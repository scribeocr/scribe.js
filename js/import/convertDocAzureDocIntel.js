import ocr from '../objects/ocrObjects.js';

import { LayoutDataColumn, LayoutDataTable, LayoutDataTablePage } from '../objects/layoutObjects.js';
import { pass3 } from './convertPageShared.js';

const debugMode = false;

/**
 * @param {Object} params
 * @param {string} params.ocrStr
 * @param {dims[]} params.pageDims - Page metrics to use for the pages
 */
export async function convertDocAzureDocIntel({ ocrStr, pageDims }) {
  let ocrData;
  try {
    ocrData = JSON.parse(ocrStr);
  } catch (error) {
    throw new Error('Failed to parse Azure Document Intelligence JSON data.');
  }

  if (!ocrData.analyzeResult || !ocrData.analyzeResult.pages || !ocrData.analyzeResult.pages[0]) {
    throw new Error('Invalid Azure Document Intelligence format: missing pages data.');
  }

  const analyzeResultPages = /** @type {AzureDocIntelPage[]} */ (ocrData.analyzeResult.pages);

  const resArr = [];

  for (let n = 0; n < analyzeResultPages.length; n++) {
    const pageData = analyzeResultPages[n];
    const pageDimsN = pageDims[n];

    if (!pageData.width || !pageData.height) {
      throw new Error('Failed to parse page dimensions.');
    }

    const pageObj = new ocr.OcrPage(n, pageDimsN);
    pageObj.textSource = 'azure_doc_intel';

    if (!pageData.words || pageData.words.length === 0) {
      const warn = { char: 'char_error' };
      resArr.push({
        pageObj, charMetricsObj: {}, dataTables: new LayoutDataTablePage(n), warn,
      });
    }

    if (pageData.unit !== 'pixel') {
      if (!pageDimsN || !pageDimsN.width || !pageDimsN.height) {
        throw new Error('Page dimensions must be provided for non-pixel units.');
      }

      const pageDimsMult = {
        width: pageDimsN.width / pageData.width,
        height: pageDimsN.height / pageData.height,
      };

      pageData.lines.forEach((line) => {
        line.polygon = line.polygon.map((val, idx) => (idx % 2 === 0 ? val * pageDimsMult.width : val * pageDimsMult.height));
      });

      pageData.words.forEach((word) => {
        word.polygon = word.polygon.map((val, idx) => (idx % 2 === 0 ? val * pageDimsMult.width : val * pageDimsMult.height));
      });
    }

    for (let i = 0; i < pageData.lines.length; i++) {
      const lineWordsInput = /** @type {AzureDocIntelWord[]} */ ([]);
      for (let j = 0; j < pageData.lines[i].spans.length; j++) {
        const span = pageData.lines[i].spans[j];
        for (let k = 0; k < pageData.words.length; k++) {
          const wordSpan = pageData.words[k].span;
          if (wordSpan.offset >= span.offset && (wordSpan.offset + wordSpan.length) <= (span.offset + span.length)) {
            lineWordsInput.push(pageData.words[k]);
          }
        }
      }

      if (lineWordsInput.length === 0) continue;

      const allX = lineWordsInput.flatMap((w) => w.polygon.filter((_, idx) => idx % 2 === 0));
      const allY = lineWordsInput.flatMap((w) => w.polygon.filter((_, idx) => idx % 2 === 1));

      const lineBbox = {
        left: Math.min(...allX),
        top: Math.min(...allY),
        right: Math.max(...allX),
        bottom: Math.max(...allY),
      };

      const baseline = [0, 0];

      const lineObj = new ocr.OcrLine(pageObj, lineBbox, baseline);
      if (debugMode) {
        lineObj.debug.raw = JSON.stringify(lineWordsInput);
      }

      for (let j = 0; j < lineWordsInput.length; j++) {
        const wordData = lineWordsInput[j];

        if (!wordData.content || wordData.content.trim() === '') continue;

        const wordX = wordData.polygon.filter((_, idx) => idx % 2 === 0);
        const wordY = wordData.polygon.filter((_, idx) => idx % 2 === 1);

        const wordBbox = {
          left: Math.min(...wordX),
          top: Math.min(...wordY),
          right: Math.max(...wordX),
          bottom: Math.max(...wordY),
        };

        const wordPoly = {
          tl: { x: wordData.polygon[0], y: wordData.polygon[1] },
          tr: { x: wordData.polygon[2], y: wordData.polygon[3] },
          br: { x: wordData.polygon[4], y: wordData.polygon[5] },
          bl: { x: wordData.polygon[6], y: wordData.polygon[7] },
        };

        const wordId = `word_${n + 1}_${pageObj.lines.length + 1}_${j + 1}`;
        const wordObj = new ocr.OcrWord(lineObj, wordId, wordData.content, wordBbox, wordPoly);

        wordObj.conf = Math.round((wordData.confidence || 0) * 100);

        if (debugMode) {
          wordObj.debug.raw = JSON.stringify(wordData);
        }

        lineObj.words.push(wordObj);
      }

      if (lineObj.words.length > 0) {
        const linePolyRaw = pageData.lines[i].polygon;
        const polyLine = {
          tl: { x: linePolyRaw[0], y: linePolyRaw[1] },
          tr: { x: linePolyRaw[2], y: linePolyRaw[3] },
          br: { x: linePolyRaw[4], y: linePolyRaw[5] },
          bl: { x: linePolyRaw[6], y: linePolyRaw[7] },
        };

        if (polyLine.br.x !== polyLine.bl.x) {
          lineObj.baseline[0] = (polyLine.br.y - polyLine.bl.y) / (polyLine.br.x - polyLine.bl.x);
        }

        // Azure word polygons are line-height rectangles (not tight to character bounds),
        // so we cannot use word polygon heights to distinguish ascender vs x-height words.
        // Instead, use heuristics based on the line polygon height.
        const lineHeight = ((polyLine.br.y - polyLine.tr.y) + (polyLine.bl.y - polyLine.tl.y)) / 2;

        lineObj.baseline[1] = lineHeight * -1 / 4 - (lineObj.bbox.bottom - polyLine.bl.y);

        const ascHeight = lineHeight * 3 / 5;
        if (ascHeight > 0) lineObj.ascHeight = ascHeight;

        pageObj.lines.push(lineObj);
      }
    }

    const pageAngle = pageData.angle || 0;
    pageObj.angle = pageAngle;

    // pass2(pageObj, 0);
    const langSet = pass3(pageObj);

    resArr.push({ pageObj, dataTables: null, langSet });
  }

  const tablesByPage = convertTableLayoutAzure(ocrData.analyzeResult.tables, pageDims, analyzeResultPages);
  for (let n = 0; n < resArr.length; n++) {
    resArr[n].dataTables = tablesByPage.get(n) || new LayoutDataTablePage(n);
  }

  return resArr;
}

/**
 * Convert Azure Document Intelligence table data into LayoutDataTable objects.
 *
 * @param {Array} [tables]
 * @param {dims[]} pageDims
 * @param {Array} pagesData
 */
function convertTableLayoutAzure(tables, pageDims, pagesData) {
  /** @type {Map<number, LayoutDataTablePage>} */
  const result = new Map();

  if (!tables || tables.length === 0) return result;

  for (const tableData of tables) {
    const pageNumber = tableData.boundingRegions?.[0]?.pageNumber;
    if (!pageNumber) continue;
    const pageIdx = pageNumber - 1; // Azure is 1-indexed

    if (!result.has(pageIdx)) {
      result.set(pageIdx, new LayoutDataTablePage(pageIdx));
    }
    const tablesPage = result.get(pageIdx);

    const table = new LayoutDataTable(tablesPage);
    const { rowCount } = tableData;

    const pageData = pagesData[pageIdx];
    const pageDimsN = pageDims[pageIdx];
    let multW = 1;
    let multH = 1;
    if (pageData && pageDimsN && pageData.unit !== 'pixel') {
      multW = pageDimsN.width / pageData.width;
      multH = pageDimsN.height / pageData.height;
    }

    const cellsByRow = new Map();
    for (const cell of tableData.cells) {
      const r = cell.rowIndex;
      if (!cellsByRow.has(r)) cellsByRow.set(r, []);
      cellsByRow.get(r).push(cell);
    }

    const firstRowCells = (cellsByRow.get(0) || []).sort((a, b) => a.columnIndex - b.columnIndex);

    let tableTop = Infinity;
    let tableBottom = -Infinity;
    for (const cell of tableData.cells) {
      const poly = cell.boundingRegions?.[0]?.polygon;
      if (!poly) continue;
      const yCoords = poly.filter((_, i) => i % 2 === 1).map((y) => y * multH);
      tableTop = Math.min(tableTop, ...yCoords);
      tableBottom = Math.max(tableBottom, ...yCoords);
    }

    for (const cell of firstRowCells) {
      const poly = cell.boundingRegions?.[0]?.polygon;
      if (!poly) continue;
      const left = poly[0] * multW; // x1 (top-left)
      const right = poly[2] * multW; // x2 (top-right)
      table.boxes.push(new LayoutDataColumn({
        left: Math.round(left),
        top: Math.round(tableTop),
        right: Math.round(right),
        bottom: Math.round(tableBottom),
      }, table));
    }

    table.rowBounds = [];
    for (let r = 0; r < rowCount; r++) {
      const rowCells = cellsByRow.get(r) || [];
      let maxBottom = 0;
      for (const cell of rowCells) {
        const poly = cell.boundingRegions?.[0]?.polygon;
        if (!poly) continue;
        const bottom = Math.max(poly[5], poly[7]) * multH; // y3 or y4
        if (bottom > maxBottom) maxBottom = bottom;
      }
      table.rowBounds.push(Math.round(maxBottom));
    }

    if (table.boxes.length > 0) {
      tablesPage.tables.push(table);
    }
  }

  return result;
}
