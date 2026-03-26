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

    const exportedText = await scribe.exportData('text');

    // Inject an empty-text word to verify empty words do not cause errors during PDF export.
    // See: https://github.com/scribeocr/scribeocr/issues/91
    const line0 = scribe.data.ocr.active[0].lines[0];
    line0.words.push(new scribe.utils.ocr.OcrWord(line0, 'empty_word_test', '', {
      left: 100, top: 100, right: 100, bottom: 120,
    }));

    const exportedPdf = await scribe.exportData('pdf');

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

    // Inject an empty-text word to verify empty words do not cause errors during HTML export.
    // See: https://github.com/scribeocr/scribeocr/issues/91
    const line0html = scribe.data.ocr.active[0].lines[0];
    line0html.words.push(new scribe.utils.ocr.OcrWord(line0html, 'empty_word_html_test', '', {
      left: 100, top: 100, right: 100, bottom: 120,
    }));

    const exportedHtml = await scribe.exportData('html');
    assert.include(exportedHtml, '>point<');

    await scribe.clear();
    scribe.opt.usePDFText.native.main = true;

    await scribe.importFiles({ pdfFiles: [exportedPdf] });

    scribe.data.ocr.active = scribe.data.ocr.pdf;
    const reExportedText = await scribe.exportData('text');

    assert.strictEqual(reExportedText, exportedText);
    assert.include(reExportedText, 'This is a lot of 12 point text');
  }).timeout(10000);

  it('Export of PDF with existing invisible text layer should not create duplicate text', async () => {
    scribe.opt.usePDFText.ocr.main = true;
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/scribe_test_pdf1.pdf`]);

    assert.strictEqual(scribe.inputData.pdfType, 'ocr');
    assert.isTrue(scribe.data.ocr.active[0]?.lines?.length > 0);

    const originalLineCount = scribe.data.ocr.active[0].lines.length;
    const originalText = await scribe.exportData('text');

    scribe.opt.displayMode = 'invis';
    const exportedPdf = await scribe.exportData('pdf');

    await scribe.clear();
    scribe.opt.usePDFText.ocr.main = true;
    await scribe.importFiles({ pdfFiles: [exportedPdf] });

    assert.strictEqual(scribe.inputData.pdfType, 'ocr');
    assert.isTrue(scribe.data.ocr.active[0]?.lines?.length > 0);

    const reImportedLineCount = scribe.data.ocr.active[0].lines.length;
    const reImportedText = await scribe.exportData('text');

    assert.isBelow(reImportedLineCount, originalLineCount * 1.5,
      `Line count after re-export (${reImportedLineCount}) should not be much larger than original (${originalLineCount}). `
      + 'A significantly higher count indicates duplicate text layers.');

    assert.isBelow(reImportedText.length, originalText.length * 1.5,
      `Text length after re-export (${reImportedText.length}) should not be much larger than original (${originalText.length}). `
      + 'A significantly longer text indicates duplicate text layers.');

    scribe.opt.displayMode = 'proof';
    scribe.opt.usePDFText.ocr.main = false;
    await scribe.clear();
  }).timeout(30000);

  it('Export of text-native PDF preserves visible text when adding overlay', async () => {
    scribe.opt.usePDFText.native.main = true;
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/small_caps_examples.pdf`]);

    assert.strictEqual(scribe.inputData.pdfType, 'text');

    // Delete the active OCR data before export so no invisible text overlay is added.
    // Without this, the native text extracted on import would be written back as an
    // invisible overlay, creating the same duplication issue tested above.
    scribe.data.ocr.active.length = 0;

    scribe.opt.displayMode = 'invis';
    const exportedPdf = await scribe.exportData('pdf');

    await scribe.clear();
    scribe.opt.usePDFText.native.main = true;
    await scribe.importFiles({ pdfFiles: [exportedPdf] });

    assert.strictEqual(scribe.inputData.pdfType, 'text');

    const text = scribe.data.ocr.active[0].lines[3].words.map((x) => x.text).join(' ');
    assert.strictEqual(text, 'Shubhdeep Deb');

    scribe.opt.displayMode = 'proof';
    await scribe.clear();
  }).timeout(30000);

  it('Annotations container is initialized for each page on import', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/testocr.png`, `${ASSETS_PATH_KARMA}/testocr.abbyy.xml`]);

    assert.isArray(scribe.data.annotations.pages[0]);
    assert.strictEqual(scribe.data.annotations.pages[0].length, 0);
  }).timeout(10000);

  it('Highlight annotations are preserved through .scribe export and import', async () => {
    scribe.data.annotations.pages[0].push({
      bbox: {
        left: 100, top: 200, right: 300, bottom: 220,
      },
      color: '#ffff00',
      opacity: 0.35,
      groupId: 'test-export-1',
    });

    scribe.opt.compressScribe = false;
    const scribeData = await scribe.exportData('scribe');

    await scribe.clear();

    const encoder = new TextEncoder();
    await scribe.importFiles({ scribeFiles: [encoder.encode(scribeData).buffer] });

    assert.strictEqual(scribe.data.annotations.pages[0].length, 1);
    assert.strictEqual(scribe.data.annotations.pages[0][0].color, '#ffff00');
    assert.strictEqual(scribe.data.annotations.pages[0][0].opacity, 0.35);
    assert.strictEqual(scribe.data.annotations.pages[0][0].bbox.left, 100);
    assert.strictEqual(scribe.data.annotations.pages[0][0].bbox.right, 300);

    scribe.opt.compressScribe = true;
    await scribe.clear();
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check addHighlights and clearHighlights.', function () {
  this.timeout(10000);

  it('Should import document for highlight tests', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/testocr.abbyy.xml`]);
    assert.strictEqual(scribe.data.ocr.active[0].lines.length, 8);
  }).timeout(10000);

  it('addHighlights with startLine/endLine creates one annotation per word on that line', async () => {
    const result = scribe.addHighlights([{ page: 0, startLine: 0, endLine: 0 }]);
    assert.strictEqual(result.highlightsApplied, 1);
    assert.strictEqual(result.totalLinesHighlighted, 1);
    // Line 0 has 11 words: "This is a lot of 12 point text to test the"
    assert.strictEqual(scribe.data.annotations.pages[0].length, 11);
  }).timeout(10000);

  it('clearHighlights removes all programmatic highlights', async () => {
    scribe.clearHighlights();
    assert.strictEqual(scribe.data.annotations.pages[0].length, 0);
  }).timeout(10000);

  it('addHighlights with text in quote-only mode highlights matching words', async () => {
    // "ocr code" matches 2 words on line 1
    const result = scribe.addHighlights([{ page: 0, text: 'ocr code' }]);
    assert.strictEqual(result.highlightsApplied, 1);
    assert.strictEqual(scribe.data.annotations.pages[0].length, 2);
    scribe.clearHighlights();
  }).timeout(10000);

  it('addHighlights throws when neither startLine nor text is provided', async () => {
    assert.throws(() => scribe.addHighlights([{ page: 0 }]));
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);
