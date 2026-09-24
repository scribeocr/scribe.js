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

describe('Check paragraph detection with academic article.', () => {
  beforeAll(async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/academic_article_1.pdf`]);
    doc.ocr.active.forEach((page, index) => {
      const angle = doc.pageMetrics[index].angle || 0;
      scribe.utils.assignParagraphs(page, angle);
    });
  });

  test('Paragraph detection functions with single-column layout with header and footnotes', async () => {
    // The test document contains a header, 3 body paragraphs, and 3 footnotes.
    expect(doc.ocr.active[0].pars.length).toBe(7);
    expect(scribe.utils.ocr.getParText(doc.ocr.active[0].pars[0])).toBe('WHISTLEBLOWERS AND ENFORCEMENT ACTIONS 125');
    expect(scribe.utils.ocr.getParText(doc.ocr.active[0].pars[6])).toBe('3 The respondent is the party (either a firm or an individual) targeted by the SEC/DOJ.');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check paragraph detection with complaint.', () => {
  beforeAll(async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/complaint_1.pdf`]);
    doc.ocr.active.forEach((page, index) => {
      const angle = doc.pageMetrics[index].angle || 0;
      scribe.utils.assignParagraphs(page, angle);
    });
  });

  test('Paragraph detection functions with single-column layout with header and footnotes', async () => {
    // The test document contains a header, 3 body paragraphs, and 3 footnotes.
    expect(doc.ocr.active[0].pars.length).toBe(7);
    expect(scribe.utils.ocr.getLineText(doc.ocr.active[0].pars[2].lines[3])).toBe('partially offset by lower sales volumes of ($0.1 billion).” They further represented:');
    expect(scribe.utils.ocr.getLineText(doc.ocr.active[0].pars[3].lines[0])).toBe('Nutrition operating profit increased 20%. Human Nutrition results were higher');
  });

  test('Paragraph detection creates new paragraph when switching to center alignment', async () => {
    expect(scribe.utils.ocr.getParText(doc.ocr.active[1].pars[2])).toBe('APPLICABILITY OF PRESUMPTION OF RELIANCE: FRAUD-ON-THE-MARKET DOCTRINE');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check paragraph detection with document with significant line sepacing.', () => {
  beforeAll(async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/complaint_2.hocr`]);
    doc.ocr.active.forEach((page, index) => {
      const angle = doc.pageMetrics[index].angle || 0;
      scribe.utils.assignParagraphs(page, angle);
    });
  });

  test('Paragraph detection creates the correct number of paragraphs', async () => {
    // The test document contains a header, 3 body paragraphs, and 3 footnotes.
    expect(doc.ocr.active[0].pars.length).toBe(5);
    const par2 = doc.ocr.active[0].pars[2];
    const firstWord = par2.lines[0].words[0];
    const lastWord = par2.lines[4].words[par2.lines[4].words.length - 1];
    expect(firstWord.text).toBe('8.');
    expect(lastWord.text).toBe('Defendant.');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check paragraph detection with numbered list.', () => {
  beforeAll(async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/October2020CBX_Questions.pdf`]);
    // Page 13 (0-indexed as 12) contains 8 numbered items
    const page = doc.ocr.active[12];
    const angle = doc.pageMetrics[12].angle || 0;
    scribe.utils.assignParagraphs(page, angle);
  });

  test('Each numbered list item should be a separate paragraph', async () => {
    const page = doc.ocr.active[12];
    // Page should have 9 paragraphs: 1 title + 8 numbered items
    expect(page.pars.length).toBe(9);

    // First paragraph is the title
    expect(scribe.utils.ocr.getParText(page.pars[0])).toBe('PERFORMANCE TEST INSTRUCTIONS');

    // Each numbered item should start its own paragraph
    expect(page.pars[1].lines[0].words[0].text).toBe('1.');
    expect(page.pars[2].lines[0].words[0].text).toBe('2.');
    expect(page.pars[3].lines[0].words[0].text).toBe('3.');
    expect(page.pars[4].lines[0].words[0].text).toBe('4.');
    expect(page.pars[5].lines[0].words[0].text).toBe('5.');
    expect(page.pars[6].lines[0].words[0].text).toBe('6.');
    expect(page.pars[7].lines[0].words[0].text).toBe('7.');
    expect(page.pars[8].lines[0].words[0].text).toBe('8.');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check paragraph detection with footnotes.', () => {
  beforeAll(async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/070823vanliere.pdf`]);
    // Page 9 (0-indexed as 8) contains 3 footnotes starting with superscript numbers
    const page = doc.ocr.active[8];
    const angle = doc.pageMetrics[8].angle || 0;
    scribe.utils.assignParagraphs(page, angle);
  });

  test('Each footnote starting with superscript should be a separate paragraph', async () => {
    const page = doc.ocr.active[8];

    // Find the footnote paragraphs (last 3 paragraphs should be footnotes 7, 8, 9)
    const footnoteParCount = page.pars.filter((par) => {
      const firstWord = par.lines[0].words[0];
      return firstWord.style && firstWord.style.sup;
    }).length;

    // Should have 3 separate footnote paragraphs
    expect(footnoteParCount).toBe(3);

    // Verify each footnote starts with the correct superscript number
    const footnotePars = page.pars.slice(-3);
    expect(footnotePars[0].lines[0].words[0].text).toBe('7');
    expect(footnotePars[1].lines[0].words[0].text).toBe('8');
    expect(footnotePars[2].lines[0].words[0].text).toBe('9');
  });

  test('The printed page number is read into every line of its page at the document\'s convention', async () => {
    // The report numbers its pages 1-22 in the foot. The cover carries no number, and the appended CV restarts at 2, so 2-8 name two pages each and are not read.
    expect(doc.ocr.active[0].lines[0].pageNum, 'the unnumbered cover page gets no page number').toBe(null);
    expect(doc.ocr.active[2].lines[0].pageNum, 'the first numbered page reads its printed 1').toBe('1');
    expect(doc.ocr.active[10].lines[0].pageNum, 'a page inside the report reads its printed number').toBe('9');
    expect(doc.ocr.active[23].lines[0].pageNum, 'the last report page reads its printed 22').toBe('22');
    const folios = doc.ocr.active[10].lines.filter((line) => line.par && line.par.type === 'pagenum');
    expect(folios.map((line) => line.words[0].text), 'only the folio line is typed pagenum, the role export drops as furniture').toEqual(['9']);
  });

  // Page 8 is avoided, since the per-page detector above rebuilt its paragraphs.
  test('a paragraph citation resolves at the document\'s one numbering, through page breaks and lettered sub-items', () => {
    const opening = (span, i, n) => span.lines[i].words.slice(0, n).map((w) => w.text).join(' ');
    const key = (spans) => spans.map((s) => [s.page, s.paragraphs, s.lines.map((l) => l.id)]);
    const first = doc.resolveCitation('¶ 1');
    expect(first.map((s) => [s.page, s.pageNum, s.paragraphs, s.lines.length, s.first, s.last, s.missing]),
      '¶ 1 is the report\'s first paragraph on physical page 2, not the survey answer numbered 1 on page 20 or footnote 1').toEqual([[2, '1', [1], 5, null, null, []]]);
    expect(opening(first[0], 0, 8), 'the span opens on the paragraph\'s marker line').toBe('1. I am Kent D. Van Liere. I');
    const crossing = doc.resolveCitation('¶ 35');
    expect(crossing.map((s) => [s.page, s.paragraphs, s.lines.length]), '¶ 35 runs from the foot of page 19 onto page 20').toEqual([[19, [35], 4], [20, [35], 8]]);
    expect(opening(crossing[1], 0, 8), 'the page-20 lines are the continuation, past the footnote and the page number').toBe('her earlier conclusion that the items purchased by');
    const listed = doc.resolveCitation('¶ 15');
    expect(listed.map((s) => [s.page, s.paragraphs, s.lines.length]), '¶ 15 includes its lettered list on the next page').toEqual([[6, [15], 6], [7, [15], 13]]);
    expect([opening(listed[1], 0, 8), opening(listed[1], 12, 7)], 'the list runs a) to d) and takes the sentence after it, up to paragraph 16')
      .toEqual(['a) The response rate to her survey is', 'Each of these areas is discussed below.']);
    const range = doc.resolveCitation('¶¶ 34-36');
    expect(range.map((s) => [s.page, s.pageNum, s.paragraphs, s.lines.length, s.missing]), '¶¶ 34-36 spans two pages and ¶ 35 is listed on both')
      .toEqual([[19, '18', [34, 35], 22, []], [20, '19', [35, 36], 16, []]]);
    expect(opening(range[1], 13, 5), '¶ 36 takes the quoted survey answer after it and stops at the misread heading').toBe('1. ONLY AT WHOLE FOODS');
    const twelve = doc.resolveCitation('para. 12');
    expect(twelve.map((s) => [s.page, s.paragraphs]), 'para. 12 resolves to one page').toEqual([[5, [12]]]);
    expect(key(doc.resolveCitation('¶12')), '¶12 without a space is the same citation').toEqual(key(twelve));
    expect(key(doc.resolveCitation('paragraph 12')), 'the spelled-out form is the same citation').toEqual(key(twelve));
    expect(key(doc.resolveCitation('¶ 15(b)')), 'a sub-item citation resolves to its paragraph').toEqual(key(listed));
    expect(doc.resolveCitation('¶ 99'), 'a paragraph past the end resolves to nothing').toEqual([]);
    expect(doc.resolveCitation('¶¶ 34, 36'), 'a comma list is not a citation yet').toEqual([]);
    const tail = doc.resolveCitation('¶¶ 41-45');
    expect(tail.map((s) => [s.page, s.paragraphs, s.lines.length, s.missing]), 'the last paragraph stops before the closing sentences, and the numbers past the end are missing')
      .toEqual([[23, [41, 42], 9, [43, 44, 45]]]);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check paragraph detection with hanging-indent CV entries.', () => {
  beforeAll(async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/070823vanliere.pdf`]);
    const page = doc.ocr.active[31];
    const angle = doc.pageMetrics[31].angle || 0;
    scribe.utils.assignParagraphs(page, angle);
  });

  test('CV entry whose company name wraps to a second line is kept in one paragraph', async () => {
    const page = doc.ocr.active[31];
    const matches = page.pars.filter((p) => scribe.utils.ocr.getParText(p).startsWith('Primen'));
    expect(matches.length).toBe(1);
    // eslint-disable-next-line max-len
    expect(scribe.utils.ocr.getParText(matches[0])).toBe('Primen (a joint venture of the Electric Power Research Institute and the Gas Research Institute) 2000-2002 President and Chief Executive Officer');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
