// Document interaction tools shared by the viewer and editor apps: text highlighting
// (toggle, color picker, comment marks), the upload drop zone, and the file-to-ScribeDoc loader.
import scribeLib from '../../../scribe.js';
import {
  makeIconButton, setTimestamp, EDIT_PAGES_SVG, RECOGNIZE_SVG,
} from './toolbar.js';
import {
  applyHighlight, createInkEdges, recolorHighlightGroup, removeHighlightGroup, setHighlightReplies,
} from '../viewerHighlights.js';
import { focusNoteEditor, removeNote, setNoteComment } from '../viewerNotes.js';
import { redactWords, redactRegion } from '../viewerRedactions.js';
import { createLineEditor } from '../editTextLineEditor.js';
import { createFillSignPalette, ICON_FILLSIGN } from '../viewerFillSign.js';
import { nativeTextForPage } from '../../../js/textEdits.js';
import { pageImagePlacements, pagePathPlacements } from '../../../js/fillSign.js';
import { showTouchCallout, hideTouchCallout } from '../viewerCanvasInteraction.js';
import {
  resolveActiveSheet, copyTablePreviewSelection, selectAllTablePreviewCells, moveTablePreviewSelection,
} from '../viewerTablePreview.js';
import { filesFromDropEvent } from '../dragAndDrop.js';

// Filled highlighter-marker glyph (Material).
// The head path (`.scribe-hl-tip`) is filled with the selected highlight color to preview the active swatch (see `setTipColor`), while the base bar underneath stays the default ink color.
const HIGHLIGHT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" height="20" width="20" viewBox="0 -960 960 960" fill="currentColor">
<path class="scribe-hl-tip" d="M280-320v-440q0-33 23.5-56.5T360-840q9 0 18 2t17 6l240 119q20 10 32.5 29.5T680-641v321H280Z"/>
<path d="M160-120l22-65q8-25 29-40t47-15h444q26 0 47 15t29 40l22 65H160Z"/>
</svg>`;
// eslint-disable-next-line max-len
const HIGHLIGHT_CURSOR = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' height=\'24\' width=\'24\' viewBox=\'0 -960 960 960\'%3E%3Cpath fill=\'white\' stroke=\'black\' stroke-width=\'30\' d=\'m268-212-56-56q-12-12-12-28.5t12-28.5l423-423q12-12 28.5-12t28.5 12l56 56q12 12 12 28.5T748-635L324-212q-11 11-28 11t-28-11Z\'/%3E%3C/svg%3E") 12 12, auto';
// Placed raw at 11px without a `.cr-icon` wrapper, so it needs its own inline size and a heavier 2.2 stroke to stay crisp that small.
// eslint-disable-next-line max-len
const HIGHLIGHT_CARET_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:block;width:11px;height:11px;pointer-events:none;" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

// Comment-card verb glyphs, sized by the `.scribe-cmt-vb svg` rule.
// Drawn in the product's icon language (see `lineIcon` in toolbar.js): 24-grid, 1.6px stroke, round caps and joins.
// eslint-disable-next-line max-len
const TB_DELETE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.5h16M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5M6 6.5l.9 11.2a2 2 0 0 0 2 1.8h6.2a2 2 0 0 0 2-1.8L18 6.5"/></svg>';
// eslint-disable-next-line max-len
const TB_PANEL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="15.5" rx="2.5"/><path d="M9.5 4v15.5"/></svg>';

/**
 * Build the highlight tool: toggle button, optional color picker, overlay-word highlighting, highlighter cursor, and comment marks.
 * The toolbar DOM is built immediately. The selection/comment behaviors are wired by `installBehaviors()` after `scribe.init`.
 * @param {import('../../viewer.js').ScribeViewer} scribe
 * @param {HTMLElement} rootElem - The app's root element (for selection scope and cursor CSS).
 * @param {object} cfg
 * @param {string[]} cfg.colors - One or more hex colors.
 * @param {string} cfg.defaultColor - Initial color (must be in `colors`).
 * @param {string} cfg.rootClass - The app's root class (for scoping the cursor rule).
 * @returns {{
 *   highlightElem: HTMLSpanElement, toolbarElem: HTMLSpanElement,
 *   updateCommentIcons: () => void,
 *   installBehaviors: () => (() => void)
 * }}
 */
export function createHighlightTool(scribe, rootElem, { colors, defaultColor, rootClass }) {
  let highlightMode = false;
  let highlightColor = defaultColor;
  // Expose the active color to the core viewer so its right-click "Highlight" item can use it (see viewer._highlightColor).
  scribe._highlightColor = highlightColor;
  /** @type {?HTMLStyleElement} */
  let cursorStyleElem = null;
  /**
   * Opens the highlight card (mini toolbar) with its comment editor expanded, anchored to `words[0]`.
   * Assigned by `installBehaviors`.
   * Called from the comment mark and (via `scribe._openCommentEditor`) the context menu.
   * @type {?(words: Array<import('../viewerWordObjects.js').UiOcrWord>) => void}
   */
  let openCommentEditor = null;

  const highlightElem = makeIconButton('Highlight', HIGHLIGHT_SVG);
  const tipPath = highlightElem.querySelector('.scribe-hl-tip');
  const setTipColor = (c) => { if (tipPath && c) tipPath.style.fill = c; };
  setTipColor(highlightColor);

  /** Toggle the highlighter cursor over the page's text when highlight mode is active. */
  function updateHighlightCursorStyle() {
    if (scribe.useCustomSelection) {
      // No word elements to hang a cursor rule on: the selection engine sets the container's cursor.
      scribe.textSel.cursorOverride = highlightMode ? HIGHLIGHT_CURSOR : null;
      if (!highlightMode) scribe.scrollContainer.style.cursor = '';
      return;
    }
    if (!cursorStyleElem) {
      cursorStyleElem = document.createElement('style');
      document.head.appendChild(cursorStyleElem);
    }
    cursorStyleElem.textContent = highlightMode
      ? `.${rootClass} .scribe-word { cursor: ${HIGHLIGHT_CURSOR} !important; }`
      : '';
  }

  function applyToSelection() {
    const matchedWords = scribe.getWordsUnderTextSelection();
    if (matchedWords.length === 0 || !highlightColor) return false;
    // Recoloring an existing highlight is done from its own card, not by picking a color here.
    const fresh = matchedWords.filter((w) => !w.highlightColor);
    if (fresh.length > 0) applyHighlight(scribe, fresh, highlightColor, 0.5);
    scribe.clearTextSelection();
    return true;
  }

  highlightElem.addEventListener('click', () => {
    if (applyToSelection()) return;
    highlightMode = !highlightMode;
    highlightElem.classList.toggle('active', highlightMode);
    updateHighlightCursorStyle();
  });

  // Color-picker swatches and the popover that holds them, plus the factory that builds each swatch button.
  const colorBtnElems = [];
  /** @type {?HTMLSpanElement} */ let paletteElem = null;
  /** @type {?HTMLSpanElement} */ let caretElem = null;
  const closePalette = () => {
    if (paletteElem) paletteElem.classList.remove('open');
    if (caretElem) caretElem.classList.remove('active');
  };
  /** @param {string} color @returns {HTMLSpanElement} */
  const makeColorBtn = (color) => {
    const btn = document.createElement('span');
    btn.className = 'highlight-color-btn';
    btn.style.backgroundColor = color;
    if (color === highlightColor) btn.classList.add('active');
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      highlightColor = color;
      scribe._highlightColor = color;
      setTipColor(color);
      colorBtnElems.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      closePalette();
      // Choosing a color highlights the current selection if there is one, but never arms paint mode on its own (only the marker does that).
      applyToSelection();
    });
    return btn;
  };

  // The element placed in the toolbar: the split control when there is a palette, otherwise the bare marker.
  /** @type {HTMLSpanElement} */
  let toolbarElem = highlightElem;
  if (colors.length > 1) {
    const split = document.createElement('span');
    split.className = 'scribe-hl-split';
    highlightElem.classList.add('scribe-hl-mark');

    paletteElem = document.createElement('span');
    paletteElem.className = 'scribe-hl-pop';
    for (const color of colors) {
      const btn = makeColorBtn(color);
      colorBtnElems.push(btn);
      paletteElem.appendChild(btn);
    }

    // A slim caret (not a full icon button) so the dropdown half stays visually subordinate to the marker.
    caretElem = document.createElement('span');
    caretElem.className = 'cr-icon-button scribe-hl-caret';
    caretElem.title = 'Highlight color';
    caretElem.role = 'button';
    caretElem.tabIndex = 0;
    caretElem.ariaLabel = 'Choose highlight color';
    caretElem.innerHTML = HIGHLIGHT_CARET_SVG;
    caretElem.addEventListener('mousedown', (e) => e.preventDefault());
    caretElem.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = !paletteElem.classList.contains('open');
      paletteElem.classList.toggle('open', willOpen);
      caretElem.classList.toggle('active', willOpen);
    });

    split.append(highlightElem, caretElem, paletteElem);
    toolbarElem = split;
  }

  /** Refresh the on-page comment marks after a comment edit. */
  function updateCommentIcons() {
    if (!scribe.elem) return;
    const pages = new Set();
    for (const kw of scribe.getUiWords()) pages.add(kw.word.line.page.n);
    // Marks live in the highlight fill layer, so refreshing one means rebuilding that whole layer.
    for (const n of pages) scribe.renderHighlights(n);
  }

  /**
   * Wire the selection-driven highlighting, comment tooltip, and overlay observer.
   * Call after `scribe.init` (needs `scribe.elem`).
   * @returns {() => void} teardown
   */
  function installBehaviors() {
    const mouseupHandler = (event) => {
      if (!highlightMode) return;
      if (!(event.target instanceof Node) || !rootElem.contains(event.target)) return;
      applyToSelection();
    };
    document.addEventListener('mouseup', mouseupHandler);

    // Close the color palette on an outside click or Escape (only wired when the split button built a palette).
    const paletteOutsideClick = (event) => {
      if (!paletteElem || !paletteElem.classList.contains('open')) return;
      const t = event.target;
      if (t instanceof Node && (paletteElem.contains(t) || (caretElem && caretElem.contains(t)))) return;
      closePalette();
    };
    const paletteKeydown = (event) => {
      if (event.key !== 'Escape' || !paletteElem || !paletteElem.classList.contains('open')) return;
      // A consumed Escape is preventDefaulted, so the mode-exit handler leaves the active mode on.
      event.preventDefault();
      closePalette();
    };
    if (paletteElem) {
      document.addEventListener('click', paletteOutsideClick);
      document.addEventListener('keydown', paletteKeydown);
    }

    // ---- Comment card: the one floating surface for a highlight or a note ----
    // Behaviors are delegated from the viewer root because marks are rebuilt with every fill-layer or notes-layer render.
    const editorHost = scribe.outerElem || scribe.elem;
    const cmtCard = document.createElement('div');
    cmtCard.className = 'scribe-cmt-card';
    // Focusable so the card can hold focus (keeping Esc-to-close alive) once a post folds the composer away.
    cmtCard.tabIndex = -1;
    cmtCard.style.display = 'none';
    const cmtQuoteRow = document.createElement('div');
    cmtQuoteRow.className = 'scribe-cmt-quote-row';
    const cmtBar = document.createElement('span');
    cmtBar.className = 'scribe-cm-bar';
    const cmtQuote = document.createElement('span');
    cmtQuote.className = 'scribe-cmt-quote';
    cmtQuoteRow.append(cmtBar, cmtQuote);
    const cmtThread = document.createElement('div');
    cmtThread.className = 'scribe-cmt-thread';
    // Count line standing in for the messages a preview collapses (all but the root and the latest).
    const cmtMore = document.createElement('div');
    cmtMore.className = 'scribe-cmt-more';
    // The composer is the card's one writing surface: the root comment when none exists yet,
    // otherwise a reply appended to the thread.
    const cmtReply = document.createElement('div');
    cmtReply.className = 'scribe-cmt-reply';
    const cmtReplyAva = document.createElement('span');
    cmtReplyAva.className = 'scribe-cm-ava';
    const cmtText = document.createElement('textarea');
    cmtText.className = 'scribe-cmt-text';
    cmtText.rows = 1;
    cmtText.setAttribute('aria-label', 'Comment text');
    cmtReply.append(cmtReplyAva, cmtText);
    const cmtReplyBtn = document.createElement('button');
    cmtReplyBtn.type = 'button';
    cmtReplyBtn.className = 'scribe-cmt-reply-btn';
    cmtReplyBtn.textContent = 'Reply';

    /**
     * @param {string} title
     * @param {string} svg
     * @returns {HTMLButtonElement}
     */
    const makeHdButton = (title, svg) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'scribe-cmt-vb';
      btn.title = title;
      btn.setAttribute('aria-label', title);
      btn.innerHTML = svg;
      return btn;
    };
    const cmtPanelBtn = makeHdButton('Show in comments panel', TB_PANEL_SVG);
    // The class lets CSS hide the panel verb on phones.
    cmtPanelBtn.classList.add('scribe-cmt-vb-panel');
    const cmtDelete = makeHdButton('Delete highlight', TB_DELETE_SVG);
    cmtDelete.classList.add('scribe-cmt-vb-del');
    const cmtHdVerbs = document.createElement('span');
    cmtHdVerbs.className = 'scribe-cmt-hd-verbs';
    cmtHdVerbs.append(cmtPanelBtn, cmtDelete);
    cmtQuoteRow.appendChild(cmtHdVerbs);

    // The quote bar doubles as the recolor control: activating it opens the swatch shelf.
    cmtBar.setAttribute('aria-label', 'Highlight color');
    cmtBar.setAttribute('aria-expanded', 'false');
    const cmtShelf = document.createElement('div');
    cmtShelf.className = 'scribe-cmt-shelf';
    /** @type {Array<HTMLButtonElement>} */
    const cmtSwatches = [];
    const shelfOpen = () => cmtShelf.classList.contains('open');
    const expandShelf = () => {
      cmtShelf.classList.add('open');
      cmtBar.setAttribute('aria-expanded', 'true');
      cmtSwatches.forEach((b) => { b.tabIndex = 0; });
    };
    const collapseShelf = () => {
      cmtShelf.classList.remove('open');
      cmtBar.setAttribute('aria-expanded', 'false');
      cmtSwatches.forEach((b) => { b.tabIndex = -1; });
    };
    /** @param {?HTMLButtonElement} sw */
    const markActiveSwatch = (sw) => { cmtSwatches.forEach((b) => b.classList.toggle('active', b === sw)); };
    // One extra "editorial red" swatch for line markups (underline/strikeout), a color the highlight palette deliberately lacks.
    // Hidden while the card serves a highlight.
    const MARKUP_RED = '#e53935';
    for (const color of [...colors, MARKUP_RED]) {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'highlight-color-btn';
      sw.style.backgroundColor = color;
      sw.dataset.color = color.toLowerCase();
      if (color === MARKUP_RED) sw.dataset.markupOnly = '1';
      sw.title = 'Recolor highlight';
      sw.setAttribute('aria-label', 'Recolor highlight');
      sw.tabIndex = -1;
      cmtSwatches.push(sw);
      cmtShelf.appendChild(sw);
    }
    cmtQuoteRow.appendChild(cmtShelf);
    cmtCard.append(cmtQuoteRow, cmtThread);
    editorHost.appendChild(cmtCard);

    /**
     * On a highlight target, `slot` selects the highlight fill (default) or the line markup (underline/strikeout) the card is editing.
     * @type {?({kind: 'highlight', slot?: ('highlight'|'line'), kw: import('../viewerWordObjects.js').UiOcrWord, groupId: ?string, n: number} | {kind: 'note', annot: Object, n: number})}
     */
    let cmtTarget = null;
    let cmtPinned = false;
    /** Whether the reply composer is unfolded on a thread that already has a root comment. */
    let cmtReplyOpen = false;
    /** @type {?ReturnType<typeof setTimeout>} */
    let cmtHideTimer = null;
    /** Ink edges marking the pinned highlight (element set owned by the card). */
    /** @type {Array<HTMLElement>} */
    let cmtEdges = [];
    /** The message text element currently editable in place, and its value at edit start. */
    /** @type {?HTMLElement} */
    let cmtEditEl = null;
    let cmtEditOrig = '';
    /** @type {?() => void} */
    let cmtDragEnd = null;

    const cmtGrow = () => { cmtText.style.height = 'auto'; cmtText.style.height = `${cmtText.scrollHeight}px`; };

    /** The model annotation behind a card target (a group annot for highlights, the note itself). */
    const cmtAnnot = (target) => {
      if (target.kind === 'note') return target.annot;
      if (!target.groupId) return null;
      return (scribe.doc.annotations.pages[target.n] || [])
        .find((a) => (target.slot === 'line'
          ? a.type === 'underline' || a.type === 'strikeout'
          : !a.type || a.type === 'highlight') && a.groupId === target.groupId) || null;
    };

    /** The on-page mark element for a card target (marks are rebuilt per render, so always re-query). */
    const cmtMarkEl = (target) => {
      if (target.kind === 'highlight') {
        if (!target.groupId) return null;
        return scribe.elem.querySelector(`.scribe-hl-cmark[data-group-id="${target.groupId}"]`);
      }
      const idx = (scribe.doc.annotations.pages[target.n] || []).filter((a) => a.type === 'text').indexOf(target.annot);
      const group = scribe.getNotesGroup(target.n);
      return group ? group.querySelector(`.scribe-note-icon[data-note-idx="${idx}"]`) : null;
    };

    /** The pinned highlight's fill bands (group bands, else the clicked word's own band). */
    const cmtBands = () => {
      if (!cmtTarget || cmtTarget.kind !== 'highlight') return [];
      const { kw, groupId, n } = cmtTarget;
      if (groupId) {
        const map = scribe._highlightRectsByGroup[n];
        const arr = map && map.get(groupId);
        if (arr && arr.length > 0) return arr;
      }
      const rect = cmtTarget.slot === 'line' ? kw.markupRectElem : kw.highlightRectElem;
      return rect ? [rect] : [];
    };

    /** Ink-edge the pinned highlight's bands (the selected-object telltale the old card had). */
    const setCmtSel = (on) => {
      for (const el of cmtEdges) el.remove();
      cmtEdges = on ? createInkEdges(cmtBands()) : [];
    };

    const initialsOf = (name) => name.split(/\s+/, 2).map((p) => p[0]).join('').toUpperCase();

    /**
     * One thread message.
     * @param {string} idx - 'root' or the reply index, for edit commits.
     */
    const makeMsg = (idx, text, author, createdAt) => {
      const msg = document.createElement('div');
      msg.className = 'scribe-cmt-msg';
      msg.dataset.reply = idx;
      if (author) {
        const meta = document.createElement('div');
        meta.className = 'scribe-cmt-meta';
        const ava = document.createElement('span');
        ava.className = 'scribe-cm-ava';
        ava.textContent = initialsOf(author);
        const who = document.createElement('span');
        who.className = 'scribe-cm-who';
        who.textContent = author;
        meta.append(ava, who);
        msg.appendChild(meta);
      }
      const mtext = document.createElement('div');
      mtext.className = 'scribe-cmt-mtext';
      mtext.textContent = text;
      msg.appendChild(mtext);
      if (createdAt) {
        const foot = document.createElement('div');
        foot.className = 'scribe-cmt-foot';
        const when = document.createElement('span');
        when.className = 'scribe-cm-when';
        setTimestamp(when, createdAt);
        foot.appendChild(when);
        msg.appendChild(foot);
      }
      return msg;
    };

    const renderThread = (annot, kind) => {
      cmtEditEl = null;
      cmtThread.replaceChildren();
      const msgs = [];
      if (annot && annot.comment) msgs.push(makeMsg('root', annot.comment, annot.author || '', annot.createdAt || ''));
      const replies = (annot && annot.replies) || [];
      replies.forEach((r, i) => msgs.push(makeMsg(String(i), r.text, r.author || '', r.createdAt || '')));
      if (msgs.length) {
        const last = msgs[msgs.length - 1];
        let foot = last.querySelector('.scribe-cmt-foot');
        if (!foot) {
          foot = document.createElement('div');
          foot.className = 'scribe-cmt-foot';
          last.appendChild(foot);
        }
        foot.appendChild(cmtReplyBtn);
      }
      // Unpinned previews show the root and the latest reply; the rest collapse to a count line.
      if (msgs.length > 2) {
        for (let i = 1; i < msgs.length - 1; i++) msgs[i].classList.add('scribe-cmt-old');
        const hidden = msgs.length - 2;
        cmtMore.textContent = `${hidden} earlier ${hidden === 1 ? 'reply' : 'replies'}`;
        msgs.splice(1, 0, cmtMore);
      }
      for (const m of msgs) cmtThread.appendChild(m);
      const author = scribe.opt.commentAuthor || '';
      cmtReplyAva.textContent = initialsOf(author);
      cmtReplyAva.style.display = author ? '' : 'none';
      const hasRoot = !!(annot && annot.comment);
      if (hasRoot) cmtText.placeholder = 'Reply…';
      else cmtText.placeholder = kind === 'note' ? 'Add a note…' : 'Add a comment…';
      cmtText.value = '';
      if (!hasRoot || cmtReplyOpen) cmtThread.appendChild(cmtReply);
      cmtGrow();
    };

    const cmtFill = (target) => {
      const annot = cmtAnnot(target);
      if (target.kind === 'highlight') {
        const isLine = target.slot === 'line';
        cmtQuote.textContent = target.groupId
          ? scribe.getUiWords().filter((w) => (isLine ? w.markupGroupId : w.highlightGroupId) === target.groupId).map((w) => w.word.text).join(' ')
          : target.kw.word.text;
        const color = (annot && annot.color) || (isLine ? target.kw.markupColor : target.kw.highlightColor) || '';
        cmtBar.style.background = color;
        // Arm the bar as the recolor control.
        cmtBar.classList.add('scribe-cmt-bar-ctl');
        cmtBar.setAttribute('role', 'button');
        cmtBar.tabIndex = 0;
        cmtBar.title = 'Highlight color';
        for (const b of cmtSwatches) {
          if (b.dataset.markupOnly) b.style.display = isLine ? '' : 'none';
        }
        const currentSw = cmtSwatches.find((b) => b.dataset.color === color.toLowerCase() && (!b.dataset.markupOnly || isLine));
        // A colour outside the palette (an imported highlight) marks nothing active.
        markActiveSwatch(currentSw || null);
        const verb = isLine
          ? (((annot && annot.type) || target.kw.markupType) === 'strikeout' ? 'Delete strikethrough' : 'Delete underline')
          : 'Delete highlight';
        cmtDelete.title = verb;
        cmtDelete.setAttribute('aria-label', verb);
      } else {
        cmtQuote.textContent = `note · page ${target.n + 1}`;
        cmtBar.style.background = 'var(--scribe-note)';
        // Notes have no color to edit: the bar is a plain marker, never a control.
        collapseShelf();
        cmtBar.classList.remove('scribe-cmt-bar-ctl');
        cmtBar.removeAttribute('role');
        cmtBar.tabIndex = -1;
        cmtBar.removeAttribute('title');
        cmtDelete.title = 'Delete note';
        cmtDelete.setAttribute('aria-label', 'Delete note');
      }
      // The panel verb needs the host's reveal hook.
      cmtPanelBtn.style.display = scribe._revealCommentInPanel ? '' : 'none';
      renderThread(annot, target.kind);
    };

    /**
     * Place the card in the first region that lands wholly inside the document area: below, above, right, then left of the anchor.
     * When none of the four fits, the card is clamped into that area and covers the text as a last resort.
     * @returns {boolean} false when the anchor has no on-screen rects, leaving the card unplaced.
     */
    const cmtPlace = (target) => {
      // A highlight's comment mark is left out of the geometry: it appears only once a comment is posted,
      // so including it would jump the card the moment the writer commits a line.
      const noteMark = target.kind === 'highlight' ? null : cmtMarkEl(target);
      const rects = noteMark ? [noteMark.getBoundingClientRect()] : cmtBands().map((b) => b.getBoundingClientRect());
      if (rects.length === 0) return false;
      // Every band is kept clear, not just the last line, so a multi-line group is never straddled.
      const anchor = rects[rects.length - 1];
      const clearLeft = Math.min(...rects.map((r) => r.left));
      const clearRight = Math.max(...rects.map((r) => r.right));
      const clearTop = Math.min(...rects.map((r) => r.top));
      const clearBottom = Math.max(...rects.map((r) => r.bottom));

      cmtCard.style.display = '';
      cmtCard.style.visibility = 'hidden';
      cmtGrow();
      // Zero the offsets first so `base` is the card's real coordinate origin: the host is not the containing block when it is position:static.
      cmtCard.style.left = '0px';
      cmtCard.style.top = '0px';
      const base = cmtCard.getBoundingClientRect();
      const cw = cmtCard.offsetWidth;
      const ch = cmtCard.offsetHeight;
      // Bound by the scrolling document area, not the viewer root, which spans the sidebar too.
      const view = (scribe.scrollContainer || editorHost).getBoundingClientRect();
      const minX = view.left + 4;
      const maxX = view.right - cw - 4;
      const minY = view.top + 4;
      const maxY = view.bottom - ch - 4;
      const x = Math.max(minX, Math.min(anchor.left - 10, maxX));
      const y = Math.max(minY, Math.min(clearTop, maxY));
      // Each spot already clears the anchor on one axis by construction, so fitting inside `view` is the only test.
      const spots = [
        { left: x, top: clearBottom + 6 },
        { left: x, top: clearTop - ch - 6 },
        { left: clearRight + 6, top: y },
        { left: clearLeft - cw - 6, top: y },
      ];
      const spot = spots.find((s) => s.left >= minX && s.left <= maxX && s.top >= minY && s.top <= maxY)
        || { left: x, top: Math.max(minY, Math.min(clearBottom + 6, maxY)) };
      cmtCard.style.left = `${spot.left - base.left}px`;
      cmtCard.style.top = `${spot.top - base.top}px`;
      cmtCard.style.visibility = '';
      return true;
    };

    const cmtSameTarget = (a, b) => !!a && !!b && a.kind === b.kind
      && (a.kind === 'highlight'
        ? (a.slot || 'highlight') === (b.slot || 'highlight') && a.groupId === b.groupId && (a.groupId || a.kw === b.kw)
        : a.annot === b.annot);

    // ---- in-place message editing (authorship is a label, not a permission) ----
    const endMsgEdit = () => {
      if (!cmtEditEl) return;
      cmtEditEl.contentEditable = 'false';
      cmtEditEl.classList.remove('editing');
      cmtEditEl = null;
    };
    const cancelMsgEdit = () => {
      if (!cmtEditEl) return;
      cmtEditEl.textContent = cmtEditOrig;
      endMsgEdit();
    };
    /** Write the edited message back to the model. Returns whether anything changed. */
    const commitMsgEdit = () => {
      if (!cmtEditEl || !cmtTarget) return false;
      const el = cmtEditEl;
      const next = (el.textContent || '').trim();
      endMsgEdit();
      if (next === cmtEditOrig.trim()) return false;
      const annot = cmtAnnot(cmtTarget);
      if (!annot) return false;
      const msg = el.closest('.scribe-cmt-msg');
      const idx = msg instanceof HTMLElement ? msg.dataset.reply : null;
      if (idx === 'root') {
        // Clearing the root takes the replies with it, and dismissal commits an emptied field unprompted, so revert instead of reading it as a delete.
        if (!next && annot.replies && annot.replies.length > 0) {
          el.textContent = cmtEditOrig;
          return false;
        }
        applyRootComment(cmtTarget, next);
      } else if (idx != null) {
        const replies = (annot.replies || []).slice();
        const i = Number(idx);
        if (!next) replies.splice(i, 1);
        else replies[i] = { ...replies[i], text: next };
        applyReplies(cmtTarget, replies);
      }
      return true;
    };
    const beginMsgEdit = (mtextEl) => {
      if (cmtEditEl === mtextEl) return;
      if (commitMsgEdit()) {
        if (scribe._rebuildCommentsPanel) scribe._rebuildCommentsPanel();
        updateCommentIcons();
      }
      cmtEditEl = mtextEl;
      cmtEditOrig = mtextEl.textContent || '';
      mtextEl.contentEditable = 'true';
      mtextEl.classList.add('editing');
      mtextEl.focus();
    };

    const applyRootComment = (target, text) => {
      if (target.kind === 'highlight') scribe.modifyHighlightComment([target.kw], text, target.slot || 'highlight');
      else setNoteComment(scribe, target.annot, text);
    };
    const applyReplies = (target, replies) => {
      if (target.kind === 'highlight') {
        setHighlightReplies(scribe, target.kw, replies, target.slot || 'highlight');
      } else if (replies.length > 0) {
        target.annot.replies = replies;
      } else {
        delete target.annot.replies;
      }
    };

    /** Post the composer's draft: the root comment when none exists, otherwise a new reply. */
    const postComposer = () => {
      if (!cmtTarget) return false;
      const text = cmtText.value.trim();
      if (!text) return false;
      cmtText.value = '';
      const annot = cmtAnnot(cmtTarget);
      if (!annot || !annot.comment) {
        applyRootComment(cmtTarget, text);
        return true;
      }
      /** @type {AnnotationReply} */
      const reply = { text, createdAt: new Date().toISOString() };
      const author = scribe.opt.commentAuthor || '';
      if (author) reply.author = author;
      applyReplies(cmtTarget, [...(annot.replies || []), reply]);
      return true;
    };

    /** Dismissal commits: any in-place message edit, then any composer draft. */
    const cmtCommit = () => {
      if (!cmtTarget) return false;
      const edited = commitMsgEdit();
      const posted = postComposer();
      if (edited || posted) {
        if (scribe._rebuildCommentsPanel) scribe._rebuildCommentsPanel();
        updateCommentIcons();
      }
      return edited || posted;
    };

    const cmtClose = () => {
      cancelMsgEdit();
      cmtCard.style.display = 'none';
      cmtCard.classList.remove('pinned');
      cmtPinned = false;
      cmtReplyOpen = false;
      cmtTarget = null;
      collapseShelf();
      setCmtSel(false);
    };

    const cmtShow = (target) => {
      if (cmtHideTimer) { clearTimeout(cmtHideTimer); cmtHideTimer = null; }
      if (cmtPinned) return; // an edit in progress owns the card
      if (cmtSameTarget(cmtTarget, target) && cmtCard.style.display !== 'none') return;
      cmtTarget = target;
      cmtFill(target);
      if (!cmtPlace(target)) cmtClose();
    };

    const cmtScheduleHide = () => {
      if (cmtPinned) return;
      if (cmtHideTimer) clearTimeout(cmtHideTimer);
      // A short grace corridor so the pointer can travel from the mark into the card.
      cmtHideTimer = setTimeout(() => { cmtHideTimer = null; if (!cmtPinned) cmtClose(); }, 160);
    };

    const cmtPin = (target) => {
      if (cmtHideTimer) { clearTimeout(cmtHideTimer); cmtHideTimer = null; }
      if (cmtPinned && cmtSameTarget(cmtTarget, target)) {
        if (cmtReply.isConnected) cmtText.focus(); else cmtCard.focus();
        return;
      }
      cmtPinned = false;
      cmtReplyOpen = false;
      cmtTarget = target;
      cmtFill(target);
      // Pin the class before placing: the composer and footer only lay out on the pinned card,
      // so measuring first would size and place the card from the preview's geometry.
      cmtCard.classList.add('pinned');
      if (!cmtPlace(target)) { cmtClose(); return; }
      cmtPinned = true;
      setCmtSel(true);
      // Focus last so it cannot scroll the container before the card is positioned.
      if (cmtReply.isConnected) cmtText.focus(); else cmtCard.focus();
    };

    /**
     * The highlighted word under an event's pointer.
     * @param {MouseEvent} event
     */
    const highlightWordAt = (event) => {
      // The custom engine has no word spans, so hit-test the highlight by page geometry rather than event.target.
      if (scribe.useCustomSelection) return scribe.textSel.hitTestHighlight(event.clientX, event.clientY)?.kw ?? null;
      const wordEl = /** @type {Element} */ (event.target).closest('.scribe-word');
      return wordEl ? /** @type {any} */ (wordEl)._scribeObj : null;
    };

    /** Resolve the card target under an event: a comment mark, a note mark, or a commented word. */
    const cmtTargetFromEvent = (event) => {
      if (!(event.target instanceof Element)) return null;
      const mark = event.target.closest('.scribe-hl-cmark');
      if (mark) {
        const kw = scribe.getUiWords().find((w) => w.highlightGroupId === mark.dataset.groupId);
        if (kw) {
          return {
            kind: 'highlight', slot: 'highlight', kw, groupId: kw.highlightGroupId, n: kw.word.line.page.n,
          };
        }
        const mkw = scribe.getUiWords().find((w) => w.markupGroupId === mark.dataset.groupId);
        return mkw ? {
          kind: 'highlight', slot: 'line', kw: mkw, groupId: mkw.markupGroupId, n: mkw.word.line.page.n,
        } : null;
      }
      const noteEl = event.target.closest('.scribe-note-icon');
      if (noteEl) {
        const n = Number(noteEl.dataset.pageN);
        const annot = (scribe.doc.annotations.pages[n] || []).filter((a) => a.type === 'text')[Number(noteEl.dataset.noteIdx)];
        return annot ? { kind: 'note', annot, n } : null;
      }
      const kw = highlightWordAt(event);
      if (kw && kw.highlightGroupId && kw.highlightComment) {
        return {
          kind: 'highlight', slot: 'highlight', kw, groupId: kw.highlightGroupId, n: kw.word.line.page.n,
        };
      }
      if (kw && kw.markupGroupId && kw.markupComment) {
        return {
          kind: 'highlight', slot: 'line', kw, groupId: kw.markupGroupId, n: kw.word.line.page.n,
        };
      }
      return null;
    };

    const cmtOver = (event) => { const t = cmtTargetFromEvent(event); if (t) cmtShow(t); };
    const cmtOut = (event) => { if (cmtTargetFromEvent(event)) cmtScheduleHide(); };
    // With no word spans, the pointer crosses no element boundary over the text,
    // so a hovered commented highlight must be sampled on pointer move rather than delegated from mouseover.
    let cmtMoveRaf = null;
    const cmtMove = (event) => {
      if (cmtMoveRaf !== null) return;
      const { clientX, clientY, target } = event;
      cmtMoveRaf = requestAnimationFrame(() => {
        cmtMoveRaf = null;
        const t = cmtTargetFromEvent({ clientX, clientY, target });
        if (t) cmtShow(t);
        else if (cmtTarget && cmtTarget.kind === 'highlight') cmtScheduleHide();
      });
    };
    const cmtPress = (event) => {
      if (!(event.target instanceof Element)) return;
      const el = event.target.closest('.scribe-hl-cmark, .scribe-note-icon');
      if (el) {
        // The click that ends a note-mark drag must not open the editor.
        if (/** @type {HTMLElement} */ (el).dataset.dragged === '1') { /** @type {HTMLElement} */ (el).dataset.dragged = ''; return; }
        event.stopPropagation();
        const t = cmtTargetFromEvent(event);
        if (t) cmtPin(t);
        return;
      }
      // Gate on the color, not the comment: the card's footer is the only place to recolor or delete an uncommented highlight.
      const kw = highlightWordAt(event);
      if (!kw || (!kw.highlightColor && !kw.markupType)) return;
      // A drag that leaves a text selection is a selection gesture, not a click on the object.
      if (scribe.hasTextSelection()) return;
      event.stopPropagation();
      // A word carrying both a fill and a line markup pins as the fill (the whole word is one target).
      const slot = kw.highlightColor ? 'highlight' : 'line';
      // A tap gets the action callout on the mark instead. Its Comment verb opens this same card.
      if (scribe._lastPrimaryPointerType === 'touch' && scribe._touchCalloutShow) {
        scribe._touchCalloutShow('markup', kw, slot);
        return;
      }
      cmtPin({
        kind: 'highlight', slot, kw, groupId: (slot === 'highlight' ? kw.highlightGroupId : kw.markupGroupId) || null, n: kw.word.line.page.n,
      });
    };
    const cmtKeyPin = (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (!(event.target instanceof Element) || !event.target.closest('.scribe-hl-cmark, .scribe-note-icon')) return;
      const t = cmtTargetFromEvent(event);
      if (!t) return;
      event.preventDefault();
      cmtPin(t);
    };
    scribe.elem.addEventListener('mouseover', cmtOver);
    scribe.elem.addEventListener('mouseout', cmtOut);
    if (scribe.useCustomSelection) scribe.elem.addEventListener('mousemove', cmtMove);
    scribe.elem.addEventListener('click', cmtPress);
    scribe.elem.addEventListener('focusin', cmtOver);
    scribe.elem.addEventListener('focusout', cmtOut);
    scribe.elem.addEventListener('keydown', cmtKeyPin);

    cmtCard.addEventListener('mouseenter', () => { if (cmtHideTimer) { clearTimeout(cmtHideTimer); cmtHideTimer = null; } });
    cmtCard.addEventListener('mouseleave', cmtScheduleHide);
    cmtCard.addEventListener('mousedown', (e) => e.stopPropagation());
    cmtCard.addEventListener('click', (e) => {
      e.stopPropagation();
      // An open swatch shelf folds when the click lands anywhere else on the card.
      if (shelfOpen() && !(e.target instanceof Node && (cmtShelf.contains(e.target) || cmtBar.contains(e.target)))) collapseShelf();
      // Clicking the preview is the pointer's "edit this" on the card itself, same as clicking the mark.
      if (!cmtPinned && cmtTarget) { cmtPin(cmtTarget); return; }
      const mtext = e.target instanceof Element && e.target.closest('.scribe-cmt-mtext');
      if (mtext instanceof HTMLElement && cmtPinned) beginMsgEdit(mtext);
    });
    cmtText.addEventListener('input', cmtGrow);
    cmtReplyBtn.addEventListener('click', () => {
      if (!cmtPinned || !cmtTarget) return;
      if (commitMsgEdit()) {
        if (scribe._rebuildCommentsPanel) scribe._rebuildCommentsPanel();
        updateCommentIcons();
      }
      cmtReplyOpen = true;
      cmtFill(cmtTarget);
      cmtText.focus();
    });
    cmtCard.addEventListener('keydown', (e) => {
      // Keep typing out of page shortcuts.
      e.stopPropagation();
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        // Do not re-place after the re-render: the card grows in place, as it already does while typing grows the field.
        e.preventDefault();
        if (cmtCommit() && cmtTarget) {
          cmtReplyOpen = false;
          cmtFill(cmtTarget);
          cmtCard.focus();
        }
        return;
      }
      if (e.key !== 'Escape') return;
      if (shelfOpen()) { collapseShelf(); return; }
      if (cmtEditEl) { cancelMsgEdit(); return; }
      if (cmtText.value.trim()) { cmtText.value = ''; cmtGrow(); return; }
      if (cmtReplyOpen && cmtTarget) {
        cmtReplyOpen = false;
        cmtFill(cmtTarget);
        cmtCard.focus();
        return;
      }
      const markEl = cmtTarget && cmtMarkEl(cmtTarget);
      // Focus the mark before closing, not after: once the card is unpinned the mark's focusin would re-show it as a preview.
      if (markEl) /** @type {HTMLElement} */ (markEl).focus();
      cmtClose();
    });

    // The quote row drags the card.
    cmtQuoteRow.addEventListener('mousedown', (e) => {
      if (e.target instanceof Element && e.target.closest('.scribe-cmt-vb, .scribe-cm-bar, .scribe-cmt-shelf')) return;
      e.preventDefault();
      const r = cmtCard.getBoundingClientRect();
      // Bounded by the document area, as in cmtPlace, so a drag cannot park the card over the sidebar.
      const h = (scribe.scrollContainer || editorHost).getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      // Measured-origin correction, as in cmtPlace: the host may not be the containing block.
      cmtCard.style.left = '0px';
      cmtCard.style.top = '0px';
      const base = cmtCard.getBoundingClientRect();
      const move = (ev) => {
        const left = Math.max(h.left + 4, Math.min(ev.clientX - dx, h.right - r.width - 4));
        const top = Math.max(h.top + 4, Math.min(ev.clientY - dy, h.bottom - r.height - 4));
        cmtCard.style.left = `${left - base.left}px`;
        cmtCard.style.top = `${top - base.top}px`;
      };
      move(e);
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        cmtDragEnd = null;
      };
      cmtDragEnd = up;
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    // The pinned check keeps the preview inert: hover cards show content, never controls.
    const cmtBarToggle = () => {
      if (!cmtPinned || !cmtTarget || cmtTarget.kind !== 'highlight') return;
      if (shelfOpen()) collapseShelf();
      else expandShelf();
    };
    cmtBar.addEventListener('click', (e) => {
      e.stopPropagation();
      cmtBarToggle();
    });
    cmtBar.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      cmtBarToggle();
    });
    cmtShelf.addEventListener('click', (e) => {
      e.stopPropagation();
      const sw = e.target instanceof Element
        ? /** @type {?HTMLButtonElement} */ (e.target.closest('.highlight-color-btn')) : null;
      if (sw && cmtTarget && cmtTarget.kind === 'highlight') {
        const color = /** @type {string} */ (sw.dataset.color);
        setCmtSel(false);
        recolorHighlightGroup(scribe, cmtTarget.kw, color, cmtTarget.slot || 'highlight');
        // The recolor rebuilt the fill layer, so re-ink the fresh bands and recolor the quote bar.
        setCmtSel(true);
        cmtBar.style.background = color;
        markActiveSwatch(sw);
        if (scribe._rebuildCommentsPanel) scribe._rebuildCommentsPanel();
      }
      collapseShelf();
    });
    cmtPanelBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!cmtTarget || !scribe._revealCommentInPanel) return;
      const t = cmtTarget;
      scribe._revealCommentInPanel(t.kind === 'highlight' ? t.kw : t.annot);
      // Opening the sidebar tweens the document inset, shifting the anchor under the still-open card.
      // Once that settles, follow the anchor to its new spot.
      setTimeout(() => { if (cmtTarget === t && cmtPinned) cmtPlace(t); }, 230);
    });
    cmtDelete.addEventListener('click', (e) => {
      e.stopPropagation();
      const t = cmtTarget;
      cmtClose();
      if (!t) return;
      if (t.kind === 'highlight') {
        removeHighlightGroup(scribe, t.kw, t.slot || 'highlight');
      } else {
        removeNote(scribe, t.annot, t.n);
        scribe.renderNotes(t.n);
      }
      updateCommentIcons();
      if (scribe._rebuildCommentsPanel) scribe._rebuildCommentsPanel();
    });

    // Capture phase, so the commit lands before the press can pin another card or start a selection.
    const cmtOutsidePress = (event) => {
      if (!cmtPinned) return;
      if (event.target instanceof Node && cmtCard.contains(event.target)) return;
      cmtCommit();
      cmtClose();
    };
    document.addEventListener('pointerdown', cmtOutsidePress, true);
    // Double-click starts word text editing (editor build), so the card must not sit over the input.
    const cmtDblclick = (event) => {
      if (event.target instanceof Node && scribe.elem.contains(event.target) && !cmtCard.contains(event.target)) {
        cmtCommit();
        cmtClose();
      }
    };
    document.addEventListener('dblclick', cmtDblclick);
    // The card is anchored to a screen position, so close it as soon as the page moves under it.
    const cmtScrollDismiss = (event) => {
      if (cmtCard.style.display === 'none') return;
      if (event.target instanceof Node && cmtCard.contains(event.target)) return;
      if (cmtPinned) cmtCommit();
      cmtClose();
    };
    scribe.scrollContainer?.addEventListener('scroll', cmtScrollDismiss, { passive: true });
    document.addEventListener('wheel', cmtScrollDismiss, { passive: true, capture: true });

    openCommentEditor = (words) => {
      if (!words || words.length === 0) return;
      const first = words[0];
      // Prefer the fill, as click-to-pin does; target the line markup only when the word has no fill.
      const slot = first.highlightColor ? 'highlight' : (first.markupType ? 'line' : 'highlight');
      cmtPin({
        kind: 'highlight', slot, kw: first, groupId: (slot === 'highlight' ? first.highlightGroupId : first.markupGroupId) || null, n: first.word.line.page.n,
      });
    };
    scribe._openCommentEditor = openCommentEditor;
    // Let other surfaces (the Comments panel) refresh the on-page comment marks after editing a comment.
    scribe._updateCommentIcons = updateCommentIcons;
    // A freestanding note is edited in its comment card, so opening its editor pins that card.
    scribe._openNoteEditor = (annot, pageIndex) => focusNoteEditor(scribe, pageIndex, annot);

    // Notes' single editor entry (the Comments panel, focusNoteEditor) pins the card.
    scribe._pinNoteCard = (annot, n) => cmtPin({ kind: 'note', annot, n });

    const isWordOrLine = (n) => n instanceof HTMLElement
      && (n.classList.contains('scribe-word') || n.classList.contains('scribe-line'));
    const commentObserver = new MutationObserver((mutations) => {
      const hasRemoved = mutations.some((m) => [...m.removedNodes].some(isWordOrLine));
      if (!hasRemoved) return;
      // The removed words were only anchors, so an in-flight edit still has live model objects to commit to.
      if (cmtPinned) cmtCommit();
      cmtClose();
    });
    commentObserver.observe(scribe.elem, { childList: true });

    return () => {
      document.removeEventListener('mouseup', mouseupHandler);
      if (paletteElem) {
        document.removeEventListener('click', paletteOutsideClick);
        document.removeEventListener('keydown', paletteKeydown);
      }
      commentObserver.disconnect();
      scribe.elem.removeEventListener('mouseover', cmtOver);
      scribe.elem.removeEventListener('mouseout', cmtOut);
      scribe.elem.removeEventListener('mousemove', cmtMove);
      scribe.elem.removeEventListener('click', cmtPress);
      scribe.elem.removeEventListener('focusin', cmtOver);
      scribe.elem.removeEventListener('focusout', cmtOut);
      scribe.elem.removeEventListener('keydown', cmtKeyPin);
      document.removeEventListener('pointerdown', cmtOutsidePress, true);
      document.removeEventListener('wheel', cmtScrollDismiss, true);
      scribe.scrollContainer?.removeEventListener('scroll', cmtScrollDismiss);
      if (cmtHideTimer) clearTimeout(cmtHideTimer);
      if (cmtDragEnd) cmtDragEnd();
      if (cmtCard.parentNode) cmtCard.parentNode.removeChild(cmtCard);
      scribe._pinNoteCard = null;
      document.removeEventListener('dblclick', cmtDblclick);
      scribe._openCommentEditor = null;
      scribe._openNoteEditor = null;
      scribe._updateCommentIcons = null;
      openCommentEditor = null;
      if (cursorStyleElem) {
        cursorStyleElem.remove();
        cursorStyleElem = null;
      }
    };
  }

  return {
    highlightElem,
    toolbarElem,
    updateCommentIcons,
    installBehaviors,
  };
}

// Lines of text with one struck through by a solid redaction bar.
// eslint-disable-next-line max-len
const REDACT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5h16M4 18.5h10"/><rect x="4" y="9.2" width="16" height="5.6" rx="1" fill="currentColor" stroke="none"/></svg>';

/**
 * Build the redact tool: a toggle button that marks content for destructive removal at export.
 * While armed, releasing a text selection marks its words; dragging a non-text area (or Alt+drag anywhere) draws a region mark for images and figures.
 * @param {import('../../viewer.js').ScribeViewer} scribe
 * @param {HTMLElement} rootElem - The app's root element (for selection scope).
 * @param {object} cfg
 * @param {(marksAdded: number) => void} [cfg.onMark] - Called after each marking gesture.
 * @returns {{ toolbarElem: HTMLSpanElement, installBehaviors: () => (() => void) }}
 */
export function createRedactTool(scribe, rootElem, { onMark } = {}) {
  let redactMode = false;
  // The context menu's "Redact" item is gated on the tool being present.
  scribe._redactEnabled = true;

  const toolbarElem = makeIconButton('Redact', REDACT_SVG);

  function updateRedactCursor() {
    if (scribe.useCustomSelection && scribe.textSel) {
      scribe.textSel.cursorOverride = redactMode ? 'crosshair' : null;
      if (!redactMode) scribe.scrollContainer.style.cursor = '';
    } else if (scribe.scrollContainer) {
      scribe.scrollContainer.style.cursor = redactMode ? 'crosshair' : '';
    }
  }

  function applyToSelection() {
    const matchedWords = scribe.getWordsUnderTextSelection();
    if (matchedWords.length === 0) return false;
    const added = redactWords(scribe, matchedWords.map((kw) => kw.word));
    scribe.clearTextSelection();
    if (added > 0 && onMark) onMark(added);
    return true;
  }

  toolbarElem.addEventListener('click', () => {
    if (applyToSelection()) return;
    redactMode = !redactMode;
    toolbarElem.classList.toggle('active', redactMode);
    updateRedactCursor();
  });

  /**
   * Wire the selection-driven marking and the region box-draw.
   * Call after `scribe.init` (needs the scroll container).
   * @returns {() => void} teardown
   */
  function installBehaviors() {
    const mouseupHandler = (event) => {
      if (!redactMode) return;
      if (!(event.target instanceof Node) || !rootElem.contains(event.target)) return;
      applyToSelection();
    };
    document.addEventListener('mouseup', mouseupHandler);

    // Region box-draw in the capture phase, so it preempts the selection engine's own drag start.
    // Alt+drag co-opts the engine's Alt=rectangle convention; a plain drag on non-text also boxes, since the engine cannot start a drag there.
    /** @type {?{ n: number, x: number, y: number, preview: HTMLDivElement }} */
    let drag = null;
    const cancelDrag = () => {
      if (drag) drag.preview.remove();
      drag = null;
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointerup', onDragUp);
    };
    const onDragMove = (ev) => {
      if (!drag) return;
      const pt = scribe.clientToPage(ev.clientX, ev.clientY);
      const x1 = pt.n === drag.n ? pt.x : (pt.n > drag.n ? Infinity : -Infinity);
      const y1 = pt.n === drag.n ? pt.y : (pt.n > drag.n ? Infinity : -Infinity);
      const dims = scribe.doc.pageMetrics[drag.n]?.dims;
      const cx = Math.max(0, Math.min(dims ? dims.width : Infinity, x1));
      const cy = Math.max(0, Math.min(dims ? dims.height : Infinity, y1));
      drag.preview.style.left = `${Math.min(drag.x, cx)}px`;
      drag.preview.style.top = `${Math.min(drag.y, cy)}px`;
      drag.preview.style.width = `${Math.abs(cx - drag.x)}px`;
      drag.preview.style.height = `${Math.abs(cy - drag.y)}px`;
    };
    const onDragUp = () => {
      if (!drag) return;
      const { n } = drag;
      const left = parseFloat(drag.preview.style.left);
      const top = parseFloat(drag.preview.style.top);
      const width = parseFloat(drag.preview.style.width) || 0;
      const height = parseFloat(drag.preview.style.height) || 0;
      cancelDrag();
      // Ignore sub-4px page-unit twitches (an accidental click, not a box).
      if (width < 4 || height < 4) return;
      if (redactRegion(scribe, n, {
        left, top, right: left + width, bottom: top + height,
      }) && onMark) onMark(1);
    };
    const pointerdownHandler = (event) => {
      if (!redactMode || event.button !== 0) return;
      if (drag) cancelDrag();
      let overText = false;
      if (!event.altKey) {
        if (scribe.useCustomSelection && scribe.textSel) {
          overText = scribe.textSel.isOverText(event.clientX, event.clientY);
        } else if (event.target instanceof Element) {
          overText = !!event.target.closest('.scribe-word, .scribe-line');
        }
      }
      // Plain drag over text = normal selection (marked on mouseup); everything else = box.
      if (overText) return;
      event.stopPropagation();
      event.preventDefault();
      const pt = scribe.clientToPage(event.clientX, event.clientY);
      const group = scribe.getRedactionsGroup(pt.n);
      if (!group) return;
      const preview = document.createElement('div');
      preview.className = 'scribe-redact-preview';
      preview.style.left = `${pt.x}px`;
      preview.style.top = `${pt.y}px`;
      group.appendChild(preview);
      drag = {
        n: pt.n, x: pt.x, y: pt.y, preview,
      };
      window.addEventListener('pointermove', onDragMove);
      window.addEventListener('pointerup', onDragUp);
    };
    scribe.scrollContainer.addEventListener('pointerdown', pointerdownHandler, true);

    const keydownHandler = (event) => {
      if (event.key === 'Escape' && drag) cancelDrag();
    };
    document.addEventListener('keydown', keydownHandler);

    return () => {
      document.removeEventListener('mouseup', mouseupHandler);
      document.removeEventListener('keydown', keydownHandler);
      scribe.scrollContainer?.removeEventListener('pointerdown', pointerdownHandler, true);
      cancelDrag();
      if (scribe.textSel) scribe.textSel.cursorOverride = null;
    };
  }

  return { toolbarElem, installBehaviors };
}

/**
 * Build the upload drop zone overlay.
 * @param {object} cfg
 * @param {number} cfg.width - Zone width in px.
 * @param {number} cfg.height - Zone height in px.
 * @param {number} cfg.top - Zone top offset in px (below the toolbar).
 * @param {(files: File[]) => (void | Promise<void>)} cfg.onFiles - Called with all chosen/dropped files.
 * @returns {{ dropZone: HTMLDivElement, openFileInputElem: HTMLInputElement }}
 */
export function createDropZone({
  width, height, top, onFiles,
}) {
  const dropZone = document.createElement('div');
  dropZone.className = 'scribe-drop-zone';
  dropZone.style.zIndex = '8';
  dropZone.style.top = `${top}px`;
  dropZone.style.position = 'absolute';
  dropZone.style.height = `${height}px`;
  dropZone.style.width = `${width}px`;

  const icon = document.createElement('div');
  icon.className = 'scribe-drop-icon';
  icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';

  // The root's coarse-pointer class swaps in the touch wording: dragging a file is not a touch gesture.
  const title = document.createElement('div');
  title.className = 'scribe-drop-title';
  title.innerHTML = '<span class="scribe-drop-title-full">Drop a PDF to get started</span>'
    + '<span class="scribe-drop-title-touch">Open a PDF to get started</span>';

  // Hidden native input wrapped by the styled label, so clicking "Choose file" opens the picker.
  const openFileInputElem = document.createElement('input');
  openFileInputElem.type = 'file';
  openFileInputElem.multiple = true;
  openFileInputElem.style.display = 'none';

  const button = document.createElement('label');
  button.className = 'scribe-drop-btn';
  button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M3 7h6l2 2h10v9a2 2 0 0 1-2 2H3z"/></svg><span>Choose file</span>';
  button.appendChild(openFileInputElem);

  const hint = document.createElement('div');
  hint.className = 'scribe-drop-hint';
  hint.textContent = 'or drag a file anywhere';

  const content = document.createElement('div');
  content.className = 'scribe-drop-content';
  content.append(icon, title, button, hint);

  // Swapped in for `content` (via the `loading` class) while the dropped file opens, so the wait reads as progress.
  const loading = document.createElement('div');
  loading.className = 'scribe-drop-loading';
  loading.innerHTML = '<div class="scribe-drop-spinner"></div><div class="scribe-drop-loading-text">Opening…</div>';

  const region = document.createElement('div');
  region.className = 'scribe-drop-region';
  region.append(content, loading);
  dropZone.appendChild(region);

  openFileInputElem.addEventListener('change', async () => {
    if (!openFileInputElem.files || openFileInputElem.files.length === 0) return;
    dropZone.classList.add('loading');
    try {
      await onFiles([...openFileInputElem.files]);
    } finally {
      dropZone.classList.remove('loading');
    }
  });

  // Drag-enter/leave can fire repeatedly over child nodes; a counter keeps the highlight stable.
  let highlightActiveCt = 0;
  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    // This guard sits below preventDefault so a drop is always allowed here, since the zone is the app's primary way to open a file.
    if (!event.dataTransfer || ![...event.dataTransfer.types].includes('Files')) return;
    dropZone.classList.add('highlight');
    highlightActiveCt++;
  });

  dropZone.addEventListener('dragleave', (event) => {
    event.preventDefault();
    const highlightActiveCtNow = highlightActiveCt;
    setTimeout(() => {
      if (highlightActiveCtNow === highlightActiveCt) dropZone.classList.remove('highlight');
    }, 100);
  });

  dropZone.addEventListener('drop', async (event) => {
    event.preventDefault();
    const files = await filesFromDropEvent(event);
    if (files.length === 0) return;
    // Switch to the loading state as soon as the drop is accepted, since the page does not render for ~1s.
    dropZone.classList.remove('highlight');
    dropZone.classList.add('loading');
    try {
      await onFiles(files);
    } finally {
      dropZone.classList.remove('loading');
    }
  });

  return { dropZone, openFileInputElem };
}

/**
 * Open a `ScribeDoc` from any supported input.
 * Raw byte inputs (`ArrayBuffer`, `Uint8Array`, non-`File` `Blob`) are treated as PDFs.
 * `File` and path strings are sorted by extension.
 * @param {File | Blob | ArrayBuffer | Uint8Array | string} file
 * @param {Object} [options]
 * @param {boolean} [options.deferText] - Resolve as soon as the document is renderable, leaving text extraction running behind `doc.textReady` (see `importFiles`).
 *    For open-and-display paths only.
 *    Callers that read the document's text right after opening must leave this unset.
 * @param {boolean} [options.skipFontOpt] - Skip font optimization.
 *    Safe only for callers that read text and never render styled overlays.
 * @returns {Promise<import('../../../js/containers/scribeDoc.js').ScribeDoc>}
 */
export async function openDocumentFromFile(file, { deferText = false, skipFontOpt = false } = {}) {
  /** @type {Parameters<typeof scribeLib.openDocument>[0]} */
  let input;
  if (file instanceof ArrayBuffer) {
    input = { pdfFiles: [file] };
  } else if (typeof Uint8Array !== 'undefined' && file instanceof Uint8Array) {
    const ab = /** @type {ArrayBuffer} */ (file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
    input = { pdfFiles: [ab] };
  } else if (typeof File !== 'undefined' && file instanceof File) {
    input = [file];
  } else if (typeof Blob !== 'undefined' && file instanceof Blob) {
    input = { pdfFiles: [await file.arrayBuffer()] };
  } else if (typeof file === 'string') {
    input = [file];
  } else {
    throw new Error('openDocumentFromFile: input must be File, Blob, ArrayBuffer, Uint8Array, or a filesystem path string.');
  }

  const doc = await scribeLib.openDocument(input, (deferText || skipFontOpt) ? { deferText, skipFontOpt } : undefined);

  // A pure viewer never runs recognize(), so an image-based PDF's active (selectable) text layer would stay empty.
  // When nothing else has filled it, fall back to the PDF's own parsed text, copying each page's deskew angle so the text overlay aligns.
  // Reassign `textReady` to the chained promise so deferred waiters observe the post-fallback state.
  doc.textReady = doc.textReady.then((res) => {
    if (doc.ocr.pdf && !doc.ocr.active.some(Boolean)) {
      doc.ocr.active = doc.ocr.pdf;
      for (let i = 0; i < doc.ocr.pdf.length; i++) {
        if (doc.ocr.pdf[i] && doc.pageMetrics[i]) doc.pageMetrics[i].angle = doc.ocr.pdf[i].angle;
      }
    }
    return res;
  });
  if (!deferText) await doc.textReady;
  return doc;
}

// eslint-disable-next-line max-len
const EDIT_TEXT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5h16"/><path d="M4 10h9.5"/><path d="M4 14.5h5.5"/><path d="M16.6 9.4l3.6 3.6-7.2 7.2-4.3.7.7-4.3z"/></svg>';

/**
 * The "Edit Text" mode tool.
 * While the mode is active, lines of visible native PDF text are selectable objects that can be edited in place or deleted.
 * @param {import('../../viewer.js').ScribeViewer} scribe
 */
export function createEditTextTool(scribe) {
  let editMode = false;
  /** @type {?ReturnType<typeof createLineEditor>} */
  let editor = null;
  let clearBoxSelection = () => {};
  let renderModeBoxes = () => {};
  const toolbarElem = makeIconButton('Edit Text', EDIT_TEXT_SVG);
  toolbarElem.classList.add('cr-labeled-button');
  const toolbarLabelElem = document.createElement('span');
  toolbarLabelElem.className = 'cr-btn-label';
  toolbarLabelElem.textContent = 'Edit Text';
  toolbarElem.appendChild(toolbarLabelElem);

  const hoverElem = document.createElement('div');
  hoverElem.className = 'scribe-edit-text-hover';
  Object.assign(hoverElem.style, {
    position: 'absolute',
    border: 'calc(1.5px / var(--scribe-zoom, 1)) solid rgba(26, 115, 232, 0.75)',
    borderRadius: '2px',
    pointerEvents: 'none',
    boxSizing: 'border-box',
  });
  const hideHover = () => hoverElem.remove();

  /** @param {?import('../../../js/objects/ocrObjects.js').OcrLine} line */
  const lineEligible = (line) => {
    if (!line || line.words.length === 0) return false;
    const nt = nativeTextForPage(scribe.doc, line.page);
    return line.words.every((w) => !!nt[w.id]);
  };

  toolbarElem.addEventListener('click', () => {
    editMode = !editMode;
    scribe._editTextActive = editMode;
    toolbarElem.classList.toggle('active', editMode);
    if (scribe.textSel) scribe.textSel.cursorOverride = editMode ? 'default' : null;
    if (editMode) {
      scribe.clearTextSelection?.();
      renderModeBoxes();
    } else {
      hideHover();
      clearBoxSelection();
      editor?.commit().catch((e) => console.error('Edit Text: commit failed:', e));
    }
  });

  /**
   * Wire the mode's pointer and keyboard behaviors.
   * Call after `scribe.init` (needs the scroll container).
   * @returns {() => void} teardown
   */
  function installBehaviors() {
    /** @param {Array<number>} pages */
    const refreshPages = (pages) => {
      for (const n of new Set(pages)) {
        scribe.refreshPageRaster(n);
        scribe.renderWords(n);
        scribe.renderHighlights?.(n);
        if (scribe.textSel) {
          scribe.textSel.invalidatePage(n);
          scribe.textSel.renderPage(n);
        }
      }
      if (scribe.onEditCallback) scribe.onEditCallback();
      validateSelection();
      renderFrames();
    };

    /** @type {Set<import('../../../js/objects/ocrObjects.js').OcrLine>} */
    const selected = new Set();
    /** @type {Map<import('../../../js/objects/ocrObjects.js').OcrLine, HTMLDivElement>} */
    const frames = new Map();

    /**
     * The drawn box for a line, sized to its visible glyphs.
     * @param {import('../../../js/objects/ocrObjects.js').OcrLine} line
     * @param {{left: number, right: number, top: number, bottom: number}} lbox
     */
    const lineDrawBox = (line, lbox) => {
      const nt = nativeTextForPage(scribe.doc, line.page);
      const lineBase = line.bbox.bottom + (line.baseline?.[1] || 0);
      let top = Infinity;
      let bottom = -Infinity;
      for (const w of line.words) {
        const base = nt[w.id]?.baselineY ?? lineBase;
        const size = w.style.size || Math.abs(w.bbox.bottom - w.bbox.top) / 0.75;
        // Declared font metrics overshoot the visible glyphs on many fonts, so a band off the word bboxes can cover neighboring lines.
        top = Math.min(top, base - 0.75 * size);
        bottom = Math.max(bottom, base + 0.25 * size);
      }
      if (!Number.isFinite(top)) top = lbox.top;
      if (!Number.isFinite(bottom)) bottom = lbox.bottom;
      return {
        left: lbox.left, right: lbox.right, top, bottom,
      };
    };

    /**
     * The eligible line under the pointer, or null when the pointer is outside its drawn band.
     * @param {number} clientX
     * @param {number} clientY
     */
    const lineHitAt = (clientX, clientY) => {
      if (!scribe.textSel) return null;
      const info = scribe.textSel.lineInfoAt(clientX, clientY, lineEligible);
      if (!info) return null;
      const p = scribe.clientToPage(clientX, clientY);
      if (p.n !== info.n) return null;
      const local = scribe.pageToLocal(info.n, info.orientation, p.x, p.y);
      const box = lineDrawBox(info.line, info.lbox);
      const pad = 2;
      if (local.x < box.left - pad || local.x > box.right + pad
        || local.y < box.top - pad || local.y > box.bottom + pad) return null;
      return info;
    };

    // Faint boxes on every eligible line show which text is native (editable) rather than baked into an image.
    /** @type {Map<import('../../../js/objects/ocrObjects.js').OcrLine, HTMLDivElement>} */
    const lineBoxes = new Map();
    let lineBoxRaf = 0;
    const clearLineBoxes = () => {
      if (lineBoxRaf) {
        cancelAnimationFrame(lineBoxRaf);
        lineBoxRaf = 0;
      }
      for (const el of lineBoxes.values()) el.remove();
      lineBoxes.clear();
    };
    const renderLineBoxesNow = () => {
      // At fit-width a line's box is a few pixels tall, so marking every one of them on a phone reads as noise rather than as a hint.
      if (!editMode || !scribe.textSel || scribe._phoneUi) {
        clearLineBoxes();
        return;
      }
      const openLine = editor?.isOpen() ? editor.lineOpen() : null;
      const seen = new Set();
      for (const n of scribe.textGroupsRenderIndices) {
        const idx = scribe.textSel.index(n);
        if (!idx) continue;
        for (const e of idx.lines) {
          if (!lineEligible(e.line) || e.line === openLine || selected.has(e.line)) continue;
          const group = scribe.getTextGroup(n, e.orientation);
          if (!group) continue;
          let el = lineBoxes.get(e.line);
          if (!el) {
            el = document.createElement('div');
            el.className = 'scribe-edit-text-lbox';
            Object.assign(el.style, {
              position: 'absolute',
              border: 'calc(1px / var(--scribe-zoom, 1)) solid rgba(26, 115, 232, 0.3)',
              borderRadius: '2px',
              pointerEvents: 'none',
              boxSizing: 'border-box',
            });
            lineBoxes.set(e.line, el);
          }
          // Not the selection band (rectTop/rectBottom): the band tiles the leading for gap-free drags, so a box that tall would read as overlapping its neighbors.
          const pad = 2;
          const box = lineDrawBox(e.line, e.lbox);
          el.style.left = `${box.left - pad}px`;
          el.style.top = `${box.top - pad}px`;
          el.style.width = `${box.right - box.left + 2 * pad}px`;
          el.style.height = `${box.bottom - box.top + 2 * pad}px`;
          if (el.parentElement !== group) group.appendChild(el);
          seen.add(e.line);
        }
      }
      for (const [line, el] of lineBoxes) {
        if (!seen.has(line)) {
          el.remove();
          lineBoxes.delete(line);
        }
      }
    };
    const scheduleLineBoxes = () => {
      if (lineBoxRaf) return;
      lineBoxRaf = requestAnimationFrame(() => {
        lineBoxRaf = 0;
        renderLineBoxesNow();
      });
    };
    renderModeBoxes = scheduleLineBoxes;

    const entryFor = (line) => {
      const n = line.page?.n;
      const idx = n != null ? scribe.textSel?.index(n) : null;
      if (!idx) return null;
      for (let li = 0; li < idx.lines.length; li++) if (idx.lines[li].line === line) return { n, li, e: idx.lines[li] };
      return null;
    };
    // Edits and undo replace line objects, so a selection only ever keeps lines the document still has.
    const validateSelection = () => {
      for (const line of [...selected]) {
        if (!line.page || !line.page.lines.includes(line)) selected.delete(line);
      }
    };
    const renderFrames = () => {
      for (const [line, el] of frames) {
        if (!selected.has(line)) {
          el.remove();
          frames.delete(line);
        }
      }
      for (const line of selected) {
        const found = entryFor(line);
        const group = found ? scribe.getTextGroup(found.n, found.e.orientation) : null;
        if (!group) {
          frames.get(line)?.remove();
          continue;
        }
        let el = frames.get(line);
        if (!el) {
          el = document.createElement('div');
          el.className = 'scribe-edit-text-frame';
          Object.assign(el.style, {
            position: 'absolute',
            border: 'calc(1.5px / var(--scribe-zoom, 1)) solid var(--scribe-accent, #1c62d4)',
            borderRadius: 'calc(3px / var(--scribe-zoom, 1))',
            background: 'var(--scribe-active, rgba(28, 98, 212, .10))',
            pointerEvents: 'none',
            boxSizing: 'border-box',
          });
          frames.set(line, el);
        }
        const pad = 2;
        const box = lineDrawBox(line, found.e.lbox);
        el.style.left = `${box.left - pad}px`;
        el.style.top = `${box.top - pad}px`;
        el.style.width = `${box.right - box.left + 2 * pad}px`;
        el.style.height = `${box.bottom - box.top + 2 * pad}px`;
        if (el.parentElement !== group) group.appendChild(el);
      }
      if (scribe._phoneUi && selected.size > 0) {
        const ordered = orderedSelection();
        const place = (grip, at, xSide) => {
          const group = scribe.getTextGroup(at.n, at.e.orientation);
          if (!group) {
            grip.remove();
            return;
          }
          const box = lineDrawBox(at.line, at.e.lbox);
          grip.style.left = `${xSide === 'left' ? box.left : box.right}px`;
          grip.style.top = `${box.bottom + 2}px`;
          if (grip.parentElement !== group) group.appendChild(grip);
        };
        if (ordered.length > 1) place(gripStart, ordered[0], 'left');
        else gripStart.remove();
        if (ordered.length > 0) place(gripEnd, ordered[ordered.length - 1], 'right');
        else gripEnd.remove();
      } else {
        gripStart.remove();
        gripEnd.remove();
      }
      scribe._modeStatus?.(selected.size === 0 ? '' : selected.size === 1 ? '1 line' : `${selected.size} lines`);
      // Every path that changes lines runs through here, so the mode's hairline boxes stay in sync by riding along.
      scheduleLineBoxes();
      scribe._modeSelectionChanged?.();
    };
    const clearSelection = () => {
      selected.clear();
      hideEditHint();
      renderFrames();
    };
    clearBoxSelection = clearSelection;

    const orderedSelection = () => {
      validateSelection();
      const out = [];
      for (const line of selected) {
        const found = entryFor(line);
        if (found) out.push({ line, ...found });
      }
      out.sort((a, b) => a.n - b.n || a.li - b.li);
      return out;
    };

    /**
     * Extend the selection line-by-line from a fixed anchor until the pointer lifts.
     * The selection is always the contiguous run of eligible lines between the anchor and the line nearest the pointer.
     * @param {{n: number, li: number}} anchor
     * @param {number} pointerId
     */
    const startLineDrag = (anchor, pointerId) => {
      const ZONE = 44;
      const MAX = 26;
      let raf = 0;
      let last = null;
      const apply = (cx, cy) => {
        const p = scribe.clientToPage(cx, cy);
        if (p.n < 0 || !scribe.textSel) return;
        const idx = scribe.textSel.index(p.n);
        if (!idx) return;
        let target = null;
        let bestScore = Infinity;
        for (let li = 0; li < idx.lines.length; li++) {
          const e = idx.lines[li];
          if (!lineEligible(e.line)) continue;
          const local = scribe.pageToLocal(p.n, e.orientation, p.x, p.y);
          const box = lineDrawBox(e.line, e.lbox);
          const dy = local.y < box.top ? box.top - local.y : local.y > box.bottom ? local.y - box.bottom : 0;
          const dx = local.x < box.left ? box.left - local.x : local.x > box.right ? local.x - box.right : 0;
          // Vertical distance dominates so a drag down a column tracks that column rather than the one beside it.
          const score = dy * 3 + dx;
          if (score < bestScore) {
            bestScore = score;
            target = { n: p.n, li };
          }
        }
        if (!target) return;
        const [a, b] = (target.n - anchor.n || target.li - anchor.li) < 0 ? [target, anchor] : [anchor, target];
        selected.clear();
        for (let n = a.n; n <= b.n; n++) {
          const pageIdx = scribe.textSel.index(n);
          if (!pageIdx) continue;
          const from = n === a.n ? a.li : 0;
          const to = n === b.n ? b.li : pageIdx.lines.length - 1;
          for (let li = from; li <= to; li++) {
            if (lineEligible(pageIdx.lines[li].line)) selected.add(pageIdx.lines[li].line);
          }
        }
        renderFrames();
      };
      const tick = () => {
        raf = requestAnimationFrame(tick);
        if (!last) return;
        const sc = scribe.scrollContainer;
        const rect = sc.getBoundingClientRect();
        const speed = (over) => Math.sign(over) * Math.min(MAX, (Math.abs(over) / ZONE) * MAX);
        const overY = Math.max(0, last.y - (rect.bottom - ZONE)) || Math.min(0, last.y - (rect.top + ZONE));
        const overX = Math.max(0, last.x - (rect.right - ZONE)) || Math.min(0, last.x - (rect.left + ZONE));
        if (overY || overX) {
          sc.scrollTop += speed(overY);
          sc.scrollLeft += speed(overX);
          apply(last.x, last.y);
        }
      };
      const move = (ev) => {
        if (ev.pointerId !== pointerId) return;
        last = { x: ev.clientX, y: ev.clientY };
        apply(last.x, last.y);
      };
      const end = (ev) => {
        if (ev.pointerId !== pointerId) return;
        scribe._editTextLineDrag = false;
        cancelAnimationFrame(raf);
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
      };
      // Signals the viewer to keep native panning and the long-press context menu off this touch.
      scribe._editTextLineDrag = true;
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
      raf = requestAnimationFrame(tick);
    };

    // Styled like the text-selection grips, so the two selection idioms match.
    const makeGrip = (which) => {
      const el = document.createElement('div');
      el.className = `scribe-edit-line-grip scribe-edit-line-grip-${which}`;
      Object.assign(el.style, {
        position: 'absolute',
        width: '44px',
        height: '44px',
        marginLeft: '-22px',
        // Set at creation because iOS only honors touch-action from before the touchstart.
        touchAction: 'none',
        cursor: 'grab',
        zIndex: '2',
        pointerEvents: 'auto',
        transform: 'scale(calc(1 / var(--scribe-zoom, 1)))',
        transformOrigin: 'top center',
      });
      const dot = document.createElement('div');
      Object.assign(dot.style, {
        position: 'absolute',
        left: '50%',
        top: '2px',
        width: '17px',
        height: '17px',
        marginLeft: '-8.5px',
        borderRadius: '50%',
        background: 'var(--scribe-accent, #1c62d4)',
        boxShadow: '0 0 0 1.5px rgba(255, 255, 255, .9), 0 1px 3px rgba(15, 22, 40, .35)',
      });
      dot.style[which === 'start' ? 'borderTopRightRadius' : 'borderTopLeftRadius'] = '2px';
      el.appendChild(dot);
      el.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        const ordered = orderedSelection();
        if (ordered.length === 0) return;
        const at = which === 'end' ? ordered[0] : ordered[ordered.length - 1];
        startLineDrag({ n: at.n, li: at.li }, ev.pointerId);
      });
      return el;
    };
    const gripStart = makeGrip('start');
    const gripEnd = makeGrip('end');

    const eligibleSelectedLines = () => {
      validateSelection();
      if (selected.size > 0) return [...selected];
      // Touch still selects through the engine, so its lines count too.
      const lines = new Set();
      for (const kw of scribe.getWordsUnderTextSelection()) lines.add(kw.word.line);
      return [...lines].filter(lineEligible);
    };
    const deleteSelectedLines = () => {
      const eligible = eligibleSelectedLines();
      if (eligible.length === 0) return false;
      const res = scribe.doc.deleteTextLines(eligible);
      clearSelection();
      scribe.clearTextSelection();
      hideHover();
      refreshPages(res.pages);
      return true;
    };
    // The context menu and touch callout offer "Delete Lines" through these while the mode is on.
    scribe._editTextSelectedLines = eligibleSelectedLines;
    scribe._editTextDeleteSelection = deleteSelectedLines;
    // A phone-layout flip mid-mode decides whether the lines get hairline boxes at all, so the app re-derives them through this.
    scribe._editTextRefreshFrames = renderFrames;

    /** @param {'bold'|'italic'} prop */
    const selectionStyleState = (prop) => {
      const lines = eligibleSelectedLines();
      let total = 0;
      let onAll = true;
      let clearable = false;
      for (const line of lines) {
        const nt = nativeTextForPage(scribe.doc, line.page);
        for (const w of line.words) {
          total += 1;
          const has = prop === 'bold' ? w.style.bold : w.style.italic;
          if (!has) { onAll = false; continue; }
          const e = nt[w.id];
          if (e && (prop === 'bold'
            ? ((e.renderMode === 1 || e.renderMode === 2) && !!e.strokeWidthPx)
            : !!(e.skew && e.skew.some((v) => v)))) clearable = true;
        }
      }
      // Locked means every word already has the style baked into its face, so there is nothing a toggle could remove.
      return { present: total > 0, on: total > 0 && onAll, locked: total > 0 && onAll && !clearable };
    };
    /** @param {'bold'|'italic'} prop */
    const toggleSelectionStyle = (prop) => {
      const lines = eligibleSelectedLines();
      if (lines.length === 0) return;
      /** @type {Array<import('../../../js/objects/ocrObjects.js').OcrWord>} */
      const words = lines.flatMap((l) => l.words);
      // Word-processor rule: any word lacking the style means the first press applies it to all.
      const target = words.some((w) => !(prop === 'bold' ? w.style.bold : w.style.italic));
      (async () => {
        const pages = new Set();
        for (const line of lines) {
          const res = await scribe.doc.replaceTextLine(
            line,
            line.words.map((w) => w.text).join(' '),
            { wordStyles: line.words.map(() => ({ [prop]: target })) },
          );
          if (res) for (const p of res.pages) pages.add(p);
        }
        if (pages.size > 0) {
          refreshPages([...pages]);
          renderFrames();
        }
      })().catch((e) => console.error('Edit Text: style toggle failed:', e));
    };
    scribe._editTextStyleState = selectionStyleState;
    scribe._editTextToggleStyle = toggleSelectionStyle;

    /** @type {?{info: NonNullable<ReturnType<import('../viewerTextSelection.js').TextSelection['lineInfoAt']>>, x: number, y: number}} */
    let menuTarget = null;
    scribe._editTextMenuTarget = (clientX, clientY) => {
      menuTarget = null;
      if (!scribe.textSel || editor?.isOpen()) return null;
      const info = lineHitAt(clientX, clientY);
      if (!info) return null;
      validateSelection();
      if (!selected.has(info.line)) {
        selected.clear();
        selected.add(info.line);
        renderFrames();
      }
      menuTarget = { info, x: clientX, y: clientY };
      return menuTarget;
    };
    scribe._editTextEditLine = () => {
      if (!menuTarget) return;
      const { info, x, y } = menuTarget;
      if (!info.line.page || !info.line.page.lines.includes(info.line)) return;
      clearSelection();
      hideHover();
      editor.open(info, x, y).finally(scheduleLineBoxes);
    };
    scribe._editTextCopySelection = () => {
      const lines = eligibleSelectedLines();
      if (lines.length === 0) return;
      lines.sort((a, b) => a.page.n - b.page.n || a.bbox.top - b.bbox.top || a.bbox.left - b.bbox.left);
      const text = lines.map((l) => l.words.map((w) => w.text).join(' ')).join('\n');
      navigator.clipboard?.writeText(text).catch(() => {});
    };

    editor = createLineEditor(scribe, {
      onCommitted: refreshPages,
      onOpenChanged: (open) => scribe._editTextEditorOpenChanged?.(open),
    });
    scribe._editTextLineEditor = editor;

    /**
     * Open the sole selected line in the editor from a keyboard action.
     * @param {{caretEnd?: boolean}} openOpts
     */
    const openSelectedForEdit = (openOpts) => {
      validateSelection();
      if (selected.size !== 1) return;
      const line = [...selected][0];
      const found = entryFor(line);
      if (!found) return;
      const info = {
        n: found.n, line, lbox: found.e.lbox, orientation: found.e.orientation, start: found.e.start,
      };
      clearSelection();
      hideHover();
      editor.open(info, null, null, openOpts).finally(scheduleLineBoxes);
    };
    // A one-line engine text selection counts as the target, since a long-press produces no box selection.
    scribe._editTextOpenSelected = () => {
      validateSelection();
      if (selected.size === 0) {
        const lines = eligibleSelectedLines();
        if (lines.length !== 1) return;
        selected.add(lines[0]);
        scribe.clearTextSelection();
      }
      openSelectedForEdit({});
    };

    const flashSelection = () => {
      for (const el of frames.values()) {
        const zoom = parseFloat(getComputedStyle(el).getPropertyValue('--scribe-zoom')) || 1;
        el.animate([
          { boxShadow: 'none' },
          { boxShadow: `0 0 0 ${3 / zoom}px var(--scribe-accent-ring, rgba(28, 98, 212, .30))` },
          { boxShadow: 'none' },
        ], { duration: 300, iterations: 2 });
      }
    };

    /** @type {?HTMLDivElement} */
    let hintElem = null;
    let hintTimer = 0;
    const hideEditHint = () => {
      if (hintTimer) clearTimeout(hintTimer);
      hintTimer = 0;
      hintElem?.remove();
      hintElem = null;
    };
    const showEditHint = () => {
      let anchor = null;
      for (const el of frames.values()) {
        if (el.isConnected) {
          anchor = el;
          break;
        }
      }
      if (!anchor) return;
      hideEditHint();
      const r = anchor.getBoundingClientRect();
      hintElem = document.createElement('div');
      hintElem.className = 'scribe-edit-text-hint';
      hintElem.textContent = 'To edit the text, press Enter or double-click the line.';
      Object.assign(hintElem.style, {
        position: 'fixed',
        zIndex: '60',
        background: 'var(--scribe-surface, #ffffff)',
        color: 'var(--scribe-ink, #1f2530)',
        border: '1px solid var(--scribe-line, #e4e8ef)',
        borderRadius: '7px',
        padding: '7px 11px',
        fontSize: '12px',
        lineHeight: '1.35',
        boxShadow: 'var(--scribe-menu-shadow, 0 4px 14px rgba(20, 30, 60, .13))',
        pointerEvents: 'none',
        maxWidth: '300px',
        transition: 'opacity .3s',
      });
      scribe.scrollContainer.appendChild(hintElem);
      const hw = hintElem.getBoundingClientRect();
      hintElem.style.left = `${Math.max(6, Math.min(r.left, window.innerWidth - hw.width - 6))}px`;
      hintElem.style.top = `${Math.max(4, r.top - hw.height - 8)}px`;
      hintTimer = window.setTimeout(() => {
        if (!hintElem) return;
        hintElem.style.opacity = '0';
        hintTimer = window.setTimeout(hideEditHint, 350);
      }, 2600);
    };

    const hoverHandler = (ev) => {
      if (!editMode || !scribe.useCustomSelection || !scribe.textSel) return;
      // Compat mouse events after a tap would paint a stray hover box on the phone, which marks nothing at rest.
      if (scribe._phoneUi) { hideHover(); return; }
      if (editor?.isOpen()) { hideHover(); return; }
      if (ev.buttons !== 0) { hideHover(); return; }
      const info = lineHitAt(ev.clientX, ev.clientY);
      if (!info) { hideHover(); return; }
      if (selected.has(info.line)) { hideHover(); return; }
      const group = scribe.getTextGroup(info.n, info.orientation);
      if (!group) { hideHover(); return; }
      // Same box and pad as the selection frame a click will draw.
      const pad = 2;
      const box = lineDrawBox(info.line, info.lbox);
      hoverElem.style.left = `${box.left - pad}px`;
      hoverElem.style.top = `${box.top - pad}px`;
      hoverElem.style.width = `${box.right - box.left + 2 * pad}px`;
      hoverElem.style.height = `${box.bottom - box.top + 2 * pad}px`;
      if (hoverElem.parentElement !== group) group.appendChild(hoverElem);
    };

    /** @type {?HTMLDivElement} */
    let marqueeEl = null;
    const removeMarquee = () => {
      marqueeEl?.remove();
      marqueeEl = null;
    };

    /**
     * Eligible lines whose drawn boxes intersect a client-space rect, on every page the rect touches.
     * @param {{left: number, top: number, right: number, bottom: number}} r
     */
    const linesInClientRect = (r) => {
      const hits = new Set();
      const containers = scribe.pageContainerArr || [];
      for (let n = 0; n < containers.length; n++) {
        const cont = containers[n];
        if (!cont || !cont.isConnected) continue;
        const pr = cont.getBoundingClientRect();
        if (pr.width === 0 || pr.right < r.left || pr.left > r.right || pr.bottom < r.top || pr.top > r.bottom) continue;
        const idx = scribe.textSel.index(n);
        if (!idx) continue;
        const dims = scribe.doc.pageMetrics[n].dims;
        for (const [orientation, indices] of idx.byOrientation) {
          let L = Infinity; let T = Infinity; let R = -Infinity; let B = -Infinity;
          for (const [cx, cy] of [[r.left, r.top], [r.right, r.top], [r.left, r.bottom], [r.right, r.bottom]]) {
            const loc = scribe.pageToLocal(n, orientation, ((cx - pr.left) * dims.width) / pr.width, ((cy - pr.top) * dims.height) / pr.height);
            L = Math.min(L, loc.x); T = Math.min(T, loc.y);
            R = Math.max(R, loc.x); B = Math.max(B, loc.y);
          }
          for (const li of indices) {
            const e = idx.lines[li];
            if (!lineEligible(e.line)) continue;
            // The selection band (rectTop/rectBottom) tiles the leading, so a rect over one line would catch its neighbors.
            const pad = 2;
            const box = lineDrawBox(e.line, e.lbox);
            if (box.left - pad < R && box.right + pad > L && box.top - pad < B && box.bottom + pad > T) hits.add(e.line);
          }
        }
      }
      return hits;
    };

    // Stopping or preventing a single touch kills native panning, so the press itself is never consumed.
    // The movement and hold thresholds mirror the engine's TOUCH_HOLD_PX and TOUCH_HOLD_MS, so a slow tap does not also start a hold-select.
    const armTouchTap = (down) => {
      if (editor?.isOpen()) return;
      const start = {
        x: down.clientX, y: down.clientY, id: down.pointerId, t: down.timeStamp,
      };
      /**
       * The eligible line nearest a client point, or null outside the tap radius.
       * @param {number} x
       * @param {number} y
       */
      const nearestLine = (x, y) => {
        // A finger covers several lines at fit-width, so the nearest band inside the radius wins rather than a strict hit test.
        const R = 12;
        const near = [...linesInClientRect({
          left: x - R, top: y - R, right: x + R, bottom: y + R,
        })];
        const p = scribe.clientToPage(x, y);
        let pick = null;
        let pickDist = Infinity;
        for (const line of near) {
          const found = entryFor(line);
          if (!found || p.n !== found.n) continue;
          const local = scribe.pageToLocal(found.n, found.e.orientation, p.x, p.y);
          const box = lineDrawBox(line, found.e.lbox);
          const d = Math.abs(local.y - (box.top + box.bottom) / 2);
          if (d < pickDist) {
            pickDist = d;
            pick = found;
          }
        }
        return pick;
      };
      const holdT = window.setTimeout(() => {
        cancel();
        const pick = nearestLine(start.x, start.y);
        if (!pick) return;
        selected.clear();
        selected.add(pick.e.line);
        renderFrames();
        startLineDrag({ n: pick.n, li: pick.li }, start.id);
      }, 500);
      const cancel = () => {
        clearTimeout(holdT);
        window.removeEventListener('pointermove', watch);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', cancel);
      };
      const watch = (mv) => {
        if (mv.pointerId !== start.id) return;
        if (Math.hypot(mv.clientX - start.x, mv.clientY - start.y) > 10) cancel();
      };
      const onUp = (up) => {
        cancel();
        if (up.pointerId !== start.id) return;
        if (up.timeStamp - start.t >= 500) return;
        if (Math.hypot(up.clientX - start.x, up.clientY - start.y) > 10) return;
        const pick = nearestLine(up.clientX, up.clientY);
        if (!pick) {
          if (selected.size > 0) clearSelection();
          return;
        }
        selected.clear();
        selected.add(pick.e.line);
        renderFrames();
      };
      window.addEventListener('pointermove', watch);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', cancel);
    };

    // Runs at capture and stops propagation so the engine's own pointerdown (text-drag selection, link arming) never sees a press this mode handles.
    const pointerdownHandler = (ev) => {
      if (!editMode || ev.button !== 0 || !scribe.textSel) return;
      // The grip's own pointerdown runs the range drag.
      if (ev.target instanceof Element && ev.target.closest('.scribe-edit-line-grip')) return;
      if (ev.pointerType === 'touch') { armTouchTap(ev); return; }
      const t = ev.target;
      if (t instanceof Element && t.closest('.scribe-hl-cmark, .scribe-note-icon, .scribe-cmt-card, [contenteditable]')) return;
      // The open editor owns only its text band, not its full-width canvas element.
      if (editor?.isOpen() && editor.containsPoint(ev.clientX, ev.clientY)) return;
      ev.stopPropagation();
      const downX = ev.clientX;
      const downY = ev.clientY;
      const shift = ev.shiftKey;
      const info = lineHitAt(downX, downY);
      const wasOpen = editor.isOpen();
      const base = shift ? new Set(selected) : new Set();
      let moved = false;
      const onMove = (mv) => {
        if (!moved && Math.hypot(mv.clientX - downX, mv.clientY - downY) <= 4) return;
        moved = true;
        if (!marqueeEl) {
          marqueeEl = document.createElement('div');
          marqueeEl.className = 'scribe-edit-text-marquee';
          Object.assign(marqueeEl.style, {
            position: 'fixed',
            zIndex: '50',
            pointerEvents: 'none',
            border: '1px solid var(--scribe-accent, #1c62d4)',
            background: 'var(--scribe-active, rgba(28, 98, 212, .10))',
          });
          document.body.appendChild(marqueeEl);
          hideHover();
        }
        const r = {
          left: Math.min(downX, mv.clientX),
          top: Math.min(downY, mv.clientY),
          right: Math.max(downX, mv.clientX),
          bottom: Math.max(downY, mv.clientY),
        };
        Object.assign(marqueeEl.style, {
          left: `${r.left}px`, top: `${r.top}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px`,
        });
        selected.clear();
        for (const l of base) selected.add(l);
        for (const l of linesInClientRect(r)) selected.add(l);
        renderFrames();
      };
      const onUp = (uv) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (moved) {
          removeMarquee();
          return;
        }
        // If an editor was open, its own click-away hook has already committed.
        if (!info) {
          clearSelection();
          return;
        }
        if (shift) {
          if (selected.has(info.line)) selected.delete(info.line);
          else selected.add(info.line);
          renderFrames();
          return;
        }
        // A double-click needs no timing window because its second click is already a click on the sole selected line.
        if (!wasOpen && selected.size === 1 && selected.has(info.line)) {
          clearSelection();
          hideHover();
          // Opening is async (font loads); the open line sheds its hairline box once it settles.
          editor.open(info, uv.clientX, uv.clientY).finally(scheduleLineBoxes);
          return;
        }
        selected.clear();
        selected.add(info.line);
        renderFrames();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };

    const keydownHandler = (ev) => {
      if (!editMode) return;
      if (ev.key === 'Escape' && editor?.isOpen()) {
        // The editor reverts and closes itself.
        const line = editor.lineOpen();
        queueMicrotask(() => {
          if (editor?.isOpen() || !line || !lineEligible(line)) return;
          if (!line.page || !line.page.lines.includes(line)) return;
          validateSelection();
          selected.clear();
          selected.add(line);
          renderFrames();
        });
        return;
      }
      const t = ev.target;
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (ev.key === 'Escape') {
        if (selected.size === 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        clearSelection();
        return;
      }
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && (ev.key === 'z' || ev.key === 'Z' || ev.key === 'y')) {
        ev.preventDefault();
        ev.stopPropagation();
        const redo = ev.key === 'y' || ev.shiftKey;
        scribe.clearTextSelection();
        hideHover();
        if (redo ? scribe.redo() : scribe.undo()) {
          validateSelection();
          renderFrames();
        }
        return;
      }
      if (mod && (ev.key === 'c' || ev.key === 'C')) {
        if (eligibleSelectedLines().length === 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        scribe._editTextCopySelection?.();
        return;
      }
      if (mod && ['b', 'B', 'i', 'I'].includes(ev.key)) {
        if (eligibleSelectedLines().length === 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        toggleSelectionStyle(ev.key === 'b' || ev.key === 'B' ? 'bold' : 'italic');
        return;
      }
      if (ev.key === 'Enter' || ev.key === 'F2') {
        validateSelection();
        if (selected.size !== 1) return;
        ev.preventDefault();
        ev.stopPropagation();
        openSelectedForEdit({ caretEnd: true });
        return;
      }
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        if (eligibleSelectedLines().length === 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        // Backspace on a single box-selected line is inert, because a text-flavored key must not destroy a line.
        // Delete still deletes, as does either key across a multi-selection.
        if (ev.key === 'Backspace' && selected.size === 1) return;
        deleteSelectedLines();
        return;
      }
      if (!mod && !ev.altKey && ev.key.length === 1) {
        if (eligibleSelectedLines().length === 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        flashSelection();
        showEditHint();
      }
    };

    let scrollRaf = 0;
    const scrollHandler = () => {
      if (hintElem) hideEditHint();
      if (scrollRaf || !editMode) return;
      // Page virtualization rebuilds text groups; re-rendering re-parents any dropped frame.
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        renderFrames();
      });
    };

    scribe.scrollContainer.addEventListener('pointermove', hoverHandler);
    scribe.scrollContainer.addEventListener('pointerdown', pointerdownHandler, true);
    scribe.scrollContainer.addEventListener('scroll', scrollHandler, { passive: true });
    document.addEventListener('keydown', keydownHandler, true);

    return () => {
      scribe.scrollContainer?.removeEventListener('pointermove', hoverHandler);
      scribe.scrollContainer?.removeEventListener('pointerdown', pointerdownHandler, true);
      scribe.scrollContainer?.removeEventListener('scroll', scrollHandler);
      document.removeEventListener('keydown', keydownHandler, true);
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      removeMarquee();
      clearSelection();
      clearLineBoxes();
      clearBoxSelection = () => {};
      renderModeBoxes = () => {};
      if (scribe.textSel) scribe.textSel.cursorOverride = null;
      hideHover();
      editor?.teardown();
      editor = null;
      scribe._editTextActive = false;
      scribe._editTextLineDrag = false;
      scribe._editTextSelectedLines = null;
      scribe._editTextDeleteSelection = null;
      scribe._editTextStyleState = null;
      scribe._editTextToggleStyle = null;
      scribe._editTextMenuTarget = null;
      scribe._editTextEditLine = null;
      scribe._editTextCopySelection = null;
      scribe._editTextLineEditor = null;
      scribe._editTextOpenSelected = null;
      scribe._editTextRefreshFrames = null;
    };
  }

  return { toolbarElem, installBehaviors };
}

// eslint-disable-next-line max-len
const IMAGE_EDIT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="14" rx="1.5"/><circle cx="9" cy="10" r="1.6"/><path d="M3.5 16.5l4.8-4.3 3.4 3 3.6-3.4 5.2 4.7"/></svg>';

/**
 * Toolbar control that toggles the Edit Graphics mode for selecting and deleting a page's image and path placements.
 * @param {import('../../viewer.js').ScribeViewer} scribe
 */
export function createGraphicsEditTool(scribe) {
  let graphicsMode = false;
  const toolbarElem = makeIconButton('Edit Graphics', IMAGE_EDIT_SVG);
  toolbarElem.classList.add('cr-labeled-button');
  const toolbarLabelElem = document.createElement('span');
  toolbarLabelElem.className = 'cr-btn-label';
  toolbarLabelElem.textContent = 'Edit Graphics';
  toolbarElem.appendChild(toolbarLabelElem);

  /** @type {Map<{left: number, top: number, right: number, bottom: number}, {n: number, kind: 'image'|'path'}>} */
  const selected = new Map();
  /** @type {Map<object, HTMLElement>} */
  const frames = new Map();
  /** @type {?HTMLElement} */
  let hoverEl = null;
  /** @type {?HTMLDivElement} */
  let marqueeEl = null;

  const makeBox = () => {
    const el = document.createElement('div');
    Object.assign(el.style, {
      position: 'absolute',
      borderRadius: 'calc(3px / var(--scribe-zoom, 1))',
      pointerEvents: 'none',
      boxSizing: 'border-box',
    });
    return el;
  };

  const placementsForPage = (n) => {
    const page = scribe.doc?.ocr?.pdf?.[n];
    const dims = page?.dims;
    if (!page || !dims) return [];
    const records = scribe.doc.contentEdits.pages[n] || [];
    const pad = 2;
    const areaCap = dims.width * dims.height * 0.95;
    const pending = (/** @type {string} */ type, /** @type {{left: number, top: number, right: number, bottom: number}} */ e) => records.some((r) => r.type === type
      && Math.abs(e.left - r.rect.left) <= pad && Math.abs(e.top - r.rect.top) <= pad
      && Math.abs(e.right - r.rect.right) <= pad && Math.abs(e.bottom - r.rect.bottom) <= pad);
    /** @type {Array<{kind: 'image'|'path', e: {left: number, top: number, right: number, bottom: number}}>} */
    const out = [];
    // A placement covering nearly the whole page is the scan or the page background, so deleting it would blank the page.
    for (const e of pageImagePlacements(page)) {
      if ((e.right - e.left) * (e.bottom - e.top) < areaCap && !pending('deleteImage', e)) out.push({ kind: 'image', e });
    }
    for (const e of pagePathPlacements(page)) {
      if ((e.right - e.left) * (e.bottom - e.top) < areaCap && !pending('deletePath', e)) out.push({ kind: 'path', e });
    }
    return out;
  };

  const placementAt = (clientX, clientY) => {
    const pt = scribe.clientToPage(clientX, clientY);
    if (!pt) return null;
    // Hairline rules have near-zero extents, so thin path targets get a minimum hit band of ~4 css px per side.
    let slop = 4;
    const cont = scribe.pageContainerArr?.[pt.n];
    const dims = scribe.doc?.ocr?.pdf?.[pt.n]?.dims;
    if (cont && cont.isConnected && dims) {
      const pr = cont.getBoundingClientRect();
      if (pr.width > 0) slop = (4 * dims.width) / pr.width;
    }
    let best = null;
    for (const { kind, e } of placementsForPage(pt.n)) {
      const sx = kind === 'path' && (e.right - e.left) < slop * 2 ? slop : 0;
      const sy = kind === 'path' && (e.bottom - e.top) < slop * 2 ? slop : 0;
      if (pt.x >= e.left - sx && pt.x <= e.right + sx && pt.y >= e.top - sy && pt.y <= e.bottom + sy) {
        const area = (e.right - e.left + 2 * sx) * (e.bottom - e.top + 2 * sy);
        if (!best || area < best.area) {
          best = {
            n: pt.n, entry: e, kind, area,
          };
        }
      }
    }
    return best;
  };

  const positionBox = (el, n, entry) => {
    const pad = 2;
    el.style.left = `${entry.left - pad}px`;
    el.style.top = `${entry.top - pad}px`;
    el.style.width = `${entry.right - entry.left + 2 * pad}px`;
    el.style.height = `${entry.bottom - entry.top + 2 * pad}px`;
    const group = scribe.getTextGroup(n, 0);
    if (group && el.parentElement !== group) group.appendChild(el);
  };

  const validateSelection = () => {
    const pools = new Map();
    for (const [entry, sel] of selected) {
      let pool = pools.get(sel.n);
      if (!pool) {
        pool = new Set(placementsForPage(sel.n).map((p) => p.e));
        pools.set(sel.n, pool);
      }
      if (!pool.has(entry)) selected.delete(entry);
    }
  };

  const renderFrames = () => {
    for (const [entry, el] of frames) {
      if (!selected.has(entry)) {
        el.remove();
        frames.delete(entry);
      }
    }
    for (const [entry, sel] of selected) {
      let el = frames.get(entry);
      if (!el) {
        el = makeBox();
        el.className = 'scribe-graphics-edit-frame';
        el.style.border = 'calc(2px / var(--scribe-zoom, 1)) solid var(--scribe-accent, #1c62d4)';
        el.style.boxShadow = '0 0 0 calc(1px / var(--scribe-zoom, 1)) rgba(255, 255, 255, .9), '
          + 'inset 0 0 0 calc(1px / var(--scribe-zoom, 1)) rgba(255, 255, 255, .9)';
        el.style.background = 'var(--scribe-active, rgba(28, 98, 212, .10))';
        frames.set(entry, el);
      }
      positionBox(el, sel.n, entry);
    }
    scribe._modeSelectionChanged?.();
  };

  const renderHover = (hit) => {
    if (!hit || selected.has(hit.entry)) {
      hoverEl?.remove();
      hoverEl = null;
      return;
    }
    if (!hoverEl) {
      hoverEl = makeBox();
      hoverEl.className = 'scribe-graphics-edit-hover';
      hoverEl.style.border = 'calc(1.5px / var(--scribe-zoom, 1)) dashed var(--scribe-accent, #1c62d4)';
      hoverEl.style.boxShadow = '0 0 0 calc(1px / var(--scribe-zoom, 1)) rgba(255, 255, 255, .75)';
    }
    positionBox(hoverEl, hit.n, hit.entry);
  };

  const removeMarquee = () => {
    marqueeEl?.remove();
    marqueeEl = null;
  };

  const resetSelection = () => {
    selected.clear();
    for (const el of frames.values()) el.remove();
    frames.clear();
    hoverEl?.remove();
    hoverEl = null;
    removeMarquee();
  };

  toolbarElem.addEventListener('click', () => {
    graphicsMode = !graphicsMode;
    scribe._graphicsEditActive = graphicsMode;
    toolbarElem.classList.toggle('active', graphicsMode);
    if (!graphicsMode) {
      resetSelection();
      hideTouchCallout();
    }
  });

  /**
   * Wire the mode's pointer and keyboard behaviors.
   * Call after `scribe.init` (needs the scroll container).
   * @returns {() => void} teardown
   */
  function installBehaviors() {
    /** @param {Array<number>} pages */
    const refreshPages = (pages) => {
      for (const n of new Set(pages)) scribe.refreshPageRaster(n);
      if (scribe.onEditCallback) scribe.onEditCallback();
      validateSelection();
      renderFrames();
    };
    const deleteSelected = () => {
      validateSelection();
      if (selected.size === 0) return;
      const items = [...selected].map(([entry, sel]) => ({
        n: sel.n,
        rect: {
          left: entry.left, top: entry.top, right: entry.right, bottom: entry.bottom,
        },
        kind: sel.kind,
      }));
      const res = scribe.doc?.deleteGraphics(items);
      resetSelection();
      hideTouchCallout();
      if (res) refreshPages(res.pages);
    };
    const selectionAnchor = () => {
      let anchor = null;
      for (const [entry, sel] of selected) {
        const cont = scribe.pageContainerArr?.[sel.n];
        const dims = scribe.doc?.ocr?.pdf?.[sel.n]?.dims;
        if (!cont || !cont.isConnected || !dims) continue;
        const pr = cont.getBoundingClientRect();
        const r = {
          left: pr.left + (entry.left * pr.width) / dims.width,
          top: pr.top + (entry.top * pr.height) / dims.height,
          right: pr.left + (entry.right * pr.width) / dims.width,
          bottom: pr.top + (entry.bottom * pr.height) / dims.height,
        };
        anchor = anchor ? {
          left: Math.min(anchor.left, r.left),
          top: Math.min(anchor.top, r.top),
          right: Math.max(anchor.right, r.right),
          bottom: Math.max(anchor.bottom, r.bottom),
        } : r;
      }
      return anchor;
    };

    /** @param {{left: number, top: number, right: number, bottom: number}} r */
    const placementsInClientRect = (r) => {
      const hits = new Map();
      const containers = scribe.pageContainerArr || [];
      for (let n = 0; n < containers.length; n++) {
        const cont = containers[n];
        if (!cont || !cont.isConnected) continue;
        const pr = cont.getBoundingClientRect();
        if (pr.width === 0 || pr.right < r.left || pr.left > r.right || pr.bottom < r.top || pr.top > r.bottom) continue;
        const dims = scribe.doc?.ocr?.pdf?.[n]?.dims;
        if (!dims) continue;
        const L = ((r.left - pr.left) * dims.width) / pr.width;
        const R = ((r.right - pr.left) * dims.width) / pr.width;
        const T = ((r.top - pr.top) * dims.height) / pr.height;
        const B = ((r.bottom - pr.top) * dims.height) / pr.height;
        for (const { kind, e } of placementsForPage(n)) {
          if (e.left <= R && e.right >= L && e.top <= B && e.bottom >= T) hits.set(e, { n, kind });
        }
      }
      return hits;
    };

    const moveHandler = (/** @type {PointerEvent} */ ev) => {
      if (!graphicsMode || marqueeEl) return;
      if (ev.buttons !== 0) {
        renderHover(null);
        return;
      }
      renderHover(placementAt(ev.clientX, ev.clientY));
    };
    // Runs at capture and stops propagation on mouse and pen presses, so the engine's text-drag selection never sees a press this mode handles.
    // A touch press that misses every placement is left to the engine, so panning still works.
    const downHandler = (/** @type {PointerEvent} */ ev) => {
      if (!graphicsMode || ev.button !== 0) return;
      const hit = placementAt(ev.clientX, ev.clientY);
      if (ev.pointerType === 'touch') {
        if (!hit) {
          if (selected.size > 0) {
            selected.clear();
            renderFrames();
            hideTouchCallout();
          }
          return;
        }
        ev.stopPropagation();
        ev.preventDefault();
        selected.clear();
        selected.set(hit.entry, { n: hit.n, kind: hit.kind });
        renderHover(null);
        renderFrames();
        // The phone's docked verb bar carries the delete instead, so the callout would double it there.
        if (!scribe._phoneUi) showTouchCallout(scribe, 'graphics');
        return;
      }
      ev.stopPropagation();
      const downX = ev.clientX;
      const downY = ev.clientY;
      const shift = ev.shiftKey;
      const base = shift ? new Map(selected) : new Map();
      let moved = false;
      const onMove = (/** @type {PointerEvent} */ mv) => {
        if (!moved && Math.hypot(mv.clientX - downX, mv.clientY - downY) <= 4) return;
        moved = true;
        if (!marqueeEl) {
          marqueeEl = document.createElement('div');
          marqueeEl.className = 'scribe-graphics-edit-marquee';
          Object.assign(marqueeEl.style, {
            position: 'fixed',
            zIndex: '50',
            pointerEvents: 'none',
            border: '1px solid var(--scribe-accent, #1c62d4)',
            background: 'var(--scribe-active, rgba(28, 98, 212, .10))',
          });
          document.body.appendChild(marqueeEl);
          renderHover(null);
        }
        const r = {
          left: Math.min(downX, mv.clientX),
          top: Math.min(downY, mv.clientY),
          right: Math.max(downX, mv.clientX),
          bottom: Math.max(downY, mv.clientY),
        };
        Object.assign(marqueeEl.style, {
          left: `${r.left}px`, top: `${r.top}px`, width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px`,
        });
        selected.clear();
        for (const [e, sel] of base) selected.set(e, sel);
        for (const [e, sel] of placementsInClientRect(r)) selected.set(e, sel);
        renderFrames();
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (moved) {
          removeMarquee();
          return;
        }
        if (!hit) {
          if (selected.size > 0) {
            selected.clear();
            renderFrames();
          }
          return;
        }
        if (shift) {
          if (selected.has(hit.entry)) selected.delete(hit.entry);
          else selected.set(hit.entry, { n: hit.n, kind: hit.kind });
          renderFrames();
          return;
        }
        selected.clear();
        selected.set(hit.entry, { n: hit.n, kind: hit.kind });
        renderHover(null);
        renderFrames();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };
    const keyHandler = (/** @type {KeyboardEvent} */ ev) => {
      if (!graphicsMode) return;
      const t = ev.target;
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (ev.key === 'Escape' && selected.size > 0) {
        ev.preventDefault();
        ev.stopPropagation();
        selected.clear();
        renderFrames();
        return;
      }
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        validateSelection();
        if (selected.size === 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        deleteSelected();
        return;
      }
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && (ev.key === 'z' || ev.key === 'Z' || ev.key === 'y' || ev.key === 'Y')) {
        ev.preventDefault();
        ev.stopPropagation();
        const redo = ev.key === 'y' || ev.key === 'Y' || ev.shiftKey;
        resetSelection();
        if (redo ? scribe.redo() : scribe.undo()) {
          validateSelection();
          renderFrames();
        }
      }
    };
    // Virtualization rebuilds the page groups on scroll, so the frames re-parent themselves onto the new ones.
    const scrollHandler = () => {
      if (!graphicsMode) return;
      renderFrames();
      renderHover(null);
    };
    const selectionCounts = () => {
      validateSelection();
      let images = 0;
      let paths = 0;
      for (const sel of selected.values()) {
        if (sel.kind === 'path') paths += 1;
        else images += 1;
      }
      return { count: selected.size, images, paths };
    };
    scribe.scrollContainer.addEventListener('pointermove', moveHandler);
    scribe.scrollContainer.addEventListener('pointerdown', downHandler, true);
    document.addEventListener('keydown', keyHandler, true);
    scribe.scrollContainer.addEventListener('scroll', scrollHandler);
    scribe._graphicsEditMenuTarget = (clientX, clientY) => {
      const hit = placementAt(clientX, clientY);
      if (!hit) return null;
      validateSelection();
      if (!selected.has(hit.entry)) {
        selected.clear();
        selected.set(hit.entry, { n: hit.n, kind: hit.kind });
        renderHover(null);
        renderFrames();
      }
      return selectionCounts();
    };
    scribe._graphicsEditSelectedCounts = selectionCounts;
    scribe._graphicsEditDeleteSelection = deleteSelected;
    scribe._graphicsEditSelectionAnchor = selectionAnchor;
    scribe._graphicsEditClearSelection = () => {
      selected.clear();
      renderFrames();
    };
    return () => {
      scribe.scrollContainer.removeEventListener('pointermove', moveHandler);
      scribe.scrollContainer.removeEventListener('pointerdown', downHandler, true);
      document.removeEventListener('keydown', keyHandler, true);
      scribe.scrollContainer.removeEventListener('scroll', scrollHandler);
      scribe._graphicsEditActive = false;
      scribe._graphicsEditMenuTarget = null;
      scribe._graphicsEditSelectedCounts = null;
      scribe._graphicsEditDeleteSelection = null;
      scribe._graphicsEditSelectionAnchor = null;
      scribe._graphicsEditClearSelection = null;
      resetSelection();
      hideTouchCallout();
    };
  }

  return { toolbarElem, installBehaviors };
}

/**
 * Toolbar control that toggles the Fill & Sign palette for placing checks, crosses, and signatures.
 * @param {import('../../basic-viewer/pdf-viewer.js').ScribePDFViewer} app
 * @returns {{ toolbarElem: HTMLElement, installBehaviors: () => (() => void), isOpen: () => boolean, close: () => void, paletteElem: () => ?HTMLElement }}
 */
export function createFillSignTool(app) {
  const toolbarElem = makeIconButton('Fill & Sign', ICON_FILLSIGN);
  toolbarElem.classList.add('cr-labeled-button');
  const toolbarLabelElem = document.createElement('span');
  toolbarLabelElem.className = 'cr-btn-label';
  toolbarLabelElem.textContent = 'Fill & Sign';
  toolbarElem.appendChild(toolbarLabelElem);
  /** @type {?ReturnType<typeof createFillSignPalette>} */
  let palette = null;
  let open = false;
  const setOpen = (next) => {
    open = next;
    toolbarElem.classList.toggle('active', open);
    if (open) {
      if (!palette) {
        palette = createFillSignPalette(app);
        app.pdfViewerElem.appendChild(palette.elem);
      }
      palette.show();
    } else if (palette) {
      palette.hide();
    }
  };
  toolbarElem.addEventListener('click', () => {
    if (toolbarElem.classList.contains('disabled')) return;
    setOpen(!open);
  });

  function installBehaviors() {
    return () => {
      if (palette) palette.destroy();
      palette = null;
    };
  }

  return {
    toolbarElem,
    installBehaviors,
    isOpen: () => open,
    close: () => setOpen(false),
    paletteElem: () => (palette ? palette.elem : null),
  };
}

/**
 * The "Edit Pages" mode tool.
 * While the mode is active the thumbnail rail arms its page mutations: drag to reorder, select to rotate or delete.
 * Out of the mode the rail is navigation-only, so a click goes to the page and a drag scrolls.
 * @param {import('../../basic-viewer/pdf-viewer.js').ScribePDFViewer} app
 * @returns {{ toolbarElem: HTMLElement, isActive: () => boolean, close: () => void }}
 */
export function createEditPagesTool(app) {
  const toolbarElem = makeIconButton('Edit Pages', EDIT_PAGES_SVG);
  toolbarElem.classList.add('cr-labeled-button');
  const toolbarLabelElem = document.createElement('span');
  toolbarLabelElem.className = 'cr-btn-label';
  toolbarLabelElem.textContent = 'Edit Pages';
  toolbarElem.appendChild(toolbarLabelElem);
  // The rail gates its mutations on this mode only once the control exists, so hosts without it keep the always-armed rail.
  app.scribe._editPagesGate = true;
  let active = false;
  const setActive = (next) => {
    if (active === next) return;
    active = next;
    toolbarElem.classList.toggle('active', active);
    // Dress and widen before any auto-open.
    // The open animation reads the panel width when it starts, so this order slides the rail in at the mode's final width.
    app._thumbnailPanel?.setPageEditMode(active);
    if (active && app._activeSidebar !== 'thumbnails') app._requestSidebar('thumbnails');
  };
  toolbarElem.addEventListener('click', () => {
    if (toolbarElem.classList.contains('disabled')) return;
    setActive(!active);
  });
  return { toolbarElem, isActive: () => active, close: () => setActive(false) };
}

const EXTRACT_TABLES_MODE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
  + ' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<rect x="4" y="4.5" width="16" height="15" rx="1.5"/><path d="M4 9.5h16M4 14.5h16M9.5 9.5v10"/></svg>';

/**
 * The Extract Tables mode tool: the surface for reviewing and exporting the document's tables.
 * @param {import('../../basic-viewer/pdf-viewer.js').ScribePDFViewer} app
 * @returns {{ toolbarElem: HTMLElement, isActive: () => boolean, close: () => void }}
 */
export function createExtractTablesTool(app) {
  const toolbarElem = makeIconButton('Extract Tables', EXTRACT_TABLES_MODE_SVG);
  toolbarElem.classList.add('cr-labeled-button');
  const toolbarLabelElem = document.createElement('span');
  toolbarLabelElem.className = 'cr-btn-label';
  toolbarLabelElem.textContent = 'Extract Tables';
  toolbarElem.appendChild(toolbarLabelElem);
  let active = false;
  let previewOn = false;
  /** @type {?string} */
  let priorDisplayMode = null;

  // The Page and Preview export view toggle, mounted into the mode banner while this mode is active.
  const viewSeg = document.createElement('span');
  viewSeg.className = 'scribe-mode-banner-viewseg';
  Object.assign(viewSeg.style, {
    display: 'inline-flex', border: '1px solid var(--scribe-line-strong)', borderRadius: '6px', overflow: 'hidden', margin: '0 2px 0 10px', flex: 'none',
  });
  const segBtn = (label, view) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.tableView = view;
    b.textContent = label;
    Object.assign(b.style, {
      border: 'none', background: 'var(--scribe-surface)', color: 'var(--scribe-ink-2)', font: '600 11px/1 inherit', fontFamily: 'inherit', padding: '4.5px 10px', cursor: 'pointer',
    });
    viewSeg.appendChild(b);
    return b;
  };
  const pageBtn = segBtn('Page', 'page');
  const previewBtn = segBtn('Preview Export', 'preview');
  previewBtn.style.borderLeft = '1px solid var(--scribe-line-strong)';
  const syncSeg = () => {
    [pageBtn, previewBtn].forEach((b) => {
      const on = (b === previewBtn) === previewOn;
      b.style.background = on ? 'var(--scribe-accent)' : 'var(--scribe-surface)';
      b.style.color = on ? 'var(--scribe-accent-ink)' : 'var(--scribe-ink-2)';
      b.style.cursor = on ? 'default' : 'pointer';
    });
  };
  const previewKey = (e) => {
    const t = /** @type {?HTMLElement} */ (e.target);
    if (t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const nativeSel = window.getSelection && window.getSelection();
    if (nativeSel && !nativeSel.isCollapsed) return;
    const arrow = {
      ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
    }[e.key];
    if (arrow && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (moveTablePreviewSelection(app.scribe, arrow[0], arrow[1], e.shiftKey)) e.preventDefault();
      return;
    }
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = e.key.toLowerCase();
    if (key !== 'c' && key !== 'a') return;
    const handled = key === 'c' ? !!copyTablePreviewSelection(app.scribe) : selectAllTablePreviewCells(app.scribe);
    if (handled) e.preventDefault();
  };

  const setPreview = (on) => {
    if (on === previewOn) return;
    const sv = app.scribe;
    previewOn = on;
    sv.state.tablePreview = on;
    if (on) {
      priorDisplayMode = sv.state.displayMode;
      sv.state.displayMode = 'ebook';
      // A column selection left by the page view would render as a phantom blue fill over the sheet.
      sv.CanvasSelection.deselectAll();
      document.addEventListener('keydown', previewKey);
    } else {
      document.removeEventListener('keydown', previewKey);
      sv.state.displayMode = priorDisplayMode || 'invis';
      priorDisplayMode = null;
      // The refresh below re-derives only the render window, so sheet elements parked on other pages are swept directly.
      for (const pc of sv.pageContainerArr) pc?.querySelectorAll('[data-scribe-tp]').forEach((el) => el.remove());
      for (const g of sv._overlayGroups || []) g?.querySelectorAll('[data-scribe-tp]').forEach((el) => el.remove());
    }
    // A display-mode change invalidates every rendered text layer, not just the visible window, as an engine switch does.
    // Pages built under the old mode would otherwise stay registered, and scrolling to one later skips its rebuild, leaving its tables as empty grids.
    sv.destroyText(false);
    // The toggle re-renders in place rather than navigating, so the active sheet heals to a table on the current page instead of the view jumping to whichever table was last active.
    let sheet = on ? resolveActiveSheet(sv) : null;
    if (on && sheet && sheet.n !== sv.state.cp.n) {
      const cur = sv.doc.layoutDataTables.pages[sv.state.cp.n];
      if (cur && cur.tables.length > 0) {
        sv.state.activeTableId = cur.tables[0].id;
        sheet = resolveActiveSheet(sv);
      }
    }
    sv.displayPage(sv.state.cp.n, false, true);
    // Nothing was edited, but the heal above can move the active table, and this is how the panel's list adopts it.
    if (sheet) sv.layoutTablesEdited(sheet.n);
    syncSeg();
  };
  pageBtn.addEventListener('click', () => setPreview(false));
  previewBtn.addEventListener('click', () => setPreview(true));
  syncSeg();

  const setActive = (next) => {
    if (active === next) return;
    const sv = app.scribe;
    if (next && !sv.doc) return;
    active = next;
    toolbarElem.classList.toggle('active', active);
    if (!active && previewOn) setPreview(false);
    // One flag gates the layout overlays, the selection fork, and the context-menu table verbs together.
    sv.state.layoutMode = active;
    if (active) {
      sv.clearTextSelection?.();
      // Re-displayed so that displayPage's layout branch paints the window pages' overlays now that the flag is on.
      sv.displayPage(sv.state.cp.n, false, false);
      app._automatePanel?.openTablesWorkspace();
    } else {
      sv.destroyControls();
      sv.destroyOverlay(false);
      // Re-render the window pages' words to restore the fills the preview's ghosting replaced.
      if (sv.doc) {
        for (let n = 0; n < sv.doc.pageMetrics.length; n++) {
          if (sv.rowDistance(n, sv.state.cp.n) < 2) sv.renderWords(n);
        }
      }
      app._automatePanel?.closeTablesWorkspace();
    }
  };
  toolbarElem.addEventListener('click', () => {
    if (toolbarElem.classList.contains('disabled')) return;
    setActive(!active);
  });

  /* Re-derives this mode's surfaces for a newly opened document, since a tab switch keeps the mode running.
     The shell has to call this after the new document's first displayPage, or the navigation below is overridden. */
  const docChanged = () => {
    if (!active) return;
    const sv = app.scribe;
    if (previewOn) {
      const sheet = resolveActiveSheet(sv);
      // A still-extracting document may yet detect tables, so only a settled tableless one drops the preview.
      if (!sheet && !sv.doc._textReadySettle) setPreview(false);
      else if (sheet && sheet.n !== sv.state.cp.n) sv.displayPage(sheet.n, true, true);
    }
    app._automatePanel?.openTablesWorkspace();
  };

  // The catalog row's entry point, which unlike the toolbar button never toggles the mode off.
  const open = () => {
    if (active) app._automatePanel?.openTablesWorkspace();
    else setActive(true);
  };

  return {
    toolbarElem, isActive: () => active, open, close: () => setActive(false), viewSegElem: () => viewSeg, docChanged,
  };
}

/**
 * The "Recognize Text" mode tool.
 * The mode's banner carries its working surface — the recognition language and the Start control — so this tool is only the row button and its active state.
 * @returns {{ toolbarElem: HTMLElement, isActive: () => boolean, close: () => void }}
 */
export function createRecognizeTextTool() {
  const toolbarElem = makeIconButton('Recognize Text', RECOGNIZE_SVG);
  toolbarElem.classList.add('cr-labeled-button');
  const toolbarLabelElem = document.createElement('span');
  toolbarLabelElem.className = 'cr-btn-label';
  toolbarLabelElem.textContent = 'Recognize Text';
  toolbarElem.appendChild(toolbarLabelElem);
  let active = false;
  const setActive = (next) => {
    if (active === next) return;
    active = next;
    toolbarElem.classList.toggle('active', active);
  };
  toolbarElem.addEventListener('click', () => {
    if (toolbarElem.classList.contains('disabled')) return;
    setActive(!active);
  });
  return { toolbarElem, isActive: () => active, close: () => setActive(false) };
}
