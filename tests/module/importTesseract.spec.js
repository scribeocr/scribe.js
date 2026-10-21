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

    expect(page.pars.map((x) => x.lines.length), 'the ocr_par elements of a Tesseract hOCR file did not become the page\'s paragraphs').toEqual([2, 1, 10, 1]);
    expect(page.lines[2].par, 'a caption line is not in the paragraph its ocr_par puts it in').toBe(page.pars[1]);
    expect(page.textSource, 'an hOCR page does not record its source').toBe('hocr');
  });

  // When using Tesseract.js or the Tesseract API to save individual pages as .hocr files, the output is different from the output of the Tesseract CLI,
  // as they only include the div with the class 'ocr_page' and the text content of the page, not the entire HTML structure.
  test('Should import HOCR pages created with Tesseract API/Tesseract.js', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/bill.tesseractjs.hocr`]);

    const page = doc.ocr.active[0];

    const text1 = page.lines[0].words.map((x) => x.text).join(' ');

    expect(text1).toBe('FIRST CHEQUING');

    expect(page.pars.map((x) => x.lines.length), 'a single-block hOCR page lost the paragraphs its producer wrote').toEqual([1, 1, 13]);
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

    const page = doc.ocr.active[0];
    expect(page.pars.length, 'the page does not carry one paragraph per ocr_par of its hOCR file').toBe(21);
    expect(page.lines[30].par.lines.length, 'an author e-mail line is not the paragraph of its own that its ocr_par makes it').toBe(1);
    expect(page.lines[34].par, 'the acknowledgment note is split across paragraphs').toBe(page.lines[43].par);
    expect(page.lines[34].par.lines.length, 'the acknowledgment paragraph does not hold exactly its ten lines').toBe(10);
    const parsBefore = page.pars;
    await doc.exportData('txt', { reflow: true });
    expect(page.pars, 'a reflowed text export replaced the paragraphs of an hOCR page').toBe(parsBefore);
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

async function readFileContent(filePath) {
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    const fs = await import('node:fs/promises');
    return fs.readFile(filePath, 'utf-8');
  }
  const response = await fetch(filePath);
  return response.text();
}

describe('Check hOCR detection from content alone.', () => {
  test('Should import the bare ocr_page fragment tesseract.js writes, without a file name', async () => {
    const text = await readFileContent(`${ASSETS_PATH}/bill.tesseractjs.hocr`);
    doc = await scribe.openDocument({ ocrFiles: [new TextEncoder().encode(text).buffer] });
    expect(doc.ocr.active[0].lines[0].words.map((x) => x.text).join(' '), 'a fragment with no XML declaration or html root is read as hOCR').toBe('FIRST CHEQUING');
  });

  test('Should import a double-quoted hOCR file: caption lines, character spans and padded words', async () => {
    // Archive.org's hOCR files use double-quoted attributes.
    // Those converted from ABBYY output also pad word spans with spaces.
    const billText = (await readFileContent(`${ASSETS_PATH}/bill.hocr`)).replace(/'/g, '"').replace('>FIRST<', '>FIRST <');
    doc = await scribe.openDocument({ ocrFiles: [new TextEncoder().encode(billText).buffer] });
    const page = doc.ocr.active[0];
    expect(page.lines.length, 'a double-quoted ocr_caption span was dropped on import').toBe(14);
    expect(page.lines[2].words.map((x) => x.text).join(' '), 'the caption line lost its words').toBe('Date Description Number Debits Credits Balance');
    expect(page.lines[0].words[0].text, 'whitespace padding inside a word span became part of the word').toBe('FIRST');

    const charText = (await readFileContent(`${ASSETS_PATH}/tesseract_italics_example_1b.hocr`)).replace(/'/g, '"');
    doc = await scribe.openDocument({ ocrFiles: [new TextEncoder().encode(charText).buffer] });
    const charPage = doc.ocr.active[0];
    expect(charPage.lines.map((x) => x.words.length), 'double-quoted character spans yielded no words').toEqual([10, 4, 6, 11]);
    expect(charPage.lines[0].words.map((x) => x.text).join(' '), 'a character-level line lost its text').toBe('Earnings In Line bespite Press Outages; Staying Neutral on Valuation');
    expect(charPage.lines[0].words.map((x) => x.chars.length), 'character boxes were lost on a double-quoted file').toEqual([8, 2, 4, 7, 5, 8, 7, 7, 2, 9]);
  });

  // The input carries an XML declaration because any XML with one was once read as hOCR.
  test('Should reject an XML file that is no OCR format', async () => {
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<notes><note>This is not an OCR file.</note></notes>\n';
    await expect(scribe.openDocument({ ocrFiles: [new TextEncoder().encode(xml).buffer] }), 'unknown XML is rejected at detection').rejects.toThrow('No supported OCR format detected');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
