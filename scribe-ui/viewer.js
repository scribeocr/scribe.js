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
import { applyHighlight, removeHighlight, modifyHighlightComment, updateHighlightGroupOutline } from './js/viewerHighlights.js';

Konva.autoDrawEnabled = false;
Konva.dragButtons = [0];

class stateViewer {
  static recognizeAllPromise = Promise.resolve();

  static layoutMode = false;

  static searchMode = false;

  /** @type {'color'|'gray'|'binary'} */
  static colorMode = 'color';

  static cp = {
    n: 0,
  };
}

/**
 * This object contains the values of options for the GUI that do not directly map to options in the `scribe` module.
 * This includes both GUI-specific options and options that are implemented through arguments rather than the `opts` object.
 */
class optViewer {
  static enableRecognition = true;

  static enableXlsxExport = false;

  static downloadFormat = 'pdf';

  static vanillaMode = false;

  static langs = ['eng'];

  /** @type {'conf'|'data'} */
  static combineMode = 'data';

  /**
   * Whether to show the intermediate, internal versions of OCR.
   * This is useful for debugging and testing, but should not be enabled by default.
   */
  static showInternalOCRVersions = false;

  static outlineWords = false;

  static outlineLines = false;

  static outlinePars = false;
}

let evalStatsConfig = {
  /** @type {string|undefined} */
  ocrActive: undefined,
  ignorePunct: scribe.opt.ignorePunct,
  ignoreCap: scribe.opt.ignoreCap,
  ignoreExtra: scribe.opt.ignoreExtra,
};

/** @type {Array<EvalMetrics>} */
const evalStats = [];

/**
 * Class for managing the selection of words, layout boxes, and data columns on the canvas.
 * This is a class due to JSDoc type considerations. All methods and properties are static.
 */
class CanvasSelection {
  /** @type {Array<KonvaOcrWord>} */
  static _selectedWordArr = [];

  /** @type {?KonvaOcrWord} */
  static selectedWordFirst = null;

  /** @type {Array<import('./js/viewerLayout.js').KonvaRegion>} */
  static _selectedRegionArr = [];

  /** @type {Array<KonvaDataColumn>} */
  static _selectedDataColumnArr = [];

  static getKonvaWords = () => CanvasSelection._selectedWordArr;

  static getKonvaRegions = () => CanvasSelection._selectedRegionArr;

  static getKonvaDataColumns = () => CanvasSelection._selectedDataColumnArr;

  static getKonvaWordsCopy = () => CanvasSelection._selectedWordArr.slice();

  static getKonvaRegionsCopy = () => CanvasSelection._selectedRegionArr.slice();

  static getKonvaDataColumnsCopy = () => CanvasSelection._selectedDataColumnArr.slice();

  static getKonvaLayoutBoxes = () => [...CanvasSelection._selectedRegionArr, ...CanvasSelection._selectedDataColumnArr];

  static getDataTables = () => ([...new Set(CanvasSelection._selectedDataColumnArr.map((x) => x.layoutBox.table))]);

  static getKonvaDataTables = () => ([...new Set(CanvasSelection._selectedDataColumnArr.map((x) => x.konvaTable))]);

  /**
   * Add word or array of words to the current selection.
   * Ignores words that are already selected.
   * @param {KonvaOcrWord|Array<KonvaOcrWord>} words
   */
  static addWords = (words) => {
    if (!Array.isArray(words)) words = [words];
    for (let i = 0; i < words.length; i++) {
      const wordI = words[i];
      if (i === 0 && CanvasSelection._selectedWordArr.length === 0) CanvasSelection.selectedWordFirst = wordI;
      if (!CanvasSelection._selectedWordArr.map((x) => x.word.id).includes(wordI.word.id)) {
        CanvasSelection._selectedWordArr.push(wordI);
      }
    }
  };

  /**
   * Add layout boxes, including both regions and data columns, to the current selection.
   * Ignores boxes that are already selected.
   * @param {Array<import('./js/viewerLayout.js').KonvaRegion|import('./js/viewerLayout.js').KonvaDataColumn>|
   * import('./js/viewerLayout.js').KonvaRegion|import('./js/viewerLayout.js').KonvaDataColumn} konvaLayoutBoxes
   */
  static addKonvaLayoutBoxes = (konvaLayoutBoxes) => {
    let konvaLayoutBoxesArr;
    if (konvaLayoutBoxes instanceof KonvaRegion || konvaLayoutBoxes instanceof KonvaDataColumn) {
      konvaLayoutBoxesArr = [konvaLayoutBoxes];
    } else {
      konvaLayoutBoxesArr = konvaLayoutBoxes;
    }
    konvaLayoutBoxesArr.forEach((konvaLayoutBox) => {
      if (konvaLayoutBox instanceof KonvaDataColumn) {
        if (!CanvasSelection._selectedDataColumnArr.map((x) => x.layoutBox.id).includes(konvaLayoutBox.layoutBox.id)) {
          CanvasSelection._selectedDataColumnArr.push(konvaLayoutBox);
        }
      } else if (!CanvasSelection._selectedRegionArr.map((x) => x.layoutBox.id).includes(konvaLayoutBox.layoutBox.id)) {
        CanvasSelection._selectedRegionArr.push(konvaLayoutBox);
      }
    });
    // Other code assumes that these arrays are sorted left to right.
    CanvasSelection._selectedDataColumnArr.sort((a, b) => a.layoutBox.coords.left - b.layoutBox.coords.left);
    CanvasSelection._selectedRegionArr.sort((a, b) => a.layoutBox.coords.left - b.layoutBox.coords.left);
  };

  /**
   *
   * @param {Array<string>} layoutBoxIdArr
   */
  static selectLayoutBoxesById = (layoutBoxIdArr) => {
    // eslint-disable-next-line no-use-before-define
    const konvaLayoutBoxes = ScribeViewer.getKonvaRegions().filter((x) => layoutBoxIdArr.includes(x.layoutBox.id));

    // eslint-disable-next-line no-use-before-define
    const konvaDataColumns = ScribeViewer.getKonvaDataColumns().filter((x) => layoutBoxIdArr.includes(x.layoutBox.id));

    CanvasSelection.selectLayoutBoxes([...konvaLayoutBoxes, ...konvaDataColumns]);
  };

  /**
   *
   * @param {Array<KonvaRegion|KonvaDataColumn>} konvaLayoutBoxes
   */
  static selectLayoutBoxes = (konvaLayoutBoxes) => {
    // eslint-disable-next-line no-use-before-define
    const selectedLayoutBoxes = ScribeViewer.CanvasSelection.getKonvaRegions();
    // eslint-disable-next-line no-use-before-define
    const selectedDataColumns = ScribeViewer.CanvasSelection.getKonvaDataColumns();

    // eslint-disable-next-line no-use-before-define
    ScribeViewer.CanvasSelection.addKonvaLayoutBoxes(konvaLayoutBoxes);

    selectedDataColumns.forEach((shape) => (shape.select()));
    selectedLayoutBoxes.forEach((shape) => (shape.select()));
  };

  /**
   * Get arrays of distinct font families and font sizes from the selected words.
   */
  static getWordProperties = () => {
    const fontFamilyArr = Array.from(new Set(CanvasSelection._selectedWordArr.map((x) => (x.fontFamilyLookup))));
    const fontSizeArr = Array.from(new Set(CanvasSelection._selectedWordArr.map((x) => (x.fontSize))));
    return { fontFamilyArr, fontSizeArr };
  };

  /**
   * Get arrays of distinct layout box properties from the selected layout boxes.
   * Includes both layout boxes and data columns.
   */
  static getLayoutBoxProperties = () => {
    const selectedWordsAll = CanvasSelection.getKonvaLayoutBoxes();
    const inclusionRuleArr = Array.from(new Set(selectedWordsAll.map((x) => (x.layoutBox.inclusionRule))));
    const inclusionLevelArr = Array.from(new Set(selectedWordsAll.map((x) => (x.layoutBox.inclusionLevel))));
    return { inclusionRuleArr, inclusionLevelArr };
  };

  /**
   *
   * @param {number} [n]
   */
  static deselectAllWords = (n) => {
    for (let i = CanvasSelection._selectedWordArr.length - 1; i >= 0; i--) {
      if (n === null || n === undefined || CanvasSelection._selectedWordArr[i].word.line.page.n === n) {
        CanvasSelection._selectedWordArr[i].deselect();
        CanvasSelection._selectedWordArr.splice(i, 1);
      }
    }

    if (CanvasSelection.selectedWordFirst && (n === null || n === undefined)) {
      CanvasSelection.selectedWordFirst = null;
    } else if (CanvasSelection.selectedWordFirst && CanvasSelection.selectedWordFirst.word.line.page.n === n) {
      CanvasSelection.selectedWordFirst = CanvasSelection._selectedWordArr[0] || null;
    }
  };

  static deselectAllRegions = () => {
    CanvasSelection._selectedRegionArr.forEach((shape) => (shape.deselect()));
    CanvasSelection._selectedRegionArr.length = 0;
  };

  static deselectAllDataColumns = () => {
    CanvasSelection._selectedDataColumnArr.forEach((shape) => (shape.deselect()));
    CanvasSelection._selectedDataColumnArr.length = 0;
  };

  static deselectAll = () => {
    CanvasSelection.deselectAllWords();
    CanvasSelection.deselectAllRegions();
    CanvasSelection.deselectAllDataColumns();
  };

  /**
   *
   * @param {string|Array<string>} ids
   */
  static deselectDataColumnsByIds = (ids) => {
    if (!Array.isArray(ids)) ids = [ids];
    for (let j = 0; j < CanvasSelection._selectedDataColumnArr.length; j++) {
      if (ids.includes(CanvasSelection._selectedDataColumnArr[j].layoutBox.id)) {
        CanvasSelection._selectedDataColumnArr.splice(j, 1);
        j--;
      }
    }
  };

  static deleteSelectedWord = deleteSelectedWord;

  static modifySelectedWordBbox = modifySelectedWordBbox;

  static modifySelectedWordStyle = modifySelectedWordStyle;

  static deleteSelectedLayoutDataTable = deleteSelectedLayoutDataTable;

  static deleteSelectedLayoutRegion = deleteSelectedLayoutRegion;

  static applyHighlight = applyHighlight;

  static removeHighlight = removeHighlight;

  static modifyHighlightComment = modifyHighlightComment;

  static updateHighlightGroupOutline = updateHighlightGroupOutline;
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

let mouseDownTarget;

/**
 * @typedef {import('./js/konva/Node.js').KonvaEventObject<MouseEvent>} KonvaMouseEvent
 * @typedef {import('./js/konva/Node.js').KonvaEventObject<TouchEvent>} KonvaTouchEvent
 * @typedef {import('./js/konva/Node.js').KonvaEventObject<WheelEvent>} KonvaWheelEvent
 */

/**
 * Class for managing the selection of words, layout boxes, and data columns on the canvas.
 * Only one canvas should be used at a time, as most properties are static.
 */
export class ScribeViewer {
  /** @type {HTMLElement} */
  static elem;

  /** @type {HTMLDivElement} */
  static HTMLOverlayBackstopElem;

  static textOverlayHidden = false;

  /** @type {Array<number>} */
  static #pageStopsStart = [];

  /** @type {Array<number>} */
  static #pageStopsEnd = [];

  /**
   *
   * @param {number} n
   * @param {boolean} start
   * @returns {number}
   */
  static getPageStop = (n, start = true) => {
    // This needs to be here to prevent `ScribeCanvas.calcPageStops` from being called before the final page dimensions are known.
    // This is an issue when a PDF is being uploaded alongside existing OCR data, as the correct dimensions are not known until the OCR data is parsed.
    if (start && n === 0) return 30;

    if (start && ScribeViewer.#pageStopsStart[n]) return ScribeViewer.#pageStopsStart[n];
    if (!start && ScribeViewer.#pageStopsEnd[n]) return ScribeViewer.#pageStopsEnd[n];

    ScribeViewer.calcPageStops();

    if (start && ScribeViewer.#pageStopsStart[n]) return ScribeViewer.#pageStopsStart[n];
    if (!start && ScribeViewer.#pageStopsEnd[n]) return ScribeViewer.#pageStopsEnd[n];

    // The `null` condition is only true briefly during initialization, and is not worth checking for every time throughout the program.
    // @ts-ignore
    return null;
  };

  /** @type {?Function} */
  static displayPageCallback = null;

  /** @type {Array<InstanceType<typeof Konva.Rect>>} */
  static placeholderRectArr = [];

  static calcPageStops = () => {
    const margin = 30;
    let y = margin;
    for (let i = 0; i < scribe.data.pageMetrics.length; i++) {
      ScribeViewer.#pageStopsStart[i] = y;
      const dims = scribe.data.pageMetrics[i]?.dims;
      if (!dims) return;

      // TODO: This does not work because angle is not populated at this point.
      // This is true even when uploading a PDF with existing OCR data, as dims are defined before parsing the OCR data.
      const rotation = (scribe.data.pageMetrics[i].angle || 0) * -1;
      y += dims.height + margin;
      ScribeViewer.#pageStopsEnd[i] = y;

      if (!ScribeViewer.placeholderRectArr[i]) {
        ScribeViewer.placeholderRectArr[i] = new Konva.Rect({
          x: 0,
          y: ScribeViewer.getPageStop(i),
          width: dims.width,
          height: dims.height,
          stroke: 'black',
          strokeWidth: 2,
          strokeScaleEnabled: false,
          listening: false,
          rotation,
        });
        ScribeViewer.layerBackground.add(ScribeViewer.placeholderRectArr[i]);
      }
    }
  };

  /**
   *
   * @returns {{x: number, y: number}}
   */
  static getStageCenter = () => {
    const layerWidth = ScribeViewer.stage.width();
    const layerHeight = ScribeViewer.stage.height();

    // Calculate the center point of the layer before any transformations
    const centerPoint = {
      x: layerWidth / 2,
      y: layerHeight / 2,
    };

    return centerPoint;
  };

  /**
   *
   * @param {InstanceType<typeof Konva.Layer>|InstanceType<typeof Konva.Stage>} layer
   * @param {number} scaleBy
   * @param {{x: number, y: number}} center - The center point to zoom in/out from.
   */
  static _zoomStageImp = (layer, scaleBy, center) => {
    const oldScale = layer.scaleX();

    const mousePointTo = {
      x: (center.x - layer.x()) / oldScale,
      y: (center.y - layer.y()) / oldScale,
    };

    const newScale = oldScale * scaleBy;

    layer.scaleX(newScale);
    layer.scaleY(newScale);

    const newPos = {
      x: center.x - mousePointTo.x * newScale,
      y: center.y - mousePointTo.y * newScale,
    };

    layer.position(newPos);
  };

  /**
   *
   * @param {number} scaleBy
   * @param {?{x: number, y: number}} [center=null] - The center point to zoom in/out from.
   *    If `null` (default), the center of the layer is used.
   */
  static _zoomStage = (scaleBy, center = null) => {
    if (!center) {
      const selectedWords = ScribeViewer.CanvasSelection.getKonvaWords();

      // If words are selected, zoom in on the selection.
      if (selectedWords.length > 0) {
        const selectionLeft = Math.min(...selectedWords.map((x) => x.x()));
        const selectionRight = Math.max(...selectedWords.map((x) => x.x() + x.width()));
        const selectionTop = Math.min(...selectedWords.map((x) => x.y()));
        const selectionBottom = Math.max(...selectedWords.map((x) => x.y() + x.height()));
        const center0 = { x: (selectionLeft + selectionRight) / 2, y: (selectionTop + selectionBottom) / 2 };

        const transform = ScribeViewer.layerText.getAbsoluteTransform();

        // Apply the transformation to the center point
        center = transform.point(center0);

        // Otherwise, zoom in on the center of the text layer.
      } else {
        center = ScribeViewer.getStageCenter();
      }
    }

    ScribeViewer._zoomStageImp(ScribeViewer.stage, scaleBy, center);

    if (!ScribeViewer.updateCurrentPage()) {
      ScribeViewer.stage.batchDraw();
    }
  };

  static updateCurrentPage = () => {
    const y = (ScribeViewer.stage.y() - ScribeViewer.stage.height() / 2) / ScribeViewer.stage.getAbsoluteScale().y * -1;
    const pageNew = ScribeViewer.calcPage(y);

    if (stateViewer.cp.n !== pageNew && pageNew >= 0) {
      ScribeViewer.displayPage(pageNew, false, false);
      return true;
    }
    return false;
  };

  /**
   *
   * @param {Object} coords
   * @param {number} [coords.deltaX=0]
   * @param {number} [coords.deltaY=0]
   */
  static panStage = ({ deltaX = 0, deltaY = 0 }) => {
    const x = ScribeViewer.stage.x();
    const y = ScribeViewer.stage.y();

    // Clip the inputs to prevent the user from panning the entire document outside of the viewport.
    if (stateViewer.cp.n === 0) {
      const maxY = (ScribeViewer.getPageStop(0) - 100) * ScribeViewer.stage.getAbsoluteScale().y * -1 + ScribeViewer.stage.height() / 2;
      const maxYDelta = Math.max(0, maxY - y);
      deltaY = Math.min(deltaY, maxYDelta);
    }

    if (stateViewer.cp.n === scribe.data.pageMetrics.length - 1) {
      const minY = ScribeViewer.getPageStop(stateViewer.cp.n, false) * ScribeViewer.stage.getAbsoluteScale().y * -1
        + ScribeViewer.stage.height() / 2;
      const minYDelta = Math.max(0, y - minY);
      deltaY = Math.max(deltaY, -minYDelta);
    }

    // Prevent panning the document outside of the viewport.
    // These limits impose the less restrictive of:
    // (1) half of the document must be within the viewport, or
    // (2) half of the viewport must contain the document.
    const minX1 = (scribe.data.pageMetrics[stateViewer.cp.n].dims.width / 2) * ScribeViewer.stage.getAbsoluteScale().y * -1;
    const minX2 = scribe.data.pageMetrics[stateViewer.cp.n].dims.width * ScribeViewer.stage.getAbsoluteScale().y * -1 + ScribeViewer.stage.width() / 2;
    const minX = Math.min(minX1, minX2);
    const minXDelta = Math.max(0, x - minX);
    deltaX = Math.max(deltaX, -minXDelta);

    const maxX1 = (scribe.data.pageMetrics[stateViewer.cp.n].dims.width / 2) * ScribeViewer.stage.getAbsoluteScale().y * -1
      + ScribeViewer.stage.width();
    const maxX2 = ScribeViewer.stage.width() / 2;
    const maxX = Math.max(maxX1, maxX2);
    const maxXDelta = Math.max(0, maxX - x);
    deltaX = Math.min(deltaX, maxXDelta);

    ScribeViewer.stage.x(x + deltaX);
    ScribeViewer.stage.y(y + deltaY);

    if (!ScribeViewer.updateCurrentPage()) {
      ScribeViewer.stage.batchDraw();
    }
  };

  /**
   * Zoom in or out on the canvas.
   * This function should be used for mapping buttons or other controls to zooming,
   * as it handles redrawing the text overlay in addition to zooming the canvas.
   * @param {number} scaleBy
   * @param {?{x: number, y: number}} [center=null] - The center point to zoom in/out from.
   *    If `null` (default), the center of the layer is used.
   */
  static zoom = (scaleBy, center = null) => {
    ScribeViewer.deleteHTMLOverlay();
    ScribeViewer._zoomStage(scaleBy, center);
    if (ScribeViewer.enableHTMLOverlay) ScribeViewer.renderHTMLOverlayAfterDelay();
  };

  /**
   * Initiates dragging if the middle mouse button is pressed.
   * @param {MouseEvent} event
   */
  static startDrag = (event) => {
    ScribeViewer.deleteHTMLOverlay();
    ScribeViewer.drag.isDragging = true;
    ScribeViewer.drag.lastX = event.x;
    ScribeViewer.drag.lastY = event.y;
    event.preventDefault();
  };

  /**
   * Initiates dragging if the middle mouse button is pressed.
   * @param {KonvaTouchEvent} event
   */
  static startDragTouch = (event) => {
    ScribeViewer.deleteHTMLOverlay();
    ScribeViewer.drag.isDragging = true;
    ScribeViewer.drag.lastX = event.evt.touches[0].clientX;
    ScribeViewer.drag.lastY = event.evt.touches[0].clientY;
    event.evt.preventDefault();
  };

  /**
   * Updates the layer's position based on mouse movement.
   * @param {KonvaMouseEvent} event
   */
  static executeDrag = (event) => {
    if (ScribeViewer.drag.isDragging) {
      const deltaX = event.evt.x - ScribeViewer.drag.lastX;
      const deltaY = event.evt.y - ScribeViewer.drag.lastY;

      if (Math.round(deltaX) === 0 && Math.round(deltaY) === 0) return;

      // This is an imprecise heuristic, so not bothering to calculate distance properly.
      ScribeViewer.drag.dragDeltaTotal += Math.abs(deltaX);
      ScribeViewer.drag.dragDeltaTotal += Math.abs(deltaY);

      ScribeViewer.drag.lastX = event.evt.x;
      ScribeViewer.drag.lastY = event.evt.y;

      ScribeViewer.panStage({ deltaX, deltaY });
    }
  };

  /**
   * @param {KonvaTouchEvent} event
   */
  static executeDragTouch = (event) => {
    if (ScribeViewer.drag.isDragging) {
      const deltaX = event.evt.touches[0].clientX - ScribeViewer.drag.lastX;
      const deltaY = event.evt.touches[0].clientY - ScribeViewer.drag.lastY;
      ScribeViewer.drag.lastX = event.evt.touches[0].clientX;
      ScribeViewer.drag.lastY = event.evt.touches[0].clientY;

      ScribeViewer.panStage({ deltaX, deltaY });
    }
  };

  /**
   * Stops dragging when the mouse button is released.
   * @param {KonvaMouseEvent|KonvaTouchEvent} event
   */
  static stopDragPinch = (event) => {
    ScribeViewer.drag.isDragging = false;
    ScribeViewer.drag.isPinching = false;
    ScribeViewer.drag.dragDeltaTotal = 0;
    ScribeViewer.drag.lastCenter = null;
    ScribeViewer.drag.lastDist = null;
    if (ScribeViewer.enableHTMLOverlay && ScribeViewer._wordHTMLArr.length === 0) {
      ScribeViewer.renderHTMLOverlay();
    }
  };

  /**
   * @param {KonvaTouchEvent} event
   */
  static executePinchTouch = (event) => {
    ScribeViewer.deleteHTMLOverlay();
    const touch1 = event.evt.touches[0];
    const touch2 = event.evt.touches[1];
    if (!touch1 || !touch2) return;
    ScribeViewer.drag.isPinching = true;
    const p1 = {
      x: touch1.clientX,
      y: touch1.clientY,
    };
    const p2 = {
      x: touch2.clientX,
      y: touch2.clientY,
    };

    const center = getCenter(p1, p2);
    const dist = getDistance(p1, p2);

    if (!ScribeViewer.drag.lastDist || !ScribeViewer.drag.lastCenter) {
      ScribeViewer.drag.lastCenter = center;
      ScribeViewer.drag.lastDist = dist;
      return;
    }

    ScribeViewer._zoomStage(dist / ScribeViewer.drag.lastDist, center);
    ScribeViewer.drag.lastDist = dist;
    if (ScribeViewer.enableHTMLOverlay) ScribeViewer.renderHTMLOverlayAfterDelay();
  };

  /**
   * Function called after the canvas is interacted with, whether by a click or a keyboard event.
   * @param {*} event
   */
  static interactionCallback = (event) => {};

  /**
   * Function called after controls are destroyed.
   * @param {boolean} deselect
   */
  static destroyControlsCallback = (deselect) => {};

  /**
   *
   * @param {HTMLDivElement} elem
   * @param {number} width
   * @param {number} height
   */
  static init(elem, width, height) {
    this.elem = elem;

    ScribeViewer.stage = new Konva.Stage({
      container: elem,
      // width: document.documentElement.clientWidth,
      // height: document.documentElement.clientHeight,
      // width: this.elem.scrollWidth,
      // height: this.elem.scrollHeight,
      width,
      height,

    });

    ScribeViewer.stage.on('contextmenu', contextMenuFunc);

    ScribeViewer.HTMLOverlayBackstopElem = document.createElement('div');
    ScribeViewer.HTMLOverlayBackstopElem.className = 'endOfContent';
    ScribeViewer.HTMLOverlayBackstopElem.style.position = 'absolute';
    ScribeViewer.HTMLOverlayBackstopElem.style.top = '0';
    ScribeViewer.HTMLOverlayBackstopElem.style.left = '0';
    ScribeViewer.HTMLOverlayBackstopElem.style.width = `${width}px`;
    ScribeViewer.HTMLOverlayBackstopElem.style.height = `${height}px`;
    ScribeViewer.HTMLOverlayBackstopElem.style.display = 'none';

    ScribeViewer.layerBackground = new Konva.Layer();
    ScribeViewer.layerText = new Konva.Layer();
    ScribeViewer.layerOverlay = new Konva.Layer();

    ScribeViewer.stage.add(ScribeViewer.layerBackground);
    ScribeViewer.stage.add(ScribeViewer.layerText);
    ScribeViewer.stage.add(ScribeViewer.layerOverlay);

    ScribeViewer.selectingRectangle = new Konva.Rect({
      fill: 'rgba(40,123,181,0.5)',
      visible: true,
      // disable events to not interrupt with events
      listening: false,
    });

    ScribeViewer.layerText.add(ScribeViewer.selectingRectangle);

    ScribeViewer.stage.on('mousemove', ScribeViewer.executeDrag);

    ScribeViewer.stage.on('touchstart', (event) => {
      if (ScribeViewer.mode === 'select') {
        if (event.evt.touches[1]) {
          ScribeViewer.executePinchTouch(event);
        } else {
          ScribeViewer.startDragTouch(event);
        }
      }
    });

    ScribeViewer.stage.on('touchmove', (event) => {
      if (event.evt.touches[1]) {
        ScribeViewer.executePinchTouch(event);
      } else if (ScribeViewer.drag.isDragging) {
        ScribeViewer.executeDragTouch(event);
      }
    });

    ScribeViewer.stage.on('mousedown touchstart', (event) => {
      if (scribe.data.pageMetrics.length === 0) return;

      // Left click only
      if (event.type === 'mousedown' && event.evt.button !== 0) return;

      if (!ScribeViewer.enableCanvasSelection) return;

      mouseDownTarget = event.target;

      if (ScribeViewer.isTouchScreen && ScribeViewer.mode === 'select') return;

      // Move selection rectangle to top.
      ScribeViewer.selectingRectangle.zIndex(ScribeViewer.layerText.children.length - 1);

      event.evt.preventDefault();
      const startCoords = ScribeViewer.layerText.getRelativePointerPosition() || { x: 0, y: 0 };
      ScribeViewer.bbox.left = startCoords.x;
      ScribeViewer.bbox.top = startCoords.y;
      ScribeViewer.bbox.right = startCoords.x;
      ScribeViewer.bbox.bottom = startCoords.y;

      ScribeViewer.selectingRectangle.width(0);
      ScribeViewer.selectingRectangle.height(0);
      ScribeViewer.selecting = true;
    });

    ScribeViewer.stage.on('mousemove touchmove', (e) => {
      e.evt.preventDefault();
      // do nothing if we didn't start selection
      if (!ScribeViewer.selecting) {
        return;
      }
      e.evt.preventDefault();
      const endCoords = ScribeViewer.layerText.getRelativePointerPosition();
      if (!endCoords) return;

      ScribeViewer.bbox.right = endCoords.x;
      ScribeViewer.bbox.bottom = endCoords.y;

      ScribeViewer.selectingRectangle.setAttrs({
        visible: true,
        x: Math.min(ScribeViewer.bbox.left, ScribeViewer.bbox.right),
        y: Math.min(ScribeViewer.bbox.top, ScribeViewer.bbox.bottom),
        width: Math.abs(ScribeViewer.bbox.right - ScribeViewer.bbox.left),
        height: Math.abs(ScribeViewer.bbox.bottom - ScribeViewer.bbox.top),
      });

      ScribeViewer.layerText.batchDraw();
    });

    ScribeViewer.stage.on('mouseup touchend', (event) => {
      // const navBarElem = /** @type {HTMLDivElement} */(document.getElementById('navBar'));
      // const activeElem = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // if (activeElem && navBarElem.contains(activeElem)) activeElem.blur();

      // For dragging layout boxes, other events are needed to stop the drag.
      if (!stateViewer.layoutMode) {
        event.evt.preventDefault();
        event.evt.stopPropagation();
      }

      const mouseUpTarget = event.target;

      const editingWord = !!ScribeViewer.KonvaIText.input;

      // If a word is being edited, the only action allowed is clicking outside the word to deselect it.
      if (editingWord) {
        if (mouseDownTarget === ScribeViewer.KonvaIText.inputWord || mouseUpTarget === ScribeViewer.KonvaIText.inputWord) {
          ScribeViewer.selecting = false;
          return;
        }
        ScribeViewer.destroyControls();
        ScribeViewer.layerText.batchDraw();

      // Delete any current selections if either (1) this is a new selection or (2) nothing is being clicked.
      // Clicks must pass this check on both start and end.
      // This prevents accidentally clearing a selection when the user is trying to highlight specific letters, but the mouse up happens over another word.
      } else if (event.evt.button === 0 && (mouseUpTarget instanceof Konva.Stage || mouseUpTarget instanceof Konva.Image)
        && (ScribeViewer.selecting || event.target instanceof Konva.Stage || event.target instanceof Konva.Image)) {
        ScribeViewer.destroyControls();
      }

      ScribeViewer.selecting = false;

      // Return early if this was a drag or pinch rather than a selection.
      // `isDragging` will be true even for a touch event, so a minimum distance moved is required to differentiate between a click and a drag.
      if (event.evt.button === 1 || (ScribeViewer.drag.isDragging && ScribeViewer.drag.dragDeltaTotal > 10) || ScribeViewer.drag.isPinching || ScribeViewer.drag.isResizingColumns) {
        ScribeViewer.stopDragPinch(event);
        return;
      }

      mouseupFunc2(event);

      ScribeViewer.mode = 'select';

      ScribeViewer.layerText.batchDraw();
    });
  }

  static renderHTMLOverlay = () => {
    const words = ScribeViewer.getKonvaWords();
    // Words are wrapped in a per-line <div> so that browser triple-click selects a single line,
    // matching the behavior of other PDF viewers and text applications. Without a block ancestor
    // per line, triple-click would select every word on the page.
    const lineToElem = new Map();
    words.forEach((word) => {
      const elem = KonvaIText.itextToElem(word);
      ScribeViewer._wordHTMLArr.push(elem);

      const line = word.word.line;
      let lineElem = lineToElem.get(line);
      if (!lineElem) {
        lineElem = document.createElement('div');
        lineElem.classList.add('scribe-line');
        lineToElem.set(line, lineElem);
        ScribeViewer._lineHTMLArr.push(lineElem);
        ScribeViewer.elem.appendChild(lineElem);
      }
      lineElem.appendChild(elem);
    });
  };

  static _renderHTMLOverlayEvents = 0;

  /**
   * Render the HTML overlay after 150ms, if no other events have been triggered in the meantime.
   * This function should be called whenever a frequently-triggered event needs to render the HTML overlay,
   * such as scrolling or zooming, which can result in performance issues if the overlay is rendered too frequently.
   */
  static renderHTMLOverlayAfterDelay = () => {
    ScribeViewer._renderHTMLOverlayEvents++;
    const eventN = ScribeViewer._renderHTMLOverlayEvents;
    setTimeout(() => {
      if (eventN === ScribeViewer._renderHTMLOverlayEvents && ScribeViewer._wordHTMLArr.length === 0) {
        ScribeViewer.renderHTMLOverlay();
      }
    }, 200);
  };

  static deleteHTMLOverlay = () => {
    ScribeViewer._wordHTMLArr.forEach((elem) => {
      if (elem.parentNode) {
        elem.parentNode.removeChild(elem);
      }
    });
    ScribeViewer._wordHTMLArr.length = 0;
    ScribeViewer._lineHTMLArr.forEach((elem) => {
      if (elem.parentNode) {
        elem.parentNode.removeChild(elem);
      }
    });
    ScribeViewer._lineHTMLArr.length = 0;
  };

  static runSetInitial = true;

  /**
   * Set the initial position and zoom of the canvas to reasonable defaults.
   * @param {dims} imgDims - Dimensions of image
   */
  static setInitialPositionZoom = (imgDims) => {
    ScribeViewer.runSetInitial = false;

    const totalHeight = document.documentElement.clientHeight;

    const interfaceHeight = 100;
    const bottomMarginHeight = 50;
    const targetHeight = totalHeight - interfaceHeight - bottomMarginHeight;

    const zoom = targetHeight / imgDims.height;

    ScribeViewer.stage.scaleX(zoom);
    ScribeViewer.stage.scaleY(zoom);
    ScribeViewer.stage.x(((ScribeViewer.stage.width() - (imgDims.width * zoom)) / 2));
    ScribeViewer.stage.y(interfaceHeight);
  };

  // Function that handles page-level info for rendering to canvas
  static renderWords = async (n) => {
    let ocrData = scribe.data.ocr.active?.[n];

    // Return early if there is not enough data to render a page yet
    // (0) Necessary info is not defined yet
    const noInfo = scribe.inputData.xmlMode[n] === undefined;
    // (1) No data has been imported
    const noInput = !scribe.inputData.xmlMode[n] && !(scribe.inputData.imageMode || scribe.inputData.pdfMode);
    // (2) XML data should exist but does not (yet)
    const xmlMissing = scribe.inputData.xmlMode[n]
    && (ocrData === undefined || ocrData === null || scribe.data.pageMetrics[n].dims === undefined);

    const pageStopsMissing = ScribeViewer.getPageStop(n) === null;

    const imageMissing = false;
    const pdfMissing = false;

    if (ScribeViewer.#textGroups[n]) {
      for (const group of Object.values(ScribeViewer.#textGroups[n])) {
        group.destroyChildren();
      }
    }

    if (ScribeViewer.KonvaIText.inputWord && ScribeViewer.KonvaIText.inputWord.word.line.page.n === n
      && ScribeViewer.KonvaIText.inputRemove
    ) {
      ScribeViewer.KonvaIText.inputRemove();
    }
    ScribeViewer.CanvasSelection.deselectAllWords(n);

    if (noInfo || noInput || xmlMissing || imageMissing || pdfMissing || pageStopsMissing) {
      return;
    }

    if (scribe.inputData.evalMode) {
      await compareGroundTruth();
      // ocrData must be re-assigned after comparing to ground truth or it will not update.
      ocrData = scribe.data.ocr.active?.[n];
    }

    if (scribe.inputData.xmlMode[n]) {
      renderCanvasWords(ocrData);
    }
  };

  /**
   * Render page `n` in the UI.
   * @param {number} n
   * @param {boolean} [scroll=false] - Scroll to the top of the page being rendered.
   * @param {boolean} [refresh=true] - Refresh the page even if it is already displayed.
   * @returns
   */
  static async displayPage(n, scroll = false, refresh = true) {
    // Return early if (1) page does not exist or (2) another page is actively being rendered.
    if (Number.isNaN(n) || n < 0 || n > (scribe.inputData.pageCount - 1)) {
      // Reset the value of pageNumElem (number in UI) to match the internal value of the page
      // elem.nav.pageNum.value = (stateGUI.cp.n + 1).toString();
      if (ScribeViewer.displayPageCallback) ScribeViewer.displayPageCallback();
      return;
    }

    if (ScribeViewer.runSetInitial) {
      ScribeViewer.setInitialPositionZoom(scribe.data.pageMetrics[n].dims);
    }

    ScribeViewer.deleteHTMLOverlay();

    if (scribe.inputData.xmlMode[stateViewer.cp.n]) {
      // TODO: This is currently run whenever the page is changed.
      // If this adds any meaningful overhead, we should only have stats updated when edits are actually made.
      search.updateFindStats();
    }

    if (scribe.opt.displayMode === 'ebook') {
      ScribeViewer.layerBackground.hide();
      ScribeViewer.layerBackground.batchDraw();
    } else {
      ScribeViewer.layerBackground.show();
      ScribeViewer.layerBackground.batchDraw();
    }

    ScribeViewer.textOverlayHidden = false;

    if (refresh || !ScribeViewer.textGroupsRenderIndices.includes(n)) {
      await ScribeViewer.renderWords(n);
    }

    if (n - 1 >= 0 && (refresh || !ScribeViewer.textGroupsRenderIndices.includes(n - 1))) {
      await ScribeViewer.renderWords(n - 1);
    }
    if (n + 1 < scribe.data.ocr.active.length && (refresh || !ScribeViewer.textGroupsRenderIndices.includes(n + 1))) {
      await ScribeViewer.renderWords(n + 1);
    }

    if (scroll) {
      ScribeViewer.stage.y((ScribeViewer.getPageStop(n) - 100) * ScribeViewer.stage.getAbsoluteScale().y * -1);
    }

    ScribeViewer.layerText.batchDraw();

    stateViewer.cp.n = n;

    ScribeViewer.destroyText();
    ScribeViewer.destroyOverlay();

    if (ScribeViewer.enableHTMLOverlay && !ScribeViewer.drag.isDragging && !ScribeViewer.drag.isPinching) {
      ScribeViewer.renderHTMLOverlayAfterDelay();
    }

    if (ScribeViewer.displayPageCallback) ScribeViewer.displayPageCallback();

    if (stateViewer.layoutMode) {
      if (refresh || !ScribeViewer.overlayGroupsRenderIndices.includes(n)) {
        layout.renderLayoutBoxes(n);
      }
      if (n - 1 >= 0 && (refresh || !ScribeViewer.overlayGroupsRenderIndices.includes(n - 1))) {
        layout.renderLayoutBoxes(n - 1);
      }
      if (n + 1 < scribe.data.ocr.active.length && (refresh || !ScribeViewer.overlayGroupsRenderIndices.includes(n + 1))) {
        layout.renderLayoutBoxes(n + 1);
      }
    }

    // Render background images ahead and behind current page to reduce delay when switching pages
    if ((scribe.inputData.pdfMode || scribe.inputData.imageMode)) {
      ViewerImageCache.renderAheadBehindBrowser(n);
    }
  }

  /** @type {InstanceType<typeof Konva.Stage>} */
  static stage;

  /** @type {InstanceType<typeof Konva.Layer>} */
  static layerBackground;

  /** @type {InstanceType<typeof Konva.Layer>} */
  static layerText;

  /** @type {InstanceType<typeof Konva.Layer>} */
  static layerOverlay;

  /** @type {Array<Object<string, InstanceType<typeof Konva.Group>>>} */
  static #textGroups = [];

  /**
   *
   * @param {number} n
   * @param {number} [orientation=0]
   */
  static createGroup = (n, orientation = 0) => {
    const group = new Konva.Group();
    const dims = scribe.data.pageMetrics[n].dims;
    const angle = scribe.data.pageMetrics[n].angle || 0;
    const textRotation = scribe.opt.autoRotate ? 0 : angle;
    const pageOffsetY = ScribeViewer.getPageStop(n) ?? 30;
    group.rotation(textRotation + orientation * 90);
    if (orientation % 2 === 1) {
      group.offset({ x: dims.height * 0.5, y: dims.width * 0.5 });
      group.position({ x: dims.width * 0.5, y: pageOffsetY + dims.height * 0.5 });
    } else {
      group.offset({ x: dims.width * 0.5, y: dims.height * 0.5 });
      group.position({ x: dims.width * 0.5, y: pageOffsetY + dims.height * 0.5 });
    }
    return group;
  };

  /**
   *
   * @param {number} n
   * @param {number} [orientation=0]
   * @returns
   */
  static getTextGroup = (n, orientation = 0) => {
    if (!ScribeViewer.#textGroups[n]) {
      ScribeViewer.#textGroups[n] = {};
    }
    if (!ScribeViewer.#textGroups[n][orientation]) {
      ScribeViewer.#textGroups[n][orientation] = ScribeViewer.createGroup(n, orientation);
      ScribeViewer.layerText.add(ScribeViewer.#textGroups[n][orientation]);
    }

    return ScribeViewer.#textGroups[n][orientation];
  };

  /**
   *
   * @param {number} n
   * @param {number} [rotation=0]
   * @returns
   */
  static setTextGroupRotation = (n, rotation = 0) => {
    ScribeViewer.getTextGroup(n);
    for (const [key, group] of Object.entries(ScribeViewer.#textGroups[n])) {
      group.rotation(Number(key) * 90 + rotation);
    }
  };

  /** @type {Array<InstanceType<typeof Konva.Group>>} */
  static #overlayGroups = [];

  /**
   *
   * @param {number} n
   * @returns
   */
  static getOverlayGroup = (n) => {
    if (!ScribeViewer.#overlayGroups[n]) {
      ScribeViewer.#overlayGroups[n] = ScribeViewer.createGroup(n);
      ScribeViewer.layerOverlay.add(ScribeViewer.#overlayGroups[n]);
    }
    return ScribeViewer.#overlayGroups[n];
  };

  /** @type {Array<number>} */
  static textGroupsRenderIndices = [];

  /** @type {Array<number>} */
  static overlayGroupsRenderIndices = [];

  static selectingRectangle;

  /**
   *
   * @param {number} y
   */
  static calcPage = (y) => {
    // Force page stops to be calculated if they are not already.
    if (ScribeViewer.#pageStopsEnd[ScribeViewer.#pageStopsEnd.length - 1] === undefined) {
      ScribeViewer.calcPageStops();
    }
    return ScribeViewer.#pageStopsEnd.findIndex((y1) => y1 > y);
  };

  static calcSelectionImageCoords = () => {
    const y = ScribeViewer.selectingRectangle.y();
    const n = ScribeViewer.calcPage(y);

    const box = ScribeViewer.selectingRectangle.getClientRect({ relativeTo: ScribeViewer.layerText });
    box.y -= ScribeViewer.getPageStop(n);

    const canvasCoordsPage = {
      left: box.x, top: box.y, width: box.width, height: box.height,
    };

    // This should always be running on a rotated image, as the recognize area button is only enabled after the angle is already known.
    const imageRotated = true;
    const angle = scribe.data.pageMetrics[n].angle || 0;

    const imageCoords = scribe.utils.coords.canvasToImage(canvasCoordsPage, imageRotated, scribe.opt.autoRotate, n, angle);

    imageCoords.left = Math.round(imageCoords.left);
    imageCoords.top = Math.round(imageCoords.top);
    imageCoords.width = Math.round(imageCoords.width);
    imageCoords.height = Math.round(imageCoords.height);

    // Restrict the rectangle to the page dimensions.
    const pageDims = scribe.data.pageMetrics[n].dims;
    const leftClip = Math.max(0, imageCoords.left);
    const topClip = Math.max(0, imageCoords.top);
    // Tesseract has a bug that subtracting 1 from the width and height (when setting the rectangle to the full image) fixes.
    // See: https://github.com/naptha/tesseract.js/issues/936
    const rightClip = Math.min(pageDims.width - 1, imageCoords.left + imageCoords.width);
    const bottomClip = Math.min(pageDims.height - 1, imageCoords.top + imageCoords.height);
    imageCoords.left = leftClip;
    imageCoords.top = topClip;
    imageCoords.width = rightClip - leftClip;
    imageCoords.height = bottomClip - topClip;

    return { box: imageCoords, n };
  };

  /** @type {?KonvaOcrWord} */
  static contextMenuWord = null;

  /** @type {Array<HTMLSpanElement>} */
  static _wordHTMLArr = [];

  /** @type {Array<HTMLDivElement>} */
  static _lineHTMLArr = [];

  /**
   * Contains the x and y coordinates of the last right-click event.
   * This is required for "right click" functions that are position-dependent,
   * as the cursor moves between the initial right click and selecting the option.
   */
  static contextMenuPointer = { x: 0, y: 0 };

  static selecting = false;

  static enableCanvasSelection = false;

  static enableHTMLOverlay = false;

  static CanvasSelection = CanvasSelection;

  static Konva = Konva;

  static KonvaIText = KonvaIText;

  static KonvaOcrWord = KonvaOcrWord;

  static KonvaLayout = KonvaLayout;

  static ViewerImageCache = ViewerImageCache;

  static state = stateViewer;

  static opt = optViewer;

  static search = search;

  static layout = layout;

  static getAllFileEntries = getAllFileEntries;

  static setWordColorOpacity = setWordColorOpacity;

  static compareGroundTruth = compareGroundTruth;

  static renderCanvasWords = renderCanvasWords;

  static evalStats = evalStats;

  /** @type {bbox} */
  static bbox = {
    top: 0, left: 0, right: 0, bottom: 0,
  };

  /** @type {('select'|'addWord'|'recognizeWord'|'recognizeArea'|'printCoords'|'addLayoutBoxOrder'|'addLayoutBoxExclude'|'addLayoutBoxDataTable')} */
  static mode = 'select';

  static isTouchScreen = navigator?.maxTouchPoints > 0;

  static drag = {
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

  static getKonvaWords = () => {
    /** @type {Array<KonvaOcrWord>} */
    const words = [];
    if (ScribeViewer.#textGroups[stateViewer.cp.n - 1]) {
      for (const group of Object.values(ScribeViewer.#textGroups[stateViewer.cp.n - 1])) {
        group.children.forEach((x) => {
          if (x instanceof KonvaOcrWord) words.push(x);
        });
      }
    }

    if (ScribeViewer.#textGroups[stateViewer.cp.n]) {
      for (const group of Object.values(ScribeViewer.#textGroups[stateViewer.cp.n])) {
        group.children.forEach((x) => {
          if (x instanceof KonvaOcrWord) words.push(x);
        });
      }
    }

    if (ScribeViewer.#textGroups[stateViewer.cp.n + 1]) {
      for (const group of Object.values(ScribeViewer.#textGroups[stateViewer.cp.n + 1])) {
        group.children.forEach((x) => {
          if (x instanceof KonvaOcrWord) words.push(x);
        });
      }
    }

    return words;
  };

  static getKonvaRegions = () => {
    /** @type {Array<KonvaRegion>} */
    const regions = [];
    if (ScribeViewer.#overlayGroups[stateViewer.cp.n - 1]?.children) {
      ScribeViewer.#overlayGroups[stateViewer.cp.n - 1].children.forEach((x) => {
        if (x instanceof KonvaRegion) regions.push(x);
      });
    }
    if (ScribeViewer.#overlayGroups[stateViewer.cp.n]?.children) {
      ScribeViewer.#overlayGroups[stateViewer.cp.n].children.forEach((x) => {
        if (x instanceof KonvaRegion) regions.push(x);
      });
    }
    if (ScribeViewer.#overlayGroups[stateViewer.cp.n + 1]?.children) {
      ScribeViewer.#overlayGroups[stateViewer.cp.n + 1].children.forEach((x) => {
        if (x instanceof KonvaRegion) regions.push(x);
      });
    }

    return regions;
  };

  static getKonvaDataColumns = () => {
    /** @type {Array<KonvaDataColumn>} */
    const columns = [];
    if (ScribeViewer.#overlayGroups[stateViewer.cp.n - 1]?.children) {
      ScribeViewer.#overlayGroups[stateViewer.cp.n - 1].children.forEach((x) => {
        if (x instanceof KonvaDataColumn) columns.push(x);
      });
    }
    if (ScribeViewer.#overlayGroups[stateViewer.cp.n]?.children) {
      ScribeViewer.#overlayGroups[stateViewer.cp.n].children.forEach((x) => {
        if (x instanceof KonvaDataColumn) columns.push(x);
      });
    }
    if (ScribeViewer.#overlayGroups[stateViewer.cp.n + 1]?.children) {
      ScribeViewer.#overlayGroups[stateViewer.cp.n + 1].children.forEach((x) => {
        if (x instanceof KonvaDataColumn) columns.push(x);
      });
    }

    return columns;
  };

  static getDataTables = () => ([...new Set(ScribeViewer.getKonvaDataColumns().map((x) => x.layoutBox.table))]);

  static getKonvaDataTables = () => ([...new Set(ScribeViewer.getKonvaDataColumns().map((x) => x.konvaTable))]);

  /**
   *
   * @param {boolean} [deselect=true] - Deselect all words, layout boxes, and data columns.
   */
  static destroyControls = (deselect = true) => {
    // elem.edit.collapseRangeBaselineBS.hide();
    ScribeViewer.KonvaOcrWord._controlArr.forEach((control) => control.destroy());
    ScribeViewer.KonvaOcrWord._controlArr.length = 0;

    if (deselect) ScribeViewer.CanvasSelection.deselectAll();

    if (ScribeViewer.KonvaIText.inputRemove) ScribeViewer.KonvaIText.inputRemove();

    ScribeViewer.destroyControlsCallback(deselect);
  };

  /**
   * Destroy objects in the overlay layer. By default, only objects outside the current view are destroyed.
   * @param {boolean} [outsideViewOnly=true] - If `true`, only destroy objects outside the current view.
   */
  static destroyOverlay = (outsideViewOnly = true) => {
    for (let i = 0; i < ScribeViewer.overlayGroupsRenderIndices.length; i++) {
      const n = ScribeViewer.overlayGroupsRenderIndices[i];
      if (Math.abs(n - stateViewer.cp.n) > 1 || !outsideViewOnly) {
        ScribeViewer.#overlayGroups[n].destroyChildren();
        ScribeViewer.overlayGroupsRenderIndices.splice(i, 1);
        i--;
      }
    }
  };

  /**
   * Destroy objects in the text layer. By default, only objects outside the current view are destroyed.
   * @param {boolean} [outsideViewOnly=true] - If `true`, only destroy objects outside the current view.
   */
  static destroyText = (outsideViewOnly = true) => {
    for (let i = 0; i < ScribeViewer.textGroupsRenderIndices.length; i++) {
      const n = ScribeViewer.textGroupsRenderIndices[i];
      if (Math.abs(n - stateViewer.cp.n) > 1 || !outsideViewOnly) {
        for (const group of Object.values(ScribeViewer.#textGroups[n])) {
          group.destroyChildren();
        }
        ScribeViewer.textGroupsRenderIndices.splice(i, 1);
        i--;
      }
    }
  };

  /** @type {?Range} */
  static _prevRange = null;

  static _prevStart = null;

  static _prevEnd = null;

  static _onSelection = (event) => {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);

    const focusWordElem = selection.focusNode?.nodeType === Node.ELEMENT_NODE ? selection.focusNode : selection.focusNode?.parentNode;

    if (!focusWordElem || !ScribeViewer._wordHTMLArr.includes(focusWordElem)) return;

    ScribeViewer.HTMLOverlayBackstopElem.style.display = '';

    focusWordElem.parentNode.insertBefore(ScribeViewer.HTMLOverlayBackstopElem, focusWordElem);

    ScribeViewer._prevRange = range.cloneRange();
  };
}

document.addEventListener('mouseup', () => {
  if (ScribeViewer.enableHTMLOverlay) {
    ScribeViewer.HTMLOverlayBackstopElem.style.display = 'none';
  }
});
document.addEventListener('touchend', () => {
  if (ScribeViewer.enableHTMLOverlay) {
    ScribeViewer.HTMLOverlayBackstopElem.style.display = 'none';
  }
});

document.addEventListener('selectionchange', ScribeViewer._onSelection);
document.addEventListener('mousedown', ScribeViewer._onSelection);

function getElementIdsInRange(range) {
  const elementIds = [];
  const treeWalker = document.createTreeWalker(
    range.commonAncestorContainer,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        // Check if the node is within the range and has the class 'scribe-word'
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

  ScribeViewer.textGroupsRenderIndices.sort((a, b) => a - b);

  let text = '';
  for (let i = 0; i < ScribeViewer.textGroupsRenderIndices.length; i++) {
    if (i > 0) text += '\n\n';
    const n = ScribeViewer.textGroupsRenderIndices[i];
    text += scribe.utils.writeText([scribe.data.ocr.active[n]], 0, 0, false, false, ids);
  }

  clipboardData.setData('text/plain', text);

  e.preventDefault(); // Prevent the default copy action
});

/**
 * Changes color and opacity of words based on the current display mode.
 */
function setWordColorOpacity() {
  ScribeViewer.getKonvaWords().forEach((obj) => {
    // const { opacity, fill } = getWordFillOpacityGUI(obj.word);

    const { fill, opacity } = scribe.utils.ocr.getWordFillOpacity(obj.word, scribe.opt.displayMode,
      scribe.opt.confThreshMed, scribe.opt.confThreshHigh, scribe.opt.overlayOpacity);

    obj.fill(fill);
    obj.opacity(opacity);
  });
}

async function compareGroundTruth() {
  const oemActive = Object.keys(scribe.data.ocr).find((key) => scribe.data.ocr[key] === scribe.data.ocr.active && key !== 'active');

  if (!oemActive) {
    console.error('No OCR data active');
    return;
  }

  const evalStatsConfigNew = {
    ocrActive: oemActive,
    ignorePunct: scribe.opt.ignorePunct,
    ignoreCap: scribe.opt.ignoreCap,
    ignoreExtra: scribe.opt.ignoreExtra,
  };
  /** @type {Parameters<typeof scribe.compareOCR>[2]} */
  const compOptions = {
    ignorePunct: scribe.opt.ignorePunct,
    ignoreCap: scribe.opt.ignoreCap,
    confThreshHigh: scribe.opt.confThreshHigh,
    confThreshMed: scribe.opt.confThreshMed,
  };

  // Compare all pages if this has not been done already with the current settings
  if (JSON.stringify(evalStatsConfig) !== JSON.stringify(evalStatsConfigNew) || evalStats.length === 0) {
    evalStatsConfig = evalStatsConfigNew;

    // TODO: This will overwrite any edits made by the user while `compareOCR` is running.
    // Is this a problem that is likely to occur in real use? If so, how should it be fixed?
    const res = await scribe.compareOCR(scribe.data.ocr.active, scribe.data.ocr['Ground Truth'], compOptions);

    scribe.data.ocr[oemActive] = res.ocr;
    scribe.data.ocr.active = scribe.data.ocr[oemActive];

    clearObjectProperties(evalStats);
    Object.assign(evalStats, res.metrics);
  }
}

/**
 *
 * @param {number} n
 * @param {bbox} box
 * @param {{x: number, y: number}} angleAdj
 * @param {number} index
 * @param {string} [label]
 * @param {number} [orientation=0]
 * @param {Array<OcrLine>} [lines] - When provided, the outline traces each line's
 *   left/right edges as a rectilinear polygon instead of a single bounding rectangle.
 */
const addBlockOutline = (n, box, angleAdj, index, label, orientation = 0, lines) => {
  const group = ScribeViewer.getTextGroup(n, orientation);

  const lineBoxes = (lines && lines.length > 0 ? lines.map((l) => l.bbox) : [box])
    .slice()
    .sort((a, b) => a.top - b.top);

  const yTopAt = (i) => (i === 0 ? lineBoxes[i].top : (lineBoxes[i - 1].bottom + lineBoxes[i].top) / 2);
  const yBottomAt = (i) => (i === lineBoxes.length - 1 ? lineBoxes[i].bottom : (lineBoxes[i].bottom + lineBoxes[i + 1].top) / 2);

  const points = [];
  for (let i = 0; i < lineBoxes.length; i++) {
    points.push(lineBoxes[i].right + angleAdj.x, yTopAt(i) + angleAdj.y);
    points.push(lineBoxes[i].right + angleAdj.x, yBottomAt(i) + angleAdj.y);
  }
  for (let i = lineBoxes.length - 1; i >= 0; i--) {
    points.push(lineBoxes[i].left + angleAdj.x, yBottomAt(i) + angleAdj.y);
    points.push(lineBoxes[i].left + angleAdj.x, yTopAt(i) + angleAdj.y);
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
};

/**
 *
 * @param {OcrPage} page
 */
function renderCanvasWords(page) {
  const angle = scribe.data.pageMetrics[page.n].angle || 0;
  const textRotation = scribe.opt.autoRotate ? 0 : angle;

  ScribeViewer.setTextGroupRotation(page.n, textRotation);

  if (!ScribeViewer.textGroupsRenderIndices.includes(page.n)) ScribeViewer.textGroupsRenderIndices.push(page.n);

  const matchIdArr = stateViewer.searchMode ? scribe.utils.ocr.getMatchingWordIds(search.search, scribe.data.ocr.active[page.n]) : [];

  const imageRotated = Math.abs(angle ?? 0) > 0.05;

  const pageAnnotations = scribe.data.annotations.pages[page.n] || [];

  if (optViewer.outlinePars && page) {
    // Do not overwrite paragraphs from programs with more advanced layout analysis.
    if (!page.textSource || !['textract', 'abbyy', 'google_vision', 'azure_doc_intel', 'docx'].includes(page.textSource)) {
      scribe.utils.assignParagraphs(page, angle);
    }

    page.pars.forEach((par, i) => {
      const angleAdj = imageRotated ? scribe.utils.ocr.calcLineStartAngleAdj(par.lines[0]) : { x: 0, y: 0 };
      addBlockOutline(page.n, par.bbox, angleAdj, i + 1, par.reason, par.lines[0]?.orientation ?? 0, par.lines);
    });
  }

  for (let i = 0; i < page.lines.length; i++) {
    const lineObj = page.lines[i];

    const group = ScribeViewer.getTextGroup(page.n, lineObj.orientation);

    const angleAdjLine = imageRotated ? scribe.utils.ocr.calcLineStartAngleAdj(lineObj) : { x: 0, y: 0 };

    if (optViewer.outlineLines) {
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

      const outlineWord = optViewer.outlineWords || scribe.opt.displayMode === 'eval' && wordObj.conf > scribe.opt.confThreshHigh && !wordObj.matchTruth;

      const angleAdjWord = imageRotated ? scribe.utils.ocr.calcWordAngleAdj(wordObj) : { x: 0, y: 0 };

      const visualBaseline = lineObj.bbox.bottom + lineObj.baseline[1] + angleAdjLine.y + angleAdjWord.y;

      let top = visualBaseline;
      if (wordObj.style.sup || wordObj.style.dropcap) top = wordObj.bbox.bottom + angleAdjLine.y + angleAdjWord.y;

      const visualLeft = wordObj.bbox.left + angleAdjLine.x + angleAdjWord.x;

      // Check if word falls within a highlight annotation
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
        listening: !stateViewer.layoutMode,
      });

      // Compute gap extensions for adjacent highlighted words.
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
 * Check if the wheel event was from a track pad by applying a series of heuristics.
 * This function should be generally reliable, although it is inherently heuristic-based,
 * so should be refined over time as more edge cases are encountered.
 * @param {WheelEvent} event
 */
const checkTrackPad = (event) => {
  // DeltaY is generally 100 or 120 for mice.
  if ([100, 120].includes(event.deltaY)) return false;
  // DeltaY will be multiplied by the zoom level.
  // While the user should not be zoomed in, this is accounted for here as a safeguard.
  // The `window.devicePixelRatio` value is generally the zoom level.
  // The known exceptions are:
  // For high-density (e.g. Retina) displays, `window.devicePixelRatio` is 2, but the zoom level is 1.
  // For Safari, this is bugged and `window.devicePixelRatio` does not scale with zooming.
  // https://bugs.webkit.org/show_bug.cgi?id=124862
  if ([100, 120].includes(Math.abs(Math.round(event.deltaY * window.devicePixelRatio * 1e5) / 1e5))) return false;

  // If delta is an integer, it is likely from a mouse.
  if (Math.round(event.deltaY) === event.deltaY) return false;

  // If none of the above conditions were met, it is likely from a track pad.
  return true;
};

/**
 * Handles the wheel event to scroll the layer vertically.
 * @param {WheelEvent} event - The wheel event from the user's mouse.
 */
const handleWheel = (event) => {
  ScribeViewer.deleteHTMLOverlay();
  event.preventDefault();
  event.stopPropagation();

  if (event.ctrlKey) { // Zoom in or out
    // Track pads report precise zoom values (many digits after the decimal) while mouses only move in fixed (integer) intervals.
    const trackPadMode = checkTrackPad(event);

    let delta = event.deltaY;

    // If `deltaMode` is `1` (less common), units are in lines rather than pixels.
    if (event.deltaMode === 1) delta *= 10;

    // Zoom by a greater amount for track pads.
    // Without this code, zooming would be extremely slow.
    if (trackPadMode) {
      delta *= 7;
      // Cap at the equivalent of ~6 scrolls of a scroll wheel.
      delta = Math.min(600, Math.max(-720, delta));
    }

    let scaleBy = 0.999 ** delta;
    if (scaleBy > 1.1) scaleBy = 1.1;
    if (scaleBy < 0.9) scaleBy = 0.9;

    ScribeViewer._zoomStage(scaleBy, ScribeViewer.stage.getPointerPosition());
    ScribeViewer.destroyControls();
  } else if (event.shiftKey) { // Scroll horizontally
    ScribeViewer.destroyControls();
    const deltaX = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX * -1 : event.deltaY * -1;
    ScribeViewer.panStage({ deltaX });
  } else { // Scroll vertically
    ScribeViewer.destroyControls();
    ScribeViewer.panStage({ deltaY: event.deltaY * -1, deltaX: event.deltaX * -1 });
  }
  if (ScribeViewer.enableHTMLOverlay) ScribeViewer.renderHTMLOverlayAfterDelay();
};

// Event listeners for mouse interactions.
// These are added to the document because adding only to the canvas does not work when overlay text is clicked.
// To avoid unintended interactions, the event listeners are only triggered when the target is within the canvas.
document.addEventListener('wheel', (event) => {
  if (event.target instanceof Node && ScribeViewer.elem.contains(event.target) && scribe.data.pageMetrics.length > 0) {
    handleWheel(event);
  }
}, { passive: false });

document.addEventListener('mousedown', (event) => {
  if (event.target instanceof Node && ScribeViewer.elem.contains(event.target) && scribe.data.pageMetrics.length > 0) {
    if (event.button === 1) { // Middle mouse button
      ScribeViewer.startDrag(event);
    }
  }
});

// Add various keyboard shortcuts.
document.addEventListener('keydown', handleKeyboardEvent);
