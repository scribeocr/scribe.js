// Freestanding note comments (PDF /Text): create, render, drag, and edit note marks in a dedicated per-page overlay layer.
// A note is a comment not anchored to text.
import { TEXT_ANNOT_ICON_PX } from '../../js/pdf/parsePdfAnnots.js';
import { populateBubbleMark, computePageBubbleZoom, dropPreviewStrip } from './viewerCommentMarks.js';

/**
 * Return the freestanding text notes on page n.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 * @returns {AnnotationText[]}
 */
export function pageNotes(viewer, n) {
  return (viewer.doc.annotations.pages[n] || []).filter((a) => a.type === 'text');
}

/**
 * Create a note annotation at page-local pixel point (x, y).
 * @param {import('../viewer.js').ScribeViewer} viewer @param {number} n @param {number} x @param {number} y
 * @returns {AnnotationText}
 */
export function createNote(viewer, n, x, y) {
  /** @type {AnnotationText} */
  const annot = {
    type: 'text',
    bbox: {
      left: x, top: y, right: x + TEXT_ANNOT_ICON_PX, bottom: y + TEXT_ANNOT_ICON_PX,
    },
    comment: '',
    open: false,
    createdAt: new Date().toISOString(),
  };
  const author = viewer.opt && viewer.opt.commentAuthor;
  if (author) annot.author = author;
  if (!viewer.doc.annotations.pages[n]) viewer.doc.annotations.pages[n] = [];
  const undoSnap = viewer.doc.docHistory.snapshotAnnots(viewer.doc.annotations, [n]);
  viewer.doc.annotations.pages[n].push(annot);
  viewer.doc.docHistory.recordAnnots(undoSnap, 'Added note');
  return annot;
}

/**
 * Set a note annotation's comment.
 * Records `viewer.opt.commentAuthor` and creation date when first non-empty.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {AnnotationText} annot
 * @param {string} comment
 */
export function setNoteComment(viewer, annot, comment) {
  const n = viewer.doc.annotations.pages.findIndex((p) => p && p.includes(annot));
  viewer.doc.docHistory.recordAnnotFields([annot], ['comment', 'author', 'createdAt'], n >= 0 ? [n] : [], 'Edited note', () => {
    annot.comment = comment;
    const author = viewer.opt && viewer.opt.commentAuthor;
    if (comment) {
      if (author && !annot.author) annot.author = author;
      if (!annot.createdAt) annot.createdAt = new Date().toISOString();
    }
  });
}

/**
 * Remove a note annotation from page n.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {AnnotationText} annot
 * @param {number} n
 */
export function removeNote(viewer, annot, n) {
  const undoSnap = viewer.doc.docHistory.snapshotAnnots(viewer.doc.annotations, [n]);
  viewer.doc.annotations.pages[n] = (viewer.doc.annotations.pages[n] || []).filter((a) => a !== annot);
  viewer.doc.docHistory.recordAnnots(undoSnap, 'Removed note');
}

/**
 * Place one note mark so the tip of its pointer lands on the note's anchor `(annot.bbox.left, annot.bbox.top)`, and set which way it unrolls on hover.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 * @param {HTMLElement} icon
 * @param {AnnotationText} annot
 */
function placeSingleNoteIcon(viewer, n, icon, annot) {
  const { dims } = viewer.doc.pageMetrics[n];
  const { z, effZ } = computePageBubbleZoom(viewer, n);
  const sizePage = 22 / effZ;
  const halfSpan = 11 / effZ;
  const x = annot.bbox.left;
  const y = annot.bbox.top;

  // The left edge of the page's upright text, taken as where the left margin ends.
  let colLeft = dims.width * 0.22;
  const ocrPage = viewer.doc.ocr.active?.[n];
  if (ocrPage) {
    let minL = Infinity;
    for (const ln of ocrPage.lines) {
      if (ln.words.length > 0 && ln.orientation === 0 && ln.bbox.left < minL) minL = ln.bbox.left;
    }
    if (minL < Infinity) colLeft = minL;
  }

  let leftScreenRoom = (x + halfSpan) * z - 8;
  let rightScreenRoom = (dims.width - x + halfSpan) * z - 8;
  const pc = viewer.pageContainerArr[n];
  const sc = viewer.scrollContainer;
  if (pc && sc && pc.isConnected && sc.isConnected) {
    const pcRect = pc.getBoundingClientRect();
    const scRect = sc.getBoundingClientRect();
    if (pcRect.width > 0 && scRect.width > 0) {
      leftScreenRoom = (pcRect.left + (x + halfSpan) * z) - (scRect.left + 8);
      rightScreenRoom = (scRect.right - 8) - (pcRect.left + (x - halfSpan) * z);
    }
  }

  const unrollLeft = (x < colLeft + 6 / effZ && leftScreenRoom >= 96)
    || (rightScreenRoom < 196 && leftScreenRoom > rightScreenRoom);
  const bTopPage = Math.max(4 / effZ, Math.min(dims.height - sizePage - 6 / effZ, y - 25 / effZ));
  let bLeftPage;
  if (unrollLeft) {
    const bRightPage = Math.max(halfSpan, Math.min(dims.width - 2 / effZ, x + halfSpan));
    bLeftPage = bRightPage - sizePage;
    icon.style.left = 'auto';
    icon.style.right = `${dims.width - bRightPage}px`;
  } else {
    bLeftPage = Math.max(2 / effZ, Math.min(dims.width - halfSpan, x - halfSpan));
    icon.style.right = 'auto';
    icon.style.left = `${bLeftPage}px`;
  }
  icon.style.top = `${bTopPage}px`;
  const tailClass = unrollLeft ? 'is-down-right' : 'is-down-left';
  // The comment card opens from these, so it lands exactly on the mark.
  icon.dataset.tail = tailClass;
  icon.dataset.lockRight = unrollLeft ? '1' : '0';
  icon.dataset.restLeftPage = String(bLeftPage);
  icon.dataset.restTopPage = String(bTopPage);
  icon.dataset.restW = String(sizePage * z);
  icon.dataset.restH = String(sizePage * z);
  populateBubbleMark(icon, {
    isNote: true,
    tailClass,
    comment: annot.comment || '',
    maxCardW: Math.floor(Math.max(unrollLeft ? leftScreenRoom : rightScreenRoom, 168)),
  });
}

/**
 * Place page n's rendered note marks for the current zoom and scroll position.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 */
export function placePageNotes(viewer, n) {
  const group = viewer._notesGroups[n];
  if (!group) return;
  const { z, effZ } = computePageBubbleZoom(viewer, n);
  group.style.setProperty('--scribe-live-zoom', String(z));
  group.style.setProperty('--scribe-bub-z', String(effZ));
  const notes = pageNotes(viewer, n);
  for (const el of group.querySelectorAll('.scribe-note-icon')) {
    const annot = notes[Number(/** @type {HTMLElement} */ (el).dataset.noteIdx)];
    if (annot) placeSingleNoteIcon(viewer, n, /** @type {HTMLElement} */ (el), annot);
  }
}

/**
 * Drag a note icon to reposition it.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {AnnotationText} annot
 * @param {HTMLElement} icon
 * @param {PointerEvent} event
 * @param {number} n
 */
function startNoteDrag(viewer, annot, icon, event, n) {
  if (event.button !== 0) return;
  event.preventDefault();
  const z = viewer.zoomLevel || 1;
  const startX = event.clientX;
  const startY = event.clientY;
  const origLeft = annot.bbox.left;
  const origTop = annot.bbox.top;
  const pm = viewer.doc.pageMetrics[n];
  const maxLeft = pm ? Math.max(0, pm.dims.width - TEXT_ANNOT_ICON_PX) : Infinity;
  const maxTop = pm ? Math.max(0, pm.dims.height - TEXT_ANNOT_ICON_PX) : Infinity;
  /** @type {?{x: number, y: number}} */
  let dragFrom = null;
  const onMove = (ev) => {
    if (!dragFrom) {
      const reach = Math.hypot(ev.clientX - startX, ev.clientY - startY);
      if (reach < 4) return;
      dragFrom = { x: startX + (ev.clientX - startX) * (4 / reach), y: startY + (ev.clientY - startY) * (4 / reach) };
      dropPreviewStrip(icon);
      icon.classList.remove('is-unrolled');
    }
    annot.bbox.left = Math.min(maxLeft, Math.max(0, origLeft + (ev.clientX - dragFrom.x) / z));
    annot.bbox.top = Math.min(maxTop, Math.max(0, origTop + (ev.clientY - dragFrom.y) / z));
    annot.bbox.right = annot.bbox.left + TEXT_ANNOT_ICON_PX;
    annot.bbox.bottom = annot.bbox.top + TEXT_ANNOT_ICON_PX;
    placeSingleNoteIcon(viewer, n, icon, annot);
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (!dragFrom) return;
    // Clear on the next macrotask in case pointerup lands off the icon and no click fires to consume the flag.
    icon.dataset.dragged = '1';
    setTimeout(() => { icon.dataset.dragged = ''; }, 0);
    // The drag mutated the bbox in place, so the entry captures value copies rather than the live object.
    const from = {
      left: origLeft, top: origTop, right: origLeft + TEXT_ANNOT_ICON_PX, bottom: origTop + TEXT_ANNOT_ICON_PX,
    };
    const to = { ...annot.bbox };
    viewer.doc.docHistory.record({
      surface: 'annot',
      label: 'Moved note',
      undo: () => { Object.assign(annot.bbox, from); return [n]; },
      redo: () => { Object.assign(annot.bbox, to); return [n]; },
    });
    viewer.annotationsEdited(n);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

/**
 * Render (or re-render) page n's notes into its dedicated notes layer.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 */
export function renderPageNotes(viewer, n) {
  const group = viewer.getNotesGroup(n);
  if (!group) return;
  group.replaceChildren();
  pageNotes(viewer, n).forEach((annot, idx) => {
    const icon = document.createElement('span');
    icon.className = 'scribe-note-icon';
    icon.dataset.noteIdx = String(idx);
    // The card delegation resolves the annot from the mark alone, so the mark carries its page.
    icon.dataset.pageN = String(n);
    icon.tabIndex = 0;
    icon.setAttribute('role', 'button');
    icon.setAttribute('aria-label', 'Note');
    icon.addEventListener('pointerdown', (e) => startNoteDrag(viewer, annot, icon, e, n));
    group.appendChild(icon);
  });
  placePageNotes(viewer, n);
}

/**
 * Open a note's comment card, with the text focused.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 * @param {AnnotationText} annot
 */
export function focusNoteEditor(viewer, n, annot) {
  if (pageNotes(viewer, n).indexOf(annot) < 0) return;
  // Re-render first so the card has a live mark to anchor on.
  viewer.renderNotes(n);
  if (viewer._openNoteCard) viewer._openNoteCard(annot, n);
}
