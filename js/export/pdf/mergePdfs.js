import {
  findXrefOffset, parseXref, extractRawStreamBytes, findRootObjNum,
  getPageObjects, collectPageTreeObjNums,
} from '../../pdf/parsePdfUtils.js';
import { bytesToLatin1 } from '../../pdf/pdfPrimitives.js';
import { ObjectCache } from '../../pdf/objectCache.js';
import {
  traceReferencedObjects,
  buildFullXrefAndTrailer,
  locateObjectByteRange,
  decryptObjectStrings,
} from './pdfObjectGraph.js';
import { buildOutlineObjects } from './writeOutline.js';

/**
 * Extract the value of a top-level dict key from a PDF dict text. Returns the
 * raw substring (an inline `<<...>>` dict, an indirect ref `N M R`, an array,
 * or null if the key is absent). Bracket-balances inline dicts (`<<`/`>>`)
 * and arrays (`[`/`]`).
 *
 * @param {string} dictText
 * @param {string} key e.g. '/OCProperties'
 */
function extractDictKeyValue(dictText, key) {
  const re = new RegExp(`${key.replace(/[/]/g, '\\/')}(?![A-Za-z0-9_])`, 'g');
  const match = re.exec(dictText);
  if (!match) return null;
  let i = match.index + match[0].length;
  while (i < dictText.length && /\s/.test(dictText[i])) i++;
  if (i >= dictText.length) return null;
  if (dictText[i] === '<' && dictText[i + 1] === '<') {
    let depth = 0;
    let p = i;
    while (p < dictText.length) {
      if (dictText[p] === '<' && dictText[p + 1] === '<') {
        depth++;
        p += 2;
        continue;
      }
      if (dictText[p] === '>' && dictText[p + 1] === '>') {
        depth--;
        p += 2;
        if (depth === 0) return dictText.substring(i, p);
        continue;
      }
      p++;
    }
    return null;
  }
  const refMatch = /^\s*(\d+)\s+(\d+)\s+R/.exec(dictText.substring(i));
  if (refMatch) return `${refMatch[1]} ${refMatch[2]} R`;
  return null;
}

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
 * For an encrypted source, walk a slice of `pdfBytes` and replace every PDF
 * string (`(...)` literal, `<...>` hex) with its decrypted equivalent.
 * Returns the latin1-decoded text.
 *
 * @param {Uint8Array} sliceBytes
 * @param {number} oldObjNum
 * @param {ObjectCache} objCache
 * @param {number} [streamLength=-1]
 */
function decryptObjectSliceToText(sliceBytes, oldObjNum, objCache, streamLength = -1) {
  const decryptedBytes = decryptObjectStrings(sliceBytes, oldObjNum, objCache);
  let text = bytesToLatin1(decryptedBytes);
  if (streamLength >= 0) {
    text = text.replace(/\/Length\s+\d+(?:\s+\d+\s+R)?/, `/Length ${streamLength}`);
  }
  return text;
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
 * @param {{ outline?: Array<import('../../objects/outlineObjects.js').OutlineNode> }} [options]
 *   `outline`: a bookmark tree written as the output's `/Outlines`.
 *   Its destinations are indices into the merged page sequence (0-based over all input pages in order).
 */
export async function mergePdfs(pdfInputs, options = {}) {
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
  /** @type {number[]} Merged page index → output page object number, for the /Outlines writer. */
  const pageObjNumByIndex = [];

  for (let s = 0; s < sources.length; s++) {
    const src = sources[s];
    const map = sourceMaps[s];
    const pageObjNumSet = new Set(src.pages.map((p) => p.objNum));
    const isEncryptedSrc = !!src.objCache.encryptionKey;

    // Emit each page dict with /Parent re-pointed at the new pages root.
    for (const page of src.pages) {
      const newObjNum = /** @type {number} */ (map.get(page.objNum));
      let pageText;
      const entry = src.xrefEntries[page.objNum];
      if (isEncryptedSrc && page.objNum !== src.objCache.encryptObjNum
          && entry && entry.type === 1 && entry.offset !== undefined) {
        const range = locateObjectByteRange(src.pdfBytes, src.text, src.objCache,
          /** @type {{type: number, offset: number}} */ (entry));
        if (!range) continue;
        const slice = src.pdfBytes.subarray(range.start, range.end);
        const decryptedText = decryptObjectSliceToText(slice, page.objNum, src.objCache);
        pageText = decryptedText.replace(/^\d+\s+\d+\s+obj\s*/, '').replace(/\s*endobj\s*$/, '');
      } else {
        pageText = page.objText;
      }
      pageText = rewriteIndirectRefs(pageText, map);
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
      pageObjNumByIndex.push(newObjNum);
    }

    // Emit every other referenced object.
    for (const oldObjNum of src.copySet) {
      if (pageObjNumSet.has(oldObjNum)) continue;
      const newObjNum = /** @type {number} */ (map.get(oldObjNum));
      const entry = src.xrefEntries[oldObjNum];
      if (!entry) continue;
      const isObjEncrypted = isEncryptedSrc && oldObjNum !== src.objCache.encryptObjNum;

      if (entry.type === 1) {
        const range = locateObjectByteRange(src.pdfBytes, src.text, src.objCache, entry);
        if (!range) continue;

        const isStream = range.streamStart !== range.start;
        if (!isStream) {
          let objText;
          if (isObjEncrypted) {
            const slice = src.pdfBytes.subarray(range.start, range.end);
            objText = decryptObjectSliceToText(slice, oldObjNum, src.objCache);
          } else {
            objText = src.text.substring(range.start, range.end);
          }
          const rewritten = rewriteIndirectRefs(objText, map)
            .replace(/^\d+\s+\d+\s+obj/, `${newObjNum} 0 obj`);
          allOutputObjects.push({ objNum: newObjNum, content: `${rewritten}\n\n` });
        } else {
          // Stream object: rewrite dict header text, copy (and decrypt) stream
          // bytes, rewrite trailer text.
          let headerText;
          let streamBytes;
          let trailerText;
          if (isObjEncrypted && entry.offset !== undefined) {
            const raw = extractRawStreamBytes(
              src.pdfBytes, entry.offset,
              src.objCache.encryptionKey, src.objCache.encryptObjNum, src.objCache.cipherMode, oldObjNum,
              src.objCache,
            );
            if (!raw) continue;
            const headerSlice = new Uint8Array(raw.dictText.length);
            for (let i = 0; i < raw.dictText.length; i++) headerSlice[i] = raw.dictText.charCodeAt(i) & 0xFF;
            headerText = `${decryptObjectSliceToText(headerSlice, oldObjNum, src.objCache, raw.data.length)}stream\n`;
            streamBytes = raw.data;
            trailerText = '\nendstream\nendobj';
          } else {
            // PDF allows an optional EOL (CR / LF / CRLF) between stream data and endstream,
            // which is not counted in /Length.
            const headerStr = src.text.substring(range.start, range.streamStart - 7);
            const declaredMatch = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(headerStr);
            const declared = declaredMatch ? Number(declaredMatch[1]) : null;
            const endStreamIdx = src.text.indexOf('endstream', range.streamStart);
            let actualLength = range.streamEnd - range.streamStart;
            if (endStreamIdx >= 0) {
              if (declared !== null) {
                const expectedEnd = range.streamStart + declared;
                const consistent = endStreamIdx === expectedEnd
                  || (endStreamIdx === expectedEnd + 1
                      && (src.pdfBytes[expectedEnd] === 0x0A || src.pdfBytes[expectedEnd] === 0x0D))
                  || (endStreamIdx === expectedEnd + 2
                      && src.pdfBytes[expectedEnd] === 0x0D && src.pdfBytes[expectedEnd + 1] === 0x0A);
                actualLength = consistent ? declared : (endStreamIdx - range.streamStart);
              } else {
                actualLength = endStreamIdx - range.streamStart;
              }
            }
            const fullHeader = src.text.substring(range.start, range.streamStart);
            headerText = fullHeader.replace(/\/Length\s+\d+(?:\s+\d+\s+R)?/, `/Length ${actualLength}`);
            streamBytes = src.pdfBytes.subarray(range.streamStart, range.streamStart + actualLength);
            trailerText = '\nendstream\nendobj';
          }
          const rewrittenHeader = rewriteIndirectRefs(headerText, map)
            .replace(/^\d+\s+\d+\s+obj/, `${newObjNum} 0 obj`);
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
        // Compressed-stream objects come from object streams,
        // which the parser already decrypts on its way in,
        // so getObjectText is plaintext here.
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
  // Preserve the first source's /OCProperties so OCG visibility (watermarks,
  // layered drawings) renders consistently with the source.
  let extraCatalogKeys = '';
  const firstSrc = sources[0];
  const firstMap = sourceMaps[0];
  const firstCatNum = findRootObjNum(firstSrc.pdfBytes);
  if (firstCatNum) {
    const catText = firstSrc.objCache.getObjectText(firstCatNum);
    if (catText) {
      const ocpValue = extractDictKeyValue(catText, '/OCProperties');
      if (ocpValue) extraCatalogKeys += `/OCProperties ${rewriteIndirectRefs(ocpValue, firstMap)}`;
    }
  }
  // Bookmarks: the caller supplies `outline` with destinations indexed into the merged page order.
  if (options.outline && options.outline.length) {
    const built = buildOutlineObjects(options.outline, pageObjNumByIndex, nextObjNum);
    if (built) {
      for (const o of built.objects) allOutputObjects.push(o);
      nextObjNum = built.nextObjNum;
      extraCatalogKeys += `/Outlines ${built.rootObjNum} 0 R`;
    }
  }

  allOutputObjects.push({
    objNum: catalogObjNum,
    content: `${catalogObjNum} 0 obj\n<</Type/Catalog/Pages ${pagesRootObjNum} 0 R${extraCatalogKeys}>>\nendobj\n\n`,
  });
  allOutputObjects.push({
    objNum: pagesRootObjNum,
    content: `${pagesRootObjNum} 0 obj\n<</Type/Pages/Kids[${keptPageRefs.join(' ')}]/Count ${keptPageRefs.length}>>\nendobj\n\n`,
  });

  // Source PDFs can ref obj numbers their own xref doesn't define;
  // we allocate new numbers but never emit content. Backfill with null,
  // since PDF spec resolves an undefined ref to null anyway.
  const emittedObjNums = new Set(allOutputObjects.map((o) => o.objNum));
  for (const map of sourceMaps) {
    for (const newObjNum of map.values()) {
      if (!emittedObjNums.has(newObjNum)) {
        allOutputObjects.push({
          objNum: newObjNum,
          content: `${newObjNum} 0 obj\nnull\nendobj\n\n`,
        });
        emittedObjNums.add(newObjNum);
      }
    }
  }

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
      if (typeof hdr === 'string') {
        parts.push(hdr);
        byteLen += hdr.length;
      } else {
        parts.push(hdr);
        byteLen += hdr.length;
      }
      parts.push(c.streamData);
      byteLen += c.streamData.length;
      const tr = c.trailer;
      if (typeof tr === 'string') {
        parts.push(tr);
        byteLen += tr.length;
      } else {
        parts.push(tr);
        byteLen += tr.length;
      }
    }
  }

  const newXrefOffset = byteLen;
  let totalSize = nextObjNum;
  for (const o of allOutputObjects) if (o.objNum + 1 > totalSize) totalSize = o.objNum + 1;
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
