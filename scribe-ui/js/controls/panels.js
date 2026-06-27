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
  const THUMB_W = width;

  const panelElem = document.createElement('div');
  panelElem.className = 'scribe-thumb-panel';

  // Full-height filler that gives the panel its scrollable height. Rows are layered over it.
  const spacer = document.createElement('div');
  spacer.style.width = '1px';
  spacer.style.height = '0px';
  panelElem.appendChild(spacer);

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
    boxElem.appendChild(imgElem);

    const labelElem = document.createElement('div');
    labelElem.className = 'scribe-thumb-label';
    labelElem.textContent = String(n + 1);

    thumbElem.appendChild(boxElem);
    thumbElem.appendChild(labelElem);
    thumbElem.addEventListener('click', () => { if (onSelect) onSelect(n); });

    panelElem.appendChild(thumbElem);
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
    doc.images.renderThumbnail(n, THUMB_W).then((blob) => {
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
    const viewH = panelElem.clientHeight;
    const first = rowAt(Math.max(0, panelElem.scrollTop - PAD - BUFFER));
    const last = rowAt(Math.max(0, panelElem.scrollTop - PAD + viewH + BUFFER));
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
  panelElem.addEventListener('scroll', onScroll);

  /** Rebuild the panel for the current document: recompute row geometry and mount the top window. */
  function rebuild() {
    generation += 1;
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
    clearMounted();
    activePage = -1;

    const doc = scribe.doc;
    pageCount = doc?.inputData?.pageCount ?? 0;
    if (!doc || pageCount === 0) {
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
      const aspect = dims && dims.width ? dims.height / dims.width : DEFAULT_ASPECT;
      const boxH = Math.max(1, Math.round(THUMB_W * aspect));
      boxHeights[n] = boxH;
      heights[n] = boxH + ROW_OVERHEAD;
      offsets[n] = acc;
      acc += heights[n];
    }
    total = acc;
    spacer.style.height = `${total}px`;
    panelElem.scrollTop = 0;
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
    const viewTop = panelElem.scrollTop - PAD;
    const viewBottom = viewTop + panelElem.clientHeight;
    if (top < viewTop) panelElem.scrollTop = Math.max(0, top + PAD - 8);
    else if (bottom > viewBottom) panelElem.scrollTop = bottom + PAD - panelElem.clientHeight + 8;
    updateWindow();
  }

  /**
   * Show or hide the panel. While hidden every row is unmounted so it holds no decoded images.
   * @param {boolean} v
   */
  function setVisible(v) {
    visible = v;
    panelElem.style.display = v ? '' : 'none';
    toggleElem.classList.toggle('active', v);
    if (v) {
      updateWindow();
    } else {
      generation += 1;
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
      clearMounted();
    }
  }

  /** Tear down: unmount all rows, cancel pending renders, and drop the DOM. */
  function destroy() {
    destroyed = true;
    generation += 1;
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
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
