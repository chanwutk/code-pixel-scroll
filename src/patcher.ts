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
 *
 * Two bundle layouts exist and are handled by two backends:
 *   'files' — `node_modules/@xterm/xterm/lib/xterm.{js,mjs}` as plain files
 *             (VS Code Insiders, Cursor, and stable up to ~1.135).
 *   'asar'  — the same paths packed inside `node_modules.asar`
 *             (VS Code stable 1.136+). See src/asar.ts.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { AsarArchive, AsarError, AsarChangedError, archiveFs, hasUnpatchedFs } from './asar';

/** Bump when the injected body changes; reconcile re-applies on mismatch. */
export const SNIPPET_VERSION = 'v2';

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
export type Layout = 'files' | 'asar';
export type ApplyAction = 'patched' | 'upgraded' | 'already-current' | 'anchor-missing' | 'file-missing';
export type RemoveAction = 'removed' | 'not-present' | 'file-missing';

const KINDS: FileKind[] = ['js', 'mjs'];
const FILE_NAMES: Record<FileKind, string> = { js: 'xterm.js', mjs: 'xterm.mjs' };
/** Path of the xterm lib dir relative to a `node_modules` root or asar root. */
const LIB_SEGMENTS = ['@xterm', 'xterm', 'lib'];

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

/** `code` values for failures that are expected to succeed on a later attempt. */
export const BUSY_CODE = 'PIXEL_SCROLL_BUSY';
export const CHANGED_CODE = 'PIXEL_SCROLL_CHANGED';

export class PatchError extends Error {
  constructor(message: string, public readonly code?: string, public readonly filePath?: string) {
    super(message);
    this.name = 'PatchError';
  }
}

/**
 * True for contention, not breakage: another window held the lock, or the
 * archive was replaced mid-operation. Nothing was written either way, so an
 * automatic pass should stay quiet and let the next one handle it.
 */
export function isTransientError(err: unknown): boolean {
  return err instanceof PatchError && (err.code === BUSY_CODE || err.code === CHANGED_CODE);
}

type Log = (msg: string) => void;

function count(haystack: string, needle: string): number {
  return needle ? haystack.split(needle).length - 1 : 0;
}

function matchCount(content: string, re: RegExp): number {
  return (content.match(re) || []).length;
}

function markerVersionsOf(content: string): string[] {
  const out: string[] = [];
  const re = startRe();
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) out.push(m[1]);
  return out;
}

function toPatchError(err: unknown, filePath: string): PatchError {
  if (err instanceof PatchError) return err;
  const e = err as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : undefined;
  const message = typeof e.message === 'string' ? e.message : String(err);
  return new PatchError(message, code, filePath);
}

function safeUnlink(p: string): void {
  try { fs.unlinkSync(p); } catch { /* ignore */ }
}

/** Same, for paths beside an archive (see `archiveFs`). */
function safeUnlinkArchive(p: string): void {
  try { archiveFs.unlinkSync(p); } catch { /* ignore */ }
}

/** Structural assertion: exactly the expected number of marker blocks. */
function assertMarkerBlocks(label: string, content: string, expectedBlocks: number, filePath: string): void {
  const sentinels = count(content, SENTINEL);
  if (sentinels !== expectedBlocks * 2) {
    throw new PatchError(
      `Marker assertion failed for ${label} (found ${sentinels} sentinels, expected ${expectedBlocks * 2})`,
      undefined,
      filePath
    );
  }
}

/**
 * Syntax-validate a file with the editor's own binary (no node-on-PATH needed).
 * `label` names the logical target for error messages.
 */
function nodeCheck(tmpPath: string, label: string, filePath: string, log: Log): void {
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
      log(`node --check unsupported for ESM here; using structural validation for ${label}`);
      return;
    }
    const first = stderr.trim().split('\n')[0] || 'unknown error';
    throw new PatchError(`Syntax validation failed for ${label}: ${first}`, undefined, filePath);
  }
}

/** Where the patched content lives, and how to read and replace it. */
interface Backend {
  readonly layout: Layout;
  /** asar edits are only picked up when the whole app process restarts. */
  readonly needsAppRestart: boolean;
  /** Directory or archive the patch targets, for status output. */
  location(): string;
  /** Display path for a target, e.g. `.../node_modules.asar/@xterm/.../xterm.js`. */
  pathFor(kind: FileKind): string;
  exists(kind: FileKind): boolean;
  read(kind: FileKind): string;
  /** Queue new content. Nothing touches disk until `commit()`. */
  stage(kind: FileKind, content: string, expectedBlocks: number): void;
  /** Write everything staged, atomically. No-op when nothing is staged. */
  commit(): void;
  xtermVersion(): string | null;
  /** Release any held handle. Called after every PatchManager operation. */
  dispose(): void;
}

/** Plain files on disk: `node_modules/@xterm/xterm/lib/xterm.{js,mjs}`. */
class FilesBackend implements Backend {
  readonly layout: Layout = 'files';
  readonly needsAppRestart = false;
  private readonly staged = new Map<FileKind, { content: string; expectedBlocks: number }>();

  constructor(private readonly nodeModulesDir: string, private readonly log: Log) {}

  private libDir(): string {
    return path.join(this.nodeModulesDir, ...LIB_SEGMENTS);
  }

  location(): string {
    return this.libDir();
  }

  pathFor(kind: FileKind): string {
    return path.join(this.libDir(), FILE_NAMES[kind]);
  }

  exists(kind: FileKind): boolean {
    return fs.existsSync(this.pathFor(kind));
  }

  read(kind: FileKind): string {
    return fs.readFileSync(this.pathFor(kind), 'utf8');
  }

  stage(kind: FileKind, content: string, expectedBlocks: number): void {
    this.staged.set(kind, { content, expectedBlocks });
  }

  commit(): void {
    for (const [kind, { content, expectedBlocks }] of this.staged) {
      this.writeValidated(kind, content, expectedBlocks);
    }
    this.staged.clear();
  }

  private writeValidated(kind: FileKind, content: string, expectedBlocks: number): void {
    const targetPath = this.pathFor(kind);
    const label = path.basename(targetPath);
    const dir = path.dirname(targetPath);
    const ext = path.extname(targetPath); // keep .js / .mjs so node infers module type
    const tmp = path.join(dir, `.pixel-scroll-tmp-${process.pid}-${Date.now()}${ext}`);

    // Writing into the bundle dir is the real permission test (App Management / TCC).
    try {
      fs.writeFileSync(tmp, content, 'utf8');
    } catch (err) {
      safeUnlink(tmp);
      throw toPatchError(err, targetPath);
    }
    try {
      assertMarkerBlocks(label, content, expectedBlocks, targetPath);
      nodeCheck(tmp, label, targetPath, this.log);
      // Commit atomically (same filesystem → atomic rename).
      fs.renameSync(tmp, targetPath);
    } catch (err) {
      safeUnlink(tmp);
      throw toPatchError(err, targetPath);
    }
    this.log(`wrote ${label}`);
  }

  dispose(): void {
    // Nothing held open.
  }

  xtermVersion(): string | null {
    try {
      const pkg = path.join(this.nodeModulesDir, '@xterm', 'xterm', 'package.json');
      const json = JSON.parse(fs.readFileSync(pkg, 'utf8')) as { version?: unknown };
      return typeof json.version === 'string' ? json.version : null;
    } catch {
      return null;
    }
  }
}

/** Files packed inside `node_modules.asar` (VS Code stable 1.136+). */
class AsarBackend implements Backend {
  readonly layout: Layout = 'asar';
  readonly needsAppRestart = true;
  private readonly staged = new Map<FileKind, { content: string; expectedBlocks: number }>();
  private cached: AsarArchive | null = null;

  constructor(private readonly archivePath: string, private readonly log: Log) {}

  private archive(): AsarArchive {
    if (!this.cached) {
      try {
        this.cached = AsarArchive.open(this.archivePath);
      } catch (err) {
        throw toPatchError(err, this.archivePath);
      }
    }
    return this.cached;
  }

  private entryPath(kind: FileKind): string {
    return [...LIB_SEGMENTS, FILE_NAMES[kind]].join('/');
  }

  location(): string {
    return this.archivePath;
  }

  pathFor(kind: FileKind): string {
    return `${this.archivePath}${path.sep}${this.entryPath(kind).split('/').join(path.sep)}`;
  }

  exists(kind: FileKind): boolean {
    try {
      return this.archive().hasPackedFile(this.entryPath(kind));
    } catch (err) {
      // Worth logging loudly: the usual cause is reading the archive with an
      // asar-aware `fs`, which makes the file look like an empty directory.
      this.log(
        `could not read ${path.basename(this.archivePath)} ` +
        `(unpatched fs: ${hasUnpatchedFs() ? 'yes' : 'no — original-fs unavailable'}): ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  }

  read(kind: FileKind): string {
    try {
      return this.archive().readFile(this.entryPath(kind)).toString('utf8');
    } catch (err) {
      throw toPatchError(err, this.pathFor(kind));
    }
  }

  stage(kind: FileKind, content: string, expectedBlocks: number): void {
    this.staged.set(kind, { content, expectedBlocks });
  }

  dispose(): void {
    this.cached?.close();
    this.cached = null;
  }

  /**
   * Serialize the rewrite across processes.
   *
   * Every editor window runs its own extension host, and each reconciles on
   * startup, so without this two of them can prepare a patch from the same
   * pristine archive and the second write lands on a file it never read.
   */
  private withLock<T>(fn: () => T): T {
    const lockPath = `${this.archivePath}.pixel-scroll-lock`;
    const staleMs = 5 * 60 * 1000;
    let lockFd: number | undefined;

    for (let attempt = 0; lockFd === undefined; attempt++) {
      try {
        lockFd = archiveFs.openSync(lockPath, 'wx');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw toPatchError(err, this.archivePath);
        }
        let ageMs = Number.POSITIVE_INFINITY;
        try { ageMs = Date.now() - archiveFs.statSync(lockPath).mtimeMs; } catch { /* vanished */ }
        if (attempt === 0 && ageMs > staleMs) {
          this.log(`clearing stale lock ${path.basename(lockPath)} (${Math.round(ageMs / 1000)}s old)`);
          safeUnlinkArchive(lockPath);
          continue;
        }
        throw new PatchError(
          'Another editor window is patching the archive right now. Nothing was written; try again in a moment.',
          BUSY_CODE, this.archivePath
        );
      }
    }

    try {
      return fn();
    } finally {
      try { archiveFs.closeSync(lockFd); } catch { /* ignore */ }
      safeUnlinkArchive(lockPath);
    }
  }

  /** One archive rewrite covers every staged target, so it is all-or-nothing. */
  commit(): void {
    if (this.staged.size === 0) return;

    const replacements = new Map<string, Buffer>();
    for (const [kind, { content, expectedBlocks }] of this.staged) {
      const label = `${FILE_NAMES[kind]} (in ${path.basename(this.archivePath)})`;
      assertMarkerBlocks(label, content, expectedBlocks, this.archivePath);
      this.checkSyntax(kind, content, label);
      replacements.set(this.entryPath(kind), Buffer.from(content, 'utf8'));
    }

    const dir = path.dirname(this.archivePath);
    // Deliberately not `*.asar`: Electron's fs wrapper claims any path whose
    // extension is `.asar`, which would make the temp file unreadable too.
    const tmp = path.join(dir, `.${path.basename(this.archivePath)}.pixel-scroll-tmp-${process.pid}-${Date.now()}`);
    const staged = [...this.staged.keys()].join(', ');

    this.withLock(() => {
      const archive = this.archive();
      try {
        // The staged content was derived from this archive's header, so the
        // rewrite is only valid over the same file. `rewrite` checks that up
        // front and reads through its own fd; check again here because the
        // rename is the moment the assumption actually has to hold.
        archive.rewrite(tmp, replacements);
        archive.assertUnchanged();
        try {
          archiveFs.chmodSync(tmp, archiveFs.statSync(this.archivePath).mode);
        } catch { /* best effort; mode is cosmetic here */ }
        archiveFs.renameSync(tmp, this.archivePath);
      } catch (err) {
        safeUnlinkArchive(tmp);
        if (err instanceof AsarChangedError) {
          this.log(`aborted: ${err.message}`);
          throw new PatchError(err.message, CHANGED_CODE, this.archivePath);
        }
        throw err instanceof AsarError
          ? new PatchError(err.message, undefined, this.archivePath)
          : toPatchError(err, this.archivePath);
      }
    });

    this.log(`rewrote ${path.basename(this.archivePath)} (${staged})`);
    this.staged.clear();
    this.dispose(); // offsets moved; the held snapshot is stale now
  }

  /** node --check needs a real file, and the archive entry is not one. */
  private checkSyntax(kind: FileKind, content: string, label: string): void {
    const tmp = path.join(
      os.tmpdir(),
      `pixel-scroll-check-${process.pid}-${Date.now()}-${FILE_NAMES[kind]}`
    );
    try {
      fs.writeFileSync(tmp, content, 'utf8');
      nodeCheck(tmp, label, this.archivePath, this.log);
    } finally {
      safeUnlink(tmp);
    }
  }

  xtermVersion(): string | null {
    try {
      const raw = this.archive().readFile('@xterm/xterm/package.json').toString('utf8');
      const json = JSON.parse(raw) as { version?: unknown };
      return typeof json.version === 'string' ? json.version : null;
    } catch {
      return null;
    }
  }
}

export class PatchManager {
  private bodyCache: string | null = null;

  constructor(
    private readonly appRoot: string,
    private readonly extensionPath: string,
    private readonly log: (msg: string) => void = () => { /* no-op */ }
  ) {}

  // ---- backend selection ----

  /**
   * Prefer a plain `node_modules` tree when it actually holds xterm; fall back
   * to `node_modules.asar` when that archive packs it. Editors that ship both
   * (a real tree plus a near-empty stub archive) therefore keep using files.
   */
  private backend(): Backend {
    const nodeModules = path.join(this.appRoot, 'node_modules');
    const files = new FilesBackend(nodeModules, this.log);
    if (files.exists('js') || files.exists('mjs')) {
      this.log(`using plain xterm files in ${files.location()}`);
      return files;
    }

    const archivePath = `${nodeModules}.asar`;
    if (archiveFs.existsSync(archivePath)) {
      const asar = new AsarBackend(archivePath, this.log);
      if (asar.exists('js') || asar.exists('mjs')) {
        this.log(`using xterm packed in ${archivePath}`);
        return asar;
      }
      asar.dispose();
      this.log(`${archivePath} exists but does not pack @xterm/xterm/lib`);
    }

    // Nothing patchable: keep the files backend so status/results report the
    // conventional paths as missing.
    return files;
  }

  /**
   * Run one operation against a freshly opened backend and release it.
   *
   * The asar backend holds the archive open for the whole operation so that
   * everything it reads — and everything it copies during a rewrite — comes
   * from one consistent snapshot, even if the file is replaced meanwhile. It
   * must not be held any longer than that: a handle kept across operations
   * would describe a file that no longer exists at that path.
   */
  private run<T>(fn: (backend: Backend) => T): T {
    const backend = this.backend();
    try {
      return fn(backend);
    } finally {
      backend.dispose();
    }
  }

  /** 'files' or 'asar' — which bundle layout this editor uses. */
  layout(): Layout {
    return this.run(b => b.layout);
  }

  /** True when a window reload is not enough and the app must be restarted. */
  needsAppRestart(): boolean {
    return this.run(b => b.needsAppRestart);
  }

  /** The directory or archive being patched. */
  location(): string {
    return this.run(b => b.location());
  }

  detectXtermVersion(): string | null {
    return this.run(b => b.xtermVersion());
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

  // ---- status ----

  private statusOf(backend: Backend, kind: FileKind): FileStatus {
    const targetPath = backend.pathFor(kind);
    if (!backend.exists(kind)) {
      return { kind, path: targetPath, exists: false, anchorCount: 0, markerVersions: [], patched: false, current: false };
    }
    const content = backend.read(kind);
    const versions = markerVersionsOf(content);
    return {
      kind,
      path: targetPath,
      exists: true,
      anchorCount: count(content, ANCHOR),
      markerVersions: versions,
      patched: versions.length > 0,
      current: versions.length === 1 && versions[0] === SNIPPET_VERSION
    };
  }

  statusFor(kind: FileKind): FileStatus {
    return this.run(b => this.statusOf(b, kind));
  }

  status(): FileStatus[] {
    return this.run(b => KINDS.map(kind => this.statusOf(b, kind)));
  }

  // ---- apply ----

  /** Compute and stage the patched content for one target; writes nothing. */
  private stageApply(backend: Backend, kind: FileKind, force: boolean): FileResult<ApplyAction> {
    const targetPath = backend.pathFor(kind);
    if (!backend.exists(kind)) {
      this.log(`xterm file not found: ${targetPath}`);
      return { kind, path: targetPath, action: 'file-missing', changed: false };
    }
    let content = backend.read(kind);
    const label = FILE_NAMES[kind];

    const startCount = matchCount(content, startRe());
    const endCount = matchCount(content, endRe());
    if (startCount !== endCount) {
      throw new PatchError(
        `Malformed marker pairing in ${label} (${startCount} start / ${endCount} end); refusing to patch.`,
        undefined, targetPath
      );
    }

    const versions = markerVersionsOf(content);
    if (!force && startCount === 1 && versions[0] === SNIPPET_VERSION) {
      return { kind, path: targetPath, action: 'already-current', changed: false };
    }

    const anchorCount = count(content, ANCHOR);
    if (anchorCount !== 1) {
      this.log(`Anchor ${anchorCount === 0 ? 'not found' : `not unique (${anchorCount})`} in ${label}; xterm may have changed. Skipping.`);
      return { kind, path: targetPath, action: 'anchor-missing', changed: false };
    }

    const wasPatched = startCount > 0;
    if (wasPatched) {
      content = content.replace(blockRe(), ''); // strip stale/other-version block(s) → clean upgrade
    }

    const at = content.indexOf(ANCHOR);
    const patched = content.slice(0, at + ANCHOR.length) + this.insertText() + content.slice(at + ANCHOR.length);

    backend.stage(kind, patched, 1);
    const action: ApplyAction = wasPatched ? 'upgraded' : 'patched';
    this.log(`${action} ${label}`);
    return { kind, path: targetPath, action, changed: true };
  }

  apply(force = false): FileResult<ApplyAction>[] {
    return this.run(backend => {
      const results = KINDS.map(kind => this.stageApply(backend, kind, force));
      backend.commit();
      return results;
    });
  }

  // ---- remove ----

  private stageRemove(backend: Backend, kind: FileKind): FileResult<RemoveAction> {
    const targetPath = backend.pathFor(kind);
    if (!backend.exists(kind)) {
      return { kind, path: targetPath, action: 'file-missing', changed: false };
    }
    const content = backend.read(kind);
    const label = FILE_NAMES[kind];
    const startCount = matchCount(content, startRe());
    const endCount = matchCount(content, endRe());

    if (startCount === 0 && endCount === 0) {
      return { kind, path: targetPath, action: 'not-present', changed: false };
    }
    if (startCount !== endCount) {
      throw new PatchError(
        `Malformed/partial marker in ${label} (${startCount} start / ${endCount} end); refusing to auto-remove. Repair manually or reinstall the editor.`,
        undefined, targetPath
      );
    }

    backend.stage(kind, content.replace(blockRe(), ''), 0);
    this.log(`staged patch removal from ${label}`);
    return { kind, path: targetPath, action: 'removed', changed: true };
  }

  remove(): FileResult<RemoveAction>[] {
    return this.run(backend => {
      const results = KINDS.map(kind => this.stageRemove(backend, kind));
      backend.commit();
      return results;
    });
  }
}
