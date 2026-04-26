import { extractDict } from '../../pdf/parsePdfUtils.js';

/**
 * Parse the trailer dict to extract /Root reference and /Size.
 * @param {string} text
 * @param {number} xrefOffset
 */
export function parseTrailerInfo(text, xrefOffset) {
  const atOffset = text.substring(xrefOffset, xrefOffset + 50);
  let dictText;

  if (/^\d+ \d+ obj/.test(atOffset)) {
    // Xref stream: the dict is in the stream object itself
    const dictStart = text.indexOf('<<', xrefOffset);
    dictText = extractDict(text, dictStart);
  } else {
    // Traditional trailer
    const trailerStart = text.indexOf('trailer', xrefOffset);
    if (trailerStart === -1) {
      return { rootRef: '1 0 R', size: 1 };
    }
    const dictStart = text.indexOf('<<', trailerStart);
    dictText = extractDict(text, dictStart);
  }

  const rootMatch = /\/Root\s+(\d+)\s+(\d+)\s+R/.exec(dictText);
  const sizeMatch = /\/Size\s+(\d+)/.exec(dictText);

  return {
    rootRef: rootMatch ? `${rootMatch[1]} ${rootMatch[2]} R` : '1 0 R',
    size: sizeMatch ? Number(sizeMatch[1]) : 1,
  };
}

/**
 * Build an incremental xref table, trailer, startxref, and %%EOF.
 * @param {Array<{objNum: number, offset: number}>} entries
 * @param {number} totalSize - Total object count (must be >= highest objNum + 1)
 * @param {number} prevXrefOffset - Offset of the previous xref section
 * @param {string} rootRef - The /Root reference e.g. "1 0 R"
 * @param {number} newXrefOffset - Byte offset where this xref section starts
 */
export function buildIncrementalXrefAndTrailer(entries, totalSize, prevXrefOffset, rootRef, newXrefOffset) {
  // Sort entries by object number
  const sorted = entries.slice().sort((a, b) => a.objNum - b.objNum);

  let xrefStr = 'xref\n';

  // Generate xref subsections (groups of contiguous object numbers)
  let i = 0;
  while (i < sorted.length) {
    const rangeStart = i;
    let rangeEnd = i;
    // Find contiguous range
    while (rangeEnd + 1 < sorted.length && sorted[rangeEnd + 1].objNum === sorted[rangeEnd].objNum + 1) {
      rangeEnd++;
    }
    const startObj = sorted[rangeStart].objNum;
    const count = rangeEnd - rangeStart + 1;
    xrefStr += `${startObj} ${count}\n`;
    for (let j = rangeStart; j <= rangeEnd; j++) {
      xrefStr += `${String(sorted[j].offset).padStart(10, '0')} 00000 n \n`;
    }
    i = rangeEnd + 1;
  }

  xrefStr += 'trailer\n';
  xrefStr += `<</Size ${totalSize}/Root ${rootRef}/Prev ${prevXrefOffset}>>\n`;
  xrefStr += 'startxref\n';
  xrefStr += `${newXrefOffset}\n`;
  xrefStr += '%%EOF\n';

  return xrefStr;
}

/**
 * BFS traversal to find all objects transitively referenced from starting text(s).
 * Follows all indirect references (N M R) except those in the exclusion set.
 * Skips /Parent references from page dicts to avoid pulling in the page tree.
 * @param {string[]} startingTexts - Text contents to start tracing from
 * @param {import('../../pdf/parsePdfUtils.js').ObjectCache} objCache
 * @param {Set<number>} excludeObjNums - Object numbers to skip (page tree objects)
 */
export function traceReferencedObjects(startingTexts, objCache, excludeObjNums) {
  const visited = new Set();
  const queue = [];

  for (const startText of startingTexts) {
    // Find /Parent reference to exclude (relevant for page dicts)
    const parentMatch = /\/Parent\s+(\d+)\s+\d+\s+R/.exec(startText);
    const parentObjNum = parentMatch ? Number(parentMatch[1]) : -1;

    const refs = [...startText.matchAll(/(\d+)\s+\d+\s+R/g)];
    for (const ref of refs) {
      const objNum = Number(ref[1]);
      if (objNum === parentObjNum) continue;
      if (excludeObjNums.has(objNum)) continue;
      if (!visited.has(objNum)) {
        visited.add(objNum);
        queue.push(objNum);
      }
    }
  }

  while (queue.length > 0) {
    const objNum = /** @type {number} */ (queue.shift());
    const objText = objCache.getObjectText(objNum);
    if (!objText) continue;

    const refs = [...objText.matchAll(/(\d+)\s+\d+\s+R/g)];
    for (const ref of refs) {
      const refNum = Number(ref[1]);
      if (excludeObjNums.has(refNum)) continue;
      if (!visited.has(refNum)) {
        visited.add(refNum);
        queue.push(refNum);
      }
    }
  }

  return visited;
}

/**
 * Build a standalone xref table and trailer for a new PDF (not incremental).
 *
 * @param {Array<{objNum: number, offset: number}>} entries
 * @param {number} totalSize
 * @param {string} rootRef - e.g. "5 0 R"
 * @param {number} xrefOffset
 */
export function buildFullXrefAndTrailer(entries, totalSize, rootRef, xrefOffset) {
  const sorted = entries.slice().sort((a, b) => a.objNum - b.objNum);

  let xrefStr = 'xref\n';

  // Free entry for object 0
  xrefStr += '0 1\n';
  xrefStr += '0000000000 65535 f \n';

  // Generate subsections for contiguous ranges
  let i = 0;
  while (i < sorted.length) {
    const rangeStart = i;
    let rangeEnd = i;
    while (rangeEnd + 1 < sorted.length && sorted[rangeEnd + 1].objNum === sorted[rangeEnd].objNum + 1) {
      rangeEnd++;
    }
    const startObj = sorted[rangeStart].objNum;
    const count = rangeEnd - rangeStart + 1;
    xrefStr += `${startObj} ${count}\n`;
    for (let j = rangeStart; j <= rangeEnd; j++) {
      xrefStr += `${String(sorted[j].offset).padStart(10, '0')} 00000 n \n`;
    }
    i = rangeEnd + 1;
  }

  xrefStr += 'trailer\n';
  xrefStr += `<</Size ${totalSize}/Root ${rootRef}>>\n`;
  xrefStr += 'startxref\n';
  xrefStr += `${xrefOffset}\n`;
  xrefStr += '%%EOF\n';

  return xrefStr;
}

/**
 * Locate a type-1 object's exact byte range in the source PDF.
 * @param {Uint8Array} pdfBytes
 * @param {string} text
 * @param {import('../../pdf/parsePdfUtils.js').ObjectCache} objCache
 * @param {{type: number, offset: number}} entry
 */
export function locateObjectByteRange(pdfBytes, text, objCache, entry) {
  const offset = entry.offset;
  let searchFrom = offset;
  let streamStart = offset;
  let streamEnd = offset;

  const streamKw = text.indexOf('stream', offset);
  const firstEndObj = text.indexOf('endobj', offset);
  if (firstEndObj === -1) return null;

  if (streamKw !== -1 && streamKw < firstEndObj) {
    // Stream object: use /Length to skip past stream data.
    const headerText = text.substring(offset, streamKw);
    const indirectLenMatch = /\/Length\s+(\d+)\s+\d+\s+R/.exec(headerText);
    const directLenMatch = /\/Length\s+(\d+)/.exec(headerText);
    let streamLength = 0;
    if (indirectLenMatch) {
      const refObjNum = Number(indirectLenMatch[1]);
      const refText = objCache.getObjectText(refObjNum);
      if (refText) streamLength = Number(refText.trim());
    } else if (directLenMatch) {
      streamLength = Number(directLenMatch[1]);
    }
    streamStart = streamKw + 6;
    if (pdfBytes[streamStart] === 0x0D && pdfBytes[streamStart + 1] === 0x0A) {
      streamStart += 2;
    } else if (pdfBytes[streamStart] === 0x0A || pdfBytes[streamStart] === 0x0D) {
      streamStart += 1;
    }
    streamEnd = streamStart + streamLength;
    searchFrom = streamEnd;
  }

  const endObjPos = text.indexOf('endobj', searchFrom);
  if (endObjPos === -1) return null;
  return {
    start: offset,
    end: endObjPos + 6,
    streamStart,
    streamEnd,
  };
}

/**
 * Copy a type-1 object's raw bytes from the source PDF, preserving binary stream data exactly.
 * @param {Uint8Array} pdfBytes
 * @param {string} text
 * @param {import('../../pdf/parsePdfUtils.js').ObjectCache} objCache
 * @param {{type: number, offset: number}} entry
 */
export function copyRawObjectBytes(pdfBytes, text, objCache, entry) {
  const range = locateObjectByteRange(pdfBytes, text, objCache, entry);
  if (!range) return null;
  const rawCopy = new Uint8Array(range.end - range.start + 2);
  rawCopy.set(pdfBytes.subarray(range.start, range.end));
  rawCopy[range.end - range.start] = 0x0A;
  rawCopy[range.end - range.start + 1] = 0x0A;
  return rawCopy;
}
