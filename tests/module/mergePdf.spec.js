/* eslint-disable import/no-relative-packages */
import { assert, config } from '../../node_modules/chai/chai.js';
import scribe from '../../scribe.js';
import { mergePdfs } from '../../js/export/pdf/mergePdfs.js';
import { findXrefOffset, parseXref, ObjectCache } from '../../js/pdf/parsePdfUtils.js';
import { getPageObjects } from '../../js/pdf/parsePdfDoc.js';
import { ASSETS_PATH_KARMA } from '../constants.js';

scribe.opt.workerN = 1;

config.truncateThreshold = 0;

/* eslint-disable prefer-arrow-callback */
/* eslint-disable func-names */

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

describe('Check PDF merge preserves page count.', function () {
  this.timeout(120000);

  it('Merged PDF contains the sum of source page counts', async () => {
    const docCount = 5;
    const pdfBuffers = [];

    for (let d = 0; d < docCount; d++) {
      scribe.opt.usePDFText.ocr.main = true;
      await scribe.importFiles([`${ASSETS_PATH_KARMA}/scribe_test_pdf1.pdf`]);

      scribe.opt.displayMode = 'proof';
      pdfBuffers.push(await scribe.exportData('pdf'));
      await scribe.clear();
    }

    const sourcePages = pdfBuffers.map((b) => countPdfPages(b));
    const expectedPages = sourcePages.reduce((a, b) => a + b, 0);

    const mergedData = await mergePdfs(pdfBuffers.map((b) => (b instanceof Uint8Array ? b : new Uint8Array(b))));
    const totalPages = countPdfPages(mergedData);

    assert.strictEqual(totalPages, expectedPages, `Merged PDF should have ${expectedPages} pages`);

    scribe.opt.usePDFText.ocr.main = false;
  }).timeout(120000);

  it('Merged PDF preserves highlight annotations from each source', async () => {
    scribe.opt.usePDFText.ocr.main = true;
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/scribe_test_pdf1.pdf`]);
    scribe.addHighlights([{ page: 0, startLine: 0, endLine: 1 }]);
    const pdfA = await scribe.exportData('pdf');
    await scribe.clear();

    await scribe.importFiles([`${ASSETS_PATH_KARMA}/scribe_test_pdf1.pdf`]);
    scribe.addHighlights([{ page: 0, startLine: 2, endLine: 2 }]);
    const pdfB = await scribe.exportData('pdf');
    await scribe.clear();

    const pagesA = countPdfPages(pdfA);
    const pagesB = countPdfPages(pdfB);

    const mergedData = await mergePdfs([new Uint8Array(pdfA), new Uint8Array(pdfB)]);
    assert.strictEqual(countPdfPages(mergedData), pagesA + pagesB);

    await scribe.importFiles({ pdfFiles: [new Uint8Array(mergedData).buffer] });
    const highlightsFirstSource = scribe.data.annotations.pages[0] || [];
    const highlightsSecondSource = scribe.data.annotations.pages[pagesA] || [];
    assert.strictEqual(highlightsFirstSource.length, 1, 'first source page 0 retains one consolidated highlight after merge');
    assert.strictEqual(highlightsSecondSource.length, 1, 'second source page 0 retains one consolidated highlight after merge');

    scribe.opt.usePDFText.ocr.main = false;
    await scribe.clear();
  }).timeout(120000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);
