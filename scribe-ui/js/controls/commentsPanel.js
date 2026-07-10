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
 *   replies: AnnotationReply[], color: string, preview: string, groupId: ?string,
 *   annot: AnnotationHighlight | AnnotationText, top: number, left: number}} CommentRow
 */

/**
 * Create the comments side panel.
 * @param {*} scribe - The ScribeViewer instance.
 * @param {{ onNavigate: (pageIndex: number) => void, onResize?: (width: number, phase: 'start'|'move'|'end') => void }} handlers
 *   `onResize` fires as the right-edge handle is dragged, with the desired width and the drag phase.
 * @returns {{ panelElem: HTMLDivElement, toggleElem: HTMLSpanElement, rebuild: () => void, setActive: (pageIndex: number) => void,
 * setVisible: (v: boolean) => void, reveal: (target: import('../viewerWordObjects.js').UiOcrWord | AnnotationText) => void, destroy: () => void }}
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
            replies: a.replies || [],
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
          replies: a.replies || [],
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
   * Refresh the on-page comment marks (highlights) and note layer for `pageIndex` after a panel edit.
   * @param {number} pageIndex
   */
  function refreshOnPage(pageIndex) {
    if (scribe._updateCommentIcons) scribe._updateCommentIcons();
    if (scribe.renderNotes && pageIndex >= 0) scribe.renderNotes(pageIndex);
    if (scribe.renderHighlights && pageIndex >= 0) scribe.renderHighlights(pageIndex);
  }

  /**
   * Write a comment onto a highlight group located by id rather than by UiOcrWord, so it works for a page not on screen.
   * Author and date are stamped on the first non-empty comment; clearing the comment removes them and any reply thread.
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
        delete a.replies;
      }
    }
    if (row.groupId) {
      for (const kw of scribe.getUiWords()) if (kw.highlightGroupId === row.groupId) kw.highlightComment = comment;
    }
    refreshOnPage(row.pageIndex);
  }

  /**
   * Write a reply thread onto a row's annotation(s), located by id rather than by UiOcrWord, so it works for a page not on screen.
   * An empty list removes the thread.
   * @param {CommentRow} row
   * @param {AnnotationReply[]} replies
   */
  function setRowReplies(row, replies) {
    if (row.kind === 'note') {
      if (replies.length > 0) row.annot.replies = replies;
      else delete row.annot.replies;
    } else {
      const match = row.groupId ? ((a) => a.groupId === row.groupId) : ((a) => a === row.annot);
      for (const a of annPages()[row.pageIndex] || []) {
        if (a.type === 'text' || (a.type && a.type !== 'highlight')) continue;
        if (!match(a)) continue;
        // Consumers read the thread off whichever annotation of the group they match first, so every member carries it.
        if (replies.length > 0) a.replies = replies;
        else delete a.replies;
      }
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

  /**
   * The open in-place editor, which has no Save button: clicking outside the row commits the field and Esc discards it.
   * @type {?{row: CommentRow, rowEl: HTMLElement, ta: HTMLTextAreaElement, anchorEl: HTMLElement,
   *   wrap: ?HTMLDivElement, foldElem: ?HTMLDivElement, target: 'root'|'new'|number, onDown: (e: PointerEvent) => void}} */
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
      row, rowEl, ta, anchorEl, wrap, foldElem, target,
    } = editState;
    detachEditorListener();
    const next = ta.value.trim();
    editState = null;
    // The teardown below changes the row's height, so measure first.
    const fromHeight = rowEl.getBoundingClientRect().height;
    ta.remove();
    if (wrap) wrap.remove();
    if (foldElem) foldElem.remove();
    rowEl.classList.remove('editing');
    anchorEl.style.display = '';

    // Dismissal commits the field, so an emptied root would otherwise destroy the thread by accident.
    const reverts = target === 'root' && !next && row.replies.length > 0;
    let changed = false;
    if (save && !reverts) {
      if (target === 'root') {
        if (next !== row.comment) {
          // Setters stamp/clear author + date on the annotation; re-read the row's cached fields to match.
          if (row.kind === 'note') setNoteComment(row, next); else setHighlightComment(row, next);
          row.comment = row.annot.comment || '';
          row.author = row.annot.author || '';
          row.createdAt = row.annot.createdAt || '';
          changed = true;
        }
      } else if (target === 'new') {
        if (next) {
          /** @type {AnnotationReply} */
          const reply = { text: next, createdAt: new Date().toISOString() };
          const author = (scribe.opt && scribe.opt.commentAuthor) || '';
          if (author) reply.author = author;
          setRowReplies(row, [...row.replies, reply]);
          changed = true;
        }
      } else if (next !== row.replies[target].text) {
        // An emptied reply is removed: unlike the root, nothing hangs below it.
        const replies = row.replies.slice();
        if (next) replies[target] = { ...replies[target], text: next };
        else replies.splice(target, 1);
        setRowReplies(row, replies);
        changed = true;
      }
    }

    /** @type {HTMLElement} */
    let settled = rowEl;
    if (changed) {
      row.replies = row.annot.replies || [];
      // Swap only this row's element, never a full rebuild, so the click that triggered the fold keeps its target alive.
      const i = rows.indexOf(row);
      // A full rebuild drops the element mid-flight, leaving nothing to animate.
      if (i < 0 || !rowEls[i]) { rebuild(); return; }
      const fresh = renderRow(row, i);
      rowEls[i].replaceWith(fresh);
      rowEls[i] = fresh;
      settled = fresh;
    }

    const toHeight = settled.getBoundingClientRect().height;
    if (toHeight === fromHeight) return;
    // A long comment outgrows the row while it shrinks.
    settled.style.overflow = 'hidden';
    // `auto` does not interpolate, so both keyframes use the measured heights.
    // 180ms matches the `.scribe-cm-fold` transition the footer opened on.
    const anim = settled.animate(
      [{ height: `${fromHeight}px` }, { height: `${toHeight}px` }],
      { duration: 180, easing: 'ease' },
    );
    const restore = () => { settled.style.overflow = ''; };
    anim.addEventListener('finish', restore);
    anim.addEventListener('cancel', restore);
  }

  /**
   * Morph one message of a row into the in-place editor.
   * @param {CommentRow} row
   * @param {HTMLElement} rowEl
   * @param {'root'|'new'|number} target - The root comment, the new-reply composer, or the index of the reply to edit.
   */
  function startEdit(row, rowEl, target) {
    if (!editing()) return;
    if (editState) {
      if (editState.row === row && editState.target === target) return;
      // Opening a second editor commits the first, as any click outside it does.
      foldEditor(true);
      // The commit may have replaced this row's element or rebuilt the whole list.
      const i = rows.indexOf(row);
      if (i < 0) return;
      if (rowEls[i]) rowEl = rowEls[i];
      // Its fold animation would otherwise hold this row at the height it was collapsing toward.
      rowEl.getAnimations().forEach((a) => a.cancel());
    }
    /** @type {?HTMLElement} */
    let anchorEl = null;
    if (target === 'root') anchorEl = /** @type {?HTMLElement} */ (rowEl.querySelector('.scribe-cm-text[data-msg="root"], .scribe-cm-ghost[data-ghost="root"]'));
    else if (target === 'new') anchorEl = /** @type {?HTMLElement} */ (rowEl.querySelector('.scribe-cm-ghost[data-ghost="reply"]'));
    else anchorEl = /** @type {?HTMLElement} */ (rowEl.querySelector(`.scribe-cm-msg[data-msg="${target}"] .scribe-cm-text`));
    if (!anchorEl) return;
    const ta = document.createElement('textarea');
    ta.className = 'scribe-cm-field';
    ta.value = target === 'root' ? row.comment : (target === 'new' ? '' : row.replies[target].text);
    ta.placeholder = target === 'root' ? 'Comment…' : 'Reply…';
    const autoGrow = () => {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(190, Math.max(40, ta.scrollHeight))}px`;
    };
    ta.addEventListener('input', autoGrow);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); foldEditor(false); } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); foldEditor(true); }
      e.stopPropagation();
    });
    /** @type {?HTMLDivElement} */
    let wrap = null;
    if (target === 'new') {
      // The composer line mirrors the on-page card's: the author's avatar beside the field.
      wrap = document.createElement('div');
      wrap.className = 'scribe-cm-reply';
      const author = (scribe.opt && scribe.opt.commentAuthor) || '';
      if (author) {
        const ava = document.createElement('span');
        ava.className = 'scribe-cm-ava';
        ava.textContent = author.split(/\s+/, 2).map((s) => s[0]).join('').toUpperCase();
        wrap.appendChild(ava);
      }
      wrap.appendChild(ta);
      wrap.addEventListener('click', (e) => e.stopPropagation());
      anchorEl.before(wrap);
    } else {
      anchorEl.before(ta);
    }
    anchorEl.style.display = 'none';
    /** @type {?HTMLDivElement} */
    let foldElem = null;
    // A fresh composer has nothing to delete.
    if (target !== 'new') {
      foldElem = document.createElement('div');
      foldElem.className = 'scribe-cm-fold';
      const foldInner = document.createElement('div');
      const foot = document.createElement('div');
      foot.className = 'scribe-cm-foot';
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'scribe-cm-remove';
      const conversation = target === 'root' && row.replies.length > 0;
      // A note is its conversation, so deleting the conversation deletes the note.
      if (conversation) removeBtn.textContent = row.kind === 'note' ? 'Delete note' : 'Delete conversation';
      else removeBtn.textContent = target === 'root' ? 'Remove comment' : 'Delete reply';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (conversation) {
          foldEditor(false);
          if (row.kind === 'note') deleteNote(row); else setHighlightComment(row, '');
          rebuild();
        } else {
          ta.value = '';
          foldEditor(true);
        }
      });
      foot.append(removeBtn);
      foldInner.appendChild(foot);
      foldElem.appendChild(foldInner);
      foldElem.addEventListener('click', (e) => e.stopPropagation());
      rowEl.appendChild(foldElem);
    }
    // Clicks inside the editor must not bubble into the row's navigate handler.
    ta.addEventListener('click', (e) => e.stopPropagation());
    /** @param {PointerEvent} e */
    const onDown = (e) => {
      if (!rowEl.contains(/** @type {Node} */ (e.target))) foldEditor(true);
    };
    // Capture phase, so the field commits before the click's own handler runs.
    document.addEventListener('pointerdown', onDown, true);
    editState = {
      row, rowEl, ta, anchorEl, wrap, foldElem, target, onDown,
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
    add('Edit', () => startEdit(row, rowEl, 'root'));
    if (row.kind === 'note') {
      add('Delete note', () => { deleteNote(row); rebuild(); });
    } else {
      // Clearing the comment takes the reply thread with it.
      add(row.replies.length > 0 ? 'Delete conversation' : 'Delete comment', () => { setHighlightComment(row, ''); rebuild(); });
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

    const rightElem = document.createElement('div');
    rightElem.className = 'scribe-cm-right';

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
      text.dataset.msg = 'root';
      text.textContent = row.comment;
      // A single click on the row navigates, so editing takes a double-click.
      if (editing()) text.addEventListener('dblclick', (e) => { e.stopPropagation(); startEdit(row, el, 'root'); });
      el.appendChild(text);
    } else if (editing()) {
      const ghost = document.createElement('button');
      ghost.type = 'button';
      ghost.className = 'scribe-cm-ghost';
      ghost.dataset.ghost = 'root';
      ghost.innerHTML = `${NEW_NOTE_SVG}<span>Add a comment…</span>`;
      ghost.addEventListener('click', (e) => { e.stopPropagation(); startEdit(row, el, 'root'); });
      el.appendChild(ghost);
    }

    row.replies.forEach((reply, ri) => {
      const msg = document.createElement('div');
      msg.className = 'scribe-cm-msg';
      msg.dataset.msg = String(ri);
      if (reply.author || reply.createdAt) {
        const meta = document.createElement('div');
        meta.className = 'scribe-cm-meta';
        if (reply.author) {
          const ava = document.createElement('span');
          ava.className = 'scribe-cm-ava';
          ava.textContent = reply.author.split(/\s+/, 2).map((s) => s[0]).join('').toUpperCase();
          const who = document.createElement('span');
          who.className = 'scribe-cm-who';
          who.textContent = reply.author;
          meta.append(ava, who);
        }
        if (reply.createdAt) {
          const d = new Date(reply.createdAt);
          /** @type {Intl.DateTimeFormatOptions} */
          const dateOpts = { month: 'short', day: 'numeric' };
          if (d.getFullYear() !== new Date().getFullYear()) dateOpts.year = 'numeric';
          const when = document.createElement('span');
          when.className = 'scribe-cm-when';
          when.textContent = `· ${d.toLocaleDateString(undefined, dateOpts)}`;
          meta.appendChild(when);
        }
        msg.appendChild(meta);
      }
      const rtext = document.createElement('div');
      rtext.className = 'scribe-cm-text';
      rtext.textContent = reply.text;
      if (editing()) rtext.addEventListener('dblclick', (e) => { e.stopPropagation(); startEdit(row, el, ri); });
      msg.appendChild(rtext);
      el.appendChild(msg);
    });

    // The way into the conversation: a quiet Reply line that morphs into the composer.
    if (editing() && row.comment) {
      const replyGhost = document.createElement('button');
      replyGhost.type = 'button';
      replyGhost.className = 'scribe-cm-ghost';
      replyGhost.dataset.ghost = 'reply';
      replyGhost.innerHTML = `${NEW_NOTE_SVG}<span>Reply…</span>`;
      replyGhost.addEventListener('click', (e) => { e.stopPropagation(); startEdit(row, el, 'new'); });
      el.appendChild(replyGhost);
    }

    el.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) { toggleSelect(i); return; }
      clearSelection();
      onNavigate(row.pageIndex);
    });

    if (editing()) {
      el.addEventListener('dblclick', (e) => {
        // A double-click inside a message or the open editor must not also open the root editor.
        if (e.target instanceof Element && e.target.closest('.scribe-cm-text, .scribe-cm-field, .scribe-cm-ghost, .scribe-cm-fold, .scribe-cm-reply')) return;
        e.stopPropagation();
        startEdit(row, el, 'root');
      });
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
    window.removeEventListener('pointercancel', onResizeEnd);
    if (onResize) onResize(resizeStartW + (e.clientX - resizeStartX), 'end');
  }
  resizeHandle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    resizeStartX = e.clientX;
    resizeStartW = parseFloat(panelElem.style.width) || panelElem.getBoundingClientRect().width;
    if (onResize) onResize(resizeStartW, 'start');
    window.addEventListener('pointermove', onResizeMove);
    window.addEventListener('pointerup', onResizeEnd);
    // The host stays in its drag regime until an 'end' report, so a canceled drag must deliver one too.
    window.addEventListener('pointercancel', onResizeEnd);
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
   * Remove the comment entry for every selected row.
   * A note is deleted outright; a highlight keeps its mark but loses its comment and any reply thread.
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
   * Scroll the panel row for a highlight or a note into view and pulse it lit.
   * @param {import('../viewerWordObjects.js').UiOcrWord | AnnotationText} target
   *   Any word of the target highlight, or the note annotation itself.
   */
  function reveal(target) {
    // The row for a just-saved comment may not exist yet.
    rebuild();
    const i = 'word' in target
      ? rows.findIndex((row) => row.kind === 'highlight'
        && (target.highlightGroupId ? row.groupId === target.highlightGroupId
          : (row.pageIndex === target.word.line.page.n
            && annotMatchesWord(/** @type {AnnotationHighlight} */ (row.annot), target.word.bbox))))
      : rows.findIndex((row) => row.kind === 'note' && row.annot === target);
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
