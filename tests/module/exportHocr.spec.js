import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import { writeHocr } from '../../js/export/writeHocr.js';
import { gs } from '../../js/generalWorkerMain.js';
import { splitHOCRStr } from '../../js/import/importOCR.js';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

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
      // HOCR does not preserve line IDs
      line.id = '';
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

describe('Check .hocr export function.', () => {
  test('Exporting to .hocr and reimporting should restore OCR data without modification', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/scribe_test_pdf1.abbyy.xml`]);

    const ocrAllComp1 = standardizeOCRPages(scribe.data.ocr.active);

    const hocrOutStrArr = splitHOCRStr(writeHocr({ ocrData: scribe.data.ocr.active }));

    const resArrPromises = hocrOutStrArr.map((x, i) => (gs.schedulerInner.addJob('convertPageHocr', { ocrStr: x, n: i, scribeMode: true })));
    const resArr = await Promise.all(resArrPromises);
    const pagesArr = resArr.map((x) => (x.pageObj));

    const ocrAllComp2 = standardizeOCRPages(pagesArr);

    expect(ocrAllComp1).toEqual(ocrAllComp2);
  });

  test('Exporting to .hocr and reimporting should restore layout tables without modification', async () => {
    // This file should contain data tables when parsed.
    await scribe.importFiles([`${ASSETS_PATH}/bill.abbyy.xml`]);
    expect(scribe.data.layoutDataTables.pages[0].tables.length).toBeGreaterThan(0);

    const layoutTables1 = structuredClone(scribe.data.layoutDataTables.pages);

    const hocrOutStr = writeHocr({ ocrData: scribe.data.ocr.active });
    const encoder = new TextEncoder();
    const encoded = encoder.encode(hocrOutStr);

    await scribe.terminate();
    await scribe.importFiles({ ocrFiles: [encoded.buffer] });

    const layoutTables2 = structuredClone(scribe.data.layoutDataTables.pages);

    expect(layoutTables1).toEqual(layoutTables2);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check non-contiguous pageArr subsetting for .hocr export.', () => {
  test('Exporting pages [0, 2] should include pages 0 and 2 but not page 1', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/trident_v_connecticut_general.abbyy.xml`]);

    const exportedHocr = await scribe.exportData('hocr', { pageArr: [0, 2] });

    // "Comstock" only appears on page 0 — should be present
    expect(exportedHocr).toContain('Comstock');
    // "Security" only appears on page 2 — should be present
    expect(exportedHocr).toContain('Security');
    // "Munger" only appears on page 1 — should not be present
    expect(exportedHocr).not.toContain('Munger');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
