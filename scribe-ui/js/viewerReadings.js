/**
 * Proof mode's readings list, which shows the selected word's other readings (`OcrWord.alt`).
 */
import scribe from '../../scribe.js';
// eslint-disable-next-line import/no-cycle
import { UiText, UiOcrWord } from './viewerWordObjects.js';

/** @typedef {import('../../js/objects/ocrObjects.js').OcrWord} OcrWord */
/** @typedef {NonNullable<OcrWord['alt']>[number]} Reading */

/** @type {?HTMLDivElement} */
let listNode = null;
/** @type {?HTMLStyleElement} */
let styleNode = null;
/** @type {?import('../viewer.js').ScribeViewer} */
let listViewer = null;
/** @type {?UiOcrWord} */
let listWord = null;
/** @type {?UiOcrWord} */
let dismissedWord = null;
/** @type {?{dx: number, dy: number}} */
let dragOffset = null;
/** @type {?{itext: UiOcrWord, index: number, word: OcrWord, hidden: Array<UiOcrWord>}} */
let previewState = null;
/** @type {?HTMLDivElement} */
let bracketNode = null;
let repositionQueued = false;

const TOKENS = ['--scribe-surface', '--scribe-line', '--scribe-line-strong', '--scribe-ink', '--scribe-ink-3', '--scribe-hover',
  '--scribe-accent-wash', '--scribe-menu-shadow'];

const GRIP_SVG = '<svg viewBox="0 0 18 6" aria-hidden="true"><circle cx="4" cy="3" r="1.15" fill="currentColor"/>'
  + '<circle cx="9" cy="3" r="1.15" fill="currentColor"/><circle cx="14" cy="3" r="1.15" fill="currentColor"/></svg>';

const readingRun = (word, reading) => {
  const lineWords = word.line.words.slice().sort((a, b) => a.bbox.left - b.bbox.left);
  const i = lineWords.indexOf(word);
  return lineWords.slice(i, i + (reading.span || 1));
};

const uiWordFor = (viewer, word) => viewer.getUiWords().find((w) => w.word === word) || null;

function ensureList() {
  if (listNode) return;
  styleNode = document.createElement('style');
  styleNode.textContent = `
    .scribe-readings { display: none; position: fixed; z-index: 60; box-sizing: border-box; min-width: 168px; padding: 4px;
      background: var(--scribe-surface, #ffffff); border: 1px solid var(--scribe-line, #e4e8ef); border-radius: 8px;
      box-shadow: var(--scribe-menu-shadow, 0 1px 2px rgba(20, 30, 60, .10), 0 5px 14px rgba(20, 30, 60, .12));
      font-family: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; font-size: 13px; line-height: 1.4;
      color: var(--scribe-ink, #1f2530); user-select: none; -webkit-user-select: none; }
    .scribe-readings-grip { height: 9px; margin: -1px 0 2px; display: flex; align-items: center; justify-content: center; cursor: grab; color: var(--scribe-ink-3, #98a1b0); }
    .scribe-readings-grip svg { width: 18px; height: 6px; display: block; }
    .scribe-readings.dragging .scribe-readings-grip { cursor: grabbing; }
    .scribe-readings-row { display: flex; align-items: center; gap: 9px; padding: 4px 10px; border-radius: 4px; white-space: nowrap; cursor: pointer; }
    .scribe-readings-row:hover { background: var(--scribe-hover, rgba(28, 42, 68, .06)); }
    .scribe-readings-key { flex: 0 0 auto; min-width: 16px; height: 16px; padding: 0 3px; box-sizing: border-box; border: 1px solid var(--scribe-line-strong, #d7dce4); border-radius: 3px;
      font: 600 10.5px/14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--scribe-ink-3, #98a1b0); text-align: center; }
    .scribe-readings-text { flex: 1 1 auto; }
    .scribe-readings-text mark { background: var(--scribe-accent-wash, rgba(28, 98, 212, .14)); color: inherit; border-radius: 2px; box-shadow: 0 0 0 1px var(--scribe-accent-wash, rgba(28, 98, 212, .14)); }
    .scribe-readings-hint { padding: 3px 10px 1px; margin-top: 3px; border-top: 1px solid var(--scribe-line, #e4e8ef); font-size: 10.5px; color: var(--scribe-ink-3, #98a1b0); white-space: nowrap; }
    .scribe-readings-bracket { position: absolute; pointer-events: none; z-index: 2; box-sizing: border-box;
      border: calc(2px / var(--scribe-zoom, 1)) dashed rgba(28, 98, 212, .9); border-radius: calc(3px / var(--scribe-zoom, 1)); }`;
  document.head.appendChild(styleNode);

  listNode = document.createElement('div');
  listNode.className = 'scribe-readings';
  document.body.appendChild(listNode);

  // Cancelling the press keeps the viewer's keyboard shortcuts working after the list is clicked or dragged.
  listNode.addEventListener('pointerdown', (e) => {
    const grip = /** @type {HTMLElement} */ (e.target).closest('.scribe-readings-grip');
    if (!grip) { e.preventDefault(); return; }
    e.preventDefault();
    if (!listNode) return;
    const x0 = e.clientX; const y0 = e.clientY;
    const start = dragOffset || { dx: 0, dy: 0 };
    listNode.classList.add('dragging');
    const onMove = (ev) => { dragOffset = { dx: start.dx + ev.clientX - x0, dy: start.dy + ev.clientY - y0 }; position(); };
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); listNode?.classList.remove('dragging'); };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
  listNode.addEventListener('click', (e) => {
    const row = /** @type {HTMLElement} */ (e.target).closest('.scribe-readings-row');
    if (row) pick(Number(row.dataset.i));
  });
  listNode.addEventListener('mouseover', (e) => {
    const row = /** @type {HTMLElement} */ (e.target).closest('.scribe-readings-row');
    if (!row || !listWord) return;
    const index = Number(row.dataset.i);
    if (previewState?.index !== index) startPreview(index);
  });
  listNode.addEventListener('mouseleave', () => endPreview());
}

function pick(index) {
  if (!listWord || !listViewer) return;
  // The preview ends first because `applyReading` removes the picked reading from the word's readings by identity, and the stand-in's readings are copies.
  endPreview();
  const reading = listWord.word.alt?.[index];
  if (reading) applyReading(listViewer, listWord, reading);
}

function render() {
  if (!listNode || !listWord) return;
  const { word } = listWord;
  listNode.replaceChildren();
  const grip = document.createElement('div');
  grip.className = 'scribe-readings-grip';
  grip.title = 'Drag';
  grip.innerHTML = GRIP_SVG;
  listNode.appendChild(grip);
  (word.alt || []).forEach((reading, i) => {
    const row = document.createElement('div');
    row.className = 'scribe-readings-row';
    row.dataset.i = String(i);
    if (i < 9) {
      const key = document.createElement('span');
      key.className = 'scribe-readings-key';
      key.textContent = String(i + 1);
      row.appendChild(key);
    }
    const from = [...readingRun(word, reading).map((w) => w.text).join(' ')];
    const to = [...reading.text];
    const m = from.length; const n = to.length;
    const lcs = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let a = m - 1; a >= 0; a--) for (let b = n - 1; b >= 0; b--) lcs[a][b] = from[a] === to[b] ? lcs[a + 1][b + 1] + 1 : Math.max(lcs[a + 1][b], lcs[a][b + 1]);
    const text = document.createElement('span');
    text.className = 'scribe-readings-text';
    let a = 0; let b = 0; let run = ''; let runDiffers = false;
    const flush = () => {
      if (!run) return;
      const node = runDiffers ? document.createElement('mark') : document.createTextNode(run);
      if (runDiffers) node.textContent = run;
      text.appendChild(node);
      run = '';
    };
    const push = (ch, differs) => { if (differs !== runDiffers) { flush(); runDiffers = differs; } run += ch; };
    while (a < m && b < n) {
      if (from[a] === to[b]) { push(to[b], false); a++; b++; } else if (lcs[a + 1][b] >= lcs[a][b + 1]) a++; else { push(to[b], true); b++; }
    }
    while (b < n) push(to[b++], true);
    flush();
    row.appendChild(text);
    listNode.appendChild(row);
  });
  const hint = document.createElement('div');
  hint.className = 'scribe-readings-hint';
  hint.textContent = '1–9 pick · Enter edit · Esc hide';
  listNode.appendChild(hint);
}

function position() {
  if (!listNode || !listWord || !listViewer || !listWord.el) return;
  const wordRect = listWord.el.getBoundingClientRect();
  const viewRect = listViewer.scrollContainer.getBoundingClientRect();
  const inView = wordRect.bottom > viewRect.top && wordRect.top < viewRect.bottom && wordRect.right > viewRect.left && wordRect.left < viewRect.right;
  if (!inView) { listNode.style.display = 'none'; return; }
  listNode.style.display = 'block';
  const h = listNode.offsetHeight; const w = listNode.offsetWidth;
  let top = wordRect.bottom + 6;
  if (top + h > viewRect.bottom - 6) top = wordRect.top - h - 6;
  let left = Math.max(viewRect.left + 6, Math.min(wordRect.left, viewRect.right - w - 6));
  if (dragOffset) { left += dragOffset.dx; top += dragOffset.dy; }
  listNode.style.left = `${left}px`;
  listNode.style.top = `${top}px`;
}

const onScroll = () => {
  if (repositionQueued) return;
  repositionQueued = true;
  requestAnimationFrame(() => { repositionQueued = false; position(); });
};

/** @param {number} index */
function startPreview(index) {
  endPreview();
  if (!listWord || !listViewer) return;
  const itext = listWord;
  const { word } = itext;
  const reading = word.alt?.[index];
  if (!reading) return;
  const run = readingRun(word, reading);
  const standIn = scribe.utils.ocr.cloneWord(word);
  standIn.text = reading.text;
  previewState = {
    itext, index, word, hidden: [],
  };
  if (run.length > 1) {
    standIn.bbox.right = run[run.length - 1].bbox.right;
    for (const other of run.slice(1)) {
      const ui = uiWordFor(listViewer, other);
      if (ui?.el) { ui.el.style.visibility = 'hidden'; previewState.hidden.push(ui); }
    }
    const parent = itext.getParent();
    if (parent) {
      bracketNode = document.createElement('div');
      bracketNode.className = 'scribe-readings-bracket';
      const pad = 3 / (listViewer.zoomLevel || 1);
      Object.assign(bracketNode.style, {
        left: `${itext.x() - pad}px`, top: `${itext.y() - pad}px`, width: `${standIn.bbox.right - word.bbox.left + pad * 2}px`, height: `${itext.height() + pad * 2}px`,
      });
      parent.appendChild(bracketNode);
    }
  }
  itext.word = standIn;
  UiText.updateWordCanvas(itext);
}

function endPreview() {
  if (bracketNode) { bracketNode.remove(); bracketNode = null; }
  if (!previewState) return;
  const { itext, word, hidden } = previewState;
  previewState = null;
  itext.word = word;
  for (const ui of hidden) if (ui.el) ui.el.style.visibility = '';
  if (itext.el) UiText.updateWordCanvas(itext);
}

/**
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {UiOcrWord} itext
 * @param {Reading} reading
 */
function applyReading(viewer, itext, reading) {
  endPreview();
  dismissedWord = itext;
  const { word } = itext;
  const run = readingRun(word, reading);
  const previous = { text: run.map((w) => w.text).join(' '), conf: word.conf, span: 1 };
  const alt = [previous, ...(word.alt || []).filter((r) => r !== reading)].sort((a, b) => b.conf - a.conf);
  if (run.length > 1) {
    const merged = scribe.utils.mergeOcrWords(run);
    merged.text = reading.text;
    merged.conf = reading.conf;
    merged.alt = alt;
    merged.styleRuns = undefined;
    const lineWords = word.line.words;
    lineWords.sort((a, b) => a.bbox.left - b.bbox.left);
    lineWords.splice(lineWords.indexOf(word), run.length, merged);
    viewer.displayPage(viewer.state.cp.n).then(() => {
      const ui = uiWordFor(viewer, merged);
      if (!ui) return;
      dismissedWord = ui;
      viewer.CanvasSelection.addWords(ui);
      UiOcrWord.addControls(ui);
      ui.select();
      UiOcrWord.updateUI();
    });
    return;
  }
  word.text = reading.text;
  word.conf = reading.conf;
  word.alt = alt;
  word.styleRuns = undefined;
  const { fill, opacity } = scribe.utils.ocr.getWordFillOpacity(word, viewer.state.displayMode,
    scribe.ScribeDoc.defaults.confThreshMed, scribe.ScribeDoc.defaults.confThreshHigh, scribe.ScribeDoc.defaults.overlayOpacity);
  itext.fill(fill);
  itext.opacity(opacity);
  UiText.updateWordCanvas(itext);
}

/** @param {import('../viewer.js').ScribeViewer} viewer */
export function readingsListSync(viewer) {
  // The selection array is edited around the words' own select/deselect calls, so the flags (not the array) say what is selected right now.
  const selected = viewer.CanvasSelection.getUiWords().filter((w) => w.selected);
  const itext = selected.length === 1 ? selected[0] : null;
  if (itext !== dismissedWord) dismissedWord = null;
  if (!UiText.enableEditing || !itext || !itext.el || !itext.word.alt?.length || UiText.input || itext === dismissedWord) {
    if (!listViewer || listViewer === viewer) readingsListHide();
    return;
  }
  ensureList();
  if (itext !== listWord) {
    endPreview();
    dragOffset = null;
    if (listViewer && listViewer !== viewer) listViewer.scrollContainer.removeEventListener('scroll', onScroll);
    if (!listViewer || listViewer !== viewer) { viewer.scrollContainer.addEventListener('scroll', onScroll, { passive: true }); window.addEventListener('resize', onScroll); }
    listViewer = viewer;
    listWord = itext;
    const tokenStyles = getComputedStyle(viewer.scrollContainer);
    for (const token of TOKENS) {
      const value = tokenStyles.getPropertyValue(token);
      if (value && listNode) listNode.style.setProperty(token, value); else listNode?.style.removeProperty(token);
    }
    render();
  } else if (!previewState) {
    render();
  }
  position();
}

export function readingsListHide() {
  endPreview();
  if (listViewer) { listViewer.scrollContainer.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); }
  if (listNode) listNode.style.display = 'none';
  listWord = null;
  listViewer = null;
  dragOffset = null;
}

/**
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {KeyboardEvent} event
 * @returns {boolean} Whether the key was the list's.
 */
export function readingsListKey(viewer, event) {
  if (!listWord || listViewer !== viewer || !listNode || listNode.style.display === 'none') return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.key === 'Escape') {
    dismissedWord = listWord;
    readingsListHide();
    return true;
  }
  if (/^[1-9]$/.test(event.key)) {
    pick(Number(event.key) - 1);
    return true;
  }
  return false;
}

export function readingsListDestroy() {
  readingsListHide();
  listNode?.remove();
  styleNode?.remove();
  listNode = null;
  styleNode = null;
  dismissedWord = null;
}
