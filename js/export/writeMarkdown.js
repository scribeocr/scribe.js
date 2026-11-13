import { assignParagraphs, lineEndEvidence, lineJoin } from '../utils/reflowPars.js';
import { extractTableContent } from '../extractTables.js';
import { calcTableBbox } from '../objects/layoutObjects.js';
import {
  getWordStyleSegments, isNoteLeader, parIsFurniture, parMarkerInText, splitNoteReference,
} from '../objects/ocrObjects.js';
import { calcBoxOverlap } from '../utils/miscUtils.js';

/**
 * Escape markdown special characters in text.
 * Only escapes characters that could cause formatting issues mid-text.
 * @param {string} text
 */
function escapeMarkdown(text) {
  return text.replace(/([\\`*_[\]~])/g, '\\$1')
    .replace(/<(?=[a-zA-Z/!])/g, '\\<')
    .replace(/&(?=[a-zA-Z0-9#][a-zA-Z0-9]{0,31};)/g, '\\&');
}

/** @type {Object<string, string>} */
const LIST_MARKERS = { '•': '-', '☐': '- [ ]', '☑': '- [x]' };

/**
 * Escape a leading character that would otherwise open a markdown block, so exported text is read back as text.
 * A leading `*` or `_` is already escaped by `escapeMarkdown`.
 * @param {string} text
 */
function escapeLeadingSyntax(text) {
  if (/^(?:[#>|]|~{3}|=+[ \t]*$|-+[ \t]*$|[-+][ \t])/.test(text)) return `\\${text}`;
  return text.replace(/^(\d{1,9})([.)])([ \t])/, '$1\\$2$3');
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
 * @param {?Array<PageMetrics>} [params.pageMetrics=null] - Page metrics for the document being exported.
 *   Required when reflow or preserveSpacing is enabled.
 * @param {boolean} [params.dropPageHeadersFooters=false] - Leave page headers and footers, with page numbers and margin line numbers, out when reflowing.
 * @param {?import('../containers/scribeDoc.js').ScribeDoc} [params.doc=null] - Owning document for progress reporting.
 */
export function writeMarkdown({
  ocrCurrent, layoutPageArr, pageArr = null, minpage = 0, maxpage = -1,
  reflowText = false, applyFormatting = true, pageMetrics = null, dropPageHeadersFooters = false, doc = null,
}) {
  let mdStr = '';

  if (!pageArr) {
    if (maxpage === -1) maxpage = ocrCurrent.length - 1;
    pageArr = [];
    for (let i = minpage; i <= maxpage; i++) pageArr.push(i);
  }

  /** @type {Map<string, string>} */
  const fnLabelById = new Map();
  const fnLabelsUsed = new Set();
  /** @param {string} own */
  const uniqueLabel = (own) => {
    let label = own;
    for (let k = 2; fnLabelsUsed.has(label); k++) label = `${own}-${k}`;
    fnLabelsUsed.add(label);
    return label;
  };
  const parById = new Map();
  for (const g of pageArr) {
    for (const par of ocrCurrent[g]?.pars || []) parById.set(par.id, par);
  }
  for (const g of pageArr) {
    for (const lineObj of ocrCurrent[g]?.lines || []) {
      for (const word of lineObj.words) {
        if (!word || !word.footnoteParId) continue;
        const fnPar = parById.get(word.footnoteParId);
        if (!fnPar || (fnPar.type !== 'footnote' && fnPar.type !== 'endnote') || fnLabelById.has(fnPar.id)) continue;
        const own = fnPar.marker && /^[^\s\]]+$/.test(fnPar.marker) ? fnPar.marker : splitNoteReference(word).label;
        if (own) fnLabelById.set(fnPar.id, uniqueLabel(own));
      }
    }
  }
  for (const g of pageArr) {
    for (const par of ocrCurrent[g]?.pars || []) {
      if (par.type === 'footnote' && par.marker && /^[^\s\]]+$/.test(par.marker) && !parMarkerInText(par) && !fnLabelById.has(par.id)) fnLabelById.set(par.id, uniqueLabel(par.marker));
    }
  }

  const evidence = reflowText ? lineEndEvidence(ocrCurrent) : null;

  let isFirstContent = true;

  /** @type {?string} */
  let lineBuf = null;
  let lineSep = '\n\n';
  let linePrefix = '';
  let lineEscape = true;
  /** @type {?string} */
  let openFence = null;

  const flushLine = () => {
    if (lineBuf) {
      if (!isFirstContent) mdStr += lineSep;
      mdStr += linePrefix + (lineEscape ? escapeLeadingSyntax(lineBuf) : lineBuf);
      isFirstContent = false;
      linePrefix = '';
    }
    lineBuf = null;
  };

  const closeFence = () => {
    if (!openFence) return;
    flushLine();
    // The prefix holding the opening fence is cleared when content is written, so a fence with none written is abandoned rather than closed.
    if (!linePrefix) mdStr += `\n${openFence}`;
    openFence = null;
    linePrefix = '';
    lineEscape = true;
  };

  /** @type {?string} */
  let currentStyleKey = null;
  // Grouping breaks on superscript and font as well as the wrapper's bold and italic, so a mid-word style change flushes instead of joining with a space.
  /** @type {?string} */
  let currentGroupKey = null;
  /** @type {Array<string>} */
  let styledWords = [];

  const flushStyledWords = () => {
    if (styledWords.length === 0) return;
    const text = styledWords.join(' ');
    if (applyFormatting) {
      lineBuf += applyStyleWrapper(text, currentStyleKey);
    } else {
      lineBuf += text;
    }
    styledWords = [];
  };

  for (const g of pageArr) {
    if (!ocrCurrent[g] || ocrCurrent[g].lines.length === 0) continue;

    const pageObj = ocrCurrent[g];

    if (reflowText && pageObj.pars.length === 0) assignParagraphs(pageObj, pageMetrics[g].angle || 0);

    if (!isFirstContent && g > minpage) {
      mdStr += '\n\n---';
    }

    const layoutPage = layoutPageArr?.[g];
    const tableWordObj = layoutPage && layoutPage.tables && layoutPage.tables.length > 0
      ? extractTableContent(pageObj, layoutPage)
      : {};
    // The table takes only the words inside its column boxes, so a word of a consumed line that no cell holds is written on its own.
    const cellWordIds = new Set(Object.values(tableWordObj).flatMap((table) => (table?.rowWordArr || []).flat(2)).filter(Boolean).map((w) => w.id));

    /** @type {Array<{key: string, bbox: bbox}>} */
    const tableBboxes = [];
    for (let t = 0; t < (layoutPage?.tables?.length || 0); t++) {
      if (layoutPage.tables[t].boxes.length > 0) tableBboxes.push({ key: String(t), bbox: calcTableBbox(layoutPage.tables[t]) });
    }
    const tableOf = (lineObj) => tableBboxes.find((tb) => calcBoxOverlap(lineObj.bbox, tb.bbox) > 0.5) || null;
    const tablesWritten = new Set();

    // No paragraph field records list depth, so it is recovered from geometry.
    /** @type {Array<number>} */
    let depthLefts = [];
    if (reflowText) {
      const listLefts = [...new Set(pageObj.pars
        .filter((par) => par.marker && par.type !== 'blockquote' && par.type !== 'footnote' && !parMarkerInText(par))
        .map((par) => par.bbox.left))].sort((a, b) => a - b);
      depthLefts = listLefts.filter((left, i) => i === 0 || left - listLefts[i - 1] > 5);
    }

    /** @type {Array<number>} */
    const listCols = [];

    /** @type {OcrPar | null | undefined} */
    let parCurrent;
    let stripLeader = false;
    let prevJoin = false;

    for (let h = 0; h < pageObj.lines.length; h++) {
      const lineObj = pageObj.lines[h];

      const inTable = tableOf(lineObj);
      if (inTable) {
        // A table splits the paragraph it interrupts.
        parCurrent = undefined;
        prevJoin = false;
        if (!tablesWritten.has(inTable.key)) {
          tablesWritten.add(inTable.key);
          const tableResult = tableWordObj[inTable.key];
          if (tableResult) {
            closeFence();
            flushLine();
            if (!isFirstContent) mdStr += '\n\n';
            mdStr += renderMarkdownTable(tableResult, applyFormatting);
            isFirstContent = false;
          }
        }
        const orphans = lineObj.words.filter((w) => !!w && !cellWordIds.has(w.id));
        if (orphans.length > 0) {
          closeFence();
          flushLine();
          lineSep = '\n\n';
          linePrefix = '';
          lineEscape = true;
          lineBuf = orphans.map((w) => escapeMarkdown(w.text)).join(' ');
          flushLine();
        }
        continue;
      }

      if (reflowText) {
        if (dropPageHeadersFooters && parIsFurniture(lineObj.par)) continue;
        if (lineObj.par !== parCurrent || parCurrent === undefined) {
          parCurrent = lineObj.par;
          closeFence();
          flushLine();
          lineSep = '\n\n';
          lineEscape = true;
          const par = lineObj.par;
          if (par && par.debug.sourceStyle === 'HTMLPreformatted') {
            const ticks = par.lines.flatMap((parLine) => parLine.words.map((word) => word.text).join(' ').match(/`+/g) || []);
            openFence = '`'.repeat(Math.max(3, ...ticks.map((t) => t.length + 1)));
            linePrefix = `${openFence}\n`;
            lineEscape = false;
          } else if (par && par.type === 'title') {
            linePrefix = `${'#'.repeat(Math.min(Math.max(par.headingLevel || 1, 1), 6))} `;
          } else if (par && par.type === 'blockquote') {
            linePrefix = '> ';
            if (par.marker && !parMarkerInText(par)) linePrefix += `${LIST_MARKERS[par.marker] || par.marker} `;
          } else if (par && fnLabelById.has(par.id)) {
            linePrefix = `[^${fnLabelById.get(par.id)}]: `;
            stripLeader = true;
          } else if (par && par.marker) {
            if (parMarkerInText(par)) {
              // Escaping here would turn the item's own `1.` into literal text and lose the list on re-import.
              lineEscape = false;
            } else {
              let depth = 0;
              for (let d = 1; d < depthLefts.length && depthLefts[d] <= par.bbox.left + 5; d++) depth = d;
              depth = Math.min(depth, 3);
              const marker = LIST_MARKERS[par.marker] || par.marker;
              // Markdown treats an item as nested only when its marker starts at the parent's content column.
              const pad = depth === 0 ? 0 : listCols[depth - 1] ?? depth * 2;
              linePrefix = `${' '.repeat(pad)}${marker} `;
              listCols.length = depth + 1;
              listCols[depth] = pad + marker.length + 1;
            }
          }
        } else if (openFence) {
          flushLine();
          lineSep = '\n';
        }
      } else {
        flushLine();
        lineSep = '\n';
        lineEscape = true;
      }

      if (openFence) {
        for (const wordObj of lineObj.words) {
          if (!wordObj) continue;
          if (lineBuf) lineBuf += ' ';
          lineBuf = (lineBuf || '') + wordObj.text;
        }
        continue;
      }

      const next = pageObj.lines[h + 1];
      const join = evidence && next && next.par === lineObj.par && !tableOf(next) ? lineJoin(lineObj, next, evidence) : { joinNext: false, dropHyphen: false };
      const words = lineObj.words.filter((w) => !!w);
      for (let i = 0; i < words.length; i++) {
        const wordObj = words[i];
        const joined = i === 0 && prevJoin;
        if (stripLeader) {
          stripLeader = false;
          if (isNoteLeader(wordObj, lineObj.par)) continue;
        }

        const fnLabel = reflowText && applyFormatting && wordObj.footnoteParId ? fnLabelById.get(wordObj.footnoteParId) : undefined;
        if (fnLabel !== undefined) {
          flushStyledWords();
          const { head, tail } = splitNoteReference(wordObj);
          if (lineBuf === null) lineBuf = '';
          else if (head && !joined) lineBuf += ' ';
          lineBuf += `${escapeMarkdown(head)}[^${fnLabel}]${escapeMarkdown(tail)}`;
          continue;
        }

        const text = i === words.length - 1 && join.dropHyphen ? wordObj.text.replace(/[-‐­]$/, '') : wordObj.text;
        const styleSegments = applyFormatting ? getWordStyleSegments(wordObj) : null;
        const pieces = styleSegments
          ? styleSegments.map((segment) => ({ text: text.slice(segment.start, segment.end), style: segment.style }))
          : [{ text, style: wordObj.style }];

        for (let p = 0; p < pieces.length; p++) {
          const styleKey = applyFormatting ? (pieces[p].style?.bold ? 'b' : '') + (pieces[p].style?.italic ? 'i' : '') : '';
          const groupKey = applyFormatting ? `${styleKey}${pieces[p].style?.sup ? 's' : ''}|${pieces[p].style?.font || ''}` : '';
          let wordText = escapeMarkdown(pieces[p].text);
          if (applyFormatting) {
            wordText = applySuperscript(wordText, pieces[p].style);
          }

          if (groupKey !== currentGroupKey && styledWords.length > 0) {
            flushStyledWords();
          }

          if (p === 0) {
            if (lineBuf === null) {
              lineBuf = '';
            } else if (styledWords.length === 0 && !joined) {
              lineBuf += ' ';
            }
          }

          currentStyleKey = styleKey;
          currentGroupKey = groupKey;
          if (p === 0 && joined && styledWords.length > 0) styledWords[styledWords.length - 1] += wordText;
          else styledWords.push(wordText);
        }
      }

      // A line joined to the next keeps its style group open, so the continued word completes the group's last word.
      if (!join.joinNext) flushStyledWords();
      prevJoin = join.joinNext;
    }
    closeFence();
    flushLine();
    doc?.progressHandler({ n: g, type: 'export', info: { } });
  }

  return mdStr;
}
