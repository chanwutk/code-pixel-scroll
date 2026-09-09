/*
 * Minimal asar (Electron archive) reader/writer — just enough to read a single
 * bundled file and rewrite the archive with replacement content for it.
 *
 * VS Code 1.136+ stable ships its dependencies as `node_modules.asar` instead
 * of a plain `node_modules` tree, so xterm's `lib/xterm.js` now lives inside
 * that archive and can no longer be edited as a file on disk.
 *
 * All byte access goes through `archiveFs` (`original-fs` under Electron), not
 * plain `fs`: see the note on that export.
 *
 * Format: a 16-byte pickle prefix, a JSON header (zero-padded to a 4-byte
 * boundary), then every packed file's bytes concatenated. Header leaves hold
 * `size` plus an `offset` string relative to the end of the padded header;
 * `unpacked: true` leaves have no offset and live in `<archive>.unpacked/`.
 *
 * Rewriting splices in place: every byte outside the replaced entries is copied
 * verbatim (shipped archives contain zero-length entries that share an offset
 * and at least one unreferenced hole, so re-packing them compactly would not
 * reproduce the original). Only the replaced entry's size and the offsets after
 * it change, which makes removing the patch restore the file byte-for-byte.
 *
 * Concurrency is the hazard that matters here. An archive's header is parsed
 * once and its entries are then addressed by absolute offset, so if the file is
 * replaced underneath us — another editor window patching at the same moment,
 * or an editor update — those offsets silently describe a different file and a
 * rewrite corrupts everything after the splice. Three things prevent that:
 *   1. `open` holds an fd for the instance's whole life and every read goes
 *      through it, so reads always see the exact bytes the header describes even
 *      if the path is replaced (a rename swaps the directory entry, not the
 *      inode we hold).
 *   2. `assertUnchanged` compares the path's identity against open time, and the
 *      caller must call it immediately before committing.
 *   3. `verifyRewrite` reads every entry back *through both headers* rather than
 *      by recomputed arithmetic, so a bad offset cannot verify itself as
 *      correct, and re-parses the archive's JSON files as a semantic canary.
 */

import * as fs from 'fs';

const PREFIX_BYTES = 16;
const MAX_HEADER_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

/**
 * The unpatched filesystem module.
 *
 * Electron replaces `fs` with an asar-aware wrapper that presents an archive as
 * a *directory*: `fs.statSync('…/node_modules.asar')` reports `isDirectory()`
 * with `size: 0`, and `fs.openSync` on it throws ENOENT. So plain `fs` can read
 * files *inside* an archive but never the archive's own bytes — which is all
 * this module does. `original-fs` is Electron's unpatched module; it does not
 * exist under plain Node, hence the fallback.
 */
export const archiveFs: typeof fs = (() => {
  try {
    return require('original-fs') as typeof fs;
  } catch {
    return fs;
  }
})();

/** True when running somewhere that hands out an asar-aware `fs` (i.e. Electron). */
export function hasUnpatchedFs(): boolean {
  return archiveFs !== fs;
}

interface AsarLeaf {
  size?: number;
  offset?: string;
  unpacked?: boolean;
}

interface AsarDir {
  files: Record<string, AsarDir | AsarLeaf>;
}

/** A packed (in-archive) file, with its offset resolved to a number. */
interface PackedEntry {
  path: string;
  leaf: AsarLeaf;
  offset: number;
  size: number;
}

/** A stretch of the data region being swapped for new content. */
interface Replacement {
  path: string;
  offset: number;
  oldSize: number;
  content: Buffer;
}

/** What the archive file looked like when we opened it. */
interface Identity {
  ino: number;
  size: number;
  mtimeMs: number;
}

export class AsarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AsarError';
  }
}

/** Thrown when the archive was replaced after we parsed its header. */
export class AsarChangedError extends AsarError {
  constructor(path: string) {
    super(
      `${path} changed on disk while the patch was being prepared ` +
      '(another window or an editor update replaced it). Nothing was written; try again.'
    );
    this.name = 'AsarChangedError';
  }
}

function isDir(node: AsarDir | AsarLeaf | undefined): node is AsarDir {
  return !!node && typeof node === 'object' && 'files' in node;
}

function pad4(n: number): number {
  return (4 - (n % 4)) % 4;
}

function identityOf(path: string): Identity {
  const st = archiveFs.statSync(path);
  return { ino: Number(st.ino), size: st.size, mtimeMs: st.mtimeMs };
}

export class AsarArchive {
  private closed = false;

  private constructor(
    readonly path: string,
    private readonly fd: number,
    private readonly header: AsarDir,
    private readonly headerJson: string,
    private readonly dataBase: number,
    private readonly fileSize: number,
    private readonly identity: Identity
  ) {}

  /**
   * Parse `archivePath`'s header and hold it open. The caller owns the returned
   * archive and must `close()` it.
   */
  static open(archivePath: string): AsarArchive {
    const identity = identityOf(archivePath);
    const fd = archiveFs.openSync(archivePath, 'r');
    try {
      const prefix = Buffer.alloc(PREFIX_BYTES);
      if (archiveFs.readSync(fd, prefix, 0, PREFIX_BYTES, 0) !== PREFIX_BYTES) {
        throw new AsarError(`${archivePath} is too small to be an asar archive`);
      }
      if (prefix.readUInt32LE(0) !== 4) {
        throw new AsarError(`Unrecognized asar header in ${archivePath}`);
      }
      const jsonBytes = prefix.readUInt32LE(12);
      if (jsonBytes <= 0 || jsonBytes > MAX_HEADER_BYTES || PREFIX_BYTES + jsonBytes > identity.size) {
        throw new AsarError(`Implausible asar header size (${jsonBytes}) in ${archivePath}`);
      }
      const raw = Buffer.alloc(jsonBytes);
      if (archiveFs.readSync(fd, raw, 0, jsonBytes, PREFIX_BYTES) !== jsonBytes) {
        throw new AsarError(`Truncated asar header in ${archivePath}`);
      }
      const headerJson = raw.toString('utf8');
      let header: unknown;
      try {
        header = JSON.parse(headerJson);
      } catch (err) {
        throw new AsarError(`Unparseable asar header in ${archivePath}: ${(err as Error).message}`);
      }
      if (!isDir(header as AsarDir)) {
        throw new AsarError(`Unexpected asar header shape in ${archivePath}`);
      }
      const dataBase = PREFIX_BYTES + jsonBytes + pad4(jsonBytes);
      return new AsarArchive(
        archivePath, fd, header as AsarDir, headerJson, dataBase, identity.size, identity
      );
    } catch (err) {
      try { archiveFs.closeSync(fd); } catch { /* ignore */ }
      throw err;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { archiveFs.closeSync(this.fd); } catch { /* ignore */ }
  }

  /**
   * Throw unless the path still holds the file we parsed. Reads are safe
   * regardless (they use our fd), but writing a rewrite derived from this
   * header over a *different* file would corrupt it, so commit paths must call
   * this immediately before the rename.
   */
  assertUnchanged(): void {
    let now: Identity;
    try {
      now = identityOf(this.path);
    } catch {
      throw new AsarChangedError(this.path);
    }
    if (
      now.ino !== this.identity.ino ||
      now.size !== this.identity.size ||
      now.mtimeMs !== this.identity.mtimeMs
    ) {
      throw new AsarChangedError(this.path);
    }
  }

  // ---- reading ----

  private read(offset: number, size: number, what: string): Buffer {
    if (this.closed) {
      throw new AsarError(`${this.path} is already closed`);
    }
    const buf = Buffer.alloc(size);
    if (size > 0 && archiveFs.readSync(this.fd, buf, 0, size, this.dataBase + offset) !== size) {
      throw new AsarError(`Short read for ${what} in ${this.path}`);
    }
    return buf;
  }

  private leafFor(entryPath: string): AsarLeaf | null {
    const segments = entryPath.split('/').filter(s => s.length > 0);
    let node: AsarDir | AsarLeaf | undefined = this.header;
    for (const segment of segments) {
      if (!isDir(node)) return null;
      node = node.files[segment];
    }
    return node !== undefined && !isDir(node) ? node : null;
  }

  /** True when `entryPath` names a file packed inside the archive itself. */
  hasPackedFile(entryPath: string): boolean {
    const leaf = this.leafFor(entryPath);
    return !!leaf && !leaf.unpacked && typeof leaf.offset === 'string' && typeof leaf.size === 'number';
  }

  readFile(entryPath: string): Buffer {
    const leaf = this.leafFor(entryPath);
    if (!leaf) {
      throw new AsarError(`${entryPath} not found in ${this.path}`);
    }
    if (leaf.unpacked) {
      throw new AsarError(`${entryPath} is stored unpacked, not inside ${this.path}`);
    }
    const { offset, size } = this.resolve(entryPath, leaf);
    return this.read(offset, size, entryPath);
  }

  private resolve(entryPath: string, leaf: AsarLeaf): { offset: number; size: number } {
    const offset = Number(leaf.offset);
    const size = leaf.size;
    if (!Number.isSafeInteger(offset) || offset < 0 || typeof size !== 'number' || size < 0) {
      throw new AsarError(`Malformed entry for ${entryPath} in ${this.path}`);
    }
    if (this.dataBase + offset + size > this.fileSize) {
      throw new AsarError(`Entry ${entryPath} extends past the end of ${this.path}`);
    }
    return { offset, size };
  }

  /** Every packed file under `root`, in the order its bytes appear on disk. */
  private packedEntries(root: AsarDir): PackedEntry[] {
    const out: PackedEntry[] = [];
    const walk = (node: AsarDir, prefix: string): void => {
      for (const [name, child] of Object.entries(node.files)) {
        const childPath = prefix ? `${prefix}/${name}` : name;
        if (isDir(child)) {
          walk(child, childPath);
        } else if (!child.unpacked && child.offset !== undefined) {
          const { offset, size } = this.resolve(childPath, child);
          out.push({ path: childPath, leaf: child, offset, size });
        }
      }
    };
    walk(root, '');
    out.sort((a, b) => a.offset - b.offset || a.size - b.size);
    return out;
  }

  private get regionBytes(): number {
    return this.fileSize - this.dataBase;
  }

  // ---- rewrite ----

  /** Resolve the entries to replace, and refuse anything that is not a clean splice. */
  private planReplacements(entries: PackedEntry[], replacements: Map<string, Buffer>): Replacement[] {
    const plan: Replacement[] = [];
    for (const [entryPath, content] of replacements) {
      const entry = entries.find(e => e.path === entryPath);
      if (!entry) {
        throw new AsarError(`Cannot replace ${entryPath}: not a packed file in ${this.path}`);
      }
      if (entry.size === 0) {
        throw new AsarError(`Cannot replace ${entryPath}: it is a zero-length entry in ${this.path}`);
      }
      plan.push({ path: entryPath, offset: entry.offset, oldSize: entry.size, content });
    }
    plan.sort((a, b) => a.offset - b.offset);

    for (let i = 1; i < plan.length; i++) {
      const prev = plan[i - 1];
      if (plan[i].offset < prev.offset + prev.oldSize) {
        throw new AsarError(`${plan[i].path} and ${prev.path} overlap in ${this.path}; refusing to rewrite it.`);
      }
    }
    // Shipped archives let zero-length entries share a neighbour's offset, which
    // is harmless; anything with actual bytes inside a replaced range is not.
    for (const entry of entries) {
      if (entry.size === 0 || replacements.has(entry.path)) continue;
      for (const r of plan) {
        if (entry.offset < r.offset + r.oldSize && entry.offset + entry.size > r.offset) {
          throw new AsarError(
            `${entry.path} shares bytes with ${r.path} in ${this.path}; refusing to rewrite it.`
          );
        }
      }
    }
    return plan;
  }

  /**
   * Write a copy of this archive to `outPath` with `replacements` substituted
   * for the named entries, then verify the result.
   *
   * Everything outside the replaced ranges — including padding and any hole not
   * claimed by an entry — is copied through untouched. In the header, only the
   * replaced entries' sizes and the offsets at or after them change.
   */
  rewrite(outPath: string, replacements: Map<string, Buffer>): void {
    this.assertUnchanged();

    // Work on a fresh parse so this instance keeps describing the file on disk.
    const header = JSON.parse(this.headerJson) as AsarDir;
    if (JSON.stringify(header) !== this.headerJson) {
      throw new AsarError(`${this.path} does not re-serialize identically; refusing to rewrite it.`);
    }
    const entries = this.packedEntries(header);
    const plan = this.planReplacements(entries, replacements);
    if (plan.length === 0) {
      throw new AsarError('No replacements given');
    }

    /** Bytes inserted before `offset` by the replacements that precede it. */
    const shiftAt = (offset: number): number =>
      plan.reduce(
        (sum, r) => (r.offset + r.oldSize <= offset ? sum + r.content.length - r.oldSize : sum),
        0
      );

    for (const entry of entries) {
      const replaced = plan.find(r => r.path === entry.path);
      entry.leaf.offset = String(entry.offset + shiftAt(entry.offset));
      entry.leaf.size = replaced ? replaced.content.length : entry.size;
    }

    const json = Buffer.from(JSON.stringify(header), 'utf8');
    const padding = pad4(json.length);
    const prefix = Buffer.alloc(PREFIX_BYTES);
    prefix.writeUInt32LE(4, 0);
    prefix.writeUInt32LE(8 + json.length + padding, 4);
    prefix.writeUInt32LE(4 + json.length + padding, 8);
    prefix.writeUInt32LE(json.length, 12);
    const newBase = PREFIX_BYTES + json.length + padding;

    const out = archiveFs.openSync(outPath, 'w');
    try {
      archiveFs.writeSync(out, prefix, 0, PREFIX_BYTES, 0);
      archiveFs.writeSync(out, json, 0, json.length, PREFIX_BYTES);
      if (padding > 0) {
        archiveFs.writeSync(out, Buffer.alloc(padding), 0, padding, PREFIX_BYTES + json.length);
      }

      const chunk = Buffer.alloc(CHUNK_BYTES);
      let writeAt = newBase;
      /** Copy old region [from, to) through, reading via our own fd. */
      const copyRegion = (from: number, to: number): void => {
        let remaining = to - from;
        let readAt = this.dataBase + from;
        while (remaining > 0) {
          const want = Math.min(remaining, CHUNK_BYTES);
          if (archiveFs.readSync(this.fd, chunk, 0, want, readAt) !== want) {
            throw new AsarError(`Short read at ${readAt} in ${this.path}`);
          }
          archiveFs.writeSync(out, chunk, 0, want, writeAt);
          readAt += want;
          writeAt += want;
          remaining -= want;
        }
      };

      let cursor = 0;
      for (const r of plan) {
        copyRegion(cursor, r.offset);
        archiveFs.writeSync(out, r.content, 0, r.content.length, writeAt);
        writeAt += r.content.length;
        cursor = r.offset + r.oldSize;
      }
      copyRegion(cursor, this.regionBytes);
    } finally {
      archiveFs.closeSync(out);
    }

    this.verifyRewrite(outPath, replacements, newBase, plan);
  }

  /**
   * Confirm `outPath` is the archive we meant to write.
   *
   * Every check reads entries back *through* the two headers rather than by
   * recomputing offsets: an entry whose offset is wrong then yields the wrong
   * bytes and fails, where arithmetic compared against the same arithmetic
   * would agree with itself.
   */
  private verifyRewrite(
    outPath: string,
    replacements: Map<string, Buffer>,
    newBase: number,
    plan: Replacement[]
  ): void {
    const delta = plan.reduce((sum, r) => sum + r.content.length - r.oldSize, 0);
    const wantSize = newBase + this.regionBytes + delta;
    const gotSize = archiveFs.statSync(outPath).size;
    if (gotSize !== wantSize) {
      throw new AsarError(`Rewritten archive is ${gotSize} bytes, expected ${wantSize}`);
    }

    const rewritten = AsarArchive.open(outPath);
    try {
      const before = this.packedEntries(JSON.parse(this.headerJson) as AsarDir);
      const after = rewritten.packedEntries(rewritten.header);
      if (after.length !== before.length) {
        throw new AsarError(
          `Rewritten archive has ${after.length} packed entries, expected ${before.length}`
        );
      }
      const afterByPath = new Map(after.map(e => [e.path, e]));
      let jsonChecked = 0;

      for (const entry of before) {
        const now = afterByPath.get(entry.path);
        if (!now) {
          throw new AsarError(`Rewritten archive is missing entry ${entry.path}`);
        }
        const replacement = replacements.get(entry.path);
        const expectedSize = replacement ? replacement.length : entry.size;
        if (now.size !== expectedSize) {
          throw new AsarError(
            `Rewritten ${entry.path} has size ${now.size}, expected ${expectedSize}`
          );
        }
        // Read both sides through their own headers and compare.
        const got = rewritten.read(now.offset, now.size, entry.path);
        const want = replacement ?? this.read(entry.offset, entry.size, entry.path);
        if (!got.equals(want)) {
          throw new AsarError(`Rewritten ${entry.path} does not hold the expected bytes`);
        }
        // Semantic canary: anything that was valid JSON must still parse. This
        // is what catches a whole-archive offset slip in one obvious place.
        if (entry.path.endsWith('.json') && !replacement && entry.size > 0 && entry.size < 512 * 1024) {
          if (parsesAsJson(want)) {
            jsonChecked++;
            if (!parsesAsJson(got)) {
              throw new AsarError(`Rewritten ${entry.path} is no longer valid JSON`);
            }
          }
        }
      }
      if (jsonChecked === 0) {
        throw new AsarError('Verification found no JSON entries to cross-check; refusing to trust the rewrite.');
      }
    } finally {
      rewritten.close();
    }
  }
}

function parsesAsJson(buf: Buffer): boolean {
  try {
    JSON.parse(buf.toString('utf8'));
    return true;
  } catch {
    return false;
  }
}
