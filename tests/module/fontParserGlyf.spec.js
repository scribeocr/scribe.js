import {
  describe, test, expect, beforeAll,
} from 'vitest';
import {
  findXrefOffset, parseXref, ObjectCache,
} from '../../js/pdf/parsePdfUtils.js';
import { getPageObjects } from '../../js/pdf/parsePdfDoc.js';
import { parsePageFonts } from '../../js/pdf/fonts/parsePdfFonts.js';
import opentype from '../../js/font-parser/src/index.js';
import {
  parseHeadTable, parseMaxpTable, parseHheaTable, parseLocaTable, parseGlyfTable,
  parseHmtxTable, makeGlyfTable,
} from '../../js/font-parser/src/opentype.js';
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

function parseFontTables(fontBytes) {
  const ab = fontBytes instanceof ArrayBuffer
    ? fontBytes
    : fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength);
  const dv = new DataView(ab);
  const u8 = new Uint8Array(ab);
  const numTables = dv.getUint16(4);
  const tableDir = {};
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    const tag = String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]).trim();
    tableDir[tag] = { offset: dv.getUint32(off + 8), length: dv.getUint32(off + 12) };
  }
  return { dv, tableDir };
}

function parseGlyphsFromFont(fontBytes) {
  const { dv, tableDir } = parseFontTables(fontBytes);
  const head = parseHeadTable(dv, tableDir.head.offset);
  const maxp = parseMaxpTable(dv, tableDir.maxp.offset);
  const hhea = parseHheaTable(dv, tableDir.hhea.offset);
  const loca = parseLocaTable(dv, tableDir.loca.offset, maxp.numGlyphs, head.indexToLocFormat === 0);

  const fontShell = { unitsPerEm: head.unitsPerEm, numGlyphs: maxp.numGlyphs, tables: {} };
  const glyphs = parseGlyfTable(dv, tableDir.glyf.offset, loca, fontShell);
  fontShell.glyphs = glyphs;

  parseHmtxTable(dv, tableDir.hhea.offset, hhea.numberOfHMetrics, maxp.numGlyphs, glyphs);

  for (let i = 0; i < maxp.numGlyphs; i++) {
    glyphs.get(i).path;
  }

  return { glyphs, numGlyphs: maxp.numGlyphs, head };
}

function rebuildGlyfAndReparse(glyphs, numGlyphs, head) {
  const result = makeGlyfTable(glyphs);
  const glyfData = result.glyfTable.encode();
  const locaData = result.locaTable.encode();

  const glyfAb = new ArrayBuffer(glyfData.length);
  const glyfU8 = new Uint8Array(glyfAb);
  for (let i = 0; i < glyfData.length; i++) glyfU8[i] = glyfData[i];

  const locaAb = new ArrayBuffer(locaData.length);
  const locaU8 = new Uint8Array(locaAb);
  for (let i = 0; i < locaData.length; i++) locaU8[i] = locaData[i];

  const locaDv = new DataView(locaAb);
  const newLoca = [];
  for (let i = 0; i <= numGlyphs; i++) {
    if (result.indexToLocFormat === 0) {
      newLoca.push(locaDv.getUint16(i * 2) * 2);
    } else {
      newLoca.push(locaDv.getUint32(i * 4));
    }
  }

  const glyfDv = new DataView(glyfAb);
  const fontShell2 = { unitsPerEm: head.unitsPerEm, numGlyphs, tables: {} };
  const rebuiltGlyphs = parseGlyfTable(glyfDv, 0, newLoca, fontShell2);
  fontShell2.glyphs = rebuiltGlyphs;

  for (let i = 0; i < numGlyphs; i++) {
    rebuiltGlyphs.get(i).path;
  }

  return rebuiltGlyphs;
}

async function extractTrueTypeFontBytes(pdfPath, pageIndex, fontName) {
  const pdfU8 = await readFileBytes(pdfPath);
  const xrefOffset = findXrefOffset(pdfU8);
  const xrefEntries = parseXref(pdfU8, xrefOffset);
  const objCache = new ObjectCache(pdfU8, xrefEntries);
  const pageObjects = getPageObjects(objCache);
  const fonts = parsePageFonts(pageObjects[pageIndex].objText, objCache);
  const font = fonts.get(fontName);
  return font.type0.fontFile;
}

describe('TrueType glyf roundtrip (parse → serialize → reparse)', () => {
  describe('chi_eng_mixed_sample.pdf F2 — CJK font with composite glyphs', () => {
    let origGlyphs;
    let rebuiltGlyphs;
    let numGlyphs;

    beforeAll(async () => {
      const fontBytes = await extractTrueTypeFontBytes(
        `${ASSETS_PATH}/chi_eng_mixed_sample.pdf`, 0, 'F2',
      );
      const parsed = parseGlyphsFromFont(fontBytes);
      origGlyphs = parsed.glyphs;
      numGlyphs = parsed.numGlyphs;
      rebuiltGlyphs = rebuildGlyfAndReparse(origGlyphs, numGlyphs, parsed.head);
    });

    test('preserves composite glyph count', () => {
      let origComposite = 0;
      let rebuiltComposite = 0;
      for (let i = 0; i < numGlyphs; i++) {
        if (origGlyphs.get(i).isComposite) origComposite++;
        if (rebuiltGlyphs.get(i).isComposite) rebuiltComposite++;
      }
      expect(rebuiltComposite).toBe(origComposite);
      expect(origComposite).toBe(497);
    });

    test('preserves composite glyph bbox (GID 973 = "中")', () => {
      const orig = origGlyphs.get(973);
      const rebuilt = rebuiltGlyphs.get(973);
      expect(orig.isComposite).toBe(true);
      expect(rebuilt.isComposite).toBe(true);
      expect(rebuilt._xMin).toBe(orig._xMin);
      expect(rebuilt._yMin).toBe(orig._yMin);
      expect(rebuilt._xMax).toBe(orig._xMax);
      expect(rebuilt._yMax).toBe(orig._yMax);
    });

    test('preserves composite glyph component records (GID 973)', () => {
      const orig = origGlyphs.get(973);
      const rebuilt = rebuiltGlyphs.get(973);
      expect(rebuilt.components.length).toBe(orig.components.length);
      for (let ci = 0; ci < orig.components.length; ci++) {
        expect(rebuilt.components[ci].glyphIndex).toBe(orig.components[ci].glyphIndex);
        expect(rebuilt.components[ci].dx).toBe(orig.components[ci].dx);
        expect(rebuilt.components[ci].dy).toBe(orig.components[ci].dy);
      }
    });

    test('preserves composite glyph behavioral flags (USE_MY_METRICS, OVERLAP_COMPOUND, etc.)', () => {
      const behavioralMask = 0x0004 | 0x0200 | 0x0400 | 0x0800 | 0x1000;
      for (let i = 0; i < numGlyphs; i++) {
        const orig = origGlyphs.get(i);
        if (!orig.isComposite) continue;
        const rebuilt = rebuiltGlyphs.get(i);
        for (let ci = 0; ci < orig.components.length; ci++) {
          const origFlags = (orig.components[ci].flags || 0) & behavioralMask;
          const rebuiltFlags = (rebuilt.components[ci].flags || 0) & behavioralMask;
          expect(rebuiltFlags, `GID ${i} component ${ci} behavioral flags`).toBe(origFlags);
        }
      }
    });

    test('preserves simple glyph bbox for all glyphs', () => {
      for (let i = 0; i < numGlyphs; i++) {
        const orig = origGlyphs.get(i);
        const rebuilt = rebuiltGlyphs.get(i);
        if (!orig.points || orig.points.length === 0) continue;
        if (orig.isComposite) continue;
        expect(rebuilt._xMin, `GID ${i} xMin`).toBe(orig._xMin);
        expect(rebuilt._yMin, `GID ${i} yMin`).toBe(orig._yMin);
        expect(rebuilt._xMax, `GID ${i} xMax`).toBe(orig._xMax);
        expect(rebuilt._yMax, `GID ${i} yMax`).toBe(orig._yMax);
      }
    });

    test('preserves glyph instructions for simple and composite glyphs', () => {
      let glyphsWithInstr = 0;
      for (let i = 0; i < numGlyphs; i++) {
        const orig = origGlyphs.get(i);
        const rebuilt = rebuiltGlyphs.get(i);
        const origInstr = orig.instructions || [];
        const rebuiltInstr = rebuilt.instructions || [];
        expect(rebuiltInstr.length, `GID ${i} instruction count`).toBe(origInstr.length);
        for (let j = 0; j < origInstr.length; j++) {
          expect(rebuiltInstr[j], `GID ${i} instruction[${j}]`).toBe(origInstr[j]);
        }
        if (origInstr.length > 0) glyphsWithInstr++;
      }
      expect(glyphsWithInstr).toBe(497);
    });

    test('preserves SVG path for all simple glyphs', () => {
      for (let i = 0; i < numGlyphs; i++) {
        const orig = origGlyphs.get(i);
        if (!orig.points || orig.points.length === 0) continue;
        if (orig.isComposite) continue;
        const rebuilt = rebuiltGlyphs.get(i);
        expect(rebuilt.path.toSVG(), `GID ${i} SVG path`).toBe(orig.path.toSVG());
      }
    });

    test('preserves SVG path for composite glyphs (resolved)', () => {
      for (let i = 0; i < numGlyphs; i++) {
        const orig = origGlyphs.get(i);
        if (!orig.isComposite) continue;
        const rebuilt = rebuiltGlyphs.get(i);
        expect(rebuilt.path.toSVG(), `GID ${i} composite SVG path`).toBe(orig.path.toSVG());
      }
    });

    test('preserves point count for all non-empty glyphs', () => {
      for (let i = 0; i < numGlyphs; i++) {
        const orig = origGlyphs.get(i);
        if (!orig.points || orig.points.length === 0) continue;
        const rebuilt = rebuiltGlyphs.get(i);
        expect(rebuilt.points.length, `GID ${i} point count`).toBe(orig.points.length);
      }
    });
  });
});

describe('Full TrueType font roundtrip (parse → toArrayBuffer → reparse)', () => {
  describe('chi_eng_mixed_sample.pdf F2 — hinting tables and maxp', () => {
    let roundtrippedBuffer;

    beforeAll(async () => {
      const fontBytes = await extractTrueTypeFontBytes(
        `${ASSETS_PATH}/chi_eng_mixed_sample.pdf`, 0, 'F2',
      );
      const ab = fontBytes.buffer.slice(fontBytes.byteOffset, fontBytes.byteOffset + fontBytes.byteLength);
      const origFont = opentype.parse(ab);
      roundtrippedBuffer = origFont.toArrayBuffer();
    });

    function parseTableDir(buf) {
      const dv = new DataView(buf);
      const u8 = new Uint8Array(buf);
      const nt = dv.getUint16(4);
      const td = {};
      for (let i = 0; i < nt; i++) {
        const off = 12 + i * 16;
        const tag = String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]).trim();
        td[tag] = { offset: dv.getUint32(off + 8), length: dv.getUint32(off + 12) };
      }
      return { dv, td };
    }

    test('roundtripped font contains cvt table with correct size', () => {
      const { td } = parseTableDir(roundtrippedBuffer);
      expect(td.cvt).toBeTruthy();
      expect(td.cvt.length).toBe(848);
    });

    test('roundtripped font contains fpgm table with correct size', () => {
      const { td } = parseTableDir(roundtrippedBuffer);
      expect(td.fpgm).toBeTruthy();
      expect(td.fpgm.length).toBe(36963);
    });

    test('roundtripped font contains prep table with correct size', () => {
      const { td } = parseTableDir(roundtrippedBuffer);
      expect(td.prep).toBeTruthy();
      expect(td.prep.length).toBe(126);
    });

    test('maxp.maxFunctionDefs matches original (441)', () => {
      const { dv, td } = parseTableDir(roundtrippedBuffer);
      const maxp = parseMaxpTable(dv, td.maxp.offset);
      expect(maxp.maxFunctionDefs).toBe(441);
    });

    test('maxp.maxStorage matches original (262)', () => {
      const { dv, td } = parseTableDir(roundtrippedBuffer);
      const maxp = parseMaxpTable(dv, td.maxp.offset);
      expect(maxp.maxStorage).toBe(262);
    });

    test('maxp.maxSizeOfInstructions matches original (36963)', () => {
      const { dv, td } = parseTableDir(roundtrippedBuffer);
      const maxp = parseMaxpTable(dv, td.maxp.offset);
      expect(maxp.maxSizeOfInstructions).toBe(36963);
    });

    test('maxp.maxCompositePoints matches original', () => {
      const { dv, td } = parseTableDir(roundtrippedBuffer);
      const maxp = parseMaxpTable(dv, td.maxp.offset);
      expect(maxp.maxCompositePoints).toBe(639);
    });

    test('maxp.maxComponentElements matches original', () => {
      const { dv, td } = parseTableDir(roundtrippedBuffer);
      const maxp = parseMaxpTable(dv, td.maxp.offset);
      expect(maxp.maxComponentElements).toBe(25);
    });
  });
});
