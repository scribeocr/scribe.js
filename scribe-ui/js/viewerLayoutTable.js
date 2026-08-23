/* eslint-disable import/no-cycle */
import scribe from '../../scribe.js';
import {
  ScribeViewer,
} from '../viewer.js';
import {
  UiLayout, UiControlLine, makeDraggable, getLayoutViewer,
} from './viewerLayoutBox.js';

import { applyTablePreview } from './viewerTablePreview.js';

// A literal rather than the accent token, because the table overlay draws over the always-white page.
const CHROME_ACCENT = '#1c62d4';
const CHROME_Z = 'var(--scribe-zoom, 1)';
const TAG_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
  + ' style="width:100%;height:100%;display:block;"><path d="M12 3H5a2 2 0 0 0-2 2v7l9 9 7-7z"/><circle cx="7.5" cy="7.5" r=".5"/></svg>';

/**
 * Make `tableId` the active table and re-render the tables whose state changed.
 * The page view draws every table identically, so the re-render only shows up in the Preview Export sheet.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {?string} tableId
 */
export function setActiveTable(viewer, tableId) {
  const prev = viewer.state.activeTableId;
  if (prev === tableId) return;
  viewer.state.activeTableId = tableId;
  for (const page of viewer.doc.layoutDataTables.pages) {
    if (!viewer.overlayGroupsRenderIndices.includes(page.n)) continue;
    for (const table of page.tables) {
      if (table.id === prev || table.id === tableId) renderLayoutDataTable(viewer, table);
    }
  }
}

/**
 * Flash one soft accent glow on a table's frame, marking the user's arrival at it.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {LayoutDataTable} layoutDataTable
 */
export function pulseTable(viewer, layoutDataTable) {
  const group = viewer._overlayGroups?.[layoutDataTable.page.n];
  const boxes = Object.values(layoutDataTable.boxes);
  if (!group || boxes.length === 0) return;
  group.querySelectorAll('[data-scribe-table-pulse]').forEach((el) => el.remove());
  const left = Math.min(...boxes.map((b) => b.coords.left));
  const right = Math.max(...boxes.map((b) => b.coords.right));
  const top = Math.min(...boxes.map((b) => b.coords.top));
  const bottom = Math.max(...boxes.map((b) => b.coords.bottom));
  const pulse = document.createElement('div');
  pulse.dataset.scribeTablePulse = '1';
  Object.assign(pulse.style, {
    position: 'absolute',
    boxSizing: 'border-box',
    left: `${left}px`,
    top: `${top}px`,
    width: `${right - left}px`,
    height: `${bottom - top}px`,
    borderRadius: 'calc(4px / var(--scribe-zoom, 1))',
    opacity: '0',
    pointerEvents: 'none',
    zIndex: '3',
  });
  pulse.classList.add('scribe-table-pulse');
  pulse.addEventListener('animationend', () => pulse.remove());
  // Where animations never run, the base opacity of 0 keeps the pulse invisible and this timeout still reaps the node.
  setTimeout(() => pulse.remove(), 1200);
  group.appendChild(pulse);
}

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

    let dragSnap = null;
    makeDraggable(this.el, this.viewer, n, {
      onStart: () => {
        this.viewer.drag.isResizingColumns = true;
        dragSnap = this.viewer.doc.docHistory.snapshotLayout(this.viewer.doc, [n]);
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
        if (dragSnap) this.viewer.doc.docHistory.recordLayout(dragSnap, 'Resized table');
        dragSnap = null;
        renderLayoutDataTable(this.viewer, this.uiTable.layoutDataTable);
        this.viewer.layoutTablesEdited(n);
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

    let dragSnap = null;
    makeDraggable(this.el, this.viewer, n, {
      onStart: () => {
        this.viewer.drag.isResizingColumns = true;
        dragSnap = this.viewer.doc.docHistory.snapshotLayout(this.viewer.doc, [n]);
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
        if (dragSnap) this.viewer.doc.docHistory.recordLayout(dragSnap, 'Resized table column');
        dragSnap = null;
        renderLayoutDataTable(this.viewer, this.uiTable.layoutDataTable);
        this.viewer.layoutTablesEdited(n);
      },
    });
  }
}

/**
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 */
export function renderLayoutDataTables(viewer, n) {
  Object.values(viewer.doc.layoutDataTables.pages[n].tables ?? []).forEach((table) => {
    renderLayoutDataTable(viewer, table, true);
  });
  // A page with no tables still needs this pass, because in the sheet view all of its words ghost.
  applyTablePreview(viewer, n);
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
      this.titleEls.forEach((el) => el.remove());

      this.topControl.destroy();
      this.bottomControl.destroy();

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

    /** @type {Array<HTMLElement>} */
    this.titleEls = [];

    /** @type {?ReturnType<typeof scribe.utils.extractSingleTableContent>} */
    this.tableContent = null;

    const preview = this.viewer.state.tablePreview;

    if (pageObj) {
      this.tableContent = scribe.utils.extractSingleTableContent(pageObj, this.layoutBoxesArr, layoutDataTable.rowBounds);

      this.rowLines = this.tableContent.rowBottomArr.map((rowBottom) => {
        const line = document.createElement('div');
        Object.assign(line.style, {
          position: 'absolute',
          left: `${tableLeft}px`,
          top: `${rowBottom}px`,
          width: `${tableRight - tableLeft}px`,
          pointerEvents: 'none',
          boxSizing: 'border-box',
        });
        if (preview) {
          Object.assign(line.style, { height: `calc(1px / ${CHROME_Z})`, background: '#c9ced6' });
        } else {
          Object.assign(line.style, {
            height: `calc(3px / ${CHROME_Z})`,
            background: 'rgba(31,37,48,0.3)',
            borderTop: `calc(1px / ${CHROME_Z}) solid rgba(255,255,255,0.7)`,
            borderBottom: `calc(1px / ${CHROME_Z}) solid rgba(255,255,255,0.7)`,
            opacity: '0.65',
          });
        }
        return line;
      });

      this.rowLines.forEach((rowLine) => {
        group.appendChild(rowLine);
      });
    }

    this.applyChrome = () => {
      this.colLines.forEach((colLine) => {
        const interior = !!(colLine.columnLeft && colLine.columnRight);
        const dashed = interior && colLine.columnLeft.layoutBox.inclusionLevel === 'line';
        if (preview) {
          colLine.setChrome(dashed
            ? {
              accent: true, dashed: true, weight: 2, casing: false,
            }
            : {
              color: '#c9ced6', weight: interior ? 1.5 : 2, casing: false,
            });
        } else {
          colLine.setChrome({ accent: true, dashed, weight: interior ? 3.5 : 2 });
        }
      });
      [this.topControl, this.bottomControl].forEach((bar) => {
        if (preview) bar.setChrome({ color: '#c9ced6', weight: 2, casing: false });
        else bar.setChrome({ accent: true, weight: 2 });
      });
    };
    this.applyChrome();

    const title = layoutDataTable.title;
    if (title && title.bbox && !preview) {
      const tb = title.bbox;
      const ul = document.createElement('div');
      Object.assign(ul.style, {
        position: 'absolute',
        left: `${tb.left}px`,
        top: `${tb.bottom + 2}px`,
        width: `${tb.right - tb.left}px`,
        height: `calc(2px / ${CHROME_Z})`,
        background: CHROME_ACCENT,
        opacity: '0.75',
        pointerEvents: 'auto',
        cursor: 'default',
        zIndex: '2',
      });
      const tag = document.createElement('span');
      tag.innerHTML = TAG_SVG;
      Object.assign(tag.style, {
        position: 'absolute',
        left: `calc(${tb.left}px - 19px / ${CHROME_Z})`,
        top: `${(tb.top + tb.bottom) / 2}px`,
        width: `calc(14px / ${CHROME_Z})`,
        height: `calc(14px / ${CHROME_Z})`,
        transform: 'translateY(-50%)',
        color: CHROME_ACCENT,
        opacity: '0.9',
        pointerEvents: 'none',
        zIndex: '2',
      });
      this.titleEls = [ul, tag];
      group.appendChild(ul);
      group.appendChild(tag);
      const outerBars = [this.colLines[0], this.colLines[this.colLines.length - 1], this.topControl, this.bottomControl];
      const ring = `0 0 0 calc(3px / ${CHROME_Z}) rgba(28,98,212,0.3)`;
      ul.addEventListener('pointerenter', () => {
        outerBars.forEach((bar) => {
          const core = /** @type {?HTMLElement} */ (bar.el && bar.el.firstElementChild);
          if (core) core.style.boxShadow = core.style.boxShadow && core.style.boxShadow !== 'none' ? `${core.style.boxShadow}, ${ring}` : ring;
        });
      });
      ul.addEventListener('pointerleave', () => this.applyChrome());
      outerBars.forEach((bar) => {
        if (!bar.el) return;
        bar.el.addEventListener('pointerenter', () => {
          ul.style.opacity = '1';
          ul.style.height = `calc(2.5px / ${CHROME_Z})`;
        });
        bar.el.addEventListener('pointerleave', () => {
          ul.style.opacity = '0.75';
          ul.style.height = `calc(2px / ${CHROME_Z})`;
        });
      });
    }
  }
}

/**
 * Render a layout data table on the canvas.
 * If the data table already exists on the canvas, it is automatically removed.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {InstanceType<typeof scribe.layout.LayoutDataTable>} layoutDataTable
 * @param {boolean} [skipPreviewApply] - Leave the Preview Export re-derive to the caller, for a batch that renders several tables on one page.
 */
export function renderLayoutDataTable(viewer, layoutDataTable, skipPreviewApply = false) {
  if (!layoutDataTable || Object.keys(layoutDataTable.boxes).length === 0) {
    console.log(`Skipping table ${layoutDataTable?.id} as it has no boxes`);
    return;
  }

  const uiLayoutExisting = viewer.getUiDataTables().find((x) => x.layoutDataTable.id === layoutDataTable.id);

  if (uiLayoutExisting) uiLayoutExisting.destroy();

  const uiLayout = new UiDataTable(viewer.doc.ocr.active[layoutDataTable.page.n], layoutDataTable, true, viewer);

  uiLayout.columns.forEach((column) => {
    const group = viewer.getOverlayGroup(column.uiTable.layoutDataTable.page.n);
    group.appendChild(column.el);
  });
  uiLayout.colLines.forEach((colLine) => colLine.moveToTop());
  uiLayout.topControl.moveToTop();
  uiLayout.bottomControl.moveToTop();

  // The Preview Export view derives its text and sheet grid from the rendered tables, so every table render re-applies it for the whole page.
  if (!skipPreviewApply) applyTablePreview(viewer, layoutDataTable.page.n);
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

    /* These listeners are element-level because the shell runs with `enableCanvasSelection` off, so the viewport's click-select pipeline never fires here.
       In the preview a press selects the cell under the pointer, never the page-view column selection, whose tint would read as a range that Ctrl+C does not copy.
       Running on pointerdown and seeding a drag anchor lets a press on a non-active table sweep into a cell range in one gesture, across the re-render that replaces this element mid-press.
       The click path stays for the synthetic clicks the context menu forwards here. */
    const previewPress = (clientY, seedDrag) => {
      // This runs a second time for the synthetic click, by which point the re-render has already destroyed this object.
      if (!this.el) return;
      const tableId = this.layoutBox.table.id;
      const pageN = this.layoutBox.table.page.n;
      const content = this.uiTable.tableContent;
      if (content && content.rowBottomArr.length > 0) {
        const c = Math.max(0, this.uiTable.layoutBoxesArr.indexOf(this.layoutBox));
        const rect = this.el.getBoundingClientRect();
        const frac = rect.height > 0 ? (clientY - rect.top) / rect.height : 0;
        const pageY = this.layoutBox.coords.top + frac * (this.layoutBox.coords.bottom - this.layoutBox.coords.top);
        let r = content.rowBottomArr.length - 1;
        for (let i = 0; i < content.rowBottomArr.length; i++) {
          if (pageY < content.rowBottomArr[i]) { r = i; break; }
        }
        this.viewer._tpSel = {
          id: tableId, r, c, r2: r, c2: c,
        };
        if (seedDrag) {
          this.viewer._tpDragAnchor = { id: tableId, r, c };
          document.addEventListener('pointerup', () => { this.viewer._tpDragAnchor = null; }, { once: true });
        }
      }
      // The selection write has to precede this re-derive, which keeps a selection only when its id matches the new active sheet, otherwise the pressed cell comes up reset to A1.
      if (this.viewer.state.activeTableId !== tableId) setActiveTable(this.viewer, tableId);
      else applyTablePreview(this.viewer, pageN);
      this.viewer.layoutTablesEdited(pageN);
    };
    this.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !this.viewer.state.tablePreview) return;
      previewPress(e.clientY, true);
    });
    this.el.addEventListener('click', (e) => {
      if (e.button !== 0) return;
      const tableId = this.layoutBox.table.id;
      const pageN = this.layoutBox.table.page.n;
      if (this.viewer.state.tablePreview) {
        previewPress(e.clientY, false);
        return;
      }
      if (this.viewer.state.activeTableId === tableId) {
        this.viewer.CanvasSelection.deselectAll();
        this.viewer.CanvasSelection.selectLayoutBoxes([this]);
        return;
      }
      setActiveTable(this.viewer, tableId);
      pulseTable(this.viewer, this.layoutBox.table);
      this.viewer.CanvasSelection.selectLayoutBoxesById([this.layoutBox.id]);
      this.viewer.layoutTablesEdited(pageN);
    });

    this.select = () => {
      this.fill('rgba(28,98,212,0.14)');
      this.fillEnabled(true);
    };
    this.deselect = () => {
      this.fill('');
      this.fillEnabled(false);
      this.strokeEnabled(false);
    };

    /**
     * Delete the column, both from the layout data and from the canvas.
     */
    this.delete = () => {
      const colIndexI = this.layoutBox.table.boxes.findIndex((x) => x.id === this.layoutBox.id);
      this.layoutBox.table.boxes.splice(colIndexI, 1);
      this.destroy();
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
  const n = table.page.n;

  const snap = viewer.doc.docHistory.snapshotLayout(viewer.doc, [n]);
  columns.sort((a, b) => a.x() - b.x());
  columns[0].layoutBox.coords.right = columns[columns.length - 1].layoutBox.coords.right;

  for (let i = 1; i < columns.length; i++) {
    columns[i].delete();
  }

  columns[0].uiTable.destroy();
  viewer.doc.docHistory.recordLayout(snap, 'Merged columns');

  renderLayoutDataTable(viewer, table);
  viewer.layoutTablesEdited(n);
};

/**
 *
 * @param {UiDataColumn} column
 * @param {number} x - Point to split the column at
 */
export const splitDataColumn = (column, x) => {
  if (!column) return;

  const viewer = getLayoutViewer(column);
  const n = column.layoutBox.table.page.n;
  const snap = viewer.doc.docHistory.snapshotLayout(viewer.doc, [n]);

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

  viewer.doc.docHistory.recordLayout(snap, 'Split column');
  column.uiTable.destroy();
  renderLayoutDataTable(viewer, column.uiTable.layoutDataTable);
  viewer.layoutTablesEdited(n);
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

  const snap = viewer.doc.docHistory.snapshotLayout(viewer.doc, [n]);
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

  viewer.doc.docHistory.recordLayout(snap, 'Split table');

  renderLayoutDataTables(viewer, n);
  viewer.layoutTablesEdited(n);
};
