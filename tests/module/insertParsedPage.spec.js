import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { removeCircularRefsOcr } from '../../js/objects/ocrObjects.js';
import {
  LayoutDataColumn, LayoutDataTable, LayoutDataTablePage, removeCircularRefsDataTables,
} from '../../js/objects/layoutObjects.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

const PAGE_COUNT = 7;
const PDF_PATH = `${ASSETS_PATH}/trident_v_connecticut_general.pdf`;

async function readFileContent(filePath) {
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    const fs = await import('node:fs/promises');
    return fs.readFile(filePath, 'utf-8');
  }
  const response = await fetch(filePath);
  return response.text();
}

function makeFixtureModel(name, outputFormat) {
  return class {
    static config = { name, outputFormat };

    static fixturePages = [];

    static pageIndex = 0;

    static async recognizeImage() {
      const rawData = this.fixturePages[this.pageIndex];
      this.pageIndex++;
      return { success: true, rawData, format: outputFormat };
    }
  };
}

async function loadGoogleVisionFixtures() {
  const dir = `${ASSETS_PATH}/trident_v_connecticut_general/googleVision`;
  const pages = [];
  for (let i = 0; i < PAGE_COUNT; i++) {
    const filename = `trident_v_connecticut_general_${String(i).padStart(3, '0')}-GoogleVisionSync.json`;
    pages.push(await readFileContent(`${dir}/${filename}`));
  }
  return pages;
}

describe('Round-trip through removeCircularRefsOcr + insertParsedPage matches recognition output.', () => {
  const engineName = 'Fixture Engine';
  const FixtureModel = makeFixtureModel(engineName, 'google_vision');

  let docA;
  let docB;
  const eventsB = [];

  beforeAll(async () => {
    FixtureModel.fixturePages = await loadGoogleVisionFixtures();
    FixtureModel.pageIndex = 0;

    docA = await scribe.openDocument([PDF_PATH]);
    await docA.recognize({ model: FixtureModel });

    docB = await scribe.openDocument([PDF_PATH]);
    docB.progressHandler = (msg) => { eventsB.push(msg); };

    for (let n = 0; n < PAGE_COUNT; n++) {
      const wireBytes = JSON.stringify(removeCircularRefsOcr([docA.ocr[engineName][n]])[0]);
      const parsedPage = JSON.parse(wireBytes);
      docB.insertParsedPage(n, parsedPage, {
        engineName,
        warn: docA.convertPageWarn[n] || {},
      });
    }
  });

  test('engine array is fully populated and active points at it', () => {
    expect(docB.ocr[engineName].length).toBe(PAGE_COUNT);
    expect(docB.ocr.active).toBe(docB.ocr[engineName]);
  });

  test('pageMetrics dims match source for every page', () => {
    for (let n = 0; n < PAGE_COUNT; n++) {
      expect(docB.pageMetrics[n].dims.width).toBe(docA.pageMetrics[n].dims.width);
      expect(docB.pageMetrics[n].dims.height).toBe(docA.pageMetrics[n].dims.height);
      expect(docB.pageMetrics[n].angle).toBe(docA.pageMetrics[n].angle);
    }
  });

  test('xmlMode set to true for every page', () => {
    for (let n = 0; n < PAGE_COUNT; n++) {
      expect(docB.inputData.xmlMode[n]).toBe(true);
    }
  });

  test('convertPageWarn matches source for every page', () => {
    for (let n = 0; n < PAGE_COUNT; n++) {
      expect(docB.convertPageWarn[n]).toEqual(docA.convertPageWarn[n] || {});
    }
  });

  test('first page has 772 words matching docA', () => {
    const wordsA = docA.ocr[engineName][0].lines.flatMap((l) => l.words);
    const wordsB = docB.ocr[engineName][0].lines.flatMap((l) => l.words);
    expect(wordsA.length).toBe(772);
    expect(wordsB.length).toBe(772);
  });

  test('first word of first page matches docA exactly', () => {
    const firstWordA = docA.ocr[engineName][0].lines[0].words[0];
    const firstWordB = docB.ocr[engineName][0].lines[0].words[0];
    expect(firstWordB.text).toBe(firstWordA.text);
    expect(firstWordB.id).toBe(firstWordA.id);
  });

  test('line.page back-reference is restored', () => {
    const page0 = docB.ocr[engineName][0];
    expect(page0.lines[0].page).toBe(page0);
  });

  test('word.line back-reference is restored', () => {
    const line0 = docB.ocr[engineName][0].lines[0];
    expect(line0.words[0].line).toBe(line0);
  });

  test('par.lines is reconstructed from lineIds and par.page is restored', () => {
    const page0 = docB.ocr[engineName][0];
    expect(page0.pars.length).toBeGreaterThan(0);
    const par0 = page0.pars[0];
    expect(par0.page).toBe(page0);
    expect(Array.isArray(par0.lines)).toBe(true);
    expect(par0.lines[0]).toBe(page0.lines.find((l) => l.id === par0.lines[0].id));
    expect(par0.lines[0].par).toBe(par0);
  });

  test('progressHandler received exactly PAGE_COUNT convert events', () => {
    const converts = eventsB.filter((m) => m.type === 'convert' && m.info && m.info.engineName === engineName);
    expect(converts.length).toBe(PAGE_COUNT);
    expect(converts.map((m) => m.n).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  afterAll(async () => {
    await docA.close();
    await docB.close();
    await scribe.terminate();
  });
});

describe('insertParsedPage round-trips layout dataTables and restores circular refs.', () => {
  const engineName = 'Synthetic Tables Engine';
  const FixtureModel = makeFixtureModel(engineName, 'google_vision');
  const TARGET_PAGE = 0;

  let doc;
  let wirePage;
  let insertedTableId;
  let insertedColumnId;

  beforeAll(async () => {
    FixtureModel.fixturePages = await loadGoogleVisionFixtures();
    FixtureModel.pageIndex = 0;

    const sourceDoc = await scribe.openDocument([PDF_PATH]);
    await sourceDoc.recognize({ model: FixtureModel });

    const sourceTables = new LayoutDataTablePage(TARGET_PAGE);
    const table = new LayoutDataTable(sourceTables);
    table.boxes.push(new LayoutDataColumn({
      left: 10, top: 20, right: 100, bottom: 200,
    }, table));
    table.boxes.push(new LayoutDataColumn({
      left: 110, top: 20, right: 200, bottom: 200,
    }, table));
    sourceTables.tables.push(table);
    insertedTableId = table.id;
    insertedColumnId = table.boxes[0].id;

    doc = await scribe.openDocument([PDF_PATH]);

    wirePage = JSON.parse(JSON.stringify(removeCircularRefsOcr([sourceDoc.ocr[engineName][TARGET_PAGE]])[0]));
    const wireTables = JSON.parse(JSON.stringify(removeCircularRefsDataTables([sourceTables])[0]));
    doc.insertParsedPage(TARGET_PAGE, wirePage, {
      engineName,
      dataTables: wireTables,
    });

    await sourceDoc.close();
  });

  test('target page has one table after insertion', () => {
    expect(doc.layoutDataTables.pages[TARGET_PAGE].tables.length).toBe(1);
  });

  test('table id and box id round-trip', () => {
    const installedTable = doc.layoutDataTables.pages[TARGET_PAGE].tables[0];
    expect(installedTable.id).toBe(insertedTableId);
    expect(installedTable.boxes.length).toBe(2);
    expect(installedTable.boxes[0].id).toBe(insertedColumnId);
  });

  test('table.page back-reference is restored', () => {
    const installedPage = doc.layoutDataTables.pages[TARGET_PAGE];
    expect(installedPage.tables[0].page).toBe(installedPage);
  });

  test('box.table back-reference is restored', () => {
    const installedTable = doc.layoutDataTables.pages[TARGET_PAGE].tables[0];
    expect(installedTable.boxes[0].table).toBe(installedTable);
  });

  // A requested table result must not be silently discarded by first-writer-wins, while a user-edited page always wins.
  test('repeat insertions follow the table merge policy', () => {
    const makeTablesPage = (n) => {
      const tablesPage = new LayoutDataTablePage(n);
      const table = new LayoutDataTable(tablesPage);
      table.boxes.push(new LayoutDataColumn({
        left: 10, top: 20, right: 100, bottom: 200,
      }, table));
      tablesPage.tables.push(table);
      return tablesPage;
    };

    const replacing = makeTablesPage(TARGET_PAGE);
    doc.insertParsedPage(TARGET_PAGE, wirePage, { engineName, dataTables: replacing });
    expect(doc.layoutDataTables.pages[TARGET_PAGE].tables[0].id, 'a table-bearing main result replaces a page\'s default tables instead of being silently discarded').toBe(replacing.tables[0].id);

    doc.layoutDataTables.pages[TARGET_PAGE].default = false;
    doc.insertParsedPage(TARGET_PAGE, wirePage, { engineName, dataTables: makeTablesPage(TARGET_PAGE) });
    expect(doc.layoutDataTables.pages[TARGET_PAGE].tables[0].id, 'a page whose tables the user edited keeps them through a later table-bearing result').toBe(replacing.tables[0].id);

    doc.layoutDataTables.pages[TARGET_PAGE].default = true;
    doc.insertParsedPage(TARGET_PAGE, wirePage, { engineName, dataTables: new LayoutDataTablePage(TARGET_PAGE) });
    expect(doc.layoutDataTables.pages[TARGET_PAGE].tables[0].id, 'a result with no tables never wipes a page\'s existing tables').toBe(replacing.tables[0].id);

    doc.insertParsedPage(TARGET_PAGE, wirePage, { engineName, dataTables: makeTablesPage(TARGET_PAGE), mainData: false });
    expect(doc.layoutDataTables.pages[TARGET_PAGE].tables[0].id, 'a supplemental (mainData: false) result does not replace existing tables').toBe(replacing.tables[0].id);

    const EMPTY_PAGE = 1;
    const filling = makeTablesPage(EMPTY_PAGE);
    doc.insertParsedPage(EMPTY_PAGE, wirePage, { engineName, dataTables: filling, mainData: false });
    expect(doc.layoutDataTables.pages[EMPTY_PAGE].tables[0].id, 'a table-bearing result still fills an empty page regardless of mainData').toBe(filling.tables[0].id);
  });

  afterAll(async () => {
    await doc.close();
    await scribe.terminate();
  });
});

describe('setActive=false leaves doc.ocr.active untouched.', () => {
  const engineName = 'No-Active Engine';
  const FixtureModel = makeFixtureModel(engineName, 'google_vision');

  let doc;

  beforeAll(async () => {
    FixtureModel.fixturePages = await loadGoogleVisionFixtures();
    FixtureModel.pageIndex = 0;

    const sourceDoc = await scribe.openDocument([PDF_PATH]);
    await sourceDoc.recognize({ model: FixtureModel });

    doc = await scribe.openDocument([PDF_PATH]);
    const initialActive = doc.ocr.active;
    expect(doc.ocr.active).toBe(initialActive);

    for (let n = 0; n < PAGE_COUNT; n++) {
      const wirePage = JSON.parse(JSON.stringify(removeCircularRefsOcr([sourceDoc.ocr[engineName][n]])[0]));
      doc.insertParsedPage(n, wirePage, { engineName, setActive: false });
    }
    doc._initialActive = initialActive;

    await sourceDoc.close();
  });

  test('doc.ocr.active is unchanged after insertion with setActive=false', () => {
    expect(doc.ocr.active).toBe(doc._initialActive);
  });

  test('engine slot is still populated', () => {
    expect(doc.ocr[engineName].length).toBe(PAGE_COUNT);
    expect(doc.ocr[engineName][0]).toBeTruthy();
  });

  afterAll(async () => {
    await doc.close();
    await scribe.terminate();
  });
});

describe('mainData=false skips pageMetrics and convertPageWarn writes.', () => {
  const engineName = 'Secondary Engine';
  const FixtureModel = makeFixtureModel(engineName, 'google_vision');

  let doc;
  let pageMetricsBefore;

  beforeAll(async () => {
    FixtureModel.fixturePages = await loadGoogleVisionFixtures();
    FixtureModel.pageIndex = 0;

    const sourceDoc = await scribe.openDocument([PDF_PATH]);
    await sourceDoc.recognize({ model: FixtureModel });

    doc = await scribe.openDocument([PDF_PATH]);
    pageMetricsBefore = doc.pageMetrics.map((pm) => ({
      width: pm.dims.width,
      height: pm.dims.height,
      angle: pm.angle,
    }));

    for (let n = 0; n < PAGE_COUNT; n++) {
      const wirePage = JSON.parse(JSON.stringify(removeCircularRefsOcr([sourceDoc.ocr[engineName][n]])[0]));
      doc.insertParsedPage(n, wirePage, {
        engineName,
        mainData: false,
        warn: { ignored: 'should-not-write' },
      });
    }

    await sourceDoc.close();
  });

  test('pageMetrics width/height unchanged from pre-insertion state', () => {
    for (let n = 0; n < PAGE_COUNT; n++) {
      expect(doc.pageMetrics[n].dims.width).toBe(pageMetricsBefore[n].width);
      expect(doc.pageMetrics[n].dims.height).toBe(pageMetricsBefore[n].height);
    }
  });

  test('convertPageWarn was not written', () => {
    for (let n = 0; n < PAGE_COUNT; n++) {
      expect(doc.convertPageWarn[n]).toBeUndefined();
    }
  });

  test('engine slot is still populated', () => {
    expect(doc.ocr[engineName].length).toBe(PAGE_COUNT);
    expect(doc.ocr[engineName][0]).toBeTruthy();
  });

  afterAll(async () => {
    await doc.close();
    await scribe.terminate();
  });
});
