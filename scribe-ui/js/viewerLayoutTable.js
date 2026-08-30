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

const tableBboxOf = (table) => {
  const boxes = Object.values(table.boxes);
  return {
    left: Math.min(...boxes.map((b) => b.coords.left)),
    top: Math.min(...boxes.map((b) => b.coords.top)),
    right: Math.max(...boxes.map((b) => b.coords.right)),
    bottom: Math.max(...boxes.map((b) => b.coords.bottom)),
  };
};
const bottomMostTable = (page) => (page?.tables?.length ? page.tables.reduce((m, t) => (tableBboxOf(t).bottom > tableBboxOf(m).bottom ? t : m)) : null);
const topMostTable = (page) => (page?.tables?.length ? page.tables.reduce((m, t) => (tableBboxOf(t).top < tableBboxOf(m).top ? t : m)) : null);

const prevTabledPage = (viewer, n) => {
  for (let i = n - 1; i >= 0; i--) {
    const page = viewer.doc.layoutDataTables.pages[i];
    if (page?.tables?.length) return page;
  }
  return null;
};

/**
 * Link each table in `tabs` as a continuation of the preceding table in document order, in one undo step.
 * Clears any pending suggestion for each linked boundary.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {Array<LayoutDataTable>} tabs - The continuation fragments.
 */
export function linkTableSet(viewer, tabs) {
  const doc = viewer.doc;
  const targets = tabs.filter((t) => !t.continuesPrev && prevTabledPage(viewer, t.page.n));
  if (targets.length === 0) return;
  const pages = new Set();
  for (const t of targets) {
    pages.add(t.page.n);
    pages.add(prevTabledPage(viewer, t.page.n).n);
  }
  const ns = [...pages].sort((a, b) => a - b);
  const snap = doc.docHistory.snapshotLayout(doc, ns);
  for (const t of targets) {
    t.continuesPrev = true;
    const idx = (doc.tableLinkSuggestions || []).findIndex((s) => s.tableId === t.id);
    if (idx >= 0) doc.tableLinkSuggestions.splice(idx, 1);
  }
  doc.docHistory.recordLayout(snap, 'Linked tables');
  refreshChainSurfaces(viewer, ns[0], ns[ns.length - 1]);
}

/**
 * Link `table` as a continuation of the preceding table in document order.
 * Records undo and clears any pending suggestion for the boundary.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {LayoutDataTable} table - The continuation fragment.
 */
export function linkTables(viewer, table) {
  linkTableSet(viewer, [table]);
}

/**
 * Break the chain at `table`, so it no longer continues the previous table.
 * Records undo, and returns the boundary to the suggestion queue so re-linking stays one click.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {LayoutDataTable} table - The continuation fragment to detach.
 */
export function unlinkTable(viewer, table) {
  const doc = viewer.doc;
  const n = table.page.n;
  const prevPage = prevTabledPage(viewer, n);
  if (!table.continuesPrev) return;
  const snap = doc.docHistory.snapshotLayout(doc, prevPage ? [prevPage.n, n] : [n]);
  table.continuesPrev = false;
  doc.docHistory.recordLayout(snap, 'Unlinked tables');
  const prevTable = prevPage ? bottomMostTable(prevPage) : null;
  if (prevTable && !(doc.tableLinkSuggestions || []).some((s) => s.tableId === table.id)) {
    doc.tableLinkSuggestions.push({
      n, prevN: prevPage.n, tableId: table.id, prevTableId: prevTable.id, reason: 'unlinked',
    });
  }
  refreshChainSurfaces(viewer, prevPage ? prevPage.n : n, n);
}

/**
 * Detach each continuation fragment in `tabs` from its chain, in one undo step.
 * Returns every broken boundary to the suggestion queue so re-linking stays one click.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {Array<LayoutDataTable>} tabs - The continuation fragments to detach.
 */
export function unlinkTableSet(viewer, tabs) {
  const doc = viewer.doc;
  const chains = scribe.tableChains(doc.layoutDataTables.pages);
  /** @type {Array<[{n: number, table: LayoutDataTable}, {n: number, table: LayoutDataTable}]>} */
  const pairs = [];
  const pages = new Set();
  for (const t of tabs) {
    if (!t.continuesPrev) continue;
    const chain = chains.find((c) => c.some((f) => f.table.id === t.id));
    const i = chain ? chain.findIndex((f) => f.table.id === t.id) : -1;
    if (i <= 0) continue;
    pairs.push([chain[i - 1], chain[i]]);
    pages.add(chain[i - 1].n);
    pages.add(chain[i].n);
  }
  if (pairs.length === 0) return;
  const ns = [...pages].sort((a, b) => a - b);
  const snap = doc.docHistory.snapshotLayout(doc, ns);
  for (const [prev, frag] of pairs) {
    frag.table.continuesPrev = false;
    if (!(doc.tableLinkSuggestions || []).some((s) => s.tableId === frag.table.id)) {
      doc.tableLinkSuggestions.push({
        n: frag.n, prevN: prev.n, tableId: frag.table.id, prevTableId: prev.table.id, reason: 'unlinked',
      });
    }
  }
  doc.docHistory.recordLayout(snap, 'Unlinked tables');
  refreshChainSurfaces(viewer, ns[0], ns[ns.length - 1]);
}

/**
 * Detach every continuation fragment of the chain containing `table`, dissolving it into per-page tables.
 * Records one undo step for the whole chain, and returns each broken boundary to the suggestion queue.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {LayoutDataTable} table - Any fragment of the chain.
 */
export function unlinkChain(viewer, table) {
  const chain = scribe.tableChains(viewer.doc.layoutDataTables.pages).find((c) => c.some((f) => f.table.id === table.id));
  if (!chain || chain.length < 2) return;
  unlinkTableSet(viewer, chain.slice(1).map((f) => f.table));
}

/**
 * The continuation fragment a Link Tables verb would flag for this table selection, or null when the selection has no facing pair to link.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {Array<LayoutDataTable>} selectedTables
 * @returns {?LayoutDataTable}
 */
export function resolveLinkCandidate(viewer, selectedTables) {
  const pages = viewer.doc.layoutDataTables.pages;
  for (const t of selectedTables) {
    const n = t.page.n;
    if (!t.continuesPrev && topMostTable(pages[n]) === t && prevTabledPage(viewer, n)) return t;
    const nextTop = pages[n + 1] ? topMostTable(pages[n + 1]) : null;
    if (nextTop && !nextTop.continuesPrev && bottomMostTable(pages[n]) === t) return nextTop;
  }
  return null;
}

/**
 * The linked continuation fragment an Unlink at Page Break verb would detach for this table selection, or null.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {Array<LayoutDataTable>} selectedTables
 * @returns {?LayoutDataTable}
 */
export function resolveUnlinkCandidate(viewer, selectedTables) {
  const pages = viewer.doc.layoutDataTables.pages;
  for (const t of selectedTables) {
    if (t.continuesPrev) return t;
    const nextTop = pages[t.page.n + 1] ? topMostTable(pages[t.page.n + 1]) : null;
    if (nextTop?.continuesPrev && bottomMostTable(pages[t.page.n]) === t) return nextTop;
  }
  return null;
}

function refreshChainSurfaces(viewer, prevN, n) {
  // Every rendered page refreshes, not just the boundary pair.
  // A chain edit shifts the sheet row numbering of every later fragment.
  for (const pageN of viewer.overlayGroupsRenderIndices) {
    renderChainChrome(viewer, pageN);
    applyTablePreview(viewer, pageN);
  }
  viewer.layoutTablesEdited(n);
}

/**
 * Draw page `n`'s cross-page linking controls: the tabs on a linked boundary, and the confirm or link tab on an unlinked one.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 */
export function renderChainChrome(viewer, n) {
  const group = viewer._overlayGroups?.[n];
  if (!group) return;
  group.querySelectorAll('[data-scribe-chain]').forEach((el) => el.remove());
  if (!viewer.state.layoutMode || viewer.state.tablePreview) return;
  const doc = viewer.doc;
  const pages = doc.layoutDataTables.pages;
  const page = pages[n];
  if (!page?.tables?.length) return;

  // Page rasters range from a few hundred pixels wide to several thousand, so a fixed pixel size renders unusably small on the large ones.
  // Tab metrics are a fraction of the page instead, scaled against US Letter at 300dpi.
  const u = (viewer.doc.pageMetrics[n]?.dims?.width || 2550) / 2550;
  const px = (v) => `${Math.round(v * u * 10) / 10}px`;
  const mk = (styles, parent = group) => {
    const el = document.createElement('div');
    el.dataset.scribeChain = '1';
    Object.assign(el.style, { position: 'absolute', boxSizing: 'border-box' }, styles);
    parent.appendChild(el);
    return el;
  };
  const tabBase = (bbox, edge) => ({
    left: `${(bbox.left + bbox.right) / 2}px`,
    top: `${edge === 'bottom' ? bbox.bottom : bbox.top}px`,
    transform: 'translate(-50%, -50%)',
    display: 'flex',
    alignItems: 'center',
    gap: px(12),
    height: px(45),
    padding: `0 ${px(22)}`,
    borderRadius: px(22),
    whiteSpace: 'nowrap',
    fontWeight: '600',
    fontSize: px(25),
    lineHeight: '1',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    zIndex: '4',
    cursor: 'pointer',
    userSelect: 'none',
    transition: 'opacity 120ms',
  });
  const arrow = (dir) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:${px(25)};height:${px(25)};display:block;">${dir === 'down' ? '<path d="M12 5v13M6.5 12.5 12 18l5.5-5.5"/>' : '<path d="M12 19V6M6.5 11.5 12 6l5.5 5.5"/>'}</svg>`;
  const solidTab = (bbox, edge, label, table, navN, navTable) => {
    const tab = mk({
      ...tabBase(bbox, edge), background: CHROME_ACCENT, color: '#fff', boxShadow: `0 ${px(2)} ${px(7)} rgba(30,26,16,.28)`,
    });
    tab.innerHTML = `${arrow(edge === 'bottom' ? 'down' : 'up')}<span>${label}</span>`;
    tab.title = `Go to page ${navN + 1}`;
    tab.addEventListener('click', (e) => {
      e.stopPropagation();
      viewer.displayPage(navN, true, true).then(() => pulseTable(viewer, navTable)).catch(() => {});
    });
    const seg = document.createElement('span');
    seg.title = 'Unlink tables';
    seg.setAttribute('role', 'button');
    Object.assign(seg.style, {
      display: 'inline-flex', alignItems: 'center', alignSelf: 'stretch', paddingLeft: px(12), borderLeft: `${px(2)} solid rgba(255, 255, 255, .45)`, cursor: 'pointer',
    });
    seg.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:${px(25)};height:${px(25)};display:block;"><path d="M10 14a4.2 4.2 0 0 0 6 0l3-3a4.24 4.24 0 0 0-6-6l-1.7 1.7"/><path d="M14 10a4.2 4.2 0 0 0-6 0l-3 3a4.24 4.24 0 0 0 6 6l1.7-1.7"/><path d="M4 4l16 16" stroke-width="1.9"/></svg>`;
    const glyph = /** @type {HTMLElement} */ (seg.firstElementChild);
    seg.addEventListener('pointerenter', () => { glyph.style.transform = 'scale(1.15)'; });
    seg.addEventListener('pointerleave', () => { glyph.style.transform = ''; });
    seg.addEventListener('click', (ev) => { ev.stopPropagation(); unlinkTable(viewer, table); });
    tab.appendChild(seg);
    return tab;
  };
  const ghostTab = (bbox, edge, label, onConfirm, onDismiss) => {
    const tab = mk({
      ...tabBase(bbox, edge), background: '#fff', color: CHROME_ACCENT, border: `${px(4)} dashed ${CHROME_ACCENT}`, cursor: 'default',
    });
    const btn = (svg, title, handler, muted) => {
      const b = document.createElement('span');
      b.title = title;
      b.setAttribute('role', 'button');
      Object.assign(b.style, {
        display: 'inline-flex', cursor: 'pointer', color: muted ? '#98a1b0' : CHROME_ACCENT, padding: `${px(2)} ${px(5)}`, borderRadius: px(10),
      });
      b.innerHTML = svg;
      b.addEventListener('click', (e) => { e.stopPropagation(); handler(); });
      return b;
    };
    const ic = (path) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:${px(27)};height:${px(27)};display:block;">${path}</svg>`;
    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    tab.appendChild(labelEl);
    tab.appendChild(btn(ic('<path d="M4.5 12.5 10 18 19.5 7"/>'), 'Link tables', onConfirm, false));
    if (onDismiss) tab.appendChild(btn(ic('<path d="M6 6l12 12M18 6 6 18"/>'), 'Dismiss', onDismiss, true));
    return tab;
  };

  const prevPage = prevTabledPage(viewer, n);
  const topTable = topMostTable(page);
  if (prevPage && topTable) {
    const bbox = tableBboxOf(topTable);
    if (topTable.continuesPrev) {
      solidTab(bbox, 'top', `From page ${prevPage.n + 1}`, topTable, prevPage.n, bottomMostTable(prevPage));
    } else {
      const sug = (doc.tableLinkSuggestions || []).find((s) => s.tableId === topTable.id);
      if (sug) {
        ghostTab(bbox, 'top', 'Same table?', () => linkTables(viewer, topTable), () => {
          const idx = doc.tableLinkSuggestions.indexOf(sug);
          if (idx >= 0) doc.tableLinkSuggestions.splice(idx, 1);
          refreshChainSurfaces(viewer, prevPage.n, n);
        });
      }
    }
  }

  const nextPage = pages[n + 1];
  const bottomTable = bottomMostTable(page);
  const nextTop = nextPage ? topMostTable(nextPage) : null;
  if (bottomTable && nextTop) {
    const bbox = tableBboxOf(bottomTable);
    if (nextTop.continuesPrev) {
      solidTab(bbox, 'bottom', `Continues on page ${nextPage.n + 1}`, nextTop, nextPage.n, nextTop);
    } else if (!(doc.tableLinkSuggestions || []).some((s) => s.tableId === nextTop.id)) {
      const zone = mk({
        left: `${bbox.left}px`,
        top: `${bbox.bottom - 8}px`,
        width: `${bbox.right - bbox.left}px`,
        height: '16px',
        zIndex: '3',
      });
      let ghost = null;
      zone.addEventListener('pointerenter', () => {
        if (ghost) return;
        ghost = ghostTab(bbox, 'bottom', 'Link tables', () => linkTables(viewer, nextTop), null);
        ghost.addEventListener('pointerleave', () => { ghost?.remove(); ghost = null; });
      });
      zone.addEventListener('pointerleave', (e) => {
        if (ghost && e.relatedTarget instanceof Node && ghost.contains(e.relatedTarget)) return;
        ghost?.remove(); ghost = null;
      });
    }
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
  renderChainChrome(viewer, n);
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

    // A separator breaks across a row only where a captured word's ink spans it, matching how a spreadsheet drops the border a cell overflows across.
    // Testing the cell's whole span instead would also drop the borders between later columns whose own values never cross one.
    /** @type {Map<UiDataColSep, Array<[number, number]>>} */
    const sepGaps = new Map();
    if (preview && this.tableContent) {
      const { rowWordArr, rowBottomArr } = this.tableContent;
      rowWordArr.forEach((colWordArr, r) => {
        const bandTop = r === 0 ? tableTop : rowBottomArr[r - 1];
        const bandBottom = r === rowWordArr.length - 1 ? tableBottom : Math.min(rowBottomArr[r], tableBottom);
        colWordArr.forEach((words, c) => {
          if (this.layoutBoxesArr[c].inclusionLevel !== 'line' || words.length === 0) return;
          this.colLines.forEach((colLine) => {
            if (!colLine.columnLeft || !colLine.columnRight) return;
            const x = colLine.x();
            if (!words.some((w) => w.bbox.left < x && w.bbox.right > x)) return;
            if (!sepGaps.has(colLine)) sepGaps.set(colLine, []);
            sepGaps.get(colLine).push([bandTop - colLine.y(), bandBottom - colLine.y()]);
          });
        });
      });
      sepGaps.forEach((bands) => {
        bands.sort((a, b) => a[0] - b[0]);
        for (let i = bands.length - 1; i > 0; i--) {
          if (bands[i][0] <= bands[i - 1][1]) { bands[i - 1][1] = Math.max(bands[i - 1][1], bands[i][1]); bands.splice(i, 1); }
        }
      });
    }

    this.applyChrome = () => {
      this.colLines.forEach((colLine) => {
        const interior = !!(colLine.columnLeft && colLine.columnRight);
        const dashed = interior && colLine.columnLeft.layoutBox.inclusionLevel === 'line';
        if (preview) {
          colLine.setChrome({
            color: '#c9ced6', weight: interior ? 1.5 : 2, casing: false, gaps: sepGaps.get(colLine),
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
      if (e.button !== 0) return;
      if (this.viewer.state.tablePreview) {
        previewPress(e.clientY, true);
        return;
      }
      // Modifier presses select nothing here, because the click handler's extend and toggle read the selection as it stood before the press.
      if (e.shiftKey || e.ctrlKey || e.metaKey) return;
      this.viewer._colSweep = { tableId: this.layoutBox.table.id, anchor: this };
      document.addEventListener('pointerup', () => { this.viewer._colSweep = null; }, { once: true });
      this.viewer.CanvasSelection.deselectAll();
      this.viewer.CanvasSelection.selectLayoutBoxes([this]);
    });
    this.el.addEventListener('pointerenter', () => {
      const sweep = this.viewer._colSweep;
      if (!sweep || this.viewer.state.tablePreview || sweep.tableId !== this.layoutBox.table.id) return;
      const lo = Math.min(sweep.anchor.x(), this.x());
      const hi = Math.max(sweep.anchor.x(), this.x());
      this.viewer.CanvasSelection.deselectAll();
      this.viewer.CanvasSelection.selectLayoutBoxes(this.uiTable.columns.filter((c) => c.x() >= lo && c.x() <= hi));
    });
    this.el.addEventListener('click', (e) => {
      if (e.button !== 0) return;
      const tableId = this.layoutBox.table.id;
      const pageN = this.layoutBox.table.page.n;
      if (this.viewer.state.tablePreview) {
        previewPress(e.clientY, false);
        return;
      }
      const selected = this.viewer.CanvasSelection.getUiDataColumnsCopy();
      if ((e.ctrlKey || e.metaKey) && selected.length > 0) {
        // No same-table filter here, because a selection spanning two tables is what makes Merge Tables reachable.
        const next = selected.filter((c) => c.layoutBox.id !== this.layoutBox.id);
        if (next.length === selected.length) next.push(this);
        this.viewer.CanvasSelection.deselectAll();
        this.viewer.CanvasSelection.selectLayoutBoxes(next);
        return;
      }
      const sameTableSel = selected.filter((c) => c.layoutBox.table.id === tableId);
      if (e.shiftKey && sameTableSel.length > 0) {
        const xs = [...sameTableSel.map((c) => c.x()), this.x()];
        const lo = Math.min(...xs);
        const hi = Math.max(...xs);
        this.viewer.CanvasSelection.deselectAll();
        this.viewer.CanvasSelection.selectLayoutBoxes(this.uiTable.columns.filter((c) => c.x() >= lo && c.x() <= hi));
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
 * The columns a Preview Export selection designates for a merge.
 * Null unless the selection spans whole adjacent columns of the active sheet.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @returns {?Array<UiDataColumn>}
 */
export const getTablePreviewMergeColumns = (viewer) => {
  const sel = viewer.state.tablePreview ? viewer._tpSel : null;
  if (!sel) return null;
  const uiTable = viewer.getUiDataTables().find((t) => t.layoutDataTable.id === sel.id);
  if (!uiTable || !uiTable.tableContent) return null;
  const rowN = uiTable.tableContent.rowBottomArr.length;
  const rLo = Math.min(sel.r, sel.r2);
  const rHi = Math.max(sel.r, sel.r2);
  const cLo = Math.min(sel.c, sel.c2);
  const cHi = Math.max(sel.c, sel.c2);
  if (!(rLo === 0 && rHi === rowN - 1 && cHi > cLo && cHi < uiTable.columns.length)) return null;
  return uiTable.columns.slice(cLo, cHi + 1);
};

/**
 * Merge the whole columns a Preview Export selection spans.
 * The merged column stays selected.
 * @param {import('../viewer.js').ScribeViewer} viewer
 */
export const mergeTablePreviewColumns = (viewer) => {
  const columns = getTablePreviewMergeColumns(viewer);
  if (!columns) return;
  const sel = viewer._tpSel;
  const rowN = columns[0].uiTable.tableContent.rowBottomArr.length;
  // The selection write must precede the merge's re-derive, which keeps a selection only when it fits the new sheet.
  viewer._tpSel = {
    id: sel.id, r: 0, c: Math.min(sel.c, sel.c2), r2: rowN - 1, c2: Math.min(sel.c, sel.c2),
  };
  mergeDataColumns(columns);
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
