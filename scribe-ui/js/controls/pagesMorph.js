// Pull-up morph between the phone companion strip and the full-height Pages room.
// Instead of the room sliding over the strip as a separate panel, the strip's own thumbnails visibly become the room's grid.
// Stage 1, grow: the film cells grow to grid size and slide into their final columns, bottom edges glued to the bar's floor.
// The grow ends with only the anchor row on screen; its neighbours have cleared the side edges.
// Stage 2, ride: the room's top edge tracks the finger 1:1, and once it picks the anchor row off the floor the row rides just beneath it, the following rows trailing rigidly from behind the dock.
// Stage 3, reveal: the row freezes at its final resting position and the remaining pull only sweeps the edge further up, uncovering the preceding row parked in place.
// The real panel is laid out hidden at the choreography's final scroll before the morph starts, so the swap at the end is pixel-exact: removing the morph exposes the identical real grid.

// Gap between the room's top edge and the riding row.
const HUG = 44;
// The pull tab's height; keep in sync with .scribe-strip-tab (companionStrip.js).
const TAB_H = 17;
// Spare px past the room's side edge when flinging non-anchor-row cells clear during the grow.
const FLARE_PAD = 16;
// Floor on the grow phase's finger travel, so very short cells still get a legible grow.
const MIN_GROW = 48;
// Per-frame fraction of the remaining travel the release/tap animation covers (retargetable ease-out).
const SETTLE_RATE = 0.2;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ez = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);

// The strip tab's glyph; keep in sync with companionStrip.js.
const CHEV_UP_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 14l7-7 7 7"/></svg>';

let stylesInjected = false;

/** Inject the morph's scoped stylesheet once. Tokens (--scribe-*) inherit from the viewer root. */
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.id = 'scribe-morph-styles';
  style.textContent = `
    .scribe-morph{position:absolute;inset:0;z-index:3;pointer-events:none;overflow:hidden;}
    .scribe-morph-cell{position:absolute;border-radius:2px;box-shadow:var(--scribe-page-shadow);
      outline:1px solid rgba(0,0,0,.12);will-change:left,top,width,height;}
    .scribe-morph-clip{position:absolute;inset:0;overflow:hidden;border-radius:2px;background:#fff;}
    .scribe-morph-clip img{width:100%;height:100%;object-fit:contain;display:block;background:#fff;}
    .scribe-morph-label{position:absolute;top:100%;left:0;right:0;margin-top:2px;text-align:center;
      font-size:13px;line-height:1;color:var(--scribe-ink-3);opacity:0;}
    .scribe-morph-cell.active{outline:2.5px solid var(--scribe-accent);}
    .scribe-morph-cell.active .scribe-morph-label{color:var(--scribe-ink);font-weight:600;}
    /* The pull tab riding the room's top edge: a visual clone of .scribe-strip-tab (keep the 54x17/right:14 geometry in sync with companionStrip.js).
       It is a VIEWER-ROOT sibling of the room because the morphing room clips its own overflow (its edge is the reveal line), so nothing poking above that edge can live inside it.
       z26 sits over the room's z25. */
    .scribe-morph-tab{position:absolute;top:0;right:14px;width:54px;height:${TAB_H}px;z-index:26;
      pointer-events:none;will-change:transform;
      background:var(--scribe-surface);border:1px solid var(--scribe-line);border-bottom:0;
      border-radius:8px 8px 0 0;display:flex;align-items:center;justify-content:center;
      color:var(--scribe-ink-2);box-shadow:0 -1px 2px rgba(20,30,60,.05);}
    .scribe-morph-tab svg{width:12px;height:12px;}
    .scribe-strip.scribe-tab-riding .scribe-strip-tab{visibility:hidden;}
  `;
  document.head.appendChild(style);
}

/**
 * Build the strip-to-room morph controller.
 * The caller owns the gesture and the settled states; the morph owns the room's transform, background, and header visibility from `begin()` until the settle (or abort) hands the room back.
 * @param {import('../../viewer.js').ScribeViewer} scribe
 * @param {{
 *   roomElem: HTMLDivElement,
 *   roomHdElem: HTMLDivElement,
 *   stripElem: HTMLDivElement,
 *   panel: ReturnType<typeof import('./panels.js').createThumbnailPanel>,
 * }} refs
 * @returns {{
 *   begin: () => boolean,
 *   beginClose: () => boolean,
 *   frame: (dy: number) => void,
 *   settle: (commit: boolean, onDone?: (committed: boolean) => void) => void,
 *   isActive: () => boolean,
 *   settling: () => boolean,
 *   abort: () => void,
 * }}
 */
export function createPagesMorph(scribe, {
  roomElem, roomHdElem, stripElem, panel,
}) {
  ensureStyles();

  /** @type {?object} Live morph scene. */
  let scene = null;
  let raf = 0;

  /**
   * Hand the room back: committed leaves it settled open; cancelled returns it to rest instantly.
   * @param {boolean} committed
   */
  function teardown(committed) {
    const s = scene;
    if (!s) return;
    scene = null;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    s.layer.remove();
    s.mtab.remove();
    stripElem.classList.remove('scribe-tab-riding');
    for (const url of s.urls) URL.revokeObjectURL(url);
    roomHdElem.style.opacity = '';
    roomHdElem.style.pointerEvents = '';
    roomElem.style.background = '';
    panel.panelElem.style.visibility = '';
    roomElem.classList.remove('morphing', 'dragging');
    if (committed) {
      roomElem.style.transform = '';
    } else {
      roomElem.classList.remove('open');
      // At travel 0 the morph's pixels equal the untouched strip underneath, so the room vanishes without a slide.
      roomElem.style.transition = 'none';
      roomElem.style.transform = '';
      requestAnimationFrame(() => { roomElem.style.transition = ''; });
      panel.setVisible(false);
      panel.panelElem.style.display = 'none';
    }
  }

  /**
   * Build a morph scene from the live strip and the laid-out thumbnail panel, and take over the room.
   * `close` builds the reverse scene: the open room played back down into the strip.
   * Returns false for degenerate states (no document, mismatched strip/grid, no coherently-placed row), where the caller falls back to the plain slide.
   * @param {boolean} close
   */
  function build(close) {
    if (scene) return false; // a live scene means the room already owns a gesture or settle
    const doc = scribe.doc;
    const pageCount = doc && doc.inputData ? doc.inputData.pageCount : 0;
    const row = stripElem.querySelector('.scribe-strip-row');
    if (!pageCount || !row || !row.childElementCount) return false;
    const geo = panel.gridGeometry();
    if (!geo || !geo.cols || geo.count !== pageCount) return false;
    const viewerElem = roomElem.parentElement;
    if (!viewerElem) return false;

    const viewerRect = viewerElem.getBoundingClientRect();
    const stripRect = stripElem.getBoundingClientRect();
    const travel = roomElem.offsetHeight || 1;
    const lead = stripRect.height; // the room starts (and ends) the pull covering the strip band exactly
    const dyFull = Math.max(1, travel - lead);
    const roomW = roomElem.offsetWidth;
    const headerH = roomHdElem.offsetHeight;
    const cols = geo.cols;
    const scrollElem = panel.panelElem.querySelector('.scribe-thumb-scroll');
    if (!scrollElem) return false;
    const viewH = scrollElem.clientHeight;
    const activeN = scribe.state && scribe.state.cp ? scribe.state.cp.n : -1;

    // Film geometry: cells are uniform, so one measured cell anchors the whole row arithmetically.
    const cells = row.querySelectorAll('.scribe-strip-cell');
    if (cells.length !== pageCount) return false;
    const filmW = cells[0].offsetWidth;
    const filmH = cells[0].offsetHeight;
    const strideF = cells.length > 1 ? cells[1].offsetLeft - cells[0].offsetLeft : filmW + 8;
    const pad = cells[0].offsetLeft;

    // Vertical film geometry never changes with the strip's scroll, so it can anchor the close's row-window test below; the horizontal measurement waits until after a possible strip flip.
    const growBottom = cells[0].getBoundingClientRect().bottom - viewerRect.top;

    let anchor;
    let filmScroll; // the strip scroll the film endpoint of the morph is laid out at
    let finalScroll; // the grid scroll the open endpoint of the morph is laid out at
    if (close) {
      if (activeN < 0) return false;
      finalScroll = scrollElem.scrollTop;
      // The row the grid collapses onto must sit where the descending edge can coherently collect it: below the hug band, its box clear of the bar's floor.
      // That is the ACTIVE page's row whenever it is on screen.
      // The caller parks the covered strip at the active page's rest before building this scene, so the collapse lands on the strip exactly as it lies.
      // When the user has scrolled the grid away from the active row, the CENTRE-MOST fully-in-window row collapses instead and the covered strip flips to its pages first, invisibly under the room.
      const rowWindow = (rStart) => {
        let rowBox = 1;
        for (let n = rStart; n < Math.min(pageCount, rStart + cols); n += 1) rowBox = Math.max(rowBox, geo.boxH(n));
        const fy = headerH + geo.boxTop(rStart) - finalScroll;
        return { fy, rowBox, ok: fy >= HUG && fy + rowBox <= growBottom };
      };
      if (rowWindow(Math.floor(activeN / cols) * cols).ok) {
        anchor = activeN;
        filmScroll = row.scrollLeft;
      } else {
        let best = -1;
        let bestDist = Infinity;
        for (let r = 0; r * cols < pageCount; r += 1) {
          const w = rowWindow(r * cols);
          if (w.fy > headerH + viewH) break;
          if (!w.ok) continue;
          const dist = Math.abs(w.fy + w.rowBox / 2 - (headerH + viewH / 2));
          if (dist < bestDist) { bestDist = dist; best = r; }
        }
        if (best < 0) return false;
        anchor = Math.min(best * cols + ((cols - 1) >> 1), pageCount - 1);
        row.scrollLeft = clamp(
          pad + anchor * strideF + filmW / 2 - row.clientWidth / 2,
          0, Math.max(0, row.scrollWidth - row.clientWidth),
        );
        filmScroll = row.scrollLeft;
      }
    } else {
      // The anchor is the ACTIVE page's row whenever the active page is on the strip: the ringed page the user navigates by must stay among the surviving thumbnails.
      // (The strip clamps at the document ends, so the visual centre is not reliably the active page.)
      // Only when the strip is flipped away from the active page does the centre page's row anchor instead, so the room opens where the user was browsing.
      filmScroll = row.scrollLeft;
      const firstVis = clamp(Math.floor((filmScroll - pad) / strideF), 0, pageCount - 1);
      const lastVis = clamp(Math.ceil((filmScroll + row.clientWidth - pad) / strideF), 0, pageCount - 1);
      const centre = clamp(Math.round((filmScroll + row.clientWidth / 2 - pad - filmW / 2) / strideF), 0, pageCount - 1);
      anchor = activeN >= firstVis && activeN <= lastVis ? activeN : centre;
      // The anchor row rests one row from the top, so exactly one earlier row remains for the edge to reveal (none when the anchor row is the first).
      const aR = Math.floor(anchor / cols);
      scrollElem.scrollTop = aR > 0 ? Math.max(0, geo.thumbTop((aR - 1) * cols) - geo.pad) : 0;
      finalScroll = scrollElem.scrollTop; // read back: the browser clamped to the real range
    }
    const aRow = Math.floor(anchor / cols);
    // Measured after any strip flip above, so it reflects the film endpoint's scroll; the trailing term follows any FURTHER scroll between now and a frame() call.
    const c0Left = cells[0].getBoundingClientRect().left - viewerRect.left;
    const filmX = (n) => c0Left + n * strideF + (row.scrollLeft - filmScroll);
    /** Viewer-relative y of page n's image box at the open endpoint. */
    const finalY = (n) => headerH + geo.boxTop(n) - finalScroll;

    // Participants: every row the grid viewport shows any part of at the open endpoint, plus every film cell visible at the strip endpoint.
    // The 15px tail is the label hanging under the box (2px gap + 13px text), so inclusion matches exactly what the real grid shows.
    // A morph cell the grid never shows would paint into the header band and then vanish at the swap.
    const pages = new Set();
    for (let r = 0; r * cols < pageCount; r += 1) {
      const top = geo.boxTop(r * cols);
      if (top >= finalScroll + viewH) break;
      if (top + geo.boxH(r * cols) + 15 <= finalScroll) continue;
      for (let n = r * cols; n < Math.min(pageCount, (r + 1) * cols); n += 1) pages.add(n);
    }
    const firstFilm = clamp(Math.floor((filmScroll - pad) / strideF), 0, pageCount - 1);
    const lastFilm = clamp(Math.ceil((filmScroll + row.clientWidth - pad) / strideF), 0, pageCount - 1);
    for (let n = firstFilm; n <= lastFilm; n += 1) pages.add(n);

    // The grow phase spreads the film around the anchor row's middle column, so that row lands on its final columns exactly while everything else clears the side edges.
    const mid = Math.min(aRow * cols + ((cols - 1) >> 1), pageCount - 1);
    const cxF = filmX(mid) + filmW / 2;
    const cxG = geo.boxLeft(mid) + geo.cellW / 2;

    // Grow completes exactly when the rising edge's hug line reaches the grown row's top, so the edge picks the row up off the floor the moment it stops growing.
    let rowBoxH = 1;
    for (let n = aRow * cols; n < Math.min(pageCount, (aRow + 1) * cols); n += 1) rowBoxH = Math.max(rowBoxH, geo.boxH(n));
    const growPx = Math.max(MIN_GROW, travel - lead + HUG - (growBottom - rowBoxH));

    const layer = document.createElement('div');
    layer.className = 'scribe-morph';
    // The strip's own tab hides and this stand-in replaces it pixel-for-pixel, then rides the room's top edge; without it the rising sheet would sweep up OVER the very tab the finger is pulling.
    // At full open the tab has exited through the viewer's clipped top edge, so the swap to the settled room is invisible at both endpoints.
    const mtab = document.createElement('div');
    mtab.className = 'scribe-morph-tab';
    mtab.innerHTML = CHEV_UP_SVG;
    mtab.style.transform = `translateY(${travel - lead - TAB_H}px)`; // the travel-0 endpoint, over the strip's tab
    stripElem.classList.add('scribe-tab-riding');

    /**
     * Fill a stand-in the strip had no render for.
     * @param {HTMLImageElement} img @param {number} n
     */
    const fillThumb = (img, n) => {
      doc.images.renderThumbnail(n, 200).then((blob) => {
        if (!blob || scene !== s) return;
        const url = URL.createObjectURL(blob);
        s.urls.push(url);
        img.src = url;
      }).catch(() => {});
    };
    const s = {
      layer,
      mtab,
      urls: /** @type {string[]} */ ([]),
      items: /** @type {Array<object>} */ ([]),
      dy: 0,
      travel,
      lead,
      dyFull,
      growPx,
      filmW,
      filmH,
      strideF,
      strideG: geo.strideX,
      cellW: geo.cellW,
      cxF,
      cxG,
      growBottom,
      aRow,
      anchorFloorY: growBottom - rowBoxH,
      finalYAnchor: finalY(aRow * cols),
      row,
      scroll0: row.scrollLeft,
    };

    for (const n of [...pages].sort((a, b) => a - b)) {
      const el = document.createElement('div');
      el.className = `scribe-morph-cell${n === activeN ? ' active' : ''}`;
      el.dataset.n = String(n);
      const clip = document.createElement('div');
      clip.className = 'scribe-morph-clip';
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      img.decoding = 'async';
      clip.appendChild(img);
      const lbl = document.createElement('div');
      lbl.className = 'scribe-morph-label';
      lbl.textContent = String(n + 1);
      el.append(clip, lbl);
      layer.appendChild(el);

      // The cached raster is unrotated, so rotation is a CSS transform.
      // A 90/270 img's box-swapped dimensions are re-set per-frame in frame() as the cell grows.
      const rot = (doc.pageMetrics && doc.pageMetrics[n] && doc.pageMetrics[n].rotation) || 0;
      if (rot % 180 === 90) {
        img.style.position = 'absolute';
        img.style.top = '50%';
        img.style.left = '50%';
        img.style.transform = `translate(-50%, -50%) rotate(${rot}deg)`;
      } else if (rot === 180) {
        img.style.transform = 'rotate(180deg)';
      }

      // Start from the pixels the user is already looking at: the strip's rendered thumbnail.
      const stripImg = cells[n].querySelector('img');
      if (stripImg && stripImg.src) img.src = stripImg.src;
      else if (doc.images) fillThumb(img, n);

      const d = n - mid;
      const rowN = Math.floor(n / cols);
      // Cells outside the anchor row get enough extra spread to clear the room's side edges by the end of the grow, so their jump to off-screen grid slots at the stage boundary is invisible.
      let flare = 0;
      if (rowN !== aRow) {
        const endX = cxG + d * geo.strideX;
        flare = d > 0
          ? Math.max(FLARE_PAD, roomW + FLARE_PAD - (endX - geo.cellW / 2))
          : -Math.max(FLARE_PAD, (endX + geo.cellW / 2) + FLARE_PAD);
      }
      s.items.push({
        el, img, lbl, d, rot, flare, row: rowN, boxH: geo.boxH(n), gx: geo.boxLeft(n), fy: finalY(n), active: n === activeN,
      });
    }

    // The real grid stays laid out underneath (visibility, not display, keeps its render pipeline live).
    panel.panelElem.style.visibility = 'hidden';
    roomHdElem.style.opacity = '0';
    roomHdElem.style.pointerEvents = 'none';
    roomElem.classList.add('dragging', 'open', 'morphing');
    roomElem.appendChild(layer);
    viewerElem.appendChild(mtab);
    scene = s;
    // A close starts at the open endpoint: paint it before the swap so the frame that replaces the real grid is pixel-identical to it.
    if (close) frame(s.dyFull);
    return true;
  }

  /**
   * Position everything for `dy` px of upward travel.
   * @param {number} dy
   */
  function frame(dy) {
    const s = scene;
    if (!s) return;
    s.dy = clamp(dy, 0, s.dyFull);
    const ty = s.travel - s.lead - s.dy; // room translate = its top edge in viewer coords
    roomElem.style.transform = `translateY(${ty}px)`;
    const p = s.dy / s.dyFull;
    const s1 = ez(clamp(s.dy / s.growPx, 0, 1));

    // The material blends from the strip's surface to the room's canvas as the grid takes shape; the riding tab is a nub on the same sheet, so it wears the same blend.
    const bg = `color-mix(in srgb, var(--scribe-canvas) ${Math.round(100 * ez(clamp(p / 0.5, 0, 1)))}%, var(--scribe-surface))`;
    roomElem.style.background = bg;
    s.mtab.style.background = bg;
    s.mtab.style.transform = `translateY(${ty - TAB_H}px)`;
    const hdo = clamp((p - 0.8) / 0.2, 0, 1);
    roomHdElem.style.opacity = String(hdo);
    roomHdElem.style.pointerEvents = hdo > 0.5 ? '' : 'none';

    // The anchor row sits on the bar's floor until the edge's hug line reaches it, rides 1:1 under the edge, then freezes at its final resting spot while the edge sweeps on.
    const yAnchor = Math.max(s.finalYAnchor, Math.min(s.anchorFloorY, ty + HUG));
    const lop = ez(clamp((p - s.growPx / s.dyFull) / 0.3, 0, 1));
    // Follow any scroll the strip has done since the scene was built, so the film endpoint is the strip as it will actually be revealed.
    const filmShift = s.scroll0 - s.row.scrollLeft;
    for (const it of s.items) {
      let x; let y; let w; let h;
      if (s.dy < s.growPx) {
        w = lerp(s.filmW, s.cellW, s1);
        h = lerp(s.filmH, it.boxH, s1);
        x = lerp(s.cxF + filmShift, s.cxG, s1) + it.d * lerp(s.strideF, s.strideG, s1) + it.flare * s1 - w / 2;
        // All cells share one top line, lerped from the film's to the grown anchor row's, so the hand-off to the riding sheet never jumps.
        // (Uniform pages make this exactly bottom-glued growth; mixed aspects land top-aligned like a grid row.)
        y = lerp(s.growBottom - s.filmH, s.anchorFloorY, s1);
      } else {
        w = s.cellW;
        h = it.boxH;
        x = it.gx;
        // Earlier rows are parked at their final spots for the edge to uncover; the anchor row and the rows trailing it ride as one rigid sheet.
        y = it.row < s.aRow ? it.fy : yAnchor + (it.fy - s.finalYAnchor);
      }
      it.el.style.left = `${x}px`;
      it.el.style.top = `${y - ty}px`;
      it.el.style.width = `${w}px`;
      it.el.style.height = `${h}px`;
      if (it.rot % 180 === 90) {
        it.img.style.width = `${h}px`;
        it.img.style.height = `${w}px`;
      }
      // The strip's hairline outline dissolves as cells take the grid's outline-free look; the active ring thickens from the strip's 2.5px to the grid's 3px.
      if (it.active) it.el.style.outlineWidth = `${lerp(2.5, 3, s1)}px`;
      else it.el.style.outlineColor = `rgba(0,0,0,${0.12 * (1 - s1)})`;
      it.lbl.style.opacity = String(lop);
    }
  }

  /**
   * Animate from the current travel to fully open (`commit`) or back to rest, along the same choreography the finger drove, then hand the room back and report the outcome.
   * @param {boolean} commit
   * @param {(committed: boolean) => void} [onDone]
   */
  function settle(commit, onDone) {
    const s = scene;
    if (!s) { if (onDone) onDone(false); return; }
    const target = commit ? s.dyFull : 0;
    if (raf) cancelAnimationFrame(raf);
    const step = () => {
      raf = 0;
      if (scene !== s) return;
      const d = target - s.dy;
      if (Math.abs(d) < 0.5) {
        frame(target);
        teardown(commit);
        if (onDone) onDone(commit);
        return;
      }
      frame(s.dy + d * SETTLE_RATE);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  return {
    begin: () => build(false),
    // Reverse scene: the open room collapses back into the strip.
    beginClose: () => build(true),
    frame,
    settle,
    isActive: () => !!scene,
    // A settle animation owns the scene; gesture frames must not steer it.
    settling: () => raf !== 0,
    // Immediate cancel for host-driven interruptions; safe when idle.
    abort: () => teardown(false),
  };
}
