import {
  findXrefOffset, parseXref, ObjectCache, sourceXrefIsWellFormed, byteIndexOf,
} from '../../pdf/parsePdfUtils.js';
import { getPageObjects } from '../../pdf/parsePdfDoc.js';
import { createPdfFontRefs, createEmbeddedFontType0 } from './writePdfFonts.js';
import { ocrPageToPDFStream } from './writePdfText.js';
import { buildHighlightAnnotObjects, consolidateAnnotations } from './writePdfAnnots.js';
import { encodeStreamObject } from './writePdfStreams.js';
import {
  parseTrailerInfo,
  buildIncrementalXrefAndTrailer,
} from './pdfObjectGraph.js';
import {
  parseExistingContents,
  rewriteContentsStripAndConvert,
  resolvePageResources,
  mergeResources,
  buildReplacementPageDict,
  overlayAnnotationBbox,
} from './pdfPageRewrite.js';
import { createConversionState } from './convertTextRegionsToPaths.js';
import { rebuildPdfSubset } from './subsetPdf.js';

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
 * @param {?Array<{ page: number, bbox: [number, number, number, number] }>} [params.convertRegionsToPaths=null]
 *   When provided, source-PDF text whose origin (Trm[4], Trm[5]) falls inside any
 *   of the supplied user-space bboxes is replaced with vector Form XObject calls.
 *   Glyphs from non-embedded or unsupported fonts are left as text.
 * @param {import('../../containers/fontContainer.js').DocFonts} [params.docFonts] - Per-document fonts.
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
  convertRegionsToPaths = null,
  docFonts,
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

  // Step 3: Create font references starting at nextObjNum when writing text overlay.
  const needsOcrFonts = !!ocrArr?.some((p) => p?.lines?.length > 0) && textMode !== 'annot';
  /** @type {Object<string, PdfFontFamily>} */
  let pdfFonts = {};
  if (needsOcrFonts) {
    const fontRefs = await createPdfFontRefs(nextObjNum, ocrArr, docFonts);
    pdfFonts = fontRefs.pdfFonts;
    nextObjNum = fontRefs.objectI;
  }

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
  if (isSubset || sourceEncrypted || sourceXrefMalformed || sourceLinearized) {
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
      docFonts,
      convertRegionsToPaths,
    });
  }

  const regionsByPage = new Map();
  if (convertRegionsToPaths) {
    for (const r of convertRegionsToPaths) {
      if (!regionsByPage.has(r.page)) regionsByPage.set(r.page, []);
      regionsByPage.get(r.page).push(r.bbox);
    }
  }
  const conversionState = regionsByPage.size > 0 ? createConversionState() : null;

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
    const baseWidth = overlayBox[2] - overlayBox[0];
    const baseHeight = overlayBox[3] - overlayBox[1];
    const scaleX = pixelDims ? baseWidth / pixelDims.width : 1;
    const scaleY = pixelDims ? baseHeight / pixelDims.height : 1;
    const tx = overlayBox[0];
    const ty = overlayBox[1];

    let textContentObjStr = '';
    /** @type {Set<PdfFontInfo>} */
    let pageFontsUsed = new Set();
    if (pageObj && pageObj.lines.length > 0 && textMode !== 'annot' && pixelDims) {
      const angle = pageMetrics?.angle || 0;
      const res = await ocrPageToPDFStream(
        pageObj, pixelDims, pdfFonts, textMode, angle, docFonts,
        rotateText, rotateBackground, confThreshHigh, confThreshMed,
      );
      textContentObjStr = res.textContentObjStr || '';
      pageFontsUsed = res.pdfFontsUsed;
    }

    const hasText = textContentObjStr && textContentObjStr.length > 0;
    const hasAnnots = pageAnnotations.length > 0;
    const hasConvert = regionsByPage.has(i);
    if (!hasText && !hasAnnots && !hasConvert) continue;

    /** @type {string[]|null} */
    let newContentsArray = null;
    /** @type {number|null} */
    let resourcesObjNum = null;

    if (hasText || hasConvert) {
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
      });

      /** @type {string[]} */
      const contentsArray = [];
      let qSaveObjNum = null;
      let qOverlayObjNum = null;
      if (hasText) {
        const qSaveStr = 'q\n';
        qSaveObjNum = allocObjNum();
        pushNewObj({ objNum: qSaveObjNum, content: `${qSaveObjNum} 0 obj\n<</Length ${qSaveStr.length}>>\nstream\n${qSaveStr}endstream\nendobj\n\n` });

        const qOverlayStr = `Q\nq ${scaleX} 0 0 ${scaleY} ${tx} ${ty} cm\n${textContentObjStr}Q\n`;
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
      const overlayExtGStateStr = hasText ? `/GSO0 <</ca 0.0>>/GSO1 <</ca ${proofOpacity}>>` : '';
      const mergedResourcesStr = mergeResources(existingResourcesStr, overlayFontsStr, overlayExtGStateStr, objCache, overlayXObjectsStr);

      resourcesObjNum = allocObjNum();
      pushNewObj({ objNum: resourcesObjNum, content: `${resourcesObjNum} 0 obj\n${mergedResourcesStr}\nendobj\n\n` });
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
  let totalSize = nextObjNum;
  for (const o of allNewObjects) {
    if (o.objNum + 1 > totalSize) totalSize = o.objNum + 1;
  }

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
