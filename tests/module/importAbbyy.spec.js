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

describe('Check Abbyy XML import function.', function () {
  this.timeout(10000);
  before(async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/econometrica_example_abbyy.xml`]);
  });

  it('Should correctly import smallcaps attribute', async () => {
    const text1 = scribe.data.ocr.active[0].lines[4].words.map((x) => x.text).join(' ');

    const text2 = scribe.data.ocr.active[0].lines[23].words.map((x) => x.text).join(' ');

    assert.strictEqual(text1, 'Shubhdeep Deb');

    assert.strictEqual(text2, 'Wage inequality in the United States has risen sharply since the 1980s. The skill');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check that text orientation is handled correctly in Abbyy imports.', function () {
  this.timeout(10000);

  it('Lines printed at exactly 90/180/270 degrees have orientation detected correctly', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/CSF_Proposed_Budget_Book_June_2024_r8_30_all_orientations_abbyy.xml`]);
    assert.strictEqual(scribe.data.ocr.active[0].lines[2].words[0].line.orientation, 3);
    assert.strictEqual(scribe.data.ocr.active[3].lines[2].words[0].line.orientation, 2);
    assert.strictEqual(scribe.data.ocr.active[2].lines[2].words[0].line.orientation, 1);
  }).timeout(10000);

  // The following tests compare the coordinates of a rotated line to the same line in a non-rotated version of the same document.
  it('Lines oriented at 90 degrees counterclockwise have coordinates calculated correctly', async () => {
    assert.approximately(scribe.data.ocr.active[0].lines[2].words[0].bbox.left, scribe.data.ocr.active[1].lines[2].words[0].bbox.left, 1);
    assert.approximately(scribe.data.ocr.active[0].lines[2].words[0].bbox.right, scribe.data.ocr.active[1].lines[2].words[0].bbox.right, 1);
    assert.approximately(scribe.data.ocr.active[0].lines[2].words[0].bbox.top, scribe.data.ocr.active[1].lines[2].words[0].bbox.top, 1);
    assert.approximately(scribe.data.ocr.active[0].lines[2].words[0].bbox.bottom, scribe.data.ocr.active[1].lines[2].words[0].bbox.bottom, 1);
  }).timeout(10000);

  it('Lines oriented at 90 degrees clockwise have coordinates calculated correctly', async () => {
    assert.approximately(scribe.data.ocr.active[2].lines[2].words[0].bbox.left, scribe.data.ocr.active[1].lines[2].words[0].bbox.left, 1);
    // This requires a larger tolerance, however the issue appears to be with the input rather than the parsing.
    assert.approximately(scribe.data.ocr.active[2].lines[2].words[0].bbox.right, scribe.data.ocr.active[1].lines[2].words[0].bbox.right, 2);
    assert.approximately(scribe.data.ocr.active[2].lines[2].words[0].bbox.top, scribe.data.ocr.active[1].lines[2].words[0].bbox.top, 1);
    assert.approximately(scribe.data.ocr.active[2].lines[2].words[0].bbox.bottom, scribe.data.ocr.active[1].lines[2].words[0].bbox.bottom, 1);
  }).timeout(10000);

  it('Lines oriented at 180 degrees have coordinates calculated correctly', async () => {
    assert.approximately(scribe.data.ocr.active[3].lines[2].words[0].bbox.left, scribe.data.ocr.active[1].lines[2].words[0].bbox.left, 1);
    assert.approximately(scribe.data.ocr.active[3].lines[2].words[0].bbox.right, scribe.data.ocr.active[1].lines[2].words[0].bbox.right, 1);
    assert.approximately(scribe.data.ocr.active[3].lines[2].words[0].bbox.top, scribe.data.ocr.active[1].lines[2].words[0].bbox.top, 1);
    assert.approximately(scribe.data.ocr.active[3].lines[2].words[0].bbox.bottom, scribe.data.ocr.active[1].lines[2].words[0].bbox.bottom, 1);
  }).timeout(10000);

  it('Lines oriented at 90/180/270 degrees have line rotation detected correctly', async () => {
    assert.approximately(scribe.data.ocr.active[4].lines[0].baseline[0], Math.tan(5 * (Math.PI / 180)), 0.01);
    assert.approximately(scribe.data.ocr.active[6].lines[0].baseline[0], Math.tan(5 * (Math.PI / 180)), 0.01);
    assert.approximately(scribe.data.ocr.active[8].lines[0].baseline[0], Math.tan(5 * (Math.PI / 180)), 0.01);
    assert.approximately(scribe.data.ocr.active[10].lines[0].baseline[0], Math.tan(5 * (Math.PI / 180)), 0.01);
    assert.approximately(scribe.data.ocr.active[5].lines[0].baseline[0], -Math.tan(5 * (Math.PI / 180)), 0.01);
    assert.approximately(scribe.data.ocr.active[7].lines[0].baseline[0], -Math.tan(5 * (Math.PI / 180)), 0.01);
    assert.approximately(scribe.data.ocr.active[9].lines[0].baseline[0], -Math.tan(5 * (Math.PI / 180)), 0.01);
    assert.approximately(scribe.data.ocr.active[11].lines[0].baseline[0], -Math.tan(5 * (Math.PI / 180)), 0.01);

    assert.approximately(scribe.data.pageMetrics[4].angle, 5, 1);
    assert.approximately(scribe.data.pageMetrics[6].angle, 5, 1);
    assert.approximately(scribe.data.pageMetrics[8].angle, 5, 1);
    assert.approximately(scribe.data.pageMetrics[10].angle, 5, 1);
    assert.approximately(scribe.data.pageMetrics[5].angle, -5, 1);
    assert.approximately(scribe.data.pageMetrics[7].angle, -5, 1);
    assert.approximately(scribe.data.pageMetrics[9].angle, -5, 1);
    assert.approximately(scribe.data.pageMetrics[11].angle, -5, 1);
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check that empty pages are handled correctly in Abbyy imports.', function () {
  this.timeout(10000);

  it('Check that empty pages are handled correctly in Abbyy imports.', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/yearbook_of_foreign_trade_statistics_of_poland_2024.xml`]);
    assert.strictEqual(scribe.data.ocr.active[0].lines.length, 7);
    assert.strictEqual(scribe.data.ocr.active[1].lines.length, 0);
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);
