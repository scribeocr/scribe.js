/* eslint-disable import/no-cycle */
import scribe from '../../scribe.js';
import {
  ScribeViewer,
} from '../viewer.js';
import {
  UiLayout, UiControlLine, makeDraggable, getLayoutViewer, hexToRgba, setAlpha, colColorsHex,
} from './viewerLayoutBox.js';

export class UiDataTableControl extends UiControlLine {
  /**
   *
   * @param {UiDataTable} uiTable
   */
  constructor(uiTable, top = true) {
    const tc = uiTable.coords;
    const n = uiTable.layoutDataTable.page.n;
    super(uiTable.viewer, n, 'h', tc.left, top ? tc.top : tc.bottom, tc.right - tc.left);

    this.uiTable = uiTable;
    this.boundTop = 0;
    this.boundBottom = 10000;

    makeDraggable(this.el, this.viewer, n, {
      onStart: () => {
        this.viewer.drag.isResizingColumns = true;
        if (top) {
          this.boundTop = 0;
          this.boundBottom = this.uiTable.bottomControl.y() - 20;
        } else {
          this.boundTop = this.uiTable.topControl.y() + 20;
          this.boundBottom = this.viewer.doc.pageMetrics[n].dims.height;
        }
      },
      onMove: (p) => {
        const newY = Math.max(this.boundTop, Math.min(this.boundBottom, p.y));
        this.y(newY);
        if (top) {
          uiTable.coords.top = newY;
          uiTable.columns.forEach((column) => {
            column.layoutBox.coords.top = newY;
            column.y(newY);
            column.height(column.layoutBox.coords.bottom - newY);
          });
          uiTable.colLines.forEach((colLine) => {
            colLine.y(newY);
            colLine.points([0, 0, 0, uiTable.coords.bottom - uiTable.coords.top]);
          });
        } else {
          uiTable.coords.bottom = newY;
          uiTable.columns.forEach((column) => {
            column.layoutBox.coords.bottom = newY;
            column.height(newY - column.layoutBox.coords.top);
          });
          uiTable.colLines.forEach((colLine) => {
            colLine.points([0, 0, 0, uiTable.coords.bottom - uiTable.coords.top]);
          });
        }
      },
      onEnd: () => {
        this.viewer.drag.isResizingColumns = false;
        renderLayoutDataTable(this.viewer, this.uiTable.layoutDataTable);
      },
    });
  }
}

export class UiDataColSep extends UiControlLine {
  /**
   *
   * @param {UiDataColumn} columnLeft
   * @param {UiDataColumn} columnRight
   * @param {UiDataTable} uiTable
   */
  constructor(columnLeft, columnRight, uiTable) {
    const x = columnRight ? columnRight.layoutBox.coords.left : columnLeft.layoutBox.coords.right;
    const y = columnRight ? columnRight.layoutBox.coords.top : columnLeft.layoutBox.coords.top;
    const n = uiTable.layoutDataTable.page.n;
    super(uiTable.viewer, n, 'v', x, y, uiTable.coords.bottom - uiTable.coords.top);

    this.next = () => this.uiTable.colLines.find((obj) => obj.x() > this.x());
    this.prev = () => this.uiTable.colLines.slice().reverse().find((obj) => obj.x() < this.x());

    this.boundLeft = 0;
    this.boundRight = 10000;

    this.uiTable = uiTable;
    this.columnLeft = columnLeft;
    this.columnRight = columnRight;

    makeDraggable(this.el, this.viewer, n, {
      onStart: () => {
        this.viewer.drag.isResizingColumns = true;
        // Bounds are the neighbouring separators (or the page edges), in page space.
        const boundLeftRaw = this.prev()?.x() ?? 0;
        const boundRightRaw = this.next()?.x() ?? this.viewer.doc.pageMetrics[n].dims.width;
        // Add minimum width between columns to prevent lines from overlapping.
        const minColWidthAbs = Math.min((boundRightRaw - boundLeftRaw) / 3, 10);
        this.boundLeft = boundLeftRaw + minColWidthAbs;
        this.boundRight = boundRightRaw - minColWidthAbs;
      },
      onMove: (p) => {
        const newX = Math.max(this.boundLeft, Math.min(this.boundRight, p.x));
        this.x(newX);
        if (this.columnLeft) {
          this.columnLeft.layoutBox.coords.right = newX;
          this.columnLeft.width(this.columnLeft.layoutBox.coords.right - this.columnLeft.layoutBox.coords.left);
        } else {
          this.uiTable.topControl.x(newX);
          this.uiTable.bottomControl.x(newX);
          this.uiTable.topControl.points([0, 0, uiTable.coords.right - newX, 0]);
          this.uiTable.bottomControl.points([0, 0, uiTable.coords.right - newX, 0]);
        }

        if (this.columnRight) {
          this.columnRight.layoutBox.coords.left = newX;
          this.columnRight.x(this.columnRight.layoutBox.coords.left);
          this.columnRight.width(this.columnRight.layoutBox.coords.right - this.columnRight.layoutBox.coords.left);
        } else {
          this.uiTable.topControl.points([0, 0, newX - uiTable.coords.left, 0]);
          this.uiTable.bottomControl.points([0, 0, newX - uiTable.coords.left, 0]);
        }
      },
      onEnd: () => {
        this.viewer.drag.isResizingColumns = false;
        if (!this.columnLeft || !this.columnRight) {
          renderLayoutDataTable(this.viewer, this.uiTable.layoutDataTable);
        } else {
          if (this.uiTable.pageObj) {
            this.uiTable.tableContent = scribe.utils.extractSingleTableContent(this.uiTable.pageObj, this.uiTable.layoutBoxesArr);
          }
          // eslint-disable-next-line no-use-before-define
          UiDataTable.colorTableWords(this.uiTable);
        }
      },
    });
  }
}

/**
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 */
export function renderLayoutDataTables(viewer, n) {
  if (!viewer.doc.layoutDataTables.pages[n].tables) return;
  Object.values(viewer.doc.layoutDataTables.pages[n].tables).forEach((table) => {
    renderLayoutDataTable(viewer, table);
  });
}

export class UiDataTable {
  /**
   * @param {OcrPage|undefined} pageObj - The page object that the table is on.
   *    This can be undefined in the fringe case where the user makes layout boxes without any OCR data.
   * @param {InstanceType<typeof scribe.layout.LayoutDataTable>} layoutDataTable
   * @param {boolean} [lockColumns=true]
   * @param {import('../viewer.js').ScribeViewer} [viewer]
   */
  // eslint-disable-next-line default-param-last
  constructor(pageObj, layoutDataTable, lockColumns = true, viewer) {
    /** @type {import('../viewer.js').ScribeViewer} */
    this.viewer = viewer || ScribeViewer.getDefault();
    // The `columns` array is expected to be sorted left to right in other code.
    this.layoutBoxesArr = Object.values(layoutDataTable.boxes).sort((a, b) => a.coords.left - b.coords.left);

    const tableLeft = Math.min(...this.layoutBoxesArr.map((x) => x.coords.left));
    const tableRight = Math.max(...this.layoutBoxesArr.map((x) => x.coords.right));
    const tableTop = Math.min(...this.layoutBoxesArr.map((x) => x.coords.top));
    const tableBottom = Math.max(...this.layoutBoxesArr.map((x) => x.coords.bottom));

    this.coords = {
      left: tableLeft, top: tableTop, right: tableRight, bottom: tableBottom,
    };

    this.pageObj = pageObj;

    this.layoutDataTable = layoutDataTable;
    this.lockColumns = lockColumns;

    // eslint-disable-next-line no-use-before-define
    this.columns = this.layoutBoxesArr.map((layoutBox) => new UiDataColumn(layoutBox, this, this.viewer));

    /**
     * Removes the table from the canvas.
     * Does not impact the underlying data.
     */
    this.destroy = () => {
      this.columns.forEach((column) => column.destroy());
      this.colLines.forEach((colLine) => colLine.destroy());
      this.rowLines.forEach((rowLine) => rowLine.remove());
      this.rowSpans.forEach((rowSpan) => rowSpan.remove());

      this.topControl.destroy();
      this.bottomControl.destroy();

      // Restore colors of words that were colored by this table.
      const wordIdArr = this.tableContent?.rowWordArr.flat().flat().map((x) => x.id) || [];
      const canvasDeselectWords = this.viewer.getUiWords().filter((x) => wordIdArr.includes(x.word.id));
      canvasDeselectWords.forEach((x) => {
        const { fill, opacity } = scribe.utils.ocr.getWordFillOpacity(x.word, this.viewer.state.displayMode,
          scribe.ScribeDoc.defaults.confThreshMed, scribe.ScribeDoc.defaults.confThreshHigh, scribe.ScribeDoc.defaults.overlayOpacity);

        x.fill(fill);
        x.opacity(opacity);
      });

      return this;
    };

    /**
     * Delete the table, both from the layout data and from the canvas.
     */
    this.delete = () => {
      const tableIndex = this.viewer.doc.layoutDataTables.pages[this.layoutDataTable.page.n].tables.findIndex((x) => x.id === this.layoutDataTable.id);
      this.viewer.doc.layoutDataTables.pages[this.layoutDataTable.page.n].tables.splice(tableIndex, 1);
      this.destroy();
      this.viewer.doc.layoutRegions.pages[this.layoutDataTable.page.n].default = false;
      this.viewer.doc.layoutDataTables.pages[this.layoutDataTable.page.n].default = false;
    };

    const group = this.viewer.getOverlayGroup(layoutDataTable.page.n);

    /** @type {Array<UiDataColSep>} */
    this.colLines = [];
    for (let i = 0; i <= this.columns.length; i++) {
      const colLine = new UiDataColSep(this.columns[i - 1], this.columns[i], this);
      this.colLines.push(colLine);
      group.appendChild(colLine.el);
    }

    this.topControl = new UiDataTableControl(this, true);
    this.bottomControl = new UiDataTableControl(this, false);

    group.appendChild(this.topControl.el);
    group.appendChild(this.bottomControl.el);

    /** @type {Array<HTMLDivElement>} */
    this.rowLines = [];

    /** @type {Array<HTMLDivElement>} */
    this.rowSpans = [];

    /** @type {?ReturnType<typeof scribe.utils.extractSingleTableContent>} */
    this.tableContent = null;

    if (pageObj) {
      this.tableContent = scribe.utils.extractSingleTableContent(pageObj, this.layoutBoxesArr);

      this.rowLines = this.tableContent.rowBottomArr.map((rowBottom) => {
        const line = document.createElement('div');
        Object.assign(line.style, {
          position: 'absolute',
          left: `${tableLeft}px`,
          top: `${rowBottom}px`,
          width: `${tableRight - tableLeft}px`,
          height: '0',
          borderTop: 'calc(2px / var(--scribe-zoom, 1)) solid rgba(0,0,0,0.25)',
          pointerEvents: 'none',
        });
        return line;
      });

      UiDataTable.colorTableWords(this);

      this.rowLines.forEach((rowLine) => {
        group.appendChild(rowLine);
      });
    }
  }

  /**
   * Calculate what words are in each column and color them accordingly.
   * @param {UiDataTable} uiDataTable
   */
  static colorTableWords(uiDataTable) {
    if (!uiDataTable.tableContent) return;
    const viewer = uiDataTable.viewer;

    const group = viewer.getOverlayGroup(uiDataTable.layoutDataTable.page.n);

    uiDataTable.rowSpans.forEach((rowSpan) => rowSpan.remove());

    /** @type {Array<Array<string>>} */
    const colWordIdArr = [];
    for (let i = 0; i < uiDataTable.columns.length; i++) {
      colWordIdArr.push([]);
    }

    for (let i = 0; i < uiDataTable.tableContent.rowWordArr.length; i++) {
      const row = uiDataTable.tableContent.rowWordArr[i];
      for (let j = 0; j < row.length; j++) {
        const wordArr = row[j];
        if (wordArr.length === 0) continue;
        colWordIdArr[j].push(...wordArr.map((word) => (word.id)));
        const wordBoxArr = wordArr.map((word) => word.bbox);
        const spanBox = scribe.utils.ocr.calcBboxUnion(wordBoxArr);
        const colorBase = colColorsHex[j % colColorsHex.length];
        const fillCol = hexToRgba(colorBase, 0.3);

        const rowSpan = document.createElement('div');
        Object.assign(rowSpan.style, {
          position: 'absolute',
          left: `${spanBox.left}px`,
          top: `${spanBox.top}px`,
          width: `${spanBox.right - spanBox.left}px`,
          height: `${spanBox.bottom - spanBox.top}px`,
          background: fillCol,
          border: `1px solid ${fillCol}`,
          boxSizing: 'border-box',
          pointerEvents: 'none',
        });
        uiDataTable.rowSpans.push(rowSpan);
        group.appendChild(rowSpan);
      }
    }

    const canvasWords = viewer.getUiWords();
    for (let i = 0; i < colWordIdArr.length; i++) {
      const colWordIndex = colWordIdArr[i];
      const colorBase = colColorsHex[i % colColorsHex.length];
      const fillCol = setAlpha(colorBase, 1);
      canvasWords.filter((x) => colWordIndex.includes(x.word.id)).forEach((x) => {
        x.fill(fillCol);
        x.opacity(1);
      });
    }
  }
}

/**
 * Render a layout data table on the canvas.
 * If the data table already exists on the canvas, it is automatically removed.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {InstanceType<typeof scribe.layout.LayoutDataTable>} layoutDataTable
 */
export function renderLayoutDataTable(viewer, layoutDataTable) {
  if (!layoutDataTable || Object.keys(layoutDataTable.boxes).length === 0) {
    console.log(`Skipping table ${layoutDataTable?.id} as it has no boxes`);
    return;
  }

  const uiLayoutExisting = viewer.getUiDataTables().find((x) => x.layoutDataTable.id === layoutDataTable.id);

  const wordIdOldArr = uiLayoutExisting?.tableContent?.rowWordArr.flat().flat().map((x) => x.id);

  if (uiLayoutExisting) uiLayoutExisting.destroy();

  const uiLayout = new UiDataTable(viewer.doc.ocr.active[layoutDataTable.page.n], layoutDataTable, true, viewer);

  if (wordIdOldArr) {
    const wordIdNewArr = uiLayout.tableContent?.rowWordArr.flat().flat().map((x) => x.id) || [];
    const wordIdDeselectArr = wordIdOldArr.filter((x) => !wordIdNewArr.includes(x));
    const canvasDeselectWords = viewer.getUiWords().filter((x) => wordIdDeselectArr.includes(x.word.id));
    canvasDeselectWords.forEach((x) => {
      const { fill, opacity } = scribe.utils.ocr.getWordFillOpacity(x.word, viewer.state.displayMode,
        scribe.ScribeDoc.defaults.confThreshMed, scribe.ScribeDoc.defaults.confThreshHigh, scribe.ScribeDoc.defaults.overlayOpacity);

      x.fill(fill);
      x.opacity(opacity);
    });
  }

  uiLayout.columns.forEach((column) => {
    const group = viewer.getOverlayGroup(column.uiTable.layoutDataTable.page.n);
    group.appendChild(column.el);
  });
  uiLayout.colLines.forEach((colLine) => colLine.moveToTop());
  uiLayout.topControl.moveToTop();
  uiLayout.bottomControl.moveToTop();
}

export class UiDataColumn extends UiLayout {
  /**
   * @param {LayoutDataColumn} layoutBox
   * @param {UiDataTable} uiTable
   * @param {import('../viewer.js').ScribeViewer} [viewer]
   */
  constructor(layoutBox, uiTable, viewer) {
    super(layoutBox, viewer || uiTable?.viewer);
    // Overwrite layoutBox so type inference works correctly, and `layoutBox` gets type `LayoutDataColumn` instead of `LayoutBox`.
    this.layoutBox = layoutBox;
    this.uiTable = uiTable;
    this.draggable(false);
    this.select = () => {
      this.fill(setAlpha(this.fill(), 0.5));
      this.fillEnabled(true);
    };
    this.deselect = () => {
      this.fill(setAlpha(this.fill(), 0.3));
      this.strokeEnabled(false);
    };

    /**
     * Delete the column, both from the layout data and from the canvas.
     */
    this.delete = () => {
      const colIndexI = this.layoutBox.table.boxes.findIndex((x) => x.id === this.layoutBox.id);
      this.layoutBox.table.boxes.splice(colIndexI, 1);
      this.destroy();
      this.viewer.doc.layoutRegions.pages[layoutBox.table.page.n].default = false;
      this.viewer.doc.layoutDataTables.pages[layoutBox.table.page.n].default = false;
      if (this.layoutBox.table.boxes.length === 0) {
        const tableIndex = this.viewer.doc.layoutDataTables.pages[layoutBox.table.page.n].tables.findIndex((x) => x.id === this.layoutBox.table.id);
        this.viewer.doc.layoutDataTables.pages[layoutBox.table.page.n].tables.splice(tableIndex, 1);
        this.uiTable.destroy();
      }
    };

    this.next = () => {
      const next = this.uiTable.columns.find((x) => x.x() > this.x());
      return next;
    };

    this.prev = () => {
      const prev = this.uiTable.columns.slice().reverse().find((x) => x.x() < this.x());
      return prev;
    };
  }
}

/**
 *
 * @param {Array<UiDataColumn>} selectedDataColumns
 * @returns
 */
export const checkDataColumnsAdjacent = (selectedDataColumns) => {
  selectedDataColumns.sort((a, b) => a.x() - b.x());
  const selectedDataColumnsIds = selectedDataColumns.map((x) => x.layoutBox.id);
  let colI = selectedDataColumns[0];
  let adjacent = true;
  for (let i = 1; i < selectedDataColumns.length; i++) {
    const colINext = colI.next();
    if (!colINext || !selectedDataColumnsIds.includes(colINext.layoutBox.id)) {
      adjacent = false;
      break;
    }
    colI = colINext;
  }
  return adjacent;
};

/**
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {LayoutDataTable} table
 */
const getAdjacentTables = (viewer, table) => {
  const adjacentTables = [];

  const tableBox = scribe.utils.calcTableBbox(table);

  const tableYMid = (tableBox.top + tableBox.bottom) / 2;

  const tablesBoxesAll = viewer.doc.layoutDataTables.pages[table.page.n].tables.map((x) => scribe.utils.calcTableBbox(x));
  const tables = viewer.doc.layoutDataTables.pages[table.page.n].tables.filter((x, i) => tablesBoxesAll[i].top < tableYMid && tablesBoxesAll[i].bottom > tableYMid).sort((a, b) => {
    const boxA = scribe.utils.calcTableBbox(a);
    const boxB = scribe.utils.calcTableBbox(b);
    return boxA.left - boxB.left;
  });

  const index = tables.findIndex((x) => x.id === table.id);

  if (index > 0) adjacentTables.push(tables[index - 1]);
  if (index < tables.length - 1) adjacentTables.push(tables[index + 1]);
  return adjacentTables;
};

/**
 * @param {Array<LayoutDataTable>} dataTables
 * @param {import('../viewer.js').ScribeViewer} [viewer]
 */
export const checkDataTablesAdjacent = (dataTables, viewer) => {
  const _viewer = viewer || ScribeViewer.getDefault();
  for (let i = 0; i < dataTables.length - 1; i++) {
    const table = dataTables[i];
    const tableNext = dataTables[i + 1];
    const adjacentTableIds = getAdjacentTables(_viewer, table).map((x) => x.id);

    if (!adjacentTableIds.includes(tableNext.id)) {
      return false;
    }
  }

  return true;
};

/**
 *
 * @param {Array<UiDataColumn>} columns
 */
export const mergeDataColumns = (columns) => {
  if (!columns || columns.length < 2 || !checkDataColumnsAdjacent(columns)) return;

  columns = columns.slice();

  const table = columns[0].uiTable.layoutDataTable;
  const viewer = getLayoutViewer(columns[0]);

  columns.sort((a, b) => a.x() - b.x());
  columns[0].layoutBox.coords.right = columns[columns.length - 1].layoutBox.coords.right;

  for (let i = 1; i < columns.length; i++) {
    columns[i].delete();
  }

  columns[0].uiTable.destroy();

  renderLayoutDataTable(viewer, table);
};

/**
 *
 * @param {UiDataColumn} column
 * @param {number} x - Point to split the column at
 */
export const splitDataColumn = (column, x) => {
  if (!column) return;

  // Add minimum width between columns to prevent lines from overlapping.
  const minColWidthAbs = Math.min((column.layoutBox.coords.right - column.layoutBox.coords.left) / 3, 10);

  // If the split point is outside the column, split at the center.
  if (x <= (column.layoutBox.coords.left + minColWidthAbs) || x >= (column.layoutBox.coords.right - minColWidthAbs)) {
    x = Math.round(column.layoutBox.coords.left + (column.layoutBox.coords.right - column.layoutBox.coords.left) / 2);
  }

  const bboxLeft = {
    left: column.layoutBox.coords.left, top: column.layoutBox.coords.top, right: x, bottom: column.layoutBox.coords.bottom,
  };
  const bboxRight = {
    left: x, top: column.layoutBox.coords.top, right: column.layoutBox.coords.right, bottom: column.layoutBox.coords.bottom,
  };

  column.layoutBox.coords = bboxLeft;

  const layoutBoxLeft = new scribe.layout.LayoutDataColumn(bboxRight, column.layoutBox.table);

  column.uiTable.layoutDataTable.boxes.push(layoutBoxLeft);

  column.uiTable.layoutDataTable.boxes.sort((a, b) => a.coords.left - b.coords.left);

  const viewer = getLayoutViewer(column);
  column.uiTable.destroy();
  renderLayoutDataTable(viewer, column.uiTable.layoutDataTable);
};

/**
 * Splits a table into two or three tables.
 * All columns in `columns` are inserted into a new table, all columns to the left of `columns` are inserted into a new table,
 * and all columns to the right of `columns` are inserted into a new table.
 * The old table is removed.
 * @param {Array<UiDataColumn>} columns
 */
export const splitDataTable = (columns) => {
  if (!columns || columns.length === 0 || columns.length === columns[0].layoutBox.table.boxes.length || !checkDataColumnsAdjacent(columns)) return;

  const viewer = getLayoutViewer(columns[0]);

  columns.sort((a, b) => a.x() - b.x());

  const n = columns[0].layoutBox.table.page.n;

  const layoutDataColumns0 = columns[0].layoutBox.table.boxes.filter((x) => x.coords.left < columns[0].layoutBox.coords.left);
  const layoutDataColumns1 = columns.map((x) => x.layoutBox);
  const layoutDataColumns2 = columns[0].layoutBox.table.boxes.filter((x) => x.coords.left > columns[columns.length - 1].layoutBox.coords.left);

  const tableExisting = layoutDataColumns1[0].table;
  const tableIndex = viewer.doc.layoutDataTables.pages[n].tables.findIndex((x) => x.id === tableExisting.id);
  viewer.doc.layoutDataTables.pages[n].tables.splice(tableIndex, 1);

  [layoutDataColumns0, layoutDataColumns1, layoutDataColumns2].forEach((layoutDataColumns) => {
    if (layoutDataColumns.length === 0) return;

    const table = new scribe.layout.LayoutDataTable(columns[0].layoutBox.table.page);

    layoutDataColumns.forEach((layoutDataColumn) => {
      layoutDataColumn.table = table;
      table.boxes.push(layoutDataColumn);
    });

    viewer.doc.layoutDataTables.pages[n].tables.push(table);
  });

  viewer.doc.layoutRegions.pages[n].default = false;
  viewer.doc.layoutDataTables.pages[n].default = false;

  renderLayoutDataTables(viewer, n);
};
