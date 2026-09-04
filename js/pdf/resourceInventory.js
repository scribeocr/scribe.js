// Byte inventory of a PDF: every image, embedded font program, Form XObject and page content stream with its on-disk length and the pages that use it.
import { findXrefOffset, parseXref, getPageObjects } from './parsePdfUtils.js';
import { ObjectCache } from './objectCache.js';
import {
  resolveIntValue, resolveNumValue, resolveNameValue, resolveArrayValue, resolveDictValue, parseDictEntries, scopeDictKeys, extractDict, decodePdfName, bytesToLatin1,
} from './pdfPrimitives.js';
import { parseColorSpace, parseFilter } from './parsePdfImages.js';

/**
 * @typedef {Object} InventoryImage
 * @property {number} objNum - The image XObject's object number.
 * @property {number} width
 * @property {number} height
 * @property {number} bitsPerComponent
 * @property {string} colorSpace - The colour space family, labelled as the renderer labels it.
 * An ICC profile reads as the device space of its channel count.
 * @property {?string} filter - The image codec filter (DCTDecode, JPXDecode, CCITTFaxDecode, JBIG2Decode, FlateDecode, ...) or null when stored raw.
 * @property {boolean} imageMask - A 1-bit stencil mask.
 * @property {number} bytes - Encoded stream length on disk, plus any soft-mask or stencil-mask stream the image references.
 * @property {number[]} pages - 0-based indices of the pages whose resources reference the image, directly or through a Form XObject.
 */

/**
 * @typedef {Object} InventoryFont
 * @property {string} name - BaseFont as written, subset prefix included.
 * @property {string} baseName - BaseFont without the six-letter subset prefix.
 * @property {string} subtype - Type1, TrueType, Type0, Type3 or MMType1.
 * @property {?string} cidSubtype - CIDFontType0 or CIDFontType2 for a Type0 font.
 * @property {boolean} embedded - A program (or, for Type3, glyph procedures) is in the file.
 * @property {boolean} subset
 * @property {number} bytes - On-disk length of the embedded program stream, or of the CharProcs streams for Type3.
 * 0 when not embedded.
 * @property {?number} programObjNum - The FontFile stream's object number.
 * @property {number[]} fontObjNums - Every font dictionary drawing with this program, or with this name when not embedded.
 * A font written inline in a resource dictionary has none.
 * @property {?string} encoding - WinAnsiEncoding, MacRomanEncoding, StandardEncoding, Identity-H, a CMap name, "Custom (Differences)", "Built-in" or "Embedded CMap".
 * @property {boolean} toUnicode - A ToUnicode CMap is present.
 * @property {?number} flags - FontDescriptor /Flags.
 * @property {?number} italicAngle - FontDescriptor /ItalicAngle.
 * @property {number[]} pages - 0-based indices of the pages that use the font, directly or through a Form XObject.
 */

/**
 * @typedef {Object} ResourceInventory
 * @property {number} fileBytes
 * @property {?string} version - The header version ("1.7"), or null when the header is missing.
 * @property {number} pageCount
 * @property {{images: number, fonts: number, drawings: number, content: number, other: number}} bytesByKind - Sums to `fileBytes`.
 * `other` is the remainder: dictionaries, object streams, cross-reference data, metadata, ICC profiles, CMaps.
 * @property {{images: number, fonts: number, drawings: number, content: number}} countByKind - Images and embedded fonts by object, Form XObjects used on pages, content streams.
 * @property {InventoryImage[]} images - Largest first.
 * @property {InventoryFont[]} fonts - Largest program first; fonts without a program last, by name.
 * @property {Array<{images: number[], fonts: number[], contentBytes: number}>} perPage - Per 0-based page: indices into `images` and `fonts`, and the page's content stream bytes.
 * @property {?{print: boolean, modify: boolean, copy: boolean, annotate: boolean}} permissions - From the encryption dictionary's /P; null for an unencrypted file.
 */

const SUBSET_PREFIX = /^[A-Z]{6}\+/;
const FONT_DICT = /\/Type\s*\/Font\b|\/Subtype\s*\/(Type1|TrueType|Type0|Type3|MMType1)\b/;
const IMAGE_DICT = /\/Subtype\s*\/Image\b/;
const FORM_DICT = /\/Subtype\s*\/Form\b/;
const REF_VALUE = /^(\d+)\s+\d+\s+R$/;

/**
 * Build the inventory for one PDF.
 * Reads dictionaries and stream lengths only, never decoding a stream.
 * @param {Uint8Array} pdfBytes
 * @returns {ResourceInventory}
 */
export function buildResourceInventory(pdfBytes) {
  const xrefEntries = parseXref(pdfBytes, findXrefOffset(pdfBytes));
  const objCache = new ObjectCache(pdfBytes, xrefEntries);
  const text = (n) => objCache.getObjectText(n) || '';
  const versionMatch = /%PDF-(\d\.\d)/.exec(bytesToLatin1(pdfBytes, 0, Math.min(pdfBytes.length, 1024)));
  const pages = getPageObjects(objCache);

  /** @type {Map<number, InventoryImage>} */
  const images = new Map();
  /** @type {Map<string, InventoryFont>} */
  const fonts = new Map();
  /** @type {Map<number, number>} Form XObject object number -> stream bytes. */
  const forms = new Map();
  /** @type {Map<number, ?{kind: 'image'|'form'}>} XObjects classified once, by object number. Null for any other kind. */
  const xobjects = new Map();
  /** @type {Map<number, ?string>} Font dictionaries recorded once, by object number, to their inventory key. */
  const fontKeyByObj = new Map();
  /** @type {Map<number, {images: Set<number>, fonts: Set<string>}>} What an owner's resources reach, walked once per Form XObject or Type3 font. */
  const ownerReach = new Map();
  /** @type {Set<number>} */
  const contentObjs = new Set();
  /** @type {Array<{images: Set<number>, fonts: Set<string>, contentBytes: number}>} */
  const perPageSets = [];
  let contentBytes = 0;

  /**
   * Record one font dictionary.
   * Fonts are keyed by program, or by name when there is none, so a program shared by several dictionaries counts once.
   * @param {string} ft - The dictionary's text.
   * @param {?number} fontObjNum - Null for a dictionary written inline in its resource dictionary.
   * @param {(ownerText: string) => {images: Set<number>, fonts: Set<string>}} walk - Walks a Type3 font's own resources.
   * @param {{images: Set<number>, fonts: Set<string>}} reach - The current owner's reach, which a Type3 font's resources join.
   * @returns {?string} The inventory key, or null for an object that is not a font dictionary.
   */
  const recordFont = (ft, fontObjNum, walk, reach) => {
    if (!ft || !FONT_DICT.test(ft)) return null;
    // Scoped reads: an inline /Encoding dictionary holds names of its own, which a first-match read of the font's keys would return instead.
    const sf = scopeDictKeys(ft);
    const subtype = resolveNameValue(sf.keyText('Subtype'), 'Subtype', objCache) || '';
    const name = decodePdfName(resolveNameValue(sf.keyText('BaseFont'), 'BaseFont', objCache) || resolveNameValue(sf.keyText('Name'), 'Name', objCache) || '');
    let descOwner = sf;
    let cidSubtype = null;
    if (subtype === 'Type0') {
      // The one descendant is a reference, or a dictionary written inline in the array.
      const arr = (resolveArrayValue(sf.keyText('DescendantFonts'), 'DescendantFonts', objCache) || '').trim();
      const ref = REF_VALUE.exec(arr.split(']')[0].trim()) || /^(\d+)\s+\d+\s+R/.exec(arr);
      const descText = arr.startsWith('<<') ? extractDict(arr, 0) : ref ? text(Number(ref[1])) : '';
      if (descText) { descOwner = scopeDictKeys(descText); cidSubtype = resolveNameValue(descOwner.keyText('Subtype'), 'Subtype', objCache); }
    }
    const dt = resolveDictValue(descOwner.keyText('FontDescriptor'), 'FontDescriptor', objCache) || '';
    const program = /\/FontFile[23]?\s+(\d+)\s+\d+\s+R/.exec(dt);
    const programObjNum = subtype === 'Type3' || !program ? null : Number(program[1]);
    const key = programObjNum != null ? `p${programObjNum}` : subtype === 'Type3' ? `t3-${fontObjNum ?? name}` : `n-${name}`;
    const existing = fonts.get(key);
    if (existing) {
      if (fontObjNum != null) existing.fontObjNums.push(fontObjNum);
      return key;
    }

    let bytes = programObjNum != null ? resolveIntValue(text(programObjNum), 'Length', objCache) : 0;
    if (subtype === 'Type3') {
      // Glyph procedures are the program: sum the CharProcs streams once.
      const seen = new Set();
      for (const { valueText } of parseDictEntries((resolveDictValue(sf.keyText('CharProcs'), 'CharProcs', objCache) || '<<>>').slice(2, -2))) {
        const ref = REF_VALUE.exec(valueText.trim());
        if (ref && !seen.has(Number(ref[1]))) { seen.add(Number(ref[1])); bytes += resolveIntValue(text(Number(ref[1])), 'Length', objCache); }
      }
      // Glyph procedures can draw with fonts and images of their own.
      const inner = walk(ft);
      for (const i of inner.images) reach.images.add(i);
      for (const f of inner.fonts) reach.fonts.add(f);
    }
    // Encoding: a name, or a dictionary with /Differences (custom) or /BaseEncoding; absent means the program's built-in encoding.
    let encoding = null;
    const encText = sf.keyText('Encoding');
    const encDict = resolveDictValue(encText, 'Encoding', objCache);
    const encName = encDict ? null : resolveNameValue(encText, 'Encoding', objCache);
    if (subtype === 'Type0') encoding = encName || (encDict ? 'Embedded CMap' : null);
    else if (encName) encoding = encName;
    else if (!encDict) encoding = 'Built-in';
    else if (/\/Differences\b/.test(encDict)) encoding = 'Custom (Differences)';
    else encoding = resolveNameValue(encDict, 'BaseEncoding', objCache) || 'Built-in';
    const flags = resolveIntValue(dt, 'Flags', objCache, Number.NaN);
    const italicAngle = resolveNumValue(dt, 'ItalicAngle', objCache, Number.NaN);
    fonts.set(key, {
      name,
      baseName: name.replace(SUBSET_PREFIX, ''),
      subtype,
      cidSubtype,
      embedded: subtype === 'Type3' || programObjNum != null,
      subset: SUBSET_PREFIX.test(name),
      bytes,
      programObjNum,
      fontObjNums: fontObjNum != null ? [fontObjNum] : [],
      encoding,
      toUnicode: sf.has('ToUnicode'),
      flags: Number.isNaN(flags) ? null : flags,
      italicAngle: Number.isNaN(italicAngle) ? null : italicAngle,
      pages: [],
    });
    return key;
  };

  /**
   * The images and fonts a resource owner (a page, a Form XObject or a Type3 font) reaches, through nested owners.
   * @param {string} ownerText
   * @param {number} depth
   * @returns {{images: Set<number>, fonts: Set<string>}}
   */
  const walkResources = (ownerText, depth) => {
    const reach = { images: new Set(), fonts: new Set() };
    if (depth > 5) return reach;
    const resText = resolveDictValue(ownerText, 'Resources', objCache) || '';
    /** A nested owner's reach, walked once. */
    const reachOf = (n, ownerTextOf) => {
      let inner = ownerReach.get(n);
      if (inner === undefined) {
        // Seeded before the walk, so an owner whose resources reach itself terminates.
        ownerReach.set(n, reach);
        inner = walkResources(ownerTextOf, depth + 1);
        ownerReach.set(n, inner);
      }
      return inner;
    };
    const xdict = resolveDictValue(resText, 'XObject', objCache);
    for (const { valueText } of xdict ? parseDictEntries(xdict.slice(2, -2)) : []) {
      const ref = REF_VALUE.exec(valueText.trim());
      if (!ref) continue;
      const n = Number(ref[1]);
      let x = xobjects.get(n);
      if (x === undefined) {
        const t = text(n);
        if (IMAGE_DICT.test(t)) {
          // Scoped reads: an image's /DecodeParms dictionary carries a /BitsPerComponent of its own.
          const si = scopeDictKeys(t);
          let bytes = resolveIntValue(si.keyText('Length'), 'Length', objCache);
          for (const maskKey of ['SMask', 'Mask']) {
            const mask = resolveDictValue(si.keyText(maskKey), maskKey, objCache);
            if (mask && IMAGE_DICT.test(mask)) bytes += resolveIntValue(mask, 'Length', objCache);
          }
          const imageMask = /\/ImageMask\s+true/.test(t);
          images.set(n, {
            objNum: n,
            width: resolveIntValue(si.keyText('Width'), 'Width', objCache),
            height: resolveIntValue(si.keyText('Height'), 'Height', objCache),
            bitsPerComponent: resolveIntValue(si.keyText('BitsPerComponent'), 'BitsPerComponent', objCache, 8),
            colorSpace: imageMask ? 'DeviceGray' : parseColorSpace(t, objCache),
            filter: parseFilter(t, objCache),
            imageMask,
            bytes,
            pages: [],
          });
          x = { kind: 'image' };
        } else if (FORM_DICT.test(t)) {
          forms.set(n, resolveIntValue(t, 'Length', objCache));
          x = { kind: 'form' };
        } else x = null;
        xobjects.set(n, x);
      }
      if (!x) continue;
      if (x.kind === 'image') { reach.images.add(n); continue; }
      const inner = reachOf(n, text(n));
      for (const i of inner.images) reach.images.add(i);
      for (const f of inner.fonts) reach.fonts.add(f);
    }
    const fdict = resolveDictValue(resText, 'Font', objCache);
    for (const { valueText } of fdict ? parseDictEntries(fdict.slice(2, -2)) : []) {
      const value = valueText.trim();
      const ref = REF_VALUE.exec(value);
      let key;
      if (ref) {
        const n = Number(ref[1]);
        key = fontKeyByObj.get(n);
        if (key === undefined) {
          key = recordFont(text(n), n, (ft) => reachOf(n, ft), reach);
          fontKeyByObj.set(n, key);
        }
      } else if (value.startsWith('<<')) {
        key = recordFont(value, null, (ft) => walkResources(ft, depth + 1), reach);
      }
      if (key) reach.fonts.add(key);
    }
    return reach;
  };

  pages.forEach((page, i) => {
    const reach = walkResources(page.objText, 0);
    for (const n of reach.images) { const p = images.get(n).pages; if (p[p.length - 1] !== i) p.push(i); }
    for (const key of reach.fonts) { const p = fonts.get(key).pages; if (p[p.length - 1] !== i) p.push(i); }
    // /Contents is one stream, or an array of them (written inline or as its own object).
    const contentsArr = resolveArrayValue(page.objText, 'Contents', objCache);
    const contentsOne = contentsArr == null ? /\/Contents\s+(\d+)\s+\d+\s+R/.exec(page.objText) : null;
    const refs = contentsArr != null ? [...contentsArr.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1])) : contentsOne ? [Number(contentsOne[1])] : [];
    let pageContent = 0;
    for (const n of refs) { if (contentObjs.has(n)) continue; contentObjs.add(n); pageContent += resolveIntValue(text(n), 'Length', objCache); }
    contentBytes += pageContent;
    perPageSets.push({ images: reach.images, fonts: reach.fonts, contentBytes: pageContent });
  });

  const imageList = [...images.values()].sort((a, b) => b.bytes - a.bytes || a.objNum - b.objNum);
  const fontList = [...fonts.values()].sort((a, b) => Number(b.embedded) - Number(a.embedded) || b.bytes - a.bytes || a.name.localeCompare(b.name));
  const imageIndex = new Map();
  imageList.forEach((im, idx) => imageIndex.set(im.objNum, idx));
  const fontIndex = new Map();
  fontList.forEach((f, idx) => fontIndex.set(f, idx));
  let imageBytes = 0;
  for (const im of imageList) imageBytes += im.bytes;
  let fontBytes = 0;
  let embeddedFonts = 0;
  for (const f of fontList) { fontBytes += f.bytes; if (f.embedded) embeddedFonts++; }
  let drawingBytes = 0;
  for (const n of forms.values()) drawingBytes += n;

  // Permissions: the encryption dictionary's /P bit field (bit 3 print, 4 modify, 5 copy, 6 annotate).
  // The cache records the dictionary even when it cannot set decryption up, so /P is readable for a file this build cannot decrypt.
  let permissions = null;
  if (objCache.encryptObjNum) {
    const p = resolveIntValue(text(objCache.encryptObjNum), 'P', objCache, Number.NaN);
    if (!Number.isNaN(p)) {
      permissions = {
        print: !!(p & 4), modify: !!(p & 8), copy: !!(p & 16), annotate: !!(p & 32),
      };
    }
  }

  const other = Math.max(0, pdfBytes.length - imageBytes - fontBytes - drawingBytes - contentBytes);
  return {
    fileBytes: pdfBytes.length,
    version: versionMatch ? versionMatch[1] : null,
    pageCount: pages.length,
    bytesByKind: {
      images: imageBytes, fonts: fontBytes, drawings: drawingBytes, content: contentBytes, other,
    },
    countByKind: {
      images: imageList.length, fonts: embeddedFonts, drawings: forms.size, content: contentObjs.size,
    },
    images: imageList,
    fonts: fontList,
    perPage: perPageSets.map((p) => ({
      images: [...p.images].map((n) => imageIndex.get(n)).sort((a, b) => a - b),
      fonts: [...p.fonts].map((k) => fontIndex.get(fonts.get(k))).sort((a, b) => a - b),
      contentBytes: p.contentBytes,
    })),
    permissions,
  };
}

/** @type {WeakMap<ArrayBuffer|Uint8Array, ResourceInventory>} One inventory per source buffer, whose bytes never change after import. */
const inventoryCache = new WeakMap();

/**
 * The inventory of the document's primary PDF source, built once per source and cached.
 * Null for a document without a PDF source.
 * @param {import('../containers/scribeDoc.js').ScribeDoc} doc
 * @returns {?ResourceInventory}
 */
export function getResourceInventoryImpl(doc) {
  const pdfData = doc?.images?.pdfData;
  if (!pdfData) return null;
  let inv = inventoryCache.get(pdfData);
  if (!inv) {
    inv = buildResourceInventory(pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData));
    inventoryCache.set(pdfData, inv);
  }
  return inv;
}
