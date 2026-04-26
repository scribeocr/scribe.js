import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

// Using arrow functions breaks references to `this`.

describe('Check Abbyy XML import function.', () => {
  test('Should import Abbyy XML with PNG image', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/ascenders_descenders_test.png`,
      `${ASSETS_PATH}/ascenders_descenders_test.abbyy.xml`]);
  });

  test('Should correctly import text content from Abbyy XML (default settings)', async () => {
    const text1 = scribe.data.ocr.active[0].lines[0].words.map((x) => x.text).join(' ');
    const text2 = scribe.data.ocr.active[0].lines[1].words.map((x) => x.text).join(' ');
    const text3 = scribe.data.ocr.active[0].lines[2].words.map((x) => x.text).join(' ');

    expect(text1).toBe('Ascenders On');
    expect(text2).toBe('query png');
    expect(text3).toBe('we can');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check Abbyy XML import function.', () => {
  test('Should import Abbyy XML without image/PDF inputs', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/econometrica_example.abbyy.xml`]);
  });

  test('Should correctly import smallcaps attribute', async () => {
    const text1 = scribe.data.ocr.active[0].lines[4].words.map((x) => x.text).join(' ');

    const text2 = scribe.data.ocr.active[0].lines[23].words.map((x) => x.text).join(' ');

    expect(text1).toBe('Shubhdeep Deb');

    expect(text2).toBe('Wage inequality in the United States has risen sharply since the 1980s. The skill');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check that text orientation is handled correctly in Abbyy imports (simple layout).', () => {
  test('Lines printed at exactly 90/180/270 degrees have orientation detected correctly', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/testocr_all_orientations.abbyy.xml`]);
    expect(scribe.data.ocr.active[0].lines[0].words[0].line.orientation).toBe(0);
    expect(scribe.data.ocr.active[1].lines[0].words[0].line.orientation).toBe(0);
    expect(scribe.data.ocr.active[2].lines[0].words[0].line.orientation).toBe(0);
    expect(scribe.data.ocr.active[3].lines[0].words[0].line.orientation).toBe(3);
    expect(scribe.data.ocr.active[4].lines[0].words[0].line.orientation).toBe(3);
    expect(scribe.data.ocr.active[5].lines[0].words[0].line.orientation).toBe(3);
    expect(scribe.data.ocr.active[6].lines[0].words[0].line.orientation).toBe(2);
    expect(scribe.data.ocr.active[7].lines[0].words[0].line.orientation).toBe(2);
    expect(scribe.data.ocr.active[8].lines[0].words[0].line.orientation).toBe(2);
    expect(scribe.data.ocr.active[9].lines[0].words[0].line.orientation).toBe(1);
    expect(scribe.data.ocr.active[10].lines[0].words[0].line.orientation).toBe(1);
    expect(scribe.data.ocr.active[11].lines[0].words[0].line.orientation).toBe(1);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check that text orientation is handled correctly in Abbyy imports.', () => {
  test('Lines printed at exactly 90/180/270 degrees have orientation detected correctly', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/CSF_Proposed_Budget_Book_June_2024_r8_30_all_orientations.abbyy.xml`]);
    expect(scribe.data.ocr.active[0].lines[2].words[0].line.orientation).toBe(3);
    expect(scribe.data.ocr.active[3].lines[2].words[0].line.orientation).toBe(2);
    expect(scribe.data.ocr.active[2].lines[2].words[0].line.orientation).toBe(1);
  });

  // The following tests compare the coordinates of a rotated line to the same line in a non-rotated version of the same document.
  test('Lines oriented at 90 degrees counterclockwise have coordinates calculated correctly', async () => {
    expect(Math.abs((scribe.data.ocr.active[0].lines[2].words[0].bbox.left) - (scribe.data.ocr.active[1].lines[2].words[0].bbox.left))).toBeLessThanOrEqual(1);
    expect(Math.abs((scribe.data.ocr.active[0].lines[2].words[0].bbox.right) - (scribe.data.ocr.active[1].lines[2].words[0].bbox.right))).toBeLessThanOrEqual(1);
    expect(Math.abs((scribe.data.ocr.active[0].lines[2].words[0].bbox.top) - (scribe.data.ocr.active[1].lines[2].words[0].bbox.top))).toBeLessThanOrEqual(1);
    expect(Math.abs((scribe.data.ocr.active[0].lines[2].words[0].bbox.bottom) - (scribe.data.ocr.active[1].lines[2].words[0].bbox.bottom))).toBeLessThanOrEqual(1);
  });

  test('Lines oriented at 90 degrees clockwise have coordinates calculated correctly', async () => {
    expect(Math.abs((scribe.data.ocr.active[2].lines[2].words[0].bbox.left) - (scribe.data.ocr.active[1].lines[2].words[0].bbox.left))).toBeLessThanOrEqual(1);
    // This requires a larger tolerance, however the issue appears to be with the input rather than the parsing.
    expect(Math.abs((scribe.data.ocr.active[2].lines[2].words[0].bbox.right) - (scribe.data.ocr.active[1].lines[2].words[0].bbox.right))).toBeLessThanOrEqual(2);
    expect(Math.abs((scribe.data.ocr.active[2].lines[2].words[0].bbox.top) - (scribe.data.ocr.active[1].lines[2].words[0].bbox.top))).toBeLessThanOrEqual(1);
    expect(Math.abs((scribe.data.ocr.active[2].lines[2].words[0].bbox.bottom) - (scribe.data.ocr.active[1].lines[2].words[0].bbox.bottom))).toBeLessThanOrEqual(1);
  });

  test('Lines oriented at 180 degrees have coordinates calculated correctly', async () => {
    expect(Math.abs((scribe.data.ocr.active[3].lines[2].words[0].bbox.left) - (scribe.data.ocr.active[1].lines[2].words[0].bbox.left))).toBeLessThanOrEqual(1);
    expect(Math.abs((scribe.data.ocr.active[3].lines[2].words[0].bbox.right) - (scribe.data.ocr.active[1].lines[2].words[0].bbox.right))).toBeLessThanOrEqual(1);
    expect(Math.abs((scribe.data.ocr.active[3].lines[2].words[0].bbox.top) - (scribe.data.ocr.active[1].lines[2].words[0].bbox.top))).toBeLessThanOrEqual(1);
    expect(Math.abs((scribe.data.ocr.active[3].lines[2].words[0].bbox.bottom) - (scribe.data.ocr.active[1].lines[2].words[0].bbox.bottom))).toBeLessThanOrEqual(1);
  });

  test('Lines oriented at 90/180/270 degrees have line rotation detected correctly', async () => {
    expect(Math.abs((scribe.data.ocr.active[4].lines[0].baseline[0]) - (Math.tan(5 * (Math.PI / 180))))).toBeLessThanOrEqual(0.01);
    expect(Math.abs((scribe.data.ocr.active[6].lines[0].baseline[0]) - (Math.tan(5 * (Math.PI / 180))))).toBeLessThanOrEqual(0.01);
    expect(Math.abs((scribe.data.ocr.active[8].lines[0].baseline[0]) - (Math.tan(5 * (Math.PI / 180))))).toBeLessThanOrEqual(0.01);
    expect(Math.abs((scribe.data.ocr.active[10].lines[0].baseline[0]) - (Math.tan(5 * (Math.PI / 180))))).toBeLessThanOrEqual(0.01);
    expect(Math.abs((scribe.data.ocr.active[5].lines[0].baseline[0]) - (-Math.tan(5 * (Math.PI / 180))))).toBeLessThanOrEqual(0.01);
    expect(Math.abs((scribe.data.ocr.active[7].lines[0].baseline[0]) - (-Math.tan(5 * (Math.PI / 180))))).toBeLessThanOrEqual(0.01);
    expect(Math.abs((scribe.data.ocr.active[9].lines[0].baseline[0]) - (-Math.tan(5 * (Math.PI / 180))))).toBeLessThanOrEqual(0.01);
    expect(Math.abs((scribe.data.ocr.active[11].lines[0].baseline[0]) - (-Math.tan(5 * (Math.PI / 180))))).toBeLessThanOrEqual(0.01);

    expect(Math.abs((scribe.data.pageMetrics[4].angle) - (5))).toBeLessThanOrEqual(1);
    expect(Math.abs((scribe.data.pageMetrics[6].angle) - (5))).toBeLessThanOrEqual(1);
    expect(Math.abs((scribe.data.pageMetrics[8].angle) - (5))).toBeLessThanOrEqual(1);
    expect(Math.abs((scribe.data.pageMetrics[10].angle) - (5))).toBeLessThanOrEqual(1);
    expect(Math.abs((scribe.data.pageMetrics[5].angle) - (-5))).toBeLessThanOrEqual(1);
    expect(Math.abs((scribe.data.pageMetrics[7].angle) - (-5))).toBeLessThanOrEqual(1);
    expect(Math.abs((scribe.data.pageMetrics[9].angle) - (-5))).toBeLessThanOrEqual(1);
    expect(Math.abs((scribe.data.pageMetrics[11].angle) - (-5))).toBeLessThanOrEqual(1);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check that empty pages are handled correctly in Abbyy imports.', () => {
  test('Check that empty pages are handled correctly in Abbyy imports.', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/yearbook_of_foreign_trade_statistics_of_poland_2024.abbyy.xml`]);
    expect(scribe.data.ocr.active[0].lines.length).toBe(7);
    expect(scribe.data.ocr.active[1].lines.length).toBe(0);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check that font style is detected for Abbyy xml imports.', () => {
  test('Bold style is detected', async () => {
    scribe.opt.usePDFText.native.main = true;
    await scribe.importFiles([`${ASSETS_PATH}/complaint_1.abbyy.xml`]);
    expect(scribe.data.ocr.active[1].lines[3].words[0].style.bold).toBe(true);
    expect(scribe.data.ocr.active[1].lines[3].words[0].style.italic).toBe(false);
    expect(scribe.data.ocr.active[1].lines[3].words[0].style.underline).toBe(false);
  });

  test('Bold + italic style is detected', async () => {
    expect(scribe.data.ocr.active[0].lines[1].words[0].style.italic).toBe(true);
    expect(scribe.data.ocr.active[0].lines[1].words[0].style.bold).toBe(true);
    expect(scribe.data.ocr.active[0].lines[1].words[0].style.underline).toBe(false);
  });

  test('Italic style is detected', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.xml`]);
    expect(scribe.data.ocr.active[0].lines[30].words[0].style.italic).toBe(true);
    expect(scribe.data.ocr.active[0].lines[30].words[0].style.bold).toBe(false);
    expect(scribe.data.ocr.active[0].lines[30].words[0].style.underline).toBe(false);
  });

  test('Bold + underlined style is detected', async () => {
    expect(scribe.data.ocr.active[0].lines[22].words[0].style.italic).toBe(false);
    expect(scribe.data.ocr.active[0].lines[22].words[0].style.bold).toBe(true);
    expect(scribe.data.ocr.active[0].lines[22].words[0].style.underline).toBe(true);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check Abbyy XML table import.', () => {
  test('Should import Abbyy XML with PDF document', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/border_patrol_tables.abbyy.xml`]);

    expect(scribe.data.ocr.active[0].lines.length > 0).toBe(true);
  });

  test('Should correctly import table structures from Abbyy XML', async () => {
    expect(scribe.data.layoutDataTables.pages[0].tables.length === 1).toBe(true);
    expect(scribe.data.layoutDataTables.pages[0].tables[0].boxes.length === 10).toBe(true);
  });

  test('Should correctly import table structures from Abbyy XML', async () => {
    expect(scribe.data.layoutDataTables.pages[0].tables.length === 1).toBe(true);

    expect(scribe.data.layoutDataTables.pages[0].tables[0].boxes.length === 10).toBe(true);
  });

  test('Should populate rowBounds from Abbyy cell data', async () => {
    const table = scribe.data.layoutDataTables.pages[0].tables[0];
    expect(table.rowBounds && table.rowBounds.length).toBe(25);
    expect(table.rowBounds && table.rowBounds[0]).toBe(544);
    expect(table.rowBounds && table.rowBounds[1]).toBe(622);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
