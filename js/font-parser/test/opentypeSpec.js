import assert from 'assert';
import { Font, Path, Glyph } from '../src/opentype.js';
import { loadFont } from './testutil.js';

describe('opentype.js', () => {
  it('can load a TrueType font', async () => {
    const font = await loadFont('./fonts/Roboto-Black.ttf');
    assert.deepEqual(font.names.fontFamily, { en: 'Roboto Black' });
    assert.equal(font.unitsPerEm, 2048);
    assert.equal(font.glyphs.length, 1294);
    const aGlyph = font.charToGlyph('A');
    assert.equal(aGlyph.unicode, 65);
    assert.equal(aGlyph.path.commands.length, 15);
  });

  it('can load a OpenType/CFF font', async () => {
    const font = await loadFont('./fonts/FiraSansOT-Medium.otf');
    assert.deepEqual(font.names.fontFamily, { en: 'Fira Sans OT Medium' });
    assert.equal(font.unitsPerEm, 1000);
    assert.equal(font.glyphs.length, 1151);
    const aGlyph = font.charToGlyph('A');
    assert.equal(aGlyph.name, 'A');
    assert.equal(aGlyph.unicode, 65);
    assert.equal(aGlyph.path.commands.length, 14);
  });

  it('can load a CID-keyed font', async () => {
    const font = await loadFont('./fonts/FDArrayTest257.otf');
    assert.deepEqual(font.names.fontFamily, { en: 'FDArray Test 257' });
    assert.deepEqual(font.tables.cff.topDict.ros, ['Adobe', 'Identity', 0]);
    assert.equal(font.tables.cff.topDict._fdArray.length, 256);
    assert.equal(font.tables.cff.topDict._fdSelect[0], 0);
    assert.equal(font.tables.cff.topDict._fdSelect[42], 41);
    assert.equal(font.tables.cff.topDict._fdSelect[256], 255);
    assert.equal(font.unitsPerEm, 1000);
    assert.equal(font.glyphs.length, 257);
    const aGlyph = font.glyphs.get(2);
    assert.equal(aGlyph.name, 'gid2');
    assert.equal(aGlyph.unicode, 1);
    assert.equal(aGlyph.path.commands.length, 24);
  });

  it('can load a WOFF/CFF font', async () => {
    const font = await loadFont('./fonts/FiraSansMedium.woff');
    assert.deepEqual(font.names.fontFamily, { en: 'Fira Sans OT' });
    assert.equal(font.unitsPerEm, 1000);
    assert.equal(font.glyphs.length, 1147);
    const aGlyph = font.charToGlyph('A');
    assert.equal(aGlyph.name, 'A');
    assert.equal(aGlyph.unicode, 65);
    assert.equal(aGlyph.path.commands.length, 14);
  });

  it('rejects a bad font', async () => {
    await assert.rejects(
      loadFont('./fonts/badfont.otf'),
    );
  });

  it('throws an error when advanceWidth is not set', () => {
    const notdefGlyph = new Glyph({
      name: '.notdef',
      unicode: 0,
      path: new Path(),
    });
    const font = new Font({
      familyName: 'MyFont',
      styleName: 'Medium',
      unitsPerEm: 1000,
      ascender: 800,
      descender: -200,
      glyphs: [notdefGlyph],
    });
    assert.throws(() => { font.toArrayBuffer(); }, /advanceWidth is not a number/);
  });

  it('preserves hmtx advanceWidth for a glyph whose CFF charstring uses the 1-operand endchar width form', async () => {
    // Per Type 2 Charstring spec (Adobe Tech Note #5177), an outline-less
    // glyph (e.g. `space`, `nbsp`) is commonly encoded as `<width> endchar`
    // — a single operand on the stack before endchar. The parser must
    // recognize that leading operand as the width override; if it falls
    // through to the `defaultWidthX` fallback, it silently clobbers the
    // hmtx-derived advance on the shared Glyph object. That's been
    // observed to break PDF width tables on re-export, because our font
    // writer reads `glyph.advanceWidth` after the path getter fires.
    //
    // FiraSansOT-Medium.otf's space glyph is the canonical 1-operand-
    // endchar case: advance 250, no outline.
    const font = await loadFont('./fonts/FiraSansOT-Medium.otf');
    const space = font.charToGlyph(' ');
    assert.strictEqual(space.advanceWidth, 250, 'hmtx advance should be 250');
    // Trigger the lazy CFF charstring parse.
    // eslint-disable-next-line no-unused-expressions
    const path = space.path;
    assert.strictEqual(path.commands.length, 0, 'space has no outline commands');
    assert.strictEqual(space.advanceWidth, 250, 'CFF parse must not clobber advanceWidth');
  });
});
