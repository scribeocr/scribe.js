// Drag-to-reorder subsystem for the page-thumbnails rail (see panels.js).
// Lifts the pressed page(s) into a floating ghost, shows the insertion line, auto-scrolls at the rail edges,
// and commits single- or multi-page moves in place by permuting the already-decoded thumbnails rather than re-rendering.
// All shared state and the core rail callbacks are reached through the `ctx` object built by `createThumbnailPanel`.

/** @typedef {import('./panels.js').ThumbRow} ThumbRow */

// Duration in ms of the row slide played when pages are reordered in place, so a move reads as a move rather than a snap.
// Also drives the page-delete neighbour slide in panels.js.
export const REORDER_SLIDE_MS = 160;
// Pointer travel in px from the press before a gesture becomes a drag; below it the press stays a plain click/selection.
const DRAG_THRESHOLD = 5;
// Pointer distance from the scroll area's top/bottom edge that auto-scrolls the rail during a drag, and its speed.
const AUTOSCROLL_EDGE = 36;
const AUTOSCROLL_SPEED = 14;

// Touch-reorder gesture thresholds, for any touch outside the phone room's modes: hold to lift; a sideways slide first gathers a contiguous run.
const LIFT_HOLD_MS = 250; // still-press before a page lifts for reorder
const LIFT_MOVE_SLOP = 9; // finger travel that cancels the lift (read as a scroll) before it fires
const SWEEP_DX = 12; // horizontal travel before the lift that starts a run-gathering sweep
const SWEEP_SETTLE_MS = 240; // pause during a sweep that collapses the gathered run into the hand
const MENU_SLOP = 8; // a lift released within this (never dragged) opens the page menu instead of moving

// Phone Pages-room gestures (see ReorderContext.roomMode).
const PEEK_HOLD_MS = 400; // still-press in browse mode before the page preview shows
const DBL_TAP_MS = 300; // second browse-mode tap on the same page within this opens it in the viewer
// Pointer + scroll travel in px since the last committed insertion gap before a different gap may commit.
// Without it, a finger resting on a razor-thin derivation boundary (or a mid-reflow cell sliding under a still finger) re-derives alternating gaps, shuffling the preview back and forth.
const GAP_HYSTERESIS = 12;
// How long a touch drag must target the same insertion gap before the cells reflow to open it, since reflowing at every crossed gap reads as a disorienting swirl on a long move.
// The settle gates only the preview; a release always commits immediately.
const REFLOW_SETTLE_MS = 250;

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
 * @property {number[]} lefts - Per-cell left offsets (live); grid x, or PAD in the rail.
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
 * @property {(clientX: number, clientY: number, n: number) => void} openContextMenu - Open the per-page menu (touch release-in-place).
 * @property {() => void} cancelCut
 * @property {?('browse'|'edit')} roomMode - Phone Pages-room interaction mode: 'browse' is read-only, 'edit' carries the mutations.
 *   Null outside the room, which keeps the hold-to-lift/sweep/release-menu gestures.
 * @property {() => boolean} gridInMotion - Whether the grid scrolled within the last settle window; a press on a moving grid catches the scroll instead of acting.
 * @property {(n: number) => void} peekShow - Show (or scrub to) the browse-mode page preview.
 * @property {() => void} peekHide
 * @property {(n: number) => void} openPage - Open page `n` in the viewer (browse-mode double-tap).
 * @property {(n: number) => void} toggleRoomSelect - Toggle page `n` in the room-Edit selection.
 * @property {(n: number, want: boolean) => void} setRoomSelect - Set page `n`'s selection to `want` (checkbox range paint).
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
    for (const entry of targetEntries) { entry.thumbElem.style.opacity = ''; entry.thumbElem.style.transition = ''; }
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
    for (const entry of targetEntries) { entry.thumbElem.style.opacity = ''; entry.thumbElem.style.transition = ''; }
    for (const clone of clones) clone.remove();
  }, REORDER_SLIDE_MS + 20);
}

/**
 * Build the floating drag ghost on document.body: a fan of up to three page images, front on top, with a count badge.
 * @param {Array<HTMLImageElement>} imgs - Page images to stack, front first (already capped by the caller).
 * @param {{width: number, height: number}} rect - Size of the front card.
 * @param {number} badgeCount - Total pages moving; a badge shows when >1.
 * @returns {HTMLDivElement}
 */
function buildGhost(imgs, rect, badgeCount) {
  const ghost = document.createElement('div');
  // position: fixed on document.body follows the pointer without being clipped by a transformed ancestor.
  ghost.style.cssText = 'position:fixed;margin:0;pointer-events:none;z-index:9999;'
    + `width:${rect.width}px;height:${rect.height}px`;
  const cardCount = imgs.length;
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
  if (badgeCount > 1) {
    const badge = document.createElement('div');
    badge.textContent = String(badgeCount);
    badge.style.cssText = 'position:absolute;top:5px;right:5px;min-width:18px;height:18px;padding:0 6px;z-index:10;'
      + 'display:flex;align-items:center;justify-content:center;border-radius:4px;background:rgba(24,27,30,.92);'
      + 'border:1px solid rgba(255,255,255,.25);color:#fff;font:600 11px sans-serif;box-sizing:border-box';
    ghost.appendChild(badge);
  }
  document.body.appendChild(ghost);
  return ghost;
}

/**
 * Wire drag-to-reorder onto the thumbnail rail.
 * Returns the per-row pointerdown handler (attached in each mounted row) and a teardown that aborts an in-flight drag.
 * @param {ReorderContext} ctx
 * @returns {{
 *   onThumbPointerDown: (e: PointerEvent, n: number) => void,
 *   onChkPointerDown: (e: PointerEvent, n: number) => void,
 *   cancelDrag: () => void,
 *   insertionGapAt: (clientX: number, clientY: number) => number,
 *   placeInsertLineAt: (line: HTMLElement, g: number) => void,
 * }}
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
    // Below the last row the void means the end of the document.
    // The row clamp below would otherwise resolve it to an x-dependent slot inside the last row.
    if (contentY > ctx.offsets[ctx.pageCount - 1] + ctx.heights[ctx.pageCount - 1]) return ctx.pageCount;
    const rows = Math.ceil(ctx.pageCount / cols);
    const row = Math.max(0, Math.min(rows - 1, Math.floor(ctx.rowAt(contentY) / cols)));
    const contentX = clientX - rect.left;
    let col = 0;
    while (col < cols && contentX > ctx.PAD + col * (ctx.THUMB_W + ctx.GRID_GAP) + ctx.THUMB_W / 2) col += 1;
    return Math.max(0, Math.min(ctx.pageCount, row * cols + col));
  }

  /**
   * Position an insertion-indicator line for gap `g`.
   * Takes the `line` element because the reorder drag and the file-drop preview each own a separate `.scribe-thumb-insert`.
   * @param {HTMLElement} line
   * @param {number} g
   */
  function placeInsertLineAt(line, g) {
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
      // Instant placement: dealRows measures the landing row this same frame, and a lingering slide transition would hand it a mid-flight rect.
      if (movedOld.has(oi)) entry.thumbElem.style.transition = 'none';
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
      // Instant placement: dealRows measures the landing rows this same frame, and a lingering slide transition would hand it a mid-flight rect.
      // dealRows clears the 'none' when the copies land.
      if (movedOld.has(oi)) entry.thumbElem.style.transition = 'none';
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
    d.ghost = buildGhost(imgs, rect, d.group ? ctx.selected.size : 1);
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
    placeInsertLineAt(d.line, d.gap);
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
        if (d.line) placeInsertLineAt(d.line, d.gap);
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
    // Touch uses the hold-to-lift / sweep-to-gather gesture (below); the mouse keeps the ghost + insertion-line drag.
    if (e.pointerType === 'touch') { onThumbTouchStart(e, n); return; }
    if (e.button !== 0) return;
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

  // A separate front-end from the mouse ghost/insertion-line drag above; both commit through reorderPages/moveSelection and settle with dealRows.
  /** @type {?object} */
  let touch = null;
  let lastTouchT = 0;
  // Page and release time of the last clean browse-mode tap, for the double-tap-to-open.
  /** @type {?{n: number, t: number}} */
  let lastTap = null;

  /**
   * The non-lifted page cell under a point, hit-tested against the live (reflowed) layout.
   * Returns null over the open gap or empty space.
   * @param {number} clientX @param {number} clientY @returns {?{p: number, rect: DOMRect}}
   */
  function cellUnderPoint(clientX, clientY) {
    const el = document.elementFromPoint(clientX, clientY);
    const t = el && 'closest' in el ? el.closest('.scribe-thumb') : null;
    if (!t || !ctx.scrollElem.contains(t)) return null;
    const p = Number(t.dataset.page);
    if (!Number.isFinite(p) || touch.pages.has(p)) return null; // ignore the pages being carried
    return { p, rect: t.getBoundingClientRect() };
  }

  /**
   * Update the insertion gap from the cell under the thumb: before it (gap = p) or after it (gap = p + 1), in the original 0..pageCount index space the commit expects.
   * Unchanged over the open gap, so the drop point holds steady.
   * @param {number} clientX @param {number} clientY
   */
  function updateGap(clientX, clientY) {
    // Hit-testing the live (reflowed) layout, not static slot geometry, keeps the previewed gap and the committed move in agreement.
    let hit = cellUnderPoint(clientX, clientY);
    let after;
    if (hit) {
      after = ctx.gridCols > 1
        ? clientX > hit.rect.left + hit.rect.width / 2
        : clientY > hit.rect.top + hit.rect.height / 2;
    } else {
      // A null hit normally means "hold steady", but past the end of the document (below the last row, or right of the last page) it is unambiguous intent for the end gap.
      let lastN = ctx.pageCount - 1;
      while (lastN >= 0 && touch.pages.has(lastN)) lastN -= 1;
      const entry = lastN >= 0 ? ctx.mounted.get(lastN) : null;
      const box = entry && entry.thumbElem.querySelector('.scribe-thumb-box');
      if (!box) return;
      const r = box.getBoundingClientRect();
      if (!(clientY > r.bottom || (clientY >= r.top && clientX > r.right))) return;
      hit = { p: lastN, rect: r };
      after = true;
    }
    const gap = after ? hit.p + 1 : hit.p;
    if (gap === touch.gap) return;
    // Scroll distance counts as travel so edge auto-scroll keeps updating under a still finger.
    const travel = Math.hypot(clientX - touch.gapX, clientY - touch.gapY)
      + Math.abs(ctx.scrollElem.scrollTop - touch.gapScroll);
    if (travel < GAP_HYSTERESIS) return;
    touch.gap = gap;
    touch.gapX = clientX;
    touch.gapY = clientY;
    touch.gapScroll = ctx.scrollElem.scrollTop;
    placeTouchLine(hit, after);
    if (touch.reflowT) clearTimeout(touch.reflowT);
    touch.reflowT = setTimeout(() => {
      if (!touch || !touch.lifted) return;
      touch.reflowT = 0;
      if (touch.gap !== gap || touch.reflowedGap === gap) return;
      touch.reflowedGap = gap;
      previewReflow(gap);
      if (touch.line) touch.line.style.display = 'none'; // the opened gap takes over as the marker
    }, REFLOW_SETTLE_MS);
  }

  /**
   * Place (and show) the touch drag's insertion line at the committed gap.
   * @param {{p: number, rect: DOMRect}} hit - The live rect anchors the line; after a reflow, static slot geometry would mark the wrong boundary by one slot.
   * @param {boolean} after
   */
  function placeTouchLine(hit, after) {
    if (!touch.line) {
      touch.line = document.createElement('div');
      touch.line.className = 'scribe-thumb-insert';
      ctx.scrollElem.appendChild(touch.line);
    }
    const line = touch.line;
    line.style.display = '';
    const sRect = ctx.scrollElem.getBoundingClientRect();
    const cx = (x) => x - sRect.left;
    const cy = (y) => y - sRect.top + ctx.scrollElem.scrollTop;
    if (ctx.gridCols > 1) {
      line.classList.add('vertical');
      line.style.left = `${cx(after ? hit.rect.right + ctx.GRID_GAP / 2 : hit.rect.left - ctx.GRID_GAP / 2)}px`;
      line.style.top = `${cy(hit.rect.top)}px`;
      line.style.height = `${hit.rect.height}px`;
      line.style.width = '';
    } else {
      line.classList.remove('vertical');
      line.style.left = `${cx(hit.rect.left)}px`;
      line.style.right = 'auto';
      line.style.width = `${hit.rect.width}px`;
      line.style.height = '';
      line.style.top = `${cy(after ? hit.rect.bottom : hit.rect.top)}px`;
    }
  }

  /**
   * Slide every non-lifted mounted cell to the slot it will occupy once the lifted page(s) drop at `gap`, so an empty gap opens under the thumb.
   * The target slot is exactly the committed final index, so the drop is jump-free.
   * @param {number} gap
   */
  function previewReflow(gap) {
    const sorted = [...touch.pages].sort((a, b) => a - b);
    const single = !touch.group;
    const to = single ? (gap <= touch.primaryN ? gap : gap - 1) : gap - sorted.filter((s) => s < gap).length;
    for (const [i, entry] of ctx.mounted) {
      if (touch.pages.has(i)) continue; // lifted pages ride the ghost; their vacated slots are the opening gap
      const slot = single
        ? newIndexFor(i, touch.primaryN, Math.max(0, Math.min(ctx.pageCount - 1, to)))
        : multiMoveIndex(i, sorted, to);
      entry.thumbElem.style.transition = `top ${REORDER_SLIDE_MS}ms ease, left ${REORDER_SLIDE_MS}ms ease`;
      entry.thumbElem.style.top = `${ctx.PAD + ctx.offsets[slot]}px`;
      entry.thumbElem.style.left = `${ctx.lefts[slot]}px`;
    }
    // Dashed drop-seat outlines, one per carried page, at the exact indices the drop will fill.
    const first = Math.max(0, Math.min(ctx.pageCount - sorted.length, to));
    if (!touch.slots) {
      touch.slots = sorted.map(() => {
        const el = document.createElement('div');
        el.className = 'scribe-thumb-slot';
        ctx.scrollElem.insertBefore(el, ctx.scrollElem.firstChild);
        return el;
      });
    }
    touch.slots.forEach((el, k) => {
      const en = ctx.mounted.get(sorted[k]);
      const box = en && en.imgElem ? en.imgElem.parentElement : null;
      if (!box) { el.style.display = 'none'; return; }
      const slot = first + k;
      el.style.transition = el.style.top ? `top ${REORDER_SLIDE_MS}ms ease, left ${REORDER_SLIDE_MS}ms ease` : 'none';
      el.style.display = '';
      el.style.width = `${box.offsetWidth}px`;
      el.style.height = `${box.offsetHeight}px`;
      el.style.left = `${ctx.lefts[slot]}px`;
      el.style.top = `${ctx.PAD + ctx.offsets[slot]}px`;
    });
  }

  /** Return every mounted cell to its true-index slot (a cancelled or no-op drop). */
  function restoreReflow() {
    const rows = [...ctx.mounted.values()];
    for (const [i, entry] of ctx.mounted) {
      entry.thumbElem.style.transition = `top ${REORDER_SLIDE_MS}ms ease, left ${REORDER_SLIDE_MS}ms ease`;
      entry.thumbElem.style.top = `${ctx.PAD + ctx.offsets[i]}px`;
      entry.thumbElem.style.left = `${ctx.lefts[i]}px`;
    }
    // Clear the inline transitions once the slide lands: left in place, a later drop's landing rows would still animate and dealRows would measure their mid-flight rects.
    setTimeout(() => {
      for (const entry of rows) entry.thumbElem.style.transition = '';
    }, REORDER_SLIDE_MS + 20);
  }

  function positionGhost() {
    if (touch && touch.ghost) {
      touch.ghost.style.left = `${touch.lastX - touch.grabDX}px`;
      touch.ghost.style.top = `${touch.lastY - touch.grabDY}px`;
    }
  }

  function touchAutoTick() {
    if (!touch || (!touch.lifted && !touch.sweeping)) { if (touch) touch.autoRAF = 0; return; }
    const rect = ctx.scrollElem.getBoundingClientRect();
    const max = ctx.scrollElem.scrollHeight - ctx.scrollElem.clientHeight;
    let dir = 0;
    if (touch.lastY < rect.top + AUTOSCROLL_EDGE && ctx.scrollElem.scrollTop > 0) dir = -1;
    else if (touch.lastY > rect.bottom - AUTOSCROLL_EDGE && ctx.scrollElem.scrollTop < max) dir = 1;
    if (dir) {
      ctx.scrollElem.scrollTop = Math.max(0, Math.min(max, ctx.scrollElem.scrollTop + dir * AUTOSCROLL_SPEED));
      ctx.updateWindow();
      if (touch.lifted) updateGap(touch.lastX, touch.lastY);
      else runTo(touch.lastX, touch.lastY);
    }
    touch.autoRAF = requestAnimationFrame(touchAutoTick);
  }
  function startTouchAuto() { if (touch && !touch.autoRAF) touch.autoRAF = requestAnimationFrame(touchAutoTick); }
  function stopTouchAuto() { if (touch && touch.autoRAF) { cancelAnimationFrame(touch.autoRAF); touch.autoRAF = 0; } }

  /**
   * Lift `pages` (sorted ascending) into the carried ghost and arm the drag.
   * @param {Array<number>} pages @param {number} primaryN - The front page, held under the thumb.
   */
  function liftTouch(pages, primaryN) {
    touch.lifted = true;
    touch.primaryN = primaryN;
    touch.group = pages.length > 1;
    touch.pages = new Set(pages);
    touch.gap = primaryN; // no-op default until a target cell is hovered
    touch.reflowedGap = -1; // no reflow yet: the lifted page's own hidden slot marks the origin
    // Gap-hysteresis anchor: travel is measured from here until the first gap commits.
    touch.gapX = touch.lastX;
    touch.gapY = touch.lastY;
    touch.gapScroll = ctx.scrollElem.scrollTop;
    ctx.suppressClick = true;
    ctx.closeContextMenu();
    // Keep the lifted rows mounted through an autoscroll: updateWindow reads drag.pages.
    ctx.drag = {
      from: primaryN, group: touch.group, pages: new Set(pages), started: true, startX: touch.startX, startY: touch.startY,
    };
    for (const p of pages) {
      const en = ctx.mounted.get(p);
      if (en) { en.thumbElem.classList.remove('prelift', 'inrun'); en.thumbElem.classList.add('lifting'); }
    }
    const primEntry = ctx.mounted.get(primaryN);
    const box = primEntry && primEntry.thumbElem.querySelector('.scribe-thumb-box');
    const rect = box ? box.getBoundingClientRect()
      : {
        left: touch.lastX - ctx.THUMB_W / 2, top: touch.lastY - ctx.THUMB_W / 2, width: ctx.THUMB_W, height: ctx.THUMB_W,
      };
    /** @type {Array<HTMLImageElement>} */
    const imgs = [];
    /** @param {number} m */
    const pushImg = (m) => { const e = ctx.mounted.get(m); if (e && e.imgElem) imgs.push(e.imgElem); };
    pushImg(primaryN);
    for (const p of pages) { if (imgs.length >= 3) break; if (p !== primaryN) pushImg(p); }
    touch.ghost = buildGhost(imgs, rect, pages.length);
    // Grab the ghost where the thumb sits within the page, clamped so a run collapsed under an off-page finger still hangs sensibly.
    touch.grabDX = Math.max(8, Math.min(rect.width - 8, touch.lastX - rect.left));
    touch.grabDY = Math.max(8, Math.min(rect.height - 8, touch.lastY - rect.top));
    positionGhost();
    startTouchAuto();
  }

  /**
   * Highlight the contiguous run from the sweep's start page to the page under the pointer, arming the collapse-on-pause.
   * @param {number} clientX @param {number} clientY
   */
  function runTo(clientX, clientY) {
    const u = document.elementFromPoint(clientX, clientY);
    const tile = u && 'closest' in u ? u.closest('.scribe-thumb') : null;
    if (!tile || !ctx.scrollElem.contains(tile)) return;
    const ui = Number(tile.dataset.page);
    if (!Number.isFinite(ui)) return;
    touch.runLo = Math.min(touch.startIdx, ui);
    touch.runHi = Math.max(touch.startIdx, ui);
    for (const [n, entry] of ctx.mounted) entry.thumbElem.classList.toggle('inrun', n >= touch.runLo && n <= touch.runHi);
    if (touch.settleT) clearTimeout(touch.settleT);
    touch.settleT = setTimeout(() => { if (touch && touch.sweeping) collapseRun(); }, SWEEP_SETTLE_MS);
  }

  /** Collapse the highlighted run into the carried clump and hand off to the lift/drag phase. */
  function collapseRun() {
    if (touch.settleT) { clearTimeout(touch.settleT); touch.settleT = null; }
    const { runLo, runHi } = touch;
    if (runHi <= runLo) return; // a single page is not a run; keep sweeping
    touch.sweeping = false;
    /** @type {Array<number>} */
    const run = [];
    for (let p = runLo; p <= runHi; p += 1) run.push(p);
    // The gathered run becomes the batch selection so the drop moves it as a block via moveSelection.
    ctx.selected.clear();
    for (const p of run) ctx.selected.add(p);
    for (const [, entry] of ctx.mounted) entry.thumbElem.classList.remove('inrun');
    liftTouch(run, runLo);
  }

  /** @param {number} clientX @param {number} clientY */
  function startSweep(clientX, clientY) {
    touch.sweeping = true;
    ctx.suppressClick = true;
    ctx.closeContextMenu();
    startTouchAuto();
    runTo(clientX, clientY);
  }

  /** Detach a gesture's listeners and timers; leaves the DOM as the caller left it. */
  function endTouch() {
    if (touch) {
      if (touch.holdT) clearTimeout(touch.holdT);
      if (touch.settleT) clearTimeout(touch.settleT);
      if (touch.reflowT) clearTimeout(touch.reflowT);
      stopTouchAuto();
    }
    window.removeEventListener('pointermove', onTouchMove);
    window.removeEventListener('pointerup', onTouchUp);
    window.removeEventListener('pointercancel', onTouchCancel);
    lastTouchT = Date.now();
    touch = null;
  }

  /** Tear down a gesture that never committed (a scroll, or a lift/sweep abandoned), restoring the layout. */
  function abortTouch() {
    if (!touch) return;
    if (touch.ghost) touch.ghost.remove();
    if (touch.line) touch.line.remove();
    // Deferred so the restore slide covers the seats before they go.
    if (touch.slots) {
      const seats = touch.slots;
      touch.slots = null;
      setTimeout(() => { for (const s of seats) s.remove(); }, REORDER_SLIDE_MS + 20);
    }
    const restore = touch.lifted || touch.sweeping;
    for (const [, entry] of ctx.mounted) entry.thumbElem.classList.remove('prelift', 'inrun', 'lifting');
    if (restore) restoreReflow();
    ctx.drag = null;
    endTouch();
  }

  /**
   * Press on a page's selection checkbox (room Edit mode): toggle that page now; sliding on across further pages paints them to the same state.
   * Starting on the checkbox is what disambiguates painting a range from dragging a page.
   * @param {PointerEvent} e @param {number} n
   */
  function onChkPointerDown(e, n) {
    if (touch || ctx.roomMode !== 'edit') return;
    if (ctx.gridInMotion()) return; // native scrolling owns it; the badge's click handler swallows the tail
    e.preventDefault();
    e.stopPropagation();
    ctx.toggleRoomSelect(n);
    touch = {
      primaryN: n,
      mode: 'edit',
      painting: true,
      paintWant: ctx.selected.has(n),
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      pointerId: e.pointerId,
      lifted: false,
      sweeping: false,
      peeking: false,
      moved: false,
      holdT: 0,
      settleT: 0,
      reflowT: 0,
      autoRAF: 0,
      ghost: null,
      line: null,
    };
    lastTouchT = Date.now();
    try { ctx.scrollElem.setPointerCapture(e.pointerId); } catch (_) { /* capture is best-effort */ }
    window.addEventListener('pointermove', onTouchMove);
    window.addEventListener('pointerup', onTouchUp);
    window.addEventListener('pointercancel', onTouchCancel);
  }

  /** @param {PointerEvent} e @param {number} n */
  function onThumbTouchStart(e, n) {
    if (touch) return; // one gesture at a time
    const mode = ctx.roomMode;
    if (mode === 'browse') {
      // Browse gestures are read-only, so they run even where the reorder guard below would bail (editing disabled, single page).
      touch = {
        primaryN: n,
        mode,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        pointerId: e.pointerId,
        peeking: false,
        lifted: false,
        sweeping: false,
        moved: false,
        holdT: 0,
        settleT: 0,
        autoRAF: 0,
        ghost: null,
      };
      // A single tap is inert in browse (opening is the double-tap's job in onTouchUp), so its click is suppressed up front.
      ctx.suppressClick = true;
      lastTouchT = Date.now();
      touch.holdT = setTimeout(() => {
        touch.holdT = 0;
        if (!touch || touch.peeking) return;
        try { ctx.scrollElem.setPointerCapture(touch.pointerId); } catch (_) { /* capture is best-effort */ }
        touch.peeking = true;
        ctx.peekShow(touch.primaryN);
      }, PEEK_HOLD_MS);
      window.addEventListener('pointermove', onTouchMove);
      window.addEventListener('pointerup', onTouchUp);
      window.addEventListener('pointercancel', onTouchCancel);
      return;
    }
    // Reordering is an editor action needing at least two pages; otherwise a press stays a plain tap (select/navigate).
    if (!(ctx.scribe.opt && ctx.scribe.opt.enablePageEditing) || ctx.pageCount < 2) return;
    const entry = ctx.mounted.get(n);
    touch = {
      primaryN: n,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      pointerId: e.pointerId,
      startIdx: n,
      group: false,
      pages: new Set([n]),
      scrollOnly: false,
      lifted: false,
      sweeping: false,
      peeking: false,
      moved: false,
      gap: n,
      reflowedGap: -1,
      gapX: e.clientX,
      gapY: e.clientY,
      gapScroll: ctx.scrollElem.scrollTop,
      holdT: 0,
      settleT: 0,
      reflowT: 0,
      autoRAF: 0,
      ghost: null,
      line: null,
      grabDX: 0,
      grabDY: 0,
      runLo: n,
      runHi: n,
    };
    lastTouchT = Date.now();
    if (mode === 'edit') {
      // Edit mode lifts from the first movement (onTouchMove), with no hold; a clean tap toggles selection in onTouchUp, so the click is suppressed.
      ctx.suppressClick = true;
      // A press while the grid still glides is a catch-the-scroll gesture and must not lift.
      if (ctx.gridInMotion()) touch.scrollOnly = true;
    } else {
      if (entry) entry.thumbElem.classList.add('prelift');
      touch.holdT = setTimeout(() => {
        touch.holdT = 0;
        if (!touch || touch.lifted || touch.sweeping) return;
        try { ctx.scrollElem.setPointerCapture(touch.pointerId); } catch (_) { /* capture is best-effort */ }
        liftTouch([n], n);
      }, LIFT_HOLD_MS);
    }
    window.addEventListener('pointermove', onTouchMove);
    window.addEventListener('pointerup', onTouchUp);
    window.addEventListener('pointercancel', onTouchCancel);
  }

  /** @param {PointerEvent} e */
  function onTouchMove(e) {
    if (!touch || e.pointerId !== touch.pointerId) return;
    touch.lastX = e.clientX;
    touch.lastY = e.clientY;
    lastTouchT = Date.now();
    if (touch.lifted) {
      e.preventDefault();
      positionGhost();
      updateGap(e.clientX, e.clientY);
      if (Math.hypot(e.clientX - touch.startX, e.clientY - touch.startY) > MENU_SLOP) touch.moved = true;
      return;
    }
    if (touch.sweeping) { e.preventDefault(); runTo(e.clientX, e.clientY); return; }
    if (touch.painting) {
      // Painted immediately per crossing, with no commit step; a cancel keeps the range.
      e.preventDefault();
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const t = el && 'closest' in el ? el.closest('.scribe-thumb') : null;
      if (t && ctx.scrollElem.contains(t)) {
        const p = Number(t.dataset.page);
        if (Number.isFinite(p)) ctx.setRoomSelect(p, touch.paintWant);
      }
      return;
    }
    if (touch.mode === 'browse') {
      if (touch.peeking) {
        e.preventDefault();
        // The peek overlay is pointer-events: none while the finger is down, so this hit-test reaches the cells beneath it.
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const t = el && 'closest' in el ? el.closest('.scribe-thumb') : null;
        if (t && ctx.scrollElem.contains(t)) {
          const p = Number(t.dataset.page);
          if (Number.isFinite(p) && p !== touch.primaryN) { touch.primaryN = p; ctx.peekShow(p); }
        }
        return;
      }
      // A real move before the hold fires is a scroll; it also voids any pending double-tap.
      if (Math.hypot(e.clientX - touch.startX, e.clientY - touch.startY) > LIFT_MOVE_SLOP) { lastTap = null; abortTouch(); }
      return;
    }
    if (touch.mode === 'edit') {
      if (touch.scrollOnly) return; // the press caught a moving grid; native scrolling owns the gesture
      if (Math.hypot(e.clientX - touch.startX, e.clientY - touch.startY) > DRAG_THRESHOLD) {
        try { ctx.scrollElem.setPointerCapture(touch.pointerId); } catch (_) { /* best-effort */ }
        const n = touch.primaryN;
        const pages = ctx.selected.has(n) && ctx.selected.size > 1 ? [...ctx.selected].sort((a, b) => a - b) : [n];
        liftTouch(pages, n);
      }
      return;
    }
    const dx = e.clientX - touch.startX;
    const dy = e.clientY - touch.startY;
    // A sideways slide before the lift gathers a run; a larger move in any direction is a scroll and abandons the gesture.
    if (Math.abs(dx) > SWEEP_DX && Math.abs(dx) > Math.abs(dy)) {
      if (touch.holdT) { clearTimeout(touch.holdT); touch.holdT = 0; }
      const en = ctx.mounted.get(touch.primaryN);
      if (en) en.thumbElem.classList.remove('prelift');
      try { ctx.scrollElem.setPointerCapture(touch.pointerId); } catch (_) { /* best-effort */ }
      startSweep(e.clientX, e.clientY);
      return;
    }
    if (Math.hypot(dx, dy) > LIFT_MOVE_SLOP) abortTouch();
  }

  /** @param {PointerEvent} e */
  function onTouchUp(e) {
    if (!touch || e.pointerId !== touch.pointerId) return;
    if (touch.holdT) { clearTimeout(touch.holdT); touch.holdT = 0; }
    if (touch.mode === 'browse') {
      if (touch.peeking) { ctx.peekHide(); lastTap = null; endTouch(); return; } // the preview lives only under the finger
      // A single tap is inert; a second on the same page within DBL_TAP_MS opens it in the viewer.
      // endTouch comes first because openPage may close the room.
      const n = touch.primaryN;
      const now = Date.now();
      endTouch();
      if (lastTap && lastTap.n === n && now - lastTap.t <= DBL_TAP_MS) {
        lastTap = null;
        ctx.openPage(n);
      } else {
        lastTap = { n, t: now };
      }
      return;
    }
    if (touch.lifted) { dropTouch(true); return; }
    if (touch.sweeping) { abortTouch(); return; } // released mid-sweep before the pause: gather nothing
    if (touch.painting) { endTouch(); return; } // the paint's selection is already applied; nothing to commit
    if (touch.mode === 'edit') {
      // Tapping anywhere on the page is its checkbox; a catch-the-scroll press is navigation and must not toggle.
      const wasCatch = touch.scrollOnly;
      const n = touch.primaryN;
      endTouch();
      if (!wasCatch) ctx.toggleRoomSelect(n);
      return;
    }
    // Neither lifted nor swept: a plain tap, left to the click handler.
    for (const [, entry] of ctx.mounted) entry.thumbElem.classList.remove('prelift');
    endTouch();
  }

  /** @param {PointerEvent} e */
  function onTouchCancel(e) {
    if (!touch || e.pointerId !== touch.pointerId) return;
    // An interruption never commits: a lifted page settles back home rather than dropping at whatever gap the finger last hovered.
    if (touch.peeking) { ctx.peekHide(); lastTap = null; abortTouch(); return; }
    if (touch.lifted) dropTouch(false, false); else abortTouch();
  }

  /**
   * Commit (or open the menu, or settle home) the lifted page(s) at the release point.
   * @param {boolean} allowMenu - Whether a lift that never dragged opens the page menu (a real release, not an interruption).
   * @param {boolean} [commit=true] - Whether a dragged lift applies its move.
   *   False on interruption (pointercancel), which puts the page(s) back instead of committing the hovered gap.
   */
  function dropTouch(allowMenu, commit = true) {
    stopTouchAuto();
    if (touch.reflowT) { clearTimeout(touch.reflowT); touch.reflowT = 0; }
    if (touch.line) { touch.line.remove(); touch.line = null; }
    // The seats stay through the settle: the landing copies (commit) or the returning crowd (put-back) must cover them before removal, else they pop out in the release frame.
    if (touch.slots) {
      const seats = touch.slots;
      touch.slots = null;
      setTimeout(() => { for (const s of seats) s.remove(); }, REORDER_SLIDE_MS + 20);
    }
    const {
      ghost, primaryN, group, pages,
    } = touch;
    // A lift released without ever dragging opens the page menu, the touch home for delete/rotate/duplicate/extract.
    // Not in the room's modes: Edit has its own mutation surface, and browse never lifts.
    if (allowMenu && !group && !touch.moved && !ctx.roomMode) {
      if (ghost) ghost.remove();
      for (const [, entry] of ctx.mounted) entry.thumbElem.classList.remove('lifting');
      restoreReflow();
      ctx.drag = null;
      const { startX, startY } = touch;
      endTouch();
      ctx.openContextMenu(startX, startY, primaryN);
      return;
    }
    const gap = touch.gap;
    let moved;
    if (!commit) {
      moved = undefined; // interrupted: the no-move path below slides everything home
    } else if (group) {
      moved = moveSelection(gap);
    } else if (gap === primaryN || gap === primaryN + 1) {
      moved = undefined;
    } else {
      const to = gap <= primaryN ? gap : gap - 1;
      moved = (to < 0 || to >= ctx.pageCount) ? undefined : reorderPages(primaryN, to);
    }
    if (!moved) {
      // Nothing committed: slide the displaced cells home and settle the ghost onto the lifted page's own slot.
      restoreReflow();
      ctx.updateWindow();
      moved = [];
      for (const p of pages) { const home = ctx.mounted.get(p); if (home) moved.push(home); }
    }
    for (const en of moved) { en.thumbElem.classList.remove('lifting'); en.thumbElem.style.opacity = '0'; }
    ctx.drag = null;
    dealRows(ghost, moved);
    endTouch();
  }

  // Non-passive because preventDefault on the pointer events alone does not stop native scrolling once a lift/sweep/peek/paint owns the pointer.
  ctx.scrollElem.addEventListener('touchmove', (e) => {
    if (touch && (touch.lifted || touch.sweeping || touch.peeking || touch.painting)) e.preventDefault();
  }, { passive: false });

  /** Whether a touch reorder is in progress or just ended, so panels.js can swallow a racing native long-press menu. */
  function touchActive() { return touch !== null || (Date.now() - lastTouchT < 500); }

  /** Abort any in-flight drag (used on teardown). */
  function cancelDrag() {
    if (touch) abortTouch();
    const d = ctx.drag;
    if (!d) return;
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragUp);
    if (d.started) endDragVisuals(d);
    ctx.drag = null;
  }

  // `insertionGapAt`/`placeInsertLineAt` are also driven by panels.js's external-file drop preview.
  return {
    onThumbPointerDown, onChkPointerDown, cancelDrag, insertionGapAt, placeInsertLineAt, touchActive,
  };
}
