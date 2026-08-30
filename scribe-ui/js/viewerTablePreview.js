import scribe from '../../scribe.js';
// eslint-disable-next-line import/no-cycle
import { unlinkTable } from './viewerLayoutTable.js';

const Z = 'var(--scribe-zoom, 1)';
const ACCENT = '#1c62d4';
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const colLetter = (i) => LETTERS[i] || String(i + 1);

const docSheets = (viewer) => {
  const out = [];
  for (const page of viewer.doc.layoutDataTables.pages) {
    page.tables.forEach((table, m) => out.push({ table, n: page.n, m }));
  }
  return out;
};

/**
 * The active sheet, resolved against the current document.
 * A stale or absent `state.activeTableId` is written back with the resolved id, so the result is null only when the document has no tables.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @returns {?{table: LayoutDataTable, n: number, m: number}}
 */
export function resolveActiveSheet(viewer) {
  const sheets = docSheets(viewer);
  const id = viewer.state.activeTableId;
  let found = id != null ? sheets.find((s) => s.table.id === id) || null : null;
  if (!found) {
    found = sheets.find((s) => s.n === viewer.state.cp.n) || sheets[0] || null;
    viewer.state.activeTableId = found ? found.table.id : null;
  }
  return found;
}

/**
 * Re-derive the preview view's ink, ghost text, and sheet grid for page `n`.
 * With the preview off it only clears what it drew, leaving word colors to the display-mode paths.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 */
export function applyTablePreview(viewer, n) {
  const group = viewer._overlayGroups?.[n];
  const pc = viewer.pageContainerArr?.[n];
  if (group) group.querySelectorAll('[data-scribe-tp]').forEach((el) => el.remove());
  if (pc) pc.querySelectorAll('[data-scribe-tp]').forEach((el) => el.remove());
  if (!viewer.state.tablePreview) return;

  // Without this return, the word loop below would hide every word on the page.
  const activeSheet = resolveActiveSheet(viewer);
  if (!activeSheet) return;

  /** @type {Array<import('./viewerLayoutTable.js').UiDataTable>} */
  const uiTables = [];
  if (group) {
    group.querySelectorAll('[data-scribe-kind="layout"]').forEach((el) => {
      const obj = /** @type {any} */ (el)._scribeObj;
      if (obj?.uiTable && !uiTables.includes(obj.uiTable)) uiTables.push(obj.uiTable);
    });
  }
  // A chain is one sheet, so every page holding one of its fragments draws that fragment as a segment of it.
  const chains = scribe.tableChains(viewer.doc.layoutDataTables.pages);
  const activeChain = chains.find((c) => c.some((f) => f.table.id === activeSheet.table.id)) || null;
  const pageFrag = activeChain && activeChain.length > 1 ? activeChain.find((f) => f.n === n) || null : null;
  const segTableId = pageFrag ? pageFrag.table.id : activeSheet.table.id;
  const sheet = uiTables.find((t) => t.layoutDataTable.id === segTableId) || null;

  const fmtOn = viewer.state.tablePreviewFormatting !== false;
  const anyTableIds = new Set();
  uiTables.forEach((t) => t.tableContent?.rowWordArr.flat(2).forEach((w) => anyTableIds.add(w.id)));
  let leftOut = 0;
  for (const obj of viewer._wordObjs?.[n] || []) {
    if (anyTableIds.has(obj.word.id)) {
      // The plain export flattens text to black, so the plain preview does too.
      obj.fill(fmtOn ? obj.word.style.color || 'black' : 'black');
      obj.opacity(1);
    } else if (viewer.state.tablePreviewGhost) {
      leftOut++;
      obj.fill('#98a0ab');
      obj.opacity(0.8);
    } else {
      leftOut++;
      obj.opacity(0);
    }
  }

  if (!group || !sheet || !sheet.tableContent) return;

  const dims = viewer.doc.pageMetrics[n].dims;
  const tc = sheet.coords;
  const content = sheet.tableContent;
  const bandEdges = [tc.top, ...content.rowBottomArr];
  const columns = sheet.layoutBoxesArr;

  // Row numbering and the dropped repeated header mirror what the export writes, so the preview stays an accurate audit of the output.
  const normRow = (words) => words.flat().map((w) => w.text).join(' ').toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  let rowOffset = 0;
  let dedupRow0 = false;
  let chainName = null;
  const fragIdx = pageFrag && activeChain ? activeChain.indexOf(pageFrag) : 0;
  if (pageFrag && activeChain) {
    chainName = scribe.tableChainName(viewer.doc.layoutDataTables.pages, activeChain);
    const fragRows = (f) => scribe.extractTextFromTables(viewer.doc.ocr.active[f.n], /** @type {any} */ ({ tables: [f.table] }))[0]?.rows || [];
    const headRows = fragRows(activeChain[0]);
    const headRow0 = headRows.length ? headRows[0].join(' ').toLowerCase().replace(/\s+/g, ' ').trim() : null;
    const dedups = (rows) => !!(headRow0 && headRow0.length >= 6 && rows.length && rows[0].join(' ').toLowerCase().replace(/\s+/g, ' ').trim() === headRow0);
    for (let fi = 0; fi < fragIdx; fi++) {
      const rows = fi === 0 ? headRows : fragRows(activeChain[fi]);
      rowOffset += rows.length - (fi > 0 && dedups(rows) ? 1 : 0);
    }
    dedupRow0 = fragIdx > 0 && !!headRow0 && headRow0.length >= 6 && content.rowWordArr.length > 0 && normRow(content.rowWordArr[0]) === headRow0;
  }
  /** Spreadsheet row number for local row `r` as a string, or a dot for the dropped repeated header. */
  const rowNum = (r) => (dedupRow0 && r === 0 ? '\u00b7' : String(rowOffset + r + 1 - (dedupRow0 ? 1 : 0)));
  const stripH = fragIdx > 0 ? 15 : 0;

  const mk = (styles, parent = group) => {
    const el = document.createElement('div');
    el.dataset.scribeTp = '1';
    Object.assign(el.style, {
      position: 'absolute', boxSizing: 'border-box', userSelect: 'none', webkitUserSelect: 'none',
    }, styles);
    parent.appendChild(el);
    return el;
  };
  // The `font` shorthand cannot hold calc() or var(), so every text element takes these longhands instead.
  const font = (px, weight = 600, family = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif') => ({
    fontWeight: String(weight), fontSize: `calc(${px}px / ${Z})`, lineHeight: '1.2', fontFamily: family,
  });

  // The grid parents to the page container, not the overlay group, which would draw it over the words.
  if (pc) {
    const bgrid = mk({
      left: '0', top: '0', width: '100%', height: '100%', pointerEvents: 'none', opacity: '0.5', zIndex: '0', overflow: 'hidden',
    }, pc);
    bgrid.dataset.scribeTpBgrid = '1';
    const heights = [];
    for (let i = 1; i < bandEdges.length; i++) heights.push(bandEdges[i] - bandEdges[i - 1]);
    heights.sort((a, b) => a - b);
    const rowPitch = Math.max(heights[Math.floor(heights.length / 2)] || 24, 10);
    // 3.2 is Excel's default column-to-row pitch ratio, 64px to 20px.
    const colPitch = rowPitch * 3.2;
    const xs = columns.map((col) => col.coords.left).concat(tc.right);
    for (let x = tc.right + colPitch, i = 0; x < dims.width && i < 250; x += colPitch, i++) xs.push(x);
    for (let x = tc.left - colPitch, i = 0; x > 0 && i < 250; x -= colPitch, i++) xs.push(x);
    const ys = bandEdges.slice();
    for (let y = bandEdges[bandEdges.length - 1] + rowPitch, i = 0; y < dims.height && i < 250; y += rowPitch, i++) ys.push(y);
    for (let y = tc.top - rowPitch, i = 0; y > 0 && i < 250; y -= rowPitch, i++) ys.push(y);
    // The backdrop is context around the sheets only, so every line stops at a table's edge.
    // Running one through would double the table's own separators and repaint the gaps line capture opens in them.
    const rects = uiTables.map((t) => t.coords);
    /** Complement of the blocked `[start, end]` spans within `[0, limit]`. */
    const cutSpans = (blocks, limit) => {
      const spans = blocks.slice().sort((a, b) => a[0] - b[0]);
      const out = [];
      let pos = 0;
      for (const [s, e] of spans) {
        if (s > pos) out.push([pos, s]);
        pos = Math.max(pos, e);
      }
      if (pos < limit) out.push([pos, limit]);
      return out;
    };
    for (const x of xs) {
      const blocks = rects.filter((r) => x >= r.left && x <= r.right).map((r) => [r.top, r.bottom]);
      for (const [s, e] of cutSpans(blocks, dims.height)) {
        mk({
          left: `${x}px`, top: `${s}px`, width: `calc(1px / ${Z})`, height: `${e - s}px`, background: '#e4e8ef',
        }, bgrid);
      }
    }
    for (const y of ys) {
      const blocks = rects.filter((r) => y >= r.top && y <= r.bottom).map((r) => [r.left, r.right]);
      for (const [s, e] of cutSpans(blocks, dims.width)) {
        mk({
          left: `${s}px`, top: `${y}px`, width: `${e - s}px`, height: `calc(1px / ${Z})`, background: '#e4e8ef',
        }, bgrid);
      }
    }
  }

  // Stripe parity counts from the start of the whole chain rather than this page, so a continuation page stripes in phase with the sheet.
  // Only the head fragment carries header rows, for the same reason.
  const headTable = activeChain ? activeChain[0].table : sheet.layoutDataTable;
  const chainHeaderRows = Math.max(0, headTable.headerRows ?? 1);
  const localHeaderRows = fragIdx === 0 ? Math.min(chainHeaderRows, content.rowBottomArr.length) : 0;
  // The plain export forces header rows bold, so the plain preview does too.
  // This needs no matching reset. Flipping the option rebuilds the text layer, and a blanket reset here would instead wipe the weights the renderer set from the document's own fonts.
  if (!fmtOn && localHeaderRows > 0) {
    const headerIds = new Set(content.rowWordArr.slice(0, localHeaderRows).flat(2).map((w) => w.id));
    for (const obj of viewer._wordObjs?.[n] || []) {
      if (headerIds.has(obj.word.id) && obj.el) obj.el.style.fontWeight = 'bold';
    }
  }
  if (pc && fmtOn && headTable.detectionMethod === 'row-band') {
    for (let r = 0; r < content.rowBottomArr.length; r++) {
      if (dedupRow0 && r === 0) continue;
      const g = rowOffset + r - (dedupRow0 ? 1 : 0);
      if (g < chainHeaderRows || (g - chainHeaderRows) % 2 !== 1) continue;
      const fill = mk({
        left: `${tc.left}px`, top: `${bandEdges[r]}px`, width: `${tc.right - tc.left}px`, height: `${bandEdges[r + 1] - bandEdges[r]}px`, background: headTable.bandColor || '#f2f2f2', pointerEvents: 'none', zIndex: '0',
      }, pc);
      fill.dataset.scribeTpZebra = '1';
    }
  }
  if (pc && localHeaderRows > 0 && localHeaderRows < bandEdges.length) {
    const rule = mk({
      left: `${tc.left}px`, top: `${bandEdges[localHeaderRows]}px`, width: `${tc.right - tc.left}px`, height: `calc(${fmtOn && headTable.detectionMethod === 'grid-strong' ? 2 : 1.2}px / ${Z})`, background: '#2f3540', pointerEvents: 'none', zIndex: '0',
    }, pc);
    rule.dataset.scribeTpHdrule = '1';
  }

  // A cell bar pinned to the page top would be scrolled out of view whenever the table sits further down, so this one tracks the table.
  const fx = mk({
    left: '0',
    top: `max(calc(4px / ${Z}), calc(${tc.top}px - ${47 + stripH}px / ${Z}))`,
    width: `${dims.width}px`,
    height: `calc(26px / ${Z})`,
    background: '#ffffff',
    border: `calc(1px / ${Z}) solid #d7dce4`,
    display: 'flex',
    alignItems: 'stretch',
    zIndex: '4',
  });
  const nameBox = mk({
    position: 'relative',
    width: `calc(64px / ${Z})`,
    flex: 'none',
    display: 'grid',
    placeItems: 'center',
    ...font(11, 650, 'ui-monospace, Menlo, Consolas, monospace'),
    color: '#1f2530',
    borderRight: `calc(1px / ${Z}) solid #d7dce4`,
  }, fx);
  // mk sets user-select: none on everything it makes, so the value readout opts back in to stay selectable.
  const fxVal = mk({
    position: 'relative',
    flex: `1 0 calc(110px / ${Z})`,
    minWidth: '0',
    alignSelf: 'center',
    userSelect: 'text',
    webkitUserSelect: 'text',
    cursor: 'text',
    padding: `0 calc(8px / ${Z})`,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    ...font(11, 400, 'ui-monospace, Menlo, Consolas, monospace'),
    color: '#1f2530',
  }, fx);

  if (chainName) {
    const nameChip = mk({
      position: 'relative',
      flex: '0 3 auto',
      minWidth: '0',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
      textOverflow: 'ellipsis',
      alignSelf: 'center',
      padding: `0 calc(8px / ${Z})`,
      borderLeft: `calc(1px / ${Z}) solid #d7dce4`,
      ...font(10.5),
      color: '#586170',
    }, fx);
    nameChip.textContent = chainName;
    nameChip.title = chainName;
  }

  const ghostOn = viewer.state.tablePreviewGhost;
  const chip = mk({
    position: 'relative',
    flex: '0 1 auto',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    textOverflow: 'ellipsis',
    alignSelf: 'center',
    display: 'flex',
    alignItems: 'center',
    gap: `calc(6px / ${Z})`,
    margin: `0 calc(6px / ${Z})`,
    padding: `calc(4px / ${Z}) calc(8px / ${Z})`,
    borderRadius: `calc(6px / ${Z})`,
    border: `calc(1px / ${Z}) solid ${ghostOn ? 'rgba(28,98,212,0.4)' : '#d7dce4'}`,
    background: '#ffffff',
    ...font(10.5),
    color: ghostOn ? ACCENT : '#586170',
    cursor: 'pointer',
  }, fx);
  const chipLabel = `Show text left out (${leftOut} word${leftOut === 1 ? '' : 's'})`;
  chip.title = chipLabel;
  mk({
    position: 'relative',
    width: `calc(10px / ${Z})`,
    height: `calc(10px / ${Z})`,
    borderRadius: `calc(3px / ${Z})`,
    border: `calc(1.5px / ${Z}) solid ${ghostOn ? ACCENT : '#98a1b0'}`,
    background: ghostOn ? ACCENT : 'transparent',
    flex: 'none',
  }, chip);
  chip.appendChild(document.createTextNode(chipLabel));
  chip.addEventListener('click', () => {
    viewer.state.tablePreviewGhost = !viewer.state.tablePreviewGhost;
    applyTablePreview(viewer, n);
  });

  if (stripH > 0) {
    const strip = mk({
      left: `${tc.left}px`,
      top: `calc(${tc.top}px - ${stripH + 1}px / ${Z})`,
      width: `${tc.right - tc.left}px`,
      height: `calc(${stripH}px / ${Z})`,
      background: '#e8f0fd',
      color: ACCENT,
      display: 'flex',
      alignItems: 'center',
      gap: `calc(8px / ${Z})`,
      padding: `0 calc(4px / ${Z}) 0 calc(8px / ${Z})`,
      ...font(9, 600),
      letterSpacing: '.03em',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      zIndex: '3',
    });
    const nameSpan = document.createElement('span');
    nameSpan.style.flex = 'none';
    nameSpan.textContent = `continued \u00b7 ${chainName}`;
    strip.appendChild(nameSpan);
    const act = document.createElement('span');
    act.title = 'Unlink tables';
    act.setAttribute('role', 'button');
    Object.assign(act.style, {
      marginLeft: 'auto',
      minWidth: '0',
      display: 'inline-flex',
      alignItems: 'center',
      gap: `calc(4px / ${Z})`,
      padding: `calc(1px / ${Z}) calc(6px / ${Z})`,
      borderRadius: `calc(4px / ${Z})`,
      fontWeight: '650',
      cursor: 'pointer',
      overflow: 'hidden',
    });
    act.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="width:calc(10px / ${Z});height:calc(10px / ${Z});flex:none;display:block;"><path d="M10 14a4.2 4.2 0 0 0 6 0l3-3a4.24 4.24 0 0 0-6-6l-1.7 1.7"/><path d="M14 10a4.2 4.2 0 0 0-6 0l-3 3a4.24 4.24 0 0 0 6 6l1.7-1.7"/><path d="M4 4l16 16" stroke-width="1.9"/></svg><span style="overflow:hidden;text-overflow:ellipsis;">Unlink from page ${activeChain[fragIdx - 1].n + 1}</span>`;
    act.addEventListener('pointerenter', () => { act.style.background = 'rgba(28, 98, 212, .12)'; });
    act.addEventListener('pointerleave', () => { act.style.background = ''; });
    act.addEventListener('click', (e) => {
      e.stopPropagation();
      unlinkTable(viewer, pageFrag.table);
    });
    strip.appendChild(act);
  }
  const colRail = mk({
    left: '0',
    // The floor is the clamped cell bar's own bottom edge, or a table near the page top slides the rail under that bar, whose higher z-index then swallows clicks on the column letters.
    top: `max(calc(30px / ${Z}), calc(${tc.top}px - ${17 + stripH}px / ${Z}))`,
    width: `${dims.width}px`,
    height: `calc(16px / ${Z})`,
    background: '#eef1f6',
    borderBottom: `calc(1px / ${Z}) solid #d7dce4`,
    zIndex: '3',
    overflow: 'hidden',
  });
  columns.forEach((col, c) => {
    const cell = mk({
      position: 'absolute',
      left: `${col.coords.left}px`,
      width: `${col.coords.right - col.coords.left}px`,
      top: '0',
      bottom: '0',
      display: 'grid',
      placeItems: 'center',
      borderRight: `calc(1px / ${Z}) solid #d7dce4`,
      ...font(10),
      color: '#586170',
    }, colRail);
    cell.dataset.scribeTpCol = String(c);
    cell.textContent = colLetter(c);
  });
  const rowRail = mk({
    left: '0',
    top: '0',
    width: `calc(22px / ${Z})`,
    height: `${dims.height}px`,
    background: '#eef1f6',
    borderRight: `calc(1px / ${Z}) solid #d7dce4`,
    zIndex: '2',
    overflow: 'hidden',
  });
  for (let r = 0; r < content.rowBottomArr.length; r++) {
    const cell = mk({
      position: 'absolute',
      left: '0',
      right: '0',
      top: `${bandEdges[r]}px`,
      height: `${bandEdges[r + 1] - bandEdges[r]}px`,
      display: 'grid',
      placeItems: 'center',
      borderBottom: `calc(1px / ${Z}) solid #d7dce4`,
      ...font(9.5),
      color: '#586170',
    }, rowRail);
    cell.dataset.scribeTpRow = String(r);
    cell.textContent = rowNum(r);
    if (dedupRow0 && r === 0) cell.style.textDecoration = 'none';
  }

  if (dedupRow0) {
    const row0Ids = new Set(content.rowWordArr[0].flat().map((w) => w.id));
    for (const obj of viewer._wordObjs?.[n] || []) {
      if (row0Ids.has(obj.word.id)) obj.fill('#a5a9b0');
    }
    mk({
      left: `${tc.left}px`,
      top: `${(bandEdges[0] + bandEdges[1]) / 2}px`,
      width: `${tc.right - tc.left}px`,
      height: `calc(1.2px / ${Z})`,
      background: '#a5a9b0',
      pointerEvents: 'none',
      zIndex: '1',
    });
  }

  const rowN = content.rowBottomArr.length;
  if (!viewer._tpSel || viewer._tpSel.id !== sheet.layoutDataTable.id
    || Math.max(viewer._tpSel.r, viewer._tpSel.r2) >= rowN || Math.max(viewer._tpSel.c, viewer._tpSel.c2) >= columns.length) {
    viewer._tpSel = {
      id: sheet.layoutDataTable.id, r: 0, c: 0, r2: 0, c2: 0,
    };
  }
  const rangeBox = mk({
    boxShadow: `inset 0 0 0 calc(2px / ${Z}) ${ACCENT}`, background: 'rgba(28,98,212,0.10)', pointerEvents: 'none', zIndex: '2',
  });
  rangeBox.dataset.scribeTpRange = '1';
  const selBox = mk({
    boxShadow: `inset 0 0 0 calc(2px / ${Z}) ${ACCENT}`, pointerEvents: 'none', zIndex: '2',
  });
  const setSel = (r, c, r2 = r, c2 = c) => {
    viewer._tpSel = {
      id: sheet.layoutDataTable.id, r, c, r2, c2,
    };
    const rLo = Math.min(r, r2); const rHi = Math.max(r, r2);
    const cLo = Math.min(c, c2); const cHi = Math.max(c, c2);
    const single = rLo === rHi && cLo === cHi;
    Object.assign(selBox.style, {
      display: single ? '' : 'none',
      left: `${columns[c].coords.left}px`,
      top: `${bandEdges[r]}px`,
      width: `${columns[c].coords.right - columns[c].coords.left}px`,
      height: `${bandEdges[r + 1] - bandEdges[r]}px`,
    });
    Object.assign(rangeBox.style, {
      display: single ? 'none' : '',
      left: `${columns[cLo].coords.left}px`,
      top: `${bandEdges[rLo]}px`,
      width: `${columns[cHi].coords.right - columns[cLo].coords.left}px`,
      height: `${bandEdges[rHi + 1] - bandEdges[rLo]}px`,
    });
    nameBox.textContent = single ? `${colLetter(c)}${rowNum(r)}` : `${colLetter(cLo)}${rowNum(rLo)}:${colLetter(cHi)}${rowNum(rHi)}`;
    const text = (content.rowWordArr[r]?.[c] || []).map((w) => w.text).join(' ');
    fxVal.textContent = text;
    fxVal.title = text;
    colRail.querySelectorAll('[data-scribe-tp-col]').forEach((el) => {
      const i = Number(el.dataset.scribeTpCol);
      const on = i >= cLo && i <= cHi;
      el.style.background = on ? '#e8f0fd' : '';
      el.style.color = on ? ACCENT : '#586170';
    });
    rowRail.querySelectorAll('[data-scribe-tp-row]').forEach((el) => {
      const i = Number(el.dataset.scribeTpRow);
      const on = i >= rLo && i <= rHi;
      el.style.background = on ? '#e8f0fd' : '';
      el.style.color = on ? ACCENT : '#586170';
    });
  };
  // A press on another table sets this anchor before the re-render that replaces the pressed element, so seeding from it carries that one sweep through.
  const pending = viewer._tpDragAnchor;
  const seeded = pending && pending.id === sheet.layoutDataTable.id
    && pending.r < rowN && pending.c < columns.length ? { r: pending.r, c: pending.c } : null;
  const dragSel = { anchor: /** @type {?{r: number, c: number}} */ (seeded) };
  if (seeded) document.addEventListener('pointerup', () => { dragSel.anchor = null; }, { once: true });
  for (let r = 0; r < rowN; r++) {
    for (let c = 0; c < columns.length; c++) {
      const hit = mk({
        left: `${columns[c].coords.left}px`,
        top: `${bandEdges[r]}px`,
        width: `${columns[c].coords.right - columns[c].coords.left}px`,
        height: `${bandEdges[r + 1] - bandEdges[r]}px`,
        zIndex: '2',
        cursor: 'cell',
      });
      hit.dataset.scribeTpCell = `${r},${c}`;
      hit.addEventListener('pointerenter', () => {
        if (dragSel.anchor) {
          if (!dragSel.anchor.header) setSel(dragSel.anchor.r, dragSel.anchor.c, r, c);
          return;
        }
        hit.style.background = 'rgba(28,42,68,0.05)';
      });
      hit.addEventListener('pointerleave', () => { hit.style.background = ''; });
      hit.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (e.shiftKey) { setSel(viewer._tpSel.r, viewer._tpSel.c, r, c); return; }
        dragSel.anchor = { r, c };
        setSel(r, c);
        document.addEventListener('pointerup', () => { dragSel.anchor = null; }, { once: true });
      });
      // A drag that releases on another cell fires its click on the common ancestor, not a cell, so this collapse never undoes a just-drawn range.
      // It stays alongside pointerdown for synthetic `el.click()` callers.
      hit.addEventListener('click', (e) => {
        if (e.shiftKey) { setSel(viewer._tpSel.r, viewer._tpSel.c, r, c); return; }
        setSel(r, c);
      });
    }
  }
  colRail.querySelectorAll('[data-scribe-tp-col]').forEach((el) => {
    const c = Number(el.dataset.scribeTpCol);
    el.style.cursor = 'pointer';
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.shiftKey) { setSel(0, viewer._tpSel.c, rowN - 1, c); return; }
      dragSel.anchor = { r: 0, c, header: 'col' };
      setSel(0, c, rowN - 1, c);
      document.addEventListener('pointerup', () => { dragSel.anchor = null; }, { once: true });
    });
    el.addEventListener('pointerenter', () => {
      if (dragSel.anchor?.header === 'col') setSel(0, dragSel.anchor.c, rowN - 1, c);
    });
  });
  rowRail.querySelectorAll('[data-scribe-tp-row]').forEach((el) => {
    const r = Number(el.dataset.scribeTpRow);
    el.style.cursor = 'pointer';
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.shiftKey) { setSel(viewer._tpSel.r, 0, r, columns.length - 1); return; }
      dragSel.anchor = { r, c: 0, header: 'row' };
      setSel(r, 0, r, columns.length - 1);
      document.addEventListener('pointerup', () => { dragSel.anchor = null; }, { once: true });
    });
    el.addEventListener('pointerenter', () => {
      if (dragSel.anchor?.header === 'row') setSel(dragSel.anchor.r, 0, r, columns.length - 1);
    });
  });

  setSel(viewer._tpSel.r, viewer._tpSel.c, viewer._tpSel.r2, viewer._tpSel.c2);
}

/**
 * Copy the preview's selected cell range to the clipboard as tab-separated text.
 * Returns the copied text, or null when there is nothing to copy.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @returns {?string}
 */
export function copyTablePreviewSelection(viewer) {
  if (!viewer.state.tablePreview) return null;
  const sel = viewer._tpSel;
  if (!sel) return null;
  const uiTable = viewer.getUiDataTables().find((t) => t.layoutDataTable.id === sel.id);
  const content = uiTable?.tableContent;
  if (!content) return null;
  const rLo = Math.min(sel.r, sel.r2); const rHi = Math.max(sel.r, sel.r2);
  const cLo = Math.min(sel.c, sel.c2); const cHi = Math.max(sel.c, sel.c2);
  const lines = [];
  for (let r = rLo; r <= rHi; r++) {
    const row = [];
    for (let c = cLo; c <= cHi; c++) row.push((content.rowWordArr[r]?.[c] || []).map((w) => w.text).join(' '));
    lines.push(row.join('\t'));
  }
  const tsv = lines.join('\n');
  navigator.clipboard?.writeText(tsv).catch(() => {});

  // Where animations never run, the base opacity of 0 keeps the flash invisible and the timeout still reaps the node.
  const group = viewer._overlayGroups?.[uiTable.layoutDataTable.page.n];
  const bandEdges = [uiTable.coords.top, ...content.rowBottomArr];
  const columns = uiTable.layoutBoxesArr;
  if (group && rHi < content.rowBottomArr.length && cHi < columns.length) {
    const flash = document.createElement('div');
    flash.dataset.scribeTp = '1';
    flash.dataset.scribeTpFlash = '1';
    Object.assign(flash.style, {
      position: 'absolute',
      boxSizing: 'border-box',
      left: `${columns[cLo].coords.left}px`,
      top: `${bandEdges[rLo]}px`,
      width: `${columns[cHi].coords.right - columns[cLo].coords.left}px`,
      height: `${bandEdges[rHi + 1] - bandEdges[rLo]}px`,
      background: '#1c62d4',
      opacity: '0',
      pointerEvents: 'none',
      zIndex: '3',
    });
    flash.classList.add('scribe-tp-flash');
    flash.addEventListener('animationend', () => flash.remove());
    setTimeout(() => flash.remove(), 1000);
    group.appendChild(flash);
  }
  return tsv;
}

/**
 * Grow the preview's cell selection to the whole active table, the Ctrl/Cmd+A spreadsheet convention.
 * Returns false when there is nothing to grow, so the caller can leave the key to the browser.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @returns {boolean}
 */
export function selectAllTablePreviewCells(viewer) {
  if (!viewer.state.tablePreview) return false;
  const sel = viewer._tpSel;
  if (!sel) return false;
  const uiTable = viewer.getUiDataTables().find((t) => t.layoutDataTable.id === sel.id);
  const content = uiTable?.tableContent;
  if (!content || content.rowBottomArr.length === 0) return false;
  viewer._tpSel = {
    id: sel.id, r: 0, c: 0, r2: content.rowBottomArr.length - 1, c2: uiTable.layoutBoxesArr.length - 1,
  };
  applyTablePreview(viewer, uiTable.layoutDataTable.page.n);
  return true;
}

/**
 * Move the preview's cell selection by one step, the arrow-key spreadsheet convention.
 * Returns false when there is nothing to move, so the caller can leave the key to the browser.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} dr - Row step (-1, 0, or 1).
 * @param {number} dc - Column step (-1, 0, or 1).
 * @param {boolean} extend - True for Shift+arrow range extension.
 * @returns {boolean}
 */
export function moveTablePreviewSelection(viewer, dr, dc, extend) {
  if (!viewer.state.tablePreview) return false;
  const sel = viewer._tpSel;
  if (!sel) return false;
  const uiTable = viewer.getUiDataTables().find((t) => t.layoutDataTable.id === sel.id);
  const content = uiTable?.tableContent;
  if (!content || content.rowBottomArr.length === 0) return false;
  const clampR = (v) => Math.min(content.rowBottomArr.length - 1, Math.max(0, v));
  const clampC = (v) => Math.min(uiTable.layoutBoxesArr.length - 1, Math.max(0, v));
  if (extend) {
    viewer._tpSel = {
      id: sel.id, r: sel.r, c: sel.c, r2: clampR(sel.r2 + dr), c2: clampC(sel.c2 + dc),
    };
  } else {
    const r = clampR(sel.r + dr);
    const c = clampC(sel.c + dc);
    viewer._tpSel = {
      id: sel.id, r, c, r2: r, c2: c,
    };
  }
  const n = uiTable.layoutDataTable.page.n;
  applyTablePreview(viewer, n);
  const focus = viewer._tpSel;
  viewer._overlayGroups?.[n]?.querySelector(`[data-scribe-tp-cell="${extend ? focus.r2 : focus.r},${extend ? focus.c2 : focus.c}"]`)
    ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return true;
}
