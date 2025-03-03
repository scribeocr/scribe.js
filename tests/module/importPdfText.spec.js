// Relative imports are required to run in browser.
/* eslint-disable import/no-relative-packages */
import { assert, config } from '../../node_modules/chai/chai.js';
// import mocha from '../../node_modules/mocha/mocha.js';
import scribe from '../../scribe.js';
import { ASSETS_PATH_KARMA } from '../constants.js';

config.truncateThreshold = 0; // Disable truncation for actual/expected values on assertion failure.

// Using arrow functions breaks references to `this`.
/* eslint-disable prefer-arrow-callback */
/* eslint-disable func-names */

// This file contains many seemingly duplicative tests.
// In all cases, there are slight differences in the PDFs being imported, such that one test may fail while another passes.

describe('Check stext import function language support.', function () {
  this.timeout(15000);
  before(async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/chi_eng_mixed_sample.pdf`]);
  });

  it('Should import Chinese characters', async () => {
    const text1 = scribe.data.ocr.active[0].lines[2].words.map((x) => x.text).join(' ');

    assert.strictEqual(text1, '嚴 重 特 殊 傳 染 性 肺 炎 指 定 處 所 隔 離 通 知 書 及 提 審 權 利 告 知');
  }).timeout(15000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check small caps are detected in PDF imports.', function () {
  this.timeout(15000);
  before(async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/small_caps_examples.pdf`]);
  });

  it('Should correctly import small caps printed using font size adjustments', async () => {
    const text1 = scribe.data.ocr.active[0].lines[3].words.map((x) => x.text).join(' ');

    const text2 = scribe.data.ocr.active[0].lines[22].words.map((x) => x.text).join(' ');

    assert.strictEqual(text1, 'Shubhdeep Deb');

    assert.strictEqual(text2, 'Wage inequality in the United States has risen sharply since the 1980s. The skill');
  }).timeout(15000);

  it('Should correctly import small caps printed using small caps font.', async () => {
    assert.strictEqual(scribe.data.ocr.active[1].lines[4].words[0].style.smallCaps, true);

    assert.strictEqual(scribe.data.ocr.active[1].lines[4].words.map((x) => x.text).join(' '), 'Abstract');
  }).timeout(15000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check superscripts are detected in PDF imports.', function () {
  this.timeout(15000);
  before(async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/superscript_examples.pdf`]);
  });

  // First document
  it('Should correctly import trailing superscripts printed using font size adjustments (1st doc)', async () => {
    assert.strictEqual(scribe.data.ocr.active[0].lines[25].words[8].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[0].lines[25].words[8].text, '1');
  }).timeout(15000);

  it('Should correctly import leading superscripts printed using font size adjustments (1st doc)', async () => {
    assert.strictEqual(scribe.data.ocr.active[0].lines[43].words[0].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[0].lines[43].words[0].text, '1');
  }).timeout(15000);

  it('Should correctly calculate line angle for lines that start or end with superscripts (1st doc)', async () => {
    // Line that ends with superscript.
    assert.strictEqual(scribe.data.ocr.active[0].lines[28].baseline[0], 0);
    // Line that starts with superscript.
    assert.strictEqual(scribe.data.ocr.active[0].lines[43].baseline[0], 0);
  }).timeout(15000);

  // Second document
  it('Should correctly import trailing superscripts printed using font size adjustments (2nd doc)', async () => {
    assert.strictEqual(scribe.data.ocr.active[1].lines[1].words[2].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[1].lines[1].words[2].text, '1');
  }).timeout(15000);

  it('Should correctly import leading superscripts printed using font size adjustments (2nd doc)', async () => {
    assert.strictEqual(scribe.data.ocr.active[1].lines[36].words[0].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[1].lines[36].words[0].text, '1');
  }).timeout(15000);

  it('Should correctly calculate line angle for lines that start with superscripts (2nd doc)', async () => {
    // Line that starts with superscript.
    assert.strictEqual(scribe.data.ocr.active[1].lines[36].baseline[0], 0);
  }).timeout(15000);

  // Third document
  it('Should correctly import leading superscripts printed using font size adjustments (3rd doc)', async () => {
    assert.strictEqual(scribe.data.ocr.active[2].lines[22].words[4].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[2].lines[22].words[4].text, '2');
  }).timeout(15000);

  it('Should correctly parse font size for lines with superscripts (3rd doc)', async () => {
    const words = scribe.data.ocr.active[2].lines[24].words;
    assert.isTrue(words.map((word) => word.style.size && Math.round(word.style.size) === 33).reduce((acc, val) => acc && val));
  }).timeout(15000);

  // Forth document
  it('Should correctly import trailing superscripts printed using font size adjustments (4th doc)', async () => {
    assert.strictEqual(scribe.data.ocr.active[3].lines[113].words[2].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[3].lines[113].words[2].text, '20');
  }).timeout(15000);

  it('Should correctly parse font size for lines with superscripts (4th doc)', async () => {
    assert.strictEqual(scribe.data.ocr.active[3].lines[248].words[1].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[3].lines[248].words[1].text, '20');
  }).timeout(15000);

  // Fifth document
  it('Should correctly import trailing superscripts printed using font size adjustments (5th doc)', async () => {
    assert.strictEqual(scribe.data.ocr.active[4].lines[11].words[16].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[4].lines[11].words[16].text, '2');
    assert.strictEqual(scribe.data.ocr.active[4].lines[11].words[16].style.size, 33.5);
  }).timeout(15000);

  it('Should correctly parse font size for lines with superscripts (5th doc)', async () => {
    assert.strictEqual(scribe.data.ocr.active[4].lines[21].words[0].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[4].lines[21].words[0].text, '2');
    assert.strictEqual(scribe.data.ocr.active[4].lines[21].words[0].style.size, 27);
  }).timeout(15000);

  // Sixth document
  it('Should correctly import trailing superscripts printed using font size adjustments (6th doc)', async () => {
    assert.strictEqual(scribe.data.ocr.active[5].lines[76].words[1].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[5].lines[76].words[1].text, 'a');
  }).timeout(15000);

  it('Should correctly parse font size for lines with superscripts (6th doc)', async () => {
    assert.strictEqual(scribe.data.ocr.active[5].lines[205].words[0].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[5].lines[205].words[0].text, 'a');
  }).timeout(15000);

  // This document breaks when used with `mutool convert` so is not combined with the others.
  // Any more tests included in the main stacked document should be inserted above this point.
  it('Should correctly parse font size for lines with superscripts (addtl doc)', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/superscript_example_report1.pdf`]);

    assert.strictEqual(scribe.data.ocr.active[0].lines[96].words[0].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[0].lines[96].words[0].text, '(1)');

    assert.strictEqual(scribe.data.ocr.active[0].lines[103].words[0].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[0].lines[103].words[0].text, '(3)');
  }).timeout(15000);

  it('Should correctly parse font size for lines with superscripts (addtl doc 2)', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/superscript_example_report2.pdf`]);

    assert.strictEqual(scribe.data.ocr.active[0].lines[32].words[4].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[0].lines[32].words[4].text, '(1)');

    assert.strictEqual(scribe.data.ocr.active[0].lines[35].words[4].style.sup, true);
    assert.strictEqual(scribe.data.ocr.active[0].lines[35].words[4].text, '(1)');
  }).timeout(15000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check font size is correctly parsed in PDF imports.', function () {
  this.timeout(15000);
  // Note: the version which uses `calcSuppFontInfo` corresponds to the scribeocr.com interface, which enables this option.
  it('Should correctly parse font sizes (1st doc)', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/border_patrol_tables.pdf`]);
    // This word was problematic at one point due to the change in font size between the first and second word.
    assert.strictEqual(scribe.data.ocr.active[0].lines[253].words[1].style.size, 32.5);
    assert.strictEqual(scribe.data.ocr.active[0].lines[253].words[1].text, 'Agent');
  }).timeout(15000);

  it('Should correctly parse font sizes and scale using calcSuppFontInfo option (1st doc)', async () => {
    scribe.opt.calcSuppFontInfo = true;
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/border_patrol_tables.pdf`]);
    scribe.opt.calcSuppFontInfo = false;
    assert.strictEqual(scribe.data.ocr.active[0].lines[253].words[1].style.size, 39);
    assert.strictEqual(scribe.data.ocr.active[0].lines[253].words[1].text, 'Agent');
  }).timeout(15000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check that text-native PDFs with broken encoding dictionaries are detected and skipped.', function () {
  this.timeout(15000);
  // Note: the version which uses `calcSuppFontInfo` corresponds to the scribeocr.com interface, which enables this option.
  it('Should correctly parse font sizes (1st doc)', async () => {
    // Set `calcSuppFontInfo` to `true` as this option previously crashed the program with this type of PDFs.
    scribe.opt.calcSuppFontInfo = true;
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/coca-cola-business-and-sustainability-report-2022.pdf`]);
    scribe.opt.calcSuppFontInfo = false;

    assert.strictEqual(scribe.data.ocr.active.length, 0);
  }).timeout(15000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check that PDF imports split lines correctly.', function () {
  this.timeout(15000);
  // Note: the version which uses `calcSuppFontInfo` corresponds to the scribeocr.com interface, which enables this option.
  it('Should correctly parse PDF lines (1st doc)', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/border_patrol_tables.pdf`]);

    // A previous version of the build 5 words across 3 distinct lines (including this one) are combined into a single line.
    assert.strictEqual(scribe.data.ocr.active[0].lines[3].words.length, 1);
    assert.strictEqual(scribe.data.ocr.active[0].lines[3].words[0].text, 'Apprehensions');
  }).timeout(15000);

  it('Should correctly parse PDF lines (2nd doc)', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/superscript_examples.pdf`]);

    // A previous version of the build split this line into 9 separate lines.
    assert.strictEqual(scribe.data.ocr.active[2].lines[58].words.map((x) => x.text).join(' '), 'ment’s (DOE’s) issuance of Accounting and Auditing Enforcement Releases');

    // A previous version of the build split this line into 2 separate lines.
    // Sidenote: This seems like it should be only one word, however there appears to be a space in the middle within the source PDF.
    assert.strictEqual(scribe.data.ocr.active[3].lines[109].words.length, 2);
    assert.strictEqual(scribe.data.ocr.active[3].lines[109].words[0].text, 'Anyfi');
  }).timeout(15000);

  it('Should correctly parse PDF lines (3rd doc)', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/superscript_example_report1.pdf`]);

    // A previous version of the build split this line into 2 separate lines, by putting the leading superscript on a separate line.
    assert.strictEqual(scribe.data.ocr.active[0].lines[99].words.map((x) => x.text).join(' '),
      '(2) Beginning with the year ended December 31, 2023, the Company changed the presentation of interest income on forgivable loans on our Consolidated Statement of');
  }).timeout(15000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check that PDF imports split words correctly.', function () {
  this.timeout(15000);

  it('Should correctly split words not separated by space or any character defined in may_add_space', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/fti_filing_p25.pdf`]);

    assert.strictEqual(scribe.data.ocr.active[0].lines[4].words[0].text, '☒');
    assert.strictEqual(scribe.data.ocr.active[0].lines[4].words[1].text, 'ANNUAL');
  }).timeout(15000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check that line baselines are imported correctly.', function () {
  this.timeout(15000);

  it('Should correctly parse line baselines for pages with rotation', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/superscript_examples_rotated.pdf`]);
    assert.strictEqual(Math.round(scribe.data.ocr.active[0].lines[25].baseline[1]), -10);
    assert.strictEqual(Math.round(scribe.data.ocr.active[1].lines[25].baseline[1]), -164);
  }).timeout(15000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check that page angle is calculated correctly.', function () {
  this.timeout(15000);

  it('Average text angle is correctly calculated', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/superscript_examples_rotated.pdf`]);
    assert.strictEqual(Math.round(scribe.data.pageMetrics[0].angle || 0), -5);
    assert.strictEqual(Math.round(scribe.data.pageMetrics[1].angle || 0), 5);
  }).timeout(15000);

  it('Different orientations should not impact page angle.', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/CSF_Proposed_Budget_Book_June_2024_r8_30_all_orientations.pdf`]);
    assert.strictEqual(scribe.data.pageMetrics[0].angle, 0);
  }).timeout(15000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check that text orientation is handled correctly.', function () {
  this.timeout(15000);

  it('Lines printed at exactly 90/180/270 degrees have orientation detected correctly', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/CSF_Proposed_Budget_Book_June_2024_r8_30_all_orientations.pdf`]);
    assert.strictEqual(scribe.data.ocr.active[0].lines[2].words[0].line.orientation, 3);
    assert.strictEqual(scribe.data.ocr.active[3].lines[2].words[0].line.orientation, 2);
    assert.strictEqual(scribe.data.ocr.active[2].lines[2].words[0].line.orientation, 1);
  }).timeout(15000);

  // The following tests compare the coordinates of a rotated line to the same line in a non-rotated version of the same document.
  it('Lines oriented at 90 degrees counterclockwise have coordinates calculated correctly', async () => {
    assert.approximately(scribe.data.ocr.active[0].lines[2].words[0].bbox.left, scribe.data.ocr.active[1].lines[2].words[0].bbox.left, 1);
    assert.approximately(scribe.data.ocr.active[0].lines[2].words[0].bbox.right, scribe.data.ocr.active[1].lines[2].words[0].bbox.right, 1);
    assert.approximately(scribe.data.ocr.active[0].lines[2].words[0].bbox.top, scribe.data.ocr.active[1].lines[2].words[0].bbox.top, 1);
    assert.approximately(scribe.data.ocr.active[0].lines[2].words[0].bbox.bottom, scribe.data.ocr.active[1].lines[2].words[0].bbox.bottom, 1);
  }).timeout(15000);

  it('Lines oriented at 90 degrees clockwise have coordinates calculated correctly', async () => {
    assert.approximately(scribe.data.ocr.active[2].lines[2].words[0].bbox.left, scribe.data.ocr.active[1].lines[2].words[0].bbox.left, 1);
    assert.approximately(scribe.data.ocr.active[2].lines[2].words[0].bbox.right, scribe.data.ocr.active[1].lines[2].words[0].bbox.right, 1);
    assert.approximately(scribe.data.ocr.active[2].lines[2].words[0].bbox.top, scribe.data.ocr.active[1].lines[2].words[0].bbox.top, 1);
    assert.approximately(scribe.data.ocr.active[2].lines[2].words[0].bbox.bottom, scribe.data.ocr.active[1].lines[2].words[0].bbox.bottom, 1);
  }).timeout(15000);

  it('Lines oriented at 180 degrees have coordinates calculated correctly', async () => {
    assert.approximately(scribe.data.ocr.active[3].lines[2].words[0].bbox.left, scribe.data.ocr.active[1].lines[2].words[0].bbox.left, 1);
    assert.approximately(scribe.data.ocr.active[3].lines[2].words[0].bbox.right, scribe.data.ocr.active[1].lines[2].words[0].bbox.right, 1);
    assert.approximately(scribe.data.ocr.active[3].lines[2].words[0].bbox.top, scribe.data.ocr.active[1].lines[2].words[0].bbox.top, 1);
    assert.approximately(scribe.data.ocr.active[3].lines[2].words[0].bbox.bottom, scribe.data.ocr.active[1].lines[2].words[0].bbox.bottom, 1);
  }).timeout(15000);

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
  }).timeout(15000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check that PDF text types are detected and imported correctly.', function () {
  this.timeout(15000);

  it('Native text is detected and set as main data `usePDFText.native.main` is true', async () => {
    scribe.opt.usePDFText.native.main = true;
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/superscript_examples_rotated.pdf`]);
    scribe.opt.usePDFText.native.main = false;
    assert.strictEqual(scribe.inputData.pdfType, 'text');
    assert.isTrue(scribe.data.ocr.active[0]?.lines?.length > 0);
  }).timeout(15000);

  it('Native text is detected and not set as main data `usePDFText.native.main` is false', async () => {
    scribe.opt.usePDFText.native.main = false;
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/superscript_examples_rotated.pdf`]);
    assert.strictEqual(scribe.inputData.pdfType, 'text');
    assert.isFalse(!!scribe.data.ocr.active[0]);
  }).timeout(15000);

  it('OCR text is detected and set as main data `usePDFText.ocr.main` is true', async () => {
    scribe.opt.usePDFText.ocr.main = true;
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/scribe_test_pdf1.pdf`]);
    scribe.opt.usePDFText.native.main = false;
    assert.strictEqual(scribe.inputData.pdfType, 'ocr');
    assert.isTrue(scribe.data.ocr.active[0]?.lines?.length > 0);
  }).timeout(15000);

  it('OCR text is detected and set as main data `usePDFText.ocr.main` is false', async () => {
    scribe.opt.usePDFText.ocr.main = false;
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/scribe_test_pdf1.pdf`]);
    // Reset to defaults
    scribe.opt.usePDFText.native.main = true;
    scribe.opt.usePDFText.ocr.main = false;
    assert.strictEqual(scribe.inputData.pdfType, 'ocr');
    assert.isFalse(!!scribe.data.ocr.active[0]);
  }).timeout(15000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check that font style is detected for PDF imports.', function () {
  this.timeout(15000);

  it('Bold style is detected', async () => {
    scribe.opt.usePDFText.native.main = true;
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/superscript_examples.pdf`]);
    assert.isTrue(scribe.data.ocr.active[5].lines[26].words[0].style.bold);
    assert.isFalse(scribe.data.ocr.active[5].lines[26].words[0].style.italic);
    assert.isFalse(scribe.data.ocr.active[5].lines[26].words[0].style.underline);
  }).timeout(15000);

  it('Italic style is detected', async () => {
    assert.isTrue(scribe.data.ocr.active[5].lines[22].words[4].style.italic);
    assert.isFalse(scribe.data.ocr.active[5].lines[22].words[4].style.bold);
    assert.isFalse(scribe.data.ocr.active[5].lines[22].words[4].style.underline);
  }).timeout(15000);

  it('Bold + italic style is detected', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/complaint_1.pdf`]);
    assert.isTrue(scribe.data.ocr.active[0].lines[1].words[0].style.italic);
    assert.isTrue(scribe.data.ocr.active[0].lines[1].words[0].style.bold);
    assert.isFalse(scribe.data.ocr.active[0].lines[1].words[0].style.underline);
  }).timeout(15000);

  it('Bold + underlined style is detected', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.pdf`]);
    assert.isFalse(scribe.data.ocr.active[0].lines[22].words[0].style.italic);
    assert.isTrue(scribe.data.ocr.active[0].lines[22].words[0].style.bold);
    assert.isTrue(scribe.data.ocr.active[0].lines[22].words[0].style.underline);
  }).timeout(15000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);
