import { makeIconButton } from './controls/toolbar.js';
import { shortcutLabel } from './platform.js';
import { GlobalFonts } from '../../js/containers/fontContainer.js';
import { EDIT_FACE_FAMILIES, EDIT_FACE_FAMILY_NAMES } from '../../js/pdf/textPatch.js';
import { familiesCompatible, normalizeFamilyForMatch } from '../../js/pdf/fonts/parsePdfFonts.js';

const lineIcon = (inner) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true">${inner}</svg>`;
/**
 * Wrap SVG shape markup in a stroked icon for icon buttons at the default toolbar height, where they are 28px.
 * One unit of its 28-unit grid is one pixel, so 2-unit strokes centered on whole units cover whole pixels.
 * @param {string} inner - Path/shape markup.
 * @returns {string} The SVG markup for the icon.
 */
const barIcon = (inner) => `<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true">${inner}</svg>`;
/**
 * The text-color icon.
 * Set `--scribe-text-ink` on an ancestor to color its bar.
 */
export const TEXT_COLOR_SVG = barIcon('<path d="M8 19 14 5l6 14"/><path d="M10 14h8"/><rect class="scribe-tc-bar-ink" x="6" y="21" width="16" height="3"/>'
  // The edge is inset half a pixel, so its one-pixel outline covers the bar's border pixels exactly.
  + '<rect class="scribe-tc-bar-edge" x="6.5" y="21.5" width="15" height="2"/>');
const BOLD_SVG = barIcon('<path d="M9 5v18"/><path d="M9 5h6a4 4 0 0 1 0 8H9"/><path d="M9 13h6a5 5 0 0 1 0 10H9"/>');
const ITALIC_SVG = barIcon('<path d="M12 5h8M8 23h8M16 5l-4 18"/>');
export const FONT_SVG = barIcon('<path d="M3.5 22.5 9.5 5.5l6 17"/><path d="M5.8 16.5h7.4"/><circle cx="20.5" cy="18.3" r="3.6"/><path d="M24.1 14.7v7.8"/>');
const CHECK_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
  + ' style="display:block;width:100%;height:100%;pointer-events:none;" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>';

export const FACE_FAMILIES = [
  { id: 'NimbusRoman', name: 'Nimbus Roman' }, { id: 'NimbusSans', name: 'Nimbus Sans' }, { id: 'NimbusMono', name: 'Nimbus Mono' }, { id: 'Carlito', name: 'Carlito' },
  { id: 'Century', name: 'Century Schoolbook' }, { id: 'Garamond', name: 'Garamond' }, { id: 'Palatino', name: 'Palatino' }, { id: 'Gothic', name: 'URW Gothic' },
];
/**
 * @param {?string} fontName
 */
export const faceIdOf = (fontName) => EDIT_FACE_FAMILIES.find((id) => EDIT_FACE_FAMILY_NAMES[id] === fontName) || null;
/**
 * @param {?string} fontName
 */
export const faceNameOf = (fontName) => {
  const id = faceIdOf(fontName);
  return id ? /** @type {{name: string}} */ (FACE_FAMILIES.find((f) => f.id === id)).name : (fontName || '');
};
/**
 * @param {string} id
 */
export const faceCssFamily = (id) => {
  const raw = GlobalFonts.raw?.[id]?.normal;
  return raw?.fontFaceName ? `"${raw.fontFaceName}"` : null;
};
/**
 * @param {number} fontObjNum
 */
export const docFontIdOf = (fontObjNum) => `obj:${fontObjNum}`;
/**
 * @param {string} id
 */
export const docFontObjNumOf = (id) => (id.startsWith('obj:') ? Number(id.slice(4)) : null);
/**
 * @param {string} baseName
 */
export const docFontDisplayName = (baseName) => baseName.replace(/^[A-Z]{6}\+/, '').replace(/[-,]+/g, ' ').trim();
/**
 * Whether page `n` draws with a font of the same family as `fontObjNum` that lacks `prop` and matches `fontObjNum` in the other of bold and italic.
 * Null while a program the answer needs has not loaded.
 * `loadPageFonts` starts those loads.
 * @param {*} scribe
 * @param {number} n
 * @param {?number} fontObjNum
 * @param {'bold'|'italic'} prop
 * @returns {?boolean}
 */
export const pageHasSiblingWithout = (scribe, n, fontObjNum, prop) => {
  if (fontObjNum === null || fontObjNum === undefined) return false;
  const page = scribe.doc.ocr.active?.[n];
  const nt = scribe.doc.nativeText.pages[n] || {};
  if (!page) return false;
  const ownEntry = scribe.doc.images.getEditFontSync(n, fontObjNum);
  if (ownEntry === undefined) return null;
  const own = ownEntry.program;
  if (!own) return false;
  const fam = normalizeFamilyForMatch(own.familyName);
  const other = prop === 'bold' ? 'italic' : 'bold';
  const seen = new Set([fontObjNum]);
  let unknown = false;
  for (const line of page.lines) {
    for (const w of line.words) {
      const o = nt[w.id]?.fontObjNum;
      if (typeof o !== 'number' || seen.has(o)) continue;
      seen.add(o);
      const entry = scribe.doc.images.getEditFontSync(n, o);
      if (entry === undefined) { unknown = true; continue; }
      const p = entry.program;
      if (!p || p[prop] || !!p[other] !== !!own[other]) continue;
      if (familiesCompatible(fam, normalizeFamilyForMatch(p.familyName))) return true;
    }
  }
  return unknown ? null : false;
};
/**
 * @param {*} scribe
 * @param {number} n
 */
export const loadPageFonts = (scribe, n) => {
  const page = scribe.doc.ocr.active?.[n];
  const nt = scribe.doc.nativeText.pages[n] || {};
  const seen = new Set();
  /** @type {Array<Promise<*>>} */
  const loads = [];
  if (!page) return Promise.resolve();
  for (const line of page.lines) {
    for (const w of line.words) {
      const o = nt[w.id]?.fontObjNum;
      if (typeof o !== 'number' || seen.has(o)) continue;
      seen.add(o);
      if (scribe.doc.images.getEditFontSync(n, o) === undefined) loads.push(scribe.doc.images.getEditFont(n, o).catch(() => null));
    }
  }
  return Promise.all(loads);
};
/** @type {?CanvasRenderingContext2D} */
let nameMeasureCtx = null;
/**
 * Set a row name in a page font's own face.
 * @param {HTMLElement} nm
 * @param {string} css - The face, as a CSS font-family value.
 * @param {number} sizePx - The row's font size.
 * @param {number} lineHeightPx
 */
export const setDocFontFace = (nm, css, sizePx, lineHeightPx) => {
  nm.style.fontFamily = css;
  // A rebuilt program can declare an ascent well under its ink, which puts the glyphs above the CSS line box.
  nm.style.lineHeight = `${lineHeightPx}px`;
  if (!nameMeasureCtx) nameMeasureCtx = document.createElement('canvas').getContext('2d');
  if (!nameMeasureCtx) return;
  nameMeasureCtx.font = `${sizePx}px ${css}`;
  const m = nameMeasureCtx.measureText(nm.textContent || '');
  if (!(m.fontBoundingBoxAscent >= 0) || !(m.actualBoundingBoxAscent >= 0)) return;
  const baseline = (lineHeightPx - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 + m.fontBoundingBoxAscent;
  const inkMid = baseline - (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
  const shift = Math.round((lineHeightPx / 2 - inkMid) * 10) / 10;
  if (Math.abs(shift) < 0.5) return;
  nm.style.position = 'relative';
  nm.style.top = `${shift}px`;
};
const EYEDROPPER_SVG = lineIcon('<g transform="rotate(45 12 12)"><path d="M10 7.5V5.5a2 2 0 0 1 4 0v2"/><path d="M9 7.5h6"/><path d="M10.2 7.5 12 20.5l1.8-13"/></g>');
// eslint-disable-next-line max-len
const CARET_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" style="display:block;width:11px;height:11px;pointer-events:none;" aria-hidden="true"><path d="M2.5 4.5l3 3 3-3"/></svg>';
// eslint-disable-next-line max-len
const CHEV_R_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;width:12px;height:12px;" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
// eslint-disable-next-line max-len
const BACK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="display:block;width:14px;height:14px;" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';

export const STANDARD_INKS = [
  ['#000000', 'Black'], ['#595959', 'Dark gray'], ['#a11d1d', 'Dark red'], ['#d92b2b', 'Red'],
  ['#0000ff', 'Blue'], ['#1f3a93', 'Dark blue'], ['#1e7d3a', 'Green'], ['#6f2da8', 'Purple'],
];

/** @param {string} hex */
export const inkName = (hex) => STANDARD_INKS.find((c) => c[0] === hex)?.[1] || hex.toUpperCase();
/** @param {string} hex */
function hexToHsv(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((val) => val / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}
/** @param {number} h @param {number} s @param {number} v */
function hsvToHex(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let rgb;
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return `#${rgb.map((val) => Math.round((val + m) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Up to 16 of the document's word colors, each with its word count.
 * @param {import('../viewer.js').ScribeViewer} scribe
 * @param {Array<string>} applied - Inks applied this session, most recent first.
 * @returns {Array<{hex: string, count: number}>}
 */
export function docInkGroup(scribe, applied) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const page of scribe.doc?.ocr?.active || []) {
    if (!page) continue;
    for (const line of page.lines) {
      for (const w of line.words) {
        const c = (w.style.color || '#000000').toLowerCase();
        counts.set(c, (counts.get(c) || 0) + 1);
      }
    }
  }
  const lead = applied.filter((h) => counts.has(h));
  const rest = [...counts.keys()].filter((h) => !lead.includes(h)).sort((a, b) => /** @type {number} */ (counts.get(b)) - /** @type {number} */ (counts.get(a)));
  return [...lead, ...rest].slice(0, 16).map((hex) => ({ hex, count: /** @type {number} */ (counts.get(hex)) }));
}

/**
 * @param {string} hex
 * @param {string} title
 * @param {boolean} active
 */
function makeSwatch(hex, title, active) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'scribe-tc-sw';
  b.style.setProperty('--c', hex);
  b.title = title;
  b.setAttribute('aria-label', title);
  if (active) b.classList.add('active');
  b.addEventListener('mousedown', (e) => e.preventDefault());
  return b;
}

/**
 * @param {HTMLElement} host - Emptied and filled with the picker.
 * @param {{preview: (hex: string) => void, apply: (hex: string) => void, cancel: () => void, sample: (onPick: (hex: string) => void, onMove: (hex: string) => void, onCancel: () => void) => void}} api
 * @param {string} startHex
 * @param {{sampler?: boolean, noFocus?: boolean, before?: string}} [opts]
 */
export function createColorPicker(host, api, startHex, opts = {}) {
  host.replaceChildren();
  const el = (tag, cls, html) => { const e = document.createElement(tag); e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const pk = el('span', 'scribe-tc-pk');
  const hd = el('span', 'scribe-tc-pkhd');
  const back = el('span', 'scribe-tc-back', BACK_SVG);
  back.tabIndex = 0;
  back.title = 'Back';
  back.setAttribute('role', 'button');
  back.setAttribute('aria-label', 'Back');
  hd.append(back, document.createTextNode('Custom color'));
  const sv = el('span', 'scribe-tc-sv');
  sv.tabIndex = 0;
  sv.setAttribute('role', 'slider');
  sv.setAttribute('aria-label', 'Saturation and brightness');
  const svh = el('span', 'scribe-tc-svh');
  sv.appendChild(svh);
  const hue = el('span', 'scribe-tc-hue');
  hue.tabIndex = 0;
  hue.setAttribute('role', 'slider');
  hue.setAttribute('aria-label', 'Hue');
  const hueh = el('span', 'scribe-tc-hueh');
  hue.appendChild(hueh);
  const row = el('span', 'scribe-tc-pkrow');
  const inp = document.createElement('input');
  inp.className = 'scribe-tc-hex';
  inp.maxLength = 6;
  inp.spellcheck = false;
  inp.setAttribute('aria-label', 'Hex color');
  inp.setAttribute('autocomplete', 'off');
  const eye = opts.sampler ? makeIconButton('Sample from page', EYEDROPPER_SVG) : null;
  const wells = el('span', 'scribe-tc-wells');
  const wOld = document.createElement('span');
  const wNew = document.createElement('span');
  wOld.title = 'Before';
  wNew.title = 'After';
  wells.append(wOld, wNew);
  row.append(el('span', 'scribe-tc-hexlbl', '#'), inp);
  if (eye) row.appendChild(eye);
  row.appendChild(wells);
  const btns = el('span', 'scribe-tc-pkbtns');
  const cancel = el('button', 'scribe-tc-btn', 'Cancel');
  cancel.type = 'button';
  const apply = el('button', 'scribe-tc-btn accent', 'Apply');
  apply.type = 'button';
  btns.append(cancel, apply);
  pk.append(hd, sv, hue, row, btns);
  host.appendChild(pk);

  let { h, s, v } = hexToHsv(startHex);
  wOld.style.background = opts.before || startHex;
  const hexNow = () => hsvToHex(h, s, v);
  const paint = (fromInput = false) => {
    const hex = hexNow();
    const pure = hsvToHex(h, 1, 1);
    sv.style.setProperty('--h', pure);
    hueh.style.setProperty('--h', pure);
    svh.style.left = `${(s * 100).toFixed(2)}%`;
    svh.style.top = `${((1 - v) * 100).toFixed(2)}%`;
    hueh.style.left = `${((h / 360) * 100).toFixed(2)}%`;
    if (!fromInput) inp.value = hex.slice(1).toUpperCase();
    inp.classList.remove('bad');
    wNew.style.background = hex;
    api.preview(hex);
  };
  /**
   * @param {HTMLElement} elm
   * @param {(x: number, y: number) => void} fn
   */
  const drag = (elm, fn) => {
    const at = (e) => {
      const r = elm.getBoundingClientRect();
      fn(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)));
      paint();
    };
    let dragging = false;
    elm.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      elm.focus({ preventScroll: true });
      try { elm.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      dragging = true;
      at(e);
    });
    elm.addEventListener('pointermove', (e) => { if (dragging) at(e); });
    const end = () => { dragging = false; };
    elm.addEventListener('pointerup', end);
    elm.addEventListener('pointercancel', end);
    elm.addEventListener('click', (e) => e.stopPropagation());
  };
  drag(sv, (x, y) => { s = x; v = 1 - y; });
  drag(hue, (x) => { h = Math.min(359.99, x * 360); });
  sv.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    let used = true;
    if (e.key === 'ArrowLeft') s = Math.max(0, s - step);
    else if (e.key === 'ArrowRight') s = Math.min(1, s + step);
    else if (e.key === 'ArrowUp') v = Math.min(1, v + step);
    else if (e.key === 'ArrowDown') v = Math.max(0, v - step);
    else used = false;
    if (used) { e.preventDefault(); e.stopPropagation(); paint(); }
  });
  hue.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 1;
    let used = true;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') h = (h - step + 360) % 360;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') h = (h + step) % 360;
    else used = false;
    if (used) { e.preventDefault(); e.stopPropagation(); paint(); }
  });
  inp.addEventListener('input', () => {
    if (/^[0-9a-f]{6}$/i.test(inp.value)) {
      ({ h, s, v } = hexToHsv(`#${inp.value.toLowerCase()}`));
      paint(true);
    } else inp.classList.toggle('bad', inp.value.length > 0);
  });
  inp.addEventListener('click', (e) => e.stopPropagation());
  const doApply = () => api.apply(hexNow());
  const doCancel = () => api.cancel();
  apply.addEventListener('click', (e) => { e.stopPropagation(); doApply(); });
  cancel.addEventListener('click', (e) => { e.stopPropagation(); doCancel(); });
  back.addEventListener('click', (e) => { e.stopPropagation(); doCancel(); });
  back.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); doCancel(); } });
  pk.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      doCancel();
    } else if (e.key === 'Enter' && e.target !== cancel && e.target !== back) {
      e.preventDefault();
      e.stopPropagation();
      doApply();
    }
  });
  if (eye) {
    eye.addEventListener('click', (e) => {
      e.stopPropagation();
      const was = { h, s, v };
      api.sample(
        (hex) => { ({ h, s, v } = hexToHsv(hex)); paint(); sv.focus({ preventScroll: true }); },
        (hex) => { ({ h, s, v } = hexToHsv(hex)); paint(); },
        () => { ({ h, s, v } = was); paint(); },
      );
    });
  }
  paint();
  if (!opts.noFocus) sv.focus({ preventScroll: true });
  return { cancel: doCancel };
}

/**
 * @param {import('../viewer.js').ScribeViewer} scribe
 * @param {{align?: 'left'|'right'}} [opts] - Which edge the plate hangs from.
 */
export function createStyleCluster(scribe, opts = {}) {
  const root = document.createElement('span');
  root.className = 'scribe-edit-text-cluster';
  /**
   * @param {'bold'|'italic'} prop
   * @param {string} label
   * @param {string} svg
   * @param {string} hint
   */
  const toggle = (prop, label, svg, hint) => {
    const b = makeIconButton(label, svg);
    b.dataset.tipKey = hint;
    b.classList.add(`scribe-tc-${prop}`);
    b.addEventListener('click', (e) => { e.stopPropagation(); if (b.classList.contains('disabled')) return; scribe._editTextToggleStyle?.(prop); });
    b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); b.click(); } });
    return { el: b, label, hint };
  };
  const bold = toggle('bold', 'Bold', BOLD_SVG, shortcutLabel('B'));
  const italic = toggle('italic', 'Italic', ITALIC_SVG, shortcutLabel('I'));
  const split = document.createElement('span');
  split.className = 'scribe-tc-split';
  const apply = makeIconButton('Text color', TEXT_COLOR_SVG);
  apply.classList.add('scribe-tc-apply');
  const caret = document.createElement('span');
  caret.className = 'cr-icon-button scribe-tc-caret';
  caret.dataset.tip = 'Choose text color';
  caret.role = 'button';
  caret.tabIndex = 0;
  caret.ariaLabel = 'Choose text color';
  caret.innerHTML = CARET_SVG;
  caret.addEventListener('mousedown', (e) => e.preventDefault());
  const pop = document.createElement('span');
  pop.className = `scribe-tc-pop${opts.align === 'right' ? ' scribe-tc-right' : ''}`;
  split.append(apply, caret, pop);
  root.append(bold.el, italic.el, split);
  const gap = document.createElement('span');
  gap.className = 'scribe-tc-gap';
  const fontSplit = document.createElement('span');
  fontSplit.className = 'scribe-tc-split';
  const fontApply = makeIconButton('Font', FONT_SVG);
  fontApply.classList.add('scribe-tc-apply', 'scribe-tc-font');
  const fontCaret = document.createElement('span');
  fontCaret.className = 'cr-icon-button scribe-tc-caret scribe-tc-font-caret';
  fontCaret.dataset.tip = 'Choose font';
  fontCaret.role = 'button';
  fontCaret.tabIndex = 0;
  fontCaret.ariaLabel = 'Choose font';
  fontCaret.innerHTML = CARET_SVG;
  fontCaret.addEventListener('mousedown', (e) => e.preventDefault());
  const fontPop = document.createElement('span');
  fontPop.className = `scribe-tc-pop scribe-tc-font-pop${opts.align === 'right' ? ' scribe-tc-right' : ''}`;
  fontPop.setAttribute('role', 'listbox');
  fontPop.setAttribute('aria-label', 'Font');
  fontSplit.append(fontApply, fontCaret, fontPop);
  root.append(gap, fontSplit);

  /** @type {?ReturnType<typeof createColorPicker>} */
  let page = null;
  const isOpen = () => pop.classList.contains('open');
  const preview = (hex) => scribe._editTextPreviewColor?.(hex);
  const refocus = () => {
    const ed = scribe._editTextLineEditor;
    if (ed?.isOpen()) ed.focus?.(); else caret.focus({ preventScroll: true });
  };

  let fontFitSeq = 0;
  const isFontOpen = () => fontPop.classList.contains('open');
  const closeFont = (refocusToo = true) => {
    if (!isFontOpen()) return;
    scribe._editTextPreviewFont?.(null);
    fontPop.classList.remove('open');
    fontCaret.classList.remove('active');
    fontApply.classList.remove('active');
    fontPop.replaceChildren();
    if (refocusToo) {
      const ed = scribe._editTextLineEditor;
      if (ed?.isOpen()) ed.focus?.(); else fontCaret.focus({ preventScroll: true });
    }
  };
  const openFont = () => {
    fontPop.replaceChildren();
    const fs = scribe._editTextFontState?.() || { present: false, fontId: null, mixed: false };
    const cur = fs.mixed ? null : (fs.fontId || null);
    /** @type {Array<HTMLSpanElement>} */
    const rows = [];
    /**
     * @param {string} id
     * @param {string} name
     * @param {?string} css
     * @param {?string} raw
     * @param {?number} count
     */
    const addRow = (id, name, css, raw, count) => {
      const row = document.createElement('span');
      row.className = 'scribe-tc-font-row';
      row.setAttribute('role', 'option');
      row.tabIndex = 0;
      row.dataset.family = id;
      const chk = document.createElement('span');
      chk.className = 'scribe-tc-font-chk';
      chk.innerHTML = CHECK_SVG;
      const nm = document.createElement('span');
      nm.className = 'scribe-tc-font-nm';
      nm.textContent = name;
      if (css && count !== null) setDocFontFace(nm, css, 14, 20);
      else if (css) nm.style.fontFamily = css;
      row.append(chk, nm);
      if (count !== null) {
        const ct = document.createElement('span');
        ct.className = 'scribe-tc-font-ct';
        ct.textContent = `${count} line${count === 1 ? '' : 's'}`;
        row.appendChild(ct);
      }
      if (raw) row.title = raw;
      if (id === cur) row.classList.add('active');
      row.addEventListener('mousedown', (e) => e.preventDefault());
      // A grayed face still previews on the line, so the overflow that bars it is visible.
      // The focus the plate takes as it opens previews nothing, so the line stays as drawn until the user moves to a face.
      row.addEventListener('mouseenter', () => scribe._editTextPreviewFont?.(id));
      row.addEventListener('mouseleave', () => scribe._editTextPreviewFont?.(null));
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        if (row.classList.contains('disabled')) return;
        closeFont(false);
        refocus();
        scribe._editTextSetFont?.(id);
      });
      rows.push(row);
      return row;
    };
    const hd = document.createElement('span');
    hd.className = 'scribe-tc-hd';
    hd.textContent = 'Built-in';
    fontPop.appendChild(hd);
    for (const f of FACE_FAMILIES) fontPop.appendChild(addRow(f.id, f.name, faceCssFamily(f.id), null, null));
    fontPop.classList.add('open');
    fontCaret.classList.add('active');
    fontApply.classList.add('active');
    const first = rows[0];
    (rows.find((r) => r.classList.contains('active')) || first)?.focus({ preventScroll: true });
    fontFitSeq += 1;
    const token = fontFitSeq;
    /** @type {?Record<string, {fits: boolean, reason?: string}>} */
    let fits = null;
    const applyFits = () => {
      if (!fits) return;
      for (const row of rows) {
        const r = fits[/** @type {string} */ (row.dataset.family)];
        if (!r || r.fits || row.classList.contains('disabled')) continue;
        row.classList.add('disabled');
        row.setAttribute('aria-disabled', 'true');
        row.title = r.reason || 'This face does not fit the line.';
      }
    };
    scribe._editTextFontFits?.().then((result) => {
      if (token !== fontFitSeq || !isFontOpen() || !result) return;
      fits = result;
      applyFits();
    }).catch(() => {});
    scribe._editTextDocFonts?.().then((docs) => {
      if (token !== fontFitSeq || !isFontOpen() || !docs || docs.length === 0) return;
      const dhd = document.createElement('span');
      dhd.className = 'scribe-tc-hd';
      dhd.textContent = 'In this document';
      const frag = document.createDocumentFragment();
      frag.appendChild(dhd);
      for (const d of docs) frag.appendChild(addRow(d.id, d.name, d.css, d.raw, d.lines));
      fontPop.insertBefore(frag, hd);
      const active = rows.find((r) => r.classList.contains('active'));
      if (active && document.activeElement === first) active.focus({ preventScroll: true });
      applyFits();
    }).catch(() => {});
  };
  fontPop.addEventListener('keydown', (e) => {
    const rows = /** @type {Array<HTMLElement>} */ ([...fontPop.querySelectorAll('.scribe-tc-font-row')]);
    const i = rows.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    let used = true;
    let to = -1;
    if (e.key === 'Escape') closeFont();
    else if (e.key === 'ArrowDown') to = Math.min(rows.length - 1, i + 1);
    else if (e.key === 'ArrowUp') to = Math.max(0, i - 1);
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = rows.length - 1;
    else if (e.key === 'Enter' || e.key === ' ') rows[i]?.click();
    else used = false;
    if (to >= 0 && rows[to]) {
      rows[to].focus({ preventScroll: true });
      scribe._editTextPreviewFont?.(rows[to].dataset.family || null);
    }
    if (used) { e.preventDefault(); e.stopPropagation(); }
  });
  fontPop.addEventListener('click', (e) => e.stopPropagation());
  const toggleFont = (e) => {
    e.stopPropagation();
    if (fontCaret.classList.contains('disabled')) return;
    if (isFontOpen()) closeFont(); else openFont();
  };
  fontApply.addEventListener('click', toggleFont);
  fontCaret.addEventListener('click', toggleFont);
  fontApply.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fontApply.click(); } });
  fontCaret.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fontCaret.click(); } });
  const close = () => {
    if (!isOpen()) return;
    preview(null);
    page = null;
    pop.classList.remove('open');
    caret.classList.remove('active');
    pop.replaceChildren();
    refocus();
  };
  /** @param {string} hex */
  const pick = (hex) => {
    page = null;
    pop.classList.remove('open');
    caret.classList.remove('active');
    pop.replaceChildren();
    preview(null);
    refocus();
    scribe._editTextSetColor?.(hex);
  };
  const startHex = () => {
    const cs = scribe._editTextColorState?.();
    return (cs && !cs.mixed && cs.color) || scribe._editTextInkState?.().cur || '#000000';
  };
  const openPicker = () => {
    page = createColorPicker(pop, {
      preview,
      apply: pick,
      cancel: () => { preview(null); buildPlate(); pop.querySelector('.scribe-tc-crow')?.focus({ preventScroll: true }); },
      sample: (onPick, onMove, onCancel) => scribe._editTextSample?.(onPick, { onMove, onCancel }),
    }, startHex(), { sampler: true });
  };
  const buildPlate = () => {
    pop.replaceChildren();
    page = null;
    const cs = scribe._editTextColorState?.() || { present: false, color: null, mixed: false };
    const cur = cs.mixed ? null : cs.color;
    const inks = docInkGroup(scribe, scribe._editTextInkState?.().applied || []);
    const hd = (text) => { const e = document.createElement('span'); e.className = 'scribe-tc-hd'; e.textContent = text; pop.appendChild(e); };
    const row = (list) => {
      const r = document.createElement('span');
      r.className = 'scribe-tc-row';
      for (const i of list) {
        const t = `${inkName(i.hex)}${i.count ? ` · ${i.count} word${i.count === 1 ? '' : 's'}` : ''}`;
        const sw = makeSwatch(i.hex, t, i.hex === cur);
        sw.addEventListener('click', (e) => { e.stopPropagation(); pick(i.hex); });
        sw.addEventListener('mouseenter', () => preview(i.hex));
        sw.addEventListener('mouseleave', () => preview(null));
        sw.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(i.hex); } });
        r.appendChild(sw);
      }
      pop.appendChild(r);
    };
    hd('In this document');
    row(inks);
    hd('Standard');
    row(STANDARD_INKS.filter((c) => !inks.some((i) => i.hex === c[0])).map(([hex]) => ({ hex, count: 0 })));
    const sep = document.createElement('span');
    sep.className = 'scribe-tc-sep';
    pop.appendChild(sep);
    const crow = document.createElement('span');
    crow.className = 'scribe-tc-crow';
    crow.tabIndex = 0;
    crow.setAttribute('role', 'button');
    crow.innerHTML = `<span class="scribe-tc-sw scribe-tc-custom"></span><span>Custom…</span><span class="scribe-tc-chev">${CHEV_R_SVG}</span>`;
    crow.addEventListener('mousedown', (e) => e.preventDefault());
    crow.addEventListener('click', (e) => { e.stopPropagation(); openPicker(); });
    crow.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); } });
    pop.appendChild(crow);
  };
  const open = () => {
    buildPlate();
    pop.classList.add('open');
    caret.classList.add('active');
    /** @type {?HTMLElement} */
    const first = pop.querySelector('.scribe-tc-sw.active') || pop.querySelector('.scribe-tc-sw');
    first?.focus({ preventScroll: true });
  };
  caret.addEventListener('click', (e) => {
    e.stopPropagation();
    if (caret.classList.contains('disabled')) return;
    if (isOpen()) close(); else open();
  });
  caret.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); caret.click(); } });
  apply.addEventListener('click', (e) => {
    e.stopPropagation();
    if (apply.classList.contains('disabled')) return;
    scribe._editTextSetColor?.(scribe._editTextInkState?.().cur || '#000000');
  });
  apply.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); apply.click(); } });
  const onDocPointerDown = (e) => {
    if (!(e.target instanceof Node)) return;
    if (isFontOpen() && !fontSplit.contains(e.target)) closeFont(false);
    if (!isOpen() || split.contains(e.target)) return;
    if (scribe.scrollContainer?.classList.contains('scribe-edit-text-sampling')) return;
    close();
  };
  document.addEventListener('pointerdown', onDocPointerDown, true);

  const sync = () => {
    for (const [prop, t] of /** @type {Array<['bold'|'italic', typeof bold]>} */ ([['bold', bold], ['italic', italic]])) {
      const s = scribe._editTextStyleState?.(prop) || { present: false, on: false, locked: false };
      t.el.classList.toggle('disabled', !s.present || s.locked);
      t.el.classList.toggle('active', s.on);
      t.el.dataset.tip = s.locked ? `This font is only available in ${prop}.` : t.label;
      t.el.dataset.tipKey = s.locked ? '' : t.hint;
    }
    const cs = scribe._editTextColorState?.() || { present: false };
    const ink = scribe._editTextInkState?.().cur || '#000000';
    apply.classList.toggle('disabled', !cs.present);
    caret.classList.toggle('disabled', !cs.present);
    apply.style.setProperty('--scribe-text-ink', ink);
    apply.dataset.tip = `Text color: ${inkName(ink)}`;
    if (!cs.present && isOpen()) close();
    const fs = scribe._editTextFontState?.() || {
      present: false, family: null, name: null, mixed: false,
    };
    fontApply.classList.toggle('disabled', !fs.present);
    fontCaret.classList.toggle('disabled', !fs.present);
    fontApply.dataset.tip = fs.present ? `Font: ${fs.mixed ? 'Mixed' : (fs.name || 'Unknown')}` : 'Font';
    if (!fs.present && isFontOpen()) closeFont(false);
  };
  return {
    el: root,
    sync,
    closePop: () => { close(); closeFont(false); },
    isPopOpen: () => isOpen() || isFontOpen(),
    /**
     * Steps back one level for Esc.
     * @returns {boolean} Whether the key was used.
     */
    escape() {
      if (isFontOpen()) { closeFont(); return true; }
      if (page) { page.cancel(); return true; }
      if (isOpen()) { close(); return true; }
      return false;
    },
    destroy() {
      document.removeEventListener('pointerdown', onDocPointerDown, true);
    },
  };
}
