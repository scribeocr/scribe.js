import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

import { mergePdfs } from '../../js/export/pdf/mergePdfs.js';
import {
  findXrefOffset, parseXref, getPageObjects,
} from '../../js/pdf/parsePdfUtils.js';
import { ObjectCache } from '../../js/pdf/objectCache.js';

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

/**
 * Count pages in a PDF without loading mupdf.
 * @param {ArrayBuffer|Uint8Array} buf
 */
function countPdfPages(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const xrefOffset = findXrefOffset(bytes);
  const xrefEntries = parseXref(bytes, xrefOffset);
  const objCache = new ObjectCache(bytes, xrefEntries);
  return getPageObjects(objCache).length;
}

describe('Check PDF merge preserves page count.', () => {
  test('Merged PDF contains the sum of source page counts', async () => {
    const docCount = 5;
    const pdfBuffers = [];

    for (let d = 0; d < docCount; d++) {
      scribe.ScribeDoc.defaults.usePDFText.ocr.main = true;
      const doc = await scribe.openDocument([`${ASSETS_PATH}/scribe_test_pdf1.pdf`]);

      scribe.ScribeDoc.defaults.displayMode = 'proof';
      pdfBuffers.push(await doc.exportData('pdf'));
      await doc.terminate();
    }

    const sourcePages = pdfBuffers.map((b) => countPdfPages(b));
    const expectedPages = sourcePages.reduce((a, b) => a + b, 0);

    const mergedData = await mergePdfs(pdfBuffers.map((b) => (b instanceof Uint8Array ? b : new Uint8Array(b))));
    const totalPages = countPdfPages(mergedData);

    expect(totalPages).toBe(expectedPages);

    scribe.ScribeDoc.defaults.usePDFText.ocr.main = false;
  });

  test('Merged PDF preserves highlight annotations from each source', async () => {
    scribe.ScribeDoc.defaults.usePDFText.ocr.main = true;
    const docA = await scribe.openDocument([`${ASSETS_PATH}/scribe_test_pdf1.pdf`]);
    docA.addHighlights([{ page: 0, startLine: 0, endLine: 1 }]);
    const pdfA = await docA.exportData('pdf');
    await docA.terminate();

    const docB = await scribe.openDocument([`${ASSETS_PATH}/scribe_test_pdf1.pdf`]);
    docB.addHighlights([{ page: 0, startLine: 2, endLine: 2 }]);
    const pdfB = await docB.exportData('pdf');
    await docB.terminate();

    const pagesA = countPdfPages(pdfA);
    const pagesB = countPdfPages(pdfB);

    const mergedData = await mergePdfs([new Uint8Array(pdfA), new Uint8Array(pdfB)]);
    expect(countPdfPages(mergedData)).toBe(pagesA + pagesB);

    const docMerged = await scribe.openDocument({ pdfFiles: [new Uint8Array(mergedData).buffer] });
    const highlightsFirstSource = docMerged.annotations.pages[0] || [];
    const highlightsSecondSource = docMerged.annotations.pages[pagesA] || [];
    expect(highlightsFirstSource.length).toBe(1);
    expect(highlightsSecondSource.length).toBe(1);

    scribe.ScribeDoc.defaults.usePDFText.ocr.main = false;
    await docMerged.terminate();
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
