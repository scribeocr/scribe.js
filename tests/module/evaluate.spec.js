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

describe('Check evaluate function.', function () {
  this.timeout(10000);
  before(async () => {
  });

  it('Should correctly compare page to ground truth', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/complaint_1.xml`]);
    await scribe.importFilesSupp([`${ASSETS_PATH_KARMA}/complaint_1.truth.hocr`], 'Ground Truth');

    const res = await scribe.compareOCR(scribe.data.ocr.active, scribe.data.ocr['Ground Truth']);

    const evalStatsDoc = scribe.utils.calcEvalStatsDoc(res.metrics);

    assert.strictEqual(evalStatsDoc.total, 183);
    assert.strictEqual(evalStatsDoc.correct, 181);
    assert.strictEqual(evalStatsDoc.incorrect, 2);
    assert.strictEqual(evalStatsDoc.missed, 0);
    assert.strictEqual(evalStatsDoc.extra, 0);
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);
