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

describe('Check evaluate function.', () => {
  beforeAll(async () => {
  });

  test('Should correctly compare page to ground truth', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/complaint_1.hocr`]);
    expect(doc.ocr.active[0].pars.length, 'a Scribe-written hOCR file without ocr_par must import paragraph-less').toBe(0);
    await doc.importFilesSupp([`${ASSETS_PATH}/complaint_1.truth.hocr`], 'Ground Truth');

    // The ternary's first branch holds the soft hyphen (U+00AD), which has no visible glyph.
    let retyped = 0;
    let hyphenated = 0;
    for (const line of doc.ocr['Ground Truth'][0].lines) {
      for (const word of line.words) {
        if (/[‘’“”]/.test(word.text)) { word.text = word.text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"'); retyped++; }
        if (/[A-Za-z]-[A-Za-z]/.test(word.text)) { word.text = word.text.replace('-', hyphenated % 2 ? '­' : '–'); hyphenated++; }
      }
    }
    expect(retyped, 'the ground truth holds words with curly quotes to retype').toBe(12);
    expect(hyphenated, 'the ground truth holds hyphenated words to retype').toBe(2);

    const res = await doc.compareOCR(doc.ocr.active, doc.ocr['Ground Truth']);

    const evalStatsDoc = scribe.utils.calcEvalStatsDoc(res.metrics);

    expect(evalStatsDoc.total, 'every ground-truth word is counted').toBe(654);
    expect(evalStatsDoc.correct, 'a word that differs from the ground truth only in quote or dash style counts as correct').toBe(650);
    expect(evalStatsDoc.incorrect, 'only the words that differ in letters or digits count as incorrect').toBe(4);
    expect(evalStatsDoc.missed).toBe(0);
    expect(evalStatsDoc.extra).toBe(0);

    const truthWord = scribe.utils.ocr.getPageWords(doc.ocr['Ground Truth'][0]).find((w) => w.text === 'PageID');
    if (!truthWord) throw new Error('the ground truth no longer holds the word PageID');
    truthWord.readings = [{
      source: 'abbyy', text: 'PageID', conf: 100,
    }, {
      source: 'abbyy', text: 'PageId', conf: 40, rank: 2, msg: 'c1',
    }];
    // Three words' flags are stamped wrong on a clone to prove the consensus sets its own.
    const base = doc.ocr.active.map((p) => scribe.utils.ocr.clonePage(p));
    for (const w of scribe.utils.ocr.getPageWords(base[0])) {
      if (['word_1_41', 'word_1_11', 'word_1_325'].includes(w.id)) { w.compTruth = w.id === 'word_1_41'; w.matchTruth = w.id !== 'word_1_41'; }
    }
    const consensus = scribe.buildConsensusLayer(base, [doc.ocr['Ground Truth']], { names: ['truth'], replaceMinAgree: 0 });
    expect(consensus.stats, 'the consensus of the OCR and the ground truth corroborates every word the comparison counts correct, and no other').toEqual({
      total: 655, high: 650, medium: 0, low: 5, replaced: 0, added: 0, spanned: 1, crossLine: 0,
    });
    const consensusWords = scribe.utils.ocr.getPageWords(consensus.ocr[0]);
    const byId = new Map(consensusWords.map((w) => [w.id, w]));
    expect(byId.get('word_1_41')?.readings, 'a word the two layers spell with different quote marks keeps both spellings as readings and counts as agreed').toEqual([
      { source: 'hocr', text: '2020.”', conf: 100 }, { source: 'truth', text: '2020."', conf: 100 },
    ]);
    expect(byId.get('word_1_41')?.conf, 'a word both layers read the same way gets the full-corroboration confidence').toBe(100);
    expect(byId.get('word_1_11')?.readings, 'a word the layers read differently keeps each reading with its source, and a comparator\'s second choice comes along under the comparator\'s name')
      .toEqual([
        { source: 'hocr', text: 'PagelD', conf: 0 }, { source: 'truth', text: 'PageID', conf: 100 }, {
          source: 'truth', text: 'PageId', conf: 40, rank: 2, msg: 'c1',
        },
      ]);
    expect(byId.get('word_1_11')?.text, 'with the plurality overwrite off, a disputed word keeps the base layer\'s text').toBe('PagelD');
    const replaced = scribe.buildConsensusLayer(base, [doc.ocr['Ground Truth']], { names: ['truth'], replaceMinAgree: 1 });
    expect(replaced.stats.replaced, 'the plurality overwrite replaces the words one comparator read differently').toBe(3);
    const replacedWord = scribe.utils.ocr.getPageWords(replaced.ocr[0]).find((w) => w.id === 'word_1_11');
    expect(replacedWord?.text, 'the comparator\'s reading replaces the disputed base text').toBe('PageID');
    expect(replacedWord?.readings, 'the reading a replaced word stands by moves to the front of its list').toEqual([
      { source: 'truth', text: 'PageID', conf: 100 }, { source: 'hocr', text: 'PagelD', conf: 0 }, {
        source: 'truth', text: 'PageId', conf: 40, rank: 2, msg: 'c1',
      },
    ]);
    // Regression: the vote counted raw spellings, so two comparators that agreed except for quote style tied instead of outvoting a wrong base word.
    const truthCurly = doc.ocr['Ground Truth'].map((p) => scribe.utils.ocr.clonePage(p));
    for (const w of scribe.utils.ocr.getPageWords(truthCurly[0])) w.text = w.text.replace(/"/g, '”').replace(/'/g, '’');
    const baseWrong = doc.ocr.active.map((p) => scribe.utils.ocr.clonePage(p));
    const wrongWord = scribe.utils.ocr.getPageWords(baseWrong[0]).find((w) => w.id === 'word_1_41');
    if (!wrongWord) throw new Error('the base layer no longer holds word_1_41');
    wrongWord.text = '2O2O.';
    const outvoted = scribe.buildConsensusLayer(baseWrong, [doc.ocr['Ground Truth'], truthCurly], { names: ['truth', 'curly'] });
    expect(outvoted.stats.replaced, 'two comparators that agree except for quote style outvote a base word neither matches').toBe(4);
    const outvotedWord = scribe.utils.ocr.getPageWords(outvoted.ocr[0]).find((w) => w.id === 'word_1_41');
    expect(outvotedWord?.text, 'the outvoting reading replaces the base text in the first comparator\'s spelling').toBe('2020."');
    expect(outvotedWord?.readings, 'both spellings of the outvoting reading move to the front of the replaced word\'s list').toEqual([
      { source: 'truth', text: '2020."', conf: 100 }, { source: 'curly', text: '2020.”', conf: 100 }, { source: 'hocr', text: '2O2O.', conf: 100 },
    ]);
    expect([byId.get('word_1_41')?.compTruth, byId.get('word_1_41')?.matchTruth], 'a word every comparator corroborated is marked compared and matched').toEqual([true, true]);
    expect([byId.get('word_1_11')?.compTruth, byId.get('word_1_11')?.matchTruth], 'a word a comparator read differently is marked compared and unmatched').toEqual([true, false]);
    expect([byId.get('word_1_325')?.compTruth, byId.get('word_1_325')?.matchTruth], 'the second word of a joined reading is marked compared and unmatched, as the combine marks a split word')
      .toEqual([true, false]);
    expect(byId.get('word_1_324')?.readings, 'a reading that joins two base words is kept on the first with its span').toEqual([
      { source: 'hocr', text: 'Nutrition', conf: 0 }, {
        source: 'truth', text: "Nutrition's", conf: 100, span: 2,
      },
    ]);
    expect(byId.get('word_1_325')?.readings, 'the second word of a joined reading keeps only its own reading').toEqual([{ source: 'hocr', text: '’s', conf: 0 }]);

    const gtPage = doc.ocr['Ground Truth'][0];
    const box = {
      left: 300, top: gtPage.dims.height - 120, right: 520, bottom: gtPage.dims.height - 80,
    };
    const extraLine = new scribe.utils.ocr.OcrLine(gtPage, { ...box }, [0, 0], 28, 14);
    const extraWord = new scribe.utils.ocr.OcrWord(extraLine, 'word_extra_1', 'Appendix', { ...box });
    extraWord.conf = 100;
    extraLine.words.push(extraWord);
    gtPage.lines.push(extraLine);
    const consensus2 = scribe.buildConsensusLayer(doc.ocr.active, [doc.ocr['Ground Truth'], doc.ocr['Ground Truth']], { names: ['truth', 'truth2'], replaceMinAgree: 0 });
    expect(consensus2.stats.added, 'a word two comparators read where the base has none is added once, not once per comparator').toBe(1);
    const addedWord = scribe.utils.ocr.getPageWords(consensus2.ocr[0]).find((w) => w.text === 'Appendix');
    expect(addedWord?.readings, 'the added word carries every comparator\'s reading of it').toEqual([
      { source: 'truth', text: 'Appendix', conf: 100 }, { source: 'truth2', text: 'Appendix', conf: 100 },
    ]);
    expect([addedWord?.compTruth, addedWord?.matchTruth], 'an added word two comparators read alike is marked compared and matched').toEqual([true, true]);
  });

  test('Words and lines merged into a page enter it in reading order', () => {
    // Regression: a word right of a line's last word landed before it, and a new line always landed last.
    const page = scribe.utils.ocr.clonePage(doc.ocr.active[0]);
    const extra = new scribe.utils.ocr.OcrPage(0, { ...page.dims });
    /** @type {Array<[string, {left: number, top: number, right: number, bottom: number}]>} */
    const additions = [
      ['BETWEEN', {
        left: 400, top: 180, right: 700, bottom: 230,
      }],
      ['ADDED', {
        left: 2200, top: 60, right: 2320, bottom: 100,
      }],
      ['TOP', {
        left: 400, top: 5, right: 700, bottom: 40,
      }],
    ];
    for (const [text, box] of additions) {
      const line = new scribe.utils.ocr.OcrLine(extra, { ...box }, [0, 0], 30, null);
      const word = new scribe.utils.ocr.OcrWord(line, `word_${text}`, text, { ...box });
      word.conf = 100;
      line.words.push(word);
      extra.lines.push(line);
    }
    scribe.combineOCRPage(extra, page, doc.pageMetrics[0], true, false);
    const texts = page.lines.map((line) => scribe.utils.ocr.getLineText(line));
    expect(page.lines.length, 'the two new lines joined the page as lines of their own and the word joined an existing line').toBe(35);
    expect(texts[0], 'a line above the first line enters the page first').toBe('TOP');
    expect(texts[1], 'a word right of a line\'s last word enters that line after it')
      .toBe('Case: 1:24-cv-00634 Document #: 1 Filed: 01/24/24 Page 12 of 28 PagelD #:12 ADDED');
    expect(texts[2], 'a line between two lines enters the page between them').toBe('BETWEEN');
    expect(texts[3], 'the line below an inserted line keeps its place')
      .toBe('impressive growth path, with strength across the Human and Animal Nutrition leading to strong');

    const truth = scribe.utils.ocr.clonePage(doc.ocr['Ground Truth'][0]);
    /** @type {Array<[string, {left: number, top: number, right: number, bottom: number}]>} */
    const truthAdditions = [
      ['EXTRA', {
        left: 2300, top: 318, right: 2420, bottom: 358,
      }],
      ['MIDDLE', {
        left: 400, top: 180, right: 700, bottom: 230,
      }],
    ];
    for (const [text, box] of truthAdditions) {
      const line = new scribe.utils.ocr.OcrLine(truth, { ...box }, [0, 0], 30, null);
      const word = new scribe.utils.ocr.OcrWord(line, `word_${text}`, text, { ...box });
      word.conf = 100;
      line.words.push(word);
      truth.lines.push(line);
    }
    const consensus = scribe.buildConsensusLayer(doc.ocr.active, [[truth]], { names: ['truth'], replaceMinAgree: 0 });
    const { lines } = consensus.ocr[0];
    expect(scribe.utils.ocr.getLineText(lines[1]), 'a comparator\'s line at a place the base lacks enters the consensus between the lines around it').toBe('MIDDLE');
    expect(scribe.utils.ocr.getLineText(lines[2]), 'a comparator\'s word right of a base line\'s last word enters that line after it')
      .toBe('impressive growth path, with strength across the Human and Animal Nutrition leading to strong EXTRA');
    const added = lines[2].words[lines[2].words.length - 1];
    expect(added.readings, 'an added word carries the reading of the comparator that read it').toEqual([{ source: 'truth', text: 'EXTRA', conf: 100 }]);
    expect(added.conf, 'an added word carries the low confidence, since no other source corroborates it').toBe(50);
    expect([added.compTruth, added.matchTruth], 'an added word one source alone read is marked uncompared').toEqual([false, false]);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check importFilesSupp works with Textract data.', () => {
  test('Should import Textract data as supplementary OCR without error', async () => {
    // Import image first to populate page metrics (required by Textract format).
    doc = await scribe.openDocument([`${ASSETS_PATH}/ascenders_descenders_test.png`,
      `${ASSETS_PATH}/ascenders_descenders_test.abbyy.xml`]);

    // Import Textract as supplementary data — this would throw
    // "Page metrics must be provided for Textract data." before the fix.
    await doc.importFilesSupp(
      [`${ASSETS_PATH}/ascenders_descenders_test_AwsTextractLayout.json`],
      'Textract',
    );

    // Verify the imported data matches expected content exactly.
    const textractPage = doc.ocr.Textract[0];
    expect(textractPage.lines.length).toBe(3);
    expect(textractPage.lines[0].words.map((x) => x.text).join(' ')).toBe('Ascenders On');
    expect(textractPage.lines[1].words.map((x) => x.text).join(' ')).toBe('query png');
    expect(textractPage.lines[2].words.map((x) => x.text).join(' ')).toBe('we can');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check importFilesSupp works with per-page Textract files.', () => {
  test('Should import per-page Textract files and assign each to the correct page', async () => {
    const subDir = `${ASSETS_PATH}/trident_v_connecticut_general`;

    // Import the multi-page PDF first to populate page metrics.
    doc = await scribe.openDocument([`${ASSETS_PATH}/trident_v_connecticut_general.pdf`]);

    // Import 7 per-page Textract JSON files as supplementary data.
    const textractFiles = [];
    for (let i = 0; i < 7; i++) {
      textractFiles.push(`${subDir}/awsTextract/trident_v_connecticut_general_${String(i).padStart(3, '0')}-AwsTextractLayoutSync.json`);
    }
    await doc.importFilesSupp(textractFiles, 'Textract');

    // Verify each page has the expected line/word counts and correct first line.
    // Before the fix, all data merged into page 0 (~4500 words) and pages 1-6 were empty.
    const expected = [
      { lines: 98, words: 614, firstLine: '564' },
      { lines: 33, words: 192, firstLine: '565' },
      { lines: 102, words: 674, firstLine: '566' },
      { lines: 118, words: 834, firstLine: '567' },
      { lines: 120, words: 831, firstLine: '568' },
      { lines: 109, words: 732, firstLine: '569' },
      { lines: 100, words: 659, firstLine: '570' },
    ];

    for (let i = 0; i < 7; i++) {
      const page = doc.ocr.Textract[i];
      const wordCount = page.lines.reduce((sum, l) => sum + l.words.length, 0);
      const firstLine = page.lines[0].words.map((w) => w.text).join(' ');
      expect(page.lines.length).toBe(expected[i].lines);
      expect(wordCount).toBe(expected[i].words);
      expect(firstLine).toBe(expected[i].firstLine);
    }
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
