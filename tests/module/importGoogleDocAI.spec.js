// Relative imports are required to run in browser.
/* eslint-disable import/no-relative-packages */
import { assert, config } from '../../node_modules/chai/chai.js';
import scribe from '../../scribe.js';
import { ASSETS_PATH_KARMA } from '../constants.js';
import { calcLineFontSize, calcWordFontSize } from '../../js/utils/fontUtils.js';

config.truncateThreshold = 0; // Disable truncation for actual/expected values on assertion failure.

// Using arrow functions breaks references to `this`.
/* eslint-disable prefer-arrow-callback */
/* eslint-disable func-names */

/**
 * Find a line containing the given words in sequence within a page.
 * @param {Object} page
 * @param {string[]} wordTexts - Consecutive words to search for.
 * @returns {{ line: Object, startIdx: number } | null}
 */
function findLineWithWords(page, wordTexts) {
  for (const line of page.lines) {
    const lineWords = line.words.map((w) => w.text);
    for (let i = 0; i <= lineWords.length - wordTexts.length; i++) {
      let match = true;
      for (let j = 0; j < wordTexts.length; j++) {
        if (lineWords[i + j] !== wordTexts[j]) {
          match = false;
          break;
        }
      }
      if (match) return { line, startIdx: i };
    }
  }
  return null;
}

describe('Check Google Document AI JSON import function (ascenders_descenders_test).', function () {
  this.timeout(10000);
  before(async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/ascenders_descenders_test.png`,
      `${ASSETS_PATH_KARMA}/ascenders_descenders_test-GoogleDocAI.json`]);
  });

  it('Should correctly import text content', async () => {
    const text1 = scribe.data.ocr.active[0].lines[0].words.map((x) => x.text).join(' ');
    const text2 = scribe.data.ocr.active[0].lines[1].words.map((x) => x.text).join(' ');
    const text3 = scribe.data.ocr.active[0].lines[2].words.map((x) => x.text).join(' ');

    assert.strictEqual(text1, 'Ascenders On');
    assert.strictEqual(text2, 'query png');
    assert.strictEqual(text3, 'we can');
  }).timeout(10000);

  it('Should import correct number of lines', async () => {
    assert.strictEqual(scribe.data.ocr.active[0].lines.length, 3);
  }).timeout(10000);

  it('Should import correct number of words per line', async () => {
    assert.strictEqual(scribe.data.ocr.active[0].lines[0].words.length, 2);
    assert.strictEqual(scribe.data.ocr.active[0].lines[1].words.length, 2);
    assert.strictEqual(scribe.data.ocr.active[0].lines[2].words.length, 2);
  }).timeout(10000);

  it('Should have high confidence values for clear text', async () => {
    // The "Ascenders" word should have >90% confidence (it reads 99 from the JSON)
    const conf = scribe.data.ocr.active[0].lines[0].words[0].conf;
    assert.isAbove(conf, 90, 'Confidence for clear text should be above 90');
    assert.isAtMost(conf, 100, 'Confidence should be at most 100');
  }).timeout(10000);

  it('Should create 3 paragraphs (one per line)', async () => {
    assert.strictEqual(scribe.data.ocr.active[0].pars.length, 3);
  }).timeout(10000);

  it('All lines should have paragraph back-references', async () => {
    for (const line of scribe.data.ocr.active[0].lines) {
      assert.isNotNull(line.par, 'Every line should have a paragraph reference');
    }
  }).timeout(10000);

  it('Paragraph text should match line text', async () => {
    const par0Text = scribe.data.ocr.active[0].pars[0].lines.map((l) => l.words.map((w) => w.text).join(' ')).join(' ');
    const par1Text = scribe.data.ocr.active[0].pars[1].lines.map((l) => l.words.map((w) => w.text).join(' ')).join(' ');
    const par2Text = scribe.data.ocr.active[0].pars[2].lines.map((l) => l.words.map((w) => w.text).join(' ')).join(' ');
    assert.strictEqual(par0Text, 'Ascenders On');
    assert.strictEqual(par1Text, 'query png');
    assert.strictEqual(par2Text, 'we can');
  }).timeout(10000);

  it('Word "Ascenders" bbox should have correct approximate position', async () => {
    const word = scribe.data.ocr.active[0].lines[0].words[0]; // "Ascenders"
    assert.strictEqual(word.text, 'Ascenders');
    // From the JSON: vertices x=[61,376], y=[70,123]
    assert.approximately(word.bbox.left, 61, 5, 'Left should be ~61');
    assert.approximately(word.bbox.right, 376, 5, 'Right should be ~376');
    assert.approximately(word.bbox.top, 70, 5, 'Top should be ~70');
    assert.approximately(word.bbox.bottom, 123, 5, 'Bottom should be ~123');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check Google Document AI import for 070823vanliere (superscript handling).', function () {
  this.timeout(60000);

  /** @type {Array} */
  let gdaiPages;

  before(async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/070823vanliere.pdf`,
      `${ASSETS_PATH_KARMA}/070823vanliere-GoogleDocAI.json`]);
    gdaiPages = scribe.data.ocr.active;
  });

  it('Should import 41 pages', async () => {
    assert.strictEqual(gdaiPages.length, 41);
  }).timeout(10000);

  describe('Unicode superscripts should be split into separate words', function () {
    it('"merger.²" on page 5 should be split into "merger." and "2"', async () => {
      const result = findLineWithWords(gdaiPages[5], ['proposed', 'merger.']);
      assert.isNotNull(result, 'Should find "proposed merger." on page 5');
      const mergerWord = result.line.words[result.startIdx + 1];
      assert.strictEqual(mergerWord.text, 'merger.');

      const supWord = result.line.words[result.startIdx + 2];
      assert.strictEqual(supWord.text, '2');
      assert.strictEqual(supWord.style.sup, true);
    }).timeout(10000);

    it('"formulas.¹" on page 9 should be split into "formulas." and "1"', async () => {
      const result = findLineWithWords(gdaiPages[9], ['various', 'formulas.']);
      assert.isNotNull(result, 'Should find "various formulas." on page 9');
      const formulasWord = result.line.words[result.startIdx + 1];
      assert.strictEqual(formulasWord.text, 'formulas.');

      const supWord = result.line.words[result.startIdx + 2];
      assert.strictEqual(supWord.text, '1');
      assert.strictEqual(supWord.style.sup, true);
    }).timeout(10000);

    it('Standalone "²" footnote marker on page 5 should become "2" with sup style', async () => {
      const result = findLineWithWords(gdaiPages[5], ['2', 'Expert', 'Report']);
      assert.isNotNull(result, 'Should find footnote line starting with "2 Expert Report"');
      const supWord = result.line.words[result.startIdx];
      assert.strictEqual(supWord.text, '2');
      assert.strictEqual(supWord.style.sup, true);
    }).timeout(10000);

    it('".³" on page 6 should be split into "." and "3"', async () => {
      const allWords = gdaiPages[6].lines.flatMap((line) => line.words);
      const supThreeIdx = allWords.findIndex((w) => w.text === '3' && w.style.sup === true);
      assert.isAbove(supThreeIdx, -1, 'Should find superscript "3" on page 6');
      assert.strictEqual(allWords[supThreeIdx].text, '3');
    }).timeout(10000);

    it('Superscript words should not contain unicode superscript characters', async () => {
      const allWords = gdaiPages.flatMap((page) => page.lines.flatMap((line) => line.words));
      const unicodeSuperRegex = /[⁰¹²³⁴⁵⁶⁷⁸⁹]/;
      const wordsWithUnicode = allWords.filter((w) => unicodeSuperRegex.test(w.text));
      assert.strictEqual(wordsWithUnicode.length, 0, 'No words should contain unicode superscript characters');
    }).timeout(10000);
  });

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);
