// Fill & Sign: rendering and editing of items placed on the page, the floating tool palette, the signature creation dialog, and the saved-signature store.
import { isFillTextRow } from '../../js/fillSign.js';

// Importing makeIconButton from toolbar.js would close an import cycle, since toolbar.js imports viewer.js and viewer.js imports this module.
const SIG_STORE_KEY = 'scribeSignatures';
const SIG_STORE_MAX_BYTES = 3_000_000;

const editIcon = (inner, w = 1.6) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
export const ICON_FILLSIGN = editIcon('<path d="M4 16.5c2.5-5.5 4.5-8 5.5-7s-2.2 6.8-1 7.5c1.2.7 3-2.5 4-2.2 1 .3.3 2.2 1.5 2.2 1 0 1.8-1 3-1"/>'
  + '<path d="M4 20h16"/>');

/**
 * A palette icon button with the app's toolbar-button classes.
 * @param {string} label - Tooltip text and accessible name.
 * @param {string} iconSvg - Inline SVG markup for the button icon.
 * @returns {HTMLSpanElement}
 */
function iconButton(label, iconSvg) {
  const btn = document.createElement('span');
  btn.className = 'cr-icon-button';
  btn.role = 'button';
  btn.tabIndex = 0;
  btn.title = label;
  btn.ariaLabel = label;
  btn.innerHTML = iconSvg;
  return btn;
}
const ICON_TEXT = editIcon('<path d="M5.5 6h13M12 6v13"/>');
const ICON_CHECK = editIcon('<path d="M5 12.5l5 5L19.5 6.5"/>');
const ICON_CROSS = editIcon('<path d="M6 6l12 12M18 6L6 18"/>');
const ICON_SIGN = editIcon('<path d="M3.5 17c3-6.5 5.5-9.5 6.8-8.5 1.4 1-2.7 8.2-1.2 9 1.4.8 3.6-3 4.8-2.6 1.2.4.4 2.6 1.8 2.6 1.2 0 2.1-1.2 3.6-1.2"/>');
const ICON_PLUS = editIcon('<path d="M12 5v14M5 12h14"/>');
const ICON_GRIP = editIcon('<circle cx="9" cy="7" r="1.2"/><circle cx="15" cy="7" r="1.2"/><circle cx="9" cy="12" r="1.2"/>'
  + '<circle cx="15" cy="12" r="1.2"/><circle cx="9" cy="17" r="1.2"/><circle cx="15" cy="17" r="1.2"/>', 0);

// Check/cross mark strokes in a unit box, scaled to the placement box.
const CHECK_STROKES = [[[0.1, 0.55], [0.38, 0.85], [0.9, 0.15]]];
const CROSS_STROKES = [[[0.12, 0.12], [0.88, 0.88]], [[0.88, 0.12], [0.12, 0.88]]];

// Page pixels come from the import raster, whose scale varies by document (300 dpi default, capped at 3500 px wide).
// Placement sizes are therefore in PDF points, scaled to page pixels at draw time.
const CHECK_BOX_PT = 10.56;
const CHECK_STROKE_PT = 1.2;
const SIG_BOX_W_PT = 115.2;
const SIG_BOX_H_PT = 38.4;
const ITEM_MIN_PT = 2.88;

/**
 * Page pixels per PDF point for page `n`, falling back to the 300 dpi import default when the page size or rendered width is unavailable.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 * @returns {number}
 */
function pxPerPt(viewer, n) {
  const pts = viewer.doc?.inputData?.pageStats?.[n]?.pageSize;
  const width = viewer.doc?.pageMetrics?.[n]?.dims?.width;
  if (!pts || !pts[0] || !width) return 300 / 72;
  return width / pts[0];
}

export const SIGNATURE_FONTS = [
  { name: 'Alex Brush', file: 'AlexBrush-Regular.ttf' },
  { name: 'Bad Script', file: 'BadScript-Regular.ttf' },
  { name: 'Ms Madi', file: 'MsMadi-Regular.ttf' },
  { name: 'Sacramento', file: 'Sacramento-Regular.ttf' },
];
let fontsLoaded = null;

/**
 * Load the bundled signature fonts once, registering them on the document for both the preview text and canvas rasterization.
 * @returns {Promise<void[]>} Resolves once every font has loaded or failed to load.
 */
function ensureSignatureFonts() {
  if (fontsLoaded) return fontsLoaded;
  fontsLoaded = Promise.all(SIGNATURE_FONTS.map(async (f) => {
    try {
      const buf = await fetch(new URL(`../../fonts/signature/${f.file}`, import.meta.url)).then((r) => r.arrayBuffer());
      const face = new FontFace(f.name, buf);
      await face.load();
      document.fonts.add(face);
    } catch { /* preview falls back to cursive */ }
  }));
  return fontsLoaded;
}

// Saved-signature store: signatures are a user asset, so they live in localStorage rather than in the .scribe file.

/**
 * A signature drawn by hand, saved as stroke polylines.
 * @typedef {Object} SignatureDrawn
 * @property {string} id
 * @property {'draw'} kind
 * @property {Array<Array<[number, number]>>} strokes - Polylines anchored at the origin.
 *   Placement rescales them to the target box, so only their proportions carry over.
 * @property {number} width - Stroke width in the same units as `strokes`.
 */

/**
 * A signature rasterized to a PNG, either typed in a script font or uploaded as an image.
 * `w` and `h` size the placement box, which need not match the PNG's pixel dimensions.
 * @typedef {Object} SignatureRaster
 * @property {string} id
 * @property {'type'|'image'} kind
 * @property {string} png - PNG data URL.
 * @property {number} w
 * @property {number} h
 * @property {string} [text] - The typed text, absent for an uploaded image.
 * @property {string} [font] - The signature font family, absent for an uploaded image.
 */

/**
 * A signature in the saved-signature store.
 * @typedef {SignatureDrawn | SignatureRaster} SignatureAsset
 */

/**
 * The saved signatures, oldest first.
 * @returns {SignatureAsset[]}
 */
export function loadSignatures() {
  try {
    const arr = JSON.parse(localStorage.getItem(SIG_STORE_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

/**
 * Add a signature to the saved-signature store, dropping the oldest entries to fit the size cap.
 * @param {SignatureAsset} sig
 * @returns {boolean} Whether the signature was saved.
 */
export function saveSignature(sig) {
  const arr = loadSignatures();
  arr.push(sig);
  let json = JSON.stringify(arr);
  for (let i = 0; i < 20 && json.length > SIG_STORE_MAX_BYTES && arr.length > 1; i++) {
    arr.shift();
    json = JSON.stringify(arr);
  }
  if (json.length > SIG_STORE_MAX_BYTES) return false;
  try { localStorage.setItem(SIG_STORE_KEY, json); return true; } catch { return false; }
}

export function deleteSignature(id) {
  const arr = loadSignatures().filter((s) => s.id !== id);
  try { localStorage.setItem(SIG_STORE_KEY, JSON.stringify(arr)); } catch { /* ignore */ }
}

// Live items layer and selection.

/**
 * A placed fill & sign item, either drawn ink, a signature stamp, or typed text.
 * @typedef {AnnotationInk | AnnotationStamp | AnnotationFreeText} FillItemRow
 */

/** @type {WeakMap<object, {n: number, row: FillItemRow}>} Selected item per viewer. */
const selectionByViewer = new WeakMap();

/** @type {WeakMap<Element, {n: number, row: FillItemRow}>} Rendered item element -> its row, for right-click targeting. */
const itemElems = new WeakMap();

/**
 * The armed item's placement ghost per viewer, where `n` is the page it currently hovers, or -1 when hidden.
 * @type {WeakMap<object, {el: HTMLDivElement, n: number}>}
 */
const ghostByViewer = new WeakMap();

/**
 * The placed fill & sign item (ink, stamp, or typed text) whose rendered element contains `target`, or null.
 * @param {?EventTarget} target
 * @returns {?{n: number, row: FillItemRow}}
 */
export function fillItemFromTarget(target) {
  const el = target instanceof Element ? target.closest('.scribe-item') : null;
  return (el && itemElems.get(el)) || null;
}

/**
 * Select one placed item, re-rendering the previously selected page along with this one.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 * @param {FillItemRow} row
 */
export function selectFillItem(viewer, n, row) {
  const prev = selectionByViewer.get(viewer);
  selectionByViewer.set(viewer, { n, row });
  if (prev && prev.n !== n) viewer.renderFillItems(prev.n);
  viewer.renderFillItems(n);
}

/**
 * Re-render page `n` after its placed items changed, and report the edit to the viewer.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 */
function refreshItems(viewer, n) {
  viewer.renderFillItems(n);
  // A placed item can cover an unsigned signature field, whose sign-here affordance then drops.
  viewer.renderFormFields(n);
  if (viewer.onEditCallback) viewer.onEditCallback();
}

/**
 * The viewer's selected placed item, or null when nothing is selected.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @returns {?{n: number, row: FillItemRow}}
 */
export function selectedFillItem(viewer) {
  return selectionByViewer.get(viewer) || null;
}

/**
 * Clear the viewer's item selection, re-rendering the page that held it.
 * @param {import('../viewer.js').ScribeViewer} viewer
 */
export function deselectFillItem(viewer) {
  const sel = selectionByViewer.get(viewer);
  if (!sel) return;
  selectionByViewer.delete(viewer);
  viewer.renderFillItems(sel.n);
}

/**
 * Delete the viewer's selected item from the page's annotations.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @returns {boolean} Whether an item was selected to delete.
 */
export function deleteSelectedFillItem(viewer) {
  const sel = selectionByViewer.get(viewer);
  if (!sel) return false;
  // A typed-text item's lifted words go with it.
  if (sel.row.type === 'freetext' && isFillTextRow(sel.row)) {
    sel.row.contents = '';
    viewer.doc.syncFillText(sel.n, sel.row);
  }
  const rows = viewer.doc.annotations.pages[sel.n] || [];
  const idx = rows.indexOf(sel.row);
  if (idx >= 0) rows.splice(idx, 1);
  selectionByViewer.delete(viewer);
  refreshItems(viewer, sel.n);
  return true;
}

// Typed-text in-place editor.

const FILL_TEXT_PT = 11;

/** @type {WeakMap<object, {n: number, row: AnnotationFreeText, el: HTMLDivElement, onOutside: (e: Event) => void}>} Open editor per viewer. */
const editingByViewer = new WeakMap();

/**
 * Commit the open typed-text editor by writing its text back to the row and re-lifting its words, or delete the row when the text is empty.
 * @param {import('../viewer.js').ScribeViewer} viewer
 */
export function closeFillTextEditor(viewer) {
  const editing = editingByViewer.get(viewer);
  if (!editing) return;
  editingByViewer.delete(viewer);
  document.removeEventListener('pointerdown', editing.onOutside, true);
  const contents = (editing.el.isConnected ? editing.el.innerText : editing.row.contents).replace(/\s+$/, '');
  editing.el.remove();
  const prevBbox = { ...editing.row.bbox };
  if (contents.trim().length === 0) {
    editing.row.contents = '';
    viewer.doc.syncFillText(editing.n, editing.row);
    const rows = viewer.doc.annotations.pages[editing.n] || [];
    const idx = rows.indexOf(editing.row);
    if (idx >= 0) rows.splice(idx, 1);
    const sel = selectionByViewer.get(viewer);
    if (sel && sel.row === editing.row) selectionByViewer.delete(viewer);
  } else {
    editing.row.contents = contents;
    viewer.doc.syncFillText(editing.n, editing.row, prevBbox);
    selectionByViewer.set(viewer, { n: editing.n, row: editing.row });
  }
  refreshItems(viewer, editing.n);
}

/**
 * Open the in-place editor over a typed-text row (new or existing).
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 * @param {AnnotationFreeText} row
 */
export function openFillTextEditor(viewer, n, row) {
  closeFillTextEditor(viewer);
  const group = viewer.getItemsGroup(n);
  if (!group) return;
  selectionByViewer.delete(viewer);
  const ed = document.createElement('div');
  ed.className = 'scribe-item scribe-item-text scribe-item-text-editing';
  try {
    ed.contentEditable = 'plaintext-only';
  } catch {
    ed.contentEditable = 'true';
  }
  ed.style.left = `${row.bbox.left}px`;
  ed.style.top = `${row.bbox.top}px`;
  ed.style.fontSize = `${row.fontSize}px`;
  ed.style.minWidth = `${row.fontSize}px`;
  ed.style.minHeight = `${row.fontSize * 1.2}px`;
  ed.innerText = row.contents || '';
  ed.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeFillTextEditor(viewer);
    }
  });
  // This capture-phase handler does not consume the press, so clicking another item mid-edit commits this editor first and selects that item second.
  const onOutside = (e) => {
    if (e.target instanceof Node && ed.contains(e.target)) return;
    closeFillTextEditor(viewer);
  };
  const editing = {
    n, row, el: ed, onOutside,
  };
  editingByViewer.set(viewer, editing);
  // renderPageFillItems replaces the layer's children, so the editor is appended after it.
  renderPageFillItems(viewer, n);
  group.appendChild(ed);
  document.addEventListener('pointerdown', onOutside, true);
  ed.focus();
  const range = document.createRange();
  range.selectNodeContents(ed);
  range.collapse(false);
  const domSel = window.getSelection();
  domSel?.removeAllRanges();
  domSel?.addRange(range);
}

/**
 * Render (or re-render) page n's fill & sign items and freetext/shape comment rows into the page's items layer.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 */
export function renderPageFillItems(viewer, n) {
  const group = viewer.getItemsGroup(n);
  if (!group) return;
  group.replaceChildren();
  const rows = viewer.doc.annotations.pages[n] || [];
  const sel = selectionByViewer.get(viewer);
  const svgNS = 'http://www.w3.org/2000/svg';

  const editing = editingByViewer.get(viewer);
  for (const row of rows) {
    // A typed-text row whose editor is open is represented by the editor, not the item.
    if (editing && editing.row === row) continue;
    const isFillText = row.type === 'freetext' && isFillTextRow(row);
    if (row.type === 'ink' || row.type === 'stamp' || isFillText) {
      const el = document.createElement('div');
      el.className = 'scribe-item';
      el.style.left = `${row.bbox.left}px`;
      el.style.top = `${row.bbox.top}px`;
      el.style.width = `${row.bbox.right - row.bbox.left}px`;
      el.style.height = `${row.bbox.bottom - row.bbox.top}px`;
      if (isFillText) {
        el.classList.add('scribe-item-text');
        el.style.fontSize = `${row.fontSize}px`;
        el.textContent = row.contents || '';
      } else if (row.type === 'ink') {
        const w = row.bbox.right - row.bbox.left;
        const h = row.bbox.bottom - row.bbox.top;
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        svg.setAttribute('class', 'scribe-item-ink');
        for (const stroke of row.strokes) {
          const path = document.createElementNS(svgNS, 'path');
          let d = '';
          for (let p = 0; p < stroke.length; p++) {
            d += `${p === 0 ? 'M' : 'L'}${stroke[p][0] - row.bbox.left} ${stroke[p][1] - row.bbox.top}`;
          }
          if (stroke.length === 1) d += `L${stroke[0][0] - row.bbox.left} ${stroke[0][1] - row.bbox.top}`;
          path.setAttribute('d', d);
          path.setAttribute('stroke', row.color || '#000000');
          path.setAttribute('stroke-width', String(row.width));
          svg.appendChild(path);
        }
        el.appendChild(svg);
      } else if (row.type === 'stamp') {
        const img = document.createElement('img');
        img.className = 'scribe-item-img';
        img.src = row.imageData;
        img.draggable = false;
        el.appendChild(img);
      }
      if (sel && sel.row === row) {
        el.classList.add('scribe-item-sel');
        for (const corner of ['nw', 'ne', 'sw', 'se']) {
          const dot = document.createElement('div');
          dot.className = `scribe-item-dot scribe-item-dot-${corner}`;
          dot.dataset.corner = corner;
          el.appendChild(dot);
        }
      }
      wireItemPointer(viewer, n, row, el);
      itemElems.set(el, { n, row });
      group.appendChild(el);
      continue;
    }

    if (row.type === 'freetext') {
      const el = document.createElement('div');
      el.className = 'scribe-item-freetext';
      el.style.left = `${row.bbox.left}px`;
      el.style.top = `${row.bbox.top}px`;
      el.style.width = `${row.bbox.right - row.bbox.left}px`;
      el.style.minHeight = `${row.bbox.bottom - row.bbox.top}px`;
      el.style.fontSize = `${row.fontSize}px`;
      el.style.color = row.textColor || '#000000';
      if (row.fillColor) el.style.background = row.fillColor;
      el.style.opacity = String(row.opacity ?? 1);
      el.textContent = row.contents || '';
      group.appendChild(el);
    } else if (row.type === 'square' || row.type === 'circle') {
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('class', 'scribe-item-shape');
      const w = row.bbox.right - row.bbox.left;
      const h = row.bbox.bottom - row.bbox.top;
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      svg.style.left = `${row.bbox.left}px`;
      svg.style.top = `${row.bbox.top}px`;
      svg.style.width = `${w}px`;
      svg.style.height = `${h}px`;
      const bw = row.borderWidth ?? 1;
      const shape = row.type === 'square'
        ? document.createElementNS(svgNS, 'rect')
        : document.createElementNS(svgNS, 'ellipse');
      if (row.type === 'square') {
        shape.setAttribute('x', String(bw / 2));
        shape.setAttribute('y', String(bw / 2));
        shape.setAttribute('width', String(Math.max(0, w - bw)));
        shape.setAttribute('height', String(Math.max(0, h - bw)));
      } else {
        shape.setAttribute('cx', String(w / 2));
        shape.setAttribute('cy', String(h / 2));
        shape.setAttribute('rx', String(Math.max(0, w / 2 - bw / 2)));
        shape.setAttribute('ry', String(Math.max(0, h / 2 - bw / 2)));
      }
      shape.setAttribute('stroke', row.borderColor || '#ff0000');
      shape.setAttribute('stroke-width', String(bw));
      shape.setAttribute('fill', row.fillColor || 'none');
      shape.setAttribute('opacity', String(row.opacity ?? 1));
      svg.appendChild(shape);
      group.appendChild(svg);
    } else if (row.type === 'line' && Array.isArray(row.points)) {
      const [x1, y1, x2, y2] = row.points;
      const left = Math.min(x1, x2);
      const top = Math.min(y1, y2);
      const w = Math.max(1, Math.abs(x2 - x1));
      const h = Math.max(1, Math.abs(y2 - y1));
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('class', 'scribe-item-shape');
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      svg.style.left = `${left}px`;
      svg.style.top = `${top}px`;
      svg.style.width = `${w}px`;
      svg.style.height = `${h}px`;
      const line = document.createElementNS(svgNS, 'line');
      line.setAttribute('x1', String(x1 - left));
      line.setAttribute('y1', String(y1 - top));
      line.setAttribute('x2', String(x2 - left));
      line.setAttribute('y2', String(y2 - top));
      line.setAttribute('stroke', row.borderColor || '#ff0000');
      line.setAttribute('stroke-width', String(row.borderWidth ?? 1));
      line.setAttribute('opacity', String(row.opacity ?? 1));
      svg.appendChild(line);
      group.appendChild(svg);
    } else if ((row.type === 'polygon' || row.type === 'polyline') && Array.isArray(row.vertices)) {
      const xs = row.vertices.filter((_, i) => i % 2 === 0);
      const ys = row.vertices.filter((_, i) => i % 2 === 1);
      const left = Math.min(...xs);
      const top = Math.min(...ys);
      const w = Math.max(1, Math.max(...xs) - left);
      const h = Math.max(1, Math.max(...ys) - top);
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('class', 'scribe-item-shape');
      svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
      svg.style.left = `${left}px`;
      svg.style.top = `${top}px`;
      svg.style.width = `${w}px`;
      svg.style.height = `${h}px`;
      const poly = document.createElementNS(svgNS, row.type === 'polygon' ? 'polygon' : 'polyline');
      poly.setAttribute('points', xs.map((x, i) => `${x - left},${ys[i] - top}`).join(' '));
      poly.setAttribute('stroke', row.borderColor || '#ff0000');
      poly.setAttribute('stroke-width', String(row.borderWidth ?? 1));
      poly.setAttribute('fill', row.type === 'polygon' ? (row.fillColor || 'none') : 'none');
      poly.setAttribute('opacity', String(row.opacity ?? 1));
      svg.appendChild(poly);
      group.appendChild(svg);
    }
  }

  const ghost = ghostByViewer.get(viewer);
  if (ghost && ghost.n === n) group.appendChild(ghost.el);
}

/**
 * Wire the pointer gestures on one placed item: click selects, drag moves, corner dots resize, and double-click edits a typed-text item.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 * @param {FillItemRow} row
 * @param {HTMLDivElement} el
 */
function wireItemPointer(viewer, n, row, el) {
  if (row.type === 'freetext') {
    el.addEventListener('dblclick', () => openFillTextEditor(viewer, n, row));
  }
  el.addEventListener('pointerdown', (down) => {
    if (down.button !== 0) return;
    down.stopPropagation();
    const corner = down.target instanceof HTMLElement ? down.target.dataset.corner : null;
    const startX = down.clientX;
    const startY = down.clientY;
    const startBbox = { ...row.bbox };
    const startFontSize = row.type === 'freetext' ? row.fontSize : 0;
    const startStrokes = row.type === 'ink' ? row.strokes.map((s) => s.map(([x, y]) => [x, y])) : null;
    const rect = el.getBoundingClientRect();
    const pxPerClient = (startBbox.right - startBbox.left) / Math.max(1, rect.width);
    let moved = false;

    const onMove = (mv) => {
      const dx = (mv.clientX - startX) * pxPerClient;
      const dy = (mv.clientY - startY) * pxPerClient;
      if (!moved && Math.abs(mv.clientX - startX) + Math.abs(mv.clientY - startY) < 3) return;
      moved = true;
      if (selectionByViewer.get(viewer)?.row !== row) {
        selectionByViewer.set(viewer, { n, row });
      }
      if (!corner) {
        row.bbox.left = startBbox.left + dx;
        row.bbox.right = startBbox.right + dx;
        row.bbox.top = startBbox.top + dy;
        row.bbox.bottom = startBbox.bottom + dy;
        if (row.type === 'ink' && startStrokes) row.strokes = startStrokes.map((s) => s.map(([x, y]) => [x + dx, y + dy]));
      } else {
        const minSize = ITEM_MIN_PT * pxPerPt(viewer, n);
        const startW = startBbox.right - startBbox.left;
        const startH = startBbox.bottom - startBbox.top;
        const anchorX = corner.includes('w') ? startBbox.right : startBbox.left;
        const anchorY = corner.includes('n') ? startBbox.bottom : startBbox.top;
        const movingX = (corner.includes('w') ? startBbox.left : startBbox.right) + dx;
        const movingY = (corner.includes('n') ? startBbox.top : startBbox.bottom) + dy;
        const s = Math.max(Math.abs(movingX - anchorX) / startW, Math.abs(movingY - anchorY) / startH);
        const newW = startW * s;
        const newH = startH * s;
        if (newW < minSize || newH < minSize) return;
        const newLeft = corner.includes('w') ? anchorX - newW : anchorX;
        const newTop = corner.includes('n') ? anchorY - newH : anchorY;
        row.bbox = {
          left: newLeft, top: newTop, right: newLeft + newW, bottom: newTop + newH,
        };
        if (row.type === 'ink' && startStrokes) {
          row.strokes = startStrokes.map((st) => st.map(([x, y]) => [
            newLeft + (x - startBbox.left) * s,
            newTop + (y - startBbox.top) * s,
          ]));
        }
        if (row.type === 'freetext') row.fontSize = startFontSize * s;
      }
      renderPageFillItems(viewer, n);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (moved) {
        if (row.type === 'freetext' && isFillTextRow(row)) viewer.doc.syncFillText(n, row, startBbox);
        refreshItems(viewer, n);
      } else {
        selectFillItem(viewer, n, row);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

// Placement.

/**
 * Fit a `w` by `h` box into `boxW` by `boxH`, preserving aspect ratio.
 * @param {number} w
 * @param {number} h
 * @param {number} boxW
 * @param {number} boxH
 * @returns {{w: number, h: number}}
 */
function fitInto(w, h, boxW, boxH) {
  const s = Math.min(boxW / Math.max(1, w), boxH / Math.max(1, h));
  return { w: w * s, h: h * s };
}

/**
 * Place a saved signature asset centered in a page rect, or at a default size centered on the rect's top-left when it spans zero area.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 * @param {SignatureAsset} asset
 * @param {bbox} rect - Target area in page coordinates.
 * @returns {AnnotationInk|AnnotationStamp} The created annotation row.
 */
export function placeSignatureAsset(viewer, n, asset, rect) {
  const natural = asset.kind === 'draw'
    ? {
      w: Math.max(...asset.strokes.flat().map((p) => p[0])) + asset.width,
      h: Math.max(...asset.strokes.flat().map((p) => p[1])) + asset.width,
    }
    : { w: asset.w, h: asset.h };
  const r = pxPerPt(viewer, n);
  const boxW = rect.right - rect.left || SIG_BOX_W_PT * r;
  const boxH = rect.bottom - rect.top || SIG_BOX_H_PT * r;
  const { w, h } = fitInto(natural.w, natural.h, boxW, boxH);
  const cx = (rect.left + rect.right) / 2 || rect.left;
  const cy = (rect.top + rect.bottom) / 2 || rect.top;
  const left = cx - w / 2;
  const top = cy - h / 2;
  let row;
  if (asset.kind === 'draw') {
    const s = w / natural.w;
    row = viewer.doc.addInk(n, {
      strokes: asset.strokes.map((st) => st.map(([x, y]) => [left + x * s, top + y * s])),
      width: Math.max(0.36 * r, asset.width * s),
      color: '#101010',
    });
  } else {
    row = viewer.doc.addStamp(n, {
      bbox: {
        left, top, right: left + w, bottom: top + h,
      },
      imageData: asset.png,
    });
  }
  selectionByViewer.set(viewer, { n, row });
  refreshItems(viewer, n);
  return row;
}

/**
 * Sign an unsigned signature field: place the most recently saved signature into its rect, or open the creation dialog first when none is saved yet.
 * @param {import('../basic-viewer/pdf-viewer.js').ScribePDFViewer} app
 * @param {number} n
 * @param {AnnotationField} fieldRow
 */
export function signIntoField(app, n, fieldRow) {
  const sigs = loadSignatures();
  const place = (asset) => placeSignatureAsset(app.scribe, n, asset, fieldRow.bbox);
  if (sigs.length > 0) place(sigs[sigs.length - 1]);
  else openSignatureDialog(app, place);
}

// Floating pill palette and arming.

/**
 * Build the Fill & Sign palette and its behaviors for one app instance.
 * @param {import('../basic-viewer/pdf-viewer.js').ScribePDFViewer} app
 * @returns {{ elem: HTMLDivElement, show: () => void, hide: () => void, isOpen: () => boolean, destroy: () => void }}
 */
export function createFillSignPalette(app) {
  const viewer = app.scribe;
  const pal = document.createElement('div');
  pal.className = 'scribe-fs-pal';
  pal.style.display = 'none';

  const grip = document.createElement('span');
  grip.className = 'scribe-fs-grip';
  grip.innerHTML = ICON_GRIP;
  pal.appendChild(grip);

  const textBtn = iconButton('Add text', ICON_TEXT);
  const checkBtn = iconButton('Check mark', ICON_CHECK);
  const crossBtn = iconButton('Cross mark', ICON_CROSS);
  const signBtn = iconButton('Signature', ICON_SIGN);
  pal.append(textBtn, checkBtn, crossBtn, signBtn);

  /** @type {null | {kind: 'text'|'check'|'cross'} | {kind: 'sig', asset: SignatureAsset}} */
  let armed = null;
  // Placement ghost: the armed item previewed under the cursor at the size a click would place it.
  /** @type {?HTMLDivElement} */
  let ghostElem = null;
  /** @type {?{el: HTMLDivElement, n: number}} */
  let ghostReg = null;
  let ghostPtW = 0;
  let ghostPtH = 0;
  const syncArmed = () => {
    textBtn.classList.toggle('active', armed?.kind === 'text');
    checkBtn.classList.toggle('active', armed?.kind === 'check');
    crossBtn.classList.toggle('active', armed?.kind === 'cross');
    signBtn.classList.toggle('active', armed?.kind === 'sig');
    viewer.elem?.classList.toggle('scribe-fs-armed', !!armed);
    // The selection engine writes a hover-derived inline cursor that beats the stylesheet rule, so the armed crosshair also goes through its cursorOverride.
    if (viewer.textSel) {
      if (armed) viewer.textSel.cursorOverride = 'crosshair';
      else if (viewer.textSel.cursorOverride === 'crosshair') viewer.textSel.cursorOverride = null;
    }
    ghostElem?.remove();
    ghostElem = null;
    ghostReg = null;
    ghostByViewer.delete(viewer);
    if (!armed) return;
    ghostElem = document.createElement('div');
    ghostElem.className = 'scribe-item scribe-item-ghost';
    ghostReg = { el: ghostElem, n: -1 };
    ghostByViewer.set(viewer, ghostReg);
    if (armed.kind === 'text') {
      ghostPtW = FILL_TEXT_PT * 0.8;
      ghostPtH = FILL_TEXT_PT * 1.2;
      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${ghostPtW} ${ghostPtH}`);
      svg.setAttribute('class', 'scribe-item-ink');
      const path = document.createElementNS(svgNS, 'path');
      path.setAttribute('d', `M${ghostPtW / 2} 0.8V${ghostPtH - 0.8}`
        + `M${ghostPtW / 2 - 1.6} 0.8h3.2M${ghostPtW / 2 - 1.6} ${ghostPtH - 0.8}h3.2`);
      path.setAttribute('stroke', '#1c62d4');
      path.setAttribute('stroke-width', '0.9');
      svg.appendChild(path);
      ghostElem.appendChild(svg);
    } else if (armed.kind === 'sig' && armed.asset.kind !== 'draw') {
      ({ w: ghostPtW, h: ghostPtH } = fitInto(armed.asset.w, armed.asset.h, SIG_BOX_W_PT, SIG_BOX_H_PT));
      const img = document.createElement('img');
      img.className = 'scribe-item-img';
      img.src = armed.asset.png;
      img.draggable = false;
      ghostElem.appendChild(img);
    } else {
      let strokes;
      let width;
      let vbW;
      let vbH;
      if (armed.kind === 'sig' && armed.asset.kind === 'draw') {
        strokes = armed.asset.strokes;
        width = armed.asset.width;
        vbW = Math.max(...strokes.flat().map((p) => p[0])) + width;
        vbH = Math.max(...strokes.flat().map((p) => p[1])) + width;
        ({ w: ghostPtW, h: ghostPtH } = fitInto(vbW, vbH, SIG_BOX_W_PT, SIG_BOX_H_PT));
      } else {
        strokes = (armed.kind === 'check' ? CHECK_STROKES : CROSS_STROKES)
          .map((s) => s.map(([x, y]) => [x * CHECK_BOX_PT, y * CHECK_BOX_PT]));
        width = CHECK_STROKE_PT;
        vbW = CHECK_BOX_PT;
        vbH = CHECK_BOX_PT;
        ghostPtW = CHECK_BOX_PT;
        ghostPtH = CHECK_BOX_PT;
      }
      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('viewBox', `0 0 ${vbW} ${vbH}`);
      svg.setAttribute('class', 'scribe-item-ink');
      for (const s of strokes) {
        const path = document.createElementNS(svgNS, 'path');
        path.setAttribute('d', s.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(''));
        path.setAttribute('stroke', '#101010');
        path.setAttribute('stroke-width', String(width));
        svg.appendChild(path);
      }
      ghostElem.appendChild(svg);
    }
  };
  const disarm = () => { armed = null; syncArmed(); };

  textBtn.addEventListener('click', () => { armed = armed?.kind === 'text' ? null : { kind: 'text' }; syncArmed(); closeMenu(); });
  checkBtn.addEventListener('click', () => { armed = armed?.kind === 'check' ? null : { kind: 'check' }; syncArmed(); closeMenu(); });
  crossBtn.addEventListener('click', () => { armed = armed?.kind === 'cross' ? null : { kind: 'cross' }; syncArmed(); closeMenu(); });

  // Signature menu: saved signatures + create.
  let menu = null;
  const closeMenu = () => { menu?.remove(); menu = null; };
  const armSig = (sig) => { armed = { kind: 'sig', asset: sig }; syncArmed(); closeMenu(); };
  const openMenu = () => {
    closeMenu();
    menu = document.createElement('div');
    menu.className = 'scribe-fs-menu';
    const sigs = loadSignatures();
    for (const sig of sigs) {
      const it = document.createElement('div');
      it.className = 'scribe-fs-menu-item';
      const prev = document.createElement('span');
      prev.className = 'scribe-fs-menu-prev';
      if (sig.kind === 'draw') {
        const xs = sig.strokes.flat().map((p) => p[0]);
        const ys = sig.strokes.flat().map((p) => p[1]);
        const w = Math.max(...xs) + sig.width;
        const h = Math.max(...ys) + sig.width;
        prev.innerHTML = `<svg viewBox="0 0 ${w} ${h}">${sig.strokes.map((s) => `<path d="${s.map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join('')}" fill="none" stroke="#101010" stroke-width="${sig.width}" stroke-linecap="round" stroke-linejoin="round"/>`).join('')}</svg>`;
      } else {
        prev.innerHTML = `<img src="${sig.png}" alt="">`;
      }
      it.appendChild(prev);
      const del = document.createElement('span');
      del.className = 'scribe-fs-menu-del';
      del.textContent = '×';
      del.title = 'Delete signature';
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteSignature(sig.id); openMenu(); });
      it.appendChild(del);
      it.addEventListener('click', () => armSig(sig));
      menu.appendChild(it);
    }
    const add = document.createElement('div');
    add.className = 'scribe-fs-menu-item scribe-fs-menu-add';
    add.innerHTML = `<span class="scribe-fs-menu-ic">${ICON_PLUS}</span>Add signature…`;
    add.addEventListener('click', () => {
      closeMenu();
      openSignatureDialog(app, (sig) => { armed = { kind: 'sig', asset: sig }; syncArmed(); });
    });
    menu.appendChild(add);
    pal.appendChild(menu);
  };
  signBtn.addEventListener('click', () => {
    if (armed?.kind === 'sig') { disarm(); closeMenu(); return; }
    if (menu) closeMenu(); else openMenu();
  });

  /**
   * Add a check or cross mark scaled to fill a square placement box on page n.
   * @param {number} n
   * @param {'check'|'cross'} kind
   * @param {number} left Box left edge in page pixels.
   * @param {number} top Box top edge in page pixels.
   * @param {number} side Box side length in page pixels.
   */
  const placeMarkInSquare = (n, kind, left, top, side) => {
    const unit = kind === 'cross' ? CROSS_STROKES : CHECK_STROKES;
    viewer.doc.addInk(n, {
      strokes: unit.map((s) => s.map(([x, y]) => [left + x * side, top + y * side])),
      width: (CHECK_STROKE_PT / CHECK_BOX_PT) * side,
      color: '#101010',
    });
    refreshItems(viewer, n);
  };

  // While armed, the press is handled in the capture phase and stopped there, so text selection never sees it.
  const onScrollPress = (e) => {
    if (e.button !== 0) return;
    if (e.target instanceof Element && (pal.contains(e.target))) return;
    if (!armed) return;
    const pt = viewer.clientToPage(e.clientX, e.clientY);
    if (pt == null || pt.n == null || pt.n < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const r = pxPerPt(viewer, pt.n);
    if (armed.kind === 'sig') {
      placeSignatureAsset(viewer, pt.n, armed.asset, {
        left: pt.x - (SIG_BOX_W_PT / 2) * r,
        top: pt.y - (SIG_BOX_H_PT / 2) * r,
        right: pt.x + (SIG_BOX_W_PT / 2) * r,
        bottom: pt.y + (SIG_BOX_H_PT / 2) * r,
      });
      disarm();
    } else if (armed.kind === 'text') {
      const fontSize = FILL_TEXT_PT * r;
      const row = viewer.doc.addFillText(pt.n, {
        x: pt.x, y: pt.y - fontSize * 0.6, contents: '', fontSize,
      });
      disarm();
      openFillTextEditor(viewer, pt.n, row);
    } else {
      // Check/cross placement stays armed: forms need many of them.
      const box = CHECK_BOX_PT * r;
      placeMarkInSquare(pt.n, armed.kind, pt.x - box / 2, pt.y - box / 2, box);
    }
  };

  const onScrollMove = (e) => {
    if (!armed || !ghostElem) return;
    const pt = viewer.clientToPage(e.clientX, e.clientY);
    const onPage = pt != null && pt.n != null && pt.n >= 0;
    const group = onPage ? viewer.getItemsGroup(pt.n) : null;
    if (!group) {
      ghostElem.remove();
      if (ghostReg) ghostReg.n = -1;
      return;
    }
    if (ghostElem.parentNode !== group) group.appendChild(ghostElem);
    if (ghostReg) ghostReg.n = pt.n;
    const r = pxPerPt(viewer, pt.n);
    const w = ghostPtW * r;
    const h = ghostPtH * r;
    ghostElem.style.width = `${w}px`;
    ghostElem.style.height = `${h}px`;
    ghostElem.style.left = `${pt.x - w / 2}px`;
    ghostElem.style.top = `${pt.y - h / 2}px`;
  };
  const onScrollLeave = () => {
    ghostElem?.remove();
    if (ghostReg) ghostReg.n = -1;
  };

  const onKey = (e) => {
    const t = document.activeElement;
    if (t instanceof HTMLElement && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable)) return;
    if (e.key === 'Escape') {
      if (menu) { closeMenu(); return; }
      if (armed) { disarm(); return; }
      deselectFillItem(viewer);
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedFillItem(viewer)) {
      e.preventDefault();
      deleteSelectedFillItem(viewer);
    }
  };

  let dragOff = null;
  pal.addEventListener('pointerdown', (down) => {
    if (down.target instanceof Element && down.target.closest('.cr-icon-button, .scribe-fs-menu')) return;
    const r = pal.getBoundingClientRect();
    dragOff = { x: down.clientX - r.left, y: down.clientY - r.top };
    const onMove = (mv) => {
      if (!dragOff) return;
      pal.style.left = `${mv.clientX - dragOff.x}px`;
      pal.style.top = `${mv.clientY - dragOff.y}px`;
      pal.style.bottom = 'auto';
      pal.style.transform = 'none';
    };
    const onUp = () => {
      dragOff = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });

  const show = () => {
    pal.style.display = '';
    document.addEventListener('keydown', onKey);
    viewer.scrollContainer?.addEventListener('pointerdown', onScrollPress, true);
    viewer.scrollContainer?.addEventListener('pointermove', onScrollMove);
    viewer.scrollContainer?.addEventListener('pointerleave', onScrollLeave);
  };
  const hide = () => {
    pal.style.display = 'none';
    disarm();
    closeMenu();
    closeFillTextEditor(viewer);
    deselectFillItem(viewer);
    document.removeEventListener('keydown', onKey);
    viewer.scrollContainer?.removeEventListener('pointerdown', onScrollPress, true);
    viewer.scrollContainer?.removeEventListener('pointermove', onScrollMove);
    viewer.scrollContainer?.removeEventListener('pointerleave', onScrollLeave);
  };
  return {
    elem: pal,
    show,
    hide,
    isOpen: () => pal.style.display !== 'none',
    destroy: () => { hide(); pal.remove(); },
  };
}

// Signature creation dialog (centered modal: draw / type / image).

/**
 * Opens the modal dialog for creating a signature by drawing, typing, or uploading an image, and passes the new signature to onSaved.
 * @param {import('../basic-viewer/pdf-viewer.js').ScribePDFViewer} app
 * @param {(sig: SignatureAsset) => void} onSaved
 */
export function openSignatureDialog(app, onSaved) {
  const host = app.pdfViewerElem || document.body;
  const scrim = document.createElement('div');
  scrim.className = 'scribe-fs-scrim';
  const dlg = document.createElement('div');
  dlg.className = 'scribe-fs-dialog';
  dlg.role = 'dialog';
  dlg.ariaModal = 'true';
  scrim.appendChild(dlg);

  const title = document.createElement('div');
  title.className = 'scribe-fs-dlg-title';
  title.textContent = 'Add signature';
  dlg.appendChild(title);

  const tabs = document.createElement('div');
  tabs.className = 'scribe-fs-tabs';
  const body = document.createElement('div');
  body.className = 'scribe-fs-dlg-body';
  dlg.append(tabs, body);

  const foot = document.createElement('div');
  foot.className = 'scribe-fs-dlg-foot';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'scribe-fs-btn';
  cancelBtn.textContent = 'Cancel';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'scribe-fs-btn scribe-fs-btn-primary';
  saveBtn.textContent = 'Save signature';
  foot.append(cancelBtn, saveBtn);
  dlg.appendChild(foot);

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    scrim.remove();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
  };
  document.addEventListener('keydown', onKey, true);
  scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) close(); });
  cancelBtn.addEventListener('click', close);

  // Draw tab
  const drawPane = document.createElement('div');
  const drawCanvas = document.createElement('canvas');
  drawCanvas.className = 'scribe-fs-draw';
  const DRAW_W = 560;
  const DRAW_H = 180;
  drawCanvas.width = DRAW_W * 2;
  drawCanvas.height = DRAW_H * 2;
  const dctx = /** @type {CanvasRenderingContext2D } */ (drawCanvas.getContext('2d'));
  dctx.scale(2, 2);
  dctx.lineWidth = 4.5;
  dctx.lineCap = 'round';
  dctx.lineJoin = 'round';
  dctx.strokeStyle = '#101010';
  /** @type {Array<Array<[number, number]>>} */
  let drawStrokes = [];
  /** @type {?Array<[number, number]>} */
  let curStroke = null;
  drawCanvas.addEventListener('pointerdown', (e) => {
    const r = drawCanvas.getBoundingClientRect();
    curStroke = [[e.clientX - r.left, e.clientY - r.top]];
    drawStrokes.push(curStroke);
    try { drawCanvas.setPointerCapture(e.pointerId); } catch { /* setPointerCapture throws for synthetic pointer events */ }
  });
  drawCanvas.addEventListener('pointermove', (e) => {
    if (!curStroke) return;
    const r = drawCanvas.getBoundingClientRect();
    curStroke.push([e.clientX - r.left, e.clientY - r.top]);
    dctx.clearRect(0, 0, DRAW_W, DRAW_H);
    for (const s of drawStrokes) {
      dctx.beginPath();
      s.forEach(([x, y], i) => (i ? dctx.lineTo(x, y) : dctx.moveTo(x, y)));
      dctx.stroke();
    }
  });
  drawCanvas.addEventListener('pointerup', () => { curStroke = null; });
  const drawClear = document.createElement('button');
  drawClear.className = 'scribe-fs-btn';
  drawClear.textContent = 'Clear';
  drawClear.addEventListener('click', () => { drawStrokes = []; curStroke = null; dctx.clearRect(0, 0, DRAW_W, DRAW_H); });
  drawPane.append(drawCanvas, drawClear);

  // Type tab
  const typePane = document.createElement('div');
  const typeInput = document.createElement('input');
  typeInput.className = 'scribe-fs-type-input';
  typeInput.placeholder = 'Type your name';
  typeInput.maxLength = 60;
  const fontRow = document.createElement('div');
  fontRow.className = 'scribe-fs-fonts';
  let typeFont = SIGNATURE_FONTS[0].name;
  const fontBtns = SIGNATURE_FONTS.map((f) => {
    const b = document.createElement('button');
    b.className = 'scribe-fs-font';
    b.style.fontFamily = `'${f.name}', cursive`;
    b.textContent = f.name;
    b.addEventListener('click', () => {
      typeFont = f.name;
      for (const other of fontBtns) other.classList.toggle('active', other === b);
      renderTypePreview();
    });
    fontRow.appendChild(b);
    return b;
  });
  fontBtns[0].classList.add('active');
  const typePreview = document.createElement('div');
  typePreview.className = 'scribe-fs-type-preview';
  const renderTypePreview = () => {
    typePreview.style.fontFamily = `'${typeFont}', cursive`;
    typePreview.textContent = typeInput.value || 'John Hancock';
  };
  typeInput.addEventListener('input', renderTypePreview);
  ensureSignatureFonts().then(renderTypePreview);
  renderTypePreview();
  typePane.append(typeInput, fontRow, typePreview);

  // Image tab
  const imagePane = document.createElement('div');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/png,image/jpeg';
  fileInput.className = 'scribe-fs-file';
  const bgToggleLabel = document.createElement('label');
  bgToggleLabel.className = 'scribe-fs-bgtoggle';
  const bgToggle = document.createElement('input');
  bgToggle.type = 'checkbox';
  bgToggle.checked = true;
  bgToggleLabel.append(bgToggle, document.createTextNode(' Remove white background'));
  const imgPreview = document.createElement('canvas');
  imgPreview.className = 'scribe-fs-img-preview';
  /** @type {?HTMLImageElement} */
  let uploadedImg = null;
  const renderImagePreview = () => {
    const ctx2 = /** @type {CanvasRenderingContext2D } */ (imgPreview.getContext('2d'));
    ctx2.clearRect(0, 0, imgPreview.width, imgPreview.height);
    if (!uploadedImg) return;
    const scale = Math.min(1, 560 / uploadedImg.naturalWidth, 180 / uploadedImg.naturalHeight);
    imgPreview.width = Math.max(1, Math.round(uploadedImg.naturalWidth * scale));
    imgPreview.height = Math.max(1, Math.round(uploadedImg.naturalHeight * scale));
    ctx2.drawImage(uploadedImg, 0, 0, imgPreview.width, imgPreview.height);
    if (bgToggle.checked) {
      const data = ctx2.getImageData(0, 0, imgPreview.width, imgPreview.height);
      for (let p = 0; p < data.data.length; p += 4) {
        if (data.data[p] > 228 && data.data[p + 1] > 228 && data.data[p + 2] > 228) data.data[p + 3] = 0;
      }
      ctx2.putImageData(data, 0, 0);
    }
  };
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => { uploadedImg = img; renderImagePreview(); };
    img.src = URL.createObjectURL(file);
  });
  bgToggle.addEventListener('change', renderImagePreview);
  imagePane.append(fileInput, bgToggleLabel, imgPreview);

  const panes = { Draw: drawPane, Type: typePane, Image: imagePane };
  let activeTab = 'Draw';
  // All three panes stay mounted, stacked in one grid cell, so the dialog height does not change when the tab switches.
  const showPane = (name) => {
    for (const [key, pane] of Object.entries(panes)) pane.classList.toggle('scribe-fs-pane-off', key !== name);
  };
  const tabBtns = Object.keys(panes).map((name) => {
    const b = document.createElement('button');
    b.className = 'scribe-fs-tab';
    b.textContent = name;
    b.addEventListener('click', () => {
      activeTab = name;
      for (const other of tabBtns) other.classList.toggle('active', other.textContent === name);
      showPane(name);
      if (name === 'Type') ensureSignatureFonts().then(renderTypePreview);
    });
    tabs.appendChild(b);
    return b;
  });
  tabBtns[0].classList.add('active');
  body.append(drawPane, typePane, imagePane);
  showPane('Draw');

  saveBtn.addEventListener('click', async () => {
    const id = `sig-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
    /** @type {?SignatureAsset} */
    let sig = null;
    if (activeTab === 'Draw') {
      if (drawStrokes.length === 0) return;
      const pts = drawStrokes.flat();
      const minX = Math.min(...pts.map((p) => p[0]));
      const minY = Math.min(...pts.map((p) => p[1]));
      sig = {
        id,
        kind: 'draw',
        strokes: drawStrokes.map((s) => s.map(([x, y]) => [Math.round((x - minX) * 10) / 10, Math.round((y - minY) * 10) / 10])),
        width: 4.5,
      };
    } else if (activeTab === 'Type') {
      const text = typeInput.value.trim();
      if (!text) return;
      await ensureSignatureFonts();
      // Rasterize at 4x so the placed stamp stays crisp when scaled up.
      const fontPx = 64;
      const scale = 4;
      const meas = document.createElement('canvas').getContext('2d');
      meas.font = `${fontPx}px '${typeFont}', cursive`;
      const m = meas.measureText(text);
      const pad = fontPx * 0.25;
      const ascent = m.actualBoundingBoxAscent || fontPx * 0.8;
      const descent = m.actualBoundingBoxDescent || fontPx * 0.3;
      const cw = Math.ceil(m.width + pad * 2);
      const ch = Math.ceil(ascent + descent + pad * 2);
      const cnv = document.createElement('canvas');
      cnv.width = cw * scale;
      cnv.height = ch * scale;
      const c2 = /** @type {CanvasRenderingContext2D } */ (cnv.getContext('2d'));
      c2.scale(scale, scale);
      c2.font = `${fontPx}px '${typeFont}', cursive`;
      c2.fillStyle = '#101010';
      c2.fillText(text, pad, pad + ascent);
      sig = {
        id, kind: 'type', png: cnv.toDataURL('image/png'), w: cw, h: ch, text, font: typeFont,
      };
    } else {
      if (!uploadedImg) return;
      renderImagePreview();
      sig = {
        id, kind: 'image', png: imgPreview.toDataURL('image/png'), w: imgPreview.width, h: imgPreview.height,
      };
    }
    if (!saveSignature(sig)) {
      title.textContent = 'Add signature — too large to save; it will be usable this session only';
    }
    close();
    onSaved(sig);
  });

  host.appendChild(scrim);
  typeInput.focus({ preventScroll: true });
}
