// Drag-to-reorder subsystem for the page-thumbnails rail (see panels.js).
// Lifts the pressed page(s) into a floating ghost, shows the insertion line, auto-scrolls at the rail edges,
// and commits single- or multi-page moves in place by permuting the already-decoded thumbnails rather than re-rendering.
// All shared state and the core rail callbacks are reached through the `ctx` object built by `createThumbnailPanel`.

/** @typedef {import('./panels.js').ThumbRow} ThumbRow */

// Duration in ms of the row slide played when pages are reordered in place, so a move reads as a move rather than a snap.
const REORDER_SLIDE_MS = 160;
// Pointer travel in px from the press before a gesture becomes a drag; below it the press stays a plain click/selection.
const DRAG_THRESHOLD = 5;
// Pointer distance from the scroll area's top/bottom edge that auto-scrolls the rail during a drag, and its speed.
const AUTOSCROLL_EDGE = 36;
const AUTOSCROLL_SPEED = 14;

/**
 * @typedef {object} ThumbDrag
 * @property {number} from - Page index pressed to start the drag.
 * @property {boolean} group - Whether the whole multi-selection is moving, not just `from`.
 * @property {Set<number>} pages - Indices of every page being dragged; kept mounted so their thumbnails survive a long drag.
 * @property {number} startX @property {number} startY - Pointer position at press, for the click/drag threshold.
 * @property {boolean} started - Whether the press has crossed the threshold into a drag.
 * @property {?HTMLElement} ghost - Floating copy of the page tracking the cursor.
 * @property {?HTMLElement} line - Insertion-position accent line.
 * @property {number} gap - Current insertion gap (0..pageCount).
 * @property {number} autoDir - Edge auto-scroll direction (-1, 0, 1).
 * @property {number} rafId - Auto-scroll animation-frame handle.
 * @property {number} lastX @property {number} lastY - Last pointer position, so auto-scroll can re-place the indicator while the pointer is held still.
 * @property {number} grabDX @property {number} grabDY - Offset of the grab point within the thumbnail.
 */

/**
 * The slice of `createThumbnailPanel`'s state and callbacks the reorder subsystem reads and drives.
 * Geometry arrays and reassignable scalars are exposed as live getters/setters so a write on either side is seen by the other.
 * @typedef {object} ReorderContext
 * @property {import('../../viewer.js').ScribeViewer} scribe
 * @property {HTMLDivElement} scrollElem - The scrollable rail content area.
 * @property {HTMLDivElement} panelElem - The panel root (focused when a drag starts).
 * @property {HTMLDivElement} batchBar - The floating batch-action pill, hidden during a drag.
 * @property {Set<number>} selected - The batch selection (mutated in place by the core).
 * @property {Map<number, ThumbRow>} mounted - The currently mounted rows (mutated in place).
 * @property {number} PAD - Panel top padding in px.
 * @property {number[]} offsets - Cumulative row tops (live).
 * @property {number[]} heights - Full row heights (live).
 * @property {number} pageCount - Page count of the current document (live).
 * @property {number} THUMB_W - Thumbnail image (cell) width in px.
 * @property {number} gridCols - Columns in the current layout (live); 1 is the rail, more is the grid.
 * @property {number[]} rowStrides - Per-row vertical stride in px (live, grid mode), indexed by row; empty in the rail.
 * @property {(y: number) => number} rowAt - Largest page index whose row top is at or above content-y `y` (live geometry).
 * @property {number} GRID_GAP - Gap in px between grid cells.
 * @property {number} activePage - The single page shown in the main viewer; reorder re-keys it on a move.
 * @property {?ThumbDrag} drag - The in-flight drag, or null. Owned here; read by the core's `updateWindow`.
 * @property {boolean} suppressClick - Set so the click ending a drag does not also select.
 * @property {() => void} computeGeometry
 * @property {(entry: ThumbRow, n: number) => void} restyleRow
 * @property {(immediate?: boolean) => void} updateWindow
 * @property {() => void} updateBatchToolbar
 * @property {(fn: (n: number) => number) => void} remapSelection
 * @property {() => void} closeContextMenu
 * @property {() => void} cancelCut
 */

/**
 * New index of the page currently at old index `oi` after the page at `from` is moved to `to`.
 * @param {number} oi @param {number} from @param {number} to @returns {number}
 */
function newIndexFor(oi, from, to) {
  if (oi === from) return to;
  if (from < to) return oi > from && oi <= to ? oi - 1 : oi;
  return oi >= to && oi < from ? oi + 1 : oi;
}

/**
 * New index of the page at old index `oi` after the pages in `sortedSel` are pulled out and re-inserted as a block starting at `to` (a post-removal index).
 * Mirrors `ScribeDoc.movePages`.
 * @param {number} oi
 * @param {Array<number>} sortedSel
 * @param {number} to
 * @returns {number}
 */
function multiMoveIndex(oi, sortedSel, to) {
  const rank = sortedSel.indexOf(oi);
  if (rank >= 0) return to + rank;
  const reduced = oi - sortedSel.filter((s) => s < oi).length;
  return reduced < to ? reduced : reduced + sortedSel.length;
}

/**
 * Slide the displaced rows for a reorder by transitioning each non-dragged row's `top` so it visibly slides to its new slot.
 * The transition is cleared once the slide ends so later `top` changes (scroll, remounts) stay instant.
 * Call before the rows are restyled to their new positions.
 * @param {Array<[number, ThumbRow]>} snapshot - The [oldIndex, row] pairs being repositioned.
 * @param {Set<number>} movedOld - Old indices of the dragged page(s), which fly in rather than slide.
 */
function slideRows(snapshot, movedOld) {
  /** @type {Array<ThumbRow>} */
  const sliding = [];
  for (const [oi, entry] of snapshot) {
    if (movedOld.has(oi)) continue;
    // Cells move in both axes when the grid reflows around a drop, so slide top and left (left is a no-op in the rail).
    entry.thumbElem.style.transition = `top ${REORDER_SLIDE_MS}ms ease, left ${REORDER_SLIDE_MS}ms ease`;
    sliding.push(entry);
  }
  setTimeout(() => {
    for (const e of sliding) e.thumbElem.style.transition = '';
  }, REORDER_SLIDE_MS + 20);
}

/**
 * Fly each just-dropped page from where it was released to its destination slot, then reveal the real rows.
 * The copies animate on `document.body` so they are not clipped at the panel edge, and each flies to its own slot so a multi-page drop spreads into place.
 * The caller keeps the real rows hidden (opacity 0) until their copy arrives, so no duplicate shows mid-flight.
 * @param {?HTMLElement} ghost - The drag ghost (on `document.body`); removed here, its position is the flight start.
 * @param {Array<ThumbRow>} targetEntries - The dropped rows, revealed as their copies land.
 */
function dealRows(ghost, targetEntries) {
  const startRect = ghost ? ghost.getBoundingClientRect() : null;
  if (ghost) ghost.remove();
  if (!startRect || targetEntries.length === 0) {
    for (const entry of targetEntries) entry.thumbElem.style.opacity = '';
    return;
  }
  // Cap the flown copies so a very large multi-page drop does not spawn a swarm; any pages beyond the cap just appear.
  const FLY_CAP = 24;
  const flying = targetEntries.slice(0, FLY_CAP);
  for (const entry of targetEntries.slice(FLY_CAP)) entry.thumbElem.style.opacity = '';

  /** @type {Array<HTMLElement>} */
  const clones = [];
  flying.forEach((entry, i) => {
    const box = entry.imgElem.parentElement;
    const destRect = box ? box.getBoundingClientRect() : null;
    if (!destRect || destRect.width === 0) return;
    // Start each copy stacked at the cursor in the drag ghost's fan order (front copy on top) for a seamless hand-off.
    const off = Math.min(i, 2) * 7;
    const clone = document.createElement('div');
    clone.style.cssText = 'position:fixed;margin:0;overflow:hidden;background:#fff;border-radius:2px;'
      + `box-shadow:0 8px 22px rgba(0,0,0,.45);pointer-events:none;z-index:${9999 - i};`
      + `left:${destRect.left}px;top:${destRect.top}px;width:${destRect.width}px;height:${destRect.height}px;`
      + `transform:translate(${startRect.left + off - destRect.left}px,${startRect.top + off - destRect.top}px)`;
    const imgClone = /** @type {HTMLImageElement} */ (entry.imgElem.cloneNode(true));
    if (!imgClone.style.width) { imgClone.style.width = '100%'; imgClone.style.height = '100%'; }
    imgClone.style.objectFit = 'contain';
    imgClone.style.display = 'block';
    clone.appendChild(imgClone);
    document.body.appendChild(clone);
    clones.push(clone);
  });
  // Commit the start offsets, then transition each copy to its slot (FLIP).
  if (clones.length) clones[0].getBoundingClientRect();
  for (const clone of clones) {
    clone.style.transition = `transform ${REORDER_SLIDE_MS}ms ease`;
    clone.style.transform = 'translate(0, 0)';
  }
  setTimeout(() => {
    for (const entry of flying) entry.thumbElem.style.opacity = '';
    for (const clone of clones) clone.remove();
  }, REORDER_SLIDE_MS + 20);
}

/**
 * Wire drag-to-reorder onto the thumbnail rail.
 * Returns the per-row pointerdown handler (attached in each mounted row) and a teardown that aborts an in-flight drag.
 * @param {ReorderContext} ctx
 * @returns {{ onThumbPointerDown: (e: PointerEvent, n: number) => void, cancelDrag: () => void }}
 */
export function installPageReorder(ctx) {
  /**
   * Insertion gap (0..pageCount) under the cursor.
   * @param {number} clientX @param {number} clientY @returns {number}
   */
  function insertionGapAt(clientX, clientY) {
    const rect = ctx.scrollElem.getBoundingClientRect();
    const contentY = clientY - rect.top + ctx.scrollElem.scrollTop - ctx.PAD;
    if (ctx.gridCols <= 1) {
      let g = 0;
      while (g < ctx.pageCount && contentY > ctx.offsets[g] + ctx.heights[g] / 2) g += 1;
      return g;
    }
    const cols = ctx.gridCols;
    const rows = Math.ceil(ctx.pageCount / cols);
    const row = Math.max(0, Math.min(rows - 1, Math.floor(ctx.rowAt(contentY) / cols)));
    const contentX = clientX - rect.left;
    let col = 0;
    while (col < cols && contentX > ctx.PAD + col * (ctx.THUMB_W + ctx.GRID_GAP) + ctx.THUMB_W / 2) col += 1;
    return Math.max(0, Math.min(ctx.pageCount, row * cols + col));
  }

  /**
   * Position the insertion indicator for gap `g`.
   * @param {number} g
   */
  function placeInsertLine(g) {
    const d = ctx.drag;
    if (!d || !d.line) return;
    const line = d.line;
    if (ctx.gridCols <= 1) {
      // Rail: a horizontal line over the single column, aligned to the thumbnail (which the panel can now be wider than).
      const y = g < ctx.pageCount ? ctx.offsets[g] : ctx.offsets[ctx.pageCount - 1] + ctx.heights[ctx.pageCount - 1];
      line.classList.remove('vertical');
      line.style.left = `${ctx.PAD}px`;
      line.style.right = 'auto';
      line.style.width = `${ctx.THUMB_W}px`;
      line.style.height = '';
      line.style.top = `${ctx.PAD + y}px`;
      return;
    }
    const cols = ctx.gridCols;
    const atEnd = g >= ctx.pageCount;
    const idx = atEnd ? ctx.pageCount - 1 : g;
    const cellLeft = ctx.PAD + (idx % cols) * (ctx.THUMB_W + ctx.GRID_GAP);
    line.classList.add('vertical');
    line.style.left = `${atEnd ? cellLeft + ctx.THUMB_W + ctx.GRID_GAP / 2 : cellLeft - ctx.GRID_GAP / 2}px`;
    line.style.top = `${ctx.PAD + ctx.offsets[idx]}px`;
    line.style.height = `${ctx.rowStrides[Math.floor(idx / cols)] - ctx.GRID_GAP}px`;
    line.style.width = '';
  }

  /**
   * Move a page and update the rail in place, reusing the already-decoded thumbnails.
   * A full `rebuild` would revoke and re-render every image, flashing the rail white, so instead it permutes the existing images,
   * relocating and relabelling rows rather than tearing them down.
   * `updateWindow` then settles the visible set, reusing each kept row's image and rendering only genuinely-new positions.
   * @param {number} from
   * @param {number} to
   * @returns {Array<ThumbRow>} The dragged row, now placed (hidden) at its destination slot, for the ghost to settle onto.
   */
  function reorderPages(from, to) {
    ctx.cancelCut();
    const keepScroll = ctx.scrollElem.scrollTop;
    const snapshot = [...ctx.mounted];
    const movedOld = new Set([from]);
    ctx.mounted.clear();

    ctx.scribe.movePage(from, to);
    ctx.computeGeometry();
    // The active page and any selection follow their content to the new indices.
    if (ctx.activePage >= 0) ctx.activePage = newIndexFor(ctx.activePage, from, to);
    ctx.remapSelection((s) => newIndexFor(s, from, to));

    // The pages the drop displaces slide around it (the dragged page itself is flown in by the ghost on release).
    slideRows(snapshot, movedOld);
    /** @type {Array<ThumbRow>} */
    const movedEntries = [];
    for (const [oi, entry] of snapshot) {
      const ni = newIndexFor(oi, from, to);
      ctx.restyleRow(entry, ni);
      ctx.mounted.set(ni, entry);
      if (movedOld.has(oi)) movedEntries.push(entry);
    }

    ctx.scrollElem.scrollTop = keepScroll;
    ctx.updateWindow();
    ctx.updateBatchToolbar();
    return movedEntries;
  }

  /**
   * Move every selected page to a contiguous block at drop gap `gap`, in place (the group-drag counterpart of `reorderPages`).
   * The pages keep their relative order and become the new selection at their landing indices.
   * @param {number} gap - Insertion gap in 0..pageCount.
   * @returns {Array<ThumbRow>|undefined} The dragged rows placed (hidden) at their slots for the ghost to settle onto, or undefined if nothing moved.
   */
  function moveSelection(gap) {
    if (ctx.selected.size === 0) return undefined;
    ctx.cancelCut();
    const sortedSel = [...ctx.selected].sort((a, b) => a - b);
    const to = gap - sortedSel.filter((s) => s < gap).length;
    // No move if the selection already forms a contiguous block starting at `to`.
    if (sortedSel.every((s, i) => s === to + i)) return undefined;
    const keepScroll = ctx.scrollElem.scrollTop;
    const snapshot = [...ctx.mounted];
    const movedOld = new Set(sortedSel);
    ctx.mounted.clear();

    ctx.scribe.movePages(sortedSel, to);
    ctx.computeGeometry();
    if (ctx.activePage >= 0) ctx.activePage = multiMoveIndex(ctx.activePage, sortedSel, to);
    ctx.remapSelection((s) => multiMoveIndex(s, sortedSel, to));

    // The pages the drop displaces slide around them (the dragged pages are flown in by the ghost on release).
    slideRows(snapshot, movedOld);
    /** @type {Array<ThumbRow>} */
    const movedEntries = [];
    for (const [oi, entry] of snapshot) {
      const ni = multiMoveIndex(oi, sortedSel, to);
      ctx.restyleRow(entry, ni);
      ctx.mounted.set(ni, entry);
      if (movedOld.has(oi)) movedEntries.push(entry);
    }

    ctx.scrollElem.scrollTop = keepScroll;
    ctx.updateWindow();
    ctx.updateBatchToolbar();
    return movedEntries;
  }

  /**
   * Lift the pressed page into a floating ghost and show the insertion line.
   * @param {number} clientX @param {number} clientY
   */
  function startDrag(clientX, clientY) {
    const d = ctx.drag;
    if (!d) return;
    d.started = true;
    ctx.suppressClick = true;
    ctx.closeContextMenu();
    // The floating pill is anchored to the selection's resting position, which the drag is about to disturb, so hide it for the duration.
    // `endDragVisuals` restores it.
    ctx.batchBar.style.display = 'none';
    // Dragging a page that is part of a 2+ selection moves the whole group; otherwise it is a single-page move.
    d.group = ctx.selected.has(d.from) && ctx.selected.size >= 2;
    // Track every page in the drag so `updateWindow` keeps their rows mounted even when they scroll far off-screen (e.g. dragging from page 1 to page 20).
    // Otherwise they would be unmounted, their thumbnails revoked, and they would flash white while re-rendering after the drop.
    d.pages = d.group ? new Set(ctx.selected) : new Set([d.from]);
    const entry = ctx.mounted.get(d.from);
    const srcBox = entry && entry.thumbElem.querySelector('.scribe-thumb-box');
    const rect = srcBox ? srcBox.getBoundingClientRect() : {
      left: clientX - ctx.THUMB_W / 2, top: clientY, width: ctx.THUMB_W, height: ctx.THUMB_W,
    };
    const dimSet = d.group ? ctx.selected : new Set([d.from]);
    for (const [n, ent] of ctx.mounted) if (dimSet.has(n)) ent.thumbElem.classList.add('dragging');

    // The ghost lives on `document.body`, outside the panel's scoped stylesheet and any transformed ancestor.
    // So it carries its own inline styling and uses `position: fixed` to follow the cursor without being clipped.
    // It is a bare container, with each page a `card` child so a group drag can fan several behind the front one.
    const ghost = document.createElement('div');
    ghost.style.cssText = 'position:fixed;margin:0;pointer-events:none;z-index:9999;'
      + `width:${rect.width}px;height:${rect.height}px`;

    // Gather the page images to stack, front first: the grabbed page, then the other selected pages, capped at 3 so dragging a large selection still shows a tidy fan rather than a deep pile.
    const cardCount = d.group ? Math.min(3, ctx.selected.size) : 1;
    /** @type {Array<HTMLImageElement>} */
    const imgs = [];
    /** @param {number} m */
    const pushImg = (m) => { const e = ctx.mounted.get(m); if (e && e.imgElem) imgs.push(e.imgElem); };
    pushImg(d.from);
    if (d.group) {
      for (const s of [...ctx.selected].sort((a, b) => a - b)) {
        if (imgs.length >= cardCount) break;
        if (s !== d.from) pushImg(s);
      }
    }

    // Build back-to-front so the grabbed page sits on top at the cursor and the rest fan down-right behind it.
    // Only the fanned cards are tilted, keeping the front card flat so a tiny accidental drag does not flash a rotation.
    for (let i = cardCount - 1; i >= 0; i -= 1) {
      const card = document.createElement('div');
      const off = i * 7;
      card.style.cssText = 'position:absolute;left:0;top:0;margin:0;overflow:hidden;background:#fff;border-radius:2px;'
        + `box-shadow:0 8px 22px rgba(0,0,0,.45);width:${rect.width}px;height:${rect.height}px;opacity:.95;`
        + `transform:translate(${off}px,${off}px) rotate(${i === 0 ? 0 : 2 + i * 3}deg);z-index:${cardCount - i}`;
      const srcImg = imgs[i] || imgs[0];
      if (srcImg) {
        const img = /** @type {HTMLImageElement} */ (srcImg.cloneNode(true));
        // A rotated page carries inline sizing already.
        // The upright case relies on the scoped rule, which does not reach `document.body`, so give it the same fit explicitly.
        if (!img.style.width) { img.style.width = '100%'; img.style.height = '100%'; }
        img.style.objectFit = 'contain';
        img.style.display = 'block';
        card.appendChild(img);
      }
      ghost.appendChild(card);
    }
    if (d.group) {
      // A count badge over the front card shows how many pages are moving, including those beyond the 3 fanned.
      const badge = document.createElement('div');
      badge.textContent = String(ctx.selected.size);
      badge.style.cssText = 'position:absolute;top:5px;right:5px;min-width:18px;height:18px;padding:0 6px;z-index:10;'
        + 'display:flex;align-items:center;justify-content:center;border-radius:4px;background:rgba(24,27,30,.92);'
        + 'border:1px solid rgba(255,255,255,.25);color:#fff;font:600 11px sans-serif;box-sizing:border-box';
      ghost.appendChild(badge);
    }
    document.body.appendChild(ghost);
    d.ghost = ghost;
    d.grabDX = clientX - rect.left;
    d.grabDY = clientY - rect.top;

    const line = document.createElement('div');
    line.className = 'scribe-thumb-insert';
    ctx.scrollElem.appendChild(line);
    d.line = line;

    document.body.style.cursor = 'grabbing';
    d.rafId = requestAnimationFrame(autoScrollTick);
    moveDrag(clientX, clientY);
  }

  /**
   * Track the cursor with the ghost and the insertion line, and arm edge auto-scroll.
   * @param {number} clientX @param {number} clientY
   */
  function moveDrag(clientX, clientY) {
    const d = ctx.drag;
    if (!d || !d.ghost || !d.line) return;
    d.lastX = clientX;
    d.lastY = clientY;
    d.ghost.style.left = `${clientX - d.grabDX}px`;
    d.ghost.style.top = `${clientY - d.grabDY}px`;
    d.gap = insertionGapAt(clientX, clientY);
    placeInsertLine(d.gap);
    const rect = ctx.scrollElem.getBoundingClientRect();
    const max = ctx.scrollElem.scrollHeight - ctx.scrollElem.clientHeight;
    if (clientY < rect.top + AUTOSCROLL_EDGE && ctx.scrollElem.scrollTop > 0) d.autoDir = -1;
    else if (clientY > rect.bottom - AUTOSCROLL_EDGE && ctx.scrollElem.scrollTop < max) d.autoDir = 1;
    else d.autoDir = 0;
  }

  /** While the pointer is held near an edge, scroll the rail and keep the insertion line under it. */
  function autoScrollTick() {
    const d = ctx.drag;
    if (!d || !d.started) return;
    if (d.autoDir !== 0) {
      const max = ctx.scrollElem.scrollHeight - ctx.scrollElem.clientHeight;
      const next = Math.max(0, Math.min(max, ctx.scrollElem.scrollTop + d.autoDir * AUTOSCROLL_SPEED));
      if (next !== ctx.scrollElem.scrollTop) {
        ctx.scrollElem.scrollTop = next;
        ctx.updateWindow();
        d.gap = insertionGapAt(d.lastX, d.lastY);
        placeInsertLine(d.gap);
      }
    }
    d.rafId = requestAnimationFrame(autoScrollTick);
  }

  /**
   * Remove the insertion line, edge-scroll loop, and drag styling, applying no move.
   * The ghost is removed too unless `keepGhost` is set, in which case the caller owns it (e.g. to fly it into the drop slot on release).
   * @param {ThumbDrag} d
   * @param {boolean} [keepGhost=false]
   */
  function endDragVisuals(d, keepGhost = false) {
    if (d.rafId) cancelAnimationFrame(d.rafId);
    if (d.ghost && !keepGhost) d.ghost.remove();
    if (d.line) d.line.remove();
    document.body.style.cursor = '';
    for (const [, entry] of ctx.mounted) entry.thumbElem.classList.remove('dragging');
    ctx.updateBatchToolbar();
  }

  /** @param {PointerEvent} e @param {number} n */
  function onThumbPointerDown(e, n) {
    ctx.suppressClick = false;
    // Pressing a thumbnail makes the rail the active pane, so the arrow keys navigate pages from here on.
    ctx.panelElem.focus({ preventScroll: true });
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const target = /** @type {Element} */ (e.target);
    // The rotate and delete badges handle their own clicks.
    if (target.closest('.scribe-thumb-rotate, .scribe-thumb-delete')) return;
    // On touch, only the grip (which opts out of native scrolling) starts a reorder.
    // A touch elsewhere scrolls the rail and a tap selects, while a mouse can drag the whole thumbnail.
    if (e.pointerType === 'touch' && !target.closest('.scribe-thumb-grip')) return;
    ctx.drag = {
      from: n,
      group: false,
      pages: new Set([n]),
      startX: e.clientX,
      startY: e.clientY,
      started: false,
      ghost: null,
      line: null,
      gap: -1,
      autoDir: 0,
      rafId: 0,
      lastX: e.clientX,
      lastY: e.clientY,
      grabDX: 0,
      grabDY: 0,
    };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragUp);
  }

  /** @param {PointerEvent} e */
  function onDragMove(e) {
    const d = ctx.drag;
    if (!d) return;
    if (d.started) { moveDrag(e.clientX, e.clientY); return; }
    if (Math.abs(e.clientX - d.startX) + Math.abs(e.clientY - d.startY) < DRAG_THRESHOLD) return;
    // Reordering is an editor action and needs at least two pages; otherwise the gesture stays a plain selection.
    if (!(ctx.scribe.opt && ctx.scribe.opt.enablePageEditing) || ctx.pageCount < 2) { cancelDrag(); return; }
    startDrag(e.clientX, e.clientY);
  }

  /** @param {PointerEvent} e */
  function onDragUp(e) {
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragUp);
    const d = ctx.drag;
    ctx.drag = null;
    if (!d || !d.started) return;
    // Keep the ghost (it lives on document.body, so the panel does not clip it) and fly it into the drop slot, with the placed row hidden until it lands.
    // Animating the ghost rather than the in-rail row keeps the part of the page dragged out over the viewer from being clipped at the panel edge mid-animation.
    endDragVisuals(d, true);
    const gap = insertionGapAt(e.clientX, e.clientY);
    let moved;
    if (gap === d.from || gap === d.from + 1) {
      // Released over the grabbed page's own slot, so the drag is a no-op.
      // Without this guard a group drop would still compact a non-contiguous selection into a block, reordering pages the user never dragged.
      moved = undefined;
    } else if (d.group) {
      // The selected pages move together to the drop gap; `moveSelection` returns undefined if already a block there.
      moved = moveSelection(gap);
    } else {
      // `movePage`'s target is the index after the page is removed, so a gap below the source shifts down by one.
      const to = gap <= d.from ? gap : gap - 1;
      moved = (to < 0 || to >= ctx.pageCount) ? undefined : reorderPages(d.from, to);
    }
    if (!moved) {
      // Nothing reordered: settle the ghost back onto the dragged page's existing slot.
      ctx.updateWindow();
      const home = ctx.mounted.get(d.from);
      moved = home ? [home] : [];
    }
    for (const entry of moved) entry.thumbElem.style.opacity = '0';
    dealRows(d.ghost, moved);
  }

  /** Abort any in-flight drag (used on teardown). */
  function cancelDrag() {
    const d = ctx.drag;
    if (!d) return;
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragUp);
    if (d.started) endDragVisuals(d);
    ctx.drag = null;
  }

  return { onThumbPointerDown, cancelDrag };
}
