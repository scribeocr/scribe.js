import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

// Using arrow functions breaks references to `this`.

describe('Check Google Vision JSON import function.', () => {
  beforeAll(async () => {
    await scribe.importFiles([`${ASSETS_PATH}/ascenders_descenders_test_GoogleVision.json`]);
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
