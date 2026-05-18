import {
  findXrefOffset, parseXref, ObjectCache, sourceXrefIsWellFormed,
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
  rewriteContentsStrippingInvisibleText,
  resolvePageResources,
  mergeResources,
  buildReplacementPageDict,
  overlayAnnotationBbox,
} from './pdfPageRewrite.js';
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
