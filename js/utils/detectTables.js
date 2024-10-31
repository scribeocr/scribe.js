import { LayoutDataColumn, LayoutDataTable } from '../objects/layoutObjects.js';
import ocr from '../objects/ocrObjects.js';
import {
  calcBboxUnion, calcBoxOverlap, calcHorizontalOverlap, mean50,
} from './miscUtils.js';
import { splitLineAgressively } from './ocrUtils.js';

/**
 *
 * @param {Array<bbox>} boundingBoxes
 */
export function calcColumnBounds(boundingBoxes) {
  const tolerance = 5; // Adjust as needed

  /** @type {Array<{left: number, right: number}>} */
  const columnBounds = [];

  // Sort bounding boxes by their left edge
  boundingBoxes.sort((a, b) => a.left - b.left);

  boundingBoxes.forEach((box) => {
    let addedToColumn = false;

    for (const column of columnBounds) {
      // Check if the bounding box overlaps horizontally with the column
      if (
        box.left <= column.right + tolerance
              && box.right >= column.left - tolerance
      ) {
        // Update column bounds
        column.left = Math.min(column.left, box.left);
        column.right = Math.max(column.right, box.right);
        addedToColumn = true;
        break;
      }
    }

    // If not added to any existing column, create a new column
    if (!addedToColumn) {
      columnBounds.push({
        left: box.left,
        right: box.right,
      });
    }
  });

  // Expand column bounds so there is no empty space between columns.
  for (let i = 0; i < columnBounds.length - 1; i++) {
    const boundRight = (columnBounds[i].right + columnBounds[i + 1].left) / 2;
    columnBounds[i].right = boundRight;
    columnBounds[i + 1].left = boundRight;
  }

  return columnBounds;
}

/**
 * Detects tables in an OcrPage and returns a structured object.
 * Each table contains columns, and each column contains rows (lines).
 * @param {OcrPage} ocrPage - OcrPage object containing OcrLine objects.
 */
export function detectTablesInPage(ocrPage) {
  const lines = ocr.clonePage(ocrPage).lines;

  // Sort lines by the top position of their bounding boxes
  lines.sort((a, b) => a.bbox.top - b.bbox.top);

  /** @type {Array<{avgTop: number, items: Array<OcrLine>}>} */
  const rows = [];
  // TODO: Make this dynamic so it adjusts based on font size.
  const rowThreshold = 10; // Threshold for vertical alignment

  // Group lines into rows based on vertical proximity
  lines.forEach((item) => {
    let addedToRow = false;

    for (const row of rows) {
      // Check if the line is vertically aligned with the row
      if (Math.abs(item.bbox.top - row.avgTop) <= rowThreshold) {
        row.items.push(item);
        // Update the average top position of the row
        row.avgTop = row.items.reduce((sum, itm) => sum + itm.bbox.top, 0) / row.items.length;
        addedToRow = true;
        break;
      }
    }

    if (!addedToRow) {
      // Create a new row if the line doesn't fit in existing rows
      rows.push({ avgTop: item.bbox.top, items: [item] });
    }
  });

  // Sort the lines within each row by their left position
  rows.forEach((row) => {
    row.items.sort((a, b) => a.bbox.left - b.bbox.left);
  });

  /**
   *
   * @param {{avgTop: number, items: Array<OcrLine>}} row
   */
  const containsNumbers = (row) => {
    let wordsNumN = 0;
    row.items.forEach((line) => {
      line.words.forEach((word) => {
        if (/[0-9]/.test(word.text)) wordsNumN++;
      });
    });

    if (wordsNumN < 4) return false;
    return true;
  };

  /**
   *
   * @param {{avgTop: number, items: Array<OcrLine>}} row
   */
  const splitRowLinesAgressively = (row) => {
    const row2 = { avgTop: row.avgTop, items: /** @type {Array<OcrLine>} */ ([]) };
    row.items.forEach((line) => {
      row2.items.push(...splitLineAgressively(line));
    });
    return row2;
  };

  /**
   *
   * @param {Array<OcrLine>} linesA
   * @param {Array<OcrLine>} linesB
   */
  const hasWordOverlap = (linesA, linesB) => {
    for (let i = 0; i < linesA.length; i++) {
      const lineI = linesA[i];
      const lineJOverlapArr = [];
      for (let j = 0; j < linesB.length; j++) {
        const lineJ = linesB[j];
        if (lineI.bbox.right < lineJ.bbox.left) break;
        if (calcHorizontalOverlap(lineI.bbox, lineJ.bbox) > 0) {
          lineJOverlapArr.push(lineJ);
        }
      }
      if (lineJOverlapArr.length > 1) {
        const wordsI = lineI.words;
        const wordsJ = lineJOverlapArr.map((line) => line.words).flat();

        for (const wordI of wordsI) {
          let overlapCount = 0;

          for (const wordJ of wordsJ) {
            if (calcHorizontalOverlap(wordI.bbox, wordJ.bbox) > 0) {
              overlapCount++;
              if (overlapCount >= 2) {
                return true;
              }
            }
          }
        }
      }
    }
    return false;
  };

  /**
   *
   * @param {Array<{avgTop: number, items: Array<OcrLine>}>} tableRows
   * @param {{avgTop: number, items: Array<OcrLine>}} row
   */
  const isCompat = (tableRows, row) => {
    if (!tableRows || tableRows.length === 0) return false;

    const expectedColumns = mean50(tableRows.map((x) => x.items.length));

    // const lastRow = tableRows[tableRows.length - 1];

    const existingLines = tableRows.map((x) => x.items).flat();

    if (Math.abs(expectedColumns - row.items.length) <= 1) {
      return true;
    }

    if (globalThis.testControl) return false;

    if (hasWordOverlap(existingLines, row.items) || hasWordOverlap(row.items, existingLines)) {
      return false;
    }

    return true;
  };

  const minRows = 4; // Minimum number of rows to consider a table

  /** @type {Array<Array<{avgTop: number, items: Array<OcrLine>}>>} */
  const tables = [];
  /** @type {Array<{avgTop: number, items: Array<OcrLine>}>} */
  let currentTable = [];
  /** @type {Array<{avgTop: number, items: Array<OcrLine>}>} */
  let currentTableCompat = [];
  let currentTableStartIndex = 0;

  const rowsSplit = rows.map((row) => splitRowLinesAgressively(row));

  // Detect tables by finding consecutive rows with similar numbers of items
  for (let i = 0; i < rowsSplit.length; i++) {
    const rowSplit = rowsSplit[i];
    // const rowSplit = rows[i];
    // let rowSplit = rowsSplit[i];
    // let rowSplit;

    if (containsNumbers(rowsSplit[i])) {
      // rowSplit = splitLinesAgressively(row);
      if (currentTable.length > 0) {
        if (isCompat(currentTableCompat, rowSplit)) {
          // Continue the current table
          currentTable.push(rowSplit);
          currentTableCompat.push(rowSplit);
        } else if (currentTable.length >= minRows) {
          // TODO: Handle case where the the header row is a table row but is not compatible
          // with the rows that come afterwards, which puts us in this block.
          // End the current table and start a new one
          const headerRows = [];
          if (rowsSplit[currentTableStartIndex - 1] && (tables.length === 0 || !tables[tables.length - 1].includes(rowsSplit[currentTableStartIndex - 1]))
            && isCompat(currentTableCompat, rowsSplit[currentTableStartIndex - 1])) {
            headerRows.push(rowsSplit[currentTableStartIndex - 1]);
            if (rowsSplit[currentTableStartIndex - 2] && (tables.length === 0 || !tables[tables.length - 1].includes(rowsSplit[currentTableStartIndex - 2]))
              && isCompat(currentTableCompat, rowsSplit[currentTableStartIndex - 2])) {
              headerRows.push(rowsSplit[currentTableStartIndex - 2]);
            }
          }
          tables.push([...headerRows, ...currentTable]);

          currentTable = [rowSplit];
          currentTableCompat = [rowSplit];
          currentTableStartIndex = i;
        } else {
          currentTable = [rowSplit];
          currentTableCompat = [rowSplit];
          currentTableStartIndex = i;
        }
      } else {
        currentTable.push(rowSplit);
        currentTableCompat.push(rowSplit);
        currentTableStartIndex = i;
      }
    } else if (currentTable.length > 0) {
      // If the current row does not pass the checks, but the next two rows do, it is still included.
      const nextRowSplit = rowsSplit[i + 1];
      const nextRowSplit2 = rowsSplit[i + 2];
      if (nextRowSplit && nextRowSplit2 && containsNumbers(nextRowSplit) && containsNumbers(nextRowSplit2)
        && isCompat(currentTableCompat, nextRowSplit) && isCompat(currentTableCompat, nextRowSplit2)) {
        currentTable.push(rowSplit);
        continue;
      }

      if (currentTable.length >= minRows) {
        const headerRows = [];
        if (rowsSplit[currentTableStartIndex - 1] && (tables.length === 0 || !tables[tables.length - 1].includes(rowsSplit[currentTableStartIndex - 1]))
          && isCompat(currentTableCompat, rowsSplit[currentTableStartIndex - 1])) {
          headerRows.push(rowsSplit[currentTableStartIndex - 1]);
          if (rowsSplit[currentTableStartIndex - 2] && (tables.length === 0 || !tables[tables.length - 1].includes(rowsSplit[currentTableStartIndex - 2]))
            && isCompat(currentTableCompat, rowsSplit[currentTableStartIndex - 2])) {
            headerRows.push(rowsSplit[currentTableStartIndex - 2]);
          }
        }
        tables.push([...headerRows, ...currentTable]);
      }

      currentTable = [];
      currentTableCompat = [];
    }
  }

  // Add the last table if it exists
  if (currentTable.length >= minRows) {
    tables.push(currentTable);
  }

  const tableLineBboxes = tables.map((table) => calcBboxUnion(table.map((row) => calcBboxUnion(row.items.map((item) => item.bbox)))));

  return tableLineBboxes;
}

/**
 *
 * @param {OcrPage} page
 * @param {bbox} bbox
 */
export const makeTableFromBbox = (page, bbox) => {
  const lines = page.lines.filter((line) => calcBoxOverlap(line.bbox, bbox) > 0.5);

  let columnBboxArr;
  if (lines.length > 0) {
    const lineBoxes = lines.map((line) => line.bbox);
    const columnBoundArr = calcColumnBounds(lineBoxes);
    columnBboxArr = columnBoundArr.map((column) => ({
      left: column.left,
      top: bbox.top,
      right: column.right,
      bottom: bbox.bottom,
    }));

    // Expand column bounds so there is no empty space between columns.
    columnBboxArr[0].left = bbox.left;
    columnBboxArr[columnBboxArr.length - 1].right = bbox.right;
    for (let i = 0; i < columnBboxArr.length - 1; i++) {
      const boundRight = (columnBboxArr[i].right + columnBboxArr[i + 1].left) / 2;
      columnBboxArr[i].right = boundRight;
      columnBboxArr[i + 1].left = boundRight;
    }
  } else {
    columnBboxArr = [{ ...bbox }];
  }

  const dataTable = new LayoutDataTable();

  columnBboxArr.forEach((columnBbox) => {
    const layoutBox = new LayoutDataColumn(columnBbox, dataTable);
    dataTable.boxes.push(layoutBox);
  });

  return dataTable;
};
