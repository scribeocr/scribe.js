// Relative imports are required to run in browser.
/* eslint-disable import/no-relative-packages */
import { assert, config } from '../../node_modules/chai/chai.js';
import scribe from '../../scribe.js';
import { ASSETS_PATH_KARMA } from '../constants.js';

// Using arrow functions breaks references to `this`.
/* eslint-disable prefer-arrow-callback */
/* eslint-disable func-names */

/**
 *
 * @param {Array<OcrPage>} ocrArr
 */
const standardizeOCRPages = (ocrArr) => {
  const ocrArrCopy = ocrArr.map((x) => scribe.utils.ocr.clonePage(x));

  ocrArrCopy.forEach((page) => {
    page.lines.forEach((line) => {
      line.raw = null;
      line.bbox.left = Math.round(line.bbox.left);
      line.bbox.top = Math.round(line.bbox.top);
      line.bbox.right = Math.round(line.bbox.right);
      line.bbox.bottom = Math.round(line.bbox.bottom);
      line.words.forEach((word) => {
        word.raw = null;
        word.bbox.left = Math.round(word.bbox.left);
        word.bbox.top = Math.round(word.bbox.top);
        word.bbox.right = Math.round(word.bbox.right);
        word.bbox.bottom = Math.round(word.bbox.bottom);
        word.style = { ...word.style };
        if (word.style.size) word.style.size = Math.round(word.style.size);
        word.chars = null;
      });
    });
  });

  return ocrArrCopy;
};

describe('Check .scribe export function.', function () {
  this.timeout(10000);

  it('Exporting to .scribe and reimporting should restore OCR data without modification', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.pdf`]);

    const ocrAllComp1 = standardizeOCRPages(scribe.data.ocr.active);

    const scribeStr = /** @type {string} */ (await scribe.exportData('scribe'));
    const scribeArrayBuffer = new TextEncoder().encode(scribeStr).buffer;
    await scribe.terminate();
    await scribe.importFiles({ scribeFiles: [scribeArrayBuffer] });

    const ocrAllComp2 = standardizeOCRPages(scribe.data.ocr.active);

    assert.deepStrictEqual(ocrAllComp1, ocrAllComp2);
    await scribe.clear();
    await scribe.terminate();
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);
