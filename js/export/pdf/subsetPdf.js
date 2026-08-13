import {
  findXrefOffset, parseXref, getPageContentStreams,
  getPageObjects, collectPageTreeObjNums, findRootObjNum,
} from '../../pdf/parsePdfUtils.js';
import {
  extractDict, parseDictEntries, bytesToLatin1,
} from '../../pdf/pdfPrimitives.js';
import { tokenizeContentStream } from '../../pdf/contentStream.js';
import { ObjectCache } from '../../pdf/objectCache.js';
import { createEmbeddedFontType0 } from './writePdfFonts.js';
import { buildOutlineObjects } from './writeOutline.js';
import { ocrPageToPDFStream } from './writePdfText.js';
import { isFillTextRow, isFillTextLine } from '../../fillSign.js';
import {
  buildHighlightAnnotObjects, buildFreeTextAnnotObjects, buildShapeAnnotObjects, buildTextAnnotObjects, buildLinkAnnotObjects, consolidateAnnotations,
} from './writePdfAnnots.js';
import { SHAPE_ANNOT_TYPES, TEXT_MARKUP_ANNOT_TYPES } from '../../addHighlights.js';
import { encodeStreamObject } from './writePdfStreams.js';
import { buildFillItemOps } from './writeFillSignItems.js';
import {
  scrubPageDictText, scrubReferencedObject, catalogKeepEntries, defaultScrubOpts,
} from '../../pdf/metadata/scrubMetadata.js';
import { extractImages } from '../../pdf/parsePdfImages.js';
import { extractPdfAnnotations } from '../../pdf/parsePdfAnnots.js';
import {
  traceReferencedObjects,
  buildFullXrefAndTrailer,
  copyRawObjectBytes,
  parseTrailerInfo,
  buildInfoDictBody,
  readSourceInfoBody,
  patchFileId,
  FILE_ID_PLACEHOLDER,
} from './pdfObjectGraph.js';
import {
  parseExistingContents,
  rewriteContentsStripAndConvert,
  resolvePageResources,
  mergeResources,
  buildReplacementPageDict,
  composePageRotation,
  overlayAnnotationBbox,
  annotLinkTargetsDroppedPage,
} from './pdfPageRewrite.js';
import { createConversionState } from './convertTextRegionsToPaths.js';
import { buildNameDests } from '../../pdf/parseOutline.js';

/** @typedef {import('../../containers/fontContainer.js').DocFonts} DocFonts */

/**
 * Rewrite a page dict's /Annots entry to drop link annotations whose destination resolves to a dropped page.
 * An indirect /Annots array is always inlined, even when no annotation is dropped.
 * @param {string} pageText
 * @param {import('../../pdf/objectCache.js').ObjectCache} objCache
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
 * Walk a page's content streams and collect the names actually invoked by Tf (fonts), Do (xobjects), and gs (ext-gstate) operators.
 * Other resource-name operators (cs/CS/scn/SCN/sh/BMC/BDC) are context-sensitive and deliberately not walked.
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

  // A form XObject resolves resource names via its own /Resources first, then falls through to the page's /Resources (PDF 32000-1:2008 7.8.3).
  // Walk used form XObjects recursively so fall-through names count as used, otherwise pruning drops resources the page actually needs.
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
 * Prune a /Resources dict's /Font, /XObject, and /ExtGState entries to only the names a page's content streams use.
 * Other subdicts pass through unchanged.
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
 * Metadata-scrub configuration; `opts` overrides the Balanced defaults (`defaultScrubOpts`).
 * @typedef {{ opts?: ReturnType<typeof import('../../pdf/metadata/scrubMetadata.js').defaultScrubOpts> }} ScrubConfig
 */

/**
 * Rebuild a PDF containing only the selected pages, optionally with OCR overlay text.
 * @param {Object} params
 * @param {Uint8Array} params.pdfBytes
 * @param {ObjectCache} params.objCache
 * @param {Object} params.xrefEntries
 * @param {any[]} params.pages
 * @param {number[]} params.pageIndices
 * @param {number} params.startingNextObjNum
 * @param {any[]} [params.ocrArr]
 * @param {?any[]} [params.annotationOcrArr=null] - Real per-page OCR geometry for highlight consolidation.
 *    Falls back to `ocrArr`.
 * @param {any[]} [params.pageMetricsArr]
 * @param {*} [params.pdfFonts]
 * @param {string} [params.textMode]
 * @param {boolean} [params.rotateText]
 * @param {boolean} [params.rotateBackground]
 * @param {number} [params.confThreshHigh]
 * @param {number} [params.confThreshMed]
 * @param {number} [params.proofOpacity]
 * @param {boolean} [params.humanReadable=false]
 * @param {Array<Array<Annotation>>} [params.annotationsPages=[]]
 * @param {?Array<{ page: number, bbox: [number, number, number, number] }>} [params.convertRegionsToPaths=null]
 * @param {?number[]} [params.convertFullPages=null] - Page indices to flatten (whole-page conversion that also runs without overlay text).
 * @param {boolean} [params.convertBrokenType3ToPaths=false] - Convert glyphs drawn by broken-ToUnicode Type3 fonts to paths on every page.
 * @param {DocFonts} [params.docFonts] - Per-document fonts for the OCR overlay text layer.
 * @param {(message: string) => void} [params.warningHandler]
 * @param {?Array<import('../../objects/outlineObjects.js').OutlineNode>} [params.outline=null] - Bookmark tree with destinations indexed into the output page order.
 * @param {?ScrubConfig} [params.scrub=null]
 * @param {?Map<number, Array<[number, number, number, number]>>} [params.redactRegionsByPage=null] - Per-page rects whose content is destructively removed and covered with an opaque black box.
 *    Rects are in the source page's user space.
 * @param {?Map<number, Array<[number, number, number, number]>>} [params.textEditRegionsByPage=null] - Per-page user-space rects whose glyphs are removed (native-text edits).
 *    Paths, images, and annotations under the rects are untouched, and no box is painted.
 * @param {?Map<number, {rects: Array<[number, number, number, number]>, pts: Array<{u: ?string, x: number, y: number, f: ?number}>, tol: number}>} [params.textEditGatedByPage=null]
 *    Per-page identity-gated edit rects: a rect removes only glyphs matching the deleted text's identities.
 * @param {?Map<number, Array<{rects: Array<[number, number, number, number]>, body: string, placed: boolean}>>} [params.textEditInsertsByPage=null]
 *    Per-page replacement blocks for replaceText records, spliced in where their glyphs are dropped.
 * @param {?Map<number, Map<string, number>>} [params.editFontRefsByPage=null] - Per-page `/EDFn` font resource entries the inserts draw with.
 * @param {?Array<{objNum: number, content: string | Uint8Array | import('./writePdfStreams.js').PdfBinaryObject}>} [params.editFontObjects=null]
 *    Pre-embedded edit font objects (allocated by the caller before `startingNextObjNum`).
 * @param {?Object<string, ?string>} [params.docInfo=null] - Document information entries overriding the source's; a null value drops that key.
 * @param {?ReturnType<typeof import('./writePdfFormFields.js').buildFormFieldUpdates>} [params.formFieldUpdates=null]
 *    Replacement widget objects carrying edited form-field values, plus the catalog /AcroForm entry to synthesize when the source has none.
 * @param {boolean} [params.flattenFormFields=false] - Paint each visible widget's current appearance into page content,
 *    drop the widget annotations, and omit /AcroForm from the rebuilt catalog.
 */
export async function rebuildPdfSubset({
  pdfBytes, objCache, xrefEntries, pages,
  pageIndices, startingNextObjNum,
  ocrArr, annotationOcrArr = null, pageMetricsArr, pdfFonts,
  textMode, rotateText, rotateBackground,
  confThreshHigh, confThreshMed, proofOpacity,
  humanReadable = false,
  annotationsPages = [],
  convertRegionsToPaths = null,
  convertFullPages = null,
  convertBrokenType3ToPaths = false,
  docFonts,
  warningHandler,
  outline = null,
  scrub = null,
  redactRegionsByPage = null,
  textEditRegionsByPage = null,
  textEditGatedByPage = null,
  textEditInsertsByPage = null,
  editFontRefsByPage = null,
  editFontObjects = null,
  docInfo = null,
  formFieldUpdates = null,
  flattenFormFields = false,
}) {
  const overlayEnabled = !!(ocrArr && pageMetricsArr && pdfFonts);
  let nextObjNum = startingNextObjNum;
  const redactByPage = redactRegionsByPage || new Map();
  const textEditByPage = textEditRegionsByPage || new Map();
  const textEditGated = textEditGatedByPage || new Map();
  // The redaction and text-edit machinery lives in the overlay page loop below, so without overlay data the marked content would pass through verbatim.
  if (redactByPage.size > 0 && !overlayEnabled) {
    throw new Error('Cannot apply redactions: rebuild was invoked without page overlay data.');
  }
  if ((textEditByPage.size > 0 || textEditGated.size > 0) && !overlayEnabled) {
    throw new Error('Cannot apply text edits: rebuild was invoked without page overlay data.');
  }
  if (flattenFormFields && !overlayEnabled) {
    throw new Error('Cannot flatten form fields: rebuild was invoked without page overlay data.');
  }

  let scrubState = null;
  let droppedSigCount = 0;
  if (scrub) {
    let imageMap = new Map();
    try { for (const [n, meta] of Object.entries(extractImages(pdfBytes) || {})) imageMap.set(Number(n), meta.filter || null); } catch { imageMap = new Map(); }
    scrubState = { imageFilter: (n) => imageMap.get(n) || null, ocgCounter: { n: 0 } };
  }

  // The rebuilt catalog is written from scratch, so document-level keys survive only by being listed here.
  /** @type {Array<{ name: string, valueText: string, tracing: string }>} */
  let catalogKeep = [];
  const rootNum0 = findRootObjNum(pdfBytes);
  const catText0 = rootNum0 != null ? objCache.getObjectText(rootNum0) : null;
  const catStart0 = catText0 ? catText0.indexOf('<<') : -1;
  const catBody0 = catStart0 !== -1 ? extractDict(catText0, catStart0).slice(2, -2) : '';
  if (catBody0) {
    catalogKeep = catalogKeepEntries(catBody0, scrub?.opts || {});
    if (!scrub) {
      const xmpEntry = parseDictEntries(catBody0).find((e) => e.name === 'Metadata');
      if (xmpEntry) catalogKeep.push({ name: 'Metadata', valueText: xmpEntry.valueText, tracing: xmpEntry.valueText });
    }
    // On a full identity subset with no supplied outline, the source /Outlines' /Dest refs still resolve (kept pages keep their object numbers), so carry it forward verbatim.
    // A subset or reorder rebuilds bookmarks from the remapped `outline` instead (buildOutlineObjects below).
    const identityPages = pageIndices.length === pages.length && pageIndices.every((v, i) => v === i);
    if (identityPages && !outline) {
      const outlinesEntry = parseDictEntries(catBody0).find((e) => e.name === 'Outlines');
      const outlineRef = outlinesEntry && outlinesEntry.valueText.trim();
      if (outlineRef && /^\d+\s+\d+\s+R$/.test(outlineRef)) {
        catalogKeep.push({ name: 'Outlines', valueText: outlineRef, tracing: outlineRef });
      }
    }
  }

  const infoBody = scrub ? null : buildInfoDictBody(readSourceInfoBody(pdfBytes, objCache), docInfo);
  const { id0Hex: sourceId0Hex } = parseTrailerInfo(pdfBytes, findXrefOffset(pdfBytes));

  // The structure tree can duplicate page text in /ActualText, so carrying it over would expose redacted or pre-edit text.
  if ((redactByPage.size > 0 || textEditByPage.size > 0 || textEditGated.size > 0 || (textEditInsertsByPage?.size ?? 0) > 0)
    && catalogKeep.some((k) => k.name === 'StructTreeRoot' || k.name === 'MarkInfo')) {
    catalogKeep = catalogKeep.filter((k) => k.name !== 'StructTreeRoot' && k.name !== 'MarkInfo');
    if (typeof warningHandler === 'function') {
      warningHandler('Redaction removed the document structure tree (tagged-PDF accessibility data), which can embed page text.');
    }
  }

  const regionsByPage = new Map();
  if (convertRegionsToPaths) {
    for (const r of convertRegionsToPaths) {
      if (!regionsByPage.has(r.page)) regionsByPage.set(r.page, []);
      regionsByPage.get(r.page).push(r.bbox);
    }
  }
  // Pages listed in `convertFullPages` are flattened (whole-page text-to-paths).
  const fullPageSet = new Set(convertFullPages || []);
  const conversionState = (regionsByPage.size > 0 || convertBrokenType3ToPaths || redactByPage.size > 0 || textEditByPage.size > 0
    || textEditGated.size > 0 || (textEditInsertsByPage?.size ?? 0) > 0)
    ? createConversionState() : null;

  const { pageTreeObjNums } = collectPageTreeObjNums(objCache);

  /** @type {Set<number>} */
  const keptPageObjNums = new Set();
  for (const i of pageIndices) {
    if (i >= 0 && i < pages.length) keptPageObjNums.add(pages[i].objNum);
  }

  // With no annotations supplied (a raw-bytes utility call), nothing re-emits links, so both stay null and source /Link objects pass through untouched.
  /** @type {?Array<number|undefined>} */
  let linkPageObjNums = null;
  /** @type {?{ nameDests: Map<string, string>, objNumToIndex: Map<number, number> }} */
  let linkDestInfo = null;
  if (annotationsPages.length > 0) {
    const keptIdx = new Set(pageIndices);
    linkPageObjNums = pages.map((p, idx) => (keptIdx.has(idx) ? p.objNum : undefined));
    const rootNumLink = findRootObjNum(pdfBytes);
    const catTextLink = (rootNumLink != null && objCache.getObjectText(rootNumLink)) || '';
    linkDestInfo = { nameDests: buildNameDests(objCache, catTextLink), objNumToIndex: new Map(pages.map((p, idx) => [p.objNum, idx])) };
  }

  // Assign new object numbers for catalog and pages root
  const catalogObjNum = nextObjNum++;
  const pagesRootObjNum = nextObjNum++;
  const infoObjNum = infoBody ? nextObjNum++ : 0;

  /** @type {Set<PdfFontInfo>} */
  const pdfFontsUsed = new Set();

  /** @type {Array<{objNum: number, content: string | Uint8Array | import('./writePdfStreams.js').PdfBinaryObject}>} */
  const allOutputObjects = [];
  const allocObjNum = () => nextObjNum++;
  /** @param {{objNum: number, content: string | Uint8Array | import('./writePdfStreams.js').PdfBinaryObject}} obj */
  const pushOutputObj = (obj) => allOutputObjects.push(obj);

  /** @type {Set<number>} */
  const modifiedPageObjNums = new Set();

  // Redacted pages' trace-text overrides (see the tracing loop below).
  /** @type {Map<number, string>} */
  const redactTraceTexts = new Map();

  // Appearance streams the flatten bake references, so synthesized ones still ship when the widgets that owned them do not.
  /** @type {Set<number>} */
  const bakedApObjNums = new Set();
  /** @type {Set<number>} */
  const patchSubtypeApObjNums = new Set();

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
      // Box corners may be stored in either order, so use absolute size and a lower-left origin.
      const baseWidth = Math.abs(overlayBox[2] - overlayBox[0]);
      const baseHeight = Math.abs(overlayBox[3] - overlayBox[1]);
      const scaleX = pixelDims ? baseWidth / pixelDims.width : 1;
      const scaleY = pixelDims ? baseHeight / pixelDims.height : 1;
      const tx = Math.min(overlayBox[0], overlayBox[2]);
      const ty = Math.min(overlayBox[1], overlayBox[3]);
      // rotScale is cross-axis because a quarter-turn /Rotate page's pixelDims have swapped axes relative to the box.
      const pageRotate = ((((pageInfo.rotate || 0) % 360) + 360) % 360);
      const rotScale = pixelDims ? baseWidth / pixelDims.height : 1;

      const fillResult = await buildFillItemOps({
        pageAnnotations, pixelDims: pixelDims || null, allocObjNum, pushObj: pushOutputObj, humanReadable, warningHandler,
      });

      const fillTextActive = pageAnnotations.some((a) => a.type === 'freetext' && isFillTextRow(a));

      let textContentObjStr = '';
      let fillTextObjStr = '';
      /** @type {Set<PdfFontInfo>} */
      let pageFontsUsed = new Set();
      if (pageObj && pageObj.lines.length > 0 && textMode !== 'annot') {
        const angle = pageMetricsArr[i].angle || 0;
        // Fill-text lines are re-emitted as a visible stream below, so keeping them in the main layer would make the text extract twice.
        const mainPage = fillTextActive ? { ...pageObj, lines: pageObj.lines.filter((l) => !isFillTextLine(l)) } : pageObj;
        if (mainPage.lines.length > 0) {
          const res = await ocrPageToPDFStream(
            mainPage, pixelDims, pdfFonts, /** @type {'ebook'|'eval'|'proof'|'invis'} */ (textMode), angle, docFonts,
            rotateText, rotateBackground, confThreshHigh, confThreshMed,
          );
          textContentObjStr = res.textContentObjStr || '';
          pageFontsUsed = res.pdfFontsUsed;
        }
      }
      // /GSF resets fill alpha in case the main layer's invisible-text ExtGState precedes it.
      if (fillTextActive && pageObj && pixelDims) {
        const fillLines = pageObj.lines.filter((l) => isFillTextLine(l));
        if (fillLines.length > 0) {
          const res = await ocrPageToPDFStream(
            { ...pageObj, lines: fillLines }, pixelDims, pdfFonts, 'ebook', 0, docFonts,
            false, false, confThreshHigh, confThreshMed,
          );
          if (res.textContentObjStr) {
            fillTextObjStr = `/GSF gs\n${res.textContentObjStr}`;
            for (const f of res.pdfFontsUsed) pageFontsUsed.add(f);
          }
        }
      }

      // Flattening bakes each visible widget's current normal appearance into page content at its /Rect, so the printed look survives while the interactive field is removed below.
      /** @type {?{ops: string, xobjRefs: Map<string, number>, dropObjNums: Set<number>}} */
      let widgetBake = null;
      if (flattenFormFields) {
        const { widgets } = extractPdfAnnotations(objCache, pageInfo.objText);
        if (widgets.length > 0) {
          const xobjRefs = new Map();
          const dropObjNums = new Set();
          const redactRects = redactByPage.get(i) || null;
          const fmtN = (v) => String(Math.round(v * 10000) / 10000);
          let ops = '';
          for (const w of widgets) {
            dropObjNums.add(w.objNum);
            // Hidden / NoView widgets are removed without painting, matching how they display.
            if (w.flags & 2 || w.flags & 32) continue;
            let apNum = w.apRef;
            const repl = formFieldUpdates?.replacements.get(w.objNum);
            if (repl) {
              if (w.ft === 'Btn') {
                const asM = /\/AS\s*\/([^\s/<>[\]()]+)/.exec(repl);
                const state = asM ? asM[1].replace(/#([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) : null;
                apNum = state != null && w.apStates && w.apStates[state] != null ? w.apStates[state] : null;
              } else {
                const apM = /\/AP\s*<<\s*\/N\s+(\d+)\s+\d+\s+R\s*>>/.exec(repl);
                if (apM) {
                  apNum = Number(apM[1]);
                } else if (typeof warningHandler === 'function') {
                  warningHandler(`The value of form field "${w.name}" cannot be drawn by the appearance synthesizer, so the flattened page keeps the field's previous appearance.`);
                }
              }
            }
            if (apNum == null) continue;
            const rx0 = Math.min(w.rect[0], w.rect[2]);
            const ry0 = Math.min(w.rect[1], w.rect[3]);
            const rx1 = Math.max(w.rect[0], w.rect[2]);
            const ry1 = Math.max(w.rect[1], w.rect[3]);
            // A widget under a redaction rect is removed without baking, since its appearance can carry redacted content.
            if (redactRects && redactRects.some((r) => rx0 < r[2] && rx1 > r[0] && ry0 < r[3] && ry1 > r[1])) continue;
            let apText = objCache.getObjectText(apNum);
            // A synthesized appearance lives in formFieldUpdates.newObjects rather than the source file.
            if (!apText) apText = formFieldUpdates?.newObjects.find((o) => o.objNum === apNum && typeof o.content === 'string')?.content ?? null;
            if (!apText) continue;
            const bboxM = /\/BBox\s*\[([^\]]*)\]/.exec(apText);
            const bbox = bboxM ? bboxM[1].trim().split(/\s+/).map(Number) : null;
            if (!bbox || bbox.length < 4 || bbox.some(Number.isNaN)) continue;
            const matrixM = /\/Matrix\s*\[([^\]]*)\]/.exec(apText);
            const mtx = matrixM ? matrixM[1].trim().split(/\s+/).map(Number) : [1, 0, 0, 1, 0, 0];
            // PDF 32000-1:2008 12.5.5: the appearance's /BBox transformed by its /Matrix is fitted to the widget's /Rect.
            let tbx0 = Infinity; let tby0 = Infinity; let tbx1 = -Infinity; let tby1 = -Infinity;
            for (const [x, y] of [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]]]) {
              const txp = mtx[0] * x + mtx[2] * y + mtx[4];
              const typ = mtx[1] * x + mtx[3] * y + mtx[5];
              tbx0 = Math.min(tbx0, txp); tby0 = Math.min(tby0, typ);
              tbx1 = Math.max(tbx1, txp); tby1 = Math.max(tby1, typ);
            }
            const sx = tbx1 - tbx0 > 1e-6 ? (rx1 - rx0) / (tbx1 - tbx0) : 1;
            const sy = tby1 - tby0 > 1e-6 ? (ry1 - ry0) / (tby1 - tby0) : 1;
            const tag = `WgtAP${apNum}`;
            xobjRefs.set(tag, apNum);
            bakedApObjNums.add(apNum);
            if (!/\/Subtype\s*\/Form\b/.test(apText)) patchSubtypeApObjNums.add(apNum);
            ops += `q ${fmtN(sx)} 0 0 ${fmtN(sy)} ${fmtN(rx0 - tbx0 * sx)} ${fmtN(ry0 - tby0 * sy)} cm /${tag} Do Q\n`;
          }
          widgetBake = { ops, xobjRefs, dropObjNums };
        }
      }
      const hasWidgetBake = !!widgetBake;

      const hasText = textContentObjStr && textContentObjStr.length > 0;
      // Redact marks, ink/stamp items, and fill-text freetext rows reach the output as page content rather than annotations, so they must not count here.
      const hasAnnots = pageAnnotations.some((a) => a.type !== 'redact' && a.type !== 'ink' && a.type !== 'stamp'
        && !(a.type === 'freetext' && isFillTextRow(a)));
      const hasFill = !!fillResult || !!fillTextObjStr;
      // Region conversion (`convertRegionsToPaths`), full-page flatten, and broken-Type3 all convert text to paths without an overlay text layer, so this gate must stay independent of `hasText`.
      const hasConvert = convertBrokenType3ToPaths || fullPageSet.has(i) || regionsByPage.has(i);
      const hasRedact = redactByPage.has(i);
      const hasTextEdits = textEditByPage.has(i) || textEditGated.has(i) || !!textEditInsertsByPage?.has(i);
      if (!hasText && !hasAnnots && !hasConvert && !hasRedact && !hasTextEdits && !hasFill && !hasWidgetBake) continue;

      /** @type {string[]|null} */
      let newContentsArray = null;
      /** @type {number|null} */
      let resourcesObjNum = null;
      /** @type {?string} */
      let pageResourcesTraceStr = null;

      if (hasText || hasConvert || hasRedact || hasTextEdits || hasFill || hasWidgetBake) {
        for (const font of pageFontsUsed) pdfFontsUsed.add(font);

        const existingContentsRefs = parseExistingContents(pageInfo.objText, objCache);
        const stripConvertResult = await rewriteContentsStripAndConvert({
          existingContentsRefs,
          pageObjText: pageInfo.objText,
          bboxes: regionsByPage.get(i) || null,
          conversionState,
          objCache,
          allocObjNum,
          pushObj: pushOutputObj,
          humanReadable,
          convertBrokenType3ToPaths,
          redactBboxes: redactByPage.get(i) || null,
          textEditBboxes: textEditByPage.get(i) || null,
          textEditGated: textEditGated.get(i) || null,
          textEditInserts: textEditInsertsByPage?.get(i) || null,
        });

        // When broken-Type3 conversion is the only reason this page is here and nothing changed,
        // leave it for the copy-through loop rather than rewrite it.
        const convertChanged = stripConvertResult.refs !== existingContentsRefs
          || stripConvertResult.xobjEntries.size > 0;
        if (!hasText && !hasAnnots && !convertChanged && !hasRedact && !hasFill && !hasWidgetBake) continue;

        if (hasText || hasFill) {
          const qSaveStr = 'q\n';
          const qSaveObjNum = nextObjNum++;
          allOutputObjects.push({ objNum: qSaveObjNum, content: `${qSaveObjNum} 0 obj\n<</Length ${qSaveStr.length}>>\nstream\n${qSaveStr}endstream\nendobj\n\n` });

          // The text stream is in the post-rotation display frame while the page keeps its source /Rotate.
          let overlayCm = `${scaleX} 0 0 ${scaleY} ${tx} ${ty}`;
          if (pageRotate === 90 || pageRotate === 270) {
            const rotScaleY = pixelDims ? baseHeight / pixelDims.width : 1;
            overlayCm = pageRotate === 90
              ? `0 ${rotScaleY} ${-rotScale} 0 ${tx + baseWidth} ${ty}`
              : `0 ${-rotScaleY} ${rotScale} 0 ${tx} ${ty + baseHeight}`;
          } else if (pageRotate === 180) {
            overlayCm = `${-scaleX} 0 0 ${-scaleY} ${tx + baseWidth} ${ty + baseHeight}`;
          }
          const qOverlayStr = `Q\nq ${overlayCm} cm\n${textContentObjStr}${fillTextObjStr}${fillResult ? fillResult.ops : ''}Q\n`;
          const qOverlayObjNum = nextObjNum++;
          allOutputObjects.push({ objNum: qOverlayObjNum, content: await encodeStreamObject(qOverlayObjNum, qOverlayStr, { humanReadable }) });

          newContentsArray = [
            `${qSaveObjNum} 0 R`,
            ...stripConvertResult.refs,
            `${qOverlayObjNum} 0 R`,
          ];
        } else {
          newContentsArray = [...stripConvertResult.refs];
        }

        // Whether the streams so far leave the graphics state at the page default.
        // The overlay sandwich ends at base, while raw source refs can leave dangling saves.
        let contentAtBaseState = !!(hasText || hasFill);

        if (widgetBake && widgetBake.ops) {
          if (!contentAtBaseState) {
            const qSaveStr = 'q\n';
            const qSaveObjNum = nextObjNum++;
            allOutputObjects.push({ objNum: qSaveObjNum, content: `${qSaveObjNum} 0 obj\n<</Length ${qSaveStr.length}>>\nstream\n${qSaveStr}endstream\nendobj\n\n` });
            newContentsArray.unshift(`${qSaveObjNum} 0 R`);
          }
          const bakeStr = `${contentAtBaseState ? 'q\n' : 'Q\nq\n'}${widgetBake.ops}Q\n`;
          const bakeObjNum = nextObjNum++;
          allOutputObjects.push({ objNum: bakeObjNum, content: await encodeStreamObject(bakeObjNum, bakeStr, { humanReadable }) });
          newContentsArray.push(`${bakeObjNum} 0 R`);
          contentAtBaseState = true;
        }

        // Paint the redaction boxes as the LAST content stream so they cover everything.
        // The content itself is removed from the streams above; the box is the visible marking.
        // Without an overlay text stream there is no balancing q/Q pair around the original content,
        // so the box stream leads with a Q against a fresh q prepended here, the same neutralization the overlay uses for its own text.
        if (hasRedact) {
          if (!contentAtBaseState) {
            const qSaveStr = 'q\n';
            const qSaveObjNum = nextObjNum++;
            allOutputObjects.push({ objNum: qSaveObjNum, content: `${qSaveObjNum} 0 obj\n<</Length ${qSaveStr.length}>>\nstream\n${qSaveStr}endstream\nendobj\n\n` });
            newContentsArray.unshift(`${qSaveObjNum} 0 R`);
          }
          const fmtN = (v) => String(Math.round(v * 10000) / 10000);
          let boxStr = contentAtBaseState ? 'q\n0 g\n' : 'Q\nq\n0 g\n';
          for (const [bx0, by0, bx1, by1] of redactByPage.get(i)) {
            boxStr += `${fmtN(bx0)} ${fmtN(by0)} ${fmtN(bx1 - bx0)} ${fmtN(by1 - by0)} re f\n`;
          }
          boxStr += 'Q\n';
          const boxObjNum = nextObjNum++;
          allOutputObjects.push({ objNum: boxObjNum, content: await encodeStreamObject(boxObjNum, boxStr, { humanReadable }) });
          newContentsArray.push(`${boxObjNum} 0 R`);
        }

        let existingResourcesStr = resolvePageResources(pageInfo.objText, objCache);
        // The original forms still hold the removed text.
        // Any name left in /XObject keeps them referenced, so they ship in the output.
        if ((hasRedact || hasTextEdits) && stripConvertResult.redactedFormNames && stripConvertResult.redactedFormNames.size > 0
          && existingResourcesStr && existingResourcesStr.startsWith('<<')) {
          const resBody = existingResourcesStr.slice(2, -2);
          const loc = locateResourceSubdict(resBody, '/XObject', objCache);
          if (loc) {
            const kept = parseDictEntries(loc.body).filter((e) => !stripConvertResult.redactedFormNames.has(e.name));
            const inner = kept.map((e) => `/${e.name} ${e.valueText}`).join(' ');
            existingResourcesStr = `<<${resBody.slice(0, loc.startInBody)}/XObject<<${inner}>>${resBody.slice(loc.endInBody)}>>`;
          }
        }
        let overlayFontsStr = '';
        for (const font of pageFontsUsed) {
          overlayFontsStr += `${font.name} ${font.objN} 0 R\n`;
        }
        const pageEditFonts = editFontRefsByPage?.get(i);
        if (pageEditFonts) {
          for (const [name, objN] of pageEditFonts) overlayFontsStr += `${name} ${objN} 0 R\n`;
        }
        let overlayXObjectsStr = '';
        for (const [tag, objN] of stripConvertResult.xobjEntries) {
          overlayXObjectsStr += `/${tag} ${objN} 0 R\n`;
        }
        if (stripConvertResult.formClones) {
          for (const [name, objN] of stripConvertResult.formClones) {
            overlayXObjectsStr += `/${name} ${objN} 0 R\n`;
          }
        }
        if (fillResult) overlayXObjectsStr += fillResult.xobjEntriesStr;
        if (widgetBake) {
          for (const [tag, objN] of widgetBake.xobjRefs) overlayXObjectsStr += `/${tag} ${objN} 0 R\n`;
        }
        const overlayExtGStateStr = (hasText ? `/GSO0 <</ca 0.0>>/GSO1 <</ca ${proofOpacity}>>` : '')
          + (fillTextObjStr ? '/GSF <</ca 1 /CA 1>>' : '');
        const mergedResourcesStr = mergeResources(existingResourcesStr, overlayFontsStr, overlayExtGStateStr, objCache, overlayXObjectsStr);

        resourcesObjNum = nextObjNum++;
        allOutputObjects.push({ objNum: resourcesObjNum, content: `${resourcesObjNum} 0 obj\n${mergedResourcesStr}\nendobj\n\n` });
        pageResourcesTraceStr = mergedResourcesStr;
      }

      /** @type {string[]} */
      let extraAnnotRefs = [];
      if (hasAnnots) {
        const outputDims = { width: baseWidth, height: baseHeight };
        // `type == null` is a legacy highlight (UI/consolidated annots omit `type`).
        // 'redact' must never be emitted as an annotation; marks are applied destructively instead.
        const highlightAnns = pageAnnotations.filter((a) => a.type == null || TEXT_MARKUP_ANNOT_TYPES.has(a.type));
        const consolidated = consolidateAnnotations(highlightAnns, annotationOcrArr?.[i] || pageObj);
        const pageForEmit = consolidated.length > 0 ? consolidated : highlightAnns;
        const transformed = pageForEmit.map((a) => overlayAnnotationBbox(a, scaleX, scaleY, tx, ty, pageRotate, baseWidth, baseHeight, rotScale));
        const { objectTexts, annotRefs } = buildHighlightAnnotObjects(transformed, nextObjNum, outputDims, warningHandler, !!scrub);
        for (const t of objectTexts) allOutputObjects.push({ objNum: nextObjNum++, content: t });
        const shapeAnns = pageAnnotations.filter((a) => SHAPE_ANNOT_TYPES.has(a.type))
          .map((a) => overlayAnnotationBbox(a, scaleX, scaleY, tx, ty, pageRotate, baseWidth, baseHeight, rotScale));
        const shapes = buildShapeAnnotObjects(shapeAnns, nextObjNum, outputDims, warningHandler, !!scrub);
        for (const t of shapes.objectTexts) allOutputObjects.push({ objNum: nextObjNum++, content: t });
        const freeTextAnns = pageAnnotations.filter((a) => a.type === 'freetext' && !isFillTextRow(a))
          .map((a) => overlayAnnotationBbox(a, scaleX, scaleY, tx, ty, pageRotate, baseWidth, baseHeight, rotScale));
        const ft = buildFreeTextAnnotObjects(freeTextAnns, nextObjNum, outputDims, warningHandler, !!scrub);
        for (const t of ft.objectTexts) allOutputObjects.push({ objNum: nextObjNum++, content: t });
        const textAnns = pageAnnotations.filter((a) => a.type === 'text')
          .map((a) => overlayAnnotationBbox(a, scaleX, scaleY, tx, ty, pageRotate, baseWidth, baseHeight, rotScale));
        const textAnnots = buildTextAnnotObjects(textAnns, nextObjNum, outputDims, warningHandler, !!scrub);
        for (const t of textAnnots.objectTexts) allOutputObjects.push({ objNum: nextObjNum++, content: t });
        const linkAnns = pageAnnotations.filter((a) => a.type === 'link')
          .map((a) => overlayAnnotationBbox(a, scaleX, scaleY, tx, ty, pageRotate, baseWidth, baseHeight, rotScale));
        const linkAnnots = buildLinkAnnotObjects(linkAnns, nextObjNum, outputDims, linkPageObjNums || [], warningHandler);
        for (const t of linkAnnots.objectTexts) allOutputObjects.push({ objNum: nextObjNum++, content: t });
        extraAnnotRefs = [...annotRefs, ...shapes.annotRefs, ...ft.annotRefs, ...textAnnots.annotRefs, ...linkAnnots.annotRefs];
      }

      const newPageObj = buildReplacementPageDict(pageInfo.objNum, pageInfo.objText, newContentsArray, resourcesObjNum, pagesRootObjNum,
        extraAnnotRefs, objCache, keptPageObjNums, pageMetricsArr[i].rotation || 0, redactByPage.get(i) || null, linkDestInfo,
        widgetBake ? widgetBake.dropObjNums : null);
      allOutputObjects.push({ objNum: pageInfo.objNum, content: newPageObj });
      modifiedPageObjNums.add(pageInfo.objNum);

      // The rebuilt resources text rides along because the trace resolves refs only against the original file and would otherwise never reach the original fonts/xobjects the page still needs.
      // Flattened pages trace their replacement dict too, so the dropped widget and field objects orphan instead of being copied.
      if (hasRedact || hasTextEdits || hasWidgetBake) {
        redactTraceTexts.set(pageInfo.objNum, pageResourcesTraceStr ? `${newPageObj}\n${pageResourcesTraceStr}` : newPageObj);
      }
    }

    for (const pdfFont of pdfFontsUsed) {
      const objStrArr = await createEmbeddedFontType0({
        font: pdfFont.opentype,
        firstObjIndex: pdfFont.objN,
        humanReadable,
        toUnicodeOverride: pdfFont.toUnicodeOverride,
        widthScale: pdfFont.widthScale || 1,
        baseDescriptorObjN: pdfFont.baseDescriptorObjN,
        baseToUnicodeObjN: pdfFont.baseToUnicodeObjN,
      });
      // A variant block has null slots (the base's shared FontDescriptor/FontFile/ToUnicode).
      // Skip them so only real objects are written, leaving the gaps to be free-filled by the rebuilt xref.
      for (let j = 0; j < objStrArr.length; j++) {
        const obj = objStrArr[j];
        if (obj) allOutputObjects.push({ objNum: pdfFont.objN + j, content: obj });
      }
    }
    if (editFontObjects) for (const o of editFontObjects) allOutputObjects.push(o);
  }

  // An appearance stream may omit /Subtype, which readers tolerate for an annotation appearance but not for a page-content XObject.
  // Such streams ship as patched copies under their original numbers.
  for (const apNum of patchSubtypeApObjNums) {
    const entry = xrefEntries[apNum];
    if (!entry || entry.type !== 1) continue;
    const raw = copyRawObjectBytes(pdfBytes, objCache, entry, apNum);
    if (!raw) continue;
    const dictStart = bytesToLatin1(raw).indexOf('<<');
    if (dictStart === -1) continue;
    const insert = '/Subtype/Form';
    const patched = new Uint8Array(raw.length + insert.length);
    patched.set(raw.subarray(0, dictStart + 2), 0);
    for (let ci = 0; ci < insert.length; ci++) patched[dictStart + 2 + ci] = insert.charCodeAt(ci);
    patched.set(raw.subarray(dictStart + 2), dictStart + 2 + insert.length);
    allOutputObjects.push({ objNum: apNum, content: patched });
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
    if (pageMetricsArr?.[i]?.rotation) pageText = composePageRotation(pageText, pageMetricsArr[i].rotation, objCache);

    if (scrub) pageText = scrubPageDictText(pageText);
    rewrittenPageTexts.set(pageInfo.objNum, pageText);
    allOutputObjects.push({ objNum: pageInfo.objNum, content: `${pageInfo.objNum} 0 obj\n${pageText}\nendobj\n\n` });
  }

  const tracingTexts = [];
  for (const i of pageIndices) {
    if (i >= pages.length) continue;
    const rewritten = rewrittenPageTexts.get(pages[i].objNum);
    // Redacted pages trace their replacement dict, never the original: tracing the original would copy the unredacted content streams and dropped annots into the output as orphans.
    tracingTexts.push(rewritten || redactTraceTexts.get(pages[i].objNum) || pages[i].objText);
  }
  // Form clones created for redaction reference fonts/images the original (untraced) form dicts used to reach, so their generated dict texts stand in for those originals here.
  if (conversionState && Array.isArray(conversionState.redactTraceTexts)) {
    for (const t of conversionState.redactTraceTexts) tracingTexts.push(t);
  }

  // Preserve the catalog's /OCProperties (optional-content configuration) on the rebuilt catalog.
  // Without this, ObjectCache.getOffOCGs() finds no OFF groups and every OFF layer (e.g. alternate values or registration/crop marks) paints.
  let ocPropertiesEntry = '';
  const rootObjNum = findRootObjNum(pdfBytes);
  const catText = rootObjNum != null ? objCache.getObjectText(rootObjNum) : null;
  // Trace the keep-by-default catalog structure (accessibility, page labels, viewer prefs) so the scrub does not orphan and silently strip it.
  for (const k of catalogKeep) if (k.tracing) tracingTexts.push(k.tracing);
  // A preserved /Info value can itself be a reference to a string object, which the trace has to reach.
  if (infoBody) tracingTexts.push(infoBody);
  if (catText && !(scrub && scrub.opts && scrub.opts.dropOCProperties)) {
    const ocIdx = catText.indexOf('/OCProperties');
    if (ocIdx >= 0) {
      const after = catText.slice(ocIdx + '/OCProperties'.length).replace(/^\s+/, '');
      if (after.startsWith('<<')) {
        const dict = extractDict(catText, catText.indexOf('<<', ocIdx));
        if (dict) { ocPropertiesEntry = `/OCProperties ${dict}`; tracingTexts.push(dict); }
      } else {
        const refM = /^(\d+)\s+(\d+)\s+R/.exec(after);
        if (refM) { ocPropertiesEntry = `/OCProperties ${refM[1]} ${refM[2]} R`; tracingTexts.push(`${refM[1]} ${refM[2]} R`); }
      }
    }
  }

  let acroFormEntry = '';
  if (catText && !scrub && !flattenFormFields) {
    const acroRefM = /\/AcroForm\s+(\d+)\s+(\d+)\s+R/.exec(catText);
    if (acroRefM) {
      acroFormEntry = `/AcroForm ${acroRefM[1]} ${acroRefM[2]} R`;
      tracingTexts.push(`${acroRefM[1]} ${acroRefM[2]} R`);
    } else {
      const acroIdx = catText.indexOf('/AcroForm');
      if (acroIdx >= 0) {
        const acroDict = extractDict(catText, catText.indexOf('<<', acroIdx));
        if (acroDict) { acroFormEntry = `/AcroForm ${acroDict}`; tracingTexts.push(acroDict); }
      }
    }
  }
  if (!acroFormEntry && !flattenFormFields && formFieldUpdates?.catalogInsertRef) acroFormEntry = formFieldUpdates.catalogInsertRef.trim();
  // Replacements reuse the source object numbers, so the dedupe below drops the unedited originals from the verbatim-copy set.
  // A flatten ships neither, keeping only the appearance streams its bake references.
  if (formFieldUpdates && !flattenFormFields) {
    for (const [objNum, content] of formFieldUpdates.replacements) allOutputObjects.push({ objNum, content });
    for (const o of formFieldUpdates.newObjects) allOutputObjects.push(o);
  } else if (formFieldUpdates) {
    for (const o of formFieldUpdates.newObjects) if (bakedApObjNums.has(o.objNum)) allOutputObjects.push(o);
  }

  // When scrubbing, scrubPageDictText strips the scrub's drop-keys from the text the BFS scans,
  // so the trace skips refs under those keys (e.g. a StructElem's /Info to a document-properties dict)
  // and their targets orphan instead of being copied verbatim.
  const referencedObjNums = traceReferencedObjects(
    tracingTexts, objCache, pageTreeObjNums, scrub ? scrubPageDictText : null,
  );

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

    if (scrub) {
      // Drop whole metadata-bearing objects outright (their host refs are scrubbed, so they orphan):
      // XMP streams, embedded-file attachments, and digital signatures (a strip invalidates a signature).
      const objTextForScrub = objCache.getObjectText(objNum);
      if (objTextForScrub && /\/Type\s*\/(Metadata|Filespec|EmbeddedFile)\b/.test(objTextForScrub)) continue;
      if (objTextForScrub && /\/Type\s*\/Sig\b/.test(objTextForScrub)) { droppedSigCount += 1; continue; }
      const replacement = scrubReferencedObject(pdfBytes, objCache, entry, objNum, scrubState);
      if (replacement != null) { allOutputObjects.push({ objNum, content: replacement }); continue; }
    }

    if (entry.type === 1) {
      const rawCopy = copyRawObjectBytes(pdfBytes, objCache, entry, objNum);
      if (!rawCopy) continue;
      allOutputObjects.push({ objNum, content: rawCopy });
    } else if (entry.type === 2) {
      // ObjStm object: write as standalone
      const objText = objCache.getObjectText(objNum);
      if (!objText) continue;
      allOutputObjects.push({ objNum, content: `${objNum} 0 obj\n${objText}\nendobj\n\n` });
    }
  }

  if (scrub && droppedSigCount > 0 && typeof warningHandler === 'function') {
    warningHandler(`Removing metadata invalidated and dropped ${droppedSigCount} digital signature(s).`);
  }

  const keptPageRefs = [];
  const pageObjNumByIndex = [];
  for (const i of pageIndices) {
    if (i >= pages.length) continue;
    keptPageRefs.push(`${pages[i].objNum} 0 R`);
    pageObjNumByIndex.push(pages[i].objNum);
  }

  // The caller supplies `outline` with destinations already indexed into the output page order, so each /Dest maps to the kept page's preserved object number.
  let outlineEntry = '';
  if (outline && outline.length) {
    const built = buildOutlineObjects(outline, pageObjNumByIndex, nextObjNum);
    if (built) {
      for (const o of built.objects) allOutputObjects.push(o);
      nextObjNum = built.nextObjNum;
      outlineEntry = ` /Outlines ${built.rootObjNum} 0 R`;
    }
  }

  const catalogKeepEntry = catalogKeep.map((k) => `/${k.name} ${k.valueText}`).join(' ');
  allOutputObjects.push({ objNum: catalogObjNum, content: `${catalogObjNum} 0 obj\n<</Type/Catalog/Pages ${pagesRootObjNum} 0 R${ocPropertiesEntry ? ` ${ocPropertiesEntry}` : ''}${acroFormEntry ? ` ${acroFormEntry}` : ''}${catalogKeepEntry ? ` ${catalogKeepEntry}` : ''}${outlineEntry}>>\nendobj\n\n` });
  allOutputObjects.push({ objNum: pagesRootObjNum, content: `${pagesRootObjNum} 0 obj\n<</Type/Pages/Kids[${keptPageRefs.join(' ')}]/Count ${keptPageRefs.length}>>\nendobj\n\n` });
  if (infoBody) allOutputObjects.push({ objNum: infoObjNum, content: `${infoObjNum} 0 obj\n<<${infoBody}>>\nendobj\n\n` });

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
  let totalSize = nextObjNum;
  for (const o of allOutputObjects) {
    if (o.objNum + 1 > totalSize) totalSize = o.objNum + 1;
  }
  // The output is a derivative of the same source document, so it keeps the permanent element and recomputes the changing one.
  const idHexPair = scrub ? null : /** @type {[string, string]} */ ([sourceId0Hex || FILE_ID_PLACEHOLDER, FILE_ID_PLACEHOLDER]);
  const xrefStr = buildFullXrefAndTrailer(xrefEntryList, totalSize, `${catalogObjNum} 0 R`, newXrefOffset,
    { infoRef: infoBody ? `${infoObjNum} 0 R` : null, idHexPair });
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

  patchFileId(result, xrefStr, newXrefOffset, 0, newXrefOffset);

  return result.buffer;
}

/**
 * Produce a new PDF containing only the specified pages of the input PDF.
 *
 * @param {ArrayBuffer | Uint8Array} basePdfData
 * @param {number[]} pageIndices
 * @param {{ outline?: Array<import('../../objects/outlineObjects.js').OutlineNode>, scrub?: ScrubConfig, warningHandler?: (message: string) => void }} [options]
 *   `outline`: a bookmark tree written as the output's `/Outlines`.
 *   Its destinations must be indices into the output page sequence (`pageIndices`), so callers remap page-index dests to output order first.
 *   `scrub`: when set, sanitizes identifying metadata (see `stripMetadataPdf`). `warningHandler`: reports dropped signatures.
 */
export async function subsetPdf(basePdfData, pageIndices, options = {}) {
  const pdfBytes = basePdfData instanceof Uint8Array ? basePdfData : new Uint8Array(basePdfData);

  const xrefOffset = findXrefOffset(pdfBytes);
  const xrefEntries = parseXref(pdfBytes, xrefOffset);
  const objCache = new ObjectCache(pdfBytes, xrefEntries);
  // The object-number scan below needs the complete xref, so finish the deferred repair.
  objCache.ensureXrefRepaired();
  const pages = getPageObjects(objCache);

  if (pageIndices.length === 0) throw new Error('subsetPdf: pageIndices is empty');
  for (const i of pageIndices) {
    if (!Number.isInteger(i) || i < 0 || i >= pages.length) {
      throw new RangeError(`subsetPdf: page ${i} out of range (0-${pages.length - 1})`);
    }
  }

  let startingNextObjNum = 0;
  for (const k in xrefEntries) {
    const n = Number(k);
    if (n > startingNextObjNum) startingNextObjNum = n;
  }
  startingNextObjNum += 1;

  return rebuildPdfSubset({
    pdfBytes,
    objCache,
    xrefEntries,
    pages,
    pageIndices,
    startingNextObjNum,
    outline: options.outline || null,
    scrub: options.scrub || null,
    warningHandler: options.warningHandler,
  });
}

/**
 * Produce a metadata-sanitized copy of a PDF: a full object-level rewrite (dropping prior revisions, orphans, /Info, catalog XMP, /Encrypt)
 * with per-object metadata scrubbed and embedded-image EXIF stripped.
 * Keeps every page unchanged.
 * `opts` overrides the Balanced defaults (see `defaultScrubOpts`).
 * @param {Uint8Array|ArrayBuffer} basePdfData
 * @param {object} [opts]
 * @param {(message: string) => void} [warningHandler] - Called once with a summary if signatures were dropped.
 * @returns {Promise<Uint8Array>}
 */
export async function stripMetadataPdf(basePdfData, opts = {}, warningHandler = undefined) {
  const pdfBytes = basePdfData instanceof Uint8Array ? basePdfData : new Uint8Array(basePdfData);
  const xrefEntries = parseXref(pdfBytes, findXrefOffset(pdfBytes));
  const objCache = new ObjectCache(pdfBytes, xrefEntries);
  objCache.ensureXrefRepaired();
  const pageCount = getPageObjects(objCache).length;
  const allPages = Array.from({ length: pageCount }, (_, i) => i);
  const out = await subsetPdf(pdfBytes, allPages, { scrub: { opts: { ...defaultScrubOpts(), ...opts } }, warningHandler });
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}
