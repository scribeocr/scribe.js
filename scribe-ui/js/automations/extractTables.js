import scribe from '../../../scribe.js';
import { pulseTable } from '../viewerLayout.js';

const lineIcon = (inner) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'
  + ` style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true">${inner}</svg>`;
const INFO_SVG = lineIcon('<circle cx="12" cy="12" r="8"/><path d="M12 11v5M12 8v.01"/>');
const SPIN_SVG = lineIcon('<path d="M12 4.5a7.5 7.5 0 1 0 7.5 7.5"/>');

/**
 * One icon-plus-text note block.
 * @param {string} svg
 * @param {string} text
 */
function noteBlock(svg, text) {
  const note = document.createElement('div');
  note.className = 'scribe-am-note';
  const ic = document.createElement('span');
  ic.className = 'scribe-am-note-ic';
  ic.innerHTML = svg;
  const tx = document.createElement('span');
  tx.textContent = text;
  note.append(ic, tx);
  return note;
}

/**
 * Parse a 1-based page-range string ("1-2, 4") into sorted unique 0-based indices, or null when invalid.
 * @param {string} text
 * @param {number} pageCount
 */
function parsePageRange(text, pageCount) {
  const indices = new Set();
  for (const part of text.split(',')) {
    const piece = part.trim();
    if (!piece) continue;
    const m = piece.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) return null;
    const start = parseInt(m[1]);
    const end = m[2] ? parseInt(m[2]) : start;
    if (start < 1 || end < start) return null;
    for (let n = start; n <= Math.min(end, pageCount); n++) indices.add(n - 1);
  }
  return indices.size ? [...indices].sort((a, b) => a - b) : null;
}

const CHEV_SVG = lineIcon('<path d="M6 9.5 12 15.5 18 9.5"/>');
const CHECK_SVG = lineIcon('<path d="M5 12.5l4.5 4.5L19 7.5"/>');
const FLAG_SVG = lineIcon('<path d="M6 21V4.5"/><path d="M6 5h11l-2.5 3.5L17 12H6z"/>');

/**
 * The export options: which pages to take, and how to lay them out as worksheets.
 * @param {import('./registry.js').AutomationHost} host
 * @param {() => void} onChange - Fires on any option change.
 */
function buildOptions(host, onChange) {
  const elem = document.createElement('div');
  elem.className = 'scribe-am-form';

  const groupLabel = (text) => {
    const el = document.createElement('div');
    el.className = 'scribe-am-label';
    el.textContent = text;
    return el;
  };
  const makeRadio = (name, text, checked) => {
    const lab = document.createElement('label');
    lab.className = 'scribe-am-check';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.checked = checked;
    input.addEventListener('change', onChange);
    lab.append(input, document.createTextNode(text));
    return { lab, input };
  };

  elem.appendChild(groupLabel('Pages'));
  const pagesRow = document.createElement('div');
  pagesRow.className = 'scribe-am-opts';
  const allPages = makeRadio('scribe-am-xt-pages', 'All pages', true);
  const currentPage = makeRadio('scribe-am-xt-pages', 'Current page', false);
  const rangePages = makeRadio('scribe-am-xt-pages', 'Range', false);
  pagesRow.append(allPages.lab, currentPage.lab, rangePages.lab);
  elem.appendChild(pagesRow);
  const rangeInput = document.createElement('input');
  rangeInput.type = 'text';
  rangeInput.className = 'scribe-am-input';
  rangeInput.placeholder = 'e.g. 1-2, 4';
  rangeInput.style.display = 'none';
  rangeInput.addEventListener('input', onChange);
  elem.appendChild(rangeInput);
  for (const radio of [allPages, currentPage, rangePages]) {
    radio.input.addEventListener('change', () => {
      rangeInput.style.display = rangePages.input.checked ? '' : 'none';
      if (rangePages.input.checked) rangeInput.focus();
    });
  }

  elem.appendChild(groupLabel('Workbook'));
  const workbookRow = document.createElement('div');
  workbookRow.className = 'scribe-am-opts';
  const perTable = makeRadio('scribe-am-xt-workbook', 'One sheet per table', true);
  const flatSheet = makeRadio('scribe-am-xt-workbook', 'Single flat sheet', false);
  workbookRow.append(perTable.lab, flatSheet.lab);
  elem.appendChild(workbookRow);
  const workbookHint = document.createElement('div');
  workbookHint.className = 'scribe-am-boost-hint';
  workbookHint.textContent = 'Sheets named from table titles when found, else \u201cPage N Table M\u201d.';
  elem.appendChild(workbookHint);

  return {
    elem,
    summarize: () => {
      let pagesPart = 'All pages';
      if (currentPage.input.checked) pagesPart = 'Current page';
      else if (rangePages.input.checked) pagesPart = rangeInput.value.trim() ? `Pages ${rangeInput.value.trim()}` : 'Range \u2014 set pages';
      const wbPart = flatSheet.input.checked ? 'single flat sheet' : 'one sheet per table';
      return `${pagesPart} \u00b7 ${wbPart}`;
    },
    getParams: () => {
      /** @type {?Array<number>} null = all pages. */
      let pageIndices = null;
      if (currentPage.input.checked) {
        pageIndices = [host.viewer.state.cp.n];
      } else if (rangePages.input.checked) {
        pageIndices = parsePageRange(rangeInput.value, host.viewer.doc.pageMetrics.length);
        if (!pageIndices) { rangeInput.focus(); return null; }
      }
      return { pageIndices, flat: flatSheet.input.checked };
    },
  };
}

/**
 * The tables workspace the Automate panel shows while the Extract Tables mode is active.
 * @param {import('./registry.js').AutomationHost} host
 * @param {HTMLElement} container
 * @returns {{refresh: () => void}}
 */
export function buildTablesWorkspace(host, container) {
  const viewer = host.viewer;
  // `viewer.doc` changes on a tab switch, so everything except the settle wiring below reads it live.
  const doc = viewer.doc;

  const noteText = () => {
    let tables = 0;
    let pages = 0;
    for (const page of viewer.doc.layoutDataTables.pages) {
      if (page.tables.length === 0) continue;
      tables += page.tables.length;
      pages += 1;
    }
    if (tables === 0) return 'No tables detected in this document.';
    return `${tables} table${tables === 1 ? '' : 's'} on ${pages} page${pages === 1 ? '' : 's'} \u2014 click a table to review it on the page; drag its lines to fix it.`;
  };
  let note;
  if (doc._textReadySettle) {
    note = noteBlock(SPIN_SVG, 'Detecting tables\u2026');
    note.querySelector('.scribe-am-note-ic').style.color = 'var(--scribe-accent)';
    doc.textReady.then(() => {
      if (viewer.doc !== doc || !note.isConnected) return;
      const settled = noteBlock(INFO_SVG, noteText());
      note.replaceWith(settled);
      note = settled;
    }).catch(() => {});
  } else {
    note = noteBlock(INFO_SVG, noteText());
  }
  container.appendChild(note);

  const listElem = document.createElement('div');
  listElem.className = 'scribe-am-xtlist';
  container.appendChild(listElem);

  /** @type {?string} */
  let selectedId = null;

  const tableEntries = () => {
    const out = [];
    for (const page of viewer.doc.layoutDataTables.pages) {
      page.tables.forEach((table, idx) => out.push({ table, n: page.n, m: idx + 1 }));
    }
    return out;
  };

  const renderList = () => {
    listElem.textContent = '';
    const entries = tableEntries();
    entries.forEach((e) => {
      const row = document.createElement('div');
      row.className = `scribe-am-xtrow${e.table.id === selectedId ? ' sel' : ''}`;
      row.tabIndex = 0;
      const tx = document.createElement('span');
      tx.className = 'scribe-am-xtrow-tx';
      // This fallback has to match the sheet name `run` writes.
      const name = e.table.title?.text || `Page ${e.n + 1} Table ${e.m}`;
      const meta = e.table.title?.text ? ` \u00b7 Page ${e.n + 1}` : '';
      tx.textContent = `${name}${meta} \u00b7 ${e.table.boxes.length} column${e.table.boxes.length === 1 ? '' : 's'}`;
      tx.title = tx.textContent;
      row.appendChild(tx);
      const select = async () => {
        selectedId = e.table.id;
        viewer.state.activeTableId = e.table.id;
        renderList();
        // Refreshed, so the overlays restyle for the new active table even when the page is already rendered.
        await viewer.displayPage(e.n, true, true);
        if (!viewer.state.tablePreview) pulseTable(viewer, e.table);
      };
      row.addEventListener('click', select);
      row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') select(); });
      listElem.appendChild(row);
    });
  };

  const foot = document.createElement('div');
  foot.className = 'scribe-am-xtfoot';
  const receiptSlot = document.createElement('div');
  receiptSlot.style.display = 'none';
  const options = buildOptions(host, () => { sumTx.textContent = options.summarize(); });
  const sum = document.createElement('button');
  sum.type = 'button';
  sum.className = 'scribe-am-xtsum';
  const sumTx = document.createElement('span');
  sumTx.textContent = 'All pages \u00b7 one sheet per table';
  const sumChev = document.createElement('span');
  sumChev.innerHTML = CHEV_SVG;
  sumChev.style.cssText = 'width:11px;height:11px;flex:none;margin-left:auto';
  sum.append(sumTx, sumChev);
  options.elem.style.display = 'none';
  sum.addEventListener('click', () => {
    const open = options.elem.style.display === 'none';
    options.elem.style.display = open ? '' : 'none';
    sum.classList.toggle('open', open);
  });
  const exportRow = document.createElement('div');
  exportRow.className = 'scribe-am-xtexport';
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'scribe-am-run';
  exportBtn.textContent = 'Export workbook';
  exportRow.appendChild(exportBtn);
  foot.append(receiptSlot, sum, options.elem, exportRow);
  container.appendChild(foot);

  /** @type {?{rows: Array<Object>}} */
  let lastOutcome = null;
  let running = false;

  const resultRow = (spec) => {
    const row = document.createElement('div');
    row.className = `scribe-am-result ${spec.kind || 'info'}`;
    const ic = document.createElement('span');
    ic.className = 'scribe-am-result-ic';
    ic.innerHTML = spec.kind === 'flag' ? FLAG_SVG : (spec.kind === 'file' ? CHECK_SVG : INFO_SVG);
    const tx = document.createElement('span');
    tx.className = 'scribe-am-result-tx';
    tx.textContent = spec.text;
    tx.title = spec.text;
    row.append(ic, tx);
    if (spec.action) {
      const act = document.createElement('button');
      act.type = 'button';
      act.className = 'scribe-am-result-act';
      act.textContent = spec.action.label;
      act.addEventListener('click', (e) => { e.stopPropagation(); spec.action.onClick(); });
      row.appendChild(act);
    }
    return row;
  };

  const renderReceipt = () => {
    receiptSlot.textContent = '';
    if (running) {
      receiptSlot.style.display = '';
      const busy = noteBlock(SPIN_SVG, 'Exporting\u2026');
      busy.querySelector('.scribe-am-note-ic').style.color = 'var(--scribe-accent)';
      busy.dataset.xtBusy = '1';
      receiptSlot.appendChild(busy);
      return;
    }
    if (!lastOutcome) { receiptSlot.style.display = 'none'; return; }
    receiptSlot.style.display = '';
    const card = document.createElement('div');
    card.className = 'scribe-am-xtreceipt';
    lastOutcome.rows.forEach((spec, i) => {
      const row = resultRow(spec);
      if (i === 0) {
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'scribe-am-result-act';
        x.textContent = '\u00d7';
        x.title = 'Dismiss';
        if (!spec.action) x.style.marginLeft = 'auto';
        x.addEventListener('click', () => { lastOutcome = null; renderReceipt(); });
        row.appendChild(x);
      }
      card.appendChild(row);
    });
    card.dataset.xtReceipt = '1';
    receiptSlot.appendChild(card);
  };

  exportBtn.addEventListener('click', async () => {
    if (running) return;
    const params = options.getParams();
    if (!params) return;
    running = true;
    exportBtn.disabled = true;
    renderReceipt();
    const caption = (text) => {
      const busy = receiptSlot.querySelector('[data-xt-busy] span:last-child');
      if (busy && text) busy.textContent = text;
    };
    try {
      const outcome = await run(host, params, (frac, text) => caption(text));
      lastOutcome = { rows: outcome.rows || [] };
    } catch (err) {
      console.error('The table export failed:', err);
      lastOutcome = { rows: [{ kind: 'flag', text: 'The export failed \u2014 nothing was written.' }] };
    }
    running = false;
    exportBtn.disabled = false;
    renderReceipt();
  });

  selectedId = tableEntries()[0]?.table.id ?? null;
  renderList();

  return {
    refresh: () => {
      const entries = tableEntries();
      const activeId = viewer.state.activeTableId;
      if (activeId && entries.some((e) => e.table.id === activeId)) selectedId = activeId;
      else if (activeId) viewer.state.activeTableId = null;
      // Undo and redo install clones, so the selection has to re-resolve by id rather than by identity.
      if (!selectedId || !entries.some((e) => e.table.id === selectedId)) selectedId = entries[0]?.table.id ?? null;
      renderList();
      if (!viewer.doc._textReadySettle && note.isConnected) {
        const settled = noteBlock(INFO_SVG, noteText());
        note.replaceWith(settled);
        note = settled;
      }
    },
  };
}

/**
 * @param {import('./registry.js').AutomationHost} host
 * @param {{pageIndices: ?Array<number>, flat: boolean}} params - null `pageIndices` = all pages.
 * @param {(frac: number, caption: string) => void} progress
 * @returns {Promise<import('./registry.js').AutomationOutcome>}
 */
export async function run(host, params, progress) {
  const doc = host.viewer.doc;
  // A freshly-opened native PDF installs its detected tables only once text extraction settles.
  if (doc._textReadySettle) {
    progress(0, 'Waiting for text extraction…');
    await doc.textReady;
    if (host.viewer.doc !== doc) return { rows: [{ kind: 'info', text: 'The document changed before the run started.' }] };
  }

  const scope = (params?.pageIndices ?? doc.layoutDataTables.pages.map((_, i) => i))
    .filter((n) => n >= 0 && n < doc.layoutDataTables.pages.length);

  /** @type {Array<{name: string, rows: Array<Array<string>>}>} */
  const harvested = [];
  for (let i = 0; i < scope.length; i++) {
    const n = scope[i];
    progress((i + 1) / (scope.length + 1), `Extracting page ${n + 1}…`);
    const layoutPage = doc.layoutDataTables.pages[n];
    const extracted = scribe.extractTextFromTables(doc.ocr.active[n], layoutPage);
    extracted.forEach((table, idx) => {
      harvested.push({
        name: layoutPage.tables[idx].title?.text || `Page ${n + 1} Table ${idx + 1}`,
        rows: table.rows,
      });
    });
    if (i % 10 === 9) await new Promise((resolve) => { setTimeout(resolve, 0); });
  }

  if (harvested.length === 0) {
    return { rows: [{ kind: 'info', text: 'No tables found on the selected pages' }] };
  }

  progress(1, 'Writing spreadsheet…');
  const sheets = params?.flat
    ? [{ name: 'Tables', rows: harvested.flatMap((t) => t.rows) }]
    : harvested.map((t) => ({ name: t.name, rows: t.rows }));
  const bytes = await scribe.utils.writeXlsxFromSheets(sheets, { columnWidths: 'auto' });
  const fileName = `${host.app._baseName().replace(/\.\w{1,6}$/, '')}-tables.xlsx`;
  await scribe.utils.saveAs(bytes, fileName);

  /** @type {Array<import('./registry.js').AutomationOutcomeRow>} */
  const rows = [{
    kind: 'file',
    text: `${fileName} · ${sheets.length} sheet${sheets.length === 1 ? '' : 's'}`,
    action: { label: 'Download again', onClick: () => scribe.utils.saveAs(bytes, fileName) },
  }];
  progress(1, '');
  return { rows };
}
