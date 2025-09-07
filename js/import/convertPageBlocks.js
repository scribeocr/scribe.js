import ocr from '../objects/ocrObjects.js';

import { pass2, pass3 } from './convertPageShared.js';

import { LayoutDataTablePage } from '../objects/layoutObjects.js';
import {
  ascCharArr, getTextScript, mean50, xCharArr,
} from '../utils/miscUtils.js';

const baselineCharArr = [...xCharArr, ...ascCharArr];

/**
 * @param {Object} params
 * @param {Array<import('@scribe.js/tesseract.js').Block>} params.ocrBlocks
 * @param {number} params.n
 * @param {dims} params.pageDims
 * @param {number} params.rotateAngle - The angle that the input image is rotated prior to recognition.
 *    This is used to transform OCR coordinates back to the original coordinate space after recognizing a rotated intermediate image.
 * @param {boolean} params.keepItalic - If true, italic tags (`<em>`) are honored.  This is false by default,
 *    as vanilla Tesseract does not recognize italic text in a way that is reliable.
 *    This is fixed for Legacy recognition in the included custom build of Tesseract.
 * @param {boolean} [params.upscale=false]
 */
export async function convertPageBlocks({
  ocrBlocks, n, pageDims, keepItalic, rotateAngle, upscale = false,
}) {
  rotateAngle = rotateAngle || 0;

  if (upscale) {
    pageDims.height *= 2;
    pageDims.width *= 2;
  }

  const currentLang = 'eng';

  const pageObj = new ocr.OcrPage(n, pageDims);

  let wordCount = 0;

  for (let i = 0; i < ocrBlocks.length; i++) {
    const block = ocrBlocks[i];
    for (let j = 0; j < block.paragraphs.length; j++) {
      const paragraph = block.paragraphs[j];

      const parbox = {
        left: paragraph.bbox.x0, top: paragraph.bbox.y0, right: paragraph.bbox.x1, bottom: paragraph.bbox.y1,
      };

      const parObj = new ocr.OcrPar(pageObj, parbox);

      for (let k = 0; k < paragraph.lines.length; k++) {
        const line = paragraph.lines[k];

        const linebox = {
          left: line.bbox.x0, top: line.bbox.y0, right: line.bbox.x1, bottom: line.bbox.y1,
        };

        const x0 = line.baseline.x0 - linebox.left;
        const x1 = line.baseline.x1 - linebox.left;
        const y0 = line.baseline.y0 - linebox.bottom;
        const y1 = line.baseline.y1 - linebox.bottom;

        const baselineSlope = (y1 - y0) / (x1 - x0);
        const baselinePoint = y0 - baselineSlope * x0;

        const baseline = [baselineSlope, baselinePoint];

        // This case presumably happens for vertical text, which we currently do not support.
        if (!Number.isFinite(baselineSlope) || !Number.isFinite(baselinePoint)) {
          baseline[0] = 0;
          baseline[1] = 0;
        }

        // Tesseract.js lists `row_height` instead of `rowHeight` in the types file, which is wrong.
        // This has been fixed in the upstream, so the `ts-ignore` comments
        // can be removed once Tesseract.js is updated in our dependencies.
        // @ts-ignore
        const ascHeight = line.rowAttributes.rowHeight - line.rowAttributes.descenders;
        // @ts-ignore
        const xHeight = line.rowAttributes.rowHeight - line.rowAttributes.descenders - line.rowAttributes.ascenders;

        const lineObj = new ocr.OcrLine(pageObj, linebox, baseline, ascHeight, xHeight);
        lineObj.par = parObj;

        for (let l = 0; l < line.words.length; l++) {
          const word = line.words[l];

          const wordbox = {
            left: word.bbox.x0, top: word.bbox.y0, right: word.bbox.x1, bottom: word.bbox.y1,
          };

          const id = `word_${n + 1}_${wordCount}`;
          wordCount++;

          // Words containing only space characters are skipped.
          if (word.text.trim() === '') continue;

          let wordLang = word.language || currentLang;
          if (['chi_sim', 'chi_tra'].includes(wordLang)) {
            const { han: hanChars, latin: latinChars } = getTextScript(word.text);

            if (hanChars === 0) {
              // Do not let languages be switched for a word that contains 0 Han characters.
              if (!['chi_sim', 'chi_tra'].includes(currentLang)) {
                wordLang = currentLang;
              // Do not let language be Chinese for any word that contains no Han characters and >0 non-Chinese characters.
              // TODO: Assign the appropriate Latin language (not necessarily English).
              } else if (latinChars > 0) {
                wordLang = 'eng';
              }
            }
          }

          // For Chinese, individual characters are treated as words.
          if (['chi_sim', 'chi_tra'].includes(wordLang)) {
            for (let m = 0; m < word.symbols.length; m++) {
              const symbol = word.symbols[m];

              const symbolbox = {
                left: symbol.bbox.x0, top: symbol.bbox.y0, right: symbol.bbox.x1, bottom: symbol.bbox.y1,
              };

              const wordObj = new ocr.OcrWord(lineObj, `${id}_${m}`, symbol.text, symbolbox);
              wordObj.conf = symbol.confidence;
              wordObj.lang = wordLang;

              lineObj.words.push(wordObj);
            }
            continue;
          }

          const wordObj = new ocr.OcrWord(lineObj, id, word.text.trim(), wordbox);
          wordObj.lang = word.language;
          wordObj.conf = word.confidence;

          // Keep alternative choices if they have higher confidence than the primary choice.
          // This happens when the original "best choice" is rejected due to an ad-hoc penalty, most frequently because it is a non-dictionary word.
          if (word.choices.length > 0) {
            word.choices.sort((a, b) => b.confidence - a.confidence);
            if (word.choices[0].text !== word.text) {
              wordObj.textAlt = word.choices[0].text;
            }
          }

          // The `word` object has a `is_italic` property, but it is always false.
          // Therefore, the font name is checked to determine if the word is italic.
          // See: https://github.com/naptha/tesseract.js/issues/907
          if (keepItalic && /italic/i.test(word.font_name)) wordObj.style.italic = true;

          // Our fork of Tesseract Legacy should be able to recognize fonts, so this information is included.
          // The generic HOCR importer does not include font information, as this is assumed to be unreliable.
          wordObj.style.font = word.font_name;

          wordObj.chars = [];
          for (let m = 0; m < word.symbols.length; m++) {
            const symbol = word.symbols[m];

            // The LSTM model sometimes produces space characters.
            if (!symbol.text?.trim()) continue;

            const symbolbox = {
              left: symbol.bbox.x0, top: symbol.bbox.y0, right: symbol.bbox.x1, bottom: symbol.bbox.y1,
            };

            const charObj = new ocr.OcrChar(symbol.text, symbolbox);

            wordObj.chars.push(charObj);
          }

          lineObj.words.push(wordObj);
        }

        if (lineObj.words.length > 0) {
          // If the line contains only one word and this is Tesseract Legacy (so bounding boxes are accurate), re-calculate the baseline.
          // Tesseract calculates the baseline early in the recognition process under the assumption that most text is on the baseline,
          // so baselines are frequently inaccurate for single-word lines.
          // `keepItalic` is used to determine if this is using Tesseract Legacy; should be edited for clarity.
          if (lineObj.words.length === 1 && keepItalic && lineObj.words[0].chars) {
            const baselineBottomArr = lineObj.words[0].chars.filter((char) => baselineCharArr.includes(char.text)).map((char) => char.bbox.bottom);
            if (baselineBottomArr.length * 2 > lineObj.words[0].chars.length) {
              const baselineBottom = mean50(baselineBottomArr);
              lineObj.baseline[1] = baselineBottom - lineObj.bbox.bottom;
            }
          }
          pageObj.lines.push(lineObj);
          parObj.lines.push(lineObj);
        }
      }
      if (parObj.lines.length > 0) {
        pageObj.pars.push(parObj);
      }
    }
  }

  pageObj.angle = rotateAngle;

  if (upscale) ocr.scalePage(pageObj, 0.5);

  pass2(pageObj, rotateAngle);
  const langSet = pass3(pageObj);

  return {
    pageObj, dataTables: new LayoutDataTablePage(n), warn: { char: '' }, langSet,
  };
}
