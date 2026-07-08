// Freestanding sticky-note comments (PDF /Text): create, render, drag, and edit note icons in a dedicated per-page overlay layer.
// A note is a comment not anchored to text.
// Its model shape is `{ type:'text', bbox, comment, ... }` in viewer.doc.annotations.pages[n] (the same store highlights use).
import { TEXT_ANNOT_ICON_PX } from '../../js/pdf/parsePdfAnnots.js';

const NOTE_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M4 4h16v10l-6 6H4z" fill="currentColor"/>'
  + '<path d="M20 14l-6 6v-5a1 1 0 0 1 1-1z" fill="rgba(0,0,0,.22)"/></svg>';

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
 * @returns {Object} the new note annotation
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
 * @param {import('../viewer.js').ScribeViewer} viewer @param {Object} annot @param {string} comment
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
 * @param {Object} annot
 * @param {number} n
 */
export function removeNote(viewer, annot, n) {
  viewer.doc.annotations.pages[n] = (viewer.doc.annotations.pages[n] || []).filter((a) => a !== annot);
}

/**
 * Drag a note icon to reposition it.
 * Converts the pointer's screen delta to page-local pixels via the zoom level, and marks the icon as dragged so the trailing click does not open the editor.
 * The icon is clamped to the page bounds, since off the page it would hide under the margin card and be impossible to recover.
 * @param {import('../viewer.js').ScribeViewer} viewer @param {Object} annot @param {HTMLElement} icon @param {PointerEvent} event @param {number} n
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
  // Move the note's margin card with the icon so the pair stays aligned during the drag.
  const card = icon.parentNode
    ? icon.parentNode.querySelector(`.scribe-note-card[data-note-idx="${icon.dataset.noteIdx}"]`) : null;
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
    if (card) card.style.top = `${annot.bbox.top}px`;
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
 * Each note gets two linked pieces: a small sticky at its bbox point (its true position + drag handle),
 * and a large matching sticky in the page's right margin (`left: 100%`), aligned to the note's line.
 * The large one is the same note blown up, showing its text.
 * Both are in the page's local frame (constant on-screen size applied by CSS).
 * Hovering either lights up the other via the shared `.linked` class.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 */
export function renderPageNotes(viewer, n) {
  const group = viewer.getNotesGroup(n);
  if (!group) return;
  group.replaceChildren();
  pageNotes(viewer, n).forEach((annot, idx) => {
    const idxStr = String(idx);
    const setLinked = (on) => {
      group.querySelectorAll(`[data-note-idx="${idxStr}"]`).forEach((el) => el.classList.toggle('linked', on));
    };

    // Small mark at the note's point (draggable, and a click focuses the inline editor).
    const icon = document.createElement('span');
    icon.className = 'scribe-note-icon';
    icon.dataset.noteIdx = idxStr;
    icon.innerHTML = NOTE_ICON_SVG;
    icon.style.left = `${annot.bbox.left}px`;
    icon.style.top = `${annot.bbox.top}px`;
    if (annot.color) icon.style.color = annot.color;
    icon.addEventListener('pointerdown', (e) => startNoteDrag(viewer, annot, icon, e, n));
    icon.addEventListener('click', (e) => {
      e.stopPropagation();
      // Suppress the click that ends a drag.
      if (icon.dataset.dragged === '1') { icon.dataset.dragged = ''; return; }
      focusNoteEditor(viewer, n, annot);
    });
    icon.addEventListener('mouseenter', () => setLinked(true));
    icon.addEventListener('mouseleave', () => setLinked(false));
    group.appendChild(icon);

    // Large margin card: the note blown up, holding its comment in an inline textarea.
    // The paper is a clipped inner element so the drop shadow on the outer card hugs the dog-ear rather than being clipped off with the corner.
    const card = document.createElement('div');
    card.className = 'scribe-note-card';
    card.dataset.noteIdx = idxStr;
    card.style.top = `${annot.bbox.top}px`;

    const paper = document.createElement('div');
    paper.className = 'scribe-note-card-paper';

    const meta = document.createElement('div');
    meta.className = 'scribe-note-card-meta';
    const syncMeta = () => {
      const parts = [];
      if (annot.author) parts.push(annot.author);
      if (annot.createdAt) parts.push(new Date(annot.createdAt).toLocaleDateString());
      meta.textContent = parts.join(' · ');
      meta.style.display = parts.length ? '' : 'none';
    };

    const text = document.createElement('textarea');
    text.className = 'scribe-note-card-text';
    text.value = annot.comment || '';
    text.placeholder = 'Add a note…';
    text.rows = 1;
    const grow = () => { text.style.height = 'auto'; text.style.height = `${text.scrollHeight}px`; };
    text.addEventListener('input', grow);
    // Keep typing out of page shortcuts and note-drag.
    // Escape ends editing.
    text.addEventListener('pointerdown', (e) => e.stopPropagation());
    text.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') text.blur(); });
    text.addEventListener('blur', () => {
      setNoteComment(viewer, annot, text.value.trim());
      syncMeta();
      if (viewer._rebuildCommentsPanel) viewer._rebuildCommentsPanel();
    });
    paper.appendChild(text);

    syncMeta();
    paper.appendChild(meta);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'scribe-note-card-del';
    del.title = 'Delete note';
    del.textContent = '×';
    del.addEventListener('pointerdown', (e) => e.stopPropagation());
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      removeNote(viewer, annot, n);
      viewer.renderNotes(n);
      if (viewer._rebuildCommentsPanel) viewer._rebuildCommentsPanel();
    });
    paper.appendChild(del);

    card.appendChild(paper);
    paper.addEventListener('click', (e) => { if (e.target !== del) text.focus(); });
    card.addEventListener('mouseenter', () => setLinked(true));
    card.addEventListener('mouseleave', () => setLinked(false));
    group.appendChild(card);
    grow();
  });
}

/**
 * Put the cursor in a note's inline editor (its margin card's textarea), rendering the page's notes first if needed.
 * The single entry point for "edit this note", used by the on-page mark, the note tool, and the Comments panel.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 * @param {Object} annot
 */
export function focusNoteEditor(viewer, n, annot) {
  const idx = pageNotes(viewer, n).indexOf(annot);
  if (idx < 0) return;
  const find = () => {
    const group = viewer.getNotesGroup(n);
    return group ? group.querySelector(`.scribe-note-card[data-note-idx="${idx}"] .scribe-note-card-text`) : null;
  };
  let ta = find();
  if (!ta) { viewer.renderNotes(n); ta = find(); }
  if (ta) ta.focus();
}
