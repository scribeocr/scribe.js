import { opt } from '../containers/app.js';
import { pageMetricsAll } from '../containers/dataContainer.js';
import { assignParagraphs } from '../utils/reflowPars.js';
import { extractTableContent } from '../extractTables.js';
import { calcTableBbox } from '../objects/layoutObjects.js';
import { calcBoxOverlap } from '../utils/miscUtils.js';

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
 * Render a table as a markdown pipe table.
 * @param {{ rowWordArr: Array<Array<Array<OcrWord>>>, rowBottomArr: Array<number> }} tableResult
 * @param {boolean} applyFormatting
 */
function renderMarkdownTable(tableResult, applyFormatting) {
  const { rowWordArr } = tableResult;
  if (!rowWordArr || rowWordArr.length === 0) return '';

  const numCols = Math.max(...rowWordArr.map((row) => row.length));
  let md = '';

  for (let r = 0; r < rowWordArr.length; r++) {
    const cells = [];
    for (let c = 0; c < numCols; c++) {
      const words = rowWordArr[r]?.[c] || [];
      if (words.length === 0) {
        cells.push('');
      } else {
        words.sort((a, b) => a.bbox.left - b.bbox.left);
        let cellText = '';
        let currentStyleKey = '';
        let styledGroup = [];
        for (const w of words) {
          let text = escapeMarkdown(w.text).replace(/\|/g, '\\|');
          if (applyFormatting) text = applySuperscript(text, w.style);
          const styleKey = applyFormatting ? (w.style?.bold ? 'b' : '') + (w.style?.italic ? 'i' : '') : '';
          if (styleKey !== currentStyleKey && styledGroup.length > 0) {
            if (cellText) cellText += ' ';
            cellText += applyStyleWrapper(styledGroup.join(' '), currentStyleKey);
            styledGroup = [];
          }
          currentStyleKey = styleKey;
          styledGroup.push(text);
        }
        if (styledGroup.length > 0) {
          if (cellText) cellText += ' ';
          cellText += applyFormatting ? applyStyleWrapper(styledGroup.join(' '), currentStyleKey) : styledGroup.join(' ');
        }
        cells.push(cellText);
      }
    }
    md += `| ${cells.join(' | ')} |\n`;

    // Insert separator row after the header (first row)
    if (r === 0) {
      md += `| ${Array(numCols).fill('---').join(' | ')} |\n`;
    }
  }

  return md;
}

/**
 * Convert an array of ocrPage objects to markdown text.
 *
 * @param {Object} params
 * @param {Array<OcrPage>} params.ocrCurrent - The OCR data to convert
 * @param {Array<import('../objects/layoutObjects.js').LayoutDataTablePage>} [params.layoutPageArr] - Table layout data per page.
 * @param {?Array<number>} [params.pageArr=null] - Array of 0-based page indices to include. Overrides minpage/maxpage when provided.
 * @param {number} [params.minpage=0] - The first page to include in the document.
 * @param {number} [params.maxpage=-1] - The last page to include in the document.
 * @param {boolean} [params.reflowText=false] - Remove line breaks within what appears to be the same paragraph.
 * @param {boolean} [params.applyFormatting=true] - Whether to apply markdown formatting (bold, italic, etc.)
 */
export function writeMarkdown({
  ocrCurrent, layoutPageArr, pageArr = null, minpage = 0, maxpage = -1,
  reflowText = false, applyFormatting = true,
}) {
  let mdStr = '';

  if (!pageArr) {
    if (maxpage === -1) maxpage = ocrCurrent.length - 1;
    pageArr = [];
    for (let i = minpage; i <= maxpage; i++) pageArr.push(i);
  }

  let newLine = false;
  let isFirstContent = true;

  for (const g of pageArr) {
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

    const layoutPage = layoutPageArr?.[g];
    const tableWordObj = layoutPage && layoutPage.tables && layoutPage.tables.length > 0
      ? extractTableContent(pageObj, layoutPage)
      : {};

    // Compute table bounding boxes and track which tables have been rendered.
    const tableBboxes = [];
    const tablesRendered = new Set();
    if (layoutPage?.tables) {
      for (let t = 0; t < layoutPage.tables.length; t++) {
        const table = layoutPage.tables[t];
        if (table.boxes.length > 0) {
          tableBboxes.push({ idx: t, key: String(t), bbox: calcTableBbox(table) });
        }
      }
    }

    let parCurrent = pageObj.lines[0].par;

    for (let h = 0; h < pageObj.lines.length; h++) {
      const lineObj = pageObj.lines[h];

      // Check if this line falls inside a table.
      let insideTable = null;
      for (const tb of tableBboxes) {
        const overlap = calcBoxOverlap(lineObj.bbox, tb.bbox);
        if (overlap > 0.5) {
          insideTable = tb;
          break;
        }
      }

      if (insideTable) {
        // If this table hasn't been rendered yet, render it now.
        if (!tablesRendered.has(insideTable.key)) {
          tablesRendered.add(insideTable.key);
          const tableResult = tableWordObj[insideTable.key];
          if (tableResult) {
            if (!isFirstContent) mdStr += '\n\n';
            mdStr += renderMarkdownTable(tableResult, applyFormatting);
            isFirstContent = false;
          }
        }
        // Skip this line (it's part of the table).
        continue;
      }

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
