// Relative imports are required to run in browser.
/* eslint-disable import/no-relative-packages */
import { assert, config } from '../../node_modules/chai/chai.js';
import scribe from '../../scribe.js';
import { ASSETS_PATH_KARMA } from '../constants.js';

config.truncateThreshold = 0; // Disable truncation for actual/expected values on assertion failure.

// Using arrow functions breaks references to `this`.
/* eslint-disable prefer-arrow-callback */
/* eslint-disable func-names */

describe('Check export for .pdf files.', function () {
  this.timeout(10000);

  it('Export -> import of simple text-only ebook-style PDF retains text content', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/text_simple.txt`]);

    const exportedPdf = await scribe.exportData('pdf');
    const exportedText = await scribe.exportData('text');

    scribe.opt.displayMode = 'ebook';

    await scribe.clear();
    scribe.opt.usePDFText.native.main = true;
    scribe.opt.keepPDFTextAlways = true;

    await scribe.importFiles({ pdfFiles: [exportedPdf] });

    scribe.data.ocr.active = scribe.data.ocr.pdf;
    const reExportedText = await scribe.exportData('text');

    assert.strictEqual(reExportedText, exportedText);
    assert.strictEqual(reExportedText, 'Tesseract.js');
    await scribe.clear();
  }).timeout(10000);

  it('Export -> import of image + text (visible, proofreading) PDF retains text content', async () => {
    scribe.opt.displayMode = 'proof';

    await scribe.importFiles([`${ASSETS_PATH_KARMA}/testocr.png`, `${ASSETS_PATH_KARMA}/testocr.abbyy.xml`]);

    const exportedPdf = await scribe.exportData('pdf');
    const exportedText = await scribe.exportData('text');

    await scribe.clear();
    scribe.opt.usePDFText.native.main = true;

    await scribe.importFiles({ pdfFiles: [exportedPdf] });

    scribe.data.ocr.active = scribe.data.ocr.pdf;
    const reExportedText = await scribe.exportData('text');

    assert.strictEqual(reExportedText, exportedText);
    assert.include(reExportedText, 'This is a lot of 12 point text');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);
