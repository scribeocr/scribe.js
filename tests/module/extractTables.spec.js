import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

// Using arrow functions breaks references to `this`.

describe('Check createTablesFromText and extractTextFromTables.', () => {
  test('Should import document', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/border_patrol_tables.pdf`]);
  });

  test('createTablesFromText creates table with column boxes and rowBounds', async () => {
    const tablesPage = scribe.createTablesFromText(0, [{
      rows: [['SECTOR', 'Apprehensions'], ['Miami', '1,891']],
    }], scribe.data.ocr.active[0]);
    scribe.data.layoutDataTables.pages[0] = tablesPage;
    const table = tablesPage.tables[0];
    expect(table.boxes.length).toBe(2);
    expect(table.rowBounds.length).toBe(2);
  });

  test('extractTextFromTables returns empty array for page without tables', async () => {
    const tables = scribe.extractTextFromTables(null, null);
    expect(tables).toEqual([]);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
