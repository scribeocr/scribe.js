import ocr from '../objects/ocrObjects.js';

import { scribeDocDefaults } from '../containers/scribeDocDefaults.js';
import { extractTableContent } from '../extractTables.js';
import { standardFontToCSS } from '../pdf/fonts/standardFontMetrics.js';
import { determineSansSerif } from '../utils/miscUtils.js';

/** @typedef {import('../extractTables.js').TableCellRich} TableCellRich */

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

      let fontStylePrev = '';
      for (let k = 0; k < words.length; k++) {
        const wordObj = words[k];

        if (xlsxMode) {
          let fontStyle = '';
          if (wordObj.style.bold) fontStyle += '<b/>';
          if (wordObj.style.italic) fontStyle += '<i/>';

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
          fontStylePrev = fontStyle;
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
 * Build an XLSX ZIP archive from complete per-sheet XML and boilerplate files.
 * @param {Array<string>} sheetXmls - Complete XML for xl/worksheets/sheetN.xml, one entry per sheet in workbook order.
 * @param {Array<{path: string, content: string}>} xlsxStrings - Boilerplate files (must reference the same sheet count).
 * @returns {Promise<Uint8Array>}
 */
async function buildXlsxZip(sheetXmls, xlsxStrings) {
  const { Uint8ArrayWriter, TextReader, ZipWriter } = await import('../../lib/zip.js/index.js');
  const zipFileWriter = new Uint8ArrayWriter();
  const zipWriter = new ZipWriter(zipFileWriter);
  for (let i = 0; i < sheetXmls.length; i++) {
    await zipWriter.add(`xl/worksheets/sheet${i + 1}.xml`, new TextReader(sheetXmls[i]));
  }
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
 * @param {import('../containers/app.js').InputData} params.inputData - The document's input metadata, used for the optional filename column.
 * @param {?Array<number>} [params.pageArr=null] - Array of 0-based page indices to include. Overrides minpage/maxpage when provided.
 * @param {number} [params.minpage=0]
 * @param {number} [params.maxpage=-1]
 * @param {boolean} [params.xlsxFilenameColumn] - Defaults to `scribeDocDefaults.xlsxFilenameColumn`.
 * @param {boolean} [params.xlsxPageNumberColumn] - Defaults to `scribeDocDefaults.xlsxPageNumberColumn`.
 * @param {?import('../containers/scribeDoc.js').ScribeDoc} [params.doc=null] - Owning document for progress reporting.
 */
export async function writeXlsx({
  ocrPageArr, layoutPageArr, inputData, pageArr = null, minpage = 0, maxpage = -1,
  xlsxFilenameColumn = scribeDocDefaults.xlsxFilenameColumn,
  xlsxPageNumberColumn = scribeDocDefaults.xlsxPageNumberColumn,
  doc = null,
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
    if (xlsxFilenameColumn) {
      if (inputData.pdfMode) {
        extraCols.push(inputData.inputFileNames[0]);
      } else {
        extraCols.push(inputData.inputFileNames[i]);
      }
    }
    if (xlsxPageNumberColumn) extraCols.push(String(i + 1));

    const tableWordObj = extractTableContent(ocrPageArr[i], layoutPageArr[i]);
    const cellsObj = createCells({ tableWordObj, extraCols, startRow: rowCount });
    rowCount += cellsObj.rows;
    cellContent += cellsObj.content;
    doc?.progressHandler({ n: i, type: 'export', info: { } });
  }

  const sheetXml = `${sheetPreamble}<sheetData>${cellContent}</sheetData>${sheetClose}`;
  return buildXlsxZip([sheetXml], xlsxStrings);
}

/**
 * One styled table region within a sheet's rows, addressed by row offsets.
 * The `headerRows` leading rows are bolded and underlined, except that a rich cell keeps the weight its own runs carry.
 * `grid` draws a thin border around every cell, `zebra` fills alternating data rows, and `alignNumeric` right-aligns columns whose data cells are at least 70 percent numeric.
 * `zebraColor` sets the zebra fill as `#rrggbb`, defaulting to light gray.
 * @typedef {{start: number, rowCount: number, headerRows: number, grid?: boolean, zebra?: boolean, zebraColor?: string, alignNumeric?: boolean}} XlsxTableRange
 */

/**
 * Workbook-level font, fill, border, and cell-format tables used to generate styles.xml.
 * These are seeded with the static boilerplate's own entries so that existing style indices, notably `s="1"` for bold plus bottom border, keep their meaning for every caller.
 * @typedef {{fonts: string[], fills: string[], borders: string[], cellXfs: string[], xfKeys: Map<string, number>, officeFontCache: Map<string, ?string>}} StyleInterner
 */

/** @returns {StyleInterner} */
function createStyleInterner() {
  return {
    fonts: [
      '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>',
      '<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>',
    ],
    fills: [
      '<fill><patternFill patternType="none"/></fill>',
      '<fill><patternFill patternType="gray125"/></fill>',
    ],
    borders: [
      '<border><left/><right/><top/><bottom/><diagonal/></border>',
      '<border><left/><right/><top/><bottom style="thin"><color indexed="64"/></bottom><diagonal/></border>',
    ],
    cellXfs: [
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>',
    ],
    xfKeys: new Map([['0|0|0|', 0], ['1|0|1|', 1]]),
    officeFontCache: new Map(),
  };
}

/**
 * Replace the styles.xml style-table sections with the interner's tables.
 * @param {string} seed - The static boilerplate styles.xml.
 * @param {StyleInterner} styleState
 */
function buildStylesXml(seed, styleState) {
  const sections = [
    ['<fonts ', '</fonts>', `<fonts count="${styleState.fonts.length}" x14ac:knownFonts="1">${styleState.fonts.join('')}</fonts>`],
    ['<fills ', '</fills>', `<fills count="${styleState.fills.length}">${styleState.fills.join('')}</fills>`],
    ['<borders ', '</borders>', `<borders count="${styleState.borders.length}">${styleState.borders.join('')}</borders>`],
    ['<cellXfs ', '</cellXfs>', `<cellXfs count="${styleState.cellXfs.length}">${styleState.cellXfs.join('')}</cellXfs>`],
  ];
  let xml = seed;
  for (const [open, close, replacement] of sections) {
    const start = xml.indexOf(open);
    const end = xml.indexOf(close) + close.length;
    xml = xml.slice(0, start) + replacement + xml.slice(end);
  }
  return xml;
}

/** Whether the interner grew past its seed entries, meaning styles.xml has to be regenerated. @param {StyleInterner} s */
const stylesGrew = (s) => s.fonts.length > 2 || s.fills.length > 2 || s.borders.length > 2 || s.cellXfs.length > 2;

/**
 * Create a single-sheet xlsx workbook from plain data.
 * @param {Array<Array<string|number|null|undefined|TableCellRich>>} rows - 2D array of cell values.
 * @param {Object} [options]
 * @param {number} [options.headerRows=0] - Number of leading rows to bold+underline.
 * @param {boolean} [options.autoFilter=false] - Add dropdown filters spanning the data range.
 * @param {'auto'|Array<number>} [options.columnWidths] - Column width strategy.
 * @param {?Array<XlsxTableRange>} [options.tableRanges] - Styled table regions, which override `headerRows` when present.
 */
export async function writeXlsxFromRows(rows, options = {}) {
  const { xlsxStrings, sheetPreamble, sheetClose } = await import('./resources/xlsxFiles.js');
  const styleState = createStyleInterner();
  const sheetXml = buildSheetXml(rows, options, 0, { sheetPreamble, sheetClose }, styleState);
  const strings = stylesGrew(styleState)
    ? xlsxStrings.map((f) => (f.path === 'xl/styles.xml' ? { path: f.path, content: buildStylesXml(f.content, styleState) } : f))
    : xlsxStrings;
  return buildXlsxZip([sheetXml], strings);
}

/**
 * Complete worksheet XML for one sheet of plain data.
 * @param {Array<Array<string|number|null|undefined|TableCellRich>>} rows - 2D array of cell values.
 * @param {Object} options - Same options as `writeXlsxFromRows`.
 * @param {number} sheetIndex - 0-based workbook position; only sheet 0 keeps the preamble's `tabSelected`.
 * @param {{sheetPreamble: string, sheetClose: string}} resources
 * @param {StyleInterner} styleState - Workbook-level style tables, shared across sheets so cellXf indices stay valid workbook-wide.
 */
function buildSheetXml(rows, options, sheetIndex, resources, styleState) {
  const {
    headerRows = 0, autoFilter = false, columnWidths, tableRanges = null,
  } = options;

  const isRich = (val) => val != null && typeof val === 'object' && Array.isArray(val.runs);
  const cellLen = (val) => (val == null ? 0 : (isRich(val) ? val.text.length : String(val).length));

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
          const len = cellLen(rows[i][j]);
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

  const internListEntry = (list, xml) => {
    let idx = list.indexOf(xml);
    if (idx === -1) {
      idx = list.length;
      list.push(xml);
    }
    return idx;
  };
  const internXf = (fontId, fillId, borderId, align) => {
    const key = `${fontId}|${fillId}|${borderId}|${align}`;
    let idx = styleState.xfKeys.get(key);
    if (idx === undefined) {
      idx = styleState.cellXfs.length;
      styleState.cellXfs.push(`<xf numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"${fontId > 0 ? ' applyFont="1"' : ''}${fillId > 1 ? ' applyFill="1"' : ''}${borderId > 0 ? ' applyBorder="1"' : ''}${align ? ` applyAlignment="1"><alignment horizontal="${align}"/></xf>` : '/>'}`);
      styleState.xfKeys.set(key, idx);
    }
    return idx;
  };
  const thinEdge = (side) => `<${side} style="thin"><color indexed="64"/></${side}>`;
  const gridBorder = `<border>${thinEdge('left')}${thinEdge('right')}${thinEdge('top')}${thinEdge('bottom')}<diagonal/></border>`;
  const gridHeaderBorder = `<border>${thinEdge('left')}${thinEdge('right')}${thinEdge('top')}<bottom style="medium"><color indexed="64"/></bottom><diagonal/></border>`;

  // Column counts are per range, not per sheet, so that grid borders never extend into a wider sibling table's columns on a shared flat sheet.
  /** @type {Map<XlsxTableRange, number>} */
  const rangeColCount = new Map();
  /** @type {Map<XlsxTableRange, Set<number>>} */
  const rangeRightCols = new Map();
  if (tableRanges) {
    for (const tr of tableRanges) {
      let cols = 0;
      for (let i = tr.start; i < tr.start + tr.rowCount && i < rows.length; i++) {
        if (rows[i].length > cols) cols = rows[i].length;
      }
      rangeColCount.set(tr, cols);
      if (!tr.alignNumeric) continue;
      const rightCols = new Set();
      for (let j = 0; j < cols; j++) {
        let numeric = 0;
        let filled = 0;
        for (let i = tr.start + tr.headerRows; i < tr.start + tr.rowCount && i < rows.length; i++) {
          const text = (rows[i][j] == null ? '' : (isRich(rows[i][j]) ? rows[i][j].text : String(rows[i][j]))).trim();
          if (!text) continue;
          filled++;
          if (/^[\d,$%.()+\-–—]+$/.test(text) && /\d/.test(text)) numeric++;
        }
        if (filled >= 2 && numeric / filled >= 0.7) rightCols.add(j);
      }
      rangeRightCols.set(tr, rightCols);
    }
  }

  let cellContent = '';
  for (let i = 0; i < rows.length; i++) {
    cellContent += `<row r="${String(i + 1)}">`;
    /** @type {?XlsxTableRange} */
    let range = null;
    if (tableRanges) {
      for (const tr of tableRanges) {
        if (i >= tr.start && i < tr.start + tr.rowCount) {
          range = tr;
          break;
        }
      }
    }
    const isHeader = range ? i - range.start < range.headerRows : i < headerRows;
    const zebraRow = !!(range && range.zebra && !isHeader && (i - range.start - range.headerRows) % 2 === 1);
    // Grid rows pad to the range's column count with style-only cells, or ragged rows would leave holes in the border rectangle.
    const rowCols = range && range.grid ? Math.max(rows[i].length, rangeColCount.get(range)) : rows[i].length;
    for (let j = 0; j < rowCols; j++) {
      const val = j < rows[i].length ? rows[i][j] : null;
      const cellRef = `${colIndexToRef(j)}${String(i + 1)}`;

      let styleAttr = '';
      if (range) {
        const fontId = isHeader && !isRich(val) ? 1 : 0;
        let borderId = 0;
        if (range.grid) borderId = internListEntry(styleState.borders, isHeader ? gridHeaderBorder : gridBorder);
        else if (isHeader) borderId = 1;
        let fillId = 0;
        if (zebraRow) {
          const argb = range.zebraColor && /^#[0-9a-fA-F]{6}$/.test(range.zebraColor) ? `FF${range.zebraColor.slice(1).toUpperCase()}` : 'FFF2F2F2';
          fillId = internListEntry(styleState.fills, `<fill><patternFill patternType="solid"><fgColor rgb="${argb}"/><bgColor indexed="64"/></patternFill></fill>`);
        }
        const align = !isHeader && rangeRightCols.get(range)?.has(j) ? 'right' : '';
        const xfId = fontId || borderId || fillId || align ? internXf(fontId, fillId, borderId, align) : 0;
        if (xfId > 0) styleAttr = ` s="${xfId}"`;
      } else if (isHeader) {
        styleAttr = ' s="1"';
      }

      if (j >= rows[i].length) {
        cellContent += `<c r="${cellRef}"${styleAttr}/>`;
      } else if (typeof val === 'number' && Number.isFinite(val)) {
        cellContent += `<c r="${cellRef}"${styleAttr}><v>${val}</v></c>`;
      } else if (isRich(val)) {
        let runsXml = '';
        for (const run of val.runs) {
          const st = run.style;
          let rPr = '';
          if (st.bold) rPr += '<b/>';
          if (st.italic) rPr += '<i/>';
          if (st.underline) rPr += '<u/>';
          if (st.sup) rPr += '<vertAlign val="superscript"/>';
          if (st.size) {
            const pt = Math.min(Math.max(Math.round((st.size * (72 / 300)) * 2) / 2, 6), 36);
            if (pt !== 11) rPr += `<sz val="${pt}"/>`;
          }
          if (st.color && /^#[0-9a-fA-F]{6}$/.test(st.color)
            && !(parseInt(st.color.slice(1, 3), 16) < 48 && parseInt(st.color.slice(3, 5), 16) < 48 && parseInt(st.color.slice(5, 7), 16) < 48)) {
            rPr += `<color rgb="FF${st.color.slice(1).toUpperCase()}"/>`;
          }
          if (st.font) {
            let office = styleState.officeFontCache.get(st.font);
            if (office === undefined) {
              // Map the PDF family to the closest widely-available Office font.
              // A null result leaves the run on Calibri, the workbook default.
              office = null;
              const css = standardFontToCSS(st.font);
              if (css) {
                if (/^(Arial|Helvetica)/.test(css)) office = 'Arial';
                else if (css.startsWith('"Times New Roman"') || css === 'serif') office = 'Times New Roman';
                else if (css.startsWith('"Courier New"')) office = 'Courier New';
              } else if (determineSansSerif(st.font) === 'SerifDefault') {
                office = 'Times New Roman';
              }
              styleState.officeFontCache.set(st.font, office);
            }
            if (office) rPr += `<rFont val="${office}"/>`;
          }
          runsXml += `<r>${rPr ? `<rPr>${rPr}</rPr>` : ''}<t xml:space="preserve">${ocr.escapeXml(run.text)}</t></r>`;
        }
        if (runsXml === '') runsXml = '<t xml:space="preserve"></t>';
        cellContent += `<c r="${cellRef}"${styleAttr} t="inlineStr"><is>${runsXml}</is></c>`;
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

  // Only one sheet may claim the selected tab, or Excel flags the workbook.
  const preamble = sheetIndex === 0 ? resources.sheetPreamble : resources.sheetPreamble.replace(' tabSelected="1"', '');
  return `${preamble}${colsXml}<sheetData>${cellContent}</sheetData>${autoFilterXml}${resources.sheetClose}`;
}

/**
 * One named worksheet of cell rows, with optional per-sheet styling overrides.
 * @typedef {{name: string, rows: Array<Array<string|number|null|undefined|TableCellRich>>, tableRanges?: Array<XlsxTableRange>, columnWidths?: 'auto'|Array<number>}} XlsxSheet
 */

/**
 * Create a multi-sheet xlsx workbook from plain data, one worksheet per entry.
 * A sheet's optional `tableRanges` and `columnWidths` override the workbook-level options for that sheet.
 * @param {Array<XlsxSheet>} sheets - Worksheets in workbook order.
 * @param {Object} [options] - Same options as `writeXlsxFromRows`, applied to every sheet.
 */
export async function writeXlsxFromSheets(sheets, options = {}) {
  const { xlsxStrings, sheetPreamble, sheetClose } = await import('./resources/xlsxFiles.js');

  // Sheet names arrive as raw text from the caller, so workbook validity is enforced here rather than at the call sites.
  /** @type {Array<string>} */
  const names = [];
  sheets.forEach((sheet, i) => {
    let name = String(sheet.name ?? '').replace(/[:\\/?*[\]]/g, '').trim().slice(0, 31);
    if (!name) name = `Sheet${i + 1}`;
    let unique = name;
    for (let suffix = 2; names.includes(unique); suffix++) {
      const tail = ` ${suffix}`;
      unique = name.slice(0, 31 - tail.length) + tail;
    }
    names.push(unique);
  });

  const n = names.length;
  const byPath = new Map(xlsxStrings.map((f) => [f.path, f.content]));
  const patch = (path, anchor, replacement) => {
    const current = byPath.get(path);
    // A one-sheet workbook replaces the boilerplate's single-sheet markup with an identical string, so testing whether the text changed would read that as a missing anchor.
    if (!current.includes(anchor)) throw new Error(`xlsx boilerplate anchor not found in ${path}`);
    byPath.set(path, current.replace(anchor, replacement));
  };
  const sheetsXml = names.map((name, i) => `<sheet name="${ocr.escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  patch('xl/workbook.xml', '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>', `<sheets>${sheetsXml}</sheets>`);
  const sheetOverrides = names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  patch('[Content_Types].xml', '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>', sheetOverrides);
  patch('docProps/app.xml', '<vt:variant><vt:i4>1</vt:i4></vt:variant>', `<vt:variant><vt:i4>${n}</vt:i4></vt:variant>`);
  patch('docProps/app.xml', '<vt:vector size="1" baseType="lpstr"><vt:lpstr>Sheet1</vt:lpstr></vt:vector>', `<vt:vector size="${n}" baseType="lpstr">${names.map((name) => `<vt:lpstr>${ocr.escapeXml(name)}</vt:lpstr>`).join('')}</vt:vector>`);
  // Adding sheets shifts the theme and styles rIds, leaving no stable anchor to patch, so this file is rebuilt.
  const relsSheets = names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('');
  byPath.set('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId${n + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>${relsSheets}</Relationships>`);

  const styleState = createStyleInterner();
  const sheetXmls = sheets.map((sheet, i) => buildSheetXml(sheet.rows, {
    ...options,
    tableRanges: sheet.tableRanges ?? null,
    columnWidths: sheet.columnWidths ?? options.columnWidths,
  }, i, { sheetPreamble, sheetClose }, styleState));
  if (stylesGrew(styleState)) byPath.set('xl/styles.xml', buildStylesXml(byPath.get('xl/styles.xml'), styleState));
  return buildXlsxZip(sheetXmls, xlsxStrings.map((f) => ({ path: f.path, content: byPath.get(f.path) })));
}
