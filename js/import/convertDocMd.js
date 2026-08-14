import ocr from '../objects/ocrObjects.js';
import { LayoutDataTablePage } from '../objects/layoutObjects.js';
import { calcWordCharMetrics } from '../utils/fontUtils.js';
import { GlobalFonts, DocFonts } from '../containers/fontContainer.js';

const FONT_FAMILY = 'Times New Roman';
const CODE_FONT_FAMILY = 'Courier';
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

/**
 * @typedef {Object} MdRun
 * @property {string} text - Literal text, with every markdown syntax character already removed. `'\n'` marks a forced line break.
 * @property {boolean} bold
 * @property {boolean} italic
 * @property {string} font
 * @property {?string} link - Target URL when the text came from a link, otherwise `null`.
 */

/**
 * Convert the inline markdown of one block into styled runs.
 * @param {string} text
 * @param {{bold: boolean, italic: boolean, font: string, link: ?string}} style - Style in effect around `text`.
 * @returns {Array<MdRun>}
 */
function parseInlineMd(text, style) {
  /** @type {Array<MdRun>} */
  const runs = [];
  let buf = '';
  const flush = () => {
    if (buf) runs.push({ text: buf, ...style });
    buf = '';
  };

  let i = 0;
  while (i < text.length) {
    const char = text[i];

    if (char === '\\' && /[\\`*_{}[\]()#+\-.!>|~]/.test(text[i + 1] || '')) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    if (char === '`') {
      let fence = 0;
      while (text[i + fence] === '`') fence++;
      let close = -1;
      for (let j = i + fence; j < text.length;) {
        if (text[j] !== '`') {
          j++;
        } else {
          let run = 0;
          while (text[j + run] === '`') run++;
          if (run === fence) {
            close = j;
            break;
          }
          j += run;
        }
      }
      if (close === -1) {
        buf += '`'.repeat(fence);
        i += fence;
        continue;
      }
      let code = text.slice(i + fence, close);
      // A code span drops one space at each end, which is how a span holds a literal backtick without running into its own fence.
      if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
      flush();
      runs.push({
        text: code, bold: style.bold, italic: style.italic, font: CODE_FONT_FAMILY, link: style.link,
      });
      i = close + fence;
      continue;
    }

    if (char === '[' || (char === '!' && text[i + 1] === '[')) {
      const isImage = char === '!';
      const labelStart = isImage ? i + 1 : i;
      let depth = 0;
      let labelEnd = -1;
      for (let j = labelStart; j < text.length; j++) {
        if (text[j] === '\\') {
          j++;
        } else if (text[j] === '[') {
          depth++;
        } else if (text[j] === ']') {
          depth--;
          if (depth === 0) {
            labelEnd = j;
            break;
          }
        }
      }
      const destMatch = labelEnd !== -1 ? /^\(\s*(\S*?)(?:\s+"[^"]*")?\s*\)/.exec(text.slice(labelEnd + 1)) : null;
      if (!destMatch) {
        buf += char;
        i++;
        continue;
      }
      flush();
      if (!isImage) {
        const url = destMatch[1];
        const link = /^(https?:|mailto:)/i.test(url) ? url : style.link;
        runs.push(...parseInlineMd(text.slice(labelStart + 1, labelEnd), { ...style, link }));
      }
      i = labelEnd + 1 + destMatch[0].length;
      continue;
    }

    if (char === '<') {
      const autolink = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(text.slice(i));
      if (autolink) {
        flush();
        runs.push({ ...style, text: autolink[1].replace(/^mailto:/i, ''), link: autolink[1] });
        i += autolink[0].length;
        continue;
      }
    }

    if (char === '*' || char === '_') {
      let run = 0;
      while (text[i + run] === char) run++;
      const charBefore = text[i - 1] || '';
      const charAfter = text[i + run] || '';
      // An underscore run only opens or closes at a word boundary, so snake_case identifiers keep their underscores.
      const canOpen = charAfter !== '' && !/\s/.test(charAfter) && (char === '*' || !/[\p{L}\p{N}]/u.test(charBefore));
      const use = Math.min(run, 3);
      let close = -1;
      if (canOpen) {
        for (let j = i + run; j < text.length;) {
          if (text[j] === '\\') {
            j += 2;
          } else if (text[j] !== char) {
            j++;
          } else {
            let closeRun = 0;
            while (text[j + closeRun] === char) closeRun++;
            const closeBefore = text[j - 1] || '';
            const closeAfter = text[j + closeRun] || '';
            if (closeRun >= use && !/\s/.test(closeBefore) && (char === '*' || !/[\p{L}\p{N}]/u.test(closeAfter))) {
              close = j;
              break;
            }
            j += closeRun;
          }
        }
      }
      if (close === -1) {
        buf += char.repeat(run);
        i += run;
        continue;
      }
      flush();
      runs.push(...parseInlineMd(text.slice(i + use, close), {
        ...style, bold: style.bold || use >= 2, italic: style.italic || use === 1 || use === 3,
      }));
      i = close + use;
      continue;
    }

    buf += char;
    i++;
  }

  flush();
  return runs;
}

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
 */

/**
 * Convert a markdown file to internal OCR format.
 * @param {Object} params
 * @param {string} params.mdStr - Raw markdown content.
 * @param {?{width: number, height: number}} [params.pageDims] - Page dimensions (defaults to US Letter).
 */
export async function convertDocMd({ mdStr, pageDims = null }) {
  if (!pageDims) pageDims = { width: 612, height: 792 };

  const lines = mdStr.split(/\r?\n/);

  /** @type {Array<MdBlock>} */
  const blocks = [];
  /** @type {?{text: string, type: import('../objects/ocrObjects.js').ParType, fontSize: number, indent: number, parNum: ?string, headingLevel: ?number, sourceStyle: string, bold: boolean}} */
  let openBlock = null;

  const closeBlock = () => {
    if (!openBlock) return;
    const runs = parseInlineMd(openBlock.text, {
      bold: openBlock.bold, italic: false, font: FONT_FAMILY, link: null,
    });
    if (runs.length > 0) {
      blocks.push({
        type: openBlock.type,
        runs,
        fontSize: openBlock.fontSize,
        indent: openBlock.indent,
        parNum: openBlock.parNum,
        headingLevel: openBlock.headingLevel,
        sourceStyle: openBlock.sourceStyle,
        preserveBreaks: false,
      });
    }
    openBlock = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // The contents of a fenced code block are imported verbatim, so the fence is matched before any other construct.
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      closeBlock();
      const closeFence = new RegExp(`^ {0,3}${fenceMatch[1][0]}{${fenceMatch[1].length},}[ \\t]*$`);
      /** @type {Array<MdRun>} */
      const runs = [];
      i++;
      for (; i < lines.length && !closeFence.test(lines[i]); i++) {
        if (runs.length > 0) {
          runs.push({
            text: '\n', bold: false, italic: false, font: CODE_FONT_FAMILY, link: null,
          });
        }
        runs.push({
          text: lines[i].replace(/\t/g, '    '), bold: false, italic: false, font: CODE_FONT_FAMILY, link: null,
        });
      }
      if (runs.length > 0) {
        blocks.push({
          type: 'body',
          runs,
          fontSize: FONT_SIZE,
          indent: LIST_INDENT,
          parNum: null,
          headingLevel: null,
          sourceStyle: 'HTMLPreformatted',
          preserveBreaks: true,
        });
      }
      continue;
    }

    if (!line.trim()) {
      closeBlock();
      continue;
    }

    const headingMatch = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/.exec(line);
    if (headingMatch) {
      closeBlock();
      const level = headingMatch[1].length;
      const runs = parseInlineMd((headingMatch[2] || '').trim(), {
        bold: true, italic: false, font: FONT_FAMILY, link: null,
      });
      if (runs.length > 0) {
        blocks.push({
          type: 'title',
          runs,
          fontSize: HEADING_SIZES[level - 1],
          indent: 0,
          parNum: null,
          headingLevel: level,
          sourceStyle: `Heading${level}`,
          preserveBreaks: false,
        });
      }
      continue;
    }

    // A dashed underline is also a thematic break, so it is claimed as a setext heading before the rule check below sees it.
    const setextMatch = openBlock && openBlock.type === 'body' && !openBlock.parNum ? /^ {0,3}(=+|-+)[ \t]*$/.exec(line) : null;
    if (setextMatch) {
      const level = setextMatch[1][0] === '=' ? 1 : 2;
      openBlock.type = 'title';
      openBlock.headingLevel = level;
      openBlock.sourceStyle = `Heading${level}`;
      openBlock.fontSize = HEADING_SIZES[level - 1];
      openBlock.bold = true;
      closeBlock();
      continue;
    }

    if (/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line)) {
      closeBlock();
      continue;
    }

    const quoteMatch = /^ {0,3}((?:>[ \t]?)+)(.*)$/.exec(line);
    if (quoteMatch) {
      if (!quoteMatch[2].trim()) {
        closeBlock();
      } else if (openBlock && openBlock.type === 'blockquote') {
        openBlock.text += ` ${quoteMatch[2].trim()}`;
      } else {
        closeBlock();
        openBlock = {
          text: quoteMatch[2].trim(),
          type: 'blockquote',
          fontSize: FONT_SIZE,
          indent: QUOTE_INDENT,
          parNum: null,
          headingLevel: null,
          sourceStyle: 'Quote',
          bold: false,
        };
      }
      continue;
    }

    const listMatch = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))[ \t]+(.*)$/.exec(line);
    if (listMatch) {
      closeBlock();
      const depth = Math.min(Math.floor(listMatch[1].replace(/\t/g, '    ').length / 2), 3);
      openBlock = {
        text: listMatch[5].trim(),
        type: 'body',
        fontSize: FONT_SIZE,
        indent: LIST_INDENT * (depth + 1),
        // The bullet character stands in for the source's `-`/`*`/`+`, which is syntax rather than something the reader sees.
        parNum: listMatch[2] ? '•' : `${listMatch[3]}${listMatch[4]}`,
        headingLevel: null,
        sourceStyle: 'ListParagraph',
        bold: false,
      };
      continue;
    }

    if (openBlock) {
      openBlock.text += ` ${line.trim()}`;
    } else {
      openBlock = {
        text: line.trim(),
        type: 'body',
        fontSize: FONT_SIZE,
        indent: 0,
        parNum: null,
        headingLevel: null,
        sourceStyle: 'Normal',
        bold: false,
      };
    }
  }
  closeBlock();

  const pagesOut = [];
  let pageIndex = 0;
  let pageObj = new ocr.OcrPage(pageIndex, pageDims);
  pageObj.textSource = 'md';
  pagesOut.push({ pageObj, dataTables: new LayoutDataTablePage(pageIndex) });

  let currentY = MARGIN_VERTICAL + LINE_HEIGHT / 2;

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
          if (tailStyle.bold !== token.run.bold || tailStyle.italic !== token.run.italic || tailStyle.font !== token.run.font) {
            lastWord.styleRuns = lastWord.styleRuns || [];
            lastWord.styleRuns.push({
              i: lastWord.text.length,
              style: { bold: token.run.bold, italic: token.run.italic, font: token.run.font },
            });
          }
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
        if (token.run.link) wordObj.style.link = token.run.link;
        wordObj.visualCoords = false;
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

  return pagesOut;
}
