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
 * Apply markdown formatting wrapper to text based on style key.
 * @param {string} text
 * @param {string} styleKey - 'b', 'i', 'bi', or ''
 * @returns {string}
 */
function applyStyleWrapper(text, styleKey) {
  if (styleKey === 'bi') {
    return `***${text}***`;
  } if (styleKey === 'b') {
    return `**${text}**`;
  } if (styleKey === 'i') {
    return `*${text}*`;
  }
  return text;
}

/**
 * Apply superscript formatting to a word if needed.
 * @param {string} text
 * @param {Object} style
 * @returns {string}
 */
function applySuperscript(text, style) {
  if (style?.sup) {
    return `<sup>${text}</sup>`;
  }
  return text;
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

      // Group consecutive words with the same bold/italic style
      let currentStyleKey = null;
      let styledWords = [];

      // eslint-disable-next-line no-loop-func
      const flushStyledWords = () => {
        if (styledWords.length === 0) return;
        const text = styledWords.join(' ');
        if (applyFormatting) {
          mdStr += applyStyleWrapper(text, currentStyleKey);
        } else {
          mdStr += text;
        }
        styledWords = [];
      };

      for (let i = 0; i < lineObj.words.length; i++) {
        const wordObj = lineObj.words[i];
        if (!wordObj) continue;

        const styleKey = applyFormatting ? (wordObj.style?.bold ? 'b' : '') + (wordObj.style?.italic ? 'i' : '') : '';
        let wordText = escapeMarkdown(wordObj.text);
        if (applyFormatting) {
          wordText = applySuperscript(wordText, wordObj.style);
        }

        // Check if style changed
        if (styleKey !== currentStyleKey && styledWords.length > 0) {
          flushStyledWords();
        }

        if (newLine && !isFirstContent) {
          flushStyledWords();
          mdStr += '\n';
        } else if (!isFirstContent && styledWords.length === 0) {
          mdStr += ' ';
        }

        newLine = false;
        isFirstContent = false;
        currentStyleKey = styleKey;
        styledWords.push(wordText);
      }

      // Flush remaining words at end of line
      flushStyledWords();
    }
    opt.progressHandler({ n: g, type: 'export', info: { } });
  }

  return mdStr;
}
