// Relative imports are required to run in browser.
/* eslint-disable import/no-relative-packages */
import { assert, config } from '../../node_modules/chai/chai.js';
// import mocha from '../../node_modules/mocha/mocha.js';
import { writeHocr } from '../../js/export/writeHocr.js';
import { gs } from '../../js/generalWorkerMain.js';
import { splitHOCRStr } from '../../js/import/importOCR.js';
import ocr from '../../js/objects/ocrObjects.js';
import scribe from '../../scribe.js';
import { ASSETS_PATH_KARMA } from '../constants.js';

config.truncateThreshold = 0; // Disable truncation for actual/expected values on assertion failure.

// Using arrow functions breaks references to `this`.
/* eslint-disable prefer-arrow-callback */
/* eslint-disable func-names */

/**
 *
 * @param {Array<OcrPage>} ocrArr
 */
const standardizeOCRPages = (ocrArr) => {
  const ocrArrCopy = ocrArr.map((x) => ocr.clonePage(x));

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
        if (word.size) word.size = Math.round(word.size);
        word.chars = null;
      });
    });
  });

  return ocrArrCopy;
};

describe('Check .hocr export function.', function () {
  this.timeout(10000);

  it('Exporting to .hocr and reimporting should restore OCR data without modification', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/scribe_test_pdf1_abbyy.xml`]);

    const ocrAllComp1 = standardizeOCRPages(scribe.data.ocr.active);

    const hocrOutStrArr = splitHOCRStr(writeHocr(scribe.data.ocr.active));

    const resArrPromises = hocrOutStrArr.map((x, i) => (gs.schedulerInner.addJob('convertPageHocr', { ocrStr: x, n: i, scribeMode: true })));
    const resArr = await Promise.all(resArrPromises);
    const pagesArr = resArr.map((x) => (x.pageObj));

    const ocrAllComp2 = standardizeOCRPages(pagesArr);

    assert.deepStrictEqual(ocrAllComp1, ocrAllComp2);
  }).timeout(10000);


  it('Exporting to .hocr and reimporting should restore layout tables without modification', async () => {

    // This file should contain data tables when parsed.
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/bill.abbyy.xml`]);
    assert.isAbove(scribe.data.layoutDataTables.pages[0].tables.length, 0);

    const layoutTables1 = structuredClone(scribe.data.layoutDataTables.pages);

    const hocrOutStr = writeHocr(scribe.data.ocr.active);
    const encoder = new TextEncoder();
    const encoded = encoder.encode(hocrOutStr);
  
    await scribe.terminate();
    await scribe.importFiles({ocrFiles: [encoded.buffer]});

    const layoutTables2 = structuredClone(scribe.data.layoutDataTables.pages);

    assert.deepStrictEqual(layoutTables1, layoutTables2);
  }).timeout(10000);


  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);
