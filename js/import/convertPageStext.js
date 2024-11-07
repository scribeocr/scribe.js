import ocr from '../objects/ocrObjects.js';

import {
  calcBboxUnion,
  calcBoxOverlap,
  calcLang,
  mean50,
  quantile,
  round6,
  unescapeXml,
} from '../utils/miscUtils.js';

import { LayoutDataTablePage } from '../objects/layoutObjects.js';
import { detectTablesInPage, makeTableFromBbox } from '../utils/detectTables.js';
import { splitLineAgressively } from '../utils/ocrUtils.js';

/**
 * @param {Object} params
 * @param {string} params.ocrStr
 * @param {number} params.n
 */
export async function convertPageStext({ ocrStr, n }) {
  const pageDimsMatch = ocrStr.match(/<page .+?width=['"]([\d.-]+)['"] height=['"]([\d.-]+)['"]/);

  if (!pageDimsMatch || !pageDimsMatch[1] || !pageDimsMatch[2]) throw new Error('Page dimensions not found in stext.');

  const pageDims = { height: parseInt(pageDimsMatch[2]), width: parseInt(pageDimsMatch[1]) };

  const pageObj = new ocr.OcrPage(n, pageDims);

  /** @type {Array<number>} */
  const angleRisePage = [];

  /** @type {Set<string>} */
  const langSet = new Set();

  function convertParStext(xmlPar) {
    /** @type {Array<OcrLine>} */
    const parLineArr = [];

    /**
     * @param {string} xmlLine
     */
    // eslint-disable-next-line no-shadow
    function convertLineStext(xmlLine) {
    // Remove the <block> tag to avoid the regex matching it instead of the <line> tag.
    // We currently have no "block" level object, however this may be useful in the future.
      xmlLine = xmlLine.replace(/<block[^>]*?>/i, '');

      const xmlLinePreChar = xmlLine.match(/^[\s\S]*?(?=<char)/)?.[0];
      if (!xmlLinePreChar) return;

      const xmlLineFormatting = xmlLinePreChar?.match(/<font[^>]+/)?.[0];
      const fontName = xmlLineFormatting?.match(/name=['"]([^'"]*)/)?.[1];
      const fontSizeStr = xmlLineFormatting?.match(/size=['"]([^'"]*)/)?.[1];

      console.assert(fontSizeStr, 'Font size not found in stext.');

      const fontSizeLine = fontSizeStr ? parseFloat(fontSizeStr) : 10;

      const fontFamilyLine = fontName?.replace(/-.+/g, '') || 'Default';

      const lineBoxArr = [...xmlLinePreChar.matchAll(/bbox(?:es)?=['"](\s*[\d.-]+)(\s*[\d.-]+)?(\s*[\d.-]+)?(\s*[\d.-]+)?/g)][0].slice(1, 5).map((x) => Math.max(parseFloat(x), 0));

      // Unlike Tesseract, stext does not have a native "word" unit (it provides only lines and letters).
      // Therefore, lines are split into words on either (1) a space character or (2) a change in formatting.
      const wordStrArr = xmlLine.split(/(?:<char[^>]*?c=['"]\s+['"]\/>)/ig);
      // If the last element is a closing font tag, remove it.
      if (wordStrArr[wordStrArr.length - 1] && wordStrArr[wordStrArr.length - 1].trim() === '</font>') wordStrArr.pop();

      // Delete any empty elements.
      // This can happen when multiple spaces are present and is problematic later in the code.
      for (let i = wordStrArr.length - 1; i >= 0; i--) {
        if (wordStrArr[i].trim() === '') {
          wordStrArr.splice(i, 1);
        }
      }

      if (wordStrArr.length === 0) return;

      /** @type {Array<Array<{left: number, top: number, right: number, bottom: number}>>} */
      const bboxes = [];

      const baselineSlopeArr = /** @type {Array<Number>} */ ([]);
      const baselineFirst = /** @type {Array<Number>} */ ([]);

      let baselineCurrent = 0;

      /** @type {Array<Array<string>>} */
      const text = [];
      /** @type {Array<number>} */
      const wordLetterOrFontArrIndex = [];
      let styleCurrent = 'normal';
      let familyCurrent = 'Default';
      /** Font size at the current position in the PDF, with no modifications. */
      let sizeCurrentRaw = 0;
      /** Font size at the current position in the PDF, with changes for typographical reasons (small caps, superscripts) ignored. */
      let sizeCurrent = 0;
      let superCurrent = false;
      let smallCapsCurrent;
      let smallCapsCurrentAlt;
      /** @type {Array<string>} */
      const styleArr = [];
      /** @type {Array<boolean>} */
      const smallCapsArr = [];
      /** @type {Array<boolean>} */
      const smallCapsAltArr = [];
      /** @type {Array<boolean>} */
      const smallCapsAltTitleCaseArr = [];
      /** @type {Array<string>} */
      const fontFamilyArr = [];
      /** @type {Array<number>} */
      const fontSizeArr = [];
      /** @type {Array<boolean>} */
      const superArr = [];

      const wordLetterOrFontArr = /** @type {Array<Array<RegExpExecArray>>} */([]);
      for (let i = 0; i < wordStrArr.length; i++) {
        // Fonts can be changed at any point in the word string.
        // Sometimes the font is changed before a space character, and othertimes it is changed after the space character.
        // This regex splits the string into elements that contain either (1) a font change or (2) a character.
        // The "quad" attribute includes 8 numbers (x and y coordinates for all 4 corners) however we only use capturing groups for 4
        const stextCharRegex = /(<font[^>]+>\s*)|<char quad=['"](\s*[\d.-]+)(\s*[\d.-]+)(?:\s*[\d.-]+)(?:\s*[\d.-]+)(?:\s*[\d.-]+)(?:\s*[\d.-]+)(\s*[\d.-]+)(\s*[\d.-]+)[^>]*?y=['"]([\d.-]+)['"][^>]*?c=['"]([^'"]+)['"]\s*\/>/ig;
        wordLetterOrFontArr[i] = [...wordStrArr[i].matchAll(stextCharRegex)];
      }

      for (let i = 0; i < wordLetterOrFontArr.length; i++) {
        let textWordArr = [];
        let bboxesWordArr = [];
        let fontFamily = familyCurrent || fontFamilyLine || 'Default';
        // Font size for the word is a separate variable, as if a font size changes at the end of the word,
        // that should not be reflected until the following word.
        let fontSizeWord = sizeCurrent || fontSizeLine || 10;
        let smallCapsWord = smallCapsCurrent || false;
        let smallCapsWordAlt = smallCapsCurrentAlt || false;
        // Title case adjustment does not carry forward between words. A word in title case may be followed by a word in all lower case.
        let smallCapsWordAltTitleCaseAdj = false;
        let styleWord = 'normal';

        const letterOrFontArr = wordLetterOrFontArr[i];

        if (letterOrFontArr.length === 0) continue;

        let wordInit = false;

        for (let j = 0; j < letterOrFontArr.length; j++) {
          const fontStr = letterOrFontArr[j][1];
          const fontNameStrI = fontStr?.match(/name=['"]([^'"]*)/)?.[1];
          const fontSizeStrI = fontStr?.match(/size=['"]([^'"]*)/)?.[1];
          const baseline = parseFloat(letterOrFontArr[j][6]);
          if (fontNameStrI && fontSizeStrI) {
            // While small caps can be printed using special "small caps" fonts, they can also be printed using a regular font with a size change.
            // This block of code detects small caps printed in title case by checking for a decrease in font size after the first letter.
            // TODO: This logic currently fails when:
            // (1) Runs of small caps include punctuation, which is printed at the full size (and therefore is counted as a size increase ending small caps).
            // (2) Runs of small caps that start with lower-case letters, which do not conform to the expectation that runs of small caps start with a capital letter.
            const sizePrevRaw = sizeCurrentRaw;
            sizeCurrentRaw = parseFloat(fontSizeStrI);
            const secondLetter = wordInit && textWordArr.length === 1 && /[A-Z]/.test(textWordArr[0]);
            const baselineNextLetter = parseFloat(letterOrFontArr[j + 1]?.[6]) || parseFloat(wordLetterOrFontArr[i + 1]?.[0]?.[6])
              || parseFloat(wordLetterOrFontArr[i + 1]?.[1]?.[6]) || parseFloat(wordLetterOrFontArr[i + 1]?.[2]?.[6]);
            const fontSizeMin = Math.min(sizeCurrentRaw, sizePrevRaw);
            const baselineDelta = (baselineNextLetter - baselineCurrent) / fontSizeMin;
            const sizeDelta = (sizeCurrentRaw - sizePrevRaw) / fontSizeMin;
            if (secondLetter && sizeCurrentRaw < sizePrevRaw && sizePrevRaw > 0 && baselineNextLetter && Math.abs(baselineDelta) < 0.1) {
              smallCapsCurrentAlt = true;
              smallCapsWordAlt = true;
              smallCapsWordAltTitleCaseAdj = true;
            // Handle case where superscript is starting or ending.
            // We need to be able to detect superscripts using either a start or end font change,
            // as only using one would miss some cases.
            } else if (Number.isFinite(baselineDelta) && Number.isFinite(sizeDelta)
            && ((baselineDelta < -0.25 && sizeDelta < -0.05) || (baselineDelta > 0.25 && sizeDelta > 0.05))) {
              // Split word when superscript starts or ends.
              if (textWordArr.length > 0) {
                text.push(textWordArr);
                bboxes.push(bboxesWordArr);
                styleArr.push(styleWord);
                fontFamilyArr.push(fontFamily);
                fontSizeArr.push(fontSizeWord);
                smallCapsArr.push(smallCapsWord);
                smallCapsAltArr.push(smallCapsWordAlt);
                smallCapsAltTitleCaseArr.push(smallCapsWordAltTitleCaseAdj);
                superArr.push(sizeDelta > 0);

                textWordArr = [];
                bboxesWordArr = [];
              }

              // If the first word was determined to be a superscript, reset `baselineFirst` to avoid skewing the slope calculation.
              if (sizeDelta > 0) {
                baselineFirst.length = 0;
                familyCurrent = fontNameStrI || familyCurrent;
                sizeCurrent = sizeCurrentRaw || sizeCurrent;
                fontSizeWord = sizeCurrent;
                fontFamily = familyCurrent;
                superArr[superArr.length - 1] = true;
                fontSizeArr[fontSizeArr.length - 1] = sizeCurrentRaw;
              }

              superCurrent = sizeDelta < 0;
            } else {
              sizeCurrent = sizeCurrentRaw || sizeCurrent;
              familyCurrent = fontNameStrI || familyCurrent;
              // Update current word only if this is before every letter in the word.
              if (textWordArr.length === 0) {
                fontSizeWord = sizeCurrent;
                fontFamily = familyCurrent;
              }
              // An increase in font size ends any small caps sequence.
              // A threshold is necessary because stext data has been observed to have small variations without a clear reason.
              // eslint-disable-next-line no-lonely-if
              if (Math.abs(sizeDelta) > 0.05) {
                smallCapsCurrentAlt = false;
                if (textWordArr.length === 0) {
                  superCurrent = false;
                  smallCapsWordAlt = false;
                  smallCapsWordAltTitleCaseAdj = false;
                }
              }
            }

            // Label as `smallCapsAlt` rather than `smallCaps`, as we confirm the word is all caps before marking as `smallCaps`.
            smallCapsCurrentAlt = smallCapsCurrentAlt ?? smallCapsAltArr[smallCapsAltArr.length - 1];
            smallCapsCurrent = /(small\W?cap)|(sc$)|(caps$)/i.test(fontNameStrI);
            smallCapsWord = smallCapsCurrent;

            if (/italic/i.test(fontNameStrI) || /-\w*ital/i.test(fontNameStrI)) {
              // The word is already initialized, so we need to change the last element of the style array.
              // Label as `smallCapsAlt` rather than `smallCaps`, as we confirm the word is all caps before marking as `smallCaps`.
              styleCurrent = 'italic';
            } else if (/bold|black/i.test(fontNameStrI)) {
              styleCurrent = 'bold';
            } else {
              styleCurrent = 'normal';
            }

            continue;
          } else {
            baselineCurrent = baseline;
          }

          if (!wordInit) {
            styleWord = styleCurrent;
            wordInit = true;
          }

          const bbox = {
            left: Math.round(parseFloat(letterOrFontArr[j][2])),
            top: Math.round(parseFloat(letterOrFontArr[j][3])),
            right: Math.round(parseFloat(letterOrFontArr[j][4])),
            bottom: Math.round(parseFloat(letterOrFontArr[j][5])),
          };

          if (!superCurrent) {
            if (baselineFirst.length === 0) {
              baselineFirst.push(bbox.left, baseline);
            } else {
              baselineSlopeArr.push((baseline - baselineFirst[1]) / (bbox.left - baselineFirst[0]));
            }
          }

          // Small caps created by reducing font size can carry forward across multiple words.
          smallCapsCurrentAlt = smallCapsCurrentAlt ?? smallCapsAltArr[smallCapsAltArr.length - 1];

          textWordArr.push(letterOrFontArr[j][7]);

          bboxesWordArr.push(bbox);
        }

        if (textWordArr.length === 0) continue;

        wordLetterOrFontArrIndex.push(i);
        text.push(textWordArr);
        bboxes.push(bboxesWordArr);
        styleArr.push(styleWord);
        fontFamilyArr.push(fontFamily);
        fontSizeArr.push(fontSizeWord);
        smallCapsAltArr.push(smallCapsWordAlt);
        smallCapsArr.push(smallCapsWord);
        smallCapsAltTitleCaseArr.push(smallCapsWordAltTitleCaseAdj);

        // Superscripts are only allowed to be one word long.
        // Any identiciation of 2+ words as a superscript is assumed a false positive and disabled.
        if (superCurrent && superArr[superArr.length - 1]) {
          superArr[superArr.length - 1] = false;
          superCurrent = false;
        }

        superArr.push(superCurrent);
      }

      // Return if there are no letters in the line.
      // This commonly happens for "lines" that contain only space characters.
      if (bboxes.length === 0) return;

      const baselineSlope = quantile(baselineSlopeArr, 0.5) || 0;

      const lineBbox = {
        left: lineBoxArr[0], top: lineBoxArr[1], right: lineBoxArr[2], bottom: lineBoxArr[3],
      };

      // baselinePoint should be the offset between the bottom of the line bounding box, and the baseline at the leftmost point
      let baselinePoint = baselineFirst[1] - lineBbox.bottom;
      baselinePoint = baselinePoint || 0;

      const baselineOut = [round6(baselineSlope), Math.round(baselinePoint)];

      // This is only a rough estimate, however since `size` is set on individual words, this value should not matter.
      const letterHeightOut = fontSizeLine * 0.6;

      const lineObj = new ocr.OcrLine(pageObj, lineBbox, baselineOut, letterHeightOut, null);

      lineObj.raw = xmlLine;

      let lettersKept = 0;
      for (let i = 0; i < text.length; i++) {
        const wordText = unescapeXml(text[i].join(''));

        if (wordText.trim() === '') continue;

        const wordLang = calcLang(wordText);
        langSet.add(wordLang);

        const wordID = `word_${n + 1}_${pageObj.lines.length + 1}_${i + 1}`;
        const bboxesI = bboxes[i];

        /** @type {Array<OcrChar>} */
        const charObjArr = [];

        for (let j = 0; j < text[i].length; j++) {
          const letter = unescapeXml(text[i][j]);

          const bbox = bboxesI[j];

          // For Chinese, every "character" in the .hocr should be its own word.
          // Tesseract LSTM already does this, however Tesseract Legacy combines entire lines into the same "word",
          // which makes good alignment impossible.
          if (wordLang === 'chi_sim') {
            const wordObj = new ocr.OcrWord(lineObj, letter, bbox, `${wordID}_${j}`);
            wordObj.conf = 100;
            wordObj.lang = wordLang;
            wordObj.visualCoords = false;

            lineObj.words.push(wordObj);
            lettersKept++;
          } else {
            const charObj = new ocr.OcrChar(letter, bbox);
            charObjArr.push(charObj);
          }
        }

        if (wordLang === 'chi_sim') continue;

        const bboxesILeft = Math.min(...bboxesI.map((x) => x.left));
        const bboxesIRight = Math.max(...bboxesI.map((x) => x.right));
        const bboxesITop = Math.min(...bboxesI.map((x) => x.top));
        const bboxesIBottom = Math.max(...bboxesI.map((x) => x.bottom));

        const bbox = {
          left: bboxesILeft, top: bboxesITop, right: bboxesIRight, bottom: bboxesIBottom,
        };

        if (bbox.left < 0 && bbox.right < 0) continue;

        const wordObj = new ocr.OcrWord(lineObj, wordText, bbox, wordID);
        wordObj.size = fontSizeArr[i];

        wordObj.lang = wordLang;

        wordObj.chars = charObjArr;

        // In stext, the coordinates are based on font bounding boxes, not where pixels start/end.
        wordObj.visualCoords = false;

        // There is no confidence information in stext.
        // Confidence is set to 100 simply for ease of reading (to avoid all red text if the default was 0 confidence).
        wordObj.conf = 100;

        if (smallCapsAltArr[i] && !/[a-z]/.test(wordObj.text) && /[A-Z].?[A-Z]/.test(wordObj.text)) {
          wordObj.smallCaps = true;
          if (smallCapsAltTitleCaseArr[i]) {
            wordObj.chars.slice(1).forEach((x) => {
              x.text = x.text.toLowerCase();
            });
          } else {
            wordObj.chars.forEach((x) => {
              x.text = x.text.toLowerCase();
            });
          }
          wordObj.text = wordObj.chars.map((x) => x.text).join('');
        } else if (smallCapsArr[i]) {
          wordObj.smallCaps = true;
        }

        if (styleArr[i] === 'italic') {
          wordObj.style = 'italic';
        } if (styleArr[i] === 'bold') {
          wordObj.style = 'bold';
        }

        wordObj.raw = wordStrArr[wordLetterOrFontArrIndex[i]];

        wordObj.font = fontFamilyArr[i];

        wordObj.sup = superArr[i];

        lineObj.words.push(wordObj);

        lettersKept++;
      }

      // If there are no letters in the line, drop the entire line element
      if (lettersKept === 0) return;

      // Recalculate the bounding box.
      // The bounding boxes reported by mupdf are often significantly larger than the actual text.
      ocr.updateLineBbox(lineObj);

      pageObj.lines.push(lineObj);
      parLineArr.push(lineObj);
      // eslint-disable-next-line consistent-return
      return baselineSlope;
    }

    const lineStrArr = xmlPar.split(/<\/line>/);

    for (let i = 0; i < lineStrArr.length; i++) {
      const angle = convertLineStext(lineStrArr[i]);
      if (typeof angle === 'number' && !Number.isNaN(angle)) angleRisePage.push(angle);
    }

    if (parLineArr.length === 0) return;

    const parbox = calcBboxUnion(parLineArr.map((x) => x.bbox));

    const parObj = new ocr.OcrPar(pageObj, parbox);

    parLineArr.forEach((x) => {
      x.par = parObj;
    });

    parObj.lines = parLineArr;
    pageObj.pars.push(parObj);
  }

  const parStrArr = ocrStr.split(/<\/block>/);

  for (let i = 0; i < parStrArr.length; i++) {
    convertParStext(parStrArr[i]);
  }

  const angleRiseMedian = mean50(angleRisePage) || 0;

  const angleOut = Math.asin(angleRiseMedian) * (180 / Math.PI);

  pageObj.angle = angleOut;

  const autoDetectTables = true;
  const dataTablePage = new LayoutDataTablePage(n);
  if (autoDetectTables) {
    const tableBboxes = detectTablesInPage(pageObj);

    for (let i = 0; i < pageObj.lines.length; i++) {
      const line = pageObj.lines[i];
      let inTable = false;
      for (let j = 0; j < tableBboxes.length; j++) {
        if (calcBoxOverlap(line.bbox, tableBboxes[j]) > 0.25) {
          inTable = true;
          break;
        }
      }
      if (inTable) {
        const newLines = splitLineAgressively(line);
        pageObj.lines.splice(i, 1, ...newLines);
      }
    }

    tableBboxes.forEach((bbox) => {
      const dataTable = makeTableFromBbox(pageObj, bbox);
      dataTable.page = dataTablePage;
      dataTablePage.tables.push(dataTable);
    });
  }

  return { pageObj, dataTables: dataTablePage, langSet };
}
