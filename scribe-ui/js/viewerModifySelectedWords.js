import scribe from '../../scribe.js';
// eslint-disable-next-line import/no-cycle
import { ScribeViewer } from '../viewer.js';
import { UiText, UiOcrWord } from './viewerWordObjects.js';

/** @param {import('../viewer.js').ScribeViewer} viewer */
export function deleteSelectedWord(viewer) {
  const _viewer = viewer || ScribeViewer.getDefault();
  const selectedObjects = _viewer.CanvasSelection.getUiWords();
  const selectedN = selectedObjects.length;

  /** @type {Object<string, Array<string>>} */
  const selectedIds = {};
  for (let i = 0; i < selectedN; i++) {
    const wordIdI = selectedObjects[i].word.id;
    const n = selectedObjects[i].word.line.page.n;
    if (!selectedIds[n]) selectedIds[n] = [];
    selectedIds[n].push(wordIdI);
    selectedObjects[i].destroy();
  }

  for (const [n, ids] of Object.entries(selectedIds)) {
    scribe.utils.ocr.deletePageWords(_viewer.doc.ocr.active[n], ids);
  }

  _viewer.destroyControls();

  if (_viewer.opt.outlineLines || _viewer.opt.outlinePars) _viewer.displayPage(_viewer.state.cp.n);
}

/**
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {'left'|'right'} side
 * @param {number} amount
 */
export function modifySelectedWordBbox(viewer, side, amount) {
  const _viewer = viewer || ScribeViewer.getDefault();
  const selectedWords = _viewer.CanvasSelection.getUiWords();
  if (selectedWords.length !== 1) return;
  const selectedWord = selectedWords[0];

  selectedWord.word.bbox[side] += amount;
  if (side === 'left') selectedWord.x(selectedWord.x() + amount);
  UiText.updateWordCanvas(selectedWord);
}

/**
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {Object} style
 * @param {string} [style.font]
 * @param {number} [style.size]
 * @param {boolean} [style.bold]
 * @param {boolean} [style.italic]
 * @param {boolean} [style.underline]
 * @param {boolean} [style.smallCaps]
 * @param {boolean} [style.sup]
 */
export async function modifySelectedWordStyle(viewer, style) {
  const _viewer = viewer || ScribeViewer.getDefault();
  const selectedObjects = _viewer.CanvasSelection.getUiWords();
  if (!selectedObjects || selectedObjects.length === 0) return;

  if (UiText.inputRemove) UiText.inputRemove();

  const selectedN = selectedObjects.length;
  for (let i = 0; i < selectedN; i++) {
    const wordI = selectedObjects[i];

    if (style.font !== undefined) wordI.word.style.font = style.font;
    if (style.size !== undefined) wordI.word.style.size = style.size;
    if (style.bold !== undefined) wordI.word.style.bold = style.bold;
    if (style.italic !== undefined) wordI.word.style.italic = style.italic;
    if (style.underline !== undefined) wordI.word.style.underline = style.underline;
    if (style.smallCaps !== undefined) wordI.word.style.smallCaps = style.smallCaps;
    if (style.sup !== undefined) wordI.word.style.sup = style.sup;
    // Runs are deltas from the word style rewritten above, so keeping them would change what they mean.
    wordI.word.styleRuns = undefined;

    const fontI = _viewer.doc.fonts.getFont(wordI.word.style, wordI.word.lang);

    wordI.fontFaceName = fontI.fontFaceName;
    wordI.fontFaceStyle = fontI.fontFaceStyle;
    wordI.fontFaceWeight = fontI.fontFaceWeight;
    wordI.smallCapsMult = fontI.smallCapsMult;

    wordI.fontFamilyLookup = fontI.family;

    await UiText.updateWordCanvas(wordI);
  }

  UiOcrWord.updateUI();
}
