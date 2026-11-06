import { assignParagraphs, hyphenatedCompounds, lineJoin } from '../utils/reflowPars.js';
import { extractTableContent } from '../extractTables.js';
import { calcTableBbox } from '../objects/layoutObjects.js';
import { parIsFurniture, parMarkerInText } from '../objects/ocrObjects.js';
import { calcBoxOverlap } from '../utils/miscUtils.js';

const LINE_END_HYPHEN_RE = /[-‐­]$/;

/**
 * Convert an array of ocrPage objects to plain text.
 *
 * @param {Object} params
 * @param {Array<OcrPage>} params.ocrCurrent -
 * @param {?Array<import('../objects/layoutObjects.js').LayoutDataTablePage>} [params.layoutPageArr] - Table layout data per page. A reflowed export writes each table as tab-separated rows.
 * @param {?Array<number>} [params.pageArr=null] - Array of 0-based page indices to include. Overrides minpage/maxpage when provided.
 * @param {number} [params.minpage=0] - The first page to include in the document.
 * @param {number} [params.maxpage=-1] - The last page to include in the document.
 * @param {boolean} [params.reflowText=false] - Remove line breaks within what appears to be the same paragraph.
 * @param {boolean} [params.dropPageHeadersFooters=false] - Leave page headers and footers, with page numbers and margin line numbers, out when reflowing.
 * @param {?Array<string>} [params.wordIds=null] - An array of word IDs to include in the document.
 * @param {?Array<PageMetrics>} [params.pageMetrics=null] - Page metrics for the document being exported.
 *   Required when reflow or preserveSpacing is enabled. If omitted, all words are included.
 * @param {boolean} [params.lineNumbers=false] - Prepend `page:line` numbers to each line (e.g. `0:5  text`).
 *    When enabled, reflowText is ignored.
 * @param {boolean} [params.preserveSpacing=false] - Pad words with spaces based on their horizontal
 *    position in the document, preserving column alignment. Useful for table extraction.
 * @param {?import('../containers/scribeDoc.js').ScribeDoc} [params.doc=null] - Owning document.
 *    Required when `params.doc.progressHandler` should receive per-page export events.
 */
export function writeText({
  ocrCurrent, layoutPageArr = null, pageArr = null, minpage = 0, maxpage = -1, reflowText = false, dropPageHeadersFooters = false,
  wordIds = null, lineNumbers = false, preserveSpacing = false, pageMetrics = null, doc = null,
}) {
  let textStr = '';

  if (!pageArr) {
    if (maxpage === -1) maxpage = ocrCurrent.length - 1;
    pageArr = [];
    for (let i = minpage; i <= maxpage; i++) pageArr.push(i);
  }

  // lineNumbers mode is incompatible with reflowText
  const doReflow = reflowText && !lineNumbers && !preserveSpacing;

  // Character width of the full page when preserveSpacing is on.
  const lineWidth = 120;

  const compounds = doReflow ? hyphenatedCompounds(ocrCurrent) : null;
  const included = (wordObj) => !!wordObj && (!wordIds || wordIds.includes(wordObj.id));

  let newLine = false;
  let prevJoin = false;

  for (const g of pageArr) {
    if (!ocrCurrent[g] || ocrCurrent[g].lines.length === 0) continue;

    const pageObj = ocrCurrent[g];
    const pageWidth = preserveSpacing && pageMetrics[g] ? pageMetrics[g].dims.width : 0;

    if (doReflow && pageObj.pars.length === 0) assignParagraphs(pageObj, pageMetrics[g].angle || 0);

    const layoutPage = doReflow ? layoutPageArr?.[g] : null;
    const tableWordObj = layoutPage && layoutPage.tables.length > 0 ? extractTableContent(pageObj, layoutPage) : {};
    // The table takes only the words inside its column boxes, so a word of a consumed line that no cell holds is written on its own.
    const cellWordIds = new Set(Object.values(tableWordObj).flatMap((table) => (table?.rowWordArr || []).flat(2)).filter(Boolean).map((w) => w.id));
    /** @type {Array<{key: string, bbox: bbox}>} */
    const tableBboxes = [];
    for (let t = 0; t < (layoutPage?.tables.length || 0); t++) {
      if (layoutPage.tables[t].boxes.length > 0) tableBboxes.push({ key: String(t), bbox: calcTableBbox(layoutPage.tables[t]) });
    }
    const tableOf = (lineObj) => tableBboxes.find((tb) => calcBoxOverlap(lineObj.bbox, tb.bbox) > 0.5) || null;
    const tablesWritten = new Set();

    let parCurrent = pageObj.lines[0].par;
    let afterTable = false;
    let prefix = '';

    for (let h = 0; h < pageObj.lines.length; h++) {
      const lineObj = pageObj.lines[h];

      const inTable = tableOf(lineObj);
      if (inTable) {
        if (!tablesWritten.has(inTable.key)) {
          tablesWritten.add(inTable.key);
          for (const row of tableWordObj[inTable.key]?.rowWordArr || []) {
            const cells = row.map((words) => (words || []).filter(included).map((w) => w.text).join(' '));
            if (cells.some((c) => c)) textStr += `\n${cells.join('\t')}`;
          }
        }
        const orphans = lineObj.words.filter((w) => included(w) && !cellWordIds.has(w.id));
        if (orphans.length > 0) textStr += `\n${orphans.map((w) => w.text).join(' ')}`;
        afterTable = true;
        prevJoin = false;
        continue;
      }

      const { par } = lineObj;
      if (doReflow) {
        if (dropPageHeadersFooters && parIsFurniture(par)) continue;
        const parStart = h === 0 || par !== parCurrent;
        // A paragraph's lines join into one, except a code block's, and a table splits the paragraph it interrupts.
        if (parStart || afterTable || (par && par.debug.sourceStyle === 'HTMLPreformatted')) newLine = true;
        // A marker the page does not print, as a Markdown or Word import records it, is written back before its item.
        if (parStart && par && par.marker && par.type !== 'title' && par.debug.sourceStyle !== 'HTMLPreformatted' && !parMarkerInText(par)) prefix = `${par.marker} `;
        parCurrent = par;
        afterTable = false;
      } else {
        newLine = true;
      }

      const last = lineObj.words.length - 1;
      let lastWritten = -1;
      lineObj.words.forEach((wordObj, i) => { if (included(wordObj)) lastWritten = i; });
      const next = pageObj.lines[h + 1];
      const join = compounds && lastWritten === last && next && next.par === par && !tableOf(next)
        ? lineJoin(lineObj, next, compounds)
        : { joinNext: false, dropHyphen: false };

      const prefixLen = lineNumbers ? `${g}:${h}  `.length : 0;
      let currentPos = 0;
      let firstInLine = true;

      for (let i = 0; i < lineObj.words.length; i++) {
        const wordObj = lineObj.words[i];
        if (!included(wordObj)) continue;

        if (newLine) {
          // A reflowed export that begins on the first page starts with its text, as the line-for-line export never did.
          if (!(doReflow && g === 0 && h === 0)) textStr += '\n';
          if (lineNumbers) textStr += `${g}:${h}  `;
          currentPos = prefixLen;
          if (prefix) {
            textStr += prefix;
            currentPos += prefix.length;
            prefix = '';
          }
        } else if (preserveSpacing && pageWidth > 0) {
          const targetPos = prefixLen + Math.round(wordObj.bbox.left / pageWidth * lineWidth);
          const padding = Math.max(1, targetPos - currentPos);
          textStr += ' '.repeat(padding);
          currentPos = targetPos + wordObj.text.length;
        } else if (!(firstInLine && prevJoin)) {
          textStr += ' ';
        }

        if (newLine && preserveSpacing && pageWidth > 0) {
          const targetPos = prefixLen + Math.round(wordObj.bbox.left / pageWidth * lineWidth);
          const padding = Math.max(0, targetPos - currentPos);
          textStr += ' '.repeat(padding);
          currentPos = targetPos + wordObj.text.length;
        }

        newLine = false;
        firstInLine = false;

        textStr += i === last && join.dropHyphen ? wordObj.text.replace(LINE_END_HYPHEN_RE, '') : wordObj.text;
      }
      prevJoin = join.joinNext;
    }
    doc?.progressHandler({ n: g, type: 'export', info: { } });
  }

  return textStr;
}
