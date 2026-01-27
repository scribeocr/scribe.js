import { opt } from '../containers/app.js';
import { pageMetricsAll } from '../containers/dataContainer.js';
import { assignParagraphs } from '../utils/reflowPars.js';

/**
 * Escape markdown special characters in text.
 * Only escapes characters that could cause formatting issues mid-text.
 * @param {string} text
 */
function escapeMarkdown(text) {
  return text.replace(/([\\`*_[\]])/g, '\\$1');
}

/**
 * Apply markdown formatting to a word based on its style.
 * @param {string} text
 * @param {Object} style
 */
function applyWordFormatting(text, style) {
  if (!text) return '';

  let result = escapeMarkdown(text);

  // Apply formatting in order: superscript, then bold/italic
  if (style.sup) {
    result = `<sup>${result}</sup>`;
  }

  if (style.bold && style.italic) {
    result = `***${result}***`;
  } else if (style.bold) {
    result = `**${result}**`;
  } else if (style.italic) {
    result = `*${result}*`;
  }

  return result;
}

/**
 * Convert an array of ocrPage objects to markdown text.
 *
 * @param {Object} params
 * @param {Array<OcrPage>} params.ocrCurrent - The OCR data to convert
 * @param {number} [params.minpage=0] - The first page to include in the document.
 * @param {number} [params.maxpage=-1] - The last page to include in the document.
 * @param {boolean} [params.reflowText=false] - Remove line breaks within what appears to be the same paragraph.
 * @param {boolean} [params.applyFormatting=true] - Whether to apply markdown formatting (bold, italic, etc.)
 */
export function writeMarkdown({
  ocrCurrent, minpage = 0, maxpage = -1, reflowText = false, applyFormatting = true,
}) {
  let mdStr = '';

  if (maxpage === -1) maxpage = ocrCurrent.length - 1;

  let newLine = false;
  let isFirstContent = true;

  for (let g = minpage; g <= maxpage; g++) {
    if (!ocrCurrent[g] || ocrCurrent[g].lines.length === 0) continue;

    const pageObj = ocrCurrent[g];

    if (reflowText && (!pageObj.textSource || !['textract', 'abbyy', 'google_vision', 'azure_doc_intel', 'docx'].includes(pageObj.textSource))) {
      const angle = pageMetricsAll[g].angle || 0;
      assignParagraphs(pageObj, angle);
    }

    // Add page break marker between pages (except before first page)
    // There is no official markdown syntax for page breaks,
    // but this appears to be a common convention.
    if (!isFirstContent && g > minpage) {
      mdStr += '\n\n---\n\n';
    }

    let parCurrent = pageObj.lines[0].par;

    for (let h = 0; h < pageObj.lines.length; h++) {
      const lineObj = pageObj.lines[h];

      if (reflowText) {
        if (h === 0 && !isFirstContent || lineObj.par !== parCurrent) newLine = true;
        parCurrent = lineObj.par;
      } else {
        newLine = true;
      }

      for (let i = 0; i < lineObj.words.length; i++) {
        const wordObj = lineObj.words[i];
        if (!wordObj) continue;

        if (newLine && !isFirstContent) {
          mdStr += '\n';
        } else if (!isFirstContent) {
          mdStr += ' ';
        }

        newLine = false;
        isFirstContent = false;

        if (applyFormatting) {
          mdStr += applyWordFormatting(wordObj.text, wordObj.style);
        } else {
          mdStr += escapeMarkdown(wordObj.text);
        }
      }
    }
    opt.progressHandler({ n: g, type: 'export', info: { } });
  }

  return mdStr;
}
