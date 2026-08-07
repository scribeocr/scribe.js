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
  test('Exporting to .scribe (gzipped, default) and reimporting should preserve document data', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.pdf`]);

    // clonePage fidelity guard, on this test's freshly parsed page.
    // standardizeOCRPages snapshots layers with clonePage, so a lossy clone silently narrows every comparison in this file to the fields it copies.
    // A restored document cannot host this check: its pages are revived plain objects, so a field added to the OCR constructors but forgotten in the clone would be absent from both sides.
    {
      expect(doc.ocr.active[0].textSource, 'fixture page 0 carries the pdf text source').toBe('pdf');
      expect(doc.ocr.active[0].pars.length, 'fixture page 0 carries 14 analyzed paragraphs').toBe(14);
      expect(doc.ocr.active[0].lines.filter((l) => l.par).length, 'every fixture line belongs to a paragraph').toBe(39);

      // Stamping the live page would corrupt the export comparison below, so the guard runs on a detached copy.
      const orig = structuredClone(doc.ocr.active[0]);

      // The sentinel pass below cannot fill empty arrays or fields that need a valid value, so populate those by hand first.
      orig.angle = 1.5;
      orig.rules.push({ y: 100, left: 50, right: 500 });
      orig.tableBoxes.push({
        left: 10, top: 20, right: 300, bottom: 400,
      });
      const line0 = orig.lines[0];
      line0.orientation = 3;
      const word0 = line0.words[0];
      word0.textAlt = 'alt';
      word0.lineNum = true;
      word0.styleRuns = [{ i: 1, style: { bold: true } }];
      orig.pars[0].type = 'footnote';
      orig.pars[0].parNum = '1';
      orig.pars[0].headingLevel = 2;
      orig.pars[0].footnoteRefId = word0.id;
      word0.footnoteParId = orig.pars[0].id;

      // Stamp every defaulted field, so a field the clone forgets cannot pass the comparison by matching the constructor default on both sides.
      const skipStamp = new Set(['chars', 'styleRuns', 'par', 'page', 'line']);
      const stamped = new Set();
      /** @param {any} obj */
      const stamp = (obj) => {
        if (!obj || typeof obj !== 'object' || stamped.has(obj)) return;
        stamped.add(obj);
        for (const k of Object.keys(obj)) {
          if (skipStamp.has(k)) continue;
          const v = obj[k];
          if (v === null || v === undefined || v === '') obj[k] = `sentinel-${k}`;
          else if (v === false) obj[k] = true;
          else if (v === 0) obj[k] = 7;
          else if (typeof v === 'object') stamp(v);
        }
      };
      stamp(orig);

      const clone = scribe.utils.ocr.clonePage(orig);

      // An expect() per node is too slow on a graph this size, so expect() runs only once a mismatch is found.
      const seen = new Map();
      /** @param {any} a @param {any} b @param {string} path */
      const compare = (a, b, path) => {
        if (a === null || typeof a !== 'object') {
          if (!Object.is(a, b)) expect(b, `clonePage dropped or altered ${path}`).toBe(a);
          return;
        }
        if (seen.has(a)) {
          if (b !== seen.get(a)) expect(b, `back-reference ${path} points into the original graph instead of the clone`).toBe(seen.get(a));
          return;
        }
        seen.set(a, b);
        if (b === a) expect(b, `clonePage aliased ${path} to the original object`).not.toBe(a);
        if (b === null || typeof b !== 'object') expect(typeof b, `clonePage dropped the object at ${path}`).toBe('object');
        for (const k of Object.keys(a)) compare(a[k], b[k], `${path}.${k}`);
      };
      compare(orig, clone, 'page');

      clone.lines[0].words[0].text = 'MUTATED';
      expect(orig.lines[0].words[0].text, 'editing the clone leaves the original word intact').not.toBe('MUTATED');
    }

    const ocrAllComp1 = standardizeOCRPages(doc.ocr.active);

    scribe.ScribeDoc.defaults.compressScribe = true;
    const scribeData = await doc.exportData('scribe');

    const dataArray = new Uint8Array(scribeData);
    expect(dataArray[0], 'default .scribe export should be gzipped (magic bytes)').toBe(0x1F);
    expect(dataArray[1], 'default .scribe export should be gzipped (magic bytes)').toBe(0x8B);

    await scribe.terminate();
    doc = await scribe.openDocument({ scribeFiles: [scribeData] });

    const ocrAllComp2 = standardizeOCRPages(doc.ocr.active);

    expect(ocrAllComp1, 'OCR data changed on gzipped .scribe round-trip').toEqual(ocrAllComp2);

    const wordMixed = doc.ocr.active[0].lines[30].words[10];
    expect(wordMixed.text, 'mixed-style word changed on .scribe round-trip').toBe('Ltd.,');
    expect(wordMixed.styleRuns, 'intra-word style runs lost on .scribe round-trip').toEqual([{ i: 4, style: { italic: false } }]);

    // No fixture is large enough to reach the segmented layout naturally, so the threshold is forced down to route this document through the segmented writer and reader.
    const scribeDataSeg = await doc.exportData('scribe', { scribeSegmentThreshold: 1 });
    const segHeadReader = new Blob([scribeDataSeg]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    const segHead = new TextDecoder().decode((await segHeadReader.read()).value).slice(0, 32);
    await segHeadReader.cancel().catch(() => {});
    expect(segHead.startsWith('{"scribeSegments"'), 'forced-threshold .scribe export must use the segmented layout, or the round-trip below silently tests the single-JSON reader').toBe(true);

    await scribe.terminate();
    doc = await scribe.openDocument({ scribeFiles: [scribeDataSeg] });

    expect(standardizeOCRPages(doc.ocr.active), 'OCR data changed on segmented .scribe round-trip').toEqual(ocrAllComp1);
    expect(doc.ocr.active[0].textSource, 'textSource lost by the segmented reader’s per-page normalization').toBe('pdf');
    expect(doc.ocr.active[0].lines.filter((l) => l.par).length, 'paragraph references not restored by the segmented reader').toBe(39);
    const wordMixedSeg = doc.ocr.active[0].lines[30].words[10];
    expect(wordMixedSeg.text, 'mixed-style word changed on segmented .scribe round-trip').toBe('Ltd.,');
    expect(wordMixedSeg.styleRuns, 'intra-word style runs lost on segmented .scribe round-trip').toEqual([{ i: 4, style: { italic: false } }]);

    await doc.clear();
    await scribe.terminate();
  });

  test('Exporting to .scribe (non-gzipped) and reimporting should preserve document data', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.pdf`]);

    const ocrAllComp1 = standardizeOCRPages(doc.ocr.active);

    scribe.ScribeDoc.defaults.compressScribe = false;
    const scribeData = await doc.exportData('scribe');

    expect(typeof scribeData, 'non-gzipped .scribe export should be a plain JSON string').toBe('string');
    expect(scribeData[0], 'non-gzipped .scribe export should be a plain JSON string').toBe('{');

    const encoder = new TextEncoder();
    const scribeDataBuffer = encoder.encode(scribeData).buffer;

    await scribe.terminate();
    doc = await scribe.openDocument({ scribeFiles: [scribeDataBuffer] });

    const ocrAllComp2 = standardizeOCRPages(doc.ocr.active);

    expect(ocrAllComp1, 'OCR data changed on non-gzipped .scribe round-trip').toEqual(ocrAllComp2);

    scribe.ScribeDoc.defaults.includeCharBoxesScribe = false;
    const scribeDataNoChars = await doc.exportData('scribe');
    scribe.ScribeDoc.defaults.includeCharBoxesScribe = true;

    await scribe.terminate();
    doc = await scribe.openDocument({ scribeFiles: [encoder.encode(scribeDataNoChars).buffer] });

    const wordMixed = doc.ocr.active[0].lines[30].words[10];
    expect(wordMixed.chars, 'char boxes should be excluded by includeCharBoxesScribe: false').toBeUndefined();
    expect(wordMixed.text, 'mixed-style word changed on char-box-free .scribe round-trip').toBe('Ltd.,');
    expect(wordMixed.styleRuns, 'style runs must survive the .scribe round-trip independently of char boxes').toEqual([{ i: 4, style: { italic: false } }]);

    const scribeStr = /** @type {string} */ (scribeData);
    expect(scribeStr.includes('"textSource":"pdf"'), 'the .scribe export no longer serializes textSource, so the legacy-tag round-trip below is vacuous').toBe(true);
    const legacyScribeData = scribeStr.replaceAll('"textSource":"pdf"', '"textSource":"stext"');
    await scribe.terminate();
    doc = await scribe.openDocument({ scribeFiles: [encoder.encode(legacyScribeData).buffer] });
    expect(doc.ocr.active[0].textSource, "a legacy .scribe 'stext' tag must restore as 'pdf'").toBe('pdf');

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
