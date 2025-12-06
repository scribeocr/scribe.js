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

describe('Check cleanup functions allow for resetting module.', function () {
  this.timeout(10000);
  it('Check that cleanup functions work properly', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/chi_eng_mixed_sample.pdf`]);
    await scribe.terminate();
    await scribe.init();
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/chi_eng_mixed_sample.pdf`]);
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('extractText function can be used with .xml imports.', function () {
  this.timeout(10000);
  it('Should recognize basic .jpg image using single function', async () => {
    const txt = await scribe.extractText([`${ASSETS_PATH_KARMA}/econometrica_example.abbyy.xml`]);
    assert.strictEqual(txt.slice(0, 17), 'Check for updates');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);
