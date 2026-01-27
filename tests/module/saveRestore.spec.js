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
      line.debug = new scribe.utils.ocr.LineDebugInfo();
      line.bbox.left = Math.round(line.bbox.left);
      line.bbox.top = Math.round(line.bbox.top);
      line.bbox.right = Math.round(line.bbox.right);
      line.bbox.bottom = Math.round(line.bbox.bottom);
      line.words.forEach((word) => {
        word.debug = new scribe.utils.ocr.WordDebugInfo();
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

  it('Exporting to .scribe (gzipped, default) and reimporting should restore OCR data without modification', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.pdf`]);

    const ocrAllComp1 = standardizeOCRPages(scribe.data.ocr.active);

    scribe.opt.compressScribe = true;
    const scribeData = await scribe.exportData('scribe');

    // Verify data is gzipped by checking magic bytes
    const dataArray = new Uint8Array(scribeData);
    assert.strictEqual(dataArray[0], 0x1F, 'First byte should be gzip magic byte 0x1F');
    assert.strictEqual(dataArray[1], 0x8B, 'Second byte should be gzip magic byte 0x8B');

    await scribe.terminate();
    await scribe.importFiles({ scribeFiles: [scribeData] });

    const ocrAllComp2 = standardizeOCRPages(scribe.data.ocr.active);

    assert.deepStrictEqual(ocrAllComp1, ocrAllComp2);
    await scribe.clear();
    await scribe.terminate();
  }).timeout(10000);

  it('Exporting to .scribe (non-gzipped) and reimporting should restore OCR data without modification', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.pdf`]);

    const ocrAllComp1 = standardizeOCRPages(scribe.data.ocr.active);

    scribe.opt.compressScribe = false;
    const scribeData = await scribe.exportData('scribe');

    // Verify data is not gzipped
    assert.strictEqual(typeof scribeData, 'string', 'Non-gzipped data should be a string');
    assert.strictEqual(scribeData[0], '{', 'Non-gzipped data should start with {');

    const encoder = new TextEncoder();
    const scribeDataBuffer = encoder.encode(scribeData).buffer;

    await scribe.terminate();
    await scribe.importFiles({ scribeFiles: [scribeDataBuffer] });

    const ocrAllComp2 = standardizeOCRPages(scribe.data.ocr.active);

    assert.deepStrictEqual(ocrAllComp1, ocrAllComp2);

    scribe.opt.compressScribe = true;
    await scribe.clear();
    await scribe.terminate();
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);
