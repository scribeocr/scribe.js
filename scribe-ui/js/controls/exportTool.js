import scribeLib from '../../../scribe.js';
import { ARTICLE_RULES, writeHtmlFragment } from '../../../js/export/writeHtml.js';
import { docxStrings } from '../../../js/export/resources/docxFiles.js';
import { scribeDocDefaults } from '../../../js/containers/scribeDocDefaults.js';
import { makeIconButton } from './toolbar.js';
import { hydrateIfProvisional } from './tools.js';
import { resolveActiveSheet } from '../viewerTablePreview.js';

const modeIcon = (inner) => `<svg viewBox="0 0 17 17" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none;display:block;width:100%;height:100%;" aria-hidden="true">${inner}</svg>`;
export const EXPORT_MODE_SVG = modeIcon('<path d="M8.5 2.5v8m-3-3 3 3 3-3M3.5 14.5h10"/>');
const LINK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1"/><path d="M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1"/></svg>';
const CARET_SVG = '<svg viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M2.5 4.5l3 3 3-3"/></svg>';
/** The gap the HTML export leaves between pages, in page pixels. */
const PAGE_GAP = 10;
const PANE_GUTTER = 8;

/**
 * @typedef {Object} ExportFormat
 * @property {'pdf'|'docx'|'xlsx'|'html'|'txt'|'md'|'hocr'|'alto'|'scribe'} id
 * @property {string} label
 * @property {string} ext
 * @property {'pages'|'document'|'pdf'|'sheet'|'summary'} surface - What the preview shows.
 * @property {Array<string>} options - The keys of the mode's settings that the format honors.
 * @property {string} [style]
 * @property {boolean} [reflow] - Whether the format joins lines into paragraphs by default.
 * @property {boolean} [needsWords]
 */
/** @type {Array<ExportFormat>} */
export const EXPORT_FORMATS = [
  {
    id: 'pdf',
    label: 'PDF',
    ext: '.pdf',
    surface: 'pdf',
    options: ['pages', 'textLayer'],
  },
  {
    id: 'docx',
    label: 'Word',
    ext: '.docx',
    surface: 'document',
    style: 'word',
    reflow: true,
    needsWords: true,
    options: ['pages', 'reflow', 'dropHeadersFooters'],
  },
  {
    id: 'xlsx',
    label: 'Excel',
    ext: '.xlsx',
    surface: 'sheet',
    options: ['pages', 'sheets', 'formatting'],
  },
  {
    id: 'html',
    label: 'HTML',
    ext: '.html',
    surface: 'document',
    style: 'html',
    reflow: false,
    needsWords: true,
    options: ['pages', 'reflow', 'dropHeadersFooters', 'images', 'fit', 'fonts'],
  },
  {
    id: 'txt',
    label: 'Text',
    ext: '.txt',
    surface: 'document',
    style: 'text',
    reflow: true,
    needsWords: true,
    options: ['pages', 'reflow', 'dropHeadersFooters', 'lineNumbers'],
  },
  {
    id: 'md',
    label: 'Markdown',
    ext: '.md',
    surface: 'document',
    style: 'markdown',
    reflow: true,
    needsWords: true,
    options: ['pages', 'reflow', 'dropHeadersFooters'],
  },
  {
    id: 'hocr',
    label: 'hOCR',
    ext: '.hocr',
    surface: 'pages',
    needsWords: true,
    options: ['pages'],
  },
  {
    id: 'alto',
    label: 'ALTO XML',
    ext: '.xml',
    surface: 'pages',
    needsWords: true,
    options: ['pages'],
  },
  {
    id: 'scribe',
    label: 'Session',
    ext: '.scribe',
    surface: 'summary',
    options: ['session'],
  },
];
const formatOf = (id) => /** @type {ExportFormat} */ (EXPORT_FORMATS.find((f) => f.id === id));

/**
 * Whether a document has words to export as text.
 * A provisional document passes.
 * @param {?import('../../../js/containers/scribeDoc.js').ScribeDoc} doc
 */
export const docHasWords = (doc) => !!doc
  // The mode hydrates a provisional document and checks again once its text arrives.
  && (doc.id < 0 || !!doc.ocr?.active?.some((page) => page?.lines?.some((line) => line.words.length > 0)));

const PANE_RULES = '  .scribe-export-body {\n    position:relative;\n    margin:0 auto;\n  }\n  .scribe-page {\n    background:#fff;\n    box-shadow:var(--scribe-page-shadow);\n  }\n';
const BOXES_RULES = '  .scribe-word {\n    outline:1px solid rgba(28,98,212,.45);\n    outline-offset:1px;\n  }\n';
const PAPER_RULES = '  .scribe-article {\n    background:#fff;\n    box-shadow:var(--scribe-page-shadow);\n    margin:6px auto 20px;\n    width:calc(100% - 12px);\n    box-sizing:border-box;\n  }\n';
const DOC_STYLES = {
  markdown: '  .scribe-article {\n    max-width:52em;\n    padding:1.5em 1.6em 2.5em;\n    font:14px/1.6 -apple-system,system-ui,\'Segoe UI\',sans-serif;\n    color:#1f2530;\n  }\n'
    + '  .scribe-article h1 {\n    font-size:1.5em;\n    margin:0 0 .5em;\n    padding-bottom:.3em;\n    border-bottom:1px solid #e4e8ef;\n  }\n'
    + '  .scribe-article h2 {\n    font-size:1.3em;\n    margin:1em 0 .4em;\n    padding-bottom:.3em;\n    border-bottom:1px solid #e4e8ef;\n  }\n'
    + '  .scribe-article h3, .scribe-article h4, .scribe-article h5, .scribe-article h6 {\n    font-size:1.1em;\n    margin:1em 0 .3em;\n  }\n'
    + '  .scribe-article p {\n    margin:0 0 .9em;\n  }\n  .scribe-article ul, .scribe-article ol {\n    margin:0 0 .9em;\n    padding-left:1.6em;\n  }\n'
    + '  .scribe-article blockquote {\n    margin:0 0 .9em;\n    padding-left:1em;\n    border-left:3px solid #d7dce4;\n    color:#586170;\n  }\n'
    + '  .scribe-article pre {\n    margin:.7em 0;\n    padding:.6em .8em;\n    background:#f6f8fa;\n    border-radius:4px;\n'
      + '    font:.85em/1.45 ui-monospace,Menlo,Consolas,monospace;\n    overflow-x:auto;\n  }\n'
    + '  .scribe-article table {\n    border-collapse:collapse;\n    margin:0 0 1em;\n    font-size:.95em;\n  }\n  .scribe-article th, .scribe-article td {\n'
      + '    border:1px solid #d8d8d8;\n    padding:.25em .6em;\n    text-align:left;\n    vertical-align:top;\n  }\n'
    + '  .scribe-article th {\n    background:#f6f8fa;\n  }\n'
    + '  .scribe-article .scribe-page-header, .scribe-article .scribe-page-footer, .scribe-article .scribe-page-number, .scribe-article .scribe-line-number {\n'
      + '    font-size:.85em;\n    color:#586170;\n  }\n'
    + '  .scribe-article .scribe-fnref a {\n    text-decoration:none;\n  }\n  .scribe-article .scribe-notes {\n    margin-top:2em;\n    padding-top:.6em;\n'
      + '    border-top:1px solid #e4e8ef;\n    font-size:.9em;\n  }\n'
    + '  .scribe-article .scribe-notes ol {\n    list-style:none;\n    padding-left:0;\n  }\n  .scribe-article .scribe-fnlabel {\n    font-weight:600;\n    margin-right:.4em;\n  }\n',
  text: '  .scribe-article {\n    max-width:80ch;\n    padding:1em 1.2em 2em;\n    font:12.5px/1.5 ui-monospace,Menlo,Consolas,monospace;\n    color:#1f2530;\n  }\n'
    + '  .scribe-article h1, .scribe-article h2, .scribe-article h3, .scribe-article h4, .scribe-article h5, .scribe-article h6 {\n    font-size:1em;\n'
      + '    font-weight:400;\n    margin:0 0 1.5em;\n  }\n'
    + '  .scribe-article p {\n    margin:0 0 1.5em;\n  }\n  .scribe-article ul, .scribe-article ol {\n    margin:0 0 1.5em;\n    padding-left:0;\n  }\n'
    + '  .scribe-article ul, .scribe-article ol {\n    list-style:none;\n  }\n  .scribe-article li {\n    margin:0 0 1.5em;\n  }\n'
    + '  .scribe-article li[data-marker]::before {\n    content:attr(data-marker) " ";\n  }\n'
    + '  .scribe-article blockquote {\n    margin:0 0 1.5em;\n  }\n  .scribe-article pre {\n    margin:0 0 1.5em;\n    font:inherit;\n    white-space:pre-wrap;\n  }\n'
    + '  .scribe-article table {\n    border-collapse:collapse;\n    margin:0 0 1.5em;\n  }\n  .scribe-article th, .scribe-article td {\n'
      + '    padding:0 2ch 0 0;\n    text-align:left;\n    vertical-align:top;\n    font-weight:400;\n  }\n'
    + '  .scribe-article .scribe-fnref a {\n    text-decoration:none;\n  }\n  .scribe-article .scribe-notes {\n    margin-top:1.5em;\n  }\n'
      + '  .scribe-article .scribe-notes ol {\n    list-style:none;\n  }\n'
    + '  .scribe-article .scribe-fnlabel {\n    margin-right:1ch;\n  }\n  .scribe-article b {\n    font-weight:400;\n  }\n  .scribe-article i {\n    font-style:normal;\n  }\n',
};
let wordStylesCache = null;
/**
 * The Word preview's stylesheet and body font family.
 * @returns {{css: string, family: string}}
 */
const wordStyles = () => {
  if (wordStylesCache) return wordStylesCache;
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  /** @param {string} path */
  const part = (path) => new DOMParser().parseFromString(docxStrings.find((f) => f.path === path)?.content || '<x/>', 'application/xml');
  const styles = part('word/styles.xml');
  const theme = part('word/theme/theme1.xml');
  /** @param {?Element} el @param {string} name */
  const child = (el, name) => (el ? el.getElementsByTagNameNS(W, name)[0] || null : null);
  /** @param {?Element} el @param {string} [attr] */
  const num = (el, attr = 'val') => { const v = el?.getAttributeNS(W, attr); return v == null ? NaN : Number(v); };
  /** @param {string} id */
  const styleOf = (id) => [...styles.getElementsByTagNameNS(W, 'style')].find((el) => el.getAttributeNS(W, 'styleId') === id) || null;
  const defaults = child(styles.documentElement, 'docDefaults');
  const bodyPt = num(child(child(defaults, 'rPrDefault'), 'sz')) / 2 || 11;
  const pSpacing = child(child(defaults, 'pPrDefault'), 'spacing');
  const afterPt = num(pSpacing, 'after') / 20 || 0;
  const line = Math.round((num(pSpacing, 'line') / 240 || 1) * 1000) / 1000;
  const minor = theme.getElementsByTagNameNS(A, 'minorFont')[0]?.getElementsByTagNameNS(A, 'latin')[0]?.getAttribute('typeface') || 'Calibri';
  const family = `"${minor}", Carlito, sans-serif`;
  // The Word export writes every heading level as Heading 1.
  const h = styleOf('Heading1');
  const hSpacing = child(h, 'spacing');
  const hColor = child(h, 'color')?.getAttributeNS(W, 'val');
  const qInd = child(styleOf('Quote'), 'ind');
  const fn = styleOf('FootnoteText');
  const fnSpacing = child(fn, 'spacing');
  const cellMar = child(styleOf('TableNormal'), 'tblCellMar');
  /** @param {string} side */
  const cellPt = (side) => num(child(cellMar, side), 'w') / 20 || 0;
  const css = `  .scribe-article {\n    max-width:8.5in;\n    padding:1in;\n    font:${bodyPt}pt/${line} ${family};\n    color:#000;\n  }\n`
    + '  .scribe-article h1, .scribe-article h2, .scribe-article h3, .scribe-article h4, .scribe-article h5, .scribe-article h6 {\n'
      + `    font-weight:${child(h, 'b') ? '700' : '400'};\n    font-size:${num(child(h, 'sz')) / 2 || bodyPt}pt;\n    line-height:${line};\n`
      + `    color:${hColor && hColor !== 'auto' ? `#${hColor}` : 'inherit'};\n`
      + `    margin:${num(hSpacing, 'before') / 20 || 0}pt 0 ${num(hSpacing, 'after') / 20 || afterPt}pt;\n  }\n`
    + `  .scribe-article p {\n    margin:0 0 ${afterPt}pt;\n  }\n`
    + `  .scribe-article ul, .scribe-article ol {\n    list-style:none;\n    margin:0;\n    padding:0;\n  }\n  .scribe-article li {\n    margin:0 0 ${afterPt}pt;\n  }\n`
    + '  .scribe-article li[data-marker]::before {\n    content:attr(data-marker) " ";\n  }\n'
    + `  .scribe-article blockquote {\n    margin:0 ${num(qInd, 'right') / 1440 || 0}in ${afterPt}pt ${num(qInd, 'left') / 1440 || 0}in;\n  }\n  .scribe-article blockquote p {\n    margin:0;\n  }\n`
    // A code block is written as one paragraph per line.
    + `  .scribe-article pre {\n    margin:0 0 ${afterPt}pt;\n    font:inherit;\n    line-height:calc(${line}em + ${afterPt}pt);\n    white-space:pre-wrap;\n  }\n`
    + `  .scribe-article table {\n    border-collapse:collapse;\n    margin:0 0 ${afterPt}pt;\n  }\n  .scribe-article th, .scribe-article td {\n    border:.5pt solid #000;\n`
      + `    padding:${cellPt('top')}pt ${cellPt('right')}pt ${cellPt('bottom') + afterPt}pt ${cellPt('left')}pt;\n    font-weight:inherit;\n    text-align:left;\n    vertical-align:top;\n  }\n`
    + '  .scribe-article .scribe-fnref a {\n    text-decoration:none;\n    color:inherit;\n  }\n'
    + `  .scribe-article .scribe-notes {\n    margin-top:18pt;\n    border-top:1px solid #000;\n    width:33%;\n    padding-top:2pt;\n    font-size:${num(child(fn, 'sz')) / 2 || bodyPt}pt;\n`
      + `    line-height:${Math.round((num(fnSpacing, 'line') / 240 || line) * 1000) / 1000};\n  }\n`
    + `  .scribe-article .scribe-notes ol {\n    width:300%;\n  }\n  .scribe-article .scribe-notes li {\n    margin:0 0 ${num(fnSpacing, 'after') / 20 || 0}pt;\n  }\n`
    + '  .scribe-article .scribe-fnlabel {\n    vertical-align:super;\n    font-size:.7em;\n    margin-right:.3em;\n  }\n';
  wordStylesCache = { css, family };
  return wordStylesCache;
};
/** @param {ExportFormat} f */
const docRules = (f) => (f.style === 'html' ? ARTICLE_RULES : f.style === 'word' ? wordStyles().css : DOC_STYLES[f.style || 'markdown']);
const CHIP_RULES = '  .scribe-export-chip {\n    position:absolute;\n    display:inline-flex;\n    align-items:center;\n    gap:4px;\n    padding:2px 8px;\n'
  + '    border:1px solid var(--scribe-line-strong);\n    border-radius:999px;\n    background:var(--scribe-surface);\n    color:var(--scribe-ink-2);\n'
  + '    font:11px/1.4 system-ui,sans-serif;\n    cursor:pointer;\n    z-index:3;\n    white-space:nowrap;\n  }\n'
  + '  .scribe-export-chip:hover, .scribe-export-chip.open {\n    color:var(--scribe-accent);\n    border-color:var(--scribe-accent);\n  }\n'
  + '  .scribe-export-chip svg {\n    width:11px;\n    height:11px;\n  }\n'
  + '  .scribe-export-rolemenu {\n    position:absolute;\n    z-index:4;\n    min-width:150px;\n    padding:4px;\n    background:var(--scribe-surface);\n'
  + '    border:1px solid var(--scribe-line);\n    border-radius:8px;\n    box-shadow:var(--scribe-menu-shadow);\n    font:13px/18px system-ui,sans-serif;\n    color:var(--scribe-ink);\n  }\n'
  + '  .scribe-export-rolemenu button {\n    display:block;\n    width:100%;\n    padding:4px 10px;\n    border:none;\n    border-radius:4px;\n    background:transparent;\n'
  + '    font:inherit;\n    color:inherit;\n    text-align:left;\n    cursor:pointer;\n    white-space:nowrap;\n  }\n'
  + '  .scribe-export-rolemenu button:hover, .scribe-export-rolemenu button:focus {\n    background:var(--scribe-hover);\n    outline:none;\n  }\n'
  + '  .scribe-export-rolemenu button.on {\n    color:var(--scribe-accent);\n    font-weight:600;\n  }\n'
  + '  [data-par]:focus {\n    outline:2px solid var(--scribe-accent);\n    outline-offset:2px;\n  }\n'
  + '  .scribe-export-chip[hidden], .scribe-export-rolemenu[hidden] {\n    display:none;\n  }\n';
const SUMMARY_RULES = '  .scribe-export-summary {\n    max-width:420px;\n    margin:16px auto;\n    padding:12px 14px;\n    background:var(--scribe-surface);\n'
  + '    border:1px solid var(--scribe-line);\n    border-radius:8px;\n'
  + '    font:13px/1.5 system-ui,sans-serif;\n    color:var(--scribe-ink);\n  }\n  .scribe-export-summary h4 {\n    margin:0 0 8px;\n    font-size:13px;\n    word-break:break-all;\n  }\n'
  + '  .scribe-export-summary dl {\n    display:grid;\n    grid-template-columns:auto 1fr;\n    gap:4px 14px;\n    margin:0;\n    font-size:12.5px;\n  }\n'
  + '  .scribe-export-summary dt {\n    color:var(--scribe-ink-2);\n  }\n  .scribe-export-summary dd {\n    margin:0;\n  }\n  .scribe-export-summary p {\n'
    + '    margin:10px 0 0;\n    font-size:12px;\n    color:var(--scribe-ink-2);\n  }\n';
const esc = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * The Export mode tool.
 * @param {import('../../basic-viewer/pdf-viewer.js').ScribePDFViewer} app
 * @returns {{ toolbarElem: HTMLElement, isActive: () => boolean, open: (format?: string) => void, close: () => void, viewSegElem: () => HTMLElement,
 *   toolsElem: () => HTMLElement, docChanged: () => void, hintText: () => ?string, format: () => string }}
 */
export function createExportTool(app) {
  const toolbarElem = makeIconButton('Export', EXPORT_MODE_SVG);
  toolbarElem.classList.add('cr-labeled-button');
  const toolbarLabelElem = document.createElement('span');
  toolbarLabelElem.className = 'cr-btn-label';
  toolbarLabelElem.textContent = 'Export';
  toolbarElem.appendChild(toolbarLabelElem);
  let active = false;
  /** @type {'page'|'preview'|'beside'} */
  let view = 'page';
  // The mode's viewer is fixed at entry, since a press into the other group during Side by side makes that group active without ending the mode.
  let modeViewer = null;
  const viewerOf = () => modeViewer || app._activeViewer();
  const settings = {
    /** @type {ExportFormat['id']} */
    format: 'pdf',
    /** @type {'all'|'current'|'range'} */
    pages: 'all',
    range: '',
    /** @type {Partial<Record<ExportFormat['id'], boolean>>} */
    reflow: {},
    dropHeadersFooters: false,
    images: false,
    /** @type {'hidden'|'visible'|'proof'} */
    textLayer: 'hidden',
    fit: false,
    /** @type {'cdn'|'embed'} */
    fonts: 'cdn',
    /** @type {'perTable'|'flat'} */
    sheets: 'perTable',
    formatting: true,
    lineNumbers: false,
    session: true,
  };
  const format = () => formatOf(settings.format);
  const reflowOn = () => settings.reflow[settings.format] ?? !!format().reflow;
  const surfaceOf = () => {
    const f = format();
    if (f.surface === 'pdf') return view === 'beside' ? 'pdf' : 'pages';
    if (f.surface === 'document' && !reflowOn()) return f.id === 'html' ? 'pages' : 'lines';
    return f.surface;
  };

  // ---- The pane. ----
  const pane = document.createElement('div');
  pane.className = 'scribe-export-pane';
  pane.tabIndex = 0;
  pane.setAttribute('aria-label', 'Export preview');
  // The pane sits inside a viewer's container, whose document-level wheel and key handlers would pan the viewer under it and cancel the pane's own scroll.
  // Only the scroll keys stop, so Esc and the shortcuts still work.
  pane.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  pane.addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) e.stopPropagation();
  });
  // The viewer's document-level handler would aim the autoscroll at the page under the pane.
  pane.addEventListener('mousedown', (e) => {
    if (e.button !== 1) return;
    e.stopPropagation();
    viewerOf().startAutoScroll(e, pane);
  });
  const shadow = pane.attachShadow({ mode: 'open' });
  const paneStyle = document.createElement('style');
  const paneBody = document.createElement('div');
  paneBody.className = 'scribe-export-body';
  shadow.append(paneStyle, paneBody);
  /** @type {Array<HTMLElement>} */
  let articleBlocks = [];
  /** @type {Array<number>} */
  let blockTops = [];
  /** @type {Array<number>} */
  let blockHeights = [];
  /** @type {Array<{top: number, bottom: number}>} Each block's span in the viewer's content space. */
  let blockSpans = [];
  /** @type {Map<string, {par: OcrPar, n: number}>} */
  let parInfo = new Map();
  /** @type {Map<string, {line: OcrLine, n: number}>} */
  let lineInfo = new Map();
  /** @param {HTMLElement} el */
  const blockSpanOf = (el) => {
    const sv = viewerOf();
    const p = parInfo.get(el.dataset.par || '');
    if (p) {
      const orientation = p.par.lines[0]?.orientation || 0;
      return { top: sv.localToContent(p.n, orientation, p.par.bbox.left, p.par.bbox.top).y, bottom: sv.localToContent(p.n, orientation, p.par.bbox.left, p.par.bbox.bottom).y };
    }
    const l = lineInfo.get(el.dataset.line || '');
    if (l) {
      return {
        top: sv.localToContent(l.n, l.line.orientation || 0, l.line.bbox.left, l.line.bbox.top).y,
        bottom: sv.localToContent(l.n, l.line.orientation || 0, l.line.bbox.left, l.line.bbox.bottom).y,
      };
    }
    return null;
  };
  /** @param {HTMLElement} el */
  const paneOffset = (el) => {
    let x = 0;
    let y = 0;
    for (let e = /** @type {?HTMLElement} */ (el); e && e !== pane; e = /** @type {?HTMLElement} */ (e.offsetParent)) {
      x += e.offsetLeft;
      y += e.offsetTop;
    }
    return { x, y };
  };
  const cacheBlocks = () => {
    blockTops = articleBlocks.map((el) => paneOffset(el).y);
    blockHeights = articleBlocks.map((el) => el.offsetHeight);
    blockSpans = [];
    const sv = viewerOf();
    if (!sv.doc) return;
    let i = 0;
    while (i < articleBlocks.length) {
      const n = Number(articleBlocks[i].dataset.page);
      let j = i;
      while (j < articleBlocks.length && Number(articleBlocks[j].dataset.page) === n) j++;
      /** @type {Array<?{top: number, bottom: number}>} */
      const spans = [];
      let ordered = true;
      for (let k = i; k < j; k++) {
        const span = blockSpanOf(articleBlocks[k]);
        const prev = spans[spans.length - 1];
        if (!span || (prev && span.top < prev.top - 1)) ordered = false;
        spans.push(span);
      }
      // A page's reading order can run back up the page, as with two columns.
      // Such a page gives each block a share of the page in proportion to its height in the pane, so the lane keeps moving down as the pane does.
      if (!ordered) {
        const start = sv.getPageStop(n);
        const end = sv.getPageStop(n, false);
        const paneTop = blockTops[i];
        const paneSpan = Math.max(1, blockTops[j - 1] + blockHeights[j - 1] - paneTop);
        for (let k = i; k < j; k++) {
          spans[k - i] = {
            top: start + ((blockTops[k] - paneTop) / paneSpan) * (end - start),
            bottom: start + ((blockTops[k] + blockHeights[k] - paneTop) / paneSpan) * (end - start),
          };
        }
      }
      for (const span of spans) blockSpans.push(/** @type {{top: number, bottom: number}} */ (span));
      i = j;
    }
    rebuildLinkKeys();
  };

  // ---- The role chips. ----
  const ROLES = [['Heading 1', 'h1'], ['Heading 2', 'h2'], ['Heading 3', 'h3'], ['Body', 'body'], ['Page header', 'header'], ['Page footer', 'footer']];
  /** @param {OcrPar} par */
  const roleKey = (par) => (par.type === 'title' ? `h${Math.min(Math.max(par.headingLevel || 1, 1), 3)}` : par.type);
  const chipEl = document.createElement('button');
  chipEl.type = 'button';
  chipEl.className = 'scribe-export-chip';
  chipEl.hidden = true;
  chipEl.setAttribute('aria-haspopup', 'true');
  const menuEl = document.createElement('div');
  menuEl.className = 'scribe-export-rolemenu';
  menuEl.setAttribute('role', 'menu');
  menuEl.hidden = true;
  shadow.append(chipEl, menuEl);
  /** @type {?HTMLElement} */
  let chipBlock = null;
  const hideChip = () => {
    chipEl.hidden = true;
    chipBlock = null;
  };
  const closeRoleMenu = () => {
    if (menuEl.hidden) return;
    menuEl.hidden = true;
    chipEl.classList.remove('open');
    chipEl.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onRoleMenuDocPress, true);
    document.removeEventListener('keydown', onRoleMenuKey, true);
  };
  const onRoleMenuDocPress = (e) => {
    const path = e.composedPath();
    if (path.includes(menuEl) || path.includes(chipEl)) return;
    closeRoleMenu();
    hideChip();
  };
  // Esc closes the menu before the mode's own Esc, which exits the mode, can see the press.
  const onRoleMenuKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeRoleMenu();
    chipEl.focus();
  };
  /** @param {?EventTarget} target */
  const chipBlockOf = (target) => {
    if (surfaceOf() !== 'document' || !(target instanceof Element)) return null;
    const el = /** @type {?HTMLElement} */ (target.closest('[data-par]'));
    if (!el || el.closest('.scribe-notes') || !/^(H[1-6]|P|LI|BLOCKQUOTE)$/.test(el.tagName)) return null;
    return parInfo.has(el.dataset.par || '') ? el : null;
  };
  /** @param {HTMLElement} el */
  const showChip = (el) => {
    if (el === chipBlock) return;
    closeRoleMenu();
    chipBlock = el;
    const info = /** @type {{par: OcrPar, n: number}} */ (parInfo.get(el.dataset.par || ''));
    const label = ROLES.find(([, key]) => key === roleKey(info.par))?.[0] || info.par.type;
    chipEl.innerHTML = `${label} ${CARET_SVG}`;
    chipEl.setAttribute('aria-label', `Paragraph role: ${label}`);
    chipEl.hidden = false;
    const at = paneOffset(el);
    chipEl.style.top = `${at.y - 2}px`;
    chipEl.style.left = `${Math.max(0, at.x + el.offsetWidth - chipEl.offsetWidth - 6)}px`;
  };
  /** @param {string} key */
  const setRole = (key) => {
    const el = chipBlock;
    const info = el ? parInfo.get(el.dataset.par || '') : null;
    closeRoleMenu();
    hideChip();
    const { doc } = viewerOf();
    if (!info || !doc) return;
    const { par, n } = info;
    doc.editWords([n], 'Paragraph role', () => {
      if (key.startsWith('h')) {
        par.type = 'title';
        par.headingLevel = Number(key.slice(1));
      } else {
        par.type = /** @type {import('../../../js/objects/ocrObjects.js').ParType} */ (key);
        par.headingLevel = null;
      }
    });
    app._syncUndoState?.();
    renderAll();
  };
  const openRoleMenu = () => {
    const info = chipBlock ? parInfo.get(chipBlock.dataset.par || '') : null;
    if (!info) return;
    const current = roleKey(info.par);
    menuEl.replaceChildren(...ROLES.map(([label, key]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.textContent = label;
      b.classList.toggle('on', key === current);
      b.addEventListener('click', () => setRole(key));
      return b;
    }));
    menuEl.hidden = false;
    menuEl.style.top = `${chipEl.offsetTop + chipEl.offsetHeight + 4}px`;
    menuEl.style.left = `${Math.max(0, chipEl.offsetLeft + chipEl.offsetWidth - menuEl.offsetWidth)}px`;
    chipEl.classList.add('open');
    chipEl.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onRoleMenuDocPress, true);
    document.addEventListener('keydown', onRoleMenuKey, true);
    /** @type {HTMLElement} */ (menuEl.querySelector('button.on') || menuEl.firstElementChild)?.focus();
  };
  chipEl.addEventListener('click', () => (menuEl.hidden ? openRoleMenu() : closeRoleMenu()));
  paneBody.addEventListener('mouseover', (e) => {
    const el = chipBlockOf(e.target);
    if (el) showChip(el);
  });
  paneBody.addEventListener('focusin', (e) => {
    const el = chipBlockOf(e.target);
    if (el) showChip(el);
  });
  pane.addEventListener('mouseleave', () => { if (menuEl.hidden && !pane.contains(document.activeElement)) hideChip(); });

  /** @type {Map<number, {el: ?HTMLElement, top: number, width: number, height: number}>} The placed pages, by page index, in page pixels. */
  let placed = new Map();
  /** @type {Array<number>} */
  let placedOrder = [];
  let paneScale = 1;
  let renderRun = 0;
  /** @type {?import('../../../js/containers/scribeDoc.js').ScribeDoc} */
  let docRendered = null;
  let shownCurrent = -1;

  /**
   * The pages the settings include, in order, or null for every page.
   * @param {import('../../../js/containers/scribeDoc.js').ScribeDoc} doc
   * @returns {?Array<number>}
   */
  const includedPages = (doc) => {
    const count = doc.pageMetrics.length;
    if (settings.pages === 'current') return [Math.min(viewerOf().state.cp.n, count - 1)];
    if (settings.pages === 'range') {
      const pages = new Set();
      for (const part of settings.range.split(',')) {
        const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
        if (!m) continue;
        const a = Math.max(1, parseInt(m[1], 10));
        const b = Math.min(count, m[2] ? parseInt(m[2], 10) : a);
        for (let i = a; i <= b; i++) pages.add(i - 1);
      }
      if (pages.size > 0) return [...pages].sort((x, y) => x - y);
    }
    return null;
  };

  /**
   * @param {import('../../../js/containers/scribeDoc.js').ScribeDoc} doc
   * @param {number} n
   */
  const pageImage = async (doc, n) => {
    const props = { rotated: scribeDocDefaults.autoRotate, upscaled: false, colorMode: scribeDocDefaults.colorMode };
    if (props.colorMode === 'binary') return doc.images.getBinary(n, props);
    if (doc.inputData.pdfMode) return doc.images.getNative(n, props);
    return doc.images.nativeSrc[n];
  };
  const pagesWithImages = () => (format().id === 'pdf' ? settings.textLayer !== 'visible' : format().id === 'html' && settings.images);
  const pagesDisplayMode = () => {
    if (format().id === 'pdf') return settings.textLayer === 'hidden' ? 'invis' : settings.textLayer === 'proof' ? 'proof' : 'ebook';
    return pagesWithImages() ? 'invis' : 'ebook';
  };

  const layoutPane = () => {
    // Beside the page the banner lies over the pane's top, so a document or summary starts below it.
    // Pages keep the lane's geometry, their tops under the banner like the page beside them.
    paneBody.style.paddingTop = pane.classList.contains('scribe-export-pane-lane') || surfaceOf() === 'pages' ? '' : `${band()}px`;
    if (surfaceOf() !== 'pages') {
      paneBody.style.zoom = '';
      paneBody.style.width = '';
      paneBody.style.height = '';
      paneScale = 1;
      return;
    }
    let widest = 0;
    let total = 0;
    for (const p of placed.values()) {
      widest = Math.max(widest, p.width);
      total = Math.max(total, p.top + p.height);
    }
    paneBody.style.width = `${widest}px`;
    paneBody.style.height = `${total}px`;
    const avail = pane.clientWidth - 2 * PANE_GUTTER;
    paneScale = widest > 0 && avail > 0 ? Math.min(1, avail / widest) : 1;
    paneBody.style.zoom = String(paneScale);
    rebuildLinkKeys();
  };

  /**
   * @param {import('../../../js/containers/scribeDoc.js').ScribeDoc} doc
   * @param {Array<number>} pages
   * @param {number} gen
   */
  const renderPages = async (doc, pages, gen) => {
    const withImages = pagesWithImages();
    const displayMode = pagesDisplayMode();
    for (const n of pages) {
      const slot = placed.get(n);
      if (!slot) continue;
      /** @type {Array<import('../../../js/objects/imageObjects.js').ImageWrapper>|undefined} */
      let images;
      if (withImages) {
        images = [];
        images[n] = await pageImage(doc, n);
      }
      if (gen !== renderRun) return;
      const frag = writeHtmlFragment({
        ocrPages: doc.ocr.active, images, pageArr: [n], docFonts: doc.fonts, pageMetrics: doc.pageMetrics, displayMode, parIds: true,
      });
      if (!paneStyle.textContent) paneStyle.textContent = frag.style + PANE_RULES + (format().surface === 'pages' ? BOXES_RULES : '');
      const tpl = document.createElement('template');
      tpl.innerHTML = frag.body;
      const el = /** @type {?HTMLElement} */ (tpl.content.firstElementChild);
      if (!el) continue;
      el.style.top = `${slot.top}px`;
      el.style.width = `${slot.width}px`;
      el.style.height = `${slot.height}px`;
      if (slot.el) slot.el.replaceWith(el);
      else paneBody.appendChild(el);
      slot.el = el;
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      if (gen !== renderRun) return;
    }
  };

  /** @param {import('../../../js/containers/scribeDoc.js').ScribeDoc} doc */
  const linesBody = (doc) => {
    lineInfo = new Map();
    let body = '<article class="scribe-article">\n';
    for (const n of includedPages(doc) || doc.pageMetrics.map((pm, i) => i)) {
      const page = doc.ocr.active[n];
      if (!page) continue;
      for (let h = 0; h < page.lines.length; h++) {
        const line = page.lines[h];
        lineInfo.set(line.id, { line, n });
        const prefix = settings.lineNumbers && format().id === 'txt' ? `${n}:${h}  ` : '';
        body += `<p data-line="${esc(line.id)}" data-page="${n}">${esc(prefix + line.words.map((w) => w.text).join(' '))}</p>\n`;
      }
    }
    return `${body}</article>\n`;
  };

  /** @param {import('../../../js/containers/scribeDoc.js').ScribeDoc} doc */
  const summaryBody = (doc) => {
    const pages = doc.ocr.active || [];
    const words = pages.reduce((sum, page) => sum + (page ? page.lines.reduce((s, line) => s + line.words.length, 0) : 0), 0);
    const tables = (doc.layoutDataTables?.pages || []).reduce((sum, p) => sum + (p?.tables?.length || 0), 0);
    const annots = (doc.annotations?.pages || []).reduce((sum, a) => sum + (a?.length || 0), 0);
    const edits = doc.docHistory?.undoStack?.length || 0;
    const name = `${app._baseName().replace(/\.\w{1,6}$/, '')}.scribe`;
    return `<div class="scribe-export-summary"><h4>${esc(name)}</h4><dl>`
      + `<dt>Pages</dt><dd>${doc.pageMetrics.length}</dd>`
      + `<dt>Text</dt><dd>${words.toLocaleString()} words</dd>`
      + `<dt>Tables</dt><dd>${tables}</dd>`
      + `<dt>Annotations</dt><dd>${annots}</dd>`
      + `<dt>Edits</dt><dd>${edits} on the undo timeline</dd>`
      + `<dt>App state</dt><dd>${settings.session ? 'Included, so an hOCR export comes back as uploaded and the tools keep their settings' : 'Left out'}</dd>`
      + '</dl><p>A session file is a container, so it has no page to show. Reopening it restores this view.</p></div>';
  };

  const renderAll = async () => {
    const sv = viewerOf();
    const { doc } = sv;
    if (!doc) return;
    const gen = ++renderRun;
    docRendered = doc;
    shownCurrent = sv.state.cp.n;
    placed = new Map();
    placedOrder = [];
    articleBlocks = [];
    parInfo = new Map();
    lineInfo = new Map();
    hideChip();
    closeRoleMenu();
    paneBody.replaceChildren();
    paneStyle.textContent = '';
    const surface = surfaceOf();
    if (surface === 'summary') {
      layoutPane();
      paneStyle.textContent = SUMMARY_RULES;
      paneBody.innerHTML = summaryBody(doc);
      return;
    }
    if (surface === 'document' || surface === 'lines') {
      layoutPane();
      const f = format();
      const word = f.style === 'word';
      let body;
      if (surface === 'document') {
        const frag = writeHtmlFragment({
          ocrPages: doc.ocr.active,
          layoutPageArr: doc.layoutDataTables.pages,
          pageArr: includedPages(doc),
          docFonts: doc.fonts,
          pageMetrics: doc.pageMetrics,
          reflowText: true,
          dropPageHeadersFooters: settings.dropHeadersFooters,
          displayMode: 'ebook',
          runFonts: word,
          parIds: true,
        });
        body = frag.body;
        paneStyle.textContent = docRules(f) + PAPER_RULES + CHIP_RULES;
        for (const page of doc.ocr.active) {
          if (page) for (const par of page.pars) parInfo.set(par.id, { par, n: page.n });
        }
      } else {
        body = linesBody(doc);
        paneStyle.textContent = docRules(f) + PAPER_RULES;
      }
      if (gen !== renderRun) return;
      paneBody.innerHTML = body;
      if (word) for (const span of paneBody.querySelectorAll('[data-font]')) /** @type {HTMLElement} */ (span).style.fontFamily = `"${span.getAttribute('data-font')}", ${wordStyles().family}`;
      articleBlocks = /** @type {Array<HTMLElement>} */ ([...paneBody.querySelectorAll('[data-par], [data-line]')]);
      // A block takes focus so the keyboard reaches its role chip.
      for (const el of articleBlocks) if (chipBlockOf(el)) el.tabIndex = 0;
      cacheBlocks();
      laneToPane();
      return;
    }
    let top = 0;
    const pages = includedPages(doc) || doc.pageMetrics.map((pm, i) => i);
    for (const n of pages) {
      // The exact HTML layout leaves a page without text out, and the other files write every page.
      const page = doc.ocr.active?.[n];
      if (format().id === 'html' && (!page || page.lines.length === 0)) continue;
      const { dims, rotation } = doc.pageMetrics[n];
      const width = (rotation || 0) % 180 === 90 ? dims.height : dims.width;
      const height = (rotation || 0) % 180 === 90 ? dims.width : dims.height;
      placed.set(n, {
        el: null, top, width, height,
      });
      placedOrder.push(n);
      top += height + PAGE_GAP;
    }
    layoutPane();
    // Linked before the pages render, so the clamp the new height causes carries the link's own position and is not read as the reader's scroll.
    laneToPane();
    const cur = sv.state.cp.n;
    const order = [...placedOrder].sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur) || a - b);
    await renderPages(doc, order, gen);
    if (gen === renderRun) laneToPane();
  };

  /**
   * Re-render the pages an edit touched, or everything when the edit's reach is unknown.
   * @param {?Array<number>} pages
   */
  const rerender = (pages) => {
    if (mounted?.kind === 'pdf') { refreshPdfPreview(); return; }
    const { doc } = viewerOf();
    if (!doc || !pane.isConnected) return;
    if (!pages || doc !== docRendered || surfaceOf() !== 'pages') { renderAll(); return; }
    renderPages(doc, pages.filter((n) => placed.has(n)), renderRun);
  };

  const ensureRendered = () => {
    const { doc } = viewerOf();
    if (doc && doc !== docRendered) return renderAll();
    return Promise.resolve();
  };

  // ---- The scroll link. ----
  const linkState = { on: true, expectLane: NaN, expectPane: NaN };
  /**
   * The mode banner's height.
   * The banner lies over the top of both sides.
   */
  const band = () => (app._modeBanner && app._modeBanner.style.display !== 'none' ? app._modeBanner.offsetHeight : 0);
  /** @param {number} target */
  const scrollPaneTo = (target) => {
    if (Math.abs(pane.scrollTop - target) < 1) return;
    pane.scrollTop = target;
    linkState.expectPane = pane.scrollTop;
  };
  /** @param {number} target */
  const scrollLaneTo = (target) => {
    const sc = viewerOf().scrollContainer;
    if (Math.abs(sc.scrollTop - target) < 1) return;
    sc.scrollTop = target;
    linkState.expectLane = sc.scrollTop;
  };
  const blockSurface = () => { const s = surfaceOf(); return s === 'document' || s === 'lines'; };
  /**
   * The scroll link's keypoints in the viewer's content space.
   * `linkPane` holds the pane position each one lands on, and both arrays stay non-decreasing.
   * @type {Array<number>}
   */
  let linkLane = [0];
  /** @type {Array<number>} */
  let linkPane = [0];
  const rebuildLinkKeys = () => {
    linkLane = [0];
    linkPane = [0];
    const sv = viewerOf();
    if (!sv.doc) return;
    /** @param {number} l @param {number} p */
    const push = (l, p) => {
      linkLane.push(Math.max(l, linkLane[linkLane.length - 1]));
      linkPane.push(Math.max(p, linkPane[linkPane.length - 1]));
    };
    if (blockSurface()) {
      for (let k = 0; k < blockSpans.length; k++) {
        push(blockSpans[k].top, blockTops[k]);
        push(blockSpans[k].bottom, blockTops[k] + blockHeights[k]);
      }
    } else {
      for (const n of placedOrder) {
        const slot = /** @type {{top: number, height: number}} */ (placed.get(n));
        push(sv.getPageStop(n), slot.top * paneScale);
        push(sv.getPageStop(n, false), (slot.top + slot.height) * paneScale);
      }
    }
    push(sv.getPageStop(sv.doc.pageMetrics.length - 1, false), pane.scrollHeight);
  };
  /**
   * @param {Array<number>} xs
   * @param {Array<number>} ys
   * @param {number} x
   */
  const linkMap = (xs, ys, x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
    let lo = 0;
    let hi = xs.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    const w = xs[hi] - xs[lo];
    return w > 0 ? ys[lo] + ((x - xs[lo]) / w) * (ys[hi] - ys[lo]) : ys[lo];
  };
  const laneToPane = () => {
    const sv = viewerOf();
    if (!sv.doc || !pane.isConnected || linkLane.length < 2) return;
    scrollPaneTo(linkMap(linkLane, linkPane, sv.scrollContainer.scrollTop / (sv.zoomLevel || 1)));
  };
  const paneToLane = () => {
    const sv = viewerOf();
    if (!sv.doc || linkLane.length < 2) return;
    scrollLaneTo(linkMap(linkPane, linkLane, pane.scrollTop) * (sv.zoomLevel || 1));
  };
  const onLaneScroll = () => {
    const sv = viewerOf();
    if (settings.pages === 'current' && pane.isConnected && sv.state.cp.n !== shownCurrent) renderAll();
    const echo = Math.abs(sv.scrollContainer.scrollTop - linkState.expectLane) <= 1;
    linkState.expectLane = NaN;
    if (echo || !linkState.on || view !== 'beside' || !pane.isConnected) return;
    laneToPane();
  };
  pane.addEventListener('scroll', () => {
    const echo = Math.abs(pane.scrollTop - linkState.expectPane) <= 1;
    linkState.expectPane = NaN;
    // In Preview the viewer under the pane follows even with the link off, so the page is in place when the pane leaves.
    if (echo || (!linkState.on && view === 'beside') || surfaceOf() === 'summary') return;
    paneToLane();
  }, { passive: true });
  if (typeof ResizeObserver !== 'undefined') {
    let paneWidth = 0;
    // The scale is set on the next frame, since a layout change inside the observer's own callback is reported as an observer loop.
    new ResizeObserver(() => {
      if (!pane.isConnected || pane.clientWidth === paneWidth) return;
      paneWidth = pane.clientWidth;
      requestAnimationFrame(() => {
        if (!pane.isConnected) return;
        layoutPane();
        cacheBlocks();
        laneToPane();
      });
    }).observe(pane);
  }
  const chip = document.createElement('span');
  chip.className = 'scribe-compare-chip on';
  chip.role = 'button';
  chip.tabIndex = 0;
  chip.title = 'Scroll the page and the preview together';
  chip.ariaLabel = chip.title;
  chip.innerHTML = LINK_SVG;
  // The sash's own press starts a resize, which the chip's press must not.
  chip.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); });
  chip.addEventListener('dblclick', (e) => e.stopPropagation());
  chip.addEventListener('click', () => {
    linkState.on = !linkState.on;
    chip.classList.toggle('on', linkState.on);
    chip.title = linkState.on ? 'Scroll the page and the preview together' : 'Scroll each side on its own';
    chip.ariaLabel = chip.title;
    if (linkState.on) laneToPane();
  });

  const placeOverLane = () => {
    const box = app._laneBox;
    if (!box) return;
    pane.style.left = `${box.left}px`;
    pane.style.width = `${box.width}px`;
  };
  /** @type {?ResizeObserver} */
  let laneObserver = null;
  /**
   * @param {HTMLElement} host
   * @param {boolean} overLane
   */
  const mountPane = (host, overLane) => {
    pane.classList.toggle('scribe-export-pane-lane', overLane);
    laneObserver?.disconnect();
    laneObserver = null;
    if (overLane) {
      placeOverLane();
      // The document's area moves with the sidebar and the right group, which resize the lane's scroll container.
      if (typeof ResizeObserver !== 'undefined') {
        laneObserver = new ResizeObserver(() => requestAnimationFrame(placeOverLane));
        laneObserver.observe(viewerOf().scrollContainer);
      }
    } else {
      pane.style.left = '';
      pane.style.width = '';
    }
    host.appendChild(pane);
    layoutPane();
    // Linked to stale content, the pane would scroll against the old surface, and the clamp when the new one arrives would read as the reader scrolling it.
    if (docRendered === viewerOf().doc) laneToPane();
    pane.focus({ preventScroll: true });
  };
  const unmountPane = () => {
    laneObserver?.disconnect();
    laneObserver = null;
    pane.remove();
  };

  // ---- The sheet surface. ----
  /** @type {?string} */
  let priorDisplayMode = null;
  /** @param {boolean} on */
  const setLanePreview = (on) => {
    const sv = viewerOf();
    if (!sv.doc || sv.state.tablePreview === on) return;
    sv.state.tablePreview = on;
    if (on) {
      priorDisplayMode = sv.state.displayMode;
      sv.state.displayMode = 'ebook';
      sv.CanvasSelection.deselectAll();
    } else {
      sv.state.displayMode = priorDisplayMode || 'invis';
      priorDisplayMode = null;
      for (const pc of sv.pageContainerArr) pc?.querySelectorAll('[data-scribe-tp]').forEach((el) => el.remove());
      for (const g of sv._overlayGroups || []) g?.querySelectorAll('[data-scribe-tp]').forEach((el) => el.remove());
    }
    // A display-mode change invalidates every rendered text layer.
    sv.destroyText(false);
    if (on) {
      const sheet = resolveActiveSheet(sv);
      if (sheet && sheet.n !== sv.state.cp.n) {
        const cur = sv.doc.layoutDataTables.pages[sv.state.cp.n];
        if (cur && cur.tables.length > 0) sv.state.activeTableId = cur.tables[0].id;
      }
    }
    sv.displayPage(sv.state.cp.n, false, true);
  };
  const openBesideSheet = () => {
    const token = ++sideSeq;
    app._openSideView({
      label: 'Excel preview',
      icon: EXPORT_MODE_SVG,
      configure: async (v) => {
        v.state.layoutMode = true;
        v.state.tablePreview = true;
        v.state.displayMode = 'ebook';
        v.CanvasSelection.deselectAll();
        v.destroyText(false);
        await v.displayPage(v.state.cp.n, false, true);
      },
      release: (v) => {
        v.state.tablePreview = false;
        v.state.layoutMode = false;
        v.state.displayMode = 'invis';
        v._tpSel = null;
        for (const pc of v.pageContainerArr) pc?.querySelectorAll('[data-scribe-tp]').forEach((el) => el.remove());
        for (const g of v._overlayGroups || []) g?.querySelectorAll('[data-scribe-tp]').forEach((el) => el.remove());
        v.destroyText(false);
      },
      onClose: () => onSideViewClosed(token),
      retarget: () => true,
    });
  };

  // ---- The PDF surface. ----
  /** @type {?import('../../../js/containers/scribeDoc.js').ScribeDoc} */
  let pdfPreviewDoc = null;
  let pdfRun = 0;
  /** @type {?ReturnType<typeof setTimeout>} */
  let pdfTimer = null;
  /**
   * @param {import('../../../js/containers/scribeDoc.js').ScribeDoc} doc
   * @returns {import('../../../js/export/export.js').ExportOptions}
   */
  const pdfOptions = (doc) => {
    /** @type {import('../../../js/export/export.js').ExportOptions} */
    const opts = { displayMode: settings.textLayer === 'hidden' ? 'invis' : settings.textLayer === 'proof' ? 'proof' : 'ebook', addOverlay: true };
    const pages = includedPages(doc);
    if (pages) opts.pageArr = pages;
    return opts;
  };
  /** @param {import('../../../js/containers/scribeDoc.js').ScribeDoc} doc */
  const buildPdfPreviewDoc = async (doc) => {
    const bytes = /** @type {ArrayBuffer} */ (await doc.exportData('pdf', pdfOptions(doc)));
    const file = new File([bytes], 'preview.pdf', { type: 'application/pdf' });
    return scribeLib.openDocument([file], { deferText: true });
  };
  const setBusy = (busy) => {
    exportBtn.disabled = busy;
    pickBtn.classList.toggle('busy', busy);
  };
  const openBesidePdf = async () => {
    const sv = viewerOf();
    if (!sv.doc) return;
    const run = ++pdfRun;
    setBusy(true);
    let previewDoc;
    try {
      previewDoc = await buildPdfPreviewDoc(sv.doc);
    } catch (err) {
      console.error('PDF preview failed:', err);
      app._showToast('Couldn’t build the PDF preview. Please try again.');
      setBusy(false);
      if (run === pdfRun && mounted?.kind === 'pdf') app._closeSideView();
      return;
    }
    setBusy(false);
    if (run !== pdfRun || !active || view !== 'beside' || mounted?.kind !== 'pdf') { previewDoc.clear(); return; }
    pdfPreviewDoc = previewDoc;
    const token = ++sideSeq;
    app._openSideView({
      label: 'PDF preview',
      icon: EXPORT_MODE_SVG,
      doc: previewDoc,
      configure: (v) => { v.state.displayMode = 'invis'; },
      release: () => {},
      onClose: () => {
        onSideViewClosed(token);
        if (pdfPreviewDoc === previewDoc) pdfPreviewDoc = null;
        previewDoc.clear();
      },
      // The preview is of one document; the lane's next document gets its own.
      retarget: () => false,
    });
  };
  const refreshPdfPreview = () => {
    if (pdfTimer) clearTimeout(pdfTimer);
    pdfTimer = setTimeout(async () => {
      pdfTimer = null;
      const sv = viewerOf();
      if (!sv.doc || !active || mounted?.kind !== 'pdf') return;
      const run = ++pdfRun;
      setBusy(true);
      let next;
      try {
        next = await buildPdfPreviewDoc(sv.doc);
      } catch (err) {
        console.error('PDF preview failed:', err);
        setBusy(false);
        return;
      }
      setBusy(false);
      if (run !== pdfRun || !active || mounted?.kind !== 'pdf') { next.clear(); return; }
      const prev = pdfPreviewDoc;
      pdfPreviewDoc = next;
      await app._retargetSideView(next);
      prev?.clear();
    }, 400);
  };

  // ---- The banner. ----
  const viewSeg = document.createElement('span');
  viewSeg.className = 'scribe-mode-banner-viewseg';
  Object.assign(viewSeg.style, {
    display: 'inline-flex', border: '1px solid var(--scribe-line-strong)', borderRadius: '6px', overflow: 'hidden', margin: '0 2px 0 10px', flex: 'none',
  });
  const segBtn = (label, key) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.exportView = key;
    b.textContent = label;
    Object.assign(b.style, {
      border: 'none',
      background: 'var(--scribe-surface)',
      color: 'var(--scribe-ink-2)',
      fontFamily: 'inherit',
      fontSize: '11px',
      fontWeight: '600',
      lineHeight: '1',
      padding: '4.5px 10px',
      cursor: 'pointer',
    });
    viewSeg.appendChild(b);
    return b;
  };
  const pageBtn = segBtn('Page', 'page');
  const previewBtn = segBtn('Preview', 'preview');
  previewBtn.style.borderLeft = '1px solid var(--scribe-line-strong)';
  const besideBtn = segBtn('Side by side', 'beside');
  besideBtn.style.borderLeft = '1px solid var(--scribe-line-strong)';
  const syncSeg = () => {
    const canBeside = !!modeViewer && modeViewer === app.scribe;
    besideBtn.disabled = !canBeside;
    besideBtn.title = canBeside ? '' : 'Side by side works from the left half';
    [pageBtn, previewBtn, besideBtn].forEach((b) => {
      const on = b.dataset.exportView === view;
      b.style.background = on ? 'var(--scribe-accent)' : 'var(--scribe-surface)';
      b.style.color = on ? 'var(--scribe-accent-ink)' : (b.disabled ? 'var(--scribe-ink-3)' : 'var(--scribe-ink-2)');
      b.style.cursor = on || b.disabled ? 'default' : 'pointer';
    });
  };

  const tools = document.createElement('span');
  tools.className = 'scribe-export-tools';
  const pickBtn = document.createElement('button');
  pickBtn.type = 'button';
  pickBtn.className = 'scribe-export-bpick';
  pickBtn.setAttribute('aria-haspopup', 'true');
  pickBtn.setAttribute('aria-label', 'Export format');
  const pickMenu = document.createElement('div');
  pickMenu.className = 'scribe-export-menu';
  pickMenu.setAttribute('role', 'menu');
  pickMenu.hidden = true;
  const optionsBtn = document.createElement('button');
  optionsBtn.type = 'button';
  optionsBtn.className = 'scribe-export-bpick';
  optionsBtn.innerHTML = `Options ${CARET_SVG}`;
  optionsBtn.setAttribute('aria-haspopup', 'true');
  const options = document.createElement('div');
  options.className = 'scribe-export-options';
  options.hidden = true;
  const exportBtn = document.createElement('button');
  exportBtn.type = 'button';
  exportBtn.className = 'scribe-export-brun';
  tools.append(pickBtn, pickMenu, optionsBtn, options, exportBtn);

  /**
   * @param {ExportFormat} f
   * @param {?import('../../../js/containers/scribeDoc.js').ScribeDoc} doc
   */
  const formatAllowed = (f, doc) => !!doc && (!f.needsWords || docHasWords(doc));
  const syncPick = () => {
    const f = format();
    pickBtn.innerHTML = `${esc(f.label)} (${esc(f.ext)}) ${CARET_SVG}`;
    exportBtn.textContent = `Export ${f.label}`;
  };
  const onPickDocPress = (e) => {
    const t = /** @type {?Node} */ (e.target);
    if (t && (pickMenu.contains(t) || pickBtn.contains(t))) return;
    closePick();
  };
  const onPickKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closePick();
    pickBtn.focus();
  };
  const closePick = () => {
    if (pickMenu.hidden) return;
    pickMenu.hidden = true;
    pickBtn.classList.remove('active');
    pickBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onPickDocPress, true);
    document.removeEventListener('keydown', onPickKey, true);
  };
  const openPick = () => {
    if (!pickMenu.hidden) return;
    closeOptions();
    const { doc } = viewerOf();
    pickMenu.replaceChildren(...EXPORT_FORMATS.map((f) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitemradio');
      b.dataset.exportFormat = f.id;
      b.textContent = `${f.label} (${f.ext})`;
      const on = f.id === settings.format;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.disabled = !formatAllowed(f, doc);
      if (b.disabled) b.title = 'The document has no text to export';
      b.addEventListener('click', () => { closePick(); setFormat(f.id); });
      return b;
    }));
    pickMenu.hidden = false;
    pickBtn.classList.add('active');
    pickBtn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onPickDocPress, true);
    document.addEventListener('keydown', onPickKey, true);
    /** @type {HTMLElement} */ (pickMenu.querySelector('button.on') || pickMenu.firstElementChild)?.focus();
  };
  pickBtn.addEventListener('click', () => (pickMenu.hidden ? openPick() : closePick()));

  /**
   * @param {string} label
   * @param {HTMLInputElement} input
   */
  const field = (label, input) => {
    const l = document.createElement('label');
    l.append(input, label);
    return l;
  };
  /**
   * @param {'radio'|'checkbox'} type
   * @param {string} name
   */
  const input = (type, name) => {
    const i = document.createElement('input');
    i.type = type;
    i.name = name;
    return i;
  };
  /**
   * @param {string} key
   * @param {string} label
   * @param {Array<HTMLElement>} fields
   */
  const row = (key, label, ...fields) => {
    const lab = document.createElement('div');
    lab.className = 'scribe-export-opt-label';
    lab.textContent = label;
    lab.dataset.option = key;
    const r = document.createElement('div');
    r.className = 'scribe-export-opt-row';
    r.dataset.option = key;
    r.append(...fields);
    options.append(lab, r);
    return [lab, r];
  };
  const pagesAll = input('radio', 'scribe-export-pages');
  const pagesCurrent = input('radio', 'scribe-export-pages');
  const pagesRange = input('radio', 'scribe-export-pages');
  const rangeInput = document.createElement('input');
  rangeInput.type = 'text';
  rangeInput.className = 'scribe-export-range';
  rangeInput.placeholder = 'e.g. 1-3, 7';
  rangeInput.setAttribute('aria-label', 'Page range');
  row('pages', 'Pages', field('All pages', pagesAll), field('Current page', pagesCurrent), field('Range', pagesRange), rangeInput);
  const reflowBox = input('checkbox', 'scribe-export-reflow');
  const headersFootersBox = input('checkbox', 'scribe-export-drop-headers-footers');
  const lineNumbersBox = input('checkbox', 'scribe-export-linenumbers');
  const reflowField = field('Join lines into paragraphs', reflowBox);
  const headersFootersField = field('Drop page headers, footers and page numbers', headersFootersBox);
  const lineNumbersField = field('Line numbers', lineNumbersBox);
  row('text', 'Text', reflowField, headersFootersField, lineNumbersField);
  const imagesBox = input('checkbox', 'scribe-export-images');
  const layerHidden = input('radio', 'scribe-export-layer');
  const layerVisible = input('radio', 'scribe-export-layer');
  const layerProof = input('radio', 'scribe-export-layer');
  const fitBox = input('checkbox', 'scribe-export-fit');
  const imagesField = field('Page image behind the text', imagesBox);
  const layerFields = [field('Text hidden over the page image', layerHidden), field('Text only', layerVisible), field('Text in proof colors over the image', layerProof)];
  const fitField = field('Fit pages to the window', fitBox);
  row('page', 'Page', imagesField, ...layerFields, fitField);
  const fontsCdn = input('radio', 'scribe-export-fonts');
  const fontsEmbed = input('radio', 'scribe-export-fonts');
  row('fonts', 'Fonts', field('Linked from the CDN', fontsCdn), field('Embedded in the file', fontsEmbed));
  const sheetsPerTable = input('radio', 'scribe-export-sheets');
  const sheetsFlat = input('radio', 'scribe-export-sheets');
  const formattingBox = input('checkbox', 'scribe-export-formatting');
  row('workbook', 'Workbook', field('One sheet per table', sheetsPerTable), field('Single flat sheet', sheetsFlat), field('Preserve source formatting', formattingBox));
  const sessionBox = input('checkbox', 'scribe-export-session');
  row('session', 'Session', field('Include the app’s state and the hOCR source', sessionBox));
  const syncOptions = () => {
    const f = format();
    const has = (k) => f.options.includes(k);
    const reflow = reflowOn();
    const show = (el, on) => { el.style.display = on ? '' : 'none'; };
    // A row shows only while one of its fields does.
    const rowOn = {
      pages: has('pages'),
      text: (has('reflow') && !settings.lineNumbers) || (has('dropHeadersFooters') && reflow) || has('lineNumbers'),
      page: (has('images') && !reflow) || has('textLayer') || (has('fit') && !reflow),
      fonts: has('fonts') && !reflow,
      workbook: has('sheets'),
      session: has('session'),
    };
    for (const el of options.querySelectorAll('[data-option]')) {
      show(/** @type {HTMLElement} */ (el), !!rowOn[/** @type {HTMLElement} */ (el).dataset.option || '']);
    }
    pagesAll.checked = settings.pages === 'all';
    pagesCurrent.checked = settings.pages === 'current';
    pagesRange.checked = settings.pages === 'range';
    rangeInput.style.display = settings.pages === 'range' ? '' : 'none';
    rangeInput.value = settings.range;
    show(reflowField, has('reflow') && !settings.lineNumbers);
    reflowBox.checked = reflow;
    // Headers and footers are left out only when the lines reflow into paragraphs.
    show(headersFootersField, has('dropHeadersFooters') && reflow);
    headersFootersBox.checked = settings.dropHeadersFooters;
    show(lineNumbersField, has('lineNumbers'));
    lineNumbersBox.checked = settings.lineNumbers;
    show(imagesField, has('images') && !reflow);
    imagesBox.checked = settings.images;
    for (const el of layerFields) show(el, has('textLayer'));
    layerHidden.checked = settings.textLayer === 'hidden';
    layerVisible.checked = settings.textLayer === 'visible';
    layerProof.checked = settings.textLayer === 'proof';
    show(fitField, has('fit') && !reflow);
    fitBox.checked = settings.fit;
    fontsCdn.checked = settings.fonts === 'cdn';
    fontsEmbed.checked = settings.fonts === 'embed';
    sheetsPerTable.checked = settings.sheets === 'perTable';
    sheetsFlat.checked = settings.sheets === 'flat';
    formattingBox.checked = settings.formatting;
    sessionBox.checked = settings.session;
    syncPick();
  };
  syncOptions();
  const onOptionsDocClick = (e) => {
    const t = /** @type {?Node} */ (e.target);
    if (t && (options.contains(t) || optionsBtn.contains(t))) return;
    closeOptions();
  };
  const onOptionsKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeOptions();
    optionsBtn.focus();
  };
  const closeOptions = () => {
    if (options.hidden) return;
    options.hidden = true;
    optionsBtn.classList.remove('active');
    optionsBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOptionsDocClick, true);
    document.removeEventListener('keydown', onOptionsKey, true);
  };
  const openOptions = () => {
    if (!options.hidden) return;
    closePick();
    syncOptions();
    options.hidden = false;
    optionsBtn.classList.add('active');
    optionsBtn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOptionsDocClick, true);
    document.addEventListener('keydown', onOptionsKey, true);
  };
  optionsBtn.addEventListener('click', () => (options.hidden ? openOptions() : closeOptions()));
  const refresh = () => {
    syncOptions();
    if (!active || view === 'page') return;
    if (mounted?.kind === 'pdf') { refreshPdfPreview(); return; }
    if (mounted?.kind === 'sheet') return;
    const kind = surfaceOf();
    if (mounted && mounted.kind !== kind) { remount(); return; }
    if (pane.isConnected) renderAll();
  };
  /** @param {'all'|'current'|'range'} pages */
  const setPages = (pages) => {
    settings.pages = pages;
    if (pages === 'range') { syncOptions(); rangeInput.focus(); return; }
    refresh();
  };
  pagesAll.addEventListener('change', () => setPages('all'));
  pagesCurrent.addEventListener('change', () => setPages('current'));
  pagesRange.addEventListener('change', () => setPages('range'));
  rangeInput.addEventListener('change', () => { settings.range = rangeInput.value.trim(); refresh(); });
  rangeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); rangeInput.blur(); } });
  reflowBox.addEventListener('change', () => { settings.reflow[settings.format] = reflowBox.checked; refresh(); });
  headersFootersBox.addEventListener('change', () => { settings.dropHeadersFooters = headersFootersBox.checked; refresh(); });
  lineNumbersBox.addEventListener('change', () => {
    settings.lineNumbers = lineNumbersBox.checked;
    if (settings.lineNumbers) settings.reflow.txt = false;
    refresh();
  });
  imagesBox.addEventListener('change', () => { settings.images = imagesBox.checked; refresh(); });
  layerHidden.addEventListener('change', () => { settings.textLayer = 'hidden'; refresh(); });
  layerVisible.addEventListener('change', () => { settings.textLayer = 'visible'; refresh(); });
  layerProof.addEventListener('change', () => { settings.textLayer = 'proof'; refresh(); });
  fitBox.addEventListener('change', () => { settings.fit = fitBox.checked; });
  fontsCdn.addEventListener('change', () => { settings.fonts = 'cdn'; });
  fontsEmbed.addEventListener('change', () => { settings.fonts = 'embed'; });
  sheetsPerTable.addEventListener('change', () => { settings.sheets = 'perTable'; });
  sheetsFlat.addEventListener('change', () => { settings.sheets = 'flat'; });
  formattingBox.addEventListener('change', () => { settings.formatting = formattingBox.checked; });
  sessionBox.addEventListener('change', () => { settings.session = sessionBox.checked; refresh(); });

  /**
   * @param {import('../../../js/containers/scribeDoc.js').ScribeDoc} doc
   * @returns {import('../../../js/export/export.js').ExportOptions}
   */
  const exportOptions = (doc) => {
    const f = format();
    if (f.id === 'pdf') return pdfOptions(doc);
    /** @type {import('../../../js/export/export.js').ExportOptions} */
    const opts = {};
    const pages = includedPages(doc);
    if (pages) opts.pageArr = pages;
    if (f.id === 'scribe') { opts.scribeSession = settings.session; return opts; }
    if (f.options.includes('reflow')) opts.reflow = reflowOn();
    if (f.options.includes('dropHeadersFooters')) opts.dropPageHeadersFooters = settings.dropHeadersFooters;
    if (f.id === 'txt') opts.lineNumbers = settings.lineNumbers;
    if (f.id === 'html') {
      const exact = !reflowOn();
      opts.displayMode = exact && settings.images ? 'invis' : 'ebook';
      opts.includeImages = exact && settings.images;
      opts.embedFonts = settings.fonts === 'embed';
      opts.htmlFitWindow = exact && settings.fit;
    }
    return opts;
  };
  exportBtn.addEventListener('click', async () => {
    const sv = viewerOf();
    if (!sv.doc || exportBtn.disabled) return;
    const f = format();
    exportBtn.disabled = true;
    try {
      if (sv.doc._textReadySettle) await sv.doc.textReady;
      if (f.id === 'xlsx') {
        const { buildTablesWorkbook } = await import('../automations/extractTables.js');
        const built = await buildTablesWorkbook(sv.doc, {
          pageIndices: includedPages(sv.doc), flat: settings.sheets === 'flat', formatting: settings.formatting,
        });
        if (!built) { app._showToast('No tables found on the selected pages.'); return; }
        await scribeLib.utils.saveAs(built.bytes, `${app._baseName().replace(/\.\w{1,6}$/, '')}-tables.xlsx`);
      } else {
        await sv.doc.download(f.id, app._baseName(), exportOptions(sv.doc));
      }
    } catch (err) {
      console.error(`Export to ${f.id} failed:`, err);
      app._showToast(`Couldn’t export ${f.label}. Please try again.`);
    } finally {
      exportBtn.disabled = false;
    }
  });

  // ---- The edits the preview mirrors. ----
  /** @type {?(() => void)} */
  let unhook = null;
  /** @param {import('../../viewer.js').ScribeViewer} sv */
  const hookEdits = (sv) => {
    const prevEdit = sv.onEditCallback;
    const prevWord = sv.onWordTextChange;
    const prevTables = sv.onLayoutTablesEdited;
    sv.onEditCallback = (pages) => {
      if (prevEdit) prevEdit(pages);
      rerender(Array.isArray(pages) ? pages : null);
    };
    sv.onWordTextChange = (obj) => {
      if (prevWord) prevWord(obj);
      rerender([obj.word.line.page.n]);
    };
    sv.onLayoutTablesEdited = (n) => {
      if (prevTables) prevTables(n);
      rerender([n]);
    };
    unhook = () => {
      sv.onEditCallback = prevEdit;
      sv.onWordTextChange = prevWord;
      sv.onLayoutTablesEdited = prevTables;
      unhook = null;
    };
  };

  // ---- The views and their surfaces. ----
  /** @type {?{view: 'preview'|'beside', kind: string}} */
  let mounted = null;
  // A side view closed by the tool itself reports its close after the next view has opened, so each open takes a token and a stale close is ignored.
  let sideSeq = 0;
  /** @param {number} token */
  const onSideViewClosed = (token) => {
    if (token !== sideSeq || view !== 'beside') return;
    view = 'page';
    mounted = null;
    syncSeg();
  };
  const openBesidePane = () => {
    const token = ++sideSeq;
    app._openSideView({
      label: `${format().label} preview`,
      icon: EXPORT_MODE_SVG,
      pane: true,
      goToPage: (n) => {
        if (blockSurface()) {
          const idx = articleBlocks.findIndex((el) => Number(el.dataset.page) >= n);
          if (idx >= 0) scrollPaneTo(Math.max(0, blockTops[idx] - band()));
          return;
        }
        const shown = placedOrder.find((p) => p >= n) ?? placedOrder[placedOrder.length - 1];
        const slot = shown === undefined ? null : placed.get(shown);
        if (slot) scrollPaneTo(Math.max(0, slot.top * paneScale - band()));
      },
      configure: async () => {
        const g = app._rightGroup;
        if (!g) return;
        mountPane(g.body, false);
        if (surfaceOf() !== 'summary') g.sash.append(chip);
        await ensureRendered();
        laneToPane();
      },
      release: () => {
        chip.remove();
        unmountPane();
      },
      onClose: () => onSideViewClosed(token),
      retarget: (doc) => formatAllowed(format(), doc),
    });
  };
  /** @param {boolean} [replacing] - The next mount opens a second view, which replaces this one in place. */
  const unmountSurface = (replacing = false) => {
    const was = mounted;
    mounted = null;
    if (!was) return;
    if (was.view === 'beside') {
      sideSeq += 1;
      if (!replacing) app._closeSideView();
      return;
    }
    if (was.kind === 'sheet') setLanePreview(false);
    else unmountPane();
  };
  const mountSurface = () => {
    if (view === 'page') return;
    const kind = surfaceOf();
    mounted = { view, kind };
    if (view === 'beside') {
      if (kind === 'sheet') openBesideSheet();
      else if (kind === 'pdf') openBesidePdf();
      else openBesidePane();
      return;
    }
    if (kind === 'sheet') { setLanePreview(true); return; }
    mountPane(app.viewerContainer, true);
    ensureRendered();
  };
  const remount = () => {
    unmountSurface(active && mounted?.view === 'beside');
    renderRun += 1;
    docRendered = null;
    if (active) mountSurface();
  };
  /** @param {'page'|'preview'|'beside'} next */
  const setView = (next) => {
    if (next === view || (next === 'beside' && (!active || besideBtn.disabled))) return;
    unmountSurface();
    view = next;
    // Closing the second view can close the right group, and the mode with it.
    if (!active) return;
    mountSurface();
    syncSeg();
  };
  pageBtn.addEventListener('click', () => setView('page'));
  previewBtn.addEventListener('click', () => setView('preview'));
  besideBtn.addEventListener('click', () => setView('beside'));
  syncSeg();
  /** @param {ExportFormat['id']} id */
  const setFormat = (id) => {
    if (settings.format === id) return;
    settings.format = id;
    syncOptions();
    if (active && view !== 'page') remount();
  };

  const setActive = (next) => {
    if (active === next) return;
    const sv = next ? app._activeViewer() : viewerOf();
    if (next && !sv.doc) return;
    active = next;
    toolbarElem.classList.toggle('active', active);
    if (!active && view !== 'page') setView('page');
    modeViewer = next ? sv : null;
    syncSeg();
    if (active) {
      if (!formatAllowed(format(), sv.doc)) settings.format = 'pdf';
      syncOptions();
      hookEdits(sv);
      sv.scrollContainer.addEventListener('scroll', onLaneScroll, { passive: true });
      setView(besideBtn.disabled ? 'preview' : 'beside');
    } else {
      if (unhook) unhook();
      sv.scrollContainer.removeEventListener('scroll', onLaneScroll);
      closeOptions();
      closePick();
      if (pdfTimer) { clearTimeout(pdfTimer); pdfTimer = null; }
      pdfRun += 1;
      renderRun += 1;
      docRendered = null;
      placed = new Map();
      placedOrder = [];
      articleBlocks = [];
      parInfo = new Map();
      lineInfo = new Map();
      paneBody.replaceChildren();
      paneStyle.textContent = '';
    }
  };
  toolbarElem.addEventListener('click', async () => {
    if (toolbarElem.classList.contains('disabled')) return;
    if (!active && !(await hydrateIfProvisional(app._activeViewer().doc))) return;
    setActive(!active);
  });

  /** Carry the mode over to a newly opened document. */
  const docChanged = () => {
    if (!active) return;
    settings.range = '';
    if (settings.pages === 'range') settings.pages = 'all';
    const sv = viewerOf();
    if (!sv.doc) { setActive(false); return; }
    // A document the document library holds as a placeholder has only the text its index kept, so the real one loads.
    // Its arrival runs this again.
    if (sv.doc.id < 0 && sv.doc._requestHydration) {
      hydrateIfProvisional(sv.doc).catch(() => {});
      return;
    }
    if (!formatAllowed(format(), sv.doc)) settings.format = 'pdf';
    syncOptions();
    // Text can arrive after the document shows, as deferred extraction's does, so the preview re-renders even for the same document.
    if (view !== 'page') remount();
  };

  /**
   * Open the mode, in `formatId` when it names a format.
   * Unlike the toolbar button, it never turns the mode off.
   * @param {string} [formatId]
   */
  const open = async (formatId) => {
    if (formatId && EXPORT_FORMATS.some((f) => f.id === formatId)) {
      if (active) setFormat(/** @type {ExportFormat['id']} */ (formatId));
      else settings.format = /** @type {ExportFormat['id']} */ (formatId);
    }
    if (active) return;
    if (!(await hydrateIfProvisional(app._activeViewer().doc))) return;
    setActive(true);
  };

  return {
    toolbarElem, isActive: () => active, open, close: () => setActive(false), viewSegElem: () => viewSeg, toolsElem: () => tools, docChanged, hintText: () => null, format: () => settings.format,
  };
}
