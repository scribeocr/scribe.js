import {
  describe, test, expect, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import {
  selectOcrPages, isFullPageImage, isScanPage, mayHaveBakedText, isEmpty,
  hasRealText, isScanOrUnreadable, hasBrokenFontRun,
} from '../../js/pdf/ocrPageSelection.js';
import { ASSETS_PATH } from './_paths.js';

// OCR selection on a real document (TSLA-Q4-2020-Update.pdf, a publicly distributed Tesla investor deck).
// This is a single, born-digital, TEXT-NATIVE slide deck: `pdfType` is `text` and the page geometry is uniform throughout.
// It contains a run of slides dominated by a large image (indices 12-22, ~73% page coverage), an embedded raster figure (index 23), and a native slide carrying image-borne text (index 32).
// All are baked-text candidates, but none is a full-page scan.
//
// It pins two things.
// First, the document-level `autoShallow` rule: a text-native deck is left entirely alone, so `autoShallow` selects nothing.
// Second, the full-page-scan threshold: a ~73% image is below `isFullPageImage`, so `autoDeep` keys on the baked-text signal rather than on scans.
// Recognition wiring and active-layer assembly are covered in the heavier extra suite.
// This CI test pins the deterministic decision only.

const IMAGE_SLIDE_START = 12;
const IMAGE_SLIDE_END = 22; // inclusive (11 large-image slides)
const IMAGE_FIGURE_PAGE = 23; // embedded raster photos, ~21% coverage
const IMAGE_TEXT_PAGE = 32;
const PAGE_COUNT = 34;

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const selectedIdx = (mask) => mask.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);

/** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
let doc;

afterAll(async () => {
  if (doc) await doc.terminate();
  await scribe.terminate();
}, 30000);

describe('per-page OCR selection on a text-native deck (TSLA investor deck)', () => {
  test('measures the deck as a text document with no full-page scans', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/TSLA-Q4-2020-Update.pdf`]);
    const stats = /** @type {import('../../js/pdf/ocrPageSelection.js').PageStats[]} */ (doc.inputData.pageStats);

    expect(doc.inputData.pageCount).toBe(PAGE_COUNT);
    expect(stats.length).toBe(PAGE_COUNT);
    expect(doc.inputData.pdfType).toBe('text');

    // A large-image slide: ~73% coverage is a baked-text candidate but below the full-page-scan band,
    // so it is not a scan.
    expect(stats[12].largestImageFrac).toBe(0.735);
    expect(mayHaveBakedText(stats[12])).toBe(true);
    expect(isFullPageImage(stats[12])).toBe(false);
    expect(isScanPage(stats[12])).toBe(false);

    // An embedded raster figure (idx 23, ~21% coverage): a `deep` baked-text trigger, but below the full-page-scan band.
    // The vector bar charts at idx 24/25 carry no raster image (frac 0) and their labels are native extractable text, so they are NOT baked-text candidates.
    expect(stats[23].largestImageFrac).toBe(0.2088);
    expect(mayHaveBakedText(stats[23])).toBe(true);
    expect(isScanPage(stats[23])).toBe(false);
    expect(stats[24].largestImageFrac).toBe(0);
    expect(mayHaveBakedText(stats[24])).toBe(false);
    expect(mayHaveBakedText(stats[25])).toBe(false);
    expect(isScanPage(stats[0])).toBe(false);
    // idx 32 carries image-borne text (line-shaped image strips), not a sizeable image.
    expect(stats[32].largestImageFrac).toBe(0.0082);
    expect(mayHaveBakedText(stats[32])).toBe(true);
    expect(isScanPage(stats[32])).toBe(false);
    expect(isEmpty(stats[33])).toBe(true);

    // Document-level recommendation flag (autoDeep would still OCR baked-text pages).
    expect(doc.inputData.requiresOCR).toBe(true);
  }, 60000);

  test('autoShallow selects nothing; autoDeep takes the large-image slides and the image-text page', async () => {
    const stats = /** @type {import('../../js/pdf/ocrPageSelection.js').PageStats[]} */ (doc.inputData.pageStats);
    const { pdfType } = doc.inputData;

    // autoShallow: a text-native deck is left entirely alone.
    expect(selectedIdx(selectOcrPages(stats, pdfType, 'autoShallow'))).toEqual([]);

    // autoDeep: the large-image slides and the embedded raster figure (plausible baked-in text), plus the image-borne-text page.
    expect(selectedIdx(selectOcrPages(stats, pdfType, 'autoDeep')))
      .toEqual([...range(IMAGE_SLIDE_START, IMAGE_SLIDE_END), IMAGE_FIGURE_PAGE, IMAGE_TEXT_PAGE]);

    // all / none bounds.
    expect(selectOcrPages(stats, pdfType, 'all').filter(Boolean).length).toBe(PAGE_COUNT);
    expect(selectOcrPages(stats, pdfType, 'none').filter(Boolean).length).toBe(0);
  }, 30000);
});

// `autoShallow`'s narrow category for a text-native document. Each fixture's PageStats are modeled on real corpus pages, and its `name` says which scenario.
describe('autoShallow narrow scan/unreadable category', () => {
  /**
   * A PageStats with the given fields over all-zero defaults.
   * @param {Partial<import('../../js/pdf/ocrPageSelection.js').PageStats>} o
   * @returns {import('../../js/pdf/ocrPageSelection.js').PageStats}
   */
  const mkStats = (o) => ({
    largestImageFrac: 0,
    invisibleTextChars: 0,
    visibleChars: 0,
    visibleReadableChars: 0,
    bodyReadableChars: 0,
    printableVis: 0,
    control: 0,
    controlVis: 0,
    pathTextCandidates: 0,
    imageTextCandidates: 0,
    longestBrokenRun: 0,
    pageSize: [612, 792],
    ...o,
  });

  const cases = [
    { name: 'full-bleed scan (header only)', s: mkStats({ largestImageFrac: 1.0, visibleReadableChars: 105 }), shallow: true },
    { name: 'full-bleed scan (header + caption)', s: mkStats({ largestImageFrac: 1.0, visibleReadableChars: 221 }), shallow: true },
    // A multi-line ECF/Bates header pushes the total over the old 250 floor, but it is all header band, so the body count still flags the scan.
    { name: 'full-bleed scan, header above the old 250 total', s: mkStats({ largestImageFrac: 1.0, visibleReadableChars: 300 }), shallow: true },
    { name: 'inset scan below 0.95 (accepted miss)', s: mkStats({ largestImageFrac: 0.78, visibleReadableChars: 150 }), shallow: false },
    { name: 'native photo slide', s: mkStats({ largestImageFrac: 0.735, visibleReadableChars: 27 }), shallow: false },
    { name: 'text page with a figure', s: mkStats({ largestImageFrac: 0.45, visibleReadableChars: 900, bodyReadableChars: 820 }), shallow: false },
    { name: 'significant broken ToUnicode', s: mkStats({ visibleChars: 1400, visibleReadableChars: 58, longestBrokenRun: 1500 }), shallow: true },
    { name: 'incidental broken glyphs', s: mkStats({ visibleReadableChars: 66, longestBrokenRun: 5 }), shallow: false },
    { name: 'clean native text', s: mkStats({ visibleReadableChars: 1500, bodyReadableChars: 1400 }), shallow: false },
  ];
  const stats = cases.map((c) => c.s);

  test('selects exactly the full-page scans and significant broken-text pages', () => {
    expect(selectOcrPages(stats, 'text', 'autoShallow')).toEqual(cases.map((c) => c.shallow));
  });

  test('a full-page scan with a trusted existing OCR layer is not re-OCR\'d', () => {
    const s = mkStats({ largestImageFrac: 1.0, visibleReadableChars: 90, invisibleTextChars: 800 });
    const trust = { native: { supp: true, main: true }, ocr: { supp: true, main: true } };
    const distrust = { native: { supp: true, main: true }, ocr: { supp: true, main: false } };
    expect(selectOcrPages([s], 'text', 'autoShallow', trust)[0]).toBe(false);
    expect(selectOcrPages([s], 'text', 'autoShallow', distrust)[0]).toBe(true);
  });

  test('autoShallow is a strict subset of autoDeep', () => {
    const shallow = selectOcrPages(stats, 'text', 'autoShallow');
    const deep = selectOcrPages(stats, 'text', 'autoDeep');
    shallow.forEach((v, i) => {
      if (v) expect(deep[i]).toBe(true);
    });
  });
});

// A real document run end-to-end through openDocument, exercising selectOcrPages on actual parser output.
const TEXT_PAGES = range(0, 7);
const SCAN_PAGES = range(8, 11);
const BROKEN_PAGES = range(12, 15);

/** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
let mixedDoc;

afterAll(async () => {
  if (mixedDoc) await mixedDoc.terminate();
}, 30000);

describe('page-category signals on a mixed text / scan / broken-encoding document', () => {
  test('per-page stats separate body text, full-page scans, and broken encoding', async () => {
    mixedDoc = await scribe.openDocument([`${ASSETS_PATH}/gov.uscourts.cand.431002.77.1_p76-83+86-89+148-151.pdf`]);
    const stats = /** @type {import('../../js/pdf/ocrPageSelection.js').PageStats[]} */ (mixedDoc.inputData.pageStats);

    expect(mixedDoc.inputData.pageCount).toBe(16);
    expect(mixedDoc.inputData.pdfType).toBe('text');

    // Text-native page: real body text, no image.
    expect(stats[0].largestImageFrac).toBe(0);
    expect(stats[0].bodyReadableChars).toBe(917);
    expect(hasRealText(stats[0])).toBe(true);
    expect(isScanOrUnreadable(stats[0])).toBe(false);

    // Full-page scan: a 100%-coverage image whose only readable text is a header (the body band is empty).
    expect(stats[8].largestImageFrac).toBe(1);
    expect(stats[8].visibleReadableChars).toBe(57);
    expect(stats[8].bodyReadableChars).toBe(0);
    expect(isFullPageImage(stats[8])).toBe(true);
    expect(isScanOrUnreadable(stats[8])).toBe(true);

    // Broken-ToUnicode page: plenty of visible glyphs, but a long broken run and no readable body text.
    expect(stats[12].longestBrokenRun).toBe(1603);
    expect(stats[12].bodyReadableChars).toBe(0);
    expect(hasBrokenFontRun(stats[12])).toBe(true);
    expect(isScanOrUnreadable(stats[12])).toBe(true);
  }, 60000);

  test('autoShallow OCRs the scans and broken pages and leaves the text-native pages alone', () => {
    const stats = /** @type {import('../../js/pdf/ocrPageSelection.js').PageStats[]} */ (mixedDoc.inputData.pageStats);
    const { pdfType } = mixedDoc.inputData;

    const shallow = selectOcrPages(stats, pdfType, 'autoShallow');
    const deep = selectOcrPages(stats, pdfType, 'autoDeep');
    expect(selectedIdx(shallow)).toEqual([...SCAN_PAGES, ...BROKEN_PAGES]);
    // No image-bearing page below the scan band here, so autoDeep adds nothing over autoShallow.
    expect(selectedIdx(deep)).toEqual([...SCAN_PAGES, ...BROKEN_PAGES]);

    for (const i of TEXT_PAGES) expect(shallow[i]).toBe(false);
    shallow.forEach((v, i) => {
      if (v) expect(deep[i]).toBe(true);
    });
  }, 30000);
});
