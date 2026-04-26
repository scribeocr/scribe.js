import { findXrefOffset, parseXref, ObjectCache } from '../../pdf/parsePdfUtils.js';
import { getPageObjects, collectPageTreeObjNums } from '../../pdf/parsePdfDoc.js';
import {
  traceReferencedObjects,
  buildFullXrefAndTrailer,
  locateObjectByteRange,
} from './pdfObjectGraph.js';

/**
 * Rewrite all indirect references `N M R` in PDF dict text using an
 * oldObjNum → newObjNum map. Refs whose old obj num is not in the map are
 * left untouched.
 *
 * @param {string} dictText
 * @param {Map<number, number>} objNumMap
 */
function rewriteIndirectRefs(dictText, objNumMap) {
  return dictText.replace(/(\d+)\s+(\d+)\s+R/g, (match, n, m) => {
    const mapped = objNumMap.get(Number(n));
    return mapped !== undefined ? `${mapped} ${m} R` : match;
  });
}

/**
 * Parse one input PDF enough to enumerate its kept pages and the set of
 * objects reachable from those pages, excluding page-tree internal nodes.
 *
 * @param {ArrayBuffer | Uint8Array} input
 */
function parseMergeSource(input) {
  const pdfBytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const text = new TextDecoder('latin1').decode(pdfBytes);

  const xrefOffset = findXrefOffset(pdfBytes);
  const xrefEntries = parseXref(pdfBytes, xrefOffset);
  const objCache = new ObjectCache(pdfBytes, xrefEntries);
  const pages = getPageObjects(objCache);
  if (pages.length === 0) throw new Error('mergePdfs: an input PDF has zero pages');

  const { pageTreeObjNums } = collectPageTreeObjNums(objCache);
  const pageTexts = pages.map((p) => p.objText);
  const copySet = traceReferencedObjects(pageTexts, objCache, pageTreeObjNums);
  for (const page of pages) copySet.add(page.objNum);

  return {
    pdfBytes, text, xrefEntries, objCache, pages, copySet,
  };
}

/**
 * Merge multiple PDFs into a single PDF whose pages are the concatenation
 * of all input pages in input order. Content is preserved byte-exactly
 * (no re-rendering). Objects from each source are copied with new object
 * numbers, and indirect references inside each copied object's dict text
 * are rewritten to match.
 *
 * @param {Array<ArrayBuffer | Uint8Array>} pdfInputs - PDFs in merge order
 */
export async function mergePdfs(pdfInputs) {
  if (!Array.isArray(pdfInputs) || pdfInputs.length === 0) {
    throw new Error('mergePdfs: pdfInputs must be a non-empty array');
  }

  // Phase 1: parse every source and collect its copy set.
  const sources = pdfInputs.map(parseMergeSource);

  // Phase 2: allocate new object numbers. Catalog/pages root first, then
  // each source's pages in order, then each source's other referenced objs.
  const catalogObjNum = 1;
  const pagesRootObjNum = 2;
  let nextObjNum = 3;

  /** @type {Array<Map<number, number>>} */
  const sourceMaps = [];

  for (const src of sources) {
    /** @type {Map<number, number>} */
    const map = new Map();
    const pageObjNumSet = new Set(src.pages.map((p) => p.objNum));
    // Pages first (keeps them contiguous in the output, cosmetic only).
    for (const page of src.pages) {
      map.set(page.objNum, nextObjNum++);
    }
    // Other referenced objects, sorted for deterministic output.
    const otherNums = [...src.copySet]
      .filter((n) => !pageObjNumSet.has(n))
      .sort((a, b) => a - b);
    for (const oldNum of otherNums) {
      map.set(oldNum, nextObjNum++);
    }
    sourceMaps.push(map);
  }

  // Phase 3: emit all copied objects with rewritten references.
  /** @type {Array<{objNum: number, content: string | Uint8Array | import('./writePdfStreams.js').PdfBinaryObject}>} */
  const allOutputObjects = [];
  /** @type {string[]} */
  const keptPageRefs = [];

  for (let s = 0; s < sources.length; s++) {
    const src = sources[s];
    const map = sourceMaps[s];
    const pageObjNumSet = new Set(src.pages.map((p) => p.objNum));

    // Emit each page dict with /Parent re-pointed at the new pages root.
    for (const page of src.pages) {
      const newObjNum = /** @type {number} */ (map.get(page.objNum));
      let pageText = rewriteIndirectRefs(page.objText, map);
      if (/\/Parent\s+\d+\s+\d+\s+R/.test(pageText)) {
        pageText = pageText.replace(/\/Parent\s+\d+\s+\d+\s+R/, `/Parent ${pagesRootObjNum} 0 R`);
      } else {
        // No /Parent — inject one at the start of the dict.
        pageText = pageText.replace(/<<\s*/, `<</Parent ${pagesRootObjNum} 0 R `);
      }
      allOutputObjects.push({
        objNum: newObjNum,
        content: `${newObjNum} 0 obj\n${pageText}\nendobj\n\n`,
      });
      keptPageRefs.push(`${newObjNum} 0 R`);
    }

    // Emit every other referenced object.
    for (const oldObjNum of src.copySet) {
      if (pageObjNumSet.has(oldObjNum)) continue;
      const newObjNum = /** @type {number} */ (map.get(oldObjNum));
      const entry = src.xrefEntries[oldObjNum];
      if (!entry) continue;

      if (entry.type === 1) {
        const range = locateObjectByteRange(src.pdfBytes, src.text, src.objCache, entry);
        if (!range) continue;

        const isStream = range.streamStart !== range.start;
        if (!isStream) {
          const objText = src.text.substring(range.start, range.end);
          const rewritten = rewriteIndirectRefs(objText, map)
            .replace(/^\d+\s+\d+\s+obj/, `${newObjNum} 0 obj`);
          allOutputObjects.push({ objNum: newObjNum, content: `${rewritten}\n\n` });
        } else {
          // Stream object: rewrite dict header text, byte-copy stream bytes,
          // rewrite trailer text.
          const headerText = src.text.substring(range.start, range.streamStart);
          const rewrittenHeader = rewriteIndirectRefs(headerText, map)
            .replace(/^\d+\s+\d+\s+obj/, `${newObjNum} 0 obj`);
          const streamBytes = src.pdfBytes.subarray(range.streamStart, range.streamEnd);
          const trailerText = src.text.substring(range.streamEnd, range.end);
          const rewrittenTrailer = `${rewriteIndirectRefs(trailerText, map)}\n\n`;
          allOutputObjects.push({
            objNum: newObjNum,
            content: {
              header: rewrittenHeader,
              streamData: streamBytes,
              trailer: rewrittenTrailer,
            },
          });
        }
      } else if (entry.type === 2) {
        const objText = src.objCache.getObjectText(oldObjNum);
        if (!objText) continue;
        const rewritten = rewriteIndirectRefs(objText, map);
        allOutputObjects.push({
          objNum: newObjNum,
          content: `${newObjNum} 0 obj\n${rewritten}\nendobj\n\n`,
        });
      }
    }
  }

  // Phase 4: catalog and pages root.
  allOutputObjects.push({
    objNum: catalogObjNum,
    content: `${catalogObjNum} 0 obj\n<</Type/Catalog/Pages ${pagesRootObjNum} 0 R>>\nendobj\n\n`,
  });
  allOutputObjects.push({
    objNum: pagesRootObjNum,
    content: `${pagesRootObjNum} 0 obj\n<</Type/Pages/Kids[${keptPageRefs.join(' ')}]/Count ${keptPageRefs.length}>>\nendobj\n\n`,
  });

  // Phase 5: write header, objects, xref, trailer.
  const pdfHeader = '%PDF-1.7\n';
  /** @type {(string | Uint8Array)[]} */
  const parts = [pdfHeader];
  let byteLen = pdfHeader.length;

  /** @type {Array<{objNum: number, offset: number}>} */
  const xrefEntryList = [];

  for (const obj of allOutputObjects) {
    xrefEntryList.push({ objNum: obj.objNum, offset: byteLen });
    const c = obj.content;
    if (typeof c === 'string') {
      parts.push(c);
      byteLen += c.length;
    } else if (c instanceof Uint8Array) {
      parts.push(c);
      byteLen += c.length;
    } else {
      const hdr = c.header;
      if (typeof hdr === 'string') { parts.push(hdr); byteLen += hdr.length; } else { parts.push(hdr); byteLen += hdr.length; }
      parts.push(c.streamData);
      byteLen += c.streamData.length;
      const tr = c.trailer;
      if (typeof tr === 'string') { parts.push(tr); byteLen += tr.length; } else { parts.push(tr); byteLen += tr.length; }
    }
  }

  const newXrefOffset = byteLen;
  const totalSize = Math.max(nextObjNum, ...allOutputObjects.map((o) => o.objNum + 1));
  const xrefStr = buildFullXrefAndTrailer(xrefEntryList, totalSize, `${catalogObjNum} 0 R`, newXrefOffset);
  parts.push(xrefStr);
  byteLen += xrefStr.length;

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
