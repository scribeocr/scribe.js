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
  applyHighlight, createInkEdges, modifyHighlightComment, removeHighlightGroup, updateHighlightGroupOutline,
} from './viewerHighlights.js';
import { createNote } from './viewerNotes.js';
import { redactWords, removeRedactionGroup, hitTestRedaction } from './viewerRedactions.js';

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

// Local copy of controls/toolbar.js's lineIcon, not imported because that would cycle (toolbar.js imports viewer.js, which imports this module).
const menuIcon = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true">${inner}</svg>`;

const CM_COPY_SVG = menuIcon('<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2.5"/>');
const CM_UNDERLINE_SVG = menuIcon('<path d="M7 4.6v6.4a5 5 0 0 0 10 0V4.6"/><path d="M6 19.4h12"/>');
const CM_STRIKE_SVG = menuIcon('<path d="M4 12h16"/><path d="M16.4 8.1A4.2 3.1 0 0 0 12 5.6c-2.4 0-4.2 1.2-4.2 2.9M7.6 15.9A4.2 3.1 0 0 0 12 18.4c2.4 0 4.2-1.2 4.2-2.9"/>');
const CM_COMMENT_SVG = menuIcon('<path d="M20 14.4a2 2 0 0 1-2 2H9.2L5 19.6V6.6a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2Z"/><path d="M12 8.1v4.2M9.9 10.2h4.2"/>');
const CM_REDACT_SVG = menuIcon('<path d="M4 6.6h16"/><path d="M4 17.4h9"/><rect x="4" y="10.3" width="16" height="3.4" rx="0.5" fill="currentColor" stroke="none"/>');
const CM_BOOKMARK_SVG = menuIcon('<path d="M7 4h10v16l-5-3.6L7 20V4Z"/>');
const CM_TRASH_SVG = menuIcon('<path d="M5.5 7h13"/><path d="M10 7V5h4v2"/><path d="M7.5 7l.6 12.3a1 1 0 0 0 1 .7h5.8a1 1 0 0 0 1-.7L16.5 7"/>');
const CM_SPLIT_SVG = menuIcon('<path d="M12 4.5v3.4M12 10.3v3.4M12 16.1v3.4"/><path d="M8.6 12H4M6.1 9.9 4 12l2.1 2.1"/><path d="M15.4 12H20M17.9 9.9 20 12l-2.1 2.1"/>');
const CM_MERGE_SVG = menuIcon('<path d="M12 5v14"/><path d="M4 12h4.6M6.5 9.9 8.6 12l-2.1 2.1"/><path d="M20 12h-4.6M17.5 9.9 15.4 12l2.1 2.1"/>');
const CM_TABLE_SVG = menuIcon('<rect x="4" y="5" width="16" height="14" rx="1.5"/><path d="M4 10h16M10.5 10v9M15.3 10v9"/>');
// The Highlight row leads with a live color swatch (set to `viewer._highlightColor` on open) instead of a glyph.
const CM_SWATCH_HTML = '<span class="scribe-cm-swatch"></span>';

const createContextMenuHTML = () => {
  const menuDiv = document.createElement('div');
  menuDiv.id = 'scribe-context-menu';

  /**
   * Build one menu row: a button with a leading icon slot and a label.
   * @param {string} id
   * @param {string} label
   * @param {string} slotHTML - Icon SVG (or swatch) markup for the leading 16px slot.
   * @param {(e: MouseEvent) => void} onClick
   * @param {boolean} [danger] - Style as the destructive row (red icon, red-tinted hover).
   */
  const item = (id, label, slotHTML, onClick, danger = false) => {
    const btn = document.createElement('button');
    btn.id = id;
    if (danger) btn.className = 'scribe-cm-danger';
    btn.style.display = 'none';
    const inner = document.createElement('span');
    // Flex layout lives on this inner span, not the button: rows are shown by setting the button's inline `display` to `initial`, which would clobber a stylesheet `display: flex` on the button.
    inner.className = 'scribe-cm-inner';
    const slot = document.createElement('span');
    slot.className = 'scribe-cm-slot';
    slot.innerHTML = slotHTML;
    const lbl = document.createElement('span');
    lbl.className = 'scribe-cm-lbl';
    lbl.textContent = label;
    inner.append(slot, lbl);
    btn.appendChild(inner);
    btn.addEventListener('click', onClick);
    return btn;
  };

  // Per-open visibility only shows or hides these rows, never reorders them, so the order here is what the user sees.
  const groups = [
    [
      item('contextMenuCopyButton', 'Copy', CM_COPY_SVG, copySelectionClick),
      item('contextMenuCopyHighlightButton', 'Copy Highlighted Text', CM_COPY_SVG, copyHighlightClick),
      item('contextMenuCopyLayoutTableContentsButton', 'Copy Table Contents', CM_COPY_SVG, copyTableContentsClick),
    ],
    [
      item('contextMenuHighlightButton', 'Highlight', CM_SWATCH_HTML, highlightSelectionClick),
      item('contextMenuUnderlineButton', 'Underline', CM_UNDERLINE_SVG, underlineSelectionClick),
      item('contextMenuStrikethroughButton', 'Strikethrough', CM_STRIKE_SVG, strikeoutSelectionClick),
      item('contextMenuCommentButton', 'Comment', CM_COMMENT_SVG, commentSelectionClick),
      item('contextMenuBookmarkButton', 'Add bookmark', CM_BOOKMARK_SVG, addBookmarkClick),
    ],
    [
      item('contextMenuSplitWordButton', 'Split Word', CM_SPLIT_SVG, splitWordClick),
      item('contextMenuMergeWordsButton', 'Merge Words', CM_MERGE_SVG, mergeWordsClick),
      item('contextMenuDeleteWordsButton', 'Delete Words', CM_TRASH_SVG, deleteWordsClick),
    ],
    [
      item('contextMenuSplitColumnButton', 'Split Column', CM_SPLIT_SVG, splitDataColumnClick),
      item('contextMenuMergeColumnsButton', 'Merge Columns', CM_MERGE_SVG, mergeDataColumnsClick),
      item('contextMenuMergeTablesButton', 'Merge Tables', CM_MERGE_SVG, mergeDataTablesClick),
      item('contextMenuSplitTableButton', 'New Table from Columns', CM_TABLE_SVG, splitDataTableClick),
      item('contextMenuDeleteLayoutTableButton', 'Delete Table', CM_TRASH_SVG, deleteLayoutDataTableClick),
      item('contextMenuDeleteLayoutRegionButton', 'Delete', CM_TRASH_SVG, deleteLayoutRegionClick),
    ],
    [
      item('contextMenuDeleteHighlightButton', 'Delete Highlight', CM_TRASH_SVG, deleteHighlightClick),
      item('contextMenuDeleteRedactionButton', 'Delete Redaction', CM_TRASH_SVG, deleteRedactionClick),
    ],
    [
      item('contextMenuRedactButton', 'Redact', CM_REDACT_SVG, redactSelectionClick, true),
    ],
  ];

  groups.forEach((buttons, i) => {
    if (i > 0) {
      const sep = document.createElement('div');
      sep.className = 'scribe-cm-sep';
      sep.style.display = 'none';
      menuDiv.appendChild(sep);
    }
    const group = document.createElement('div');
    group.className = 'scribe-cm-group';
    for (const btn of buttons) group.appendChild(btn);
    menuDiv.appendChild(group);
  });

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

/**
 * Which markup slot of `viewer.contextMenuWord` the menu's Delete/Copy verbs act on: its highlight fill or its line markup.
 * @type {('highlight'|'line')}
 */
let contextMenuMarkupSlot = 'highlight';

const deleteHighlightClick = () => {
  const viewer = mv();
  hideContextMenu();
  // The delete item is only offered on a marked word, so the guard inside `removeHighlightGroup` normally does not fire.
  removeHighlightGroup(viewer, viewer.contextMenuWord, contextMenuMarkupSlot);
};

/** Mark the words under the current text selection for redaction (destructive at export). */
const redactSelectionClick = () => {
  const viewer = mv();
  hideContextMenu();
  const words = viewer.getWordsUnderTextSelection();
  if (words.length === 0) return;
  const added = redactWords(viewer, words.map((kw) => kw.word));
  viewer.clearTextSelection();
  if (added > 0 && viewer._onRedactMark) viewer._onRedactMark(added);
};

/** Delete the redaction mark group under the right-click point (resolved at menu open). */
const deleteRedactionClick = () => {
  const viewer = mv();
  hideContextMenu();
  if (redactTarget) removeRedactionGroup(viewer, redactTarget.groupId);
  redactTarget = null;
};

/** Copy the current text selection. */
const copySelectionClick = () => {
  const viewer = mv();
  if (viewer.useCustomSelection) {
    const text = viewer.textSel.getText();
    if (text) navigator.clipboard?.writeText(text).catch(() => {});
  } else {
    // Native selection exposes no text handle, so execCommand('copy') fires a trusted copy event that the document listener fills with proper OCR text.
    // Not a synthetic ClipboardEvent: Firefox nulls its clipboardData, so the listener would have nothing to write.
    try { document.execCommand('copy'); } catch { /* clipboard unavailable, so nothing to copy */ }
  }
  hideContextMenu();
};

/** Copy the right-clicked markup's text: its group's words in reading order, one clipboard line per OCR line. */
const copyHighlightClick = () => {
  const viewer = mv();
  hideContextMenu();
  const kw = viewer.contextMenuWord;
  const isLine = contextMenuMarkupSlot === 'line';
  if (!kw || (isLine ? !kw.markupType : !kw.highlightColor)) return;
  // Snippet-level fidelity is enough here.
  const words = viewer.getUiWords()
    .filter((w) => (isLine
      ? w.markupType && (kw.markupGroupId ? w.markupGroupId === kw.markupGroupId : w.markupRectElem === kw.markupRectElem)
      : w.highlightColor && (kw.highlightGroupId ? w.highlightGroupId === kw.highlightGroupId : w.highlightRectElem === kw.highlightRectElem)))
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
  viewer.clearTextSelection();
};

// Underline and strikethrough have no toolbar color tool like highlight's, so they need these hardcoded defaults.
const UNDERLINE_COLOR_DEFAULT = '#81c784';
const STRIKEOUT_COLOR_DEFAULT = '#e53935';

/** Underline (annotation, not the word text style) the words under the current text selection. */
const underlineSelectionClick = () => {
  const viewer = mv();
  hideContextMenu();
  const words = viewer.getWordsUnderTextSelection();
  if (words.length === 0) return;
  applyHighlight(viewer, words, UNDERLINE_COLOR_DEFAULT, 1, 'underline');
  viewer.clearTextSelection();
};

/** Strike through (annotation) the words under the current text selection. */
const strikeoutSelectionClick = () => {
  const viewer = mv();
  hideContextMenu();
  const words = viewer.getWordsUnderTextSelection();
  if (words.length === 0) return;
  applyHighlight(viewer, words, STRIKEOUT_COLOR_DEFAULT, 1, 'strikeout');
  viewer.clearTextSelection();
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
  if (commentTargetWord && (commentTargetWord.highlightColor || commentTargetWord.markupType) && viewer._openCommentEditor) {
    viewer._openCommentEditor([commentTargetWord]);
    return;
  }
  const color = viewer._highlightColor;
  const words = viewer.getWordsUnderTextSelection();
  if (color && words.length > 0 && viewer._openCommentEditor) {
    applyHighlight(viewer, words, color, 0.5);
    viewer.clearTextSelection();
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

// Keep this popup `position: fixed`, never absolute: an absolute menu opened near the window bottom extends the document's scroll overflow and summons a page scrollbar.
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
/** @type {HTMLButtonElement} */ let contextMenuRedactButtonElem;
/** @type {HTMLButtonElement} */ let contextMenuDeleteRedactionButtonElem;

/**
 * The redaction mark under the right-click point, resolved when the menu opens.
 * @type {?{ n: number, groupId: string }}
 */
let redactTarget = null;
/** @type {HTMLButtonElement} */ let contextMenuHighlightButtonElem;
/** @type {HTMLButtonElement} */ let contextMenuUnderlineButtonElem;
/** @type {HTMLButtonElement} */ let contextMenuStrikethroughButtonElem;
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
  contextMenuRedactButtonElem = /** @type {HTMLButtonElement} */(document.getElementById('contextMenuRedactButton'));
  contextMenuDeleteRedactionButtonElem = /** @type {HTMLButtonElement} */(document.getElementById('contextMenuDeleteRedactionButton'));
  contextMenuHighlightButtonElem = /** @type {HTMLButtonElement} */(document.getElementById('contextMenuHighlightButton'));
  contextMenuUnderlineButtonElem = /** @type {HTMLButtonElement} */(document.getElementById('contextMenuUnderlineButton'));
  contextMenuStrikethroughButtonElem = /** @type {HTMLButtonElement} */(document.getElementById('contextMenuStrikethroughButton'));
  contextMenuCommentButtonElem = /** @type {HTMLButtonElement} */(document.getElementById('contextMenuCommentButton'));
  contextMenuBookmarkButtonElem = /** @type {HTMLButtonElement} */(document.getElementById('contextMenuBookmarkButton'));
  contextMenuCopyButtonElem = /** @type {HTMLButtonElement} */(document.getElementById('contextMenuCopyButton'));
  contextMenuCopyHighlightButtonElem = /** @type {HTMLButtonElement} */(document.getElementById('contextMenuCopyHighlightButton'));

  // This menu is body-level, so it can't inherit the viewer's `--scribe-*` tokens; contextMenuFunc mirrors them onto it on open to match the app theme.
  // The CSS fallbacks are the light palette, so a token-less embedder still gets sane colors.
  contextMenuStyleElem = document.createElement('style');
  contextMenuStyleElem.textContent = `
    #scribe-context-menu {
      display: none;
      position: fixed;
      width: max-content;
      min-width: 176px;
      box-sizing: border-box;
      padding: 5px;
      background: var(--scribe-surface, #ffffff);
      border: 1px solid var(--scribe-line, #e4e8ef);
      border-radius: 8px;
      box-shadow: var(--scribe-menu-shadow, 0 8px 24px rgba(20, 30, 60, .18));
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 12.5px;
      line-height: 1.55;
      color: var(--scribe-ink, #1f2530);
      user-select: none;
    }
    /* Flex here blockifies the rows, which are shown inline (style.display = 'initial'), so they stack with no inline baseline gaps. */
    #scribe-context-menu .scribe-cm-group {
      display: flex;
      flex-direction: column;
    }
    #scribe-context-menu button {
      width: 100%;
      background: none;
      border: none;
      margin: 0;
      padding: 0;
      font: inherit;
      color: inherit;
      text-align: left;
    }
    #scribe-context-menu .scribe-cm-inner {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 4.5px 9px;
      border-radius: 6px;
      white-space: nowrap;
    }
    #scribe-context-menu button:hover .scribe-cm-inner {
      background: var(--scribe-hover, rgba(28, 42, 68, .06));
    }
    #scribe-context-menu .scribe-cm-slot {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
      width: 16px;
      height: 16px;
      color: var(--scribe-ink-2, #586170);
    }
    #scribe-context-menu .scribe-cm-swatch {
      width: 15px;
      height: 15px;
      border-radius: 3px;
      box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .18);
    }
    #scribe-context-menu .scribe-cm-danger .scribe-cm-slot {
      color: var(--scribe-danger, #d1493d);
    }
    #scribe-context-menu .scribe-cm-danger:hover .scribe-cm-inner {
      background: var(--scribe-danger-soft, #fbe9e7);
      color: var(--scribe-danger, #d1493d);
    }
    #scribe-context-menu .scribe-cm-sep {
      height: 1px;
      background: var(--scribe-line, #e4e8ef);
      margin: 3px 8px;
    }`;
  document.head.appendChild(contextMenuStyleElem);
}

// The `--scribe-*` tokens mirrored onto the body-level menu on open, since it lives outside the viewer's scoped token definitions and the cascade can't reach it.
const CONTEXT_MENU_TOKENS = ['--scribe-surface', '--scribe-line', '--scribe-ink', '--scribe-ink-2', '--scribe-hover', '--scribe-danger', '--scribe-danger-soft', '--scribe-menu-shadow'];

/** Remove the shared context menu, the touch callout, and their styles from the document. */
export const destroyContextMenu = () => {
  hideContextMenu();
  hideTouchCallout();
  menuNode?.remove();
  contextMenuStyleElem?.remove();
  menuNode = null;
  contextMenuStyleElem = null;
  calloutNode?.remove();
  calloutStyleElem?.remove();
  calloutNode = null;
  calloutStyleElem = null;
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
  contextMenuRedactButtonElem.style.display = 'none';
  contextMenuDeleteRedactionButtonElem.style.display = 'none';
  contextMenuHighlightButtonElem.style.display = 'none';
  contextMenuUnderlineButtonElem.style.display = 'none';
  contextMenuStrikethroughButtonElem.style.display = 'none';
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

/** @type {?HTMLDivElement} */
let calloutNode = null;
/** @type {?HTMLStyleElement} */
let calloutStyleElem = null;
/** @type {?HTMLDivElement} */
let calloutRow1 = null;
/** @type {?HTMLDivElement} */
let calloutRow2 = null;
/** @type {Object<string, HTMLButtonElement>} */
const calloutBtns = {};
let calloutDismissActive = false;

const CALLOUT_CHEVRON_SVG = menuIcon('<path d="M6 9.4 12 15l6-5.6"/>');

const CALLOUT_EDIT_SVG = menuIcon('<path d="M5 19h4L18.2 9.8a2 2 0 0 0 0-2.8l-1.2-1.2a2 2 0 0 0-2.8 0L5 15v4Z"/><path d="M12.8 7.2l4 4"/>');

const onCalloutDismissPointerDown = (/** @type {Event} */ event) => {
  if (calloutNode && calloutNode.contains(/** @type {Node} */ (event.target))) return;
  hideTouchCallout();
};
// Scrolling and zooming hide the callout (the OS convention) but keep the selection.
const onCalloutDismiss = () => hideTouchCallout();
const onCalloutDismissKeyDown = (/** @type {KeyboardEvent} */ event) => {
  if (event.key === 'Escape') hideTouchCallout();
};

export const hideTouchCallout = () => {
  if (!calloutNode || calloutNode.style.display === 'none') return;
  clearInkEdge();
  calloutNode.style.display = 'none';
  _menuViewer = null;
  if (calloutDismissActive) {
    calloutDismissActive = false;
    document.removeEventListener('pointerdown', onCalloutDismissPointerDown, CAPTURE);
    document.removeEventListener('scroll', onCalloutDismiss, CAPTURE_PASSIVE);
    document.removeEventListener('wheel', onCalloutDismiss, CAPTURE_PASSIVE);
    document.removeEventListener('keydown', onCalloutDismissKeyDown, CAPTURE);
    window.removeEventListener('resize', onCalloutDismiss);
    window.removeEventListener('blur', onCalloutDismiss);
  }
};

/** Open the in-place word editor on a single-word touch selection. */
const calloutEditTextClick = () => {
  const viewer = mv();
  if (!UiText.enableEditing) return;
  const words = viewer.getWordsUnderTextSelection();
  if (words.length !== 1) return;
  const kw = words[0];
  viewer.clearTextSelection();
  UiText.addTextInput(kw);
};

/** Delete the tapped highlight/markup group, offering Undo through the host's destructive-action toast. */
const calloutDeleteMarkupClick = () => {
  const viewer = mv();
  const kw = viewer.contextMenuWord;
  const slot = contextMenuMarkupSlot;
  if (!kw) return;
  const isLine = slot === 'line';
  // Removal only clears the words' marks, so the captured objects stay valid for the undo.
  const words = viewer.getUiWords()
    .filter((w) => (isLine
      ? w.markupType && (kw.markupGroupId ? w.markupGroupId === kw.markupGroupId : w.markupRectElem === kw.markupRectElem)
      : w.highlightColor && (kw.highlightGroupId ? w.highlightGroupId === kw.highlightGroupId : w.highlightRectElem === kw.highlightRectElem)));
  const snapshot = {
    color: isLine ? kw.markupColor : kw.highlightColor,
    opacity: isLine ? kw.markupOpacity : kw.highlightOpacity,
    kind: isLine ? (kw.markupType || 'underline') : 'highlight',
    comment: isLine ? kw.markupComment : kw.highlightComment,
  };
  removeHighlightGroup(viewer, kw, slot);
  const label = isLine ? (snapshot.kind === 'strikeout' ? 'Strikethrough' : 'Underline') : 'Highlight';
  // The callout's delete has no hover-to-verify step, so a one-tap mistake needs a one-tap way back.
  viewer._onDestructiveAction?.(`${label} deleted.`, () => {
    if (words.length === 0 || !snapshot.color) return;
    applyHighlight(viewer, words, snapshot.color, snapshot.opacity ?? (isLine ? 1 : 0.5), snapshot.kind);
    if (snapshot.comment) {
      modifyHighlightComment(viewer, words, snapshot.comment, snapshot.kind);
      // The comment landed after the bands drew, so redraw for its mark.
      for (const n of new Set(words.map((w) => w.word.line.page.n))) viewer.renderHighlights(n);
    }
  });
};

function ensureTouchCallout() {
  if (calloutNode) return;
  calloutNode = document.createElement('div');
  calloutNode.id = 'scribe-touch-callout';
  calloutNode.style.display = 'none';

  /**
   * @param {string} key
   * @param {string} label
   * @param {string} slotHTML
   * @param {(event: MouseEvent) => void} onClick
   * @param {boolean} [danger=false]
   */
  const btn = (key, label, slotHTML, onClick, danger = false) => {
    const el = document.createElement('button');
    el.type = 'button';
    el.title = label;
    el.setAttribute('aria-label', label);
    if (danger) el.classList.add('scribe-callout-danger');
    el.innerHTML = `<span class="scribe-callout-slot">${slotHTML}</span>`;
    // hideTouchCallout nulls the target state the verb reads, so the verb runs first.
    el.addEventListener('click', (event) => { onClick(event); hideTouchCallout(); });
    calloutBtns[key] = el;
    return el;
  };

  calloutRow2 = document.createElement('div');
  calloutRow2.className = 'scribe-callout-row scribe-callout-row2';
  calloutRow2.append(
    btn('bookmark', 'Add bookmark', CM_BOOKMARK_SVG, addBookmarkClick),
    btn('redact', 'Redact', CM_REDACT_SVG, redactSelectionClick),
    btn('strike', 'Strikethrough', CM_STRIKE_SVG, strikeoutSelectionClick),
    btn('edit', 'Edit text', CALLOUT_EDIT_SVG, calloutEditTextClick),
  );

  calloutRow1 = document.createElement('div');
  calloutRow1.className = 'scribe-callout-row';
  const vr = document.createElement('span');
  vr.className = 'scribe-callout-vr';
  const moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.title = 'More';
  moreBtn.setAttribute('aria-label', 'More');
  moreBtn.setAttribute('aria-expanded', 'false');
  moreBtn.innerHTML = `<span class="scribe-callout-slot">${CALLOUT_CHEVRON_SVG}</span>`;
  moreBtn.addEventListener('click', () => {
    const open = calloutRow2.style.display !== 'none';
    calloutRow2.style.display = open ? 'none' : 'flex';
    moreBtn.setAttribute('aria-expanded', String(!open));
    moreBtn.classList.toggle('open', !open);
  });
  calloutBtns.more = moreBtn;
  calloutRow1.append(
    btn('copy', 'Copy', CM_COPY_SVG, copySelectionClick),
    btn('copyhl', 'Copy highlighted text', CM_COPY_SVG, copyHighlightClick),
    btn('highlight', 'Highlight', CM_SWATCH_HTML, highlightSelectionClick),
    btn('underline', 'Underline', CM_UNDERLINE_SVG, underlineSelectionClick),
    btn('comment', 'Comment', CM_COMMENT_SVG, commentSelectionClick),
    vr,
    btn('delete', 'Delete', CM_TRASH_SVG, calloutDeleteMarkupClick, true),
    moreBtn,
  );

  calloutNode.append(calloutRow2, calloutRow1);
  document.body.appendChild(calloutNode);

  calloutStyleElem = document.createElement('style');
  calloutStyleElem.textContent = `
    #scribe-touch-callout {
      position: fixed;
      z-index: 60;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      user-select: none;
      -webkit-user-select: none;
    }
    #scribe-touch-callout .scribe-callout-row {
      display: flex;
      align-items: center;
      padding: 3px;
      background: var(--scribe-surface, #ffffff);
      border: 1px solid var(--scribe-line, #e4e8ef);
      border-radius: 12px;
      box-shadow: var(--scribe-menu-shadow, 0 8px 24px rgba(20, 30, 60, .18));
    }
    /* .flipped (callout below the selection) reverses the rows so the tail row stays on the far side. */
    #scribe-touch-callout.flipped { flex-direction: column-reverse; }
    #scribe-touch-callout button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 44px;
      height: 42px;
      background: none;
      border: none;
      margin: 0;
      padding: 0;
      border-radius: 9px;
      color: var(--scribe-ink, #1f2530);
      cursor: pointer;
    }
    #scribe-touch-callout button:hover { background: var(--scribe-hover, rgba(28, 42, 68, .06)); }
    #scribe-touch-callout button.open { background: var(--scribe-hover, rgba(28, 42, 68, .06)); }
    #scribe-touch-callout .scribe-callout-slot {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      color: var(--scribe-ink-2, #586170);
    }
    #scribe-touch-callout .scribe-callout-slot svg { width: 20px; height: 20px; }
    #scribe-touch-callout .scribe-cm-swatch {
      width: 18px;
      height: 18px;
      border-radius: 4px;
      box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .18);
    }
    #scribe-touch-callout .scribe-callout-danger .scribe-callout-slot { color: var(--scribe-danger, #d1493d); }
    #scribe-touch-callout .scribe-callout-danger:hover { background: var(--scribe-danger-soft, #fbe9e7); }
    #scribe-touch-callout .scribe-callout-vr {
      width: 1px;
      height: 26px;
      background: var(--scribe-line, #e4e8ef);
      margin: 0 2px;
    }
    #scribe-touch-callout button.open .scribe-callout-slot { transform: rotate(180deg); }`;
  document.head.appendChild(calloutStyleElem);
}

/**
 * Open the touch callout on the current selection or on a tapped highlight/markup group.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {'selection'|'markup'} kind
 * @param {?import('./viewerWordObjects.js').UiOcrWord} [kw] - The tapped group's word (markup kind).
 * @param {'highlight'|'line'} [slot='highlight'] - Which of the word's marks was tapped (markup kind).
 */
export const showTouchCallout = (viewer, kind, kw = null, slot = 'highlight') => {
  if (viewer.state.layoutMode) return;
  ensureTouchCallout();
  hideContextMenu();
  clearInkEdge();
  _menuViewer = viewer;

  /** @type {?{left: number, top: number, right: number, bottom: number}} */
  let anchor = null;
  /** @type {Object<string, boolean>} */
  const show = {
    copy: false, copyhl: false, highlight: false, underline: false, comment: false, delete: false, bookmark: false, redact: false, strike: false, edit: false,
  };

  const editingEnabled = !!(viewer.opt && viewer.opt.enablePageEditing);
  if (kind === 'selection') {
    if (!viewer.hasTextSelection() || !viewer.useCustomSelection) { hideTouchCallout(); return; }
    anchor = viewer.textSel.selectionClientRect();
    viewer.contextMenuWord = null;
    commentTargetWord = null;
    commentNoteTarget = null;
    const startPage = viewer.textSel.range?.kind === 'linear' ? viewer.textSel.range.start.n : -1;
    bookmarkTargetPage = (viewer._addBookmark && editingEnabled) ? startPage : -1;
    show.copy = true;
    show.highlight = !!viewer._highlightColor;
    show.underline = true;
    show.strike = true;
    show.comment = !!viewer._openCommentEditor && show.highlight;
    show.redact = !!viewer._redactEnabled;
    show.bookmark = bookmarkTargetPage >= 0;
    // Resolving the words is O(selection), so gate on a small single-page range first.
    if (UiText.enableEditing && viewer.textSel.range?.kind === 'linear') {
      const r = viewer.textSel.range;
      if (r.start.n === r.end.n && r.end.off - r.start.off <= 40) {
        show.edit = viewer.getWordsUnderTextSelection().length === 1;
      }
    }
  } else {
    if (!kw) { hideTouchCallout(); return; }
    viewer.contextMenuWord = kw;
    contextMenuMarkupSlot = slot;
    commentTargetWord = kw;
    commentNoteTarget = null;
    bookmarkTargetPage = -1;
    show.copyhl = true;
    show.comment = !!viewer._openCommentEditor;
    show.delete = true;
    const groupId = slot === 'line' ? kw.markupGroupId : kw.highlightGroupId;
    const rectElem = slot === 'line' ? kw.markupRectElem : kw.highlightRectElem;
    /** @type {HTMLDivElement[]} */
    let bands = [];
    if (groupId) {
      for (const map of viewer._highlightRectsByGroup) {
        const arr = map && map.get(groupId);
        if (arr) bands.push(...arr);
      }
    } else if (rectElem) {
      bands = [rectElem];
    }
    inkEdgeElems = createInkEdges(bands);
    let left = Infinity; let top = Infinity; let right = -Infinity; let bottom = -Infinity;
    for (const band of bands) {
      const r = band.getBoundingClientRect();
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    if (left !== Infinity) {
      anchor = {
        left, top, right, bottom,
      };
    }
  }

  if (!anchor) { hideTouchCallout(); return; }
  viewer.contextMenuPointer = viewer.clientToContent((anchor.left + anchor.right) / 2, (anchor.top + anchor.bottom) / 2);

  for (const [key, el] of Object.entries(calloutBtns)) {
    if (key === 'more') continue;
    el.style.display = show[key] ? '' : 'none';
  }
  const tailCount = ['bookmark', 'redact', 'strike', 'edit'].filter((k) => show[k]).length;
  calloutBtns.more.style.display = tailCount > 0 ? '' : 'none';
  calloutBtns.more.setAttribute('aria-expanded', 'false');
  calloutBtns.more.classList.remove('open');
  /** @type {HTMLDivElement} */ (calloutRow2).style.display = 'none';
  const vrElem = /** @type {HTMLElement} */ (calloutNode.querySelector('.scribe-callout-vr'));
  vrElem.style.display = (show.delete || tailCount > 0) ? '' : 'none';
  if (show.highlight) {
    /** @type {HTMLElement} */ (calloutBtns.highlight.querySelector('.scribe-cm-swatch')).style.background = viewer._highlightColor;
  }

  // Theme tokens, mirrored like the context menu's (the callout is body-level, outside the viewer's scope).
  const tokenStyles = getComputedStyle(viewer.scrollContainer);
  for (const token of CONTEXT_MENU_TOKENS) {
    const value = tokenStyles.getPropertyValue(token);
    if (value) calloutNode.style.setProperty(token, value);
    else calloutNode.style.removeProperty(token);
  }

  const hostRect = viewer.outerElem ? viewer.outerElem.getBoundingClientRect() : {
    left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight,
  };
  // Show before measuring: a display:none node has no size.
  calloutNode.style.display = 'flex';
  calloutNode.classList.remove('flipped');
  const { width: cw, height: ch } = calloutNode.getBoundingClientRect();
  let top = anchor.top - ch - 10;
  if (top < hostRect.top + 8) {
    calloutNode.classList.add('flipped');
    // The 26px drop clears the selection's end grips.
    top = Math.min(anchor.bottom + 26, hostRect.bottom - ch - 8);
  }
  const left = Math.max(hostRect.left + 8, Math.min((anchor.left + anchor.right) / 2 - cw / 2, hostRect.right - cw - 8));
  calloutNode.style.top = `${Math.max(hostRect.top + 8, top)}px`;
  calloutNode.style.left = `${left}px`;

  if (!calloutDismissActive) {
    calloutDismissActive = true;
    document.addEventListener('pointerdown', onCalloutDismissPointerDown, CAPTURE);
    document.addEventListener('scroll', onCalloutDismiss, CAPTURE_PASSIVE);
    document.addEventListener('wheel', onCalloutDismiss, CAPTURE_PASSIVE);
    document.addEventListener('keydown', onCalloutDismissKeyDown, CAPTURE);
    window.addEventListener('resize', onCalloutDismiss);
    window.addEventListener('blur', onCalloutDismiss);
  }
};

export const contextMenuFunc = (viewer, event) => {
  // One target surface at a time.
  hideTouchCallout();
  // The DOM selection engine leaves a native browser text selection, so bail before the preventDefault below to let the browser's own right-click menu act on it.
  if (!viewer.useCustomSelection && !viewer.enableCanvasSelection) { hideContextMenu(); return; }
  // A right-click inside a text field (a note or comment editor, a rename box) keeps the browser's native edit menu rather than ours.
  const editableTarget = /** @type {?HTMLElement} */ (event.target);
  if (editableTarget && (editableTarget.tagName === 'INPUT' || editableTarget.tagName === 'TEXTAREA' || editableTarget.isContentEditable)) return;
  ensureContextMenu();
  _menuViewer = viewer;
  try {
    const pointerRelative = viewer.clientToContent(event.clientX, event.clientY);
    let targetObj = eventTargetObj(event);
    // Fill bands and markup bars are pointer-transparent, so a right-click on one between words lands on no word element.
    if (!viewer.state.layoutMode && !(targetObj instanceof UiOcrWord && (targetObj.highlightColor || targetObj.markupType))) {
      const hitRect = (rectElem) => {
        if (!rectElem) return false;
        const r = rectElem.getBoundingClientRect();
        return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
      };
      for (const kw of viewer.getUiWords()) {
        if (hitRect(kw.highlightRectElem) || hitRect(kw.markupRectElem)) {
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

    // Copy, Highlight, and markup are read-only-safe, so none is gated on the editor-only enableCanvasSelection flag.
    // Keyed on whether a selection exists, not its resolved words: resolving a whole-document selection would build every page's word objects just to grey out a menu item.
    const hasTextSelection = !viewer.state.layoutMode && viewer.hasTextSelection();
    const enableCopy = hasTextSelection;
    const enableHighlight = hasTextSelection && !!viewer._highlightColor;
    const enableMarkup = hasTextSelection;
    // Deleting a redaction is not editor-gated: a mark changes what an export contains, so any viewer must be able to remove it.
    const enableRedact = hasTextSelection && !!viewer._redactEnabled;
    redactTarget = !viewer.state.layoutMode ? hitTestRedaction(viewer, event.clientX, event.clientY) : null;
    const enableDeleteRedaction = !!redactTarget;

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
      if (targetObj.highlightColor || targetObj.markupType) {
        enableDeleteHighlight = true;
        enableCopyHighlight = true;
        // Fill first when the word carries both, matching the comment card's click-to-pin priority.
        contextMenuMarkupSlot = targetObj.highlightColor ? 'highlight' : 'line';
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
      if (canComment && targetObj instanceof UiOcrWord && (targetObj.highlightColor || targetObj.markupType)) {
        enableComment = true;
        const existing = targetObj.highlightColor ? targetObj.highlightComment : targetObj.markupComment;
        commentLabel = existing ? 'Edit comment' : 'Add comment';
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
      || enableSplitWord || enableMergeWords || enableDeleteWords || enableDeleteHighlight || enableCopyHighlight || enableHighlight || enableMarkup || enableComment || enableBookmark || enableCopy
      || enableRedact || enableDeleteRedaction)) return;

    // Not btn.textContent, which would wipe the icon slot.
    const setMenuLabel = (btn, text) => { /** @type {HTMLElement} */ (btn.querySelector('.scribe-cm-lbl')).textContent = text; };

    if (enableCopy) contextMenuCopyButtonElem.style.display = 'initial';
    if (enableCopyHighlight) {
      setMenuLabel(contextMenuCopyHighlightButtonElem, contextMenuMarkupSlot === 'line' ? 'Copy Marked Text' : 'Copy Highlighted Text');
      contextMenuCopyHighlightButtonElem.style.display = 'initial';
    }
    if (enableHighlight) {
      // The row's swatch shows the color this click would apply.
      /** @type {HTMLElement} */ (contextMenuHighlightButtonElem.querySelector('.scribe-cm-swatch')).style.background = viewer._highlightColor;
      contextMenuHighlightButtonElem.style.display = 'initial';
    }
    if (enableMarkup) {
      contextMenuUnderlineButtonElem.style.display = 'initial';
      contextMenuStrikethroughButtonElem.style.display = 'initial';
    }
    if (enableRedact) contextMenuRedactButtonElem.style.display = 'initial';
    if (enableDeleteRedaction) contextMenuDeleteRedactionButtonElem.style.display = 'initial';
    if (enableComment) {
      setMenuLabel(contextMenuCommentButtonElem, commentLabel);
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
    if (enableDeleteHighlight) {
      const targetKind = contextMenuMarkupSlot === 'line'
        ? (/** @type {UiOcrWord} */ (targetObj).markupType === 'strikeout' ? 'Strikethrough' : 'Underline')
        : 'Highlight';
      setMenuLabel(contextMenuDeleteHighlightButtonElem, `Delete ${targetKind}`);
      contextMenuDeleteHighlightButtonElem.style.display = 'initial';
    }

    // A separator shows only between two visible groups, so the menu never opens with a leading, trailing, or doubled separator.
    let pendingSep = null;
    let anyVisibleBefore = false;
    for (const child of menuNode.children) {
      if (child.classList.contains('scribe-cm-sep')) {
        pendingSep = /** @type {HTMLElement} */ (child);
        continue;
      }
      const groupVisible = [...child.children].some((btn) => /** @type {HTMLElement} */ (btn).style.display !== 'none');
      if (pendingSep) {
        pendingSep.style.display = groupVisible && anyVisibleBefore ? '' : 'none';
        pendingSep = null;
      }
      anyVisibleBefore = anyVisibleBefore || groupVisible;
    }

    // Copy each viewer theme token onto the menu, removing any the host leaves unset so the stylesheet's light fallbacks take over.
    const tokenStyles = getComputedStyle(viewer.scrollContainer);
    for (const token of CONTEXT_MENU_TOKENS) {
      const value = tokenStyles.getPropertyValue(token);
      if (value) menuNode.style.setProperty(token, value);
      else menuNode.style.removeProperty(token);
    }

    event.preventDefault();

    // The menu is opening on a highlight or line markup: ink its edges while it is the menu's target.
    clearInkEdge();
    if (targetObj instanceof UiOcrWord && (targetObj.highlightColor || targetObj.markupType)) {
      const groupId = contextMenuMarkupSlot === 'line' ? targetObj.markupGroupId : targetObj.highlightGroupId;
      const rectElem = contextMenuMarkupSlot === 'line' ? targetObj.markupRectElem : targetObj.highlightRectElem;
      /** @type {HTMLDivElement[]} */
      let bands = [];
      if (groupId) {
        for (const map of viewer._highlightRectsByGroup) {
          const arr = map && map.get(groupId);
          if (arr) bands.push(...arr);
        }
      } else if (rectElem) {
        bands = [rectElem];
      }
      inkEdgeElems = createInkEdges(bands);
    }

    // Show first so the menu has a size, then clamp it into the viewport.
    // No paint happens between the display flip and the final position (same task), so the menu never flashes.
    menuNode.style.display = 'initial';
    const { width: menuW, height: menuH } = menuNode.getBoundingClientRect();
    menuNode.style.top = `${Math.max(4, Math.min(event.clientY + 4, window.innerHeight - menuH - 4))}px`;
    menuNode.style.left = `${Math.max(4, Math.min(event.clientX + 4, window.innerWidth - menuW - 4))}px`;

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
