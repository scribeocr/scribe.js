/* eslint-disable import/no-cycle */
import scribe from '../../scribe.js';
import { UiDataColumn, UiRegion } from './viewerLayout.js';
import { handleKeyboardEvent } from './viewerShortcuts.js';

let layerStyleSheetInjected = false;
/** Inject the one-time stylesheet whose `.scribe-hide-*-layer` root classes hide a viewer's text, overlay, or image layer. */
export function ensureLayerStyleSheet() {
  if (layerStyleSheetInjected || typeof document === 'undefined') return;
  layerStyleSheetInjected = true;
  const styleEl = document.createElement('style');
  styleEl.textContent = '.scribe-hide-text-layer .scribe-layer-text{display:none}'
    + '.scribe-hide-overlay-layer .scribe-layer-overlay{display:none}'
    + '.scribe-hide-image-layer .scribe-layer-image{display:none!important}';
  document.head.appendChild(styleEl);
}

/** Per-viewer transient UI state (page index, options). */
export class ScribeViewerState {
  constructor() {
    this.recognizeAllPromise = Promise.resolve();
    this.layoutMode = false;
    this.searchMode = false;
    /** @type {'color'|'gray'|'binary'} */
    this.colorMode = 'color';
    /**
     * @type {'invis'|'ebook'|'eval'|'proof'|'annot'}
     */
    this.displayMode = 'invis';
    this.cp = { n: 0 };
  }
}

export class ScribeViewerOpts {
  constructor() {
    this.enableRecognition = true;
    /** Whether the page-thumbnails panel shows per-page edit controls (delete / drag-reorder). Editor-only. */
    this.enablePageEditing = false;
    this.enableXlsxExport = false;
    this.downloadFormat = 'pdf';
    this.vanillaMode = false;
    this.langs = ['eng'];
    /** @type {'conf'|'data'} */
    this.combineMode = 'data';
    /**
     * Whether to show the intermediate, internal versions of OCR.
     * Useful for debugging.
     * Should not be enabled by default.
     */
    this.showInternalOCRVersions = false;
    this.outlineWords = false;
    this.outlineLines = false;
    this.outlinePars = false;
    /**
     * Scope of this viewer's document-level keyboard shortcuts.
     * - `'focused'` (default): handle a keystroke only when the event originates inside this viewer,
     *   or when this viewer is the active one and focus is on the bare document body.
     *   Safe for embedding beside host UI and for several independent viewers on one page.
     * - `'global'`: handle keystrokes anywhere on the page whenever this viewer is the active (or only) viewer.
     *   This is the full-screen single-viewer app behavior, for when the viewer owns the page.
     * - `'off'`: never handle document-level keystrokes.
     * @type {'focused'|'global'|'off'}
     */
    this.keyboardScope = 'focused';
    /**
     * Panning model.
     * - `false` (default): the document stays clamped so it fills or centers in the viewport,
     *   never scrolling past its own edges (a document-centric, word-processor feel). This is what the basic viewer wants.
     * - `true`: blank space is added around the document so a page can be dragged past the viewport edges,
     *   for the free canvas movement of an image editor. Editors embedding the viewer typically want this.
     */
    this.freePan = false;
  }
}

/** Per-viewer canvas selection state (selected words, regions, data columns). */
export class CanvasSelection {
  /**
   * @param {import('../viewer.js').ScribeViewer} viewer
   */
  constructor(viewer) {
    this.viewer = viewer;
    /** @type {Array<import('./viewerWordObjects.js').UiOcrWord>} */
    this._selectedWordArr = [];
    /** @type {?import('./viewerWordObjects.js').UiOcrWord} */
    this.selectedWordFirst = null;
    /** @type {Array<UiRegion>} */
    this._selectedRegionArr = [];
    /** @type {Array<UiDataColumn>} */
    this._selectedDataColumnArr = [];
  }

  getUiWords() { return this._selectedWordArr; }

  getUiRegions() { return this._selectedRegionArr; }

  getUiDataColumns() { return this._selectedDataColumnArr; }

  getUiWordsCopy() { return this._selectedWordArr.slice(); }

  getUiRegionsCopy() { return this._selectedRegionArr.slice(); }

  getUiDataColumnsCopy() { return this._selectedDataColumnArr.slice(); }

  getUiLayoutBoxes() { return [...this._selectedRegionArr, ...this._selectedDataColumnArr]; }

  getDataTables() { return [...new Set(this._selectedDataColumnArr.map((x) => x.layoutBox.table))]; }

  getUiDataTables() { return [...new Set(this._selectedDataColumnArr.map((x) => x.uiTable))]; }

  /**
   * Add word or array of words to the current selection.
   * Ignores words that are already selected.
   * @param {import('./viewerWordObjects.js').UiOcrWord|Array<import('./viewerWordObjects.js').UiOcrWord>} words
   */
  addWords(words) {
    if (!Array.isArray(words)) words = [words];
    for (let i = 0; i < words.length; i++) {
      const wordI = words[i];
      if (i === 0 && this._selectedWordArr.length === 0) this.selectedWordFirst = wordI;
      if (!this._selectedWordArr.map((x) => x.word.id).includes(wordI.word.id)) {
        this._selectedWordArr.push(wordI);
      }
    }
  }

  /**
   * Add layout boxes, including both regions and data columns, to the current selection.
   * Ignores boxes that are already selected.
   * @param {Array<UiRegion|UiDataColumn>|UiRegion|UiDataColumn} uiLayoutBoxes
   */
  addUiLayoutBoxes(uiLayoutBoxes) {
    let uiLayoutBoxesArr;
    if (uiLayoutBoxes instanceof UiRegion || uiLayoutBoxes instanceof UiDataColumn) {
      uiLayoutBoxesArr = [uiLayoutBoxes];
    } else {
      uiLayoutBoxesArr = uiLayoutBoxes;
    }
    uiLayoutBoxesArr.forEach((uiLayoutBox) => {
      if (uiLayoutBox instanceof UiDataColumn) {
        if (!this._selectedDataColumnArr.map((x) => x.layoutBox.id).includes(uiLayoutBox.layoutBox.id)) {
          this._selectedDataColumnArr.push(uiLayoutBox);
        }
      } else if (!this._selectedRegionArr.map((x) => x.layoutBox.id).includes(uiLayoutBox.layoutBox.id)) {
        this._selectedRegionArr.push(uiLayoutBox);
      }
    });
    this._selectedDataColumnArr.sort((a, b) => a.layoutBox.coords.left - b.layoutBox.coords.left);
    this._selectedRegionArr.sort((a, b) => a.layoutBox.coords.left - b.layoutBox.coords.left);
  }

  /** @param {Array<string>} layoutBoxIdArr */
  selectLayoutBoxesById(layoutBoxIdArr) {
    const uiLayoutBoxes = this.viewer.getUiRegions().filter((x) => layoutBoxIdArr.includes(x.layoutBox.id));
    const uiDataColumns = this.viewer.getUiDataColumns().filter((x) => layoutBoxIdArr.includes(x.layoutBox.id));
    this.selectLayoutBoxes([...uiLayoutBoxes, ...uiDataColumns]);
  }

  /** @param {Array<UiRegion|UiDataColumn>} uiLayoutBoxes */
  selectLayoutBoxes(uiLayoutBoxes) {
    const selectedLayoutBoxes = this.getUiRegions();
    const selectedDataColumns = this.getUiDataColumns();

    this.addUiLayoutBoxes(uiLayoutBoxes);

    selectedDataColumns.forEach((shape) => (shape.select()));
    selectedLayoutBoxes.forEach((shape) => (shape.select()));
  }

  /** Get arrays of distinct font families and font sizes from the selected words. */
  getWordProperties() {
    const fontFamilyArr = Array.from(new Set(this._selectedWordArr.map((x) => (x.fontFamilyLookup))));
    const fontSizeArr = Array.from(new Set(this._selectedWordArr.map((x) => (x.fontSize))));
    return { fontFamilyArr, fontSizeArr };
  }

  /**
   * Get arrays of distinct layout box properties from the selected layout boxes.
   * Includes both layout boxes and data columns.
   */
  getLayoutBoxProperties() {
    const selectedWordsAll = this.getUiLayoutBoxes();
    const inclusionRuleArr = Array.from(new Set(selectedWordsAll.map((x) => (x.layoutBox.inclusionRule))));
    const inclusionLevelArr = Array.from(new Set(selectedWordsAll.map((x) => (x.layoutBox.inclusionLevel))));
    return { inclusionRuleArr, inclusionLevelArr };
  }

  /** @param {number} [n] */
  deselectAllWords(n) {
    for (let i = this._selectedWordArr.length - 1; i >= 0; i--) {
      if (n === null || n === undefined || this._selectedWordArr[i].word.line.page.n === n) {
        this._selectedWordArr[i].deselect();
        this._selectedWordArr.splice(i, 1);
      }
    }

    if (this.selectedWordFirst && (n === null || n === undefined)) {
      this.selectedWordFirst = null;
    } else if (this.selectedWordFirst && this.selectedWordFirst.word.line.page.n === n) {
      this.selectedWordFirst = this._selectedWordArr[0] || null;
    }
  }

  deselectAllRegions() {
    this._selectedRegionArr.forEach((shape) => (shape.deselect()));
    this._selectedRegionArr.length = 0;
  }

  deselectAllDataColumns() {
    this._selectedDataColumnArr.forEach((shape) => (shape.deselect()));
    this._selectedDataColumnArr.length = 0;
  }

  deselectAll() {
    this.deselectAllWords();
    this.deselectAllRegions();
    this.deselectAllDataColumns();
  }

  /** @param {string|Array<string>} ids */
  deselectDataColumnsByIds(ids) {
    if (!Array.isArray(ids)) ids = [ids];
    for (let j = 0; j < this._selectedDataColumnArr.length; j++) {
      if (ids.includes(this._selectedDataColumnArr[j].layoutBox.id)) {
        this._selectedDataColumnArr.splice(j, 1);
        j--;
      }
    }
  }
}

/** Registry of all live viewer instances. Used to route document-level events to the right viewer. */
const _allViewers = new Set();

// Tracks the most recently interacted-with viewer.
// Keyboard shortcuts fire at the document level (no spatial target), so they route to this viewer.
/** @type {?import('../viewer.js').ScribeViewer} */
let _activeViewer = null;

/** @type {?import('../viewer.js').ScribeViewer} */
let _defaultViewer = null;

/** @returns {Set<import('../viewer.js').ScribeViewer>} */
export const getAllViewers = () => _allViewers;

/** @returns {?import('../viewer.js').ScribeViewer} */
export const getActiveViewer = () => _activeViewer;

/** @param {?import('../viewer.js').ScribeViewer} v */
export const setActiveViewer = (v) => { _activeViewer = v; };

/** @returns {?import('../viewer.js').ScribeViewer} */
export const getDefaultViewer = () => _defaultViewer;

/** @param {?import('../viewer.js').ScribeViewer} v */
export const setDefaultViewer = (v) => { _defaultViewer = v; };

/**
 * Register a newly constructed viewer, making it the default if none exists yet.
 * @param {import('../viewer.js').ScribeViewer} v
 */
export const registerViewer = (v) => {
  _allViewers.add(v);
  if (!_defaultViewer) _defaultViewer = v;
};

/**
 * Remove a destroyed viewer from the registry, clearing it as the active/default viewer if it held either role.
 * @param {import('../viewer.js').ScribeViewer} v
 */
export const unregisterViewer = (v) => {
  _allViewers.delete(v);
  if (_defaultViewer === v) _defaultViewer = null;
  if (_activeViewer === v) _activeViewer = null;
};

/**
 * Find the viewer whose element contains the given DOM node.
 * Used by document-level event listeners to route events to the right viewer.
 * @param {Node} target
 * @returns {?import('../viewer.js').ScribeViewer}
 */
export function findViewerForTarget(target) {
  for (const v of _allViewers) {
    if (v.elem && v.elem.contains(target)) return v;
  }
  return null;
}

// Document-level event listeners.
// These fire at the document level (not per-viewer) because the canvas may be obscured by HTML
// overlay text. We dispatch each event to the viewer whose element contains the target.

document.addEventListener('mouseup', () => {
  for (const v of _allViewers) {
    v.stopAutoScroll();
    if (v.enableHTMLOverlay && v.HTMLOverlayBackstopElem) {
      v.HTMLOverlayBackstopElem.style.display = 'none';
    }
  }
});

// Track the cursor at the document level while autoscrolling.
document.addEventListener('mousemove', (event) => {
  for (const v of _allViewers) {
    if (v.autoScroll.active) {
      v.autoScroll.pointerX = event.clientX;
      v.autoScroll.pointerY = event.clientY;
    }
  }
});

// If the window loses focus while the middle button is held, the mouseup never arrives.
window.addEventListener('blur', () => {
  for (const v of _allViewers) v.stopAutoScroll();
});

// The pointer can also leave the window without the window losing focus, e.g. the middle button is released outside it.
// Then neither a mouseup nor a blur fires, so the session would otherwise linger: a stuck indicator, plus the rAF tick scrolling on at its last speed.
// relatedTarget is null only when the pointer leaves the document entirely.
document.addEventListener('mouseout', (event) => {
  if (event.relatedTarget === null) {
    for (const v of _allViewers) v.stopAutoScroll();
  }
});

document.addEventListener('touchend', () => {
  for (const v of _allViewers) {
    if (v.enableHTMLOverlay && v.HTMLOverlayBackstopElem) {
      v.HTMLOverlayBackstopElem.style.display = 'none';
    }
  }
});

const _routeSelectionEvent = (event) => {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const focusNode = selection.focusNode;
  if (!focusNode) return;
  const target = focusNode.nodeType === Node.ELEMENT_NODE ? focusNode : focusNode.parentNode;
  if (!target) return;
  const v = findViewerForTarget(target);
  if (v) v._onSelection(event);
};

document.addEventListener('selectionchange', _routeSelectionEvent);
document.addEventListener('mousedown', _routeSelectionEvent);

// Triple-click should select the whole line.
// The words are absolutely-positioned spans, so the browser's native paragraph selection does not pick up the `.scribe-line` wrapper.
// Select it explicitly on the final `click` of the gesture (after which no mouseup/click can collapse the selection again).
document.addEventListener('click', (event) => {
  if (event.detail < 3 || event.button !== 0) return;
  const target = /** @type {any} */ (event.target);
  const lineElem = target?.closest?.('.scribe-word')?.closest('.scribe-line');
  if (!lineElem || !findViewerForTarget(lineElem)) return;
  const sel = document.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(lineElem);
  sel.removeAllRanges();
  sel.addRange(range);
});

function getElementIdsInRange(range) {
  const elementIds = [];
  // Non-word elements return FILTER_SKIP, not FILTER_REJECT, so the walker descends into the per-line `.scribe-line` wrappers to reach the word spans.
  // A multi-line selection's common ancestor is the overlay root, whose direct children are those line divs.
  const selRects = [...range.getClientRects()];
  // A word is selected when its centre lies inside a selection rect, which keeps the copied set aligned with the highlight:
  // it excludes a horizontally adjacent word touched only at the boundary, and the next line whose rect overlaps by a few pixels.
  const selected = (r) => {
    const cx = (r.left + r.right) / 2;
    const cy = (r.top + r.bottom) / 2;
    return selRects.some((s) => cx >= s.left && cx <= s.right && cy >= s.top && cy <= s.bottom);
  };
  const treeWalker = document.createTreeWalker(
    range.commonAncestorContainer,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        if (node instanceof HTMLElement && node.classList && node.classList.contains('scribe-word')) {
          return selected(node.getBoundingClientRect()) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_SKIP;
      },
    },
  );

  while (treeWalker.nextNode()) {
    const node = treeWalker.currentNode;
    if (node instanceof HTMLElement && node.id) {
      elementIds.push(node.id);
    }
  }

  return elementIds;
}

document.addEventListener('copy', (e) => {
  const sel = /** @type {Selection} */ (window.getSelection());
  const clipboardData = e.clipboardData;

  if (sel.rangeCount === 0 || !clipboardData) return;

  const range = sel.getRangeAt(0);

  const ids = getElementIdsInRange(range);

  if (ids.length === 0) return;

  // Route to the viewer that owns the selection's anchor.
  const anchorNode = sel.anchorNode;
  if (!anchorNode) return;
  const anchorTarget = anchorNode.nodeType === Node.ELEMENT_NODE ? anchorNode : anchorNode.parentNode;
  if (!anchorTarget) return;
  const v = findViewerForTarget(anchorTarget);
  if (!v) return;

  v.textGroupsRenderIndices.sort((a, b) => a - b);

  // writeText prefixes every line with '\n'. Trim each page's output and drop pages with no selected words,
  // so the clipboard text has no stray leading or trailing blank lines.
  const pageTexts = [];
  for (const n of v.textGroupsRenderIndices) {
    const pageText = scribe.utils.writeText({
      ocrCurrent: v.doc.ocr.active,
      pageArr: [n],
      wordIds: ids,
    }).trim();
    if (pageText) pageTexts.push(pageText);
  }
  const text = pageTexts.join('\n\n');

  if (!text) return;

  clipboardData.setData('text/plain', text);
  e.preventDefault();
});

/**
 * Track-pad detection heuristic for wheel events.
 * @param {WheelEvent} event
 */
const checkTrackPad = (event) => {
  if ([100, 120].includes(event.deltaY)) return false;
  if ([100, 120].includes(Math.abs(Math.round(event.deltaY * window.devicePixelRatio * 1e5) / 1e5))) return false;
  if (Math.round(event.deltaY) === event.deltaY) return false;
  return true;
};

/**
 * Handle a wheel event for a specific viewer (zoom, pan, or scroll).
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {WheelEvent} event
 */
const handleWheel = (viewer, event) => {
  event.preventDefault();
  event.stopPropagation();

  if (event.ctrlKey) {
    const trackPadMode = checkTrackPad(event);

    let delta = event.deltaY;
    if (event.deltaMode === 1) delta *= 10;

    if (trackPadMode) {
      delta *= 7;
      delta = Math.min(600, Math.max(-720, delta));
    }

    let scaleBy = 0.999 ** delta;
    if (scaleBy > 1.1) scaleBy = 1.1;
    if (scaleBy < 0.9) scaleBy = 0.9;

    viewer._zoomStage(scaleBy, { x: event.clientX, y: event.clientY });
    viewer.destroyControls();
  } else if (event.shiftKey) {
    viewer.destroyControls();
    const deltaX = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX * -1 : event.deltaY * -1;
    viewer.pan({ deltaX });
  } else {
    viewer.destroyControls();
    viewer.pan({ deltaY: event.deltaY * -1, deltaX: event.deltaX * -1 });
  }
};

document.addEventListener('wheel', (event) => {
  if (!(event.target instanceof Node)) return;
  const v = findViewerForTarget(event.target);
  if (v && v.doc.pageMetrics.length > 0) handleWheel(v, event);
}, { passive: false });

document.addEventListener('mousedown', (event) => {
  if (!(event.target instanceof Node)) return;
  const v = findViewerForTarget(event.target);
  if (v) {
    // Interacting with a viewer makes it the active one (the target of body-level keystrokes).
    _activeViewer = v;
    if (v.doc.pageMetrics.length > 0 && event.button === 1) {
      if (v.state.displayMode === 'invis') v.startAutoScroll(event);
      else v.startDrag(event);
    }
    return;
  }
  // The click landed outside every viewer canvas.
  // A `'focused'`-scope viewer stops claiming body-level keystrokes unless the click landed on its own controls (toolbar, etc.).
  // A `'global'`-scope viewer keeps the page, matching a full-screen app.
  if (_activeViewer && _activeViewer.opt.keyboardScope === 'focused') {
    const outer = _activeViewer.outerElem;
    if (!(outer instanceof HTMLElement && outer.contains(event.target))) _activeViewer = null;
  }
});

document.addEventListener('keydown', (event) => {
  if (!(event.target instanceof Node)) return;
  const targetViewer = findViewerForTarget(event.target);
  if (targetViewer) {
    // The keystroke originates inside a viewer: that viewer owns it (unless shortcuts are off).
    if (targetViewer.opt.keyboardScope !== 'off') handleKeyboardEvent(targetViewer, event);
    return;
  }
  // The keystroke originates outside every viewer. A focused host control such as an input or button must never be hijacked,
  // so only the bare document body (meaning nothing in particular is focused) may route to a viewer.
  if (event.target !== document.body && event.target !== document.documentElement) return;
  const v = _activeViewer || _defaultViewer;
  if (!v) return;
  // `'global'`: claim body-level keystrokes whenever this is the active or only viewer (full-screen app).
  // `'focused'`: only the actively-interacted viewer claims them, e.g. arrow-key word navigation right after clicking the canvas.
  // `_activeViewer` is cleared on mousedown elsewhere.
  if (v.opt.keyboardScope === 'global' || (v.opt.keyboardScope === 'focused' && v === _activeViewer)) {
    handleKeyboardEvent(v, event);
  }
});
