import { opt } from '../containers/app.js';
import { pageMetricsAll } from '../containers/dataContainer.js';
import { assignParagraphs } from '../utils/reflowPars.js';

/**
 * Convert an array of ocrPage objects to plain text.
 *
 * @param {Object} params
 * @param {Array<OcrPage>} params.ocrCurrent -
 * @param {number} [params.minpage=0] - The first page to include in the document.
 * @param {number} [params.maxpage=-1] - The last page to include in the document.
 * @param {boolean} [params.reflowText=false] - Remove line breaks within what appears to be the same paragraph.
 * @param {?Array<string>} [params.wordIds=null] - An array of word IDs to include in the document.
 *    If omitted, all words are included.
 */
export function writeText({
  ocrCurrent, minpage = 0, maxpage = -1, reflowText = false, wordIds = null,
}) {
  let textStr = '';

  if (maxpage === -1) maxpage = ocrCurrent.length - 1;

  let newLine = false;

  for (let g = minpage; g <= maxpage; g++) {
    if (!ocrCurrent[g] || ocrCurrent[g].lines.length === 0) continue;

    const pageObj = ocrCurrent[g];

    // Do not overwrite paragraphs from Abbyy or Textract.
    if (reflowText && (!pageObj.textSource || !['textract', 'abbyy'].includes(pageObj.textSource))) {
      const angle = pageMetricsAll[g].angle || 0;
      assignParagraphs(pageObj, angle);
    }

    let parCurrent = pageObj.lines[0].par;

    for (let h = 0; h < pageObj.lines.length; h++) {
      const lineObj = pageObj.lines[h];

      if (reflowText) {
        if (g > 0 && h === 0 || lineObj.par !== parCurrent) newLine = true;
        parCurrent = lineObj.par;
      } else {
        newLine = true;
      }

      for (let i = 0; i < lineObj.words.length; i++) {
        const wordObj = lineObj.words[i];
        if (!wordObj) continue;

        if (wordIds && !wordIds.includes(wordObj.id)) continue;

        if (newLine) {
          textStr = `${textStr}\n`;
        } else if (h > 0 || g > 0 || i > 0) {
          textStr = `${textStr} `;
        }

        newLine = false;

        textStr += wordObj.text;
      }
    }
    opt.progressHandler({ n: g, type: 'export', info: { } });
  }

  return textStr;
}
