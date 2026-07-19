import { findRootObjNum } from './parsePdfUtils.js';
import { readDocProducer, OCR_PRODUCER_RE } from './structTree.js';
import { normalizeHeadingText } from '../utils/miscUtils.js';

/** Decode a PDF string body (literal-escape or hex, with UTF-16BE BOM support) to a JS string. */
function decodePdfString(raw, isHex) {
  if (raw == null) return '';
  if (isHex) {
    const h = raw.replace(/\s+/g, '');
    const bytes = [];
    for (let i = 0; i + 1 < h.length; i += 2) bytes.push(parseInt(h.slice(i, i + 2), 16));
    if (bytes[0] === 0xFE && bytes[1] === 0xFF) {
      let s = '';
      for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      return s;
    }
    return bytes.map((b) => String.fromCharCode(b)).join('');
  }
  const s = raw.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (m, g) => {
    if (g === 'n') return '\n'; if (g === 'r') return '\r'; if (g === 't') return '\t';
    if (g === '(') return '('; if (g === ')') return ')'; if (g === '\\') return '\\';
    if (/^[0-7]+$/.test(g)) return String.fromCharCode(parseInt(g, 8));
    return g;
  });
  if (s.charCodeAt(0) === 0xFE && s.charCodeAt(1) === 0xFF) {
    let o = '';
    for (let i = 2; i + 1 < s.length; i += 2) o += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
    return o;
  }
  return s;
}

/**
 * Is this bookmark title shaped like a heading (a short label) rather than a running paragraph?
 * This is the gate that rejects per-paragraph bookmarks.
 * Conservative by design: a missed heading is a no-op, a false anchor is a wrong split.
 * @param {string} title
 */
function headingShaped(title) {
  const t = (title || '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (t.length > 80 || t.split(' ').length > 12) return false;
  if (/[.!?]["')”’]?$/.test(t)) return false; // ends like a sentence
  // Rejecting "1." / "10)" running-paragraph enumerators also skips real numbered headings ("1. Introduction"): those are virtually always geometrically distinct, so geometry already classifies them.
  if (/^\(?\d{1,4}[.)]/.test(t)) return false;
  if (/^\(?[a-z]{1,3}[.)]\s/i.test(t)) return false; // list marker: "(a)" "iv."
  if ((t.match(/[A-Za-z]/g) || []).length < 2) return false; // "..." / numeric-only
  if (!/^[\p{L}\p{Nd}]/u.test(t)) return false; // leading symbol ("* depending on model")
  // A real heading's first word carries an uppercase letter (Title-case, ALL-CAPS, or a camelCase brand token like "iDrive").
  // An all-lowercase Latin first word marks a sentence fragment or footnote bookmark, not a heading.
  // Non-Latin first words (CJK/Cyrillic) are exempt.
  const w0 = t.split(/\s+/)[0];
  if (/[a-z]/.test(w0) && !/[A-Z]/.test(w0)) return false;
  return true;
}

/** First page object number referenced by an explicit destination array `[N 0 R /XYZ ...]`. */
function destArrayPageObj(arrText) {
  const m = /^\s*\[\s*(\d+)\s+\d+\s+R\b/.exec(arrText || '');
  return m ? Number(m[1]) : null;
}

/** Walk a name tree (`/Names` leaves, `/Kids` internal nodes), collecting name-to-value-token entries into `out`. */
function buildNameTree(objCache, rootRef, out) {
  const seen = new Set();
  function rec(objNum, depth) {
    if (depth > 50 || seen.has(objNum)) return; seen.add(objNum);
    const t = objCache.getObjectText(objNum); if (!t) return;
    const namesM = /\/Names\s*\[([\s\S]*?)\]/.exec(t);
    if (namesM) {
      const body = namesM[1];
      const re = /\(((?:[^()\\]|\\.)*)\)\s*(\[[\s\S]*?\]|\d+\s+\d+\s+R|<<[\s\S]*?>>)|<([0-9A-Fa-f\s]+)>\s*(\[[\s\S]*?\]|\d+\s+\d+\s+R|<<[\s\S]*?>>)/g;
      let m;
      while ((m = re.exec(body))) {
        const name = m[1] != null ? decodePdfString(m[1], false) : decodePdfString(m[3], true);
        out.set(name, m[2] || m[4]);
      }
    }
    const kidsM = /\/Kids\s*\[([\s\S]*?)\]/.exec(t);
    if (kidsM) { const re = /(\d+)\s+\d+\s+R/g; let m; while ((m = re.exec(kidsM[1]))) rec(Number(m[1]), depth + 1); }
  }
  rec(rootRef, 0);
}

/** Resolve a named destination (from the /Names /Dests tree or the legacy catalog /Dests dict). */
function resolveNamedDest(objCache, nameDests, oldDests, name) {
  let val = nameDests.get(name);
  if (val == null && oldDests) val = oldDests.get(name);
  if (val == null) return null;
  let text = val;
  const refM = /^\s*(\d+)\s+\d+\s+R/.exec(val);
  if (refM) text = objCache.getObjectText(Number(refM[1])) || '';
  const dM = /\/D\s*(\[[\s\S]*?\])/.exec(text);
  if (dM) return destArrayPageObj(dM[1]);
  if (text.trim().startsWith('[')) return destArrayPageObj(text);
  return null;
}

/** Resolve a /Dest or action /D value (array | indirect ref | named: literal or name object). */
function resolveDest(objCache, val, nameDests, oldDests) {
  if (val == null) return null;
  val = val.trim();
  if (val.startsWith('[')) return destArrayPageObj(val);
  const refM = /^(\d+)\s+\d+\s+R/.exec(val);
  if (refM) { const t = objCache.getObjectText(Number(refM[1])) || ''; return t.trim().startsWith('[') ? destArrayPageObj(t) : null; }
  const litM = /^\(((?:[^()\\]|\\.)*)\)/.exec(val);
  if (litM) return resolveNamedDest(objCache, nameDests, oldDests, decodePdfString(litM[1], false));
  const nameM = /^\/([^\s/<>\[\]()]+)/.exec(val);
  if (nameM) return resolveNamedDest(objCache, nameDests, oldDests, nameM[1]);
  return null;
}

/**
 * Build the per-page heading-anchor index from a document's `/Outlines`.
 * @param {ObjectCache} objCache
 * @param {Uint8Array} pdfBytes
 * @param {Array<{objNum: number, objText: string}>} pageObjs - page objects in page order (index = page index).
 * @returns {Map<number, Set<string>> | null} Page index to set of normalized heading-anchor titles, or null when the document has no usable outline (none, OCR producer, or nothing resolvable).
 */
export function buildOutlineHeadingIndex(objCache, pdfBytes, pageObjs) {
  const root = findRootObjNum(pdfBytes);
  if (!root) return null;
  const cat = objCache.getObjectText(root) || '';
  const olM = /\/Outlines\s+(\d+)\s+\d+\s+R/.exec(cat);
  if (!olM) return null;
  if (OCR_PRODUCER_RE.test(readDocProducer(objCache, pdfBytes))) return null;
  const olDict = objCache.getObjectText(Number(olM[1])) || '';
  const firstM = /\/First\s+(\d+)\s+\d+\s+R/.exec(olDict);
  if (!firstM) return null;

  const objToIdx = new Map();
  pageObjs.forEach((p, i) => { if (p && p.objNum > 0) objToIdx.set(p.objNum, i); });

  // Named-destination sources: the modern /Names /Dests name tree and the legacy catalog /Dests dict.
  const nameDests = new Map();
  const namesM = /\/Names\s+(\d+)\s+\d+\s+R/.exec(cat);
  if (namesM) {
    const namesDict = objCache.getObjectText(Number(namesM[1])) || '';
    const destsM = /\/Dests\s+(\d+)\s+\d+\s+R/.exec(namesDict);
    if (destsM) buildNameTree(objCache, Number(destsM[1]), nameDests);
  }
  let oldDests = null;
  const oldDestsM = /\/Dests\s+(\d+)\s+\d+\s+R/.exec(cat);
  if (oldDestsM) {
    oldDests = new Map();
    const dt = objCache.getObjectText(Number(oldDestsM[1])) || '';
    const re = /\/([^\s/<>\[\]()]+)\s*(\[[\s\S]*?\]|\d+\s+\d+\s+R|<<[\s\S]*?>>)/g; let m;
    while ((m = re.exec(dt))) oldDests.set(m[1], m[2]);
  }

  /** @type {Map<number, Set<string>>} */
  const index = new Map();
  const seen = new Set();
  function walk(objNum) {
    let cur = objNum; let guard = 0;
    while (cur && !seen.has(cur) && guard++ < 10000) {
      seen.add(cur);
      const d = objCache.getObjectText(cur) || '';

      const tLit = /\/Title\s*\(((?:[^()\\]|\\.)*)\)/.exec(d);
      const tHex = /\/Title\s*<([0-9A-Fa-f\s]+)>/.exec(d);
      let title = '';
      if (tLit && (!tHex || tLit.index <= tHex.index)) title = decodePdfString(tLit[1], false);
      else if (tHex) title = decodePdfString(tHex[1], true);

      if (headingShaped(title)) {
        // Destination: /Dest directly, else a /GoTo action's /D.
        const destM = /\/Dest\s*(\[[\s\S]*?\]|\(((?:[^()\\]|\\.)*)\)|\/[^\s/<>\[\]()]+|\d+\s+\d+\s+R)/.exec(d);
        let pageObj = destM ? resolveDest(objCache, destM[1], nameDests, oldDests) : null;
        if (pageObj == null) {
          const aInline = /\/A\s*<<([\s\S]*?)>>/.exec(d);
          const aRef = !aInline ? /\/A\s+(\d+)\s+\d+\s+R/.exec(d) : null;
          const ab = aInline ? aInline[1] : (aRef ? (objCache.getObjectText(Number(aRef[1])) || '') : '');
          if (ab && /\/S\s*\/GoTo\b/.test(ab)) {
            const dM = /\/D\s*(\[[\s\S]*?\]|\(((?:[^()\\]|\\.)*)\)|\/[^\s/<>\[\]()]+|\d+\s+\d+\s+R)/.exec(ab);
            if (dM) pageObj = resolveDest(objCache, dM[1], nameDests, oldDests);
          }
        }
        if (pageObj != null && objToIdx.has(pageObj)) {
          const idx = objToIdx.get(pageObj);
          if (!index.has(idx)) index.set(idx, new Set());
          index.get(idx).add(normalizeHeadingText(title));
        }
      }

      const fM = /\/First\s+(\d+)\s+\d+\s+R/.exec(d);
      if (fM) walk(Number(fM[1]));
      const nM = /\/Next\s+(\d+)\s+\d+\s+R/.exec(d);
      cur = nM ? Number(nM[1]) : null;
    }
  }
  walk(Number(firstM[1]));
  return index.size ? index : null;
}

/**
 * Stamp `page.outlineHeadings` (the page's Set of normalized heading-anchor titles) from the resolved index.
 * @param {Array<{pageObj: OcrPage}|null>} results - per-page parse results (index = page index).
 * @param {Map<number, Set<string>>} headingIndex
 */
export function stampOutlineHeadings(results, headingIndex) {
  for (const [idx, set] of headingIndex) {
    const r = results[idx];
    if (r && r.pageObj) r.pageObj.outlineHeadings = set;
  }
}
