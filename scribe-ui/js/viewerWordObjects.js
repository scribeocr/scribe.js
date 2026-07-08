import scribe from '../../scribe.js';
// eslint-disable-next-line import/no-cycle
import { ScribeViewer } from '../viewer.js';

/**
 * Resolve the viewer associated with a UiText/UiOcrWord.
 * Falls back to the default viewer when none was explicitly attached (backward-compat for single-viewer apps).
 * @param {UiText} itext
 */
function getViewer(itext) {
  return itext.viewer || ScribeViewer.getDefault();
}

let wordStyleSheetInjected = false;

/**
 * Inject, once, the static styles shared by every `.scribe-word` span (see `_styleElem`),
 * as one stylesheet rule rather than inline on each of thousands of words.
 */
function ensureWordStyleSheet() {
  if (wordStyleSheetInjected || typeof document === 'undefined') return;
  wordStyleSheetInjected = true;
  const styleEl = document.createElement('style');
  // `.scribe-fill` = selection dead-space fillers built alongside the words (see `_renderCanvasWords`).
  // z-index 0 sits them under the words (z-index 1) so a pointer over a glyph hit-tests the word, not the filler.
  // color:transparent and the ::selection rule keep the filler unpainted, including the selection sliver the browser would otherwise paint over its character.
  // No overflow:hidden by design: there is nothing to clip, and a clip node per filler across thousands of them taxes paint and compositing every frame.
  styleEl.textContent = '.scribe-word{position:absolute;z-index:1;white-space:nowrap;font-kerning:normal;pointer-events:auto;padding:0}'
    + '.scribe-fill{position:absolute;z-index:0;pointer-events:auto;width:0;white-space:pre;font-size:2px;color:transparent}'
    + '.scribe-fill::selection{background:transparent;color:transparent}';
  document.head.appendChild(styleEl);
}

/**
 * A word rendered as an absolutely-positioned `<span>` in page (content) space.
 * While it uses an `OcrWord` for layout, it is not tied to OCR and works with any dummy `OcrWord`.
 */
export class UiText {
  /** @type {?HTMLSpanElement} */
  static input = null;

  /**
   * innerHTML of the input element before the current edit, used to restore it within a callback when the new value is invalid.
   */
  static inputInnerHTMLLast = '';

  static inputCursorLast = 0;

  /** @type {?UiText} */
  static inputWord = null;

  /** @type {?Function} */
  static inputRemove = null;

  static enableEditing = false;

  static smartQuotes = true;

  /** Client coordinates of the pointer at the last edit-triggering double-click, read by `getCursorIndex`. */
  static _lastPointerClient = { x: 0, y: 0 };

  /**
   * @param {Object} options
   * @param {number} options.x
   * @param {number} options.yActual
   * @param {InstanceType<typeof scribe.utils.ocr.OcrWord>} options.word
   * @param {number} [options.rotation=0]
   * @param {boolean} [options.outline=false]
   * @param {boolean} [options.selected=false]
   * @param {boolean} [options.fillBox=false]
   * @param {boolean} [options.activeMatch=false]
   * @param {number} [options.opacity=1]
   * @param {string} [options.fill='black']
   * @param {boolean} [options.dynamicWidth=false] - If `true`, the width is computed from the text content rather than the bounding box.
   *    Used for dummy text boxes not tied to OCR; should be `false` for OCR text boxes.
   * @param {Function} [options.changeTextCallback] - Called when the text is edited and the input loses focus.
   * @param {Function} [options.inputTextCallback] - Called when a keystroke modifies the value of the text input.
   * @param {?string} [options.highlightColor=null] - Highlight background color (hex string like '#ffff00'), or null for no highlight.
   * @param {number} [options.highlightOpacity=1] - Opacity for the highlight background (0-1).
   * @param {?string} [options.highlightGroupId=null] - Group ID linking annotations in the same highlight group.
   * @param {string} [options.highlightComment=''] - Comment text attached to this highlight group.
   * @param {import('../viewer.js').ScribeViewer} [options.viewer] - The viewer this word belongs to; falls back to the default viewer.
   */
  constructor({
    x, yActual, word, rotation = 0,
    outline = false, selected = false, fillBox = false, activeMatch = false, opacity = 1, fill = 'black', dynamicWidth = false, changeTextCallback, inputTextCallback,
    highlightColor = null, highlightOpacity = 1, highlightGroupId = null, highlightComment = '',
    viewer,
  }) {
    const _viewer = viewer || ScribeViewer.getDefault();
    ensureWordStyleSheet();
    const {
      charSpacing, leftSideBearing, rightSideBearing, fontSize, charArr, advanceArr, kerningArr, font,
    } = scribe.utils.calcWordMetrics(word, _viewer.doc.fonts);

    const charSpacingFinal = !dynamicWidth ? charSpacing : 0;

    const advanceArrTotal = [];
    for (let i = 0; i < advanceArr.length; i++) {
      let leftI = 0;
      leftI += advanceArr[i] || 0;
      leftI += kerningArr[i] || 0;
      leftI += charSpacingFinal || 0;
      advanceArrTotal.push(leftI);
    }

    // The `dynamicWidth` option is useful for dummy text boxes that are not tied to OCR, however should be `false` for OCR text boxes.
    // Setting to `true` for OCR text results in no change for most words, however can cause fringe issues with some words.
    // For example, in some cases Tesseract will misidentify a single character as a multi-character word.
    // In this case, the total advance may be negative, making this method of calculating the width incorrect.
    let width = dynamicWidth ? advanceArrTotal.reduce((a, b) => a + b, 0) : word.bbox.right - word.bbox.left;

    // Subtract the side bearings from the width if they are not excluded from the `ocrWord` coordinates.
    if (!dynamicWidth && !word.visualCoords) {
      width -= (leftSideBearing + rightSideBearing);
      width = Math.max(width, 7);
    }

    let y = yActual - fontSize * 0.6;
    if (!word.visualCoords && (word.style.sup || word.style.dropcap)) {
      const fontDesc = font.opentype.descender / font.opentype.unitsPerEm * fontSize;
      y = yActual - fontSize * 0.6 + fontDesc;
    }

    /** @type {import('../viewer.js').ScribeViewer} */
    this.viewer = _viewer;
    this.word = word;
    this.charArr = charArr;
    this.charSpacing = charSpacingFinal;
    this.advanceArrTotal = advanceArrTotal;
    this.leftSideBearing = leftSideBearing;
    this.fontSize = fontSize;
    this.smallCapsMult = font.smallCapsMult;
    // Vertical font metrics (ascent/descent) in px, derived from the opentype font rather than a per-word canvas `measureText`.
    // The equivalent `fontBoundingBoxAscent`/`Descent` are per-(font, size) and text-independent, so per-word measurement would add nothing.
    this.fontAscentPx = font.opentype.ascender / font.opentype.unitsPerEm * fontSize;
    this.fontDescentPx = -font.opentype.descender / font.opentype.unitsPerEm * fontSize;
    // `yActual` is the y value we want to draw the text at, which is usually the baseline.
    this.yActual = yActual;
    // Baseline used to re-derive `yActual` on edit; `UiOcrWord` overrides it with its measured line baseline.
    this.topBaseline = yActual;
    this.fontFaceStyle = font.fontFaceStyle;
    this.fontFaceWeight = font.fontFaceWeight;
    this.fontFaceName = font.fontFaceName;
    this.fontFamilyLookup = font.family;
    this.rotation = rotation;
    this.dynamicWidth = dynamicWidth;
    this.changeTextCallback = changeTextCallback;
    this.inputTextCallback = inputTextCallback;

    // Geometry, in page (content) space. `x`/`y` are the top-left of the interactive box; `width`/`height` its size.
    this._x = x;
    this._y = y;
    this._width = width;
    this._height = fontSize * 0.6;
    this._scaleX = 1;
    this._fill = fill;
    this._opacity = opacity;
    this._listening = true;
    this._visible = true;

    // Visual-state flags whose setters restyle the element, so external assignments (search/highlight) repaint with no redraw call.
    this._outline = outline;
    this._selected = selected;
    this._fillBox = fillBox;
    this._activeMatch = activeMatch;
    this._highlightColor = highlightColor;
    this._highlightOpacity = highlightOpacity;
    this.highlightGroupId = highlightGroupId;
    this.highlightComment = highlightComment;
    this.highlightGapLeft = 0;
    this.highlightGapRight = 0;
    /**
     * The fill rect this word's highlight run rendered into (set by `renderHighlights`, null when unhighlighted).
     * Hover feedback lifts this band directly when the highlight has no group id.
     * @type {?HTMLDivElement}
     */
    this.highlightRectElem = null;

    this.lastWidth = width;

    /** @type {HTMLSpanElement} */
    this.el = this._styleElem(document.createElement('span'), { fresh: true });
    // Back-reference for hit-testing: `event.target.closest('.scribe-word')._scribeObj` resolves to this object.
    /** @type {any} */ (this.el)._scribeObj = this;

    this.el.addEventListener('dblclick', (event) => {
      if (!UiText.enableEditing) return;
      if (event.button !== 0) return;
      UiText._lastPointerClient = { x: event.clientX, y: event.clientY };
      UiText.addTextInput(this);
    });

    this.select = () => { this.selected = true; };
    this.deselect = () => { this.selected = false; };
  }

  /** @param {number} [v] @returns {number} */
  x(v) { if (v === undefined) return this._x; this._x = v; if (this.el) this._position(); return this._x; }

  /** @param {number} [v] @returns {number} */
  y(v) { if (v === undefined) return this._y; this._y = v; if (this.el) this._position(); return this._y; }

  /** @param {number} [v] @returns {number} */
  width(v) { if (v === undefined) return this._width; this._width = v; return this._width; }

  /** @param {number} [v] @returns {number} */
  height(v) { if (v === undefined) return this._height; this._height = v; return this._height; }

  /** @param {number} [v] @returns {number} */
  scaleX(v) { if (v === undefined) return this._scaleX; this._scaleX = v; if (this.el) this._position(); return this._scaleX; }

  /** @param {string} [v] @returns {string} */
  fill(v) { if (v === undefined) return this._fill; this._fill = v; if (this.el) this._styleElem(this.el); return this._fill; }

  /** @param {number} [v] @returns {number} */
  opacity(v) { if (v === undefined) return this._opacity; this._opacity = v; if (this.el) this._styleElem(this.el); return this._opacity; }

  /** @param {boolean} [v] @returns {boolean} */
  listening(v) {
    if (v === undefined) return this._listening;
    this._listening = v;
    if (this.el) this.el.style.pointerEvents = v ? 'auto' : 'none';
    return this._listening;
  }

  /** @param {boolean} [v] @returns {boolean} */
  visible(v) { if (v === undefined) return this._visible; this._visible = v; if (this.el) this.el.style.display = v ? '' : 'none'; return this._visible; }

  show() { this.visible(true); }

  hide() { this.visible(false); }

  /** Re-apply style to the element after field changes. */
  draw() { if (this.el) this._styleElem(this.el); }

  get outline() { return this._outline; }

  set outline(v) { this._outline = v; if (this.el) this._applyStateStyle(); }

  get selected() { return this._selected; }

  set selected(v) { this._selected = v; if (this.el) this._applyStateStyle(); }

  get fillBox() { return this._fillBox; }

  set fillBox(v) { this._fillBox = v; if (this.el) this._applyStateStyle(); }

  get activeMatch() { return this._activeMatch; }

  set activeMatch(v) { this._activeMatch = v; if (this.el) this._applyStateStyle(); }

  get highlightColor() { return this._highlightColor; }

  // The fill is drawn by the viewer's highlight layer (`renderHighlights`), not the word span, so setting the colour only updates state.
  set highlightColor(v) { this._highlightColor = v; }

  get highlightOpacity() { return this._highlightOpacity; }

  set highlightOpacity(v) { this._highlightOpacity = v; }

  /** Remove the element from the DOM and drop this word from the viewer's per-page registry. */
  destroy() {
    // The registry that `getUiWords` reads must never hold a destroyed word.
    // A lingering entry whose element is now null crashes any later pass that calls `getClientRect` on it.
    // Doing this here covers every delete path, not just one caller.
    const n = this.word?.line?.page?.n;
    const pageWords = (n !== undefined && this.viewer) ? this.viewer._wordObjs[n] : undefined;
    if (pageWords) {
      const i = pageWords.findIndex((w) => w === this);
      if (i >= 0) pageWords.splice(i, 1);
    }
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
    this.el = /** @type {any} */ (null);
  }

  /** The element's parent (the per-line wrapper), used when attaching edit controls. */
  getParent() { return this.el ? this.el.parentNode : null; }

  /**
   * Content-space axis-aligned bounding box of the rendered span (handles zoom/rotation via the live layout).
   * @returns {{x: number, y: number, width: number, height: number}}
   */
  getClientRect() {
    const v = getViewer(this);
    const r = this.el.getBoundingClientRect();
    const tl = v.clientToContent(r.left, r.top);
    const br = v.clientToContent(r.right, r.bottom);
    return {
      x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y,
    };
  }

  /** Update only the absolute position of the element from the current `x`/`y` (cheap; no text re-measure). */
  _position() {
    if (!this.el) return;
    const scale = 1;
    let x1 = this._x;
    if (this.word.visualCoords) x1 -= this.leftSideBearing * scale;

    const fontSizeHTML = this.fontSize * scale;
    const topHTML = this._y - this.fontAscentPx * scale + fontSizeHTML * 0.6;

    this.el.style.left = `${x1}px`;
    this.el.style.top = `${topHTML}px`;
  }

  /** Apply the search-match fill and selection/outline decorations from the current flags. */
  _applyStateStyle() {
    if (!this.el) return;
    if (this._activeMatch) this.el.style.backgroundColor = '#ff990088';
    else if (this._fillBox) this.el.style.backgroundColor = '#4278f550';
    else this.el.style.backgroundColor = '';

    if (this._selected) this.el.style.outline = 'calc(2px / var(--scribe-zoom, 1)) solid rgba(40,123,181,1)';
    else if (this._outline) this.el.style.outline = 'calc(2px / var(--scribe-zoom, 1)) solid black';
    else this.el.style.outline = 'none';
  }

  /**
   * Apply all content, font, position, opacity, underline, small-caps, and highlight styling to `elem` from the current fields.
   * Used both to build `this.el` and to rebuild the editable input.
   * @param {HTMLSpanElement} elem
   * @param {object} [opts]
   * @param {boolean} [opts.pad=false] - Add horizontal padding so an edit cursor is visible before the first / after the last letter.
   *   Pass false for the read-only word, where padding only makes adjacent word boxes overlap and corrupt selection.
   * @param {boolean} [opts.fresh=false] - True when styling a brand-new element (no stale inline style to clear).
   * @returns {HTMLSpanElement}
   */
  _styleElem(elem, { pad = false, fresh = false } = {}) {
    const scale = 1;
    const wordStr = this.charArr.join('');

    const charSpacingHTML = this.charSpacing * scale;

    let x1 = this._x;
    if (this.word.visualCoords) x1 -= this.leftSideBearing * scale;

    const fontSizeHTML = this.fontSize * scale;

    const fontSizeHTMLSmallCaps = this.fontSize * scale * this.smallCapsMult;

    // Align with baseline.
    const topHTML = this._y - this.fontAscentPx * scale + fontSizeHTML * 0.6;

    const angle = this.rotation;

    const padPx = pad ? 5 : 0;
    const topPadOffset = padPx * Math.sin(angle * (Math.PI / 180));
    const leftPadOffset = padPx * Math.cos(angle * (Math.PI / 180));
    const opacity = this._opacity;
    // A fresh element has no inline style to clear, so absent features are simply omitted.
    // Restyling an existing element must instead write a feature's default back, to clear a value a previous styling left behind.
    const restyle = !fresh;

    // Per-word dynamic styles, always written.
    // The static styles shared by every word live in the injected `.scribe-word` rule (see `ensureWordStyleSheet`), so they are not re-written per word.
    elem.style.left = `${x1 - leftPadOffset}px`;
    elem.style.top = `${topHTML - topPadOffset}px`;
    elem.style.fontSize = `${fontSizeHTML}px`;
    elem.style.fontFamily = this.fontFaceName;
    elem.style.fontStyle = this.fontFaceStyle;
    elem.style.fontWeight = this.fontFaceWeight;
    elem.style.letterSpacing = `${charSpacingHTML}px`;
    // Line height must match the height of the font bounding box for the font metrics to be accurate.
    elem.style.lineHeight = `${(this.fontAscentPx + this.fontDescentPx) * scale}px`;
    // Text with opacity 0 is not selectable, so we make it transparent instead.
    if (opacity === 0) {
      elem.style.color = 'transparent';
      elem.style.opacity = '1';
    } else {
      elem.style.color = this._fill;
      elem.style.opacity = String(opacity);
    }

    // Glyph selection is wanted only in `invis` mode, where the transparent text layer is the searchable/copyable overlay.
    // In the visible modes the word box is the interactive unit, so selecting the letters too would only be noise.
    const selectText = this.viewer.state.displayMode === 'invis';
    elem.style.userSelect = selectText ? 'text' : 'none';
    elem.style.setProperty('-webkit-user-select', selectText ? 'text' : 'none');

    // Exceptions to the `.scribe-word` defaults: written only when they differ,
    // and cleared on a restyle so a stale value does not linger.
    if (padPx) {
      elem.style.paddingLeft = `${padPx}px`;
      elem.style.paddingRight = `${padPx}px`;
    } else if (restyle) {
      elem.style.paddingLeft = '';
      elem.style.paddingRight = '';
    }
    if (!scribe.ScribeDoc.defaults.kerning) elem.style.fontKerning = 'none';
    else if (restyle) elem.style.fontKerning = '';
    if (!this._listening) elem.style.pointerEvents = 'none';
    else if (restyle) elem.style.pointerEvents = '';
    if (!this._visible) elem.style.display = 'none';
    else if (restyle) elem.style.display = '';

    if (Math.abs(angle ?? 0) > 0.05) {
      elem.style.transformOrigin = `left ${this._y - topHTML}px`;
      elem.style.transform = `rotate(${angle}deg)`;
    } else if (restyle) {
      elem.style.transformOrigin = '';
      elem.style.transform = '';
    }

    // For small caps, real uppercasing would persist into the saved text, and the CSS small-caps property cannot size the caps.
    // So render them with `text-transform: uppercase` (display-only) plus each letter in a span at a smaller font size.
    if (this.word.style.smallCaps) {
      elem.style.textTransform = 'uppercase';
      elem.innerHTML = UiText.makeSmallCapsDivs(wordStr, fontSizeHTMLSmallCaps);
    } else {
      if (restyle) elem.style.textTransform = '';
      elem.textContent = wordStr;
    }

    if (this.word.style.underline && opacity !== 0) {
      const underlineThickness = this.word.style.bold ? Math.ceil(fontSizeHTML / 12) : Math.ceil(fontSizeHTML / 24);
      const underlineOffset = Math.ceil(fontSizeHTML / 12) + Math.ceil(fontSizeHTML / 24) / 2;
      elem.style.textDecoration = 'underline';
      elem.style.textDecorationThickness = `${underlineThickness}px`;
      elem.style.textDecorationColor = this._fill;
      elem.style.textUnderlineOffset = `${underlineOffset}px`;
    } else if (restyle) {
      elem.style.textDecoration = '';
    }

    elem.classList.add('scribe-word');
    elem.id = this.word.id;

    // Always sets `outline` (selection/outline or none), so `_styleElem` does not need to suppress it separately.
    this._applyStateStyleOn(elem);

    return elem;
  }

  /**
   * Apply search-match/selection decorations to a specific element (shared by `_applyStateStyle` and `_styleElem`).
   * @param {HTMLSpanElement} elem
   */
  _applyStateStyleOn(elem) {
    if (this._activeMatch) elem.style.backgroundColor = '#ff990088';
    else if (this._fillBox) elem.style.backgroundColor = '#4278f550';
    else elem.style.backgroundColor = '';

    if (this._selected) elem.style.outline = 'calc(2px / var(--scribe-zoom, 1)) solid rgba(40,123,181,1)';
    else if (this._outline) elem.style.outline = 'calc(2px / var(--scribe-zoom, 1)) solid black';
    else elem.style.outline = 'none';
  }

  /**
   * Get the index of the letter that the cursor is closest to.
   * Used when selecting a letter to edit; when actively editing, `getInputCursorIndex` is used instead.
   * @param {UiText} itext
   */
  static getCursorIndex = (itext) => {
    const r = itext.el.getBoundingClientRect();
    const zoom = getViewer(itext).zoomLevel || 1;
    // Pointer x relative to the word's `x()` origin (the box left, before the visual-coords side-bearing shift).
    const relX = (UiText._lastPointerClient.x - r.left) / zoom - (itext.word.visualCoords ? itext.leftSideBearing : 0);

    let letterIndex = 0;
    let leftI = -itext.leftSideBearing;
    for (let i = 0; i < itext.charArr.length; i++) {
      // For most letters, the letter is selected if the pointer is in the left 75% of the advance.
      // This could be rewritten to be more precise by using the actual bounding box of each letter,
      // however this would require calculating additional metrics for each letter.
      // The 75% rule is a compromise, as setting to 50% would be unintuitive for users trying to select the letter they want to edit,
      // and setting to 100% would be unintuitive for users trying to position the cursor between letters.
      // For the last letter, using the 75% rule would make it extremely difficult to select the end of the word.
      const cutOffPer = i + 1 === itext.charArr.length ? 0.5 : 0.75;
      const cutOff = leftI + itext.advanceArrTotal[i] * cutOffPer;
      if (cutOff > relX) break;
      letterIndex++;
      leftI += itext.advanceArrTotal[i];
    }
    return letterIndex;
  };

  /**
   * @param {string} text
   * @param {number} fontSizeHTMLSmallCaps
   */
  static makeSmallCapsDivs = (text, fontSizeHTMLSmallCaps) => {
    const textDivs0 = text.match(/([a-z]+)|([^a-z]+)/g);
    if (!textDivs0) return '';
    const textDivs = textDivs0.map((x) => {
      const lower = /[a-z]/.test(x);
      const styleStr = lower ? `style="font-size:${fontSizeHTMLSmallCaps}px"` : '';
      return `<span class="input-sub" ${styleStr}>${x}</span>`;
    });
    return textDivs.join('');
  };

  /**
   * Update word textbox following changes.
   * Whenever a user edits a word in any way (including content and font/style),
   * the position and character spacing need to be re-calculated so they still overlay with the background image.
   * @param {UiText} wordI
   */
  static updateWordCanvas = (wordI) => {
    // Re-calculate left position given potentially new left bearing.
    const {
      advanceArr, fontSize, kerningArr, charSpacing, charArr, leftSideBearing, rightSideBearing, font,
    } = scribe.utils.calcWordMetrics(wordI.word, getViewer(wordI).doc.fonts);

    wordI.charArr = charArr;

    const charSpacingFinal = !wordI.dynamicWidth ? charSpacing : 0;

    const advanceArrTotal = [];
    for (let i = 0; i < advanceArr.length; i++) {
      let leftI = 0;
      leftI += advanceArr[i] || 0;
      leftI += kerningArr[i] || 0;
      leftI += charSpacingFinal || 0;
      advanceArrTotal.push(leftI);
    }

    wordI.advanceArrTotal = advanceArrTotal;

    wordI.charSpacing = charSpacingFinal;

    wordI.leftSideBearing = leftSideBearing;

    let width = wordI.dynamicWidth ? advanceArrTotal.reduce((a, b) => a + b, 0) : wordI.word.bbox.right - wordI.word.bbox.left;

    // Subtract the side bearings from the width if they are not excluded from the `ocrWord` coordinates.
    if (!wordI.dynamicWidth && !wordI.word.visualCoords) width -= (leftSideBearing + rightSideBearing);

    wordI.width(width);

    wordI.scaleX(1);

    wordI.fontSize = fontSize;
    wordI.height(fontSize * 0.6);
    // Font size may have changed, so refresh the cached vertical metrics (see the constructor).
    wordI.fontAscentPx = font.opentype.ascender / font.opentype.unitsPerEm * fontSize;
    wordI.fontDescentPx = -font.opentype.descender / font.opentype.unitsPerEm * fontSize;

    if (wordI.word.style.sup || wordI.word.style.dropcap) {
      const lineObj = wordI.word.line;
      wordI.yActual = wordI.topBaseline + (wordI.word.bbox.bottom - lineObj.bbox.bottom - lineObj.baseline[1]);
    } else {
      wordI.yActual = wordI.topBaseline;
    }

    let y = wordI.yActual - fontSize * 0.6;
    if (!wordI.word.visualCoords && (wordI.word.style.sup || wordI.word.style.dropcap)) {
      const fontDesc = font.opentype.descender / font.opentype.unitsPerEm * fontSize;
      y = wordI.yActual - fontSize * 0.6 + fontDesc;
    }
    wordI._y = y;

    wordI.show();

    if (wordI.el) wordI._styleElem(wordI.el);

    // The word may have shifted or changed width. Keep its edit handles (if any) tracking its edges.
    getViewer(wordI).repositionControls();

    // A highlighted word that moved or resized shifts its run's band, so rebuild the page's highlight layer.
    if (wordI.highlightColor) getViewer(wordI).renderHighlights(wordI.word.line.page.n);
  };

  /**
   * Build the absolutely-positioned `<span>` for a word, used both as the editable input and as the read-only word element.
   * @param {UiText} itext
   * @param {object} [opts]
   * @param {boolean} [opts.pad=true] - Add horizontal padding so an edit cursor is visible before the first / after the last letter.
   * @returns {HTMLSpanElement}
   */
  static itextToElem = (itext, { pad = true } = {}) => itext._styleElem(document.createElement('span'), { pad, fresh: true });

  /**
   * Set cursor position to `index` within the input.
   * @param {number} index
   */
  static setCursor = (index) => {
    if (!UiText.input) {
      console.error('Input element not found');
      return;
    }
    const range = document.createRange();
    const sel = /** @type {Selection} */ (window.getSelection());

    let letterI = 0;
    for (let i = 0; i < UiText.input.childNodes.length; i++) {
      const node = UiText.input.childNodes[i];
      const nodeLen = node.textContent?.length || 0;
      if (letterI + nodeLen >= index) {
        const textNode = node.nodeType === 3 ? node : node.childNodes[0];
        range.setStart(textNode, index - letterI);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        break;
      } else {
        letterI += nodeLen;
      }
    }
  };

  /**
   * Position and show the input for editing.
   * @param {UiText} itext
   * @param {?number} cursorIndex - Index to position the cursor at. If `null`, position is determined by mouse location.
   *    If `-1`, the cursor is positioned at the end of the text.
   */
  static addTextInput = (itext, cursorIndex = null) => {
    let letterIndex = cursorIndex ?? UiText.getCursorIndex(itext);
    if (letterIndex < 0) letterIndex = itext.charArr.length;

    if (UiText.inputRemove) UiText.inputRemove();

    const inputElem = UiText.itextToElem(itext);
    inputElem.contentEditable = 'plaintext-only';
    // The editable input must stay selectable even in modes where `_styleElem` disables glyph selection on the read-only word,
    // otherwise the caret cannot be placed and text cannot be selected while editing.
    inputElem.style.userSelect = 'text';
    inputElem.style.setProperty('-webkit-user-select', 'text');

    UiText.inputWord = itext;
    UiText.input = inputElem;
    UiText.inputInnerHTMLLast = inputElem.innerHTML;
    UiText.inputCursorLast = letterIndex;

    const fontI = getViewer(itext).doc.fonts.getWordFont(itext.word);

    const fontSizeHTMLSmallCaps = itext.fontSize * fontI.smallCapsMult;

    inputElem.onbeforeinput = () => {
      const index = getInputCursorIndex();
      UiText.inputInnerHTMLLast = inputElem.innerHTML;
      UiText.inputCursorLast = index;
    };

    if (itext.word.style.smallCaps) {
      inputElem.oninput = () => {
        const index = getInputCursorIndex();
        const textContent = inputElem.textContent || '';
        inputElem.innerHTML = UiText.makeSmallCapsDivs(textContent, fontSizeHTMLSmallCaps);
        UiText.setCursor(index);
        if (itext.inputTextCallback) itext.inputTextCallback(itext);
      };
    } else {
      inputElem.oninput = () => {
        if (itext.inputTextCallback) itext.inputTextCallback(itext);
      };
    }

    UiText.inputRemove = () => {
      if (!UiText.input) return;

      let textNew = scribe.utils.ocr.replaceLigatures(UiText.input.textContent || '').trim();

      if (UiText.smartQuotes) textNew = scribe.utils.replaceSmartQuotes(textNew);

      // Words are not allowed to be empty.
      if (textNew) {
        itext.word.text = textNew;
        if (itext.changeTextCallback) itext.changeTextCallback(itext);
      }
      UiText.updateWordCanvas(itext);
      UiText.input.remove();
      UiText.input = null;
      UiText.inputRemove = null;
      UiText.inputWord = null;
      UiText.inputInnerHTMLLast = '';
      UiText.inputCursorLast = 0;
    };

    UiText.input.addEventListener('blur', () => (UiText.inputRemove));
    UiText.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && UiText.inputRemove) {
        UiText.inputRemove();
        e.preventDefault();
        e.stopPropagation();
      }
    });

    // Append into the word's per-line wrapper so the input lives in the same page (content) space and tracks scroll/zoom.
    const parent = itext.el.parentNode || document.body;
    parent.appendChild(UiText.input);

    UiText.input.focus();

    /**
     * Returns the cursor position relative to the start of the text box, including all text nodes.
     * @returns {number}
     */
    const getInputCursorIndex = () => {
      const sel = /** @type {Selection} */ (window.getSelection());
      // The anchor node may be either (1) a text node or (2) a `<span>` element that contains a text element.
      const anchor = /** @type {Node} */ (sel.anchorNode);
      let index = sel.anchorOffset;

      /**
       * @param {Node} node
       */
      const getPrevTextNode = (node) => {
        if (node.previousSibling && node.previousSibling.nodeType === 3) return node.previousSibling;

        if (node.parentNode instanceof HTMLElement) {
          if (node.parentNode.classList.contains('scribe-word')) return undefined;
        }

        const prevSibling = node.parentNode?.previousSibling;

        if (prevSibling) {
          if (prevSibling.nodeType === 3) return prevSibling;
          return prevSibling.childNodes[0];
        }

        return undefined;
      };

      let node = getPrevTextNode(anchor);
      while (node) {
        index += node.textContent?.length || 0;
        node = getPrevTextNode(node);
      }

      return index;
    };

    UiText.setCursor(letterIndex);

    // Hide the read-only word while editing so only the input shows.
    itext.hide();
  };
}

export class UiOcrWord extends UiText {
  /**
   * @param {Object} options
   * @param {number} options.visualLeft
   * @param {number} options.yActual
   * @param {number} options.topBaseline
   * @param {OcrWord} options.word
   * @param {number} options.rotation
   * @param {boolean} options.outline - Draw black outline around text.
   * @param {boolean} options.fillBox
   * @param {boolean} [options.activeMatch=false]
   * @param {boolean} options.listening
   * @param {?string} [options.highlightColor=null]
   * @param {number} [options.highlightOpacity=1]
   * @param {?string} [options.highlightGroupId=null]
   * @param {string} [options.highlightComment='']
   * @param {import('../viewer.js').ScribeViewer} [options.viewer]
   */
  constructor({
    visualLeft, yActual, topBaseline, word, rotation,
    outline, fillBox, activeMatch = false, listening, highlightColor = null, highlightOpacity = 1,
    highlightGroupId = null, highlightComment = '',
    viewer,
  }) {
    const { fill, opacity } = scribe.utils.ocr.getWordFillOpacity(word, viewer?.state.displayMode ?? 'invis',
      scribe.ScribeDoc.defaults.confThreshMed, scribe.ScribeDoc.defaults.confThreshHigh, scribe.ScribeDoc.defaults.overlayOpacity);

    super({
      x: visualLeft,
      yActual,
      word,
      rotation,
      outline,
      fillBox,
      activeMatch,
      opacity,
      fill,
      highlightColor,
      highlightOpacity,
      highlightGroupId,
      highlightComment,
      changeTextCallback: () => {},
      viewer,
    });

    this.listening(listening);

    this.lastX = this.x();
    this.lastWidth = this.width();
    this.baselineAdj = 0;
    this.topBaseline = topBaseline;
    this.topBaselineOrig = topBaseline;
  }

  /**
   * Move the word to a new line baseline, updating `topBaseline`/`yActual` and repositioning the element (setting the fields alone does not move it).
   * Used for live feedback while the baseline-adjustment slider is dragged.
   * It matches `updateWordCanvas`'s vertical math but skips the per-word character re-measure, which a baseline change does not affect.
   * @param {number} topBaseline - New line baseline in page (content) space.
   */
  setBaseline(topBaseline) {
    this.topBaseline = topBaseline;

    // Superscripts and dropcaps sit off the line baseline by a fixed offset.
    if (this.word.style.sup || this.word.style.dropcap) {
      const lineObj = this.word.line;
      this.yActual = topBaseline + (this.word.bbox.bottom - lineObj.bbox.bottom - lineObj.baseline[1]);
    } else {
      this.yActual = topBaseline;
    }

    let y = this.yActual - this.fontSize * 0.6;
    if (!this.word.visualCoords && (this.word.style.sup || this.word.style.dropcap)) {
      // `fontDescentPx` is the negated descender, so subtracting it adds the descent to the offset.
      y -= this.fontDescentPx;
    }
    this.y(y);

    // The slider moves the word vertically without going through `updateWordCanvas`,
    // so reposition any edit handles here too, keeping them on the word's edges.
    getViewer(this).repositionControls();

    if (this.highlightColor) getViewer(this).renderHighlights(this.word.line.page.n);
  }

  /**
   * Update the UI to reflect the properties of selected words.
   * This should be called when any word is selected, after adding them to the selection.
   */
  static updateUI = () => {};

  /**
   * Add controls for editing the left/right bounds of a word: a draggable handle `<div>` on each vertical edge.
   * @param {UiOcrWord} itext
   */
  static addControls = (itext) => {
    const parent = itext.getParent();
    if (!parent) throw new Error('Object must be added to a layer before drawing controls');

    const viewer = getViewer(itext);

    // White fill, blue border, and rounding make the handle read as a draggable grip rather than a flat bar.
    // It extends a little above and below the word so it stands proud of the box edge instead of blending in.
    const handleW = 8;
    const handlePad = 3;
    /**
     * @param {'left'|'right'} side
     */
    const makeHandle = (side) => {
      const handle = document.createElement('div');
      handle.className = 'scribe-word-handle';
      Object.assign(handle.style, {
        position: 'absolute',
        top: `${itext.y() - handlePad}px`,
        height: `${itext.height() + handlePad * 2}px`,
        width: `${handleW}px`,
        marginLeft: `${-handleW / 2}px`,
        boxSizing: 'border-box',
        background: '#ffffff',
        border: '1.5px solid rgba(40,123,181,1)',
        borderRadius: `${handleW / 2}px`,
        boxShadow: '0 1px 2px rgba(0,0,0,0.35)',
        cursor: 'ew-resize',
        zIndex: '3',
        touchAction: 'none',
        // The text group is `pointer-events: none`, so the handle must opt back in to receive its drags.
        pointerEvents: 'auto',
      });
      const positionHandle = () => {
        const px = side === 'left' ? itext.x() : itext.x() + itext.width();
        handle.style.left = `${px}px`;
        handle.style.top = `${itext.y() - handlePad}px`;
        handle.style.height = `${itext.height() + handlePad * 2}px`;
      };
      positionHandle();

      // Edge positions captured at pointerdown, so each move sets the dragged edge to its start plus the cumulative pointer delta.
      // Adding the delta to the live bbox instead would re-apply the running total on every event, growing the box far beyond the pointer movement.
      let startX = 0;
      let startLeft = 0;
      let startBboxLeft = 0;
      let startBboxRight = 0;

      /** @param {PointerEvent} e */
      const onMove = (e) => {
        const delta = (e.clientX - startX) / (viewer.zoomLevel || 1);
        if (side === 'left') {
          // Keep the dragged left edge at least 7px short of the fixed right edge.
          const newBboxLeft = Math.min(startBboxLeft + delta, startBboxRight - 7);
          itext.word.bbox.left = newBboxLeft;
          itext.x(startLeft + (newBboxLeft - startBboxLeft));
        } else {
          // Keep the dragged right edge at least 7px past the fixed left edge.
          itext.word.bbox.right = Math.max(startBboxRight + delta, startBboxLeft + 7);
        }
        // `updateWordCanvas` re-derives the element width from the bbox, so width is not set directly here.
        UiText.updateWordCanvas(itext);
        positionHandle();
      };

      /** @param {PointerEvent} e */
      const onUp = (e) => {
        handle.releasePointerCapture(e.pointerId);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
      };

      /** @param {PointerEvent} e */
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        startX = e.clientX;
        startLeft = itext.x();
        startBboxLeft = itext.word.bbox.left;
        startBboxRight = itext.word.bbox.right;
        handle.setPointerCapture(e.pointerId);
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
      });

      /** @type {any} */ (handle).destroy = () => { if (handle.parentNode) handle.parentNode.removeChild(handle); };
      /** @type {any} */ (handle).reposition = positionHandle;
      return handle;
    };

    const leftHandle = makeHandle('left');
    const rightHandle = makeHandle('right');
    parent.appendChild(leftHandle);
    parent.appendChild(rightHandle);

    viewer._controlArr.push(/** @type {any} */ (leftHandle));
    viewer._controlArr.push(/** @type {any} */ (rightHandle));
  };
}
