// Relative imports are required to run in browser.
/* eslint-disable import/no-relative-packages */
import { assert, config } from '../../node_modules/chai/chai.js';
import scribe from '../../scribe.js';
import { ASSETS_PATH_KARMA } from '../constants.js';

config.truncateThreshold = 0; // Disable truncation for actual/expected values on assertion failure.

// Using arrow functions breaks references to `this`.
/* eslint-disable prefer-arrow-callback */
/* eslint-disable func-names */

describe('Check export for .txt files.', function () {
  this.timeout(10000);

  it('Exporting simple paragraph to text works properly', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/testocr.xml`]);

    const exportedText = await scribe.exportData('text');

    const testText = `This is a lot of 12 point text to test the ocr code and see if it works on all types of file format.
The quick brown dog jumped over the lazy fox. The quick brown dog jumped over the lazy fox. The quick brown dog jumped over the lazy fox. The quick brown dog jumped over the lazy fox.`;

    assert.strictEqual(exportedText, testText);

    assert.include(exportedText, 'This is a lot of 12 point text');
    assert.include(exportedText, 'The quick brown dog jumped');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check export -> import for .txt files.', function () {
  this.timeout(10000);

  it('Importing .txt file and exporting to text should preserve content (simple example)', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/text_simple.txt`]);

    const importedText = scribe.data.ocr.active.map((page) => page.lines.map((line) => line.words.map((word) => word.text).join(' ')).join('\n')).join('\n\n');

    const exportedText = await scribe.exportData('text');

    assert.strictEqual(exportedText, importedText);

    assert.include(exportedText, 'Tesseract.js');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);
