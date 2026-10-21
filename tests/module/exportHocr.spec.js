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
    // The page angle is recomputed from rounded baselines on import, so it does not round-trip exactly.
    page.angle = 0;
    page.textSource = null;
    page.pars.forEach((par) => {
      par.id = '';
      par.reason = '';
      par.debug = new scribe.utils.ocr.ParDebugInfo();
      par.bbox.left = Math.round(par.bbox.left);
      par.bbox.top = Math.round(par.bbox.top);
      par.bbox.right = Math.round(par.bbox.right);
      par.bbox.bottom = Math.round(par.bbox.bottom);
    });
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
    const doc = await scribe.openDocument([`${ASSETS_PATH}/scribe_test_pdf1.abbyy.xml`]);

    // One word gets a drop cap, whose nested span the importer must read without ending the line early.
    doc.ocr.active[0].lines[0].words[0].style.dropcap = true;

    const ocrAllComp1 = standardizeOCRPages(doc.ocr.active);

    const hocrOutStrArr = splitHOCRStr(writeHocr({
      ocrData: doc.ocr.active,
      docFonts: doc.fonts,
      layoutRegions: doc.layoutRegions,
      pageMetrics: doc.pageMetrics,
      dataTablesSerialized: doc.serializeLayoutDataTables(),
    }));

    const resArrPromises = hocrOutStrArr.map((x, i) => (gs.schedulerInner.addJob('convertPageHocr', { ocrStr: x, n: i, scribeMode: true })));
    const resArr = await Promise.all(resArrPromises);
    const pagesArr = resArr.map((x) => (x.pageObj));

    const ocrAllComp2 = standardizeOCRPages(pagesArr);

    expect(ocrAllComp2, 'the hOCR export and re-import changed the text, boxes, styles or paragraphs').toEqual(ocrAllComp1);
  });

  test('Exporting to .hocr and reimporting should restore layout tables without modification', async () => {
    // This file should contain data tables when parsed.
    const doc = await scribe.openDocument([`${ASSETS_PATH}/bill.abbyy.xml`]);
    expect(doc.layoutDataTables.pages[0].tables.length).toBeGreaterThan(0);

    const layoutTables1 = structuredClone(doc.layoutDataTables.pages);

    const hocrOutStr = writeHocr({
      ocrData: doc.ocr.active,
      docFonts: doc.fonts,
      layoutRegions: doc.layoutRegions,
      pageMetrics: doc.pageMetrics,
      dataTablesSerialized: doc.serializeLayoutDataTables(),
    });
    const encoder = new TextEncoder();
    const encoded = encoder.encode(hocrOutStr);

    await scribe.terminate();
    const doc2 = await scribe.openDocument({ ocrFiles: [encoded.buffer] });

    const page2 = doc2.ocr.active[0];
    expect(page2.pars.length, 'the paragraph count changed on hOCR export and re-import').toBe(51);
    expect(page2.pars.map((x) => x.lines.length).slice(0, 6), 'paragraph membership changed on hOCR export and re-import').toEqual([1, 1, 1, 1, 12, 1]);
    expect(page2.lines[5].par, 'a re-imported line left the paragraph it was exported in').toBe(page2.lines[11].par);
    expect(page2.lines[3].par, 'two paragraphs merged on hOCR export and re-import').not.toBe(page2.lines[4].par);

    const layoutTables2 = structuredClone(doc2.layoutDataTables.pages);

    expect(layoutTables1).toEqual(layoutTables2);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check non-contiguous pageArr subsetting for .hocr export.', () => {
  test('Exporting pages [0, 2] should include pages 0 and 2 but not page 1', async () => {
    const doc = await scribe.openDocument([`${ASSETS_PATH}/trident_v_connecticut_general.abbyy.xml`]);

    const exportedHocr = await doc.exportData('hocr', { pageArr: [0, 2] });

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
