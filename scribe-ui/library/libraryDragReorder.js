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
const CHIP_EDGE = 8;
const CHIP_GRIP_TOP = 6;
const GATHER_MS = 170;
const FLICK_PX = 24;
const FLICK_MS = 60;

/**
 * A press on a card or row in the library grid, from the press through the drag it may become.
 * @typedef {Object} CardDrag
 * @property {string} relPath - The pressed card's document, or a folder key with its trailing slash.
 * @property {HTMLElement} cardElem - The pressed card or row.
 * @property {HTMLElement} scroller - What scrolls the pressed item: the list's column, or the body for the grid.
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
 * @property {boolean} chip - Whether the hand is the list's name chip (a document row's drag).
 * @property {number} pageW - The chip's page size at rest.
 * @property {number} pageH
 * @property {boolean} overBar - Whether the pointer has reached the bar at any time during the drag.
 */

/**
 * Install card drag-to-reorder over the library grid.
 * @param {Object} deps
 * @param {import('../basic-viewer/pdf-viewer.js').ScribePDFViewer} deps.viewer
 * @param {HTMLElement} deps.surface - Library root, flagged with a class for the length of a drag.
 * @param {HTMLElement} deps.body - The surface the cards and rows live in, which scrolls the grid.
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
 * @param {(img: HTMLImageElement, relPath: string) => void} deps.thumbFor - Point an image at a document's thumbnail.
 * @param {(reached: boolean, afterCrumbDrop: boolean) => void} deps.barApproach - Unfold a folded path when the pointer reaches the bar mid-drag, or fold it back when that drag ends.
 */
export function createDragReorder({
  viewer, surface, body, selectedPaths, getManifest, saveManifestSoon, render, openCardMenu, dragAllowed, reorderAllowed,
  previewFolder, unpreviewFolder, startLanding, moveItems, foldFor, finishLanding, thumbFor, barApproach,
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
   * Build the list's hand for a document row.
   * @param {CardDrag} d
   */
  const buildChipGhost = (d) => {
    const ghost = document.createElement('div');
    ghost.className = 'scribe-library-ghost chip scribe-pdf-viewer';
    const theme = viewer.pdfViewerElem.getAttribute('data-theme');
    if (theme) ghost.setAttribute('data-theme', theme);
    ghost.style.fontFamily = getComputedStyle(viewer.pdfViewerElem).fontFamily;
    const rowImg = d.cardElem.querySelector(':scope > .nm > img');
    // A portfolio's cover sheet is never shown, so a row whose image is hidden lifts a chip with the name alone.
    const page = rowImg && rowImg.getBoundingClientRect().width > 0 ? document.createElement('img') : null;
    if (page) {
      page.className = 'pg';
      page.alt = '';
      page.draggable = false;
      if (rowImg instanceof HTMLImageElement && rowImg.src) page.src = rowImg.src;
      else thumbFor(page, d.relPath);
    } else ghost.classList.add('nopage');
    const col = document.createElement('span');
    col.className = 'col';
    const name = document.createElement('span');
    name.className = 'n';
    name.textContent = titleOf(d.relPath);
    const dest = document.createElement('span');
    dest.className = 'dest';
    dest.appendChild(document.createElement('span'));
    col.appendChild(name);
    col.appendChild(dest);
    if (page) ghost.appendChild(page);
    ghost.appendChild(col);
    if (d.carried.length > 1) ghost.appendChild(countBadge(d.carried.length));
    document.body.appendChild(ghost);
    d.pageW = page ? page.offsetWidth : 0;
    d.pageH = page ? page.offsetHeight : 0;
    return ghost;
  };

  /**
   * Set where the pointer holds the chip.
   * @param {CardDrag} d
   */
  const chipGrip = (d) => {
    const ghost = /** @type {HTMLElement} */ (d.ghost);
    const handW = ghost.offsetWidth;
    const title = /** @type {HTMLElement} */ (d.cardElem.querySelector('.nm .t'));
    const range = document.createRange();
    range.selectNodeContents(title);
    const tr = range.getBoundingClientRect();
    const rowImg = d.cardElem.querySelector(':scope > .nm > img');
    const pr = rowImg && rowImg.getBoundingClientRect().width > 0 ? rowImg.getBoundingClientRect() : null;
    const hr = ghost.getBoundingClientRect();
    const chipPage = ghost.querySelector('img.pg');
    const cr = chipPage ? chipPage.getBoundingClientRect() : null;
    const pageL = cr ? cr.left - hr.left : 0;
    const pageR = cr ? pageL + cr.width : 0;
    const textL = cr ? pageR + 10 : /** @type {HTMLElement} */ (ghost.querySelector('.n')).getBoundingClientRect().left - hr.left;
    const textR = handW - 12;
    const x = d.startX;
    const leftEdge = pr ? pr.left : tr.left;
    let ox;
    if (x > tr.right) ox = handW - CHIP_EDGE;
    else if (x < leftEdge) ox = CHIP_EDGE;
    else if (pr && x <= pr.right) ox = pageL + ((x - pr.left) / pr.width) * (pageR - pageL);
    else if (x < tr.left) ox = pageR + ((x - (pr ? pr.right : tr.left)) / Math.max(1, tr.left - (pr ? pr.right : tr.left))) * (textL - pageR);
    else ox = textL + ((x - tr.left) / Math.max(1, tr.width)) * (textR - textL);
    d.grabDX = Math.max(CHIP_EDGE, Math.min(handW - CHIP_EDGE, ox));
    d.grabDY = CHIP_GRIP_TOP;
  };

  /**
   * The chip's place with its page on the row's page, or its name on the row's name when the row shows no page.
   * @param {CardDrag} d
   */
  const chipHome = (d) => {
    const ghost = /** @type {HTMLElement} */ (d.ghost);
    const page = ghost.querySelector('img.pg');
    const hr = ghost.getBoundingClientRect();
    const rowImg = d.cardElem.querySelector(':scope > .nm > img');
    if (page && rowImg && rowImg.getBoundingClientRect().width > 0) {
      const cr = page.getBoundingClientRect();
      const r = rowImg.getBoundingClientRect();
      return {
        left: r.left - (cr.left - hr.left), top: r.top - (cr.top - hr.top), pageW: r.width, pageH: r.height, gap: 12,
      };
    }
    const nameL = /** @type {HTMLElement} */ (ghost.querySelector('.n')).getBoundingClientRect().left - hr.left;
    const r = /** @type {HTMLElement} */ (d.cardElem.querySelector('.nm .t')).getBoundingClientRect();
    return {
      left: r.left - nameL, top: r.top + r.height / 2 - hr.height / 2, pageW: d.pageW, pageH: d.pageH, gap: page ? 10 : 0,
    };
  };

  /**
   * Animate the chip's lift out of its row.
   * @param {CardDrag} d
   */
  const gatherIn = (d) => {
    const ghost = /** @type {HTMLElement} */ (d.ghost);
    if (reducedMotion()) {
      ghost.style.width = `${ghost.offsetWidth}px`;
      return;
    }
    const page = ghost.querySelector('img.pg');
    const home = chipHome(d);
    const cs = getComputedStyle(ghost);
    const plate = { backgroundColor: cs.backgroundColor, borderColor: cs.borderTopColor, boxShadow: cs.boxShadow };
    if (page) {
      page.animate([{ width: `${home.pageW}px`, height: `${home.pageH}px` }, { width: `${d.pageW}px`, height: `${d.pageH}px` }], { duration: GATHER_MS, easing: 'ease' });
      ghost.animate([{ columnGap: `${home.gap}px` }, { columnGap: cs.columnGap }], { duration: GATHER_MS, easing: 'ease' });
    }
    ghost.animate([{ backgroundColor: 'transparent', borderColor: 'transparent', boxShadow: 'none' }, plate], { duration: GATHER_MS, easing: 'ease' });
    const t0 = performance.now();
    /** @param {number} now */
    const step = (now) => {
      if (drag !== d || !d.ghost) return;
      const p = Math.max(0, Math.min(1, (now - t0) / GATHER_MS));
      const e = 1 - (1 - p) ** 3;
      const curLeft = d.lastX - d.grabDX;
      const curTop = d.lastY - d.grabDY;
      ghost.style.transform = `translate(${(home.left - curLeft) * (1 - e)}px, ${(home.top - curTop) * (1 - e)}px)`;
      if (p < 1) {
        requestAnimationFrame(step);
        return;
      }
      ghost.style.transform = '';
      // Pinned once the page is at rest, so the destination line opening under the name never widens the chip.
      ghost.style.width = `${ghost.offsetWidth}px`;
    };
    requestAnimationFrame(step);
  };

  /**
   * Animate the chip back into its row when a drag ends without a drop.
   * @param {CardDrag} d
   */
  const gatherOut = (d) => {
    const ghost = /** @type {HTMLElement} */ (d.ghost);
    const row = d.cardElem;
    const nm = /** @type {?HTMLElement} */ (row.querySelector(':scope > .nm'));
    const release = () => {
      ghost.remove();
      if (nm) nm.style.opacity = '';
      for (const p of d.carried) elemOf(p)?.classList.remove('dragging');
    };
    if (reducedMotion()) {
      release();
      return Promise.resolve();
    }
    const page = ghost.querySelector('img.pg');
    const r = ghost.getBoundingClientRect();
    const pr = page ? page.getBoundingClientRect() : null;
    const cs = getComputedStyle(ghost);
    const from = {
      bg: cs.backgroundColor, bd: cs.borderTopColor, sh: cs.boxShadow, gap: cs.columnGap, w: pr ? pr.width : 0, h: pr ? pr.height : 0,
    };
    for (const a of ghost.getAnimations({ subtree: true })) a.cancel();
    ghost.classList.remove('has-dest');
    ghost.style.transform = 'none';
    ghost.style.left = `${r.left}px`;
    ghost.style.top = `${r.top}px`;
    // The chip may widen as its page grows on the way back, but never shrink.
    ghost.style.width = '';
    ghost.style.minWidth = `${r.width}px`;
    const home = chipHome(d);
    if (nm) nm.style.opacity = '0';
    const gone = { backgroundColor: 'transparent', borderColor: 'transparent', boxShadow: 'none' };
    const anims = [
      ghost.animate([{ transform: 'none' }, { transform: `translate(${home.left - r.left}px, ${home.top - r.top}px)` }], { duration: GATHER_MS, easing: 'ease', fill: 'forwards' }),
      ghost.animate([{ backgroundColor: from.bg, borderColor: from.bd, boxShadow: from.sh }, { ...gone, offset: 0.7 }, gone], { duration: GATHER_MS, easing: 'ease', fill: 'forwards' }),
    ];
    if (page) {
      anims.push(page.animate([{ width: `${from.w}px`, height: `${from.h}px` }, { width: `${home.pageW}px`, height: `${home.pageH}px` }], { duration: GATHER_MS, easing: 'ease', fill: 'forwards' }));
      anims.push(ghost.animate([{ columnGap: from.gap }, { columnGap: `${home.gap}px` }], { duration: GATHER_MS, easing: 'ease', fill: 'forwards' }));
    }
    return Promise.all(anims.map((a) => a.finished)).then(() => {
      release();
      for (const cell of row.querySelectorAll(':scope > :not(.nm)')) cell.animate([{ opacity: 0.3 }, { opacity: 1 }], { duration: 100, easing: 'ease' });
    }, release);
  };

  /**
   * Flick the chip toward the drop target as it fades out.
   * @param {CardDrag} d
   * @param {HTMLElement} target
   */
  const flickInto = (d, target) => {
    const ghost = /** @type {HTMLElement} */ (d.ghost);
    if (reducedMotion()) {
      ghost.remove();
      return Promise.resolve();
    }
    const pr = /** @type {HTMLElement} */ (ghost.querySelector('img.pg') ?? ghost.querySelector('.n')).getBoundingClientRect();
    const icon = target.querySelector('.scribe-library-fold') ?? target.querySelector('.fi');
    let aimX;
    if (icon) {
      const ir = icon.getBoundingClientRect();
      aimX = ir.left + ir.width / 2;
    } else if (target.classList.contains('scribe-library-crumb')) aimX = target.getBoundingClientRect().left + 16;
    else aimX = (target.querySelector('.nm .t') ?? target).getBoundingClientRect().left + 8;
    const away = aimX - (pr.left + pr.width / 2);
    const dx = Math.abs(away) > FLICK_PX ? Math.sign(away) * FLICK_PX : away;
    // A drop during the lift composes the flick with the gather's offset rather than snapping the chip to the pointer.
    const cur = getComputedStyle(ghost).transform;
    const base = cur === 'none' ? '' : ` ${cur}`;
    const anim = ghost.animate([{ transform: cur, opacity: 1 }, { transform: `translate(${dx}px, 0)${base}`, opacity: 0 }], { duration: FLICK_MS, easing: 'ease', fill: 'forwards' });
    const done = () => ghost.remove();
    return anim.finished.then(done, done);
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
      d.chip = true;
      d.ghost = buildChipGhost(d);
      chipGrip(d);
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
    // The chip's position is driven per frame while it gathers, which a transition on its transform would smear.
    d.ghost.style.transition = reducedMotion() || d.chip ? 'none' : `transform ${OVER_TARGET_MS}ms ease`;
    for (const p of d.carried) elemOf(p)?.classList.add('dragging');
    surface.classList.add('card-drag');
    if (d.chip) surface.classList.add('chip-drag');
    if (d.canReorder && mainGridElem) {
      d.line = document.createElement('div');
      d.line.className = 'scribe-library-insert-line';
      mainGridElem.appendChild(d.line);
      updateGap(d, true);
    }
    positionGhost(d);
    if (d.chip) gatherIn(d);
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
    let target = under && /** @type {?HTMLElement} */ (under.closest('[data-dir-target]'));
    if (!target && viewer.toolbarElem) {
      const bar = viewer.toolbarElem.getBoundingClientRect();
      if (d.lastY >= bar.top && d.lastY <= bar.bottom && d.lastX >= bar.left && d.lastX <= bar.right) {
        for (const crumb of viewer.toolbarElem.querySelectorAll('.scribe-library-crumb[data-dir-target]')) {
          const r = crumb.getBoundingClientRect();
          if (r.width && d.lastX >= r.left - 3 && d.lastX <= r.right + 3) {
            target = /** @type {HTMLElement} */ (crumb);
            break;
          }
        }
      }
    }
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
      if (d.ghost && !d.chip) d.ghost.style.transform = d.dropElem ? `scale(${d.isDir ? FOLDER_OVER_TARGET_SCALE : OVER_TARGET_SCALE})` : '';
      if (d.ghost && d.chip) {
        const up = d.dropElem && !d.dropElem.classList.contains('folder');
        const line = /** @type {HTMLElement} */ (d.ghost.querySelector('.dest > span'));
        if (up) line.textContent = `Move to ${(d.dropElem?.textContent ?? '').trim()}`;
        d.ghost.classList.toggle('has-dest', !!up);
      }
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
    d.scroller.scrollTop += d.autoDir * AUTOSCROLL_SPEED;
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
    if (!d.overBar && viewer.toolbarElem) {
      const bar = viewer.toolbarElem.getBoundingClientRect();
      if (e.clientY >= bar.top - 2 && e.clientY <= bar.bottom + 2 && e.clientX >= bar.left && e.clientX <= bar.right) {
        d.overBar = true;
        barApproach(true, false);
      }
    }
    updateDropTarget(d);
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > MENU_SLOP) d.moved = true;
    const scrollRect = d.scroller.getBoundingClientRect();
    if (e.clientY < scrollRect.top + AUTOSCROLL_EDGE) d.autoDir = -1;
    else if (e.clientY > scrollRect.bottom - AUTOSCROLL_EDGE) d.autoDir = 1;
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
    if (d.chip) {
      await gatherOut(d);
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
    if (d.chip) {
      flight = flickInto(d, target);
    } else if (d.isRow || d.isDir) {
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
    surface.classList.remove('card-drag', 'chip-drag');
    if (d.overBar) barApproach(false, commit && !!d.dropElem && d.dropDir != null && !d.dropElem.classList.contains('folder'));
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
      scroller: /** @type {HTMLElement} */ (card.closest('.scribe-library-rlist') ?? body),
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
      chip: false,
      pageW: 0,
      pageH: 0,
      overBar: false,
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
