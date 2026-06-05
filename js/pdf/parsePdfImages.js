import {
  extractDict, ObjectCache, findXrefOffset, parseXref,
  resolveArrayValue, findTopLevelKeyIndex,
} from './parsePdfUtils.js';
import {
  parseTintColorSpace, buildTintLookupTable, tintComponentsToRGB,
} from './pdfColorFunctions.js';
import { parsePdfLiteralString } from './pdfCrypto.js';

/**
 * @typedef {{
 *   width: number,
 *   height: number,
 *   bitsPerComponent: number,
 *   colorSpace: string,
 *   filter: string|null,
 *   imageData: Uint8Array|null,
 *   objNum: number,
 *   sMask: Uint8Array|null,
 *   sMaskWidth: number|null,
 *   sMaskHeight: number|null,
 *   sMaskDecodeInvert: boolean,
 *   palette: Uint8Array|null,
 *   paletteBase: string|null,
 *   imageMask: boolean,
 *   decodeInvert: boolean,
 *   separationTintSamples: Uint8Array|null,
 *   deviceNTintCS: {tintFn: any, altCS: any, nInputs: number}|null,
 *   iccProfileObjNum: number|null,
 *   iccTransform: {gamma: number[], matrix: number[]}|null,
 *   labWhitePoint: number[]|null,
 *   labRange: number[]|null,
 *   paletteHival: number|null,
 *   colorKeyMask: number[]|null,
 *   transparentWhite?: boolean,
 * }} ImageInfo
 */

/**
 * @typedef {{
 *   tag: string,
 *   objNum: number,
 *   bbox?: number[],
 *   transparencyGroup?: { isolated: boolean, knockout: boolean },
 * }} FormXObjectInfo
 */

/**
 * Parse a Form XObject's optional transparency group dictionary.
 * @param {string} formObjText
 * @param {ObjectCache} objCache
 */
function parseTransparencyGroup(formObjText, objCache) {
  let groupText = null;
  const groupRefMatch = /\/Group\s+(\d+)\s+\d+\s+R/.exec(formObjText);
  if (groupRefMatch) {
    groupText = objCache.getObjectText(Number(groupRefMatch[1])) || null;
  } else {
    const groupIdx = formObjText.indexOf('/Group');
    if (groupIdx !== -1) {
      const afterGroup = formObjText.substring(groupIdx + 6);
      const dictStartRel = afterGroup.indexOf('<<');
      if (dictStartRel !== -1) {
        groupText = extractDict(formObjText, groupIdx + 6 + dictStartRel);
      }
    }
  }
  if (!groupText || !/\/S\s*\/Transparency\b/.test(groupText)) return null;
  return {
    isolated: /\/I\s*true\b/.test(groupText),
    knockout: /\/K\s*true\b/.test(groupText),
  };
}

/**
 * Parse image and Form XObjects from a page's Resources dictionary.
 *
 * @param {string} pageObjText  – the raw text of the Page object
 * @param {ObjectCache} objCache
 */
export function parsePageImages(pageObjText, objCache, options = {}) {
  /** @type {Map<string, ImageInfo>} */
  const images = new Map();
  /** @type {Map<string, FormXObjectInfo>} */
  const forms = new Map();
  const recurseForms = options.recurseForms !== false;
  const maxDepth = Number.isFinite(options.maxDepth) ? Number(options.maxDepth) : 5;

  extractXObjectsFromResources(pageObjText, objCache, '', images, forms, 0, new Set(), { recurseForms, maxDepth });

  return { images, forms };
}

/**
 * Extract image and Form XObjects from a Resources dictionary.
 * Recurses into Form XObjects up to a depth limit.
 *
 * @param {string} objText – object text containing /Resources
 * @param {ObjectCache} objCache
 * @param {string} prefix – key prefix for nested images (e.g., 'Xi637/')
 * @param {Map<string, ImageInfo>} images
 * @param {Map<string, FormXObjectInfo>} forms
 * @param {number} depth
 * @param {Set<number>} visitedFormObjNums
 * @param {{ recurseForms: boolean, maxDepth: number }} options
 */
function extractXObjectsFromResources(objText, objCache, prefix, images, forms, depth, visitedFormObjNums, options) {
  if (depth > options.maxDepth) return;

  // Resolve Resources (may be inline or an indirect reference)
  let resourcesText = objText;
  const resRefMatch = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(objText);
  if (resRefMatch) {
    const resObj = objCache.getObjectText(Number(resRefMatch[1]));
    if (resObj) resourcesText = resObj;
  } else {
    // Inline Resources dict — extract it to avoid matching '/XObject' from
    // '/Type /XObject' in the parent object (e.g. Form XObjects).
    const resInlineIdx = objText.indexOf('/Resources');
    if (resInlineIdx !== -1) {
      const afterRes = objText.substring(resInlineIdx + 10).trim();
      if (afterRes.startsWith('<<')) {
        const resDictText = extractDict(objText, resInlineIdx + 10 + objText.substring(resInlineIdx + 10).indexOf('<<'));
        if (resDictText) resourcesText = resDictText;
      }
    }
  }

  // Find XObject dictionary within Resources
  const xobjStart = resourcesText.indexOf('/XObject');
  if (xobjStart === -1) return;

  let xobjDictText;
  const afterXObj = resourcesText.substring(xobjStart + 8).trim();
  if (afterXObj.startsWith('<<')) {
    xobjDictText = extractDict(
      resourcesText,
      xobjStart + 8 + resourcesText.substring(xobjStart + 8).indexOf('<<'),
    );
  } else {
    const xobjRefMatch = /^(\d+)\s+\d+\s+R/.exec(afterXObj);
    if (xobjRefMatch) {
      const xObj = objCache.getObjectText(Number(xobjRefMatch[1]));
      if (xObj) xobjDictText = xObj;
    }
  }
  if (!xobjDictText) return;

  // Iterate each entry: /Im1 N 0 R  (or /X1 N 0 R, etc.)
  const entryRegex = /\/([^\s/]*)\s+(\d+)\s+\d+\s+R/g;
  const entries = [...xobjDictText.matchAll(entryRegex)];

  for (const entry of entries) {
    const tag = entry[1];
    const objNum = Number(entry[2]);
    const entryObjText = objCache.getObjectText(objNum);
    if (!entryObjText) continue;

    if (/\/Subtype\s*\/Image/.test(entryObjText)) {
      const info = parseImageObject(entryObjText, objNum, objCache);
      if (info) images.set(prefix + tag, info);
    } else if (/\/Subtype\s*\/Form/.test(entryObjText)) {
      /** @type {FormXObjectInfo} */
      const formEntry = { tag, objNum };
      const bboxStr = resolveArrayValue(entryObjText, 'BBox', objCache);
      if (bboxStr) {
        formEntry.bbox = bboxStr.split(/\s+/).map(Number);
      }
      const transparencyGroup = parseTransparencyGroup(entryObjText, objCache);
      if (transparencyGroup) formEntry.transparencyGroup = transparencyGroup;
      forms.set(prefix + tag, formEntry);
      // Recurse into the Form's Resources to discover nested images,
      // but skip Form XObjects already visited to avoid exponential expansion
      if (options.recurseForms && !visitedFormObjNums.has(objNum)) {
        visitedFormObjNums.add(objNum);
        extractXObjectsFromResources(
          entryObjText,
          objCache,
          `${prefix}${tag}/`,
          images,
          forms,
          depth + 1,
          visitedFormObjNums,
          options,
        );
      }
    }
  }
}

/**
 * Extract every image XObject from a PDF.
 *
 * @param {Uint8Array} pdfBytes
 */
export function extractImages(pdfBytes) {
  const xrefOffset = findXrefOffset(pdfBytes);
  const xrefEntries = parseXref(pdfBytes, xrefOffset);
  const objCache = new ObjectCache(pdfBytes, xrefEntries);

  /** @type {{ [objNum: number]: ImageInfo }} */
  const result = {};

  for (const objNum of Object.keys(xrefEntries)) {
    const num = Number(objNum);
    const objText = objCache.getObjectText(num);
    if (!objText) continue;

    // Quick pre-filter before the real regex
    if (!objText.includes('/Subtype') || !objText.includes('/Image')) continue;
    if (!/\/Subtype\s*\/Image/.test(objText)) continue;

    const info = parseImageObject(objText, num, objCache);
    if (info) result[num] = info;
  }

  return result;
}

/**
 * Read an integer value from the top level of an image dict, resolving a direct integer or an `N M R` indirect reference.
 * @param {string} objText - The image object text (the first << >> is taken as the dict).
 * @param {string} key - PDF name with leading slash, e.g. '/BitsPerComponent'.
 * @param {number} dflt - Returned when the key is absent at the top level.
 * @param {ObjectCache} objCache
 * @returns {number}
 */
function readTopLevelInt(objText, key, dflt, objCache) {
  const dictStart = objText.indexOf('<<');
  const dictBody = dictStart >= 0 ? extractDict(objText, dictStart).slice(2, -2) : objText;
  const idx = findTopLevelKeyIndex(dictBody, key);
  if (idx < 0) return dflt;
  const after = dictBody.slice(idx + key.length);
  const refMatch = /^\s+(\d+)\s+\d+\s+R/.exec(after);
  if (refMatch) {
    const refObjText = objCache.getObjectText(Number(refMatch[1]));
    const val = refObjText && /(\d+)/.exec(refObjText);
    return val ? Number(val[1]) : dflt;
  }
  const direct = /^\s+(\d+)/.exec(after);
  return direct ? Number(direct[1]) : dflt;
}

/**
 * Parse a single image XObject and return its metadata + raw bytes.
 *
 * @param {string} objText     – text of the image object dictionary
 * @param {number} objNum      – object number (for stream extraction)
 * @param {ObjectCache} objCache
 * @returns {ImageInfo|null}
 */
export function parseImageObject(objText, objNum, objCache) {
  const width = readTopLevelInt(objText, '/Width', 0, objCache);
  const height = readTopLevelInt(objText, '/Height', 0, objCache);
  if (width === 0 || height === 0) return null;

  const bitsPerComponent = readTopLevelInt(objText, '/BitsPerComponent', 8, objCache);

  const imageMask = /\/ImageMask\s+true/.test(objText);
  const colorSpace = imageMask ? 'DeviceGray' : parseColorSpace(objText, objCache);
  const iccProfileObjNum = imageMask ? null : findICCProfileObjNum(objText, objCache);
  const iccTransform = iccProfileObjNum ? parseICCProfile(iccProfileObjNum, objCache) : null;
  let filter = parseFilter(objText);
  // Handle indirect filter reference: /Filter N 0 R
  if (!filter) {
    const indirectFilterMatch = /\/Filter\s+(\d+)\s+\d+\s+R/.exec(objText);
    if (indirectFilterMatch) {
      const filterObjText = objCache.getObjectText(Number(indirectFilterMatch[1]));
      if (filterObjText) {
        // getObjectText returns the bare /Filter value (a name or array) with no /Filter key.
        // Re-prefix one so parseFilter picks the image codec (DCTDecode/JPXDecode) from a chain,
        // not its leading transport filter.
        filter = parseFilter(`/Filter ${filterObjText}`);
      }
    }
  }

  // Check for inverted /Decode array: /Decode [1 0] means invert sample values
  const imgDecodeMatch = /\/Decode\s*\[\s*([\d.]+)\s+([\d.]+)/.exec(objText);
  const decodeInvert = imgDecodeMatch ? (Number(imgDecodeMatch[1]) > Number(imgDecodeMatch[2])) : false;

  // Image stream bytes are loaded lazily at render time.
  const imageData = null;

  // Handle Indexed color space: extract palette data
  let palette = null;
  let paletteBase = null;
  let paletteHival = null;
  if (colorSpace === 'Indexed') {
    let csText = objText;
    let csObjNum = null;
    const csRefMatch = /\/ColorSpace\s+(\d+)\s+\d+\s+R/.exec(objText);
    if (csRefMatch) {
      csObjNum = Number(csRefMatch[1]);
      const csObj = objCache.getObjectText(csObjNum);
      if (csObj) csText = csObj;
    }
    const idxResult = parseIndexedColorSpace(csText, objCache, csObjNum || objNum);
    if (idxResult) {
      palette = idxResult.palette;
      paletteBase = idxResult.base;
      paletteHival = idxResult.hival;
    }
  }

  let separationTintSamples = null;
  if (colorSpace === 'Separation') {
    let csText = objText;
    const csRefMatch2 = /\/ColorSpace\s+(\d+)\s+\d+\s+R/.exec(objText);
    if (csRefMatch2) {
      const csObj = objCache.getObjectText(Number(csRefMatch2[1]));
      if (csObj) csText = csObj;
    }
    const parsedTintCS = parseTintColorSpace(csText, objCache);
    if (parsedTintCS.tintFn && parsedTintCS.nInputs === 1) {
      separationTintSamples = buildTintLookupTable(parsedTintCS);
    }
  }

  let deviceNTintCS = null;
  if (colorSpace === 'DeviceN') {
    let csText = objText;
    const csRefMatchDN = /\/ColorSpace\s+(\d+)\s+\d+\s+R/.exec(objText);
    if (csRefMatchDN) {
      const csObj = objCache.getObjectText(Number(csRefMatchDN[1]));
      if (csObj) csText = csObj;
    }
    const parsedTintCS = parseTintColorSpace(csText, objCache);
    // The tint transform is applied lazily, when the renderer decodes a drawn image (imageInfoToBitmap),
    // so an unused DeviceN image in a shared Resources dict costs nothing here.
    if (parsedTintCS.tintFn && parsedTintCS.nInputs >= 1) deviceNTintCS = parsedTintCS;
  }

  let labWhitePoint = null;
  let labRange = null;
  if (colorSpace === 'Lab') {
    let csText = objText;
    const csRefMatch3 = /\/ColorSpace\s+(\d+)\s+\d+\s+R/.exec(objText);
    if (csRefMatch3) {
      const csObj = objCache.getObjectText(Number(csRefMatch3[1]));
      if (csObj) csText = csObj;
    }
    const wpStr = resolveArrayValue(csText, 'WhitePoint', objCache);
    if (wpStr) {
      labWhitePoint = wpStr.split(/\s+/).map(Number);
    }
    const rangeStr = resolveArrayValue(csText, 'Range', objCache);
    if (rangeStr) {
      const rangeNums = rangeStr.split(/\s+/).map(Number);
      if (rangeNums.length >= 4) labRange = [rangeNums[0], rangeNums[1], rangeNums[2], rangeNums[3]];
    }
  }

  let sMask = null;
  let sMaskWidth = null;
  let sMaskHeight = null;
  let sMaskDecodeInvert = false;
  let colorKeyMask = null;

  const colorKeyMatch = /\/Mask\s*\[([\d\s]+)\]/.exec(objText);
  if (colorKeyMatch) {
    colorKeyMask = colorKeyMatch[1].trim().split(/\s+/).map(Number);
  }

  const sMaskRefMatch = /\/SMask\s+(\d+)\s+\d+\s+R/.exec(objText);
  const explicitMaskRefMatch = !sMaskRefMatch && !colorKeyMatch ? /\/Mask\s+(\d+)\s+\d+\s+R/.exec(objText) : null;
  const maskRefMatch = sMaskRefMatch || explicitMaskRefMatch;
  if (maskRefMatch) {
    const sMaskObjNum = Number(maskRefMatch[1]);
    const sMaskObjText = objCache.getObjectText(sMaskObjNum);
    if (sMaskObjText) {
      // An SMask is itself an image dict that can carry a /DecodeParms, so read its dimensions
      // from the top level too (same reason as the main image above).
      sMaskWidth = readTopLevelInt(sMaskObjText, '/Width', 0, objCache);
      sMaskHeight = readTopLevelInt(sMaskObjText, '/Height', 0, objCache);
      sMask = objCache.getStreamBytes(sMaskObjNum);
      if (sMask && sMaskWidth && sMaskHeight) {
        const isImageMask = /\/ImageMask\s+true/.test(sMaskObjText);
        const smBpc = readTopLevelInt(sMaskObjText, '/BitsPerComponent', isImageMask ? 1 : 8, objCache);
        if (smBpc === 1) {
          const unpacked = new Uint8Array(sMaskWidth * sMaskHeight);
          const rowBytes = Math.ceil(sMaskWidth / 8);
          for (let y = 0; y < sMaskHeight; y++) {
            for (let x = 0; x < sMaskWidth; x++) {
              const byteIdx = y * rowBytes + Math.floor(x / 8);
              const bitIdx = 7 - (x % 8);
              unpacked[y * sMaskWidth + x] = (Math.floor(sMask[byteIdx] / (2 ** bitIdx)) % 2) * 255;
            }
          }
          sMask = unpacked;
        }
        // For explicit /Mask with ImageMask: default Decode [0 1] means
        // sample 0 = paint (opaque), sample 1 = don't paint (transparent).
        // The unpacking above produces 0→0, 1→255, so we must invert.
        // A /Decode [1 0] on the mask would cancel this inversion.
        const isExplicitMask = !!explicitMaskRefMatch;
        const decodeMatch = /\/Decode\s*\[\s*([\d.]+)\s+([\d.]+)\s*\]/.exec(sMaskObjText);
        const decodeInverted = !!decodeMatch && parseFloat(decodeMatch[1]) > parseFloat(decodeMatch[2]);
        // Invert if: explicit stencil mask with default Decode, OR soft mask with /Decode [1 0]
        const shouldInvert = (isExplicitMask && isImageMask && !decodeInverted) || (!isExplicitMask && decodeInverted);
        // A DCTDecode/JPXDecode mask is still a compressed codestream here.
        // Inverting these bytes would corrupt it, so defer the inversion until imageInfoToBitmap decodes it.
        const sMaskFilter = parseFilter(sMaskObjText);
        if (shouldInvert && (sMaskFilter === 'DCTDecode' || sMaskFilter === 'JPXDecode')) {
          sMaskDecodeInvert = true;
        } else if (shouldInvert) {
          for (let j = 0; j < sMask.length; j++) {
            sMask[j] = 255 - sMask[j];
          }
        }
      }
    }
  }

  return {
    width,
    height,
    bitsPerComponent,
    colorSpace,
    filter,
    imageData,
    sMask,
    sMaskWidth,
    sMaskHeight,
    sMaskDecodeInvert,
    palette,
    paletteBase,
    paletteHival,
    imageMask,
    decodeInvert,
    separationTintSamples,
    deviceNTintCS,
    iccProfileObjNum,
    iccTransform,
    labWhitePoint,
    labRange,
    colorKeyMask,
    objNum,
  };
}

/**
 * Read the /ColorSpace value from an image object.
 * @param {string} objText
 * @param {ObjectCache} [objCache]
 */
function parseColorSpace(objText, objCache) {
  const nameMatch = /\/ColorSpace\s*\/(\w+)/.exec(objText);
  if (nameMatch) return nameMatch[1];

  const arrayMatch = /\/ColorSpace\s*\[\s*\/(\w+)/.exec(objText);
  if (arrayMatch) {
    if (arrayMatch[1] === 'DeviceN') {
      return classifyDeviceN(objText);
    }

    if (arrayMatch[1] === 'ICCBased' && objCache) {
      return resolveICCBased(objText, objCache);
    }
    return arrayMatch[1];
  }

  if (objCache) {
    const refMatch = /\/ColorSpace\s+(\d+)\s+\d+\s+R/.exec(objText);
    if (refMatch) {
      const csObjText = objCache.getObjectText(Number(refMatch[1]));
      if (csObjText) {
        const csArrayMatch = /\/(\w+)/.exec(csObjText);
        if (csArrayMatch) {
          if (csArrayMatch[1] === 'DeviceN') {
            return classifyDeviceN(csObjText);
          }
          if (csArrayMatch[1] === 'ICCBased') {
            return resolveICCBased(csObjText, objCache);
          }
          return csArrayMatch[1];
        }
      }
    }
  }

  return 'DeviceRGB';
}

/**
 * Parse an ICC profile stream to extract the color transform parameters.
 * Returns gamma values (per channel) and a 3x3 matrix that converts from
 * the profile's RGB to CIE XYZ (D50). Returns null if the profile can't be parsed.
 * @param {number} profileObjNum
 * @param {ObjectCache} objCache
 */
function parseICCProfile(profileObjNum, objCache) {
  const cache = objCache.iccProfileCache;
  if (cache.has(profileObjNum)) return cache.get(profileObjNum) || null;
  const streamBytes = objCache.getStreamBytes(profileObjNum);
  if (!streamBytes || streamBytes.length < 132) { cache.set(profileObjNum, null); return null; }
  const d = streamBytes;

  // Validate ICC signature at offset 36
  if (d[36] !== 0x61 || d[37] !== 0x63 || d[38] !== 0x73 || d[39] !== 0x70) { cache.set(profileObjNum, null); return null; } // 'acsp'

  // Read color space at offset 16 — only handle RGB profiles
  const csBytes = String.fromCharCode(d[16], d[17], d[18], d[19]);
  if (csBytes.trim() !== 'RGB') { cache.set(profileObjNum, null); return null; }

  const tagCount = (d[128] << 24) | (d[129] << 16) | (d[130] << 8) | d[131];
  if (tagCount < 1 || tagCount > 100) { cache.set(profileObjNum, null); return null; }

  // Build tag index
  const tags = {};
  for (let i = 0; i < tagCount; i++) {
    const off = 132 + i * 12;
    if (off + 12 > d.length) break;
    const sig = String.fromCharCode(d[off], d[off + 1], d[off + 2], d[off + 3]);
    const tagOff = (d[off + 4] << 24) | (d[off + 5] << 16) | (d[off + 6] << 8) | d[off + 7];
    const tagSize = (d[off + 8] << 24) | (d[off + 9] << 16) | (d[off + 10] << 8) | d[off + 11];
    tags[sig] = { offset: tagOff, size: tagSize };
  }

  // Read XYZ tag: 4-byte type sig + 4-byte reserved + X(s15.16) + Y(s15.16) + Z(s15.16)
  const readXYZ = (tag) => {
    if (!tag || tag.offset + 20 > d.length) return null;
    const o = tag.offset + 8; // skip type sig + reserved
    const buf = new DataView(d.buffer, d.byteOffset);
    return [buf.getInt32(o) / 65536, buf.getInt32(o + 4) / 65536, buf.getInt32(o + 8) / 65536];
  };

  const rXYZ = readXYZ(tags.rXYZ);
  const gXYZ = readXYZ(tags.gXYZ);
  const bXYZ = readXYZ(tags.bXYZ);
  if (!rXYZ || !gXYZ || !bXYZ) { cache.set(profileObjNum, null); return null; }

  // Profile RGB→XYZ matrix (column-major: columns are rXYZ, gXYZ, bXYZ)
  // Stored as row-major 3x3: matrix[row*3 + col]
  const matrix = [
    rXYZ[0], gXYZ[0], bXYZ[0],
    rXYZ[1], gXYZ[1], bXYZ[1],
    rXYZ[2], gXYZ[2], bXYZ[2],
  ];

  // Read TRC (transfer function / gamma) for each channel
  const readGamma = (tag) => {
    if (!tag || tag.offset + 12 > d.length) return 2.2; // default sRGB-ish
    const buf = new DataView(d.buffer, d.byteOffset);
    const count = buf.getUint32(tag.offset + 8);
    if (count === 0) return 1.0; // linear
    if (count === 1) return buf.getUint16(tag.offset + 12) / 256; // u8.8 fixed point
    return 2.2; // complex curve — approximate as sRGB
  };

  const gamma = [
    readGamma(tags.rTRC),
    readGamma(tags.gTRC),
    readGamma(tags.bTRC),
  ];

  const result = { gamma, matrix };
  cache.set(profileObjNum, result);
  return result;
}

/**
 * Extract the ICC profile stream object number from a color space definition.
 * Returns null if the color space is not ICCBased.
 * @param {string} objText - Image object text
 * @param {ObjectCache} [objCache]
 */
function findICCProfileObjNum(objText, objCache) {
  // Array form: /ColorSpace [/ICCBased 5 0 R]
  const arrayIcc = /\/ColorSpace\s*\[\s*\/ICCBased\s+(\d+)\s+\d+\s+R/.exec(objText);
  if (arrayIcc) return Number(arrayIcc[1]);

  // Indirect reference form: /ColorSpace N 0 R → resolve to find ICCBased
  if (objCache) {
    const refMatch = /\/ColorSpace\s+(\d+)\s+\d+\s+R/.exec(objText);
    if (refMatch) {
      const csObjText = objCache.getObjectText(Number(refMatch[1]));
      if (csObjText) {
        const iccMatch = /\/ICCBased\s+(\d+)\s+\d+\s+R/.exec(csObjText);
        if (iccMatch) return Number(iccMatch[1]);
      }
    }
  }
  return null;
}

/**
 * Resolve an ICCBased color space to its Device* equivalent based on the /N component count.
 * ICCBased color spaces are functionally equivalent to DeviceGray (N=1), DeviceRGB (N=3),
 * or DeviceCMYK (N=4) for rendering purposes.
 * @param {string} csText - Text containing the ICCBased array (e.g., "[/ICCBased 5 0 R]")
 * @param {ObjectCache} objCache
 */
function resolveICCBased(csText, objCache) {
  const iccRefMatch = /\/ICCBased\s+(\d+)\s+\d+\s+R/.exec(csText);
  if (iccRefMatch) {
    const iccObjText = objCache.getObjectText(Number(iccRefMatch[1]));
    if (iccObjText) {
      const nMatch = /\/N\s+(\d+)/.exec(iccObjText);
      const n = nMatch ? Number(nMatch[1]) : 3;
      return n === 1 ? 'DeviceGray' : n === 4 ? 'DeviceCMYK' : 'DeviceRGB';
    }
  }
  return 'DeviceRGB';
}

/**
 * Pre-convert an indexed palette whose base is a tint-based color space
 * (Separation or DeviceN) to RGB using the tint transform.
 *
 * @param {Uint8Array} palette - Raw palette bytes (nColors * nInputComponents)
 * @param {string} baseObjText - Text of the Separation/DeviceN base CS array object
 * @param {ObjectCache} objCache
 */
function convertTintPalette(palette, baseObjText, objCache) {
  const parsedTintCS = parseTintColorSpace(baseObjText, objCache);
  if (!parsedTintCS.tintFn || parsedTintCS.nInputs < 1) return null;
  const nComp = parsedTintCS.nInputs;
  const nColors = Math.floor(palette.length / nComp);
  if (nColors === 0) return null;

  const rgbPalette = new Uint8Array(nColors * 3);
  const inputs = new Array(nComp);
  for (let ci = 0; ci < nColors; ci++) {
    for (let c = 0; c < nComp; c++) inputs[c] = palette[ci * nComp + c] / 255;
    const rgb = tintComponentsToRGB(parsedTintCS, inputs);
    if (!rgb) return null;
    rgbPalette[ci * 3] = rgb[0];
    rgbPalette[ci * 3 + 1] = rgb[1];
    rgbPalette[ci * 3 + 2] = rgb[2];
  }
  return rgbPalette;
}

/**
 * Parse an Indexed color space definition from its text representation.
 *
 * @param {string} rawCsText - Text containing the Indexed array (e.g. "[/Indexed /DeviceRGB 255 <hex>]")
 * @param {ObjectCache} objCache
 * @param {number|null} [objNum=null] - Object number for raw-byte literal string parsing
 * @returns {{palette: Uint8Array, hival: number, base: string}|null}
 */
export function parseIndexedColorSpace(rawCsText, objCache, objNum = null) {
  // PDF allows `% ... newline` comments. Strip them so the
  // structural regexes below don't trip over a stray comment between tokens.
  //
  // Use `csText` (stripped) only for shape-matching regexes. Use `rawCsText`
  // (original bytes) for extracting palette data from `(...)` literal strings:
  // a `%` byte inside a literal is data, not a comment, and stripping would
  // silently corrupt those palette bytes.
  const csText = rawCsText.replace(/%[^\r\n]*/g, '');
  let paletteBase = null;
  let paletteHival = 0;
  let palette = null;
  let baseObjText = null; // for tint/Lab post-processing

  // ── Step 1: Try stream-ref patterns first ──────────────────────────────────

  // 1a: direct base name + stream: /Indexed /DeviceRGB 255 67 0 R
  const directStreamMatch = /\/Indexed\s*\/(\w+)\s+(\d+)\s+(\d+)\s+\d+\s+R/.exec(csText);
  if (directStreamMatch) {
    paletteBase = directStreamMatch[1];
    paletteHival = Number(directStreamMatch[2]);
    const palObjNum = Number(directStreamMatch[3]);
    palette = objCache.getStreamBytes(palObjNum) || readIndirectLiteralPalette(objCache, palObjNum);
  }

  // 1b: indirect base ref + stream: /Indexed 74 0 R 13 67 0 R
  if (!palette) {
    const refStreamMatch = /\/Indexed\s+(\d+)\s+\d+\s+R\s+(\d+)\s+(\d+)\s+\d+\s+R/.exec(csText);
    if (refStreamMatch) {
      const baseObjNum = Number(refStreamMatch[1]);
      paletteHival = Number(refStreamMatch[2]);
      const palObjNum = Number(refStreamMatch[3]);
      palette = objCache.getStreamBytes(palObjNum) || readIndirectLiteralPalette(objCache, palObjNum);
      baseObjText = objCache.getObjectText(baseObjNum);
      if (baseObjText) {
        const m = /\/(\w+)/.exec(baseObjText);
        if (m) paletteBase = m[1];
      }
    }
  }

  // 1c: array-form base + stream: [/Indexed [/CalRGB <<...>>] 3 102 0 R]
  if (!palette) {
    const arrBaseMatch = /\/Indexed\s*\[/.exec(csText);
    if (arrBaseMatch) {
      const arrStart = arrBaseMatch.index + arrBaseMatch[0].length;
      let depth = 1;
      let arrEnd = arrStart;
      while (arrEnd < csText.length && depth > 0) {
        if (csText[arrEnd] === '[') depth++;
        else if (csText[arrEnd] === ']') depth--;
        if (depth > 0) arrEnd++;
      }
      const baseArr = csText.substring(arrStart, arrEnd);
      const baseNameMatch = /\/(\w+)/.exec(baseArr);
      if (baseNameMatch) {
        const afterArr = csText.substring(arrEnd + 1).trim();
        // After the base array: hival N 0 R (stream), or hival <hex>, or hival (literal)
        const streamAfterArr = /^(\d+)\s+(\d+)\s+\d+\s+R/.exec(afterArr);
        const hexAfterArr = !streamAfterArr ? /^(\d+)\s*<([0-9a-fA-F\s]+)>/.exec(afterArr) : null;
        if (streamAfterArr) {
          paletteBase = baseNameMatch[1];
          baseObjText = baseArr;
          paletteHival = Number(streamAfterArr[1]);
          const palObjNum = Number(streamAfterArr[2]);
          palette = objCache.getStreamBytes(palObjNum) || readIndirectLiteralPalette(objCache, palObjNum);
        } else if (hexAfterArr) {
          paletteBase = baseNameMatch[1];
          baseObjText = baseArr;
          paletteHival = Number(hexAfterArr[1]);
          const hex = hexAfterArr[2].replace(/\s+/g, '');
          palette = new Uint8Array(hex.length / 2);
          for (let i = 0; i < palette.length; i++) palette[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
          palette = objCache.decryptObjectStringBytes(palette, objNum);
        } else {
          const litAfterArr = /^(\d+)\s*\(/.exec(afterArr);
          const litMatch = litAfterArr ? /\/Indexed[\s\S]*?\d+\s*\(/.exec(rawCsText) : null;
          if (litMatch) {
            paletteBase = baseNameMatch[1];
            baseObjText = baseArr;
            paletteHival = Number(litAfterArr[1]);
            palette = parseLiteralPalette(rawCsText, litMatch, objCache, objNum);
          }
        }
      }
    }
  }

  // ── Step 2: Try literal string patterns ────────────────────────────────────

  // 2a: direct base name + literal: /Indexed /DeviceRGB 255 (bytes...)
  if (!palette) {
    const litDirectMatch = /\/Indexed\s*\/(\w+)\s+(\d+)\s*\(/.exec(rawCsText);
    if (litDirectMatch) {
      paletteBase = litDirectMatch[1];
      paletteHival = Number(litDirectMatch[2]);
      palette = parseLiteralPalette(rawCsText, litDirectMatch, objCache, objNum);
    }
  }

  // 2b: indirect base ref + literal: /Indexed 639 0 R 18 (bytes...)
  if (!palette) {
    const litRefMatch = /\/Indexed\s+(\d+)\s+\d+\s+R\s+(\d+)\s*\(/.exec(rawCsText);
    if (litRefMatch) {
      const baseObjNum = Number(litRefMatch[1]);
      paletteHival = Number(litRefMatch[2]);
      baseObjText = objCache.getObjectText(baseObjNum);
      if (baseObjText) {
        const m = /\/(\w+)/.exec(baseObjText);
        if (m) paletteBase = m[1];
      }
      palette = parseLiteralPalette(rawCsText, litRefMatch, objCache, objNum);
    }
  }

  // ── Step 3: Try hex string patterns ────────────────────────────────────────

  // 3a: direct base name + hex: /Indexed /DeviceRGB 202 <hex>
  if (!palette) {
    const hexDirectMatch = /\/Indexed\s*\/(\w+)\s+(\d+)\s*<([0-9a-fA-F\s]+)>/.exec(csText);
    if (hexDirectMatch) {
      paletteBase = hexDirectMatch[1];
      paletteHival = Number(hexDirectMatch[2]);
      const hex = hexDirectMatch[3].replace(/\s+/g, '');
      palette = new Uint8Array(hex.length / 2);
      for (let i = 0; i < palette.length; i++) palette[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
      palette = objCache.decryptObjectStringBytes(palette, objNum);
    }
  }

  // 3b: indirect base ref + hex: /Indexed 8 0 R 202 <hex>
  if (!palette) {
    const hexRefMatch = /\/Indexed\s+(\d+)\s+\d+\s+R\s+(\d+)\s*<([0-9a-fA-F\s]+)>/.exec(csText);
    if (hexRefMatch) {
      const baseObjNum = Number(hexRefMatch[1]);
      paletteHival = Number(hexRefMatch[2]);
      const hex = hexRefMatch[3].replace(/\s+/g, '');
      palette = new Uint8Array(hex.length / 2);
      for (let i = 0; i < palette.length; i++) palette[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
      palette = objCache.decryptObjectStringBytes(palette, objNum);
      baseObjText = objCache.getObjectText(baseObjNum);
      if (baseObjText) {
        const m = /\/(\w+)/.exec(baseObjText);
        if (m) paletteBase = m[1];
      }
    }
  }

  if (!palette || !paletteBase) return null;

  // ── Step 4: Resolve base color space ───────────────────────────────────────

  // Cal* → Device*
  if (paletteBase === 'CalRGB') paletteBase = 'DeviceRGB';
  else if (paletteBase === 'CalGray') paletteBase = 'DeviceGray';

  // ICCBased → Device* via /N
  if (paletteBase === 'ICCBased') {
    const iccSrc = baseObjText || csText;
    const iccRefMatch = /(\d+)\s+\d+\s+R/.exec(iccSrc);
    if (iccRefMatch) {
      const iccObjText = objCache.getObjectText(Number(iccRefMatch[1]));
      const nMatch = iccObjText && /\/N\s+(\d+)/.exec(iccObjText);
      const n = nMatch ? Number(nMatch[1]) : 3;
      paletteBase = n === 1 ? 'DeviceGray' : n === 4 ? 'DeviceCMYK' : 'DeviceRGB';
    } else {
      paletteBase = 'DeviceRGB';
    }
  }

  // ── Step 5: Pre-convert exotic base palettes ───────────────────────────────

  // Separation/DeviceN → pre-convert palette via tint transform
  if ((paletteBase === 'Separation' || paletteBase === 'DeviceN') && baseObjText) {
    const converted = convertTintPalette(palette, baseObjText, objCache);
    if (converted) {
      palette = converted;
      paletteBase = 'DeviceRGB';
    }
  }

  // Lab → pre-convert L*a*b* → sRGB
  if (paletteBase === 'Lab' && baseObjText) {
    const rangeStr = resolveArrayValue(baseObjText, 'Range', objCache);
    const rangeNums = rangeStr ? rangeStr.split(/\s+/).map(Number) : null;
    const aMin = rangeNums && rangeNums.length >= 4 ? rangeNums[0] : -100;
    const aMax = rangeNums && rangeNums.length >= 4 ? rangeNums[1] : 100;
    const bMin = rangeNums && rangeNums.length >= 4 ? rangeNums[2] : -100;
    const bMax = rangeNums && rangeNums.length >= 4 ? rangeNums[3] : 100;
    const wpStr = resolveArrayValue(baseObjText, 'WhitePoint', objCache);
    const wpNums = wpStr ? wpStr.split(/\s+/).map(Number) : null;
    const wp = wpNums && wpNums.length >= 3 ? [wpNums[0], wpNums[1], wpNums[2]] : [0.9642, 1.0, 0.8249];
    const nEntries = Math.floor(palette.length / 3);
    const rgbPalette = new Uint8Array(nEntries * 3);
    const delta = 6 / 29;
    const fInv = (ft) => (ft > delta ? ft * ft * ft : 3 * delta * delta * (ft - 4 / 29));
    const gammaEnc = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
    for (let i = 0; i < nEntries; i++) {
      const Lstar = palette[i * 3] / 255 * 100;
      const astar = palette[i * 3 + 1] / 255 * (aMax - aMin) + aMin;
      const bstar = palette[i * 3 + 2] / 255 * (bMax - bMin) + bMin;
      const fy = (Lstar + 16) / 116;
      const fx = fy + astar / 500;
      const fz = fy - bstar / 200;
      const xyzX = wp[0] * fInv(fx);
      const xyzY = wp[1] * fInv(fy);
      const xyzZ = wp[2] * fInv(fz);
      const lr = 3.1338561 * xyzX - 1.6168667 * xyzY - 0.4906146 * xyzZ;
      const lg = -0.9787684 * xyzX + 1.9161415 * xyzY + 0.0334540 * xyzZ;
      const lb = 0.0719453 * xyzX - 0.2289914 * xyzY + 1.4052427 * xyzZ;
      rgbPalette[i * 3] = Math.max(0, Math.min(255, Math.round(255 * gammaEnc(Math.max(0, Math.min(1, lr))))));
      rgbPalette[i * 3 + 1] = Math.max(0, Math.min(255, Math.round(255 * gammaEnc(Math.max(0, Math.min(1, lg))))));
      rgbPalette[i * 3 + 2] = Math.max(0, Math.min(255, Math.round(255 * gammaEnc(Math.max(0, Math.min(1, lb))))));
    }
    palette = rgbPalette;
    paletteBase = 'DeviceRGB';
  }

  return { palette, hival: paletteHival, base: paletteBase };
}

/**
 * Read an indirect palette object as a literal string. Used when /Indexed names
 * an object number whose payload is a `(...)` string literal rather than a stream.
 * @param {ObjectCache} objCache
 * @param {number} objNum
 * @returns {Uint8Array|null}
 */
function readIndirectLiteralPalette(objCache, objNum) {
  const entry = objCache.xrefEntries[objNum];
  if (entry && entry.type === 1) {
    const pdfBytes = objCache.pdfBytes;
    const endSearch = Math.min(entry.offset + 5000, pdfBytes.length);
    for (let i = entry.offset; i < endSearch; i++) {
      if (pdfBytes[i] === 0x28) { // '('
        return objCache.decryptObjectStringBytes(parsePdfLiteralString(pdfBytes, i).value, objNum);
      }
      if (pdfBytes[i] === 0x3C || pdfBytes[i] === 0x2F) return null;
    }
  }
  const text = objCache.getObjectText(objNum);
  if (!text) return null;
  const parenIdx = text.indexOf('(');
  if (parenIdx < 0) return null;
  const bytes = [];
  let depth = 1;
  for (let i = parenIdx + 1; i < text.length && depth > 0; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x5C) {
      i++;
      if (i >= text.length) break;
      const nc = text.charCodeAt(i);
      if (nc === 0x6E) bytes.push(0x0A);
      else if (nc === 0x72) bytes.push(0x0D);
      else if (nc === 0x74) bytes.push(0x09);
      else if (nc === 0x62) bytes.push(0x08);
      else if (nc === 0x66) bytes.push(0x0C);
      else if (nc === 0x0D) {
        if (i + 1 < text.length && text.charCodeAt(i + 1) === 0x0A) i++;
      } else if (nc === 0x0A) { /* line continuation */
      } else if (nc >= 0x30 && nc <= 0x37) {
        let oct = String.fromCharCode(nc);
        if (i + 1 < text.length && text.charCodeAt(i + 1) >= 0x30 && text.charCodeAt(i + 1) <= 0x37) oct += text[++i];
        if (i + 1 < text.length && text.charCodeAt(i + 1) >= 0x30 && text.charCodeAt(i + 1) <= 0x37) oct += text[++i];
        bytes.push(parseInt(oct, 8));
      } else {
        bytes.push(nc);
      }
    } else if (c === 0x28) {
      depth++; bytes.push(c);
    } else if (c === 0x29) {
      depth--; if (depth > 0) bytes.push(c);
    } else {
      bytes.push(c);
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Parse a literal string palette from csText, with raw-byte fallback for type-1 objects.
 * @param {string} csText
 * @param {RegExpExecArray} regexMatch - The regex match that found the literal opening
 * @param {ObjectCache} objCache
 * @param {number|null} objNum
 */
function parseLiteralPalette(csText, regexMatch, objCache, objNum) {
  // Try raw-byte parsing from pdfBytes to avoid TextDecoder corruption of 0x80-0x9F
  if (objNum != null) {
    const entry = objCache.xrefEntries[objNum];
    if (entry && entry.type === 1) {
      const objOffset = entry.offset;
      const pdfBytes = objCache.pdfBytes;
      const endSearch = Math.min(objOffset + 5000, pdfBytes.length);
      let parenPos = -1;
      for (let si = objOffset; si < endSearch; si++) {
        if (pdfBytes[si] === 0x2F) { // '/'
          if (si + 7 < endSearch
              && pdfBytes[si + 1] === 0x49 && pdfBytes[si + 2] === 0x6E && pdfBytes[si + 3] === 0x64
              && pdfBytes[si + 4] === 0x65 && pdfBytes[si + 5] === 0x78 && pdfBytes[si + 6] === 0x65
              && pdfBytes[si + 7] === 0x64) { // "Indexed"
            for (let pi = si + 8; pi < endSearch; pi++) {
              if (pdfBytes[pi] === 0x28) { parenPos = pi; break; }
            }
            break;
          }
        }
      }
      if (parenPos >= 0) return objCache.decryptObjectStringBytes(parsePdfLiteralString(pdfBytes, parenPos).value, objNum);
    }
  }
  // Fallback: parse from text via charCodeAt (works for compressed objects)
  const parenIdx = csText.indexOf('(', regexMatch.index + regexMatch[0].length - 1);
  if (parenIdx < 0) return null;
  const bytes = [];
  let depth = 1;
  for (let i = parenIdx + 1; i < csText.length && depth > 0; i++) {
    const c = csText.charCodeAt(i);
    if (c === 0x5C) { // backslash
      i++;
      if (i >= csText.length) break;
      const nc = csText.charCodeAt(i);
      if (nc === 0x6E) bytes.push(0x0A);
      else if (nc === 0x72) bytes.push(0x0D);
      else if (nc === 0x74) bytes.push(0x09);
      else if (nc === 0x62) bytes.push(0x08);
      else if (nc === 0x66) bytes.push(0x0C);
      else if (nc === 0x0D) {
        if (i + 1 < csText.length && csText.charCodeAt(i + 1) === 0x0A) i++;
      } else if (nc === 0x0A) {
        /* line continuation */
      } else if (nc >= 0x30 && nc <= 0x37) {
        let oct = String.fromCharCode(nc);
        if (i + 1 < csText.length && csText.charCodeAt(i + 1) >= 0x30 && csText.charCodeAt(i + 1) <= 0x37) oct += csText[++i];
        if (i + 1 < csText.length && csText.charCodeAt(i + 1) >= 0x30 && csText.charCodeAt(i + 1) <= 0x37) oct += csText[++i];
        bytes.push(parseInt(oct, 8));
      } else {
        bytes.push(nc);
      }
    } else if (c === 0x28) {
      depth++; bytes.push(c);
    } else if (c === 0x29) {
      depth--; if (depth > 0) bytes.push(c);
    } else {
      bytes.push(c);
    }
  }
  return objCache.decryptObjectStringBytes(new Uint8Array(bytes), objNum);
}

/**
 * Classify a DeviceN color space. Single-colorant DeviceN (e.g., [/DeviceN [/Black] ...])
 * is functionally equivalent to Separation and needs ink inversion. Multi-colorant DeviceN
 * (e.g., [/DeviceN [/Red /Green /Blue /Alpha] ...]) should be treated as RGB-like.
 * @param {string} csText
 */
function classifyDeviceN(csText) {
  // Count colorant names in the array: /DeviceN [ /Name1 /Name2 ... ]
  // Names may contain PDF hex escapes (e.g., /PANTONE#202755#20U), so match any
  // non-delimiter chars rather than \w+.
  const namesMatch = /\/DeviceN\s*\[\s*((?:\/[^/[\]<>(){}\s]+\s*)+)\]/.exec(csText);
  if (namesMatch) {
    const colorants = namesMatch[1].match(/\/[^/[\]<>(){}\s]+/g) || [];
    if (colorants.length === 1) return 'Separation';
  }
  return 'DeviceN';
}

/**
 * Read the /Filter value from an image object.
 * Handles both single name (/Filter /DCTDecode) and array (/Filter [/FlateDecode]).
 * For array filter chains, returns the image-format filter (DCTDecode/JPXDecode)
 * if present, since extractStream decodes transport filters (ASCIIHexDecode,
 * FlateDecode, etc.) but leaves image-format filters for imageInfoToBitmap.
 * @param {string} objText
 */
function parseFilter(objText) {
  const filterAlias = {
    AHx: 'ASCIIHexDecode',
    A85: 'ASCII85Decode',
    LZW: 'LZWDecode',
    Fl: 'FlateDecode',
    RL: 'RunLengthDecode',
    CCF: 'CCITTFaxDecode',
    DCT: 'DCTDecode',
  };
  const arrayMatch = /\/Filter\s*\[([\s\S]*?)\]/.exec(objText);
  if (arrayMatch) {
    const filters = [...arrayMatch[1].matchAll(/\/([^\s/<>[\]]+)/g)].map((m) => filterAlias[m[1]] || m[1]);
    for (const f of filters) {
      if (f === 'DCTDecode' || f === 'JPXDecode') return f;
    }
    return filters[0] || null;
  }

  // Single name
  const nameMatch = /\/Filter\s*\/(\w+)/.exec(objText);
  if (nameMatch) return filterAlias[nameMatch[1]] || nameMatch[1];

  return null;
}

/**
 * Determine an appropriate file extension for a given image filter.
 * @param {string|null} filter
 */
export function imageFilterToExt(filter) {
  switch (filter) {
    case 'DCTDecode': return 'jpg';
    case 'JPXDecode': return 'jp2';
    default: return 'raw';
  }
}
