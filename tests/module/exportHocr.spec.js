import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

// Using arrow functions breaks references to `this`.

/**
 * @param {Array<OcrPage>} ocrArr
 */
const hocrView = (ocrArr) => ocrArr.map((page) => ({
  dims: page.dims,
  pars: page.pars.map((par) => ({ id: par.id, lines: par.lines.map((line) => line.id) })),
  lines: page.lines.map((line) => ({
    id: line.id,
    par: line.par ? line.par.id : null,
    bbox: [line.bbox.left, line.bbox.top, line.bbox.right, line.bbox.bottom].map(Math.round),
    baseline: [Number(line.baseline[0].toFixed(6)), Math.round(line.baseline[1])],
    ascHeight: line.ascHeight === null ? null : Number(line.ascHeight.toFixed(3)),
    xHeight: line.xHeight === null ? null : Number(line.xHeight.toFixed(3)),
    words: line.words.map((word) => ({
      id: word.id,
      text: word.text,
      lang: word.lang,
      conf: Math.round(word.conf),
      bbox: [word.bbox.left, word.bbox.top, word.bbox.right, word.bbox.bottom].map(Math.round),
      font: word.style.font,
      bold: word.style.bold,
      italic: word.style.italic,
      underline: word.style.underline,
      smallCaps: word.style.smallCaps,
      sup: word.style.sup,
      dropcap: word.style.dropcap,
    })),
  })),
}));

async function readFileContent(filePath) {
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    const fs = await import('node:fs/promises');
    return fs.readFile(filePath, 'utf-8');
  }
  const response = await fetch(filePath);
  return response.text();
}

/** @param {string} hocr */
const lineMarkup = (hocr) => hocr.match(/<span class='(?:ocr_line|ocr_caption)'[\s\S]+?(?:<\/span>\s*){2}/g) || [];
/** @param {string} hocr */
const lineOrder = (hocr) => [...hocr.matchAll(/class='ocr_(?:line|caption)' id='([^']+)'/g)].map((m) => m[1]);
/** @param {string} hocr */
const ocrSystem = (hocr) => hocr.match(/<meta name='ocr-system' content='([^']*)'/)?.[1];

describe('Check .hocr export of a document from another format.', () => {
  test('Exporting to .hocr and reimporting should restore OCR data without modification', async () => {
    const doc = await scribe.openDocument([`${ASSETS_PATH}/scribe_test_pdf1.abbyy.xml`]);
    // A drop cap's nested span once ended its line early on re-import.
    doc.ocr.active[0].lines[0].words[0].style.dropcap = true;

    const page0 = doc.ocr.active[0];
    const undone = page0.lines[0].words[1];
    const redone = page0.lines[12].words[0];
    expect([undone.text, undone.conf, redone.text, redone.conf], 'the two doubtful words these edits correct').toEqual(['grave.', 0, 't', 0]);
    doc.editWords([0], 'Edited word', () => { undone.text = 'tomb.'; undone.conf = 100; });
    expect(doc.docHistory.undoStack.at(-1)?.label, 'a word edit records one undo step under its label').toBe('Edited word');
    expect(doc.undo(), 'a word edit is undoable').toBe(true);
    expect([undone.text, undone.conf], 'undo restores the word\'s text and confidence').toEqual(['grave.', 0]);
    doc.editWords([page0], 'Edited word', () => { redone.text = 'to'; redone.conf = 100; });
    doc.undo();
    expect([redone.text, redone.conf], 'undoing the second edit restores its word').toEqual(['t', 0]);
    expect(doc.redo(), 'an undone word edit is redoable').toBe(true);
    expect([redone.text, redone.conf], 'redo re-applies the correction and its confidence').toEqual(['to', 100]);

    // The Export mode's role chips edit a paragraph's role through `editWords`, whose undo once left the role unchanged.
    const rolePar = page0.lines[0].par;
    expect([rolePar.type, rolePar.headingLevel], 'the first paragraph starts as body text').toEqual(['body', null]);
    doc.editWords([0], 'Paragraph role', () => { rolePar.type = 'title'; rolePar.headingLevel = 2; });
    expect(await doc.exportData('md', { pageArr: [0] }), 'a paragraph made a level-2 heading opens the Markdown export as one').toMatch(/^## /);
    expect(doc.undo(), 'a paragraph role edit is undoable').toBe(true);
    expect([rolePar.type, rolePar.headingLevel], 'undo restores the paragraph role').toEqual(['body', null]);
    expect(await doc.exportData('md', { pageArr: [0] }), 'the undone heading leaves the Markdown export').not.toMatch(/^## /);

    const view1 = hocrView(doc.ocr.active);

    const hocrOutStr = /** @type {string} */ (await doc.exportData('hocr'));
    const doc2 = await scribe.openDocument({ ocrFiles: [new TextEncoder().encode(hocrOutStr).buffer] });

    expect(hocrView(doc2.ocr.active), 'words, lines, metrics or paragraphs changed across an hOCR export and re-import').toEqual(view1);
    expect(ocrSystem(hocrOutStr), 'a document not from hOCR names another producer').toBe('scribe.js');
    expect([doc2.ocr.active[0].lines[0].words[1].text, doc2.ocr.active[0].lines[0].words[1].conf], 'an undone word edit must not reach the hOCR export').toEqual(['grave.', 0]);
    expect([doc2.ocr.active[0].lines[12].words[0].text, doc2.ocr.active[0].lines[12].words[0].conf], 'a redone word edit reaches the hOCR export with its confidence').toEqual(['to', 100]);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check .hocr export of a document imported from hOCR.', () => {
  /** @type {string} */
  let input;
  /** @type {string} */
  let unedited;
  /** @type {string} */
  let edited;
  /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
  let reimported;
  /** @type {Array<{id: string, lines: Array<string>}>} */
  let parsBefore;
  /** @type {string} */
  let lastLineDeleted;
  /** @type {Array<string>} */
  let addedOrder;
  /** @type {string} */
  let lineAdded;
  /** @type {string} */
  let regrouped;
  /** @type {string} */
  let langEdited;
  /** @type {string} */
  let secondInput;
  /** @type {Array<string>} */
  let secondOrder;
  /** @type {string} */
  let otherLayer;
  /** @type {string} */
  let uploadAfterModel;
  /** @type {string} */
  let modelExport;
  /** @type {string} */
  let restoredUpload;
  /** @type {string} */
  let restoredModel;
  /** @type {string} */
  let secondParDeleted;
  /** @type {string} */
  let droppedInput;
  /** @type {string} */
  let droppedUnedited;
  /** @type {string} */
  let droppedRedacted;
  /** @type {string} */
  let lineOnlyInput;
  /** @type {string} */
  let lineOnlyAfterReflow;
  /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
  let lineOnlyLangEdited;

  beforeAll(async () => {
    input = await readFileContent(`${ASSETS_PATH}/bill.hocr`);
    const doc = await scribe.openDocument([`${ASSETS_PATH}/bill.png`, `${ASSETS_PATH}/bill.hocr`]);
    const page = doc.ocr.active[0];
    parsBefore = page.pars.map((par) => ({ id: par.id, lines: par.lines.map((line) => line.id) }));
    unedited = /** @type {string} */ (await doc.exportData('hocr'));
    page.lines[1].words[0].text = 'Lien';
    page.lines[1].words[1].style.font = 'Q&A Sans';
    page.lines[1].words[2].style.font = "O'Brien; Serif";
    edited = /** @type {string} */ (await doc.exportData('hocr'));
    reimported = await scribe.openDocument({ ocrFiles: [new TextEncoder().encode(edited).buffer] });

    // The editor's word deletion removes an emptied line from the page but not from its paragraph.
    scribe.utils.ocr.deletePageWords(page, page.lines[page.lines.length - 1].words.map((word) => word.id));
    lastLineDeleted = /** @type {string} */ (await doc.exportData('hocr'));

    const addedBox = {
      left: 40, top: 96, right: 120, bottom: 108,
    };
    const addedLine = new scribe.utils.ocr.OcrLine(page, { ...addedBox }, [0, 0], 10, null);
    const addedWord = new scribe.utils.ocr.OcrWord(addedLine, 'added_word', 'ADDED', { ...addedBox });
    addedWord.conf = 100;
    addedLine.words = [addedWord];
    page.lines.splice(3, 0, addedLine);
    addedOrder = page.lines.map((line) => line.id);
    lineAdded = /** @type {string} */ (await doc.exportData('hocr'));

    scribe.utils.assignParagraphs(page, 0);
    regrouped = /** @type {string} */ (await doc.exportData('hocr'));

    page.lines.find((line) => line.id === 'line_1_6').words[0].lang = 'deu';
    langEdited = /** @type {string} */ (await doc.exportData('hocr'));

    // The tesseract.js reading of the same scan reuses the upload's line ids.
    secondInput = await readFileContent(`${ASSETS_PATH}/bill.tesseractjs.hocr`);
    await doc.importFilesSupp([`${ASSETS_PATH}/bill.tesseractjs.hocr`], 'Second');
    secondOrder = doc.ocr.Second[0].lines.map((line) => line.id);
    otherLayer = /** @type {string} */ (await doc.exportData('hocr', { ocrName: 'Second' }));

    class MockHocrModel {
      static config = { name: 'Mock hOCR', outputFormat: 'hocr' };

      static async recognizeImage() {
        return { success: true, rawData: secondInput, format: 'hocr' };
      }
    }
    await doc.recognize({ model: MockHocrModel });
    uploadAfterModel = /** @type {string} */ (await doc.exportData('hocr', { ocrName: 'User Upload' }));
    modelExport = /** @type {string} */ (await doc.exportData('hocr', { ocrName: 'Mock hOCR' }));

    const saveAndRestore = async (/** @type {string} */ ocrName) => {
      const session = /** @type {string} */ (await doc.exportData('scribe', { scribeSession: true, compressScribe: false, ocrName }));
      const restored = await scribe.openDocument({ scribeFiles: [new TextEncoder().encode(session).buffer], imageFiles: [`${ASSETS_PATH}/bill.png`] });
      return /** @type {string} */ (await restored.exportData('hocr'));
    };
    restoredUpload = await saveAndRestore('User Upload');
    restoredModel = await saveAndRestore('Mock hOCR');

    const second = doc.ocr.Second[0];
    scribe.utils.ocr.deletePageWords(second, second.lines[0].words.map((word) => word.id));
    secondParDeleted = /** @type {string} */ (await doc.exportData('hocr', { ocrName: 'Second' }));

    const line13 = input.match(/<span class='ocr_line' id='line_1_13'[\s\S]+?<\/span>\s*<\/span>/)[0];
    droppedInput = input.replace(line13, line13.replace(/title='bbox [^;']*; /g, "title='"));
    const droppedDoc = await scribe.openDocument({ ocrFiles: [new TextEncoder().encode(droppedInput).buffer] });
    droppedUnedited = /** @type {string} */ (await droppedDoc.exportData('hocr'));
    droppedDoc.addRedactions([{
      page: 0,
      bbox: {
        left: 0, top: 0, right: 957, bottom: 307,
      },
    }]);
    droppedRedacted = /** @type {string} */ (await droppedDoc.exportData('hocr'));

    // A reflowed text export assigns paragraphs in place to a page that has none.
    const fix = 'gov.uscourts.cand.431002.77.1_p76-83+86-89+148-151.p8.tesseract.hocr';
    lineOnlyInput = await readFileContent(`${ASSETS_PATH}/${fix}`);
    const lineOnlyDoc = await scribe.openDocument([`${ASSETS_PATH}/${fix}`]);
    await lineOnlyDoc.exportData('txt', { reflow: true });
    lineOnlyAfterReflow = /** @type {string} */ (await lineOnlyDoc.exportData('hocr'));
    const lineOnlyFirst = lineOnlyDoc.ocr.active[0].lines[0];
    for (const word of lineOnlyFirst.words) word.lang = 'deu';
    lineOnlyFirst.words[0].text = 'EDITED';
    const lineOnlyEdited = /** @type {string} */ (await lineOnlyDoc.exportData('hocr'));
    lineOnlyLangEdited = await scribe.openDocument({ ocrFiles: [new TextEncoder().encode(lineOnlyEdited).buffer] });
  });

  test('An unedited export returns the uploaded markup', async () => {
    expect(lineMarkup(unedited), 'an unedited export changed a line of the uploaded hOCR').toEqual(lineMarkup(input));
    expect(ocrSystem(unedited), 'the producing engine was replaced in ocr-system').toBe('tesseract 5.1.0-471-gbc490');
    expect((unedited.match(/<meta name=/g) || []).length, 'the head carries metas that are not hOCR metadata').toBe(3);
    expect((unedited.match(/class='ocr_par'/g) || []).length, 'paragraphs were dropped from the export').toBe(4);
    expect(unedited, 'a non-text element of the page was dropped from the export').toContain("<div class='ocr_photo' id='block_1_3' title=\"bbox 27 94 939 104\"></div>");
  });

  test('An edit changes only the line it touched', async () => {
    const before = lineMarkup(input);
    const after = lineMarkup(edited);
    expect(after.length, 'an edit to one word added or dropped a line').toBe(before.length);
    expect(before.map((line, i) => (line === after[i] ? null : i)).filter((i) => i !== null), 'an edit to one word rewrote other lines').toEqual([1]);
    expect(after[1], 'the edited line does not carry the new text').toContain('>Lien</span>');
    expect(after[1], 'the edited word lost its id').toContain("id='word_1_3'");
    expect(after[1], 'the edited word lost its confidence').toContain('x_wconf 96');
    expect(after[1], 'the edited line lost its id').toContain("id='line_1_2'");
    expect(edited, 'a non-text element of the page was dropped after an edit').toContain("id='block_1_3'");
  });

  test('Deleting a paragraph\'s only line removes the paragraph and its carea', async () => {
    expect(lineMarkup(lastLineDeleted).length, 'the deleted line is still exported, or another line was lost').toBe(13);
    expect(lastLineDeleted, 'the deleted line was written back as an empty line').not.toContain("id='line_1_14'");
    expect(lastLineDeleted, 'the emptied paragraph is still exported').not.toContain("id='par_1_4'");
    expect(lastLineDeleted, 'the emptied carea is still exported').not.toContain("id='block_1_5'");
    expect(lastLineDeleted, 'a container was written with an empty bounding box').not.toContain('bbox 0 0 0 0');
  });

  test('A line added in memory is written in reading order, and every id stays unique', async () => {
    expect(lineOrder(lineAdded), 'the added line was not written where it sits among the page\'s lines').toEqual(addedOrder);
    expect(lineAdded, 'the added word is missing from the export').toContain('>ADDED</span>');
    const ids = [...lineAdded.matchAll(/\sid='([^']+)'/g)].map((m) => m[1]);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i), 'two elements of the export share an id').toEqual([]);
  });

  test('Regrouping the page\'s paragraphs in memory changes nothing in the export', async () => {
    expect(regrouped, 'paragraphs the uploaded file does not know moved or rewrote its lines').toBe(lineAdded);
  });

  test('Changing a word\'s language rewrites that line alone', async () => {
    const before = lineMarkup(regrouped);
    const after = lineMarkup(langEdited);
    const changed = before.map((line, i) => (line === after[i] ? null : i)).filter((i) => i !== null);
    expect(changed.map((i) => lineOrder(langEdited)[i]), 'a language edit was written back as the old markup, or rewrote other lines').toEqual(['line_1_6']);
    expect(after[changed[0]], 'the rebuilt line does not carry the new language').toContain("lang='deu'");
  });

  test('Exporting another hOCR layer returns that layer\'s own markup', async () => {
    expect(lineMarkup(otherLayer), 'the second layer\'s lines were not returned as its file has them').toEqual(lineMarkup(secondInput));
    expect(lineOrder(otherLayer), 'the second layer\'s lines were written in the uploaded file\'s order').toEqual(secondOrder);
    expect(ocrSystem(otherLayer), 'the uploaded file\'s engine was named as the producer of a file that has none').toBe('scribe.js');
    expect(otherLayer, 'the uploaded file\'s photo was carried into another layer\'s export').not.toContain("class='ocr_photo'");
  });

  test('A recognition model\'s hOCR does not replace the uploaded file\'s markup', async () => {
    expect(uploadAfterModel, 'the upload exports differently after a model run').toBe(langEdited);
    expect(lineMarkup(modelExport), 'the model\'s own lines were not returned as the model wrote them').toEqual(lineMarkup(secondInput));
  });

  test('Deleting one paragraph of a carea that holds others rebuilds the carea\'s box', async () => {
    expect(secondParDeleted, 'the emptied paragraph is still exported').not.toContain("id='par_1_1'");
    expect(secondParDeleted, 'the carea kept the box of the deleted paragraph').toContain("<div class='ocr_carea' id='block_1_1' title=\"bbox 32 35 932 307\">");
  });

  test('Every layer\'s remembered markup survives a session save and restore', async () => {
    expect(restoredUpload, 'the upload exports differently after a session restore').toBe(langEdited);
    expect(restoredModel, 'the model\'s layer exports differently after a session restore').toBe(modelExport);
  });

  test('A paragraph holding a line the importer dropped is returned as uploaded', async () => {
    const parTag = (/** @type {string} */ hocr) => hocr.match(/<p class='ocr_par' id='par_1_3'[^>]*>/)?.[0];
    expect(parTag(droppedUnedited), 'the paragraph was rebuilt although none of its lines was edited').toBe(parTag(droppedInput));
    expect(droppedUnedited, 'the dropped line was not returned as uploaded').toContain("id='line_1_13'");
  });

  test('A redacted export carries nothing the importer dropped', async () => {
    expect(droppedRedacted, 'text of a line the importer dropped leaked past a redaction').not.toContain('02Aug2018');
    expect((droppedRedacted.match(/class='ocrx_word'/g) || []).length, 'a word survived a redaction of the whole page').toBe(0);
  });

  test('A reflowed text export does not restructure a later hOCR export', async () => {
    const lines = (/** @type {string} */ hocr) => hocr.match(/<span class='ocr_line'[\s\S]+?(?:<\/span>\s*){2}/g) || [];
    expect(lines(lineOnlyAfterReflow), 'the paragraphs a reflowed export grouped in memory moved or rewrote the uploaded lines').toEqual(lines(lineOnlyInput));
    expect((lineOnlyAfterReflow.match(/class='ocr_par'/g) || []).length, 'in-memory paragraphs were written into the hOCR of a file that has none').toBe(0);
  });

  test('A rebuilt line outside any paragraph keeps its language', async () => {
    const first = lineOnlyLangEdited.ocr.active[0].lines[0];
    expect(first.words[0].text, 'the edit did not survive re-import').toBe('EDITED');
    expect([...new Set(first.words.map((word) => word.lang))], 'the words of a rebuilt paragraph-less line lost their language').toEqual(['deu']);
  });

  test('The edited export re-imports with the edit and the same paragraphs', async () => {
    expect(reimported.ocr.active[0].lines[1].words[0].text, 'the edit did not survive re-import').toBe('Lien');
    expect(reimported.ocr.active[0].lines[1].words[0].conf, 'the edited word lost its confidence on re-import').toBe(96);
    expect(reimported.ocr.active[0].lines[1].words[1].style.font, 'a font name holding an ampersand changed across an hOCR round trip').toBe('Q&A Sans');
    expect(reimported.ocr.active[0].lines[1].words[2].style.font, 'a font name holding an apostrophe and a semicolon changed across an hOCR round trip').toBe("O'Brien; Serif");
    expect(reimported.ocr.active[0].pars.map((par) => ({ id: par.id, lines: par.lines.map((line) => line.id) })), 'paragraphs changed across an hOCR export and re-import').toEqual(parsBefore);
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});

describe('Check non-contiguous pageArr subsetting for .hocr export.', () => {
  test('Exporting pages [0, 2] should include pages 0 and 2 but not page 1', async () => {
    const doc = await scribe.openDocument([`${ASSETS_PATH}/trident_v_connecticut_general.abbyy.xml`]);

    const exportedHocr = await doc.exportData('hocr', { pageArr: [0, 2] });

    // "Comstock" only appears on page 0 — should be present
    expect(exportedHocr).toContain('Comstock');
    // "Security" only appears on page 2 — should be present
    expect(exportedHocr).toContain('Security');
    // "Munger" only appears on page 1 — should not be present
    expect(exportedHocr).not.toContain('Munger');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
