// Page-area frame elements shared by the viewer and editor apps: the page-thumbnails rail and the custom overlay scrollbars.
// Both are positioned over the viewer and driven by the stage.
import { makeIconButton } from './toolbar.js';

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

// Default-Letter aspect (height/width) for rows whose page metrics are unavailable.
const DEFAULT_ASPECT = 11 / 8.5;
// Per-row overhead around the image box: vertical padding + gap + label, in px (matches controlStyles).
const ROW_OVERHEAD = 28;
// Panel top padding in px (matches controlStyles `.scribe-thumb-panel`), the offset of row 0.
const PAD = 8;
// Extra px mounted above and below the viewport so scrolling reveals ready rows, not blanks.
const BUFFER = 600;
// Wait this long after the last scroll before fetching thumbnails, so a fling skips the rows it passes.
const RENDER_DEBOUNCE_MS = 120;
// Panel width beyond the thumbnail image: horizontal padding plus room for the panel's own scrollbar.
const PANEL_EXTRA_W = 30;
// Bounds for the user-draggable thumbnail image width (panel width is this plus PANEL_EXTRA_W).
const MIN_IMG_W = 90;
const MAX_IMG_W = 300;
// Slide duration in ms. Must match the `transition` on `.scribe-thumb-panel` so the post-hide unmount waits for it.
const SLIDE_MS = 180;

/**
 * Build the page-thumbnails panel and its toolbar toggle.
 * @param {import('../../viewer.js').ScribeViewer} scribe
 * @param {object} cfg
 * @param {number} [cfg.width=150] - Thumbnail image width in px.
 * @param {(n: number) => void} cfg.onSelect - Called with the page index when a thumbnail is clicked.
 * @returns {{
 *   panelElem: HTMLDivElement, toggleElem: HTMLSpanElement,
 *   rebuild: () => void, setActive: (n: number) => void,
 *   setVisible: (v: boolean) => void, destroy: () => void
 * }}
 */
export function createThumbnailPanel(scribe, { width = 150, onSelect }) {
  let THUMB_W = Math.max(MIN_IMG_W, Math.min(MAX_IMG_W, width));

  const panelElem = document.createElement('div');
  panelElem.className = 'scribe-thumb-panel';
  panelElem.style.width = `${THUMB_W + PANEL_EXTRA_W}px`;

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
  let destroyed = false;
  let rafPending = false;
  /** @type {?ReturnType<typeof setTimeout>} */
  let renderTimer = null;
  // Deferred unmount after a slide-out, so rows stay visible for the duration of the hide animation.
  /** @type {?ReturnType<typeof setTimeout>} */
  let hideTimer = null;

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
   * Create and place the DOM for row `n` (image fills in later, on a debounced render pass).
   * @param {number} n
   */
  function mountRow(n) {
    const thumbElem = document.createElement('div');
    thumbElem.className = 'scribe-thumb';
    thumbElem.style.position = 'absolute';
    thumbElem.style.left = '0';
    thumbElem.style.right = '0';
    thumbElem.style.top = `${PAD + offsets[n]}px`;
    thumbElem.style.height = `${heights[n]}px`;
    thumbElem.dataset.page = String(n);
    if (n === activePage) thumbElem.classList.add('active');

    const boxElem = document.createElement('div');
    boxElem.className = 'scribe-thumb-box';
    boxElem.style.width = `${THUMB_W}px`;
    boxElem.style.height = `${boxHeights[n]}px`;

    const imgElem = document.createElement('img');
    imgElem.alt = '';
    imgElem.draggable = false;
    // The thumbnail is cached at the page's original orientation, so the user rotation is applied as a CSS transform.
    // For a 90/270 rotation the box's width and height are swapped, so the image is sized to those transposed dimensions
    // and rotated to fill the box (object-fit: contain keeps the page aspect exact).
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
    boxElem.appendChild(imgElem);

    const labelElem = document.createElement('div');
    labelElem.className = 'scribe-thumb-label';
    labelElem.textContent = String(n + 1);

    const rotateBtn = document.createElement('span');
    rotateBtn.className = 'scribe-thumb-rotate';
    rotateBtn.title = 'Rotate right';
    rotateBtn.innerHTML = ROTATE_SVG;
    rotateBtn.addEventListener('click', (e) => { e.stopPropagation(); onRotate(n); });

    boxElem.appendChild(rotateBtn);
    boxElem.addEventListener('click', () => { if (onSelect) onSelect(n); });

    thumbElem.appendChild(boxElem);
    thumbElem.appendChild(labelElem);

    scrollElem.appendChild(thumbElem);
    mounted.set(n, {
      thumbElem, imgElem, url: null, pending: false,
    });
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

  /** After scrolling settles, request thumbnails for the mounted rows that still lack one. */
  function scheduleRenders() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      if (destroyed || !visible) return;
      for (const [n, entry] of mounted) {
        if (!entry.url && !entry.pending) requestRender(n, entry);
      }
    }, RENDER_DEBOUNCE_MS);
  }

  /** Mount the rows in the current scroll window (+buffer), unmount the rest, then queue renders. */
  function updateWindow() {
    if (destroyed || !visible || pageCount === 0) return;
    const viewH = scrollElem.clientHeight;
    const first = rowAt(Math.max(0, scrollElem.scrollTop - PAD - BUFFER));
    const last = rowAt(Math.max(0, scrollElem.scrollTop - PAD + viewH + BUFFER));
    for (const [n, entry] of mounted) {
      if (n < first || n > last) unmountRow(n, entry);
    }
    for (let n = first; n <= last; n++) {
      if (!mounted.has(n)) mountRow(n);
    }
    scheduleRenders();
  }

  function onScroll() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; updateWindow(); });
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

  /** Rebuild the panel for the current document: recompute row geometry and mount the top window. */
  function rebuild() {
    generation += 1;
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
    clearMounted();
    activePage = -1;
    computeGeometry();
    scrollElem.scrollTop = 0;
    updateWindow();
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
    updateWindow();
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
   * Rotate page `n` 90 degrees clockwise from its thumbnail, then rebuild the panel geometry, preserving the scroll position.
   * @param {number} n
   */
  function onRotate(n) {
    scribe.rotatePage(n, 90);
    const keepScroll = scrollElem.scrollTop;
    rebuild();
    scrollElem.scrollTop = keepScroll;
    updateWindow();
  }

  /**
   * Mark page `n` as current (highlight + scroll into the panel view if off-screen).
   * @param {number} n
   */
  function setActive(n) {
    if (n === activePage) return;
    const prev = mounted.get(activePage);
    if (prev) prev.thumbElem.classList.remove('active');
    activePage = n;
    const cur = mounted.get(n);
    if (cur) cur.thumbElem.classList.add('active');
    if (!visible || pageCount === 0 || !heights[n]) return;

    // Set scrollTop directly rather than scrollIntoView, which could also scroll an ancestor or the document.
    const top = offsets[n];
    const bottom = top + heights[n];
    const viewTop = scrollElem.scrollTop - PAD;
    const viewBottom = viewTop + scrollElem.clientHeight;
    if (top < viewTop) scrollElem.scrollTop = Math.max(0, top + PAD - 8);
    else if (bottom > viewBottom) scrollElem.scrollTop = bottom + PAD - scrollElem.clientHeight + 8;
    updateWindow();
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
      updateWindow();
    } else {
      panelElem.style.transform = 'translateX(-100%)';
      generation += 1;
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
      hideTimer = setTimeout(() => { hideTimer = null; clearMounted(); }, SLIDE_MS);
    }
  }

  /** Tear down: unmount all rows, cancel pending renders, and drop the DOM. */
  function destroy() {
    destroyed = true;
    generation += 1;
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    clearMounted();
    panelElem.replaceChildren();
  }

  return {
    panelElem, toggleElem, rebuild, setActive, setVisible, destroy,
  };
}

/**
 * Build and install overlay scrollbars inside `viewerContainer`, driven by `scribe`'s stage.
 * @param {import('../../viewer.js').ScribeViewer} scribe
 * @param {HTMLElement} viewerContainer - The positioned element the tracks are appended to.
 * @returns {{ updateScrollbars: () => void }}
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
   * Compute scrollbar geometry for one axis from the current stage transform and document extent.
   * @param {'x'|'y'} axis
   * @param {boolean} otherVisible - Whether the perpendicular scrollbar is showing (shortens this track).
   * @returns {?{visible: boolean, trackPx: number, thumbPx: number, startPx: number, lo: number, hi: number, range: number, scale: number}}
   */
  function scrollGeometry(axis, otherVisible) {
    const { stage } = scribe;
    const pageMetrics = scribe.doc && scribe.doc.pageMetrics;
    if (!stage || !pageMetrics || pageMetrics.length === 0) return null;

    const scale = stage.getAbsoluteScale().y || 1;
    const barSize = 12;
    const minThumb = 24;

    let viewportPx;
    let stagePos;
    let lo;
    let hi;
    if (axis === 'y') {
      viewportPx = stage.height();
      stagePos = stage.y();
      lo = scribe.getPageStop(0) - 100;
      hi = scribe.getPageStop(pageMetrics.length - 1, false);
    } else {
      viewportPx = stage.width();
      stagePos = stage.x();
      const dims = pageMetrics[scribe.state.cp.n] && pageMetrics[scribe.state.cp.n].dims;
      if (!dims) return null;
      lo = 0;
      hi = dims.width;
    }

    const visible = hi * scale > viewportPx + 0.5;
    const trackPx = Math.max(0, viewportPx - (otherVisible ? barSize : 0));
    const range = hi - lo;
    const metric = (stagePos - viewportPx / 2) / scale * -1;
    const viewLen = viewportPx / scale;
    const thumbPx = Math.min(trackPx, Math.max(minThumb, (viewLen / (range + viewLen)) * trackPx));
    const posFrac = range > 0 ? Math.min(1, Math.max(0, (metric - lo) / range)) : 0;
    const startPx = posFrac * (trackPx - thumbPx);

    return {
      visible, trackPx, thumbPx, startPx, lo, hi, range, scale,
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
      const metric = geom.lo + posFrac * geom.range;
      const viewportPx = axis === 'y' ? scribe.stage.height() : scribe.stage.width();
      const stagePos = axis === 'y' ? scribe.stage.y() : scribe.stage.x();
      const delta = (viewportPx / 2 - metric * geom.scale) - stagePos;
      scribe.panStage(axis === 'y' ? { deltaY: delta } : { deltaX: delta });
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
      const viewportPx = axis === 'y' ? scribe.stage.height() : scribe.stage.width();
      const delta = client < trackStart + thumbStart ? viewportPx * 0.9 : viewportPx * -0.9;
      scribe.panStage(axis === 'y' ? { deltaY: delta } : { deltaX: delta });
      event.preventDefault();
    });
  }

  /** Reposition and show/hide both overlay scrollbars to match the current stage transform. */
  function updateScrollbars() {
    if (!scribe.stage) return;
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

  scribe.stage.on('xChange yChange scaleXChange scaleYChange', () => updateScrollbars());
  updateScrollbars();

  return { updateScrollbars };
}
