import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

// Using arrow functions breaks references to `this`.

describe('Check export for markdown files.', () => {
  test('Exporting simple paragraph to markdown works properly', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/testocr.abbyy.xml`]);

    const exportedMd = await scribe.exportData('md');

    expect(exportedMd).toContain('This is a lot of 12 point text');
    expect(exportedMd).toContain('The quick brown dog jumped');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check markdown formatting export.', () => {
  test('Italic text should be wrapped with asterisks', async () => {
    // Use ABBYY format which properly captures italic styling
    await scribe.importFiles([`${ASSETS_PATH}/superscript_examples.abbyy.xml`]);

    const exportedMd = await scribe.exportData('md');

    // "Econometrica" is italic in the source document
    expect(exportedMd).toContain('*Econometrica*');
  });

  test('Bold text should be wrapped with double asterisks', async () => {
    // Use ABBYY format which properly captures bold styling
    await scribe.importFiles([`${ASSETS_PATH}/superscript_examples.abbyy.xml`]);

    const exportedMd = await scribe.exportData('md');

    expect(exportedMd).toContain('**Investments & Acquisitions**');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check non-contiguous pageArr subsetting for markdown export.', () => {
  test('Exporting pages [0, 2] should include pages 0 and 2 but not page 1', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/trident_v_connecticut_general.abbyy.xml`]);

    const exportedMd = await scribe.exportData('md', { pageArr: [0, 2] });

    // "Comstock" only appears on page 0 — should be present
    expect(exportedMd).toContain('Comstock');
    // "Security" only appears on page 2 — should be present
    expect(exportedMd).toContain('Security');
    // "Munger" only appears on page 1 — should not be present
    expect(exportedMd).not.toContain('Munger');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check markdown table export.', () => {
  test('Should export tables as markdown pipe tables', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/border_patrol_tables.abbyy.xml`]);

    const exportedMd = await scribe.exportData('md', { pageArr: [2] });

    // Header row with pipe separators
    expect(exportedMd).toContain('| **SECTOR** | **Female** | **Male** | **Total Apprehensions** |');
    // Separator row after header
    expect(exportedMd).toContain('| --- | --- | --- | --- |');
    // Specific data row
    expect(exportedMd).toContain('| Miami | 220 | 1,671 | 1,891 |');
    expect(exportedMd).toContain('| Ramey | 76 | 486 | 562 |');
  });

  test('Text outside the table is rendered as regular text', async () => {
    const exportedMd = await scribe.exportData('md', { pageArr: [2] });

    // Page title text appears outside the table
    expect(exportedMd).toContain('**United States Border Patrol**');
    expect(exportedMd).toContain('Apprehensions by Gender');
  });

  test('Pages without tables export normally', async () => {
    // testocr.abbyy.xml has no tables
    await scribe.clear();
    await scribe.importFiles([`${ASSETS_PATH}/testocr.abbyy.xml`]);

    const exportedMd = await scribe.exportData('md');

    expect(exportedMd).toContain('This is a lot of 12 point text');
    expect(exportedMd).not.toContain('| --- |');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
