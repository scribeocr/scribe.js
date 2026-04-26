import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

// Using arrow functions breaks references to `this`.

describe('Check cleanup functions allow for resetting module.', () => {
  test('Check that cleanup functions work properly', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/chi_eng_mixed_sample.pdf`]);
    await scribe.terminate();
    await scribe.init();
    await scribe.importFiles([`${ASSETS_PATH}/chi_eng_mixed_sample.pdf`]);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('extractText function can be used with .xml imports.', () => {
  test('Should recognize basic .jpg image using single function', async () => {
    const txt = await scribe.extractText([`${ASSETS_PATH}/econometrica_example.abbyy.xml`]);
    expect(txt.slice(0, 17)).toBe('Check for updates');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
