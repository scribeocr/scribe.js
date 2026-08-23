import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import { Parser } from 'commonmark';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

/** @param {import('../../js/containers/scribeDoc.js').ScribeDoc} doc */
const wordSequence = (doc) => doc.ocr.active
  .map((page) => page.lines.map((line) => line.words.map((word) => word.text).join(' ')).join(' ')).join(' ');

/** @param {import('../../js/objects/ocrObjects.js').OcrPar} par */
const parText = (par) => par.lines.map((line) => line.words.map((word) => word.text).join(' ')).join(' ');

/** @param {import('../../js/containers/scribeDoc.js').ScribeDoc} doc */
const parStructure = (doc) => doc.ocr.active.flatMap((page, n) => page.pars.map(
  (par) => `page ${n} | ${par.type} | h${par.headingLevel} | ${par.parNum} | left ${par.bbox.left} | ${parText(par)}`,
));

/**
 * @typedef {Object} MdReaderBlock
 * @property {string} kind - `heading1`-`heading6`, `para`, `item`, `code`, or `rule`.
 * @property {number} depth - List nesting level, 1 for a top-level item and 0 outside a list.
 * @property {boolean} quoted - Whether the block sits inside a block quote.
 * @property {boolean} ordered - Whether an item belongs to a numbered list.
 * @property {string} text
 */

/**
 * Read exported markdown the way a standards-compliant reader would.
 * The reference CommonMark implementation is an oracle independent of our own importer, which shares its author's assumptions and so cannot catch them.
 * @param {string} mdStr
 * @returns {Array<MdReaderBlock>}
 */
const readMarkdown = (mdStr) => {
  /** @type {Array<MdReaderBlock>} */
  const out = [];
  const inlineText = (node) => {
    let str = '';
    const walker = node.walker();
    for (let event = walker.next(); event; event = walker.next()) {
      if (!event.entering) continue;
      if (['text', 'code', 'html_inline'].includes(event.node.type)) str += event.node.literal;
      if (event.node.type === 'softbreak') str += ' ';
    }
    return str;
  };
  const visit = (parent, depth, quoted) => {
    for (let node = parent.firstChild; node; node = node.next) {
      const item = parent.type === 'item';
      const base = { depth, quoted, ordered: item && parent.parent.listType === 'ordered' };
      if (node.type === 'block_quote') visit(node, depth, true);
      else if (node.type === 'list') for (let li = node.firstChild; li; li = li.next) visit(li, depth + 1, quoted);
      else if (node.type === 'heading') out.push({ ...base, kind: `heading${node.level}`, text: inlineText(node) });
      else if (node.type === 'paragraph') out.push({ ...base, kind: item ? 'item' : 'para', text: inlineText(node) });
      else if (node.type === 'code_block') out.push({ ...base, kind: 'code', text: (node.literal || '').replace(/\n$/, '') });
      else if (node.type === 'thematic_break') out.push({ ...base, kind: 'rule', text: '' });
    }
  };
  visit(new Parser().parse(mdStr), 0, false);
  return out;
};

// Fixture lines that are ordinary text but open a markdown block when written unescaped.
const SYNTAX_LOOKALIKE_LINES = [
  '# of quadrats is recorded before species counts, never after.',
  '> 90% of transects finish within two hours of low tide.',
  '- 4 degrees is the coldest morning recorded at this site.',
  '12. Removal procedures were renumbered in this revision.',
  '| Depth readings | come from the staff gauge, not the app estimate.',
  '=====',
];

describe('Check markdown import.', () => {
  /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
  let doc;
  /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
  let docMdReimport;
  /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
  let docPdfReimport;
  /** @type {string} */
  let plainText;
  /** @type {Array<MdReaderBlock>} */
  let mdBlocks;

  beforeAll(async () => {
    doc = await scribe.openDocument([`${ASSETS_PATH}/markdown-field-guide.md`]);
    plainText = /** @type {string} */ (await doc.exportData('text'));
    const markdown = /** @type {string} */ (await doc.exportData('md'));
    const pdf = /** @type {ArrayBuffer} */ (await doc.exportData('pdf'));

    mdBlocks = readMarkdown(markdown);

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
    expect(words.length, 'every word of the source document must be imported').toBe(538);
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
    expect(plainText.includes('**'), 'emphasis markers must be consumed by the importer').toBe(false);
    expect(plainText.includes('`'), 'code-span backticks must be consumed by the importer').toBe(false);
    expect(plainText.includes(']('), 'link syntax must be consumed by the importer').toBe(false);
    expect(plainText.includes('## Before you go'), 'heading markers must be consumed by the importer').toBe(false);
    expect(plainText.includes('- A charged phone'), 'list markers must be consumed by the importer').toBe(false);
    expect(plainText.includes('> Survey data'), 'block quote markers must be consumed by the importer').toBe(false);
    expect(plainText.includes('Quadrat frame placed on cobble'), 'an image must be dropped rather than importing its alt text as body text').toBe(false);
    expect(doc.ocr.active[0].pars.length, 'the image line and the horizontal rule must each produce no paragraph').toBe(27);
  });

  test('Escaped syntax characters import as literal text', () => {
    const pars = doc.ocr.active[1].pars;
    expect(parText(pars[4]), 'an escaped `#` must import as body text with the character kept').toBe('# of quadrats is recorded before species counts, never after.');
    expect(pars[4].type, 'a line beginning with an escaped `#` must not become a heading').toBe('body');
    expect(parText(pars[5]), 'an escaped `>` must import as body text with the character kept').toBe('> 90% of transects finish within two hours of low tide.');
    expect(pars[5].type, 'a line beginning with an escaped `>` must not become a block quote').toBe('body');
    expect(parText(pars[6]), 'an escaped `-` must import as body text with the character kept').toBe('- 4 degrees is the coldest morning recorded at this site.');
    expect(pars[6].parNum, 'a line beginning with an escaped `-` must not become a list item').toBe(null);
    expect(parText(pars[7]), 'an escaped ordered-list marker must import as body text').toBe('12. Removal procedures were renumbered in this revision.');
    expect(pars[7].parNum, 'a line beginning with `12\\.` must not become a numbered item').toBe(null);
    expect(parText(pars[8]), 'an escaped `|` must import as body text with the pipes kept').toBe('| Depth readings | come from the staff gauge, not the app estimate.');
    expect(parText(pars[10]), 'a rule of equals signs after a blank line must import as text, not a setext underline').toBe('=====');
  });

  test('Front matter is metadata, not content', () => {
    expect(plainText.includes('season: 2026'), 'YAML front matter must not import as document text').toBe(false);
    expect(parText(doc.ocr.active[0].pars[0]), 'the first paragraph must be the title, not front matter read as a setext heading').toBe('Coastal Survey Field Guide');
  });

  test('Inline HTML becomes styles and entities become characters', () => {
    const words = doc.ocr.active[1].lines.flatMap((line) => line.words);
    expect(words.find((word) => word.text === 'flooded').style.bold, 'a `<b>` element must import as a bold word').toBe(true);
    expect(words.find((word) => word.text === 'H&S'), '`&amp;` must decode to a literal ampersand').toBeTruthy();
    expect(words.find((word) => word.text === '—'), '`&mdash;` must decode to an em dash').toBeTruthy();
    expect(words.find((word) => word.text === 'appendix.1').styleRuns, 'a `<sup>` segment must become a superscript style run at its boundary')
      .toEqual([{
        i: 9,
        style: {
          bold: false, italic: false, font: 'Times New Roman', sup: true,
        },
      }]);
    expect(plainText.includes('<b>'), 'no HTML tag may reach the imported text').toBe(false);
    expect(plainText.includes('&amp;'), 'no entity may reach the imported text undecoded').toBe(false);
  });

  test('Strikethrough markers are consumed and their text kept', () => {
    expect(parText(doc.ocr.active[1].pars[12]), 'the struck word must survive without its tildes')
      .toBe('The 2025 edition said to skip flooded quadrats; H&S guidance now says to record them from the nearest '
        + 'safe rock — see the safety appendix.1 The app shows three four substrate types this season.');
    expect(plainText.includes('~'), 'no strikethrough tilde may reach the imported text').toBe(false);
  });

  test('A hard line break forces a new line inside the paragraph', () => {
    const par = doc.ocr.active[1].pars[13];
    expect(parText(par), 'both halves of the broken paragraph must import').toBe('Site access changed too: the west stairs are closed until May.');
    expect(par.lines.length, 'a trailing-backslash break must produce two lines').toBe(2);
    expect(par.lines[0].words.map((word) => word.text).join(' '), 'the break must fall exactly where the source put it, not where reflow would')
      .toBe('Site access changed too:');
  });

  test('Reference links resolve through their definitions', () => {
    const words = doc.ocr.active[1].lines.flatMap((line) => line.words);
    expect(words.find((word) => word.text === 'regional').style.link, 'a `[text][ref]` link must carry the destination from its definition')
      .toBe('https://example.org/coastal/archive');
    expect(parText(doc.ocr.active[1].pars[14]), 'reference brackets must leave the text')
      .toBe('Field reports go to the regional archive, with survey photos attached 1 before the end of the month.');
    expect(plainText.includes('archive]:'), 'a reference definition line must produce no visible text').toBe(false);
  });

  test('A footnote definition becomes a linked footnote paragraph', () => {
    const notePar = doc.ocr.active[1].pars[25];
    expect(notePar.type, 'a `[^1]:` definition must import as a footnote paragraph').toBe('footnote');
    expect(notePar.parNum, 'the footnote keeps its label as the marker').toBe('1');
    expect(parText(notePar), 'the footnote body must survive without its label syntax').toBe('Photos larger than 10 MB upload only on wifi.');
    const marker = doc.ocr.active[1].lines.flatMap((line) => line.words).find((word) => word.text === '1' && word.style.sup);
    expect(marker.footnoteParId, 'the `[^1]` reference must link to its footnote paragraph').toBe(notePar.id);
    expect(notePar.footnoteRefId, 'the footnote paragraph must link back to its reference word').toBe(marker.id);
  });

  test('Task-list checkboxes become visible markers', () => {
    expect(doc.ocr.active[1].pars[15].parNum, 'an unchecked task imports with an empty-checkbox marker').toBe('☐');
    expect(parText(doc.ocr.active[1].pars[15]), 'the checkbox syntax must leave the item text').toBe('Confirm your tide-table subscription');
    expect(doc.ocr.active[1].pars[16].parNum, 'a checked task imports with a checked-checkbox marker').toBe('☑');
  });

  test('List nesting follows the parent content column', () => {
    expect(doc.ocr.active[1].pars[17].parNum, 'the outer numbered item keeps its number').toBe('1.');
    expect(doc.ocr.active[1].pars[17].bbox.left, 'the outer numbered item sits at first-level indent').toBe(44);
    expect(doc.ocr.active[1].pars[18].parNum, 'the nested numbered item keeps its number').toBe('1.');
    expect(doc.ocr.active[1].pars[18].bbox.left, 'a marker at the parent content column nests one level, not two').toBe(68);
  });

  test('An indented chunk outside a list imports as a code block', () => {
    const codePar = doc.ocr.active[1].pars[20];
    expect(codePar.debug.sourceStyle, 'four-space indentation must import as preformatted text').toBe('HTMLPreformatted');
    expect(codePar.lines.length, 'the code block must keep its source line break').toBe(2);
    expect(parText(codePar), 'the code text must survive with its indentation removed').toBe('TRANSECT 4 / STOP 3 substrate: cobble');
  });

  test('Blocks inside a block quote keep their structure without their syntax', () => {
    const pars = doc.ocr.active[1].pars;
    expect(parText(pars[21]), 'a quoted heading must import without its `#` markers').toBe('From the coordinator');
    expect(pars[21].type, 'a quoted heading imports as a quote paragraph').toBe('blockquote');
    expect(pars[21].lines[0].words[0].style.size, 'a quoted heading keeps its heading size').toBe(20);
    expect(pars[21].lines[0].words[0].style.bold, 'a quoted heading keeps its heading weight').toBe(true);
    expect(parText(pars[22]), 'quoted paragraph lines must merge without their `>` markers').toBe('Thank you for another season. Every record helps someone downstream.');
    expect(pars[23].type, 'a quoted list item imports as a quote paragraph').toBe('blockquote');
    expect(pars[23].parNum, 'a quoted bullet keeps its marker without the `-` reaching the text').toBe('•');
    expect(parText(pars[23]), 'the quoted item text must survive').toBe('Keep your site maps');
  });

  test('Soft line breaks inside a paragraph reflow', () => {
    const par = doc.ocr.active[0].pars[1];
    expect(parText(par), 'two source lines separated by a soft break belong to one paragraph')
      .toBe('A short handbook for volunteers recording shoreline conditions. Read it before your first survey, and keep a copy in your field bag.');
    // The source file breaks this paragraph after "before", so a line ending in "and" proves it re-wrapped.
    expect(par.lines[0].words.map((word) => word.text).join(' '), 'paragraph text must re-wrap to the page rather than preserve the source line breaks')
      .toBe('A short handbook for volunteers recording shoreline conditions. Read it before your first survey, and');
  });

  test('A standards-compliant reader sees the block structure the document was written from', () => {
    expect(mdBlocks.filter((block) => block.kind.startsWith('heading')).map((block) => `${block.kind} ${block.text}`),
      'headings must reach a compliant reader at their source levels').toEqual([
      'heading1 Coastal Survey Field Guide',
      'heading2 Before you go',
      'heading3 Recording a transect',
      'heading2 Uploading your data',
      'heading2 Common mistakes',
      'heading2 Reporting problems',
      'heading2 Notation notes',
      'heading2 Revision history',
    ]);

    expect(mdBlocks.filter((block) => block.kind === 'item').map((block) => block.depth),
      'list nesting must survive export, including an item nested under a numbered parent').toEqual([1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 1, 1]);

    expect(mdBlocks.filter((block) => block.kind === 'item' && block.depth === 2).map((block) => block.text),
      'the nested items must be the ones nested in the source').toEqual([
      'A battery pack, for a full day in the field',
      'New keycodes are posted there each Monday.',
    ]);

    expect(mdBlocks.filter((block) => block.quoted).map((block) => `${block.kind} ${block.text}`),
      'every quoted block must still read as quoted, including lists inside the quote').toEqual([
      'para Survey data is only as good as its worst observation. When you cannot identify a species, photograph it and mark the entry as unconfirmed.',
      'para From the coordinator',
      'para Thank you for another season. Every record helps someone downstream.',
      'item Keep your site maps',
      'item Return borrowed quadrat frames',
    ]);

    expect(mdBlocks.filter((block) => block.kind === 'code').map((block) => block.text),
      'fenced and indented code must reach a compliant reader as code, with their line breaks').toEqual([
      '{"transect": 4, "stop": 3, "substrate": "cobble", "count": 17}',
      'TRANSECT 4 / STOP 3\nsubstrate: cobble',
    ]);

    expect(mdBlocks.filter((block) => block.kind === 'rule').length,
      'the page break between the two exported pages must be the only thematic break').toBe(1);
  });

  test('Body text that looks like markdown syntax reaches a reader as text', () => {
    expect(SYNTAX_LOOKALIKE_LINES.map((line) => (mdBlocks.find((block) => block.text === line) || {}).kind),
      'a line beginning with a markdown syntax character must parse as a paragraph rather than opening a block')
      .toEqual(['para', 'para', 'para', 'para', 'para', 'para']);
  });

  test('Exported markdown re-imports to the same text and paragraph structure', () => {
    expect(wordSequence(docMdReimport), 'text must survive a markdown export and re-import word for word').toBe(wordSequence(doc));
    // The word-sequence assertion above localizes a failure to text loss, which structure equality alone would not distinguish.
    expect(parStructure(docMdReimport), 'paragraph structure must survive a markdown export and re-import').toEqual(parStructure(doc));
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
