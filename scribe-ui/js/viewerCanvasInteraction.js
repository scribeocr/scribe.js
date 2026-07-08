/* eslint-disable import/no-cycle */
import scribe from '../../scribe.js';
import {
  ScribeViewer,
} from '../viewer.js';
import {
  addLayoutBox,
  addLayoutDataTable,
  checkDataColumnsAdjacent, checkDataTablesAdjacent, UiDataColumn, UiLayout, mergeDataColumns, mergeDataTables, splitDataColumn, splitDataTable,
} from './viewerLayout.js';
import { UiText, UiOcrWord } from './viewerWordObjects.js';
import { deleteSelectedWord } from './viewerModifySelectedWords.js';
import { deleteSelectedLayoutDataTable, deleteSelectedLayoutRegion } from './viewerModifySelectedLayout.js';
import {
  applyHighlight, createInkEdges, removeHighlightGroup, updateHighlightGroupOutline,
} from './viewerHighlights.js';
import { createNote } from './viewerNotes.js';

/**
 * Resolve a DOM event's target to its UI object (the `UiOcrWord`/`UiRegion`/`UiDataColumn` attached as `el._scribeObj`),
 * walking up to the nearest word span or marked layout element.
 * @param {Event} event
 * @returns {?any}
 */
function eventTargetObj(event) {
  const el = /** @type {any} */ (event.target)?.closest?.('.scribe-word, [data-scribe-kind]');
  return el ? el._scribeObj || null : null;
}

/**
 * Whether two content-space axis-aligned boxes overlap.
 * @param {{x: number, y: number, width: number, height: number}} a
 * @param {{x: number, y: number, width: number, height: number}} b
 */
function rectsOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * The drag-select marquee as a content-space box, derived from the viewer's current selection bbox.
 * @param {import('../viewer.js').ScribeViewer} viewer
 */
function marqueeBox(viewer) {
  return {
    x: Math.min(viewer.bbox.left, viewer.bbox.right),
    y: Math.min(viewer.bbox.top, viewer.bbox.bottom),
    width: Math.abs(viewer.bbox.right - viewer.bbox.left),
    height: Math.abs(viewer.bbox.bottom - viewer.bbox.top),
  };
}

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

  const wordCanvas = new UiOcrWord({
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
  const lineDiv = document.createElement('div');
  lineDiv.className = 'scribe-line';
  group.appendChild(lineDiv);
  lineDiv.appendChild(wordCanvas.el);
  if (!viewer._wordObjs[n]) viewer._wordObjs[n] = [];
  viewer._wordObjs[n].push(wordCanvas);
}

const createContextMenuHTML = () => {
  const menuDiv = document.createElement('div');
  menuDiv.id = 'scribe-context-menu';

  const innerDiv = document.createElement('div');

  const copySelectionButton = document.createElement('button');
  copySelectionButton.id = 'contextMenuCopyButton';
  copySelectionButton.textContent = 'Copy';
  copySelectionButton.style.display = 'none';
  copySelectionButton.addEventListener('click', copySelectionClick);

  const copyHighlightButton = document.createElement('button');
  copyHighlightButton.id = 'contextMenuCopyHighlightButton';
  copyHighlightButton.textContent = 'Copy Highlighted Text';
  copyHighlightButton.style.display = 'none';
  copyHighlightButton.addEventListener('click', copyHighlightClick);

  const highlightSelectionButton = document.createElement('button');
  highlightSelectionButton.id = 'contextMenuHighlightButton';
  highlightSelectionButton.textContent = 'Highlight';
  highlightSelectionButton.style.display = 'none';
  highlightSelectionButton.addEventListener('click', highlightSelectionClick);

  const commentButton = document.createElement('button');
  commentButton.id = 'contextMenuCommentButton';
  commentButton.textContent = 'Comment';
  commentButton.style.display = 'none';
  commentButton.addEventListener('click', commentSelectionClick);

  const bookmarkButton = document.createElement('button');
  bookmarkButton.id = 'contextMenuBookmarkButton';
  bookmarkButton.textContent = 'Add bookmark';
  bookmarkButton.style.display = 'none';
  bookmarkButton.addEventListener('click', addBookmarkClick);

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

  innerDiv.appendChild(copySelectionButton);
  innerDiv.appendChild(copyHighlightButton);
  innerDiv.appendChild(highlightSelectionButton);
  innerDiv.appendChild(commentButton);
  innerDiv.appendChild(bookmarkButton);
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
  const uiWord = viewer.contextMenuWord;

  if (!uiWord) return;

  const splitIndex = UiOcrWord.getCursorIndex(uiWord);
  const { wordA, wordB } = scribe.utils.splitOcrWord(uiWord.word, splitIndex, viewer.doc.fonts);

  const wordIndex = uiWord.word.line.words.findIndex((x) => x.id === uiWord.word.id);

  uiWord.word.line.words.splice(wordIndex, 1, wordA, wordB);

  viewer.displayPage(viewer.state.cp.n);
};

const mergeWordsClick = () => {
  hideContextMenu();
  const viewer = mv();

  const selectedUiWords = viewer.CanvasSelection.getUiWords();
  const selectedWords = selectedUiWords.map((x) => x.word);
  if (selectedUiWords.length < 2 || !scribe.utils.checkOcrWordsAdjacent(selectedWords)) return;
  const newWord = scribe.utils.mergeOcrWords(selectedUiWords.map((x) => x.word));
  const lineWords = selectedUiWords[0].word.line.words;
  selectedUiWords.sort((a, b) => a.word.bbox.left - b.word.bbox.left);
  lineWords.sort((a, b) => a.bbox.left - b.bbox.left);
  const firstIndex = lineWords.findIndex((x) => x.id === selectedUiWords[0].word.id);
  lineWords.splice(firstIndex, selectedUiWords.length, newWord);

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
  const selectedColumns = viewer.CanvasSelection.getUiDataColumns();
  if (selectedColumns.length === 0 || !navigator.clipboard) return;

  const table = document.createElement('table');

  if (!selectedColumns[0].uiTable.tableContent) return;

  selectedColumns[0].uiTable.tableContent.rowWordArr.forEach((row) => {
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
  mergeDataColumns(viewer.CanvasSelection.getUiDataColumns());
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
  const selectedColumns = viewer.CanvasSelection.getUiDataColumns();
  splitDataColumn(selectedColumns[0], viewer.contextMenuPointer.x);
  viewer.destroyControls();
};

const splitDataTableClick = () => {
  hideContextMenu();
  const viewer = mv();
  splitDataTable(viewer.CanvasSelection.getUiDataColumns());
  viewer.destroyControls();
};

const deleteHighlightClick = () => {
  const viewer = mv();
  hideContextMenu();
  // The Delete Highlight item is only offered on a highlighted word, so the guard inside `removeHighlightGroup` normally does not fire.
  removeHighlightGroup(viewer, viewer.contextMenuWord);
};

/**
 * Copy the current text selection.
 * execCommand('copy') fires a trusted copy event that the app's own document 'copy' listener fills with OCR-accurate, multi-page text, so right-click Copy and Ctrl+C produce identical clipboard text.
 * A synthetic ClipboardEvent is not usable here: Firefox nulls the clipboardData passed to its constructor, so the listener would have nothing to write into.
 */
const copySelectionClick = () => {
  try { document.execCommand('copy'); } catch { /* clipboard unavailable, so nothing to copy */ }
  hideContextMenu();
};

/** Copy the right-clicked highlight's text: its group's words in reading order, one clipboard line per OCR line. */
const copyHighlightClick = () => {
  const viewer = mv();
  hideContextMenu();
  const kw = viewer.contextMenuWord;
  if (!kw || !kw.highlightColor) return;
  // Snippet-level fidelity is enough here.
  const words = viewer.getUiWords()
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
};

/** Highlight the words under the current browser text selection, using the color the toolbar's highlight tool last set (mirrored to viewer._highlightColor). */
const highlightSelectionClick = () => {
  const viewer = mv();
  hideContextMenu();
  const color = viewer._highlightColor;
  const words = viewer.getWordsUnderTextSelection();
  if (!color || words.length === 0) return;
  applyHighlight(viewer, words, color, 0.5);
  window.getSelection()?.removeAllRanges();
};

/**
 * Comment on the highlight under the cursor, highlight the current text selection and comment on that, or (with no such target) drop a freestanding note at the click point.
 * The first two open `viewer._openCommentEditor`.
 * The note path uses `createNote` + `viewer._openNoteEditor`.
 * Both editors are installed on the viewer by the highlight tool.
 * @param {MouseEvent} event
 */
const commentSelectionClick = (event) => {
  const viewer = mv();
  hideContextMenu();
  // `_openCommentEditor` opens a highlight card that closes on any outside click at the document level.
  // Stop propagation so this menu click does not reach that closer and dismiss the card `_openCommentEditor` opens.
  event.stopPropagation();
  if (commentTargetWord && commentTargetWord.highlightColor && viewer._openCommentEditor) {
    viewer._openCommentEditor([commentTargetWord]);
    return;
  }
  const color = viewer._highlightColor;
  const words = viewer.getWordsUnderTextSelection();
  if (color && words.length > 0 && viewer._openCommentEditor) {
    applyHighlight(viewer, words, color, 0.5);
    window.getSelection()?.removeAllRanges();
    viewer._openCommentEditor(words);
    return;
  }
  if (commentNoteTarget && viewer._openNoteEditor) {
    const { n, x, y } = commentNoteTarget;
    const annot = createNote(viewer, n, x, y);
    viewer.renderNotes(n);
    // Refresh the Comments panel so the new note is listed, then focus its inline editor last so the rebuild does not steal focus.
    if (viewer.onEditCallback) viewer.onEditCallback();
    viewer._openNoteEditor(annot, n);
  }
};

/** Add a bookmark to the page under the cursor via the host-installed `_addBookmark`. */
const addBookmarkClick = () => {
  const viewer = mv();
  hideContextMenu();
  if (viewer._addBookmark && bookmarkTargetPage >= 0) viewer._addBookmark(bookmarkTargetPage);
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
/** @type {HTMLButtonElement} */ let contextMenuHighlightButtonElem;
/** @type {HTMLButtonElement} */ let contextMenuCommentButtonElem;
/** @type {HTMLButtonElement} */ let contextMenuBookmarkButtonElem;
/** @type {HTMLButtonElement} */ let contextMenuCopyButtonElem;
/** @type {HTMLButtonElement} */ let contextMenuCopyHighlightButtonElem;
/**
 * The highlighted word the context menu's Comment item edits, or null to comment the current text selection instead.
 * Reset on every `contextMenuFunc` so a handler never reads a stale target.
 * @type {?import('./viewerWordObjects.js').UiOcrWord}
 */
let commentTargetWord = null;
/**
 * The page point (page-local pixels) where the Comment item drops a freestanding note, when neither a highlighted word nor a text selection is the target.
 * Null otherwise. Reset on every `contextMenuFunc`.
 * @type {?{n: number, x: number, y: number}}
 */
let commentNoteTarget = null;
// The page the Add-bookmark item targets, or -1.
// Reset on every `contextMenuFunc`.
let bookmarkTargetPage = -1;

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
  contextMenuHighlightButtonElem = /** @type {HTMLButtonElement} */(document.getElementById('contextMenuHighlightButton'));
  contextMenuCommentButtonElem = /** @type {HTMLButtonElement} */(document.getElementById('contextMenuCommentButton'));
  contextMenuBookmarkButtonElem = /** @type {HTMLButtonElement} */(document.getElementById('contextMenuBookmarkButton'));
  contextMenuCopyButtonElem = /** @type {HTMLButtonElement} */(document.getElementById('contextMenuCopyButton'));
  contextMenuCopyHighlightButtonElem = /** @type {HTMLButtonElement} */(document.getElementById('contextMenuCopyHighlightButton'));

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
  hideContextMenu();
  menuNode?.remove();
  contextMenuStyleElem?.remove();
  menuNode = null;
  contextMenuStyleElem = null;
  _menuViewer = null;
};

// Shared event-listener options for the context menu's auto-dismiss handlers.
// The capture option must match between a listener's addEventListener and removeEventListener calls, so the add and remove sites use these shared constants.
const CAPTURE = { capture: true };
const CAPTURE_PASSIVE = { capture: true, passive: true };

/**
 * Ink-edge overlays marking the context menu's target highlight, one per fill band.
 * Separate full-opacity elements over the bands; a shadow on a band itself would inherit its fill opacity and wash out.
 * Appended to each band's layer group so page transforms apply and a highlight re-render sweeps them.
 * @type {HTMLDivElement[]}
 */
let inkEdgeElems = [];

const clearInkEdge = () => {
  for (const el of inkEdgeElems) el.remove();
  inkEdgeElems = [];
};

let dismissListenersActive = false;

const onMenuDismissPointerDown = (/** @type {Event} */ event) => {
  // A press on the menu activates a button, so leave closing to that button's own click handler.
  if (menuNode && menuNode.contains(/** @type {Node} */ (event.target))) return;
  hideContextMenu();
};

const onMenuDismiss = () => hideContextMenu();

const onMenuDismissKeyDown = (/** @type {KeyboardEvent} */ event) => {
  if (event.key === 'Escape') hideContextMenu();
};

export const hideContextMenu = () => {
  clearInkEdge();
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
  contextMenuHighlightButtonElem.style.display = 'none';
  contextMenuCommentButtonElem.style.display = 'none';
  contextMenuBookmarkButtonElem.style.display = 'none';
  contextMenuCopyButtonElem.style.display = 'none';
  contextMenuCopyHighlightButtonElem.style.display = 'none';
  menuNode.style.display = 'none';
  _menuViewer = null;

  // Stop listening for the dismiss interactions once hidden (attached in contextMenuFunc when shown).
  if (dismissListenersActive) {
    dismissListenersActive = false;
    document.removeEventListener('pointerdown', onMenuDismissPointerDown, CAPTURE);
    document.removeEventListener('scroll', onMenuDismiss, CAPTURE_PASSIVE);
    document.removeEventListener('wheel', onMenuDismiss, CAPTURE_PASSIVE);
    document.removeEventListener('keydown', onMenuDismissKeyDown, CAPTURE);
    window.removeEventListener('resize', onMenuDismiss);
    window.removeEventListener('blur', onMenuDismiss);
  }
};

export const contextMenuFunc = (viewer, event) => {
  // Return before the later preventDefault so the browser's native context menu shows instead of ours.
  if (viewer.contextMenuDisabledDebug) { hideContextMenu(); return; }
  // A right-click inside a text field (a note or comment editor, a rename box) keeps the browser's native edit menu rather than ours.
  const editableTarget = /** @type {?HTMLElement} */ (event.target);
  if (editableTarget && (editableTarget.tagName === 'INPUT' || editableTarget.tagName === 'TEXTAREA' || editableTarget.isContentEditable)) return;
  ensureContextMenu();
  _menuViewer = viewer;
  try {
    const pointerRelative = viewer.clientToContent(event.clientX, event.clientY);
    let targetObj = eventTargetObj(event);
    // Fill bands are pointer-transparent, so a right-click on a highlight between words lands on no word element.
    if (!viewer.state.layoutMode && !(targetObj instanceof UiOcrWord && targetObj.highlightColor)) {
      for (const kw of viewer.getUiWords()) {
        if (!kw.highlightRectElem) continue;
        const r = kw.highlightRectElem.getBoundingClientRect();
        if (event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom) {
          targetObj = kw;
          break;
        }
      }
    }

    const selectedUiWords = viewer.CanvasSelection.getUiWords();
    const selectedWords = selectedUiWords.map((x) => x.word);
    const selectedColumns = viewer.CanvasSelection.getUiDataColumns();
    const selectedRegions = viewer.CanvasSelection.getUiRegions();

    viewer.contextMenuPointer = pointerRelative;

    // A text selection over this viewer's words (outside layout mode) enables Copy (always) and Highlight (when a highlight color is set).
    // Both are read-only-safe, so neither is gated on the editor-only enableCanvasSelection flag.
    const hasTextSelection = !viewer.state.layoutMode && viewer.getWordsUnderTextSelection().length > 0;
    const enableCopy = hasTextSelection;
    const enableHighlight = hasTextSelection && !!viewer._highlightColor;

    let enableSplitWord = false;
    let enableMergeWords = false;
    let enableDeleteWords = false;
    let enableDeleteHighlight = false;
    let enableCopyHighlight = false;
    // Word editing (split / merge / delete) is gated on `enableCanvasSelection`, the editor-only flag.
    // Deleting a highlight is not, so the read-only viewer still offers it.
    if (viewer.enableCanvasSelection && !viewer.state.layoutMode && selectedUiWords.length > 0) enableDeleteWords = true;
    if (!viewer.state.layoutMode && targetObj instanceof UiOcrWord) {
      viewer.contextMenuWord = targetObj;
      if (targetObj.highlightColor) {
        enableDeleteHighlight = true;
        enableCopyHighlight = true;
      }
      if (viewer.enableCanvasSelection) {
        if (selectedUiWords.length < 2) {
          UiText._lastPointerClient = { x: event.clientX, y: event.clientY };
          const cursorIndex = UiOcrWord.getCursorIndex(targetObj);
          if (cursorIndex > 0 && cursorIndex < targetObj.word.text.length) {
            enableSplitWord = true;
          }
        } else {
          const adjacentWords = scribe.utils.checkOcrWordsAdjacent(selectedWords);
          if (adjacentWords) enableMergeWords = true;
        }
      }
    }

    // Add comment and Add bookmark are offered on a right-click anywhere over a loaded page in an editable viewer,
    // so a click on blank space still gets a useful menu instead of the browser's default.
    const hasDoc = !!(viewer.doc && viewer.doc.pageMetrics && viewer.doc.pageMetrics.length);
    const editingEnabled = !!(viewer.opt && viewer.opt.enablePageEditing);
    // The page point under the cursor, shared by the freestanding-note and add-bookmark actions.
    // null past the last page (clientToPage returns n = -1 there), so the void below the pages offers neither.
    const rawPoint = (hasDoc && !viewer.state.layoutMode) ? viewer.clientToPage(event.clientX, event.clientY) : null;
    const pagePoint = rawPoint && rawPoint.n >= 0 ? rawPoint : null;

    // Comment: edit a highlighted word's comment, comment on a highlightable text selection, or (with neither) drop a freestanding note at the click point.
    // The first two need the highlight tool's editor.
    // The note also needs editing on.
    const canComment = !!viewer._openCommentEditor;
    let enableComment = false;
    let commentLabel = 'Add comment';
    commentTargetWord = null;
    commentNoteTarget = null;
    if (!viewer.state.layoutMode) {
      if (canComment && targetObj instanceof UiOcrWord && targetObj.highlightColor) {
        enableComment = true;
        commentLabel = targetObj.highlightComment ? 'Edit comment' : 'Add comment';
        commentTargetWord = targetObj;
      } else if (canComment && enableHighlight) {
        enableComment = true;
      } else if (editingEnabled && pagePoint && viewer._openNoteEditor) {
        enableComment = true;
        commentNoteTarget = pagePoint;
      }
    }

    // Add bookmark: point a new outline entry at the page under the cursor.
    // Available only in the editor, where the host installs `_addBookmark`.
    const enableBookmark = !!viewer._addBookmark && editingEnabled && !!pagePoint;
    bookmarkTargetPage = enableBookmark ? pagePoint.n : -1;

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
      if (selectedColumns.length > 0 && selectedColumns.length === selectedColumns[0].uiTable.columns.length) {
        enableDeleteTable = true;
        enableCopyTableContents = true;
      }
    } else if (selectedTables.length > 1 && checkDataTablesAdjacent(selectedTables)) {
      enableMergeTables = true;
    } else if (selectedRegions.length > 0) {
      enableDeleteRegion = true;
    }

    if (!(enableMergeColumns || enableSplit || enableDeleteRegion || enableDeleteTable || enableCopyTableContents || enableMergeTables || enableSplitTable
      || enableSplitWord || enableMergeWords || enableDeleteWords || enableDeleteHighlight || enableCopyHighlight || enableHighlight || enableComment || enableBookmark || enableCopy)) return;

    if (enableCopy) contextMenuCopyButtonElem.style.display = 'initial';
    if (enableCopyHighlight) contextMenuCopyHighlightButtonElem.style.display = 'initial';
    if (enableHighlight) contextMenuHighlightButtonElem.style.display = 'initial';
    if (enableComment) {
      contextMenuCommentButtonElem.textContent = commentLabel;
      contextMenuCommentButtonElem.style.display = 'initial';
    }
    if (enableBookmark) contextMenuBookmarkButtonElem.style.display = 'initial';
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

    event.preventDefault();

    // The menu is opening on a highlight: ink its edges while it is the menu's target.
    clearInkEdge();
    if (targetObj instanceof UiOcrWord && targetObj.highlightColor) {
      /** @type {HTMLDivElement[]} */
      let bands = [];
      if (targetObj.highlightGroupId) {
        for (const map of viewer._highlightRectsByGroup) {
          const arr = map && map.get(targetObj.highlightGroupId);
          if (arr) bands.push(...arr);
        }
      } else if (targetObj.highlightRectElem) {
        bands = [targetObj.highlightRectElem];
      }
      inkEdgeElems = createInkEdges(bands);
    }

    menuNode.style.display = 'initial';
    menuNode.style.top = `${event.clientY + 4}px`;
    menuNode.style.left = `${event.clientX + 4}px`;

    // Close on the interactions a native context menu closes on (see the handler definitions).
    // Capture phase is required for scroll because the viewer's inner scroll container's scroll event does not bubble to document.
    dismissListenersActive = true;
    document.addEventListener('pointerdown', onMenuDismissPointerDown, CAPTURE);
    document.addEventListener('scroll', onMenuDismiss, CAPTURE_PASSIVE);
    document.addEventListener('wheel', onMenuDismiss, CAPTURE_PASSIVE);
    document.addEventListener('keydown', onMenuDismissKeyDown, CAPTURE);
    window.addEventListener('resize', onMenuDismiss);
    window.addEventListener('blur', onMenuDismiss);
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
  const shapes = viewer.getUiWords();

  const newSelectedWords = shapes.filter((shape) => rectsOverlap(box, shape.getClientRect()));
  viewer.CanvasSelection.addWords(newSelectedWords);

  const selectedWords = viewer.CanvasSelection.getUiWords();

  if (selectedWords.length > 1) {
    selectedWords.forEach((shape) => (shape.select()));
  } else if (selectedWords.length === 1) {
    UiOcrWord.addControls(selectedWords[0]);
    selectedWords[0].select();
    UiOcrWord.updateUI();
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
  const shapes = [...viewer.getUiDataColumns(), ...viewer.getUiRegions()];
  const layoutBoxes = shapes.filter((shape) => rectsOverlap(box, shape.getClientRect()));

  viewer.CanvasSelection.selectLayoutBoxes(layoutBoxes);
}

export const mouseupFunc2 = (viewer, event) => {
  hideContextMenu();

  viewer.interactionCallback(event);

  viewer.stopDragPinch(event);

  const targetObj = eventTargetObj(event);

  if (event.button === 2) {
    const selectedColumnIds = viewer.CanvasSelection.getUiDataColumns().map((x) => x.layoutBox.id);
    const selectedWordIds = viewer.CanvasSelection.getUiWords().map((x) => x.word.id);

    if (!(targetObj instanceof UiDataColumn || targetObj instanceof UiOcrWord)) return;

    if (targetObj instanceof UiDataColumn && selectedColumnIds.includes(targetObj.layoutBox.id)) return;
    if (targetObj instanceof UiOcrWord && selectedWordIds.includes(targetObj.word.id)) return;
  }

  const marqueeShown = viewer.selectingRectangle.style.display !== 'none';
  const marquee = marqueeBox(viewer);
  // Read whether a marquee was drawn, then hide it here. The `pointerup` caller leaves it visible for this read,
  // so hiding it any earlier would force the single-word click path below for every selection.
  viewer.selectingRectangle.style.display = 'none';
  if (!marqueeShown || (marquee.width < 5 && marquee.height < 5)) {
    const ptr = viewer.clientToContent(event.clientX, event.clientY);
    const box = {
      x: ptr.x, y: ptr.y, width: 1, height: 1,
    };
    if (viewer.mode === 'select' && !viewer.state.layoutMode) {
      viewer.destroyControls(!event.ctrlKey);
      selectWords(viewer, box);
      UiOcrWord.updateUI();
      updateHighlightGroupOutline(viewer);
    } else if (viewer.mode === 'select' && viewer.state.layoutMode) {
      viewer.destroyControls(!event.ctrlKey);
      selectLayoutBoxesArea(viewer, box);
      UiLayout.updateUI();
    }
    return;
  }

  if (viewer.mode === 'select' && !viewer.state.layoutMode) {
    viewer.destroyControls(!event.ctrlKey);
    selectWords(viewer, marquee);
    UiOcrWord.updateUI();
    updateHighlightGroupOutline(viewer);
  } else if (viewer.mode === 'select' && viewer.state.layoutMode) {
    viewer.destroyControls(!event.ctrlKey);
    selectLayoutBoxesArea(viewer, marquee);
    UiLayout.updateUI();
  } else if (['addWord', 'recognizeWord', 'recognizeArea', 'printCoords', 'addLayoutBoxOrder', 'addLayoutBoxExclude', 'addLayoutBoxDataTable'].includes(viewer.mode)) {
    const { n, box } = viewer.calcSelectionImageCoords();

    if (viewer.mode === 'addWord') {
      addWordManual(viewer, n, box);
    } else if (viewer.mode === 'recognizeWord') {
      recognizeArea(viewer, n, box, true).catch((err) => console.error('recognizeArea failed:', err));
    } else if (viewer.mode === 'recognizeArea') {
      recognizeArea(viewer, n, box, false).catch((err) => console.error('recognizeArea failed:', err));
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
