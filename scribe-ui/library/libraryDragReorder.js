// Card drag for the library's main grid: lift, ghost, insertion line, folder drop, and edge autoscroll.
// Owns the gesture's whole state, so the surface around it only asks whether a drag is running rather than tracking one.

import { REORDER_SLIDE_MS } from '../js/controls/pageReorder.js';
import { titleOf } from './libraryStore.js';

// Card drag thresholds, matching the Pages-view gesture grammar so the two surfaces feel identical.
const DRAG_THRESHOLD = 5;
const LIFT_HOLD_MS = 250;
const LIFT_MOVE_SLOP = 9;
const MENU_SLOP = 8;
const GAP_HYSTERESIS = 12;
const AUTOSCROLL_EDGE = 36;
const AUTOSCROLL_SPEED = 14;

/**
 * Install card drag-to-reorder over the library grid.
 * @param {Object} deps
 * @param {import('../basic-viewer/pdf-viewer.js').ScribePDFViewer} deps.viewer
 * @param {HTMLElement} deps.surface - Library root, flagged with a class for the length of a drag.
 * @param {HTMLElement} deps.body - Scrolling surface the cards live in, and the autoscroll target.
 * @param {Set<string>} deps.selectedPaths
 * @param {() => ?import('./libraryStore.js').LibraryManifest} deps.getManifest
 * @param {() => ?import('./libraryStore.js').LibraryStore} deps.getStore
 * @param {() => void} deps.saveManifestSoon
 * @param {() => void} deps.render
 * @param {(clientX: number, clientY: number, relPath: string, card: HTMLElement) => void} deps.openCardMenu
 * @param {() => boolean} deps.dragAllowed - Whether the grid is in a state a card drag may start from.
 * @param {() => boolean} deps.reorderAllowed - Whether the current sort and view support manual ordering.
 */
export function createDragReorder({
  viewer, surface, body, selectedPaths, getManifest, getStore, saveManifestSoon, render, openCardMenu, dragAllowed, reorderAllowed,
}) {
  /** @type {?Object} In-flight card drag. */
  let dragState = null;
  /** Render requested while a drag held the grid frozen; replayed when the drag ends. */
  let renderPending = false;
  /** Relative paths in the main grid's current display order (the drag's reorder base). */
  let gridPaths = [];
  /** @type {?HTMLElement} */
  let mainGridElem = null;
  /** Clicks are ignored until this time right after a drag, so the drop doesn't open a card. */
  let suppressClickUntil = 0;
  /** When the last touch drag ended, so the native long-press contextmenu racing it is swallowed. */
  let lastTouchDragT = 0;

  const blockTouchScroll = (e) => {
    if (dragState?.started) e.preventDefault();
  };

  /**
   * Insertion gap (0..cards.length) for a pointer position.
   * @param {HTMLElement[]} cards
   * @param {number} x
   * @param {number} y
   */
  const gapAt = (cards, x, y) => {
    let best = -1;
    let bestDist = Infinity;
    let bestRect = null;
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      const d = (x - (r.left + r.width / 2)) ** 2 + (y - (r.top + r.height / 2)) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = i;
        bestRect = r;
      }
    }
    if (best < 0) return 0;
    return best + (x > /** @type {DOMRect} */ (bestRect).left + /** @type {DOMRect} */ (bestRect).width / 2 ? 1 : 0);
  };

  const startDragVisuals = (d) => {
    d.started = true;
    const rect = d.cardElem.getBoundingClientRect();
    d.grabDX = d.startX - rect.left;
    d.grabDY = d.startY - rect.top;
    const clone = /** @type {HTMLElement} */ (d.cardElem.cloneNode(true));
    clone.style.width = '100%';
    clone.style.height = '100%';
    clone.style.boxSizing = 'border-box';
    // A row's track widths and its dropped columns are both decided by the list host the ghost is about to leave behind.
    // Neither follows the clone to document.body, so both are carried over from what the source row resolved to.
    const rowStyle = getComputedStyle(d.cardElem);
    if (rowStyle.display === 'grid') {
      clone.style.gridTemplateColumns = rowStyle.gridTemplateColumns;
      const cells = [...d.cardElem.children];
      [...clone.children].forEach((cell, i) => {
        if (getComputedStyle(cells[i]).display === 'none') /** @type {HTMLElement} */ (cell).style.display = 'none';
      });
    }
    // On document.body the ghost sits outside the viewer root, so it carries the scope class, theme, and font itself for the scoped card rules and tokens to apply.
    d.ghost = document.createElement('div');
    d.ghost.className = 'scribe-library-ghost scribe-pdf-viewer';
    const theme = viewer.pdfViewerElem.getAttribute('data-theme');
    if (theme) d.ghost.setAttribute('data-theme', theme);
    d.ghost.style.fontFamily = getComputedStyle(viewer.pdfViewerElem).fontFamily;
    d.ghost.style.width = `${rect.width}px`;
    d.ghost.style.height = `${rect.height}px`;
    d.ghost.appendChild(clone);
    document.body.appendChild(d.ghost);
    d.cardElem.classList.add('dragging');
    surface.classList.add('card-drag');
    if (d.canReorder && mainGridElem) {
      d.line = document.createElement('div');
      d.line.className = 'scribe-library-insert-line';
      mainGridElem.appendChild(d.line);
      updateGap(d, true);
    }
    positionGhost(d);
    updateDropTarget(d);
  };

  const positionGhost = (d) => {
    if (d.ghost) {
      d.ghost.style.left = `${d.lastX - d.grabDX}px`;
      d.ghost.style.top = `${d.lastY - d.grabDY}px`;
    }
  };

  /**
   * Resolve the folder card, row, or ancestor breadcrumb under the pointer into the drag's move destination.
   * The document's own folder never targets, so dropping there reads as a no-op rather than a move.
   * @param {Object} d
   */
  const updateDropTarget = (d) => {
    const under = document.elementFromPoint(d.lastX, d.lastY);
    const target = under && /** @type {?HTMLElement} */ (under.closest('[data-dir-target]'));
    const cut = d.relPath.lastIndexOf('/');
    const parent = cut < 0 ? '' : d.relPath.slice(0, cut);
    const elem = target && target.dataset.dirTarget !== parent ? target : null;
    if (elem !== d.dropElem) {
      d.dropElem?.classList.remove('drop');
      d.dropElem = elem;
      d.dropElem?.classList.add('drop');
      d.ghost?.classList.toggle('over-drop', !!d.dropElem);
      if (d.line) d.line.style.display = d.dropElem ? 'none' : '';
    }
    d.dropDir = d.dropElem ? (d.dropElem.dataset.dirTarget ?? null) : null;
  };

  /** @param {Object} d @param {boolean} [force] - Commit the derived gap even under the hysteresis threshold. */
  const updateGap = (d, force = false) => {
    if (!mainGridElem || !d.line) return;
    const cards = /** @type {HTMLElement[]} */ ([...mainGridElem.querySelectorAll(':scope > .scribe-library-card:not(.folder)')]);
    const gap = gapAt(cards, d.lastX, d.lastY);
    if (gap !== d.gap && (force || d.sinceGap >= GAP_HYSTERESIS)) {
      d.gap = gap;
      d.sinceGap = 0;
      const anchor = cards[Math.min(gap, cards.length - 1)];
      if (anchor) {
        const before = gap < cards.length;
        d.line.style.left = `${before ? anchor.offsetLeft - 8 : anchor.offsetLeft + anchor.offsetWidth + 5}px`;
        d.line.style.top = `${anchor.offsetTop}px`;
        d.line.style.height = `${anchor.offsetHeight}px`;
      }
    }
  };

  const autoScrollTick = () => {
    const d = dragState;
    if (!d || !d.autoDir) {
      if (d) d.rafId = 0;
      return;
    }
    body.scrollTop += d.autoDir * AUTOSCROLL_SPEED;
    d.sinceGap += AUTOSCROLL_SPEED;
    updateGap(d);
    updateDropTarget(d);
    d.rafId = requestAnimationFrame(autoScrollTick);
  };

  const onDragMove = (e) => {
    const d = dragState;
    if (!d) return;
    d.sinceGap += Math.hypot(e.clientX - d.lastX, e.clientY - d.lastY);
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    if (!d.started) {
      const dist = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
      if (d.isTouch) {
        // Travel before the hold fires reads as a scroll.
        if (dist > LIFT_MOVE_SLOP) endDrag(false);
        return;
      }
      if (dist <= DRAG_THRESHOLD) return;
      startDragVisuals(d);
    }
    positionGhost(d);
    updateGap(d);
    updateDropTarget(d);
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > MENU_SLOP) d.moved = true;
    const bodyRect = body.getBoundingClientRect();
    if (e.clientY < bodyRect.top + AUTOSCROLL_EDGE) d.autoDir = -1;
    else if (e.clientY > bodyRect.bottom - AUTOSCROLL_EDGE) d.autoDir = 1;
    else d.autoDir = 0;
    if (d.autoDir && !d.rafId) d.rafId = requestAnimationFrame(autoScrollTick);
  };

  const onDragUp = () => endDrag(true);
  const onDragCancel = () => endDrag(false);

  /** @param {boolean} commit */
  const endDrag = (commit) => {
    const d = dragState;
    if (!d) return;
    const manifest = getManifest();
    const store = getStore();
    dragState = null;
    window.clearTimeout(d.holdTimer);
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragUp);
    window.removeEventListener('pointercancel', onDragCancel);
    document.removeEventListener('touchmove', blockTouchScroll);
    if (d.rafId) cancelAnimationFrame(d.rafId);
    d.ghost?.remove();
    d.line?.remove();
    d.dropElem?.classList.remove('drop');
    d.cardElem.classList.remove('dragging');
    surface.classList.remove('card-drag');
    if (d.started) {
      suppressClickUntil = Date.now() + 350;
      if (d.isTouch) {
        lastTouchDragT = Date.now();
        // A lift released without ever dragging opens the card menu, the touch home for Remove.
        if (commit && !d.moved) {
          if (renderPending) {
            renderPending = false;
            render();
          }
          openCardMenu(d.startX, d.startY, d.relPath, d.cardElem);
          return;
        }
      }
      if (commit && d.dropDir != null && manifest) {
        const { relPath, dropDir } = d;
        renderPending = false;
        (async () => {
          const entry = manifest.docs[relPath];
          if (!entry || !store) return;
          try {
            const moved = await store.moveFile(relPath, dropDir);
            delete manifest.docs[relPath];
            manifest.docs[moved.relPath] = entry;
            // The copy re-stamps the file; recording the new mtime avoids a pointless verify on the next scan.
            entry.mtime = moved.mtime;
            saveManifestSoon();
          } catch (err) {
            viewer._showToast(`Couldn't move “${titleOf(relPath)}” — ${err instanceof Error ? err.message : 'the file could not be moved'}.`);
          }
          selectedPaths.delete(relPath);
          render();
        })();
        return;
      }
      if (commit && d.canReorder && d.gap >= 0 && manifest) {
        const paths = gridPaths.slice();
        const fromIdx = paths.indexOf(d.relPath);
        const to = d.gap > fromIdx ? d.gap - 1 : d.gap;
        if (fromIdx >= 0 && to !== fromIdx) {
          paths.splice(fromIdx, 1);
          paths.splice(to, 0, d.relPath);
          // The displayed order becomes the manual order wholesale, so every doc in the folder gets a concrete position the first time one is placed.
          paths.forEach((p, i) => {
            const entry = manifest.docs[p];
            if (entry) entry.order = i;
          });
          saveManifestSoon();
          const beforeRects = new Map();
          for (const el of mainGridElem?.querySelectorAll(':scope > .scribe-library-card') ?? []) {
            beforeRects.set(/** @type {HTMLElement} */ (el).dataset.relPath, el.getBoundingClientRect());
          }
          renderPending = false;
          render();
          // Slide each card from its old slot so the move reads as a move.
          const moved = [];
          for (const el of mainGridElem?.querySelectorAll(':scope > .scribe-library-card') ?? []) {
            const prev = beforeRects.get(/** @type {HTMLElement} */ (el).dataset.relPath);
            if (!prev) continue;
            const now = el.getBoundingClientRect();
            const dx = prev.left - now.left;
            const dy = prev.top - now.top;
            if (!dx && !dy) continue;
            const elem = /** @type {HTMLElement} */ (el);
            elem.style.transition = 'none';
            elem.style.transform = `translate(${dx}px, ${dy}px)`;
            moved.push(elem);
          }
          // A synchronous layout read commits the translated positions before the slide-back transition arms.
          if (moved.length && mainGridElem) mainGridElem.getBoundingClientRect();
          for (const elem of moved) {
            elem.style.transition = `transform ${REORDER_SLIDE_MS}ms ease`;
            elem.style.transform = '';
            elem.addEventListener('transitionend', () => {
              elem.style.transition = '';
            }, { once: true });
          }
          return;
        }
      }
    }
    if (renderPending) {
      renderPending = false;
      render();
    }
  };

  /**
   * @param {PointerEvent} e
   * @param {string} relPath
   * @param {HTMLElement} card
   */
  const beginCardDrag = (e, relPath, card) => {
    if (dragState || !dragAllowed()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // A sloppy modifier-click must land as a selection click, never arm a reorder drag.
    if (e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (e.target instanceof Element && e.target.closest('.actions')) return;
    const isTouch = e.pointerType !== 'mouse';
    dragState = {
      relPath,
      cardElem: card,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      started: false,
      moved: false,
      canReorder: reorderAllowed(),
      /** @type {?string} Move destination while over a folder or crumb; null means none. */
      dropDir: null,
      /** @type {?HTMLElement} */ dropElem: null,
      /** @type {?HTMLElement} */ ghost: null,
      /** @type {?HTMLElement} */ line: null,
      gap: -1,
      sinceGap: 0,
      autoDir: 0,
      rafId: 0,
      holdTimer: 0,
      isTouch,
      grabDX: 0,
      grabDY: 0,
    };
    if (isTouch) {
      dragState.holdTimer = window.setTimeout(() => {
        const d = dragState;
        if (d && !d.started) {
          startDragVisuals(d);
          document.addEventListener('touchmove', blockTouchScroll, { passive: false });
        }
      }, LIFT_HOLD_MS);
    }
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragUp);
    window.addEventListener('pointercancel', onDragCancel);
  };

  return {
    beginCardDrag,

    /**
     * Adopt the freshly rendered main grid as the reorder base.
     * @param {?HTMLElement} elem
     * @param {string[]} paths - Display order of `elem`'s cards.
     */
    setMainGrid: (elem, paths) => {
      mainGridElem = elem;
      gridPaths = paths;
    },

    /** Whether a drag is armed or running, so a click or context menu racing it can bow out. */
    active: () => dragState !== null,

    /**
     * Hold a render until the drop, since a rebuild mid-drag would pull the card out from under the pointer.
     * @returns {boolean} Whether the caller should skip its render.
     */
    deferRender: () => {
      if (!dragState?.started) return false;
      renderPending = true;
      return true;
    },

    /** Whether a drag just ended, so the click that closes it does not also open a card. */
    clickSuppressed: () => Date.now() < suppressClickUntil,

    /** Whether a touch drag just ended, so the native long-press contextmenu racing it is swallowed. */
    touchDragRecent: () => Date.now() - lastTouchDragT < 500,

    /** Abandon any live drag without replaying the render it deferred. */
    cancel: () => {
      renderPending = false;
      if (dragState) endDrag(false);
    },
  };
}
