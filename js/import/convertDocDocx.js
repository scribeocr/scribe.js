import ocr from '../objects/ocrObjects.js';
import { LayoutDataTablePage } from '../objects/layoutObjects.js';
import { calcWordCharMetrics } from '../utils/fontUtils.js';
import { FontCont } from '../containers/fontContainer.js';
import { unescapeXml } from '../utils/miscUtils.js';

const FONT_FAMILY = 'Times New Roman';
const FONT_SIZE = 14;
const CHAR_SPACING = 0;
const WORD_SPACING = 0;
const LINE_HEIGHT = 14.4;
const MARGIN_VERTICAL = 30;
const MARGIN_HORIZONTAL = 20;

/** @type {?opentype.Font} */
let fontOpentype = null;

/**
 * Calculates the advance of a string in pixels.
 * @param {string} text
 * @param {number} size
 * @param {opentype.Font} font
 */
function getTextWidth(text, size, font) {
  const charMetrics = calcWordCharMetrics(text, font);

  const advanceTotal = charMetrics.advanceArr.reduce((a, b) => a + b, 0);
  const kerningTotal = charMetrics.kerningArr.reduce((a, b) => a + b, 0);

  const wordLastGlyphMetrics = font.charToGlyph(text.at(-1)).getMetrics();
  const wordFirstGlyphMetrics = font.charToGlyph(text[0]).getMetrics();

  const wordLeftBearing = wordFirstGlyphMetrics.xMin || 0;
  const lastGlyphMax = wordLastGlyphMetrics.xMax || 0;
  const wordRightBearing = charMetrics.advanceArr[charMetrics.advanceArr.length - 1] - lastGlyphMax;

  const wordWidth1 = (advanceTotal + kerningTotal - wordLeftBearing - wordRightBearing);
  const wordWidth1Px = wordWidth1 * (size / font.unitsPerEm);
  const spacingTotalPx = (text.length - 1) * CHAR_SPACING;
  const wordWidth = wordWidth1Px + spacingTotalPx;

  return wordWidth;
}

/**
 * @typedef {Object} StyleInfo
 * @property {number | null} fontSize - Font size in points
 * @property {string | null} font - Font family name
 * @property {boolean} bold
 * @property {boolean} italic
 */

/**
 * @typedef {Object} ParsedStyles
 * @property {Map<string, StyleInfo>} styles - Map of style ID to style properties
 * @property {number | null} defaultFontSize - Default font size from docDefaults in points
 */

/**
 * Parse styles.xml from docx to extract style definitions
 * @param {string} stylesXml - The content of word/styles.xml
 * @returns {ParsedStyles} Parsed styles including default font size
 */
export function parseStyles(stylesXml) {
  /** @type {Map<string, StyleInfo>} */
  const styles = new Map();
  let defaultFontSize = null;

  const docDefaultsMatch = stylesXml.match(/<w:docDefaults>.*?<\/w:docDefaults>/s);
  if (docDefaultsMatch) {
    const defaultSzMatch = docDefaultsMatch[0].match(/<w:sz\s+w:val="(\d+)"/);
    if (defaultSzMatch) {
      defaultFontSize = parseInt(defaultSzMatch[1], 10) / 2;
    }
  }

  const styleMatches = stylesXml.matchAll(/<w:style\s+[^>]*w:styleId="([^"]+)"[^>]*>(.*?)<\/w:style>/gs);

  for (const styleMatch of styleMatches) {
    const styleId = styleMatch[1];
    const styleContent = styleMatch[2];

    /** @type {StyleInfo} */
    const styleInfo = {
      fontSize: null,
      font: null,
      bold: false,
      italic: false,
    };

    const szMatch = styleContent.match(/<w:sz\s+w:val="(\d+)"/);
    if (szMatch) {
      styleInfo.fontSize = parseInt(szMatch[1], 10) / 2;
    }

    const fontMatch = styleContent.match(/<w:rFonts\s+[^>]*w:ascii="([^"]+)"/);
    if (fontMatch) {
      styleInfo.font = unescapeXml(fontMatch[1]);
    }

    styleInfo.bold = /<w:b\s*\/>/.test(styleContent) || /<w:b\s+w:val="true"/.test(styleContent) || /<w:b\s+w:val="1"/.test(styleContent);

    styleInfo.italic = /<w:i\s*\/>/.test(styleContent) || /<w:i\s+w:val="true"/.test(styleContent) || /<w:i\s+w:val="1"/.test(styleContent);

    styles.set(styleId, styleInfo);
  }

  return { styles, defaultFontSize };
}

/**
 * @typedef {Object} RunStyles
 * @property {boolean} bold
 * @property {boolean} italic
 * @property {boolean} smallCaps
 * @property {boolean} underline
 * @property {boolean} sup
 * @property {string | null} font
 * @property {number | null} fontSize
 */

/**
 * Parse XML text content docx run element (<w:r>)
 * @param {string} runXml
 * @returns {{text: string, styles: RunStyles}}
 */
function parseRunElement(runXml) {
  /** @type {RunStyles} */
  const styles = {
    bold: /<w:b\s*\/>/.test(runXml) || /<w:b\s+w:val="true"/.test(runXml) || /<w:b\s+w:val="1"/.test(runXml),
    italic: /<w:i\s*\/>/.test(runXml) || /<w:i\s+w:val="true"/.test(runXml) || /<w:i\s+w:val="1"/.test(runXml),
    smallCaps: /<w:smallCaps\s*\/>/.test(runXml) || /<w:smallCaps\s+w:val="true"/.test(runXml) || /<w:smallCaps\s+w:val="1"/.test(runXml),
    underline: /<w:u\s+w:val="single"/.test(runXml) || (/<w:u\s*\/>/.test(runXml) && !/<w:u\s+w:val="none"/.test(runXml)),
    sup: /<w:vertAlign\s+w:val="superscript"/.test(runXml),
    font: null,
    fontSize: null,
  };

  const fontMatch = runXml.match(/<w:rFonts\s+[^>]*w:ascii="([^"]+)"/);
  if (fontMatch) {
    styles.font = unescapeXml(fontMatch[1]);
  } else {
    const fontMatchHAnsi = runXml.match(/<w:rFonts\s+[^>]*w:hAnsi="([^"]+)"/);
    if (fontMatchHAnsi) {
      styles.font = unescapeXml(fontMatchHAnsi[1]);
    }
  }

  const szMatch = runXml.match(/<w:sz\s+w:val="(\d+)"/);
  if (szMatch) {
    styles.fontSize = parseInt(szMatch[1], 10) / 2;
  }

  const textMatches = runXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g);
  let text = '';
  for (const match of textMatches) {
    text += unescapeXml(match[1]);
  }

  return { text, styles };
}

/**
 * Parse footnotes from docx footnotes.xml content
 * @param {string} footnotesXml
 * @returns {Map<string, Array<{text: string, styles: RunStyles}>>}
 */
export function parseFootnotes(footnotesXml) {
  /** @type {Map<string, Array<{text: string, styles: RunStyles}>>} */
  const footnotes = new Map();

  const footnoteMatches = footnotesXml.matchAll(/<w:footnote\s+[^>]*w:id="([^"]+)"[^>]*>(.*?)<\/w:footnote>/gs);

  for (const footnoteMatch of footnoteMatches) {
    const footnoteId = footnoteMatch[1];
    const footnoteContent = footnoteMatch[2];

    // Skip separator footnotes (id -1 and 0 are typically separators)
    if (footnoteId === '-1' || footnoteId === '0') continue;

    const runs = [];
    const runMatches = footnoteContent.matchAll(/<w:r[^>]*>(.*?)<\/w:r>/gs);

    for (const runMatch of runMatches) {
      const runContent = runMatch[1];

      // Skip footnote reference markers (<w:footnoteRef/>)
      if (/<w:footnoteRef\s*\/>/.test(runContent)) continue;

      const parsed = parseRunElement(runContent);
      if (parsed.text) {
        runs.push(parsed);
      }
    }

    if (runs.length > 0) {
      footnotes.set(footnoteId, runs);
    }
  }

  return footnotes;
}

/**
 * @typedef {'title' | 'body' | 'footnote'} ParType
 */

/**
 * @typedef {Object} ParsedParagraph
 * @property {Array<{text: string, styles: RunStyles}>} runs
 * @property {ParType} type
 */

/**
 * Parse paragraphs from docx document.xml content
 * @param {string} docXml
 * @param {Map<string, Array<{text: string, styles: RunStyles}>>} [footnotesMap]
 * @param {Map<string, StyleInfo>} [stylesMap]
 * @param {number | null} [defaultFontSize]
 * @returns {Array<ParsedParagraph>}
 */
export function parseParagraphs(docXml, footnotesMap = new Map(), stylesMap = new Map(), defaultFontSize = null) {
  /** @type {Array<ParsedParagraph>} */
  const paragraphs = [];
  /** @type {Array<string>} */
  const footnoteOrder = [];

  const paragraphMatches = docXml.matchAll(/<w:p[^>]*>(.*?)<\/w:p>/gs);

  for (const parMatch of paragraphMatches) {
    const parContent = parMatch[1];
    /** @type {Array<{text: string, styles: RunStyles}>} */
    const runs = [];

    const pStyleMatch = parContent.match(/<w:pStyle\s+w:val="([^"]+)"/);
    const styleId = pStyleMatch ? pStyleMatch[1] : null;
    /** @type {ParType} */
    let parType = 'body';
    if (styleId) {
      const styleName = styleId.toLowerCase();
      if (styleName === 'title' || styleName.startsWith('heading') || styleName.startsWith('toc')) {
        parType = 'title';
      }
    }

    const parStyle = styleId ? stylesMap.get(styleId) : null;

    const runMatches = parContent.matchAll(/<w:r[^>]*>(.*?)<\/w:r>/gs);

    for (const runMatch of runMatches) {
      const runContent = runMatch[1];

      const footnoteRefMatch = runContent.match(/<w:footnoteReference\s+[^>]*w:id="([^"]+)"/);
      if (footnoteRefMatch) {
        const footnoteId = footnoteRefMatch[1];
        if (footnotesMap.has(footnoteId) && !footnoteOrder.includes(footnoteId)) {
          footnoteOrder.push(footnoteId);
        }
        // Add a superscript marker for the footnote number
        const footnoteIndex = footnoteOrder.indexOf(footnoteId) + 1;
        runs.push({
          text: String(footnoteIndex),
          styles: {
            bold: false,
            italic: false,
            smallCaps: false,
            underline: false,
            sup: true,
            font: null,
            fontSize: null,
          },
        });
        continue;
      }

      const parsed = parseRunElement(runContent);

      if (parsed.text) {
        if (parsed.styles.fontSize === null) {
          if (parStyle?.fontSize) {
            parsed.styles.fontSize = parStyle.fontSize;
          } else if (defaultFontSize !== null) {
            parsed.styles.fontSize = defaultFontSize;
          }
        }
        runs.push(parsed);
      }
    }

    if (runs.length > 0) {
      paragraphs.push({ runs, type: parType });
    }
  }

  if (footnoteOrder.length > 0) {
    const footnoteTextStyle = stylesMap.get('FootnoteText');
    const footnoteFontSize = footnoteTextStyle?.fontSize ?? defaultFontSize;

    for (const footnoteId of footnoteOrder) {
      const footnoteRuns = footnotesMap.get(footnoteId);
      if (footnoteRuns) {
        const footnoteIndex = footnoteOrder.indexOf(footnoteId) + 1;
        // Add footnote number as superscript at the start
        // TODO: This should be handled by the rendering functions.
        /** @type {Array<{text: string, styles: RunStyles}>} */
        const footnoteParagraphRuns = [
          {
            text: String(footnoteIndex),
            styles: {
              bold: false,
              italic: false,
              smallCaps: false,
              underline: false,
              sup: true,
              font: null,
              fontSize: footnoteFontSize,
            },
          },
          {
            text: ' ',
            styles: {
              bold: false,
              italic: false,
              smallCaps: false,
              underline: false,
              sup: false,
              font: null,
              fontSize: footnoteFontSize,
            },
          },
        ];

        for (const run of footnoteRuns) {
          const runWithSize = {
            text: run.text,
            styles: {
              ...run.styles,
              fontSize: run.styles.fontSize ?? footnoteFontSize,
            },
          };
          footnoteParagraphRuns.push(runWithSize);
        }

        paragraphs.push({ runs: footnoteParagraphRuns, type: 'footnote' });
      }
    }
  }

  return paragraphs;
}

/**
 * Convert a docx file to internal OCR format
 * @param {Object} params
 * @param {ArrayBuffer} params.docxData - The docx file data
 * @param {?{width: number, height: number}} [params.pageDims] - Page dimensions (will be calculated if not provided)
 */
export async function convertDocDocx({ docxData, pageDims = null }) {
  const zipModule = await import('../../lib/zip.js/index.js');

  const blob = new Blob([docxData]);

  const zipReader = new zipModule.ZipReader(new zipModule.BlobReader(blob));
  const entries = await zipReader.getEntries();

  const documentEntry = entries.find((entry) => entry.filename === 'word/document.xml');
  if (!documentEntry) {
    throw new Error('No word/document.xml found in docx file');
  }

  const writer = new zipModule.BlobWriter();
  await documentEntry.getData(writer);
  const documentBlob = await writer.getData();
  const documentXml = await documentBlob.text();

  // Read footnotes.xml if it exists
  let footnotesXml = null;
  const footnotesEntry = entries.find((entry) => entry.filename === 'word/footnotes.xml');
  if (footnotesEntry) {
    const footnotesWriter = new zipModule.BlobWriter();
    await footnotesEntry.getData(footnotesWriter);
    const footnotesBlob = await footnotesWriter.getData();
    footnotesXml = await footnotesBlob.text();
  }

  // Read styles.xml if it exists
  let stylesXml = null;
  const stylesEntry = entries.find((entry) => entry.filename === 'word/styles.xml');
  if (stylesEntry) {
    const stylesWriter = new zipModule.BlobWriter();
    await stylesEntry.getData(stylesWriter);
    const stylesBlob = await stylesWriter.getData();
    stylesXml = await stylesBlob.text();
  }

  await zipReader.close();

  const pagesOut = await convertDocumentXML({
    documentXml, footnotesXml, stylesXml, pageDims,
  });

  return pagesOut;
}

/**
 * Convert a docx file to internal OCR format
 * @param {Object} params
 * @param {string} params.documentXml
 * @param {?string} [params.footnotesXml] - The content of word/footnotes.xml (optional)
 * @param {?string} [params.stylesXml] - The content of word/styles.xml (optional)
 * @param {?{width: number, height: number}} [params.pageDims] - Page dimensions (will be calculated if not provided)
 */
const convertDocumentXML = async ({
  documentXml, footnotesXml = null, stylesXml = null, pageDims = null,
}) => {
  if (!fontOpentype) {
    fontOpentype = (await FontCont.getFont({ font: FONT_FAMILY })).opentype;
  }

  const ASCENDER_HEIGHT = fontOpentype.ascender * (FONT_SIZE / fontOpentype.unitsPerEm);
  const DESCENDER_HEIGHT = fontOpentype.descender * (FONT_SIZE / fontOpentype.unitsPerEm);

  if (!pageDims) {
    pageDims = { width: 612, height: 792 };
  }

  const footnotesMap = footnotesXml ? parseFootnotes(footnotesXml) : new Map();
  const parsedStyles = stylesXml ? parseStyles(stylesXml) : { styles: new Map(), defaultFontSize: null };

  const paragraphs = parseParagraphs(documentXml, footnotesMap, parsedStyles.styles, parsedStyles.defaultFontSize);

  const pagesOut = [];
  let pageIndex = 0;
  let pageObj = new ocr.OcrPage(pageIndex, pageDims);
  pageObj.textSource = 'docx';
  let tablesPage = new LayoutDataTablePage(0);
  pagesOut.push({ pageObj, dataTables: tablesPage });

  const availableWidth = pageDims.width - MARGIN_HORIZONTAL * 2;
  let currentY = MARGIN_VERTICAL + LINE_HEIGHT / 2;

  for (const paragraph of paragraphs) {
    const parLines = [];
    let parRight = MARGIN_HORIZONTAL;
    let runIndex = 0;
    let charIndexInRun = 0;
    const parRuns = paragraph.runs;
    const parType = paragraph.type;

    while (runIndex < parRuns.length) {
      if (currentY + FONT_SIZE > pageDims.height - MARGIN_VERTICAL) {
        if (parLines.length > 0) {
          const parBbox = {
            left: MARGIN_HORIZONTAL,
            top: parLines[0].bbox.top,
            right: parRight,
            bottom: parLines[parLines.length - 1].bbox.bottom,
          };
          const parObj = new ocr.OcrPar(pageObj, parBbox);
          parObj.lines = parLines;
          parObj.type = parType;
          for (const ln of parLines) ln.par = parObj;
          pageObj.pars.push(parObj);
          parLines.length = 0;
          parRight = MARGIN_HORIZONTAL;
        }
        pageIndex++;
        const newPage = new ocr.OcrPage(pageIndex, pageDims);
        newPage.textSource = 'docx';
        const newTables = new LayoutDataTablePage(pageIndex);
        pagesOut.push({ pageObj: newPage, dataTables: newTables });
        pageObj = newPage;
        tablesPage = newTables;
        currentY = MARGIN_VERTICAL + LINE_HEIGHT / 2;
      }

      const baseline = [0, DESCENDER_HEIGHT];
      const lineTop = Math.round(currentY - ASCENDER_HEIGHT);
      const lineBottom = Math.round(currentY + DESCENDER_HEIGHT);

      const lineBbox = {
        left: MARGIN_HORIZONTAL,
        top: lineTop,
        right: MARGIN_HORIZONTAL,
        bottom: lineBottom,
      };
      const lineObj = new ocr.OcrLine(
        pageObj,
        lineBbox,
        baseline,
        ASCENDER_HEIGHT,
        null,
      );

      let currentX = MARGIN_HORIZONTAL;
      let lineComplete = false;
      let lastItemWasWhitespace = false;

      while (runIndex < parRuns.length && !lineComplete) {
        const run = parRuns[runIndex];
        const remainingText = run.text.substring(charIndexInRun);

        const words = remainingText.split(/(\s+)/);

        for (let wordIdx = 0; wordIdx < words.length; wordIdx++) {
          const word = words[wordIdx];
          if (word.length === 0) continue;

          const isWhitespace = /^\s+$/.test(word);

          if (isWhitespace) {
            const runFontSize = run.styles.fontSize || FONT_SIZE;
            const spaceWidth = getTextWidth(' ', runFontSize, fontOpentype) + WORD_SPACING;
            currentX += spaceWidth * word.length;
            charIndexInRun += word.length;
            lastItemWasWhitespace = true;
          } else {
            const runFontSize = run.styles.fontSize || FONT_SIZE;

            // Check if we should append to the previous word (word continues across runs)
            // Only append if: we're at the start of a new run AND the last item was NOT whitespace
            const lastWord = lineObj.words[lineObj.words.length - 1];
            const stylesMatch = lastWord && lastWord.style.sup === run.styles.sup && lastWord.style.size === run.styles.fontSize;
            const shouldAppend = lastWord && wordIdx === 0 && charIndexInRun === 0 && !lastItemWasWhitespace && stylesMatch;

            if (shouldAppend) {
              const combinedText = lastWord.text + word;
              const combinedWidth = getTextWidth(combinedText, runFontSize, fontOpentype);

              if (lastWord.bbox.left + combinedWidth > MARGIN_HORIZONTAL + availableWidth) {
                lineComplete = true;
                break;
              }

              lastWord.text = combinedText;
              lastWord.bbox.right = Math.round(lastWord.bbox.left + combinedWidth);
              currentX = lastWord.bbox.right;
              charIndexInRun += word.length;
            } else {
              // Superscripts are typically rendered at ~60% of normal font size
              const supFontSizeRatio = 0.6;
              const effectiveFontSize = run.styles.sup ? runFontSize * supFontSizeRatio : runFontSize;
              const wordWidth = getTextWidth(word, effectiveFontSize, fontOpentype);

              if (lineObj.words.length > 0 && currentX + wordWidth > MARGIN_HORIZONTAL + availableWidth) {
                lineComplete = true;
                break;
              }

              const wordAscenderHeight = fontOpentype.ascender * (runFontSize / fontOpentype.unitsPerEm);
              const wordDescenderHeight = fontOpentype.descender * (runFontSize / fontOpentype.unitsPerEm);

              // For superscripts, adjust vertical position to be above the baseline
              // The baseline is at currentY (from DESCENDER_HEIGHT), so superscripts should be above it
              let wordTop = Math.round(currentY - wordAscenderHeight);
              let wordBottom = Math.round(currentY + wordDescenderHeight);
              if (run.styles.sup) {
                // Superscript height is proportional to the reduced font size
                const supHeight = wordAscenderHeight * supFontSizeRatio;
                // Position superscript with its bottom at the x-height (roughly 70% of ascender)
                const xHeight = wordAscenderHeight * 0.7;
                wordBottom = Math.round(currentY - xHeight);
                wordTop = Math.round(wordBottom - supHeight);
              }

              const wordBbox = {
                left: Math.round(currentX),
                top: wordTop,
                right: Math.round(currentX + wordWidth),
                bottom: wordBottom,
              };
              const wordId = `word_${pageIndex + 1}_${pageObj.lines.length + 1}_${lineObj.words.length + 1}`;
              const wordObj = new ocr.OcrWord(lineObj, wordId, word, wordBbox);
              wordObj.conf = 100;
              wordObj.style.font = run.styles.font || FONT_FAMILY;

              wordObj.style.bold = run.styles.bold;
              wordObj.style.italic = run.styles.italic;
              wordObj.style.smallCaps = run.styles.smallCaps;
              wordObj.style.underline = run.styles.underline;
              wordObj.style.sup = run.styles.sup;
              wordObj.style.size = run.styles.fontSize;

              lineObj.words.push(wordObj);
              currentX += wordWidth;
              charIndexInRun += word.length;
            }
            lastItemWasWhitespace = false;
          }
        }

        if (charIndexInRun >= run.text.length) {
          runIndex++;
          charIndexInRun = 0;
        }

        if (lineComplete) break;
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

      currentY += LINE_HEIGHT;
    }

    if (parLines.length > 0) {
      const parBbox = {
        left: MARGIN_HORIZONTAL,
        top: parLines[0].bbox.top,
        right: parRight,
        bottom: parLines[parLines.length - 1].bbox.bottom,
      };
      const parObj = new ocr.OcrPar(pageObj, parBbox);
      parObj.lines = parLines;
      parObj.type = parType;
      for (const ln of parLines) ln.par = parObj;
      pageObj.pars.push(parObj);
    }
  }

  return pagesOut;
};
