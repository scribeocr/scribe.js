import scribe from '../../scribe.js';
// eslint-disable-next-line import/no-cycle
import { ScribeViewer } from '../viewer.js';

export function deleteSelectedWord() {
  const selectedObjects = ScribeViewer.CanvasSelection.getKonvaWords();
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
    scribe.utils.ocr.deletePageWords(scribe.data.ocr.active[n], ids);
  }

  ScribeViewer.destroyControls();

  ScribeViewer.layerText.batchDraw();

  // Re-render the page if the user has selected the option to outline lines/pars to update the boxes.
  if (ScribeViewer.opt.outlineLines || ScribeViewer.opt.outlinePars) ScribeViewer.displayPage(ScribeViewer.state.cp.n);
}

/**
 *
 * @param {'left'|'right'} side
 * @param {number} amount
 * @returns
 */
export function modifySelectedWordBbox(side, amount) {
  // const words = ScribeCanvas.getKonvaWords();
  const selectedWords = ScribeViewer.CanvasSelection.getKonvaWords();
  if (selectedWords.length !== 1) return;
  const selectedWord = selectedWords[0];

  selectedWord.word.bbox[side] += amount;
  if (side === 'left') selectedWord.x(selectedWord.x() + amount);
  ScribeViewer.KonvaIText.updateWordCanvas(selectedWord);
}

/**
 *
 * @param {Object} style
 * @param {string} [style.font]
 * @param {number} [style.size]
 * @param {boolean} [style.bold]
 * @param {boolean} [style.italic]
 * @param {boolean} [style.underline]
 * @param {boolean} [style.smallCaps]
 * @param {boolean} [style.sup]
 */
export async function modifySelectedWordStyle(style) {
  const selectedObjects = ScribeViewer.CanvasSelection.getKonvaWords();
  if (!selectedObjects || selectedObjects.length === 0) return;

  if (ScribeViewer.KonvaIText.inputRemove) ScribeViewer.KonvaIText.inputRemove();

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

    const fontI = scribe.data.font.getFont(wordI.word.style, wordI.word.lang);

    wordI.fontFaceName = fontI.fontFaceName;
    wordI.fontFaceStyle = fontI.fontFaceStyle;
    wordI.fontFaceWeight = fontI.fontFaceWeight;
    wordI.smallCapsMult = fontI.smallCapsMult;

    wordI.fontFamilyLookup = fontI.family;

    await ScribeViewer.KonvaIText.updateWordCanvas(wordI);
  }

  ScribeViewer.layerText.batchDraw();
  ScribeViewer.KonvaOcrWord.updateUI();
}
