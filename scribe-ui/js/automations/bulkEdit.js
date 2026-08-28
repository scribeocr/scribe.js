// The Bulk Edit workspace: select lines of native PDF text by their properties, review the matches, and delete them together.
// The rules and exclusions are view state that never serializes into the document.
import { getLineText } from '../../../js/objects/ocrObjects.js';
import { cleanFamilyName } from '../../../js/utils/miscUtils.js';
import {
  nativeLineEligible, nativeLineDrawBox, nativeLineHitAt, refreshEditedPages,
} from '../controls/tools.js';
import { pxPerPt } from '../viewerFillSign.js';

const lineIcon = (inner) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"'
  + ` style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true">${inner}</svg>`;
const PICK_SVG = lineIcon('<circle cx="12" cy="12" r="6"/><path d="M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21"/>');
const CHECK_SVG = lineIcon('<path d="M5 12.5l4.5 4.5L19 7.5"/>');
const X_SVG = lineIcon('<path d="M7 7l10 10M17 7L7 17"/>');
const FLAG_SVG = lineIcon('<path d="M6 21V4.5"/><path d="M6 5h11l-2.5 3.5L17 12H6z"/>');

const PROPS = [
  { id: 'font', label: 'Font', ops: ['is', 'is not'] },
  { id: 'size', label: 'Size', ops: ['is', 'is at least', 'is at most'] },
  { id: 'color', label: 'Color', ops: ['is', 'is not'] },
  { id: 'style', label: 'Style', ops: ['is entirely', 'is mostly', 'contains', 'is not'] },
  { id: 'position', label: 'Position', ops: ['is inside', 'is outside'] },
  { id: 'text', label: 'Text', ops: ['contains', 'does not contain', 'is'] },
];
const REGIONS = [
  { id: 'top', label: 'Top strip' },
  { id: 'bottom', label: 'Bottom strip' },
  { id: 'body', label: 'Body' },
];
const STRIP = 0.1;
const SNIP_PX_PER_PT = 0.8;
const SNIP_HEIGHT = 44;

/**
 * Build the Bulk Edit workspace into `container`.
 * @param {import('./registry.js').AutomationHost} host
 * @param {HTMLElement} container
 * @returns {{refresh: () => void, teardown: () => void}}
 */
export function buildBulkEditWorkspace(host, container) {
  const viewer = host.viewer;
  const doc = viewer.doc;

  container.textContent = '';
  const body = document.createElement('div');
  body.className = 'scribe-am-rdbody';
  const foot = document.createElement('div');
  foot.className = 'scribe-am-rdfoot';
  foot.style.display = 'none';
  container.append(body, foot);

  /** @type {'empty'|'picking'|'select'|'done'} */
  let stage = 'empty';
  /** @type {Array<{prop: string, op: string, value: string}>} */
  let rules = [];
  /** @type {?{line: import('../../../js/objects/ocrObjects.js').OcrLine, n: number}} */
  let example = null;
  /** @type {Array<{n: number, line: import('../../../js/objects/ocrObjects.js').OcrLine, p: Object}>} */
  let matches = [];
  /** @type {Array<{key: string, items: Array<Object>, excluded: boolean, cursor: number}>} */
  let groups = [];
  /** Kept across rescans, so editing a rule never silently restores an exclusion the user made. */
  const excludedKeys = new Set();
  /** @type {Map<string, number>} */
  let fontsSeen = new Map();
  /** @type {Map<string, number>} */
  let colorsSeen = new Map();
  /** @type {Map<string, number>} */
  let stylesSeen = new Map();
  /** @type {'before'|'after'} */
  let view = 'before';
  /** @type {?Object} The match ringed in the document after a card jump. */
  let current = null;
  /** @type {?{entry: Object, count: number, pages: number, excluded: number}} */
  let lastDelete = null;
  let destroyed = false;

  const eligible = (line) => nativeLineEligible(doc, line);

  /**
   * The properties a rule can test.
   * Read off the line's first alphanumeric word, except style, which aggregates every word.
   * @param {import('../../../js/objects/ocrObjects.js').OcrLine} line
   * @param {number} n
   */
  const propsOf = (line, n) => {
    const w = line.words.find((x) => /[\p{L}\p{N}]/u.test(x.text)) || line.words[0];
    const raw = (w.style.font || '').replace(/^[A-Z]{6}\+/, '');
    const dims = doc.pageMetrics[n].dims;
    const mid = (line.bbox.top + line.bbox.bottom) / 2;
    const styleWords = line.words.filter((x) => /[\p{L}\p{N}]/u.test(x.text));
    const byCombo = new Map();
    let total = 0;
    for (const sw of (styleWords.length ? styleWords : line.words)) {
      const parts = [];
      if (sw.style.bold) parts.push('Bold');
      if (sw.style.italic) parts.push('Italic');
      if (sw.style.smallCaps) parts.push('Small caps');
      if (sw.style.underline) parts.push('Underline');
      const combo = parts.join(' ') || 'Regular';
      const chars = sw.text.replace(/[^\p{L}\p{N}]/gu, '').length || 1;
      byCombo.set(combo, (byCombo.get(combo) || 0) + chars);
      total += chars;
    }
    return {
      font: raw ? cleanFamilyName(raw) : 'Unknown',
      size: w.style.size ? Math.round((w.style.size / pxPerPt(viewer, n)) * 2) / 2 : 0,
      color: (w.style.color || '#000000').toLowerCase(),
      style: { entire: byCombo.size === 1 ? byCombo.keys().next().value : null, byCombo, total },
      position: mid < dims.height * STRIP ? 'top' : (mid > dims.height * (1 - STRIP) ? 'bottom' : 'body'),
      text: getLineText(line),
    };
  };

  const ruleOk = (rule, p) => {
    if (rule.prop === 'font') return (p.font === rule.value) === (rule.op === 'is');
    if (rule.prop === 'color') return (p.color === String(rule.value).toLowerCase()) === (rule.op === 'is');
    if (rule.prop === 'position') return (p.position === rule.value) === (rule.op === 'is inside');
    if (rule.prop === 'size') {
      const v = Number(rule.value);
      if (!Number.isFinite(v) || v <= 0) return true;
      if (rule.op === 'is') return Math.abs(p.size - v) <= 0.5;
      return rule.op === 'is at least' ? p.size >= v - 0.25 : p.size <= v + 0.25;
    }
    if (rule.prop === 'style') {
      if (!rule.value) return true;
      if (rule.op === 'is entirely') return p.style.entire === rule.value;
      if (rule.op === 'is not') return p.style.entire !== rule.value;
      if (rule.op === 'is mostly') return (p.style.byCombo.get(rule.value) || 0) / p.style.total >= 0.8;
      return p.style.byCombo.has(rule.value);
    }
    const needle = String(rule.value).trim().toLowerCase();
    if (!needle) return true;
    const hay = p.text.toLowerCase();
    if (rule.op === 'is') return hay.trim() === needle;
    return hay.includes(needle) === (rule.op === 'contains');
  };

  /**
   * The style rule a picked line implies.
   * The operator is the strictest one that still matches the line, so a seeded rule never excludes its own example.
   */
  const styleRuleFor = (st) => {
    if (st.entire) return { prop: 'style', op: 'is entirely', value: st.entire };
    let best = 'Regular';
    let bestN = 0;
    for (const [combo, chars] of st.byCombo) if (chars > bestN) { best = combo; bestN = chars; }
    return { prop: 'style', op: bestN / st.total >= 0.8 ? 'is mostly' : 'contains', value: best };
  };

  // Numbers are blanked so stamps that differ only in a page number or date still group together.
  const lookKey = (m) => [m.p.text.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase(), m.p.font, m.p.color].join('|');
  const relTop = (m) => ((m.line.bbox.top + m.line.bbox.bottom) / 2) / doc.pageMetrics[m.n].dims.height;
  const sameLook = (g, m) => g.look === lookKey(m) && Math.abs(g.size - m.p.size) <= 0.5 && Math.abs(g.relTop - relTop(m)) <= 0.015;

  function scan() {
    matches = [];
    fontsSeen = new Map();
    colorsSeen = new Map();
    stylesSeen = new Map();
    for (let n = 0; n < doc.pageMetrics.length; n++) {
      const page = doc.ocr.active[n];
      if (!page) continue;
      for (const line of page.lines) {
        if (!eligible(line)) continue;
        const p = propsOf(line, n);
        fontsSeen.set(p.font, (fontsSeen.get(p.font) || 0) + 1);
        colorsSeen.set(p.color, (colorsSeen.get(p.color) || 0) + 1);
        for (const combo of p.style.byCombo.keys()) stylesSeen.set(combo, (stylesSeen.get(combo) || 0) + 1);
        if (rules.length && rules.every((r) => ruleOk(r, p))) matches.push({ n, line, p });
      }
    }
    groups = [];
    for (const m of matches) {
      let g = groups.find((x) => sameLook(x, m));
      if (!g) {
        const look = lookKey(m);
        g = {
          key: `${look}|${m.p.size}|${relTop(m).toFixed(2)}`, look, size: m.p.size, relTop: relTop(m), items: [], excluded: false, cursor: 0,
        };
        g.excluded = excludedKeys.has(g.key);
        groups.push(g);
      }
      g.items.push(m);
    }
    groups.sort((a, b) => b.items.length - a.items.length || a.items[0].n - b.items[0].n);
    if (current && !matches.some((m) => m.line === current.line)) current = null;
  }

  const keptCount = () => groups.reduce((sum, g) => sum + (g.excluded ? 0 : g.items.length), 0);
  const excludedCount = () => groups.reduce((sum, g) => sum + (g.excluded ? g.items.length : 0), 0);

  /**
   * Default rules from a picked line.
   * The text rule keeps the shortest phrase every look-alike line shares and no rival line contains, so a stamp's docket number wins over its page number.
   */
  function rulesFromExample(ex) {
    const p = propsOf(ex.line, ex.n);
    const exMatch = { n: ex.n, line: ex.line, p };
    const exLook = { look: lookKey(exMatch), size: p.size, relTop: relTop(exMatch) };
    /** @type {Array<string>} */
    const family = [];
    /** @type {Array<string>} */
    const rivals = [];
    for (let n = 0; n < doc.pageMetrics.length; n++) {
      const page = doc.ocr.active[n];
      if (!page) continue;
      for (const line of page.lines) {
        if (!eligible(line)) continue;
        const q = propsOf(line, n);
        if (q.font !== p.font || q.size !== p.size || q.color !== p.color || q.position !== p.position) continue;
        const text = q.text.toLowerCase();
        if (sameLook(exLook, { n, line, p: q })) family.push(text);
        else rivals.push(text);
      }
    }
    const tokens = p.text.split(/\s+/).filter(Boolean);
    const inAllFamily = (tok) => family.every((t) => t.includes(tok.toLowerCase()));
    const inNoRival = (tok) => rivals.every((t) => !t.includes(tok.toLowerCase()));
    let phrase = tokens.slice(0, 3).join(' ');
    for (let i = 0; i < tokens.length; i++) {
      if (!inAllFamily(tokens[i]) || !inNoRival(tokens[i])) continue;
      phrase = i > 0 && inAllFamily(tokens[i - 1]) ? `${tokens[i - 1]} ${tokens[i]}` : tokens[i];
      break;
    }
    return [
      { prop: 'font', op: 'is', value: p.font },
      { prop: 'size', op: 'is', value: String(p.size) },
      { prop: 'color', op: 'is', value: p.color },
      styleRuleFor(p.style),
      { prop: 'position', op: 'is inside', value: p.position },
      { prop: 'text', op: 'contains', value: phrase },
    ];
  }

  /** @type {Map<import('../../../js/objects/ocrObjects.js').OcrLine, HTMLDivElement>} */
  const marks = new Map();
  const clearMarks = () => {
    for (const el of marks.values()) el.remove();
    marks.clear();
  };
  function paintMarks() {
    if (destroyed) return;
    const wanted = new Map();
    if (stage === 'select') {
      for (const g of groups) for (const m of g.items) wanted.set(m.line, { m, excluded: g.excluded });
    }
    for (const [line, el] of marks) {
      if (!wanted.has(line)) {
        el.remove();
        marks.delete(line);
      }
    }
    const zoom = 'var(--scribe-zoom, 1)';
    for (const [line, { m, excluded }] of wanted) {
      const idx = viewer.textSel?.index(m.n);
      const e = idx ? idx.lines.find((x) => x.line === line) : null;
      const group = e ? viewer.getTextGroup(m.n, e.orientation) : null;
      if (!group) {
        marks.get(line)?.remove();
        continue;
      }
      let el = marks.get(line);
      if (!el) {
        el = document.createElement('div');
        el.className = 'scribe-be-mark';
        Object.assign(el.style, {
          position: 'absolute',
          pointerEvents: 'none',
          boxSizing: 'border-box',
          borderRadius: `calc(3px / ${zoom})`,
        });
        marks.set(line, el);
      }
      const hidden = view === 'after' && !excluded;
      if (hidden) {
        el.style.border = `calc(1px / ${zoom}) dashed var(--scribe-ink-3, #98a1b0)`;
        el.style.background = '#fff';
      } else if (excluded) {
        el.style.border = `calc(1.5px / ${zoom}) dashed var(--scribe-ink-3, #98a1b0)`;
        el.style.background = 'transparent';
      } else if (current && current.line === line) {
        el.style.border = `calc(2px / ${zoom}) solid var(--scribe-accent, #1c62d4)`;
        el.style.background = 'var(--scribe-accent-wash, rgba(28, 98, 212, .14))';
      } else {
        el.style.border = `calc(1.5px / ${zoom}) solid var(--scribe-accent, #1c62d4)`;
        el.style.background = 'var(--scribe-active, rgba(28, 98, 212, .10))';
      }
      const pad = 2;
      const box = nativeLineDrawBox(doc, line, e.lbox);
      el.style.left = `${box.left - pad}px`;
      el.style.top = `${box.top - pad}px`;
      el.style.width = `${box.right - box.left + 2 * pad}px`;
      el.style.height = `${box.bottom - box.top + 2 * pad}px`;
      if (el.parentElement !== group) group.appendChild(el);
    }
  }
  let paintRaf = 0;
  const schedulePaint = () => {
    if (paintRaf || destroyed) return;
    paintRaf = requestAnimationFrame(() => {
      paintRaf = 0;
      paintMarks();
    });
  };

  const hoverElem = document.createElement('div');
  hoverElem.className = 'scribe-be-hover';
  Object.assign(hoverElem.style, {
    position: 'absolute',
    border: 'calc(1.5px / var(--scribe-zoom, 1)) solid rgba(26, 115, 232, 0.75)',
    borderRadius: '2px',
    pointerEvents: 'none',
    boxSizing: 'border-box',
  });
  const hideHover = () => hoverElem.remove();

  /** @type {?HTMLDivElement} */
  let pill = null;
  const placePill = () => {
    if (!pill) return;
    const r = viewer.scrollContainer.getBoundingClientRect();
    pill.style.left = `${r.left + r.width / 2}px`;
    pill.style.top = `${r.top + 10}px`;
  };
  const showPill = () => {
    if (pill) return;
    pill = document.createElement('div');
    pill.className = 'scribe-be-pill';
    Object.assign(pill.style, {
      position: 'fixed',
      zIndex: '60',
      transform: 'translateX(-50%)',
      display: 'inline-flex',
      alignItems: 'center',
      gap: '7px',
      height: '26px',
      padding: '0 12px',
      borderRadius: '13px',
      background: 'var(--scribe-surface, #ffffff)',
      border: '1px solid var(--scribe-line, #e4e8ef)',
      boxShadow: 'var(--scribe-menu-shadow, 0 4px 14px rgba(20, 30, 60, .13))',
      fontSize: '12px',
      color: 'var(--scribe-ink-2, #586170)',
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
    });
    pill.innerHTML = '<b style="color:var(--scribe-ink, #1f2530);font-weight:600;">Previewing “After”</b><span>· nothing is deleted yet</span>';
    viewer.scrollContainer.appendChild(pill);
    placePill();
  };
  const hidePill = () => {
    pill?.remove();
    pill = null;
  };

  const onPointerMove = (ev) => {
    if (stage !== 'picking' || ev.buttons !== 0) {
      hideHover();
      return;
    }
    const info = nativeLineHitAt(viewer, ev.clientX, ev.clientY, eligible);
    const group = info ? viewer.getTextGroup(info.n, info.orientation) : null;
    if (!info || !group) {
      hideHover();
      return;
    }
    const pad = 2;
    const box = nativeLineDrawBox(doc, info.line, info.lbox);
    hoverElem.style.left = `${box.left - pad}px`;
    hoverElem.style.top = `${box.top - pad}px`;
    hoverElem.style.width = `${box.right - box.left + 2 * pad}px`;
    hoverElem.style.height = `${box.bottom - box.top + 2 * pad}px`;
    if (hoverElem.parentElement !== group) group.appendChild(hoverElem);
  };
  /** @type {?{x: number, y: number, id: number}} */
  let press = null;
  // Capture phase, so the engine's own pointerdown never starts a text drag from a pick.
  const onPointerDown = (ev) => {
    if (stage !== 'picking' || ev.button !== 0) return;
    const t = ev.target;
    if (t instanceof Element && t.closest('.scribe-hl-cmark, .scribe-note-icon, .scribe-cmt-card, .scribe-redact-tab, [contenteditable]')) return;
    ev.stopPropagation();
    press = { x: ev.clientX, y: ev.clientY, id: ev.pointerId };
  };
  const onPointerUp = (ev) => {
    if (!press || ev.pointerId !== press.id) return;
    const moved = Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > 6;
    press = null;
    if (moved || stage !== 'picking') return;
    const info = nativeLineHitAt(viewer, ev.clientX, ev.clientY, eligible);
    if (!info) return;
    ev.stopPropagation();
    pickExample({ line: info.line, n: info.n });
  };
  const onKeyDown = (ev) => {
    if (stage !== 'picking' || ev.key !== 'Escape') return;
    ev.preventDefault();
    ev.stopPropagation();
    cancelPicking();
  };
  const onScroll = () => schedulePaint();
  const onResize = () => placePill();

  function startPicking() {
    if (!viewer.textSel) return;
    stage = 'picking';
    viewer.clearTextSelection?.();
    viewer.textSel.cursorOverride = 'crosshair';
    document.addEventListener('keydown', onKeyDown, true);
    render();
    paintMarks();
  }
  function endPicking() {
    hideHover();
    press = null;
    if (viewer.textSel) viewer.textSel.cursorOverride = null;
    document.removeEventListener('keydown', onKeyDown, true);
  }
  function cancelPicking() {
    endPicking();
    stage = rules.length ? 'select' : 'empty';
    render();
    paintMarks();
  }
  function pickExample(ex) {
    endPicking();
    example = ex;
    rules = rulesFromExample(ex);
    excludedKeys.clear();
    current = null;
    view = 'before';
    hidePill();
    stage = 'select';
    scan();
    render();
    paintMarks();
  }

  /** @type {?HTMLElement} */
  let menuElem = null;
  /** @type {?HTMLElement} */
  let menuAnchor = null;
  const closeMenu = () => {
    if (!menuElem) return;
    menuElem.remove();
    menuElem = null;
    menuAnchor = null;
    document.removeEventListener('pointerdown', onMenuPointerDown, true);
  };
  function onMenuPointerDown(e) {
    // A press on the open menu's own button falls through to the click that toggles it shut.
    if (menuElem && !menuElem.contains(e.target) && !menuAnchor.contains(e.target)) closeMenu();
  }
  /**
   * @param {HTMLElement} anchor
   * @param {Array<{value: string, html: string, checked?: boolean}>} items
   * @param {(value: string) => void} onPick
   */
  function openMenu(anchor, items, onPick) {
    const reclick = menuAnchor === anchor;
    closeMenu();
    if (reclick) return;
    const menu = document.createElement('div');
    menu.className = 'scribe-am-mmenu';
    menu.setAttribute('role', 'menu');
    for (const item of items) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'scribe-am-mrow';
      row.setAttribute('role', 'menuitemradio');
      row.setAttribute('aria-checked', item.checked ? 'true' : 'false');
      row.innerHTML = `<span class="scribe-am-mcheck">${CHECK_SVG}</span><span class="scribe-am-mcol"><span class="scribe-am-mname">${item.html}</span></span>`;
      row.addEventListener('click', () => {
        closeMenu();
        onPick(item.value);
      });
      menu.appendChild(row);
    }
    const panel = /** @type {HTMLElement} */ (container.closest('.scribe-am-panel') || container);
    const panelRect = panel.getBoundingClientRect();
    const aRect = anchor.getBoundingClientRect();
    menu.style.position = 'absolute';
    menu.style.left = `${Math.max(10, Math.min(Math.round(aRect.left - panelRect.left), panelRect.width - 218))}px`;
    menu.style.top = `${Math.round(aRect.bottom - panelRect.top + 4)}px`;
    panel.appendChild(menu);
    menuElem = menu;
    menuAnchor = anchor;
    document.addEventListener('pointerdown', onMenuPointerDown, true);
    menu.querySelector('.scribe-am-mrow')?.focus();
  }

  const ESC = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);
  const fontCss = (font) => `"${font.replace(/"/g, '')}", ${/times|roman|serif|georgia|garamond|palatino|century|book|minion|cambria|schoolbook/i.test(font) ? 'serif' : 'sans-serif'}`;
  const colorLabel = (color) => `<span class="scribe-am-be-swatch" style="background:${esc(color)};"></span>`
    + `<span class="scribe-am-be-hex">${esc(color.toUpperCase())}</span>`;
  const regionLabel = (id) => REGIONS.find((r) => r.id === id)?.label || id;
  const styleLabel = (combo) => {
    let html = esc(combo);
    if (combo.includes('Small caps')) html = `<span style="font-variant:small-caps;">${html}</span>`;
    if (combo.includes('Underline')) html = `<u>${html}</u>`;
    if (combo.includes('Italic')) html = `<i>${html}</i>`;
    if (combo.includes('Bold')) html = `<b>${html}</b>`;
    return html;
  };
  const topStyleSeen = () => [...stylesSeen.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 'Regular';

  const selButton = (html, grow) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `scribe-am-be-sel${grow ? ' grow' : ''}`;
    b.innerHTML = `<span class="tx">${html}</span><span class="scribe-am-be-caret">▾</span>`;
    return b;
  };
  const quietButton = (label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'scribe-am-quiet';
    b.style.justifySelf = 'start';
    b.textContent = label;
    return b;
  };
  const runButton = (html, danger) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `scribe-am-run${danger ? ' danger' : ''}`;
    b.innerHTML = html;
    return b;
  };
  const note = (iconSvg, html) => {
    const el = document.createElement('div');
    el.className = 'scribe-am-note';
    el.innerHTML = `<span class="scribe-am-note-ic">${iconSvg}</span><span>${html}</span>`;
    return el;
  };
  const label = (text) => {
    const el = document.createElement('div');
    el.className = 'scribe-am-label';
    el.textContent = text;
    return el;
  };
  const smallNote = (text) => {
    const el = document.createElement('div');
    el.className = 'scribe-am-rdnote';
    el.textContent = text;
    return el;
  };

  let rescanTimer = 0;
  const rescanSoon = () => {
    clearTimeout(rescanTimer);
    rescanTimer = window.setTimeout(() => {
      scan();
      renderMatches();
      paintMarks();
    }, 150);
  };

  function buildRuleRow(rule, index) {
    const row = document.createElement('div');
    row.className = 'scribe-am-be-rule';
    const def = PROPS.find((p) => p.id === rule.prop) || PROPS[0];
    const propBtn = selButton(esc(def.label), false);
    propBtn.title = 'Property';
    propBtn.addEventListener('click', () => openMenu(propBtn, PROPS.map((p) => ({ value: p.id, html: esc(p.label), checked: p.id === rule.prop })), (id) => {
      if (id === rule.prop) return;
      const next = PROPS.find((p) => p.id === id);
      rule.prop = id;
      rule.op = next.ops[0];
      const exProps = example ? propsOf(example.line, example.n) : null;
      if (id === 'style') {
        const seed = exProps ? styleRuleFor(exProps.style) : null;
        rule.op = seed ? seed.op : next.ops[0];
        rule.value = seed ? seed.value : topStyleSeen();
      } else {
        rule.value = exProps ? String(exProps[id]) : (id === 'position' ? 'top' : '');
      }
      scan();
      render();
      paintMarks();
    }));
    const opBtn = selButton(esc(rule.op), false);
    opBtn.title = 'Operator';
    opBtn.addEventListener('click', () => openMenu(opBtn, def.ops.map((op) => ({ value: op, html: esc(op), checked: op === rule.op })), (op) => {
      rule.op = op;
      scan();
      render();
      paintMarks();
    }));
    row.append(propBtn, opBtn);
    if (rule.prop === 'font' || rule.prop === 'color' || rule.prop === 'style' || rule.prop === 'position') {
      const shown = rule.prop === 'font' ? esc(rule.value || 'Choose…')
        : rule.prop === 'color' ? (rule.value ? colorLabel(rule.value) : 'Choose…')
          : rule.prop === 'style' ? (rule.value ? styleLabel(rule.value) : 'Choose…')
            : esc(regionLabel(rule.value || 'top'));
      const valBtn = selButton(shown, true);
      valBtn.title = 'Value';
      valBtn.addEventListener('click', () => {
        let items;
        if (rule.prop === 'font') {
          items = [...fontsSeen.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => ({ value: f, html: esc(f), checked: f === rule.value }));
        } else if (rule.prop === 'color') {
          items = [...colorsSeen.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => ({ value: c, html: colorLabel(c), checked: c === rule.value }));
        } else if (rule.prop === 'style') {
          items = [...stylesSeen.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => ({ value: s, html: styleLabel(s), checked: s === rule.value }));
        } else {
          items = REGIONS.map((r) => ({ value: r.id, html: esc(r.label), checked: r.id === rule.value }));
        }
        openMenu(valBtn, items, (v) => {
          rule.value = v;
          scan();
          render();
          paintMarks();
        });
      });
      row.appendChild(valBtn);
    } else {
      const input = document.createElement('input');
      input.className = 'scribe-am-be-val';
      input.type = rule.prop === 'size' ? 'number' : 'text';
      if (rule.prop === 'size') {
        input.step = '0.5';
        input.min = '1';
        input.placeholder = 'pt';
      } else input.placeholder = 'Text to match';
      input.value = rule.value;
      input.setAttribute('aria-label', rule.prop === 'size' ? 'Size in points' : 'Text');
      input.addEventListener('input', () => {
        rule.value = input.value;
        rescanSoon();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          input.blur();
        }
      });
      if (rule.prop === 'size') {
        const unit = document.createElement('span');
        unit.style.cssText = 'font-size:12px;color:var(--scribe-ink-2);flex:none;';
        unit.textContent = 'pt';
        row.append(input, unit);
      } else row.appendChild(input);
    }
    const rx = document.createElement('span');
    rx.className = 'scribe-am-be-rx';
    rx.role = 'button';
    rx.tabIndex = 0;
    rx.title = 'Remove condition';
    rx.innerHTML = X_SVG;
    const remove = () => {
      rules.splice(index, 1);
      scan();
      render();
      paintMarks();
    };
    rx.addEventListener('click', remove);
    rx.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        remove();
      }
    });
    row.appendChild(rx);
    return row;
  }

  function buildRulesBlock() {
    const wrap = document.createElement('div');
    wrap.style.display = 'grid';
    wrap.style.gap = '8px';
    wrap.appendChild(label('All conditions must match'));
    const list = document.createElement('div');
    list.className = 'scribe-am-be-rules';
    rules.forEach((rule, i) => list.appendChild(buildRuleRow(rule, i)));
    if (!rules.length) {
      const empty = document.createElement('div');
      empty.className = 'scribe-am-empty';
      empty.style.padding = '2px 0';
      empty.textContent = 'Add a condition to start matching, or pick an example line in the document.';
      list.appendChild(empty);
    }
    wrap.appendChild(list);
    const unused = PROPS.filter((p) => !rules.some((r) => r.prop === p.id));
    if (unused.length) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'scribe-am-be-add';
      add.textContent = '+ Add condition';
      add.addEventListener('click', () => openMenu(add, unused.map((p) => ({ value: p.id, html: esc(p.label) })), (id) => {
        const def = PROPS.find((p) => p.id === id);
        const exProps = example ? propsOf(example.line, example.n) : null;
        if (id === 'style') {
          rules.push(exProps ? styleRuleFor(exProps.style) : { prop: 'style', op: def.ops[0], value: topStyleSeen() });
        } else {
          rules.push({ prop: id, op: def.ops[0], value: exProps ? String(exProps[id]) : (id === 'position' ? 'top' : '') });
        }
        scan();
        render();
        paintMarks();
      }));
      wrap.appendChild(add);
    }
    const repick = quietButton(example ? 'Pick a different example' : 'Pick an example line');
    repick.addEventListener('click', startPicking);
    wrap.appendChild(repick);
    return wrap;
  }

  /**
   * The page's own text around `m`, drawn at snippet scale with the match highlighted.
   * @param {Object} m
   * @param {number} width
   */
  function buildSnippetImage(m, width) {
    const img = document.createElement('div');
    img.className = 'scribe-am-be-simg';
    const page = doc.ocr.active[m.n];
    if (!page) return img;
    const dims = doc.pageMetrics[m.n].dims;
    const lineW = Math.max(1, m.line.bbox.right - m.line.bbox.left);
    const scalePx = Math.min(SNIP_PX_PER_PT / pxPerPt(viewer, m.n), (width - 16) / lineW);
    const bandH = SNIP_HEIGHT / scalePx;
    const viewW = width / scalePx;
    const midY = (m.line.bbox.top + m.line.bbox.bottom) / 2;
    const midX = (m.line.bbox.left + m.line.bbox.right) / 2;
    // A line at the page's edge sits at the band's edge, so the band still reaches its one neighbor for context.
    const others = page.lines.filter((l) => l !== m.line && l.words.length > 0);
    const above = others.some((l) => l.bbox.bottom <= m.line.bbox.top);
    const below = others.some((l) => l.bbox.top >= m.line.bbox.bottom);
    let top = midY - bandH / 2;
    if (!above && below) top = m.line.bbox.top - 6 / scalePx;
    else if (above && !below) top = m.line.bbox.bottom + 6 / scalePx - bandH;
    const left = Math.max(0, Math.min(dims.width - viewW, midX - viewW / 2));
    for (const line of page.lines) {
      if (line.bbox.bottom < top || line.bbox.top > top + bandH || line.words.length === 0) continue;
      const w = line.words.find((x) => /[\p{L}\p{N}]/u.test(x.text)) || line.words[0];
      const sizePx = (w.style.size || Math.abs(w.bbox.bottom - w.bbox.top) / 0.75) * scalePx;
      const el = document.createElement('span');
      el.className = `scribe-am-be-sline${line === m.line ? ' hit' : ''}`;
      el.textContent = getLineText(line);
      el.dataset.tw = String((line.bbox.right - line.bbox.left) * scalePx);
      Object.assign(el.style, {
        left: `${(line.bbox.left - left) * scalePx}px`,
        top: `${(line.bbox.top - top) * scalePx}px`,
        fontSize: `${Math.max(3, sizePx)}px`,
        fontFamily: fontCss(cleanFamilyName((w.style.font || '').replace(/^[A-Z]{6}\+/, '')) || 'sans-serif'),
        fontWeight: w.style.bold ? '700' : '400',
        fontStyle: w.style.italic ? 'italic' : 'normal',
        color: w.style.color || '#000',
        opacity: line === m.line ? '1' : '.45',
        transformOrigin: '0 50%',
      });
      img.appendChild(el);
    }
    return img;
  }

  /** Squeeze each snippet line to the width its glyphs have on the page, since the substitute font rarely shares the PDF font's metrics. */
  function fitSnippetLines(within) {
    for (const el of within.querySelectorAll('.scribe-am-be-sline[data-tw]')) {
      const target = Number(el.dataset.tw);
      const measured = el.getBoundingClientRect().width;
      if (target > 0 && measured > target * 1.02) el.style.transform = `scaleX(${(target / measured).toFixed(3)})`;
    }
  }

  async function jumpTo(m) {
    current = m;
    await viewer.displayPage(m.n, false, false);
    if (destroyed) return;
    const idx = viewer.textSel?.index(m.n);
    const e = idx ? idx.lines.find((x) => x.line === m.line) : null;
    if (e) {
      const box = nativeLineDrawBox(doc, m.line, e.lbox);
      const c = viewer.localToContent(m.n, e.orientation, (box.left + box.right) / 2, (box.top + box.bottom) / 2);
      const sc = viewer.scrollContainer;
      const zoom = viewer.zoomLevel || 1;
      sc.scrollTop = c.y * zoom - sc.clientHeight / 2;
      viewer.updateCurrentPage?.();
    }
    paintMarks();
  }

  /** @type {?HTMLElement} */
  let countEl = null;
  /** @type {?HTMLElement} */
  let matchBlock = null;

  function renderMatches() {
    if (!countEl || !matchBlock) return;
    const pages = new Set(matches.map((m) => m.n)).size;
    countEl.innerHTML = `<b>${matches.length}</b><span>${matches.length === 1 ? 'line' : 'lines'} on ${pages} ${pages === 1 ? 'page' : 'pages'} ${matches.length === 1 ? 'matches' : 'match'}</span>`;
    matchBlock.textContent = '';
    if (!groups.length) {
      renderFoot();
      return;
    }
    const looks = groups.length;
    matchBlock.appendChild(label(`${matches.length} ${matches.length === 1 ? 'match' : 'matches'} · ${looks} distinct ${looks === 1 ? 'look' : 'looks'} · click a card to jump`));
    const snips = document.createElement('div');
    snips.className = 'scribe-am-be-snips';
    const cardW = Math.max(120, body.clientWidth - 26);
    for (const g of groups) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `scribe-am-be-snip${g.excluded ? ' excl' : ''}`;
      card.title = 'Jump to this match in the document';
      const first = g.items[0];
      const last = g.items[g.items.length - 1];
      const pagesLabel = first.n === last.n ? `p. ${first.n + 1}` : `p. ${first.n + 1}–${last.n + 1}`;
      card.appendChild(buildSnippetImage(first, cardW));
      const bar = document.createElement('div');
      bar.className = 'scribe-am-be-sbar';
      bar.innerHTML = g.items.length > 1
        ? `<b>×${g.items.length} identical</b><span class="pg">${pagesLabel}</span>`
        : `<b>${pagesLabel}</b><span class="pg">${esc(first.p.text).slice(0, 60)}</span>`;
      const keep = document.createElement('span');
      keep.className = 'scribe-am-be-skeep';
      keep.textContent = g.excluded ? 'EXCLUDED' : 'DELETING';
      const sx = document.createElement('button');
      sx.type = 'button';
      sx.className = 'scribe-am-quiet scribe-am-be-sx';
      sx.textContent = g.excluded ? 'Restore' : 'Exclude';
      sx.addEventListener('click', (e) => {
        e.stopPropagation();
        g.excluded = !g.excluded;
        if (g.excluded) excludedKeys.add(g.key);
        else excludedKeys.delete(g.key);
        renderMatches();
        paintMarks();
      });
      bar.append(keep, sx);
      card.appendChild(bar);
      card.addEventListener('click', () => {
        const item = g.items[g.cursor % g.items.length];
        g.cursor += 1;
        jumpTo(item);
      });
      snips.appendChild(card);
    }
    matchBlock.appendChild(snips);
    fitSnippetLines(snips);
    matchBlock.appendChild(smallNote('Click a card to jump the document to that match; Exclude/Restore decides without navigating.'));

    const confirm = document.createElement('div');
    confirm.style.display = 'grid';
    confirm.style.gap = '8px';
    confirm.appendChild(label('Confirm'));
    const seg = document.createElement('div');
    seg.className = 'scribe-am-be-seg';
    ['Before', 'After'].forEach((name) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = name.toLowerCase() === view ? 'on' : '';
      b.textContent = name;
      b.addEventListener('click', () => {
        view = /** @type {'before'|'after'} */ (name.toLowerCase());
        if (view === 'after') showPill();
        else hidePill();
        renderMatches();
        paintMarks();
      });
      seg.appendChild(b);
    });
    confirm.appendChild(seg);
    const desc = document.createElement('div');
    desc.className = 'scribe-am-desc';
    desc.textContent = `After shows the document as the delete would leave it — the ${keptCount()} matched ${keptCount() === 1 ? 'line' : 'lines'} hidden, nothing committed.`;
    confirm.appendChild(desc);
    matchBlock.appendChild(confirm);
    renderFoot();
  }

  function renderFoot() {
    foot.textContent = '';
    if (stage !== 'select' || !groups.length) {
      foot.style.display = 'none';
      return;
    }
    foot.style.display = '';
    const sum = document.createElement('div');
    sum.className = 'scribe-am-rdsum';
    const kept = keptCount();
    const ex = excludedCount();
    sum.innerHTML = `<span><b>${kept}</b> to delete · ${ex} excluded</span>`;
    const grow = document.createElement('span');
    grow.style.flex = '1';
    const del = runButton(`Delete ${kept} ${kept === 1 ? 'line' : 'lines'}`, true);
    del.disabled = kept === 0;
    del.addEventListener('click', doDelete);
    sum.append(grow, del);
    foot.appendChild(sum);
    foot.appendChild(smallNote(ex > 0 ? 'Excluded lines stay untouched in the document. Deletes are recorded edits — undo restores them.' : 'Deletes are recorded edits — undo restores them.'));
  }

  function doDelete() {
    const lines = [];
    for (const g of groups) {
      if (g.excluded) continue;
      for (const m of g.items) if (m.line.page && m.line.page.lines.includes(m.line)) lines.push(m.line);
    }
    if (!lines.length) return;
    const excluded = excludedCount();
    const pages = new Set(lines.map((l) => l.page.n));
    let res;
    try {
      res = doc.docHistory.group(`Deleted ${lines.length} lines (Bulk Edit)`, () => doc.deleteTextLines(lines));
    } catch (err) {
      console.error('Bulk Edit: delete failed:', err);
      body.prepend(note(FLAG_SVG, 'The delete failed; nothing was changed.'));
      return;
    }
    view = 'before';
    hidePill();
    current = null;
    clearMarks();
    refreshEditedPages(viewer, res.pages);
    lastDelete = {
      entry: doc.docHistory.undoStack[doc.docHistory.undoStack.length - 1],
      count: lines.length,
      pages: pages.size,
      excluded,
    };
    stage = 'done';
    render();
  }

  function render() {
    closeMenu();
    body.textContent = '';
    countEl = null;
    matchBlock = null;
    if (stage === 'empty') {
      const desc = document.createElement('div');
      desc.className = 'scribe-am-desc';
      desc.textContent = 'Select many lines at once by what they have in common — font, size, color, style, position, text — then edit or delete them together.';
      body.appendChild(desc);
      const pick = runButton(`<span style="display:inline-flex;width:14px;height:14px;margin-right:7px;vertical-align:-2px;">${PICK_SVG}</span>Pick an example line`, false);
      pick.style.justifySelf = 'start';
      if (!viewer.textSel) {
        pick.disabled = true;
        pick.title = 'Picking needs the standard text selection engine';
      }
      pick.addEventListener('click', startPicking);
      body.appendChild(pick);
      const manual = quietButton('Or add criteria manually');
      manual.addEventListener('click', () => {
        stage = 'select';
        scan();
        render();
        paintMarks();
      });
      body.appendChild(manual);
      renderFoot();
      return;
    }
    if (stage === 'picking') {
      const kbd = '<kbd style="font-family:inherit;font-size:10.5px;font-weight:600;color:var(--scribe-ink-3);'
        + 'border:1px solid var(--scribe-line-strong);border-radius:4px;padding:0 4px;">Esc</kbd>';
      body.appendChild(note(PICK_SVG, '<b style="color:var(--scribe-ink);">Click a line in the document.</b> '
        + `Its properties become the selector. ${kbd} cancels.`));
      const cancel = quietButton('Cancel');
      cancel.addEventListener('click', cancelPicking);
      body.appendChild(cancel);
      renderFoot();
      return;
    }
    if (stage === 'done' && lastDelete) {
      const d = lastDelete;
      const excludedText = d.excluded > 0 ? ` The ${d.excluded} excluded ${d.excluded === 1 ? 'line was' : 'lines were'} left untouched.` : '';
      const rec = note(`<span style="color:#2e7d4f;">${CHECK_SVG}</span>`, `<b style="color:var(--scribe-ink);">Deleted ${d.count} ${d.count === 1 ? 'line' : 'lines'} on ${d.pages} ${d.pages === 1 ? 'page' : 'pages'}.</b>${esc(excludedText)}`);
      body.appendChild(rec);
      const acts = document.createElement('div');
      acts.style.display = 'flex';
      acts.style.gap = '8px';
      const undo = quietButton('Undo');
      const stack = doc.docHistory.undoStack;
      const isTop = stack.length > 0 && stack[stack.length - 1] === d.entry;
      undo.disabled = !isTop;
      if (!isTop) undo.title = 'Later edits come first — use the edit history (Ctrl+Z).';
      undo.addEventListener('click', () => {
        if (!viewer.undo()) return;
        lastDelete = null;
        stage = 'select';
        scan();
        render();
        paintMarks();
      });
      const again = quietButton('Run again');
      again.addEventListener('click', () => {
        lastDelete = null;
        stage = 'select';
        scan();
        render();
        paintMarks();
      });
      acts.append(undo, again);
      body.appendChild(acts);
      body.appendChild(smallNote(`Also in the edit history — Ctrl+Z restores all ${d.count} ${d.count === 1 ? 'line' : 'lines'} as one step.`));
      renderFoot();
      return;
    }
    countEl = document.createElement('div');
    countEl.className = 'scribe-am-be-count';
    body.appendChild(countEl);
    body.appendChild(buildRulesBlock());
    matchBlock = document.createElement('div');
    matchBlock.style.display = 'grid';
    matchBlock.style.gap = '10px';
    body.appendChild(matchBlock);
    renderMatches();
  }

  viewer.scrollContainer.addEventListener('pointermove', onPointerMove);
  viewer.scrollContainer.addEventListener('pointerdown', onPointerDown, true);
  viewer.scrollContainer.addEventListener('pointerup', onPointerUp, true);
  viewer.scrollContainer.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize);
  // Page renders rebuild the text groups the marks live in, so every render has to repaint them.
  const prevDisplayCb = viewer.displayPageCallback;
  const ourDisplayCb = () => {
    if (prevDisplayCb) prevDisplayCb();
    schedulePaint();
  };
  viewer.displayPageCallback = ourDisplayCb;

  (async () => {
    // A freshly-opened PDF may still be extracting text, so a scan before it settles would miss lines.
    if (doc._textReadySettle) await doc.textReady;
  })().then(() => { if (!destroyed && stage === 'select') { scan(); render(); paintMarks(); } });

  render();

  return {
    refresh: () => {
      if (stage === 'select') {
        scan();
        render();
        paintMarks();
      }
    },
    teardown: () => {
      destroyed = true;
      endPicking();
      closeMenu();
      clearTimeout(rescanTimer);
      if (paintRaf) cancelAnimationFrame(paintRaf);
      clearMarks();
      hidePill();
      viewer.scrollContainer?.removeEventListener('pointermove', onPointerMove);
      viewer.scrollContainer?.removeEventListener('pointerdown', onPointerDown, true);
      viewer.scrollContainer?.removeEventListener('pointerup', onPointerUp, true);
      viewer.scrollContainer?.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      if (viewer.displayPageCallback === ourDisplayCb) viewer.displayPageCallback = prevDisplayCb;
    },
  };
}
