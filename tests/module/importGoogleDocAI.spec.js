import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

// Using arrow functions breaks references to `this`.

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

describe('Check Google Document AI JSON import function (ascenders_descenders_test).', () => {
  beforeAll(async () => {
    await scribe.importFiles([`${ASSETS_PATH}/ascenders_descenders_test.png`,
      `${ASSETS_PATH}/ascenders_descenders_test-GoogleDocAI.json`]);
  });

  test('Should correctly import text content', async () => {
    const text1 = scribe.data.ocr.active[0].lines[0].words.map((x) => x.text).join(' ');
    const text2 = scribe.data.ocr.active[0].lines[1].words.map((x) => x.text).join(' ');
    const text3 = scribe.data.ocr.active[0].lines[2].words.map((x) => x.text).join(' ');

    expect(text1).toBe('Ascenders On');
    expect(text2).toBe('query png');
    expect(text3).toBe('we can');
  });

  test('Should import correct number of lines', async () => {
    expect(scribe.data.ocr.active[0].lines.length).toBe(3);
  });

  test('Should import correct number of words per line', async () => {
    expect(scribe.data.ocr.active[0].lines[0].words.length).toBe(2);
    expect(scribe.data.ocr.active[0].lines[1].words.length).toBe(2);
    expect(scribe.data.ocr.active[0].lines[2].words.length).toBe(2);
  });

  test('Should have high confidence values for clear text', async () => {
    // The "Ascenders" word should have >90% confidence (it reads 99 from the JSON)
    const conf = scribe.data.ocr.active[0].lines[0].words[0].conf;
    expect(conf).toBeGreaterThan(90);
    expect(conf).toBeLessThanOrEqual(100);
  });

  test('Should create 3 paragraphs (one per line)', async () => {
    expect(scribe.data.ocr.active[0].pars.length).toBe(3);
  });

  test('All lines should have paragraph back-references', async () => {
    for (const line of scribe.data.ocr.active[0].lines) {
      expect(line.par).not.toBeNull();
    }
  });

  test('Paragraph text should match line text', async () => {
    const par0Text = scribe.data.ocr.active[0].pars[0].lines.map((l) => l.words.map((w) => w.text).join(' ')).join(' ');
    const par1Text = scribe.data.ocr.active[0].pars[1].lines.map((l) => l.words.map((w) => w.text).join(' ')).join(' ');
    const par2Text = scribe.data.ocr.active[0].pars[2].lines.map((l) => l.words.map((w) => w.text).join(' ')).join(' ');
    expect(par0Text).toBe('Ascenders On');
    expect(par1Text).toBe('query png');
    expect(par2Text).toBe('we can');
  });

  test('Word "Ascenders" bbox should have correct approximate position', async () => {
    const word = scribe.data.ocr.active[0].lines[0].words[0]; // "Ascenders"
    expect(word.text).toBe('Ascenders');
    // From the JSON: vertices x=[61,376], y=[70,123]
    expect(Math.abs((word.bbox.left) - (61))).toBeLessThanOrEqual(5);
    expect(Math.abs((word.bbox.right) - (376))).toBeLessThanOrEqual(5);
    expect(Math.abs((word.bbox.top) - (70))).toBeLessThanOrEqual(5);
    expect(Math.abs((word.bbox.bottom) - (123))).toBeLessThanOrEqual(5);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check Google Document AI import for 070823vanliere (superscript handling).', () => {
  /** @type {Array} */
  let gdaiPages;

  beforeAll(async () => {
    await scribe.importFiles([`${ASSETS_PATH}/070823vanliere.pdf`,
      `${ASSETS_PATH}/070823vanliere-GoogleDocAI.json`]);
    gdaiPages = scribe.data.ocr.active;
  });

  test('Should import 41 pages', async () => {
    expect(gdaiPages.length).toBe(41);
  });

  describe('Unicode superscripts should be split into separate words', () => {
    test('"merger.²" on page 5 should be split into "merger." and "2"', async () => {
      const result = findLineWithWords(gdaiPages[5], ['proposed', 'merger.']);
      expect(result).not.toBeNull();
      const mergerWord = result.line.words[result.startIdx + 1];
      expect(mergerWord.text).toBe('merger.');

      const supWord = result.line.words[result.startIdx + 2];
      expect(supWord.text).toBe('2');
      expect(supWord.style.sup).toBe(true);
    });

    test('"formulas.¹" on page 9 should be split into "formulas." and "1"', async () => {
      const result = findLineWithWords(gdaiPages[9], ['various', 'formulas.']);
      expect(result).not.toBeNull();
      const formulasWord = result.line.words[result.startIdx + 1];
      expect(formulasWord.text).toBe('formulas.');

      const supWord = result.line.words[result.startIdx + 2];
      expect(supWord.text).toBe('1');
      expect(supWord.style.sup).toBe(true);
    });

    test('Standalone "²" footnote marker on page 5 should become "2" with sup style', async () => {
      const result = findLineWithWords(gdaiPages[5], ['2', 'Expert', 'Report']);
      expect(result).not.toBeNull();
      const supWord = result.line.words[result.startIdx];
      expect(supWord.text).toBe('2');
      expect(supWord.style.sup).toBe(true);
    });

    test('".³" on page 6 should be split into "." and "3"', async () => {
      const allWords = gdaiPages[6].lines.flatMap((line) => line.words);
      const supThreeIdx = allWords.findIndex((w) => w.text === '3' && w.style.sup === true);
      expect(supThreeIdx).toBeGreaterThan(-1);
      expect(allWords[supThreeIdx].text).toBe('3');
    });

    test('Superscript words should not contain unicode superscript characters', async () => {
      const allWords = gdaiPages.flatMap((page) => page.lines.flatMap((line) => line.words));
      const unicodeSuperRegex = /[⁰¹²³⁴⁵⁶⁷⁸⁹]/;
      const wordsWithUnicode = allWords.filter((w) => unicodeSuperRegex.test(w.text));
      expect(wordsWithUnicode.length).toBe(0);
    });
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
