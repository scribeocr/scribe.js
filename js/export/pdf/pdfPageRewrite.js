import {
  extractDict, bytesToLatin1, findTopLevelKeyIndex,
  resolveIntValue, resolveNumValue, resolveNumArray,
} from '../../pdf/pdfPrimitives.js';
import { stripText } from '../../pdf/contentStream.js';
import { encodeStreamObject } from './writePdfStreams.js';
import { convertSinglePageForRegions } from './convertTextRegionsToPaths.js';

/**
 * Parse /Contents from a page dict, returning an array of indirect references to
 * content stream objects.
 * @param {string} pageObjText
 * @param {import('../../pdf/objectCache.js').ObjectCache} [objCache]
 */
export function parseExistingContents(pageObjText, objCache) {
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
 * @param {import('../../pdf/objectCache.js').ObjectCache} objCache
 * @param {() => number} allocObjNum
 * @param {(obj: { objNum: number, content: string | Uint8Array | import('./writePdfStreams.js').PdfBinaryObject }) => void} pushObj
 * @param {boolean} humanReadable
 */
export async function rewriteContentsStrippingInvisibleText(existingContentsRefs, objCache, allocObjNum, pushObj, humanReadable) {
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
 * Strip invisible text and optionally convert per-glyph text inside the
 * supplied user-space bboxes to vector paths via Form XObjects.
 *
 * Returns new content stream refs and any Form XObject /Resources entries that must be
 * merged into the page's /Resources/XObject dict.
 *
 * When `bboxes` is null or empty, this is equivalent to
 * `rewriteContentsStrippingInvisibleText` with an empty `xobjEntries`.
 *
 * @param {object} params
 * @param {string[]} params.existingContentsRefs
 * @param {string} params.pageObjText
 * @param {ReadonlyArray<ReadonlyArray<number>> | null} params.bboxes
 * @param {ReturnType<typeof import('./convertTextRegionsToPaths.js').createConversionState> | null} params.conversionState
 * @param {import('../../pdf/objectCache.js').ObjectCache} params.objCache
 * @param {() => number} params.allocObjNum
 * @param {(obj: { objNum: number, content: string | Uint8Array | import('./writePdfStreams.js').PdfBinaryObject }) => void} params.pushObj
 * @param {boolean} params.humanReadable
 * @param {boolean} [params.convertBrokenType3ToPaths] - When true, convert all glyphs drawn by broken-ToUnicode Type3 fonts to paths.
 * @returns {Promise<{
 *   refs: string[],
 *   xobjEntries: Map<string, number>,
 *   formClones: Map<string, number>,
 *   skipped: Array<{fontObjNum: number, charCode: number, reason: string}>,
 * }>}
 */
export async function rewriteContentsStripAndConvert({
  existingContentsRefs, pageObjText, bboxes, conversionState,
  objCache, allocObjNum, pushObj, humanReadable, convertBrokenType3ToPaths = false,
}) {
  /** @type {Map<string, number>} */
  const emptyXobj = new Map();
  /** @type {Map<string, number>} */
  const emptyFormClones = new Map();
  if (existingContentsRefs.length === 0) {
    return {
      refs: existingContentsRefs, xobjEntries: emptyXobj, formClones: emptyFormClones, skipped: [],
    };
  }

  /** @type {string[]} */
  const parts = [];
  let canMerge = true;
  for (const ref of existingContentsRefs) {
    const refMatch = /^(\d+)\s+\d+\s+R$/.exec(ref);
    if (!refMatch) { canMerge = false; break; }
    let bytes;
    try {
      bytes = objCache.getStreamBytes(Number(refMatch[1]));
    } catch {
      bytes = null;
    }
    if (!bytes) { canMerge = false; break; }
    parts.push(bytesToLatin1(bytes));
  }
  if (!canMerge) {
    return {
      refs: existingContentsRefs, xobjEntries: emptyXobj, formClones: emptyFormClones, skipped: [],
    };
  }

  const merged = parts.join('\n');
  const { text: strippedText, dropped } = stripText(merged, { mode: 'invisible' });

  const wantConvert = ((!!bboxes && bboxes.length > 0) || convertBrokenType3ToPaths) && !!conversionState;
  let workingText = strippedText;
  /** @type {Map<string, number>} */
  let xobjEntries = emptyXobj;
  /** @type {Map<string, number>} */
  let formClones = emptyFormClones;
  /** @type {Array<{fontObjNum: number, charCode: number, reason: string}>} */
  let skipped = [];
  let converted = false;

  if (wantConvert) {
    const result = await convertSinglePageForRegions({
      streamText: workingText,
      pageObjText,
      bboxes,
      state: conversionState,
      objCache,
      allocObjNum,
      pushObj,
      humanReadable,
      convertBrokenType3ToPaths,
    });
    if (result.skipped) skipped = result.skipped;
    if (result.changed) {
      if (result.text !== undefined) workingText = result.text;
      if (result.xobjEntries) xobjEntries = result.xobjEntries;
      if (result.formClones) formClones = result.formClones;
      converted = true;
    }
  }

  if (!dropped && !converted) {
    return {
      refs: existingContentsRefs, xobjEntries, formClones, skipped,
    };
  }

  const newObjNum = allocObjNum();
  const objBin = await encodeStreamObject(newObjNum, workingText, { humanReadable });
  pushObj({ objNum: newObjNum, content: objBin });
  return {
    refs: [`${newObjNum} 0 R`], xobjEntries, formClones, skipped,
  };
}

/**
 * Resolve the effective /Resources dictionary for a page.
 * Handles inline dicts, indirect references, and inherited resources.
 * @param {string} pageObjText
 * @param {import('../../pdf/objectCache.js').ObjectCache} objCache
 */
export function resolvePageResources(pageObjText, objCache) {
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
 *
 * @param {string} inner
 * @param {string} key  e.g. '/Font' or '/ExtGState'
 * @param {string} newEntries
 * @param {?import('../../pdf/objectCache.js').ObjectCache} objCache
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
 * @param {?import('../../pdf/objectCache.js').ObjectCache} [objCache=null]
 * @param {string} [overlayXObjectsStr='']
 */
export function mergeResources(existingDict, overlayFontsStr, overlayExtGStateStr, objCache = null, overlayXObjectsStr = '') {
  let inner = existingDict.slice(2, -2).trim();
  inner = mergeResourceKey(inner, '/Font', overlayFontsStr, objCache);
  inner = mergeResourceKey(inner, '/ExtGState', overlayExtGStateStr, objCache);
  inner = mergeResourceKey(inner, '/XObject', overlayXObjectsStr, objCache);
  // Newline before `>>` so any trailing `%` line-comment in `inner` ends before the close.
  return `<<${inner}\n>>`;
}

/**
 * Returns true if the annot dict at `annotObjNum` is a /Subtype/Link whose
 * destination resolves to a page object that is being dropped.
 *
 * @param {number} annotObjNum
 * @param {import('../../pdf/objectCache.js').ObjectCache} objCache
 * @param {Set<number>} keptPageObjNums
 */
export function annotLinkTargetsDroppedPage(annotObjNum, objCache, keptPageObjNums) {
  const annotText = objCache.getObjectText(annotObjNum);
  if (!annotText) return false;
  if (!/\/Subtype\s*\/Link\b/.test(annotText)) return false;

  const destArrayPage = (arrText) => {
    const m = /^\s*\[\s*(\d+)\s+\d+\s+R\b/.exec(arrText);
    return m ? Number(m[1]) : null;
  };

  /**
   * Resolve a /Dest or /D value, given inline or as an indirect ref to a destination array, to its target page object number.
   * Returns null for named destinations, which need a catalog name-tree lookup this skips.
   * @param {string} annotBody
   * @param {string} key
   * @returns {number|null}
   */
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
 * Resolve an inheritable numeric-array page attribute (/MediaBox, /CropBox)
 * by walking the /Parent chain when the page dict itself lacks it.
 * @param {string} pageObjText
 * @param {string} key
 * @param {import('../../pdf/objectCache.js').ObjectCache|null} objCache
 * @returns {number[]|null}
 */
function resolveInheritedNumArray(pageObjText, key, objCache) {
  let text = pageObjText;
  for (let depth = 0; depth < 32 && text; depth++) {
    const own = resolveNumArray(text, key, objCache, null);
    if (own) return own;
    if (!objCache) return null;
    const parentMatch = /\/Parent\s+(\d+)\s+\d+\s+R/.exec(text);
    if (!parentMatch) return null;
    text = objCache.getObjectText(Number(parentMatch[1]));
  }
  return null;
}

/**
 * Resolve an inheritable integer page attribute (/Rotate) up the /Parent chain.
 * @param {string} pageObjText
 * @param {string} key
 * @param {import('../../pdf/objectCache.js').ObjectCache|null} objCache
 * @returns {number|null}
 */
function resolveInheritedInt(pageObjText, key, objCache) {
  let text = pageObjText;
  for (let depth = 0; depth < 32 && text; depth++) {
    const own = resolveIntValue(text, key, objCache, NaN);
    if (!Number.isNaN(own)) return own;
    if (!objCache) return null;
    const parentMatch = /\/Parent\s+(\d+)\s+\d+\s+R/.exec(text);
    if (!parentMatch) return null;
    text = objCache.getObjectText(Number(parentMatch[1]));
  }
  return null;
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
 * @param {import('../../pdf/objectCache.js').ObjectCache|null} [objCache=null]
 *   Used to resolve an indirect /Annots array so source refs can be
 *   inlined alongside new user-added refs.
 * @param {?Set<number>} [keptPageObjNums=null] - When non-null (subset rebuild),
 *   filter out source link annotations whose destination page is not in this set.
 */
export function buildReplacementPageDict(objNum, originalObjText, newContentsArray, resourcesObjNum, parentObjNum = null, extraAnnotRefs = [], objCache = null, keptPageObjNums = null) {
  let dictStr = `${objNum} 0 obj\n<<`;
  dictStr += '/Type/Page';

  // Copy or override /Parent
  if (parentObjNum !== null) {
    dictStr += `/Parent ${parentObjNum} 0 R`;
  } else {
    const parentMatch = /\/Parent\s+(\d+\s+\d+\s+R)/.exec(originalObjText);
    if (parentMatch) dictStr += `/Parent ${parentMatch[1]}`;
  }

  const mediaBox = resolveInheritedNumArray(originalObjText, 'MediaBox', objCache);
  if (mediaBox) dictStr += `/MediaBox[${mediaBox.join(' ')}]`;

  const cropBox = resolveInheritedNumArray(originalObjText, 'CropBox', objCache);
  if (cropBox) dictStr += `/CropBox[${cropBox.join(' ')}]`;

  const rot = resolveInheritedInt(originalObjText, 'Rotate', objCache);
  if (rot !== null) dictStr += `/Rotate ${rot}`;

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

  const structParents = resolveIntValue(originalObjText, 'StructParents', objCache, NaN);
  if (!Number.isNaN(structParents)) dictStr += `/StructParents ${structParents}`;

  const tabsMatch = /\/Tabs\s*\/(\w+)/.exec(originalObjText);
  if (tabsMatch) dictStr += `/Tabs/${tabsMatch[1]}`;

  const userUnit = resolveNumValue(originalObjText, 'UserUnit', objCache, NaN);
  if (!Number.isNaN(userUnit)) dictStr += `/UserUnit ${userUnit}`;

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
 * Transform a pixel-space annotation's geometry into the coordinate frame the overlay's page uses.
 *
 * @param {Annotation} annot
 * @param {number} scaleX
 * @param {number} scaleY
 * @param {number} tx
 * @param {number} ty
 * @returns {Annotation}
 */
export function overlayAnnotationBbox(annot, scaleX, scaleY, tx, ty) {
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
  // FreeText font size lives in the same pixel frame as the bbox,
  // so convert it to page points alongside the rect for the text to fit its box at any scale.
  if (annot.type === 'freetext' && typeof annot.fontSize === 'number') out.fontSize = annot.fontSize * scaleY;
  return out;
}
