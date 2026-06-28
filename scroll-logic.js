// @ts-check
/*
 * Pixel Scroll Terminal — injected scroll logic.
 * ---------------------------------------------------------------------------
 * This file is NOT loaded directly by the extension or by VS Code. It exists to
 * keep the injected code readable and type-checked. At patch time, the patcher
 * (src/patcher.ts) reads this file, extracts ONLY the text between the
 * BODY:START and BODY:END marker lines below, and splices it verbatim into
 * xterm's `Viewport.prototype._handleScroll`, immediately after the unique
 * anchor `this._isHandlingScroll=!0;`.
 *
 * Inside that method `this` is the xterm Viewport and `e` is the scroll event,
 * so the body below may reference `this` and `e` directly. The wrapper function
 * `__pixelScrollHandleScroll` is only scaffolding that lets `tsc --checkJs`
 * type-check the body in isolation.
 *
 * IMPORTANT constraints for the body (between the markers):
 *   - Use block comments only (no `//`) so it stays valid even on one line.
 *   - Keep it fully self-contained and wrapped in try/catch so a failure can
 *     never break xterm's own scroll handling.
 *   - Only reference identifiers that exist verbatim in BOTH the .js (CJS) and
 *     .mjs (ESM) xterm builds: `this._renderService.dimensions.css.cell.height`,
 *     `this._scrollableElement.getDomNode()`, and the `e.scrollTop` param.
 * ---------------------------------------------------------------------------
 */

/**
 * @typedef {Object} ScrollableElementDomNode
 * @property {(selectors: string) => (HTMLElement | null)} querySelector
 */

/**
 * @typedef {Object} ScrollableElementLike
 * @property {() => ScrollableElementDomNode} getDomNode
 */

/**
 * @typedef {Object} RenderServiceLike
 * @property {{ css: { cell: { height: number } } }} dimensions
 */

/**
 * Minimal shape of the xterm Viewport (`this`) that our body touches.
 * `__pixelScrollScreen` is our own cache field added at runtime.
 *
 * @typedef {Object} ViewportLike
 * @property {RenderServiceLike} _renderService
 * @property {ScrollableElementLike} _scrollableElement
 * @property {HTMLElement | null | undefined} __pixelScrollScreen
 */

/**
 * Stand-in for xterm's `Viewport.prototype._handleScroll`. Only the body
 * between the markers is extracted and spliced into the real method.
 *
 * @this {ViewportLike}
 * @param {{ scrollTop: number }} e
 * @returns {void}
 */
function __pixelScrollHandleScroll(e) {
  // BODY:START
  try {
    /* Exact cell height straight from xterm's render service (never measured from the DOM). */
    const cellHeight = this._renderService.dimensions.css.cell.height;
    if (cellHeight > 0) {
      /* The sub-row remainder xterm's canvas rounding discards on every scroll. */
      const offset = e.scrollTop - Math.round(e.scrollTop / cellHeight) * cellHeight;
      /* Cache .xterm-screen on this Viewport (one per terminal); re-find if detached. */
      let screenEl = this.__pixelScrollScreen;
      if (!screenEl || !screenEl.isConnected) {
        screenEl = this.__pixelScrollScreen =
          this._scrollableElement.getDomNode().querySelector('.xterm-screen');
      }
      /* Add the discarded fraction back as a compositor-only transform. */
      if (screenEl) {
        screenEl.style.transform = 'translateY(' + (-offset) + 'px)';
      }
    }
  } catch (_e) {
    /* Never let our code break xterm's own scroll handling. */
  }
  // BODY:END
}
