// Freestanding note comments (PDF /Text): create, render, drag, and edit note marks in a dedicated per-page overlay layer.
// A note is a comment not anchored to text.
// Its model shape is `{ type:'text', bbox, comment, ... }` in viewer.doc.annotations.pages[n] (the same store highlights use).
import { TEXT_ANNOT_ICON_PX } from '../../js/pdf/parsePdfAnnots.js';
import { COMMENT_MARK_SVG } from './viewerLayerStyles.js';

/**
 * Return the freestanding text notes on page n.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 * @returns {AnnotationText[]}
 */
function pageNotes(viewer, n) {
  return (viewer.doc.annotations.pages[n] || []).filter((a) => a.type === 'text');
}

/**
 * Create a note annotation at page-local pixel point (x, y) and stamp its author and creation date.
 * @param {import('../viewer.js').ScribeViewer} viewer @param {number} n @param {number} x @param {number} y
 * @returns {AnnotationText} the new note annotation
 */
export function createNote(viewer, n, x, y) {
  /** @type {AnnotationText} */
  const annot = {
    type: 'text',
    bbox: {
      left: x, top: y, right: x + TEXT_ANNOT_ICON_PX, bottom: y + TEXT_ANNOT_ICON_PX,
    },
    comment: '',
    open: true,
    createdAt: new Date().toISOString(),
  };
  const author = viewer.opt && viewer.opt.commentAuthor;
  if (author) annot.author = author;
  if (!viewer.doc.annotations.pages[n]) viewer.doc.annotations.pages[n] = [];
  viewer.doc.annotations.pages[n].push(annot);
  return annot;
}

/**
 * Set a note's comment, stamping author/date on first authoring (author from viewer.opt.commentAuthor).
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {AnnotationText} annot
 * @param {string} comment
 */
export function setNoteComment(viewer, annot, comment) {
  annot.comment = comment;
  const author = viewer.opt && viewer.opt.commentAuthor;
  if (comment) {
    if (author && !annot.author) annot.author = author;
    if (!annot.createdAt) annot.createdAt = new Date().toISOString();
  }
}

/**
 * Remove a note annotation from page n.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {AnnotationText} annot
 * @param {number} n
 */
export function removeNote(viewer, annot, n) {
  viewer.doc.annotations.pages[n] = (viewer.doc.annotations.pages[n] || []).filter((a) => a !== annot);
}

/**
 * Drag a note icon to reposition it.
 * Converts the pointer's screen delta to page-local pixels via the zoom level, and marks the icon as dragged so the trailing click does not open the editor.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {AnnotationText} annot
 * @param {HTMLElement} icon
 * @param {PointerEvent} event
 * @param {number} n
 */
function startNoteDrag(viewer, annot, icon, event, n) {
  event.preventDefault();
  const z = viewer.zoomLevel || 1;
  const startX = event.clientX;
  const startY = event.clientY;
  const origLeft = annot.bbox.left;
  const origTop = annot.bbox.top;
  const pm = viewer.doc.pageMetrics[n];
  const maxLeft = pm ? Math.max(0, pm.dims.width - TEXT_ANNOT_ICON_PX) : Infinity;
  const maxTop = pm ? Math.max(0, pm.dims.height - TEXT_ANNOT_ICON_PX) : Infinity;
  let moved = false;
  const onMove = (ev) => {
    const dx = (ev.clientX - startX) / z;
    const dy = (ev.clientY - startY) / z;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
    annot.bbox.left = Math.min(maxLeft, Math.max(0, origLeft + dx));
    annot.bbox.top = Math.min(maxTop, Math.max(0, origTop + dy));
    annot.bbox.right = annot.bbox.left + TEXT_ANNOT_ICON_PX;
    annot.bbox.bottom = annot.bbox.top + TEXT_ANNOT_ICON_PX;
    icon.style.left = `${annot.bbox.left}px`;
    icon.style.top = `${annot.bbox.top}px`;
  };
  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    if (moved) icon.dataset.dragged = '1';
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
    icon.innerHTML = COMMENT_MARK_SVG;
    icon.style.left = `${annot.bbox.left}px`;
    icon.style.top = `${annot.bbox.top}px`;
    if (annot.color) icon.style.color = annot.color;
    icon.addEventListener('pointerdown', (e) => startNoteDrag(viewer, annot, icon, e, n));
    group.appendChild(icon);
  });
}

/**
 * Open a note's editor: its comment card, pinned with the text focused.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 * @param {AnnotationText} annot
 */
export function focusNoteEditor(viewer, n, annot) {
  if (pageNotes(viewer, n).indexOf(annot) < 0) return;
  // Re-render first so the card has a live mark to anchor on.
  viewer.renderNotes(n);
  if (viewer._pinNoteCard) viewer._pinNoteCard(annot, n);
}
