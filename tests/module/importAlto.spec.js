import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

// Using arrow functions breaks references to `this`.

describe('Check ALTO XML import function.', () => {
  test('Should import ALTO XML with PNG image', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/ascenders_descenders_test.png`,
      `${ASSETS_PATH}/ascenders_descenders_test.alto.xml`]);
  });

  test('Should correctly import text content from ALTO XML (default settings)', async () => {
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

describe('Check ALTO XML import function without image.', () => {
  test('Should import ALTO XML without image/PDF inputs', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/the_past.alto.xml`]);
  });

  test('Should correctly import text content', async () => {
    const text1 = scribe.data.ocr.active[0].lines[0].words.map((x) => x.text).join(' ');
    const text3 = scribe.data.ocr.active[0].lines[2].words.map((x) => x.text).join(' ');

    expect(text1).toBe('THE PAST.');
    expect(text3).toBe('THE PAST.');
  });

  test('Should correctly import confidence scores', async () => {
    const word1 = scribe.data.ocr.active[0].lines[0].words[0];
    const word2 = scribe.data.ocr.active[0].lines[0].words[1];

    expect(word1.conf).toBeGreaterThan(1);
    expect(word2.conf).toBeGreaterThan(1);
    expect(word1.conf).toBeLessThan(100);
    expect(word2.conf).toBeLessThan(100);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check that font style is detected for ALTO xml imports.', () => {
  test('Bold style is detected', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/the_past.alto.xml`]);
    // First line has STYLE="bold" on both words
    expect(scribe.data.ocr.active[0].lines[0].words[0].style.bold).toBe(true);
    expect(scribe.data.ocr.active[0].lines[0].words[1].style.bold).toBe(true);
  });

  test('Font family is detected from STYLEREFS', async () => {
    // Check that font family is extracted from TextStyle definitions
    // The first TextBlock in TopMargin uses font2 which is Times New Roman
    const word = scribe.data.ocr.active[0].lines[0].words[0];
    // STYLEREFS at TextBlock level should be inherited by words
    expect(word.style.font).toBe('Times New Roman');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check ALTO XML multi-page import.', () => {
  test('Should import multi-page ALTO XML document', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/testocr_all_orientations.alto.xml`]);
    expect(scribe.data.ocr.active.length).toBe(12);
  });

  test('Should correctly parse page dimensions', async () => {
    const page = scribe.data.ocr.active[0];
    expect(scribe.data.ocr.active[0].dims.height).toBe(480);
    expect(scribe.data.ocr.active[0].dims.width).toBe(640);
    expect(page.dims.height > 0).toBe(true);
    expect(page.dims.width > 0).toBe(true);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check ALTO XML import positioning matches Abbyy.', () => {
  /** @type {Object<number, {baseline: Array<number>, fontSize: number, baselineY: number}>} */
  let abbyyLineMetrics;
  /** @type {Object<number, {baseline: Array<number>, fontSize: number, baselineY: number}>} */
  let altoLineMetrics;

  beforeAll(async () => {
    await scribe.init({ ocr: true, font: true });

    // First, import Abbyy XML to get accurate line metrics (ground truth)
    await scribe.importFiles([
      `${ASSETS_PATH}/ascenders_descenders_test.png`,
      `${ASSETS_PATH}/ascenders_descenders_test.abbyy.xml`,
    ]);

    abbyyLineMetrics = {};
    const abbyyPage = scribe.data.ocr.active[0];
    for (let lineIdx = 0; lineIdx < abbyyPage.lines.length; lineIdx++) {
      const line = abbyyPage.lines[lineIdx];
      const wordMetrics = scribe.utils.calcWordMetrics(line.words[0]);
      abbyyLineMetrics[lineIdx] = {
        baseline: [...line.baseline],
        fontSize: wordMetrics.fontSize,
        baselineY: line.bbox.bottom + line.baseline[1],
      };
    }

    await scribe.clear();
    await scribe.importFiles([
      `${ASSETS_PATH}/ascenders_descenders_test.png`,
      `${ASSETS_PATH}/ascenders_descenders_test.alto.xml`,
    ]);

    altoLineMetrics = {};
    const altoPage = scribe.data.ocr.active[0];
    for (let lineIdx = 0; lineIdx < altoPage.lines.length; lineIdx++) {
      const line = altoPage.lines[lineIdx];
      const wordMetrics = scribe.utils.calcWordMetrics(line.words[0]);
      altoLineMetrics[lineIdx] = {
        baseline: [...line.baseline],
        fontSize: wordMetrics.fontSize,
        baselineY: line.bbox.bottom + line.baseline[1],
      };
    }
  });

  test('ALTO line 0 font size should match Abbyy font size', async () => {
    const altoFontSize = altoLineMetrics[0].fontSize;
    const abbyyFontSize = abbyyLineMetrics[0].fontSize;
    const percentDiff = Math.abs(altoFontSize - abbyyFontSize) / abbyyFontSize;
    expect(Math.abs((altoFontSize) - (abbyyFontSize))).toBeLessThanOrEqual(5);
    expect(percentDiff).toBeLessThan(0.1);
  });

  test('ALTO line 1 font size should match Abbyy font size', async () => {
    const altoFontSize = altoLineMetrics[1].fontSize;
    const abbyyFontSize = abbyyLineMetrics[1].fontSize;
    const percentDiff = Math.abs(altoFontSize - abbyyFontSize) / abbyyFontSize;
    console.log(`Line 1: ALTO fontSize=${altoFontSize}, Abbyy fontSize=${abbyyFontSize}, diff=${(percentDiff * 100).toFixed(1)}%`);
    expect(Math.abs((altoFontSize) - (abbyyFontSize))).toBeLessThanOrEqual(5);
    expect(percentDiff).toBeLessThan(0.1);
  });

  test('ALTO line 2 font size should match Abbyy font size', async () => {
    const altoFontSize = altoLineMetrics[2].fontSize;
    const abbyyFontSize = abbyyLineMetrics[2].fontSize;
    const percentDiff = Math.abs(altoFontSize - abbyyFontSize) / abbyyFontSize;
    expect(Math.abs((altoFontSize) - (abbyyFontSize))).toBeLessThanOrEqual(5);
    expect(percentDiff).toBeLessThan(0.1);
  });

  test('ALTO line 0 baseline Y should match Abbyy baseline Y', async () => {
    const altoBaselineY = altoLineMetrics[0].baselineY;
    const abbyyBaselineY = abbyyLineMetrics[0].baselineY;
    const percentDiff = Math.abs(altoBaselineY - abbyyBaselineY) / abbyyBaselineY;
    expect(Math.abs((altoBaselineY) - (abbyyBaselineY))).toBeLessThanOrEqual(3);
    expect(percentDiff).toBeLessThan(0.1);
  });

  test('ALTO line 1 baseline Y should match Abbyy baseline Y', async () => {
    const altoBaselineY = altoLineMetrics[1].baselineY;
    const abbyyBaselineY = abbyyLineMetrics[1].baselineY;
    const percentDiff = Math.abs(altoBaselineY - abbyyBaselineY) / abbyyBaselineY;
    expect(Math.abs((altoBaselineY) - (abbyyBaselineY))).toBeLessThanOrEqual(3);
    expect(percentDiff).toBeLessThan(0.1);
  });

  test('ALTO line 2 baseline Y should match Abbyy baseline Y', async () => {
    const altoBaselineY = altoLineMetrics[2].baselineY;
    const abbyyBaselineY = abbyyLineMetrics[2].baselineY;
    const percentDiff = Math.abs(altoBaselineY - abbyyBaselineY) / abbyyBaselineY;
    expect(Math.abs((altoBaselineY) - (abbyyBaselineY))).toBeLessThanOrEqual(3);
    expect(percentDiff).toBeLessThan(0.1);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
