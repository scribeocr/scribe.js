import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { subsetPdf } from '../../js/export/pdf/writePdfOverlay.js';
import { mergePdfs } from '../../js/export/pdf/mergePdfs.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

const isNode = typeof window === 'undefined';

/** @param {string} pdfPath */
async function readPdfBytes(pdfPath) {
  if (isNode) {
    const { readFile } = await import('node:fs/promises');
    return new Uint8Array(await readFile(pdfPath));
  }
  const response = await fetch(pdfPath);
  return new Uint8Array(await response.arrayBuffer());
}

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

// Using arrow functions breaks references to `this`.

describe('Check export for .pdf files.', () => {
  test('Export -> import of simple text-only ebook-style PDF retains text content', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/text_simple.txt`]);

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

    expect(reExportedText).toBe(exportedText);
    expect(reExportedText).toBe('Tesseract.js');
    await scribe.clear();
  });

  test('Export -> import of image + text (visible, proofreading) PDF retains text content', async () => {
    scribe.opt.displayMode = 'proof';

    await scribe.importFiles([`${ASSETS_PATH}/testocr.png`, `${ASSETS_PATH}/testocr.abbyy.xml`]);

    const exportedPdf = await scribe.exportData('pdf');
    const exportedText = await scribe.exportData('text');

    // Inject an empty-text word to verify empty words do not cause errors during HTML export.
    // See: https://github.com/scribeocr/scribeocr/issues/91
    const line0html = scribe.data.ocr.active[0].lines[0];
    line0html.words.push(new scribe.utils.ocr.OcrWord(line0html, 'empty_word_html_test', '', {
      left: 100, top: 100, right: 100, bottom: 120,
    }));

    const exportedHtml = await scribe.exportData('html');
    expect(exportedHtml).toContain('>point<');

    await scribe.clear();
    scribe.opt.usePDFText.native.main = true;

    await scribe.importFiles({ pdfFiles: [exportedPdf] });

    scribe.data.ocr.active = scribe.data.ocr.pdf;
    const reExportedText = await scribe.exportData('text');

    expect(reExportedText).toBe(exportedText);
    expect(reExportedText).toContain('This is a lot of 12 point text');
  });

  test('Export of PDF with existing invisible text layer should not create duplicate text', async () => {
    scribe.opt.usePDFText.ocr.main = true;
    await scribe.importFiles([`${ASSETS_PATH}/scribe_test_pdf1.pdf`]);

    expect(scribe.inputData.pdfType).toBe('ocr');
    expect(scribe.data.ocr.active[0]?.lines?.length > 0).toBe(true);

    const originalLineCount = scribe.data.ocr.active[0].lines.length;
    const originalText = await scribe.exportData('text');

    scribe.opt.displayMode = 'invis';
    const exportedPdf = await scribe.exportData('pdf');

    await scribe.clear();
    scribe.opt.usePDFText.ocr.main = true;
    await scribe.importFiles({ pdfFiles: [exportedPdf] });

    expect(scribe.inputData.pdfType).toBe('ocr');
    expect(scribe.data.ocr.active[0]?.lines?.length > 0).toBe(true);

    const reImportedLineCount = scribe.data.ocr.active[0].lines.length;
    const reImportedText = await scribe.exportData('text');

    expect(reImportedLineCount).toBeLessThan(originalLineCount * 1.5);

    expect(reImportedText.length).toBeLessThan(originalText.length * 1.5);

    scribe.opt.displayMode = 'proof';
    scribe.opt.usePDFText.ocr.main = false;
    await scribe.clear();
  });

  test('Export of text-native PDF preserves visible text when adding overlay', async () => {
    scribe.opt.usePDFText.native.main = true;
    await scribe.importFiles([`${ASSETS_PATH}/small_caps_examples.pdf`]);

    expect(scribe.inputData.pdfType).toBe('text');

    // Delete the active OCR data before export so no invisible text overlay is added.
    // Without this, the native text extracted on import would be written back as an
    // invisible overlay, creating the same duplication issue tested above.
    scribe.data.ocr.active.length = 0;

    scribe.opt.displayMode = 'invis';
    const exportedPdf = await scribe.exportData('pdf');

    await scribe.clear();
    scribe.opt.usePDFText.native.main = true;
    await scribe.importFiles({ pdfFiles: [exportedPdf] });

    expect(scribe.inputData.pdfType).toBe('text');

    const text = scribe.data.ocr.active[0].lines[3].words.map((x) => x.text).join(' ');
    expect(text).toBe('Shubhdeep Deb');

    scribe.opt.displayMode = 'proof';
    await scribe.clear();
  });

  test('Annotations container is initialized for each page on import', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/testocr.png`, `${ASSETS_PATH}/testocr.abbyy.xml`]);

    expect(Array.isArray(scribe.data.annotations.pages[0])).toBe(true);
    expect(scribe.data.annotations.pages[0].length).toBe(0);
  });

  test('Highlight annotations are preserved through .scribe export and import', async () => {
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

    expect(scribe.data.annotations.pages[0].length).toBe(1);
    expect(scribe.data.annotations.pages[0][0].color).toBe('#ffff00');
    expect(scribe.data.annotations.pages[0][0].opacity).toBe(0.35);
    expect(scribe.data.annotations.pages[0][0].bbox.left).toBe(100);
    expect(scribe.data.annotations.pages[0][0].bbox.right).toBe(300);

    scribe.opt.compressScribe = true;
    await scribe.clear();
  });

  test('Highlight annotations are preserved through PDF export and re-import', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/complaint_1.pdf`]);
    await scribe.recognize();
    scribe.addHighlights([{ page: 0, startLine: 0, endLine: 2 }]);
    // addHighlights emits one entry per word; line 0-2 of complaint_1.pdf has 29 words.
    expect(scribe.data.annotations.pages[0].length).toBe(29);

    const pdfBytes = await scribe.exportData('pdf');
    await scribe.clear();

    await scribe.importFiles({ pdfFiles: [new Uint8Array(pdfBytes).buffer] });
    const highlights = scribe.data.annotations.pages.flatMap((p) => p || []);
    // Export consolidates the 29 per-word highlights into a single multi-quad
    // annotation spanning lines 0-2.
    expect(highlights.length).toBe(1);
    expect(highlights[0].quads.length).toBe(3);
    expect(highlights[0].color).toBe('#ffe93b');
    expect(highlights[0].opacity).toBe(0.4);
    await scribe.clear();
  });

  test('Exported PDF is compressed (FlateDecode) by default and larger under humanReadablePDF', async () => {
    // Regression gate for the compression + font-subsetting pipeline. The
    // compressed output on testocr.png + .abbyy.xml was ~220 KB before
    // FlateDecode + Latin-font subsetting landed; it is ~57 KB after. The
    // `humanReadablePDF` branch preserves pre-compression diffing by
    // emitting ASCII-hex streams, which bloats the output back up.
    scribe.opt.displayMode = 'proof';
    await scribe.importFiles([`${ASSETS_PATH}/testocr.png`, `${ASSETS_PATH}/testocr.abbyy.xml`]);

    scribe.opt.humanReadablePDF = false;
    const compressed = await scribe.exportData('pdf');
    expect(compressed.byteLength).toBeLessThan(70000);

    scribe.opt.humanReadablePDF = true;
    const humanReadable = await scribe.exportData('pdf');
    expect(humanReadable.byteLength).toBeGreaterThan(compressed.byteLength);

    scribe.opt.humanReadablePDF = false;
    await scribe.clear();
  });

  test('humanReadablePDF round-trip yields same text as compressed round-trip', async () => {
    scribe.opt.displayMode = 'proof';
    await scribe.importFiles([`${ASSETS_PATH}/testocr.png`, `${ASSETS_PATH}/testocr.abbyy.xml`]);

    scribe.opt.humanReadablePDF = false;
    const pdfCompressed = await scribe.exportData('pdf');
    scribe.opt.humanReadablePDF = true;
    const pdfHuman = await scribe.exportData('pdf');

    await scribe.clear();
    scribe.opt.usePDFText.native.main = true;
    await scribe.importFiles({ pdfFiles: [pdfCompressed] });
    scribe.data.ocr.active = scribe.data.ocr.pdf;
    const textCompressed = await scribe.exportData('text');

    await scribe.clear();
    scribe.opt.usePDFText.native.main = true;
    await scribe.importFiles({ pdfFiles: [pdfHuman] });
    scribe.data.ocr.active = scribe.data.ocr.pdf;
    const textHuman = await scribe.exportData('text');

    expect(textCompressed).toBe(textHuman);
    expect(textCompressed).toContain('This is a lot of 12 point text');

    scribe.opt.humanReadablePDF = false;
    await scribe.clear();
  });

  test('PDF overlay via incremental update inserts extractable text into existing PDF', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/gov.uscourts.cand.249697.1.0_2.pdf`]);
    await scribe.recognize();

    const ocrText = /** @type {string} */ (await scribe.exportData('text', { minPage: 0, maxPage: 0 }));
    expect(ocrText.length).toBeGreaterThan(10);

    scribe.opt.displayMode = 'invis';
    scribe.opt.addOverlay = true;
    const exportedPdf = /** @type {ArrayBuffer} */ (await scribe.exportData('pdf'));
    expect(exportedPdf.byteLength).toBeGreaterThan(1000);

    await scribe.clear();
    scribe.opt.usePDFText.native.main = true;
    scribe.opt.keepPDFTextAlways = true;
    await scribe.importFiles({ pdfFiles: [exportedPdf] });

    scribe.data.ocr.active = scribe.data.ocr.pdf;
    const reExportedText = /** @type {string} */ (await scribe.exportData('text', { minPage: 0, maxPage: 0 }));
    expect(reExportedText.length).toBeGreaterThan(10);

    scribe.opt.displayMode = 'proof';
    scribe.opt.addOverlay = true;
    await scribe.clear();
  });

  test('Export of scanned PDF builds new PDF with rendered images and extractable text', async () => {
    // addOverlay=false forces the image-rendering path (vs. incremental update).
    await scribe.importFiles([`${ASSETS_PATH}/gov.uscourts.cand.249697.1.0_2.pdf`]);
    await scribe.recognize();

    const ocrText = /** @type {string} */ (await scribe.exportData('text', { minPage: 0, maxPage: 0 }));
    expect(ocrText.length).toBeGreaterThan(10);

    scribe.opt.displayMode = 'invis';
    scribe.opt.addOverlay = false;
    const exportedPdf = /** @type {ArrayBuffer} */ (await scribe.exportData('pdf', { minPage: 0, maxPage: 0 }));
    expect(exportedPdf.byteLength).toBeGreaterThan(1000);

    await scribe.clear();
    scribe.opt.usePDFText.native.main = true;
    scribe.opt.keepPDFTextAlways = true;
    await scribe.importFiles({ pdfFiles: [exportedPdf] });

    scribe.data.ocr.active = scribe.data.ocr.pdf;
    const reExportedText = /** @type {string} */ (await scribe.exportData('text', { minPage: 0, maxPage: 0 }));
    expect(reExportedText.length).toBeGreaterThan(10);

    scribe.opt.displayMode = 'proof';
    scribe.opt.addOverlay = true;
    await scribe.clear();
  });

  test('PDF overlay with page subset exports only the requested pages and removes unreferenced objects', async () => {
    scribe.opt.usePDFText.native.main = true;
    scribe.opt.keepPDFTextAlways = true;
    await scribe.importFiles([`${ASSETS_PATH}/Iris (plant) - Wikipedia_123.pdf`]);

    expect(scribe.data.ocr.active.length).toBe(3);
    expect(scribe.data.ocr.active[0].lines[0].words[0].text).toBe('Iris');

    scribe.opt.displayMode = 'invis';
    scribe.opt.addOverlay = true;
    const fullExportPdf = /** @type {ArrayBuffer} */ (await scribe.exportData('pdf'));
    const fullExportSize = fullExportPdf.byteLength;

    const exportedPdf = /** @type {ArrayBuffer} */ (await scribe.exportData('pdf', { minPage: 1, maxPage: 2 }));
    expect(exportedPdf.byteLength).toBeGreaterThan(1000);
    expect(exportedPdf.byteLength).toBeLessThan(fullExportSize);

    await scribe.clear();
    scribe.opt.usePDFText.native.main = true;
    scribe.opt.keepPDFTextAlways = true;
    await scribe.importFiles({ pdfFiles: [exportedPdf] });

    scribe.data.ocr.active = scribe.data.ocr.pdf;
    expect(scribe.data.ocr.active.length).toBe(2);

    for (let i = 0; i < 2; i++) {
      const pageText = /** @type {string} */ (await scribe.exportData('text', { minPage: i, maxPage: i }));
      expect(pageText.length).toBeGreaterThan(10);
    }

    const exportedPage0Text = /** @type {string} */ (await scribe.exportData('text', { minPage: 0, maxPage: 0 }));
    expect(exportedPage0Text).not.toContain('Iris (plant)');

    scribe.opt.displayMode = 'proof';
    await scribe.clear();
  });

  test('subsetPdf keeps arbitrary pages and drops unreferenced resource objects', async () => {
    const { readFile } = await import('node:fs/promises');
    const originalBytes = (await readFile(`${ASSETS_PATH}/Iris (plant) - Wikipedia_123.pdf`)).buffer;

    // Case 1: keep pages 0 and 2, drop the middle page.
    const subsetBytes02 = /** @type {ArrayBuffer} */ (await subsetPdf(originalBytes, [0, 2]));
    expect(subsetBytes02.byteLength).toBeGreaterThan(1000);
    expect(subsetBytes02.byteLength).toBeLessThan(originalBytes.byteLength);

    await scribe.clear();
    scribe.opt.usePDFText.native.main = true;
    scribe.opt.keepPDFTextAlways = true;
    await scribe.importFiles({ pdfFiles: [subsetBytes02] });
    scribe.data.ocr.active = scribe.data.ocr.pdf;

    expect(scribe.data.ocr.active.length).toBe(2);
    expect(scribe.data.ocr.active[0].lines[0].words[0].text).toBe('Iris');
    const subsetPage1Text = /** @type {string} */ (await scribe.exportData('text', { minPage: 1, maxPage: 1 }));
    expect(subsetPage1Text).not.toContain('Iris (plant)');

    // Case 2: keep just the middle page.
    await scribe.clear();
    const subsetBytes1 = /** @type {ArrayBuffer} */ (await subsetPdf(originalBytes, [1]));
    expect(subsetBytes1.byteLength).toBeGreaterThan(1000);

    scribe.opt.usePDFText.native.main = true;
    scribe.opt.keepPDFTextAlways = true;
    await scribe.importFiles({ pdfFiles: [subsetBytes1] });
    scribe.data.ocr.active = scribe.data.ocr.pdf;

    expect(scribe.data.ocr.active.length).toBe(1);
    const middlePageText = /** @type {string} */ (await scribe.exportData('text', { minPage: 0, maxPage: 0 }));
    expect(middlePageText).not.toContain('Iris (plant)');

    await scribe.clear();
  });

  test('mergePdfs concatenates pages from two input PDFs into one output', async () => {
    const { readFile } = await import('node:fs/promises');
    const originalBytes = (await readFile(`${ASSETS_PATH}/Iris (plant) - Wikipedia_123.pdf`)).buffer;

    const mergedBytes = /** @type {ArrayBuffer} */ (await mergePdfs([originalBytes, originalBytes]));
    expect(mergedBytes.byteLength).toBeGreaterThan(1000);
    // Output should be roughly 2× the original.
    expect(mergedBytes.byteLength).toBeGreaterThan(originalBytes.byteLength * 1.5);
    expect(mergedBytes.byteLength).toBeLessThan(originalBytes.byteLength * 2.5);

    await scribe.clear();
    scribe.opt.usePDFText.native.main = true;
    scribe.opt.keepPDFTextAlways = true;
    await scribe.importFiles({ pdfFiles: [mergedBytes] });
    scribe.data.ocr.active = scribe.data.ocr.pdf;

    expect(scribe.data.ocr.active.length).toBe(6);
    expect(scribe.data.ocr.active[0].lines[0].words[0].text).toBe('Iris');
    expect(scribe.data.ocr.active[3].lines[0].words[0].text).toBe('Iris');

    await scribe.clear();
  });

  test('PDF overlay with full page range retains all pages', async () => {
    scribe.opt.usePDFText.native.main = true;
    scribe.opt.keepPDFTextAlways = true;
    await scribe.importFiles([`${ASSETS_PATH}/Iris (plant) - Wikipedia_123.pdf`]);

    scribe.opt.displayMode = 'invis';
    scribe.opt.addOverlay = true;
    const exportedPdf = /** @type {ArrayBuffer} */ (await scribe.exportData('pdf'));
    expect(exportedPdf.byteLength).toBeGreaterThan(1000);

    await scribe.clear();
    scribe.opt.usePDFText.native.main = true;
    scribe.opt.keepPDFTextAlways = true;
    await scribe.importFiles({ pdfFiles: [exportedPdf] });

    scribe.data.ocr.active = scribe.data.ocr.pdf;
    expect(scribe.data.ocr.active.length).toBe(3);

    const page0Text = /** @type {string} */ (await scribe.exportData('text', { minPage: 0, maxPage: 0 }));
    expect(page0Text).toContain('Iris');

    scribe.opt.displayMode = 'proof';
    await scribe.clear();
  });

  test('Human-readable text-only PDF has uncompressed content streams and hex-encoded fonts', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/text_simple.txt`]);

    scribe.opt.displayMode = 'ebook';
    scribe.opt.humanReadablePDF = true;
    const exportedPdf = /** @type {ArrayBuffer} */ (await scribe.exportData('pdf'));
    scribe.opt.humanReadablePDF = false;

    const pdfBytes = new Uint8Array(exportedPdf);
    const pdfText = new TextDecoder().decode(pdfBytes);

    // Content streams should contain readable PDF text operators (not compressed).
    expect(pdfText).toContain('BT');
    expect(pdfText).toContain('Tf');
    expect(pdfText).not.toContain('/Filter/FlateDecode');
    // Font streams should use ASCIIHexDecode.
    expect(pdfText).toContain('/Filter/ASCIIHexDecode');

    // Skip the first 30 bytes (well past the header + marker comment) when asserting
    // the rest of the file is human-readable ASCII.
    let allAsciiBody = true;
    for (let i = 30; i < pdfBytes.length; i++) {
      if (pdfBytes[i] > 127) { allAsciiBody = false; break; }
    }
    expect(allAsciiBody).toBe(true);

    await scribe.clear();
    scribe.opt.usePDFText.native.main = true;
    scribe.opt.keepPDFTextAlways = true;
    await scribe.importFiles({ pdfFiles: [exportedPdf] });
    scribe.data.ocr.active = scribe.data.ocr.pdf;
    const reExportedText = await scribe.exportData('text');
    expect(reExportedText).toBe('Tesseract.js');

    scribe.opt.displayMode = 'proof';
    await scribe.clear();
  });

  test('Human-readable PDF with images hex-encodes image streams', async () => {
    scribe.opt.displayMode = 'proof';
    scribe.opt.humanReadablePDF = true;

    await scribe.importFiles([`${ASSETS_PATH}/testocr.png`, `${ASSETS_PATH}/testocr.abbyy.xml`]);
    const exportedPdf = /** @type {ArrayBuffer} */ (await scribe.exportData('pdf'));

    scribe.opt.humanReadablePDF = false;

    const pdfBytes = new Uint8Array(exportedPdf);
    const pdfText = new TextDecoder().decode(pdfBytes);

    // Image streams should use ASCIIHexDecode in a filter array.
    expect(pdfText).toContain('/ASCIIHexDecode');
    // No FlateDecode should appear as a standalone filter (only inside filter arrays).
    expect(pdfText).not.toContain('/Filter/FlateDecode');
    expect(pdfText).not.toContain('/Filter /FlateDecode');

    // Skip the first 30 bytes (well past the header + marker comment) when asserting
    // the rest of the file is human-readable ASCII.
    let allAsciiBody = true;
    for (let i = 30; i < pdfBytes.length; i++) {
      if (pdfBytes[i] > 127) { allAsciiBody = false; break; }
    }
    expect(allAsciiBody).toBe(true);

    await scribe.clear();
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check addHighlights and clearHighlights.', () => {
  test('Should import document for highlight tests', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/testocr.abbyy.xml`]);
    expect(scribe.data.ocr.active[0].lines.length).toBe(8);
  });

  test('addHighlights with startLine/endLine creates one annotation per word on that line', async () => {
    const result = scribe.addHighlights([{ page: 0, startLine: 0, endLine: 0 }]);
    expect(result.highlightsApplied).toBe(1);
    expect(result.totalLinesHighlighted).toBe(1);
    // Line 0 has 11 words: "This is a lot of 12 point text to test the"
    expect(scribe.data.annotations.pages[0].length).toBe(11);
  });

  test('clearHighlights removes all programmatic highlights', async () => {
    scribe.clearHighlights();
    expect(scribe.data.annotations.pages[0].length).toBe(0);
  });

  test('addHighlights with text in quote-only mode highlights matching words', async () => {
    // "ocr code" matches 2 words on line 1
    const result = scribe.addHighlights([{ page: 0, text: 'ocr code' }]);
    expect(result.highlightsApplied).toBe(1);
    expect(scribe.data.annotations.pages[0].length).toBe(2);
    scribe.clearHighlights();
  });

  test('addHighlights throws when neither startLine nor text is provided', async () => {
    expect(() => scribe.addHighlights([{ page: 0 }])).toThrow(undefined);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
