// Relative imports are required to run in browser.
/* eslint-disable import/no-relative-packages */
import { assert, config } from '../../node_modules/chai/chai.js';
import scribe from '../../scribe.js';
import { ASSETS_PATH_KARMA } from '../constants.js';

scribe.opt.workerN = 1;

config.truncateThreshold = 0; // Disable truncation for actual/expected values on assertion failure.

// Using arrow functions breaks references to `this`.
/* eslint-disable prefer-arrow-callback */
/* eslint-disable func-names */

describe('Check createTablesFromText and extractTextFromTables.', function () {
  this.timeout(10000);

  it('Should import document', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/border_patrol_tables.pdf`]);
  }).timeout(10000);

  it('createTablesFromText creates table with column boxes and rowBounds', async () => {
    const tablesPage = scribe.createTablesFromText(0, [{
      rows: [['SECTOR', 'Apprehensions'], ['Miami', '1,891']],
    }], scribe.data.ocr.active[0]);
    scribe.data.layoutDataTables.pages[0] = tablesPage;
    const table = tablesPage.tables[0];
    assert.strictEqual(table.boxes.length, 2);
    assert.strictEqual(table.rowBounds.length, 2);
  }).timeout(10000);

  it('extractTextFromTables returns empty array for page without tables', async () => {
    const tables = scribe.extractTextFromTables(null, null);
    assert.deepStrictEqual(tables, []);
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);
