import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { subsetPdf } from '../../js/export/pdf/subsetPdf.js';
import { mergePdfs } from '../../js/export/pdf/mergePdfs.js';
import { getMetadata } from '../../js/pdf/metadata/metadataInspect.js';
import { ca } from '../../js/canvasAdapter.js';
import { renderPdfPage } from '../_renderPdfPage.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';
import { strayFields } from './_ocrFields.js';

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
 * Read both elements of the output trailer's `/ID` array.
 * `getMetadata` reports only the first.
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {?[string, string]}
 */
function trailerIdPair(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const text = new TextDecoder('latin1').decode(bytes);
  const tail = text.slice(text.lastIndexOf('trailer'));
  const m = /\/ID\s*\[\s*<([0-9A-Fa-f]*)>\s*<([0-9A-Fa-f]*)>\s*\]/.exec(tail);
  return m ? [m[1], m[2]] : null;
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

    const freshId = trailerIdPair(exportedPdf);
    expect(freshId !== null, 'a freshly built PDF must carry a file identifier').toBe(true);
    expect(freshId[0], 'a first write must set both file identifier elements alike').toBe(freshId[1]);

    const freshText = new TextDecoder('latin1').decode(new Uint8Array(exportedPdf));
    const xrefOffset = Number(/startxref\s+(\d+)/.exec(freshText.slice(freshText.lastIndexOf('startxref')))[1]);
    const xrefHeader = /^xref\n(\d+) (\d+)\n/.exec(freshText.slice(xrefOffset));
    expect(xrefHeader && xrefHeader[1], 'a fresh build writes one cross-reference subsection starting at object 0').toBe('0');
    expect(xrefHeader[2], 'the cross-reference subsection must cover every object in the fresh build').toBe('318');
    const entriesStart = xrefOffset + xrefHeader[0].length;
    expect(freshText.indexOf('trailer', entriesStart) - entriesStart,
      'ISO 32000-2 7.5.4 requires every cross-reference entry to be exactly 20 bytes, so 318 entries occupy 6360').toBe(6360);

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
      comment: 'Flag this passage.',
      replies: [{ text: 'Flagged and cross-checked.', author: 'M. Vahl', createdAt: '2026-07-07T10:30:00.000Z' }],
    });
    doc.annotations.pages[0].push({
      type: 'underline',
      bbox: {
        left: 100, top: 400, right: 300, bottom: 420,
      },
      color: '#81c784',
      opacity: 1,
      groupId: 'test-export-2',
    });

    scribe.ScribeDoc.defaults.compressScribe = false;
    const scribeData = await doc.exportData('scribe');

    await doc.clear();

    const encoder = new TextEncoder();
    doc = await scribe.openDocument({ scribeFiles: [encoder.encode(scribeData).buffer] });

    expect(doc.annotations.pages[0].length, 'both the highlight and the underline survive the .scribe round-trip').toBe(2);
    expect(doc.annotations.pages[0][0].color).toBe('#ffff00');
    expect(doc.annotations.pages[0][0].opacity).toBe(0.35);
    expect(doc.annotations.pages[0][0].bbox.left).toBe(100);
    expect(doc.annotations.pages[0][0].bbox.right).toBe(300);
    expect(doc.annotations.pages[0][0].replies?.length, 'comment replies survive the .scribe round-trip').toBe(1);
    expect(doc.annotations.pages[0][0].replies?.[0].text, 'reply text survives the .scribe round-trip').toBe('Flagged and cross-checked.');
    expect(doc.annotations.pages[0][1].type, 'the underline keeps its markup type through the .scribe round-trip').toBe('underline');
    expect(doc.annotations.pages[0][1].color, 'the underline keeps its color through the .scribe round-trip').toBe('#81c784');
    expect(doc.annotations.pages[0][1].opacity, 'the underline keeps its opacity through the .scribe round-trip').toBe(1);

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

    for (const a of doc.annotations.pages[0]) {
      if (!(a.type == null || a.type === 'highlight')) continue;
      a.comment = 'Check the venue allegations against the exhibits.';
      a.author = 'J. Rondo';
      a.createdAt = '2026-07-06T09:00:00.000Z';
      a.replies = [
        { text: 'Exhibit 4 has the venue facts.', author: 'M. Vahl', createdAt: '2026-07-07T10:30:00.000Z' },
        { text: 'Scoped the claim to Exhibit 4.', author: 'J. Rondo', createdAt: '2026-07-08T16:45:00.000Z' },
      ];
    }
    doc.addTextAnnots([{
      page: 0,
      x: 500,
      y: 500,
      comment: 'Margins here are inconsistent with the exhibits.',
      author: 'J. Rondo',
      createdAt: '2026-07-06T09:00:00.000Z',
      replies: [{ text: 'The exhibits use the 2019 template.', author: 'M. Vahl', createdAt: '2026-07-07T11:00:00.000Z' }],
    }]);
    expect(doc.annotations.pages[0].length, 'the note annotation was added').toBe(47);

    // FreeText and shape annotations never write an author of their own, so their reply threads are the only place those types can leak identity through a sanitized export.
    const ftAnnot = /** @type {AnnotationFreeText} */ (doc.annotations.pages[0].find((a) => a.type === 'freetext'));
    ftAnnot.replies = [{ text: 'Confirmed against the caption block.', author: 'M. Vahl', createdAt: '2026-07-07T12:15:00.000Z' }];
    const squareAnnot = /** @type {AnnotationShapeStyle} */ (doc.annotations.pages[0].find((a) => a.type === 'square'));
    squareAnnot.comment = 'Venue paragraph boxed for review.';
    squareAnnot.replies = [{ text: 'Box the venue paragraph.', author: 'M. Vahl', createdAt: '2026-07-07T12:20:00.000Z' }];

    // The underline's groupId collides with the highlight's (both are the first group of their addHighlights call, `hl-0`), so these also guard against cross-type consolidation merges.
    // These carry no comments, replies, or authors, so the /IRT, warning, and sanitized-identity counts stay valid.
    doc.addHighlights([
      {
        page: 0, startLine: 3, endLine: 4, markup: 'underline', color: '#81c784',
      },
      {
        page: 0, text: 'billion in operating profit in the coming years.', markup: 'strikeout', color: '#e53935',
      },
    ]);
    // Lines 3-4 have 13 + 19 words, and the quote matches the 8 words of line 5.
    expect(doc.annotations.pages[0].length, 'the underline and strikeout emit one entry per word').toBe(87);

    // Exported before the malformed shape is injected below, so the skip-path warning count stays 1.
    const sanitizedBytes = await doc.exportData('pdf', { sanitize: true });

    // Inject a malformed shape past addShapes validation to exercise the export skip path.
    // @ts-expect-error - intentionally missing bbox.
    doc.annotations.pages[0].push({ type: 'square', borderColor: '#ff0000', borderWidth: 4 });
    const warnings = /** @type {string[]} */ ([]);
    const prevWarn = scribe.opt.warningHandler;
    scribe.opt.warningHandler = (msg) => warnings.push(msg);

    const pdfBytes = await doc.exportData('pdf');
    scribe.opt.warningHandler = prevWarn;

    // complaint_1's base MediaBox is 612x792 over 2550x3300 OCR space, so page coords scale by 0.24 and flip in y.
    const shapeText = new TextDecoder('latin1').decode(new Uint8Array(pdfBytes));
    expect(shapeText, 'the square border width is written in points, not pixel-frame units').toContain('/BS <</W 1.44>>');
    expect(shapeText).toContain('/Subtype /Square /Rect [46.56 634.56 289.44 733.44] /C [1 0 0]');
    expect(shapeText).toContain('/Subtype /Circle /Rect [334.56 562.56 505.44 733.44] /C [0 0 1] /IC [0 1 0] /CA 0.4');
    expect(shapeText).toContain('/Subtype /Line /Rect [45.6 525.6 554.4 530.4] /C [0 0 0]');
    expect(shapeText).toContain('/L [48 528 552 528]');
    expect(shapeText).toContain('/Subtype /Polygon /Rect [106.56 274.56 325.44 457.44] /C [1 0 1]');
    expect(shapeText).toContain('/Vertices [108 456 324 456 216 276]');
    // One /AP appearance Form XObject per shape; only the circle is filled (/IC).
    expect(shapeText.split('/Subtype /Form').length - 1).toBe(4);
    expect(shapeText.split('/IC ').length - 1).toBe(1);
    // The malformed square emitted nothing (only the one valid square is present) and was reported once.
    expect(shapeText.split('/Subtype /Square').length - 1).toBe(1);
    expect(warnings.filter((w) => w.includes('Skipped') && w.includes('square')).length).toBe(1);
    expect(shapeText.split('/IRT ').length - 1, 'each reply exports as a /Text annotation with /IRT').toBe(5);
    expect(shapeText.split('/Subtype /Underline').length - 1, 'the underline exports as a single consolidated /Underline annotation').toBe(1);
    expect(shapeText.split('/Subtype /StrikeOut').length - 1, 'the strikeout exports as a single consolidated /StrikeOut annotation').toBe(1);

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

    const underlines = all.filter((a) => a.type === 'underline');
    expect(underlines.length, 'the underline round-trips as one consolidated annotation, unmerged with the same-groupId highlight').toBe(1);
    expect(underlines[0].quads.length, 'the underline keeps one quad per line (lines 3-4)').toBe(2);
    expect(underlines[0].color, 'the underline color round-trips').toBe('#81c784');
    expect(underlines[0].opacity, 'the underline defaults to full opacity').toBe(1);
    const strikeouts = all.filter((a) => a.type === 'strikeout');
    expect(strikeouts.length, 'the strikeout round-trips as one consolidated annotation').toBe(1);
    expect(strikeouts[0].quads.length, 'the single-line strikeout quote keeps one quad').toBe(1);
    expect(strikeouts[0].color, 'the strikeout color round-trips').toBe('#e53935');
    expect(strikeouts[0].opacity, 'the strikeout defaults to full opacity').toBe(1);

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

    const ftReplies = ft.replies || [];
    expect(ftReplies.length, 'the FreeText comment thread round-trips through /IRT annots').toBe(1);
    expect(ftReplies[0].text, 'FreeText reply text survives').toBe('Confirmed against the caption block.');
    expect(ftReplies[0].author, 'FreeText reply author survives an unsanitized export').toBe('M. Vahl');
    expect(ftReplies[0].createdAt, 'FreeText reply creation date survives an unsanitized export').toBe('2026-07-07T12:15:00.000Z');

    // A shape comment that reaches the exported bytes but not the model leaves our own reader redrawing the box with none of its text.
    const squares = all.filter((a) => a.type === 'square');
    expect(squares.length, 'the square is lifted into the model on re-import, not left as opaque passthrough bytes').toBe(1);
    expect(squares[0].comment, 'the shape comment reaches the model, so the reader can show it').toBe('Venue paragraph boxed for review.');
    expect(squares[0].borderColor, 'the square border color round-trips').toBe('#ff0000');
    expect(squares[0].borderWidth, 'the square border width round-trips in the frame it was authored in').toBeCloseTo(6, 10);
    const sqReplies = squares[0].replies || [];
    expect(sqReplies.length, 'the shape comment thread round-trips through /IRT annots').toBe(1);
    expect(sqReplies[0].text, 'shape reply text survives').toBe('Box the venue paragraph.');
    expect(sqReplies[0].author, 'shape reply author survives an unsanitized export').toBe('M. Vahl');
    const circles = all.filter((a) => a.type === 'circle');
    expect(circles.length, 'the circle is lifted into the model on re-import').toBe(1);
    expect(circles[0].fillColor, 'the circle interior color round-trips').toBe('#00ff00');
    expect(circles[0].opacity, 'the circle opacity round-trips').toBe(0.4);
    expect(all.filter((a) => a.type === 'line').length, 'the line is lifted into the model on re-import').toBe(1);
    expect(all.filter((a) => a.type === 'polygon').length, 'the polygon is lifted into the model on re-import').toBe(1);

    const notes = all.filter((a) => a.type === 'text');
    expect(notes.length, 'the note annotation round-trips').toBe(1);
    expect(highlights[0].comment, 'the highlight comment round-trips').toBe('Check the venue allegations against the exhibits.');
    const hlReplies = highlights[0].replies || [];
    expect(hlReplies.length, 'the highlight comment thread round-trips through /IRT annots').toBe(2);
    expect(hlReplies[0].text, 'first reply text survives').toBe('Exhibit 4 has the venue facts.');
    expect(hlReplies[0].author, 'first reply author survives').toBe('M. Vahl');
    expect(hlReplies[0].createdAt, 'first reply creation date survives').toBe('2026-07-07T10:30:00.000Z');
    expect(hlReplies[1].text, 'replies stay in chronological order').toBe('Scoped the claim to Exhibit 4.');
    expect(hlReplies[1].author, 'second reply author survives').toBe('J. Rondo');
    const noteReplies = notes[0].replies || [];
    expect(noteReplies.length, 'the note thread round-trips').toBe(1);
    expect(noteReplies[0].text, 'note reply text survives').toBe('The exhibits use the 2019 template.');

    // Acrobat writes a follow-up as a reply to a reply, a nesting our own export never emits.
    const hlObjMatch = /(\d+) 0 obj\s*<<\/Type \/Annot \/Subtype \/Highlight/.exec(shapeText);
    expect(hlObjMatch, 'the exported highlight annotation object was found').toBeTruthy();
    const hlObjNum = Number(hlObjMatch[1]);
    const irtNeedle = `/IRT ${hlObjNum} 0 R`;
    const firstIrt = shapeText.indexOf(irtNeedle);
    const secondIrt = shapeText.indexOf(irtNeedle, firstIrt + 1);
    expect(secondIrt > 0, 'both highlight replies target the root').toBe(true);
    // Replies are emitted consecutively after their parent, so the first reply is hlObjNum + 1.
    const nestedNeedle = `/IRT ${hlObjNum + 1} 0 R`;
    expect(nestedNeedle.length, 'patched ref keeps byte length (xref offsets unchanged)').toBe(irtNeedle.length);
    const patchedStr = shapeText.slice(0, secondIrt) + nestedNeedle + shapeText.slice(secondIrt + irtNeedle.length);
    const patched = Uint8Array.from(patchedStr, (c) => c.charCodeAt(0));
    await doc.clear();
    doc = await scribe.openDocument({ pdfFiles: [patched.buffer] });
    const all2 = doc.annotations.pages.flatMap((p) => p || []);
    const hl2 = all2.filter((a) => a.type === 'highlight');
    expect(hl2.length, 'the highlight still imports from the patched file').toBe(1);
    expect((hl2[0].replies || []).length, 'a nested reply chain flattens into the root thread').toBe(2);
    expect((hl2[0].replies || [])[1]?.text, 'flattened thread keeps chronological order').toBe('Scoped the claim to Exhibit 4.');

    // A review-state annotation (ISO 32000-2 12.5.6.3) is a /Text with /IRT that records a status on the thread rather than a message in it.
    // Acrobat leaves its /Contents empty, so lifting one as a reply would destroy the state and inject a blank message.
    const replyKeys = '/Name /Comment /Open false /F 4';
    const stateKeys = '/StateModel/Marked/State/Marked';
    expect(stateKeys.length, 'patched keys keep byte length (xref offsets unchanged)').toBe(replyKeys.length);
    const stateObjStart = shapeText.indexOf(`${hlObjNum + 2} 0 obj`);
    expect(stateObjStart > 0, 'the second highlight reply object was found').toBe(true);
    const keysAt = shapeText.indexOf(replyKeys, stateObjStart);
    expect(keysAt > stateObjStart, 'the reply keys to overwrite were found').toBe(true);
    const stateStr = shapeText.slice(0, keysAt) + stateKeys + shapeText.slice(keysAt + replyKeys.length);
    const stateBytes = Uint8Array.from(stateStr, (c) => c.charCodeAt(0));
    await doc.clear();
    doc = await scribe.openDocument({ pdfFiles: [stateBytes.buffer] });
    const all3 = doc.annotations.pages.flatMap((p) => p || []);
    const hl3 = all3.filter((a) => a.type === 'highlight');
    expect(hl3.length, 'the highlight still imports from the state-patched file').toBe(1);
    expect((hl3[0].replies || []).length, 'a review-state annotation is not lifted into the thread as a reply').toBe(1);
    expect((hl3[0].replies || [])[0]?.text, 'the sibling state annotation leaves the real reply intact').toBe('Exhibit 4 has the venue facts.');
    expect(all3.filter((a) => a.type === 'text').length, 'a review-state annotation is not lifted as a standalone note').toBe(1);

    await doc.clear();
    doc = await scribe.openDocument({ pdfFiles: [new Uint8Array(sanitizedBytes).buffer] });
    const allS = doc.annotations.pages.flatMap((p) => p || []);
    const ftS = allS.filter((a) => a.type === 'freetext');
    expect(ftS.length, 'the FreeText annotation survives a sanitized export').toBe(1);
    const ftSReplies = ftS[0].replies || [];
    expect(ftSReplies.length, 'the FreeText thread survives a sanitized export').toBe(1);
    expect(ftSReplies[0].text, 'a sanitized export keeps the FreeText reply text').toBe('Confirmed against the caption block.');
    expect(ftSReplies[0].author, 'a sanitized export omits the FreeText reply author').toBe(undefined);
    expect(ftSReplies[0].createdAt, 'a sanitized export omits the FreeText reply timestamp').toBe(undefined);
    const hlS = allS.filter((a) => a.type === 'highlight');
    expect((hlS[0].replies || [])[0]?.author, 'a sanitized export omits the highlight reply author').toBe(undefined);
    const sqS = allS.filter((a) => a.type === 'square');
    expect(sqS.length, 'the square survives a sanitized export').toBe(1);
    expect((sqS[0].replies || [])[0]?.text, 'a sanitized export keeps the shape reply text').toBe('Box the venue paragraph.');
    expect((sqS[0].replies || [])[0]?.author, 'a sanitized export omits the shape reply author').toBe(undefined);
    const sanitizedText = new TextDecoder('latin1').decode(new Uint8Array(sanitizedBytes));
    expect(sanitizedText.split('/T <').length - 1, 'a sanitized export writes no annotation author anywhere').toBe(0);
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
    const fullExportPdf = /** @type {ArrayBuffer} */ (await doc.exportData('pdf', { docInfo: { Creator: 'scribe-test v1' } }));
    const fullExportSize = fullExportPdf.byteLength;

    const exportedPdf = /** @type {ArrayBuffer} */ (await doc.exportData('pdf', { minPage: 1, maxPage: 2 }));
    expect(exportedPdf.byteLength).toBeGreaterThan(1000);
    expect(exportedPdf.byteLength).toBeLessThan(fullExportSize);

    // The full export appends incrementally; the page subset forces the object-level rebuild.
    const fullMeta = getMetadata(new Uint8Array(fullExportPdf));
    expect(fullMeta.info?.Title, 'source /Info Title lost on an incremental overlay export').toBe('Iris (plant) - Wikipedia');
    expect(fullMeta.info?.Producer, 'source /Info Producer lost on an incremental overlay export').toBe('Skia/PDF m144');
    expect(fullMeta.info?.Creator, 'docInfo did not override the source /Info Creator').toBe('scribe-test v1');
    expect(fullMeta.docId, 'a source with no /ID must not gain one on the incremental path').toBe(null);

    const subsetMeta = getMetadata(new Uint8Array(exportedPdf));
    expect(subsetMeta.info?.Title, 'source /Info Title lost on a rebuild export').toBe('Iris (plant) - Wikipedia');
    expect(subsetMeta.info?.Producer, 'source /Info Producer lost on a rebuild export').toBe('Skia/PDF m144');
    expect(subsetMeta.info?.Creator, 'source /Info Creator lost on a rebuild export with no docInfo')
      .toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36');
    expect(subsetMeta.lang, 'catalog /Lang lost on a rebuild export').toBe('en');
    expect(subsetMeta.structTree, 'catalog /StructTreeRoot lost on a rebuild export').toBe(true);
    expect(subsetMeta.viewerPreferences, 'catalog /ViewerPreferences lost on a rebuild export').toBe(true);

    // A subset export writes twice: the rebuild mints an identifier, then the overlay updates its changing element.
    const subsetId = trailerIdPair(exportedPdf);
    expect(subsetId !== null, 'a rebuild export must write a file identifier').toBe(true);
    expect(subsetId.map((element) => element.length), 'each file identifier element must be 16 bytes of hex').toEqual([32, 32]);
    expect(subsetId[1] === subsetId[0], 'the changing /ID element must differ from the permanent one after the overlay update').toBe(false);

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
    const markupCount = () => doc.annotations.pages[0].filter((a) => a.type !== 'link').length;
    expect(markupCount(), 'addHighlights should emit one entry per native word for lines 0-2 (5 words)').toBe(5);
    doc.addHighlights([{
      page: 0, startLine: 3, markup: 'underline', color: '#81c784',
    }]);
    expect(markupCount(), 'the underline emits one entry per native word for line 3 (2 words)').toBe(7);

    doc.addLinks([
      {
        page: 0,
        bbox: {
          left: 200, top: 300, right: 600, bottom: 360,
        },
        dest: { pageIndex: 2, yFrac: 0.5 },
      },
      {
        page: 1,
        bbox: {
          left: 200, top: 300, right: 600, bottom: 360,
        },
        uri: 'https://example.com/added-by-test',
      },
    ]);
    const linkCount = (pages) => pages.flatMap((p) => p || []).filter((a) => a.type === 'link').length;
    expect(linkCount(doc.annotations.pages), 'addLinks adds two link annotations beside the 97 lifted source URI links').toBe(99);

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
    const underlines = doc.annotations.pages.flatMap((p) => p || []).filter((a) => a.type === 'underline');
    expect(underlines.length, 'the underline round-trips through the overlay path as one annotation, unmerged with the same-groupId highlight').toBe(1);
    expect(underlines[0].quads.length, 'the single-line underline keeps one quad').toBe(1);

    expect(linkCount(doc.annotations.pages), 'all 97 lifted source URI links plus the 2 added links survive the round-trip, un-duplicated').toBe(99);
    expect(
      doc.annotations.pages.map((p) => (p || []).filter((a) => a.type === 'link' && a.uri).length),
      'per-page URI link counts survive (43/25/29 from the source, plus the added page-1 link)',
    ).toEqual([43, 26, 29]);
    const firstUriLink = (doc.annotations.pages[0] || []).find((a) => a.type === 'link' && a.uri);
    expect(firstUriLink.uri, 'the first page-0 URI link keeps its exact target URL').toBe('https://en.wikipedia.org/wiki/Template:Taxonomy/Iris');
    const destLinks = (doc.annotations.pages[0] || []).filter((a) => a.type === 'link' && a.dest);
    expect(destLinks.length, 'the added internal link is the only dest link on page 0 (source internal links all dangle in this fixture)').toBe(1);
    expect(destLinks[0].dest.pageIndex, 'the added internal link still targets page 2 after the round-trip').toBe(2);
    expect(destLinks[0].dest.view, 'a yFrac-only added link exports as a page-level /Fit destination').toEqual(['Fit']);
    const addedUriLink = (doc.annotations.pages[1] || []).find((a) => a.type === 'link' && a.uri === 'https://example.com/added-by-test');
    expect(addedUriLink, 'the addLinks external link survives the round-trip with its exact URL').toBeTruthy();

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
    const reUnderlines = doc.annotations.pages.flatMap((p) => p || []).filter((a) => a.type === 'underline');
    expect(reUnderlines.length, 'underline duplicated on re-export: it survives in both the source /Annots and the model').toBe(1);
    expect(reUnderlines[0].quads.length, 'the underline lost its quad on the second round-trip').toBe(1);
    expect(linkCount(doc.annotations.pages), 'links duplicated or lost on re-export: each must survive as the lifted annotation only, with its source copy dropped').toBe(99);

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

    // This fixture carries both an XMP packet and an /ID, which a rebuild must not drop as a side effect.
    const exportedMeta = getMetadata(new Uint8Array(exportedPdf));
    expect(exportedMeta.docId, 'source /ID first element must be carried unchanged').toBe('<678EED841A000148BA25DAE34641AA49>');

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

  test('stripMetadata removes identifying metadata while text and page count survive re-import', async () => {
    // The metadata-strip export is a distinct operation from the overlay exports above, so this test opens the fixture itself rather than riding along.
    scribe.ScribeDoc.defaults.usePDFText.native.main = true;
    scribe.ScribeDoc.defaults.keepPDFTextAlways = true;

    const originalMeta = getMetadata(await readPdfBytes(`${ASSETS_PATH}/fti_filing_p25.pdf`));
    expect(originalMeta.info?.Author, 'fixture must carry an /Info author for the strip test to be meaningful').toBe('rr615379');
    expect(!!originalMeta.xmp.catalog, 'fixture must carry a document XMP packet').toBe(true);
    expect(originalMeta.priorRevisions, 'fixture must carry prior incremental-save revisions to strip').toBe(2);

    doc = await scribe.openDocument([`${ASSETS_PATH}/fti_filing_p25.pdf`]);
    const strippedBytes = new Uint8Array(await doc.stripMetadata());
    await doc.clear();

    const strippedMeta = getMetadata(strippedBytes);
    expect(strippedMeta.info, 'stripMetadata removes the /Info dictionary').toBe(null);
    expect(strippedMeta.docId, 'stripMetadata removes the /ID file identifier').toBe(null);
    expect(strippedMeta.xmp.catalog, 'stripMetadata removes the document XMP packet').toBe(null);
    expect(strippedMeta.xmp.perObject.length, 'stripMetadata removes per-object XMP packets').toBe(0);
    expect(strippedMeta.priorRevisions, 'stripMetadata collapses prior incremental-save revisions to one').toBe(1);

    doc = await scribe.openDocument({ pdfFiles: [strippedBytes.buffer] });
    expect(doc.inputData.pageCount, 'page count survives metadata strip').toBe(1);
    expect(doc.ocr.active[0].lines[0].words[0].text, 'body text survives metadata strip').toBe('UNITED');

    scribe.ScribeDoc.defaults.usePDFText.native.main = false;
    scribe.ScribeDoc.defaults.keepPDFTextAlways = false;
    await doc.clear();
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Redaction marks are applied destructively on export.', () => {
  // Redaction removes content from every export, so it cannot ride along on another test's round-trip without breaking that test's own assertions.
  /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
  let redactDoc;
  /** @type {string} */
  let redactTxt;
  /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
  let redactReimportDoc;
  /** @type {Uint8Array} */
  let redactPdfBytes;

  test('Should import document and export with a redaction mark applied', async () => {
    // Earlier tests in this file flip the shared defaults.
    // Quote-mode marking and the re-import check both read the PDF's native text.
    scribe.ScribeDoc.defaults.usePDFText.native.main = true;
    scribe.ScribeDoc.defaults.displayMode = 'invis';
    redactDoc = await scribe.openDocument([`${ASSETS_PATH}/academic_article_1.pdf`]);
    const res = redactDoc.addRedactions([{ page: 0, text: 'misrepresentation' }]);
    expect(res.marksAdded, 'quote-mode redaction marks the unique target word').toBe(1);
    // A pending replacement is drawn text a mark must catch too, on a line the assertions below ignore.
    // The mark sits past the record's erase rects, so it covers only the replacement's painted text.
    const editLine = redactDoc.ocr.active[0].lines.find((line) => line.words.map((w) => w.text).join(' ')
      .startsWith('latory enforcement action.'));
    const editBox = { ...editLine.bbox };
    await redactDoc.replaceTextLine(editLine, 'Short text REDLEAKSENTINEL REDLEAKSENTINEL REDLEAKSENTINEL REDLEAKSENTINEL REDLEAKSENTINEL');
    redactDoc.addRedactions([{
      page: 0,
      bbox: {
        left: editBox.right + 20,
        top: editBox.top - 8,
        right: redactDoc.ocr.active[0].dims.width - 10,
        bottom: editBox.bottom + 8,
      },
    }]);
    redactTxt = /** @type {string} */ (await redactDoc.exportData('txt'));
    const pdfBuf = /** @type {ArrayBuffer} */ (await redactDoc.exportData('pdf', { displayMode: 'invis', addOverlay: true }));
    redactPdfBytes = new Uint8Array(pdfBuf);
    redactReimportDoc = await scribe.openDocument({ pdfFiles: [pdfBuf] });
    expect(redactReimportDoc.inputData.pageCount, 'redacted export re-imports as a 1-page PDF').toBe(1);
  });

  test('the marked word is removed from the txt export and its neighbors survive', () => {
    expect(redactTxt.includes('misrepresentation'), 'redacted word must not reach the txt export').toBe(false);
    expect(redactTxt.includes('cial since the passage of the Sarbanes-Oxley Act of'), 'words around the redacted word must survive').toBe(true);
  });

  test('the marked word is not extractable from the exported PDF', () => {
    const words = [];
    for (const line of redactReimportDoc.ocr.active[0].lines) for (const w of line.words) words.push(w.text);
    expect(words.includes('misrepresentation'), 'redacted word must not be extractable from the exported PDF').toBe(false);
    expect(words.includes('passage'), 'neighboring word must survive in the exported PDF').toBe(true);
    expect(words.length, 'exact word count of the redacted page on re-import').toBe(484);
  });

  test('replacement text drawn into a mark is dropped from the exported PDF', () => {
    const words = [];
    for (const line of redactReimportDoc.ocr.active[0].lines) for (const w of line.words) words.push(w.text);
    expect(words.includes('REDLEAKSENTINEL'), 'a pending replacement painted into a redaction mark reached the exported PDF').toBe(false);
    expect(words.includes('latory'), 'the replaced line\'s original text survived the export').toBe(false);
  });

  test('the exported PDF contains no /Redact annotation and no raw copy of the word', () => {
    let raw = '';
    for (let i = 0; i < redactPdfBytes.length; i++) raw += String.fromCharCode(redactPdfBytes[i]);
    expect(/\/Subtype\s*\/Redact\b/.test(raw), 'marks are applied at export, never written as /Redact annots').toBe(false);
    expect(raw.includes('misrepresentation'), 'redacted word must not appear in the raw output bytes').toBe(false);
  });

  test('the live document keeps the word and the editable mark (apply-at-export)', () => {
    const words = [];
    for (const line of redactDoc.ocr.active[0].lines) for (const w of line.words) words.push(w.text);
    expect(words.includes('misrepresentation'), 'live document must keep the word after export').toBe(true);
    expect(redactDoc.annotations.pages[0].filter((a) => a.type === 'redact').length, 'live document must keep the redaction marks after export').toBe(2);
    redactDoc.removeRedactions();
    expect(redactDoc.annotations.pages[0].filter((a) => a.type === 'redact').length, 'removeRedactions clears the mark').toBe(0);
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

describe('Check intra-word style runs survive a visible-text PDF export -> import round-trip.', () => {
  beforeAll(async () => {
    scribe.ScribeDoc.defaults.usePDFText.native.main = true;
    doc = await scribe.openDocument([`${ASSETS_PATH}/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.pdf`]);

    // No committed asset has a dash-joined style flip, so one word is rewritten in place to cover that case.
    // The bbox is narrowed to the new text's natural width, since the wider original makes the export letter-space the word enough for the reimporter to split it.
    const craft = doc.ocr.active[1].lines[18].words[3];
    craft.text = 'alpha—beta';
    craft.style.italic = true;
    craft.styleRuns = [{ i: 6, style: { italic: false } }];
    craft.chars = null;
    craft.bbox = {
      left: 604, top: 2255, right: 839, bottom: 2311,
    };

    scribe.ScribeDoc.defaults.displayMode = 'ebook';
    const pdfData = await doc.exportData('pdf');
    scribe.ScribeDoc.defaults.displayMode = 'invis';
    await scribe.terminate();
    doc = await scribe.openDocument({ pdfFiles: [pdfData] });
  });

  test('Non-italic trailing comma of the italic citation survives as a style run', () => {
    const words = doc.ocr.active[0].lines[30].words;
    expect(words[10].text, 'mixed-style word changed on visible-text PDF round-trip').toBe('Ltd.,');
    expect(words[10].style.italic, 'italic body style lost on visible-text PDF round-trip').toBe(true);
    expect(words[10].styleRuns, 'intra-word style run lost on visible-text PDF round-trip').toEqual([{ i: 4, style: { italic: false } }]);
    expect(words[11].text, 'word after the mixed-style word changed on visible-text PDF round-trip').toBe('Case');
    expect(words[11].styleRuns, 'uniform-style word should carry no style runs after PDF round-trip').toBeUndefined();
  });

  test('Dash-joined style flip stays one word with the non-italic half captured as a style run', () => {
    const words = doc.ocr.active[1].lines[18].words;
    expect(words[3].text, 'dash-joined mixed-style token split or corrupted on PDF round-trip').toBe('alpha—beta');
    expect(words[3].style.italic, 'italic first half lost on the dash-joined token').toBe(true);
    expect(words[3].styleRuns, 'style flip at the dash not captured on PDF round-trip').toEqual([{ i: 6, style: { italic: false } }]);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

// Deleting a line is a destructive edit, so this feature gets its own round-trip instead of riding an existing one.
describe('Check native text line deletion and replacement survive .scribe persistence and apply on PDF export.', () => {
  const lineText = (line) => line.words.map((x) => x.text).join(' ');

  /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
  let restoredDoc;
  /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
  let reDoc;
  let strays;
  let standardObj;
  let sessionObj;

  beforeAll(async () => {
    scribe.ScribeDoc.defaults.usePDFText.native.main = true;
    const srcDoc = await scribe.openDocument([`${ASSETS_PATH}/Iris (plant) - Wikipedia_123.pdf`]);
    const target = srcDoc.ocr.active[0].lines.find((line) => lineText(line) === 'Three Iris varieties are used in the Iris flower data set');
    await srcDoc.replaceTextLine(target, 'Several Iris varieties are used in the Iris flower data set');
    srcDoc.deleteTextLines([srcDoc.ocr.active[0].lines[21]]);
    strays = strayFields(srcDoc);
    standardObj = JSON.parse(/** @type {string} */ (await srcDoc.exportData('scribe', { compressScribe: false })));
    sessionObj = JSON.parse(/** @type {string} */ (await srcDoc.exportData('scribe', { compressScribe: false, scribeSession: true })));
    const scribeData = await srcDoc.exportData('scribe', { scribeSession: true });
    await srcDoc.close();
    restoredDoc = await scribe.openDocument({ scribeFiles: [scribeData] });
    const pdfData = await restoredDoc.exportData('pdf');
    reDoc = await scribe.openDocument({ pdfFiles: [pdfData] });
  });

  test('Edited pages leave no undeclared fields on OCR words or chars', () => {
    expect(strays.word, 'edit-time data was stamped onto OcrWord, so it serializes into every .scribe export').toEqual([]);
    expect(strays.char, 'edit-time data was stamped onto OcrChar, so it serializes into every .scribe export').toEqual([]);
  });

  test('Standard .scribe carries no app session data while the session save carries it all', () => {
    expect(Object.keys(standardObj).sort(), 'the standard .scribe export grew an undocumented top-level field')
      .toEqual(['annotations', 'fontState', 'inputData', 'layoutDataTables', 'layoutRegions', 'ocr', 'outline', 'pageRotations', 'pageSourceIndices']);
    expect(sessionObj.session?.v, 'the session block is missing from a session save').toBe(1);
    expect(sessionObj.session?.textEdits?.[0]?.length, 'edit records are missing from the session block').toBe(2);
    expect(sessionObj.session?.nativeText?.length, 'per-page native-text metadata is missing from the session block').toBe(3);
    expect(Object.keys(sessionObj.session?.nativeText?.[0] || {}).length, 'native-text entries were lost from the edited page\'s session block').toBe(228);
  });

  test('Deleted line, replaced line, and their edit records survive the .scribe round-trip', () => {
    const page = restoredDoc.ocr.active[0];
    expect(page.lines.length, 'the deleted line returned to the restored model').toBe(43);
    expect(page.lines.some((line) => lineText(line).includes('As well as being the scientific name')),
      'the deleted line\'s text reappeared in the restored model').toBe(false);
    expect(lineText(page.lines[20]), 'the line above the deletion changed on .scribe restore')
      .toBe('Iris is a flowering plant genus of 310 accepted species [1] with');
    expect(lineText(page.lines[21]), 'the line below the deletion changed on .scribe restore')
      .toBe('widely used as a common name for all Iris species, as well as');
    expect(lineText(page.lines[30]), 'the replaced line\'s corrected text was lost on .scribe restore')
      .toBe('Several Iris varieties are used in the Iris flower data set');
    expect(restoredDoc.textEdits.pages[0].length, 'a pending edit record was lost on .scribe restore').toBe(2);
    expect(restoredDoc.textEdits.pages[0][0].type, 'the restored replacement record changed type').toBe('replaceText');
    expect(restoredDoc.textEdits.pages[0][0].runs.length, 'the restored replacement record lost its draw-spec runs').toBe(11);
    expect(restoredDoc.textEdits.pages[0][0].rects.length, 'the restored replacement record lost its per-word rects').toBe(11);
    expect(restoredDoc.textEdits.pages[0][1].type, 'the restored deletion record changed type').toBe('deleteText');
    expect(restoredDoc.textEdits.pages[0][1].rects.length, 'the restored deletion record lost its per-word rects').toBe(12);
    expect(restoredDoc.textEdits.pages[0][1].glyphs.length, 'the restored deletion record lost its glyph identities, so its rects would strike overlapping layers geometrically').toBe(12);
  });

  test('Deleted line is gone from the exported PDF while its neighbors survive intact', () => {
    expect(reDoc.ocr.active.length, 'page count changed on export with a pending deletion').toBe(3);
    const page = reDoc.ocr.active[0];
    expect(page.lines.length, 'the deleted line still exports to the PDF').toBe(43);
    expect(page.lines.some((line) => lineText(line).includes('As well as being the scientific name')),
      'the deleted line\'s text is still in the exported PDF').toBe(false);
    expect(lineText(page.lines[20]), 'the line above the deletion was damaged by the export')
      .toBe('Iris is a flowering plant genus of 310 accepted species [1] with');
    expect(lineText(page.lines[21]), 'the line below the deletion was damaged by the export')
      .toBe('widely used as a common name for all Iris species, as well as');
    expect(lineText(reDoc.ocr.active[1].lines[0]), 'an untouched page was damaged by the export')
      .toBe('Hermodactyloides');
  });

  test('Replaced line exports its corrected text in place with intact neighbors', () => {
    const page = reDoc.ocr.active[0];
    expect(lineText(page.lines[30]), 'the replacement text does not extract in place from the exported PDF')
      .toBe('Several Iris varieties are used in the Iris flower data set');
    expect(page.lines.some((line) => lineText(line).includes('Three Iris')),
      'the replaced word\'s original text is still in the exported PDF').toBe(false);
    expect(lineText(page.lines[29]), 'the line above the replacement was damaged by the export')
      .toBe('dichotoma) are currently included in Iris.');
    expect(lineText(page.lines[31]), 'the line below the replacement was damaged by the export')
      .toBe('outlined by Ronald Fisher in his 1936 paper The use of');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

// This needs its own round-trip because no other committed fixture has overlapping text layers.
// The asset stacks three complete web-article PDFs: pages 0-2 hold the menu and banner overlaps, pages 3-7 the faux-bold ghost copies, and pages 8-14 the white halo copies.
// The halo fonts on pages 8-14 have an em box far larger than the deletion band, which is the geometry a size-capped strike wrongly spares.
describe('Check deleting one of two visually-overlapping text layers removes only that layer on PDF export.', () => {
  const lineText = (line) => line.words.map((x) => x.text).join(' ');

  /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
  let reDoc;

  beforeAll(async () => {
    scribe.ScribeDoc.defaults.usePDFText.native.main = true;
    const editDoc = await scribe.openDocument([`${ASSETS_PATH}/online-articles-text-overlap.pdf`]);
    const find = (n, prefix) => {
      const line = editDoc.ocr.active[n].lines.find((l) => lineText(l).startsWith(prefix));
      if (!line) throw new Error(`fixture line not found on page ${n}: ${prefix}`);
      return line;
    };
    // A plain line with no overlapping layer.
    editDoc.deleteTextLines([find(1, 'Bais Naftoli honored Baca')]);
    // The banner overprints two body lines in its own font, and the nav menu overprints one of those lines in a different font.
    editDoc.deleteTextLines([find(1, 'SUPPORT THE JEWISH JOURNAL')]);
    editDoc.deleteTextLines([find(1, 'HOME NEWS OPINION HOLLYWOOD CULTURE BLOG')]);
    // Both target lines have a coincident faux-bold second draw the deletion must fold.
    editDoc.deleteTextLines([find(6, 'SFGate Screen Name:')]);
    editDoc.deleteTextLines([find(6, 'Sign On to post your comment.')]);
    // The sentence carries six white halo copies of its bold phrase, all of which must fold.
    editDoc.deleteTextLines([find(8, 'Justice made public this month')]);
    const pdfData = await editDoc.exportData('pdf');
    await editDoc.close();
    reDoc = await scribe.openDocument({ pdfFiles: [pdfData] });
  });

  afterAll(async () => {
    await reDoc.close();
  });

  test('A plain non-overlapping line deletes cleanly with intact neighbors', () => {
    const lines = reDoc.ocr.active[1].lines.map(lineText);
    expect(lines.some((t) => t.includes('Bais Naftoli honored Baca')), 'the deleted plain line is still in the exported PDF').toBe(false);
    expect(lines.some((t) => t === '50 years of service to the county community and for his longstanding friendship to'),
      'a neighbor of the deleted plain line was damaged').toBe(true);
  });

  test('Body text survives deleting the different-font menu printed across it', () => {
    const lines = reDoc.ocr.active[1].lines.map(lineText);
    expect(lines.some((t) => t.includes('HOME NEWS OPINION HOLLYWOOD CULTURE BLOG')), 'the deleted menu line is still in the exported PDF').toBe(false);
    expect(lines.some((t) => t === 'what fate may await him. The 74-year-old member of the Catholic community said'),
      'the body line under the deleted menu was co-deleted').toBe(true);
  });

  test('Body text survives deleting a same-font banner printed over it', () => {
    const lines = reDoc.ocr.active[1].lines.map(lineText);
    expect(lines.some((t) => t.includes('SUPPORT THE JEWISH JOURNAL')), 'the deleted banner line is still in the exported PDF').toBe(false);
    expect(lines.some((t) => t === 'Actress Zooey Deschanel converts to Judaism'),
      'the headline under the deleted same-font banner was co-deleted').toBe(true);
    expect(lines.some((t) => t === 'what fate may await him. The 74-year-old member of the Catholic community said'),
      'the body line under the deleted same-font banner was co-deleted').toBe(true);
  });

  test('Faux-bold ghost copies fold with the deleted text and merged real text survives', () => {
    const lines = reDoc.ocr.active[6].lines.map(lineText);
    expect(lines.some((t) => t.includes('SFGate Screen Name:')), 'the deleted line is still in the exported PDF').toBe(false);
    expect(lines.some((t) => t.includes('SF ate Sc een Name:')), 'the faux-bold ghost copy was stranded by the deletion').toBe(false);
    expect(lines.some((t) => t.includes('Sign On to post')), 'the deleted comment-prompt line is still in the exported PDF').toBe(false);
    expect(lines.some((t) => t.includes('yo omm t')), 'the merged ghost copy was stranded by the deletion').toBe(false);
    expect(lines.some((t) => t.includes('Not Registered?')), 'real text sharing a line with a ghost copy was co-deleted').toBe(true);
  });

  test('White text-shadow halo copies fold with the deleted sentence', () => {
    const lines = reDoc.ocr.active[8].lines.map(lineText);
    expect(lines.some((t) => t.includes('Justice made public')), 'the deleted sentence is still in the exported PDF').toBe(false);
    expect(lines.some((t) => t.includes('antit ust lawsuit') || t.includes('antitrust lawsu it')),
      'a hidden white halo copy of the deleted sentence was stranded').toBe(false);
    expect(lines.some((t) => t.includes('against the company; the government redacted how')),
      'the line after the deleted sentence was co-deleted').toBe(true);
  });
});

// The replacement pipeline must carry the source's faux-bold stroke state, or every edited word visibly thins in the raster and the exported file.
// The fixture's DFKaiShu does not self-report bold, so the re-imported bold flag regresses too when the stroke is dropped.
// This needs its own round-trip: no other committed round-trip imports stroked text, and the edit is destructive.
describe('Check faux-bold (stroked) native text keeps its weight through edit and PDF export.', () => {
  const lineText = (line) => line.words.map((x) => x.text).join(' ');

  /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
  let editDoc;
  /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
  let editReDoc;
  /** @type {string} */
  let exportRaw;
  /** @type {number} */
  let inkOriginal;
  /** @type {number} */
  let inkRedrawn;
  /** @type {number} */
  let inkPlainTwin;
  /** @type {number} */
  let inkBoldToggled;
  /** @type {number} */
  let inkAppended;

  /**
   * Dark pixels inside a page-px bbox of a rendered page data URL, composited on white.
   * @param {string} dataUrl
   * @param {bbox} box
   * @param {{width: number, height: number}} dims
   */
  const inkInBox = async (dataUrl, box, dims) => {
    const img = await ca.createImageBitmapFromData(dataUrlToPngBytes(dataUrl));
    const sx = img.width / dims.width;
    const sy = img.height / dims.height;
    const x = Math.floor(box.left * sx) - 2;
    const y = Math.floor(box.top * sy) - 2;
    const w = Math.ceil((box.right - box.left) * sx) + 4;
    const h = Math.ceil((box.bottom - box.top) * sy) + 4;
    const canvas = ca.makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 128) ink += 1;
    }
    return ink;
  };

  beforeAll(async () => {
    scribe.ScribeDoc.defaults.usePDFText.native.main = true;
    // Uncompressed streams let the splice assertions read the replacement's drawing state directly.
    scribe.ScribeDoc.defaults.humanReadablePDF = true;
    editDoc = await scribe.openDocument([`${ASSETS_PATH}/chi_eng_mixed_sample.pdf`]);
    const page = editDoc.ocr.active[0];
    const line = page.lines[2];
    // 隔 already appears stroked at word 13 of the same line, so the redrawn glyph's weight can be compared against an untouched copy in the same render.
    await editDoc.replaceTextLine(line, line.words.map((w, i) => (i === 18 ? '隔' : w.text)).join(' '));
    // A second edit of the same line folds the first record, so word 18 now redraws from its post-edit entry rather than the source stream.
    await editDoc.replaceTextLine(line, line.words.map((w, i) => (i === 21 ? '利' : w.text)).join(' '));
    // Style-only toggles on plain words: bold synthesizes the faux-bold stroke, italic synthesizes the standard shear.
    const boldLine = page.lines[18];
    await editDoc.replaceTextLine(boldLine, lineText(boldLine), { wordStyles: boldLine.words.map((w, i) => (i === 4 ? { bold: true } : null)) });
    const italicLine = page.lines[17];
    await editDoc.replaceTextLine(italicLine, lineText(italicLine), { wordStyles: italicLine.words.map((w, i) => (i === 4 ? { italic: true } : null)) });
    // A word appended past the line's last word erases nothing, so its record carries no rects.
    const appendLine = page.lines[4];
    await editDoc.replaceTextLine(appendLine, `${lineText(appendLine)} APPENDSENTINEL`);
    if (isNode) {
      const img = await editDoc.images.getNative(0, { rotated: false, upscaled: false });
      inkOriginal = await inkInBox(img.src, line.words[13].bbox, page.dims);
      inkRedrawn = await inkInBox(img.src, line.words[18].bbox, page.dims);
      inkPlainTwin = await inkInBox(img.src, italicLine.words[0].bbox, page.dims);
      inkBoldToggled = await inkInBox(img.src, boldLine.words[4].bbox, page.dims);
      inkAppended = await inkInBox(img.src, appendLine.words[appendLine.words.length - 1].bbox, page.dims);
    }
    const pdfData = /** @type {ArrayBuffer} */ (await editDoc.exportData('pdf'));
    exportRaw = new TextDecoder('latin1').decode(new Uint8Array(pdfData));
    editReDoc = await scribe.openDocument({ pdfFiles: [pdfData] });
  });

  test('Replaced word extracts in place from the exported PDF with its faux-bold neighbors intact', () => {
    expect(lineText(editReDoc.ocr.active[0].lines[2]), 'the replacement text does not extract in place from the exported PDF')
      .toBe('嚴 重 特 殊 傳 染 性 肺 炎 指 定 處 所 隔 離 通 知 書 隔 提 審 利 利 告 知');
  });

  test('Replaced word re-imports as bold like the stroked text it replaced', () => {
    const words = editReDoc.ocr.active[0].lines[2].words;
    expect(words[18].style.bold, 'the folded first edit lost the faux-bold (render mode 2) weight on export').toBe(true);
    expect(words[21].style.bold, 'the second edit lost the faux-bold (render mode 2) weight on export').toBe(true);
    expect(words[13].style.bold, 'an untouched faux-bold word lost its weight on export').toBe(true);
  });

  test('Redrawn glyph keeps the original faux-bold ink weight in the rendered raster', () => {
    if (!isNode) return;
    // An exact pixel count would pin the renderer's antialiasing, not the invariant; the band asserts equal weight within AA noise.
    // Fill-only drawing of this glyph measures ~0.59 of the stroked original's ink.
    const ratio = inkRedrawn / inkOriginal;
    expect(ratio, 'the redrawn glyph renders lighter than the untouched copy of the same stroked glyph').toBeGreaterThan(0.9);
    expect(ratio, 'the redrawn glyph renders heavier than the untouched copy of the same stroked glyph').toBeLessThan(1.15);
  });

  test('Exported replacement draws with the original stroke state', () => {
    const tfIdx = exportRaw.indexOf('/EDF0 1 Tf');
    expect(tfIdx !== -1, 'the replacement splice is missing from the exported PDF').toBe(true);
    const body = exportRaw.slice(exportRaw.lastIndexOf('0 Tc 0 Tw 100 Tz 0 Tr 0 Ts', tfIdx), tfIdx);
    expect(body.includes('2 Tr'), 'the exported replacement must draw fill+stroke (2 Tr) like the stroked original').toBe(true);
    // The source pen is 0.456; the page-pixel frame the runs live in quantizes it by <0.1%.
    expect(body.includes('0.455908 w'), 'the original stroke width must round-trip into the exported replacement').toBe(true);
    expect(body.includes('0 0 0 RG'), 'the original stroke color must round-trip into the exported replacement').toBe(true);
  });

  test('Bold toggle on a plain word re-imports as bold and draws heavier than its plain twin', () => {
    const line = editReDoc.ocr.active[0].lines[18];
    expect(lineText(line), 'the bold-toggled line must keep its text in place')
      .toBe('public, please comply with the following regulations regarding designated residence isolation (home');
    expect(line.words[4].style.bold, 'a bold toggle on plain native text must survive export and re-import').toBe(true);
    expect(line.words[3].style.bold, 'a neighbor of the bold-toggled word must stay plain').toBe(false);
    if (!isNode) return;
    // The toggled "the" is compared against the untouched "the" one line up at the same size; a plain redraw would measure ~1.0.
    const ratio = inkBoldToggled / inkPlainTwin;
    expect(ratio, 'the bold-toggled word must draw heavier than its plain twin').toBeGreaterThan(1.15);
    expect(ratio, 'the bold-toggled word must stay in faux-bold range, not double weight').toBeLessThan(1.9);
  });

  test('Word appended past the end of a line survives export and draws in the raster', () => {
    expect(lineText(editReDoc.ocr.active[0].lines[4]), 'a pure-append replacement must extract in place from the exported PDF')
      .toBe('and Right to Petition for Habeas Corpus Relief APPENDSENTINEL');
    if (!isNode) return;
    // The appended word measures ~13100 ink px when drawn; an exact count would pin antialiasing, and near zero means it was dropped.
    expect(inkAppended, 'a pure-append replacement must draw in the rendered raster').toBeGreaterThan(6500);
  });

  test('Italic toggle on a plain word re-imports as italic with the synthesized shear', () => {
    const line = editReDoc.ocr.active[0].lines[17];
    expect(lineText(line), 'the italic-toggled line must keep its text in place')
      .toBe('the spread of the disease and protect the health and safety of your friends, family members and the');
    expect(line.words[4].style.italic, 'an italic toggle on plain native text must survive export and re-import').toBe(true);
    expect(line.words[3].style.italic, 'a neighbor of the italic-toggled word must stay upright').toBe(false);
    const entry = editReDoc.nativeText.pages[0][line.words[4].id];
    expect(entry && entry.skew && entry.skew[0], 'the synthesized shear ratio must round-trip through the exported text matrix').toBe(0.25);
  });

  test('Style-only toggles draw the synthesized stroke and shear in the export splice', () => {
    // Synthesized pen: 0.025 em at the word's 50px size, converted to content units like the captured stroke above.
    expect(exportRaw.includes('0.29994 w'), 'the synthesized faux-bold pen width is missing from the export splice').toBe(true);
    // Sheared Tm: the up-column picks up 0.25 of the flow vector.
    expect(exportRaw.includes('11.997582 0 2.999395 12 '), 'the synthesized shear is missing from the exported text matrix').toBe(true);
  });

  afterAll(async () => {
    scribe.ScribeDoc.defaults.humanReadablePDF = false;
    await scribe.terminate();
  });
});

// The overlay export wrapped the invisible text layer in a scale-only cm while keeping the page's /Rotate, so the layer sat 90 degrees out of alignment and body text selected bottom-to-top.
// Page 1 of the fixture is the reported shape: upright body text on a /Rotate 90 page, plus a genuinely sideways margin line.
describe('Check invisible text layer orientation on source pages with /Rotate.', () => {
  const lineText = (line) => line.words.map((x) => x.text).join(' ');

  /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
  let doc;
  /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
  let reDoc;
  /** @type {ArrayBuffer} */
  let exportedBytes;

  beforeAll(async () => {
    doc = await scribe.openDocument([
      `${ASSETS_PATH}/CSF_Proposed_Budget_Book_June_2024_r8_30_all_orientations.pdf`,
      `${ASSETS_PATH}/CSF_Proposed_Budget_Book_June_2024_r8_30_all_orientations.abbyy.xml`,
    ]);
    const out = /** @type {ArrayBuffer} */ (await doc.exportData('pdf', {
      displayMode: 'invis', addOverlay: true, minPage: 1, maxPage: 1,
    }));
    exportedBytes = out;
    reDoc = await scribe.openDocument({ pdfFiles: [out] });
    await reDoc.textReady;
  });

  test('Document metadata survives a page-subset rebuild', () => {
    const meta = getMetadata(new Uint8Array(exportedBytes));
    expect(meta.info?.Producer, 'source /Info Producer lost on a page-subset rebuild').toBe('Adobe PDF Library 17.0');
    expect(meta.info?.Creator, 'source /Info Creator lost on a page-subset rebuild').toBe('Adobe InDesign 19.4 (Macintosh)');

    expect(meta.docId, 'source /ID first element must be carried unchanged through a rebuild').toBe('<425F4742D93EEB4A910796B59A49E64B>');
    const idPair = trailerIdPair(exportedBytes);
    expect(idPair !== null, 'a rebuild export must write a file identifier').toBe(true);
    expect(idPair[1] === idPair[0], 'the changing /ID element must differ from the permanent one after an edit').toBe(false);
  });

  test('OCR text over a /Rotate source page imports in the display frame', async () => {
    const page = doc.ocr.active[1];

    const body = page.lines.filter((line) => lineText(line) === 'Mayor');
    expect(body.length, 'the body line "Mayor" imports as one line over a /Rotate page').toBe(1);
    expect(body[0].orientation, 'upright body text imports at orientation 0 over a /Rotate page').toBe(0);

    const margin = page.lines.filter((line) => lineText(line) === 'SAN FRANCISCO: AN OVERVIEW');
    expect(margin.length, 'the sideways margin line imports as one line over a /Rotate page').toBe(1);
    expect(margin[0].orientation, 'the sideways margin line imports at orientation 1 over a /Rotate page').toBe(1);
  });

  test('Invisible text layer is written at display orientation on a /Rotate page', async () => {
    const page = reDoc.ocr.active[0];
    expect(page !== undefined, 'the exported page re-imports with a readable text layer').toBe(true);

    const body = page.lines.filter((line) => lineText(line) === 'Mayor');
    expect(body.length, 'body line "Mayor" appears in both the source text and the invisible layer').toBe(2);
    for (const line of body) {
      expect(line.orientation, 'body text must display upright, not rotated with the page\'s /Rotate').toBe(0);
    }

    const margin = page.lines.filter((line) => lineText(line) === 'SAN FRANCISCO: AN OVERVIEW');
    expect(margin.length, 'the sideways margin line appears in both the source text and the invisible layer').toBe(2);
    for (const line of margin) {
      expect(line.orientation, 'the sideways margin line must keep orientation 1 in the exported PDF').toBe(1);
    }
  });

  afterAll(async () => {
    if (doc) await doc.clear();
    if (reDoc) await reDoc.clear();
    await scribe.terminate();
  });
});
