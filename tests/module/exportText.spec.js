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
    const doc = await scribe.openDocument([`${ASSETS_PATH}/testocr.abbyy.xml`]);

    const exportedText = await doc.exportData('text');

    const testText = `This is a lot of 12 point text to test the ocr code and see if it works on all types of file format.
The quick brown dog jumped over the lazy fox. The quick brown dog jumped over the lazy fox. The quick brown dog jumped over the lazy fox. The quick brown dog jumped over the lazy fox.`;

    expect(exportedText).toBe(testText);

    expect(exportedText).toContain('This is a lot of 12 point text');
    expect(exportedText).toContain('The quick brown dog jumped');

    // Regression: exclusion ignored `inclusionLevel`/`inclusionRule` and always dropped whole lines.
    const layoutPage = doc.layoutRegions.pages[0];

    const wordBox = new scribe.layout.LayoutRegion(layoutPage, 0, {
      left: 245, top: 85, right: 370, bottom: 124,
    }, 'exclude');
    layoutPage.boxes[wordBox.id] = wordBox;
    expect(await doc.exportData('text', { enableLayout: true }), 'a word-level exclude box (the default) drops exactly the words under it, even mid-line')
      .toBe(`This is a lot of text to test the ocr code and see if it works on all types of file format.
The quick brown dog jumped over the lazy fox. The quick brown dog jumped over the lazy fox. The quick brown dog jumped over the lazy fox. The quick brown dog jumped over the lazy fox.`);
    expect(await doc.exportData('text'), 'layout regions stay inert without enableLayout').toBe(testText);
    delete layoutPage.boxes[wordBox.id];

    const leftBox = new scribe.layout.LayoutRegion(layoutPage, 0, {
      left: 340, top: 190, right: 360, bottom: 230,
    }, 'exclude');
    leftBox.inclusionRule = 'left';
    layoutPage.boxes[leftBox.id] = leftBox;
    expect(await doc.exportData('text', { enableLayout: true }), "the 'left' rule drops a word whose left edge is inside the box, though most of the word is outside")
      .toBe(`This is a lot of 12 point text to test the ocr code and see if it works on all types of file format.
The quick brown dog over the lazy fox. The quick brown dog jumped over the lazy fox. The quick brown dog jumped over the lazy fox. The quick brown dog jumped over the lazy fox.`);
    delete layoutPage.boxes[leftBox.id];

    const lineBox = new scribe.layout.LayoutRegion(layoutPage, 0, {
      left: 30, top: 155, right: 150, bottom: 190,
    }, 'exclude');
    lineBox.inclusionLevel = 'line';
    layoutPage.boxes[lineBox.id] = lineBox;
    expect(await doc.exportData('text', { enableLayout: true }), 'a line-level exclude box drops the whole line, including words outside the box')
      .toBe(`This is a lot of 12 point text to test the ocr code and see if it works on all types
The quick brown dog jumped over the lazy fox. The quick brown dog jumped over the lazy fox. The quick brown dog jumped over the lazy fox. The quick brown dog jumped over the lazy fox.`);
    delete layoutPage.boxes[lineBox.id];

    const orderA = new scribe.layout.LayoutRegion(layoutPage, 0, {
      left: 30, top: 85, right: 590, bottom: 125,
    }, 'order');
    const orderB = new scribe.layout.LayoutRegion(layoutPage, 0, {
      left: 30, top: 155, right: 230, bottom: 190,
    }, 'order');
    layoutPage.boxes[orderA.id] = orderA;
    layoutPage.boxes[orderB.id] = orderB;
    expect(await doc.exportData('text', { enableLayout: true }), 'equal-priority order boxes keep original relative order and move ahead of unassigned lines')
      .toBe(`This is a lot of 12 point text to test the of file format. ocr code and see if it works on all types
The quick brown dog jumped over the lazy fox. The quick brown dog jumped over the lazy fox. The quick brown dog jumped over the lazy fox. The quick brown dog jumped over the lazy fox.`);
    delete layoutPage.boxes[orderA.id];
    delete layoutPage.boxes[orderB.id];
  });

  test('Exclude boxes are tested in the deskew-adjusted frame on skewed pages', async () => {
    const doc = await scribe.openDocument([`${ASSETS_PATH}/testocr_all_orientations.abbyy.xml`]);

    // Page 1 is detected at about -4.94 degrees.
    // The box covers "This is a lot" as displayed, while those words' raw bboxes sit about 25px lower and mostly outside it, so a raw-frame test would drop nothing.
    const layoutPage = doc.layoutRegions.pages[1];
    const box = new scribe.layout.LayoutRegion(layoutPage, 0, {
      left: 28, top: 82, right: 205, bottom: 120,
    }, 'exclude');
    layoutPage.boxes[box.id] = box;
    const exportedText = await doc.exportData('text', { pageArr: [1], enableLayout: true });
    expect(exportedText, 'a box drawn against the deskew-adjusted page drops the words it visibly covers')
      .toBe(`
of 12 point text to test the
ocr code and see if it works on all types
of file format.
The quick brown dog jumped over the lazy fox. The quick brown dog jumped over the lazy fox. The quick brown dog jumped over the lazy fox. The quick brown dog jumped over the lazy fox.`);
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
    const doc = await scribe.openDocument([`${ASSETS_PATH}/trident_v_connecticut_general.abbyy.xml`]);

    const exportedText = await doc.exportData('text', { pageArr: [0, 2] });

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
    const doc = await scribe.openDocument([`${ASSETS_PATH}/text_simple.txt`]);

    const importedText = doc.ocr.active.map((page) => page.lines.map((line) => line.words.map((word) => word.text).join(' ')).join('\n')).join('\n\n');

    const exportedText = await doc.exportData('text');

    expect(exportedText).toBe(importedText);

    expect(exportedText).toContain('Tesseract.js');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check preserveSpacing text export.', () => {
  /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
  let doc;
  test('preserveSpacing output is longer than compact output due to padding', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/border_patrol_tables.pdf`]);
    const compact = writeText({
      ocrCurrent: doc.ocr.active, pageArr: [0], lineNumbers: true, pageMetrics: doc.pageMetrics,
    });
    const spaced = writeText({
      ocrCurrent: doc.ocr.active, pageArr: [0], lineNumbers: true, preserveSpacing: true, pageMetrics: doc.pageMetrics,
    });
    expect(compact.length).toBe(3348);
    expect(spaced.length).toBe(17325);
  });

  test('preserveSpacing indents words based on their horizontal position', async () => {
    const spaced = writeText({
      ocrCurrent: doc.ocr.active, pageArr: [0], lineNumbers: true, preserveSpacing: true, pageMetrics: doc.pageMetrics,
    });
    // "SECTOR" starts with significant left indent in the document
    expect(spaced).toContain('0:0             SECTOR');
    // "Miami" appears at the left edge of the data area
    expect(spaced).toContain('0:15     Miami');
  });

  afterAll(async () => {
    await doc.close();
    await scribe.terminate();
  });
});
