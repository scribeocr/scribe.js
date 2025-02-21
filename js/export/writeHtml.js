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
      fontBoundingBoxDescent: Math.round(os2.sTypoDescender * (fontSize / unitsPerEm)),
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
 * @param {Array<OcrPage>} ocrCurrent -
 * @param {number} minpage - The first page to include in the document.
 * @param {number} maxpage - The last page to include in the document.
 * @param {boolean} reflowText - Remove line breaks within what appears to be the same paragraph.
 * @param {boolean} removeMargins - Remove the margins from the text.
 * @param {?Array<string>} wordIds - An array of word IDs to include in the document.
 *    If omitted, all words are included.
 */
export function writeHtml(ocrCurrent, minpage = 0, maxpage = -1, reflowText = false, removeMargins = false, wordIds = null) {
  const fontsUsed = new Set();

  const pad = 5;

  let bodyStr = '<body>\n';

  if (maxpage === -1) maxpage = ocrCurrent.length - 1;

  let newLine = false;

  let top = 0;

  for (let g = minpage; g <= maxpage; g++) {
    if (!ocrCurrent[g] || ocrCurrent[g].lines.length === 0) continue;

    const pageObj = ocrCurrent[g];

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

    bodyStr += `  <div class="scribe-page" id="page${g}" style="position:absolute;top:${top}px;">\n`;
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

    for (let h = 0; h < pageObj.lines.length; h++) {
      const lineObj = pageObj.lines[h];

      if (reflowText) {
        if (g > 0 && h === 0 || lineObj.par !== parCurrent) newLine = true;
        parCurrent = lineObj.par;
      } else {
        newLine = true;
      }

      for (let i = 0; i < lineObj.words.length; i++) {
        const wordObj = lineObj.words[i];
        if (!wordObj) continue;

        if (wordIds && !wordIds.includes(wordObj.id)) continue;

        if (newLine) {
          bodyStr += '\n';
        } else if (h > 0 || g > 0 || i > 0) {
          bodyStr += ' ';
        }

        newLine = false;

        const scale = 1;
        const angle = 0;

        const fontI = FontCont.getWordFont(wordObj);
        fontsUsed.add(fontI);

        const {
          charSpacing, leftSideBearing, rightSideBearing, fontSize, charArr, advanceArr, kerningArr, font,
        } = calcWordMetrics(wordObj);

        const wordStr = charArr.join('');

        const charSpacingHTML = charSpacing * scale;

        let x1 = wordObj.bbox.left - minLeft;
        const y1 = wordObj.line.bbox.bottom + wordObj.line.baseline[1] - minTop;

        if (wordObj.visualCoords) x1 -= leftSideBearing * scale;

        const fontSizeHTML = fontSize * scale;

        const metrics = calcFontMetrics(fontI, fontSizeHTML);

        const fontSizeHTMLSmallCaps = fontSize * scale * fontI.smallCapsMult;

        // Align with baseline
        const topHTML = Math.round((y1 - metrics.fontBoundingBoxAscent + fontSizeHTML * 0.6) * 1000) / 1000;

        let styleStr = '';

        const topPadOffset = 5 * Math.sin(angle * (Math.PI / 180));
        const leftPadOffset = 5 * Math.cos(angle * (Math.PI / 180));

        styleStr += `left:${x1 - leftPadOffset}px;`;
        styleStr += `top:${topHTML - topPadOffset}px;`;
        styleStr += `font-size:${fontSizeHTML}px;`;
        styleStr += `font-family:${fontI.fontFaceName};`;

        if (Math.abs(angle ?? 0) > 0.05) {
          styleStr += `transform-origin:left ${y1 - topHTML}px;`;
          styleStr += `transform:rotate(${angle}deg);`;
        }

        // We cannot make the text uppercase in the input field, as this would result in the text being saved as uppercase.
        // Additionally, while there is a small-caps CSS property, it does not allow for customizing the size of the small caps.
        // Therefore, we handle small caps by making all text print as uppercase using the `text-transform` CSS property,
        // and then wrapping each letter in a span with a smaller font size.
        let innerHTML;
        if (wordObj.smallCaps) {
          styleStr += 'text-transform:uppercase;';
          innerHTML = makeSmallCapsDivs(wordStr, fontSizeHTMLSmallCaps);
        } else {
          innerHTML = wordStr;
        }

        styleStr += `letter-spacing:${charSpacingHTML}px;`;

        styleStr += `font-weight:${fontI.fontFaceWeight};`;
        styleStr += `font-style:${fontI.fontFaceStyle};`;

        // Line height must match the height of the font bounding box for the font metrics to be accurate.
        styleStr += `line-height:${metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent}px;`;

        bodyStr += `    <span class="scribe-word" id="${wordObj.id}" style="${styleStr}">${innerHTML}</span>`;
      }
    }

    bodyStr += '\n  </div>\n';

    opt.progressHandler({ n: g, type: 'export', info: { } });
  }

  let styleStr = '<style>\n  .scribe-word {\n';

  styleStr += '    position:absolute;\n';
  styleStr += `    padding-left:${pad}px;\n`;
  styleStr += `    padding-right:${pad}px;\n`;
  styleStr += '    z-index:1;\n';
  styleStr += '    white-space:nowrap;\n';
  if (opt.kerning) {
    styleStr += '    font-kerning:normal;\n';
  } else {
    styleStr += '    font-kerning:none;\n';
  }

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

  const htmlStr = `<html>\n<head>\n${styleStr}</head>\n${bodyStr}</html>`;

  return htmlStr;
}
