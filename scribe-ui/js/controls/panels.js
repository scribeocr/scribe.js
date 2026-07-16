// Page-area frame elements shared by the viewer and editor apps: the page-thumbnails rail and the custom overlay scrollbars.
// Both are positioned over the viewer and driven by the stage.
import { makeIconButton } from './toolbar.js';
import { installPageReorder, REORDER_SLIDE_MS } from './pageReorder.js';

/** @typedef {{thumbElem: HTMLDivElement, imgElem: HTMLImageElement, url: ?string, pending: boolean}} ThumbRow */

// A left column of small previews beside a larger page, evoking a thumbnails panel.
export const THUMB_SVG = `<svg xmlns="http://www.w3.org/2000/svg" height="20" width="20" viewBox="0 0 24 24" fill="currentColor">
<rect x="4" y="3" width="7" height="5" rx="1"/>
<rect x="4" y="10" width="7" height="5" rx="1"/>
<rect x="4" y="17" width="7" height="4" rx="1"/>
<rect x="14" y="3" width="6" height="18" rx="1" opacity="0.55"/>
</svg>`;
const ROTATE_SVG = `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="display:block;pointer-events:none;">
<path d="M15.55 5.55L11 1v3.07C7.06 4.56 4 7.92 4 12s3.05 7.44 7 7.93v-2.02c-2.84-.48-5-2.94-5-5.91s2.16-5.43 5-5.91V10l4.55-4.45zM19.93 11c-.17-1.39-.72-2.73-1.62-3.89l-1.42 1.42c.54.75.88 1.6 1.02 2.47h2.02zM13 17.9v2.02c1.39-.17 2.74-.71 3.9-1.61l-1.44-1.44c-.75.54-1.59.89-2.46 1.03zm3.89-2.42l1.42 1.41c.9-1.16 1.45-2.5 1.62-3.89h-2.02c-.14.87-.48 1.72-1.02 2.47z"/></svg>`;
const DELETE_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M9 3v1H4v2h16V4h-5V3H9zM6 7l1 13h10l1-13H6z"/></svg>';
// Check face of the Edit-mode selection checkbox; always in the markup, kept transparent by CSS until the page is selected.
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"'
  + ' stroke-linejoin="round" aria-hidden="true"><path d="M5.5 12.5l4.3 4.3L18.5 7.5"/></svg>';
// An X glyph for the selection bar's clear button.
const CLEAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';

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
// Thumbnail image width in px (panel width is this plus PANEL_EXTRA_W for one column).
// The desktop rail uses THUMB_W; the phone sheet uses COMPACT_W so several columns fit its width (see setCompact).
const THUMB_W = 200;
const COMPACT_W = 104;
// Column cap in the compact phone grid (higher than MAX_COLS so a landscape phone can pack more).
const COMPACT_MAX_COLS = 6;
// Resolution thumbnails are rasterized at; kept above THUMB_W so they stay crisp on high-DPI screens (CSS downscales).
const RENDER_W = 300;
// Slide duration in ms. Must match the `transition` on `.scribe-thumb-panel` so the post-hide unmount waits for it.
const SLIDE_MS = 180;
// Fallback height in px for centering the floating batch pill before it has been laid out and measured.
const BATCH_BAR_H = 40;
// Gap in px between cells (and from the panel edge) in the multi-column grid layout.
const GRID_GAP = 14;
// Tighter per-row overhead and vertical gap for the compact phone grid; the overhead must match the padding/label sizing under `.scribe-thumb-compact`.
const COMPACT_ROW_OVERHEAD = 21;
const COMPACT_VGAP = 7;
// Most columns the panel can be widened to. The resize handle caps the panel width here; there is no full-screen mode.
const MAX_COLS = 3;
// Pointer travel in px before a press in the panel's empty space becomes a drag-select rather than a plain click.
const MARQUEE_THRESHOLD = 4;
// Distance in px from the scroll viewport's top/bottom edge that auto-scrolls the rail during a drag-select, and its speed.
const MARQUEE_EDGE = 36;
const MARQUEE_SPEED = 14;

/** Columns of `cw`-wide cells that fit in inner width `w`. @param {number} w @param {number} cw */
const colsFor = (w, cw) => Math.max(1, Math.floor((w - 2 * PAD + GRID_GAP) / (cw + GRID_GAP)));
/** Panel width in px that fits exactly `cols` columns of `cw`-wide cells. @param {number} cols @param {number} cw */
const panelWidthForCols = (cols, cw) => cols * cw + (cols - 1) * GRID_GAP + PANEL_EXTRA_W;

/**
 * Module-scoped page clipboard for cut/copy/paste of whole pages.
 * A copy pastes into any open document. A cut only pastes into its source, since pasting it removes the originals.
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
 * @param {(n: number) => void} [cfg.onPageOpen] - Show page `n` in the viewer, closing any surface that covers it (the browse-mode double-tap).
 *   Falls back to `onSelect`.
 * @param {(pageIndices: Array<number>) => void} [cfg.onExtract] - Called with the page indices to open as a new document.
 * @param {(at: number) => void} [cfg.onInsertFromFile] - Called with the gap index at which to insert pages picked from a file.
 * @param {(width: number, phase?: 'start'|'move'|'end') => void} [cfg.onResize] - Called with the panel's current visible width in px (0 when hidden).
 *   `phase` is set on handle-drag reports and absent on non-drag reports (view shown or hidden).
 * @returns {{
 *   panelElem: HTMLDivElement, toggleElem: HTMLSpanElement,
 *   rebuild: (activeN?: number) => void, cancelCut: () => void, setActive: (n: number) => void,
 *   setVisible: (v: boolean) => void, setWidth: (px: number) => number,
 *   setCompact: (on: boolean) => void, setRoomMode: (mode: ?('browse'|'edit')) => void, clearSelection: () => void,
 *   beginStructureSlide: () => (() => void), refit: () => void,
 *   getResizeBounds: () => { min: number, max: number },
 *   gridGeometry: () => { count: number, cols: number, cellW: number, pad: number, strideX: number,
 *     boxLeft: (n: number) => number, boxTop: (n: number) => number, boxH: (n: number) => number, thumbTop: (n: number) => number },
 *   dropIndicator: { gapAt: (clientX: number, clientY: number) => number, show: (clientX: number, clientY: number) => number, hide: () => void },
 *   insertPagesAt: (at: number, count: number, activeN: number) => void,
 *   destroy: () => void
 * }}
 */
export function createThumbnailPanel(scribe, {
  onSelect, onPageOpen, onExtract, onInsertFromFile, onResize,
}) {
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

  // Floating selection bar for the phone room's Edit mode: count + Clear, then Rotate + Delete.
  // A child of the panel, unlike the pill: it never needs to overhang the panel bounds, and the panel is its positioning context in the room.
  // Clear sits by the count, away from Delete, so dismissing a selection never borders the destructive verb.
  const roomBar = document.createElement('div');
  roomBar.className = 'scribe-thumb-selbar';
  const roomBarCount = document.createElement('span');
  roomBarCount.className = 'scribe-thumb-selbar-count';
  const roomBarClear = document.createElement('button');
  roomBarClear.type = 'button';
  roomBarClear.className = 'scribe-thumb-selbar-clear';
  roomBarClear.title = 'Clear selection';
  roomBarClear.setAttribute('aria-label', 'Clear selection');
  roomBarClear.innerHTML = CLEAR_SVG;
  roomBarClear.addEventListener('click', () => clearSelection());
  const roomBarRotate = document.createElement('button');
  roomBarRotate.type = 'button';
  roomBarRotate.className = 'scribe-thumb-selbar-btn';
  roomBarRotate.innerHTML = `${ROTATE_SVG}<span>Rotate</span>`;
  roomBarRotate.addEventListener('click', () => rotateSelection());
  const roomBarDelete = document.createElement('button');
  roomBarDelete.type = 'button';
  roomBarDelete.className = 'scribe-thumb-selbar-btn scribe-thumb-selbar-delete';
  roomBarDelete.innerHTML = `${DELETE_SVG}<span>Delete</span>`;
  roomBarDelete.addEventListener('click', () => {
    if (roomMode !== 'edit' || selected.size === 0 || !scribe.doc || roomBar.dataset.busy) return;
    // Mirror deleteSelection's keep-one clamp, so a surviving page is never shown shrinking.
    let doom = [...selected].filter((i) => i < pageCount).sort((a, b) => a - b);
    if (doom.length >= pageCount) doom = doom.slice(0, pageCount - 1);
    if (doom.length === 0) return;
    roomBar.dataset.busy = '1';
    const doomSet = new Set(doom);
    const sliding = [];
    for (const [n, en] of mounted) {
      if (doomSet.has(n)) {
        en.thumbElem.style.transition = 'transform .16s ease, opacity .16s ease';
        en.thumbElem.style.transform = 'scale(.55)';
        en.thumbElem.style.opacity = '0';
      } else {
        en.thumbElem.style.transition = `top ${REORDER_SLIDE_MS}ms ease, left ${REORDER_SLIDE_MS}ms ease`;
        sliding.push(en);
      }
    }
    // The commit deletes exactly the pages shown shrinking: a toggle racing the animation must not widen the delete.
    setTimeout(() => {
      selected.clear();
      for (const i of doom) selected.add(i);
      deleteSelection();
      delete roomBar.dataset.busy;
      setTimeout(() => { for (const en of sliding) en.thumbElem.style.transition = ''; }, REORDER_SLIDE_MS + 20);
    }, 170);
  });
  roomBar.append(roomBarCount, roomBarClear, roomBarRotate, roomBarDelete);
  panelElem.appendChild(roomBar);

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
  // Number of grid columns: 1 in the rail, up to MAX_COLS in grid mode.
  let gridCols = 1;
  // Effective cell width: THUMB_W in the desktop rail, COMPACT_W in the phone sheet (setCompact).
  let cellW = THUMB_W;
  let compact = false;
  // Per-row overhead (padding + label) and the vertical gap between rows; tightened for the compact phone grid.
  let rowOverhead = ROW_OVERHEAD;
  let rowGap = GRID_GAP;
  /** @type {number[]} Per-row vertical stride in px (grid mode), indexed by row. Empty in the rail. */
  let rowStrides = [];
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
  // Frozen when the multi-selection forms so scrolling the rail or growing the selection never moves the batch pill.
  /** @type {?number} */
  let batchAnchorClientY = null;
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
  // Phone Pages-room interaction mode: 'browse' is read-only, 'edit' carries the mutations.
  /** @type {?('browse'|'edit')} */
  let roomMode = null;
  // Timestamp of the grid's last scroll event.
  // A press on a still-gliding grid catches the scroll and must not act on a page.
  // Scroll events stream every frame while the grid moves, so no event within the settle window means it is at rest.
  let lastScrollT = 0;
  const SCROLL_SETTLE_MS = 100;
  const gridInMotion = () => Date.now() - lastScrollT < SCROLL_SETTLE_MS;

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
    get lefts() { return lefts; },
    get pageCount() { return pageCount; },
    get THUMB_W() { return cellW; },
    get gridCols() { return gridCols; },
    get rowStrides() { return rowStrides; },
    rowAt,
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
    openContextMenu,
    cancelCut,
    get roomMode() { return roomMode; },
    gridInMotion,
    peekShow,
    peekHide,
    openPage: (n) => (onPageOpen || onSelect)(n),
    toggleRoomSelect,
    setRoomSelect,
  };
  const reorder = installPageReorder(ctx);

  // Preview for an external file dragged over the rail to insert its pages, driven by the host's file-drag handlers (see the viewer's root drop wiring).
  // It reuses the reorder subsystem's gap geometry and the same accent `.scribe-thumb-insert` indicator, but owns its own line element since no internal reorder drag is in flight.
  /** @type {?HTMLDivElement} */
  let dropLine = null;
  const dropIndicator = {
    /** Gap (0..pageCount) a drop at the cursor would insert at. @param {number} clientX @param {number} clientY @returns {number} */
    gapAt(clientX, clientY) { return reorder.insertionGapAt(clientX, clientY); },
    /** Show/position the insertion line under the cursor. Returns the gap it marks. @param {number} clientX @param {number} clientY @returns {number} */
    show(clientX, clientY) {
      if (!dropLine) {
        dropLine = document.createElement('div');
        dropLine.className = 'scribe-thumb-insert';
        scrollElem.appendChild(dropLine);
      }
      const gap = reorder.insertionGapAt(clientX, clientY);
      reorder.placeInsertLineAt(dropLine, gap);
      return gap;
    },
    hide() { if (dropLine) { dropLine.remove(); dropLine = null; } },
  };

  // A held page previews centered over the grid; the reorder subsystem's browse gesture drives it (open on hold, scrub on slide, hide on release).
  // Buttonless: it lives only under the finger, so the whole overlay is pointer-events: none and the scrub hit-test passes through to the cells.
  const PEEK_W = 280; // width of the peeked page in px (a very tall page scales down to fit)
  const PEEK_SETTLE_MS = 160; // pause on one page before its crisp display-resolution upgrade
  /** @type {?HTMLDivElement} */
  let peekScrim = null;
  /** @type {?HTMLDivElement} */
  let peekBox = null;
  /** @type {?HTMLImageElement} */
  let peekImg = null;
  /** @type {?HTMLDivElement} */
  let peekCap = null;
  // The crisp render's object URL is owned here and revoked on replacement; the small cell rasters in `mounted` are never revoked here.
  let peekN = -1;
  /** @type {?ReturnType<typeof setTimeout>} */
  let peekCrispT = null;
  /** @type {?string} */
  let peekCrispUrl = null;

  /** Show the peek, or retarget an open one, on page `n`. @param {number} n */
  function peekShow(n) {
    if (!peekScrim) {
      peekScrim = document.createElement('div');
      peekScrim.className = 'scribe-thumb-scrim';
      const card = document.createElement('div');
      card.className = 'scribe-thumb-peek';
      peekBox = document.createElement('div');
      peekBox.className = 'scribe-thumb-peek-box';
      peekImg = document.createElement('img');
      peekImg.alt = '';
      peekImg.draggable = false;
      peekCap = document.createElement('div');
      peekCap.className = 'scribe-thumb-peek-cap';
      peekBox.appendChild(peekImg);
      card.append(peekBox, peekCap);
      peekScrim.appendChild(card);
      panelElem.appendChild(peekScrim);
    }
    if (peekCrispT) { clearTimeout(peekCrispT); peekCrispT = null; }
    peekN = n;
    // Size from the cell's display aspect (boxHeights is rotation-aware), clamped so a very tall page never outgrows the room body under it.
    const ratio = (boxHeights[n] || cellW) / cellW;
    let w = PEEK_W;
    let h = Math.round(w * ratio);
    const maxH = viewportH - 90;
    if (maxH > 80 && h > maxH) { w = Math.round(w * (maxH / h)); h = maxH; }
    peekBox.style.width = `${w}px`;
    peekBox.style.height = `${h}px`;
    // The already-decoded grid raster, given the same rotation treatment as restyleRow (it is stored at the page's original orientation).
    // An unrendered cell shows the bare white page and caption.
    const entry = mounted.get(n);
    const url = (entry && entry.url) || '';
    peekImg.style.cssText = url ? '' : 'display:none';
    peekImg.src = url;
    // The previous page's crisp render is off-screen now that the small raster replaced it.
    if (peekCrispUrl) { URL.revokeObjectURL(peekCrispUrl); peekCrispUrl = null; }
    // Rotation styles apply even with no raster yet; the crisp upgrade below only flips `display` back on.
    const rot = (scribe.doc && scribe.doc.pageMetrics[n] && scribe.doc.pageMetrics[n].rotation) || 0;
    if (rot % 180 === 90) {
      peekImg.style.position = 'absolute';
      peekImg.style.top = '50%';
      peekImg.style.left = '50%';
      peekImg.style.width = `${h}px`;
      peekImg.style.height = `${w}px`;
      peekImg.style.transform = `translate(-50%, -50%) rotate(${rot}deg)`;
    } else if (rot === 180) {
      peekImg.style.transform = 'rotate(180deg)';
    }
    peekCap.textContent = `Page ${n + 1}`;
    peekScrim.classList.add('on');
    // Crisp upgrade once the finger settles: a fresh render at device resolution for the box the peek shows (the rotated case swaps the img's box, so use its longer side).
    // Guarded so a scrub-away or release between request and resolve drops the result.
    peekCrispT = setTimeout(() => {
      peekCrispT = null;
      const crispW = Math.round((rot % 180 === 90 ? h : w) * Math.min(window.devicePixelRatio || 1, 3));
      scribe.doc?.images?.renderThumbnail(n, crispW, 0.7, true).then((blob) => {
        if (!blob || peekN !== n || !peekScrim.classList.contains('on')) return;
        if (peekCrispUrl) URL.revokeObjectURL(peekCrispUrl);
        peekCrispUrl = URL.createObjectURL(blob);
        peekImg.src = peekCrispUrl;
        peekImg.style.display = '';
      }).catch(() => { /* keep the small raster */ });
    }, PEEK_SETTLE_MS);
  }

  /** Hide the peek (release/interruption). The elements stay for the next hold. */
  function peekHide() {
    if (peekCrispT) { clearTimeout(peekCrispT); peekCrispT = null; }
    peekN = -1;
    if (peekScrim) peekScrim.classList.remove('on');
  }

  /**
   * Largest page index whose row top is at or above content-y `y`.
   * In the rail this is the page at `y`. In the grid it is a page in that row, so divide by `gridCols` for the row index.
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
    thumbElem.style.width = `${cellW}px`;
    thumbElem.style.top = `${PAD + offsets[n]}px`;
    thumbElem.style.height = `${heights[n]}px`;
    thumbElem.dataset.page = String(n);
    thumbElem.classList.toggle('active', n === activePage);
    thumbElem.classList.toggle('selected', selected.has(n));
    thumbElem.classList.toggle('cut', cutMarks.has(n));
    const chk = thumbElem.querySelector('.scribe-thumb-chk');
    if (chk) chk.setAttribute('aria-checked', String(selected.has(n)));

    const box = imgElem.parentElement;
    if (box) {
      box.style.width = `${cellW}px`;
      box.style.height = `${boxHeights[n]}px`;
    }

    imgElem.style.cssText = '';
    const rot = (scribe.doc && scribe.doc.pageMetrics[n] && scribe.doc.pageMetrics[n].rotation) || 0;
    if (rot % 180 === 90) {
      imgElem.style.position = 'absolute';
      imgElem.style.top = '50%';
      imgElem.style.left = '50%';
      imgElem.style.width = `${boxHeights[n]}px`;
      imgElem.style.height = `${cellW}px`;
      imgElem.style.transform = `translate(-50%, -50%) rotate(${rot}deg)`;
    } else if (rot === 180) {
      imgElem.style.transform = 'rotate(180deg)';
    }

    // Highlights and redactions are separate overlays because the cached thumbnail raster never includes them.
    if (box) {
      const annots = (scribe.doc && scribe.doc.annotations && scribe.doc.annotations.pages[n]) || [];
      const dims = scribe.doc && scribe.doc.pageMetrics[n] && scribe.doc.pageMetrics[n].dims;
      // Same box as the raster img above, so bands align with the possibly-rotated page.
      const overlayCss = rot % 180 === 90
        ? `top:50%;left:50%;width:${boxHeights[n]}px;height:${cellW}px;transform:translate(-50%, -50%) rotate(${rot}deg)`
        : (rot === 180 ? 'inset:0;transform:rotate(180deg)' : 'inset:0');
      /** @type {Array<{kind: string, color: string, opacity: number, left: number, right: number, top: number, bottom: number}>} */
      const runs = [];
      if (dims) {
        const sorted = annots
          .filter((a) => (a.type == null || a.type === 'highlight' || a.type === 'underline' || a.type === 'strikeout') && a.color && a.bbox)
          .sort((a, b) => (a.bbox.top - b.bbox.top) || (a.bbox.left - b.bbox.left));
        for (const a of sorted) {
          const h = a.bbox.bottom - a.bbox.top;
          const mid = (a.bbox.top + a.bbox.bottom) / 2;
          const kind = a.type || 'highlight';
          // Merge adjacent same-colour same-kind markups on one line so a phrase reads as a single band, not per-word specks.
          const run = runs.find((r) => r.color === a.color && r.kind === kind
            && Math.abs((r.top + r.bottom) / 2 - mid) < h * 0.6
            && a.bbox.left - r.right < h * 2 && r.left - a.bbox.right < h * 2);
          if (run) {
            run.left = Math.min(run.left, a.bbox.left);
            run.right = Math.max(run.right, a.bbox.right);
            run.top = Math.min(run.top, a.bbox.top);
            run.bottom = Math.max(run.bottom, a.bbox.bottom);
          } else {
            runs.push({
              kind, color: a.color, opacity: a.opacity ?? 0.5, left: a.bbox.left, right: a.bbox.right, top: a.bbox.top, bottom: a.bbox.bottom,
            });
          }
        }
      }
      let hlElem = thumbElem.querySelector('.scribe-thumb-hl');
      if (runs.length === 0) {
        if (hlElem) hlElem.remove();
      } else {
        if (!hlElem) {
          hlElem = document.createElement('div');
          hlElem.className = 'scribe-thumb-hl';
          box.appendChild(hlElem);
        }
        hlElem.style.cssText = overlayCss;
        hlElem.replaceChildren(...runs.map((run) => {
          const band = document.createElement('span');
          // The thin underline/strikeout bar can go sub-pixel at thumbnail scale, hence the 1px minHeight floor.
          let top = run.top;
          let height = run.bottom - run.top;
          if (run.kind !== 'highlight') {
            const barH = height * 0.12;
            top = run.kind === 'underline' ? run.bottom - barH : (run.top + run.bottom) / 2 - barH / 2;
            height = barH;
          }
          Object.assign(band.style, {
            left: `${(run.left / dims.width) * 100}%`,
            top: `${(top / dims.height) * 100}%`,
            width: `${((run.right - run.left) / dims.width) * 100}%`,
            height: `${(height / dims.height) * 100}%`,
            minHeight: '1px',
            background: run.color,
            opacity: `${run.opacity}`,
          });
          return band;
        }));
      }

      // Redactions carry no `color`, so the highlight filter above skips them; they get their own overlay here.
      const redacts = dims ? annots.filter((a) => a.type === 'redact' && a.bbox) : [];
      let rdElem = thumbElem.querySelector('.scribe-thumb-redact');
      if (redacts.length === 0) {
        if (rdElem) rdElem.remove();
      } else {
        if (!rdElem) {
          rdElem = document.createElement('div');
          rdElem.className = 'scribe-thumb-redact';
          box.appendChild(rdElem);
        }
        rdElem.style.cssText = overlayCss;
        rdElem.replaceChildren(...redacts.map((a) => {
          const band = document.createElement('span');
          Object.assign(band.style, {
            left: `${(a.bbox.left / dims.width) * 100}%`,
            top: `${(a.bbox.top / dims.height) * 100}%`,
            width: `${((a.bbox.right - a.bbox.left) / dims.width) * 100}%`,
            height: `${((a.bbox.bottom - a.bbox.top) / dims.height) * 100}%`,
            minHeight: '1px',
          });
          return band;
        }));
      }
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
    boxElem.style.width = `${cellW}px`;

    const imgElem = document.createElement('img');
    imgElem.alt = '';
    imgElem.draggable = false;
    boxElem.appendChild(imgElem);

    const labelElem = document.createElement('div');
    labelElem.className = 'scribe-thumb-label';

    boxElem.addEventListener('click', (e) => { if (!suppressClick) handleThumbClick(e, idx()); });
    // A press that never crosses the reorder drag threshold stays a plain click, because suppressClick is set only once a drag begins.
    boxElem.addEventListener('pointerdown', (e) => reorder.onThumbPointerDown(e, idx()));
    boxElem.addEventListener('contextmenu', (e) => {
      if (!(scribe.opt && scribe.opt.enablePageEditing)) return;
      e.preventDefault();
      // The room's modes have no page menu: browse is read-only, and Edit mutates on the cells.
      if (roomMode) return;
      // The touch hold-to-lift gesture opens this menu itself on a release-in-place.
      // Swallow the native long-press contextmenu Android fires in parallel so it does not open twice.
      if (reorder.touchActive()) return;
      openContextMenu(e.clientX, e.clientY, idx());
    });

    // The whole thumbnail is draggable to reorder when page editing is on; the `grab` cursor advertises it.
    if (scribe.opt && scribe.opt.enablePageEditing) boxElem.classList.add('editable');

    // Edit-mode selection checkbox, shown only under `.scribe-pages-room.editing`.
    // A child of the row, not the box, so it can overhang the page corner (the box clips its overflow) and its press never reaches the box's drag handler.
    const chkBtn = document.createElement('button');
    chkBtn.type = 'button';
    chkBtn.className = 'scribe-thumb-chk';
    chkBtn.setAttribute('role', 'checkbox');
    chkBtn.setAttribute('aria-checked', 'false');
    chkBtn.setAttribute('aria-label', 'Select page');
    chkBtn.innerHTML = CHECK_SVG;
    // chkPress swallows the click that follows any press: a handled press already toggled, and a catch-the-scroll press must not toggle.
    // A keyboard activation is a click with no preceding press, so it still toggles.
    let chkPress = false;
    chkBtn.addEventListener('pointerdown', (e) => {
      chkPress = true;
      reorder.onChkPointerDown(e, idx());
    });
    chkBtn.addEventListener('click', () => {
      if (chkPress) { chkPress = false; return; }
      if (roomMode === 'edit') toggleRoomSelect(idx());
    });

    thumbElem.appendChild(boxElem);
    thumbElem.appendChild(labelElem);
    thumbElem.appendChild(chkBtn);

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

  /**
   * The page at the centre of the scroll viewport, used both to rank the render queue and as the scheduler focus.
   * @returns {number}
   */
  function focusPage() {
    // rowAt returns the LAST page of the centre row, skewed toward later pages in a multi-column grid.
    // The centre column keeps the distance ranking symmetric (a no-op in the 1-col rail).
    const centerRowLast = rowAt(scrollElem.scrollTop + viewportH / 2);
    const rowFirst = centerRowLast - (centerRowLast % gridCols);
    return Math.max(0, Math.min(pageCount - 1, rowFirst + (gridCols >> 1)));
  }

  /**
   * Report the rail's centre page (or `null` when the rail is idle) to the render scheduler, so a staged queue dispatches the thumbnails the user is looking at before ones scrolled past.
   * Separate from the main viewer's focus because the rail can be scrolled to a different page.
   * @param {?number} n
   */
  function reportThumbFocus(n) {
    scribe.doc?.images?.pdfScheduler?.setThumbFocus(n);
  }

  /**
   * Request thumbnails for every mounted row that still lacks one, nearest the viewport centre first.
   */
  function flushRenders() {
    if (destroyed || !visible) return;
    const f = focusPage();
    /** @type {Array<[number, ThumbRow]>} */
    const pending = [];
    for (const [n, entry] of mounted) if (!entry.url && !entry.pending) pending.push([n, entry]);
    // The scheduler re-ranks a backlog by focus, but with idle workers each request dispatches the instant it is queued,
    // so an ascending sweep would raster the off-screen buffer rows before the on-screen ones.
    pending.sort((a, b) => Math.abs(a[0] - f) - Math.abs(b[0] - f));
    for (const [n, entry] of pending) requestRender(n, entry);
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
    // Snap the scroll band to whole rows, so every cell of a partially-visible edge row mounts.
    // In the rail (gridCols 1) row and page coincide.
    const firstRow = Math.floor(rowAt(Math.max(0, scrollElem.scrollTop - PAD - BUFFER)) / gridCols);
    const lastRow = Math.floor(rowAt(Math.max(0, scrollElem.scrollTop - PAD + viewH + BUFFER)) / gridCols);
    return [firstRow * gridCols, Math.min(pageCount - 1, (lastRow + 1) * gridCols - 1)];
  }

  /**
   * Mount the rows in the current scroll window (+buffer), unmount the rest, then queue renders.
   * @param {boolean} [immediate=false] - Render the newly mounted rows now rather than behind the scroll debounce.
   */
  function updateWindow(immediate = false) {
    if (destroyed || !visible || pageCount === 0) return;
    // Tell the scheduler which page the rail is centred on, so a backlogged queue renders on-screen thumbnails first.
    reportThumbFocus(focusPage());
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
    lastScrollT = Date.now();
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
    return Math.min(colsFor(viewportW || cellW, cellW), compact ? COMPACT_MAX_COLS : MAX_COLS);
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
    rowStrides = [];
    gridCols = 1;
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
      return Math.max(1, Math.round(cellW * aspect));
    };

    // Panel width changes only how many fixed-width cells fit, never their size.
    gridCols = gridColsFor();
    layoutMode = gridCols > 1 ? 'grid' : 'rail';

    if (layoutMode === 'grid') {
      // Centre the compact grid, which is narrower than its full-width sheet.
      // The desktop rail is sized to its columns, so only the phone sheet needs centring.
      const gridInnerW = gridCols * cellW + (gridCols - 1) * GRID_GAP;
      const sidePad = compact ? Math.max(PAD, Math.round((viewportW - gridInnerW) / 2)) : PAD;
      // Rows differ in height, so each row's stride is recorded here for `rowAt` to search instead of dividing by one stride.
      let rowTop = 0;
      for (let start = 0; start < pageCount; start += gridCols) {
        const end = Math.min(pageCount, start + gridCols);
        let rowBox = 1;
        for (let n = start; n < end; n++) {
          boxHeights[n] = boxHeightOf(n);
          if (boxHeights[n] > rowBox) rowBox = boxHeights[n];
        }
        for (let n = start; n < end; n++) {
          lefts[n] = sidePad + (n - start) * (cellW + GRID_GAP);
          offsets[n] = rowTop;
          heights[n] = boxHeights[n] + rowOverhead;
        }
        const stride = rowBox + rowOverhead + rowGap;
        rowStrides.push(stride);
        rowTop += stride;
      }
      total = rowTop;
    } else {
      let acc = 0;
      for (let n = 0; n < pageCount; n++) {
        boxHeights[n] = boxHeightOf(n);
        heights[n] = boxHeights[n] + rowOverhead;
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

  /**
   * The sidebar's min/max width bounds in px (1 to MAX_COLS columns).
   * Reads layout, so read once at a resize start and clamp each move against the cached result instead of re-reading per frame.
   * @returns {{ min: number, max: number }}
   */
  function getResizeBounds() {
    measureViewport();
    const maxCols = compact ? COMPACT_MAX_COLS : MAX_COLS;
    const min = panelWidthForCols(1, cellW);
    const extraW = Math.max(0, (parseFloat(panelElem.style.width) || min) - viewportW);
    const containerW = (panelElem.parentElement && panelElem.parentElement.clientWidth) || min;
    const max = Math.min(maxCols * cellW + (maxCols - 1) * GRID_GAP + 2 * PAD + extraW, containerW);
    return { min, max };
  }

  /**
   * Set the panel width to `px`, clamped to `getResizeBounds` and re-columned to match.
   * The re-column is O(pages), so call it once to commit a width, not on every drag-move.
   * @param {number} px
   * @returns {number} The applied (clamped) width.
   */
  function setWidth(px) {
    const { min, max } = getResizeBounds();
    const applied = Math.max(min, Math.min(max, px));
    panelElem.style.width = `${applied}px`;
    measureViewport();
    // Visible: reflow animates the column change.
    // Hidden: recompute geometry so the next reveal lands at the right columns, skipping the wasted off-screen mount and animation.
    if (visible) reflow(); else computeGeometry();
    return applied;
  }

  /**
   * Switch cell size between the docked desktop rail (THUMB_W) and the phone sheet's compact grid (COMPACT_W).
   * Call `refit` once the sheet is shown, to re-measure at its real width.
   * @param {boolean} on
   */
  function setCompact(on) {
    if (compact === on) return;
    compact = on;
    cellW = on ? COMPACT_W : THUMB_W;
    rowOverhead = on ? COMPACT_ROW_OVERHEAD : ROW_OVERHEAD;
    rowGap = on ? COMPACT_VGAP : GRID_GAP;
    panelElem.classList.toggle('scribe-thumb-compact', on);
    // Returning to the rail: shed the sheet's stretched width so the desktop rail opens at one column.
    if (!on) panelElem.style.width = `${cellW + PANEL_EXTRA_W}px`;
    measureViewport();
    computeGeometry();
    if (visible) updateWindow(true);
  }

  /**
   * Set the phone Pages-room interaction mode: 'browse' (read-only), 'edit' (selection + drag mutations), or null to restore the desktop/tablet gestures.
   * A mode flip tears down whatever the old mode had in flight (an open peek, a carried page, a menu).
   * @param {?('browse'|'edit')} mode
   */
  function setRoomMode(mode) {
    if (roomMode === mode) return;
    roomMode = mode;
    peekHide();
    reorder.cancelDrag();
    closeContextMenu();
    // The selection is scoped to a mode, so every flip clears it, entering or leaving.
    // The explicit updateBatchToolbar covers the nothing-to-clear case: bar and pill visibility key off roomMode.
    clearSelection();
    updateBatchToolbar();
  }

  /**
   * Re-measure and re-lay the grid for the panel's current container width, without the animated column flip.
   * Used when the panel is re-homed into the phone sheet (a full-width container the rail geometry didn't know about).
   */
  function refit() {
    measureViewport();
    computeGeometry();
    // Keep already-rastered rows: cell width never changes in a refit, so the cached bitmaps stay valid, and unmounting would flash the grid white on every sheet show.
    for (const [n, entry] of mounted) {
      if (n >= pageCount) unmountRow(n, entry);
      else restyleRow(entry, n);
    }
    if (visible) updateWindow(true);
  }

  // Drag the right-edge handle to resize the panel between one column (the docked rail) and MAX_COLS columns.
  // Thumbnail size is fixed, so the width only changes how many columns fit.
  let resizeStartX = 0;
  let resizeStartPanelW = 0;
  let resizeContainerW = 0;
  let resizeLivePanelW = 0;
  // The page pinned at drag start, plus its fractional position, so every reflow re-centers the same page.
  let resizeAnchorPage = -1;
  let resizeAnchorFrac = 0;
  // The panel's extra width (scrollbar gutter + padding + border) measured at drag start.
  let resizeExtraW = 0;

  /** @param {PointerEvent} event */
  function onResizeMove(event) {
    // The upper bound uses the measured extra width (resizeExtraW), not the PANEL_EXTRA_W estimate,
    // so the real scrollbar gutter decides whether the last column fits.
    const minPanelW = panelWidthForCols(1, cellW);
    const maxColsInnerW = MAX_COLS * cellW + (MAX_COLS - 1) * GRID_GAP + 2 * PAD;
    const maxPanelW = Math.min(maxColsInnerW + resizeExtraW, resizeContainerW);
    resizeLivePanelW = Math.max(minPanelW, Math.min(maxPanelW, resizeStartPanelW + (event.clientX - resizeStartX)));
    panelElem.style.width = `${resizeLivePanelW}px`;
    // The width just changed. Refresh the cache once here so reflow/gridColsFor/windowRange read it without each forcing a layout.
    measureViewport();
    reflow();
    if (onResize) onResize(resizeLivePanelW, 'move');
  }

  function onResizeEnd() {
    window.removeEventListener('pointermove', onResizeMove);
    window.removeEventListener('pointerup', onResizeEnd);
    window.removeEventListener('pointercancel', onResizeEnd);
    updateWindow(true);
    if (onResize) onResize(resizeLivePanelW, 'end');
  }

  resizeHandle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    resizeStartX = event.clientX;
    resizeStartPanelW = panelElem.getBoundingClientRect().width;
    resizeLivePanelW = resizeStartPanelW;
    resizeContainerW = (panelElem.parentElement && panelElem.parentElement.clientWidth) || resizeStartPanelW;
    measureViewport();
    resizeExtraW = resizeStartPanelW - viewportW;
    const centerY = scrollElem.scrollTop + viewportH / 2;
    resizeAnchorPage = activePage >= 0 && activePage < pageCount
      ? activePage
      : (pageCount > 0 ? rowAt(Math.max(0, centerY - PAD)) : -1);
    resizeAnchorFrac = resizeAnchorPage >= 0 && heights[resizeAnchorPage]
      ? Math.max(0, Math.min(1, (centerY - (PAD + offsets[resizeAnchorPage])) / heights[resizeAnchorPage])) : 0;
    if (onResize) onResize(resizeStartPanelW, 'start');
    window.addEventListener('pointermove', onResizeMove);
    window.addEventListener('pointerup', onResizeEnd);
    // The host stays in its drag regime until an 'end' report, so a canceled drag must deliver one too.
    window.addEventListener('pointercancel', onResizeEnd);
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
    // The geometry arrays span all pages, not just the mounted window, so the rect selects pages scrolled out of view.
    for (let n = 0; n < pageCount; n++) {
      if (lefts[n] < right && lefts[n] + cellW > l && PAD + offsets[n] < b && PAD + offsets[n] + boxHeights[n] > t) selected.add(n);
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
  // Right-clicking a gap between thumbnails (or the empty space) offers to paste or insert a file at that position.
  scrollElem.addEventListener('contextmenu', (e) => {
    if (!(scribe.opt && scribe.opt.enablePageEditing) || !scribe.doc) return;
    if (e.target instanceof Element && e.target.closest('.scribe-thumb-box')) return;
    e.preventDefault();
    openGapMenu(e.clientX, e.clientY);
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

  /**
   * Reflect an in-place insertion of `count` pages at index `at`: the rows at or after `at` shift down by `count` (reusing their already-decoded thumbnails),
   * the scroll position is kept, the new pages are mounted, and `activeN` stays highlighted.
   * Called after the document has already grown (e.g. by `pastePages`), so the rail re-lays in place instead of tearing down and re-rendering every row like `rebuild`.
   * The only visible change is the new pages.
   * @param {number} at
   * @param {number} count
   * @param {number} activeN - Page to keep current (index in the grown document).
   */
  function insertPagesAt(at, count, activeN) {
    if (count <= 0) return;
    cancelCut();
    const snapshot = [...mounted];
    mounted.clear();
    computeGeometry();
    activePage = activeN >= 0 && activeN < pageCount ? activeN : -1;
    remapSelection((s) => (s >= at ? s + count : s));
    for (const [oi, entry] of snapshot) {
      const ni = oi >= at ? oi + count : oi;
      restyleRow(entry, ni);
      mounted.set(ni, entry);
    }
    updateWindow();
    updateBatchToolbar();
  }

  /**
   * Re-key the current selection AND the shift-click anchor through `fn` (the same page-index remap an op applies to its rows), dropping anything that falls out of range.
   * Carrying `selAnchor` too keeps a later Shift-click extending from the right page after a delete/insert/reorder shifts indices.
   * Otherwise the anchor points at a stale page.
   * @param {(n: number) => number} fn
   */
  function remapSelection(fn) {
    const next = [...selected].map(fn).filter((n) => n >= 0 && n < pageCount);
    selected.clear();
    for (const n of next) selected.add(n);
    if (selAnchor >= 0) {
      const a = fn(selAnchor);
      selAnchor = (a >= 0 && a < pageCount) ? a : -1;
    }
  }

  /** Reflect the current selection on the mounted rows and refresh the batch bar. */
  function syncSelectionUI() {
    for (const [n, entry] of mounted) {
      entry.thumbElem.classList.toggle('selected', selected.has(n));
      const chk = entry.thumbElem.querySelector('.scribe-thumb-chk');
      if (chk) chk.setAttribute('aria-checked', String(selected.has(n)));
    }
    // While anything is selected, CSS (scoped to the room's Edit grid) demotes the active-page ring to a neutral hairline, so accent means exactly one thing there: selected.
    panelElem.classList.toggle('scribe-thumb-hassel', selected.size > 0);
    updateBatchToolbar();
  }

  /** Show the floating batch strip only while the rail is visible with 2+ pages selected, and place it by the selection. */
  function updateBatchToolbar() {
    // In the phone room the floating selection bar is the batch surface; the desktop pill stands down.
    const show = visible && !roomMode && selected.size >= 2;
    batchCount.textContent = String(selected.size);
    batchBar.style.display = show ? '' : 'none';
    // Dropping below 2 selected clears the frozen anchor, so the next 2+ selection re-freezes at the row nearest center.
    if (selected.size < 2) batchAnchorClientY = null;
    if (show) positionBatchBar();
    roomBarCount.textContent = `${selected.size} selected`;
    roomBar.classList.toggle('on', roomMode === 'edit' && selected.size > 0);
  }

  /**
   * Place the batch strip beside the rail, clamped into the scroll viewport.
   * The vertical position is frozen once (`batchAnchorClientY`); only the horizontal edge tracks the panel afterward.
   * Grid mode pins it inside the panel's right edge, since 'just right of the thumbnail' would fall between columns; the single-column rail puts it just right of the panel.
   */
  function positionBatchBar() {
    if (selected.size < 2) return;
    const hostRect = batchHost.getBoundingClientRect();
    const panelRect = panelElem.getBoundingClientRect();
    const scrollRect = scrollElem.getBoundingClientRect();
    const barH = batchBar.offsetHeight || BATCH_BAR_H;
    const barW = batchBar.offsetWidth || BATCH_BAR_H;
    // Freeze the vertical position once, at the client-space row center of the selected page nearest the viewport center.
    if (batchAnchorClientY === null) {
      const viewMidY = (scrollRect.top + scrollRect.bottom) / 2;
      let bestY = 0;
      let bestDist = Infinity;
      for (const n of selected) {
        const rowCenterY = scrollRect.top + PAD + offsets[n] + heights[n] / 2 - scrollElem.scrollTop;
        const dist = Math.abs(rowCenterY - viewMidY);
        if (dist < bestDist) { bestDist = dist; bestY = rowCenterY; }
      }
      batchAnchorClientY = bestY;
    }
    const centerY = Math.max(scrollRect.top + barH / 2 + 6, Math.min(batchAnchorClientY, scrollRect.bottom - barH / 2 - 6));
    const left = layoutMode === 'grid'
      ? scrollRect.right - hostRect.left - barW - 14
      : panelRect.right - hostRect.left + 8;
    batchBar.style.left = `${left}px`;
    batchBar.style.top = `${centerY - hostRect.top - barH / 2}px`;
  }

  /** Clear the selection and refresh the UI. */
  function clearSelection() {
    if (selected.size === 0) return;
    selected.clear();
    syncSelectionUI();
  }

  /**
   * Capture every page's on-screen position keyed by page identity, ahead of a structure change that fully rebuilds the grid (the room Revert's undo unwind).
   * The returned player, invoked after the rebuild, restores the scroll and replays the change in the grid's reorder language.
   * @returns {() => void}
   */
  function beginStructureSlide() {
    const doc = scribe.doc;
    if (!doc) return () => {};
    const sRect = scrollElem.getBoundingClientRect();
    const scrollBefore = scrollElem.scrollTop;
    // Identity is the page's sourceId:sourcePageN pair, not the pageMetrics object: undo snapshots structuredClone the metrics, so object identity does not survive an unwind.
    // Null fields keep the container's semantics: null sourcePageN means the current index, null sourceId means the primary source.
    // They are materialized only by the first order edit, so unwinding a document's first session restores nulls, and reading them raw would orphan every page.
    const idOf = (d, pm, n) => {
      if (!pm) return null;
      const sid = pm.sourceId ?? (d.images ? d.images.primarySourceId : null) ?? 'doc';
      return `${sid}:${pm.sourcePageN ?? n}`;
    };
    /** @type {Map<string, ?{left: number, top: number}>} null = duplicated key, never animate it */
    const before = new Map();
    /** @type {string[]} pre-change identity order, for the moved-vs-displaced split */
    const orderBefore = [];
    // Positions from layout geometry, not DOM rects, so movers crossing the mounted window's edge still get correct endpoints.
    for (let n = 0; n < pageCount; n += 1) {
      const key = idOf(doc, doc.pageMetrics[n], n);
      if (!key) continue;
      orderBefore.push(key);
      before.set(key, before.has(key) ? null : {
        left: sRect.left + lefts[n], top: sRect.top + PAD + offsets[n] - scrollBefore,
      });
    }
    // On-screen image boxes: flight starts for movers, and the only surviving pixels for pages the change removes.
    // Their <img> elements are adopted at play time, not cloned: the remount revokes unmounted thumbnails' object URLs, and a clone would re-fetch the dead URL and paint white.
    /** @type {Map<string, {rect: DOMRect, img: HTMLImageElement}>} */
    const visBefore = new Map();
    for (const [n, entry] of mounted) {
      const key = idOf(doc, doc.pageMetrics[n], n);
      if (!key || before.get(key) === null || !entry.imgElem) continue;
      const box = entry.imgElem.parentElement;
      if (box) visBefore.set(key, { rect: box.getBoundingClientRect(), img: entry.imgElem });
    }
    return () => {
      scrollElem.scrollTop = scrollBefore;
      updateWindow(true);
      const doc2 = scribe.doc;
      if (!doc2) return;

      /** @type {Map<string, number>} identity -> page index after the change */
      const afterIndex = new Map();
      for (let n = 0; n < doc2.pageMetrics.length; n += 1) {
        const key = idOf(doc2, doc2.pageMetrics[n], n);
        if (key && before.has(key) && before.get(key) !== null && !afterIndex.has(key)) afterIndex.set(key, n);
      }
      const travelers = new Set();
      const seq = orderBefore.filter((k) => afterIndex.has(k));
      if (seq.length && seq.length <= 2000) {
        const tailVal = [];
        const tailIdx = [];
        const parent = new Array(seq.length).fill(-1);
        for (let i = 0; i < seq.length; i += 1) {
          const v = afterIndex.get(seq[i]);
          let lo = 0;
          let hi = tailVal.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (tailVal[mid] < v) lo = mid + 1; else hi = mid;
          }
          tailVal[lo] = v;
          tailIdx[lo] = i;
          parent[i] = lo > 0 ? tailIdx[lo - 1] : -1;
        }
        const crowd = new Set();
        for (let i = tailVal.length ? tailIdx[tailVal.length - 1] : -1; i >= 0; i = parent[i]) crowd.add(i);
        for (let i = 0; i < seq.length; i += 1) { if (!crowd.has(i)) travelers.add(seq[i]); }
      }
      // Displaced slides longer than this grow in instead.
      const maxHop = scrollElem.clientHeight * 2;
      const sRect2 = scrollElem.getBoundingClientRect();
      const movers = [];
      const grown = [];
      /** @type {Array<{img: ?HTMLImageElement, adopt: ?HTMLImageElement, from: {left: number, top: number}, dest: {left: number, top: number, width: number, height: number}, el: ?HTMLElement}>} */
      const flights = [];
      /** @type {Array<{rect: DOMRect, img: HTMLImageElement}>} */
      const shrinks = [];
      const onScreen = new Set();
      for (const [n, entry] of mounted) {
        const key = idOf(doc2, doc2.pageMetrics[n], n);
        if (key) onScreen.add(key);
        const was = key ? before.get(key) : null;
        const el = entry.thumbElem;
        if (!was) { grown.push(el); continue; } // restored by the revert (or unidentifiable): grow in
        const box = entry.imgElem && entry.imgElem.parentElement;
        if (key && travelers.has(key) && box) {
          const dest = box.getBoundingClientRect();
          if (dest.width) {
            // Flight start: the on-screen box if it was visible, else the old slot's geometry.
            // The copy adopts the detached pre-change <img>. When the remount reused that element for another page, fall back to the fresh row's image.
            const src = visBefore.get(key);
            const from = src ? src.rect : { left: was.left, top: was.top };
            if (Math.abs(from.left - dest.left) > 0.5 || Math.abs(from.top - dest.top) > 0.5) {
              flights.push({
                img: entry.imgElem,
                adopt: src && !src.img.isConnected ? src.img : null,
                from,
                dest,
                el,
              });
            }
            continue;
          }
        }
        const now = el.getBoundingClientRect();
        const dx = was.left - now.left;
        const dy = was.top - now.top;
        if (!dx && !dy) continue;
        if (Math.hypot(dx, dy) > maxHop) { grown.push(el); continue; }
        movers.push({ el, dx, dy });
      }
      // Movers whose destination fell outside the mounted window fly off toward it; pages with no destination were removed and shrink out where they stood.
      // A source <img> still connected means the remount reused its row for another page: skip the visual.
      for (const [key, src] of visBefore) {
        if (onScreen.has(key) || src.img.isConnected) continue;
        const n2 = afterIndex.get(key);
        if (n2 !== undefined && travelers.has(key)) {
          flights.push({
            img: null,
            adopt: src.img,
            from: src.rect,
            dest: {
              left: sRect2.left + lefts[n2],
              top: sRect2.top + PAD + offsets[n2] - scrollElem.scrollTop,
              width: src.rect.width,
              height: src.rect.height,
            },
            el: null,
          });
        } else if (n2 === undefined) {
          shrinks.push(src);
        }
      }
      if (!movers.length && !grown.length && !flights.length && !shrinks.length) return;
      /** @type {HTMLElement[]} */
      const clones = [];
      /** @type {HTMLElement[]} */
      const shrinkClones = [];
      /** @type {HTMLElement[]} */
      const hiddenRows = [];
      // Lifted copies in dealRows' exact grammar: fixed on document.body, sized to the destination, translated back to the flight start, capped the same way (pages beyond just appear).
      const FLY_CAP = 24;
      flights.slice(0, FLY_CAP).forEach((f, i) => {
        const clone = document.createElement('div');
        clone.style.cssText = 'position:fixed;margin:0;overflow:hidden;background:#fff;border-radius:2px;'
          + `box-shadow:0 8px 22px rgba(0,0,0,.45);pointer-events:none;z-index:${9999 - i};`
          + `left:${f.dest.left}px;top:${f.dest.top}px;width:${f.dest.width}px;height:${f.dest.height}px;`
          + `transform:translate(${f.from.left - f.dest.left}px,${f.from.top - f.dest.top}px)`;
        const img = f.adopt || /** @type {HTMLImageElement} */ (f.img.cloneNode(true));
        if (!img.style.width) { img.style.width = '100%'; img.style.height = '100%'; }
        img.style.objectFit = 'contain';
        img.style.display = 'block';
        clone.appendChild(img);
        document.body.appendChild(clone);
        clones.push(clone);
        if (f.el) { f.el.style.opacity = '0'; hiddenRows.push(f.el); }
      });
      for (const src of shrinks) {
        const clone = document.createElement('div');
        clone.style.cssText = 'position:fixed;margin:0;overflow:hidden;background:#fff;border-radius:2px;'
          + 'box-shadow:0 1px 3px rgba(0,0,0,.2);pointer-events:none;z-index:9998;'
          + `left:${src.rect.left}px;top:${src.rect.top}px;width:${src.rect.width}px;height:${src.rect.height}px;`;
        const img = src.img;
        if (!img.style.width) { img.style.width = '100%'; img.style.height = '100%'; }
        img.style.objectFit = 'contain';
        img.style.display = 'block';
        clone.appendChild(img);
        document.body.appendChild(clone);
        shrinkClones.push(clone);
      }
      for (const m of movers) {
        m.el.style.transition = 'none';
        m.el.style.transform = `translate(${m.dx}px, ${m.dy}px)`;
      }
      for (const el of grown) {
        el.style.transition = 'none';
        el.style.transform = 'scale(.55)';
        el.style.opacity = '0';
      }
      scrollElem.getBoundingClientRect(); // commit the start frame before the transitions arm
      requestAnimationFrame(() => {
        for (const m of movers) {
          m.el.style.transition = `transform ${REORDER_SLIDE_MS}ms ease`;
          m.el.style.transform = '';
        }
        for (const el of grown) {
          el.style.transition = 'transform .16s ease, opacity .16s ease';
          el.style.transform = '';
          el.style.opacity = '';
        }
        for (const clone of clones) {
          clone.style.transition = `transform ${REORDER_SLIDE_MS}ms ease`;
          clone.style.transform = 'translate(0, 0)';
        }
        for (const clone of shrinkClones) {
          clone.style.transition = 'transform .16s ease, opacity .16s ease';
          clone.style.transform = 'scale(.55)';
          clone.style.opacity = '0';
        }
        setTimeout(() => {
          for (const m of movers) m.el.style.transition = '';
          for (const el of grown) el.style.transition = '';
          for (const el of hiddenRows) el.style.opacity = '';
          for (const clone of clones) clone.remove();
          for (const clone of shrinkClones) clone.remove();
        }, REORDER_SLIDE_MS + 20);
      });
    };
  }

  /** Toggle page `n` in the room-Edit selection (the tap-anywhere-on-the-page gesture). @param {number} n */
  function toggleRoomSelect(n) {
    if (selected.has(n)) selected.delete(n); else selected.add(n);
    selAnchor = n;
    syncSelectionUI();
  }

  /**
   * Set page `n`'s selection to `want`, for the checkbox range paint: painting to the starting toggle's state means a slide never flip-flops.
   * @param {number} n @param {boolean} want
   */
  function setRoomSelect(n, want) {
    if (selected.has(n) === want) return;
    if (want) selected.add(n); else selected.delete(n);
    syncSelectionUI();
  }

  // The `.scribe-thumb` currently marked as the right-click target (highlighted while its context menu is open), or null.
  /** @type {?HTMLElement} */
  let contextTargetElem = null;

  /** Clear both right-click affordances: the target page's highlight (page menu) and the gap insertion line (gap menu). */
  function clearContextHighlight() {
    if (contextTargetElem) { contextTargetElem.classList.remove('context'); contextTargetElem = null; }
    dropIndicator.hide();
  }

  /** Hide the page context menu if it is open. */
  function closeContextMenu() {
    menuElem.style.display = 'none';
    clearContextHighlight();
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
    // Mark the right-clicked page so it is visibly the menu's target.
    clearContextHighlight();
    const targetEntry = mounted.get(n);
    if (targetEntry) { targetEntry.thumbElem.classList.add('context'); contextTargetElem = targetEntry.thumbElem; }
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
    if (canPaste()) addItem('Paste after this page', false, () => pasteAt(n + 1));
    if (onInsertFromFile) addItem('Insert file after this page', false, () => onInsertFromFile(n + 1));
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

  /**
   * Context menu for the rail's gaps and empty space: paste or insert a file at the position under the cursor.
   * A right-click between two pages therefore inserts there, not at the end.
   * The insertion line marks that gap (the "here" the items refer to) for as long as the menu is open, which also tells the user they clicked a gap rather than a page.
   * @param {number} clientX
   * @param {number} clientY
   */
  function openGapMenu(clientX, clientY) {
    if (!(scribe.opt && scribe.opt.enablePageEditing) || !scribe.doc) return;
    clearContextHighlight();
    const gap = dropIndicator.show(clientX, clientY);
    menuElem.replaceChildren();
    /** @param {string} label @param {() => void} fn */
    const addItem = (label, fn) => {
      const item = document.createElement('div');
      item.className = 'scribe-thumb-menu-item';
      item.textContent = label;
      item.addEventListener('click', () => { closeContextMenu(); fn(); });
      menuElem.appendChild(item);
    };
    if (canPaste()) addItem('Paste here', () => pasteAt(gap));
    if (onInsertFromFile) addItem('Insert file here', () => onInsertFromFile(gap));
    if (!menuElem.firstChild) { clearContextHighlight(); return; } // nothing to offer at this gap

    menuElem.style.display = '';
    const hostRect = batchHost.getBoundingClientRect();
    const left = Math.min(clientX - hostRect.left, hostRect.width - menuElem.offsetWidth - 4);
    const top = Math.min(clientY - hostRect.top, hostRect.height - menuElem.offsetHeight - 4);
    menuElem.style.left = `${Math.max(4, left)}px`;
    menuElem.style.top = `${Math.max(4, top)}px`;
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
    if (e.shiftKey && (selAnchor >= 0 || activePage >= 0)) {
      // Fall back to the on-screen page so a Shift-click extends a range even before any thumbnail has set an anchor.
      const pivot = selAnchor >= 0 ? selAnchor : activePage;
      const lo = Math.min(pivot, n);
      const hi = Math.max(pivot, n);
      selected.clear();
      for (let i = lo; i <= hi; i++) selected.add(i);
      selAnchor = pivot;
      syncSelectionUI();
      if (onSelect) onSelect(n);
    } else if (e.ctrlKey || e.metaKey) {
      // Seed the batch with the current on-screen page so the first Ctrl-add keeps both pages instead of only the new one.
      const seed = activePage >= 0 ? activePage : selAnchor;
      if (selected.size === 0 && seed >= 0 && seed < pageCount && seed !== n) selected.add(seed);
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
    selAnchor = -1; // The anchor page may be among those deleted, so a later Shift-click should re-anchor rather than extend from a stale index.

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
   * A cut marks the originals for removal on paste and dims them.
   * A copy leaves them in place.
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

  /**
   * Whether the clipboard's pages can be pasted into the current document.
   * A copy can paste into any open document, but a cut only into its source document, since its paste removes the originals.
   * @returns {boolean}
   */
  function canPaste() {
    if (!scribe.doc || pageClipboard.payloads.length === 0) return false;
    if (pageClipboard.mode === 'cut') return pageClipboard.sourceDocId === scribe.doc.id;
    return true;
  }

  /**
   * Paste the clipboard's pages as a contiguous block at `insertIndex`.
   * A copy is a pure insertion, as calm as an insert-from-file drop: the reader keeps their page,
   * the rail scroll stays put, and nothing is auto-selected, so the only visible change is the new pages appearing at `insertIndex`.
   * A cut is a move: it also removes the source rows, re-lays the rail, and lands on and selects the relocated block.
   * A cut is consumed (the clipboard is cleared), but a copy can be pasted again.
   * @param {number} insertIndex
   */
  function pasteAt(insertIndex) {
    if (!canPaste()) return;
    const wasCut = pageClipboard.mode === 'cut';
    const range = scribe.pastePages(
      pageClipboard.payloads,
      insertIndex,
      wasCut ? { removeSourceIndices: [...pageClipboard.sourceIndices] } : { keepCurrentPage: true },
    );
    if (wasCut) clearPageClipboard();
    cutMarks.clear();
    if (!range) return;
    if (wasCut) {
      // A cut is a move: land on and select the relocated block, matching the intent of moving pages.
      rebuild(range.start);
      for (let i = range.start; i < range.start + range.count; i++) selected.add(i);
      selAnchor = range.start;
      syncSelectionUI();
    } else {
      // A copy is a pure insertion, so keep the reader on their page: insertPagesAt gets range.cp
      // because the viewer's own state.cp.n is stale here while the rebuild's displayPage is still async.
      // Clear the selection because insertPagesAt shifts the pre-paste selection up by the inserted block,
      // so without this the accent ring would stay on the originals at their new indices, reading as if those pages had moved.
      insertPagesAt(range.start, range.count, range.cp);
      selected.clear();
      selAnchor = -1;
      syncSelectionUI();
    }
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
      // The rail is idle, so drop its focus hint and stop skewing the scheduler's background order.
      reportThumbFocus(null);
      hideTimer = setTimeout(() => { hideTimer = null; clearMounted(); }, SLIDE_MS);
    }
    // The batch strip lives outside the panel, so it does not slide with it; show/hide it with the rail.
    updateBatchToolbar();
    // The document insets to the panel when shown, and reclaims the space when hidden.
    notifyResize();
  }

  /**
   * Keyboard handler for the thumbnail rail, active only while focus is within the panel.
   * Arrow keys navigate the grid visually: left/right step one page, and up/down move by a full row (`gridCols` pages).
   * Home/End jump to the ends.
   * Each move mirrors a plain thumbnail click, or with Shift extends the batch selection from the anchor.
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
    const rowStep = gridCols;
    let target;
    if (e.key === 'ArrowRight') target = Math.min(cur + 1, pageCount - 1);
    else if (e.key === 'ArrowLeft') target = Math.max(cur - 1, 0);
    else if (e.key === 'ArrowDown') target = Math.min(cur + rowStep, pageCount - 1);
    else if (e.key === 'ArrowUp') target = Math.max(cur - rowStep, 0);
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
   * @param {PointerEvent} e
   */
  function onOutsidePointerDown(e) {
    if (selected.size === 0) return;
    const t = e.target;
    if (t instanceof Element && t.closest('.scribe-thumb-scroll, .scribe-thumb-batch, .scribe-thumb-selbar, .scribe-thumb-menu, .scribe-thumb-resize')) return;
    clearSelection();
  }
  batchHost.addEventListener('pointerdown', onOutsidePointerDown);

  // An Edit-mode tap on the scroll area's empty space clears the selection: putting one down must not require aiming at a control.
  // The target is checked at pointerdown because a page press's later events retarget to the scroll element once the reorder system takes pointer capture.
  /** @type {?{x: number, y: number, t: number, scroll: number}} */
  let voidTap = null;
  scrollElem.addEventListener('pointerdown', (e) => {
    voidTap = null;
    if (roomMode !== 'edit' || selected.size === 0) return;
    const t = e.target;
    if (t instanceof Element && t.closest('.scribe-thumb')) return;
    voidTap = {
      x: e.clientX, y: e.clientY, t: Date.now(), scroll: scrollElem.scrollTop,
    };
  }, { passive: true });
  scrollElem.addEventListener('pointerup', (e) => {
    const v = voidTap;
    voidTap = null;
    if (!v || roomMode !== 'edit') return;
    if (Date.now() - v.t > 350) return;
    if (Math.hypot(e.clientX - v.x, e.clientY - v.y) > 8) return;
    if (Math.abs(scrollElem.scrollTop - v.scroll) > 1) return;
    clearSelection();
  }, { passive: true });

  /**
   * Batch keyboard actions on the current selection: Delete/Backspace removes the selected pages, Escape clears the selection.
   * The handler is inert while the panel is hidden.
   * Delete/Backspace are additionally ignored when nothing is selected or focus is in a text field.
   * @param {KeyboardEvent} e
   */
  function onKeyDown(e) {
    if (!visible) return;
    const t = /** @type {?HTMLElement} */ (e.target);
    const inEditable = !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable));
    // Select every page (Ctrl/Cmd+A) while the rail is the open sidebar, overriding the browser's page-wide select-all.
    if (!inEditable && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a' && scribe.opt.keyboardScope !== 'off') {
      e.preventDefault();
      selected.clear();
      for (let i = 0; i < pageCount; i += 1) selected.add(i);
      selAnchor = pageCount - 1;
      syncSelectionUI();
      return;
    }
    if (e.key === 'Escape') { closeContextMenu(); clearSelection(); return; }
    if (selected.size === 0 || inEditable) return;
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
    if (scribe.onAnnotationsRendered === onAnnotationsRendered) scribe.onAnnotationsRendered = null;
    reportThumbFocus(null);
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
    peekHide();
    if (peekCrispUrl) { URL.revokeObjectURL(peekCrispUrl); peekCrispUrl = null; }
    panelElem.removeEventListener('keydown', onPanelKeyDown);
    batchHost.removeEventListener('pointerdown', onOutsidePointerDown);
    document.removeEventListener('keydown', onKeyDown);
    clearMounted();
    dropIndicator.hide();
    batchBar.remove();
    menuElem.remove();
    panelElem.replaceChildren();
  }

  // Repaint an already-mounted thumbnail when its page's highlights or redactions change; rows mounted later get them from `restyleRow`.
  const onAnnotationsRendered = (n) => {
    const entry = mounted.get(n);
    if (entry) restyleRow(entry, n);
  };
  scribe.onAnnotationsRendered = onAnnotationsRendered;

  /**
   * Snapshot of the current grid layout for the phone pull-up morph, which places stand-in cells where the real thumbnails will sit once the Pages room settles.
   * Positions are relative to the scroll content (subtract scrollTop for viewport y) and locate the white image box itself, padding included.
   * Reflects the last computeGeometry, so call after `refit` when the panel was just re-homed.
   */
  function gridGeometry() {
    const boxPadTop = compact ? 3 : 6;
    return {
      count: pageCount,
      cols: gridCols,
      cellW,
      pad: PAD,
      strideX: pageCount > 1 && gridCols > 1 ? lefts[1] - lefts[0] : cellW + GRID_GAP,
      /** @param {number} n */ boxLeft: (n) => lefts[n] + 4,
      /** @param {number} n */ boxTop: (n) => PAD + offsets[n] + boxPadTop,
      /** @param {number} n */ boxH: (n) => boxHeights[n],
      /** @param {number} n */ thumbTop: (n) => PAD + offsets[n],
    };
  }

  return {
    panelElem,
    toggleElem,
    rebuild,
    cancelCut,
    setActive,
    setVisible,
    setWidth,
    setCompact,
    setRoomMode,
    clearSelection,
    beginStructureSlide,
    refit,
    getResizeBounds,
    gridGeometry,
    dropIndicator,
    insertPagesAt,
    destroy,
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
