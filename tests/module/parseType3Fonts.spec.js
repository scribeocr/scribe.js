import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import {
  extractType3Fonts, extractType3GlyphBBoxes, correctType3CharBBoxes,
} from '../../js/pdf/fonts/parsePdfFonts.js';
import opentype from '../../js/font-parser/src/index.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

/** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
let doc;

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

/** @param {string} filePath */
async function readFileBytes(filePath) {
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    const fs = await import('node:fs/promises');
    const buf = await fs.readFile(filePath);
    return new Uint8Array(buf);
  }
  const response = await fetch(filePath);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Expected per-object Type3 font data for Iris (plant) - Wikipedia_AdobePDF123.pdf.
 * @type {Record<number, {fontName: string, fileLen: number, numGlyphs: number, glyphsWithPaths: number, serializeLen: number}>}
 */
const EXPECTED_TYPE3 = {
  246: {
    fontName: 'T2', fileLen: 18984, numGlyphs: 113, glyphsWithPaths: 111, serializeLen: 18956,
  },
  247: {
    fontName: 'T3', fileLen: 26676, numGlyphs: 112, glyphsWithPaths: 110, serializeLen: 26648,
  },
  450: {
    fontName: 'T1', fileLen: 32880, numGlyphs: 176, glyphsWithPaths: 174, serializeLen: 32852,
  },
};

describe('Extract Type3 fonts as OpenType from broken encoding PDF.', () => {
  /** @type {ReturnType<typeof extractType3Fonts>} */
  let fonts;

  beforeAll(async () => {
    const pdfBytes = await readFileBytes(`${ASSETS_PATH}/Iris (plant) - Wikipedia_AdobePDF123.pdf`);
    fonts = extractType3Fonts(pdfBytes);
  });

  test('Finds 3 Type3 fonts (T1, T2, T3) keyed by their PDF object numbers', () => {
    const objNums = Object.keys(fonts).map(Number).sort((a, b) => a - b);
    expect(objNums).toEqual([246, 247, 450]);
    expect(fonts[246].fontName).toBe('T2');
    expect(fonts[247].fontName).toBe('T3');
    expect(fonts[450].fontName).toBe('T1');
  });

  test('Each font file has the expected byte length and OpenType CFF header (OTTO)', () => {
    for (const objNum of Object.keys(EXPECTED_TYPE3).map(Number)) {
      const expected = EXPECTED_TYPE3[objNum];
      const tag = `obj ${objNum} (${expected.fontName})`;
      const file = fonts[objNum].fontFile;
      expect(file, tag).toBeInstanceOf(Uint8Array);
      expect(file.length, tag).toBe(expected.fileLen);
      expect(String.fromCharCode(file[0], file[1], file[2], file[3]), tag).toBe('OTTO');
    }
  });

  test('Each parsed font has the expected glyph count and unitsPerEm = 1000', () => {
    for (const objNum of Object.keys(EXPECTED_TYPE3).map(Number)) {
      const expected = EXPECTED_TYPE3[objNum];
      const font = opentype.parse(/** @type {ArrayBuffer} */ (fonts[objNum].fontFile.buffer));
      const tag = `obj ${objNum} (${expected.fontName})`;
      expect(font.numGlyphs, tag).toBe(expected.numGlyphs);
      expect(font.unitsPerEm, tag).toBe(1000);
    }
  });

  test('Each font has the expected count of glyphs with non-empty path data', () => {
    for (const objNum of Object.keys(EXPECTED_TYPE3).map(Number)) {
      const expected = EXPECTED_TYPE3[objNum];
      const font = opentype.parse(/** @type {ArrayBuffer} */ (fonts[objNum].fontFile.buffer));
      let glyphsWithPaths = 0;
      for (let i = 1; i < font.numGlyphs; i++) {
        const g = font.glyphs.get(i);
        if (g.path && g.path.commands.length > 0) glyphsWithPaths++;
      }
      expect(glyphsWithPaths, `obj ${objNum} (${expected.fontName})`).toBe(expected.glyphsWithPaths);
    }
  });

  test('All glyphs in every Type3 font have advanceWidth = 1000', () => {
    for (const objNum of Object.keys(EXPECTED_TYPE3).map(Number)) {
      const expected = EXPECTED_TYPE3[objNum];
      const font = opentype.parse(/** @type {ArrayBuffer} */ (fonts[objNum].fontFile.buffer));
      for (let i = 1; i < font.numGlyphs; i++) {
        const g = font.glyphs.get(i);
        expect(g.advanceWidth, `${expected.fontName} glyph ${g.name}`).toBe(1000);
      }
    }
  });

  test('T1 first real glyph path includes moveTo and close commands', () => {
    const font = opentype.parse(/** @type {ArrayBuffer} */ (fonts[450].fontFile.buffer));
    const g = font.glyphs.get(1);
    expect(g.path.commands.length).toBeGreaterThan(0);
    const types = new Set(g.path.commands.map((c) => c.type));
    expect(types.has('M')).toBe(true);
    expect(types.has('Z')).toBe(true);
  });

  test('T1 glyph bounding boxes span exactly the expected width and height range', () => {
    const font = opentype.parse(/** @type {ArrayBuffer} */ (fonts[450].fontFile.buffer));
    let measured = 0;
    let minW = Infinity;
    let maxW = -Infinity;
    let minH = Infinity;
    let maxH = -Infinity;
    for (let i = 1; i < font.numGlyphs; i++) {
      const g = font.glyphs.get(i);
      if (!g.path || g.path.commands.length === 0) continue;
      const bbox = g.getBoundingBox();
      const w = bbox.x2 - bbox.x1;
      const h = bbox.y2 - bbox.y1;
      if (w === 0 && h === 0) continue;
      if (w > 0) {
        minW = Math.min(minW, w);
        maxW = Math.max(maxW, w);
      }
      if (h > 0) {
        minH = Math.min(minH, h);
        maxH = Math.max(maxH, h);
      }
      measured++;
    }
    expect(measured).toBe(174);
    expect(minW).toBe(88);
    expect(maxW).toBe(877);
    expect(minH).toBe(61);
    expect(maxH).toBe(973);
  });

  test('Each font re-serializes via toArrayBuffer to the expected byte length', () => {
    for (const objNum of Object.keys(EXPECTED_TYPE3).map(Number)) {
      const expected = EXPECTED_TYPE3[objNum];
      const font = opentype.parse(/** @type {ArrayBuffer} */ (fonts[objNum].fontFile.buffer));
      const buf = font.toArrayBuffer();
      expect(buf.byteLength, `obj ${objNum} (${expected.fontName})`).toBe(expected.serializeLen);
    }
  });

  test('T1 glyph 1 unicode is exactly U+E000 (start of Private Use Area)', () => {
    const font = opentype.parse(/** @type {ArrayBuffer} */ (fonts[450].fontFile.buffer));
    expect(font.glyphs.get(1).unicode).toBe(0xE000);
  });

  test('T1 median glyph bounding-box height is 693 units (FontMatrix scaling sanity)', () => {
    // FontMatrix maps Type3 glyph space (0–1) to text space; the extractor scales
    // to 1000 unitsPerEm. A median bbox height of 693 confirms body-text glyphs
    // landed in the 600–800 range typical of OpenType fonts at that em size,
    // which is what downstream rendering relies on.
    const font = opentype.parse(/** @type {ArrayBuffer} */ (fonts[450].fontFile.buffer));
    const heights = [];
    for (let i = 1; i < font.numGlyphs; i++) {
      const g = font.glyphs.get(i);
      if (!g.path || g.path.commands.length === 0) continue;
      const bbox = g.getBoundingBox();
      const h = bbox.y2 - bbox.y1;
      if (h > 0) heights.push(h);
    }
    heights.sort((a, b) => a - b);
    expect(heights[Math.floor(heights.length / 2)]).toBe(693);
  });
});

// extractType3GlyphBBoxes is a separate exported function that returns the raw
// per-glyph bbox data (normalized 0–1 coordinates) before it gets scaled into
// OpenType form. It uses an independent code path from extractType3Fonts so
// it needs its own coverage.
describe('Extract Type3 glyph bounding boxes (raw normalized data).', () => {
  /** @type {ReturnType<typeof extractType3GlyphBBoxes>} */
  let bboxFonts;

  beforeAll(async () => {
    const pdfBytes = await readFileBytes(`${ASSETS_PATH}/Iris (plant) - Wikipedia_AdobePDF123.pdf`);
    bboxFonts = extractType3GlyphBBoxes(pdfBytes);
  });

  test('Returns 3 fonts at the expected obj numbers with expected glyph counts', () => {
    const objNums = Object.keys(bboxFonts).map(Number).sort((a, b) => a - b);
    expect(objNums).toEqual([246, 247, 450]);
    // Note: glyph counts are 1 less than the OpenType numGlyphs reported by
    // extractType3Fonts because the OpenType output adds a synthetic .notdef.
    expect(Object.keys(bboxFonts[246].glyphs).length).toBe(112);
    expect(Object.keys(bboxFonts[247].glyphs).length).toBe(111);
    expect(Object.keys(bboxFonts[450].glyphs).length).toBe(175);
  });

  test('T1 specific glyphs have expected normalized bbox dimensions', () => {
    const t1 = bboxFonts[450];
    // PDF coordinates are doubles, so width/height computations carry FP tails;
    // assertions use precision=5 (≈ ±5e-6) rather than a coarse tolerance.
    /** @type {{x0: number, y0: number, x1: number, y1: number}} */
    const g0 = /** @type {any} */ (t1.glyphs['0'].bbox); // parallelogram
    expect(g0.x0).toBeCloseTo(0.034668, 5);
    expect(g0.y0).toBe(0);
    expect(g0.x1 - g0.x0).toBeCloseTo(0.29688, 5);
    expect(g0.y1 - g0.y0).toBeCloseTo(0.71582, 5);

    /** @type {{x0: number, y0: number, x1: number, y1: number}} */
    const g1 = /** @type {any} */ (t1.glyphs['1'].bbox); // curved shape
    expect(g1.x0).toBeCloseTo(0.03223, 5);
    expect(g1.y0).toBe(0);
    expect(g1.x1 - g1.x0).toBeCloseTo(0.4419, 5);
    expect(g1.y1 - g1.y0).toBeCloseTo(0.53076, 5);

    /** @type {{x0: number, y0: number, x1: number, y1: number}} */
    const g100 = /** @type {any} */ (t1.glyphs['100'].bbox); // tall narrow shape
    expect(g100.x0).toBeCloseTo(0.02099, 5);
    expect(g100.y0).toBe(0);
    expect(g100.x1 - g100.x0).toBeCloseTo(0.24805, 5);
    expect(g100.y1 - g100.y0).toBeCloseTo(0.73975, 5);
  });

  test('T1 i255 (space-like glyph) has null bbox', () => {
    expect(bboxFonts[450].glyphs.i255.bbox).toBeNull();
  });

  test('T1 bboxes span the expected normalized width and height range (no [-10,-10,10,10] placeholders)', () => {
    // Catches regression to the placeholder [-10,-10,10,10] FontBBox: tight bboxes
    // should max out near 1 (one em), not at 20.
    let measured = 0;
    let minW = Infinity;
    let maxW = -Infinity;
    let minH = Infinity;
    let maxH = -Infinity;
    for (const g of Object.values(bboxFonts[450].glyphs)) {
      if (!g.bbox) continue;
      const w = g.bbox.x1 - g.bbox.x0;
      const h = g.bbox.y1 - g.bbox.y0;
      if (w > 0) {
        minW = Math.min(minW, w);
        maxW = Math.max(maxW, w);
      }
      if (h > 0) {
        minH = Math.min(minH, h);
        maxH = Math.max(maxH, h);
      }
      measured++;
    }
    expect(measured).toBe(174);
    expect(minW).toBeCloseTo(0.08789, 5);
    expect(maxW).toBeCloseTo(0.87695, 5);
    expect(minH).toBeCloseTo(0.06104, 5);
    expect(maxH).toBeCloseTo(0.97314, 5);
  });
});

// correctType3CharBBoxes is the only consumer of extractType3GlyphBBoxes inside
// the OCR pipeline: it rewrites per-character bboxes on already-imported OcrPages
// using the actual glyph outlines, replacing the broken sizes that come from
// PDFs whose Type3 fonts use the placeholder FontBBox.
describe('correctType3CharBBoxes restores OcrPage character dimensions.', () => {
  /** @type {number} */
  let medianGTH;
  /** @type {number} */
  let medianGTW;
  /** @type {number} */
  let medianBeforeH;
  /** @type {number} */
  let medianAfterH;
  /** @type {number} */
  let medianAfterW;

  beforeAll(async () => {
    // Ground truth from the parallel Type0 PDF (same content, working encoding).
    doc = await scribe.openDocument([`${ASSETS_PATH}/Iris (plant) - Wikipedia_123.pdf`]);
    const gtH = [];
    const gtW = [];
    for (const line of doc.ocr.active[0].lines) {
      for (const word of line.words) {
        if (!word.chars) continue;
        for (const ch of word.chars) {
          gtH.push(ch.bbox.bottom - ch.bbox.top);
          gtW.push(ch.bbox.right - ch.bbox.left);
        }
      }
    }
    gtH.sort((a, b) => a - b);
    gtW.sort((a, b) => a - b);
    medianGTH = gtH[Math.floor(gtH.length / 2)];
    medianGTW = gtW[Math.floor(gtW.length / 2)];
    await scribe.terminate();

    // Broken Type3 PDF — record before-correction baseline, then apply.
    doc = await scribe.openDocument([`${ASSETS_PATH}/Iris (plant) - Wikipedia_AdobePDF123.pdf`]);
    const beforeH = [];
    for (const line of doc.ocr.pdf[0].lines) {
      for (const word of line.words) {
        if (!word.chars) continue;
        for (const ch of word.chars) {
          const h = ch.bbox.bottom - ch.bbox.top;
          if (h > 0) beforeH.push(h);
        }
      }
    }
    beforeH.sort((a, b) => a - b);
    medianBeforeH = beforeH[Math.floor(beforeH.length / 2)];

    const pdfBytes = await readFileBytes(`${ASSETS_PATH}/Iris (plant) - Wikipedia_AdobePDF123.pdf`);
    const type3Fonts = extractType3GlyphBBoxes(pdfBytes);
    correctType3CharBBoxes(doc.ocr.pdf, type3Fonts);

    const afterH = [];
    const afterW = [];
    for (const line of doc.ocr.pdf[0].lines) {
      for (const word of line.words) {
        if (!word.chars) continue;
        for (const ch of word.chars) {
          const h = ch.bbox.bottom - ch.bbox.top;
          const w = ch.bbox.right - ch.bbox.left;
          if (h > 0 && w > 0) {
            afterH.push(h);
            afterW.push(w);
          }
        }
      }
    }
    afterH.sort((a, b) => a - b);
    afterW.sort((a, b) => a - b);
    medianAfterH = afterH[Math.floor(afterH.length / 2)];
    medianAfterW = afterW[Math.floor(afterW.length / 2)];
  });

  afterAll(async () => {
    await scribe.terminate();
  });

  test('Type0 ground-truth median character height is 35 px and width is 24 px', () => {
    expect(medianGTH).toBe(35);
    expect(medianGTW).toBe(24);
  });

  test('Uncorrected Type3 character heights are taller than ground truth (50 px)', () => {
    // Confirms the precondition: without correction, Type3 chars get the broken
    // placeholder height. Anchors the regression so a future change that already
    // produces correct sizes upstream would surface here.
    expect(medianBeforeH).toBe(50);
  });

  test('Corrected Type3 character heights and widths match the expected post-correction values', () => {
    expect(medianAfterH).toBe(26);
    expect(medianAfterW).toBe(21);
  });

  test('A Type 3 font answers the editor with a program built from its CharProcs and each code\'s mapped text', async () => {
    const ef = await doc.images.getEditFont(0, 450);
    expect(ef?.program?.kind, 'a Type 3 font with drawable CharProcs answers as a type3 program').toBe('type3');
    expect(ef.program.font?.numGlyphs, 'one glyph per CharProc plus .notdef').toBe(176);
    const table = ef.program.glyphs;
    expect(table?.length, 'the glyph table lists every CharProc').toBe(175);
    const g2 = table.find((g) => g.name === '2');
    expect(g2?.codes, 'CharProc "2" is reached by code 3').toEqual([3]);
    expect(g2?.text, 'code 3 extracts as the placeholder U+E003, which is what the glyph maps to').toBe('\uE003');
    expect(g2?.hasOutline, 'CharProc "2" draws an outline').toBe(true);
    expect(ef.program.font.glyphs.get(ef.program.font.charToGlyphIndex('\uE003')).name, 'the placeholder draws CharProc "2"').toBe('2');
    const sp = table.find((g) => g.name === 'i255');
    expect(sp?.codes, 'the inkless CharProc "i255" is reached by code 9').toEqual([9]);
    expect(sp?.text, 'the inkless CharProc extracts as a space').toBe(' ');
    expect(sp?.hasOutline, 'CharProc "i255" has no outline').toBe(false);
  });

  // Runs last in this describe, since it rewrites the shared document's text.
  describe('Characters recorded against Type 3 glyph outlines', () => {
    const adobePath = `${ASSETS_PATH}/Iris (plant) - Wikipedia_AdobePDF123.pdf`;
    /** @type {number[]} */
    let setPages;
    /** @type {Record<string, string>} */
    let afterSet;
    /** @type {Record<string, string>} */
    let afterUndo;
    /** @type {Record<string, string>} */
    let afterRedo;
    /** @type {Record<string, string>} */
    let afterRestore;
    /** @type {number[]} */
    let editPages;
    /** @type {string} */
    let afterEdit;
    /** @type {string} */
    let afterLegacyEdit;
    /** @type {{ line: string[], nextPage: string, lines: number, words: number }} */
    let fromPdf;

    beforeAll(async () => {
      const page = doc.ocr.pdf[0];
      const word = page.lines[1].words[0];
      const entry = doc.nativeText.pages[0][word.id];
      const hashes = await doc.images.getType3GlyphHashes(0);
      const outlines = entry.codes.map((code) => hashes.fonts.get(entry.fontObjNum).byCode.get(code).hash);
      const read = () => ({
        word: word.text,
        chars: word.chars.map((c) => c.text).join(''),
        mixed: page.lines[1].words[1].text,
        heading: page.lines[0].words[0].text,
        nextPage: doc.ocr.pdf[1].lines[1].words[0].text,
      });
      setPages = await doc.setType3GlyphMappings(outlines.map((hash, i) => [hash, 'Iris'[i]]));
      afterSet = read();
      doc.undo();
      afterUndo = read();
      doc.redo();
      afterRedo = read();

      // The viewer shows a placeholder-text document from its `pdf` layer; the export reads the active one.
      doc.ocr.active = doc.ocr.pdf;
      const scribeData = await doc.exportData('scribe', { scribeSession: true });
      const restored = await scribe.openDocument({ pdfFiles: [adobePath], scribeFiles: [scribeData] });
      const restoredLine = restored.ocr.active[0].lines[1];
      afterRestore = {
        word: restoredLine.words[0].text,
        mixed: restoredLine.words[1].text,
        nextPage: restored.ocr.active[1].lines[1].words[0].text,
      };

      const mixed = restoredLine.words[1];
      const mixedEntry = restored.nativeText.pages[0][mixed.id];
      const restoredHashes = await restored.images.getType3GlyphHashes(0);
      const outlineAt = (i) => restoredHashes.fonts.get(mixedEntry.fontObjNum).byCode.get(mixedEntry.codes[i]).hash;
      const bOutline = outlineAt(2);
      const cOutline = outlineAt(6);
      editPages = await restored.setType3GlyphMappings([[bOutline, 'b']]);
      afterEdit = mixed.text;
      // A session saved before the parser recorded glyph codes restores its words without them, so the next edit has to fetch them from the PDF.
      for (const record of Object.values(restored.nativeText.pages[0])) delete record.codes;
      await restored.setType3GlyphMappings([[cOutline, 'c']]);
      afterLegacyEdit = mixed.text;

      const reopened = await scribe.openDocument({ pdfFiles: [await restored.exportData('pdf')] });
      const reopenedPage = reopened.ocr.pdf[0];
      fromPdf = {
        line: reopenedPage.lines[1].words.map((w) => w.text),
        nextPage: reopened.ocr.pdf[1].lines[1].words[0].text,
        lines: reopenedPage.lines.length,
        words: reopenedPage.lines.flatMap((line) => line.words).length,
      };
    });

    test('A recorded character repairs every word drawn with its glyph, in place, as one undoable step', () => {
      expect(setPages, 'the change reports the pages whose words it rewrote').toEqual([0, 1]);
      expect(afterSet.word, 'the word whose glyphs were mapped reads as the mapped characters').toBe('Iris');
      expect(afterSet.chars, 'the per-character text follows the word text').toBe('Iris');
      expect(afterSet.mixed, 'a word that mixes mapped and unmapped glyphs keeps placeholders for the unmapped ones').toBe('siiri');
      expect(afterSet.heading, 'the heading, set in another face, is untouched').toBe('');
      expect(afterSet.nextPage, 'the same outlines in the next page\'s font are repaired too, keyed by outline').toBe('Iris');
      expect(afterUndo.word, 'undo restores the placeholder text').toBe('');
      expect(afterUndo.nextPage, 'undo restores every page the change rewrote').toBe('');
      expect(afterRedo.word, 'redo re-applies the recorded characters').toBe('Iris');
    });

    test('A restored session keeps the repaired words and can still be edited', () => {
      expect(afterRestore.word, 'the repaired word survives the session round-trip').toBe('Iris');
      expect(afterRestore.mixed, 'a partly repaired word survives the session round-trip with its placeholders').toBe('siiri');
      expect(afterRestore.nextPage, 'the repair on the next page survives the session round-trip').toBe('Iris');
      expect(editPages, 'a character recorded on the restored session reaches every page that draws the outline').toEqual([0, 1]);
      expect(afterEdit, 'a character recorded on the restored session repairs its words').toBe('sibiri');
      expect(afterLegacyEdit, 'a session restored without glyph codes is still repaired').toBe('sibiric');
    });

    test('A PDF exported from the restored session carries the text in its fonts, each word once', () => {
      expect(fromPdf.line, 'characters recorded before and after the restore extract from the PDF, and a glyph without one stays a placeholder').toEqual(['Iris', 'sibiric']);
      expect(fromPdf.nextPage, 'the next page\'s font carries the recorded characters too').toBe('Iris');
      expect([fromPdf.lines, fromPdf.words], 'the exported page repeats no repaired word in a text overlay').toEqual([44, 240]);
    });
  });
});
