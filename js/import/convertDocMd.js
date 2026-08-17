import ocr from '../objects/ocrObjects.js';
import { LayoutDataTablePage } from '../objects/layoutObjects.js';
import { calcWordCharMetrics } from '../utils/fontUtils.js';
import { GlobalFonts, DocFonts } from '../containers/fontContainer.js';
import { collectMdRefs, parseMdBlocks } from '../utils/parseMd.js';

const FONT_FAMILY = 'Times New Roman';
const FONT_SIZE = 14;
const CHAR_SPACING = 0;
const LINE_HEIGHT = 14.4;
const MARGIN_VERTICAL = 30;
const MARGIN_HORIZONTAL = 20;
const BLOCK_SPACING = LINE_HEIGHT / 2;
const LIST_INDENT = 24;
const QUOTE_INDENT = 24;
const HEADING_SIZES = [24, 20, 18, 16, 14, 14];

/**
 * Font faces used to measure text, keyed by family and bold/italic combination.
 * Resolving against a throwaway `DocFonts` returns process-wide built-ins rather than any document's own fonts, which is what makes one cache safe to share across documents.
 * @type {Map<string, opentypeFont>}
 */
const fontFaces = new Map();

const fontLookupDoc = new DocFonts();

/**
 * @param {Partial<Style>} style
 * @returns {opentypeFont}
 */
const resolveFontFace = (style) => {
  const key = `${style.font}|${style.bold ? 'b' : ''}${style.italic ? 'i' : ''}`;
  let face = fontFaces.get(key);
  if (!face) {
    face = GlobalFonts.getFont(style, fontLookupDoc).opentype;
    fontFaces.set(key, face);
  }
  return face;
};

/**
 * Calculates the advance of a string in pixels.
 * @param {string} text
 * @param {number} size
 * @param {opentypeFont} font
 */
function getTextWidth(text, size, font) {
  const { advanceArr, kerningArr } = calcWordCharMetrics(text, font);

  const advanceTotal = advanceArr.reduce((a, b) => a + b, 0);
  const kerningTotal = kerningArr.reduce((a, b) => a + b, 0);

  const wordLastGlyphMetrics = font.charToGlyph(text.at(-1)).getMetrics();
  const wordFirstGlyphMetrics = font.charToGlyph(text[0]).getMetrics();

  // The `leftSideBearing`/`rightSideBearing` numbers reported by Opentype.js are not accurate for mono-spaced fonts, so `xMin`/`xMax` are used instead.
  const wordLeftBearing = wordFirstGlyphMetrics.xMin || 0;
  const lastGlyphMax = wordLastGlyphMetrics.xMax || 0;
  const wordRightBearing = advanceArr[advanceArr.length - 1] - lastGlyphMax;

  const wordWidth1 = (advanceTotal + kerningTotal - wordLeftBearing - wordRightBearing);
  const wordWidth1Px = wordWidth1 * (size / font.unitsPerEm);
  const spacingTotalPx = (text.length - 1) * CHAR_SPACING;
  const wordWidth = wordWidth1Px + spacingTotalPx;

  return wordWidth;
}

/** @typedef {import('../utils/parseMd.js').MdRun} MdRun */

/**
 * @typedef {Object} MdBlock
 * @property {import('../objects/ocrObjects.js').ParType} type
 * @property {Array<MdRun>} runs
 * @property {number} fontSize
 * @property {number} indent - Offset of this block's left edge from the page's text margin, in pixels.
 * @property {?string} parNum - List marker as the reader sees it, or `null` when the block is not a list item.
 * @property {?number} headingLevel
 * @property {string} sourceStyle - Word style name for the markdown construct, matching the names the .docx importer records.
 * @property {boolean} preserveBreaks - Set for code blocks, which keep their source line breaks instead of reflowing.
 * @property {string} [footnoteLabel] - Label of the footnote definition this block came from.
 */

/**
 * Convert a markdown file to internal OCR format.
 * @param {Object} params
 * @param {string} params.mdStr - Raw markdown content.
 * @param {?{width: number, height: number}} [params.pageDims] - Page dimensions (defaults to US Letter).
 */
export async function convertDocMd({ mdStr, pageDims = null }) {
  if (!pageDims) pageDims = { width: 612, height: 792 };

  let lines = mdStr.split(/\r?\n/);

  // A YAML front matter block is metadata, not content. Without this check its closing fence reads as a setext underline, turning the metadata into a heading.
  if (lines.length > 2 && /^---[ \t]*$/.test(lines[0])) {
    let close = -1;
    let hasKey = false;
    for (let j = 1; j < lines.length; j++) {
      if (/^(?:---|\.\.\.)[ \t]*$/.test(lines[j])) {
        close = j;
        break;
      }
      if (/^[A-Za-z0-9_-]+:(?:[ \t]|$)/.test(lines[j])) hasKey = true;
    }
    // A key-shaped line is required so a document that merely opens with a thematic break does not lose everything up to the next rule.
    if (close !== -1 && hasKey) lines = lines.slice(close + 1);
  }

  const blocks = parseMdBlocks(lines, collectMdRefs(lines), FONT_FAMILY).map((b) => {
    /** @type {import('../objects/ocrObjects.js').ParType} */
    let type = 'body';
    if (b.kind === 'heading') type = 'title';
    else if (b.kind === 'footnote') type = 'footnote';
    let sourceStyle = 'Normal';
    if (b.kind === 'code') sourceStyle = 'HTMLPreformatted';
    else if (b.kind === 'footnote') sourceStyle = 'FootnoteText';
    else if (b.kind === 'heading') sourceStyle = `Heading${b.headingLevel}`;
    else if (b.listDepth !== null) sourceStyle = 'ListParagraph';
    let indent = 0;
    if (b.kind === 'code') indent = LIST_INDENT;
    else if (b.listDepth !== null) indent = LIST_INDENT * (b.listDepth + 1);
    /** @type {MdBlock} */
    const block = {
      type,
      runs: b.runs,
      fontSize: b.headingLevel ? HEADING_SIZES[b.headingLevel - 1] : FONT_SIZE,
      indent,
      parNum: (b.kind === 'footnote' ? b.footnoteLabel : b.marker) ?? null,
      headingLevel: b.kind === 'heading' ? b.headingLevel : null,
      sourceStyle,
      preserveBreaks: b.kind === 'code',
      footnoteLabel: b.footnoteLabel,
    };
    // A quoted code block keeps its fence identity.
    // The markdown writer can express a fence or a quote, not both.
    if (b.quoted && b.kind !== 'code') {
      block.type = 'blockquote';
      // The heading level lives only on title paragraphs, so a quoted heading keeps its size and weight instead.
      block.headingLevel = null;
      if (block.sourceStyle === 'Normal' || /^Heading/.test(block.sourceStyle)) block.sourceStyle = 'Quote';
      block.indent += QUOTE_INDENT;
    }
    return block;
  });

  const pagesOut = [];
  let pageIndex = 0;
  let pageObj = new ocr.OcrPage(pageIndex, pageDims);
  pageObj.textSource = 'md';
  pagesOut.push({ pageObj, dataTables: new LayoutDataTablePage(pageIndex) });

  let currentY = MARGIN_VERTICAL + LINE_HEIGHT / 2;

  /** @type {Map<string, OcrPar>} */
  const fnPars = new Map();
  /** @type {Array<{word: OcrWord, label: string}>} */
  const fnRefs = [];

  for (const block of blocks) {
    const bodyFace = resolveFontFace({ font: FONT_FAMILY });
    const ascHeight = bodyFace.ascender * (block.fontSize / bodyFace.unitsPerEm);
    const descHeight = bodyFace.descender * (block.fontSize / bodyFace.unitsPerEm);
    const lineHeight = LINE_HEIGHT * (block.fontSize / FONT_SIZE);
    const leftEdge = MARGIN_HORIZONTAL + block.indent;
    const rightEdge = pageDims.width - MARGIN_HORIZONTAL;

    // A token with no whitespace before it continues the previous word, which is how a style change inside a word (`mid**dle**`) becomes one word with style runs.
    /** @type {Array<{text: string, space: string, lineBreak: boolean, run: MdRun}>} */
    const tokens = [];
    let space = '';
    for (const run of block.runs) {
      if (run.text === '\n') {
        tokens.push({
          text: '', space: '', lineBreak: true, run,
        });
        space = '';
        continue;
      }
      for (const piece of run.text.split(/(\s+)/)) {
        if (!piece) continue;
        if (/^\s+$/.test(piece)) {
          space = piece;
        } else {
          tokens.push({
            text: piece, space, lineBreak: false, run,
          });
          space = '';
        }
      }
    }

    /** @type {Array<OcrLine>} */
    const parLines = [];
    let parRight = leftEdge;
    let tokenIndex = 0;

    /** @param {OcrPage} page */
    const flushPar = (page) => {
      if (parLines.length === 0) return;
      const parObj = new ocr.OcrPar(page, {
        left: leftEdge,
        top: parLines[0].bbox.top,
        right: parRight,
        bottom: parLines[parLines.length - 1].bbox.bottom,
      });
      parObj.lines = parLines.slice();
      parObj.type = block.type;
      parObj.parNum = block.parNum;
      parObj.headingLevel = block.headingLevel;
      parObj.debug.sourceStyle = block.sourceStyle;
      for (const parLine of parObj.lines) parLine.par = parObj;
      page.pars.push(parObj);
      if (block.footnoteLabel && !fnPars.has(block.footnoteLabel)) fnPars.set(block.footnoteLabel, parObj);
      parLines.length = 0;
      parRight = leftEdge;
    };

    while (tokenIndex < tokens.length) {
      if (currentY + block.fontSize > pageDims.height - MARGIN_VERTICAL) {
        flushPar(pageObj);
        pageIndex++;
        pageObj = new ocr.OcrPage(pageIndex, pageDims);
        pageObj.textSource = 'md';
        pagesOut.push({ pageObj, dataTables: new LayoutDataTablePage(pageIndex) });
        currentY = MARGIN_VERTICAL + LINE_HEIGHT / 2;
      }

      if (currentY - ascHeight < MARGIN_VERTICAL) currentY = MARGIN_VERTICAL + ascHeight;

      const lineTop = Math.round(currentY - ascHeight);
      const lineBottom = Math.round(currentY - descHeight);
      const lineObj = new ocr.OcrLine(pageObj, {
        left: leftEdge, top: lineTop, right: leftEdge, bottom: lineBottom,
      }, [0, descHeight], ascHeight, null);

      let currentX = leftEdge;

      while (tokenIndex < tokens.length) {
        const token = tokens[tokenIndex];
        if (token.lineBreak) {
          tokenIndex++;
          break;
        }

        const face = resolveFontFace(token.run);
        const tokenWidth = getTextWidth(token.text, block.fontSize, face);
        const lastWord = lineObj.words[lineObj.words.length - 1];

        if (!token.space && lastWord) {
          const tailStyle = lastWord.styleRuns && lastWord.styleRuns.length > 0
            ? { ...lastWord.style, ...lastWord.styleRuns[lastWord.styleRuns.length - 1].style }
            : lastWord.style;
          if (tailStyle.bold !== token.run.bold || tailStyle.italic !== token.run.italic || tailStyle.font !== token.run.font
            || !!tailStyle.sup !== !!token.run.sup) {
            lastWord.styleRuns = lastWord.styleRuns || [];
            /** @type {Partial<Style>} */
            const runStyle = { bold: token.run.bold, italic: token.run.italic, font: token.run.font };
            // Omitted fields inherit the word's own style, so `sup` is written only where it differs from it.
            if (!!token.run.sup !== !!lastWord.style.sup) runStyle.sup = !!token.run.sup;
            lastWord.styleRuns.push({ i: lastWord.text.length, style: runStyle });
          }
          // A footnote marker fusing into a larger word must not link.
          // Exports that render real footnotes replace the linked word wholesale, which would drop the rest of its text.
          if (fnRefs.length > 0 && fnRefs[fnRefs.length - 1].word === lastWord) fnRefs.pop();
          lastWord.text += token.text;
          lastWord.bbox.right = Math.round(lastWord.bbox.right + tokenWidth);
          currentX = lastWord.bbox.right;
          tokenIndex++;
          continue;
        }

        // A code block keeps the whitespace that starts a line, which is all that carries its indentation.
        // Reflowed text drops it, so a wrapped line begins flush at the margin.
        const keepSpace = token.space && (lineObj.words.length > 0 || block.preserveBreaks);
        const spaceWidth = keepSpace ? getTextWidth(token.space, block.fontSize, face) : 0;
        if (lineObj.words.length > 0 && currentX + spaceWidth + tokenWidth > rightEdge) break;
        currentX += spaceWidth;

        const wordId = `word_${pageIndex + 1}_${pageObj.lines.length + 1}_${lineObj.words.length + 1}`;
        const wordObj = new ocr.OcrWord(lineObj, wordId, token.text, {
          left: Math.round(currentX),
          top: lineTop,
          right: Math.round(currentX + tokenWidth),
          bottom: lineBottom,
        });
        wordObj.conf = 100;
        wordObj.style.font = token.run.font;
        wordObj.style.size = block.fontSize;
        wordObj.style.bold = token.run.bold;
        wordObj.style.italic = token.run.italic;
        if (token.run.sup) wordObj.style.sup = true;
        if (token.run.link) wordObj.style.link = token.run.link;
        wordObj.visualCoords = false;
        if (token.run.footnoteLabel && token.text === token.run.footnoteLabel) fnRefs.push({ word: wordObj, label: token.run.footnoteLabel });
        lineObj.words.push(wordObj);

        currentX += tokenWidth;
        tokenIndex++;
      }

      if (lineObj.words.length > 0) {
        lineObj.bbox = {
          left: lineObj.words[0].bbox.left,
          top: lineTop,
          right: lineObj.words[lineObj.words.length - 1].bbox.right,
          bottom: lineBottom,
        };
        pageObj.lines.push(lineObj);
        parLines.push(lineObj);
        parRight = Math.max(parRight, lineObj.bbox.right);
      }

      currentY += lineHeight;
    }

    flushPar(pageObj);

    currentY += BLOCK_SPACING;
  }

  for (const ref of fnRefs) {
    const notePar = fnPars.get(ref.label);
    if (!notePar) continue;
    ref.word.footnoteParId = notePar.id;
    if (!notePar.footnoteRefId) notePar.footnoteRefId = ref.word.id;
  }

  return pagesOut;
}
