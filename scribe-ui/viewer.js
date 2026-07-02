/* eslint-disable import/no-cycle */
import scribe from '../scribe.js';
import { search } from './js/viewerSearch.js';
import {
  UiDataColumn, UiLayout, UiRegion, layout,
} from './js/viewerLayout.js';
import { clearObjectProperties } from '../js/utils/miscUtils.js';
import { UiText, UiOcrWord } from './js/viewerWordObjects.js';
import { ViewerImageCache } from './js/viewerImageCache.js';
import { contextMenuFunc, mouseupFunc2 } from './js/viewerCanvasInteraction.js';
import {
  deleteSelectedWord, modifySelectedWordBbox, modifySelectedWordStyle,
} from './js/viewerModifySelectedWords.js';
import { getAllFileEntries } from './js/dragAndDrop.js';
import { deleteSelectedLayoutDataTable, deleteSelectedLayoutRegion } from './js/viewerModifySelectedLayout.js';
import {
  applyHighlight, removeHighlight, modifyHighlightComment, updateHighlightGroupOutline,
} from './js/viewerHighlights.js';
import {
  ensureLayerStyleSheet, ScribeViewerState, ScribeViewerOpts, CanvasSelection,
  registerViewer, unregisterViewer, getActiveViewer, setActiveViewer,
  getDefaultViewer, getAllViewers, findViewerForTarget,
} from './js/viewerRuntime.js';
/**
 * Per-viewer canvas controller. Owns its own scroll container, document, selection, and event state.
 * Multiple instances can coexist on the same page. Each operates independently.
 *
 * For backward compatibility, the existing static `ScribeViewer.X` API is preserved as a facade.
 * It delegates to a default instance (the first one constructed, created lazily on first access).
 * Single-viewer applications can continue to use the static API unchanged.
 */
export class ScribeViewer {
  /**
   * Number of pages ahead and behind the current page to keep the text DOM built before `destroyText` evicts it.
   * Wider than the +/-1 build window (see `displayPage`) so scrolling back over recently-seen pages reuses their word spans instead of rebuilding.
   */
  static textRetainPages = 8;

  /**
   * After a deferred (fast-scroll or invis) page change, wait this long (ms) with no further page change before building the landed page's word DOM.
   * A fast sweep across many pages keeps rescheduling this, so it builds only the page it settles on rather than every page flown past (see `updateCurrentPage`).
   */
  static deferredTextSettleMs = 100;

  /**
   * Scroll speed (fraction of viewport height per frame) above which a page scrolls away too fast to read, so its word build is deferred (see `updateCurrentPage`).
   * Invis mode defers at any speed, since its text is invisible.
   */
  static deferTextVelocityFraction = 0.5;

  /** Blank vertical space (content px) between stacked pages, applied above the first page and below each page. */
  static pageMargin = 30;

  /**
   * In free-pan mode, how much blank scrollable space to add around the document, as a fraction of the largest page's width (left/right) and height (top/bottom).
   * One page-dimension lets a page be panned fully off an edge.
   */
  static freePanGutterFraction = 1;

  constructor() {
    this.state = new ScribeViewerState();
    this.opt = new ScribeViewerOpts();
    this.CanvasSelection = new CanvasSelection(this);
    this.imageCache = new ViewerImageCache(this);
    /** @type {import('../js/containers/scribeDoc.js').ScribeDoc} */
    this._doc = new scribe.ScribeDoc();

    /** @type {HTMLElement} */
    this.elem = /** @type {any} */ (null);
    /**
     * The outer element of the UI component that owns this viewer
     * (e.g. a wrapper that also contains a toolbar), if any.
     * Used to decide whether a click landed on the viewer's own controls when managing keyboard focus.
     * Defaults to `elem` when unset.
     * @type {?HTMLElement}
     */
    this.outerElem = null;
    /** @type {HTMLDivElement} */
    this.HTMLOverlayBackstopElem = /** @type {any} */ (null);

    this.textOverlayHidden = false;

    /** @type {Array<number>} */
    this._pageStopsStart = [];
    /** @type {Array<number>} */
    this._pageStopsEnd = [];

    /** @type {?Function} */
    this.displayPageCallback = null;

    /** @type {?Function} Fired after an undo/redo, so host UI (e.g. the bookmarks panel) can refresh non-page state. */
    this.onEditCallback = null;

    /**
     * Per-page container `<div>`s, indexed by page number. Each holds the page `<canvas>` raster,
     * the per-page text layer, and (in the editor) the overlay layer. Positioned in content space.
     * @type {Array<?HTMLDivElement>}
     */
    this.pageContainerArr = [];

    /**
     * The scrolling viewport. `overflow:auto`; its `scrollTop/Left` is the scroll position.
     * @type {HTMLDivElement}
     */
    this.scrollContainer = /** @type {any} */ (null);
    /**
     * Cached scroll-container box metrics (client/scroll height/width).
     * Reading them forces a synchronous layout, but they change only on viewport resize or content/zoom,
     * so they are cached and invalidated (set `null`) in `resize` and `_updateContentSize`.
     * @type {?{clientHeight: number, clientWidth: number, scrollHeight: number, scrollWidth: number}}
     */
    this._scrollMetricsCache = null;
    /**
     * Last scroll position read cleanly in `updateCurrentPage`, before the per-frame word build dirties layout.
     * @type {number}
     */
    this._scrollTop = 0;
    /** @type {number} */
    this._scrollLeft = 0;
    /**
     * Settle timer for a deferred (fast-scroll or invis) text build (see `updateCurrentPage`), or null when none is pending.
     * @type {?ReturnType<typeof setTimeout>}
     */
    this._deferredTextTimer = null;
    /**
     * Sized to the whole document (max display width x last page stop, times zoom) so the native scrollbar gets the right extent. Holds `zoomLayer`.
     * @type {HTMLDivElement}
     */
    this.contentSizer = /** @type {any} */ (null);
    /**
     * Wraps every page container; carries the single CSS `transform: scale(zoom)`.
     * @type {HTMLDivElement}
     */
    this.zoomLayer = /** @type {any} */ (null);

    /** Current zoom factor (was `stage.scaleX()`). The public `zoom()` method multiplies this. */
    this.zoomLevel = 1;

    /** Document extent in content space (unscaled): max page display width, and the last page stop. */
    this._contentWidth = 0;
    this._contentHeight = 0;
    /**
     * Effective content width (`_effectiveContentWidth`) at the last content re-layout.
     * `resize` compares against it to skip a resize that moves no page.
     */
    this._lastEffectiveWidth = -1;

    /**
     * Per-page text-layer containers, indexed by page then line orientation (0/1/2/3 = 0/90/180/270deg).
     * The +-1 page virtualization keys off the page index.
     * @type {Array<Object<string, HTMLDivElement>>}
     */
    this._textGroups = [];
    /** @type {Array<?HTMLDivElement>} */
    this._overlayGroups = [];
    /** @type {Array<number>} */
    this.textGroupsRenderIndices = [];
    /** @type {Array<number>} */
    this.overlayGroupsRenderIndices = [];

    /** The drag-select marquee `<div>`, shown only while a selection is in progress. */
    this.selectingRectangle = /** @type {any} */ (null);

    /** @type {?UiOcrWord} */
    this.contextMenuWord = null;

    /**
     * Rendered word objects per page (the DOM word layer), indexed by page number.
     * The text group's DOM children are per-line `<div>`s, so the word objects are tracked here rather than read back off the group.
     * @type {Array<Array<UiOcrWord>>}
     */
    this._wordObjs = [];
    /** @type {Array<Array<UiRegion>>} */
    this._regionObjs = [];
    /** @type {Array<Array<UiDataColumn>>} */
    this._dataColumnObjs = [];

    /**
     * Contains the x and y coordinates of the last right-click event.
     * Required for "right click" functions that are position-dependent,
     * as the cursor moves between the initial right click and selecting the option.
     */
    this.contextMenuPointer = { x: 0, y: 0 };

    this.selecting = false;
    this.enableCanvasSelection = false;
    this.enableHTMLOverlay = false;

    /** @type {bbox} */
    this.bbox = {
      top: 0, left: 0, right: 0, bottom: 0,
    };

    /** @type {('select'|'addWord'|'recognizeWord'|'recognizeArea'|'printCoords'|'addLayoutBoxOrder'|'addLayoutBoxExclude'|'addLayoutBoxDataTable')} */
    this.mode = 'select';

    this.drag = {
      isPinching: false,
      isDragging: false,
      isResizingColumns: false,
      dragDeltaTotal: 0,
      lastX: 0,
      lastY: 0,
      /** @type {?{x: number, y: number}} */
      lastCenter: null,
      /** @type {?number} */
      lastDist: null,
    };

    // Browser-style middle-button autoscroll (hold and move) for OCR viewing (`invis`) mode.
    this.autoScroll = {
      active: false,
      originX: 0,
      originY: 0,
      pointerX: 0,
      pointerY: 0,
      /** @type {?number} */
      rafId: null,
      /** @type {?HTMLDivElement} */
      indicator: null,
    };

    this.runSetInitial = true;

    /** @type {?ReturnType<typeof setTimeout>} Debounce for re-rastering page canvases after a zoom settles. */
    this._rerasterTimer = null;

    /** Per-instance controls array (transformers/handles for the currently selected word). */
    /** @type {Array<any>} */
    this._controlArr = [];

    /** @type {Array<HTMLElement>} */
    this._highlightOutlineRects = [];

    this._searchState = {
      search: '',
      /**
       * Ordered list of matches across the whole doc, one entry per occurrence.
       * @type {Array<{pageN: number, wordIds: Array<string>}>}
       * */
      matchList: [],
      /**
       * Index into `matchList` of the currently-focused match, or -1 when none.
       * @type {number}
       * */
      activeMatch: -1,
    };

    this.evalStats = [];
    this._evalStatsConfig = {
      /** @type {string|undefined} */
      ocrActive: undefined,
      ignorePunct: scribe.ScribeDoc.defaults.ignorePunct,
      ignoreCap: scribe.ScribeDoc.defaults.ignoreCap,
    };

    /** @type {?Range} */
    this._prevRange = null;
    this._prevStart = null;
    this._prevEnd = null;

    /** @type {?EventTarget} */
    this._mouseDownTarget = null;

    /** @param {*} event */
    this.interactionCallback = (event) => {};
    /** @param {boolean} deselect */
    // eslint-disable-next-line no-unused-vars
    this.destroyControlsCallback = (deselect) => {};

    registerViewer(this);
  }

  /** @returns {import('../js/containers/scribeDoc.js').ScribeDoc} */
  get doc() { return this._doc; }

  set doc(value) {
    const prev = this._doc;
    this._doc = value;
    if (prev && prev !== value && this.scrollContainer) this.clear();
  }

  /** Remove every per-page DOM container (raster, text, overlay) and reset the page-group bookkeeping. */
  _clearPageDom() {
    for (const pc of this.pageContainerArr) {
      if (pc) pc.remove();
    }
    this.pageContainerArr.length = 0;
    this._textGroups.length = 0;
    this.textGroupsRenderIndices.length = 0;
    this._overlayGroups.length = 0;
    this.overlayGroupsRenderIndices.length = 0;
  }

  /**
   * Drop every rendered page (DOM containers, rasters, text, and overlay groups) and reset the display state.
   * Call this after `doc.clear()`, which empties the document in place without firing the `doc` setter, so the stale pages would otherwise linger until the next rebuild.
   * Assigning a new document instead clears the view on its own, via the setter.
   */
  clear() {
    this.destroyControls();

    this._clearPageDom();

    this._highlightOutlineRects.length = 0;

    this._pageStopsStart.length = 0;
    this._pageStopsEnd.length = 0;

    this.imageCache.clear();

    this.evalStats.length = 0;
    this._evalStatsConfig = {
      ocrActive: undefined,
      ignorePunct: scribe.ScribeDoc.defaults.ignorePunct,
      ignoreCap: scribe.ScribeDoc.defaults.ignoreCap,
    };

    this._searchState = {
      search: '', matchList: [], activeMatch: -1,
    };

    this.state.cp.n = 0;
    this.state.searchMode = false;
  }

  /**
   * @param {number} n
   * @param {boolean} [start=true]
   * @returns {number}
   */
  getPageStop(n, start = true) {
    // In centered mode the first page always starts one margin down.
    // Free-pan adds a gutter above it, so fall through to the computed stop there instead of shortcutting.
    if (start && n === 0 && !this.opt.freePan) return ScribeViewer.pageMargin;

    if (start && this._pageStopsStart[n]) return this._pageStopsStart[n];
    if (!start && this._pageStopsEnd[n]) return this._pageStopsEnd[n];

    this.calcPageStops();

    if (start && this._pageStopsStart[n]) return this._pageStopsStart[n];
    if (!start && this._pageStopsEnd[n]) return this._pageStopsEnd[n];

    // @ts-ignore
    return null;
  }

  /**
   * Free-pan gutter (content px) padding the document on each side so pages can be dragged past the viewport edges.
   * @returns {{x: number, y: number}}
   */
  _panGutter() {
    if (!this.opt.freePan) return { x: 0, y: 0 };
    let maxWidth = 0;
    let maxHeight = 0;
    for (let i = 0; i < this.doc.pageMetrics.length; i++) {
      const dims = this.getDisplayDims(i);
      if (!dims) continue;
      if (dims.width > maxWidth) maxWidth = dims.width;
      if (dims.height > maxHeight) maxHeight = dims.height;
    }
    const k = ScribeViewer.freePanGutterFraction;
    return { x: maxWidth * k, y: maxHeight * k };
  }

  calcPageStops() {
    const margin = ScribeViewer.pageMargin;
    const gutter = this._panGutter();
    let y = gutter.y + margin;
    let maxWidth = 0;
    for (let i = 0; i < this.doc.pageMetrics.length; i++) {
      this._pageStopsStart[i] = y;
      const dims = this.getDisplayDims(i);
      if (!dims) return;

      y += dims.height + margin;
      this._pageStopsEnd[i] = y;
      if (dims.width > maxWidth) maxWidth = dims.width;
    }
    this._contentWidth = maxWidth + gutter.x * 2;
    this._contentHeight = y + gutter.y;
    this._updateContentSize();
  }

  /**
   * Snap a content-space coordinate so the page lands on a whole device pixel after the zoom transform.
   * A fractional device-pixel offset would otherwise blur the whole page.
   * @param {number} coord - Content-space position.
   * @returns {number} The position adjusted so `coord * zoom * devicePixelRatio` is a whole number.
   */
  _snapToDevice(coord) {
    const s = this.zoomLevel * (window.devicePixelRatio || 1);
    return s > 0 ? Math.round(coord * s) / s : coord;
  }

  /** Size the content sizer to the scaled document extent so the native scrollbars get the right range. */
  _updateContentSize() {
    if (!this.contentSizer) return;
    this._scrollMetricsCache = null; // content extent changing -> cached scrollHeight/Width are stale
    // Resolve the centering width once.
    // `_pageLeft` reads `clientWidth` (a forced layout), so using it per container below would force a reflow for each.
    const eff = this._effectiveContentWidth();
    this._lastEffectiveWidth = eff;
    const z = this.zoomLevel;
    const sizerW = `${eff * z}px`;
    const sizerH = `${this._contentHeight * z}px`;
    if (this.contentSizer.style.width !== sizerW) this.contentSizer.style.width = sizerW;
    if (this.contentSizer.style.height !== sizerH) this.contentSizer.style.height = sizerH;
    // Containers built before `calcPageStops` finalized `_contentWidth` can keep a stale centering, so re-center all to `eff`.
    // The write guards read inline style (no forced layout), so skipping unmoved pages costs nothing.
    // Read `_pageStopsStart` directly, since `getPageStop` could re-enter `calcPageStops`.
    for (let n = 0; n < this.pageContainerArr.length; n++) {
      const pc = this.pageContainerArr[n];
      if (!pc) continue;
      const dims = this.getDisplayDims(n);
      const left = `${dims ? this._snapToDevice((eff - dims.width) / 2) : 0}px`;
      if (pc.style.left !== left) pc.style.left = left;
      if (this._pageStopsStart[n] !== undefined) {
        const top = `${this._snapToDevice(this._pageStopsStart[n])}px`;
        if (pc.style.top !== top) pc.style.top = top;
      }
    }
  }

  /**
   * Scale the zoom layer and mirror the scale into the `--scribe-zoom` custom property.
   * Strokes on scaled descendants divide it back out with `calc(Npx / var(--scribe-zoom, 1))` so they keep a constant on-screen width at any zoom.
   * Every site that scales the layer must go through here so the property never drifts from the transform.
   * @param {number} z
   */
  _applyZoomTransform(z) {
    this.zoomLayer.style.transform = `scale(${z})`;
    this.zoomLayer.style.setProperty('--scribe-zoom', String(z));
  }

  /**
   * Content-space width the pages are centered within: the larger of the document's max page width and the viewport width (in content units).
   * Using the viewport width when it is larger centers a narrow page instead of left-aligning it under the thumbnail panel.
   * @returns {number}
   */
  _effectiveContentWidth() {
    const vw = this.scrollContainer ? this.scrollContainer.clientWidth / (this.zoomLevel || 1) : 0;
    return Math.max(this._contentWidth, vw);
  }

  /**
   * Content-space left offset of page `n` (pages are centered horizontally).
   * @param {number} n
   */
  _pageLeft(n) {
    const dims = this.getDisplayDims(n);
    return dims ? (this._effectiveContentWidth() - dims.width) / 2 : 0;
  }

  /**
   * Map a point in page `n`'s coordinate space (image px) to client (viewport) px.
   * @param {number} n
   * @param {{x: number, y: number}} pt
   * @returns {{x: number, y: number}}
   */
  contentToClient(n, pt) {
    const rect = this.zoomLayer.getBoundingClientRect();
    const cx = this._pageLeft(n) + pt.x;
    const cy = this.getPageStop(n) + pt.y;
    return { x: rect.left + cx * this.zoomLevel, y: rect.top + cy * this.zoomLevel };
  }

  /**
   * Map a client (viewport) point to content space (continuous page-stop space; scroll/zoom independent).
   * @param {number} clientX
   * @param {number} clientY
   * @returns {{x: number, y: number}}
   */
  clientToContent(clientX, clientY) {
    const rect = this.zoomLayer.getBoundingClientRect();
    return { x: (clientX - rect.left) / this.zoomLevel, y: (clientY - rect.top) / this.zoomLevel };
  }

  /**
   * Map a client (viewport) point to page space, returning the page it falls in.
   * @param {number} clientX
   * @param {number} clientY
   * @returns {{n: number, x: number, y: number}}
   */
  clientToPage(clientX, clientY) {
    const { x: cx, y: cy } = this.clientToContent(clientX, clientY);
    const n = this.calcPage(cy);
    return { n, x: cx - this._pageLeft(n), y: cy - this.getPageStop(n) };
  }

  /**
   * Page dimensions as displayed, accounting for a 90/270 user rotation (which swaps width/height).
   * The stored `pageMetrics[n].dims` is left unrotated; export uses it with the composed /Rotate.
   * @param {number} n
   * @returns {dims}
   */
  getDisplayDims(n) {
    const dims = this.doc.pageMetrics[n]?.dims;
    if (!dims) return dims;
    const rotation = this.doc.pageMetrics[n].rotation || 0;
    return (rotation % 180 === 90) ? { width: dims.height, height: dims.width } : dims;
  }

  /**
   * Rotate page `n` by `deltaDeg` (a multiple of 90), updating its user rotation.
   * A 90/270 step swaps the displayed dimensions and shifts every following page's stop, so the cached layout is rebuilt and the current view re-rendered.
   * The rotation is a display transform. Export persists it as the page's /Rotate.
   * @param {number} n
   * @param {number} deltaDeg
   */
  rotatePage(n, deltaDeg) {
    const pm = this.doc.pageMetrics[n];
    if (!pm) return;
    pm.rotation = ((((pm.rotation || 0) + deltaDeg) % 360) + 360) % 360;

    this._clearPageDom();
    this._pageStopsStart.length = 0;
    this._pageStopsEnd.length = 0;
    this.imageCache.clear();

    this.calcPageStops();
    this.displayPage(this.state.cp.n, false, true);
  }

  /**
   * Rebuild all per-page DOM state after a structural page edit (delete/move), then re-render at `cp`.
   * Unlike `rotatePage`, this also drops the overlay groups: a structural edit renumbers every page,
   * so overlay groups cached by page index would otherwise land on the wrong page.
   * @param {number} cp - Page to display after the rebuild.
   */
  _rebuildPages(cp, follow = false) {
    this._clearPageDom();
    this._pageStopsStart.length = 0;
    this._pageStopsEnd.length = 0;
    this.imageCache.clear();

    this.calcPageStops();

    // The scroll position survives the rebuild, so leave it unless `follow` is set (`cp` was the moved page, chase it)
    // or `cp` has scrolled out of the viewport.
    const zoom = this.zoomLevel;
    const { clientHeight } = this._scrollMetrics();
    const dims = this.getDisplayDims(cp);
    const top = this.getPageStop(cp) * zoom;
    const bottom = top + (dims ? dims.height * zoom : 0);
    const viewTop = this.scrollContainer.scrollTop;
    if (follow || top >= viewTop + clientHeight || bottom <= viewTop) {
      this.scrollContainer.scrollTop = Math.max(0, top - 100 * zoom);
    }
    // Render `cp`'s window; the surrounding read-ahead extends it to cover the rest of the viewport.
    this.displayPage(cp, false, true);
  }

  /**
   * Delete page `n` from the document and rebuild the view. The last remaining page cannot be deleted.
   * @param {number} n
   */
  deletePage(n) {
    if (!this.doc || n < 0 || n >= this.doc.pageMetrics.length) return;
    if (this.doc.pageMetrics.length <= 1) return;
    this.doc.deletePage(n);
    let cp = this.state.cp.n;
    if (n < cp) cp -= 1;
    cp = Math.max(0, Math.min(cp, this.doc.pageMetrics.length - 1));
    this._rebuildPages(cp);
  }

  /**
   * Move page `from` to index `to` and rebuild the view, keeping the current page in view.
   * @param {number} from
   * @param {number} to
   */
  movePage(from, to) {
    if (!this.doc) return;
    const len = this.doc.pageMetrics.length;
    if (from < 0 || from >= len || to < 0 || to >= len || from === to) return;
    this.doc.movePage(from, to);
    // Follow the shown page when it is the one being moved, so the view chases it to its new slot.
    const followed = this.state.cp.n === from;
    let cp = this.state.cp.n;
    if (cp === from) cp = to;
    else if (from < to && cp > from && cp <= to) cp -= 1;
    else if (from > to && cp >= to && cp < from) cp += 1;
    this._rebuildPages(cp, followed);
  }

  /**
   * Delete several pages at once, then rebuild the view a single time. Never deletes every page.
   * @param {Array<number>} indices
   */
  deletePages(indices) {
    if (!this.doc) return;
    const len = this.doc.pageMetrics.length;
    let valid = [...new Set(indices)].filter((i) => i >= 0 && i < len).sort((a, b) => a - b);
    if (valid.length >= len) valid = valid.slice(0, len - 1); // keep at least one page
    if (valid.length === 0) return;
    this.doc.deletePages(valid);
    // Shift the current page up by the deletions below it; if it was itself deleted this lands on the page that follows the deleted block.
    const removedBelow = valid.filter((i) => i < this.state.cp.n).length;
    const cp = Math.max(0, Math.min(this.state.cp.n - removedBelow, this.doc.pageMetrics.length - 1));
    this._rebuildPages(cp);
  }

  /**
   * Move several pages to a contiguous block starting at `to` (post-removal index), then rebuild the view once.
   * @param {Array<number>} indices
   * @param {number} to
   */
  movePages(indices, to) {
    if (!this.doc) return;
    const len = this.doc.pageMetrics.length;
    const valid = [...new Set(indices)].filter((i) => i >= 0 && i < len).sort((a, b) => a - b);
    if (valid.length === 0) return;
    const cpIndexInBlock = valid.indexOf(this.state.cp.n);
    this.doc.movePages(valid, to);
    // The displayed page follows its content: into the moved block if it was selected, else by the net shift.
    let cp;
    if (cpIndexInBlock >= 0) {
      cp = to + cpIndexInBlock;
    } else {
      const removedBelow = valid.filter((i) => i < this.state.cp.n).length;
      cp = this.state.cp.n - removedBelow + (this.state.cp.n - removedBelow >= to ? valid.length : 0);
    }
    cp = Math.max(0, Math.min(cp, this.doc.pageMetrics.length - 1));
    this._rebuildPages(cp, cpIndexInBlock >= 0);
  }

  /**
   * Insert clone bundles (from `doc.copyPages`) as a contiguous block at `to`, then rebuild the view once, landing on the first inserted page.
   * When `removeSourceIndices` is given (a cut), the original source pages are deleted after the insert, with their indices shifted for the pages inserted ahead of them.
   * @param {Array<object>} bundles - Clone bundles from `doc.copyPages`.
   * @param {number} to - Insertion index.
   * @param {{ removeSourceIndices?: Array<number> }} [options]
   * @returns {?{ start: number, count: number }} The inserted range, or `null` if nothing was pasted.
   */
  pastePages(bundles, to, { removeSourceIndices } = {}) {
    if (!this.doc || !this.opt.enablePageEditing) return null;
    if (!Array.isArray(bundles) || bundles.length === 0) return null;
    const count = bundles.length;
    const insertAt = Math.max(0, Math.min(to, this.doc.pageMetrics.length));
    this.doc.insertPages(bundles, insertAt);

    let start = insertAt;
    if (removeSourceIndices && removeSourceIndices.length) {
      // Sources at or after the insertion point shifted up by the inserted block; delete them in the new index space.
      const shifted = removeSourceIndices.filter((i) => i >= 0).map((i) => (i >= insertAt ? i + count : i));
      this.doc.deletePages(shifted);
      // Sources removed below the inserted block pull it up by that many slots.
      const removedBelow = shifted.filter((i) => i < start).length;
      start = Math.max(0, start - removedBelow);
    }
    const cp = Math.max(0, Math.min(start, this.doc.pageMetrics.length - 1));
    this._rebuildPages(cp);
    return { start, count };
  }

  /**
   * Rotate several pages by `deltaDeg`, then rebuild the view once.
   * Rotation is a display transform persisted as each page's /Rotate on export.
   * @param {Array<number>} indices
   * @param {number} deltaDeg
   */
  rotatePages(indices, deltaDeg) {
    if (!this.doc) return;
    if (!this.doc.rotatePages(indices, deltaDeg)) return;
    this._clearPageDom();
    this._pageStopsStart.length = 0;
    this._pageStopsEnd.length = 0;
    this.imageCache.clear();
    this.calcPageStops();
    this.displayPage(this.state.cp.n, false, true);
  }

  /**
   * Undo the last page operation (delete/move/reorder/insert/paste/duplicate/rotate) and rebuild the view.
   * @returns {boolean} Whether anything was undone.
   */
  undo() {
    if (!this.doc || !this.opt.enablePageEditing || !this.doc.undo()) return false;
    this._rebuildPages(Math.max(0, Math.min(this.state.cp.n, this.doc.pageMetrics.length - 1)));
    if (this.onEditCallback) this.onEditCallback();
    return true;
  }

  /**
   * Redo the last undone page operation and rebuild the view.
   * @returns {boolean} Whether anything was redone.
   */
  redo() {
    if (!this.doc || !this.opt.enablePageEditing || !this.doc.redo()) return false;
    this._rebuildPages(Math.max(0, Math.min(this.state.cp.n, this.doc.pageMetrics.length - 1)));
    if (this.onEditCallback) this.onEditCallback();
    return true;
  }

  /** Center of the scrolling viewport, in client (viewport) coordinates. Used as a default zoom anchor. */
  getViewportCenter() {
    const rect = this.scrollContainer.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  /**
   * Apply a zoom by `scaleBy`, keeping the content point currently under `center` fixed in the viewport.
   * @param {number} scaleBy
   * @param {{x: number, y: number}} center  Client (viewport) coordinates.
   */
  _zoomStageImp(scaleBy, center) {
    const oldZoom = this.zoomLevel;
    const newZoom = oldZoom * scaleBy;
    const scRect = this.scrollContainer.getBoundingClientRect();
    // Scaled-content position currently under `center`.
    const sx = center.x - scRect.left + this.scrollContainer.scrollLeft;
    const sy = center.y - scRect.top + this.scrollContainer.scrollTop;
    // The same unscaled content point, projected at the new zoom.
    const nx = (sx / oldZoom) * newZoom;
    const ny = (sy / oldZoom) * newZoom;

    this.zoomLevel = newZoom;
    this._applyZoomTransform(newZoom);
    this._updateContentSize();

    this.scrollContainer.scrollLeft = nx - (center.x - scRect.left);
    this.scrollContainer.scrollTop = ny - (center.y - scRect.top);
  }

  /**
   * @param {number} scaleBy
   * @param {?{x: number, y: number}} [center=null]
   */
  _zoomStage(scaleBy, center = null) {
    if (!center) {
      const selectedWords = this.CanvasSelection.getUiWords();
      if (selectedWords.length > 0) {
        // Word rects are in content space; convert the selection centre to a client point for the anchor.
        const rects = selectedWords.map((x) => x.getClientRect());
        const left = Math.min(...rects.map((r) => r.x));
        const right = Math.max(...rects.map((r) => r.x + r.width));
        const top = Math.min(...rects.map((r) => r.y));
        const bottom = Math.max(...rects.map((r) => r.y + r.height));
        const rect = this.zoomLayer.getBoundingClientRect();
        center = {
          x: rect.left + ((left + right) / 2) * this.zoomLevel,
          y: rect.top + ((top + bottom) / 2) * this.zoomLevel,
        };
      } else {
        center = this.getViewportCenter();
      }
    }

    this._zoomStageImp(scaleBy, center);
    this.updateCurrentPage();
    this._scheduleReraster();
  }

  /** After a zoom settles, re-raster the visible page canvases at the new resolution so they stay crisp. */
  _scheduleReraster() {
    if (this._rerasterTimer) clearTimeout(this._rerasterTimer);
    this._rerasterTimer = setTimeout(() => {
      this._rerasterTimer = null;
      if (this.doc.inputData.pdfMode || this.doc.inputData.imageMode) {
        this.imageCache.renderAheadBehindBrowser(this.state.cp.n);
      }
    }, 150);
  }

  /**
   * Scroll-container box metrics (client/scroll height/width).
   * Reading them forces a layout but they don't change during a scroll, so they are read once and reused until `resize`/`_updateContentSize` invalidate the cache.
   * @returns {{clientHeight: number, clientWidth: number, scrollHeight: number, scrollWidth: number}}
   */
  _scrollMetrics() {
    let m = this._scrollMetricsCache;
    if (!m) {
      const sc = this.scrollContainer;
      m = {
        clientHeight: sc.clientHeight,
        clientWidth: sc.clientWidth,
        scrollHeight: sc.scrollHeight,
        scrollWidth: sc.scrollWidth,
      };
      this._scrollMetricsCache = m;
    }
    return m;
  }

  /**
   * @param {number} [scrollSpeed=0] - Scroll distance (px) since the previous frame, supplied only by the scroll listener.
   *   Used to decide whether the page is changing too fast to read, and so whether to defer the build.
   * @returns {boolean}
   */
  updateCurrentPage(scrollSpeed = 0) {
    if (!this.scrollContainer) return false;
    // Read and cache the scroll position here for the scrollbar geometry to reuse without a per-frame reflow.
    // Reading it before the frame's word build dirties layout keeps it cheap.
    this._scrollTop = this.scrollContainer.scrollTop;
    this._scrollLeft = this.scrollContainer.scrollLeft;
    const y = (this._scrollTop + this._scrollMetrics().clientHeight / 2) / this.zoomLevel;
    const pageNew = this.calcPage(y);

    if (this.state.cp.n !== pageNew && pageNew >= 0) {
      // Defer the word build when the page changes too fast to read: update the page now and (re)arm a settle timer, so a fast sweep builds only the landing page.
      // Invis mode always defers (its text is invisible).
      // Visible modes defer only above the speed threshold, so a normal slow scroll builds immediately.
      const fast = scrollSpeed > this._scrollMetrics().clientHeight * ScribeViewer.deferTextVelocityFraction;
      const defer = this.state.displayMode === 'invis' || fast;
      this.displayPage(pageNew, false, false, defer);
      if (defer) {
        if (this._deferredTextTimer) clearTimeout(this._deferredTextTimer);
        this._deferredTextTimer = setTimeout(() => {
          this._deferredTextTimer = null;
          this.displayPage(this.state.cp.n, false, false);
        }, ScribeViewer.deferredTextSettleMs);
      }
      return true;
    }
    return false;
  }

  /**
   * Scroll the viewport by a pixel delta. Positive `deltaY` follows a downward drag (revealing content above).
   * The old stage model moved `stage.y` (negative-of-scroll) by `+delta`, so native scroll uses the inverse sign.
   * Native `overflow:auto` clamps the range, so the old manual page-bound clamps are gone.
   * @param {Object} coords
   * @param {number} [coords.deltaX=0]
   * @param {number} [coords.deltaY=0]
   */
  pan({ deltaX = 0, deltaY = 0 }) {
    if (!this.scrollContainer) return;
    this.scrollContainer.scrollLeft -= deltaX;
    this.scrollContainer.scrollTop -= deltaY;
  }

  /**
   * Zoom in or out on the canvas. Used for buttons and other controls.
   * @param {number} scaleBy
   * @param {?{x: number, y: number}} [center=null]
   */
  zoom(scaleBy, center = null) {
    this._zoomStage(scaleBy, center);
  }

  /**
   * Resize the canvas to new pixel dimensions.
   * @param {number} width
   * @param {number} height
   */
  resize(width, height) {
    if (!this.scrollContainer || !(width > 0) || !(height > 0)) return;
    this.scrollContainer.style.width = `${width}px`;
    this.scrollContainer.style.height = `${height}px`;
    this._scrollMetricsCache = null;
    // Page layout depends only on the effective content width, not the viewport height, so a resize that leaves it unchanged moves no page.
    // Skip the re-center walk over every container and let the browser reflow just the viewport box.
    const eff = Math.max(this._contentWidth, width / (this.zoomLevel || 1));
    if (eff !== this._lastEffectiveWidth) this._updateContentSize();
  }

  /**
   * Initiates dragging when the middle mouse button is pressed.
   * @param {MouseEvent} event
   */
  startDrag(event) {
    this.drag.isDragging = true;
    this.drag.lastX = event.clientX;
    this.drag.lastY = event.clientY;
    event.preventDefault();
  }

  /** @param {TouchEvent} event */
  startDragTouch(event) {
    this.drag.isDragging = true;
    this.drag.lastX = event.touches[0].clientX;
    this.drag.lastY = event.touches[0].clientY;
    event.preventDefault();
  }

  /** @param {MouseEvent} event */
  executeDrag(event) {
    if (!this.drag.isDragging) return;
    const deltaX = event.clientX - this.drag.lastX;
    const deltaY = event.clientY - this.drag.lastY;

    if (Math.round(deltaX) === 0 && Math.round(deltaY) === 0) return;

    this.drag.dragDeltaTotal += Math.abs(deltaX) + Math.abs(deltaY);

    this.drag.lastX = event.clientX;
    this.drag.lastY = event.clientY;

    this.pan({ deltaX, deltaY });
  }

  /** @param {TouchEvent} event */
  executeDragTouch(event) {
    if (!this.drag.isDragging) return;
    const deltaX = event.touches[0].clientX - this.drag.lastX;
    const deltaY = event.touches[0].clientY - this.drag.lastY;
    this.drag.lastX = event.touches[0].clientX;
    this.drag.lastY = event.touches[0].clientY;

    this.pan({ deltaX, deltaY });
  }

  /**
   * Stops dragging when the mouse button is released.
   * @param {Event} [event]
   */
  stopDragPinch(event) {
    this.drag.isDragging = false;
    this.drag.isPinching = false;
    this.drag.dragDeltaTotal = 0;
    this.drag.lastCenter = null;
    this.drag.lastDist = null;
  }

  /**
   * Begin browser-style hold-and-move autoscroll: while the middle button is held the document scrolls vertically.
   * Used in OCR viewing (`invis`) mode in place of the 1:1 drag-pan.
   * @param {MouseEvent} event
   */
  startAutoScroll(event) {
    this.stopAutoScroll();
    event.preventDefault(); // suppress the browser's own middle-click autoscroll
    const a = this.autoScroll;
    a.active = true;
    a.originX = event.clientX;
    a.originY = event.clientY;
    a.pointerX = event.clientX;
    a.pointerY = event.clientY;

    if (this.scrollContainer) this.scrollContainer.style.cursor = 'all-scroll';

    // Anchor indicator: a circle with a center dot at the press point (the familiar autoscroll affordance).
    const ind = document.createElement('div');
    Object.assign(ind.style, {
      position: 'fixed',
      left: `${a.originX}px`,
      top: `${a.originY}px`,
      width: '40px',
      height: '40px',
      marginLeft: '-20px',
      marginTop: '-20px',
      borderRadius: '50%',
      border: '1px solid rgba(0,0,0,0.35)',
      background: 'rgba(255,255,255,0.55)',
      boxShadow: '0 0 3px rgba(0,0,0,0.3)',
      zIndex: '2147483647',
      pointerEvents: 'none',
    });
    const dot = document.createElement('div');
    Object.assign(dot.style, {
      position: 'absolute',
      left: '50%',
      top: '50%',
      width: '4px',
      height: '4px',
      marginLeft: '-2px',
      marginTop: '-2px',
      borderRadius: '50%',
      background: 'rgba(0,0,0,0.6)',
    });
    ind.appendChild(dot);
    document.body.appendChild(ind);
    a.indicator = ind;

    const DEAD = 12; // px of slack before any scrolling starts
    const RANGE = 600; // px past the dead zone at which the max speed is reached
    const MIN = 10 / 60; // px-per-frame floor (~10 px/s) the instant past the dead zone, avoiding a sub-useful crawl
    const MAX = 400; // px-per-frame at full deflection (~24000 px/s at 60fps)
    const EXP = 3; // >1 -> gentle near the dead zone (fine, few-lines control), steep at the extremes
    const tick = () => {
      if (!a.active) return;
      // Vertical-only, like a standard PDF viewer: the horizontal cursor offset is ignored so the page never drifts left/right.
      // (Horizontal scrolling stays on Shift+wheel and the scrollbar.)
      // Cursor below origin (vY > 0) -> scroll down -> content moves up -> negate (matches the wheel handler's sign).
      const d = a.pointerY - a.originY;
      const past = Math.min(Math.abs(d) - DEAD, RANGE);
      const vY = past <= 0 ? 0 : Math.sign(d) * (MIN + (MAX - MIN) * (past / RANGE) ** EXP);
      if (vY !== 0) this.pan({ deltaY: -vY });
      a.rafId = requestAnimationFrame(tick);
    };
    a.rafId = requestAnimationFrame(tick);
  }

  /** Stop middle-button autoscroll and clean up its indicator and cursor. */
  stopAutoScroll() {
    const a = this.autoScroll;
    if (!a.active) return;
    a.active = false;
    if (a.rafId !== null) {
      cancelAnimationFrame(a.rafId);
      a.rafId = null;
    }
    if (this.scrollContainer) this.scrollContainer.style.cursor = '';
    if (a.indicator) {
      a.indicator.remove();
      a.indicator = null;
    }
  }

  /** @param {TouchEvent} event */
  executePinchTouch(event) {
    const touch1 = event.touches[0];
    const touch2 = event.touches[1];
    if (!touch1 || !touch2) return;
    this.drag.isPinching = true;
    const p1 = { x: touch1.clientX, y: touch1.clientY };
    const p2 = { x: touch2.clientX, y: touch2.clientY };

    const center = {
      x: (p1.x + p2.x) / 2,
      y: (p1.y + p2.y) / 2,
    };
    const dist = Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);

    if (!this.drag.lastDist || !this.drag.lastCenter) {
      this.drag.lastCenter = center;
      this.drag.lastDist = dist;
      return;
    }

    this._zoomStage(dist / this.drag.lastDist, center);
    this.drag.lastDist = dist;
  }

  /**
   * Whether a DOM target is page background (not a word span or a layout box). Used to detect deselect clicks.
   * @param {?EventTarget} el
   */
  // eslint-disable-next-line class-methods-use-this
  _isBackgroundTarget(el) {
    const node = /** @type {any} */ (el);
    return !node || typeof node.closest !== 'function' || !node.closest('.scribe-word, [data-scribe-kind]');
  }

  /**
   * Attach the viewer to a DOM element. Builds the native scroll container, content/zoom layers, and event handlers.
   * @param {HTMLDivElement} elem
   * @param {number} width
   * @param {number} height
   */
  init(elem, width, height) {
    this.elem = elem;
    ensureLayerStyleSheet();

    const scrollContainer = document.createElement('div');
    scrollContainer.className = 'scribe-viewport';
    Object.assign(scrollContainer.style, {
      position: 'relative',
      overflow: 'auto',
      width: `${width}px`,
      height: `${height}px`,
      // Hide the native scrollbars; the custom overlay scrollbars (panels.js) are the visible UI.
      scrollbarWidth: 'none',
    });

    const contentSizer = document.createElement('div');
    contentSizer.className = 'scribe-content';
    contentSizer.style.position = 'relative';

    const zoomLayer = document.createElement('div');
    zoomLayer.className = 'scribe-zoom';
    Object.assign(zoomLayer.style, {
      position: 'absolute', top: '0', left: '0', transformOrigin: '0 0',
    });

    contentSizer.appendChild(zoomLayer);
    scrollContainer.appendChild(contentSizer);
    elem.appendChild(scrollContainer);

    this.scrollContainer = scrollContainer;
    this.contentSizer = contentSizer;
    this.zoomLayer = zoomLayer;

    // Drag-select marquee, shown only while a selection is in progress. Positioned in content space.
    const marquee = document.createElement('div');
    Object.assign(marquee.style, {
      position: 'absolute', background: 'rgba(40,123,181,0.5)', pointerEvents: 'none', display: 'none', zIndex: '6',
    });
    zoomLayer.appendChild(marquee);
    this.selectingRectangle = marquee;

    // Invisible backstop behind the words that catches the selection focus in the empty gaps between them,
    // so dragging a selection through a gap extends only to the last word reached instead of jumping to the top of the page.
    // `_onSelection` keeps it just before the current focus word.
    // It overscans one page margin above and below to cover the blank strips between pages.
    const backstopOverscan = ScribeViewer.pageMargin;
    this.HTMLOverlayBackstopElem = document.createElement('div');
    this.HTMLOverlayBackstopElem.className = 'endOfContent';
    Object.assign(this.HTMLOverlayBackstopElem.style, {
      position: 'absolute',
      left: '0',
      top: `-${backstopOverscan}px`,
      width: '100%',
      height: `calc(100% + ${2 * backstopOverscan}px)`,
      display: 'none',
      pointerEvents: 'auto',
    });

    // `contextMenuFunc` lazily builds the shared menu, then shows only the actions that apply
    // (none on a read-only viewer, where it returns before suppressing the browser's own menu).
    scrollContainer.addEventListener('contextmenu', (event) => contextMenuFunc(this, event));

    // On native scroll, update the current page (coalesced to one update per frame),
    // passing the per-frame scroll distance as the speed `updateCurrentPage` uses to decide whether to defer the word build.
    let scrollRaf = /** @type {?number} */ (null);
    let lastScrollTopForSpeed = scrollContainer.scrollTop;
    scrollContainer.addEventListener('scroll', () => {
      if (scrollRaf !== null) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = null;
        const st = scrollContainer.scrollTop;
        const speed = Math.abs(st - lastScrollTopForSpeed);
        lastScrollTopForSpeed = st;
        this.updateCurrentPage(speed);
      });
    });

    // Middle-button 1:1 drag-pan (non-`invis` modes; `invis` mode uses autoscroll instead).
    scrollContainer.addEventListener('mousemove', (event) => this.executeDrag(event));

    scrollContainer.addEventListener('touchstart', (event) => {
      if (this.mode !== 'select') return;
      if (event.touches[1]) this.executePinchTouch(event);
      else this.startDragTouch(event);
    }, { passive: false });

    scrollContainer.addEventListener('touchmove', (event) => {
      if (event.touches[1]) this.executePinchTouch(event);
      else if (this.drag.isDragging) this.executeDragTouch(event);
    }, { passive: false });

    // Marquee drag-select (editor only; `enableCanvasSelection` is false in the read-only viewer).
    scrollContainer.addEventListener('pointerdown', (event) => {
      setActiveViewer(this);
      if (this.doc.pageMetrics.length === 0) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (!this.enableCanvasSelection) return;
      if (ScribeViewer.isTouchScreen && this.mode === 'select') return;

      this._mouseDownTarget = /** @type {any} */ (event.target);
      const start = this.clientToContent(event.clientX, event.clientY);
      this.bbox.left = start.x;
      this.bbox.top = start.y;
      this.bbox.right = start.x;
      this.bbox.bottom = start.y;
      marquee.style.width = '0';
      marquee.style.height = '0';
      this.selecting = true;
    });

    // The editor drives every drag (pan, marquee-select, box/handle resize) through pointer events, so the browser's native drag gesture is never wanted here.
    // Left alone it fires when a mousedown-drag begins on an existing text selection (e.g. one left by triple-click line-select or word editing),
    // showing a confusing "no-drop" cursor over a drop that can never happen.
    scrollContainer.addEventListener('dragstart', (event) => {
      if (this.enableCanvasSelection) event.preventDefault();
    });

    scrollContainer.addEventListener('pointermove', (event) => {
      if (!this.selecting) return;
      event.preventDefault();
      const end = this.clientToContent(event.clientX, event.clientY);
      this.bbox.right = end.x;
      this.bbox.bottom = end.y;
      Object.assign(marquee.style, {
        display: '',
        left: `${Math.min(this.bbox.left, this.bbox.right)}px`,
        top: `${Math.min(this.bbox.top, this.bbox.bottom)}px`,
        width: `${Math.abs(this.bbox.right - this.bbox.left)}px`,
        height: `${Math.abs(this.bbox.bottom - this.bbox.top)}px`,
      });
    });

    scrollContainer.addEventListener('pointerup', (event) => {
      // Suppress the native pointer-up default only when we own canvas selection and are not in layout mode.
      // The read-only HTML-overlay viewer relies on native selection,
      // so preventing the default there would stop the browser collapsing a selection on click and leave text stuck highlighted.
      if (this.enableCanvasSelection && !this.state.layoutMode) event.preventDefault();

      const mouseUpTarget = /** @type {HTMLElement} */ (event.target);
      const editingWord = !!UiText.input;

      // If a word is being edited, the only allowed action is clicking outside the word to deselect it.
      if (editingWord) {
        if (this._mouseDownTarget === UiText.inputWord || mouseUpTarget === UiText.inputWord) {
          this.selecting = false;
          return;
        }
        this.destroyControls();
      } else if (event.button === 0 && this._isBackgroundTarget(mouseUpTarget)
        && (this.selecting || this._isBackgroundTarget(/** @type {any} */ (this._mouseDownTarget)))) {
        this.destroyControls();
      }

      this.selecting = false;

      // A drag or pinch rather than a click: stop the gesture and skip the click handler.
      if (event.button === 1 || (this.drag.isDragging && this.drag.dragDeltaTotal > 10) || this.drag.isPinching || this.drag.isResizingColumns) {
        marquee.style.display = 'none';
        this.stopAutoScroll();
        this.stopDragPinch(event);
        return;
      }

      // `mouseupFunc2` hides the marquee itself, after reading whether one was drawn.
      // Hiding it here would make that read always false and collapse every drag-select into the single-word click path.
      if (this.enableCanvasSelection) mouseupFunc2(this, event);
      this.mode = 'select';
    });
  }

  /**
   * Set the initial position and zoom of the canvas to reasonable defaults.
   * @param {dims} imgDims - Dimensions of image
   */
  setInitialPositionZoom(imgDims) {
    this.runSetInitial = false;

    const totalHeight = this.scrollContainer.clientHeight;
    const interfaceHeight = 100;
    const bottomMarginHeight = 50;
    const targetHeight = totalHeight - interfaceHeight - bottomMarginHeight;

    const zoom = targetHeight / imgDims.height;
    this.zoomLevel = zoom;
    this._applyZoomTransform(zoom);
    // Populate `_contentWidth`/`_contentHeight` and size the content sizer before the scroll writes below.
    // Without this, on the first call both are still 0, so the content sizer gets zero height and the browser clamps the centering scroll to 0,
    // opening the document far below the viewport.
    this.calcPageStops();
    // `_contentWidth` is symmetric about the document centre (equal free-pan gutters), so centering it centers the document.
    // `scrollTop` skips the top gutter so the first page starts at the top of the viewport, not below a band of free-pan blank space.
    this.scrollContainer.scrollLeft = Math.max(0, (this._contentWidth * zoom - this.scrollContainer.clientWidth) / 2);
    this.scrollContainer.scrollTop = this._panGutter().y * zoom;
  }

  /**
   * Render the OCR word overlay for page `n`, clearing any existing words first.
   * @param {number} n
   */
  async renderWords(n) {
    let ocrData = this.doc.ocr.active?.[n];

    const noInfo = this.doc.inputData.xmlMode[n] === undefined;
    const noInput = !this.doc.inputData.xmlMode[n] && !(this.doc.inputData.imageMode || this.doc.inputData.pdfMode);
    const xmlMissing = this.doc.inputData.xmlMode[n]
      && (ocrData === undefined || ocrData === null || this.doc.pageMetrics[n].dims === undefined);

    const pageStopsMissing = this.getPageStop(n) === null;

    const imageMissing = false;
    const pdfMissing = false;

    if (this._textGroups[n]) {
      for (const group of Object.values(this._textGroups[n])) {
        group.replaceChildren();
      }
    }
    this._wordObjs[n] = [];

    if (UiText.inputWord && UiText.inputWord.word.line.page.n === n && UiText.inputRemove) {
      UiText.inputRemove();
    }
    this.CanvasSelection.deselectAllWords(n);

    if (noInfo || noInput || xmlMissing || imageMissing || pdfMissing || pageStopsMissing) {
      return;
    }

    if (this.doc.inputData.evalMode) {
      await this._compareGroundTruth();
      ocrData = this.doc.ocr.active?.[n];
    }

    if (this.doc.inputData.xmlMode[n]) {
      this._renderCanvasWords(ocrData);
    }
  }

  /**
   * Render page `n` in the UI.
   * @param {number} n
   * @param {boolean} [scroll=false]
   * @param {boolean} [refresh=true]
   * @param {boolean} [deferText=false] - Skip building/evicting the word DOM and overlays, doing only the cheap page change (raster, scrollbars, page number).
   *   Used while scrolling too fast to read the text (or any scroll in invis mode). `updateCurrentPage` schedules the real build for when the scroll settles.
   */
  async displayPage(n, scroll = false, refresh = true, deferText = false) {
    if (Number.isNaN(n) || n < 0 || n > (this.doc.inputData.pageCount - 1)) {
      if (this.displayPageCallback) this.displayPageCallback();
      return;
    }

    // A real build supersedes any pending deferred one (e.g. a click or the settle timer landing mid-scroll).
    if (!deferText && this._deferredTextTimer) {
      clearTimeout(this._deferredTextTimer);
      this._deferredTextTimer = null;
    }

    if (this.runSetInitial) {
      this.setInitialPositionZoom(this.doc.pageMetrics[n].dims);
    }

    // In ebook mode the page raster is hidden so only the (reflowed) text shows.
    const hideBackground = this.state.displayMode === 'ebook';
    for (const pc of this.pageContainerArr) {
      const canvas = pc && /** @type {any} */ (pc)._canvas;
      if (canvas) canvas.style.display = hideBackground ? 'none' : '';
    }

    this.textOverlayHidden = false;

    if (!deferText) {
      if (refresh || !this.textGroupsRenderIndices.includes(n)) {
        await this.renderWords(n);
      }

      if (n - 1 >= 0 && (refresh || !this.textGroupsRenderIndices.includes(n - 1))) {
        await this.renderWords(n - 1);
      }
      if (n + 1 < this.doc.ocr.active.length && (refresh || !this.textGroupsRenderIndices.includes(n + 1))) {
        await this.renderWords(n + 1);
      }
    }

    if (scroll) {
      // Land page `n` as the current page.
      // The scroll fires `updateCurrentPage`, which picks the page at the viewport centre.
      // Top-aligning a short page with the usual 100px gap would put that centre in the next page,
      // so top-align only tall pages and centre short ones to keep `n` current.
      const dims = this.getDisplayDims(n);
      const pageTop = this.getPageStop(n);
      const halfView = this._scrollMetrics().clientHeight / (2 * this.zoomLevel);
      const top = dims && halfView > dims.height + 100 ? pageTop + dims.height / 2 - halfView : pageTop - 100;
      this.scrollContainer.scrollTop = Math.max(0, top * this.zoomLevel);
    }

    this.state.cp.n = n;

    if (!deferText) {
      this.destroyText();
      this.destroyOverlay();
    }

    if (this.displayPageCallback) this.displayPageCallback();

    if (this.state.layoutMode && !deferText) {
      if (refresh || !this.overlayGroupsRenderIndices.includes(n)) {
        layout.renderLayoutBoxes(this, n);
      }
      if (n - 1 >= 0 && (refresh || !this.overlayGroupsRenderIndices.includes(n - 1))) {
        layout.renderLayoutBoxes(this, n - 1);
      }
      if (n + 1 < this.doc.ocr.active.length && (refresh || !this.overlayGroupsRenderIndices.includes(n + 1))) {
        layout.renderLayoutBoxes(this, n + 1);
      }
    }

    if ((this.doc.inputData.pdfMode || this.doc.inputData.imageMode)) {
      this.imageCache.renderAheadBehindBrowser(n);
    }
  }

  /**
   * Ensure the per-page container `<div>` exists (positioned in content space, sized to the displayed page),
   * creating it and attaching it to the zoom layer if needed.
   * @param {number} n
   * @returns {?HTMLDivElement}
   */
  _ensurePageContainer(n) {
    let pc = this.pageContainerArr[n];
    if (pc) return pc;
    const disp = this.getDisplayDims(n);
    if (!disp) return null;
    // Resolve the page stop first: it runs `calcPageStops`, which sets `_contentWidth` that `_pageLeft` reads to center the page.
    const top = this._snapToDevice(this.getPageStop(n));
    const left = this._snapToDevice(this._pageLeft(n));
    pc = document.createElement('div');
    pc.className = 'scribe-page';
    pc.dataset.page = String(n);
    Object.assign(pc.style, {
      position: 'absolute',
      left: `${left}px`,
      top: `${top}px`,
      width: `${disp.width}px`,
      height: `${disp.height}px`,
      outline: 'calc(1px / var(--scribe-zoom, 1)) solid black',
      background: '#fff',
    });
    // Insert the container in page-index order (before the nearest already-built higher-index page, or append if none), not at the end.
    // Native text selection spans nodes in DOM order, and containers are built lazily out of page order (n, n-1, n+1 in `displayPage`),
    // so appending would let a cross-page selection skip a middle page.
    let nextPc = null;
    for (let i = n + 1; i < this.pageContainerArr.length; i++) {
      if (this.pageContainerArr[i]) { nextPc = this.pageContainerArr[i]; break; }
    }
    this.zoomLayer.insertBefore(pc, nextPc);
    this.pageContainerArr[n] = pc;
    return pc;
  }

  /**
   * Build a per-page, per-orientation group `<div>`.
   * The group's local space is the page's unrotated space.
   * It is sized to that space, rotated about its centre, and centred within the displayed page.
   * Not yet attached to the DOM.
   * @param {number} n
   * @param {number} [orientation=0]
   * @returns {HTMLDivElement}
   */
  createGroup(n, orientation = 0) {
    const dims = this.doc.pageMetrics[n].dims;
    const disp = this.getDisplayDims(n);
    const userRotation = this.doc.pageMetrics[n].rotation || 0;
    const angle = this.doc.pageMetrics[n].angle || 0;
    const textRotation = scribe.ScribeDoc.defaults.autoRotate ? 0 : angle;
    const rotation = textRotation + orientation * 90 + userRotation;
    const localW = orientation % 2 === 1 ? dims.height : dims.width;
    const localH = orientation % 2 === 1 ? dims.width : dims.height;
    const group = document.createElement('div');
    group.className = 'scribe-group';
    Object.assign(group.style, {
      position: 'absolute',
      left: `${disp.width * 0.5 - localW * 0.5}px`,
      top: `${disp.height * 0.5 - localH * 0.5}px`,
      width: `${localW}px`,
      height: `${localH}px`,
      transformOrigin: `${localW * 0.5}px ${localH * 0.5}px`,
      transform: rotation ? `rotate(${rotation}deg)` : 'none',
      zIndex: '1',
    });
    return group;
  }

  /**
   * @param {number} n
   * @param {number} [orientation=0]
   */
  getTextGroup(n, orientation = 0) {
    if (!this._textGroups[n]) this._textGroups[n] = {};
    if (!this._textGroups[n][orientation]) {
      const group = this.createGroup(n, orientation);
      // The group box is sized to the whole page, so a rotated-orientation group overlaps the other orientation groups.
      // An interactive container would then swallow selection and clicks meant for the text under it.
      // Keep the container transparent to the pointer.
      // The word spans opt back in with their own `pointer-events: auto`.
      group.style.pointerEvents = 'none';
      group.classList.add('scribe-layer-text');
      this._textGroups[n][orientation] = group;
      const pc = this._ensurePageContainer(n);
      if (pc) pc.appendChild(group);
    }
    return this._textGroups[n][orientation];
  }

  /**
   * @param {number} n
   * @param {number} [rotation=0]
   */
  setTextGroupRotation(n, rotation = 0) {
    this.getTextGroup(n);
    const userRotation = this.doc.pageMetrics[n]?.rotation || 0;
    for (const [key, group] of Object.entries(this._textGroups[n])) {
      group.style.transform = `rotate(${Number(key) * 90 + rotation + userRotation}deg)`;
    }
  }

  /** @param {number} n */
  getOverlayGroup(n) {
    if (!this._overlayGroups[n]) {
      const group = this.createGroup(n);
      group.style.zIndex = '2';
      group.classList.add('scribe-layer-overlay');
      this._overlayGroups[n] = group;
      const pc = this._ensurePageContainer(n);
      if (pc) pc.appendChild(group);
    }
    return this._overlayGroups[n];
  }

  /**
   * Show or hide the OCR text layer (word boxes and lines) across every page.
   * @param {boolean} [visible=true]
   */
  setTextLayerVisible(visible = true) {
    this.elem?.classList.toggle('scribe-hide-text-layer', !visible);
  }

  /**
   * Show or hide the layout layer (regions, data columns, reading-order boxes) across every page.
   * @param {boolean} [visible=true]
   */
  setOverlayLayerVisible(visible = true) {
    this.elem?.classList.toggle('scribe-hide-overlay-layer', !visible);
  }

  /**
   * Show or hide the page image (raster background) layer across every page.
   * The `ebook` display mode also hides the image and takes precedence, so this has no effect while that mode is active.
   * @param {boolean} [visible=true]
   */
  setImageLayerVisible(visible = true) {
    this.elem?.classList.toggle('scribe-hide-image-layer', !visible);
  }

  /** @param {number} y */
  calcPage(y) {
    if (this._pageStopsEnd[this._pageStopsEnd.length - 1] === undefined) {
      this.calcPageStops();
    }
    return this._pageStopsEnd.findIndex((y1) => y1 > y);
  }

  calcSelectionImageCoords() {
    // `this.bbox` holds the marquee in content space; reduce it to the page-local box the OCR expects.
    const left = Math.min(this.bbox.left, this.bbox.right);
    const top = Math.min(this.bbox.top, this.bbox.bottom);
    const n = this.calcPage(top);

    const canvasCoordsPage = {
      left: left - this._pageLeft(n),
      top: top - this.getPageStop(n),
      width: Math.abs(this.bbox.right - this.bbox.left),
      height: Math.abs(this.bbox.bottom - this.bbox.top),
    };

    const imageRotated = true;
    const angle = this.doc.pageMetrics[n].angle || 0;

    const imageCoords = scribe.utils.coords.canvasToImage(canvasCoordsPage, imageRotated, scribe.ScribeDoc.defaults.autoRotate, n, this.doc.pageMetrics, angle);

    imageCoords.left = Math.round(imageCoords.left);
    imageCoords.top = Math.round(imageCoords.top);
    imageCoords.width = Math.round(imageCoords.width);
    imageCoords.height = Math.round(imageCoords.height);

    const pageDims = this.doc.pageMetrics[n].dims;
    const leftClip = Math.max(0, imageCoords.left);
    const topClip = Math.max(0, imageCoords.top);
    // Tesseract has a bug where subtracting 1 from the width/height when setting the rectangle to the full image fixes it.
    // See: https://github.com/naptha/tesseract.js/issues/936
    const rightClip = Math.min(pageDims.width - 1, imageCoords.left + imageCoords.width);
    const bottomClip = Math.min(pageDims.height - 1, imageCoords.top + imageCoords.height);
    imageCoords.left = leftClip;
    imageCoords.top = topClip;
    imageCoords.width = rightClip - leftClip;
    imageCoords.height = bottomClip - topClip;

    return { box: imageCoords, n };
  }

  getUiWords() {
    /** @type {Array<UiOcrWord>} */
    const words = [];
    const n = this.state.cp.n;
    for (const offset of [-1, 0, 1]) {
      const idx = n + offset;
      if (this._wordObjs[idx]) words.push(...this._wordObjs[idx]);
    }
    // A destroyed word can briefly remain in the registry; drop it so callers that measure the element
    // (rectangle selection, recolor) never dereference a null `el`.
    return words.filter((w) => w.el);
  }

  getUiRegions() {
    /** @type {Array<UiRegion>} */
    const regions = [];
    const n = this.state.cp.n;
    for (const offset of [-1, 0, 1]) {
      const group = this._overlayGroups[n + offset];
      if (!group) continue;
      group.querySelectorAll('[data-scribe-kind="layout"]').forEach((el) => {
        const obj = /** @type {any} */ (el)._scribeObj;
        if (obj instanceof UiRegion) regions.push(obj);
      });
    }
    return regions;
  }

  getUiDataColumns() {
    /** @type {Array<UiDataColumn>} */
    const columns = [];
    const n = this.state.cp.n;
    for (const offset of [-1, 0, 1]) {
      const group = this._overlayGroups[n + offset];
      if (!group) continue;
      group.querySelectorAll('[data-scribe-kind="layout"]').forEach((el) => {
        const obj = /** @type {any} */ (el)._scribeObj;
        if (obj instanceof UiDataColumn) columns.push(obj);
      });
    }
    return columns;
  }

  getDataTables() { return [...new Set(this.getUiDataColumns().map((x) => x.layoutBox.table))]; }

  getUiDataTables() { return [...new Set(this.getUiDataColumns().map((x) => x.uiTable))]; }

  /** @param {boolean} [deselect=true] - Deselect all words, layout boxes, and data columns. */
  destroyControls(deselect = true) {
    this._controlArr.forEach((control) => control.destroy());
    this._controlArr.length = 0;

    if (deselect) this.CanvasSelection.deselectAll();

    if (UiText.inputRemove) UiText.inputRemove();

    this.destroyControlsCallback(deselect);
  }

  /**
   * Move the selected word's edit handles back onto its edges after it moves or resizes.
   */
  repositionControls() {
    for (const control of this._controlArr) control.reposition?.();
  }

  /**
   * Destroy objects in the overlay layer. By default, only objects outside the current view are destroyed.
   * @param {boolean} [outsideViewOnly=true]
   */
  destroyOverlay(outsideViewOnly = true) {
    for (let i = 0; i < this.overlayGroupsRenderIndices.length; i++) {
      const n = this.overlayGroupsRenderIndices[i];
      if (Math.abs(n - this.state.cp.n) > 1 || !outsideViewOnly) {
        this._overlayGroups[n]?.replaceChildren();
        this._regionObjs[n] = [];
        this._dataColumnObjs[n] = [];
        this.overlayGroupsRenderIndices.splice(i, 1);
        i--;
      }
    }
  }

  /**
   * Destroy objects in the text layer. By default, only objects outside the current view are destroyed.
   * @param {boolean} [outsideViewOnly=true]
   */
  destroyText(outsideViewOnly = true) {
    for (let i = 0; i < this.textGroupsRenderIndices.length; i++) {
      const n = this.textGroupsRenderIndices[i];
      if (Math.abs(n - this.state.cp.n) > ScribeViewer.textRetainPages || !outsideViewOnly) {
        for (const group of Object.values(this._textGroups[n])) {
          group.replaceChildren();
        }
        this._wordObjs[n] = [];
        this.textGroupsRenderIndices.splice(i, 1);
        i--;
      }
    }
  }

  /** @param {Event} event */
  _onSelection(event) {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);

    const focusNodeElem = selection.focusNode?.nodeType === Node.ELEMENT_NODE ? selection.focusNode : selection.focusNode?.parentNode;
    const focusWordElem = /** @type {?HTMLElement} */ (/** @type {any} */ (focusNodeElem)?.closest?.('.scribe-word'));

    if (!focusWordElem) return;

    this.HTMLOverlayBackstopElem.style.display = '';

    focusWordElem.parentNode?.insertBefore(this.HTMLOverlayBackstopElem, focusWordElem);

    this._prevRange = range.cloneRange();
  }

  /**
   * Recolor every word for the current display mode (proof, ebook, eval, etc.).
   * Covers all rendered pages, not just the active window, since off-screen pages kept built (`textRetainPages`) would otherwise keep the previous mode's colors until rebuilt.
   */
  setWordColorOpacity() {
    for (const pageWords of this._wordObjs) {
      if (!pageWords) continue;
      for (const obj of pageWords) {
        const { fill, opacity } = scribe.utils.ocr.getWordFillOpacity(obj.word, this.state.displayMode,
          scribe.ScribeDoc.defaults.confThreshMed, scribe.ScribeDoc.defaults.confThreshHigh, scribe.ScribeDoc.defaults.overlayOpacity);
        obj.fill(fill);
        obj.opacity(opacity);
      }
    }
  }

  /**
   * Compare the active OCR pages against the ground truth and update `evalStats`.
   */
  async _compareGroundTruth() {
    const oemActive = Object.keys(this.doc.ocr).find((key) => this.doc.ocr[key] === this.doc.ocr.active && key !== 'active');

    if (!oemActive) {
      console.error('No OCR data active');
      return;
    }

    const evalStatsConfigNew = {
      ocrActive: oemActive,
      ignorePunct: scribe.ScribeDoc.defaults.ignorePunct,
      ignoreCap: scribe.ScribeDoc.defaults.ignoreCap,
    };
    /** @type {Parameters<typeof this.doc.compareOCR>[2]} */
    const compOptions = {
      ignorePunct: scribe.ScribeDoc.defaults.ignorePunct,
      ignoreCap: scribe.ScribeDoc.defaults.ignoreCap,
      confThreshHigh: scribe.ScribeDoc.defaults.confThreshHigh,
      confThreshMed: scribe.ScribeDoc.defaults.confThreshMed,
    };

    if (JSON.stringify(this._evalStatsConfig) !== JSON.stringify(evalStatsConfigNew) || this.evalStats.length === 0) {
      this._evalStatsConfig = evalStatsConfigNew;

      // TODO: This will overwrite any edits made by the user while `compareOCR` is running.
      // Is this a problem that is likely to occur in real use? If so, how should it be fixed?
      const res = await this.doc.compareOCR(this.doc.ocr.active, this.doc.ocr['Ground Truth'], compOptions);

      this.doc.ocr[oemActive] = res.ocr;
      this.doc.ocr.active = this.doc.ocr[oemActive];

      clearObjectProperties(this.evalStats);
      Object.assign(this.evalStats, res.metrics);
    }
  }

  /**
   * Draw OCR words for a page into the text layer.
   * @param {OcrPage} page
   */
  _renderCanvasWords(page) {
    const angle = this.doc.pageMetrics[page.n].angle || 0;
    const textRotation = scribe.ScribeDoc.defaults.autoRotate ? 0 : angle;

    this.setTextGroupRotation(page.n, textRotation);

    if (!this.textGroupsRenderIndices.includes(page.n)) this.textGroupsRenderIndices.push(page.n);

    const matchIdArr = this.state.searchMode ? scribe.utils.ocr.getMatchingWordIds(search.search, this.doc.ocr.active[page.n]) : [];

    // Word IDs of the currently-focused match, computed only when that match is on this page, so it renders distinctly from the others.
    const activeMatchEntry = this.state.searchMode ? this._searchState.matchList[this._searchState.activeMatch] : null;
    const activeIds = activeMatchEntry && activeMatchEntry.pageN === page.n ? new Set(activeMatchEntry.wordIds) : new Set();

    const imageRotated = Math.abs(angle ?? 0) > 0.05;

    const pageAnnotations = this.doc.annotations.pages[page.n] || [];

    if (!this._wordObjs[page.n]) this._wordObjs[page.n] = [];

    if (this.opt.outlinePars && page) {
      if (!page.textSource || !['textract', 'abbyy', 'google_vision', 'azure_doc_intel', 'docx'].includes(page.textSource)) {
        scribe.utils.assignParagraphs(page, angle);
      }

      page.pars.forEach((par, i) => {
        const angleAdj = imageRotated ? scribe.utils.ocr.calcLineStartAngleAdj(par.lines[0]) : { x: 0, y: 0 };
        this._addBlockOutline(page.n, par.bbox, angleAdj, i + 1, par.reason, par.lines[0]?.orientation ?? 0, par.lines);
      });
    }

    for (let i = 0; i < page.lines.length; i++) {
      const lineObj = page.lines[i];

      const group = this.getTextGroup(page.n, lineObj.orientation);

      const angleAdjLine = imageRotated ? scribe.utils.ocr.calcLineStartAngleAdj(lineObj) : { x: 0, y: 0 };

      if (this.opt.outlineLines) {
        const heightAdj = Math.abs(Math.tan(angle * (Math.PI / 180)) * (lineObj.bbox.right - lineObj.bbox.left));
        const height1 = lineObj.bbox.bottom - lineObj.bbox.top - heightAdj;
        const height2 = lineObj.words[0] ? lineObj.words[0].bbox.bottom - lineObj.words[0].bbox.top : 0;
        const height = Math.max(height1, height2);

        const lineRect = document.createElement('div');
        Object.assign(lineRect.style, {
          position: 'absolute',
          left: `${lineObj.bbox.left + angleAdjLine.x}px`,
          top: `${lineObj.bbox.bottom + lineObj.baseline[1] + angleAdjLine.y - height}px`,
          width: `${lineObj.bbox.right - lineObj.bbox.left}px`,
          height: `${height}px`,
          border: 'calc(1px / var(--scribe-zoom, 1)) solid rgba(0,0,255,0.75)',
          boxSizing: 'border-box',
          pointerEvents: 'none',
        });

        group.appendChild(lineRect);
      }

      // Words are wrapped in a per-line `<div>` so triple-click selects a single line, not the whole page.
      const lineDiv = document.createElement('div');
      lineDiv.className = 'scribe-line';
      group.appendChild(lineDiv);

      /** @type {UiOcrWord|null} */
      let prevWordCanvas = null;
      for (const wordObj of lineObj.words) {
        if (!wordObj.text) continue;

        const outlineWord = this.opt.outlineWords || this.state.displayMode === 'eval' && wordObj.conf > scribe.ScribeDoc.defaults.confThreshHigh && !wordObj.matchTruth;

        const angleAdjWord = imageRotated ? scribe.utils.ocr.calcWordAngleAdj(wordObj) : { x: 0, y: 0 };

        const visualBaseline = lineObj.bbox.bottom + lineObj.baseline[1] + angleAdjLine.y + angleAdjWord.y;

        let top = visualBaseline;
        if (wordObj.style.sup || wordObj.style.dropcap) top = wordObj.bbox.bottom + angleAdjLine.y + angleAdjWord.y;

        const visualLeft = wordObj.bbox.left + angleAdjLine.x + angleAdjWord.x;

        let highlightColor = null;
        let highlightOpacity = 1;
        let highlightGroupId = null;
        let highlightComment = '';
        for (const annot of pageAnnotations) {
          if (!(annot.bbox.left <= wordObj.bbox.left && annot.bbox.right >= wordObj.bbox.right
            && annot.bbox.top <= wordObj.bbox.top && annot.bbox.bottom >= wordObj.bbox.bottom)) continue;

          if (annot.quads) {
            const matchesQuad = annot.quads.some((quad) => quad.left < wordObj.bbox.right && quad.right > wordObj.bbox.left
              && quad.top < wordObj.bbox.bottom && quad.bottom > wordObj.bbox.top);
            if (!matchesQuad) continue;
          }

          highlightColor = annot.color;
          highlightOpacity = annot.opacity;
          highlightGroupId = annot.groupId || null;
          highlightComment = annot.comment || '';
          break;
        }

        const wordCanvas = new UiOcrWord({
          visualLeft,
          yActual: top,
          topBaseline: visualBaseline,
          rotation: 0,
          word: wordObj,
          outline: outlineWord,
          fillBox: matchIdArr.includes(wordObj.id) && !activeIds.has(wordObj.id),
          activeMatch: activeIds.has(wordObj.id),
          highlightColor,
          highlightOpacity,
          highlightGroupId,
          highlightComment,
          listening: !this.state.layoutMode,
          viewer: this,
        });

        if (wordCanvas.highlightColor && prevWordCanvas && prevWordCanvas.highlightColor
          && wordCanvas.highlightGroupId && wordCanvas.highlightGroupId === prevWordCanvas.highlightGroupId) {
          const gap = (wordCanvas.x() - (prevWordCanvas.x() + prevWordCanvas.width())) / 2;
          wordCanvas.highlightGapLeft = gap;
          prevWordCanvas.highlightGapRight = gap;
        }

        prevWordCanvas = wordCanvas;
        lineDiv.appendChild(wordCanvas.el);
        this._wordObjs[page.n].push(wordCanvas);
      }
    }
  }

  /**
   * Draw a paragraph/block outline.
   */
  // eslint-disable-next-line default-param-last
  _addBlockOutline(n, box, angleAdj, index, label, orientation = 0, lines) {
    const group = this.getTextGroup(n, orientation);

    const sortedLines = (lines && lines.length > 0 ? lines.map((l) => l.bbox) : [box])
      .slice()
      .sort((a, b) => a.top - b.top);
    const first = sortedLines[0];
    const last = sortedLines[sortedLines.length - 1];
    const topAlone = sortedLines.length === 1 || sortedLines[1].top >= first.bottom;
    const bottomAlone = sortedLines.length === 1 || sortedLines[sortedLines.length - 2].bottom <= last.top;

    const tlNotch = topAlone && first.left > box.left;
    const trNotch = topAlone && first.right < box.right;
    const blNotch = bottomAlone && last.left > box.left;
    const brNotch = bottomAlone && last.right < box.right;

    const ax = angleAdj.x;
    const ay = angleAdj.y;
    const points = [];
    if (tlNotch) points.push(first.left + ax, box.top + ay);
    else points.push(box.left + ax, box.top + ay);

    if (trNotch) {
      points.push(first.right + ax, box.top + ay);
      points.push(first.right + ax, first.bottom + ay);
      points.push(box.right + ax, first.bottom + ay);
    } else {
      points.push(box.right + ax, box.top + ay);
    }

    if (brNotch) {
      points.push(box.right + ax, last.top + ay);
      points.push(last.right + ax, last.top + ay);
      points.push(last.right + ax, box.bottom + ay);
    } else {
      points.push(box.right + ax, box.bottom + ay);
    }

    if (blNotch) {
      points.push(last.left + ax, box.bottom + ay);
      points.push(last.left + ax, last.top + ay);
      points.push(box.left + ax, last.top + ay);
    } else {
      points.push(box.left + ax, box.bottom + ay);
    }

    if (tlNotch) {
      points.push(box.left + ax, first.bottom + ay);
      points.push(first.left + ax, first.bottom + ay);
    }

    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    Object.assign(svg.style, {
      position: 'absolute', left: '0', top: '0', width: '0', height: '0', overflow: 'visible', pointerEvents: 'none',
    });
    const pointPairs = [];
    for (let i = 0; i < points.length; i += 2) pointPairs.push(`${points[i]},${points[i + 1]}`);
    const poly = document.createElementNS(ns, 'polygon');
    poly.setAttribute('points', pointPairs.join(' '));
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', 'rgba(0,0,255,0.75)');
    poly.setAttribute('stroke-width', '1');
    // Keep the outline a constant device width under the zoom layer's transform, instead of scaling to sub-pixel.
    poly.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.appendChild(poly);
    group.appendChild(svg);

    // Numbered badge to the left of the block's top-left corner.
    const radius = 14;
    const badge = document.createElement('div');
    Object.assign(badge.style, {
      position: 'absolute',
      left: `${box.left + angleAdj.x - 2 * radius - 4}px`,
      top: `${box.top + angleAdj.y}px`,
      width: `${2 * radius}px`,
      height: `${2 * radius}px`,
      borderRadius: '50%',
      background: 'rgba(0, 100, 200, 0.85)',
      color: '#fff',
      font: `bold ${radius * 1.2}px Arial`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      pointerEvents: 'none',
    });
    badge.textContent = String(index);
    group.appendChild(badge);

    if (label) {
      const reason = document.createElement('div');
      Object.assign(reason.style, {
        position: 'absolute',
        left: `${box.left + angleAdj.x}px`,
        top: `${box.top + angleAdj.y}px`,
        font: '12px Arial',
        color: 'rgba(0,0,255,0.75)',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
      });
      reason.textContent = label;
      group.appendChild(reason);
    }
  }

  /** Delete the currently selected word(s) from the document. */
  deleteSelectedWord() { return deleteSelectedWord(this); }

  /**
   * Adjust the left or right edge of the selected word's bbox by `amount` pixels.
   * @param {'left'|'right'} side
   * @param {number} amount
   */
  modifySelectedWordBbox(side, amount) { return modifySelectedWordBbox(this, side, amount); }

  /**
   * Apply style changes to the currently selected words.
   * @param {Object} style
   * @param {string} [style.font]
   * @param {number} [style.size]
   * @param {boolean} [style.bold]
   * @param {boolean} [style.italic]
   * @param {boolean} [style.underline]
   * @param {boolean} [style.smallCaps]
   * @param {boolean} [style.sup]
   */
  modifySelectedWordStyle(style) { return modifySelectedWordStyle(this, style); }

  /** Delete the currently selected layout data table. */
  deleteSelectedLayoutDataTable() { return deleteSelectedLayoutDataTable(this); }

  /** Delete the currently selected layout region(s). */
  deleteSelectedLayoutRegion() { return deleteSelectedLayoutRegion(this); }

  /**
   * Apply a highlight color and opacity to the given words, creating or updating their annotation data.
   * @param {Array<InstanceType<typeof UiOcrWord>>} words
   * @param {number} pageIndex
   * @param {string} color
   * @param {number} opacity
   */
  applyHighlight(words, pageIndex, color, opacity) { return applyHighlight(this, words, pageIndex, color, opacity); }

  /**
   * Remove highlights from the given words and drop their annotation data.
   * @param {Array<InstanceType<typeof UiOcrWord>>} words
   * @param {number} pageIndex
   */
  removeHighlight(words, pageIndex) { return removeHighlight(this, words, pageIndex); }

  /**
   * Set the comment on the highlight group containing the first selected word.
   * @param {Array<InstanceType<typeof UiOcrWord>>} words
   * @param {number} pageIndex
   * @param {string} comment
   */
  modifyHighlightComment(words, pageIndex, comment) { return modifyHighlightComment(this, words, pageIndex, comment); }

  /** Redraw the dashed outline around the words in the currently selected highlight group. */
  updateHighlightGroupOutline() { return updateHighlightGroupOutline(this); }

  /**
   * Tear down the viewer. Removes it from the global registry. Caller is responsible for the DOM.
   */
  destroy() {
    unregisterViewer(this);
    this.stopAutoScroll();
    this._clearPageDom();
    if (this.scrollContainer && this.scrollContainer.parentNode) this.scrollContainer.parentNode.removeChild(this.scrollContainer);
  }

  /** Detect a touchscreen (global, not per-viewer). */
  static isTouchScreen = navigator?.maxTouchPoints > 0;
}

// Static type/utility exports.
// These are not per-viewer state. They're class references.
ScribeViewer.UiText = UiText;
ScribeViewer.UiOcrWord = UiOcrWord;
ScribeViewer.UiLayout = UiLayout;
ScribeViewer.ViewerImageCache = ViewerImageCache;
ScribeViewer.search = search;
ScribeViewer.layout = layout;
ScribeViewer.getAllFileEntries = getAllFileEntries;

// Backward-compatibility static facade.
// Existing single-viewer applications call `ScribeViewer.X` (static). We preserve that surface
// by routing it to a default instance. The default is the first instance constructed.
// If no instance has been constructed yet, accessing the static API lazily creates one.
// Multi-viewer applications should construct their own `new ScribeViewer()` instances and use
// the instance API directly. Each instance is independent.

function getDefault() {
  return getDefaultViewer() || new ScribeViewer();
}

ScribeViewer.getDefault = getDefault;

ScribeViewer.getAllViewers = getAllViewers;

ScribeViewer.findViewerForTarget = findViewerForTarget;

/** @returns {?ScribeViewer} */
ScribeViewer.getActiveViewer = () => getActiveViewer() || getDefaultViewer();

const _delegatedMethods = [
  'init', 'displayPage', 'rotatePage', 'renderWords',
  'setInitialPositionZoom', 'getPageStop', 'calcPageStops', 'getViewportCenter',
  'pan', 'zoom', 'resize', 'startDrag', 'startDragTouch', 'executeDrag', 'executeDragTouch',
  'stopDragPinch', 'executePinchTouch', 'createGroup', 'getTextGroup', 'setTextGroupRotation',
  'getOverlayGroup', 'calcPage', 'calcSelectionImageCoords', 'getUiWords', 'getUiRegions',
  'getUiDataColumns', 'getDataTables', 'getUiDataTables', 'destroyControls', 'destroyOverlay',
  'destroyText', 'updateCurrentPage', 'setWordColorOpacity', 'deleteSelectedWord',
  'modifySelectedWordBbox', 'modifySelectedWordStyle', 'deleteSelectedLayoutDataTable',
  'deleteSelectedLayoutRegion', 'applyHighlight', 'removeHighlight', 'modifyHighlightComment',
  'updateHighlightGroupOutline', 'setTextLayerVisible', 'setOverlayLayerVisible', 'setImageLayerVisible',
  'clear', 'deletePages', 'movePages', 'pastePages', 'rotatePages',
];
for (const m of _delegatedMethods) {
  ScribeViewer[m] = (...args) => /** @type {any} */ (getDefault())[m](...args);
}

const _delegatedFields = [
  'elem', 'HTMLOverlayBackstopElem', 'textOverlayHidden', 'doc',
  'displayPageCallback', 'onEditCallback', 'scrollContainer',
  'textGroupsRenderIndices', 'overlayGroupsRenderIndices', 'selectingRectangle', 'contextMenuWord',
  'contextMenuPointer', 'selecting', 'enableCanvasSelection', 'enableHTMLOverlay', 'bbox',
  'mode', 'drag', 'runSetInitial', 'state', 'opt', 'CanvasSelection', 'evalStats',
  'interactionCallback', 'destroyControlsCallback',
];
for (const f of _delegatedFields) {
  if (Object.prototype.hasOwnProperty.call(ScribeViewer, f)) continue;
  Object.defineProperty(ScribeViewer, f, {
    configurable: true,
    get() { return /** @type {any} */ (getDefault())[f]; },
    set(v) { /** @type {any} */ (getDefault())[f] = v; },
  });
}

ScribeViewer.setWordColorOpacity = (...args) => getDefault().setWordColorOpacity(...args);
ScribeViewer.compareGroundTruth = (...args) => /** @type {any} */ (getDefault())._compareGroundTruth(...args);
ScribeViewer.renderCanvasWords = (page) => getDefault()._renderCanvasWords(page);
