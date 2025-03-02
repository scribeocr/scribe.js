import ocr from '../objects/ocrObjects.js';

import { inputData, opt } from '../containers/app.js';
import { extractTableContent } from '../extractTables.js';

/**
 * @param {ReturnType<extractTableContent>} tableWordObj
 * @param {Array<string>} extraCols
 * @param {number} startRow
 * @param {boolean} xlsxMode
 * @param {boolean} htmlMode
 */
export function createCells(tableWordObj, extraCols = [], startRow = 0, xlsxMode = true, htmlMode = false) {
  let textStr = '';
  let rowIndex = startRow;
  let rowCount = 0;

  for (const [key, value] of Object.entries(tableWordObj)) {
    const cellsSingle = createCellsSingle(value.rowWordArr, extraCols, rowIndex, xlsxMode, htmlMode);
    textStr += cellsSingle.content;
    rowIndex += cellsSingle.rows;
    rowCount += cellsSingle.rows;
  }

  return { content: textStr, rows: rowCount };
}

/**
 * Convert a single table into HTML or Excel XML rows
 * @param {ReturnType<import('../extractTables.js').extractSingleTableContent>['rowWordArr']} ocrTableWords
 * @param {Array<string>} extraCols
 * @param {number} startRow
 * @param {boolean} xlsxMode
 * @param {boolean} htmlMode
 * @param {boolean} previewMode
 */
function createCellsSingle(ocrTableWords, extraCols = [], startRow = 0, xlsxMode = true, htmlMode = false, previewMode = true) {
  const letters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z'];

  let textStr = htmlMode ? '<table>' : '';
  for (let i = 0; i < ocrTableWords.length; i++) {
    if (xlsxMode) {
      textStr += `<row r="${String(startRow + i + 1)}">`;
    } else if (htmlMode) {
      textStr += '<tr>';
    }

    for (let j = 0; j < extraCols.length; j++) {
      // Escape special characters for XML
      let colTxt = ocr.escapeXml(extraCols[j]);
      if (xlsxMode) {
        textStr += `<c r="${letters[j]}${String(startRow + i + 1)}" t="inlineStr"><is><r><t xml:space="preserve">${colTxt}</t></r></is></c>`;
      } else if (htmlMode) {
        // When generating an HTML preview, file names are abbreviated for readability
        if (previewMode && colTxt.length > 13) {
          colTxt = `${colTxt.slice(0, 20)}...`;
        }
        textStr += `<td>${colTxt}</td>`;
      }
    }

    for (let j = 0; j < ocrTableWords[i].length; j++) {
      const words = ocrTableWords[i][j];

      // In xlsx, empty cells are omitted entirely.  For other formats they are included.
      if (!words || words.length === 0) {
        if (htmlMode) {
          textStr += '<td/>';
        }
        continue;
      }

      // Sort left to right so words are printed in the correct order
      words.sort((a, b) => a.bbox.left - b.bbox.left);

      if (xlsxMode) {
        textStr += `<c r="${letters[j + extraCols.length]}${String(startRow + i + 1)}" t="inlineStr"><is>`;
      } else if (htmlMode) {
        textStr += '<td>';
      }

      for (let k = 0; k < words.length; k++) {
        const wordObj = words[k];

        const fontStylePrev = '';

        if (xlsxMode) {
          let fontStyle;
          if (wordObj.style.italic) {
            fontStyle = '<i/>';
          } else if (wordObj.style.smallCaps) {
            fontStyle = '<smallCaps/>';
          } else {
            fontStyle = '';
          }

          if (fontStyle !== fontStylePrev || k === 0) {
            const styleStr = fontStyle === '' ? '' : `<rPr>${fontStyle}</rPr>`;

            if (k === 0) {
              textStr = `${textStr}<r>${styleStr}<t xml:space="preserve">`;
            } else {
              textStr = `${textStr} </t></r><r>${styleStr}<t xml:space="preserve">`;
            }
          } else {
            textStr += ' ';
          }
        } else {
          textStr += ' ';
        }

        // DOCX is an XML format, so any escaped XML characters need to continue being escaped.
        if (xlsxMode) {
          // TODO: For now we just delete superscript tags.
          // Eventually this should be added to Word exports properly.
          textStr += ocr.escapeXml(wordObj.text);
        } else {
          textStr += wordObj.text;
        }
      }

      if (xlsxMode) {
        textStr += '</t></r></is></c>';
      } else if (htmlMode) {
        textStr += '</td>';
      }
    }

    if (xlsxMode) {
      textStr += '</row>';
    } else if (htmlMode) {
      textStr += '</tr>';
    }
  }

  if (htmlMode) textStr += '</table>';

  return { content: textStr, rows: ocrTableWords.length };
}

/**
 *
 * @param {Array<OcrPage>} ocrPageArr
 * @param {Array<LayoutDataTablePage>} layoutPageArr
 * @param {number} minpage
 * @param {number} maxpage
 */
export async function writeXlsx(ocrPageArr, layoutPageArr, minpage = 0, maxpage = -1) {
  const { xlsxStrings, sheetStart, sheetEnd } = await import('./resources/xlsxFiles.js');
  const { Uint8ArrayWriter, TextReader, ZipWriter } = await import('../../lib/zip.js/index.js');

  if (maxpage === -1) maxpage = ocrPageArr.length - 1;

  const zipFileWriter = new Uint8ArrayWriter();
  const zipWriter = new ZipWriter(zipFileWriter);

  let sheetContent = sheetStart;
  let rowCount = 0;
  for (let i = minpage; i <= maxpage; i++) {
    /** @type {Array<string>} */
    const extraCols = [];
    if (opt.xlsxFilenameColumn) {
      if (inputData.pdfMode) {
        extraCols.push(inputData.inputFileNames[0]);
      } else {
        extraCols.push(inputData.inputFileNames[i]);
      }
    }
    if (opt.xlsxPageNumberColumn) extraCols.push(String(i + 1));

    const tableWordObj = extractTableContent(ocrPageArr[i], layoutPageArr[i]);
    const cellsObj = createCells(tableWordObj, extraCols, rowCount);
    rowCount += cellsObj.rows;
    sheetContent += cellsObj.content;
    opt.progressHandler({ n: i, type: 'export', info: { } });
  }
  sheetContent += sheetEnd;

  const textReader = new TextReader(sheetContent);
  await zipWriter.add('xl/worksheets/sheet1.xml', textReader);

  for (let i = 0; i < xlsxStrings.length; i++) {
    const textReaderI = new TextReader(xlsxStrings[i].content);
    await zipWriter.add(xlsxStrings[i].path, textReaderI);
  }

  await zipWriter.close();

  const zipFileData = await zipFileWriter.getData();

  return zipFileData;
}
