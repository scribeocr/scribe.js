import { FontCont } from '../../containers/fontContainer.js';
import ocr from '../../objects/ocrObjects.js';
import { calcWordMetrics } from '../../utils/fontUtils.js';
import { getStyleLookup } from '../../utils/miscUtils.js';

/**
 * @param {number} x
 */
const formatNum = (x) => String(Math.round(x * 1e6) / 1e6);

/**
 *
 * @param {OcrPage} pageObj
 * @param {dims} outputDims
 * @param {Object<string, PdfFontFamily>} pdfFonts
 * @param {("ebook"|"eval"|"proof"|"invis")} textMode -
 * @param {number} angle
 * @param {boolean} rotateText
 * @param {boolean} rotateBackground
 * @param {number} confThreshHigh
 * @param {number} confThreshMed
 */
export async function ocrPageToPDFStream(pageObj, outputDims, pdfFonts, textMode, angle,
  rotateText = false, rotateBackground = false, confThreshHigh = 85, confThreshMed = 75) {
  if (!pageObj || pageObj.lines.length === 0) {
    return { textContentObjStr: '', pdfFontsUsed: new Set() };
  }

  const cosAnglePage = Math.cos(angle * (Math.PI / 180));

  /** @type {Set<PdfFontInfo>} */
  const pdfFontsUsed = new Set();

  const underlines = /** @type {Array<{left: number, right: number, top: number, height: number, fontSize: number, bold: boolean}>} */ ([]);

  // Start 1st object: Text Content
  let textContentObjStr = '';

  if (textMode === 'invis') {
    textContentObjStr += '/GSO0 gs\n';
  } else if (['proof', 'eval'].includes(textMode)) {
    textContentObjStr += '/GSO1 gs\n';
  }

  textContentObjStr += 'BT\n';

  // Move cursor to top of the page
  textContentObjStr += `1 0 0 1 0 ${String(outputDims.height)} Tm\n`;

  let pdfFontNameCurrent = '';
  let pdfFontTypeCurrent = 0;

  for (let i = 0; i < pageObj.lines.length; i++) {
    const lineObj = pageObj.lines[i];
    const { words } = lineObj;

    if (words.length === 0) continue;

    let wordJ = words[0];

    let fillColor = '0 0 0 rg';
    if (textMode === 'proof') {
      if (wordJ.conf > confThreshHigh) {
        fillColor = '0 1 0.5 rg';
      } else if (wordJ.conf > confThreshMed) {
        fillColor = '1 0.8 0 rg';
      } else {
        fillColor = '1 0 0 rg';
      }
    }

    const angleAdjLine = (rotateBackground && Math.abs(angle ?? 0) > 0.05) ? ocr.calcLineStartAngleAdj(lineObj) : { x: 0, y: 0 };

    let fillColorCurrent = fillColor;

    textContentObjStr += `${fillColor}\n`;

    let wordFont = FontCont.getWordFont(wordJ);

    const word0Metrics = calcWordMetrics(wordJ, angle);

    let wordFontSize = word0Metrics.fontSize;

    // Set font and font size
    const pdfFontCurrent = wordJ.lang === 'chi_sim' ? pdfFonts.NotoSansSC.normal : pdfFonts[wordFont.family][getStyleLookup(wordJ.style)];
    pdfFontNameCurrent = pdfFontCurrent.name;
    pdfFontTypeCurrent = pdfFontCurrent.type;
    pdfFontsUsed.add(pdfFontCurrent);

    textContentObjStr += `${pdfFontNameCurrent} ${String(wordFontSize)} Tf\n`;

    // Reset baseline to line baseline
    textContentObjStr += '0 Ts\n';

    const word0LeftBearing = wordJ.visualCoords ? word0Metrics.leftSideBearing : 0;

    let tz = 100;
    if (wordJ.style.dropcap) {
      const wordWidthActual = wordJ.bbox.right - wordJ.bbox.left;
      tz = (wordWidthActual / word0Metrics.visualWidth) * 100;
    }

    // Move to next line
    const lineLeftAdj = wordJ.bbox.left - word0LeftBearing * (tz / 100) + angleAdjLine.x;
    const lineTopAdj = lineObj.bbox.bottom + lineObj.baseline[1] + angleAdjLine.y;

    const lineAngleDeg = Number(rotateText) * angle + 90 * lineObj.orientation;

    const sinAngleTm = Math.sin(lineAngleDeg * (Math.PI / 180));
    const cosAngleTm = Math.cos(lineAngleDeg * (Math.PI / 180));

    if (lineObj.orientation === 1) {
      textContentObjStr += `${formatNum(cosAngleTm)} ${formatNum(-sinAngleTm)} ${formatNum(sinAngleTm)} ${formatNum(cosAngleTm)} ${formatNum(outputDims.width - lineTopAdj + 1)} ${formatNum(outputDims.height - lineLeftAdj)} Tm\n`;
    } else if (lineObj.orientation === 2) {
      textContentObjStr += `${formatNum(cosAngleTm)} ${formatNum(-sinAngleTm)} ${formatNum(sinAngleTm)} ${formatNum(cosAngleTm)} ${formatNum(outputDims.width - lineLeftAdj + 1)} ${formatNum(lineTopAdj)} Tm\n`;
    } else if (lineObj.orientation === 3) {
      textContentObjStr += `${formatNum(cosAngleTm)} ${formatNum(-sinAngleTm)} ${formatNum(sinAngleTm)} ${formatNum(cosAngleTm)} ${formatNum(lineTopAdj)} ${formatNum(lineLeftAdj)} Tm\n`;
    } else {
      textContentObjStr += `${formatNum(cosAngleTm)} ${formatNum(-sinAngleTm)} ${formatNum(sinAngleTm)} ${formatNum(cosAngleTm)} ${formatNum(lineLeftAdj)} ${formatNum(outputDims.height - lineTopAdj + 1)} Tm\n`;
    }

    textContentObjStr += '[ ';

    let wordBoxLast = {
      left: 0, top: 0, right: 0, bottom: 0,
    };
    let wordRightBearingLast = 0;
    let charSpacingLast = 0;
    let spacingAdj = 0;
    let kernSpacing = false;
    let wordLast = wordJ;
    let underlineLeft = /** @type {?number} */ null;
    let underlineRight = /** @type {?number} */ null;
    let wordFontOpentypeLast = wordFont.opentype;
    let fontSizeLast = wordFontSize;
    let tsCurrent = 0;
    let tzCurrent = 100;
    let charLig = false;

    for (let j = 0; j < words.length; j++) {
      wordJ = words[j];

      const wordMetrics = calcWordMetrics(wordJ, angle);
      wordFontSize = wordMetrics.fontSize;
      const charSpacing = wordMetrics.charSpacing;
      const charArr = wordMetrics.charArr;
      const wordLeftBearing = wordJ.visualCoords ? wordMetrics.leftSideBearing : 0;
      const kerningArr = wordMetrics.kerningArr;

      wordFont = FontCont.getWordFont(wordJ);

      fillColor = '0 0 0 rg';
      if (textMode === 'proof') {
        const wordConf = wordJ.conf;

        if (wordConf > confThreshHigh) {
          fillColor = '0 1 0.5 rg';
        } else if (wordConf > confThreshMed) {
          fillColor = '1 0.8 0 rg';
        } else {
          fillColor = '1 0 0 rg';
        }
      } else if (textMode === 'eval') {
        fillColor = wordJ.matchTruth ? '0 1 0.5 rg' : '1 0 0 rg';
      }

      const angleAdjWord = wordJ.style.sup ? ocr.calcWordAngleAdj(wordJ) : { x: 0, y: 0 };
      const angleAdjWordX = (rotateBackground && Math.abs(angle ?? 0) > 0.05) ? angleAdjWord.x : 0;

      let ts = 0;
      if (wordJ.style.sup || wordJ.style.dropcap) {
        ts = (lineObj.bbox.bottom + lineObj.baseline[1] + angleAdjLine.y) - (wordJ.bbox.bottom + angleAdjLine.y + angleAdjWord.y);
        if (!wordJ.visualCoords) {
          const fontDesc = wordFont.opentype.descender / wordFont.opentype.unitsPerEm * wordMetrics.fontSize;
          ts -= fontDesc;
        }
      } else {
        ts = 0;
      }

      // TODO: This probably fails for Chinese, rethink.
      tz = 100;
      if (wordJ.style.dropcap) {
        const wordWidthActual = wordJ.bbox.right - wordJ.bbox.left;
        tz = (wordWidthActual / wordMetrics.visualWidth) * 100;
      }

      const pdfFont = wordJ.lang === 'chi_sim' ? pdfFonts.NotoSansSC.normal : pdfFonts[wordFont.family][getStyleLookup(wordJ.style)];
      const pdfFontName = pdfFont.name;
      const pdfFontType = pdfFont.type;
      pdfFontsUsed.add(pdfFont);

      const wordWidthAdj = (wordJ.bbox.right - wordJ.bbox.left) / cosAnglePage;
      const wordSpaceAdj = (wordJ.bbox.left - wordBoxLast.right) / cosAnglePage;

      // Add space character between words
      if (j > 0 && !kernSpacing) {
        // The space between words determined by:
        // (1) The right bearing of the last word, (2) the left bearing of the current word, (3) the width of the space character between words,
        // (4) the current character spacing value (applied twice--both before and after the space character).
        const spaceAdvance = wordFontOpentypeLast.charToGlyph(' ').advanceWidth || wordFontOpentypeLast.unitsPerEm / 2;
        const spaceWidthGlyph = spaceAdvance * (fontSizeLast / wordFontOpentypeLast.unitsPerEm);

        const wordSpaceExpectedPx = (spaceWidthGlyph + charSpacingLast * 2 + wordRightBearingLast) + wordLeftBearing;

        // Ad-hoc adjustment needed to replicate wordSpace
        // const wordSpaceExtra = (wordSpace + angleSpaceAdjXWord - spaceWidth - charSpacing * 2 - wordLeftBearing - wordRightBearingLast + spacingAdj);
        const wordSpaceExtraPx = (wordSpaceAdj - wordSpaceExpectedPx + spacingAdj + angleAdjWordX) * (100 / tzCurrent);

        if (pdfFontTypeCurrent === 0) {
          const spaceChar = wordFont.opentype.charToGlyphIndex(' ').toString(16).padStart(4, '0');
          textContentObjStr += `<${spaceChar}> ${String(Math.round(wordSpaceExtraPx * (-1000 / fontSizeLast) * 1e6) / 1e6)}`;
        } else {
          textContentObjStr += `( ) ${String(Math.round(wordSpaceExtraPx * (-1000 / fontSizeLast) * 1e6) / 1e6)}`;
        }
      }
      kernSpacing = false;

      wordBoxLast = wordJ.bbox;

      // In general, we assume that (given our adjustments to character spacing) the rendered word has the same width as the image of that word.
      // However, this assumption does not hold for single-character words, as there is no space between character to adjust.
      // Therefore, we calculate the difference between the rendered and actual word and apply an adjustment to the width of the next space.
      // (This does not apply to drop caps as those have horizontal scaling applied to exactly match the image.)
      if (charArr.length === 1 && !wordJ.style.dropcap) {
        const wordLastGlyph = wordFont.opentype.charToGlyph(charArr.at(-1));
        const wordLastGlyphMetrics = wordLastGlyph.getMetrics();
        const lastCharAdvance = wordLast.visualCoords ? (wordLastGlyphMetrics.xMax - wordLastGlyphMetrics.xMin) : wordLastGlyph.advanceWidth || wordFont.opentype.unitsPerEm / 2;
        const lastCharWidth = lastCharAdvance * (wordFontSize / wordFont.opentype.unitsPerEm);
        spacingAdj = wordWidthAdj - lastCharWidth - angleAdjWordX;
      } else {
        spacingAdj = 0 - angleAdjWordX;
      }

      textContentObjStr += ' ] TJ\n';

      const fontSize = wordJ.style.smallCaps && wordJ.text[0] && wordJ.text[0] !== wordJ.text[0].toUpperCase() ? wordFontSize * wordFont.smallCapsMult : wordFontSize;
      if (pdfFontName !== pdfFontNameCurrent || fontSize !== fontSizeLast) {
        textContentObjStr += `${pdfFontName} ${String(fontSize)} Tf\n`;
        pdfFontNameCurrent = pdfFontName;
        pdfFontTypeCurrent = pdfFontType;
        fontSizeLast = fontSize;
      }
      if (fillColor !== fillColorCurrent) {
        textContentObjStr += `${fillColor}\n`;
        fillColorCurrent = fillColor;
      }
      if (ts !== tsCurrent) {
        textContentObjStr += `${String(ts)} Ts\n`;
        tsCurrent = ts;
      }
      if (tz !== tzCurrent) {
        textContentObjStr += `${String(tz)} Tz\n`;
        tzCurrent = tz;
      }

      textContentObjStr += `${String(Math.round(charSpacing * 1e6) / 1e6)} Tc\n`;

      textContentObjStr += '[ ';

      // Non-ASCII and special characters are encoded/escaped using winEncodingLookup
      for (let k = 0; k < charArr.length; k++) {
        const letterSrc = charArr[k];
        const letter = wordJ.style.smallCaps ? charArr[k].toUpperCase() : charArr[k];
        const fontSizeLetter = wordJ.style.smallCaps && letterSrc !== letter ? wordFontSize * wordFont.smallCapsMult : wordFontSize;

        // Encoding needs to come from `pdfFont`, not `wordFont`, as the `pdfFont` will have a different index when subset.
        const letterEnc = pdfFontTypeCurrent === 0 ? pdfFont.opentype.charToGlyphIndex(letter)?.toString(16).padStart(4, '0') : winEncodingLookup[letter];
        if (letterEnc) {
          let kern = (kerningArr[k] || 0) * (-1000 / fontSizeLetter);

          if (wordJ.lang === 'chi_sim' && j + 1 < words.length && words[j + 1].lang === 'chi_sim') {
            kernSpacing = true;
            const wordNext = words[j + 1];
            const wordSpaceNextAdj = (wordNext.bbox.left - wordJ.bbox.right) / cosAngleTm;
            // const wordSpaceNextAdj = wordNext.bbox.left - wordBox.right;

            const wordGlyph = wordFont.opentype.charToGlyph(charArr.at(-1));
            const wordGlyphMetrics = wordGlyph.getMetrics();
            const wordNextGlyphMetrics = wordFont.opentype.charToGlyph(wordNext.text.substr(0, 1)).getMetrics();

            const wordRightBearing = wordJ.visualCoords ? (wordGlyph.advanceWidth - wordGlyphMetrics.xMax) * (wordFontSize / wordFont.opentype.unitsPerEm) : 0;

            const wordNextLeftBearing = wordNext.visualCoords ? wordNextGlyphMetrics.xMin * (wordFontSize / wordFont.opentype.unitsPerEm) : 0;

            const wordSpaceExpected = charSpacing + wordRightBearing + wordNextLeftBearing;

            kern = Math.round((wordSpaceNextAdj - wordSpaceExpected + spacingAdj + angleAdjWordX) * (-1000 / wordFontSize));
          }

          // PDFs render text based on a "widths" PDF object, rather than the advance width in the embedded font file.
          // The widths are in 1/1000 of a unit, and this PDF object is created by mupdf.
          // The widths output in this object are converted to integers, which creates a rounding error when the font em size is not 1000.
          // All built-in fonts are already 1000 to avoid this, however custom fonts may not be.
          // This results in a small rounding error for the advance of each character, which adds up, as PDF positioning is cumulative.
          // To correct for this, the error is calculated and added to the kerning value.
          const charAdvance = wordFont.opentype.charToGlyph(letter).advanceWidth;
          const charWidthPdfPrecise = charAdvance * (1000 / wordFont.opentype.unitsPerEm);
          const charWidthPdfRound = Math.floor(charWidthPdfPrecise);
          const charWidthError = charWidthPdfRound - charWidthPdfPrecise;

          const charAdj = kern + charWidthError;

          if (pdfFontName !== pdfFontNameCurrent || fontSizeLetter !== fontSizeLast) {
            textContentObjStr += ' ] TJ\n';
            textContentObjStr += `${pdfFontName} ${String(fontSizeLetter)} Tf\n`;
            fontSizeLast = fontSizeLetter;
            textContentObjStr += `${String(Math.round(charSpacing * 1e6) / 1e6)} Tc\n`;
            textContentObjStr += '[ ';
          }

          if (pdfFontTypeCurrent === 0) {
            textContentObjStr += `<${letterEnc}> ${String(Math.round(charAdj * 1e6) / 1e6)} `;
          } else {
            textContentObjStr += `(${letterEnc}) ${String(Math.round(kern * 1e6) / 1e6)} `;
          }

          if (charLig) {
            k++;
            charLig = false;
          }
        } else {
          // When the requested character could not be found, a space is inserted, with extra space to match the width of the missing character
          const kern = (wordFont.opentype.charToGlyph(letter).advanceWidth - wordFont.opentype.charToGlyph(' ').advanceWidth) * (-1000 / wordFont.opentype.unitsPerEm) || 0;

          if (pdfFontTypeCurrent === 0) {
            const spaceChar = wordFont.opentype.charToGlyphIndex(' ').toString(16).padStart(4, '0');
            textContentObjStr += `<${spaceChar}> ${String(Math.round(kern * 1e6) / 1e6)} `;
          } else {
            textContentObjStr += `( ) ${String(Math.round(kern * 1e6) / 1e6)} `;
          }
        }
      }

      if (wordJ.style.underline && underlineLeft === null) {
        underlineLeft = wordJ.bbox.left;
      }

      if (wordJ.style.underline) {
        underlineRight = wordJ.bbox.right;
      }

      if (underlineLeft !== null && (!wordJ.style.underline || j === words.length - 1)) {
        underlines.push({
          left: underlineLeft,
          right: underlineRight,
          top: lineTopAdj,
          height: lineObj.bbox.bottom - lineObj.bbox.top,
          fontSize: wordFontSize,
          bold: wordJ.style.bold,
        });

        underlineLeft = null;
        underlineRight = null;
      }

      wordLast = wordJ;
      wordRightBearingLast = wordLast.visualCoords ? wordMetrics.rightSideBearing : 0;
      wordFontOpentypeLast = wordFont.opentype;
      charSpacingLast = charSpacing;
    }

    textContentObjStr += ' ] TJ\n';
  }

  textContentObjStr += 'ET';

  // Add underlines
  underlines.forEach((underline) => {
    const underlineThickness = underline.bold ? Math.ceil(underline.fontSize / 12) : Math.ceil(underline.fontSize / 24);
    const underlineOffset = Math.ceil(underline.fontSize / 12) + underlineThickness;

    textContentObjStr += `\n${String(underline.left)} ${String(outputDims.height - underline.top - underlineOffset)} ${String(underline.right - underline.left)} ${underlineThickness} re\nf\n`;
  });

  return { textContentObjStr, pdfFontsUsed };
}
