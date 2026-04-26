import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

// Using arrow functions breaks references to `this`.

describe('Check evaluate function.', () => {
  beforeAll(async () => {
  });

  test('Should correctly compare page to ground truth', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/complaint_1.hocr`]);
    await scribe.importFilesSupp([`${ASSETS_PATH}/complaint_1.truth.hocr`], 'Ground Truth');

    const res = await scribe.compareOCR(scribe.data.ocr.active, scribe.data.ocr['Ground Truth']);

    const evalStatsDoc = scribe.utils.calcEvalStatsDoc(res.metrics);

    expect(evalStatsDoc.total).toBe(654);
    expect(evalStatsDoc.correct).toBe(650);
    expect(evalStatsDoc.incorrect).toBe(4);
    expect(evalStatsDoc.missed).toBe(0);
    expect(evalStatsDoc.extra).toBe(0);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check importFilesSupp works with Textract data.', () => {
  test('Should import Textract data as supplementary OCR without error', async () => {
    // Import image first to populate page metrics (required by Textract format).
    await scribe.importFiles([`${ASSETS_PATH}/ascenders_descenders_test.png`,
      `${ASSETS_PATH}/ascenders_descenders_test.abbyy.xml`]);

    // Import Textract as supplementary data — this would throw
    // "Page metrics must be provided for Textract data." before the fix.
    await scribe.importFilesSupp(
      [`${ASSETS_PATH}/ascenders_descenders_test_AwsTextractLayout.json`],
      'Textract',
    );

    // Verify the imported data matches expected content exactly.
    const textractPage = scribe.data.ocr.Textract[0];
    expect(textractPage.lines.length).toBe(3);
    expect(textractPage.lines[0].words.map((x) => x.text).join(' ')).toBe('Ascenders On');
    expect(textractPage.lines[1].words.map((x) => x.text).join(' ')).toBe('query png');
    expect(textractPage.lines[2].words.map((x) => x.text).join(' ')).toBe('we can');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check importFilesSupp works with per-page Textract files.', () => {
  test('Should import per-page Textract files and assign each to the correct page', async () => {
    const subDir = `${ASSETS_PATH}/trident_v_connecticut_general`;

    // Import the multi-page PDF first to populate page metrics.
    await scribe.importFiles([`${ASSETS_PATH}/trident_v_connecticut_general.pdf`]);

    // Import 7 per-page Textract JSON files as supplementary data.
    const textractFiles = [];
    for (let i = 0; i < 7; i++) {
      textractFiles.push(`${subDir}/awsTextract/trident_v_connecticut_general_${String(i).padStart(3, '0')}-AwsTextractLayoutSync.json`);
    }
    await scribe.importFilesSupp(textractFiles, 'Textract');

    // Verify each page has the expected line/word counts and correct first line.
    // Before the fix, all data merged into page 0 (~4500 words) and pages 1-6 were empty.
    const expected = [
      { lines: 98, words: 614, firstLine: '564' },
      { lines: 33, words: 192, firstLine: '565' },
      { lines: 102, words: 674, firstLine: '566' },
      { lines: 118, words: 834, firstLine: '567' },
      { lines: 120, words: 831, firstLine: '568' },
      { lines: 109, words: 732, firstLine: '569' },
      { lines: 100, words: 659, firstLine: '570' },
    ];

    for (let i = 0; i < 7; i++) {
      const page = scribe.data.ocr.Textract[i];
      const wordCount = page.lines.reduce((sum, l) => sum + l.words.length, 0);
      const firstLine = page.lines[0].words.map((w) => w.text).join(' ');
      expect(page.lines.length).toBe(expected[i].lines);
      expect(wordCount).toBe(expected[i].words);
      expect(firstLine).toBe(expected[i].firstLine);
    }
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
