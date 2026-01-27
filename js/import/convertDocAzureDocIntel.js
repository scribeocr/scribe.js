import ocr from '../objects/ocrObjects.js';

import { LayoutDataTablePage } from '../objects/layoutObjects.js';
import { pass2, pass3 } from './convertPageShared.js';

// NOTE: This is a WIP and incomplete.
// The Azure Document Intelligence format is not yet supported.

const debugMode = false;

/**
 * @param {Object} params
 * @param {string} params.ocrStr
 * @param {dims[]} params.pageDims - Page metrics to use for the pages
 */
export async function convertDocAzureDocIntel({ ocrStr, pageDims }) {
  let ocrData;
  try {
    ocrData = JSON.parse(ocrStr);
  } catch (error) {
    throw new Error('Failed to parse Azure Document Intelligence JSON data.');
  }

  if (!ocrData.analyzeResult || !ocrData.analyzeResult.pages || !ocrData.analyzeResult.pages[0]) {
    throw new Error('Invalid Azure Document Intelligence format: missing pages data.');
  }

  const analyzeResultPages = /** @type {AzureDocIntelPage[]} */ (ocrData.analyzeResult.pages);

  const resArr = [];

  for (let n = 0; n < analyzeResultPages.length; n++) {
    const pageData = analyzeResultPages[n];
    const pageDimsN = pageDims[n];

    if (!pageData.width || !pageData.height) {
      throw new Error('Failed to parse page dimensions.');
    }

    const pageObj = new ocr.OcrPage(n, pageDimsN);
    pageObj.textSource = 'azure_doc_intel';

    if (!pageData.words || pageData.words.length === 0) {
      const warn = { char: 'char_error' };
      resArr.push({
        pageObj, charMetricsObj: {}, dataTables: new LayoutDataTablePage(n), warn,
      });
    }

    if (pageData.unit !== 'pixel') {
      if (!pageDimsN || !pageDimsN.width || !pageDimsN.height) {
        throw new Error('Page dimensions must be provided for non-pixel units.');
      }

      const pageDimsMult = {
        width: pageDimsN.width / pageData.width,
        height: pageDimsN.height / pageData.height,
      };

      pageData.lines.forEach((line) => {
        line.polygon = line.polygon.map((val, idx) => (idx % 2 === 0 ? val * pageDimsMult.width : val * pageDimsMult.height));
      });

      pageData.words.forEach((word) => {
        word.polygon = word.polygon.map((val, idx) => (idx % 2 === 0 ? val * pageDimsMult.width : val * pageDimsMult.height));
      });
    }

    for (let i = 0; i < pageData.lines.length; i++) {
      const lineWordsInput = /** @type {AzureDocIntelWord[]} */ ([]);
      for (let j = 0; j < pageData.lines[i].spans.length; j++) {
        const span = pageData.lines[i].spans[j];
        for (let k = 0; k < pageData.words.length; k++) {
          const wordSpan = pageData.words[k].span;
          if (wordSpan.offset >= span.offset && (wordSpan.offset + wordSpan.length) <= (span.offset + span.length)) {
            lineWordsInput.push(pageData.words[k]);
          }
        }
      }

      if (lineWordsInput.length === 0) continue;

      const allX = lineWordsInput.flatMap((w) => w.polygon.filter((_, i) => i % 2 === 0));
      const allY = lineWordsInput.flatMap((w) => w.polygon.filter((_, i) => i % 2 === 1));

      const lineBbox = {
        left: Math.min(...allX),
        top: Math.min(...allY),
        right: Math.max(...allX),
        bottom: Math.max(...allY),
      };

      const baseline = [0, 0];

      const lineObj = new ocr.OcrLine(pageObj, lineBbox, baseline);
      if (debugMode) {
        lineObj.debug.raw = JSON.stringify(lineWordsInput);
      }

      for (let j = 0; j < lineWordsInput.length; j++) {
        const wordData = lineWordsInput[j];

        if (!wordData.content || wordData.content.trim() === '') continue;

        const wordX = wordData.polygon.filter((_, i) => i % 2 === 0);
        const wordY = wordData.polygon.filter((_, i) => i % 2 === 1);

        const wordBbox = {
          left: Math.min(...wordX),
          top: Math.min(...wordY),
          right: Math.max(...wordX),
          bottom: Math.max(...wordY),
        };

        const wordId = `word_${n + 1}_${pageObj.lines.length + 1}_${j + 1}`;
        const wordObj = new ocr.OcrWord(lineObj, wordId, wordData.content, wordBbox);

        wordObj.conf = Math.round((wordData.confidence || 0) * 100);

        if (debugMode) {
          wordObj.debug.raw = JSON.stringify(wordData);
        }

        lineObj.words.push(wordObj);
      }

      if (lineObj.words.length > 0) {
        pageObj.lines.push(lineObj);
      }
    }

    const pageAngle = pageData.angle || 0;
    pageObj.angle = pageAngle;

    // pass2(pageObj, 0);
    const langSet = pass3(pageObj);

    const dataTables = new LayoutDataTablePage(n);

    resArr.push({ pageObj, dataTables, langSet });
  }

  return resArr;
}
