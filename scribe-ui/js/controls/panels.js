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
// Bounds for the user-draggable thumbnail image width (panel width is this plus PANEL_EXTRA_W).
const MIN_IMG_W = 90;
const MAX_IMG_W = 300;
// Slide duration in ms. Must match the `transition` on `.scribe-thumb-panel` so the post-hide unmount waits for it.
const SLIDE_MS = 180;
// Fallback height in px for centering the floating batch pill before it has been laid out and measured.
const BATCH_BAR_H = 40;

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
 * @param {number} [cfg.width=150] - Thumbnail image width in px.
 * @param {(n: number) => void} cfg.onSelect - Called with the page index when a thumbnail is clicked.
 * @param {(pageIndices: Array<number>) => void} [cfg.onExtract] - Called with the page indices to open as a new document.
 * @returns {{
 *   panelElem: HTMLDivElement, toggleElem: HTMLSpanElement,
 *   rebuild: (activeN?: number) => void, setActive: (n: number) => void,
 *   setVisible: (v: boolean) => void, destroy: () => void
 * }}
 */
export function createThumbnailPanel(scribe, { width = 150, onSelect, onExtract }) {
  let THUMB_W = Math.max(MIN_IMG_W, Math.min(MAX_IMG_W, width));

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

  // Drag handle on the panel's right edge for resizing the thumbnail width (see resize wiring below).
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
  let total = 0;
  let pageCount = 0;

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
    thumbElem.style.top = `${PAD + offsets[n]}px`;
    thumbElem.style.height = `${heights[n]}px`;
    thumbElem.dataset.page = String(n);
    thumbElem.classList.toggle('active', n === activePage);
    thumbElem.classList.toggle('selected', selected.has(n));
    thumbElem.classList.toggle('cut', cutMarks.has(n));

    const box = imgElem.parentElement;
    if (box) box.style.height = `${boxHeights[n]}px`;

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
    // Render at the maximum rail width and let CSS downscale into the THUMB_W box, so thumbnails stay crisp at any width.
    doc.images.renderThumbnail(n, MAX_IMG_W).then((blob) => {
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

  /**
   * Mount the rows in the current scroll window (+buffer), unmount the rest, then queue renders.
   * @param {boolean} [immediate=false] - Render the newly mounted rows now rather than behind the scroll debounce.
   */
  function updateWindow(immediate = false) {
    if (destroyed || !visible || pageCount === 0) return;
    const viewH = scrollElem.clientHeight;
    const first = rowAt(Math.max(0, scrollElem.scrollTop - PAD - BUFFER));
    const last = rowAt(Math.max(0, scrollElem.scrollTop - PAD + viewH + BUFFER));
    for (const [n, entry] of mounted) {
      // Keep the row being dragged mounted even when it scrolls out of the window, so the ghost's image URL
      // (owned by this row) is not revoked mid-drag.
      if ((n < first || n > last) && !(drag && drag.started && drag.pages.has(n))) unmountRow(n, entry);
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
      const fling = speed > scrollElem.clientHeight * FLING_VIEWPORT_FRACTION;
      updateWindow(!fling);
    });
  }
  scrollElem.addEventListener('scroll', onScroll);

  /**
   * Recompute every row's box height, full height, and top offset from the current page metrics and THUMB_W,
   * and size the spacer to the total. Shared by the document rebuild and the width resize.
   */
  function computeGeometry() {
    const doc = scribe.doc;
    pageCount = doc?.inputData?.pageCount ?? 0;
    if (!doc || pageCount === 0) {
      offsets = [];
      heights = [];
      boxHeights = [];
      total = 0;
      spacer.style.height = '0px';
      return;
    }
    const metrics = doc.pageMetrics || [];
    offsets = [];
    heights = [];
    boxHeights = [];
    let acc = 0;
    for (let n = 0; n < pageCount; n++) {
      const dims = metrics[n] && metrics[n].dims;
      const rotated = (((metrics[n] && metrics[n].rotation) || 0) % 180) === 90;
      let aspect = dims && dims.width ? dims.height / dims.width : DEFAULT_ASPECT;
      if (rotated && dims && dims.height) aspect = dims.width / dims.height;
      const boxH = Math.max(1, Math.round(THUMB_W * aspect));
      boxHeights[n] = boxH;
      heights[n] = boxH + ROW_OVERHEAD;
      offsets[n] = acc;
      acc += heights[n];
    }
    total = acc;
    spacer.style.height = `${total}px`;
  }

  /**
   * Rebuild the panel for the current document: recompute row geometry and mount the window around the active page.
   * @param {number} [activeN=-1] - Page to mark active and scroll to (e.g. a tab's last page), or -1 to start at the top.
   */
  function rebuild(activeN = -1) {
    generation += 1;
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
    clearMounted();
    // A rebuild means the document changed, so the old page indices no longer refer to the same pages.
    selected.clear();
    selAnchor = -1;
    cutMarks.clear();
    updateBatchToolbar();
    computeGeometry();
    activePage = activeN >= 0 && activeN < pageCount ? activeN : -1;
    // Start scrolled to the active page so its thumbnail is in the first mounted window.
    // This avoids the top-then-jump (and its second, late render) when switching to a tab whose last page is far down.
    // Same bottom-align as setActive.
    if (activePage > 0 && heights[activePage]) {
      const bottom = offsets[activePage] + heights[activePage];
      scrollElem.scrollTop = Math.max(0, bottom + PAD - scrollElem.clientHeight + 8);
    } else {
      scrollElem.scrollTop = 0;
    }
    updateWindow(true);
  }

  /**
   * Resize the thumbnail width to `imgW` (clamped to the allowed range),
   * reflowing every row and re-rendering at the new resolution while keeping the current scroll position.
   * @param {number} imgW
   */
  function setWidth(imgW) {
    THUMB_W = Math.max(MIN_IMG_W, Math.min(MAX_IMG_W, Math.round(imgW)));
    panelElem.style.width = `${THUMB_W + PANEL_EXTRA_W}px`;
    generation += 1;
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
    clearMounted();
    computeGeometry();
    scrollElem.scrollTop = Math.min(scrollElem.scrollTop, Math.max(0, total - scrollElem.clientHeight));
    updateWindow(true);
  }

  // Drag the right-edge handle to resize the thumbnail width.
  // The panel widens live for feedback, and the thumbnails reflow and re-render once at the new resolution when the drag ends.
  let dragStartX = 0;
  let dragStartW = 0;
  let dragW = 0;
  /** @param {PointerEvent} event */
  function onResizeMove(event) {
    dragW = Math.max(MIN_IMG_W, Math.min(MAX_IMG_W, dragStartW + (event.clientX - dragStartX)));
    panelElem.style.width = `${dragW + PANEL_EXTRA_W}px`;
  }

  function onResizeEnd() {
    window.removeEventListener('pointermove', onResizeMove);
    window.removeEventListener('pointerup', onResizeEnd);
    setWidth(dragW);
  }

  resizeHandle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    dragStartX = event.clientX;
    dragStartW = THUMB_W;
    dragW = THUMB_W;
    window.addEventListener('pointermove', onResizeMove);
    window.addEventListener('pointerup', onResizeEnd);
  });

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
    const viewBottom = viewTop + scrollElem.clientHeight;
    if (top < viewTop) scrollElem.scrollTop = Math.max(0, top + PAD - 8);
    else if (bottom > viewBottom) scrollElem.scrollTop = bottom + PAD - scrollElem.clientHeight + 8;
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
   * A press anywhere in the component clears the page selection,
   * unless it lands on a thumbnail, the selection's own floating UI (batch strip, context menu), or the resize handle.
   * Thumbnails are left to `handleThumbClick`, and the resize handle is excluded so a width drag keeps the selection.
   * @param {PointerEvent} e
   */
  function onOutsidePointerDown(e) {
    if (selected.size === 0) return;
    const t = e.target;
    if (t instanceof Element && t.closest('.scribe-thumb-box, .scribe-thumb-batch, .scribe-thumb-menu, .scribe-thumb-resize')) return;
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
