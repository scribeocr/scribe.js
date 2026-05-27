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

/**
 *
 * @param {Array<OcrPage>} ocrArr
 */
const standardizeOCRPages = (ocrArr) => {
  const ocrArrCopy = ocrArr.map((x) => scribe.utils.ocr.clonePage(x));

  ocrArrCopy.forEach((page) => {
    page.lines.forEach((line) => {
      line.debug = new scribe.utils.ocr.LineDebugInfo();
      line.bbox.left = Math.round(line.bbox.left);
      line.bbox.top = Math.round(line.bbox.top);
      line.bbox.right = Math.round(line.bbox.right);
      line.bbox.bottom = Math.round(line.bbox.bottom);
      line.words.forEach((word) => {
        word.debug = new scribe.utils.ocr.WordDebugInfo();
        word.bbox.left = Math.round(word.bbox.left);
        word.bbox.top = Math.round(word.bbox.top);
        word.bbox.right = Math.round(word.bbox.right);
        word.bbox.bottom = Math.round(word.bbox.bottom);
        word.style = { ...word.style };
        if (word.style.size) word.style.size = Math.round(word.style.size);
        word.chars = null;
      });
    });
  });

  return ocrArrCopy;
};

describe('Check .scribe export function.', () => {
  test('Exporting to .scribe (gzipped, default) and reimporting should restore OCR data without modification', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.pdf`]);

    const ocrAllComp1 = standardizeOCRPages(doc.ocr.active);

    scribe.ScribeDoc.defaults.compressScribe = true;
    const scribeData = await doc.exportData('scribe');

    // Verify data is gzipped by checking magic bytes
    const dataArray = new Uint8Array(scribeData);
    expect(dataArray[0]).toBe(0x1F);
    expect(dataArray[1]).toBe(0x8B);

    await scribe.terminate();
    doc = await scribe.openDocument({ scribeFiles: [scribeData] });

    const ocrAllComp2 = standardizeOCRPages(doc.ocr.active);

    expect(ocrAllComp1).toEqual(ocrAllComp2);
    await doc.clear();
    await scribe.terminate();
  });

  test('Exporting to .scribe (non-gzipped) and reimporting should restore OCR data without modification', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.pdf`]);

    const ocrAllComp1 = standardizeOCRPages(doc.ocr.active);

    scribe.ScribeDoc.defaults.compressScribe = false;
    const scribeData = await doc.exportData('scribe');

    // Verify data is not gzipped
    expect(typeof scribeData).toBe('string');
    expect(scribeData[0]).toBe('{');

    const encoder = new TextEncoder();
    const scribeDataBuffer = encoder.encode(scribeData).buffer;

    await scribe.terminate();
    doc = await scribe.openDocument({ scribeFiles: [scribeDataBuffer] });

    const ocrAllComp2 = standardizeOCRPages(doc.ocr.active);

    expect(ocrAllComp1).toEqual(ocrAllComp2);

    scribe.ScribeDoc.defaults.compressScribe = true;
    await doc.clear();
    await scribe.terminate();
  });

  test('Reimporting .scribe alongside PDF should preserve page angle', async () => {
    const pdfPath = `${ASSETS_PATH}/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.pdf`;
    doc = await scribe.openDocument([pdfPath]);

    doc.ocr.active[0].angle = 2.5;

    scribe.ScribeDoc.defaults.compressScribe = false;
    const scribeData = await doc.exportData('scribe');
    const encoder = new TextEncoder();
    const scribeDataBuffer = encoder.encode(scribeData).buffer;

    await scribe.terminate();
    doc = await scribe.openDocument({ scribeFiles: [scribeDataBuffer], pdfFiles: [pdfPath] });

    expect(doc.pageMetrics[0].angle).toBe(2.5);

    await doc.clear();
    await scribe.terminate();
  });

  test('Exporting with includeExtraTextScribe should add text properties, which are removed on import', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.pdf`]);

    const ocrAllComp1 = standardizeOCRPages(doc.ocr.active);

    scribe.ScribeDoc.defaults.compressScribe = false;
    scribe.ScribeDoc.defaults.includeExtraTextScribe = true;
    const scribeData = await doc.exportData('scribe');

    // Verify data contains correct text properties
    const parsedData = JSON.parse(scribeData);
    const page = parsedData.ocr[0];

    expect(page.lines[0].text).toBe('UNITED STATES DISTRICT COURT');
    expect(page.lines[1].text).toBe('FOR THE EASTERN DISTRICT OF MICHIGAN');
    // Page-level text join: pin length, header start, court-system footer.
    expect(page.text.length).toBe(1449);
    expect(page.text.slice(0, 65)).toBe('UNITED STATES DISTRICT COURT\nFOR THE EASTERN DISTRICT OF MICHIGAN');
    expect(page.text.slice(-72)).toBe('Case 2:12-cv-13821-AC-DRG ECF No. 1, PageID.1 Filed 08/29/12 Page 1 of 6');
    expect(page.pars[0].text).toBe('UNITED STATES DISTRICT COURT FOR THE EASTERN DISTRICT OF MICHIGAN');

    const encoder = new TextEncoder();
    const scribeDataBuffer = encoder.encode(scribeData).buffer;

    await scribe.terminate();
    doc = await scribe.openDocument({ scribeFiles: [scribeDataBuffer] });

    // Verify text properties are removed after import
    const activeOcr = doc.ocr.active;
    expect('text' in activeOcr[0]).toBe(false);
    expect('text' in activeOcr[0].lines[0]).toBe(false);
    if (activeOcr[0].pars && activeOcr[0].pars.length > 0) {
      expect('text' in activeOcr[0].pars[0]).toBe(false);
    }

    // Verify OCR data is unchanged
    const ocrAllComp2 = standardizeOCRPages(doc.ocr.active);
    expect(ocrAllComp1).toEqual(ocrAllComp2);

    scribe.ScribeDoc.defaults.compressScribe = true;
    scribe.ScribeDoc.defaults.includeExtraTextScribe = false;
    await doc.clear();
    await scribe.terminate();
  });

  test('Importing .scribe after terminate() and exporting to PDF should succeed without font errors', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.pdf`]);

    scribe.ScribeDoc.defaults.compressScribe = true;
    const scribeData = await doc.exportData('scribe');

    await scribe.terminate();
    doc = await scribe.openDocument({ scribeFiles: [scribeData] });

    scribe.ScribeDoc.defaults.displayMode = 'ebook';
    const pdfData = await doc.exportData('pdf');

    expect(pdfData.byteLength || pdfData.length).toBeGreaterThan(0);

    await doc.clear();
    await scribe.terminate();
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
