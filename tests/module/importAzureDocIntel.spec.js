import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

/** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
let doc;

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

// Using arrow functions breaks references to `this`.

/** @param {import('../../js/objects/ocrObjects.js').OcrPar} par */
const parText = (par) => par.lines.map((line) => line.words.map((word) => word.text).join(' ')).join(' ');

describe('Check Azure Document Intelligence import.', () => {
  test('Should import Azure Document Intelligence with PDF document', async () => {
    /** @type {string[]} */
    const warnings = [];
    const warningHandlerPrev = scribe.opt.warningHandler;
    scribe.opt.warningHandler = (message) => warnings.push(message);
    try {
      doc = await scribe.openDocument([`${ASSETS_PATH}/border_patrol_tables.pdf`,
        `${ASSETS_PATH}/border_patrol_tables-AzureDocIntelLayout.json`]);
    } finally {
      scribe.opt.warningHandler = warningHandlerPrev;
    }

    expect(doc.ocr.active[0].lines.length > 0).toBe(true);
    expect(warnings, 'an Azure file with the PDF\'s page count imports without a page-mismatch warning').toEqual([]);
  });

  test('Should correctly import table structures from Azure Document Intelligence', async () => {
    expect(doc.layoutDataTables.pages[0].tables.length).toBe(1);
    expect(doc.layoutDataTables.pages[0].tables[0].boxes.length).toBe(10);
    expect(doc.layoutDataTables.pages[0].tables[0].detectionMethod, 'vendor table provenance is recorded in detectionMethod').toBe('azure_doc_intel');
  });

  test('Should populate rowBounds with correct dimensions', async () => {
    const table = doc.layoutDataTables.pages[0].tables[0];
    expect(table.rowBounds).not.toBeNull();
    expect(table.rowBounds && table.rowBounds.length).toBe(25);
  });

  test('Should correctly extract table content via extractTextFromTables', async () => {
    const tables = scribe.extractTextFromTables(doc.ocr.active[0], doc.layoutDataTables.pages[0]);
    expect(tables.length).toBe(1);
    expect(tables[0].rows.length).toBe(25);
    expect(tables[0].rows[0].length).toBe(10);
  });

  test('Should correctly extract header row content', async () => {
    const tables = scribe.extractTextFromTables(doc.ocr.active[0], doc.layoutDataTables.pages[0]);
    expect(tables[0].rows[0][0]).toContain('SECTOR');
  });

  test('Should correctly extract data row content', async () => {
    const tables = scribe.extractTextFromTables(doc.ocr.active[0], doc.layoutDataTables.pages[0]);
    const miamiRow = tables[0].rows.find((r) => r[0].includes('Miami'));
    expect(miamiRow).not.toBeNull();
    expect(miamiRow[1]).toContain('127');
  });

  test('Should import tables on all pages', async () => {
    expect(doc.layoutDataTables.pages[1].tables.length).toBe(1);
    expect(doc.layoutDataTables.pages[1].tables[0].boxes.length).toBe(6);
    expect(doc.layoutDataTables.pages[2].tables.length).toBe(1);
    expect(doc.layoutDataTables.pages[2].tables[0].boxes.length).toBe(4);
    expect(doc.layoutDataTables.pages[3].tables.length).toBe(1);
    expect(doc.layoutDataTables.pages[3].tables[0].boxes.length).toBe(5);
  });

  test('Should mark the column-header row of each table', async () => {
    for (let n = 0; n < 4; n++) {
      expect(doc.layoutDataTables.pages[n].tables[0].headerRows, `the table on page ${n + 1} has one header row, per the columnHeader cells`).toBe(1);
    }
  });

  test('Should import Azure paragraphs with their lines in order', async () => {
    expect(doc.ocr.active.map((page) => page.pars.length), 'one paragraph per Azure paragraph on each page').toEqual([257, 153, 103, 102]);

    const page = doc.ocr.active[0];
    expect(page.lines.filter((line) => !line.par).length, 'every line belongs to a paragraph').toBe(0);
    expect(page.pars.flatMap((par) => par.lines).length, 'the paragraphs partition the page lines').toBe(page.lines.length);

    expect(parText(page.pars[0]), 'a three-line paragraph keeps its lines together').toBe('U.S. BORDER PATROL');
    expect(page.pars[0].lines.length, 'the three-line paragraph has three lines').toBe(3);
    expect(parText(page.pars[4]), 'a wrapped table header cell is one paragraph').toBe('Agent Staffing*');
    expect(page.pars[4].lines.length, 'the wrapped header cell has two lines').toBe(2);
  });

  test('Should map Azure paragraph roles onto paragraph types', async () => {
    const page = doc.ocr.active[0];
    expect(parText(page.pars[1]), 'the first title paragraph is the document title').toBe('United States Border Patrol');
    expect(page.pars[1].type, 'the title role becomes a title paragraph').toBe('title');
    expect(page.pars[1].reason, 'the Azure role is recorded as the paragraph reason').toBe('title');
    expect(page.pars.filter((par) => par.type === 'title').length, 'page 1 has two title paragraphs').toBe(2);
    expect(page.pars[0].type, 'a paragraph without a role is body text').toBe('body');
    expect(page.pars[0].reason, 'a paragraph without a role records a plain paragraph reason').toBe('paragraph');
  });

  test('Reflowed text export joins the lines of each Azure paragraph and nothing else', async () => {
    const text = await doc.exportData('text');
    // Each table header cell is its own Azure paragraph.
    expect(text, 'the header cells export one per line, with the wrapped cells joined').toContain('\nSECTOR\nAgent Staffing*\nApprehensions\nOther Than Mexican Apprehensions\n');
    expect(text, 'a two-line footnote paragraph exports as one line, joined where its lines break')
      .toContain('\nSouthwest Border Sectors include: Big Bend, Del Rio, El Centro, El Paso, Laredo, Rio Grande Valley, San Diego, Tucson, and Yuma. Drug quantities are');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
