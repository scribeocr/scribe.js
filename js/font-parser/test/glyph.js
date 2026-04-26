import assert from 'assert';
import { loadFont } from './testutil.js';

describe('glyph.js', () => {
  describe('bounding box', () => {
    let trueTypeFont;
    let openTypeFont;

    before(async () => {
      trueTypeFont = await loadFont('./fonts/Roboto-Black.ttf');
      openTypeFont = await loadFont('./fonts/FiraSansMedium.woff');
    });

    it('calculates a box for a linear shape', () => {
      const glyph = trueTypeFont.charToGlyph('A');
      const box = glyph.getBoundingBox();
      assert.equal(box.x1, -3);
      assert.equal(box.y1, 0);
      assert.equal(box.x2, 1399);
      assert.equal(box.y2, 1456);
    });

    it('calculates a box for a quadratic shape', () => {
      const glyph = trueTypeFont.charToGlyph('Q');
      const box = glyph.getBoundingBox();
      assert.equal(box.x1, 72);
      assert.equal(box.y1, -266);
      assert.equal(box.x2, 1345);
      assert.equal(box.y2, 1476);
    });

    it('calculates a box for a bezier shape', () => {
      const glyph = openTypeFont.charToGlyph('Q');
      const box = glyph.getBoundingBox();
      assert.equal(box.x1, 62);
      assert.equal(box.y1, -103);
      assert.equal(box.x2, 688);
      assert.equal(box.y2, 701);
    });
  });
});

