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

  test('Should set parNum on footnote paragraphs', async () => {
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
      expect(par.parNum).not.toBeNull();
      expect(par.parNum).toMatch(/^\d+$/);
    }

    const firstFootnote = doc.ocr.active[0].pars.find((par) => par.id === '11821BFA');
    expect(firstFootnote.parNum).toBe('1');
  });

  test('Should set parNum on numbered body paragraphs', async () => {
    const bodyPar = doc.ocr.active[0].pars.find((par) => par.id === '38168435');
    expect(bodyPar).not.toBeNull();
    expect(bodyPar.parNum).toBe('1.1');

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
