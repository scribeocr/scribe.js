import { calcBoxOverlap } from "../modifyOCR.js";
import { LayoutDataColumn, LayoutDataTable } from "../objects/layoutObjects.js";
import ocr from "../objects/ocrObjects.js";
import { calcBboxUnion, mean50 } from "./miscUtils.js";

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

  /**@type {Array<{avgTop: number, items: Array<OcrLine>}>} */
  const rows = [];
  // TODO: Make this dynamic so it adjusts based on font size.
  const rowThreshold = 10; // Threshold for vertical alignment

  // Group lines into rows based on vertical proximity
  lines.forEach(item => {
    let addedToRow = false;

    for (let row of rows) {
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
  rows.forEach(row => {
    row.items.sort((a, b) => a.bbox.left - b.bbox.left);
  });

  /**
   * 
   * @param {{avgTop: number, items: Array<OcrLine>}} row 
   */
  const isTableRow = (row) => {
    if (row.items.length < 4) return false;
    let fewWordsN = 0;
    let majorityNumbersN = 0;
    row.items.forEach((line) => {
      const totalN = line.words.map((word) => word.text.length).reduce((a, b) => a + b, 0);
      const digitN = line.words.map((word) => word.text.split('').filter((char) => /[0-9\W]/.test(char)).length).reduce((a, b) => a + b, 0);

      if (line.words.length <= 2) fewWordsN++;
      // if (digitN / totalN > 0.5) majorityNumbersN++;
      if (digitN > 0) majorityNumbersN++;
    });

    if (fewWordsN < row.items.length  * 0.75) return false;
    if (majorityNumbersN < row.items.length * 0.75) return false;
    return true;
  }

  /**
   * 
   * @param {Array<{avgTop: number, items: Array<OcrLine>}>} tableRows
   * @param {{avgTop: number, items: Array<OcrLine>}} row 
   */
  const isCompat = (tableRows, row) => {
    if (!tableRows || tableRows.length === 0) return false;

    const expectedColumns = mean50(tableRows.map((x) => x.items.length));

    // const lastRow = tableRows[tableRows.length - 1];
    if (Math.abs(expectedColumns - row.items.length) <= 1) {
      return true;
    }
    return false;
  }

  const minRows = 4; // Minimum number of rows to consider a table

  /**@type {Array<Array<{avgTop: number, items: Array<OcrLine>}>>} */
  const tables = [];
  /**@type {Array<{avgTop: number, items: Array<OcrLine>}>} */
  let currentTable = [];
  /**@type {Array<{avgTop: number, items: Array<OcrLine>}>} */
  let currentTableCompat = [];
  /**@type {?{avgTop: number, items: Array<OcrLine>}} */
  let headerRow = null;

  // Detect tables by finding consecutive rows with similar numbers of items
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    if (isTableRow(row)) {

      if (currentTable.length > 0) {

        // const prevRow = currentTable[currentTable.length - 1];
        if (isCompat(currentTableCompat, row)) {
          // Continue the current table
          currentTable.push(row);
          currentTableCompat.push(row);
        } else {
          // TODO: Handle case where the the header row is a table row but is not compatible
          // with the rows that come afterwards, which puts us in this block.
          // End the current table and start a new one
          if (currentTable.length >= minRows) {
            if (headerRow && Math.abs(headerRow.items.length - currentTable[0].items.length) <= 1) {
              tables.push([headerRow, ...currentTable]);
            } else {
              tables.push(currentTable);
            }
            
          } else if (currentTable.length === 1) {
            headerRow = currentTable[0];
            currentTable = [row];
            
  
          } else {
            currentTable = [row];
            headerRow = null;
  
          }
        }
      } else {
        currentTable.push(row);
        currentTableCompat.push(row);
      }


    } else {

      // If the current row does not pass the checks, but the next two rows do, it is still included.
      const nextRow = rows[i + 1];
      const nextRow2 = rows[i + 2];
      if (nextRow && nextRow2 && isTableRow(nextRow) && isTableRow(nextRow2) 
        && isCompat(currentTableCompat, nextRow) && isCompat(currentTableCompat, nextRow2)) {
        currentTable.push(row);
        continue;
      }


      // Not a table row
      if (currentTable.length >= minRows) {
        if (headerRow && Math.abs(headerRow.items.length - currentTable[0].items.length) <= 1) {
          tables.push([headerRow, ...currentTable]);
        } else {
          tables.push(currentTable);
        }
        
      }
      currentTable = [];
      headerRow = row;
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
}

