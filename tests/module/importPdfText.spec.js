// Relative imports are required to run in browser.
/* eslint-disable import/no-relative-packages */
import { assert, config } from '../../node_modules/chai/chai.js';
// import mocha from '../../node_modules/mocha/mocha.js';
import scribe from '../../scribe.js';
import { ASSETS_PATH_KARMA } from '../constants.js';

scribe.opt.workerN = 1;

config.truncateThreshold = 0; // Disable truncation for actual/expected values on assertion failure.

// Using arrow functions breaks references to `this`.
/* eslint-disable prefer-arrow-callback */
/* eslint-disable func-names */

// This file contains many seemingly duplicative tests.
// In all cases, there are slight differences in the PDFs being imported, such that one test may fail while another passes.

describe('Check stylistic ligatures are normalized in PDF text extraction.', function () {
  this.timeout(20000);
  before(async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/academic_article_1.pdf`]);
  });

  it('Word with the fi ligature is extracted with separate f and i', async () => {
    assert.strictEqual(scribe.data.ocr.active[0].lines[46].words[8].text, 'firm');
    assert.strictEqual(scribe.data.ocr.active[0].lines[13].words[3].text, 'firms;');
    assert.strictEqual(scribe.data.ocr.active[0].lines[17].words[3].text, 'firm’s');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check stext import function language support.', function () {
  this.timeout(10000);
  before(async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/chi_eng_mixed_sample.pdf`]);
  });

  it('Should import Chinese characters', async () => {
    const text1 = scribe.data.ocr.active[0].lines[2].words.map((x) => x.text).join(' ');

    assert.strictEqual(text1, '嚴 重 特 殊 傳 染 性 肺 炎 指 定 處 所 隔 離 通 知 書 及 提 審 權 利 告 知');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check small caps are detected in PDF imports.', function () {
  this.timeout(10000);
  before(async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/small_caps_examples.pdf`]);
  });

  it('Should correctly import small caps printed using font size adjustments', async () => {
    const text1 = scribe.data.ocr.active[0].lines[3].words.map((x) => x.text).join(' ');

    const text2 = scribe.data.ocr.active[0].lines[22].words.map((x) => x.text).join(' ');

    assert.strictEqual(text1, 'Shubhdeep Deb');

    assert.strictEqual(text2, 'Wage inequality in the United States has risen sharply since the 1980s. The skill');
  }).timeout(10000);

  it('Should correctly import small caps printed using small caps font.', async () => {
    assert.strictEqual(scribe.data.ocr.active[1].lines[4].words[0].style.smallCaps, true);

    assert.strictEqual(scribe.data.ocr.active[1].lines[4].words.map((x) => x.text).join(' '), 'Abstract');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check superscripts are detected in PDF imports.', function () {
  this.timeout(10000);
  before(async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/superscript_examples.pdf`]);
  });

  // First document
  it('Should correctly import trailing superscripts printed using font size adjustments (1st doc)', async () => {
    assert.strictEqual(scribe.data.ocr.active[0].lines[25].words[8].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[0].lines[25].words[8].text, '1');
  }).timeout(10000);

  it('Should correctly import leading superscripts printed using font size adjustments (1st doc)', async () => {
    assert.strictEqual(scribe.data.ocr.active[0].lines[43].words[0].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[0].lines[43].words[0].text, '1');
  }).timeout(10000);

  it('Should correctly calculate line angle for lines that start or end with superscripts (1st doc)', async () => {
    // Line that ends with superscript.
    assert.strictEqual(scribe.data.ocr.active[0].lines[28].baseline[0], 0);
    // Line that starts with superscript.
    assert.strictEqual(scribe.data.ocr.active[0].lines[43].baseline[0], 0);
  }).timeout(10000);

  // Second document
  it('Should correctly import trailing superscripts printed using font size adjustments (2nd doc)', async () => {
    assert.strictEqual(scribe.data.ocr.active[1].lines[1].words[2].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[1].lines[1].words[2].text, '1');
  }).timeout(10000);

  it('Should correctly import leading superscripts printed using font size adjustments (2nd doc)', async () => {
    assert.strictEqual(scribe.data.ocr.active[1].lines[36].words[0].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[1].lines[36].words[0].text, '1');
  }).timeout(10000);

  it('Should correctly calculate line angle for lines that start with superscripts (2nd doc)', async () => {
    // Line that starts with superscript.
    assert.strictEqual(scribe.data.ocr.active[1].lines[36].baseline[0], 0);
  }).timeout(10000);

  // Third document
  it('Should correctly import leading superscripts printed using font size adjustments (3rd doc)', async () => {
    assert.strictEqual(scribe.data.ocr.active[2].lines[22].words[4].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[2].lines[22].words[4].text, '2');
  }).timeout(10000);

  it('Should correctly parse font size for lines with superscripts (3rd doc)', async () => {
    // The body line "lic and private enforcers' incentives and information sets,"
    // sits one line below a line with a trailing superscript "2" — verify the
    // superscript on the previous line did not poison size detection here.
    assert.strictEqual(scribe.data.ocr.active[2].lines[24].words.map((w) => w.text).join(' '),
      'lic and private enforcers’ incentives and information sets,');
    const words = scribe.data.ocr.active[2].lines[24].words;
    assert.isTrue(words.map((word) => word.style.size && Math.round(word.style.size) === 33).reduce((acc, val) => acc && val));
  }).timeout(10000);

  // Forth document
  it('Should correctly import trailing superscripts printed using font size adjustments (4th doc)', async () => {
    // Line "corporate round 20" — the trailing "20" is a footnote superscript.
    assert.strictEqual(scribe.data.ocr.active[3].lines[109].words.map((w) => w.text).join(' '), 'corporate round 20');
    assert.strictEqual(scribe.data.ocr.active[3].lines[109].words[2].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[3].lines[109].words[2].text, '20');
  }).timeout(10000);

  it('Should correctly parse font size for lines with superscripts (4th doc)', async () => {
    // Footnote line that mixes body text and inline superscript markers
    // ("Accel. 20 Including American Express. 21 Purchased 55%…"). The "20"
    // here marks the start of a new footnote and must be detected as a
    // superscript even though it sits mid-line, not at line end.
    assert.strictEqual(scribe.data.ocr.active[3].lines[231].words.map((w) => w.text).join(' '),
      'Accel. 20 Including American Express. 21 Purchased 55% interest from Fiserv. 22 Including');
    assert.strictEqual(scribe.data.ocr.active[3].lines[231].words[1].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[3].lines[231].words[1].text, '20');
  }).timeout(10000);

  // Fifth document
  it('Should correctly import trailing superscripts printed using font size adjustments (5th doc)', async () => {
    assert.strictEqual(scribe.data.ocr.active[4].lines[11].words[16].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[4].lines[11].words[16].text, '2');
    assert.strictEqual(scribe.data.ocr.active[4].lines[11].words[16].style.size, 33.5);
  }).timeout(10000);

  it('Should correctly parse font size for lines with superscripts (5th doc)', async () => {
    assert.strictEqual(scribe.data.ocr.active[4].lines[21].words[0].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[4].lines[21].words[0].text, '2');
    assert.strictEqual(scribe.data.ocr.active[4].lines[21].words[0].style.size, 27);
  }).timeout(10000);

  // Sixth document
  it('Should correctly import trailing superscripts printed using font size adjustments (6th doc)', async () => {
    // Table cell "Other a" — the trailing "a" is a footnote-marker superscript.
    assert.strictEqual(scribe.data.ocr.active[5].lines[61].words.map((w) => w.text).join(' '), 'Other a');
    assert.strictEqual(scribe.data.ocr.active[5].lines[61].words[1].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[5].lines[61].words[1].text, 'a');
  }).timeout(10000);

  it('Should correctly parse font size for lines with superscripts (6th doc)', async () => {
    // Footnote text starts with the leading-superscript marker "a"
    // ("a Includes burglary, larceny, motor vehicle theft, …"). The "a" must
    // be detected as a superscript even though it leads the line.
    assert.strictEqual(scribe.data.ocr.active[5].lines[158].words.map((w) => w.text).join(' ').slice(0, 70),
      'a Includes burglary, larceny, motor vehicle theft, arson, transportati');
    assert.strictEqual(scribe.data.ocr.active[5].lines[158].words[0].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[5].lines[158].words[0].text, 'a');
  }).timeout(10000);

  // This document breaks when used with `mutool convert` so is not combined with the others.
  // Any more tests included in the main stacked document should be inserted above this point.
  it('Should correctly parse font size for lines with superscripts (addtl doc)', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/superscript_example_report1.pdf`]);

    // Footnote (1): "(1) Effective July 1, 2023, prior period segment information…"
    assert.strictEqual(scribe.data.ocr.active[0].lines[86].words.map((w) => w.text).join(' ').slice(0, 80),
      '(1) Effective July 1, 2023, prior period segment information for the Corporate F');
    assert.strictEqual(scribe.data.ocr.active[0].lines[86].words[0].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[0].lines[86].words[0].text, '(1)');

    // Footnote (3): "(3) See "FTI Consulting, Inc. Non-GAAP Financial Measures"…"
    assert.strictEqual(scribe.data.ocr.active[0].lines[93].words.map((w) => w.text).join(' ').slice(0, 80),
      '(3) See “FTI Consulting, Inc. Non-GAAP Financial Measures” for the definition of');
    assert.strictEqual(scribe.data.ocr.active[0].lines[93].words[0].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[0].lines[93].words[0].text, '(3)');
  }).timeout(10000);

  it('Should correctly parse font size for lines with superscripts (addtl doc 2)', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/superscript_example_report2.pdf`]);

    assert.strictEqual(scribe.data.ocr.active[0].lines[32].words[4].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[0].lines[32].words[4].text, '(1)');

    assert.strictEqual(scribe.data.ocr.active[0].lines[35].words[4].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[0].lines[35].words[4].text, '(1)');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check font size is correctly parsed in PDF imports.', function () {
  this.timeout(10000);
  it('Should correctly parse font sizes (1st doc)', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/border_patrol_tables.pdf`]);
    // This word was problematic at one point due to the change in font size between the first and second word.
    // Anchor on the line text so a future re-merge that shifts this footnote line still trips the test loudly.
    assert.strictEqual(scribe.data.ocr.active[0].lines[218].words.map((w) => w.text).join(' '),
      '* Agent staffing statistics depict FY19 on-board personnel data as of 09/30/2019');
    assert.strictEqual(scribe.data.ocr.active[0].lines[218].words[1].style.size, 32.5);
    assert.strictEqual(scribe.data.ocr.active[0].lines[218].words[1].text, 'Agent');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check handling of PDFs with broken encoding dictionaries.', function () {
  this.timeout(10000);
  it('PDF with invalid encoding dictionary is detected and text is not imported', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/Iris (plant) - Wikipedia_AdobePDF123.pdf`]);

    assert.strictEqual(scribe.inputData.pdfType, 'image');
    assert.strictEqual(scribe.data.ocr.active.length, 0);
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check that PDF imports split lines correctly.', function () {
  this.timeout(10000);
  it('Should correctly parse PDF lines (1st doc)', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/border_patrol_tables.pdf`]);

    // A previous version of the build 5 words across 3 distinct lines (including this one) are combined into a single line.
    assert.strictEqual(scribe.data.ocr.active[0].lines[3].words.length, 1);
    assert.strictEqual(scribe.data.ocr.active[0].lines[3].words[0].text, 'Apprehensions');
  }).timeout(10000);

  it('Should correctly parse PDF lines (2nd doc)', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/superscript_examples.pdf`]);

    // A previous version of the build split this line into 9 separate lines.
    assert.strictEqual(scribe.data.ocr.active[2].lines[58].words.map((x) => x.text).join(' '),
      'ment’s (DOE’s) issuance of Accounting and Auditing Enforcement Releases');

    // The source PDF has a mid-word space in "Anyfin" but it should still be parsed
    // as a single word; HEAD's parser split it into 2 words and the test tolerated that.
    assert.strictEqual(scribe.data.ocr.active[3].lines[105].words.length, 1);
    assert.strictEqual(scribe.data.ocr.active[3].lines[105].words[0].text, 'Anyfin');
  }).timeout(10000);

  it('Should correctly parse PDF lines (3rd doc)', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/superscript_example_report1.pdf`]);

    // A previous version of the build split this line into 2 separate lines, by putting the leading superscript on a separate line.
    assert.strictEqual(scribe.data.ocr.active[0].lines[89].words.map((x) => x.text).join(' '),
      '(2) Beginning with the year ended December 31, 2023, the Company changed the presentation of interest income on forgivable loans on our Consolidated Statement of');
    assert.strictEqual(scribe.data.ocr.active[0].lines[89].words[0].style.sup, true);
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check that PDF imports split words correctly.', function () {
  this.timeout(10000);

  it('Should correctly split words not separated by space or any character defined in may_add_space', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/fti_filing_p25.pdf`]);

    assert.strictEqual(scribe.data.ocr.active[0].lines[4].words[0].text, '☒');
    assert.strictEqual(scribe.data.ocr.active[0].lines[4].words[1].text, 'ANNUAL');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check that line baselines are imported correctly.', function () {
  this.timeout(10000);

  it('Should correctly parse line baselines for pages with rotation', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/superscript_examples_rotated.pdf`]);
    assert.strictEqual(Math.round(scribe.data.ocr.active[0].lines[25].baseline[1]), -10);
    assert.strictEqual(Math.round(scribe.data.ocr.active[1].lines[25].baseline[1]), -162);
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check that page angle is calculated correctly.', function () {
  this.timeout(10000);

  it('Average text angle is correctly calculated', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/superscript_examples_rotated.pdf`]);
    assert.strictEqual(Math.round(scribe.data.pageMetrics[0].angle || 0), -5);
    assert.strictEqual(Math.round(scribe.data.pageMetrics[1].angle || 0), 5);
  }).timeout(10000);

  it('Different orientations should not impact page angle.', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/CSF_Proposed_Budget_Book_June_2024_r8_30_all_orientations.pdf`]);
    assert.strictEqual(scribe.data.pageMetrics[0].angle, 0);
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check that text orientation is handled correctly.', function () {
  this.timeout(10000);

  it('Lines printed at exactly 90/180/270 degrees have orientation detected correctly', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/CSF_Proposed_Budget_Book_June_2024_r8_30_all_orientations.pdf`]);
    assert.strictEqual(scribe.data.ocr.active[0].lines[2].words[0].line.orientation, 3);
    assert.strictEqual(scribe.data.ocr.active[3].lines[2].words[0].line.orientation, 2);
    assert.strictEqual(scribe.data.ocr.active[2].lines[2].words[0].line.orientation, 1);
  }).timeout(10000);

  // The following tests compare the coordinates of a rotated line to the same line in a non-rotated version of the same document.
  it('Lines oriented at 90 degrees counterclockwise have coordinates calculated correctly', async () => {
    assert.approximately(scribe.data.ocr.active[0].lines[2].words[0].bbox.left, scribe.data.ocr.active[1].lines[2].words[0].bbox.left, 1);
    assert.approximately(scribe.data.ocr.active[0].lines[2].words[0].bbox.right, scribe.data.ocr.active[1].lines[2].words[0].bbox.right, 1);
    assert.approximately(scribe.data.ocr.active[0].lines[2].words[0].bbox.top, scribe.data.ocr.active[1].lines[2].words[0].bbox.top, 1);
    assert.approximately(scribe.data.ocr.active[0].lines[2].words[0].bbox.bottom, scribe.data.ocr.active[1].lines[2].words[0].bbox.bottom, 1);
  }).timeout(10000);

  it('Lines oriented at 90 degrees clockwise have coordinates calculated correctly', async () => {
    assert.approximately(scribe.data.ocr.active[2].lines[2].words[0].bbox.left, scribe.data.ocr.active[1].lines[2].words[0].bbox.left, 1);
    assert.approximately(scribe.data.ocr.active[2].lines[2].words[0].bbox.right, scribe.data.ocr.active[1].lines[2].words[0].bbox.right, 1);
    assert.approximately(scribe.data.ocr.active[2].lines[2].words[0].bbox.top, scribe.data.ocr.active[1].lines[2].words[0].bbox.top, 1);
    assert.approximately(scribe.data.ocr.active[2].lines[2].words[0].bbox.bottom, scribe.data.ocr.active[1].lines[2].words[0].bbox.bottom, 1);
  }).timeout(10000);

  it('Lines oriented at 180 degrees have coordinates calculated correctly', async () => {
    assert.approximately(scribe.data.ocr.active[3].lines[2].words[0].bbox.left, scribe.data.ocr.active[1].lines[2].words[0].bbox.left, 1);
    assert.approximately(scribe.data.ocr.active[3].lines[2].words[0].bbox.right, scribe.data.ocr.active[1].lines[2].words[0].bbox.right, 1);
    assert.approximately(scribe.data.ocr.active[3].lines[2].words[0].bbox.top, scribe.data.ocr.active[1].lines[2].words[0].bbox.top, 1);
    assert.approximately(scribe.data.ocr.active[3].lines[2].words[0].bbox.bottom, scribe.data.ocr.active[1].lines[2].words[0].bbox.bottom, 1);
  }).timeout(10000);

  it('Lines oriented at 90/180/270 degrees have line rotation detected correctly', async () => {
    assert.approximately(scribe.data.ocr.active[4].lines[0].baseline[0], Math.tan(5 * (Math.PI / 180)), 0.01);
    assert.approximately(scribe.data.ocr.active[6].lines[0].baseline[0], Math.tan(5 * (Math.PI / 180)), 0.01);
    assert.approximately(scribe.data.ocr.active[8].lines[0].baseline[0], Math.tan(5 * (Math.PI / 180)), 0.01);
    assert.approximately(scribe.data.ocr.active[10].lines[0].baseline[0], Math.tan(5 * (Math.PI / 180)), 0.01);
    assert.approximately(scribe.data.ocr.active[5].lines[0].baseline[0], -Math.tan(5 * (Math.PI / 180)), 0.01);
    assert.approximately(scribe.data.ocr.active[7].lines[0].baseline[0], -Math.tan(5 * (Math.PI / 180)), 0.01);
    assert.approximately(scribe.data.ocr.active[9].lines[0].baseline[0], -Math.tan(5 * (Math.PI / 180)), 0.01);
    assert.approximately(scribe.data.ocr.active[11].lines[0].baseline[0], -Math.tan(5 * (Math.PI / 180)), 0.01);

    assert.approximately(scribe.data.ocr.active[4].lines[2].baseline[0], Math.tan(5 * (Math.PI / 180)), 0.01);
    assert.approximately(scribe.data.ocr.active[6].lines[2].baseline[0], Math.tan(5 * (Math.PI / 180)), 0.01);
    assert.approximately(scribe.data.ocr.active[8].lines[2].baseline[0], Math.tan(5 * (Math.PI / 180)), 0.01);
    assert.approximately(scribe.data.ocr.active[10].lines[2].baseline[0], Math.tan(5 * (Math.PI / 180)), 0.01);
    assert.approximately(scribe.data.ocr.active[5].lines[2].baseline[0], -Math.tan(5 * (Math.PI / 180)), 0.01);
    assert.approximately(scribe.data.ocr.active[7].lines[2].baseline[0], -Math.tan(5 * (Math.PI / 180)), 0.01);
    assert.approximately(scribe.data.ocr.active[9].lines[2].baseline[0], -Math.tan(5 * (Math.PI / 180)), 0.01);
    assert.approximately(scribe.data.ocr.active[11].lines[2].baseline[0], -Math.tan(5 * (Math.PI / 180)), 0.01);
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check that PDF text types are detected and imported correctly.', function () {
  this.timeout(10000);

  it('Native text is detected and set as main data `usePDFText.native.main` is true', async () => {
    scribe.opt.usePDFText.native.main = true;
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/superscript_examples_rotated.pdf`]);
    scribe.opt.usePDFText.native.main = false;
    assert.strictEqual(scribe.inputData.pdfType, 'text');
    assert.isTrue(scribe.data.ocr.active[0]?.lines?.length > 0);
  }).timeout(10000);

  it('Native text is detected and not set as main data `usePDFText.native.main` is false', async () => {
    scribe.opt.usePDFText.native.main = false;
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/superscript_examples_rotated.pdf`]);
    assert.strictEqual(scribe.inputData.pdfType, 'text');
    assert.isFalse(!!scribe.data.ocr.active[0]);
  }).timeout(10000);

  it('OCR text is detected and set as main data `usePDFText.ocr.main` is true', async () => {
    scribe.opt.usePDFText.ocr.main = true;
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/scribe_test_pdf1.pdf`]);
    scribe.opt.usePDFText.native.main = false;
    assert.strictEqual(scribe.inputData.pdfType, 'ocr');
    assert.isTrue(scribe.data.ocr.active[0]?.lines?.length > 0);
  }).timeout(10000);

  it('OCR text is detected and extracted but not set to main data when `usePDFText.ocr.main` is false', async () => {
    scribe.opt.usePDFText.ocr.main = false;
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/scribe_test_pdf1.pdf`]);
    // Reset to defaults
    scribe.opt.usePDFText.native.main = true;
    scribe.opt.usePDFText.ocr.main = false;
    assert.strictEqual(scribe.inputData.pdfType, 'ocr');
    assert.isTrue(scribe.data.ocr.pdf[0]?.lines?.length > 0);
    assert.isUndefined(scribe.data.ocr.active[0]);
  }).timeout(10000);

  // If angle is set it would not be replaced by the accurate angle
  // when higher quality OCR text is imported or created.
  it('Page angle is not set from invisible OCR text when usePDFText.ocr.main is false', async () => {
    assert.strictEqual(scribe.data.pageMetrics[0].angle, null);
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check that font style is detected for PDF imports.', function () {
  this.timeout(10000);

  it('Bold style is detected', async () => {
    scribe.opt.usePDFText.native.main = true;
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/superscript_examples.pdf`]);
    // lines[26] is the "TABLE 6" header — bold, non-italic, non-underlined.
    assert.strictEqual(scribe.data.ocr.active[5].lines[26].words.map((w) => w.text).join(' '), 'TABLE 6');
    assert.isTrue(scribe.data.ocr.active[5].lines[26].words[0].style.bold);
    assert.isFalse(scribe.data.ocr.active[5].lines[26].words[0].style.italic);
    assert.isFalse(scribe.data.ocr.active[5].lines[26].words[0].style.underline);
  }).timeout(10000);

  it('Italic style is detected', async () => {
    assert.isTrue(scribe.data.ocr.active[5].lines[22].words[4].style.italic);
    assert.isFalse(scribe.data.ocr.active[5].lines[22].words[4].style.bold);
    assert.isFalse(scribe.data.ocr.active[5].lines[22].words[4].style.underline);
  }).timeout(10000);

  it('Italic style is detected when leading punctuation is non-italic', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/high-risk_protection_order_application_for_and_declaration_in_support_of_mandatory_use.pdf`]);
    // Line: "Applicant ( Print your name above ),"
    // The non-italic "(" is now split into its own word, and the inner italicized
    // body words ("Print", "your", "name", "above") are italic. The non-italic
    // wrappers — "Applicant", "(", and ")," — must remain italic=false.
    assert.strictEqual(scribe.data.ocr.active[0].lines[15].words.map((w) => w.text).join(' '),
      'Applicant ( Print your name above ),');
    assert.strictEqual(scribe.data.ocr.active[0].lines[15].words[2].text, 'Print');
    assert.isTrue(scribe.data.ocr.active[0].lines[15].words[2].style.italic);
    assert.isFalse(scribe.data.ocr.active[0].lines[15].words[1].style.italic, 'leading "(" must not inherit italic from its neighbor');
  }).timeout(10000);

  it('Bold + italic style is detected', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/complaint_1.pdf`]);
    assert.strictEqual(scribe.data.ocr.active[0].lines[1].words[0].text, 'impressive');
    assert.isTrue(scribe.data.ocr.active[0].lines[1].words[0].style.italic);
    assert.isTrue(scribe.data.ocr.active[0].lines[1].words[0].style.bold);
    assert.isFalse(scribe.data.ocr.active[0].lines[1].words[0].style.underline);
  }).timeout(10000);

  it('Bold + underlined style is detected', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.pdf`]);
    assert.strictEqual(scribe.data.ocr.active[0].lines[22].words[0].text, 'COMPLAINT');
    assert.isFalse(scribe.data.ocr.active[0].lines[22].words[0].style.italic);
    assert.isTrue(scribe.data.ocr.active[0].lines[22].words[0].style.bold);
    assert.isTrue(scribe.data.ocr.active[0].lines[22].words[0].style.underline);
  }).timeout(10000);

  it('Bold + underlined section heading is detected (NATURE OF THE ACTION)', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.pdf`]);
    const line = scribe.data.ocr.active[0].lines[26];
    assert.strictEqual(line.words.map((w) => w.text).join(' '), 'NATURE OF THE ACTION');
    for (const w of line.words) {
      assert.isTrue(w.style.bold, `"${w.text}" should be bold`);
      assert.isTrue(w.style.underline, `"${w.text}" should be underlined`);
    }
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check that symbols are detected for PDF imports.', function () {
  this.timeout(10000);

  it('Symbols are not combined with words', async () => {
    scribe.opt.usePDFText.native.main = true;
    // An earlier version combined the checkbox with the first word.
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/high-risk_protection_order_application_for_and_declaration_in_support_of_mandatory_use.pdf`]);
    assert.strictEqual(scribe.data.ocr.active[0].lines[9].words.length, 4);
    assert.strictEqual(scribe.data.ocr.active[0].lines[9].words[1].text, 'Attorney,');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check that `keepPDFTextAlways` option works.', function () {
  this.timeout(10000);

  it('Text-native headers are imported for image-based PDF document.', async () => {
    scribe.opt.keepPDFTextAlways = true;
    // This PDF is an image-based court document but has a text-native header added by the court system.
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/gov.uscourts.cand.249697.1.0_2.pdf`]);
    assert.strictEqual(scribe.inputData.pdfType, 'image');
    assert.strictEqual(!!scribe.data.ocr.active[0]?.lines?.length, false);
    assert.strictEqual(scribe.data.ocr.pdf[0].lines.length, 1);
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);
