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

describe('Check ALTO XML import function.', function () {
  this.timeout(10000);

  it('Should import ALTO XML with PNG image', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/ascenders_descenders_test.png`,
      `${ASSETS_PATH_KARMA}/ascenders_descenders_test.alto.xml`]);
  });

  it('Should correctly import text content from ALTO XML (default settings)', async () => {
    const text1 = scribe.data.ocr.active[0].lines[0].words.map((x) => x.text).join(' ');
    const text2 = scribe.data.ocr.active[0].lines[1].words.map((x) => x.text).join(' ');
    const text3 = scribe.data.ocr.active[0].lines[2].words.map((x) => x.text).join(' ');

    assert.strictEqual(text1, 'Ascenders On');
    assert.strictEqual(text2, 'query png');
    assert.strictEqual(text3, 'we can');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check ALTO XML import function without image.', function () {
  this.timeout(10000);

  it('Should import ALTO XML without image/PDF inputs', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/the_past.alto.xml`]);
  });

  it('Should correctly import text content', async () => {
    const text1 = scribe.data.ocr.active[0].lines[0].words.map((x) => x.text).join(' ');
    const text3 = scribe.data.ocr.active[0].lines[2].words.map((x) => x.text).join(' ');

    assert.strictEqual(text1, 'THE PAST.');
    assert.strictEqual(text3, 'THE PAST.');
  }).timeout(10000);

  it('Should correctly import confidence scores', async () => {
    const word1 = scribe.data.ocr.active[0].lines[0].words[0];
    const word2 = scribe.data.ocr.active[0].lines[0].words[1];

    assert.isAbove(word1.conf, 1);
    assert.isAbove(word2.conf, 1);
    assert.isBelow(word1.conf, 100);
    assert.isBelow(word2.conf, 100);
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check that font style is detected for ALTO xml imports.', function () {
  this.timeout(10000);

  it('Bold style is detected', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/the_past.alto.xml`]);
    // First line has STYLE="bold" on both words
    assert.isTrue(scribe.data.ocr.active[0].lines[0].words[0].style.bold);
    assert.isTrue(scribe.data.ocr.active[0].lines[0].words[1].style.bold);
  }).timeout(10000);

  it('Font family is detected from STYLEREFS', async () => {
    // Check that font family is extracted from TextStyle definitions
    // The first TextBlock in TopMargin uses font2 which is Times New Roman
    const word = scribe.data.ocr.active[0].lines[0].words[0];
    // STYLEREFS at TextBlock level should be inherited by words
    assert.strictEqual(word.style.font, 'Times New Roman');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check ALTO XML multi-page import.', function () {
  this.timeout(10000);

  it('Should import multi-page ALTO XML document', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/testocr_all_orientations.alto.xml`]);
    assert.strictEqual(scribe.data.ocr.active.length, 12);
  }).timeout(10000);

  it('Should correctly parse page dimensions', async () => {
    const page = scribe.data.ocr.active[0];
    assert.strictEqual(scribe.data.ocr.active[0].dims.height, 480);
    assert.strictEqual(scribe.data.ocr.active[0].dims.width, 640);
    assert.isTrue(page.dims.height > 0);
    assert.isTrue(page.dims.width > 0);
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check ALTO XML import positioning matches Abbyy.', function () {
  this.timeout(60000);

  /** @type {Object<number, {baseline: Array<number>, fontSize: number, baselineY: number}>} */
  let abbyyLineMetrics;
  /** @type {Object<number, {baseline: Array<number>, fontSize: number, baselineY: number}>} */
  let altoLineMetrics;

  before(async () => {
    await scribe.init({ ocr: true, font: true });

    // First, import Abbyy XML to get accurate line metrics (ground truth)
    await scribe.importFiles([
      `${ASSETS_PATH_KARMA}/ascenders_descenders_test.png`,
      `${ASSETS_PATH_KARMA}/ascenders_descenders_test.abbyy.xml`,
    ]);

    abbyyLineMetrics = {};
    const abbyyPage = scribe.data.ocr.active[0];
    for (let lineIdx = 0; lineIdx < abbyyPage.lines.length; lineIdx++) {
      const line = abbyyPage.lines[lineIdx];
      const wordMetrics = scribe.utils.calcWordMetrics(line.words[0]);
      abbyyLineMetrics[lineIdx] = {
        baseline: [...line.baseline],
        fontSize: wordMetrics.fontSize,
        baselineY: line.bbox.bottom + line.baseline[1],
      };
    }

    await scribe.clear();
    await scribe.importFiles([
      `${ASSETS_PATH_KARMA}/ascenders_descenders_test.png`,
      `${ASSETS_PATH_KARMA}/ascenders_descenders_test.alto.xml`,
    ]);

    altoLineMetrics = {};
    const altoPage = scribe.data.ocr.active[0];
    for (let lineIdx = 0; lineIdx < altoPage.lines.length; lineIdx++) {
      const line = altoPage.lines[lineIdx];
      const wordMetrics = scribe.utils.calcWordMetrics(line.words[0]);
      altoLineMetrics[lineIdx] = {
        baseline: [...line.baseline],
        fontSize: wordMetrics.fontSize,
        baselineY: line.bbox.bottom + line.baseline[1],
      };
    }
  });

  it('ALTO line 0 font size should match Abbyy font size', async () => {
    const altoFontSize = altoLineMetrics[0].fontSize;
    const abbyyFontSize = abbyyLineMetrics[0].fontSize;
    const percentDiff = Math.abs(altoFontSize - abbyyFontSize) / abbyyFontSize;
    assert.approximately(altoFontSize, abbyyFontSize, 5, 'Line 0 font size should be within 5px');
    assert.isBelow(percentDiff, 0.1, 'Line 0 font size should be within 10%');
  }).timeout(10000);

  it('ALTO line 1 font size should match Abbyy font size', async () => {
    const altoFontSize = altoLineMetrics[1].fontSize;
    const abbyyFontSize = abbyyLineMetrics[1].fontSize;
    const percentDiff = Math.abs(altoFontSize - abbyyFontSize) / abbyyFontSize;
    console.log(`Line 1: ALTO fontSize=${altoFontSize}, Abbyy fontSize=${abbyyFontSize}, diff=${(percentDiff * 100).toFixed(1)}%`);
    assert.approximately(altoFontSize, abbyyFontSize, 5, 'Line 1 font size should be within 5px');
    assert.isBelow(percentDiff, 0.1, 'Line 1 font size should be within 10%');
  }).timeout(10000);

  it('ALTO line 2 font size should match Abbyy font size', async () => {
    const altoFontSize = altoLineMetrics[2].fontSize;
    const abbyyFontSize = abbyyLineMetrics[2].fontSize;
    const percentDiff = Math.abs(altoFontSize - abbyyFontSize) / abbyyFontSize;
    assert.approximately(altoFontSize, abbyyFontSize, 5, 'Line 2 font size should be within 5px');
    assert.isBelow(percentDiff, 0.1, 'Line 2 font size should be within 10%');
  }).timeout(10000);

  it('ALTO line 0 baseline Y should match Abbyy baseline Y', async () => {
    const altoBaselineY = altoLineMetrics[0].baselineY;
    const abbyyBaselineY = abbyyLineMetrics[0].baselineY;
    const percentDiff = Math.abs(altoBaselineY - abbyyBaselineY) / abbyyBaselineY;
    assert.approximately(altoBaselineY, abbyyBaselineY, 3, 'Line 0 baseline Y should be within 3px');
    assert.isBelow(percentDiff, 0.1, 'Line 0 baseline Y should be within 10%');
  }).timeout(10000);

  it('ALTO line 1 baseline Y should match Abbyy baseline Y', async () => {
    const altoBaselineY = altoLineMetrics[1].baselineY;
    const abbyyBaselineY = abbyyLineMetrics[1].baselineY;
    const percentDiff = Math.abs(altoBaselineY - abbyyBaselineY) / abbyyBaselineY;
    assert.approximately(altoBaselineY, abbyyBaselineY, 3, 'Line 1 baseline Y should be within 3px');
    assert.isBelow(percentDiff, 0.1, 'Line 1 baseline Y should be within 10%');
  }).timeout(10000);

  it('ALTO line 2 baseline Y should match Abbyy baseline Y', async () => {
    const altoBaselineY = altoLineMetrics[2].baselineY;
    const abbyyBaselineY = abbyyLineMetrics[2].baselineY;
    const percentDiff = Math.abs(altoBaselineY - abbyyBaselineY) / abbyyBaselineY;
    assert.approximately(altoBaselineY, abbyyBaselineY, 3, 'Line 2 baseline Y should be within 3px');
    assert.isBelow(percentDiff, 0.1, 'Line 2 baseline Y should be within 10%');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);
