// Card drag for the library's grid and lists: lift, ghost, insertion line, folder drop, and edge autoscroll.
// Owns the gesture's whole state, so the surface around it only asks whether a drag is running rather than tracking one.

import {
  REORDER_SLIDE_MS, buildGhost, fanOrder, flyCopies,
} from '../js/controls/pageReorder.js';
import { titleOf } from './libraryStore.js';

/** @typedef {import('./libraryView.js').LibraryMove} LibraryMove */

// Card drag thresholds, matching the Pages-view gesture grammar so the two surfaces feel identical.
const DRAG_THRESHOLD = 5;
const LIFT_HOLD_MS = 250;
const LIFT_MOVE_SLOP = 9;
const MENU_SLOP = 8;
const GAP_HYSTERESIS = 12;
const AUTOSCROLL_EDGE = 36;
const AUTOSCROLL_SPEED = 14;
export const FOLDER_FLY_MS = 240;
const OVER_TARGET_SCALE = 0.45;
export const FOLDER_OVER_TARGET_SCALE = 0.7;
const OVER_TARGET_MS = 140;
const LIFT_MS = 140;
const LIFT_SCALE = 1.03;

/**
 * A press on a card or row in the library grid, from the press through the drag it may become.
 * @typedef {Object} CardDrag
 * @property {string} relPath - The pressed card's document, or a folder key with its trailing slash.
 * @property {HTMLElement} cardElem - The pressed card or row.
 * @property {boolean} isRow - Whether the press is on a list row.
 * @property {boolean} isDir
 * @property {string[]} carried - Every document and folder moving, in display order.
 * @property {Array<{relPath: string, img: ?HTMLImageElement}>} fan - The documents the ghost shows, front first.
 * @property {number} startX - Pointer clientX at the press.
 * @property {number} startY - Pointer clientY at the press.
 * @property {number} lastX - Last pointer clientX.
 * @property {number} lastY
 * @property {boolean} started - Whether the press has become a drag.
 * @property {boolean} moved - Whether the pointer has traveled past the menu slop since the press.
 * @property {boolean} canReorder - Whether the current sort and view allow manual ordering.
 * @property {?string} dropDir - Move destination while over a folder or crumb, null for none.
 * @property {?HTMLElement} dropElem - The folder card, row, or crumb that destination comes from.
 * @property {?HTMLElement} ghost - Floating copy tracking the pointer, a fan of pages for cards or a stack of rows for lists.
 * @property {?HTMLElement} line - Insertion-position line.
 * @property {number} gap - Current insertion gap, -1 before the first.
 * @property {number} sinceGap - Pointer travel since `gap` last changed, for the hysteresis.
 * @property {number} autoDir - Edge auto-scroll direction (-1, 0, 1).
 * @property {number} rafId - Auto-scroll animation-frame handle, 0 when idle.
 * @property {number} holdTimer - The touch hold timer that starts the drag.
 * @property {boolean} isTouch - Whether the press came from touch.
 * @property {number} grabDX - Offset of the grab point within the ghost.
 * @property {number} grabDY
 */

/**
 * Install card drag-to-reorder over the library grid.
 * @param {Object} deps
 * @param {import('../basic-viewer/pdf-viewer.js').ScribePDFViewer} deps.viewer
 * @param {HTMLElement} deps.surface - Library root, flagged with a class for the length of a drag.
 * @param {HTMLElement} deps.body - Scrolling surface the cards live in, and the autoscroll target.
 * @param {Set<string>} deps.selectedPaths
 * @param {() => ?import('./libraryStore.js').LibraryManifest} deps.getManifest
 * @param {() => void} deps.saveManifestSoon
 * @param {() => void} deps.render
 * @param {(clientX: number, clientY: number, relPath: string, card: HTMLElement) => void} deps.openCardMenu
 * @param {() => boolean} deps.dragAllowed - Whether the grid is in a state a card drag may start from.
 * @param {() => boolean} deps.reorderAllowed - Whether the current sort and view support manual ordering.
 * @param {(elem: HTMLElement, dirPath: string, entries: import('./libraryStore.js').LibraryDocEntry[]) => void} deps.previewFolder - Show a folder's fold as the hovering drag would leave it.
 * @param {(elem: HTMLElement, dirPath: string) => void} deps.unpreviewFolder - Put a folder back as it is.
 * @param {(dirPath: string, entries: import('./libraryStore.js').LibraryDocEntry[]) => void} deps.startLanding - Begin a drop's landing in a folder.
 * @param {(keys: string[], destDir: string) => Promise<{moves: LibraryMove[], failed: string[]}>} deps.moveItems
 * @param {(dirPath: string, mini: boolean) => HTMLElement} deps.foldFor - A folder's fold at card or list size.
 * @param {(dirPath: string, moves: LibraryMove[], fromDir: string) => void} deps.finishLanding
 */
export function createDragReorder({
  viewer, surface, body, selectedPaths, getManifest, saveManifestSoon, render, openCardMenu, dragAllowed, reorderAllowed,
  previewFolder, unpreviewFolder, startLanding, moveItems, foldFor, finishLanding,
}) {
  /** @type {?CardDrag} */
  let drag = null;
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

  const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const blockTouchScroll = (e) => {
    if (drag?.started) e.preventDefault();
  };

  // The Recent strip and the Just added shelf repeat cards from the main grid, so a drag reads these bands only.
  const CARRY_BANDS = ['folders-grid', 'main-grid', 'rows'];

  /** @param {string} relPath */
  const elemOf = (relPath) => /** @type {?HTMLElement} */(body.querySelector(CARRY_BANDS.map((b) => `[data-band="${b}"] > [data-rel-path="${CSS.escape(relPath)}"]`).join(', ')));

  /** @param {number} n */
  const countBadge = (n) => {
    const badge = document.createElement('div');
    badge.textContent = String(n);
    badge.style.cssText = 'position:absolute;top:-6px;right:-6px;min-width:18px;height:18px;padding:0 6px;z-index:10;'
      + 'display:flex;align-items:center;justify-content:center;border-radius:4px;background:rgba(24,27,30,.92);'
      + 'border:1px solid rgba(255,255,255,.25);color:#fff;font:600 11px sans-serif;box-sizing:border-box';
    return badge;
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

  /**
   * Build the drag ghost for a list row.
   * @param {CardDrag} d
   * @param {DOMRect} rect - The pressed row's box.
   */
  const buildRowGhost = (d, rect) => {
    // On document.body the ghost sits outside the viewer root, so it carries the scope class, theme, and font itself for the scoped row rules and tokens to apply.
    const ghost = document.createElement('div');
    ghost.className = 'scribe-library-ghost scribe-pdf-viewer';
    const theme = viewer.pdfViewerElem.getAttribute('data-theme');
    if (theme) ghost.setAttribute('data-theme', theme);
    ghost.style.fontFamily = getComputedStyle(viewer.pdfViewerElem).fontFamily;
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    // A row's track widths and its dropped columns are both decided by the list host the ghost is about to leave behind.
    // Neither follows a clone to document.body, so both are carried over from what the source row resolved to.
    const rowStyle = getComputedStyle(d.cardElem);
    const hiddenCells = [...d.cardElem.children].map((cell) => getComputedStyle(cell).display === 'none');
    /** @param {HTMLElement} row */
    const cloneRow = (row) => {
      const clone = /** @type {HTMLElement} */ (row.cloneNode(true));
      clone.classList.remove('dragging', 'selected', 'context');
      clone.style.width = '100%';
      clone.style.boxSizing = 'border-box';
      if (rowStyle.display === 'grid') {
        clone.style.gridTemplateColumns = rowStyle.gridTemplateColumns;
        [...clone.children].forEach((cell, i) => {
          if (hiddenCells[i]) /** @type {HTMLElement} */ (cell).style.display = 'none';
        });
      }
      return clone;
    };
    for (let i = Math.min(d.fan.length - 1, 2); i >= 1; i--) {
      const behind = elemOf(d.fan[i].relPath);
      if (!behind) continue;
      const plate = document.createElement('div');
      plate.className = 'row-ghost';
      plate.style.cssText = `height:${rect.height}px;transform:translate(${i * 6}px,${i * 6}px);z-index:${3 - i}`;
      plate.appendChild(cloneRow(behind));
      ghost.appendChild(plate);
    }
    const front = document.createElement('div');
    front.className = 'row-ghost';
    front.style.cssText = `height:${rect.height}px;z-index:3`;
    front.appendChild(cloneRow(d.cardElem));
    ghost.appendChild(front);
    if (d.carried.length > 1) {
      ghost.appendChild(countBadge(d.carried.length));
    }
    document.body.appendChild(ghost);
    return ghost;
  };

  /**
   * Build the drag ghost for a folder.
   * @param {CardDrag} d
   */
  const buildFoldGhost = (d) => {
    const ghost = document.createElement('div');
    ghost.className = 'scribe-library-ghost scribe-pdf-viewer';
    const theme = viewer.pdfViewerElem.getAttribute('data-theme');
    if (theme) ghost.setAttribute('data-theme', theme);
    ghost.style.fontFamily = getComputedStyle(viewer.pdfViewerElem).fontFamily;
    const mini = d.isRow;
    const w = mini ? 40 : 150;
    const h = mini ? 32 : 68;
    ghost.style.width = `${w}px`;
    ghost.style.height = `${h + 30}px`;
    const home = (d.cardElem.querySelector('.scribe-library-fold') ?? d.cardElem).getBoundingClientRect();
    d.grabDX = d.startX - home.left;
    d.grabDY = d.startY - home.top;
    // A press usually lands on the title below the fold, so a grab-point origin would pull the fold down toward it on every shrink.
    ghost.style.transformOrigin = `${w / 2}px ${h / 2}px`;
    // The lift animates a wrapper, because an animation on the hand itself would override its shrink transition while it plays and end with a jump.
    const lift = document.createElement('div');
    lift.className = 'scribe-ghost-lift';
    lift.style.cssText = `position:absolute;left:0;top:0;width:100%;height:100%;transform-origin:${w / 2}px ${h / 2}px`;
    const behind = d.carried.filter((p) => p.endsWith('/') && p !== d.relPath).slice(0, 2).reverse();
    behind.forEach((p, i) => {
      const depth = behind.length - i;
      const plate = document.createElement('span');
      plate.className = 'fold-ghost';
      plate.style.cssText = `transform:translate(${depth * 6}px,${depth * 6}px);z-index:${3 - depth};opacity:.9`;
      plate.appendChild(foldFor(p.slice(0, -1), mini));
      lift.appendChild(plate);
    });
    const front = document.createElement('span');
    front.className = 'fold-ghost';
    front.style.zIndex = '4';
    front.appendChild(foldFor(d.relPath.slice(0, -1), mini));
    lift.appendChild(front);
    const label = document.createElement('span');
    label.className = 'fold-label';
    label.style.top = `${h + 8}px`;
    const name = titleOf(d.relPath.slice(0, -1));
    label.textContent = d.carried.length > 1 ? `${name} + ${d.carried.length - 1}` : name;
    lift.appendChild(label);
    ghost.appendChild(lift);
    if (d.carried.length > 1) ghost.appendChild(countBadge(d.carried.length));
    document.body.appendChild(ghost);
    if (!reducedMotion()) lift.animate([{ transform: 'scale(1)' }, { transform: `scale(${LIFT_SCALE})` }], { duration: LIFT_MS, easing: 'ease', fill: 'forwards' });
    return ghost;
  };

  const startDragVisuals = (d) => {
    d.started = true;
    const manifest = getManifest();
    const group = selectedPaths.has(d.relPath) && selectedPaths.size >= 2;
    const siblings = [...body.querySelectorAll(CARRY_BANDS.map((b) => `[data-band="${b}"] > [data-rel-path]`).join(', '))]
      .map((el) => /** @type {HTMLElement} */(el).dataset.relPath ?? '');
    d.carried = group ? siblings.filter((p) => selectedPaths.has(p) && (p.endsWith('/') || !!manifest?.docs[p])) : [d.relPath];
    if (!d.carried.includes(d.relPath)) d.carried = [d.relPath];
    d.isRow = d.cardElem.classList.contains('scribe-library-row');
    d.isDir = d.relPath.endsWith('/');
    const docs = d.carried.filter((p) => !p.endsWith('/'));
    d.fan = d.isDir ? [] : fanOrder(d.relPath, docs).map(({ item }) => ({ relPath: item, img: /** @type {?HTMLImageElement} */ (elemOf(item)?.querySelector('img.thumb') ?? null) }));
    const rect = d.cardElem.getBoundingClientRect();
    if (d.isDir) {
      d.ghost = buildFoldGhost(d);
    } else if (d.isRow) {
      d.ghost = buildRowGhost(d, rect);
      d.grabDX = d.startX - rect.left;
      d.grabDY = d.startY - rect.top;
    } else {
      const thumb = d.cardElem.querySelector('img.thumb');
      const tr = thumb && thumb.getBoundingClientRect().width > 0 ? thumb.getBoundingClientRect() : rect;
      const cards = fanOrder(d.relPath, docs).map(({ item, dir }) => ({ img: /** @type {HTMLImageElement} */ (elemOf(item)?.querySelector('img.thumb') ?? document.createElement('img')), dir }));
      d.ghost = buildGhost(cards, tr, d.carried.length);
      d.grabDX = d.startX - tr.left;
      d.grabDY = d.startY - tr.top;
      // The fan goes in a wrapper of its own because the ghost's transform is the folder shrink.
      if (!reducedMotion()) {
        const lift = document.createElement('div');
        lift.className = 'scribe-ghost-lift';
        lift.style.cssText = `position:absolute;left:0;top:0;width:100%;height:100%;transform-origin:${d.grabDX}px ${d.grabDY}px`;
        for (const page of [...d.ghost.querySelectorAll('.scribe-ghost-card')]) lift.appendChild(page);
        d.ghost.prepend(lift);
        lift.animate([{ transform: 'scale(1)' }, { transform: `scale(${LIFT_SCALE})` }], { duration: LIFT_MS, easing: 'ease', fill: 'forwards' });
        for (const page of lift.children) page.animate([{ boxShadow: '0 1px 3px rgba(30, 26, 16, .18)' }, { boxShadow: '0 8px 22px rgba(0, 0, 0, .45)' }], { duration: LIFT_MS, easing: 'ease' });
      }
    }
    if (!d.isDir) d.ghost.style.transformOrigin = `${d.grabDX}px ${d.grabDY}px`;
    d.ghost.style.transition = reducedMotion() ? 'none' : `transform ${OVER_TARGET_MS}ms ease`;
    for (const p of d.carried) elemOf(p)?.classList.add('dragging');
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
   * The item's own folder never targets, so dropping there reads as a no-op.
   * @param {CardDrag} d
   */
  const updateDropTarget = (d) => {
    const under = document.elementFromPoint(d.lastX, d.lastY);
    const target = under && /** @type {?HTMLElement} */ (under.closest('[data-dir-target]'));
    const pressed = d.isDir ? d.relPath.slice(0, -1) : d.relPath;
    const cut = pressed.lastIndexOf('/');
    const parent = cut < 0 ? '' : pressed.slice(0, cut);
    let elem = target && target.dataset.dirTarget !== parent ? target : null;
    if (elem) {
      const dir = elem.dataset.dirTarget ?? '';
      if (d.carried.some((p) => p.endsWith('/') && (`${dir}/` === p || dir.startsWith(p)))) elem = null;
    }
    if (elem !== d.dropElem) {
      if (d.dropElem) {
        d.dropElem.classList.remove('drop');
        if (d.dropElem.classList.contains('folder')) unpreviewFolder(d.dropElem, d.dropElem.dataset.dirTarget ?? '');
      }
      d.dropElem = elem;
      if (d.dropElem) {
        d.dropElem.classList.add('drop');
        if (d.dropElem.classList.contains('folder')) {
          const manifest = getManifest();
          const entries = d.carried.map((p) => manifest?.docs[p]).filter((e) => !!e);
          previewFolder(d.dropElem, d.dropElem.dataset.dirTarget ?? '', /** @type {import('./libraryStore.js').LibraryDocEntry[]} */ (entries));
        }
      }
      if (d.ghost) d.ghost.style.transform = d.dropElem ? `scale(${d.isDir ? FOLDER_OVER_TARGET_SCALE : OVER_TARGET_SCALE})` : '';
      if (d.line) d.line.style.display = d.dropElem ? 'none' : '';
    }
    d.dropDir = d.dropElem ? (d.dropElem.dataset.dirTarget ?? null) : null;
  };

  /**
   * @param {CardDrag} d
   * @param {boolean} [force] - Commit the derived gap even under the hysteresis threshold.
   */
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
    const d = drag;
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
    const d = drag;
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
  /** @param {KeyboardEvent} e */
  const onDragKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    endDrag(false);
  };

  /**
   * The ghost's pages as they are drawn now, front first.
   * @param {CardDrag} d
   * @returns {Array<{relPath: string, img: HTMLImageElement, from: {left: number, top: number, width: number, height: number}, rot: number, opacity: number}>}
   */
  const ghostPages = (d) => {
    if (!d.ghost || d.isRow || d.isDir) return [];
    const lift = d.ghost.querySelector('.scribe-ghost-lift');
    const scale = (new DOMMatrix(getComputedStyle(d.ghost).transform).a || 1) * (lift ? new DOMMatrix(getComputedStyle(lift).transform).a || 1 : 1);
    const cards = [...d.ghost.querySelectorAll('.scribe-ghost-card')].reverse();
    /** @type {ReturnType<typeof ghostPages>} */
    const out = [];
    cards.forEach((card, i) => {
      const img = d.fan[i]?.img;
      if (!img) return;
      const b = card.getBoundingClientRect();
      const w = /** @type {HTMLElement} */ (card).offsetWidth * scale;
      const h = /** @type {HTMLElement} */ (card).offsetHeight * scale;
      out.push({
        relPath: d.fan[i].relPath,
        img,
        from: {
          left: b.left + b.width / 2 - w / 2, top: b.top + b.height / 2 - h / 2, width: w, height: h,
        },
        rot: Number(/** @type {HTMLElement} */ (card).dataset.rot || 0),
        opacity: 0.95,
      });
    });
    return out;
  };

  /**
   * Glide the list's ghost to `to` and remove it on arrival.
   * @param {CardDrag} d
   * @param {{left: number, top: number, width: number, height: number}} to
   * @param {boolean} fade - Vanish into the target.
   * @param {number} ms
   */
  const glideRowGhost = (d, to, fade, ms) => {
    const g = d.ghost;
    if (!g) return Promise.resolve();
    if (reducedMotion()) {
      g.remove();
      return Promise.resolve();
    }
    const r = g.getBoundingClientRect();
    g.style.transition = 'none';
    g.style.transformOrigin = '0 0';
    g.style.left = `${r.left}px`;
    g.style.top = `${r.top}px`;
    g.style.transform = `scale(${r.width / g.offsetWidth})`;
    g.getBoundingClientRect();
    const scale = fade ? Math.min(1, Math.max(0.1, to.height / g.offsetHeight)) : 1;
    g.style.transition = `transform ${ms}ms ease, opacity ${ms}ms ease`;
    g.style.transform = `translate(${to.left - r.left}px, ${to.top - r.top}px) scale(${scale})`;
    if (fade) g.style.opacity = '0';
    return new Promise((resolve) => {
      setTimeout(() => {
        g.remove();
        resolve();
      }, ms + 20);
    });
  };

  /**
   * Where each carried page lands in `target`.
   * @param {HTMLElement} target
   * @param {Map<string, string>} hashByPath - relPath -> document hash.
   * @returns {(relPath: string) => {to: {left: number, top: number, width: number, height: number}, fade: boolean}}
   */
  const landingSpots = (target, hashByPath) => {
    const reserved = new Map([...target.querySelectorAll('.paper.reserved')].map((paper) => [/** @type {HTMLElement} */ (paper).dataset.paper ?? '', paper.getBoundingClientRect()]));
    const fold = target.querySelector('.scribe-library-fold');
    const foldRect = fold ? fold.getBoundingClientRect() : null;
    const icon = target.querySelector('.fi');
    const iconRect = (icon || target).getBoundingClientRect();
    return (relPath) => {
      const slot = reserved.get(hashByPath.get(relPath) ?? '');
      if (slot) return { to: slot, fade: false };
      if (foldRect) {
        return {
          to: {
            left: foldRect.left + foldRect.width / 2 - 20, top: foldRect.top + 8, width: 40, height: 52,
          },
          fade: true,
        };
      }
      return {
        to: {
          left: iconRect.left + iconRect.width / 2 - 12, top: iconRect.top + iconRect.height / 2 - 16, width: 24, height: 32,
        },
        fade: true,
      };
    };
  };

  /**
   * Re-render, sliding every card or row whose place changed from its old slot.
   * @param {string[]} [still] - Items to leave un-slid.
   */
  const renderWithSlide = (still = []) => {
    const SEL = '[data-band="folders-grid"] > .scribe-library-card, [data-band="main-grid"] > .scribe-library-card, [data-band="rows"] > .scribe-library-row';
    const beforeRects = new Map();
    for (const el of body.querySelectorAll(SEL)) beforeRects.set(/** @type {HTMLElement} */ (el).dataset.relPath, el.getBoundingClientRect());
    renderPending = false;
    render();
    if (reducedMotion()) return;
    /** @type {HTMLElement[]} */
    const moved = [];
    for (const el of body.querySelectorAll(SEL)) {
      const elem = /** @type {HTMLElement} */ (el);
      const prev = beforeRects.get(elem.dataset.relPath);
      if (!prev || still.includes(elem.dataset.relPath ?? '')) continue;
      const now = elem.getBoundingClientRect();
      const dx = prev.left - now.left;
      const dy = prev.top - now.top;
      if (!dx && !dy) continue;
      elem.style.transition = 'none';
      elem.style.transform = `translate(${dx}px, ${dy}px)`;
      moved.push(elem);
    }
    // A synchronous layout read commits the translated positions before the slide-back transition arms.
    if (moved.length) body.getBoundingClientRect();
    for (const elem of moved) {
      elem.style.transition = `transform ${REORDER_SLIDE_MS}ms ease`;
      elem.style.transform = '';
      elem.addEventListener('transitionend', () => {
        elem.style.transition = '';
      }, { once: true });
    }
  };

  /**
   * Put the carried cards back as they were.
   * @param {CardDrag} d
   */
  const settleBack = async (d) => {
    const release = () => {
      for (const p of d.carried) elemOf(p)?.classList.remove('dragging');
    };
    if (!d.ghost) {
      release();
      return;
    }
    if (d.isRow || d.isDir) {
      const home = d.isDir ? (d.cardElem.querySelector('.scribe-library-fold') ?? d.cardElem) : d.cardElem;
      await glideRowGhost(d, home.getBoundingClientRect(), false, REORDER_SLIDE_MS);
      release();
      return;
    }
    const pages = ghostPages(d);
    d.ghost.remove();
    if (reducedMotion()) {
      release();
      return;
    }
    /** @type {Parameters<typeof flyCopies>[0]} */
    const flights = [];
    for (const page of pages) {
      const home = elemOf(page.relPath)?.querySelector('img.thumb');
      if (!home) continue;
      flights.push({
        img: page.img, from: page.from, to: home.getBoundingClientRect(), rot: page.rot, opacity: page.opacity, fit: 'contain',
      });
    }
    await flyCopies(flights, REORDER_SLIDE_MS);
    release();
  };

  /**
   * Move the carried items into the dropped-on folder or crumb while the hand flies into it.
   * @param {CardDrag} d
   */
  const commitMove = async (d) => {
    const target = /** @type {HTMLElement} */ (d.dropElem);
    const destDir = /** @type {string} */ (d.dropDir);
    const manifest = getManifest();
    const isFolder = target.classList.contains('folder');
    const docs = d.carried.filter((p) => !p.endsWith('/'));
    if (isFolder) {
      const entries = docs.map((p) => manifest?.docs[p]).filter((e) => !!e);
      startLanding(destDir, /** @type {import('./libraryStore.js').LibraryDocEntry[]} */ (entries));
    }
    /** @type {Map<string, string>} */
    const hashByPath = new Map(docs.map((p) => [p, manifest?.docs[p]?.hash ?? '']));
    const spotOf = landingSpots(target, hashByPath);
    /** @type {Promise<void>} */
    let flight;
    if (d.isRow || d.isDir) {
      const spot = spotOf(d.relPath);
      flight = glideRowGhost(d, spot.to, true, FOLDER_FLY_MS);
    } else {
      const pages = ghostPages(d);
      d.ghost?.remove();
      flight = reducedMotion() ? Promise.resolve() : flyCopies(pages.map((page) => {
        const spot = spotOf(page.relPath);
        return {
          img: page.img, from: page.from, to: spot.to, rot: page.rot, opacity: page.opacity, fade: spot.fade, fit: 'cover',
        };
      }), FOLDER_FLY_MS);
    }
    const pressed = d.isDir ? d.relPath.slice(0, -1) : d.relPath;
    const cut = pressed.lastIndexOf('/');
    const fromDir = cut < 0 ? '' : pressed.slice(0, cut);
    const { moves, failed } = await moveItems(d.carried, destDir);
    // The render below draws a vacated slot, so a crumb drop records its undo first.
    if (!isFolder) finishLanding(destDir, moves, fromDir);
    renderWithSlide();
    for (const p of failed) elemOf(p)?.classList.remove('dragging');
    await flight;
    if (isFolder) finishLanding(destDir, moves, fromDir);
    else target.classList.remove('drop');
  };

  /**
   * Put the carried cards at the insertion gap under the Custom sort.
   * @param {CardDrag} d
   * @param {import('./libraryStore.js').LibraryManifest} manifest
   */
  const commitReorder = async (d, manifest) => {
    const paths = gridPaths.slice();
    const moving = paths.filter((p) => d.carried.includes(p));
    const before = paths.slice(0, d.gap).filter((p) => !moving.includes(p));
    const after = paths.slice(d.gap).filter((p) => !moving.includes(p));
    const next = [...before, ...moving, ...after];
    if (!moving.length || next.every((p, i) => p === paths[i])) {
      await settleBack(d);
      return;
    }
    // The displayed order becomes the manual order wholesale, so every doc in the folder gets a concrete position the first time one is placed.
    next.forEach((p, i) => {
      const entry = manifest.docs[p];
      if (entry) entry.order = i;
    });
    saveManifestSoon();
    const pages = ghostPages(d);
    d.ghost?.remove();
    renderWithSlide(moving);
    if (reducedMotion()) {
      for (const p of moving) body.querySelector(`[data-rel-path="${CSS.escape(p)}"]`)?.classList.remove('dragging');
      return;
    }
    /** @type {HTMLImageElement[]} */
    const hidden = [];
    /** @type {Parameters<typeof flyCopies>[0]} */
    const flights = [];
    for (const page of pages) {
      const img = /** @type {?HTMLImageElement} */ (body.querySelector(`[data-band="main-grid"] > [data-rel-path="${CSS.escape(page.relPath)}"] img.thumb`));
      if (!img) continue;
      img.style.opacity = '0';
      hidden.push(img);
      flights.push({
        img: page.img, from: page.from, to: img.getBoundingClientRect(), rot: page.rot, opacity: page.opacity, fit: 'contain',
      });
    }
    await flyCopies(flights, REORDER_SLIDE_MS);
    for (const img of hidden) img.style.opacity = '';
    for (const p of moving) body.querySelector(`[data-rel-path="${CSS.escape(p)}"]`)?.classList.remove('dragging');
  };

  /** @param {boolean} commit */
  const endDrag = (commit) => {
    const d = drag;
    if (!d) return;
    const manifest = getManifest();
    drag = null;
    window.clearTimeout(d.holdTimer);
    window.removeEventListener('pointermove', onDragMove);
    window.removeEventListener('pointerup', onDragUp);
    window.removeEventListener('pointercancel', onDragCancel);
    window.removeEventListener('keydown', onDragKey);
    document.removeEventListener('touchmove', blockTouchScroll);
    if (d.rafId) cancelAnimationFrame(d.rafId);
    d.line?.remove();
    surface.classList.remove('card-drag');
    if (!d.started) {
      if (renderPending) {
        renderPending = false;
        render();
      }
      return;
    }
    suppressClickUntil = Date.now() + 350;
    const dropping = commit && d.dropDir != null && !!manifest && !!d.dropElem;
    if (!dropping && d.dropElem) {
      d.dropElem.classList.remove('drop');
      if (d.dropElem.classList.contains('folder')) unpreviewFolder(d.dropElem, d.dropElem.dataset.dirTarget ?? '');
    }
    if (d.isTouch) {
      lastTouchDragT = Date.now();
      // A lift released without ever dragging opens the card menu, the touch home for Remove.
      if (commit && !d.moved) {
        d.ghost?.remove();
        for (const p of d.carried) elemOf(p)?.classList.remove('dragging');
        if (renderPending) {
          renderPending = false;
          render();
        }
        openCardMenu(d.startX, d.startY, d.relPath, d.cardElem);
        return;
      }
    }
    if (dropping) {
      commitMove(d);
      return;
    }
    if (commit && d.canReorder && d.gap >= 0 && manifest) {
      commitReorder(d, manifest);
      return;
    }
    settleBack(d).then(() => {
      if (renderPending) {
        renderPending = false;
        render();
      }
    });
  };

  /**
   * @param {PointerEvent} e
   * @param {string} relPath
   * @param {HTMLElement} card
   */
  const beginCardDrag = (e, relPath, card) => {
    if (drag || !dragAllowed()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // A sloppy modifier-click must land as a selection click, never arm a reorder drag.
    if (e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (e.target instanceof Element && e.target.closest('.actions')) return;
    const isTouch = e.pointerType !== 'mouse';
    drag = {
      relPath,
      cardElem: card,
      isRow: false,
      isDir: relPath.endsWith('/'),
      carried: [relPath],
      fan: [],
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      started: false,
      moved: false,
      canReorder: reorderAllowed() && !relPath.endsWith('/'),
      dropDir: null,
      dropElem: null,
      ghost: null,
      line: null,
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
      drag.holdTimer = window.setTimeout(() => {
        const d = drag;
        if (d && !d.started) {
          startDragVisuals(d);
          document.addEventListener('touchmove', blockTouchScroll, { passive: false });
        }
      }, LIFT_HOLD_MS);
    }
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragUp);
    window.addEventListener('pointercancel', onDragCancel);
    window.addEventListener('keydown', onDragKey);
  };

  return {
    beginCardDrag,

    renderWithSlide: () => renderWithSlide(),

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
    active: () => drag !== null,

    /**
     * Hold a render until the drop, since a rebuild mid-drag would pull the card out from under the pointer.
     * @returns {boolean} Whether the caller should skip its render.
     */
    deferRender: () => {
      if (!drag?.started) return false;
      renderPending = true;
      return true;
    },

    /** Whether a drag or another gesture just ended, so the click that closes it does not also open a card. */
    clickSuppressed: () => Date.now() < suppressClickUntil,

    /** Ignore the click another gesture's release is about to fire. */
    suppressClick: () => { suppressClickUntil = Date.now() + 350; },

    /** Whether a touch drag just ended, so the native long-press contextmenu racing it is swallowed. */
    touchDragRecent: () => Date.now() - lastTouchDragT < 500,

    /** Abandon any live drag without replaying the render it deferred. */
    cancel: () => {
      renderPending = false;
      if (drag) endDrag(false);
    },
  };
}
