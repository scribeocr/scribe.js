// Relative imports are required to run in browser.
/* eslint-disable import/no-relative-packages */
import { assert, config } from '../../node_modules/chai/chai.js';
import scribe from '../../scribe.js';
import { writeText } from '../../js/export/writeText.js';
import { ASSETS_PATH_KARMA } from '../constants.js';

scribe.opt.workerN = 1;

config.truncateThreshold = 0; // Disable truncation for actual/expected values on assertion failure.

// Using arrow functions breaks references to `this`.
/* eslint-disable prefer-arrow-callback */
/* eslint-disable func-names */

describe('Check export for .txt files.', function () {
  this.timeout(10000);

  it('Exporting simple paragraph to text works properly', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/testocr.abbyy.xml`]);

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

describe('Check non-contiguous pageArr subsetting for text export.', function () {
  this.timeout(10000);

  // trident_v_connecticut_general.abbyy.xml has 7 pages.
  // Page 0 contains "Officer Comstock" (unique to page 0).
  // Page 1 contains "Munger, Tolles" (unique to page 1).
  // Page 2 contains "Security First Life" (unique to page 2).
  it('Exporting pages [0, 2] should include pages 0 and 2 but not page 1', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/trident_v_connecticut_general.abbyy.xml`]);

    const exportedText = await scribe.exportData('text', { pageArr: [0, 2] });

    // "Comstock" only appears on page 0 — should be present
    assert.include(exportedText, 'Comstock');
    // "Security" only appears on page 2 — should be present
    assert.include(exportedText, 'Security');
    // "Munger" only appears on page 1 — should not be present
    assert.notInclude(exportedText, 'Munger');
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

describe('Check preserveSpacing text export.', function () {
  this.timeout(10000);

  it('preserveSpacing output is longer than compact output due to padding', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/border_patrol_tables.pdf`]);
    const compact = writeText({
      ocrCurrent: scribe.data.ocr.active, pageArr: [0], lineNumbers: true,
    });
    const spaced = writeText({
      ocrCurrent: scribe.data.ocr.active, pageArr: [0], lineNumbers: true, preserveSpacing: true,
    });
    assert.strictEqual(compact.length, 3348);
    assert.strictEqual(spaced.length, 17325);
  }).timeout(10000);

  it('preserveSpacing indents words based on their horizontal position', async () => {
    const spaced = writeText({
      ocrCurrent: scribe.data.ocr.active, pageArr: [0], lineNumbers: true, preserveSpacing: true,
    });
    // "SECTOR" starts with significant left indent in the document
    assert.include(spaced, '0:0             SECTOR');
    // "Miami" appears at the left edge of the data area
    assert.include(spaced, '0:15     Miami');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);
