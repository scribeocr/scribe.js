import {
  describe, test, expect, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

/**
 * @param {Uint8Array} bytes - xlsx workbook.
 * @param {string} path - zip part to read.
 */
async function readXlsxPart(bytes, path) {
  const { ZipReader, Uint8ArrayReader, TextWriter } = await import('../../lib/zip.js/index.js');
  const reader = new ZipReader(new Uint8ArrayReader(bytes));
  const entries = await reader.getEntries();
  const content = await entries.find((e) => e.filename === path).getData(new TextWriter());
  await reader.close();
  return content;
}

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

    // A one-sheet workbook patches its boilerplate to byte-identical content, which a changed-the-text check read as a missing anchor.
    const soloBytes = await scribe.utils.writeXlsxFromSheets([sheets[0]], { columnWidths: 'auto' });
    const soloReader = new ZipReader(new Uint8ArrayReader(soloBytes));
    const soloByPath = new Map((await soloReader.getEntries()).map((e) => [e.filename, e]));
    expect([...soloByPath.keys()].filter((p) => p.startsWith('xl/worksheets/')), 'a single-table export writes exactly one worksheet part')
      .toEqual(['xl/worksheets/sheet1.xml']);
    const soloTypesXml = await soloByPath.get('[Content_Types].xml').getData(new TextWriter());
    expect((soloTypesXml.match(/\/xl\/worksheets\/sheet\d+\.xml/g) || []).length, 'the one-sheet workbook declares exactly one worksheet content type').toBe(1);
    const soloWorkbookXml = await soloByPath.get('xl/workbook.xml').getData(new TextWriter());
    expect(soloWorkbookXml.match(/<sheet name="([^"]*)"/g).map((m) => m.slice(13, -1)), 'the lone sheet keeps its table name rather than the boilerplate Sheet1')
      .toEqual(['Page 1 Table 1']);
    const soloAppXml = await soloByPath.get('docProps/app.xml').getData(new TextWriter());
    expect(soloAppXml.includes('<vt:vector size="1" baseType="lpstr"><vt:lpstr>Page 1 Table 1</vt:lpstr></vt:vector>'), 'the one-sheet workbook titles-of-parts names the sheet').toBe(true);
    await soloReader.close();
  });

  // Runs before the createTablesFromText test below, which overwrites page 0's detected tables.
  test('formatted export carries source styling; plain export keeps bold underlined headers only', async () => {
    const rich = scribe.extractTextFromTables(doc.ocr.active[0], doc.layoutDataTables.pages[0], { cellFormats: true });
    const headerCell = rich[0].rows[0][0];
    expect(headerCell.text, 'rich extraction keeps the plain cell text alongside runs').toBe('SECTOR');
    expect(headerCell.runs.length, 'a uniformly-styled header cell extracts as a single run').toBe(1);
    expect(headerCell.runs[0].style.bold, 'the SECTOR header keeps its source bold').toBe(true);
    expect(headerCell.runs[0].style.font, 'the SECTOR header keeps its source font family').toBe('Arial');
    expect(headerCell.runs[0].style.size, 'the SECTOR header keeps its source size (px at 300dpi)').toBe(57);
    const mixedCell = rich[0].rows[0][4];
    expect(mixedCell.runs.map((r) => r.text), 'a mixed-size header cell splits into one run per style').toEqual(['Marijuana ', '(pounds)']);
    expect(mixedCell.runs.map((r) => r.style.size), 'the (pounds) qualifier keeps its smaller source size').toEqual([41, 32.5]);

    expect(doc.layoutDataTables.pages[0].tables[0].headerRows, 'the all-text first row inside the grid classifies as one header row').toBe(1);
    const chains = scribe.extractDocTableChains(doc.ocr.active, doc.layoutDataTables.pages, { cellFormats: true });
    expect(chains.map((c) => c.headerRows), 'each chain resolves one header row for styling').toEqual([1, 1, 1, 1]);

    const richRows = chains[0].rows;
    const richBytes = await scribe.utils.writeXlsxFromSheets([{
      name: 'Rich',
      rows: richRows,
      tableRanges: [{
        start: 0, rowCount: richRows.length, headerRows: chains[0].headerRows, grid: true, alignNumeric: true,
      }],
      columnWidths: [30, 10, 14, 19, 12, 10, 12, 8, 8, 8],
    }], { columnWidths: 'auto' });
    const richSheet1 = await readXlsxPart(richBytes, 'xl/worksheets/sheet1.xml');
    expect(richSheet1.includes('<c r="A1" s="2" t="inlineStr"><is><r><rPr><b/><sz val="13.5"/><rFont val="Arial"/></rPr><t xml:space="preserve">SECTOR</t></r></is></c>'),
      'the header cell writes a bold 13.5pt Arial rich run with the grid header style').toBe(true);
    expect(richSheet1.includes('<c r="B2" s="4" t="inlineStr">'), 'a numeric data column right-aligns inside the grid').toBe(true);
    expect(richSheet1.includes('<col min="1" max="1" width="30" customWidth="1"/>'), 'per-sheet column widths override the auto widths').toBe(true);
    const richStyles = await readXlsxPart(richBytes, 'xl/styles.xml');
    const gridBorderXml = '<border><left style="thin"><color indexed="64"/></left><right style="thin"><color indexed="64"/></right>'
      + '<top style="thin"><color indexed="64"/></top><bottom style="thin"><color indexed="64"/></bottom><diagonal/></border>';
    expect(richStyles.includes(gridBorderXml), 'the stylesheet grows a full thin-grid border for grid-detected tables').toBe(true);
    expect(richStyles.match(/<cellXfs count="(\d+)"/)[1], 'the grid workbook interns exactly three new cell formats').toBe('5');

    const plainRows = scribe.extractDocTableChains(doc.ocr.active, doc.layoutDataTables.pages)[0].rows;
    const plainBytes = await scribe.utils.writeXlsxFromSheets([{
      name: 'Plain',
      rows: plainRows,
      tableRanges: [{ start: 0, rowCount: plainRows.length, headerRows: 1 }],
    }], { columnWidths: 'auto' });
    const noRangeBytes = await scribe.utils.writeXlsxFromSheets([{ name: 'Plain', rows: plainRows }], { columnWidths: 'auto' });
    const plainSheet1 = await readXlsxPart(plainBytes, 'xl/worksheets/sheet1.xml');
    expect(plainSheet1.includes('<c r="A1" s="1" t="inlineStr">'), 'plain-mode headers carry the bold+underline style').toBe(true);
    expect(plainSheet1.includes('<c r="A2" t="inlineStr">'), 'plain-mode data cells stay unstyled').toBe(true);
    expect(await readXlsxPart(plainBytes, 'xl/styles.xml'), 'header-only ranges leave the stylesheet byte-identical to an unstyled workbook')
      .toBe(await readXlsxPart(noRangeBytes, 'xl/styles.xml'));
  });

  test('exportData xlsx merges same-style runs and emits no invalid smallCaps element', async () => {
    const legacy = await doc.exportData('xlsx');
    const legacyBytes = legacy instanceof Uint8Array ? legacy : new Uint8Array(legacy);
    const sheet1 = await readXlsxPart(legacyBytes, 'xl/worksheets/sheet1.xml');
    // Without run coalescing each word opens a run of its own, splitting a multi-word bold header into one run per word.
    expect(sheet1.includes('<r><rPr><b/></rPr><t xml:space="preserve">Other Apprehensions Than Mexican</t></r>'),
      'adjacent bold header words coalesce into one rich run').toBe(true);
    expect(sheet1.includes('<smallCaps/>'), 'the WordprocessingML smallCaps element never reaches xlsx output').toBe(false);
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
