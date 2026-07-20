import { scribeDocDefaults } from '../containers/scribeDocDefaults.js';
import ocr from '../objects/ocrObjects.js';
import { calcWordMetrics } from './fontUtils.js';
import { calcBboxUnion, getRandomAlphanum } from './miscUtils.js';

/**
 * Count words above the high-confidence threshold across `pages`.
 * @param {Array<OcrPage>} pages
 * @param {number} [confThreshHigh]
 */
export const calcConf = (pages, confThreshHigh = scribeDocDefaults.confThreshHigh) => {
  let wordsTotal = 0;
  let wordsHighConf = 0;
  for (let i = 0; i < pages.length; i++) {
    const words = ocr.getPageWords(pages[i]);
    for (let j = 0; j < words.length; j++) {
      const word = words[j];
      wordsTotal += 1;
      if (word.conf > confThreshHigh) wordsHighConf += 1;
    }
  }
  return { total: wordsTotal, highConf: wordsHighConf };
};

/**
 * Fields of `style` that differ from `base`.
 * @param {Style} base
 * @param {Style} style
 * @returns {Partial<Style>}
 */
const diffStyle = (base, style) => {
  /** @type {Partial<Style>} */
  const delta = {};
  for (const key of Object.keys(style)) {
    if (style[key] !== base[key]) delta[key] = style[key];
  }
  return delta;
};

/**
 *
 * @param {OcrWord} word
 * @param {number} splitIndex
 * @param {import('../containers/fontContainer.js').DocFonts} docFonts - Fonts used to estimate the
 *   split point when character-level metrics are missing or unreliable.
 * @returns
 */
export function splitOcrWord(word, splitIndex, docFonts) {
  const wordA = ocr.cloneWord(word);
  const wordB = ocr.cloneWord(word);

  // Character-level metrics are often present and reliable, however may not be.
  // If a user edits the text, then the character-level metrics from the OCR engine will not match.
  // Therefore, a fallback strategy is used in this case to calculate where to split the word.
  const validCharData = word.chars && word.chars.map((x) => x.text).join('') === word.text;
  if (wordA.chars && wordB.chars) {
    wordA.chars.splice(splitIndex);
    wordB.chars.splice(0, splitIndex);
    if (validCharData) {
      wordA.bbox = calcBboxUnion(wordA.chars.map((x) => x.bbox));
      wordB.bbox = calcBboxUnion(wordB.chars.map((x) => x.bbox));
    }
  }

  // TODO: This is a quick fix; figure out how to get this math correct.
  if (!validCharData) {
    const metrics = calcWordMetrics(wordA, docFonts);
    wordA.bbox.right -= metrics.advanceArr.slice(splitIndex).reduce((a, b) => a + b, 0);
    wordB.bbox.left = wordA.bbox.right;
  }

  if (word.styleRuns) {
    const runsA = word.styleRuns.filter((run) => run.i < splitIndex).map((run) => ({ i: run.i, style: { ...run.style } }));
    wordA.styleRuns = runsA.length > 0 ? runsA : undefined;
    // Unlike wordA, wordB's base style changed, so its deltas must be recomputed.
    const runAtSplit = word.styleRuns.filter((run) => run.i <= splitIndex).pop();
    const styleB = runAtSplit ? { ...word.style, ...runAtSplit.style } : { ...word.style };
    wordB.style = styleB;
    const runsB = word.styleRuns.filter((run) => run.i > splitIndex)
      .map((run) => ({ i: run.i - splitIndex, style: diffStyle(styleB, { ...word.style, ...run.style }) }));
    wordB.styleRuns = runsB.length > 0 ? runsB : undefined;
  }

  wordA.text = wordA.text.split('').slice(0, splitIndex).join('');
  wordB.text = wordB.text.split('').slice(splitIndex).join('');

  wordA.id = `${word.id}a`;
  wordB.id = `${word.id}b`;

  return { wordA, wordB };
}

/**
 *
 * @param {Array<OcrWord>} words
 * @returns
 */
export function mergeOcrWords(words) {
  words.sort((a, b) => a.bbox.left - b.bbox.left);
  const wordA = ocr.cloneWord(words[0]);
  wordA.bbox.right = words[words.length - 1].bbox.right;
  wordA.text = words.map((x) => x.text).join('');
  if (wordA.chars) wordA.chars = words.flatMap((x) => x.chars || []);

  const runs = wordA.styleRuns ? wordA.styleRuns.map((run) => ({ i: run.i, style: { ...run.style } })) : [];
  let tailStyle = runs.length > 0 ? { ...wordA.style, ...runs[runs.length - 1].style } : wordA.style;
  let offset = words[0].text.length;
  for (let wi = 1; wi < words.length; wi++) {
    const word = words[wi];
    const segments = [{ i: 0, style: word.style }];
    if (word.styleRuns) for (const run of word.styleRuns) segments.push({ i: run.i, style: { ...word.style, ...run.style } });
    for (const segment of segments) {
      if (Object.keys(diffStyle(tailStyle, segment.style)).length === 0) continue;
      runs.push({ i: offset + segment.i, style: diffStyle(wordA.style, segment.style) });
      tailStyle = segment.style;
    }
    offset += word.text.length;
  }
  wordA.styleRuns = runs.length > 0 ? runs : undefined;
  return wordA;
}

/**
 *
 * @param {Array<OcrWord>} words
 * @returns
 */
export const checkOcrWordsAdjacent = (words) => {
  const sortedWords = words.slice().sort((a, b) => a.bbox.left - b.bbox.left);
  const lineWords = words[0].line.words;
  lineWords.sort((a, b) => a.bbox.left - b.bbox.left);

  const firstIndex = lineWords.findIndex((x) => x.id === sortedWords[0].id);
  const lastIndex = lineWords.findIndex((x) => x.id === sortedWords[sortedWords.length - 1].id);
  return lastIndex - firstIndex === sortedWords.length - 1;
};

/**
 *
 * @param {OcrLine} line
 */
export const splitLineAgressively = (line) => {
  /** @type {Array<OcrLine>} */
  const linesOut = [];
  const lineHeight = line.bbox.bottom - line.bbox.top;
  let wordPrev = line.words[0];
  let lineCurrent = ocr.cloneLine(line);
  lineCurrent.words = [line.words[0]];
  for (let i = 1; i < line.words.length; i++) {
    const word = ocr.cloneWord(line.words[i]);
    if (word.bbox.left - wordPrev.bbox.right > lineHeight) {
      linesOut.push(lineCurrent);
      lineCurrent = ocr.cloneLine(line);
      word.line = lineCurrent;
      lineCurrent.words = [word];
    } else {
      word.line = lineCurrent;
      lineCurrent.words.push(word);
    }
    wordPrev = word;
  }
  linesOut.push(lineCurrent);

  linesOut.forEach((x) => {
    ocr.updateLineBbox(x);
  });

  // Generate new IDs for all split lines except the first (which keeps the original ID)
  for (let i = 1; i < linesOut.length; i++) {
    linesOut[i].id = getRandomAlphanum(8);
  }

  return linesOut;
};
