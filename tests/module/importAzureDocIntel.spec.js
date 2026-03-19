// Relative imports are required to run in browser.
/* eslint-disable import/no-relative-packages */
import { assert, config } from '../../node_modules/chai/chai.js';
import scribe from '../../scribe.js';
import { ASSETS_PATH_KARMA } from '../constants.js';

config.truncateThreshold = 0; // Disable truncation for actual/expected values on assertion failure.

// Using arrow functions breaks references to `this`.
/* eslint-disable prefer-arrow-callback */
/* eslint-disable func-names */

describe('Check Azure Document Intelligence table import.', function () {
  this.timeout(10000);

  it('Should import Azure Document Intelligence with PDF document', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/border_patrol_tables.pdf`,
      `${ASSETS_PATH_KARMA}/border_patrol_tables-AzureDocIntelLayout.json`]);

    assert.isTrue(scribe.data.ocr.active[0].lines.length > 0);
  }).timeout(10000);

  it('Should correctly import table structures from Azure Document Intelligence', async () => {
    assert.strictEqual(scribe.data.layoutDataTables.pages[0].tables.length, 1);
    assert.strictEqual(scribe.data.layoutDataTables.pages[0].tables[0].boxes.length, 10);
  }).timeout(10000);

  it('Should populate rowBounds with correct dimensions', async () => {
    const table = scribe.data.layoutDataTables.pages[0].tables[0];
    assert.isNotNull(table.rowBounds);
    assert.strictEqual(table.rowBounds && table.rowBounds.length, 25);
  }).timeout(10000);

  it('Should correctly extract table content via extractTextFromTables', async () => {
    const tables = scribe.extractTextFromTables(scribe.data.ocr.active[0], scribe.data.layoutDataTables.pages[0]);
    assert.strictEqual(tables.length, 1);
    assert.strictEqual(tables[0].rows.length, 25);
    assert.strictEqual(tables[0].rows[0].length, 10);
  }).timeout(10000);

  it('Should correctly extract header row content', async () => {
    const tables = scribe.extractTextFromTables(scribe.data.ocr.active[0], scribe.data.layoutDataTables.pages[0]);
    assert.include(tables[0].rows[0][0], 'SECTOR');
  }).timeout(10000);

  it('Should correctly extract data row content', async () => {
    const tables = scribe.extractTextFromTables(scribe.data.ocr.active[0], scribe.data.layoutDataTables.pages[0]);
    const miamiRow = tables[0].rows.find((r) => r[0].includes('Miami'));
    assert.isNotNull(miamiRow);
    assert.include(miamiRow[1], '127');
  }).timeout(10000);

  it('Should import tables on all pages', async () => {
    assert.strictEqual(scribe.data.layoutDataTables.pages[1].tables.length, 1);
    assert.strictEqual(scribe.data.layoutDataTables.pages[1].tables[0].boxes.length, 6);
    assert.strictEqual(scribe.data.layoutDataTables.pages[2].tables.length, 1);
    assert.strictEqual(scribe.data.layoutDataTables.pages[2].tables[0].boxes.length, 4);
    assert.strictEqual(scribe.data.layoutDataTables.pages[3].tables.length, 1);
    assert.strictEqual(scribe.data.layoutDataTables.pages[3].tables[0].boxes.length, 5);
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);
