import { FontCont } from '../containers/fontContainer.js';
import { opt } from '../containers/app.js';
import { calcWordMetrics } from '../utils/fontUtils.js';
import { assignParagraphs } from '../utils/reflowPars.js';
import { pageMetricsArr } from '../containers/dataContainer.js';
import ocr from '../objects/ocrObjects.js';

/**
 * Calculate the font metrics for a given font and font size.
 * This is used to get metrics that match `ctx.measureText`, but without requiring a canvas.
 * @param {FontContainerFont} fontI
 * @param {number} fontSize
 */
const calcFontMetrics = (fontI, fontSize) => {
  const os2 = fontI.opentype.tables.os2;
  const unitsPerEm = fontI.opentype.unitsPerEm;

  // Bit 7: Use_Typo_Metrics (1 = Yes)
  // eslint-disable-next-line no-bitwise
  if (os2.fsSelection >> 7 & 1) {
    return {
      fontBoundingBoxAscent: Math.round(os2.sTypoAscender * (fontSize / unitsPerEm)),
      fontBoundingBoxDescent: Math.abs(Math.round(os2.sTypoDescender * (fontSize / unitsPerEm))),
    };
  }

  return {
    fontBoundingBoxAscent: Math.round(os2.usWinAscent * (fontSize / unitsPerEm)),
    fontBoundingBoxDescent: Math.round(os2.usWinDescent * (fontSize / unitsPerEm)),
  };
};

/**
 *
 * @param {string} text
 * @param {number} fontSizeHTMLSmallCaps
 */
const makeSmallCapsDivs = (text, fontSizeHTMLSmallCaps) => {
  const textDivs0 = text.match(/([a-z]+)|([^a-z]+)/g);
  if (!textDivs0) return '';
  const textDivs = textDivs0.map((x) => {
    const lower = /[a-z]/.test(x);
    const styleStr = lower ? `style="font-size:${fontSizeHTMLSmallCaps}px"` : '';
    return `<span class="input-sub" ${styleStr}>${x}</span>`;
  });
  return textDivs.join('');
};

/**
 * Convert an array of ocrPage objects to HTML.
 *
 * @param {Object} params
 * @param {Array<OcrPage>} params.ocrPages -
 * @param {Array<ImageWrapper>} [params.images] -
 * @param {number} [params.minpage=0] - The first page to include in the document.
 * @param {number} [params.maxpage=-1] - The last page to include in the document.
 * @param {boolean} [params.reflowText=false] - Remove line breaks within what appears to be the same paragraph.
 * @param {boolean} [params.removeMargins=false] - Remove the margins from the text.
 * @param {?Array<string>} [params.wordIds] - An array of word IDs to include in the document.
 *    If omitted, all words are included.
 */
export function writeHtml({
  ocrPages, images, minpage = 0, maxpage = -1, reflowText = false, removeMargins = false, wordIds = null,
}) {
  const fontsUsed = new Set();

  const enableOptSaved = FontCont.state.enableOpt;
  FontCont.state.enableOpt = false;

  if (images && images.length === 0) images = undefined;

  // This does not work well yet, so hard-code it to false for now.
  reflowText = false;

  let bodyStr = '<body>\n';

  if (maxpage === -1) maxpage = ocrPages.length - 1;

  let newLine = false;

  const activeLine = {
    left: 0,
    y1: 0,
    maxFontBoundingBoxAscentLine: 0,
    bodyWordsStr: '',
  };

  const addLine = () => {
    if (activeLine.bodyWordsStr !== '') {
      const topHTML = Math.round((activeLine.y1 - activeLine.maxFontBoundingBoxAscentLine) * 1000) / 1000;
      bodyStr += `    <div class="scribe-line" style="left:${activeLine.left}px;top:${topHTML}px;">\n`;
      bodyStr += activeLine.bodyWordsStr;
      bodyStr += '       <br>\n';
      bodyStr += '    </div>\n';
    }
    activeLine.bodyWordsStr = '';
    activeLine.maxFontBoundingBoxAscentLine = 0;
    activeLine.y1 = 0;
    activeLine.left = 0;
  };

  let top = 0;

  let firstPage = true;

  for (let g = minpage; g <= maxpage; g++) {
    // TODO: change this when an image is included.
    if (!ocrPages[g] || ocrPages[g].lines.length === 0) continue;

    const pageObj = ocrPages[g];

    let minLeft = 0;
    let minTop = 0;
    let maxBottom = 0;
    if (removeMargins) {
      const wordArr = ocr.getPageWords(pageObj);
      for (let h = 0; h < wordArr.length; h++) {
        const wordObj = wordArr[h];
        if (wordIds && !wordIds.includes(wordObj.id)) continue;
        if (minLeft === 0 || wordObj.bbox.left < minLeft) minLeft = wordObj.bbox.left;
        if (minTop === 0 || wordObj.bbox.top < minTop) minTop = wordObj.bbox.top;
        if (wordObj.bbox.bottom > maxBottom) maxBottom = wordObj.bbox.bottom;
      }
    }

    if (!firstPage) bodyStr += '\n</div>\n';
    firstPage = false;
    bodyStr += `  <div class="scribe-page" id="page${g}" style="position:absolute;top:${top}px;">\n`;

    const imageObj = images ? images[g] : null;
    if (imageObj) {
      bodyStr += `  <img class="scribe-image" src="${imageObj.src}">\n`;
    }

    if (removeMargins) {
      top += Math.min((maxBottom - minTop) + 200, pageMetricsArr[g].dims.height + 10);
    } else {
      top += pageMetricsArr[g].dims.height + 10;
    }

    if (reflowText) {
      const angle = pageMetricsArr[g].angle || 0;
      assignParagraphs(pageObj, angle);
    }

    let parCurrent = pageObj.lines[0].par;
    let wordObjPrev = /** @type {?OcrWord} */ (null);
    let rightSideBearingPrev = 0;
    let charSpacingHTMLPrev = 0;

    for (let h = 0; h < pageObj.lines.length; h++) {
      const lineObj = pageObj.lines[h];

      if (reflowText) {
        if (h === 0 || lineObj.par !== parCurrent) newLine = true;
        parCurrent = lineObj.par;
      } else {
        newLine = true;
      }

      let underlinePrev = false;

      for (let i = 0; i < lineObj.words.length; i++) {
        const wordObj = lineObj.words[i];
        if (!wordObj) continue;

        if (wordIds && !wordIds.includes(wordObj.id)) continue;

        if (newLine) {
          wordObjPrev = null;

          addLine();

          const scale = 1;

          const {
            charSpacing, leftSideBearing, rightSideBearing, fontSize, charArr, advanceArr, kerningArr, font,
          } = calcWordMetrics(wordObj);

          activeLine.y1 = wordObj.line.bbox.bottom + wordObj.line.baseline[1] - minTop;

          activeLine.left = wordObj.bbox.left - minLeft;
          if (wordObj.visualCoords) activeLine.left -= leftSideBearing * scale;
        } else if (h > 0 || g > 0 || i > 0) {
          bodyStr += ' ';
        }

        newLine = false;

        const scale = 1;
        const angle = 0;

        // HTML exports currently only use raw fonts, as the fonts are retrieved from a CDN.
        const fontI = FontCont.getWordFont(wordObj);
        fontsUsed.add(fontI);

        const {
          charSpacing, leftSideBearing, rightSideBearing, fontSize, charArr, advanceArr, kerningArr, font,
        } = calcWordMetrics(wordObj);

        const wordStr = charArr.join('');

        const charSpacingHTML = charSpacing * scale;

        const y1 = wordObj.line.bbox.bottom + wordObj.line.baseline[1] - minTop;

        const fontSizeHTML = fontSize * scale;

        const metrics = calcFontMetrics(fontI, fontSizeHTML);

        const fontSizeHTMLSmallCaps = fontSize * scale * fontI.smallCapsMult;

        if (metrics.fontBoundingBoxAscent > activeLine.maxFontBoundingBoxAscentLine) {
          activeLine.maxFontBoundingBoxAscentLine = metrics.fontBoundingBoxAscent;
        }

        // Align with baseline
        const topHTML = Math.round((y1 - metrics.fontBoundingBoxAscent) * 1000) / 1000;

        let styleStr = '';

        styleStr += `font-size:${fontSizeHTML}px;`;
        styleStr += `font-family:${fontI.fontFaceName};`;

        if (Math.abs(angle ?? 0) > 0.05) {
          styleStr += `transform-origin:left ${y1 - topHTML}px;`;
          styleStr += `transform:rotate(${angle}deg);`;
        }

        const { fill, opacity } = ocr.getWordFillOpacity(wordObj, opt.displayMode,
          opt.confThreshMed, opt.confThreshHigh, opt.overlayOpacity);

        // Text with opacity 0 is not selectable, so we make it transparent instead.
        if (opacity === 0) {
          styleStr += 'color:transparent;';
          styleStr += 'opacity:1;';
        } else {
          styleStr += `color:${fill};`;
          styleStr += `opacity:${opacity};`;
        }

        // We cannot make the text uppercase in the input field, as this would result in the text being saved as uppercase.
        // Additionally, while there is a small-caps CSS property, it does not allow for customizing the size of the small caps.
        // Therefore, we handle small caps by making all text print as uppercase using the `text-transform` CSS property,
        // and then wrapping each letter in a span with a smaller font size.
        let innerHTML;
        if (wordObj.style.smallCaps) {
          styleStr += 'text-transform:uppercase;';
          innerHTML = makeSmallCapsDivs(wordStr, fontSizeHTMLSmallCaps);
        } else {
          innerHTML = wordStr;
        }

        let leftPad = 0;
        if (wordObjPrev) {
          let bearingAdj = 0;
          if (wordObj.visualCoords) {
            bearingAdj = leftSideBearing + rightSideBearingPrev;
          }

          leftPad = (wordObj.bbox.left - wordObjPrev.bbox.right - bearingAdj - charSpacingHTMLPrev) / Math.cos(angle);
        }

        styleStr += `letter-spacing:${charSpacingHTML}px;`;

        styleStr += `font-weight:${fontI.fontFaceWeight};`;
        styleStr += `font-style:${fontI.fontFaceStyle};`;

        // Line height must match the height of the font bounding box for the font metrics to be accurate.
        styleStr += `line-height:${metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent}px;`;

        if (wordObj.style.sup) {
          const supOffset = Math.round(wordObj.line.bbox.bottom + wordObj.line.baseline[1] - wordObj.bbox.bottom);
          styleStr += `vertical-align:${supOffset}px;`;
        }

        if (wordObj.style.underline) {
          styleStr += 'text-decoration:underline;';
          styleStr += `text-decoration-color:${fill};`;
          styleStr += `text-decoration-thickness:${Math.ceil(fontSizeHTML / 12)}px;`;
          styleStr += `text-underline-offset:${Math.ceil(fontSizeHTML / 12) + Math.ceil(fontSizeHTML / 24)}px;`;
        }

        if (i > 0) {
          let styleStrSpace = `font-family:${fontI.fontFaceName};`;
          const spaceAdvancePx = (fontI.opentype.charToGlyph(' ').advanceWidth / fontI.opentype.unitsPerEm);
          const fontSizeHTMLSpace = leftPad / spaceAdvancePx;
          if (fontSizeHTMLSpace > fontSizeHTML * 3) {
            styleStrSpace += `font-size:${fontSizeHTML}px;`;

            const leftPadFinal = leftPad - spaceAdvancePx * fontSizeHTML;

            styleStrSpace += `padding-left:${leftPadFinal}px;`;
          } else {
            styleStrSpace += `font-size:${fontSizeHTML}px;`;
            const leftPadFinal = leftPad - spaceAdvancePx * fontSizeHTML;
            styleStrSpace += `word-spacing:${leftPadFinal}px;`;
          }

          if (underlinePrev) {
            styleStrSpace += 'text-decoration:underline;';
            styleStrSpace += `text-decoration-color:${fill};`;
            styleStrSpace += `text-decoration-thickness:${Math.ceil(fontSizeHTML / 12)}px;`;
            styleStrSpace += `text-underline-offset:${Math.ceil(fontSizeHTML / 12) + Math.ceil(fontSizeHTML / 24)}px;`;
          }

          activeLine.bodyWordsStr += `<span class="scribe-space" style=${styleStrSpace}> </span>`;
        }

        activeLine.bodyWordsStr += `<span class="scribe-word" id="${wordObj.id}" style="${styleStr}">${innerHTML}</span>`;

        underlinePrev = wordObj.style.underline;

        wordObjPrev = wordObj;
        rightSideBearingPrev = rightSideBearing;
        charSpacingHTMLPrev = charSpacingHTML;
      }
    }

    addLine();
    bodyStr += '\n  </div>\n';

    opt.progressHandler({ n: g, type: 'export', info: { } });
  }

  let styleStr = '<style>\n  .scribe-word {\n';

  styleStr += '    z-index:1;\n';
  styleStr += '    white-space:nowrap;\n';
  if (opt.kerning) {
    styleStr += '    font-kerning:normal;\n';
  } else {
    styleStr += '    font-kerning:none;\n';
  }

  styleStr += '  }\n';

  styleStr += '  .scribe-line {\n';
  styleStr += '    position:absolute;\n';
  styleStr += '    white-space:nowrap;\n';
  styleStr += '  }\n';

  styleStr += '  .scribe-image {\n';
  styleStr += '    position:absolute;\n';
  styleStr += '    user-select:none;\n';
  styleStr += '    pointer-events:none;\n';
  styleStr += '  }\n';

  for (const fontI of fontsUsed) {
    const cdnPath = 'https://cdn.jsdelivr.net/npm/scribe.js-ocr@0.7.1/fonts/all/';
    let styleTitleCase = fontI.style.charAt(0).toUpperCase() + fontI.style.slice(1).toLowerCase();
    if (styleTitleCase === 'Normal') styleTitleCase = 'Regular';
    const fontName = `${fontI.family}-${styleTitleCase}.woff`;
    const fontPath = cdnPath + fontName;

    styleStr += `  @font-face {
    font-family: '${fontI.fontFaceName}';
    font-style: ${fontI.fontFaceStyle};
    font-weight: ${fontI.fontFaceWeight};
    src: url('${fontPath}');
  }\n`;
  }

  styleStr += '</style>\n';

  bodyStr += '</body>\n';

  const metaStr = '<meta charset="UTF-8">\n';

  const htmlStr = `<!doctype html>\n<html>\n<head>\n${metaStr}${styleStr}</head>\n${bodyStr}</html>`;

  FontCont.state.enableOpt = enableOptSaved;

  return htmlStr;
}
