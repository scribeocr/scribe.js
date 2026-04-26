import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

import { writeText } from '../../js/export/writeText.js';

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

// Using arrow functions breaks references to `this`.

describe('Check export for .txt files.', () => {
  test('Exporting simple paragraph to text works properly', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/testocr.abbyy.xml`]);

    const exportedText = await scribe.exportData('text');

    const testText = `This is a lot of 12 point text to test the ocr code and see if it works on all types of file format.
The quick brown dog jumped over the lazy fox. The quick brown dog jumped over the lazy fox. The quick brown dog jumped over the lazy fox. The quick brown dog jumped over the lazy fox.`;

    expect(exportedText).toBe(testText);

    expect(exportedText).toContain('This is a lot of 12 point text');
    expect(exportedText).toContain('The quick brown dog jumped');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check non-contiguous pageArr subsetting for text export.', () => {
  // trident_v_connecticut_general.abbyy.xml has 7 pages.
  // Page 0 contains "Officer Comstock" (unique to page 0).
  // Page 1 contains "Munger, Tolles" (unique to page 1).
  // Page 2 contains "Security First Life" (unique to page 2).
  test('Exporting pages [0, 2] should include pages 0 and 2 but not page 1', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/trident_v_connecticut_general.abbyy.xml`]);

    const exportedText = await scribe.exportData('text', { pageArr: [0, 2] });

    // "Comstock" only appears on page 0 — should be present
    expect(exportedText).toContain('Comstock');
    // "Security" only appears on page 2 — should be present
    expect(exportedText).toContain('Security');
    // "Munger" only appears on page 1 — should not be present
    expect(exportedText).not.toContain('Munger');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check export -> import for .txt files.', () => {
  test('Importing .txt file and exporting to text should preserve content (simple example)', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/text_simple.txt`]);

    const importedText = scribe.data.ocr.active.map((page) => page.lines.map((line) => line.words.map((word) => word.text).join(' ')).join('\n')).join('\n\n');

    const exportedText = await scribe.exportData('text');

    expect(exportedText).toBe(importedText);

    expect(exportedText).toContain('Tesseract.js');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check preserveSpacing text export.', () => {
  test('preserveSpacing output is longer than compact output due to padding', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/border_patrol_tables.pdf`]);
    const compact = writeText({
      ocrCurrent: scribe.data.ocr.active, pageArr: [0], lineNumbers: true,
    });
    const spaced = writeText({
      ocrCurrent: scribe.data.ocr.active, pageArr: [0], lineNumbers: true, preserveSpacing: true,
    });
    expect(compact.length).toBe(3348);
    expect(spaced.length).toBe(17325);
  });

  test('preserveSpacing indents words based on their horizontal position', async () => {
    const spaced = writeText({
      ocrCurrent: scribe.data.ocr.active, pageArr: [0], lineNumbers: true, preserveSpacing: true,
    });
    // "SECTOR" starts with significant left indent in the document
    expect(spaced).toContain('0:0             SECTOR');
    // "Miami" appears at the left edge of the data area
    expect(spaced).toContain('0:15     Miami');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
