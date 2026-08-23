import {
  describe, test, expect, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

/** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
let doc;

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

// Using arrow functions breaks references to `this`.

describe('Check createTablesFromText and extractTextFromTables.', () => {
  test('Should import document', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/border_patrol_tables.pdf`]);
  });

  // Runs before the createTablesFromText test below, which overwrites page 0's detected tables.
  test('writeXlsxFromSheets builds one named worksheet per detected table', async () => {
    // The workbook's shape is downstream of detection, so the detected input is pinned here in its own right rather than left implied by the sheet names below.
    expect(doc.layoutDataTables.pages.map((p) => p.tables.length), 'each of the four pages carries exactly one detected table').toEqual([1, 1, 1, 1]);
    expect(doc.layoutDataTables.pages.map((p) => p.tables[0].boxes.length), 'the four tables are detected with 10, 6, 4, and 5 columns').toEqual([10, 6, 4, 5]);

    const sheets = [];
    for (let n = 0; n < doc.layoutDataTables.pages.length; n++) {
      const layoutPage = doc.layoutDataTables.pages[n];
      const extracted = scribe.extractTextFromTables(doc.ocr.active[n], layoutPage);
      extracted.forEach((t, idx) => {
        sheets.push({ name: layoutPage.tables[idx].title?.text || `Page ${n + 1} Table ${idx + 1}`, rows: t.rows });
      });
    }
    expect(sheets.map((s) => s.name), 'the document yields one table per page, named by page and position')
      .toEqual(['Page 1 Table 1', 'Page 2 Table 1', 'Page 3 Table 1', 'Page 4 Table 1']);
    expect(sheets.map((s) => s.rows.length), 'each table extracts its full row set').toEqual([25, 25, 25, 19]);
    expect(sheets[0].rows[0][0], 'the SECTOR header cell lands in the header row').toBe('SECTOR');
    expect(sheets[0].rows[1], 'the Miami data row buckets cleanly under the detected row bounds')
      .toEqual(['Miami', '127', '1,891', '1,358', '594', '650', '241', '0', '0', '0']);

    const bytes = await scribe.utils.writeXlsxFromSheets(sheets, { columnWidths: 'auto' });
    const { ZipReader, Uint8ArrayReader, TextWriter } = await import('../../lib/zip.js/index.js');
    const reader = new ZipReader(new Uint8ArrayReader(bytes));
    const entries = await reader.getEntries();
    const byPath = new Map(entries.map((e) => [e.filename, e]));
    expect([...byPath.keys()].filter((p) => p.startsWith('xl/worksheets/')).sort(), 'the workbook carries four worksheet parts')
      .toEqual(['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml', 'xl/worksheets/sheet4.xml']);
    const workbookXml = await byPath.get('xl/workbook.xml').getData(new TextWriter());
    expect(workbookXml.match(/<sheet name="([^"]*)"/g).map((m) => m.slice(13, -1)), 'the workbook lists every sheet by its table name')
      .toEqual(['Page 1 Table 1', 'Page 2 Table 1', 'Page 3 Table 1', 'Page 4 Table 1']);
    const sheet1Xml = await byPath.get('xl/worksheets/sheet1.xml').getData(new TextWriter());
    const sheet2Xml = await byPath.get('xl/worksheets/sheet2.xml').getData(new TextWriter());
    expect(sheet1Xml.includes('<t xml:space="preserve">SECTOR</t>'), 'the SECTOR cell lands in the first worksheet').toBe(true);
    expect(sheet1Xml.includes('tabSelected="1"'), 'the first sheet claims the selected tab').toBe(true);
    expect(sheet2Xml.includes('tabSelected="1"'), 'later sheets do not claim the selected tab').toBe(false);
    await reader.close();
  });

  test('createTablesFromText creates table with column boxes and rowBounds', async () => {
    const tablesPage = scribe.createTablesFromText(0, [{
      rows: [['SECTOR', 'Apprehensions'], ['Miami', '1,891']],
    }], doc.ocr.active[0]);
    doc.layoutDataTables.pages[0] = tablesPage;
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
