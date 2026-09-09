# Pixel Scroll Terminal

Per-pixel (sub-line) smooth scrolling for the VS Code integrated terminal.

## The problem

VS Code's terminal is built on [xterm.js](https://github.com/xtermjs/xterm.js). xterm
renders rows onto a `<canvas>` that can only draw **whole rows**, so on every scroll it
rounds the scroll position to the nearest row and **discards the fractional remainder**.
That discarded fraction is exactly what makes trackpad scrolling look chunky.

## The fix

On each scroll, translate the `.xterm-screen` element (the canvas holder) by the discarded
fraction, so the eye sees smooth sub-row motion:

```js
offset = scrollTop - Math.round(scrollTop / cellHeight) * cellHeight;
screen.style.transform = `translateY(${-offset}px)`;
```

- `cellHeight` is read **exactly** from inside xterm via the render service
  (`this._renderService.dimensions.css.cell.height`) — never measured from the DOM.
- We translate `.xterm-screen` (renderer-agnostic), **not** `.xterm-rows` (which only exists
  under xterm's DOM renderer and is absent under VS Code's WebGL renderer).

## How it works

The precise sub-line scroll position is **not** in the DOM, and the xterm `Terminal` object is
**not** reachable from an injected page script. The only place with both the exact pixel
`scrollTop` and the exact cell height is xterm's own `Viewport.prototype._handleScroll(e)`.

So this extension **self-patches that method inside the running editor's app bundle** — from
the extension host, which on macOS is the only process allowed to modify the app's own files.
No loader extension; no DOM-injected script.

- It patches **both** builds that ship with the editor: the CJS `lib/xterm.js` **and** the ESM
  `lib/xterm.mjs` (VS Code's ESM workbench loads the `.mjs` at runtime, so patching only the
  `.js` would do nothing).
- The splice anchor is `this._isHandlingScroll=!0;` — unique, byte-identical across both
  builds, and positioned **after** xterm's early-return guards (so the render service is
  initialized). A few readable statements (the body of `scroll-logic.js`) are inserted right
  after it, wrapped in `try/catch` so a failure can never break terminal scrolling.
- The injected region is delimited by **versioned comment markers** so it can be located,
  upgraded, and removed **byte-for-byte**.
- The target editor is whatever you installed the extension into (resolved via
  `vscode.env.appRoot`), so it works the same in VS Code, Insiders, VSCodium, and Cursor.
- Two bundle layouts are supported, picked automatically:
  - **files** — `node_modules/@xterm/xterm/lib/xterm.{js,mjs}` as plain files on disk
    (Insiders, VSCodium, Cursor, and VS Code stable up to ~1.135).
  - **asar** — the same paths packed inside `node_modules.asar` (VS Code stable 1.136+, which
    no longer ships a plain `node_modules` tree). The archive is spliced in place: every byte
    outside the two xterm entries is copied through verbatim, and only the patched entries'
    sizes and the offsets after them change. See `src/asar.ts`.

    Reading the archive requires Electron's **`original-fs`**: the `fs` the extension host gets
    is asar-aware, and it presents `node_modules.asar` as an empty *directory* — you can read
    files *inside* the archive with it, but never the archive's own bytes.

    Because an archive's entries are addressed by absolute offset, a rewrite is only valid over
    the exact file whose header it was derived from — and every editor window runs its own
    extension host that reconciles on startup. Three things keep that safe: an exclusive lock
    file beside the archive serializes the rewrite across processes; the archive is held open
    for the whole operation and read through that fd, so a snapshot stays coherent even if the
    path is replaced; and the file's identity is re-checked immediately before the rename, which
    aborts without writing if anything moved. Losing the lock is reported as "try again", never
    as a failure — nothing is written in that case.

  Run **Pixel Scroll Terminal: Show Status** to see which layout your editor uses.

## Requirements

- **macOS** (the permission handling and self-patch model are written for macOS).
- A VS Code-family editor whose terminal uses xterm 6.x with both `lib/xterm.js` and
  `lib/xterm.mjs` present, either as plain files or packed in `node_modules.asar`
  (VS Code 1.126+, Insiders, VSCodium, Cursor all qualify).

## Build & install (sideload)

```bash
npm install
npm run check      # node --check the snippet + type-check scroll-logic.js
npm run compile    # tsc → out/
npm run package    # produces pixel-scroll-terminal-<version>.vsix
code --install-extension pixel-scroll-terminal-*.vsix
```

(Use your editor's CLI — `code-insiders`, `codium`, `cursor` — or **Extensions: Install from
VSIX…** in the UI.)

> This extension modifies the editor's bundled files, which the VS Code Marketplace does not
> permit, so it is meant to be **sideloaded** rather than published.

## Usage

Open the Command Palette and run:

| Command | What it does |
| --- | --- |
| **Pixel Scroll Terminal: Enable** | Applies the patch, then offers to reload (or restart). |
| **Pixel Scroll Terminal: Disable** | Removes the patch byte-for-byte, then offers to reload. |
| **Pixel Scroll Terminal: Reapply Patch** | Forces a fresh re-patch (e.g. after manual edits). |
| **Pixel Scroll Terminal: Show Status** | Prints state, versions, and per-file patch status to the *Pixel Scroll Terminal* output channel. |

A reload is required because the old xterm build is already loaded in memory. On VS Code stable
1.136+ (the **asar** layout) a reload is *not* enough — the app process caches
`node_modules.asar`, so quit and reopen the editor instead; the prompt says which one you need.

The enabled/disabled state is persisted. On startup the extension **reconciles**: if it was
enabled but a VS Code update has replaced xterm (patch missing or stale), it re-applies
automatically and offers a reload.

## macOS "App Management" permission

On macOS, modifying an app under `/Applications` can require the **App Management** privacy
permission. If a patch write is denied (`EPERM`/`EACCES`), the extension shows a message with
an **Open Settings** button. Grant permission at:

**System Settings → Privacy & Security → App Management → enable your editor**

then use **Retry** (or run Enable again).

## Reversibility

Disabling removes only the bytes between the markers, restoring the xterm files **exactly**.
On the **asar** layout the whole archive comes back byte-for-byte too, holes and all. You can
verify either way:

```bash
APP="$(...)/Contents/Resources/app"
# files layout:
shasum -a 256 "$APP/node_modules/@xterm/xterm/lib/xterm."{js,mjs}
# asar layout:
shasum -a 256 "$APP/node_modules.asar"
# Enable → reload/restart → Disable → reload/restart, then hash again: it must match.
```

Every write is validated before it replaces the original: the patched content is syntax-checked
with `node --check` (run via the editor's own binary), written to a temporary file beside the
target, and only then atomically renamed over it — so the real file is never left in a broken
state.

The asar rewrite adds three more gates, all of which must pass before the rename:

1. The header must re-serialize byte-identically, or the rewrite is refused outright.
2. Every entry in the finished temporary archive is read back **through both headers** and
   compared with the source — never by recomputing offsets, since arithmetic compared against
   the same arithmetic will happily agree with itself while describing the wrong bytes.
3. Every entry that parsed as JSON before must still parse. A whole-archive offset slip shows
   up here immediately and unmistakably, which byte arithmetic alone can miss.

Worth doing before you enable it the first time, so recovery never depends on reinstalling:

```bash
cp "$(...)/Contents/Resources/app/node_modules.asar" ~/node_modules.asar.pristine
```

## Uninstalling

**Run "Disable" before uninstalling the extension.** On macOS an extension cannot clean up the
app bundle during uninstall (that step runs as an external process, which App Management blocks
from writing the bundle). An orphaned patch is harmless — it is self-contained, wrapped in
`try/catch`, keeps working, and is wiped automatically by the next VS Code update that replaces
xterm — but disabling first keeps things tidy.

## Performance

`.xterm-screen` ships as plain `position: relative`, so a 2D transform isn't guaranteed its
own compositor layer — each scroll could repaint the canvas. The patch therefore promotes the
element once with `will-change: transform` and animates with `translate3d(…)`, keeping every
update GPU-compositor-only, and it skips the style write when the sub-row offset is unchanged.

For the best result, make sure the terminal is using the GPU (WebGL) renderer:

```jsonc
// settings.json
"terminal.integrated.gpuAcceleration": "auto"  // or "on"
```

With the DOM renderer (`"off"`), the base render cost is much higher and no transform trick can
fully hide it. (A sub-pixel transform also trades a touch of crispness for smoothness while in
motion — that is inherent to the effect.)

## Known limitations

- Up to a half-row sliver may briefly show at the very top/bottom **during** active scrolling
  (the canvas renders only the visible rows; overscan is out of scope).
- After a font-size/zoom change the fractional offset can look momentarily stale until the next
  scroll, then self-corrects. (This build patches only `_handleScroll`.)
- Enable/Disable require a window reload to take effect — or, on the **asar** layout, a full
  quit and reopen, because the app process caches the archive's header for its lifetime.

## Project layout

```
package.json        manifest: commands, onStartupFinished, extensionKind ["ui"]
tsconfig.json
src/extension.ts    activate, commands, reconcile, reload/permission prompts, output channel
src/patcher.ts      PatchManager: layout backends, markers, apply/remove/status, validated writes
src/asar.ts         minimal asar reader/writer for the packed (node_modules.asar) layout
scroll-logic.js     the readable, type-checked injected body (between BODY:START/BODY:END)
```

`scroll-logic.js` is **data**, not compiled — the patcher reads it at runtime and splices the
text between its `BODY:START`/`BODY:END` markers verbatim. Edit the logic there; bump
`SNIPPET_VERSION` in `src/patcher.ts` when you do, so reconcile upgrades existing installs.

## Disclaimer

This tool rewrites files inside your editor's installation. It is reversible by design and
validates every write, but use it at your own risk. Not affiliated with Microsoft, the xterm.js
project, or any editor vendor.
