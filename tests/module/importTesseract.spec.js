// Relative imports are required to run in browser.
/* eslint-disable import/no-relative-packages */
import { assert, config } from '../../node_modules/chai/chai.js';
// import mocha from '../../node_modules/mocha/mocha.js';
import scribe from '../../scribe.js';
import { ASSETS_PATH_KARMA } from '../constants.js';

config.truncateThreshold = 0; // Disable truncation for actual/expected values on assertion failure.

// Using arrow functions breaks references to `this`.
/* eslint-disable prefer-arrow-callback */
/* eslint-disable func-names */

describe('Check .hocr import function (basic)', function () {
  this.timeout(10000);
  before(async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/econometrica_example_tess.hocr`]);
  });

  it('Should import HOCR created with Tesseract CLI', async () => {

    await scribe.importFiles([`${ASSETS_PATH_KARMA}/bill.hocr`]);

    const page = scribe.data.ocr.active[0];

    const text1 = page.lines[0].words.map((x) => x.text).join(' ');

    assert.strictEqual(text1, 'FIRST CHEQUING');
  }).timeout(10000);


  // When using Tesseract.js or the Tesseract API to save individual pages as .hocr files, the output is different from the output of the Tesseract CLI,
  // as they only include the div with the class 'ocr_page' and the text content of the page, not the entire HTML structure.
  it('Should import HOCR pages created with Tesseract API/Tesseract.js', async () => {

    await scribe.importFiles([`${ASSETS_PATH_KARMA}/bill.tesseractjs.hocr`]);

    const page = scribe.data.ocr.active[0];

    const text1 = page.lines[0].words.map((x) => x.text).join(' ');

    assert.strictEqual(text1, 'FIRST CHEQUING');
  }).timeout(10000);


  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);


describe('Check Tesseract .hocr import function (small caps).', function () {
  this.timeout(10000);
  before(async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/econometrica_example_tess.hocr`]);
  });

  it('Should correctly import small caps printed using font size adjustments', async () => {
    const text1 = scribe.data.ocr.active[0].lines[4].words.map((x) => x.text).join(' ');

    const text2 = scribe.data.ocr.active[0].lines[23].words.map((x) => x.text).join(' ');

    assert.strictEqual(text1, 'Shubhdeep Deb');

    assert.strictEqual(text2, 'Wage inequality in the United States has risen sharply since the 1980s. The skill');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);