import {
  findXrefOffset, parseXref, sourceXrefIsWellFormed, xrefSectionIsStream, getPageObjects, findRootObjNum,
} from '../../pdf/parsePdfUtils.js';
import { byteIndexOf, mergeResources } from '../../pdf/pdfPrimitives.js';
import {
  pageRectToContentRect, mapImageDelete, mapPathDelete,
} from '../../pdf/pageGeometry.js';
import { ObjectCache } from '../../pdf/objectCache.js';
import { createPdfFontRefs, createEmbeddedFontType0 } from './writePdfFonts.js';
import { ocrPageToPDFStream } from './writePdfText.js';
import { isFillTextRow, isFillTextLine } from '../../fillSign.js';
import {
  buildHighlightAnnotObjects, buildFreeTextAnnotObjects, buildShapeAnnotObjects, buildTextAnnotObjects, buildLinkAnnotObjects, consolidateAnnotations,
} from './writePdfAnnots.js';
import { buildFormFieldUpdates } from './writePdfFormFields.js';
import { buildFillItemOps } from './writeFillSignItems.js';
import { SHAPE_ANNOT_TYPES, TEXT_MARKUP_ANNOT_TYPES } from '../../addHighlights.js';
import { encodeStreamObject } from './writePdfStreams.js';
import {
  parseTrailerInfo,
  buildIncrementalXrefAndTrailer,
  buildInfoDictBody,
  readSourceInfoBody,
  patchFileId,
  locateObjectByteRange,
  traceReferencedObjects,
  FILE_ID_PLACEHOLDER,
} from './pdfObjectGraph.js';
import {
  parseExistingContents, rewriteContentsStripAndConvert, resolvePageResources, buildReplacementPageDict, overlayAnnotationBbox, pageHasLiftedSourceAnnots,
} from './pdfPageRewrite.js';
import { createConversionState } from './convertTextRegionsToPaths.js';
import { rebuildPdfSubset } from './subsetPdf.js';
import { buildOutlineObjects } from './writeOutline.js';
import { buildNameDests } from '../../pdf/parseOutline.js';
import { substituteFaceOutputObjects, recordFaceTag } from '../../pdf/substituteFaces.js';

/**
 * Insert OCR text layers into an existing PDF.
 * The output is an incremental update when possible, and a full rebuild when the source or the requested output demands it.
 *
 * @param {Object} params
 * @param {ArrayBuffer | Uint8Array} params.basePdfData - Read in place, never written to.
 * @param {Array<OcrPage>} params.ocrArr - OCR data for each page (indexed to match `basePdfData`).
 * @param {?Array<OcrPage>} [params.annotationOcrArr=null] - OCR geometry used for highlight consolidation, since `ocrArr` can be emptied for clean text-native pages.
 *   Falls back to `ocrArr` when null.
 * @param {Array<PageMetrics>} params.pageMetricsArr
 * @param {?Array<number>} [params.pageArr=null] - 0-based source page indices to include, in output order.
 *   Defaults to all pages.
 * @param {("ebook"|"eval"|"proof"|"invis"|"annot")} [params.textMode="invis"]
 * @param {boolean} [params.rotateText=true]
 * @param {boolean} [params.rotateBackground=false]
 * @param {number} [params.confThreshHigh=85]
 * @param {number} [params.confThreshMed=75]
 * @param {number} [params.proofOpacity=0.8]
 * @param {boolean} [params.humanReadable=false]
 * @param {Array<Array<Annotation>>} [params.annotationsPages=[]]
 * @param {Array<Array<ContentEdit>>} [params.contentEditsPages=[]] - Text, image, and path edit records, applied destructively to the page content streams.
 * @param {?Array<{ page: number, bbox: [number, number, number, number] }>} [params.convertRegionsToPaths=null]
 *   Source-PDF text whose glyph origin falls inside any of these user-space bboxes is converted to paths.
 *   Glyphs from non-embedded or unsupported fonts are left as text.
 * @param {boolean} [params.convertTextToPaths=false] - When true and `convertRegionsToPaths` is not supplied, all source text on every page is converted to paths.
 * @param {?number[]} [params.convertFullPages=null] - Page indices whose source text is converted to paths in full, including pages with no overlay text.
 * @param {boolean} [params.convertBrokenType3ToPaths=false] - Converts glyphs drawn by broken-ToUnicode Type3 fonts to paths on every page, so their gibberish text stops being selectable.
 * @param {import('../../containers/fontContainer.js').DocFonts} [params.docFonts]
 * @param {(message: string) => void} [params.warningHandler]
 * @param {?Array<import('../../objects/outlineObjects.js').OutlineNode>} [params.outline=null] - Bookmark tree with destinations indexed into the output page order.
 *   Null leaves the source's bookmarks unchanged; an empty array strips them.
 * @param {?{ opts?: ReturnType<typeof import('../../pdf/metadata/scrubMetadata.js').defaultScrubOpts> }} [params.scrub=null]
 *   When set, scrubs identifying metadata and forces a full rebuild.
 * @param {?Object<string, ?string>} [params.docInfo=null] - Document information entries overriding the source's; a null value drops that key.
 * @param {boolean} [params.flattenFormFields=false] - Paint each visible form widget's current appearance into the page content,
 *   then remove the widget annotations and the catalog's /AcroForm, so fields stop being interactive. Forces a full rebuild.
 * @returns {Promise<ArrayBuffer>}
 */
export async function overlayPdfText({
  basePdfData,
  ocrArr,
  annotationOcrArr = null,
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
  contentEditsPages = [],
  convertRegionsToPaths = null,
  convertTextToPaths = false,
  convertFullPages = null,
  convertBrokenType3ToPaths = false,
  docFonts,
  warningHandler,
  outline = null,
  scrub = null,
  docInfo = null,
  flattenFormFields = false,
}) {
  const pdfBytes = basePdfData instanceof Uint8Array ? basePdfData : new Uint8Array(basePdfData);

  // Step 1: Parse the base PDF structure
  const xrefOffset = findXrefOffset(pdfBytes);
  const xrefEntries = parseXref(pdfBytes, xrefOffset);
  const objCache = new ObjectCache(pdfBytes, xrefEntries);
  // The object-number scan below needs the complete xref, so finish the deferred repair.
  objCache.ensureXrefRepaired();
  const pages = getPageObjects(objCache);
  const { rootRef, infoRef: sourceInfoRef, id0Hex: sourceId0Hex } = parseTrailerInfo(pdfBytes, xrefOffset);

  // Default to all pages in the source PDF when pageArr is not supplied.
  const effectivePageArr = pageArr
    ? pageArr.filter((i) => i >= 0 && i < pages.length)
    : Array.from({ length: pages.length }, (_, i) => i);

  // Whole-page text-to-paths convenience: synthesize one full-page region per page from its CropBox/MediaBox.
  // An explicitly supplied convertRegionsToPaths wins.
  let regionsForPaths = convertRegionsToPaths;
  if (convertTextToPaths && !regionsForPaths) {
    regionsForPaths = effectivePageArr.map((i) => {
      const box = pages[i].cropBox || pages[i].mediaBox || [0, 0, 612, 792];
      return { page: i, bbox: [box[0], box[1], box[2], box[3]] };
    });
  }

  // Per-page flatten: synthesize a whole-page region for each listed page,
  // same construction as the convertTextToPaths block above but scoped to convertFullPages.
  const fullPageSet = new Set(convertFullPages || []);
  if (fullPageSet.size > 0) {
    const fullRegions = [];
    for (const i of effectivePageArr) {
      if (!fullPageSet.has(i)) continue;
      const box = pages[i].cropBox || pages[i].mediaBox || [0, 0, 612, 792];
      fullRegions.push({ page: i, bbox: /** @type {[number, number, number, number]} */ ([box[0], box[1], box[2], box[3]]) });
    }
    regionsForPaths = regionsForPaths ? regionsForPaths.concat(fullRegions) : fullRegions;
  }

  // Redaction marks (page-pixel frame) become per-page erase rects in source content space, by inverting the box-origin + /Rotate transform the importer bakes into its initial CTM (parseSinglePage).
  // User rotation is NOT part of this mapping: marks live in the pre-user-rotation frame, and user rotation is written as /Rotate only (which also forces the rebuild path below).
  /** @type {Map<number, Array<[number, number, number, number]>>} */
  const redactRegionsByPage = new Map();
  for (const i of effectivePageArr) {
    const marks = (annotationsPages[i] || []).filter((a) => a.type === 'redact');
    if (marks.length === 0) continue;
    const dims = pageMetricsArr?.[i]?.dims;
    if (!dims) throw new Error(`Cannot apply redactions on page ${i}: page dimensions are unknown.`);
    const box = pages[i].cropBox || pages[i].mediaBox || [0, 0, 612, 792];
    /** @type {Array<[number, number, number, number]>} */
    const rects = [];
    for (const m of marks) {
      const mapped = pageRectToContentRect(m.bbox, dims, box, pages[i].rotate || 0);
      if (mapped) rects.push(mapped);
    }
    if (rects.length > 0) redactRegionsByPage.set(i, rects);
  }

  /** @type {Map<number, Array<TextPatch>>} */
  const textPatchesByPage = new Map();
  for (const i of effectivePageArr) {
    const records = /** @type {Array<TextPatch>} */ ((contentEditsPages[i] || []).filter((r) => r && r.type === 'patchText'));
    if (records.length > 0) textPatchesByPage.set(i, records);
  }

  /** @type {Map<number, Array<{rect: [number, number, number, number], sites: Array<{objNum: ?number, rect: [number, number, number, number]}>, tol: number}>>} */
  const imageDeleteByPage = new Map();
  for (const i of effectivePageArr) {
    const records = (contentEditsPages[i] || []).filter((r) => r && r.type === 'deleteImage');
    if (records.length === 0) continue;
    const dims = pageMetricsArr?.[i]?.dims;
    if (!dims) throw new Error(`Cannot apply image deletions on page ${i}: page dimensions are unknown.`);
    const box = pages[i].cropBox || pages[i].mediaBox || [0, 0, 612, 792];
    const gates = [];
    for (const rec of records) {
      const gate = mapImageDelete(/** @type {ImageEditDelete} */ (rec), dims, box, pages[i].rotate || 0);
      if (gate) gates.push(gate);
    }
    if (gates.length > 0) imageDeleteByPage.set(i, gates);
  }

  /** @type {Map<number, Array<{rect: [number, number, number, number], sites: Array<{rect: [number, number, number, number], paint: string, commands: number}>, tol: number}>>} */
  const pathDeleteByPage = new Map();
  for (const i of effectivePageArr) {
    const records = (contentEditsPages[i] || []).filter((r) => r && r.type === 'deletePath');
    if (records.length === 0) continue;
    const dims = pageMetricsArr?.[i]?.dims;
    if (!dims) throw new Error(`Cannot apply path deletions on page ${i}: page dimensions are unknown.`);
    const box = pages[i].cropBox || pages[i].mediaBox || [0, 0, 612, 792];
    const gates = [];
    for (const rec of records) {
      const gate = mapPathDelete(/** @type {PathEditDelete} */ (rec), dims, box, pages[i].rotate || 0);
      if (gate) gates.push(gate);
    }
    if (gates.length > 0) pathDeleteByPage.set(i, gates);
  }

  // Step 2: Determine next available object number.
  let nextObjNum = 0;
  for (const k in xrefEntries) {
    const n = Number(k);
    if (n > nextObjNum) nextObjNum = n;
  }
  nextObjNum += 1;

  // Step 3: Create font references starting at nextObjNum when writing text overlay.
  const needsOcrFonts = !!ocrArr?.some((p) => p?.lines?.length > 0) && textMode !== 'annot';
  /** @type {Object<string, PdfFontFamily>} */
  let pdfFonts = {};
  if (needsOcrFonts) {
    const fontRefs = await createPdfFontRefs(nextObjNum, ocrArr, docFonts);
    pdfFonts = fontRefs.pdfFonts;
    nextObjNum = fontRefs.objectI;
  }

  // The export embeds the program bytes each substitute face was drawn with, from the object cache.
  const faces = await substituteFaceOutputObjects(objCache, [...textPatchesByPage.values()].flat(), nextObjNum, humanReadable);
  nextObjNum = faces.nextObjNum;
  /** @type {Map<number, Map<string, number>>} */
  const editFontRefsByPage = new Map();
  for (const [i, records] of textPatchesByPage) {
    /** @type {Map<string, number>} */
    const refs = new Map();
    for (const rec of records) for (const f of rec.fonts || []) refs.set(`/${recordFaceTag(f)}`, /** @type {number} */ (faces.refs.get(recordFaceTag(f))));
    if (refs.size > 0) editFontRefsByPage.set(i, refs);
  }
  const editFontObjects = faces.objects;

  // Incremental update appends new objects but leaves the source's trailer chain in
  // place. For encrypted sources that means /Encrypt stays active and readers will
  // try to decrypt the unencrypted overlay objects with the file key, garbling them.
  // Rebuild from scratch (dropping /Encrypt) to keep the output consistently plain.
  const sourceEncrypted = !!objCache.encryptionKey;

  // Incremental update keeps the source's bytes (including its malformed startxref/trailer) in place.
  // Only rebuild can give the output a clean xref.
  const sourceXrefMalformed = !sourceXrefIsWellFormed(pdfBytes);

  // Linearization declares the original file's exact length in /L.
  // Appending an incremental update breaks that invariant
  // and Acrobat shows "this document is being repaired" on every open.
  // Rebuild instead so the output has no stale linearization dictionary.
  const sourceLinearized = byteIndexOf(pdfBytes.subarray(0, Math.min(1024, pdfBytes.length)), '/Linearized') !== -1;

  // If exporting a proper subset of pages (fewer pages than the source, or
  // a reordering), rebuild the PDF instead of incremental update.
  // Incremental can only extend existing pages in place — it can't drop or reorder them.
  const isSubset = effectivePageArr.length !== pages.length
    || effectivePageArr.some((v, idx) => v !== idx);
  const hasUserRotation = !!(pageMetricsArr && pageMetricsArr.some((pm) => pm && pm.rotation));
  // Scrub and redaction must rebuild because an incremental update preserves the source bytes, leaving the old metadata and the redacted content recoverable.
  const formFieldUpdates = buildFormFieldUpdates({
    objCache,
    pages,
    pageIndices: effectivePageArr,
    annotationsPages,
    startingNextObjNum: nextObjNum,
    catalogObjNum: findRootObjNum(pdfBytes),
    warningHandler,
  });
  nextObjNum = formFieldUpdates.nextObjNum;

  if (isSubset || sourceEncrypted || sourceXrefMalformed || sourceLinearized || hasUserRotation || scrub || redactRegionsByPage.size > 0
    || flattenFormFields) {
    return rebuildPdfSubset({
      pdfBytes,
      objCache,
      xrefEntries,
      pages,
      pageIndices: effectivePageArr,
      outline,
      ocrArr,
      annotationOcrArr,
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
      docFonts,
      convertRegionsToPaths: regionsForPaths,
      convertFullPages,
      convertBrokenType3ToPaths,
      warningHandler,
      scrub,
      redactRegionsByPage,
      textPatchesByPage,
      imageDeleteByPage,
      pathDeleteByPage,
      editFontRefsByPage,
      editFontObjects,
      docInfo,
      formFieldUpdates,
      flattenFormFields,
    });
  }

  /** @type {Set<number>} */
  const scrubObjNums = new Set();

  const regionsByPage = new Map();
  if (regionsForPaths) {
    for (const r of regionsForPaths) {
      if (!regionsByPage.has(r.page)) regionsByPage.set(r.page, []);
      regionsByPage.get(r.page).push(r.bbox);
    }
  }
  const conversionState = (regionsByPage.size > 0 || convertBrokenType3ToPaths || imageDeleteByPage.size > 0 || pathDeleteByPage.size > 0
    || textPatchesByPage.size > 0)
    ? createConversionState() : null;

  // With no annotations supplied, nothing re-emits links, so both stay null and source /Link objects pass through untouched.
  // This path is always the full document in source order (subsets delegate to `rebuildPdfSubset`), so the page map is the identity.
  /** @type {?Array<number|undefined>} */
  let linkPageObjNums = null;
  /** @type {?{ nameDests: Map<string, string>, objNumToIndex: Map<number, number> }} */
  let linkDestInfo = null;
  if (annotationsPages.length > 0) {
    linkPageObjNums = pages.map((p) => p.objNum);
    const rootNumLink = findRootObjNum(pdfBytes);
    const catTextLink = (rootNumLink != null && objCache.getObjectText(rootNumLink)) || '';
    linkDestInfo = { nameDests: buildNameDests(objCache, catTextLink), objNumToIndex: new Map(pages.map((p, idx) => [p.objNum, idx])) };
  }

  /** @type {Set<PdfFontInfo>} */
  const pdfFontsUsed = new Set();

  // All new objects to append (font objects are added later)
  /** @type {Array<{objNum: number, content: string | Uint8Array | import('./writePdfStreams.js').PdfBinaryObject}>} */
  const newObjects = [];
  const allocObjNum = () => nextObjNum++;
  /** @param {{objNum: number, content: string | Uint8Array | import('./writePdfStreams.js').PdfBinaryObject}} obj */
  const pushNewObj = (obj) => newObjects.push(obj);

  // Step 4: For each page, generate text content and build modified objects
  for (const i of effectivePageArr) {
    const pageInfo = pages[i];
    const pageObj = ocrArr?.[i];
    const pageMetrics = pageMetricsArr?.[i] || null;
    const pixelDims = pageMetrics?.dims;
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
      pageAnnotations, pixelDims: pixelDims || null, allocObjNum, pushObj: pushNewObj, humanReadable, warningHandler,
    });

    const fillTextActive = pageAnnotations.some((a) => a.type === 'freetext' && isFillTextRow(a));

    let textContentObjStr = '';
    let fillTextObjStr = '';
    /** @type {Set<PdfFontInfo>} */
    let pageFontsUsed = new Set();
    if (pageObj && pageObj.lines.length > 0 && textMode !== 'annot' && pixelDims) {
      const angle = pageMetrics?.angle || 0;
      // The fill-text lines are re-emitted as visible text below, so leaving them in the main layer would duplicate the text on export.
      const mainPage = fillTextActive ? { ...pageObj, lines: pageObj.lines.filter((l) => !isFillTextLine(l)) } : pageObj;
      if (mainPage.lines.length > 0) {
        const res = await ocrPageToPDFStream(
          mainPage, pixelDims, pdfFonts, textMode, angle, docFonts,
          rotateText, rotateBackground, confThreshHigh, confThreshMed,
        );
        textContentObjStr = res.textContentObjStr || '';
        pageFontsUsed = res.pdfFontsUsed;
      }
    }
    // /GSF resets fill alpha, which a proof/eval-mode main text stream sets in the graphics state both streams share.
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

    const hasText = textContentObjStr && textContentObjStr.length > 0;
    // These types are applied to the page content rather than written as annotations.
    const hasAnnots = pageAnnotations.some((a) => a.type !== 'redact' && a.type !== 'ink' && a.type !== 'stamp'
      && !(a.type === 'freetext' && isFillTextRow(a)));
    const hasFill = !!fillResult || !!fillTextObjStr;
    const hasConvert = regionsByPage.has(i) || convertBrokenType3ToPaths;
    const hasTextEdits = textPatchesByPage.has(i);
    // Deleting a page's last annotation leaves nothing to re-emit, so no condition above marks the page as changed.
    // Its source /Annots still holds the lifted copies, which a skip here would pass through and resurrect.
    const hasLiftedAnnotsToDrop = annotationsPages.length > 0 && pageHasLiftedSourceAnnots(pageInfo.objText, objCache, linkDestInfo);
    const hasImageDeletes = imageDeleteByPage.has(i);
    const hasPathDeletes = pathDeleteByPage.has(i);
    if (!hasText && !hasAnnots && !hasConvert && !hasTextEdits && !hasImageDeletes && !hasPathDeletes && !hasFill && !hasLiftedAnnotsToDrop) continue;

    /** @type {string[]|null} */
    let newContentsArray = null;
    /** @type {number|null} */
    let resourcesObjNum = null;

    if (hasText || hasConvert || hasTextEdits || hasImageDeletes || hasPathDeletes || hasFill) {
      for (const font of pageFontsUsed) pdfFontsUsed.add(font);

      const existingContentsRefs = parseExistingContents(pageInfo.objText, objCache);
      const stripConvertResult = await rewriteContentsStripAndConvert({
        existingContentsRefs,
        pageObjText: pageInfo.objText,
        bboxes: regionsByPage.get(i) || null,
        conversionState,
        objCache,
        allocObjNum,
        pushObj: pushNewObj,
        humanReadable,
        convertBrokenType3ToPaths,
        imageDeletes: imageDeleteByPage.get(i) || null,
        pathDeletes: pathDeleteByPage.get(i) || null,
        textPatches: textPatchesByPage.get(i) || null,
        editFontRefs: editFontRefsByPage.get(i) || null,
      });
      if (hasTextEdits || hasImageDeletes || hasPathDeletes) {
        for (const o of stripConvertResult.supersededContentObjNums || []) scrubObjNums.add(o);
      }
      for (const o of stripConvertResult.deletedImageObjNums || []) scrubObjNums.add(o);

      // When broken-Type3 conversion is the *only* reason this page is here
      // (no overlay text, no annotations, no explicit region) and nothing actually changed,
      // leave the page untouched rather than re-emitting it verbatim.
      const convertChanged = stripConvertResult.refs !== existingContentsRefs
        || stripConvertResult.xobjEntries.size > 0;
      // A flatten page (fullPageSet) that came out unchanged is left untouched.
      // An explicitly supplied region is re-emitted rather than skipped.
      if (!hasText && !hasAnnots && !convertChanged && !hasFill && (!regionsByPage.has(i) || fullPageSet.has(i))) continue;

      /** @type {string[]} */
      const contentsArray = [];
      let qSaveObjNum = null;
      let qOverlayObjNum = null;
      if (hasText || hasFill) {
        const qSaveStr = 'q\n';
        qSaveObjNum = allocObjNum();
        pushNewObj({ objNum: qSaveObjNum, content: `${qSaveObjNum} 0 obj\n<</Length ${qSaveStr.length}>>\nstream\n${qSaveStr}endstream\nendobj\n\n` });

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
        qOverlayObjNum = allocObjNum();
        pushNewObj({ objNum: qOverlayObjNum, content: await encodeStreamObject(qOverlayObjNum, qOverlayStr, { humanReadable }) });

        contentsArray.push(`${qSaveObjNum} 0 R`, ...stripConvertResult.refs, `${qOverlayObjNum} 0 R`);
      } else {
        contentsArray.push(...stripConvertResult.refs);
      }
      newContentsArray = contentsArray;

      // Merge overlay fonts + ExtGState (+ converted-glyph XObjects) into the page's /Resources.
      const existingResourcesStr = resolvePageResources(pageInfo.objText, objCache);
      let overlayFontsStr = '';
      for (const font of pageFontsUsed) {
        overlayFontsStr += `${font.name} ${font.objN} 0 R\n`;
      }
      const pageEditFonts = editFontRefsByPage.get(i);
      if (pageEditFonts) {
        for (const [name, objN] of pageEditFonts) overlayFontsStr += `${name} ${objN} 0 R\n`;
      }
      let overlayXObjectsStr = '';
      for (const [tag, objN] of stripConvertResult.xobjEntries) {
        overlayXObjectsStr += `/${tag} ${objN} 0 R\n`;
      }
      // Redirects for Form XObjects that were cloned for path conversion.
      // PDF dicts use last-wins semantics for duplicate keys, so an entry like
      // `/Fm2 origN 0 R\n/Fm2 cloneN 0 R` resolves to the clone.
      if (stripConvertResult.formClones) {
        for (const [name, objN] of stripConvertResult.formClones) {
          overlayXObjectsStr += `/${name} ${objN} 0 R\n`;
        }
      }
      if (fillResult) overlayXObjectsStr += fillResult.xobjEntriesStr;
      const overlayExtGStateStr = (hasText && ['proof', 'eval'].includes(textMode) ? `/GSO1 <</ca ${proofOpacity}>>` : '')
        + (fillTextObjStr ? '/GSF <</ca 1 /CA 1>>' : '');
      // A name left in /XObject keeps a dead image reachable, so the byte scrub below would spare it.
      const imageDeleteDropNames = hasImageDeletes && stripConvertResult.redactedFormNames && stripConvertResult.redactedFormNames.size > 0
        ? stripConvertResult.redactedFormNames : null;
      const mergedResourcesStr = mergeResources(existingResourcesStr, overlayFontsStr, overlayExtGStateStr, objCache, overlayXObjectsStr,
        imageDeleteDropNames);

      resourcesObjNum = allocObjNum();
      pushNewObj({ objNum: resourcesObjNum, content: `${resourcesObjNum} 0 obj\n${mergedResourcesStr}\nendobj\n\n` });
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
      for (const t of objectTexts) newObjects.push({ objNum: nextObjNum++, content: t });
      const shapeAnns = pageAnnotations.filter((a) => SHAPE_ANNOT_TYPES.has(a.type))
        .map((a) => overlayAnnotationBbox(a, scaleX, scaleY, tx, ty, pageRotate, baseWidth, baseHeight, rotScale));
      const shapes = buildShapeAnnotObjects(shapeAnns, nextObjNum, outputDims, warningHandler, !!scrub);
      for (const t of shapes.objectTexts) newObjects.push({ objNum: nextObjNum++, content: t });
      const freeTextAnns = pageAnnotations.filter((a) => a.type === 'freetext' && !isFillTextRow(a))
        .map((a) => overlayAnnotationBbox(a, scaleX, scaleY, tx, ty, pageRotate, baseWidth, baseHeight, rotScale));
      const ft = buildFreeTextAnnotObjects(freeTextAnns, nextObjNum, outputDims, warningHandler, !!scrub);
      for (const t of ft.objectTexts) newObjects.push({ objNum: nextObjNum++, content: t });
      const textAnns = pageAnnotations.filter((a) => a.type === 'text')
        .map((a) => overlayAnnotationBbox(a, scaleX, scaleY, tx, ty, pageRotate, baseWidth, baseHeight, rotScale));
      const textAnnots = buildTextAnnotObjects(textAnns, nextObjNum, outputDims, warningHandler, !!scrub);
      for (const t of textAnnots.objectTexts) newObjects.push({ objNum: nextObjNum++, content: t });
      const linkAnns = pageAnnotations.filter((a) => a.type === 'link')
        .map((a) => overlayAnnotationBbox(a, scaleX, scaleY, tx, ty, pageRotate, baseWidth, baseHeight, rotScale));
      const linkAnnots = buildLinkAnnotObjects(linkAnns, nextObjNum, outputDims, linkPageObjNums || [], warningHandler);
      for (const t of linkAnnots.objectTexts) newObjects.push({ objNum: nextObjNum++, content: t });
      extraAnnotRefs = [...annotRefs, ...shapes.annotRefs, ...ft.annotRefs, ...textAnnots.annotRefs, ...linkAnnots.annotRefs];
    }

    const newPageObj = buildReplacementPageDict(pageInfo.objNum, pageInfo.objText, newContentsArray, resourcesObjNum, null, extraAnnotRefs, objCache,
      null, 0, null, linkDestInfo);
    newObjects.push({ objNum: pageInfo.objNum, content: newPageObj });
  }

  for (const [objNum, content] of formFieldUpdates.replacements) newObjects.push({ objNum, content });
  for (const o of formFieldUpdates.newObjects) newObjects.push(o);

  // Step 5: Create font objects for fonts that are actually used
  /** @type {Array<{objNum: number, content: string | import('./writePdfStreams.js').PdfBinaryObject}>} */
  const fontObjects = [];
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
    // Skip them so only real objects are written, leaving their object numbers free in the incremental xref.
    for (let j = 0; j < objStrArr.length; j++) {
      const obj = objStrArr[j];
      if (obj) fontObjects.push({ objNum: pdfFont.objN + j, content: obj });
    }
  }
  for (const o of editFontObjects) fontObjects.push(o);

  // Step 6: Build incremental update
  const allNewObjects = [...fontObjects, ...newObjects];

  // An empty doc.outline still strips the source's /Outlines.
  // Text edits strip /StructTreeRoot and /MarkInfo because the structure tree's /ActualText would otherwise keep speaking the deleted or replaced text.
  {
    const catalogObjNum = Number((/^(\d+)/.exec(rootRef) || [])[1]);
    const catalogText = catalogObjNum ? objCache.getObjectText(catalogObjNum) : null;
    const editsApplied = textPatchesByPage.size > 0;
    const stripStruct = editsApplied && !!catalogText && /\/(StructTreeRoot|MarkInfo)\b/.test(catalogText);
    const wantOutline = !!(outline && catalogText && (outline.length || /\/Outlines\b/.test(catalogText)));
    if (catalogText && (wantOutline || stripStruct || formFieldUpdates.catalogInsertRef)) {
      let outlineRef = '';
      if (outline && outline.length) {
        const built = buildOutlineObjects(outline, effectivePageArr.map((i) => pages[i].objNum), nextObjNum);
        if (built) {
          for (const o of built.objects) allNewObjects.push(o);
          nextObjNum = built.nextObjNum;
          outlineRef = ` /Outlines ${built.rootObjNum} 0 R`;
        }
      }
      let stripped = outline ? catalogText.replace(/\s*\/Outlines\s+\d+\s+\d+\s+R/, '') : catalogText;
      if (stripStruct) {
        stripped = stripped
          .replace(/\s*\/StructTreeRoot\s+\d+\s+\d+\s+R/, '')
          .replace(/\s*\/MarkInfo\s+(?:\d+\s+\d+\s+R|<<[^>]*>>)/, '');
      }
      const closeIdx = stripped.lastIndexOf('>>');
      const newCatalog = `${stripped.slice(0, closeIdx)}${outlineRef}${formFieldUpdates.catalogInsertRef}${stripped.slice(closeIdx)}`;
      allNewObjects.push({ objNum: catalogObjNum, content: `${catalogObjNum} 0 obj\n${newCatalog}\nendobj\n\n` });
    }
  }

  // An incremental append leaves the source's own /Info object addressable, so the trailer only has to point at it again.
  let outInfoRef = sourceInfoRef;
  if (docInfo) {
    const infoBody = buildInfoDictBody(readSourceInfoBody(pdfBytes, objCache), docInfo);
    if (infoBody) {
      const infoObjNum = nextObjNum++;
      allNewObjects.push({ objNum: infoObjNum, content: `${infoObjNum} 0 obj\n<<${infoBody}>>\nendobj\n\n` });
      outInfoRef = `${infoObjNum} 0 R`;
    }
  }

  if (allNewObjects.length === 0) {
    // The returned PDF must not alias the worker pool's shared memory.
    if (typeof SharedArrayBuffer !== 'undefined' && pdfBytes.buffer instanceof SharedArrayBuffer) return pdfBytes.slice();
    return basePdfData;
  }

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
  let totalSize = nextObjNum;
  for (const o of allNewObjects) {
    if (o.objNum + 1 > totalSize) totalSize = o.objNum + 1;
  }

  // A source with no identifier gains none, because a permanent element invented at revision time would not identify the original document.
  const idHexPair = sourceId0Hex ? /** @type {[string, string]} */ ([sourceId0Hex, FILE_ID_PLACEHOLDER]) : null;
  const trailerStr = buildIncrementalXrefAndTrailer(newXrefEntries, totalSize, xrefOffset, rootRef, newXrefOffset,
    [], { infoRef: outInfoRef, idHexPair }, xrefSectionIsStream(pdfBytes, xrefOffset));
  const trailerStart = pdfBytes.length + appendByteLen;
  appendParts.push(trailerStr);
  appendByteLen += trailerStr.length;

  const result = new Uint8Array(pdfBytes.length + appendByteLen);
  result.set(pdfBytes);

  // The source xref stays live in an incremental update, so a dead object is overwritten in place with a same-length stub rather than removed.
  if (scrubObjNums.size > 0) {
    for (const n of [...scrubObjNums]) {
      const t = objCache.getObjectText(n);
      const sm = t && /\/SMask\s+(\d+)\s+\d+\s+R/.exec(t);
      if (sm) scrubObjNums.add(Number(sm[1]));
    }
    // An image dropped from this page can still be drawn on another, so a candidate the updated document still reaches is spared.
    // The trace resolves references against the original file, so leaving the superseded objects in the walk would keep the dead objects reachable through them.
    const supersededObjNums = new Set(allNewObjects.map((o) => o.objNum));
    const startingTexts = [`<</Root ${rootRef}/Info ${outInfoRef || ''}>>`];
    for (const o of allNewObjects) {
      const c = o.content;
      if (typeof c === 'string') startingTexts.push(c);
      else if (c && typeof c.header === 'string') startingTexts.push(c.header + (typeof c.trailer === 'string' ? c.trailer : ''));
    }
    const reachable = traceReferencedObjects(startingTexts, objCache, supersededObjNums);
    for (const n of [...scrubObjNums]) {
      if (reachable.has(n)) scrubObjNums.delete(n);
    }
    for (const n of scrubObjNums) {
      const entry = xrefEntries[n];
      if (!entry || entry.type !== 1) continue;
      const range = locateObjectByteRange(pdfBytes, objCache, entry);
      if (!range) continue;
      const stub = `${n} 0 obj\n<</Length 0>>\nstream\nendstream\nendobj`;
      if (range.end - range.start < stub.length) continue;
      result.fill(0x20, range.start, range.end);
      for (let si = 0; si < stub.length; si++) result[range.start + si] = stub.charCodeAt(si);
    }
  }
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

  // The hash covers only the appended revision, not the whole file.
  // The source bytes are carried verbatim, so hashing them again would cost a full pass over the input on every export.
  await patchFileId(result, trailerStr, trailerStart, pdfBytes.length, newXrefOffset);

  return result.buffer;
}
