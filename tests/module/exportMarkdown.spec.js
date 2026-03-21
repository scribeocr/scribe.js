// Relative imports are required to run in browser.
/* eslint-disable import/no-relative-packages */
import { assert, config } from '../../node_modules/chai/chai.js';
import scribe from '../../scribe.js';
import { ASSETS_PATH_KARMA } from '../constants.js';

config.truncateThreshold = 0; // Disable truncation for actual/expected values on assertion failure.

// Using arrow functions breaks references to `this`.
/* eslint-disable prefer-arrow-callback */
/* eslint-disable func-names */

describe('Check export for markdown files.', function () {
  this.timeout(10000);

  it('Exporting simple paragraph to markdown works properly', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/testocr.abbyy.xml`]);

    const exportedMd = await scribe.exportData('md');

    assert.include(exportedMd, 'This is a lot of 12 point text');
    assert.include(exportedMd, 'The quick brown dog jumped');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check markdown formatting export.', function () {
  this.timeout(10000);

  it('Italic text should be wrapped with asterisks', async () => {
    // Use ABBYY format which properly captures italic styling
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/superscript_examples.abbyy.xml`]);

    const exportedMd = await scribe.exportData('md');

    // "Econometrica" is italic in the source document
    assert.include(exportedMd, '*Econometrica*');
  }).timeout(10000);

  it('Bold text should be wrapped with double asterisks', async () => {
    // Use ABBYY format which properly captures bold styling
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/superscript_examples.abbyy.xml`]);

    const exportedMd = await scribe.exportData('md');

    assert.include(exportedMd, '**Investments & Acquisitions**');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check non-contiguous pageArr subsetting for markdown export.', function () {
  this.timeout(10000);

  it('Exporting pages [0, 2] should include pages 0 and 2 but not page 1', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/trident_v_connecticut_general.abbyy.xml`]);

    const exportedMd = await scribe.exportData('md', { pageArr: [0, 2] });

    // "Comstock" only appears on page 0 — should be present
    assert.include(exportedMd, 'Comstock');
    // "Security" only appears on page 2 — should be present
    assert.include(exportedMd, 'Security');
    // "Munger" only appears on page 1 — should not be present
    assert.notInclude(exportedMd, 'Munger');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check markdown table export.', function () {
  this.timeout(10000);

  it('Should export tables as markdown pipe tables', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/border_patrol_tables.abbyy.xml`]);

    const exportedMd = await scribe.exportData('md', { pageArr: [2] });

    // Header row with pipe separators
    assert.include(exportedMd, '| **SECTOR** | **Female** | **Male** | **Total Apprehensions** |');
    // Separator row after header
    assert.include(exportedMd, '| --- | --- | --- | --- |');
    // Specific data row
    assert.include(exportedMd, '| Miami | 220 | 1,671 | 1,891 |');
    assert.include(exportedMd, '| Ramey | 76 | 486 | 562 |');
  }).timeout(10000);

  it('Text outside the table is rendered as regular text', async () => {
    const exportedMd = await scribe.exportData('md', { pageArr: [2] });

    // Page title text appears outside the table
    assert.include(exportedMd, '**United States Border Patrol**');
    assert.include(exportedMd, 'Apprehensions by Gender');
  }).timeout(10000);

  it('Pages without tables export normally', async () => {
    // testocr.abbyy.xml has no tables
    await scribe.clear();
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/testocr.abbyy.xml`]);

    const exportedMd = await scribe.exportData('md');

    assert.include(exportedMd, 'This is a lot of 12 point text');
    assert.notInclude(exportedMd, '| --- |');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);
