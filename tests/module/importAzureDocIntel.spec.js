import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

// Using arrow functions breaks references to `this`.

describe('Check Azure Document Intelligence table import.', () => {
  test('Should import Azure Document Intelligence with PDF document', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/border_patrol_tables.pdf`,
      `${ASSETS_PATH}/border_patrol_tables-AzureDocIntelLayout.json`]);

    expect(scribe.data.ocr.active[0].lines.length > 0).toBe(true);
  });

  test('Should correctly import table structures from Azure Document Intelligence', async () => {
    expect(scribe.data.layoutDataTables.pages[0].tables.length).toBe(1);
    expect(scribe.data.layoutDataTables.pages[0].tables[0].boxes.length).toBe(10);
  });

  test('Should populate rowBounds with correct dimensions', async () => {
    const table = scribe.data.layoutDataTables.pages[0].tables[0];
    expect(table.rowBounds).not.toBeNull();
    expect(table.rowBounds && table.rowBounds.length).toBe(25);
  });

  test('Should correctly extract table content via extractTextFromTables', async () => {
    const tables = scribe.extractTextFromTables(scribe.data.ocr.active[0], scribe.data.layoutDataTables.pages[0]);
    expect(tables.length).toBe(1);
    expect(tables[0].rows.length).toBe(25);
    expect(tables[0].rows[0].length).toBe(10);
  });

  test('Should correctly extract header row content', async () => {
    const tables = scribe.extractTextFromTables(scribe.data.ocr.active[0], scribe.data.layoutDataTables.pages[0]);
    expect(tables[0].rows[0][0]).toContain('SECTOR');
  });

  test('Should correctly extract data row content', async () => {
    const tables = scribe.extractTextFromTables(scribe.data.ocr.active[0], scribe.data.layoutDataTables.pages[0]);
    const miamiRow = tables[0].rows.find((r) => r[0].includes('Miami'));
    expect(miamiRow).not.toBeNull();
    expect(miamiRow[1]).toContain('127');
  });

  test('Should import tables on all pages', async () => {
    expect(scribe.data.layoutDataTables.pages[1].tables.length).toBe(1);
    expect(scribe.data.layoutDataTables.pages[1].tables[0].boxes.length).toBe(6);
    expect(scribe.data.layoutDataTables.pages[2].tables.length).toBe(1);
    expect(scribe.data.layoutDataTables.pages[2].tables[0].boxes.length).toBe(4);
    expect(scribe.data.layoutDataTables.pages[3].tables.length).toBe(1);
    expect(scribe.data.layoutDataTables.pages[3].tables[0].boxes.length).toBe(5);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
