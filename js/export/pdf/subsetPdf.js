import {
  findXrefOffset, parseXref, ObjectCache, extractDict, parseDictEntries,
  getPageContentStreams, tokenizeContentStream, bytesToLatin1,
} from '../../pdf/parsePdfUtils.js';
import { getPageObjects, collectPageTreeObjNums } from '../../pdf/parsePdfDoc.js';
import { createEmbeddedFontType0 } from './writePdfFonts.js';
import { ocrPageToPDFStream } from './writePdfText.js';
import { buildHighlightAnnotObjects, consolidateAnnotations } from './writePdfAnnots.js';
import { encodeStreamObject } from './writePdfStreams.js';
import {
  traceReferencedObjects,
  buildFullXrefAndTrailer,
  copyRawObjectBytes,
} from './pdfObjectGraph.js';
import {
  parseExistingContents,
  rewriteContentsStripAndConvert,
  resolvePageResources,
  mergeResources,
  buildReplacementPageDict,
  overlayAnnotationBbox,
  annotLinkTargetsDroppedPage,
} from './pdfPageRewrite.js';
import { createConversionState } from './convertTextRegionsToPaths.js';

/** @typedef {import('../../containers/fontContainer.js').DocFonts} DocFonts */

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
 * @param {?Array<{ page: number, bbox: [number, number, number, number] }>} [params.convertRegionsToPaths=null]
 * @param {DocFonts} [params.docFonts] - Per-document fonts for the OCR overlay text layer.
 */
export async function rebuildPdfSubset({
  pdfBytes, text, objCache, xrefEntries, pages,
  pageIndices, startingNextObjNum,
  ocrArr, pageMetricsArr, pdfFonts,
  textMode, rotateText, rotateBackground,
  confThreshHigh, confThreshMed, proofOpacity,
  humanReadable = false,
  annotationsPages = [],
  convertRegionsToPaths = null,
  docFonts,
}) {
  const overlayEnabled = !!(ocrArr && pageMetricsArr && pdfFonts);
  let nextObjNum = startingNextObjNum;

  const regionsByPage = new Map();
  if (convertRegionsToPaths) {
    for (const r of convertRegionsToPaths) {
      if (!regionsByPage.has(r.page)) regionsByPage.set(r.page, []);
      regionsByPage.get(r.page).push(r.bbox);
    }
  }
  const conversionState = regionsByPage.size > 0 ? createConversionState() : null;

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
  const allocObjNum = () => nextObjNum++;
  /** @param {{objNum: number, content: string | Uint8Array | import('./writePdfStreams.js').PdfBinaryObject}} obj */
  const pushOutputObj = (obj) => allOutputObjects.push(obj);

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
      // Box corners may be stored in either order, so use absolute size and a lower-left origin.
      const baseWidth = Math.abs(overlayBox[2] - overlayBox[0]);
      const baseHeight = Math.abs(overlayBox[3] - overlayBox[1]);
      const scaleX = pixelDims ? baseWidth / pixelDims.width : 1;
      const scaleY = pixelDims ? baseHeight / pixelDims.height : 1;
      const tx = Math.min(overlayBox[0], overlayBox[2]);
      const ty = Math.min(overlayBox[1], overlayBox[3]);

      let textContentObjStr = '';
      /** @type {Set<PdfFontInfo>} */
      let pageFontsUsed = new Set();
      if (pageObj && pageObj.lines.length > 0 && textMode !== 'annot') {
        const angle = pageMetricsArr[i].angle || 0;
        const res = await ocrPageToPDFStream(
          pageObj, pixelDims, pdfFonts, /** @type {'ebook'|'eval'|'proof'|'invis'} */ (textMode), angle, docFonts,
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
        const stripConvertResult = await rewriteContentsStripAndConvert({
          existingContentsRefs,
          pageObjText: pageInfo.objText,
          bboxes: regionsByPage.get(i) || null,
          conversionState,
          objCache,
          allocObjNum,
          pushObj: pushOutputObj,
          humanReadable,
        });
        newContentsArray = [
          `${qSaveObjNum} 0 R`,
          ...stripConvertResult.refs,
          `${qOverlayObjNum} 0 R`,
        ];

        const existingResourcesStr = resolvePageResources(pageInfo.objText, objCache);
        let overlayFontsStr = '';
        for (const font of pageFontsUsed) {
          overlayFontsStr += `${font.name} ${font.objN} 0 R\n`;
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
        const overlayExtGStateStr = `/GSO0 <</ca 0.0>>/GSO1 <</ca ${proofOpacity}>>`;
        const mergedResourcesStr = mergeResources(existingResourcesStr, overlayFontsStr, overlayExtGStateStr, objCache, overlayXObjectsStr);

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
  let totalSize = nextObjNum;
  for (const o of allOutputObjects) {
    if (o.objNum + 1 > totalSize) totalSize = o.objNum + 1;
  }
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
    text,
    objCache,
    xrefEntries,
    pages,
    pageIndices,
    startingNextObjNum,
  });
}
