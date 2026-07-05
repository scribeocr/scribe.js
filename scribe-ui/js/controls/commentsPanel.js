// Comments side panel: a flat, navigable list of every comment in the document.
// Each row is either a highlight-anchored comment (shown with a quote of the highlighted text) or a freestanding sticky note.
// A sibling of the bookmarks and thumbnails rails.
// Clicking a row jumps to that comment's page.
import { makeIconButton } from './toolbar.js';
import { annotMatchesWord } from '../viewerHighlights.js';
import { createNote } from '../viewerNotes.js';

// Speech-bubble glyph for the toolbar toggle.
const COMMENT_SVG = '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor"><path d="M3 2h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6.5L4 13.5V11H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/></svg>';
// Plus glyph for the header "new note on this page" button.
const NEW_NOTE_SVG = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
// Small dog-eared sticky glyph marking a freestanding-note row (matches the on-page note icon).
const NOTE_MARK_SVG = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M4 4h16v10l-6 6H4z"/><path d="M20 14l-6 6v-5a1 1 0 0 1 1-1z" fill="rgba(0,0,0,.22)"/></svg>';

const MAX_SNIPPET_WORDS = 16;

/**
 * Create the comments side panel.
 * @param {*} scribe - The ScribeViewer instance.
 * @param {{ onNavigate: (pageIndex: number) => void, onResize?: (width: number, phase: 'start'|'move'|'end') => void }} handlers
 *   `onResize` fires as the right-edge handle is dragged, with the desired width and the drag phase.
 * @returns {{ panelElem: HTMLDivElement, toggleElem: HTMLSpanElement, rebuild: () => void, setActive: (pageIndex: number) => void, setVisible: (v: boolean) => void, destroy: () => void }}
 */
export function createCommentsPanel(scribe, { onNavigate, onResize }) {
  const panelElem = document.createElement('div');
  panelElem.className = 'scribe-comments-panel';
  panelElem.style.width = '240px';
  panelElem.tabIndex = -1;

  // Header: title plus a running count of comments in the document.
  const headerElem = document.createElement('div');
  headerElem.className = 'scribe-cm-hd';
  const headerTitle = document.createElement('span');
  headerTitle.className = 'scribe-cm-hd-title';
  headerTitle.textContent = 'Comments';
  const countElem = document.createElement('span');
  countElem.className = 'scribe-cm-hd-count';
  // "New note on this page": drops a freestanding note in the current viewport and opens its editor.
  // Only useful while editing, so a read-only viewer hides it (set in rebuild()).
  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'scribe-cm-new';
  newBtn.title = 'New note on this page';
  newBtn.innerHTML = NEW_NOTE_SVG;
  newBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!hasDoc() || !scribe.getNotesGroup) return;
    // Place at the centre of the current viewport so the new note lands on-screen.
    // Fall back to the current page.
    let n = -1;
    let x = 40;
    let y = 40;
    if (scribe.scrollContainer && scribe.clientToPage) {
      const r = scribe.scrollContainer.getBoundingClientRect();
      const p = scribe.clientToPage(r.left + r.width / 2, r.top + r.height / 2);
      if (p && p.n != null && p.n >= 0) { n = p.n; x = p.x; y = p.y; }
    }
    if (n < 0) n = (scribe.state && scribe.state.cp) ? scribe.state.cp.n : 0;
    if (n == null || n < 0) return;
    const annot = createNote(scribe, n, x, y);
    if (scribe.renderNotes) scribe.renderNotes(n);
    rebuild();
    // Anchor the editor on the freshly-rendered icon (the note was pushed last -> the layer's last child).
    const group = scribe.getNotesGroup(n);
    const icon = group ? group.lastElementChild : null;
    if (icon && scribe._openNoteEditor) scribe._openNoteEditor(annot, n, icon);
  });
  headerElem.append(headerTitle, countElem, newBtn);
  panelElem.appendChild(headerElem);

  const listElem = document.createElement('div');
  listElem.className = 'scribe-cm-list';
  panelElem.appendChild(listElem);

  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'scribe-cm-resize';
  panelElem.appendChild(resizeHandle);

  // Reused per-row context menu (mounted on the viewer root so the panel's overflow does not clip it).
  const menuElem = document.createElement('div');
  menuElem.className = 'scribe-cm-menu';
  menuElem.style.display = 'none';
  (scribe.outerElem || panelElem).appendChild(menuElem);

  const toggleElem = makeIconButton('Comments', COMMENT_SVG);

  let activePage = -1;
  const editing = () => !!(scribe.opt && scribe.opt.enablePageEditing);
  const hasDoc = () => !!(scribe.doc && scribe.doc.pageMetrics && scribe.doc.pageMetrics.length);
  const annPages = () => (scribe.doc && scribe.doc.annotations && scribe.doc.annotations.pages) || [];

  function closeMenu() { menuElem.style.display = 'none'; menuElem.textContent = ''; }
  /**
   * Show the reused context menu at viewport point (x, y), positioned within the host.
   * @param {number} x
   * @param {number} y
   */
  function showMenuAt(x, y) {
    menuElem.style.display = 'block';
    const host = (scribe.outerElem || panelElem).getBoundingClientRect();
    menuElem.style.left = `${x - host.left}px`;
    menuElem.style.top = `${y - host.top}px`;
  }

  /**
   * Returns a short quote of the words a group's highlight annotations cover on the given page, read from the page's OCR words.
   * @param {number} pageIndex
   * @param {Array<Object>} groupAnns
   * @returns {string}
   */
  function quoteSnippet(pageIndex, groupAnns) {
    const ocrPage = scribe.doc.ocr && scribe.doc.ocr.active && scribe.doc.ocr.active[pageIndex];
    if (!ocrPage || !ocrPage.lines) return '';
    const words = [];
    for (const line of ocrPage.lines) {
      for (const word of line.words) {
        if (!groupAnns.some((a) => annotMatchesWord(a, word.bbox))) continue;
        words.push(word.text);
        if (words.length >= MAX_SNIPPET_WORDS) return `${words.join(' ')}…`;
      }
    }
    return words.join(' ');
  }

  /**
   * Collect one row per commented highlight group and per freestanding note, across all pages.
   * @returns {Array<{pageIndex: number, kind: 'highlight'|'note', comment: string, author: string, createdAt: string, color: string, preview: string, groupId: ?string, annot: Object}>}
   */
  function collectRows() {
    const rows = [];
    const pages = annPages();
    for (let i = 0; i < pages.length; i += 1) {
      const anns = pages[i] || [];
      const seenGroups = new Set();
      for (const a of anns) {
        if (a.type === 'text') {
          rows.push({
            pageIndex: i, kind: 'note', comment: a.comment || '', author: a.author || '', createdAt: a.createdAt || '', color: a.color || '', preview: '', groupId: null, annot: a,
          });
          continue;
        }
        if (a.type && a.type !== 'highlight') continue;
        if (!a.comment) continue;
        // One row per group (a highlight spans many per-word annotations sharing a groupId).
        // Group-less imported highlights key by their bbox so distinct ones do not collapse together.
        const key = a.groupId || `bbox:${a.bbox.left}:${a.bbox.top}:${a.bbox.right}:${a.bbox.bottom}`;
        if (seenGroups.has(key)) continue;
        seenGroups.add(key);
        const groupAnns = a.groupId ? anns.filter((x) => x.groupId === a.groupId) : [a];
        rows.push({
          pageIndex: i,
          kind: 'highlight',
          comment: a.comment,
          author: a.author || '',
          createdAt: a.createdAt || '',
          color: a.color || '',
          preview: quoteSnippet(i, groupAnns),
          groupId: a.groupId || null,
          annot: a,
        });
      }
    }
    return rows;
  }

  /**
   * Refresh the on-page comment icons (highlights) and note layer for `pageIndex` after a panel edit.
   * @param {number} pageIndex
   */
  function refreshOnPage(pageIndex) {
    if (scribe._updateCommentIcons) scribe._updateCommentIcons();
    if (scribe.renderNotes && pageIndex >= 0) scribe.renderNotes(pageIndex);
  }

  /**
   * Write a comment onto a highlight group directly (no UiOcrWords needed, so it works for a page not on screen).
   * Stamps author/date on first authoring and clears them when emptied, matching the on-page editor.
   * @param {Object} row
   * @param {string} comment
   */
  function setHighlightComment(row, comment) {
    const author = (scribe.opt && scribe.opt.commentAuthor) || '';
    const now = new Date().toISOString();
    const match = row.groupId ? ((a) => a.groupId === row.groupId) : ((a) => a === row.annot);
    for (const a of annPages()[row.pageIndex] || []) {
      if (a.type === 'text' || (a.type && a.type !== 'highlight')) continue;
      if (!match(a)) continue;
      a.comment = comment;
      if (comment) {
        if (author && !a.author) a.author = author;
        if (!a.createdAt) a.createdAt = now;
      } else {
        delete a.author;
        delete a.createdAt;
      }
    }
    if (row.groupId) {
      for (const kw of scribe.getUiWords()) if (kw.highlightGroupId === row.groupId) kw.highlightComment = comment;
    }
    refreshOnPage(row.pageIndex);
  }

  /**
   * Remove a highlight group (or a group-less highlight) entirely.
   * @param {Object} row
   */
  function deleteHighlight(row) {
    const match = row.groupId ? ((a) => a.groupId === row.groupId) : ((a) => a === row.annot);
    const page = annPages()[row.pageIndex] || [];
    scribe.doc.annotations.pages[row.pageIndex] = page.filter((a) => !((a.type == null || a.type === 'highlight') && match(a)));
    for (const kw of scribe.getUiWords()) {
      const covered = (row.groupId && kw.highlightGroupId === row.groupId)
        || (!row.groupId && annotMatchesWord(row.annot, kw.word.bbox));
      if (!covered) continue;
      kw.highlightColor = null;
      kw.highlightOpacity = 1;
      kw.highlightGroupId = null;
      kw.highlightComment = '';
    }
    refreshOnPage(row.pageIndex);
  }

  /**
   * Edit a note's comment directly.
   * @param {Object} row
   * @param {string} comment
   */
  function setNoteComment(row, comment) {
    const author = (scribe.opt && scribe.opt.commentAuthor) || '';
    row.annot.comment = comment;
    if (comment) {
      if (author && !row.annot.author) row.annot.author = author;
      if (!row.annot.createdAt) row.annot.createdAt = new Date().toISOString();
    }
    refreshOnPage(row.pageIndex);
  }

  /**
   * Remove a freestanding note entirely.
   * @param {Object} row
   */
  function deleteNote(row) {
    const page = annPages()[row.pageIndex] || [];
    scribe.doc.annotations.pages[row.pageIndex] = page.filter((a) => a !== row.annot);
    refreshOnPage(row.pageIndex);
  }

  /**
   * Inline-edit a row's comment: swap the text element for a textarea, committing on Enter/blur (Esc cancels).
   * @param {Object} row
   * @param {HTMLElement} textElem
   */
  function startEdit(row, textElem) {
    const ta = document.createElement('textarea');
    ta.className = 'scribe-cm-edit';
    ta.value = row.comment;
    ta.rows = 2;
    textElem.replaceWith(ta);
    ta.focus();
    ta.select();
    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      const next = ta.value.trim();
      if (save && next !== row.comment) {
        if (row.kind === 'note') setNoteComment(row, next); else setHighlightComment(row, next);
        rebuild();
      } else rebuild();
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(true); } else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
      e.stopPropagation();
    });
    ta.addEventListener('blur', () => commit(true));
  }

  /**
   * Open the per-row edit menu at the pointer.
   * @param {Object} row
   * @param {number} x
   * @param {number} y
   * @param {HTMLElement} textElem
   */
  function openRowMenu(row, x, y, textElem) {
    menuElem.textContent = '';
    const add = (label, fn) => {
      const item = document.createElement('div');
      item.className = 'scribe-cm-menu-item';
      item.textContent = label;
      item.addEventListener('click', () => { closeMenu(); fn(); });
      menuElem.appendChild(item);
    };
    add('Edit', () => startEdit(row, textElem));
    if (row.kind === 'note') {
      add('Delete note', () => { deleteNote(row); rebuild(); });
    } else {
      add('Delete comment', () => { setHighlightComment(row, ''); rebuild(); });
      add('Delete highlight', () => { deleteHighlight(row); rebuild(); });
    }
    showMenuAt(x, y);
  }

  /**
   * Render one comment row.
   * @param {Object} row
   * @returns {HTMLDivElement}
   */
  function renderRow(row) {
    const el = document.createElement('div');
    el.className = 'scribe-cm-row';
    el.dataset.page = String(row.pageIndex);
    if (row.pageIndex === activePage) el.classList.add('active');

    // Kind marker: a color swatch for a highlight comment, the note glyph for a freestanding note.
    const marker = document.createElement('span');
    marker.className = 'scribe-cm-marker';
    if (row.kind === 'note') {
      marker.innerHTML = NOTE_MARK_SVG;
    } else {
      marker.classList.add('scribe-cm-swatch');
      if (row.color) marker.style.background = row.color;
    }
    el.appendChild(marker);

    const body = document.createElement('div');
    body.className = 'scribe-cm-body';

    if (row.preview) {
      const quote = document.createElement('div');
      quote.className = 'scribe-cm-quote';
      quote.textContent = row.preview;
      body.appendChild(quote);
    }

    const text = document.createElement('div');
    text.className = 'scribe-cm-text';
    text.textContent = row.comment;
    body.appendChild(text);

    const meta = document.createElement('div');
    meta.className = 'scribe-cm-meta';
    const bits = document.createElement('span');
    const parts = [];
    if (row.author) parts.push(row.author);
    if (row.createdAt) parts.push(new Date(row.createdAt).toLocaleDateString());
    bits.textContent = parts.join(' · ');
    const pageBadge = document.createElement('span');
    pageBadge.className = 'scribe-cm-page';
    pageBadge.textContent = `p. ${row.pageIndex + 1}`;
    meta.append(bits, pageBadge);
    body.appendChild(meta);
    el.appendChild(body);

    el.addEventListener('click', () => onNavigate(row.pageIndex));
    if (editing()) {
      text.addEventListener('dblclick', (e) => { e.stopPropagation(); startEdit(row, text); });
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); openRowMenu(row, e.clientX, e.clientY, text); });
    }
    return el;
  }

  function rebuild() {
    closeMenu();
    // Only offer note creation in an editable viewer.
    newBtn.style.display = editing() ? '' : 'none';
    listElem.textContent = '';
    if (!hasDoc()) { countElem.textContent = ''; return; }
    const rows = collectRows();
    rows.sort((a, b) => a.pageIndex - b.pageIndex);
    countElem.textContent = rows.length ? String(rows.length) : '';
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'scribe-cm-empty';
      empty.textContent = editing() ? 'No comments yet.' : 'No comments.';
      listElem.appendChild(empty);
      return;
    }
    for (const row of rows) listElem.appendChild(renderRow(row));
  }

  (scribe.outerElem || document).addEventListener('click', (e) => { if (!menuElem.contains(e.target)) closeMenu(); });

  // Right-edge resize reports the desired width plus a drag phase to the host, which owns the shared clamp so this panel and the rail stay one width (mirrors the bookmarks panel).
  let resizeStartX = 0;
  let resizeStartW = 0;
  function onResizeMove(e) { if (onResize) onResize(resizeStartW + (e.clientX - resizeStartX), 'move'); }
  function onResizeEnd(e) {
    window.removeEventListener('pointermove', onResizeMove);
    window.removeEventListener('pointerup', onResizeEnd);
    if (onResize) onResize(resizeStartW + (e.clientX - resizeStartX), 'end');
  }
  resizeHandle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    resizeStartX = e.clientX;
    resizeStartW = parseFloat(panelElem.style.width) || panelElem.getBoundingClientRect().width;
    if (onResize) onResize(resizeStartW, 'start');
    window.addEventListener('pointermove', onResizeMove);
    window.addEventListener('pointerup', onResizeEnd);
  });

  /**
   * Cheap re-highlight of the rows on the current page, without a full rebuild.
   * @param {number} pageIndex
   */
  function setActive(pageIndex) {
    activePage = pageIndex;
    for (const el of listElem.querySelectorAll('.scribe-cm-row')) {
      el.classList.toggle('active', Number(el.dataset.page) === activePage);
    }
  }

  function setVisible(v) { panelElem.style.display = v ? '' : 'none'; if (v) rebuild(); }
  function destroy() { closeMenu(); menuElem.remove(); panelElem.remove(); }

  panelElem.style.display = 'none';
  return {
    panelElem, toggleElem, rebuild, setActive, setVisible, destroy,
  };
}
