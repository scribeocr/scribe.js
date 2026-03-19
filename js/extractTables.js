import ocr from './objects/ocrObjects.js';
import { calcBoxOverlap } from './utils/miscUtils.js';
import { LayoutDataColumn, LayoutDataTable, LayoutDataTablePage } from './objects/layoutObjects.js';

/**
 *
 * @param {OcrPage} pageObj
 * @param {import('./objects/layoutObjects.js').LayoutDataTablePage} layoutObj
 * @returns
 */
export function extractTableContent(pageObj, layoutObj) {
  /** @type {Object<string, ReturnType<extractSingleTableContent>>} */
  const tableWordObj = {};

  if (!layoutObj?.tables || Object.keys(layoutObj.tables).length === 0) return tableWordObj;

  for (const [key, value] of Object.entries(layoutObj.tables)) {
    tableWordObj[key] = extractSingleTableContent(pageObj, Object.values(value.boxes), value.rowBounds);
  }

  return tableWordObj;
}

// TODO: This currently creates junk rows with only punctuation, as those bounding boxes are so small they often do not overlap with other lines.
/**
 * Extracts words from a page that are within the bounding boxes of the table, organized into arrays of rows and columns.
 * The output is in the form of a 3D array, where the first dimension is the row, the second dimension is the column, and the third dimension is the word.
 * @param {OcrPage} pageObj
 * @param {Array<import('./objects/layoutObjects.js').LayoutBoxBase>} boxes
 * @param {?Array<number>} [rowBounds=null] - Bottom y-coordinate of each row. When provided, used for row assignment instead of spatial derivation.
 */
export function extractSingleTableContent(pageObj, boxes, rowBounds = null) {
  /** @type {Array<OcrWord>} */
  const wordArr = [];
  /** @type {Array<bbox>} */
  const boxArr = [];
  /** @type {Array<number>} */
  const wordPriorityArr = [];

  // Sort boxes by left bound.
  const boxesArr = Object.values(boxes).sort((a, b) => a.coords.left - b.coords.left);

  const tableBox = {
    left: boxesArr[0].coords.left,
    top: boxesArr[0].coords.top,
    right: boxesArr[boxesArr.length - 1].coords.right,
    bottom: boxesArr[boxesArr.length - 1].coords.bottom,
  };

  // Unlike when exporting to text, anything not in a rectangle is excluded by default
  // priorityArr.fill(boxesArr.length+1);

  for (let i = 0; i < pageObj.lines.length; i++) {
    const lineObj = ocr.cloneLine(pageObj.lines[i]);
    ocr.rotateLine(lineObj, pageObj.angle * -1, pageObj.dims);

    // Skip lines that are entirely outside the table
    if (lineObj.bbox.left > tableBox.right || lineObj.bbox.right < tableBox.left || lineObj.bbox.top > tableBox.bottom || lineObj.bbox.bottom < tableBox.top) continue;

    // First, check for overlap with line-level boxes.
    const lineBoxALeft = {
      left: lineObj.bbox.left, top: lineObj.bbox.top, right: lineObj.bbox.left + 1, bottom: lineObj.bbox.bottom,
    };

    let boxFoundLine = false;
    // It is possible for a single line to match the inclusion criteria for multiple boxes.
    // Only the first (leftmost) match is used.
    for (let j = 0; j < boxesArr.length; j++) {
      const obj = boxesArr[j];

      if (obj.inclusionLevel !== 'line') continue;

      const overlap = obj.inclusionRule === 'left' ? calcBoxOverlap(lineBoxALeft, obj.coords) : calcBoxOverlap(lineObj.bbox, obj.coords);
      if (overlap > 0.5) {
        for (let k = 0; k < lineObj.words.length; k++) {
          const wordObj = lineObj.words[k];
          wordArr.push(wordObj);
          boxArr.push(lineObj.bbox);
          wordPriorityArr.push(j);
        }
        boxFoundLine = true;
        break;
      }
    }

    if (boxFoundLine) continue;

    // Second, check for overlap on the word-level boxes.
    for (const wordObj of lineObj.words) {
      let boxFoundWord = false;
      for (let j = 0; j < boxesArr.length; j++) {
        const obj = boxesArr[j];

        if (obj.inclusionLevel !== 'word') continue;

        const wordBoxALeft = {
          left: wordObj.bbox.left, top: wordObj.bbox.top, right: wordObj.bbox.left + 1, bottom: wordObj.bbox.bottom,
        };

        const overlap = obj.inclusionRule === 'left' ? calcBoxOverlap(wordBoxALeft, obj.coords) : calcBoxOverlap(wordObj.bbox, obj.coords);

        if (overlap > 0.5) {
          wordArr.push(wordObj);
          boxArr.push(wordObj.bbox);
          wordPriorityArr.push(j);
          boxFoundWord = true;
          break;
        }
      }

      if (boxFoundWord) continue;

      // It is possible for a word that is 100% within the table to not be included in any columns if the user sets particular inclusion rules.
      // To prevent this, any word that is unassigned with the user-specified inclusion rules is assigned using the word-level+majority rule.
      for (let j = 0; j < boxesArr.length; j++) {
        const obj = boxesArr[j];

        const overlap = calcBoxOverlap(wordObj.bbox, obj.coords);

        if (overlap > 0.5) {
          wordArr.push(wordObj);
          boxArr.push(wordObj.bbox);
          wordPriorityArr.push(j);
          break;
        }
      }
    }
  }

  // Split lines into separate arrays for each column
  // let lastCol = -1;
  /** @type {Array<Array<{word: OcrWord, box: bbox}>>} */
  const colArr = [];
  for (let i = 0; i < boxesArr.length; i++) {
    colArr.push([]);
    for (let j = 0; j < wordPriorityArr.length; j++) {
      if (wordPriorityArr[j] === i) {
        colArr[colArr.length - 1].push({ word: wordArr[j], box: boxArr[j] });
      }
    }
  }

  // For each array, sort all words by lower bound.
  // The following steps assume that the words are ordered.
  colArr.forEach((x) => x.sort((a, b) => a.box.bottom - b.box.bottom));

  // Create rows
  /** @type {Array<Array<Array<OcrWord>>>} */
  const rowWordArr = [];

  /** @type {Array<number>} */
  const rowBottomArr = [];

  if (rowBounds) {
    const splitPoints = [];
    for (let r = 0; r < rowBounds.length; r++) {
      const next = r + 1 < rowBounds.length ? rowBounds[r + 1] : Infinity;
      splitPoints.push((rowBounds[r] + next) / 2);
    }

    for (let r = 0; r < rowBounds.length; r++) {
      /** @type {Array<Array<OcrWord>>} */
      const colWordArr = [];
      for (let i = 0; i < colArr.length; i++) {
        colWordArr[i] = [];
      }
      const rowTop = r === 0 ? -Infinity : splitPoints[r - 1];
      const rowBot = splitPoints[r];
      for (let i = 0; i < colArr.length; i++) {
        for (const entry of colArr[i]) {
          if (entry.box.bottom > rowTop && entry.box.bottom <= rowBot) {
            colWordArr[i].push(entry.word);
          }
        }
      }
      rowWordArr.push(colWordArr);
      rowBottomArr.push(rowBounds[r]);
    }
  } else {
    // Derive rows spatially.
    const indexArr = Array(colArr.length);
    indexArr.fill(0);
    const lengthArr = colArr.map((x) => x.length);

    // To split lines into cells, the highest line on the page (that has not already been assigned to a cell) is identified,
    // and establishes the vertical bounds of a new row.
    // Next, the first unassigned line in each column is checked for whether it belongs in the new row.
    // This is necessary as a "line" in HOCR does not necessarily correspond to a visual line--
    // multiple HOCR "lines" may have the same visual baseline so belong in the same cell.
    while (!indexArr.every((x, index) => x === lengthArr[index])) {
      // Identify highest unassigned word
      const compArrBox = indexArr.map((x, index) => colArr[index][x]);
      compArrBox.sort((a, b) => a.box.bottom - b.box.bottom);
      const rowBox = {
        left: 0, top: 0, right: 5000, bottom: compArrBox[0].box.bottom,
      };

      /** @type {Array<Array<OcrWord>>} */
      const colWordArr = [];
      for (let i = 0; i < colArr.length; i++) {
        colWordArr[i] = [];
      }
      let rowBottom;

      for (let i = 0; i < indexArr.length; i++) {
        for (let j = indexArr[i]; j < colArr[i].length; j++) {
          const overlap = calcBoxOverlap(colArr[i][j].box, rowBox);
          if (overlap > 0.5) {
            colWordArr[i].push(colArr[i][j].word);
            if (!rowBottom || colArr[i][j].box.bottom > rowBottom) rowBottom = colArr[i][j].box.bottom;
            indexArr[i]++;
          } else {
            break;
          }
        }
      }
      rowWordArr.push(colWordArr);
      rowBottomArr.push(rowBottom);
    }
  }

  return { rowWordArr, rowBottomArr };
}

/**
 * Convert pre-structured cell text into spatial layout data by matching
 * each cell's text against OCR words on the page.
 *
 * @param {Array<Array<string>>} rows - 2D array of cell text [row][column].
 * @param {OcrPage} ocrPage
 * @param {LayoutDataTable} table - The table to populate with boxes and rowBounds.
 */
function convertRowsToLayout(rows, ocrPage, table) {
  if (!rows || rows.length === 0 || !ocrPage) return;

  const numCols = Math.max(...rows.map((r) => r.length));

  const colLeft = Array(numCols).fill(Infinity);
  const colRight = Array(numCols).fill(-Infinity);
  const rowBottom = Array(rows.length).fill(-Infinity);
  let tableTop = Infinity;

  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      const cellText = rows[r][c];
      if (!cellText) continue;

      const matchedWords = ocr.getMatchingWords(cellText, ocrPage);
      for (const word of matchedWords) {
        if (word.bbox.left < colLeft[c]) colLeft[c] = word.bbox.left;
        if (word.bbox.right > colRight[c]) colRight[c] = word.bbox.right;
        if (word.bbox.bottom > rowBottom[r]) rowBottom[r] = word.bbox.bottom;
        if (word.bbox.top < tableTop) tableTop = word.bbox.top;
      }
    }
  }

  const tableBottom = Math.max(...rowBottom.filter((v) => v > -Infinity));
  if (tableTop === Infinity) tableTop = 0;

  // Fill gaps: expand column bounds so there's no empty space between columns.
  for (let c = 0; c < numCols - 1; c++) {
    if (colRight[c] < Infinity && colLeft[c + 1] < Infinity) {
      const mid = Math.round((colRight[c] + colLeft[c + 1]) / 2);
      colRight[c] = mid;
      colLeft[c + 1] = mid;
    }
  }

  for (let c = 0; c < numCols; c++) {
    if (colLeft[c] === Infinity) continue;
    table.boxes.push(new LayoutDataColumn({
      left: Math.round(colLeft[c]),
      top: Math.round(tableTop),
      right: Math.round(colRight[c]),
      bottom: Math.round(tableBottom),
    }, table));
  }

  table.rowBounds = rowBottom.map((v) => (v > -Infinity ? Math.round(v) : 0));
}

/**
 * Create table layout from cell text by matching against OCR words on the page.
 *
 * @param {number} pageNum - Page index (0-based).
 * @param {Array<{rows: Array<Array<string>>}>} tables
 * @param {OcrPage} ocrPage
 */
export function createTablesFromText(pageNum, tables, ocrPage) {
  const tablesPage = new LayoutDataTablePage(pageNum);
  for (const spec of tables) {
    const table = new LayoutDataTable(tablesPage);
    convertRowsToLayout(spec.rows, ocrPage, table);
    tablesPage.tables.push(table);
  }
  return tablesPage;
}

/**
 * Extract text content from tables on a page as rows of cell strings.
 *
 * @param {OcrPage} ocrPage
 * @param {import('./objects/layoutObjects.js').LayoutDataTablePage} layoutPage
 */
export function extractTextFromTables(ocrPage, layoutPage) {
  if (!layoutPage?.tables?.length) return [];
  if (!ocrPage) return [];

  return layoutPage.tables.map((table) => {
    const result = extractSingleTableContent(ocrPage, Object.values(table.boxes), table.rowBounds);
    const rows = result.rowWordArr.map((row) => row.map((col) => {
      if (!col || col.length === 0) return '';
      col.sort((a, b) => a.bbox.left - b.bbox.left);
      return col.map((w) => w.text).join(' ');
    }));
    return { id: table.id, rows };
  });
}
