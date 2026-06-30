/* eslint-disable import/no-cycle */
import scribe from '../../scribe.js';
import {
  ScribeViewer,
} from '../viewer.js';
import { UiText } from './viewerWordObjects.js';
import {
  UiLayout, UiControlLine, makeDraggable,
} from './viewerLayoutBox.js';
import {
  UiDataTableControl, UiDataColSep, renderLayoutDataTables, UiDataTable,
  renderLayoutDataTable, UiDataColumn, checkDataColumnsAdjacent,
  checkDataTablesAdjacent, mergeDataColumns, splitDataColumn, splitDataTable,
} from './viewerLayoutTable.js';

// Re-export the layout-box and table APIs so existing importers can keep using `viewerLayout.js` as the entry point.
export {
  UiLayout,
  UiDataTableControl, UiDataColSep, renderLayoutDataTables, UiDataTable,
  renderLayoutDataTable, UiDataColumn, checkDataColumnsAdjacent,
  checkDataTablesAdjacent, mergeDataColumns, splitDataColumn, splitDataTable,
};

class UiRegionControlHorizontal extends UiControlLine {
  /**
   *
   * @param {UiRegion} uiRegion
   */
  constructor(uiRegion, top = true) {
    const c = uiRegion.layoutBox.coords;
    const n = uiRegion.layoutBox.page.n;
    super(uiRegion.viewer, n, 'h', c.left, top ? c.top : c.bottom, c.right - c.left);

    this.uiRegion = uiRegion;
    this.boundTop = 0;
    this.boundBottom = 10000;

    makeDraggable(this.el, this.viewer, n, {
      onStart: () => {
        this.viewer.drag.isResizingColumns = true;
        if (top) {
          this.boundTop = 0;
          this.boundBottom = this.uiRegion.bottomControl.y() - 20;
        } else {
          this.boundTop = this.uiRegion.topControl.y() + 20;
          this.boundBottom = this.viewer.doc.pageMetrics[n].dims.height;
        }
      },
      onMove: (p) => {
        const newY = Math.max(this.boundTop, Math.min(this.boundBottom, p.y));
        this.y(newY);
        const box = this.uiRegion.layoutBox.coords;
        if (top) {
          box.top = newY;
          this.uiRegion.y(box.top);
          this.uiRegion.height(box.bottom - box.top);
          this.uiRegion.leftControl.y(box.top);
          this.uiRegion.rightControl.y(box.top);
          this.uiRegion.leftControl.points([0, 0, 0, box.bottom - box.top]);
          this.uiRegion.rightControl.points([0, 0, 0, box.bottom - box.top]);
        } else {
          box.bottom = newY;
          this.uiRegion.height(box.bottom - box.top);
          this.uiRegion.leftControl.points([0, 0, 0, box.bottom - box.top]);
          this.uiRegion.rightControl.points([0, 0, 0, box.bottom - box.top]);
        }

        if (this.uiRegion.label) {
          this.uiRegion.label.x(this.uiRegion.x() + this.uiRegion.width() * 0.5);
          this.uiRegion.label.yActual = this.uiRegion.y() + this.uiRegion.height() * 0.5;
          UiText.updateWordCanvas(this.uiRegion.label);
        }
      },
      onEnd: () => { this.viewer.drag.isResizingColumns = false; },
    });
  }
}

class UiRegionControlVertical extends UiControlLine {
  /**
   *
   * @param {UiRegion} uiRegion
   */
  constructor(uiRegion, left = true) {
    const c = uiRegion.layoutBox.coords;
    const n = uiRegion.layoutBox.page.n;
    super(uiRegion.viewer, n, 'v', left ? c.left : c.right, c.top, c.bottom - c.top);

    this.uiRegion = uiRegion;
    this.boundLeft = 0;
    this.boundRight = 10000;

    makeDraggable(this.el, this.viewer, n, {
      onStart: () => {
        this.viewer.drag.isResizingColumns = true;
        if (left) {
          this.boundLeft = 0;
          this.boundRight = this.uiRegion.rightControl.x() - 20;
        } else {
          this.boundLeft = this.uiRegion.leftControl.x() + 20;
          this.boundRight = this.viewer.doc.pageMetrics[n].dims.width;
        }
      },
      onMove: (p) => {
        const newX = Math.max(this.boundLeft, Math.min(this.boundRight, p.x));
        this.x(newX);
        const box = this.uiRegion.layoutBox.coords;
        if (left) {
          box.left = newX;
          this.uiRegion.x(box.left);
          this.uiRegion.width(box.right - box.left);
          this.uiRegion.topControl.x(box.left);
          this.uiRegion.bottomControl.x(box.left);
          this.uiRegion.topControl.points([0, 0, box.right - box.left, 0]);
          this.uiRegion.bottomControl.points([0, 0, box.right - box.left, 0]);
        } else {
          box.right = newX;
          this.uiRegion.width(box.right - box.left);
          this.uiRegion.topControl.points([0, 0, box.right - box.left, 0]);
          this.uiRegion.bottomControl.points([0, 0, box.right - box.left, 0]);
        }

        if (this.uiRegion.label) {
          this.uiRegion.label.x(this.uiRegion.x() + this.uiRegion.width() * 0.5);
          this.uiRegion.label.yActual = this.uiRegion.y() + this.uiRegion.height() * 0.5;
          UiText.updateWordCanvas(this.uiRegion.label);
        }
      },
      onEnd: () => { this.viewer.drag.isResizingColumns = false; },
    });
  }
}

export class UiRegion extends UiLayout {
  /**
   * @param {LayoutRegion} layoutBox
   * @param {import('../viewer.js').ScribeViewer} [viewer]
   */
  constructor(layoutBox, viewer) {
    super(layoutBox, viewer);

    this.layoutBox = layoutBox;

    this.topControl = new UiRegionControlHorizontal(this, true);
    this.bottomControl = new UiRegionControlHorizontal(this, false);

    this.leftControl = new UiRegionControlVertical(this, true);
    this.rightControl = new UiRegionControlVertical(this, false);

    const group = this.viewer.getOverlayGroup(layoutBox.page.n);

    group.appendChild(this.topControl.el);
    group.appendChild(this.bottomControl.el);
    group.appendChild(this.leftControl.el);
    group.appendChild(this.rightControl.el);

    // When the whole region box is dragged, keep its four edge controls aligned to the new bounds.
    this._reposition = () => {
      this.topControl.x(this.x());
      this.topControl.y(this.y());
      this.bottomControl.x(this.x());
      this.bottomControl.y(this.y() + this.height());
      this.leftControl.x(this.x());
      this.leftControl.y(this.y());
      this.rightControl.x(this.x() + this.width());
      this.rightControl.y(this.y());
    };

    this.destroyLayout = this.destroy;

    /**
     * Removes the region from the canvas.
     * Does not impact the underlying data.
     */
    this.destroy = () => {
      this.topControl.destroy();
      this.bottomControl.destroy();
      this.leftControl.destroy();
      this.rightControl.destroy();

      this.destroyLayout();

      return this;
    };
  }
}

/**
 * Cleans a table to conform to the following rules:
 * 1. Columns must have no space between them (no overlap, no gap).
 * 2. Columns must have the same height.
 * This function is run after combining tables, as combining separate tables results in columns that do not conform to these rules.
 * @param {LayoutDataTable} table
 */
const cleanLayoutDataColumns = (table) => {
  const columnsArr = table.boxes;
  columnsArr.sort((a, b) => a.coords.left - b.coords.left);

  // Step 1: If columns overlap by a small amount, separate them.
  for (let i = 0; i < columnsArr.length - 1; i++) {
    const column = columnsArr[i];
    const nextColumn = columnsArr[i + 1];

    const gap = nextColumn.coords.left - column.coords.right;

    if (gap < 0 && gap >= 10) {
      const midpoint = Math.round(column.coords.right + gap / 2);
      column.coords.right = midpoint;
      nextColumn.coords.left = midpoint;
    }
  }

  // Step 2: If columns overlap by a large amount, delete one of them.
  for (let i = 0; i < columnsArr.length - 1; i++) {
    const column = columnsArr[i];
    const nextColumn = columnsArr[i + 1];

    column.coords.top = Math.min(column.coords.top, nextColumn.coords.top);
    column.coords.bottom = Math.max(column.coords.bottom, nextColumn.coords.bottom);

    const gap = nextColumn.coords.left - column.coords.right;

    if (gap < 0) {
      columnsArr.splice(i + 1, 1);
      i--;
    }
  }

  // Step 3: If columns have a gap between them, expand the columns to fill the gap.
  for (let i = 0; i < columnsArr.length - 1; i++) {
    const column = columnsArr[i];
    const nextColumn = columnsArr[i + 1];

    const gap = nextColumn.coords.left - column.coords.right;

    if (gap > 0) {
      const midpoint = Math.round(column.coords.right + gap / 2);
      column.coords.right = midpoint;
      nextColumn.coords.left = midpoint;
    }
  }

  // Step 4: Standardize all columns to the same height.
  const tableTop = Math.min(...columnsArr.map((x) => x.coords.top));
  const tableBottom = Math.max(...columnsArr.map((x) => x.coords.bottom));

  columnsArr.forEach((x) => {
    x.coords.top = tableTop;
    x.coords.bottom = tableBottom;
  });

  // Replace table boxes with cleaned columns.
  table.boxes = columnsArr;
};

/**
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 */
export function renderLayoutBoxes(viewer, n) {
  const group = viewer.getOverlayGroup(n);
  // The group's rotation is set by `createGroup` from the page's deskew + user rotation; clear only its contents.
  group.replaceChildren();

  if (!viewer.overlayGroupsRenderIndices.includes(n)) viewer.overlayGroupsRenderIndices.push(n);

  Object.values(viewer.doc.layoutRegions.pages[n].boxes).forEach((box) => {
    const uiLayout = new UiRegion(box, viewer);
    group.appendChild(uiLayout.el);
    if (uiLayout.label) group.appendChild(uiLayout.label.el);
    uiLayout.topControl.moveToTop();
    uiLayout.bottomControl.moveToTop();
    uiLayout.leftControl.moveToTop();
    uiLayout.rightControl.moveToTop();
  });
  renderLayoutDataTables(viewer, n);
}

/**
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} level
 */
export function setLayoutBoxInclusionLevelClick(viewer, level) {
  const selectedRegions = viewer.CanvasSelection.getUiRegions();
  const selectedDataColumns = viewer.CanvasSelection.getUiDataColumns();

  const changedPages = {};

  const selectedArr = selectedRegions.map((x) => x.layoutBox.id);
  selectedArr.push(...selectedDataColumns.map((x) => x.layoutBox.id));

  selectedRegions.forEach((x) => {
    if (x.layoutBox.inclusionLevel !== level) changedPages[x.layoutBox.page.n] = true;
    x.layoutBox.inclusionLevel = level;
  });

  selectedDataColumns.forEach((x) => {
    if (x.layoutBox.inclusionLevel !== level) changedPages[x.layoutBox.table.page.n] = true;
    x.layoutBox.inclusionLevel = level;
  });

  Object.keys(changedPages).forEach((n) => {
    renderLayoutBoxes(viewer, Number(n));
    viewer.CanvasSelection.selectLayoutBoxesById(selectedArr);
  });
}

/**
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {string} rule
 */
export function setLayoutBoxInclusionRuleClick(viewer, rule) {
  const selectedRegions = viewer.CanvasSelection.getUiRegions();
  const selectedDataColumns = viewer.CanvasSelection.getUiDataColumns();

  const changedPages = {};

  const selectedArr = selectedRegions.map((x) => x.layoutBox.id);
  selectedArr.push(...selectedDataColumns.map((x) => x.layoutBox.id));

  selectedRegions.forEach((x) => {
    if (x.layoutBox.inclusionRule !== rule) changedPages[x.layoutBox.page.n] = true;
    x.layoutBox.inclusionRule = rule;
  });
  selectedDataColumns.forEach((x) => {
    if (x.layoutBox.inclusionRule !== rule) changedPages[x.layoutBox.table.page.n] = true;
    x.layoutBox.inclusionRule = rule;
  });

  Object.keys(changedPages).forEach((n) => {
    renderLayoutBoxes(viewer, Number(n));
    viewer.CanvasSelection.selectLayoutBoxesById(selectedArr);
  });
}

/**
 *
 * @param {Array<LayoutDataTable>} tables
 */
export const mergeDataTables = (tables) => {
  if (!tables || tables.length < 2) return;
  const viewer = ScribeViewer.getDefault();
  if (!checkDataTablesAdjacent(tables, viewer)) return;

  const tableFirst = tables[0];

  const n = tableFirst.page.n;

  for (let i = 1; i < tables.length; i++) {
    tables[i].boxes.forEach((x) => {
      x.table = tableFirst;
      tableFirst.boxes.push(x);
    });
    const tableIndex = viewer.doc.layoutDataTables.pages[n].tables.findIndex((x) => x.id === tables[i].id);
    viewer.doc.layoutDataTables.pages[n].tables.splice(tableIndex, 1);
  }
  viewer.doc.layoutRegions.pages[n].default = false;
  viewer.doc.layoutDataTables.pages[n].default = false;

  cleanLayoutDataColumns(tableFirst);

  renderLayoutBoxes(viewer, n);
};

/**
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n - Page number.
 * @param {Object} box
 * @param {number} box.width
 * @param {number} box.height
 * @param {number} box.left
 * @param {number} box.top
 * @param {string} type
 */
export function addLayoutBox(viewer, n, box, type) {
  const maxPriority = Math.max(...Object.values(viewer.doc.layoutRegions.pages[n].boxes).map((layoutRegion) => layoutRegion.order), -1);

  const bbox = {
    left: box.left, top: box.top, right: box.left + box.width, bottom: box.top + box.height,
  };

  const region = new scribe.layout.LayoutRegion(viewer.doc.layoutRegions.pages[n], maxPriority + 1, bbox, type);

  viewer.doc.layoutRegions.pages[n].boxes[region.id] = region;

  renderLayoutBoxes(viewer, n);
}

/**
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n - Page number.
 * @param {Object} box
 * @param {number} box.width
 * @param {number} box.height
 * @param {number} box.left
 * @param {number} box.top
 */
export function addLayoutDataTable(viewer, n, box) {
  const bbox = {
    left: box.left, top: box.top, right: box.left + box.width, bottom: box.top + box.height,
  };

  const lines = viewer.doc.ocr.active[n].lines.filter((line) => scribe.utils.calcBoxOverlap(line.bbox, bbox) > 0.5);

  let columnBboxArr;
  if (lines.length > 0) {
    const lineBoxes = lines.map((line) => line.bbox);
    const columnBoundArr = scribe.utils.calcColumnBounds(lineBoxes);
    columnBboxArr = columnBoundArr.map((column) => ({
      left: column.left,
      top: bbox.top,
      right: column.right,
      bottom: bbox.bottom,
    }));

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

  const dataTable = new scribe.layout.LayoutDataTable(viewer.doc.layoutDataTables.pages[n]);

  columnBboxArr.forEach((columnBbox) => {
    const layoutBox = new scribe.layout.LayoutDataColumn(columnBbox, dataTable);
    dataTable.boxes.push(layoutBox);
  });

  viewer.doc.layoutDataTables.pages[n].tables.push(dataTable);

  viewer.doc.layoutRegions.pages[n].default = false;
  viewer.doc.layoutDataTables.pages[n].default = false;

  renderLayoutDataTable(viewer, dataTable);
}

/**
 * Apply the layout regions from one page to range of other pages.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} srcN - Page number of the source layout.
 * @param {number} minN - Minimum page number to apply the layout to.
 * @param {number} maxN - Maximum page number to apply the layout to (inclusive).
 */
function applyLayoutRegions(viewer, srcN, minN, maxN) {
  const srcRegions = viewer.doc.layoutRegions.pages[srcN].boxes;
  for (let i = minN; i <= maxN; i++) {
    if (i === srcN) continue;
    const boxes = structuredClone(srcRegions);
    for (const [, value] of Object.entries(boxes)) {
      value.id = scribe.utils.getRandomAlphanum(10);
      value.page = viewer.doc.layoutRegions.pages[i];
    }
    viewer.doc.layoutRegions.pages[i].boxes = boxes;
    if (Math.abs(i - viewer.state.cp.n) < 2) {
      renderLayoutBoxes(viewer, i);
    }
  }
}

/**
 * Apply the layout data tables from one page to range of other pages.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} srcN - Page number of the source layout.
 * @param {number} minN - Minimum page number to apply the layout to.
 * @param {number} maxN - Maximum page number to apply the layout to (inclusive).
 */
function applyLayoutDataTables(viewer, srcN, minN, maxN) {
  const srcTables = viewer.doc.layoutDataTables.pages[srcN].tables;
  for (let i = minN; i <= maxN; i++) {
    if (i === srcN) continue;
    const tables = structuredClone(srcTables);
    tables.forEach((x) => {
      x.id = scribe.utils.getRandomAlphanum(10);
      x.page = viewer.doc.layoutDataTables.pages[i];
    });
    viewer.doc.layoutDataTables.pages[i].tables = tables;
    if (Math.abs(i - viewer.state.cp.n) < 2) {
      renderLayoutBoxes(viewer, i);
    }
  }
}

export class layout {
  static renderLayoutBoxes = renderLayoutBoxes;

  static setLayoutBoxInclusionLevelClick = setLayoutBoxInclusionLevelClick;

  static setLayoutBoxInclusionRuleClick = setLayoutBoxInclusionRuleClick;

  static mergeDataTables = mergeDataTables;

  static splitDataColumn = splitDataColumn;

  static splitDataTable = splitDataTable;

  static addLayoutBox = addLayoutBox;

  static addLayoutDataTable = addLayoutDataTable;

  static applyLayoutRegions = applyLayoutRegions;

  static applyLayoutDataTables = applyLayoutDataTables;
}
