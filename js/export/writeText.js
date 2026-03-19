import { opt } from '../containers/app.js';
import { pageMetricsAll } from '../containers/dataContainer.js';
import { assignParagraphs } from '../utils/reflowPars.js';

/**
 * Convert an array of ocrPage objects to plain text.
 *
 * @param {Object} params
 * @param {Array<OcrPage>} params.ocrCurrent -
 * @param {?Array<number>} [params.pageArr=null] - Array of 0-based page indices to include. Overrides minpage/maxpage when provided.
 * @param {number} [params.minpage=0] - The first page to include in the document.
 * @param {number} [params.maxpage=-1] - The last page to include in the document.
 * @param {boolean} [params.reflowText=false] - Remove line breaks within what appears to be the same paragraph.
 * @param {?Array<string>} [params.wordIds=null] - An array of word IDs to include in the document.
 *    If omitted, all words are included.
 * @param {boolean} [params.lineNumbers=false] - Prepend `page:line` numbers to each line (e.g. `0:5  text`).
 *    When enabled, reflowText is ignored.
 * @param {boolean} [params.preserveSpacing=false] - Pad words with spaces based on their horizontal
 *    position in the document, preserving column alignment. Useful for table extraction.
 */
export function writeText({
  ocrCurrent, pageArr = null, minpage = 0, maxpage = -1, reflowText = false,
  wordIds = null, lineNumbers = false, preserveSpacing = false,
}) {
  let textStr = '';

  if (!pageArr) {
    if (maxpage === -1) maxpage = ocrCurrent.length - 1;
    pageArr = [];
    for (let i = minpage; i <= maxpage; i++) pageArr.push(i);
  }

  let newLine = false;

  // lineNumbers mode is incompatible with reflowText
  const doReflow = reflowText && !lineNumbers && !preserveSpacing;

  // Character width of the full page when preserveSpacing is on.
  const lineWidth = 120;

  for (const g of pageArr) {
    if (!ocrCurrent[g] || ocrCurrent[g].lines.length === 0) continue;

    const pageObj = ocrCurrent[g];
    const pageWidth = preserveSpacing && pageMetricsAll[g] ? pageMetricsAll[g].dims.width : 0;

    if (doReflow && (!pageObj.textSource || !['textract', 'abbyy', 'google_vision', 'azure_doc_intel', 'docx'].includes(pageObj.textSource))) {
      const angle = pageMetricsAll[g].angle || 0;
      assignParagraphs(pageObj, angle);
    }

    let parCurrent = pageObj.lines[0].par;

    for (let h = 0; h < pageObj.lines.length; h++) {
      const lineObj = pageObj.lines[h];

      if (doReflow) {
        if (g > 0 && h === 0 || lineObj.par !== parCurrent) newLine = true;
        parCurrent = lineObj.par;
      } else {
        newLine = true;
      }

      let currentPos = 0;
      const prefixLen = lineNumbers ? `${g}:${h}  `.length : 0;

      for (let i = 0; i < lineObj.words.length; i++) {
        const wordObj = lineObj.words[i];
        if (!wordObj) continue;

        if (wordIds && !wordIds.includes(wordObj.id)) continue;

        if (newLine) {
          textStr += '\n';
          if (lineNumbers) textStr += `${g}:${h}  `;
          currentPos = prefixLen;
        } else if (preserveSpacing && pageWidth > 0) {
          const targetPos = prefixLen + Math.round(wordObj.bbox.left / pageWidth * lineWidth);
          const padding = Math.max(1, targetPos - currentPos);
          textStr += ' '.repeat(padding);
          currentPos = targetPos + wordObj.text.length;
        } else if (h > 0 || g > 0 || i > 0) {
          textStr += ' ';
        }

        if (newLine && preserveSpacing && pageWidth > 0) {
          const targetPos = prefixLen + Math.round(wordObj.bbox.left / pageWidth * lineWidth);
          const padding = Math.max(0, targetPos - currentPos);
          textStr += ' '.repeat(padding);
          currentPos = targetPos + wordObj.text.length;
        }

        newLine = false;

        textStr += wordObj.text;
      }
    }
    opt.progressHandler({ n: g, type: 'export', info: { } });
  }

  return textStr;
}
