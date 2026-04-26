import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

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

// Validate that the test stext files have not been modified (e.g., by a linter changing whitespace).
// The difference between testocr.stext and testocr.spacing.stext is specifically about whitespace/formatting,
// so any modification would invalidate the tests.
// Note: Line endings may differ when cloned on Windows vs. Unix systems,
// so we accept both LF and CRLF counts.
describe('Validate stext test file integrity.', () => {
  test('testocr.stext should have expected byte count (detect linter modifications)', async () => {
    const text = await readFileContent(`${ASSETS_PATH}/testocr.stext`);
    expect([44382, 44712]).toContain(text.length);
  });

  test('testocr.spacing.stext should have expected byte count (detect linter modifications)', async () => {
    const text = await readFileContent(`${ASSETS_PATH}/testocr.spacing.stext`);
    expect([57774, 58388]).toContain(text.length);
  });
});

describe('Check stext import function.', () => {
  test('Should import stext file', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/testocr.stext`]);
  });

  test('Should correctly import text content from stext', async () => {
    const text1 = scribe.data.ocr.active[0].lines[0].words.map((x) => x.text).join(' ');
    const text2 = scribe.data.ocr.active[0].lines[1].words.map((x) => x.text).join(' ');
    const text3 = scribe.data.ocr.active[0].lines[2].words.map((x) => x.text).join(' ');
    const text4 = scribe.data.ocr.active[0].lines[3].words.map((x) => x.text).join(' ');
    const text5 = scribe.data.ocr.active[0].lines[4].words.map((x) => x.text).join(' ');
    const text6 = scribe.data.ocr.active[0].lines[5].words.map((x) => x.text).join(' ');
    const text7 = scribe.data.ocr.active[0].lines[6].words.map((x) => x.text).join(' ');
    const text8 = scribe.data.ocr.active[0].lines[7].words.map((x) => x.text).join(' ');

    expect(text1).toBe('This is a lot of 12 point text to test the');
    expect(text2).toBe('ocr code and see if it works on all types');
    expect(text3).toBe('of file format.');
    expect(text4).toBe('The quick brown dog jumped over the');
    expect(text5).toBe('lazy fox. The quick brown dog jumped');
    expect(text6).toBe('over the lazy fox. The quick brown dog');
    expect(text7).toBe('jumped over the lazy fox. The quick');
    expect(text8).toBe('brown dog jumped over the lazy fox.');
  });

  test('Should have correct number of words per line (not import lines as single words)', async () => {
    const wordCount1 = scribe.data.ocr.active[0].lines[0].words.length;
    const wordCount2 = scribe.data.ocr.active[0].lines[1].words.length;
    const wordCount3 = scribe.data.ocr.active[0].lines[2].words.length;
    const wordCount4 = scribe.data.ocr.active[0].lines[3].words.length;
    const wordCount5 = scribe.data.ocr.active[0].lines[4].words.length;
    const wordCount6 = scribe.data.ocr.active[0].lines[5].words.length;
    const wordCount7 = scribe.data.ocr.active[0].lines[6].words.length;
    const wordCount8 = scribe.data.ocr.active[0].lines[7].words.length;

    expect(wordCount1).toBe(11);
    expect(wordCount2).toBe(10);
    expect(wordCount3).toBe(3);
    expect(wordCount4).toBe(7);
    expect(wordCount5).toBe(7);
    expect(wordCount6).toBe(8);
    expect(wordCount7).toBe(7);
    expect(wordCount8).toBe(7);

    const totalWords = scribe.data.ocr.active[0].lines.reduce((sum, line) => sum + line.words.length, 0);
    expect(totalWords).toBe(60);
  });

  test('Should have correct number of lines', async () => {
    expect(scribe.data.ocr.active[0].lines.length).toBe(8);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

// Tests for stext files with different whitespace/formatting (multiline char elements).
// This file has the same content as testocr.stext but with XML formatted with newlines/indentation.
// This exists because a bug previously existed where the import would fail on such files.
describe('Check stext import function with multiline XML formatting (spacing variant).', () => {
  test('Should import stext file with multiline formatting', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/testocr.spacing.stext`]);
  });

  test('Should correctly import text content from stext with multiline formatting', async () => {
    const text1 = scribe.data.ocr.active[0].lines[0].words.map((x) => x.text).join(' ');
    const text2 = scribe.data.ocr.active[0].lines[1].words.map((x) => x.text).join(' ');
    const text3 = scribe.data.ocr.active[0].lines[2].words.map((x) => x.text).join(' ');
    const text4 = scribe.data.ocr.active[0].lines[3].words.map((x) => x.text).join(' ');
    const text5 = scribe.data.ocr.active[0].lines[4].words.map((x) => x.text).join(' ');
    const text6 = scribe.data.ocr.active[0].lines[5].words.map((x) => x.text).join(' ');
    const text7 = scribe.data.ocr.active[0].lines[6].words.map((x) => x.text).join(' ');
    const text8 = scribe.data.ocr.active[0].lines[7].words.map((x) => x.text).join(' ');

    expect(text1).toBe('This is a lot of 12 point text to test the');
    expect(text2).toBe('ocr code and see if it works on all types');
    expect(text3).toBe('of file format.');
    expect(text4).toBe('The quick brown dog jumped over the');
    expect(text5).toBe('lazy fox. The quick brown dog jumped');
    expect(text6).toBe('over the lazy fox. The quick brown dog');
    expect(text7).toBe('jumped over the lazy fox. The quick');
    expect(text8).toBe('brown dog jumped over the lazy fox.');
  });

  test('Should have correct number of words per line with multiline formatting (not import lines as single words)', async () => {
    const wordCount1 = scribe.data.ocr.active[0].lines[0].words.length;
    const wordCount2 = scribe.data.ocr.active[0].lines[1].words.length;
    const wordCount3 = scribe.data.ocr.active[0].lines[2].words.length;
    const wordCount4 = scribe.data.ocr.active[0].lines[3].words.length;
    const wordCount5 = scribe.data.ocr.active[0].lines[4].words.length;
    const wordCount6 = scribe.data.ocr.active[0].lines[5].words.length;
    const wordCount7 = scribe.data.ocr.active[0].lines[6].words.length;
    const wordCount8 = scribe.data.ocr.active[0].lines[7].words.length;

    expect(wordCount1).toBe(11);
    expect(wordCount2).toBe(10);
    expect(wordCount3).toBe(3);
    expect(wordCount4).toBe(7);
    expect(wordCount5).toBe(7);
    expect(wordCount6).toBe(8);
    expect(wordCount7).toBe(7);
    expect(wordCount8).toBe(7);

    const totalWords = scribe.data.ocr.active[0].lines.reduce((sum, line) => sum + line.words.length, 0);
    expect(totalWords).toBe(60);
  });

  test('Should have correct number of lines with multiline formatting', async () => {
    expect(scribe.data.ocr.active[0].lines.length).toBe(8);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
