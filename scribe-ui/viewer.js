/* eslint-disable import/no-cycle */
import scribe from '../scribe.js';
import Konva from './js/konva/index.js';
import { search } from './js/viewerSearch.js';
import {
  KonvaDataColumn, KonvaLayout, KonvaRegion, layout,
} from './js/viewerLayout.js';
import { clearObjectProperties } from '../js/utils/miscUtils.js';
import { KonvaIText, KonvaOcrWord } from './js/viewerWordObjects.js';
import { ViewerImageCache } from './js/viewerImageCache.js';
import { handleKeyboardEvent } from './js/viewerShortcuts.js';
import { contextMenuFunc, mouseupFunc2 } from './js/viewerCanvasInteraction.js';
import {
  deleteSelectedWord, modifySelectedWordBbox, modifySelectedWordStyle,
} from './js/viewerModifySelectedWords.js';
import { getAllFileEntries } from './js/dragAndDrop.js';
import { deleteSelectedLayoutDataTable, deleteSelectedLayoutRegion } from './js/viewerModifySelectedLayout.js';
import {
  applyHighlight, removeHighlight, modifyHighlightComment, updateHighlightGroupOutline,
} from './js/viewerHighlights.js';

Konva.autoDrawEnabled = false;
Konva.dragButtons = [0];

/** Per-viewer transient UI state (page index, options). */
class ScribeViewerState {
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

/**
 * Per-viewer GUI options.
 * GUI-specific options and options that are implemented through arguments rather than the `opts` object.
 */
class ScribeViewerOpts {
  constructor() {
    this.enableRecognition = true;
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
  }
}

/** Per-viewer canvas selection state (selected words, regions, data columns). */
class CanvasSelection {
  /**
   * @param {ScribeViewer} viewer
   */
  constructor(viewer) {
    this.viewer = viewer;
    /** @type {Array<KonvaOcrWord>} */
    this._selectedWordArr = [];
    /** @type {?KonvaOcrWord} */
    this.selectedWordFirst = null;
    /** @type {Array<KonvaRegion>} */
    this._selectedRegionArr = [];
    /** @type {Array<KonvaDataColumn>} */
    this._selectedDataColumnArr = [];
  }

  getKonvaWords() { return this._selectedWordArr; }

  getKonvaRegions() { return this._selectedRegionArr; }

  getKonvaDataColumns() { return this._selectedDataColumnArr; }

  getKonvaWordsCopy() { return this._selectedWordArr.slice(); }

  getKonvaRegionsCopy() { return this._selectedRegionArr.slice(); }

  getKonvaDataColumnsCopy() { return this._selectedDataColumnArr.slice(); }

  getKonvaLayoutBoxes() { return [...this._selectedRegionArr, ...this._selectedDataColumnArr]; }

  getDataTables() { return [...new Set(this._selectedDataColumnArr.map((x) => x.layoutBox.table))]; }

  getKonvaDataTables() { return [...new Set(this._selectedDataColumnArr.map((x) => x.konvaTable))]; }

  /**
   * Add word or array of words to the current selection.
   * Ignores words that are already selected.
   * @param {KonvaOcrWord|Array<KonvaOcrWord>} words
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
   * @param {Array<KonvaRegion|KonvaDataColumn>|KonvaRegion|KonvaDataColumn} konvaLayoutBoxes
   */
  addKonvaLayoutBoxes(konvaLayoutBoxes) {
    let konvaLayoutBoxesArr;
    if (konvaLayoutBoxes instanceof KonvaRegion || konvaLayoutBoxes instanceof KonvaDataColumn) {
      konvaLayoutBoxesArr = [konvaLayoutBoxes];
    } else {
      konvaLayoutBoxesArr = konvaLayoutBoxes;
    }
    konvaLayoutBoxesArr.forEach((konvaLayoutBox) => {
      if (konvaLayoutBox instanceof KonvaDataColumn) {
        if (!this._selectedDataColumnArr.map((x) => x.layoutBox.id).includes(konvaLayoutBox.layoutBox.id)) {
          this._selectedDataColumnArr.push(konvaLayoutBox);
        }
      } else if (!this._selectedRegionArr.map((x) => x.layoutBox.id).includes(konvaLayoutBox.layoutBox.id)) {
        this._selectedRegionArr.push(konvaLayoutBox);
      }
    });
    this._selectedDataColumnArr.sort((a, b) => a.layoutBox.coords.left - b.layoutBox.coords.left);
    this._selectedRegionArr.sort((a, b) => a.layoutBox.coords.left - b.layoutBox.coords.left);
  }

  /** @param {Array<string>} layoutBoxIdArr */
  selectLayoutBoxesById(layoutBoxIdArr) {
    const konvaLayoutBoxes = this.viewer.getKonvaRegions().filter((x) => layoutBoxIdArr.includes(x.layoutBox.id));
    const konvaDataColumns = this.viewer.getKonvaDataColumns().filter((x) => layoutBoxIdArr.includes(x.layoutBox.id));
    this.selectLayoutBoxes([...konvaLayoutBoxes, ...konvaDataColumns]);
  }

  /** @param {Array<KonvaRegion|KonvaDataColumn>} konvaLayoutBoxes */
  selectLayoutBoxes(konvaLayoutBoxes) {
    const selectedLayoutBoxes = this.getKonvaRegions();
    const selectedDataColumns = this.getKonvaDataColumns();

    this.addKonvaLayoutBoxes(konvaLayoutBoxes);

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
    const selectedWordsAll = this.getKonvaLayoutBoxes();
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

function getCenter(p1, p2) {
  return {
    x: (p1.x + p2.x) / 2,
    y: (p1.y + p2.y) / 2,
  };
}

function getDistance(p1, p2) {
  return Math.sqrt((p2.x - p1.x) ** 2 + (p2.y - p1.y) ** 2);
}

/**
 * @typedef {import('./js/konva/Node.js').KonvaEventObject<MouseEvent>} KonvaMouseEvent
 * @typedef {import('./js/konva/Node.js').KonvaEventObject<TouchEvent>} KonvaTouchEvent
 * @typedef {import('./js/konva/Node.js').KonvaEventObject<WheelEvent>} KonvaWheelEvent
 */

/** Registry of all live viewer instances. Used to route document-level events to the right viewer. */
const _allViewers = new Set();

// Tracks the most recently interacted-with viewer.
// Keyboard shortcuts fire at the document level (no spatial target), so they route to this viewer.
/** @type {?ScribeViewer} */
let _activeViewer = null;

/**
 * Per-viewer canvas controller. Owns its own Konva stage, document, selection, and event state.
 * Multiple instances can coexist on the same page. Each operates independently.
 *
 * For backward compatibility, the existing static `ScribeViewer.X` API is preserved as a facade.
 * It delegates to a default instance (the first one constructed, created lazily on first access).
 * Single-viewer applications can continue to use the static API unchanged.
 */
export class ScribeViewer {
  constructor() {
    this.state = new ScribeViewerState();
    this.opt = new ScribeViewerOpts();
    this.CanvasSelection = new CanvasSelection(this);
    this.imageCache = new ViewerImageCache(this);
    /** @type {import('../js/containers/scribeDoc.js').ScribeDoc} */
    this._doc = new scribe.ScribeDoc();

    /** @type {HTMLElement} */
    this.elem = /** @type {any} */ (null);
    /**
     * The outer element of the UI component that owns this viewer
     * (e.g. a wrapper that also contains a toolbar), if any.
     * Used to decide whether a click landed on the viewer's own chrome when managing keyboard focus.
     * Defaults to `elem` when unset.
     * @type {?HTMLElement}
     */
    this.outerElem = null;
    /** @type {HTMLDivElement} */
    this.HTMLOverlayBackstopElem = /** @type {any} */ (null);

    this.textOverlayHidden = false;

    /** @type {Array<number>} */
    this._pageStopsStart = [];
    /** @type {Array<number>} */
    this._pageStopsEnd = [];

    /** @type {?Function} */
    this.displayPageCallback = null;

    /** @type {Array<InstanceType<typeof Konva.Rect>>} */
    this.placeholderRectArr = [];

    /** @type {InstanceType<typeof Konva.Stage>} */
    this.stage = /** @type {any} */ (null);
    /** @type {InstanceType<typeof Konva.Layer>} */
    this.layerBackground = /** @type {any} */ (null);
    /** @type {InstanceType<typeof Konva.Layer>} */
    this.layerText = /** @type {any} */ (null);
    /** @type {InstanceType<typeof Konva.Layer>} */
    this.layerOverlay = /** @type {any} */ (null);

    /** @type {Array<Object<string, InstanceType<typeof Konva.Group>>>} */
    this._textGroups = [];
    /** @type {Array<InstanceType<typeof Konva.Group>>} */
    this._overlayGroups = [];
    /** @type {Array<number>} */
    this.textGroupsRenderIndices = [];
    /** @type {Array<number>} */
    this.overlayGroupsRenderIndices = [];

    /** @type {InstanceType<typeof Konva.Rect>} */
    this.selectingRectangle = /** @type {any} */ (null);

    /** @type {?KonvaOcrWord} */
    this.contextMenuWord = null;

    /** @type {Array<HTMLSpanElement>} */
    this._wordHTMLArr = [];
    /** @type {Array<HTMLDivElement>} */
    this._lineHTMLArr = [];

    /**
     * Contains the x and y coordinates of the last right-click event.
     * Required for "right click" functions that are position-dependent,
     * as the cursor moves between the initial right click and selecting the option.
     */
    this.contextMenuPointer = { x: 0, y: 0 };

    this.selecting = false;
    this.enableCanvasSelection = false;
    this.enableHTMLOverlay = false;

    /** @type {bbox} */
    this.bbox = {
      top: 0, left: 0, right: 0, bottom: 0,
    };

    /** @type {('select'|'addWord'|'recognizeWord'|'recognizeArea'|'printCoords'|'addLayoutBoxOrder'|'addLayoutBoxExclude'|'addLayoutBoxDataTable')} */
    this.mode = 'select';

    this.drag = {
      isPinching: false,
      isDragging: false,
      isResizingColumns: false,
      dragDeltaTotal: 0,
      lastX: 0,
      lastY: 0,
      /** @type {?{x: number, y: number}} */
      lastCenter: null,
      /** @type {?number} */
      lastDist: null,
    };

    this.runSetInitial = true;

    /** Per-instance controls array (transformers/handles for the currently selected word). */
    /** @type {Array<any>} */
    this._controlArr = [];

    /** @type {Array<InstanceType<typeof Konva.Rect>>} */
    this._highlightOutlineRects = [];

    this._searchState = {
      /** @type {string[]} */
      text: [],
      search: '',
      /** @type {number[]} */
      matches: [],
      init: false,
      total: 0,
    };

    this.evalStats = [];
    this._evalStatsConfig = {
      /** @type {string|undefined} */
      ocrActive: undefined,
      ignorePunct: scribe.ScribeDoc.defaults.ignorePunct,
      ignoreCap: scribe.ScribeDoc.defaults.ignoreCap,
    };

    /** @type {?Range} */
    this._prevRange = null;
    this._prevStart = null;
    this._prevEnd = null;

    this._renderHTMLOverlayEvents = 0;

    /** @type {?import('./js/konva/Node.js').Node} */
    this._mouseDownTarget = null;

    /** @param {*} event */
    this.interactionCallback = (event) => {};
    /** @param {boolean} deselect */
    // eslint-disable-next-line no-unused-vars
    this.destroyControlsCallback = (deselect) => {};

    _allViewers.add(this);
    if (!_defaultViewer) _defaultViewer = this;
  }

  /** @returns {import('../js/containers/scribeDoc.js').ScribeDoc} */
  get doc() { return this._doc; }

  set doc(value) {
    const prev = this._doc;
    this._doc = value;
    if (prev && prev !== value && this.stage) this._resetDocState();
  }

  _resetDocState() {
    this.deleteHTMLOverlay();
    this.destroyControls();

    for (const groupMap of this._textGroups) {
      if (!groupMap) continue;
      for (const group of Object.values(groupMap)) group.destroy();
    }
    this._textGroups.length = 0;
    this.textGroupsRenderIndices.length = 0;

    for (const group of this._overlayGroups) {
      if (group) group.destroy();
    }
    this._overlayGroups.length = 0;
    this.overlayGroupsRenderIndices.length = 0;

    for (const rect of this.placeholderRectArr) {
      if (rect) rect.destroy();
    }
    this.placeholderRectArr.length = 0;

    this._highlightOutlineRects.length = 0;

    this._pageStopsStart.length = 0;
    this._pageStopsEnd.length = 0;

    this.imageCache.clear();

    this.evalStats.length = 0;
    this._evalStatsConfig = {
      ocrActive: undefined,
      ignorePunct: scribe.ScribeDoc.defaults.ignorePunct,
      ignoreCap: scribe.ScribeDoc.defaults.ignoreCap,
    };

    this._searchState = {
      text: [], search: '', matches: [], init: false, total: 0,
    };

    this.state.cp.n = 0;
    this.state.searchMode = false;
  }

  /**
   * @param {number} n
   * @param {boolean} [start=true]
   * @returns {number}
   */
  getPageStop(n, start = true) {
    if (start && n === 0) return 30;

    if (start && this._pageStopsStart[n]) return this._pageStopsStart[n];
    if (!start && this._pageStopsEnd[n]) return this._pageStopsEnd[n];

    this.calcPageStops();

    if (start && this._pageStopsStart[n]) return this._pageStopsStart[n];
    if (!start && this._pageStopsEnd[n]) return this._pageStopsEnd[n];

    // @ts-ignore
    return null;
  }

  calcPageStops() {
    const margin = 30;
    let y = margin;
    for (let i = 0; i < this.doc.pageMetrics.length; i++) {
      this._pageStopsStart[i] = y;
      const dims = this.doc.pageMetrics[i]?.dims;
      if (!dims) return;

      const rotation = (this.doc.pageMetrics[i].angle || 0) * -1;
      y += dims.height + margin;
      this._pageStopsEnd[i] = y;

      if (!this.placeholderRectArr[i]) {
        this.placeholderRectArr[i] = new Konva.Rect({
          x: 0,
          y: this.getPageStop(i),
          width: dims.width,
          height: dims.height,
          stroke: 'black',
          strokeWidth: 2,
          strokeScaleEnabled: false,
          listening: false,
          rotation,
        });
        this.layerBackground.add(this.placeholderRectArr[i]);
      }
    }
  }

  /** @returns {{x: number, y: number}} */
  getStageCenter() {
    const layerWidth = this.stage.width();
    const layerHeight = this.stage.height();
    return { x: layerWidth / 2, y: layerHeight / 2 };
  }

  /**
   * @param {InstanceType<typeof Konva.Layer>|InstanceType<typeof Konva.Stage>} layer
   * @param {number} scaleBy
   * @param {{x: number, y: number}} center
   */
  // eslint-disable-next-line class-methods-use-this
  _zoomStageImp(layer, scaleBy, center) {
    const oldScale = layer.scaleX();

    const mousePointTo = {
      x: (center.x - layer.x()) / oldScale,
      y: (center.y - layer.y()) / oldScale,
    };

    const newScale = oldScale * scaleBy;

    layer.scaleX(newScale);
    layer.scaleY(newScale);

    layer.position({
      x: center.x - mousePointTo.x * newScale,
      y: center.y - mousePointTo.y * newScale,
    });
  }

  /**
   * @param {number} scaleBy
   * @param {?{x: number, y: number}} [center=null]
   */
  _zoomStage(scaleBy, center = null) {
    if (!center) {
      const selectedWords = this.CanvasSelection.getKonvaWords();

      if (selectedWords.length > 0) {
        const selectionLeft = Math.min(...selectedWords.map((x) => x.x()));
        const selectionRight = Math.max(...selectedWords.map((x) => x.x() + x.width()));
        const selectionTop = Math.min(...selectedWords.map((x) => x.y()));
        const selectionBottom = Math.max(...selectedWords.map((x) => x.y() + x.height()));
        const center0 = { x: (selectionLeft + selectionRight) / 2, y: (selectionTop + selectionBottom) / 2 };

        const transform = this.layerText.getAbsoluteTransform();
        center = transform.point(center0);
      } else {
        center = this.getStageCenter();
      }
    }

    this._zoomStageImp(this.stage, scaleBy, center);

    if (!this.updateCurrentPage()) {
      this.stage.batchDraw();
    }
  }

  updateCurrentPage() {
    const y = (this.stage.y() - this.stage.height() / 2) / this.stage.getAbsoluteScale().y * -1;
    const pageNew = this.calcPage(y);

    if (this.state.cp.n !== pageNew && pageNew >= 0) {
      this.displayPage(pageNew, false, false);
      return true;
    }
    return false;
  }

  /**
   * @param {Object} coords
   * @param {number} [coords.deltaX=0]
   * @param {number} [coords.deltaY=0]
   */
  panStage({ deltaX = 0, deltaY = 0 }) {
    const x = this.stage.x();
    const y = this.stage.y();

    if (this.state.cp.n === 0) {
      const maxY = (this.getPageStop(0) - 100) * this.stage.getAbsoluteScale().y * -1 + this.stage.height() / 2;
      const maxYDelta = Math.max(0, maxY - y);
      deltaY = Math.min(deltaY, maxYDelta);
    }

    if (this.state.cp.n === this.doc.pageMetrics.length - 1) {
      const minY = this.getPageStop(this.state.cp.n, false) * this.stage.getAbsoluteScale().y * -1
        + this.stage.height() / 2;
      const minYDelta = Math.max(0, y - minY);
      deltaY = Math.max(deltaY, -minYDelta);
    }

    const minX1 = (this.doc.pageMetrics[this.state.cp.n].dims.width / 2) * this.stage.getAbsoluteScale().y * -1;
    const minX2 = this.doc.pageMetrics[this.state.cp.n].dims.width * this.stage.getAbsoluteScale().y * -1 + this.stage.width() / 2;
    const minX = Math.min(minX1, minX2);
    const minXDelta = Math.max(0, x - minX);
    deltaX = Math.max(deltaX, -minXDelta);

    const maxX1 = (this.doc.pageMetrics[this.state.cp.n].dims.width / 2) * this.stage.getAbsoluteScale().y * -1
      + this.stage.width();
    const maxX2 = this.stage.width() / 2;
    const maxX = Math.max(maxX1, maxX2);
    const maxXDelta = Math.max(0, maxX - x);
    deltaX = Math.min(deltaX, maxXDelta);

    this.stage.x(x + deltaX);
    this.stage.y(y + deltaY);

    if (!this.updateCurrentPage()) {
      this.stage.batchDraw();
    }
  }

  /**
   * Zoom in or out on the canvas. Used for buttons and other controls.
   * Handles redrawing the text overlay.
   * @param {number} scaleBy
   * @param {?{x: number, y: number}} [center=null]
   */
  zoom(scaleBy, center = null) {
    this.deleteHTMLOverlay();
    this._zoomStage(scaleBy, center);
    if (this.enableHTMLOverlay) this.renderHTMLOverlayAfterDelay();
  }

  /**
   * Resize the canvas to new pixel dimensions.
   * @param {number} width
   * @param {number} height
   */
  resize(width, height) {
    if (!this.stage || !(width > 0) || !(height > 0)) return;

    this.stage.width(width);
    this.stage.height(height);
    if (this.HTMLOverlayBackstopElem) {
      this.HTMLOverlayBackstopElem.style.width = `${width}px`;
      this.HTMLOverlayBackstopElem.style.height = `${height}px`;
    }
    this.stage.batchDraw();
  }

  /**
   * Initiates dragging when the middle mouse button is pressed.
   * @param {MouseEvent} event
   */
  startDrag(event) {
    this.deleteHTMLOverlay();
    this.drag.isDragging = true;
    this.drag.lastX = event.x;
    this.drag.lastY = event.y;
    event.preventDefault();
  }

  /** @param {KonvaTouchEvent} event */
  startDragTouch(event) {
    this.deleteHTMLOverlay();
    this.drag.isDragging = true;
    this.drag.lastX = event.evt.touches[0].clientX;
    this.drag.lastY = event.evt.touches[0].clientY;
    event.evt.preventDefault();
  }

  /** @param {KonvaMouseEvent} event */
  executeDrag(event) {
    if (this.drag.isDragging) {
      const deltaX = event.evt.x - this.drag.lastX;
      const deltaY = event.evt.y - this.drag.lastY;

      if (Math.round(deltaX) === 0 && Math.round(deltaY) === 0) return;

      this.drag.dragDeltaTotal += Math.abs(deltaX);
      this.drag.dragDeltaTotal += Math.abs(deltaY);

      this.drag.lastX = event.evt.x;
      this.drag.lastY = event.evt.y;

      this.panStage({ deltaX, deltaY });
    }
  }

  /** @param {KonvaTouchEvent} event */
  executeDragTouch(event) {
    if (this.drag.isDragging) {
      const deltaX = event.evt.touches[0].clientX - this.drag.lastX;
      const deltaY = event.evt.touches[0].clientY - this.drag.lastY;
      this.drag.lastX = event.evt.touches[0].clientX;
      this.drag.lastY = event.evt.touches[0].clientY;

      this.panStage({ deltaX, deltaY });
    }
  }

  /**
   * Stops dragging when the mouse button is released.
   * @param {KonvaMouseEvent|KonvaTouchEvent} event
   */
  stopDragPinch(event) {
    this.drag.isDragging = false;
    this.drag.isPinching = false;
    this.drag.dragDeltaTotal = 0;
    this.drag.lastCenter = null;
    this.drag.lastDist = null;
    if (this.enableHTMLOverlay && this._wordHTMLArr.length === 0) {
      this.renderHTMLOverlay();
    }
  }

  /** @param {KonvaTouchEvent} event */
  executePinchTouch(event) {
    this.deleteHTMLOverlay();
    const touch1 = event.evt.touches[0];
    const touch2 = event.evt.touches[1];
    if (!touch1 || !touch2) return;
    this.drag.isPinching = true;
    const p1 = { x: touch1.clientX, y: touch1.clientY };
    const p2 = { x: touch2.clientX, y: touch2.clientY };

    const center = getCenter(p1, p2);
    const dist = getDistance(p1, p2);

    if (!this.drag.lastDist || !this.drag.lastCenter) {
      this.drag.lastCenter = center;
      this.drag.lastDist = dist;
      return;
    }

    this._zoomStage(dist / this.drag.lastDist, center);
    this.drag.lastDist = dist;
    if (this.enableHTMLOverlay) this.renderHTMLOverlayAfterDelay();
  }

  /**
   * Attach the viewer to a DOM element. Builds the Konva stage, layers, and event handlers.
   * @param {HTMLDivElement} elem
   * @param {number} width
   * @param {number} height
   */
  init(elem, width, height) {
    this.elem = elem;

    this.stage = new Konva.Stage({
      container: elem,
      width,
      height,
    });

    this.stage.on('contextmenu', (event) => contextMenuFunc(this, event));

    this.HTMLOverlayBackstopElem = document.createElement('div');
    this.HTMLOverlayBackstopElem.className = 'endOfContent';
    this.HTMLOverlayBackstopElem.style.position = 'absolute';
    this.HTMLOverlayBackstopElem.style.top = '0';
    this.HTMLOverlayBackstopElem.style.left = '0';
    this.HTMLOverlayBackstopElem.style.width = `${width}px`;
    this.HTMLOverlayBackstopElem.style.height = `${height}px`;
    this.HTMLOverlayBackstopElem.style.display = 'none';

    this.layerBackground = new Konva.Layer();
    this.layerText = new Konva.Layer();
    this.layerOverlay = new Konva.Layer();

    this.stage.add(this.layerBackground);
    this.stage.add(this.layerText);
    this.stage.add(this.layerOverlay);

    this.selectingRectangle = new Konva.Rect({
      fill: 'rgba(40,123,181,0.5)',
      visible: true,
      listening: false,
    });

    this.layerText.add(this.selectingRectangle);

    this.stage.on('xChange yChange scaleXChange scaleYChange', () => {
      if (!this.enableHTMLOverlay) return;
      this.deleteHTMLOverlay();
      if (!this.drag.isDragging && !this.drag.isPinching) this.renderHTMLOverlayAfterDelay();
    });

    this.stage.on('mousemove', (event) => this.executeDrag(event));

    this.stage.on('touchstart', (event) => {
      if (this.mode === 'select') {
        if (event.evt.touches[1]) {
          this.executePinchTouch(event);
        } else {
          this.startDragTouch(event);
        }
      }
    });

    this.stage.on('touchmove', (event) => {
      if (event.evt.touches[1]) {
        this.executePinchTouch(event);
      } else if (this.drag.isDragging) {
        this.executeDragTouch(event);
      }
    });

    this.stage.on('mousedown touchstart', (event) => {
      _activeViewer = this;
      if (this.doc.pageMetrics.length === 0) return;
      if (event.type === 'mousedown' && event.evt.button !== 0) return;
      if (!this.enableCanvasSelection) return;

      this._mouseDownTarget = event.target;

      if (ScribeViewer.isTouchScreen && this.mode === 'select') return;

      this.selectingRectangle.zIndex(this.layerText.children.length - 1);

      event.evt.preventDefault();
      const startCoords = this.layerText.getRelativePointerPosition() || { x: 0, y: 0 };
      this.bbox.left = startCoords.x;
      this.bbox.top = startCoords.y;
      this.bbox.right = startCoords.x;
      this.bbox.bottom = startCoords.y;

      this.selectingRectangle.width(0);
      this.selectingRectangle.height(0);
      this.selecting = true;
    });

    this.stage.on('mousemove touchmove', (e) => {
      e.evt.preventDefault();
      if (!this.selecting) return;
      e.evt.preventDefault();
      const endCoords = this.layerText.getRelativePointerPosition();
      if (!endCoords) return;

      this.bbox.right = endCoords.x;
      this.bbox.bottom = endCoords.y;

      this.selectingRectangle.setAttrs({
        visible: true,
        x: Math.min(this.bbox.left, this.bbox.right),
        y: Math.min(this.bbox.top, this.bbox.bottom),
        width: Math.abs(this.bbox.right - this.bbox.left),
        height: Math.abs(this.bbox.bottom - this.bbox.top),
      });

      this.layerText.batchDraw();
    });

    this.stage.on('mouseup touchend', (event) => {
      // For dragging layout boxes, other events are needed to stop the drag.
      if (!this.state.layoutMode) {
        event.evt.preventDefault();
        event.evt.stopPropagation();
      }

      const mouseUpTarget = event.target;
      const editingWord = !!KonvaIText.input;

      // If a word is being edited, the only allowed action is clicking outside the word to deselect it.
      if (editingWord) {
        if (this._mouseDownTarget === KonvaIText.inputWord || mouseUpTarget === KonvaIText.inputWord) {
          this.selecting = false;
          return;
        }
        this.destroyControls();
        this.layerText.batchDraw();

      // Delete any current selections if either (1) this is a new selection or (2) nothing is being clicked.
      // Clicks must pass this check on both start and end.
      // Prevents clearing a selection when the user is highlighting letters but mouseup happens over another word.
      } else if (event.evt.button === 0 && (mouseUpTarget instanceof Konva.Stage || mouseUpTarget instanceof Konva.Image)
        && (this.selecting || event.target instanceof Konva.Stage || event.target instanceof Konva.Image)) {
        this.destroyControls();
      }

      this.selecting = false;

      // Return early if this was a drag or pinch rather than a selection.
      if (event.evt.button === 1 || (this.drag.isDragging && this.drag.dragDeltaTotal > 10) || this.drag.isPinching || this.drag.isResizingColumns) {
        this.stopDragPinch(event);
        return;
      }

      mouseupFunc2(this, event);

      this.mode = 'select';

      this.layerText.batchDraw();
    });
  }

  renderHTMLOverlay() {
    const words = this.getKonvaWords();
    // Words are wrapped in a per-line <div> so triple-click selects a single line.
    // Without a block ancestor per line, triple-click selects the whole page.
    const lineToElem = new Map();
    words.forEach((word) => {
      const elem = KonvaIText.itextToElem(word);
      this._wordHTMLArr.push(elem);

      const line = word.word.line;
      let lineElem = lineToElem.get(line);
      if (!lineElem) {
        lineElem = document.createElement('div');
        lineElem.classList.add('scribe-line');
        lineToElem.set(line, lineElem);
        this._lineHTMLArr.push(lineElem);
        this.elem.appendChild(lineElem);
      }
      lineElem.appendChild(elem);
    });
  }

  /**
   * Render the HTML overlay after 200ms, if no other events have been triggered in the meantime.
   * Called from frequently-triggered events (scroll/zoom) to coalesce rendering.
   */
  renderHTMLOverlayAfterDelay() {
    this._renderHTMLOverlayEvents++;
    const eventN = this._renderHTMLOverlayEvents;
    setTimeout(() => {
      if (eventN === this._renderHTMLOverlayEvents && this._wordHTMLArr.length === 0) {
        this.renderHTMLOverlay();
      }
    }, 200);
  }

  deleteHTMLOverlay() {
    this._wordHTMLArr.forEach((elem) => {
      if (elem.parentNode) elem.parentNode.removeChild(elem);
    });
    this._wordHTMLArr.length = 0;
    this._lineHTMLArr.forEach((elem) => {
      if (elem.parentNode) elem.parentNode.removeChild(elem);
    });
    this._lineHTMLArr.length = 0;
  }

  /**
   * Set the initial position and zoom of the canvas to reasonable defaults.
   * @param {dims} imgDims - Dimensions of image
   */
  setInitialPositionZoom(imgDims) {
    this.runSetInitial = false;

    const totalHeight = this.stage.height();
    const interfaceHeight = 100;
    const bottomMarginHeight = 50;
    const targetHeight = totalHeight - interfaceHeight - bottomMarginHeight;

    const zoom = targetHeight / imgDims.height;

    this.stage.scaleX(zoom);
    this.stage.scaleY(zoom);
    this.stage.x(((this.stage.width() - (imgDims.width * zoom)) / 2));
    this.stage.y(interfaceHeight);
  }

  async renderWords(n) {
    let ocrData = this.doc.ocr.active?.[n];

    const noInfo = this.doc.inputData.xmlMode[n] === undefined;
    const noInput = !this.doc.inputData.xmlMode[n] && !(this.doc.inputData.imageMode || this.doc.inputData.pdfMode);
    const xmlMissing = this.doc.inputData.xmlMode[n]
      && (ocrData === undefined || ocrData === null || this.doc.pageMetrics[n].dims === undefined);

    const pageStopsMissing = this.getPageStop(n) === null;

    const imageMissing = false;
    const pdfMissing = false;

    if (this._textGroups[n]) {
      for (const group of Object.values(this._textGroups[n])) {
        group.destroyChildren();
      }
    }

    if (KonvaIText.inputWord && KonvaIText.inputWord.word.line.page.n === n && KonvaIText.inputRemove) {
      KonvaIText.inputRemove();
    }
    this.CanvasSelection.deselectAllWords(n);

    if (noInfo || noInput || xmlMissing || imageMissing || pdfMissing || pageStopsMissing) {
      return;
    }

    if (this.doc.inputData.evalMode) {
      await this._compareGroundTruth();
      ocrData = this.doc.ocr.active?.[n];
    }

    if (this.doc.inputData.xmlMode[n]) {
      this._renderCanvasWords(ocrData);
    }
  }

  /**
   * Render page `n` in the UI.
   * @param {number} n
   * @param {boolean} [scroll=false]
   * @param {boolean} [refresh=true]
   */
  async displayPage(n, scroll = false, refresh = true) {
    if (Number.isNaN(n) || n < 0 || n > (this.doc.inputData.pageCount - 1)) {
      if (this.displayPageCallback) this.displayPageCallback();
      return;
    }

    if (this.runSetInitial) {
      this.setInitialPositionZoom(this.doc.pageMetrics[n].dims);
    }

    this.deleteHTMLOverlay();

    if (this.doc.inputData.xmlMode[this.state.cp.n]) {
      search.updateFindStats(this);
    }

    if (this.state.displayMode === 'ebook') {
      this.layerBackground.hide();
      this.layerBackground.batchDraw();
    } else {
      this.layerBackground.show();
      this.layerBackground.batchDraw();
    }

    this.textOverlayHidden = false;

    if (refresh || !this.textGroupsRenderIndices.includes(n)) {
      await this.renderWords(n);
    }

    if (n - 1 >= 0 && (refresh || !this.textGroupsRenderIndices.includes(n - 1))) {
      await this.renderWords(n - 1);
    }
    if (n + 1 < this.doc.ocr.active.length && (refresh || !this.textGroupsRenderIndices.includes(n + 1))) {
      await this.renderWords(n + 1);
    }

    if (scroll) {
      this.stage.y((this.getPageStop(n) - 100) * this.stage.getAbsoluteScale().y * -1);
    }

    this.layerText.batchDraw();

    this.state.cp.n = n;

    this.destroyText();
    this.destroyOverlay();

    if (this.enableHTMLOverlay && !this.drag.isDragging && !this.drag.isPinching) {
      this.renderHTMLOverlayAfterDelay();
    }

    if (this.displayPageCallback) this.displayPageCallback();

    if (this.state.layoutMode) {
      if (refresh || !this.overlayGroupsRenderIndices.includes(n)) {
        layout.renderLayoutBoxes(this, n);
      }
      if (n - 1 >= 0 && (refresh || !this.overlayGroupsRenderIndices.includes(n - 1))) {
        layout.renderLayoutBoxes(this, n - 1);
      }
      if (n + 1 < this.doc.ocr.active.length && (refresh || !this.overlayGroupsRenderIndices.includes(n + 1))) {
        layout.renderLayoutBoxes(this, n + 1);
      }
    }

    if ((this.doc.inputData.pdfMode || this.doc.inputData.imageMode)) {
      this.imageCache.renderAheadBehindBrowser(n);
    }
  }

  /**
   * @param {number} n
   * @param {number} [orientation=0]
   */
  createGroup(n, orientation = 0) {
    const group = new Konva.Group();
    const dims = this.doc.pageMetrics[n].dims;
    const angle = this.doc.pageMetrics[n].angle || 0;
    const textRotation = scribe.ScribeDoc.defaults.autoRotate ? 0 : angle;
    const pageOffsetY = this.getPageStop(n) ?? 30;
    group.rotation(textRotation + orientation * 90);
    if (orientation % 2 === 1) {
      group.offset({ x: dims.height * 0.5, y: dims.width * 0.5 });
      group.position({ x: dims.width * 0.5, y: pageOffsetY + dims.height * 0.5 });
    } else {
      group.offset({ x: dims.width * 0.5, y: dims.height * 0.5 });
      group.position({ x: dims.width * 0.5, y: pageOffsetY + dims.height * 0.5 });
    }
    return group;
  }

  /**
   * @param {number} n
   * @param {number} [orientation=0]
   */
  getTextGroup(n, orientation = 0) {
    if (!this._textGroups[n]) this._textGroups[n] = {};
    if (!this._textGroups[n][orientation]) {
      this._textGroups[n][orientation] = this.createGroup(n, orientation);
      this.layerText.add(this._textGroups[n][orientation]);
    }
    return this._textGroups[n][orientation];
  }

  /**
   * @param {number} n
   * @param {number} [rotation=0]
   */
  setTextGroupRotation(n, rotation = 0) {
    this.getTextGroup(n);
    for (const [key, group] of Object.entries(this._textGroups[n])) {
      group.rotation(Number(key) * 90 + rotation);
    }
  }

  /** @param {number} n */
  getOverlayGroup(n) {
    if (!this._overlayGroups[n]) {
      this._overlayGroups[n] = this.createGroup(n);
      this.layerOverlay.add(this._overlayGroups[n]);
    }
    return this._overlayGroups[n];
  }

  /** @param {number} y */
  calcPage(y) {
    if (this._pageStopsEnd[this._pageStopsEnd.length - 1] === undefined) {
      this.calcPageStops();
    }
    return this._pageStopsEnd.findIndex((y1) => y1 > y);
  }

  calcSelectionImageCoords() {
    const y = this.selectingRectangle.y();
    const n = this.calcPage(y);

    const box = this.selectingRectangle.getClientRect({ relativeTo: this.layerText });
    box.y -= this.getPageStop(n);

    const canvasCoordsPage = {
      left: box.x, top: box.y, width: box.width, height: box.height,
    };

    const imageRotated = true;
    const angle = this.doc.pageMetrics[n].angle || 0;

    const imageCoords = scribe.utils.coords.canvasToImage(canvasCoordsPage, imageRotated, scribe.ScribeDoc.defaults.autoRotate, n, this.doc.pageMetrics, angle);

    imageCoords.left = Math.round(imageCoords.left);
    imageCoords.top = Math.round(imageCoords.top);
    imageCoords.width = Math.round(imageCoords.width);
    imageCoords.height = Math.round(imageCoords.height);

    const pageDims = this.doc.pageMetrics[n].dims;
    const leftClip = Math.max(0, imageCoords.left);
    const topClip = Math.max(0, imageCoords.top);
    // Tesseract has a bug where subtracting 1 from the width/height when setting the rectangle to the full image fixes it.
    // See: https://github.com/naptha/tesseract.js/issues/936
    const rightClip = Math.min(pageDims.width - 1, imageCoords.left + imageCoords.width);
    const bottomClip = Math.min(pageDims.height - 1, imageCoords.top + imageCoords.height);
    imageCoords.left = leftClip;
    imageCoords.top = topClip;
    imageCoords.width = rightClip - leftClip;
    imageCoords.height = bottomClip - topClip;

    return { box: imageCoords, n };
  }

  getKonvaWords() {
    /** @type {Array<KonvaOcrWord>} */
    const words = [];
    const n = this.state.cp.n;
    for (const offset of [-1, 0, 1]) {
      const idx = n + offset;
      if (this._textGroups[idx]) {
        for (const group of Object.values(this._textGroups[idx])) {
          group.children.forEach((x) => {
            if (x instanceof KonvaOcrWord) words.push(x);
          });
        }
      }
    }
    return words;
  }

  getKonvaRegions() {
    /** @type {Array<KonvaRegion>} */
    const regions = [];
    const n = this.state.cp.n;
    for (const offset of [-1, 0, 1]) {
      const idx = n + offset;
      if (this._overlayGroups[idx]?.children) {
        this._overlayGroups[idx].children.forEach((x) => {
          if (x instanceof KonvaRegion) regions.push(x);
        });
      }
    }
    return regions;
  }

  getKonvaDataColumns() {
    /** @type {Array<KonvaDataColumn>} */
    const columns = [];
    const n = this.state.cp.n;
    for (const offset of [-1, 0, 1]) {
      const idx = n + offset;
      if (this._overlayGroups[idx]?.children) {
        this._overlayGroups[idx].children.forEach((x) => {
          if (x instanceof KonvaDataColumn) columns.push(x);
        });
      }
    }
    return columns;
  }

  getDataTables() { return [...new Set(this.getKonvaDataColumns().map((x) => x.layoutBox.table))]; }

  getKonvaDataTables() { return [...new Set(this.getKonvaDataColumns().map((x) => x.konvaTable))]; }

  /** @param {boolean} [deselect=true] - Deselect all words, layout boxes, and data columns. */
  destroyControls(deselect = true) {
    this._controlArr.forEach((control) => control.destroy());
    this._controlArr.length = 0;

    if (deselect) this.CanvasSelection.deselectAll();

    if (KonvaIText.inputRemove) KonvaIText.inputRemove();

    this.destroyControlsCallback(deselect);
  }

  /**
   * Destroy objects in the overlay layer. By default, only objects outside the current view are destroyed.
   * @param {boolean} [outsideViewOnly=true]
   */
  destroyOverlay(outsideViewOnly = true) {
    for (let i = 0; i < this.overlayGroupsRenderIndices.length; i++) {
      const n = this.overlayGroupsRenderIndices[i];
      if (Math.abs(n - this.state.cp.n) > 1 || !outsideViewOnly) {
        this._overlayGroups[n].destroyChildren();
        this.overlayGroupsRenderIndices.splice(i, 1);
        i--;
      }
    }
  }

  /**
   * Destroy objects in the text layer. By default, only objects outside the current view are destroyed.
   * @param {boolean} [outsideViewOnly=true]
   */
  destroyText(outsideViewOnly = true) {
    for (let i = 0; i < this.textGroupsRenderIndices.length; i++) {
      const n = this.textGroupsRenderIndices[i];
      if (Math.abs(n - this.state.cp.n) > 1 || !outsideViewOnly) {
        for (const group of Object.values(this._textGroups[n])) {
          group.destroyChildren();
        }
        this.textGroupsRenderIndices.splice(i, 1);
        i--;
      }
    }
  }

  /** @param {Event} event */
  _onSelection(event) {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);

    const focusWordElem = selection.focusNode?.nodeType === Node.ELEMENT_NODE ? selection.focusNode : selection.focusNode?.parentNode;

    if (!focusWordElem || !this._wordHTMLArr.includes(/** @type {HTMLSpanElement} */ (focusWordElem))) return;

    this.HTMLOverlayBackstopElem.style.display = '';

    focusWordElem.parentNode?.insertBefore(this.HTMLOverlayBackstopElem, focusWordElem);

    this._prevRange = range.cloneRange();
  }

  /**
   * Recolor words based on current display mode (proof, ebook, eval, etc.).
   */
  setWordColorOpacity() {
    this.getKonvaWords().forEach((obj) => {
      const { fill, opacity } = scribe.utils.ocr.getWordFillOpacity(obj.word, this.state.displayMode,
        scribe.ScribeDoc.defaults.confThreshMed, scribe.ScribeDoc.defaults.confThreshHigh, scribe.ScribeDoc.defaults.overlayOpacity);
      obj.fill(fill);
      obj.opacity(opacity);
    });
  }

  /**
   * Compare the active OCR pages against the ground truth and update `evalStats`.
   */
  async _compareGroundTruth() {
    const oemActive = Object.keys(this.doc.ocr).find((key) => this.doc.ocr[key] === this.doc.ocr.active && key !== 'active');

    if (!oemActive) {
      console.error('No OCR data active');
      return;
    }

    const evalStatsConfigNew = {
      ocrActive: oemActive,
      ignorePunct: scribe.ScribeDoc.defaults.ignorePunct,
      ignoreCap: scribe.ScribeDoc.defaults.ignoreCap,
    };
    /** @type {Parameters<typeof this.doc.compareOCR>[2]} */
    const compOptions = {
      ignorePunct: scribe.ScribeDoc.defaults.ignorePunct,
      ignoreCap: scribe.ScribeDoc.defaults.ignoreCap,
      confThreshHigh: scribe.ScribeDoc.defaults.confThreshHigh,
      confThreshMed: scribe.ScribeDoc.defaults.confThreshMed,
    };

    if (JSON.stringify(this._evalStatsConfig) !== JSON.stringify(evalStatsConfigNew) || this.evalStats.length === 0) {
      this._evalStatsConfig = evalStatsConfigNew;

      // TODO: This will overwrite any edits made by the user while `compareOCR` is running.
      // Is this a problem that is likely to occur in real use? If so, how should it be fixed?
      const res = await this.doc.compareOCR(this.doc.ocr.active, this.doc.ocr['Ground Truth'], compOptions);

      this.doc.ocr[oemActive] = res.ocr;
      this.doc.ocr.active = this.doc.ocr[oemActive];

      clearObjectProperties(this.evalStats);
      Object.assign(this.evalStats, res.metrics);
    }
  }

  /**
   * Draw OCR words for a page into the text layer.
   * @param {OcrPage} page
   */
  _renderCanvasWords(page) {
    const angle = this.doc.pageMetrics[page.n].angle || 0;
    const textRotation = scribe.ScribeDoc.defaults.autoRotate ? 0 : angle;

    this.setTextGroupRotation(page.n, textRotation);

    if (!this.textGroupsRenderIndices.includes(page.n)) this.textGroupsRenderIndices.push(page.n);

    const matchIdArr = this.state.searchMode ? scribe.utils.ocr.getMatchingWordIds(search.search, this.doc.ocr.active[page.n]) : [];

    const imageRotated = Math.abs(angle ?? 0) > 0.05;

    const pageAnnotations = this.doc.annotations.pages[page.n] || [];

    if (this.opt.outlinePars && page) {
      if (!page.textSource || !['textract', 'abbyy', 'google_vision', 'azure_doc_intel', 'docx'].includes(page.textSource)) {
        scribe.utils.assignParagraphs(page, angle);
      }

      page.pars.forEach((par, i) => {
        const angleAdj = imageRotated ? scribe.utils.ocr.calcLineStartAngleAdj(par.lines[0]) : { x: 0, y: 0 };
        this._addBlockOutline(page.n, par.bbox, angleAdj, i + 1, par.reason, par.lines[0]?.orientation ?? 0, par.lines);
      });
    }

    for (let i = 0; i < page.lines.length; i++) {
      const lineObj = page.lines[i];

      const group = this.getTextGroup(page.n, lineObj.orientation);

      const angleAdjLine = imageRotated ? scribe.utils.ocr.calcLineStartAngleAdj(lineObj) : { x: 0, y: 0 };

      if (this.opt.outlineLines) {
        const heightAdj = Math.abs(Math.tan(angle * (Math.PI / 180)) * (lineObj.bbox.right - lineObj.bbox.left));
        const height1 = lineObj.bbox.bottom - lineObj.bbox.top - heightAdj;
        const height2 = lineObj.words[0] ? lineObj.words[0].bbox.bottom - lineObj.words[0].bbox.top : 0;
        const height = Math.max(height1, height2);

        const lineRect = new Konva.Rect({
          x: lineObj.bbox.left + angleAdjLine.x,
          y: lineObj.bbox.bottom + lineObj.baseline[1] + angleAdjLine.y - height,
          width: lineObj.bbox.right - lineObj.bbox.left,
          height,
          stroke: 'rgba(0,0,255,0.75)',
          strokeWidth: 1,
          draggable: false,
          listening: false,
        });

        group.add(lineRect);
      }

      /** @type {KonvaOcrWord|null} */
      let prevWordCanvas = null;
      for (const wordObj of lineObj.words) {
        if (!wordObj.text) continue;

        const outlineWord = this.opt.outlineWords || this.state.displayMode === 'eval' && wordObj.conf > scribe.ScribeDoc.defaults.confThreshHigh && !wordObj.matchTruth;

        const angleAdjWord = imageRotated ? scribe.utils.ocr.calcWordAngleAdj(wordObj) : { x: 0, y: 0 };

        const visualBaseline = lineObj.bbox.bottom + lineObj.baseline[1] + angleAdjLine.y + angleAdjWord.y;

        let top = visualBaseline;
        if (wordObj.style.sup || wordObj.style.dropcap) top = wordObj.bbox.bottom + angleAdjLine.y + angleAdjWord.y;

        const visualLeft = wordObj.bbox.left + angleAdjLine.x + angleAdjWord.x;

        let highlightColor = null;
        let highlightOpacity = 1;
        let highlightGroupId = null;
        let highlightComment = '';
        for (const annot of pageAnnotations) {
          if (!(annot.bbox.left <= wordObj.bbox.left && annot.bbox.right >= wordObj.bbox.right
            && annot.bbox.top <= wordObj.bbox.top && annot.bbox.bottom >= wordObj.bbox.bottom)) continue;

          if (annot.quads) {
            const matchesQuad = annot.quads.some((quad) => quad.left < wordObj.bbox.right && quad.right > wordObj.bbox.left
              && quad.top < wordObj.bbox.bottom && quad.bottom > wordObj.bbox.top);
            if (!matchesQuad) continue;
          }

          highlightColor = annot.color;
          highlightOpacity = annot.opacity;
          highlightGroupId = annot.groupId || null;
          highlightComment = annot.comment || '';
          break;
        }

        const wordCanvas = new KonvaOcrWord({
          visualLeft,
          yActual: top,
          topBaseline: visualBaseline,
          rotation: 0,
          word: wordObj,
          outline: outlineWord,
          fillBox: matchIdArr.includes(wordObj.id),
          highlightColor,
          highlightOpacity,
          highlightGroupId,
          highlightComment,
          listening: !this.state.layoutMode,
          viewer: this,
        });

        if (wordCanvas.highlightColor && prevWordCanvas && prevWordCanvas.highlightColor
          && wordCanvas.highlightGroupId && wordCanvas.highlightGroupId === prevWordCanvas.highlightGroupId) {
          const gap = (wordCanvas.x() - (prevWordCanvas.x() + prevWordCanvas.width())) / 2;
          wordCanvas.highlightGapLeft = gap;
          prevWordCanvas.highlightGapRight = gap;
        }

        prevWordCanvas = wordCanvas;
        group.add(wordCanvas);
      }
    }
  }

  /**
   * Draw a paragraph/block outline.
   */
  // eslint-disable-next-line default-param-last
  _addBlockOutline(n, box, angleAdj, index, label, orientation = 0, lines) {
    const group = this.getTextGroup(n, orientation);

    const sortedLines = (lines && lines.length > 0 ? lines.map((l) => l.bbox) : [box])
      .slice()
      .sort((a, b) => a.top - b.top);
    const first = sortedLines[0];
    const last = sortedLines[sortedLines.length - 1];
    const topAlone = sortedLines.length === 1 || sortedLines[1].top >= first.bottom;
    const bottomAlone = sortedLines.length === 1 || sortedLines[sortedLines.length - 2].bottom <= last.top;

    const tlNotch = topAlone && first.left > box.left;
    const trNotch = topAlone && first.right < box.right;
    const blNotch = bottomAlone && last.left > box.left;
    const brNotch = bottomAlone && last.right < box.right;

    const ax = angleAdj.x;
    const ay = angleAdj.y;
    const points = [];
    if (tlNotch) points.push(first.left + ax, box.top + ay);
    else points.push(box.left + ax, box.top + ay);

    if (trNotch) {
      points.push(first.right + ax, box.top + ay);
      points.push(first.right + ax, first.bottom + ay);
      points.push(box.right + ax, first.bottom + ay);
    } else {
      points.push(box.right + ax, box.top + ay);
    }

    if (brNotch) {
      points.push(box.right + ax, last.top + ay);
      points.push(last.right + ax, last.top + ay);
      points.push(last.right + ax, box.bottom + ay);
    } else {
      points.push(box.right + ax, box.bottom + ay);
    }

    if (blNotch) {
      points.push(last.left + ax, box.bottom + ay);
      points.push(last.left + ax, last.top + ay);
      points.push(box.left + ax, last.top + ay);
    } else {
      points.push(box.left + ax, box.bottom + ay);
    }

    if (tlNotch) {
      points.push(box.left + ax, first.bottom + ay);
      points.push(first.left + ax, first.bottom + ay);
    }

    const blockRect = new Konva.Line({
      points,
      closed: true,
      stroke: 'rgba(0,0,255,0.75)',
      strokeWidth: 1,
      draggable: false,
      listening: false,
    });

    const indexStr = String(index);
    const badgeObj = new Konva.Shape({
      x: box.left + angleAdj.x,
      y: box.top + angleAdj.y,
      sceneFunc: (context, shape) => {
        const scale = shape.getAbsoluteScale().x;
        const screenRadius = Math.min(18, Math.max(12, 12 * scale));
        const radius = screenRadius / scale;
        const cx = -radius - 4 / scale;
        const cy = radius;

        context.beginPath();
        context.arc(cx, cy, radius, 0, 2 * Math.PI);
        context.fillStyle = 'rgba(0, 100, 200, 0.85)';
        context.fill();

        const fontSize = radius * 1.2;
        context.font = `bold ${fontSize}px Arial`;
        context.fillStyle = '#fff';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(indexStr, cx, cy);
      },
      draggable: false,
      listening: false,
    });

    group.add(blockRect);
    group.add(badgeObj);

    if (label) {
      const reasonObj = new Konva.Shape({
        x: box.left + angleAdj.x,
        y: box.top + angleAdj.y,
        sceneFunc: (context, shape) => {
          const scale = shape.getAbsoluteScale().x;
          const screenSize = Math.min(20, Math.max(10, 10 * scale));
          const fontSize = screenSize / scale;
          context.font = `${fontSize}px Arial`;
          context.fillStyle = 'rgba(0,0,255,0.75)';
          context.textBaseline = 'top';
          context.fillText(label, 0, 0);
        },
        draggable: false,
        listening: false,
      });

      group.add(reasonObj);
    }
  }

  /** Delete the currently selected word(s) from the document. */
  deleteSelectedWord() { return deleteSelectedWord(this); }

  /**
   * Adjust the left or right edge of the selected word's bbox by `amount` pixels.
   * @param {'left'|'right'} side
   * @param {number} amount
   */
  modifySelectedWordBbox(side, amount) { return modifySelectedWordBbox(this, side, amount); }

  /**
   * Apply style changes to the currently selected words.
   * @param {Object} style
   * @param {string} [style.font]
   * @param {number} [style.size]
   * @param {boolean} [style.bold]
   * @param {boolean} [style.italic]
   * @param {boolean} [style.underline]
   * @param {boolean} [style.smallCaps]
   * @param {boolean} [style.sup]
   */
  modifySelectedWordStyle(style) { return modifySelectedWordStyle(this, style); }

  /** Delete the currently selected layout data table. */
  deleteSelectedLayoutDataTable() { return deleteSelectedLayoutDataTable(this); }

  /** Delete the currently selected layout region(s). */
  deleteSelectedLayoutRegion() { return deleteSelectedLayoutRegion(this); }

  /**
   * Apply a highlight color and opacity to the given words, creating or updating their annotation data.
   * @param {Array<InstanceType<typeof KonvaOcrWord>>} words
   * @param {number} pageIndex
   * @param {string} color
   * @param {number} opacity
   */
  applyHighlight(words, pageIndex, color, opacity) { return applyHighlight(this, words, pageIndex, color, opacity); }

  /**
   * Remove highlights from the given words and drop their annotation data.
   * @param {Array<InstanceType<typeof KonvaOcrWord>>} words
   * @param {number} pageIndex
   */
  removeHighlight(words, pageIndex) { return removeHighlight(this, words, pageIndex); }

  /**
   * Set the comment on the highlight group containing the first selected word.
   * @param {Array<InstanceType<typeof KonvaOcrWord>>} words
   * @param {number} pageIndex
   * @param {string} comment
   */
  modifyHighlightComment(words, pageIndex, comment) { return modifyHighlightComment(this, words, pageIndex, comment); }

  /** Redraw the dashed outline around the words in the currently selected highlight group. */
  updateHighlightGroupOutline() { return updateHighlightGroupOutline(this); }

  /**
   * Tear down the viewer. Removes it from the global registry. Caller is responsible for the DOM.
   */
  destroy() {
    _allViewers.delete(this);
    if (_defaultViewer === this) _defaultViewer = null;
    if (_activeViewer === this) _activeViewer = null;
    try { this.stage?.destroy(); } catch { /* ignore */ }
  }

  /** Detect a touchscreen (global, not per-viewer). */
  static isTouchScreen = navigator?.maxTouchPoints > 0;
}

// Static type/utility exports.
// These are not per-viewer state. They're class references.
ScribeViewer.Konva = Konva;
ScribeViewer.KonvaIText = KonvaIText;
ScribeViewer.KonvaOcrWord = KonvaOcrWord;
ScribeViewer.KonvaLayout = KonvaLayout;
ScribeViewer.ViewerImageCache = ViewerImageCache;
ScribeViewer.search = search;
ScribeViewer.layout = layout;
ScribeViewer.getAllFileEntries = getAllFileEntries;

// Backward-compatibility static facade.
// Existing single-viewer applications call `ScribeViewer.X` (static). We preserve that surface
// by routing it to a default instance. The default is the first instance constructed.
// If no instance has been constructed yet, accessing the static API lazily creates one.
// Multi-viewer applications should construct their own `new ScribeViewer()` instances and use
// the instance API directly. Each instance is independent.

/** @type {?ScribeViewer} */
let _defaultViewer = null;

function getDefault() {
  if (!_defaultViewer) _defaultViewer = new ScribeViewer();
  return _defaultViewer;
}

ScribeViewer.getDefault = getDefault;

/** @returns {Set<ScribeViewer>} */
ScribeViewer.getAllViewers = () => _allViewers;

/**
 * Find the viewer whose element contains the given DOM node.
 * Used by document-level event listeners to route events to the right viewer.
 * @param {Node} target
 * @returns {?ScribeViewer}
 */
function findViewerForTarget(target) {
  for (const v of _allViewers) {
    if (v.elem && v.elem.contains(target)) return v;
  }
  return null;
}

ScribeViewer.findViewerForTarget = findViewerForTarget;

/** @returns {?ScribeViewer} */
ScribeViewer.getActiveViewer = () => _activeViewer || _defaultViewer;

const _delegatedMethods = [
  'init', 'displayPage', 'renderWords', 'renderHTMLOverlay', 'renderHTMLOverlayAfterDelay',
  'deleteHTMLOverlay', 'setInitialPositionZoom', 'getPageStop', 'calcPageStops', 'getStageCenter',
  'panStage', 'zoom', 'resize', 'startDrag', 'startDragTouch', 'executeDrag', 'executeDragTouch',
  'stopDragPinch', 'executePinchTouch', 'createGroup', 'getTextGroup', 'setTextGroupRotation',
  'getOverlayGroup', 'calcPage', 'calcSelectionImageCoords', 'getKonvaWords', 'getKonvaRegions',
  'getKonvaDataColumns', 'getDataTables', 'getKonvaDataTables', 'destroyControls', 'destroyOverlay',
  'destroyText', 'updateCurrentPage', 'setWordColorOpacity', 'deleteSelectedWord',
  'modifySelectedWordBbox', 'modifySelectedWordStyle', 'deleteSelectedLayoutDataTable',
  'deleteSelectedLayoutRegion', 'applyHighlight', 'removeHighlight', 'modifyHighlightComment',
  'updateHighlightGroupOutline',
];
for (const m of _delegatedMethods) {
  ScribeViewer[m] = (...args) => /** @type {any} */ (getDefault())[m](...args);
}

const _delegatedFields = [
  'elem', 'HTMLOverlayBackstopElem', 'textOverlayHidden', 'doc', 'placeholderRectArr',
  'displayPageCallback', 'stage', 'layerBackground', 'layerText', 'layerOverlay',
  'textGroupsRenderIndices', 'overlayGroupsRenderIndices', 'selectingRectangle', 'contextMenuWord',
  'contextMenuPointer', 'selecting', 'enableCanvasSelection', 'enableHTMLOverlay', 'bbox',
  'mode', 'drag', 'runSetInitial', 'state', 'opt', 'CanvasSelection', 'evalStats',
  '_wordHTMLArr', '_lineHTMLArr', 'interactionCallback', 'destroyControlsCallback',
];
for (const f of _delegatedFields) {
  if (Object.prototype.hasOwnProperty.call(ScribeViewer, f)) continue;
  Object.defineProperty(ScribeViewer, f, {
    configurable: true,
    get() { return /** @type {any} */ (getDefault())[f]; },
    set(v) { /** @type {any} */ (getDefault())[f] = v; },
  });
}

ScribeViewer.setWordColorOpacity = (...args) => getDefault().setWordColorOpacity(...args);
ScribeViewer.compareGroundTruth = (...args) => /** @type {any} */ (getDefault())._compareGroundTruth(...args);
ScribeViewer.renderCanvasWords = (page) => getDefault()._renderCanvasWords(page);

// Document-level event listeners.
// These fire at the document level (not per-viewer) because the canvas may be obscured by HTML
// overlay text. We dispatch each event to the viewer whose element contains the target.

document.addEventListener('mouseup', () => {
  for (const v of _allViewers) {
    if (v.enableHTMLOverlay && v.HTMLOverlayBackstopElem) {
      v.HTMLOverlayBackstopElem.style.display = 'none';
    }
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

function getElementIdsInRange(range) {
  const elementIds = [];
  const treeWalker = document.createTreeWalker(
    range.commonAncestorContainer,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        if (node instanceof HTMLElement && node.classList && node.classList.contains('scribe-word')) {
          const nodeRange = document.createRange();
          nodeRange.selectNode(node);
          return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_REJECT;
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

  let text = '';
  for (let i = 0; i < v.textGroupsRenderIndices.length; i++) {
    if (i > 0) text += '\n\n';
    const n = v.textGroupsRenderIndices[i];
    text += scribe.utils.writeText({
      ocrCurrent: v.doc.ocr.active,
      pageArr: [n],
      wordIds: ids,
    });
  }

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
 * @param {ScribeViewer} viewer
 * @param {WheelEvent} event
 */
const handleWheel = (viewer, event) => {
  viewer.deleteHTMLOverlay();
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

    viewer._zoomStage(scaleBy, viewer.stage.getPointerPosition());
    viewer.destroyControls();
  } else if (event.shiftKey) {
    viewer.destroyControls();
    const deltaX = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX * -1 : event.deltaY * -1;
    viewer.panStage({ deltaX });
  } else {
    viewer.destroyControls();
    viewer.panStage({ deltaY: event.deltaY * -1, deltaX: event.deltaX * -1 });
  }
  if (viewer.enableHTMLOverlay) viewer.renderHTMLOverlayAfterDelay();
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
    if (v.doc.pageMetrics.length > 0 && event.button === 1) v.startDrag(event);
    return;
  }
  // The click landed outside every viewer canvas.
  // A `'focused'`-scope viewer stops claiming body-level keystrokes unless the click landed on its own chrome (toolbar, etc.).
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
