// Document interaction tools shared by the viewer and editor apps: text highlighting
// (toggle, color picker, comment marks), the upload drop zone, and the file-to-ScribeDoc loader.
import scribeLib from '../../../scribe.js';
import { makeIconButton } from './toolbar.js';
import {
  applyHighlight, createInkEdges, recolorHighlightGroup, removeHighlightGroup, setHighlightReplies,
} from '../viewerHighlights.js';
import {
  createNote, focusNoteEditor, removeNote, setNoteComment,
} from '../viewerNotes.js';
import { redactWords, redactRegion } from '../viewerRedactions.js';
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
    const paletteKeydown = (event) => { if (event.key === 'Escape') closePalette(); };
    if (paletteElem) {
      document.addEventListener('click', paletteOutsideClick);
      document.addEventListener('keydown', paletteKeydown);
    }

    // ---- Comment card: the one floating surface for a highlight or a note ----
    // Behaviors are delegated from the viewer root because marks are rebuilt with every fill-layer or notes-layer render.
    const editorHost = scribe.outerElem || scribe.elem;
    const cmtCard = document.createElement('div');
    cmtCard.className = 'scribe-cmt-card';
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

    // Verb footer, shown only on the pinned card.
    const cmtFoot = document.createElement('div');
    cmtFoot.className = 'scribe-cmt-foot';
    // The coin stack is one control at rest, so it holds the only tab stop until fanning gives the coins their own.
    const cmtCoins = document.createElement('span');
    cmtCoins.className = 'scribe-hl-coins';
    cmtCoins.title = 'Highlight color';
    cmtCoins.setAttribute('role', 'button');
    cmtCoins.setAttribute('aria-label', 'Highlight color');
    cmtCoins.setAttribute('aria-expanded', 'false');
    cmtCoins.tabIndex = 0;
    /** @type {Array<HTMLButtonElement>} */
    const cmtSwatches = [];
    const coinsOpen = () => cmtCoins.classList.contains('open');
    const expandCoins = () => {
      cmtCoins.classList.add('open');
      cmtCoins.setAttribute('aria-expanded', 'true');
      cmtSwatches.forEach((b) => { b.tabIndex = 0; });
    };
    const collapseCoins = () => {
      cmtCoins.classList.remove('open');
      cmtCoins.setAttribute('aria-expanded', 'false');
      cmtSwatches.forEach((b) => { b.tabIndex = -1; });
    };
    /**
     * Put `sw` on top of the stack (first coin, descending z behind it) and mark it active.
     * @param {HTMLButtonElement} sw
     */
    const setTopCoin = (sw) => {
      cmtCoins.prepend(sw);
      let i = 0;
      for (const c of cmtCoins.children) {
        // Skip hidden coins, or they leave a hole in the fan.
        if (/** @type {HTMLElement} */ (c).style.display === 'none') continue;
        /** @type {HTMLElement} */ (c).style.setProperty('--coin-i', String(i));
        /** @type {HTMLElement} */ (c).style.zIndex = String(cmtSwatches.length - i);
        i += 1;
      }
      cmtSwatches.forEach((b) => b.classList.toggle('active', b === sw));
    };
    // One extra "editorial red" coin for line markups (underline/strikeout), a color the highlight palette deliberately lacks.
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
      cmtCoins.appendChild(sw);
    }
    setTopCoin(cmtSwatches[0]);
    const cmtSpring = document.createElement('span');
    cmtSpring.className = 'scribe-cmt-foot-spring';
    /**
     * @param {string} title
     * @param {string} svg
     * @returns {HTMLButtonElement}
     */
    const makeFootButton = (title, svg) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'scribe-cmt-vb';
      btn.title = title;
      btn.setAttribute('aria-label', title);
      btn.innerHTML = svg;
      return btn;
    };
    const cmtPanelBtn = makeFootButton('Show in comments panel', TB_PANEL_SVG);
    const cmtDelete = makeFootButton('Delete highlight', TB_DELETE_SVG);
    cmtDelete.classList.add('scribe-cmt-vb-del');
    cmtFoot.append(cmtCoins, cmtSpring, cmtPanelBtn, cmtDelete);
    cmtCard.append(cmtQuoteRow, cmtThread, cmtFoot);
    editorHost.appendChild(cmtCard);

    /**
     * On a highlight target, `slot` selects the highlight fill (default) or the line markup (underline/strikeout) the card is editing.
     * @type {?({kind: 'highlight', slot?: ('highlight'|'line'), kw: import('../viewerWordObjects.js').UiOcrWord, groupId: ?string, n: number} | {kind: 'note', annot: Object, n: number})}
     */
    let cmtTarget = null;
    let cmtPinned = false;
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
    const dateShort = (iso) => {
      const d = new Date(iso);
      /** @type {Intl.DateTimeFormatOptions} */
      const dateOpts = { month: 'short', day: 'numeric' };
      if (d.getFullYear() !== new Date().getFullYear()) dateOpts.year = 'numeric';
      return d.toLocaleDateString(undefined, dateOpts);
    };

    /**
     * One thread message: identity line (avatar, name, date) over the text.
     * @param {string} idx - 'root' or the reply index, for edit commits.
     */
    const makeMsg = (idx, text, author, createdAt) => {
      const msg = document.createElement('div');
      msg.className = 'scribe-cmt-msg';
      msg.dataset.reply = idx;
      if (author || createdAt) {
        const meta = document.createElement('div');
        meta.className = 'scribe-cmt-meta';
        if (author) {
          const ava = document.createElement('span');
          ava.className = 'scribe-cm-ava';
          ava.textContent = initialsOf(author);
          const who = document.createElement('span');
          who.className = 'scribe-cm-who';
          who.textContent = author;
          meta.append(ava, who);
        }
        if (createdAt) {
          const when = document.createElement('span');
          when.className = 'scribe-cm-when';
          when.textContent = `· ${dateShort(createdAt)}`;
          meta.appendChild(when);
        }
        msg.appendChild(meta);
      }
      const mtext = document.createElement('div');
      mtext.className = 'scribe-cmt-mtext';
      mtext.textContent = text;
      msg.appendChild(mtext);
      return msg;
    };

    /** Rebuild the thread: root + replies, the preview's collapse marking, and the composer. */
    const renderThread = (annot, kind) => {
      cmtEditEl = null;
      cmtThread.replaceChildren();
      const msgs = [];
      if (annot && annot.comment) msgs.push(makeMsg('root', annot.comment, annot.author || '', annot.createdAt || ''));
      const replies = (annot && annot.replies) || [];
      replies.forEach((r, i) => msgs.push(makeMsg(String(i), r.text, r.author || '', r.createdAt || '')));
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
      cmtThread.appendChild(cmtReply);
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
        cmtCoins.style.display = '';
        for (const b of cmtSwatches) {
          if (b.dataset.markupOnly) b.style.display = isLine ? '' : 'none';
        }
        const currentSw = cmtSwatches.find((b) => b.dataset.color === color.toLowerCase() && (!b.dataset.markupOnly || isLine));
        // A colour outside the palette (an imported highlight) leaves the stack order alone, nothing active.
        if (currentSw) setTopCoin(currentSw);
        else cmtSwatches.forEach((b) => b.classList.remove('active'));
        const verb = isLine
          ? (((annot && annot.type) || target.kw.markupType) === 'strikeout' ? 'Delete strikethrough' : 'Delete underline')
          : 'Delete highlight';
        cmtDelete.title = verb;
        cmtDelete.setAttribute('aria-label', verb);
      } else {
        cmtQuote.textContent = `note · page ${target.n + 1}`;
        cmtBar.style.background = 'var(--scribe-note)';
        cmtCoins.style.display = 'none';
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
      cmtTarget = null;
      collapseCoins();
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
      if (cmtPinned && cmtSameTarget(cmtTarget, target)) { cmtText.focus(); return; }
      cmtPinned = false;
      cmtTarget = target;
      cmtFill(target);
      // Pin the class before placing: the composer and footer only lay out on the pinned card,
      // so measuring first would size and place the card from the preview's geometry.
      cmtCard.classList.add('pinned');
      if (!cmtPlace(target)) { cmtClose(); return; }
      cmtPinned = true;
      setCmtSel(true);
      // Focus last so it cannot scroll the container before the card is positioned.
      cmtText.focus();
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
      // An open coin fan folds when the click lands anywhere else on the card.
      if (coinsOpen() && !(e.target instanceof Node && cmtCoins.contains(e.target))) collapseCoins();
      // Clicking the preview is the pointer's "edit this" on the card itself, same as clicking the mark.
      if (!cmtPinned && cmtTarget) { cmtPin(cmtTarget); return; }
      const mtext = e.target instanceof Element && e.target.closest('.scribe-cmt-mtext');
      if (mtext instanceof HTMLElement && cmtPinned) beginMsgEdit(mtext);
    });
    cmtText.addEventListener('input', cmtGrow);
    cmtCard.addEventListener('keydown', (e) => {
      // Keep typing out of page shortcuts.
      e.stopPropagation();
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        // Do not re-place after the re-render: the card grows in place, as it already does while typing grows the field.
        e.preventDefault();
        if (cmtCommit() && cmtTarget) {
          cmtFill(cmtTarget);
          cmtText.focus();
        }
        return;
      }
      if (e.key !== 'Escape') return;
      // Esc folds inward: an open coin fan, an in-place message edit, a composer draft, then the card.
      if (coinsOpen()) { collapseCoins(); return; }
      if (cmtEditEl) { cancelMsgEdit(); return; }
      if (cmtText.value.trim()) { cmtText.value = ''; cmtGrow(); return; }
      const markEl = cmtTarget && cmtMarkEl(cmtTarget);
      // Focus the mark before closing, not after: once the card is unpinned the mark's focusin would re-show it as a preview.
      if (markEl) /** @type {HTMLElement} */ (markEl).focus();
      cmtClose();
    });

    // The quote row drags the card.
    cmtQuoteRow.addEventListener('mousedown', (e) => {
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

    // ---- footer verbs ----
    cmtCoins.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!coinsOpen()) {
        expandCoins();
        return;
      }
      const sw = e.target instanceof Element
        ? /** @type {?HTMLButtonElement} */ (e.target.closest('.highlight-color-btn')) : null;
      if (sw && cmtTarget && cmtTarget.kind === 'highlight') {
        const color = /** @type {string} */ (sw.dataset.color);
        setCmtSel(false);
        recolorHighlightGroup(scribe, cmtTarget.kw, color, cmtTarget.slot || 'highlight');
        // The recolor rebuilt the fill layer, so re-ink the fresh bands and recolor the quote bar.
        setCmtSel(true);
        cmtBar.style.background = color;
        setTopCoin(sw);
        if (scribe._rebuildCommentsPanel) scribe._rebuildCommentsPanel();
      }
      collapseCoins();
    });
    cmtCoins.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      if (coinsOpen()) collapseCoins();
      else expandCoins();
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

    // Notes' single editor entry (the note tool, the Comments panel, focusNoteEditor) pins the card.
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

// A speech-bubble-with-plus glyph for the note tool.
// eslint-disable-next-line max-len
const NOTE_TOOL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" height="20" width="20" viewBox="0 0 24 24" fill="currentColor"><path d="M4 3h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H9l-4 4v-4H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm7 3v3H8v2h3v3h2v-3h3V9h-3V6h-2z"/></svg>';

/**
 * Build the freestanding-note tool: a toolbar button that drops a note at the top-right of the current page and puts the cursor in its inline editor.
 * The user drags the note's mark to reposition it rather than clicking to place it.
 * @param {import('../../viewer.js').ScribeViewer} scribe
 * @returns {{ toolbarElem: HTMLSpanElement, installBehaviors: () => (() => void) }}
 */
export function createNoteTool(scribe) {
  const toolbarElem = makeIconButton('Add note', NOTE_TOOL_SVG);

  toolbarElem.addEventListener('click', () => {
    const n = scribe.state?.cp?.n ?? 0;
    const pm = scribe.doc.pageMetrics[n];
    if (!pm) return;
    // Place the mark at the top-right of the page, clear of the edge.
    const x = Math.max(0, pm.dims.width - 46);
    const annot = createNote(scribe, n, x, 22);
    scribe.renderNotes(n);
    focusNoteEditor(scribe, n, annot);
  });

  // Placement is immediate, so there are no page-level behaviors to install.
  function installBehaviors() { return () => {}; }

  return { toolbarElem, installBehaviors };
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

  const title = document.createElement('div');
  title.className = 'scribe-drop-title';
  title.textContent = 'Drop a PDF to get started';

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
 * @returns {Promise<import('../../../js/containers/scribeDoc.js').ScribeDoc>}
 */
export async function openDocumentFromFile(file, { deferText = false } = {}) {
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

  const doc = await scribeLib.openDocument(input, deferText ? { deferText: true } : undefined);

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
