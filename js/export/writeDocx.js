import {
  documentEnd, documentStart, docxStrings, fontTableEnd, fontTableStart, footnotesStart, footnotesEnd,
} from './resources/docxFiles.js';

import { assignParagraphs, lineEndEvidence, lineJoin } from '../utils/reflowPars.js';
import { extractTableContent } from '../extractTables.js';
import { calcTableBbox } from '../objects/layoutObjects.js';
import ocr, {
  clonePage, isNoteLeader, parIsFurniture, parMarkerInText, splitNoteReference,
} from '../objects/ocrObjects.js';
import { calcBoxOverlap, collectBytes } from '../utils/miscUtils.js';
import { writeZipChunks } from './writeZip.js';
import { cssGenericForFontObj } from '../pdf/fonts/base14Substitution.js';

const LINE_END_HYPHEN_RE = /[-‐­]$/;

/**
 * The font table entry for a run font.
 * Word substitutes from it when the font is not installed.
 *
 * @param {string} font - A word's recorded font family.
 * @param {import('../containers/fontContainer.js').DocFonts} docFonts
 * @returns {{altName: ?string, family: 'roman'|'swiss'|'modern'|'script', pitch: 'variable'|'fixed'}}
 */
export function docxFontEntry(font, docFonts) {
  // The class the document's fonts draw the word in stands in for the descriptor's serif flag, which the word does not carry.
  const generic = cssGenericForFontObj({ baseName: font, serifFlag: docFonts.getFont({ font }).type !== 'sans' });
  if (generic === 'monospace') return { altName: 'Courier New', family: 'modern', pitch: 'fixed' };
  if (generic === 'cursive') return { altName: null, family: 'script', pitch: 'variable' };
  if (generic === 'sans-serif') return { altName: 'Arial', family: 'swiss', pitch: 'variable' };
  return { altName: 'Times New Roman', family: 'roman', pitch: 'variable' };
}

/**
 * Convert an array of ocrPage objects to XML for a Word document.
 * @param {Parameters<typeof docxContentChunks>[0]} params
 * @returns {{body: string, footnotesXml: string, fontsXml: string}}
 */
export function writeDocxContent(params) {
  const chunks = docxContentChunks(params);
  let body = '';
  let next = chunks.next();
  for (; !next.done; next = chunks.next()) body += next.value;
  return { body, ...next.value };
}

/**
 * Yield Word document body XML one page at a time from an array of ocrPage objects.
 * @param {Object} params
 * @param {Array<OcrPage>} params.ocrCurrent
 * @param {?Array<import('../objects/layoutObjects.js').LayoutDataTablePage>} [params.layoutPageArr=null] - Per-page table layouts, written as Word tables when reflowText is true.
 * @param {?Array<number>} [params.pageArr=null] - 0-based page indices to include, overriding minpage and maxpage.
 * @param {number} [params.minpage=0] - First 0-based page index to include.
 * @param {number} [params.maxpage=-1] - Last 0-based page index to include, or -1 for the last page.
 * @param {boolean} [params.reflowText=false] - Remove line breaks within what appears to be the same paragraph.
 * @param {?Array<string>} [params.wordIds=null] - Subset of word IDs to include, or null for all words.
 * @param {?Array<PageMetrics>} [params.pageMetrics=null] - Required when reflowText is true.
 * @param {boolean} [params.dropPageHeadersFooters=false] - Omit page headers, footers, page numbers, and margin line numbers when reflowText is true.
 * @param {?import('../containers/scribeDoc.js').ScribeDoc} [params.doc=null] - Owning document, used for progress reporting and font-table entries.
 * @returns {Generator<string, {footnotesXml: string, fontsXml: string}>} Per-page body XML, with footnote and font-table XML as the generator return value.
 */
export function* docxContentChunks({
  ocrCurrent, layoutPageArr = null, pageArr = null, minpage = 0, maxpage = -1, reflowText = false, wordIds = null,
  pageMetrics = null, dropPageHeadersFooters = false, doc = null,
}) {
  if (!pageArr) {
    if (maxpage === -1) maxpage = ocrCurrent.length - 1;
    pageArr = [];
    for (let i = minpage; i <= maxpage; i++) pageArr.push(i);
  }

  const evidence = reflowText ? lineEndEvidence(ocrCurrent) : null;
  const included = (wordObj) => !!wordObj && (!wordIds || wordIds.includes(wordObj.id));

  /** @type {Map<string, number>} The page of each note paragraph, by its id. */
  const notePages = new Map();
  /** @type {Array<{parId: string, label: string}>} In-text note references in reading order, with target paragraph ID and marker text. */
  const refs = [];
  for (const g of pageArr) {
    const pageObj = ocrCurrent[g];
    if (!pageObj) continue;
    for (const par of pageObj.pars) {
      if (par.type === 'footnote' || par.type === 'endnote') notePages.set(par.id, g);
      else notePages.delete(par.id);
    }
    for (const lineObj of pageObj.lines) {
      for (const wordObj of lineObj.words) {
        if (included(wordObj) && wordObj.footnoteParId) refs.push({ parId: wordObj.footnoteParId, label: splitNoteReference(wordObj).label });
      }
    }
  }
  /** @type {Map<string, string>} */
  const footnoteIdByParId = new Map();
  // A note whose reference mark is not a number ("*", "†", "a") keeps that mark as a custom mark, since Word prints its own number for an auto-numbered reference.
  /** @type {Map<string, string>} */
  const footnoteMarkByParId = new Map();
  /** @type {Array<string>} */
  const footnoteParIds = [];
  for (const { parId, label } of refs) {
    if (!notePages.has(parId) || footnoteIdByParId.has(parId)) continue;
    footnoteIdByParId.set(parId, String(footnoteParIds.length + 1));
    footnoteParIds.push(parId);
    if (/\D/.test(label)) footnoteMarkByParId.set(parId, label);
  }

  /** @type {Set<string>} */
  const runFonts = new Set();
  const styleXml = (style) => {
    let s = '';
    if (style.bold) s += '<w:b/>';
    if (style.italic) s += '<w:i/>';
    if (style.smallCaps) s += '<w:smallCaps/>';
    if (style.underline) s += '<w:u w:val="single"/>';
    if (style.sup) s += '<w:vertAlign w:val="superscript"/>';
    if (style.font) {
      runFonts.add(style.font);
      s += `<w:rFonts w:ascii="${ocr.escapeXml(style.font)}" w:hAnsi="${ocr.escapeXml(style.font)}"/>`;
    }
    return s;
  };

  // A superscript run gets no leading inter-word space, so a footnote marker stays attached to the preceding word.
  // A word with style runs becomes one <w:r> per segment (e.g. an italic word's non-italic comma).
  const textRun = (wordObj, lead, text = wordObj.text) => {
    const segments = ocr.getWordStyleSegments(wordObj) || [{ start: 0, end: text.length, style: wordObj.style }];
    let runsXml = '';
    segments.forEach((segment, index) => {
      const sx = styleXml(segment.style);
      const rPr = sx ? `<w:rPr>${sx}</w:rPr>` : '';
      const leadSeg = index === 0 ? lead : '';
      runsXml += `<w:r>${rPr}<w:t xml:space="preserve">${leadSeg}${ocr.escapeXml(text.slice(segment.start, segment.end))}</w:t></w:r>`;
    });
    return runsXml;
  };

  /**
   * The runs of a paragraph's lines, joined as one paragraph.
   * @param {Array<{words: Array<?OcrWord>}>} lines
   * @param {{prefix?: string, leadSpace?: boolean, stripLeader?: boolean}} [opts] - `stripLeader` drops a footnote's own leading marker word.
   */
  const runsOf = (lines, { prefix = '', leadSpace = false, stripLeader = false } = {}) => {
    let runs = '';
    let first = true;
    let prevJoin = false;
    let strippingLeader = stripLeader;
    if (prefix) {
      const firstWord = lines.flatMap((line) => line.words).find(included);
      const sx = firstWord ? styleXml({ font: firstWord.style.font }) : '';
      runs += `<w:r>${sx ? `<w:rPr>${sx}</w:rPr>` : ''}<w:t xml:space="preserve">${ocr.escapeXml(prefix)}</w:t></w:r>`;
    }
    for (let li = 0; li < lines.length; li++) {
      const lineObj = lines[li];
      const last = lineObj.words.length - 1;
      let lastWritten = -1;
      lineObj.words.forEach((wordObj, i) => { if (included(wordObj)) lastWritten = i; });
      const join = evidence && lastWritten === last ? lineJoin(lineObj, lines[li + 1] || null, evidence) : { joinNext: false, dropHyphen: false };
      let firstInLine = true;
      for (let i = 0; i < lineObj.words.length; i++) {
        const wordObj = lineObj.words[i];
        if (!included(wordObj)) continue;
        if (strippingLeader && isNoteLeader(wordObj, lineObj.par || null)) continue;
        strippingLeader = false;

        // The marker's text is dropped for a numbered reference, since Word renders the number itself.
        // The run carries the marker's font, or Word would render the mark in the theme font beside words in the page font.
        const fnId = wordObj.footnoteParId ? footnoteIdByParId.get(wordObj.footnoteParId) : undefined;
        const mark = wordObj.footnoteParId ? footnoteMarkByParId.get(wordObj.footnoteParId) : undefined;
        if (fnId !== undefined) {
          const { head, tail } = splitNoteReference(wordObj);
          if (head) runs += textRun(wordObj, first ? (leadSpace ? ' ' : '') : (firstInLine && prevJoin ? '' : ' '), head);
          const rPr = `<w:rPr><w:rStyle w:val="FootnoteReference"/>${styleXml({ sup: true, font: wordObj.style.font })}</w:rPr>`;
          runs += mark === undefined
            ? `<w:r>${rPr}<w:footnoteReference w:id="${fnId}"/></w:r>`
            : `<w:r>${rPr}<w:footnoteReference w:customMarkFollows="1" w:id="${fnId}"/><w:t>${ocr.escapeXml(mark)}</w:t></w:r>`;
          if (tail) runs += textRun(wordObj, '', tail);
          first = false;
          firstInLine = false;
          continue;
        }

        const text = i === last && join.dropHyphen ? wordObj.text.replace(LINE_END_HYPHEN_RE, '') : wordObj.text;
        runs += textRun(wordObj, first ? (leadSpace ? ' ' : '') : (wordObj.style.sup || (firstInLine && prevJoin) ? '' : ' '), text);
        first = false;
        firstInLine = false;
      }
      prevJoin = join.joinNext;
    }
    return runs;
  };

  let footnotesXml = '';
  for (const parId of footnoteParIds) {
    const par = /** @type {OcrPar} */ (ocrCurrent[/** @type {number} */ (notePages.get(parId))].pars.findLast((p) => p.id === parId));
    const runs = runsOf(par.lines, { leadSpace: true, stripLeader: true });
    const mark = footnoteMarkByParId.get(par.id);
    const font = par.lines[0]?.words[0]?.style.font;
    const markRun = mark === undefined
      ? `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/>${styleXml({ font })}</w:rPr><w:footnoteRef/></w:r>`
      : `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/>${styleXml({ sup: true, font })}</w:rPr><w:t>${ocr.escapeXml(mark)}</w:t></w:r>`;
    footnotesXml += `<w:footnote w:id="${footnoteIdByParId.get(par.id)}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>${markRun}${runs}</w:p></w:footnote>`;
  }

  const BORDER = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join('');
  /** @param {{rowWordArr: Array<Array<Array<OcrWord>>>}} table */
  const tableXml = (table) => {
    const { rowWordArr } = table;
    if (!rowWordArr || rowWordArr.length === 0) return '';
    const numCols = Math.max(...rowWordArr.map((row) => row.length));
    let xml = `<w:tbl><w:tblPr><w:tblStyle w:val="TableNormal"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${BORDER}</w:tblBorders></w:tblPr><w:tblGrid>${'<w:gridCol/>'.repeat(numCols)}</w:tblGrid>`;
    for (const row of rowWordArr) {
      xml += '<w:tr>';
      for (let c = 0; c < numCols; c++) {
        const words = (row[c] || []).filter(included);
        let runs = '';
        words.forEach((wordObj, i) => { runs += textRun(wordObj, i === 0 ? '' : ' '); });
        xml += `<w:tc><w:p>${runs}</w:p></w:tc>`;
      }
      xml += '</w:tr>';
    }
    return `${xml}</w:tbl>`;
  };

  let body = '';
  /** @type {Array<OcrLine>} The lines of the paragraph being written. */
  let parLines = [];
  const writePar = () => {
    if (parLines.length === 0) return;
    const { par } = parLines[0];
    const pPr = par && par.type === 'title' ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'
      : par && par.type === 'blockquote' ? '<w:pPr><w:pStyle w:val="Quote"/></w:pPr>'
        : '';
    // A marker the page does not print, as a Markdown or Word import records it, is written back before its paragraph.
    const prefix = reflowText && par && par.marker && par.debug.sourceStyle !== 'HTMLPreformatted' && !parMarkerInText(par) ? `${par.marker} ` : '';
    const runs = runsOf(parLines, { prefix });
    if (runs) body += `<w:p>${pPr}${runs}</w:p>`;
    parLines = [];
  };
  for (const g of pageArr) {
    let pageObj = ocrCurrent[g];
    if (!pageObj || pageObj.lines.length === 0) continue;

    if (reflowText && pageObj.pars.length === 0) {
      pageObj = clonePage(pageObj);
      assignParagraphs(pageObj, pageMetrics[g].angle || 0);
    }

    const layoutPage = reflowText ? layoutPageArr?.[g] : null;
    const tableWordObj = layoutPage && layoutPage.tables.length > 0 ? extractTableContent(pageObj, layoutPage) : {};
    // The table takes only the words inside its column boxes, so a word of a consumed line that no cell holds is written on its own.
    const cellWordIds = new Set(Object.values(tableWordObj).flatMap((table) => (table?.rowWordArr || []).flat(2)).filter(Boolean).map((w) => w.id));
    /** @type {Array<{key: string, bbox: bbox}>} */
    const tableBboxes = [];
    for (let t = 0; t < (layoutPage?.tables.length || 0); t++) {
      if (layoutPage.tables[t].boxes.length > 0) tableBboxes.push({ key: String(t), bbox: calcTableBbox(layoutPage.tables[t]) });
    }
    const tablesWritten = new Set();

    for (const lineObj of pageObj.lines) {
      const inTable = tableBboxes.find((tb) => calcBoxOverlap(lineObj.bbox, tb.bbox) > 0.5);
      if (inTable) {
        writePar();
        if (!tablesWritten.has(inTable.key)) {
          tablesWritten.add(inTable.key);
          const table = tableWordObj[inTable.key];
          if (table) body += tableXml(table);
        }
        const orphans = lineObj.words.filter((w) => included(w) && !cellWordIds.has(w.id));
        if (orphans.length > 0) body += `<w:p>${runsOf([{ words: orphans }])}</w:p>`;
        continue;
      }
      const { par } = lineObj;
      if (reflowText && dropPageHeadersFooters && parIsFurniture(par)) continue;
      // Lines belonging to an exported footnote live in word/footnotes.xml, not the body.
      if (par && footnoteIdByParId.has(par.id)) continue;
      // In reflow mode a paragraph's lines share one <w:p>, except a code block's, which keep their line breaks; otherwise each line is its own paragraph.
      if (!reflowText || (parLines.length > 0 && par !== parLines[0].par) || (par && par.debug.sourceStyle === 'HTMLPreformatted')) writePar();
      parLines.push(lineObj);
    }
    writePar();
    doc?.progressHandler({ n: g, type: 'export', info: { } });
    yield body;
    body = '';
  }

  let fontsXml = '';
  if (doc?.fonts) {
    const listed = new Set([...fontTableStart.matchAll(/w:name="([^"]*)"/g)].map((m) => m[1]));
    for (const font of runFonts) {
      if (listed.has(font)) continue;
      const { altName, family, pitch } = docxFontEntry(font, doc.fonts);
      fontsXml += `<w:font w:name="${ocr.escapeXml(font)}">${altName ? `<w:altName w:val="${altName}"/>` : ''}<w:family w:val="${family}"/><w:pitch w:val="${pitch}"/></w:font>`;
    }
  }

  return { footnotesXml, fontsXml };
}

/**
 * Create a Word document from an array of ocrPage objects.
 * @param {Parameters<typeof writeDocxChunks>[0]} params
 * @returns {Promise<Uint8Array>}
 */
export function writeDocx(params) {
  return collectBytes(writeDocxChunks(params));
}

/**
 * Create a Word document from an array of ocrPage objects, yielding byte chunks.
 * @param {Object} params
 * @param {Array<OcrPage>} params.hocrCurrent
 * @param {?Array<import('../objects/layoutObjects.js').LayoutDataTablePage>} [params.layoutPageArr=null] - Used when `reflowText` is enabled to write detected tables as Word tables.
 * @param {?Array<number>} [params.pageArr=null] - 0-based page indices to include, overriding `minpage` and `maxpage`.
 * @param {number} [params.minpage=0]
 * @param {number} [params.maxpage=-1]
 * @param {?Array<PageMetrics>} [params.pageMetrics=null] - Required when `reflowText` is enabled.
 * @param {boolean} [params.reflowText=false] - Remove line breaks within what appears to be the same paragraph.
 * @param {boolean} [params.dropPageHeadersFooters=false] - Omit page headers, footers, page numbers, and margin line numbers when `reflowText` is enabled.
 * @param {?import('../containers/scribeDoc.js').ScribeDoc} [params.doc=null] - Owning document for progress reporting and font-table entries.
 * @returns {AsyncGenerator<Uint8Array>}
 */
export function writeDocxChunks({
  hocrCurrent, layoutPageArr = null, pageArr = null, minpage = 0, maxpage = -1, pageMetrics = null, reflowText = false, dropPageHeadersFooters = false, doc = null,
}) {
  if (!pageArr) {
    if (maxpage === -1) maxpage = hocrCurrent.length - 1;
    pageArr = [];
    for (let i = minpage; i <= maxpage; i++) pageArr.push(i);
  }

  const chunks = docxContentChunks({
    ocrCurrent: hocrCurrent,
    layoutPageArr,
    pageArr,
    reflowText,
    dropPageHeadersFooters,
    pageMetrics,
    doc,
  });
  // The zip writer reads one entry at a time, so the notes and fonts the body's writer returns are known when their entries are asked for.
  return writeZipChunks((function* docxEntries() {
    /** @type {{footnotesXml: string, fontsXml: string}|undefined} */
    let notesAndFonts;
    yield {
      path: 'word/document.xml',
      text: (function* documentXml() {
        yield documentStart;
        notesAndFonts = yield* chunks;
        yield documentEnd;
      }()),
    };
    const { footnotesXml, fontsXml } = /** @type {{footnotesXml: string, fontsXml: string}} */ (notesAndFonts);
    yield { path: 'word/footnotes.xml', text: footnotesStart + footnotesXml + footnotesEnd };
    yield { path: 'word/fontTable.xml', text: fontTableStart + fontsXml + fontTableEnd };
    for (const file of docxStrings) yield { path: file.path, text: file.content };
  }()));
}
