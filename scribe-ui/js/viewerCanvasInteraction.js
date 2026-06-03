/* eslint-disable import/no-cycle */
import scribe from '../../scribe.js';
import {
  ScribeViewer,
} from '../viewer.js';
import { Konva } from './konva/_FullInternals.js';
import {
  addLayoutBox,
  addLayoutDataTable,
  checkDataColumnsAdjacent, checkDataTablesAdjacent, KonvaDataColumn, KonvaLayout, mergeDataColumns, mergeDataTables, splitDataColumn, splitDataTable,
} from './viewerLayout.js';
import { KonvaOcrWord } from './viewerWordObjects.js';
import { deleteSelectedWord } from './viewerModifySelectedWords.js';
import { deleteSelectedLayoutDataTable, deleteSelectedLayoutRegion } from './viewerModifySelectedLayout.js';
import { annotMatchesWord, updateHighlightGroupOutline } from './viewerHighlights.js';

/**
 * Recognize area selected by user in Tesseract.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n - Page number.
 * @param {Object} box
 * @param {number} box.width
 * @param {number} box.height
 * @param {number} box.left
 * @param {number} box.top
 * @param {boolean} [wordMode=false] - Assume selection is single word.
 */
async function recognizeArea(viewer, n, box, wordMode = false) {
  if (box.width < 4 || box.height < 4) return;

  if (!viewer.doc.ocr.active[n]) {
    console.error('Base text layer must exist prior to recognizing area.');
    return;
  }

  const imageCoords = { ...box };

  const legacy = true;
  const lstm = true;

  const psm = wordMode ? '8' : '6';

  const upscale = viewer.doc.inputData.imageMode && scribe.ScribeDoc.defaults.enableUpscale;

  if (upscale) {
    imageCoords.left *= 2;
    imageCoords.top *= 2;
    imageCoords.width *= 2;
    imageCoords.height *= 2;
  }

  const pageDims = viewer.doc.pageMetrics[n].dims;
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
  if (imageCoords.width < 4 || imageCoords.height < 4) return;

  const res0 = await viewer.doc.recognizePageImp(n, legacy, lstm, true, { rectangle: imageCoords, tessedit_pageseg_mode: psm, upscale });

  let pageNew;
  if (legacy && lstm) {
    const resLegacy = await res0[0];
    const resLSTM = await res0[1];

    const pageObjLSTM = resLSTM.convert.lstm.pageObj;
    const pageObjLegacy = resLegacy.convert.legacy.pageObj;

    const debugLabel = 'recognizeArea';

    if (debugLabel && !viewer.doc.debug.debugImg[debugLabel]) {
      viewer.doc.debug.debugImg[debugLabel] = new Array(viewer.doc.images.pageCount);
      for (let i = 0; i < viewer.doc.images.pageCount; i++) {
        viewer.doc.debug.debugImg[debugLabel][i] = [];
      }
    }

    /** @type {Parameters<typeof viewer.doc.compareOCR>[2]} */
    const compOptions = {
      mode: 'comb',
      debugLabel,
      ignoreCap: scribe.ScribeDoc.defaults.ignoreCap,
      ignorePunct: scribe.ScribeDoc.defaults.ignorePunct,
      confThreshHigh: scribe.ScribeDoc.defaults.confThreshHigh,
      confThreshMed: scribe.ScribeDoc.defaults.confThreshMed,
      legacyLSTMComb: true,
    };

    const res = await viewer.doc.compareOCR([pageObjLegacy], [pageObjLSTM], compOptions);

    if (viewer.doc.debug.debugImg[debugLabel]) viewer.doc.debug.debugImg[debugLabel] = res.debug;

    pageNew = res.ocr[0];
  } else if (legacy) {
    const resLegacy = await res0[0];
    pageNew = resLegacy.convert.legacy.pageObj;
  } else {
    const resLSTM = await res0[0];
    pageNew = resLSTM.convert.lstm.pageObj;
  }

  scribe.combineOCRPage(pageNew, viewer.doc.ocr.active[n], viewer.doc.pageMetrics[n]);

  if (viewer.textGroupsRenderIndices.includes(n)) viewer.displayPage(viewer.state.cp.n);
}

/**
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n - Page number.
 * @param {Object} box
 * @param {number} box.width
 * @param {number} box.height
 * @param {number} box.left
 * @param {number} box.top
 */
async function addWordManual(viewer, n, box) {
  const wordText = 'A';
  let angleAdjXRect = 0;
  let angleAdjYRect = 0;
  let sinAngle = 0;
  let shiftX = 0;
  let shiftY = 0;
  if (scribe.ScribeDoc.defaults.autoRotate && Math.abs(viewer.doc.pageMetrics[n].angle ?? 0) > 0.05) {
    const rotateAngle = viewer.doc.pageMetrics[n].angle || 0;

    const pageDims = viewer.doc.pageMetrics[n].dims;

    sinAngle = Math.sin(rotateAngle * (Math.PI / 180));
    const cosAngle = Math.cos(rotateAngle * (Math.PI / 180));

    shiftX = sinAngle * (pageDims.height * 0.5) * -1 || 0;
    shiftY = sinAngle * ((pageDims.width - shiftX) * 0.5) || 0;

    const baselineY = (box.top + box.height) - (box.height) / 3;

    const angleAdjYInt = (1 - cosAngle) * (baselineY - shiftY) - sinAngle * (box.left - shiftX);
    const angleAdjXInt = sinAngle * ((baselineY - shiftY) - angleAdjYInt * 0.5);

    angleAdjXRect = angleAdjXInt + shiftX;
    angleAdjYRect = angleAdjYInt + shiftY;
  }

  const rectTopHOCR = box.top - angleAdjYRect;
  const rectBottomHOCR = box.top + box.height - angleAdjYRect;

  const rectLeftHOCR = box.left - angleAdjXRect;
  const rectRightHOCR = box.left + box.width - angleAdjXRect;

  const wordBox = {
    left: rectLeftHOCR, top: rectTopHOCR, right: rectRightHOCR, bottom: rectBottomHOCR,
  };

  const pageObj = new scribe.utils.ocr.OcrPage(n, viewer.doc.ocr.active[n].dims);
  const lineObjTemp = new scribe.utils.ocr.OcrLine(pageObj, wordBox, [0, 0], 10, null);
  pageObj.lines = [lineObjTemp];
  const wordIDNew = scribe.utils.getRandomAlphanum(10);
  const wordObj = new scribe.utils.ocr.OcrWord(lineObjTemp, wordIDNew, wordText, wordBox);
  wordObj.conf = 100;
  lineObjTemp.words = [wordObj];

  scribe.combineOCRPage(pageObj, viewer.doc.ocr.active[n], viewer.doc.pageMetrics[n], true, false);

  const wordObjNew = scribe.utils.ocr.getPageWord(viewer.doc.ocr.active[n], wordIDNew);

  if (!wordObjNew) throw new Error('Failed to add word to page.');

  const angle = viewer.doc.pageMetrics[n].angle || 0;
  const imageRotated = Math.abs(angle ?? 0) > 0.05;

  const angleAdjLine = imageRotated ? scribe.utils.ocr.calcLineStartAngleAdj(wordObjNew.line) : { x: 0, y: 0 };
  const angleAdjWord = imageRotated ? scribe.utils.ocr.calcWordAngleAdj(wordObj) : { x: 0, y: 0 };

  const linebox = wordObjNew.line.bbox;
  const baseline = wordObjNew.line.baseline;

  const visualBaseline = linebox.bottom + baseline[1] + angleAdjLine.y + angleAdjWord.y;

  const outlineWord = viewer.opt.outlineWords || viewer.state.displayMode === 'eval' && wordObj.conf > scribe.ScribeDoc.defaults.confThreshHigh && !wordObj.matchTruth;

  const wordCanvas = new KonvaOcrWord({
    visualLeft: box.left,
    yActual: visualBaseline,
    topBaseline: visualBaseline,
    rotation: 0,
    word: wordObj,
    outline: outlineWord,
    fillBox: false,
    listening: !viewer.state.layoutMode,
    viewer,
  });

  const group = viewer.getTextGroup(n);
  group.add(wordCanvas);

  viewer.layerText.batchDraw();
}

const createContextMenuHTML = () => {
  const menuDiv = document.createElement('div');
  menuDiv.id = 'scribe-context-menu';

  const innerDiv = document.createElement('div');

  const deleteWordsButton = document.createElement('button');
  deleteWordsButton.id = 'contextMenuDeleteWordsButton';
  deleteWordsButton.textContent = 'Delete Words';
  deleteWordsButton.style.display = 'none';
  deleteWordsButton.addEventListener('click', deleteWordsClick);

  const splitWordButton = document.createElement('button');
  splitWordButton.id = 'contextMenuSplitWordButton';
  splitWordButton.textContent = 'Split Word';
  splitWordButton.style.display = 'none';
  splitWordButton.addEventListener('click', splitWordClick);

  const mergeWordsButton = document.createElement('button');
  mergeWordsButton.id = 'contextMenuMergeWordsButton';
  mergeWordsButton.textContent = 'Merge Words';
  mergeWordsButton.style.display = 'none';
  mergeWordsButton.addEventListener('click', mergeWordsClick);

  const splitColumnButton = document.createElement('button');
  splitColumnButton.id = 'contextMenuSplitColumnButton';
  splitColumnButton.textContent = 'Split Column';
  splitColumnButton.style.display = 'none';
  splitColumnButton.addEventListener('click', splitDataColumnClick);

  const mergeButton = document.createElement('button');
  mergeButton.id = 'contextMenuMergeColumnsButton';
  mergeButton.textContent = 'Merge Columns';
  mergeButton.style.display = 'none';
  mergeButton.addEventListener('click', mergeDataColumnsClick);

  const deleteRegionButton = document.createElement('button');
  deleteRegionButton.id = 'contextMenuDeleteLayoutRegionButton';
  deleteRegionButton.textContent = 'Delete';
  deleteRegionButton.style.display = 'none';
  deleteRegionButton.addEventListener('click', deleteLayoutRegionClick);

  const deleteTableButton = document.createElement('button');
  deleteTableButton.id = 'contextMenuDeleteLayoutTableButton';
  deleteTableButton.textContent = 'Delete Table';
  deleteTableButton.style.display = 'none';
  deleteTableButton.addEventListener('click', deleteLayoutDataTableClick);

  const copyTableContentsButton = document.createElement('button');
  copyTableContentsButton.id = 'contextMenuCopyLayoutTableContentsButton';
  copyTableContentsButton.textContent = 'Copy Table Contents';
  copyTableContentsButton.style.display = 'none';
  copyTableContentsButton.addEventListener('click', copyTableContentsClick);

  const mergeTablesButton = document.createElement('button');
  mergeTablesButton.id = 'contextMenuMergeTablesButton';
  mergeTablesButton.textContent = 'Merge Tables';
  mergeTablesButton.style.display = 'none';
  mergeTablesButton.addEventListener('click', mergeDataTablesClick);

  const splitTableButton = document.createElement('button');
  splitTableButton.id = 'contextMenuSplitTableButton';
  splitTableButton.textContent = 'New Table from Columns';
  splitTableButton.style.display = 'none';
  splitTableButton.addEventListener('click', splitDataTableClick);

  const deleteHighlightButton = document.createElement('button');
  deleteHighlightButton.id = 'contextMenuDeleteHighlightButton';
  deleteHighlightButton.textContent = 'Delete Highlight';
  deleteHighlightButton.style.display = 'none';
  deleteHighlightButton.addEventListener('click', deleteHighlightClick);

  innerDiv.appendChild(deleteWordsButton);
  innerDiv.appendChild(splitWordButton);
  innerDiv.appendChild(mergeWordsButton);
  innerDiv.appendChild(splitColumnButton);
  innerDiv.appendChild(mergeButton);
  innerDiv.appendChild(deleteRegionButton);
  innerDiv.appendChild(deleteTableButton);
  innerDiv.appendChild(copyTableContentsButton);
  innerDiv.appendChild(mergeTablesButton);
  innerDiv.appendChild(splitTableButton);
  innerDiv.appendChild(deleteHighlightButton);

  menuDiv.appendChild(innerDiv);

  return menuDiv;
};

// The context menu is a singleton DOM element shared across viewers (only one can be visible at a
// time). When opened we store the owning viewer on `_menuViewer` and click handlers act on it.
/** @type {?import('../viewer.js').ScribeViewer} */
let _menuViewer = null;
function mv() { return _menuViewer || ScribeViewer.getDefault(); }

const splitWordClick = () => {
  hideContextMenu();
  const viewer = mv();
  const konvaWord = viewer.contextMenuWord;

  if (!konvaWord) return;

  const splitIndex = KonvaOcrWord.getCursorIndex(konvaWord);
  const { wordA, wordB } = scribe.utils.splitOcrWord(konvaWord.word, splitIndex, viewer.doc.fonts);

  const wordIndex = konvaWord.word.line.words.findIndex((x) => x.id === konvaWord.word.id);

  konvaWord.word.line.words.splice(wordIndex, 1, wordA, wordB);

  viewer.displayPage(viewer.state.cp.n);
};

const mergeWordsClick = () => {
  hideContextMenu();
  const viewer = mv();

  const selectedKonvaWords = viewer.CanvasSelection.getKonvaWords();
  const selectedWords = selectedKonvaWords.map((x) => x.word);
  if (selectedKonvaWords.length < 2 || !scribe.utils.checkOcrWordsAdjacent(selectedWords)) return;
  const newWord = scribe.utils.mergeOcrWords(selectedKonvaWords.map((x) => x.word));
  const lineWords = selectedKonvaWords[0].word.line.words;
  selectedKonvaWords.sort((a, b) => a.word.bbox.left - b.word.bbox.left);
  lineWords.sort((a, b) => a.bbox.left - b.bbox.left);
  const firstIndex = lineWords.findIndex((x) => x.id === selectedKonvaWords[0].word.id);
  lineWords.splice(firstIndex, selectedKonvaWords.length, newWord);

  viewer.displayPage(viewer.state.cp.n);
};

const deleteLayoutDataTableClick = () => {
  hideContextMenu();
  deleteSelectedLayoutDataTable(mv());
};

const deleteLayoutRegionClick = () => {
  hideContextMenu();
  deleteSelectedLayoutRegion(mv());
};

const copyTableContentsClick = () => {
  hideContextMenu();
  const viewer = mv();
  const selectedColumns = viewer.CanvasSelection.getKonvaDataColumns();
  if (selectedColumns.length === 0 || !navigator.clipboard) return;

  const table = document.createElement('table');

  if (!selectedColumns[0].konvaTable.tableContent) return;

  selectedColumns[0].konvaTable.tableContent.rowWordArr.forEach((row) => {
    const tr = document.createElement('tr');
    row.forEach((cell) => {
      const td = document.createElement('td');
      td.textContent = cell.map((word) => word.text).join(' ');
      tr.appendChild(td);
    });
    table.appendChild(tr);
  });

  navigator.clipboard.write([
    new ClipboardItem({
      'text/html': new Blob([table.outerHTML], { type: 'text/html' }),
      'text/plain': new Blob([table.innerText], { type: 'text/plain' }),
    }),
  ]);
};

const mergeDataColumnsClick = () => {
  hideContextMenu();
  const viewer = mv();
  mergeDataColumns(viewer.CanvasSelection.getKonvaDataColumns());
  viewer.destroyControls();
};

const mergeDataTablesClick = () => {
  hideContextMenu();
  const viewer = mv();
  const dataTableArr = viewer.CanvasSelection.getDataTables();
  mergeDataTables(dataTableArr);
  viewer.destroyControls();
};

const splitDataColumnClick = () => {
  hideContextMenu();
  const viewer = mv();
  const selectedColumns = viewer.CanvasSelection.getKonvaDataColumns();
  splitDataColumn(selectedColumns[0], viewer.contextMenuPointer.x);
  viewer.destroyControls();
};

const splitDataTableClick = () => {
  hideContextMenu();
  const viewer = mv();
  splitDataTable(viewer.CanvasSelection.getKonvaDataColumns());
  viewer.destroyControls();
};

const deleteHighlightClick = () => {
  hideContextMenu();
  const viewer = mv();

  const konvaWord = viewer.contextMenuWord;
  if (!konvaWord || !konvaWord.highlightColor) return;

  const n = konvaWord.word.line.page.n;
  const wb = konvaWord.word.bbox;
  const pageAnnotations = viewer.doc.annotations.pages[n];

  const matchingAnnot = pageAnnotations.find((annot) => annotMatchesWord(annot, wb));
  if (!matchingAnnot) return;

  viewer.doc.annotations.pages[n] = pageAnnotations.filter((annot) => annot.groupId !== matchingAnnot.groupId);
  for (const kw of viewer.getKonvaWords()) {
    if (kw.highlightGroupId === matchingAnnot.groupId) {
      kw.highlightColor = null;
      kw.highlightOpacity = 1;
      kw.highlightGroupId = null;
      kw.highlightComment = '';
      kw.highlightGapLeft = 0;
      kw.highlightGapRight = 0;
    }
  }

  updateHighlightGroupOutline(viewer);
  if (KonvaOcrWord.updateUI) KonvaOcrWord.updateUI();
  viewer.layerText.batchDraw();
};

const deleteWordsClick = () => {
  hideContextMenu();
  const viewer = mv();
  deleteSelectedWord(viewer);
  viewer.destroyControls();
};

// The context menu is built and its CSS injected on first use, so merely importing the viewer adds nothing to the host document.
// It uses a `scribe-`-prefixed id with id-scoped CSS and is a body-level popup positioned in document coordinates,
// so it cannot collide with host markup or styles.
/** @type {?HTMLElement} */
let menuNode = null;
/** @type {?HTMLStyleElement} */
let contextMenuStyleElem = null;
/** @type {HTMLButtonElement} */ let contextMenuSplitWordButtonElem;
/** @type {HTMLButtonElement} */ let contextMenuDeleteWordsButtonElem;
/** @type {HTMLButtonElement} */ let contextMenuMergeWordsButtonElem;
/** @type {HTMLButtonElement} */ let contextMenuMergeColumnsButtonElem;
/** @type {HTMLButtonElement} */ let contextMenuSplitColumnButtonElem;
/** @type {HTMLButtonElement} */ let contextMenuDeleteLayoutRegionButtonElem;
/** @type {HTMLButtonElement} */ let contextMenuDeleteLayoutTableButtonElem;
/** @type {HTMLButtonElement} */ let contextMenuCopyLayoutTableContentsButtonElem;
/** @type {HTMLButtonElement} */ let contextMenuMergeTablesButtonElem;
/** @type {HTMLButtonElement} */ let contextMenuSplitTableButtonElem;
/** @type {HTMLButtonElement} */ let contextMenuDeleteHighlightButtonElem;

function ensureContextMenu() {
  if (menuNode) return;
  menuNode = createContextMenuHTML();
  document.body.appendChild(menuNode);

  contextMenuSplitWordButtonElem = /** @type {HTMLButtonElement} */(document.getElementById('contextMenuSplitWordButton'));
  contextMenuDeleteWordsButtonElem = /** @type {HTMLButtonElement} */(document.getElementById('contextMenuDeleteWordsButton'));
  contextMenuMergeWordsButtonElem = /** @type {HTMLButtonElement} */(document.getElementById('contextMenuMergeWordsButton'));
  contextMenuMergeColumnsButtonElem = /** @type {HTMLButtonElement} */(document.getElementById('contextMenuMergeColumnsButton'));
  contextMenuSplitColumnButtonElem = /** @type {HTMLButtonElement} */(document.getElementById('contextMenuSplitColumnButton'));
  contextMenuDeleteLayoutRegionButtonElem = /** @type {HTMLButtonElement} */(document.getElementById('contextMenuDeleteLayoutRegionButton'));
  contextMenuDeleteLayoutTableButtonElem = /** @type {HTMLButtonElement} */(document.getElementById('contextMenuDeleteLayoutTableButton'));
  contextMenuCopyLayoutTableContentsButtonElem = /** @type {HTMLButtonElement} */(document.getElementById('contextMenuCopyLayoutTableContentsButton'));
  contextMenuMergeTablesButtonElem = /** @type {HTMLButtonElement} */(document.getElementById('contextMenuMergeTablesButton'));
  contextMenuSplitTableButtonElem = /** @type {HTMLButtonElement} */(document.getElementById('contextMenuSplitTableButton'));
  contextMenuDeleteHighlightButtonElem = /** @type {HTMLButtonElement} */(document.getElementById('contextMenuDeleteHighlightButton'));

  contextMenuStyleElem = document.createElement('style');
  contextMenuStyleElem.textContent = `
    #scribe-context-menu {
      display: none;
      position: absolute;
      width: min-content;
      background-color: white;
      box-shadow: 0 0 5px grey;
      border-radius: 3px;
    }
    #scribe-context-menu button {
      width: 100%;
      background-color: white;
      border: none;
      margin: 0;
      padding: 10px;
      text-wrap: nowrap;
      text-align: left;
    }
    #scribe-context-menu button:hover {
      background-color: lightgray;
    }`;
  document.head.appendChild(contextMenuStyleElem);
}

/** Remove the shared context menu and its styles from the document. */
export const destroyContextMenu = () => {
  menuNode?.remove();
  contextMenuStyleElem?.remove();
  menuNode = null;
  contextMenuStyleElem = null;
  _menuViewer = null;
};

export const hideContextMenu = () => {
  if (!menuNode) return;
  contextMenuMergeWordsButtonElem.style.display = 'none';
  contextMenuSplitWordButtonElem.style.display = 'none';
  contextMenuDeleteWordsButtonElem.style.display = 'none';
  contextMenuMergeColumnsButtonElem.style.display = 'none';
  contextMenuSplitColumnButtonElem.style.display = 'none';
  contextMenuDeleteLayoutRegionButtonElem.style.display = 'none';
  contextMenuDeleteLayoutTableButtonElem.style.display = 'none';
  contextMenuCopyLayoutTableContentsButtonElem.style.display = 'none';
  contextMenuMergeTablesButtonElem.style.display = 'none';
  contextMenuSplitTableButtonElem.style.display = 'none';
  contextMenuDeleteHighlightButtonElem.style.display = 'none';
  menuNode.style.display = 'none';
  _menuViewer = null;
};

export const contextMenuFunc = (viewer, event) => {
  ensureContextMenu();
  _menuViewer = viewer;
  try {
    const pointer = viewer.stage.getPointerPosition();
    const pointerRelative = viewer.layerOverlay.getRelativePointerPosition();

    if (!pointer || !pointerRelative) return;

    const selectedKonvaWords = viewer.CanvasSelection.getKonvaWords();
    const selectedWords = selectedKonvaWords.map((x) => x.word);
    const selectedColumns = viewer.CanvasSelection.getKonvaDataColumns();
    const selectedRegions = viewer.CanvasSelection.getKonvaRegions();

    viewer.contextMenuPointer = pointerRelative;

    let enableSplitWord = false;
    let enableMergeWords = false;
    let enableDeleteWords = false;
    let enableDeleteHighlight = false;
    if (!viewer.state.layoutMode && selectedKonvaWords.length > 0) enableDeleteWords = true;
    if (!viewer.state.layoutMode && event.target instanceof KonvaOcrWord) {
      viewer.contextMenuWord = event.target;
      if (event.target.highlightColor) enableDeleteHighlight = true;
      if (selectedKonvaWords.length < 2) {
        const cursorIndex = KonvaOcrWord.getCursorIndex(event.target);
        if (cursorIndex > 0 && cursorIndex < event.target.word.text.length) {
          enableSplitWord = true;
        }
      } else {
        const adjacentWords = scribe.utils.checkOcrWordsAdjacent(selectedWords);
        if (adjacentWords) enableMergeWords = true;
      }
    }

    const selectedTables = viewer.CanvasSelection.getDataTables();

    let enableMergeTables = false;
    let enableMergeColumns = false;
    let enableSplit = false;
    let enableDeleteRegion = false;
    let enableDeleteTable = false;
    let enableCopyTableContents = false;
    let enableSplitTable = false;

    if (selectedTables.length === 1) {
      const adjacentColumns = checkDataColumnsAdjacent(selectedColumns);
      if (selectedColumns.length > 1 && adjacentColumns) enableMergeColumns = true;
      if (selectedColumns.length === 1) enableSplit = true;
      if (selectedRegions.length > 0) enableDeleteRegion = true;
      if (selectedColumns.length > 0 && adjacentColumns && selectedColumns.length < selectedTables[0].boxes.length) enableSplitTable = true;
      if (selectedColumns.length > 0 && selectedColumns.length === selectedColumns[0].konvaTable.columns.length) {
        enableDeleteTable = true;
        enableCopyTableContents = true;
      }
    } else if (selectedTables.length > 1 && checkDataTablesAdjacent(selectedTables)) {
      enableMergeTables = true;
    } else if (selectedRegions.length > 0) {
      enableDeleteRegion = true;
    }

    if (!(enableMergeColumns || enableSplit || enableDeleteRegion || enableDeleteTable || enableCopyTableContents || enableMergeTables || enableSplitTable
      || enableSplitWord || enableMergeWords || enableDeleteWords || enableDeleteHighlight)) return;

    if (enableMergeWords) contextMenuMergeWordsButtonElem.style.display = 'initial';
    if (enableSplitWord) contextMenuSplitWordButtonElem.style.display = 'initial';
    if (enableDeleteWords) contextMenuDeleteWordsButtonElem.style.display = 'initial';
    if (enableMergeColumns) contextMenuMergeColumnsButtonElem.style.display = 'initial';
    if (enableSplit) contextMenuSplitColumnButtonElem.style.display = 'initial';
    if (enableDeleteRegion) contextMenuDeleteLayoutRegionButtonElem.style.display = 'initial';
    if (enableDeleteTable) contextMenuDeleteLayoutTableButtonElem.style.display = 'initial';
    if (enableCopyTableContents) contextMenuCopyLayoutTableContentsButtonElem.style.display = 'initial';
    if (enableMergeTables) contextMenuMergeTablesButtonElem.style.display = 'initial';
    if (enableSplitTable) contextMenuSplitTableButtonElem.style.display = 'initial';
    if (enableDeleteHighlight) contextMenuDeleteHighlightButtonElem.style.display = 'initial';

    event.evt.preventDefault();

    menuNode.style.display = 'initial';
    const containerRect = viewer.stage.container().getBoundingClientRect();
    menuNode.style.top = `${containerRect.top + pointer.y + 4}px`;
    menuNode.style.left = `${containerRect.left + pointer.x + 4}px`;
  } catch (e) {
    _menuViewer = null;
    throw e;
  }
};

/**
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {Object} box
 * @param {number} box.width
 * @param {number} box.height
 * @param {number} box.x
 * @param {number} box.y
 */
function selectWords(viewer, box) {
  const shapes = viewer.getKonvaWords();

  const newSelectedWords = shapes.filter((shape) => Konva.Util.haveIntersection(box, shape.getClientRect()));
  viewer.CanvasSelection.addWords(newSelectedWords);

  const selectedWords = viewer.CanvasSelection.getKonvaWords();

  if (selectedWords.length > 1) {
    selectedWords.forEach((shape) => (shape.select()));
  } else if (selectedWords.length === 1) {
    KonvaOcrWord.addControls(selectedWords[0]);
    selectedWords[0].select();
    KonvaOcrWord.updateUI();
  }
}

/**
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {Object} box
 * @param {number} box.width
 * @param {number} box.height
 * @param {number} box.x
 * @param {number} box.y
 */
export function selectLayoutBoxesArea(viewer, box) {
  const shapes = [...viewer.getKonvaDataColumns(), ...viewer.getKonvaRegions()];
  const layoutBoxes = shapes.filter((shape) => Konva.Util.haveIntersection(box, shape.getClientRect()));

  viewer.CanvasSelection.selectLayoutBoxes(layoutBoxes);
}

export const mouseupFunc2 = (viewer, event) => {
  hideContextMenu();

  viewer.interactionCallback(event);

  viewer.stopDragPinch(event);

  if (event.evt.button === 2) {
    const selectedColumnIds = viewer.CanvasSelection.getKonvaDataColumns().map((x) => x.layoutBox.id);
    const selectedWordIds = viewer.CanvasSelection.getKonvaWords().map((x) => x.word.id);

    if (!(event.target instanceof KonvaDataColumn || event.target instanceof KonvaOcrWord)) return;

    if (event.target instanceof KonvaDataColumn && selectedColumnIds.includes(event.target.layoutBox.id)) return;
    if (event.target instanceof KonvaOcrWord && selectedWordIds.includes(event.target.word.id)) return;
  }

  if (!viewer.selectingRectangle.visible() || (viewer.selectingRectangle.width() < 5 && viewer.selectingRectangle.height() < 5)) {
    const ptr = viewer.stage.getPointerPosition();
    if (!ptr) return;
    const box = {
      x: ptr.x, y: ptr.y, width: 1, height: 1,
    };
    if (viewer.mode === 'select' && !viewer.state.layoutMode) {
      viewer.destroyControls(!event.evt.ctrlKey);
      selectWords(viewer, box);
      KonvaOcrWord.updateUI();
      updateHighlightGroupOutline(viewer);
      viewer.layerText.batchDraw();
    } else if (viewer.mode === 'select' && viewer.state.layoutMode) {
      viewer.destroyControls(!event.evt.ctrlKey);
      selectLayoutBoxesArea(viewer, box);
      KonvaLayout.updateUI();
      viewer.layerOverlay.batchDraw();
    }
    return;
  }

  viewer.selectingRectangle.visible(false);

  if (viewer.mode === 'select' && !viewer.state.layoutMode) {
    viewer.destroyControls(!event.evt.ctrlKey);
    const box = viewer.selectingRectangle.getClientRect();
    selectWords(viewer, box);
    KonvaOcrWord.updateUI();
    updateHighlightGroupOutline(viewer);
  } else if (viewer.mode === 'select' && viewer.state.layoutMode) {
    viewer.destroyControls(!event.evt.ctrlKey);
    const box = viewer.selectingRectangle.getClientRect();
    selectLayoutBoxesArea(viewer, box);
    KonvaLayout.updateUI();
  } else if (['addWord', 'recognizeWord', 'recognizeArea', 'printCoords', 'addLayoutBoxOrder', 'addLayoutBoxExclude', 'addLayoutBoxDataTable'].includes(viewer.mode)) {
    const { n, box } = viewer.calcSelectionImageCoords();

    if (viewer.mode === 'addWord') {
      addWordManual(viewer, n, box);
    } else if (viewer.mode === 'recognizeWord') {
      recognizeArea(viewer, n, box, true);
    } else if (viewer.mode === 'recognizeArea') {
      recognizeArea(viewer, n, box, false);
    } else if (viewer.mode === 'printCoords') {
      const debugCoords = {
        left: box.left,
        top: box.top,
        right: box.left + box.width,
        bottom: box.top + box.height,
        topInv: viewer.doc.pageMetrics[n].dims.height - box.top,
        bottomInv: viewer.doc.pageMetrics[n].dims.height - (box.top + box.height),
      };
      console.log(debugCoords);
    } else if (viewer.mode === 'addLayoutBoxOrder') {
      addLayoutBox(viewer, n, box, 'order');
    } else if (viewer.mode === 'addLayoutBoxExclude') {
      addLayoutBox(viewer, n, box, 'exclude');
    } else if (viewer.mode === 'addLayoutBoxDataTable') {
      addLayoutDataTable(viewer, n, box);
    }
  }
};
