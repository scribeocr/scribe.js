// Relative imports are required to run in browser.
/* eslint-disable import/no-relative-packages */
import { assert, config } from '../../node_modules/chai/chai.js';
import scribe from '../../scribe.js';
import { ASSETS_PATH_KARMA } from '../constants.js';

config.truncateThreshold = 0; // Disable truncation for actual/expected values on assertion failure.

// Helper function to read file content in both Node.js and browser environments
async function readFileContent(filePath) {
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    // Node.js environment
    const fs = await import('node:fs/promises');
    return fs.readFile(filePath, 'utf-8');
  }
  // Browser environment
  const response = await fetch(filePath);
  return response.text();
}

// Using arrow functions breaks references to `this`.
/* eslint-disable prefer-arrow-callback */
/* eslint-disable func-names */

// Validate that the test stext files have not been modified (e.g., by a linter changing whitespace).
// The difference between testocr.stext and testocr.spacing.stext is specifically about whitespace/formatting,
// so any modification would invalidate the tests.
// Note: Line endings may differ when cloned on Windows vs. Unix systems,
// so we accept both LF and CRLF counts.
describe('Validate stext test file integrity.', function () {
  this.timeout(10000);

  it('testocr.stext should have expected byte count (detect linter modifications)', async () => {
    const text = await readFileContent(`${ASSETS_PATH_KARMA}/testocr.stext`);
    assert.oneOf(text.length, [44382, 44712], 'testocr.stext has been modified - file size changed from expected values');
  });

  it('testocr.spacing.stext should have expected byte count (detect linter modifications)', async () => {
    const text = await readFileContent(`${ASSETS_PATH_KARMA}/testocr.spacing.stext`);
    assert.oneOf(text.length, [57774, 58388], 'testocr.spacing.stext has been modified - file size changed from expected values');
  });
}).timeout(120000);

describe('Check stext import function.', function () {
  this.timeout(10000);

  it('Should import stext file', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/testocr.stext`]);
  });

  it('Should correctly import text content from stext', async () => {
    const text1 = scribe.data.ocr.active[0].lines[0].words.map((x) => x.text).join(' ');
    const text2 = scribe.data.ocr.active[0].lines[1].words.map((x) => x.text).join(' ');
    const text3 = scribe.data.ocr.active[0].lines[2].words.map((x) => x.text).join(' ');
    const text4 = scribe.data.ocr.active[0].lines[3].words.map((x) => x.text).join(' ');
    const text5 = scribe.data.ocr.active[0].lines[4].words.map((x) => x.text).join(' ');
    const text6 = scribe.data.ocr.active[0].lines[5].words.map((x) => x.text).join(' ');
    const text7 = scribe.data.ocr.active[0].lines[6].words.map((x) => x.text).join(' ');
    const text8 = scribe.data.ocr.active[0].lines[7].words.map((x) => x.text).join(' ');

    assert.strictEqual(text1, 'This is a lot of 12 point text to test the');
    assert.strictEqual(text2, 'ocr code and see if it works on all types');
    assert.strictEqual(text3, 'of file format.');
    assert.strictEqual(text4, 'The quick brown dog jumped over the');
    assert.strictEqual(text5, 'lazy fox. The quick brown dog jumped');
    assert.strictEqual(text6, 'over the lazy fox. The quick brown dog');
    assert.strictEqual(text7, 'jumped over the lazy fox. The quick');
    assert.strictEqual(text8, 'brown dog jumped over the lazy fox.');
  }).timeout(10000);

  it('Should have correct number of words per line (not import lines as single words)', async () => {
    const wordCount1 = scribe.data.ocr.active[0].lines[0].words.length;
    const wordCount2 = scribe.data.ocr.active[0].lines[1].words.length;
    const wordCount3 = scribe.data.ocr.active[0].lines[2].words.length;
    const wordCount4 = scribe.data.ocr.active[0].lines[3].words.length;
    const wordCount5 = scribe.data.ocr.active[0].lines[4].words.length;
    const wordCount6 = scribe.data.ocr.active[0].lines[5].words.length;
    const wordCount7 = scribe.data.ocr.active[0].lines[6].words.length;
    const wordCount8 = scribe.data.ocr.active[0].lines[7].words.length;

    assert.strictEqual(wordCount1, 11, 'Line 1 should have 11 words');
    assert.strictEqual(wordCount2, 10, 'Line 2 should have 10 words');
    assert.strictEqual(wordCount3, 3, 'Line 3 should have 3 words');
    assert.strictEqual(wordCount4, 7, 'Line 4 should have 7 words');
    assert.strictEqual(wordCount5, 7, 'Line 5 should have 7 words');
    assert.strictEqual(wordCount6, 8, 'Line 6 should have 8 words');
    assert.strictEqual(wordCount7, 7, 'Line 7 should have 7 words');
    assert.strictEqual(wordCount8, 7, 'Line 8 should have 7 words');

    const totalWords = scribe.data.ocr.active[0].lines.reduce((sum, line) => sum + line.words.length, 0);
    assert.strictEqual(totalWords, 60, 'Total word count should be 60');
  }).timeout(10000);

  it('Should have correct number of lines', async () => {
    assert.strictEqual(scribe.data.ocr.active[0].lines.length, 8, 'Should have 8 lines');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

// Tests for stext files with different whitespace/formatting (multiline char elements).
// This file has the same content as testocr.stext but with XML formatted with newlines/indentation.
// This exists because a bug previously existed where the import would fail on such files.
describe('Check stext import function with multiline XML formatting (spacing variant).', function () {
  this.timeout(10000);

  it('Should import stext file with multiline formatting', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/testocr.spacing.stext`]);
  });

  it('Should correctly import text content from stext with multiline formatting', async () => {
    const text1 = scribe.data.ocr.active[0].lines[0].words.map((x) => x.text).join(' ');
    const text2 = scribe.data.ocr.active[0].lines[1].words.map((x) => x.text).join(' ');
    const text3 = scribe.data.ocr.active[0].lines[2].words.map((x) => x.text).join(' ');
    const text4 = scribe.data.ocr.active[0].lines[3].words.map((x) => x.text).join(' ');
    const text5 = scribe.data.ocr.active[0].lines[4].words.map((x) => x.text).join(' ');
    const text6 = scribe.data.ocr.active[0].lines[5].words.map((x) => x.text).join(' ');
    const text7 = scribe.data.ocr.active[0].lines[6].words.map((x) => x.text).join(' ');
    const text8 = scribe.data.ocr.active[0].lines[7].words.map((x) => x.text).join(' ');

    assert.strictEqual(text1, 'This is a lot of 12 point text to test the');
    assert.strictEqual(text2, 'ocr code and see if it works on all types');
    assert.strictEqual(text3, 'of file format.');
    assert.strictEqual(text4, 'The quick brown dog jumped over the');
    assert.strictEqual(text5, 'lazy fox. The quick brown dog jumped');
    assert.strictEqual(text6, 'over the lazy fox. The quick brown dog');
    assert.strictEqual(text7, 'jumped over the lazy fox. The quick');
    assert.strictEqual(text8, 'brown dog jumped over the lazy fox.');
  }).timeout(10000);

  it('Should have correct number of words per line with multiline formatting (not import lines as single words)', async () => {
    const wordCount1 = scribe.data.ocr.active[0].lines[0].words.length;
    const wordCount2 = scribe.data.ocr.active[0].lines[1].words.length;
    const wordCount3 = scribe.data.ocr.active[0].lines[2].words.length;
    const wordCount4 = scribe.data.ocr.active[0].lines[3].words.length;
    const wordCount5 = scribe.data.ocr.active[0].lines[4].words.length;
    const wordCount6 = scribe.data.ocr.active[0].lines[5].words.length;
    const wordCount7 = scribe.data.ocr.active[0].lines[6].words.length;
    const wordCount8 = scribe.data.ocr.active[0].lines[7].words.length;

    assert.strictEqual(wordCount1, 11, 'Line 1 should have 11 words');
    assert.strictEqual(wordCount2, 10, 'Line 2 should have 10 words');
    assert.strictEqual(wordCount3, 3, 'Line 3 should have 3 words');
    assert.strictEqual(wordCount4, 7, 'Line 4 should have 7 words');
    assert.strictEqual(wordCount5, 7, 'Line 5 should have 7 words');
    assert.strictEqual(wordCount6, 8, 'Line 6 should have 8 words');
    assert.strictEqual(wordCount7, 7, 'Line 7 should have 7 words');
    assert.strictEqual(wordCount8, 7, 'Line 8 should have 7 words');

    const totalWords = scribe.data.ocr.active[0].lines.reduce((sum, line) => sum + line.words.length, 0);
    assert.strictEqual(totalWords, 60, 'Total word count should be 60');
  }).timeout(10000);

  it('Should have correct number of lines with multiline formatting', async () => {
    assert.strictEqual(scribe.data.ocr.active[0].lines.length, 8, 'Should have 8 lines');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);
