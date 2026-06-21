import {
  describe, test, expect, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import {
  selectOcrPages, isFullPageImage, isScanPage, mayHaveBakedText, isEmpty,
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
