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
  const { advanceArr, kerningArr } = calcWordCharMetrics(text, font);

  const advanceTotal = advanceArr.reduce((a, b) => a + b, 0);
  const kerningTotal = kerningArr.reduce((a, b) => a + b, 0);

  const wordLastGlyphMetrics = font.charToGlyph(text.at(-1)).getMetrics();
  const wordFirstGlyphMetrics = font.charToGlyph(text[0]).getMetrics();

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
 * Parse XML text content from a docx run element
 * @param {string} runXml - XML string of a <w:r> element
 * @returns {{text: string, styles: {bold: boolean, italic: boolean, smallCaps: boolean, underline: boolean, sup: boolean, font: string | null}}}
 */
function parseRunElement(runXml) {
  const styles = {
    bold: /<w:b\s*\/>/.test(runXml) || /<w:b\s+w:val="true"/.test(runXml) || /<w:b\s+w:val="1"/.test(runXml),
    italic: /<w:i\s*\/>/.test(runXml) || /<w:i\s+w:val="true"/.test(runXml) || /<w:i\s+w:val="1"/.test(runXml),
    smallCaps: /<w:smallCaps\s*\/>/.test(runXml) || /<w:smallCaps\s+w:val="true"/.test(runXml) || /<w:smallCaps\s+w:val="1"/.test(runXml),
    underline: /<w:u\s+w:val="single"/.test(runXml) || (/<w:u\s*\/>/.test(runXml) && !/<w:u\s+w:val="none"/.test(runXml)),
    sup: /<w:vertAlign\s+w:val="superscript"/.test(runXml),
    font: null,
  };

  // Extract font family from <w:rFonts> element
  const fontMatch = runXml.match(/<w:rFonts\s+[^>]*w:ascii="([^"]+)"/);
  if (fontMatch) {
    styles.font = unescapeXml(fontMatch[1]);
  } else {
    // Try w:hAnsi if ascii not found
    const fontMatchHAnsi = runXml.match(/<w:rFonts\s+[^>]*w:hAnsi="([^"]+)"/);
    if (fontMatchHAnsi) {
      styles.font = unescapeXml(fontMatchHAnsi[1]);
    }
  }

  const textMatches = runXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g);
  let text = '';
  for (const match of textMatches) {
    text += unescapeXml(match[1]);
  }

  return { text, styles };
}

/**
 * Parse paragraphs from docx document.xml content
 * @param {string} docXml - The content of word/document.xml
 * @returns {Array<Array<{text: string, styles: {bold: boolean, italic: boolean, smallCaps: boolean, underline: boolean, sup: boolean, font: string | null}}>>}
 */
function parseParagraphs(docXml) {
  const paragraphs = [];

  const paragraphMatches = docXml.matchAll(/<w:p[^>]*>(.*?)<\/w:p>/gs);

  for (const parMatch of paragraphMatches) {
    const parContent = parMatch[1];
    const runs = [];

    const runMatches = parContent.matchAll(/<w:r[^>]*>(.*?)<\/w:r>/gs);

    for (const runMatch of runMatches) {
      const runContent = runMatch[1];
      const parsed = parseRunElement(runContent);

      if (parsed.text) {
        runs.push(parsed);
      }
    }

    if (runs.length > 0) {
      paragraphs.push(runs);
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
  const { BlobReader, BlobWriter, ZipReader } = await import('../../lib/zip.js/index.js');

  const blob = new Blob([docxData]);

  const zipReader = new ZipReader(new BlobReader(blob));
  const entries = await zipReader.getEntries();

  const documentEntry = entries.find((entry) => entry.filename === 'word/document.xml');
  if (!documentEntry) {
    throw new Error('No word/document.xml found in docx file');
  }

  const writer = new BlobWriter();
  await documentEntry.getData(writer);
  const documentBlob = await writer.getData();
  const documentXml = await documentBlob.text();

  await zipReader.close();

  const pagesOut = await convertDocumentXML({ documentXml, pageDims });

  return pagesOut;
}

/**
 * Convert a docx file to internal OCR format
 * @param {Object} params
 * @param {string} params.documentXml
 * @param {?{width: number, height: number}} [params.pageDims] - Page dimensions (will be calculated if not provided)
 */
const convertDocumentXML = async ({ documentXml, pageDims = null }) => {
  if (!fontOpentype) {
    fontOpentype = (await FontCont.getFont({ font: FONT_FAMILY })).opentype;
  }

  const ASCENDER_HEIGHT = fontOpentype.ascender * (FONT_SIZE / fontOpentype.unitsPerEm);
  const DESCENDER_HEIGHT = fontOpentype.descender * (FONT_SIZE / fontOpentype.unitsPerEm);

  if (!pageDims) {
    pageDims = { width: 612, height: 792 };
  }

  const paragraphs = parseParagraphs(documentXml);

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

    while (runIndex < paragraph.length) {
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

      while (runIndex < paragraph.length && !lineComplete) {
        const run = paragraph[runIndex];
        const remainingText = run.text.substring(charIndexInRun);

        const words = remainingText.split(/(\s+)/);

        for (let wordIdx = 0; wordIdx < words.length; wordIdx++) {
          const word = words[wordIdx];
          if (word.length === 0) continue;

          const isWhitespace = /^\s+$/.test(word);

          if (isWhitespace) {
            const spaceWidth = getTextWidth(' ', FONT_SIZE, fontOpentype) + WORD_SPACING;
            currentX += spaceWidth * word.length;
            charIndexInRun += word.length;
            lastItemWasWhitespace = true;
          } else {
            // Check if we should append to the previous word (word continues across runs)
            // Only append if: we're at the start of a new run AND the last item was NOT whitespace
            const lastWord = lineObj.words[lineObj.words.length - 1];
            const shouldAppend = lastWord && wordIdx === 0 && charIndexInRun === 0 && !lastItemWasWhitespace;

            if (shouldAppend) {
              const combinedText = lastWord.text + word;
              const combinedWidth = getTextWidth(combinedText, FONT_SIZE, fontOpentype);

              if (lastWord.bbox.left + combinedWidth > MARGIN_HORIZONTAL + availableWidth) {
                lineComplete = true;
                break;
              }

              lastWord.text = combinedText;
              lastWord.bbox.right = Math.round(lastWord.bbox.left + combinedWidth);
              currentX = lastWord.bbox.right;
              charIndexInRun += word.length;
            } else {
              const wordWidth = getTextWidth(word, FONT_SIZE, fontOpentype);

              if (lineObj.words.length > 0 && currentX + wordWidth > MARGIN_HORIZONTAL + availableWidth) {
                lineComplete = true;
                break;
              }

              const wordBbox = {
                left: Math.round(currentX),
                top: lineTop,
                right: Math.round(currentX + wordWidth),
                bottom: lineBottom,
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
      for (const ln of parLines) ln.par = parObj;
      pageObj.pars.push(parObj);
    }
  }

  return pagesOut;
};
