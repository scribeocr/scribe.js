import {
  documentEnd, documentStart, docxStrings, footnotesStart, footnotesEnd,
} from './resources/docxFiles.js';

import { assignParagraphs } from '../utils/reflowPars.js';

import ocr from '../objects/ocrObjects.js';

/**
 * Convert an array of ocrPage objects to XML for a Word document.
 *
 * @param {Object} params
 * @param {Array<OcrPage>} params.ocrCurrent -
 * @param {?Array<number>} [params.pageArr=null] - Array of 0-based page indices to include. Overrides minpage/maxpage when provided.
 * @param {number} [params.minpage=0] - The first page to include in the document.
 * @param {number} [params.maxpage=-1] - The last page to include in the document.
 * @param {boolean} [params.reflowText=false] - Remove line breaks within what appears to be the same paragraph.
 * @param {?Array<string>} [params.wordIds=null] - An array of word IDs to include in the document.
 *    If omitted, all words are included.
 * @param {?Array<PageMetrics>} [params.pageMetrics=null] - Page metrics for the document being
 *    exported. Required when reflow or preserveSpacing is enabled.
 * @param {?import('../containers/scribeDoc.js').ScribeDoc} [params.doc=null] - Owning document for progress reporting.
 */
export function writeDocxContent({
  ocrCurrent, pageArr = null, minpage = 0, maxpage = -1, reflowText = false, wordIds = null,
  pageMetrics = null, doc = null,
}) {
  if (!pageArr) {
    if (maxpage === -1) maxpage = ocrCurrent.length - 1;
    pageArr = [];
    for (let i = minpage; i <= maxpage; i++) pageArr.push(i);
  }

  // Pre-pass: assign each linked note paragraph (footnote or endnote) a Word footnote id in in-text reference order, which is how Word numbers footnotes.
  // Unlinked note paragraphs fall through as ordinary body paragraphs, so no content is dropped.
  const parById = new Map();
  for (const g of pageArr) {
    const pageObj = ocrCurrent[g];
    if (pageObj) for (const par of pageObj.pars) parById.set(par.id, par);
  }
  /** @type {Map<string, string>} */
  const footnoteIdByParId = new Map();
  const footnoteParsOrdered = [];
  for (const g of pageArr) {
    const pageObj = ocrCurrent[g];
    if (!pageObj) continue;
    for (const lineObj of pageObj.lines) {
      for (const wordObj of lineObj.words) {
        if (!wordObj || !wordObj.footnoteParId) continue;
        if (wordIds && !wordIds.includes(wordObj.id)) continue;
        const fnPar = parById.get(wordObj.footnoteParId);
        if (!fnPar || (fnPar.type !== 'footnote' && fnPar.type !== 'endnote') || footnoteIdByParId.has(fnPar.id)) continue;
        footnoteIdByParId.set(fnPar.id, String(footnoteParsOrdered.length + 1));
        footnoteParsOrdered.push(fnPar);
      }
    }
  }

  const styleXml = (style) => {
    let s = '';
    if (style.bold) s += '<w:b/>';
    if (style.italic) s += '<w:i/>';
    if (style.smallCaps) s += '<w:smallCaps/>';
    if (style.underline) s += '<w:u w:val="single"/>';
    if (style.sup) s += '<w:vertAlign w:val="superscript"/>';
    if (style.font) s += `<w:rFonts w:ascii="${ocr.escapeXml(style.font)}" w:hAnsi="${ocr.escapeXml(style.font)}"/>`;
    return s;
  };

  // A superscript run gets no leading inter-word space, so a footnote marker stays attached to the preceding word.
  // A word with style runs becomes one <w:r> per segment (e.g. an italic word's non-italic comma).
  const textRun = (wordObj, lead) => {
    const segments = ocr.getWordStyleSegments(wordObj) || [{ start: 0, end: wordObj.text.length, style: wordObj.style }];
    let runsXml = '';
    segments.forEach((segment, index) => {
      const sx = styleXml(segment.style);
      const rPr = sx ? `<w:rPr>${sx}</w:rPr>` : '';
      const leadSeg = index === 0 ? lead : '';
      runsXml += `<w:r>${rPr}<w:t xml:space="preserve">${leadSeg}${ocr.escapeXml(wordObj.text.slice(segment.start, segment.end))}</w:t></w:r>`;
    });
    return runsXml;
  };

  const fnMarkerRe = /^[\d*†‡]{1,3}[.)\]]?$/;
  let footnotesXml = '';
  for (const par of footnoteParsOrdered) {
    let runs = '';
    let firstWord = true;
    let strippingLeader = true;
    for (const lineObj of par.lines) {
      for (const wordObj of lineObj.words) {
        if (!wordObj) continue;
        if (wordIds && !wordIds.includes(wordObj.id)) continue;
        // Drop the footnote's own leading marker (a superscript number/symbol): Word renders the number from <w:footnoteRef/>, so keeping the literal would double it.
        // Only PDF-sourced footnotes carry this marker word; the .docx importer strips it at import.
        if (strippingLeader && wordObj.style.sup && fnMarkerRe.test((wordObj.text || '').trim())) continue;
        strippingLeader = false;
        runs += textRun(wordObj, firstWord ? ' ' : (wordObj.style.sup ? '' : ' '));
        firstWord = false;
      }
    }
    footnotesXml += `<w:footnote w:id="${footnoteIdByParId.get(par.id)}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>${runs}</w:p></w:footnote>`;
  }

  let body = '';
  let openKey = null;
  let firstWordInPar = true;

  for (const g of pageArr) {
    const pageObj = ocrCurrent[g];
    if (!pageObj || pageObj.lines.length === 0) continue;

    // Native-text PDFs already carry analyzeLayout paragraphs from import; re-running the per-page detector here would discard them.
    // reflowPars still serves OCR/.hocr input.
    const nativePdf = doc?.inputData?.pdfType === 'text';
    if (reflowText && !nativePdf && (!pageObj.textSource || !['textract', 'abbyy', 'google_vision', 'azure_doc_intel', 'docx'].includes(pageObj.textSource))) {
      const angle = pageMetrics[g].angle || 0;
      assignParagraphs(pageObj, angle);
    }

    for (let h = 0; h < pageObj.lines.length; h++) {
      const lineObj = pageObj.lines[h];
      const linePar = lineObj.par;

      // Lines belonging to an exported footnote live in word/footnotes.xml, not the body.
      if (linePar && footnoteIdByParId.has(linePar.id)) continue;

      // In reflow mode lines of the same paragraph share one <w:p>; otherwise each line is its own paragraph.
      const key = reflowText ? linePar : lineObj;

      for (let i = 0; i < lineObj.words.length; i++) {
        const wordObj = lineObj.words[i];
        if (!wordObj) continue;
        if (wordIds && !wordIds.includes(wordObj.id)) continue;

        // Open the paragraph lazily on the first emitted word so filtered/empty lines never leave an empty <w:p>.
        if (key !== openKey) {
          if (openKey !== null) body += '</w:p>';
          const pPr = linePar && linePar.type === 'title' ? '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'
            : linePar && linePar.type === 'blockquote' ? '<w:pPr><w:pStyle w:val="Quote"/></w:pPr>'
              : '';
          body += `<w:p>${pPr}`;
          openKey = key;
          firstWordInPar = true;
        }

        // A footnote reference marker becomes a real Word footnote reference.
        // The literal marker text is dropped since Word renders the number itself.
        const fnId = wordObj.footnoteParId ? footnoteIdByParId.get(wordObj.footnoteParId) : undefined;
        if (fnId !== undefined) {
          body += `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="${fnId}"/></w:r>`;
          firstWordInPar = false;
          continue;
        }

        body += textRun(wordObj, firstWordInPar ? '' : (wordObj.style.sup ? '' : ' '));
        firstWordInPar = false;
      }
    }
    doc?.progressHandler({ n: g, type: 'export', info: { } });
  }
  if (openKey !== null) body += '</w:p>';

  return { body, footnotesXml };
}

/**
 * Create a Word document from an array of ocrPage objects.
 *
 * @param {Object} params
 * @param {Array<OcrPage>} params.hocrCurrent -
 * @param {?Array<number>} [params.pageArr=null] - Array of 0-based page indices to include. Overrides minpage/maxpage when provided.
 * @param {number} [params.minpage=0] - The first page to include in the document.
 * @param {number} [params.maxpage=-1] - The last page to include in the document.
 * @param {?Array<PageMetrics>} [params.pageMetrics=null] - Page metrics for the document being
 *    exported. Required when reflow or preserveSpacing is enabled.
 * @param {boolean} [params.reflowText=false] - Remove line breaks within what appears to be the same paragraph.
 * @param {?import('../containers/scribeDoc.js').ScribeDoc} [params.doc=null] - Owning document for progress reporting.
 */
export async function writeDocx({
  hocrCurrent, pageArr = null, minpage = 0, maxpage = -1, pageMetrics = null, reflowText = false, doc = null,
}) {
  const { Uint8ArrayWriter, TextReader, ZipWriter } = await import('../../lib/zip.js/index.js');

  if (!pageArr) {
    if (maxpage === -1) maxpage = hocrCurrent.length - 1;
    pageArr = [];
    for (let i = minpage; i <= maxpage; i++) pageArr.push(i);
  }

  const zipFileWriter = new Uint8ArrayWriter();
  const zipWriter = new ZipWriter(zipFileWriter);

  const { body, footnotesXml } = writeDocxContent({
    ocrCurrent: hocrCurrent,
    pageArr,
    reflowText,
    pageMetrics,
    doc,
  });

  await zipWriter.add('word/document.xml', new TextReader(documentStart + body + documentEnd));
  await zipWriter.add('word/footnotes.xml', new TextReader(footnotesStart + footnotesXml + footnotesEnd));

  for (let i = 0; i < docxStrings.length; i++) {
    const textReaderI = new TextReader(docxStrings[i].content);
    await zipWriter.add(docxStrings[i].path, textReaderI);
  }

  await zipWriter.close();

  const zipFileData = await zipFileWriter.getData();

  return zipFileData;
}
