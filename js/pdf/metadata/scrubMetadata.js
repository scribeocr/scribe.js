/**
 * Metadata scrubbing for the object-preserving PDF rebuild (subsetPdf/mergePdfs).
 * Before each object is copied, this removes identifying metadata by dict parse, never regex:
 * it drops `/Metadata`, `/PieceInfo`, `/AA` top-level keys (the referenced streams then orphan and are not copied),
 * rewrites filename-leaking OCG layer names, and losslessly strips EXIF/XMP from embedded JPEG/JPX image streams.
 *
 * Companion reader: `metadataInspect.js`.
 */
import { extractDict, parseDictEntries } from '../pdfPrimitives.js';
import { extractRawStreamBytes } from '../parsePdfUtils.js';
import { stripJpegMetadata, stripJpxMetadata } from './imageMetadata.js';

// Top-level dict keys dropped from every copied object.
// `Info` is included because outside the trailer a `/Info` key is only ever a document-information dictionary.
const DROP_ALWAYS = new Set(['Metadata', 'PieceInfo', 'AA', 'Info']);
// Matches a string that looks like a source filename or path (a leak to scrub).
// Requires a real file extension or an absolute path, not just a slash, so benign names like "Headers/Footers" don't match.
const FILENAME_LIKE = /\.(pdf|ai|psd|indd|tiff?|jpe?g|png|docx?|xlsx?|pptx?|eps|svg)\b|[A-Za-z]:\\|\/(?:Users|home|Volumes)\//i;

/**
 * Dispatch to the right image-stream stripper for a PDF image /Filter.
 * Returns bytes unchanged for filters that cannot carry identifying metadata (Flate/LZW/CCITT/JBIG2 raster data).
 * @param {Uint8Array} bytes
 * @param {string|null} filter - The image's /Filter (e.g. 'DCTDecode', 'JPXDecode').
 * @returns {Uint8Array}
 */
function stripImageStreamMetadata(bytes, filter) {
  if (!filter) return bytes;
  if (filter.includes('DCTDecode')) return stripJpegMetadata(bytes);
  if (filter.includes('JPXDecode')) return stripJpxMetadata(bytes);
  return bytes;
}

// A document-information dictionary can hang off any key, so it must be recognised by content, not by the referring key.
// Any of these fields marks a dict as doc-info, because they never appear on functional objects (unlike `/Title`).
const INFO_STRONG = ['Author', 'Creator', 'Producer', 'Company', 'Manager'];
// These fields are scrubbed from a dict already identified as info-like.
// `/Title` is in the set but only dropped from such a dict, never from a functional one such as an outline item.
const INFO_FIELDS = new Set([...INFO_STRONG, 'Title', 'Subject', 'Keywords', 'CreationDate', 'ModDate', 'Trapped']);

/** True if a dict body is a document-information dictionary (see INFO_STRONG). */
function bodyIsInfoLike(body) {
  for (const e of parseDictEntries(body)) if (INFO_STRONG.includes(e.name)) return true;
  return false;
}

/** Balanced default: strip identifying data, keep accessibility/page-labels/viewer-prefs. */
export function defaultScrubOpts() {
  return {
    stripStructTree: false, stripPageLabels: false, stripViewerPrefs: false, dropOCProperties: false,
  };
}

/** True if a dict body has a top-level key this scrub would remove. */
function bodyHasDropKey(body) {
  for (const e of parseDictEntries(body)) if (DROP_ALWAYS.has(e.name)) return true;
  return false;
}

/**
 * Rebuild a dict body keeping only non-dropped entries.
 * @returns {{dict: string, changed: boolean}} `dict` includes the `<<`/`>>` wrapper.
 */
function rebuildDict(body, { lengthOverride = null, ocgLabel = null } = {}) {
  const kept = [];
  let changed = false;
  const infoLike = bodyIsInfoLike(body);
  for (const e of parseDictEntries(body)) {
    if (DROP_ALWAYS.has(e.name)) { changed = true; continue; }
    // A document-information dictionary hung off an arbitrary key: strip its identifying fields in place,
    // leaving the (now-empty) object so whatever references it does not dangle.
    if (infoLike && INFO_FIELDS.has(e.name)) { changed = true; continue; }
    if (e.name === 'Length' && lengthOverride != null) { kept.push(`/Length ${lengthOverride}`); changed = true; continue; }
    if (e.name === 'Name' && ocgLabel && FILENAME_LIKE.test(e.valueText)) { kept.push(`/Name (${ocgLabel})`); changed = true; continue; }
    // Accessibility alt-text and actual-text often carry the source image's local path or filename.
    // Drop only when the value looks like a path or filename, keeping real descriptions.
    if ((e.name === 'Alt' || e.name === 'ActualText') && FILENAME_LIKE.test(e.valueText)) { changed = true; continue; }
    kept.push(`/${e.name} ${e.valueText}`);
  }
  if (lengthOverride != null && !kept.some((k) => k.startsWith('/Length '))) kept.push(`/Length ${lengthOverride}`);
  return { dict: `<<${kept.join(' ')}>>`, changed };
}

/**
 * Scrub a dict's text (non-stream): drop metadata keys and empty an info-like dict.
 * Also serves as the trace-ref transform, so refs under a dropped key are not followed.
 */
export function scrubPageDictText(pageText) {
  const dictStart = pageText.indexOf('<<');
  if (dictStart === -1) return pageText;
  const dictText = extractDict(pageText, dictStart);
  const body = dictText.slice(2, -2);
  if (!bodyHasDropKey(body) && !bodyIsInfoLike(body)) return pageText;
  const { dict } = rebuildDict(body);
  return pageText.slice(0, dictStart) + dict + pageText.slice(dictStart + dictText.length);
}

/**
 * Scrub a referenced object that the rebuild is about to copy. Returns:
 *  - `null` if no scrub needed (caller keeps the fast byte-for-byte copy),
 *  - a string (scrubbed non-stream object),
 *  - a `{header, streamData, trailer}` binary object (scrubbed stream object).
 *
 * @param {Uint8Array} pdfBytes
 * @param {object} objCache
 * @param {{type:number, offset:number}} entry
 * @param {number} objNum
 * @param {{imageFilter:(n:number)=>string|null, ocgCounter:{n:number}}} ctx
 */
export function scrubReferencedObject(pdfBytes, objCache, entry, objNum, ctx) {
  const objText = objCache.getObjectText(objNum);
  if (!objText) return null;
  const dictStart = objText.indexOf('<<');
  if (dictStart === -1) return null;
  const dictText = extractDict(objText, dictStart);
  const body = dictText.slice(2, -2);

  const isOCG = /\/Type\s*\/OCG\b/.test(objText);
  const ocgLabel = isOCG ? `Layer ${ctx.ocgCounter.n + 1}` : null;
  const filter = ctx.imageFilter ? ctx.imageFilter(objNum) : null;
  const isImage = /\/Subtype\s*\/Image\b/.test(objText);

  const dropKey = bodyHasDropKey(body);
  const infoLike = bodyIsInfoLike(body);
  const leakyOcg = isOCG && /\/Name\s*[(<]/.test(body) && parseDictEntries(body).some((e) => e.name === 'Name' && FILENAME_LIKE.test(e.valueText));
  const leakyAlt = /\/(?:Alt|ActualText)\s*[(<]/.test(body) && parseDictEntries(body).some((e) => (e.name === 'Alt' || e.name === 'ActualText') && FILENAME_LIKE.test(e.valueText));
  const streamKw = objText.indexOf('stream', dictStart + dictText.length);
  const isStream = streamKw !== -1;
  const strippableImage = isImage && isStream && filter && (filter.includes('DCTDecode') || filter.includes('JPXDecode'));

  if (!dropKey && !infoLike && !leakyOcg && !strippableImage && !leakyAlt) return null;
  if (isOCG && leakyOcg) ctx.ocgCounter.n += 1;

  if (!isStream) {
    const { dict, changed } = rebuildDict(body, { ocgLabel });
    return changed ? `${objNum} 0 obj\n${dict}\nendobj\n\n` : null;
  }

  // Stream object: re-emit dict + (possibly stripped) encoded stream, /Length corrected.
  let raw;
  try {
    raw = extractRawStreamBytes(pdfBytes, entry.offset, objCache.encryptionKey ?? null, objCache.encryptObjNum ?? -1, objCache.cipherMode ?? '', objNum);
  } catch { raw = null; }
  if (!raw || !raw.data) return null; // cannot re-emit safely → leave to raw copy
  let data = raw.data;
  if (strippableImage) {
    const stripped = stripImageStreamMetadata(data, filter);
    if (stripped.length !== data.length) data = stripped;
  }
  const { dict } = rebuildDict(body, { lengthOverride: data.length, ocgLabel });
  return { header: `${objNum} 0 obj\n${dict}\nstream\n`, streamData: data, trailer: '\nendstream\nendobj\n\n' };
}

/** Extract `/Key value` entries to carry forward onto the rebuilt catalog (keep-by-default structure). */
export function catalogKeepEntries(catBody, opts) {
  const keep = [];
  const wants = {
    StructTreeRoot: !opts.stripStructTree,
    MarkInfo: !opts.stripStructTree,
    Lang: true,
    PageLabels: !opts.stripPageLabels,
    ViewerPreferences: !opts.stripViewerPrefs,
  };
  for (const e of parseDictEntries(catBody)) {
    if (wants[e.name]) keep.push({ name: e.name, valueText: e.valueText, tracing: e.valueText });
  }
  return keep;
}
