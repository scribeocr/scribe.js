import {
  describe, test, expect, beforeAll,
} from 'vitest';
import { extractType0Fonts } from '../../js/pdf/fonts/parsePdfFonts.js';
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
 * Expected per-object font data for Iris (plant) - Wikipedia_123.pdf.
 * Indexed by PDF object number. The spec asserts the exact shape of the
 * extraction result, not just the names or count.
 * @type {Record<number, {fontName: string, fileLen: number, numGlyphs: number, ascender: number, descender: number, serializeLen: number}>}
 */
const EXPECTED_TYPE0 = {
  7: {
    fontName: 'Arial-BoldItalicMT', fileLen: 16740, numGlyphs: 87, ascender: 1854, descender: -434, serializeLen: 10412,
  },
  10: {
    fontName: 'Arial-ItalicMT', fileLen: 22464, numGlyphs: 93, ascender: 1854, descender: -434, serializeLen: 16204,
  },
  11: {
    fontName: 'Arial-BoldMT', fileLen: 24744, numGlyphs: 93, ascender: 1854, descender: -434, serializeLen: 18428,
  },
  12: {
    fontName: 'ArialMT', fileLen: 42180, numGlyphs: 239, ascender: 1854, descender: -434, serializeLen: 32396,
  },
  15: {
    fontName: 'ArialMT', fileLen: 29948, numGlyphs: 94, ascender: 1854, descender: -434, serializeLen: 23628,
  },
  16: {
    fontName: 'Georgia-BoldItalic', fileLen: 11028, numGlyphs: 87, ascender: 1878, descender: -449, serializeLen: 6824,
  },
  17: {
    fontName: 'Georgia-Bold', fileLen: 17028, numGlyphs: 93, ascender: 1878, descender: -449, serializeLen: 13432,
  },
  18: {
    fontName: 'Georgia', fileLen: 47196, numGlyphs: 465, ascender: 1878, descender: -449, serializeLen: 34068,
  },
  19: {
    fontName: 'Georgia-Italic', fileLen: 21380, numGlyphs: 119, ascender: 1878, descender: -449, serializeLen: 16328,
  },
  71: {
    fontName: 'Arial-ItalicMT', fileLen: 16664, numGlyphs: 87, ascender: 1854, descender: -434, serializeLen: 10404,
  },
  109: {
    fontName: 'TimesNewRomanPSMT', fileLen: 100828, numGlyphs: 2773, ascender: 1825, descender: -443, serializeLen: 30124,
  },
};

describe('Extract Type0 fonts from Iris Wikipedia PDF.', () => {
  /** @type {ReturnType<typeof extractType0Fonts>} */
  let fonts;

  beforeAll(async () => {
    const pdfBytes = await readFileBytes(`${ASSETS_PATH}/Iris (plant) - Wikipedia_123.pdf`);
    fonts = extractType0Fonts(pdfBytes);
  });

  test('Finds all 11 Type0 fonts keyed by their PDF object numbers', () => {
    const objNums = Object.keys(fonts).map(Number).sort((a, b) => a - b);
    expect(objNums).toEqual([7, 10, 11, 12, 15, 16, 17, 18, 19, 71, 109]);
  });

  test('Extracted font names match expected families per object', () => {
    for (const objNum of Object.keys(EXPECTED_TYPE0).map(Number)) {
      expect(fonts[objNum].fontName, `obj ${objNum}`).toBe(EXPECTED_TYPE0[objNum].fontName);
    }
  });

  test('Each font file has the expected byte length and TrueType header', () => {
    for (const objNum of Object.keys(EXPECTED_TYPE0).map(Number)) {
      const expected = EXPECTED_TYPE0[objNum];
      const tag = `obj ${objNum} (${expected.fontName})`;
      const file = fonts[objNum].fontFile;
      expect(file, tag).toBeInstanceOf(Uint8Array);
      expect(file.length, tag).toBe(expected.fileLen);
      // TrueType sfnt header: 0x00010000
      expect(file[0], tag).toBe(0x00);
      expect(file[1], tag).toBe(0x01);
      expect(file[2], tag).toBe(0x00);
      expect(file[3], tag).toBe(0x00);
    }
  });

  test('Each parsed font has the expected glyph count and unitsPerEm = 2048', () => {
    for (const objNum of Object.keys(EXPECTED_TYPE0).map(Number)) {
      const expected = EXPECTED_TYPE0[objNum];
      const font = opentype.parse(/** @type {ArrayBuffer} */ (fonts[objNum].fontFile.buffer));
      const tag = `obj ${objNum} (${expected.fontName})`;
      expect(font.numGlyphs, tag).toBe(expected.numGlyphs);
      expect(font.unitsPerEm, tag).toBe(2048);
    }
  });

  test('Each parsed font has the expected ascender and descender', () => {
    for (const objNum of Object.keys(EXPECTED_TYPE0).map(Number)) {
      const expected = EXPECTED_TYPE0[objNum];
      const font = opentype.parse(/** @type {ArrayBuffer} */ (fonts[objNum].fontFile.buffer));
      const tag = `obj ${objNum} (${expected.fontName})`;
      expect(font.ascender, tag).toBe(expected.ascender);
      expect(font.descender, tag).toBe(expected.descender);
    }
  });

  test('Each font re-serializes via toArrayBuffer to the expected byte length', () => {
    for (const objNum of Object.keys(EXPECTED_TYPE0).map(Number)) {
      const expected = EXPECTED_TYPE0[objNum];
      const font = opentype.parse(/** @type {ArrayBuffer} */ (fonts[objNum].fontFile.buffer));
      const buf = font.toArrayBuffer();
      expect(buf.byteLength, `obj ${objNum} (${expected.fontName})`).toBe(expected.serializeLen);
    }
  });

  test('Same-name Type0 fonts represent different subsets (distinct byte content)', () => {
    // Iris PDF embeds ArialMT and Arial-ItalicMT twice each, with different glyph
    // subsets used on different pages. The extractor must key results by PDF object
    // number, not by family name — otherwise one entry would overwrite the other.
    expect(fonts[12].fontName).toBe('ArialMT');
    expect(fonts[15].fontName).toBe('ArialMT');
    expect(fonts[12].fontFile).not.toEqual(fonts[15].fontFile);

    expect(fonts[10].fontName).toBe('Arial-ItalicMT');
    expect(fonts[71].fontName).toBe('Arial-ItalicMT');
    expect(fonts[10].fontFile).not.toEqual(fonts[71].fontFile);
  });
});
