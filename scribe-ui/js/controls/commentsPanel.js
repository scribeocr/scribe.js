// Comments side panel: every comment in the document as a card, grouped under sticky per-page headers.
// A card is either a highlight-anchored comment (quoting the highlighted text behind a bar of the highlight's color) or a freestanding note.
// A sibling of the bookmarks and thumbnails rails.
import { makeIconButton } from './toolbar.js';
import { annotMatchesWord } from '../viewerHighlights.js';
import { createNote } from '../viewerNotes.js';

// Speech-bubble glyph for the toolbar toggle.
const COMMENT_SVG = '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor"><path d="M3 2h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6.5L4 13.5V11H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/></svg>';
// Plus glyph for the header "new note on this page" button (also the row's ghost "Add a comment" affordance).
const NEW_NOTE_SVG = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
// Small dog-eared note glyph marking a freestanding-note row (matches the on-page note icon).
const NOTE_MARK_SVG = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M4 4h16v10l-6 6H4z"/><path d="M20 14l-6 6v-5a1 1 0 0 1 1-1z" fill="rgba(0,0,0,.22)"/></svg>';
// Row hover verbs, drawn on the same 24-grid / 1.6px / round-cap family as the on-page card's icons.
const PENCIL_SVG = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M13.7 6.3l4 4M5 19l.9-3.9L15.9 5.1a1.9 1.9 0 0 1 2.7 0l.3.3a1.9 1.9 0 0 1 0 2.7L8.9 18.1 5 19z"/></svg>';
const TRASH_SVG = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M4 6.5h16M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5M6 6.5l.9 11.2a2 2 0 0 0 2 1.8h6.2a2 2 0 0 0 2-1.8L18 6.5"/></svg>';
// Outline speech bubble for the empty state (the filled COMMENT_SVG stays the toolbar toggle).
const EMPTY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'
  + '<rect x="3" y="4" width="18" height="12.5" rx="2.5"/><path d="M8.5 16.5v3.2l4-3.2"/></svg>';

// A quote up to MAX + SLACK tall shows in full; taller, it caps at MAX and scrolls inside.
// The SLACK band keeps a quote only just over MAX from scrolling to reveal a mere sliver.
const QUOTE_SCROLL_MAX_PX = 160;
const QUOTE_SCROLL_SLACK_PX = 64;

/**
 * One panel row: a highlight group (quoting the text it covers) or a freestanding note.
 * `top`/`left` are the anchor's page-space position, ordering rows within a page group.
 * @typedef {{pageIndex: number, kind: 'highlight'|'note', comment: string, author: string, createdAt: string,
 *   color: string, preview: string, groupId: ?string, annot: AnnotationHighlight | AnnotationText,
 *   top: number, left: number}} CommentRow
 */

/**
 * Create the comments side panel.
 * @param {*} scribe - The ScribeViewer instance.
 * @param {{ onNavigate: (pageIndex: number) => void, onResize?: (width: number, phase: 'start'|'move'|'end') => void }} handlers
 *   `onResize` fires as the right-edge handle is dragged, with the desired width and the drag phase.
 * @returns {{ panelElem: HTMLDivElement, toggleElem: HTMLSpanElement, rebuild: () => void, setActive: (pageIndex: number) => void,
 * setVisible: (v: boolean) => void, reveal: (uiWord: import('../viewerWordObjects.js').UiOcrWord) => void, destroy: () => void }}
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
  let visible = false;
  // The comment rows from the last rebuild, their row elements, and the row indices selected for a bulk action.
  /** @type {CommentRow[]} */
  let rows = [];
  /** @type {HTMLElement[]} */
  const rowEls = [];
  const selected = new Set();
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
   * Returns the full text the group's highlight annotations cover on the given page, read from the page's OCR words.
   * The row shows it clamped to two lines; double-clicking the quote expands it in place.
   * @param {number} pageIndex
   * @param {Array<Object>} groupAnns
   * @returns {string}
   */
  function quoteText(pageIndex, groupAnns) {
    const ocrPage = scribe.doc.ocr && scribe.doc.ocr.active && scribe.doc.ocr.active[pageIndex];
    if (!ocrPage || !ocrPage.lines) return '';
    const words = [];
    for (const line of ocrPage.lines) {
      for (const word of line.words) {
        if (!groupAnns.some((a) => annotMatchesWord(a, word.bbox))) continue;
        words.push(word.text);
      }
    }
    return words.join(' ');
  }

  /**
   * Collect one row per highlight group and per freestanding note, across all pages.
   * @returns {CommentRow[]}
   */
  function collectRows() {
    /** @type {CommentRow[]} */
    const out = [];
    const pages = annPages();
    for (let i = 0; i < pages.length; i += 1) {
      const anns = pages[i] || [];
      const seenGroups = new Set();
      for (const a of anns) {
        if (a.type === 'text') {
          out.push({
            pageIndex: i,
            kind: 'note',
            comment: a.comment || '',
            author: a.author || '',
            createdAt: a.createdAt || '',
            color: a.color || '',
            preview: '',
            groupId: null,
            annot: a,
            top: a.bbox ? a.bbox.top : 0,
            left: a.bbox ? a.bbox.left : 0,
          });
          continue;
        }
        if (a.type && a.type !== 'highlight') continue;
        // A highlight is listed whether or not it carries a comment, and its highlighted text is the row's quote.
        // One row per group (a highlight spans many per-word annotations sharing a groupId).
        // Group-less imported highlights key by their bbox so distinct ones do not collapse together.
        const key = a.groupId || `bbox:${a.bbox.left}:${a.bbox.top}:${a.bbox.right}:${a.bbox.bottom}`;
        if (seenGroups.has(key)) continue;
        seenGroups.add(key);
        const groupAnns = a.groupId ? anns.filter((x) => x.groupId === a.groupId) : [a];
        // The group's topmost-leftmost box anchors the row's position, whatever order the words were swept in.
        let top = Infinity;
        let left = Infinity;
        for (const g of groupAnns) {
          if (!g.bbox) continue;
          if (g.bbox.top < top) top = g.bbox.top;
          if (g.bbox.left < left) left = g.bbox.left;
        }
        out.push({
          pageIndex: i,
          kind: 'highlight',
          comment: a.comment || '',
          author: a.author || '',
          createdAt: a.createdAt || '',
          color: a.color || '',
          preview: quoteText(i, groupAnns),
          groupId: a.groupId || null,
          annot: a,
          top: top === Infinity ? 0 : top,
          left: left === Infinity ? 0 : left,
        });
      }
    }
    return out;
  }

  /**
   * Refresh the on-page comment icons (highlights) and note layer for `pageIndex` after a panel edit.
   * @param {number} pageIndex
   */
  function refreshOnPage(pageIndex) {
    if (scribe._updateCommentIcons) scribe._updateCommentIcons();
    if (scribe.renderNotes && pageIndex >= 0) scribe.renderNotes(pageIndex);
    if (scribe.renderHighlights && pageIndex >= 0) scribe.renderHighlights(pageIndex);
  }

  /**
   * Write a comment onto a highlight group directly (no UiOcrWords needed, so it works for a page not on screen).
   * Stamps author/date on first authoring and clears them when emptied, matching the on-page editor.
   * @param {CommentRow} row
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
   * @param {CommentRow} row
   */
  function deleteHighlight(row) {
    const match = row.groupId ? ((a) => a.groupId === row.groupId) : ((a) => a === row.annot);
    const page = annPages()[row.pageIndex] || [];
    scribe.doc.annotations.pages[row.pageIndex] = page.filter((a) => !((a.type == null || a.type === 'highlight') && match(a)));
    for (const kw of scribe.getUiWords()) {
      const covered = (row.groupId && kw.highlightGroupId === row.groupId)
        || (!row.groupId && annotMatchesWord(/** @type {AnnotationHighlight} */ (row.annot), kw.word.bbox));
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
   * @param {CommentRow} row
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
   * @param {CommentRow} row
   */
  function deleteNote(row) {
    const page = annPages()[row.pageIndex] || [];
    scribe.doc.annotations.pages[row.pageIndex] = page.filter((a) => a !== row.annot);
    refreshOnPage(row.pageIndex);
  }

  // The single open in-place editor.
  // No Save button: dismissing it commits, only Esc discards.
  /** @type {?{row: CommentRow, rowEl: HTMLElement, ta: HTMLTextAreaElement, foldElem: HTMLDivElement, onDown: (e: PointerEvent) => void}} */
  let editState = null;

  /** Remove the document-level click-out listener of the open editor, if any. */
  function detachEditorListener() {
    if (editState) document.removeEventListener('pointerdown', editState.onDown, true);
  }

  /**
   * Close the in-place editor, committing the field's text when `save` is set.
   * @param {boolean} save
   */
  function foldEditor(save) {
    if (!editState) return;
    const {
      row, rowEl, ta, foldElem,
    } = editState;
    detachEditorListener();
    const next = ta.value.trim();
    editState = null;
    ta.remove();
    foldElem.remove();
    rowEl.classList.remove('editing');
    for (const sel of ['.scribe-cm-text', '.scribe-cm-ghost']) {
      const hidden = /** @type {?HTMLElement} */ (rowEl.querySelector(sel));
      if (hidden) hidden.style.display = '';
    }
    if (save && next !== row.comment) {
      // Setters stamp/clear author + date on the annotation; re-read the row's cached fields to match.
      if (row.kind === 'note') setNoteComment(row, next); else setHighlightComment(row, next);
      row.comment = row.annot.comment || '';
      row.author = row.annot.author || '';
      row.createdAt = row.annot.createdAt || '';
      // Swap only this row's element, never a full rebuild, so the click that triggered the fold keeps its target alive.
      const i = rows.indexOf(row);
      if (i >= 0 && rowEls[i]) {
        const fresh = renderRow(row, i);
        rowEls[i].replaceWith(fresh);
        rowEls[i] = fresh;
      } else rebuild();
    }
  }

  /**
   * Morph a row into the comment editor.
   * @param {CommentRow} row
   * @param {HTMLElement} rowEl
   */
  function startEdit(row, rowEl) {
    if (!editing()) return;
    if (editState) {
      if (editState.row === row) return;
      // Opening a second editor commits the first, as any click outside it does.
      foldEditor(true);
    }
    for (const sel of ['.scribe-cm-text', '.scribe-cm-ghost']) {
      const shown = /** @type {?HTMLElement} */ (rowEl.querySelector(sel));
      if (shown) shown.style.display = 'none';
    }
    const ta = document.createElement('textarea');
    ta.className = 'scribe-cm-field';
    ta.value = row.comment;
    ta.placeholder = 'Comment…';
    const autoGrow = () => {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(190, Math.max(40, ta.scrollHeight))}px`;
    };
    ta.addEventListener('input', autoGrow);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); foldEditor(false); } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); foldEditor(true); }
      e.stopPropagation();
    });
    const foldElem = document.createElement('div');
    foldElem.className = 'scribe-cm-fold';
    const foldInner = document.createElement('div');
    const foot = document.createElement('div');
    foot.className = 'scribe-cm-foot';
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'scribe-cm-remove';
    removeBtn.textContent = 'Remove comment';
    removeBtn.addEventListener('click', (e) => { e.stopPropagation(); ta.value = ''; foldEditor(true); });
    foot.append(removeBtn);
    foldInner.appendChild(foot);
    foldElem.appendChild(foldInner);
    // Clicks inside the editor must not bubble into the row's navigate handler.
    ta.addEventListener('click', (e) => e.stopPropagation());
    foldElem.addEventListener('click', (e) => e.stopPropagation());
    rowEl.append(ta, foldElem);
    // Click-out saves (capture phase, so it runs before whatever the click itself does).
    /** @param {PointerEvent} e */
    const onDown = (e) => {
      if (!rowEl.contains(/** @type {Node} */ (e.target))) foldEditor(true);
    };
    document.addEventListener('pointerdown', onDown, true);
    editState = {
      row, rowEl, ta, foldElem, onDown,
    };
    rowEl.getBoundingClientRect(); // commit the collapsed footer so adding the class animates the 0fr -> 1fr slide
    rowEl.classList.add('editing');
    autoGrow();
    ta.focus();
    ta.select();
  }

  /**
   * Open the per-row edit menu at the pointer.
   * @param {CommentRow} row
   * @param {number} x
   * @param {number} y
   * @param {HTMLElement} rowEl
   */
  function openRowMenu(row, x, y, rowEl) {
    menuElem.textContent = '';
    const add = (label, fn) => {
      const item = document.createElement('div');
      item.className = 'scribe-cm-menu-item';
      item.textContent = label;
      item.addEventListener('click', () => { closeMenu(); fn(); });
      menuElem.appendChild(item);
    };
    add('Edit', () => startEdit(row, rowEl));
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
   * @param {CommentRow} row
   * @param {number} i - The row's index in the current list, keying its bulk selection.
   * @returns {HTMLDivElement}
   */
  function renderRow(row, i) {
    const el = document.createElement('div');
    el.className = 'scribe-cm-row';
    el.dataset.page = String(row.pageIndex);

    // Right slot of the lead line: the date and the editor-only hover verbs share one grid cell, so revealing the verbs never reflows the lead line.
    const rightElem = document.createElement('div');
    rightElem.className = 'scribe-cm-right';
    if (editing()) {
      const verbs = document.createElement('div');
      verbs.className = 'scribe-cm-verbs';
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'scribe-cm-verb';
      editBtn.title = row.comment ? 'Edit comment' : 'Add comment';
      editBtn.innerHTML = PENCIL_SVG;
      editBtn.addEventListener('click', (e) => { e.stopPropagation(); startEdit(row, el); });
      // The trash verb deletes the whole anchor (highlight or note), not just the comment; comment-only removal is the editor's "Remove comment".
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'scribe-cm-verb scribe-cm-verb-del';
      delBtn.title = row.kind === 'note' ? 'Delete note' : 'Delete highlight';
      delBtn.innerHTML = TRASH_SVG;
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (row.kind === 'note') deleteNote(row); else deleteHighlight(row);
        rebuild();
      });
      verbs.append(editBtn, delBtn);
      rightElem.appendChild(verbs);
    }

    // The anchor line names what the comment hangs on: the quoted highlight behind a bar of its color, or the note mark.
    const anchor = document.createElement('div');
    anchor.className = 'scribe-cm-anchor';
    const bar = document.createElement('span');
    bar.className = 'scribe-cm-bar';
    // Raw highlight color, not a tinted shade, matching the coin picker's swatches.
    if (row.kind === 'note') bar.style.background = 'var(--scribe-note)';
    else if (row.color) bar.style.background = row.color;
    anchor.appendChild(bar);
    if (row.kind === 'note') {
      const kind = document.createElement('span');
      kind.className = 'scribe-cm-kind';
      kind.innerHTML = `${NOTE_MARK_SVG}<span>Note</span>`;
      anchor.appendChild(kind);
    } else {
      const quote = document.createElement('span');
      quote.className = 'scribe-cm-quote';
      quote.textContent = row.preview;
      // stopPropagation so expanding the quote does not also fire the row's edit-on-dblclick shortcut.
      quote.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const expanding = !quote.classList.contains('expanded');
        quote.classList.toggle('expanded', expanding);
        quote.classList.remove('scroll');
        quote.style.maxHeight = '';
        if (expanding && quote.scrollHeight > QUOTE_SCROLL_MAX_PX + QUOTE_SCROLL_SLACK_PX) {
          quote.classList.add('scroll');
          quote.style.maxHeight = `${QUOTE_SCROLL_MAX_PX}px`;
        }
      });
      anchor.appendChild(quote);
    }

    // Authored rows lead with an identity header; unauthored rows lead with the anchor line, which carries the verbs instead.
    if (row.author) {
      const top = document.createElement('div');
      top.className = 'scribe-cm-top';
      const meta = document.createElement('div');
      meta.className = 'scribe-cm-meta';
      const ava = document.createElement('span');
      ava.className = 'scribe-cm-ava';
      ava.textContent = row.author.split(/\s+/, 2).map((s) => s[0]).join('').toUpperCase();
      const who = document.createElement('span');
      who.className = 'scribe-cm-who';
      who.textContent = row.author;
      meta.append(ava, who);
      if (row.createdAt) {
        const d = new Date(row.createdAt);
        /** @type {Intl.DateTimeFormatOptions} */
        const dateOpts = { month: 'short', day: 'numeric' };
        if (d.getFullYear() !== new Date().getFullYear()) dateOpts.year = 'numeric';
        const when = document.createElement('span');
        when.className = 'scribe-cm-when';
        when.textContent = `· ${d.toLocaleDateString(undefined, dateOpts)}`;
        rightElem.prepend(when);
        if (rightElem.childElementCount > 1) rightElem.classList.add('scribe-cm-right-swap');
      }
      top.appendChild(meta);
      if (rightElem.childElementCount) top.appendChild(rightElem);
      el.append(top, anchor);
    } else {
      if (rightElem.childElementCount) anchor.appendChild(rightElem);
      el.appendChild(anchor);
    }

    if (row.comment) {
      const text = document.createElement('div');
      text.className = 'scribe-cm-text';
      text.textContent = row.comment;
      el.appendChild(text);
    } else if (editing()) {
      // The visible way in for a comment-less row (the old blank row was double-click-only).
      const ghost = document.createElement('button');
      ghost.type = 'button';
      ghost.className = 'scribe-cm-ghost';
      ghost.innerHTML = `${NEW_NOTE_SVG}<span>Add a comment…</span>`;
      ghost.addEventListener('click', (e) => { e.stopPropagation(); startEdit(row, el); });
      el.appendChild(ghost);
    }

    el.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) { toggleSelect(i); return; }
      clearSelection();
      onNavigate(row.pageIndex);
    });

    if (editing()) {
      el.addEventListener('dblclick', (e) => { e.stopPropagation(); startEdit(row, el); });
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); openRowMenu(row, e.clientX, e.clientY, el); });
    }

    if (row.kind === 'highlight') {
      // Row->highlight half of the two-way hover sync: hovering the row lifts the highlight's fill bands in the viewer (when its page is rendered).
      // A group-less imported highlight has no group id, so its band is found through a covered word instead.
      /** @type {Array<HTMLElement>} */
      let litBands = [];
      el.addEventListener('mouseenter', () => {
        litBands = [];
        if (row.groupId) {
          for (const map of scribe._highlightRectsByGroup || []) {
            const arr = map && map.get(row.groupId);
            if (arr) litBands.push(...arr);
          }
        } else {
          const covered = scribe.getUiWords().find((kw) => kw.word.line.page.n === row.pageIndex
            && kw.highlightRectElem && annotMatchesWord(/** @type {AnnotationHighlight} */ (row.annot), kw.word.bbox));
          if (covered && covered.highlightRectElem) litBands.push(covered.highlightRectElem);
        }
        for (const band of litBands) band.classList.add('scribe-hl-hover');
      });
      el.addEventListener('mouseleave', () => {
        for (const band of litBands) band.classList.remove('scribe-hl-hover');
        litBands = [];
      });
    }
    return el;
  }

  function rebuild() {
    closeMenu();
    detachEditorListener();
    editState = null; // any open editor's nodes go with the list
    // Only offer note creation in an editable viewer.
    newBtn.style.display = editing() ? '' : 'none';
    listElem.textContent = '';
    rowEls.length = 0;
    selected.clear();
    rows = [];
    if (!hasDoc()) { countElem.textContent = ''; return; }
    rows = collectRows();
    // Sort by page then position, never creation order, so a highlight added atop a page never lists below an older one lower down.
    rows.sort((a, b) => a.pageIndex - b.pageIndex || a.top - b.top || a.left - b.left);
    countElem.textContent = rows.length ? String(rows.length) : '';
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'scribe-cm-empty';
      empty.innerHTML = EMPTY_SVG;
      const title = document.createElement('div');
      title.className = 'scribe-cm-empty-t';
      title.textContent = editing() ? 'No comments yet' : 'No comments';
      empty.appendChild(title);
      if (editing()) {
        const how = document.createElement('div');
        how.className = 'scribe-cm-empty-h';
        how.textContent = 'Highlight text in the document, or add a note with +.';
        empty.appendChild(how);
      }
      listElem.appendChild(empty);
      return;
    }
    let lastPage = -1;
    rows.forEach((row, i) => {
      if (row.pageIndex !== lastPage) {
        lastPage = row.pageIndex;
        const grp = document.createElement('div');
        grp.className = 'scribe-cm-grp';
        grp.dataset.page = String(row.pageIndex);
        if (row.pageIndex === activePage) grp.classList.add('active');
        const label = document.createElement('span');
        label.textContent = `Page ${row.pageIndex + 1}`;
        grp.appendChild(label);
        listElem.appendChild(grp);
      }
      const el = renderRow(row, i);
      rowEls[i] = el;
      listElem.appendChild(el);
    });
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

  /** Reflect `selected` on the rendered rows. */
  function applySelection() {
    rowEls.forEach((el, i) => { if (el) el.classList.toggle('selected', selected.has(i)); });
  }

  /** Select every comment (Ctrl/Cmd+A). */
  function selectAll() {
    selected.clear();
    for (let i = 0; i < rows.length; i += 1) selected.add(i);
    applySelection();
  }

  /** Clear the bulk selection. */
  function clearSelection() {
    if (selected.size === 0) return;
    selected.clear();
    applySelection();
  }

  /**
   * Add or remove one row from the bulk selection (Ctrl/Cmd-click).
   * @param {number} i
   */
  function toggleSelect(i) {
    if (selected.has(i)) selected.delete(i); else selected.add(i);
    applySelection();
  }

  /**
   * Remove the comment entry for every selected row (editor only):
   * a note is deleted outright, a highlight keeps its mark but loses its comment, so either way the row leaves the list.
   */
  function deleteSelected() {
    if (!editing() || selected.size === 0) return;
    const targets = [...selected].map((i) => rows[i]).filter(Boolean);
    for (const row of targets) {
      if (row.kind === 'note') deleteNote(row); else setHighlightComment(row, '');
    }
    selected.clear();
    rebuild();
  }

  /**
   * Sidebar shortcuts while the comments panel is the open sidebar:
   * Ctrl/Cmd+A selects every comment, Delete/Backspace removes the selection (editor only), Escape clears it.
   * @param {KeyboardEvent} e
   */
  function onKeyDown(e) {
    if (!visible || (scribe.opt && scribe.opt.keyboardScope === 'off')) return;
    const t = /** @type {?HTMLElement} */ (e.target);
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selectAll();
      return;
    }
    if (e.key === 'Escape') {
      // The field handles Esc while focused; this catches it after focus leaves the editor.
      if (editState) { foldEditor(false); return; }
      clearSelection();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selected.size > 0) {
      e.preventDefault();
      deleteSelected();
    }
  }
  document.addEventListener('keydown', onKeyDown);

  /**
   * Cheap re-accent of the current page's group header, without a full rebuild.
   * @param {number} pageIndex
   */
  function setActive(pageIndex) {
    activePage = pageIndex;
    for (const grp of listElem.querySelectorAll('.scribe-cm-grp')) {
      grp.classList.toggle('active', Number(/** @type {HTMLElement} */ (grp).dataset.page) === activePage);
    }
  }

  function setVisible(v) {
    visible = v;
    panelElem.style.display = v ? '' : 'none';
    if (v) rebuild();
    else { foldEditor(false); clearSelection(); }
  }

  /**
   * Highlight->row half of the two-way hover sync: the viewer reports the hovered group and its row lights up.
   * @param {?string} groupId
   */
  const onHighlightHover = (groupId) => {
    rowEls.forEach((el, i) => {
      if (el) el.classList.toggle('lit', !!groupId && !!rows[i] && rows[i].groupId === groupId);
    });
  };
  scribe.onHighlightHover = onHighlightHover;

  /**
   * Scroll the panel row for a highlight into view and pulse it lit.
   * This is the highlight card's "show in comments panel" verb.
   * Rebuilds first so a comment saved moments ago is listed.
   * @param {import('../viewerWordObjects.js').UiOcrWord} uiWord Any word of the target highlight.
   */
  function reveal(uiWord) {
    rebuild();
    const i = rows.findIndex((row) => row.kind === 'highlight'
      && (uiWord.highlightGroupId ? row.groupId === uiWord.highlightGroupId
        : (row.pageIndex === uiWord.word.line.page.n
          && annotMatchesWord(/** @type {AnnotationHighlight} */ (row.annot), uiWord.word.bbox))));
    const el = i >= 0 ? rowEls[i] : null;
    if (!el) return;
    el.scrollIntoView({ block: 'nearest' });
    el.classList.add('lit');
    setTimeout(() => el.classList.remove('lit'), 1600);
  }

  function destroy() {
    closeMenu();
    foldEditor(false); // drops the editor's document-level click-out listener
    menuElem.remove();
    panelElem.remove();
    document.removeEventListener('keydown', onKeyDown);
    if (scribe.onHighlightHover === onHighlightHover) scribe.onHighlightHover = null;
  }

  panelElem.style.display = 'none';
  return {
    panelElem, toggleElem, rebuild, setActive, setVisible, reveal, destroy,
  };
}
