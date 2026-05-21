import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

/** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
let doc;

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

// Using arrow functions breaks references to `this`.

describe('Check .hocr import function (basic)', () => {
  beforeAll(async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/econometrica_example_tess.hocr`]);
  });

  test('Should import HOCR created with Tesseract CLI', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/bill.hocr`]);

    const page = doc.ocr.active[0];

    const text1 = page.lines[0].words.map((x) => x.text).join(' ');

    expect(text1).toBe('FIRST CHEQUING');
  });

  // When using Tesseract.js or the Tesseract API to save individual pages as .hocr files, the output is different from the output of the Tesseract CLI,
  // as they only include the div with the class 'ocr_page' and the text content of the page, not the entire HTML structure.
  test('Should import HOCR pages created with Tesseract API/Tesseract.js', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/bill.tesseractjs.hocr`]);

    const page = doc.ocr.active[0];

    const text1 = page.lines[0].words.map((x) => x.text).join(' ');

    expect(text1).toBe('FIRST CHEQUING');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check .hocr import function (alt settings)', () => {
  beforeAll(async () => {
  });

  test('Should import HOCR created with Tesseract CLI using lstm_choice_mode=1', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/simple_paragraph_lstm_choice_mode1.hocr`]);

    const text1 = doc.ocr.active[0].lines[0].words.map((x) => x.text).join(' ');

    expect(text1).toBe('JNJ announced this morning the acquisition of privately-held Aragon for $650 million');
  });

  test('Should import HOCR created with Tesseract CLI using lstm_choice_mode=2', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/simple_paragraph_lstm_choice_mode2.hocr`]);

    const text1 = doc.ocr.active[0].lines[0].words.map((x) => x.text).join(' ');

    expect(text1).toBe('JNJ announced this morning the acquisition of privately-held Aragon for $650 million');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check Tesseract .hocr import function imports styles correctly.', () => {
  beforeAll(async () => {

  });

  test('Should correctly import small caps printed using font size adjustments', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/econometrica_example_tess.hocr`]);

    const text1 = doc.ocr.active[0].lines[4].words.map((x) => x.text).join(' ');

    const text2 = doc.ocr.active[0].lines[23].words.map((x) => x.text).join(' ');

    expect(text1).toBe('Shubhdeep Deb');

    expect(text2).toBe('Wage inequality in the United States has risen sharply since the 1980s. The skill');
  });

  test('Should ignore italics in imports from Tesseract', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/tesseract_italics_example_1a.hocr`]);

    expect(doc.ocr.active[0].lines[0].words[0].style.italic).toBe(false);
  });

  // This version was created with the hocr_font_info and hocr_char_boxes options enabled.
  test('Should ignore italics in imports from Tesseract (alt configs)', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/tesseract_italics_example_1b.hocr`]);

    expect(doc.ocr.active[0].lines[0].words[0].style.italic).toBe(false);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
