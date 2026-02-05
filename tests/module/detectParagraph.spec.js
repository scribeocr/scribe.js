// Relative imports are required to run in browser.
/* eslint-disable import/no-relative-packages */

// import { after, it } from 'mocha';
import { assert, config } from '../../node_modules/chai/chai.js';
// import path from 'path';
import scribe from '../../scribe.js';
import { ASSETS_PATH_KARMA } from '../constants.js';

config.truncateThreshold = 0; // Disable truncation for actual/expected values on assertion failure.

// Using arrow functions breaks references to `this`.
/* eslint-disable prefer-arrow-callback */
/* eslint-disable func-names */

describe('Check paragraph detection with academic article.', function () {
  this.timeout(20000);
  before(async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/academic_article_1.pdf`]);
    scribe.data.ocr.active.forEach((page, index) => {
      const angle = scribe.data.pageMetrics[index].angle || 0;
      scribe.utils.assignParagraphs(page, angle);
    });
  });

  it('Paragraph detection functions with single-column layout with header and footnotes', async () => {
    // The test document contains a header, 3 body paragraphs, and 3 footnotes.
    assert.strictEqual(scribe.data.ocr.active[0].pars.length, 7);
    assert.strictEqual(scribe.utils.ocr.getParText(scribe.data.ocr.active[0].pars[0]), 'WHISTLEBLOWERS AND ENFORCEMENT ACTIONS 125');
    assert.strictEqual(scribe.utils.ocr.getParText(scribe.data.ocr.active[0].pars[6]), '3 The respondent is the party (either a firm or an individual) targeted by the SEC/DOJ.');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
});

describe('Check paragraph detection with complaint.', function () {
  this.timeout(20000);
  before(async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/complaint_1.pdf`]);
    scribe.data.ocr.active.forEach((page, index) => {
      const angle = scribe.data.pageMetrics[index].angle || 0;
      scribe.utils.assignParagraphs(page, angle);
    });
  });

  it('Paragraph detection functions with single-column layout with header and footnotes', async () => {
    // The test document contains a header, 3 body paragraphs, and 3 footnotes.
    assert.strictEqual(scribe.data.ocr.active[0].pars.length, 7);
    assert.strictEqual(scribe.utils.ocr.getLineText(scribe.data.ocr.active[0].pars[2].lines[3]), 'partially offset by lower sales volumes of ($0.1 billion).” They further represented:');
    assert.strictEqual(scribe.utils.ocr.getLineText(scribe.data.ocr.active[0].pars[3].lines[0]), 'Nutrition operating profit increased 20%. Human Nutrition results were higher');
  }).timeout(10000);

  it('Paragraph detection creates new paragraph when switching to center alignment', async () => {
    assert.strictEqual(scribe.utils.ocr.getParText(scribe.data.ocr.active[1].pars[2]), 'APPLICABILITY OF PRESUMPTION OF RELIANCE: FRAUD-ON-THE-MARKET DOCTRINE');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
});

describe('Check paragraph detection with document with significant line sepacing.', function () {
  this.timeout(20000);
  before(async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/complaint_2.hocr`]);
    scribe.data.ocr.active.forEach((page, index) => {
      const angle = scribe.data.pageMetrics[index].angle || 0;
      scribe.utils.assignParagraphs(page, angle);
    });
  });

  it('Paragraph detection creates the correct number of paragraphs', async () => {
    // The test document contains a header, 3 body paragraphs, and 3 footnotes.
    assert.strictEqual(scribe.data.ocr.active[0].pars.length, 5);
    const par2 = scribe.data.ocr.active[0].pars[2];
    const firstWord = par2.lines[0].words[0];
    const lastWord = par2.lines[4].words[par2.lines[4].words.length - 1];
    assert.strictEqual(firstWord.text, '8.');
    assert.strictEqual(lastWord.text, 'Defendant.');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
});

describe('Check paragraph detection with numbered list.', function () {
  this.timeout(20000);
  before(async () => {
    scribe.opt.extractText = true;
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/October2020CBX_Questions.pdf`]);
    // Page 13 (0-indexed as 12) contains 8 numbered items
    const page = scribe.data.ocr.active[12];
    const angle = scribe.data.pageMetrics[12].angle || 0;
    scribe.utils.assignParagraphs(page, angle);
  });

  it('Each numbered list item should be a separate paragraph', async () => {
    const page = scribe.data.ocr.active[12];
    // Page should have 9 paragraphs: 1 title + 8 numbered items
    assert.strictEqual(page.pars.length, 9, 'Should have 9 paragraphs (1 title + 8 list items)');

    // First paragraph is the title
    assert.strictEqual(scribe.utils.ocr.getParText(page.pars[0]), 'PERFORMANCE TEST INSTRUCTIONS');

    // Each numbered item should start its own paragraph
    assert.strictEqual(page.pars[1].lines[0].words[0].text, '1.');
    assert.strictEqual(page.pars[2].lines[0].words[0].text, '2.');
    assert.strictEqual(page.pars[3].lines[0].words[0].text, '3.');
    assert.strictEqual(page.pars[4].lines[0].words[0].text, '4.');
    assert.strictEqual(page.pars[5].lines[0].words[0].text, '5.');
    assert.strictEqual(page.pars[6].lines[0].words[0].text, '6.');
    assert.strictEqual(page.pars[7].lines[0].words[0].text, '7.');
    assert.strictEqual(page.pars[8].lines[0].words[0].text, '8.');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
});

describe('Check paragraph detection with footnotes.', function () {
  this.timeout(20000);
  before(async () => {
    scribe.opt.extractText = true;
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/070823vanliere.pdf`]);
    // Page 9 (0-indexed as 8) contains 3 footnotes starting with superscript numbers
    const page = scribe.data.ocr.active[8];
    const angle = scribe.data.pageMetrics[8].angle || 0;
    scribe.utils.assignParagraphs(page, angle);
  });

  it('Each footnote starting with superscript should be a separate paragraph', async () => {
    const page = scribe.data.ocr.active[8];

    // Find the footnote paragraphs (last 3 paragraphs should be footnotes 7, 8, 9)
    const footnoteParCount = page.pars.filter((par) => {
      const firstWord = par.lines[0].words[0];
      return firstWord.style && firstWord.style.sup;
    }).length;

    // Should have 3 separate footnote paragraphs
    assert.strictEqual(footnoteParCount, 3, 'Should have 3 separate footnote paragraphs');

    // Verify each footnote starts with the correct superscript number
    const footnotePars = page.pars.slice(-3);
    assert.strictEqual(footnotePars[0].lines[0].words[0].text, '7');
    assert.strictEqual(footnotePars[1].lines[0].words[0].text, '8');
    assert.strictEqual(footnotePars[2].lines[0].words[0].text, '9');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
});
