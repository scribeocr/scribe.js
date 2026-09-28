// A substitute face is a built-in font that draws a character typed into a text edit when the page's own font has no glyph for it.
import opentype from '../font-parser/src/index.js';
import { createEmbeddedFontType0, type0FontObjectParts } from '../export/pdf/writePdfFonts.js';

/** @type {Record<string, string>} */
const VARIANTS = {
  normal: 'Regular', bold: 'Bold', italic: 'Italic', boldItalic: 'BoldItalic',
};

/**
 * The resource name a substitute face is drawn under.
 * A face may declare the ascent and descent of the page font it stands in for, so each distinct pair is a separate face with its own name.
 * @param {string} family
 * @param {string} styleKey
 * @param {?{ ascent: number, descent: number }} [metrics] - Per 1000 em of the face.
 */
export const substituteFaceTag = (family, styleKey, metrics = null) => `EDF${family}${VARIANTS[styleKey] || 'Regular'}${
  metrics ? `A${Math.round(metrics.ascent)}D${Math.round(Math.abs(metrics.descent))}` : ''}`.replace(/[^A-Za-z0-9]/g, '');

/** @type {Map<string, Promise<opentype.Font>>} */
const programs = new Map();

/**
 * The complete built-in face, parsed once.
 * Every consumer embeds this one file, so glyph ids and widths agree between the document's object cache and the export.
 * @param {string} family
 * @param {string} styleKey
 * @returns {Promise<opentype.Font>}
 */
export function loadSubstituteProgram(family, styleKey) {
  const key = `${family}/${styleKey}`;
  let p = programs.get(key);
  if (!p) {
    p = (async () => {
      const variant = VARIANTS[styleKey] || 'Regular';
      const stem = family === 'Gothic' ? 'URWGothicBook' : family;
      const url = new URL(`../../fonts/all/${stem}-${variant}.woff`, import.meta.url);
      /** @type {ArrayBuffer} */
      let buffer;
      if (typeof process !== 'undefined' && typeof document === 'undefined') {
        const { fileURLToPath } = await import('node:url');
        const { readFileSync } = await import('node:fs');
        const bytes = readFileSync(fileURLToPath(url));
        buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      } else {
        buffer = await fetch(url).then((r) => r.arrayBuffer());
      }
      return opentype.parse(buffer);
    })();
    programs.set(key, p);
    p.catch(() => programs.delete(key));
  }
  return p;
}

/**
 * @typedef {{ tag: string, objNum: number, font: opentype.Font, family: string, styleKey: string, metrics: ?{ ascent: number, descent: number }, base: ?SubstituteFaceEntry }} SubstituteFaceEntry
 *   `base` is the face whose widths, program and ToUnicode map this face shares, null for the first face of its family and style.
 */

/** @type {WeakMap<object, Map<string, SubstituteFaceEntry>>} */
const registries = new WeakMap();

// Kept clear of the renderer's synthetic appearance streams, which are numbered 900000000 plus the annotation's object number.
const SUBSTITUTE_OBJ_BASE = 950000000;
/** The object numbers a face reserves, for its Type0 font, descriptor, widths, program, CIDFont and ToUnicode map in that order. */
const FACE_OBJECTS = 6;

/**
 * The substitute faces synthesized into a document's object cache, by tag.
 * @param {import('./objectCache.js').ObjectCache} objCache
 */
function registryOf(objCache) {
  let reg = registries.get(objCache);
  if (!reg) {
    reg = new Map();
    registries.set(objCache, reg);
  }
  return reg;
}

/**
 * Synthesize a built-in face into the document's object cache as an embedded Type0 font, once per face, and return its entry.
 * @param {import('./objectCache.js').ObjectCache} objCache
 * @param {string} family
 * @param {string} styleKey
 * @param {?{ ascent: number, descent: number }} [metrics] - The ascent and descent the face declares, per 1000 em of the face; the program's own when null.
 * @returns {Promise<SubstituteFaceEntry>}
 */
export async function ensureSubstituteFace(objCache, family, styleKey, metrics = null) {
  const reg = registryOf(objCache);
  const tag = substituteFaceTag(family, styleKey, metrics);
  const have = reg.get(tag);
  if (have) return have;
  const font = await loadSubstituteProgram(family, styleKey);
  const again = reg.get(tag);
  if (again) return again;
  const objNum = SUBSTITUTE_OBJ_BASE + reg.size * FACE_OBJECTS;
  const first = [...reg.values()].find((e) => e.family === family && e.styleKey === styleKey);
  const base = first ? first.base || first : null;
  const parts = type0FontObjectParts({
    font,
    firstObjIndex: objNum,
    italic: styleKey === 'italic' || styleKey === 'boldItalic',
    metrics,
    baseWidthsObjN: base ? base.objNum + 2 : undefined,
    baseFontFileObjN: base ? base.objNum + 3 : undefined,
    baseToUnicodeObjN: base ? base.objNum + 5 : undefined,
  });
  parts.forEach((part, k) => {
    if (!part) return;
    if (!('stream' in part)) {
      objCache.addSyntheticObject(objNum + k, part.text, new Uint8Array(0));
      return;
    }
    let bytes = part.stream;
    if (typeof bytes === 'string') {
      const text = bytes;
      bytes = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    }
    objCache.addSyntheticObject(objNum + k, `<<${part.dictExtras}/Length ${bytes.length}>>`, bytes);
  });
  /** @type {SubstituteFaceEntry} */
  const entry = {
    tag, objNum, font, family, styleKey, metrics, base,
  };
  reg.set(tag, entry);
  return entry;
}

/**
 * The family and style of the substitute face synthesized under an object number, or null for any other font.
 * @param {import('./objectCache.js').ObjectCache} objCache
 * @param {?number} objNum
 * @returns {?{ family: string, styleKey: string }}
 */
export function substituteFaceByObjNum(objCache, objNum) {
  const reg = registries.get(objCache);
  if (!reg || typeof objNum !== 'number') return null;
  for (const entry of reg.values()) if (entry.objNum === objNum) return { family: entry.family, styleKey: entry.styleKey };
  return null;
}

/** @param {{ ascent?: number, descent?: number }} f */
const metricsOf = (f) => (Number.isFinite(f.ascent) && Number.isFinite(f.descent) ? { ascent: /** @type {number} */ (f.ascent), descent: /** @type {number} */ (f.descent) } : null);

/**
 * The resource name a record's face entry is drawn under.
 * @param {{ family: string, styleKey: string, ascent?: number, descent?: number }} f
 */
export const recordFaceTag = (f) => substituteFaceTag(f.family, f.styleKey, metricsOf(f));

/**
 * Synthesize every substitute face the patch records name.
 * @param {import('./objectCache.js').ObjectCache} objCache
 * @param {?Array<ContentEdit>} records
 */
export async function ensureSubstituteFacesForRecords(objCache, records) {
  for (const rec of records || []) {
    if (!rec || rec.type !== 'patchText' || !rec.fonts) continue;
    for (const f of rec.fonts) await ensureSubstituteFace(objCache, f.family, f.styleKey, metricsOf(f));
  }
}

/**
 * The `/Tag N 0 R` font resource entries the page's patch records add, joined into one string.
 * Faces not yet synthesized are silently omitted.
 * @param {import('./objectCache.js').ObjectCache} objCache
 * @param {?Array<ContentEdit>} records
 */
export function substituteFaceResourceEntries(objCache, records) {
  const reg = registries.get(objCache);
  if (!reg) return '';
  const parts = [];
  const seen = new Set();
  for (const rec of records || []) {
    if (!rec || rec.type !== 'patchText' || !rec.fonts) continue;
    for (const f of rec.fonts) {
      const tag = recordFaceTag(f);
      const entry = reg.get(tag);
      if (!entry || seen.has(tag)) continue;
      seen.add(tag);
      parts.push(`/${tag} ${entry.objNum} 0 R`);
    }
  }
  return parts.join(' ');
}

/**
 * The substitute faces a set of records draws with, as output objects of an exported PDF numbered from `firstObjNum`.
 * @param {import('./objectCache.js').ObjectCache} objCache
 * @param {?Array<ContentEdit>} records
 * @param {number} firstObjNum
 * @param {boolean} humanReadable
 * @returns {Promise<{ refs: Map<string, number>, nextObjNum: number,
 *   objects: Array<{ objNum: number, content: string | import('../export/pdf/writePdfStreams.js').PdfBinaryObject }> }>}
 *   `refs` maps each face's resource name to its font object.
 */
export async function substituteFaceOutputObjects(objCache, records, firstObjNum, humanReadable) {
  await ensureSubstituteFacesForRecords(objCache, records);
  const reg = registryOf(objCache);
  /** @type {Map<string, number>} */
  const refs = new Map();
  /** @type {Array<{ objNum: number, content: string | import('../export/pdf/writePdfStreams.js').PdfBinaryObject }>} */
  const objects = [];
  /** @type {Map<string, number>} */
  const baseObjNumByFace = new Map();
  let next = firstObjNum;
  for (const rec of records || []) {
    for (const f of rec?.fonts || []) {
      const tag = recordFaceTag(f);
      const entry = reg.get(tag);
      if (!entry || refs.has(tag)) continue;
      const objN = next;
      next += FACE_OBJECTS;
      refs.set(tag, objN);
      const faceKey = `${entry.family}/${entry.styleKey}`;
      const baseObjN = baseObjNumByFace.get(faceKey);
      if (baseObjN === undefined) baseObjNumByFace.set(faceKey, objN);
      const contents = await createEmbeddedFontType0({
        font: entry.font,
        firstObjIndex: objN,
        italic: entry.styleKey === 'italic' || entry.styleKey === 'boldItalic',
        humanReadable,
        metrics: entry.metrics,
        rawFontBytes: objCache.getStreamBytes((entry.base || entry).objNum + 3) || undefined,
        baseWidthsObjN: baseObjN === undefined ? undefined : baseObjN + 2,
        baseFontFileObjN: baseObjN === undefined ? undefined : baseObjN + 3,
        baseToUnicodeObjN: baseObjN === undefined ? undefined : baseObjN + 5,
      });
      contents.forEach((content, k) => {
        if (content) objects.push({ objNum: objN + k, content });
      });
    }
  }
  return { refs, objects, nextObjNum: next };
}
