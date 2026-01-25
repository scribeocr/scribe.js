// Relative imports are required to run in browser.
/* eslint-disable import/no-relative-packages */
import { assert, config } from '../../node_modules/chai/chai.js';
// import mocha from '../../node_modules/mocha/mocha.js';
import scribe from '../../scribe.js';
import { ASSETS_PATH_KARMA } from '../constants.js';

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
