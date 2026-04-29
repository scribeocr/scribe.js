import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { extractPDFTextDirect } from '../../js/pdf/parsePdfDoc.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;

/** @param {string} pdfPath */
async function readPdfBytes(pdfPath) {
  if (isNode) {
    const { readFile } = await import('node:fs/promises');
    return new Uint8Array(await readFile(pdfPath));
  }
  const response = await fetch(pdfPath);
  return new Uint8Array(await response.arrayBuffer());
}

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

  test('Should load chi_sim font so getWordFont works on Chinese words', async () => {
    const { FontCont } = await import('../../js/containers/fontContainer.js');
    const chiWord = scribe.data.ocr.active[0].lines.flatMap((l) => l.words).find((w) => w.lang === 'chi_sim');
    expect(chiWord).toBeDefined();
    expect(FontCont.getWordFont(chiWord).family).toBe('NotoSansSC');
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

  test('Footnote line at lines[43] starts with leading superscript "1" followed by "See" (1st doc)', async () => {
    // Existing test above verifies lines[43].words[0] is a leading superscript.
    // This test goes further: the same line is the start of a "See ..."
    // footnote, so words[1] should be "See" and not be marked as a superscript.
    const line = scribe.data.ocr.active[0].lines[43];
    expect(line.words[0].text).toBe('1');
    expect(line.words[0].style.sup).toBe(true);
    expect(line.words[1].text).toBe('See');
    expect(line.words[1].style.sup).toBe(false);
  });

  test('Trailing superscript "1" at lines[25].words[8] has smaller font size than surrounding non-sup words (1st doc)', async () => {
    const line = scribe.data.ocr.active[0].lines[25];
    // words[7] = "years.", words[8] = "1" (sup), words[9] = "Furthermore,"
    expect(line.words[8].text).toBe('1');
    expect(line.words[8].style.sup).toBe(true);
    expect(line.words[8].style.size).toBeCloseTo(26.982, 3);
    expect(line.words[7].style.sup).toBe(false);
    expect(line.words[7].style.size).toBeCloseTo(43.587, 3);
    const supSize = /** @type {number} */ (line.words[8].style.size);
    const normalSize = /** @type {number} */ (line.words[7].style.size);
    expect(supSize).toBeLessThan(normalSize);
  });

  test('Trailing superscript "1" at lines[25].words[8] sits above the non-sup baseline (1st doc)', async () => {
    const line = scribe.data.ocr.active[0].lines[25];
    expect(line.words[8].bbox.bottom).toBe(1685);
    expect(line.words[7].bbox.bottom).toBe(1705);
    expect(line.words[8].bbox.bottom).toBeLessThan(line.words[7].bbox.bottom);
  });

  test('Trailing superscript at lines[25].words[8] is positioned within 25px of the surrounding non-sup baseline (1st doc)', async () => {
    // Without bbox correction, the superscript is shifted up by the full
    // baseline offset (gap >50px). With correction, the gap should be ≤25px.
    // Catches the opposite failure mode of the strict "sits above" test above.
    const line = scribe.data.ocr.active[0].lines[25];
    expect(line.words[8].text).toBe('1');
    expect(line.words[8].style.sup).toBe(true);
    expect(line.words[0].style.sup).toBeFalsy();
    expect(Math.abs(line.words[8].bbox.bottom - line.words[0].bbox.bottom)).toBeLessThanOrEqual(25);
  });

  test('Copyright line at lines[46] (1st doc) is split into 18 individual words', async () => {
    // The "© 2024 The Authors. Econometrica published by..." copyright line
    // should be split into individual words, not concatenated into a single run.
    const line = scribe.data.ocr.active[0].lines[46];
    expect(line.words.length).toBe(18);
    expect(line.words[0].text).toBe('©');
    expect(line.words[1].text).toBe('2024');
  });

  test('Parenthesized citation "(Bayless, 2000;" at page 3 lines[62] is split as two words, not by characters', async () => {
    // Without correct handling, "(Bayless, 2000;" might split into "(",
    // "Bayless,", "20", "0", "0", ";".
    const line = scribe.data.ocr.active[2].lines[62];
    expect(line.words[8].text).toBe('(Bayless,');
    expect(line.words[9].text).toBe('2000;');
  });

  test('Number "71,542" at page 6 lines[35].words[0] is kept as a single word, not split at the comma', async () => {
    expect(scribe.data.ocr.active[5].lines[35].words[0].text).toBe('71,542');
  });

  test('Word "Latin" at page 4 lines[4].words[2] is not falsely underlined when the nearest vector path is too far below', async () => {
    const line = scribe.data.ocr.active[3].lines[4];
    expect(line.words[2].text).toBe('Latin');
    expect(line.words[2].style.underline).toBe(false);
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

describe('Check Type0 sibling-font ToUnicode fallback (coca-cola-business-and-sustainability-report-2022.pdf).', () => {
  beforeAll(async () => {
    await scribe.importFiles([`${ASSETS_PATH}/coca-cola-business-and-sustainability-report-2022.pdf`]);
  });

  test('Imports all 15 pages of the report', async () => {
    expect(scribe.data.ocr.active.length).toBe(15);
  });

  test('Page 1 heading contains "THE COCA" and "BUSINESS & SUSTAINABILITY REPORT" with no control characters', async () => {
    const lineTexts = scribe.data.ocr.active[0].lines.map((l) => l.words.map((w) => w.text).join(' '));
    const headingLine = lineTexts.find((line) => line.includes('BUSINESS & SUSTAINABILITY REPORT'));
    expect(headingLine).toBeDefined();
    const heading = /** @type {string} */ (headingLine);
    expect(heading).toContain('THE COCA');
    // eslint-disable-next-line no-control-regex
    expect(/[\x00-\x1F]/.test(heading)).toBe(false);
  });

  test('Page 1 contains "Net Operating Revenues, Operating Income and Unit Case Volume by Operating Segment"', async () => {
    const lineTexts = scribe.data.ocr.active[0].lines.map((l) => l.words.map((w) => w.text).join(' '));
    const segmentLine = lineTexts.find((line) => line.includes('Net Operating Revenues, Operating Income and Unit Case Volume by Operating Segment'));
    expect(segmentLine).toBeDefined();
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check direct text extraction from Iris (plant) - Wikipedia_123.pdf.', () => {
  beforeAll(async () => {
    await scribe.importFiles([`${ASSETS_PATH}/Iris (plant) - Wikipedia_123.pdf`]);
  });

  test('Extracts all 3 pages', async () => {
    expect(scribe.data.ocr.active.length).toBe(3);
  });

  test('Page 1 has dimensions 2550x3300 (300 DPI rendering of US Letter)', async () => {
    expect(scribe.data.ocr.active[0].dims.width).toBe(2550);
    expect(scribe.data.ocr.active[0].dims.height).toBe(3300);
  });

  test('Visual top line of page 1 is "Iris (plant)"', async () => {
    const sortedLines = [...scribe.data.ocr.active[0].lines].sort(
      (a, b) => (a.bbox.top - b.bbox.top) || (a.bbox.left - b.bbox.left),
    );
    expect(sortedLines[0].words.map((w) => w.text).join(' ')).toBe('Iris (plant)');
  });

  test('Page 1 contains expected article body text', async () => {
    const allText = scribe.data.ocr.active[0].lines
      .map((l) => l.words.map((w) => w.text).join(' '))
      .join('\n');
    expect(allText).toContain('Iris is a');
    expect(allText).toContain('flowering plant genus');
    expect(allText).toContain('showy flowers');
  });

  test('Page 1 surfaces the literal fill color and opacity 1 for visible text', async () => {
    // Text-native PDF, default `Tr=0`. Page 0 mixes default-black body text
    // (243 words) with grey link/caption words (#666666, 4 words).
    const opacities = new Set();
    const colors = new Map();
    for (const line of scribe.data.ocr.active[0].lines) {
      for (const w of line.words) {
        opacities.add(w.style.opacity);
        colors.set(w.style.color, (colors.get(w.style.color) || 0) + 1);
      }
    }
    expect([...opacities]).toEqual([1]);
    expect(colors.get('#000000')).toBe(243);
    expect(colors.get('#666666')).toBe(4);
    expect(colors.size).toBe(2);
  });

  test('Page 1 lines[0].words[0] is "Iris" with 4 chars at expected per-char widths and a uniform height of 35', async () => {
    const word = scribe.data.ocr.active[0].lines[0].words[0];
    expect(word.text).toBe('Iris');
    expect(word.chars).toBeDefined();
    const chars = /** @type {NonNullable<typeof word.chars>} */ (word.chars);
    expect(chars.length).toBe(4);
    expect(chars.map((c) => c.text)).toEqual(['I', 'r', 'i', 's']);
    expect(chars[0].bbox.right - chars[0].bbox.left).toBe(14);
    expect(chars[1].bbox.right - chars[1].bbox.left).toBe(20);
    expect(chars[2].bbox.right - chars[2].bbox.left).toBe(14);
    expect(chars[3].bbox.right - chars[3].bbox.left).toBe(27);
    for (const ch of chars) expect(ch.bbox.bottom - ch.bbox.top).toBe(35);
  });

  test('"Iris sibirica" caption at lines[1] has font size 44', async () => {
    expect(scribe.data.ocr.active[0].lines[1].words.map((w) => w.text).join(' ')).toBe('Iris sibirica');
    expect(scribe.data.ocr.active[0].lines[1].words[0].style.size).toBe(44);
  });

  test('"Kingdom: Plantae" taxonomy line at lines[3] has font size 50', async () => {
    expect(scribe.data.ocr.active[0].lines[3].words.map((w) => w.text).join(' ')).toBe('Kingdom: Plantae');
    expect(scribe.data.ocr.active[0].lines[3].words[0].style.size).toBe(50);
  });

  test('Page 2 line "...The three styles [7] divide..." is not split at the inline superscript', async () => {
    const page = scribe.data.ocr.active[1];
    const matches = page.lines.filter((l) => l.words.map((w) => w.text).join(' ').startsWith('parts). The three styles'));
    expect(matches.length).toBe(1);
    expect(matches[0].words.map((w) => w.text).join(' ')).toBe('parts). The three styles [7] divide towards the apex into petaloid branches; this is significant in');
  });

  test('Page 2 line "...with the three [7] stigmatic" is not split at the inline superscript', async () => {
    const page = scribe.data.ocr.active[1];
    const matches = page.lines.filter((l) => l.words.map((w) => w.text).join(' ').startsWith('contact with the perianth'));
    expect(matches.length).toBe(1);
    expect(matches[0].words.map((w) => w.text).join(' ')).toBe('contact with the perianth, then with the three [7] stigmatic');
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

  test('Type1 fonts using hex strings do not produce false CJK characters (rotated.pdf page 0)', async () => {
    // Earlier versions of the Type1 hex-string decoder mis-mapped some byte
    // values to CJK code points. Asserts (a) page 0 word-by-word has no chars
    // in the U+3400–U+9FFF range, and (b) the page actually parsed (lines[0]
    // text matches the expected first word of the Econometrica article).
    const page0 = scribe.data.ocr.active[0];
    for (const line of page0.lines) {
      for (const word of line.words) {
        expect(/[㐀-鿿]/.test(word.text), `word "${word.text}"`).toBe(false);
      }
    }
    expect(page0.lines[0].words[0].text).toBe('Econometrica');
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

  test('pageMetrics dims match post-rotation ocr dims for all four /Rotate values', () => {
    // Page 0: /Rotate 0   (portrait)  612x792pt -> 2550x3300 @ 300dpi
    // Page 1: /Rotate 90  (landscape) post-rotation 792x612pt -> 3300x2550
    // Page 2: /Rotate 180 (portrait)  612x792pt -> 2550x3300
    // Page 3: /Rotate 270 (landscape) post-rotation 792x612pt -> 3300x2550
    for (const i of [0, 1, 2, 3]) {
      expect(scribe.data.pageMetrics[i].dims.width).toBe(scribe.data.ocr.active[i].dims.width);
      expect(scribe.data.pageMetrics[i].dims.height).toBe(scribe.data.ocr.active[i].dims.height);
    }
    expect(scribe.data.pageMetrics[0].dims).toEqual({ width: 2550, height: 3300 });
    expect(scribe.data.pageMetrics[1].dims).toEqual({ width: 3300, height: 2550 });
    expect(scribe.data.pageMetrics[2].dims).toEqual({ width: 2550, height: 3300 });
    expect(scribe.data.pageMetrics[3].dims).toEqual({ width: 3300, height: 2550 });
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

  // This is a distinct test case because the mechanism for hiding OCR text is different.
  // The OCR layer uses `3 Tr` and has no explicit /ca.
  test('Words rendered with `3 Tr` (invisible) parse to opacity 0 and default-black color', async () => {
    const opacities = new Set();
    const colors = new Set();
    for (const line of scribe.data.ocr.active[0].lines) {
      for (const w of line.words) {
        opacities.add(w.style.opacity);
        colors.add(w.style.color);
      }
    }
    expect([...opacities]).toEqual([0]);
    expect([...colors]).toEqual(['#000000']);
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

describe('intel-history-1996-annual-report.pdf direct-parser regression', () => {
  /** @type {Record<number, any>} */
  const page = {};

  beforeAll(async () => {
    const pdfBytes = await readPdfBytes(`${ASSETS_PATH}/intel-history-1996-annual-report.pdf`);
    const pages = /** @type {any[]} */ (extractPDFTextDirect(pdfBytes));
    for (const i of [7, 8, 10, 18]) page[i] = pages[i].pageObj;
  });

  describe('page 10 — dot leaders split from preceding text', () => {
    // Page 10 is a financial statement with dot leaders separating labels from
    // values. The dots are rendered at a smaller text-matrix size (Tm scale 5)
    // than the labels (scale 9.5), but use the same font and sit on the same
    // baseline with zero gap. Without a word split at the font-size boundary,
    // the dots merge into the preceding word ("equivalents.......").
    test('"equivalents" should not contain trailing dot leaders', () => {
      const word = page[10].lines.flatMap((/** @type {any} */ ln) => ln.words).find((/** @type {any} */ w) => w.text.startsWith('equivalents'));
      expect(word).toBeTruthy();
      expect(word.text).toBe('equivalents');
    });

    test('"expenses" should not contain trailing dot leaders', () => {
      const words = page[10].lines.flatMap((/** @type {any} */ ln) => ln.words).filter((/** @type {any} */ w) => w.text.startsWith('expenses'));
      expect(words.length).toBeGreaterThan(0);
      for (const word of words) {
        expect(word.text).toBe('expenses');
      }
    });
  });

  describe('page 18 — drop caps merge with continuation text', () => {
    // Page 18 has drop cap letters: a large "I" starting "Intel posted record..."
    // and a large "T" starting "The Company's financial condition...". The drop
    // cap is rendered at Tm scale 26.79 while the continuation uses scale 9.5
    // (same font F17). The drop cap baseline sits lower (it spans multiple
    // lines), but the continuation should still merge into the same line.
    test('Line 42: drop cap "I" + "ntel" continuation', () => {
      expect(page[18].lines[42].words[0].text).toBe('I');
      expect(page[18].lines[42].words[0].style.dropcap).toBe(true);
      expect(page[18].lines[42].words[0].bbox.bottom).toBe(353);
      expect(page[18].lines[42].words[1].text).toBe('ntel');
      expect(page[18].lines[42].words[1].style.sup).not.toBe(true);
    });

    test('Line 137: drop cap "T" + "he" continuation', () => {
      expect(page[18].lines[137].words[0].text).toBe('T');
      expect(page[18].lines[137].words[0].style.dropcap).toBe(true);
      expect(page[18].lines[137].words[0].bbox.bottom).toBe(1006);
      expect(page[18].lines[137].words[1].text).toBe('he');
      expect(page[18].lines[137].words[1].style.sup).not.toBe(true);
    });

    // The header has "Management's discussion and analysis" at size 29.5 and
    // "of financial condition" at size 17.7 on a different baseline. These must
    // be separate lines, with "of" not flagged as superscript.
    test('Line 234 large heading "Management’s discussion and analysis"', () => {
      expect(page[18].lines[234].words[0].text).toBe('Management’s');
      expect(page[18].lines[234].words[3].text).toBe('analysis');
    });

    test('Line 235 sub-heading "of financial condition" (not superscript)', () => {
      expect(page[18].lines[235].words[0].text).toBe('of');
      expect(page[18].lines[235].words[0].style.sup).not.toBe(true);
      expect(page[18].lines[235].words[2].text).toBe('condition');
    });
  });

  describe('page 7 — curly-quote merging and drop caps', () => {
    // Page 7 references the Intel jingle as "bong" with curly quotes. The
    // opening U+201C is emitted later in the content stream than "bong",
    // landing on a separate line; it must be merged into the same word.
    test('Line 59 word 0: "“bong”" (curly-quoted, split from "sound")', () => {
      expect(page[7].lines[59].words[0].text).toBe('“bong”');
    });

    // Page 7 has 4 drop caps each isolated on their own line instead of being
    // on the same line as the continuation text:
    //   "T" + "he Intel Inside..." / "I" + "n 1996, we launched..." /
    //   "W" + "e have worked..."   / "I" + "n1996, more than..."
    test('Line 7: drop cap "T" + "he"', () => {
      expect(page[7].lines[7].words[0].text).toBe('T');
      expect(page[7].lines[7].words[0].style.dropcap).toBe(true);
      expect(page[7].lines[7].words[1].text).toBe('he');
    });

    test('Line 22: drop cap "I" + "n"', () => {
      expect(page[7].lines[22].words[0].text).toBe('I');
      expect(page[7].lines[22].words[0].style.dropcap).toBe(true);
      expect(page[7].lines[22].words[1].text).toBe('n');
    });

    test('Line 39: drop cap "W" + "e"', () => {
      expect(page[7].lines[39].words[0].text).toBe('W');
      expect(page[7].lines[39].words[0].style.dropcap).toBe(true);
      expect(page[7].lines[39].words[1].text).toBe('e');
    });

    test('Line 49: drop cap "I" + "n1996,"', () => {
      expect(page[7].lines[49].words[0].text).toBe('I');
      expect(page[7].lines[49].words[0].style.dropcap).toBe(true);
      expect(page[7].lines[49].words[1].text).toBe('n1996,');
    });
  });

  describe('page 8 — body text near decorative rules is not falsely underlined', () => {
    // Page 8 has several words flagged as underlined due to nearby thin
    // horizontal vector paths that are decorative borders, not real underlines.
    test('Line 3 word 0 "worldwide"', () => {
      expect(page[8].lines[3].words[0].text).toBe('worldwide');
      expect(page[8].lines[3].words[0].style.underline).not.toBe(true);
    });

    test('Line 34 words 0-2 "Brazil is hot"', () => {
      expect(page[8].lines[34].words[0].text).toBe('Brazil');
      expect(page[8].lines[34].words[0].style.underline).not.toBe(true);
      expect(page[8].lines[34].words[1].text).toBe('is');
      expect(page[8].lines[34].words[1].style.underline).not.toBe(true);
      expect(page[8].lines[34].words[2].text).toBe('hot');
      expect(page[8].lines[34].words[2].style.underline).not.toBe(true);
    });

    test('Line 49 words 0-1 "of China"', () => {
      expect(page[8].lines[49].words[0].text).toBe('of');
      expect(page[8].lines[49].words[0].style.underline).not.toBe(true);
      expect(page[8].lines[49].words[1].text).toBe('China');
      expect(page[8].lines[49].words[1].style.underline).not.toBe(true);
    });

    test('Line 61 words 0-1 "The India"', () => {
      expect(page[8].lines[61].words[0].text).toBe('The');
      expect(page[8].lines[61].words[0].style.underline).not.toBe(true);
      expect(page[8].lines[61].words[1].text).toBe('India');
      expect(page[8].lines[61].words[1].style.underline).not.toBe(true);
    });
  });
});
