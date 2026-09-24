import { bboxToPageSpace } from './addHighlights.js';

/**
 * @typedef {Object} CitationSpan
 * @property {number} page - 0-based index of the physical page the span lies on.
 * @property {?string} pageNum - The printed page number.
 * @property {?number} first - First cited line number present on this printed page.
 * @property {?number} last - Last cited line number present on this printed page.
 * @property {?Array<number>} paragraphs - The cited paragraph numbers with lines on this page.
 * @property {Array<import('./objects/ocrObjects.js').OcrLine>} lines - The lines of the cited rows or paragraphs.
 * @property {import('./objects/ocrObjects.js').bbox} bbox - Union of `lines` in page pixels, with a line taller than its row counted as the row's band.
 * @property {Array<number>} missing - Cited line numbers with no line on this printed page, or cited paragraph numbers no paragraph carries.
 */

/**
 * @typedef {Object} Citation
 * @property {'page' | 'line' | 'paragraph'} kind
 * @property {?number} page
 * @property {?number} line
 * @property {?number} endPage
 * @property {?number} endLine
 * @property {?Array<number>} paragraphs
 */

/**
 * Parses a citation.
 * Accepted forms are "34", "34:14", "34:14-18", "34:14-35:2" and the page range "34-36", with any whitespace, hyphen or dash between the parts.
 * Paragraph forms are "¶ 12", "¶¶ 12-14", "para. 12" and "paragraph 12".
 * A leading "at", "p.", "pp.", "pg.", "page", "pages" or "vol. N" is ignored.
 * A sub-item after a paragraph number, as in "¶ 12(a)" or "¶ 12.a", is ignored too.
 * @param {string} text
 * @returns {?Citation}
 */
export function parseCitation(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim().toLowerCase().replace(/^(?:(?:at|pp?\.?|pg\.?|pages?|vol\.?\s*[ivxlc\d]+[.,]?)\s+)+/, '');
  const sub = String.raw`(?:\s*\(\s*[a-z0-9]{1,4}\s*\)|\s*\.\s*[a-z](?![a-z]))?`;
  const pm = s.match(new RegExp(String.raw`^(?:¶{1,2}|paras?\.?|paragraphs?)\s*(\d+)${sub}(?:\s*[-–—]+\s*(\d+)?${sub})?\s*$`));
  if (pm) {
    const paragraph = parseInt(pm[1], 10);
    const endParagraph = pm[2] != null ? parseInt(pm[2], 10) : paragraph;
    if (paragraph < 1 || endParagraph < paragraph) return null;
    const paragraphs = [];
    for (let k = paragraph; k <= endParagraph; k++) paragraphs.push(k);
    return {
      kind: 'paragraph', page: null, line: null, endPage: null, endLine: null, paragraphs,
    };
  }
  const m = s.match(/^(\d+)(?:\s*:\s*(\d+))?(?:\s*[-–—]+\s*(?:(\d+)\s*:\s*)?(\d+))?\s*$/);
  if (!m) return null;
  const page = parseInt(m[1], 10);
  const line = m[2] != null ? parseInt(m[2], 10) : null;
  let endPage = page;
  let endLine = null;
  if (m[4] != null) {
    if (m[3] != null) { endPage = parseInt(m[3], 10); endLine = parseInt(m[4], 10); } else if (line != null) { endLine = parseInt(m[4], 10); } else { endPage = parseInt(m[4], 10); }
  }
  if (page < 1 || (line != null && line < 1) || (endLine != null && endLine < 1)) return null;
  if (line == null && endLine != null) return null;
  if (endPage < page || (endPage === page && line != null && endLine != null && endLine < line)) return null;
  return {
    kind: line == null ? 'page' : 'line', page, line, endPage, endLine, paragraphs: null,
  };
}

/**
 * Resolves a citation to the lines it names.
 * A printed page that appears twice yields one span per occurrence.
 * @param {Array<?import('./objects/ocrObjects.js').OcrPage>} pages - A layer's pages.
 * @param {string} text
 * @returns {Array<CitationSpan>}
 */
export function resolveCitation(pages, text) {
  const c = parseCitation(text);
  if (!c) return [];
  /** @type {Array<CitationSpan>} */
  const spans = [];
  if (c.kind === 'paragraph') {
    const wanted = new Set(c.paragraphs);
    /** @type {Set<number>} */
    const found = new Set();
    for (let n = 0; n < pages.length; n++) {
      const pg = pages[n];
      if (!pg) continue;
      /** @type {Array<import('./objects/ocrObjects.js').OcrLine>} */
      const lines = [];
      /** @type {Set<number>} */
      const nums = new Set();
      for (const par of pg.pars || []) {
        if (par.parNum == null || !wanted.has(par.parNum)) continue;
        nums.add(par.parNum);
        found.add(par.parNum);
        for (const l of par.lines) lines.push(l);
      }
      if (!lines.length) continue;
      const bbox = {
        left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity,
      };
      for (const l of lines) {
        const q = bboxToPageSpace(l.bbox, l.orientation, pg.dims);
        bbox.left = Math.min(bbox.left, q.left); bbox.top = Math.min(bbox.top, q.top); bbox.right = Math.max(bbox.right, q.right); bbox.bottom = Math.max(bbox.bottom, q.bottom);
      }
      const labeled = lines.find((l) => l.pageNum != null) || pg.lines.find((l) => l.pageNum != null);
      spans.push({
        page: n, pageNum: labeled ? String(labeled.pageNum) : null, first: null, last: null, paragraphs: [...nums].sort((a, b) => a - b), lines, bbox, missing: [],
      });
    }
    const missing = /** @type {Array<number>} */ (c.paragraphs).filter((k) => !found.has(k));
    for (const sp of spans) sp.missing = missing;
    return spans;
  }
  const cPage = /** @type {number} */ (c.page);
  const cEndPage = /** @type {number} */ (c.endPage);
  /** @type {Array<{page: number, pageNum: string, num: number, lines: Array<import('./objects/ocrObjects.js').OcrLine>}>} */
  const printed = [];
  for (let n = 0; n < pages.length; n++) {
    const pg = pages[n];
    if (!pg) continue;
    const byLabel = new Map();
    for (const line of pg.lines) {
      if (line.pageNum == null) continue;
      const key = String(line.pageNum);
      let entry = byLabel.get(key);
      if (!entry) {
        entry = {
          page: n, pageNum: key, num: /^\d+$/.test(key) ? parseInt(key, 10) : NaN, lines: [],
        };
        byLabel.set(key, entry);
        printed.push(entry);
      }
      entry.lines.push(line);
    }
  }
  for (const p of printed) {
    if (Number.isNaN(p.num) || p.num < cPage || p.num > cEndPage) continue;
    // An OCR engine can draw one line box across two rows.
    /** @type {Map<number, number>} */
    const rowCy = new Map();
    let pitch = 0;
    const height = (l) => l.bbox.bottom - l.bbox.top;
    const hMed = median(p.lines.map(height));
    const centers = new Map();
    for (const l of p.lines) {
      if (l.lineNum == null || height(l) > 1.5 * hMed) continue;
      if (!centers.has(l.lineNum)) centers.set(l.lineNum, []);
      centers.get(l.lineNum).push((l.bbox.top + l.bbox.bottom) / 2);
    }
    for (const [n, cs] of centers) rowCy.set(n, median(cs));
    const gaps = [];
    for (const [n, cy] of rowCy) if (rowCy.has(n + 1)) gaps.push(rowCy.get(n + 1) - cy);
    if (gaps.length) pitch = median(gaps);
    const bbox = {
      left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity,
    };
    const grow = (l) => {
      const b = l.bbox;
      let top = b.top; let bottom = b.bottom;
      if (pitch > 0 && height(l) > 1.3 * pitch && rowCy.has(l.lineNum)) {
        const cy = rowCy.get(l.lineNum);
        top = Math.max(top, cy - 0.5 * pitch); bottom = Math.min(bottom, cy + 0.5 * pitch);
      }
      const q = bboxToPageSpace({
        left: b.left, top, right: b.right, bottom,
      }, l.orientation, pages[p.page].dims);
      bbox.left = Math.min(bbox.left, q.left); bbox.top = Math.min(bbox.top, q.top); bbox.right = Math.max(bbox.right, q.right); bbox.bottom = Math.max(bbox.bottom, q.bottom);
    };
    if (c.line == null) {
      const numbered = p.lines.filter((l) => l.lineNum != null);
      const lines = numbered.length ? numbered : p.lines;
      for (const l of lines) grow(l);
      const nums = numbered.map((l) => /** @type {number} */(l.lineNum));
      spans.push({
        page: p.page, pageNum: p.pageNum, first: nums.length ? Math.min(...nums) : null, last: nums.length ? Math.max(...nums) : null, paragraphs: null, lines, bbox, missing: [],
      });
      continue;
    }
    const lo = p.num === cPage ? c.line : 1;
    const hi = p.num === cEndPage ? (c.endLine != null ? c.endLine : c.line) : Infinity;
    const lines = p.lines.filter((l) => l.lineNum != null && l.lineNum >= lo && l.lineNum <= hi);
    if (!lines.length) continue;
    const present = new Set(lines.map((l) => l.lineNum));
    const missing = [];
    if (hi !== Infinity) for (let k = lo; k <= hi; k++) if (!present.has(k)) missing.push(k);
    for (const l of lines) grow(l);
    const nums = [...present].map(Number);
    spans.push({
      page: p.page, pageNum: p.pageNum, first: Math.min(...nums), last: Math.max(...nums), paragraphs: null, lines, bbox, missing,
    });
  }
  return spans;
}

/** @param {Array<number>} arr */
function median(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  if (!s.length) return 0;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
