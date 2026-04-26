// Relative imports are required to run in browser.
/* eslint-disable import/no-relative-packages */
import { assert, config } from '../../node_modules/chai/chai.js';
// import mocha from '../../node_modules/mocha/mocha.js';
import scribe from '../../scribe.js';
import { ASSETS_PATH_KARMA } from '../constants.js';

scribe.opt.workerN = 1;

config.truncateThreshold = 0; // Disable truncation for actual/expected values on assertion failure.

// Using arrow functions breaks references to `this`.
/* eslint-disable prefer-arrow-callback */
/* eslint-disable func-names */

describe('Check AWS Textract JSON import function (syncronous API).', function () {
  this.timeout(10000);

  it('Should import AWS Textract with PNG image', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/ascenders_descenders_test.png`,
      `${ASSETS_PATH_KARMA}/ascenders_descenders_test_AwsTextract.json`]);
  });

  it('Should correctly import text content from AWS Textract (default settings)', async () => {
    const text1 = scribe.data.ocr.active[0].lines[0].words.map((x) => x.text).join(' ');
    const text2 = scribe.data.ocr.active[0].lines[1].words.map((x) => x.text).join(' ');
    const text3 = scribe.data.ocr.active[0].lines[2].words.map((x) => x.text).join(' ');

    assert.strictEqual(text1, 'Ascenders On');
    assert.strictEqual(text2, 'query png');
    assert.strictEqual(text3, 'we can');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check AWS Textract JSON import function (layout analysis enabled) (syncronous API).', function () {
  this.timeout(10000);
  before(async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/ascenders_descenders_test.png`,
      `${ASSETS_PATH_KARMA}/ascenders_descenders_test_AwsTextractLayout.json`]);
  });

  it('Should correctly import text content from AWS Textract (default settings)', async () => {
    const text1 = scribe.data.ocr.active[0].lines[0].words.map((x) => x.text).join(' ');
    const text2 = scribe.data.ocr.active[0].lines[1].words.map((x) => x.text).join(' ');
    const text3 = scribe.data.ocr.active[0].lines[2].words.map((x) => x.text).join(' ');

    assert.strictEqual(text1, 'Ascenders On');
    assert.strictEqual(text2, 'query png');
    assert.strictEqual(text3, 'we can');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check AWS Textract table import (syncronous API).', function () {
  this.timeout(10000);

  it('Should import AWS Textract with PDF document', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/border_patrol_tables.pdf`,
      `${ASSETS_PATH_KARMA}/border_patrol_tables_analyzeDocResponse.json`]);

    assert.isTrue(scribe.data.ocr.active[0].lines.length > 0);
  }).timeout(10000);

  it('Should correctly import table structures from AWS Textract', async () => {
    assert.isTrue(scribe.data.layoutDataTables.pages[0].tables.length === 1);
    assert.isTrue(scribe.data.layoutDataTables.pages[0].tables[0].boxes.length === 10);
  }).timeout(10000);

  it('Should correctly import table structures from AWS Textract', async () => {
    assert.isTrue(scribe.data.layoutDataTables.pages[0].tables.length === 1);

    assert.isTrue(scribe.data.layoutDataTables.pages[0].tables[0].boxes.length === 10);
  }).timeout(10000);

  it('Should populate rowBounds from Textract cell data', async () => {
    const table = scribe.data.layoutDataTables.pages[0].tables[0];
    assert.strictEqual(table.rowBounds && table.rowBounds.length, 25);
    assert.strictEqual(table.rowBounds && table.rowBounds[0], 559);
    assert.strictEqual(table.rowBounds && table.rowBounds[1], 627);
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check AWS Textract JSON import correctly handles angle brackets.', function () {
  this.timeout(10000);

  before(async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/dictionary_spelling.png`,
      `${ASSETS_PATH_KARMA}/dictionary_spelling-AwsTextractLayoutSync.json`]);
  });

  it('Should correctly import < and > signs from AWS Textract', async () => {
    // The document contains text with angle brackets like <th>, <e>, <wh>, etc.
    const allText = scribe.data.ocr.active[0].lines.map((line) => line.words.map((x) => x.text).join(' ')).join(' ');

    assert.include(allText, '<th>');
    assert.include(allText, '<e>');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check scribe JSON import handles null OCR pages (blank pages).', function () {
  this.timeout(10000);

  it('Should import scribe JSON that has null entries in the OCR array without crashing', async () => {
    // Import a known-good scribe file, export it, then inject null pages to simulate blank pages.
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.pdf`]);

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
    assert.strictEqual(scribe.data.ocr.active[0].lines.length, 0);
    assert.strictEqual(scribe.data.ocr.active[0].dims.width, 1080);
    assert.strictEqual(scribe.data.ocr.active[0].dims.height, 1920);
    // Page 1 should be the original first page with real OCR data.
    assert.isTrue(scribe.data.ocr.active[1].lines.length > 0);
    assert.strictEqual(scribe.data.ocr.active[1].lines[0].words[0].text, 'UNITED');
  }).timeout(10000);

  after(async () => {
    scribe.opt.compressScribe = true;
    await scribe.clear();
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check combined per-page Textract sync responses import to correct pages.', function () {
  this.timeout(10000);

  // Helper that works in both Node.js and browser environments.
  async function readTextFile(filePath) {
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
      const fs = await import('node:fs/promises');
      return fs.readFile(filePath, 'utf-8');
    }
    const response = await fetch(filePath);
    return response.text();
  }

  before(async () => {
    // Read per-page sync Textract responses (blocks lack the Page property).
    const pageResponses = [];
    for (let i = 0; i < 7; i++) {
      const filename = `${ASSETS_PATH_KARMA}/trident_v_connecticut_general/awsTextract/trident_v_connecticut_general_${String(i).padStart(3, '0')}-AwsTextractLayoutSync.json`;
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
      pdfFiles: [`${ASSETS_PATH_KARMA}/trident_v_connecticut_general.pdf`],
      ocrFiles: [combinedBuffer],
    });
  });

  it('Should distribute blocks across all pages (not put everything on page 0)', async () => {
    // Before the fix, all blocks had Page=1/undefined so everything landed on page 0.
    for (let i = 0; i < 7; i++) {
      assert.isOk(scribe.data.ocr.active[i], `Page ${i} should have OCR data`);
      assert.isTrue(scribe.data.ocr.active[i].lines.length > 0, `Page ${i} should have lines`);
    }
  }).timeout(10000);

  it('Should have correct first word on page 0', async () => {
    const firstWord = scribe.data.ocr.active[0].lines[0].words[0].text;
    assert.strictEqual(firstWord, '564');
  }).timeout(10000);

  it('Should have correct first word on page 6', async () => {
    const firstWord = scribe.data.ocr.active[6].lines[0].words[0].text;
    assert.strictEqual(firstWord, '570');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check AWS Textract properly splits unicode superscript footnotes.', function () {
  this.timeout(10000);

  before(async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/econometrica_example_all_orientations.pdf`,
      `${ASSETS_PATH_KARMA}/econometrica_example_all_orientations-AwsTextractLayout.json`]);
  });

  it('Should split unicode superscripts into separate words', async () => {
    // The original Textract data has "years.¹" as one word, which should be split into "years." and "1"
    const page = scribe.data.ocr.active[0];
    const allWords = page.lines.flatMap((line) => line.words);

    const yearsWordIndex = allWords.findIndex((w) => w.text === 'years.');
    assert.strictEqual(allWords[yearsWordIndex - 1].text, 'recent');
    assert.strictEqual(allWords[yearsWordIndex].text, 'years.');
    assert.strictEqual(allWords[yearsWordIndex + 1].text, '1');
    assert.strictEqual(allWords[yearsWordIndex + 1].style.sup, true);
  }).timeout(10000);

  it('Should convert unicode superscript characters to regular numbers and mark with style.sup', async () => {
    const page = scribe.data.ocr.active[0];
    const allWords = page.lines.flatMap((line) => line.words);

    const supWords = allWords.filter((w) => w.style.sup === true);
    const supTexts = supWords.map((w) => w.text);
    assert.deepStrictEqual(supTexts, ['1', '2', '3', '1', '3', '2']);
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);
