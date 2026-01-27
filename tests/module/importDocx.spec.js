// Relative imports are required to run in browser.
/* eslint-disable import/no-relative-packages */
import { assert, config } from '../../node_modules/chai/chai.js';
import scribe from '../../scribe.js';
import { ASSETS_PATH_KARMA } from '../constants.js';

config.truncateThreshold = 0; // Disable truncation for actual/expected values on assertion failure.

// Using arrow functions breaks references to `this`.
/* eslint-disable prefer-arrow-callback */
/* eslint-disable func-names */

// Skip tests prior to Node.js EOL (20.x) where the native File class is available.
// While the library should be compatible with earlier versions of Node.js,
// getting every test to run on versions that are already EOL is not a priority.
const itSkipNodeEOL = typeof process === 'undefined' || parseInt(process.versions.node.split('.')[0]) >= 20 ? it : xit;

describe('Check docx import function.', function () {
  this.timeout(10000);

  itSkipNodeEOL('Should import docx file', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/testocr.abbyy.xml`]);
    const docxData = await scribe.exportData('docx');

    await scribe.terminate();

    const docxFile = new File([docxData], 'test.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    await scribe.importFiles([docxFile]);
  });

  itSkipNodeEOL('Should correctly import text content from docx', async () => {
    const text1 = scribe.data.ocr.active[0].lines[0].words.map((x) => x.text).join(' ');

    assert.include(text1, 'This is a lot of 12 point text');
  }).timeout(10000);

  itSkipNodeEOL('Should correctly import paragraphs from docx', async () => {
    assert.isTrue(scribe.data.ocr.active[0].lines.length > 0);
    assert.isTrue(scribe.data.ocr.active[0].pars.length > 0);
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check export -> import round-trip for docx files.', function () {
  this.timeout(10000);

  itSkipNodeEOL('Exporting and importing docx should preserve text content', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/testocr.abbyy.xml`]);

    const originalText = scribe.data.ocr.active.map((page) => page.lines.map((line) => line.words.map((word) => word.text).join(' ')).join('\n')).join('\n\n');

    const docxData = await scribe.exportData('docx');
    const docxFile = new File([docxData], 'test.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    await scribe.terminate();
    await scribe.importFiles([docxFile]);

    const importedText = scribe.data.ocr.active.map((page) => page.lines.map((line) => line.words.map((word) => word.text).join(' ')).join('\n')).join('\n\n');

    assert.include(importedText, 'This is a lot of 12 point text');
    assert.include(importedText, 'The quick brown dog jumped');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check that font styles are preserved in docx round-trip.', function () {
  this.timeout(10000);

  itSkipNodeEOL('Bold style is preserved in round-trip', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/complaint_1.abbyy.xml`]);

    const originalBoldWord = scribe.data.ocr.active[1].lines[3].words[0];
    assert.isTrue(originalBoldWord.style.bold);

    const docxData = await scribe.exportData('docx');
    const docxFile = new File([docxData], 'test.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    await scribe.terminate();
    await scribe.importFiles([docxFile]);

    let foundBoldWord = false;
    for (const page of scribe.data.ocr.active) {
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

    assert.isTrue(foundBoldWord, 'Should have at least one bold word after round-trip');
  }).timeout(10000);

  itSkipNodeEOL('Italic style is preserved in round-trip', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.xml`]);

    const originalItalicWord = scribe.data.ocr.active[0].lines[30].words[0];
    assert.isTrue(originalItalicWord.style.italic);

    const docxData = await scribe.exportData('docx');
    const docxFile = new File([docxData], 'test.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    await scribe.terminate();
    await scribe.importFiles([docxFile]);

    let foundItalicWord = false;
    for (const page of scribe.data.ocr.active) {
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

    assert.isTrue(foundItalicWord, 'Should have at least one italic word after round-trip');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check that small caps are preserved in docx round-trip.', function () {
  this.timeout(10000);

  itSkipNodeEOL('Small caps style is preserved in round-trip', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/econometrica_example.abbyy.xml`]);

    const originalSmallCapsWord = scribe.data.ocr.active[0].lines[4].words[0];
    const originalText = originalSmallCapsWord.text;

    const docxData = await scribe.exportData('docx');
    const docxFile = new File([docxData], 'test.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    await scribe.terminate();
    await scribe.importFiles([docxFile]);

    let foundSmallCapsWord = false;
    for (const page of scribe.data.ocr.active) {
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

    assert.isTrue(foundSmallCapsWord, 'Should have at least one small caps word after round-trip');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check multi-page docx import.', function () {
  this.timeout(10000);

  itSkipNodeEOL('Should correctly handle multi-page documents', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/CSF_Proposed_Budget_Book_June_2024_r8_30_all_orientations.abbyy.xml`]);

    const originalPageCount = scribe.data.ocr.active.length;

    const docxData = await scribe.exportData('docx');
    const docxFile = new File([docxData], 'test.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    await scribe.terminate();
    await scribe.importFiles([docxFile]);

    assert.isTrue(scribe.data.ocr.active.length > 0);

    for (const page of scribe.data.ocr.active) {
      assert.isTrue(page.lines.length > 0 || scribe.data.ocr.active.indexOf(page) > 0);
    }
  }).timeout(20000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check that font families are preserved in docx round-trip.', function () {
  this.timeout(10000);

  itSkipNodeEOL('Font family is preserved in round-trip', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/testocr.abbyy.xml`]);

    const originalFontWord = scribe.data.ocr.active[0].lines[0].words[0];
    const originalFont = originalFontWord.style.font;
    assert.isNotNull(originalFont, 'Original word should have a font');
    assert.isString(originalFont, 'Font should be a string');

    const docxData = await scribe.exportData('docx');
    const docxFile = new File([docxData], 'test.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

    await scribe.terminate();
    await scribe.importFiles([docxFile]);

    let foundFontWord = false;
    for (const page of scribe.data.ocr.active) {
      for (const line of page.lines) {
        for (const word of line.words) {
          if (word.style.font) {
            foundFontWord = true;
            assert.strictEqual(word.style.font, originalFont, `Font should be preserved as "${originalFont}"`);
            break;
          }
        }
        if (foundFontWord) break;
      }
      if (foundFontWord) break;
    }

    assert.isTrue(foundFontWord, 'Should have at least one word with font family after round-trip');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check iris.docx import extracts footnotes and paragraph types.', function () {
  this.timeout(10000);

  itSkipNodeEOL('Should extract correct number of footnotes from iris.docx', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/iris.docx`]);

    let footnoteCount = 0;
    for (const page of scribe.data.ocr.active) {
      for (const par of page.pars) {
        if (par.type === 'footnote') {
          footnoteCount++;
        }
      }
    }

    assert.strictEqual(footnoteCount, 13, 'iris.docx should have 13 footnotes');
  }).timeout(10000);

  itSkipNodeEOL('Should identify first paragraph as title in iris.docx', async () => {
    const firstPar = scribe.data.ocr.active[0].pars[0];

    assert.strictEqual(firstPar.type, 'title', 'First paragraph should be identified as title');
  }).timeout(10000);

  itSkipNodeEOL('Should parse title text as 20pt in iris.docx', async () => {
    const firstPar = scribe.data.ocr.active[0].pars[0];
    const firstWord = firstPar.lines[0].words[0];

    assert.strictEqual(firstWord.style.size, 20, 'First title word should be 20pt');
  }).timeout(10000);

  itSkipNodeEOL('Should parse body text as 12pt in iris.docx', async () => {
    // Find first body paragraph
    let bodyPar = null;
    for (const par of scribe.data.ocr.active[0].pars) {
      if (par.type === 'body') {
        bodyPar = par;
        break;
      }
    }

    assert.isNotNull(bodyPar, 'Should have at least one body paragraph');
    const bodyWord = bodyPar.lines[0].words[0];
    assert.strictEqual(bodyWord.style.size, 12, 'Body text should be 12pt');
  }).timeout(10000);

  itSkipNodeEOL('Should parse footnote text as 10pt in iris.docx', async () => {
    // Find first footnote paragraph
    let footnotePar = null;
    for (const page of scribe.data.ocr.active) {
      for (const par of page.pars) {
        if (par.type === 'footnote') {
          footnotePar = par;
          break;
        }
      }
      if (footnotePar) break;
    }

    assert.isNotNull(footnotePar, 'Should have at least one footnote paragraph');
    // Skip the superscript number, check the actual footnote text
    const footnoteWord = footnotePar.lines[0].words.find((w) => !w.style.sup);
    assert.isNotNull(footnoteWord, 'Should have non-superscript text in footnote');
    assert.strictEqual(footnoteWord.style.size, 10, 'Footnote text should be 10pt');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);
