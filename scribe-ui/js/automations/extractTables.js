import scribe from '../../../scribe.js';
import {
  pulseTable, linkTables, linkTableSet, unlinkTable, unlinkTableSet, unlinkChain,
} from '../viewerLayout.js';

/** @typedef {import('../../../js/extractTables.js').TableCellRich} TableCellRich */
/** @typedef {import('../../../js/export/writeTabular.js').XlsxTableRange} XlsxTableRange */

const lineIcon = (inner) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'
  + ` style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true">${inner}</svg>`;
const INFO_SVG = lineIcon('<circle cx="12" cy="12" r="8"/><path d="M12 11v5M12 8v.01"/>');
const SPIN_SVG = lineIcon('<path d="M12 4.5a7.5 7.5 0 1 0 7.5 7.5"/>');
// The conventional interlocked-diagonal chain glyph smudges at the 12-16px these render at.
const LINK_SVG = lineIcon('<path d="M14.5 7.5H17a4.5 4.5 0 0 1 0 9h-2.5" stroke-width="2"/>'
  + '<path d="M9.5 16.5H7a4.5 4.5 0 0 1 0-9h2.5" stroke-width="2"/><path d="M8.5 12h7" stroke-width="2"/>');
const UNLINK_SVG = lineIcon('<path d="M14.5 7.5H17a4.5 4.5 0 0 1 0 9h-2.5" stroke-width="2"/>'
  + '<path d="M9.5 16.5H7a4.5 4.5 0 0 1 0-9h2.5" stroke-width="2"/><path d="M5 5l14 14" stroke-width="2"/>');
const CHEV_R_SVG = lineIcon('<path d="M9 6l6 6-6 6"/>');
const CHECK_MINI_SVG = lineIcon('<path d="M4.5 12.5 10 18 19.5 7"/>');
const X_MINI_SVG = lineIcon('<path d="M6 6l12 12M18 6 6 18"/>');

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
  workbookHint.textContent = 'Sheets named from table titles when found, else \u201cPage N Table M\u201d (\u201cPages A\u2013B Table M\u201d across pages).';
  elem.appendChild(workbookHint);

  elem.appendChild(groupLabel('Formatting'));
  const formattingRow = document.createElement('div');
  formattingRow.className = 'scribe-am-opts';
  const formattingLab = document.createElement('label');
  formattingLab.className = 'scribe-am-check';
  const formattingInput = document.createElement('input');
  formattingInput.type = 'checkbox';
  // This reads and writes viewer state rather than local state so the Preview Export view always shows what the export will write.
  formattingInput.checked = host.viewer.state.tablePreviewFormatting !== false;
  formattingInput.addEventListener('change', () => {
    host.viewer.state.tablePreviewFormatting = formattingInput.checked;
    if (host.viewer.state.tablePreview) {
      host.viewer.destroyText(false);
      host.viewer.displayPage(host.viewer.state.cp.n, false, true);
    }
  });
  formattingInput.addEventListener('change', onChange);
  formattingLab.append(formattingInput, document.createTextNode('Preserve source formatting'));
  formattingRow.appendChild(formattingLab);
  elem.appendChild(formattingRow);
  const formattingHint = document.createElement('div');
  formattingHint.className = 'scribe-am-boost-hint';
  formattingHint.textContent = 'Carries bold/italic, fonts, sizes, colors, and cell borders into the workbook. Off = plain cells with bold, underlined headers.';
  elem.appendChild(formattingHint);

  return {
    elem,
    summarize: () => {
      let pagesPart = 'All pages';
      if (currentPage.input.checked) pagesPart = 'Current page';
      else if (rangePages.input.checked) pagesPart = rangeInput.value.trim() ? `Pages ${rangeInput.value.trim()}` : 'Range \u2014 set pages';
      const wbPart = flatSheet.input.checked ? 'single flat sheet' : 'one sheet per table';
      const sheets = flatSheet.input.checked ? 1 : scribe.tableChains(host.viewer.doc.layoutDataTables.pages).length;
      const fmtPart = formattingInput.checked ? '' : ' \u00b7 plain';
      return `${pagesPart} \u00b7 ${wbPart}${sheets > 0 ? ` \u00b7 ${sheets} sheet${sheets === 1 ? '' : 's'}` : ''}${fmtPart}`;
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
      return { pageIndices, flat: flatSheet.input.checked, formatting: formattingInput.checked };
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
    const chains = scribe.tableChains(viewer.doc.layoutDataTables.pages);
    if (chains.length === 0) return 'No tables detected in this document.';
    const spanning = chains.filter((c) => c.length > 1);
    const count = `${chains.length} table${chains.length === 1 ? '' : 's'}`;
    let spanPart = '';
    if (spanning.length === 1) {
      const c = spanning[0];
      spanPart = ` (one across pages ${c[0].n + 1}\u2013${c[c.length - 1].n + 1})`;
    } else if (spanning.length > 1) {
      spanPart = ` (${spanning.length} span multiple pages)`;
    }
    return `${count}${spanPart} \u2014 click a table to review it on the page; drag its lines to fix it.`;
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
  /** Chain head ids whose per-fragment sub-rows are open. */
  const expanded = new Set();

  /** The user's row selection, keyed `c:<id>` for a whole chain, `p:<id>` for one page fragment, `s:<id>` for a suggestion. */
  const multiSel = new Set();
  let rowKeys = [];
  /** @type {?string} */
  let multiAnchor = null;

  /**
   * The single action the current selection resolves to, or null when it resolves to none.
   * The selection combines while any page break inside it is unlinked, and separates only once it is fully linked.
   * A selected suggestion contributes its own page break, so it joins the combine side even when the selection skips pages.
   * @returns {?{kind: ('combine'|'separate'), targets: Array<LayoutDataTable>, label: string, ids: Array<string>}}
   */
  const resolveSelection = () => {
    const chains = scribe.tableChains(viewer.doc.layoutDataTables.pages);
    const docFrags = chains.flat();
    const pos = new Map(docFrags.map((f, i) => [f.table.id, i]));
    const chainOf = new Map();
    chains.forEach((c) => c.forEach((f) => chainOf.set(f.table.id, c)));
    const selIds = new Set();
    const sugIds = new Set();
    for (const k of multiSel) {
      const id = k.slice(2);
      if (k[0] === 'c') (chainOf.get(id) || []).forEach((f) => selIds.add(f.table.id));
      else if (k[0] === 's') sugIds.add(id);
      else if (pos.has(id)) selIds.add(id);
    }
    const sugTargets = (viewer.doc.tableLinkSuggestions || [])
      .filter((s) => sugIds.has(s.tableId))
      .map((s) => docFrags[pos.get(s.tableId) ?? -1])
      .filter((f) => f && !f.table.continuesPrev && pos.get(f.table.id) > 0);
    const S = docFrags.filter((f) => selIds.has(f.table.id));
    if (S.length < 2 && sugTargets.length === 0) return null;
    let skipped = false;
    const linkTargets = [];
    const unlinkTargets = [];
    for (let i = 1; i < S.length; i++) {
      if (pos.get(S[i].table.id) !== pos.get(S[i - 1].table.id) + 1) { skipped = true; continue; }
      if (chainOf.get(S[i].table.id) === chainOf.get(S[i - 1].table.id)) unlinkTargets.push(S[i]);
      else linkTargets.push(S[i]);
    }
    const combine = [...(skipped ? [] : linkTargets), ...sugTargets.filter((f) => !linkTargets.includes(f))];
    if (combine.length > 0) {
      const parent = new Map();
      const find = (c) => { let x = c; while (parent.get(x) !== x) x = parent.get(x); return x; };
      for (const f of combine) {
        const a = chainOf.get(f.table.id);
        const b = chainOf.get(docFrags[pos.get(f.table.id) - 1].table.id);
        if (!parent.has(a)) parent.set(a, a);
        if (!parent.has(b)) parent.set(b, b);
        parent.set(find(a), find(b));
      }
      const groups = new Set([...parent.keys()].map(find)).size;
      const ids = [...new Set([...selIds, ...combine.flatMap((f) => [f.table.id, docFrags[pos.get(f.table.id) - 1].table.id])])];
      const label = groups === 1 ? `Make one table (${parent.size} → 1)` : `Link tables (${parent.size} → ${groups})`;
      return {
        kind: 'combine', targets: combine.map((f) => f.table), label, ids,
      };
    }
    if (unlinkTargets.length > 0) {
      const touched = new Set(S.map((f) => chainOf.get(f.table.id))).size;
      return {
        kind: 'separate', targets: unlinkTargets.map((f) => f.table), label: `Separate into ${touched + unlinkTargets.length} tables`, ids: [...selIds],
      };
    }
    return null;
  };

  const applySelection = () => {
    const r = resolveSelection();
    if (!r) return;
    if (r.kind === 'combine') linkTableSet(viewer, r.targets);
    else unlinkTableSet(viewer, r.targets);
    // The result stays selected, so the same control offers the inverse on the next press.
    multiSel.clear();
    for (const chain of scribe.tableChains(viewer.doc.layoutDataTables.pages)) {
      if (chain.some((f) => r.ids.includes(f.table.id))) multiSel.add(`c:${chain[0].table.id}`);
    }
    renderList();
  };

  /**
   * Extend the selection to the contiguous run between the anchor row and `key`, replacing it.
   * Selections are always contiguous runs, since a table only ever links to the previous tabled page.
   */
  const extendRange = (key) => {
    const anchor = multiAnchor && rowKeys.includes(multiAnchor) ? multiAnchor : key;
    const i1 = rowKeys.indexOf(anchor);
    const i2 = rowKeys.indexOf(key);
    multiSel.clear();
    for (let i = Math.min(i1, i2); i <= Math.max(i1, i2); i++) multiSel.add(rowKeys[i]);
    multiAnchor = anchor;
    renderList();
  };

  let sweep = null;
  let sweepConsumeClick = false;
  const endSweep = () => {
    if (!sweep) return;
    document.removeEventListener('pointerup', endSweep, true);
    document.removeEventListener('pointercancel', endSweep, true);
    if (sweep.moved) {
      // Without this the click fired on release would collapse the swept range to the row under the pointer.
      sweepConsumeClick = true;
      // A release outside any row fires no click, so the flag must not outlive this tick.
      setTimeout(() => { sweepConsumeClick = false; }, 0);
    }
    sweep = null;
  };
  listElem.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || ev.pointerType === 'touch') return;
    if (ev.target.closest('button, .scribe-am-xtglyph.chev')) return;
    const rowEl = ev.target.closest('[data-row-key]');
    if (!rowEl) return;
    sweep = { startKey: rowEl.dataset.rowKey, lastKey: rowEl.dataset.rowKey, moved: false };
    document.addEventListener('pointerup', endSweep, true);
    document.addEventListener('pointercancel', endSweep, true);
  });
  listElem.addEventListener('pointerover', (ev) => {
    if (!sweep) return;
    const rowEl = ev.target.closest('[data-row-key]');
    if (!rowEl || rowEl.dataset.rowKey === sweep.lastKey) return;
    const i1 = rowKeys.indexOf(sweep.startKey);
    const i2 = rowKeys.indexOf(rowEl.dataset.rowKey);
    if (i1 < 0 || i2 < 0) return;
    sweep.moved = true;
    sweep.lastKey = rowEl.dataset.rowKey;
    multiSel.clear();
    for (let i = Math.min(i1, i2); i <= Math.max(i1, i2); i++) multiSel.add(rowKeys[i]);
    multiAnchor = sweep.startKey;
    renderList();
  });
  listElem.addEventListener('click', (ev) => {
    if (!sweepConsumeClick) return;
    sweepConsumeClick = false;
    ev.stopPropagation();
    ev.preventDefault();
  }, true);

  /** The one-verb action slot a selected table row carries in place of its per-row verbs. */
  const verbAct = (res) => {
    const acts = document.createElement('span');
    acts.className = 'scribe-am-xtsubacts';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'scribe-am-xtsugact';
    b.title = res.label;
    b.innerHTML = res.kind === 'combine' ? LINK_SVG : UNLINK_SVG;
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      applySelection();
    });
    acts.appendChild(b);
    return acts;
  };

  listElem.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || multiSel.size === 0) return;
    // The mode-exit Escape handler skips a press whose default was prevented, so this keeps Esc from also leaving the mode.
    ev.preventDefault();
    ev.stopPropagation();
    multiSel.clear();
    multiAnchor = null;
    renderList();
  });

  const chainEntries = () => scribe.tableChains(viewer.doc.layoutDataTables.pages).map((chain) => {
    const head = chain[0];
    const pageTables = viewer.doc.layoutDataTables.pages[head.n].tables.slice()
      .sort((a, b) => scribe.layout.calcTableBbox(a).top - scribe.layout.calcTableBbox(b).top);
    const m = pageTables.indexOf(head.table) + 1;
    const last = chain[chain.length - 1].n;
    const pagesPart = chain.length > 1 ? `Pages ${head.n + 1}\u2013${last + 1}` : `Page ${head.n + 1}`;
    // This fallback has to match the sheet name `run` writes.
    const name = head.table.title?.text || `${pagesPart} Table ${m}`;
    const meta = head.table.title?.text ? ` \u00b7 ${pagesPart}` : '';
    return {
      chain, head: head.table, n: head.n, name, meta,
    };
  });

  const glyphSpan = (svg, visible, cls = '') => {
    const g = document.createElement('span');
    g.className = `scribe-am-xtglyph${cls ? ` ${cls}` : ''}`;
    g.innerHTML = svg;
    if (!visible) g.style.visibility = 'hidden';
    return g;
  };
  const selectFragment = async (table, n) => {
    selectedId = table.id;
    viewer.state.activeTableId = table.id;
    renderList();
    // Refreshed, so the overlays restyle for the new active table even when the page is already rendered.
    await viewer.displayPage(n, true, true);
    if (!viewer.state.tablePreview) pulseTable(viewer, table);
  };

  const renderList = () => {
    listElem.textContent = '';
    rowKeys = [];
    const res = resolveSelection();
    const entries = chainEntries();
    entries.forEach((e) => {
      const row = document.createElement('div');
      const holdsSelected = e.chain.some((f) => f.table.id === selectedId);
      const rowKey = `c:${e.head.id}`;
      rowKeys.push(rowKey);
      const inSel = multiSel.has(rowKey);
      row.className = `scribe-am-xtrow${holdsSelected ? ' sel' : ''}${inSel ? ' msel' : ''}`;
      row.dataset.rowKey = rowKey;
      row.tabIndex = 0;
      const multi = e.chain.length > 1;
      const chev = glyphSpan(CHEV_R_SVG, multi, 'chev');
      if (multi && expanded.has(e.head.id)) chev.classList.add('open');
      if (multi) {
        chev.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (expanded.has(e.head.id)) expanded.delete(e.head.id); else expanded.add(e.head.id);
          renderList();
        });
      }
      row.appendChild(chev);
      row.appendChild(glyphSpan(LINK_SVG, multi, 'link'));
      const tx = document.createElement('span');
      tx.className = 'scribe-am-xtrow-tx';
      const cols = e.head.boxes.length;
      tx.textContent = `${e.name}${e.meta} \u00b7 ${cols} column${cols === 1 ? '' : 's'}`;
      tx.title = tx.textContent;
      row.appendChild(tx);
      // A selected row whose selection resolves to no action keeps its own verb, so clicking a row never costs it its unlink.
      if (inSel && res) {
        row.appendChild(verbAct(res));
      } else if (multi) {
        const acts = document.createElement('span');
        acts.className = 'scribe-am-xtsubacts';
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'scribe-am-xtsugact muted';
        b.title = `Unlink pages ${e.n + 1}\u2013${e.chain[e.chain.length - 1].n + 1}`;
        b.innerHTML = UNLINK_SVG;
        b.addEventListener('click', (ev) => {
          ev.stopPropagation();
          unlinkChain(viewer, e.head);
        });
        acts.appendChild(b);
        row.appendChild(acts);
      }
      const select = () => selectFragment(e.head, e.n);
      const onAct = (ev) => {
        if (ev.shiftKey) {
          extendRange(rowKey);
          return;
        }
        multiSel.clear();
        multiSel.add(rowKey);
        multiAnchor = rowKey;
        select();
      };
      row.addEventListener('click', onAct);
      row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') onAct(ev); });
      listElem.appendChild(row);
      if (multi && expanded.has(e.head.id)) {
        e.chain.forEach((frag) => {
          const sub = document.createElement('div');
          const subKey = `p:${frag.table.id}`;
          rowKeys.push(subKey);
          const subSel = multiSel.has(subKey);
          sub.className = `scribe-am-xtrow sub${frag.table.id === selectedId ? ' sel' : ''}${subSel ? ' msel' : ''}`;
          sub.dataset.rowKey = subKey;
          sub.tabIndex = 0;
          const stx = document.createElement('span');
          stx.className = 'scribe-am-xtrow-tx';
          stx.textContent = `Page ${frag.n + 1}`;
          sub.appendChild(stx);
          if (subSel && res) {
            sub.appendChild(verbAct(res));
          } else if (frag !== e.chain[0]) {
            const acts = document.createElement('span');
            acts.className = 'scribe-am-xtsubacts';
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'scribe-am-xtsugact muted';
            b.title = `Unlink from ${e.name} before page ${frag.n + 1}`;
            b.innerHTML = UNLINK_SVG;
            b.addEventListener('click', (ev) => {
              ev.stopPropagation();
              // After the split this fragment heads a new chain, and pre-expanding it keeps both halves open.
              expanded.add(frag.table.id);
              unlinkTable(viewer, frag.table);
            });
            acts.appendChild(b);
            sub.appendChild(acts);
          }
          const subSelect = () => selectFragment(frag.table, frag.n);
          const onSubAct = (ev) => {
            if (ev.shiftKey) {
              extendRange(subKey);
              return;
            }
            multiSel.clear();
            multiSel.add(subKey);
            multiAnchor = subKey;
            subSelect();
          };
          sub.addEventListener('click', onSubAct);
          sub.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') onSubAct(ev); });
          listElem.appendChild(sub);
        });
      }
    });

    // Unlinking appends to the queue, so page order has to be restored here or a range over these rows spans the wrong boundaries.
    const sugs = (viewer.doc.tableLinkSuggestions || [])
      .map((s) => ({ s, table: viewer.doc.layoutDataTables.pages[s.n]?.tables.find((t) => t.id === s.tableId) }))
      .filter((x) => x.table && !x.table.continuesPrev)
      .sort((a, b) => a.s.prevN - b.s.prevN);
    if (sugs.length > 0) {
      const divider = document.createElement('div');
      divider.className = 'scribe-am-xtsugdiv';
      const dl = document.createElement('span');
      dl.textContent = 'Suggested';
      const all = document.createElement('button');
      all.type = 'button';
      all.className = 'scribe-am-xtsugall';
      all.textContent = 'Confirm all';
      all.addEventListener('click', () => { for (const x of sugs) linkTables(viewer, x.table); });
      divider.append(dl, all);
      listElem.appendChild(divider);
      sugs.forEach(({ s, table }) => {
        const row = document.createElement('div');
        const sugKey = `s:${table.id}`;
        rowKeys.push(sugKey);
        const sugSel = multiSel.has(sugKey);
        row.className = `scribe-am-xtrow${sugSel ? ' msel' : ''}`;
        row.dataset.rowKey = sugKey;
        row.tabIndex = 0;
        row.appendChild(glyphSpan(CHEV_R_SVG, false, 'chev'));
        row.appendChild(glyphSpan(LINK_SVG, true, 'link muted'));
        const tx = document.createElement('span');
        tx.className = 'scribe-am-xtrow-tx';
        tx.innerHTML = `Pages ${s.prevN + 1}\u2013${s.n + 1} <span class="scribe-am-xtwhy">\u00b7 ${s.reason}</span>`;
        tx.title = `Pages ${s.prevN + 1}\u2013${s.n + 1} \u00b7 ${s.reason}`;
        row.appendChild(tx);
        const acts = document.createElement('span');
        acts.className = 'scribe-am-xtsugacts';
        const mkAct = (svg, title, handler, muted) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.title = title;
          b.className = `scribe-am-xtsugact${muted ? ' muted' : ''}`;
          b.innerHTML = svg;
          b.addEventListener('click', (ev) => { ev.stopPropagation(); handler(); });
          return b;
        };
        if (sugSel && res) {
          const selSugs = sugs.filter((x) => multiSel.has(`s:${x.table.id}`));
          acts.appendChild(mkAct(CHECK_MINI_SVG, res.label, () => applySelection(), false));
          acts.appendChild(mkAct(X_MINI_SVG, selSugs.length > 1 ? `Dismiss ${selSugs.length} suggestions` : 'Dismiss', () => {
            for (const x of selSugs) {
              const idx = viewer.doc.tableLinkSuggestions.indexOf(x.s);
              if (idx >= 0) viewer.doc.tableLinkSuggestions.splice(idx, 1);
              multiSel.delete(`s:${x.table.id}`);
            }
            renderList();
          }, true));
        } else {
          acts.appendChild(mkAct(CHECK_MINI_SVG, 'Link tables', () => linkTables(viewer, table), false));
          acts.appendChild(mkAct(X_MINI_SVG, 'Dismiss', () => {
            const idx = viewer.doc.tableLinkSuggestions.indexOf(s);
            if (idx >= 0) viewer.doc.tableLinkSuggestions.splice(idx, 1);
            multiSel.delete(sugKey);
            renderList();
          }, true));
        }
        row.appendChild(acts);
        const goTo = () => selectFragment(table, s.n);
        const onSugAct = (ev) => {
          if (ev.shiftKey) {
            extendRange(sugKey);
            return;
          }
          multiSel.clear();
          multiSel.add(sugKey);
          multiAnchor = sugKey;
          goTo();
        };
        row.addEventListener('click', onSugAct);
        row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') onSugAct(ev); });
        listElem.appendChild(row);
      });
    }

    listElem.querySelectorAll('.scribe-am-xtrow.msel').forEach((el) => {
      const prevSel = el.previousElementSibling?.classList.contains('msel');
      const nextSel = el.nextElementSibling?.classList.contains('msel');
      if (!prevSel && !nextSel) el.classList.add('cap-solo');
      else if (!prevSel) el.classList.add('cap-top');
      else if (!nextSel) el.classList.add('cap-bot');
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

  selectedId = chainEntries()[0]?.head.id ?? null;
  renderList();
  sumTx.textContent = options.summarize();

  return {
    refresh: () => {
      const entries = chainEntries();
      const allIds = new Set(entries.flatMap((e) => e.chain.map((f) => f.table.id)));
      const liveSugIds = new Set((viewer.doc.tableLinkSuggestions || []).map((s) => s.tableId));
      for (const k of [...multiSel]) {
        if (k[0] === 's' ? !liveSugIds.has(k.slice(2)) : !allIds.has(k.slice(2))) multiSel.delete(k);
      }
      const activeId = viewer.state.activeTableId;
      if (activeId && allIds.has(activeId)) selectedId = activeId;
      else if (activeId) viewer.state.activeTableId = null;
      // Undo and redo install clones, so the selection has to re-resolve by id rather than by identity.
      if (!selectedId || !allIds.has(selectedId)) selectedId = entries[0]?.head.id ?? null;
      renderList();
      sumTx.textContent = options.summarize();
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
 * @param {{pageIndices: ?Array<number>, flat: boolean, formatting: boolean}} params - null `pageIndices` = all pages.
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

  /** @type {Array<{name: string, rows: Array<Array<string|TableCellRich>>, range: XlsxTableRange, columnWidths?: Array<number>}>} */
  const harvested = [];
  const scopeSet = new Set(scope);
  progress(0.2, 'Extracting tables\u2026');
  const chains = scribe.extractDocTableChains(doc.ocr.active, doc.layoutDataTables.pages, { cellFormats: params?.formatting });
  for (const chain of chains) {
    const frags = chain.fragments.filter((f) => scopeSet.has(f.n));
    if (frags.length === 0) continue;
    const head = chain.fragments[0];
    const pageTables = doc.layoutDataTables.pages[head.n].tables.slice()
      .sort((a, b) => scribe.layout.calcTableBbox(a).top - scribe.layout.calcTableBbox(b).top);
    const m = pageTables.indexOf(head.table) + 1;
    const first = frags[0].n; const last = frags[frags.length - 1].n;
    const pagesPart = frags.length > 1 ? `Pages ${first + 1}\u2013${last + 1}` : `Page ${first + 1}`;
    const chainRows = frags.flatMap((f) => f.rows);
    // Header styling applies only when the chain head made it into scope.
    // A scoped-out head leaves continuation rows alone, which are all data.
    /** @type {XlsxTableRange} */
    const range = { start: 0, rowCount: chainRows.length, headerRows: frags[0] === head ? chain.headerRows : 0 };
    /** @type {Array<number>|undefined} */
    let columnWidths;
    if (params?.formatting) {
      if (head.table.detectionMethod === 'grid-strong') range.grid = true;
      if (head.table.detectionMethod === 'row-band') {
        range.zebra = true;
        if (head.table.bandColor) range.zebraColor = head.table.bandColor;
      }
      range.alignNumeric = true;
      // A chain whose fragments disagree on column count has no single source geometry to copy, so it keeps the auto widths.
      if (!params?.flat && chain.fragments.every((f) => f.table.boxes.length === head.table.boxes.length)) {
        columnWidths = head.table.boxes.map((b) => Math.round(Math.min(Math.max(((b.coords.right - b.coords.left) * (96 / 300) - 5) / 7, 8), 60) * 100) / 100);
      }
    }
    harvested.push({
      name: head.table.title?.text || `${pagesPart} Table ${m}`,
      rows: chainRows,
      range,
      columnWidths,
    });
  }

  if (harvested.length === 0) {
    return { rows: [{ kind: 'info', text: 'No tables found on the selected pages' }] };
  }

  progress(1, 'Writing spreadsheet…');
  /** @type {Array<{name: string, rows: Array<Array<string|TableCellRich>>, tableRanges: Array<XlsxTableRange>, columnWidths?: Array<number>}>} */
  let sheets;
  if (params?.flat) {
    /** @type {Array<Array<string|TableCellRich>>} */
    const flatRows = [];
    /** @type {Array<XlsxTableRange>} */
    const flatRanges = [];
    for (const t of harvested) {
      flatRanges.push({ ...t.range, start: flatRows.length });
      flatRows.push(...t.rows);
    }
    sheets = [{ name: 'Tables', rows: flatRows, tableRanges: flatRanges }];
  } else {
    sheets = harvested.map((t) => ({
      name: t.name, rows: t.rows, tableRanges: [t.range], columnWidths: t.columnWidths,
    }));
  }
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
