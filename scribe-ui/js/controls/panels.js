// Page-area frame elements shared by the viewer and editor apps: the page-thumbnails rail and the custom overlay scrollbars.
// Both are positioned over the viewer and driven by the stage.
import { makeIconButton } from './toolbar.js';
import { installPageReorder } from './pageReorder.js';

/** @typedef {{thumbElem: HTMLDivElement, imgElem: HTMLImageElement, url: ?string, pending: boolean}} ThumbRow */

// A left column of small previews beside a larger page, evoking a thumbnails panel.
const THUMB_SVG = `<svg xmlns="http://www.w3.org/2000/svg" height="20" width="20" viewBox="0 0 24 24" fill="currentColor">
<rect x="4" y="3" width="7" height="5" rx="1"/>
<rect x="4" y="10" width="7" height="5" rx="1"/>
<rect x="4" y="17" width="7" height="4" rx="1"/>
<rect x="14" y="3" width="6" height="18" rx="1" opacity="0.55"/>
</svg>`;
const ROTATE_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="display:block;pointer-events:none;">
<path d="M15.55 5.55L11 1v3.07C7.06 4.56 4 7.92 4 12s3.05 7.44 7 7.93v-2.02c-2.84-.48-5-2.94-5-5.91s2.16-5.43 5-5.91V10l4.55-4.45zM19.93 11c-.17-1.39-.72-2.73-1.62-3.89l-1.42 1.42c.54.75.88 1.6 1.02 2.47h2.02zM13 17.9v2.02c1.39-.17 2.74-.71 3.9-1.61l-1.44-1.44c-.75.54-1.59.89-2.46 1.03zm3.89-2.42l1.42 1.41c.9-1.16 1.45-2.5 1.62-3.89h-2.02c-.14.87-.48 1.72-1.02 2.47z"/></svg>`;
const DELETE_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M9 3v1H4v2h16V4h-5V3H9zM6 7l1 13h10l1-13H6z"/></svg>';

// Default-Letter aspect (height/width) for rows whose page metrics are unavailable.
const DEFAULT_ASPECT = 11 / 8.5;
// Per-row overhead around the image box: vertical padding + gap + label, in px (matches controlStyles).
const ROW_OVERHEAD = 28;
// Panel top padding in px (matches controlStyles `.scribe-thumb-panel`), the offset of row 0.
const PAD = 8;
// Extra px mounted above and below the viewport so scrolling reveals ready rows, not blanks.
const BUFFER = 600;
// After a fast fling, wait this long with no further scroll before fetching thumbnails,
// so only the landing window is rastered, not the rows it flies past.
// A slow scroll renders immediately and never waits (see onScroll).
const RENDER_DEBOUNCE_MS = 120;
// A scroll faster than this fraction of the panel viewport per frame counts as a fling,
// so its thumbnails are deferred rather than rastered row-by-row.
// Mirrors the viewer's `deferTextVelocityFraction`.
const FLING_VIEWPORT_FRACTION = 0.5;
// Wait this long after the last page change before scrolling the active thumb into view, so a fast scroll across
// many pages repositions the rail once on clean layout instead of forcing a reflow at every page crossing.
const ACTIVE_SCROLL_DEBOUNCE_MS = 80;
// Panel width beyond the thumbnail image: horizontal padding plus room for the panel's own scrollbar.
const PANEL_EXTRA_W = 30;
// Fixed thumbnail image width in px (panel width is this plus PANEL_EXTRA_W for one column). Not user-adjustable for now.
const THUMB_W = 200;
// Resolution thumbnails are rasterized at; kept above THUMB_W so they stay crisp on high-DPI screens (CSS downscales).
const RENDER_W = 300;
// Slide duration in ms. Must match the `transition` on `.scribe-thumb-panel` so the post-hide unmount waits for it.
const SLIDE_MS = 180;
// Fallback height in px for centering the floating batch pill before it has been laid out and measured.
const BATCH_BAR_H = 40;
// Gap in px between cells (and from the panel edge) in the multi-column grid layout.
const GRID_GAP = 14;
// Most columns the panel can be widened to. The resize handle caps the panel width here; there is no full-screen mode.
const MAX_COLS = 3;
// Pointer travel in px before a press in the panel's empty space becomes a drag-select rather than a plain click.
const MARQUEE_THRESHOLD = 4;
// Distance in px from the scroll viewport's top/bottom edge that auto-scrolls the rail during a drag-select, and its speed.
const MARQUEE_EDGE = 36;
const MARQUEE_SPEED = 14;

/** Columns of THUMB_W cells that fit in inner width `w`. @param {number} w */
const colsFor = (w) => Math.max(1, Math.floor((w - 2 * PAD + GRID_GAP) / (THUMB_W + GRID_GAP)));
/** Panel width in px that fits exactly `cols` columns. @param {number} cols */
const panelWidthForCols = (cols) => cols * THUMB_W + (cols - 1) * GRID_GAP + PANEL_EXTRA_W;

/**
 * Module-scoped page clipboard shared by every thumbnail panel, for cut/copy/paste of whole pages within one document.
 * `sourceDocId` holds the originating `doc.id`, so a paste is refused when it does not match the target document's (fresh) id.
 */
const pageClipboard = {
  /** @type {'cut'|'copy'|null} What the held pages should do when pasted. */
  mode: null,
  /** @type {Array<object>} Clone bundles from `doc.copyPages`, detached from the source pages. */
  payloads: [],
  /** @type {?number} `doc.id` the pages were taken from. */
  sourceDocId: null,
  /** @type {Array<number>} Source page indices, used to remove the originals when a cut is pasted. */
  sourceIndices: [],
};

/** Empty the clipboard, e.g. once a cut has been consumed by a paste, or the user pressed Escape. */
function clearPageClipboard() {
  pageClipboard.mode = null;
  pageClipboard.payloads = [];
  pageClipboard.sourceDocId = null;
  pageClipboard.sourceIndices = [];
}

/**
 * Build the page-thumbnails panel and its toolbar toggle.
 * @param {import('../../viewer.js').ScribeViewer} scribe
 * @param {object} cfg
 * @param {(n: number) => void} cfg.onSelect - Called with the page index when a thumbnail is clicked.
 * @param {(pageIndices: Array<number>) => void} [cfg.onExtract] - Called with the page indices to open as a new document.
 * @param {(width: number) => void} [cfg.onResize] - Called with the panel's current visible width in px (0 when hidden), so the host can inset the document to the remaining area.
 * @returns {{
 *   panelElem: HTMLDivElement, toggleElem: HTMLSpanElement,
 *   rebuild: (activeN?: number) => void, setActive: (n: number) => void,
 *   setVisible: (v: boolean) => void, destroy: () => void
 * }}
 */
export function createThumbnailPanel(scribe, { onSelect, onExtract, onResize }) {
  const panelElem = document.createElement('div');
  panelElem.className = 'scribe-thumb-panel';
  panelElem.style.width = `${THUMB_W + PANEL_EXTRA_W}px`;
  // Focusable so the rail can take focus and claim the arrow keys for page navigation when active, with `:focus-within` marking the current page.
  // `-1` keeps it out of the tab order, so the rail is focused by clicking a thumb rather than by Tab.
  panelElem.tabIndex = -1;

  const scrollElem = document.createElement('div');
  scrollElem.className = 'scribe-thumb-scroll';
  panelElem.appendChild(scrollElem);

  // Full-height filler that gives the scroll area its scrollable height. Rows are layered over it.
  const spacer = document.createElement('div');
  spacer.style.width = '1px';
  spacer.style.height = '0px';
  scrollElem.appendChild(spacer);

  // Drag handle on the panel's right edge for resizing the panel between one and MAX_COLS columns (see resize wiring below).
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'scribe-thumb-resize';
  panelElem.appendChild(resizeHandle);

  // Floating batch-action pill (count, rotate/delete), hidden until 2+ pages are selected, shown over the rail centered on the selection (see `positionBatchBar`).
  // It overlays the thumbnails rather than docking, so showing it never reflows the rail.
  const batchBar = document.createElement('div');
  batchBar.className = 'scribe-thumb-batch';
  batchBar.style.display = 'none';
  const batchCount = document.createElement('span');
  batchCount.className = 'scribe-thumb-batch-count';
  const batchRotateBtn = document.createElement('button');
  batchRotateBtn.className = 'scribe-thumb-batch-btn';
  batchRotateBtn.title = 'Rotate selected pages';
  batchRotateBtn.innerHTML = ROTATE_SVG;
  batchRotateBtn.addEventListener('click', () => rotateSelection());
  const batchDeleteBtn = document.createElement('button');
  batchDeleteBtn.className = 'scribe-thumb-batch-btn scribe-thumb-batch-delete';
  batchDeleteBtn.title = 'Delete selected pages';
  batchDeleteBtn.innerHTML = DELETE_SVG;
  batchDeleteBtn.addEventListener('click', () => deleteSelection());
  batchBar.append(batchCount, batchRotateBtn, batchDeleteBtn);
  // Mount the strip on the viewer root (a sibling of the panel) rather than inside it: the panel clips its overflow,
  // so a child could not sit beside the rail. The root shares the panel's positioning context and the scoped styles.
  const batchHost = scribe.outerElem || panelElem;
  batchHost.appendChild(batchBar);

  // Right-click page context menu (delete/rotate). Built once here and repopulated per open by `openContextMenu`;
  // it shares the strip's host so it is not clipped by the rail.
  const menuElem = document.createElement('div');
  menuElem.className = 'scribe-thumb-menu';
  menuElem.style.display = 'none';
  batchHost.appendChild(menuElem);

  const toggleElem = makeIconButton('Page thumbnails', THUMB_SVG);
  toggleElem.classList.add('active');

  /** @type {number[]} Cumulative top (within the content region) of each row. */
  let offsets = [];
  /** @type {number[]} Full height of each row (image box + overhead). */
  let heights = [];
  /** @type {number[]} Image-box height of each row. */
  let boxHeights = [];
  /** @type {number[]} Left offset of each cell. 0 in rail mode (full-width rows). Per-column in grid mode. */
  let lefts = [];
  let total = 0;
  let pageCount = 0;
  // 'rail' is the docked single-column strip; 'grid' is the multi-column (up to MAX_COLS) page organizer.
  /** @type {'rail'|'grid'} */
  let layoutMode = 'rail';
  // Grid layout, valid only in 'grid' mode: number of columns and the uniform per-row vertical stride.
  let gridCols = 1;
  let rowStride = 0;
  // Cached because reading clientHeight/clientWidth forces a synchronous layout, and the scroll/resize paths read the viewport size every frame.
  let viewportH = 0;
  let viewportW = 0;

  /** @type {Map<number, ThumbRow>} */
  const mounted = new Map();
  // Bumped on every teardown (rebuild, hide, destroy) so an in-flight render from a previous generation is ignored.
  let generation = 0;
  let visible = true;
  let activePage = -1;
  // Multi-selection of page indices for batch actions (rotate/delete/move), distinct from `activePage` (the single page shown in the main viewer).
  // `selAnchor` is the pivot for shift-click range selection.
  /** @type {Set<number>} */
  const selected = new Set();
  let selAnchor = -1;
  // Page indices marked for a pending cut, dimmed until the cut is pasted or canceled. Distinct from `selected`.
  /** @type {Set<number>} */
  const cutMarks = new Set();
  let destroyed = false;
  let rafPending = false;
  /** @type {?ReturnType<typeof setTimeout>} */
  let renderTimer = null;
  // Deferred unmount after a slide-out, so rows stay visible for the duration of the hide animation.
  /** @type {?ReturnType<typeof setTimeout>} */
  let hideTimer = null;
  // Settle timer that defers scrolling the active thumb into view off the scroll path (see setActive).
  /** @type {?ReturnType<typeof setTimeout>} */
  let activeScrollTimer = null;
  // The in-flight column-reflow slide (see playColumnFlip): the cells mid-transition and the leaving cells kept mounted only to animate out,
  // plus the timer that clears the transforms and unmounts the leaving cells once it settles.
  /** @type {?{timer: ReturnType<typeof setTimeout>, animated: Array<HTMLElement>, leaving: Set<number>}} */
  let columnFlip = null;
  // The in-flight drag-to-reorder gesture, or null. Owned by the reorder subsystem (installPageReorder); read here
  // by `updateWindow` to keep dragged rows mounted, and through `suppressClick` so the click ending a drag does not select.
  /** @type {?import('./pageReorder.js').ThumbDrag} */
  let drag = null;
  // Set when a drag begins so the click that ends the same gesture does not also select; cleared on the next press.
  let suppressClick = false;

  // Shared state and core callbacks handed to the drag-to-reorder subsystem. Geometry arrays and reassignable scalars
  // are exposed as live getters/setters so a write on either side is seen by the other.
  /** @type {import('./pageReorder.js').ReorderContext} */
  const ctx = {
    scribe,
    scrollElem,
    panelElem,
    batchBar,
    selected,
    mounted,
    PAD,
    get offsets() { return offsets; },
    get heights() { return heights; },
    get pageCount() { return pageCount; },
    get THUMB_W() { return THUMB_W; },
    get gridCols() { return gridCols; },
    get rowStride() { return rowStride; },
    GRID_GAP,
    get activePage() { return activePage; },
    set activePage(v) { activePage = v; },
    get drag() { return drag; },
    set drag(v) { drag = v; },
    get suppressClick() { return suppressClick; },
    set suppressClick(v) { suppressClick = v; },
    computeGeometry,
    restyleRow,
    updateWindow,
    updateBatchToolbar,
    remapSelection,
    closeContextMenu,
    cancelCut,
  };
  const reorder = installPageReorder(ctx);

  /**
   * Largest row index whose top is at or above content-y `y`.
   * @param {number} y
   * @returns {number}
   */
  function rowAt(y) {
    let lo = 0;
    let hi = pageCount - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid] <= y) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans;
  }

  /** Re-read the scroll element's viewport size into the cache. Called only when it can have changed (resize), not on scroll. */
  function measureViewport() {
    viewportH = scrollElem.clientHeight;
    viewportW = scrollElem.clientWidth;
  }

  /**
   * Revoke a mounted row's object URL, drop its DOM, and forget it.
   * @param {number} n
   * @param {ThumbRow} entry
   */
  function unmountRow(n, entry) {
    if (entry.url) URL.revokeObjectURL(entry.url);
    entry.thumbElem.remove();
    mounted.delete(n);
  }

  /** Unmount every row. */
  function clearMounted() {
    for (const [n, entry] of mounted) unmountRow(n, entry);
  }

  /**
   * Apply page `n`'s geometry, rotation, label, and active/selection state to an already-built row, so a row survives a reorder, rotate, or delete without being re-rendered.
   * The cached image is at the page's original orientation, so rotation is applied here as a CSS transform (90/270 swaps the box width and height).
   * @param {ThumbRow} entry @param {number} n
   */
  function restyleRow(entry, n) {
    const { thumbElem, imgElem } = entry;
    // Left-anchor the cell rather than center it, so the lone rail thumbnail does not jump when a second column appears.
    thumbElem.style.left = `${lefts[n]}px`;
    thumbElem.style.right = 'auto';
    thumbElem.style.width = `${THUMB_W}px`;
    thumbElem.style.top = `${PAD + offsets[n]}px`;
    thumbElem.style.height = `${heights[n]}px`;
    thumbElem.dataset.page = String(n);
    thumbElem.classList.toggle('active', n === activePage);
    thumbElem.classList.toggle('selected', selected.has(n));
    thumbElem.classList.toggle('cut', cutMarks.has(n));

    const box = imgElem.parentElement;
    if (box) {
      box.style.width = `${THUMB_W}px`;
      box.style.height = `${boxHeights[n]}px`;
    }

    imgElem.style.cssText = '';
    const rot = (scribe.doc && scribe.doc.pageMetrics[n] && scribe.doc.pageMetrics[n].rotation) || 0;
    if (rot % 180 === 90) {
      imgElem.style.position = 'absolute';
      imgElem.style.top = '50%';
      imgElem.style.left = '50%';
      imgElem.style.width = `${boxHeights[n]}px`;
      imgElem.style.height = `${THUMB_W}px`;
      imgElem.style.transform = `translate(-50%, -50%) rotate(${rot}deg)`;
    } else if (rot === 180) {
      imgElem.style.transform = 'rotate(180deg)';
    }

    const label = thumbElem.querySelector('.scribe-thumb-label');
    if (label) label.textContent = String(n + 1);
  }

  /**
   * Create and place the DOM for row `n` (image fills in later, on a debounced render pass).
   * @param {number} n
   */
  function mountRow(n) {
    const thumbElem = document.createElement('div');
    thumbElem.className = 'scribe-thumb';
    thumbElem.style.position = 'absolute';
    thumbElem.style.left = '0';
    thumbElem.style.right = '0';
    // Handlers read the page index from the element rather than capturing `n`,
    // so a row reused after an in-place reorder/rotate/delete acts on its current position.
    const idx = () => Number(thumbElem.dataset.page);

    const boxElem = document.createElement('div');
    boxElem.className = 'scribe-thumb-box';
    boxElem.style.width = `${THUMB_W}px`;

    const imgElem = document.createElement('img');
    imgElem.alt = '';
    imgElem.draggable = false;
    boxElem.appendChild(imgElem);

    const labelElem = document.createElement('div');
    labelElem.className = 'scribe-thumb-label';

    const rotateBtn = document.createElement('span');
    rotateBtn.className = 'scribe-thumb-rotate';
    rotateBtn.title = 'Rotate right';
    rotateBtn.innerHTML = ROTATE_SVG;
    rotateBtn.addEventListener('click', (e) => { e.stopPropagation(); onRotate(idx()); });

    boxElem.appendChild(rotateBtn);
    boxElem.addEventListener('click', (e) => { if (!suppressClick) handleThumbClick(e, idx()); });
    // A press that never crosses the reorder drag threshold stays a plain click, because suppressClick is set only once a drag begins.
    boxElem.addEventListener('pointerdown', (e) => reorder.onThumbPointerDown(e, idx()));
    boxElem.addEventListener('contextmenu', (e) => {
      if (!(scribe.opt && scribe.opt.enablePageEditing)) return;
      e.preventDefault();
      openContextMenu(e.clientX, e.clientY, idx());
    });

    // The whole thumbnail is draggable to reorder when page editing is on; the `grab` cursor advertises it.
    if (scribe.opt && scribe.opt.enablePageEditing) boxElem.classList.add('editable');

    thumbElem.appendChild(boxElem);
    thumbElem.appendChild(labelElem);

    scrollElem.appendChild(thumbElem);
    const entry = {
      thumbElem, imgElem, url: null, pending: false,
    };
    mounted.set(n, entry);
    restyleRow(entry, n);
  }

  /**
   * Fetch the cached JPEG Blob for row `n` and display it,
   * unless the row was unmounted or the generation was superseded before the render resolved.
   * @param {number} n
   * @param {ThumbRow} entry
   */
  function requestRender(n, entry) {
    const doc = scribe.doc;
    if (!doc || !doc.images) return;
    entry.pending = true;
    const gen = generation;
    // Render above the display size and let CSS downscale into the THUMB_W box, so thumbnails stay crisp on high-DPI screens.
    doc.images.renderThumbnail(n, RENDER_W).then((blob) => {
      if (destroyed || gen !== generation) return;
      if (mounted.get(n) !== entry) return;
      if (!blob) { entry.pending = false; return; }
      entry.url = URL.createObjectURL(blob);
      entry.imgElem.src = entry.url;
    }).catch(() => {
      if (mounted.get(n) === entry) entry.pending = false;
    });
  }

  /** Request thumbnails for every mounted row that still lacks one. */
  function flushRenders() {
    if (destroyed || !visible) return;
    for (const [n, entry] of mounted) {
      if (!entry.url && !entry.pending) requestRender(n, entry);
    }
  }

  /**
   * Queue thumbnail renders for mounted rows that still lack one.
   * `immediate` renders the visible window now, for slow scrolls and programmatic redraws (rebuild, resize, reveal, jump-to-page) that have no fling to skip.
   * Otherwise the renders sit behind a trailing debounce, so a fast fling rasters only the window it settles on, not every row flown past.
   * @param {boolean} [immediate=false]
   */
  function scheduleRenders(immediate = false) {
    if (immediate) {
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
      flushRenders();
      return;
    }
    // Trailing debounce: a continuing fling re-arms this every frame, so the flush fires once the scroll settles.
    if (renderTimer) clearTimeout(renderTimer);
    renderTimer = setTimeout(() => { renderTimer = null; flushRenders(); }, RENDER_DEBOUNCE_MS);
  }

  /** First and last page index in the current scroll window (+buffer). @returns {[number, number]} */
  function windowRange() {
    const viewH = viewportH;
    if (layoutMode === 'grid' && rowStride > 0) {
      // Every cell in a grid row shares the same top, so map the visible band to whole rows and mount their cells.
      const firstRow = Math.max(0, Math.floor((scrollElem.scrollTop - PAD - BUFFER) / rowStride));
      const lastRow = Math.max(0, Math.floor((scrollElem.scrollTop - PAD + viewH + BUFFER) / rowStride));
      return [firstRow * gridCols, Math.min(pageCount - 1, (lastRow + 1) * gridCols - 1)];
    }
    return [
      rowAt(Math.max(0, scrollElem.scrollTop - PAD - BUFFER)),
      rowAt(Math.max(0, scrollElem.scrollTop - PAD + viewH + BUFFER)),
    ];
  }

  /**
   * Mount the rows in the current scroll window (+buffer), unmount the rest, then queue renders.
   * @param {boolean} [immediate=false] - Render the newly mounted rows now rather than behind the scroll debounce.
   */
  function updateWindow(immediate = false) {
    if (destroyed || !visible || pageCount === 0) return;
    const [first, last] = windowRange();
    for (const [n, entry] of mounted) {
      // Keep a dragged page mounted past the scroll window, since unmounting revokes the object URL the drag ghost still shows.
      // Keep a column-flip leaving cell mounted too; finishColumnFlip unmounts it once the slide settles.
      const keep = (drag && drag.started && drag.pages.has(n)) || (columnFlip && columnFlip.leaving.has(n));
      if ((n < first || n > last) && !keep) unmountRow(n, entry);
    }
    for (let n = first; n <= last; n++) {
      if (!mounted.has(n)) mountRow(n);
    }
    scheduleRenders(immediate);
  }

  let lastScrollTop = scrollElem.scrollTop;
  function onScroll() {
    closeContextMenu();
    if (selected.size >= 2) positionBatchBar();
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const st = scrollElem.scrollTop;
      const speed = Math.abs(st - lastScrollTop);
      lastScrollTop = st;
      // Render revealed rows immediately on a slow scroll.
      // A fast fling defers them (the trailing debounce in `scheduleRenders`), rastering only the landing window instead of every row flown past.
      const fling = speed > viewportH * FLING_VIEWPORT_FRACTION;
      updateWindow(!fling);
    });
  }
  scrollElem.addEventListener('scroll', onScroll);

  // Covers host-driven height changes (window/devtools); the drag already refreshes the cache on width.
  // The scroll element's box is sized by the panel, not its content, so mounting rows cannot re-trigger this.
  const viewportObserver = new ResizeObserver(() => {
    measureViewport();
    updateWindow(true);
  });
  viewportObserver.observe(scrollElem);

  /** Column count for the current width: as many fixed-width cells as fit the inner width, capped at MAX_COLS. @returns {number} */
  function gridColsFor() {
    return Math.min(colsFor(viewportW || THUMB_W), MAX_COLS);
  }

  /**
   * Recompute every row's box height, full height, and top offset from the current page metrics and THUMB_W,
   * and size the spacer to the total. Shared by the document rebuild and the width resize.
   */
  function computeGeometry() {
    const doc = scribe.doc;
    pageCount = doc?.inputData?.pageCount ?? 0;
    offsets = [];
    heights = [];
    boxHeights = [];
    lefts = [];
    gridCols = 1;
    rowStride = 0;
    if (!doc || pageCount === 0) {
      total = 0;
      spacer.style.height = '0px';
      return;
    }
    const metrics = doc.pageMetrics || [];
    // Image-box height of page `n` at the current cell width, preserving its aspect (90/270 rotation transposes it).
    /** @param {number} n */
    const boxHeightOf = (n) => {
      const dims = metrics[n] && metrics[n].dims;
      const rotated = (((metrics[n] && metrics[n].rotation) || 0) % 180) === 90;
      let aspect = dims && dims.width ? dims.height / dims.width : DEFAULT_ASPECT;
      if (rotated && dims && dims.height) aspect = dims.width / dims.height;
      return Math.max(1, Math.round(THUMB_W * aspect));
    };

    // Panel width changes only how many fixed-width cells fit, never their size.
    gridCols = gridColsFor();
    layoutMode = gridCols > 1 ? 'grid' : 'rail';

    if (layoutMode === 'grid') {
      // Row stride is uniform (the tallest cell), so a scroll position maps to a row by division.
      // Each page keeps its own height and top-aligns in its slot, so a shorter page leaves a gap below.
      let maxBox = 1;
      for (let n = 0; n < pageCount; n++) {
        boxHeights[n] = boxHeightOf(n);
        if (boxHeights[n] > maxBox) maxBox = boxHeights[n];
      }
      rowStride = maxBox + ROW_OVERHEAD + GRID_GAP;
      for (let n = 0; n < pageCount; n++) {
        lefts[n] = PAD + (n % gridCols) * (THUMB_W + GRID_GAP);
        offsets[n] = Math.floor(n / gridCols) * rowStride;
        heights[n] = boxHeights[n] + ROW_OVERHEAD;
      }
      total = Math.ceil(pageCount / gridCols) * rowStride;
    } else {
      let acc = 0;
      for (let n = 0; n < pageCount; n++) {
        boxHeights[n] = boxHeightOf(n);
        heights[n] = boxHeights[n] + ROW_OVERHEAD;
        lefts[n] = PAD;
        offsets[n] = acc;
        acc += heights[n];
      }
      total = acc;
    }
    spacer.style.height = `${total}px`;
  }

  /**
   * Rebuild the panel for the current document: recompute row geometry and mount the window around the active page.
   * @param {number} [activeN=-1] - Page to mark active and scroll to (e.g. a tab's last page), or -1 to start at the top.
   */
  function rebuild(activeN = -1) {
    // The panel keeps its current width across documents. ComputeGeometry re-derives the columns for that width below.
    generation += 1;
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
    clearMounted();
    // A rebuild means the document changed, so the old page indices no longer refer to the same pages.
    selected.clear();
    selAnchor = -1;
    cutMarks.clear();
    updateBatchToolbar();
    measureViewport();
    computeGeometry();
    activePage = activeN >= 0 && activeN < pageCount ? activeN : -1;
    // Start scrolled to the active page so its thumbnail is in the first mounted window.
    // This avoids the top-then-jump (and its second, late render) when switching to a tab whose last page is far down.
    // Same bottom-align as setActive.
    if (activePage > 0 && heights[activePage]) {
      const bottom = offsets[activePage] + heights[activePage];
      scrollElem.scrollTop = Math.max(0, bottom + PAD - viewportH + 8);
    } else {
      scrollElem.scrollTop = 0;
    }
    updateWindow(true);
  }

  /**
   * Re-lay the rows for a new column count.
   */
  function reflow() {
    if (pageCount === 0 || gridColsFor() === gridCols) return;
    // Settle any slide still in flight (a fast drag can re-cross a boundary mid-animation) before measuring.
    finishColumnFlip();

    // The slide derives each cell's start from the pre-relayout geometry and scroll, so snapshot them.
    // computeGeometry reassigns the arrays, so holding the references keeps the old ones intact.
    const before = {
      offsets, lefts, scrollTop: scrollElem.scrollTop, mounted: new Set(mounted.keys()),
    };

    computeGeometry();
    // Restore the anchor page captured at the drag start, by index, every reflow. A grid row groups several pages under one offset,
    // so re-deriving the page from the scroll position each time (rowAt returns the row's last page) would drift
    // when crossing boundaries back and forth (1->3->1). Restoring the same page+fraction is exact.
    if (resizeAnchorPage >= 0 && resizeAnchorPage < pageCount) {
      const newCenterY = PAD + offsets[resizeAnchorPage] + resizeAnchorFrac * heights[resizeAnchorPage];
      scrollElem.scrollTop = Math.min(Math.max(0, newCenterY - viewportH / 2), Math.max(0, total - viewportH));
    } else {
      scrollElem.scrollTop = Math.min(scrollElem.scrollTop, Math.max(0, total - viewportH));
    }

    // Mount the new window's cells, position everything at its new slot, and play the slide.
    const [first, last] = windowRange();
    for (let n = first; n <= last; n++) if (!mounted.has(n)) mountRow(n);
    for (const [n, entry] of mounted) restyleRow(entry, n);
    scheduleRenders(true);

    playColumnFlip(before, first, last);
  }

  /**
   * Slide the mounted cells from their old column positions into their new slots.
   * An entering cell had no old position and could sit far off-screen,
   * so its start is pinned just beyond the nearest edge to slide in rather than streak across the viewport.
   * @param {{offsets: Array<number>, lefts: Array<number>, scrollTop: number, mounted: Set<number>}} before
   * @param {number} first @param {number} last
   */
  function playColumnFlip(before, first, last) {
    const newScrollTop = scrollElem.scrollTop;
    /** @type {Array<HTMLElement>} */
    const animated = [];
    for (const [n, entry] of mounted) {
      const newTop = PAD + offsets[n] - newScrollTop;
      let oldTop = PAD + before.offsets[n] - before.scrollTop;
      if (!before.mounted.has(n)) oldTop = Math.max(-0.5 * viewportH, Math.min(1.5 * viewportH, oldTop));
      const dx = before.lefts[n] - lefts[n];
      const dy = oldTop - newTop;
      if (Math.round(dx) === 0 && Math.round(dy) === 0) continue;
      entry.thumbElem.style.transition = 'none';
      entry.thumbElem.style.transform = `translate(${dx}px, ${dy}px)`;
      animated.push(entry.thumbElem);
    }
    /** @type {Set<number>} */
    const leaving = new Set();
    for (const n of before.mounted) if ((n < first || n > last) && mounted.has(n)) leaving.add(n);

    if (animated.length === 0) {
      for (const n of leaving) { const e = mounted.get(n); if (e) unmountRow(n, e); }
      return;
    }
    // Commit the inverted start, then play to the resting position on the next frame.
    scrollElem.getBoundingClientRect();
    for (const el of animated) {
      el.style.transition = `transform ${SLIDE_MS}ms ease`;
      el.style.transform = '';
    }
    columnFlip = { timer: setTimeout(finishColumnFlip, SLIDE_MS + 20), animated, leaving };
  }

  /** End the in-flight column slide: clear the transition transforms and unmount the cells that slid out of view. */
  function finishColumnFlip() {
    if (!columnFlip) return;
    clearTimeout(columnFlip.timer);
    for (const el of columnFlip.animated) { el.style.transition = ''; el.style.transform = ''; }
    for (const n of columnFlip.leaving) { const e = mounted.get(n); if (e) unmountRow(n, e); }
    columnFlip = null;
  }

  /** Report the panel's current visible width (0 when hidden) so the host can inset the document to the remaining area. */
  function notifyResize() {
    if (onResize) onResize(visible ? (parseFloat(panelElem.style.width) || 0) : 0);
  }

  // Drag the right-edge handle to resize the panel between one column (the docked rail) and MAX_COLS columns.
  // Thumbnail size is fixed, so the width only changes how many columns fit.
  let resizeStartX = 0;
  let resizeStartPanelW = 0;
  let resizeContainerW = 0;
  let resizeLivePanelW = 0;
  // The page centered when the drag began, plus its fractional position, so every reflow re-centers the same page.
  let resizeAnchorPage = -1;
  let resizeAnchorFrac = 0;
  // The panel's extra width (scrollbar gutter + padding + border) measured at drag start.
  let resizeExtraW = 0;

  /** @param {PointerEvent} event */
  function onResizeMove(event) {
    // The upper bound uses the measured extra width (resizeExtraW), not the PANEL_EXTRA_W estimate,
    // so the real scrollbar gutter decides whether the last column fits.
    const minPanelW = panelWidthForCols(1);
    const maxColsInnerW = MAX_COLS * THUMB_W + (MAX_COLS - 1) * GRID_GAP + 2 * PAD;
    const maxPanelW = Math.min(maxColsInnerW + resizeExtraW, resizeContainerW);
    resizeLivePanelW = Math.max(minPanelW, Math.min(maxPanelW, resizeStartPanelW + (event.clientX - resizeStartX)));
    panelElem.style.width = `${resizeLivePanelW}px`;
    // The width just changed. Refresh the cache once here so reflow/gridColsFor/windowRange read it without each forcing a layout.
    measureViewport();
    reflow();
    notifyResize();
  }

  function onResizeEnd() {
    window.removeEventListener('pointermove', onResizeMove);
    window.removeEventListener('pointerup', onResizeEnd);
    updateWindow(true);
    notifyResize();
  }

  resizeHandle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    resizeStartX = event.clientX;
    resizeStartPanelW = panelElem.getBoundingClientRect().width;
    resizeLivePanelW = resizeStartPanelW;
    resizeContainerW = (panelElem.parentElement && panelElem.parentElement.clientWidth) || resizeStartPanelW;
    // Pin the active page (the one shown in the viewer) for the whole drag so it stays in the pane across column changes,
    // or fall back to the page at the viewport center when nothing is active.
    measureViewport();
    resizeExtraW = resizeStartPanelW - viewportW;
    const centerY = scrollElem.scrollTop + viewportH / 2;
    resizeAnchorPage = activePage >= 0 && activePage < pageCount
      ? activePage
      : (pageCount > 0 ? rowAt(Math.max(0, centerY - PAD)) : -1);
    resizeAnchorFrac = resizeAnchorPage >= 0 && heights[resizeAnchorPage]
      ? Math.max(0, Math.min(1, (centerY - (PAD + offsets[resizeAnchorPage])) / heights[resizeAnchorPage])) : 0;
    window.addEventListener('pointermove', onResizeMove);
    window.addEventListener('pointerup', onResizeEnd);
  });

  // Drag-to-select: a press in the panel's empty space rubber-bands a rectangle that selects every page it covers.
  // A press that never crosses the threshold is a plain click, which clears the selection.
  // Holding Shift/Ctrl/Cmd unions the covered pages with the existing selection instead of replacing it.
  // Touch is left to scroll.
  const marqueeElem = document.createElement('div');
  marqueeElem.className = 'scribe-thumb-marquee';
  marqueeElem.style.display = 'none';
  scrollElem.appendChild(marqueeElem);
  /** @type {?{originX: number, originY: number, base: Set<number>, started: boolean, lastX: number, lastY: number, autoDir: number, rafId: number}} */
  let marquee = null;

  /**
   * Size the marquee rect to (curX, curY) and select every page it covers, unioned with the drag's captured base.
   * curX/curY are in content space, so the rect and its selection track the thumbnails as the panel auto-scrolls under a held pointer.
   * @param {number} curX @param {number} curY
   */
  function updateMarquee(curX, curY) {
    if (!marquee) return;
    const l = Math.min(marquee.originX, curX);
    const right = Math.max(marquee.originX, curX);
    const t = Math.min(marquee.originY, curY);
    const b = Math.max(marquee.originY, curY);
    marqueeElem.style.left = `${l}px`;
    marqueeElem.style.top = `${t}px`;
    marqueeElem.style.width = `${right - l}px`;
    marqueeElem.style.height = `${b - t}px`;
    selected.clear();
    for (const n of marquee.base) selected.add(n);
    // The geometry arrays cover every page, not just the mounted window, so the rect also selects pages scrolled out of view.
    for (let n = 0; n < pageCount; n++) {
      if (lefts[n] < right && lefts[n] + THUMB_W > l && PAD + offsets[n] < b && PAD + offsets[n] + heights[n] > t) selected.add(n);
    }
    syncSelectionUI();
  }

  /** While the pointer is held near a vertical edge, scroll the rail and grow the selection over the newly revealed rows. */
  function marqueeAutoScroll() {
    if (!marquee || !marquee.started || marquee.autoDir === 0) { if (marquee) marquee.rafId = 0; return; }
    const max = scrollElem.scrollHeight - scrollElem.clientHeight;
    const next = Math.max(0, Math.min(max, scrollElem.scrollTop + marquee.autoDir * MARQUEE_SPEED));
    if (next !== scrollElem.scrollTop) {
      scrollElem.scrollTop = next;
      updateWindow();
      const rect = scrollElem.getBoundingClientRect();
      updateMarquee(
        Math.max(0, Math.min(scrollElem.clientWidth, marquee.lastX - rect.left)),
        marquee.lastY - rect.top + scrollElem.scrollTop,
      );
      if (next === 0 || next === max) marquee.autoDir = 0;
    }
    marquee.rafId = marquee.autoDir !== 0 ? requestAnimationFrame(marqueeAutoScroll) : 0;
  }

  /** @param {PointerEvent} e */
  function onMarqueeMove(e) {
    if (!marquee) return;
    marquee.lastX = e.clientX;
    marquee.lastY = e.clientY;
    const rect = scrollElem.getBoundingClientRect();
    const curX = Math.max(0, Math.min(scrollElem.clientWidth, e.clientX - rect.left));
    const curY = e.clientY - rect.top + scrollElem.scrollTop;
    if (!marquee.started) {
      // Below the threshold the press is still a candidate click.
      if (Math.abs(curX - marquee.originX) + Math.abs(curY - marquee.originY) < MARQUEE_THRESHOLD) return;
      marquee.started = true;
      marqueeElem.style.display = '';
    }
    e.preventDefault();
    updateMarquee(curX, curY);
    const nearTop = e.clientY < rect.top + MARQUEE_EDGE && scrollElem.scrollTop > 0;
    const nearBottom = e.clientY > rect.bottom - MARQUEE_EDGE && scrollElem.scrollTop < scrollElem.scrollHeight - scrollElem.clientHeight;
    marquee.autoDir = nearTop ? -1 : (nearBottom ? 1 : 0);
    if (marquee.autoDir !== 0 && !marquee.rafId) marquee.rafId = requestAnimationFrame(marqueeAutoScroll);
  }

  function onMarqueeUp() {
    window.removeEventListener('pointermove', onMarqueeMove);
    window.removeEventListener('pointerup', onMarqueeUp);
    const m = marquee;
    marquee = null;
    if (!m) return;
    if (m.rafId) cancelAnimationFrame(m.rafId);
    if (m.started) {
      marqueeElem.style.display = 'none';
      // Anchor a later Shift+click at the lowest page the rect selected.
      let lo = -1;
      for (const n of selected) if (lo < 0 || n < lo) lo = n;
      selAnchor = lo;
    } else if (m.base.size === 0) {
      // A plain press in empty space (no modifier) clears the selection, matching a press outside the panel.
      clearSelection();
    }
  }

  /** @param {PointerEvent} e */
  function onMarqueePointerDown(e) {
    if (e.pointerType === 'touch') return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const target = e.target;
    // A press on a thumbnail is its own click/reorder gesture; the marquee only starts in the panel's empty space.
    if (target instanceof Element && target.closest('.scribe-thumb-box')) return;
    const rect = scrollElem.getBoundingClientRect();
    // clientWidth excludes the scrollbar, so a press at or beyond it is on the scrollbar.
    // Skip the marquee there, or scrolling the bar would clear the selection.
    if (e.clientX - rect.left - scrollElem.clientLeft >= scrollElem.clientWidth) return;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    marquee = {
      originX: Math.max(0, Math.min(scrollElem.clientWidth, e.clientX - rect.left)),
      originY: e.clientY - rect.top + scrollElem.scrollTop,
      base: additive ? new Set(selected) : new Set(),
      started: false,
      lastX: e.clientX,
      lastY: e.clientY,
      autoDir: 0,
      rafId: 0,
    };
    window.addEventListener('pointermove', onMarqueeMove);
    window.addEventListener('pointerup', onMarqueeUp);
  }
  scrollElem.addEventListener('pointerdown', onMarqueePointerDown);

  /**
   * Rotate page `n` clockwise by `deg` (a multiple of 90) in place, as a CSS transform on the cached thumbnail rather than a re-render.
   * A 90/270 turn swaps the aspect, changing the box height and shifting the rows below, so every mounted row is restyled.
   * @param {number} n
   * @param {number} [deg=90]
   */
  function onRotate(n, deg = 90) {
    scribe.rotatePage(n, deg);
    computeGeometry();
    for (const [i, entry] of mounted) restyleRow(entry, i);
    updateWindow();
  }

  /**
   * Delete page `n` from its thumbnail, in place.
   * The deleted row is dropped and the rows below it shift up one index, reusing their images rather than re-rendering.
   * The last page is kept.
   * @param {number} n
   */
  function onDelete(n) {
    if (!scribe.doc || scribe.doc.pageMetrics.length <= 1) return;
    cancelCut();
    const snapshot = [...mounted];
    const belowActive = n < activePage ? 1 : 0;
    mounted.clear();
    scribe.deletePage(n);
    computeGeometry();
    if (activePage >= 0) activePage = Math.max(0, Math.min(activePage - belowActive, pageCount - 1));
    remapSelection((s) => (s === n ? -1 : (s > n ? s - 1 : s)));
    for (const [oi, entry] of snapshot) {
      if (oi === n) { unmountRow(oi, entry); continue; }
      const ni = oi > n ? oi - 1 : oi;
      restyleRow(entry, ni);
      mounted.set(ni, entry);
    }
    updateWindow();
    updateBatchToolbar();
  }

  /** Re-key the current selection through `fn`, dropping anything that falls out of range. @param {(n: number) => number} fn */
  function remapSelection(fn) {
    const next = [...selected].map(fn).filter((n) => n >= 0 && n < pageCount);
    selected.clear();
    for (const n of next) selected.add(n);
  }

  /** Reflect the current selection on the mounted rows and refresh the batch bar. */
  function syncSelectionUI() {
    for (const [n, entry] of mounted) entry.thumbElem.classList.toggle('selected', selected.has(n));
    updateBatchToolbar();
  }

  /** Show the floating batch strip only while the rail is visible with 2+ pages selected, and place it by the selection. */
  function updateBatchToolbar() {
    const show = visible && selected.size >= 2;
    batchCount.textContent = String(selected.size);
    batchBar.style.display = show ? '' : 'none';
    if (show) positionBatchBar();
  }

  /**
   * Place the vertical strip just right of the rail, centered on the selection's visible span and clamped to stay within the scroll viewport.
   * Coordinates resolve against the host via client rects, so panel slide/resize and scroll are accounted for.
   * Called on selection changes and on scroll.
   */
  function positionBatchBar() {
    if (selected.size < 2) return;
    const hostRect = batchHost.getBoundingClientRect();
    const panelRect = panelElem.getBoundingClientRect();
    const scrollRect = scrollElem.getBoundingClientRect();
    // In the multi-column grid the rail's "just to the right of the thumbnail" anchor would sit between columns,
    // so pin the pill inside the panel's right edge, vertically centered in the viewport.
    if (layoutMode === 'grid') {
      const barH = batchBar.offsetHeight || BATCH_BAR_H;
      const barW = batchBar.offsetWidth || BATCH_BAR_H;
      batchBar.style.left = `${scrollRect.right - hostRect.left - barW - 14}px`;
      batchBar.style.top = `${(scrollRect.top + scrollRect.bottom) / 2 - hostRect.top - barH / 2}px`;
      return;
    }
    const sel = [...selected].sort((a, b) => a - b);
    const last = sel[sel.length - 1];
    const selTop = scrollRect.top + PAD + offsets[sel[0]] - scrollElem.scrollTop;
    const selBottom = scrollRect.top + PAD + offsets[last] + heights[last] - scrollElem.scrollTop;
    const barH = batchBar.offsetHeight || BATCH_BAR_H;
    const centerY = Math.max(scrollRect.top + barH / 2 + 6, Math.min((selTop + selBottom) / 2, scrollRect.bottom - barH / 2 - 6));
    batchBar.style.left = `${panelRect.right - hostRect.left + 8}px`;
    batchBar.style.top = `${centerY - hostRect.top - barH / 2}px`;
  }

  /** Clear the selection and refresh the UI. */
  function clearSelection() {
    if (selected.size === 0) return;
    selected.clear();
    syncSelectionUI();
  }

  /** Hide the page context menu if it is open. */
  function closeContextMenu() {
    menuElem.style.display = 'none';
    document.removeEventListener('pointerdown', onMenuOutsidePointer);
  }

  /**
   * Open the page context menu at the cursor for page `n`.
   * When `n` is part of a 2+ selection the actions apply to the whole selection, otherwise to that page alone.
   * Editor-only.
   * @param {number} clientX
   * @param {number} clientY
   * @param {number} n
   */
  function openContextMenu(clientX, clientY, n) {
    if (!(scribe.opt && scribe.opt.enablePageEditing)) return;
    const multi = selected.has(n) && selected.size >= 2;
    const count = multi ? selected.size : 1;
    menuElem.replaceChildren();
    /** @param {string} label @param {boolean} danger @param {() => void} fn */
    const addItem = (label, danger, fn) => {
      const item = document.createElement('div');
      item.className = danger ? 'scribe-thumb-menu-item danger' : 'scribe-thumb-menu-item';
      item.textContent = label;
      item.addEventListener('click', () => { closeContextMenu(); fn(); });
      menuElem.appendChild(item);
    };
    /** @param {number} deg */
    const rotate = (deg) => (multi ? rotateSelection(deg) : onRotate(n, deg));

    // A header naming the target count keeps each rotate item short while still saying what the actions affect.
    if (multi) {
      const header = document.createElement('div');
      header.className = 'scribe-thumb-menu-header';
      header.textContent = `${count} pages`;
      menuElem.appendChild(header);
    }
    addItem('Rotate 90°', false, () => rotate(90));
    addItem('Rotate 180°', false, () => rotate(180));
    addItem('Rotate 270°', false, () => rotate(270));
    menuElem.appendChild(document.createElement('hr')).className = 'scribe-thumb-menu-divider';
    addItem(multi ? 'Cut' : 'Cut page', false, () => copySelection(multi ? [...selected] : [n], 'cut'));
    addItem(multi ? 'Copy' : 'Copy page', false, () => copySelection(multi ? [...selected] : [n], 'copy'));
    // Paste lands just after the right-clicked page; only offered when this document has pages on the clipboard.
    if (canPaste()) addItem('Paste', false, () => pasteAt(n + 1));
    menuElem.appendChild(document.createElement('hr')).className = 'scribe-thumb-menu-divider';
    if (onExtract) {
      addItem(multi ? 'New document from selection' : 'New document from page', false,
        () => onExtract(multi ? [...selected].sort((a, b) => a - b) : [n]));
    }
    addItem(multi ? 'Delete' : 'Delete page', true, () => (multi ? deleteSelection() : onDelete(n)));

    // Show first so the menu has measurable dimensions, then clamp it inside the host.
    menuElem.style.display = '';
    const hostRect = batchHost.getBoundingClientRect();
    const left = Math.min(clientX - hostRect.left, hostRect.width - menuElem.offsetWidth - 4);
    const top = Math.min(clientY - hostRect.top, hostRect.height - menuElem.offsetHeight - 4);
    menuElem.style.left = `${Math.max(4, left)}px`;
    menuElem.style.top = `${Math.max(4, top)}px`;
    // Dismiss on the next interaction outside the menu (deferred so the opening right-click does not close it).
    setTimeout(() => document.addEventListener('pointerdown', onMenuOutsidePointer), 0);
  }

  /** @param {PointerEvent} e */
  function onMenuOutsidePointer(e) {
    if (menuElem.contains(/** @type {Node} */ (e.target))) return;
    closeContextMenu();
  }

  /**
   * A plain click navigates to one page and clears the batch, Ctrl/Cmd toggles a page in the batch, and Shift extends a range from the anchor.
   * `selected` is the batch set (shown with a check), tracked separately from navigation, which drives `activePage`.
   * @param {MouseEvent} e
   * @param {number} n
   */
  function handleThumbClick(e, n) {
    // The rail and grid both sit beside the visible document, so a plain click navigates to the page (and clears the batch).
    if (e.shiftKey && selAnchor >= 0) {
      const lo = Math.min(selAnchor, n);
      const hi = Math.max(selAnchor, n);
      selected.clear();
      for (let i = lo; i <= hi; i++) selected.add(i);
      syncSelectionUI();
      if (onSelect) onSelect(n);
    } else if (e.ctrlKey || e.metaKey) {
      // Seed with the page that was plain-clicked just before this Ctrl-click so the first Ctrl-add keeps both,
      // rather than starting the selection at the Ctrl-clicked page and dropping the original.
      if (selected.size === 0 && selAnchor >= 0 && selAnchor < pageCount && selAnchor !== n) selected.add(selAnchor);
      if (selected.has(n)) selected.delete(n); else selected.add(n);
      selAnchor = n;
      syncSelectionUI();
    } else {
      selected.clear();
      selAnchor = n;
      syncSelectionUI();
      if (onSelect) onSelect(n);
    }
  }

  /**
   * Rotate every selected page clockwise by `deg` (a multiple of 90) in place (CSS transform only, no re-render).
   * @param {number} [deg]
   */
  function rotateSelection(deg = 90) {
    if (selected.size === 0) return;
    scribe.rotatePages([...selected], deg);
    computeGeometry();
    for (const [i, entry] of mounted) restyleRow(entry, i);
    updateWindow();
  }

  /** Delete every selected page in place, keeping at least one page in the document. */
  function deleteSelection() {
    if (selected.size === 0 || !scribe.doc) return;
    cancelCut();
    let toDelete = [...selected].filter((i) => i < pageCount).sort((a, b) => a - b);
    if (toDelete.length >= pageCount) toDelete = toDelete.slice(0, pageCount - 1);
    if (toDelete.length === 0) return;
    const delSet = new Set(toDelete);
    const belowActive = toDelete.filter((d) => d < activePage).length;
    const snapshot = [...mounted];
    mounted.clear();
    selected.clear();

    scribe.deletePages(toDelete);
    computeGeometry();
    if (activePage >= 0) activePage = Math.max(0, Math.min(activePage - belowActive, pageCount - 1));

    for (const [oi, entry] of snapshot) {
      if (delSet.has(oi)) { unmountRow(oi, entry); continue; }
      const ni = oi - toDelete.filter((d) => d < oi).length;
      restyleRow(entry, ni);
      mounted.set(ni, entry);
    }
    updateWindow();
    updateBatchToolbar();
  }

  /** Reflect the pending-cut marks on the mounted rows. */
  function syncCutUI() {
    for (const [n, entry] of mounted) entry.thumbElem.classList.toggle('cut', cutMarks.has(n));
  }

  /**
   * Cancel this document's pending cut before an index-changing edit (delete/reorder).
   * The cut's stored source indices would otherwise go stale and a later paste could remove the wrong pages.
   * A copy survives, since its payload is an independent clone.
   */
  function cancelCut() {
    if (pageClipboard.mode === 'cut' && scribe.doc && pageClipboard.sourceDocId === scribe.doc.id) {
      clearPageClipboard();
    }
    if (cutMarks.size) { cutMarks.clear(); syncCutUI(); }
  }

  /**
   * Snapshot pages `indices` to the page clipboard for a later paste.
   * `mode` 'cut' marks the originals for removal on paste (and dims them).
   * 'copy' leaves them in place.
   * Editor-only, with same-document scope stamped by `doc.id`.
   * @param {Array<number>} indices
   * @param {'cut'|'copy'} mode
   */
  function copySelection(indices, mode) {
    if (!scribe.doc) return;
    const targets = [...new Set(indices)].filter((i) => i >= 0 && i < pageCount).sort((a, b) => a - b);
    if (targets.length === 0) return;
    pageClipboard.payloads = scribe.doc.copyPages(targets);
    pageClipboard.mode = mode;
    pageClipboard.sourceDocId = scribe.doc.id;
    pageClipboard.sourceIndices = targets;
    cutMarks.clear();
    if (mode === 'cut') for (const i of targets) cutMarks.add(i);
    syncCutUI();
  }

  /** Whether the clipboard holds pages from THIS document, so a paste here is valid. */
  function canPaste() {
    return !!scribe.doc && pageClipboard.payloads.length > 0 && pageClipboard.sourceDocId === scribe.doc.id;
  }

  /**
   * Paste the clipboard's pages as a contiguous block at `insertIndex`, rebuild the rail, and select the new pages.
   * A cut removes the originals and is consumed (clipboard cleared).
   * A copy can be pasted again.
   * @param {number} insertIndex
   */
  function pasteAt(insertIndex) {
    if (!canPaste()) return;
    const opts = pageClipboard.mode === 'cut' ? { removeSourceIndices: [...pageClipboard.sourceIndices] } : {};
    const range = scribe.pastePages(pageClipboard.payloads, insertIndex, opts);
    if (pageClipboard.mode === 'cut') clearPageClipboard();
    cutMarks.clear();
    if (!range) return;
    // `scribe.pastePages` already rebuilt the viewer onto the first pasted page; `rebuild` re-lays the rail to match.
    rebuild(range.start);
    // The freshly inserted pages become the selection.
    for (let i = range.start; i < range.start + range.count; i++) selected.add(i);
    selAnchor = range.start;
    syncSelectionUI();
  }

  /**
   * Mark page `n` as current (highlight + scroll into the panel view if off-screen).
   * @param {number} n
   */
  function setActive(n) {
    if (n === activePage) return;
    // Swap the highlight immediately.
    // A classList change touches no layout, so this stays cheap mid-scroll and keeps the active thumb marked as pages flip past.
    const prev = mounted.get(activePage);
    if (prev) prev.thumbElem.classList.remove('active');
    activePage = n;
    const cur = mounted.get(n);
    if (cur) cur.thumbElem.classList.add('active');
    if (!visible || pageCount === 0 || !heights[n]) return;

    // Defer scrolling the active thumb into view onto a settle timer.
    // The viewer's per-page word build dirties layout at every page-boundary crossing, so an inline scroll-into-view would force a reflow at each one.
    // Coalesced, it runs once after scrolling settles, on clean layout.
    if (activeScrollTimer) clearTimeout(activeScrollTimer);
    activeScrollTimer = setTimeout(() => {
      activeScrollTimer = null;
      if (destroyed) return;
      scrollThumbIntoView(activePage);
    }, ACTIVE_SCROLL_DEBOUNCE_MS);
  }

  /**
   * Scroll the rail the minimum needed to bring row `n` fully into the scroll viewport, then settle the mounted set.
   * Sets `scrollTop` directly rather than `scrollIntoView`, which could also scroll an ancestor or the document.
   * No-op while hidden or before the row's geometry is known.
   * @param {number} n
   */
  function scrollThumbIntoView(n) {
    if (!visible || pageCount === 0 || n < 0 || !heights[n]) return;
    const top = offsets[n];
    const bottom = top + heights[n];
    const viewTop = scrollElem.scrollTop - PAD;
    const viewBottom = viewTop + viewportH;
    if (top < viewTop) scrollElem.scrollTop = Math.max(0, top + PAD - 8);
    else if (bottom > viewBottom) scrollElem.scrollTop = bottom + PAD - viewportH + 8;
    updateWindow(true);
  }

  /**
   * Slide the panel in or out. On the way out the rows stay mounted for the duration of the slide,
   * then unmount so the panel holds no decoded images while hidden.
   * @param {boolean} v
   */
  function setVisible(v) {
    visible = v;
    toggleElem.classList.toggle('active', v);
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (v) {
      panelElem.style.transform = 'translateX(0)';
      // Revealing the rail should paint its thumbnails right away, not 120ms later.
      updateWindow(true);
    } else {
      // A hidden rail must not stay the active pane, or it would keep swallowing the arrow keys.
      // Release focus so the viewer reclaims them.
      if (document.activeElement === panelElem) panelElem.blur();
      panelElem.style.transform = 'translateX(-100%)';
      generation += 1;
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
      hideTimer = setTimeout(() => { hideTimer = null; clearMounted(); }, SLIDE_MS);
    }
    // The batch strip lives outside the panel, so it does not slide with it; show/hide it with the rail.
    updateBatchToolbar();
    // The document insets to the panel when shown, and reclaims the space when hidden.
    notifyResize();
  }

  /**
   * Keyboard handler for the thumbnail rail, active only while focus is within the panel.
   * Arrow keys move the current page by one and Home/End jump to the ends, each mirroring a plain thumbnail click.
   * Shift extends the batch selection from the anchor, like Shift+click.
   * Stops propagation on handled keys so the viewer's own arrow-key word navigation does not also fire.
   * @param {KeyboardEvent} e
   */
  function onPanelKeyDown(e) {
    if (!visible || pageCount === 0) return;

    // Cut/copy/paste pages (editor-only). Cmd on Mac via metaKey.
    // Handled here while the rail has focus, so it does not collide with the document-level word-text copy handler (which ignores the non-text panel selection anyway).
    if ((e.ctrlKey || e.metaKey) && !e.altKey && scribe.opt.enablePageEditing && scribe.opt.keyboardScope !== 'off') {
      const key = e.key.toLowerCase();
      if (key === 'x' || key === 'c') {
        const targets = selected.size ? [...selected] : (activePage >= 0 ? [activePage] : []);
        if (targets.length === 0) return;
        copySelection(targets, key === 'x' ? 'cut' : 'copy');
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (key === 'v') {
        pasteAt(activePage >= 0 ? activePage + 1 : pageCount);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    // Escape cancels a pending cut from this document.
    if (e.key === 'Escape' && pageClipboard.mode === 'cut' && canPaste()) {
      clearPageClipboard();
      cutMarks.clear();
      syncCutUI();
      e.preventDefault();
      return;
    }

    const cur = activePage >= 0 ? activePage : 0;
    let target;
    if (e.key === 'ArrowDown') target = Math.min(cur + 1, pageCount - 1);
    else if (e.key === 'ArrowUp') target = Math.max(cur - 1, 0);
    else if (e.key === 'Home') target = 0;
    else if (e.key === 'End') target = pageCount - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) {
      if (selAnchor < 0) selAnchor = cur;
      const lo = Math.min(selAnchor, target);
      const hi = Math.max(selAnchor, target);
      selected.clear();
      for (let i = lo; i <= hi; i++) selected.add(i);
      syncSelectionUI();
    } else {
      selected.clear();
      selAnchor = target;
      syncSelectionUI();
    }
    // Swap the highlight now (cheap, classList only), then scroll immediately so a held arrow key tracks page by
    // page rather than waiting on `setActive`'s coalesced scroll. `onSelect` re-asserts the same active page.
    setActive(target);
    scrollThumbIntoView(target);
    if (onSelect) onSelect(target);
  }
  panelElem.addEventListener('keydown', onPanelKeyDown);

  /**
   * Clear the page selection on a pointerdown outside the panel and its selection UI.
   * The batch strip and context menu are exempted too because they belong to the selection but float outside the panel.
   * @param {PointerEvent} e
   */
  function onOutsidePointerDown(e) {
    if (selected.size === 0) return;
    const t = e.target;
    if (t instanceof Element && t.closest('.scribe-thumb-scroll, .scribe-thumb-batch, .scribe-thumb-menu, .scribe-thumb-resize')) return;
    clearSelection();
  }
  batchHost.addEventListener('pointerdown', onOutsidePointerDown);

  /**
   * Batch keyboard actions on the current selection: Delete/Backspace removes the selected pages, Escape clears the selection.
   * The handler is inert while the panel is hidden.
   * Delete/Backspace are additionally ignored when nothing is selected or focus is in a text field.
   * @param {KeyboardEvent} e
   */
  function onKeyDown(e) {
    if (!visible) return;
    if (e.key === 'Escape') { closeContextMenu(); clearSelection(); return; }
    if (selected.size === 0) return;
    const t = /** @type {?HTMLElement} */ (e.target);
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelection();
    }
  }
  document.addEventListener('keydown', onKeyDown);

  /** Tear down: unmount all rows, cancel pending renders, and drop the DOM. */
  function destroy() {
    destroyed = true;
    generation += 1;
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (activeScrollTimer) { clearTimeout(activeScrollTimer); activeScrollTimer = null; }
    if (columnFlip) { clearTimeout(columnFlip.timer); columnFlip = null; }
    if (marquee) {
      window.removeEventListener('pointermove', onMarqueeMove);
      window.removeEventListener('pointerup', onMarqueeUp);
      if (marquee.rafId) cancelAnimationFrame(marquee.rafId);
      marquee = null;
    }
    viewportObserver.disconnect();
    reorder.cancelDrag();
    closeContextMenu();
    panelElem.removeEventListener('keydown', onPanelKeyDown);
    batchHost.removeEventListener('pointerdown', onOutsidePointerDown);
    document.removeEventListener('keydown', onKeyDown);
    clearMounted();
    batchBar.remove();
    menuElem.remove();
    panelElem.replaceChildren();
  }

  return {
    panelElem, toggleElem, rebuild, setActive, setVisible, destroy,
  };
}

/**
 * Build and install overlay scrollbars inside `viewerContainer`, driven by the viewer's native scroll container.
 * @param {import('../../viewer.js').ScribeViewer} scribe
 * @param {HTMLElement} viewerContainer - The positioned element the tracks are appended to.
 * @returns {{ updateScrollbars: () => void, vTrack: HTMLDivElement, vThumb: HTMLDivElement, hTrack: HTMLDivElement, hThumb: HTMLDivElement }}
 */
export function createScrollbars(scribe, viewerContainer) {
  const vTrack = document.createElement('div');
  vTrack.className = 'scribe-scrollbar scribe-scrollbar-v';
  vTrack.style.display = 'none';
  const vThumb = document.createElement('div');
  vThumb.className = 'scribe-scrollbar-thumb';
  vTrack.appendChild(vThumb);

  const hTrack = document.createElement('div');
  hTrack.className = 'scribe-scrollbar scribe-scrollbar-h';
  hTrack.style.display = 'none';
  const hThumb = document.createElement('div');
  hThumb.className = 'scribe-scrollbar-thumb';
  hTrack.appendChild(hThumb);

  viewerContainer.appendChild(vTrack);
  viewerContainer.appendChild(hTrack);

  /**
   * Compute scrollbar geometry for one axis from the native scroll metrics of the viewer's scroll container.
   * @param {'x'|'y'} axis
   * @param {boolean} otherVisible - Whether the perpendicular scrollbar is showing (shortens this track).
   * @returns {?{visible: boolean, trackPx: number, thumbPx: number, startPx: number, maxScroll: number}}
   */
  function scrollGeometry(axis, otherVisible) {
    const sc = scribe.scrollContainer;
    const pageMetrics = scribe.doc && scribe.doc.pageMetrics;
    if (!sc || !pageMetrics || pageMetrics.length === 0) return null;

    const barSize = 12;
    const minThumb = 24;

    const m = scribe._scrollMetrics();
    const clientSize = axis === 'y' ? m.clientHeight : m.clientWidth;
    const scrollSize = axis === 'y' ? m.scrollHeight : m.scrollWidth;
    // During a scroll gesture the per-frame word build has dirtied layout, so reading scrollTop/Left live would force a reflow.
    // Reuse the value `updateCurrentPage` read cleanly this frame, and read live otherwise.
    const active = scribe.autoScroll?.active || scribe.drag?.isDragging;
    const scrollPos = active
      ? (axis === 'y' ? scribe._scrollTop : scribe._scrollLeft)
      : (axis === 'y' ? sc.scrollTop : sc.scrollLeft);

    const visible = scrollSize > clientSize + 0.5;
    const trackPx = Math.max(0, clientSize - (otherVisible ? barSize : 0));
    const thumbPx = Math.min(trackPx, Math.max(minThumb, (clientSize / scrollSize) * trackPx));
    const maxScroll = Math.max(1, scrollSize - clientSize);
    const posFrac = Math.min(1, Math.max(0, scrollPos / maxScroll));
    const startPx = posFrac * (trackPx - thumbPx);

    return {
      visible, trackPx, thumbPx, startPx, maxScroll,
    };
  }

  /**
   * Wire thumb-drag and track-click scrolling for one axis.
   * @param {'x'|'y'} axis
   * @param {HTMLDivElement} track
   * @param {HTMLDivElement} thumb
   */
  function installScrollbarDrag(axis, track, thumb) {
    /** @type {?{trackStart: number, grab: number}} */
    let dragState = null;

    const onMove = (event) => {
      if (!dragState) return;
      const otherVisible = (axis === 'y' ? hTrack : vTrack).style.display !== 'none';
      const geom = scrollGeometry(axis, otherVisible);
      if (!geom) return;
      const client = axis === 'y' ? event.clientY : event.clientX;
      const denom = geom.trackPx - geom.thumbPx;
      const startPx = Math.min(denom, Math.max(0, client - dragState.trackStart - dragState.grab));
      const posFrac = denom > 0 ? startPx / denom : 0;
      const scrollPos = posFrac * geom.maxScroll;
      if (axis === 'y') scribe.scrollContainer.scrollTop = scrollPos;
      else scribe.scrollContainer.scrollLeft = scrollPos;
      // The container's `scroll` event also refreshes the bars, but it fires async.
      // Reposition now so the thumb tracks the drag synchronously.
      updateScrollbars();
      event.preventDefault();
    };

    const onUp = () => {
      dragState = null;
      thumb.classList.remove('dragging');
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };

    thumb.addEventListener('pointerdown', (event) => {
      const rect = track.getBoundingClientRect();
      const trackStart = axis === 'y' ? rect.top : rect.left;
      const thumbStart = axis === 'y' ? thumb.offsetTop : thumb.offsetLeft;
      const client = axis === 'y' ? event.clientY : event.clientX;
      dragState = { trackStart, grab: client - (trackStart + thumbStart) };
      thumb.classList.add('dragging');
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      event.preventDefault();
      event.stopPropagation();
    });

    track.addEventListener('pointerdown', (event) => {
      if (event.target !== track) return;
      const rect = track.getBoundingClientRect();
      const trackStart = axis === 'y' ? rect.top : rect.left;
      const thumbStart = axis === 'y' ? thumb.offsetTop : thumb.offsetLeft;
      const client = axis === 'y' ? event.clientY : event.clientX;
      const sc = scribe.scrollContainer;
      const clientSize = axis === 'y' ? sc.clientHeight : sc.clientWidth;
      // Page toward the click: above the thumb scrolls back (negative), below scrolls forward.
      const delta = client < trackStart + thumbStart ? clientSize * -0.9 : clientSize * 0.9;
      if (axis === 'y') sc.scrollTop += delta;
      else sc.scrollLeft += delta;
      event.preventDefault();
    });
  }

  /** Reposition and show/hide both overlay scrollbars to match the current native scroll position. */
  function updateScrollbars() {
    if (!scribe.scrollContainer) return;
    const vVisible = !!(scrollGeometry('y', false)?.visible);
    const hGeom = scrollGeometry('x', vVisible);
    const hVisible = !!(hGeom?.visible);
    const vGeom = scrollGeometry('y', hVisible);

    if (vGeom && vGeom.visible) {
      vTrack.style.display = 'block';
      vTrack.style.height = `${Math.round(vGeom.trackPx)}px`;
      vThumb.style.height = `${Math.round(vGeom.thumbPx)}px`;
      vThumb.style.top = `${Math.round(vGeom.startPx)}px`;
    } else {
      vTrack.style.display = 'none';
    }

    if (hGeom && hGeom.visible) {
      hTrack.style.display = 'block';
      hTrack.style.width = `${Math.round(hGeom.trackPx)}px`;
      hThumb.style.width = `${Math.round(hGeom.thumbPx)}px`;
      hThumb.style.left = `${Math.round(hGeom.startPx)}px`;
    } else {
      hTrack.style.display = 'none';
    }
  }

  installScrollbarDrag('y', vTrack, vThumb);
  installScrollbarDrag('x', hTrack, hThumb);

  // Native scroll fires `scroll`.
  // Zoom changes the content size, caught by observing the scroll container and its content.
  scribe.scrollContainer.addEventListener('scroll', () => updateScrollbars());
  const ro = new ResizeObserver(() => updateScrollbars());
  ro.observe(scribe.scrollContainer);
  if (scribe.contentSizer) ro.observe(scribe.contentSizer);
  updateScrollbars();

  return {
    updateScrollbars, vTrack, vThumb, hTrack, hThumb,
  };
}
