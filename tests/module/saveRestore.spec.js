import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { writeSavedDoc } from '../../js/export/writeSavedDoc.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';
import {
  LAYOUTS, saveRestoreSave, emptyStores, scribeText, diffValues,
} from './_scribeRoundTrip.js';
import { docPages, expectSamePage } from './_pages.js';

/** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
let doc;

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

/** A page-mode recognition model that returns one fixed hOCR word, so a page it touched is unmistakable. */
class MockHocrModel {
  static config = { name: 'Mock hOCR', outputFormat: 'hocr' };

  static async recognizeImage() {
    const rawData = "<div class='ocr_page' id='page_1' title='bbox 0 0 612 792'><div class='ocr_carea' title='bbox 100 100 300 120'>"
      + "<p class='ocr_par' title='bbox 100 100 300 120'><span class='ocr_line' title='bbox 100 100 300 120; baseline 0 -3; x_size 20'>"
      + "<span class='ocrx_word' title='bbox 100 100 200 120; x_wconf 95'>MOCKWORD</span></span></p></div></div>";
    return { success: true, rawData, format: 'hocr' };
  }
}

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
      expect(doc.getPage(0).textSource, 'fixture page 0 carries the pdf text source').toBe('pdf');
      expect(doc.getPage(0).pars.length, 'fixture page 0 carries 14 analyzed paragraphs').toBe(14);
      expect(doc.getPage(0).lines.filter((l) => l.par).length, 'every fixture line belongs to a paragraph').toBe(39);

      const orig = structuredClone(doc.getPage(0));

      // The sentinel pass below cannot fill empty arrays or fields that need a valid value, so populate those by hand first.
      orig.angle = 1.5;
      orig.graphicLines.push({ y: 100, left: 50, right: 500 });
      orig.tableBoxes.push({
        left: 10, top: 20, right: 300, bottom: 400,
      });
      const line0 = orig.lines[0];
      line0.orientation = 3;
      const word0 = line0.words[0];
      word0.readings = [{
        source: 'sentinel', text: 'alt', conf: 1, rank: 2, span: 1, msg: 'sentinel',
      }];
      word0.styleRuns = [{ i: 1, style: { bold: true } }];
      orig.pars[0].type = 'footnote';
      orig.pars[0].marker = '1';
      orig.pars[0].headingLevel = 2;
      orig.pars[0].footnoteRefId = word0.id;
      word0.footnoteParId = orig.pars[0].id;

      const skipSentinel = new Set(['readings', 'chars', 'styleRuns', 'par', 'page', 'line', 'n']);
      const populated = new Set();
      /** @param {any} obj */
      const fillSentinels = (obj) => {
        if (!obj || typeof obj !== 'object' || populated.has(obj)) return;
        populated.add(obj);
        for (const k of Object.keys(obj)) {
          if (skipSentinel.has(k)) continue;
          const v = obj[k];
          if (v === null || v === undefined || v === '') obj[k] = `sentinel-${k}`;
          else if (v === false) obj[k] = true;
          else if (v === 0) obj[k] = 7;
          else if (typeof v === 'object') fillSentinels(v);
        }
      };
      fillSentinels(orig);

      const clone = scribe.utils.ocr.clonePage(orig);

      expectSamePage(orig, clone, 'clonePage');

      clone.lines[0].words[0].text = 'MUTATED';
      expect(orig.lines[0].words[0].text, 'editing the clone leaves the original word intact').not.toBe('MUTATED');

      const edge = structuredClone(doc.getPage(0, { detail: true }));
      const edgeWords = edge.lines.flatMap((line) => line.words);
      edgeWords[0].text = '﻿UNITED';
      edgeWords[1].text = 'STA\uD800TES';
      const ligature = edgeWords[2].chars;
      ligature.splice(0, 2, { text: 'DI', bbox: { ...ligature[0].bbox, right: ligature[1].bbox.right } });
      edge.lines[0].ascHeight = undefined;
      edgeWords[3].text = null;
      edgeWords[4].text = undefined;
      edgeWords[5].style = null;
      edgeWords[6].style = undefined;
      edgeWords[7].chars[0].text = undefined;

      const pageBudget = scribe.opt.pageBudget;
      doc.insertParsedPage(0, orig, { layer: 'every field', setActive: false, mainData: false });
      doc.insertParsedPage(0, edge, { layer: 'edge values', setActive: false, mainData: false });
      scribe.opt.pageBudget = 1;
      doc.getPage(0);
      const bare = doc.getPage(0, { layer: 'every field' });
      const bareCharWords = bare.lines.flatMap((line) => line.words).filter((word) => word.chars).length;
      const detailed = doc.getPage(0, { layer: 'every field', detail: true });
      const edgeBare = doc.getPage(0, { layer: 'edge values' });
      const edgeBareAsRead = structuredClone(edgeBare);
      const edgeBareWords = edgeBare.lines.flatMap((line) => line.words);
      for (const words of [edgeWords, edgeBareWords]) {
        words[8].bbox.left -= 3;
        words[9].style.italic = true;
        words[10].text += 'x';
      }
      edgeWords[10].chars = null;
      const edgeDetailed = doc.getPage(0, { layer: 'edge values', detail: true });
      const changed = doc.getPage(1);
      changed.lines[0].words[0].text += '*';
      doc.getPage(0);
      const changedReread = doc.getPage(1);
      const changedRereadText = changedReread.lines[0].words[0].text;
      changedReread.lines[0].words[0].text = '-2-';
      scribe.opt.pageBudget = pageBudget;
      expect(bareCharWords, 'a page read back without detail carries character boxes').toBe(0);
      expectSamePage(orig, bare, 'the page record', 'chars');
      expectSamePage(orig, detailed, 'the page and detail records');

      const asRead = edgeBareAsRead.lines.flatMap((line) => line.words);
      expect([asRead[0].text, asRead[1].text, edgeBareAsRead.lines[0].ascHeight, asRead[3].text, asRead[4].text, asRead[5].style, asRead[6].style],
        'a page record keeps a leading U+FEFF, a lone surrogate, and null apart from undefined on a line height, a word text and a word style')
        .toStrictEqual(['﻿UNITED', 'STA\uD800TES', undefined, null, undefined, null, undefined]);
      const edgeDetailedWords = edgeDetailed.lines.flatMap((line) => line.words);
      expect([edgeDetailedWords[2].chars?.length, edgeDetailedWords[2].chars?.[0].text, edgeDetailedWords[7].chars?.[0].text],
        'a detail record keeps a character box that spans two letters, and a character text held as undefined')
        .toStrictEqual([7, 'DI', undefined]);
      expect([edgeDetailedWords[8].bbox.left, edgeDetailedWords[8].chars?.length, edgeDetailedWords[9].style.italic, edgeDetailedWords[9].chars?.length],
        'a word moved or restyled after the page was read keeps the change and still gets its character boxes')
        .toStrictEqual([1465, 2, true, 8]);
      expect(edgeDetailedWords[10].chars, 'a word retyped after the page was read gets no character boxes, since the stored ones no longer line up').toBe(null);
      expectSamePage(edge, edgeDetailed, 'the page and detail records of a page with edge values');
      expect([changedReread === changed, changedRereadText],
        'a word changed in place on a page from doc.getPage keeps the change after the page leaves memory and is rebuilt')
        .toStrictEqual([false, '-2-*']);
    }

    const regionPage = doc.layoutRegions.pages[0];
    const excludeRegion = new scribe.layout.LayoutRegion(regionPage, 0, {
      left: 100, top: 200, right: 500, bottom: 400,
    }, 'exclude');
    regionPage.boxes[excludeRegion.id] = excludeRegion;
    const imageRegion = new scribe.layout.LayoutImageRegion(regionPage, {
      left: 600, top: 700, right: 900, bottom: 1000,
    });
    regionPage.boxes[imageRegion.id] = imageRegion;

    const ocrAllComp1 = standardizeOCRPages(docPages(doc));

    scribe.ScribeDoc.defaults.compressScribe = true;
    const scribeData = await doc.exportData('scribe');

    const dataArray = new Uint8Array(scribeData);
    expect(dataArray[0], 'default .scribe export should be gzipped (magic bytes)').toBe(0x1F);
    expect(dataArray[1], 'default .scribe export should be gzipped (magic bytes)').toBe(0x8B);

    await scribe.terminate();
    doc = await scribe.openDocument({ scribeFiles: [scribeData] });

    const ocrAllComp2 = standardizeOCRPages(docPages(doc));

    expect(ocrAllComp1, 'OCR data changed on gzipped .scribe round-trip').toEqual(ocrAllComp2);

    const wordMixed = doc.getPage(0).lines[30].words[10];
    expect(wordMixed.text, 'mixed-style word changed on .scribe round-trip').toBe('Ltd.,');
    expect(wordMixed.styleRuns, 'intra-word style runs lost on .scribe round-trip').toEqual([{ i: 4, style: { italic: false } }]);

    const regionsRestored = Object.values(doc.layoutRegions.pages[0].boxes);
    expect(regionsRestored.length, 'user-drawn layout regions lost on .scribe round-trip').toBe(2);
    const excludeRestored = regionsRestored.find((b) => b.type === 'exclude');
    expect(excludeRestored?.coords, 'the exclude region changed coordinates on .scribe round-trip').toEqual({
      left: 100, top: 200, right: 500, bottom: 400,
    });
    const imageRestored = /** @type {LayoutImageRegion} */ (regionsRestored.find((b) => b.type === 'image'));
    expect(imageRestored?.coords, 'the image region changed coordinates on .scribe round-trip').toEqual({
      left: 600, top: 700, right: 900, bottom: 1000,
    });
    expect(imageRestored?.excludeText, 'the image region lost its text-suppression flag on .scribe round-trip').toBe(true);
    expect(imageRestored?.source, 'the image region lost its crop-the-raster pixel source on .scribe round-trip').toBe(null);
    expect(imageRestored?.page?.n, 'the restored image region lost its page back-reference, so region deletion would crash').toBe(0);

    // No fixture is large enough to reach the segmented layout naturally, so both exports below force the threshold down to one character.
    doc.addHighlights([{ page: 0, startLine: 0, endLine: 2 }]);
    const scribeDataThresholdOnly = await doc.exportData('scribe', { scribeSegmentThreshold: 1 });
    const thresholdOnlyHeadReader = new Blob([scribeDataThresholdOnly]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    const thresholdOnlyHead = new TextDecoder().decode((await thresholdOnlyHeadReader.read()).value).slice(0, 32);
    await thresholdOnlyHeadReader.cancel().catch(() => {});
    expect(thresholdOnlyHead.startsWith('{"ocr":'), 'without the scribeSegments opt-in a compressed export must stay a single JSON document even past scribeSegmentThreshold').toBe(true);

    const scribeDataSeg = await doc.exportData('scribe', { scribeSegments: true, scribeSegmentThreshold: 1 });
    const segHeadReader = new Blob([scribeDataSeg]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    const segHead = new TextDecoder().decode((await segHeadReader.read()).value).slice(0, 32);
    await segHeadReader.cancel().catch(() => {});
    expect(segHead.startsWith('{"scribeSegments"'), 'forced-threshold .scribe export must use the segmented layout, or the round-trip below silently tests the single-JSON reader').toBe(true);

    await scribe.terminate();
    doc = await scribe.openDocument({ scribeFiles: [scribeDataSeg] });

    expect(standardizeOCRPages(docPages(doc)), 'OCR data changed on segmented .scribe round-trip').toEqual(ocrAllComp1);
    expect(doc.getPage(0).textSource, 'textSource lost by the segmented reader’s per-page normalization').toBe('pdf');
    expect(doc.getPage(0).lines.filter((l) => l.par).length, 'paragraph references not restored by the segmented reader').toBe(39);
    const wordMixedSeg = doc.getPage(0).lines[30].words[10];
    expect(wordMixedSeg.text, 'mixed-style word changed on segmented .scribe round-trip').toBe('Ltd.,');
    expect(wordMixedSeg.styleRuns, 'intra-word style runs lost on segmented .scribe round-trip').toEqual([{ i: 4, style: { italic: false } }]);
    expect(doc.annotations.pages[0].length, 'highlight annotations lost on segmented .scribe round-trip').toBe(12);
    expect(Object.values(doc.layoutRegions.pages[0].boxes).length, 'layout regions lost on segmented .scribe round-trip').toBe(2);

    await doc.clear();
    await scribe.terminate();
  });

  test('Exporting to .scribe (non-gzipped) and reimporting should preserve document data', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.pdf`]);

    const ocrAllComp1 = standardizeOCRPages(docPages(doc));

    scribe.ScribeDoc.defaults.compressScribe = false;
    const scribeData = await doc.exportData('scribe');

    expect(typeof scribeData, 'non-gzipped .scribe export should be a plain JSON string').toBe('string');
    expect(scribeData[0], 'non-gzipped .scribe export should be a plain JSON string').toBe('{');

    const encoder = new TextEncoder();
    const scribeDataBuffer = encoder.encode(scribeData).buffer;

    await scribe.terminate();
    doc = await scribe.openDocument({ scribeFiles: [scribeDataBuffer] });

    const ocrAllComp2 = standardizeOCRPages(docPages(doc));

    expect(ocrAllComp1, 'OCR data changed on non-gzipped .scribe round-trip').toEqual(ocrAllComp2);

    scribe.ScribeDoc.defaults.includeCharBoxesScribe = false;
    const scribeDataNoChars = await doc.exportData('scribe');
    scribe.ScribeDoc.defaults.includeCharBoxesScribe = true;

    await scribe.terminate();
    doc = await scribe.openDocument({ scribeFiles: [encoder.encode(scribeDataNoChars).buffer] });

    const wordMixed = doc.getPage(0).lines[30].words[10];
    expect(wordMixed.chars ?? null, 'char boxes should be excluded by includeCharBoxesScribe: false').toBeNull();
    expect(wordMixed.text, 'mixed-style word changed on char-box-free .scribe round-trip').toBe('Ltd.,');
    expect(wordMixed.styleRuns, 'style runs must survive the .scribe round-trip independently of char boxes').toEqual([{ i: 4, style: { italic: false } }]);

    const scribeStr = /** @type {string} */ (scribeData);
    expect(scribeStr.includes('"textSource":"pdf"'), 'the .scribe export no longer serializes textSource, so the legacy-tag round-trip below is vacuous').toBe(true);
    const legacyScribeData = scribeStr.replaceAll('"textSource":"pdf"', '"textSource":"stext"');
    await scribe.terminate();
    doc = await scribe.openDocument({ scribeFiles: [encoder.encode(legacyScribeData).buffer] });
    expect(doc.getPage(0).textSource, "a legacy .scribe 'stext' tag must restore as 'pdf'").toBe('pdf');

    scribe.ScribeDoc.defaults.compressScribe = true;
    await doc.clear();
    await scribe.terminate();
  });

  test('Reimporting .scribe alongside PDF should preserve page angle', async () => {
    const pdfPath = `${ASSETS_PATH}/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.pdf`;
    doc = await scribe.openDocument([pdfPath]);

    doc.getPage(0).angle = 2.5;

    scribe.ScribeDoc.defaults.compressScribe = false;
    const scribeData = await doc.exportData('scribe');
    const encoder = new TextEncoder();
    const scribeDataBuffer = encoder.encode(scribeData).buffer;

    await scribe.terminate();
    doc = await scribe.openDocument({ scribeFiles: [scribeDataBuffer], pdfFiles: [pdfPath] });

    expect(doc.pageMetrics[0].angle).toBe(2.5);

    // The restored text layer is the PDF's own parse, not user-supplied OCR.
    // Without that distinction every page of a restored session goes to the engine, and the OCR result replaces the native text.
    await doc.recognize({ model: MockHocrModel, ocrPages: 'autoShallow' });
    expect(scribe.utils.ocr.getPageText(doc.getPage(0)).split('\n')[0], 'native text survives recognizing a restored session whose pages need no OCR').toBe('UNITED STATES DISTRICT COURT');
    expect(doc.inputData.ocrApplied.filter(Boolean).length, 'the conservative page selection applies to a restored session as to a fresh open').toBe(0);

    await doc.clear();
    await scribe.terminate();
  });

  test('Exporting with includeExtraTextScribe should add text properties, which are removed on import', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.pdf`]);

    const ocrAllComp1 = standardizeOCRPages(docPages(doc));

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
    const activeOcr = docPages(doc);
    expect('text' in activeOcr[0]).toBe(false);
    expect('text' in activeOcr[0].lines[0]).toBe(false);
    if (activeOcr[0].pars && activeOcr[0].pars.length > 0) {
      expect('text' in activeOcr[0].pars[0]).toBe(false);
    }

    // Verify OCR data is unchanged
    const ocrAllComp2 = standardizeOCRPages(docPages(doc));
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

// A saved file that restores to a different file is wrong whatever the field, so the whole file is compared rather than a chosen few.
describe('A standard .scribe file survives save and restore unchanged.', () => {
  const filingPath = `${ASSETS_PATH}/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.pdf`;
  const imagePath = `${ASSETS_PATH}/testocr.png`;
  const pagePaths = ['simple.png', 'ascenders_descenders_test.png', 'italics_1.png'].map((f) => `${ASSETS_PATH}/${f}`);
  const states = [
    { name: 'An untouched filing', source: { pdfFiles: [filingPath] }, fontSwitchFlips: false },
    { name: 'A filing with every store filled', source: { pdfFiles: [filingPath] }, fontSwitchFlips: false },
    { name: 'An image with an uploaded OCR file', source: { imageFiles: [imagePath] }, fontSwitchFlips: true },
    {
      name: 'Three images with no text, one rotated', source: { imageFiles: pagePaths }, fontSwitchFlips: false, needsSource: true,
    },
  ];
  const paths = ['alone', 'beside its source'];
  // A page with no text is only its image, so a session of such pages has nothing to restore without the images beside it.
  const pathsFor = (/** @type {{needsSource?: boolean}} */ state) => (state.needsSource ? ['beside its source'] : paths);

  /** @type {Record<string, Array<string>>} The values that differ between the two saves, per state, layout and restore path. */
  const changed = {};
  /** @type {Record<string, any>} The first single-layout save of the filled state. */
  let filledFile;
  /**
   * Results recorded from documents opened from saved files.
   * @type {Record<string, any>}
   */
  const fromSaved = {};

  beforeAll(async () => {
    const filing = await scribe.openDocument([filingPath]);
    const records = new Blob((await writeSavedDoc(filing)).parts);
    const image = await scribe.openDocument([imagePath, `${ASSETS_PATH}/testocr.abbyy.xml`]);
    const pages = await scribe.openDocument({ imageFiles: pagePaths });
    pages.pageMetrics[1].rotation = 90;
    const docs = [filing, filing, image, pages];

    for (const [k, state] of states.entries()) {
      if (k === 1) {
        await filing.recognize({ model: MockHocrModel, ocrPages: [false, true, false, false, false, false] });
        filing.addHighlights([{ page: 0, startLine: 0, endLine: 2 }]);
        filing.addFreeText([{
          page: 0,
          bbox: {
            left: 200, top: 300, right: 600, bottom: 360,
          },
          contents: 'A typed note',
        }]);
        filing.addRedactions([{
          page: 0,
          bbox: {
            left: 100, top: 100, right: 400, bottom: 140,
          },
        }]);
        const regionPage = filing.layoutRegions.pages[0];
        const region = new scribe.layout.LayoutRegion(regionPage, 0, {
          left: 100, top: 200, right: 500, bottom: 400,
        }, 'exclude');
        regionPage.boxes[region.id] = region;
        const tablesPage = filing.layoutDataTables.pages[0];
        const table = new scribe.layout.LayoutDataTable(tablesPage);
        table.boxes.push(new scribe.layout.LayoutDataColumn({
          left: 100, top: 200, right: 300, bottom: 400,
        }, table));
        tablesPage.tables.push(table);
        filing.addBookmark({ title: 'Added', page: 1 });
        filing.pageMetrics[4].rotation = 90;
      }
      for (const [layout, options] of LAYOUTS) {
        for (const path of pathsFor(state)) {
          const result = await saveRestoreSave(docs[k], options, path === 'alone' ? null : state.source);
          if (k === 1 && layout === 'single') filledFile = JSON.parse(result.firstText);
          changed[`${state.name}, ${layout}, ${path}`] = result.changed;
        }
      }
    }

    // A deleted and a moved page give the saved file a page order that differs from the PDF's.
    filing.deletePages([5]);
    filing.movePages([0], 1);
    // The document library saves with these options.
    // Segmenting puts the document-level blocks alone on the first line.
    const sessionOptions = {
      compressScribe: true, scribeSession: true, scribeSegments: true, scribeSegmentThreshold: 0,
    };
    const savedFile = /** @type {ArrayBuffer} */ (await filing.exportData('scribe', sessionOptions));
    const savedText = await scribeText(savedFile);
    const work = new Blob((await writeSavedDoc(filing)).parts);
    const closing = await scribe.openDocument({ pdfFiles: [filingPath] }, { saved: { records, work } });
    fromSaved.atOpen = {
      sourcePages: closing.pageMetrics.map((pm) => pm.sourcePageN),
      rotations: closing.pageMetrics.map((pm) => pm.rotation),
      pagesWithWords: docPages(closing).filter(Boolean).length,
      annotations: closing.annotations.pages.map((p) => p.length),
      bookmarks: closing.outline.map((node) => node.title),
    };
    closing.deletePages([0]);
    fromSaved.sourcePagesAfterRefusedDelete = closing.pageMetrics.map((pm) => pm.sourcePageN);
    const closedExport = closing.exportData('txt').then(() => 'resolved', (err) => err.message);
    await closing.close();
    fromSaved.closedExport = await closedExport;

    const reopened = await scribe.openDocument({ pdfFiles: [filingPath] }, { saved: { records, work } });
    const resavedText = await scribeText(await reopened.exportData('scribe', sessionOptions));
    const savedLines = savedText.split('\n').filter(Boolean);
    const resavedLines = resavedText.split('\n').filter(Boolean);
    fromSaved.changed = [];
    for (let i = 0; i < Math.max(savedLines.length, resavedLines.length); i++) {
      diffValues(savedLines[i] ? JSON.parse(savedLines[i]) : undefined, resavedLines[i] ? JSON.parse(resavedLines[i]) : undefined, i === 0 ? 'header' : `page ${i - 1}`, fromSaved.changed);
    }
    fromSaved.unchangedSaveChangesText = (await writeSavedDoc(reopened)).textChanged;
    await reopened.close();

    const cutShort = await scribe.openDocument({ pdfFiles: [filingPath] }, {
      saved: { records: records.slice(0, records.size - 2000), onError: (err) => { fromSaved.failedRead = /** @type {Error} */ (err).message; } },
    });
    fromSaved.failedExport = await cutShort.exportData('scribe', sessionOptions).then(() => 'resolved', (err) => err.message);
    await cutShort.close();

    const ocrPath = `${ASSETS_PATH}/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.xml`;
    const together = await scribe.openDocument([filingPath, ocrPath]);
    const togetherLines = (await scribeText(await together.exportData('scribe', sessionOptions))).split('\n').filter(Boolean);
    const fromOcr = await scribe.openDocument({ pdfFiles: [filingPath] }, {
      saved: { records: new Blob((await writeSavedDoc(together)).parts), pageDims: together.pageMetrics.map((pm) => [pm.dims.width, pm.dims.height]) },
    });
    await together.close();
    const fromOcrLines = (await scribeText(await fromOcr.exportData('scribe', sessionOptions))).split('\n').filter(Boolean);
    fromSaved.ocrFileChanged = [];
    for (let i = 0; i < Math.max(togetherLines.length, fromOcrLines.length); i++) {
      diffValues(togetherLines[i] ? JSON.parse(togetherLines[i]) : undefined, fromOcrLines[i] ? JSON.parse(fromOcrLines[i]) : undefined, i === 0 ? 'header' : `page ${i - 1}`, fromSaved.ocrFileChanged);
    }
    await fromOcr.close();

    await filing.close();
    await image.close();
    await pages.close();
  });

  test('A filing opened from its saved files shows its saved pages before any text is read', () => {
    expect(fromSaved.atOpen, 'the saved page order, rotation, annotations and bookmarks must be in place at open, with no page of text read').toEqual({
      sourcePages: [1, 0, 2, 3, 4],
      rotations: [0, 0, 0, 0, 90],
      pagesWithWords: 0,
      annotations: [0, 14, 0, 0, 0],
      bookmarks: ['Added'],
    });
  });

  test('A document whose text is still being read refuses a page edit', () => {
    expect(fromSaved.sourcePagesAfterRefusedDelete, 'a page deleted before the text is in would be lost or misplaced when its page records arrive').toEqual([1, 0, 2, 3, 4]);
  });

  test('A filing opened from its saved files saves the file it was saved from', () => {
    expect(fromSaved.changed, 'values changed between the .scribe export of the edited filing and that of the filing opened from its saved files').toEqual([]);
    expect(fromSaved.unchangedSaveChangesText, 'a save of a document just opened from its saved files must report its text as unchanged').toBe(false);
  });

  test('An export of a document whose records file cannot be read is rejected, and the failure is reported', () => {
    expect(fromSaved.failedRead, 'a records file cut short must be reported to the host that opened the document').toBe('The saved file is shorter than its page table says.');
    expect(fromSaved.failedExport, 'an export of a document whose text could not be read must be rejected, never written without the text').toBe('The document could not be loaded, so it was not exported.');
  });

  test('A PDF and its OCR file opened from their saved files save the file the two save when opened together', () => {
    expect(fromSaved.ocrFileChanged, 'values differ between a PDF opened with its OCR file and the same pair opened from their saved files').toEqual([]);
  });

  test('An export waiting on a document that is closed while its text is read is rejected', () => {
    expect(fromSaved.closedExport, 'an export must not be written from a document closed before its text arrived').toBe('The document could not be loaded, so it was not exported.');
  });

  for (const state of states) {
    for (const [layout] of LAYOUTS) {
      for (const path of pathsFor(state)) {
        // Restored beside an image, the font optimization switch is re-decided against images that are not loaded yet and flips off.
        // That one difference is expected until the restore keeps the saved decision, and this expectation fails the day it does.
        const fontSwitchFlips = state.fontSwitchFlips && path !== 'alone';
        const expected = fontSwitchFlips ? [`${layout === 'single' ? 'file' : 'header'}.fontState.enableOpt: true -> false`] : [];
        test(`${state.name} saves again unchanged: ${layout} file, restored ${path}`, () => {
          expect(changed[`${state.name}, ${layout}, ${path}`], 'values changed between the first save and the save made after restoring it').toEqual(expected);
        });
      }
    }
  }

  test('A recognition model\'s hOCR paragraph reaches the saved session, without the raw markup', () => {
    expect(filledFile.ocr[1].pars.length, 'the paragraph of a model\'s hOCR page is missing from the saved session').toBe(1);
    expect(JSON.stringify(filledFile.ocr[1]).includes('ocrx_word'), 'the raw hOCR markup is saved into the session').toBe(false);
  });

  // A store that is empty in the filled state passes the comparison above without being tested, since nothing equals nothing.
  test('The filled state fills every store the standard file holds', () => {
    const grew = 'the standard file gained or lost a store: fill it in the filled state above, then list it here';
    expect(Object.keys(filledFile).sort(), grew).toEqual([
      'annotations', 'fontState', 'inputData', 'layoutDataTables', 'layoutRegions', 'ocr', 'outline', 'pageRotations',
    ]);
    expect(Object.keys(filledFile.inputData).sort(), grew).toEqual(['ocrApplied', 'pageStats', 'pdfType', 'requiresOCR']);
    expect([...emptyStores(filledFile), ...emptyStores(filledFile.inputData, 'inputData.')], 'a store holds nothing in the filled state, so its round trip goes untested').toEqual([]);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

// Deleting the width counts mimics a session saved before the font statistics recorded them.
describe('A session whose font statistics cannot be scored still opens with its text.', () => {
  const imagePath = `${ASSETS_PATH}/econometrica_example.png`;
  /** @type {Array<string>} */
  const warnings = [];
  /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
  let restored;

  beforeAll(async () => {
    const saved = await scribe.openDocument([imagePath, `${ASSETS_PATH}/econometrica_example.abbyy.xml`]);
    const file = JSON.parse(/** @type {string} */ (await saved.exportData('scribe', { compressScribe: false })));
    await saved.close();
    for (const family of Object.values(file.fontState.charMetrics)) {
      for (const style of Object.values(family)) if (style && typeof style === 'object') delete style.widthObs;
    }
    const warningHandlerPrev = scribe.opt.warningHandler;
    scribe.opt.warningHandler = (message) => warnings.push(message);
    try {
      restored = await scribe.openDocument({ scribeFiles: [new TextEncoder().encode(JSON.stringify(file)).buffer], imageFiles: [imagePath] });
    } finally {
      scribe.opt.warningHandler = warningHandlerPrev;
    }
  });

  test('The session opens with every word of its page', () => {
    expect(restored.getPage(0).lines.reduce((n, line) => n + line.words.length, 0), 'the restored text is lost when font optimization fails').toBe(532);
  });

  test('The failed font optimization is reported as one warning', () => {
    expect(warnings.map((w) => w.split(':')[0]), 'a failed font optimization is reported through the warning handler instead of rejecting the open')
      .toEqual(['Font optimization failed, so the default fonts are used']);
  });

  afterAll(async () => {
    if (restored) await restored.close();
    await scribe.terminate();
  });
});
