/**
 * Read every category of identifying metadata in a PDF, for the metadata viewer and to validate removal.
 * Values are surfaced raw, so the user sees exactly what is embedded.
 *
 * Companion remover: `scrubMetadata.js`.
 */
import {
  findXrefOffset, parseXref, findRootObjNum,
} from '../parsePdfUtils.js';
import { ObjectCache } from '../objectCache.js';
import {
  extractDict, extractDictFromBytes, parseDictEntries, findTopLevelKeyIndex, bytesToLatin1, byteLastIndexOf, byteIndexOf, decodePdfString,
} from '../pdfPrimitives.js';
import { extractImages } from '../parsePdfImages.js';
import { inspectJpegMetadata, inspectJpxMetadata } from './imageMetadata.js';

/** The inner body (between `<<` and `>>`) of the first dict in an object's text, or '' if none. */
function dictBodyOf(text) {
  if (!text) return '';
  const start = text.indexOf('<<');
  if (start === -1) return '';
  const dict = extractDict(text, start);
  return dict.length >= 4 ? dict.slice(2, -2) : '';
}

/** Value text of a top-level key in a dict body, or null. `key` includes the leading slash. */
function topValue(dictBody, key) {
  const idx = findTopLevelKeyIndex(dictBody, key);
  if (idx === -1) return null;
  for (const e of parseDictEntries(dictBody)) if (`/${e.name}` === key) return e.valueText.trim();
  return null;
}

/**
 * Count cross-reference sections in the `/Prev` chain.
 * >1 means the file retains prior incremental-save revisions that still carry old metadata.
 * @param {Uint8Array} pdfBytes
 * @returns {number}
 */
export function countXrefRevisions(pdfBytes) {
  let off = findXrefOffset(pdfBytes);
  const seen = new Set();
  let count = 0;
  const headerOff = Math.max(0, byteIndexOf(pdfBytes, '%PDF'));
  while (off != null && off >= 0 && !seen.has(off) && count < 64) {
    seen.add(off);
    count += 1;
    const abs = off + (off < pdfBytes.length ? 0 : 0);
    // Read a window and find this section's trailer/xref-stream dict, then its /Prev.
    const isTable = bytesToLatin1(pdfBytes, abs, Math.min(abs + 4, pdfBytes.length)) === 'xref';
    let dictText = '';
    if (isTable) {
      const tIdx = byteIndexOf(pdfBytes, 'trailer', abs);
      if (tIdx !== -1) dictText = bytesToLatin1(pdfBytes, tIdx, Math.min(tIdx + 600, pdfBytes.length));
    } else {
      let ds = -1;
      for (let i = abs; i < Math.min(abs + 400, pdfBytes.length - 1); i++) if (pdfBytes[i] === 0x3C && pdfBytes[i + 1] === 0x3C) { ds = i; break; }
      if (ds !== -1) dictText = extractDictFromBytes(pdfBytes, ds);
    }
    const m = /\/Prev\s+(\d+)/.exec(dictText);
    off = m ? Number(m[1]) + headerOff : null;
  }
  return count;
}

/** Latest trailer / xref-stream dict text (for /Info, /ID, /Encrypt). */
function trailerDictText(pdfBytes) {
  const len = pdfBytes.length;
  const startxrefIdx = byteLastIndexOf(pdfBytes, 'startxref');
  const trailerIdx = startxrefIdx !== -1 ? byteLastIndexOf(pdfBytes, 'trailer', startxrefIdx) : byteLastIndexOf(pdfBytes, 'trailer');
  if (trailerIdx !== -1) return bytesToLatin1(pdfBytes, trailerIdx, Math.min(trailerIdx + 800, len));
  // xref-stream form: read the dict at the startxref offset.
  const off = findXrefOffset(pdfBytes);
  if (off != null && off >= 0) {
    for (let i = off; i < Math.min(off + 400, len - 1); i++) if (pdfBytes[i] === 0x3C && pdfBytes[i + 1] === 0x3C) return extractDictFromBytes(pdfBytes, i);
  }
  return '';
}

/**
 * Enumerate all identifying metadata in a PDF.
 * @param {Uint8Array} pdfBytes
 * @returns {object} grouped raw-value metadata report
 */
export function getMetadata(pdfBytes) {
  const xrefEntries = parseXref(pdfBytes, findXrefOffset(pdfBytes));
  const objCache = new ObjectCache(pdfBytes, xrefEntries);
  const report = {
    info: null,
    docId: null,
    xmp: { catalog: null, perObject: [] },
    pieceInfo: [],
    ocgs: [],
    embeddedFiles: [],
    actions: { openAction: false, aa: false, javascript: false },
    images: [],
    structTree: false,
    lang: null,
    pageLabels: false,
    viewerPreferences: false,
    signatures: [],
    customInfo: [],
    annotationAuthors: [],
    priorRevisions: 0,
    encrypted: false,
  };

  // Trailer: /Info, /ID, /Encrypt
  const trailer = trailerDictText(pdfBytes);
  report.encrypted = /\/Encrypt\s+\d+\s+\d+\s+R/.test(trailer);
  const idM = /\/ID\s*\[\s*(<[0-9A-Fa-f\s]*>|\([^)]*\))/.exec(trailer);
  if (idM) report.docId = idM[1];
  const infoM = /\/Info\s+(\d+)\s+\d+\s+R/.exec(trailer);
  const infoObjNum = infoM ? Number(infoM[1]) : -1;
  if (infoM) {
    const body = dictBodyOf(objCache.getObjectText(Number(infoM[1])));
    if (body) {
      const info = {};
      for (const e of parseDictEntries(body)) info[e.name] = decodePdfString(e.valueText.trim());
      if (Object.keys(info).length) report.info = info;
    }
  }

  // Catalog-level keys
  const rootNum = findRootObjNum(pdfBytes);
  const catBody = rootNum != null ? dictBodyOf(objCache.getObjectText(rootNum)) : '';
  if (catBody) {
    const catMeta = /\/Metadata\s+(\d+)\s+\d+\s+R/.exec(catBody);
    if (catMeta) { try { report.xmp.catalog = bytesToLatin1(objCache.getStreamBytes(Number(catMeta[1]))); } catch { report.xmp.catalog = '(unreadable)'; } }
    report.actions.openAction = findTopLevelKeyIndex(catBody, '/OpenAction') !== -1;
    report.actions.aa = findTopLevelKeyIndex(catBody, '/AA') !== -1;
    report.structTree = findTopLevelKeyIndex(catBody, '/StructTreeRoot') !== -1;
    report.pageLabels = findTopLevelKeyIndex(catBody, '/PageLabels') !== -1;
    report.viewerPreferences = findTopLevelKeyIndex(catBody, '/ViewerPreferences') !== -1;
    const langV = topValue(catBody, '/Lang');
    if (langV) report.lang = decodePdfString(langV);
    const namesV = topValue(catBody, '/Names');
    if (namesV) {
      const namesBody = /^\d+\s+\d+\s+R/.test(namesV) ? dictBodyOf(objCache.getObjectText(Number(namesV))) : (namesV.startsWith('<<') ? namesV.slice(2, -2) : '');
      if (namesBody) {
        report.actions.javascript = findTopLevelKeyIndex(namesBody, '/JavaScript') !== -1;
      }
    }
  }

  // Per-object sweep: XMP, PieceInfo, OCG names, Filespec (embedded files), Sig
  for (const objNumStr of Object.keys(xrefEntries)) {
    const objNum = Number(objNumStr);
    const text = objCache.getObjectText(objNum);
    if (!text) continue;
    // per-object XMP (image/page/form) — excludes the catalog one (handled above)
    if (/\/Type\s*\/Metadata\b/.test(text) && objNum !== (catBody && /\/Metadata\s+(\d+)/.exec(catBody) ? Number(/\/Metadata\s+(\d+)/.exec(catBody)[1]) : -1)) {
      if (report.xmp.perObject.length < 200) {
        let xmp = null; try { xmp = bytesToLatin1(objCache.getStreamBytes(objNum)); } catch { /* skip */ }
        report.xmp.perObject.push({ objNum, bytes: xmp ? xmp.length : 0 });
      }
    }
    const body = dictBodyOf(text);
    if (body) {
      if (findTopLevelKeyIndex(body, '/PieceInfo') !== -1) report.pieceInfo.push({ objNum });
      if (/\/Type\s*\/OCG\b/.test(text)) {
        const nameV = topValue(body, '/Name');
        if (nameV) report.ocgs.push({ objNum, name: decodePdfString(nameV) });
      }
      if (/\/Type\s*\/Filespec\b/.test(text)) {
        const fn = topValue(body, '/UF') || topValue(body, '/F');
        report.embeddedFiles.push({ objNum, name: fn ? decodePdfString(fn) : '(unnamed)' });
      }
      if (/\/Type\s*\/Sig\b/.test(text) || (findTopLevelKeyIndex(body, '/ByteRange') !== -1 && findTopLevelKeyIndex(body, '/Contents') !== -1 && /\/(Sig|DocTimeStamp)\b/.test(text))) {
        report.signatures.push({ objNum, subFilter: topValue(body, '/SubFilter') });
      }
      // Info-identifying keys never appear on a functional object, so a non-trailer dict carrying one is a hidden custom info dict a strip must remove.
      if (objNum !== infoObjNum && !/\/Type\s*\/(Metadata|Catalog)\b/.test(text)
        && /\/(Author|Producer|Creator|Company|Manager)\s*[(<]/.test(body)) {
        const infoKeys = parseDictEntries(body).map((e) => e.name)
          .filter((k) => ['Author', 'Producer', 'Creator', 'Company', 'Manager', 'Title', 'Subject', 'Keywords', 'Signer(s)'].includes(k));
        if (infoKeys.some((k) => ['Author', 'Producer', 'Creator', 'Company', 'Manager'].includes(k))) {
          report.customInfo.push({ objNum, keys: infoKeys });
        }
      }
      // /T holds the reviewer's name on a markup annotation but the field name on a Widget.
      if (/\/Type\s*\/Annot\b/.test(text) && !/\/Subtype\s*\/Widget\b/.test(text)) {
        const authorV = topValue(body, '/T');
        if (authorV) report.annotationAuthors.push({ objNum, author: decodePdfString(authorV) });
      }
    }
  }

  // Image-internal metadata in JPEG/JPX streams
  let images = {};
  try { images = extractImages(pdfBytes) || {}; } catch { images = {}; }
  for (const [objNum, meta] of Object.entries(images)) {
    if (!meta.filter) continue;
    let bytes; try { bytes = objCache.getStreamBytes(Number(objNum)); } catch { continue; }
    if (!bytes) continue;
    if (/DCTDecode/.test(meta.filter)) {
      const j = inspectJpegMetadata(bytes);
      if (j.hasExif || j.hasXmp || j.hasIptc) report.images.push({ objNum: Number(objNum), filter: 'DCTDecode', ...j });
    } else if (/JPXDecode/.test(meta.filter)) {
      const x = inspectJpxMetadata(bytes);
      if (x.hasXml || x.hasUuid) report.images.push({ objNum: Number(objNum), filter: 'JPXDecode', ...x });
    }
  }

  report.priorRevisions = countXrefRevisions(pdfBytes);
  return report;
}

/**
 * Doc-level metadata report.
 * Reads the primary source plus any foreign sources from cross-document page copy (attached as `additionalSources`).
 * Returns null for a document with no PDF source.
 * @param {import('../../containers/scribeDoc.js').ScribeDoc} doc
 * @returns {?object}
 */
export function getMetadataImpl(doc) {
  const images = doc?.images;
  const primaryBytes = images?.pdfData;
  if (!primaryBytes) return null;
  const toU8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));
  const report = getMetadata(toU8(primaryBytes));
  if (images.sources && images.sources.size > 1) {
    const extra = [];
    for (const [id, src] of images.sources) {
      if (id === images.primarySourceId || !src?.pdfData) continue;
      extra.push({ sourceId: id, report: getMetadata(toU8(src.pdfData)) });
    }
    if (extra.length) report.additionalSources = extra;
  }
  return report;
}
