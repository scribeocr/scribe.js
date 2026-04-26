import assert from 'assert';
import {
  Font, Glyph, Path, parse,
} from '../src/opentype.js';
import { loadFont } from './testutil.js';

describe('font.js', () => {
  let font;

  const fGlyph = new Glyph({
    name: 'f', unicode: 102, path: new Path(), advanceWidth: 1,
  });
  const iGlyph = new Glyph({
    name: 'i', unicode: 105, path: new Path(), advanceWidth: 1,
  });
  const ffGlyph = new Glyph({
    name: 'f_f', unicode: 0xfb01, path: new Path(), advanceWidth: 1,
  });
  const fiGlyph = new Glyph({
    name: 'f_i', unicode: 0xfb02, path: new Path(), advanceWidth: 1,
  });
  const ffiGlyph = new Glyph({
    name: 'f_f_i', unicode: 0xfb03, path: new Path(), advanceWidth: 1,
  });

  const glyphs = [
    new Glyph({
      name: '.notdef', unicode: 0, path: new Path(), advanceWidth: 1,
    }),
    fGlyph, iGlyph, ffGlyph, fiGlyph, ffiGlyph,
  ];

  beforeEach(() => {
    font = new Font({
      familyName: 'MyFont',
      styleName: 'Medium',
      unitsPerEm: 1000,
      ascender: 800,
      descender: 0,
      fsSelection: 42,
      tables: { os2: { achVendID: 'TEST' } },
      glyphs,
    });
  });

  describe('Font constructor', () => {
    it('accept 0 as descender value', () => {
      assert.equal(font.descender, 0);
    });
    it('tables definition must be supported', () => {
      assert.equal(font.tables.os2.achVendID, 'TEST');
    });
    it('tables definition must blend with default tables values', () => {
      assert.equal(font.tables.os2.usWidthClass, 5);
    });
    it('tables definition can override defaults values', () => {
      assert.equal(font.tables.os2.fsSelection, 42);
    });
    it('tables definition shall be serialized', async () => {
      const buf = font.toArrayBuffer();
      const parsed = await parse(buf);
      assert.equal(parsed.tables.os2.achVendID, 'TEST');
    });
  });
});
