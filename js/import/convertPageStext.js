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

      const dir = xmlLinePreChar.match(/dir=['"](\s*[\d.-]+)(\s*[\d.-]+)/)?.slice(1, 3).map((x) => parseFloat(x));

      let orientation = 0;
      if (dir && Math.abs(dir[0]) < 0.5 && dir[1] >= 0.5) {
        orientation = 1;
      } else if (dir && dir[0] <= -0.5 && Math.abs(dir[1]) < 0.5) {
        orientation = 2;
      } else if (dir && Math.abs(dir[0]) < 0.5 && dir[1] <= -0.5) {
        orientation = 3;
      }

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

      let baselineFirstDone = false;
      const baselineFirst = /** @type {Array<Number>} */ ([]);

      let baselineCurrent = 0;

      /** @type {Array<Array<string>>} */
      const textArr = [];
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
      const underlineArr = [];
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

      /**
       * @typedef {Object} Point
       * @property {number} x - The x coordinate.
       * @property {number} y - The y coordinate.
       */

      /**
       * @typedef {Object} Quad
       * @property {Point} ul - Upper left corner.
       * @property {Point} ur - Upper right corner.
       * @property {Point} ll - Lower left corner.
       * @property {Point} lr - Lower right corner.
       */

      /**
       * @typedef {Object} StextChar
       * @property {Quad} quad
       * @property {Point} origin
       * @property {string} text
       * @property {number} flags
       */

      /**
       * @typedef {Object} StextFont
       * @property {string} name
       * @property {number} size
       */

      const wordCharOrFontArr = /** @type {Array<Array<StextChar|StextFont>>} */([]);
      for (let i = 0; i < wordStrArr.length; i++) {
        // Fonts can be changed at any point in the word string.
        // Sometimes the font is changed before a space character, and othertimes it is changed after the space character.
        // This regex splits the string into elements that contain either (1) a font change or (2) a character.
        // The "quad" attribute includes 8 numbers (x and y coordinates for all 4 corners) however we only use capturing groups for 4
        const stextCharRegex = /(<font[^>]+>\s*)|<char quad=['"](\s*[\d.-]+)(\s*[\d.-]+)(\s*[\d.-]+)(\s*[\d.-]+)(\s*[\d.-]+)(\s*[\d.-]+)(\s*[\d.-]+)(\s*[\d.-]+)[^>]*?x=['"]([\d.-]+)[^>]*?y=['"]([\d.-]+)['"]([^>]*?c=['"][^'"]+['"])\s*\/>/ig;
        const stextMatches = [...wordStrArr[i].matchAll(stextCharRegex)];

        wordCharOrFontArr[i] = [];
        for (let j = 0; j < stextMatches.length; j++) {
          const fontStr = stextMatches[j][1];
          const fontNameStrI = fontStr?.match(/name=['"]([^'"]*)/)?.[1];
          const fontSizeStrI = fontStr?.match(/size=['"]([^'"]*)/)?.[1];
          // fontNameStrI can exist but be an empty string. Therefore, truthy/falsy checks are not sufficient.
          if (fontNameStrI !== undefined && fontSizeStrI !== undefined) {
            // Skip font changes that occur at the end of a line.
            // In addition to being unnecessary, these are problematic when parsing superscripts.
            if (i + 1 === wordStrArr.length && j + 1 === stextMatches.length) continue;
            wordCharOrFontArr[i][j] = {
              name: fontNameStrI,
              size: parseFloat(fontSizeStrI),
            };
            continue;
          }

          let quad;
          if (orientation === 1) {
            quad = {
              ul: { x: parseFloat(stextMatches[j][6]), y: parseFloat(stextMatches[j][7]) },
              ur: { x: parseFloat(stextMatches[j][2]), y: parseFloat(stextMatches[j][3]) },
              ll: { x: parseFloat(stextMatches[j][8]), y: parseFloat(stextMatches[j][9]) },
              lr: { x: parseFloat(stextMatches[j][4]), y: parseFloat(stextMatches[j][5]) },
            };
          } else if (orientation === 2) {
            quad = {
              ul: { x: parseFloat(stextMatches[j][8]), y: parseFloat(stextMatches[j][9]) },
              ur: { x: parseFloat(stextMatches[j][6]), y: parseFloat(stextMatches[j][7]) },
              ll: { x: parseFloat(stextMatches[j][4]), y: parseFloat(stextMatches[j][5]) },
              lr: { x: parseFloat(stextMatches[j][2]), y: parseFloat(stextMatches[j][3]) },
            };
          } else if (orientation === 3) {
            quad = {
              ul: { x: parseFloat(stextMatches[j][4]), y: parseFloat(stextMatches[j][5]) },
              ur: { x: parseFloat(stextMatches[j][8]), y: parseFloat(stextMatches[j][9]) },
              ll: { x: parseFloat(stextMatches[j][2]), y: parseFloat(stextMatches[j][3]) },
              lr: { x: parseFloat(stextMatches[j][6]), y: parseFloat(stextMatches[j][7]) },
            };
          } else {
            quad = {
              ul: { x: parseFloat(stextMatches[j][2]), y: parseFloat(stextMatches[j][3]) },
              ur: { x: parseFloat(stextMatches[j][4]), y: parseFloat(stextMatches[j][5]) },
              ll: { x: parseFloat(stextMatches[j][6]), y: parseFloat(stextMatches[j][7]) },
              lr: { x: parseFloat(stextMatches[j][8]), y: parseFloat(stextMatches[j][9]) },
            };
          }

          const flags = parseInt(stextMatches[j][12]?.match(/flags=['"]([^'"]*)/)?.[1]);
          const text = stextMatches[j][12]?.match(/c=['"]([^'"]*)/)?.[1];

          wordCharOrFontArr[i][j] = {
            quad,
            origin: { x: parseFloat(stextMatches[j][10]), y: parseFloat(stextMatches[j][11]) },
            flags,
            text,
          };
        }
      }

      for (let i = 0; i < wordCharOrFontArr.length; i++) {
        let textWordArr = [];
        let bboxesWordArr = [];
        const underlineWordArr = [];
        let fontFamily = familyCurrent || fontFamilyLine || 'Default';
        // Font size for the word is a separate variable, as if a font size changes at the end of the word,
        // that should not be reflected until the following word.
        let fontSizeWord = sizeCurrent || fontSizeLine || 10;
        let smallCapsWord = smallCapsCurrent || false;
        let smallCapsWordAlt = smallCapsCurrentAlt || false;
        // Title case adjustment does not carry forward between words. A word in title case may be followed by a word in all lower case.
        let smallCapsWordAltTitleCaseAdj = false;
        let styleWord = 'normal';

        if (wordCharOrFontArr[i].length === 0) continue;

        let wordInit = false;

        for (let j = 0; j < wordCharOrFontArr[i].length; j++) {
          const charOrFont = wordCharOrFontArr[i][j];
          if ('name' in charOrFont) {
            // While small caps can be printed using special "small caps" fonts, they can also be printed using a regular font with a size change.
            // This block of code detects small caps printed in title case by checking for a decrease in font size after the first letter.
            // TODO: This logic currently fails when:
            // (1) Runs of small caps include punctuation, which is printed at the full size (and therefore is counted as a size increase ending small caps).
            // (2) Runs of small caps that start with lower-case letters, which do not conform to the expectation that runs of small caps start with a capital letter.
            const sizePrevRaw = sizeCurrentRaw;
            sizeCurrentRaw = charOrFont.size;
            const secondLetter = wordInit && textWordArr.length === 1 && /[A-Z]/.test(textWordArr[0]);

            let baselineNextLetter;
            const possibleNextLetter1 = wordCharOrFontArr[i][j + 1];
            const possibleNextLetter2 = wordCharOrFontArr[i + 1]?.[0];
            const possibleNextLetter3 = wordCharOrFontArr[i + 1]?.[1];
            const possibleNextLetter4 = wordCharOrFontArr[i + 1]?.[2];

            if (possibleNextLetter1 && 'origin' in possibleNextLetter1) {
              baselineNextLetter = possibleNextLetter1.origin.y;
            } else if (possibleNextLetter2 && 'origin' in possibleNextLetter2) {
              baselineNextLetter = possibleNextLetter2.origin.y;
            } else if (possibleNextLetter3 && 'origin' in possibleNextLetter3) {
              baselineNextLetter = possibleNextLetter3.origin.y;
            } else if (possibleNextLetter4 && 'origin' in possibleNextLetter4) {
              baselineNextLetter = possibleNextLetter4.origin.y;
            }

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
                textArr.push(textWordArr);
                bboxes.push(bboxesWordArr);
                styleArr.push(styleWord);
                fontFamilyArr.push(fontFamily);

                if (sizeDelta > 0) {
                  fontSizeArr.push(sizePrevRaw);
                } else {
                  fontSizeArr.push(fontSizeWord);
                }

                smallCapsArr.push(smallCapsWord);
                smallCapsAltArr.push(smallCapsWordAlt);
                smallCapsAltTitleCaseArr.push(smallCapsWordAltTitleCaseAdj);
                superArr.push(sizeDelta > 0);

                textWordArr = [];
                bboxesWordArr = [];
              }

              if (sizeDelta > 0) {
                // If the first word was determined to be a superscript, reset `baselineFirst` to avoid skewing the slope calculation.
                if (!baselineFirstDone) baselineFirst.length = 0;
                familyCurrent = charOrFont.name || familyCurrent;
                sizeCurrent = sizeCurrentRaw || sizeCurrent;
                fontSizeWord = sizeCurrent;
                fontFamily = familyCurrent;
                superArr[superArr.length - 1] = true;
              }

              // If `baselineFirstDone` was set using a non-superscript word, mark it as done.
              if (superArr.length > 0 && !superArr[superArr.length - 1] && baselineFirst.length > 0) {
                baselineFirstDone = true;
              }

              superCurrent = sizeDelta < 0;
            } else {
              sizeCurrent = sizeCurrentRaw || sizeCurrent;
              familyCurrent = charOrFont.name || familyCurrent;
              // Update current word only if this is before every letter in the word.
              if (textWordArr.length === 0) {
                fontSizeWord = sizeCurrent;
                fontFamily = familyCurrent;
              }
              // An increase in font size ends any small caps sequence.
              // A threshold is necessary because stext data has been observed to have small variations without a clear reason.
              // eslint-disable-next-line no-lonely-if
              if (Number.isFinite(sizeDelta) && Math.abs(sizeDelta) > 0.05) {
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
            smallCapsCurrent = /(small\W?cap)|(sc$)|(caps$)/i.test(charOrFont.name);
            smallCapsWord = smallCapsCurrent;

            if (/italic/i.test(charOrFont.name) || /-\w*ital/i.test(charOrFont.name) || /-it$/i.test(charOrFont.name) || /oblique/i.test(charOrFont.name)) {
              // The word is already initialized, so we need to change the last element of the style array.
              // Label as `smallCapsAlt` rather than `smallCaps`, as we confirm the word is all caps before marking as `smallCaps`.
              styleCurrent = 'italic';
            } else if (/bold|black/i.test(charOrFont.name)) {
              styleCurrent = 'bold';
            } else {
              styleCurrent = 'normal';
            }

            continue;
          } else {
            baselineCurrent = charOrFont.origin.y;
          }

          if (!wordInit) {
            styleWord = styleCurrent;
            wordInit = true;
          }

          let bbox;
          if (orientation === 1) {
            bbox = {
              left: Math.round(charOrFont.origin.y),
              top: Math.round(pageDims.width - Math.max(charOrFont.quad.ur.x, charOrFont.quad.lr.x)),
              right: Math.round(charOrFont.origin.y + (charOrFont.quad.lr.y - charOrFont.quad.ur.y)),
              bottom: Math.round(pageDims.width - Math.min(charOrFont.quad.ul.x, charOrFont.quad.ll.x)),
            };
          } else if (orientation === 2) {
            bbox = {
              left: Math.round(pageDims.width - charOrFont.origin.x),
              top: Math.round(pageDims.height - Math.max(charOrFont.quad.ll.y, charOrFont.quad.lr.y)),
              right: Math.round(pageDims.width - (charOrFont.origin.x - (charOrFont.quad.ur.x - charOrFont.quad.ul.x))),
              bottom: Math.round(pageDims.height - Math.min(charOrFont.quad.ul.y, charOrFont.quad.ur.y)),
            };
          } else if (orientation === 3) {
            bbox = {
              left: Math.round(pageDims.height - charOrFont.origin.y),
              top: Math.round(Math.min(charOrFont.quad.ul.x, charOrFont.quad.ll.x)),
              right: Math.round(pageDims.height - charOrFont.origin.y + (charOrFont.quad.lr.y - charOrFont.quad.ur.y)),
              bottom: Math.round(Math.max(charOrFont.quad.ur.x, charOrFont.quad.lr.x)),
            };
          } else {
            bbox = {
              left: Math.round(charOrFont.origin.x),
              top: Math.round(Math.min(charOrFont.quad.ul.y, charOrFont.quad.ur.y)),
              right: Math.round(charOrFont.origin.x + (charOrFont.quad.ur.x - charOrFont.quad.ul.x)),
              bottom: Math.round(Math.max(charOrFont.quad.ll.y, charOrFont.quad.lr.y)),
            };
          }

          if (!superCurrent) {
            if (baselineFirst.length === 0) {
              let originY;
              if (orientation === 1) {
                originY = pageDims.width - charOrFont.origin.x;
              } else if (orientation === 2) {
                originY = pageDims.height - charOrFont.origin.y;
              } else if (orientation === 3) {
                originY = charOrFont.origin.x;
              } else {
                originY = charOrFont.origin.y;
              }

              baselineFirst.push(bbox.left, originY);
            }
          }

          // Small caps created by reducing font size can carry forward across multiple words.
          smallCapsCurrentAlt = smallCapsCurrentAlt ?? smallCapsAltArr[smallCapsAltArr.length - 1];

          textWordArr.push(charOrFont.text);

          underlineWordArr.push(charOrFont.flags === 2);

          bboxesWordArr.push(bbox);
        }

        if (textWordArr.length === 0) continue;

        const underlineWord = underlineWordArr.reduce((a, b) => Number(a) + Number(b), 0) / underlineWordArr.length > 0.5;
        underlineArr.push(underlineWord);

        wordLetterOrFontArrIndex.push(i);
        textArr.push(textWordArr);
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
        if (superCurrent) fontSizeArr[fontSizeArr.length - 1] = sizeCurrentRaw;
      }

      // Return if there are no letters in the line.
      // This commonly happens for "lines" that contain only space characters.
      if (bboxes.length === 0) return;

      let baselineSlope = 0;
      if (dir && dir[0] !== undefined && !Number.isNaN(dir[0]) && dir[1] !== undefined && !Number.isNaN(dir[1])) {
        if (orientation === 1) {
          baselineSlope = -dir[0];
        } else if (orientation === 2) {
          baselineSlope = -dir[1];
        } else if (orientation === 3) {
          baselineSlope = dir[0];
        } else {
          baselineSlope = dir[1];
        }
      } else {
        console.log('Unable to parse slope.');
      }

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

      lineObj.orientation = orientation;

      lineObj.raw = xmlLine;

      let lettersKept = 0;
      for (let i = 0; i < textArr.length; i++) {
        const wordText = unescapeXml(textArr[i].join(''));

        if (wordText.trim() === '') continue;

        const wordLang = calcLang(wordText);
        langSet.add(wordLang);

        const wordID = `word_${n + 1}_${pageObj.lines.length + 1}_${i + 1}`;
        const bboxesI = bboxes[i];

        /** @type {Array<OcrChar>} */
        const charObjArr = [];

        for (let j = 0; j < textArr[i].length; j++) {
          const letter = unescapeXml(textArr[i][j]);

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

        wordObj.underline = underlineArr[i];

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
      // The `Math.abs(angle) < 0.3` condition avoids vertical text impacting the angle calculation.
      // The page angle is intended to account for page skew, not different orientations (90/180/270 degrees).
      // TODO: Eventually different orientations should be supported.
      if (typeof angle === 'number' && !Number.isNaN(angle) && Math.abs(angle) < 0.3) angleRisePage.push(angle);
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

  const autoDetectTables = false;
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
