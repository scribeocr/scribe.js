// Comments side panel: every annotation in the document as a card, grouped under sticky per-page headers.
// A card is a text markup (quoting its covered text), a freestanding note, or a redaction mark (listed for review, though it has no comment thread).
// A sibling of the bookmarks and thumbnails rails.
import { makeIconButton } from './toolbar.js';
import { annotMatchesWord } from '../viewerHighlights.js';
import { createNote } from '../viewerNotes.js';
import { removeRedactionGroup } from '../viewerRedactions.js';
import { bboxToPageSpace } from '../../../js/addHighlights.js';

// Speech-bubble glyph for the toolbar toggle.
const COMMENT_SVG = '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor"><path d="M3 2h10a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6.5L4 13.5V11H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/></svg>';
// Plus glyph for the header "new note on this page" button (also the row's ghost "Add a comment" affordance).
const NEW_NOTE_SVG = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
// Small dog-eared note glyph marking a freestanding-note row (matches the on-page note icon).
const NOTE_MARK_SVG = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M4 4h16v10l-6 6H4z"/><path d="M20 14l-6 6v-5a1 1 0 0 1 1-1z" fill="rgba(0,0,0,.22)"/></svg>';
// Outline speech bubble for the empty state (the filled COMMENT_SVG stays the toolbar toggle).
const EMPTY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'
  + '<rect x="3" y="4" width="18" height="12.5" rx="2.5"/><path d="M8.5 16.5v3.2l4-3.2"/></svg>';
// Send arrow on the compact composer.
const SEND_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V6M6 12l6-6 6 6"/></svg>';

const DOTS_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 12h.01M12 12h.01M18.5 12h.01"/></svg>';

// A quote up to MAX + SLACK tall shows in full; taller, it caps at MAX and scrolls inside.
// The SLACK band keeps a quote only just over MAX from scrolling to reveal a mere sliver.
const QUOTE_SCROLL_MAX_PX = 160;
const QUOTE_SCROLL_SLACK_PX = 64;

/**
 * One panel row: a highlight group (quoting the text it covers), a freestanding note, or a redaction mark group.
 * `top`/`left` are the anchor's page-space position, ordering rows within a page group.
 * @typedef {{pageIndex: number, kind: 'highlight'|'note'|'redact', comment: string, author: string, createdAt: string,
 *   replies: AnnotationReply[], color: string, preview: string, groupId: ?string,
 *   annot: AnnotationHighlight | AnnotationText | AnnotationRedact, top: number, left: number}} CommentRow
 */

/**
 * Create the comments side panel.
 * @param {*} scribe - The ScribeViewer instance.
 * @param {{ onNavigate: (dest: { pageIndex: number, yFrac?: number }) => void, onResize?: (width: number, phase: 'start'|'move'|'end') => void,
 *   onComposeFocus?: (focused: boolean) => void }} handlers
 *   `onNavigate` receives the anchor's top edge as `yFrac`, a fraction of page height, so the host can scroll to the comment rather than the top of its page.
 *   `onResize` fires as the right-edge handle is dragged, with the desired width and the drag phase.
 *   `onComposeFocus` fires as the compact conversation composer gains/loses focus, so the host can keep it clear of the on-screen keyboard.
 * @returns {{ panelElem: HTMLDivElement, toggleElem: HTMLSpanElement, rebuild: () => void, setActive: (pageIndex: number) => void,
 * setVisible: (v: boolean) => void, setCompact: (on: boolean) => void, reveal: (target: import('../viewerWordObjects.js').UiOcrWord | AnnotationText) => void,
 * destroy: () => void, newNote: () => void }}
 */
export function createCommentsPanel(scribe, { onNavigate, onResize, onComposeFocus }) {
  const panelElem = document.createElement('div');
  panelElem.className = 'scribe-comments-panel';
  panelElem.style.width = '240px';
  panelElem.tabIndex = -1;

  const headerElem = document.createElement('div');
  headerElem.className = 'scribe-cm-hd';
  const headerTitle = document.createElement('span');
  headerTitle.className = 'scribe-cm-hd-title';
  headerTitle.textContent = 'Comments';
  // "New note on this page": drops a freestanding note in the current viewport and opens its editor.
  // Only useful while editing, so a read-only viewer hides it (set in rebuild()).
  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'scribe-cm-new';
  newBtn.title = 'New note on this page';
  newBtn.innerHTML = NEW_NOTE_SVG;
  // Shared by the header button and the phone sheet's header action (which replaces this header there).
  function newNote() {
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
  }
  newBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    newNote();
  });
  headerElem.append(headerTitle, newBtn);
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
    const redact = groupAnns.length > 0 && groupAnns[0].type === 'redact';
    const words = [];
    for (const line of ocrPage.lines) {
      for (const word of line.words) {
        if (redact) {
          // Any-overlap in page space, matching the export engine's drop rule, so the quote shows exactly the words the mark removes (including ones a region mark only grazes).
          const b = bboxToPageSpace(word.bbox, line.orientation, ocrPage.dims);
          if (!groupAnns.some((a) => b.left < a.bbox.right && b.right > a.bbox.left
            && b.top < a.bbox.bottom && b.bottom > a.bbox.top)) continue;
        } else if (!groupAnns.some((a) => annotMatchesWord(a, word.bbox, a.type || 'highlight'))) continue;
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
        if (a.type === 'redact') {
          // Redaction marks get a row (one per group, quoting the text the export will remove) so pending redactions are reviewable here.
          // The row has no comment thread; it exists only to locate and delete the mark.
          const rKey = `redact|${a.groupId}`;
          if (seenGroups.has(rKey)) continue;
          seenGroups.add(rKey);
          const groupAnns = anns.filter((x) => x.type === 'redact' && x.groupId === a.groupId);
          let top = Infinity;
          let left = Infinity;
          for (const g of groupAnns) {
            if (g.bbox.top < top) top = g.bbox.top;
            if (g.bbox.left < left) left = g.bbox.left;
          }
          out.push({
            pageIndex: i,
            kind: 'redact',
            comment: '',
            author: '',
            createdAt: '',
            replies: [],
            color: '',
            preview: quoteText(i, groupAnns),
            groupId: a.groupId,
            annot: a,
            top: top === Infinity ? 0 : top,
            left: left === Infinity ? 0 : left,
          });
          continue;
        }
        if (a.type && a.type !== 'highlight' && a.type !== 'underline' && a.type !== 'strikeout') continue;
        // A text markup (highlight/underline/strikeout) is listed with or without a comment; its covered text is the quote.
        // One row per group, since a markup is many per-word annotations sharing a groupId.
        // Group-less imported highlights key by bbox so distinct ones do not collapse.
        // The kind is in the key and member filter because a highlight and an underline can share a groupId (`addHighlights` numbers groups per call) yet are separate markups.
        const kind = a.type || 'highlight';
        const key = a.groupId ? `${kind}|${a.groupId}` : `bbox:${kind}:${a.bbox.left}:${a.bbox.top}:${a.bbox.right}:${a.bbox.bottom}`;
        if (seenGroups.has(key)) continue;
        seenGroups.add(key);
        const groupAnns = a.groupId ? anns.filter((x) => x.groupId === a.groupId && (x.type || 'highlight') === kind) : [a];
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
   * The row's anchor as a navigation destination.
   * @param {CommentRow} row
   * @returns {{pageIndex: number, yFrac?: number}}
   */
  function rowDest(row) {
    const dims = scribe.doc && scribe.doc.pageMetrics && scribe.doc.pageMetrics[row.pageIndex]
      ? scribe.doc.pageMetrics[row.pageIndex].dims : null;
    return {
      pageIndex: row.pageIndex,
      yFrac: dims && dims.height > 0 ? Math.min(1, Math.max(0, row.top / dims.height)) : undefined,
    };
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
    // The kind gate keeps a same-groupId markup of another kind (see `collectRows`) untouched.
    const rowKind = (row.annot && row.annot.type) || 'highlight';
    const match = row.groupId ? ((a) => a.groupId === row.groupId) : ((a) => a === row.annot);
    for (const a of annPages()[row.pageIndex] || []) {
      if (a.type === 'text' || (a.type || 'highlight') !== rowKind) continue;
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
      for (const kw of scribe.getUiWords()) {
        if (rowKind === 'highlight' && kw.highlightGroupId === row.groupId) kw.highlightComment = comment;
        else if (rowKind !== 'highlight' && kw.markupGroupId === row.groupId) kw.markupComment = comment;
      }
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
      const rowKind = (row.annot && row.annot.type) || 'highlight';
      const match = row.groupId ? ((a) => a.groupId === row.groupId) : ((a) => a === row.annot);
      for (const a of annPages()[row.pageIndex] || []) {
        if (a.type === 'text' || (a.type || 'highlight') !== rowKind) continue;
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
    const rowKind = (row.annot && row.annot.type) || 'highlight';
    const match = row.groupId ? ((a) => a.groupId === row.groupId) : ((a) => a === row.annot);
    const page = annPages()[row.pageIndex] || [];
    scribe.doc.annotations.pages[row.pageIndex] = page.filter((a) => !((a.type || 'highlight') === rowKind && match(a)));
    for (const kw of scribe.getUiWords()) {
      const covered = (row.groupId && (rowKind === 'highlight' ? kw.highlightGroupId : kw.markupGroupId) === row.groupId)
        || (!row.groupId && annotMatchesWord(/** @type {AnnotationHighlight} */ (row.annot), kw.word.bbox, rowKind));
      if (!covered) continue;
      if (rowKind === 'highlight') {
        kw.highlightColor = null;
        kw.highlightOpacity = 1;
        kw.highlightGroupId = null;
        kw.highlightComment = '';
      } else {
        kw.markupType = null;
        kw.markupColor = null;
        kw.markupOpacity = 1;
        kw.markupGroupId = null;
        kw.markupComment = '';
      }
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

  let compact = false;
  /** The row expanded in the compact list. @type {?CommentRow} */
  let openRow = null;
  /** The message being edited: 'root' or a reply index. @type {?('root'|number)} */
  let openEdit = null;
  /**
   * The row whose composer is open.
   * Independent of `openRow`, since a card that folds nothing composes in place without entering the open state.
   * @type {?CommentRow}
   */
  let composingRow = null;
  /**
   * The row `openEdit` applies to.
   * @type {?CommentRow}
   */
  let editRow = null;
  /** Last tap on a thread message, for the double tap that opens its editor. */
  const msgTap = { row: null, target: null, t: 0 };
  /**
   * Disc tint per participant, assigned in order of first appearance in the list.
   * @type {Map<string, string>}
   */
  const avaTint = new Map();

  /**
   * Format an ISO date as "Jun 5", adding the year when it is not the current year.
   * @param {string} iso
   * @returns {string}
   */
  function shortDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    /** @type {Intl.DateTimeFormatOptions} */
    const dateOpts = { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) dateOpts.year = 'numeric';
    return d.toLocaleDateString(undefined, dateOpts);
  }

  /**
   * The row's quote line: the text the mark covers, drawn the way the mark itself draws it.
   * @param {CommentRow} row
   * @returns {HTMLDivElement}
   */
  function compactQuote(row) {
    const q = document.createElement('div');
    q.className = 'scribe-cmc-quote';
    const rowKind = row.kind === 'redact' ? 'redact' : ((row.annot && row.annot.type) || 'highlight');
    q.textContent = row.preview || (rowKind === 'redact' ? 'Region on this page' : '');
    q.title = rowKind === 'underline' ? 'Underline'
      : (rowKind === 'strikeout' ? 'Strikethrough' : (rowKind === 'redact' ? 'Redaction' : 'Highlight'));
    if (rowKind === 'redact') {
      q.classList.add('rd');
    } else if (row.color) {
      if (rowKind === 'underline') {
        q.classList.add('ul');
        q.style.textDecorationColor = row.color;
      } else if (rowKind === 'strikeout') {
        q.classList.add('st');
        q.style.textDecorationColor = row.color;
      } else {
        q.style.background = `color-mix(in srgb, ${row.color} var(--scribe-cm-wash, 35%), transparent)`;
      }
    }
    return q;
  }

  /**
   * A participant's initials disc, tinted so one person is one colour throughout the list.
   * @param {string} name
   * @returns {HTMLSpanElement}
   */
  function avatarFor(name) {
    const el = document.createElement('span');
    el.className = `scribe-cmc-ava scribe-cmc-ava-${avaTint.get(name) || 'a'}`;
    el.textContent = name.split(/\s+/, 2).map((s) => s[0] || '').join('').toUpperCase();
    return el;
  }

  /**
   * An invisible disc-sized spacer.
   * It holds a message's avatar-gutter slot open so every message body shares one text column.
   * @returns {HTMLSpanElement}
   */
  function avatarSlot() {
    const el = document.createElement('span');
    el.className = 'scribe-cmc-ava';
    el.style.visibility = 'hidden';
    return el;
  }

  /**
   * Re-render one compact list row in place, keeping the list's scroll position.
   * @param {CommentRow} row
   */
  function refreshCompactRow(row) {
    const i = rows.indexOf(row);
    if (i < 0 || !rowEls[i]) return;
    const fresh = renderCompactRow(row);
    rowEls[i].replaceWith(fresh);
    rowEls[i] = fresh;
    // A detached field cannot take focus, so the editor and composer are focused here rather than where they are built.
    // Focusing at build time fails silently: on a phone the keyboard simply never opens.
    const ed = /** @type {?HTMLTextAreaElement} */ (fresh.querySelector('.scribe-cmc-ed'));
    if (ed) {
      // scrollHeight also reads 0 while detached, so the initial fit waits for the DOM.
      ed.style.height = 'auto';
      ed.style.height = `${ed.scrollHeight}px`;
      ed.focus({ preventScroll: true });
      ed.setSelectionRange(ed.value.length, ed.value.length);
      return;
    }
    if (composingRow === row) {
      const field = /** @type {?HTMLTextAreaElement} */ (fresh.querySelector('.scribe-cmc-field'));
      if (field) field.focus();
    }
    syncCompactAria(row);
  }

  /**
   * Commit the expanded row's draft.
   * The first message becomes the root comment; later ones append replies.
   * @param {CommentRow} row
   * @param {HTMLTextAreaElement} field
   */
  function postReply(row, field) {
    const next = field.value.trim();
    if (!next) return;
    if (!row.comment) {
      if (row.kind === 'note') setNoteComment(row, next); else setHighlightComment(row, next);
      // The setters stamp author + date on the annotation; copy them back into the row's cached fields.
      const annot = /** @type {AnnotationHighlight | AnnotationText} */ (row.annot);
      row.comment = annot.comment || '';
      row.author = annot.author || '';
      row.createdAt = annot.createdAt || '';
    } else {
      /** @type {AnnotationReply} */
      const reply = { text: next, createdAt: new Date().toISOString() };
      const author = (scribe.opt && scribe.opt.commentAuthor) || '';
      if (author) reply.author = author;
      setRowReplies(row, [...row.replies, reply]);
      row.replies = /** @type {AnnotationHighlight | AnnotationText} */ (row.annot).replies || [];
    }
    field.value = '';
    composingRow = null;
    // The first reply turns a resting card into a thread, which opens on its new conversation.
    if (openRow !== row && row.replies.length) setOpenRow(row);
    else refreshEased(row);
  }

  /**
   * Commit the expanded row's open message editor.
   * Emptying a reply deletes it, but emptying the root discards the edit instead of clearing the comment.
   * @param {CommentRow} row
   * @param {'root'|number} target
   * @param {string} value
   */
  function commitCompactEdit(row, target, value) {
    const next = value.trim();
    openEdit = null;
    if (target === 'root') {
      if (next && next !== row.comment) {
        if (row.kind === 'note') setNoteComment(row, next); else setHighlightComment(row, next);
        const annot = /** @type {AnnotationHighlight | AnnotationText} */ (row.annot);
        row.comment = annot.comment || '';
        row.author = annot.author || '';
        row.createdAt = annot.createdAt || '';
      }
    } else if (next !== row.replies[target].text) {
      const replies = row.replies.slice();
      if (next) replies[target] = { ...replies[target], text: next };
      else replies.splice(target, 1);
      setRowReplies(row, replies);
      row.replies = /** @type {AnnotationHighlight | AnnotationText} */ (row.annot).replies || [];
    }
    refreshEased(row);
  }

  /**
   * Replace one message of the expanded row with a text field.
   * @param {CommentRow} row
   * @param {HTMLElement} msgElem - The message body the editor takes the place of.
   * @param {'root'|number} target
   * @param {string} value
   */
  function openCompactEditor(row, msgElem, target, value) {
    openEdit = target;
    editRow = row;
    const wrap = document.createElement('div');
    wrap.className = 'scribe-cmc-edit';
    // The root's editor sits in the card body, outside the drawer's click guard.
    // A tap into the field must not read as a row tap and fold the card mid-edit.
    wrap.addEventListener('click', (e) => e.stopPropagation());
    const field = document.createElement('textarea');
    field.className = 'scribe-cmc-ed';
    field.value = value;
    field.rows = 1;
    const grow = () => {
      field.style.height = 'auto';
      field.style.height = `${field.scrollHeight}px`;
    };
    field.addEventListener('input', grow);
    field.addEventListener('focus', () => { if (onComposeFocus) onComposeFocus(true); });
    // With no Save button, leaving the field is the commit: a tap anywhere else ends the edit and keeps the draft.
    // The flag keeps the blur a removal fires from double-committing after Esc or Ctrl+Enter already settled the edit.
    let done = false;
    field.addEventListener('blur', () => {
      if (onComposeFocus) onComposeFocus(false);
      if (done) return;
      done = true;
      commitCompactEdit(row, target, field.value);
    });
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        done = true;
        openEdit = null;
        refreshEased(row);
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        done = true;
        commitCompactEdit(row, target, field.value);
      }
      e.stopPropagation();
    });
    wrap.append(field);
    // Swapped live (a double tap on the message), the card eases to the editor's height; during a row render the element is detached and the render's own reflow owns the motion.
    const live = msgElem.isConnected;
    const i = rows.indexOf(row);
    const fromH = live && i >= 0 && rowEls[i] ? rowEls[i].getBoundingClientRect().height : -1;
    msgElem.replaceWith(wrap);
    grow();
    if (live) {
      animateRowReflow(row, fromH);
      // A blur-committed editor must hold focus from the start, or an untouched one could never end.
      field.focus({ preventScroll: true });
      field.setSelectionRange(field.value.length, field.value.length);
    }
  }

  /**
   * Delete the row's whole thread.
   * A note vanishes; a highlight keeps its mark but sheds its comment and replies.
   * @param {CommentRow} row
   */
  function removeRow(row) {
    const before = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? null : new Map();
    if (before) rows.forEach((r, i) => { if (rowEls[i]) before.set(r.annot, rowEls[i].getBoundingClientRect().top); });
    if (row.kind === 'note') deleteNote(row); else setHighlightComment(row, '');
    openRow = null;
    openEdit = null;
    editRow = null;
    composingRow = null;
    rebuild();
    if (!before || !before.size) return;
    /** @type {Array<[HTMLElement, number]>} */
    const shifts = [];
    rows.forEach((r, i) => {
      const el = rowEls[i];
      const from = before.get(r.annot);
      if (!el || from === undefined) return;
      const dy = from - el.getBoundingClientRect().top;
      if (Math.abs(dy) >= 1) shifts.push([el, dy]);
    });
    if (!shifts.length) return;
    for (const [el, dy] of shifts) el.style.transform = `translateY(${dy}px)`;
    listElem.getBoundingClientRect();
    for (const [el] of shifts) {
      el.style.transition = 'transform .24s cubic-bezier(.3, .8, .3, 1)';
      el.style.transform = '';
    }
    setTimeout(() => { for (const [el] of shifts) el.style.transition = ''; }, 300);
  }

  /**
   * Open the panel's shared context menu right-aligned under a message's dots button.
   * @param {HTMLElement} btn
   * @param {(add: (label: string, run: () => void, danger?: boolean) => void) => void} fill
   */
  function openDotsMenu(btn, fill) {
    menuElem.textContent = '';
    fill((label, run, danger) => {
      const item = document.createElement('div');
      item.className = `scribe-cm-menu-item${danger ? ' scribe-cm-menu-danger' : ''}`;
      item.textContent = label;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMenu();
        run();
      });
      menuElem.appendChild(item);
    });
    const r = btn.getBoundingClientRect();
    showMenuAt(r.left, r.bottom + 2);
    const host = (scribe.outerElem || panelElem).getBoundingClientRect();
    menuElem.style.left = `${Math.max(4, r.right - menuElem.offsetWidth - host.left)}px`;
  }

  /**
   * The expanded row's conversation below the card body.
   * The root message itself lives in the card body, shared with the collapsed state.
   * @param {CommentRow} row
   * @returns {HTMLDivElement}
   */
  function buildDrawer(row) {
    const drawer = document.createElement('div');
    drawer.className = 'scribe-cmc-drawer';

    /**
     * One reply of the conversation.
     * @param {AnnotationReply} reply
     * @param {number} ri
     */
    const addMsg = (reply, ri) => {
      const author = reply.author || 'Reviewer';
      const msg = document.createElement('div');
      msg.className = 'scribe-cmc-msg';
      msg.appendChild(avatarFor(author));
      const body = document.createElement('span');
      body.className = 'scribe-cmc-mb';
      const head = document.createElement('span');
      head.className = 'scribe-cmc-mh';
      const who = document.createElement('span');
      who.textContent = author;
      head.appendChild(who);
      if (editing()) {
        const dots = document.createElement('button');
        dots.type = 'button';
        dots.className = 'scribe-cmc-dots';
        dots.title = 'Reply actions';
        dots.setAttribute('aria-label', 'Reply actions');
        dots.innerHTML = DOTS_SVG;
        dots.addEventListener('click', (e) => {
          e.stopPropagation();
          openDotsMenu(dots, (add) => {
            add('Edit', () => {
              msgTap.row = null;
              composingRow = null;
              editRow = row;
              openEdit = ri;
              refreshEased(row);
            });
            add('Delete', () => {
              openEdit = null;
              const i = rows.indexOf(row);
              const h = i >= 0 && rowEls[i] ? rowEls[i].getBoundingClientRect().height : -1;
              const replies = row.replies.slice();
              replies.splice(ri, 1);
              setRowReplies(row, replies);
              row.replies = row.annot.replies || [];
              refreshCompactRow(row);
              animateRowReflow(row, h);
            }, true);
          });
        });
        head.appendChild(dots);
      }
      body.appendChild(head);
      const textElem = document.createElement('span');
      textElem.className = 'scribe-cmc-mt';
      textElem.textContent = reply.text;
      body.appendChild(textElem);
      const ft = compactFoot(row, ri);
      if (ft) body.appendChild(ft);
      msg.appendChild(body);
      drawer.appendChild(msg);
      if (openEdit === ri && editRow === row) openCompactEditor(row, textElem, ri, reply.text);
      else if (editing()) {
        // The double tap that opens the editor is counted from click events, which a phone double tap and a mouse double click both produce.
        textElem.addEventListener('click', (e) => {
          e.stopPropagation();
          const now = Date.now();
          if (msgTap.row === row && msgTap.target === ri && now - msgTap.t < 400) {
            msgTap.row = null;
            openCompactEditor(row, textElem, ri, reply.text);
          } else {
            msgTap.row = row;
            msgTap.target = ri;
            msgTap.t = now;
          }
        });
      }
    };

    row.replies.forEach(addMsg);
    return drawer;
  }

  /**
   * The card's draft field with its send button.
   * Rendered while the row composes, and as an empty note's resting state.
   * @param {CommentRow} row
   * @returns {HTMLDivElement}
   */
  function buildComposer(row) {
    const comp = document.createElement('div');
    comp.className = 'scribe-cmc-comp';
    comp.addEventListener('click', (e) => e.stopPropagation());
    const field = document.createElement('textarea');
    field.className = 'scribe-cmc-field';
    field.rows = 1;
    const answering = row.replies.length ? row.replies[row.replies.length - 1].author : '';
    field.placeholder = row.comment ? (answering ? `Reply to ${answering}…` : 'Reply…') : 'Comment…';
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'scribe-cmc-send';
    send.title = 'Send';
    send.setAttribute('aria-label', 'Send');
    send.innerHTML = SEND_SVG;
    send.disabled = true;
    field.addEventListener('input', () => {
      field.style.height = 'auto';
      field.style.height = `${Math.min(field.scrollHeight, 120)}px`;
      send.disabled = !field.value.trim();
    });
    field.addEventListener('focus', () => { if (onComposeFocus) onComposeFocus(true); });
    field.addEventListener('blur', () => { if (onComposeFocus) onComposeFocus(false); });
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        field.value = '';
        composingRow = null;
        refreshEased(row);
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        postReply(row, field);
      } else if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !field.value.trim()) {
        // A blank reply cannot post (the send button is disabled), so return dismisses the composer.
        // It is the one way out on a phone, which has no Escape.
        e.preventDefault();
        composingRow = null;
        refreshEased(row);
      }
      e.stopPropagation();
    });
    // Posting from the button must not blur the field first, so the keyboard stays up for the next reply.
    send.addEventListener('pointerdown', (e) => e.preventDefault());
    send.addEventListener('click', (e) => { e.stopPropagation(); postReply(row, field); });
    comp.append(field, send);
    return comp;
  }

  /**
   * Ease a re-rendered compact row from its pre-swap height to its fresh natural height.
   * @param {CommentRow} row
   * @param {number} fromH - Rendered height before the swap; negative skips the animation.
   * @param {() => void} [onSettle] - Runs once the height settles (immediately when nothing animates).
   */
  function animateRowReflow(row, fromH, onSettle) {
    const i = rows.indexOf(row);
    const el = i >= 0 ? rowEls[i] : null;
    if (!el || fromH < 0) {
      if (onSettle) onSettle();
      return;
    }
    const toH = el.getBoundingClientRect().height;
    if (Math.abs(toH - fromH) < 1) {
      if (onSettle) onSettle();
      return;
    }
    el.style.height = `${fromH}px`;
    el.classList.add('scribe-cmc-reflow');
    el.getBoundingClientRect();
    el.style.height = `${toH}px`;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener('transitionend', onEnd);
      el.classList.remove('scribe-cmc-reflow');
      el.style.height = '';
      if (onSettle) onSettle();
    };
    /** @param {TransitionEvent} e */
    function onEnd(e) { if (e.target === el && e.propertyName === 'height') settle(); }
    el.addEventListener('transitionend', onEnd);
    // transitionend is lost under reduced motion or if the row leaves layout mid-flight.
    setTimeout(settle, 320);
  }

  /**
   * Re-render `row` easing its height, for control swaps that grow or shrink the card in place.
   * @param {CommentRow} row
   */
  function refreshEased(row) {
    const i = rows.indexOf(row);
    const h = i >= 0 && rowEls[i] ? rowEls[i].getBoundingClientRect().height : -1;
    refreshCompactRow(row);
    animateRowReflow(row, h);
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // A same-height swap has no reflow to ride, so the incoming control fades in instead.
    const el = i >= 0 ? rowEls[i] : null;
    if (!el || h < 0 || Math.abs(el.getBoundingClientRect().height - h) >= 1) return;
    const incoming = el.querySelector('.scribe-cmc-comp, .scribe-cmc-edit');
    if (!(incoming instanceof HTMLElement)) return;
    incoming.style.opacity = '0';
    incoming.getBoundingClientRect();
    incoming.style.transition = 'opacity .18s ease';
    incoming.style.opacity = '1';
    setTimeout(() => { incoming.style.cssText = ''; }, 240);
  }

  /**
   * Ease `row`'s root text between its clamped and full extents, in step with the row's own reveal.
   * @param {CommentRow} row
   * @param {boolean} opening
   */
  function easeRootText(row, opening) {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const i = rows.indexOf(row);
    const el = i >= 0 ? rowEls[i] : null;
    const t = el ? el.querySelector('.scribe-cmc-root .scribe-cmc-text') : null;
    if (!t) return;
    // scrollHeight reads the full content height even while the resting clamp hides it.
    const clamped = Math.round(parseFloat(getComputedStyle(t).lineHeight) * 2);
    const full = t.scrollHeight;
    if (full <= clamped + 2) return;
    t.style.display = 'block';
    t.style.webkitLineClamp = 'unset';
    t.style.maxHeight = `${opening ? clamped : full}px`;
    t.getBoundingClientRect();
    t.style.transition = 'max-height .24s cubic-bezier(.3, .8, .3, 1)';
    t.style.maxHeight = `${opening ? full : clamped}px`;
    setTimeout(() => { t.style.cssText = ''; }, 300);
  }

  /**
   * Dissolve `row`'s reply summary as the conversation opens; print it back in place as the card folds shut.
   * @param {CommentRow} row
   * @param {boolean} opening
   */
  function easeStrip(row, opening) {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const i = rows.indexOf(row);
    const el = i >= 0 ? rowEls[i] : null;
    const s = el ? el.querySelector('.scribe-cmc-strip') : null;
    if (!(s instanceof HTMLElement)) return;
    if (!opening) {
      // The returning summary only fades in at its resting size and place.
      // The fold's rising edge does the moving, so nothing inside the collapsed card travels against it.
      s.style.opacity = '0';
      s.getBoundingClientRect();
      s.style.transition = 'opacity .24s cubic-bezier(.3, .8, .3, 1)';
      s.style.opacity = '1';
      setTimeout(() => { s.style.cssText = ''; }, 300);
      return;
    }
    // scrollHeight still reads the faces' height while the open state holds the strip at zero.
    const full = `${s.scrollHeight}px`;
    s.style.overflow = 'hidden';
    s.style.visibility = 'visible';
    s.style.height = full;
    s.style.marginTop = '8px';
    s.style.opacity = '1';
    s.getBoundingClientRect();
    const curve = '.24s cubic-bezier(.3, .8, .3, 1)';
    s.style.transition = `height ${curve}, margin-top ${curve}, opacity ${curve}`;
    s.style.height = '0';
    s.style.marginTop = '0';
    s.style.opacity = '0';
    setTimeout(() => { s.style.cssText = ''; }, 300);
  }

  /**
   * Expand `row` in place (animated), collapsing whichever row was open.
   * @param {?CommentRow} row
   */
  function setOpenRow(row) {
    const prev = openRow;
    if (prev === row) return;
    // A keyboard toggle never reaches the outside-click closer, so any open dots menu would outlive the re-render.
    closeMenu();
    openRow = row;
    openEdit = null;
    const prevComposing = composingRow !== row ? composingRow : null;
    if (composingRow !== row) composingRow = null;
    const elOf = (r) => {
      const i = rows.indexOf(r);
      return (i >= 0 && rowEls[i]) ? rowEls[i] : null;
    };
    const prevEl = prev ? elOf(prev) : null;
    const prevH = prevEl ? prevEl.getBoundingClientRect().height : -1;
    const openH = row && elOf(row) ? elOf(row).getBoundingClientRect().height : -1;
    const listBox = listElem.getBoundingClientRect();
    const startY = row && elOf(row) ? elOf(row).getBoundingClientRect().top - listBox.top : 0;
    if (prevComposing && prevComposing !== prev) refreshCompactRow(prevComposing);
    if (prev) refreshCompactRow(prev);
    if (row) refreshCompactRow(row);
    // Both rows now rest at their final sizes, so the pin aims at the layout the motion ends in.
    // With the pin aimed at the starting layout instead, the row overshoots and falls back.
    const el = row ? elOf(row) : null;
    let targetY = 0;
    if (el) {
      const fin = el.getBoundingClientRect();
      const finY = fin.top - listBox.top;
      // A conversation usually outgrows the list, so its top is pinned to the list's top rather than nudged the minimum distance, which would leave most of the thread below the fold.
      targetY = (fin.height > listBox.height || finY < 0) ? 0
        : finY - Math.max(0, finY + fin.height - listBox.height);
    }
    // The height ease measures its target before the inner eases move the text and strip to their start values.
    // A later measure would catch them mid-start and settle the row short.
    if (prev) {
      const freshEl = elOf(prev);
      const toH = freshEl ? freshEl.getBoundingClientRect().height : -1;
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!reduce && prevEl && freshEl && toH >= 0 && Math.abs(toH - prevH) >= 1) {
        // The collapsed render steps aside so the card folds shut over its still-painted conversation.
        // Folding over a card re-rendered up front spends the whole ease sweeping a blank tail.
        freshEl.replaceWith(prevEl);
        // The summary takes its resting slot at once and fades in place while the fold clips the conversation away beneath it.
        // Its start state must ride the same style pass as the class flip: a flush between them snaps it to resting opacity, and the fade then plays backwards.
        const s = prevEl.querySelector('.scribe-cmc-strip');
        if (s instanceof HTMLElement) {
          s.style.opacity = '0';
          s.style.transition = 'opacity .2s cubic-bezier(.3, .8, .3, 1)';
        }
        prevEl.classList.remove('open');
        prevEl.setAttribute('aria-expanded', 'false');
        prevEl.style.height = `${prevH}px`;
        prevEl.classList.add('scribe-cmc-reflow');
        const t = prevEl.querySelector('.scribe-cmc-root .scribe-cmc-text');
        const clamped = t instanceof HTMLElement ? Math.round(parseFloat(getComputedStyle(t).lineHeight) * 2) : 0;
        // The class flip restored the resting clamp; inline overrides hold the text open so it can ease down.
        const unclamp = t instanceof HTMLElement && t.scrollHeight > clamped + 2;
        if (unclamp) {
          t.style.display = 'block';
          t.style.webkitLineClamp = 'unset';
          t.style.maxHeight = `${t.scrollHeight}px`;
          t.style.transition = 'max-height .2s cubic-bezier(.3, .8, .3, 1)';
        }
        prevEl.getBoundingClientRect();
        prevEl.style.height = `${toH}px`;
        // The fade and re-clamp commit after one rendered frame at their start values, so the transitions arm against that frame rather than the pre-collapse open state.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (unclamp) t.style.maxHeight = `${clamped}px`;
          if (s instanceof HTMLElement) s.style.opacity = '1';
        }));
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          prevEl.removeEventListener('transitionend', onEnd);
          // The canonical collapsed render takes over; a mid-fold re-render may have replaced it.
          const j = rows.indexOf(prev);
          const cur = j >= 0 ? rowEls[j] : null;
          if (prevEl.parentNode && cur && !cur.parentNode) prevEl.replaceWith(cur);
          else prevEl.remove();
        };
        /** @param {TransitionEvent} e */
        function onEnd(e) { if (e.target === prevEl && e.propertyName === 'height') settle(); }
        prevEl.addEventListener('transitionend', onEnd);
        setTimeout(settle, 320);
      } else {
        animateRowReflow(prev, prevH);
        easeRootText(prev, false);
        easeStrip(prev, false);
      }
    }
    if (row) {
      animateRowReflow(row, openH);
      easeRootText(row, true);
      easeStrip(row, true);
    }
    if (el) glideScroll(el, startY, targetY);
  }

  let glideSeq = 0;

  /**
   * Ease the list's scroll so the toggled row travels straight to its pinned resting place.
   * @param {HTMLElement} el - The opened row, re-measured every frame so the collapse above it and its own growth compose into one motion.
   * @param {number} from - The row's on-screen offset as the toggle begins.
   * @param {number} to - The offset the pin rule chose against the final layout.
   */
  function glideScroll(el, from, to) {
    const seq = ++glideSeq;
    // Scrolled by hand rather than with scrollIntoView, which walks every scrollable ancestor and would drag the whole viewer along to bring one list row into view.
    const place = (y) => {
      listElem.scrollTop += (el.getBoundingClientRect().top - listElem.getBoundingClientRect().top) - y;
    };
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      place(to);
      return;
    }
    // y(x) of the reveal's cubic-bezier(.3, .8, .3, 1), so the glide shares its cadence.
    const curve = (x) => {
      let lo = 0;
      let hi = 1;
      let u = x;
      for (let k = 0; k < 24; k++) {
        u = (lo + hi) / 2;
        if (3 * (1 - u) * (1 - u) * u * 0.3 + 3 * (1 - u) * u * u * 0.3 + u * u * u < x) lo = u;
        else hi = u;
      }
      return 3 * (1 - u) * (1 - u) * u * 0.8 + 3 * (1 - u) * u * u + u * u * u;
    };
    let start = 0;
    /** @param {number} ts */
    const step = (ts) => {
      if (seq !== glideSeq || !el.isConnected) return;
      if (!start) start = ts;
      const p = Math.min(1, (ts - start) / 240);
      place(from + (to - from) * curve(p));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /**
   * Whether the row folds anything a tap could reveal.
   * The clamped-text check measures the rendered element, so it must run against an attached row.
   * @param {CommentRow} row
   * @returns {boolean}
   */
  function rowFolds(row) {
    if (row.kind === 'redact') return false;
    if (row === openRow) return true;
    if (row.replies.length) return true;
    const i = rows.indexOf(row);
    const el = i >= 0 ? rowEls[i] : null;
    const t = el ? el.querySelector('.scribe-cmc-root .scribe-cmc-text') : null;
    return !!t && t.scrollHeight > t.clientHeight + 1;
  }

  /**
   * Reflect the row's measured foldability on its rendered element.
   * Rows are built detached with no layout to measure the clamp, so the render pass cannot set this.
   * @param {CommentRow} row
   */
  function syncCompactAria(row) {
    const i = rows.indexOf(row);
    const el = i >= 0 ? rowEls[i] : null;
    if (!el || row.kind === 'redact') return;
    if (rowFolds(row)) el.setAttribute('aria-expanded', String(row === openRow));
    else el.removeAttribute('aria-expanded');
  }

  /**
   * A message's foot line.
   * Carries the date, plus the Reply verb when the message is where the conversation ends.
   * @param {CommentRow} row
   * @param {'root'|number} target
   * @returns {?HTMLDivElement}
   */
  function compactFoot(row, target) {
    const createdAt = target === 'root' ? row.createdAt : (row.replies[target] && row.replies[target].createdAt) || '';
    const last = target === 'root' ? row.replies.length === 0 : target === row.replies.length - 1;
    const verb = editing() && last && composingRow !== row;
    if (!createdAt && !verb) return null;
    const ft = document.createElement('div');
    ft.className = 'scribe-cmc-ft';
    if (createdAt) {
      const fd = document.createElement('span');
      fd.className = 'scribe-cmc-fd';
      fd.textContent = shortDate(createdAt);
      ft.appendChild(fd);
    }
    if (verb) {
      const fr = document.createElement('button');
      fr.type = 'button';
      fr.className = 'scribe-cmc-fr';
      fr.textContent = row.comment || target !== 'root' ? 'Reply' : 'Comment';
      fr.addEventListener('click', (e) => {
        e.stopPropagation();
        openEdit = null;
        composingRow = row;
        refreshEased(row);
      });
      ft.appendChild(fr);
    }
    return ft;
  }

  /**
   * One row of the compact list, rendered collapsed or expanded.
   * The collapsed form is a strict prefix of the expanded one, so opening a card only reveals the conversation below what is already showing.
   * @param {CommentRow} row
   * @returns {HTMLDivElement}
   */
  function renderCompactRow(row) {
    const el = document.createElement('div');
    el.className = 'scribe-cmc-row';
    el.dataset.page = String(row.pageIndex);
    const interactive = row.kind !== 'redact';
    const expanded = interactive && row === openRow;
    if (expanded) el.classList.add('open');
    if (interactive) {
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
    }
    const rail = document.createElement('span');
    rail.className = 'scribe-cmc-rail';
    rail.style.background = row.kind === 'note' ? 'var(--scribe-note)'
      : (row.kind === 'redact' ? 'var(--scribe-danger)' : (row.color || 'var(--scribe-line-strong)'));
    const inner = document.createElement('div');
    inner.className = 'scribe-cmc-in';
    el.append(rail, inner);

    const head = document.createElement('div');
    head.className = 'scribe-cmc-hd';
    head.appendChild(avatarFor(row.author || 'Reviewer'));
    const mh = document.createElement('span');
    mh.className = 'scribe-cmc-mh';
    const who = document.createElement('span');
    who.className = 'scribe-cmc-who';
    who.textContent = row.author || 'Reviewer';
    mh.appendChild(who);
    // Comment dates live in each message's foot. A redaction has no messages, so its date keeps the head slot.
    if (row.kind === 'redact' && row.createdAt) {
      const when = document.createElement('span');
      when.className = 'scribe-cmc-when';
      when.textContent = `· ${shortDate(row.createdAt)}`;
      mh.appendChild(when);
    }
    head.appendChild(mh);
    const pg = document.createElement('span');
    pg.className = 'scribe-cmc-pg';
    pg.textContent = `p. ${row.pageIndex + 1}`;
    head.appendChild(pg);
    if (editing() && interactive && (row.comment || row.kind === 'note')) {
      const dots = document.createElement('button');
      dots.type = 'button';
      dots.className = 'scribe-cmc-dots';
      dots.title = 'Comment actions';
      dots.setAttribute('aria-label', 'Comment actions');
      dots.innerHTML = DOTS_SVG;
      dots.addEventListener('click', (e) => {
        e.stopPropagation();
        openDotsMenu(dots, (add) => {
          if (row.comment) {
            add('Edit', () => {
              msgTap.row = null;
              // A clamped card opens so the editor holds the full text. A card that folds nothing edits in place.
              if (openRow !== row && rowFolds(row)) setOpenRow(row);
              composingRow = null;
              editRow = row;
              openEdit = 'root';
              refreshEased(row);
            });
          }
          const delLabel = row.replies.length ? 'Delete thread'
            : (row.kind === 'note' ? 'Delete note' : 'Delete');
          add(delLabel, () => removeRow(row), true);
        });
      });
      head.appendChild(dots);
    }
    inner.appendChild(head);

    const quote = row.kind !== 'note' && (row.preview || row.kind === 'redact') ? compactQuote(row) : null;
    if (quote) inner.appendChild(quote);

    if (row.comment) {
      const rootRow = document.createElement('div');
      rootRow.className = 'scribe-cmc-root';
      rootRow.appendChild(avatarSlot());
      const col = document.createElement('div');
      col.className = 'scribe-cmc-rc';
      const textElem = document.createElement('div');
      textElem.className = 'scribe-cmc-text';
      textElem.textContent = row.comment;
      col.appendChild(textElem);
      const ft = compactFoot(row, 'root');
      if (ft) col.appendChild(ft);
      rootRow.appendChild(col);
      inner.appendChild(rootRow);
      if (openEdit === 'root' && editRow === row) openCompactEditor(row, textElem, 'root', row.comment);
      else if (editing()) {
        // The double tap that opens the editor is counted from click events, which a phone double tap and a mouse double click both produce.
        textElem.addEventListener('click', (e) => {
          // A folding card's resting summary belongs to the row tap. Its text edits only once the card is open.
          if (!expanded && rowFolds(row)) return;
          const now = Date.now();
          if (msgTap.row === row && msgTap.target === 'root' && now - msgTap.t < 400) {
            e.stopPropagation();
            msgTap.row = null;
            openCompactEditor(row, textElem, 'root', row.comment);
          } else {
            msgTap.row = row;
            msgTap.target = 'root';
            msgTap.t = now;
            // On a resting card the first tap stays a card tap, so it still navigates to the mark.
            if (expanded) e.stopPropagation();
          }
        });
      }
    } else if (row.kind === 'redact') {
      const gone = document.createElement('div');
      gone.className = 'scribe-cmc-text gone';
      gone.textContent = 'Removed on export';
      inner.appendChild(gone);
    } else if (row.kind !== 'note' && (row.createdAt || editing())) {
      // An uncommented highlight or markup has no message, but the foot still anchors the date and the Comment verb.
      // An empty note gets no verb since its resting composer below is the affordance.
      const rootRow = document.createElement('div');
      rootRow.className = 'scribe-cmc-root';
      rootRow.appendChild(avatarSlot());
      const col = document.createElement('div');
      col.className = 'scribe-cmc-rc';
      const ft = compactFoot(row, 'root');
      if (ft) col.appendChild(ft);
      rootRow.appendChild(col);
      if (col.childNodes.length) inner.appendChild(rootRow);
    }

    if (row.replies.length) {
      // The open row renders the reply summary too, held at zero by CSS, so the toggle can ease it away and back.
      const strip = document.createElement('div');
      strip.className = 'scribe-cmc-strip';
      const faces = document.createElement('span');
      faces.className = 'scribe-cmc-faces';
      const seen = new Set();
      // Newest speaker first, so the stack paints them over the people they answered.
      for (const speaker of [{ author: row.author }, ...row.replies].reverse()) {
        const face = speaker.author || 'Reviewer';
        if (seen.has(face) || seen.size >= 3) continue;
        seen.add(face);
        faces.appendChild(avatarFor(face));
      }
      strip.appendChild(faces);
      const n = document.createElement('span');
      n.className = 'scribe-cmc-n';
      n.textContent = row.replies.length > 1 ? `${row.replies.length} replies` : '1 reply';
      strip.append(n);
      inner.appendChild(strip);
    }

    if (expanded) inner.appendChild(buildDrawer(row));

    if (editing() && (composingRow === row || (row.kind === 'note' && !row.comment))) {
      inner.appendChild(buildComposer(row));
    }

    el.addEventListener('click', (e) => {
      if (/** @type {HTMLElement} */ (e.target).closest('.scribe-cmc-drawer, .scribe-cmc-comp, .scribe-cmc-edit, button, textarea')) return;
      onNavigate(rowDest(row));
      if (interactive && (expanded || rowFolds(row))) setOpenRow(expanded ? null : row);
    });
    if (interactive) {
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        if (/** @type {HTMLElement} */ (e.target).closest('.scribe-cmc-drawer, .scribe-cmc-comp, button, textarea')) return;
        e.preventDefault();
        onNavigate(rowDest(row));
        if (expanded || rowFolds(row)) setOpenRow(expanded ? null : row);
      });
    }
    return el;
  }

  /**
   * Switch between the desktop card list and the compact phone list.
   * @param {boolean} on
   */
  function setCompact(on) {
    if (compact === !!on) return;
    compact = !!on;
    panelElem.classList.toggle('scribe-cm-compact', compact);
    openRow = null;
    openEdit = null;
    editRow = null;
    composingRow = null;
    if (visible) rebuild();
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
      // A note is its conversation even when reply-less, so a note root's verb deletes the note itself.
      // A highlight root without replies only clears its comment.
      const deletes = target === 'root' && (row.kind === 'note' || row.replies.length > 0);
      if (deletes) removeBtn.textContent = row.kind === 'note' ? 'Delete note' : 'Delete conversation';
      else removeBtn.textContent = target === 'root' ? 'Remove comment' : 'Delete reply';
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (deletes) {
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
    if (row.kind === 'redact') {
      // Deletes the whole group, including its marks on other pages.
      add('Delete redaction', () => { removeRedactionGroup(scribe, row.groupId); rebuild(); });
      showMenuAt(x, y);
      return;
    }
    add('Edit', () => startEdit(row, rowEl, 'root'));
    if (row.kind === 'note') {
      add('Delete note', () => { deleteNote(row); rebuild(); });
    } else {
      // Clearing the comment takes the reply thread with it.
      add(row.replies.length > 0 ? 'Delete conversation' : 'Delete comment', () => { setHighlightComment(row, ''); rebuild(); });
      const rowKind = (row.annot && row.annot.type) || 'highlight';
      const deleteLabel = rowKind === 'underline' ? 'Delete underline'
        : (rowKind === 'strikeout' ? 'Delete strikethrough' : 'Delete highlight');
      add(deleteLabel, () => { deleteHighlight(row); rebuild(); });
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

    // Markup rows carry no kind label: the quote renders with its own annotation applied (wash, underline, strikethrough, or redaction hatch), so it self-identifies.
    // The kind word rides in the quote's tooltip.
    const anchor = document.createElement('div');
    anchor.className = 'scribe-cm-anchor';
    const bar = document.createElement('span');
    bar.className = 'scribe-cm-bar';
    // Raw mark color, not a tinted shade, matching the coin picker's swatches.
    if (row.kind === 'note') bar.style.background = 'var(--scribe-note)';
    else if (row.kind === 'redact') bar.style.background = '#d1493d';
    else if (row.color) bar.style.background = row.color;
    anchor.appendChild(bar);
    if (row.kind === 'note') {
      const kind = document.createElement('span');
      kind.className = 'scribe-cm-kind';
      kind.innerHTML = `${NOTE_MARK_SVG}<span>Note</span>`;
      anchor.appendChild(kind);
    } else {
      const rowKind = row.kind === 'redact' ? 'redact' : ((row.annot && row.annot.type) || 'highlight');
      const quote = document.createElement('span');
      quote.className = 'scribe-cm-quote';
      quote.title = rowKind === 'underline' ? 'Underline'
        : (rowKind === 'strikeout' ? 'Strikethrough' : (rowKind === 'redact' ? 'Redaction' : 'Highlight'));
      if (rowKind === 'redact') {
        quote.classList.add('scribe-cm-qmark', 'scribe-cm-q-rd');
        // A region mark (drawn over a figure or scan) covers no words, so its quote falls back to a placeholder.
        quote.textContent = row.preview || 'Region on this page';
      } else {
        quote.textContent = row.preview;
        if (rowKind === 'underline') {
          quote.classList.add('scribe-cm-q-ul');
          if (row.color) quote.style.textDecorationColor = row.color;
        } else if (rowKind === 'strikeout') {
          quote.classList.add('scribe-cm-q-st');
          if (row.color) quote.style.textDecorationColor = row.color;
        } else if (row.color) {
          quote.classList.add('scribe-cm-qmark');
          quote.style.background = `color-mix(in srgb, ${row.color} var(--scribe-cm-wash, 35%), transparent)`;
        }
      }
      if (row.preview) {
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
      }
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
    } else if (editing() && row.kind !== 'redact') {
      // A redaction mark has no comment field, so its row offers no composer.
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
      onNavigate(rowDest(row));
    });

    if (editing()) {
      if (row.kind !== 'redact') {
        el.addEventListener('dblclick', (e) => {
          // A double-click inside a message or the open editor must not also open the root editor.
          if (e.target instanceof Element && e.target.closest('.scribe-cm-text, .scribe-cm-field, .scribe-cm-ghost, .scribe-cm-fold, .scribe-cm-reply')) return;
          e.stopPropagation();
          startEdit(row, el, 'root');
        });
      }
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

    if (row.kind === 'redact') {
      // Row->mark half of the hover sync: hovering the row washes the group's on-page marks, since redaction marks otherwise look alike.
      /** @type {Array<Element>} */
      let litMarks = [];
      el.addEventListener('mouseenter', () => {
        litMarks = [...(scribe.outerElem || document).querySelectorAll('.scribe-redact-mark')]
          .filter((m) => /** @type {HTMLElement} */ (m).dataset.groupId === row.groupId);
        for (const m of litMarks) m.classList.add('scribe-redact-hover');
      });
      el.addEventListener('mouseleave', () => {
        for (const m of litMarks) m.classList.remove('scribe-redact-hover');
        litMarks = [];
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
    if (!hasDoc()) {
      openRow = null;
      return;
    }
    rows = collectRows();
    // Sort by page then position, never creation order, so a highlight added atop a page never lists below an older one lower down.
    rows.sort((a, b) => a.pageIndex - b.pageIndex || a.top - b.top || a.left - b.left);
    avaTint.clear();
    for (const row of rows) {
      for (const who of [row.author || 'Reviewer', ...row.replies.map((reply) => reply.author || 'Reviewer')]) {
        if (!avaTint.has(who)) avaTint.set(who, 'abc'[avaTint.size % 3]);
      }
    }
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
      openRow = null;
      return;
    }
    let lastPage = -1;
    rows.forEach((row, i) => {
      if (!compact && row.pageIndex !== lastPage) {
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
      const el = compact ? renderCompactRow(row) : renderRow(row, i);
      rowEls[i] = el;
      listElem.appendChild(el);
    });
    if (compact) {
      // `collectRows` rebuilds the row objects, so the stateful rows are re-found by annotation identity.
      /** @type {(r: ?CommentRow) => ?CommentRow} */
      const refind = (r) => (r ? rows.find((x) => x.annot === r.annot)
        || (r.groupId ? rows.find((x) => x.kind === r.kind && x.groupId === r.groupId && x.pageIndex === r.pageIndex) : null)
        || null : null);
      openRow = refind(openRow);
      composingRow = refind(composingRow);
      editRow = refind(editRow);
      if (!editRow) openEdit = null;
      // The loop above rendered every row against the stale identities, so the stateful ones render once more.
      for (const r of new Set([openRow, composingRow, editRow].filter(Boolean))) {
        const i = rows.indexOf(r);
        if (rowEls[i]) {
          const fresh = renderCompactRow(r);
          rowEls[i].replaceWith(fresh);
          rowEls[i] = fresh;
        }
      }
      rows.forEach(syncCompactAria);
    }
  }

  // Capture phase on the document, so a press anywhere outside dismisses the menu even when the press target's own handler stops propagation.
  // The click leg covers keyboard-activated controls, which fire no pointer events.
  /** @param {Event} e */
  const dismissMenu = (e) => {
    if (menuElem.style.display !== 'none' && !menuElem.contains(/** @type {Node} */ (e.target))) closeMenu();
  };
  document.addEventListener('pointerdown', dismissMenu, true);
  document.addEventListener('click', dismissMenu, true);

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
   * A note is deleted outright.
   * A highlight keeps its mark but loses its comment and reply thread
   * A redaction (having no comment) is deleted outright, group-wide.
   */
  function deleteSelected() {
    if (!editing() || selected.size === 0) return;
    const targets = [...selected].map((i) => rows[i]).filter(Boolean);
    for (const row of targets) {
      if (row.kind === 'note') deleteNote(row);
      else if (row.kind === 'redact') removeRedactionGroup(scribe, row.groupId);
      else setHighlightComment(row, '');
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
      if (compact && composingRow) {
        const r = composingRow;
        composingRow = null;
        refreshEased(r);
        return;
      }
      if (compact && openRow) { setOpenRow(null); return; }
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
    else {
      foldEditor(false);
      clearSelection();
      openRow = null;
      openEdit = null;
      editRow = null;
      composingRow = null;
    }
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
    let i = -1;
    if ('word' in target) {
      // Try the fill before the line markup, matching the card's click-to-pin priority.
      // Each lookup also filters on kind, since a fill and a line markup can share a groupId.
      const rowKindOf = (row) => ((row.annot && row.annot.type) || 'highlight');
      if (target.highlightGroupId) {
        i = rows.findIndex((row) => row.kind === 'highlight' && row.groupId === target.highlightGroupId && rowKindOf(row) === 'highlight');
      }
      if (i < 0 && target.markupGroupId) {
        i = rows.findIndex((row) => row.kind === 'highlight' && row.groupId === target.markupGroupId && rowKindOf(row) !== 'highlight');
      }
      if (i < 0) {
        i = rows.findIndex((row) => row.kind === 'highlight'
          && row.pageIndex === target.word.line.page.n
          && annotMatchesWord(/** @type {AnnotationHighlight} */ (row.annot), target.word.bbox, (row.annot && row.annot.type) || 'highlight'));
      }
    } else {
      i = rows.findIndex((row) => row.kind === 'note' && row.annot === target);
    }
    const el = i >= 0 ? rowEls[i] : null;
    if (!el) return;
    el.scrollIntoView({ block: 'nearest' });
    el.classList.add('lit');
    setTimeout(() => el.classList.remove('lit'), 1600);
    if (compact && rowFolds(rows[i])) setOpenRow(rows[i]);
  }

  function destroy() {
    closeMenu();
    foldEditor(false); // drops the editor's document-level click-out listener
    document.removeEventListener('pointerdown', dismissMenu, true);
    document.removeEventListener('click', dismissMenu, true);
    menuElem.remove();
    panelElem.remove();
    document.removeEventListener('keydown', onKeyDown);
    if (scribe.onHighlightHover === onHighlightHover) scribe.onHighlightHover = null;
  }

  panelElem.style.display = 'none';
  return {
    panelElem, toggleElem, rebuild, setActive, setVisible, setCompact, reveal, destroy, newNote,
  };
}
