import {
  resolveArrayValue, parsePdfDate, resolveBoolValue, resolveNameValue, resolveNumValue, resolveIntValue,
  resolveStringValue, parsePdfLiteralString, resolveDictValue, decodePdfString,
} from './pdfPrimitives.js';
import { resolveItemDest } from './parseOutline.js';

// Bounding-box size in pixels imposed on a /Text annotation.
// The size is nominal because the marker renders at a fixed on-screen size regardless of the box.
// Shared with the create paths so imported and newly-placed text annotations are one size.
export const TEXT_ANNOT_ICON_PX = 24;

/**
 * @typedef {Object} PdfHighlightRaw
 * @property {number} objNum
 * @property {'Highlight'|'Underline'|'StrikeOut'} subtype - PDF /Subtype: the text-markup kind.
 * @property {[number, number, number, number]} rect - /Rect in pts, bottom-left origin.
 * @property {number[]|null} quadPoints - /QuadPoints: flat array of 8*N floats, pts, bottom-left origin.
 * @property {[number, number, number]|null} color - /C normalized 0..1, or null if absent.
 * @property {number} opacity - /CA, defaults to 1 when absent.
 * @property {string} comment - /Contents text (UTF-16BE or PDFDocEncoding decoded), '' when absent.
 * @property {string} author - /T text, '' when absent.
 * @property {?string} createdAt - /CreationDate as UTC ISO-8601, null when absent or unparseable.
 * @property {AnnotationReply[]} [replies] - Lifted /IRT reply thread, oldest first.
 */

/**
 * @typedef {Object} PdfShapeRaw
 * @property {number} objNum
 * @property {'Square'|'Circle'|'Line'|'Polygon'|'PolyLine'} subtype - PDF /Subtype: the shape kind.
 * @property {[number, number, number, number]} rect - /Rect in pts, bottom-left origin.
 * @property {[number, number, number]|null} color - /C stroke color normalized 0..1, or null if absent.
 * @property {[number, number, number]|null} interiorColor - /IC fill color normalized 0..1, or null if absent.
 * @property {number} opacity - /CA, defaults to 1 when absent.
 * @property {number} borderWidth - /BS /W in pts, defaults to 1 when absent.
 * @property {number[]|null} points - /L endpoints in pts for a Line, null otherwise.
 * @property {number[]|null} vertices - /Vertices in pts for a Polygon or PolyLine, null otherwise.
 * @property {string} comment - /Contents text (UTF-16BE or PDFDocEncoding decoded), '' when absent.
 * @property {string} author - /T text, '' when absent.
 * @property {?string} createdAt - /CreationDate as UTC ISO-8601, null when absent or unparseable.
 * @property {AnnotationReply[]} [replies] - Lifted /IRT reply thread, oldest first.
 */

/**
 * Read the decoded PDF string value for `key` from an annotation object's text.
 * Returns '' when the key is absent.
 * @param {string} annotText
 * @param {string} key - The dict key without the leading slash, e.g. 'Contents' or 'T'.
 * @param {import('./objectCache.js').ObjectCache} objCache
 * @returns {string}
 */
function parseAnnotPdfString(annotText, key, objCache) {
  return resolveStringValue(annotText, key, objCache) ?? '';
}

/**
 * @typedef {Object} PdfFreeTextRaw
 * @property {number} objNum
 * @property {[number, number, number, number]} rect - /Rect in pts, bottom-left origin.
 * @property {string} contents - /Contents text, '' when absent.
 * @property {number} fontSize - Tf size from /DA, 10 when absent.
 * @property {[number, number, number]|null} textColor - rg fill from /DA normalized 0..1, or null.
 * @property {[number, number, number]|null} fillColor - /C normalized 0..1, or null if absent.
 * @property {number} opacity - /CA, defaults to 1 when absent.
 * @property {AnnotationReply[]} [replies] - Lifted /IRT reply thread, oldest first.
 */

/**
 * @typedef {Object} PdfTextAnnotRaw
 * @property {number} objNum
 * @property {[number, number, number, number]} rect - /Rect in pts, bottom-left origin.
 * @property {[number, number, number]|null} color - /C normalized 0..1, or null if absent.
 * @property {number} opacity - /CA, defaults to 1 when absent.
 * @property {string} contents - /Contents text, '' when absent.
 * @property {boolean} open - /Open, false when absent.
 * @property {string} iconName - /Name icon, 'Comment' when absent.
 * @property {string} author - /T text, '' when absent.
 * @property {?string} createdAt - /CreationDate as UTC ISO-8601, null when absent or unparseable.
 * @property {AnnotationReply[]} [replies] - Lifted /IRT reply thread, oldest first.
 */

const SHAPE_SUBTYPE_RE = /\/Subtype\s*\/(Square|Circle|Line|Polygon|PolyLine)\b/;

/**
 * True when a shape annotation carries only properties the writer reproduces.
 * Those are stroke and interior color, opacity, border width, and geometry.
 * A shape that fails this keeps its source object, because re-emitting it would redraw it from that subset alone.
 * @param {string} annotText
 * @returns {boolean}
 */
function shapeIsReproducible(annotText) {
  // Cloudy borders (/BE), rect insets (/RD), line endings (/LE), rich-text bodies (/RC), and blend modes (/BM) have no representation in the model.
  if (/\/(?:BE|RD|LE|RC|BM)(?![A-Za-z0-9])/.test(annotText)) return false;
  // The writer emits a solid border of one width, so a dashed or non-solid /BS is out of reach.
  const bs = /\/BS\s*<<([^>]*)>>/.exec(annotText);
  if (bs && (/\/D(?![A-Za-z0-9])/.test(bs[1]) || /\/S\s*\/(?!S\b)/.test(bs[1]))) return false;
  // A legacy /Border array carries its dash pattern in a fourth element.
  const border = /\/Border\s*\[([^\]]*)\]/.exec(annotText);
  if (border && border[1].trim() && border[1].trim().split(/\s+/).length > 3) return false;
  return true;
}

/**
 * True when the annotation is one the importer lifts into the editable model rather than passing through.
 * The model re-emits these on export, so the source copy must be dropped or the annotation duplicates each round-trip.
 * @param {string} annotText - The raw annotation object text.
 * @param {import('./objectCache.js').ObjectCache} objCache
 * @returns {boolean}
 */
export function annotIsModelManaged(annotText, objCache) {
  // A pending /Redact counts even when the visibility flags below would hide it: a hidden redaction must still remove its content at export.
  if (/\/Subtype\s*\/Redact\b/.test(annotText)) return true;
  // Invisible (bit 1), Hidden (bit 2), or NoView (bit 6).
  const flags = resolveIntValue(annotText, 'F', objCache, 0);
  if (flags & 1 || flags & 2 || flags & 32) return false;
  // /Squiggly is deliberately absent: it stays a passthrough annotation.
  if (/\/Subtype\s*\/(?:Highlight|Underline|StrikeOut)\b/.test(annotText) || /\/Subtype\s*\/FreeText\b/.test(annotText)) return true;
  if (SHAPE_SUBTYPE_RE.test(annotText)) return shapeIsReproducible(annotText);
  // Replies (/IRT) are excluded here because they are lifted into their root's thread instead.
  return /\/Subtype\s*\/Text\b/.test(annotText) && !/\/IRT\b/.test(annotText);
}

const IRT_RE = /\/IRT\s+(\d+)\s+\d+\s+R/;

/**
 * Walk a /Text reply's /IRT chain to its root, flattening nested reply-to-reply chains onto one thread.
 * Null when the annotation is not a reply, or its chain is broken or cyclic.
 * @param {string} annotText
 * @param {import('./objectCache.js').ObjectCache} objCache
 * @returns {?{rootRef: number, rootText: string}}
 */
function resolveReplyRoot(annotText, objCache) {
  if (!/\/Subtype\s*\/Text\b/.test(annotText)) return null;
  // /RT /Group marks grouped markup, not a comment thread.
  if (/\/RT\s*\/Group\b/.test(annotText)) return null;
  // A /State annotation has empty /Contents, so lifting it would create a blank reply.
  if (/\/State(?:Model)?\s*\/\w/.test(annotText)) return null;
  let irt = IRT_RE.exec(annotText);
  if (!irt) return null;
  // The depth cap guards malformed cyclic chains.
  for (let depth = 0; depth < 8; depth++) {
    const ref = Number(irt[1]);
    const text = objCache.getObjectText(ref);
    if (!text) return null;
    const parentIrt = IRT_RE.exec(text);
    if (!parentIrt) return { rootRef: ref, rootText: text };
    irt = parentIrt;
  }
  return null;
}

/**
 * True when the annotation is a comment reply whose thread root is model-managed.
 * The reply is re-emitted with its root on export, so the source copy must be dropped.
 * @param {string} annotText
 * @param {import('./objectCache.js').ObjectCache} objCache
 * @returns {boolean}
 */
export function annotIsLiftedReply(annotText, objCache) {
  const root = resolveReplyRoot(annotText, objCache);
  return !!root && annotIsModelManaged(root.rootText, objCache);
}

/**
 * True when the annotation is a /Link the importer lifts into the document's annotations.
 * Export drops the source copy of every lifted link, so this verdict must match the parse-side lift.
 * `linkDestInfo` must cover the full source page set, not an export's kept pages, or a lifted link whose target page was deleted resurrects in the output.
 * @param {string} annotText
 * @param {import('./objectCache.js').ObjectCache} objCache
 * @param {{ nameDests: Map<string, string>, objNumToIndex: Map<number, number> }} linkDestInfo
 * @returns {boolean}
 */
export function linkAnnotIsLifted(annotText, objCache, linkDestInfo) {
  if (!/\/Subtype\s*\/Link\b/.test(annotText)) return false;
  const flags = resolveIntValue(annotText, 'F', objCache, 0);
  if (flags & 1 || flags & 2 || flags & 32) return false;
  const rectStr = resolveArrayValue(annotText, 'Rect', objCache);
  const rect = rectStr ? rectStr.split(/\s+/).map(Number) : [];
  if (rect.length < 4 || rect.slice(0, 4).some(Number.isNaN)) return false;
  if (resolveLinkUri(annotText, objCache)) return true;
  const { dest } = resolveItemDest(annotText, linkDestInfo.nameDests, linkDestInfo.objNumToIndex, objCache);
  return !!dest;
}

/**
 * @typedef {Object} PdfRedactRaw
 * @property {number} objNum
 * @property {[number, number, number, number]} rect - /Rect in pts, bottom-left origin.
 * @property {number[]|null} quadPoints - /QuadPoints: flat array of 8*N floats, pts, bottom-left origin.
 */

/**
 * @typedef {Object} PdfLinkRaw
 * @property {[number, number, number, number]} rect - /Rect in pts, bottom-left origin.
 * @property {string} [uri] - URL from the link's /A /URI action; absent for an internal link.
 * @property {string} [annotText] - Raw annotation object text of a non-URI link, for the caller to resolve its /Dest or /GoTo target.
 */

/**
 * Resolve a /Link annotation's target URL, following the /A action whether it is an indirect ref or a dict inline in the annotation.
 * Returns null when there is no /URI action, which is the case for an internal /Dest page jump since that is not a URL.
 * @param {string} annotText
 * @param {import('./objectCache.js').ObjectCache} objCache
 * @returns {?string}
 */
function resolveLinkUri(annotText, objCache) {
  const refMatch = /\/A\s+(\d+)\s+\d+\s+R/.exec(annotText);
  let actionText = refMatch ? objCache.getObjectText(Number(refMatch[1])) : annotText;
  if (!actionText) return null;
  // buildLinkAnnotObjects emits /URI as a hex string, so this branch is what makes this library's own exports re-lift.
  const hexMatch = /\/URI\s*<(?!<)([0-9a-fA-F\s]*)>/.exec(actionText);
  if (hexMatch) {
    let hex = hexMatch[1].replace(/\s+/g, '');
    if (hex.length % 2 === 1) hex += '0';
    let uri = '';
    for (let hi = 0; hi < hex.length; hi += 2) uri += String.fromCharCode(parseInt(hex.slice(hi, hi + 2), 16));
    return uri || null;
  }
  let keyMatch = /\/URI\s*\(/.exec(actionText);
  if (!keyMatch) {
    const uriRef = /\/URI\s+(\d+)\s+\d+\s+R/.exec(actionText);
    const uriText = uriRef ? objCache.getObjectText(Number(uriRef[1])) : null;
    if (!uriText) return null;
    actionText = uriText;
    keyMatch = { index: 0 };
  }
  // A URL can contain balanced unescaped parens, which is legal in a PDF literal string but cannot be matched by a regex.
  const parenOpen = actionText.indexOf('(', keyMatch.index);
  if (parenOpen === -1) return null;
  const bytes = Uint8Array.from(actionText, (c) => c.charCodeAt(0) & 0xFF);
  const { value } = parsePdfLiteralString(bytes, parenOpen);
  let uri = '';
  for (const b of value) uri += String.fromCharCode(b);
  return uri || null;
}

/**
 * @typedef {Object} PdfWidgetRaw
 * @property {number} objNum
 * @property {number} rootRef - Topmost /Parent object number, or the widget itself when parentless.
 * @property {number} valueRef - Object number where write-back places /V.
 * @property {[number, number, number, number]} rect - /Rect in pts, bottom-left origin.
 * @property {?string} ft - /FT, inherited.
 * @property {string} name - Fully-qualified field name, or '(unnamed)' when no level declares /T.
 * @property {?string} value - Decoded /V, with an unchecked /Btn (/Off) normalized to null.
 * @property {boolean} signed
 * @property {number} ff - Field flags (/Ff), inherited.
 * @property {number} flags - Annotation flags (/F).
 * @property {?number} maxLen - /MaxLen, inherited.
 * @property {number} quadding - /Q text alignment, inherited.
 * @property {?string} da - /DA default-appearance string, inherited.
 * @property {?string} onState - Checkbox/radio on-state name from the widget's own /AP /N states.
 * @property {?string[]} options - /Ch option display strings from /Opt, inherited.
 * @property {?number} apRef - Object number of the /AP /N appearance stream for the widget's current state.
 * @property {?Object<string, number>} apStates - State name to stream object number when /AP /N is a per-state dict.
 */

/**
 * Sorts a page's /Annots into the buckets the importer lifts, plus the refs of the remaining visible annotations.
 * Lifting a Widget into `widgets` does not remove it from `passthroughRefs`, so its source object still renders and survives export.
 * @param {import('./objectCache.js').ObjectCache} objCache
 * @param {string} pageObjText
 * @returns {{ highlights: PdfHighlightRaw[], freeTexts: PdfFreeTextRaw[], textAnnots: PdfTextAnnotRaw[],
 *   shapes: PdfShapeRaw[], redacts: PdfRedactRaw[], links: PdfLinkRaw[], widgets: PdfWidgetRaw[], passthroughRefs: number[] }}
 */
export function extractPdfAnnotations(objCache, pageObjText) {
  /** @type {PdfHighlightRaw[]} */
  const highlights = [];
  /** @type {PdfFreeTextRaw[]} */
  const freeTexts = [];
  /** @type {PdfTextAnnotRaw[]} */
  const textAnnots = [];
  /** @type {PdfShapeRaw[]} */
  const shapes = [];
  /** @type {PdfRedactRaw[]} */
  const redacts = [];
  /** @type {PdfLinkRaw[]} */
  const links = [];
  /** @type {PdfWidgetRaw[]} */
  const widgets = [];
  /** @type {number[]} */
  const passthroughRefs = [];

  let annotRefs = null;
  const inlineMatch = /\/Annots\s*\[([^\]]*)\]/.exec(pageObjText);
  if (inlineMatch) {
    annotRefs = [...inlineMatch[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
  } else {
    const indirectMatch = /\/Annots\s+(\d+)\s+\d+\s+R/.exec(pageObjText);
    if (indirectMatch) {
      const arrayText = objCache.getObjectText(Number(indirectMatch[1]));
      if (arrayText) {
        annotRefs = [...arrayText.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
      }
    }
  }
  if (!annotRefs || annotRefs.length === 0) {
    return {
      highlights, freeTexts, textAnnots, shapes, redacts, links, widgets, passthroughRefs,
    };
  }

  /** @type {Map<number, Array<{objNum: number, text: string, author: string, createdAt: ?string}>>} */
  const repliesByRoot = new Map();

  for (const annotRef of annotRefs) {
    const annotText = objCache.getObjectText(annotRef);
    if (!annotText) continue;

    if (!annotIsModelManaged(annotText, objCache)) {
      // Flags are ignored here: a reply is thread content, not a page icon.
      const root = resolveReplyRoot(annotText, objCache);
      if (root && annotIsModelManaged(root.rootText, objCache)) {
        const creationDateStr = parseAnnotPdfString(annotText, 'CreationDate', objCache);
        if (!repliesByRoot.has(root.rootRef)) repliesByRoot.set(root.rootRef, []);
        /** @type {Array<{objNum: number, text: string, author: string, createdAt: ?string}>} */ (repliesByRoot.get(root.rootRef)).push({
          objNum: annotRef,
          text: parseAnnotPdfString(annotText, 'Contents', objCache),
          author: parseAnnotPdfString(annotText, 'T', objCache),
          createdAt: creationDateStr ? parsePdfDate(creationDateStr) : null,
        });
        continue;
      }
      const flags = resolveIntValue(annotText, 'F', objCache, 0);

      if (/\/Subtype\s*\/Widget\b/.test(annotText)) {
        try {
          const chainTexts = [annotText];
          const chainRefs = [annotRef];
          let cur = annotText;
          let rootRef = annotRef;
          const visitedParents = new Set([annotRef]);
          for (let depth = 0; depth < 16; depth++) {
            const pm = /\/Parent\s+(\d+)\s+\d+\s+R/.exec(cur);
            if (!pm) break;
            const parentNum = Number(pm[1]);
            if (visitedParents.has(parentNum)) break;
            visitedParents.add(parentNum);
            const parentText = objCache.getObjectText(parentNum);
            if (!parentText) break;
            rootRef = parentNum;
            chainTexts.push(parentText);
            chainRefs.push(parentNum);
            cur = parentText;
          }

          let ft = null;
          for (const t of chainTexts) { if (/\/FT(?![A-Za-z0-9])/.test(t)) { ft = resolveNameValue(t, 'FT', objCache); break; } }
          let ff = 0;
          for (const t of chainTexts) { if (/\/Ff(?![A-Za-z0-9])/.test(t)) { ff = resolveIntValue(t, 'Ff', objCache, 0); break; } }
          let maxLen = null;
          for (const t of chainTexts) { if (/\/MaxLen(?![A-Za-z0-9])/.test(t)) { maxLen = resolveIntValue(t, 'MaxLen', objCache, 0) || null; break; } }
          let quadding = 0;
          for (const t of chainTexts) { if (/\/Q(?![A-Za-z0-9])/.test(t)) { quadding = resolveIntValue(t, 'Q', objCache, 0); break; } }
          let da = null;
          for (const t of chainTexts) { if (/\/DA(?![A-Za-z0-9])/.test(t)) { da = resolveStringValue(t, 'DA', objCache); break; } }
          const nameParts = [];
          // The fully-qualified field name is every level's own /T, root-to-leaf.
          for (const t of chainTexts) { if (/\/T(?![A-Za-z0-9])/.test(t)) nameParts.push(resolveStringValue(t, 'T', objCache) || ''); }
          const name = nameParts.length ? nameParts.reverse().join('.') : '(unnamed)';

          const vLevelText = chainTexts.find((t) => /\/V(?![A-Za-z0-9])/.test(t)) || null;
          let value = null;
          let signed = false;
          if (vLevelText) {
            if (ft === 'Btn') {
              value = resolveNameValue(vLevelText, 'V', objCache);
            } else if (ft === 'Sig') {
              signed = resolveDictValue(vLevelText, 'V', objCache) !== null;
            } else {
              value = resolveStringValue(vLevelText, 'V', objCache);
              if (value == null && ft === 'Ch') {
                const arr = resolveArrayValue(vLevelText, 'V', objCache);
                if (arr != null) {
                  const parts = [...arr.matchAll(/\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>/g)].map((m) => decodePdfString(m[0]));
                  if (parts.length > 0) value = parts.join('; ');
                }
              }
            }
            if (value && value.charCodeAt(0) === 0xfeff) value = value.slice(1);
          }
          if (ft === 'Btn' && value === 'Off') value = null;

          // A /V written to the widget rather than the leaf /T node leaves the field itself unfilled.
          let valueRef = annotRef;
          const vIdx = chainTexts.findIndex((t) => /\/V(?![A-Za-z0-9])/.test(t));
          if (vIdx >= 0) {
            valueRef = chainRefs[vIdx];
          } else {
            const tIdx = chainTexts.findIndex((t) => /\/T(?![A-Za-z0-9])/.test(t));
            if (tIdx >= 0) valueRef = chainRefs[tIdx];
          }

          let onState = null;
          if (ft === 'Btn' && !(ff & 0x10000)) {
            const apText = resolveDictValue(annotText, 'AP', objCache);
            const nText = apText ? resolveDictValue(apText, 'N', objCache) : null;
            // A /N carrying /BBox is a single appearance stream, so scanning it for state names would pick up its own dict keys.
            if (nText && !/\/BBox(?![A-Za-z0-9])/.test(nText)) {
              for (const m of nText.matchAll(/\/([^\s/<>[\]()]+)\s+\d+\s+\d+\s+R/g)) {
                const state = m[1].replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
                if (state !== 'Off') { onState = state; break; }
              }
            }
            if (onState == null && value != null) onState = value;
          }

          let options = null;
          if (ft === 'Ch') {
            const optLevel = chainTexts.find((t) => /\/Opt(?![A-Za-z0-9])/.test(t));
            const optArr = optLevel ? resolveArrayValue(optLevel, 'Opt', objCache) : null;
            if (optArr != null) {
              options = [];
              // The last string of an [export, display] pair is the user-visible text.
              for (const m of optArr.matchAll(/\[((?:\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>|[^\]])*)\]|\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>/g)) {
                let entry = m[0];
                if (m[1] !== undefined) {
                  const strs = [...m[1].matchAll(/\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>/g)];
                  if (strs.length === 0) continue;
                  entry = strs[strs.length - 1][0];
                }
                let s = decodePdfString(entry);
                if (s && s.charCodeAt(0) === 0xfeff) s = s.slice(1);
                options.push(s);
              }
            }
          }

          let apRef = null;
          let apStates = null;
          const apDictText = resolveDictValue(annotText, 'AP', objCache);
          if (apDictText) {
            const nText = resolveDictValue(apDictText, 'N', objCache);
            // A /N carrying /BBox is the appearance stream itself; otherwise it is a per-state dict.
            if (nText && /\/BBox(?![A-Za-z0-9])/.test(nText)) {
              const nRefM = /\/N\s+(\d+)\s+\d+\s+R/.exec(apDictText);
              if (nRefM) apRef = Number(nRefM[1]);
            } else if (nText) {
              apStates = {};
              for (const m of nText.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
                const state = m[1].replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
                apStates[state] = Number(m[2]);
              }
              const as = resolveNameValue(annotText, 'AS', objCache);
              const current = as ?? (ft === 'Btn' ? (value != null && onState != null ? onState : 'Off') : null);
              if (current != null && apStates[current] != null) apRef = apStates[current];
            }
          }

          const wRectStr = resolveArrayValue(annotText, 'Rect', objCache);
          const wRectNums = wRectStr ? wRectStr.split(/\s+/).map(Number) : [];
          if (wRectNums.length >= 4 && !wRectNums.slice(0, 4).some(Number.isNaN)) {
            widgets.push({
              objNum: annotRef,
              rootRef,
              valueRef,
              rect: [wRectNums[0], wRectNums[1], wRectNums[2], wRectNums[3]],
              ft,
              name,
              value,
              signed,
              ff,
              flags,
              maxLen,
              quadding,
              da,
              onState,
              options,
              apRef,
              apStates,
            });
          }
        } catch { /* skip this malformed widget */ }
      }

      // Of these not-lifted annotations, Invisible/Hidden/NoView are dropped entirely.
      // Every other visible annotation passes through on export unchanged, except lifted /Links, which export drops and re-emits from the document's annotations.
      if (!(flags & 1 || flags & 2 || flags & 32)) {
        passthroughRefs.push(annotRef);
        // Links stay in passthroughRefs as well, so the renderer still paints their source appearance streams.
        if (/\/Subtype\s*\/Link\b/.test(annotText)) {
          const linkUri = resolveLinkUri(annotText, objCache);
          const linkRectStr = resolveArrayValue(annotText, 'Rect', objCache);
          const linkRect = linkRectStr ? linkRectStr.split(/\s+/).map(Number) : [];
          if (linkRect.length >= 4 && !linkRect.slice(0, 4).some(Number.isNaN)) {
            /** @type {[number, number, number, number]} */
            const rect = [linkRect[0], linkRect[1], linkRect[2], linkRect[3]];
            if (linkUri) links.push({ rect, uri: linkUri });
            else links.push({ rect, annotText });
          }
        }
      }
      continue;
    }

    const isFreeText = /\/Subtype\s*\/FreeText\b/.test(annotText);
    const isTextAnnot = /\/Subtype\s*\/Text\b/.test(annotText);
    const isRedact = /\/Subtype\s*\/Redact\b/.test(annotText);

    const rectStr = resolveArrayValue(annotText, 'Rect', objCache);
    const rectNums = rectStr ? rectStr.split(/\s+/).map(Number) : [];
    const rectValid = rectNums.length >= 4 && !rectNums.slice(0, 4).some(Number.isNaN);
    // A /Text annotation tolerates a missing/invalid rect (defaulted below) so a model-managed one is never silently lost.
    if (!rectValid && !isTextAnnot) continue;
    /** @type {[number, number, number, number]} */
    const rect = rectValid ? [rectNums[0], rectNums[1], rectNums[2], rectNums[3]] : [0, 0, TEXT_ANNOT_ICON_PX, TEXT_ANNOT_ICON_PX];

    if (isRedact) {
      // Appearance entries (/IC, /RO, /OverlayText) are ignored because the applied redaction always paints an opaque black box.
      const rQpStr = resolveArrayValue(annotText, 'QuadPoints', objCache);
      redacts.push({ objNum: annotRef, rect, quadPoints: rQpStr ? rQpStr.split(/\s+/).map(Number) : null });
      continue;
    }

    const cStr = resolveArrayValue(annotText, 'C', objCache);
    const cNums = cStr ? cStr.split(/\s+/).map(Number) : null;
    /** @type {[number, number, number]|null} */
    const color = cNums && cNums.length >= 3 && !cNums.some(Number.isNaN)
      ? [cNums[0], cNums[1], cNums[2]] : null;

    const opacity = resolveNumValue(annotText, 'CA', objCache, 1);

    const shapeMatch = SHAPE_SUBTYPE_RE.exec(annotText);
    if (shapeMatch) {
      const icStr = resolveArrayValue(annotText, 'IC', objCache);
      const icNums = icStr ? icStr.split(/\s+/).map(Number) : null;
      const lStr = resolveArrayValue(annotText, 'L', objCache);
      const vStr = resolveArrayValue(annotText, 'Vertices', objCache);
      const bsWidth = /\/BS\s*<<([^>]*)>>/.exec(annotText);
      const shapeCreatedAt = parseAnnotPdfString(annotText, 'CreationDate', objCache);
      shapes.push({
        objNum: annotRef,
        subtype: /** @type {'Square'|'Circle'|'Line'|'Polygon'|'PolyLine'} */ (shapeMatch[1]),
        rect,
        color,
        interiorColor: icNums && icNums.length >= 3 && !icNums.some(Number.isNaN)
          ? [icNums[0], icNums[1], icNums[2]] : null,
        opacity,
        borderWidth: bsWidth ? (resolveNumValue(bsWidth[1], 'W', objCache, 1) ?? 1) : 1,
        points: lStr ? lStr.split(/\s+/).map(Number) : null,
        vertices: vStr ? vStr.split(/\s+/).map(Number) : null,
        comment: parseAnnotPdfString(annotText, 'Contents', objCache),
        author: parseAnnotPdfString(annotText, 'T', objCache),
        createdAt: shapeCreatedAt ? parsePdfDate(shapeCreatedAt) : null,
      });
      continue;
    }

    if (isFreeText) {
      const da = resolveStringValue(annotText, 'DA', objCache) ?? '';
      const tfMatch = /([\d.]+)\s+Tf/.exec(da);
      const rgMatch = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
      freeTexts.push({
        objNum: annotRef,
        rect,
        contents: parseAnnotPdfString(annotText, 'Contents', objCache),
        fontSize: tfMatch ? Number(tfMatch[1]) : 10,
        textColor: rgMatch ? [Number(rgMatch[1]), Number(rgMatch[2]), Number(rgMatch[3])] : null,
        fillColor: color,
        opacity,
      });
      continue;
    }

    if (isTextAnnot) {
      const creationDateStr = parseAnnotPdfString(annotText, 'CreationDate', objCache);
      textAnnots.push({
        objNum: annotRef,
        rect,
        color,
        opacity,
        contents: parseAnnotPdfString(annotText, 'Contents', objCache),
        open: resolveBoolValue(annotText, 'Open', objCache, false),
        iconName: resolveNameValue(annotText, 'Name', objCache) || 'Comment',
        author: parseAnnotPdfString(annotText, 'T', objCache),
        createdAt: creationDateStr ? parsePdfDate(creationDateStr) : null,
      });
      continue;
    }

    const qpStr = resolveArrayValue(annotText, 'QuadPoints', objCache);
    const quadPoints = qpStr ? qpStr.split(/\s+/).map(Number) : null;

    const subtypeMatch = /\/Subtype\s*\/(Underline|StrikeOut)\b/.exec(annotText);
    const createdAtStr = parseAnnotPdfString(annotText, 'CreationDate', objCache);
    highlights.push({
      objNum: annotRef,
      subtype: subtypeMatch ? /** @type {'Underline'|'StrikeOut'} */ (subtypeMatch[1]) : 'Highlight',
      rect,
      quadPoints,
      color,
      opacity,
      comment: parseAnnotPdfString(annotText, 'Contents', objCache),
      author: parseAnnotPdfString(annotText, 'T', objCache),
      createdAt: createdAtStr ? parsePdfDate(createdAtStr) : null,
    });
  }

  if (repliesByRoot.size > 0) {
    for (const raws of [highlights, freeTexts, textAnnots, shapes]) {
      for (const raw of raws) {
        const found = repliesByRoot.get(raw.objNum);
        if (!found) continue;
        found.sort((a, b) => {
          const da = a.createdAt || '';
          const db = b.createdAt || '';
          if (da !== db) return da < db ? -1 : 1;
          // Object order breaks date ties and orders undated replies.
          return a.objNum - b.objNum;
        });
        raw.replies = found.map((r) => {
          /** @type {AnnotationReply} */
          const reply = { text: r.text };
          if (r.author) reply.author = r.author;
          if (r.createdAt) reply.createdAt = r.createdAt;
          return reply;
        });
      }
    }
  }

  return {
    highlights, freeTexts, textAnnots, shapes, redacts, links, widgets, passthroughRefs,
  };
}

/**
 * Convert a user-space /Redact annotation to pixel-space redaction marks: one per quad, or one from /Rect when there are no QuadPoints, all sharing the given group id.
 * @param {PdfRedactRaw} raw
 * @param {{ scale: number, visualHeightPts: number, initialCtm: number[], groupId: string }} transform
 * @returns {AnnotationRedact[]}
 */
export function pdfRedactToAnnotations(raw, transform) {
  const {
    scale, visualHeightPts, initialCtm, groupId,
  } = transform;
  const mapPoint = (x, y) => {
    const cx = initialCtm[0] * x + initialCtm[2] * y + initialCtm[4];
    const cy = initialCtm[1] * x + initialCtm[3] * y + initialCtm[5];
    return { x: cx * scale, y: (visualHeightPts - cy) * scale };
  };
  /** @param {Array<{x: number, y: number}>} corners @returns {bbox} */
  const bboxFromCorners = (corners) => {
    let left = Infinity; let right = -Infinity; let top = Infinity; let bottom = -Infinity;
    for (const c of corners) {
      if (c.x < left) left = c.x;
      if (c.x > right) right = c.x;
      if (c.y < top) top = c.y;
      if (c.y > bottom) bottom = c.y;
    }
    return {
      left, top, right, bottom,
    };
  };
  /** @type {AnnotationRedact[]} */
  const out = [];
  if (raw.quadPoints && raw.quadPoints.length >= 8) {
    for (let qi = 0; qi + 7 < raw.quadPoints.length; qi += 8) {
      const corners = [
        mapPoint(raw.quadPoints[qi], raw.quadPoints[qi + 1]),
        mapPoint(raw.quadPoints[qi + 2], raw.quadPoints[qi + 3]),
        mapPoint(raw.quadPoints[qi + 4], raw.quadPoints[qi + 5]),
        mapPoint(raw.quadPoints[qi + 6], raw.quadPoints[qi + 7]),
      ];
      out.push({ type: 'redact', bbox: bboxFromCorners(corners), groupId });
    }
    return out;
  }
  const corners = [
    mapPoint(raw.rect[0], raw.rect[1]),
    mapPoint(raw.rect[2], raw.rect[1]),
    mapPoint(raw.rect[0], raw.rect[3]),
    mapPoint(raw.rect[2], raw.rect[3]),
  ];
  out.push({ type: 'redact', bbox: bboxFromCorners(corners), groupId });
  return out;
}

/**
 * Convert a PDF user-space highlight to the pixel-space `AnnotationHighlight` shape.
 * @param {PdfHighlightRaw} raw
 * @param {{ scale: number, visualHeightPts: number, initialCtm: number[], groupId: string }} transform
 * @returns {AnnotationHighlight}
 */
export function pdfHighlightToAnnotation(raw, transform) {
  const {
    scale, visualHeightPts, initialCtm, groupId,
  } = transform;

  // `initialCtm` bakes in any /Rotate, so the Y-flip is against the post-rotate visual height.
  const mapPoint = (x, y) => {
    const cx = initialCtm[0] * x + initialCtm[2] * y + initialCtm[4];
    const cy = initialCtm[1] * x + initialCtm[3] * y + initialCtm[5];
    return { x: cx * scale, y: (visualHeightPts - cy) * scale };
  };

  const bboxFromCorners = (corners) => {
    let left = Infinity; let right = -Infinity;
    let top = Infinity; let bottom = -Infinity;
    for (const c of corners) {
      if (c.x < left) left = c.x;
      if (c.x > right) right = c.x;
      if (c.y < top) top = c.y;
      if (c.y > bottom) bottom = c.y;
    }
    return {
      left, top, right, bottom,
    };
  };

  // /Rect — apply full transform to all 4 corners, take bbox of the result.
  const rectCorners = [
    mapPoint(raw.rect[0], raw.rect[1]),
    mapPoint(raw.rect[2], raw.rect[1]),
    mapPoint(raw.rect[0], raw.rect[3]),
    mapPoint(raw.rect[2], raw.rect[3]),
  ];
  const bbox = bboxFromCorners(rectCorners);

  // /QuadPoints — group into quads of 4 (x,y) points, transform each, compute bbox per quad.
  /** @type {bbox[] | undefined} */
  let quads;
  if (raw.quadPoints && raw.quadPoints.length >= 8) {
    quads = [];
    for (let qi = 0; qi + 7 < raw.quadPoints.length; qi += 8) {
      const corners = [
        mapPoint(raw.quadPoints[qi], raw.quadPoints[qi + 1]),
        mapPoint(raw.quadPoints[qi + 2], raw.quadPoints[qi + 3]),
        mapPoint(raw.quadPoints[qi + 4], raw.quadPoints[qi + 5]),
        mapPoint(raw.quadPoints[qi + 6], raw.quadPoints[qi + 7]),
      ];
      quads.push(bboxFromCorners(corners));
    }
  }

  const color = raw.color || [1, 1, 0];
  const hex = `#${color.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('')}`;

  /** @type {AnnotationHighlight} */
  const annot = {
    type: raw.subtype === 'Underline' ? 'underline' : (raw.subtype === 'StrikeOut' ? 'strikeout' : 'highlight'),
    bbox,
    color: hex,
    opacity: raw.opacity,
    groupId,
  };
  if (raw.comment) annot.comment = raw.comment;
  if (raw.author) annot.author = raw.author;
  if (raw.createdAt) annot.createdAt = raw.createdAt;
  if (raw.replies && raw.replies.length > 0) annot.replies = raw.replies;
  if (quads && quads.length > 0) annot.quads = quads;
  return annot;
}

/**
 * Convert a PDF user-space FreeText annotation to the pixel-space
 * `AnnotationFreeText` shape used by `scribe.data.annotations.pages[i]`.
 * Coordinate handling matches `pdfHighlightToAnnotation`.
 * `fontSize` is scaled into the same pixel frame as the bbox, which the writer reverses on export.
 *
 * @param {PdfFreeTextRaw} raw
 * @param {{ scale: number, visualHeightPts: number, initialCtm: number[] }} transform
 * @returns {AnnotationFreeText}
 */
export function pdfFreeTextToAnnotation(raw, transform) {
  const { scale, visualHeightPts, initialCtm } = transform;

  const mapPoint = (x, y) => {
    const cx = initialCtm[0] * x + initialCtm[2] * y + initialCtm[4];
    const cy = initialCtm[1] * x + initialCtm[3] * y + initialCtm[5];
    return { x: cx * scale, y: (visualHeightPts - cy) * scale };
  };

  const corners = [
    mapPoint(raw.rect[0], raw.rect[1]),
    mapPoint(raw.rect[2], raw.rect[1]),
    mapPoint(raw.rect[0], raw.rect[3]),
    mapPoint(raw.rect[2], raw.rect[3]),
  ];
  let left = Infinity; let right = -Infinity;
  let top = Infinity; let bottom = -Infinity;
  for (const c of corners) {
    if (c.x < left) left = c.x;
    if (c.x > right) right = c.x;
    if (c.y < top) top = c.y;
    if (c.y > bottom) bottom = c.y;
  }

  const toHex = (rgb) => `#${rgb.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('')}`;

  /** @type {AnnotationFreeText} */
  const annot = {
    type: 'freetext',
    bbox: {
      left, top, right, bottom,
    },
    contents: raw.contents,
    // fontSize is a vertical distance, so like the rect corners it scales by the page CTM's vertical magnitude.
    // hypot(ctm[2], ctm[3]) gives that magnitude even on rotated pages, where ctm[3] alone would be 0.
    fontSize: raw.fontSize * scale * Math.hypot(initialCtm[2], initialCtm[3]),
    textColor: toHex(raw.textColor || [0, 0, 0]),
    opacity: raw.opacity,
  };
  if (raw.fillColor) annot.fillColor = toHex(raw.fillColor);
  if (raw.replies && raw.replies.length > 0) annot.replies = raw.replies;
  return annot;
}

/**
 * Convert a PDF user-space /Text annotation to the pixel-space `AnnotationText` model.
 * Maps the /Rect corners like `pdfHighlightToAnnotation`, then imposes a fixed icon size on the top-left
 * (a point icon's source rect size is not meaningful and varies wildly between producers).
 * @param {PdfTextAnnotRaw} raw
 * @param {{ scale: number, visualHeightPts: number, initialCtm: number[] }} transform
 * @returns {AnnotationText}
 */
export function pdfTextAnnotToAnnotation(raw, transform) {
  const { scale, visualHeightPts, initialCtm } = transform;
  const mapPoint = (x, y) => {
    const cx = initialCtm[0] * x + initialCtm[2] * y + initialCtm[4];
    const cy = initialCtm[1] * x + initialCtm[3] * y + initialCtm[5];
    return { x: cx * scale, y: (visualHeightPts - cy) * scale };
  };
  const corners = [
    mapPoint(raw.rect[0], raw.rect[1]),
    mapPoint(raw.rect[2], raw.rect[1]),
    mapPoint(raw.rect[0], raw.rect[3]),
    mapPoint(raw.rect[2], raw.rect[3]),
  ];
  let left = Infinity;
  let top = Infinity;
  for (const c of corners) {
    if (c.x < left) left = c.x;
    if (c.y < top) top = c.y;
  }

  /** @type {AnnotationText} */
  const annot = {
    type: 'text',
    bbox: {
      left, top, right: left + TEXT_ANNOT_ICON_PX, bottom: top + TEXT_ANNOT_ICON_PX,
    },
    comment: raw.contents,
    open: raw.open,
  };
  if (raw.color) {
    annot.color = `#${raw.color.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('')}`;
  }
  if (raw.author) annot.author = raw.author;
  if (raw.createdAt) annot.createdAt = raw.createdAt;
  if (raw.replies && raw.replies.length > 0) annot.replies = raw.replies;
  return annot;
}

/**
 * Convert a PDF user-space shape annotation to the pixel-space `AnnotationShape` model.
 *
 * @param {PdfShapeRaw} raw
 * @param {{ scale: number, visualHeightPts: number, initialCtm: number[] }} transform
 * @returns {AnnotationShape}
 */
export function pdfShapeToAnnotation(raw, transform) {
  const { scale, visualHeightPts, initialCtm } = transform;

  const mapPoint = (x, y) => {
    const cx = initialCtm[0] * x + initialCtm[2] * y + initialCtm[4];
    const cy = initialCtm[1] * x + initialCtm[3] * y + initialCtm[5];
    return { x: cx * scale, y: (visualHeightPts - cy) * scale };
  };
  const toHex = (rgb) => `#${rgb.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('')}`;

  /** @type {AnnotationShapeStyle} */
  const style = {
    borderColor: toHex(raw.color || [0, 0, 0]),
    opacity: raw.opacity,
    // The stroke is a distance, so it scales into the bbox's pixel frame like a FreeText font size.
    borderWidth: raw.borderWidth * scale * Math.hypot(initialCtm[2], initialCtm[3]),
  };
  if (raw.interiorColor) style.fillColor = toHex(raw.interiorColor);
  if (raw.comment) style.comment = raw.comment;
  if (raw.author) style.author = raw.author;
  if (raw.createdAt) style.createdAt = raw.createdAt;
  if (raw.replies && raw.replies.length > 0) style.replies = raw.replies;

  // The writer re-emits this geometry, so falling back to the bbox would flatten a line or polygon onto the rectangle that bounds it.
  if (raw.subtype === 'Line' && raw.points && raw.points.length >= 4) {
    const a = mapPoint(raw.points[0], raw.points[1]);
    const b = mapPoint(raw.points[2], raw.points[3]);
    return { ...style, type: 'line', points: [a.x, a.y, b.x, b.y] };
  }
  if ((raw.subtype === 'Polygon' || raw.subtype === 'PolyLine') && raw.vertices && raw.vertices.length >= 4) {
    const vertices = [];
    for (let i = 0; i + 1 < raw.vertices.length; i += 2) {
      const p = mapPoint(raw.vertices[i], raw.vertices[i + 1]);
      vertices.push(p.x, p.y);
    }
    return { ...style, type: raw.subtype === 'Polygon' ? 'polygon' : 'polyline', vertices };
  }

  // The writer pads /Rect outward by the border width, so undo that here or every round-trip grows the box.
  // It stays in points because /Rect has not been mapped into the pixel frame yet.
  const inset = raw.borderWidth;
  const corners = [
    mapPoint(raw.rect[0] + inset, raw.rect[1] + inset),
    mapPoint(raw.rect[2] - inset, raw.rect[1] + inset),
    mapPoint(raw.rect[0] + inset, raw.rect[3] - inset),
    mapPoint(raw.rect[2] - inset, raw.rect[3] - inset),
  ];
  let left = Infinity; let right = -Infinity;
  let top = Infinity; let bottom = -Infinity;
  for (const c of corners) {
    if (c.x < left) left = c.x;
    if (c.x > right) right = c.x;
    if (c.y < top) top = c.y;
    if (c.y > bottom) bottom = c.y;
  }
  return {
    ...style,
    type: raw.subtype === 'Circle' ? 'circle' : 'square',
    bbox: {
      left, top, right, bottom,
    },
  };
}
