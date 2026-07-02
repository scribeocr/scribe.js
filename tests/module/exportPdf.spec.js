import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { subsetPdf } from '../../js/export/pdf/subsetPdf.js';
import { mergePdfs } from '../../js/export/pdf/mergePdfs.js';
import { ca } from '../../js/canvasAdapter.js';
import { renderPdfPage } from '../_renderPdfPage.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

/** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
let doc;

const FREETEXT_LABEL = 'Page label — review ✓';
const FREETEXT_SPEC = {
  page: 0,
  bbox: {
    left: 100, top: 50, right: 400, bottom: 80,
  },
  contents: FREETEXT_LABEL,
  fontSize: 9,
  textColor: '#cc0000',
  fillColor: '#ffffcc',
  opacity: 1,
};

const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;

/** @param {string} pdfPath */
async function readPdfBytes(pdfPath) {
  if (isNode) {
    const { readFile } = await import('node:fs/promises');
    return new Uint8Array(await readFile(pdfPath));
  }
  const response = await fetch(pdfPath);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Decode a `data:image/png;base64,...` URL into raw PNG bytes (Node + browser).
 * @param {string} dataUrl
 * @returns {Uint8Array}
 */
function dataUrlToPngBytes(dataUrl) {
  const base64 = dataUrl.slice('data:image/png;base64,'.length);
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(base64, 'base64'));
  const bin = atob(base64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

// Using arrow functions breaks references to `this`.

describe('Check export for .pdf files.', () => {
  test('Export -> import of simple text-only ebook-style PDF retains text content', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/text_simple.txt`]);

    const exportedText = await doc.exportData('text');

    // Inject an empty-text word to verify empty words do not cause errors during PDF export.
    // See: https://github.com/scribeocr/scribeocr/issues/91
    const line0 = doc.ocr.active[0].lines[0];
    line0.words.push(new scribe.utils.ocr.OcrWord(line0, 'empty_word_test', '', {
      left: 100, top: 100, right: 100, bottom: 120,
    }));

    const exportedPdf = await doc.exportData('pdf');

    scribe.ScribeDoc.defaults.displayMode = 'ebook';

    await doc.clear();
    scribe.ScribeDoc.defaults.usePDFText.native.main = true;
    scribe.ScribeDoc.defaults.keepPDFTextAlways = true;

    doc = await scribe.openDocument({ pdfFiles: [exportedPdf] });

    doc.ocr.active = doc.ocr.pdf;
    const reExportedText = await doc.exportData('text');

    expect(reExportedText).toBe(exportedText);
    expect(reExportedText).toBe('Tesseract.js');
    await doc.clear();
  });

  test('Export -> import of image + text (visible, proofreading) PDF retains text content', async () => {
    scribe.ScribeDoc.defaults.displayMode = 'proof';

    doc = await scribe.openDocument([`${ASSETS_PATH}/testocr.png`, `${ASSETS_PATH}/testocr.abbyy.xml`]);

    const exportedPdf = await doc.exportData('pdf');
    const exportedText = await doc.exportData('text');

    // Inject an empty-text word to verify empty words do not cause errors during HTML export.
    // See: https://github.com/scribeocr/scribeocr/issues/91
    const line0html = doc.ocr.active[0].lines[0];
    line0html.words.push(new scribe.utils.ocr.OcrWord(line0html, 'empty_word_html_test', '', {
      left: 100, top: 100, right: 100, bottom: 120,
    }));

    const exportedHtml = await doc.exportData('html');
    expect(exportedHtml).toContain('>point<');

    await doc.clear();
    scribe.ScribeDoc.defaults.usePDFText.native.main = true;

    doc = await scribe.openDocument({ pdfFiles: [exportedPdf] });

    doc.ocr.active = doc.ocr.pdf;
    const reExportedText = await doc.exportData('text');

    expect(reExportedText).toBe(exportedText);
    expect(reExportedText).toContain('This is a lot of 12 point text');
  });

  for (const mode of /** @type {const} */ (['invis', 'proof'])) {
    test(`Existing invisible OCR layer is stripped before overlaying (displayMode='${mode}')`, async () => {
      scribe.ScribeDoc.defaults.usePDFText.ocr.main = true;
      doc = await scribe.openDocument([`${ASSETS_PATH}/scribe_test_pdf1.pdf`]);
      expect(doc.inputData.pdfType).toBe('ocr');

      const sourceOcr = doc.ocr.active.length ? doc.ocr.active : doc.ocr.pdf;
      let sourceLines = 0;
      let sourceWords = 0;
      for (const page of sourceOcr) {
        sourceLines += page.lines.length;
        for (const line of page.lines) sourceWords += line.words.length;
      }
      expect(sourceLines).toBe(58);
      expect(sourceWords).toBe(407);

      scribe.ScribeDoc.defaults.displayMode = mode;
      const exportedPdf = await doc.exportData('pdf');

      await doc.clear();
      scribe.ScribeDoc.defaults.usePDFText.ocr.main = true;
      scribe.ScribeDoc.defaults.keepPDFTextAlways = true;
      doc = await scribe.openDocument({ pdfFiles: [exportedPdf] });
      const ocr = doc.ocr.active.length ? doc.ocr.active : doc.ocr.pdf;

      let lines = 0;
      let words = 0;
      const colors = new Set();
      const opacities = new Set();
      for (const page of ocr) {
        lines += page.lines.length;
        for (const line of page.lines) {
          for (const w of line.words) {
            words++;
            colors.add(w.style.color);
            opacities.add(w.style.opacity);
          }
        }
      }
      expect(lines).toBe(58);
      expect(words).toBe(407);
      expect(lines).toBe(sourceLines);
      expect(words).toBe(sourceWords);
      expect(colors.size).toBe(1);
      expect(opacities.size).toBe(1);
      if (mode === 'invis') {
        expect([...colors]).toEqual(['#000000']);
        expect([...opacities]).toEqual([0]);
      } else {
        // Confidence buckets in the source PDF text default to high → green
        // (#00ff80) at proofOpacity 0.8 since no recognise pass was run.
        expect([...colors]).toEqual(['#00ff80']);
        expect([...opacities]).toEqual([0.8]);
      }

      scribe.ScribeDoc.defaults.displayMode = 'invis';
      scribe.ScribeDoc.defaults.usePDFText.ocr.main = false;
      scribe.ScribeDoc.defaults.keepPDFTextAlways = false;
      await doc.clear();
    });
  }

  test('Export of text-native PDF preserves visible text when adding overlay', async () => {
    scribe.ScribeDoc.defaults.usePDFText.native.main = true;
    doc = await scribe.openDocument([`${ASSETS_PATH}/small_caps_examples.pdf`]);

    expect(doc.inputData.pdfType).toBe('text');

    // Delete the active OCR data before export so no invisible text overlay is added.
    // Without this, the native text extracted on import would be written back as an
    // invisible overlay, creating the same duplication issue tested above.
    doc.ocr.active.length = 0;

    scribe.ScribeDoc.defaults.displayMode = 'invis';
    const exportedPdf = await doc.exportData('pdf');

    await doc.clear();
    scribe.ScribeDoc.defaults.usePDFText.native.main = true;
    doc = await scribe.openDocument({ pdfFiles: [exportedPdf] });

    expect(doc.inputData.pdfType).toBe('text');

    const text = doc.ocr.active[0].lines[3].words.map((x) => x.text).join(' ');
    expect(text).toBe('Shubhdeep Deb');

    scribe.ScribeDoc.defaults.displayMode = 'invis';
    await doc.clear();
  });

  test('Annotations container is initialized for each page on import', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/testocr.png`, `${ASSETS_PATH}/testocr.abbyy.xml`]);

    expect(Array.isArray(doc.annotations.pages[0])).toBe(true);
    expect(doc.annotations.pages[0].length).toBe(0);
  });

  test('Highlight annotations are preserved through .scribe export and import', async () => {
    doc.annotations.pages[0].push({
      bbox: {
        left: 100, top: 200, right: 300, bottom: 220,
      },
      color: '#ffff00',
      opacity: 0.35,
      groupId: 'test-export-1',
    });

    scribe.ScribeDoc.defaults.compressScribe = false;
    const scribeData = await doc.exportData('scribe');

    await doc.clear();

    const encoder = new TextEncoder();
    doc = await scribe.openDocument({ scribeFiles: [encoder.encode(scribeData).buffer] });

    expect(doc.annotations.pages[0].length).toBe(1);
    expect(doc.annotations.pages[0][0].color).toBe('#ffff00');
    expect(doc.annotations.pages[0][0].opacity).toBe(0.35);
    expect(doc.annotations.pages[0][0].bbox.left).toBe(100);
    expect(doc.annotations.pages[0][0].bbox.right).toBe(300);

    scribe.ScribeDoc.defaults.compressScribe = true;
    await doc.clear();
  });

  test('Highlight, FreeText, and shape annotations are preserved through PDF export and re-import', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/complaint_1.pdf`, `${ASSETS_PATH}/complaint_1.abbyy.xml`]);
    doc.addHighlights([{ page: 0, startLine: 0, endLine: 2 }]);
    // addHighlights emits one entry per word; lines 0-2 of complaint_1.abbyy.xml have 41 words.
    expect(doc.annotations.pages[0].length).toBe(41);

    doc.addFreeText([FREETEXT_SPEC]);
    expect(doc.annotations.pages[0].length).toBe(42);

    const shapeResult = doc.addShapes([
      {
        page: 0,
        type: 'square',
        bbox: {
          left: 200, top: 250, right: 1200, bottom: 650,
        },
        borderColor: '#ff0000',
        borderWidth: 6,
      },
      {
        page: 0,
        type: 'circle',
        bbox: {
          left: 1400, top: 250, right: 2100, bottom: 950,
        },
        borderColor: '#0000ff',
        fillColor: '#00ff00',
        opacity: 0.4,
        borderWidth: 6,
      },
      {
        page: 0, type: 'line', points: [200, 1100, 2300, 1100], borderColor: '#000000', borderWidth: 10,
      },
      {
        page: 0, type: 'polygon', vertices: [450, 1400, 1350, 1400, 900, 2150], borderColor: '#ff00ff', borderWidth: 6,
      },
    ]);
    expect(shapeResult.shapesAdded).toBe(4);
    expect(doc.annotations.pages[0].length).toBe(46);

    // Inject a malformed shape past addShapes validation to exercise the export skip path.
    // @ts-expect-error - intentionally missing bbox.
    doc.annotations.pages[0].push({ type: 'square', borderColor: '#ff0000', borderWidth: 4 });
    const warnings = /** @type {string[]} */ ([]);
    const prevWarn = scribe.opt.warningHandler;
    scribe.opt.warningHandler = (msg) => warnings.push(msg);

    const pdfBytes = await doc.exportData('pdf');
    scribe.opt.warningHandler = prevWarn;

    // Shapes are written into the exported PDF (they are not re-parsed back into the model on import).
    // complaint_1's base MediaBox is 612x792 over 2550x3300 OCR space, so page coords scale by 0.24 and flip in y.
    const shapeText = new TextDecoder('latin1').decode(new Uint8Array(pdfBytes));
    expect(shapeText).toContain('/Subtype /Square /Rect [42 630 294 738] /C [1 0 0]');
    expect(shapeText).toContain('/Subtype /Circle /Rect [330 558 510 738] /C [0 0 1] /IC [0 1 0] /CA 0.4');
    expect(shapeText).toContain('/Subtype /Line /Rect [38 518 562 538] /C [0 0 0]');
    expect(shapeText).toContain('/L [48 528 552 528]');
    expect(shapeText).toContain('/Subtype /Polygon /Rect [102 270 330 462] /C [1 0 1]');
    expect(shapeText).toContain('/Vertices [108 456 324 456 216 276]');
    // One /AP appearance Form XObject per shape; only the circle is filled (/IC).
    expect(shapeText.split('/Subtype /Form').length - 1).toBe(4);
    expect(shapeText.split('/IC ').length - 1).toBe(1);
    // The malformed square emitted nothing (only the one valid square is present) and was reported once.
    expect(shapeText.split('/Subtype /Square').length - 1).toBe(1);
    expect(warnings.filter((w) => w.includes('Skipped') && w.includes('square')).length).toBe(1);

    await doc.clear();

    doc = await scribe.openDocument({ pdfFiles: [new Uint8Array(pdfBytes).buffer] });
    const all = doc.annotations.pages.flatMap((p) => p || []);
    const highlights = all.filter((a) => a.type === 'highlight');
    const freeTexts = all.filter((a) => a.type === 'freetext');

    // Export consolidates the per-word highlights into a single multi-quad
    // annotation spanning lines 0-2.
    expect(highlights.length).toBe(1);
    expect(highlights[0].quads.length).toBe(3);
    expect(highlights[0].color).toBe('#ffe93b');
    expect(highlights[0].opacity).toBe(0.4);

    expect(freeTexts.length).toBe(1);
    const ft = freeTexts[0];
    expect(ft.type).toBe('freetext');
    expect(ft.contents).toBe(FREETEXT_LABEL);
    expect(ft.fontSize).toBeCloseTo(9, 10);
    expect(ft.textColor).toBe('#cc0000');
    expect(ft.fillColor).toBe('#ffffcc');
    expect(ft.opacity).toBe(1);
    expect(ft.bbox.left).toBe(100);
    expect(ft.bbox.top).toBe(50);
    expect(ft.bbox.right).toBe(400);
    // The /Rect Y-flip round-trip (H - (H - 80)) leaves ~1e-13 float noise.
    expect(ft.bbox.bottom).toBeCloseTo(80, 10);
    await doc.clear();
  });

  test('Exported PDF is compressed (FlateDecode) by default and larger under humanReadablePDF', async () => {
    // Regression gate for the compression + font-subsetting pipeline. The
    // compressed output on testocr.png + .abbyy.xml was ~220 KB before
    // FlateDecode + Latin-font subsetting landed; it is ~57 KB after. The
    // `humanReadablePDF` branch preserves pre-compression diffing by
    // emitting ASCII-hex streams, which bloats the output back up.
    scribe.ScribeDoc.defaults.displayMode = 'proof';
    doc = await scribe.openDocument([`${ASSETS_PATH}/testocr.png`, `${ASSETS_PATH}/testocr.abbyy.xml`]);

    scribe.ScribeDoc.defaults.humanReadablePDF = false;
    const compressed = await doc.exportData('pdf');
    expect(compressed.byteLength).toBeLessThan(70000);

    scribe.ScribeDoc.defaults.humanReadablePDF = true;
    const humanReadable = await doc.exportData('pdf');
    expect(humanReadable.byteLength).toBeGreaterThan(compressed.byteLength);

    scribe.ScribeDoc.defaults.humanReadablePDF = false;
    await doc.clear();
  });

  describe('Proof-mode round-trip preserves color, opacity, and text', () => {
    /** @type {Array<{ color: string, opacity: number }>} */
    let compressedWords;
    /** @type {string} */
    let textCompressed;
    /** @type {string} */
    let textHuman;

    beforeAll(async () => {
      scribe.ScribeDoc.defaults.displayMode = 'proof';
      doc = await scribe.openDocument([`${ASSETS_PATH}/testocr.png`, `${ASSETS_PATH}/testocr.abbyy.xml`]);

      scribe.ScribeDoc.defaults.humanReadablePDF = false;
      const pdfCompressed = await doc.exportData('pdf');
      scribe.ScribeDoc.defaults.humanReadablePDF = true;
      const pdfHuman = await doc.exportData('pdf');
      scribe.ScribeDoc.defaults.humanReadablePDF = false;

      await doc.clear();
      scribe.ScribeDoc.defaults.usePDFText.native.main = true;
      doc = await scribe.openDocument({ pdfFiles: [pdfCompressed] });
      doc.ocr.active = doc.ocr.pdf;
      compressedWords = [];
      for (const line of doc.ocr.active[0].lines) {
        for (const w of line.words) compressedWords.push({ color: w.style.color, opacity: w.style.opacity });
      }
      textCompressed = /** @type {string} */ (await doc.exportData('text'));

      await doc.clear();
      scribe.ScribeDoc.defaults.usePDFText.native.main = true;
      doc = await scribe.openDocument({ pdfFiles: [pdfHuman] });
      doc.ocr.active = doc.ocr.pdf;
      textHuman = /** @type {string} */ (await doc.exportData('text'));
    });

    afterAll(async () => {
      await doc.clear();
    });

    test('Compressed export round-trips 59 high-confidence words coloured green (#00ff80)', () => {
      const greenCount = compressedWords.filter((w) => w.color === '#00ff80').length;
      expect(greenCount).toBe(59);
    });

    test('Compressed export round-trips 1 low-confidence word coloured red (#ff0000)', () => {
      const redCount = compressedWords.filter((w) => w.color === '#ff0000').length;
      expect(redCount).toBe(1);
    });

    test('Compressed export emits exactly the two confidence colours present in this fixture (no medium-confidence words)', () => {
      const distinctColors = new Set(compressedWords.map((w) => w.color));
      expect([...distinctColors].sort()).toEqual(['#00ff80', '#ff0000']);
    });

    test('Compressed export round-trips proofOpacity 0.8 for every word', () => {
      const distinctOpacities = new Set(compressedWords.map((w) => w.opacity));
      expect([...distinctOpacities]).toEqual([0.8]);
    });

    test('humanReadable export yields identical extracted text to compressed export', () => {
      expect(textHuman).toBe(textCompressed);
    });

    test('Round-tripped text contains the expected source content', () => {
      expect(textCompressed).toContain('This is a lot of 12 point text');
    });
  });

  test('PDF overlay with page subset exports only the requested pages and removes unreferenced objects', async () => {
    scribe.ScribeDoc.defaults.usePDFText.native.main = true;
    scribe.ScribeDoc.defaults.keepPDFTextAlways = true;
    doc = await scribe.openDocument([`${ASSETS_PATH}/Iris (plant) - Wikipedia_123.pdf`]);

    expect(doc.ocr.active.length).toBe(3);
    expect(doc.ocr.active[0].lines[0].words[0].text).toBe('Iris');

    scribe.ScribeDoc.defaults.displayMode = 'invis';
    scribe.ScribeDoc.defaults.addOverlay = true;
    const fullExportPdf = /** @type {ArrayBuffer} */ (await doc.exportData('pdf'));
    const fullExportSize = fullExportPdf.byteLength;

    const exportedPdf = /** @type {ArrayBuffer} */ (await doc.exportData('pdf', { minPage: 1, maxPage: 2 }));
    expect(exportedPdf.byteLength).toBeGreaterThan(1000);
    expect(exportedPdf.byteLength).toBeLessThan(fullExportSize);

    await doc.clear();
    scribe.ScribeDoc.defaults.usePDFText.native.main = true;
    scribe.ScribeDoc.defaults.keepPDFTextAlways = true;
    doc = await scribe.openDocument({ pdfFiles: [exportedPdf] });

    doc.ocr.active = doc.ocr.pdf;
    expect(doc.ocr.active.length).toBe(2);

    for (let i = 0; i < 2; i++) {
      const pageText = /** @type {string} */ (await doc.exportData('text', { minPage: i, maxPage: i }));
      expect(pageText.length).toBeGreaterThan(10);
    }

    const exportedPage0Text = /** @type {string} */ (await doc.exportData('text', { minPage: 0, maxPage: 0 }));
    expect(exportedPage0Text).not.toContain('Iris (plant)');

    scribe.ScribeDoc.defaults.displayMode = 'invis';
    await doc.clear();
  });

  test('subsetPdf keeps arbitrary pages and drops unreferenced resource objects', async () => {
    const originalBytes = (await readPdfBytes(`${ASSETS_PATH}/Iris (plant) - Wikipedia_123.pdf`)).buffer;

    // Case 1: keep pages 0 and 2, drop the middle page.
    const subsetBytes02 = /** @type {ArrayBuffer} */ (await subsetPdf(originalBytes, [0, 2]));
    expect(subsetBytes02.byteLength).toBeGreaterThan(1000);
    expect(subsetBytes02.byteLength).toBeLessThan(originalBytes.byteLength);

    await doc.clear();
    scribe.ScribeDoc.defaults.usePDFText.native.main = true;
    scribe.ScribeDoc.defaults.keepPDFTextAlways = true;
    doc = await scribe.openDocument({ pdfFiles: [subsetBytes02] });
    doc.ocr.active = doc.ocr.pdf;

    expect(doc.ocr.active.length).toBe(2);
    expect(doc.ocr.active[0].lines[0].words[0].text).toBe('Iris');
    const subsetPage1Text = /** @type {string} */ (await doc.exportData('text', { minPage: 1, maxPage: 1 }));
    expect(subsetPage1Text).not.toContain('Iris (plant)');

    // Case 2: keep just the middle page.
    await doc.clear();
    const subsetBytes1 = /** @type {ArrayBuffer} */ (await subsetPdf(originalBytes, [1]));
    expect(subsetBytes1.byteLength).toBeGreaterThan(1000);

    scribe.ScribeDoc.defaults.usePDFText.native.main = true;
    scribe.ScribeDoc.defaults.keepPDFTextAlways = true;
    doc = await scribe.openDocument({ pdfFiles: [subsetBytes1] });
    doc.ocr.active = doc.ocr.pdf;

    expect(doc.ocr.active.length).toBe(1);
    const middlePageText = /** @type {string} */ (await doc.exportData('text', { minPage: 0, maxPage: 0 }));
    expect(middlePageText).not.toContain('Iris (plant)');

    await doc.clear();
  });

  test('mergePdfs concatenates pages from two input PDFs into one output', async () => {
    const originalBytes = (await readPdfBytes(`${ASSETS_PATH}/Iris (plant) - Wikipedia_123.pdf`)).buffer;

    const mergedBytes = /** @type {ArrayBuffer} */ (await mergePdfs([originalBytes, originalBytes]));
    expect(mergedBytes.byteLength).toBeGreaterThan(1000);
    // Output should be roughly 2× the original.
    expect(mergedBytes.byteLength).toBeGreaterThan(originalBytes.byteLength * 1.5);
    expect(mergedBytes.byteLength).toBeLessThan(originalBytes.byteLength * 2.5);

    await doc.clear();
    scribe.ScribeDoc.defaults.usePDFText.native.main = true;
    scribe.ScribeDoc.defaults.keepPDFTextAlways = true;
    doc = await scribe.openDocument({ pdfFiles: [mergedBytes] });
    doc.ocr.active = doc.ocr.pdf;

    expect(doc.ocr.active.length).toBe(6);
    expect(doc.ocr.active[0].lines[0].words[0].text).toBe('Iris');
    expect(doc.ocr.active[3].lines[0].words[0].text).toBe('Iris');

    await doc.clear();
  });

  test('PDF overlay (annot mode): all pages retained, text not duplicated, and a multi-line highlight round-trips as one consolidated annotation, un-duplicated on re-export', async () => {
    scribe.ScribeDoc.defaults.usePDFText.native.main = true;
    scribe.ScribeDoc.defaults.keepPDFTextAlways = true;
    doc = await scribe.openDocument([`${ASSETS_PATH}/Iris (plant) - Wikipedia_123.pdf`]);

    const countWords = (pages) => {
      let n = 0;
      for (const page of pages) {
        for (const line of page.lines) n += line.words.filter((w) => w.text).length;
      }
      return n;
    };
    expect(countWords(doc.ocr.active), 'source PDF native word count baseline').toBe(1064);

    // A single-word highlight consolidates to one annotation regardless, so the span must cover multiple words to catch the regression.
    doc.addHighlights([{ page: 0, startLine: 0, endLine: 2 }]);
    expect(doc.annotations.pages[0].length, 'addHighlights should emit one entry per native word for lines 0-2 (5 words)').toBe(5);

    scribe.ScribeDoc.defaults.displayMode = 'annot';
    scribe.ScribeDoc.defaults.addOverlay = true;
    const exportedPdf = /** @type {ArrayBuffer} */ (await doc.exportData('pdf'));
    expect(exportedPdf.byteLength, 'annot-mode overlay export produces a non-trivial PDF').toBeGreaterThan(1000);

    await doc.clear();
    scribe.ScribeDoc.defaults.usePDFText.native.main = true;
    scribe.ScribeDoc.defaults.keepPDFTextAlways = true;
    doc = await scribe.openDocument({ pdfFiles: [exportedPdf] });

    doc.ocr.active = doc.ocr.pdf;
    expect(doc.ocr.active.length, 'all 3 source pages survive the overlay round-trip').toBe(3);
    expect(
      countWords(doc.ocr.active),
      'annot mode must not emit a visible overlay text layer on top of the source text',
    ).toBe(1064);

    const page0Text = /** @type {string} */ (await doc.exportData('text', { minPage: 0, maxPage: 0 }));
    expect(page0Text, 'source page-0 text is preserved through the overlay round-trip').toContain('Iris');

    const highlights = doc.annotations.pages.flatMap((p) => p || []).filter((a) => a.type === 'highlight');
    expect(highlights.length, 'multi-line highlight did not consolidate to one annotation (word-level leak from the empty overlay page)').toBe(1);
    expect(highlights[0].quads.length, 'consolidated highlight lost its per-line quads (expected one per line, lines 0-2)').toBe(3);

    // The highlight now lives in both the source /Annots and the model, so export must drop the source copy or each round-trip doubles the count.
    // That only happens after a round-trip, so only this second export can catch the duplication.
    const reExportedPdf = /** @type {ArrayBuffer} */ (await doc.exportData('pdf'));
    await doc.clear();
    scribe.ScribeDoc.defaults.usePDFText.native.main = true;
    scribe.ScribeDoc.defaults.keepPDFTextAlways = true;
    doc = await scribe.openDocument({ pdfFiles: [reExportedPdf] });
    const reHighlights = doc.annotations.pages.flatMap((p) => p || []).filter((a) => a.type === 'highlight');
    expect(reHighlights.length, 'highlight duplicated on re-export: it survives in both the source /Annots and the model').toBe(1);
    expect(reHighlights[0].quads.length, 'consolidated highlight lost its per-line quads on the second round-trip').toBe(3);

    scribe.ScribeDoc.defaults.displayMode = 'invis';
    await doc.clear();
  });

  test('Human-readable text-only PDF has uncompressed content streams and hex-encoded fonts', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/text_simple.txt`]);

    scribe.ScribeDoc.defaults.displayMode = 'ebook';
    scribe.ScribeDoc.defaults.humanReadablePDF = true;
    const exportedPdf = /** @type {ArrayBuffer} */ (await doc.exportData('pdf'));
    scribe.ScribeDoc.defaults.humanReadablePDF = false;

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

    await doc.clear();
    scribe.ScribeDoc.defaults.usePDFText.native.main = true;
    scribe.ScribeDoc.defaults.keepPDFTextAlways = true;
    doc = await scribe.openDocument({ pdfFiles: [exportedPdf] });
    doc.ocr.active = doc.ocr.pdf;
    const reExportedText = await doc.exportData('text');
    expect(reExportedText).toBe('Tesseract.js');

    scribe.ScribeDoc.defaults.displayMode = 'invis';
    await doc.clear();
  });

  test('PDF export of encrypted source with proof overlay produces a valid (decrypted) PDF', async () => {
    scribe.ScribeDoc.defaults.usePDFText.native.main = true;
    scribe.ScribeDoc.defaults.keepPDFTextAlways = true;
    doc = await scribe.openDocument([`${ASSETS_PATH}/intel-history-1996-annual-report.pdf`]);

    expect(doc.inputData.pageCount).toBe(22);
    expect(doc.inputData.pdfType).toBe('text');

    scribe.ScribeDoc.defaults.displayMode = 'proof';
    scribe.ScribeDoc.defaults.addOverlay = true;
    const exportedPdf = /** @type {ArrayBuffer} */ (await doc.exportData('pdf'));
    expect(exportedPdf.byteLength).toBeGreaterThan(1000);

    // The output must not retain a reference to the source PDF's /Encrypt dict.
    // When /Encrypt stays in the trailer chain, PDF readers RC4-decrypt the
    // unencrypted overlay objects with the file key, garbling them and breaking
    // every page (zlib "incorrect header check" on every FlateDecode stream).
    const exportedText = new TextDecoder('latin1').decode(new Uint8Array(exportedPdf));
    expect(exportedText.includes('/Encrypt')).toBe(false);

    // Acrobat is stricter than Chrome/Firefox about font dict syntax: PDF arrays use
    // whitespace as separators, never commas, and the CIDFont subtype must match the
    // embedded font program (CIDFontType0 for OpenType-CFF "OTTO", CIDFontType2 for
    // OpenType-TrueType). Either mismatch will silently drop the overlay glyphs in
    // Acrobat while browsers still render them.
    expect(exportedText.includes('FontBBox[0, 0, 0, 0]')).toBe(false);
    expect(exportedText.includes('/Subtype/CIDFontType2')).toBe(false);
    expect(exportedText.includes('/Subtype/CIDFontType0')).toBe(true);

    // Every FlateDecode stream copied from the encrypted source must inflate cleanly under a strict zlib reader.
    // Pre-fix, the EOL-strip heuristic in extractRawStreamBytes truncated the last data byte of
    // nine 1px image XObjects whose deflate stream happened to end on 0x0A/0x0D.
    // Use Node's inflateSync (strict) since scribe's own inflate path is tolerant of truncated streams and would mask the bug.
    // Node-only: the bug under test is in the writer (platform-independent), so checking in Node is sufficient.
    if (isNode) {
      const { findXrefOffset, parseXref } = await import('../../js/pdf/parsePdfUtils.js');
      const { ObjectCache } = await import('../../js/pdf/objectCache.js');
      const { inflateSync } = await import('node:zlib');
      const exportBytes = new Uint8Array(exportedPdf);
      const xrefOffset = findXrefOffset(exportBytes);
      const xrefEntries = parseXref(exportBytes, xrefOffset);
      const objCache = new ObjectCache(exportBytes, xrefEntries);
      let inflatedCount = 0;
      const failures = [];
      for (const [k, entry] of Object.entries(xrefEntries)) {
        if (entry.type !== 1) continue;
        const objNum = Number(k);
        const objText = objCache.getObjectText(objNum);
        if (!objText || !/\/Filter\s*\/FlateDecode\b/.test(objText)) continue;
        const objStart = entry.offset;
        let p = objStart;
        while (p < exportBytes.length - 6 && !(
          exportBytes[p] === 0x73 && exportBytes[p + 1] === 0x74
          && exportBytes[p + 2] === 0x72 && exportBytes[p + 3] === 0x65
          && exportBytes[p + 4] === 0x61 && exportBytes[p + 5] === 0x6D
        )) p++;
        if (p >= exportBytes.length - 6) continue;
        let s = p + 6;
        if (exportBytes[s] === 0x0D && exportBytes[s + 1] === 0x0A) s += 2;
        else if (exportBytes[s] === 0x0A || exportBytes[s] === 0x0D) s += 1;
        const lengthMatch = /\/Length\s+(\d+)/.exec(objText);
        if (!lengthMatch) continue;
        const len = Number(lengthMatch[1]);
        const slice = exportBytes.subarray(s, s + len);
        try {
          inflateSync(Buffer.from(slice));
          inflatedCount++;
        } catch (e) {
          failures.push({ objNum, length: len, msg: e.message });
        }
      }
      expect(failures, `expected all FlateDecode streams to inflate; failures: ${JSON.stringify(failures.slice(0, 5))}`).toEqual([]);
      expect(inflatedCount).toBeGreaterThan(50);
    }

    await doc.clear();
    scribe.ScribeDoc.defaults.usePDFText.native.main = true;
    scribe.ScribeDoc.defaults.keepPDFTextAlways = true;
    doc = await scribe.openDocument({ pdfFiles: [exportedPdf] });

    expect(doc.inputData.pageCount).toBe(22);
    const page7Words = doc.ocr.pdf[7].lines.flatMap((l) => l.words.map((w) => w.text));
    expect(page7Words.slice(0, 5)).toEqual(['12', 'Intel', 'Corporation', '1996', 'www.intel.com']);

    scribe.ScribeDoc.defaults.displayMode = 'invis';
    scribe.ScribeDoc.defaults.usePDFText.native.main = false;
    scribe.ScribeDoc.defaults.keepPDFTextAlways = false;
    await doc.clear();
  });

  test('PDF overlay aligns with source text on pages where CropBox differs from MediaBox', async () => {
    // fti_filing_p25.pdf has CropBox [9 9 603 783] inside MediaBox [0 0 612 792]. The overlay
    // export must scale and offset relative to the CropBox (the visible region scribe rasterises
    // as 2475x3225 px), not the MediaBox — using MediaBox produces an overlay scaled ~1.03×
    // too large and translated to the MediaBox origin, so the proof-mode duplicates land off
    // the source text.
    scribe.ScribeDoc.defaults.usePDFText.native.main = true;
    scribe.ScribeDoc.defaults.keepPDFTextAlways = true;
    doc = await scribe.openDocument([`${ASSETS_PATH}/fti_filing_p25.pdf`]);

    expect(doc.inputData.pageCount).toBe(1);
    expect(doc.ocr.active[0].lines[0].words[0].text).toBe('UNITED');
    expect(doc.ocr.active[0].lines[0].words[0].bbox).toEqual({
      left: 1014, top: 83, right: 1234, bottom: 146,
    });

    scribe.ScribeDoc.defaults.displayMode = 'proof';
    scribe.ScribeDoc.defaults.addOverlay = true;
    const exportedPdf = /** @type {ArrayBuffer} */ (await doc.exportData('pdf'));

    await doc.clear();
    scribe.ScribeDoc.defaults.usePDFText.native.main = true;
    scribe.ScribeDoc.defaults.keepPDFTextAlways = true;
    doc = await scribe.openDocument({ pdfFiles: [exportedPdf] });

    // In proof mode the export keeps the source text and adds a coloured overlay copy.
    // Re-importing yields two "UNITED" words; they should sit at the same horizontal
    // position and approximately the same baseline. (The overlay uses scribe's NimbusRoman
    // metrics rather than the source's embedded font, so the bbox vertical extent differs
    // by a handful of pixels from font ascent/descent — this is not a positioning bug.)
    // Pre-fix the overlay was offset to (1007, 38, 1234, 118): dx=-7 px, dy=-45 px.
    const reImportedWords = doc.ocr.pdf[0].lines.flatMap((l) => l.words);
    const unitedWords = reImportedWords.filter((w) => w.text === 'UNITED');
    expect(unitedWords.length).toBe(2);
    const sortedByTop = unitedWords.slice().sort((a, b) => a.bbox.top - b.bbox.top);
    expect(sortedByTop[0].bbox).toEqual({
      left: 1014, top: 74, right: 1234, bottom: 152,
    });
    expect(sortedByTop[1].bbox).toEqual({
      left: 1014, top: 83, right: 1234, bottom: 146,
    });

    scribe.ScribeDoc.defaults.displayMode = 'invis';
    scribe.ScribeDoc.defaults.usePDFText.native.main = false;
    scribe.ScribeDoc.defaults.keepPDFTextAlways = false;
    await doc.clear();
  });

  test('Human-readable PDF with images hex-encodes image streams', async () => {
    scribe.ScribeDoc.defaults.displayMode = 'proof';
    scribe.ScribeDoc.defaults.humanReadablePDF = true;

    doc = await scribe.openDocument([`${ASSETS_PATH}/testocr.png`, `${ASSETS_PATH}/testocr.abbyy.xml`]);
    const exportedPdf = /** @type {ArrayBuffer} */ (await doc.exportData('pdf'));

    scribe.ScribeDoc.defaults.humanReadablePDF = false;

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

    await doc.clear();
  });

  test('Default (compressed) PDF with images embeds image streams as binary FlateDecode, not ASCIIHexDecode', async () => {
    // ASCIIHexDecode doubles every embedded image stream. It must be used only  under humanReadablePDF.
    // The default export embeds the raw binary image bytes under a single FlateDecode (PNG) / DCTDecode (JPEG) filter.
    scribe.ScribeDoc.defaults.displayMode = 'proof';
    scribe.ScribeDoc.defaults.humanReadablePDF = false;

    doc = await scribe.openDocument([`${ASSETS_PATH}/testocr.png`, `${ASSETS_PATH}/testocr.abbyy.xml`]);
    const exportedPdf = /** @type {ArrayBuffer} */ (await doc.exportData('pdf'));

    const pdfText = new TextDecoder('latin1').decode(new Uint8Array(exportedPdf));
    // The image is the only ASCIIHexDecode user in default mode, so none should remain.
    expect(pdfText).not.toContain('/ASCIIHexDecode');
    // The PNG image XObject carries a single binary FlateDecode filter.
    expect(pdfText).toMatch(/\/Subtype\s*\/Image[\s\S]{0,300}?\/Filter\s*\/FlateDecode\b/);

    await doc.clear();

    // The binary image stream must still decode to a non-blank page.
    const { dataUrl } = await renderPdfPage(new Uint8Array(exportedPdf), 0, 'color');
    const img = await ca.createImageBitmapFromData(dataUrlToPngBytes(dataUrl));
    const canvas = ca.makeCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    const seen = new Set();
    for (let i = 0; i < data.length; i += 1600) seen.add((data[i] + data[i + 1] + data[i + 2]) >> 2);
    expect(seen.size).toBeGreaterThanOrEqual(10);

    await doc.clear();
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check addHighlights and clearHighlights.', () => {
  test('Should import document for highlight tests', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/testocr_all_orientations.abbyy.xml`]);
    expect(doc.ocr.active.length).toBe(12);
    expect(doc.ocr.active[0].lines.length).toBe(8);
  });

  test('addHighlights with startLine/endLine creates one annotation per word on that line', async () => {
    const result = doc.addHighlights([{ page: 0, startLine: 0, endLine: 0 }]);
    expect(result.highlightsApplied).toBe(1);
    expect(result.totalLinesHighlighted).toBe(1);
    // Line 0 has 11 words: "This is a lot of 12 point text to test the"
    expect(doc.annotations.pages[0].length).toBe(11);
  });

  test('clearHighlights removes all programmatic highlights', async () => {
    doc.clearHighlights();
    expect(doc.annotations.pages[0].length).toBe(0);
  });

  test('addHighlights with text in quote-only mode highlights matching words', async () => {
    // "ocr code" matches 2 words on line 1
    const result = doc.addHighlights([{ page: 0, text: 'ocr code' }]);
    expect(result.highlightsApplied).toBe(1);
    expect(doc.annotations.pages[0].length).toBe(2);
    doc.clearHighlights();
  });

  test('addHighlights throws when neither startLine nor text is provided', async () => {
    expect(() => doc.addHighlights([{ page: 0 }])).toThrow(undefined);
  });

  test('addHighlights reports each applied highlight in groups with its union bbox (line mode)', async () => {
    doc.clearHighlights();
    const result = doc.addHighlights([{ page: 0, startLine: 0, endLine: 0 }]);
    expect(result.groups.length).toBe(1);
    expect(result.groups[0].page).toBe(0);
    expect(result.groups[0].groupId).toBe('hl-0');
    expect(result.groups[0].bbox).toEqual({
      left: 36, top: 92, right: 580, bottom: 122,
    });
    expect(doc.ocr.active[0].dims.height).toBe(480);
    const fracY = result.groups[0].bbox.top / doc.ocr.active[0].dims.height;
    expect(fracY).toBeCloseTo(0.1917, 4);
  });

  test('addHighlights groups: quote-only mode reports the bbox of the matched words', async () => {
    doc.clearHighlights();
    const result = doc.addHighlights([{ page: 0, text: 'ocr code' }]);
    expect(result.groups.length).toBe(1);
    expect(result.groups[0].groupId).toBe('hl-0');
    expect(result.groups[0].bbox).toEqual({
      left: 36, top: 126, right: 160, bottom: 150,
    });
  });

  // Rotated lines store word bboxes in scribe's internal "virtual horizontal" frame (see the page->virtual transform in parsePdfDoc.js).
  // A highlight annotation has no orientation, so its bbox must be the page-space inverse, or the highlight lands on empty space.
  // Pages 3/6/9 carry page 0's line 0 rotated to orientations 3/2/1.
  // Each expected bbox is the page-space inverse of page 0's line-mode group bbox {36, 92, 580, 122}.
  test('addHighlights emits rotated-line highlights in page space, not the virtual-horizontal frame', () => {
    const cases = [
      {
        page: 3,
        orientation: 3,
        expected: {
          left: 92, top: 60, right: 122, bottom: 604,
        },
      },
      {
        page: 6,
        orientation: 2,
        expected: {
          left: 60, top: 358, right: 604, bottom: 388,
        },
      },
      {
        page: 9,
        orientation: 1,
        expected: {
          left: 358, top: 36, right: 388, bottom: 580,
        },
      },
    ];
    for (const c of cases) {
      doc.clearHighlights();
      expect(doc.ocr.active[c.page].lines[0].orientation, `page ${c.page} orientation`).toBe(c.orientation);
      const result = doc.addHighlights([{ page: c.page, startLine: 0, endLine: 0 }]);
      expect(result.groups.length, `page ${c.page} group count`).toBe(1);
      expect(result.groups[0].bbox, `page ${c.page} bbox`).toEqual(c.expected);
    }
    doc.clearHighlights();
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
