// Document interaction tools shared by the viewer and editor apps: text highlighting
// (toggle, color picker, comment icons), the upload drop zone, and the file-to-ScribeDoc loader.
import scribeLib from '../../../scribe.js';
import { makeIconButton } from './toolbar.js';
import { applyHighlight, recolorHighlightGroup, removeHighlightGroup } from '../viewerHighlights.js';
import { createNote, focusNoteEditor } from '../viewerNotes.js';
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

// Mini-toolbar action glyphs (comment bubble / copy / trash), sized by the `.scribe-hl-tb-btn svg` rule.
// eslint-disable-next-line max-len
const TB_COMMENT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" stroke-linejoin="round"/></svg>';
// eslint-disable-next-line max-len
const TB_COPY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5.5" y="5.5" width="7" height="8" rx="1"/><path d="M3.5 10.5v-7a1 1 0 0 1 1-1h5"/></svg>';
// eslint-disable-next-line max-len
const TB_DELETE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5v-1.5h3v1.5M4.5 4.5l.7 8h5.6l.7-8" stroke-linejoin="round"/></svg>';
// eslint-disable-next-line max-len
const TB_GRIP_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 14" width="8" height="14" fill="currentColor" aria-hidden="true"><circle cx="2" cy="2" r="1.2"/><circle cx="6" cy="2" r="1.2"/><circle cx="2" cy="7" r="1.2"/><circle cx="6" cy="7" r="1.2"/><circle cx="2" cy="12" r="1.2"/><circle cx="6" cy="12" r="1.2"/></svg>';
// eslint-disable-next-line max-len
const TB_PANEL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M6 2.5v11"/></svg>';

/**
 * Build the highlight tool: toggle button, optional color picker, overlay-word highlighting, highlighter cursor, and comment icons.
 * The toolbar DOM is built immediately. The selection/comment behaviors are wired by `installBehaviors()` after `scribe.init`.
 * @param {import('../../viewer.js').ScribeViewer} scribe
 * @param {HTMLElement} rootElem - The app's root element (for selection scope and cursor CSS).
 * @param {object} cfg
 * @param {string[]} cfg.colors - One or more hex colors.
 * @param {string} cfg.defaultColor - Initial color (must be in `colors`).
 * @param {string} cfg.rootClass - The app's root class (for scoping the cursor rule).
 * @returns {{
 *   highlightElem: HTMLSpanElement, toolbarElem: HTMLSpanElement,
 *   getSelectedOverlayWords: () => Array<import('../viewerWordObjects.js').UiOcrWord>, updateCommentIcons: () => void,
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
  /** @type {?HTMLDivElement} */
  let commentTooltip = null;
  /**
   * Opens the highlight card (mini toolbar) with its comment editor expanded, anchored to `words[0]`.
   * Assigned by `installBehaviors`.
   * Called from the comment icon and (via `scribe._openCommentEditor`) the context menu.
   * @type {?(words: Array<import('../viewerWordObjects.js').UiOcrWord>) => void}
   */
  let openCommentEditor = null;

  const highlightElem = makeIconButton('Highlight', HIGHLIGHT_SVG);
  const tipPath = highlightElem.querySelector('.scribe-hl-tip');
  const setTipColor = (c) => { if (tipPath && c) tipPath.style.fill = c; };
  setTipColor(highlightColor);

  /** Toggle the highlighter cursor on the overlay words when highlight mode is active. */
  function updateHighlightCursorStyle() {
    if (!cursorStyleElem) {
      cursorStyleElem = document.createElement('style');
      document.head.appendChild(cursorStyleElem);
    }
    cursorStyleElem.textContent = highlightMode
      ? `.${rootClass} .scribe-word { cursor: ${HIGHLIGHT_CURSOR} !important; }`
      : '';
  }

  /** UiOcrWord objects under the current browser text selection (via the HTML overlay). */
  function getSelectedOverlayWords() {
    return scribe.getWordsUnderTextSelection();
  }

  function applyToSelection() {
    const matchedWords = getSelectedOverlayWords();
    if (matchedWords.length === 0 || !highlightColor) return false;
    applyHighlight(scribe, matchedWords, highlightColor, 0.5);
    window.getSelection()?.removeAllRanges();
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

  /** Place one comment icon for a highlight group, anchored at its first word's overlay element. */
  const addCommentIcon = (kw, viewerElem) => {
    const wordElem = viewerElem.querySelector(`.scribe-word[id="${kw.word.id}"]`);
    if (!wordElem) return;
    const wordLeft = parseFloat(/** @type {HTMLElement} */ (wordElem).style.left) || 0;
    const wordTop = parseFloat(/** @type {HTMLElement} */ (wordElem).style.top) || 0;

    const icon = document.createElement('span');
    icon.className = 'highlight-comment-icon';
    icon.textContent = '💬';
    icon.style.left = `${wordLeft - 16}px`;
    icon.style.top = `${wordTop - 14}px`;

    icon.addEventListener('mouseover', () => {
      if (!commentTooltip) return;
      commentTooltip.textContent = kw.highlightComment;
      commentTooltip.style.visibility = 'hidden';
      commentTooltip.style.display = '';
      const iconLeft = parseFloat(icon.style.left) || 0;
      const iconTop = parseFloat(icon.style.top) || 0;
      commentTooltip.style.left = `${iconLeft}px`;
      commentTooltip.style.top = `${iconTop - commentTooltip.offsetHeight - 4}px`;
      commentTooltip.style.visibility = '';
    });
    icon.addEventListener('mouseout', () => {
      if (commentTooltip) commentTooltip.style.display = 'none';
    });
    icon.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openCommentEditor) openCommentEditor([kw]);
    });

    viewerElem.appendChild(icon);
  };

  /** Rebuild the comment icons: one per highlight group that carries a comment. */
  function updateCommentIcons() {
    const viewerElem = scribe.elem;
    if (!viewerElem) return;
    viewerElem.querySelectorAll('.highlight-comment-icon').forEach((el) => el.remove());

    const allWords = scribe.getUiWords();
    if (!allWords || allWords.length === 0) return;

    const groupFirstWord = new Map();
    for (const kw of allWords) {
      if (!kw.highlightGroupId || !kw.highlightComment) continue;
      const existing = groupFirstWord.get(kw.highlightGroupId);
      if (!existing
        || kw.word.bbox.top < existing.word.bbox.top
        || (kw.word.bbox.top === existing.word.bbox.top && kw.word.bbox.left < existing.word.bbox.left)) {
        groupFirstWord.set(kw.highlightGroupId, kw);
      }
    }

    for (const [, kw] of groupFirstWord) addCommentIcon(kw, viewerElem);
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

    commentTooltip = document.createElement('div');
    commentTooltip.className = 'highlight-comment-tooltip';
    commentTooltip.style.display = 'none';
    scribe.elem.appendChild(commentTooltip);

    // Mini highlight toolbar: clicking a highlight floats a small card above it.
    // Mounted on the unzoomed outer element and positioned from the clicked word's screen rect, so it lands correctly at any zoom.
    const editorHost = scribe.outerElem || scribe.elem;
    const hlToolbar = document.createElement('div');
    hlToolbar.className = 'scribe-hl-toolbar';
    hlToolbar.style.display = 'none';
    hlToolbar.addEventListener('mousedown', (e) => e.stopPropagation());
    const hlToolbarRow = document.createElement('div');
    hlToolbarRow.className = 'scribe-hl-tb-row';
    hlToolbar.appendChild(hlToolbarRow);
    /** @type {?import('../viewerWordObjects.js').UiOcrWord} The clicked word whose highlight the open toolbar targets. */
    let hlToolbarWord = null;
    /** The user dragged the card during this open: leave it where they put it. */
    let hlToolbarMoved = false;
    /** A drag just ended: the gesture's trailing click must not be read as an outside click. */
    let hlToolbarJustDragged = false;
    /** @type {?() => void} Ends an in-flight grip drag (teardown safety). */
    let hlToolbarDragEnd = null;

    // Drag grip: the card is repositionable so it can be moved off anything it covers.
    const tbGrip = document.createElement('span');
    tbGrip.className = 'scribe-hl-tb-grip';
    tbGrip.title = 'Move';
    tbGrip.setAttribute('aria-label', 'Move card');
    tbGrip.innerHTML = TB_GRIP_SVG;
    hlToolbarRow.appendChild(tbGrip);
    tbGrip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const h = editorHost.getBoundingClientRect();
      const r = hlToolbar.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      let dragMoved = false;
      hlToolbar.classList.add('dragging');
      /** @param {MouseEvent} ev */
      const move = (ev) => {
        dragMoved = true;
        hlToolbar.style.left = `${Math.max(4, Math.min(ev.clientX - h.left - dx, h.width - r.width - 4))}px`;
        hlToolbar.style.top = `${Math.max(4, Math.min(ev.clientY - h.top - dy, h.height - r.height - 4))}px`;
      };
      const up = () => {
        hlToolbar.classList.remove('dragging');
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        hlToolbarDragEnd = null;
        if (!dragMoved) return;
        hlToolbarMoved = true;
        hlToolbarJustDragged = true;
        // The gesture's click fires right after mouseup.
        // Failing that, clear on the next tick.
        setTimeout(() => { hlToolbarJustDragged = false; }, 0);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      hlToolbarDragEnd = up;
    });

    /**
     * The fill bands of the toolbar's target highlight: its group's bands, or the clicked word's own band when it belongs to no group.
     * @returns {Element[]}
     */
    const hlToolbarBands = () => {
      const kw = hlToolbarWord;
      if (!kw) return [];
      if (!kw.highlightGroupId) return kw.highlightRectElem ? [kw.highlightRectElem] : [];
      const bands = [];
      for (const map of scribe._highlightRectsByGroup) {
        const arr = map && map.get(kw.highlightGroupId);
        if (arr) bands.push(...arr);
      }
      return bands;
    };
    /**
     * Toggle the sustained selected lift (`scribe-hl-sel`) on the toolbar's target highlight bands.
     * @param {boolean} on
     */
    const setHlToolbarSel = (on) => {
      for (const band of hlToolbarBands()) band.classList.toggle('scribe-hl-sel', on);
    };

    /**
     * Place the open comment card beside its highlight's bands, or below them.
     * Take whichever candidate sits nearest the clicked word, the least shift from where the user is looking.
     * When exactly one candidate would cover the highlight, take the other instead.
     * @param {Element} wordEl
     */
    const placeCardBesideHighlight = (wordEl) => {
      const rects = hlToolbarBands().map((b) => b.getBoundingClientRect());
      if (rects.length === 0) rects.push(wordEl.getBoundingClientRect());
      const h = editorHost.getBoundingClientRect();
      // The highlight's union, in host coordinates.
      const union = {
        left: Math.min(...rects.map((r) => r.left)) - h.left,
        right: Math.max(...rects.map((r) => r.right)) - h.left,
        top: Math.min(...rects.map((r) => r.top)) - h.top,
        bottom: Math.max(...rects.map((r) => r.bottom)) - h.top,
      };
      const w = hlToolbar.offsetWidth;
      const cardH = hlToolbar.offsetHeight;
      const clampX = (x) => Math.max(4, Math.min(x, h.width - w - 4));
      const clampY = (y) => Math.max(4, Math.min(y, h.height - cardH - 4));
      // Candidate A (beside): right of the union (left of it when there is no room), top-aligned.
      let aLeft = union.right + 10;
      if (aLeft + w > h.width - 4) aLeft = union.left - w - 10;
      aLeft = clampX(aLeft);
      const aTop = clampY(union.top);
      // Candidate B (below): under the union, left-aligned with the clicked word.
      const wr = wordEl.getBoundingClientRect();
      const bLeft = clampX(wr.left - h.left);
      const bTop = clampY(union.bottom + 8);
      const covers = (l, t) => l < union.right && l + w > union.left && t < union.bottom && t + cardH > union.top;
      // Shift = the gap between the clicked word's rect and the candidate card rect (0 when they touch).
      const wl = wr.left - h.left;
      const wt = wr.top - h.top;
      const dist = (l, t) => Math.hypot(
        Math.max(0, l - (wl + wr.width), wl - (l + w)),
        Math.max(0, t - (wt + wr.height), wt - (t + cardH)),
      );
      let below = dist(bLeft, bTop) < dist(aLeft, aTop);
      if (covers(bLeft, bTop) !== covers(aLeft, aTop)) below = covers(aLeft, aTop);
      hlToolbar.style.left = `${below ? bLeft : aLeft}px`;
      hlToolbar.style.top = `${below ? bTop : aTop}px`;
    };

    // The comment half of the card: a grid-rows wrapper (0fr <-> 1fr) so it slides open and closed without ever leaving the card's surface.
    const tbCommentWrap = document.createElement('div');
    tbCommentWrap.className = 'scribe-hl-tb-comment';
    const tbCommentInner = document.createElement('div');
    tbCommentWrap.appendChild(tbCommentInner);
    const editorText = document.createElement('textarea');
    editorText.className = 'scribe-comment-editor-text';
    editorText.rows = 3;
    editorText.placeholder = 'Add a comment…';
    const editorMeta = document.createElement('div');
    editorMeta.className = 'scribe-comment-editor-meta';
    const editorBtns = document.createElement('div');
    editorBtns.className = 'scribe-comment-editor-btns';
    const editorDelete = document.createElement('button');
    editorDelete.type = 'button';
    editorDelete.className = 'scribe-comment-editor-delete';
    editorDelete.textContent = 'Delete';
    const editorSave = document.createElement('button');
    editorSave.type = 'button';
    editorSave.className = 'scribe-comment-editor-save';
    editorSave.textContent = 'Save';
    editorBtns.append(editorDelete, editorSave);
    tbCommentInner.append(editorText, editorMeta, editorBtns);
    hlToolbar.appendChild(tbCommentWrap);

    const metaLine = (annot) => {
      const parts = [];
      if (annot && annot.author) parts.push(annot.author);
      if (annot && annot.createdAt) parts.push(new Date(annot.createdAt).toLocaleString());
      return parts.join(' · ');
    };

    const commentOpen = () => hlToolbar.classList.contains('comment-open');
    /**
     * Prefill the comment half from the toolbar's target highlight and slide it open.
     * @param {boolean} focus Put the cursor in the textarea (explicit comment intent, not a mere reveal).
     */
    const expandComment = (focus) => {
      const kw = hlToolbarWord;
      if (!kw) return;
      const annot = (scribe.doc.annotations.pages[kw.word.line.page.n] || []).find(
        (a) => a.groupId && a.groupId === kw.highlightGroupId,
      );
      editorText.value = kw.highlightComment || '';
      const meta = metaLine(annot);
      editorMeta.textContent = meta;
      editorMeta.style.display = meta ? '' : 'none';
      if (commentTooltip) commentTooltip.style.display = 'none';
      hlToolbar.classList.add('comment-open');
      if (focus) {
        editorText.focus();
        editorText.select();
      }
    };
    const collapseComment = () => {
      hlToolbar.classList.remove('comment-open');
      editorText.blur();
    };

    const closeHlToolbar = () => {
      if (!hlToolbarWord) return;
      setHlToolbarSel(false);
      hlToolbarWord = null;
      collapseCoins();
      collapseComment();
      hlToolbar.style.display = 'none';
    };

    editorSave.addEventListener('click', () => {
      if (hlToolbarWord) scribe.modifyHighlightComment([hlToolbarWord], editorText.value.trim());
      updateCommentIcons();
      collapseComment();
    });
    editorDelete.addEventListener('click', () => {
      if (hlToolbarWord) scribe.modifyHighlightComment([hlToolbarWord], '');
      updateCommentIcons();
      collapseComment();
    });
    editorText.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        collapseComment();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        editorSave.click();
      }
    });

    // The color control is a coin stack showing the current color on top.
    // At rest it is a single control (one tab stop), not four targets; the coins are individually clickable only when fanned.
    // Clicking fans them out over the card with pure transforms, so the card never resizes and the verbs never move.
    const tbCoins = document.createElement('span');
    tbCoins.className = 'scribe-hl-coins';
    tbCoins.title = 'Highlight color';
    tbCoins.setAttribute('role', 'button');
    tbCoins.setAttribute('aria-label', 'Highlight color');
    tbCoins.setAttribute('aria-expanded', 'false');
    tbCoins.tabIndex = 0;
    hlToolbarRow.appendChild(tbCoins);
    /** @type {Array<HTMLButtonElement>} */
    const tbSwatches = [];
    const coinsOpen = () => tbCoins.classList.contains('open');
    const expandCoins = () => {
      tbCoins.classList.add('open');
      tbCoins.setAttribute('aria-expanded', 'true');
      // The coins are focusable options only while fanned.
      // At rest the stack is the single tab stop.
      tbSwatches.forEach((b) => { b.tabIndex = 0; });
      // The 16px fan floats over the comment verb next to the stack.
      // Disable it so a click aimed at a coin cannot land on it by mistake.
      tbComment.disabled = true;
    };
    const collapseCoins = () => {
      tbCoins.classList.remove('open');
      tbCoins.setAttribute('aria-expanded', 'false');
      tbSwatches.forEach((b) => { b.tabIndex = -1; });
      tbComment.disabled = false;
    };
    /**
     * Put `sw` on top of the stack (first coin, descending z behind it) and mark it active.
     * @param {HTMLButtonElement} sw
     */
    const setTopCoin = (sw) => {
      tbCoins.prepend(sw);
      let i = 0;
      for (const c of tbCoins.children) {
        /** @type {HTMLElement} */ (c).style.setProperty('--coin-i', String(i));
        /** @type {HTMLElement} */ (c).style.zIndex = String(tbSwatches.length - i);
        i += 1;
      }
      tbSwatches.forEach((b) => b.classList.toggle('active', b === sw));
    };
    for (const color of colors) {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'highlight-color-btn';
      sw.style.backgroundColor = color;
      sw.dataset.color = color.toLowerCase();
      sw.title = 'Recolor highlight';
      sw.setAttribute('aria-label', 'Recolor highlight');
      sw.tabIndex = -1;
      tbSwatches.push(sw);
      tbCoins.appendChild(sw);
    }
    setTopCoin(tbSwatches[0]);
    // One delegated handler: a click on the resting stack only fans it, and a click on a fanned coin recolors and folds.
    tbCoins.addEventListener('click', (e) => {
      if (!coinsOpen()) {
        expandCoins();
        return;
      }
      const sw = e.target instanceof Element
        ? /** @type {?HTMLButtonElement} */ (e.target.closest('.highlight-color-btn')) : null;
      if (sw && hlToolbarWord) {
        setHlToolbarSel(false);
        recolorHighlightGroup(scribe, hlToolbarWord, colors[tbSwatches.indexOf(sw)]);
        // The recolor rebuilt the fill layer, so re-apply the lift to the fresh bands.
        setHlToolbarSel(true);
        setTopCoin(sw);
      }
      collapseCoins();
    });
    tbCoins.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (coinsOpen()) collapseCoins();
      else expandCoins();
    });
    /**
     * The fan folds when the pointer commits anywhere else.
     * @param {MouseEvent} event
     */
    const coinsOutsideClick = (event) => {
      if (!coinsOpen()) return;
      if (event.target instanceof Node && tbCoins.contains(event.target)) return;
      collapseCoins();
    };
    document.addEventListener('click', coinsOutsideClick);

    const tbSep = document.createElement('span');
    tbSep.className = 'scribe-hl-tb-sep';
    hlToolbarRow.appendChild(tbSep);

    /**
     * @param {string} title
     * @param {string} svg
     * @returns {HTMLButtonElement}
     */
    const makeTbButton = (title, svg) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'scribe-hl-tb-btn';
      btn.title = title;
      btn.setAttribute('aria-label', title);
      btn.innerHTML = svg;
      hlToolbarRow.appendChild(btn);
      return btn;
    };

    const tbComment = makeTbButton('Comment', TB_COMMENT_SVG);
    tbComment.addEventListener('click', () => {
      if (commentOpen()) {
        collapseComment();
        return;
      }
      expandComment(false);
      // The growing card must not cover the highlight being commented.
      // Move it beside/below the highlight, unless the user has already dragged it somewhere deliberate.
      const wordEl = hlToolbarWord && scribe.elem.querySelector(`.scribe-word[id="${hlToolbarWord.word.id}"]`);
      if (!hlToolbarMoved && wordEl) placeCardBesideHighlight(wordEl);
      editorText.focus();
      editorText.select();
    });

    const tbCopy = makeTbButton('Copy text', TB_COPY_SVG);
    const tbCopied = document.createElement('span');
    tbCopied.className = 'scribe-hl-tb-copied';
    tbCopied.textContent = 'Copied';
    tbCopy.appendChild(tbCopied);
    tbCopy.addEventListener('click', () => {
      const kw = hlToolbarWord;
      if (!kw) return;
      // The highlight's words in reading order, one text line per OCR line.
      // Snippet-level fidelity is enough here.
      const words = scribe.getUiWords()
        .filter((w) => w.highlightColor && (kw.highlightGroupId
          ? w.highlightGroupId === kw.highlightGroupId
          : w.highlightRectElem === kw.highlightRectElem))
        .sort((a, b) => a.word.line.page.n - b.word.line.page.n
          || a.word.line.bbox.top - b.word.line.bbox.top || a.x() - b.x());
      /** @type {Array<Array<string>>} */
      const lines = [];
      let lastLineId = null;
      for (const w of words) {
        if (w.word.line.id !== lastLineId) { lines.push([]); lastLineId = w.word.line.id; }
        lines[lines.length - 1].push(w.word.text);
      }
      const text = lines.map((ws) => ws.join(' ')).join('\n');
      if (!text) return;
      navigator.clipboard?.writeText(text).catch(() => {});
      tbCopied.classList.add('show');
      setTimeout(() => tbCopied.classList.remove('show'), 900);
    });

    // Only shown when the host installed the panel hook (the editor with the comments sidebar enabled).
    const tbPanel = makeTbButton('Show in comments panel', TB_PANEL_SVG);
    tbPanel.addEventListener('click', () => {
      const kw = hlToolbarWord;
      if (!kw || !scribe._revealCommentInPanel) return;
      scribe._revealCommentInPanel(kw);
      // Opening the sidebar tweens the document inset, shifting the highlight under the still-open card.
      // Once that settles, follow the highlight to its new spot, unless the user dragged the card somewhere deliberate.
      setTimeout(() => {
        if (hlToolbarWord !== kw || hlToolbarMoved) return;
        const wordEl = scribe.elem.querySelector(`.scribe-word[id="${kw.word.id}"]`);
        if (wordEl) placeHlToolbar(wordEl);
      }, 230);
    });

    const tbDelete = makeTbButton('Delete highlight', TB_DELETE_SVG);
    tbDelete.classList.add('scribe-hl-tb-delete');
    tbDelete.addEventListener('click', () => {
      const kw = hlToolbarWord;
      closeHlToolbar();
      if (kw) removeHighlightGroup(scribe, kw);
      updateCommentIcons();
    });

    editorHost.appendChild(hlToolbar);

    /**
     * Position the open card for its current state: the bare pill floats above the word, the comment card sits beside/below the highlight.
     * @param {Element} wordEl
     */
    const placeHlToolbar = (wordEl) => {
      if (commentOpen()) {
        placeCardBesideHighlight(wordEl);
        return;
      }
      const a = wordEl.getBoundingClientRect();
      const h = editorHost.getBoundingClientRect();
      const left = Math.max(4, Math.min(a.left - h.left, h.width - hlToolbar.offsetWidth - 4));
      let top = a.top - h.top - hlToolbar.offsetHeight - 8;
      if (top < 4) top = a.bottom - h.top + 8;
      hlToolbar.style.left = `${left}px`;
      hlToolbar.style.top = `${top}px`;
    };

    /**
     * Open the card on the clicked highlighted word, with the group's current colour marked active and its bands lifted.
     * @param {import('../viewerWordObjects.js').UiOcrWord} kw
     * @param {Element} wordEl
     * @param {boolean} [expandCommentNow] Open with the comment half expanded and focused (comment icon / context menu).
     */
    const openHlToolbar = (kw, wordEl, expandCommentNow = false) => {
      closeHlToolbar();
      hlToolbarWord = kw;
      hlToolbarMoved = false;
      const current = (kw.highlightColor || '').toLowerCase();
      const currentSw = tbSwatches.find((b) => b.dataset.color === current);
      // A colour outside the palette (an imported highlight) leaves the stack order alone, nothing active.
      if (currentSw) setTopCoin(currentSw);
      else tbSwatches.forEach((b) => b.classList.remove('active'));
      tbPanel.style.display = scribe._revealCommentInPanel ? '' : 'none';
      hlToolbar.style.display = '';
      if (expandCommentNow || kw.highlightComment) expandComment(false);
      // A fresh open must appear at its spot, never glide from wherever the card last stood.
      // The placement's own layout reads would otherwise start the left/top transition from that stale position.
      hlToolbar.style.transitionProperty = 'none';
      placeHlToolbar(wordEl);
      hlToolbar.getBoundingClientRect(); // commit the position while transitions are off
      hlToolbar.style.transitionProperty = '';
      setHlToolbarSel(true);
      // Focus last so it cannot scroll the container before the card is positioned.
      if (expandCommentNow) {
        editorText.focus();
        editorText.select();
      }
    };

    // A plain click on a highlighted word opens the toolbar.
    // Any other click closes it.
    // A drag that leaves a text selection is a selection gesture, not a click on the highlight object.
    /** @param {MouseEvent} event */
    const hlToolbarClick = (event) => {
      if (hlToolbarJustDragged) {
        hlToolbarJustDragged = false;
        return;
      }
      const t = event.target;
      if (!(t instanceof Element)) return;
      if (hlToolbar.contains(t)) return;
      const wordEl = t.closest('.scribe-word');
      if (!wordEl || !scribe.elem.contains(wordEl)) { closeHlToolbar(); return; }
      const kw = /** @type {any} */ (wordEl)._scribeObj;
      if (!kw || !kw.highlightColor) { closeHlToolbar(); return; }
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) { closeHlToolbar(); return; }
      openHlToolbar(kw, wordEl);
    };
    document.addEventListener('click', hlToolbarClick);
    // Double-click starts word text editing (editor build), so the toolbar must not sit over the input.
    /** @param {MouseEvent} event */
    const hlToolbarDblclick = (event) => {
      if (event.target instanceof Node && scribe.elem.contains(event.target)) closeHlToolbar();
    };
    document.addEventListener('dblclick', hlToolbarDblclick);
    /** @param {KeyboardEvent} event */
    const hlToolbarKeydown = (event) => {
      if (event.key !== 'Escape') return;
      // Escape folds inward: first an open coin fan, then the comment half, then the card itself.
      if (hlToolbarWord && coinsOpen()) collapseCoins();
      else if (hlToolbarWord && commentOpen()) collapseComment();
      else closeHlToolbar();
    };
    document.addEventListener('keydown', hlToolbarKeydown);
    // The toolbar is anchored to a screen position, so close it as soon as the page moves under it.
    // But scrolling inside the card (the comment textarea) must not dismiss it.
    /** @param {Event} event */
    const hlToolbarDismiss = (event) => {
      if (event.target instanceof Node && hlToolbar.contains(event.target)) return;
      closeHlToolbar();
    };
    scribe.scrollContainer?.addEventListener('scroll', hlToolbarDismiss, { passive: true });
    document.addEventListener('wheel', hlToolbarDismiss, { passive: true, capture: true });

    openCommentEditor = (words) => {
      if (!words || words.length === 0) return;
      const first = words[0];
      const wordEl = scribe.elem.querySelector(`.scribe-word[id="${first.word.id}"]`);
      if (!wordEl) return;
      openHlToolbar(first, wordEl, true);
    };
    scribe._openCommentEditor = openCommentEditor;
    // Let other surfaces (the Comments panel) refresh the on-page comment icons after editing a comment.
    scribe._updateCommentIcons = updateCommentIcons;
    // A freestanding note is edited inline in its margin card, so opening its editor just places the cursor there.
    scribe._openNoteEditor = (annot, pageIndex) => focusNoteEditor(scribe, pageIndex, annot);

    let commentIconTimer = null;
    const isWordOrLine = (n) => n instanceof HTMLElement
      && (n.classList.contains('scribe-word') || n.classList.contains('scribe-line'));
    const commentObserver = new MutationObserver((mutations) => {
      const hasRemoved = mutations.some((m) => [...m.removedNodes].some(isWordOrLine));
      if (hasRemoved) {
        scribe.elem?.querySelectorAll('.highlight-comment-icon').forEach((el) => el.remove());
        commentTooltip.style.display = 'none';
        // A word teardown (page re-render, document swap) leaves the toolbar pointing at a dead word.
        closeHlToolbar();
      }
      const hasAdded = mutations.some((m) => [...m.addedNodes].some(isWordOrLine));
      if (!hasAdded) return;
      if (commentIconTimer) clearTimeout(commentIconTimer);
      commentIconTimer = setTimeout(() => updateCommentIcons(), 100);
    });
    commentObserver.observe(scribe.elem, { childList: true });

    return () => {
      document.removeEventListener('mouseup', mouseupHandler);
      if (paletteElem) {
        document.removeEventListener('click', paletteOutsideClick);
        document.removeEventListener('keydown', paletteKeydown);
      }
      commentObserver.disconnect();
      if (hlToolbarDragEnd) hlToolbarDragEnd();
      closeHlToolbar();
      document.removeEventListener('click', coinsOutsideClick);
      document.removeEventListener('click', hlToolbarClick);
      document.removeEventListener('dblclick', hlToolbarDblclick);
      document.removeEventListener('keydown', hlToolbarKeydown);
      document.removeEventListener('wheel', hlToolbarDismiss, true);
      scribe.scrollContainer?.removeEventListener('scroll', hlToolbarDismiss);
      if (hlToolbar.parentNode) hlToolbar.parentNode.removeChild(hlToolbar);
      scribe._openCommentEditor = null;
      scribe._openNoteEditor = null;
      scribe._updateCommentIcons = null;
      openCommentEditor = null;
      if (commentTooltip && commentTooltip.parentNode) commentTooltip.parentNode.removeChild(commentTooltip);
      commentTooltip = null;
      if (cursorStyleElem) {
        cursorStyleElem.remove();
        cursorStyleElem = null;
      }
    };
  }

  return {
    highlightElem,
    toolbarElem,
    getSelectedOverlayWords,
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
    // Place the mark at the top-right of the page, clear of the edge, so the card renders in the right margin.
    const x = Math.max(0, pm.dims.width - 46);
    const annot = createNote(scribe, n, x, 22);
    scribe.renderNotes(n);
    focusNoteEditor(scribe, n, annot);
  });

  // Placement is immediate, so there are no page-level behaviors to install.
  function installBehaviors() { return () => {}; }

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
