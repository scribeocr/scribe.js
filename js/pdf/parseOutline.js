import { makeOutlineNode } from '../objects/outlineObjects.js';
import { findRootObjNum } from './parsePdfUtils.js';
import { decodePdfString } from './pdfPrimitives.js';

/**
 * Parse the PDF `/Outlines` (bookmark) tree of a loaded document into the outline model.
 *
 * Destinations are normalized to zero-based page indices via the page list, so the result is page-order-relative (see js/objects/outlineObjects.js).
 * Named destinations are resolved through the catalog `/Names -> /Dests` name tree and the legacy `/Dests` dictionary.
 * Non-`GoTo` bookmark actions (URI, remote `GoToR`) are preserved as opaque `action` strings.
 * A bookmark whose target can't be resolved to a page is kept as a structural (dest-less) node rather than dropped.
 *
 * Browser-safe (runs in the PDF worker): no Node globals.
 *
 * @param {import('./objectCache.js').ObjectCache} objCache
 * @param {Array<{ objNum: number }>} pages - Page objects in document order (from getPageObjects).
 * @returns {Array<import('../objects/outlineObjects.js').OutlineNode>} Top-level nodes; empty when none.
 */
export function parseOutline(objCache, pages) {
  const catalogObjNum = findRootObjNum(objCache.pdfBytes);
  if (!catalogObjNum) return [];
  const catalogText = objCache.getObjectText(catalogObjNum);
  if (!catalogText) return [];

  const outlinesObjNum = refObjNum(catalogText, 'Outlines');
  if (!outlinesObjNum) return [];
  const rootText = objCache.getObjectText(outlinesObjNum);
  if (!rootText) return [];

  const objNumToIndex = new Map(pages.map((p, i) => [p.objNum, i]));
  const nameDests = buildNameDests(objCache, catalogText);

  const firstObjNum = refObjNum(rootText, 'First');
  if (!firstObjNum) return [];
  return walkSiblings(firstObjNum, objCache, nameDests, objNumToIndex, new Set());
}

/**
 * Walk a /Next-linked sibling chain into an array of outline nodes, recursing into /First children.
 * A visited set breaks any cyclic /Next or /First links in a malformed PDF.
 *
 * @param {number} firstObjNum - Object number of the first item in the sibling chain.
 * @param {import('./objectCache.js').ObjectCache} objCache
 * @param {Map<string, { pageIndex: number, view: any }>} nameDests - Named destinations resolved from the catalog.
 * @param {Map<number, number>} objNumToIndex - Page object number to zero-based page index.
 * @param {Set<number>} visited - Object numbers already walked, to break cycles.
 * @returns {Array<import('../objects/outlineObjects.js').OutlineNode>} Nodes in sibling order.
 */
function walkSiblings(firstObjNum, objCache, nameDests, objNumToIndex, visited) {
  const out = [];
  let cur = firstObjNum;
  while (cur && !visited.has(cur)) {
    visited.add(cur);
    const text = objCache.getObjectText(cur);
    if (!text) break;

    const { dest, action } = resolveItemDest(text, nameDests, objNumToIndex, objCache);
    const countMatch = /\/Count\s+(-?\d+)/.exec(text);
    const node = makeOutlineNode({
      title: decodePdfString(rawValue(text, 'Title') || ''),
      dest,
      action,
      // /Count is negative for a collapsed item with descendants; absent/positive means open.
      open: !(countMatch && Number(countMatch[1]) < 0),
    });

    const childFirst = refObjNum(text, 'First');
    if (childFirst) node.children = walkSiblings(childFirst, objCache, nameDests, objNumToIndex, visited);

    out.push(node);
    cur = refObjNum(text, 'Next');
  }
  return out;
}

/**
 * Resolve an outline item's destination to `{ dest, action }`:
 * - a `/Dest` (inline array, named, or indirect) or `/A /GoTo /D` -> `{ dest: { pageIndex, view } }`;
 * - a non-`GoTo` `/A` action (URI, GoToR) -> `{ action: '<<...>>' }` (opaque, re-emitted verbatim);
 * - anything unresolvable or absent -> `{ dest: null, action: null }` (structural node).
 * @param {string} itemText - Raw object text of the outline item.
 * @param {Map<string, string>} nameDests - Named-destination name to value token map.
 * @param {Map<number, number>} objNumToIndex - Page object number to page index map.
 * @param {*} objCache - Object cache exposing `getObjectText(objNum)`.
 * @returns {{dest: {pageIndex: number, view: Array<number|string|null>}|null, action: string|null}}
 */
function resolveItemDest(itemText, nameDests, objNumToIndex, objCache) {
  let destToken = rawValue(itemText, 'Dest');
  if (!destToken) {
    let actionText = null;
    const actionRef = refObjNum(itemText, 'A');
    if (actionRef) {
      actionText = objCache.getObjectText(actionRef);
    } else {
      const inline = /\/A\s*<<([\s\S]*?)>>/.exec(itemText);
      if (inline) actionText = `<<${inline[1]}>>`;
    }
    if (actionText) {
      if (/\/S\s*\/GoTo\b/.test(actionText)) destToken = rawValue(actionText, 'D');
      else return { dest: null, action: actionText.trim() };
    }
  }
  if (!destToken) return { dest: null, action: null };

  const arrText = destTokenToArrayText(destToken.trim(), nameDests, objCache);
  const parsed = arrText ? parseDestArray(arrText) : null;
  if (!parsed || !objNumToIndex.has(parsed.pageObjNum)) return { dest: null, action: null };
  return { dest: { pageIndex: objNumToIndex.get(parsed.pageObjNum), view: parsed.view }, action: null };
}

/**
 * Resolve a raw /Dest token (array, name string, name object, or indirect ref) to a `[...]` array text.
 * @param {string} token - The raw /Dest token to resolve.
 * @param {Map<string, string>} nameDests - Named-destination name to value-token map.
 * @param {{ getObjectText: (objNum: number) => (string | null) }} objCache - Object cache for resolving indirect refs.
 * @returns {string | null} The resolved `[...]` array text, or null if it cannot be resolved.
 */
function destTokenToArrayText(token, nameDests, objCache) {
  if (token.startsWith('[')) return token;
  if (token.startsWith('(') || token.startsWith('<')) return resolveValueToDestArray(nameDests.get(decodePdfString(token)), objCache);
  if (token.startsWith('/')) return resolveValueToDestArray(nameDests.get(token.slice(1)), objCache);
  if (/^\d+\s+\d+\s+R/.test(token)) return resolveValueToDestArray(token, objCache);
  return null;
}

/**
 * Resolve a name-tree value (a `[...]` array, an indirect ref, or a `<< /D [...] >>` dict) to array text.
 * @param {string|undefined} value - Raw name-tree value token, or undefined if absent.
 * @param {object} objCache - Object cache exposing `getObjectText(objNum)` for resolving indirect refs.
 * @returns {string|null} The `[...]` destination array text, or null if unresolvable.
 */
function resolveValueToDestArray(value, objCache) {
  if (!value) return null;
  const t = value.trim();
  if (t.startsWith('[')) return t;
  if (t.startsWith('<<')) {
    const d = rawValue(t, 'D');
    return d ? resolveValueToDestArray(d, objCache) : null;
  }
  const refMatch = /^(\d+)\s+\d+\s+R/.exec(t);
  if (refMatch) return resolveValueToDestArray(objCache.getObjectText(Number(refMatch[1])), objCache);
  return null;
}

/**
 * Parse a destination array `[<pageObjNum> 0 R /Fit ...]` into its page object number and view tail.
 * @param {string} arrText - Destination array text, e.g. `[5 0 R /XYZ 0 792 null]`.
 * @returns {{pageObjNum: number, view: Array<string|number|null>}|null} Page object number and view parameters, or null if `arrText` is not a valid destination array.
 */
function parseDestArray(arrText) {
  const m = /^\s*\[\s*(\d+)\s+\d+\s+R\b([\s\S]*?)\]\s*$/.exec(arrText.trim());
  if (!m) return null;
  const tail = m[2].trim();
  const view = tail
    ? tail.replace(/^\//, '').split(/\s+/).filter(Boolean).map((tk) => (tk === 'null' ? null : (/^-?[\d.]+$/.test(tk) ? Number(tk) : tk)))
    : [];
  return { pageObjNum: Number(m[1]), view };
}

/**
 * Build a map of named-destination name -> value token from the /Names /Dests name tree and legacy /Dests dict.
 * @param {import('./objCache.js').ObjCache} objCache
 * @param {string} catalogText
 * @returns {Map<string, string>}
 */
function buildNameDests(objCache, catalogText) {
  const nameDests = new Map();

  const namesDictNum = refObjNum(catalogText, 'Names');
  if (namesDictNum) {
    const namesText = objCache.getObjectText(namesDictNum);
    const destsTreeNum = namesText && refObjNum(namesText, 'Dests');
    if (destsTreeNum) walkNameTree(destsTreeNum, objCache, nameDests, new Set());
  }

  // Legacy: a /Dests dictionary directly in the catalog, mapping /Name -> dest.
  const legacyNum = refObjNum(catalogText, 'Dests');
  if (legacyNum) {
    const legacyText = objCache.getObjectText(legacyNum);
    if (legacyText) for (const m of legacyText.matchAll(/\/([^\s/<>()[\]]+)\s*(\[[\s\S]*?\]|\d+\s+\d+\s+R)/g)) if (!nameDests.has(m[1])) nameDests.set(m[1], m[2]);
  }
  return nameDests;
}

/**
 * Recursively collect name -> value pairs from a name-tree node (/Names leaves + /Kids intermediates).
 * @param {number} nodeObjNum
 * @param {import('./objectCache.js').ObjectCache} objCache
 * @param {Map<string, string>} nameDests
 * @param {Set<number>} visited
 */
function walkNameTree(nodeObjNum, objCache, nameDests, visited) {
  if (visited.has(nodeObjNum)) return;
  visited.add(nodeObjNum);
  const text = objCache.getObjectText(nodeObjNum);
  if (!text) return;

  const namesArr = rawValue(text, 'Names');
  if (namesArr) parseNameLeaf(namesArr.slice(1, -1), nameDests);

  const kidsArr = rawValue(text, 'Kids');
  if (kidsArr) for (const m of kidsArr.matchAll(/(\d+)\s+\d+\s+R/g)) walkNameTree(Number(m[1]), objCache, nameDests, visited);
}

/**
 * Scan the inner text of a name-tree leaf's /Names array as alternating (name) value pairs.
 * @param {string} inner - Inner text of the /Names array (contents between its brackets).
 * @param {Map<string, string>} nameDests - Map accumulating name -> value pairs across leaves.
 */
function parseNameLeaf(inner, nameDests) {
  let i = 0;
  const readToken = () => {
    while (i < inner.length && /\s/.test(inner[i])) i += 1;
    if (i >= inner.length) return null;
    const c = inner[i];
    if (c === '(') {
      let depth = 0; let j = i;
      for (; j < inner.length; j += 1) {
        const ch = inner[j];
        if (ch === '\\') { j += 1; } else if (ch === '(') depth += 1; else if (ch === ')') { depth -= 1; if (depth === 0) { j += 1; break; } }
      }
      const tok = inner.slice(i, j); i = j; return tok;
    }
    if (c === '<' && inner[i + 1] === '<') {
      let depth = 0; let j = i;
      for (; j < inner.length - 1; j += 1) {
        if (inner[j] === '<' && inner[j + 1] === '<') { depth += 1; j += 1; } else if (inner[j] === '>' && inner[j + 1] === '>') { depth -= 1; j += 1; if (depth === 0) { j += 1; break; } }
      }
      const tok = inner.slice(i, j); i = j; return tok;
    }
    if (c === '<') { const j = inner.indexOf('>', i); const tok = inner.slice(i, j + 1); i = j + 1; return tok; }
    if (c === '[') {
      let depth = 0; let j = i;
      for (; j < inner.length; j += 1) { if (inner[j] === '[') depth += 1; else if (inner[j] === ']') { depth -= 1; if (depth === 0) { j += 1; break; } } }
      const tok = inner.slice(i, j); i = j; return tok;
    }
    const rest = inner.slice(i);
    const refMatch = /^\d+\s+\d+\s+R/.exec(rest);
    if (refMatch) { i += refMatch[0].length; return refMatch[0]; }
    const other = /^\S+/.exec(rest); i += other[0].length; return other[0];
  };
  let key = readToken();
  while (key != null) {
    const value = readToken();
    if (value == null) break;
    const name = decodePdfString(key);
    if (!nameDests.has(name)) nameDests.set(name, value);
    key = readToken();
  }
}

/**
 * The object number of an indirect reference stored under `/key`, or null.
 * @param {string} text - Dictionary text to search.
 * @param {string} key - Key name (without the leading slash) whose value is an indirect reference.
 * @returns {number | null}
 */
function refObjNum(text, key) {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * The raw value token following `/key` in a dictionary text: a literal `(...)` / hex `<...>` string,
 * a `[...]` array, a `<<...>>` dict, an indirect ref `N G R`, a `/Name`, or a number.
 * @param {string} text - Dictionary text to scan.
 * @param {string} key - Key name, without the leading slash.
 * @returns {string|null} The raw value token, or null when the key is absent.
 */
function rawValue(text, key) {
  const re = new RegExp(`/${key}\\s*`, 'g');
  const m = re.exec(text);
  if (!m) return null;
  const i = re.lastIndex;
  const c = text[i];
  if (c === '(') {
    let depth = 0; let j = i;
    for (; j < text.length; j += 1) {
      const ch = text[j];
      if (ch === '\\') { j += 1; } else if (ch === '(') depth += 1; else if (ch === ')') { depth -= 1; if (depth === 0) { j += 1; break; } }
    }
    return text.slice(i, j);
  }
  if (c === '<' && text[i + 1] === '<') {
    let depth = 0; let j = i;
    for (; j < text.length - 1; j += 1) {
      if (text[j] === '<' && text[j + 1] === '<') { depth += 1; j += 1; } else if (text[j] === '>' && text[j + 1] === '>') { depth -= 1; j += 1; if (depth === 0) { j += 1; break; } }
    }
    return text.slice(i, j);
  }
  if (c === '<') { const j = text.indexOf('>', i); return j === -1 ? null : text.slice(i, j + 1); }
  if (c === '[') {
    let depth = 0; let j = i;
    for (; j < text.length; j += 1) { if (text[j] === '[') depth += 1; else if (text[j] === ']') { depth -= 1; if (depth === 0) { j += 1; break; } } }
    return text.slice(i, j);
  }
  const rest = text.slice(i);
  const refMatch = /^\d+\s+\d+\s+R/.exec(rest);
  if (refMatch) return refMatch[0];
  const nameMatch = /^\/[^\s/<>()[\]]+/.exec(rest);
  if (nameMatch) return nameMatch[0];
  const numMatch = /^-?[\d.]+/.exec(rest);
  return numMatch ? numMatch[0] : null;
}
