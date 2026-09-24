import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH } from './_paths.js';

const texts = (span) => span.lines.map((l) => l.words.map((w) => w.text).join(' '));
const box = (span) => Object.fromEntries(Object.entries(span.bbox).map(([k, v]) => [k, Math.round(v)]));
const pageNums = (doc) => doc.ocr.active.map((pg) => [...new Set(pg.lines.map((l) => l.pageNum).filter((x) => x != null))]);
const wordsWithLineNum = (doc) => doc.ocr.active.reduce((a, pg) => a + pg.lines.reduce((b, l) => b + l.words.filter((w) => 'lineNum' in w).length, 0), 0);

// The fixture is a court filing whose pages 0 to 7 are a hearing transcript printed 36 to 43.
// Its pages 8 to 11 are scans and its pages 12 to 15 text in an unreadable font, none of them numbered paper.
describe('one-up native transcript', () => {
  /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
  let doc;
  beforeAll(async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/gov.uscourts.cand.431002.77.1_p76-83+86-89+148-151.pdf`]);
    if (doc._textReadySettle) await doc.textReady;
  });
  afterAll(async () => { await scribe.terminate(); });

  test('every numbered row carries its number and every line its printed page', () => {
    const page = doc.ocr.active[0];
    const nums = page.lines.filter((l) => l.lineNum != null).map((l) => l.lineNum);
    expect(page.lines.length, 'line count of the first page').toBe(53);
    expect(nums.length, 'the number lines and the body lines of 25 rows carry a line number').toBe(50);
    expect(new Set(nums).size, 'the rows count 1 to 25').toBe(25);
    expect(Math.min(...nums), 'the count begins at 1').toBe(1);
    expect(Math.max(...nums), 'the count ends at 25').toBe(25);
    expect(page.lines.filter((l) => l.lineNum == null).map((l) => l.words.map((w) => w.text).join(' ')), 'only the footer, the folio and the filing stamp are outside the rows')
      .toEqual(['UNITED STATES COURT REPORTERS', '36', 'Case 3:24-cr-00329-CRB Document 77-1 Filed 09/06/24 Page 77 of 155']);
    expect(page.lines.every((l) => l.pageNum === '36'), 'every line of the page carries its printed page number, not the filing stamp\'s').toBe(true);
    expect(pageNums(doc), 'the transcript pages are printed 36 to 43, and the scans and unreadable pages carry nothing')
      .toEqual([['36'], ['37'], ['38'], ['39'], ['40'], ['41'], ['42'], ['43'], [], [], [], [], [], [], [], []]);
  });

  test('a single citation resolves to the row on its printed page', () => {
    const spans = doc.resolveCitation('36:1');
    expect(spans.length, 'one span for a citation on one page').toBe(1);
    expect(spans[0].page, 'printed page 36 is the first physical page').toBe(0);
    expect(spans[0].pageNum, 'the span names the printed page').toBe('36');
    expect([spans[0].first, spans[0].last], 'the span covers row 1 alone').toEqual([1, 1]);
    expect(texts(spans[0]), 'the row is its number line and its text line').toEqual(['1', 'WILL ACCEPT SO SHE CAN BE RELEASED, AND THEN SIT DOWN AND MAKE']);
    expect(box(spans[0]), 'the box is the union of the row\'s lines').toEqual({
      left: 300, top: 239, right: 2183, bottom: 279,
    });
    expect(spans[0].missing, 'no cited row is missing').toEqual([]);
    const blank = doc.resolveCitation('43:25');
    expect([blank[0].page, texts(blank[0])], 'a blank last row is its number alone').toEqual([7, ['25']]);
  });

  test('a range and a whole page resolve to their rows', () => {
    const range = doc.resolveCitation('40:10-12');
    expect(range.length, 'one span for a range on one page').toBe(1);
    expect([range[0].page, range[0].first, range[0].last, range[0].lines.length], 'rows 10 to 12 of page 40, six lines').toEqual([4, 10, 12, 6]);
    expect(texts(range[0]), 'the three numbers and the three rows\' text').toEqual(['10', '11', '12', 'MY BIRTHDAY THAT DAY, SO --', 'THE COURT: YOUR BIRTHDAY?', 'MR. FOSTER: YES.']);
    const whole = doc.resolveCitation('36');
    expect([whole[0].page, whole[0].first, whole[0].last, whole[0].lines.length], 'a bare page number names its 25 rows').toEqual([0, 1, 25, 50]);
  });

  test('a page or line the document lacks resolves to nothing', () => {
    expect(doc.resolveCitation('44:1'), 'printed page 44 is not in the document').toEqual([]);
    expect(doc.resolveCitation('36:26'), 'page 36 has no row 26').toEqual([]);
    expect(doc.resolveCitation('not a citation'), 'text that is not a citation').toEqual([]);
    expect(doc.resolveCitation('¶ 3'), 'a transcript has no numbered paragraphs').toEqual([]);
  });

  test('the fields survive a .scribe round trip, and an older file gets them on restore', async () => {
    scribe.ScribeDoc.defaults.compressScribe = false;
    const scribeData = await doc.exportData('scribe');
    scribe.ScribeDoc.defaults.compressScribe = true;
    await scribe.terminate();
    doc = await scribe.openDocument({ scribeFiles: [new TextEncoder().encode(scribeData).buffer] });
    const restored = doc.resolveCitation('43:25');
    expect([restored[0].page, restored[0].first, restored[0].last], 'the citation resolves to the same row after the round trip').toEqual([7, 25, 25]);
    expect(texts(restored[0]), 'the row\'s line survives the round trip').toEqual(['25']);
    expect(doc.ocr.active[0].lines.filter((l) => l.lineNum != null).length, 'every numbered line keeps its number').toBe(50);
    expect(wordsWithLineNum(doc), 'no word carries the retired line-number flag').toBe(0);

    // Emulates a file saved before the line fields existed, whose words carried a boolean `lineNum`.
    const older = scribeData.replace(/"lineNum":(null|\d+),"pageNum":(null|"[^"]*"),/g, '').replace(/"text":"THE",/g, '"text":"THE","lineNum":false,');
    expect((older.match(/"lineNum":false/g) || []).length, 'the emulated older file carries stale word flags').toBe(78);
    await scribe.terminate();
    doc = await scribe.openDocument({ scribeFiles: [new TextEncoder().encode(older).buffer] });
    const older36 = doc.resolveCitation('36:1');
    expect([older36[0].page, older36[0].first, older36[0].lines.length], 'the fields are computed on restore of an older file').toEqual([0, 1, 2]);
    expect(wordsWithLineNum(doc), 'the stale word flag is dropped on restore').toBe(0);
  });
});

describe('four-up native transcript', () => {
  /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
  let doc;
  beforeAll(async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/M.D.Fla._8_25-cv-03557-MSS-AEP_1_4_p5-8.pdf`]);
    if (doc._textReadySettle) await doc.textReady;
  });
  afterAll(async () => { await scribe.terminate(); });

  test('each sheet carries its four printed pages', () => {
    expect(pageNums(doc).map((nums) => nums.sort((a, b) => a - b)), 'the four sheets hold printed pages 10 to 25')
      .toEqual([['10', '11', '12', '13'], ['14', '15', '16', '17'], ['18', '19', '20', '21'], ['22', '23', '24', '25']]);
  });

  // The PDF parser joins a long left-hand row of this sheet to the row beside it, so many right-hand rows have no line of their own.
  // Only rows that stand alone are asserted here.
  test('a citation resolves to the right quadrant', () => {
    const right = doc.resolveCitation('25:25');
    expect([right[0].page, right[0].pageNum, texts(right[0])], 'row 25 of page 25, the lower right quadrant of the last sheet').toEqual([3, '25', ['25 but it also calls for a legal conclusion.']]);
    expect(box(right[0]), 'the box lies in the right half of the sheet').toEqual({
      left: 1403, top: 3011, right: 2110, bottom: 3053,
    });
    const left = doc.resolveCitation('10:1');
    expect([left[0].page, texts(left[0])], 'row 1 of page 10, the upper left quadrant').toEqual([0, ['1', 'roof redone.']]);
    const range = doc.resolveCitation('19:14-16');
    expect([range[0].page, texts(range[0])], 'rows 14 to 16 of page 19, the lower left quadrant of the third sheet')
      .toEqual([2, ['14', 'fascia incident or issue?', '15', 'A No.', '16', 'Q Was that handled by Mr. Welsh?']]);
    expect(doc.resolveCitation('26:1'), 'page 26 is not in the document').toEqual([]);
  });
});

// The fixture is a court filing with no readable text of its own: a cover page, an index page and three trial transcript pages printed 62 to 64.
describe('scanned transcript with an imported Textract layer', () => {
  /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
  let doc;
  afterAll(async () => { await scribe.terminate(); });

  test('the Textract layer resolves citations without a recognition run', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/D.Md._8_25-cr-00006-LKG_402_2.pdf`, `${ASSETS_PATH}/D.Md._8_25-cr-00006-LKG_402_2-AwsTextractLayoutSync.json`]);
    if (doc._textReadySettle) await doc.textReady;
    expect(pageNums(doc), 'the transcript pages are printed 62 to 64, not the "Page 3 of 5" of the filing stamp, and the cover and index carry nothing').toEqual([[], [], ['62'], ['63'], ['64']]);
    expect(doc.ocr.active.map((pg) => pg.lines.filter((l) => l.lineNum != null).length), 'numbered lines per page').toEqual([0, 0, 50, 50, 50]);
    const first = doc.resolveCitation('62:1');
    expect([first[0].page, texts(first[0])], 'row 1 of page 62').toEqual([2, ['1', 'So, if Mr. Goldstein was playing poker at the end of 2016,']]);
    expect(box(first[0]), 'the box of row 1').toEqual({
      left: 225, top: 253, right: 2242, bottom: 298,
    });
    const last = doc.resolveCitation('64:25');
    expect([last[0].page, texts(last[0])], 'row 25 of page 64').toEqual([4, ['personal money.', '25']]);
    expect(doc.resolveCitation('65:1'), 'page 65 is not in the document').toEqual([]);
  });

  // A turned page stores its lines sideways in their own frame, so the span's box must be mapped back to the page.
  test('a page turned sideways keeps its rows and resolves to where they are drawn', async () => {
    doc.rotatePages([3], 90);
    const out = /** @type {ArrayBuffer} */ (await doc.exportData('pdf', { displayMode: 'invis', addOverlay: true }));
    scribe.ScribeDoc.defaults.usePDFText.ocr.main = true;
    const reDoc = await scribe.openDocument({ pdfFiles: [out] });
    scribe.ScribeDoc.defaults.usePDFText.ocr.main = false;
    await reDoc.textReady;
    expect(reDoc.ocr.active.map((pg) => pg.lines[0].orientation), 'the turned page imports sideways, its neighbors upright').toEqual([0, 0, 0, 1, 0]);
    expect(pageNums(reDoc), 'every page keeps its printed page number when one page is turned').toEqual([[], [], ['62'], ['63'], ['64']]);
    const row = reDoc.resolveCitation('63:25');
    expect([row[0].page, row[0].first, row[0].last, texts(row[0])], 'row 25 of the turned page').toEqual([3, 25, 25, ['25', 'you’re going to hear from these people at different points in']]);
    expect(box(row[0]), 'the box lies where the row is drawn on the turned page').toEqual({
      left: 353, top: 191, right: 424, bottom: 2194,
    });
  });
});
