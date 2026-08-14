import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

/** @param {import('../../js/containers/scribeDoc.js').ScribeDoc} doc */
const wordSequence = (doc) => doc.ocr.active
  .map((page) => page.lines.map((line) => line.words.map((word) => word.text).join(' ')).join(' ')).join(' ');

/** @param {import('../../js/objects/ocrObjects.js').OcrPar} par */
const parText = (par) => par.lines.map((line) => line.words.map((word) => word.text).join(' ')).join(' ');

describe('Check markdown import.', () => {
  /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
  let doc;
  /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
  let docMdReimport;
  /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
  let docPdfReimport;
  /** @type {string} */
  let plainText;

  beforeAll(async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/markdown-field-guide.md`]);
    plainText = /** @type {string} */ (await doc.exportData('text'));
    const markdown = /** @type {string} */ (await doc.exportData('md'));
    const pdf = /** @type {ArrayBuffer} */ (await doc.exportData('pdf'));

    docMdReimport = await scribe.openDocument([new File([markdown], 'roundtrip.md', { type: 'text/markdown' })]);

    scribe.ScribeDoc.defaults.usePDFText.native.main = true;
    scribe.ScribeDoc.defaults.keepPDFTextAlways = true;
    docPdfReimport = await scribe.openDocument({ pdfFiles: [pdf] });
    docPdfReimport.ocr.active = docPdfReimport.ocr.pdf;
  }, 120_000);

  test('Markdown is laid out onto real pages tagged with the markdown source', () => {
    expect(doc.inputData.pageCount, 'markdown must paginate onto the number of pages its text fills').toBe(2);
    expect(doc.ocr.active.length, 'every synthesized page must carry OCR data').toBe(2);
    expect(doc.ocr.active[0].dims, 'synthesized pages are US Letter at 72 dpi').toEqual({ width: 612, height: 792 });
    expect(doc.ocr.active[0].textSource, 'the first page must be tagged as imported from markdown').toBe('md');
    expect(doc.ocr.active[1].textSource, 'a page created by overflow must be tagged as imported from markdown too').toBe('md');

    const words = doc.ocr.active.flatMap((page) => page.lines.flatMap((line) => line.words));
    expect(words.length, 'every word of the source document must be imported').toBe(314);
    expect(words.filter((word) => word.visualCoords !== false).length,
      'synthesized coordinates are font bounding boxes, not measured pixels, so no word may claim visual coordinates').toBe(0);
  });

  test('Headings become title paragraphs carrying their level', () => {
    expect(doc.ocr.active[0].pars[0].type, 'a top-level heading must import as a title paragraph').toBe('title');
    expect(doc.ocr.active[0].pars[0].headingLevel, 'a `#` heading is level 1').toBe(1);
    expect(parText(doc.ocr.active[0].pars[0]), 'the heading text must survive without its `#` marker').toBe('Coastal Survey Field Guide');
    expect(doc.ocr.active[0].pars[2].headingLevel, 'a `##` heading is level 2').toBe(2);
    expect(parText(doc.ocr.active[0].pars[2]), 'the level 2 heading text must survive').toBe('Before you go');
    expect(doc.ocr.active[0].pars[10].headingLevel, 'a `###` heading is level 3').toBe(3);
    expect(parText(doc.ocr.active[0].pars[10]), 'the level 3 heading text must survive').toBe('Recording a transect');
    // A setext heading is an ordinary paragraph until its underline is read, so it exercises a different path than the `#` headings above.
    expect(doc.ocr.active[0].pars[25].type, 'a dash-underlined (setext) heading must import as a title paragraph').toBe('title');
    expect(doc.ocr.active[0].pars[25].headingLevel, 'a dash-underlined heading is level 2').toBe(2);
    expect(parText(doc.ocr.active[0].pars[25]), 'the setext heading must lose its underline, not its text').toBe('Reporting problems');
  });

  test('List markers leave the text and become the paragraph number', () => {
    expect(parText(doc.ocr.active[0].pars[5]), 'a bullet item must import without its `-` marker').toBe('A charged phone with the survey app installed');
    expect(doc.ocr.active[0].pars[5].parNum, 'a bullet item records the bullet the reader sees').toBe('•');
    expect(parText(doc.ocr.active[0].pars[6]), 'a nested bullet item must import as its own paragraph').toBe('A battery pack, for a full day in the field');
    expect(parText(doc.ocr.active[0].pars[12]), 'a numbered item must import without its `1.` marker').toBe('Photograph the quadrat from directly above.');
    expect(doc.ocr.active[0].pars[12].parNum, 'a numbered item records its number as written').toBe('1.');
    expect(doc.ocr.active[0].pars[15].parNum, 'list numbering must follow the source through the whole list').toBe('4.');
  });

  test('A block quote imports as a blockquote paragraph', () => {
    expect(doc.ocr.active[0].pars[17].type, 'a `>` block must import as a blockquote paragraph').toBe('blockquote');
    expect(parText(doc.ocr.active[0].pars[17]), 'quote text must survive without its `>` markers, reflowed into one paragraph')
      .toBe('Survey data is only as good as its worst observation. When you cannot identify a species, photograph it and mark the entry as unconfirmed.');
  });

  test('Emphasis becomes word styles, including where it changes inside a word', () => {
    const words = doc.ocr.active[0].lines.flatMap((line) => line.words);
    const bold = words.find((word) => word.text === 'thirty');
    expect(bold.style.bold, '`**thirty**` must import as a bold word').toBe(true);
    const italic = words.find((word) => word.text === 'rain');
    expect(italic.style.italic, '`*rain or shine*` must import as italic words').toBe(true);

    const midWord = words.find((word) => word.text === 'miscount');
    expect(midWord.text, '`mis**count**` must import as a single word, markers removed').toBe('miscount');
    expect(midWord.styleRuns, 'the bold half of `mis**count**` must be recorded as a style run at the boundary')
      .toEqual([{ i: 3, style: { bold: true, italic: false, font: 'Times New Roman' } }]);
  });

  test('Code keeps its text and loses its backticks', () => {
    const inlineCode = doc.ocr.active[0].lines.flatMap((line) => line.words).find((word) => word.text === 'Sync');
    expect(inlineCode.style.font, 'an inline code span must import as monospace text').toBe('Courier');

    const codeBlock = doc.ocr.active[0].pars[20];
    expect(codeBlock.debug.sourceStyle, 'a fenced code block must import as preformatted text').toBe('HTMLPreformatted');
    expect(parText(codeBlock), 'code block contents must survive with the fence lines removed')
      .toBe('{"transect": 4, "stop": 3, "substrate": "cobble", "count": 17}');
  });

  test('A link keeps its text and carries its target', () => {
    const words = doc.ocr.active[0].lines.flatMap((line) => line.words);
    expect(words.find((word) => word.text === 'volunteer').style.link, 'link text must carry the link target')
      .toBe('https://example.org/coastal/contact');
    expect(parText(doc.ocr.active[0].pars[22]), 'a link contributes its text to the paragraph and its URL to nothing')
      .toBe('Questions go to the volunteer coordinator, who answers within two working days.');
  });

  test('Markdown syntax never reaches the imported text', () => {
    expect(/\*\*|\]\(|`|^#{1,6}\s|^\s*[-*+]\s/m.test(plainText), 'heading, emphasis, list, code, and link markers must all be consumed by the importer').toBe(false);
    expect(plainText.includes('Quadrat frame placed on cobble'), 'an image must be dropped rather than importing its alt text as body text').toBe(false);
    expect(doc.ocr.active[0].pars.length, 'the image line and the horizontal rule must each produce no paragraph').toBe(27);
  });

  test('Soft line breaks inside a paragraph reflow', () => {
    const par = doc.ocr.active[0].pars[1];
    expect(parText(par), 'two source lines separated by a soft break belong to one paragraph')
      .toBe('A short handbook for volunteers recording shoreline conditions. Read it before your first survey, and keep a copy in your field bag.');
    // The source file breaks this paragraph after "before", so a line ending in "and" proves it re-wrapped.
    expect(par.lines[0].words.map((word) => word.text).join(' '), 'paragraph text must re-wrap to the page rather than preserve the source line breaks')
      .toBe('A short handbook for volunteers recording shoreline conditions. Read it before your first survey, and');
  });

  test('Exported markdown re-imports to the same text', () => {
    expect(wordSequence(docMdReimport), 'text must survive a markdown export and re-import word for word').toBe(wordSequence(doc));
    expect(parText(docMdReimport.ocr.active[0].pars[0]).startsWith('Coastal Survey Field Guide'),
      'the re-imported document must still start with the guide title').toBe(true);
  });

  test('Exported PDF re-imports with the text intact', () => {
    expect(docPdfReimport.ocr.active.length, 'the exported PDF must keep both pages of the markdown import').toBe(2);
    // The word "miscount" is drawn as two runs, roman then bold, which the PDF text extractor reads back as two words.
    expect(wordSequence(docPdfReimport).replace(/\s+/g, ''), 'text was lost exporting the markdown import to PDF and re-importing it')
      .toBe(wordSequence(doc).replace(/\s+/g, ''));
    expect(docPdfReimport.ocr.active[0].lines[0].words.map((word) => word.text).join(' '),
      'the heading must come back as readable text from the exported PDF').toBe('Coastal Survey Field Guide');
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
