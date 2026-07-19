import { findRootObjNum, findInfoObjNum } from './parsePdfUtils.js';

const BLOCK = new Set([
  'P', 'H', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'Title', 'Caption', 'BlockQuote',
  'Note', 'Footnote', 'Quote', 'Code', 'TOCI', 'Index', 'LI', 'Figure', 'Formula',
]);

// Inline tags roll up to the nearest block ancestor, so styled runs and list labels/bodies (Lbl, LBody) stay in their paragraph.
const INLINE = new Set([
  'Span', 'Link', 'Em', 'Strong', 'Reference', 'Annot', 'Sub', 'Sup', 'Ruby', 'Warichu',
  'Lbl', 'LBody', 'BibEntry', 'Artifact',
]);

// Producers whose tags are synthetic OCR output rather than authored structure: they tag scanned pages line by line, so their trees carry no paragraph boundaries and are excluded.
export const OCR_PRODUCER_RE = /paper\s*capture|luradocument|abbyy|finereader|kofax|readiris|omnipage|tesseract|scansoft|\bcapture\b/i;

function extractBalanced(s, start, open, close) {
  let depth = 0; let i = start;
  while (i < s.length) {
    if (s.startsWith(open, i)) { depth++; i += open.length; continue; }
    if (s.startsWith(close, i)) { depth--; i += close.length; if (depth === 0) return s.slice(start, i); continue; }
    i++;
  }
  return s.slice(start);
}

/** Tokenize a PDF array/dict body into ordered tokens: {ref}, {dict}, {arr}, {num}, {null}. */
function parseTokens(s) {
  const out = []; let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue; }
    if (s[i] === '<' && s[i + 1] === '<') { const d = extractBalanced(s, i, '<<', '>>'); out.push({ type: 'dict', text: d }); i += d.length; continue; }
    if (s[i] === '[') { const a = extractBalanced(s, i, '[', ']'); out.push({ type: 'arr', text: a }); i += a.length; continue; }
    const refM = /^(\d+)\s+\d+\s+R/.exec(s.slice(i));
    if (refM) { out.push({ type: 'ref', num: Number(refM[1]) }); i += refM[0].length; continue; }
    const numM = /^-?\d+/.exec(s.slice(i));
    if (numM) { out.push({ type: 'num', val: Number(numM[0]) }); i += numM[0].length; continue; }
    if (s.startsWith('null', i)) { out.push({ type: 'null' }); i += 4; continue; }
    i++;
  }
  return out;
}

/** Walk a PDF number tree (`/Nums` leaves, `/Kids` internal nodes) into a Map from number to value token. */
function buildNumberTree(objCache, rootRef) {
  const out = new Map();
  const seen = new Set();
  function rec(objNum, depth) {
    if (depth > 50 || seen.has(objNum)) return; seen.add(objNum);
    const t = objCache.getObjectText(objNum); if (!t) return;
    const numsM = /\/Nums\s*\[/.exec(t);
    if (numsM) {
      const body = extractBalanced(t, numsM.index + numsM[0].length - 1, '[', ']').slice(1, -1);
      const toks = parseTokens(body);
      for (let k = 0; k + 1 < toks.length; k += 2) if (toks[k].type === 'num') out.set(toks[k].val, toks[k + 1]);
    }
    const kidsM = /\/Kids\s*\[/.exec(t);
    if (kidsM) {
      const body = extractBalanced(t, kidsM.index + kidsM[0].length - 1, '[', ']');
      const re = /(\d+)\s+\d+\s+R/g; let m;
      while ((m = re.exec(body))) rec(Number(m[1]), depth + 1);
    }
  }
  rec(rootRef, 0);
  return out;
}

/**
 * Read a document-information dictionary field as a best-effort latin1 string.
 * Handles both literal `(...)` and hex `<...>` (UTF-16BE) forms.
 * @param {ObjectCache} objCache
 * @param {Uint8Array} pdfBytes
 * @param {string} field - info-dict key without the leading slash (e.g. 'Producer', 'Creator').
 * @returns {string}
 */
function readInfoField(objCache, pdfBytes, field) {
  try {
    const infoNum = findInfoObjNum(pdfBytes);
    if (!infoNum) return '';
    const info = objCache.getObjectText(infoNum) || '';
    const lit = new RegExp(`/${field}\\s*\\(((?:[^()\\\\]|\\\\.)*)\\)`).exec(info);
    if (lit) return lit[1];
    const hex = new RegExp(`/${field}\\s*<([0-9A-Fa-f\\s]+)>`).exec(info);
    if (hex) {
      const h = hex[1].replace(/\s+/g, '');
      let s = '';
      // UTF-16BE (BOM feff) or raw bytes: strip the high zero bytes for an ASCII-ish read.
      for (let i = 0; i < h.length; i += 2) { const c = parseInt(h.slice(i, i + 2), 16); if (c) s += String.fromCharCode(c); }
      return s.replace(/^﻿/, '');
    }
  } catch { /* best-effort */ }
  return '';
}

/**
 * Read the document `/Producer` string (best-effort, latin1).
 * @param {ObjectCache} objCache
 * @param {Uint8Array} pdfBytes
 * @returns {string}
 */
export function readDocProducer(objCache, pdfBytes) {
  return readInfoField(objCache, pdfBytes, 'Producer');
}

// Microsoft Word, both its native PDF export and the Acrobat PDFMaker-for-Word plugin, tags exactly one struct element per Word paragraph, so the element boundary is the paragraph boundary.
// Matched against /Creator and /Producer (e.g. "Microsoft® Word 2016", "Acrobat PDFMaker 10.1 for Word").
const WORD_AUTHORED_RE = /microsoft\W{0,3}word|pdfmaker\b[^()]*?\bfor\s+word/i;

/**
 * Best-effort: was this PDF authored by Microsoft Word (native export or the PDFMaker-for-Word plugin)?
 * @param {ObjectCache} objCache
 * @param {Uint8Array} pdfBytes
 * @returns {boolean}
 */
export function docAuthoredByWord(objCache, pdfBytes) {
  return WORD_AUTHORED_RE.test(readInfoField(objCache, pdfBytes, 'Creator'))
    || WORD_AUTHORED_RE.test(readInfoField(objCache, pdfBytes, 'Producer'));
}

/**
 * Build the per-page (pageIndex, MCID) to owning-block-element map for a tagged PDF.
 *
 * @param {ObjectCache} objCache
 * @param {Uint8Array} pdfBytes
 * @param {Array<{objNum: number, objText: string}>} pageObjs - page objects (index = page index).
 * @returns {Map<string, {elemNum: number, tag: string}> | null} keyed by `${pageIndex}:${mcid}`, or null when the doc has no usable structure (no StructTreeRoot/ParentTree, or an OCR producer).
 */
export function buildStructElemMap(objCache, pdfBytes, pageObjs) {
  const root = findRootObjNum(pdfBytes);
  if (!root) return null;
  const catText = objCache.getObjectText(root);
  const strRef = /\/StructTreeRoot\s+(\d+)\s+\d+\s+R/.exec(catText || '');
  if (!strRef) return null;
  if (OCR_PRODUCER_RE.test(readDocProducer(objCache, pdfBytes))) return null;
  const rootDict = objCache.getObjectText(Number(strRef[1]));
  if (!rootDict) return null;

  // RoleMap: custom tag to standard tag.
  const roleMap = {};
  let rmText = '';
  const rmInline = /\/RoleMap\s*<<([\s\S]*?)>>/.exec(rootDict);
  const rmRef = /\/RoleMap\s+(\d+)\s+\d+\s+R/.exec(rootDict);
  if (rmInline) rmText = rmInline[1];
  else if (rmRef) { const t = objCache.getObjectText(Number(rmRef[1])) || ''; const mm = /<<([\s\S]*?)>>/.exec(t); rmText = mm ? mm[1] : ''; }
  if (rmText) { const re = /\/([A-Za-z0-9._]+)\s*\/([A-Za-z0-9._]+)/g; let m; while ((m = re.exec(rmText))) roleMap[m[1]] = m[2]; }
  const mapTag = (s) => { if (!s) return '?'; let cur = s; const seen = new Set(); while (roleMap[cur] && !seen.has(cur)) { seen.add(cur); cur = roleMap[cur]; } return cur; };

  const ptRef = /\/ParentTree\s+(\d+)\s+\d+\s+R/.exec(rootDict);
  if (!ptRef) return null;
  const parentTree = buildNumberTree(objCache, Number(ptRef[1]));
  if (!parentTree.size) return null;

  const tagOf = (objNum) => mapTag((/\/S\s*\/([A-Za-z0-9._]+)/.exec(objCache.getObjectText(objNum) || '') || [])[1] || '?');
  const parentOf = (objNum) => { const m = /\/P\s+(\d+)\s+\d+\s+R/.exec(objCache.getObjectText(objNum) || ''); return m ? Number(m[1]) : null; };

  // Resolve an owning element up to its nearest BLOCK ancestor (through INLINE tags only).
  const ownerCache = new Map();
  function blockOwner(objNum) {
    if (ownerCache.has(objNum)) return ownerCache.get(objNum);
    let cur = objNum; const seen = new Set(); let res = null;
    while (cur != null && !seen.has(cur)) {
      seen.add(cur);
      const tag = tagOf(cur);
      if (BLOCK.has(tag)) { res = { elemNum: cur, tag }; break; }
      if (!INLINE.has(tag)) { res = { elemNum: objNum, tag: tagOf(objNum) }; break; } // grouping container: keep immediate owner
      cur = parentOf(cur);
    }
    if (!res) res = { elemNum: objNum, tag: tagOf(objNum) };
    ownerCache.set(objNum, res);
    return res;
  }

  const map = new Map();
  pageObjs.forEach((pg, pageIdx) => {
    const spM = /\/StructParents\s+(\d+)/.exec(pg.objText || '');
    if (!spM) return;
    const valTok = parentTree.get(Number(spM[1]));
    if (!valTok) return;
    let arrText;
    if (valTok.type === 'ref') arrText = objCache.getObjectText(valTok.num) || '';
    else if (valTok.type === 'arr') arrText = valTok.text;
    else return;
    const inner = arrText.startsWith('[') ? arrText.slice(1, -1) : (/\[([\s\S]*)\]/.exec(arrText) || [, ''])[1];
    parseTokens(inner).forEach((tk, mcid) => {
      if (tk.type === 'ref') map.set(`${pageIdx}:${mcid}`, blockOwner(tk.num));
    });
  });
  return map.size ? map : null;
}

/**
 * Stamp `word.structElemId` (owning block-element object number) and `word.structElemTag` onto every word, from the resolved element map.
 * `word.mcid` and `word.structTag` come from the content stream and are left untouched: `structTag` is the raw stream tag, while `structElemTag` is the resolved tree element's tag.
 * @param {Array<{pageObj: OcrPage}|null>} results - parsed pages (index = page index), mutated in place.
 * @param {Map<string, {elemNum: number, tag: string}>} elemMap
 */
export function stampStructIds(results, elemMap) {
  for (let n = 0; n < results.length; n++) {
    const r = results[n];
    if (!r || !r.pageObj || !r.pageObj.lines) continue;
    for (const line of r.pageObj.lines) {
      for (const word of line.words) {
        if (word.mcid == null) continue;
        const o = elemMap.get(`${n}:${word.mcid}`);
        if (o) { word.structElemId = o.elemNum; word.structElemTag = o.tag; }
      }
    }
  }
}
