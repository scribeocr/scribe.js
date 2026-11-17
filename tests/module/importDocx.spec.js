import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { parseParagraphs } from '../../js/import/convertDocDocx.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

/** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
let doc;

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

// Using arrow functions breaks references to `this`.

// Skip tests prior to Node.js EOL (20.x) where the native File class is available.
// While the library should be compatible with earlier versions of Node.js,
// getting every test to run on versions that are already EOL is not a priority.

describe('Check docx import function.', () => {
  test('Should import docx file', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/testocr.abbyy.xml`]);
    const docxData = await doc.exportData('docx');

    await scribe.terminate();

    const docxFile = new File([docxData], 'test.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    doc = await scribe.openDocument([docxFile]);
  });

  test('Should correctly import text content from docx', async () => {
    const text1 = doc.ocr.active[0].lines[0].words.map((x) => x.text).join(' ');

    expect(text1).toContain('This is a lot of 12 point text');
  });

  test('Should correctly import paragraphs from docx', async () => {
    expect(doc.ocr.active[0].lines.length > 0).toBe(true);
    expect(doc.ocr.active[0].pars.length > 0).toBe(true);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check export -> import round-trip for docx files.', () => {
  test('Exporting and importing docx should preserve text content', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/testocr.abbyy.xml`]);

    const originalText = doc.ocr.active.map((page) => page.lines.map((line) => line.words.map((word) => word.text).join(' ')).join('\n')).join('\n\n');

    const docxData = await doc.exportData('docx');
    const docxFile = new File([docxData], 'test.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    await scribe.terminate();
    doc = await scribe.openDocument([docxFile]);

    const importedText = doc.ocr.active.map((page) => page.lines.map((line) => line.words.map((word) => word.text).join(' ')).join('\n')).join('\n\n');

    expect(importedText).toContain('This is a lot of 12 point text');
    expect(importedText).toContain('The quick brown dog jumped');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check that font styles are preserved in docx round-trip.', () => {
  test('Bold style is preserved in round-trip', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/complaint_1.abbyy.xml`]);

    const originalBoldWord = doc.ocr.active[1].lines[3].words[0];
    expect(originalBoldWord.style.bold).toBe(true);

    const docxData = await doc.exportData('docx');
    const docxFile = new File([docxData], 'test.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    await scribe.terminate();
    doc = await scribe.openDocument([docxFile]);

    let foundBoldWord = false;
    for (const page of doc.ocr.active) {
      for (const line of page.lines) {
        for (const word of line.words) {
          if (word.style.bold) {
            foundBoldWord = true;
            break;
          }
        }
        if (foundBoldWord) break;
      }
      if (foundBoldWord) break;
    }

    expect(foundBoldWord).toBe(true);
  });

  test('Italic styles are preserved in round-trip', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.xml`]);

    const originalItalicWord = doc.ocr.active[0].lines[30].words[0];
    expect(originalItalicWord.style.italic, 'fixture word must be italic for the style round-trip to be meaningful').toBe(true);

    // A run word currently cannot arise from ABBYY import, which splits words at style changes.
    originalItalicWord.styleRuns = [{ i: 3, style: { italic: false } }];

    const docxData = await doc.exportData('docx');
    const docxFile = new File([docxData], 'test.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    await scribe.terminate();
    doc = await scribe.openDocument([docxFile]);

    let foundItalicWord = false;
    for (const page of doc.ocr.active) {
      for (const line of page.lines) {
        for (const word of line.words) {
          if (word.style.italic) {
            foundItalicWord = true;
            break;
          }
        }
        if (foundItalicWord) break;
      }
      if (foundItalicWord) break;
    }

    expect(foundItalicWord, 'no italic word survived the docx round-trip').toBe(true);

    const wordMixed = doc.ocr.active[0].lines[24].words[2];
    expect(wordMixed.text, 'planted mixed-style word changed on docx round-trip').toBe('Inc.');
    expect(wordMixed.style.italic, 'italic base style lost on docx round-trip').toBe(true);
    expect(wordMixed.styleRuns, 'intra-word style run lost on docx round-trip').toEqual([{ i: 3, style: { italic: false } }]);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check that combined bold + italic is preserved in docx round-trip.', () => {
  test('Word with both bold and italic survives round-trip with both flags set', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/testocr.abbyy.xml`]);

    const targetWord = doc.ocr.active[0].lines[0].words[0];
    targetWord.style.bold = true;
    targetWord.style.italic = true;

    const docxData = await doc.exportData('docx');
    const docxFile = new File([docxData], 'test.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    await scribe.terminate();
    doc = await scribe.openDocument([docxFile]);

    let foundBoldItalic = false;
    for (const page of doc.ocr.active) {
      for (const line of page.lines) {
        for (const word of line.words) {
          if (word.style.bold && word.style.italic) {
            foundBoldItalic = true;
            break;
          }
        }
        if (foundBoldItalic) break;
      }
      if (foundBoldItalic) break;
    }

    expect(foundBoldItalic).toBe(true);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check that small caps are preserved in docx round-trip.', () => {
  test('Small caps style is preserved in round-trip', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/econometrica_example.abbyy.xml`]);

    const originalSmallCapsWord = doc.ocr.active[0].lines[4].words[0];
    const originalText = originalSmallCapsWord.text;

    const docxData = await doc.exportData('docx');
    const docxFile = new File([docxData], 'test.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    await scribe.terminate();
    doc = await scribe.openDocument([docxFile]);

    let foundSmallCapsWord = false;
    for (const page of doc.ocr.active) {
      for (const line of page.lines) {
        for (const word of line.words) {
          if (word.style.smallCaps) {
            foundSmallCapsWord = true;
            break;
          }
        }
        if (foundSmallCapsWord) break;
      }
      if (foundSmallCapsWord) break;
    }

    expect(foundSmallCapsWord).toBe(true);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check multi-page docx import.', () => {
  test('Should correctly handle multi-page documents', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/CSF_Proposed_Budget_Book_June_2024_r8_30_all_orientations.abbyy.xml`]);

    const originalPageCount = doc.ocr.active.length;

    const docxData = await doc.exportData('docx');
    const docxFile = new File([docxData], 'test.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    await scribe.terminate();
    doc = await scribe.openDocument([docxFile]);

    expect(doc.ocr.active.length > 0).toBe(true);

    for (const page of doc.ocr.active) {
      expect(page.lines.length > 0 || doc.ocr.active.indexOf(page) > 0).toBe(true);
    }
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check that font families are preserved in docx round-trip.', () => {
  test('Font family is preserved in round-trip', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/testocr.abbyy.xml`]);

    const originalFontWord = doc.ocr.active[0].lines[0].words[0];
    const originalFont = originalFontWord.style.font;
    expect(originalFont).not.toBeNull();
    expect(typeof originalFont).toBe('string');

    const docxData = await doc.exportData('docx');
    const docxFile = new File([docxData], 'test.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    await scribe.terminate();
    doc = await scribe.openDocument([docxFile]);

    let foundFontWord = false;
    for (const page of doc.ocr.active) {
      for (const line of page.lines) {
        for (const word of line.words) {
          if (word.style.font) {
            foundFontWord = true;
            expect(word.style.font).toBe(originalFont);
            break;
          }
        }
        if (foundFontWord) break;
      }
      if (foundFontWord) break;
    }

    expect(foundFontWord).toBe(true);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check iris.docx import extracts footnotes and paragraph types.', () => {
  test('Should extract correct number of footnotes from iris.docx', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/iris.docx`]);

    let footnoteCount = 0;
    for (const page of doc.ocr.active) {
      for (const par of page.pars) {
        if (par.type === 'footnote') {
          footnoteCount++;
        }
      }
    }

    expect(footnoteCount).toBe(13);
  });

  test('Should identify first paragraph as title with correct ID and text', async () => {
    const firstPar = doc.ocr.active[0].pars[0];

    expect(firstPar.type).toBe('title');
    // Verify paragraph ID matches Word's w14:paraId
    expect(firstPar.id).toBe('30416D11');
    // Verify title text content
    const titleText = scribe.utils.ocr.getParText(firstPar);
    expect(titleText).toBe('Iris (plant)');
  });

  test('Should parse title text as 28pt in iris.docx', async () => {
    const firstPar = doc.ocr.active[0].pars[0];
    const firstWord = firstPar.lines[0].words[0];

    expect(firstWord.text).toBe('Iris');
    expect(firstWord.style.size).toBe(28);
  });

  test('Should parse title font as Gill Sans in iris.docx', async () => {
    const firstPar = doc.ocr.active[0].pars[0];
    const firstWord = firstPar.lines[0].words[0];

    expect(firstWord.text).toBe('Iris');
    expect(firstWord.style.font).toBe('Gill Sans');
  });

  test('Should parse level 2 heading font as Arial in iris.docx', async () => {
    const overviewPar = doc.ocr.active[0].pars.find((par) => par.id === '63BCB147');
    expect(overviewPar).not.toBeNull();

    const firstWord = overviewPar.lines[0].words[0];
    expect(firstWord.text).toBe('Overview');
    expect(firstWord.style.font).toBe('Arial');
  });

  test('Should parse body text as 10pt in iris.docx', async () => {
    const bodyPar = doc.ocr.active[0].pars.find((par) => par.id === '38168435');

    expect(bodyPar).not.toBeNull();
    expect(bodyPar.type).toBe('body');
    const bodyWord = bodyPar.lines[0].words[0];
    expect(bodyWord.text).toBe('Iris');
    expect(bodyWord.style.size).toBe(10);
  });

  test('Should save Word style name in debug.sourceStyle', async () => {
    const titlePar = doc.ocr.active[0].pars[0];
    expect(titlePar.debug.sourceStyle).toBe('Heading1Legal1');

    const bodyPar = doc.ocr.active[0].pars.find((par) => par.id === '38168435');
    expect(bodyPar.debug.sourceStyle).toBe('ParaLegal1');

    const footnotePar = doc.ocr.active[0].pars.find((par) => par.id === '11821BFA');
    expect(footnotePar.debug.sourceStyle).toBe('FootnoteText');
  });

  test('Should parse first footnote with correct ID and text', async () => {
    const footnotePar = doc.ocr.active[0].pars.find((par) => par.id === '11821BFA');

    expect(footnotePar).not.toBeNull();
    expect(footnotePar.type).toBe('footnote');

    const footnoteText = scribe.utils.ocr.getParText(footnotePar);
    expect(footnoteText.includes('Iris Tourn. ex L.')).toBe(true);

    const footnoteWord = footnotePar.lines[0].words.find((w) => !w.style.sup);
    expect(footnoteWord.style.size).toBe(10);
  });

  test('Should link first footnote reference to first footnote paragraph', async () => {
    const footnotePar = doc.ocr.active[0].pars.find((par) => par.id === '11821BFA');
    expect(footnotePar).not.toBeNull();

    expect(footnotePar.footnoteRefId).not.toBeNull();

    // Find the reference word and verify bidirectional link
    const refWord = scribe.utils.ocr.getPageWord(footnotePar.page, footnotePar.footnoteRefId);
    expect(refWord).not.toBeNull();
    expect(refWord.text).toBe('1');
    expect(refWord.style.sup).toBe(true);
    expect(refWord.footnoteParId).toBe('11821BFA');
    expect(refWord.style.font, 'a footnote reference must take the font of its paragraph, as the words around it do').toBe('Century');
    expect(refWord.style.size, 'a footnote reference must take the font size of its paragraph, as the words around it do').toBe(10);
  });

  test('Should identify all 13 footnote reference words', async () => {
    const footnoteRefWords = [];
    for (const page of doc.ocr.active) {
      for (const line of page.lines) {
        for (const word of line.words) {
          if (word.footnoteParId !== null) {
            footnoteRefWords.push(word);
          }
        }
      }
    }

    expect(footnoteRefWords.length).toBe(13);

    for (const word of footnoteRefWords) {
      expect(word.style.sup).toBe(true);
    }

    expect(footnoteRefWords[0].text).toBe('1');
  });

  test('Should set marker on footnote paragraphs', async () => {
    const footnotePars = [];
    for (const page of doc.ocr.active) {
      for (const par of page.pars) {
        if (par.type === 'footnote') {
          footnotePars.push(par);
        }
      }
    }

    expect(footnotePars.length).toBe(13);

    for (const par of footnotePars) {
      expect(par.marker).not.toBeNull();
      expect(par.marker).toMatch(/^\d+$/);
    }

    const firstFootnote = doc.ocr.active[0].pars.find((par) => par.id === '11821BFA');
    expect(firstFootnote.marker).toBe('1');
  });

  test('Should set marker on numbered body paragraphs', async () => {
    const bodyPar = doc.ocr.active[0].pars.find((par) => par.id === '38168435');
    expect(bodyPar).not.toBeNull();
    expect(bodyPar.marker).toBe('1.1');

    const parText = scribe.utils.ocr.getParText(bodyPar);
    expect(parText.startsWith('1.1')).toBe(false);
    expect(parText.startsWith('Iris')).toBe(true);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check iris.docx footnote data survives .scribe export/import round-trip.', () => {
  test('Should preserve footnote count after .scribe round-trip', async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/iris.docx`]);

    const scribeData = await doc.exportData('scribe');
    await scribe.terminate();
    doc = await scribe.openDocument({ scribeFiles: [scribeData] });

    let footnoteCountAfter = 0;
    for (const page of doc.ocr.active) {
      for (const par of page.pars) {
        if (par.type === 'footnote') footnoteCountAfter++;
      }
    }
    expect(footnoteCountAfter).toBe(13);
  });

  test('Should preserve paragraph IDs after .scribe round-trip', async () => {
    const titlePar = doc.ocr.active[0].pars.find((par) => par.id === '30416D11');
    expect(titlePar).not.toBeNull();
    expect(titlePar.type).toBe('title');

    const bodyPar = doc.ocr.active[0].pars.find((par) => par.id === '38168435');
    expect(bodyPar).not.toBeNull();
    expect(bodyPar.type).toBe('body');

    const footnotePar = doc.ocr.active[0].pars.find((par) => par.id === '11821BFA');
    expect(footnotePar).not.toBeNull();
    expect(footnotePar.type).toBe('footnote');
  });

  test('Should preserve footnote bidirectional links after .scribe round-trip', async () => {
    const footnotePar = doc.ocr.active[0].pars.find((par) => par.id === '11821BFA');
    expect(footnotePar).not.toBeNull();
    expect(footnotePar.footnoteRefId).not.toBeNull();

    const refWord = scribe.utils.ocr.getPageWord(footnotePar.page, footnotePar.footnoteRefId);
    expect(refWord).not.toBeNull();
    expect(refWord.text).toBe('1');
    expect(refWord.footnoteParId).toBe('11821BFA');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check Word footnote marks and inline run content are imported as Word prints them.', () => {
  /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
  let wordDoc;
  /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
  let shapesDoc;

  /**
   * @param {import('../../js/containers/scribeDoc.js').ScribeDoc} source
   * @param {number} parIndex
   */
  const parWords = (source, parIndex) => source.ocr.active[0].pars[parIndex].lines.flatMap((line) => line.words);

  /**
   * @param {import('../../js/containers/scribeDoc.js').ScribeDoc} source
   * @param {import('../../js/objects/ocrObjects.js').OcrWord} word
   */
  const noteOf = (source, word) => source.ocr.active[0].pars.find((par) => par.id === word.footnoteParId);

  beforeAll(async () => {
    wordDoc = await scribe.openDocument([`${ASSETS_PATH}/footnotes_custom_marks.docx`]);

    // Shapes the Word-authored fixture does not hold.
    const ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const refStyle = '<w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr>';
    const symbolStar = '<w:sym w:font="Symbol" w:char="F02A"/>';
    const webdings = '<w:sym w:font="Webdings" w:char="F06E"/>';
    /** @param {string} text */
    const textRun = (text) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
    /** @param {number} id */
    const autoRef = (id) => `<w:r>${refStyle}<w:footnoteReference w:id="${id}"/></w:r>`;
    /**
     * @param {number} id
     * @param {string} mark
     */
    const customRef = (id, mark) => `<w:r>${refStyle}<w:footnoteReference w:customMarkFollows="1" w:id="${id}"/>${mark}</w:r>`;
    /**
     * @param {number} id
     * @param {string} runs
     */
    const note = (id, runs) => `<w:footnote w:id="${id}"><w:p>${runs}</w:p></w:footnote>`;
    const autoMark = `<w:r>${refStyle}<w:footnoteRef/></w:r>`;
    /** @param {string} mark */
    const markRun = (mark) => `<w:r>${refStyle}${mark}</w:r>`;

    const body = [
      `${textRun('Styled opener')}${autoRef(1)}${textRun(' end.')}`,
      `${textRun('Shared run')}${autoRef(2)}${textRun(' end.')}`,
      `${textRun('Split mark')}${customRef(3, '')}${markRun('')}${markRun('<w:t>‡</w:t>')}${textRun(' end.')}`,
      `${textRun('Merged mark')}${customRef(4, '<w:t>†</w:t>')}${textRun(' end.')}`,
      `${textRun('Comma mark')}${customRef(5, '<w:t>*,</w:t>')}${textRun(' then end.')}`,
      `${textRun('Mixed mark')}${customRef(6, '')}${markRun(symbolStar)}${textRun(' end.')}`,
      `${textRun('Empty mark')}${customRef(7, '')}${textRun(', then end.')}`,
      `${textRun('Blank mark')}${customRef(8, '<w:t xml:space="preserve"> </w:t>')}${textRun('then end.')}`,
      `${textRun('Webdings mark')}${customRef(9, webdings)}${textRun('. Next sentence.')}`,
      `${textRun('On mark')}<w:r>${refStyle}<w:footnoteReference w:customMarkFollows="on" w:id="10"/><w:t>§</w:t></w:r>${textRun(' end.')}`,
      '<w:r><w:t>Before</w:t><w:footnoteReference w:id="11"/><w:t xml:space="preserve"> after.</w:t></w:r>',
      `${textRun('One')}${autoRef(12)}${textRun(' two')}${autoRef(12)}${textRun(' end.')}`,
      `${textRun('Numbered note ')}${customRef(13, '')}${textRun('See below.')}`,
      '<w:r><w:t xml:space="preserve">Symbols </w:t><w:sym w:font="Wingdings" w:char="F0FC"/><w:t xml:space="preserve"> </w:t><w:sym w:font="Calibri" w:char="2020"/><w:cr/><w:t>next</w:t></w:r>',
      `${textRun('Order')}<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>1</w:t></w:r>${customRef(14, '<w:t>¶</w:t>')}${textRun(' end.')}`,
    ].map((runs) => `<w:p>${runs}</w:p>`).join('');
    const notes = [
      note(1, `${autoMark}<w:r>${refStyle}<w:t xml:space="preserve"> See</w:t></w:r>${textRun(' Smith at 12.')}`),
      note(2, '<w:r><w:footnoteRef/><w:t xml:space="preserve"> Shared run note.</w:t></w:r>'),
      note(3, `${markRun('<w:t>‡</w:t>')}${textRun(' Split note.')}`),
      note(4, textRun('† Merged note.')),
      note(5, `${markRun('<w:t>*</w:t>')}${textRun(' Comma note.')}`),
      note(6, `${markRun('<w:t>*</w:t>')}${textRun(' Mixed note.')}`),
      note(7, textRun('Empty-mark note.')),
      note(8, `${markRun('<w:t xml:space="preserve"> </w:t>')}${textRun('Blank-mark note.')}`),
      note(9, `${markRun(webdings)}${textRun(' Webdings note.')}`),
      note(10, `${markRun('<w:t>§</w:t>')}${textRun(' On note.')}`),
      note(11, `${autoMark}${textRun(' Shared reference run note.')}`),
      note(12, `${autoMark}${textRun(' Twice referenced note.')}`),
      note(13, `${autoMark}${textRun(' See Smith at 12.')}`),
      note(14, `${markRun('<w:t>¶</w:t>')}${textRun(' Order note.')}`),
    ].join('');

    const { Uint8ArrayWriter, TextReader, ZipWriter } = await import('../../lib/zip.js/index.js');
    const zipWriter = new ZipWriter(new Uint8ArrayWriter());
    await zipWriter.add('word/document.xml', new TextReader(`<w:document ${ns}><w:body>${body}</w:body></w:document>`));
    await zipWriter.add('word/footnotes.xml', new TextReader(`<w:footnotes ${ns}>${notes}</w:footnotes>`));
    const shapesData = await zipWriter.close();
    shapesDoc = await scribe.openDocument([new File([shapesData], 'footnote_shapes.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })]);
  });

  test('A custom mark keeps its symbol and takes no number in footnotes_custom_marks.docx', async () => {
    const authorWords = parWords(wordDoc, 0);
    expect(authorWords.map((w) => w.text), 'a custom mark and the superscript text after it must import as separate words')
      .toEqual(['Erik', 'Jones', 'and', 'Meg', 'Tong', '*', '1', 'wrote', 'this.']);
    const star = authorWords[5];
    expect(star.style.sup, 'a custom mark must import as a superscript word').toBe(true);
    const starNote = noteOf(wordDoc, star);
    expect(starNote?.type, 'a custom mark must link to its footnote').toBe('footnote');
    expect(starNote?.marker, 'a custom-marked footnote must carry its mark as its label').toBe('*');
    expect(starNote && scribe.utils.ocr.getParText(starNote), 'a custom-marked footnote must not repeat its mark in its text').toBe('Equal contribution.');
    expect(starNote?.footnoteRefId, 'a custom-marked footnote must link back to its mark').toBe(star.id);
    expect(authorWords[6].style.sup, 'superscript text after a custom mark must stay superscript').toBe(true);
    expect(authorWords[6].footnoteParId, 'superscript text after a custom mark is not a footnote reference').toBe(null);

    const sharmaWords = parWords(wordDoc, 1);
    expect(sharmaWords.map((w) => w.text), 'the first numbered footnote must be numbered 1, since a custom mark takes no number')
      .toEqual(['Mrinank', 'Sharma', '1', 'led', 'the', 'study.']);
    const firstNote = noteOf(wordDoc, sharmaWords[2]);
    expect(firstNote && scribe.utils.ocr.getParText(firstNote), 'the first numbered reference must link to the first numbered footnote').toBe('First numbered note.');
    expect(wordDoc.ocr.active[0].pars.filter((par) => par.type === 'footnote').map((par) => par.marker), 'the footnotes must carry the marks Word prints, in reference order')
      .toEqual(['*', '1', '2', '3', '\u2217', '†', '4', '5', '6']);
  });

  test('An auto-numbered footnote keeps text set in the reference style in footnotes_custom_marks.docx', async () => {
    const seeNote = noteOf(wordDoc, parWords(wordDoc, 2)[2]);
    expect(seeNote?.marker, 'the second numbered reference must link to the footnote numbered 2').toBe('2');
    expect(seeNote && scribe.utils.ocr.getParText(seeNote), 'a numbered footnote must keep a word set in the reference style').toBe('See Smith at 12.');
    const wholeNote = noteOf(wordDoc, parWords(wordDoc, 3)[3]);
    expect(wholeNote?.marker, 'the third numbered reference must link to the footnote numbered 3').toBe('3');
    expect(wholeNote && scribe.utils.ocr.getParText(wholeNote), 'a numbered footnote set wholly in the reference style must keep its text').toBe('Whole note in reference style.');
  });

  test('A custom mark from the Symbol font and one before a comma are read in footnotes_custom_marks.docx', async () => {
    const symbolWords = parWords(wordDoc, 4);
    expect(symbolWords.map((w) => w.text), 'a custom mark picked from the Symbol font must import as the character it prints')
      .toEqual(['Symbol', 'mark', 'check', '\u2217', 'after', 'symbol.']);
    const symbolNote = noteOf(wordDoc, symbolWords[3]);
    expect(symbolNote?.marker, 'a footnote marked from the Symbol font must carry the decoded mark as its label').toBe('\u2217');
    expect(symbolNote && scribe.utils.ocr.getParText(symbolNote), 'a footnote marked from the Symbol font must not repeat its mark in its text').toBe('Symbol-font custom note.');

    const daggerWords = parWords(wordDoc, 5);
    expect(daggerWords.map((w) => w.text), 'a comma after a custom mark must stay in the body text')
      .toEqual(['Punctuated', 'claim', '†', ',', 'and', 'the', 'rest.']);
    const daggerNote = noteOf(wordDoc, daggerWords[2]);
    expect(daggerNote?.marker, 'a custom mark before a comma must be the label of its footnote').toBe('†');
    expect(daggerNote && scribe.utils.ocr.getParText(daggerNote), 'a custom mark before a comma must link to its footnote').toBe('Dagger note before comma.');
  });

  test('Adjacent footnote references stay separate words in footnotes_custom_marks.docx', async () => {
    const anchorWords = parWords(wordDoc, 6);
    expect(anchorWords.map((w) => w.text), 'the numbered footnote after three custom marks must be numbered 4')
      .toEqual(['Unnumbered', 'note', 'anchor', '4', 'end.']);
    const anchorNote = noteOf(wordDoc, anchorWords[3]);
    expect(anchorNote && scribe.utils.ocr.getParText(anchorNote), 'the fourth numbered reference must link to its footnote').toBe('Unnumbered copyright note.');

    const pairWords = parWords(wordDoc, 7);
    expect(pairWords.map((w) => w.text), 'two adjacent footnote references must import as two words')
      .toEqual(['Adjacent', 'pair', '5', '6', 'done.']);
    const earlierNote = noteOf(wordDoc, pairWords[2]);
    const laterNote = noteOf(wordDoc, pairWords[3]);
    expect(earlierNote && scribe.utils.ocr.getParText(earlierNote), 'the first of two adjacent references must link to its own footnote').toBe('Earlier paired note.');
    expect(laterNote && scribe.utils.ocr.getParText(laterNote), 'the second of two adjacent references must link to its own footnote').toBe('Later paired note.');
  });

  test('A tab, a line break, a non-breaking hyphen and a symbol are read as printed in footnotes_custom_marks.docx', async () => {
    // The Wingdings run that ends the paragraph is not decoded, so it is left out.
    expect(parWords(wordDoc, 8).slice(0, 10).map((w) => w.text), 'a tab and a line break must separate words, and a non-breaking hyphen and a symbol must be kept')
      .toEqual(['Label', 'Value', '|', 'FirstLine', 'SecondLine', '|', 'non-breaking', '|', 'Symbol:', 'α']);
  });

  test('An auto-numbered footnote keeps its text whatever run its number shares', async () => {
    const styledNote = noteOf(shapesDoc, parWords(shapesDoc, 0)[2]);
    expect(styledNote?.marker, 'a numbered reference must link to the footnote numbered 1').toBe('1');
    expect(styledNote && scribe.utils.ocr.getParText(styledNote), 'a numbered footnote must keep a word set in the reference style directly after its number').toBe('See Smith at 12.');
    const sharedWords = parWords(shapesDoc, 1);
    expect(sharedWords.map((w) => w.text), 'a footnote whose number shares a run with its text must keep its reference').toEqual(['Shared', 'run', '2', 'end.']);
    const sharedNote = noteOf(shapesDoc, sharedWords[2]);
    expect(sharedNote && scribe.utils.ocr.getParText(sharedNote), 'a footnote whose number shares a run with its text must keep that text').toBe('Shared run note.');
  });

  test('A custom mark is read from the next run, from a shared text run and beside punctuation', async () => {
    const splitWords = parWords(shapesDoc, 2);
    expect(splitWords.map((w) => w.text), 'a custom mark in the next run that prints anything must import as the reference word').toEqual(['Split', 'mark', '‡', 'end.']);
    const splitNote = noteOf(shapesDoc, splitWords[2]);
    expect(splitNote?.marker, 'a custom mark in the next run that prints anything must be the label of its footnote').toBe('‡');
    expect(splitNote && scribe.utils.ocr.getParText(splitNote), 'a custom mark in the next run that prints anything must leave the footnote text').toBe('Split note.');

    const mergedNote = noteOf(shapesDoc, parWords(shapesDoc, 3)[2]);
    expect(mergedNote?.marker, 'a footnote whose mark shares a run with its text must carry the mark as its label').toBe('†');
    expect(mergedNote && scribe.utils.ocr.getParText(mergedNote), 'a footnote whose mark shares a run with its text must lose the mark alone').toBe('Merged note.');

    const commaWords = parWords(shapesDoc, 4);
    expect(commaWords.map((w) => w.text), 'a comma typed in the run of a custom mark must stay in the body text').toEqual(['Comma', 'mark', '*', ',', 'then', 'end.']);
    const commaNote = noteOf(shapesDoc, commaWords[2]);
    expect(commaNote?.marker, 'a comma typed in the run of a custom mark must not join the label of its footnote').toBe('*');
    expect(commaNote && scribe.utils.ocr.getParText(commaNote), 'a custom mark typed before a comma must leave the footnote text').toBe('Comma note.');

    const mixedWords = parWords(shapesDoc, 5);
    expect(mixedWords.map((w) => w.text), 'a picked asterisk in the run after its reference must be read as the mark of a footnote that opens with a typed one')
      .toEqual(['Mixed', 'mark', '\u2217', 'end.']);
    const mixedNote = noteOf(shapesDoc, mixedWords[2]);
    expect(mixedNote?.marker, 'a picked asterisk must be the label of a footnote that opens with a typed one').toBe('\u2217');
    expect(mixedNote && scribe.utils.ocr.getParText(mixedNote), 'a typed asterisk must leave the text of a footnote marked with a picked one').toBe('Mixed note.');

    const onWords = parWords(shapesDoc, 9);
    expect(onWords.map((w) => w.text), 'customMarkFollows="on" must be read as a custom mark').toEqual(['On', 'mark', '§', 'end.']);
    expect(noteOf(shapesDoc, onWords[2])?.marker, 'a footnote marked under customMarkFollows="on" must carry its mark as its label').toBe('§');
  });

  test('A custom mark that cannot be read leaves no reference word and takes no number', async () => {
    expect(parWords(shapesDoc, 6).map((w) => w.text), 'a comma after a missing custom mark must stay with the word before it').toEqual(['Empty', 'mark,', 'then', 'end.']);
    expect(parWords(shapesDoc, 7).map((w) => w.text), 'a blank custom mark must leave no reference word and keep its words apart').toEqual(['Blank', 'mark', 'then', 'end.']);
    expect(parWords(shapesDoc, 8).map((w) => w.text), 'a period after an unreadable custom mark must stay with the word before it').toEqual(['Webdings', 'mark.', 'Next', 'sentence.']);

    const notes = shapesDoc.ocr.active[0].pars.filter((par) => par.type === 'footnote');
    expect(notes.map((par) => par.marker), 'a footnote whose custom mark cannot be read must have no label, and must take no number from the numbered footnotes')
      .toEqual(['1', '2', '‡', '†', '*', '\u2217', null, null, null, '§', '3', '4', null, '¶']);
    expect(notes.slice(6, 9).map((par) => par.footnoteRefId), 'a footnote whose custom mark cannot be read must have no reference word').toEqual([null, null, null]);
    expect(notes.slice(6, 9).map((par) => scribe.utils.ocr.getParText(par)), 'a footnote whose custom mark cannot be read must keep its text')
      .toEqual(['Empty-mark note.', 'Blank-mark note.', 'Webdings note.']);

    // The body text after the reference and the note both open with "See".
    // The note prints a number of its own, so that word is no mark.
    const bodyWords = parWords(shapesDoc, 12);
    expect(bodyWords.map((w) => w.text), 'body text after a reference with no mark must stay in the body').toEqual(['Numbered', 'note', 'See', 'below.']);
    expect(bodyWords[2].footnoteParId, 'body text must not become the reference of a footnote that prints its own number').toBe(null);
    expect(bodyWords[2].style.sup, 'body text after a reference with no mark must not become superscript').toBe(false);
    expect(scribe.utils.ocr.getParText(notes[12]), 'a footnote that prints its own number must keep the word it opens with').toBe('See Smith at 12.');
    expect(notes[12].footnoteRefId, 'a footnote whose reference has no mark must have no reference word').toBe(null);
  });

  test('Text beside a reference in one run is kept, and every reference to a footnote links to it', async () => {
    const besideWords = parWords(shapesDoc, 10);
    expect(besideWords.map((w) => w.text), 'text on both sides of a reference in one run must be kept').toEqual(['Before', '3', 'after.']);
    const besideNote = noteOf(shapesDoc, besideWords[1]);
    expect(besideNote && scribe.utils.ocr.getParText(besideNote), 'a reference that shares a run with text must link to its footnote').toBe('Shared reference run note.');

    const twiceWords = parWords(shapesDoc, 11);
    expect(twiceWords.map((w) => w.text), 'two references to one footnote must both print its number').toEqual(['One', '4', 'two', '4', 'end.']);
    const twiceNote = noteOf(shapesDoc, twiceWords[1]);
    expect(twiceNote && scribe.utils.ocr.getParText(twiceNote), 'the first reference to a footnote must link to it').toBe('Twice referenced note.');
    expect(twiceWords[3].footnoteParId, 'the second reference to a footnote must link to it too').toBe(twiceNote?.id);
    expect(twiceNote?.footnoteRefId, 'a footnote referenced twice must link back to its first reference').toBe(twiceWords[1].id);
  });

  test('A reference directly after superscript text stays a word of its own', async () => {
    const orderWords = parWords(shapesDoc, 14);
    expect(orderWords.map((w) => w.text), 'a reference must not join superscript text before it').toEqual(['Order', '1', '¶', 'end.']);
    expect(orderWords[1].footnoteParId, 'superscript text before a reference is not a footnote reference').toBe(null);
    expect(noteOf(shapesDoc, orderWords[2])?.marker, 'a reference after superscript text must link to its footnote').toBe('¶');
  });

  test('A Wingdings symbol, a symbol stored at its own code and a carriage return are read as printed', async () => {
    expect(parWords(shapesDoc, 13).map((w) => w.text), 'a Wingdings symbol and a symbol stored at its own code must be decoded, and a carriage return must separate words')
      .toEqual(['Symbols', '✓', '†', 'next']);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('parseParagraphs handles footnote references whose target is missing.', () => {
  test('Should not emit a "0" marker when the referenced footnote is absent from footnotes.xml', () => {
    const docXml = '<w:document><w:body>'
      + '<w:p w14:paraId="AAAA1111">'
      + '<w:r><w:t>Before </w:t></w:r>'
      + '<w:r><w:footnoteReference w:id="2"/></w:r>'
      + '<w:r><w:t> after.</w:t></w:r>'
      + '</w:p>'
      + '</w:body></w:document>';

    const paragraphs = parseParagraphs(docXml, new Map());

    expect(paragraphs.length).toBe(1);
    const markerRun = paragraphs[0].runs.find((r) => r.footnoteId === '2');
    expect(markerRun).toBeUndefined();
  });

  test('Should not shift numbering of subsequent footnotes when one is missing', () => {
    const docXml = '<w:document><w:body>'
      + '<w:p w14:paraId="AAAA1111">'
      + '<w:r><w:footnoteReference w:id="1"/></w:r>'
      + '<w:r><w:t> middle </w:t></w:r>'
      + '<w:r><w:footnoteReference w:id="2"/></w:r>'
      + '<w:r><w:t> tail </w:t></w:r>'
      + '<w:r><w:footnoteReference w:id="3"/></w:r>'
      + '</w:p>'
      + '</w:body></w:document>';

    const styles = {
      bold: false,
      italic: false,
      smallCaps: false,
      underline: false,
      sup: false,
      font: null,
      fontSize: null,
    };
    const footnotesMap = new Map([
      ['1', { runs: [{ text: 'first', styles }], paraId: 'F1' }],
      ['3', { runs: [{ text: 'third', styles }], paraId: 'F3' }],
    ]);

    const paragraphs = parseParagraphs(docXml, footnotesMap);

    const bodyPar = paragraphs.find((p) => p.type === 'body');
    if (!bodyPar) throw new Error('expected a body paragraph');
    const markerRuns = bodyPar.runs.filter((r) => r.footnoteId !== undefined);
    expect(markerRuns.length).toBe(2);
    expect(markerRuns[0].footnoteId).toBe('1');
    expect(markerRuns[0].text).toBe('1');
    expect(markerRuns[1].footnoteId).toBe('3');
    expect(markerRuns[1].text).toBe('2');

    const footnotePars = paragraphs.filter((p) => p.type === 'footnote');
    expect(footnotePars.length).toBe(2);
    expect(footnotePars[0].footnoteId).toBe('1');
    expect(footnotePars[0].footnoteIndex).toBe(1);
    expect(footnotePars[1].footnoteId).toBe('3');
    expect(footnotePars[1].footnoteIndex).toBe(2);
  });
});
