import {
  resolveArrayValue, resolveNumArray, resolveIntValue, scopeDictKeys, formatPdfDate,
} from '../../pdf/pdfPrimitives.js';
import { stripTopLevelKey } from './writePdfFormFields.js';

/**
 * Build in-place `/Subtype /Stamp` object replacements and `/Annots` drops for one page.
 * @param {Object} params
 * @param {import('../../pdf/objectCache.js').ObjectCache} params.objCache
 * @param {{ objText: string }} params.pageInfo
 * @param {Array<Annotation>} params.pageAnnotations - The page's rows.
 * @param {?Array<{srcRef: number, bbox: bbox}>} params.liftedStamps - The stamp annotations the import lifted from this page, with their boxes as read.
 *   Null when unknown, and then no deletion is detected.
 * @param {(bbox: bbox) => ?[number, number, number, number]} params.toRect - Maps a row's box to the page's user space.
 * @param {boolean} params.scrub - Strip the reviewer's identity (/T, /CreationDate, /M, /NM, /RC) from a rewritten annotation, as the scrub does to every other markup annotation.
 * @param {(message: string) => void} [params.warningHandler]
 * @returns {{ replacements: Array<{objNum: number, content: string}>, dropObjNums: Set<number> }}
 *   `replacements` are the rewritten annotation objects under their source numbers.
 *   `dropObjNums` are the source annotations to omit from the page's /Annots.
 */
export function pageStampEdits({
  objCache, pageInfo, pageAnnotations, liftedStamps, toRect, scrub, warningHandler,
}) {
  /** @type {Array<{objNum: number, content: string}>} */
  const replacements = [];
  /** @type {Set<number>} */
  const dropObjNums = new Set();
  const stampRows = /** @type {Array<AnnotationStamp>} */ (pageAnnotations.filter((a) => a.type === 'stamp'));
  if (stampRows.length === 0 && !(liftedStamps && liftedStamps.length)) return { replacements, dropObjNums };

  const annotsText = resolveArrayValue(pageInfo.objText, 'Annots', objCache);
  const annotRefs = annotsText ? [...annotsText.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1])) : [];
  const stampTextOf = (/** @type {number} */ objNum) => {
    if (!annotRefs.includes(objNum)) return null;
    const text = objCache.getObjectText(objNum);
    return text && /\/Subtype\s*\/Stamp\b/.test(scopeDictKeys(text).keyText('Subtype')) ? text : null;
  };
  const fmt = (/** @type {number} */ v) => String(Math.round(v * 10000) / 10000);

  for (const row of stampRows) {
    const text = stampTextOf(row.srcRef);
    if (!text) {
      if (typeof warningHandler === 'function') warningHandler(`Stamp annotation ${row.srcRef} is not on its page in the source PDF, so its row was not written.`);
      continue;
    }
    const rect = toRect(row.bbox);
    // Keys are read at the top level alone, since a producer's private dictionary inside the annotation can carry its own /Rect.
    const annotKeys = scopeDictKeys(text);
    const srcRect = resolveNumArray(annotKeys.keyText('Rect'), 'Rect', objCache, null);
    if (!rect || !srcRect || srcRect.length < 4) continue;
    const src = [Math.min(srcRect[0], srcRect[2]), Math.min(srcRect[1], srcRect[3]), Math.max(srcRect[0], srcRect[2]), Math.max(srcRect[1], srcRect[3])];
    // An untouched row maps back onto the annotation's own rect, give or take float error.
    if (rect.every((v, i) => Math.abs(v - src[i]) < 0.05)) continue;

    let dict = stripTopLevelKey(stripTopLevelKey(stripTopLevelKey(text, 'Rect'), 'F'), 'M');
    let insert = ` /Rect [${rect.map(fmt).join(' ')}]`;
    // Clear Locked (bit 8) so a moved or resized stamp annotation exports unlocked.
    const flags = resolveIntValue(annotKeys.keyText('F'), 'F', objCache, 0);
    if (flags) insert += ` /F ${flags & ~128}`;
    if (scrub) {
      for (const key of ['T', 'CreationDate', 'NM', 'RC']) dict = stripTopLevelKey(dict, key);
    } else {
      insert += ` /M (${formatPdfDate(new Date())})`;
    }
    const closeIdx = dict.lastIndexOf('>>');
    if (closeIdx === -1) continue;
    replacements.push({ objNum: row.srcRef, content: `${row.srcRef} 0 obj\n${dict.slice(0, closeIdx)}${insert}${dict.slice(closeIdx)}\nendobj\n\n` });
  }

  for (const lifted of liftedStamps || []) {
    if (stampRows.some((r) => r.srcRef === lifted.srcRef) || !stampTextOf(lifted.srcRef)) continue;
    dropObjNums.add(lifted.srcRef);
  }
  if (dropObjNums.size > 0) {
    for (const ref of annotRefs) {
      if (dropObjNums.has(ref)) continue;
      let text = objCache.getObjectText(ref);
      // The depth cap guards malformed cyclic chains.
      for (let depth = 0; text && depth < 8; depth++) {
        const irt = /\/IRT\s+(\d+)\s+\d+\s+R/.exec(scopeDictKeys(text).keyText('IRT'));
        if (!irt) break;
        if (dropObjNums.has(Number(irt[1]))) {
          dropObjNums.add(ref);
          break;
        }
        text = objCache.getObjectText(Number(irt[1]));
      }
    }
  }
  return { replacements, dropObjNums };
}
