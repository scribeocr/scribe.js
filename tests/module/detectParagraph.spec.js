import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

// Using arrow functions breaks references to `this`.

describe('Check paragraph detection with academic article.', () => {
  beforeAll(async () => {
    await scribe.importFiles([`${ASSETS_PATH}/academic_article_1.pdf`]);
    scribe.data.ocr.active.forEach((page, index) => {
      const angle = scribe.data.pageMetrics[index].angle || 0;
      scribe.utils.assignParagraphs(page, angle);
    });
  });

  test('Paragraph detection functions with single-column layout with header and footnotes', async () => {
    // The test document contains a header, 3 body paragraphs, and 3 footnotes.
    expect(scribe.data.ocr.active[0].pars.length).toBe(7);
    expect(scribe.utils.ocr.getParText(scribe.data.ocr.active[0].pars[0])).toBe('WHISTLEBLOWERS AND ENFORCEMENT ACTIONS 125');
    expect(scribe.utils.ocr.getParText(scribe.data.ocr.active[0].pars[6])).toBe('3 The respondent is the party (either a firm or an individual) targeted by the SEC/DOJ.');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check paragraph detection with complaint.', () => {
  beforeAll(async () => {
    await scribe.importFiles([`${ASSETS_PATH}/complaint_1.pdf`]);
    scribe.data.ocr.active.forEach((page, index) => {
      const angle = scribe.data.pageMetrics[index].angle || 0;
      scribe.utils.assignParagraphs(page, angle);
    });
  });

  test('Paragraph detection functions with single-column layout with header and footnotes', async () => {
    // The test document contains a header, 3 body paragraphs, and 3 footnotes.
    expect(scribe.data.ocr.active[0].pars.length).toBe(7);
    expect(scribe.utils.ocr.getLineText(scribe.data.ocr.active[0].pars[2].lines[3])).toBe('partially offset by lower sales volumes of ($0.1 billion).” They further represented:');
    expect(scribe.utils.ocr.getLineText(scribe.data.ocr.active[0].pars[3].lines[0])).toBe('Nutrition operating profit increased 20%. Human Nutrition results were higher');
  });

  test('Paragraph detection creates new paragraph when switching to center alignment', async () => {
    expect(scribe.utils.ocr.getParText(scribe.data.ocr.active[1].pars[2])).toBe('APPLICABILITY OF PRESUMPTION OF RELIANCE: FRAUD-ON-THE-MARKET DOCTRINE');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check paragraph detection with document with significant line sepacing.', () => {
  beforeAll(async () => {
    await scribe.importFiles([`${ASSETS_PATH}/complaint_2.hocr`]);
    scribe.data.ocr.active.forEach((page, index) => {
      const angle = scribe.data.pageMetrics[index].angle || 0;
      scribe.utils.assignParagraphs(page, angle);
    });
  });

  test('Paragraph detection creates the correct number of paragraphs', async () => {
    // The test document contains a header, 3 body paragraphs, and 3 footnotes.
    expect(scribe.data.ocr.active[0].pars.length).toBe(5);
    const par2 = scribe.data.ocr.active[0].pars[2];
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
    scribe.opt.extractText = true;
    await scribe.importFiles([`${ASSETS_PATH}/October2020CBX_Questions.pdf`]);
    // Page 13 (0-indexed as 12) contains 8 numbered items
    const page = scribe.data.ocr.active[12];
    const angle = scribe.data.pageMetrics[12].angle || 0;
    scribe.utils.assignParagraphs(page, angle);
  });

  test('Each numbered list item should be a separate paragraph', async () => {
    const page = scribe.data.ocr.active[12];
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
    scribe.opt.extractText = true;
    await scribe.importFiles([`${ASSETS_PATH}/070823vanliere.pdf`]);
    // Page 9 (0-indexed as 8) contains 3 footnotes starting with superscript numbers
    const page = scribe.data.ocr.active[8];
    const angle = scribe.data.pageMetrics[8].angle || 0;
    scribe.utils.assignParagraphs(page, angle);
  });

  test('Each footnote starting with superscript should be a separate paragraph', async () => {
    const page = scribe.data.ocr.active[8];

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

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check paragraph detection with hanging-indent CV entries.', () => {
  beforeAll(async () => {
    scribe.opt.extractText = true;
    await scribe.importFiles([`${ASSETS_PATH}/070823vanliere.pdf`]);
    const page = scribe.data.ocr.active[31];
    const angle = scribe.data.pageMetrics[31].angle || 0;
    scribe.utils.assignParagraphs(page, angle);
  });

  test('CV entry whose company name wraps to a second line is kept in one paragraph', async () => {
    const page = scribe.data.ocr.active[31];
    const matches = page.pars.filter((p) => scribe.utils.ocr.getParText(p).startsWith('Primen'));
    expect(matches.length).toBe(1);
    // eslint-disable-next-line max-len
    expect(scribe.utils.ocr.getParText(matches[0])).toBe('Primen (a joint venture of the Electric Power Research Institute and the Gas Research Institute) 2000-2002 President and Chief Executive Officer');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
