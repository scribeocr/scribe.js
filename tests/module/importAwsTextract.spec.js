import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

// Using arrow functions breaks references to `this`.

describe('Check AWS Textract JSON import function (syncronous API).', () => {
  test('Should import AWS Textract with PNG image', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/ascenders_descenders_test.png`,
      `${ASSETS_PATH}/ascenders_descenders_test_AwsTextract.json`]);
  });

  test('Should correctly import text content from AWS Textract (default settings)', async () => {
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

describe('Check AWS Textract JSON import function (layout analysis enabled) (syncronous API).', () => {
  beforeAll(async () => {
    await scribe.importFiles([`${ASSETS_PATH}/ascenders_descenders_test.png`,
      `${ASSETS_PATH}/ascenders_descenders_test_AwsTextractLayout.json`]);
  });

  test('Should correctly import text content from AWS Textract (default settings)', async () => {
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

describe('Check AWS Textract table import (syncronous API).', () => {
  test('Should import AWS Textract with PDF document', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/border_patrol_tables.pdf`,
      `${ASSETS_PATH}/border_patrol_tables_analyzeDocResponse.json`]);

    expect(scribe.data.ocr.active[0].lines.length > 0).toBe(true);
  });

  test('Should correctly import table structures from AWS Textract', async () => {
    expect(scribe.data.layoutDataTables.pages[0].tables.length === 1).toBe(true);
    expect(scribe.data.layoutDataTables.pages[0].tables[0].boxes.length === 10).toBe(true);
  });

  test('Should correctly import table structures from AWS Textract', async () => {
    expect(scribe.data.layoutDataTables.pages[0].tables.length === 1).toBe(true);

    expect(scribe.data.layoutDataTables.pages[0].tables[0].boxes.length === 10).toBe(true);
  });

  test('Should populate rowBounds from Textract cell data', async () => {
    const table = scribe.data.layoutDataTables.pages[0].tables[0];
    expect(table.rowBounds && table.rowBounds.length).toBe(25);
    expect(table.rowBounds && table.rowBounds[0]).toBe(559);
    expect(table.rowBounds && table.rowBounds[1]).toBe(627);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check AWS Textract JSON import correctly handles angle brackets.', () => {
  beforeAll(async () => {
    await scribe.importFiles([`${ASSETS_PATH}/dictionary_spelling.png`,
      `${ASSETS_PATH}/dictionary_spelling-AwsTextractLayoutSync.json`]);
  });

  test('Should correctly import < and > signs from AWS Textract', async () => {
    // The document contains text with angle brackets like <th>, <e>, <wh>, etc.
    const allText = scribe.data.ocr.active[0].lines.map((line) => line.words.map((x) => x.text).join(' ')).join(' ');

    expect(allText).toContain('<th>');
    expect(allText).toContain('<e>');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check scribe JSON import handles null OCR pages (blank pages).', () => {
  test('Should import scribe JSON that has null entries in the OCR array without crashing', async () => {
    // Import a known-good scribe file, export it, then inject null pages to simulate blank pages.
    await scribe.importFiles([`${ASSETS_PATH}/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.pdf`]);

    scribe.opt.compressScribe = false;
    const scribeStr = await scribe.exportData('scribe');
    const scribeObj = JSON.parse(scribeStr);

    // Inject null at the beginning and end to simulate blank/cover pages.
    scribeObj.ocr.unshift(null);
    scribeObj.ocr.push(null);

    const modified = JSON.stringify(scribeObj);
    const encoder = new TextEncoder();
    const buffer = encoder.encode(modified).buffer;

    await scribe.terminate();
    await scribe.importFiles({ scribeFiles: [buffer] });

    // Page 0 was null in the input, so it should be an empty placeholder page with default dims.
    expect(scribe.data.ocr.active[0].lines.length).toBe(0);
    expect(scribe.data.ocr.active[0].dims.width).toBe(1080);
    expect(scribe.data.ocr.active[0].dims.height).toBe(1920);
    // Page 1 should be the original first page with real OCR data.
    expect(scribe.data.ocr.active[1].lines.length > 0).toBe(true);
    expect(scribe.data.ocr.active[1].lines[0].words[0].text).toBe('UNITED');
  });

  afterAll(async () => {
    scribe.opt.compressScribe = true;
    await scribe.clear();
    await scribe.terminate();
  });
});

describe('Check combined per-page Textract sync responses import to correct pages.', () => {
  // Helper that works in both Node.js and browser environments.
  async function readTextFile(filePath) {
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
      const fs = await import('node:fs/promises');
      return fs.readFile(filePath, 'utf-8');
    }
    const response = await fetch(filePath);
    return response.text();
  }

  beforeAll(async () => {
    // Read per-page sync Textract responses (blocks lack the Page property).
    const pageResponses = [];
    for (let i = 0; i < 7; i++) {
      const filename = `${ASSETS_PATH}/trident_v_connecticut_general/awsTextract/trident_v_connecticut_general_${String(i).padStart(3, '0')}-AwsTextractLayoutSync.json`;
      pageResponses.push(JSON.parse(await readTextFile(filename)));
    }

    // Combine per-page responses into a single Textract JSON, setting the
    // correct Page number on each block. This is what the fixed
    // combineTextractResponses does; we inline the logic here to avoid
    // importing the Node-only AWS adapter in the browser.
    const combined = { ...pageResponses[0], Blocks: [], Warnings: [] };
    for (let ri = 0; ri < pageResponses.length; ri++) {
      for (const block of pageResponses[ri].Blocks) {
        block.Page = ri + 1;
        combined.Blocks.push(block);
      }
    }

    // Import the PDF together with the combined OCR data as an ArrayBuffer.
    const combinedBuffer = new TextEncoder().encode(JSON.stringify(combined)).buffer;
    await scribe.importFiles({
      pdfFiles: [`${ASSETS_PATH}/trident_v_connecticut_general.pdf`],
      ocrFiles: [combinedBuffer],
    });
  });

  test('Should distribute blocks across all pages (not put everything on page 0)', async () => {
    // Before the fix, all blocks had Page=1/undefined so everything landed on page 0.
    for (let i = 0; i < 7; i++) {
      expect(scribe.data.ocr.active[i]).toBeTruthy();
      expect(scribe.data.ocr.active[i].lines.length > 0).toBe(true);
    }
  });

  test('Should have correct first word on page 0', async () => {
    const firstWord = scribe.data.ocr.active[0].lines[0].words[0].text;
    expect(firstWord).toBe('564');
  });

  test('Should have correct first word on page 6', async () => {
    const firstWord = scribe.data.ocr.active[6].lines[0].words[0].text;
    expect(firstWord).toBe('570');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check AWS Textract properly splits unicode superscript footnotes.', () => {
  beforeAll(async () => {
    await scribe.importFiles([`${ASSETS_PATH}/econometrica_example_all_orientations.pdf`,
      `${ASSETS_PATH}/econometrica_example_all_orientations-AwsTextractLayout.json`]);
  });

  test('Should split unicode superscripts into separate words', async () => {
    // The original Textract data has "years.¹" as one word, which should be split into "years." and "1"
    const page = scribe.data.ocr.active[0];
    const allWords = page.lines.flatMap((line) => line.words);

    const yearsWordIndex = allWords.findIndex((w) => w.text === 'years.');
    expect(allWords[yearsWordIndex - 1].text).toBe('recent');
    expect(allWords[yearsWordIndex].text).toBe('years.');
    expect(allWords[yearsWordIndex + 1].text).toBe('1');
    expect(allWords[yearsWordIndex + 1].style.sup).toBe(true);
  });

  test('Should convert unicode superscript characters to regular numbers and mark with style.sup', async () => {
    const page = scribe.data.ocr.active[0];
    const allWords = page.lines.flatMap((line) => line.words);

    const supWords = allWords.filter((w) => w.style.sup === true);
    const supTexts = supWords.map((w) => w.text);
    expect(supTexts).toEqual(['1', '2', '3', '1', '3', '2']);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
