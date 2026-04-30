import ocr from '../objects/ocrObjects.js';

import { inputData, opt } from '../containers/app.js';
import { extractTableContent } from '../extractTables.js';

/**
 * Convert a 0-based column index to an Excel column reference (A, B, ..., Z, AA, AB, ...).
 * @param {number} index
 */
function colIndexToRef(index) {
  let ref = '';
  let n = index;
  do {
    ref = String.fromCharCode(65 + (n % 26)) + ref;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return ref;
}

/**
 * @param {Object} params
 * @param {ReturnType<extractTableContent>} params.tableWordObj
 * @param {Array<string>} [params.extraCols=[]]
 * @param {number} [params.startRow=0]
 * @param {boolean} [params.xlsxMode=true]
 * @param {boolean} [params.htmlMode=false]
 */
export function createCells({
  tableWordObj, extraCols = [], startRow = 0, xlsxMode = true, htmlMode = false,
}) {
  let textStr = '';
  let rowIndex = startRow;
  let rowCount = 0;

  for (const [key, value] of Object.entries(tableWordObj)) {
    const cellsSingle = createCellsSingle({
      ocrTableWords: value.rowWordArr, extraCols, startRow: rowIndex, xlsxMode, htmlMode,
    });
    textStr += cellsSingle.content;
    rowIndex += cellsSingle.rows;
    rowCount += cellsSingle.rows;
  }

  return { content: textStr, rows: rowCount };
}

/**
 * Convert a single table into HTML or Excel XML rows
 * @param {Object} params
 * @param {ReturnType<import('../extractTables.js').extractSingleTableContent>['rowWordArr']} params.ocrTableWords
 * @param {Array<string>} [params.extraCols=[]]
 * @param {number} [params.startRow=0]
 * @param {boolean} [params.xlsxMode=true]
 * @param {boolean} [params.htmlMode=false]
 * @param {boolean} [params.previewMode=true]
 */
function createCellsSingle({
  ocrTableWords, extraCols = [], startRow = 0, xlsxMode = true, htmlMode = false, previewMode = true,
}) {
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
        textStr += `<c r="${colIndexToRef(j)}${String(startRow + i + 1)}" t="inlineStr"><is><r><t xml:space="preserve">${colTxt}</t></r></is></c>`;
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
        textStr += `<c r="${colIndexToRef(j + extraCols.length)}${String(startRow + i + 1)}" t="inlineStr"><is>`;
      } else if (htmlMode) {
        textStr += '<td>';
      }

      for (let k = 0; k < words.length; k++) {
        const wordObj = words[k];

        const fontStylePrev = '';

        if (xlsxMode) {
          let fontStyle = '';
          if (wordObj.style.bold) fontStyle += '<b/>';
          if (wordObj.style.italic) fontStyle += '<i/>';
          if (wordObj.style.smallCaps) fontStyle += '<smallCaps/>';

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
 * Build an XLSX ZIP archive from complete sheet XML and boilerplate files.
 * @param {string} sheetXml - Complete XML for xl/worksheets/sheet1.xml.
 * @param {Array<{path: string, content: string}>} xlsxStrings - Boilerplate files.
 * @returns {Promise<Uint8Array>}
 */
async function buildXlsxZip(sheetXml, xlsxStrings) {
  const { Uint8ArrayWriter, TextReader, ZipWriter } = await import('../../lib/zip.js/index.js');
  const zipFileWriter = new Uint8ArrayWriter();
  const zipWriter = new ZipWriter(zipFileWriter);
  await zipWriter.add('xl/worksheets/sheet1.xml', new TextReader(sheetXml));
  for (let i = 0; i < xlsxStrings.length; i++) {
    await zipWriter.add(xlsxStrings[i].path, new TextReader(xlsxStrings[i].content));
  }
  await zipWriter.close();
  return zipFileWriter.getData();
}

/**
 *
 * @param {Object} params
 * @param {Array<OcrPage>} params.ocrPageArr
 * @param {Array<LayoutDataTablePage>} params.layoutPageArr
 * @param {?Array<number>} [params.pageArr=null] - Array of 0-based page indices to include. Overrides minpage/maxpage when provided.
 * @param {number} [params.minpage=0]
 * @param {number} [params.maxpage=-1]
 */
export async function writeXlsx({
  ocrPageArr, layoutPageArr, pageArr = null, minpage = 0, maxpage = -1,
}) {
  const { xlsxStrings, sheetPreamble, sheetClose } = await import('./resources/xlsxFiles.js');

  if (!pageArr) {
    if (maxpage === -1) maxpage = ocrPageArr.length - 1;
    pageArr = [];
    for (let i = minpage; i <= maxpage; i++) pageArr.push(i);
  }

  let cellContent = '';
  let rowCount = 0;
  for (const i of pageArr) {
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
    const cellsObj = createCells({ tableWordObj, extraCols, startRow: rowCount });
    rowCount += cellsObj.rows;
    cellContent += cellsObj.content;
    opt.progressHandler({ n: i, type: 'export', info: { } });
  }

  const sheetXml = `${sheetPreamble}<sheetData>${cellContent}</sheetData>${sheetClose}`;
  return buildXlsxZip(sheetXml, xlsxStrings);
}

/**
 * Create a single-sheet xlsx workbook from plain data.
 * @param {Array<Array<string|number|null|undefined>>} rows - 2D array of cell values.
 * @param {Object} [options]
 * @param {number} [options.headerRows=0] - Number of leading rows to bold+underline.
 * @param {boolean} [options.autoFilter=false] - Add dropdown filters spanning the data range.
 * @param {'auto'|Array<number>} [options.columnWidths] - Column width strategy.
 */
export async function writeXlsxFromRows(rows, options = {}) {
  const { xlsxStrings, sheetPreamble, sheetClose } = await import('./resources/xlsxFiles.js');

  const { headerRows = 0, autoFilter = false, columnWidths } = options;

  let maxCols = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].length > maxCols) maxCols = rows[i].length;
  }

  let colsXml = '';
  if (columnWidths) {
    let widths;
    if (columnWidths === 'auto') {
      widths = new Array(maxCols).fill(0);
      for (let i = 0; i < rows.length; i++) {
        for (let j = 0; j < rows[i].length; j++) {
          const val = rows[i][j];
          const len = val == null ? 0 : String(val).length;
          if (len > widths[j]) widths[j] = len;
        }
      }
      for (let c = 0; c < widths.length; c++) {
        widths[c] = Math.min(Math.max(widths[c] * 1.2 + 2, 8), 60);
      }
    } else {
      widths = columnWidths;
    }
    colsXml = '<cols>';
    for (let c = 0; c < widths.length; c++) {
      colsXml += `<col min="${c + 1}" max="${c + 1}" width="${widths[c]}" customWidth="1"/>`;
    }
    colsXml += '</cols>';
  }

  let cellContent = '';
  for (let i = 0; i < rows.length; i++) {
    cellContent += `<row r="${String(i + 1)}">`;
    const isHeader = i < headerRows;
    for (let j = 0; j < rows[i].length; j++) {
      const val = rows[i][j];
      const cellRef = `${colIndexToRef(j)}${String(i + 1)}`;
      const styleAttr = isHeader ? ' s="1"' : '';

      if (typeof val === 'number' && Number.isFinite(val)) {
        cellContent += `<c r="${cellRef}"${styleAttr}><v>${val}</v></c>`;
      } else {
        const cellText = ocr.escapeXml(val == null ? '' : String(val));
        cellContent += `<c r="${cellRef}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${cellText}</t></is></c>`;
      }
    }
    cellContent += '</row>';
  }

  let autoFilterXml = '';
  if (autoFilter && rows.length > 0 && maxCols > 0) {
    autoFilterXml = `<autoFilter ref="A1:${colIndexToRef(maxCols - 1)}${rows.length}"/>`;
  }

  const sheetXml = `${sheetPreamble}${colsXml}<sheetData>${cellContent}</sheetData>${autoFilterXml}${sheetClose}`;
  return buildXlsxZip(sheetXml, xlsxStrings);
}
