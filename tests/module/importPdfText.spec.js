import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

// Using arrow functions breaks references to `this`.

// This file contains many seemingly duplicative tests.
// In all cases, there are slight differences in the PDFs being imported, such that one test may fail while another passes.

describe('Check stylistic ligatures are normalized in PDF text extraction.', () => {
  beforeAll(async () => {
    await scribe.importFiles([`${ASSETS_PATH}/academic_article_1.pdf`]);
  });

  test('Word with the fi ligature is extracted with separate f and i', async () => {
    expect(scribe.data.ocr.active[0].lines[46].words[8].text).toBe('firm');
    expect(scribe.data.ocr.active[0].lines[13].words[3].text).toBe('firms;');
    expect(scribe.data.ocr.active[0].lines[17].words[3].text).toBe('firm’s');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check stext import function language support.', () => {
  beforeAll(async () => {
    await scribe.importFiles([`${ASSETS_PATH}/chi_eng_mixed_sample.pdf`]);
  });

  test('Should import Chinese characters', async () => {
    const text1 = scribe.data.ocr.active[0].lines[2].words.map((x) => x.text).join(' ');

    expect(text1).toBe('嚴 重 特 殊 傳 染 性 肺 炎 指 定 處 所 隔 離 通 知 書 及 提 審 權 利 告 知');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check small caps are detected in PDF imports.', () => {
  beforeAll(async () => {
    await scribe.importFiles([`${ASSETS_PATH}/small_caps_examples.pdf`]);
  });

  test('Should correctly import small caps printed using font size adjustments', async () => {
    const text1 = scribe.data.ocr.active[0].lines[3].words.map((x) => x.text).join(' ');

    const text2 = scribe.data.ocr.active[0].lines[22].words.map((x) => x.text).join(' ');

    expect(text1).toBe('Shubhdeep Deb');

    expect(text2).toBe('Wage inequality in the United States has risen sharply since the 1980s. The skill');
  });

  test('Should correctly import small caps printed using small caps font.', async () => {
    expect(scribe.data.ocr.active[1].lines[4].words[0].style.smallCaps).toBe(true);

    expect(scribe.data.ocr.active[1].lines[4].words.map((x) => x.text).join(' ')).toBe('Abstract');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check superscripts are detected in PDF imports.', () => {
  beforeAll(async () => {
    await scribe.importFiles([`${ASSETS_PATH}/superscript_examples.pdf`]);
  });

  // First document
  test('Should correctly import trailing superscripts printed using font size adjustments (1st doc)', async () => {
    expect(scribe.data.ocr.active[0].lines[25].words[8].style.sup).toBe(true);
    expect(scribe.data.ocr.active[0].lines[25].words[8].text).toBe('1');
  });

  test('Should correctly import leading superscripts printed using font size adjustments (1st doc)', async () => {
    expect(scribe.data.ocr.active[0].lines[43].words[0].style.sup).toBe(true);
    expect(scribe.data.ocr.active[0].lines[43].words[0].text).toBe('1');
  });

  test('Should correctly calculate line angle for lines that start or end with superscripts (1st doc)', async () => {
    // Line that ends with superscript.
    expect(scribe.data.ocr.active[0].lines[28].baseline[0]).toBe(0);
    // Line that starts with superscript.
    expect(scribe.data.ocr.active[0].lines[43].baseline[0]).toBe(0);
  });

  // Second document
  test('Should correctly import trailing superscripts printed using font size adjustments (2nd doc)', async () => {
    expect(scribe.data.ocr.active[1].lines[1].words[2].style.sup).toBe(true);
    expect(scribe.data.ocr.active[1].lines[1].words[2].text).toBe('1');
  });

  test('Should correctly import leading superscripts printed using font size adjustments (2nd doc)', async () => {
    expect(scribe.data.ocr.active[1].lines[36].words[0].style.sup).toBe(true);
    expect(scribe.data.ocr.active[1].lines[36].words[0].text).toBe('1');
  });

  test('Should correctly calculate line angle for lines that start with superscripts (2nd doc)', async () => {
    // Line that starts with superscript.
    expect(scribe.data.ocr.active[1].lines[36].baseline[0]).toBe(0);
  });

  // Third document
  test('Should correctly import leading superscripts printed using font size adjustments (3rd doc)', async () => {
    expect(scribe.data.ocr.active[2].lines[22].words[4].style.sup).toBe(true);
    expect(scribe.data.ocr.active[2].lines[22].words[4].text).toBe('2');
  });

  test('Should correctly parse font size for lines with superscripts (3rd doc)', async () => {
    // The body line "lic and private enforcers' incentives and information sets,"
    // sits one line below a line with a trailing superscript "2" — verify the
    // superscript on the previous line did not poison size detection here.
    expect(scribe.data.ocr.active[2].lines[24].words.map((w) => w.text).join(' ')).toBe('lic and private enforcers’ incentives and information sets,');
    const words = scribe.data.ocr.active[2].lines[24].words;
    expect(words.map((word) => word.style.size && Math.round(word.style.size) === 33).reduce((acc, val) => acc && val)).toBe(true);
  });

  // Forth document
  test('Should correctly import trailing superscripts printed using font size adjustments (4th doc)', async () => {
    // Line "corporate round 20" — the trailing "20" is a footnote superscript.
    expect(scribe.data.ocr.active[3].lines[109].words.map((w) => w.text).join(' ')).toBe('corporate round 20');
    expect(scribe.data.ocr.active[3].lines[109].words[2].style.sup).toBe(true);
    expect(scribe.data.ocr.active[3].lines[109].words[2].text).toBe('20');
  });

  test('Should correctly parse font size for lines with superscripts (4th doc)', async () => {
    // Footnote line that mixes body text and inline superscript markers
    // ("Accel. 20 Including American Express. 21 Purchased 55%…"). The "20"
    // here marks the start of a new footnote and must be detected as a
    // superscript even though it sits mid-line, not at line end.
    expect(scribe.data.ocr.active[3].lines[231].words.map((w) => w.text).join(' ')).toBe('Accel. 20 Including American Express. 21 Purchased 55% interest from Fiserv. 22 Including');
    expect(scribe.data.ocr.active[3].lines[231].words[1].style.sup).toBe(true);
    expect(scribe.data.ocr.active[3].lines[231].words[1].text).toBe('20');
  });

  // Fifth document
  test('Should correctly import trailing superscripts printed using font size adjustments (5th doc)', async () => {
    expect(scribe.data.ocr.active[4].lines[11].words[16].style.sup).toBe(true);
    expect(scribe.data.ocr.active[4].lines[11].words[16].text).toBe('2');
    expect(scribe.data.ocr.active[4].lines[11].words[16].style.size).toBe(33.5);
  });

  test('Should correctly parse font size for lines with superscripts (5th doc)', async () => {
    expect(scribe.data.ocr.active[4].lines[21].words[0].style.sup).toBe(true);
    expect(scribe.data.ocr.active[4].lines[21].words[0].text).toBe('2');
    expect(scribe.data.ocr.active[4].lines[21].words[0].style.size).toBe(27);
  });

  // Sixth document
  test('Should correctly import trailing superscripts printed using font size adjustments (6th doc)', async () => {
    // Table cell "Other a" — the trailing "a" is a footnote-marker superscript.
    expect(scribe.data.ocr.active[5].lines[61].words.map((w) => w.text).join(' ')).toBe('Other a');
    expect(scribe.data.ocr.active[5].lines[61].words[1].style.sup).toBe(true);
    expect(scribe.data.ocr.active[5].lines[61].words[1].text).toBe('a');
  });

  test('Should correctly parse font size for lines with superscripts (6th doc)', async () => {
    // Footnote text starts with the leading-superscript marker "a"
    // ("a Includes burglary, larceny, motor vehicle theft, …"). The "a" must
    // be detected as a superscript even though it leads the line.
    expect(scribe.data.ocr.active[5].lines[158].words.map((w) => w.text).join(' ').slice(0, 70)).toBe('a Includes burglary, larceny, motor vehicle theft, arson, transportati');
    expect(scribe.data.ocr.active[5].lines[158].words[0].style.sup).toBe(true);
    expect(scribe.data.ocr.active[5].lines[158].words[0].text).toBe('a');
  });

  // This document breaks when used with `mutool convert` so is not combined with the others.
  // Any more tests included in the main stacked document should be inserted above this point.
  test('Should correctly parse font size for lines with superscripts (addtl doc)', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/superscript_example_report1.pdf`]);

    // Footnote (1): "(1) Effective July 1, 2023, prior period segment information…"
    expect(scribe.data.ocr.active[0].lines[86].words.map((w) => w.text).join(' ').slice(0, 80)).toBe('(1) Effective July 1, 2023, prior period segment information for the Corporate F');
    expect(scribe.data.ocr.active[0].lines[86].words[0].style.sup).toBe(true);
    expect(scribe.data.ocr.active[0].lines[86].words[0].text).toBe('(1)');

    // Footnote (3): "(3) See "FTI Consulting, Inc. Non-GAAP Financial Measures"…"
    expect(scribe.data.ocr.active[0].lines[93].words.map((w) => w.text).join(' ').slice(0, 80)).toBe('(3) See “FTI Consulting, Inc. Non-GAAP Financial Measures” for the definition of');
    expect(scribe.data.ocr.active[0].lines[93].words[0].style.sup).toBe(true);
    expect(scribe.data.ocr.active[0].lines[93].words[0].text).toBe('(3)');
  });

  test('Should correctly parse font size for lines with superscripts (addtl doc 2)', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/superscript_example_report2.pdf`]);

    expect(scribe.data.ocr.active[0].lines[32].words[4].style.sup).toBe(true);
    expect(scribe.data.ocr.active[0].lines[32].words[4].text).toBe('(1)');

    expect(scribe.data.ocr.active[0].lines[35].words[4].style.sup).toBe(true);
    expect(scribe.data.ocr.active[0].lines[35].words[4].text).toBe('(1)');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check font size is correctly parsed in PDF imports.', () => {
  test('Should correctly parse font sizes (1st doc)', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/border_patrol_tables.pdf`]);
    // This word was problematic at one point due to the change in font size between the first and second word.
    // Anchor on the line text so a future re-merge that shifts this footnote line still trips the test loudly.
    expect(scribe.data.ocr.active[0].lines[218].words.map((w) => w.text).join(' ')).toBe('* Agent staffing statistics depict FY19 on-board personnel data as of 09/30/2019');
    expect(scribe.data.ocr.active[0].lines[218].words[1].style.size).toBe(32.5);
    expect(scribe.data.ocr.active[0].lines[218].words[1].text).toBe('Agent');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check handling of PDFs with broken encoding dictionaries.', () => {
  test('PDF with invalid encoding dictionary is detected and text is not imported', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/Iris (plant) - Wikipedia_AdobePDF123.pdf`]);

    expect(scribe.inputData.pdfType).toBe('image');
    expect(scribe.data.ocr.active.length).toBe(0);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check that PDF imports split lines correctly.', () => {
  test('Should correctly parse PDF lines (1st doc)', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/border_patrol_tables.pdf`]);

    // A previous version of the build 5 words across 3 distinct lines (including this one) are combined into a single line.
    expect(scribe.data.ocr.active[0].lines[3].words.length).toBe(1);
    expect(scribe.data.ocr.active[0].lines[3].words[0].text).toBe('Apprehensions');
  });

  test('Should correctly parse PDF lines (2nd doc)', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/superscript_examples.pdf`]);

    // A previous version of the build split this line into 9 separate lines.
    expect(scribe.data.ocr.active[2].lines[58].words.map((x) => x.text).join(' ')).toBe('ment’s (DOE’s) issuance of Accounting and Auditing Enforcement Releases');

    // The source PDF has a mid-word space in "Anyfin" but it should still be parsed
    // as a single word; HEAD's parser split it into 2 words and the test tolerated that.
    expect(scribe.data.ocr.active[3].lines[105].words.length).toBe(1);
    expect(scribe.data.ocr.active[3].lines[105].words[0].text).toBe('Anyfin');
  });

  test('Should correctly parse PDF lines (3rd doc)', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/superscript_example_report1.pdf`]);

    // A previous version of the build split this line into 2 separate lines, by putting the leading superscript on a separate line.
    expect(scribe.data.ocr.active[0].lines[89].words.map((x) => x.text).join(' ')).toBe('(2) Beginning with the year ended December 31, 2023, the Company changed the presentation of interest income on forgivable loans on our Consolidated Statement of');
    expect(scribe.data.ocr.active[0].lines[89].words[0].style.sup).toBe(true);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check that PDF imports split words correctly.', () => {
  test('Should correctly split words not separated by space or any character defined in may_add_space', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/fti_filing_p25.pdf`]);

    expect(scribe.data.ocr.active[0].lines[4].words[0].text).toBe('☒');
    expect(scribe.data.ocr.active[0].lines[4].words[1].text).toBe('ANNUAL');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check that line baselines are imported correctly.', () => {
  test('Should correctly parse line baselines for pages with rotation', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/superscript_examples_rotated.pdf`]);
    expect(Math.round(scribe.data.ocr.active[0].lines[25].baseline[1])).toBe(-10);
    expect(Math.round(scribe.data.ocr.active[1].lines[25].baseline[1])).toBe(-162);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check that page angle is calculated correctly.', () => {
  test('Average text angle is correctly calculated', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/superscript_examples_rotated.pdf`]);
    expect(Math.round(scribe.data.pageMetrics[0].angle || 0)).toBe(-5);
    expect(Math.round(scribe.data.pageMetrics[1].angle || 0)).toBe(5);
  });

  test('Different orientations should not impact page angle.', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/CSF_Proposed_Budget_Book_June_2024_r8_30_all_orientations.pdf`]);
    expect(scribe.data.pageMetrics[0].angle).toBe(0);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check that text orientation is handled correctly.', () => {
  test('Lines printed at exactly 90/180/270 degrees have orientation detected correctly', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/CSF_Proposed_Budget_Book_June_2024_r8_30_all_orientations.pdf`]);
    expect(scribe.data.ocr.active[0].lines[2].words[0].line.orientation).toBe(3);
    expect(scribe.data.ocr.active[3].lines[2].words[0].line.orientation).toBe(2);
    expect(scribe.data.ocr.active[2].lines[2].words[0].line.orientation).toBe(1);
  });

  // The following tests compare the coordinates of a rotated line to the same line in a non-rotated version of the same document.
  test('Lines oriented at 90 degrees counterclockwise have coordinates calculated correctly', async () => {
    expect(Math.abs((scribe.data.ocr.active[0].lines[2].words[0].bbox.left) - (scribe.data.ocr.active[1].lines[2].words[0].bbox.left))).toBeLessThanOrEqual(1);
    expect(Math.abs((scribe.data.ocr.active[0].lines[2].words[0].bbox.right) - (scribe.data.ocr.active[1].lines[2].words[0].bbox.right))).toBeLessThanOrEqual(1);
    expect(Math.abs((scribe.data.ocr.active[0].lines[2].words[0].bbox.top) - (scribe.data.ocr.active[1].lines[2].words[0].bbox.top))).toBeLessThanOrEqual(1);
    expect(Math.abs((scribe.data.ocr.active[0].lines[2].words[0].bbox.bottom) - (scribe.data.ocr.active[1].lines[2].words[0].bbox.bottom))).toBeLessThanOrEqual(1);
  });

  test('Lines oriented at 90 degrees clockwise have coordinates calculated correctly', async () => {
    expect(Math.abs((scribe.data.ocr.active[2].lines[2].words[0].bbox.left) - (scribe.data.ocr.active[1].lines[2].words[0].bbox.left))).toBeLessThanOrEqual(1);
    expect(Math.abs((scribe.data.ocr.active[2].lines[2].words[0].bbox.right) - (scribe.data.ocr.active[1].lines[2].words[0].bbox.right))).toBeLessThanOrEqual(1);
    expect(Math.abs((scribe.data.ocr.active[2].lines[2].words[0].bbox.top) - (scribe.data.ocr.active[1].lines[2].words[0].bbox.top))).toBeLessThanOrEqual(1);
    expect(Math.abs((scribe.data.ocr.active[2].lines[2].words[0].bbox.bottom) - (scribe.data.ocr.active[1].lines[2].words[0].bbox.bottom))).toBeLessThanOrEqual(1);
  });

  test('Lines oriented at 180 degrees have coordinates calculated correctly', async () => {
    expect(Math.abs((scribe.data.ocr.active[3].lines[2].words[0].bbox.left) - (scribe.data.ocr.active[1].lines[2].words[0].bbox.left))).toBeLessThanOrEqual(1);
    expect(Math.abs((scribe.data.ocr.active[3].lines[2].words[0].bbox.right) - (scribe.data.ocr.active[1].lines[2].words[0].bbox.right))).toBeLessThanOrEqual(1);
    expect(Math.abs((scribe.data.ocr.active[3].lines[2].words[0].bbox.top) - (scribe.data.ocr.active[1].lines[2].words[0].bbox.top))).toBeLessThanOrEqual(1);
    expect(Math.abs((scribe.data.ocr.active[3].lines[2].words[0].bbox.bottom) - (scribe.data.ocr.active[1].lines[2].words[0].bbox.bottom))).toBeLessThanOrEqual(1);
  });

  test('Lines oriented at 90/180/270 degrees have line rotation detected correctly', async () => {
    expect(Math.abs((scribe.data.ocr.active[4].lines[0].baseline[0]) - (Math.tan(5 * (Math.PI / 180))))).toBeLessThanOrEqual(0.01);
    expect(Math.abs((scribe.data.ocr.active[6].lines[0].baseline[0]) - (Math.tan(5 * (Math.PI / 180))))).toBeLessThanOrEqual(0.01);
    expect(Math.abs((scribe.data.ocr.active[8].lines[0].baseline[0]) - (Math.tan(5 * (Math.PI / 180))))).toBeLessThanOrEqual(0.01);
    expect(Math.abs((scribe.data.ocr.active[10].lines[0].baseline[0]) - (Math.tan(5 * (Math.PI / 180))))).toBeLessThanOrEqual(0.01);
    expect(Math.abs((scribe.data.ocr.active[5].lines[0].baseline[0]) - (-Math.tan(5 * (Math.PI / 180))))).toBeLessThanOrEqual(0.01);
    expect(Math.abs((scribe.data.ocr.active[7].lines[0].baseline[0]) - (-Math.tan(5 * (Math.PI / 180))))).toBeLessThanOrEqual(0.01);
    expect(Math.abs((scribe.data.ocr.active[9].lines[0].baseline[0]) - (-Math.tan(5 * (Math.PI / 180))))).toBeLessThanOrEqual(0.01);
    expect(Math.abs((scribe.data.ocr.active[11].lines[0].baseline[0]) - (-Math.tan(5 * (Math.PI / 180))))).toBeLessThanOrEqual(0.01);

    expect(Math.abs((scribe.data.ocr.active[4].lines[2].baseline[0]) - (Math.tan(5 * (Math.PI / 180))))).toBeLessThanOrEqual(0.01);
    expect(Math.abs((scribe.data.ocr.active[6].lines[2].baseline[0]) - (Math.tan(5 * (Math.PI / 180))))).toBeLessThanOrEqual(0.01);
    expect(Math.abs((scribe.data.ocr.active[8].lines[2].baseline[0]) - (Math.tan(5 * (Math.PI / 180))))).toBeLessThanOrEqual(0.01);
    expect(Math.abs((scribe.data.ocr.active[10].lines[2].baseline[0]) - (Math.tan(5 * (Math.PI / 180))))).toBeLessThanOrEqual(0.01);
    expect(Math.abs((scribe.data.ocr.active[5].lines[2].baseline[0]) - (-Math.tan(5 * (Math.PI / 180))))).toBeLessThanOrEqual(0.01);
    expect(Math.abs((scribe.data.ocr.active[7].lines[2].baseline[0]) - (-Math.tan(5 * (Math.PI / 180))))).toBeLessThanOrEqual(0.01);
    expect(Math.abs((scribe.data.ocr.active[9].lines[2].baseline[0]) - (-Math.tan(5 * (Math.PI / 180))))).toBeLessThanOrEqual(0.01);
    expect(Math.abs((scribe.data.ocr.active[11].lines[2].baseline[0]) - (-Math.tan(5 * (Math.PI / 180))))).toBeLessThanOrEqual(0.01);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check that PDF text types are detected and imported correctly.', () => {
  test('Native text is detected and set as main data `usePDFText.native.main` is true', async () => {
    scribe.opt.usePDFText.native.main = true;
    await scribe.importFiles([`${ASSETS_PATH}/superscript_examples_rotated.pdf`]);
    scribe.opt.usePDFText.native.main = false;
    expect(scribe.inputData.pdfType).toBe('text');
    expect(scribe.data.ocr.active[0]?.lines?.length > 0).toBe(true);
  });

  test('Native text is detected and not set as main data `usePDFText.native.main` is false', async () => {
    scribe.opt.usePDFText.native.main = false;
    await scribe.importFiles([`${ASSETS_PATH}/superscript_examples_rotated.pdf`]);
    expect(scribe.inputData.pdfType).toBe('text');
    expect(!!scribe.data.ocr.active[0]).toBe(false);
  });

  test('OCR text is detected and set as main data `usePDFText.ocr.main` is true', async () => {
    scribe.opt.usePDFText.ocr.main = true;
    await scribe.importFiles([`${ASSETS_PATH}/scribe_test_pdf1.pdf`]);
    scribe.opt.usePDFText.native.main = false;
    expect(scribe.inputData.pdfType).toBe('ocr');
    expect(scribe.data.ocr.active[0]?.lines?.length > 0).toBe(true);
  });

  test('OCR text is detected and extracted but not set to main data when `usePDFText.ocr.main` is false', async () => {
    scribe.opt.usePDFText.ocr.main = false;
    await scribe.importFiles([`${ASSETS_PATH}/scribe_test_pdf1.pdf`]);
    // Reset to defaults
    scribe.opt.usePDFText.native.main = true;
    scribe.opt.usePDFText.ocr.main = false;
    expect(scribe.inputData.pdfType).toBe('ocr');
    expect(scribe.data.ocr.pdf[0]?.lines?.length > 0).toBe(true);
    expect(scribe.data.ocr.active[0]).toBeUndefined();
  });

  // If angle is set it would not be replaced by the accurate angle
  // when higher quality OCR text is imported or created.
  test('Page angle is not set from invisible OCR text when usePDFText.ocr.main is false', async () => {
    expect(scribe.data.pageMetrics[0].angle).toBe(null);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check that font style is detected for PDF imports.', () => {
  test('Bold style is detected', async () => {
    scribe.opt.usePDFText.native.main = true;
    await scribe.importFiles([`${ASSETS_PATH}/superscript_examples.pdf`]);
    // lines[26] is the "TABLE 6" header — bold, non-italic, non-underlined.
    expect(scribe.data.ocr.active[5].lines[26].words.map((w) => w.text).join(' ')).toBe('TABLE 6');
    expect(scribe.data.ocr.active[5].lines[26].words[0].style.bold).toBe(true);
    expect(scribe.data.ocr.active[5].lines[26].words[0].style.italic).toBe(false);
    expect(scribe.data.ocr.active[5].lines[26].words[0].style.underline).toBe(false);
  });

  test('Italic style is detected', async () => {
    expect(scribe.data.ocr.active[5].lines[22].words[4].style.italic).toBe(true);
    expect(scribe.data.ocr.active[5].lines[22].words[4].style.bold).toBe(false);
    expect(scribe.data.ocr.active[5].lines[22].words[4].style.underline).toBe(false);
  });

  test('Italic style is detected when leading punctuation is non-italic', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/high-risk_protection_order_application_for_and_declaration_in_support_of_mandatory_use.pdf`]);
    // Line: "Applicant ( Print your name above ),"
    // The non-italic "(" is now split into its own word, and the inner italicized
    // body words ("Print", "your", "name", "above") are italic. The non-italic
    // wrappers — "Applicant", "(", and ")," — must remain italic=false.
    expect(scribe.data.ocr.active[0].lines[15].words.map((w) => w.text).join(' ')).toBe('Applicant ( Print your name above ),');
    expect(scribe.data.ocr.active[0].lines[15].words[2].text).toBe('Print');
    expect(scribe.data.ocr.active[0].lines[15].words[2].style.italic).toBe(true);
    expect(scribe.data.ocr.active[0].lines[15].words[1].style.italic).toBe(false);
  });

  test('Bold + italic style is detected', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/complaint_1.pdf`]);
    expect(scribe.data.ocr.active[0].lines[1].words[0].text).toBe('impressive');
    expect(scribe.data.ocr.active[0].lines[1].words[0].style.italic).toBe(true);
    expect(scribe.data.ocr.active[0].lines[1].words[0].style.bold).toBe(true);
    expect(scribe.data.ocr.active[0].lines[1].words[0].style.underline).toBe(false);
  });

  test('Bold + underlined style is detected', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.pdf`]);
    expect(scribe.data.ocr.active[0].lines[22].words[0].text).toBe('COMPLAINT');
    expect(scribe.data.ocr.active[0].lines[22].words[0].style.italic).toBe(false);
    expect(scribe.data.ocr.active[0].lines[22].words[0].style.bold).toBe(true);
    expect(scribe.data.ocr.active[0].lines[22].words[0].style.underline).toBe(true);
  });

  test('Bold + underlined section heading is detected (NATURE OF THE ACTION)', async () => {
    await scribe.importFiles([`${ASSETS_PATH}/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.pdf`]);
    const line = scribe.data.ocr.active[0].lines[26];
    expect(line.words.map((w) => w.text).join(' ')).toBe('NATURE OF THE ACTION');
    for (const w of line.words) {
      expect(w.style.bold).toBe(true);
      expect(w.style.underline).toBe(true);
    }
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check that symbols are detected for PDF imports.', () => {
  test('Symbols are not combined with words', async () => {
    scribe.opt.usePDFText.native.main = true;
    // An earlier version combined the checkbox with the first word.
    await scribe.importFiles([`${ASSETS_PATH}/high-risk_protection_order_application_for_and_declaration_in_support_of_mandatory_use.pdf`]);
    expect(scribe.data.ocr.active[0].lines[9].words.length).toBe(4);
    expect(scribe.data.ocr.active[0].lines[9].words[1].text).toBe('Attorney,');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check that `keepPDFTextAlways` option works.', () => {
  test('Text-native headers are imported for image-based PDF document.', async () => {
    scribe.opt.keepPDFTextAlways = true;
    // This PDF is an image-based court document but has a text-native header added by the court system.
    await scribe.importFiles([`${ASSETS_PATH}/gov.uscourts.cand.249697.1.0_2.pdf`]);
    expect(scribe.inputData.pdfType).toBe('image');
    expect(!!scribe.data.ocr.active[0]?.lines?.length).toBe(false);
    expect(scribe.data.ocr.pdf[0].lines.length).toBe(1);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
