import ocr from '../objects/ocrObjects.js';
import { LayoutDataTablePage } from '../objects/layoutObjects.js';
import { calcWordCharMetrics } from '../utils/fontUtils.js';
import { FontCont } from '../containers/fontContainer.js';

const FONT_FAMILY = 'Times New Roman';
const FONT_SIZE = 12;
const CHAR_SPACING = 1;
const LINE_HEIGHT = 14.4;
const ASCENDER_HEIGHT = 9.6;
const DESCENDER_HEIGHT = 2.4;

/** @type {?opentype.Font} */
let fontOpentype = null;

/**
 * Calculates the advance of a string in pixels.
 * @param {string} text
 * @param {number} size
 * @param {opentype.Font} font
 */
function getTextAdvance(text, size, font) {
  const { advanceArr, kerningArr } = calcWordCharMetrics(text, font);

  const advanceTotal = advanceArr.reduce((a, b) => a + b, 0);
  const kerningTotal = kerningArr.reduce((a, b) => a + b, 0);

  const wordWidth1 = (advanceTotal + kerningTotal) * (size / font.unitsPerEm);
  const spacingTotalPx = (text.length - 1) * CHAR_SPACING;
  const wordWidth = wordWidth1 + spacingTotalPx;

  return wordWidth;
}

/**
 * Splits text into words, preserving whitespace information
 * @param {string} line - The line of text
 * @returns {Array<{text: string, isWhitespace: boolean}>} Array of word objects
 */
function splitIntoWords(line) {
  const words = [];
  let currentWord = '';
  let isInWhitespace = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const charIsWhitespace = /\s/.test(char);

    if (charIsWhitespace !== isInWhitespace) {
      if (currentWord.length > 0) {
        words.push({ text: currentWord, isWhitespace: isInWhitespace });
        currentWord = '';
      }
      isInWhitespace = charIsWhitespace;
    }
    currentWord += char;
  }

  if (currentWord.length > 0) {
    words.push({ text: currentWord, isWhitespace: isInWhitespace });
  }

  return words;
}

/**
 * Convert raw text to internal OCR format
 * @param {Object} params
 * @param {string} params.textStr - Raw text content
 * @param {?{width: number, height: number}} [params.pageDims] - Page dimensions (will be calculated if not provided)
 */
export async function convertPageText({ textStr, pageDims = null }) {
  let pageIndex = 0;

  if (!fontOpentype) {
    fontOpentype = (await FontCont.getFont({ font: FONT_FAMILY })).opentype;
  }

  const lines = textStr.split(/\r?\n/);

  if (!pageDims) {
    pageDims = { width: 612, height: 792 }; // Default to letter size (8.5 x 11 inches)
  }

  let pageObj = new ocr.OcrPage(pageIndex, pageDims);
  pageObj.textSource = 'text';

  if (lines.length === 0 || lines.every((line) => line.trim() === '')) {
    const warn = { char: 'char_error' };
    return {
      pageObj,
      charMetricsObj: {},
      dataTables: new LayoutDataTablePage(0),
      warn,
    };
  }

  let tablesPage = new LayoutDataTablePage(0);
  const pagesOut = [{ pageObj, dataTables: tablesPage }];
  const margin = 20;
  const availableWidth = pageDims.width - margin * 2;

  let currentY = margin + ASCENDER_HEIGHT;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const lineText = lines[lineIndex];

    if (lineText.length === 0 || lineText.trim().length === 0) {
      currentY += LINE_HEIGHT;
      if (currentY + DESCENDER_HEIGHT > pageDims.height - margin) {
        pageIndex++;
        const newPage = new ocr.OcrPage(pageIndex, pageDims);
        newPage.textSource = 'text';
        const newTables = new LayoutDataTablePage(0);
        pagesOut.push({ pageObj: newPage, dataTables: newTables });
        pageObj = newPage;
        tablesPage = newTables;
        currentY = margin + ASCENDER_HEIGHT;
      }
      continue;
    }

    const wordTokens = splitIntoWords(lineText);

    const parLines = [];
    let parRight = margin;

    for (let idx = 0; idx < wordTokens.length;) {
      if (currentY + DESCENDER_HEIGHT > pageDims.height - margin) {
        if (parLines.length > 0) {
          const parBbox = {
            left: margin,
            top: parLines[0].bbox.top,
            right: parRight,
            bottom: parLines[parLines.length - 1].bbox.bottom,
          };
          const parObj = new ocr.OcrPar(pageObj, parBbox);
          parObj.lines = parLines;
          for (const ln of parLines) ln.par = parObj;
          pageObj.pars.push(parObj);
          parLines.length = 0;
          parRight = margin;
        }
        pageIndex++;
        const newPage = new ocr.OcrPage(pageIndex, pageDims);
        newPage.textSource = 'text';
        const newTables = new LayoutDataTablePage(0);
        pagesOut.push({ pageObj: newPage, dataTables: newTables });
        pageObj = newPage;
        tablesPage = newTables;
        currentY = margin + ASCENDER_HEIGHT;
      }

      const baseline = [0, DESCENDER_HEIGHT];
      const lineTop = Math.round(currentY - ASCENDER_HEIGHT);
      const lineBottom = Math.round(currentY + DESCENDER_HEIGHT);

      let currentX = margin;
      let widthSoFar = 0;

      const lineBbox = {
        left: margin,
        top: lineTop,
        right: margin,
        bottom: lineBottom,
      };
      const lineObj = new ocr.OcrLine(
        pageObj,
        lineBbox,
        baseline,
        ASCENDER_HEIGHT,
        ASCENDER_HEIGHT - DESCENDER_HEIGHT,
      );

      let lastConsumed = idx;
      for (let j = idx; j < wordTokens.length; j++) {
        const tok = wordTokens[j];
        const tokWidth = getTextAdvance(tok.text, FONT_SIZE, fontOpentype);

        if (tok.isWhitespace) {
          if (lineObj.words.length === 0) {
            // leading whitespace allowed if it fits
            if (widthSoFar + tokWidth > availableWidth) break;
            currentX += tokWidth;
            widthSoFar += tokWidth;
            lastConsumed = j + 1;
          } else {
            // trailing/middle whitespace (allowed even if it exceeds width)
            currentX += tokWidth;
            widthSoFar += tokWidth;
            lastConsumed = j + 1;
          }
        } else {
          if (lineObj.words.length > 0 && widthSoFar + tokWidth > availableWidth) {
            // wrap before this word
            break;
          }
          // place the word
          const wordBbox = {
            left: Math.round(currentX),
            top: lineTop,
            right: Math.round(currentX + tokWidth),
            bottom: lineBottom,
          };
          const wordId = `word_${pageIndex + 1}_${pageObj.lines.length + 1}_${lineObj.words.length + 1}`;
          const wordObj = new ocr.OcrWord(lineObj, tok.text, wordBbox, wordId);
          wordObj.conf = 100;
          wordObj.style.font = FONT_FAMILY;
          lineObj.words.push(wordObj);

          currentX += tokWidth;
          widthSoFar += tokWidth;
          lastConsumed = j + 1;
        }
      }

      // Extreme edge case: force place a long word when nothing fit and next token is a non-whitespace word
      if (lineObj.words.length === 0) {
        const nextTok = wordTokens[idx];
        if (nextTok && !nextTok.isWhitespace) {
          const tokWidth = getTextAdvance(nextTok.text, FONT_SIZE, fontOpentype);
          const wordBbox = {
            left: Math.round(currentX),
            top: lineTop,
            right: Math.round(currentX + tokWidth),
            bottom: lineBottom,
          };
          const wordId = `word_${pageIndex + 1}_${pageObj.lines.length + 1}_${lineObj.words.length + 1}`;
          const wordObj = new ocr.OcrWord(lineObj, nextTok.text, wordBbox, wordId);
          wordObj.conf = 100;
          wordObj.style.font = FONT_FAMILY;
          lineObj.words.push(wordObj);
          currentX += tokWidth;
          widthSoFar += tokWidth;
          lastConsumed = idx + 1;
        } else {
          // Can't place oversized leading whitespace; stop processing this paragraph
          break;
        }
      }

      if (lineObj.words.length > 0) {
        lineObj.bbox = {
          left: lineObj.words[0].bbox.left,
          top: lineTop,
          right: Math.round(currentX),
          bottom: lineBottom,
        };

        pageObj.lines.push(lineObj);
        parLines.push(lineObj);
        parRight = Math.max(parRight, lineObj.bbox.right);

        currentY += LINE_HEIGHT;
        idx = lastConsumed;
      }
    }

    if (parLines.length > 0) {
      const parBbox = {
        left: margin,
        top: parLines[0].bbox.top,
        right: parRight,
        bottom: parLines[parLines.length - 1].bbox.bottom,
      };
      const parObj = new ocr.OcrPar(pageObj, parBbox);
      parObj.lines = parLines;
      for (const ln of parLines) ln.par = parObj;
      pageObj.pars.push(parObj);
    }
  }

  pageObj.angle = 0;

  return pagesOut;
}
