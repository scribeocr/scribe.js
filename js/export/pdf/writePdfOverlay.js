import {
  findXrefOffset, parseXref, sourceXrefIsWellFormed, getPageObjects,
} from '../../pdf/parsePdfUtils.js';
import { byteIndexOf } from '../../pdf/pdfPrimitives.js';
import { ObjectCache } from '../../pdf/objectCache.js';
import { createPdfFontRefs, createEmbeddedFontType0 } from './writePdfFonts.js';
import { ocrPageToPDFStream } from './writePdfText.js';
import {
  buildHighlightAnnotObjects, buildFreeTextAnnotObjects, buildShapeAnnotObjects, buildTextAnnotObjects, consolidateAnnotations,
} from './writePdfAnnots.js';
import { SHAPE_ANNOT_TYPES, TEXT_MARKUP_ANNOT_TYPES } from '../../addHighlights.js';
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
import { buildOutlineObjects } from './writeOutline.js';

/**
 * Insert OCR text layers into an existing PDF via incremental update, or
 * rebuild with a subset/reordering of pages when `pageArr` demands it.
 * In incremental mode the original PDF bytes are not modified; new objects
 * are appended after %%EOF.
 *
 * @param {Object} params
 * @param {ArrayBuffer} params.basePdfData - The original PDF bytes
 * @param {Array<OcrPage>} params.ocrArr - OCR data for each page (indexed to match `basePdfData`)
 * @param {?Array<OcrPage>} [params.annotationOcrArr=null] - Real per-page OCR geometry for highlight consolidation.
 *   `ocrArr` is emptied for clean text-native pages, so it lacks the word/line geometry consolidation needs.
 *   Falls back to `ocrArr` when null.
 * @param {Array<PageMetrics>} params.pageMetricsArr - Page metrics (dims in pixels)
 * @param {?Array<number>} [params.pageArr=null] - 0-based page indices into `basePdfData` to include. Defaults to all pages.
 * @param {("ebook"|"eval"|"proof"|"invis"|"annot")} [params.textMode="invis"]
 * @param {boolean} [params.rotateText=true]
 * @param {boolean} [params.rotateBackground=false]
 * @param {number} [params.confThreshHigh=85]
 * @param {number} [params.confThreshMed=75]
 * @param {number} [params.proofOpacity=0.8]
 * @param {boolean} [params.humanReadable=false]
 * @param {Array<Array<Annotation>>} [params.annotationsPages=[]] - Per-page annotation arrays
 * @param {?Array<{ page: number, bbox: [number, number, number, number] }>} [params.convertRegionsToPaths=null]
 *   When provided, source-PDF text whose origin (Trm[4], Trm[5]) falls inside any
 *   of the supplied user-space bboxes is replaced with vector Form XObject calls.
 *   Glyphs from non-embedded or unsupported fonts are left as text.
 * @param {boolean} [params.convertTextToPaths=false] - Convenience flag: when true and `convertRegionsToPaths` is not supplied,
 *   every page is converted in full (one whole-page region per page from its CropBox/MediaBox).
 *   An explicit `convertRegionsToPaths` wins.
 * @param {?number[]} [params.convertFullPages=null] - Page indices to flatten:
 *   each listed page gets a synthesized whole-page region (CropBox/MediaBox), converting ALL its text to paths,
 *   including (on the rebuild path) pages with no overlay text.
 *   Used by the page-category flatten/passthrough export.
 * @param {boolean} [params.convertBrokenType3ToPaths=false] - When true, glyphs drawn by broken-ToUnicode Type3 fonts are converted to paths on every page (font-scoped, no region needed),
 *   so the gibberish PUA text they carry stops being selectable and the invisible OCR overlay becomes the only copy source.
 *   Other fonts' text is left selectable.
 * @param {import('../../containers/fontContainer.js').DocFonts} [params.docFonts] - Per-document fonts.
 * @param {(message: string) => void} [params.warningHandler] - Reports each annotation skipped on error.
 * @param {?Array<import('../../objects/outlineObjects.js').OutlineNode>} [params.outline=null] - Bookmark tree with destinations indexed into the output page order.
 *   Null leaves the source's bookmarks unchanged; an empty array strips them.
 * @param {?{ opts?: ReturnType<typeof import('../../pdf/metadata/scrubMetadata.js').defaultScrubOpts> }} [params.scrub=null]
 *   When set, forces the rebuild path and scrubs identifying metadata using these scrub options.
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
  convertRegionsToPaths = null,
  convertTextToPaths = false,
  convertFullPages = null,
  convertBrokenType3ToPaths = false,
  docFonts,
  warningHandler,
  outline = null,
  scrub = null,
}) {
  const pdfBytes = new Uint8Array(basePdfData);
  // Local latin1 view used by overlayPdfText's downstream helpers.
  const text = new TextDecoder('latin1').decode(pdfBytes);

  // Step 1: Parse the base PDF structure
  const xrefOffset = findXrefOffset(pdfBytes);
  const xrefEntries = parseXref(pdfBytes, xrefOffset);
  const objCache = new ObjectCache(pdfBytes, xrefEntries);
  // The object-number scan below needs the complete xref, so finish the deferred repair.
  objCache.ensureXrefRepaired();
  const pages = getPageObjects(objCache);
  const { rootRef } = parseTrailerInfo(text, xrefOffset);

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
    const contentW = Math.abs(box[2] - box[0]);
    const contentH = Math.abs(box[3] - box[1]);
    const ox = Math.min(box[0], box[2]);
    const oy = Math.min(box[1], box[3]);
    const rot = (((pages[i].rotate || 0) % 360) + 360) % 360;
    const visW = rot % 180 === 0 ? contentW : contentH;
    const visH = rot % 180 === 0 ? contentH : contentW;
    /** @type {Array<[number, number, number, number]>} */
    const rects = [];
    for (const m of marks) {
      const corners = [
        [m.bbox.left, m.bbox.top], [m.bbox.right, m.bbox.top],
        [m.bbox.left, m.bbox.bottom], [m.bbox.right, m.bbox.bottom],
      ];
      let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
      for (const [px, py] of corners) {
        // Pixel (top-left origin) -> visual pts (y-up) -> invert /Rotate -> content user space.
        const vx = px * (visW / dims.width);
        const vy = visH - py * (visH / dims.height);
        let x; let y;
        if (rot === 90) {
          y = vx + oy;
          x = contentW + ox - vy;
        } else if (rot === 180) {
          x = contentW + ox - vx;
          y = contentH + oy - vy;
        } else if (rot === 270) {
          y = contentH + oy - vx;
          x = vy + ox;
        } else {
          x = vx + ox;
          y = vy + oy;
        }
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
      if (x1 > x0 && y1 > y0) rects.push([x0, y0, x1, y1]);
    }
    if (rects.length > 0) redactRegionsByPage.set(i, rects);
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
  // A metadata scrub must rebuild: incremental append would leave the source's trailer chain and every prior /Prev revision's metadata in place.
  // Rebuilding drops all of it and scrubs the copied objects.
  // Redactions must rebuild too, but as a hard security property: an incremental update PRESERVES the original file bytes, so the redacted content stays recoverable.
  if (isSubset || sourceEncrypted || sourceXrefMalformed || sourceLinearized || hasUserRotation || scrub || redactRegionsByPage.size > 0) {
    return rebuildPdfSubset({
      pdfBytes,
      text,
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
    });
  }

  const regionsByPage = new Map();
  if (regionsForPaths) {
    for (const r of regionsForPaths) {
      if (!regionsByPage.has(r.page)) regionsByPage.set(r.page, []);
      regionsByPage.get(r.page).push(r.bbox);
    }
  }
  const conversionState = (regionsByPage.size > 0 || convertBrokenType3ToPaths)
    ? createConversionState() : null;

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
    // overlayAnnotationBbox uses it to map annotation coords back into unrotated MediaBox space.
    const pageRotate = ((((pageInfo.rotate || 0) % 360) + 360) % 360);
    const rotScale = pixelDims ? baseWidth / pixelDims.height : 1;

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
    // Redact marks are never written as annotations (they are applied destructively), so they must not force the annots-driven page rewrite.
    const hasAnnots = pageAnnotations.some((a) => a.type !== 'redact');
    const hasConvert = regionsByPage.has(i) || convertBrokenType3ToPaths;
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
        convertBrokenType3ToPaths,
      });

      // When broken-Type3 conversion is the *only* reason this page is here
      // (no overlay text, no annotations, no explicit region) and nothing actually changed,
      // leave the page untouched rather than re-emitting it verbatim.
      const convertChanged = stripConvertResult.refs !== existingContentsRefs
        || stripConvertResult.xobjEntries.size > 0;
      // A flatten page (fullPageSet) that came out unchanged is left untouched.
      // An explicitly supplied region is re-emitted rather than skipped.
      if (!hasText && !hasAnnots && !convertChanged && (!regionsByPage.has(i) || fullPageSet.has(i))) continue;

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
      const freeTextAnns = pageAnnotations.filter((a) => a.type === 'freetext')
        .map((a) => overlayAnnotationBbox(a, scaleX, scaleY, tx, ty, pageRotate, baseWidth, baseHeight, rotScale));
      const ft = buildFreeTextAnnotObjects(freeTextAnns, nextObjNum, outputDims, warningHandler, !!scrub);
      for (const t of ft.objectTexts) newObjects.push({ objNum: nextObjNum++, content: t });
      const textAnns = pageAnnotations.filter((a) => a.type === 'text')
        .map((a) => overlayAnnotationBbox(a, scaleX, scaleY, tx, ty, pageRotate, baseWidth, baseHeight, rotScale));
      const textAnnots = buildTextAnnotObjects(textAnns, nextObjNum, outputDims, warningHandler, !!scrub);
      for (const t of textAnnots.objectTexts) newObjects.push({ objNum: nextObjNum++, content: t });
      extraAnnotRefs = [...annotRefs, ...shapes.annotRefs, ...ft.annotRefs, ...textAnnots.annotRefs];
    }

    const newPageObj = buildReplacementPageDict(pageInfo.objNum, pageInfo.objText, newContentsArray, resourcesObjNum, null, extraAnnotRefs, objCache);
    newObjects.push({ objNum: pageInfo.objNum, content: newPageObj });
  }

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

  // Step 6: Build incremental update
  const allNewObjects = [...fontObjects, ...newObjects];

  // Override the catalog's /Outlines so doc.outline wins over the source's own bookmarks on this incremental path.
  // An empty doc.outline still strips the source's /Outlines.
  if (outline) {
    const catalogObjNum = Number((/^(\d+)/.exec(rootRef) || [])[1]);
    const catalogText = catalogObjNum ? objCache.getObjectText(catalogObjNum) : null;
    if (catalogText && (outline.length || /\/Outlines\b/.test(catalogText))) {
      let outlineRef = '';
      if (outline.length) {
        const built = buildOutlineObjects(outline, effectivePageArr.map((i) => pages[i].objNum), nextObjNum);
        if (built) {
          for (const o of built.objects) allNewObjects.push(o);
          nextObjNum = built.nextObjNum;
          outlineRef = ` /Outlines ${built.rootObjNum} 0 R`;
        }
      }
      const stripped = catalogText.replace(/\s*\/Outlines\s+\d+\s+\d+\s+R/, '');
      const closeIdx = stripped.lastIndexOf('>>');
      const newCatalog = `${stripped.slice(0, closeIdx)}${outlineRef}${stripped.slice(closeIdx)}`;
      allNewObjects.push({ objNum: catalogObjNum, content: `${catalogObjNum} 0 obj\n${newCatalog}\nendobj\n\n` });
    }
  }

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
