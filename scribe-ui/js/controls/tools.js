// Document interaction tools shared by the viewer and editor apps: text highlighting
// (toggle, color picker, comment marks), the upload drop zone, and the file-to-ScribeDoc loader.
import scribeLib from '../../../scribe.js';
import {
  makeIconButton, setTimestamp, EDIT_PAGES_SVG, RECOGNIZE_SVG,
} from './toolbar.js';
import {
  applyHighlight, createInkEdges, recolorHighlightGroup, removeHighlightGroup, setHighlightReplies,
} from '../viewerHighlights.js';
import {
  focusNoteEditor, pageNotes, removeNote, setNoteComment,
} from '../viewerNotes.js';
import {
  BUBBLE_TIP_SVG, computeHighlightMarginHome, computePageHighlightHomes, computePageBubbleZoom, dropPreviewStrip,
} from '../viewerCommentMarks.js';
import { redactWords, redactRegion } from '../viewerRedactions.js';
import { createLineEditor } from '../editTextLineEditor.js';
import {
  createStyleCluster, FACE_FAMILIES, faceIdOf, faceNameOf, docFontDisplayName, docFontIdOf, docFontObjNumOf, loadPageFonts, pageHasSiblingWithout,
} from '../editTextStyle.js';
import { createFillSignPalette } from '../viewerFillSign.js';
import { nativeTextForPage, wordDrawBox } from '../../../js/textEdits.js';
import { GlobalFonts } from '../../../js/containers/fontContainer.js';
import { resolveReplacementChar } from '../../../js/pdf/glyphResolve.js';
import { pageImagePlacements, pagePathPlacements } from '../../../js/fillSign.js';
import { showTouchCallout, hideTouchCallout, isContextMenuOpen } from '../viewerCanvasInteraction.js';
import {
  resolveActiveSheet, copyTablePreviewSelection, selectAllTablePreviewCells, moveTablePreviewSelection,
} from '../viewerTablePreview.js';
import { pulseTable, setActiveTable, renderLayoutBoxes } from '../viewerLayout.js';
import { filesFromDropEvent } from '../dragAndDrop.js';
import { createDropdown } from './dropdown.js';
import { barIcon } from './icons.js';
import { UiText } from '../viewerWordObjects.js';

// eslint-disable-next-line max-len
const HIGHLIGHT_CURSOR = 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' height=\'24\' width=\'24\' viewBox=\'0 -960 960 960\'%3E%3Cpath fill=\'white\' stroke=\'black\' stroke-width=\'30\' d=\'m268-212-56-56q-12-12-12-28.5t12-28.5l423-423q12-12 28.5-12t28.5 12l56 56q12 12 12 28.5T748-635L324-212q-11 11-28 11t-28-11Z\'/%3E%3C/svg%3E") 12 12, auto';
// eslint-disable-next-line max-len
const HIGHLIGHT_CARET_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" style="display:block;width:11px;height:11px;pointer-events:none;" aria-hidden="true"><path d="M2.5 4.5l3 3 3-3"/></svg>';

/**
 * Wrap SVG in a stroked icon for the mode control's 17px slots.
 * One unit of its 17-unit grid is one pixel, so 1-unit strokes centered on half units cover whole pixels.
 * @param {string} inner - Path/shape markup.
 * @returns {string} The SVG markup for the icon.
 */
const modeIcon = (inner) => `<svg viewBox="0 0 17 17" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true">${inner}</svg>`;

// Comment-card verb glyphs, sized by the `.scribe-cmt-vb svg` rule.
// eslint-disable-next-line max-len
const TB_DELETE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.5h16M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5M6 6.5l.9 11.2a2 2 0 0 0 2 1.8h6.2a2 2 0 0 0 2-1.8L18 6.5"/></svg>';
// eslint-disable-next-line max-len
const TB_PANEL_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="15.5" rx="2.5"/><path d="M9.5 4v15.5"/></svg>';

/**
 * @param {HTMLElement} el
 * @param {string} label
 * @param {() => import('../../viewer.js').ScribeViewer} viewer - The viewer the tool is bound to, read at each hover or focus since the binding moves between groups.
 */
function nameForSelection(el, label, viewer) {
  const sync = () => {
    const name = viewer().hasTextSelection() ? `${label} selection` : label;
    el.dataset.tip = name;
    el.ariaLabel = name;
  };
  el.addEventListener('mouseenter', sync);
  el.addEventListener('focus', sync);
}

const HL_COMMENT_COUNT_KEY = 'scribe-hl-comment-count';

/**
 * Build the highlight tool: toggle button, optional color picker, overlay-word highlighting, highlighter cursor, and comment marks.
 * The toolbar DOM is built immediately. The selection/comment behaviors are wired by `installBehaviors()` after `scribe.init`.
 * @param {import('../../viewer.js').ScribeViewer} initialViewer
 * @param {HTMLElement} rootElem - The app's root element (for selection scope and cursor CSS).
 * @param {object} cfg
 * @param {string[]} cfg.colors - One or more hex colors.
 * @param {string} cfg.defaultColor - Initial color (must be in `colors`).
 * @param {string} cfg.rootClass - The app's root class (for scoping the cursor rule).
 * @returns {{
 *   highlightElem: HTMLSpanElement, toolbarElem: HTMLSpanElement,
 *   updateCommentIcons: () => void,
 *   installBehaviors: (viewer?: import('../../viewer.js').ScribeViewer) => (() => void),
 *   setArmed: (on: boolean) => void, isArmed: () => boolean
 * }}
 */
export function createHighlightTool(initialViewer, rootElem, { colors, defaultColor, rootClass }) {
  let scribe = initialViewer;
  let highlightMode = false;
  let highlightColor = defaultColor;
  let memGradCount = 0;
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
  /**
   * Shows the seed, the prompt to comment, on a highlight just made.
   * @type {?(words: Array<import('../viewerWordObjects.js').UiOcrWord>) => void}
   */
  let armLiveHighlight = null;
  /** Takes the seed down, and posts and closes a card opened from it. @type {?() => void} */
  let dismissLiveHighlight = null;

  const highlightElem = makeIconButton('Highlight', barIcon('highlighter'));
  nameForSelection(highlightElem, 'Highlight', () => scribe);
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
    if (dismissLiveHighlight) dismissLiveHighlight();
    // Recoloring an existing highlight is done from its own card, not by picking a color here.
    const fresh = matchedWords.filter((w) => !w.highlightColor);
    if (fresh.length > 0) applyHighlight(scribe, fresh, highlightColor, 0.5);
    scribe.clearTextSelection();
    if (fresh.length > 0 && armLiveHighlight) armLiveHighlight(fresh);
    return true;
  }

  /** @param {boolean} on */
  const setArmed = (on) => {
    if (!on && dismissLiveHighlight) dismissLiveHighlight();
    highlightMode = on;
    highlightElem.classList.toggle('active', highlightMode);
    updateHighlightCursorStyle();
  };

  highlightElem.addEventListener('click', () => {
    if (applyToSelection()) return;
    setArmed(!highlightMode);
  });

  // Color-picker swatches and the popover that holds them, plus the factory that builds each swatch button.
  const colorBtnElems = [];
  /** @type {?HTMLSpanElement} */ let paletteElem = null;
  /** @type {?HTMLSpanElement} */ let caretElem = null;
  /** @type {?ReturnType<typeof createDropdown>} */
  let paletteDropdown = null;
  const closePalette = () => paletteDropdown?.close();
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
    caretElem.dataset.tip = 'Choose highlight color';
    caretElem.role = 'button';
    caretElem.tabIndex = 0;
    caretElem.ariaLabel = 'Choose highlight color';
    caretElem.innerHTML = HIGHLIGHT_CARET_SVG;
    caretElem.addEventListener('mousedown', (e) => e.preventDefault());
    const pop = paletteElem;
    const caret = caretElem;
    paletteDropdown = createDropdown({
      show: () => {
        pop.classList.add('open');
        caret.classList.add('active');
        return pop;
      },
      hide: () => {
        pop.classList.remove('open');
        caret.classList.remove('active');
      },
      rows: '.highlight-color-btn',
    });
    paletteDropdown.attachTrigger(caretElem);

    split.append(highlightElem, caretElem, paletteElem);
    toolbarElem = split;
  }

  /** Hides again the mark an open card stands in for. @type {?() => void} */
  let syncOpenMarkHook = null;

  /** Refresh the on-page comment marks after a comment edit. */
  function updateCommentIcons() {
    if (!scribe.elem) return;
    const pages = new Set();
    for (const kw of scribe.getUiWords()) pages.add(kw.word.line.page.n);
    for (const n of pages) scribe.renderHighlights(n);
    if (syncOpenMarkHook) syncOpenMarkHook();
  }

  /**
   * Wire the selection-driven highlighting and the comment surfaces: hover on the on-page marks, the seed of a fresh highlight, and the comment card.
   * Call after `scribe.init` (needs `scribe.elem`).
   * @param {import('../../viewer.js').ScribeViewer} [viewer] - The viewer to bind, after the caller has torn down the previous binding.
   * @returns {() => void} teardown
   */
  function installBehaviors(viewer = scribe) {
    scribe = viewer;
    scribe._highlightColor = highlightColor;
    updateHighlightCursorStyle();
    /** Set for the rest of the event turn when a paint-mode drag has just made a highlight, so the click that ends the drag does not open that highlight's card. */
    let paintedOnMouseup = false;
    const mouseupHandler = (event) => {
      if (!highlightMode) return;
      if (!(event.target instanceof Node) || !rootElem.contains(event.target)) return;
      if (applyToSelection()) {
        paintedOnMouseup = true;
        setTimeout(() => { paintedOnMouseup = false; }, 0);
      }
    };
    document.addEventListener('mouseup', mouseupHandler);

    const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // The card's CSS width.
    const CARD_W = 228;
    const CARD_MIN_W = 176;

    // ---- Comment card ----
    const editorHost = scribe.outerElem || scribe.elem;
    // The host also holds the toolbar and the tabs, so the comment surfaces sit in a layer that covers the document area alone and clips them to it.
    const surfaceLayer = document.createElement('div');
    surfaceLayer.style.cssText = 'position:absolute;left:0;top:0;overflow:clip;pointer-events:none;';
    editorHost.appendChild(surfaceLayer);
    /**
     * Fit the surface layer to the document area.
     * @returns {DOMRect} The document area in client coordinates, whose corner the surfaces are positioned from.
     */
    const fitSurfaceLayer = () => {
      const view = (scribe.scrollContainer || editorHost).getBoundingClientRect();
      const box = surfaceLayer.getBoundingClientRect();
      // Moved by the difference from where it sits, so the host need not be the layer's containing block.
      if (Math.abs(view.left - box.left) > 0.05) surfaceLayer.style.left = `${(parseFloat(surfaceLayer.style.left) || 0) + view.left - box.left}px`;
      if (Math.abs(view.top - box.top) > 0.05) surfaceLayer.style.top = `${(parseFloat(surfaceLayer.style.top) || 0) + view.top - box.top}px`;
      if (Math.abs(view.width - box.width) > 0.05) surfaceLayer.style.width = `${view.width}px`;
      if (Math.abs(view.height - box.height) > 0.05) surfaceLayer.style.height = `${view.height}px`;
      return view;
    };
    /** @param {?HTMLElement} node */
    const liveClientRect = (node) => {
      if (!node || !node.isConnected || node.style.display === 'none') return null;
      const r = node.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return {
        left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height,
      };
    };

    const cmtCard = document.createElement('div');
    cmtCard.className = 'scribe-cmt-card';
    // Focusable so the card can hold focus (keeping Esc-to-close alive) once a post folds the composer away.
    cmtCard.tabIndex = -1;
    cmtCard.style.display = 'none';
    const cmtBarRow = document.createElement('div');
    cmtBarRow.className = 'scribe-cmt-bar-row';
    const cmtBar = document.createElement('span');
    cmtBar.className = 'scribe-cm-bar';
    cmtBarRow.appendChild(cmtBar);
    const cmtThread = document.createElement('div');
    cmtThread.className = 'scribe-cmt-thread';
    // The composer is the card's one writing surface: the root comment when none exists yet, otherwise a reply appended to the thread.
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

    const cmtEmptyFoot = document.createElement('div');
    cmtEmptyFoot.className = 'scribe-cmt-empty-foot';
    const cmtPostBtn = document.createElement('button');
    cmtPostBtn.type = 'button';
    cmtPostBtn.className = 'scribe-cmt-mini-btn scribe-cmt-mini-save scribe-cmt-post-btn';
    cmtPostBtn.textContent = 'Post ↵';
    cmtPostBtn.title = 'Enter to post · Shift+Enter for new line';

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

    cmtBar.setAttribute('role', 'button');
    cmtBar.tabIndex = 0;
    cmtBar.title = 'Highlight color';
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
    cmtBarRow.appendChild(cmtShelf);
    cmtCard.append(cmtBarRow, cmtThread);
    // Nested rounded clip boxes and border overlays clip all four corners during open/close using compositor-only translations.
    const cmtBox = document.createElement('div');
    cmtBox.className = 'scribe-cmt-box';
    const cmtBoxClips = ['is-x', 'is-y', 'is-b'].map((kind) => {
      const node = document.createElement('div');
      node.className = `scribe-cmt-clip ${kind}`;
      return node;
    });
    const cmtBoxEdges = ['is-x', 'is-y', 'is-b'].map((kind) => {
      const node = document.createElement('div');
      node.className = `scribe-cmt-edge ${kind}`;
      return node;
    });
    cmtBoxClips[2].append(cmtCard, ...cmtBoxEdges);
    cmtBoxClips[1].appendChild(cmtBoxClips[2]);
    cmtBoxClips[0].appendChild(cmtBoxClips[1]);
    cmtBox.appendChild(cmtBoxClips[0]);
    surfaceLayer.appendChild(cmtBox);

    /**
     * What a comment surface is attached to.
     * It is a highlight or line markup, reached through any word of it, or a freestanding note.
     * `slot` says whether a word's highlight fill or its underline or strikeout is meant.
     * @typedef {{kind: 'highlight', slot?: ('highlight'|'line'), kw: import('../viewerWordObjects.js').UiOcrWord, groupId: ?string, n: number}} HighlightTarget
     * @typedef {HighlightTarget | {kind: 'note', annot: AnnotationText, n: number}} CommentTarget
     */
    /** The open card's target, null while the card is closed. @type {?CommentTarget} */
    let cmtTarget = null;
    /** Whether the reply composer is unfolded on a thread that already has a root comment. */
    let cmtReplyOpen = false;
    /** Whether the open card came from the seed, for a first comment on a highlight just made. */
    let cmtFromSeed = false;
    /** @type {Array<HTMLElement>} */
    let cmtEdges = [];
    /** @type {?HTMLElement} */
    let cmtEditEl = null;
    let cmtEditOrig = '';
    /** @type {?() => void} */
    let cmtDragEnd = null;
    /** @type {?{dx: number, dy: number}} */
    let cmtAnchorOff = null;
    /**
     * Where the card sits once any animation on it has finished, in client coordinates.
     * @type {?{left: number, top: number, right: number, bottom: number, w: number, h: number}}
     */
    let cmtRestRect = null;
    let cmtPlaceScrolled = 0;
    /** Suppresses scroll-to-dismiss for the async scroll event fired when `cmtPlace` scrolls the viewport. */
    let cmtSelfScroll = false;
    /** @type {?number} */
    let cardMorphRaf = null;
    /**
     * Close animations in flight, by `targetKey`, so opening the same target again can start from the animation's current frame.
     * @type {Map<string, {ghost: HTMLElement, target: CommentTarget, anims: Animation[],
     *   rect: () => {left: number, top: number, right: number, bottom: number, w: number, h: number}}>}
     */
    const shellMorphs = new Map();
    /** @type {Animation[]} */
    let cardAnims = [];
    /** @type {HTMLElement[]} */
    let cardMorphExtras = [];
    /** @type {?[string, string]} */
    let cardMorphPos = null;
    const EASE_OUT = 'cubic-bezier(.215,.61,.355,1)';
    /**
     * @param {Element} boxEl
     * @param {Element} innerClip
     */
    const shownRect = (boxEl, innerClip) => {
      const b = boxEl.getBoundingClientRect();
      const inner = innerClip.getBoundingClientRect();
      const right = Math.min(b.right, inner.right);
      const bottom = Math.min(b.bottom, inner.bottom);
      return {
        left: b.left, top: b.top, right, bottom, w: right - b.left, h: bottom - b.top,
      };
    };
    const slideTo = (x, y) => `translate(${x.toFixed(2)}px,${y.toFixed(2)}px)`;
    /**
     * Counter-translate the nested clip boxes and border overlays so the visible card rect animates from `from` to `to`.
     * @param {{box: Element, clips: Element[], edges: Element[], inner: Element}} win
     * @param {number} fw
     * @param {number} fh
     * @param {{x: number, y: number, w: number, h: number}} from
     * @param {{x: number, y: number, w: number, h: number}} to
     * @param {KeyframeAnimationOptions} timing
     * @returns {Animation[]}
     */
    const windowAnims = (win, fw, fh, from, to, timing) => {
      const a0x = fw - from.w;
      const a0y = fh - from.h;
      const a1x = fw - to.w;
      const a1y = fh - to.h;
      return [
        win.box.animate([{ transform: slideTo(from.x, from.y) }, { transform: slideTo(to.x, to.y) }], timing),
        win.clips[0].animate([{ transform: slideTo(-a0x, 0) }, { transform: slideTo(-a1x, 0) }], timing),
        win.clips[1].animate([{ transform: slideTo(a0x, -a0y) }, { transform: slideTo(a1x, -a1y) }], timing),
        win.clips[2].animate([{ transform: slideTo(-a0x, 0) }, { transform: slideTo(-a1x, 0) }], timing),
        win.inner.animate([{ transform: slideTo(a0x, a0y) }, { transform: slideTo(a1x, a1y) }], timing),
        win.edges[0].animate([{ transform: slideTo(0, a0y) }, { transform: slideTo(0, a1y) }], timing),
        win.edges[1].animate([{ transform: slideTo(a0x, 0) }, { transform: slideTo(a1x, 0) }], timing),
      ];
    };
    /** @type {Set<HTMLElement>} */
    const hiddenOpenMarks = new Set();

    /**
     * @param {import('../viewerWordObjects.js').UiOcrWord} kw
     * @param {('highlight'|'line')} slot
     * @returns {HighlightTarget}
     */
    const highlightTarget = (kw, slot) => ({
      kind: 'highlight', slot, kw, groupId: (slot === 'highlight' ? kw.highlightGroupId : kw.markupGroupId) || null, n: kw.word.line.page.n,
    });

    /** @param {CommentTarget} t */
    const targetKey = (t) => (t.kind === 'highlight'
      ? `hl:${t.n}:${t.slot || 'highlight'}:${t.groupId || t.kw.word.id}`
      : `note:${t.n}:${pageNotes(scribe, t.n).indexOf(t.annot)}`);

    const cmtGrow = () => {
      cmtText.style.height = 'auto';
      const rawH = cmtText.scrollHeight;
      cmtText.style.height = `${Math.min(90, Math.max(18, rawH))}px`;
      cmtText.style.overflowY = rawH > 90 ? 'auto' : 'hidden';
      cmtThread.classList.toggle('is-scrollable', cmtThread.scrollHeight > 322);
    };

    const cmtAnnot = (target) => {
      if (target.kind === 'note') return target.annot;
      if (!target.groupId) return null;
      return (scribe.doc.annotations.pages[target.n] || [])
        .find((a) => (target.slot === 'line'
          ? a.type === 'underline' || a.type === 'strikeout'
          : !a.type || a.type === 'highlight') && a.groupId === target.groupId) || null;
    };

    /**
     * The on-page mark element of a card target.
     * Marks are rebuilt with each render, so it is queried afresh at every use.
     * @param {CommentTarget} target
     * @returns {?HTMLElement}
     */
    const cmtMarkEl = (target) => {
      if (target.kind === 'highlight') {
        if (!target.groupId) return null;
        return scribe.elem.querySelector(`.scribe-hl-cmark[data-group-id="${target.groupId}"][data-slot="${target.slot || 'highlight'}"]`);
      }
      const group = scribe.getNotesGroup(target.n);
      return group ? group.querySelector(`.scribe-note-icon[data-note-idx="${pageNotes(scribe, target.n).indexOf(target.annot)}"]`) : null;
    };

    const targetBands = (target) => {
      if (!target || target.kind !== 'highlight') return [];
      const { kw, groupId, n } = target;
      if (groupId) {
        const map = scribe._highlightRectsByGroup[n];
        const arr = map && map.get(groupId);
        if (arr && arr.length > 0) return arr;
      }
      const rect = target.slot === 'line' ? kw.markupRectElem : kw.highlightRectElem;
      return rect ? [rect] : [];
    };

    const setCmtSel = (on) => {
      for (const el of cmtEdges) el.remove();
      cmtEdges = on ? createInkEdges(targetBands(cmtTarget)) : [];
    };

    /**
     * Where a target's mark rests on screen, in client coordinates, with the document area that bounds it.
     * @param {CommentTarget} target
     */
    const targetScreenHome = (target) => {
      const view = (scribe.scrollContainer || editorHost).getBoundingClientRect();
      if (view.width < 40 || view.height < 40) return null;
      const pc = scribe.pageContainerArr[target.n];
      if (!pc || !pc.isConnected) return null;
      const pcRect = pc.getBoundingClientRect();
      if (pcRect.width <= 0) return null;
      const z = scribe.zoomLevel;

      // The resting spot, with its position in page px and its size in screen px.
      let rest;
      const markEl = cmtMarkEl(target);
      if (markEl) {
        rest = {
          left: Number(markEl.dataset.restLeftPage),
          top: Number(markEl.dataset.restTopPage),
          w: Number(markEl.dataset.restW),
          h: Number(markEl.dataset.restH),
          lockRight: markEl.dataset.lockRight === '1',
          tailClass: markEl.dataset.tail,
          room: Number(markEl.dataset.room) || 0,
          clear: Number(markEl.dataset.clear) || 0,
          textGap: Number(markEl.dataset.textGap) || 0,
        };
      } else if (target.kind === 'highlight') {
        const bandRects = targetBands(target).map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
        if (bandRects.length === 0) return null;
        const runs = bandRects.map((r) => ({
          left: (r.left - pcRect.left) / z,
          right: (r.right - pcRect.left) / z,
          top: (r.top - pcRect.top) / z,
          bottom: (r.bottom - pcRect.top) / z,
        }));
        const slot = target.slot || 'highlight';
        // A highlight imported without a group id cannot join the page-wide solve, so it is placed on its own.
        const home = (target.groupId && computePageHighlightHomes(scribe, target.n, { groupId: target.groupId, slot, runs }).get(`${slot}:${target.groupId}`))
          || computeHighlightMarginHome(scribe, target.n, runs);
        rest = {
          left: home.restLeftPage,
          top: home.restTopPage,
          w: home.restW,
          h: home.restH,
          lockRight: home.lockRight,
          tailClass: home.tailClass,
          room: home.roomPx,
          clear: home.clearPx,
          textGap: home.textGapPx,
        };
      } else {
        // A note's mark is not rendered while comments are off in the viewer, so its card opens from where the mark would sit.
        const { effZ } = computePageBubbleZoom(scribe, target.n);
        const left = target.annot.bbox.left - 11 / effZ;
        const rightRoom = (view.right - 8) - (pcRect.left + left * z);
        const leftRoom = (pcRect.left + (left + 22 / effZ) * z) - (view.left + 8);
        const lockRight = rightRoom < 196 && leftRoom > rightRoom;
        rest = {
          left, top: target.annot.bbox.top - 25 / effZ, w: (22 / effZ) * z, h: (22 / effZ) * z, lockRight, tailClass: lockRight ? 'is-down-right' : 'is-down-left', room: 0, clear: 0, textGap: 0,
        };
      }
      const bLeft = pcRect.left + rest.left * z;
      const bTop = pcRect.top + rest.top * z;
      const bRight = bLeft + rest.w;
      return {
        bLeft,
        bTop,
        bRight,
        bBottom: bTop + rest.h,
        restW: rest.w,
        restH: rest.h,
        textGap: rest.textGap,
        lockRight: rest.lockRight,
        lockBottom: target.kind === 'note',
        tailClass: rest.tailClass,
        // Re-clamp to `view` because `dataset.room` and `dataset.clear` go stale across scrolls and container resizes that do not re-place marks.
        wall: rest.lockRight ? Math.max(view.left + 4, bRight - rest.room) : Math.min(view.right - 4, bLeft + rest.room),
        clearWall: rest.lockRight ? Math.max(view.left + 4, bRight - rest.clear) : Math.min(view.right - 4, bLeft + rest.clear),
        offscreen: (rest.tailClass === 'is-left' && bRight <= view.left) || (rest.tailClass === 'is-right' && bLeft >= view.right),
        view,
      };
    };

    const cmtAnchorRects = (target) => {
      // A highlight's comment mark appears only once a comment is posted, so it is left out to keep the anchor still under an open card.
      const noteMark = target.kind === 'highlight' ? null : cmtMarkEl(target);
      if (noteMark) {
        const r = noteMark.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return [r];
      }
      return targetBands(target).map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    };

    // ---- Animations between a mark and the card ----
    // A surface opened, closed or re-placed mid-animation starts from the frame it is on.

    const clearCardMorphStyles = () => {
      if (cardMorphRaf !== null) { cancelAnimationFrame(cardMorphRaf); cardMorphRaf = null; }
      for (const anim of cardAnims) anim.cancel();
      cardAnims = [];
      for (const node of cardMorphExtras) node.remove();
      cardMorphExtras = [];
      cmtBox.classList.remove('is-on');
      cmtBox.style.cssText = '';
      for (const node of [...cmtBoxClips, ...cmtBoxEdges]) node.style.cssText = '';
      cmtBar.style.transformOrigin = '';
      if (cardMorphPos) {
        [cmtCard.style.left, cmtCard.style.top] = cardMorphPos;
        cardMorphPos = null;
      }
      cmtCard.style.height = '';
      cmtCard.style.overflow = '';
      for (const ell of cmtCard.querySelectorAll('.scribe-card-ell-fade')) ell.remove();
      cmtThread.classList.toggle('is-scrollable', cmtThread.scrollHeight > 322);
    };

    const cancelShellMorph = (key) => {
      const rec = shellMorphs.get(key);
      if (!rec) return;
      for (const anim of rec.anims) anim.cancel();
      shellMorphs.delete(key);
      const liveMark = cmtMarkEl(rec.target);
      if (liveMark) liveMark.classList.remove('is-morph-target');
      if (rec.ghost.isConnected) rec.ghost.remove();
    };

    /**
     * Fade a copy of a closing surface out in place.
     * @param {{left: number, top: number, w: number, h: number}} fromRect - The surface's rect, in client coordinates.
     * @param {string} barColor - The highlight color the surface's bar showed, or '' for none.
     * @param {boolean} lockRight - Whether the surface was anchored by its right edge.
     * @param {boolean} [lockBottom] - Whether it was anchored by its bottom edge.
     */
    const spawnExitFadeGhost = (fromRect, barColor, lockRight, lockBottom = false) => {
      if (reducedMotion()) return;
      const base = fitSurfaceLayer();
      const ghost = document.createElement('div');
      ghost.className = 'scribe-shell-morph';
      ghost.style.cssText = `left:${(fromRect.left - base.left).toFixed(1)}px;top:${(fromRect.top - base.top).toFixed(1)}px;width:${fromRect.w.toFixed(1)}px;height:${fromRect.h.toFixed(1)}px;--scribe-box-radius:6px;transform-origin:${lockRight ? '100%' : '0%'} ${lockBottom ? '100%' : '50%'};`;
      const box = document.createElement('span');
      box.className = 'scribe-bub-box';
      ghost.appendChild(box);
      if (barColor) {
        const bar = document.createElement('span');
        bar.className = 'scribe-cm-bar';
        bar.style.cssText = `position:absolute;left:7px;top:5px;width:3px;height:${Math.max(11, Math.min(16, fromRect.h - 10))}px;border-radius:1.5px;background:${barColor};z-index:1;`;
        ghost.appendChild(bar);
      }
      surfaceLayer.appendChild(ghost);
      const t0 = performance.now();
      const step = (now) => {
        if (!ghost.isConnected) return;
        const u = Math.max(0, Math.min(1, (now - t0) / 150));
        if (u >= 1) { ghost.remove(); return; }
        const e = 1 - ((1 - u) ** 2.6);
        ghost.style.opacity = (1 - e).toFixed(3);
        ghost.style.transform = `scale(${(1 - 0.06 * e).toFixed(4)})`;
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };

    /**
     * @param {{left: number, top: number, w: number, h: number}} fromRect
     * @param {CommentTarget} target
     */
    const fadeCardOut = (fromRect, target) => {
      const home = targetScreenHome(target);
      spawnExitFadeGhost(
        fromRect,
        target.kind === 'highlight' ? (target.kw.highlightColor || target.kw.markupColor || '') : '',
        home ? home.lockRight : false,
        target.kind === 'note',
      );
    };

    /**
     * Fold a closing card into its target's mark.
     * @param {{left: number, top: number, right: number, bottom: number, w: number, h: number}} fromRect - The part of the card that showed, in client coordinates.
     * @param {CommentTarget} target
     * @param {HTMLElement} face - A copy of the card as it looked when it closed, carrying the card's full size as `data-w` and `data-h`.
     */
    const animateShellToBubble = (fromRect, target, face) => {
      if (reducedMotion()) return;
      const key = targetKey(target);
      cancelShellMorph(key);
      const markEl = cmtMarkEl(target);
      const home = targetScreenHome(target);
      if (!markEl || !home || home.offscreen) {
        fadeCardOut(fromRect, target);
        return;
      }
      const view = home.view;
      if (home.bBottom < view.top || home.bTop > view.bottom || home.bRight < view.left || home.bLeft > view.right) return;

      markEl.style.transition = 'none';
      markEl.classList.remove('is-unrolled', 'is-active', 'is-hidden-for-card');
      const m = markEl.getBoundingClientRect();
      markEl.style.transition = '';
      markEl.classList.add('is-morph-target');

      const base = fitSurfaceLayer();
      const fw = Number(face.dataset.w) || fromRect.w;
      const fh = Number(face.dataset.h) || fromRect.h;
      const mx = m.left - fromRect.left;
      const my = m.top - fromRect.top;
      const timing = { duration: 200, easing: EASE_OUT, fill: 'both' };
      const placed = `position:absolute;left:${(fromRect.left - base.left).toFixed(2)}px;top:${(fromRect.top - base.top).toFixed(2)}px;width:${fw}px;height:${fh}px;`;
      const leave = document.createElement('div');
      leave.className = 'scribe-cmt-leave';
      leave.inert = true;
      /** @type {Animation[]} */
      const anims = [];
      for (const kind of ['', ' is-ring']) {
        const shade = document.createElement('div');
        shade.className = `scribe-cmt-shade${kind}`;
        shade.style.cssText = placed;
        leave.appendChild(shade);
        anims.push(
          shade.animate([
            { transform: `translate(0px,0px) scale(${(fromRect.w / fw).toFixed(4)},${(fromRect.h / fh).toFixed(4)})` },
            { transform: `translate(${mx.toFixed(2)}px,${my.toFixed(2)}px) scale(${(m.width / fw).toFixed(4)},${(m.height / fh).toFixed(4)})` },
          ], timing),
          shade.animate([{ opacity: 1, offset: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 0, offset: 1 }], timing),
        );
      }
      const clips = ['is-x', 'is-y', 'is-b'].map((kind) => {
        const node = document.createElement('div');
        node.className = `scribe-cmt-clip ${kind}`;
        node.style.cssText = `width:${fw}px;height:${fh}px;`;
        return node;
      });
      const edges = ['is-x', 'is-y', 'is-b'].map((kind) => {
        const node = document.createElement('div');
        node.className = `scribe-cmt-edge ${kind}`;
        node.style.cssText = `width:${fw}px;height:${fh}px;`;
        return node;
      });
      face.removeAttribute('tabindex');
      face.style.cssText = `position:absolute;left:0;top:0;width:${fw}px;margin:0;`;
      clips[2].append(face, ...edges);
      clips[1].appendChild(clips[2]);
      clips[0].appendChild(clips[1]);
      const body = document.createElement('div');
      body.className = 'scribe-cmt-box is-on';
      body.style.cssText = placed;
      body.appendChild(clips[0]);
      leave.appendChild(body);
      anims.push(
        ...windowAnims({
          box: body, clips, edges, inner: face,
        }, fw, fh, {
          x: 0, y: 0, w: fromRect.w, h: fromRect.h,
        }, {
          x: mx, y: my, w: m.width, h: m.height,
        }, timing),
        body.animate([{ opacity: 1, offset: 0 }, { opacity: 1, offset: 0.7 }, { opacity: 0, offset: 1 }], timing),
        markEl.animate([{ opacity: 0, offset: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1, offset: 1 }], timing),
      );
      const thread = face.querySelector('.scribe-cmt-thread');
      if (thread) anims.push(thread.animate([{ opacity: 1, offset: 0 }, { opacity: 0, offset: 0.43 }, { opacity: 0, offset: 1 }], timing));
      surfaceLayer.appendChild(leave);

      const rec = {
        ghost: leave, target, anims, rect: () => shownRect(body, clips[2]),
      };
      shellMorphs.set(key, rec);
      Promise.all(anims.map((anim) => anim.finished)).then(() => {
        if (shellMorphs.get(key) === rec) cancelShellMorph(key);
      }, () => {});
    };

    /**
     * Glide the card from where it was to where a re-placement has just put it, after its content changed height.
     * @param {?{left: number, top: number, h: number}} beforeRect - The card's rect before the change, null to skip.
     * @param {number} [baseMs]
     */
    const animateCardResize = (beforeRect, baseMs = 140) => {
      const rest = cmtRestRect;
      if (!beforeRect || !rest || reducedMotion()) return;
      if (Math.abs(beforeRect.h - rest.h) < 0.8 && Math.abs(beforeRect.top - rest.top) < 0.8 && Math.abs(beforeRect.left - rest.left) < 0.8) return;
      clearCardMorphStyles();
      cmtCard.style.overflow = 'hidden';
      cmtThread.classList.remove('is-scrollable');
      const t0 = performance.now();
      const applyAt = (u) => {
        const tgt = cmtRestRect;
        if (!tgt) return;
        const base = fitSurfaceLayer();
        const e = 1 - ((1 - u) ** 3);
        cmtCard.style.left = `${((beforeRect.left + (tgt.left - beforeRect.left) * e) - base.left).toFixed(2)}px`;
        cmtCard.style.top = `${((beforeRect.top + (tgt.top - beforeRect.top) * e) - base.top).toFixed(2)}px`;
        cmtCard.style.height = `${(beforeRect.h + (tgt.h - beforeRect.h) * e).toFixed(2)}px`;
      };
      applyAt(0);
      const step = (now) => {
        if (!cmtTarget || !cmtRestRect) {
          clearCardMorphStyles();
          return;
        }
        const u = Math.max(0, Math.min(1, (now - t0) / baseMs));
        if (u >= 1) {
          const base = fitSurfaceLayer();
          const tgt = cmtRestRect;
          clearCardMorphStyles();
          cmtCard.style.left = `${(tgt.left - base.left).toFixed(1)}px`;
          cmtCard.style.top = `${(tgt.top - base.top).toFixed(1)}px`;
          return;
        }
        applyAt(u);
        cardMorphRaf = requestAnimationFrame(step);
      };
      cardMorphRaf = requestAnimationFrame(step);
    };

    const initialsOf = (name) => name.split(/\s+/, 2).map((p) => p[0]).join('').toUpperCase();

    // ---- In-place message editing ----
    // Any message can be edited, whoever wrote it, since authorship is a label and not a permission.
    const endMsgEdit = () => {
      if (!cmtEditEl) return;
      cmtEditEl.contentEditable = 'false';
      const msg = cmtEditEl.closest('.scribe-cmt-msg');
      if (msg) msg.classList.remove('is-editing-this');
      cmtCard.classList.remove('is-editing-msg');
      cmtEditEl = null;
    };
    const cancelMsgEdit = () => {
      if (!cmtEditEl) return;
      const beforeRect = liveClientRect(cmtCard);
      cmtEditEl.textContent = cmtEditOrig;
      endMsgEdit();
      if (cmtTarget) {
        cmtPlace(cmtTarget);
        animateCardResize(beforeRect);
      }
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

    const commitMsgEdit = () => {
      if (!cmtEditEl || !cmtTarget) return false;
      const el = cmtEditEl;
      const next = (el.textContent || '').trim();
      endMsgEdit();
      if (next === cmtEditOrig.trim()) {
        el.textContent = cmtEditOrig;
        return false;
      }
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

    const saveActiveMsgEdit = () => {
      if (!cmtEditEl || !cmtTarget) return;
      const beforeRect = liveClientRect(cmtCard);
      const changed = commitMsgEdit();
      if (changed) {
        if (scribe._rebuildCommentsPanel) scribe._rebuildCommentsPanel();
        updateCommentIcons();
      }
      const annot = cmtTarget ? cmtAnnot(cmtTarget) : null;
      const hasAny = !!(annot && (annot.comment || (annot.replies && annot.replies.length > 0)));
      if (changed && !hasAny) {
        cmtClose(true);
        return;
      }
      if (cmtTarget) {
        cmtFill(cmtTarget);
        cmtPlace(cmtTarget);
        animateCardResize(beforeRect);
        cmtCard.focus({ preventScroll: true });
      }
    };

    const beginMsgEdit = (mtextEl) => {
      if (cmtEditEl === mtextEl) return;
      if (commitMsgEdit()) {
        if (scribe._rebuildCommentsPanel) scribe._rebuildCommentsPanel();
        updateCommentIcons();
      }
      cmtEditEl = mtextEl;
      cmtEditOrig = mtextEl.textContent || '';
      // Plain text only, where the browser has it, so a paste cannot bring markup into the message.
      try {
        mtextEl.contentEditable = 'plaintext-only';
      } catch {
        mtextEl.contentEditable = 'true';
      }
      if (!mtextEl.isContentEditable) mtextEl.contentEditable = 'true';
      const msg = mtextEl.closest('.scribe-cmt-msg');
      if (msg) msg.classList.add('is-editing-this');
      cmtCard.classList.add('is-editing-msg');
      mtextEl.focus({ preventScroll: true });
    };

    /**
     * @param {string} idx - 'root' or the reply index, for edit commits.
     * @param {string} text
     * @param {string} author
     * @param {string} createdAt
     * @param {boolean} isLast - Whether this is the thread's last message, the one that carries the Reply verb and the card verbs.
     */
    const makeMsg = (idx, text, author, createdAt, isLast) => {
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

      const foot = document.createElement('div');
      foot.className = 'scribe-cmt-foot';
      if (createdAt) {
        const when = document.createElement('span');
        when.className = 'scribe-cm-when';
        setTimestamp(when, createdAt);
        foot.appendChild(when);
      }
      if (isLast) foot.appendChild(cmtReplyBtn);

      const rightSlot = document.createElement('span');
      rightSlot.className = 'scribe-cmt-right-slot';
      if (isLast) rightSlot.appendChild(cmtHdVerbs);
      const editBtns = document.createElement('span');
      editBtns.className = 'scribe-cmt-edit-btns';
      const escBtn = document.createElement('button');
      escBtn.type = 'button';
      escBtn.className = 'scribe-cmt-mini-btn scribe-cmt-mini-esc';
      escBtn.textContent = 'Esc';
      escBtn.title = 'Cancel edit (Esc)';
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'scribe-cmt-mini-btn scribe-cmt-mini-save';
      saveBtn.textContent = 'Save ↵';
      saveBtn.title = 'Enter to save · Shift+Enter for new line';
      escBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        cancelMsgEdit();
        cmtCard.focus({ preventScroll: true });
      });
      saveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        saveActiveMsgEdit();
      });
      editBtns.append(escBtn, saveBtn);
      rightSlot.appendChild(editBtns);
      foot.appendChild(rightSlot);
      msg.appendChild(foot);
      return msg;
    };

    const renderThread = (annot, kind) => {
      cmtEditEl = null;
      cmtCard.classList.remove('is-editing-msg');
      cmtThread.replaceChildren();
      const entries = [];
      if (annot && annot.comment) {
        entries.push({
          idx: 'root', text: annot.comment, author: annot.author || '', createdAt: annot.createdAt || '',
        });
      }
      const replies = (annot && annot.replies) || [];
      replies.forEach((r, i) => entries.push({
        idx: String(i), text: r.text, author: r.author || '', createdAt: r.createdAt || '',
      }));
      const msgs = entries.map((ent, i) => makeMsg(ent.idx, ent.text, ent.author, ent.createdAt, i === entries.length - 1));
      for (const m of msgs) cmtThread.appendChild(m);
      const author = scribe.opt.commentAuthor || '';
      cmtReplyAva.textContent = initialsOf(author);
      cmtReplyAva.style.display = author ? '' : 'none';
      const hasRoot = !!(annot && annot.comment);
      if (hasRoot) cmtText.placeholder = 'Reply…';
      else cmtText.placeholder = kind === 'note' ? 'Add a note…' : 'Add a comment…';
      cmtText.value = '';
      if (!hasRoot || cmtReplyOpen) {
        cmtThread.appendChild(cmtReply);
        cmtEmptyFoot.replaceChildren();
        if (!hasRoot) cmtEmptyFoot.appendChild(cmtHdVerbs);
        cmtEmptyFoot.appendChild(cmtPostBtn);
        cmtThread.appendChild(cmtEmptyFoot);
      }
      cmtGrow();
    };

    const cmtFill = (target) => {
      const annot = cmtAnnot(target);
      if (target.kind === 'highlight') {
        const isLine = target.slot === 'line';
        cmtCard.classList.remove('scribe-cmt-note-clean');
        cmtBar.hidden = false;
        const color = (annot && annot.color) || (isLine ? target.kw.markupColor : target.kw.highlightColor) || '';
        cmtBar.style.background = color;
        for (const b of cmtSwatches) {
          if (b.dataset.markupOnly) b.style.display = isLine ? '' : 'none';
        }
        const currentSw = cmtSwatches.find((b) => b.dataset.color === color.toLowerCase() && (!b.dataset.markupOnly || isLine));
        markActiveSwatch(currentSw || null);
        const verb = isLine
          ? (((annot && annot.type) || target.kw.markupType) === 'strikeout' ? 'Delete strikethrough' : 'Delete underline')
          : 'Delete highlight';
        cmtDelete.title = verb;
        cmtDelete.setAttribute('aria-label', verb);
      } else {
        cmtCard.classList.add('scribe-cmt-note-clean');
        cmtBar.hidden = true;
        collapseShelf();
        cmtDelete.title = 'Delete note';
        cmtDelete.setAttribute('aria-label', 'Delete note');
      }
      // The panel verb needs the host's reveal hook.
      cmtPanelBtn.style.display = scribe._revealCommentInPanel ? '' : 'none';
      renderThread(annot, target.kind);
    };

    /**
     * Place the card for its target, inside the document area.
     * @returns {boolean} false when the target is not on screen, leaving the card unplaced.
     */
    const cmtPlace = (target) => {
      clearCardMorphStyles();
      const home = targetScreenHome(target);
      if (!home) return false;
      const rects = cmtAnchorRects(target);
      const { view } = home;
      const beside = home.tailClass === 'is-left' || home.tailClass === 'is-right';
      // Allow up to 6px of encroachment past the bubble toward the text, keeping at least 4px of text clearance.
      const nearer = Math.max(0, Math.min(6, home.textGap - 4));
      let room = CARD_W;
      if (beside) room = home.lockRight ? home.bRight + nearer - home.wall : home.wall - home.bLeft + nearer;
      cmtCard.style.setProperty('--scribe-cmt-w', `${Math.max(CARD_MIN_W, Math.min(CARD_W, Math.floor(room)))}px`);
      cmtCard.classList.remove('scribe-cmt-narrow');

      cmtCard.style.display = '';
      cmtCard.style.visibility = 'hidden';
      cmtGrow();
      if ([...cmtThread.querySelectorAll('.scribe-cmt-foot')].some((foot) => foot.scrollWidth > foot.clientWidth)) cmtCard.classList.add('scribe-cmt-narrow');
      const base = fitSurfaceLayer();
      const cw = cmtCard.offsetWidth || CARD_W;
      const ch = cmtCard.offsetHeight || 52;
      const minX = view.left + 4;
      const maxX = Math.max(minX, view.right - cw - 4);
      const minY = view.top + 4;
      const maxY = Math.max(minY, view.bottom - ch - 4);

      let left;
      let top;
      cmtPlaceScrolled = 0;
      if (rects.length > 0 && beside && cw > room) {
        const last = rects.reduce((a, r) => (r.bottom > a.bottom ? r : a));
        if (home.offscreen) left = last.left;
        else left = home.lockRight ? home.wall : home.wall - cw;
        left = Math.max(minX, Math.min(maxX, left));
        top = last.bottom + 6;
        // Sliding the card up into view would put it on the highlight, so the document scrolls to make room.
        const past = top + ch - (view.bottom - 4);
        const sc = scribe.scrollContainer;
        if (sc && past > 0) {
          const scrollTop0 = sc.scrollTop;
          sc.scrollTop = scrollTop0 + Math.min(past, Math.max(0, top - minY));
          cmtPlaceScrolled = sc.scrollTop - scrollTop0;
          if (cmtPlaceScrolled !== 0) cmtSelfScroll = true;
          top -= cmtPlaceScrolled;
        }
        // At the end of the document scroll can stop short, so place the card above the highlight when more of it fits there.
        const over = Math.min(...rects.map((r) => r.top)) - cmtPlaceScrolled - 6 - ch;
        if (top + ch - (view.bottom - 4) > Math.max(0, minY - over)) top = over;
      } else if (beside) {
        left = home.lockRight ? Math.max(home.wall, home.bRight - cw) : Math.min(home.wall - cw, home.bLeft);
        top = Math.max(minY, Math.min(maxY, home.bTop));
      } else {
        left = Math.max(minX, Math.min(maxX, home.lockRight ? (home.bRight - cw) : home.bLeft));
        top = Math.max(minY, Math.min(maxY, home.lockBottom ? (home.bBottom - ch) : home.bTop));
      }

      cmtCard.style.left = `${(left - base.left).toFixed(1)}px`;
      cmtCard.style.top = `${(top - base.top).toFixed(1)}px`;
      cmtCard.style.visibility = '';
      cmtRestRect = {
        left, top, right: left + cw, bottom: top + ch, w: cw, h: ch,
      };
      const anchor = rects[rects.length - 1];
      cmtAnchorOff = anchor ? { dx: left - anchor.left, dy: top - (anchor.top - cmtPlaceScrolled) } : null;
      return true;
    };

    const cmtSameTarget = (a, b) => !!a && !!b && a.kind === b.kind
      && (a.kind === 'highlight'
        ? (a.slot || 'highlight') === (b.slot || 'highlight') && a.groupId === b.groupId && (a.groupId || a.kw === b.kw)
        : a.annot === b.annot);

    /** Post the composer's draft: the root comment when none exists, otherwise a new reply. */
    const postComposer = () => {
      if (!cmtTarget) return false;
      const text = cmtText.value.trim();
      if (!text) return false;
      cmtText.value = '';
      const annot = cmtAnnot(cmtTarget);
      if (!annot || !annot.comment) {
        applyRootComment(cmtTarget, text);
        if (cmtFromSeed) {
          // Counted so the seed can drop its label once the user has commented this way twice.
          memGradCount += 1;
          try {
            const next = Math.max(memGradCount, (Number(window.localStorage.getItem(HL_COMMENT_COUNT_KEY)) || 0) + 1);
            window.localStorage.setItem(HL_COMMENT_COUNT_KEY, String(next));
          } catch { /* storage unavailable */ }
        }
        return true;
      }
      /** @type {AnnotationReply} */
      const reply = { text, createdAt: new Date().toISOString() };
      const author = scribe.opt.commentAuthor || '';
      if (author) reply.author = author;
      applyReplies(cmtTarget, [...(annot.replies || []), reply]);
      return true;
    };

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

    // ---- The seed ----
    // A fresh highlight shows a small seed where its comment bubble would rest.
    // Only one of the seed and the card is ever up.
    const seedElem = document.createElement('div');
    seedElem.className = 'scribe-hl-seed';
    seedElem.style.display = 'none';
    seedElem.setAttribute('role', 'button');
    seedElem.tabIndex = 0;
    seedElem.setAttribute('aria-label', 'Add a comment');
    const seedBar = document.createElement('span');
    seedBar.className = 'scribe-cm-bar';
    const seedBeam = document.createElement('span');
    seedBeam.className = 'scribe-hl-ibeam';
    const seedLabel = document.createElement('span');
    seedLabel.className = 'scribe-hl-seed-label';
    seedLabel.textContent = 'Type to comment';
    seedElem.append(seedBar, seedBeam, seedLabel);

    surfaceLayer.appendChild(seedElem);

    /**
     * The seed's state while it is up.
     * `spot` is where it was last placed, in client coordinates.
     * @type {?{target: HighlightTarget, color: string, isMin: boolean,
     *   spot: ?{left: number, top: number, right: number, bottom: number, lockRight: boolean}}}
     */
    let liveState = null;
    /** @type {?number} */
    let liveRaf = null;
    /** @type {Array<HTMLElement>} */
    let liveEdges = [];

    /**
     * Hide the mark of the target whose card is open, and show again any mark hidden for an earlier one.
     * Marks are rebuilt with each highlight render, so it must run again after one.
     */
    const syncOpenMarkVisibility = () => {
      for (const prev of hiddenOpenMarks) {
        if (prev.isConnected) {
          prev.style.transition = 'none';
          prev.classList.remove('is-hidden-for-card');
          prev.getBoundingClientRect();
          prev.style.transition = '';
        }
      }
      hiddenOpenMarks.clear();
      const markEl = cmtTarget ? cmtMarkEl(cmtTarget) : null;
      if (markEl) {
        dropPreviewStrip(markEl);
        markEl.classList.remove('is-unrolled', 'is-active');
        markEl.classList.add('is-hidden-for-card');
        hiddenOpenMarks.add(markEl);
      }
    };
    syncOpenMarkHook = syncOpenMarkVisibility;

    /**
     * Close the card without committing anything in flight.
     * @param {boolean} [animate] - Fold the card into its target's mark, or fade it out when the target has no comment to show one.
     */
    const cmtClose = (animate = false) => {
      const closingTarget = cmtTarget;
      // Measured now, before the card hides.
      let fromRect = animate ? liveClientRect(cmtCard) : null;
      if (fromRect && cmtBox.classList.contains('is-on')) fromRect = shownRect(cmtBox, cmtBoxClips[2]);
      const annot = closingTarget ? cmtAnnot(closingTarget) : null;
      /** @type {?HTMLElement} */
      let face = null;
      if (fromRect && annot && annot.comment && !reducedMotion()) {
        face = /** @type {HTMLElement} */ (cmtCard.cloneNode(true));
        face.dataset.w = String(cmtCard.offsetWidth);
        face.dataset.h = String(cmtCard.offsetHeight);
      }

      cancelMsgEdit();
      clearCardMorphStyles();
      cmtCard.style.display = 'none';
      cmtCard.classList.remove('is-editing-msg', 'scribe-cmt-note-clean');
      cmtReplyOpen = false;
      cmtFromSeed = false;
      cmtTarget = null;
      cmtRestRect = null;
      collapseShelf();
      setCmtSel(false);
      syncOpenMarkVisibility();

      if (fromRect && closingTarget) {
        if (face) animateShellToBubble(fromRect, closingTarget, face);
        else fadeCardOut(fromRect, closingTarget);
      }
    };

    /**
     * Close the open card, first committing an in-place message edit or a composer draft.
     * @param {boolean} animate
     */
    const cmtDismiss = (animate) => {
      if (!cmtTarget) return;
      cmtCommit();
      cmtClose(animate);
    };

    /** @param {boolean} [animateExit] */
    const disarmLive = (animateExit = false) => {
      const fromRect = (animateExit && liveState) ? liveClientRect(seedElem) : null;
      const prevColor = liveState ? liveState.color : '';
      const prevLockRight = !!(liveState && liveState.spot && liveState.spot.lockRight);
      if (liveRaf !== null) { cancelAnimationFrame(liveRaf); liveRaf = null; }
      for (const el of liveEdges) el.remove();
      liveEdges = [];
      liveState = null;
      seedElem.style.display = 'none';
      if (fromRect) spawnExitFadeGhost(fromRect, prevColor, prevLockRight);
    };

    /**
     * Put the seed on its highlight's resting spot.
     * @returns {boolean} false when the spot is off screen or cannot be found, leaving the seed hidden.
     */
    const placeLiveSeed = () => {
      if (!liveState) return false;
      const home = targetScreenHome(liveState.target);
      if (!home) {
        seedElem.style.display = 'none';
        return false;
      }
      seedElem.style.animation = 'none';
      seedElem.style.display = 'inline-flex';
      seedElem.style.visibility = 'hidden';
      const base = fitSurfaceLayer();
      const view = home.view;
      const besideW = home.lockRight ? home.bRight - home.clearWall : home.clearWall - home.bLeft;
      let bare = liveState.isMin;
      seedElem.classList.toggle('scribe-hl-seed-min', bare);
      seedLabel.style.display = bare ? 'none' : '';
      if (!bare && (seedElem.offsetWidth || 118) > besideW) {
        bare = true;
        seedElem.classList.add('scribe-hl-seed-min');
        seedLabel.style.display = 'none';
      }
      if (bare) seedElem.title = 'Type or click to comment';
      else seedElem.removeAttribute('title');
      const pw = seedElem.offsetWidth || (bare ? 24 : 118);
      const ph = seedElem.offsetHeight || 22;
      let left;
      let top;
      if (pw <= besideW) {
        left = home.lockRight ? home.bRight - pw : home.bLeft;
        top = Math.max(view.top + 4, Math.min(view.bottom - ph - 4, home.bTop));
      } else {
        const rects = cmtAnchorRects(liveState.target);
        const last = rects.reduce((a, r) => (r.bottom > a.bottom ? r : a));
        left = Math.max(view.left + 6, Math.min(view.right - pw - 6, last.left));
        top = last.bottom + 6;
        if (top + ph > view.bottom - 4) top = Math.min(...rects.map((r) => r.top)) - 6 - ph;
      }
      const visible = home.bBottom > view.top + 4 && home.bTop < view.bottom - 4;
      if (!visible) {
        seedElem.style.display = 'none';
        seedElem.style.visibility = '';
        seedElem.style.animation = '';
        return false;
      }
      liveState.spot = {
        left, top, right: left + pw, bottom: top + ph, lockRight: home.lockRight,
      };
      seedElem.style.left = `${(left - base.left).toFixed(1)}px`;
      seedElem.style.top = `${(top - base.top).toFixed(1)}px`;
      seedElem.style.visibility = '';
      seedElem.style.animation = '';
      return true;
    };

    /**
     * Turn the seed into the card, growing it out of the seed's spot with the composer holding `initialText`.
     * @param {string} initialText - The key or pasted text that opened it, '' for a click.
     */
    const openCardFromSeed = (initialText) => {
      if (!liveState) return;
      const { target } = liveState;
      // Measured now, before opening the card takes the seed down.
      const seedRect = liveClientRect(seedElem);
      cmtOpen(target, seedRect, initialText);
      cmtFromSeed = cmtSameTarget(cmtTarget, target);
    };

    armLiveHighlight = (words) => {
      // The seed answers to hover and to typing, which a touch screen has neither of.
      // A tapped highlight gets the action callout instead.
      if (scribe._lastPrimaryPointerType === 'touch') return;
      dismissTransient();

      const view = (scribe.scrollContainer || editorHost).getBoundingClientRect();
      if (view.width < 40 || view.height < 40) return;
      let anchorWord = null;
      /** @type {Array<HTMLDivElement>} */
      let bands = [];
      for (const w of words) {
        if (!w.highlightColor || !w.highlightGroupId) continue;
        const arr = scribe._highlightRectsByGroup[w.word.line.page.n]?.get(w.highlightGroupId);
        if (!arr || arr.length === 0) continue;
        const vis = arr.some((b) => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.bottom > view.top + 4 && r.top < view.bottom - 4
            && r.right > view.left + 4 && r.left < view.right - 4;
        });
        if (vis) {
          anchorWord = w;
          bands = arr;
          break;
        }
      }
      if (!anchorWord) return;

      // After two comments made through the seed, it drops its "Type to comment" label.
      let isMin = memGradCount >= 2;
      try { isMin = (Number(window.localStorage.getItem(HL_COMMENT_COUNT_KEY)) || 0) >= 2; } catch { /* storage unavailable */ }
      const color = anchorWord.highlightColor || highlightColor;
      seedBar.style.background = color;
      liveState = {
        target: highlightTarget(anchorWord, 'highlight'),
        color,
        isMin,
        spot: null,
      };
      if (!placeLiveSeed()) {
        disarmLive(false);
        return;
      }
      liveEdges = createInkEdges(bands);

      const liveTick = () => {
        if (!liveState) { liveRaf = null; return; }
        // The highlight is gone, or has gained a comment by another route.
        const annot = cmtAnnot(liveState.target);
        if (!annot || annot.comment) {
          disarmLive(false);
          return;
        }
        // A render rebuilt the highlight's bands under the seed.
        if (liveEdges.length === 0 || liveEdges.some((el) => !el.isConnected)) {
          for (const el of liveEdges) el.remove();
          liveEdges = createInkEdges(targetBands(liveState.target));
          if (!placeLiveSeed()) { disarmLive(false); return; }
        }
        liveRaf = requestAnimationFrame(liveTick);
      };
      liveRaf = requestAnimationFrame(liveTick);
    };
    scribe._armLiveHighlight = armLiveHighlight;
    dismissLiveHighlight = () => {
      if (cmtFromSeed) cmtDismiss(false);
      disarmLive(false);
    };

    seedElem.addEventListener('pointerdown', (e) => e.stopPropagation());
    seedElem.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    seedElem.addEventListener('click', (e) => {
      e.stopPropagation();
      openCardFromSeed('');
    });
    seedElem.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();
      openCardFromSeed('');
    });

    /** @param {KeyboardEvent|ClipboardEvent} e */
    const typingElsewhere = (e) => {
      const tgt = e.target instanceof HTMLElement ? e.target : null;
      const act = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return !!((tgt && (tgt instanceof HTMLInputElement || tgt instanceof HTMLTextAreaElement || tgt instanceof HTMLSelectElement || tgt.isContentEditable))
        || (act && (act instanceof HTMLInputElement || act instanceof HTMLTextAreaElement || act instanceof HTMLSelectElement || act.isContentEditable))
        || UiText.input
        || scribe.state.layoutMode
        || scribe._editTextActive
        || scribe._graphicsEditActive
        || (act && act !== document.body && act !== document.documentElement && !rootElem.contains(act)));
    };
    // While the seed is up, the keyboard belongs to it.
    const onLiveKeydown = (e) => {
      if (!liveState || e.defaultPrevented || e.isComposing || typingElsewhere(e)) return;
      if (editorHost.offsetParent === null && getComputedStyle(editorHost).display === 'none') return;

      if (e.key === 'Escape') {
        if (isContextMenuOpen() || rootElem.querySelector('.scribe-hl-pop.open, .scribe-dropdown-open')) return;
        e.preventDefault();
        disarmLive(true);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Backspace' || e.key === 'Delete') {
        // Takes the fresh highlight back as an undo while it is still the last edit, so the history holds no add-then-remove pair.
        const { kw } = liveState.target;
        disarmLive(false);
        const { undoStack } = scribe.doc.docHistory;
        const topUndo = undoStack[undoStack.length - 1];
        if (topUndo && topUndo.label === 'Added highlight') scribe.undo();
        else removeHighlightGroup(scribe, kw, 'highlight');
        updateCommentIcons();
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // Keys that scroll the page leave the seed behind.
      if (e.key === ' ' || e.key === 'PageDown' || e.key === 'PageUp'
        || e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        disarmLive(false);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        openCardFromSeed('');
        return;
      }
      if (e.key.length === 1) {
        e.preventDefault();
        e.stopPropagation();
        openCardFromSeed(e.key);
      }
    };
    const onLivePaste = (e) => {
      if (!liveState || e.defaultPrevented || typingElsewhere(e)) return;
      const pasted = e.clipboardData?.getData('text/plain')?.trim() || '';
      if (!pasted) return;
      e.preventDefault();
      e.stopPropagation();
      openCardFromSeed(pasted);
    };
    document.addEventListener('keydown', onLiveKeydown, true);
    document.addEventListener('paste', onLivePaste, true);

    // ---- Hovering marks and highlights, and opening the card ----
    // The pointer over a commented highlight pairs it with its bubble: the bubble leans toward the highlight and the highlight's bands lift.
    /** The group whose highlight and bubble are paired. @type {?string} */
    let activeHoverGroupId = null;
    /** The mark under the pointer, shown unrolled. @type {?HTMLElement} */
    let unrolledMarkEl = null;
    /** @type {?ReturnType<typeof setTimeout>} */
    let hoverExitTimer = null;
    /** @type {Array<HTMLElement>} */
    let pairedLitBands = [];

    const syncBubbleHoverState = () => {
      for (const b of pairedLitBands) b.classList.remove('scribe-hl-hover');
      pairedLitBands = [];
      if (!scribe.elem) return;

      if (activeHoverGroupId) {
        for (const map of scribe._highlightRectsByGroup) {
          const arr = map && map.get(activeHoverGroupId);
          if (arr) pairedLitBands.push(...arr);
        }
        for (const b of pairedLitBands) b.classList.add('scribe-hl-hover');
      }
      for (const mark of scribe.elem.querySelectorAll('.scribe-hl-cmark, .scribe-note-icon')) {
        const hm = /** @type {HTMLElement} */ (mark);
        const isNote = hm.classList.contains('scribe-note-icon');
        const hidden = hm.classList.contains('is-hidden-for-card') || hm.classList.contains('is-morph-target');
        const paired = !isNote && !hidden && !!activeHoverGroupId && hm.dataset.groupId === activeHoverGroupId;
        const unrolled = !hidden && hm === unrolledMarkEl;
        const wasUnrolled = hm.classList.contains('is-unrolled');
        if (unrolled === wasUnrolled) {
          if (!isNote) hm.classList.toggle('is-active', paired || unrolled);
          continue;
        }

        // Overlay a full-width preview strip and reveal it by translating its clip container so hover animations run on the compositor.
        const lockRight = hm.dataset.lockRight === '1';
        let strip = /** @type {?HTMLElement} */ (hm.querySelector('.scribe-bub-strip'));
        if (strip && strip.classList.contains('is-lock-right') !== lockRight) {
          dropPreviewStrip(hm);
          strip = null;
        }
        const building = unrolled && !strip;
        // Opening reads `restBarOp` and `restLinesOp` before toggling classes so the strip starts from the mark's current opacity.
        // Closing toggles classes first so those reads capture the target opacity the mark will settle to.
        if (!building) {
          if (!isNote) hm.classList.toggle('is-active', paired || unrolled);
          hm.classList.toggle('is-unrolled', unrolled);
        }
        if (!building && !strip) continue;
        const ownBar = /** @type {?HTMLElement} */ (hm.querySelector(':scope > .scribe-cm-bar'));
        const ownLines = /** @type {?HTMLElement} */ (hm.querySelector(':scope > .scribe-bub-body > .scribe-bub-lines'));
        const restBarOp = ownBar ? getComputedStyle(ownBar).opacity : '0.5';
        const restLinesOp = ownLines ? getComputedStyle(ownLines).opacity : '0.58';
        if (!strip) {
          strip = document.createElement('span');
          strip.className = `scribe-bub-strip ${lockRight ? 'is-lock-right' : 'is-lock-left'}`;
          // Left-anchored strips counter-translate `.scribe-strip-face` inside `.scribe-strip-slide`, so `.scribe-strip-cap` rides on `slide` to draw the moving right border.
          // Right-anchored strips translate `slide` and `face` together from the right, so `cap` stays on `.scribe-strip-clip` to close the fixed right edge.
          const cap = '<span class="scribe-strip-cap"></span>';
          strip.innerHTML = '<span class="scribe-strip-shade is-rest"></span><span class="scribe-strip-shade is-open"></span>'
            + '<span class="scribe-strip-clip"><span class="scribe-strip-slide"><span class="scribe-strip-face"><span class="scribe-bub-box"></span>'
            + `${isNote ? '' : '<span class="scribe-strip-bar"></span>'}<span class="scribe-strip-lines"></span>`
            + '<span class="scribe-strip-text"><span class="scribe-prev-txt"></span><span class="scribe-prev-ell">…</span></span></span>'
            + `${lockRight ? '' : cap}</span>${lockRight ? cap : ''}</span>${BUBBLE_TIP_SVG}`;
          if (ownBar) /** @type {HTMLElement} */ (strip.querySelector('.scribe-strip-bar')).style.background = ownBar.style.background;
          const stripLines = /** @type {HTMLElement} */ (strip.querySelector('.scribe-strip-lines'));
          stripLines.innerHTML = ownLines ? ownLines.innerHTML : '';
          stripLines.style.color = ownLines ? getComputedStyle(ownLines).color : '';
          /** @type {HTMLElement} */ (strip.querySelector('.scribe-prev-txt')).textContent = hm.dataset.previewText || '';
          /** @type {HTMLElement} */ (strip.querySelector('.scribe-prev-ell')).hidden = hm.dataset.hasEllipsis !== '1';
        }
        const part = (sel) => /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (strip).querySelector(sel));

        const z = scribe.zoomLevel;
        const unrollW = parseFloat(hm.style.getPropertyValue('--scribe-unroll-w')) || 196;
        const restW = isNote ? 22 : 30;
        const shrink = Math.min(1, z / (parseFloat(getComputedStyle(hm).getPropertyValue('--scribe-bub-z')) || z));
        const travel = (lockRight ? 1 : -1) * (unrollW - restW) / z;
        const slideX = (v) => `translateX(${v.toFixed(3)}px)`;
        const curve = 'cubic-bezier(.22,1,.36,1)';
        // Each row is one part and one property: its value at rest and unrolled, then the duration, easing and delay toward unrolled and toward rest.
        /** @type {Array<[HTMLElement, 'transform'|'opacity', string, string, number, string, number, number, string, number]>} */
        const moves = [
          [part('.scribe-strip-slide'), 'transform', slideX(travel), slideX(0), 200, curve, 0, 200, curve, 0],
          [part('.scribe-strip-shade.is-open'), 'transform', `scaleX(${(restW / unrollW).toFixed(4)})`, 'scaleX(1)', 200, curve, 0, 200, curve, 0],
          [part('.scribe-strip-shade.is-open'), 'opacity', '0', '1', 180, 'ease', 0, 180, 'ease', 0],
          [part('.scribe-strip-shade.is-rest'), 'opacity', '1', '0', 180, 'ease', 0, 180, 'ease', 0],
          [part('.scribe-strip-lines'), 'opacity', restLinesOp, '0', 75, 'ease', 0, 120, 'ease', 55],
          [part('.scribe-strip-lines'), 'transform', 'scaleX(1)', 'scaleX(0.72)', 120, curve, 0, 140, curve, 45],
          [part('.scribe-strip-text'), 'opacity', '0', '1', 130, 'ease', 45, 80, 'ease', 0],
          [part('.scribe-strip-text'), 'transform', slideX(2 / z), slideX(0), 160, curve, 35, 120, curve, 0],
        ];
        if (!isNote) {
          moves.push(
            [part('.scribe-strip-bar'), 'transform', `scaleY(${(11.5 / 13.5).toFixed(4)})`, 'scaleY(1)', 160, curve, 0, 160, curve, 0],
            [part('.scribe-strip-bar'), 'opacity', restBarOp, '0.88', 140, 'ease', 0, 140, 'ease', 0],
          );
        }
        if (!lockRight) moves.push([part('.scribe-strip-face'), 'transform', slideX(-travel), slideX(0), 200, curve, 0, 200, curve, 0]);
        if (shrink < 0.999) {
          // Shift the full-size strip out to 10px from the text as it scales up so its pointer tip does not overlap the highlight.
          const back = isNote ? 0 : (lockRight ? -1 : 1) * Math.max(0, 10 - (Number(hm.dataset.textGap) || 10)) / z;
          moves.push([strip, 'transform', `translateX(0px) scale(${shrink.toFixed(4)})`, `translateX(${back.toFixed(3)}px) scale(1)`, 200, curve, 0, 200, curve, 0]);
        }
        if (building) {
          for (const [node, prop, atRest] of moves) node.style[prop] = atRest;
          hm.appendChild(strip);
          hm.classList.add('has-strip');
          // Flush initial styles before adding `is-unrolled` so CSS border transitions on the newly mounted strip run.
          strip.getBoundingClientRect();
          if (!isNote) hm.classList.toggle('is-active', paired || unrolled);
          hm.classList.toggle('is-unrolled', unrolled);
        }

        const starts = moves.map(([node, prop, atRest]) => {
          const now = getComputedStyle(node);
          if (prop === 'opacity') return now.opacity;
          const m = new DOMMatrixReadOnly(now.transform);
          if (node === strip) return `translateX(${m.e.toFixed(3)}px) scale(${m.a.toFixed(4)})`;
          const fn = atRest.slice(0, atRest.indexOf('('));
          return fn === 'translateX' ? slideX(m.e) : `${fn}(${(fn === 'scaleY' ? m.d : m.a).toFixed(4)})`;
        });
        // Sample keyframes dividing out `strip`'s concurrent scale change so the visible preview width still interpolates linearly when `shrink < 1`.
        const fullW = unrollW / z;
        const scaleNow = shrink < 0.999 ? new DOMMatrixReadOnly(getComputedStyle(strip).transform).a : 1;
        const scaleEnd = unrolled || shrink >= 0.999 ? 1 : shrink;
        const shownNow = (fullW - Math.abs(new DOMMatrixReadOnly(getComputedStyle(part('.scribe-strip-slide')).transform).e)) * scaleNow;
        const shownEnd = (fullW - (unrolled ? 0 : Math.abs(travel))) * scaleEnd;
        const windowFrames = (sign) => Array.from({ length: 9 }, (_, i) => {
          const q = i / 8;
          return { transform: slideX(sign * (fullW - (shownNow + (shownEnd - shownNow) * q) / (scaleNow + (scaleEnd - scaleNow) * q))), offset: q };
        });
        for (const anim of strip.getAnimations({ subtree: true })) anim.cancel();
        const still = reducedMotion();
        const anims = moves.map(([node, prop, atRest, atOpen, msOpen, easeOpen, waitOpen, msRest, easeRest, waitRest], i) => node.animate(
          node.classList.contains('scribe-strip-slide') || node.classList.contains('scribe-strip-face')
            ? windowFrames((node.classList.contains('scribe-strip-slide') ? 1 : -1) * Math.sign(travel))
            : [{ [prop]: starts[i] }, { [prop]: unrolled ? atOpen : atRest }],
          {
            duration: still ? 0 : (unrolled ? msOpen : msRest), easing: unrolled ? easeOpen : easeRest, delay: still ? 0 : (unrolled ? waitOpen : waitRest), fill: 'both',
          },
        ));
        Promise.all(anims.map((anim) => anim.finished)).then(() => {
          if (!unrolled) {
            dropPreviewStrip(hm);
            return;
          }
          for (const [node, prop, , atOpen] of moves) node.style[prop] = atOpen;
          for (const anim of anims) anim.cancel();
        }, () => {});
      }
    };

    const clearHover = () => {
      // On a highlight's words the selection engine holds the light of the group's row in the comments panel.
      // On the bubble, or between the two, the light was put on from here, so it is put out from here.
      const litFromHere = activeHoverGroupId && (unrolledMarkEl || !(cmtMoveEvt && highlightWordAt(/** @type {MouseEvent} */ (cmtMoveEvt))));
      unrolledMarkEl = null;
      activeHoverGroupId = null;
      syncBubbleHoverState();
      if (litFromHere && scribe.onHighlightHover) scribe.onHighlightHover(null);
    };

    /**
     * Whether a client point is on a group's highlight, between two of its lines, or in the strip between the highlight and its bubble.
     * The pointer traveling from one to the other stays on the pair, so the pairing does not drop on the way.
     */
    const isInsideHighlightCorridor = (groupId, clientX, clientY) => {
      /** @type {Array<DOMRect>} */
      const bRects = [];
      for (const map of scribe._highlightRectsByGroup) {
        const arr = map && map.get(groupId);
        if (arr) {
          for (const b of arr) {
            const r = b.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) bRects.push(r);
          }
        }
      }
      if (bRects.length === 0) return false;
      bRects.sort((a, b) => a.top - b.top || a.left - b.left);
      for (let i = 0; i < bRects.length; i++) {
        const r = bRects[i];
        if (clientX >= r.left - 4 && clientX <= r.right + 4 && clientY >= r.top - 4 && clientY <= r.bottom + 4) return true;
        if (i + 1 < bRects.length) {
          const rn = bRects[i + 1];
          if (rn.top - r.bottom < 28 && clientY >= r.bottom - 3 && clientY <= rn.top + 3) {
            const t = Math.max(0, Math.min(1, (clientY - r.bottom) / Math.max(1, rn.top - r.bottom)));
            const xMin = r.left + (rn.left - r.left) * t - 8;
            const xMax = r.right + (rn.right - r.right) * t + 8;
            if (clientX >= xMin && clientX <= xMax) return true;
          }
        }
      }
      const markEl = /** @type {?HTMLElement} */ (scribe.elem.querySelector(`.scribe-hl-cmark[data-group-id="${groupId}"]`));
      if (!markEl || markEl.classList.contains('is-hidden-for-card')) return false;
      const mRect = markEl.getBoundingClientRect();
      if (mRect.width <= 0 || mRect.height <= 0) return false;
      const hlL = Math.min(...bRects.map((r) => r.left));
      const hlR = Math.max(...bRects.map((r) => r.right));
      const hlT = Math.min(...bRects.map((r) => r.top));
      const hlB = Math.max(...bRects.map((r) => r.bottom));
      const tail = markEl.dataset.tail || '';
      if (tail === 'is-left' && clientX >= mRect.left - 4 && clientX <= hlL + 14) {
        const u = Math.max(0, Math.min(1, (clientX - mRect.right) / Math.max(1, hlL - mRect.right)));
        const yMin = (mRect.top - 5) + (Math.min(mRect.top - 5, hlT - 4) - (mRect.top - 5)) * u;
        const yMax = (mRect.bottom + 5) + (Math.max(mRect.bottom + 5, hlB + 4) - (mRect.bottom + 5)) * u;
        return clientY >= yMin && clientY <= yMax;
      }
      if (tail === 'is-right' && clientX >= hlR - 14 && clientX <= mRect.right + 4) {
        const u = Math.max(0, Math.min(1, (mRect.left - clientX) / Math.max(1, mRect.left - hlR)));
        const yMin = (mRect.top - 5) + (Math.min(mRect.top - 5, hlT - 4) - (mRect.top - 5)) * u;
        const yMax = (mRect.bottom + 5) + (Math.max(mRect.bottom + 5, hlB + 4) - (mRect.bottom + 5)) * u;
        return clientY >= yMin && clientY <= yMax;
      }
      return false;
    };

    let cmtMoveRaf = null;
    /** @type {?{clientX: number, clientY: number, target: EventTarget|null, buttons: number}} */
    let cmtMoveEvt = null;

    /**
     * Open the card on a target, growing it out of the target's mark.
     * @param {CommentTarget} target
     * @param {?{left: number, top: number, right: number, bottom: number, w: number, h: number}} [seedRect] - The seed's rect, when the card takes the seed's place.
     * @param {string} [draft] - Text to start the composer with.
     */
    const cmtOpen = (target, seedRect = null, draft = '') => {
      if (cmtMoveRaf !== null) { cancelAnimationFrame(cmtMoveRaf); cmtMoveRaf = null; }
      if (hoverExitTimer) { clearTimeout(hoverExitTimer); hoverExitTimer = null; }
      disarmLive(false);
      if (cmtSameTarget(cmtTarget, target)) {
        if (cmtReply.isConnected) cmtText.focus({ preventScroll: true });
        else cmtCard.focus({ preventScroll: true });
        return;
      }
      cmtDismiss(true);

      // What the card grows out of is read here, before the mark is hidden for the card.
      const key = targetKey(target);
      const activeMorph = shellMorphs.get(key);
      const markEl = cmtMarkEl(target);
      /** @type {?{left: number, top: number, right: number, bottom: number, w: number, h: number}} */
      let fromRect = null;
      let wasUnrolled = false;
      let startTextOp = 0;
      let startBarH = 11.5;
      let startBarOp = 0.5;
      /** @type {?DOMRect} */
      let prevTxtScreen = null;
      /** @type {?HTMLElement} */
      let markGhost = null;
      const markHome = targetScreenHome(target);
      const markInView = !!markHome && !markHome.offscreen;
      if (activeMorph) {
        fromRect = activeMorph.rect();
        cancelShellMorph(key);
      } else if (markEl && markInView && !markEl.classList.contains('is-hidden-for-card')) {
        const strip = /** @type {?HTMLElement} */ (markEl.querySelector('.scribe-bub-strip'));
        if (strip) {
          const outer = /** @type {HTMLElement} */ (strip.querySelector('.scribe-strip-clip')).getBoundingClientRect();
          const inner = /** @type {HTMLElement} */ (strip.querySelector('.scribe-strip-slide')).getBoundingClientRect();
          const left = Math.max(outer.left, inner.left);
          const right = Math.min(outer.right, inner.right);
          if (right > left && outer.height > 0) {
            fromRect = {
              left, top: outer.top, right, bottom: outer.bottom, w: right - left, h: outer.height,
            };
          }
        }
        if (!fromRect) fromRect = liveClientRect(markEl);
        wasUnrolled = markEl.classList.contains('is-unrolled');
        const prevNode = /** @type {?HTMLElement} */ (strip ? strip.querySelector('.scribe-strip-text') : null);
        const barNode = /** @type {?HTMLElement} */ (strip ? strip.querySelector('.scribe-strip-bar') : markEl.querySelector('.scribe-cm-bar'));
        // Opacities are read live, since a press can land while the preview is still unrolling.
        if (prevNode) startTextOp = Math.max(0, Math.min(1, parseFloat(getComputedStyle(prevNode).opacity) || 0));
        if (barNode) {
          startBarH = barNode.getBoundingClientRect().height;
          startBarOp = Math.max(0, Math.min(1, parseFloat(getComputedStyle(barNode).opacity) || 0.5));
        }
        const pTxt = strip ? strip.querySelector('.scribe-prev-txt') : null;
        if (pTxt && wasUnrolled) prevTxtScreen = pTxt.getBoundingClientRect();

        const r = markEl.getBoundingClientRect();
        if (!wasUnrolled && !reducedMotion() && r.width > 0 && r.height > 0) {
          const base = fitSurfaceLayer();
          const { z, effZ } = computePageBubbleZoom(scribe, target.n);
          const copy = /** @type {HTMLElement} */ (markEl.cloneNode(true));
          copy.removeAttribute('tabindex');
          copy.removeAttribute('data-group-id');
          copy.removeAttribute('data-note-idx');
          const live = [markEl, ...markEl.querySelectorAll('*')];
          const still = [copy, ...copy.querySelectorAll('*')];
          for (let i = 0; i < live.length; i++) {
            const now = getComputedStyle(live[i]);
            const part = /** @type {HTMLElement} */ (still[i]);
            part.style.transition = 'none';
            part.style.opacity = now.opacity;
            part.style.transform = now.transform;
          }
          // Subtract `markEl`'s hover transform from `r` because `copy` already carries that transform inline.
          const lean = new DOMMatrixReadOnly(getComputedStyle(markEl).transform);
          copy.style.left = '0';
          copy.style.top = '0';
          copy.style.right = 'auto';
          copy.style.margin = '0';
          const scaled = document.createElement('div');
          scaled.style.cssText = `position:absolute;left:0;top:0;transform-origin:0 0;transform:scale(${z});--scribe-zoom:${z};--scribe-live-zoom:${z};--scribe-bub-z:${effZ};`;
          scaled.appendChild(copy);
          markGhost = document.createElement('div');
          markGhost.className = 'scribe-mark-copy';
          markGhost.style.cssText = `left:${(r.left - lean.e * z - base.left).toFixed(2)}px;top:${(r.top - lean.f * z - base.top).toFixed(2)}px;`;
          markGhost.appendChild(scaled);
        }
        dropPreviewStrip(markEl);
      } else if (seedRect) {
        fromRect = seedRect;
        // The seed's bar is 12px tall at full strength.
        startBarH = 12;
        startBarOp = 1;
      } else if (markHome && markInView) {
        fromRect = {
          left: markHome.bLeft, top: markHome.bTop, right: markHome.bRight, bottom: markHome.bBottom, w: markHome.restW, h: markHome.restH,
        };
      }

      clearHover();

      cmtReplyOpen = false;
      cmtTarget = target;
      cmtFill(target);
      if (draft) cmtText.value = draft;
      if (!cmtPlace(target)) { cmtClose(false); return; }
      if (!fromRect && cmtRestRect) {
        fromRect = {
          left: cmtRestRect.left, top: cmtRestRect.top, right: cmtRestRect.left + 30, bottom: cmtRestRect.top + 22, w: 30, h: 22,
        };
      }
      setCmtSel(true);
      syncOpenMarkVisibility();

      if (fromRect && cmtRestRect && !reducedMotion()) {
        const finalRect = cmtRestRect;
        const base = fitSurfaceLayer();
        const cw = finalRect.w;
        const ch = finalRect.h;
        const dx = fromRect.left - finalRect.left;
        const dy = fromRect.top - finalRect.top;
        const timing = { duration: 205, easing: EASE_OUT, fill: 'both' };
        /** @type {Animation[]} */
        const anims = [];
        if (markGhost) {
          surfaceLayer.appendChild(markGhost);
          cardMorphExtras.push(markGhost);
          anims.push(
            markGhost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 70, easing: 'linear', fill: 'both' }),
            markGhost.animate([{ transform: slideTo(0, 0) }, { transform: slideTo(-dx, -dy) }], timing),
          );
        }
        const placed = `left:${(finalRect.left - base.left).toFixed(2)}px;top:${(finalRect.top - base.top).toFixed(2)}px;width:${cw}px;height:${ch}px;`;
        cardMorphPos = [cmtCard.style.left, cmtCard.style.top];
        cmtBox.style.cssText = placed;
        for (const node of [...cmtBoxClips, ...cmtBoxEdges]) node.style.cssText = `width:${cw}px;height:${ch}px;`;
        cmtBox.classList.add('is-on');
        cmtCard.style.left = '0px';
        cmtCard.style.top = '0px';
        for (const kind of ['', ' is-ring']) {
          const shade = document.createElement('div');
          shade.className = `scribe-cmt-shade${kind}`;
          shade.style.cssText = placed;
          surfaceLayer.insertBefore(shade, cmtBox);
          cardMorphExtras.push(shade);
          anims.push(shade.animate([
            { transform: `translate(${dx.toFixed(2)}px,${dy.toFixed(2)}px) scale(${(fromRect.w / cw).toFixed(4)},${(fromRect.h / ch).toFixed(4)})` },
            { transform: 'translate(0px,0px) scale(1,1)' },
          ], timing));
          if (kind) anims.push(shade.animate([{ opacity: 0, offset: 0 }, { opacity: 1, offset: 0.83 }, { opacity: 1, offset: 1 }], timing));
        }
        anims.push(...windowAnims({
          box: cmtBox, clips: cmtBoxClips, edges: cmtBoxEdges, inner: cmtCard,
        }, cw, ch, {
          x: dx, y: dy, w: fromRect.w, h: fromRect.h,
        }, {
          x: 0, y: 0, w: cw, h: ch,
        }, timing));
        if (!cmtBar.hidden) {
          cmtBar.style.transformOrigin = '50% 0';
          anims.push(
            cmtBar.animate([{ transform: `translate(-1px,-1.5px) scaleY(${(startBarH / 16).toFixed(4)})` }, { transform: 'translate(0px,0px) scaleY(1)' }], timing),
            cmtBar.animate([{ opacity: startBarOp }, { opacity: 1 }], timing),
          );
        }
        const mtext = prevTxtScreen ? cmtThread.querySelector('.scribe-cmt-mtext') : null;
        if (wasUnrolled && mtext && prevTxtScreen) {
          // An unrolled mark already shows the comment's first words, which are also the card's first message.
          // The thread starts offset so those words sit where the preview drew them, then glides to its own place.
          const cardScreen = cmtCard.getBoundingClientRect();
          const mtScreen = mtext.getBoundingClientRect();
          const textOffX = mtScreen.left - cardScreen.left;
          const textOffY = mtScreen.top - cardScreen.top;
          const tx0 = (prevTxtScreen.left - fromRect.left) - textOffX;
          const ty0 = (prevTxtScreen.top - fromRect.top) - textOffY;
          anims.push(
            cmtThread.animate([{ transform: slideTo(tx0, ty0) }, { transform: slideTo(0, 0) }], timing),
            cmtThread.animate([{ opacity: startTextOp, offset: 0 }, { opacity: startTextOp, offset: 0.10 }, { opacity: 1, offset: 0.78 }, { opacity: 1, offset: 1 }], timing),
          );
          for (const fNode of cmtThread.querySelectorAll('.scribe-cmt-foot, .scribe-cmt-empty-foot')) {
            anims.push(fNode.animate([{ opacity: 0, offset: 0 }, { opacity: 0, offset: 0.18 }, { opacity: 1, offset: 0.86 }, { opacity: 1, offset: 1 }], timing));
          }
          const ellLeft = textOffX - 1 + (Number(markEl?.dataset.prefixPx) || prevTxtScreen.width);
          if (markEl?.dataset.hasEllipsis === '1' && startTextOp > 0.25 && ellLeft < fromRect.w - 6) {
            // The preview's ellipsis has no counterpart in the card, so a copy of it rides with the thread and fades out.
            const ell = document.createElement('span');
            ell.className = 'scribe-card-ell-fade';
            ell.style.cssText = `left:${ellLeft.toFixed(2)}px;top:${(textOffY - 1).toFixed(2)}px;`;
            ell.textContent = '…';
            cmtCard.appendChild(ell);
            anims.push(
              ell.animate([{ transform: slideTo(tx0, ty0) }, { transform: slideTo(0, 0) }], timing),
              ell.animate([{ opacity: startTextOp, offset: 0 }, { opacity: 0, offset: 0.32 }, { opacity: 0, offset: 1 }], timing),
            );
          }
        } else {
          const growUp = target.kind === 'note' && Math.abs(fromRect.bottom - finalRect.bottom) <= 12;
          anims.push(
            cmtThread.animate([{ transform: slideTo(0, growUp ? 2.5 : -2.5) }, { transform: slideTo(0, 0) }], timing),
            cmtThread.animate([{ opacity: 0, offset: 0 }, { opacity: 0, offset: 0.14 }, { opacity: 1, offset: 0.86 }, { opacity: 1, offset: 1 }], timing),
          );
        }
        if (cmtPlaceScrolled !== 0) {
          anims.push(scribe.contentSizer.animate([{ transform: `translateY(${cmtPlaceScrolled.toFixed(2)}px)` }, { transform: 'translateY(0px)' }], timing));
        }
        cardAnims = anims;
        Promise.all(anims.map((anim) => anim.finished)).then(() => {
          if (cardAnims === anims) clearCardMorphStyles();
        }, () => {});
      }

      if (cmtReply.isConnected) cmtText.focus({ preventScroll: true });
      else cmtCard.focus({ preventScroll: true });
      if (draft) cmtText.setSelectionRange(draft.length, draft.length);
    };

    /**
     * The highlighted word under an event's pointer.
     * @param {MouseEvent} event
     */
    const highlightWordAt = (event) => {
      if (scribe.useCustomSelection) return scribe.textSel.hitTestHighlight(event.clientX, event.clientY)?.kw ?? null;
      const wordEl = event.target instanceof Element ? event.target.closest('.scribe-word') : null;
      return wordEl ? /** @type {any} */ (wordEl)._scribeObj : null;
    };

    /** @returns {?CommentTarget} */
    const markTargetFromEvent = (event) => {
      if (!(event.target instanceof Element)) return null;
      const mark = /** @type {?HTMLElement} */ (event.target.closest('.scribe-hl-cmark'));
      if (mark) {
        const slot = mark.dataset.slot === 'line' ? 'line' : 'highlight';
        const kw = scribe.getUiWords().find((w) => (slot === 'line' ? w.markupGroupId : w.highlightGroupId) === mark.dataset.groupId);
        return kw ? highlightTarget(kw, slot) : null;
      }
      const noteEl = /** @type {?HTMLElement} */ (event.target.closest('.scribe-note-icon'));
      if (noteEl) {
        const n = Number(noteEl.dataset.pageN);
        const annot = pageNotes(scribe, n)[Number(noteEl.dataset.noteIdx)];
        return annot ? { kind: 'note', annot, n } : null;
      }
      return null;
    };

    /**
     * The card target a press or click lands on: a mark, or a word of a highlight or line markup, commented or not.
     * A word carrying both a fill and a line markup resolves to the fill, since the whole word is one target.
     * @returns {?CommentTarget}
     */
    const pressTargetFromEvent = (event) => {
      if (!(event.target instanceof Element)) return null;
      if (event.target.closest('.scribe-hl-cmark, .scribe-note-icon')) return markTargetFromEvent(event);
      if (!scribe.elem.contains(event.target)) return null;
      const kw = highlightWordAt(event);
      if (!kw || (!kw.highlightColor && !kw.markupType)) return null;
      return highlightTarget(kw, kw.highlightColor ? 'highlight' : 'line');
    };

    // With no word spans, the pointer crosses no element boundary over the text, so what it hovers is sampled on pointer move, once a frame.
    const onViewerPointerMove = (event) => {
      cmtMoveEvt = {
        clientX: event.clientX,
        clientY: event.clientY,
        target: event.target,
        buttons: event.buttons,
      };
      if (cmtMoveRaf !== null) return;
      cmtMoveRaf = requestAnimationFrame(() => {
        cmtMoveRaf = null;
        const ev = cmtMoveEvt;
        if (!ev || !scribe.elem) return;

        if ((ev.buttons !== 0 || scribe.textSel?._drag || scribe.selecting) && scribe.hasTextSelection()) cmtDismiss(false);

        const kw = highlightWordAt(/** @type {MouseEvent} */ (ev));

        // A press held on a mark keeps the mark as it is until the click lands.
        const pressingMark = ev.buttons !== 0
          && ev.target instanceof Element
          && !!ev.target.closest('.scribe-hl-cmark, .scribe-note-icon')
          && !scribe.textSel?._drag
          && !scribe.selecting;
        if (pressingMark) return;

        if (ev.buttons !== 0 || scribe.textSel?._drag || scribe.selecting || isContextMenuOpen()) {
          if (unrolledMarkEl || activeHoverGroupId) clearHover();
          return;
        }

        const tgtEl = ev.target instanceof Element ? ev.target : null;
        const hitCmark = /** @type {?HTMLElement} */ (tgtEl ? tgtEl.closest('.scribe-hl-cmark') : null);
        if (hitCmark && !hitCmark.classList.contains('is-hidden-for-card')) {
          if (hoverExitTimer) { clearTimeout(hoverExitTimer); hoverExitTimer = null; }
          const t = markTargetFromEvent(ev);
          if (t) cancelShellMorph(targetKey(t));
          const gid = hitCmark.dataset.groupId || null;
          const unroll = hitCmark.dataset.noPreview === '1' ? null : hitCmark;
          if (unrolledMarkEl !== unroll || activeHoverGroupId !== gid) {
            unrolledMarkEl = unroll;
            activeHoverGroupId = gid;
            syncBubbleHoverState();
            if (scribe.onHighlightHover) scribe.onHighlightHover(gid);
          }
          return;
        }

        const hitNote = /** @type {?HTMLElement} */ (tgtEl ? tgtEl.closest('.scribe-note-icon') : null);
        if (hitNote && !hitNote.classList.contains('is-hidden-for-card')) {
          if (hoverExitTimer) { clearTimeout(hoverExitTimer); hoverExitTimer = null; }
          const t = markTargetFromEvent(ev);
          if (t) cancelShellMorph(targetKey(t));
          const canUnroll = !!(t && t.kind === 'note' && t.annot?.comment && String(t.annot.comment).trim());
          const nextUnroll = canUnroll ? hitNote : null;
          if (unrolledMarkEl !== nextUnroll || activeHoverGroupId !== null) {
            if (activeHoverGroupId && !kw && scribe.onHighlightHover) scribe.onHighlightHover(null);
            unrolledMarkEl = nextUnroll;
            activeHoverGroupId = null;
            syncBubbleHoverState();
          }
          return;
        }

        const commentedGid = (kw && kw.highlightGroupId && kw.highlightComment)
          ? kw.highlightGroupId
          : ((kw && kw.markupGroupId && kw.markupComment) ? kw.markupGroupId : null);
        if (commentedGid) {
          if (hoverExitTimer) { clearTimeout(hoverExitTimer); hoverExitTimer = null; }
          if (unrolledMarkEl !== null || activeHoverGroupId !== commentedGid) {
            unrolledMarkEl = null;
            activeHoverGroupId = commentedGid;
            syncBubbleHoverState();
          }
          return;
        }

        if (activeHoverGroupId && isInsideHighlightCorridor(activeHoverGroupId, ev.clientX, ev.clientY)) {
          if (hoverExitTimer) { clearTimeout(hoverExitTimer); hoverExitTimer = null; }
          if (unrolledMarkEl !== null) {
            unrolledMarkEl = null;
            syncBubbleHoverState();
          }
          // The selection engine drops the lift and the panel row's light as the pointer leaves the highlight's words.
          // Both are put back while it crosses to the bubble, except over another highlight's words, where the engine's own hover stands.
          if (!kw) {
            for (const b of pairedLitBands) b.classList.add('scribe-hl-hover');
            if (scribe.onHighlightHover) scribe.onHighlightHover(activeHoverGroupId);
          }
          return;
        }

        if (unrolledMarkEl !== null) {
          unrolledMarkEl = null;
          syncBubbleHoverState();
        }
        if (activeHoverGroupId && !hoverExitTimer) {
          hoverExitTimer = setTimeout(() => {
            hoverExitTimer = null;
            clearHover();
          }, 65);
        }
      });
    };

    const onViewerPointerLeave = () => {
      if (hoverExitTimer) { clearTimeout(hoverExitTimer); hoverExitTimer = null; }
      if (unrolledMarkEl || activeHoverGroupId) clearHover();
    };

    const cmtPress = (event) => {
      if (paintedOnMouseup) { paintedOnMouseup = false; return; }
      if (!(event.target instanceof Element)) return;
      const markEl = /** @type {?HTMLElement} */ (event.target.closest('.scribe-hl-cmark, .scribe-note-icon'));
      if (markEl) {
        // The click that ends a note-mark drag must not open the card.
        if (markEl.dataset.dragged === '1') { markEl.dataset.dragged = ''; return; }
        event.stopPropagation();
      }
      const target = pressTargetFromEvent(event);
      if (!target) return;
      if (!markEl) {
        // A drag that leaves a text selection is a selection gesture, not a click on the highlight.
        if (scribe.hasTextSelection()) {
          cmtDismiss(false);
          return;
        }
        event.stopPropagation();
      }
      if (cmtSameTarget(cmtTarget, target)) {
        cmtDismiss(true);
        return;
      }
      if (!markEl && target.kind === 'highlight' && scribe._lastPrimaryPointerType === 'touch' && scribe._touchCalloutShow) {
        scribe._touchCalloutShow('markup', target.kw, target.slot);
        return;
      }
      cmtOpen(target);
    };

    const cmtKeyOpen = (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const t = markTargetFromEvent(event);
      if (!t) return;
      event.preventDefault();
      cmtOpen(t);
    };

    scribe.elem.addEventListener('pointermove', onViewerPointerMove);
    scribe.elem.addEventListener('pointerleave', onViewerPointerLeave);
    scribe.elem.addEventListener('click', cmtPress);
    scribe.elem.addEventListener('keydown', cmtKeyOpen);

    cmtCard.addEventListener('mousedown', (e) => e.stopPropagation());
    cmtCard.addEventListener('pointerdown', (e) => e.stopPropagation());
    cmtCard.addEventListener('contextmenu', (e) => e.stopPropagation());
    cmtCard.addEventListener('click', (e) => {
      e.stopPropagation();
      // An open swatch shelf folds when the click lands anywhere else on the card.
      if (shelfOpen() && !(e.target instanceof Node && (cmtShelf.contains(e.target) || cmtBar.contains(e.target)))) collapseShelf();
      const mtext = e.target instanceof Element && e.target.closest('.scribe-cmt-mtext');
      if (mtext instanceof HTMLElement) beginMsgEdit(mtext);
    });
    cmtText.addEventListener('input', () => {
      const beforeRect = liveClientRect(cmtCard);
      const beforeH = cmtText.style.height;
      cmtGrow();
      // A key that leaves the composer's height unchanged moves nothing.
      // Placing the card again for it would cut short the opening animation, which the keys after the one that opened the card land in.
      if (cmtTarget && cmtText.style.height !== beforeH) {
        cmtPlace(cmtTarget);
        animateCardResize(beforeRect, 120);
      }
    });
    const postDraft = () => {
      const beforeRect = liveClientRect(cmtCard);
      if (cmtCommit() && cmtTarget) {
        // A first comment typed straight after highlighting is finished once posted, so the card folds into the new bubble.
        if (cmtFromSeed) {
          cmtClose(true);
          return;
        }
        cmtReplyOpen = false;
        cmtFill(cmtTarget);
        cmtPlace(cmtTarget);
        animateCardResize(beforeRect);
        cmtCard.focus({ preventScroll: true });
      }
    };
    cmtPostBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      postDraft();
    });
    cmtReplyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!cmtTarget) return;
      const beforeRect = liveClientRect(cmtCard);
      if (commitMsgEdit()) {
        if (scribe._rebuildCommentsPanel) scribe._rebuildCommentsPanel();
        updateCommentIcons();
      }
      cmtReplyOpen = true;
      cmtFill(cmtTarget);
      cmtPlace(cmtTarget);
      animateCardResize(beforeRect);
      cmtText.focus({ preventScroll: true });
    });
    cmtCard.addEventListener('input', (e) => {
      if (cmtEditEl && e.target === cmtEditEl && cmtTarget) {
        const beforeRect = liveClientRect(cmtCard);
        cmtPlace(cmtTarget);
        animateCardResize(beforeRect, 120);
      }
    });
    cmtCard.addEventListener('keydown', (e) => {
      // Keep typing out of page shortcuts.
      e.stopPropagation();
      if (e.key === 'Enter') {
        if (cmtEditEl && e.target === cmtEditEl) {
          if (!e.shiftKey || e.ctrlKey || e.metaKey) {
            e.preventDefault();
            saveActiveMsgEdit();
          }
          return;
        }
        if ((cmtReply.isConnected && e.target === cmtText && !e.shiftKey) || e.ctrlKey || e.metaKey) {
          e.preventDefault();
          postDraft();
          return;
        }
      }
      if (e.key !== 'Escape') return;
      if (shelfOpen()) { collapseShelf(); return; }
      if (cmtEditEl) {
        e.preventDefault();
        cancelMsgEdit();
        cmtCard.focus({ preventScroll: true });
        return;
      }
      if (cmtText.value.trim()) {
        const beforeRect = liveClientRect(cmtCard);
        cmtText.value = '';
        cmtGrow();
        if (cmtTarget) {
          cmtPlace(cmtTarget);
          animateCardResize(beforeRect, 120);
        }
        return;
      }
      if (cmtReplyOpen && cmtTarget) {
        const beforeRect = liveClientRect(cmtCard);
        cmtReplyOpen = false;
        cmtFill(cmtTarget);
        cmtPlace(cmtTarget);
        animateCardResize(beforeRect);
        cmtCard.focus({ preventScroll: true });
        return;
      }
      // Focus returns to the mark, so the keyboard can open the card again.
      const markEl = cmtTarget && cmtMarkEl(cmtTarget);
      cmtClose(true);
      if (markEl) markEl.focus({ preventScroll: true });
    });

    cmtCard.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target instanceof Element && e.target.closest('textarea, button, .scribe-cmt-mtext, .scribe-cm-bar, .scribe-cmt-shelf')) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const r0 = cmtCard.getBoundingClientRect();
      const h = (scribe.scrollContainer || editorHost).getBoundingClientRect();
      const anchorRects = cmtTarget ? cmtAnchorRects(cmtTarget) : [];
      const anchor = anchorRects[anchorRects.length - 1];
      let dragging = false;
      const move = (ev) => {
        if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 3) {
          dragging = true;
          clearCardMorphStyles();
        }
        if (!dragging) return;
        const base = fitSurfaceLayer();
        const left = Math.max(h.left + 4, Math.min(h.right - r0.width - 4, r0.left + (ev.clientX - startX)));
        const top = Math.max(h.top + 4, Math.min(h.bottom - r0.height - 4, r0.top + (ev.clientY - startY)));
        cmtCard.style.left = `${(left - base.left).toFixed(1)}px`;
        cmtCard.style.top = `${(top - base.top).toFixed(1)}px`;
        cmtRestRect = {
          left, top, right: left + r0.width, bottom: top + r0.height, w: r0.width, h: r0.height,
        };
        if (anchor) cmtAnchorOff = { dx: left - anchor.left, dy: top - anchor.top };
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        cmtDragEnd = null;
      };
      cmtDragEnd = up;
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    const cmtBarToggle = () => {
      if (!cmtTarget || cmtTarget.kind !== 'highlight') return;
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
        // The recolor rebuilt the highlight layer, so the fresh mark is hidden again and the fresh bands re-inked.
        syncOpenMarkVisibility();
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
      scribe._revealCommentInPanel(cmtTarget.kind === 'highlight' ? cmtTarget.kw : cmtTarget.annot);
    });
    cmtDelete.addEventListener('click', (e) => {
      e.stopPropagation();
      const t = cmtTarget;
      if (!t) return;
      // Started before the removal, while the target's mark still says which side the card was anchored on.
      const fromRect = liveClientRect(cmtCard);
      if (fromRect) fadeCardOut(fromRect, t);
      cmtClose(false);
      if (t.kind === 'highlight') {
        removeHighlightGroup(scribe, t.kw, t.slot || 'highlight');
      } else {
        removeNote(scribe, t.annot, t.n);
        scribe.renderNotes(t.n);
      }
      updateCommentIcons();
      if (scribe._rebuildCommentsPanel) scribe._rebuildCommentsPanel();
    });

    /**
     * Dismiss whichever comment surface is up, the seed or the card, committing a draft or edit in flight.
     * A surface that holds `node` is left alone.
     * @param {?Node} [node] - Target of the event behind the dismissal.
     * @param {boolean} [animate]
     */
    const dismissTransient = (node = null, animate = false) => {
      if (liveState && !(node && seedElem.contains(node))) disarmLive(animate);
      if (!(node && cmtCard.contains(node))) cmtDismiss(animate);
    };

    // Capture phase, so the commit lands before the press can open another card or start a selection.
    const cmtOutsidePress = (event) => {
      paintedOnMouseup = false;
      if (event.button !== 0) return;
      const node = event.target instanceof Node ? event.target : null;
      // A press on the open card's own highlight or mark is left to the click that follows, which toggles the card shut.
      if (cmtTarget && !(node && cmtCard.contains(node)) && cmtSameTarget(cmtTarget, pressTargetFromEvent(event))) return;
      dismissTransient(node, true);
    };
    document.addEventListener('pointerdown', cmtOutsidePress, true);

    const cmtContextDismiss = (event) => dismissTransient(event.target instanceof Node ? event.target : null);
    document.addEventListener('contextmenu', cmtContextDismiss, true);

    // Double-click starts word text editing (editor build), so the card must not sit over the input.
    const cmtDblclick = (event) => {
      if (event.target instanceof Node && scribe.elem.contains(event.target)) dismissTransient(event.target);
    };
    document.addEventListener('dblclick', cmtDblclick);

    const cmtScrollDismiss = (event) => {
      if (event.type === 'scroll' && cmtSelfScroll) {
        cmtSelfScroll = false;
        return;
      }
      if (liveState) disarmLive(false);
      dismissTransient(event.target instanceof Node ? event.target : null);
    };
    scribe.scrollContainer?.addEventListener('scroll', cmtScrollDismiss, { passive: true });
    document.addEventListener('wheel', cmtScrollDismiss, { passive: true, capture: true });

    // A sidebar's glide or drag moves and resizes the document area on every frame, which shifts the pages under the open surface.
    const cmtFollow = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (liveState) placeLiveSeed();
      if (!cmtTarget) return;
      // Cancel any in-flight open animation first because `cmtCard` is parked at `0px, 0px` inside `cmtBox` while opening.
      if (cardAnims.length > 0) clearCardMorphStyles();
      const view = fitSurfaceLayer();
      if (!cmtAnchorOff) { cmtPlace(cmtTarget); return; }
      const rects = cmtAnchorRects(cmtTarget);
      if (rects.length === 0) return;
      const anchor = rects[rects.length - 1];
      const r = cmtCard.getBoundingClientRect();
      const left = Math.max(view.left + 4, Math.min(view.right - r.width - 4, anchor.left + cmtAnchorOff.dx));
      const top = Math.max(view.top + 4, Math.min(view.bottom - r.height - 4, anchor.top + cmtAnchorOff.dy));
      // Re-run `cmtPlace` when viewport clamping would shift the card, since clamping inward can push a margin card over its highlight.
      if (left !== anchor.left + cmtAnchorOff.dx || top !== anchor.top + cmtAnchorOff.dy) { cmtPlace(cmtTarget); return; }
      cmtCard.style.left = `${left - view.left}px`;
      cmtCard.style.top = `${top - view.top}px`;
      cmtRestRect = {
        left, top, right: left + r.width, bottom: top + r.height, w: r.width, h: r.height,
      };
    });
    cmtFollow?.observe(scribe.scrollContainer || editorHost);

    openCommentEditor = (words) => {
      if (!words || words.length === 0) return;
      const first = words[0];
      cmtOpen(highlightTarget(first, first.highlightColor || !first.markupType ? 'highlight' : 'line'));
    };
    scribe._openCommentEditor = openCommentEditor;
    // Let other surfaces (the Comments panel) refresh the on-page comment marks after editing a comment.
    scribe._updateCommentIcons = updateCommentIcons;
    scribe._openNoteEditor = (annot, pageIndex) => focusNoteEditor(scribe, pageIndex, annot);
    scribe._openNoteCard = (annot, n) => cmtOpen({ kind: 'note', annot, n });
    // The touch callout takes the place of any comment surface.
    scribe._dismissTransientPopovers = dismissTransient;

    const isWordOrLine = (n) => n instanceof HTMLElement
      && (n.classList.contains('scribe-word') || n.classList.contains('scribe-line'));
    const commentObserver = new MutationObserver((mutations) => {
      const hasRemoved = mutations.some((m) => [...m.removedNodes].some(isWordOrLine));
      if (!hasRemoved) return;
      // The removed words were only anchors, so an in-flight edit still has its annotations to commit to.
      dismissTransient();
    });
    commentObserver.observe(scribe.elem, { childList: true });

    return () => {
      document.removeEventListener('mouseup', mouseupHandler);
      closePalette();
      commentObserver.disconnect();
      cmtFollow?.disconnect();
      for (const key of [...shellMorphs.keys()]) cancelShellMorph(key);
      clearCardMorphStyles();
      disarmLive(false);
      syncOpenMarkHook = null;
      for (const prev of hiddenOpenMarks) prev.classList.remove('is-hidden-for-card');
      hiddenOpenMarks.clear();
      for (const b of pairedLitBands) b.classList.remove('scribe-hl-hover');
      pairedLitBands = [];
      document.removeEventListener('keydown', onLiveKeydown, true);
      document.removeEventListener('paste', onLivePaste, true);
      document.removeEventListener('contextmenu', cmtContextDismiss, true);
      scribe.elem.removeEventListener('pointermove', onViewerPointerMove);
      scribe.elem.removeEventListener('pointerleave', onViewerPointerLeave);
      scribe.elem.removeEventListener('click', cmtPress);
      scribe.elem.removeEventListener('keydown', cmtKeyOpen);
      document.removeEventListener('pointerdown', cmtOutsidePress, true);
      document.removeEventListener('wheel', cmtScrollDismiss, true);
      scribe.scrollContainer?.removeEventListener('scroll', cmtScrollDismiss);
      if (cmtMoveRaf !== null) cancelAnimationFrame(cmtMoveRaf);
      if (hoverExitTimer) clearTimeout(hoverExitTimer);
      if (cmtDragEnd) cmtDragEnd();
      surfaceLayer.remove();
      scribe._openNoteCard = null;
      scribe._dismissTransientPopovers = null;
      document.removeEventListener('dblclick', cmtDblclick);
      scribe._openCommentEditor = null;
      scribe._armLiveHighlight = null;
      scribe._openNoteEditor = null;
      scribe._updateCommentIcons = null;
      openCommentEditor = null;
      armLiveHighlight = null;
      dismissLiveHighlight = null;
      if (scribe.useCustomSelection && scribe.textSel) scribe.textSel.cursorOverride = null;
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
    setArmed,
    isArmed: () => highlightMode,
  };
}

// Lines of text with one struck through by a solid redaction bar.
// eslint-disable-next-line max-len
const REDACT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5.5h16M4 18.5h10"/><rect x="4" y="9.2" width="16" height="5.6" rx="1" fill="currentColor" stroke="none"/></svg>';

/**
 * Build the redact tool: a toggle button that marks content for destructive removal at export.
 * While armed, releasing a text selection marks its words; dragging a non-text area (or Alt+drag anywhere) draws a region mark for images and figures.
 * @param {import('../../viewer.js').ScribeViewer} initialViewer
 * @param {HTMLElement} rootElem - The app's root element (for selection scope).
 * @param {object} cfg
 * @param {(marksAdded: number) => void} [cfg.onMark] - Called after each marking gesture.
 * @returns {{ toolbarElem: HTMLSpanElement, installBehaviors: (viewer?: import('../../viewer.js').ScribeViewer) => (() => void) }}
 */
export function createRedactTool(initialViewer, rootElem, { onMark } = {}) {
  let scribe = initialViewer;
  let redactMode = false;
  // The context menu's "Redact" item is gated on the tool being present.
  scribe._redactEnabled = true;

  const toolbarElem = makeIconButton('Redact', REDACT_SVG);
  nameForSelection(toolbarElem, 'Redact', () => scribe);

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
    const { added } = redactWords(scribe, matchedWords.map((kw) => kw.word));
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
   * @param {import('../../viewer.js').ScribeViewer} [viewer] - The viewer to bind, after the caller has torn down the previous binding.
   * @returns {() => void} teardown
   */
  function installBehaviors(viewer = scribe) {
    scribe = viewer;
    scribe._redactEnabled = true;
    updateRedactCursor();
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
      // The Preview tab is a control over the page, so a press on it must not also start a box.
      if (event.target instanceof Element && event.target.closest('.scribe-redact-tab')) return;
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
      if (scribe.scrollContainer) scribe.scrollContainer.style.cursor = '';
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
 * The files among `names` that import together with the PDF named `pdfName`.
 * @param {string} pdfName
 * @param {string[]} names
 * @returns {{ocrFiles: string[], scribeFiles: string[]}} The OCR files, most preferred first, and the `.scribe` sessions.
 */
export function filesNamedForPdf(pdfName, names) {
  const stem = pdfName.replace(/\.pdf$/i, '').toLowerCase();
  /** @type {string[]} */
  const scribeFiles = [];
  /** @type {Array<[number, string]>} */
  const ranked = [];
  if (stem) {
    for (const name of names) {
      const lower = name.toLowerCase();
      if (!lower.startsWith(stem)) continue;
      const rest = lower.slice(stem.length);
      if (/^\.scribe(?:\.json)?$/.test(rest)) scribeFiles.push(name);
      else if (/^\.(?:hocr|xml|html|htm|stext|json)(?:\.gz)?$/.test(rest)) ranked.push([0, name]);
      else if (/^_abbyy\.(?:gz|xml)$/.test(rest)) ranked.push([1, name]);
      else if (/^_hocr\.html?(?:\.gz)?$/.test(rest)) ranked.push([2, name]);
      else if (/^_chocr\.html?(?:\.gz)?$/.test(rest)) ranked.push([3, name]);
    }
  }
  ranked.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
  return { ocrFiles: ranked.map(([, name]) => name), scribeFiles };
}

/**
 * Open a `ScribeDoc` from any supported input.
 * Raw byte inputs (`ArrayBuffer`, `Uint8Array`, non-`File` `Blob`) are treated as PDFs.
 * `File` and path strings are sorted by extension.
 * @param {File | Blob | ArrayBuffer | Uint8Array | string} file
 * @param {Object} [options]
 * @param {File[]} [options.ocrFiles]
 * @param {File[]} [options.scribeFiles]
 * @param {(err: Error & {ocrPages?: number, pageCount?: number}) => void} [options.onOcrFileRejected] - Called with the error when an import that includes OCR files fails.
 *    The document then opens without them.
 * @param {boolean} [options.deferText] - Resolve as soon as the document is renderable, leaving text extraction running behind `doc.textReady` (see `importFiles`).
 *    For open-and-display paths only.
 *    Callers that read the document's text right after opening must leave this unset.
 * @param {Promise<unknown>} [options.textStart] - With `deferText`, extraction begins once this promise settles, so the first screen can render first.
 * @param {boolean} [options.skipFontOpt] - Skip font optimization.
 *    Safe only for callers that read text and never render styled overlays.
 * @param {number} [options.pdfWorkerN]
 * @returns {Promise<import('../../../js/containers/scribeDoc.js').ScribeDoc>}
 */
export async function openDocumentFromFile(file, {
  deferText = false, textStart = undefined, skipFontOpt = false, pdfWorkerN = undefined, ocrFiles = [], scribeFiles = [], onOcrFileRejected = undefined,
} = {}) {
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

  if (Array.isArray(input)) {
    input.push(...ocrFiles, ...scribeFiles);
  } else {
    if (ocrFiles.length) input.ocrFiles = ocrFiles;
    if (scribeFiles.length) input.scribeFiles = scribeFiles;
  }

  let doc;
  try {
    doc = await scribeLib.openDocument(input, (deferText || skipFontOpt || pdfWorkerN) ? {
      deferText, textStart, skipFontOpt, pdfWorkerN,
    } : undefined);
  } catch (err) {
    if (!ocrFiles.length) throw err;
    onOcrFileRejected?.(err instanceof Error ? err : new Error(String(err)));
    return openDocumentFromFile(file, {
      deferText, textStart, skipFontOpt, pdfWorkerN, scribeFiles,
    });
  }

  fallBackToPdfText(doc);
  if (!deferText) await doc.textReady;
  return doc;
}

/**
 * Make the PDF's own parsed text the document's active layer when nothing else has filled it by the time its text is in.
 * Code that awaits `doc.textReady` after this call sees the fallback applied.
 * @param {import('../../../js/containers/scribeDoc.js').ScribeDoc} doc
 */
export function fallBackToPdfText(doc) {
  doc.textReady = doc.textReady.then((res) => {
    if (doc.ocr.pdf && !doc.ocr.active.some(Boolean)) {
      doc.ocr.active = doc.ocr.pdf;
      for (let i = 0; i < doc.ocr.pdf.length; i++) {
        if (doc.ocr.pdf[i] && doc.pageMetrics[i]) doc.pageMetrics[i].angle = doc.ocr.pdf[i].angle;
      }
    }
    return res;
  });
}

const EDIT_TEXT_SVG = modeIcon('<path d="M2.5 4.5h12M2.5 7.5h7M2.5 10.5h4"/><path d="M12.5 7.5l2 2-5 5h-2v-2z"/>');

/**
 * Whether every word of `line` is visible native PDF text that can be edited or deleted in place.
 * @param {import('../../../js/containers/scribeDoc.js').ScribeDoc} doc
 * @param {?import('../../../js/objects/ocrObjects.js').OcrLine} line
 */
export function nativeLineEligible(doc, line) {
  if (!line || line.words.length === 0) return false;
  const nt = nativeTextForPage(doc, line.page);
  return line.words.every((w) => !!nt[w.id] && !nt[w.id].uneditable);
}

/**
 * The drawn box for a native-text line, sized to its visible glyphs.
 * @param {import('../../../js/containers/scribeDoc.js').ScribeDoc} doc
 * @param {import('../../../js/objects/ocrObjects.js').OcrLine} line
 * @param {{left: number, right: number, top: number, bottom: number}} lbox
 */
export function nativeLineDrawBox(doc, line, lbox) {
  const nt = nativeTextForPage(doc, line.page);
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
}

/**
 * The eligible line under a client point, or null when the point is outside its drawn band.
 * @param {import('../../viewer.js').ScribeViewer} scribe
 * @param {number} clientX
 * @param {number} clientY
 * @param {(line: import('../../../js/objects/ocrObjects.js').OcrLine) => boolean} eligible
 */
export function nativeLineHitAt(scribe, clientX, clientY, eligible) {
  if (!scribe.textSel) return null;
  const info = scribe.textSel.lineInfoAt(clientX, clientY, eligible);
  if (!info) return null;
  const p = scribe.clientToPage(clientX, clientY);
  if (p.n !== info.n) return null;
  const local = scribe.pageToLocal(info.n, info.orientation, p.x, p.y);
  const box = nativeLineDrawBox(scribe.doc, info.line, info.lbox);
  const pad = 2;
  if (local.x < box.left - pad || local.x > box.right + pad
    || local.y < box.top - pad || local.y > box.bottom + pad) return null;
  return info;
}

/**
 * Refresh the pages a native-text edit changed.
 * Pages without built text are invalidated rather than re-rendered.
 * They rebuild through the normal lazy path when scrolled to.
 * @param {import('../../viewer.js').ScribeViewer} scribe
 * @param {Array<number>} pages
 * @returns {Promise<void>} Settles once every re-rendered page shows its fresh raster.
 */
export function refreshEditedPages(scribe, pages) {
  /** @type {Array<Promise<void>>} */
  const swaps = [];
  for (const n of new Set(pages)) {
    // A document-wide edit would otherwise raster and rebuild word DOM for hundreds of pages the user never viewed.
    if (!scribe.textGroupsRenderIndices.includes(n)) {
      scribe.doc?.images?.invalidatePageRender(n);
      scribe.imageCache.invalidatePage(n);
      // Nothing re-renders this page now, so a kept canvas would show it as it was before the edit.
      scribe.imageCache.deletePageCanvas(n);
      scribe.textSel?.invalidatePage(n);
      continue;
    }
    swaps.push(scribe.refreshPageRaster(n));
    scribe.renderWords(n);
    scribe.renderHighlights?.(n);
    if (scribe.textSel) {
      scribe.textSel.invalidatePage(n);
      scribe.textSel.renderPage(n);
    }
  }
  if (scribe.onEditCallback) scribe.onEditCallback();
  return Promise.all(swaps).then(() => {});
}

/**
 * Load a provisional document.
 * @param {?Object} doc
 * @returns {Promise<boolean>} Whether the document is loaded, which is false when its load failed or it was closed first.
 */
export const hydrateIfProvisional = async (doc) => {
  // A loaded document passes at once, without waiting on a deferred text import the way `ensureHydrated` does.
  if (!doc || doc.hydrationState === 'hydrated') return true;
  return doc.ensureHydrated();
};

/**
 * The "Edit Text" mode tool.
 * While the mode is active, lines of visible native PDF text are selectable objects that can be edited in place or deleted.
 * @param {import('../../viewer.js').ScribeViewer} initialViewer
 */
export function createEditTextTool(initialViewer) {
  let scribe = initialViewer;
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
  const lineEligible = (line) => nativeLineEligible(scribe.doc, line);

  toolbarElem.addEventListener('click', async () => {
    if (!editMode && !(await hydrateIfProvisional(scribe.doc))) return;
    editMode = !editMode;
    scribe._editTextActive = editMode;
    toolbarElem.classList.toggle('active', editMode);
    if (scribe.textSel) scribe.textSel.cursorOverride = editMode ? 'default' : null;
    if (editMode) {
      scribe.clearTextSelection?.();
      // Nothing is selected yet, so the style controls start dimmed.
      clearBoxSelection();
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
   * @param {import('../../viewer.js').ScribeViewer} [viewer] - The viewer to bind, after the caller has torn down the previous binding.
   * @returns {() => void} teardown
   */
  function installBehaviors(viewer = scribe) {
    scribe = viewer;
    /** @param {Array<number>} pages */
    const refreshPages = (pages) => {
      const swapped = refreshEditedPages(scribe, pages);
      validateSelection();
      renderFrames();
      return swapped;
    };

    /** @type {Set<import('../../../js/objects/ocrObjects.js').OcrLine>} */
    const selected = new Set();
    /** @type {Map<import('../../../js/objects/ocrObjects.js').OcrLine, HTMLDivElement>} */
    const frames = new Map();
    // Assigned once the style controls exist below; the frame renderer calls them on every selection change.
    let syncStyleUi = () => {};
    let hideBar = () => {};

    /**
     * The drawn box for a line, sized to its visible glyphs.
     * @param {import('../../../js/objects/ocrObjects.js').OcrLine} line
     * @param {{left: number, right: number, top: number, bottom: number}} lbox
     */
    const lineDrawBox = (line, lbox) => nativeLineDrawBox(scribe.doc, line, lbox);

    /**
     * The eligible line under the pointer, or null when the pointer is outside its drawn band.
     * @param {number} clientX
     * @param {number} clientY
     */
    const lineHitAt = (clientX, clientY) => nativeLineHitAt(scribe, clientX, clientY, lineEligible);

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
    // Edits and undo replace line objects, and a switch replaces the document, so a selection only ever keeps lines the document on screen has.
    const validateSelection = () => {
      for (const line of [...selected]) {
        if (!line.page || !line.page.lines.includes(line) || scribe.doc?.ocr?.active?.[line.page.n] !== line.page) selected.delete(line);
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
      syncStyleUi();
      if (selected.size === 0 && !editor?.isOpen()) hideBar();
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
    const deleteSelectedLines = async () => {
      const eligible = eligibleSelectedLines();
      if (eligible.length === 0) return false;
      const res = await scribe.doc.deleteTextLines(eligible);
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
      let unknown = false;
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
          const sibling = clearable ? true : pageHasSiblingWithout(scribe, line.page.n, e?.fontObjNum ?? null, prop);
          if (sibling === null) unknown = true;
          else if (sibling) clearable = true;
        }
      }
      if (unknown) Promise.all(lines.map((line) => loadPageFonts(scribe, line.page.n))).then(() => syncStyleUi()).catch(() => {});
      return { present: total > 0, on: total > 0 && onAll, locked: total > 0 && onAll && !clearable && !unknown };
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
          if (res && res.pages) for (const p of res.pages) pages.add(p);
        }
        if (pages.size > 0) {
          refreshPages([...pages]);
          renderFrames();
        }
      })().catch((e) => console.error('Edit Text: style toggle failed:', e));
    };
    let inkCur = '#000000';
    /** @type {Array<string>} Inks applied this session, most recent first. */
    let inksApplied = [];
    // The open line editor owns the target while it is up (its caret's word or selected words); otherwise the selected lines do.
    /** @param {'bold'|'italic'} prop */
    const styleState = (prop) => (editor?.isOpen() ? editor.styleState(prop) : selectionStyleState(prop));
    /** @param {'bold'|'italic'} prop */
    const toggleStyle = (prop) => {
      if (editor?.isOpen()) editor.toggleStyle(prop);
      else toggleSelectionStyle(prop);
      syncStyleUi();
    };
    const colorState = () => {
      if (editor?.isOpen()) return editor.colorState();
      const lines = eligibleSelectedLines();
      const inks = new Set();
      for (const line of lines) for (const w of line.words) inks.add((w.style.color || '#000000').toLowerCase());
      const list = [...inks];
      return { present: lines.length > 0, color: list[0] || null, mixed: list.length > 1 };
    };
    const fontState = () => {
      const fs = editor?.isOpen() ? editor.fontState() : selectedFontState();
      // A page font's name comes from its program, so until that loads the state names the family alone.
      const n = editor?.isOpen() ? editor.pageN() : eligibleSelectedLines()[0]?.page.n;
      if (fs.fontObjNum !== null && typeof n === 'number' && scribe.doc.images.getEditFontSync(n, fs.fontObjNum) === undefined) {
        scribe.doc.images.getEditFont(n, fs.fontObjNum).then(() => syncStyleUi()).catch(() => {});
      }
      return fs;
    };
    const selectedFontState = () => {
      const lines = eligibleSelectedLines();
      const ids = new Set();
      let name = null;
      for (const line of lines) {
        const nt = scribe.doc.nativeText.pages[line.page.n] || {};
        for (const w of line.words) {
          const face = faceIdOf(w.style.font || '');
          const objNum = face ? null : (nt[w.id]?.fontObjNum ?? null);
          ids.add(face || (objNum !== null ? docFontIdOf(objNum) : ''));
          if (face) name = faceNameOf(w.style.font || '');
          else if (objNum !== null) {
            const base = scribe.doc.images.getEditFontSync(line.page.n, objNum)?.program?.baseName;
            name = base ? docFontDisplayName(base) : (w.style.font || '');
          } else name = w.style.font || '';
        }
      }
      const list = [...ids];
      const one = list.length === 1 && list[0] ? list[0] : null;
      return {
        present: lines.length > 0,
        fontId: one,
        family: one && docFontObjNumOf(one) === null ? one : null,
        fontObjNum: one ? docFontObjNumOf(one) : null,
        name: list.length === 1 ? name : null,
        mixed: list.length > 1,
      };
    };
    /**
     * The page's own embedded fonts the target's pages draw with, most used first.
     * @returns {Promise<Array<{ id: string, fontObjNum: number, name: string, raw: string, lines: number, css: ?string }>>}
     */
    const docFonts = async () => {
      const edN = editor?.isOpen() ? editor.pageN() : null;
      const pages = new Set(typeof edN === 'number' ? [edN] : eligibleSelectedLines().map((l) => l.page.n));
      /** @type {Map<number, { lines: Set<import('../../../js/objects/ocrObjects.js').OcrLine>, n: number }>} */
      const used = new Map();
      for (const n of pages) {
        const page = scribe.doc.ocr.active?.[n];
        const nt = scribe.doc.nativeText.pages[n] || {};
        if (!page) continue;
        for (const line of page.lines) {
          for (const w of line.words) {
            if (faceIdOf(w.style.font || '')) continue;
            const fo = nt[w.id]?.fontObjNum;
            if (typeof fo !== 'number' || !Number.isFinite(fo)) continue;
            let e = used.get(fo);
            if (!e) { e = { lines: new Set(), n }; used.set(fo, e); }
            e.lines.add(line);
          }
        }
      }
      /** @type {Array<{ id: string, fontObjNum: number, name: string, raw: string, lines: number, css: ?string }>} */
      const out = [];
      for (const [fo, e] of used) {
        const ef = await scribe.doc.images.getEditFont(e.n, fo).catch(() => null);
        const program = ef?.program;
        if (!program?.font) continue;
        const raw = program.baseName || `font ${fo}`;
        const name = docFontDisplayName(raw);
        const showable = !!ef?.faceName && [...name].every((ch) => ch === ' ' || resolveReplacementChar(ch, program, {}).kind === 'orig');
        out.push({
          id: docFontIdOf(fo), fontObjNum: fo, name, raw, lines: e.lines.size, css: showable && ef?.faceName ? `"${ef.faceName}"` : null,
        });
      }
      out.sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name));
      return out;
    };
    /** @param {string} id */
    const fontStyleOf = (id) => {
      const objNum = docFontObjNumOf(id);
      return objNum !== null ? { fontObjNum: objNum } : { font: id };
    };
    /**
     * @param {import('../../../js/objects/ocrObjects.js').OcrLine} line
     * @param {string} id
     * @param {boolean} tolerant
     * @returns {import('../../../js/pdf/textPatch.js').TextEditRequest}
     */
    const fontRequest = (line, id, tolerant) => {
      const nt = nativeTextForPage(scribe.doc, line.page);
      return {
        kind: 'replace',
        tolerant,
        words: line.words.map((w) => ({
          id: w.id, text: w.text, penX: nt[w.id]?.penX || [], baselineY: nt[w.id]?.baselineY,
        })),
        newTexts: line.words.map((w) => w.text),
        styles: line.words.map(() => fontStyleOf(id)),
      };
    };
    /**
     * @returns {Promise<Record<string, {fits: boolean, reason?: string}>>}
     */
    const fontFits = async () => {
      const ids = [...FACE_FAMILIES.map((f) => f.id), ...(await docFonts()).map((d) => d.id)];
      if (editor?.isOpen()) return editor.fontFits(ids);
      const targets = orderedSelection();
      /** @type {Record<string, {fits: boolean, reason?: string}>} */
      const out = {};
      await Promise.all(ids.map(async (id) => {
        for (const { line, n } of targets) {
          const res = await scribe.doc.images.previewTextEdit(n, fontRequest(line, id, false)).catch((e) => ({ refused: String(e?.message || e) }));
          if (res && res.refused) { out[id] = { fits: false, reason: res.refused }; return; }
        }
        out[id] = { fits: true };
      }));
      return out;
    };
    /** @type {?HTMLDivElement} */
    let refusedElem = null;
    let refusedTimer = 0;
    /**
     * @param {import('../../../js/objects/ocrObjects.js').OcrLine} line
     * @param {string} reason
     */
    const showRefusal = (line, reason) => {
      refusedElem?.remove();
      refusedElem = null;
      if (refusedTimer) clearTimeout(refusedTimer);
      const found = entryFor(line);
      const group = found ? scribe.getTextGroup(found.n, 0) : null;
      if (!found || !group) return;
      const lb = lineDrawBox(line, found.e.lbox);
      const el = document.createElement('div');
      el.className = 'scribe-edit-text-refused';
      el.textContent = reason;
      el.style.left = `${lb.left}px`;
      el.style.top = `${lb.bottom + 4}px`;
      group.appendChild(el);
      refusedElem = el;
      refusedTimer = window.setTimeout(() => { el.remove(); if (refusedElem === el) refusedElem = null; }, 2600);
    };
    /** @type {Array<HTMLCanvasElement>} */
    const fontPreviewEls = [];
    let fontPreviewSeq = 0;
    const clearFontPreview = () => {
      fontPreviewSeq += 1;
      for (const el of fontPreviewEls) el.remove();
      fontPreviewEls.length = 0;
    };
    /**
     * @param {?string} id
     */
    const previewFont = (id) => {
      if (editor?.isOpen()) { editor.previewFont(id); return; }
      clearFontPreview();
      if (!id) return;
      const seq = fontPreviewSeq;
      (async () => {
        for (const { line, n, e } of orderedSelection()) {
          if (e.orientation) continue;
          const res = await scribe.doc.images.previewTextEdit(n, fontRequest(line, id, true)).catch(() => null);
          if (seq !== fontPreviewSeq) return;
          const group = scribe.getTextGroup(n, 0);
          if (!res || !res.words || !group) continue;
          const glyphs = res.words.flatMap((w) => w.glyphs);
          if (glyphs.length === 0) continue;
          /** @type {Map<number|undefined, ?{program: ?import('../../../js/pdf/glyphResolve.js').EditFontProgram, faceName: ?string}>} */
          const editFonts = new Map();
          for (const g of glyphs) {
            const f = g.face ? undefined : (g.fontObjNum ?? undefined);
            if (f === undefined || editFonts.has(f)) continue;
            editFonts.set(f, (await scribe.doc.images.getEditFont(n, f)) || null);
          }
          if (seq !== fontPreviewSeq) return;
          const lb = lineDrawBox(line, e.lbox);
          const pad = 2;
          let left = lb.left - pad;
          let right = lb.right + pad;
          let top = lb.top - pad;
          let bottom = lb.bottom + pad;
          for (const g of glyphs) {
            left = Math.min(left, g.penX - pad);
            right = Math.max(right, g.penX + g.widthPx + pad);
            top = Math.min(top, g.penY - 1.1 * g.sizePx);
            bottom = Math.max(bottom, g.penY + 0.4 * g.sizePx);
          }
          const zoom = parseFloat(getComputedStyle(group).getPropertyValue('--scribe-zoom')) || scribe.zoomLevel || 1;
          const k = (window.devicePixelRatio || 1) * zoom;
          const cv = document.createElement('canvas');
          cv.width = Math.max(1, Math.ceil((right - left) * k));
          cv.height = Math.max(1, Math.ceil((bottom - top) * k));
          cv.className = 'scribe-edit-text-fontpreview';
          Object.assign(cv.style, {
            position: 'absolute', left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px`, pointerEvents: 'none',
          });
          const cx = cv.getContext('2d');
          if (!cx) continue;
          cx.scale(k, k);
          cx.translate(-left, -top);
          cx.fillStyle = '#ffffff';
          cx.fillRect(lb.left - pad, lb.top - pad, lb.right - lb.left + 2 * pad, lb.bottom - lb.top + 2 * pad);
          cx.textBaseline = 'alphabetic';
          for (const g of glyphs) {
            let drawn = g.text;
            if (g.face) {
              const raw = GlobalFonts.raw?.[g.face.family]?.[g.face.styleKey] || GlobalFonts.raw?.[g.face.family]?.normal;
              if (!raw?.fontFaceName) continue;
              cx.font = `${raw.fontFaceStyle || 'normal'} ${raw.fontFaceWeight || 'normal'} ${g.sizePx}px "${raw.fontFaceName}"`;
            } else {
              const ef = editFonts.get(g.fontObjNum ?? undefined);
              if (!ef?.faceName || !ef.program) continue;
              // Some fonts map their visible hyphen glyph to a soft hyphen (U+00AD), which a canvas draws as nothing.
              drawn = g.text.replace(/\u00ad/g, '-');
              const program = ef.program;
              if ([...drawn].some((ch) => resolveReplacementChar(ch, program, {}).kind !== 'orig')) continue;
              cx.font = `${g.sizePx}px "${ef.faceName}"`;
            }
            cx.fillStyle = g.fillColor;
            cx.fillText(drawn, g.penX, g.penY);
          }
          group.appendChild(cv);
          fontPreviewEls.push(cv);
        }
      })().catch((err) => console.error('Edit Text: font preview failed:', err));
    };
    /**
     * @param {string} id
     */
    const setFont = (id) => {
      if (editor?.isOpen()) {
        editor.setFont(id);
        syncStyleUi();
        return;
      }
      const lines = eligibleSelectedLines();
      clearFontPreview();
      if (lines.length === 0) {
        syncStyleUi();
        return;
      }
      (async () => {
        const pages = new Set();
        for (const line of lines) {
          const res = await scribe.doc.replaceTextLine(line, line.words.map((w) => w.text).join(' '), { wordStyles: line.words.map(() => fontStyleOf(id)) });
          if (res && 'refused' in res && res.refused) showRefusal(line, res.refused);
          else if (res && res.pages) for (const p of res.pages) pages.add(p);
        }
        if (pages.size > 0) {
          refreshPages([...pages]);
          renderFrames();
        }
        syncStyleUi();
      })().catch((err) => console.error('Edit Text: font change failed:', err));
    };
    /** @type {Array<HTMLCanvasElement>} */
    const previewEls = [];
    // Bumped by every preview change, so a commit only lifts the preview it drew itself.
    let previewSeq = 0;
    const clearPreview = () => {
      for (const el of previewEls) el.remove();
      previewEls.length = 0;
    };
    /**
     * Draw the target in `hex` without committing, or lift the preview when `hex` is null.
     * Each word's raster pixels are re-inked by their darkness and laid over the word.
     * This only has to look right on paper, because the commit re-renders exactly.
     * @param {?string} hex
     */
    const previewColor = (hex) => {
      previewSeq += 1;
      if (editor?.isOpen()) { editor.previewColor(hex); return; }
      clearPreview();
      if (!hex) return;
      const ir = parseInt(hex.slice(1, 3), 16);
      const ig = parseInt(hex.slice(3, 5), 16);
      const ib = parseInt(hex.slice(5, 7), 16);
      for (const { line, n, e } of orderedSelection()) {
        // A rotated group's boxes are not axis-aligned on screen; those lines wait for the commit.
        if (e.orientation) continue;
        const frame = frames.get(line);
        const group = scribe.getTextGroup(n, 0);
        const canvas = scribe.pageContainerArr?.[n]?.querySelector('canvas.scribe-layer-image');
        if (!frame || !group || !(canvas instanceof HTMLCanvasElement) || !canvas.width) continue;
        const fr = frame.getBoundingClientRect();
        const cr = canvas.getBoundingClientRect();
        if (!fr.width || !cr.width) continue;
        const pad = 2;
        const lb = lineDrawBox(line, e.lbox);
        // The frame is the line's local box drawn on screen, so it gives the local-to-client mapping without the group's transform.
        const sx = fr.width / (lb.right - lb.left + 2 * pad);
        const sy = fr.height / (lb.bottom - lb.top + 2 * pad);
        const ox = fr.left - (lb.left - pad) * sx;
        const oy = fr.top - (lb.top - pad) * sy;
        const kx = canvas.width / cr.width;
        const ky = canvas.height / cr.height;
        const src = canvas.getContext('2d');
        if (!src) continue;
        for (const w of line.words) {
          const a = scribe.pageToLocal(n, 0, w.bbox.left, w.bbox.top);
          const b = scribe.pageToLocal(n, 0, w.bbox.right, w.bbox.bottom);
          const l = Math.min(a.x, b.x) - 1;
          const t = Math.min(a.y, b.y) - 1;
          const r = Math.max(a.x, b.x) + 1;
          const bt = Math.max(a.y, b.y) + 1;
          const px0 = Math.max(0, Math.floor((ox + l * sx - cr.left) * kx));
          const py0 = Math.max(0, Math.floor((oy + t * sy - cr.top) * ky));
          const px1 = Math.min(canvas.width, Math.ceil((ox + r * sx - cr.left) * kx));
          const py1 = Math.min(canvas.height, Math.ceil((oy + bt * sy - cr.top) * ky));
          const cw = px1 - px0;
          const ch = py1 - py0;
          if (cw <= 0 || ch <= 0) continue;
          let img;
          try { img = src.getImageData(px0, py0, cw, ch); } catch { continue; }
          const d = img.data;
          for (let i = 0; i < d.length; i += 4) {
            // Darkness is the ink's coverage; the paper stays transparent, so the selection's wash shows through.
            const k = 1 - (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
            d[i] = ir;
            d[i + 1] = ig;
            d[i + 2] = ib;
            d[i + 3] = Math.round(255 * k);
          }
          const el = document.createElement('canvas');
          el.width = cw;
          el.height = ch;
          el.getContext('2d')?.putImageData(img, 0, 0);
          el.className = 'scribe-edit-text-inkpreview';
          Object.assign(el.style, {
            position: 'absolute', left: `${l}px`, top: `${t}px`, width: `${r - l}px`, height: `${bt - t}px`, pointerEvents: 'none',
          });
          group.appendChild(el);
          previewEls.push(el);
        }
      }
    };
    /** @param {string} hex */
    const setColor = (hex) => {
      const ink = hex.toLowerCase();
      inkCur = ink;
      inksApplied = [ink, ...inksApplied.filter((h) => h !== ink)];
      if (editor?.isOpen()) {
        clearPreview();
        editor.setColor(ink);
        syncStyleUi();
        return;
      }
      const lines = eligibleSelectedLines();
      if (lines.length === 0) {
        clearPreview();
        syncStyleUi();
        return;
      }
      // A keyboard pick never previewed, so the preview is redrawn in the picked ink.
      // It covers the words until the fresh raster is on screen, so the old ink never shows in between.
      previewColor(ink);
      const seq = previewSeq;
      (async () => {
        const pages = new Set();
        for (const line of lines) {
          const res = await scribe.doc.replaceTextLine(
            line,
            line.words.map((w) => w.text).join(' '),
            { wordStyles: line.words.map(() => ({ color: ink })) },
          );
          if (res && res.pages) for (const p of res.pages) pages.add(p);
        }
        let swapped = Promise.resolve();
        if (pages.size > 0) {
          swapped = refreshPages([...pages]);
          renderFrames();
        }
        syncStyleUi();
        await swapped;
        if (previewSeq === seq) clearPreview();
      })().catch((e) => {
        if (previewSeq === seq) clearPreview();
        console.error('Edit Text: text color failed:', e);
      });
    };

    // The page sampler: a loupe over the page canvas whose center pixel a press commits.
    /** @type {?{onPick: (hex: string) => void, onMove?: (hex: string) => void, onCancel?: () => void, hex: ?string}} */
    let sampling = null;
    const loupe = document.createElement('div');
    loupe.className = 'scribe-edit-text-loupe';
    const loupeCv = document.createElement('canvas');
    loupeCv.width = 13;
    loupeCv.height = 13;
    loupe.appendChild(loupeCv);
    const loupeLbl = document.createElement('span');
    loupeLbl.className = 'scribe-edit-text-loupe-lbl';
    loupeLbl.innerHTML = '<i></i><span></span>';
    // On the viewer root, beside the scroll container, like Fill & Sign's palette: a press on these never reaches the selection engine or this mode's own press handler.
    scribe.elem.append(loupe, loupeLbl);
    const stopSampling = () => {
      sampling = null;
      scribe.scrollContainer.classList.remove('scribe-edit-text-sampling');
      scribe.scrollContainer.style.touchAction = '';
      loupe.style.display = 'none';
      loupeLbl.style.display = 'none';
    };
    /**
     * @param {number} clientX
     * @param {number} clientY
     * @param {boolean} touch - The loupe floats above a finger, which hides the point.
     */
    const sampleAt = (clientX, clientY, touch) => {
      if (!sampling) return null;
      const p = scribe.clientToPage(clientX, clientY);
      const canvas = p.n >= 0 ? scribe.pageContainerArr?.[p.n]?.querySelector('canvas.scribe-layer-image') : null;
      if (!(canvas instanceof HTMLCanvasElement) || !canvas.width) {
        loupe.style.display = 'none';
        loupeLbl.style.display = 'none';
        return null;
      }
      const cr = canvas.getBoundingClientRect();
      // A canvas pixel k spans [k, k + 1) on screen, so the point's pixel is the floor, not the nearest edge.
      const px = Math.min(canvas.width - 1, Math.max(0, Math.floor(((clientX - cr.left) / cr.width) * canvas.width)));
      const py = Math.min(canvas.height - 1, Math.max(0, Math.floor(((clientY - cr.top) / cr.height) * canvas.height)));
      const src = canvas.getContext('2d');
      if (!src) return null;
      let hex;
      try {
        const win = src.getImageData(px - 6, py - 6, 13, 13);
        loupeCv.getContext('2d')?.putImageData(win, 0, 0);
        const c = win.data;
        const i = (6 * 13 + 6) * 4;
        hex = `#${[c[i], c[i + 1], c[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      } catch { return null; }
      const ly = touch ? clientY - 78 : clientY;
      loupe.style.left = `${clientX}px`;
      loupe.style.top = `${ly}px`;
      loupe.style.setProperty('--c', hex);
      loupe.style.display = 'block';
      loupeLbl.style.left = `${clientX}px`;
      loupeLbl.style.top = `${ly}px`;
      loupeLbl.style.setProperty('--c', hex);
      loupeLbl.style.display = 'inline-flex';
      const lblText = loupeLbl.querySelector('span');
      if (lblText) lblText.textContent = hex.toUpperCase();
      sampling.hex = hex;
      sampling.onMove?.(hex);
      return hex;
    };
    /**
     * @param {(hex: string) => void} onPick
     * @param {{onMove?: (hex: string) => void, onCancel?: () => void}} [o]
     */
    const startSampling = (onPick, o = {}) => {
      sampling = {
        onPick, onMove: o.onMove, onCancel: o.onCancel, hex: null,
      };
      scribe.scrollContainer.classList.add('scribe-edit-text-sampling');
      // A finger drag aims the loupe; native panning would take it away.
      scribe.scrollContainer.style.touchAction = 'none';
    };
    const cancelSampling = () => {
      const sm = sampling;
      stopSampling();
      sm?.onCancel?.();
    };
    const samplerMove = (ev) => { if (sampling) sampleAt(ev.clientX, ev.clientY, ev.pointerType === 'touch'); };
    const samplerDown = (ev) => {
      if (!sampling) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.button === 2) { cancelSampling(); return; }
      sampleAt(ev.clientX, ev.clientY, ev.pointerType === 'touch');
    };
    const samplerUp = (ev) => {
      if (!sampling) return;
      ev.preventDefault();
      ev.stopPropagation();
      // The release commits what the loupe shows, the last sample, as Chrome's eyedropper does; off the page it cancels.
      const hex = sampleAt(ev.clientX, ev.clientY, ev.pointerType === 'touch');
      const sm = sampling;
      stopSampling();
      if (hex) sm.onPick(hex);
      else sm.onCancel?.();
    };
    const samplerContext = (ev) => {
      if (!sampling) return;
      ev.preventDefault();
      ev.stopPropagation();
      cancelSampling();
    };
    document.addEventListener('pointermove', samplerMove, true);
    document.addEventListener('pointerdown', samplerDown, true);
    document.addEventListener('pointerup', samplerUp, true);
    document.addEventListener('contextmenu', samplerContext, true);

    const bannerCluster = createStyleCluster(scribe, { align: 'right' });
    const bannerTools = document.createElement('span');
    bannerTools.className = 'scribe-mode-banner-tools scribe-edit-text-tools';
    bannerTools.appendChild(bannerCluster.el);
    scribe._editTextBannerTools = bannerTools;
    const bar = document.createElement('div');
    bar.className = 'scribe-edit-text-bar scribe-edit-text-tools';
    const barCluster = createStyleCluster(scribe, { align: 'left' });
    bar.appendChild(barCluster.el);
    scribe.elem.appendChild(bar);
    let barOn = false;
    let barDocked = false;
    let barHideT = 0;
    syncStyleUi = () => {
      bannerCluster.sync();
      barCluster.sync();
    };
    hideBar = () => {
      if (!barOn) return;
      barOn = false;
      barDocked = false;
      barCluster.closePop();
      bar.classList.remove('shown', 'docked');
      clearTimeout(barHideT);
      barHideT = window.setTimeout(() => bar.classList.remove('on'), 130);
    };
    /**
     * Above the anchor, starting at `left`; below it when there is no room above.
     * @param {{left: number, top: number, right: number, bottom: number}} anchor
     * @param {number} left
     */
    const placeBar = (anchor, left) => {
      clearTimeout(barHideT);
      barOn = true;
      bar.classList.add('on');
      bar.classList.toggle('docked', barDocked);
      barCluster.closePop();
      barCluster.sync();
      const bw = bar.offsetWidth;
      const bh = bar.offsetHeight;
      const sc = scribe.scrollContainer.getBoundingClientRect();
      const x = Math.max(sc.left + 4, Math.min(left, sc.right - bw - 4));
      let y = anchor.top - bh - 6;
      if (y < sc.top + 4) y = anchor.bottom + 6;
      bar.style.left = `${x}px`;
      bar.style.top = `${y}px`;
      requestAnimationFrame(() => { if (barOn) bar.classList.add('shown'); });
    };
    /**
     * @param {number} clientX - The pointer, where the bar starts.
     */
    const showBarAt = (clientX) => {
      if (scribe._phoneUi) return;
      let anchor = null;
      if (editor?.isOpen()) {
        anchor = editor.bandClientRect();
      } else {
        const first = orderedSelection()[0];
        const fr = first ? frames.get(first.line) : null;
        if (fr && fr.isConnected) anchor = fr.getBoundingClientRect();
      }
      if (!anchor) return;
      barDocked = false;
      placeBar(anchor, clientX - 8);
    };
    scribe._editTextMenuShown = (menuRect) => {
      if (scribe._phoneUi || editor?.isOpen() || eligibleSelectedLines().length === 0) return;
      barDocked = true;
      placeBar({
        left: menuRect.left, top: menuRect.top, right: menuRect.right, bottom: menuRect.bottom,
      }, menuRect.left);
    };
    scribe._editTextMenuHidden = () => { if (barDocked) hideBar(); };
    scribe._editTextMenuHolds = (target) => barOn && barDocked && (!!sampling || (target instanceof Node && bar.contains(target)));
    // The bar stays put until a press lands outside it (or Esc, typing, or the selection going away).
    const barDownHandler = (ev) => {
      if (!barOn || barDocked || sampling) return;
      if (ev.target instanceof Node && bar.contains(ev.target)) return;
      hideBar();
    };
    document.addEventListener('pointerdown', barDownHandler, true);

    scribe._editTextStyleState = styleState;
    scribe._editTextToggleStyle = toggleStyle;
    scribe._editTextColorState = colorState;
    scribe._editTextSetColor = setColor;
    scribe._editTextPreviewColor = previewColor;
    scribe._editTextSample = startSampling;
    scribe._editTextInkState = () => ({ cur: inkCur, applied: inksApplied });
    scribe._editTextFontState = fontState;
    scribe._editTextSetFont = setFont;
    scribe._editTextPreviewFont = previewFont;
    scribe._editTextFontFits = fontFits;
    scribe._editTextDocFonts = docFonts;

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
      onOpenChanged: (open) => {
        if (open) hideBar();
        clearPreview();
        clearFontPreview();
        syncStyleUi();
        scribe._editTextEditorOpenChanged?.(open);
      },
      // A drag across words summons the bar; keyboard selections never do.
      onRangeSelected: (x) => showBarAt(x),
      onCaretChanged: () => syncStyleUi(),
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
        boxShadow: 'var(--scribe-menu-shadow, 0 1px 2px rgba(20, 30, 60, .10), 0 5px 14px rgba(20, 30, 60, .12))',
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
      if (t instanceof Element && t.closest('.scribe-hl-cmark, .scribe-note-icon, .scribe-cmt-card, .scribe-redact-tab, [contenteditable]')) return;
      // The sampler owns the press: its own capture handlers pick or cancel.
      if (sampling) return;
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
          if (selected.size > 0) showBarAt(uv.clientX);
          return;
        }
        // If an editor was open, its own click-away hook has already committed.
        if (!info) {
          clearSelection();
          // The engine never sees a press in this mode, so a selection it is somehow holding is cleared here on its behalf.
          scribe.clearTextSelection();
          return;
        }
        if (shift) {
          if (selected.has(info.line)) selected.delete(info.line);
          else selected.add(info.line);
          renderFrames();
          if (selected.size > 0) showBarAt(uv.clientX);
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
        showBarAt(uv.clientX);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };

    const keydownHandler = (ev) => {
      if (!editMode) return;
      if (ev.key === 'Escape') {
        if (sampling) {
          ev.preventDefault();
          ev.stopPropagation();
          cancelSampling();
          return;
        }
        if (bannerCluster.escape() || barCluster.escape()) {
          ev.preventDefault();
          ev.stopPropagation();
          return;
        }
        if (barOn) {
          ev.preventDefault();
          ev.stopPropagation();
          hideBar();
          return;
        }
      } else if (barOn && !ev.ctrlKey && !ev.metaKey && !ev.altKey
        && (ev.key.length === 1 || ev.key === 'Backspace' || ev.key === 'Delete' || ev.key === 'Enter')
        && !(ev.target instanceof Element && ev.target.closest('.scribe-edit-text-tools'))) {
        // The key itself is not consumed, so it still lands on whoever owns it.
        hideBar();
      }
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
        if (selected.size === 0) {
          if (scribe.getWordsUnderTextSelection().length > 0) {
            ev.preventDefault();
            ev.stopPropagation();
            scribe.clearTextSelection();
          }
          return;
        }
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
      // A focused style control owns the keys below.
      // Enter and Space pick a swatch or apply the picker, and Delete must never reach the page from inside a picker.
      if (t instanceof Element && t.closest('.scribe-edit-text-tools')) return;
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
      hideBar();
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
      hideBar();
      bar.remove();
      stopSampling();
      loupe.remove();
      loupeLbl.remove();
      clearPreview();
      bannerTools.remove();
      bannerCluster.destroy();
      barCluster.destroy();
      document.removeEventListener('pointermove', samplerMove, true);
      document.removeEventListener('pointerdown', samplerDown, true);
      document.removeEventListener('pointerup', samplerUp, true);
      document.removeEventListener('contextmenu', samplerContext, true);
      document.removeEventListener('pointerdown', barDownHandler, true);
      scribe._editTextBannerTools = null;
      scribe._editTextColorState = null;
      scribe._editTextSetColor = null;
      scribe._editTextPreviewColor = null;
      scribe._editTextSample = null;
      scribe._editTextInkState = null;
      scribe._editTextFontState = null;
      scribe._editTextSetFont = null;
      scribe._editTextPreviewFont = null;
      scribe._editTextFontFits = null;
      scribe._editTextDocFonts = null;
      scribe._editTextMenuShown = null;
      scribe._editTextMenuHidden = null;
      scribe._editTextMenuHolds = null;
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

  /**
   * Commit any open line edit and clear the selection when the bound viewer shows another document.
   * @param {import('../../viewer.js').ScribeViewer} viewer
   */
  const docChanged = (viewer) => {
    if (viewer !== scribe || !editMode) return;
    // The commit lands in the document the edit was typed in.
    if (editor?.isOpen()) editor.commit().catch((e) => console.error('Edit Text: commit failed:', e));
    clearBoxSelection();
  };

  return { toolbarElem, installBehaviors, docChanged };
}

const IMAGE_EDIT_SVG = modeIcon('<rect x="2.5" y="3.5" width="12" height="10" rx="1"/><circle cx="5.5" cy="6.5" r="1"/><path d="M2.5 12.5l3-3 2 2 3-3 4 4"/>');

/**
 * Toolbar control that toggles the Edit Graphics mode for selecting and deleting a page's image and path placements.
 * @param {import('../../viewer.js').ScribeViewer} initialViewer
 */
export function createGraphicsEditTool(initialViewer) {
  let scribe = initialViewer;
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
    const dims = scribe.doc?.pageMetrics?.[n]?.dims;
    if (!dims) return [];
    const records = scribe.doc.contentEdits.pages[n] || [];
    const pad = 2;
    const areaCap = dims.width * dims.height * 0.95;
    const pending = (/** @type {string} */ type, /** @type {{left: number, top: number, right: number, bottom: number}} */ e) => records.some((r) => r.type === type
      && Math.abs(e.left - r.rect.left) <= pad && Math.abs(e.top - r.rect.top) <= pad
      && Math.abs(e.right - r.rect.right) <= pad && Math.abs(e.bottom - r.rect.bottom) <= pad);
    /** @type {Array<{kind: 'image'|'path', e: {left: number, top: number, right: number, bottom: number}}>} */
    const out = [];
    // A placement covering nearly the whole page is the scan or the page background, so deleting it would blank the page.
    for (const e of pageImagePlacements(scribe.doc, n)) {
      if ((e.right - e.left) * (e.bottom - e.top) < areaCap && !pending('deleteImage', e)) out.push({ kind: 'image', e });
    }
    for (const e of pagePathPlacements(scribe.doc, n)) {
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
    const dims = scribe.doc?.pageMetrics?.[pt.n]?.dims;
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

  toolbarElem.addEventListener('click', async () => {
    if (!graphicsMode && !(await hydrateIfProvisional(scribe.doc))) return;
    graphicsMode = !graphicsMode;
    scribe._graphicsEditActive = graphicsMode;
    toolbarElem.classList.toggle('active', graphicsMode);
    // A selection carried in from the viewer would stay painted over the placements.
    if (graphicsMode) scribe.clearTextSelection();
    if (scribe.textSel) scribe.textSel.cursorOverride = graphicsMode ? 'default' : null;
    if (!graphicsMode) {
      resetSelection();
      hideTouchCallout();
    }
  });

  /**
   * Wire the mode's pointer and keyboard behaviors.
   * Call after `scribe.init` (needs the scroll container).
   * @param {import('../../viewer.js').ScribeViewer} [viewer] - The viewer to bind, after the caller has torn down the previous binding.
   * @returns {() => void} teardown
   */
  function installBehaviors(viewer = scribe) {
    scribe = viewer;
    /** @param {Array<number>} pages */
    const refreshPages = (pages) => {
      for (const n of new Set(pages)) scribe.refreshPageRaster(n);
      if (scribe.onEditCallback) scribe.onEditCallback();
      validateSelection();
      renderFrames();
    };
    const deleteSelected = () => {
      validateSelection();
      if (selected.size === 0) return false;
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
      if (!res) return false;
      refreshPages(res.pages);
      return true;
    };
    const selectionAnchor = () => {
      let anchor = null;
      for (const [entry, sel] of selected) {
        const cont = scribe.pageContainerArr?.[sel.n];
        const dims = scribe.doc?.pageMetrics?.[sel.n]?.dims;
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
        const dims = scribe.doc?.pageMetrics?.[n]?.dims;
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
      // A selection left by another document is no selection, so it does not take Escape.
      validateSelection();
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
      validateSelection();
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
      if (scribe.textSel) scribe.textSel.cursorOverride = null;
      resetSelection();
      hideTouchCallout();
    };
  }

  /**
   * Drop any selected placement of a document the bound viewer no longer shows.
   * @param {import('../../viewer.js').ScribeViewer} viewer
   */
  const docChanged = (viewer) => {
    if (viewer !== scribe || !graphicsMode) return;
    validateSelection();
    renderFrames();
  };

  return { toolbarElem, installBehaviors, docChanged };
}

const FILL_SIGN_SVG = modeIcon('<path d="M2.5 12C4.3 8.1 5.7 6.4 6.4 7.1S4.8 11.9 5.7 12.4C6.5 12.9 7.8 10.6 8.5 10.8C9.2 11 8.7 12.4 9.6 12.4C10.3 12.4 10.9 11.7 11.7 11.7"/>'
  + '<path d="M2.5 14.5h12"/>');

/**
 * Toolbar control that toggles the Fill & Sign palette for placing checks, crosses, and signatures.
 * @param {import('../../basic-viewer/pdf-viewer.js').ScribePDFViewer} app
 * @returns {{ toolbarElem: HTMLElement, installBehaviors: () => (() => void), isOpen: () => boolean, close: () => void, paletteElem: () => ?HTMLElement }}
 */
export function createFillSignTool(app) {
  const toolbarElem = makeIconButton('Fill & Sign', FILL_SIGN_SVG);
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
      // The palette places onto the viewer it was built for.
      if (palette && palette.viewer !== app._activeViewer()) {
        palette.destroy();
        palette = null;
      }
      if (!palette) {
        palette = createFillSignPalette(app);
        app.pdfViewerElem.appendChild(palette.elem);
      }
      palette.show();
      // The palette's offered spots come from the document's text and shapes, which a provisional document has not loaded.
      hydrateIfProvisional(app._activeViewer().doc);
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
    app._activeThumbnails()?.setPageEditMode(active);
    if (active) app._showActiveSidebar('thumbnails');
    // A page edit waits for a provisional document to load, so the load starts here, ahead of the first edit.
    if (active) hydrateIfProvisional(app._activeViewer().doc);
  };
  toolbarElem.addEventListener('click', () => {
    if (toolbarElem.classList.contains('disabled')) return;
    setActive(!active);
  });
  return { toolbarElem, isActive: () => active, close: () => setActive(false) };
}

const EXTRACT_TABLES_MODE_SVG = modeIcon('<rect x="2.5" y="2.5" width="12" height="12" rx="1"/><path d="M2.5 6.5h12M2.5 10.5h12M6.5 6.5v8"/>');

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
  let view = 'page';
  /** @type {?string} */
  let priorDisplayMode = null;
  // The mode's viewer is fixed at entry, since a press into the other group during Side by side makes that group active without ending the mode.
  let modeViewer = null;
  const viewerOf = () => modeViewer || app._activeViewer();

  let armed = false;
  let priorCanvasSelection = false;
  /** @type {?Set<string>} */
  let beforeIds = null;
  const hintText = () => (armed ? 'Drag a box around the table \u00b7 Esc cancels' : null);
  const armPointerDown = () => { beforeIds = new Set(viewerOf().doc.layoutDataTables.pages.flatMap((p) => (p?.tables || []).map((t) => t.id))); };
  const armPointerUp = () => {
    const sv = viewerOf();
    const before = beforeIds;
    beforeIds = null;
    const added = before ? sv.doc.layoutDataTables.pages.flatMap((p) => (p?.tables || []).filter((t) => !before.has(t.id)).map((t) => ({ table: t, n: p.n }))) : [];
    // The viewer's release handler resets the mode after every press, so a click that drew nothing has to re-arm it.
    if (added.length === 0) { sv.mode = 'addLayoutBoxDataTable'; return; }
    disarm();
    setActiveTable(sv, added[0].table.id);
    // Refreshed again so the list selects the table just made active.
    sv.layoutTablesEdited(added[0].n);
    pulseTable(sv, added[0].table);
  };
  const disarm = () => {
    if (!armed) return;
    armed = false;
    const sv = viewerOf();
    sv.mode = 'select';
    sv.enableCanvasSelection = priorCanvasSelection;
    sv.elem.classList.remove('scribe-xt-armed');
    sv.scrollContainer.removeEventListener('pointerdown', armPointerDown);
    sv.scrollContainer.removeEventListener('pointerup', armPointerUp);
    beforeIds = null;
    app._setToolHint?.(tool);
  };
  const armAddTable = () => {
    const sv = viewerOf();
    if (!sv.doc || !active) return;
    if (view === 'preview') setView('page');
    if (armed) return;
    armed = true;
    priorCanvasSelection = sv.enableCanvasSelection;
    sv.enableCanvasSelection = true;
    sv.mode = 'addLayoutBoxDataTable';
    sv.CanvasSelection.deselectAll();
    sv.elem.classList.add('scribe-xt-armed');
    // Registered after the viewer's own handlers on the same element, so the release runs once the table exists and the mode has been reset.
    sv.scrollContainer.addEventListener('pointerdown', armPointerDown);
    sv.scrollContainer.addEventListener('pointerup', armPointerUp);
    app._setToolHint?.(tool);
  };

  // The Page, Preview Export and Side by side view switch, mounted into the mode banner while this mode is active.
  const viewSeg = document.createElement('span');
  viewSeg.className = 'scribe-mode-banner-viewseg';
  Object.assign(viewSeg.style, {
    display: 'inline-flex', border: '1px solid var(--scribe-line-strong)', borderRadius: '6px', overflow: 'hidden', margin: '0 2px 0 10px', flex: 'none',
  });
  const segBtn = (label, key) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.tableView = key;
    b.textContent = label;
    Object.assign(b.style, {
      border: 'none',
      background: 'var(--scribe-surface)',
      color: 'var(--scribe-ink-2)',
      fontFamily: 'inherit',
      fontSize: '11px',
      fontWeight: '600',
      lineHeight: '1',
      padding: '4.5px 10px',
      cursor: 'pointer',
    });
    viewSeg.appendChild(b);
    return b;
  };
  const pageBtn = segBtn('Page', 'page');
  const previewBtn = segBtn('Preview Export', 'preview');
  previewBtn.style.borderLeft = '1px solid var(--scribe-line-strong)';
  const besideBtn = segBtn('Side by side', 'beside');
  besideBtn.style.borderLeft = '1px solid var(--scribe-line-strong)';
  const syncSeg = () => {
    const canBeside = !!modeViewer && modeViewer === app.scribe;
    besideBtn.disabled = !canBeside;
    besideBtn.title = canBeside ? '' : 'Side by side works from the left half';
    [pageBtn, previewBtn, besideBtn].forEach((b) => {
      const on = b.dataset.tableView === view;
      b.style.background = on ? 'var(--scribe-accent)' : 'var(--scribe-surface)';
      b.style.color = on ? 'var(--scribe-accent-ink)' : (b.disabled ? 'var(--scribe-ink-3)' : 'var(--scribe-ink-2)');
      b.style.cursor = on || b.disabled ? 'default' : 'pointer';
    });
  };
  // This must beat the mode-exit handler that also listens on document, so it registers in the capture phase and marks the press handled.
  // A single selected column falls through deliberately, so Escape still exits the mode.
  const pageEscKey = (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    const t = /** @type {?HTMLElement} */ (e.target);
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const sv = viewerOf();
    if (armed) {
      e.preventDefault();
      disarm();
      return;
    }
    if (sv.state.tablePreview) return;
    if (sv.CanvasSelection.getUiDataColumns().length > 1) {
      e.preventDefault();
      sv.CanvasSelection.deselectAll();
    }
  };

  const previewViewer = () => {
    const g = app._rightGroup;
    if (view === 'beside' && g && app._sideView && g.active === app._sideView.tab) return g.viewer;
    return viewerOf();
  };

  const syncBeside = () => {
    const pv = previewViewer();
    const sv = viewerOf();
    if (pv === sv) return Promise.resolve();
    pv.state.activeTableId = sv.state.activeTableId;
    pv.state.tablePreviewGhost = sv.state.tablePreviewGhost;
    pv.state.tablePreviewFormatting = sv.state.tablePreviewFormatting;
    pv.destroyText(false);
    return pv.displayPage(pv.state.cp.n, false, true);
  };

  const previewKey = (e) => {
    const t = /** @type {?HTMLElement} */ (e.target);
    if (t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    const nativeSel = window.getSelection && window.getSelection();
    if (nativeSel && !nativeSel.isCollapsed) return;
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      const pv = previewViewer();
      const sel = pv._tpSel;
      const sheet = sel ? pv.getUiDataTables().find((u) => u.layoutDataTable.id === sel.id) : null;
      const cell = sheet ? pv._overlayGroups?.[sheet.layoutDataTable.page.n]?.querySelector(`[data-scribe-tp-cell="${Math.min(sel.r, sel.r2)},${Math.min(sel.c, sel.c2)}"]`) : null;
      if (!cell) return;
      e.preventDefault();
      const r = cell.getBoundingClientRect();
      cell.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true, cancelable: true, clientX: r.left + 8, clientY: r.top + 8, button: 2,
      }));
      return;
    }
    const arrow = {
      ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
    }[e.key];
    if (arrow && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (moveTablePreviewSelection(previewViewer(), arrow[0], arrow[1], e.shiftKey)) e.preventDefault();
      return;
    }
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = e.key.toLowerCase();
    if (key !== 'c' && key !== 'a') return;
    const handled = key === 'c' ? !!copyTablePreviewSelection(previewViewer()) : selectAllTablePreviewCells(previewViewer());
    if (handled) e.preventDefault();
  };

  /** @param {boolean} on */
  const setLanePreview = (on) => {
    const sv = viewerOf();
    if (sv.state.tablePreview === on) return;
    sv.state.tablePreview = on;
    if (on) {
      priorDisplayMode = sv.state.displayMode;
      sv.state.displayMode = 'ebook';
      // A column selection left by the page view would render as a phantom blue fill over the sheet.
      sv.CanvasSelection.deselectAll();
    } else {
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
  };

  /** @type {?{prev: ?Function}} */
  let laneEditedHook = null;
  const dropBesideHooks = () => {
    if (!laneEditedHook) return;
    viewerOf().onLayoutTablesEdited = laneEditedHook.prev;
    laneEditedHook = null;
  };
  const openBeside = () => {
    const sv = viewerOf();
    const configure = async (v) => {
      v.state.layoutMode = true;
      v.state.tablePreview = true;
      v.state.displayMode = 'ebook';
      v.CanvasSelection.deselectAll();
      v.onLayoutTablesEdited = paneEdited;
      await syncBeside();
    };
    const release = (v) => {
      v.state.tablePreview = false;
      v.state.layoutMode = false;
      v.state.displayMode = 'invis';
      v._tpSel = null;
      if (v.onLayoutTablesEdited === paneEdited) v.onLayoutTablesEdited = null;
    };
    // A provisional document holds no tables until it has loaded.
    const retarget = (doc) => doc.layoutDataTables.pages.some((p) => p?.tables?.length > 0) || !!doc._textReadySettle || doc.hydrationState !== 'hydrated';
    const onClose = () => {
      if (view !== 'beside') return;
      view = 'page';
      dropBesideHooks();
      document.removeEventListener('keydown', previewKey);
      syncSeg();
    };
    const prev = sv.onLayoutTablesEdited;
    laneEditedHook = { prev };
    sv.onLayoutTablesEdited = (n) => {
      prev?.(n);
      syncBeside();
    };
    const paneEdited = (n) => {
      if (sv.state.layoutMode && sv.overlayGroupsRenderIndices.includes(n)) {
        sv.destroyControls();
        renderLayoutBoxes(sv, n);
      }
      prev?.(n);
    };
    app._openSideView({
      label: 'Preview Export', icon: EXTRACT_TABLES_MODE_SVG, configure, release, onClose, retarget,
    });
  };
  /** @param {'page'|'preview'|'beside'} next */
  const setView = (next) => {
    if (next === view) {
      if (next === 'beside') app._raiseSideView();
      return;
    }
    if (next === 'beside' && (!active || besideBtn.disabled)) return;
    const prev = view;
    view = next;
    if (prev === 'beside') {
      dropBesideHooks();
      app._closeSideView();
    }
    if (next === 'page') document.removeEventListener('keydown', previewKey);
    else if (prev === 'page') document.addEventListener('keydown', previewKey);
    setLanePreview(next === 'preview');
    if (next === 'beside') openBeside();
    syncSeg();
  };
  pageBtn.addEventListener('click', () => setView('page'));
  previewBtn.addEventListener('click', () => setView('preview'));
  besideBtn.addEventListener('click', () => setView('beside'));
  syncSeg();

  const setActive = (next) => {
    if (active === next) return;
    const sv = next ? app._activeViewer() : viewerOf();
    if (next && !sv.doc) return;
    active = next;
    toolbarElem.classList.toggle('active', active);
    // The view returns to the page before the mode's viewer is let go, since leaving a view undoes its changes to that viewer.
    if (!active && view !== 'page') setView('page');
    modeViewer = next ? sv : null;
    syncSeg();
    // One flag gates the layout overlays, the selection fork, and the context-menu table verbs together.
    sv.state.layoutMode = active;
    if (active) {
      sv.clearTextSelection?.();
      document.addEventListener('keydown', pageEscKey, true);
      // Re-displayed so that displayPage's layout branch paints the window pages' overlays now that the flag is on.
      sv.displayPage(sv.state.cp.n, false, false);
      app._automatePanel?.openTablesWorkspace();
      sv._armAddLayoutTable = armAddTable;
    } else {
      disarm();
      delete sv._armAddLayoutTable;
      document.removeEventListener('keydown', pageEscKey, true);
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
  toolbarElem.addEventListener('click', async () => {
    if (toolbarElem.classList.contains('disabled')) return;
    if (!active && !(await hydrateIfProvisional(app._activeViewer().doc))) return;
    setActive(!active);
  });

  /* Re-derives this mode's surfaces for a newly opened document, since a tab switch keeps the mode running.
     The shell has to call this after the new document's first displayPage, or the navigation below is overridden. */
  const docChanged = () => {
    if (!active) return;
    disarm();
    const sv = viewerOf();
    if (view === 'preview') {
      const sheet = resolveActiveSheet(sv);
      // A document that is still extracting, or has not loaded, may yet hold tables, so only a settled tableless one drops the preview.
      if (!sheet && !sv.doc._textReadySettle && sv.doc.hydrationState === 'hydrated') setView('page');
      else if (sheet && sheet.n !== sv.state.cp.n) sv.displayPage(sheet.n, true, true);
    }
    app._automatePanel?.openTablesWorkspace();
  };

  // The catalog row's entry point, which unlike the toolbar button never toggles the mode off.
  const open = async () => {
    if (active) { app._automatePanel?.openTablesWorkspace(); return; }
    if (!(await hydrateIfProvisional(app._activeViewer().doc))) return;
    setActive(true);
  };

  const tool = {
    toolbarElem, isActive: () => active, open, close: () => setActive(false), viewSegElem: () => viewSeg, docChanged, armAddTable, hintText, syncBeside,
  };
  return tool;
}

const INSPECT_MODE_SVG = modeIcon('<circle cx="8.5" cy="8.5" r="6"/><path d="M8.5 7.5v4M8.5 5.5v.01"/>');
const INSPECT_ARMED_HINT = 'Click a word on the page to identify its font · Esc cancels';

/**
 * The Inspect Document mode tool.
 * The document's facts, size and fonts show in the right panel, or the bottom sheet on the phone.
 * A font is identified by a deliberate pick: the panel's "Identify font" arms one click on the page, which pins the font that drew the word and rings the word.
 * The context menu and the touch callout offer the same verb without arming.
 * A click on the ringed word or on blank paper drops the pin.
 * @param {import('../../basic-viewer/pdf-viewer.js').ScribePDFViewer} app
 * @returns {{ toolbarElem: HTMLElement, isActive: () => boolean, open: () => void, close: () => void, docChanged: () => void,
 *   setArmed: (on: boolean) => void, isArmed: () => boolean, hintText: () => ?string, identify: (kw: any) => boolean }}
 */
export function createInspectDocumentTool(app) {
  const toolbarElem = makeIconButton('Inspect Document', INSPECT_MODE_SVG);
  toolbarElem.classList.add('cr-labeled-button');
  const toolbarLabelElem = document.createElement('span');
  toolbarLabelElem.className = 'cr-btn-label';
  toolbarLabelElem.textContent = 'Inspect Document';
  toolbarElem.appendChild(toolbarLabelElem);
  let active = false;
  let armed = false;
  /** @type {?{n: number, word: import('../../../js/objects/ocrObjects.js').OcrWord}} The word whose font is pinned. */
  let pinned = null;
  // The Edit Text hover box, at word size: the same 1.5px band 2px out from the glyphs.
  const hoverElem = document.createElement('div');
  hoverElem.className = 'scribe-inspect-hover';
  Object.assign(hoverElem.style, {
    position: 'absolute',
    border: 'calc(1.5px / var(--scribe-zoom, 1)) solid rgba(26, 115, 232, 0.75)',
    borderRadius: '2px',
    pointerEvents: 'none',
    boxSizing: 'border-box',
  });
  // An outline, not a border, so the ring never covers the glyphs it marks.
  const ringElem = document.createElement('div');
  ringElem.className = 'scribe-inspect-ring';
  Object.assign(ringElem.style, {
    position: 'absolute',
    outline: 'calc(2px / var(--scribe-zoom, 1)) solid var(--scribe-accent, #1c62d4)',
    outlineOffset: 'calc(1px / var(--scribe-zoom, 1))',
    borderRadius: 'calc(1px / var(--scribe-zoom, 1))',
    pointerEvents: 'none',
    boxSizing: 'border-box',
  });
  const hideHover = () => hoverElem.remove();
  /** The live workspace, wherever it is mounted. */
  const workspace = () => (app._phoneUi ? app._inspectSheetHandle : app._automatePanel?.inspectWorkspace()) || null;
  // The panel module loads lazily, so an early entry waits for it; the phone's sheet needs no panel.
  const showWorkspace = () => {
    if (app._phoneUi) { app._openInspectSheet?.(); return; }
    Promise.resolve(app._automateReady).then(() => { if (active && !app._phoneUi) app._automatePanel?.openInspectWorkspace(); });
  };

  /** Whether the inventory can name the font that drew a UI word: native text whose font object is known. */
  const identifiable = (kw) => {
    const doc = app._activeViewer().doc;
    const page = kw?.word?.line?.page;
    if (!doc || !page || page.textSource !== 'pdf') return false;
    return doc.nativeText.pages[page.n]?.[kw.word.id]?.fontObjNum != null;
  };
  /** Mount `el` over `word` in its page's text group, `pad` px out from the drawn box; off-window pages get nothing. */
  const placeBox = (el, word, pad) => {
    const sv = app._activeViewer();
    const n = word.line.page.n;
    if (!sv.doc || !sv.windowPages(sv.state.cp.n).includes(n)) { el.remove(); return; }
    const group = sv.getTextGroup(n, word.line.orientation || 0);
    if (!group) { el.remove(); return; }
    const box = wordDrawBox(app._activeViewer().doc, word);
    el.style.left = `${box.left - pad}px`;
    el.style.top = `${box.top - pad}px`;
    el.style.width = `${box.right - box.left + 2 * pad}px`;
    el.style.height = `${box.bottom - box.top + 2 * pad}px`;
    if (el.parentElement !== group) group.appendChild(el);
  };
  const drawRing = () => { if (pinned) placeBox(ringElem, pinned.word, 0); else ringElem.remove(); };

  const setArmed = (on) => {
    if ((on && !active) || armed === on) return;
    armed = on;
    const sv = app._activeViewer();
    // The Edit Text convention: the arrow while a pick is armed, since the hover box marks what a click takes.
    if (sv.textSel) sv.textSel.cursorOverride = on ? 'default' : null;
    if (!on) hideHover();
    app._setToolHint?.(app._inspectTool);
    if (on) app._lowerInspectSheet?.();
    sv._modeStatus?.(on ? 'Tap a word on the page' : '');
    workspace()?.armedChanged?.(on);
  };
  /**
   * Drop the pinned font, its mask and the ring.
   * Returns whether a font was pinned.
   */
  const clearPin = () => {
    const had = !!pinned || !!workspace()?.hasPin?.();
    pinned = null;
    ringElem.remove();
    workspace()?.clearPin?.();
    return had;
  };
  /**
   * Pin the font that drew `kw`.
   * The panel opens its row and masks the pages around its words, the word keeps a ring, and an armed pick disarms.
   * @returns {boolean} Whether the word maps to a font in the inventory.
   */
  const pickWord = (kw) => {
    if (!active || !identifiable(kw)) return false;
    const n = kw.word.line.page.n;
    if (!workspace()?.selectWord(n, kw.word.id)) return false;
    pinned = { n, word: kw.word };
    drawRing();
    hideHover();
    if (armed) setArmed(false);
    return true;
  };

  const hoverHandler = (ev) => {
    // The phone has no hover; a compat mouse event after a tap would leave a stray box.
    if (!armed || app._phoneUi || ev.buttons !== 0) { hideHover(); return; }
    const kw = app._activeViewer().textSel?.wordAt?.(ev.clientX, ev.clientY);
    if (!kw || !identifiable(kw)) { hideHover(); return; }
    placeBox(hoverElem, kw.word, 2);
  };
  // A click (no drag) on the page.
  // Capture phase, ahead of the selection engine, and without stopping propagation, so a drag still selects text as in View.
  /** @type {?{x: number, y: number}} */
  let down = null;
  const onPointerDown = (ev) => {
    down = null;
    if (ev.button !== 0) return;
    const t = /** @type {?HTMLElement} */ (ev.target);
    if (t && t.closest && t.closest('.scribe-hl-cmark, .scribe-note-icon, .scribe-cmt-card, .scribe-field, .scribe-item, .scribe-inspect-wordfield, [contenteditable]')) return;
    down = { x: ev.clientX, y: ev.clientY };
  };
  const onPointerUp = (ev) => {
    const d = down;
    down = null;
    if (!d || Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 6) return;
    const kw = app._activeViewer().textSel?.wordAt?.(ev.clientX, ev.clientY) || null;
    // Armed: a click on text with no known font, a picture or blank paper leaves the pick armed.
    if (armed) { if (kw) pickWord(kw); return; }
    if (kw && workspace()?.wordClicked?.(kw)) return;
    // Pinned: the ringed word toggles and blank paper clears; any other word is View's.
    if (pinned && (!kw || kw.word === pinned.word)) clearPin();
  };
  // An Escape that clears nothing here falls through to the mode-exit handler.
  const pageEscKey = (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    const t = /** @type {?HTMLElement} */ (e.target);
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (armed) { setArmed(false); e.preventDefault(); return; }
    if (workspace()?.closeWordField?.()) { e.preventDefault(); return; }
    if (workspace()?.leaveEditMode?.()) { e.preventDefault(); return; }
    if (workspace()?.clearGlyph?.()) { e.preventDefault(); return; }
    if (clearPin()) e.preventDefault();
  };
  /** @type {?() => void} */
  let prevDisplayCb = null;
  /** @type {?() => void} */
  let ourDisplayCb = null;

  const setActive = (next) => {
    if (active === next) return;
    const sv = app._activeViewer();
    if (next && !sv.doc) return;
    active = next;
    toolbarElem.classList.toggle('active', active);
    if (active) {
      sv.clearTextSelection?.();
      // The context menu's and touch callout's "Identify font" verb, offered only while the mode is on.
      sv._inspectIdentify = (kw) => pickWord(kw);
      document.addEventListener('keydown', pageEscKey, true);
      sv.scrollContainer?.addEventListener('pointerdown', onPointerDown, true);
      sv.scrollContainer?.addEventListener('pointerup', onPointerUp, true);
      sv.scrollContainer?.addEventListener('pointermove', hoverHandler);
      // The workspace follows the navigation cursor, so it chains the single page hook the way Bulk Edit does.
      prevDisplayCb = sv.displayPageCallback;
      ourDisplayCb = () => {
        if (prevDisplayCb) prevDisplayCb();
        workspace()?.pageChanged();
        drawRing();
      };
      sv.displayPageCallback = ourDisplayCb;
      showWorkspace();
    } else {
      setArmed(false);
      pinned = null;
      ringElem.remove();
      hideHover();
      sv._inspectIdentify = null;
      document.removeEventListener('keydown', pageEscKey, true);
      sv.scrollContainer?.removeEventListener('pointerdown', onPointerDown, true);
      sv.scrollContainer?.removeEventListener('pointerup', onPointerUp, true);
      sv.scrollContainer?.removeEventListener('pointermove', hoverHandler);
      if (sv.displayPageCallback === ourDisplayCb) sv.displayPageCallback = prevDisplayCb;
      ourDisplayCb = null;
      app._automatePanel?.closeInspectWorkspace();
      app._closeInspectSheet?.();
    }
  };
  toolbarElem.addEventListener('click', async () => {
    if (toolbarElem.classList.contains('disabled')) return;
    if (!active && !(await hydrateIfProvisional(app._activeViewer().doc))) return;
    setActive(!active);
  });

  /** Re-derive the workspace on the current layout's surface after a tab switch or a layout switch. */
  const docChanged = () => {
    if (!active) return;
    // The pick and pin belong to the old workspace.
    setArmed(false);
    pinned = null;
    ringElem.remove();
    showWorkspace();
  };

  // The app-menu row's entry point, driving the button with a programmatic click so mode exclusivity and the banner sync keep their one implementation.
  // Entering an already-active mode never toggles it off.
  const open = () => {
    if (active) docChanged();
    else if (!toolbarElem.classList.contains('disabled')) toolbarElem.click();
  };

  return {
    toolbarElem,
    isActive: () => active,
    open,
    close: () => setActive(false),
    docChanged,
    setArmed,
    isArmed: () => armed,
    /** The banner hint while a pick is armed; null leaves the mode's own hint in place. */
    hintText: () => (armed ? INSPECT_ARMED_HINT : null),
    identify: (kw) => pickWord(kw),
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

const PROOFREAD_SVG = modeIcon('<path d="M2.5 4.5h12M2.5 7.5h8M2.5 10.5h5"/><path d="M9.5 12.5l2 2 3.5-4.5"/>');

/**
 * Create the Proofread Text mode tool.
 * The mode draws the recognized text over the page, colored by confidence, with each word selectable and editable in place.
 * @param {import('../../basic-viewer/pdf-viewer.js').ScribePDFViewer} app
 * @returns {{ toolbarElem: HTMLElement, isActive: () => boolean, close: () => void }}
 */
export function createProofreadTextTool(app) {
  const toolbarElem = makeIconButton('Proofread Text', PROOFREAD_SVG);
  toolbarElem.classList.add('cr-labeled-button');
  const toolbarLabelElem = document.createElement('span');
  toolbarLabelElem.className = 'cr-btn-label';
  toolbarLabelElem.textContent = 'Proofread Text';
  toolbarElem.appendChild(toolbarLabelElem);
  let active = false;
  // The mode's viewer is fixed at entry, since a press into the other group during Side by side makes that group active without ending the mode.
  let modeViewer = null;
  /** @param {boolean} next */
  const setActive = (next) => {
    if (active === next) return;
    const sv = next ? app._activeViewer() : (modeViewer || app._activeViewer());
    if (next && !sv.doc) return;
    active = next;
    modeViewer = next ? sv : null;
    toolbarElem.classList.toggle('active', active);
    UiText.enableEditing = active;
    sv.state.displayMode = active ? 'proof' : 'invis';
    if (active) sv.clearTextSelection?.();
    else sv.destroyControls(true);
    sv.destroyText(false);
    sv.displayPage(sv.state.cp.n, false, true);
  };
  toolbarElem.addEventListener('click', () => {
    // Leaving comes before the disabled check, since the gate can disable the row while the mode is on and every exit runs through this click.
    if (active) { setActive(false); return; }
    if (toolbarElem.classList.contains('disabled')) return;
    const doc = app._activeViewer().doc;
    // Awaiting before the toggle would let the exclusivity click see this button inactive and leave the other mode on.
    if (doc && doc.hydrationState !== 'hydrated') {
      hydrateIfProvisional(doc).then(async (ok) => {
        if (!ok) return;
        // Once its text is in, the loaded document decides whether there is anything to proofread.
        // Activating on the unloaded document's answer could leave the mode on with its row disabled.
        const real = app._activeViewer().doc;
        if (!real || real.hydrationState !== 'hydrated') return;
        if (real.textReady) await real.textReady.catch(() => {});
        if (app._activeViewer().doc !== real) return;
        app._syncDocGatedControls?.();
        if (toolbarElem.classList.contains('disabled')) return;
        // The exclusivity click saw this button inactive, so the mode that was on is closed here before this one opens.
        for (const other of app._exclusiveToolBtns || []) if (other !== toolbarElem && other.classList.contains('active')) other.click();
        setActive(true);
      });
      return;
    }
    setActive(true);
  });
  return { toolbarElem, isActive: () => active, close: () => setActive(false) };
}

const COMPARE_SVG = modeIcon('<path d="M5.5 5.5v-3h9v9h-3"/><rect x="2.5" y="5.5" width="9" height="9" rx="1"/><path d="M4.5 8.5h5M4.5 11.5h5"/>');

/**
 * Create the Compare Versions mode tool.
 * The mode compares the lane's document against the right group's and marks the changes on both.
 * @param {import('../../basic-viewer/pdf-viewer.js').ScribePDFViewer} app
 */
export function createCompareVersionsTool(app) {
  const toolbarElem = makeIconButton('Compare Versions', COMPARE_SVG);
  toolbarElem.classList.add('cr-labeled-button');
  const toolbarLabelElem = document.createElement('span');
  toolbarLabelElem.className = 'cr-btn-label';
  toolbarLabelElem.textContent = 'Compare Versions';
  toolbarElem.appendChild(toolbarLabelElem);
  let active = false;
  /** @param {boolean} next */
  const setActive = (next) => {
    if (active === next) return;
    active = next;
    toolbarElem.classList.toggle('active', active);
    if (active) app._startCompare(); else app._endCompare();
  };
  toolbarElem.addEventListener('click', () => {
    if (active) { setActive(false); return; }
    if (toolbarElem.classList.contains('disabled')) return;
    const provisional = app._compareDocs().filter((doc) => doc && doc.hydrationState !== 'hydrated');
    if (provisional.length) {
      Promise.all(provisional.map((doc) => hydrateIfProvisional(doc))).then(async (oks) => {
        if (oks.some((ok) => !ok)) return;
        const docs = app._compareDocs();
        if (docs.some((doc) => !doc || doc.hydrationState !== 'hydrated')) return;
        await Promise.all(docs.map((doc) => (doc.textReady ? doc.textReady.catch(() => {}) : null)));
        app._syncDocGatedControls?.();
        if (toolbarElem.classList.contains('disabled')) return;
        // The exclusivity click saw this button inactive, so the mode that was on is closed here before this one opens.
        for (const other of app._exclusiveToolBtns || []) if (other !== toolbarElem && other.classList.contains('active')) other.click();
        setActive(true);
      });
      return;
    }
    setActive(true);
  });
  return { toolbarElem, isActive: () => active, close: () => setActive(false) };
}
