/*
 * PatchManager — applies / removes the pixel-scroll patch to xterm's bundled
 * files inside the running editor's app bundle.
 *
 * It is deliberately free of any `vscode` import so it stays simple to reason
 * about and test: the caller passes in `appRoot` and `extensionPath`.
 *
 * The patch splices the body of scroll-logic.js into xterm's
 * Viewport.prototype._handleScroll, immediately after the unique, byte-identical
 * anchor `this._isHandlingScroll=!0;`, wrapped in versioned comment markers so
 * it can be found, upgraded, and removed byte-for-byte.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

/** Bump when the injected body changes; reconcile re-applies on mismatch. */
export const SNIPPET_VERSION = 'v1';

/** Unique, byte-identical, post-guard splice anchor (verified: exactly 1 per build). */
const ANCHOR = 'this._isHandlingScroll=!0;';

const MARKER_START = `/*<<PIXEL_SCROLL_TERMINAL:${SNIPPET_VERSION}:START>>*/`;
const MARKER_END = `/*<<PIXEL_SCROLL_TERMINAL:${SNIPPET_VERSION}:END>>*/`;
const SENTINEL = '<<PIXEL_SCROLL_TERMINAL';

/** Fresh regexes each call (global regexes are stateful via lastIndex). */
const blockRe = () =>
  /\/\*<<PIXEL_SCROLL_TERMINAL:[^>]*?:START>>\*\/[\s\S]*?\/\*<<PIXEL_SCROLL_TERMINAL:[^>]*?:END>>\*\//g;
const startRe = () => /\/\*<<PIXEL_SCROLL_TERMINAL:([^>]*?):START>>\*\//g;
const endRe = () => /\/\*<<PIXEL_SCROLL_TERMINAL:[^>]*?:END>>\*\//g;

export type FileKind = 'js' | 'mjs';
export type ApplyAction = 'patched' | 'upgraded' | 'already-current' | 'anchor-missing' | 'file-missing';
export type RemoveAction = 'removed' | 'not-present' | 'file-missing';

export interface FileStatus {
  kind: FileKind;
  path: string;
  exists: boolean;
  anchorCount: number;
  markerVersions: string[];
  patched: boolean;
  current: boolean;
}

export interface FileResult<A> {
  kind: FileKind;
  path: string;
  action: A;
  changed: boolean;
}

export class PatchError extends Error {
  constructor(message: string, public readonly code?: string, public readonly filePath?: string) {
    super(message);
    this.name = 'PatchError';
  }
}

export class PatchManager {
  private bodyCache: string | null = null;

  constructor(
    private readonly appRoot: string,
    private readonly extensionPath: string,
    private readonly log: (msg: string) => void = () => { /* no-op */ }
  ) {}

  // ---- paths ----

  private xtermLibDir(): string {
    return path.join(this.appRoot, 'node_modules', '@xterm', 'xterm', 'lib');
  }

  targets(): { kind: FileKind; path: string }[] {
    const dir = this.xtermLibDir();
    return [
      { kind: 'js', path: path.join(dir, 'xterm.js') },
      { kind: 'mjs', path: path.join(dir, 'xterm.mjs') }
    ];
  }

  detectXtermVersion(): string | null {
    try {
      const pkg = path.join(this.appRoot, 'node_modules', '@xterm', 'xterm', 'package.json');
      const json = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { version?: unknown };
      return typeof json.version === 'string' ? json.version : null;
    } catch {
      return null;
    }
  }

  // ---- injected body ----

  /** Read & cache the body extracted from scroll-logic.js (between BODY marker lines). */
  bodyText(): string {
    if (this.bodyCache !== null) return this.bodyCache;
    const file = path.join(this.extensionPath, 'scroll-logic.js');
    const raw = fs.readFileSync(file, 'utf8');
    // Match the marker LINES themselves (a line that is exactly `// BODY:START`),
    // so prose elsewhere that merely mentions the markers can't match by accident.
    const startMatch = /^[ \t]*\/\/ BODY:START[ \t]*\r?\n/m.exec(raw);
    const endMatch = /^[ \t]*\/\/ BODY:END[ \t]*$/m.exec(raw);
    if (!startMatch || !endMatch || endMatch.index <= startMatch.index) {
      throw new PatchError(`Could not find BODY:START/BODY:END marker lines in ${file}`);
    }
    const body = raw.slice(startMatch.index + startMatch[0].length, endMatch.index).trim();
    if (!body) {
      throw new PatchError(`Injected body in ${file} is empty`);
    }
    if (body.includes('//')) {
      // `//` could comment out trailing code once spliced onto a single line.
      throw new PatchError('Injected body must not contain // line comments (use block comments).');
    }
    this.bodyCache = body;
    return body;
  }

  private insertText(): string {
    return `${MARKER_START}\n${this.bodyText()}\n${MARKER_END}`;
  }

  // ---- counting helpers ----

  private static count(haystack: string, needle: string): number {
    return needle ? haystack.split(needle).length - 1 : 0;
  }

  private static matchCount(content: string, re: RegExp): number {
    return (content.match(re) || []).length;
  }

  private static markerVersions(content: string): string[] {
    const out: string[] = [];
    const re = startRe();
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) out.push(m[1]);
    return out;
  }

  // ---- status ----

  statusFor(kind: FileKind, filePath: string): FileStatus {
    if (!fs.existsSync(filePath)) {
      return { kind, path: filePath, exists: false, anchorCount: 0, markerVersions: [], patched: false, current: false };
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const versions = PatchManager.markerVersions(content);
    return {
      kind,
      path: filePath,
      exists: true,
      anchorCount: PatchManager.count(content, ANCHOR),
      markerVersions: versions,
      patched: versions.length > 0,
      current: versions.length === 1 && versions[0] === SNIPPET_VERSION
    };
  }

  status(): FileStatus[] {
    return this.targets().map(t => this.statusFor(t.kind, t.path));
  }

  // ---- atomic write + validation ----

  private atomicWriteValidated(targetPath: string, newContent: string, expectedBlocks: number): void {
    const dir = path.dirname(targetPath);
    const ext = path.extname(targetPath); // keep .js / .mjs so node infers module type
    const tmp = path.join(dir, `.pixel-scroll-tmp-${process.pid}-${Date.now()}${ext}`);

    // Writing into the bundle dir is the real permission test (App Management / TCC).
    try {
      fs.writeFileSync(tmp, newContent, 'utf8');
    } catch (err) {
      this.safeUnlink(tmp);
      throw this.toPatchError(err, targetPath);
    }

    try {
      // Structural assertion: exactly the expected number of marker blocks.
      const sentinels = PatchManager.count(newContent, SENTINEL);
      if (sentinels !== expectedBlocks * 2) {
        throw new PatchError(
          `Marker assertion failed for ${path.basename(targetPath)} ` +
          `(found ${sentinels} sentinels, expected ${expectedBlocks * 2})`,
          undefined, targetPath
        );
      }
      // Syntax validation via the editor's own binary (no node-on-PATH needed).
      this.nodeCheck(tmp, targetPath);
      // Commit atomically (same filesystem → atomic rename).
      fs.renameSync(tmp, targetPath);
    } catch (err) {
      this.safeUnlink(tmp);
      throw err instanceof PatchError ? err : this.toPatchError(err, targetPath);
    }
  }

  private nodeCheck(tmpPath: string, targetPath: string): void {
    try {
      execFileSync(process.execPath, ['--check', tmpPath], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: 'pipe'
      });
    } catch (err) {
      const e = err as { stderr?: Buffer | string; message?: string };
      const stderr = `${e.stderr ? e.stderr.toString() : ''}${e.message ?? ''}`;
      // Very old Node builds can't --check ES modules. That specific case is
      // non-fatal: the structural assertion already passed and the body was
      // node --check'd at build time. Any other failure is a real syntax error.
      const esmUnsupported = /\.mjs$/i.test(tmpPath) && /not supported|ES modules?/i.test(stderr);
      if (esmUnsupported) {
        this.log(`node --check unsupported for ESM here; using structural validation for ${path.basename(targetPath)}`);
        return;
      }
      const first = stderr.trim().split('\n')[0] || 'unknown error';
      throw new PatchError(`Syntax validation failed for ${path.basename(targetPath)}: ${first}`, undefined, targetPath);
    }
  }

  // ---- apply ----

  applyFile(kind: FileKind, filePath: string, force = false): FileResult<ApplyAction> {
    if (!fs.existsSync(filePath)) {
      this.log(`xterm file not found: ${filePath}`);
      return { kind, path: filePath, action: 'file-missing', changed: false };
    }
    let content = fs.readFileSync(filePath, 'utf8');

    const startCount = PatchManager.matchCount(content, startRe());
    const endCount = PatchManager.matchCount(content, endRe());
    if (startCount !== endCount) {
      throw new PatchError(
        `Malformed marker pairing in ${path.basename(filePath)} (${startCount} start / ${endCount} end); refusing to patch.`,
        undefined, filePath
      );
    }

    const versions = PatchManager.markerVersions(content);
    if (!force && startCount === 1 && versions[0] === SNIPPET_VERSION) {
      return { kind, path: filePath, action: 'already-current', changed: false };
    }

    const anchorCount = PatchManager.count(content, ANCHOR);
    if (anchorCount !== 1) {
      this.log(`Anchor ${anchorCount === 0 ? 'not found' : `not unique (${anchorCount})`} in ${path.basename(filePath)}; xterm may have changed. Skipping.`);
      return { kind, path: filePath, action: 'anchor-missing', changed: false };
    }

    const wasPatched = startCount > 0;
    if (wasPatched) {
      content = content.replace(blockRe(), ''); // strip stale/other-version block(s) → clean upgrade
    }

    const at = content.indexOf(ANCHOR);
    const patched = content.slice(0, at + ANCHOR.length) + this.insertText() + content.slice(at + ANCHOR.length);

    this.atomicWriteValidated(filePath, patched, 1);
    const action: ApplyAction = wasPatched ? 'upgraded' : 'patched';
    this.log(`${action} ${path.basename(filePath)}`);
    return { kind, path: filePath, action, changed: true };
  }

  apply(force = false): FileResult<ApplyAction>[] {
    return this.targets().map(t => this.applyFile(t.kind, t.path, force));
  }

  // ---- remove ----

  removeFile(kind: FileKind, filePath: string): FileResult<RemoveAction> {
    if (!fs.existsSync(filePath)) {
      return { kind, path: filePath, action: 'file-missing', changed: false };
    }
    const content = fs.readFileSync(filePath, 'utf8');
    const startCount = PatchManager.matchCount(content, startRe());
    const endCount = PatchManager.matchCount(content, endRe());

    if (startCount === 0 && endCount === 0) {
      return { kind, path: filePath, action: 'not-present', changed: false };
    }
    if (startCount !== endCount) {
      throw new PatchError(
        `Malformed/partial marker in ${path.basename(filePath)} (${startCount} start / ${endCount} end); refusing to auto-remove. Repair manually or reinstall the editor.`,
        undefined, filePath
      );
    }

    const cleaned = content.replace(blockRe(), '');
    this.atomicWriteValidated(filePath, cleaned, 0);
    this.log(`removed patch from ${path.basename(filePath)}`);
    return { kind, path: filePath, action: 'removed', changed: true };
  }

  remove(): FileResult<RemoveAction>[] {
    return this.targets().map(t => this.removeFile(t.kind, t.path));
  }

  // ---- error helpers ----

  private safeUnlink(p: string): void {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }

  private toPatchError(err: unknown, filePath: string): PatchError {
    const e = err as { code?: unknown; message?: unknown };
    const code = typeof e.code === 'string' ? e.code : undefined;
    const message = typeof e.message === 'string' ? e.message : String(err);
    return new PatchError(message, code, filePath);
  }
}
