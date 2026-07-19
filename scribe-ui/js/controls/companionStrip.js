// Persistent page companion strip for the phone layout: a thin filmstrip pinned above the dock that stays visible while reading, the phone counterpart to the desktop thumbnail rail.
// Thumbnails render lazily as cells scroll into view, so a 500-page document stays cheap.

const CELL_H = 84;
const CELL_W = Math.round(CELL_H * (8.5 / 11));
let stylesInjected = false;

/** Inject the strip's scoped stylesheet once. Tokens (--scribe-*) inherit from the viewer root. */
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.id = 'scribe-strip-styles';
  style.textContent = `
    .scribe-strip{position:absolute;left:0;right:0;z-index:14;display:none;flex-direction:column;
      bottom:calc(56px + env(safe-area-inset-bottom,0px));height:${CELL_H + 12}px;box-sizing:border-box;
      background:var(--scribe-surface);border-top:1px solid var(--scribe-line);color:var(--scribe-ink);}
    .scribe-phone .scribe-strip.on{display:flex;}
    /* The plain 8px lead-in on both sides is deliberate: it keeps a fully-fitting document immobile and clamps rests at the ends, so the bar moves only when new pages come into view.
       (A half-viewport lead-in centered the end pages over dead space and let a fully-visible document shuffle a few px on every page change.) */
    .scribe-strip-row{flex:1;display:flex;align-items:center;gap:8px;padding:6px 8px;
      overflow-x:auto;overflow-y:hidden;scrollbar-width:none;-webkit-overflow-scrolling:touch;touch-action:pan-x;}
    .scribe-strip-row::-webkit-scrollbar{display:none;}
    /* touch-callout and user-select off so a long press on a page image cannot raise iOS Safari's save-image sheet. */
    .scribe-strip-cell{flex:0 0 auto;width:${CELL_W}px;height:${CELL_H}px;padding:0;border:0;cursor:pointer;
      background:#fff;border-radius:2px;box-shadow:var(--scribe-page-shadow);outline:1px solid rgba(0,0,0,.12);
      outline-offset:0;overflow:hidden;position:relative;-webkit-tap-highlight-color:transparent;
      -webkit-touch-callout:none;-webkit-user-select:none;user-select:none;}
    .scribe-strip-cell img{width:100%;height:100%;object-fit:contain;display:block;background:#fff;}
    .scribe-strip-cell.active{outline:2.5px solid var(--scribe-accent);}
    /* The wind bar: a track along the strip's top edge whose accent fill is, at rest, a short marker at the reading position's fraction of the document.
       Flipping the strip winds the fill out into a segment spanning the reading position to the flipped-to page; returning unwinds it back to the marker. */
    .scribe-strip-prog{position:absolute;left:0;right:0;top:0;height:3px;pointer-events:none;
      background:var(--scribe-line-strong);opacity:0;transition:opacity .16s;z-index:15;}
    .scribe-strip-prog.on{opacity:1;}
    .scribe-strip-prog-fill{position:absolute;top:0;bottom:0;left:0;width:0;background:var(--scribe-accent);
      border-radius:2px;transition:left .12s ease-out,width .12s ease-out;}
    /* The pull tab unfolds the strip into the full-height Pages room; it pokes up into the canvas so it costs no strip height and never covers a thumbnail.
       During the strip-to-room morph, pagesMorph.js hides it and rides a pixel-identical stand-in along the room's top edge, so a restyle here must be mirrored there.
       The invisible ::after halo is the real touch target, kept off the row below so it cannot eat cell taps. */
    .scribe-strip-tab{position:absolute;top:-17px;right:14px;width:54px;height:17px;margin:0;padding:0;
      background:var(--scribe-surface);border:1px solid var(--scribe-line);border-bottom:0;
      border-radius:8px 8px 0 0;display:flex;align-items:center;justify-content:center;
      color:var(--scribe-ink-2);box-shadow:0 -1px 2px rgba(20,30,60,.05);cursor:pointer;
      touch-action:none;-webkit-tap-highlight-color:transparent;}
    .scribe-strip-tab svg{width:12px;height:12px;}
    .scribe-strip-tab::after{content:"";position:absolute;inset:-14px -18px -4px -18px;}
    .scribe-strip-tab:active{background:var(--scribe-hover);}
    @media (prefers-reduced-motion:reduce){.scribe-strip-prog,.scribe-strip-prog-fill{transition:none;}}
  `;
  document.head.appendChild(style);
}

// Drawn in the toolbar's icon grammar.
const CHEV_UP_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 14l7-7 7 7"/></svg>';

/**
 * Build the phone companion strip.
 * @param {import('../../viewer.js').ScribeViewer} scribe
 * @param {{ onExpand?: (phase: 'tap'|'start'|'move'|'end', dy: number) => void }} [handlers]
 *   `onExpand` fires as the strip is pulled up toward the full-height Pages room: `tap` for the pull tab, or `start`/`move`/`end` with the upward travel in px for a live drag.
 *   Travel is re-based to the gesture's engagement point, so `start` always reports 0.
 *   Omitting `onExpand` leaves the strip a pure filmstrip (no tab, no vertical gesture).
 * @returns {{
 *   stripElem: HTMLDivElement,
 *   setActive: (n: number) => void,
 *   park: () => void,
 *   settle: () => void,
 *   rebuild: (page?: number) => void,
 *   setVisible: (v: boolean) => void,
 *   destroy: () => void,
 * }}
 */
export function createCompanionStrip(scribe, { onExpand } = {}) {
  ensureStyles();

  const stripElem = document.createElement('div');
  stripElem.className = 'scribe-strip';

  const row = document.createElement('div');
  row.className = 'scribe-strip-row';

  const prog = document.createElement('div');
  prog.className = 'scribe-strip-prog';
  const progFill = document.createElement('div');
  progFill.className = 'scribe-strip-prog-fill';
  prog.appendChild(progFill);

  stripElem.append(row, prog);

  if (onExpand) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'scribe-strip-tab';
    tab.title = 'All pages';
    tab.setAttribute('aria-label', 'All pages');
    tab.innerHTML = CHEV_UP_SVG;
    tab.addEventListener('click', () => onExpand('tap', 0));
    stripElem.appendChild(tab);

    /** @type {?{id: number, y0: number, x0: number, sl0: number, base: number, active: boolean, dy: number}} */
    let pull = null;
    stripElem.addEventListener('pointerdown', (e) => {
      // Ignore additional pointers while a pull is live; a stale un-engaged record is replaced.
      if (pull && pull.active && e.pointerId !== pull.id) return;
      pull = {
        id: e.pointerId, y0: e.clientY, x0: e.clientX, sl0: row.scrollLeft, base: 0, active: false, dy: 0,
      };
    });
    stripElem.addEventListener('pointermove', (e) => {
      if (!pull || e.pointerId !== pull.id) return;
      const dy = pull.y0 - e.clientY;
      const dx = Math.abs(e.clientX - pull.x0);
      if (!pull.active) {
        // The row already moving means the browser's pan owns this gesture; never steal a scroll in progress.
        if (Math.abs(row.scrollLeft - pull.sl0) > 1) {
          pull = null;
          return;
        }
        // A fast horizontal flick often leads with a short upward arc, so engagement demands 2:1 steepness or the pull would steal the whole flick at that arc.
        // The 12px floor holds the slope test past the platforms' own pan slop, so steepness is judged on intent rather than first-frame tremor.
        if (dy > 12 && dy > 2 * dx) {
          pull.active = true;
          pull.base = dy;
          pull.dy = 0;
          try { stripElem.setPointerCapture(e.pointerId); } catch { /* untrusted event: move/up still bubble here */ }
          onExpand('start', 0);
        } else if (dx > 14 && dx > Math.abs(dy)) {
          pull = null; // horizontal flip; the row's own scroll owns this gesture
        }
        return;
      }
      pull.dy = dy - pull.base;
      onExpand('move', pull.dy);
    });
    // touch-action is latched at touchstart, so this non-passive preventDefault is the only mid-gesture way to keep the row's pan-x from reclaiming an engaged pull.
    // A takeover fires pointercancel and snaps the half-risen room back.
    stripElem.addEventListener('touchmove', (e) => {
      if (pull && pull.active && e.cancelable) e.preventDefault();
    }, { passive: false });
    const endPull = (e) => {
      if (!pull || e.pointerId !== pull.id) return;
      const { active, dy: lastDy } = pull;
      // On a cancel Chrome reports coordinates as (0, 0), which would read as an enormous upward travel and pop the room open; end at the last travel a real move reported instead.
      const dy = e.type === 'pointercancel' ? lastDy : pull.y0 - e.clientY - pull.base;
      pull = null;
      if (active) onExpand('end', dy);
    };
    stripElem.addEventListener('pointerup', endPull);
    stripElem.addEventListener('pointercancel', endPull);
    // Safety net: a capture that dies without an up/cancel ever reaching us would leave the room parked over the strip.
    // Act only when the STRIP loses its own capture.
    // Engaging a touch pull transfers the pointerdown target's implicit capture, so this event fires at the child (bubbling here) the instant every touch pull starts.
    stripElem.addEventListener('lostpointercapture', (e) => {
      if (e.target !== stripElem) return;
      if (!pull || e.pointerId !== pull.id || !pull.active) return;
      pull = null;
      onExpand('end', 0);
    });
  }

  /** @type {HTMLButtonElement[]} */
  let cells = [];
  let pageCount = 0;
  let activePage = 0;
  let destroyed = false;
  let followRAF = 0;
  let followTarget = 0;
  let followPos = 0; // float model of the eased scroll (scrollLeft itself rounds to device px)
  let scrollHost = /** @type {HTMLElement|null} */ (null); // scribe.scrollContainer, attached once it exists
  let syncRAF = 0; // coalesces viewer scroll events to one strip sync per frame
  // While a finger is on the strip, or the fling it launched is still coasting, the mirror must not write scrollLeft.
  // A programmatic write cancels a native fling the instant it starts, and drags against a held finger.
  const GLIDE_MS = 150;
  /** @type {Set<number>} */
  const holdIds = new Set();
  let userGlideT = -Infinity;
  const userOwns = () => holdIds.size > 0 || performance.now() - userGlideT < GLIDE_MS;
  const reduceMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // Cells whose thumbnail render is in flight, so `renderVisible` does not spawn a second render for the same cell.
  // Keyed by the cell element, so a rebuild's fresh cells are never confused with the old ones.
  /** @type {WeakSet<HTMLButtonElement>} */
  const rendering = new WeakSet();

  /**
   * Render cell `n`'s thumbnail if it is not already rendered or in flight.
   * @param {number} n
   */
  function renderCell(n) {
    const cell = cells[n];
    if (!cell || rendering.has(cell)) return;
    const img = cell.querySelector('img');
    if (!img || img.src) return;
    const doc = scribe.doc;
    if (!doc || !doc.images) return;
    rendering.add(cell);
    // Failures are swallowed: `renderVisible` retries on every scroll/reveal, so a transient failure never permanently blanks a cell.
    doc.images.thumbnailUrl(n).then((url) => {
      if (destroyed || !url || cells[n] !== cell) return;
      img.src = url;
    }).catch(() => {}).finally(() => { rendering.delete(cell); });
  }

  /** Render every cell currently in (or near) the strip's viewport. */
  function renderVisible() {
    if (!cells.length) return;
    geom();
    const margin = 200; // prefetch a screen-ish of cells to either side
    const first = Math.max(0, Math.floor((row.scrollLeft - margin - gPad) / gStride));
    const last = Math.min(pageCount - 1, Math.floor((row.scrollLeft + gRowW + margin - gPad) / gStride));
    // Tell the scheduler where the strip is looking, so a flick's backlog of staged thumbnails dispatches nearest-to-view first.
    // Only while showing: a hidden strip must not override the rail's live focus.
    if (stripElem.classList.contains('on')) {
      const centre = Math.max(0, Math.min(pageCount - 1, Math.round((row.scrollLeft + gRowW / 2 - gPad) / gStride)));
      scribe.doc?.images?.pdfScheduler?.setThumbFocus(centre);
    }
    for (let n = first; n <= last; n += 1) renderCell(n);
  }

  function stopFollow() { if (followRAF) { cancelAnimationFrame(followRAF); followRAF = 0; } }

  /** One animation frame of the follow: ease a fraction of the remaining distance toward `followTarget`, which callers may keep moving. */
  function followStep() {
    followRAF = 0;
    if (destroyed) return;
    // Ease off the float model, never the scrollLeft read-back: easing off the rounded read-back stalls for good a few px short of the target.
    const diff = followTarget - followPos;
    if (Math.abs(diff) < 0.5) { row.scrollLeft = followTarget; mirrorSl = row.scrollLeft; return; }
    followPos += diff * 0.2;
    row.scrollLeft = followPos;
    mirrorSl = row.scrollLeft;
    followRAF = requestAnimationFrame(followStep);
  }
  // (Re)start the follow loop toward the current `followTarget`.
  // A start while the loop is live keeps the float model, which cannot go stale because every external scrollLeft writer calls stopFollow() first.
  function startFollow() {
    if (!followRAF) {
      followPos = row.scrollLeft;
      followRAF = requestAnimationFrame(followStep);
    }
  }

  // Measured once and reused: a parked bar still takes the scroll-event storm of a pinch,
  // so the per-event path must stay pure arithmetic with no layout reads.
  let geomValid = false;
  let gPad = 8;
  let gStride = CELL_W + 8;
  let gRowW = 0;
  let gMaxScroll = 0;
  let gTrackW = 0;
  function measureGeom() {
    if (!cells.length || row.clientWidth === 0) return; // a hidden row would cache zeros, so keep the fallbacks and retry on the next use
    gPad = cells[0].offsetLeft;
    gStride = cells.length > 1 ? cells[1].offsetLeft - cells[0].offsetLeft : CELL_W + 8;
    gRowW = row.clientWidth;
    gMaxScroll = Math.max(0, row.scrollWidth - row.clientWidth);
    gTrackW = stripElem.clientWidth;
    geomValid = true;
  }
  function geom() { if (!geomValid) measureGeom(); }

  /** Strip scroll offset that centers a (possibly fractional) page in the row. */
  function targetForPage(pageFloat) {
    geom();
    return Math.max(0, Math.min(gMaxScroll, gPad + pageFloat * gStride + CELL_W / 2 - gRowW / 2));
  }

  // Rest and mirror share ONE target, the continuous fractional reading position, so settling can never fight the mirror.
  // (Resting on the INTEGER active cell instead walked the bar out and straight back on every same-page viewer scroll.)
  // `mirrorOffset` is the hop guard: a scroll resuming from rest carries whatever offset accrued while parked, decaying as the scroll continues.
  const REST_MS = 180;
  // Zooms anchor at the finger, not the centre, so they shift the reading fraction by under half a page and a same-page pinch or double-tap cannot jiggle the bar.
  const FREEZE_PAGES = 0.75;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let restTimer = null;
  let resting = false; // the bar is parked (or gliding) onto the rest position
  let mirrorOffset = 0;
  let frozenFrac = 0; // the reading position the bar last parked on
  let mirrorSl = 0; // the last scrollLeft the mirror itself wrote

  /**
   * Rest the strip on the current reading position, instantly or (when `smooth`) via the ease loop.
   * @param {boolean} [smooth=true]
   */
  function positionForActive(smooth = true) {
    if (!cells[activePage]) return;
    resting = true;
    // A rest ends the offset's life (the resume re-seeds it); left stale it would skew the wind marker's zero point while parked.
    mirrorOffset = 0;
    // Rest on the fraction the mirror tracks, falling back to the integer active page around structural rebuilds, where the viewer's scroll geometry may not describe the new document yet.
    const f = scribe.scrollPageFraction();
    const rest = Number.isFinite(f) && Math.abs(f - activePage) <= 1
      ? Math.max(0, Math.min(pageCount - 1, f)) : activePage;
    frozenFrac = rest;
    followTarget = targetForPage(rest);
    renderVisible();
    if (!smooth || reduceMotion()) { stopFollow(); row.scrollLeft = followTarget; mirrorSl = row.scrollLeft; onFlip(); return; }
    startFollow();
  }

  /** The viewer scroll has been idle: glide the bar onto the reading position's rest. */
  function restSettle() {
    restTimer = null;
    if (destroyed || userOwns() || !cells[activePage]) return;
    if (resting) return;
    positionForActive();
  }

  /** Instantly rest the strip on the viewer's current page, cancelling any in-flight glide, so a surface covering the strip (the Pages room) can close onto it exactly as it will be revealed. */
  function park() {
    const cp = scribe.state && scribe.state.cp;
    if (cp && cp.n !== activePage) setActive(cp.n);
    positionForActive(false);
  }

  /**
   * Glide the strip home onto the reading position's rest.
   * A parked bar no longer unwinds on its own, so a caller that displaced the row itself must call this.
   */
  function settle() { positionForActive(); }

  // Mirror the viewer's continuous scroll: move the strip to the reader's fractional-page position.
  // A move within JUMP_GAP snaps 1:1 so the strip's velocity matches the scroll; a larger gap eases via the follow loop.
  const JUMP_GAP = (CELL_W + 8) * 3;
  function syncToViewer() {
    syncRAF = 0;
    if (destroyed || !cells.length) return;
    if (userOwns()) return;
    const f = scribe.scrollPageFraction();
    const frac = Number.isFinite(f) ? Math.max(0, Math.min(pageCount - 1, f)) : activePage;
    if (resting && Math.abs(frac - frozenFrac) <= FREEZE_PAGES) { onFlip(); return; }
    const target = targetForPage(frac);
    if (resting) {
      // Resume from the rest without a hop: carry the parked offset and let it decay below.
      resting = false;
      stopFollow();
      mirrorOffset = row.scrollLeft - target;
    }
    mirrorOffset *= 0.94;
    if (Math.abs(mirrorOffset) < 0.5) mirrorOffset = 0;
    if (Math.abs(target - row.scrollLeft) > JUMP_GAP && !reduceMotion()) {
      mirrorOffset = 0;
      followTarget = target;
      startFollow();
    } else {
      stopFollow();
      row.scrollLeft = target + mirrorOffset;
      mirrorSl = row.scrollLeft;
    }
    // At the document ends the write above clamps to an unchanged scrollLeft and fires no row scroll event, so drive the wind marker explicitly.
    onFlip();
  }
  function onViewerScroll() {
    if (restTimer) clearTimeout(restTimer);
    restTimer = setTimeout(restSettle, REST_MS);
    if (!syncRAF) syncRAF = requestAnimationFrame(syncToViewer);
  }
  function ensureScrollSync() {
    if (scrollHost || !scribe.scrollContainer) return;
    scrollHost = scribe.scrollContainer;
    scrollHost.addEventListener('scroll', onViewerScroll, { passive: true });
  }

  /**
   * Mark page `n` active. Moves the highlight only; position stays owned by `syncToViewer`.
   * @param {number} n
   */
  function setActive(n) {
    ensureScrollSync();
    if (n === activePage && cells[n]?.classList.contains('active')) return;
    cells[activePage]?.classList.remove('active');
    activePage = Math.max(0, Math.min(pageCount - 1, n));
    cells[activePage]?.classList.add('active');
    // Navigating to a page the strip already shows moves no scroll and fires no scroll event; recompute the fill now or it keeps the pre-navigation flip segment.
    onFlip();
    onViewerScroll();
  }

  /** @param {Event} e */
  function onCellClick(e) {
    // A tap is explicit navigation: release the glide hold so the mirror may recenter on the tapped page.
    userGlideT = -Infinity;
    scribe.displayPage(Number(/** @type {HTMLElement} */ (e.currentTarget).dataset.n), true, false);
  }

  /** @param {number} [page] */
  function rebuild(page = activePage) {
    ensureScrollSync();
    hideFeedback();
    row.textContent = '';
    cells = [];
    pageCount = scribe.doc ? scribe.doc.inputData.pageCount : 0;
    activePage = Math.max(0, Math.min(pageCount - 1, page || 0));
    for (let n = 0; n < pageCount; n += 1) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = `scribe-strip-cell${n === activePage ? ' active' : ''}`;
      cell.dataset.n = String(n);
      cell.setAttribute('aria-label', `Page ${n + 1}`);
      const img = document.createElement('img');
      // A native image drag would steal an upward pull mid-gesture (pointercancel) and snap the room back.
      img.draggable = false;
      // The cached thumbnail raster is at the page's original orientation, so rotation is applied as a CSS transform.
      const rot = (scribe.doc && scribe.doc.pageMetrics[n] && scribe.doc.pageMetrics[n].rotation) || 0;
      if (rot % 180 === 90) {
        img.style.position = 'absolute';
        img.style.top = '50%';
        img.style.left = '50%';
        img.style.width = `${CELL_H}px`;
        img.style.height = `${CELL_W}px`;
        img.style.transform = `translate(-50%, -50%) rotate(${rot}deg)`;
      } else if (rot === 180) {
        img.style.transform = 'rotate(180deg)';
      }
      cell.appendChild(img);
      cell.addEventListener('click', onCellClick);
      row.appendChild(cell);
      cells.push(cell);
    }
    geomValid = false;
    // Wait a frame so offsetLeft is real before the first center.
    // The first center jumps instantly so a restored mid-document page does not flash an unwind on load.
    requestAnimationFrame(() => { if (!destroyed) { positionForActive(false); renderVisible(); } });
  }

  // ---- the wind bar ----
  function hideFeedback() { prog.classList.remove('on'); }

  // Wide enough to read as a position against the track, short enough not to be mistaken for a flip segment.
  const MARKER_PX = 10;

  function onFlip() {
    const cell = cells[activePage];
    if (pageCount < 2 || !cell) { hideFeedback(); return; }
    geom();
    const sl = Math.max(0, Math.min(gMaxScroll, row.scrollLeft));
    const fraction = Math.max(0, Math.min(pageCount - 1, scribe.scrollPageFraction()));
    const anchorFrac = fraction / (pageCount - 1);
    const zero = Math.max(0, Math.min(gMaxScroll, mirrorSl));
    const DEAD = 4;
    const d = sl - zero;
    let flipFrac = anchorFrac;
    if (d > DEAD && zero < gMaxScroll) {
      flipFrac = anchorFrac + (1 - anchorFrac) * ((d - DEAD) / Math.max(1, gMaxScroll - zero - DEAD));
    } else if (d < -DEAD && zero > 0) {
      flipFrac = anchorFrac - anchorFrac * ((-d - DEAD) / Math.max(1, zero - DEAD));
    }
    flipFrac = Math.max(0, Math.min(1, flipFrac));
    const trackW = gTrackW;
    let left = Math.min(anchorFrac, flipFrac) * trackW;
    let width = Math.abs(flipFrac - anchorFrac) * trackW;
    if (width < MARKER_PX) {
      left = Math.max(0, Math.min(trackW - MARKER_PX, left + width / 2 - MARKER_PX / 2));
      width = MARKER_PX;
    }
    progFill.style.left = `${left}px`;
    progFill.style.width = `${width}px`;
    prog.classList.add('on');
  }
  // A scroll frame while the user owns the strip is their own motion (the mirror is muted then), so it extends the glide window until the fling has actually died out.
  row.addEventListener('scroll', () => {
    if (userOwns()) userGlideT = performance.now();
    onFlip();
    renderVisible();
  });
  // A resize changes the centering math and the wind track width, so a parked bar's cached geometry and marker both go stale.
  const geomObserver = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => { geomValid = false; onFlip(); }) : null;
  if (geomObserver) geomObserver.observe(row);

  // A touch is the user taking over to flip: stop the follow so it does not fight them, and hold the mirror off until the touch and any fling it launches settle.
  // Tracked on the strip, not the row: ups and cancels still arrive here after a pull transfers pointer capture to the strip, so a hold can never leak.
  stripElem.addEventListener('pointerdown', (e) => { holdIds.add(e.pointerId); stopFollow(); }, { passive: true });
  const endHold = (e) => {
    if (holdIds.delete(e.pointerId) && holdIds.size === 0) userGlideT = performance.now();
  };
  stripElem.addEventListener('pointerup', endHold, { passive: true });
  stripElem.addEventListener('pointercancel', endHold, { passive: true });

  function setVisible(v) {
    stripElem.classList.toggle('on', v);
    // Wait one frame so the just-shown strip has real widths: a fill computed at the hidden strip's zero track width parks at 0.
    if (v) {
      geomValid = false;
      requestAnimationFrame(() => { if (!destroyed) { renderVisible(); onFlip(); } });
    } else {
      // A hidden strip is idle: drop its focus hint so it stops skewing the background render order.
      scribe.doc?.images?.pdfScheduler?.setThumbFocus(null);
    }
  }

  function destroy() {
    destroyed = true;
    stopFollow();
    if (restTimer) clearTimeout(restTimer);
    if (syncRAF) cancelAnimationFrame(syncRAF);
    if (scrollHost) scrollHost.removeEventListener('scroll', onViewerScroll);
    if (geomObserver) geomObserver.disconnect();
    stripElem.remove();
  }

  return {
    stripElem, setActive, park, settle, rebuild, setVisible, destroy,
  };
}
