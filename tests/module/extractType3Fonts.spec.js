import {
  describe, test, expect, beforeAll,
} from 'vitest';
import { extractType3Fonts } from '../../js/pdf/fonts/parsePdfFonts.js';
import opentype from '../../js/font-parser/src/index.js';
import { ASSETS_PATH } from './_paths.js';

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
    fontName: 'T2', fileLen: 19872, numGlyphs: 113, glyphsWithPaths: 111, serializeLen: 19844,
  },
  247: {
    fontName: 'T3', fileLen: 27556, numGlyphs: 112, glyphsWithPaths: 110, serializeLen: 27528,
  },
  450: {
    fontName: 'T1', fileLen: 34272, numGlyphs: 176, glyphsWithPaths: 174, serializeLen: 34244,
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
