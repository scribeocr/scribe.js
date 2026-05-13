import {
  findXrefOffset, parseXref, ObjectCache, extractDict,
  getPageContentStreams, tokenizeContentStream,
  bytesToLatin1, stripText, sourceXrefIsWellFormed,
} from '../../pdf/parsePdfUtils.js';
import { getPageObjects, collectPageTreeObjNums } from '../../pdf/parsePdfDoc.js';
import { createPdfFontRefs, createEmbeddedFontType0 } from './writePdfFonts.js';
import { ocrPageToPDFStream } from './writePdfText.js';
import { buildHighlightAnnotObjects, consolidateAnnotations } from './writePdfAnnots.js';
import { encodeStreamObject } from './writePdfStreams.js';
import {
  parseTrailerInfo,
  buildIncrementalXrefAndTrailer,
  traceReferencedObjects,
  buildFullXrefAndTrailer,
  copyRawObjectBytes,
} from './pdfObjectGraph.js';

/**
 * Parse /Contents from a page dict, returning an array of indirect references to
 * content stream objects.
 * @param {string} pageObjText
 * @param {ObjectCache} [objCache]
 */
function parseExistingContents(pageObjText, objCache) {
  const arrayMatch = /\/Contents\s*\[([\s\S]*?)\]/.exec(pageObjText);
  if (arrayMatch) {
    return [...arrayMatch[1].matchAll(/(\d+)\s+(\d+)\s+R/g)]
      .map((m) => `${m[1]} ${m[2]} R`);
  }
  const singleMatch = /\/Contents\s+(\d+)\s+(\d+)\s+R/.exec(pageObjText);
  if (singleMatch) {
    const ref = `${singleMatch[1]} ${singleMatch[2]} R`;
    if (objCache) {
      const refText = objCache.getObjectText(Number(singleMatch[1]));
      if (refText) {
        const trimmed = refText.trim();
        if (trimmed.startsWith('[')) {
          return [...trimmed.matchAll(/(\d+)\s+(\d+)\s+R/g)].map((m) => `${m[1]} ${m[2]} R`);
        }
      }
    }
    return [ref];
  }
  return [];
}

/**
 *
 * @param {string[]} existingContentsRefs
 * @param {ObjectCache} objCache
 * @param {() => number} allocObjNum
 * @param {(obj: { objNum: number, content: string | Uint8Array | import('./writePdfStreams.js').PdfBinaryObject }) => void} pushObj
 * @param {boolean} humanReadable
 */
async function rewriteContentsStrippingInvisibleText(existingContentsRefs, objCache, allocObjNum, pushObj, humanReadable) {
  if (existingContentsRefs.length === 0) return existingContentsRefs;
  /** @type {string[]} */
  const parts = [];
  for (const ref of existingContentsRefs) {
    const refMatch = /^(\d+)\s+\d+\s+R$/.exec(ref);
    if (!refMatch) return existingContentsRefs;
    let bytes;
    try {
      bytes = objCache.getStreamBytes(Number(refMatch[1]));
    } catch {
      bytes = null;
    }
    if (!bytes) return existingContentsRefs;
    parts.push(bytesToLatin1(bytes));
  }
  const merged = parts.join('\n');
  const { text, dropped } = stripText(merged, { mode: 'invisible' });
  if (!dropped) return existingContentsRefs;
  const newObjNum = allocObjNum();
  const objBin = await encodeStreamObject(newObjNum, text, { humanReadable });
  pushObj({ objNum: newObjNum, content: objBin });
  return [`${newObjNum} 0 R`];
}

/**
 * Resolve the effective /Resources dictionary for a page.
 * Handles inline dicts, indirect references, and inherited resources.
 * @param {string} pageObjText
 * @param {ObjectCache} objCache
 */
function resolvePageResources(pageObjText, objCache) {
  const resIdx = pageObjText.indexOf('/Resources');
  if (resIdx >= 0) {
    const afterRes = pageObjText.substring(resIdx + '/Resources'.length).trimStart();
    if (afterRes.startsWith('<<')) {
      const dictStart = pageObjText.indexOf('<<', resIdx);
      return extractDict(pageObjText, dictStart);
    }
    const refMatch = /^(\d+)\s+\d+\s+R/.exec(afterRes);
    if (refMatch) {
      const resText = objCache.getObjectText(Number(refMatch[1]));
      if (resText) {
        const dictStart = resText.indexOf('<<');
        if (dictStart >= 0) return extractDict(resText, dictStart);
      }
    }
  }

  const parentMatch = /\/Parent\s+(\d+)\s+\d+\s+R/.exec(pageObjText);
  if (parentMatch) {
    const parentText = objCache.getObjectText(Number(parentMatch[1]));
    if (parentText) {
      return resolvePageResources(parentText, objCache);
    }
  }

  return '<<>>';
}

/**
 * Find `key` (a PDF name like '/ExtGState') at the top level of a dict body,
 * skipping over nested dicts/arrays/strings/comments.
 * Naive `indexOf` would match a nested `/ExtGState`
 * (e.g. inside a marked-content `/Properties` entry's own resource dict),
 * causing the overlay merge to splice into the wrong dict.
 *
 * @param {string} inner
 * @param {string} key
 */
function findTopLevelKeyIndex(inner, key) {
  let depth = 0;
  let i = 0;
  const len = inner.length;
  while (i < len) {
    const c = inner.charCodeAt(i);
    if (c === 0x3C && inner.charCodeAt(i + 1) === 0x3C) { depth++; i += 2; continue; }
    if (c === 0x3E && inner.charCodeAt(i + 1) === 0x3E) { depth--; i += 2; continue; }
    if (c === 0x5B) { depth++; i++; continue; }
    if (c === 0x5D) { depth--; i++; continue; }
    if (c === 0x28) {
      let parenDepth = 1;
      i++;
      while (i < len && parenDepth > 0) {
        const sc = inner.charCodeAt(i);
        if (sc === 0x5C) { i += 2; continue; }
        if (sc === 0x28) parenDepth++;
        else if (sc === 0x29) parenDepth--;
        i++;
      }
      continue;
    }
    if (c === 0x3C) {
      const end = inner.indexOf('>', i);
      i = end < 0 ? len : end + 1;
      continue;
    }
    if (c === 0x25) {
      while (i < len) {
        const cc = inner.charCodeAt(i);
        if (cc === 0x0A || cc === 0x0D) break;
        i++;
      }
      continue;
    }
    if (depth === 0 && c === 0x2F && inner.startsWith(key, i)) {
      const after = inner.charCodeAt(i + key.length);
      // PDF name terminates on whitespace or a delimiter (one of /()<>[]{}%).
      if (Number.isNaN(after)
          || after === 0x20 || after === 0x09 || after === 0x0A || after === 0x0D || after === 0x0C
          || after === 0x2F || after === 0x28 || after === 0x29 || after === 0x3C || after === 0x3E
          || after === 0x5B || after === 0x5D || after === 0x7B || after === 0x7D || after === 0x25) {
        return i;
      }
    }
    i++;
  }
  return -1;
}

/**
 *
 * @param {string} inner
 * @param {string} key  e.g. '/Font' or '/ExtGState'
 * @param {string} newEntries
 * @param {?ObjectCache} objCache
 */
function mergeResourceKey(inner, key, newEntries, objCache) {
  if (!newEntries) return inner;
  const idx = findTopLevelKeyIndex(inner, key);
  // Use a newline (not just a space) before any appended/spliced content so a trailing
  // `%` line-comment in `inner` doesn't swallow our content.
  // Same reason we put a newline before the closing `>>` we synthesise.
  if (idx < 0) return `${inner}\n${key}<<${newEntries}>>`;
  let p = idx + key.length;
  while (p < inner.length && /\s/.test(inner[p])) p++;
  if (inner.startsWith('<<', p)) {
    const dict = extractDict(inner, p);
    const merged = `${dict.slice(0, -2)}\n${newEntries}\n>>`;
    return inner.slice(0, p) + merged + inner.slice(p + dict.length);
  }
  const refMatch = /^(\d+)\s+\d+\s+R/.exec(inner.slice(p));
  if (refMatch && objCache) {
    const resolved = objCache.getObjectText(Number(refMatch[1]));
    if (resolved) {
      // Resolved object text may be just the dict body or wrapped — strip
      // any surrounding `<< >>` and splice into our inline dict.
      const trimmed = resolved.trim();
      const inner2 = trimmed.startsWith('<<') && trimmed.endsWith('>>')
        ? trimmed.slice(2, -2).trim()
        : trimmed;
      const merged = `<<${inner2}\n${newEntries}\n>>`;
      return inner.slice(0, p) + merged + inner.slice(p + refMatch[0].length);
    }
  }
  // Couldn't resolve — leave the original slot alone and append a duplicate
  // key. PDF readers honor the last entry for duplicate keys, so the new
  // (overlay) fonts/ExtGStates win.
  return `${inner}\n${key}<<${newEntries}>>`;
}

/**
 * @param {string} existingDict
 * @param {string} overlayFontsStr
 * @param {string} overlayExtGStateStr
 * @param {?ObjectCache} [objCache=null]
 */
function mergeResources(existingDict, overlayFontsStr, overlayExtGStateStr, objCache = null) {
  let inner = existingDict.slice(2, -2).trim();
  inner = mergeResourceKey(inner, '/Font', overlayFontsStr, objCache);
  inner = mergeResourceKey(inner, '/ExtGState', overlayExtGStateStr, objCache);
  // Newline before `>>` so any trailing `%` line-comment in `inner` ends before the close.
  return `<<${inner}\n>>`;
}

/**
 * Returns true if the annot dict at `annotObjNum` is a /Subtype/Link whose
 * destination resolves to a page object that is being dropped.
 *
 * @param {number} annotObjNum
 * @param {import('../../pdf/parsePdfUtils.js').ObjectCache} objCache
 * @param {Set<number>} keptPageObjNums
 */
function annotLinkTargetsDroppedPage(annotObjNum, objCache, keptPageObjNums) {
  const annotText = objCache.getObjectText(annotObjNum);
  if (!annotText) return false;
  if (!/\/Subtype\s*\/Link\b/.test(annotText)) return false;

  const destArrayPage = (arrText) => {
    const m = /^\s*\[\s*(\d+)\s+\d+\s+R\b/.exec(arrText);
    return m ? Number(m[1]) : null;
  };

  // Resolve a /Dest or /D value to its target page object number,
  // following indirect refs to a destination array
  // (e.g. `/Dest 600 0 R` where obj 600 is `[596 0 R /XYZ ...]`).
  // Named destinations are not resolved here; they live in the catalog's /Dests or /Names tree
  // and our current scope is to drop annots whose target is *known* to be a dropped page.
  const resolveTargetPage = (annotBody, key) => {
    const inlineArr = new RegExp(`/${key}\\s*(\\[[\\s\\S]*?\\])`).exec(annotBody);
    if (inlineArr) return destArrayPage(inlineArr[1]);
    const indirectRef = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(annotBody);
    if (indirectRef) {
      const targetText = objCache.getObjectText(Number(indirectRef[1]));
      if (targetText) return destArrayPage(targetText);
    }
    return null;
  };

  const directDestPage = resolveTargetPage(annotText, 'Dest');
  if (directDestPage != null) return !keptPageObjNums.has(directDestPage);

  // /A action: indirect ref or inline dict. Either way we need the action's /D.
  let actionText = null;
  const actionRefMatch = /\/A\s+(\d+)\s+\d+\s+R/.exec(annotText);
  if (actionRefMatch) {
    actionText = objCache.getObjectText(Number(actionRefMatch[1]));
  } else {
    const inlineActionMatch = /\/A\s*<<([\s\S]*?)>>/.exec(annotText);
    if (inlineActionMatch) actionText = inlineActionMatch[1];
  }
  if (actionText) {
    if (!/\/S\s*\/GoTo\b/.test(actionText)) return false;
    const actionDestPage = resolveTargetPage(actionText, 'D');
    if (actionDestPage != null) return !keptPageObjNums.has(actionDestPage);
  }

  return false;
}

/**
 * Rewrite a page dict's /Annots entry to drop link annotations whose
 * destination resolves to a page that is being dropped.
 * Resolves indirect /Annots arrays by inlining them.
 * No-op when /Annots is absent or all link targets are kept.
 *
 * @param {string} pageText
 * @param {import('../../pdf/parsePdfUtils.js').ObjectCache} objCache
 * @param {Set<number>} keptPageObjNums
 */
function dropOrphanLinkAnnots(pageText, objCache, keptPageObjNums) {
  const arrayMatch = /\/Annots\s*\[([\s\S]*?)\]/.exec(pageText);
  const indirectMatch = arrayMatch ? null : /\/Annots\s+(\d+)\s+\d+\s+R/.exec(pageText);

  /** @type {string[]} */
  const refs = [];
  if (arrayMatch) {
    for (const m of arrayMatch[1].matchAll(/(\d+\s+\d+\s+R)/g)) refs.push(m[1]);
  } else if (indirectMatch) {
    const arrayText = objCache.getObjectText(Number(indirectMatch[1]));
    if (!arrayText) return pageText;
    for (const m of arrayText.matchAll(/(\d+\s+\d+\s+R)/g)) refs.push(m[1]);
  } else {
    return pageText;
  }

  const filtered = refs.filter((ref) => {
    const m = /^(\d+)\s+\d+\s+R$/.exec(ref);
    if (!m) return true;
    return !annotLinkTargetsDroppedPage(Number(m[1]), objCache, keptPageObjNums);
  });
  if (filtered.length === refs.length && arrayMatch) return pageText;

  const replacement = filtered.length > 0 ? `/Annots[${filtered.join(' ')}]` : '';
  if (arrayMatch) {
    return pageText.slice(0, arrayMatch.index) + replacement + pageText.slice(arrayMatch.index + arrayMatch[0].length);
  }
  // indirectMatch: replace the indirect ref with an inline (possibly empty) array
  return pageText.slice(0, indirectMatch.index) + replacement + pageText.slice(indirectMatch.index + indirectMatch[0].length);
}

/**
 * Rebuild a /Page dict with overlay additions.
 *
 * @param {number} objNum
 * @param {string} originalObjText
 * @param {string[]|null} newContentsArray - New /Contents refs. If null,
 *   preserve the original /Contents (used for the annotation-only path
 *   where no overlay content stream is being added).
 * @param {number|null} resourcesObjNum - New /Resources object number. If
 *   null, preserve the original /Resources entry verbatim.
 * @param {number|null} [parentObjNum=null]
 * @param {string[]} [extraAnnotRefs=[]] - Additional `N 0 R` refs to
 *   append to the merged /Annots array.
 * @param {import('../../pdf/parsePdfUtils.js').ObjectCache|null} [objCache=null]
 *   Used to resolve an indirect /Annots array so source refs can be
 *   inlined alongside new user-added refs.
 * @param {?Set<number>} [keptPageObjNums=null] - When non-null (subset rebuild),
 *   filter out source link annotations whose destination page is not in this set.
 */
function buildReplacementPageDict(objNum, originalObjText, newContentsArray, resourcesObjNum, parentObjNum = null, extraAnnotRefs = [], objCache = null, keptPageObjNums = null) {
  let dictStr = `${objNum} 0 obj\n<<`;
  dictStr += '/Type/Page';

  // Copy or override /Parent
  if (parentObjNum !== null) {
    dictStr += `/Parent ${parentObjNum} 0 R`;
  } else {
    const parentMatch = /\/Parent\s+(\d+\s+\d+\s+R)/.exec(originalObjText);
    if (parentMatch) dictStr += `/Parent ${parentMatch[1]}`;
  }

  // Copy /MediaBox
  const mbMatch = /\/MediaBox\s*\[\s*([\d.+\-e\s]+)\s*\]/.exec(originalObjText);
  if (mbMatch) dictStr += `/MediaBox[${mbMatch[1].trim()}]`;

  // Copy /CropBox if present
  const cbMatch = /\/CropBox\s*\[\s*([\d.+\-e\s]+)\s*\]/.exec(originalObjText);
  if (cbMatch) dictStr += `/CropBox[${cbMatch[1].trim()}]`;

  // Copy /Rotate if present
  const rotMatch = /\/Rotate\s+(\d+)/.exec(originalObjText);
  if (rotMatch) dictStr += `/Rotate ${rotMatch[1]}`;

  // Merge source /Annots with extraAnnotRefs (new user-added highlights).
  // When no extras are supplied we emit the source array verbatim so
  // pass-through annotations (links, notes, form widgets) survive unchanged.
  const annotsIndirectMatch = /\/Annots\s+(\d+)\s+\d+\s+R/.exec(originalObjText);
  const annotsArrayMatch = /\/Annots\s*\[([\s\S]*?)\]/.exec(originalObjText);
  let sourceAnnotRefs = [];
  if (annotsIndirectMatch && objCache) {
    const arrayText = objCache.getObjectText(Number(annotsIndirectMatch[1]));
    if (arrayText) {
      for (const m of arrayText.matchAll(/(\d+\s+\d+\s+R)/g)) sourceAnnotRefs.push(m[1]);
    }
  } else if (annotsArrayMatch) {
    for (const m of annotsArrayMatch[1].matchAll(/(\d+\s+\d+\s+R)/g)) sourceAnnotRefs.push(m[1]);
  }
  if (keptPageObjNums && objCache) {
    sourceAnnotRefs = sourceAnnotRefs.filter((ref) => {
      const m = /^(\d+)\s+\d+\s+R$/.exec(ref);
      if (!m) return true;
      return !annotLinkTargetsDroppedPage(Number(m[1]), objCache, keptPageObjNums);
    });
  }
  if (extraAnnotRefs.length > 0 || sourceAnnotRefs.length > 0) {
    if (extraAnnotRefs.length === 0 && annotsIndirectMatch && !objCache) {
      dictStr += `/Annots ${annotsIndirectMatch[0].slice('/Annots'.length).trim()}`;
    } else {
      dictStr += `/Annots[${[...sourceAnnotRefs, ...extraAnnotRefs].join(' ')}]`;
    }
  }

  // Copy /StructParents if present
  const spMatch = /\/StructParents\s+(\d+)/.exec(originalObjText);
  if (spMatch) dictStr += `/StructParents ${spMatch[1]}`;

  // Copy /Tabs if present
  const tabsMatch = /\/Tabs\s*\/(\w+)/.exec(originalObjText);
  if (tabsMatch) dictStr += `/Tabs/${tabsMatch[1]}`;

  // Copy /UserUnit if present
  const uuMatch = /\/UserUnit\s+([\d.]+)/.exec(originalObjText);
  if (uuMatch) dictStr += `/UserUnit ${uuMatch[1]}`;

  // /Contents: new array or preserved original
  if (newContentsArray !== null) {
    dictStr += `/Contents[${newContentsArray.join(' ')}]`;
  } else {
    const contentsArrMatch = /\/Contents\s*\[([\s\S]*?)\]/.exec(originalObjText);
    const contentsRefMatch = /\/Contents\s+(\d+\s+\d+\s+R)/.exec(originalObjText);
    if (contentsArrMatch) dictStr += `/Contents[${contentsArrMatch[1].trim()}]`;
    else if (contentsRefMatch) dictStr += `/Contents ${contentsRefMatch[1]}`;
  }

  // /Resources: new reference or preserved original (ref or inline dict)
  if (resourcesObjNum !== null) {
    dictStr += `/Resources ${resourcesObjNum} 0 R`;
  } else {
    const resRefMatch = /\/Resources\s+(\d+\s+\d+\s+R)/.exec(originalObjText);
    if (resRefMatch) {
      dictStr += `/Resources ${resRefMatch[1]}`;
    } else {
      const resInlineMatch = /\/Resources\s*<</.exec(originalObjText);
      if (resInlineMatch) {
        const dictStart = resInlineMatch.index + resInlineMatch[0].length - 2;
        dictStr += `/Resources${extractDict(originalObjText, dictStart)}`;
      }
    }
  }

  dictStr += '>>\nendobj\n\n';
  return dictStr;
}

/**
 * Walk a page's content streams and collect the names actually invoked by
 * Tf (fonts), Do (xobjects), and gs (ext-gstate) operators.
 * Only these three operators are walked — other resource-name operators
 * (cs/CS/scn/SCN/sh/BMC/BDC) are context-sensitive and intentionally skipped.
 * @param {string} pageObjText
 * @param {ObjectCache} objCache
 */
function collectUsedResourceNames(pageObjText, objCache) {
  const usedFonts = new Set();
  const usedXObjects = new Set();
  const usedExtGStates = new Set();

  /**
   * Map a /XObject resource name on the page to the underlying object number.
   * Returns null when the page's /XObject dict is absent or the name isn't defined.
   * @param {string} name e.g. '/R12'
   */
  const resolvePageXObjectName = (name) => {
    const resolvedRes = resolvePageResources(pageObjText, objCache);
    const xobjMatch = /\/XObject\s*(?:<<([\s\S]*?)>>|(\d+)\s+\d+\s+R)/.exec(resolvedRes);
    if (!xobjMatch) return null;
    let xobjBody = xobjMatch[1];
    if (!xobjBody && xobjMatch[2]) {
      const indirectText = objCache.getObjectText(Number(xobjMatch[2]));
      if (!indirectText) return null;
      xobjBody = indirectText;
    }
    if (!xobjBody) return null;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`${escaped}\\s+(\\d+)\\s+\\d+\\s+R`);
    const m = re.exec(xobjBody);
    return m ? Number(m[1]) : null;
  };

  /** @param {string} streamText */
  const walk = (streamText, onXObject) => {
    const tokens = tokenizeContentStream(streamText);
    let lastName = null;
    for (const tok of tokens) {
      if (tok.type === 'name') { lastName = tok.value; continue; }
      if (tok.type === 'operator') {
        if (lastName !== null) {
          if (tok.value === 'Tf') usedFonts.add(lastName);
          else if (tok.value === 'Do') {
            usedXObjects.add(lastName);
            if (onXObject) onXObject(lastName);
          } else if (tok.value === 'gs') usedExtGStates.add(lastName);
        }
        lastName = null;
        continue;
      }
      if (tok.type === 'number') continue;
      lastName = null;
    }
  };

  // Form XObjects whose content streams reference resources by name resolve those
  // names via their own /Resources first, then fall through to the page's /Resources
  // (PDF 32000-1:2008 §7.8.3). Walk used Form XObjects recursively so fall-through
  // names get included — otherwise pruning drops resources the page actually needs.
  const visited = new Set();
  /** @param {string} xobjName */
  const recurseForm = (xobjName) => {
    const objNum = resolvePageXObjectName(xobjName);
    if (objNum == null || visited.has(objNum)) return;
    visited.add(objNum);
    const xobjText = objCache.getObjectText(objNum);
    if (!xobjText || !/\/Subtype\s*\/Form\b/.test(xobjText)) return;
    let formStreamBytes;
    try { formStreamBytes = objCache.getStreamBytes(objNum); } catch { formStreamBytes = null; }
    if (!formStreamBytes) return;
    walk(bytesToLatin1(formStreamBytes), recurseForm);
  };

  const streams = getPageContentStreams(pageObjText, objCache);
  if (!streams) return { usedFonts, usedXObjects, usedExtGStates };
  // A page's multiple content streams are interpreted as concatenated.
  // Walking them separately drops a name/operator pair when the split lands between them
  // (e.g. `/Fm1` at end of one stream, `Do` at start of the next),
  // causing /Fm1 to look unused and get pruned.
  walk(streams.join('\n'), recurseForm);

  return { usedFonts, usedXObjects, usedExtGStates };
}

/**
 * Parse the top-level name→value entries of a PDF dict body.
 * @param {string} dictBody - The inner text of a dict (no outer << >>)
 */
function parseDictEntries(dictBody) {
  const entries = [];
  const len = dictBody.length;
  let i = 0;

  while (i < len) {
    while (i < len && /\s/.test(dictBody[i])) i++;
    if (i >= len) break;
    if (dictBody[i] !== '/') { i++; continue; }
    i++;
    let name = '';
    while (i < len && !/[\s/<>[\](){}%]/.test(dictBody[i])) { name += dictBody[i]; i++; }
    while (i < len && /\s/.test(dictBody[i])) i++;
    if (i >= len) break;

    const valueStart = i;
    const ch = dictBody[i];
    if (ch === '<' && dictBody[i + 1] === '<') {
      const sub = extractDict(dictBody, i);
      i += sub.length;
    } else if (ch === '[') {
      let depth = 1; i++;
      while (i < len && depth > 0) {
        if (dictBody[i] === '[') depth++;
        else if (dictBody[i] === ']') depth--;
        i++;
      }
    } else if (ch === '(') {
      let depth = 1; i++;
      while (i < len && depth > 0) {
        if (dictBody[i] === '\\') { i += 2; continue; }
        if (dictBody[i] === '(') depth++;
        else if (dictBody[i] === ')') depth--;
        i++;
      }
    } else if (ch === '<') {
      while (i < len && dictBody[i] !== '>') i++;
      if (i < len) i++;
    } else if (ch === '/') {
      i++;
      while (i < len && !/[\s/<>[\](){}%]/.test(dictBody[i])) i++;
    } else {
      const indirectMatch = /^(\d+)\s+(\d+)\s+R/.exec(dictBody.slice(i));
      if (indirectMatch) {
        i += indirectMatch[0].length;
      } else {
        while (i < len && !/[\s/<>[\]]/.test(dictBody[i])) i++;
      }
    }
    entries.push({ name, valueText: dictBody.slice(valueStart, i) });
  }

  return entries;
}

/**
 * Resolve a /Subtype subdict inside a resources dict — returns its inner body
 * (between << and >>). Handles both inline `/Font <<...>>` and indirect
 * `/Font N M R`. Returns null if the subdict is missing or malformed.
 * @param {string} resourcesDictBody
 * @param {string} key
 * @param {ObjectCache} objCache
 */
function locateResourceSubdict(resourcesDictBody, key, objCache) {
  const keyIdx = resourcesDictBody.indexOf(key);
  if (keyIdx < 0) return null;
  let i = keyIdx + key.length;
  while (i < resourcesDictBody.length && /\s/.test(resourcesDictBody[i])) i++;

  if (resourcesDictBody[i] === '<' && resourcesDictBody[i + 1] === '<') {
    const full = extractDict(resourcesDictBody, i);
    return {
      body: full.slice(2, -2),
      original: resourcesDictBody.slice(keyIdx, i + full.length),
      startInBody: keyIdx,
      endInBody: i + full.length,
    };
  }
  const refMatch = /^(\d+)\s+\d+\s+R/.exec(resourcesDictBody.slice(i));
  if (refMatch) {
    const refObjNum = Number(refMatch[1]);
    const refText = objCache.getObjectText(refObjNum);
    if (!refText) return null;
    const dictStart = refText.indexOf('<<');
    if (dictStart < 0) return null;
    const full = extractDict(refText, dictStart);
    return {
      body: full.slice(2, -2),
      original: resourcesDictBody.slice(keyIdx, i + refMatch[0].length),
      startInBody: keyIdx,
      endInBody: i + refMatch[0].length,
    };
  }
  return null;
}

/**
 * Given a /Resources dict text (full, with outer << >>) and sets of names
 * actually used by a page's content streams, return a new /Resources dict
 * where /Font, /XObject, and /ExtGState entries are pruned to only the used
 * names. Other subdicts pass through unchanged.
 * @param {string} resourcesDictText - Full /Resources dict including outer << >>
 * @param {{usedFonts: Set<string>, usedXObjects: Set<string>, usedExtGStates: Set<string>}} used
 * @param {ObjectCache} objCache
 */
function pruneResourcesDict(resourcesDictText, used, objCache) {
  if (!resourcesDictText.startsWith('<<') || !resourcesDictText.endsWith('>>')) {
    return resourcesDictText;
  }
  let body = resourcesDictText.slice(2, -2);

  /** @type {(key: string, usedSet: Set<string>) => void} */
  const pruneOne = (key, usedSet) => {
    const loc = locateResourceSubdict(body, key, objCache);
    if (!loc) return;
    const entries = parseDictEntries(loc.body);
    const kept = entries.filter((e) => usedSet.has(e.name));
    let replacement;
    if (kept.length === 0) {
      replacement = '';
    } else {
      const inner = kept.map((e) => `/${e.name} ${e.valueText}`).join(' ');
      replacement = `${key}<<${inner}>>`;
    }
    body = body.slice(0, loc.startInBody) + replacement + body.slice(loc.endInBody);
  };

  pruneOne('/Font', used.usedFonts);
  pruneOne('/XObject', used.usedXObjects);
  pruneOne('/ExtGState', used.usedExtGStates);

  return `<<${body}>>`;
}

/**
 * Replace the page dict's /Resources entry with the given inline dict text.
 * Handles inline, indirect, and absent /Resources forms.
 * @param {string} pageObjText
 * @param {string} newResourcesDictText
 */
function replacePageResources(pageObjText, newResourcesDictText) {
  const resIdx = pageObjText.indexOf('/Resources');
  if (resIdx < 0) {
    const insertPos = pageObjText.lastIndexOf('>>');
    if (insertPos < 0) return pageObjText;
    return `${pageObjText.slice(0, insertPos)}/Resources ${newResourcesDictText}${pageObjText.slice(insertPos)}`;
  }
  let afterKey = resIdx + '/Resources'.length;
  while (afterKey < pageObjText.length && /\s/.test(pageObjText[afterKey])) afterKey++;
  if (pageObjText[afterKey] === '<' && pageObjText[afterKey + 1] === '<') {
    const full = extractDict(pageObjText, afterKey);
    return `${pageObjText.slice(0, resIdx)}/Resources ${newResourcesDictText}${pageObjText.slice(afterKey + full.length)}`;
  }
  const refMatch = /^(\d+)\s+(\d+)\s+R/.exec(pageObjText.slice(afterKey));
  if (refMatch) {
    return `${pageObjText.slice(0, resIdx)}/Resources ${newResourcesDictText}${pageObjText.slice(afterKey + refMatch[0].length)}`;
  }
  return pageObjText;
}

/**
 * Rebuild a PDF containing only the selected pages, optionally with OCR
 * overlay text. Used instead of incremental update when exporting a proper
 * subset of pages. Unreferenced objects are excluded to reduce file size.
 * @param {Object} params
 * @param {Uint8Array} params.pdfBytes
 * @param {string} params.text
 * @param {ObjectCache} params.objCache
 * @param {Object} params.xrefEntries
 * @param {any[]} params.pages
 * @param {number[]} params.pageIndices
 * @param {number} params.startingNextObjNum
 * @param {any[]} [params.ocrArr]
 * @param {any[]} [params.pageMetricsArr]
 * @param {*} [params.pdfFonts]
 * @param {string} [params.textMode]
 * @param {boolean} [params.rotateText]
 * @param {boolean} [params.rotateBackground]
 * @param {number} [params.confThreshHigh]
 * @param {number} [params.confThreshMed]
 * @param {number} [params.proofOpacity]
 * @param {boolean} [params.humanReadable=false]
 * @param {Array<Array<AnnotationHighlight>>} [params.annotationsPages=[]]
 */
async function rebuildPdfSubset({
  pdfBytes, text, objCache, xrefEntries, pages,
  pageIndices, startingNextObjNum,
  ocrArr, pageMetricsArr, pdfFonts,
  textMode, rotateText, rotateBackground,
  confThreshHigh, confThreshMed, proofOpacity,
  humanReadable = false,
  annotationsPages = [],
}) {
  const overlayEnabled = !!(ocrArr && pageMetricsArr && pdfFonts);
  let nextObjNum = startingNextObjNum;

  const { pageTreeObjNums } = collectPageTreeObjNums(objCache);

  /** @type {Set<number>} */
  const keptPageObjNums = new Set();
  for (const i of pageIndices) {
    if (i >= 0 && i < pages.length) keptPageObjNums.add(pages[i].objNum);
  }

  // Assign new object numbers for catalog and pages root
  const catalogObjNum = nextObjNum++;
  const pagesRootObjNum = nextObjNum++;

  /** @type {Set<PdfFontInfo>} */
  const pdfFontsUsed = new Set();

  /** @type {Array<{objNum: number, content: string | Uint8Array | import('./writePdfStreams.js').PdfBinaryObject}>} */
  const allOutputObjects = [];

  /** @type {Set<number>} */
  const modifiedPageObjNums = new Set();

  // Generate overlay content for each kept page that has OCR data (only if overlay enabled)
  if (overlayEnabled) {
    for (const i of pageIndices) {
      if (i >= pages.length) continue;

      const pageInfo = pages[i];
      const pageObj = ocrArr?.[i];
      const pixelDims = pageMetricsArr[i].dims;
      const pageAnnotations = annotationsPages[i] || [];

      // pixelDims is the rasterised CropBox region; scale and translate the overlay relative
      // to CropBox so it lands inside the visible area on pages where MediaBox is larger.
      const overlayBox = pageInfo.cropBox || pageInfo.mediaBox;
      const baseWidth = overlayBox[2] - overlayBox[0];
      const baseHeight = overlayBox[3] - overlayBox[1];
      const scaleX = pixelDims ? baseWidth / pixelDims.width : 1;
      const scaleY = pixelDims ? baseHeight / pixelDims.height : 1;
      const tx = overlayBox[0];
      const ty = overlayBox[1];

      let textContentObjStr = '';
      /** @type {Set<PdfFontInfo>} */
      let pageFontsUsed = new Set();
      if (pageObj && pageObj.lines.length > 0 && textMode !== 'annot') {
        const angle = pageMetricsArr[i].angle || 0;
        const res = await ocrPageToPDFStream(
          pageObj, pixelDims, pdfFonts, /** @type {'ebook'|'eval'|'proof'|'invis'} */ (textMode), angle,
          rotateText, rotateBackground, confThreshHigh, confThreshMed,
        );
        textContentObjStr = res.textContentObjStr || '';
        pageFontsUsed = res.pdfFontsUsed;
      }

      const hasText = textContentObjStr && textContentObjStr.length > 0;
      const hasAnnots = pageAnnotations.length > 0;
      if (!hasText && !hasAnnots) continue;

      /** @type {string[]|null} */
      let newContentsArray = null;
      /** @type {number|null} */
      let resourcesObjNum = null;

      if (hasText) {
        for (const font of pageFontsUsed) pdfFontsUsed.add(font);

        const qSaveStr = 'q\n';
        const qSaveObjNum = nextObjNum++;
        allOutputObjects.push({ objNum: qSaveObjNum, content: `${qSaveObjNum} 0 obj\n<</Length ${qSaveStr.length}>>\nstream\n${qSaveStr}endstream\nendobj\n\n` });

        const qOverlayStr = `Q\nq ${scaleX} 0 0 ${scaleY} ${tx} ${ty} cm\n${textContentObjStr}Q\n`;
        const qOverlayObjNum = nextObjNum++;
        allOutputObjects.push({ objNum: qOverlayObjNum, content: await encodeStreamObject(qOverlayObjNum, qOverlayStr, { humanReadable }) });

        const existingContentsRefs = parseExistingContents(pageInfo.objText, objCache);
        const strippedContentsRefs = await rewriteContentsStrippingInvisibleText(
          existingContentsRefs,
          objCache,
          () => nextObjNum++,
          (obj) => allOutputObjects.push(obj),
          humanReadable,
        );
        newContentsArray = [
          `${qSaveObjNum} 0 R`,
          ...strippedContentsRefs,
          `${qOverlayObjNum} 0 R`,
        ];

        const existingResourcesStr = resolvePageResources(pageInfo.objText, objCache);
        let overlayFontsStr = '';
        for (const font of pageFontsUsed) {
          overlayFontsStr += `${font.name} ${font.objN} 0 R\n`;
        }
        const overlayExtGStateStr = `/GSO0 <</ca 0.0>>/GSO1 <</ca ${proofOpacity}>>`;
        const mergedResourcesStr = mergeResources(existingResourcesStr, overlayFontsStr, overlayExtGStateStr, objCache);

        resourcesObjNum = nextObjNum++;
        allOutputObjects.push({ objNum: resourcesObjNum, content: `${resourcesObjNum} 0 obj\n${mergedResourcesStr}\nendobj\n\n` });
      }

      /** @type {string[]} */
      let extraAnnotRefs = [];
      if (hasAnnots) {
        const consolidated = consolidateAnnotations(pageAnnotations, pageObj);
        const pageForEmit = consolidated.length > 0 ? consolidated : pageAnnotations;
        const transformed = pageForEmit.map((a) => overlayAnnotationBbox(a, scaleX, scaleY, tx, ty));
        const outputDims = { width: baseWidth, height: baseHeight };
        const { objectTexts, annotRefs } = buildHighlightAnnotObjects(transformed, nextObjNum, outputDims);
        for (const t of objectTexts) allOutputObjects.push({ objNum: nextObjNum++, content: t });
        extraAnnotRefs = annotRefs;
      }

      const newPageObj = buildReplacementPageDict(pageInfo.objNum, pageInfo.objText, newContentsArray, resourcesObjNum, pagesRootObjNum,
        extraAnnotRefs, objCache, keptPageObjNums);
      allOutputObjects.push({ objNum: pageInfo.objNum, content: newPageObj });
      modifiedPageObjNums.add(pageInfo.objNum);
    }

    for (const pdfFont of pdfFontsUsed) {
      const objStrArr = await createEmbeddedFontType0({ font: pdfFont.opentype, firstObjIndex: pdfFont.objN, humanReadable });
      for (let j = 0; j < objStrArr.length; j++) {
        allOutputObjects.push({ objNum: pdfFont.objN + j, content: objStrArr[j] });
      }
    }
  }

  /** @type {Map<number, string>} */
  const rewrittenPageTexts = new Map();
  for (const i of pageIndices) {
    if (i >= pages.length) continue;
    const pageInfo = pages[i];
    if (modifiedPageObjNums.has(pageInfo.objNum)) continue;

    let pageText = pageInfo.objText;

    if (/\/Parent\s+\d+\s+\d+\s+R/.test(pageText)) {
      pageText = pageText.replace(/\/Parent\s+\d+\s+\d+\s+R/, `/Parent ${pagesRootObjNum} 0 R`);
    }

    const resolvedRes = resolvePageResources(pageInfo.objText, objCache);
    const used = collectUsedResourceNames(pageInfo.objText, objCache);
    const prunedRes = pruneResourcesDict(resolvedRes, used, objCache);
    pageText = replacePageResources(pageText, prunedRes);
    pageText = dropOrphanLinkAnnots(pageText, objCache, keptPageObjNums);

    rewrittenPageTexts.set(pageInfo.objNum, pageText);
    allOutputObjects.push({ objNum: pageInfo.objNum, content: `${pageInfo.objNum} 0 obj\n${pageText}\nendobj\n\n` });
  }

  const tracingTexts = [];
  for (const i of pageIndices) {
    if (i >= pages.length) continue;
    const rewritten = rewrittenPageTexts.get(pages[i].objNum);
    tracingTexts.push(rewritten || pages[i].objText);
  }
  const referencedObjNums = traceReferencedObjects(tracingTexts, objCache, pageTreeObjNums);

  for (const i of pageIndices) {
    if (i >= pages.length) continue;
    referencedObjNums.delete(pages[i].objNum);
  }
  for (const obj of allOutputObjects) {
    referencedObjNums.delete(obj.objNum);
  }

  for (const objNum of referencedObjNums) {
    const entry = xrefEntries[objNum];
    if (!entry) continue;

    if (entry.type === 1) {
      const rawCopy = copyRawObjectBytes(pdfBytes, text, objCache, entry, objNum);
      if (!rawCopy) continue;
      allOutputObjects.push({ objNum, content: rawCopy });
    } else if (entry.type === 2) {
      // ObjStm object: write as standalone
      const objText = objCache.getObjectText(objNum);
      if (!objText) continue;
      allOutputObjects.push({ objNum, content: `${objNum} 0 obj\n${objText}\nendobj\n\n` });
    }
  }

  const keptPageRefs = [];
  for (const i of pageIndices) {
    if (i >= pages.length) continue;
    keptPageRefs.push(`${pages[i].objNum} 0 R`);
  }

  allOutputObjects.push({ objNum: catalogObjNum, content: `${catalogObjNum} 0 obj\n<</Type/Catalog/Pages ${pagesRootObjNum} 0 R>>\nendobj\n\n` });
  allOutputObjects.push({ objNum: pagesRootObjNum, content: `${pagesRootObjNum} 0 obj\n<</Type/Pages/Kids[${keptPageRefs.join(' ')}]/Count ${keptPageRefs.length}>>\nendobj\n\n` });

  // Build the new PDF
  const pdfHeader = '%PDF-1.7\n';
  /** @type {(string | Uint8Array)[]} */
  const parts = [pdfHeader];
  let byteLen = pdfHeader.length;

  const xrefEntryList = [];

  for (const obj of allOutputObjects) {
    xrefEntryList.push({ objNum: obj.objNum, offset: byteLen });
    const c = obj.content;
    if (typeof c === 'string') {
      parts.push(c);
      byteLen += c.length;
    } else if (c instanceof Uint8Array) {
      // Raw byte copy of original PDF object
      parts.push(c);
      byteLen += c.length;
    } else {
      // PdfBinaryObject: header + streamData + trailer
      parts.push(c.header);
      byteLen += c.header.length;
      parts.push(c.streamData);
      byteLen += c.streamData.length;
      parts.push(c.trailer);
      byteLen += c.trailer.length;
    }
  }

  const newXrefOffset = byteLen;
  const totalSize = Math.max(nextObjNum, ...allOutputObjects.map((o) => o.objNum + 1));
  const xrefStr = buildFullXrefAndTrailer(xrefEntryList, totalSize, `${catalogObjNum} 0 R`, newXrefOffset);
  parts.push(xrefStr);
  byteLen += xrefStr.length;

  // Concatenate all parts into a single byte array
  const result = new Uint8Array(byteLen);
  let writeOffset = 0;
  for (const part of parts) {
    if (typeof part === 'string') {
      for (let ci = 0; ci < part.length; ci++) {
        result[writeOffset++] = part.charCodeAt(ci);
      }
    } else {
      result.set(part, writeOffset);
      writeOffset += part.length;
    }
  }

  return result.buffer;
}

/**
 * Produce a new PDF containing only the specified pages of the input PDF.
 *
 * @param {ArrayBuffer | Uint8Array} basePdfData
 * @param {number[]} pageIndices
 */
export async function subsetPdf(basePdfData, pageIndices) {
  const pdfBytes = basePdfData instanceof Uint8Array ? basePdfData : new Uint8Array(basePdfData);
  const text = new TextDecoder('latin1').decode(pdfBytes);

  const xrefOffset = findXrefOffset(pdfBytes);
  const xrefEntries = parseXref(pdfBytes, xrefOffset);
  const objCache = new ObjectCache(pdfBytes, xrefEntries);
  const pages = getPageObjects(objCache);

  if (pageIndices.length === 0) throw new Error('subsetPdf: pageIndices is empty');
  for (const i of pageIndices) {
    if (!Number.isInteger(i) || i < 0 || i >= pages.length) {
      throw new RangeError(`subsetPdf: page ${i} out of range (0-${pages.length - 1})`);
    }
  }

  const startingNextObjNum = Math.max(...Object.keys(xrefEntries).map(Number)) + 1;

  return rebuildPdfSubset({
    pdfBytes,
    text,
    objCache,
    xrefEntries,
    pages,
    pageIndices,
    startingNextObjNum,
  });
}

/**
 * Transform a pixel-space AnnotationHighlight bbox into the coordinate frame the overlay's page uses.
 *
 * @param {AnnotationHighlight} annot
 * @param {number} scaleX
 * @param {number} scaleY
 * @param {number} tx
 * @param {number} ty
 * @returns {AnnotationHighlight}
 */
function overlayAnnotationBbox(annot, scaleX, scaleY, tx, ty) {
  const transformBbox = (b) => ({
    left: b.left * scaleX + tx,
    right: b.right * scaleX + tx,
    top: b.top * scaleY - ty,
    bottom: b.bottom * scaleY - ty,
  });
  const out = {
    ...annot,
    bbox: transformBbox(annot.bbox),
  };
  if (annot.quads) out.quads = annot.quads.map(transformBbox);
  return out;
}

/**
 * Insert OCR text layers into an existing PDF via incremental update, or
 * rebuild with a subset/reordering of pages when `pageArr` demands it.
 * In incremental mode the original PDF bytes are not modified; new objects
 * are appended after %%EOF.
 *
 * @param {Object} params
 * @param {ArrayBuffer} params.basePdfData - The original PDF bytes
 * @param {Array<OcrPage>} params.ocrArr - OCR data for each page (indexed to match `basePdfData`)
 * @param {Array<PageMetrics>} params.pageMetricsArr - Page metrics (dims in pixels)
 * @param {?Array<number>} [params.pageArr=null] - 0-based page indices into `basePdfData` to include. Defaults to all pages.
 * @param {("ebook"|"eval"|"proof"|"invis"|"annot")} [params.textMode="invis"]
 * @param {boolean} [params.rotateText=true]
 * @param {boolean} [params.rotateBackground=false]
 * @param {number} [params.confThreshHigh=85]
 * @param {number} [params.confThreshMed=75]
 * @param {number} [params.proofOpacity=0.8]
 * @param {boolean} [params.humanReadable=false]
 * @param {Array<Array<AnnotationHighlight>>} [params.annotationsPages=[]] - Per-page annotation arrays
 * @returns {Promise<ArrayBuffer>}
 */
export async function overlayPdfText({
  basePdfData,
  ocrArr,
  pageMetricsArr,
  pageArr = null,
  textMode = 'invis',
  rotateText = true,
  rotateBackground = false,
  confThreshHigh = 85,
  confThreshMed = 75,
  proofOpacity = 0.8,
  humanReadable = false,
  annotationsPages = [],
}) {
  const pdfBytes = new Uint8Array(basePdfData);
  // Local latin1 view used by overlayPdfText's downstream helpers.
  const text = new TextDecoder('latin1').decode(pdfBytes);

  // Step 1: Parse the base PDF structure
  const xrefOffset = findXrefOffset(pdfBytes);
  const xrefEntries = parseXref(pdfBytes, xrefOffset);
  const objCache = new ObjectCache(pdfBytes, xrefEntries);
  const pages = getPageObjects(objCache);
  const { rootRef } = parseTrailerInfo(text, xrefOffset);

  // Default to all pages in the source PDF when pageArr is not supplied.
  const effectivePageArr = pageArr
    ? pageArr.filter((i) => i >= 0 && i < pages.length)
    : Array.from({ length: pages.length }, (_, i) => i);

  // Step 2: Determine next available object number
  let nextObjNum = Math.max(...Object.keys(xrefEntries).map(Number)) + 1;

  // Step 3: Create font references starting at nextObjNum
  const fontRefs = await createPdfFontRefs(nextObjNum, ocrArr);
  const { pdfFonts } = fontRefs;
  nextObjNum = fontRefs.objectI;

  // Incremental update appends new objects but leaves the source's trailer chain in
  // place. For encrypted sources that means /Encrypt stays active and readers will
  // try to decrypt the unencrypted overlay objects with the file key, garbling them.
  // Rebuild from scratch (dropping /Encrypt) to keep the output consistently plain.
  const sourceEncrypted = !!objCache.encryptionKey;

  // Incremental update keeps the source's bytes (including its malformed startxref/trailer) in place.
  // Only rebuild can give the output a clean xref.
  const sourceXrefMalformed = !sourceXrefIsWellFormed(pdfBytes);

  // If exporting a proper subset of pages (fewer pages than the source, or
  // a reordering), rebuild the PDF instead of incremental update.
  // Incremental can only extend existing pages in place — it can't drop or reorder them.
  const isSubset = effectivePageArr.length !== pages.length
    || effectivePageArr.some((v, idx) => v !== idx);
  if (isSubset || sourceEncrypted || sourceXrefMalformed) {
    return rebuildPdfSubset({
      pdfBytes,
      text,
      objCache,
      xrefEntries,
      pages,
      pageIndices: effectivePageArr,
      ocrArr,
      pageMetricsArr,
      textMode,
      rotateText,
      rotateBackground,
      confThreshHigh,
      confThreshMed,
      proofOpacity,
      pdfFonts,
      startingNextObjNum: nextObjNum,
      humanReadable,
      annotationsPages,
    });
  }

  /** @type {Set<PdfFontInfo>} */
  const pdfFontsUsed = new Set();

  // All new objects to append (font objects are added later)
  /** @type {Array<{objNum: number, content: string}>} */
  const newObjects = [];

  // Step 4: For each page, generate text content and build modified objects
  for (const i of effectivePageArr) {
    const pageInfo = pages[i];
    const pageObj = ocrArr?.[i];
    const pixelDims = pageMetricsArr[i].dims;
    const pageAnnotations = annotationsPages[i] || [];

    // pixelDims is the rasterised CropBox region; scale and translate the overlay relative
    // to CropBox so it lands inside the visible area on pages where MediaBox is larger.
    const overlayBox = pageInfo.cropBox || pageInfo.mediaBox;
    const baseWidth = overlayBox[2] - overlayBox[0];
    const baseHeight = overlayBox[3] - overlayBox[1];
    const scaleX = pixelDims ? baseWidth / pixelDims.width : 1;
    const scaleY = pixelDims ? baseHeight / pixelDims.height : 1;
    const tx = overlayBox[0];
    const ty = overlayBox[1];

    let textContentObjStr = '';
    /** @type {Set<PdfFontInfo>} */
    let pageFontsUsed = new Set();
    if (pageObj && pageObj.lines.length > 0 && textMode !== 'annot') {
      const angle = pageMetricsArr[i].angle || 0;
      const res = await ocrPageToPDFStream(
        pageObj, pixelDims, pdfFonts, textMode, angle,
        rotateText, rotateBackground, confThreshHigh, confThreshMed,
      );
      textContentObjStr = res.textContentObjStr || '';
      pageFontsUsed = res.pdfFontsUsed;
    }

    const hasText = textContentObjStr && textContentObjStr.length > 0;
    const hasAnnots = pageAnnotations.length > 0;
    if (!hasText && !hasAnnots) continue;

    /** @type {string[]|null} */
    let newContentsArray = null;
    /** @type {number|null} */
    let resourcesObjNum = null;

    if (hasText) {
      for (const font of pageFontsUsed) pdfFontsUsed.add(font);

      const qSaveStr = 'q\n';
      const qSaveObjNum = nextObjNum++;
      newObjects.push({ objNum: qSaveObjNum, content: `${qSaveObjNum} 0 obj\n<</Length ${qSaveStr.length}>>\nstream\n${qSaveStr}endstream\nendobj\n\n` });

      const qOverlayStr = `Q\nq ${scaleX} 0 0 ${scaleY} ${tx} ${ty} cm\n${textContentObjStr}Q\n`;
      const qOverlayObjNum = nextObjNum++;
      newObjects.push({ objNum: qOverlayObjNum, content: await encodeStreamObject(qOverlayObjNum, qOverlayStr, { humanReadable }) });

      const existingContentsRefs = parseExistingContents(pageInfo.objText, objCache);
      const strippedContentsRefs = await rewriteContentsStrippingInvisibleText(
        existingContentsRefs,
        objCache,
        () => nextObjNum++,
        (obj) => newObjects.push(obj),
        humanReadable,
      );
      newContentsArray = [
        `${qSaveObjNum} 0 R`,
        ...strippedContentsRefs,
        `${qOverlayObjNum} 0 R`,
      ];

      // Merge overlay fonts + ExtGState into the page's /Resources.
      const existingResourcesStr = resolvePageResources(pageInfo.objText, objCache);
      let overlayFontsStr = '';
      for (const font of pageFontsUsed) {
        overlayFontsStr += `${font.name} ${font.objN} 0 R\n`;
      }
      const overlayExtGStateStr = `/GSO0 <</ca 0.0>>/GSO1 <</ca ${proofOpacity}>>`;
      const mergedResourcesStr = mergeResources(existingResourcesStr, overlayFontsStr, overlayExtGStateStr, objCache);

      resourcesObjNum = nextObjNum++;
      newObjects.push({ objNum: resourcesObjNum, content: `${resourcesObjNum} 0 obj\n${mergedResourcesStr}\nendobj\n\n` });
    }

    /** @type {string[]} */
    let extraAnnotRefs = [];
    if (hasAnnots) {
      const consolidated = consolidateAnnotations(pageAnnotations, pageObj);
      const pageForEmit = consolidated.length > 0 ? consolidated : pageAnnotations;
      const transformed = pageForEmit.map((a) => overlayAnnotationBbox(a, scaleX, scaleY, tx, ty));
      const outputDims = { width: baseWidth, height: baseHeight };
      const { objectTexts, annotRefs } = buildHighlightAnnotObjects(transformed, nextObjNum, outputDims);
      for (const t of objectTexts) newObjects.push({ objNum: nextObjNum++, content: t });
      extraAnnotRefs = annotRefs;
    }

    const newPageObj = buildReplacementPageDict(pageInfo.objNum, pageInfo.objText, newContentsArray, resourcesObjNum, null, extraAnnotRefs, objCache);
    newObjects.push({ objNum: pageInfo.objNum, content: newPageObj });
  }

  // Step 5: Create font objects for fonts that are actually used
  /** @type {Array<{objNum: number, content: string | import('./writePdfStreams.js').PdfBinaryObject}>} */
  const fontObjects = [];
  for (const pdfFont of pdfFontsUsed) {
    const objStrArr = await createEmbeddedFontType0({ font: pdfFont.opentype, firstObjIndex: pdfFont.objN, humanReadable });
    for (let j = 0; j < objStrArr.length; j++) {
      fontObjects.push({ objNum: pdfFont.objN + j, content: objStrArr[j] });
    }
  }

  // Step 6: Build incremental update
  const allNewObjects = [...fontObjects, ...newObjects];

  if (allNewObjects.length === 0) return basePdfData;

  /** @type {(string | Uint8Array)[]} */
  const appendParts = [];
  let appendByteLen = 0;
  appendParts.push('\n');
  appendByteLen += 1;

  const newXrefEntries = [];

  for (const obj of allNewObjects) {
    const offset = pdfBytes.length + appendByteLen;
    newXrefEntries.push({ objNum: obj.objNum, offset });
    const c = obj.content;
    if (typeof c === 'string') {
      appendParts.push(c);
      appendByteLen += c.length;
    } else {
      appendParts.push(c.header);
      appendByteLen += c.header.length;
      appendParts.push(c.streamData);
      appendByteLen += c.streamData.length;
      appendParts.push(c.trailer);
      appendByteLen += c.trailer.length;
    }
  }

  const newXrefOffset = pdfBytes.length + appendByteLen;
  const totalSize = Math.max(nextObjNum, ...allNewObjects.map((o) => o.objNum + 1));

  const trailerStr = buildIncrementalXrefAndTrailer(newXrefEntries, totalSize, xrefOffset, rootRef, newXrefOffset);
  appendParts.push(trailerStr);
  appendByteLen += trailerStr.length;

  const result = new Uint8Array(pdfBytes.length + appendByteLen);
  result.set(pdfBytes);
  let offset = pdfBytes.length;
  for (const part of appendParts) {
    if (typeof part === 'string') {
      for (let i = 0; i < part.length; i++) {
        result[offset++] = part.charCodeAt(i);
      }
    } else {
      result.set(part, offset);
      offset += part.length;
    }
  }

  return result.buffer;
}
