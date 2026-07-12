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
  annotMatchesWord, applyHighlight, removeHighlight, modifyHighlightComment, updateHighlightGroupOutline,
} from './js/viewerHighlights.js';
import { renderPageNotes } from './js/viewerNotes.js';
import { renderPageRedactions, updateRedactTab, hideRedactTabSoon } from './js/viewerRedactions.js';
import { ensureLayerStyleSheet, COMMENT_MARK_SVG } from './js/viewerLayerStyles.js';
import {
  ScribeViewerState, ScribeViewerOpts, CanvasSelection,
  registerViewer, unregisterViewer, getActiveViewer, setActiveViewer,
  getDefaultViewer, getAllViewers, findViewerForTarget,
} from './js/viewerRuntime.js';
import { DEBUG_RENDER_SCHED } from '../tess/TessScheduler.js';

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

  /**
   * Scroll speed (fraction of viewport height per frame) above which full-res page rasters are deferred to low-res previews (see `updateCurrentPage`).
   * Far below `deferTextVelocityFraction` because raster completions clump ~40-60ms of main-thread canvas insert each and starve the scroll loop.
   */
  static deferRasterVelocityFraction = 0.13;

  /**
   * Resume threshold for full rasters once deferred, below `deferRasterVelocityFraction` so the two form a hysteresis band against velocity noise flapping the strategy.
   */
  static resumeRasterVelocityFraction = 0.09;

  /**
   * Delay (ms) after the last scroll frame before restoring the invis-mode text layers hidden during a sustained scroll (see `_updateScrollTextHide`).
   */
  static scrollTextHideSettleMs = 200;

  /**
   * Cumulative scroll distance within one gesture (fraction of viewport height) that engages the mid-scroll text-layer hide.
   * High enough that a few wheel ticks don't churn the layers (each hide/show is a compositor update), low enough that a page-to-page scroll engages early.
   */
  static scrollTextHideDistanceFraction = 0.5;

  /**
   * Serve text selection from the OCR model (`js/viewerTextSelection.js`); set false for the invisible DOM text layer with the browser's native selection.
   */
  static customSelection = true;

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
    /**
     * The selection engine, resolved by `_sel()` from what the build registered: the model-driven engine, the invisible-text DOM engine, or null when `enableHTMLOverlay` is off.
     * @type {?{kind: string}}
     */
    this._selEngine = null;
    /** Latch for `_sel()`: the engine choice is made once, on first use after `init`. */
    this._selEngineInit = false;
    /**
     * The model-driven text selection, set by the custom engine's `attach` (`js/selection/customSelectionEngine.js`) and null under the DOM engine.
     * @type {?import('./js/viewerTextSelection.js').TextSelection}
     */
    this.textSel = null;
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

    /**
     * [Debug] When `true` the text overlay is never built, unlike `textOverlayHidden` which only hides an already-built one.
     * Meaningful only under the DOM selection engine (the built-in engine draws selection from the model, not from an overlay).
     */
    this.textOverlayDisabledDebug = false;

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
     * Settle timer for a deferred page build (see `updateCurrentPage`).
     * A deferred word build (fast scroll, or any scroll in invis mode) or raster window (preview glide) arms it.
     * Firing builds the landed page in full and ends any glide.
     * @type {?ReturnType<typeof setTimeout>}
     */
    this._deferredTextTimer = null;
    /**
     * Whether page rasters are currently deferred to previews.
     * Set/cleared with hysteresis in `updateCurrentPage`; force-cleared by any settled full render in `displayPage`.
     * @type {boolean}
     */
    this._rasterDeferred = false;
    /**
     * Whether the scroll is in the tail of a preview-mode glide, where page boundaries raster only the centered page.
     * The settled full render clears it and fills the window.
     * @type {boolean}
     */
    this._rasterTail = false;
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
     * Per-page text-layer containers, indexed by page then line orientation (0/1/2/3 = 0/90/180/270deg).
     * The +-1 page virtualization keys off the page index.
     * @type {Array<Object<string, HTMLDivElement>>}
     */
    this._textGroups = [];
    /**
     * Per-page highlight-layer containers, indexed by page then line orientation, mirroring `_textGroups`.
     * Drawn below the text layer and above the page raster, with `mix-blend-mode: multiply` so highlighted glyphs stay crisp.
     * @type {Array<Object<string, HTMLDivElement>>}
     */
    this._highlightGroups = [];
    /**
     * Per-page selection-layer containers, indexed by page then line orientation.
     * Holds the custom selection's rectangles and the search-match rectangles, above the highlight bands.
     * @type {Array<Object<string, HTMLDivElement>>}
     */
    this._selectGroups = [];
    /**
     * Per-page `word.id` -> word object, built alongside `_wordObjs` so a selection can resolve ids in one step.
     * @type {Array<Map<string, UiOcrWord>>}
     */
    this._wordObjMaps = [];
    /** Pages whose search-match rectangles need redrawing on the next frame. @type {Set<number>} */
    this._markRepaintPages = new Set();
    /** @type {?number} */
    this._markRepaintRaf = null;
    /**
     * Called after the custom text selection changes (including when it is cleared).
     * The host UI registers here to enable or disable selection-dependent controls.
     * @type {?() => void}
     */
    this.onSelectionChange = null;
    /**
     * Per-page maps from highlight group id to that group's fill rects, rebuilt with the fill layer, so hover feedback can lift every band of a group at once (including bands on other pages).
     * @type {Array<Map<string, Array<HTMLDivElement>>>}
     */
    this._highlightRectsByGroup = [];
    /**
     * Per-page comment marks, rebuilt with the fill layer.
     * The geometry is cached so a zoom change can re-place the marks without a rebuild.
     * @type {Array<Array<{el: HTMLSpanElement, right: number, top: number, bottom: number, nextLeft: ?number}>>}
     */
    this._commentMarks = [];
    /**
     * Called with the page index after that page's highlight or redaction layer is rebuilt.
     * The thumbnail panel registers here to keep its overlays current.
     * @type {?(n: number) => void}
     */
    this.onAnnotationsRendered = null;
    /**
     * Called with a highlight group id when the pointer enters a highlight, and null when it leaves.
     * The comments panel registers here to light the hovered highlight's row.
     * @type {?(groupId: ?string) => void}
     */
    this.onHighlightHover = null;
    /**
     * Rebuild the comments side panel so an open panel reflects a comment/note edited elsewhere (mini toolbar, note card).
     * The host registers this when the comments panel is installed.
     * @type {?() => void}
     */
    this._rebuildCommentsPanel = null;
    /** @type {Array<?HTMLDivElement>} */
    this._overlayGroups = [];
    /** @type {Array<?HTMLDivElement>} Per-page sticky-note layer (z above words/highlights, survives layout-mode teardown). */
    this._notesGroups = [];
    /** @type {Array<?HTMLDivElement>} Per-page redaction-mark layer (above highlights, below notes; never blocks the pointer). */
    this._redactGroups = [];
    /** @type {Array<?HTMLDivElement>} Per-page redaction "Preview" tab layer, kept out of the multiply-blending mark layer so the tab label stays opaque. */
    this._redactTabGroups = [];
    /**
     * State of the floating "Preview" tab over the hovered redaction mark.
     * @type {?{el: HTMLSpanElement, n: number, groupId: string, left: number, top: number, hideT: number, pinned: boolean, on: boolean}}
     */
    this._redactTab = null;
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

    // The highlight color the tool currently applies, mirrored here for the context menu.
    // Null when highlighting is disabled.
    /** @type {?string} */
    this._highlightColor = null;

    // Whether a redact tool is present, mirrored here for the context menu's "Redact" item.
    /** @type {boolean} */
    this._redactEnabled = false;

    // Host callback fired after a marking gesture.
    /** @type {?(marksAdded: number) => void} */
    this._onRedactMark = null;

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

    /** @type {?EventTarget} */
    this._mouseDownTarget = null;

    /** @param {*} event */
    this.interactionCallback = (event) => {};
    /** @param {boolean} deselect */
    // eslint-disable-next-line no-unused-vars
    this.destroyControlsCallback = (deselect) => {};

    registerViewer(this);
  }

  /**
   * The selection engines available to viewers, each registered by importing its module
   * (`js/selection/customSelectionEngine.js`, `js/selection/domSelectionEngine.js`), so a bundle ships only the engines it imports.
   * @type {{dom: ?{kind: string, attach: (viewer: ScribeViewer) => any}, custom: ?{kind: string, attach: (viewer: ScribeViewer) => any}}}
   */
  static _selectionEngines = { dom: null, custom: null };

  /** @param {{kind: 'dom'|'custom', attach: (viewer: ScribeViewer) => any}} engine */
  static registerSelectionEngine(engine) {
    ScribeViewer._selectionEngines[engine.kind] = engine;
  }

  /**
   * Whether text interaction is served by the model-driven `textSel` rather than the browser's native selection over invisible word spans.
   */
  get useCustomSelection() {
    return this._sel()?.kind === 'custom';
  }

  /**
   * This viewer's selection engine, resolved and installed on first use rather than at `init`.
   * @returns {?any}
   */
  _sel() {
    // Lazy because apps set enableHTMLOverlay/enableCanvasSelection after construction; the first render or pointer gesture is the first moment the choice is needed.
    if (!this._selEngineInit && this.elem) {
      this._selEngineInit = true;
      this._selEngine = this._resolveSelectionEngine();
      /** @type {any} */ (this._selEngine)?.install?.();
    }
    return this._selEngine;
  }

  /**
   * Pick and attach this viewer's selection engine from what the build registered.
   */
  _resolveSelectionEngine() {
    if (!this.enableHTMLOverlay) return null;
    const { dom, custom } = ScribeViewer._selectionEngines;
    if (this.enableCanvasSelection) {
      // Canvas selection (the editor's marquee) builds on the word-span layer, so it needs the DOM engine.
      if (!dom) throw new Error('enableCanvasSelection requires the DOM selection engine: import scribe-ui/js/selection/domSelectionEngine.js');
      return dom.attach(this);
    }
    // Otherwise use custom, except fall to DOM when both are registered and the customSelection switch is off.
    if (custom && (ScribeViewer.customSelection || !dom)) return custom.attach(this);
    if (dom) return dom.attach(this);
    throw new Error('No selection engine registered: import scribe-ui/js/selection/customSelectionEngine.js, scribe-ui/js/selection/domSelectionEngine.js, or both');
  }

  /**
   * [Debug] Swap this viewer's selection engine live, rebuilding the text layers so already-rendered pages adopt the new one.
   * It swaps by flipping the class-level `customSelection` switch, so both engines must be registered.
   * @param {'custom'|'dom'} kind
   */
  setSelectionEngineDebug(kind) {
    if (this._sel()?.kind === kind) return;
    this.clearTextSelection();
    /** @type {any} */ (this._selEngine)?.uninstall?.();
    this.textSel?.destroy();
    this.textSel = null;
    this._selEngine = null;
    this._selEngineInit = false;
    ScribeViewer.customSelection = kind === 'custom';
    // The overlay-disable debug flag is DOM-engine-only; clear it when leaving that engine, or pages stay overlay-less with no way to toggle it back.
    if (kind === 'custom') this.textOverlayDisabledDebug = false;
    this.destroyText(false);
    this.displayPage(this.state.cp.n, false, true);
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
    this._highlightGroups.length = 0;
    this._highlightRectsByGroup.length = 0;
    this._commentMarks.length = 0;
    this.textGroupsRenderIndices.length = 0;
    this._overlayGroups.length = 0;
    this._notesGroups.length = 0;
    this._redactGroups.length = 0;
    this._redactTabGroups.length = 0;
    this._redactTab = null;
    this.overlayGroupsRenderIndices.length = 0;
    this._selectGroups.length = 0;
    this._wordObjMaps.length = 0;
    // Runs on every document swap, page reorder, rotation, and teardown, so drop the selection's now-stale cached geometry and range.
    this.textSel?.invalidateAll();
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

  /** Size the content sizer to the scaled document extent so the native scrollbars get the right range, and re-center the pages. */
  _updateContentSize() {
    if (!this.contentSizer) return;
    this._scrollMetricsCache = null; // content extent changing -> cached scrollHeight/Width are stale
    // Pages are centered within the document's own content width, independent of the viewport.
    // A viewport-only change (window or sidebar resize) therefore moves no page, re-centering the whole block via `_updateHCentering` instead.
    const eff = this._contentWidth;
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
    this._updateHCentering(this.scrollContainer ? this.scrollContainer.clientWidth : 0);
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
    for (let n = 0; n < this._commentMarks.length; n++) {
      if (this._commentMarks[n]) this._placeCommentMarks(n);
    }
  }

  /**
   * Left offset that centers page `n` within the content width rather than the viewport, keeping page positions viewport-independent so a resize never moves them.
   * @param {number} n
   * @returns {number}
   */
  _pageLeft(n) {
    const dims = this.getDisplayDims(n);
    return dims ? (this._contentWidth - dims.width) / 2 : 0;
  }

  /**
   * Re-center the fixed-width content block horizontally within the viewport.
   * Because page positions are viewport-independent, centering is one margin on the content sizer,
   * so a resize or sidebar drag reflows just this box instead of walking every page and dirtying its word layer.
   * Snapped to a whole device pixel so the page raster stays crisp at rest.
   * @param {number} viewportWidth - The scroll container's inner width in CSS px.
   */
  _updateHCentering(viewportWidth) {
    if (!this.contentSizer) return;
    const contentPx = this._contentWidth * this.zoomLevel;
    const dpr = window.devicePixelRatio || 1;
    // Center only when the viewport is wider than the content. Otherwise the content overflows and scrolls from the left edge.
    const raw = Math.max(0, (viewportWidth - contentPx) / 2);
    const offset = `${Math.round(raw * dpr) / dpr}px`;
    if (this.contentSizer.style.marginLeft !== offset) this.contentSizer.style.marginLeft = offset;
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
   * The rotation, in degrees, that `createGroup` applies to page `n`'s group for orientation `orientation`.
   * @param {number} n
   * @param {number} orientation
   */
  _groupRotation(n, orientation) {
    const metrics = this.doc.pageMetrics[n];
    const textRotation = scribe.ScribeDoc.defaults.autoRotate ? 0 : (metrics.angle || 0);
    return textRotation + orientation * 90 + (metrics.rotation || 0);
  }

  /**
   * Map a displayed-page point into the local space of page `n`'s orientation group, the space the OCR line and word boxes live in.
   * Inverts the centre-rotation `createGroup` applies.
   * @param {number} n
   * @param {number} orientation
   * @param {number} x
   * @param {number} y
   * @returns {{x: number, y: number}}
   */
  pageToLocal(n, orientation, x, y) {
    const disp = this.getDisplayDims(n);
    const dims = this.doc.pageMetrics[n].dims;
    const localW = orientation % 2 === 1 ? dims.height : dims.width;
    const localH = orientation % 2 === 1 ? dims.width : dims.height;
    const rad = -this._groupRotation(n, orientation) * (Math.PI / 180);
    const dx = x - disp.width / 2;
    const dy = y - disp.height / 2;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return { x: dx * cos - dy * sin + localW / 2, y: dx * sin + dy * cos + localH / 2 };
  }

  /**
   * Map a point in page `n`'s orientation-group local space to content (page-stop) space.
   * @param {number} n
   * @param {number} orientation
   * @param {number} x
   * @param {number} y
   * @returns {{x: number, y: number}}
   */
  localToContent(n, orientation, x, y) {
    const disp = this.getDisplayDims(n);
    const dims = this.doc.pageMetrics[n].dims;
    const localW = orientation % 2 === 1 ? dims.height : dims.width;
    const localH = orientation % 2 === 1 ? dims.width : dims.height;
    const rad = this._groupRotation(n, orientation) * (Math.PI / 180);
    const dx = x - localW / 2;
    const dy = y - localH / 2;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return {
      x: this._pageLeft(n) + disp.width / 2 + dx * cos - dy * sin,
      y: this.getPageStop(n) + disp.height / 2 + dx * sin + dy * cos,
    };
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
   * @param {{ removeSourceIndices?: Array<number>, keepCurrentPage?: boolean }} [options]
   * @returns {?{ start: number, count: number, cp: number }} The inserted range and the page landed on (`cp`), or `null` if nothing was pasted.
   *   Callers doing an in-place rail splice need `cp` because `state.cp.n` updates asynchronously (the rebuild's `displayPage` is not awaited), so it is stale right after this returns.
   */
  pastePages(bundles, to, { removeSourceIndices, keepCurrentPage } = {}) {
    if (!this.doc || !this.opt.enablePageEditing) return null;
    if (!Array.isArray(bundles) || bundles.length === 0) return null;
    const count = bundles.length;
    const insertAt = Math.max(0, Math.min(to, this.doc.pageMetrics.length));
    // Remember the page in view before the insert shifts indices, so `keepCurrentPage` can stay on the same page.
    const prevCp = this.state.cp.n;
    // Sources at or after the insertion point shifted up by the inserted block. Delete them in the new index space.
    const shifted = (removeSourceIndices && removeSourceIndices.length)
      ? removeSourceIndices.filter((i) => i >= 0).map((i) => (i >= insertAt ? i + count : i))
      : null;
    // A cut is insert-then-delete-sources.
    // Record both as ONE undoable step, so a single undo reverses the whole move rather than leaving the intermediate state
    // where the pages exist in both their old and new places (which a later export would duplicate).
    // The inner verbs fold into this outer record via PageHistory's re-entrancy guard.
    // A plain copy has no `shifted`, so this records exactly the one insert.
    this.doc.history.record(() => {
      this.doc.insertPages(bundles, insertAt);
      if (shifted) this.doc.deletePages(shifted);
    });

    let start = insertAt;
    if (shifted) {
      // Sources removed below the inserted block pull it up by that many slots.
      const removedBelow = shifted.filter((i) => i < start).length;
      start = Math.max(0, start - removedBelow);
    }
    // Land on the freshly inserted block (a paste, which selects what it added), or, for an insert-from-file that should not disturb the reader,
    // stay on the page they were viewing, which shifts down by `count` only when the block lands at or before it.
    // Mirrors how `deletePage` keeps the current page rather than jumping.
    const landing = keepCurrentPage ? (prevCp >= insertAt ? prevCp + count : prevCp) : start;
    const cp = Math.max(0, Math.min(landing, this.doc.pageMetrics.length - 1));
    this._rebuildPages(cp);
    return { start, count, cp };
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
      const clientH = this._scrollMetrics().clientHeight;
      const fast = scrollSpeed > clientH * ScribeViewer.deferTextVelocityFraction;
      const defer = this.state.displayMode === 'invis' || fast;
      // The raster strategy defers on its own, much lower cutoff than text (see the statics for why).
      // A slow scroll that never entered a glide rasters every page immediately across the full window.
      if (this._rasterDeferred) {
        if (scrollSpeed < clientH * ScribeViewer.resumeRasterVelocityFraction) this._rasterDeferred = false;
      } else if (scrollSpeed > clientH * ScribeViewer.deferRasterVelocityFraction) {
        // The full raster window is cold when a glide decelerates below the cutoff, and firing it while still moving clumps completions into the decelerating frames.
        // The tail flag limits boundary rasters to the centered page; the settled render (displayPage below) fills the full window once the scroll holds still.
        this._rasterDeferred = true;
        this._rasterTail = true;
      }
      const deferRaster = this._rasterDeferred ? true : (this._rasterTail ? 'current' : false);
      this.displayPage(pageNew, false, false, defer, deferRaster);
      // Arm the settle timer whenever the raster is deferred, even if text built immediately:
      // only the settled render below fills the full raster window and ends the glide tail.
      // The displayPage call above cancels any pending timer when text is not deferred,
      // so without this re-arm a glide in a visible mode leaves previews until the next zoom.
      if (defer || deferRaster !== false) {
        if (this._deferredTextTimer) clearTimeout(this._deferredTextTimer);
        // Fire only once the scroll position holds still.
        // A fixed delay would fire mid-glide, because at low speeds page boundaries fall further apart than the delay.
        let armTop = this._scrollTop;
        const onSettle = () => {
          this._deferredTextTimer = null;
          const top = this.scrollContainer ? this.scrollContainer.scrollTop : armTop;
          if (Math.abs(top - armTop) > 2) {
            armTop = top;
            this._deferredTextTimer = setTimeout(onSettle, ScribeViewer.deferredTextSettleMs);
            return;
          }
          this.displayPage(this.state.cp.n, false, false);
        };
        this._deferredTextTimer = setTimeout(onSettle, ScribeViewer.deferredTextSettleMs);
      }
      return true;
    }
    return false;
  }

  /**
   * Page indices spanned by the current selection, middle pages of a multi-page selection included.
   * @returns {Set<number>}
   */
  _selectionPages() {
    if (this.useCustomSelection) return /** @type {NonNullable<typeof this.textSel>} */ (this.textSel).pages();
    return /** @type {any} */ (this._sel())?.pages?.() ?? new Set();
  }

  /**
   * Hide the built text layers during a sustained scroll.
   * `_endScrollTextHide` restores them at settle.
   * @param {number} speed - Scroll distance (px) since the previous frame.
   */
  _updateScrollTextHide(speed) {
    // Only the DOM engine puts text in the DOM, so only it has word/filler elements to stop compositing mid-scroll.
    /** @type {any} */ (this._sel())?.onScroll?.(speed);
  }

  /**
   * Restore every hidden text layer and reset the scroll gesture.
   */
  _endScrollTextHide() {
    /** @type {any} */ (this._sel())?.endScrollHide?.();
  }

  /**
   * Hide the built text layers until `endInteractionTextHide`.
   * Without hiding them, a host interaction that moves or re-clips the content repaints every built word each frame.
   */
  startInteractionTextHide() {
    /** @type {any} */ (this._sel())?.startInteractionHide?.();
  }

  /** Restore the text layers hidden by `startInteractionTextHide`; sharing the scroll-hide restore keeps either hide source from leaving a group stuck hidden. */
  endInteractionTextHide() {
    this._endScrollTextHide();
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
    // Pages are centered within `_contentWidth` independent of the viewport, so a resize moves no page and needs no O(pages) re-center walk.
    // Re-centering the whole block within the new viewport takes one snapped margin that the browser reflows as a single box, which keeps a sidebar drag or animation smooth.
    this._updateHCentering(width);
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
   * Begin browser-style middle-button autoscroll: the document scrolls toward the cursor's offset from the press point.
   * Used in OCR viewing (`invis`) mode in place of the 1:1 drag-pan.
   * @param {MouseEvent} event
   */
  startAutoScroll(event) {
    this.stopAutoScroll(false);
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

    const DEAD = 12; // px of slack before any scrolling starts (rejects click jitter)
    const TOE = 40; // px of the ramp's flat toe hidden behind the dead zone, so scrolling starts already climbing the curve instead of from its flat bottom
    const RANGE = 600; // px of ramp travel from its zero to full speed
    const SPAN = RANGE + TOE; // full ramp length, of which the TOE lives behind the dead zone
    const MIN = 10 / 60; // px-per-frame floor of the ramp, which combined with TOE and MAX puts the dead-zone edge speed at ~22 px/s
    const MAX = 800; // px-per-frame at full deflection (~48000 px/s at 60fps)
    const EXP = 3; // >1 -> gentle near the start, steep at the extremes
    const tick = () => {
      if (!a.active) return;
      // Ramp each axis through its own dead zone so a near-vertical hold does not creep sideways.
      // Negate because pan's delta is grab-style: a positive ramp (cursor down/right) would otherwise scroll the view up/left, away from the cursor.
      const ramp = (/** @type {number} */ d) => {
        const past = Math.abs(d) - DEAD;
        if (past <= 0) return 0;
        const r = Math.min(past + TOE, SPAN); // start TOE px up the curve, so the dead zone hides the flat toe
        return Math.sign(d) * (MIN + (MAX - MIN) * (r / SPAN) ** EXP);
      };
      const vX = ramp(a.pointerX - a.originX);
      const vY = ramp(a.pointerY - a.originY);
      if (vX !== 0 || vY !== 0) this.pan({ deltaX: -vX, deltaY: -vY });
      a.rafId = requestAnimationFrame(tick);
    };
    a.rafId = requestAnimationFrame(tick);
  }

  /**
   * Stop middle-button autoscroll and clean up its indicator and cursor.
   * @param {boolean} [settle=true] - Render the landing page at full resolution now.
   *   Pass false when the stop is not the user finishing a scroll.
   */
  stopAutoScroll(settle = true) {
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
    if (!settle) return;

    // Autoscroll stops instantly with no coast, so render the landing page at full resolution now instead of waiting for the deferred-text settle timer.
    // `updateCurrentPage` pins `cp` to the centred page so a late scroll frame no-ops instead of re-deferring; `displayPage` clears the pending timer.
    this.updateCurrentPage();
    this.displayPage(this.state.cp.n, false, false);
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
        this._updateScrollTextHide(speed);
      });
    });

    // Middle-button 1:1 drag-pan (non-`invis` modes; `invis` mode uses autoscroll instead).
    scrollContainer.addEventListener('mousemove', (event) => this.executeDrag(event));

    // Marks are pointer-transparent, so the "Preview" tab reveal hit-tests them on every move instead of using DOM hover.
    scrollContainer.addEventListener('mousemove', (event) => updateRedactTab(this, event));
    scrollContainer.addEventListener('mouseleave', () => hideRedactTabSoon(this));

    // Hovering any word of a highlight lifts every band of its group and swaps in a pointer cursor,
    // signalling the highlight is an engageable object (its actions live in the right-click menu).
    // Delegated rather than per-word so it tracks highlights applied or removed after the words were built.
    // The custom engine does this from geometry instead (`TextSelection._onHoverMove`), having no word elements to delegate to.
    if (!this.useCustomSelection) {
      /** @type {?{wordEl: HTMLElement, rects: Array<HTMLDivElement>}} */
      let hlLift = null;
      const clearHlLift = () => {
        if (!hlLift) return;
        for (const rect of hlLift.rects) rect.classList.remove('scribe-hl-hover');
        hlLift.wordEl.style.cursor = '';
        hlLift = null;
        if (this.onHighlightHover) this.onHighlightHover(null);
      };
      scrollContainer.addEventListener('mouseover', (event) => {
        const wordEl = event.target instanceof Element ? /** @type {?HTMLElement} */ (event.target.closest('.scribe-word')) : null;
        if (hlLift && hlLift.wordEl === wordEl) return;
        clearHlLift();
        if (!wordEl) return;
        const kw = /** @type {any} */ (wordEl)._scribeObj;
        if (!kw || !kw.highlightColor) return;
        /** @type {Array<HTMLDivElement>} */
        const rects = [];
        if (kw.highlightGroupId) {
          // A group can span pages (a selection highlighted across a page break), so gather bands from every page's map.
          for (const map of this._highlightRectsByGroup) {
            const arr = map && map.get(kw.highlightGroupId);
            if (arr) rects.push(...arr);
          }
        } else if (kw.highlightRectElem) {
          // A group-less highlight (imported without ids) lifts just its own band.
          rects.push(kw.highlightRectElem);
        }
        for (const rect of rects) rect.classList.add('scribe-hl-hover');
        wordEl.style.cursor = 'pointer';
        hlLift = { wordEl, rects };
        if (this.onHighlightHover) this.onHighlightHover(kw.highlightGroupId || null);
      });
      scrollContainer.addEventListener('mouseleave', clearHlLift);
    }

    scrollContainer.addEventListener('touchstart', (event) => {
      if (this.mode !== 'select') return;
      if (event.touches[1]) this.executePinchTouch(event);
      else this.startDragTouch(event);
    }, { passive: false });

    scrollContainer.addEventListener('touchmove', (event) => {
      // A press-and-hold has claimed this touch for a text selection; panning it too would fight the drag.
      if (this.useCustomSelection && this.textSel.isDragging()) { event.preventDefault(); return; }
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
        // The comparisons below match only the word, not the input element,
        // so without inInput the opening double-click's own mouseup would close the editor instantly.
        const inInput = UiText.input && mouseUpTarget instanceof Node && UiText.input.contains(mouseUpTarget);
        if (inInput || this._mouseDownTarget === UiText.inputWord || mouseUpTarget === UiText.inputWord) {
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
    // Clear the highlight layer here too, so a page that loses its text (no-data early return below) does not strand stale bands.
    if (this._highlightGroups[n]) {
      for (const group of Object.values(this._highlightGroups[n])) {
        group.replaceChildren();
      }
    }
    if (this._selectGroups[n]) {
      for (const group of Object.values(this._selectGroups[n])) {
        group.replaceChildren();
      }
      this.textSel?.destroyPage(n);
    }
    this._wordObjs[n] = [];
    this._wordObjMaps[n] = null;

    if (UiText.inputWord && UiText.inputWord.word.line.page.n === n && UiText.inputRemove) {
      UiText.inputRemove();
    }
    this.CanvasSelection.deselectAllWords(n);

    // Guard sits after the clears, not at the function top, so disabling the overlay still sheds its stale groups and words.
    if (this.textOverlayDisabledDebug) return;

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
   * @param {boolean|'current'} [deferRaster=false] - Raster strategy for this page change (see `updateCurrentPage`):
   *   true = skip full rasters and show low-res previews;
   *   'current' = raster only page `n`, with no ahead/behind window;
   *   false = full raster window, and clears any glide tail.
   */
  async displayPage(n, scroll = false, refresh = true, deferText = false, deferRaster = false) {
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

    // Issue the raster request before the synchronous word-DOM build so render workers can start on the target page instead of waiting.
    // Must run after setInitialPositionZoom so the canvases raster at the correct zoom.
    if (this.doc.inputData.pdfMode || this.doc.inputData.imageMode) {
      if (deferRaster === true) {
        // Full rasters are suppressed here, so the flown-past pages need a cheap preview to avoid blank.
        // Point the look-ahead in the scroll direction, the sign of the jump to `n`.
        this.imageCache.ensurePreviewWindow(n, Math.sign(n - this.state.cp.n) || 1);
      } else {
        this.imageCache.renderAheadBehindBrowser(n, deferRaster === 'current' ? 0 : undefined);
        if (!deferRaster) {
          // A full-window render ends any preview glide, so the next boundaries return to the normal slow-scroll path.
          this._rasterDeferred = false;
          this._rasterTail = false;
        }
      }
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

    this.renderNotes(n);
    if (n - 1 >= 0) this.renderNotes(n - 1);
    if (n + 1 < this.doc.ocr.active.length) this.renderNotes(n + 1);
    this.renderRedactions(n);
    if (n - 1 >= 0) this.renderRedactions(n - 1);
    if (n + 1 < this.doc.ocr.active.length) this.renderRedactions(n + 1);

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

    if (DEBUG_RENDER_SCHED && this.state.cp.n !== n) {
      console.log(`[render-sched] current page -> ${n} (was ${this.state.cp.n})`);
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
  }

  /**
   * Navigate to an outline (bookmark) destination.
   * A rotated page falls back to a plain page jump because its raster no longer shares the parse-time vertical axis that `yFrac` indexes.
   * @param {{ pageIndex: number, yFrac?: number }} dest
   */
  goToOutlineDest(dest) {
    const n = dest.pageIndex;
    if (!Number.isInteger(n) || n < 0 || n > (this.doc.inputData.pageCount - 1)) return;
    const dims = this.getDisplayDims(n);
    const userRotation = (this.doc.pageMetrics[n]?.rotation || 0) % 360;
    const yFrac = (typeof dest.yFrac === 'number' && userRotation === 0 && dims) ? dest.yFrac : null;
    if (yFrac == null || yFrac < 0.02) {
      this.displayPage(n, true, false);
      return;
    }

    this.displayPage(n, false, false);
    const yPx = yFrac * dims.height;
    // The same 100px lead-in displayPage's own page jump uses, so the two scroll styles agree at the page top.
    this.scrollContainer.scrollTop = Math.max(0, (this.getPageStop(n) + yPx - 100) * this.zoomLevel);
    this._flashDestination(n, yPx);
  }

  /**
   * One-shot flash marking the destination at page-space `yPx` on page `n`.
   * Styled inline and animated via WAAPI so it needs no stylesheet, working even in bare embeds.
   * @param {number} n
   * @param {number} yPx
   */
  _flashDestination(n, yPx) {
    const pc = this._ensurePageContainer(n);
    const dims = this.getDisplayDims(n);
    if (!pc || !dims) return;
    for (const prev of pc.querySelectorAll('.scribe-dest-flash')) prev.remove();
    const el = document.createElement('div');
    el.className = 'scribe-dest-flash';
    // Page space is ~300 DPI, so the 90px band is ~22pt.
    // That is roughly a heading line.
    const h = Math.min(90, dims.height);
    Object.assign(el.style, {
      position: 'absolute',
      left: '8px',
      right: '8px',
      top: `${Math.max(0, Math.min(yPx - h / 2, dims.height - h))}px`,
      height: `${h}px`,
      borderRadius: '6px',
      background: 'var(--scribe-accent-ring, rgba(28, 98, 212, .30))',
      pointerEvents: 'none',
      zIndex: '6',
    });
    pc.appendChild(el);
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.style.opacity = '0.6';
      setTimeout(() => el.remove(), 900);
    } else {
      const anim = el.animate(
        [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 0 }],
        { duration: 1400, easing: 'ease-out' },
      );
      anim.onfinish = () => el.remove();
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
    // Native selection follows DOM order, but pages build lazily out of order (n, n-1, n+1 in `displayPage`), so appending would let a cross-page selection skip a middle page.
    // The custom engine reads order from the model and does not care, but the word-editing path still uses native selection.
    let nextPc = null;
    for (let i = n + 1; i < this.pageContainerArr.length; i++) {
      if (this.pageContainerArr[i]) { nextPc = this.pageContainerArr[i]; break; }
    }
    this.zoomLayer.insertBefore(pc, nextPc);
    this.pageContainerArr[n] = pc;
    // A page built while a selection spans it (scrolled into view mid-drag) draws its part of it now.
    if (this.useCustomSelection && !this.textSel.isEmpty()) this.textSel.renderPage(n);
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
    // Keep the selection groups rotated in lock-step too, so selection and match rectangles track the words.
    if (this._selectGroups[n]) {
      for (const [key, group] of Object.entries(this._selectGroups[n])) {
        group.style.transform = `rotate(${Number(key) * 90 + rotation + userRotation}deg)`;
      }
    }
    // Keep the highlight groups rotated in lock-step with their text groups, so the band tracks the words on a skewed/rotated page.
    if (this._highlightGroups[n]) {
      for (const [key, group] of Object.entries(this._highlightGroups[n])) {
        group.style.transform = `rotate(${Number(key) * 90 + rotation + userRotation}deg)`;
      }
    }
  }

  /**
   * The per-page highlight fill layer, one group per line orientation like the text layer.
   * It blends with `mix-blend-mode: multiply` so a highlight tints the paper to its colour while the text layer above stays at full contrast.
   * @param {number} n
   * @param {number} [orientation=0]
   * @returns {HTMLDivElement}
   */
  getHighlightGroup(n, orientation = 0) {
    if (!this._highlightGroups[n]) this._highlightGroups[n] = {};
    if (!this._highlightGroups[n][orientation]) {
      const group = this.createGroup(n, orientation);
      group.style.zIndex = '0';
      group.style.pointerEvents = 'none';
      group.style.mixBlendMode = 'multiply';
      group.classList.add('scribe-layer-highlight');
      this._highlightGroups[n][orientation] = group;
      const pc = this._ensurePageContainer(n);
      if (pc) pc.appendChild(group);
    }
    return this._highlightGroups[n][orientation];
  }

  /**
   * The per-page selection layer, one group per line orientation like the highlight layer.
   * @param {number} n
   * @param {number} [orientation=0]
   * @returns {?HTMLDivElement}
   */
  getSelectGroup(n, orientation = 0) {
    if (!this._selectGroups[n]) this._selectGroups[n] = {};
    if (!this._selectGroups[n][orientation]) {
      const pc = this._ensurePageContainer(n);
      if (!pc) return null;
      const group = this.createGroup(n, orientation);
      // zIndex 1 sits above the highlight bands; the layer's `multiply` blend tints a selection over a highlight without washing out the glyphs beneath.
      group.style.zIndex = '1';
      group.classList.add('scribe-layer-select');
      this._selectGroups[n][orientation] = group;
      pc.appendChild(group);
    }
    return this._selectGroups[n][orientation];
  }

  /**
   * Page `n`'s word objects, keyed by word id, building them if this is the first caller to need them.
   * @param {number} n
   * @returns {Map<string, UiOcrWord>}
   */
  ensureWordObjs(n) {
    const existing = this._wordObjMaps[n];
    if (existing) return existing;
    const page = this.doc.ocr.active?.[n];
    if (!page || !this.doc.pageMetrics[n]) return new Map();
    this._buildWordObjs(page);
    return this._wordObjMaps[n] || new Map();
  }

  /**
   * Redraw page `n`'s search-match rectangles once the current burst of flag changes settles.
   * @param {number} n
   */
  scheduleMarkRepaint(n) {
    if (!this.useCustomSelection) return;
    this._markRepaintPages.add(n);
    // viewerSearch flips activeMatch/fillBox word by word; coalescing into one rAF keeps that a single repaint.
    if (this._markRepaintRaf !== null) return;
    this._markRepaintRaf = requestAnimationFrame(() => {
      this._markRepaintRaf = null;
      for (const page of this._markRepaintPages) {
        if (this.pageContainerArr[page]) this.textSel.renderMarks(page);
      }
      this._markRepaintPages.clear();
    });
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
   * The per-page sticky-note layer.
   * Kept out of the overlay layer so notes survive the layout-mode toggle that tears the overlay down.
   * @param {number} n
   * @returns {?HTMLDivElement}
   */
  getNotesGroup(n) {
    if (!this._notesGroups[n]) {
      const group = this.createGroup(n);
      group.style.zIndex = '3';
      // Transparent to the pointer so empty areas pass clicks through to the text; icons opt back in via CSS.
      group.style.pointerEvents = 'none';
      group.classList.add('scribe-layer-notes');
      this._notesGroups[n] = group;
      const pc = this._ensurePageContainer(n);
      if (pc) pc.appendChild(group);
    }
    return this._notesGroups[n];
  }

  /**
   * Render page n note icons into its notes layer.
   * @param {number} n
   */
  renderNotes(n) {
    if (!this.opt.enableComments) return;
    renderPageNotes(this, n);
  }

  /**
   * The per-page redaction-mark layer, lazily created; above highlights and text, below notes.
   * @param {number} n
   * @returns {?HTMLDivElement}
   */
  getRedactionsGroup(n) {
    if (!this._redactGroups[n]) {
      const group = this.createGroup(n);
      group.style.zIndex = '2';
      group.style.pointerEvents = 'none'; // Content under a mark stays selectable.
      group.style.mixBlendMode = 'multiply'; // Darkens rather than covers, so the hatch reads behind the glyphs and they keep full contrast.
      group.classList.add('scribe-layer-redact');
      this._redactGroups[n] = group;
      const pc = this._ensurePageContainer(n);
      if (pc) pc.appendChild(group);
    }
    return this._redactGroups[n];
  }

  /**
   * The per-page redaction "Preview" tab layer, lazily created; above the marks, unblended so the label stays opaque.
   * @param {number} n
   * @returns {?HTMLDivElement}
   */
  getRedactTabGroup(n) {
    if (!this._redactTabGroups[n]) {
      const group = this.createGroup(n);
      group.style.zIndex = '2';
      group.style.pointerEvents = 'none';
      group.classList.add('scribe-layer-redact-tab');
      this._redactTabGroups[n] = group;
      const pc = this._ensurePageContainer(n);
      if (pc) pc.appendChild(group);
    }
    return this._redactTabGroups[n];
  }

  /**
   * Render page n redaction marks into their layer.
   * No visibility gate: a mark changes what an export will contain, so every viewer must show it.
   * @param {number} n
   */
  renderRedactions(n) {
    renderPageRedactions(this, n);
    if (this.onAnnotationsRendered) this.onAnnotationsRendered(n);
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
      if (this.useCustomSelection && this.doc.ocr.active?.[idx]) this.ensureWordObjs(idx);
      if (this._wordObjs[idx]) words.push(...this._wordObjs[idx]);
    }
    // A destroyed word can briefly linger in the registry, so drop it before a caller measuring its geometry dereferences the null `el`.
    return words.filter((w) => !w._destroyed);
  }

  /** Drop the current text selection, whichever engine holds it. */
  clearTextSelection() {
    if (this.useCustomSelection) /** @type {NonNullable<typeof this.textSel>} */ (this.textSel).clear();
    else /** @type {any} */ (this._sel())?.clear?.();
  }

  /** Whether any of this viewer's text is currently selected. */
  hasTextSelection() {
    if (this.useCustomSelection) return !(/** @type {NonNullable<typeof this.textSel>} */ (this.textSel).isEmpty());
    // The native selection is window-global, so it only counts when it covers this viewer's own words.
    return /** @type {any} */ (this._sel())?.hasSelection?.() ?? false;
  }

  /**
   * The overlay words under the current text selection, scoped to this viewer.
   * @returns {Array<UiOcrWord>}
   */
  getWordsUnderTextSelection() {
    if (this.useCustomSelection) return /** @type {NonNullable<typeof this.textSel>} */ (this.textSel).getWords();
    return /** @type {any} */ (this._sel())?.getWords?.() ?? [];
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
        if (this._highlightGroups[n]) {
          for (const group of Object.values(this._highlightGroups[n])) {
            group.replaceChildren();
          }
        }
        if (this._selectGroups[n]) {
          for (const group of Object.values(this._selectGroups[n])) {
            group.replaceChildren();
          }
          this.textSel?.destroyPage(n);
        }
        this._wordObjs[n] = [];
        this._wordObjMaps[n] = null;
        this.textGroupsRenderIndices.splice(i, 1);
        i--;
      }
    }
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
   * Draw the debug paragraph outlines (`opt.outlinePars`).
   * @param {OcrPage} page
   * @param {number} angle
   */
  _renderParOutlines(page, angle) {
    if (!page.textSource || !['textract', 'abbyy', 'google_vision', 'azure_doc_intel', 'docx'].includes(page.textSource)) {
      scribe.utils.assignParagraphs(page, angle);
    }
    const imageRotated = Math.abs(angle) > 0.05;
    page.pars.forEach((par, i) => {
      const angleAdj = imageRotated ? scribe.utils.ocr.calcLineStartAngleAdj(par.lines[0]) : { x: 0, y: 0 };
      this._addBlockOutline(page.n, par.bbox, angleAdj, i + 1, par.reason, par.lines[0]?.orientation ?? 0, par.lines);
    });
  }

  /**
   * Build page `n`'s word objects without elements: the geometry, font metrics, and highlight/search state that highlight bands, search marks, and selection need.
   * @param {OcrPage} page
   */
  _buildWordObjs(page) {
    const angle = this.doc.pageMetrics[page.n].angle || 0;
    const imageRotated = Math.abs(angle) > 0.05;
    const pageAnnotations = this.doc.annotations.pages[page.n] || [];
    const matchIdArr = this.state.searchMode ? scribe.utils.ocr.getMatchingWordIds(search.search, this.doc.ocr.active[page.n]) : [];
    const activeMatchEntry = this.state.searchMode ? this._searchState.matchList[this._searchState.activeMatch] : null;
    const activeIds = activeMatchEntry && activeMatchEntry.pageN === page.n ? new Set(activeMatchEntry.wordIds) : new Set();

    /** @type {Array<UiOcrWord>} */
    const words = [];
    /** @type {Map<string, UiOcrWord>} */
    const byId = new Map();

    for (const lineObj of page.lines) {
      const angleAdjLine = imageRotated ? scribe.utils.ocr.calcLineStartAngleAdj(lineObj) : { x: 0, y: 0 };
      /** @type {?UiOcrWord} */
      let prevWordCanvas = null;
      for (const wordObj of lineObj.words) {
        if (!wordObj.text) continue;
        const angleAdjWord = imageRotated ? scribe.utils.ocr.calcWordAngleAdj(wordObj) : { x: 0, y: 0 };
        const visualBaseline = lineObj.bbox.bottom + lineObj.baseline[1] + angleAdjLine.y + angleAdjWord.y;
        const top = (wordObj.style.sup || wordObj.style.dropcap)
          ? wordObj.bbox.bottom + angleAdjLine.y + angleAdjWord.y : visualBaseline;

        const annot = pageAnnotations.find((a) => annotMatchesWord(a, wordObj.bbox));
        const lineAnnot = pageAnnotations.find((a) => annotMatchesWord(a, wordObj.bbox, 'line'));

        const wordCanvas = new UiOcrWord({
          visualLeft: wordObj.bbox.left + angleAdjLine.x + angleAdjWord.x,
          yActual: top,
          topBaseline: visualBaseline,
          rotation: 0,
          word: wordObj,
          fillBox: matchIdArr.includes(wordObj.id) && !activeIds.has(wordObj.id),
          activeMatch: activeIds.has(wordObj.id),
          highlightColor: annot ? annot.color : null,
          highlightOpacity: annot ? annot.opacity : 1,
          highlightGroupId: annot ? (annot.groupId || null) : null,
          highlightComment: annot ? (annot.comment || '') : '',
          markupType: lineAnnot ? /** @type {'underline'|'strikeout'} */ (lineAnnot.type) : null,
          markupColor: lineAnnot ? lineAnnot.color : null,
          markupOpacity: lineAnnot ? lineAnnot.opacity : 1,
          markupGroupId: lineAnnot ? (lineAnnot.groupId || null) : null,
          markupComment: lineAnnot ? (lineAnnot.comment || '') : '',
          viewer: this,
          dom: false,
        });

        // Words of one highlight group split the gap between them so the group reads as one continuous band, not per-word rectangles.
        if (wordCanvas.highlightColor && prevWordCanvas && prevWordCanvas.highlightColor
          && wordCanvas.highlightGroupId && wordCanvas.highlightGroupId === prevWordCanvas.highlightGroupId) {
          const gap = (wordCanvas.x() - (prevWordCanvas.x() + prevWordCanvas.width())) / 2;
          wordCanvas.highlightGapLeft = gap;
          prevWordCanvas.highlightGapRight = gap;
        }
        prevWordCanvas = wordCanvas;
        words.push(wordCanvas);
        byId.set(wordObj.id, wordCanvas);
      }
    }

    this._wordObjs[page.n] = words;
    this._wordObjMaps[page.n] = byId;
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

    // Under the custom engine in `invis` mode, no text enters the DOM; highlights and search render from word objects and the engine hit-tests selection geometrically.
    // Visible modes (proof/eval/ebook/annot) instead fall through to the span path below, where the words are the display.
    if (this.useCustomSelection && this.state.displayMode === 'invis') {
      if (this.opt.outlinePars) this._renderParOutlines(page, angle);
      // Word objects exist to carry highlight and search state; a page with neither needs none.
      const needsWords = (this.doc.annotations.pages[page.n] || []).length > 0 || this.state.searchMode;
      if (needsWords && !this._wordObjMaps[page.n]) this._buildWordObjs(page);
      this.renderHighlights(page.n);
      /** @type {NonNullable<typeof this.textSel>} */ (this.textSel).renderMarks(page.n);
      /** @type {NonNullable<typeof this.textSel>} */ (this.textSel).renderPage(page.n);
      return;
    }
    if (this.useCustomSelection) this._wordObjMaps[page.n] = null;

    const matchIdArr = this.state.searchMode ? scribe.utils.ocr.getMatchingWordIds(search.search, this.doc.ocr.active[page.n]) : [];

    // Word IDs of the currently-focused match, computed only when that match is on this page, so it renders distinctly from the others.
    const activeMatchEntry = this.state.searchMode ? this._searchState.matchList[this._searchState.activeMatch] : null;
    const activeIds = activeMatchEntry && activeMatchEntry.pageN === page.n ? new Set(activeMatchEntry.wordIds) : new Set();

    const imageRotated = Math.abs(angle ?? 0) > 0.05;

    const pageAnnotations = this.doc.annotations.pages[page.n] || [];

    if (!this._wordObjs[page.n]) this._wordObjs[page.n] = [];

    // Native selection only maps a pointer to a caret where it lands on real text,
    // so the render loop below fills every non-glyph gap of a line's territory ("band") with an invisible selectable span in reading order.
    // The following passes compute each line's band so the bands tile the page with no dead space.
    const pageDims = this.doc.pageMetrics[page.n].dims;
    const renderedLines = page.lines.filter((l) => l.words.some((w) => w.text));

    // Each line's horizontal extent is its COLUMN's width, not its own bbox; otherwise a short line (a paragraph's last line) leaves a selection hole out to the column edge.
    // A short line x-overlaps its column's full-width lines, so the union recovers that width.
    // The vertical window keeps a distant full-width title from welding separate columns into one extent.
    /** @type {Map<OcrLine, {left: number, right: number}>} */
    const colExtents = new Map();
    for (const l of renderedLines) {
      const lb = l.bbox;
      const dilate = (lb.bottom - lb.top) * 3;
      const ext = { left: lb.left, right: lb.right };
      for (const m of renderedLines) {
        const mb = m.bbox;
        if (mb.top >= lb.bottom + dilate || mb.bottom <= lb.top - dilate) continue;
        if (mb.left < lb.right && mb.right > lb.left) {
          ext.left = Math.min(ext.left, mb.left);
          ext.right = Math.max(ext.right, mb.right);
        }
      }
      colExtents.set(l, ext);
    }

    // Filler territories exist only for native selection, so only the DOM engine computes them.
    /** @type {Map<OcrLine, {left: number, right: number, top: number, bottom: number}>} */
    const fillLimits = /** @type {any} */ (this._sel())?.computeFillLimits?.(renderedLines, colExtents, pageDims)
      ?? new Map();
    // The custom engine owns hit-testing and selection, so its glyph spans must not be natively selectable.
    const selectText = this.state.displayMode === 'invis' && !this.useCustomSelection;

    if (this.opt.outlinePars) this._renderParOutlines(page, angle);

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

      // Words wrap in a per-line `<div>` so triple-click selects one line, not the whole page.
      // Do not make it a positioned/sized stacking context to speed up hit-testing: the engine does not bounds-cull child stacking contexts under the zoom transform.
      const lineDiv = document.createElement('div');
      lineDiv.className = 'scribe-line';
      group.appendChild(lineDiv);

      const lineWords = lineObj.words.filter((w) => w.text);
      const lim = fillLimits.get(lineObj);
      /** @type {(hitL: number, hitR: number) => void} */
      const appendFiller = /** @type {any} */ (this._sel())?.makeLineFiller?.(lineDiv, lim, angleAdjLine, selectText)
        ?? (() => {});
      let lineWordIdx = 0;

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

        const annot = pageAnnotations.find((a) => annotMatchesWord(a, wordObj.bbox));
        const lineAnnot = pageAnnotations.find((a) => annotMatchesWord(a, wordObj.bbox, 'line'));

        const wordCanvas = new UiOcrWord({
          visualLeft,
          yActual: top,
          topBaseline: visualBaseline,
          rotation: 0,
          word: wordObj,
          outline: outlineWord,
          fillBox: matchIdArr.includes(wordObj.id) && !activeIds.has(wordObj.id),
          activeMatch: activeIds.has(wordObj.id),
          highlightColor: annot ? annot.color : null,
          highlightOpacity: annot ? annot.opacity : 1,
          highlightGroupId: annot ? (annot.groupId || null) : null,
          highlightComment: annot ? (annot.comment || '') : '',
          markupType: lineAnnot ? /** @type {'underline'|'strikeout'} */ (lineAnnot.type) : null,
          markupColor: lineAnnot ? lineAnnot.color : null,
          markupOpacity: lineAnnot ? lineAnnot.opacity : 1,
          markupGroupId: lineAnnot ? (lineAnnot.groupId || null) : null,
          markupComment: lineAnnot ? (lineAnnot.comment || '') : '',
          // Paint-only under the custom engine: the spans are display, never pointer targets.
          listening: !this.state.layoutMode && !this.useCustomSelection,
          viewer: this,
        });

        if (wordCanvas.highlightColor && prevWordCanvas && prevWordCanvas.highlightColor
          && wordCanvas.highlightGroupId && wordCanvas.highlightGroupId === prevWordCanvas.highlightGroupId) {
          const gap = (wordCanvas.x() - (prevWordCanvas.x() + prevWordCanvas.width())) / 2;
          wordCanvas.highlightGapLeft = gap;
          prevWordCanvas.highlightGapRight = gap;
        }

        // The filler before this word: from the band's left edge (or the previous word's middle) to this word's middle.
        // Splitting at word middles puts the band above and below each word-half under the filler whose caret is the nearer word boundary.
        if (lim) {
          const midW = (wordObj.bbox.left + wordObj.bbox.right) / 2;
          if (lineWordIdx === 0) {
            appendFiller(lim.left, midW);
          } else {
            appendFiller((lineWords[lineWordIdx - 1].bbox.left + lineWords[lineWordIdx - 1].bbox.right) / 2, midW);
          }
        }
        lineWordIdx++;

        prevWordCanvas = wordCanvas;
        lineDiv.appendChild(wordCanvas.el);
        this._wordObjs[page.n].push(wordCanvas);
      }

      // The trailing filler: from the last word's middle out to the band's right edge.
      if (lim && lineWordIdx > 0) {
        const last = lineWords[lineWordIdx - 1];
        appendFiller((last.bbox.left + last.bbox.right) / 2, lim.right);
      }
    }

    this.renderHighlights(page.n);

    if (this.useCustomSelection) {
      // The engine's consumers look words up by id.
      // In visible modes the words already exist as spans, so index them rather than a separate dom:false `_buildWordObjs`.
      const byId = new Map();
      for (const kw of this._wordObjs[page.n]) byId.set(kw.word.id, kw);
      this._wordObjMaps[page.n] = byId;
      /** @type {NonNullable<typeof this.textSel>} */ (this.textSel).renderMarks(page.n);
      /** @type {NonNullable<typeof this.textSel>} */ (this.textSel).renderPage(page.n);
    }
  }

  /**
   * Rebuild page `n`'s highlight fill and line-markup layer from the per-word state on `_wordObjs[n]`.
   * Consecutive words on a line sharing the same highlight are merged into one rectangle,
   * so a multi-word highlight is one seamless band rather than a row of per-word rectangles.
   * Underline/strikeout runs merge the same way, drawn as one continuous bar per run.
   * @param {number} n
   */
  renderHighlights(n) {
    if (this._highlightGroups[n]) {
      for (const group of Object.values(this._highlightGroups[n])) group.replaceChildren();
    }
    this._highlightRectsByGroup[n] = new Map();
    if (this.onAnnotationsRendered) this.onAnnotationsRendered(n);
    const words = this._wordObjs[n];
    if (!words || words.length === 0) return;

    /** @type {Map<string, Array<UiOcrWord>>} */
    const lineMap = new Map();
    for (const kw of words) {
      kw.highlightRectElem = null;
      kw.markupRectElem = null;
      const lineId = kw.word.line.id;
      let lineArr = lineMap.get(lineId);
      if (!lineArr) { lineArr = []; lineMap.set(lineId, lineArr); }
      lineArr.push(kw);
    }

    // The last flushed run of each commented group, in reading order, marks where the group's comment mark goes.
    /** @type {Map<string, {right: number, top: number, bottom: number, nextLeft: ?number, orientation: number, color: string}>} */
    const markRuns = new Map();

    for (const lineWords of lineMap.values()) {
      lineWords.sort((a, b) => a.x() - b.x());

      /** @type {?{key: string, color: string, opacity: number, groupId: ?string, words: Array<UiOcrWord>, left: number, right: number, top: number, bottom: number, orientation: number}} */
      let run = null;
      /** @param {?number} [nextLeft] Left edge of the word that ends the run on its line (null at line end). */
      const flush = (nextLeft = null) => {
        if (!run) return;
        const group = this.getHighlightGroup(n, run.orientation);
        const rect = document.createElement('div');
        const r = parseInt(run.color.slice(1, 3), 16);
        const g = parseInt(run.color.slice(3, 5), 16);
        const b = parseInt(run.color.slice(5, 7), 16);
        // The band's alpha lives in `opacity` via `--scribe-hl-o` (not in an rgba background), so the hover lift is one class toggle that scales it up without re-deriving the colour.
        rect.className = 'scribe-hl-band';
        rect.style.setProperty('--scribe-hl-o', `${run.opacity}`);
        Object.assign(rect.style, {
          position: 'absolute',
          left: `${run.left}px`,
          top: `${run.top}px`,
          width: `${run.right - run.left}px`,
          height: `${run.bottom - run.top}px`,
          background: `rgb(${r}, ${g}, ${b})`,
          pointerEvents: 'none',
        });
        group.appendChild(rect);
        for (const rkw of run.words) rkw.highlightRectElem = rect;
        if (run.groupId) {
          const arr = this._highlightRectsByGroup[n].get(run.groupId);
          if (arr) arr.push(rect); else this._highlightRectsByGroup[n].set(run.groupId, [rect]);
          if (run.words[0].highlightComment) {
            markRuns.set(run.groupId, {
              right: run.right, top: run.top, bottom: run.bottom, nextLeft, orientation: run.orientation, color: run.color,
            });
          }
        }
        run = null;
      };

      /**
       * @type {?{key: string, type: ('underline'|'strikeout'), color: string, opacity: number, groupId: ?string,
       *   words: Array<UiOcrWord>, left: number, right: number, top: number, bottom: number, baseline: number, maxFs: number, orientation: number}}
       */
      let lineRun = null;
      /** @param {?number} [nextLeft] Left edge of the word that ends the run on its line (null at line end). */
      const flushLine = (nextLeft = null) => {
        if (!lineRun) return;
        const group = this.getHighlightGroup(n, lineRun.orientation);
        const rect = document.createElement('div');
        const r = parseInt(lineRun.color.slice(1, 3), 16);
        const g = parseInt(lineRun.color.slice(3, 5), 16);
        const b = parseInt(lineRun.color.slice(5, 7), 16);
        // One continuous bar per run, spanning the word gaps like PDF /Underline and /StrikeOut, so no gap-splitting applies here.
        const barHeight = Math.max(lineRun.maxFs * 0.06, 1);
        const barCenter = lineRun.type === 'underline'
          ? lineRun.baseline + lineRun.maxFs * 0.07
          : lineRun.baseline - lineRun.maxFs * 0.25;
        rect.className = 'scribe-hl-band';
        rect.style.setProperty('--scribe-hl-o', `${lineRun.opacity}`);
        Object.assign(rect.style, {
          position: 'absolute',
          left: `${lineRun.left}px`,
          top: `${barCenter - barHeight / 2}px`,
          width: `${lineRun.right - lineRun.left}px`,
          height: `${barHeight}px`,
          background: `rgb(${r}, ${g}, ${b})`,
          pointerEvents: 'none',
        });
        group.appendChild(rect);
        for (const rkw of lineRun.words) rkw.markupRectElem = rect;
        if (lineRun.groupId) {
          const arr = this._highlightRectsByGroup[n].get(lineRun.groupId);
          if (arr) arr.push(rect); else this._highlightRectsByGroup[n].set(lineRun.groupId, [rect]);
          if (lineRun.words[0].markupComment) {
            // The word-box extent (not the thin bar's) centers the comment mark on the text like a highlight's.
            markRuns.set(lineRun.groupId, {
              right: lineRun.right, top: lineRun.top, bottom: lineRun.bottom, nextLeft, orientation: lineRun.orientation, color: lineRun.color,
            });
          }
        }
        lineRun = null;
      };

      for (const kw of lineWords) {
        const left = kw.x() - (kw.word.visualCoords ? kw.leftSideBearing : 0);
        const fs = kw.fontSize;
        const wordBox = {
          left,
          right: left + kw.width(),
          top: kw.y() - fs * 0.12,
          bottom: kw.y() + fs * 0.72,
        };

        if (!kw.highlightColor) {
          flush(left);
        } else {
          const key = `${kw.highlightColor}_${kw.highlightOpacity}_${kw.highlightGroupId || ''}`;
          if (run && run.key === key) {
            run.left = Math.min(run.left, wordBox.left);
            run.right = Math.max(run.right, wordBox.right);
            run.top = Math.min(run.top, wordBox.top);
            run.bottom = Math.max(run.bottom, wordBox.bottom);
            run.words.push(kw);
          } else {
            flush(left);
            run = {
              key, color: kw.highlightColor, opacity: kw.highlightOpacity, groupId: kw.highlightGroupId, words: [kw], orientation: kw.word.line.orientation, ...wordBox,
            };
          }
        }

        if (!kw.markupType || !kw.markupColor) {
          flushLine(left);
        } else {
          const lineKey = `${kw.markupType}_${kw.markupColor}_${kw.markupOpacity}_${kw.markupGroupId || ''}`;
          if (lineRun && lineRun.key === lineKey) {
            lineRun.left = Math.min(lineRun.left, wordBox.left);
            lineRun.right = Math.max(lineRun.right, wordBox.right);
            lineRun.top = Math.min(lineRun.top, wordBox.top);
            lineRun.bottom = Math.max(lineRun.bottom, wordBox.bottom);
            lineRun.baseline = Math.max(lineRun.baseline, kw.y() + fs * 0.6);
            lineRun.maxFs = Math.max(lineRun.maxFs, fs);
            lineRun.words.push(kw);
          } else {
            flushLine(left);
            lineRun = {
              key: lineKey,
              type: kw.markupType,
              color: kw.markupColor,
              opacity: kw.markupOpacity,
              groupId: kw.markupGroupId,
              words: [kw],
              orientation: kw.word.line.orientation,
              baseline: kw.y() + fs * 0.6,
              maxFs: fs,
              ...wordBox,
            };
          }
        }
      }
      flush();
      flushLine();
    }

    this._commentMarks[n] = [];
    for (const [groupId, m] of markRuns) {
      const mark = document.createElement('span');
      mark.className = 'scribe-hl-cmark';
      mark.dataset.groupId = groupId;
      mark.tabIndex = 0;
      mark.setAttribute('role', 'button');
      mark.setAttribute('aria-label', 'Comment');
      // The band renders this hue at reduced opacity, so the solid mark reads as its saturated form.
      mark.style.color = m.color;
      mark.innerHTML = COMMENT_MARK_SVG;
      // Parented to the band's orientation group, so page rotation and zoom transforms apply to both alike.
      this.getHighlightGroup(n, m.orientation).appendChild(mark);
      this._commentMarks[n].push({
        el: mark, right: m.right, top: m.top, bottom: m.bottom, nextLeft: m.nextLeft,
      });
    }
    this._placeCommentMarks(n);
  }

  /**
   * Position page `n`'s comment marks for the current zoom.
   * Call again on every zoom change: the mark keeps a constant on-screen size, so whether it fits inline depends on the zoom.
   * @param {number} n
   */
  _placeCommentMarks(n) {
    const marks = this._commentMarks[n];
    if (!marks || marks.length === 0) return;
    const z = this.zoomLevel || 1;
    const px = 14 / z;
    for (const m of marks) {
      // 3px screen gap after the band, and the mark must clear the next word by 2px screen.
      const fits = m.nextLeft === null || m.nextLeft - m.right >= (3 + 14 + 2) / z;
      if (fits) {
        m.el.style.left = `${m.right + 3 / z}px`;
        m.el.style.top = `${(m.top + m.bottom) / 2 - px / 2}px`;
      } else {
        m.el.style.left = `${m.right - px * 0.75}px`;
        m.el.style.top = `${m.top - px * 0.85}px`;
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
   * @param {string} color
   * @param {number} opacity
   * @param {('highlight'|'underline'|'strikeout')} [kind='highlight']
   */
  applyHighlight(words, color, opacity, kind = 'highlight') { return applyHighlight(this, words, color, opacity, kind); }

  /**
   * Remove highlights (or line markups) from the given words and drop their annotation data.
   * @param {Array<InstanceType<typeof UiOcrWord>>} words
   * @param {('highlight'|'line')} [kind='highlight']
   */
  removeHighlight(words, kind = 'highlight') { return removeHighlight(this, words, kind); }

  /**
   * Set the comment on the highlight (or line-markup) group containing the first selected word.
   * @param {Array<InstanceType<typeof UiOcrWord>>} words
   * @param {string} comment
   * @param {('highlight'|'line')} [kind='highlight']
   */
  modifyHighlightComment(words, comment, kind = 'highlight') { return modifyHighlightComment(this, words, comment, kind); }

  /** Redraw the dashed outline around the words in the currently selected highlight group. */
  updateHighlightGroupOutline() { return updateHighlightGroupOutline(this); }

  /**
   * Tear down the viewer. Removes it from the global registry. Caller is responsible for the DOM.
   */
  destroy() {
    unregisterViewer(this);
    this.stopAutoScroll(false);
    this._endScrollTextHide();
    /** @type {any} */ (this._selEngine)?.uninstall?.();
    this.textSel?.destroy();
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
  'init', 'displayPage', 'goToOutlineDest', 'rotatePage', 'renderWords',
  'setInitialPositionZoom', 'getPageStop', 'calcPageStops', 'getViewportCenter',
  'pan', 'zoom', 'resize', 'startDrag', 'startDragTouch', 'executeDrag', 'executeDragTouch',
  'stopDragPinch', 'executePinchTouch', 'createGroup', 'getTextGroup', 'setTextGroupRotation',
  'getHighlightGroup', 'getSelectGroup', 'renderHighlights', 'getOverlayGroup', 'calcPage', 'calcSelectionImageCoords', 'getUiWords', 'getUiRegions',
  'getWordsUnderTextSelection', 'clearTextSelection', 'hasTextSelection', 'ensureWordObjs',
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
  'mode', 'drag', 'runSetInitial', 'state', 'opt', 'CanvasSelection', 'textSel', 'evalStats',
  'interactionCallback', 'destroyControlsCallback', 'onSelectionChange',
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
