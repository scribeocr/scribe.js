import ocr from '../../objects/ocrObjects.js';
import { calcWordMetrics } from '../../utils/fontUtils.js';
import { getStyleLookup } from '../../utils/miscUtils.js';

/** @typedef {import('../../containers/fontContainer.js').DocFonts} DocFonts */

/**
 * @param {number} x
 */
const formatNum = (x) => String(Math.round(x * 1e6) / 1e6);

// Largest character spacing (Tc), as a fraction of font size, any word may keep before switching to a wider font variant.
// This value is lower than it theoretically needs to be because we only estimate the true value, not taking kerning into account.
const MAX_WORD_TC_RATIO = 0.05;

/**
 *
 * @param {OcrPage} pageObj
 * @param {dims} outputDims
 * @param {Object<string, PdfFontFamily>} pdfFonts
 * @param {('ebook'|'eval'|'proof'|'invis'|'annot')} textMode -
 * @param {number} angle
 * @param {DocFonts} [docFonts] - Per-document fonts.
 * @param {boolean} rotateText
 * @param {boolean} rotateBackground
 * @param {number} confThreshHigh
 * @param {number} confThreshMed
 */
export async function ocrPageToPDFStream(pageObj, outputDims, pdfFonts, textMode, angle, docFonts,
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
    const words = lineObj.words.filter((w) => w.text);

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

    let wordFont = docFonts.getWordFont(wordJ);

    const word0Metrics = calcWordMetrics(wordJ, docFonts, angle);

    let wordFontSize = word0Metrics.fontSize;

    // Set font and font size
    const pdfFontCurrent = wordJ.lang === 'chi_sim' ? pdfFonts.NotoSansSC.normal : pdfFonts[wordFont.family][getStyleLookup(wordJ.style)];
    pdfFontNameCurrent = pdfFontCurrent.name;
    pdfFontTypeCurrent = pdfFontCurrent.type;
    // The subset font will have a different glyph index mapping than the un-subset opentype font,
    // so we need to keep track of both.
    let pdfFontOpentypeCurrent = pdfFontCurrent.opentype;
    // A width-scaled variant declares wider advances than its shared base outlines,
    // so the export-font advance reads below multiply by the active variant's scale (1 for a base font).
    let pdfFontScaleCurrent = pdfFontCurrent.widthScale || 1;
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
    let fontSizeLast = wordFontSize;
    let tsCurrent = 0;
    let tzCurrent = 100;
    let charLig = false;

    for (let j = 0; j < words.length; j++) {
      wordJ = words[j];

      const wordMetrics = calcWordMetrics(wordJ, docFonts, angle);
      wordFontSize = wordMetrics.fontSize;
      const charSpacing = wordMetrics.charSpacing;
      const charArr = wordMetrics.charArr;
      const wordLeftBearing = wordJ.visualCoords ? wordMetrics.leftSideBearing : 0;
      const kerningArr = wordMetrics.kerningArr;

      wordFont = docFonts.getWordFont(wordJ);

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

      let pdfFont = wordJ.lang === 'chi_sim' ? pdfFonts.NotoSansSC.normal : pdfFonts[wordFont.family][getStyleLookup(wordJ.style)];

      // Style runs resolve to per-segment fonts inside the glyph loop below.
      const styleSegments = wordJ.lang === 'chi_sim' ? null : ocr.getWordStyleSegments(wordJ);
      let segmentIdx = 0;

      // When the per-character spacing needed to fit this word in its box is large enough that a viewer would break the word while extracting its text,
      // switch to the smallest width-scaled font variant that folds the stretch into the glyphs' declared widths, leaving only a sub-threshold residual Tc.
      // The word still renders at the same overall width, with the stretch carried by wider advances instead of Tc.
      // Latin only: chi_sim uses full-width glyphs and a separate inter-word kern path.
      // Words with style runs also keep the base fonts, since a width variant only exists for the word's own style.
      // (visualCoords words are negligible here, so the residual is computed from the advance sum directly rather than re-deriving bearings.)
      let emitCharSpacing = charSpacing;
      if (pdfFont.type === 0 && wordJ.lang !== 'chi_sim' && !styleSegments && charArr.length > 1 && pdfFont.widthVariants) {
        const thresholdPx = MAX_WORD_TC_RATIO * wordFontSize;
        if (charSpacing > thresholdPx) {
          const gaps = charArr.length - 1;
          const advanceTotalPx = wordMetrics.advanceArr.reduce((a, b) => a + b, 0);
          if (advanceTotalPx > 0) {
            // The (scale - 1) that brings the residual per-gap Tc down to the threshold exactly.
            // Pick the smallest variant that reaches it (widest as a fallback for extreme stretches).
            const reqDelta = ((charSpacing - thresholdPx) * gaps) / advanceTotalPx;
            let chosen = pdfFont.widthVariants[0];
            for (const v of pdfFont.widthVariants) {
              chosen = v;
              if (v.scale - 1 >= reqDelta) break;
            }
            // The variant references the base font's shared FontDescriptor/FontFile/ToUnicode,
            // so the base must be embedded even when no word renders at base width. Add it to the used set.
            pdfFontsUsed.add(pdfFont);
            pdfFont = chosen.info;
            emitCharSpacing = charSpacing - ((chosen.scale - 1) * advanceTotalPx) / gaps;
          }
        }
      }

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
        // Size the inter-word space from the glyph actually emitted below:
        // the currently-active export font's space advance scaled by its width factor (`pdfFontScaleCurrent`),
        // so a word that switched to a width-scaled variant gets the variant's wider space rather than the base's.
        const spaceAdvance = (pdfFontOpentypeCurrent.charToGlyph(' ').advanceWidth || pdfFontOpentypeCurrent.unitsPerEm / 2) * pdfFontScaleCurrent;
        const spaceWidthGlyph = spaceAdvance * (fontSizeLast / pdfFontOpentypeCurrent.unitsPerEm);

        const wordSpaceExpectedPx = (spaceWidthGlyph + charSpacingLast * 2 + wordRightBearingLast) + wordLeftBearing;

        // Ad-hoc adjustment needed to replicate wordSpace
        // const wordSpaceExtra = (wordSpace + angleSpaceAdjXWord - spaceWidth - charSpacing * 2 - wordLeftBearing - wordRightBearingLast + spacingAdj);
        const wordSpaceExtraPx = (wordSpaceAdj - wordSpaceExpectedPx + spacingAdj + angleAdjWordX) * (100 / tzCurrent);

        if (pdfFontTypeCurrent === 0) {
          // Look up the space glyph in the currently-active (subset) font —
          // the one a viewer will consult at this point in the stream.
          // `wordFont.opentype` is the un-subset source and has different
          // glyph indices.
          const spaceChar = pdfFontOpentypeCurrent.charToGlyphIndex(' ').toString(16).padStart(4, '0');
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
        pdfFontOpentypeCurrent = pdfFont.opentype;
        pdfFontScaleCurrent = pdfFont.widthScale || 1;
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

      textContentObjStr += `${String(Math.round(emitCharSpacing * 1e6) / 1e6)} Tc\n`;

      textContentObjStr += '[ ';

      // Non-ASCII and special characters are encoded/escaped using winEncodingLookup
      for (let k = 0; k < charArr.length; k++) {
        const letterSrc = charArr[k];
        let styleLetter = wordJ.style;
        let pdfFontLetter = pdfFont;
        if (styleSegments) {
          // The segment ends are text indices, which match k because ligature formation is skipped for words with style runs.
          while (segmentIdx < styleSegments.length - 1 && k >= styleSegments[segmentIdx].end) segmentIdx++;
          styleLetter = styleSegments[segmentIdx].style;
          pdfFontLetter = pdfFonts[wordFont.family][getStyleLookup(styleLetter)];
          if (pdfFontLetter !== pdfFont) pdfFontsUsed.add(pdfFontLetter);
        }
        const letter = styleLetter.smallCaps ? charArr[k].toUpperCase() : charArr[k];
        const fontSizeLetter = styleLetter.smallCaps && letterSrc !== letter ? wordFontSize * wordFont.smallCapsMult : wordFontSize;

        // Encoding needs to come from `pdfFontLetter`, not `wordFont`, as the `pdfFontLetter` will have a different index when subset.
        const baseGid = pdfFontLetter.type === 0 ? pdfFontLetter.opentype.charToGlyphIndex(letter) : null;
        const letterEnc = pdfFontLetter.type === 0 ? baseGid?.toString(16).padStart(4, '0') : winEncodingLookup[letter];
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

          if (pdfFontLetter.name !== pdfFontNameCurrent || fontSizeLetter !== fontSizeLast) {
            textContentObjStr += ' ] TJ\n';
            textContentObjStr += `${pdfFontLetter.name} ${String(fontSizeLetter)} Tf\n`;
            pdfFontNameCurrent = pdfFontLetter.name;
            pdfFontTypeCurrent = pdfFontLetter.type;
            pdfFontOpentypeCurrent = pdfFontLetter.opentype;
            pdfFontScaleCurrent = pdfFontLetter.widthScale || 1;
            fontSizeLast = fontSizeLetter;
            textContentObjStr += `${String(Math.round(emitCharSpacing * 1e6) / 1e6)} Tc\n`;
            textContentObjStr += '[ ';
          }

          if (pdfFontLetter.type === 0) {
            // PDF text positioning uses the integer /W widths, not the embedded font's own advances,
            // so rounding each declared width to an integer leaves a small per-glyph error that accumulates (positioning is cumulative).
            // Correct it through the TJ number, computing the advance from the same scaled value that produced the emitted `/W`:
            // `pdfFontLetter.widthScale` (1 for a base font) times the shared base outline's advance.
            const advancePdfPrecise = pdfFontLetter.opentype.charToGlyph(letter).advanceWidth * (pdfFontLetter.widthScale || 1) * (1000 / pdfFontLetter.opentype.unitsPerEm);
            const tjAdj = kern + (Math.floor(advancePdfPrecise) - advancePdfPrecise);
            textContentObjStr += `<${letterEnc}> ${String(Math.round(tjAdj * 1e6) / 1e6)} `;
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
            const spaceChar = pdfFontOpentypeCurrent.charToGlyphIndex(' ').toString(16).padStart(4, '0');
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
      // The residual Tc actually emitted (not the raw stretch) is what the next word's space calculation must account for,
      // so a variant word reports its reduced spacing.
      charSpacingLast = emitCharSpacing;
    }

    textContentObjStr += ' ] TJ\n';
  }

  textContentObjStr += 'ET\n';

  // Add underlines
  underlines.forEach((underline) => {
    const underlineThickness = underline.bold ? Math.ceil(underline.fontSize / 12) : Math.ceil(underline.fontSize / 24);
    const underlineOffset = Math.ceil(underline.fontSize / 12) + underlineThickness;

    textContentObjStr += `\n${String(underline.left)} ${String(outputDims.height - underline.top - underlineOffset)} ${String(underline.right - underline.left)} ${underlineThickness} re\nf\n`;
  });

  return { textContentObjStr, pdfFontsUsed };
}
