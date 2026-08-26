// The Redactions workspace: the Automate panel surface that owns the document's redaction term list.
// Terms live on `doc.redactions`, which serializes into the `.scribe` session block, so a field added to a term record reaches users' saved files.
import scribe from '../../../scribe.js';
import { redactWords, removeRedactionGroup, setRedactPreview } from '../viewerRedactions.js';
import { formatTimestamp } from '../controls/toolbar.js';

const lineIcon = (inner) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'
  + ` style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true">${inner}</svg>`;
const CHECK_SVG = lineIcon('<path d="M5 12.5l4.5 4.5L19 7.5"/>');
const FLAG_SVG = lineIcon('<path d="M6 21V4.5"/><path d="M6 5h11l-2.5 3.5L17 12H6z"/>');
const INFO_SVG = lineIcon('<circle cx="12" cy="12" r="8"/><path d="M12 11v5M12 8v.01"/>');
const DOTS_SVG = lineIcon('<circle cx="5.5" cy="12" r="1.2" fill="currentColor" stroke="none"/>'
  + '<circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.2" fill="currentColor" stroke="none"/>');

const MODE_ORDER = /** @type {Array<RedactionTermRecord['mode']>} */ (['variants', 'exact', 'contains']);
const MODE_LABELS = { variants: 'word + variants', exact: 'exact word', contains: 'anywhere in word' };

/**
 * A word token with edge punctuation stripped, for whole-word comparison.
 * Interior punctuation stays, so hyphenated and possessive terms still match exactly.
 * @param {string} text
 */
const trimPunct = (text) => text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/**
 * Endings accepted after a term's final word in `variants` mode.
 * A plural possessive needs no entry, because edge punctuation is trimmed before the comparison.
 */
const VARIANT_SUFFIXES = ['s', 'es', "'s", '’s'];

/**
 * Every non-overlapping occurrence of `term` on a page, as runs of matched words.
 * Multi-word terms match consecutive words in reading order, like the find bar.
 * @param {OcrPage} page
 * @param {string} term
 * @param {RedactionTermRecord['mode']} mode
 * @param {boolean} matchCase
 * @returns {Array<Array<OcrWord>>}
 */
function findOccurrences(page, term, mode, matchCase) {
  const norm = (s) => (matchCase ? s : s.toLowerCase());
  const termTokens = norm(term.trim()).split(/\s+/);
  if (!termTokens.length || !termTokens[0]) return [];
  const words = scribe.utils.ocr.getPageWords(page);
  const occurrences = [];
  const tokenMatches = (tokText, termToken, last) => {
    if (mode === 'contains') return norm(tokText).includes(termToken);
    const t = norm(trimPunct(tokText));
    if (t === termToken) return true;
    if (mode !== 'variants' || !last) return false;
    return VARIANT_SUFFIXES.some((suf) => t === termToken + suf);
  };
  for (let i = 0; i <= words.length - termTokens.length; i++) {
    const cand = words.slice(i, i + termTokens.length);
    let hit;
    if (mode === 'contains' && termTokens.length > 1) {
      hit = norm(cand.map((w) => w.text).join(' ')).includes(termTokens.join(' '));
    } else {
      hit = cand.every((w, j) => tokenMatches(w.text, termTokens[j], j === termTokens.length - 1));
    }
    if (hit) {
      occurrences.push(cand);
      i += termTokens.length - 1;
    }
  }
  return occurrences;
}

/**
 * Build the Redactions workspace into `container`.
 * All term data lives on `viewer.doc.redactions`, so discarding and rebuilding the view loses nothing.
 * @param {import('./registry.js').AutomationHost} host
 * @param {HTMLElement} container
 * @returns {{refresh: () => void, prefill: (term: string) => void}}
 */
export function buildRedactionsWorkspace(host, container) {
  const viewer = host.viewer;
  const store = () => viewer.doc.redactions;

  container.textContent = '';
  const body = document.createElement('div');
  body.className = 'scribe-am-rdbody';
  const foot = document.createElement('div');
  foot.className = 'scribe-am-rdfoot';
  container.append(body, foot);

  const scannedLine = document.createElement('div');
  scannedLine.className = 'scribe-as-mark';

  const addWrap = document.createElement('div');
  addWrap.style.display = 'grid';
  addWrap.style.gap = '10px';
  const chipsWrap = document.createElement('div');
  chipsWrap.className = 'scribe-am-terms';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'scribe-am-terms-input';
  input.placeholder = 'Add a term or phrase…';
  input.setAttribute('aria-label', 'Add a term or phrase');
  chipsWrap.appendChild(input);
  chipsWrap.addEventListener('click', () => input.focus());
  const optsRow = document.createElement('div');
  optsRow.className = 'scribe-am-opts';
  const caseLabel = document.createElement('label');
  caseLabel.className = 'scribe-am-check';
  const caseBox = document.createElement('input');
  caseBox.type = 'checkbox';
  caseBox.checked = store().matchCase;
  caseBox.addEventListener('change', () => { store().matchCase = caseBox.checked; });
  caseLabel.append(caseBox, document.createTextNode('Match case'));
  optsRow.appendChild(caseLabel);
  const receiptHost = document.createElement('div');
  receiptHost.style.display = 'none';
  addWrap.append(chipsWrap, optsRow, receiptHost);

  const catLabel = document.createElement('div');
  catLabel.className = 'scribe-am-cat';
  catLabel.style.paddingLeft = '2px';
  catLabel.textContent = 'Terms';
  const list = document.createElement('div');
  list.style.display = 'grid';
  list.style.gap = '1px';
  const emptyNote = document.createElement('div');
  emptyNote.className = 'scribe-am-empty';
  emptyNote.textContent = 'Terms you add stage a redaction mark over every occurrence in the document.';
  body.append(scannedLine, addWrap, catLabel, list, emptyNote);

  const sumRow = document.createElement('div');
  sumRow.className = 'scribe-am-rdsum';
  const sumText = document.createElement('b');
  const sumGrow = document.createElement('span');
  sumGrow.style.flex = '1';
  const previewLabel = document.createElement('label');
  previewLabel.className = 'scribe-am-check';
  previewLabel.style.fontSize = '12px';
  const previewBox = document.createElement('input');
  previewBox.type = 'checkbox';
  previewBox.addEventListener('change', () => setRedactPreview(viewer, previewBox.checked));
  previewLabel.append(previewBox, document.createTextNode('Preview export'));
  sumRow.append(sumText, sumGrow, previewLabel);
  const footNote = document.createElement('div');
  footNote.className = 'scribe-am-rdnote';
  footNote.textContent = 'Marks stay reviewable here and in Comments; export removes the marked content.';
  foot.append(sumRow, footNote);

  const scanning = new Set();

  /**
   * Marks and page spread a term's staged groups currently cover.
   * The count walks the annotations rather than `groupIds`, so marks deleted from the comments panel or by an undo drop out of it.
   * @param {RedactionTermRecord} rec
   */
  const termStats = (rec) => {
    const ids = new Set(rec.groupIds);
    let marks = 0;
    const pages = new Set();
    viewer.doc.annotations.pages.forEach((pageAnnots, n) => {
      for (const a of pageAnnots || []) {
        if (a.type === 'redact' && ids.has(a.groupId)) {
          marks += 1;
          pages.add(n);
        }
      }
    });
    return { marks, pages: pages.size };
  };

  /**
   * Replace the receipt line under the add box.
   * @param {'ok'|'flag'|'info'} kind
   * @param {string} text
   * @param {?{label: string, onClick: () => void}} act
   */
  function showReceipt(kind, text, act) {
    receiptHost.textContent = '';
    receiptHost.style.display = '';
    const row = document.createElement('div');
    row.className = `scribe-am-result ${kind}`;
    const ic = document.createElement('span');
    ic.className = 'scribe-am-result-ic';
    ic.innerHTML = kind === 'ok' ? CHECK_SVG : (kind === 'flag' ? FLAG_SVG : INFO_SVG);
    const tx = document.createElement('span');
    tx.className = 'scribe-am-result-tx';
    tx.textContent = text;
    tx.title = text;
    row.append(ic, tx);
    if (act) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'scribe-am-result-act';
      btn.textContent = act.label;
      btn.addEventListener('click', act.onClick);
      row.appendChild(btn);
    }
    receiptHost.appendChild(row);
  }

  function deleteTerm(rec) {
    viewer.doc.docHistory.group('Removed redaction marks', () => {
      for (const gid of rec.groupIds) removeRedactionGroup(viewer, gid);
    });
    const terms = store().terms;
    const i = terms.indexOf(rec);
    if (i !== -1) terms.splice(i, 1);
    receiptHost.style.display = 'none';
    render();
  }

  /**
   * Stage marks for `rec` over every occurrence, replacing whatever its previous scan staged.
   * Returns null when the document switched or the term was removed while scanning.
   * @param {RedactionTermRecord} rec
   * @param {string} historyLabel
   * @returns {Promise<?{occurrences: number, marks: number}>}
   */
  async function scanTerm(rec, historyLabel) {
    const doc = viewer.doc;
    // A freshly-opened PDF may still be extracting text, so searching before it settles reports false misses.
    if (doc._textReadySettle) {
      await doc.textReady;
      if (viewer.doc !== doc) return null;
    }
    /** @type {Array<Array<OcrWord>>} */
    const found = [];
    for (let n = 0; n < doc.pageMetrics.length; n++) {
      const page = doc.ocr.active[n];
      if (page) {
        for (const occ of findOccurrences(page, rec.term, rec.mode, store().matchCase)) found.push(occ);
      }
      if (n % 5 === 4) await new Promise((resolve) => { setTimeout(resolve, 0); });
    }
    if (viewer.doc !== doc || !store().terms.includes(rec)) return null;
    const groupIds = [];
    let marks = 0;
    doc.docHistory.group(historyLabel, () => {
      for (const gid of rec.groupIds) removeRedactionGroup(viewer, gid);
      for (const occ of found) {
        // One call per occurrence, so each occurrence stays its own deletable mark group.
        const { added, groupId } = redactWords(viewer, occ);
        if (added > 0 && groupId) {
          marks += added;
          groupIds.push(groupId);
        }
      }
    });
    rec.groupIds = groupIds;
    store().scannedAt = new Date().toISOString();
    return { occurrences: found.length, marks };
  }

  /**
   * Scan `rec` with its row shown as pending, and report an add's outcome in the receipt line.
   * @param {RedactionTermRecord} rec
   * @param {string} historyLabel
   * @param {boolean} [isAdd]
   */
  async function runScan(rec, historyLabel, isAdd) {
    scanning.add(rec);
    render();
    let out = null;
    try {
      out = await scanTerm(rec, historyLabel);
    } finally {
      scanning.delete(rec);
    }
    if (out && isAdd) {
      if (out.marks > 0) {
        showReceipt('ok', `Staged ${out.marks} mark${out.marks === 1 ? '' : 's'} for “${rec.term}”`, { label: 'Undo', onClick: () => deleteTerm(rec) });
      } else if (out.occurrences > 0) {
        showReceipt('info', `Every “${rec.term}” match was already marked`, { label: 'Remove', onClick: () => deleteTerm(rec) });
      } else {
        showReceipt('flag', `“${rec.term}” — no matches`, { label: 'Remove', onClick: () => deleteTerm(rec) });
      }
    }
    render();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const term = input.value.trim().replace(/\s+/g, ' ');
    if (!term) return;
    e.preventDefault();
    e.stopPropagation();
    if (store().terms.some((t) => !t.removed && t.term.toLowerCase() === term.toLowerCase())) {
      showReceipt('info', `“${term}” is already listed`, null);
      return;
    }
    /** @type {RedactionTermRecord} */
    const rec = { term, mode: 'variants', groupIds: [] };
    store().terms.push(rec);
    input.value = '';
    runScan(rec, 'Marked for redaction', true);
  });

  /** @type {?HTMLElement} */
  let menuElem = null;
  const closeMenu = () => {
    if (!menuElem) return;
    menuElem.remove();
    menuElem = null;
    list.querySelector('.scribe-am-trow.menuopen')?.classList.remove('menuopen');
    document.removeEventListener('pointerdown', onMenuPointerDown, true);
  };
  function onMenuPointerDown(e) {
    if (menuElem && !menuElem.contains(e.target)) closeMenu();
  }

  function openRowMenu(rec, row, anchor) {
    closeMenu();
    row.classList.add('menuopen');
    const menu = document.createElement('div');
    menu.className = 'scribe-am-mmenu';
    menu.setAttribute('role', 'menu');
    const addItem = (label, danger, onClick) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'scribe-am-mrow';
      item.textContent = label;
      if (danger) item.style.color = 'var(--scribe-danger)';
      item.addEventListener('click', () => {
        closeMenu();
        onClick();
      });
      menu.appendChild(item);
    };
    addItem('Edit term', false, () => beginEdit(rec, row));
    addItem('Rescan', false, () => runScan(rec, 'Updated redaction marks'));
    addItem('Remove marks', true, () => {
      viewer.doc.docHistory.group('Removed redaction marks', () => {
        for (const gid of rec.groupIds) removeRedactionGroup(viewer, gid);
      });
      rec.groupIds = [];
      rec.removed = true;
      render();
    });
    const panel = /** @type {HTMLElement} */ (container.closest('.scribe-am-panel') || container);
    const panelRect = panel.getBoundingClientRect();
    const aRect = anchor.getBoundingClientRect();
    menu.style.position = 'absolute';
    menu.style.left = 'auto';
    menu.style.right = `${Math.round(panelRect.right - aRect.right)}px`;
    menu.style.top = `${Math.round(aRect.bottom - panelRect.top + 4)}px`;
    panel.appendChild(menu);
    menuElem = menu;
    document.addEventListener('pointerdown', onMenuPointerDown, true);
  }

  function beginEdit(rec, row) {
    const nm = row.querySelector('.scribe-am-trow-nm');
    if (!nm) return;
    const edit = document.createElement('input');
    edit.type = 'text';
    edit.className = 'scribe-am-trow-edit';
    edit.value = rec.term;
    nm.replaceWith(edit);
    edit.focus();
    edit.select();
    edit.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const next = edit.value.trim().replace(/\s+/g, ' ');
        if (next && next !== rec.term) {
          rec.term = next;
          runScan(rec, 'Updated redaction marks');
        } else render();
      } else if (e.key === 'Escape') render();
      else return;
      e.stopPropagation();
    });
    edit.addEventListener('blur', () => { if (edit.isConnected) render(); });
  }

  function buildRow(rec) {
    const row = document.createElement('div');
    row.className = `scribe-am-trow${rec.removed ? ' removed' : ''}`;
    const t = document.createElement('span');
    t.className = 'scribe-am-trow-t';
    const nm = document.createElement('span');
    nm.className = 'scribe-am-trow-nm';
    nm.textContent = rec.term;
    t.appendChild(nm);
    const nLine = document.createElement('span');
    nLine.className = 'scribe-am-trow-n';
    if (rec.removed) {
      nLine.textContent = 'marks removed';
    } else if (scanning.has(rec)) {
      nLine.textContent = 'Scanning…';
    } else {
      const { marks, pages } = termStats(rec);
      nLine.textContent = marks === 0 ? '0 matches' : `${marks} mark${marks === 1 ? '' : 's'} · ${pages} page${pages === 1 ? '' : 's'}`;
      nLine.append(' · ');
      const mode = document.createElement('span');
      mode.className = 'scribe-am-trow-mode';
      mode.role = 'button';
      mode.tabIndex = 0;
      mode.title = 'Change how this term matches';
      mode.textContent = `${MODE_LABELS[rec.mode]} ▾`;
      mode.addEventListener('click', () => {
        rec.mode = MODE_ORDER[(MODE_ORDER.indexOf(rec.mode) + 1) % MODE_ORDER.length];
        runScan(rec, 'Updated redaction marks');
      });
      mode.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          mode.click();
        }
      });
      nLine.appendChild(mode);
    }
    const acts = document.createElement('span');
    acts.className = 'scribe-am-trow-acts';
    if (rec.removed) {
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'scribe-am-quiet';
      restore.style.fontSize = '11.5px';
      restore.style.padding = '1px 7px';
      restore.textContent = 'Restore';
      restore.addEventListener('click', () => {
        rec.removed = false;
        runScan(rec, 'Marked for redaction');
      });
      acts.appendChild(restore);
    } else {
      const dots = document.createElement('span');
      dots.className = 'scribe-am-ib';
      dots.role = 'button';
      dots.tabIndex = 0;
      dots.title = 'Term actions';
      dots.innerHTML = DOTS_SVG;
      dots.addEventListener('click', () => openRowMenu(rec, row, dots));
      acts.appendChild(dots);
    }
    row.append(t, nLine, acts);
    return row;
  }

  function render() {
    closeMenu();
    const terms = store().terms;
    const active = terms.filter((t) => !t.removed);
    scannedLine.style.display = terms.length && store().scannedAt ? '' : 'none';
    if (terms.length && store().scannedAt) {
      scannedLine.textContent = `Last scanned ${formatTimestamp(store().scannedAt)} · `;
      const rescan = document.createElement('span');
      rescan.className = 'scribe-am-rdrescan';
      rescan.role = 'button';
      rescan.tabIndex = 0;
      rescan.textContent = 'Rescan';
      rescan.addEventListener('click', async () => {
        for (const rec of active) await runScan(rec, 'Updated redaction marks');
      });
      scannedLine.appendChild(rescan);
    }
    list.textContent = '';
    for (const rec of terms) list.appendChild(buildRow(rec));
    catLabel.style.display = terms.length ? '' : 'none';
    emptyNote.style.display = terms.length ? 'none' : '';
    let totalMarks = 0;
    for (const rec of active) totalMarks += termStats(rec).marks;
    sumText.textContent = `${totalMarks} mark${totalMarks === 1 ? '' : 's'} from ${active.length} term${active.length === 1 ? '' : 's'}`;
  }

  render();
  input.focus();
  return {
    refresh: render,
    prefill: (term) => {
      input.value = term;
      input.focus();
      input.select();
    },
  };
}
