import { parsePageImages, parseImageObject, parseIndexedColorSpace } from './parsePdfImages.js';
import {
  parseSeparationTint, parseTintColorSpace,
  tintComponentsToRGB, cmykToRgb, evaluateFunction, parseFunction, tintSamplesToRgb,
} from './pdfColorFunctions.js';
import { extractPdfAnnotations } from './parsePdfAnnots.js';
import {
  findRootObjNum, applyPredictor, getPageContentStreams, isFormOCHidden, parseHiddenOCMCNames,
} from './parsePdfUtils.js';
import {
  extractDict, resolveIntValue, resolveNumValue, resolveArrayValue, matMul, bytesToLatin1,
} from './pdfPrimitives.js';
import { parseDrawOps } from './parseDrawOps.js';

/** @typedef {import('./objectCache.js').ObjectCache} ObjectCache */
/** @typedef {import('./parseDrawOps.js').DrawOp} DrawOp */
/** @typedef {import('./parseDrawOps.js').ImageDrawOp} ImageDrawOp */
/** @typedef {import('./parseDrawOps.js').PathCommand} PathCommand */
/** @typedef {import('./parseDrawOps.js').SmaskRef} SmaskRef */
/** @typedef {import('./parseDrawOps.js').PatternShading} PatternShading */
/** @typedef {import('./parseDrawOps.js').TilingPatternRef} TilingPatternRef */
/** @typedef {import('./parseDrawOps.js').TransparencyGroupAttrs} TransparencyGroupAttrs */
/** @typedef {import('./parseDrawOps.js').ClipEntry} ClipEntry */
import { inflate as pakoInflate, inflatePartial as pakoInflatePartial } from '../../lib/pako-inflate.js';
import { parsePageFonts, parseGlyphStreamPaths } from './fonts/parsePdfFonts.js';
import { standardFontToCSS } from './fonts/standardFontMetrics.js';
import {
  base14ToBundledFont, cssFamilyToBundledFont, genericToBundledFont, cssGenericForFontObj,
} from './fonts/base14Substitution.js';
import { FALLBACK_CHAIN } from '../fallbackFonts.js';
import { loadFontFace } from '../containers/fontContainer.js';
import { decodeCMYKJpegToRGB } from './codecs/decodeJPEG.js';
import {
  rebuildFontFromGlyphs, buildFontFromCFF, convertType1ToOTFNew,
} from './fonts/convertFontToOTF.js';
import { ca } from '../canvasAdapter.js';

/**
 * Linearly interpolate an RGB value from a tint transform sample table.
 * The table contains nSamples RGB triplets (R0,G0,B0,R1,G1,B1,...).
 * `tint` is 0–255 mapping across the sample range.
 * @param {Uint8Array} tintSamples
 * @param {number} nSamples
 * @param {number} tint
 * @returns {[number, number, number]}
 */
function interpolateTint(tintSamples, nSamples, tint) {
  const t = tint / 255 * (nSamples - 1);
  const lo = Math.min(Math.floor(t), nSamples - 1);
  const hi = Math.min(lo + 1, nSamples - 1);
  const f = t - lo;
  const li = lo * 3;
  const hi3 = hi * 3;
  return [
    Math.round(tintSamples[li] * (1 - f) + tintSamples[hi3] * f),
    Math.round(tintSamples[li + 1] * (1 - f) + tintSamples[hi3 + 1] * f),
    Math.round(tintSamples[li + 2] * (1 - f) + tintSamples[hi3 + 2] * f),
  ];
}

/**
 * Stable family-name alias for an embedded PDF font, keyed on
 * `(docId, fontObjNum)`. Reused across every page of the document so
 * `GlobalFonts.register` dedups to one registration per typeface.
 *
 * @param {{ docId: number }} objCache
 * @param {number|null|undefined} fontObjNum
 * @param {string} fallbackTag — used when fontObjNum is missing (inline
 *   Type 3 / fonts declared in the Resources dict).
 */
function pdfFontFamilyName(objCache, fontObjNum, fallbackTag) {
  if (fontObjNum != null) return `_pdf_d${objCache.docId}_f${fontObjNum}`;
  return `_pdf_d${objCache.docId}_t${fallbackTag}`;
}

/**
 * After a font registration loop, append a CSS generic family fallback to each
 * embedded `_pdf_*` entry in `registeredFontNames` so that missing glyphs fall
 * back to a style-appropriate system font rather than Chrome's default serif.
 *
 * @param {Map<string, string>} registeredFontNames
 * @param {Map<string, any>} fonts
 */
function appendGenericFallbacks(registeredFontNames, fonts) {
  for (const [fontTag, name] of registeredFontNames) {
    const fontObj = fonts.get(fontTag);
    if (!fontObj) continue;
    const trailingGeneric = name.match(/,\s*(sans-serif|serif|monospace|cursive)\s*$/i);
    if (trailingGeneric) {
      registeredFontNames.set(fontTag, name.replace(
        /,\s*(sans-serif|serif|monospace|cursive)\s*$/i,
        `, ${FALLBACK_CHAIN}, $1`,
      ));
    } else {
      const primary = /[",]/.test(name) ? name : `"${name}"`;
      registeredFontNames.set(fontTag, `${primary}, ${FALLBACK_CHAIN}, ${cssGenericForFontObj(fontObj)}`);
    }
  }
}

/**
 * Register a non-embedded font using bundled substitution fonts.
 *
 * @param {{ baseName: string, bold?: boolean, italic?: boolean, serifFlag?: boolean }} fontObj
 * @param {string} _familyName - CSS font-family name to register
 * @param {Map<string, string>} targetMap - Map to set familyName into (e.g., registeredFontNames)
 * @param {string} fontTag - Font tag key for targetMap
 */
async function registerNonEmbeddedFont(fontObj, _familyName, targetMap, fontTag) {
  // FontFaces are registered at the variant's actual weight/style.
  // Otherwise Firefox stacks an extra faux-bold or italic on top of an already-bold/italic file.
  const hints = { bold: fontObj.bold, italic: fontObj.italic };
  const sub = base14ToBundledFont(fontObj.baseName, hints)
    || cssFamilyToBundledFont(standardFontToCSS(fontObj.baseName), hints)
    || genericToBundledFont(cssGenericForFontObj(fontObj), hints);
  if (sub) {
    try {
      let fontBytes;
      if (typeof process !== 'undefined') {
        const { fileURLToPath } = await import('node:url');
        const { readFileSync } = await import('node:fs');
        fontBytes = readFileSync(fileURLToPath(sub.url));
      } else {
        fontBytes = await fetch(sub.url).then((r) => r.arrayBuffer());
      }
      const face = loadFontFace(sub.alias, sub.faceStyle, sub.faceWeight, fontBytes);
      await face.loaded;
      targetMap.set(fontTag, sub.alias);
      return;
    } catch (_e) {
      const fallback = standardFontToCSS(fontObj.baseName) || cssGenericForFontObj(fontObj);
      targetMap.set(fontTag, fallback);
      console.warn(`[renderPdfPage] Bundled font ${sub.alias} failed to load for "${fontObj.baseName}", using ${fallback} fallback`);
      return;
    }
  }
  const cssFamily = standardFontToCSS(fontObj.baseName);
  const fallback = cssFamily || cssGenericForFontObj(fontObj);
  targetMap.set(fontTag, fallback);
  if (!cssFamily) console.warn(`[renderPdfPage] No font data for "${fontObj.baseName}", using ${fallback} fallback`);
}

/**
 * Convert an embedded font's binary data to OTF and register it via loadFontFace.
 *
 * @param {string} fontTag
 * @param {Object} fontObj - Parsed fontInfo from parsePageFonts()
 * @param {Map<string, string>} registeredFontNames - fontTag → CSS familyName (mutated)
 * @param {Set<string>} symbolFontTags - (mutated)
 * @param {Set<string>} cidPUATags - (mutated)
 * @param {Set<string>} rawCharCodeTags - (mutated)
 * @param {Map<string, Set<number>>} cidCollisionMap - (mutated)
 * @param {ObjectCache} objCache
 * @param {string} familyName - CSS family name to register (used on cache miss only)
 */
async function convertAndRegisterFont(
  fontTag, fontObj, registeredFontNames, symbolFontTags, cidPUATags,
  rawCharCodeTags, cidCollisionMap, objCache, familyName,
) {
  const fontData = fontObj.type0 || fontObj.type1;
  if (!fontData || !fontData.fontFile) {
    await registerNonEmbeddedFont(fontObj, familyName, registeredFontNames, fontTag);
    return;
  }

  // Cache hit: font already converted and registered in a prior page/context.
  const cacheKey = fontObj.fontObjNum;
  if (cacheKey != null) {
    const cached = objCache.fontConversionCache.get(cacheKey);
    if (cached) {
      registeredFontNames.set(fontTag, cached.familyName);
      if (cached.usesPUA) cidPUATags.add(fontTag);
      if (cached.cidCollisions) cidCollisionMap.set(fontTag, cached.cidCollisions);
      if (cached.cmapType === 'symbol') symbolFontTags.add(fontTag);
      else if (cached.cmapType === 'rawCharCode') rawCharCodeTags.add(fontTag);
      if (cached.fontMatrix && fontObj.type1) fontObj.type1.fontMatrix = cached.fontMatrix;
      // All glyph outlines are empty (a metrics-only subset), so flag the fresh fontObj to make the draw path suppress its glyphs.
      if (cached.allGlyphsEmpty) fontObj.allGlyphsEmpty = true;
      return;
    }
  }

  // Cache miss: convert font binary to OTF and register with loadFontFace.
  const ab = fontData.fontFile.buffer.slice(
    fontData.fontFile.byteOffset,
    fontData.fontFile.byteOffset + fontData.fontFile.byteLength,
  );
  let fontBytes = new Uint8Array(ab);
  const isCFF = fontBytes.length >= 4 && fontBytes[0] === 1 && fontBytes[1] === 0;
  let isPFA = fontBytes.length >= 2 && fontBytes[0] === 0x25 && fontBytes[1] === 0x21;
  const isPFB = fontBytes.length >= 6 && fontBytes[0] === 0x80 && (fontBytes[1] === 0x01 || fontBytes[1] === 0x02);

  // PFB→PFA: strip segment headers
  if (isPFB && !isCFF) {
    const segments = [];
    let pfbPos = 0;
    while (pfbPos + 6 <= fontBytes.length && fontBytes[pfbPos] === 0x80) {
      const segType = fontBytes[pfbPos + 1];
      if (segType === 3) break;
      const segLen = fontBytes[pfbPos + 2] | (fontBytes[pfbPos + 3] << 8) | (fontBytes[pfbPos + 4] << 16) | (fontBytes[pfbPos + 5] << 24);
      pfbPos += 6;
      if (pfbPos + segLen > fontBytes.length) break;
      segments.push(fontBytes.subarray(pfbPos, pfbPos + segLen));
      pfbPos += segLen;
    }
    if (segments.length > 0) {
      const totalLen = segments.reduce((s, seg) => s + seg.length, 0);
      const pfaData = new Uint8Array(totalLen);
      let off = 0;
      for (const seg of segments) { pfaData.set(seg, off); off += seg.length; }
      fontBytes = pfaData;
      isPFA = true;
    }
  }

  let usesPUA = false;
  let cmapType = null;
  let cidCollisions = null;
  let fontMatrix = null;
  let registered = false;

  // OTTO (OpenType/CFF) — try direct load, fall back to CFF extraction
  const isOTTO = fontBytes.length >= 4 && fontBytes[0] === 0x4F && fontBytes[1] === 0x54
    && fontBytes[2] === 0x54 && fontBytes[3] === 0x4F;
  if (isOTTO) {
    try {
      const face = loadFontFace(familyName, 'normal', 'normal', ab);
      await face.loaded;
      registered = true;
    } catch (_e) {
      const numT = (fontBytes[4] << 8) | fontBytes[5];
      for (let ti = 0; ti < numT; ti++) {
        const e = 12 + ti * 16;
        if (e + 16 > fontBytes.length) break;
        if (fontBytes[e] === 0x43 && fontBytes[e + 1] === 0x46 && fontBytes[e + 2] === 0x46 && fontBytes[e + 3] === 0x20) {
          const cffOff = (fontBytes[e + 8] << 24) | (fontBytes[e + 9] << 16) | (fontBytes[e + 10] << 8) | fontBytes[e + 11];
          const cffLen = (fontBytes[e + 12] << 24) | (fontBytes[e + 13] << 16) | (fontBytes[e + 14] << 8) | fontBytes[e + 15];
          if (cffOff + cffLen <= fontBytes.length) {
            const cffBytes = fontBytes.subarray(cffOff, cffOff + cffLen);
            const result = buildFontFromCFF(cffBytes, fontObj, fontObj.differences);
            if (result) {
              try {
                const face2 = loadFontFace(familyName, 'normal', 'normal', result.otfData);
                await face2.loaded;
                usesPUA = result.usesPUA;
                cidCollisions = result.cidCollisions;
                registered = true;
              } catch (_e2) { /* CFF extraction also failed */ }
            }
          }
          break;
        }
      }
    }
  }

  // Raw CFF
  if (!registered && isCFF) {
    const result = buildFontFromCFF(fontBytes, fontObj, fontObj.differences);
    if (!result) console.warn(`[renderPdfPage] buildFontFromCFF returned null for "${fontObj.baseName}"`);
    if (result) {
      try {
        const face = loadFontFace(familyName, 'normal', 'normal', result.otfData);
        await face.loaded;
        usesPUA = result.usesPUA;
        cidCollisions = result.cidCollisions;
        registered = true;
      } catch (cffErr) {
        console.warn(`[renderPdfPage] CFF OTF load failed for "${fontObj.baseName}":`, cffErr);
      }
    }
  }

  // Type1 PFA/PFB
  if (!registered && isPFA) {
    const type1Result = convertType1ToOTFNew(fontBytes, fontObj);
    if (type1Result) {
      try {
        const face = loadFontFace(familyName, 'normal', 'normal', type1Result.otfData);
        await face.loaded;
        fontMatrix = type1Result.fontMatrix || null;
        if (fontMatrix && fontObj.type1) fontObj.type1.fontMatrix = fontMatrix;
        usesPUA = type1Result.usesPUA;
        registered = true;
      } catch (_e) { /* Type1→OTF failed */ }
    }
  }

  // TrueType
  if (!registered && !isPFA && !isCFF) {
    const cidToGidMap = fontData.cidToGidMap;
    let effectiveCidMap;
    if (cidToGidMap instanceof Uint8Array && cidToGidMap.length > 0) {
      effectiveCidMap = cidToGidMap;
    } else if (cidToGidMap === 'identity') {
      const nT = (fontBytes[4] << 8) | fontBytes[5];
      let numGlyphs = 0;
      for (let ti = 0; ti < nT; ti++) {
        const e = 12 + ti * 16;
        if (e + 16 > fontBytes.length) break;
        if (fontBytes[e] === 0x6D && fontBytes[e + 1] === 0x61 && fontBytes[e + 2] === 0x78 && fontBytes[e + 3] === 0x70) {
          const mo = (fontBytes[e + 8] << 24) | (fontBytes[e + 9] << 16) | (fontBytes[e + 10] << 8) | fontBytes[e + 11];
          if (mo + 6 <= fontBytes.length) numGlyphs = (fontBytes[mo + 4] << 8) | fontBytes[mo + 5];
          break;
        }
      }
      if (numGlyphs > 0) {
        effectiveCidMap = new Uint8Array(numGlyphs * 2);
        for (let g = 0; g < numGlyphs; g++) {
          effectiveCidMap[g * 2] = (g >> 8) & 0xFF;
          effectiveCidMap[g * 2 + 1] = g & 0xFF;
        }
      }
    }
    const rebuilt = rebuildFontFromGlyphs(ab, fontObj, effectiveCidMap);
    if (rebuilt) {
      try {
        const face = loadFontFace(familyName, 'normal', 'normal', rebuilt.otfData);
        await face.loaded;
        usesPUA = rebuilt.usesPUA;
        cmapType = rebuilt.cmapType || null;
        cidCollisions = rebuilt.cidCollisions;
        registered = true;
      } catch (_e) {
        console.warn(`[renderPdfPage] Rebuilt TrueType font FAILED for "${fontObj.baseName}" (${rebuilt.otfData.byteLength} bytes):`, _e?.message || _e);
      }
    }
  }

  if (registered) {
    registeredFontNames.set(fontTag, familyName);
    if (usesPUA) cidPUATags.add(fontTag);
    if (cidCollisions) cidCollisionMap.set(fontTag, cidCollisions);
    if (cmapType === 'symbol') symbolFontTags.add(fontTag);
    else if (cmapType === 'rawCharCode') rawCharCodeTags.add(fontTag);
  } else {
    await registerNonEmbeddedFont(fontObj, familyName, registeredFontNames, fontTag);
  }

  // Store in document-level cache so subsequent pages/contexts skip conversion.
  if (cacheKey != null) {
    objCache.fontConversionCache.set(cacheKey, {
      familyName: registeredFontNames.get(fontTag),
      usesPUA,
      cmapType,
      cidCollisions,
      fontMatrix,
      allGlyphsEmpty: fontObj.allGlyphsEmpty,
    });
  }
}

/** @type {Record<string, GlobalCompositeOperation>} Map PDF blend mode names to Canvas globalCompositeOperation values. */
const pdfBlendToCanvas = {
  Multiply: 'multiply',
  Screen: 'screen',
  Overlay: 'overlay',
  Darken: 'darken',
  Lighten: 'lighten',
  ColorDodge: 'color-dodge',
  ColorBurn: 'color-burn',
  HardLight: 'hard-light',
  SoftLight: 'soft-light',
  Difference: 'difference',
  Exclusion: 'exclusion',
  Hue: 'hue',
  Saturation: 'saturation',
  Color: 'color',
  Luminosity: 'luminosity',
};

/**
 * Strip EXIF APP1 markers from JPEG data to prevent browser EXIF orientation.
 * PDF CTM already handles image placement; EXIF rotation would be applied twice.
 * @param {Uint8Array} data
 */
function stripJpegExif(data) {
  if (data.length < 4 || data[0] !== 0xFF || data[1] !== 0xD8) return data;
  // Walk markers after SOI, removing APP1 (FF E1) segments
  const out = [0xFF, 0xD8];
  let pos = 2;
  while (pos < data.length - 1) {
    if (data[pos] !== 0xFF) break;
    const marker = data[pos + 1];
    if (marker === 0xDA) break; // SOS — rest is image data
    const segLen = (data[pos + 2] << 8) | data[pos + 3];
    if (marker === 0xE1) {
      // Skip APP1 (EXIF)
      pos += 2 + segLen;
      continue;
    }
    // Copy this marker segment
    for (let i = 0; i < 2 + segLen; i++) out.push(data[pos + i]);
    pos += 2 + segLen;
  }
  // Copy the rest (SOS + image data + EOI)
  for (let i = pos; i < data.length; i++) out.push(data[i]);
  return new Uint8Array(out);
}

/**
 * @param {Uint8Array} rawData - Raw JPEG bytes or already-decoded pixel data
 */
async function decodeSmaskJpeg(rawData) {
  // Check if this looks like raw JPEG data (starts with SOI marker)
  if (rawData.length >= 2 && rawData[0] === 0xFF && rawData[1] === 0xD8) {
    let bitmap;
    try {
      bitmap = await ca.createImageBitmapFromData(rawData);
    } catch {
      // Corrupted JPEG SMask — return raw data as-is (will be treated as already-decoded)
      return rawData;
    }
    const bw = bitmap.width;
    const bh = bitmap.height;
    const canvas = ca.makeCanvas(bw, bh);
    const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
    ctx.drawImage(bitmap, 0, 0);
    ca.closeDrawable(bitmap);
    const imgData = ctx.getImageData(0, 0, bw, bh);
    // Extract grayscale values (use red channel since it's a grayscale JPEG)
    const pixels = new Uint8Array(bw * bh);
    for (let i = 0; i < pixels.length; i++) {
      pixels[i] = imgData.data[i * 4]; // Red channel = grayscale value
    }
    ca.closeDrawable(canvas);
    return pixels;
  }
  // JPEG 2000: a JP2 box signature (00 00 00 0C 6A 50 ...) or a bare codestream (SOC marker FF 4F).
  // A JPXDecode SMask may be stored either way, so decode both.
  const isJP2Box = rawData.length >= 6 && rawData[0] === 0x00 && rawData[1] === 0x00
    && rawData[2] === 0x00 && rawData[3] === 0x0C && rawData[4] === 0x6A && rawData[5] === 0x50;
  const isJ2kCodestream = rawData.length >= 2 && rawData[0] === 0xFF && rawData[1] === 0x4F;
  if (isJP2Box || isJ2kCodestream) {
    const { decodeJPX } = await import('./codecs/decodeJPX.js');
    const decoded = decodeJPX(rawData);
    if (decoded && decoded.pixelData) {
      return new Uint8Array(decoded.pixelData.buffer, decoded.pixelData.byteOffset, decoded.pixelData.byteLength);
    }
  }
  // Already decoded pixel data
  return rawData;
}

/**
 * Box-average a binary (0/255) soft mask down to outW x outH.
 * Used when the mask is higher-resolution than the device area the image occupies: averaging preserves the edge anti-aliasing a full-resolution draw would produce,
 * without building a composite at the mask's full resolution.
 * @param {Uint8Array} sMask
 * @param {number} sMaskWidth
 * @param {number} sMaskHeight
 * @param {number} outW
 * @param {number} outH
 * @returns {Uint8Array} length outW*outH
 */
function boxDownsampleMask(sMask, sMaskWidth, sMaskHeight, outW, outH) {
  const out = new Uint8Array(outW * outH);
  for (let oy = 0; oy < outH; oy++) {
    const sy0 = Math.floor((oy * sMaskHeight) / outH);
    const sy1 = Math.max(sy0 + 1, Math.floor(((oy + 1) * sMaskHeight) / outH));
    for (let ox = 0; ox < outW; ox++) {
      const sx0 = Math.floor((ox * sMaskWidth) / outW);
      const sx1 = Math.max(sx0 + 1, Math.floor(((ox + 1) * sMaskWidth) / outW));
      let sum = 0;
      let cnt = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        const row = sy * sMaskWidth;
        for (let sx = sx0; sx < sx1; sx++) { sum += sMask[row + sx]; cnt++; }
      }
      out[oy * outW + ox] = ((sum / cnt) + 0.5) | 0;
    }
  }
  return out;
}

/**
 * Box-average an RGBA buffer down to outW x outH (straight alpha).
 * Used to shrink a very large decoded image to the device draw size before creating its ImageBitmap.
 * This optimization is critical for avoiding 10s render times on certain pages, both in browser and Node.js.
 *
 * @param {Uint8ClampedArray} rgba
 * @param {number} width
 * @param {number} height
 * @param {number} outW
 * @param {number} outH
 * @returns {Uint8ClampedArray} length outW*outH*4
 */
function boxDownsampleRgba(rgba, width, height, outW, outH) {
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let oy = 0; oy < outH; oy++) {
    const sy0 = Math.floor((oy * height) / outH);
    const sy1 = Math.max(sy0 + 1, Math.floor(((oy + 1) * height) / outH));
    for (let ox = 0; ox < outW; ox++) {
      const sx0 = Math.floor((ox * width) / outW);
      const sx1 = Math.max(sx0 + 1, Math.floor(((ox + 1) * width) / outW));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let cnt = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        const row = sy * width;
        for (let sx = sx0; sx < sx1; sx++) {
          const si = (row + sx) * 4;
          r += rgba[si];
          g += rgba[si + 1];
          b += rgba[si + 2];
          a += rgba[si + 3];
          cnt++;
        }
      }
      const di = (oy * outW + ox) * 4;
      out[di] = ((r / cnt) + 0.5) | 0;
      out[di + 1] = ((g / cnt) + 0.5) | 0;
      out[di + 2] = ((b / cnt) + 0.5) | 0;
      out[di + 3] = ((a / cnt) + 0.5) | 0;
    }
  }
  return out;
}

/**
 * Convert decoded image bytes to an ImageBitmap suitable for canvas drawing.
 * `maxW`/`maxH` are the device px the image will be drawn within (0 = unbounded)
 * and cap JPEG2000 decode resolution.
 *
 * @param {import('./parsePdfImages.js').ImageInfo} imageInfo
 * @param {ObjectCache} [objCache]
 * @param {number} [maxW]
 * @param {number} [maxH]
 */
async function imageInfoToBitmap(imageInfo, objCache, maxW = 0, maxH = 0) {
  if (imageInfo.imageData == null && objCache && imageInfo.objNum != null) {
    imageInfo.imageData = objCache.getStreamBytes(imageInfo.objNum);
  }
  let {
    width, height, bitsPerComponent, colorSpace, filter, imageData, sMask, sMaskWidth, sMaskHeight,
    decodeInvert, colorKeyMask,
  } = imageInfo;

  // If imageData is null (corrupted/truncated stream), skip this image
  if (imageData == null) return null;

  if (sMask && sMaskWidth && sMaskHeight) {
    sMask = await decodeSmaskJpeg(sMask);
    // A /Decode [1 0] on a DCTDecode/JPXDecode SMask is applied here, after decode,
    // because inverting the compressed codestream at parse time would corrupt it.
    if (imageInfo.sMaskDecodeInvert) {
      for (let i = 0; i < sMask.length; i++) sMask[i] = 255 - sMask[i];
    }
  }

  // DCTDecode (JPEG) — imageData is the raw JPEG file, create bitmap directly
  if (filter === 'DCTDecode') {
    // DeviceCMYK JPEG: Chrome's createImageBitmap produces wrong colors for 4-component CMYK/YCCK JPEGs.
    // Use our JS decoder to get correct RGB output.
    if (colorSpace === 'DeviceCMYK') {
      const jpegBytes = imageData instanceof Uint8Array ? imageData : new Uint8Array(imageData);
      const cmykResult = decodeCMYKJpegToRGB(jpegBytes, decodeInvert);
      if (cmykResult) {
        const { width: w, height: h, rgbData } = cmykResult;
        const canvas = ca.makeCanvas(w, h);
        const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
        const imgData = new ImageData(new Uint8ClampedArray(rgbData.buffer, rgbData.byteOffset, rgbData.byteLength), w, h);
        if (sMask && sMaskWidth && sMaskHeight) {
          const px = imgData.data;
          for (let j = 0; j < w * h; j++) {
            const sx = Math.min(Math.floor((j % w) * sMaskWidth / w), sMaskWidth - 1);
            const sy = Math.min(Math.floor(Math.floor(j / w) * sMaskHeight / h), sMaskHeight - 1);
            px[j * 4 + 3] = sMask[sy * sMaskWidth + sx];
          }
        }
        ctx.putImageData(imgData, 0, 0);
        return ca.createImageBitmapFromCanvas(canvas);
      }
      // Fallback to browser decoder if JS decoder fails
    }

    // Photoshop-encoded Lab JPEGs carry an Adobe APP14 marker with
    // transform=YCbCr, so the browser decoder applies YCbCr→RGB.
    // Its RGB output is the L*a*b* sample data.
    if (colorSpace === 'Lab') {
      let jpegBytes = imageData instanceof Uint8Array ? imageData : new Uint8Array(imageData);
      if (jpegBytes.length >= 2 && !(jpegBytes[jpegBytes.length - 2] === 0xFF && jpegBytes[jpegBytes.length - 1] === 0xD9)) {
        const f = new Uint8Array(jpegBytes.length + 2);
        f.set(jpegBytes);
        f[jpegBytes.length] = 0xFF;
        f[jpegBytes.length + 1] = 0xD9;
        jpegBytes = f;
      }
      try {
        const labBitmap = await ca.createImageBitmapFromData(stripJpegExif(jpegBytes));
        const w = labBitmap.width;
        const h = labBitmap.height;
        const tmp = ca.makeCanvas(w, h);
        const tctx = /** @type {OffscreenCanvasRenderingContext2D} */ (tmp.getContext('2d', { willReadFrequently: true }));
        tctx.drawImage(labBitmap, 0, 0);
        const labPixels = tctx.getImageData(0, 0, w, h).data;
        const labBytes = new Uint8Array(w * h * 3);
        for (let j = 0; j < w * h; j++) {
          labBytes[j * 3] = labPixels[j * 4];
          labBytes[j * 3 + 1] = labPixels[j * 4 + 1];
          labBytes[j * 3 + 2] = labPixels[j * 4 + 2];
        }
        const { labBytesToRGBA } = await import('./codecs/decodeJPEG.js');
        const wp = imageInfo.labWhitePoint || [0.9642, 1.0, 0.8249];
        const range = imageInfo.labRange || [-100, 100, -100, 100];
        const rgba = labBytesToRGBA(labBytes, w, h, wp, range);
        const out = ca.makeCanvas(w, h);
        const octx = /** @type {OffscreenCanvasRenderingContext2D} */ (out.getContext('2d', { willReadFrequently: true }));
        octx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), w, h), 0, 0);
        return ca.createImageBitmapFromCanvas(out);
      } catch { /* fall through */ }
    }

    // Some PDFs contain JPEGs missing the EOI (End-Of-Image) marker (FF D9).
    // Chrome's createImageBitmap rejects these, so append EOI if missing.
    let jpegData = imageData instanceof Uint8Array ? imageData : new Uint8Array(imageData);
    if (jpegData.length >= 2 && !(jpegData[jpegData.length - 2] === 0xFF && jpegData[jpegData.length - 1] === 0xD9)) {
      const fixed = new Uint8Array(jpegData.length + 2);
      fixed.set(jpegData);
      fixed[jpegData.length] = 0xFF;
      fixed[jpegData.length + 1] = 0xD9;
      jpegData = fixed;
    }
    // Strip EXIF APP1 marker to prevent browser from applying EXIF orientation.
    // The PDF CTM already handles correct image placement; EXIF rotation would be applied twice.
    jpegData = stripJpegExif(jpegData);
    let jpegBitmap;
    try {
      jpegBitmap = await ca.createImageBitmapFromData(jpegData);
    } catch {
      // Corrupted JPEG (e.g., bogus Huffman tables in encrypted PDFs) — fill with black
      // (matching mupdf's behavior of zero-filling undecodable image data) so rendering
      // can continue without crashing.
      const w = width || 1;
      const h = height || 1;
      const blackPixels = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        blackPixels[i * 4 + 3] = 255; // alpha = opaque, RGB = 0 (black)
      }
      return ca.createImageBitmapFromImageData(new ImageData(blackPixels, w, h));
    }

    // Separation color space (including single-colorant DeviceN): pixel values represent ink amounts
    // (0=no ink, 255=full ink), but the browser decodes them as luminance (0=black, 255=white).
    // Apply tint transform samples if available, otherwise invert via compositing.
    if (colorSpace === 'Separation') {
      const w = jpegBitmap.width;
      const h = jpegBitmap.height;
      const canvas = ca.makeCanvas(w, h);
      const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
      ctx.drawImage(jpegBitmap, 0, 0);
      ca.closeDrawable(jpegBitmap);

      const tintSamples = imageInfo.separationTintSamples;
      if (tintSamples && tintSamples.length >= 3) {
        const nSamples = Math.floor(tintSamples.length / 3);
        const imgData = ctx.getImageData(0, 0, w, h);
        const px = imgData.data;
        for (let i = 0; i < px.length; i += 4) {
          // Raw tint value: 0=no ink, 255=full ink.
          // /Decode [1 0] inverts the mapping (byte 0 = full ink), so invert before lookup.
          const tint = decodeInvert ? (255 - px[i]) : px[i];
          const [r, g, b] = interpolateTint(tintSamples, nSamples, tint);
          px[i] = r;
          px[i + 1] = g;
          px[i + 2] = b;
        }
        ctx.putImageData(imgData, 0, 0);

      // No tint transform available — simple inversion.
      // With decodeInvert, the /Decode [1 0] and ink conventions cancel out, so skip inversion.
      } else if (!decodeInvert) {
        ctx.globalCompositeOperation = 'difference';
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, w, h);
      }
      // Apply soft mask if present
      if (sMask && sMaskWidth && sMaskHeight) {
        const imgData2 = ctx.getImageData(0, 0, w, h);
        const px2 = imgData2.data;
        for (let j = 0; j < w * h; j++) {
          const sx = Math.min(Math.floor((j % w) * sMaskWidth / w), sMaskWidth - 1);
          const sy = Math.min(Math.floor(Math.floor(j / w) * sMaskHeight / h), sMaskHeight - 1);
          px2[j * 4 + 3] = sMask[sy * sMaskWidth + sx];
        }
        ctx.putImageData(imgData2, 0, 0);
      }
      return ca.createImageBitmapFromCanvas(canvas);
    }

    // Indexed color space JPEG: a single-component DCTDecode whose decoded samples are palette indices.
    // The base is /DeviceCMYK, /DeviceRGB, or /DeviceGray.
    // The browser decodes the grayscale JPEG to raw index values (R=G=B=index),
    // so map each index through the palette, like the uncompressed Indexed path
    // later in this function (the one reached when there is no image codec).
    if (colorSpace === 'Indexed' && imageInfo.palette) {
      const w = jpegBitmap.width;
      const h = jpegBitmap.height;
      const canvas = ca.makeCanvas(w, h);
      const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
      ctx.drawImage(jpegBitmap, 0, 0);
      ca.closeDrawable(jpegBitmap);

      const palette = imageInfo.palette;
      const base = imageInfo.paletteBase || 'DeviceRGB';
      const nComp = base === 'DeviceCMYK' ? 4 : (base === 'DeviceGray' || base === 'CalGray' ? 1 : 3);
      const imgData = ctx.getImageData(0, 0, w, h);
      const px = imgData.data;
      for (let i = 0; i < px.length; i += 4) {
        const po = px[i] * nComp;
        if (nComp === 4) {
          const [r, g, b] = cmykToRgb(palette[po] / 255, palette[po + 1] / 255, palette[po + 2] / 255, palette[po + 3] / 255);
          px[i] = r;
          px[i + 1] = g;
          px[i + 2] = b;
        } else if (nComp === 1) {
          px[i] = palette[po];
          px[i + 1] = palette[po];
          px[i + 2] = palette[po];
        } else {
          px[i] = palette[po];
          px[i + 1] = palette[po + 1];
          px[i + 2] = palette[po + 2];
        }
      }
      ctx.putImageData(imgData, 0, 0);

      // Apply soft mask if present
      if (sMask && sMaskWidth && sMaskHeight) {
        const imgData2 = ctx.getImageData(0, 0, w, h);
        const px2 = imgData2.data;
        for (let j = 0; j < w * h; j++) {
          const sx = Math.min(Math.floor((j % w) * sMaskWidth / w), sMaskWidth - 1);
          const sy = Math.min(Math.floor(Math.floor(j / w) * sMaskHeight / h), sMaskHeight - 1);
          px2[j * 4 + 3] = sMask[sy * sMaskWidth + sx];
        }
        ctx.putImageData(imgData2, 0, 0);
      }
      return ca.createImageBitmapFromCanvas(canvas);
    }

    // /Decode [1 0 ...] inversion for JPEG: invert decoded pixel values via compositing
    if (decodeInvert) {
      const w = jpegBitmap.width;
      const h = jpegBitmap.height;
      const canvas = ca.makeCanvas(w, h);
      const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
      ctx.drawImage(jpegBitmap, 0, 0);
      ca.closeDrawable(jpegBitmap);
      ctx.globalCompositeOperation = 'difference';
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, w, h);
      const invertedBitmap = await ca.createImageBitmapFromCanvas(canvas);

      // Apply soft mask if present
      if (sMask && sMaskWidth && sMaskHeight) {
        const canvas2 = ca.makeCanvas(w, h);
        const ctx2 = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas2.getContext('2d', { willReadFrequently: true }));
        ctx2.drawImage(invertedBitmap, 0, 0);
        ca.closeDrawable(invertedBitmap);
        const imgData = ctx2.getImageData(0, 0, w, h);
        const px = imgData.data;
        for (let i = 0; i < w * h; i++) {
          const sx = Math.min(Math.floor((i % w) * sMaskWidth / w), sMaskWidth - 1);
          const sy = Math.min(Math.floor(Math.floor(i / w) * sMaskHeight / h), sMaskHeight - 1);
          px[i * 4 + 3] = sMask[sy * sMaskWidth + sx];
        }
        ctx2.putImageData(imgData, 0, 0);
        return ca.createImageBitmapFromCanvas(canvas2);
      }
      return invertedBitmap;
    }

    // Apply soft mask (SMask) or stencil mask alpha channel if present
    if (sMask && sMaskWidth && sMaskHeight) {
      const w = jpegBitmap.width;
      const h = jpegBitmap.height;
      if (sMaskWidth === w && sMaskHeight === h) {
        // Mask matches image dimensions — apply directly
        const canvas = ca.makeCanvas(w, h);
        const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
        ctx.drawImage(jpegBitmap, 0, 0);
        ca.closeDrawable(jpegBitmap);
        const imgData = ctx.getImageData(0, 0, w, h);
        const px = imgData.data;
        for (let i = 0; i < w * h; i++) {
          px[i * 4 + 3] = sMask[i];
        }
        ctx.putImageData(imgData, 0, 0);
        return ca.createImageBitmapFromCanvas(canvas);
      }
      if (sMaskWidth > w || sMaskHeight > h) {
        // Mask is higher resolution: upsample the image to the mask dimensions, but never beyond the device area this image occupies (maxW/maxH).
        let outW = sMaskWidth;
        let outH = sMaskHeight;
        if (maxW && maxH && (outW > maxW || outH > maxH)) {
          const k = Math.min(maxW / outW, maxH / outH);
          outW = Math.max(w, Math.round(sMaskWidth * k));
          outH = Math.max(h, Math.round(sMaskHeight * k));
        }
        const canvas = ca.makeCanvas(w, h);
        const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
        ctx.drawImage(jpegBitmap, 0, 0);
        ca.closeDrawable(jpegBitmap);
        const imgData = ctx.getImageData(0, 0, w, h);
        const px = imgData.data;
        const maskA = boxDownsampleMask(sMask, sMaskWidth, sMaskHeight, outW, outH);
        const upsampled = new Uint8ClampedArray(outW * outH * 4);
        for (let y = 0; y < outH; y++) {
          const srcY = Math.min(Math.floor(y * h / outH), h - 1);
          for (let x = 0; x < outW; x++) {
            const srcX = Math.min(Math.floor(x * w / outW), w - 1);
            const dstIdx = (y * outW + x) * 4;
            const srcIdx = (srcY * w + srcX) * 4;
            upsampled[dstIdx] = px[srcIdx];
            upsampled[dstIdx + 1] = px[srcIdx + 1];
            upsampled[dstIdx + 2] = px[srcIdx + 2];
            upsampled[dstIdx + 3] = maskA[y * outW + x];
          }
        }
        return ca.createImageBitmapFromImageData(new ImageData(upsampled, outW, outH));
      }
      // Mask is lower resolution — resample mask to image dimensions
      const canvas = ca.makeCanvas(w, h);
      const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
      ctx.drawImage(jpegBitmap, 0, 0);
      ca.closeDrawable(jpegBitmap);
      const imgData = ctx.getImageData(0, 0, w, h);
      const px = imgData.data;
      for (let y = 0; y < h; y++) {
        const srcY = Math.min(Math.floor(y * sMaskHeight / h), sMaskHeight - 1);
        for (let x = 0; x < w; x++) {
          const srcX = Math.min(Math.floor(x * sMaskWidth / w), sMaskWidth - 1);
          px[(y * w + x) * 4 + 3] = sMask[srcY * sMaskWidth + srcX];
        }
      }
      ctx.putImageData(imgData, 0, 0);
      return ca.createImageBitmapFromCanvas(canvas);
    }

    // If the JPEG's actual dimensions match the PDF's declared dimensions, use as-is.
    // Otherwise, the PDF declares a larger image than the JPEG contains;
    // create a canvas at the declared size (filled with black) and draw the JPEG at origin.
    if (jpegBitmap.width === width && jpegBitmap.height === height) {
      return jpegBitmap;
    }
    const canvas = ca.makeCanvas(width, height);
    const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
    // Canvas defaults to transparent black; fill explicitly to match mupdf behavior
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(jpegBitmap, 0, 0);
    ca.closeDrawable(jpegBitmap);
    return ca.createImageBitmapFromCanvas(canvas);
  }

  // JPXDecode (JPEG 2000) — decode via pure JS decoder
  if (filter === 'JPXDecode') {
    const { decodeJPX } = await import('./codecs/decodeJPX.js');
    // Each reduce level halves the decoded dimensions and skips entropy-decoding the finest resolution sub-bands (~4x less work per level),
    // so we want the level closest to the device size the image is actually drawn at.
    // Halve while the reduced dimensions stay >= ~0.71x (1/sqrt2) of the draw size: pick the geometrically nearest level, accepting up to ~1.41x upscale.
    let reduceLevels = 0;
    if (maxW && maxH) {
      let rw = imageInfo.width;
      let rh = imageInfo.height;
      while (reduceLevels < 5 && rw / 2 >= maxW * 0.71 && rh / 2 >= maxH * 0.71) {
        rw = Math.floor(rw / 2);
        rh = Math.floor(rh / 2);
        reduceLevels++;
      }
    }
    // A PDF /Indexed colour space (imageInfo.palette) overrides any internal JP2 palette
    // and needs the raw index samples, so skip the internal palette expansion in that case.
    const decoded = decodeJPX(imageData, reduceLevels, !imageInfo.palette);
    if (!decoded) return null;
    const w = decoded.width;
    const h = decoded.height;
    const components = decoded.components;
    const pixels = decoded.pixelData;

    // JPX may have more components than the PDF color space expects (e.g. gray+alpha=2 for DeviceGray).
    // Determine the expected color component count from the PDF color space, and use the JPX's extra
    // component as built-in alpha when present.
    const expectedComponents = (colorSpace === 'DeviceGray' || colorSpace === 'CalGray') ? 1
      : (colorSpace === 'DeviceRGB' || colorSpace === 'CalRGB') ? 3
        : (colorSpace === 'DeviceCMYK') ? 4 : 0;
    const hasJpxAlpha = expectedComponents > 0 && components === expectedComponents + 1;

    const rgbaData = new Uint8ClampedArray(w * h * 4);
    if (colorSpace === 'DeviceN' && imageInfo.deviceNTintCS
        && components === imageInfo.deviceNTintCS.nInputs) {
      const rgb = tintSamplesToRgb(imageInfo.deviceNTintCS, pixels, components, w * h);
      if (rgb) {
        for (let i = 0; i < w * h; i++) {
          rgbaData[i * 4] = rgb[i * 3];
          rgbaData[i * 4 + 1] = rgb[i * 3 + 1];
          rgbaData[i * 4 + 2] = rgb[i * 3 + 2];
          rgbaData[i * 4 + 3] = 255;
        }
      }
    } else if (components === 1 && colorSpace === 'Indexed' && imageInfo.palette) {
      // Indexed color space: each pixel value is an index into the PDF palette.
      // decodeJPX MSB-aligns each decoded sample to 8 bits (sample << (8 - precision)) as a display convenience,
      // but the palette index is the raw reconstructed sample at the component bit depth
      // (T.800 G.1.2 inverse DC level shift yields 0..2^precision-1).
      // For sub-8-bit JPX, recover the index by reversing that alignment.
      const palette = imageInfo.palette;
      const base = imageInfo.paletteBase || 'DeviceRGB';
      const nComp = base === 'DeviceCMYK' ? 4 : (base === 'DeviceGray' || base === 'CalGray' ? 1 : 3);
      const jpxPrecision = decoded.precision ? decoded.precision[0] : 8;
      const idxShift = jpxPrecision < 8 ? (8 - jpxPrecision) : 0;
      for (let i = 0; i < w * h; i++) {
        const idx = pixels[i] >> idxShift;
        const po = idx * nComp;
        const pi = i * 4;
        if (nComp === 4) {
          const [r, g, b] = cmykToRgb(palette[po] / 255, palette[po + 1] / 255, palette[po + 2] / 255, palette[po + 3] / 255);
          rgbaData[pi] = r;
          rgbaData[pi + 1] = g;
          rgbaData[pi + 2] = b;
        } else if (nComp === 1) {
          rgbaData[pi] = rgbaData[pi + 1] = rgbaData[pi + 2] = palette[po];
        } else {
          rgbaData[pi] = palette[po];
          rgbaData[pi + 1] = palette[po + 1];
          rgbaData[pi + 2] = palette[po + 2];
        }
        rgbaData[pi + 3] = 255;
      }
    } else if (components === 1 && colorSpace === 'Separation') {
      // Separation: pixel values are tint amounts (0=no ink, 255=full ink).
      // Apply tint transform if available, otherwise invert.
      const tintSamples = imageInfo.separationTintSamples;
      if (tintSamples && tintSamples.length >= 3) {
        const nSamples = Math.floor(tintSamples.length / 3);
        for (let i = 0; i < w * h; i++) {
          const tint = decodeInvert ? (255 - pixels[i]) : pixels[i];
          const [r, g, b] = interpolateTint(tintSamples, nSamples, tint);
          rgbaData[i * 4] = r;
          rgbaData[i * 4 + 1] = g;
          rgbaData[i * 4 + 2] = b;
          rgbaData[i * 4 + 3] = 255;
        }
      } else {
        for (let i = 0; i < w * h; i++) {
          const val = decodeInvert ? pixels[i] : (255 - pixels[i]);
          // eslint-disable-next-line no-multi-assign
          rgbaData[i * 4] = rgbaData[i * 4 + 1] = rgbaData[i * 4 + 2] = val;
          rgbaData[i * 4 + 3] = 255;
        }
      }
    } else if (components === 1 || (hasJpxAlpha && expectedComponents === 1)) {
      // DeviceGray (or gray+alpha from JPX)
      for (let i = 0; i < w * h; i++) {
        // eslint-disable-next-line no-multi-assign
        rgbaData[i * 4] = rgbaData[i * 4 + 1] = rgbaData[i * 4 + 2] = pixels[i * components];
        rgbaData[i * 4 + 3] = hasJpxAlpha ? pixels[i * components + 1] : 255;
      }
    } else if (colorSpace === 'Lab' && components === 3) {
      const { labBytesToRGBA } = await import('./codecs/decodeJPEG.js');
      const wp = imageInfo.labWhitePoint || [0.9505, 1.0, 1.089];
      const range = imageInfo.labRange || [-100, 100, -100, 100];
      rgbaData.set(labBytesToRGBA(pixels, w, h, wp, range));
    } else if (components === 3 || (hasJpxAlpha && expectedComponents === 3)) {
      // DeviceRGB (or RGB+alpha from JPX)
      for (let i = 0; i < w * h; i++) {
        rgbaData[i * 4] = pixels[i * components];
        rgbaData[i * 4 + 1] = pixels[i * components + 1];
        rgbaData[i * 4 + 2] = pixels[i * components + 2];
        rgbaData[i * 4 + 3] = hasJpxAlpha ? pixels[i * components + 3] : 255;
      }
    } else if (components === 4) {
      if (colorSpace === 'DeviceCMYK') {
        // CMYK pixel data: convert to RGB using SWOP polynomial approximation
        for (let i = 0; i < w * h; i++) {
          const c = decodeInvert ? (1 - pixels[i * 4] / 255) : (pixels[i * 4] / 255);
          const m = decodeInvert ? (1 - pixels[i * 4 + 1] / 255) : (pixels[i * 4 + 1] / 255);
          const y = decodeInvert ? (1 - pixels[i * 4 + 2] / 255) : (pixels[i * 4 + 2] / 255);
          const k = decodeInvert ? (1 - pixels[i * 4 + 3] / 255) : (pixels[i * 4 + 3] / 255);
          const [cr, cg, cb] = cmykToRgb(c, m, y, k);
          rgbaData[i * 4] = cr;
          rgbaData[i * 4 + 1] = cg;
          rgbaData[i * 4 + 2] = cb;
          rgbaData[i * 4 + 3] = 255;
        }
      } else {
        // Assume RGBA
        for (let i = 0; i < w * h; i++) {
          rgbaData[i * 4] = pixels[i * 4];
          rgbaData[i * 4 + 1] = pixels[i * 4 + 1];
          rgbaData[i * 4 + 2] = pixels[i * 4 + 2];
          rgbaData[i * 4 + 3] = pixels[i * 4 + 3];
        }
      }
    }

    if (sMask && sMaskWidth && sMaskHeight) {
      if (sMaskWidth === w && sMaskHeight === h) {
        for (let i = 0; i < w * h; i++) {
          rgbaData[i * 4 + 3] = sMask[i];
        }
      } else if (sMaskWidth > w || sMaskHeight > h) {
        // Mask is higher resolution than image: upsample the image to the mask dimensions to preserve fine mask detail (e.g. text stencil edges).
        // But never build the composite larger than the device area this image occupies (maxW/maxH):
        // an /SMask can be many times the image's pixel count, so producing a mask-resolution bitmap only to down-scale it at draw time is wasted work.
        let outW = sMaskWidth;
        let outH = sMaskHeight;
        if (maxW && maxH && (outW > maxW || outH > maxH)) {
          const k = Math.min(maxW / outW, maxH / outH);
          outW = Math.max(w, Math.round(sMaskWidth * k));
          outH = Math.max(h, Math.round(sMaskHeight * k));
        }
        const maskA = boxDownsampleMask(sMask, sMaskWidth, sMaskHeight, outW, outH);
        const upsampled = new Uint8ClampedArray(outW * outH * 4);
        for (let y = 0; y < outH; y++) {
          const srcY = Math.min(Math.floor(y * h / outH), h - 1);
          for (let x = 0; x < outW; x++) {
            const srcX = Math.min(Math.floor(x * w / outW), w - 1);
            const dstIdx = (y * outW + x) * 4;
            const srcIdx = (srcY * w + srcX) * 4;
            upsampled[dstIdx] = rgbaData[srcIdx];
            upsampled[dstIdx + 1] = rgbaData[srcIdx + 1];
            upsampled[dstIdx + 2] = rgbaData[srcIdx + 2];
            upsampled[dstIdx + 3] = maskA[y * outW + x];
          }
        }
        return ca.createImageBitmapFromImageData(new ImageData(upsampled, outW, outH));
      } else {
        // Mask is lower resolution than image — resample mask to image dimensions
        for (let y = 0; y < h; y++) {
          const srcY = Math.min(Math.floor(y * sMaskHeight / h), sMaskHeight - 1);
          for (let x = 0; x < w; x++) {
            const srcX = Math.min(Math.floor(x * sMaskWidth / w), sMaskWidth - 1);
            rgbaData[(y * w + x) * 4 + 3] = sMask[srcY * sMaskWidth + srcX];
          }
        }
      }
    }

    return ca.createImageBitmapFromImageData(new ImageData(rgbaData, w, h));
  }

  // For all other cases (FlateDecode, CCITTFaxDecode, no filter),
  // imageData is raw decoded pixel bytes. Build RGBA ImageData.
  let rgbaData;

  // 16-bit per component: downscale to 8-bit by taking the high byte of each sample.
  // PDF stores 16-bit values as big-endian, so bytes [0]=high, [1]=low for each sample.
  if (bitsPerComponent === 16) {
    const sampleCount = imageData.length / 2;
    const data8 = new Uint8Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      data8[i] = imageData[i * 2];
    }
    imageData = data8;
    bitsPerComponent = 8;
  }

  // Fast path for very large 1-bit grayscale scans (JBIG2/CCITTFax): box-average the packed bits straight to the device draw size.
  // The general path's cost is dominated not by the final draw but by building a full-resolution RGBA buffer and then creating an ImageBitmap from it.
  // Averaging the 1-bit source directly into a draw-size RGBA is one pass over 8x less memory and skips both the giant allocation and the large-bitmap upload.
  // A 1-bit soft mask at the same resolution (the MRC foreground/background pairing) is area-averaged into alpha in the same pass.
  // Restricted to plain DeviceGray/CalGray with no transparent-white key, colour-key mask, or ICC transform, so no downstream per-pixel post-processing is bypassed.
  const mask11 = sMask && sMaskWidth === width && sMaskHeight === height;
  if (bitsPerComponent === 1 && (colorSpace === 'DeviceGray' || colorSpace === 'CalGray')
    && !imageInfo.transparentWhite && (!(sMask && sMaskWidth && sMaskHeight) || mask11)
    && !colorKeyMask && !imageInfo.iccTransform
    && maxW && maxH && (width > maxW || height > maxH) && width * height >= 40e6) {
    const k = Math.min(maxW / width, maxH / height);
    const outW = Math.max(1, Math.round(width * k));
    const outH = Math.max(1, Math.round(height * k));
    if (width * height >= outW * outH * 2) {
      const rowBytes = Math.ceil(width / 8);
      const ma = mask11 ? sMask : null;
      const out = new Uint8ClampedArray(outW * outH * 4);
      for (let oy = 0; oy < outH; oy++) {
        const sy0 = Math.floor((oy * height) / outH);
        const sy1 = Math.max(sy0 + 1, Math.floor(((oy + 1) * height) / outH));
        for (let ox = 0; ox < outW; ox++) {
          const sx0 = Math.floor((ox * width) / outW);
          const sx1 = Math.max(sx0 + 1, Math.floor(((ox + 1) * width) / outW));
          let sum = 0;
          let asum = 0;
          let cnt = 0;
          for (let sy = sy0; sy < sy1; sy++) {
            const rb = sy * rowBytes;
            const mrow = sy * width;
            for (let sx = sx0; sx < sx1; sx++) {
              sum += (imageData[rb + (sx >> 3)] >> (7 - (sx & 7))) & 1;
              if (ma) asum += ma[mrow + sx];
              cnt++;
            }
          }
          // 1-bit DeviceGray: bit 1 = white (255), bit 0 = black; /Decode [1 0] inverts.
          let v = (((sum / cnt) * 255) + 0.5) | 0;
          if (decodeInvert) v = 255 - v;
          const di = (oy * outW + ox) * 4;
          out[di] = v;
          out[di + 1] = v;
          out[di + 2] = v;
          out[di + 3] = ma ? (((asum / cnt) + 0.5) | 0) : 255;
        }
      }
      return ca.createImageBitmapFromImageData(new ImageData(out, outW, outH));
    }
  }

  if (colorSpace === 'Indexed' && imageInfo.palette) {
    const palette = imageInfo.palette;
    const base = imageInfo.paletteBase || 'DeviceRGB';
    const nComp = base === 'DeviceCMYK' ? 4 : (base === 'DeviceGray' || base === 'CalGray' ? 1 : 3);
    const hival = imageInfo.paletteHival != null ? imageInfo.paletteHival : ((1 << bitsPerComponent) - 1);
    rgbaData = new Uint8ClampedArray(width * height * 4);
    const rowBytes = Math.ceil(width * bitsPerComponent / 8);
    // imageData can be short of width*height (truncated FlateDecode tail).
    // Out-of-range reads return undefined, and palette[NaN]=0 then paints
    // those pixels solid black, so cap iteration to leave the tail transparent.
    const maxBytes = imageData ? imageData.length : 0;
    const validRows = rowBytes > 0 ? Math.min(height, Math.floor(maxBytes / rowBytes)) : height;

    for (let y = 0; y < validRows; y++) {
      for (let x = 0; x < width; x++) {
        let idx;
        if (bitsPerComponent === 8) {
          idx = imageData[y * rowBytes + x];
        } else if (bitsPerComponent === 4) {
          const bytePos = y * rowBytes + Math.floor(x / 2);
          idx = (x % 2 === 0) ? (imageData[bytePos] >> 4) & 0xF : imageData[bytePos] & 0xF;
        } else if (bitsPerComponent === 2) {
          const bytePos = y * rowBytes + Math.floor(x / 4);
          idx = (imageData[bytePos] >> (6 - (x % 4) * 2)) & 0x3;
        } else {
          const bytePos = y * rowBytes + Math.floor(x / 8);
          idx = (imageData[bytePos] >> (7 - (x % 8))) & 1;
        }
        // /Decode [max 0] inverts the index mapping for Indexed color spaces
        if (decodeInvert) idx = hival - idx;

        const pi = (y * width + x) * 4;
        const po = idx * nComp;
        if (nComp === 3) {
          rgbaData[pi] = palette[po];
          rgbaData[pi + 1] = palette[po + 1];
          rgbaData[pi + 2] = palette[po + 2];
          rgbaData[pi + 3] = 255;
        } else if (nComp === 1) {
          rgbaData[pi] = rgbaData[pi + 1] = rgbaData[pi + 2] = palette[po];
          rgbaData[pi + 3] = 255;
        } else if (nComp === 4) {
          const [r, g, b] = cmykToRgb(palette[po] / 255, palette[po + 1] / 255, palette[po + 2] / 255, palette[po + 3] / 255);
          rgbaData[pi] = r;
          rgbaData[pi + 1] = g;
          rgbaData[pi + 2] = b;
          rgbaData[pi + 3] = 255;
        }
      }
    }
  } else if (bitsPerComponent === 1) {
    // 1-bit monochrome — each byte contains 8 pixels, MSB first
    // For DeviceGray: 0=black, 1=white (unless BlackIs1 was set during decoding, which inverts)
    // For Separation: 0=no ink (white), 1=full ink (black) — opposite of DeviceGray
    const isSeparation = colorSpace === 'Separation';
    const tintSamples = isSeparation ? imageInfo.separationTintSamples : null;
    rgbaData = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      const rowByteWidth = Math.ceil(width / 8);
      for (let x = 0; x < width; x++) {
        const byteIndex = y * rowByteWidth + Math.floor(x / 8);
        const bitIndex = 7 - (x % 8);
        const rawBit = (imageData[byteIndex] >> bitIndex) & 1;
        // In standard PDF: 0 = black, 1 = white for DeviceGray with 1bpc
        // /Decode [1 0] inverts: 0 = white, 1 = black
        const bit = decodeInvert ? (1 - rawBit) : rawBit;
        const pi = (y * width + x) * 4;
        if (isSeparation && tintSamples && tintSamples.length >= 3) {
          // Use tint transform: bit 0=no ink (tint index 0), bit 1=full ink (last tint index)
          const nSamples = Math.floor(tintSamples.length / 3);
          const si = (bit === 0 ? 0 : nSamples - 1) * 3;
          rgbaData[pi] = tintSamples[si];
          rgbaData[pi + 1] = tintSamples[si + 1];
          rgbaData[pi + 2] = tintSamples[si + 2];
          rgbaData[pi + 3] = 255;
        } else if (isSeparation) {
          // Separation without tint samples: 0=no ink (white), 1=full ink (black)
          const val = (1 - bit) * 255;
          rgbaData[pi] = val;
          rgbaData[pi + 1] = val;
          rgbaData[pi + 2] = val;
          rgbaData[pi + 3] = 255;
        } else {
          const val = bit * 255;
          rgbaData[pi] = val;
          rgbaData[pi + 1] = val;
          rgbaData[pi + 2] = val;
          // Inline images inside a tiling pattern paint white as transparent
          // so the pattern shows through. transparentWhite carries that intent from the caller.
          rgbaData[pi + 3] = (imageInfo.transparentWhite && val === 255) ? 0 : 255;
        }
      }
    }
  } else if (colorSpace === 'DeviceGray' || colorSpace === 'CalGray') {
    // Grayscale
    rgbaData = new Uint8ClampedArray(width * height * 4);
    if (bitsPerComponent === 4) {
      const rowBytes = Math.ceil(width / 2);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const bytePos = y * rowBytes + (x >> 1);
          const nibble = (x & 1) === 0 ? (imageData[bytePos] >> 4) & 0xF : imageData[bytePos] & 0xF;
          const raw = nibble * 17; // scale 0-15 to 0-255
          const val = decodeInvert ? (255 - raw) : raw;
          const pi = (y * width + x) * 4;
          rgbaData[pi] = val;
          rgbaData[pi + 1] = val;
          rgbaData[pi + 2] = val;
          rgbaData[pi + 3] = 255;
        }
      }
    } else if (bitsPerComponent === 2) {
      const rowBytes = Math.ceil(width / 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const bytePos = y * rowBytes + (x >> 2);
          const sample = (imageData[bytePos] >> (6 - (x & 3) * 2)) & 0x3;
          const raw = sample * 85; // scale 0-3 to 0-255
          const val = decodeInvert ? (255 - raw) : raw;
          const pi = (y * width + x) * 4;
          rgbaData[pi] = val;
          rgbaData[pi + 1] = val;
          rgbaData[pi + 2] = val;
          rgbaData[pi + 3] = 255;
        }
      }
    } else {
      for (let i = 0; i < width * height; i++) {
        const val = decodeInvert ? (255 - imageData[i]) : imageData[i];
        rgbaData[i * 4] = val;
        rgbaData[i * 4 + 1] = val;
        rgbaData[i * 4 + 2] = val;
        rgbaData[i * 4 + 3] = 255;
      }
    }
  } else if (colorSpace === 'DeviceCMYK') {
    rgbaData = new Uint8ClampedArray(width * height * 4);
    if (bitsPerComponent === 8) {
      for (let i = 0; i < width * height; i++) {
        const c = decodeInvert ? (1 - imageData[i * 4] / 255) : (imageData[i * 4] / 255);
        const m = decodeInvert ? (1 - imageData[i * 4 + 1] / 255) : (imageData[i * 4 + 1] / 255);
        const y = decodeInvert ? (1 - imageData[i * 4 + 2] / 255) : (imageData[i * 4 + 2] / 255);
        const k = decodeInvert ? (1 - imageData[i * 4 + 3] / 255) : (imageData[i * 4 + 3] / 255);
        const [r, g, b] = cmykToRgb(c, m, y, k);
        rgbaData[i * 4] = r;
        rgbaData[i * 4 + 1] = g;
        rgbaData[i * 4 + 2] = b;
        rgbaData[i * 4 + 3] = 255;
      }
    } else {
      const rowBytes = Math.ceil(width * 4 * bitsPerComponent / 8);
      const compMax = (1 << bitsPerComponent) - 1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const comps = [0, 0, 0, 0];
          for (let cc = 0; cc < 4; cc++) {
            const bitOff = (x * 4 + cc) * bitsPerComponent;
            const byteIdx = y * rowBytes + (bitOff >> 3);
            const shift = 8 - (bitOff & 7) - bitsPerComponent;
            comps[cc] = (imageData[byteIdx] >> shift) & compMax;
          }
          const cN = decodeInvert ? (1 - comps[0] / compMax) : (comps[0] / compMax);
          const mN = decodeInvert ? (1 - comps[1] / compMax) : (comps[1] / compMax);
          const yN = decodeInvert ? (1 - comps[2] / compMax) : (comps[2] / compMax);
          const kN = decodeInvert ? (1 - comps[3] / compMax) : (comps[3] / compMax);
          const [r, g, b] = cmykToRgb(cN, mN, yN, kN);
          const pi = (y * width + x) * 4;
          rgbaData[pi] = r;
          rgbaData[pi + 1] = g;
          rgbaData[pi + 2] = b;
          rgbaData[pi + 3] = 255;
        }
      }
    }
  } else if (colorSpace === 'Separation') {
    // Separation color space (including single-colorant DeviceN): pixel values are tint amounts
    // (0=no ink/white, 255=full ink). Apply tint transform if available, otherwise invert.
    rgbaData = new Uint8ClampedArray(width * height * 4);
    const tintSamples = imageInfo.separationTintSamples;
    const readTint = (i) => {
      if (bitsPerComponent === 8) return imageData[i];
      if (bitsPerComponent === 4) {
        const rowBytes = Math.ceil(width / 2);
        const x = i % width;
        const y = Math.floor(i / width);
        const byte = imageData[y * rowBytes + (x >> 1)];
        const nibble = (x & 1) === 0 ? (byte >> 4) & 0xF : byte & 0xF;
        return nibble * 17;
      }
      if (bitsPerComponent === 2) {
        const rowBytes = Math.ceil(width / 4);
        const x = i % width;
        const y = Math.floor(i / width);
        const byte = imageData[y * rowBytes + (x >> 2)];
        const sample = (byte >> (6 - (x & 3) * 2)) & 0x3;
        return sample * 85;
      }
      if (bitsPerComponent === 1) {
        const rowBytes = Math.ceil(width / 8);
        const x = i % width;
        const y = Math.floor(i / width);
        const byte = imageData[y * rowBytes + (x >> 3)];
        return ((byte >> (7 - (x & 7))) & 1) ? 255 : 0;
      }
      return imageData[i];
    };
    if (tintSamples && tintSamples.length >= 3) {
      const nSamples = Math.floor(tintSamples.length / 3);
      for (let i = 0; i < width * height; i++) {
        const raw = readTint(i);
        const tint = decodeInvert ? (255 - raw) : raw;
        const [r, g, b] = interpolateTint(tintSamples, nSamples, tint);
        rgbaData[i * 4] = r;
        rgbaData[i * 4 + 1] = g;
        rgbaData[i * 4 + 2] = b;
        rgbaData[i * 4 + 3] = 255;
      }
    } else {
      // No sampled tint transform — invert (0=white, 255=black) for typical ink separation.
      // With decodeInvert, /Decode [1 0] and ink conventions cancel out.
      for (let i = 0; i < width * height; i++) {
        const raw = readTint(i);
        const val = decodeInvert ? raw : (255 - raw);
        rgbaData[i * 4] = val;
        rgbaData[i * 4 + 1] = val;
        rgbaData[i * 4 + 2] = val;
        rgbaData[i * 4 + 3] = 255;
      }
    }
  } else if ((colorSpace === 'DeviceRGB' || colorSpace === 'CalRGB') && (bitsPerComponent === 4 || bitsPerComponent === 2)) {
    // DeviceRGB with sub-byte components: each component is `bitsPerComponent` bits,
    // packed MSB-first across the row, with each row padded to a byte boundary.
    rgbaData = new Uint8ClampedArray(width * height * 4);
    const rowBytes = Math.ceil(width * 3 * bitsPerComponent / 8);
    const compMax = (1 << bitsPerComponent) - 1;
    const scale = 255 / compMax;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const comps = [0, 0, 0];
        for (let c = 0; c < 3; c++) {
          const bitOff = (x * 3 + c) * bitsPerComponent;
          const byteIdx = y * rowBytes + (bitOff >> 3);
          const shift = 8 - (bitOff & 7) - bitsPerComponent;
          comps[c] = (imageData[byteIdx] >> shift) & compMax;
        }
        const r = decodeInvert ? compMax - comps[0] : comps[0];
        const g = decodeInvert ? compMax - comps[1] : comps[1];
        const b = decodeInvert ? compMax - comps[2] : comps[2];
        const pi = (y * width + x) * 4;
        rgbaData[pi] = Math.round(r * scale);
        rgbaData[pi + 1] = Math.round(g * scale);
        rgbaData[pi + 2] = Math.round(b * scale);
        rgbaData[pi + 3] = 255;
      }
    }
  } else if (colorSpace === 'Lab') {
    const wp = imageInfo.labWhitePoint || [0.9505, 1.0, 1.089];
    const range = imageInfo.labRange || [-100, 100, -100, 100];
    const { labBytesToRGBA } = await import('./codecs/decodeJPEG.js');
    rgbaData = new Uint8ClampedArray(labBytesToRGBA(imageData, width, height, wp, range).buffer);
  } else if (colorSpace === 'DeviceN' && imageInfo.deviceNTintCS) {
    // Multi-colorant DeviceN raster: map each pixel's colorant tuple to RGB through the tint transform.
    // Done here rather than at parse time so a shared Resources dict listing many DeviceN images
    // only pays the conversion for the ones a page actually draws.
    const nComp = imageInfo.deviceNTintCS.nInputs;
    rgbaData = new Uint8ClampedArray(width * height * 4);
    const rgb = tintSamplesToRgb(imageInfo.deviceNTintCS, imageData, nComp, width * height);
    if (rgb) {
      for (let i = 0; i < width * height; i++) {
        rgbaData[i * 4] = rgb[i * 3];
        rgbaData[i * 4 + 1] = rgb[i * 3 + 1];
        rgbaData[i * 4 + 2] = rgb[i * 3 + 2];
        rgbaData[i * 4 + 3] = 255;
      }
    }
  } else {
    // Default: DeviceRGB / ICCBased / DeviceN
    // Use known component counts for named color spaces. Data-length inference is a
    // fallback only — it can be wrong when the PNG predictor uses sub-byte BPC that
    // causes fractional-byte row padding, making decoded data slightly shorter than
    // width*height*components.
    let components;
    if (colorSpace === 'DeviceRGB' || colorSpace === 'CalRGB' || colorSpace === 'ICCBased') {
      components = 3;
    } else {
      components = Math.round(imageData.length / (width * height)) || 3;
    }
    rgbaData = new Uint8ClampedArray(width * height * 4);
    if (components === 1) {
      for (let i = 0; i < width * height; i++) {
        const val = decodeInvert ? (255 - imageData[i]) : imageData[i];
        rgbaData[i * 4] = val;
        rgbaData[i * 4 + 1] = val;
        rgbaData[i * 4 + 2] = val;
        rgbaData[i * 4 + 3] = 255;
      }
    } else if (components === 4) {
      for (let i = 0; i < width * height; i++) {
        rgbaData[i * 4] = decodeInvert ? (255 - imageData[i * 4]) : imageData[i * 4];
        rgbaData[i * 4 + 1] = decodeInvert ? (255 - imageData[i * 4 + 1]) : imageData[i * 4 + 1];
        rgbaData[i * 4 + 2] = decodeInvert ? (255 - imageData[i * 4 + 2]) : imageData[i * 4 + 2];
        rgbaData[i * 4 + 3] = imageData[i * 4 + 3];
      }
    } else {
      for (let i = 0; i < width * height; i++) {
        rgbaData[i * 4] = decodeInvert ? (255 - imageData[i * components]) : imageData[i * components];
        rgbaData[i * 4 + 1] = decodeInvert ? (255 - imageData[i * components + 1]) : imageData[i * components + 1];
        rgbaData[i * 4 + 2] = decodeInvert ? (255 - imageData[i * components + 2]) : imageData[i * components + 2];
        rgbaData[i * 4 + 3] = 255;
      }
    }
  }

  // Apply ICC profile color transform if present (converts profile RGB → sRGB).
  // The transform linearizes using the profile's gamma, applies the profile's
  // RGB→XYZ matrix, then converts XYZ to sRGB with standard sRGB primaries.
  if (imageInfo.iccTransform && rgbaData) {
    const { gamma, matrix: m } = imageInfo.iccTransform;
    // Precompute linearization LUTs (gamma curves) for each channel
    const lut = gamma.map((g) => {
      const t = new Float32Array(256);
      for (let v = 0; v < 256; v++) t[v] = (v / 255) ** g;
      return t;
    });
    const xyzToSrgb = [
      3.1338561, -1.6168667, -0.4906146,
      -0.9787684, 1.9161415, 0.0334540,
      0.0719453, -0.2289914, 1.4052427,
    ];
    const n = width * height;
    for (let i = 0; i < n; i++) {
      const off = i * 4;
      const lr = lut[0][rgbaData[off]];
      const lg = lut[1][rgbaData[off + 1]];
      const lb = lut[2][rgbaData[off + 2]];
      const x = m[0] * lr + m[1] * lg + m[2] * lb;
      const y = m[3] * lr + m[4] * lg + m[5] * lb;
      const z = m[6] * lr + m[7] * lg + m[8] * lb;
      const sr = xyzToSrgb[0] * x + xyzToSrgb[1] * y + xyzToSrgb[2] * z;
      const sg = xyzToSrgb[3] * x + xyzToSrgb[4] * y + xyzToSrgb[5] * z;
      const sb = xyzToSrgb[6] * x + xyzToSrgb[7] * y + xyzToSrgb[8] * z;
      rgbaData[off] = Math.max(0, Math.min(255, Math.round(255 * (Math.max(0, sr) ** (1 / 2.2)))));
      rgbaData[off + 1] = Math.max(0, Math.min(255, Math.round(255 * (Math.max(0, sg) ** (1 / 2.2)))));
      rgbaData[off + 2] = Math.max(0, Math.min(255, Math.round(255 * (Math.max(0, sb) ** (1 / 2.2)))));
    }
  }

  if (sMask && sMaskWidth && sMaskHeight) {
    if (sMaskWidth === width && sMaskHeight === height) {
      for (let i = 0; i < width * height; i++) {
        rgbaData[i * 4 + 3] = sMask[i];
      }
    } else if (sMaskWidth > width || sMaskHeight > height) {
      // Mask is higher resolution than image — upsample image to mask dimensions
      const outW = sMaskWidth;
      const outH = sMaskHeight;
      const upsampled = new Uint8ClampedArray(outW * outH * 4);
      for (let y = 0; y < outH; y++) {
        const srcY = Math.min(Math.floor(y * height / outH), height - 1);
        for (let x = 0; x < outW; x++) {
          const srcX = Math.min(Math.floor(x * width / outW), width - 1);
          const dstIdx = (y * outW + x) * 4;
          const srcIdx = (srcY * width + srcX) * 4;
          upsampled[dstIdx] = rgbaData[srcIdx];
          upsampled[dstIdx + 1] = rgbaData[srcIdx + 1];
          upsampled[dstIdx + 2] = rgbaData[srcIdx + 2];
          upsampled[dstIdx + 3] = sMask[y * outW + x];
        }
      }
      return ca.createImageBitmapFromImageData(new ImageData(upsampled, outW, outH));
    } else {
      // Mask is lower resolution than image — resample mask to image dimensions
      for (let y = 0; y < height; y++) {
        const srcY = Math.min(Math.floor(y * sMaskHeight / height), sMaskHeight - 1);
        for (let x = 0; x < width; x++) {
          const srcX = Math.min(Math.floor(x * sMaskWidth / width), sMaskWidth - 1);
          rgbaData[(y * width + x) * 4 + 3] = sMask[srcY * sMaskWidth + srcX];
        }
      }
    }
  }

  // Apply color key mask: pixels whose component values all fall within the
  // specified [min, max] ranges become fully transparent (PDF spec §8.9.6.4).
  // The compared values are the source samples before palette lookup (the index for Indexed), read at the image's bit depth.
  // Sub-byte depths pack samples MSB-first with each row padded to a byte.
  if (colorKeyMask && rgbaData) {
    const nComp = colorKeyMask.length / 2;
    const rowBytes = Math.ceil(width * nComp * bitsPerComponent / 8);
    const sampleMax = (1 << bitsPerComponent) - 1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let masked = true;
        for (let c = 0; c < nComp; c++) {
          let val;
          if (bitsPerComponent === 8) {
            val = imageData[y * rowBytes + x * nComp + c];
          } else {
            const bitOff = (x * nComp + c) * bitsPerComponent;
            const byteIdx = y * rowBytes + (bitOff >> 3);
            val = (imageData[byteIdx] >> (8 - (bitOff & 7) - bitsPerComponent)) & sampleMax;
          }
          if (val < colorKeyMask[c * 2] || val > colorKeyMask[c * 2 + 1]) {
            masked = false;
            break;
          }
        }
        if (masked) rgbaData[(y * width + x) * 4 + 3] = 0;
      }
    }
  }

  // General net for any other >=40 MP raster (RGB/CMYK/Indexed, or a non-1:1-masked bilevel) that missed the fast path above:
  // when the decoded image dwarfs the device draw box, box-average it down to draw size before creating the ImageBitmap.
  // This still has to build the full-resolution RGBA, but it removes the expensive createImageBitmap of a huge bitmap and the large-source drawImage downscale.
  // The extra box pass is paid back by those, a net win in both Node and Chrome.
  // Gated only on absolute source size (>=40 MP) to reduce overhead + complexity on images that would not benefit.
  if (maxW && maxH && (width > maxW || height > maxH) && width * height >= 40e6) {
    const k = Math.min(maxW / width, maxH / height);
    const outW = Math.max(1, Math.round(width * k));
    const outH = Math.max(1, Math.round(height * k));
    if (width * height >= outW * outH * 2) {
      const small = boxDownsampleRgba(rgbaData, width, height, outW, outH);
      return ca.createImageBitmapFromImageData(new ImageData(small, outW, outH));
    }
  }

  const imgData = new ImageData(rgbaData, width, height);
  return ca.createImageBitmapFromImageData(imgData);
}

/**
 * Convert an ImageMask image to an ImageBitmap using the current fill color.
 * ImageMask images are stencil masks: where mask bits are set, the fill color
 * is painted; where not set, pixels are transparent.
 *
 * @param {import('./parsePdfImages.js').ImageInfo} imageInfo
 * @param {string} fillColor - CSS color string (e.g. 'rgb(20,20,20)')
 * @param {ObjectCache} [objCache]
 * @returns {Promise<ImageBitmap>}
 */
async function imageMaskToBitmap(imageInfo, fillColor, objCache) {
  if (imageInfo.imageData == null && objCache && imageInfo.objNum != null) {
    imageInfo.imageData = objCache.getStreamBytes(imageInfo.objNum);
  }
  const { width, height, imageData } = imageInfo;

  const colorMatch = /rgb\((\d+),(\d+),(\d+)\)/.exec(fillColor);
  const r = colorMatch ? Number(colorMatch[1]) : 0;
  const g = colorMatch ? Number(colorMatch[2]) : 0;
  const b = colorMatch ? Number(colorMatch[3]) : 0;

  const rgbaData = new Uint8ClampedArray(width * height * 4);
  const rowBytes = Math.ceil(width / 8);
  // Determine which bit value means "painted" based on Decode array.
  // Default Decode [0 1]: sample 0 → painted. Decode [1 0]: sample 1 → painted.
  const paintBit = imageInfo.decodeInvert ? 1 : 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byteIndex = y * rowBytes + Math.floor(x / 8);
      const bitIndex = 7 - (x % 8);
      const bit = (imageData[byteIndex] >> bitIndex) & 1;
      const pi = (y * width + x) * 4;
      if (bit === paintBit) {
        rgbaData[pi] = r;
        rgbaData[pi + 1] = g;
        rgbaData[pi + 2] = b;
        rgbaData[pi + 3] = 255;
      }
      // else: leave as transparent (0,0,0,0)
    }
  }

  return ca.createImageBitmapFromImageData(new ImageData(rgbaData, width, height));
}

/**
 * Read a Form XObject's own /Matrix (defaults to identity).
 * Matches only the dict's top-level /Matrix. A /Matrix nested in the form's
 * /Resources (e.g. a shading pattern's matrix) must not be mistaken for it.
 * @param {string} objText - the form or appearance dict text
 * @returns {number[]} a 6-element matrix
 */
function parseFormMatrix(objText) {
  for (let i = 0, depth = 0; i < objText.length - 1; i++) {
    const c2 = objText[i] + objText[i + 1];
    if (c2 === '<<') { depth += 1; i += 1; } else if (c2 === '>>') { depth -= 1; i += 1; } else if (depth === 1 && objText.startsWith('/Matrix', i)) {
      const m = /\/Matrix\s*\[\s*([\d.\seE+-]+)\]/.exec(objText.slice(i));
      if (m) {
        const parsed = m[1].trim().split(/\s+/).map(Number);
        if (parsed.length === 6 && parsed.every((n) => Number.isFinite(n))) return parsed;
      }
      break;
    }
  }
  return [1, 0, 0, 1, 0, 0];
}

/**
 * Compose `smask`'s snapshotted `parentCtm` with `composedBase`, returning a new wrapper without mutating the shared smask object.
 * The parentCtm was snapshotted when `/gs` set the soft mask, in the coordinate space active then.
 * When the op is later composed with parent form transforms,
 * parentCtm must be composed the same way so the SMask form ends up in the correct page-space location.
 * @param {SmaskRef} smask
 * @param {number[]} composedBase
 * @returns {SmaskRef}
 */
function transformSmaskCtm(smask, composedBase) {
  if (!smask) return smask;
  if (!smask.parentCtm) return { ...smask, parentCtm: composedBase.slice() };
  return { ...smask, parentCtm: matMul(smask.parentCtm, composedBase) };
}

/**
 * Apply a Form XObject's composed transform to a draw op.
 * Images get their CTM composed; text/type3/path ops get their coordinates transformed.
 * @param {DrawOp} op
 * @param {number[]} composedBase - The form's composed transform matrix
 * @returns {DrawOp}
 */
function applyFormTransform(op, composedBase) {
  /**
   * Apply the form transform `composedBase` to the op's secondary coordinate references.
   * These are its smask parent CTMs and its fill/stroke tiling- and shading-pattern matrices.
   * They are defined in form-local space, so each is composed with `composedBase` to bring it into the surrounding coordinate space.
   * Mutates `result` in place.
   * @param {DrawOp} result
   */
  const composeFormRefs = (result) => {
    if (op.smask) result.smask = transformSmaskCtm(op.smask, composedBase);
    if (op.outerSmask) result.outerSmask = transformSmaskCtm(op.outerSmask, composedBase);
    if (op.tilingPattern) result.tilingPattern = { ...op.tilingPattern, matrix: matMul(op.tilingPattern.matrix, composedBase) };
    if (op.patternShading?.matrix) result.patternShading = { ...op.patternShading, matrix: matMul(op.patternShading.matrix, composedBase) };
    // strokeTilingPattern and strokePatternShading are declared only on path ops.
    if (op.type === 'path' && result.type === 'path') {
      if (op.strokeTilingPattern) result.strokeTilingPattern = { ...op.strokeTilingPattern, matrix: matMul(op.strokeTilingPattern.matrix, composedBase) };
      if (op.strokePatternShading?.matrix) result.strokePatternShading = { ...op.strokePatternShading, matrix: matMul(op.strokePatternShading.matrix, composedBase) };
    }
  };
  switch (op.type) {
    case 'image': {
      const finalCtm = matMul(op.ctm, composedBase);
      const result = { ...op, ctm: finalCtm };
      if (op.clips) result.clips = op.clips.map((c) => ({ ...c, ctm: matMul(c.ctm, composedBase) }));
      composeFormRefs(result);
      return result;
    }
    case 'type0text': {
      const trm = matMul([op.a, op.b, op.c, op.d, op.x, op.y], composedBase);
      const result = {
        ...op, a: trm[0], b: trm[1], c: trm[2], d: trm[3], x: trm[4], y: trm[5],
      };
      if (op.clips) result.clips = op.clips.map((c) => ({ ...c, ctm: matMul(c.ctm, composedBase) }));
      composeFormRefs(result);
      return result;
    }
    case 'type3glyph': {
      const newTransform = matMul(op.transform, composedBase);
      const result = { ...op, transform: newTransform };
      if (op.clips) result.clips = op.clips.map((c) => ({ ...c, ctm: matMul(c.ctm, composedBase) }));
      composeFormRefs(result);
      return result;
    }
    case 'path': {
      const newCtm = matMul(op.ctm, composedBase);
      const result = { ...op, ctm: newCtm };
      if (op.clips) result.clips = op.clips.map((c) => ({ ...c, ctm: matMul(c.ctm, composedBase) }));
      composeFormRefs(result);
      return result;
    }
    case 'shading': {
      const newCtm = matMul(op.ctm, composedBase);
      const result = { ...op, ctm: newCtm };
      if (op.clips) result.clips = op.clips.map((c) => ({ ...c, ctm: matMul(c.ctm, composedBase) }));
      composeFormRefs(result);
      return result;
    }
    case 'inlineImage': {
      const newCtm = matMul(op.ctm, composedBase);
      const result = { ...op, ctm: newCtm };
      if (op.clips) result.clips = op.clips.map((c) => ({ ...c, ctm: matMul(c.ctm, composedBase) }));
      composeFormRefs(result);
      return result;
    }
    default:
      return op;
  }
}

/**
 * Flatten image draw operations by expanding Form XObject references into their
 * constituent image draw operations with composed CTMs.
 *
 * @param {Array<ImageDrawOp>} imageOps - Image-type draw ops only
 * @param {Map<string, import('./parsePdfImages.js').ImageInfo>} images
 * @param {Map<string, import('./parsePdfImages.js').FormXObjectInfo>} forms
 * @param {ObjectCache} objCache
 * @param {Map<string, object>} fonts - Font map for parsing nested form streams
 * @param {Map<string, string>} registeredFontNames
 * @param {string} [prefix=''] - key prefix for nested lookups
 * @param {number} [pageIndex=0]
 * @param {Set<string>} [symbolFontTags]
 * @param {Set<string>} [cidPUATags]
 * @param {Map<string, ExtGStateEntry>} [pageExtGStates]
 * @param {Set<string>} [rawCharCodeTags]
 * @param {Map} [formResourceCache]
 * @param {number} [depth=0]
 * @param {Set<number>} [offOCGs]
 * @param {Map<string, Set<number>>} [cidCollisionMap]
 * @param {string} [inheritedFillColor='black']
 * @param {string} [inheritedStrokeColor='rgb(0,0,0)']
 * @param {number} [inheritedFillAlpha=1]
 * @param {number} [inheritedStrokeAlpha=1]
 * @param {{nextId: number, registry: Map<number, TransparencyGroupAttrs>}|null} [groupContext]
 * @param {number|null} [currentGroupId]
 * @returns {Promise<Array<DrawOp>>}
 */
async function flattenDrawOps(
  imageOps, images, forms, objCache, fonts, registeredFontNames, prefix = '',
  pageIndex = 0, symbolFontTags = new Set(), cidPUATags = new Set(), pageExtGStates = new Map(), rawCharCodeTags = new Set(),
  formResourceCache = new Map(), depth = 0, offOCGs = new Set(),
  cidCollisionMap = new Map(),
  inheritedFillColor = 'black', inheritedStrokeColor = 'rgb(0,0,0)',
  inheritedFillAlpha = 1, inheritedStrokeAlpha = 1,
  groupContext = null, currentGroupId = null,
) {
  /** @type {Array<DrawOp>} */
  const flattened = [];
  if (depth > 200) return flattened;
  // Backstop against pathological/malicious form nesting.
  // depth > 200 guard above bounds recursion depth.
  // callCount guard bounds total breadth.
  // Legitimate documents with ~11k objects at this path have been encountered,
  // so this is currently set to a high number.
  const callCount = (formResourceCache.get('_callCount') || 0) + 1;
  formResourceCache.set('_callCount', callCount);
  if (callCount > 100000) return flattened;

  for (const op of imageOps) {
    const fullName = prefix + op.name;

    if (images.has(fullName)) {
      /** @type {ImageDrawOp} */
      const imgOp = {
        type: 'image',
        name: fullName,
        ctm: op.ctm,
        fillAlpha: op.fillAlpha,
        strokeAlpha: op.strokeAlpha,
        fillColor: op.fillColor,
      };
      if (op.clips) imgOp.clips = op.clips;
      if (op.overprint) imgOp.overprint = true;
      if (op.blendMode) imgOp.blendMode = op.blendMode;
      if (op.tilingPattern) imgOp.tilingPattern = op.tilingPattern;
      if (op.fillColorInherited) imgOp.fillColorInherited = true;
      if (op.fillAlphaInherited) imgOp.fillAlphaInherited = true;
      if (op.strokeColorInherited) imgOp.strokeColorInherited = true;
      if (op.strokeAlphaInherited) imgOp.strokeAlphaInherited = true;
      flattened.push(imgOp);
      continue;
    }

    // Check if this is a Form XObject that we can recurse into
    const formInfo = forms.get(fullName);
    if (!formInfo) continue;

    const formObjText = objCache.getObjectText(formInfo.objNum);
    if (!formObjText) continue;

    // Skip forms hidden by Optional Content
    if (offOCGs.size > 0 && isFormOCHidden(formObjText, offOCGs, objCache)) continue;

    // Get the Form's own /Matrix (defaults to identity).
    const formMatrix = parseFormMatrix(formObjText);

    // Compose: outerCTM * formMatrix
    const composedBase = matMul(formMatrix, op.ctm);

    // Build a clip entry from the Form XObject's BBox so content outside
    // the bounding box is clipped.  The BBox is in the form's local
    // coordinate space, so its CTM is the composed form transform.
    /** @type {{path: any[], ctm: number[], evenOdd: boolean, fromFormObjNum?: number}|null} */
    let bboxClip = null;
    if (formInfo.bbox && formInfo.bbox.length === 4) {
      // PDF spec §8.10.2: BBox is in form-local space and clips the form's content.
      // BBox may be specified in any corner order — normalize to min/max so the clip
      // is a positive rectangle regardless of how the producer wrote it.
      const bx0 = Math.min(formInfo.bbox[0], formInfo.bbox[2]);
      const by0 = Math.min(formInfo.bbox[1], formInfo.bbox[3]);
      const bx1 = Math.max(formInfo.bbox[0], formInfo.bbox[2]);
      const by1 = Math.max(formInfo.bbox[1], formInfo.bbox[3]);
      bboxClip = {
        path: [
          { type: 'M', x: bx0, y: by0 },
          { type: 'L', x: bx1, y: by0 },
          { type: 'L', x: bx1, y: by1 },
          { type: 'L', x: bx0, y: by1 },
          { type: 'Z' },
        ],
        ctm: composedBase.slice(),
        evenOdd: false,
        fromFormObjNum: formInfo.objNum,
      };
    }

    // Check if we've already parsed this Form XObject's resources and content.
    // Same objNum always produces the same fonts, images, patterns, draw ops, etc.
    // Only the prefix (for name lookups) and transform (for positioning) vary per call.
    // Inherited text state (PDF spec §8.10.1) affects how the form's `T*`/`Tj`
    // operators resolve to glyph positions, so include it in the cache key.
    const ts = op.textState || {
      tc: 0, tw: 0, tl: 0, tz: 100, trise: 0,
    };
    const cacheKey = `${formInfo.objNum}_${ts.tc}_${ts.tw}_${ts.tl}_${ts.tz}_${ts.trise}`;
    let cached = formResourceCache.get(cacheKey);
    if (!cached) {
      // Parse the Form's own fonts — use a cache keyed by the font reference set
      // to avoid re-parsing when many Form XObjects share the same fonts.
      const fontRefMatches = [...formObjText.matchAll(/\/Fo\w+\s+(\d+)\s+\d+\s+R/g)];
      const fontRefKey = fontRefMatches.map((m) => m[1]).sort().join(',');
      const cachedFontParse = fontRefKey ? formResourceCache.get(`_fonts_${fontRefKey}`) : null;
      let formFonts;
      if (cachedFontParse) {
        formFonts = cachedFontParse.formFonts;
      } else {
        formFonts = parsePageFonts(formObjText, objCache);
        if (fontRefKey) formResourceCache.set(`_fonts_${fontRefKey}`, { formFonts });
      }
      let effectiveFonts2 = fonts;
      let effectiveRegistered2 = registeredFontNames;
      // Scope the symbol/PUA/rawCharCode tag-sets per form.
      // These classifications are keyed by the local font tag, whose meaning is scope-dependent.
      // Without this, a symbol-encoded page /TT0 could mark a same-tagged non-symbol form /TT0 as symbol.
      let effectiveSymbol2 = symbolFontTags;
      let effectiveCidPUA2 = cidPUATags;
      let effectiveRaw2 = rawCharCodeTags;
      // Clone per form like the tag-sets: convertAndRegisterFont records collisions keyed by font tag,
      // so a form-local tag would otherwise overwrite the parent's entry for the same tag.
      let effectiveCidCollisionMap2 = cidCollisionMap;
      if (formFonts.size > 0) {
        effectiveFonts2 = new Map([...fonts, ...formFonts]);
        effectiveRegistered2 = new Map(registeredFontNames);
        effectiveSymbol2 = new Set(symbolFontTags);
        effectiveCidPUA2 = new Set(cidPUATags);
        effectiveRaw2 = new Set(rawCharCodeTags);
        effectiveCidCollisionMap2 = new Map(cidCollisionMap);
        for (const [fontTag, fontObj] of formFonts) {
          // A Form XObject's local /Resources must shadow the parent scope.
          // Even if the tag already exists (e.g. /C0_0 on the page and inside
          // the form), re-register against the form font object so parseDrawOps
          // resolves to the form-local family alias.
          const formId = fullName.replace(/\//g, '_');
          const familyName = pdfFontFamilyName(objCache, fontObj.fontObjNum, `${formId}_${fontTag}`);
          // Clear the parent scope's classification for this tag.
          // convertAndRegisterFont only adds, so without this a non-symbol form font keeps a parent symbol tag.
          effectiveSymbol2.delete(fontTag);
          effectiveCidPUA2.delete(fontTag);
          effectiveRaw2.delete(fontTag);
          await convertAndRegisterFont(
            fontTag, fontObj, effectiveRegistered2, effectiveSymbol2, effectiveCidPUA2,
            effectiveRaw2, effectiveCidCollisionMap2, objCache, familyName,
          );
        }
        appendGenericFallbacks(effectiveRegistered2, effectiveFonts2);
      }

      // Cache all resource parsing by the full set of resource object refs.
      // Many Form XObjects share identical Resources, so this avoids redundant parsing.
      const resRefMatches = [...formObjText.matchAll(/\/\w+\s+(\d+)\s+\d+\s+R/g)];
      const resKey = resRefMatches.map((m) => m[1]).join(',');
      const cachedRes = resKey ? formResourceCache.get(`_res_${resKey}`) : null;
      let formExtGStates;
      let formColorSpaces;
      let formImagesResult;
      let formShadings;
      let formPatterns;
      if (cachedRes) {
        formExtGStates = cachedRes.formExtGStates;
        formColorSpaces = cachedRes.formColorSpaces;
        formImagesResult = cachedRes.formImagesResult;
        formShadings = cachedRes.formShadings;
        formPatterns = cachedRes.formPatterns;
      } else {
        formExtGStates = parseExtGStates(formObjText, objCache);
        formColorSpaces = parsePageColorSpaces(formObjText, objCache);
        formImagesResult = parsePageImages(formObjText, objCache, { recurseForms: false });
        formShadings = parseShadings(formObjText, objCache);
        formPatterns = parsePatterns(formObjText, objCache);
        if (resKey) {
          formResourceCache.set(`_res_${resKey}`, {
            formExtGStates, formColorSpaces, formImagesResult, formShadings, formPatterns,
          });
        }
      }
      let formResourcesText = formObjText;
      const formResRefMatch = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(formObjText);
      if (formResRefMatch) {
        const formResObj = objCache.getObjectText(Number(formResRefMatch[1]));
        if (formResObj) formResourcesText = formResObj;
      }
      const formDefinesOwnExtGState = /\/ExtGState[\s/<]/.test(formResourcesText);
      const effectiveExtGStates2 = formDefinesOwnExtGState
        ? formExtGStates
        : (formExtGStates.size > 0
          ? new Map([...pageExtGStates, ...formExtGStates])
          : pageExtGStates);

      const streamBytes = objCache.getStreamBytes(formInfo.objNum);
      let rawFormDrawOps = [];
      if (streamBytes) {
        const formStream = bytesToLatin1(streamBytes);
        rawFormDrawOps = parseDrawOps(
          formStream, effectiveFonts2, effectiveExtGStates2, effectiveRegistered2,
          formColorSpaces.size > 0 ? formColorSpaces : undefined, effectiveSymbol2, effectiveCidPUA2, effectiveRaw2,
          formShadings, formPatterns, effectiveCidCollisionMap2, ts,
          parseHiddenOCMCNames(formObjText, objCache, offOCGs),
        );
      }

      cached = {
        formImagesResult,
        rawFormDrawOps,
        effectiveFonts: effectiveFonts2,
        effectiveRegistered: effectiveRegistered2,
        effectiveExtGStates: effectiveExtGStates2,
        effectiveSymbol: effectiveSymbol2,
        effectiveCidPUA: effectiveCidPUA2,
        effectiveRaw: effectiveRaw2,
        effectiveCidCollisionMap: effectiveCidCollisionMap2,
      };
      formResourceCache.set(cacheKey, cached);
    }

    // Resolve the form's effective inherited fill/stroke color.
    // Per PDF spec section 8.10.1, a form inherits its caller's graphics state at the time of `Do`.
    // The Do op was emitted by the caller's parser with the caller's then-current colors.
    // If the caller never explicitly set a color before invoking the form (so the Do op was tagged as inherited),
    // fall back to this function's inherited param so the chain propagates through nested forms.
    const formInheritedFill = op.fillColorInherited ? inheritedFillColor : op.fillColor;
    const formInheritedStroke = op.strokeColorInherited ? inheritedStrokeColor : (op.strokeColor || inheritedStrokeColor);
    const formInheritedFillAlpha = op.fillAlphaInherited ? inheritedFillAlpha : (op.fillAlpha != null ? op.fillAlpha : 1);
    const formInheritedStrokeAlpha = op.strokeAlphaInherited ? inheritedStrokeAlpha : (op.strokeAlpha != null ? op.strokeAlpha : 1);

    // Per-call expansion (no expandedOps cache): the cached `rawFormDrawOps` carry inheritance markers
    // so the same parsed form can be reused across callers, but each invocation resolves the markers against its own parent context.
    // Register images/forms with current prefix for the recursive flattening
    for (const [name, info] of cached.formImagesResult.images) {
      images.set(`${fullName}/${name}`, info);
    }
    for (const [name, info] of cached.formImagesResult.forms) {
      forms.set(`${fullName}/${name}`, info);
    }

    if (cached.formImagesResult.images.size === 0
      && cached.formImagesResult.forms.size === 0
      && !/\/Resources[\s<]/.test(formObjText)) {
      for (const [name, info] of [...images]) {
        const relName = prefix ? (name.startsWith(prefix) ? name.substring(prefix.length) : null) : name;
        if (relName && !relName.includes('/') && relName !== fullName.substring(prefix.length)) {
          images.set(`${fullName}/${relName}`, info);
        }
      }
      for (const [name, info] of [...forms]) {
        const relName = prefix ? (name.startsWith(prefix) ? name.substring(prefix.length) : null) : name;
        if (relName && !relName.includes('/') && relName !== fullName.substring(prefix.length)) {
          forms.set(`${fullName}/${relName}`, info);
        }
      }
    }

    const effectiveFonts = cached.effectiveFonts;
    const effectiveRegistered = cached.effectiveRegistered;
    const effectiveExtGStates = cached.effectiveExtGStates;
    const effectiveSymbol = cached.effectiveSymbol || symbolFontTags;
    const effectiveCidPUA = cached.effectiveCidPUA || cidPUATags;
    const effectiveRaw = cached.effectiveRaw || rawCharCodeTags;
    const effectiveCidCollisionMap = cached.effectiveCidCollisionMap || cidCollisionMap;
    const innerPrefix = `${fullName}/`;
    // If this Form is a transparency group AND we have a group context,
    // allocate a groupId and capture the outer GS attributes that apply at composite time.
    // Inner ops will be tagged with this groupId and will NOT carry these attributes.
    let formGroupId = null;
    // Only isolate when the composite step is non-trivial: a non-Normal blend mode, sub-1 alpha, or an SMask.
    // With Normal/1.0/no-mask, isolating to a transparent canvas and source-over'ing back
    // is functionally identical to drawing directly, but breaks blend modes inside the group that depend on
    // the backdrop (Multiply, Darken, etc.).
    // Both outermost and nested groups register here. The renderer maintains a stack of group canvases.
    const compositeIsTrivial = (!op.blendMode || op.blendMode === 'Normal')
      && (op.fillAlpha == null || op.fillAlpha >= 1)
      && (op.strokeAlpha == null || op.strokeAlpha >= 1)
      && !op.smask;
    // A group whose only non-triviality is its group alpha needs no isolation buffer.
    // The alpha folds directly into its single op.
    const singleOpAlphaGroup = !compositeIsTrivial
      && (!op.blendMode || op.blendMode === 'Normal')
      && !op.smask
      && formInfo.transparencyGroup && !formInfo.transparencyGroup.knockout
      && cached.rawFormDrawOps.length === 1
      && cached.rawFormDrawOps[0].type !== 'image'
      && !(cached.rawFormDrawOps[0].fill && cached.rawFormDrawOps[0].stroke);
    // An isolated group composites against a fully transparent backdrop.
    // A child blend that depends on the backdrop (Screen, Multiply, Darken...) needs that:
    // when the group's own composite is trivial, the isolation above is skipped,
    // the child blends against the parent (e.g. the white page), and Screen-over-white erases it.
    // So force a buffer when an isolated group has a direct op with a non-Normal blend
    // (a blend nested deeper inside a child form is not inspected here).
    const isolatedNeedsBuffer = formInfo.transparencyGroup && formInfo.transparencyGroup.isolated
      && cached.rawFormDrawOps.some((fop) => fop.blendMode && fop.blendMode !== 'Normal');
    if (groupContext && formInfo.transparencyGroup && (!compositeIsTrivial || isolatedNeedsBuffer) && !singleOpAlphaGroup) {
      formGroupId = groupContext.nextId++;
      groupContext.registry.set(formGroupId, {
        isolated: !!formInfo.transparencyGroup.isolated,
        knockout: !!formInfo.transparencyGroup.knockout,
        blendMode: op.blendMode || 'Normal',
        fillAlpha: op.fillAlpha != null ? op.fillAlpha : 1,
        strokeAlpha: op.strokeAlpha != null ? op.strokeAlpha : 1,
        smask: op.smask || null,
        parentGroupId: currentGroupId,
      });
    }
    const innerGroupId = formGroupId !== null ? formGroupId : currentGroupId;

    /** @type {Array<DrawOp>} */
    const expandedFormOps = [];
    for (const innerOp of cached.rawFormDrawOps) {
      if (innerOp.type === 'image') {
        const nestedGroupIdStart = groupContext ? groupContext.nextId : 0;
        const nestedFlattened = await flattenDrawOps(
          [innerOp], images, forms, objCache, effectiveFonts, effectiveRegistered,
          innerPrefix, pageIndex, effectiveSymbol, effectiveCidPUA, effectiveExtGStates, effectiveRaw,
          formResourceCache, depth + 1, offOCGs, effectiveCidCollisionMap,
          formInheritedFill, formInheritedStroke,
          formInheritedFillAlpha, formInheritedStrokeAlpha,
          groupContext, innerGroupId,
        );
        // Compose this form's transform onto the SMask of every transparency group registered while flattening this child op.
        // applyFormTransform below re-composes each returned content op with composedBase,
        // but a group's SMask lives in the registry rather than on an op, so applyFormTransform never reaches it.
        if (groupContext) {
          for (let gid = nestedGroupIdStart; gid < groupContext.nextId; gid++) {
            const ga = groupContext.registry.get(gid);
            if (ga && ga.smask) ga.smask = transformSmaskCtm(ga.smask, composedBase);
          }
        }
        for (const nestedOp of nestedFlattened) expandedFormOps.push(nestedOp);
      } else {
        expandedFormOps.push(innerOp);
      }
    }

    // Apply the parent's transform, clipping, SMask, alpha to each op.
    // Resolve any inheritance markers against this form's effective parent colors.
    const hasFormSiblingSmasks = op.smask && expandedFormOps.some((fop) => fop.smask);
    for (const innerOp of expandedFormOps) {
      const transformed = applyFormTransform(innerOp, composedBase);
      if (innerOp.fillColorInherited) {
        transformed.fillColor = formInheritedFill;
        delete transformed.fillColorInherited;
      }
      if (innerOp.strokeColorInherited) {
        transformed.strokeColor = formInheritedStroke;
        delete transformed.strokeColorInherited;
      }
      const fillAlphaInherited = innerOp.fillAlphaInherited;
      const strokeAlphaInherited = innerOp.strokeAlphaInherited;
      delete transformed.fillAlphaInherited;
      delete transformed.strokeAlphaInherited;
      // Propagate parent clip paths (from W/W* before Do) to inner ops.
      // Clone each clip so the rotation transform (which mutates ctm in-place)
      // doesn't corrupt shared references across sibling ops.
      if (op.clips && op.clips.length > 0) {
        if (!transformed.clips) transformed.clips = [];
        for (const c of op.clips) transformed.clips.push({ ...c, ctm: c.ctm.slice() });
      }
      if (bboxClip) {
        if (!transformed.clips) transformed.clips = [];
        transformed.clips.push({ ...bboxClip, ctm: bboxClip.ctm.slice() });
      }
      // When the outer form is a transparency group, the GS attributes
      // (blendMode, alpha, smask) apply at group composite time, not per-op,
      // so we must NOT propagate them down to inner ops.
      if (formGroupId === null) {
        if (op.smask) {
          if (hasFormSiblingSmasks) {
            transformed.outerSmask = op.smask;
          } else if (!transformed.smask) {
            transformed.smask = op.smask;
          }
        }
        if (singleOpAlphaGroup) {
          // No isolation buffer: fold the group alpha into the single op so it
          // composites as content x groupAlpha, matching the isolated result.
          const ownFill = fillAlphaInherited ? 1 : (transformed.fillAlpha != null ? transformed.fillAlpha : 1);
          const ownStroke = strokeAlphaInherited ? 1 : (transformed.strokeAlpha != null ? transformed.strokeAlpha : 1);
          if (op.fillAlpha != null) transformed.fillAlpha = ownFill * op.fillAlpha;
          if (op.strokeAlpha != null) transformed.strokeAlpha = ownStroke * op.strokeAlpha;
        } else {
          if (fillAlphaInherited && formInheritedFillAlpha < 1) transformed.fillAlpha = formInheritedFillAlpha;
          if (strokeAlphaInherited && formInheritedStrokeAlpha < 1) transformed.strokeAlpha = formInheritedStrokeAlpha;
        }
        if (op.blendMode && !transformed.blendMode) transformed.blendMode = op.blendMode;
      }
      if (op.overprint && !transformed.overprint) transformed.overprint = true;
      // Tag with innermost active groupId if not already tagged by deeper recursion.
      if (innerGroupId !== null && transformed.groupId === undefined) {
        transformed.groupId = innerGroupId;
      }
      flattened.push(transformed);
    }
  }

  return flattened;
}

/**
 * @typedef {{ fillAlpha?: number, strokeAlpha?: number, overprint?: boolean,
 *   blendMode?: string, smask?: SmaskRef|null, lineWidth?: number,
 *   lineCap?: number, lineJoin?: number, miterLimit?: number,
 *   dashArray?: number[], dashPhase?: number }} ExtGStateEntry
 */

/**
 * Parse the /BM blend mode from an ExtGState dict.
 * Returns null when /BM is absent.
 *
 * @param {string} gsObjText - Raw text of the ExtGState dict
 * @returns {string|null}
 */
function parseBlendMode(gsObjText) {
  const arrMatch = /\/BM\s*\[([^\]]+)\]/.exec(gsObjText);
  if (arrMatch) {
    const names = [...arrMatch[1].matchAll(/\/(\w+)/g)].map((m) => m[1]);
    for (const n of names) {
      if (n === 'Normal' || pdfBlendToCanvas[n]) return n;
    }
    return names[0] || null;
  }
  const nameMatch = /\/BM\s*\/(\w+)/.exec(gsObjText);
  return nameMatch ? nameMatch[1] : null;
}

/**
 * Parse the /TR transfer function from a soft mask dict. /TR maps mask
 * luminosity (or alpha) to the final mask alpha; /Identity (or absent)
 * means no transform. Returns a parsed function or null.
 *
 * @param {string} smaskDict
 * @param {ObjectCache} objCache
 * @returns {ReturnType<typeof parseFunction>|null}
 */
function parseSmaskTR(smaskDict, objCache) {
  if (/\/TR\s*\/Identity\b/.test(smaskDict)) return null;
  const refMatch = /\/TR\s+(\d+)\s+\d+\s+R/.exec(smaskDict);
  if (refMatch) return parseFunction(Number(refMatch[1]), objCache);
  const inlineIdx = smaskDict.indexOf('/TR');
  if (inlineIdx !== -1) {
    const after = smaskDict.substring(inlineIdx + 3).trimStart();
    if (after.startsWith('<<')) {
      const dictStart = smaskDict.indexOf('<<', inlineIdx + 3);
      if (dictStart !== -1) return parseFunction(extractDict(smaskDict, dictStart), objCache);
    }
  }
  return null;
}

/**
 * Parse a soft mask's /BC backdrop colour array (components in the mask group's
 * colour space). Returns null when absent (the spec default is black).
 * @param {string} smaskDict
 * @param {ObjectCache} objCache
 * @returns {number[]|null}
 */
function parseSmaskBC(smaskDict, objCache) {
  let arrStr = null;
  const refMatch = /\/BC\s+(\d+)\s+\d+\s+R/.exec(smaskDict);
  if (refMatch) {
    const t = objCache.getObjectText(Number(refMatch[1]));
    const m = t && /\[([^\]]*)\]/.exec(t);
    if (m) arrStr = m[1];
  } else {
    const m = /\/BC\s*\[([^\]]*)\]/.exec(smaskDict);
    if (m) arrStr = m[1];
  }
  if (arrStr == null) return null;
  const arr = arrStr.trim().split(/\s+/).filter((s) => s.length > 0).map(Number);
  return arr.length > 0 && !arr.some(Number.isNaN) ? arr : null;
}

/**
 * Parse extended graphics states from a page's Resources dictionary.
 * @param {string} pageObjText Page object text.
 * @param {ObjectCache} objCache Object cache for resolving references.
 * @returns {Map<string, object>} Map of graphics state names to state properties (fillAlpha, strokeAlpha, blendMode, smask, overprint).
 */
function parseExtGStates(pageObjText, objCache) {
  const states = new Map();

  let resourcesText = null;
  const resRefMatch = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(pageObjText);
  if (resRefMatch) {
    resourcesText = objCache.getObjectText(Number(resRefMatch[1])) || null;
  } else {
    const resIdx = pageObjText.indexOf('/Resources');
    if (resIdx !== -1) {
      const dictStart = pageObjText.indexOf('<<', resIdx);
      if (dictStart !== -1) resourcesText = extractDict(pageObjText, dictStart);
    }
  }
  if (!resourcesText) return states;

  const gsStart = findTopLevelKey(resourcesText, '/ExtGState');
  if (gsStart === -1) return states;

  let gsDictText;
  const afterGs = resourcesText.substring(gsStart + 10).trim();
  if (afterGs.startsWith('<<')) {
    gsDictText = extractDict(resourcesText, gsStart + 10 + resourcesText.substring(gsStart + 10).indexOf('<<'));
  } else {
    const gsRefMatch = /^(\d+)\s+\d+\s+R/.exec(afterGs);
    if (gsRefMatch) {
      const gsObj = objCache.getObjectText(Number(gsRefMatch[1]));
      if (gsObj) gsDictText = gsObj;
    }
  }
  if (!gsDictText) return states;

  // Extract each GState entry: /GS1 N 0 R or /GS1 << ... >>
  const gsEntryRegex = /\/([^\s/<>[\]]+)\s+(\d+)\s+\d+\s+R/g;
  for (const match of gsDictText.matchAll(gsEntryRegex)) {
    const gsName = match[1];
    const gsObjNum = Number(match[2]);
    const gsObj = objCache.getObjectText(gsObjNum);
    if (!gsObj) continue;

    /** @type {ExtGStateEntry} */
    const entry = {};
    // /ca = fill alpha (non-stroking), /CA = stroke alpha (stroking)
    const caMatch = /\/ca\s+([0-9.]+)/.exec(gsObj);
    const CAMatch = /\/CA\s+([0-9.]+)/.exec(gsObj);
    if (caMatch) entry.fillAlpha = parseFloat(caMatch[1]);
    if (CAMatch) entry.strokeAlpha = parseFloat(CAMatch[1]);

    // /op = overprint for non-stroking, /OP = overprint for stroking
    const opMatch = /\/op\s+(true|false)/.exec(gsObj);
    const OPMatch = /\/OP\s+(true|false)/.exec(gsObj);
    // /op takes precedence for non-stroking; if absent, /OP applies to both
    if (opMatch) {
      entry.overprint = opMatch[1] === 'true';
    } else if (OPMatch) {
      entry.overprint = OPMatch[1] === 'true';
    }

    // /SMask — soft mask (luminosity or alpha)
    if (/\/SMask\s*\/None/.test(gsObj)) {
      entry.smask = null; // explicitly clear
    } else {
      const smaskRef = /\/SMask\s+(\d+)\s+\d+\s+R/.exec(gsObj);
      let smaskDict;
      if (smaskRef) {
        smaskDict = objCache.getObjectText(Number(smaskRef[1]));
      } else {
        // Try inline SMask dictionary: /SMask << /G ... >>
        const smaskIdx = gsObj.indexOf('/SMask');
        if (smaskIdx !== -1) {
          const afterSmask = gsObj.substring(smaskIdx + 6).trim();
          if (afterSmask.startsWith('<<')) {
            smaskDict = extractDict(gsObj, smaskIdx + 6 + gsObj.substring(smaskIdx + 6).indexOf('<<'));
          }
        }
      }
      if (smaskDict) {
        const gMatch = /\/G\s+(\d+)\s+\d+\s+R/.exec(smaskDict);
        const sMatch = /\/S\s*\/(\w+)/.exec(smaskDict);
        if (gMatch) {
          entry.smask = {
            formObjNum: Number(gMatch[1]),
            type: sMatch ? sMatch[1] : 'Luminosity',
            tr: parseSmaskTR(smaskDict, objCache),
            bc: parseSmaskBC(smaskDict, objCache),
          };
        }
      }
    }

    // /BM = blend mode (name, or array of names per PDF spec 11.3.5)
    const bm = parseBlendMode(gsObj);
    if (bm) entry.blendMode = bm;

    // /LW = line width
    const lwMatch = /\/LW\s+([0-9.]+)/.exec(gsObj);
    if (lwMatch) entry.lineWidth = parseFloat(lwMatch[1]);

    // /LC line cap, /LJ line join, /ML miter limit, /D [dashArray dashPhase]
    const lcMatch = /\/LC\s+(\d+)/.exec(gsObj);
    if (lcMatch) entry.lineCap = parseInt(lcMatch[1], 10);
    const ljMatch = /\/LJ\s+(\d+)/.exec(gsObj);
    if (ljMatch) entry.lineJoin = parseInt(ljMatch[1], 10);
    const mlMatch = /\/ML\s+([0-9.]+)/.exec(gsObj);
    if (mlMatch) entry.miterLimit = parseFloat(mlMatch[1]);
    const dMatch = /\/D\s*\[\s*\[([^\]]*)\]\s*([0-9.]+)\s*\]/.exec(gsObj);
    if (dMatch) {
      entry.dashArray = dMatch[1].trim() ? dMatch[1].trim().split(/\s+/).map(Number).filter((x) => Number.isFinite(x)) : [];
      entry.dashPhase = parseFloat(dMatch[2]);
    }

    if (entry.fillAlpha !== undefined || entry.strokeAlpha !== undefined || entry.smask !== undefined
      || entry.overprint !== undefined || entry.blendMode !== undefined || entry.lineWidth !== undefined
      || entry.lineCap !== undefined || entry.lineJoin !== undefined || entry.miterLimit !== undefined
      || entry.dashArray !== undefined) {
      states.set(gsName, entry);
    }
  }

  // Also check for inline GState dictionaries: /GS1 << /ca 0.5 /CA 0.5 >>
  const inlineGsRegex = /\/([^\s/<>[\]]+)\s*<</g;
  let inlineMatch;
  while ((inlineMatch = inlineGsRegex.exec(gsDictText)) !== null) {
    const gsName = inlineMatch[1];
    if (states.has(gsName)) continue; // Already parsed from indirect ref
    const dictText = extractDict(gsDictText, inlineMatch.index + inlineMatch[0].length - 2);
    if (!dictText) continue;

    /** @type {ExtGStateEntry} */
    const entry = {};
    const caMatch = /\/ca\s+([0-9.]+)/.exec(dictText);
    const CAMatch = /\/CA\s+([0-9.]+)/.exec(dictText);
    if (caMatch) entry.fillAlpha = parseFloat(caMatch[1]);
    if (CAMatch) entry.strokeAlpha = parseFloat(CAMatch[1]);

    const opMatch2 = /\/op\s+(true|false)/.exec(dictText);
    const OPMatch2 = /\/OP\s+(true|false)/.exec(dictText);
    if (opMatch2) {
      entry.overprint = opMatch2[1] === 'true';
    } else if (OPMatch2) {
      entry.overprint = OPMatch2[1] === 'true';
    }

    // /SMask — soft mask (luminosity or alpha)
    if (/\/SMask\s*\/None/.test(dictText)) {
      entry.smask = null;
    } else {
      const smaskRef = /\/SMask\s+(\d+)\s+\d+\s+R/.exec(dictText);
      let smaskDict;
      if (smaskRef) {
        smaskDict = objCache.getObjectText(Number(smaskRef[1]));
      } else {
        // Try inline SMask dictionary: /SMask << /G ... >>
        const smaskIdx = dictText.indexOf('/SMask');
        if (smaskIdx !== -1) {
          const afterSmask = dictText.substring(smaskIdx + 6).trim();
          if (afterSmask.startsWith('<<')) {
            smaskDict = extractDict(dictText, smaskIdx + 6 + dictText.substring(smaskIdx + 6).indexOf('<<'));
          }
        }
      }
      if (smaskDict) {
        const gMatch = /\/G\s+(\d+)\s+\d+\s+R/.exec(smaskDict);
        const sMatch = /\/S\s*\/(\w+)/.exec(smaskDict);
        if (gMatch) {
          entry.smask = {
            formObjNum: Number(gMatch[1]),
            type: sMatch ? sMatch[1] : 'Luminosity',
            tr: parseSmaskTR(smaskDict, objCache),
            bc: parseSmaskBC(smaskDict, objCache),
          };
        }
      }
    }

    // /BM = blend mode (name, or array of names per PDF spec 11.3.5)
    const bm2 = parseBlendMode(dictText);
    if (bm2) entry.blendMode = bm2;

    // /LW = line width
    const lwMatch2 = /\/LW\s+([0-9.]+)/.exec(dictText);
    if (lwMatch2) entry.lineWidth = parseFloat(lwMatch2[1]);

    // /LC line cap, /LJ line join, /ML miter limit, /D [dashArray dashPhase]
    const lcMatch2 = /\/LC\s+(\d+)/.exec(dictText);
    if (lcMatch2) entry.lineCap = parseInt(lcMatch2[1], 10);
    const ljMatch2 = /\/LJ\s+(\d+)/.exec(dictText);
    if (ljMatch2) entry.lineJoin = parseInt(ljMatch2[1], 10);
    const mlMatch2 = /\/ML\s+([0-9.]+)/.exec(dictText);
    if (mlMatch2) entry.miterLimit = parseFloat(mlMatch2[1]);
    const dMatch2 = /\/D\s*\[\s*\[([^\]]*)\]\s*([0-9.]+)\s*\]/.exec(dictText);
    if (dMatch2) {
      entry.dashArray = dMatch2[1].trim() ? dMatch2[1].trim().split(/\s+/).map(Number).filter((x) => Number.isFinite(x)) : [];
      entry.dashPhase = parseFloat(dMatch2[2]);
    }

    if (entry.fillAlpha !== undefined || entry.strokeAlpha !== undefined || entry.smask !== undefined
       || entry.overprint !== undefined || entry.blendMode !== undefined || entry.lineWidth !== undefined
       || entry.lineCap !== undefined || entry.lineJoin !== undefined || entry.miterLimit !== undefined
       || entry.dashArray !== undefined) {
      states.set(gsName, entry);
    }
  }

  return states;
}

/**
 * Find a top-level key inside a PDF dict string. The dict must start with `<<`
 * at some position in `dictText`. Returns the index where `key` occurs at
 * depth 1 (directly inside the outer dict), or -1.
 *
 * @param {string} dictText
 * @param {string} key - e.g. "/ColorSpace" — includes the leading slash
 */
function findTopLevelKey(dictText, key) {
  let depth = 0;
  let i = 0;
  const n = dictText.length;
  while (i < n) {
    const c = dictText.charCodeAt(i);
    if (c === 0x3C && dictText.charCodeAt(i + 1) === 0x3C) { // '<<'
      depth++;
      i += 2;
    } else if (c === 0x3E && dictText.charCodeAt(i + 1) === 0x3E) { // '>>'
      depth--;
      i += 2;
    } else if (depth === 1 && c === 0x2F && dictText.startsWith(key, i)) {
      const after = dictText.charCodeAt(i + key.length);
      // Valid key terminators: whitespace, '/', '[', '(', '<', digit
      if (after === 0x20 || after === 0x09 || after === 0x0A || after === 0x0D
        || after === 0x2F || after === 0x5B || after === 0x28 || after === 0x3C
        || (after >= 0x30 && after <= 0x39)) {
        return i;
      }
      i++;
    } else {
      i++;
    }
  }
  return -1;
}

/**
 * Parse ColorSpace entries from page resources to identify Separation color spaces.
 * Returns a map of resource names to objects with type string and optional tint samples.
 *
 * @param {string} pageObjText - Raw text of the Page object
 * @param {ObjectCache} objCache - PDF object cache
 */
function parsePageColorSpaces(pageObjText, objCache) {
  /** @type {Map<string, {type: string, tintSamples: Uint8Array|null, nComponents: number, deviceNGrid?: object|null, indexedInfo?: object|null, labWhitePoint?: number[]|null}>} */
  const colorSpaces = new Map();

  // Extract the Resources dict text. The Resources may be an indirect reference
  // or an inline dict. We must narrow to the Resources dict before searching for
  // /ColorSpace, because nested dicts (e.g. /Shading << /Sh10 << /ColorSpace /DeviceCMYK ... >>)
  // contain their own /ColorSpace keys that would otherwise be picked up first.
  let resourcesText = null;
  const resRefMatch = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(pageObjText);
  if (resRefMatch) {
    resourcesText = objCache.getObjectText(Number(resRefMatch[1])) || null;
  } else {
    const resIdx = pageObjText.indexOf('/Resources');
    if (resIdx !== -1) {
      const dictStart = pageObjText.indexOf('<<', resIdx);
      if (dictStart !== -1) resourcesText = extractDict(pageObjText, dictStart);
    }
  }
  if (!resourcesText) return colorSpaces;

  // Find /ColorSpace at the top level of the Resources dict (depth 1 inside the outer <<>>).
  // A naïve indexOf would match /ColorSpace keys inside nested Shading or Pattern dicts.
  const csStart = findTopLevelKey(resourcesText, '/ColorSpace');
  if (csStart === -1) return colorSpaces;

  let csDictText;
  const afterCs = resourcesText.substring(csStart + 11).trim();
  if (afterCs.startsWith('<<')) {
    csDictText = extractDict(resourcesText, csStart + 11 + resourcesText.substring(csStart + 11).indexOf('<<'));
  } else {
    const csRefMatch = /^(\d+)\s+\d+\s+R/.exec(afterCs);
    if (csRefMatch) {
      const csObj = objCache.getObjectText(Number(csRefMatch[1]));
      if (csObj) csDictText = csObj;
    }
  }
  if (!csDictText) return colorSpaces;

  // Extract each color space entry: /Cs6 N 0 R or /Cs6 [/ICCBased ...]
  const csEntryRegex = /\/([^\s/<>[\]]+)\s+(\d+)\s+\d+\s+R/g;
  for (const match of csDictText.matchAll(csEntryRegex)) {
    const csName = match[1];
    const csObjText = objCache.getObjectText(Number(match[2]));
    if (!csObjText) continue;
    const typeMatch = /\/(\w+)/.exec(csObjText);
    if (typeMatch) {
      let tintSamples = null;
      let nComponents = 3;
      let csType = typeMatch[1];
      let deviceNGrid = null;
      // Single-colorant DeviceN (e.g. [/DeviceN [/Black] /DeviceCMYK ...]) is functionally
      // equivalent to Separation — needs ink inversion for scn color handling.
      // Multi-colorant DeviceN uses a sampled tint transform grid for color conversion.
      if (csType === 'DeviceN') {
        const namesMatch = /\/DeviceN\s*\[\s*((?:\/[^/[\]<>(){}\s]+\s*)+)\]/.exec(csObjText);
        if (namesMatch) {
          const colorants = namesMatch[1].match(/\/[^/[\]<>(){}\s]+/g) || [];
          if (colorants.length === 1) {
            csType = 'Separation';
          } else if (colorants.length >= 2) {
            // Multi-colorant DeviceN: parse the tint transform and pre-compute an RGB grid.
            const tintInfo = parseSeparationTint(csObjText, objCache);
            if (tintInfo.tintSamples) {
              // tintSamples are pre-computed RGB values from the sampled function.
              // For a 2-input function with Size [S0, S1], there are S0*S1 samples.
              // parseSeparationTint treats them as a flat 1D array — we need the grid dimensions.
              const sizeMatch = /\/Size\s*\[\s*([\d\s]+)\]/.exec(csObjText);
              // Also check the tint function object for Size
              const allRefs = [...csObjText.matchAll(/(\d+)\s+\d+\s+R/g)];
              let funcObjText = null;
              if (allRefs.length > 0) {
                funcObjText = objCache.getObjectText(Number(allRefs[allRefs.length - 1][1]));
              }
              const sizeText = sizeMatch ? sizeMatch[1] : (funcObjText?.match(/\/Size\s*\[\s*([\d\s]+)\]/)?.[1] || '');
              const gridSizes = sizeText.trim().split(/\s+/).map(Number).filter((n) => n > 0);
              if (gridSizes.length === colorants.length) {
                deviceNGrid = {
                  nInputs: colorants.length,
                  sizes: gridSizes,
                  rgbSamples: tintInfo.tintSamples,
                  nComponents: tintInfo.nComponents,
                };
              }
            }
            // FunctionType 2/4 tint transforms have no /Size, so no grid is built.
            // Keep the parsed tint CS for direct per-call evaluation in scn/SCN.
            if (!deviceNGrid) {
              const parsedTint = parseTintColorSpace(csObjText, objCache);
              if (parsedTint.tintFn && parsedTint.nInputs === colorants.length) {
                deviceNGrid = {
                  nInputs: colorants.length,
                  sizes: null,
                  rgbSamples: null,
                  nComponents: 3,
                  parsedTint,
                };
              }
            }
          }
        }
      }
      if (csType === 'Separation') {
        const tintInfo = parseSeparationTint(csObjText, objCache);
        tintSamples = tintInfo.tintSamples;
        nComponents = tintInfo.nComponents;
      }
      let indexedInfo = null;
      if (csType === 'Indexed') {
        indexedInfo = parseIndexedColorSpace(csObjText, objCache, Number(match[2]));
      }
      let labWhitePoint = null;
      if (csType === 'Lab') {
        const wpStr = resolveArrayValue(csObjText, 'WhitePoint', objCache);
        labWhitePoint = wpStr ? wpStr.split(/\s+/).map(Number) : [0.9642, 1.0, 0.8249];
      }
      colorSpaces.set(csName, {
        type: csType, tintSamples, nComponents, deviceNGrid, indexedInfo, labWhitePoint,
      });
    }
  }

  // Also check for inline array definitions: /Cs6 [/Separation ...]
  const inlineArrayRegex = /\/([^\s/<>[\]]+)\s*\[\s*\/(\w+)/g;
  for (const match of csDictText.matchAll(inlineArrayRegex)) {
    const csName = match[1];
    if (!colorSpaces.has(csName)) {
      let tintSamples = null;
      let nComponents = 3;
      let csType = match[2];
      const matchPos = csDictText.indexOf(match[0]);
      const arrStart = csDictText.indexOf('[', matchPos);
      let arrEnd = -1;
      if (arrStart !== -1) {
        let depth = 0;
        for (let i = arrStart; i < csDictText.length; i++) {
          if (csDictText[i] === '[') depth++;
          else if (csDictText[i] === ']') {
            depth--;
            if (depth === 0) { arrEnd = i + 1; break; }
          }
        }
      }
      const arrText = arrEnd > 0 ? csDictText.substring(arrStart, arrEnd) : '';
      // Single-colorant DeviceN → treat as Separation
      if (csType === 'DeviceN' && arrText) {
        const namesMatch = /\/DeviceN\s*\[\s*((?:\/\w+\s*)+)\]/.exec(arrText);
        if (namesMatch) {
          const colorants = namesMatch[1].trim().split(/(?=\/)/).filter((s) => s.startsWith('/'));
          if (colorants.length === 1) csType = 'Separation';
        }
      }
      if (csType === 'Separation' && arrText) {
        const tintInfo = parseSeparationTint(arrText, objCache);
        tintSamples = tintInfo.tintSamples;
        nComponents = tintInfo.nComponents;
      }
      let indexedInfo = null;
      if (csType === 'Indexed' && arrText) {
        indexedInfo = parseIndexedColorSpace(arrText, objCache);
      }
      let labWhitePoint = null;
      if (csType === 'Lab' && arrText) {
        const wpStr = resolveArrayValue(arrText, 'WhitePoint', objCache);
        labWhitePoint = wpStr ? wpStr.split(/\s+/).map(Number) : [0.9642, 1.0, 0.8249];
      }
      colorSpaces.set(csName, {
        type: csType, tintSamples, nComponents, indexedInfo, labWhitePoint,
      });
    }
  }

  return colorSpaces;
}

/**
 * @typedef {{
 *   deviceNTintCS: import('./pdfColorFunctions.js').ParsedTintCS|null,
 *   sepTintSamples: Uint8Array|null,
 *   isCMYK: boolean,
 *   isGray: boolean,
 * }} ShadingColorInfo
 */

/**
 * Convert a parsed function's output components to an `rgb(r,g,b)` string for a gradient stop.
 * The component meaning depends on the shading's color space:
 * DeviceN/Separation tints route through the tint transform, CMYK through `cmykToRgb`,
 * otherwise the first one (gray) or three (RGB) outputs are used.
 *
 * @param {number[]} values
 * @param {ShadingColorInfo} colorInfo
 * @returns {string}
 */
function shadingValuesToColor(values, colorInfo) {
  let r; let g; let b;
  if (colorInfo.deviceNTintCS) {
    const rgb = tintComponentsToRGB(colorInfo.deviceNTintCS, values);
    if (rgb) { [r, g, b] = rgb; } else { r = 128; g = 128; b = 128; }
  } else if (colorInfo.sepTintSamples) {
    const sepMax = colorInfo.sepTintSamples.length / 3 - 1;
    const idx = Math.round(Math.max(0, Math.min(1, values[0])) * sepMax) * 3;
    r = colorInfo.sepTintSamples[idx]; g = colorInfo.sepTintSamples[idx + 1]; b = colorInfo.sepTintSamples[idx + 2];
  } else if (colorInfo.isCMYK && values.length >= 4) {
    [r, g, b] = cmykToRgb(
      Math.max(0, Math.min(1, values[0])),
      Math.max(0, Math.min(1, values[1])),
      Math.max(0, Math.min(1, values[2])),
      Math.max(0, Math.min(1, values[3])),
    );
  } else {
    r = Math.round(Math.max(0, Math.min(1, values[0] ?? 0)) * 255);
    g = colorInfo.isGray ? r : Math.round(Math.max(0, Math.min(1, values[1] ?? 0)) * 255);
    b = colorInfo.isGray ? r : Math.round(Math.max(0, Math.min(1, values[2] ?? 0)) * 255);
  }
  return `rgb(${r},${g},${b})`;
}

/**
 * Sample a parsed PDF function into axial/radial gradient color stops.
 * Accepts either a single function whose outputs are the color components,
 * or an array of functions (the shading's `/Function [F0 F1 ...]` form)
 * where each function supplies one component from its first output.
 *
 * @param {import('./pdfColorFunctions.js').ParsedFunction
 *   | Array<import('./pdfColorFunctions.js').ParsedFunction|null>} fn
 * @param {ShadingColorInfo} colorInfo
 * @returns {Array<{offset: number, color: string}>}
 */
function functionToShadingStops(fn, colorInfo) {
  const stops = [];
  if (Array.isArray(fn)) {
    const nStops = fn.some((f) => f && f.type === 0) ? 64 : 16;
    for (let i = 0; i < nStops; i++) {
      const t = i / (nStops - 1);
      const values = fn.map((f) => (f ? (evaluateFunction(f, [t])?.[0] ?? 0) : 0));
      stops.push({ offset: t, color: shadingValuesToColor(values, colorInfo) });
    }
    return stops;
  }
  let nStops;
  if (fn.type === 0) nStops = Math.min(fn.size[0], 64);
  else if (fn.type === 2) nStops = fn.N === 1 ? 2 : 16;
  else nStops = (fn.type === 3 && fn.functions.some((f) => f && f.type === 0)) ? 64 : 16;
  for (let i = 0; i < nStops; i++) {
    const t = i / (nStops - 1);
    const values = evaluateFunction(fn, [t]) || [];
    stops.push({ offset: t, color: shadingValuesToColor(values, colorInfo) });
  }
  return stops;
}

/**
 * Approximate ShadingType 1 shading, where color is defined by function, with an axial gradient.
 * Returns null when the shading's function cannot be parsed.
 *
 * @param {string} shadingDict - the Shading dictionary text
 * @param {ObjectCache} objCache
 * @param {ShadingColorInfo} colorInfo - how to turn the function's outputs into CSS colors
 * @returns {{ type: 2, coords: number[], stops: Array<{offset:number,color:string}>, extend: boolean[], bbox?: number[], multiply?: boolean, matrix?: number[] } | null}
 */
function type1ShadingToAxial(shadingDict, objCache, colorInfo) {
  const domStr = resolveArrayValue(shadingDict, 'Domain', objCache);
  const dom = domStr ? domStr.split(/\s+/).map(Number) : [0, 1, 0, 1];
  const [x0, x1, y0, y1] = dom;

  // The shading's own /Matrix (default identity) maps domain coords into the shading's target space.
  // The pattern /Matrix (applied later by the renderer) then maps that to user space.
  const mStr = resolveArrayValue(shadingDict, 'Matrix', objCache);
  const m = mStr ? mStr.split(/\s+/).map(Number) : [1, 0, 0, 1, 0, 0];
  const mapPt = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

  let funcDictText;
  let funcObjNum;
  const funcRefMatch = /\/Function\s+(\d+)\s+\d+\s+R/.exec(shadingDict);
  if (funcRefMatch) {
    funcObjNum = Number(funcRefMatch[1]);
    funcDictText = objCache.getObjectText(funcObjNum);
  } else {
    const fStart = shadingDict.indexOf('/Function');
    if (fStart !== -1) {
      const fOpen = shadingDict.indexOf('<<', fStart + 9);
      if (fOpen !== -1) funcDictText = extractDict(shadingDict, fOpen);
    }
  }
  const fn = funcDictText ? parseFunction(funcObjNum != null ? funcObjNum : funcDictText, objCache) : null;
  if (!fn) return null;

  const xm = (x0 + x1) / 2;
  const ym = (y0 + y1) / 2;
  const colorVar = (a, b) => {
    if (!a || !b) return 0;
    let mx = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) mx = Math.max(mx, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
    return mx;
  };
  const alongX = colorVar(evaluateFunction(fn, [x0, ym]), evaluateFunction(fn, [x1, ym]))
    >= colorVar(evaluateFunction(fn, [xm, y0]), evaluateFunction(fn, [xm, y1]));

  const nStops = 16;
  const stops = [];
  for (let i = 0; i < nStops; i++) {
    const t = i / (nStops - 1);
    const px = alongX ? x0 + (x1 - x0) * t : xm;
    const py = alongX ? ym : y0 + (y1 - y0) * t;
    stops.push({ offset: t, color: shadingValuesToColor(evaluateFunction(fn, [px, py]) || [], colorInfo) });
  }
  const [cx0, cy0] = mapPt(alongX ? x0 : xm, alongX ? ym : y0);
  const [cx1, cy1] = mapPt(alongX ? x1 : xm, alongX ? ym : y1);
  return {
    type: 2, coords: [cx0, cy0, cx1, cy1], stops, extend: [true, true],
  };
}

/**
 * Compute a Coons patch interior control point from 12 boundary control points
 * (PDF spec §8.7.4.5.7).
 * (-4*corner + 6*(adj1+adj2) - 2*(far1+far2) + 3*(diag1+diag2) - opp) / 9
 *
 * @param {number[]} corner
 * @param {number[]} adj1
 * @param {number[]} adj2
 * @param {number[]} far1
 * @param {number[]} far2
 * @param {number[]} diag1
 * @param {number[]} diag2
 * @param {number[]} opp
 */
function coonsInteriorPt(corner, adj1, adj2, far1, far2, diag1, diag2, opp) {
  return [
    (-4 * corner[0] + 6 * (adj1[0] + adj2[0]) - 2 * (far1[0] + far2[0]) + 3 * (diag1[0] + diag2[0]) - opp[0]) / 9,
    (-4 * corner[1] + 6 * (adj1[1] + adj2[1]) - 2 * (far1[1] + far2[1]) + 3 * (diag1[1] + diag2[1]) - opp[1]) / 9,
  ];
}

/**
 * Parse a Type 6 (Coons) or Type 7 (tensor-product) mesh patch shading.
 * Reads the binary stream data and returns an array of patches, each with a 4×4 grid
 * of control points and 4 corner colors in RGB.
 *
 * @param {string} shObjText - Raw text of the Shading object
 * @param {number} shObjNum - Object number of the Shading stream
 * @param {number} shadingType - 6 (Coons) or 7 (tensor-product)
 * @param {ObjectCache} objCache - PDF object cache
 */
function parseMeshShading(shObjText, shObjNum, shadingType, objCache) {
  const bpc = resolveIntValue(shObjText, 'BitsPerComponent', objCache);
  const bpco = resolveIntValue(shObjText, 'BitsPerCoordinate', objCache);
  const bpf = resolveIntValue(shObjText, 'BitsPerFlag', objCache);
  const decodeStr = resolveArrayValue(shObjText, 'Decode', objCache);
  if (!bpc || !bpco || !bpf || !decodeStr) return null;

  const decode = decodeStr.split(/\s+/).map(Number);
  // Derive nComps from Decode array: [xmin xmax ymin ymax c1min c1max ... cnmin cnmax]
  const nComps = (decode.length - 4) / 2;

  const streamBytes = objCache.getStreamBytes(shObjNum);
  if (!streamBytes || streamBytes.length === 0) return null;

  const colorEval = buildMeshColorEvaluator(shObjText, objCache);

  // Bit reader
  let bitPos = 0;
  const totalBits = streamBytes.length * 8;

  function readBits(n) {
    let val = 0;
    let rem = n;
    while (rem > 0) {
      const byteIdx = bitPos >>> 3;
      const bitOff = bitPos & 7;
      const avail = 8 - bitOff;
      const take = Math.min(avail, rem);
      const shift = avail - take;
      val = val * (1 << take) + ((streamBytes[byteIdx] >>> shift) & ((1 << take) - 1));
      bitPos += take;
      rem -= take;
    }
    return val;
  }

  const coordMax = 2 ** bpco - 1;
  const compMax = 2 ** bpc - 1;

  function readCoord() {
    const rx = readBits(bpco);
    const ry = readBits(bpco);
    return [
      decode[0] + rx * (decode[1] - decode[0]) / coordMax,
      decode[2] + ry * (decode[3] - decode[2]) / coordMax,
    ];
  }

  function readColor() {
    const comps = [];
    for (let i = 0; i < nComps; i++) {
      comps.push(decode[4 + i * 2] + readBits(bpc) * (decode[4 + i * 2 + 1] - decode[4 + i * 2]) / compMax);
    }
    return colorEval(comps);
  }

  /**
   * Map 12 stream-order points to the non-inherited positions in the 4×4 grid.
   * Stream order: p13, p23, p33, p32, p31, p30, p20, p10, p11, p12, p22, p21
   * (same for both flag=0's last 12 and flag!=0's 12 points in Type 7)
   */
  function mapStreamPoints12(p) {
    // Stream order: p13, p23, p33, p32, p31, p30, p20, p10, p11, p12, p22, p21
    return [
      [p[7], p[8], p[9], p[0]], // i=1: p10, p11, p12, p13
      [p[6], p[11], p[10], p[1]], // i=2: p20, p21, p22, p23
      [p[5], p[4], p[3], p[2]], // i=3: p30, p31, p32, p33
    ];
  }

  // Bits needed to check before reading a patch
  const bitsNewT7 = bpf + 32 * bpco + 4 * nComps * bpc;
  const bitsContT7 = bpf + 24 * bpco + 2 * nComps * bpc;
  const bitsNewT6 = bpf + 24 * bpco + 4 * nComps * bpc;
  const bitsContT6 = bpf + 16 * bpco + 2 * nComps * bpc;

  const patches = [];
  let prev = null;

  while (true) {
    const minBits = prev
      ? (shadingType === 7 ? bitsContT7 : bitsContT6)
      : (shadingType === 7 ? bitsNewT7 : bitsNewT6);
    if (bitPos + minBits > totalBits) break;

    const flag = readBits(bpf) & 3;
    if (!prev && flag !== 0) break;

    let points; // points[i][j] = [x,y]
    let colors; // [c00, c03, c33, c30] as RGB [r,g,b]

    if (shadingType === 7) {
      // --- Type 7: tensor-product patch mesh (16 control points) ---
      if (flag === 0) {
        const p = [];
        for (let k = 0; k < 16; k++) p.push(readCoord());
        const c = [readColor(), readColor(), readColor(), readColor()];
        // Stream: p00,p01,p02,p03, p13,p23,p33, p32,p31,p30, p20,p10, p11,p12,p22,p21
        const rows = mapStreamPoints12(p.slice(4));
        points = [[p[0], p[1], p[2], p[3]], rows[0], rows[1], rows[2]];
        colors = [c[0], c[1], c[2], c[3]]; // c00, c03, c33, c30
      } else {
        // Inherit left column (i=0) from an edge of previous patch
        let ip;
        let ic00;
        let ic03;
        if (flag === 1) {
          ip = [prev.points[0][3], prev.points[1][3], prev.points[2][3], prev.points[3][3]];
          ic00 = prev.colors[1]; ic03 = prev.colors[2];
        } else if (flag === 2) {
          ip = [prev.points[3][3], prev.points[3][2], prev.points[3][1], prev.points[3][0]];
          ic00 = prev.colors[2]; ic03 = prev.colors[3];
        } else {
          ip = [prev.points[3][0], prev.points[2][0], prev.points[1][0], prev.points[0][0]];
          ic00 = prev.colors[3]; ic03 = prev.colors[0];
        }
        const p = [];
        for (let k = 0; k < 12; k++) p.push(readCoord());
        const nc33 = readColor();
        const nc30 = readColor();
        const rows = mapStreamPoints12(p);
        points = [[ip[0], ip[1], ip[2], ip[3]], rows[0], rows[1], rows[2]];
        colors = [ic00, ic03, nc33, nc30];
      }
    } else {
      // --- Type 6: Coons patch mesh (12 boundary control points) ---
      let bp00;
      let bp10;
      let bp20;
      let bp30;
      let bp31;
      let bp32;
      let bp33;
      let bp23;
      let bp13;
      let bp03;
      let bp02;
      let bp01;
      let cc00;
      let cc03;
      let cc33;
      let cc30;

      if (flag === 0) {
        const p = [];
        for (let k = 0; k < 12; k++) p.push(readCoord());
        const c = [readColor(), readColor(), readColor(), readColor()];
        // Stream order traces boundary: p00,p10,p20,p30, p31,p32,p33, p23,p13,p03, p02,p01
        bp00 = p[0]; bp10 = p[1]; bp20 = p[2]; bp30 = p[3];
        bp31 = p[4]; bp32 = p[5]; bp33 = p[6];
        bp23 = p[7]; bp13 = p[8]; bp03 = p[9];
        bp02 = p[10]; bp01 = p[11];
        cc00 = c[0]; cc30 = c[1]; cc33 = c[2]; cc03 = c[3]; // c1=c00, c2=c30, c3=c33, c4=c03
      } else {
        // Inherit 4 boundary points (bottom edge of new = one edge of previous) + 2 colors
        if (flag === 1) {
          bp00 = prev.points[3][0]; bp10 = prev.points[3][1];
          bp20 = prev.points[3][2]; bp30 = prev.points[3][3];
          cc00 = prev.colors[3]; cc30 = prev.colors[2];
        } else if (flag === 2) {
          bp00 = prev.points[3][3]; bp10 = prev.points[2][3];
          bp20 = prev.points[1][3]; bp30 = prev.points[0][3];
          cc00 = prev.colors[2]; cc30 = prev.colors[1];
        } else {
          bp00 = prev.points[0][3]; bp10 = prev.points[0][2];
          bp20 = prev.points[0][1]; bp30 = prev.points[0][0];
          cc00 = prev.colors[1]; cc30 = prev.colors[0];
        }
        const p = [];
        for (let k = 0; k < 8; k++) p.push(readCoord());
        cc33 = readColor(); cc03 = readColor();
        bp31 = p[0]; bp32 = p[1]; bp33 = p[2];
        bp23 = p[3]; bp13 = p[4]; bp03 = p[5];
        bp02 = p[6]; bp01 = p[7];
      }

      // Compute 4 interior points from boundary using Coons patch formulas
      const bp11 = coonsInteriorPt(bp00, bp01, bp10, bp03, bp30, bp13, bp31, bp33);
      const bp12 = coonsInteriorPt(bp03, bp02, bp13, bp00, bp33, bp10, bp32, bp30);
      const bp21 = coonsInteriorPt(bp30, bp31, bp20, bp33, bp00, bp23, bp01, bp03);
      const bp22 = coonsInteriorPt(bp33, bp32, bp23, bp30, bp03, bp20, bp02, bp00);

      points = [
        [bp00, bp01, bp02, bp03],
        [bp10, bp11, bp12, bp13],
        [bp20, bp21, bp22, bp23],
        [bp30, bp31, bp32, bp33],
      ];
      colors = [cc00, cc03, cc33, cc30];
    }

    const patch = { points, colors };
    patches.push(patch);
    prev = patch;
  }

  return patches.length > 0 ? { type: 'mesh', patches } : null;
}

/**
 * Render mesh patch shading (Types 6/7) onto a canvas context.
 * Rasterizes patches to an ImageData pixel buffer for performance (avoids millions of
 * Canvas 2D path API calls), then composites via drawImage which respects the active clip.
 *
 * @param {CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D} ctx
 * @param {Array<{points: number[][][], colors: number[][]}>} patches
 */
function renderMeshPatches(ctx, patches) {
  // Read the current canvas transform to map shading coords → canvas pixels
  const xform = ctx.getTransform();
  const ta = xform.a;
  const tb = xform.b;
  const tc = xform.c;
  const td = xform.d;
  const te = xform.e;
  const tf = xform.f;

  // Compute canvas-pixel bounding box of all patches
  let minPx = Infinity;
  let minPy = Infinity;
  let maxPx = -Infinity;
  let maxPy = -Infinity;
  for (const patch of patches) {
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const sx = patch.points[i][j][0];
        const sy = patch.points[i][j][1];
        const px = ta * sx + tc * sy + te;
        const py = tb * sx + td * sy + tf;
        if (px < minPx) minPx = px;
        if (py < minPy) minPy = py;
        if (px > maxPx) maxPx = px;
        if (py > maxPy) maxPy = py;
      }
    }
  }

  const ox = Math.floor(minPx);
  const oy = Math.floor(minPy);
  const w = Math.ceil(maxPx) - ox + 1;
  const h = Math.ceil(maxPy) - oy + 1;
  if (w <= 0 || h <= 0 || w > 8000 || h > 8000) return;

  // Rasterize all patches into a pixel buffer
  const tmpCanvas = ca.makeCanvas(w, h);
  const tmpCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (tmpCanvas.getContext('2d', { willReadFrequently: true }));
  const imgData = tmpCtx.createImageData(w, h);
  const pix = imgData.data;

  const N = 32; // tessellation subdivisions per patch
  // Pre-compute Bernstein basis
  const basis = new Array(N + 1);
  for (let k = 0; k <= N; k++) {
    const t = k / N;
    const t1 = 1 - t;
    basis[k] = [t1 * t1 * t1, 3 * t * t1 * t1, 3 * t * t * t1, t * t * t];
  }

  for (const patch of patches) {
    const { points: pts, colors: [c00, c03, c33, c30] } = patch;

    // Evaluate surface on (N+1)×(N+1) grid in canvas-pixel coords
    const gx = new Float64Array((N + 1) * (N + 1));
    const gy = new Float64Array((N + 1) * (N + 1));
    for (let jv = 0; jv <= N; jv++) {
      const bv = basis[jv];
      for (let iu = 0; iu <= N; iu++) {
        const bu = basis[iu];
        let sx = 0;
        let sy = 0;
        for (let i = 0; i < 4; i++) {
          const wi = bu[i];
          for (let j = 0; j < 4; j++) {
            const ww = wi * bv[j];
            sx += pts[i][j][0] * ww;
            sy += pts[i][j][1] * ww;
          }
        }
        const idx = jv * (N + 1) + iu;
        gx[idx] = ta * sx + tc * sy + te - ox;
        gy[idx] = tb * sx + td * sy + tf - oy;
      }
    }

    // For each cell, fill its bounding-box pixels in the ImageData
    for (let jv = 0; jv < N; jv++) {
      for (let iu = 0; iu < N; iu++) {
        const i00 = jv * (N + 1) + iu;
        const i10 = i00 + 1;
        const i01 = i00 + (N + 1);
        const i11 = i01 + 1;

        // Cell bounding box
        const x0 = Math.max(0, Math.floor(Math.min(gx[i00], gx[i10], gx[i01], gx[i11])));
        const y0 = Math.max(0, Math.floor(Math.min(gy[i00], gy[i10], gy[i01], gy[i11])));
        const x1 = Math.min(w - 1, Math.ceil(Math.max(gx[i00], gx[i10], gx[i01], gx[i11])));
        const y1 = Math.min(h - 1, Math.ceil(Math.max(gy[i00], gy[i10], gy[i01], gy[i11])));

        // Cell center color (bilinear interpolation)
        const u = (iu + 0.5) / N;
        const v = (jv + 0.5) / N;
        const u1 = 1 - u;
        const v1 = 1 - v;
        const cr = u1 * v1 * c00[0] + u * v1 * c30[0] + u1 * v * c03[0] + u * v * c33[0];
        const cg = u1 * v1 * c00[1] + u * v1 * c30[1] + u1 * v * c03[1] + u * v * c33[1];
        const cb = u1 * v1 * c00[2] + u * v1 * c30[2] + u1 * v * c03[2] + u * v * c33[2];
        const rr = Math.round(cr);
        const gg = Math.round(cg);
        const bb = Math.round(cb);

        for (let py = y0; py <= y1; py++) {
          let off = (py * w + x0) * 4;
          for (let px = x0; px <= x1; px++) {
            pix[off] = rr;
            pix[off + 1] = gg;
            pix[off + 2] = bb;
            pix[off + 3] = 255;
            off += 4;
          }
        }
      }
    }
  }

  // Composite onto the main canvas — drawImage respects the active clip path
  tmpCtx.putImageData(imgData, 0, 0);
  ctx.save();
  ctx.resetTransform();
  ctx.drawImage(tmpCanvas, ox, oy);
  ctx.restore();
  ca.closeDrawable(tmpCanvas);
}

/**
 * Render Gouraud-shaded triangles (ShadingType 4) into the current canvas context.
 * Each triangle has 3 vertices with coordinates and RGB colors; interior pixels are
 * barycentric-interpolated.
 * @param {OffscreenCanvasRenderingContext2D} ctx
 * @param {Array<{vertices: number[][], colors: number[][]}>} triangles
 * @param {number[]|null} [clipBounds] - Optional [xMin, yMin, xMax, yMax] in device
 *   pixels to clamp the rendering area. Used by batched Gouraud rendering.
 * @param {number[]} [canvasDims] - [width, height] of the canvas, used as fallback when clipBounds is null
 */
function renderGouraudTriangles(ctx, triangles, clipBounds, canvasDims) {
  // Full pixel-level Gouraud interpolation
  const xform = ctx.getTransform();
  const ta = xform.a;
  const tb = xform.b;
  const tc = xform.c;
  const td = xform.d;
  const te = xform.e;
  const tf = xform.f;

  let minPx = Infinity;
  let minPy = Infinity;
  let maxPx = -Infinity;
  let maxPy = -Infinity;
  for (const tri of triangles) {
    for (const v of tri.vertices) {
      const px = ta * v[0] + tc * v[1] + te;
      const py = tb * v[0] + td * v[1] + tf;
      if (px < minPx) minPx = px;
      if (py < minPy) minPy = py;
      if (px > maxPx) maxPx = px;
      if (py > maxPy) maxPy = py;
    }
  }

  // Clamp bounding box to clip bounds (if provided) or canvas dimensions.
  // Pattern-fill triangles can have extreme vertices (Decode range [-16384,16384])
  // spanning far beyond the visible area. Clamping to clip bounds is critical
  // for performance when called thousands of times.
  const bxMin = clipBounds ? clipBounds[0] : 0;
  const byMin = clipBounds ? clipBounds[1] : 0;
  const bxMax = clipBounds ? clipBounds[2] : (canvasDims ? canvasDims[0] : 8000);
  const byMax = clipBounds ? clipBounds[3] : (canvasDims ? canvasDims[1] : 8000);
  const ox = Math.max(bxMin, Math.floor(minPx));
  const oy = Math.max(byMin, Math.floor(minPy));
  const w = Math.min(bxMax, Math.ceil(maxPx)) - ox + 1;
  const h = Math.min(byMax, Math.ceil(maxPy)) - oy + 1;
  if (w <= 0 || h <= 0 || w > 8000 || h > 8000) return;

  const tmpCanvas = ca.makeCanvas(w, h);
  const tmpCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (tmpCanvas.getContext('2d', { willReadFrequently: true }));
  const imgData = tmpCtx.createImageData(w, h);
  const pix = imgData.data;

  for (const tri of triangles) {
    const [v0, v1, v2] = tri.vertices;
    const [c0, c1, c2] = tri.colors;

    const x0 = ta * v0[0] + tc * v0[1] + te - ox;
    const y0 = tb * v0[0] + td * v0[1] + tf - oy;
    const x1 = ta * v1[0] + tc * v1[1] + te - ox;
    const y1 = tb * v1[0] + td * v1[1] + tf - oy;
    const x2 = ta * v2[0] + tc * v2[1] + te - ox;
    const y2 = tb * v2[0] + td * v2[1] + tf - oy;

    const bx0 = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const by0 = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const bx1 = Math.min(w - 1, Math.ceil(Math.max(x0, x1, x2)));
    const by1 = Math.min(h - 1, Math.ceil(Math.max(y0, y1, y2)));

    const d00 = x1 - x0;
    const d01 = x2 - x0;
    const d10 = y1 - y0;
    const d11 = y2 - y0;
    const denom = d00 * d11 - d01 * d10;
    if (Math.abs(denom) < 1e-10) continue;
    const invDenom = 1 / denom;

    for (let py = by0; py <= by1; py++) {
      for (let px = bx0; px <= bx1; px++) {
        const dx = px + 0.5 - x0;
        const dy = py + 0.5 - y0;
        const u = (dx * d11 - d01 * dy) * invDenom;
        const v = (d00 * dy - dx * d10) * invDenom;
        if (u < -0.001 || v < -0.001 || u + v > 1.002) continue;
        const w0 = 1 - u - v;
        const idx = (py * w + px) * 4;
        pix[idx] = Math.round(w0 * c0[0] + u * c1[0] + v * c2[0]);
        pix[idx + 1] = Math.round(w0 * c0[1] + u * c1[1] + v * c2[1]);
        pix[idx + 2] = Math.round(w0 * c0[2] + u * c1[2] + v * c2[2]);
        pix[idx + 3] = 255;
      }
    }
  }

  // Composite via a temp canvas + drawImage so the active clip path is respected.
  // putImageData ignores clips; drawImage after resetTransform loses clip context.
  // Instead, put pixels into a temp canvas, then drawImage in identity space —
  // the clip was set before any transform changes, so it persists correctly.
  tmpCtx.putImageData(imgData, 0, 0);
  ctx.save();
  ctx.resetTransform();
  ctx.drawImage(tmpCanvas, ox, oy);
  ctx.restore();
  ca.closeDrawable(tmpCanvas);
}

/**
 * Build a per-vertex/per-corner color evaluator for a mesh shading (types 4-7).
 *
 * The returned function takes the color components decoded from the shading
 * stream for one vertex/corner. When the shading has a /Function those are the
 * function's parametric input(s), which it maps to colorant values in /ColorSpace.
 * Otherwise they are colorant values directly. Either way the colorant values are
 * converted to sRGB through /ColorSpace (DeviceN/Separation tint transform,
 * DeviceCMYK, DeviceGray, etc.).
 *
 * @param {string} shObjText - Raw text of the Shading object
 * @param {ObjectCache} objCache
 * @returns {(comps: number[]) => [number, number, number]}
 */
function buildMeshColorEvaluator(shObjText, objCache) {
  /** @type {import('./pdfColorFunctions.js').ParsedFunction|null} */
  let tintFn = null;
  /** @type {Array<import('./pdfColorFunctions.js').ParsedFunction|null>|null} */
  let tintFnArray = null;
  const funcArrMatch = /\/Function\s*\[\s*((?:\d+\s+\d+\s+R\s*)+)\]/.exec(shObjText);
  if (funcArrMatch) {
    const refs = [...funcArrMatch[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
    if (refs.length === 1) tintFn = parseFunction(refs[0], objCache);
    else tintFnArray = refs.map((r) => parseFunction(r, objCache));
  } else {
    const funcRefMatch = /\/Function\s+(\d+)\s+\d+\s+R/.exec(shObjText);
    if (funcRefMatch) {
      tintFn = parseFunction(Number(funcRefMatch[1]), objCache);
    } else {
      const funcIdx = shObjText.indexOf('/Function');
      if (funcIdx !== -1) {
        const funcDictOpen = shObjText.indexOf('<<', funcIdx + 9);
        if (funcDictOpen !== -1) {
          const funcDictText = extractDict(shObjText, funcDictOpen);
          if (funcDictText && /\/FunctionType/.test(funcDictText)) tintFn = parseFunction(funcDictText, objCache);
        }
      }
    }
  }

  let csText = null;
  const csArrStart = /\/ColorSpace\s*\[/.exec(shObjText);
  if (csArrStart) {
    const bracketIdx = csArrStart.index + csArrStart[0].length - 1;
    let depth = 1;
    let endIdx = bracketIdx + 1;
    while (endIdx < shObjText.length && depth > 0) {
      const ch = shObjText[endIdx];
      if (ch === '[') depth++;
      else if (ch === ']') depth--;
      if (depth > 0) endIdx++;
    }
    csText = shObjText.substring(bracketIdx, endIdx + 1);
  } else {
    const csRefMatch = /\/ColorSpace\s+(\d+)\s+\d+\s+R/.exec(shObjText);
    if (csRefMatch) csText = objCache.getObjectText(Number(csRefMatch[1]));
    else {
      const csNameMatch = /\/ColorSpace\s*\/(\w+)/.exec(shObjText);
      if (csNameMatch) csText = `/${csNameMatch[1]}`;
    }
  }

  const grayConvert = (c) => { const v = Math.max(0, Math.min(255, Math.round((c[0] || 0) * 255))); return [v, v, v]; };
  const rgbConvert = (c) => [
    Math.max(0, Math.min(255, Math.round((c[0] || 0) * 255))),
    Math.max(0, Math.min(255, Math.round((c[1] || 0) * 255))),
    Math.max(0, Math.min(255, Math.round((c[2] || 0) * 255))),
  ];
  /** @type {(c: number[]) => [number, number, number]} */
  let csConvert;
  if (csText && /\/Separation|\/DeviceN/.test(csText)) {
    const parsed = parseTintColorSpace(csText, objCache);
    csConvert = (c) => tintComponentsToRGB(parsed, c) || [128, 128, 128];
  } else if (csText && /\/DeviceCMYK/.test(csText)) {
    csConvert = (c) => cmykToRgb(c[0] || 0, c[1] || 0, c[2] || 0, c[3] || 0);
  } else if (csText && /\/DeviceGray|\/CalGray/.test(csText)) {
    csConvert = grayConvert;
  } else if (csText && /\/ICCBased/.test(csText)) {
    const iccRefMatch = /(\d+)\s+\d+\s+R/.exec(csText);
    const iccObjText = iccRefMatch ? objCache.getObjectText(Number(iccRefMatch[1])) : null;
    const nMatch = iccObjText && /\/N\s+(\d+)/.exec(iccObjText);
    const nComp = nMatch ? Number(nMatch[1]) : 3;
    if (nComp === 1) csConvert = grayConvert;
    else if (nComp === 4) csConvert = (c) => cmykToRgb(c[0] || 0, c[1] || 0, c[2] || 0, c[3] || 0);
    else csConvert = rgbConvert;
  } else {
    csConvert = rgbConvert;
  }

  if (tintFnArray) {
    return (comps) => csConvert(tintFnArray.map((fn) => {
      if (!fn) return 0;
      const o = evaluateFunction(fn, comps);
      return o ? o[0] : 0;
    }));
  }
  if (tintFn) {
    return (comps) => csConvert(evaluateFunction(tintFn, comps) || comps);
  }
  return (comps) => csConvert(comps);
}

/**
 * Parse a ShadingType 4 (free-form Gouraud-shaded triangle mesh) shading.
 * @param {string} shObjText Shading dictionary content.
 * @param {number} shObjNum Object number for stream bytes.
 * @param {ObjectCache} objCache Object cache for resolving references.
 * @returns {{ type: 'gouraud', triangles: Array<{vertices: number[][], colors: number[][]}> } | null}
 */
function parseType4Shading(shObjText, shObjNum, objCache) {
  const bpc = resolveIntValue(shObjText, 'BitsPerComponent', objCache);
  const bpco = resolveIntValue(shObjText, 'BitsPerCoordinate', objCache);
  const bpf = resolveIntValue(shObjText, 'BitsPerFlag', objCache);
  const decodeStr = resolveArrayValue(shObjText, 'Decode', objCache);
  if (!bpc || !bpco || !bpf || !decodeStr) return null;

  const decode = decodeStr.split(/\s+/).map(Number);
  const nComps = (decode.length - 4) / 2;

  const streamBytes = objCache.getStreamBytes(shObjNum);
  if (!streamBytes || streamBytes.length === 0) return null;

  const colorEval = buildMeshColorEvaluator(shObjText, objCache);

  // Bit reader
  let bitPos = 0;
  const totalBits = streamBytes.length * 8;

  function readBits(n) {
    let val = 0;
    let rem = n;
    while (rem > 0) {
      const byteIdx = bitPos >>> 3;
      const bitOff = bitPos & 7;
      const avail = 8 - bitOff;
      const take = Math.min(avail, rem);
      const shift = avail - take;
      val = val * (1 << take) + ((streamBytes[byteIdx] >>> shift) & ((1 << take) - 1));
      bitPos += take;
      rem -= take;
    }
    return val;
  }

  const coordMax = 2 ** bpco - 1;
  const compMax = 2 ** bpc - 1;

  function readVertex() {
    const rx = readBits(bpco);
    const ry = readBits(bpco);
    const x = decode[0] + rx * (decode[1] - decode[0]) / coordMax;
    const y = decode[2] + ry * (decode[3] - decode[2]) / coordMax;
    const comps = [];
    for (let i = 0; i < nComps; i++) {
      comps.push(decode[4 + i * 2] + readBits(bpc) * (decode[4 + i * 2 + 1] - decode[4 + i * 2]) / compMax);
    }
    return { coord: [x, y], color: colorEval(comps) };
  }

  const triangles = [];
  let prev = null; // previous triangle vertices/colors for flag 1/2 continuation

  while (bitPos + bpf <= totalBits) {
    const flag = readBits(bpf) & 3;
    if (flag === 0) {
      // New triangle: read 3 vertices (each preceded by its own flag byte;
      // the 2nd and 3rd flags are ignored per spec but still present in the stream)
      const vertexBits = 2 * bpco + nComps * bpc;
      if (bitPos + 3 * vertexBits + 2 * bpf > totalBits) break;
      const v0 = readVertex();
      readBits(bpf); // skip flag of 2nd vertex
      const v1 = readVertex();
      readBits(bpf); // skip flag of 3rd vertex
      const v2 = readVertex();
      const tri = { vertices: [v0.coord, v1.coord, v2.coord], colors: [v0.color, v1.color, v2.color] };
      triangles.push(tri);
      prev = tri;
    } else if (flag === 1 && prev) {
      // Continue from edge v1-v2 of previous triangle
      if (bitPos + 2 * bpco + nComps * bpc > totalBits) break;
      const vNew = readVertex();
      const tri = {
        vertices: [prev.vertices[1], prev.vertices[2], vNew.coord],
        colors: [prev.colors[1], prev.colors[2], vNew.color],
      };
      triangles.push(tri);
      prev = tri;
    } else if (flag === 2 && prev) {
      // Continue from edge v0-v2 of previous triangle
      if (bitPos + 2 * bpco + nComps * bpc > totalBits) break;
      const vNew = readVertex();
      const tri = {
        vertices: [prev.vertices[0], prev.vertices[2], vNew.coord],
        colors: [prev.colors[0], prev.colors[2], vNew.color],
      };
      triangles.push(tri);
      prev = tri;
    } else {
      break;
    }
  }

  if (triangles.length === 0) return null;
  return { type: 'gouraud', triangles };
}

/**
 * Parse a Type 5 (lattice-form Gouraud-shaded triangle mesh) shading.
 * @param {string} shObjText
 * @param {number} shObjNum
 * @param {ObjectCache} objCache
 */
function parseLatticeShading(shObjText, shObjNum, objCache) {
  const bpc = resolveIntValue(shObjText, 'BitsPerComponent', objCache);
  const bpco = resolveIntValue(shObjText, 'BitsPerCoordinate', objCache);
  const vpr = resolveIntValue(shObjText, 'VerticesPerRow', objCache);
  const decodeStr = resolveArrayValue(shObjText, 'Decode', objCache);
  if (!bpc || !bpco || !vpr || vpr < 2 || !decodeStr) return null;

  const decode = decodeStr.split(/\s+/).map(Number);
  const nComps = (decode.length - 4) / 2;

  const streamBytes = objCache.getStreamBytes(shObjNum);
  if (!streamBytes || streamBytes.length === 0) return null;

  const colorEval = buildMeshColorEvaluator(shObjText, objCache);

  // Bit reader
  let bitPos = 0;
  const totalBits = streamBytes.length * 8;
  function readBits(n) {
    let val = 0;
    let rem = n;
    while (rem > 0) {
      const byteIdx = bitPos >>> 3;
      const bitOff = bitPos & 7;
      const avail = 8 - bitOff;
      const take = Math.min(avail, rem);
      const shift = avail - take;
      val = val * (1 << take) + ((streamBytes[byteIdx] >>> shift) & ((1 << take) - 1));
      bitPos += take;
      rem -= take;
    }
    return val;
  }

  const coordMax = 2 ** bpco - 1;
  const compMax = 2 ** bpc - 1;

  // Read all vertices
  const bitsPerVertex = bpco * 2 + bpc * nComps;
  const vertices = [];
  while (bitPos + bitsPerVertex <= totalBits) {
    const rx = readBits(bpco);
    const ry = readBits(bpco);
    const x = decode[0] + rx * (decode[1] - decode[0]) / coordMax;
    const y = decode[2] + ry * (decode[3] - decode[2]) / coordMax;
    const comps = [];
    for (let i = 0; i < nComps; i++) {
      comps.push(decode[4 + i * 2] + readBits(bpc) * (decode[4 + i * 2 + 1] - decode[4 + i * 2]) / compMax);
    }
    vertices.push({ x, y, color: colorEval(comps) });
  }

  const nRows = Math.floor(vertices.length / vpr);
  if (nRows < 2) return null;

  // Convert grid cells to bilinear patches (degree-elevated to cubic for renderMeshPatches)
  const patches = [];
  for (let r = 0; r < nRows - 1; r++) {
    for (let c = 0; c < vpr - 1; c++) {
      const v00 = vertices[r * vpr + c];
      const v01 = vertices[r * vpr + (c + 1)];
      const v10 = vertices[(r + 1) * vpr + c];
      const v11 = vertices[(r + 1) * vpr + (c + 1)];
      const points = [];
      for (let i = 0; i < 4; i++) {
        const si = i / 3;
        const row = [];
        for (let j = 0; j < 4; j++) {
          const sj = j / 3;
          row.push([
            (1 - si) * ((1 - sj) * v00.x + sj * v01.x) + si * ((1 - sj) * v10.x + sj * v11.x),
            (1 - si) * ((1 - sj) * v00.y + sj * v01.y) + si * ((1 - sj) * v10.y + sj * v11.y),
          ]);
        }
        points.push(row);
      }
      // colors: [c00, c03, c33, c30] per renderMeshPatches convention
      patches.push({
        points,
        colors: [v00.color, v01.color, v11.color, v10.color],
      });
    }
  }

  return patches.length > 0 ? { type: 'mesh', patches } : null;
}

/**
 * Parse Shading entries from page resources.
 * Returns a map of shading names to their parsed shading data.
 * @param {string} pageObjText - Raw text of the Page object
 * @param {ObjectCache} objCache - PDF object cache
 */
function parseShadings(pageObjText, objCache) {
  const shadings = new Map();

  // Extract the Resources dict, mirroring parsePageColorSpaces' depth-aware lookup.
  let resourcesText = null;
  const resRefMatch = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(pageObjText);
  if (resRefMatch) {
    resourcesText = objCache.getObjectText(Number(resRefMatch[1])) || null;
  } else {
    const resIdx = pageObjText.indexOf('/Resources');
    if (resIdx !== -1) {
      const dictStart = pageObjText.indexOf('<<', resIdx);
      if (dictStart !== -1) resourcesText = extractDict(pageObjText, dictStart);
    }
  }
  if (!resourcesText) return shadings;

  const shStart = findTopLevelKey(resourcesText, '/Shading');
  if (shStart === -1) return shadings;

  let shDictText;
  const afterSh = resourcesText.substring(shStart + 8).trim();
  if (afterSh.startsWith('<<')) {
    shDictText = extractDict(resourcesText, shStart + 8 + resourcesText.substring(shStart + 8).indexOf('<<'));
  } else {
    const shRefMatch = /^(\d+)\s+\d+\s+R/.exec(afterSh);
    if (shRefMatch) {
      const shObj = objCache.getObjectText(Number(shRefMatch[1]));
      if (shObj) shDictText = shObj;
    }
  }
  if (!shDictText) return shadings;

  // Walk the Shading dict at depth 1 to collect top-level entries. Each entry can be
  // either `/ShName N 0 R` (indirect) or `/ShName << ... >>` (inline). A naive regex
  // would miss all inline forms AND would wrongly match `/Function N 0 R` inside
  // nested inline shading dicts, creating bogus entries.
  /** @type {Array<{name: string, objNum: number, inline: string|null}>} */
  const entries = [];
  {
    let depth = 0;
    let i = 0;
    const n = shDictText.length;
    while (i < n) {
      if (shDictText[i] === '<' && shDictText[i + 1] === '<') {
        depth++;
        i += 2;
      } else if (shDictText[i] === '>' && shDictText[i + 1] === '>') {
        depth--;
        i += 2;
      } else if (depth === 1 && shDictText[i] === '/') {
        const nameMatch = /^\/([^\s/<>[\]]+)/.exec(shDictText.substring(i));
        if (!nameMatch) { i++; continue; }
        let j = i + nameMatch[0].length;
        while (j < n && /\s/.test(shDictText[j])) j++;
        if (shDictText[j] === '<' && shDictText[j + 1] === '<') {
          const inlineDict = extractDict(shDictText, j);
          entries.push({ name: nameMatch[1], objNum: 0, inline: inlineDict });
          i = j + inlineDict.length;
        } else {
          const refMatch = /^(\d+)\s+\d+\s+R/.exec(shDictText.substring(j));
          if (refMatch) {
            entries.push({ name: nameMatch[1], objNum: Number(refMatch[1]), inline: null });
            i = j + refMatch[0].length;
          } else {
            i = j;
          }
        }
      } else {
        i++;
      }
    }
  }

  for (const entry of entries) {
    const shName = entry.name;
    const shObjNum = entry.objNum;
    const shObjText = entry.inline || (shObjNum ? objCache.getObjectText(shObjNum) : null);
    if (!shObjText) continue;

    const typeMatch = /\/ShadingType\s+(\d+)/.exec(shObjText);
    const shadingType = typeMatch ? Number(typeMatch[1]) : 0;

    if (shadingType === 4) {
      const gouraudResult = parseType4Shading(shObjText, shObjNum, objCache);
      if (gouraudResult) shadings.set(shName, gouraudResult);
      continue;
    }
    if (shadingType === 5) {
      const meshResult = parseLatticeShading(shObjText, shObjNum, objCache);
      if (meshResult) shadings.set(shName, meshResult);
      continue;
    }
    if (shadingType === 6 || shadingType === 7) {
      const meshResult = parseMeshShading(shObjText, shObjNum, shadingType, objCache);
      if (meshResult) shadings.set(shName, meshResult);
      continue;
    }

    if (shadingType !== 1 && shadingType !== 2 && shadingType !== 3) continue;

    let coords = null;
    if (shadingType !== 1) {
      const coordsStr = resolveArrayValue(shObjText, 'Coords', objCache);
      if (!coordsStr) continue;
      coords = coordsStr.split(/\s+/).map(Number);
    }

    // Parse /Extend array (defaults to [false, false] per spec)
    const extendStr = resolveArrayValue(shObjText, 'Extend', objCache);
    const extendParts = extendStr ? extendStr.split(/\s+/) : [];
    const extend = [extendParts[0] === 'true', extendParts[1] === 'true'];

    // Parse /BBox (optional clipping rectangle for the shading)
    const bboxStr = resolveArrayValue(shObjText, 'BBox', objCache);
    const bbox = bboxStr ? bboxStr.split(/\s+/).map(Number) : null;

    // Extract the shading's /ColorSpace defining text once so downstream detection can treat its three encodings uniformly:
    // a scalar name (`/DeviceGray`), an inline array (`[/Separation /Black /DeviceCMYK 118 0 R]`), or an indirect reference (`N 0 R`).
    let csText = null;
    const csArrStart = /\/ColorSpace\s*\[/.exec(shObjText);
    if (csArrStart) {
      const bracketIdx = csArrStart.index + csArrStart[0].length - 1;
      let depth = 1;
      let endIdx = bracketIdx + 1;
      while (endIdx < shObjText.length && depth > 0) {
        const ch = shObjText[endIdx];
        if (ch === '[') depth++;
        else if (ch === ']') depth--;
        if (depth > 0) endIdx++;
      }
      csText = shObjText.substring(bracketIdx, endIdx + 1);
    } else {
      const csRefMatch = /\/ColorSpace\s+(\d+)\s+\d+\s+R/.exec(shObjText);
      if (csRefMatch) {
        csText = objCache.getObjectText(Number(csRefMatch[1]));
      } else {
        const csNameMatch = /\/ColorSpace\s*\/(\w+)/.exec(shObjText);
        if (csNameMatch) csText = `/${csNameMatch[1]}`;
      }
    }

    let shadingCS = 'DeviceRGB';
    let isGray = false;
    let sepTintSamples = null;
    /** @type {import('./pdfColorFunctions.js').ParsedTintCS|null} */
    let deviceNTintCS = null;
    let isSeparationShading = false;

    if (csText) {
      if (/\/Separation|\/DeviceN/.test(csText)) {
        isSeparationShading = true;
        // For multi-colorant DeviceN, the 1D tint LUT is wrong (the function
        // emits multiple values that must each pass through the tint transform).
        // Store the parsed tint CS for direct per-stop evaluation below.
        const dnNamesMatch = /\/DeviceN\s*\[\s*((?:\/[^/[\]<>(){}\s]+\s*)+)\]/.exec(csText);
        const dnNumColorants = dnNamesMatch ? (dnNamesMatch[1].match(/\/[^/[\]<>(){}\s]+/g) || []).length : 0;
        if (dnNumColorants >= 2) {
          deviceNTintCS = parseTintColorSpace(csText, objCache);
        } else {
          const tintInfo = parseSeparationTint(csText, objCache);
          if (tintInfo.tintSamples) sepTintSamples = tintInfo.tintSamples;
        }
      } else if (/\/DeviceCMYK/.test(csText)) {
        shadingCS = 'DeviceCMYK';
      } else if (/\/DeviceGray|\/CalGray/.test(csText)) {
        shadingCS = 'DeviceGray';
        isGray = true;
      } else if (/\/DeviceRGB|\/CalRGB/.test(csText)) {
        shadingCS = 'DeviceRGB';
      } else if (/\/ICCBased/.test(csText)) {
        const iccRefMatch = /(\d+)\s+\d+\s+R/.exec(csText);
        if (iccRefMatch) {
          const iccObjText = objCache.getObjectText(Number(iccRefMatch[1]));
          const nMatch = iccObjText && /\/N\s+(\d+)/.exec(iccObjText);
          const nComp = nMatch ? Number(nMatch[1]) : 3;
          if (nComp === 1) { shadingCS = 'DeviceGray'; isGray = true; } else if (nComp === 4) shadingCS = 'DeviceCMYK';
          else shadingCS = 'DeviceRGB';
        }
      }
    }

    if (shadingType === 1) {
      const axial = type1ShadingToAxial(shObjText, objCache, {
        deviceNTintCS, sepTintSamples, isCMYK: shadingCS === 'DeviceCMYK', isGray,
      });
      if (axial) {
        if (bbox) axial.bbox = bbox;
        if (isSeparationShading) axial.multiply = true;
        shadings.set(shName, axial);
      }
      continue;
    }

    // Parse function reference — handle both indirect ref and inline array of refs.
    // /Function may be: (a) a single indirect ref `N 0 R`, (b) an array of refs
    // `[N 0 R M 0 R ...]` where each function produces one output component.
    const funcArrAllMatch = /\/Function\s*\[\s*((?:\d+\s+\d+\s+R\s*)+)\]/.exec(shObjText);
    const funcArrRefs = funcArrAllMatch
      ? [...funcArrAllMatch[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]))
      : null;

    if (funcArrRefs && funcArrRefs.length > 1) {
      const fns = funcArrRefs.map((ref) => parseFunction(ref, objCache));
      const stops = functionToShadingStops(fns, {
        deviceNTintCS, sepTintSamples, isCMYK: shadingCS === 'DeviceCMYK', isGray,
      });
      shadings.set(shName, {
        type: shadingType, coords, stops, extend, bbox, multiply: isSeparationShading,
      });
      continue;
    }

    // Single function ref — either direct `N 0 R` or single-element array `[N 0 R]`
    let funcObjNum;
    if (funcArrRefs && funcArrRefs.length === 1) {
      funcObjNum = funcArrRefs[0];
    } else {
      const funcSingleMatch = /\/Function\s+(\d+)\s+\d+\s+R/.exec(shObjText);
      if (funcSingleMatch) funcObjNum = Number(funcSingleMatch[1]);
    }
    if (funcObjNum == null) continue;

    const fn = parseFunction(funcObjNum, objCache);
    if (!fn) continue;
    const stops = functionToShadingStops(fn, {
      deviceNTintCS, sepTintSamples, isCMYK: shadingCS === 'DeviceCMYK', isGray,
    });
    shadings.set(shName, {
      type: shadingType, coords, stops, extend, bbox, multiply: isSeparationShading,
    });
  }

  return shadings;
}

/**
 * Parse Pattern entries from page resources. For PatternType 2 (shading patterns),
 * extract full shading info (gradient type, coords, color stops) so patterns can
 * be rendered as actual Canvas gradients instead of solid midpoint colors.
 *
 * @param {string} pageObjText
 * @param {ObjectCache} objCache
 * @returns {Map<string, { color: string, shading?: PatternShading, tiling?: TilingPatternRef }>}
 */
function parsePatterns(pageObjText, objCache) {
  const patterns = new Map();

  let resourcesText = pageObjText;
  const resRefMatch = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(pageObjText);
  if (resRefMatch) {
    const resObj = objCache.getObjectText(Number(resRefMatch[1]));
    if (resObj) resourcesText = resObj;
  }

  // Search for /Pattern as a Resources dictionary key (not a color space value like /CS0/Pattern).
  // Skip occurrences where the text after '/Pattern' doesn't start with '<<' or a reference.
  let patDictText;
  let searchFrom = 0;
  while (!patDictText) {
    const patStart = resourcesText.indexOf('/Pattern', searchFrom);
    if (patStart === -1) break;
    const afterPat = resourcesText.substring(patStart + 8).trim();
    if (afterPat.startsWith('<<')) {
      patDictText = extractDict(resourcesText, patStart + 8 + resourcesText.substring(patStart + 8).indexOf('<<'));
    } else {
      const patRefMatch = /^(\d+)\s+\d+\s+R/.exec(afterPat);
      if (patRefMatch) {
        const patObj = objCache.getObjectText(Number(patRefMatch[1]));
        if (patObj) patDictText = patObj;
      }
    }
    searchFrom = patStart + 8;
  }
  if (!patDictText) return patterns;

  const patEntries = [];
  const patEntryRegex = /\/([^\s/<>[\]]+)\s+(\d+)\s+\d+\s+R/g;
  for (const match of patDictText.matchAll(patEntryRegex)) {
    const patObjText = objCache.getObjectText(Number(match[2]));
    if (patObjText) patEntries.push({ patName: match[1], patObjNum: Number(match[2]), patObjText });
  }
  const inlineRegex = /\/([^\s/<>[\]]+)\s*<</g;
  let inlineMatch;
  while ((inlineMatch = inlineRegex.exec(patDictText)) !== null) {
    const patName = inlineMatch[1];
    if (patEntries.some((e) => e.patName === patName)) continue;
    const dictStart = inlineMatch.index + inlineMatch[0].length - 2;
    const inlineDictText = extractDict(patDictText, dictStart);
    if (inlineDictText) patEntries.push({ patName, patObjNum: null, patObjText: inlineDictText });
  }
  for (const { patName, patObjNum, patObjText } of patEntries) {
    const patTypeMatch = /\/PatternType\s+(\d+)/.exec(patObjText);
    const patType = patTypeMatch ? Number(patTypeMatch[1]) : 0;

    if (patType === 1) {
      const bboxStr = resolveArrayValue(patObjText, 'BBox', objCache);
      if (!bboxStr) continue;
      const bbox = bboxStr.split(/\s+/).map(Number);
      const matrixStr = resolveArrayValue(patObjText, 'Matrix', objCache);
      const matrix = matrixStr ? matrixStr.split(/\s+/).map(Number) : [1, 0, 0, 1, 0, 0];
      const xStep = resolveNumValue(patObjText, 'XStep', objCache) || (bbox[2] - bbox[0]);
      const yStep = resolveNumValue(patObjText, 'YStep', objCache) || (bbox[3] - bbox[1]);
      const paintType = resolveIntValue(patObjText, 'PaintType', objCache, 1);
      patterns.set(patName, {
        color: 'rgb(128,128,128)',
        tiling: {
          objNum: patObjNum, bbox, xStep, yStep, matrix, paintType,
        },
      });
      continue;
    }

    if (patType !== 2) continue;

    const shadingIdx = patObjText.indexOf('/Shading');
    if (shadingIdx === -1) continue;
    let shadingDict;
    const afterShading = patObjText.substring(shadingIdx + 8).trim();
    const shadingRefMatch = /^(\d+)\s+\d+\s+R/.exec(afterShading);
    if (shadingRefMatch) {
      shadingDict = objCache.getObjectText(Number(shadingRefMatch[1]));
    } else {
      const shadingDictStart = patObjText.indexOf('<<', shadingIdx + 8);
      if (shadingDictStart !== -1) shadingDict = extractDict(patObjText, shadingDictStart);
    }
    if (!shadingDict) continue;

    // /ColorSpace may be a scalar name `/DeviceRGB`,
    // an inline array `[/ICCBased N 0 R]` or `[/Separation ...]`, or an indirect reference `N 0 R`.
    // Extract the defining text once so the family tests below treat all forms alike.
    let patCsText = null;
    const patCsArrStart = /\/ColorSpace\s*\[/.exec(shadingDict);
    if (patCsArrStart) {
      const bracketIdx = patCsArrStart.index + patCsArrStart[0].length - 1;
      let depth = 1;
      let endIdx = bracketIdx + 1;
      while (endIdx < shadingDict.length && depth > 0) {
        const ch = shadingDict[endIdx];
        if (ch === '[') depth++;
        else if (ch === ']') depth--;
        if (depth > 0) endIdx++;
      }
      patCsText = shadingDict.substring(bracketIdx, endIdx + 1);
    } else {
      const csRefMatch = /\/ColorSpace\s+(\d+)\s+\d+\s+R/.exec(shadingDict);
      if (csRefMatch) {
        patCsText = objCache.getObjectText(Number(csRefMatch[1]));
      } else {
        const csNameMatch = /\/ColorSpace\s*\/(\w+)/.exec(shadingDict);
        if (csNameMatch) patCsText = `/${csNameMatch[1]}`;
      }
    }

    let patShadingCS = 'DeviceRGB';
    let patSepTintSamples = null;
    /** @type {import('./pdfColorFunctions.js').ParsedTintCS|null} */
    let patDeviceNTintCS = null;

    if (patCsText) {
      if (/\/Separation|\/DeviceN/.test(patCsText)) {
        // For multi-colorant DeviceN (e.g. 5-channel PANTONE+CMYK), the 1D diagonal tint LUT is wrong.
        // Each function output must go through the multi-input tint transform as a full N-tuple,
        // so parse the tint CS directly and route every Type 2/3 stop through it
        // with all C0->C1 components jointly. Single-colorant DeviceN uses the 1D LUT.
        const dnNamesMatch = /\/DeviceN\s*\[\s*((?:\/[^/[\]<>(){}\s]+\s*)+)\]/.exec(patCsText);
        const dnNumColorants = dnNamesMatch
          ? (dnNamesMatch[1].match(/\/[^/[\]<>(){}\s]+/g) || []).length
          : 0;
        if (dnNumColorants >= 2) {
          patDeviceNTintCS = parseTintColorSpace(patCsText, objCache);
        } else {
          const tintInfo = parseSeparationTint(patCsText, objCache);
          if (tintInfo.tintSamples) patSepTintSamples = tintInfo.tintSamples;
        }
        patShadingCS = 'Separation';
      } else if (/\/DeviceCMYK/.test(patCsText)) {
        patShadingCS = 'DeviceCMYK';
      } else if (/\/DeviceGray|\/CalGray/.test(patCsText)) {
        patShadingCS = 'DeviceGray';
      } else if (/\/DeviceRGB|\/CalRGB/.test(patCsText)) {
        patShadingCS = 'DeviceRGB';
      } else if (/\/ICCBased/.test(patCsText)) {
        const iccRefMatch = /(\d+)\s+\d+\s+R/.exec(patCsText);
        if (iccRefMatch) {
          const iccObjText = objCache.getObjectText(Number(iccRefMatch[1]));
          const nMatch = iccObjText && /\/N\s+(\d+)/.exec(iccObjText);
          const nComp = nMatch ? Number(nMatch[1]) : 3;
          patShadingCS = nComp === 1 ? 'DeviceGray' : nComp === 4 ? 'DeviceCMYK' : 'DeviceRGB';
        }
      }
    }
    if (patShadingCS !== 'DeviceRGB' && patShadingCS !== 'DeviceGray' && patShadingCS !== 'DeviceCMYK' && !patSepTintSamples && !patDeviceNTintCS) continue;
    const patIsGray = patShadingCS === 'DeviceGray';
    const patIsCMYK = patShadingCS === 'DeviceCMYK';

    const shadingTypeMatch = /\/ShadingType\s+(\d+)/.exec(shadingDict);
    const shadingType = shadingTypeMatch ? Number(shadingTypeMatch[1]) : 0;

    // Handle Gouraud triangle mesh in patterns (type 4)
    if (shadingType === 4) {
      const shObjNum = shadingRefMatch ? Number(shadingRefMatch[1]) : null;
      if (shObjNum) {
        const gouraudResult = parseType4Shading(shadingDict, shObjNum, objCache);
        if (gouraudResult) {
          const matrixStr = resolveArrayValue(patObjText, 'Matrix', objCache);
          const matrix = matrixStr ? matrixStr.split(/\s+/).map(Number) : null;
          if (matrix) gouraudResult.matrix = matrix;
          patterns.set(patName, { color: 'rgb(128,128,128)', shading: gouraudResult });
        }
      }
      continue;
    }

    // Handle mesh-type shadings in patterns (types 5, 6, 7)
    if (shadingType === 5 || shadingType === 6 || shadingType === 7) {
      const shObjNum = shadingRefMatch ? Number(shadingRefMatch[1]) : null;
      let meshResult;
      if (shadingType === 5 && shObjNum) {
        meshResult = parseLatticeShading(shadingDict, shObjNum, objCache);
      } else if (shObjNum) {
        meshResult = parseMeshShading(shadingDict, shObjNum, shadingType, objCache);
      }
      if (meshResult) {
        const matrixStr = resolveArrayValue(patObjText, 'Matrix', objCache);
        const matrix = matrixStr ? matrixStr.split(/\s+/).map(Number) : null;
        if (matrix) meshResult.matrix = matrix;
        patterns.set(patName, { color: 'rgb(128,128,128)', shading: meshResult });
      }
      continue;
    }

    if (shadingType === 1) {
      const axial = type1ShadingToAxial(shadingDict, objCache, {
        deviceNTintCS: patDeviceNTintCS, sepTintSamples: patSepTintSamples, isCMYK: patIsCMYK, isGray: patIsGray,
      });
      if (axial) {
        const matrixStr = resolveArrayValue(patObjText, 'Matrix', objCache);
        const matrix = matrixStr ? matrixStr.split(/\s+/).map(Number) : null;
        if (matrix) axial.matrix = matrix;
        const color = axial.stops[Math.floor(axial.stops.length / 2)]?.color || 'rgb(128,128,128)';
        patterns.set(patName, { color, shading: axial });
      }
      continue;
    }

    if (shadingType !== 2 && shadingType !== 3) continue;

    const coordsStr = resolveArrayValue(shadingDict, 'Coords', objCache);
    if (!coordsStr) continue;
    const coords = coordsStr.split(/\s+/).map(Number);

    // Parse /Extend array (defaults to [false, false] per spec)
    const extendStr = resolveArrayValue(shadingDict, 'Extend', objCache);
    const extendParts = extendStr ? extendStr.split(/\s+/) : [];
    const extend = [extendParts[0] === 'true', extendParts[1] === 'true'];

    // Parse /BBox (optional clipping rectangle for the shading)
    const bboxStr = resolveArrayValue(shadingDict, 'BBox', objCache);
    const bbox = bboxStr ? bboxStr.split(/\s+/).map(Number) : null;

    // Parse /Matrix (pattern space to user space transform, default identity)
    const matrixStr = resolveArrayValue(patObjText, 'Matrix', objCache);
    const matrix = matrixStr ? matrixStr.split(/\s+/).map(Number) : null;

    let funcDictText;
    let funcObjNum;
    const funcRefMatch = /\/Function\s+(\d+)\s+\d+\s+R/.exec(shadingDict);
    if (funcRefMatch) {
      funcObjNum = Number(funcRefMatch[1]);
      funcDictText = objCache.getObjectText(funcObjNum);
    } else {
      // Try inline function dict
      const funcDictStart = shadingDict.indexOf('/Function');
      if (funcDictStart !== -1) {
        const funcDictOpen = shadingDict.indexOf('<<', funcDictStart + 9);
        if (funcDictOpen !== -1) funcDictText = extractDict(shadingDict, funcDictOpen);
      }
    }
    const fn = funcDictText
      ? parseFunction(funcObjNum != null ? funcObjNum : funcDictText, objCache)
      : null;
    if (fn) {
      const stops = functionToShadingStops(fn, {
        deviceNTintCS: patDeviceNTintCS, sepTintSamples: patSepTintSamples, isCMYK: patIsCMYK, isGray: patIsGray,
      });
      const shading = {
        type: shadingType, coords, stops, extend, ...(bbox && { bbox }), ...(matrix && { matrix }),
      };
      const color = stops[Math.floor(stops.length / 2)]?.color || 'rgb(128,128,128)';
      patterns.set(patName, { color, shading });
    }
  }

  return patterns;
}

/**
 * Tile-canvas pixel size for a tiling pattern at a given device scale, clamped
 * so neither axis exceeds the canvas dimension limit. Producer and consumers
 * must compute this identically or the pattern-space transform will be wrong.
 *
 * @param {number} bboxW
 * @param {number} bboxH
 * @param {number} matScaleX
 * @param {number} matScaleY
 * @param {number} scale
 * @returns {{ tileW: number, tileH: number }}
 */
function tilingTilePixelDims(bboxW, bboxH, matScaleX, matScaleY, scale) {
  let tileW = Math.max(1, Math.round(bboxW * matScaleX * scale));
  let tileH = Math.max(1, Math.round(bboxH * matScaleY * scale));
  const maxDim = 4096;
  if (tileW > maxDim || tileH > maxDim) {
    const reduce = Math.min(maxDim / tileW, maxDim / tileH);
    tileW = Math.max(1, Math.round(tileW * reduce));
    tileH = Math.max(1, Math.round(tileH * reduce));
  }
  return { tileW, tileH };
}

/**
 * Render the contents of a tiling pattern to a tile-sized canvas.
 * Used by `renderSMaskToCanvas` when the mask form fills with a tiling pattern.
 *
 * @param {{ objNum: number, bbox: number[], matrix: number[] }} tp
 * @param {ObjectCache} objCache
 * @param {number} scale
 */
async function renderTilingPatternTileForSmask(tp, objCache, scale) {
  const patObjText = objCache.getObjectText(tp.objNum);
  const patStreamBytes = objCache.getStreamBytes(tp.objNum);
  if (!patObjText || !patStreamBytes) return null;

  let patResText = patObjText;
  const patResRef = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(patObjText);
  if (patResRef) {
    const resObj = objCache.getObjectText(Number(patResRef[1]));
    if (resObj) patResText = resObj;
  }

  const { images: patImages, forms: patForms } = parsePageImages(patResText, objCache, { recurseForms: false });
  const patExtGStates = parseExtGStates(patObjText, objCache);
  const patPatterns = parsePatterns(patObjText, objCache);

  const patStream = bytesToLatin1(patStreamBytes);
  const rawPatDrawOps = parseDrawOps(patStream, new Map(), patExtGStates, new Map(), new Map(),
    new Set(), new Set(), new Set(), new Map(), patPatterns);

  let patDrawOps;
  if (patForms.size > 0) {
    patDrawOps = [];
    for (const op of rawPatDrawOps) {
      if (op.type === 'image' && patForms.has(op.name)) {
        const sub = await flattenDrawOps(
          [op], patImages, patForms, objCache, new Map(), new Map(),
          '', 0, new Set(), new Set(), patExtGStates, new Set(),
          new Map(), 0, new Set(), new Map(),
          'black', 'rgb(0,0,0)',
          1, 1,
          null, null,
        );
        for (const sop of sub) patDrawOps.push(sop);
      } else {
        patDrawOps.push(op);
      }
    }
  } else {
    patDrawOps = rawPatDrawOps;
  }

  const bboxW = tp.bbox[2] - tp.bbox[0];
  const bboxH = tp.bbox[3] - tp.bbox[1];
  const matScaleX = Math.sqrt(tp.matrix[0] * tp.matrix[0] + tp.matrix[1] * tp.matrix[1]) || 1;
  const matScaleY = Math.sqrt(tp.matrix[2] * tp.matrix[2] + tp.matrix[3] * tp.matrix[3]) || 1;
  let tileW = Math.max(1, Math.round(bboxW * matScaleX * scale));
  let tileH = Math.max(1, Math.round(bboxH * matScaleY * scale));
  const maxDim = 4096;
  if (tileW > maxDim || tileH > maxDim) {
    const reduceFactor = Math.min(maxDim / tileW, maxDim / tileH);
    tileW = Math.max(1, Math.round(tileW * reduceFactor));
    tileH = Math.max(1, Math.round(tileH * reduceFactor));
  }

  const tileCanvas = ca.makeCanvas(tileW, tileH);
  const tileCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (tileCanvas.getContext('2d', { willReadFrequently: true }));
  const tileScaleX = tileW / bboxW;
  const tileScaleY = tileH / bboxH;

  for (const pop of patDrawOps) {
    if (pop.type === 'image') {
      const imageInfo = patImages.get(pop.name);
      if (!imageInfo) continue;
      const bitmap = imageInfo.imageMask
        ? await imageMaskToBitmap(imageInfo, pop.fillColor || 'black', objCache)
        : await imageInfoToBitmap(imageInfo, objCache);
      if (!bitmap) continue;
      tileCtx.save();
      tileCtx.setTransform(
        pop.ctm[0] * tileScaleX, -pop.ctm[1] * tileScaleY,
        pop.ctm[2] * tileScaleX, -pop.ctm[3] * tileScaleY,
        (pop.ctm[4] - tp.bbox[0]) * tileScaleX,
        (bboxH + tp.bbox[1] - pop.ctm[5]) * tileScaleY,
      );
      tileCtx.transform(1, 0, 0, -1, 0, 1);
      tileCtx.drawImage(bitmap, 0, 0, 1, 1);
      tileCtx.restore();
      ca.closeDrawable(bitmap);
    } else if (pop.type === 'path' && pop.fill) {
      tileCtx.save();
      if (pop.fillAlpha < 1) tileCtx.globalAlpha = pop.fillAlpha;
      tileCtx.setTransform(
        pop.ctm[0] * tileScaleX, -pop.ctm[1] * tileScaleY,
        pop.ctm[2] * tileScaleX, -pop.ctm[3] * tileScaleY,
        (pop.ctm[4] - tp.bbox[0]) * tileScaleX,
        (bboxH + tp.bbox[1] - pop.ctm[5]) * tileScaleY,
      );
      tileCtx.beginPath();
      for (const cmd of pop.commands) {
        switch (cmd.type) {
          case 'M': tileCtx.moveTo(cmd.x, cmd.y); break;
          case 'L': tileCtx.lineTo(cmd.x, cmd.y); break;
          case 'C': tileCtx.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y); break;
          case 'Z': tileCtx.closePath(); break;
          default: break;
        }
      }
      tileCtx.fillStyle = pop.fillColor || 'black';
      tileCtx.fill(pop.evenOdd ? 'evenodd' : 'nonzero');
      tileCtx.restore();
    }
  }

  return tileCanvas;
}

/**
 * Decode an inline image (BI/ID/EI) and return an ImageBitmap.
 * Supports image masks with CCITTFaxDecode, DCTDecode (JPEG), and uncompressed data.
 * @param {{dictText: string, imageData: string, fillColor?: string, fillAlpha?: number, tilingPattern?: any, colorSpaces?: Map<string, any>}} op
 * @param {ObjectCache} objCache
 * @param {Map<string, any>} [fallbackColorSpaces] - page-level color-space registry used when op.colorSpaces is absent
 */
async function decodeInlineImageBitmap(op, objCache, fallbackColorSpaces = new Map()) {
  const { dictText, imageData } = op;
  const getVal = (abbrev, full) => {
    const re = new RegExp(`/${abbrev}(?![a-zA-Z])\\s*/?([^\\s/<>]+)`);
    const m = re.exec(dictText) || new RegExp(`/${full}(?![a-zA-Z])\\s*/?([^\\s/<>]+)`).exec(dictText);
    return m ? m[1] : null;
  };
  const getArr = (abbrev, full) => {
    const re = new RegExp(`/${abbrev}(?![a-zA-Z])\\s*\\[\\s*([^\\]]+)\\]`);
    const m = re.exec(dictText) || new RegExp(`/${full}(?![a-zA-Z])\\s*\\[\\s*([^\\]]+)\\]`).exec(dictText);
    return m ? m[1].trim().split(/\s+/).map(Number) : null;
  };
  const width = Number(getVal('W', 'Width') || 0);
  const height = Number(getVal('H', 'Height') || 0);
  if (!width || !height) return null;
  const bpc = Number(getVal('BPC', 'BitsPerComponent') || 8);
  const isImageMask = getVal('IM', 'ImageMask') === 'true';
  const decode = getArr('D', 'Decode');
  const filterMap = {
    CCF: 'CCITTFaxDecode',
    DCT: 'DCTDecode',
    Fl: 'FlateDecode',
    LZW: 'LZWDecode',
    RL: 'RunLengthDecode',
    AHx: 'ASCIIHexDecode',
    A85: 'ASCII85Decode',
  };
  let filters;
  const filterArrMatch = /\/(?:F|Filter)\s*\[\s*([^\]]+)\]/.exec(dictText);
  if (filterArrMatch) {
    // Names self-delimit on `/`, so the array may have no whitespace (e.g. `[/A85/Fl]`).
    filters = (filterArrMatch[1].match(/\/[^\s/\]]+/g) || []).map((f) => {
      const name = f.replace(/^\//, '');
      return filterMap[name] || name;
    });
  } else {
    const filterRaw = getVal('F', 'Filter') || '';
    const f = filterMap[filterRaw] || filterRaw;
    filters = f ? [f] : [];
  }
  const csRaw = getVal('CS', 'ColorSpace') || '';
  const csMap = { G: 'DeviceGray', RGB: 'DeviceRGB', CMYK: 'DeviceCMYK' };
  let colorSpace = csMap[csRaw] || csRaw;
  /** @type {{type: string, indexedInfo: any, tintSamples: Uint8Array|null, nComponents: number, deviceNGrid: any}|null} */
  let resolvedCS = null;
  if (!['DeviceGray', 'DeviceRGB', 'DeviceCMYK'].includes(colorSpace)) {
    const csRegistry = op.colorSpaces || fallbackColorSpaces;
    const entry = csRegistry.get(csRaw);
    if (entry) {
      resolvedCS = entry;
      if (entry.type === 'Indexed') {
        colorSpace = 'Indexed';
      } else if (entry.type === 'Separation' || entry.type === 'DeviceN') {
        colorSpace = entry.type;
      } else if (entry.type === 'DeviceRGB' || entry.type === 'CalRGB') {
        colorSpace = 'DeviceRGB';
      } else if (entry.type === 'DeviceCMYK') {
        colorSpace = 'DeviceCMYK';
      } else if (entry.type === 'DeviceGray' || entry.type === 'CalGray') {
        colorSpace = 'DeviceGray';
      }
    }
    if (!resolvedCS) {
      const csKeyMatch = /\/(?:CS|ColorSpace)\s*\[/.exec(dictText);
      if (csKeyMatch) {
        const arrStart = dictText.indexOf('[', csKeyMatch.index);
        let depth = 0;
        let arrEnd = arrStart;
        for (let ci = arrStart; ci < dictText.length; ci++) {
          if (dictText[ci] === '[') depth++;
          else if (dictText[ci] === ']') { depth--; if (depth === 0) { arrEnd = ci + 1; break; } }
        }
        const csText = dictText.substring(arrStart, arrEnd)
          .replace(/\/([A-Za-z][\w-]*)/g, ' /$1 ')
          .replace(/\/I\b/, '/Indexed')
          .replace(/\/RGB\b/, '/DeviceRGB')
          .replace(/\/G\b/, '/DeviceGray')
          .replace(/\/CMYK\b/, '/DeviceCMYK');
        if (/\/Indexed\b/.test(csText)) {
          const idxResult = parseIndexedColorSpace(csText, objCache);
          if (idxResult) {
            colorSpace = 'Indexed';
            resolvedCS = {
              type: 'Indexed', indexedInfo: idxResult, tintSamples: null, nComponents: 1, deviceNGrid: null,
            };
          }
        }
      }
    }
  }

  let data = new Uint8Array(imageData.length);
  for (let j = 0; j < imageData.length; j++) data[j] = imageData.charCodeAt(j);

  // Decode the filter chain to raw sample bytes.
  // DCTDecode/JPXDecode are image codecs handled downstream by imageInfoToBitmap,
  // so stop at the first one and pass its compressed bytes through unchanged.
  let imageCodec = null;
  for (const filter of filters) {
    if (filter === 'DCTDecode' || filter === 'JPXDecode') { imageCodec = filter; break; }
    if (filter === 'ASCII85Decode') {
      const ascii = new TextDecoder('latin1').decode(data);
      const clean = ascii.replace(/\s/g, '');
      const endMarker = clean.indexOf('~>');
      const encoded = endMarker >= 0 ? clean.substring(0, endMarker) : clean;
      const output = [];
      let ai = 0;
      while (ai < encoded.length) {
        if (encoded[ai] === 'z') {
          output.push(0, 0, 0, 0);
          ai++;
        } else {
          const groupLen = Math.min(5, encoded.length - ai);
          const group = [];
          for (let gj = 0; gj < groupLen; gj++) group.push(encoded.charCodeAt(ai + gj) - 33);
          while (group.length < 5) group.push(84);
          let val = 0;
          for (let gj = 0; gj < 5; gj++) val = val * 85 + group[gj];
          const numBytes = groupLen === 5 ? 4 : groupLen - 1;
          const divisors = [16777216, 65536, 256, 1];
          for (let gj = 0; gj < numBytes; gj++) output.push(Math.floor(val / divisors[gj]) % 256);
          ai += groupLen;
        }
      }
      data = new Uint8Array(output);
    } else if (filter === 'ASCIIHexDecode') {
      const hex = new TextDecoder('latin1').decode(data).replace(/\s/g, '').replace(/>$/, '');
      const out = new Uint8Array(Math.floor(hex.length / 2));
      for (let hi = 0; hi < out.length; hi++) out[hi] = parseInt(hex.substring(hi * 2, hi * 2 + 2), 16);
      data = out;
    } else if (filter === 'CCITTFaxDecode') {
      const { decodeCCITTFax } = await import('./codecs/decodeCCITT.js');
      const dpText = dictText;
      const params = {};
      const kMatch = /\/K\s+(-?\d+)/.exec(dpText) || /\/DP\s*<<[^>]*\/K\s+(-?\d+)/.exec(dpText);
      if (kMatch) params.K = Number(kMatch[1] || kMatch[2]);
      const colMatch = /\/Columns\s+(\d+)/.exec(dpText) || /\/DP\s*<<[^>]*\/Columns\s+(\d+)/.exec(dpText);
      if (colMatch) params.Columns = Number(colMatch[1] || colMatch[2]);
      else params.Columns = width;
      const blackIs1Match = /\/BlackIs1\s+true/.exec(dpText);
      if (blackIs1Match) params.BlackIs1 = true;
      params.Rows = height;
      params.EndOfBlock = false;
      const decoded = decodeCCITTFax(data, params);
      data = new Uint8Array(decoded.buffer);
    } else if (filter === 'FlateDecode') {
      let inflated = pakoInflate(data);
      if (!(inflated instanceof Uint8Array)) inflated = pakoInflatePartial(data);
      data = inflated;
      const dpMatch = /\/(?:DP|DecodeParms)\s*(?:\[\s*(?:null\s*)?)?<<([^>]*)>>/.exec(dictText);
      if (dpMatch) {
        let dpText = dpMatch[1];
        if (!/\/Columns\s+\d+/.test(dpText)) dpText = `/Columns ${width} ${dpText}`;
        data = applyPredictor(data, dpText, objCache);
      }
    } else if (filter === 'LZWDecode') {
      const { decodeLZW } = await import('./codecs/decodeLZW.js');
      data = decodeLZW(data, dictText);
    } else if (filter === 'RunLengthDecode') {
      const output = [];
      let pos = 0;
      while (pos < data.length) {
        const len = data[pos++];
        if (len < 128) {
          for (let k = 0; k < len + 1 && pos < data.length; k++) output.push(data[pos++]);
        } else if (len > 128) {
          const val = pos < data.length ? data[pos++] : 0;
          for (let k = 0; k < 257 - len; k++) output.push(val);
        } else break;
      }
      data = new Uint8Array(output);
    }
  }

  const invert = !!(decode && decode[0] === 1);

  // Hand the decoded samples to the shared XObject decoders
  // so inline images go through the same colour-space conversion
  // (sub-byte depths, /Decode, Lab, ICC, CMYK JPEG, ...) instead of a parallel subset.
  /** @type {import('./parsePdfImages.js').ImageInfo} */
  const imageInfo = {
    width,
    height,
    bitsPerComponent: bpc,
    colorSpace,
    filter: imageCodec,
    imageData: data,
    objNum: -1,
    sMask: null,
    sMaskWidth: null,
    sMaskHeight: null,
    sMaskDecodeInvert: false,
    palette: null,
    paletteBase: null,
    imageMask: isImageMask,
    decodeInvert: invert,
    separationTintSamples: null,
    deviceNTintCS: null,
    iccProfileObjNum: null,
    iccTransform: null,
    labWhitePoint: null,
    labRange: null,
    paletteHival: null,
    colorKeyMask: null,
    transparentWhite: !!op.tilingPattern,
  };

  if (isImageMask) {
    if (!op.fillColor || op.fillColor.includes('NaN')) return null;
    return imageMaskToBitmap(imageInfo, op.fillColor, objCache);
  }

  if (resolvedCS) {
    if (resolvedCS.indexedInfo) {
      imageInfo.palette = resolvedCS.indexedInfo.palette;
      imageInfo.paletteBase = resolvedCS.indexedInfo.base;
      imageInfo.paletteHival = resolvedCS.indexedInfo.hival;
      // CCITTFaxDecode emits 0=black, 1=white, used directly as the index into the 2-entry fax palette.
      // Invert (idx = hival - idx) only when entry 0 is the lighter color, so the fax's black runs land on the darker entry.
      // A black-at-index-0 palette (e.g. <00ff>) already maps correctly.
      // Inverting it would paint the ink in the background color, rendering the image invisible.
      if (bpc === 1 && imageCodec == null && filters.includes('CCITTFaxDecode')
          && !decode && resolvedCS.indexedInfo.hival === 1) {
        const pal = resolvedCS.indexedInfo.palette;
        const nComp = resolvedCS.indexedInfo.base === 'DeviceCMYK' ? 4
          : (resolvedCS.indexedInfo.base === 'DeviceGray' || resolvedCS.indexedInfo.base === 'CalGray' ? 1 : 3);
        const brightness = (o) => {
          if (nComp === 1) return pal[o];
          if (nComp === 4) {
            const [r, g, b] = cmykToRgb(pal[o] / 255, pal[o + 1] / 255, pal[o + 2] / 255, pal[o + 3] / 255);
            return 0.299 * r + 0.587 * g + 0.114 * b;
          }
          return 0.299 * pal[o] + 0.587 * pal[o + 1] + 0.114 * pal[o + 2];
        };
        if (pal && brightness(0) > brightness(nComp)) imageInfo.decodeInvert = true;
      }
    }
    // Single-input DeviceN reduces to a 1-D tint LUT, same as Separation.
    if (resolvedCS.tintSamples) {
      imageInfo.separationTintSamples = resolvedCS.tintSamples;
      imageInfo.colorSpace = 'Separation';
    }
  }
  return imageInfoToBitmap(imageInfo, objCache);
}

/**
 * Render an SMask Form XObject to a canvas and produce an alpha mask.
 * @param {SmaskRef} smaskInfo
 * @param {ObjectCache} objCache
 * @param {number} canvasWidth
 * @param {number} canvasHeight
 * @param {number} pageHeightPts
 * @param {number} boxOriginX
 * @param {number} boxOriginY
 * @param {number} scale
 * @param {{ x: number, y: number, width: number, height: number }|null} [bbox=null]
 */
async function renderSMaskToCanvas(smaskInfo, objCache, canvasWidth, canvasHeight, pageHeightPts, boxOriginX, boxOriginY, scale, bbox = null) {
  const formObjText = objCache.getObjectText(smaskInfo.formObjNum);
  if (!formObjText) return null;

  const { images: maskImages, forms: maskForms } = parsePageImages(formObjText, objCache, { recurseForms: true });

  const streamBytes = objCache.getStreamBytes(smaskInfo.formObjNum);
  if (!streamBytes) return null;
  const formStream = bytesToLatin1(streamBytes);

  const maskExtGStates = parseExtGStates(formObjText, objCache);
  const maskShadings = parseShadings(formObjText, objCache);
  const maskPatterns = parsePatterns(formObjText, objCache);
  const maskColorSpaces = parsePageColorSpaces(formObjText, objCache);

  const maskFonts = parsePageFonts(formObjText, objCache);
  const maskRegistered = new Map();
  const maskSymbolTags = new Set();
  const maskCidPUATags = new Set();
  const maskRawCharCodeTags = new Set();
  const maskCidCollisionMap = new Map();
  for (const [fontTag, fontObj] of maskFonts) {
    const familyName = pdfFontFamilyName(objCache, fontObj.fontObjNum, `smask_${smaskInfo.formObjNum}_${fontTag}`);
    await convertAndRegisterFont(
      fontTag, fontObj, maskRegistered, maskSymbolTags, maskCidPUATags,
      maskRawCharCodeTags, maskCidCollisionMap, objCache, familyName,
    );
  }
  appendGenericFallbacks(maskRegistered, maskFonts);

  const rawFormDrawOps = parseDrawOps(formStream, maskFonts, maskExtGStates, maskRegistered, maskColorSpaces,
    maskSymbolTags, maskCidPUATags, maskRawCharCodeTags, maskShadings, maskPatterns, maskCidCollisionMap);

  let formDrawOps;
  if (maskForms.size > 0) {
    formDrawOps = [];
    for (const op of rawFormDrawOps) {
      if (op.type === 'image' && maskForms.has(op.name)) {
        const sub = await flattenDrawOps(
          [op], maskImages, maskForms, objCache, maskFonts, maskRegistered,
          '', 0, maskSymbolTags, maskCidPUATags, maskExtGStates, maskRawCharCodeTags,
          new Map(), 0, new Set(), maskCidCollisionMap,
          'black', 'rgb(0,0,0)',
          1, 1,
          null, null,
        );
        for (const sop of sub) formDrawOps.push(sop);
      } else {
        formDrawOps.push(op);
      }
    }
  } else {
    formDrawOps = rawFormDrawOps;
  }

  // Apply the form's own /Matrix to each op's CTM (maps form space -> user space).
  const formMatrix = parseFormMatrix(formObjText);
  for (const op of formDrawOps) {
    if (op.ctm) op.ctm = matMul(op.ctm, formMatrix);
  }

  // PDF spec §11.6.5.1: SMask is positioned by the parent CTM at the time
  // /gs set the soft mask. Apply that parent CTM to every op so the mask form
  // ends up in the correct page coordinates (e.g., aligned with each annotation
  // column when the same SMask shape is referenced from multiple annotations).
  if (smaskInfo.parentCtm && smaskInfo.parentCtm.length === 6) {
    for (const op of formDrawOps) {
      const opAny = /** @type {any} */ (op);
      if (opAny.ctm) opAny.ctm = matMul(opAny.ctm, smaskInfo.parentCtm);
      if (opAny.clips) {
        for (const clip of opAny.clips) {
          clip.ctm = matMul(clip.ctm, smaskInfo.parentCtm);
        }
      }
    }
  }

  // Render the mask content to a canvas. When `bbox` is provided, allocate a tight
  // canvas sized to the bbox and shift coordinates so the bbox origin lands at (0,0).
  // This is a ~50x speedup for pages with many per-image soft masks where each mask
  // only covers a small portion of the page.
  const maskW = bbox ? bbox.width : canvasWidth;
  const maskH = bbox ? bbox.height : canvasHeight;
  const shiftX = bbox ? bbox.x : 0;
  const shiftY = bbox ? bbox.y : 0;
  const maskCanvas = ca.makeCanvas(maskW, maskH);
  const maskCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (maskCanvas.getContext('2d', { willReadFrequently: true }));

  // For /S/Luminosity, composite the mask group over an opaque backdrop of colour /BC
  // (PDF spec 11.6.5.2, default black), so areas the group leaves unpainted take the
  // backdrop's luminosity rather than alpha 0.
  // For /S/Alpha, leave the canvas fully transparent. The alpha channel itself is the mask.
  const isAlphaMask = smaskInfo.type === 'Alpha';
  if (!isAlphaMask) {
    const bc = smaskInfo.bc;
    let bcColor = 'black';
    if (bc && bc.length === 1) {
      const v = Math.round(Math.max(0, Math.min(1, bc[0])) * 255);
      bcColor = `rgb(${v},${v},${v})`;
    } else if (bc && bc.length === 3) {
      bcColor = `rgb(${Math.round(bc[0] * 255)},${Math.round(bc[1] * 255)},${Math.round(bc[2] * 255)})`;
    } else if (bc && bc.length === 4) {
      const [r, g, b] = cmykToRgb(bc[0], bc[1], bc[2], bc[3]);
      bcColor = `rgb(${r},${g},${b})`;
    }
    maskCtx.fillStyle = bcColor;
    maskCtx.fillRect(0, 0, maskW, maskH);
  }

  for (const op of formDrawOps) {
    if (op.type === 'image') {
      const imageInfo = maskImages.get(op.name);
      if (!imageInfo) continue;

      const bitmap = imageInfo.imageMask
        ? await imageMaskToBitmap(imageInfo, 'white', objCache)
        : await imageInfoToBitmap(imageInfo, objCache);

      maskCtx.save();
      if (op.fillAlpha < 1) maskCtx.globalAlpha = op.fillAlpha;
      // Apply clip paths (e.g., circular clips that define the mask shape)
      if (op.clips) {
        for (const clip of op.clips) {
          if (!clip.path) continue;
          maskCtx.setTransform(
            clip.ctm[0] * scale, -clip.ctm[1] * scale, clip.ctm[2] * scale, -clip.ctm[3] * scale,
            (clip.ctm[4] - boxOriginX) * scale - shiftX, (pageHeightPts + boxOriginY - clip.ctm[5]) * scale - shiftY,
          );
          maskCtx.beginPath();
          for (const cmd of clip.path) {
            if (cmd.type === 'M') maskCtx.moveTo(cmd.x, cmd.y);
            else if (cmd.type === 'L') maskCtx.lineTo(cmd.x, cmd.y);
            else if (cmd.type === 'C') maskCtx.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y);
            else if (cmd.type === 'Z') maskCtx.closePath();
          }
          maskCtx.clip(clip.evenOdd ? 'evenodd' : 'nonzero');
        }
      }
      maskCtx.setTransform(
        op.ctm[0] * scale,
        -op.ctm[1] * scale,
        op.ctm[2] * scale,
        -op.ctm[3] * scale,
        (op.ctm[4] - boxOriginX) * scale - shiftX,
        (pageHeightPts + boxOriginY - op.ctm[5]) * scale - shiftY,
      );
      maskCtx.transform(1, 0, 0, -1, 0, 1);
      maskCtx.drawImage(bitmap, 0, 0, 1, 1);
      maskCtx.restore();
      ca.closeDrawable(bitmap);
    } else if (op.type === 'shading') {
      const sh = op.shading;
      maskCtx.save();
      if (op.fillAlpha < 1) maskCtx.globalAlpha = op.fillAlpha;
      // Apply clip paths for shading ops too
      if (op.clips) {
        for (const clip of op.clips) {
          if (!clip.path) continue;
          maskCtx.setTransform(
            clip.ctm[0] * scale, -clip.ctm[1] * scale, clip.ctm[2] * scale, -clip.ctm[3] * scale,
            (clip.ctm[4] - boxOriginX) * scale - shiftX, (pageHeightPts + boxOriginY - clip.ctm[5]) * scale - shiftY,
          );
          maskCtx.beginPath();
          for (const cmd of clip.path) {
            if (cmd.type === 'M') maskCtx.moveTo(cmd.x, cmd.y);
            else if (cmd.type === 'L') maskCtx.lineTo(cmd.x, cmd.y);
            else if (cmd.type === 'C') maskCtx.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y);
            else if (cmd.type === 'Z') maskCtx.closePath();
          }
          maskCtx.clip(clip.evenOdd ? 'evenodd' : 'nonzero');
        }
      }
      maskCtx.setTransform(
        op.ctm[0] * scale,
        -op.ctm[1] * scale,
        op.ctm[2] * scale,
        -op.ctm[3] * scale,
        (op.ctm[4] - boxOriginX) * scale - shiftX,
        (pageHeightPts + boxOriginY - op.ctm[5]) * scale - shiftY,
      );

      if (sh.type === 2) {
        const grad = maskCtx.createLinearGradient(sh.coords[0], sh.coords[1], sh.coords[2], sh.coords[3]);
        for (const stop of sh.stops) {
          grad.addColorStop(stop.offset, stop.color);
        }
        maskCtx.fillStyle = grad;
        maskCtx.fillRect(-1e9, -1e9, 2e9, 2e9);
      } else if (sh.type === 3) {
        const grad = maskCtx.createRadialGradient(
          sh.coords[0], sh.coords[1], sh.coords[2],
          sh.coords[3], sh.coords[4], sh.coords[5],
        );
        for (const stop of sh.stops) {
          grad.addColorStop(stop.offset, stop.color);
        }
        maskCtx.fillStyle = grad;
        maskCtx.fillRect(-1e9, -1e9, 2e9, 2e9);
      } else if (sh.type === 'mesh') {
        renderMeshPatches(maskCtx, sh.patches);
      } else if (sh.type === 'gouraud') {
        renderGouraudTriangles(maskCtx, sh.triangles, null, [maskW, maskH]);
      }
      maskCtx.restore();
    } else if (op.type === 'path' && op.fill) {
      // Render filled paths on the mask canvas (some masks use path fills)
      maskCtx.save();
      if (op.fillAlpha < 1) maskCtx.globalAlpha = op.fillAlpha;
      if (op.clips) {
        for (const clip of op.clips) {
          if (!clip.path) continue;
          maskCtx.setTransform(
            clip.ctm[0] * scale, -clip.ctm[1] * scale, clip.ctm[2] * scale, -clip.ctm[3] * scale,
            (clip.ctm[4] - boxOriginX) * scale - shiftX, (pageHeightPts + boxOriginY - clip.ctm[5]) * scale - shiftY,
          );
          maskCtx.beginPath();
          for (const cmd of clip.path) {
            if (cmd.type === 'M') maskCtx.moveTo(cmd.x, cmd.y);
            else if (cmd.type === 'L') maskCtx.lineTo(cmd.x, cmd.y);
            else if (cmd.type === 'C') maskCtx.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y);
            else if (cmd.type === 'Z') maskCtx.closePath();
          }
          maskCtx.clip(clip.evenOdd ? 'evenodd' : 'nonzero');
        }
      }
      maskCtx.setTransform(
        op.ctm[0] * scale,
        -op.ctm[1] * scale,
        op.ctm[2] * scale,
        -op.ctm[3] * scale,
        (op.ctm[4] - boxOriginX) * scale - shiftX,
        (pageHeightPts + boxOriginY - op.ctm[5]) * scale - shiftY,
      );
      maskCtx.beginPath();
      for (const cmd of op.commands) {
        switch (cmd.type) {
          case 'M': maskCtx.moveTo(cmd.x, cmd.y); break;
          case 'L': maskCtx.lineTo(cmd.x, cmd.y); break;
          case 'C': maskCtx.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y); break;
          case 'Z': maskCtx.closePath(); break;
          default: break;
        }
      }
      if (op.patternShading) {
        const sh = op.patternShading;
        maskCtx.clip(op.evenOdd ? 'evenodd' : 'nonzero');
        if (sh.matrix) maskCtx.transform(...sh.matrix);
        if (sh.type === 'mesh') {
          renderMeshPatches(maskCtx, sh.patches);
        } else if (sh.type === 'gouraud') {
          renderGouraudTriangles(maskCtx, sh.triangles, null, [maskW, maskH]);
        } else {
          let grad;
          if (sh.type === 2) {
            grad = maskCtx.createLinearGradient(sh.coords[0], sh.coords[1], sh.coords[2], sh.coords[3]);
          } else if (sh.type === 3) {
            grad = maskCtx.createRadialGradient(sh.coords[0], sh.coords[1], sh.coords[2], sh.coords[3], sh.coords[4], sh.coords[5]);
          }
          if (grad) {
            for (const stop of sh.stops) grad.addColorStop(stop.offset, stop.color);
            maskCtx.fillStyle = grad;
            maskCtx.fillRect(-1e9, -1e9, 2e9, 2e9);
          } else {
            maskCtx.fillStyle = op.fillColor || 'black';
            maskCtx.fill(op.evenOdd ? 'evenodd' : 'nonzero');
          }
        }
      } else if (op.tilingPattern) {
        const tp = op.tilingPattern;
        const tileCanvas = await renderTilingPatternTileForSmask(tp, objCache, scale);
        if (tileCanvas) {
          const bboxW = tp.bbox[2] - tp.bbox[0];
          const bboxH = tp.bbox[3] - tp.bbox[1];
          const tileW = tileCanvas.width;
          const tileH = tileCanvas.height;
          const sx = bboxW / tileW * scale;
          const sy = bboxH / tileH * scale;
          maskCtx.clip(op.evenOdd ? 'evenodd' : 'nonzero');
          maskCtx.setTransform(1, 0, 0, 1, 0, 0);
          const canvasPat = maskCtx.createPattern(tileCanvas, 'repeat');
          if (canvasPat) {
            canvasPat.setTransform(new DOMMatrix([
              tp.matrix[0] * sx, -tp.matrix[1] * sx,
              -tp.matrix[2] * sy, tp.matrix[3] * sy,
              (tp.matrix[0] * tp.bbox[0] + tp.matrix[2] * (tp.bbox[1] + bboxH) + tp.matrix[4] - boxOriginX) * scale - shiftX,
              (pageHeightPts + boxOriginY - tp.matrix[1] * tp.bbox[0] - tp.matrix[3] * (tp.bbox[1] + bboxH) - tp.matrix[5]) * scale - shiftY,
            ]));
            maskCtx.fillStyle = canvasPat;
            maskCtx.fillRect(0, 0, maskW, maskH);
          }
          ca.closeDrawable(tileCanvas);
        }
      } else {
        maskCtx.fillStyle = op.fillColor || 'black';
        maskCtx.fill(op.evenOdd ? 'evenodd' : 'nonzero');
      }
      maskCtx.restore();
    } else if (op.type === 'type0text' && op.fontFamily && op.text) {
      const isEmbedded = /^"?_pdf_/.test(op.fontFamily);
      const weight = (!isEmbedded && op.bold) ? 'bold' : 'normal';
      const style = (!isEmbedded && op.italic) ? 'italic' : 'normal';
      maskCtx.save();
      maskCtx.font = /[",]/.test(op.fontFamily)
        ? `${style} ${weight} 1px ${op.fontFamily}`
        : `${style} ${weight} 1px "${op.fontFamily}"`;
      maskCtx.textBaseline = 'alphabetic';
      let hScale = 1;
      if (op.pdfGlyphWidth !== undefined) {
        const mw = maskCtx.measureText(op.text).width;
        if (mw > 0) {
          hScale = op.pdfGlyphWidth / (1000 * mw);
          if (!isEmbedded && hScale > 2.0) hScale = 1;
        }
      }
      maskCtx.setTransform(
        op.a * scale * hScale, -op.b * scale * hScale,
        -op.c * scale, op.d * scale,
        (op.x - boxOriginX) * scale - shiftX,
        (pageHeightPts + boxOriginY - op.y) * scale - shiftY,
      );
      maskCtx.fillStyle = op.fillColor || 'black';
      if (op.fillAlpha < 1) maskCtx.globalAlpha = op.fillAlpha;
      maskCtx.fillText(op.text, 0, 0);
      maskCtx.restore();
    } else if (op.type === 'inlineImage') {
      const bitmap = await decodeInlineImageBitmap(op, objCache);
      if (!bitmap) continue;
      if (Math.abs(op.ctm[0] * op.ctm[3] - op.ctm[1] * op.ctm[2]) < 1e-9) {
        ca.closeDrawable(bitmap);
        continue;
      }
      maskCtx.save();
      if (op.fillAlpha < 1) maskCtx.globalAlpha = op.fillAlpha;
      if (op.clips) {
        for (const clip of op.clips) {
          if (!clip.path) continue;
          maskCtx.setTransform(
            clip.ctm[0] * scale, -clip.ctm[1] * scale, clip.ctm[2] * scale, -clip.ctm[3] * scale,
            (clip.ctm[4] - boxOriginX) * scale - shiftX, (pageHeightPts + boxOriginY - clip.ctm[5]) * scale - shiftY,
          );
          maskCtx.beginPath();
          for (const cmd of clip.path) {
            if (cmd.type === 'M') maskCtx.moveTo(cmd.x, cmd.y);
            else if (cmd.type === 'L') maskCtx.lineTo(cmd.x, cmd.y);
            else if (cmd.type === 'C') maskCtx.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y);
            else if (cmd.type === 'Z') maskCtx.closePath();
          }
          maskCtx.clip(clip.evenOdd ? 'evenodd' : 'nonzero');
        }
      }
      maskCtx.setTransform(
        op.ctm[0] * scale, -op.ctm[1] * scale,
        op.ctm[2] * scale, -op.ctm[3] * scale,
        (op.ctm[4] - boxOriginX) * scale - shiftX,
        (pageHeightPts + boxOriginY - op.ctm[5]) * scale - shiftY,
      );
      maskCtx.transform(1, 0, 0, -1, 0, 1);
      maskCtx.drawImage(bitmap, 0, 0, 1, 1);
      maskCtx.restore();
      ca.closeDrawable(bitmap);
    }
  }

  const trFn = smaskInfo.tr || null;
  // Precompute the transfer function across its 256 possible byte inputs.
  let trLut = null;
  if (trFn) {
    trLut = new Float64Array(256);
    for (let k = 0; k < 256; k++) {
      const out = evaluateFunction(trFn, [k / 255]);
      trLut[k] = out && out.length > 0 ? out[0] : k / 255;
    }
  }
  const maskData = maskCtx.getImageData(0, 0, maskW, maskH);
  const px = maskData.data;
  for (let i = 0; i < px.length; i += 4) {
    const alpha = px[i + 3] / 255;
    let outAlpha;
    if (isAlphaMask) {
      outAlpha = trLut ? trLut[px[i + 3]] : alpha;
      px[i] = 255;
      px[i + 1] = 255;
      px[i + 2] = 255;
      px[i + 3] = Math.round(Math.max(0, Math.min(1, outAlpha)) * 255);
    } else {
      const luminosity = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / 255;
      outAlpha = trLut ? trLut[Math.round(luminosity * 255)] : luminosity;
      px[i] = 255;
      px[i + 1] = 255;
      px[i + 2] = 255;
      px[i + 3] = Math.round(Math.max(0, Math.min(1, outAlpha)) * alpha * 255);
    }
  }
  maskCtx.putImageData(maskData, 0, 0);
  return maskCanvas;
}

/**
 * Render a single PDF page to a image data URL.
 *
 * @param {string} pageObjText - Raw text of the Page object
 * @param {ObjectCache} objCache - PDF object cache
 * @param {number[]} mediaBox - Page media box [x0, y0, x1, y1]
 * @param {number} pageIndex - Page index (for ImageWrapper)
 * @param {'color'|'gray'} [colorMode='color'] - Output color mode
 * @param {number} [rotate=0] - Page rotation in degrees
 * @param {number} [dpi=300] - Render resolution in dots per inch
 * @param {'png'|'jpeg'} [outputFormat='png'] - Output encoding: 'png' returns a base64 data URL and 'jpeg' returns a Blob (browser only).
 * @param {number} [quality=0.6] - JPEG quality 0-1 (ignored for png).
 * @returns {Promise<{dataUrl?: string, blob?: Blob, colorMode: string, ok: boolean, failReason?: string, failDetail?: string}>}
 *   A PNG data URL (`dataUrl`, default) or a JPEG `blob` (when `outputFormat` is 'jpeg'), plus the effective color mode.
 *   `ok` is false when the page is a failure placeholder (blank fallback) rather than a real render.
 *   Failure placeholders are always a PNG `dataUrl` regardless of `outputFormat`.
 *   `failReason` is then one of `exception`, `memory_abort`, or `corrupt_encrypted`, with `failDetail` carrying the error text.
 *   A genuinely empty page (no draw ops) returns `ok: true`.
 */
export async function renderPdfPageAsImage(pageObjText, objCache, mediaBox, pageIndex, colorMode = 'color', rotate = 0, dpi = 300, outputFormat = 'png', quality = 0.6) {
  // Optional Content visibility is a property of the document — fetch the
  // (cached) set of OCGs hidden in View mode from the ObjectCache so that
  // every caller of this function (worker, batch entry, tests) automatically
  // hides print-only watermark layers and other hidden OCGs.
  const offOCGs = objCache.getOffOCGs();
  const contentWidthPts = Math.abs(mediaBox[2] - mediaBox[0]);
  const contentHeightPts = Math.abs(mediaBox[3] - mediaBox[1]);
  // CropBox or other non-zero-origin boxes require coordinate offset.
  // Box corners may be stored in either order, so the origin is the lower-left corner.
  const boxOriginX = Math.min(mediaBox[0], mediaBox[2]);
  const boxOriginY = Math.min(mediaBox[1], mediaBox[3]);

  // Compute visual (post-rotation) dimensions and rotation CTM.
  // /Rotate specifies clockwise rotation for display (PDF spec).
  // The CTM translations must account for non-zero box origins (CropBox offset)
  // so that the rendering formula canvas_y = (pageHeightPts + boxOriginY - f) * scale
  // correctly maps CropBox edges to canvas edges after rotation.
  let rotCtm = null; // null = identity (no rotation)
  let pageWidthPts = contentWidthPts;
  let pageHeightPts = contentHeightPts;
  if (rotate === 90) {
    rotCtm = [0, -1, 1, 0, boxOriginX - boxOriginY, contentWidthPts + boxOriginX + boxOriginY];
    pageWidthPts = contentHeightPts;
    pageHeightPts = contentWidthPts;
  } else if (rotate === 180) {
    rotCtm = [-1, 0, 0, -1, contentWidthPts + 2 * boxOriginX, contentHeightPts + 2 * boxOriginY];
  } else if (rotate === 270) {
    rotCtm = [0, 1, -1, 0, contentHeightPts + boxOriginY + boxOriginX, boxOriginY - boxOriginX];
    pageWidthPts = contentHeightPts;
    pageHeightPts = contentWidthPts;
  }

  // Encrypted PDFs with xref entries pointing beyond file size are severely corrupt.
  // Content decrypted from repaired offsets cannot be trusted — render blank to match
  // how other renderers (e.g. mupdf) handle this case.
  if (objCache.xrefSeverelyCorrupt && objCache.encryptionKey) {
    const scale = 300 / 72;
    const w = Math.ceil(pageWidthPts * scale);
    const h = Math.ceil(pageHeightPts * scale);
    const c = ca.makeCanvas(w, h);
    const cCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (c.getContext('2d', { willReadFrequently: true }));
    cCtx.fillStyle = 'white';
    cCtx.fillRect(0, 0, w, h);
    const _imgData = cCtx.getImageData(0, 0, w, h);
    const out = {
      dataUrl: await buildPngDataUrl(_imgData, 'gray'), colorMode: 'gray', ok: false, failReason: 'corrupt_encrypted',
    };
    ca.closeDrawable(c);
    return out;
  }

  // Parse immediate page-level image/Form XObjects.
  // Nested resources are discovered lazily while flattening only the forms that are actually drawn.
  const { images, forms } = parsePageImages(pageObjText, objCache, { recurseForms: false });

  // Parse all fonts from the page (needed for Type3 glyph rendering and Type0 text)
  const fonts = parsePageFonts(pageObjText, objCache);

  // Register fonts for canvas text rendering (Type0 and Type1/TrueType)
  const registeredFontNames = new Map();
  /** @type {Set<string>} Font tags with Symbol-only cmap (need PUA codepoints for canvas rendering) */
  const symbolFontTags = new Set();
  /** @type {Set<string>} Font tags with Mac-only cmap (need raw charCodes for canvas rendering) */
  const rawCharCodeTags = new Set();
  /** @type {Set<string>} Font tags with PUA-based cmap (CID CFF fonts use U+E000+CID for glyph lookup) */
  const cidPUATags = new Set();
  /** @type {Map<string, Set<number>>} Font tags → CIDs forced to PUA due to Unicode collision */
  const cidCollisionMap = new Map();
  /** @type {string[]} Font tags with no embedded data — deferred to second pass */
  const deferredFontTags = [];
  for (const [fontTag, fontObj] of fonts) {
    const fontData = fontObj.type0 || fontObj.type1;
    if (!fontData) {
      deferredFontTags.push(fontTag);
      continue;
    }
    const familyName = pdfFontFamilyName(objCache, fontObj.fontObjNum, fontTag);
    await convertAndRegisterFont(
      fontTag, fontObj, registeredFontNames, symbolFontTags, cidPUATags,
      rawCharCodeTags, cidCollisionMap, objCache, familyName,
    );
  }

  // Second pass: register non-embedded fonts using CSS fallback
  for (const fontTag of deferredFontTags) {
    const fontObj = fonts.get(fontTag);
    if (!fontObj) continue;
    // Non-embedded CID fonts without toUnicode: skip registration to avoid garbled text.
    // CIDs are opaque glyph indices — rendering them through a substitution font
    // produces garbled Latin characters.
    // Exception: fonts with type0 info (e.g., UTF-16 encoded
    // CID fonts) can render via showType0Literal which falls back to String.fromCharCode.
    if (fontObj.isCIDFont && fontObj.toUnicode.size === 0 && !fontObj.type0) {
      console.warn(`[renderPdfPage] Skipping non-embedded CID font "${fontObj.baseName}" (no toUnicode map)`);
      continue;
    }
    const familyName = pdfFontFamilyName(objCache, fontObj.fontObjNum, fontTag);
    await registerNonEmbeddedFont(fontObj, familyName, registeredFontNames, fontTag);
  }
  appendGenericFallbacks(registeredFontNames, fonts);

  const extGStates = parseExtGStates(pageObjText, objCache);
  const colorSpaces = parsePageColorSpaces(pageObjText, objCache);
  const pageShadings = parseShadings(pageObjText, objCache);
  const pagePatterns = parsePatterns(pageObjText, objCache);

  let pageHasColor = false;
  for (const [, imgInfo] of images) {
    if (imgInfo.bitsPerComponent === 1) continue;
    const cs = imgInfo.colorSpace;
    if (cs === 'DeviceGray' || cs === 'CalGray') continue;
    if (cs === 'Indexed') {
      if (imgInfo.paletteBase === 'DeviceGray' || imgInfo.paletteBase === 'CalGray') continue;
    }
    pageHasColor = true;
    break;
  }

  // Get the content streams as an array (one entry per /Contents stream). Passing the
  // streams individually lets parseDrawOps reset corruption state at boundaries so a
  // single bad stream doesn't poison the rest of the page.
  const contentStreams = getPageContentStreams(pageObjText, objCache);

  // Parse content stream for all draw operations (images, Type3 glyphs, Type0 text, paths)
  const rawDrawOps = contentStreams && contentStreams.length > 0
    ? parseDrawOps(contentStreams, fonts, extGStates, registeredFontNames, colorSpaces, symbolFontTags,
      cidPUATags, rawCharCodeTags, pageShadings, pagePatterns, cidCollisionMap, null,
      parseHiddenOCMCNames(pageObjText, objCache, offOCGs), objCache.lastContentStreamsRecovered)
    : [];

  // Yield to the event loop after heavy synchronous parsing (parseDrawOps tokenizes
  // the full content stream synchronously). For large streams (500KB+), this prevents
  // the browser from being declared dead by test harnesses due to event-loop starvation.
  // The 500KB threshold avoids unnecessary yields for typical pages.
  const totalContentLen = contentStreams ? contentStreams.reduce((acc, s) => acc + s.length, 0) : 0;
  if (totalContentLen > 500000) {
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }

  // Flatten Form XObjects while preserving paint order.

  /** @type {Array<DrawOp>} */
  const drawOps = [];
  /** @type {{nextId: number, registry: Map<number, TransparencyGroupAttrs>}} */
  const groupContext = { nextId: 1, registry: new Map() };
  if (forms.size > 0) {
    const sharedFormResourceCache = new Map();
    for (const op of rawDrawOps) {
      if (op.type === 'image') {
        const flattened = await flattenDrawOps(
          [op], images, forms, objCache, fonts, registeredFontNames,
          '', pageIndex, symbolFontTags, cidPUATags, extGStates, rawCharCodeTags,
          sharedFormResourceCache, 0, offOCGs, cidCollisionMap,
          'black', 'rgb(0,0,0)',
          1, 1,
          groupContext, null,
        );
        for (let fi = 0; fi < flattened.length; fi++) drawOps.push(flattened[fi]);
      } else {
        drawOps.push(op);
      }
    }
  } else {
    for (let ri = 0; ri < rawDrawOps.length; ri++) drawOps.push(rawDrawOps[ri]);
  }

  // Render annotation appearance streams (e.g., signature widgets, form fields).
  // `extractPdfAnnotations` owns the /Annots-array resolution + /Highlight parse
  // (shared with the importer at js/pdf/parsePdfAnnots.js); we fetch each
  // annotText here for flag-filtering, /AP resolution, and non-highlight synth.
  const annotsParsed = extractPdfAnnotations(objCache, pageObjText);
  // AcroForm /NeedAppearances: when true, field appearances are out of date and must be regenerated
  // from the field value (text) or /MK caption (buttons) rather than trusting a possibly-stale embedded /AP.
  let needAppearances = false;
  {
    const rootObjNum = findRootObjNum(objCache.pdfBytes);
    const catalogText = rootObjNum ? objCache.getObjectText(rootObjNum) : null;
    const acroFormMatch = catalogText ? /\/AcroForm\s+(\d+)\s+\d+\s+R/.exec(catalogText) : null;
    const acroFormText = acroFormMatch ? objCache.getObjectText(Number(acroFormMatch[1])) : null;
    if (acroFormText && /\/NeedAppearances\s+true\b/.test(acroFormText)) needAppearances = true;
  }
  /** @type {Map<number, import('./parsePdfAnnots.js').PdfHighlightRaw>} */
  const highlightByRef = new Map(annotsParsed.highlights.map((h) => [h.objNum, h]));
  const annotRefsRaw = [
    ...annotsParsed.highlights.map((h) => h.objNum),
    ...annotsParsed.passthroughRefs,
  ];
  // Render form-field Widget annotations after (on top of) non-Widget markup annotations.
  const annotIsWidget = (ref) => {
    const t = objCache.getObjectText(ref);
    return t ? /\/Subtype\s*\/Widget\b/.test(t) : false;
  };
  const annotRefs = [
    ...annotRefsRaw.filter((r) => !annotIsWidget(r)),
    ...annotRefsRaw.filter((r) => annotIsWidget(r)),
  ];
  if (annotRefs.length > 0) {
    for (const annotRef of annotRefs) {
      let annotText = objCache.getObjectText(annotRef);
      if (!annotText) continue;

      // Apple Preview / iOS stamp+ink annotations stash a stale private copy of the whole annotation (its own /AP, /Rect, /Subtype from before the user moved/resized it) inside /AAPL:AKExtras.
      // Standard viewers ignore that private key and use the live top-level keys.
      // Our key regexes below take the first match, which would otherwise land inside that copy and render the stamp at its pre-edit position.
      // Drop the /AAPL:AKExtras value (a balanced << >>, skipping () strings) so only the live keys remain.
      const akIdx = annotText.indexOf('/AAPL:AKExtras');
      if (akIdx !== -1) {
        const open = annotText.indexOf('<<', akIdx);
        if (open !== -1) {
          // extractDict runs to the end of the string when the value never closes, leaving `end` at
          // annotText.length; the guard then leaves a malformed annotation untouched.
          const akDict = extractDict(annotText, open);
          const end = open + akDict.length;
          if (end < annotText.length) annotText = annotText.slice(0, akIdx) + annotText.slice(end);
        }
      }

      let rectArrText = null;
      const rectInlineMatch = /\/Rect\s*(\[[^\]]*\])/.exec(annotText);
      if (rectInlineMatch) {
        rectArrText = rectInlineMatch[1];
      } else {
        const rectRefMatch = /\/Rect\s+(\d+)\s+\d+\s+R/.exec(annotText);
        const rectObjText = rectRefMatch ? objCache.getObjectText(Number(rectRefMatch[1])) : null;
        const rectObjArr = rectObjText ? /(\[[^\]]*\])/.exec(rectObjText) : null;
        if (rectObjArr) rectArrText = rectObjArr[1];
      }
      if (!rectArrText) continue;
      const rect = [];
      const rectTokRe = /(\d+)\s+\d+\s+R|(-?[\d.]+(?:[eE][-+]?\d+)?)/g;
      let rectTok;
      while ((rectTok = rectTokRe.exec(rectArrText)) && rect.length < 4) {
        if (rectTok[1] !== undefined) {
          const numText = objCache.getObjectText(Number(rectTok[1]));
          const numMatch = numText ? /(-?[\d.]+(?:[eE][-+]?\d+)?)/.exec(numText) : null;
          rect.push(numMatch ? Number(numMatch[1]) : NaN);
        } else {
          rect.push(Number(rectTok[2]));
        }
      }
      if (rect.length < 4 || rect.some(Number.isNaN)) continue;
      // /Rect corners may be stored in either order, so normalize to lower-left + size.
      const rectX0 = Math.min(rect[0], rect[2]);
      const rectY0 = Math.min(rect[1], rect[3]);
      const rectW = Math.abs(rect[2] - rect[0]);
      const rectH = Math.abs(rect[3] - rect[1]);
      // Line annotations may have an empty Rect with endpoints defined by /L
      // Ink annotations may have inverted Rects (coords are in InkList, not Rect)
      const isLineAnnot = /\/Subtype\s*\/Line\b/.test(annotText);
      const isInkAnnot = /\/Subtype\s*\/Ink\b/.test(annotText);
      if ((rectW <= 0 || rectH <= 0) && !isLineAnnot && !isInkAnnot) continue;

      // Check annotation flags. Skip if hidden (bit 2), invisible (bit 1), or NoView (bit 6).
      const flagsMatch = /\/F\s+(\d+)(?=\s*[/>])/.exec(annotText);
      const flags = flagsMatch ? Number(flagsMatch[1]) : 0;
      if (flags & 1 || flags & 2 || flags & 32) continue; // Invisible, Hidden, or NoView

      // Get normal appearance stream reference (/AP<</N objNum 0 R>>)
      // Also handle sub-state dictionaries (/AP<</N<</State1 obj1 0 R /State2 obj2 0 R>>>>)
      // used by checkboxes/radio buttons where /AS selects the current state.
      let apObjNum = null;
      let apDictText = annotText;
      const apIndirectMatch = /\/AP\s+(\d+)\s+\d+\s+R/.exec(annotText);
      if (apIndirectMatch) {
        const refText = objCache.getObjectText(Number(apIndirectMatch[1]));
        if (refText) apDictText = refText;
      }
      const apDirectMatch = /\/AP\s*<<[\s\S]*?\/N\s+(\d+)\s+\d+\s+R/.exec(apDictText)
        || /^<<[\s\S]*?\/N\s+(\d+)\s+\d+\s+R/.exec(apDictText);
      if (apDirectMatch) {
        apObjNum = Number(apDirectMatch[1]);
        // /N may be an indirect ref to a sub-state dict (checkbox/radio) rather than the appearance stream.
        // That dict has no /BBox, so follow /AS to the state's stream. A real appearance stream keeps apObjNum unchanged.
        const nObjText = objCache.getObjectText(apObjNum);
        if (nObjText && !/\/BBox/.test(nObjText)) {
          const asMatch = /\/AS\s*\/(\w+)/.exec(annotText);
          const currentState = asMatch ? asMatch[1] : 'Off';
          const stateRefMatch = new RegExp(`\\/${currentState}\\s+(\\d+)\\s+\\d+\\s+R`).exec(nObjText);
          if (stateRefMatch) apObjNum = Number(stateRefMatch[1]);
        }
      } else {
        // Inline sub-state dict: /AP << /N << /Yes 31 0 R /Off 32 0 R >> >>
        const apDictMatch = /\/AP\s*<<[\s\S]*?\/N\s*<<([\s\S]*?)>>/.exec(apDictText)
          || /^<<[\s\S]*?\/N\s*<<([\s\S]*?)>>/.exec(apDictText);
        if (apDictMatch) {
          const asMatch = /\/AS\s*\/(\w+)/.exec(annotText);
          const currentState = asMatch ? asMatch[1] : 'Off';
          const stateRefMatch = new RegExp(`\\/${currentState}\\s+(\\d+)\\s+\\d+\\s+R`).exec(apDictMatch[1]);
          if (stateRefMatch) apObjNum = Number(stateRefMatch[1]);
        }
      }

      // Resolve the field type from this widget or its /Parent (radio kids put /FT on /Parent).
      let resolvedFieldType = '';
      const ftSelfMatch = /\/FT\s*\/(\w+)/.exec(annotText);
      if (ftSelfMatch) {
        resolvedFieldType = ftSelfMatch[1];
      } else {
        const parentRefMatch = /\/Parent\s+(\d+)\s+\d+\s+R/.exec(annotText);
        const parentText = parentRefMatch ? objCache.getObjectText(Number(parentRefMatch[1])) : null;
        const ftParentMatch = parentText ? /\/FT\s*\/(\w+)/.exec(parentText) : null;
        if (ftParentMatch) resolvedFieldType = ftParentMatch[1];
      }
      // Decode the text/choice field value (/V) once, up front: a literal /V may itself be UTF-16BE
      // (its first two decoded bytes are 0xFE 0xFF), and the decoded value drives both the regenerate
      // decision below and the synthesis further down, so parse it before either.
      let fieldValue = null;
      if (resolvedFieldType === 'Tx' || resolvedFieldType === 'Ch') {
        const vLitMatch = /\/V\s*\(((?:[^()\\]|\\.)*)\)/.exec(annotText);
        const vHexMatch = /\/V\s*<([0-9A-Fa-f\s]*)>/.exec(annotText);
        if (vLitMatch) {
          const lit = vLitMatch[1].replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (m, c) => {
            const simple = {
              n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\',
            };
            return simple[c] !== undefined ? simple[c] : String.fromCharCode(parseInt(c, 8));
          });
          // A literal /V may itself hold UTF-16BE bytes: its first two chars are 0xFE 0xFF (the BOM).
          if (lit.charCodeAt(0) === 0xfe && lit.charCodeAt(1) === 0xff) {
            let s = '';
            for (let k = 2; k + 1 < lit.length; k += 2) s += String.fromCharCode((lit.charCodeAt(k) << 8) | lit.charCodeAt(k + 1));
            fieldValue = s;
          } else {
            fieldValue = lit;
          }
        } else if (vHexMatch) {
          const hex = vHexMatch[1].replace(/\s+/g, '');
          const bytes = [];
          for (let k = 0; k + 1 < hex.length; k += 2) bytes.push(parseInt(hex.substr(k, 2), 16));
          if (bytes[0] === 0xfe && bytes[1] === 0xff) {
            let s = '';
            for (let k = 2; k + 1 < bytes.length; k += 2) s += String.fromCharCode((bytes[k] << 8) | bytes[k + 1]);
            fieldValue = s;
          } else {
            fieldValue = bytesToLatin1(Uint8Array.from(bytes));
          }
        }
        if (fieldValue && fieldValue.charCodeAt(0) === 0xfeff) fieldValue = fieldValue.slice(1);
      }

      // Under /NeedAppearances the embedded /AP is stale, so drop it (apObjNum = null) to force the field to be synthesized instead,
      // but only where the synth can faithfully reproduce the value.
      // /Tx fields drop their /AP only for single-line, Latin-1-representable values.
      // Multiline or non-Latin-1 values stay on their embedded /AP, which the synth cannot reproduce.
      // Radio and checkbox buttons drop their /AP.
      // Pushbuttons (Ff bit 17) keep theirs, having no value to regenerate.
      if (needAppearances && apObjNum !== null) {
        if (resolvedFieldType === 'Tx') {
          const ffTxMatch = /\/Ff\s+(\d+)/.exec(annotText);
          const txMultiline = ((ffTxMatch ? Number(ffTxMatch[1]) : 0) & 0x1000) !== 0;
          const synthCanRender = fieldValue === null || !/[^\x00-\xff]/.test(fieldValue);
          if (!txMultiline && synthCanRender) apObjNum = null;
        } else if (resolvedFieldType === 'Btn') {
          const ffBtnMatch = /\/Ff\s+(\d+)/.exec(annotText);
          if (!((ffBtnMatch ? Number(ffBtnMatch[1]) : 0) & 0x10000)) apObjNum = null;
        }
      }

      // No usable /AP: synthesize the field appearance and route it through the /AP path below,
      // which handles font parsing and the BBox->Rect transform.
      // Text/choice fields draw their /V.
      // Selected radio/checkbox buttons draw a filled dot.
      if (apObjNum === null) {
        if (resolvedFieldType === 'Tx' || resolvedFieldType === 'Ch') {
          // The value was decoded once above (handles both literal and hex UTF-16BE); reuse it.
          if (fieldValue && fieldValue.length > 0) {
            const daMatch = /\/DA\s*\(((?:[^()\\]|\\.)*)\)/.exec(annotText);
            const da = daMatch ? daMatch[1] : '/Helvetica 10 Tf 0 g';
            const tfMatch = /\/[\w+-]+\s+([\d.]+)\s+Tf/.exec(da);
            let fontSize = tfMatch ? Number(tfMatch[1]) : 10;
            // /DA font size 0 means auto-size: pick a size that fits the field height.
            if (!fontSize) fontSize = Math.min(12, Math.max(6, rectH - 4));
            const tfEnd = da.lastIndexOf('Tf');
            const colorOps = tfEnd >= 0 ? da.slice(tfEnd + 2).trim() : '0 g';
            const qMatch = /\/Q\s+(\d+)/.exec(annotText);
            const quadding = qMatch ? Number(qMatch[1]) : 0;
            const multiline = (() => {
              const ffMatch = /\/Ff\s+(\d+)/.exec(annotText);
              return ffMatch ? (Number(ffMatch[1]) & 0x1000) !== 0 : false;
            })();
            const pad = 2;
            // Escape the value for re-emission inside a content-stream literal string.
            const esc = (s) => s.replace(/[\\()]/g, (ch) => `\\${ch}`);
            // Helvetica's average advance is ~0.5em, enough to place/justify single lines
            // and to wrap a multiline note approximately (no per-glyph metrics needed here).
            const avgCharW = fontSize * 0.5;
            let textCommands = '';
            if (multiline) {
              const maxChars = Math.max(1, Math.floor((rectW - 2 * pad) / avgCharW));
              // Honor the value's own line breaks, then width-wrap each paragraph independently.
              const lines = [];
              for (const para of fieldValue.split(/\r\n|\r|\n/)) {
                const words = para.split(/\s+/).filter((w) => w.length > 0);
                if (words.length === 0) { lines.push(''); continue; }
                let line = '';
                for (const w of words) {
                  if (line.length === 0) line = w;
                  else if ((line.length + 1 + w.length) <= maxChars) line += ` ${w}`;
                  else { lines.push(line); line = w; }
                }
                if (line.length > 0) lines.push(line);
              }
              const leading = fontSize * 1.15;
              let ty = rectH - pad - fontSize;
              textCommands = `${pad} ${ty} Td`;
              for (let li = 0; li < lines.length; li++) {
                if (li > 0) textCommands += ` 0 ${-leading} Td`;
                textCommands += ` (${esc(lines[li])}) Tj`;
                ty -= leading;
              }
            } else {
              const textW = fieldValue.length * avgCharW;
              let tx = pad;
              if (quadding === 1) tx = Math.max(pad, (rectW - textW) / 2);
              else if (quadding === 2) tx = Math.max(pad, rectW - textW - pad);
              const ty = Math.max(pad, (rectH - fontSize) / 2 + fontSize * 0.2);
              textCommands = `${tx} ${ty} Td (${esc(fieldValue)}) Tj`;
            }
            const synthDict = `<</Type/XObject/Subtype/Form/FormType 1/BBox[0 0 ${rectW} ${rectH}]`
              + '/Resources<</Font<</HsynthF<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>>>/ProcSet[/PDF/Text]>>>>';
            const clip = `0 0 ${rectW} ${rectH} re W n`;
            const synthStream = `/Tx BMC q ${clip} BT /HsynthF ${fontSize} Tf ${colorOps} ${textCommands} ET Q EMC`;
            const synthObjNum = 900000000 + annotRef;
            objCache.addSyntheticObject(synthObjNum, synthDict, new TextEncoder().encode(synthStream));
            apObjNum = synthObjNum;
          }
        } else if (resolvedFieldType === 'Btn') {
          // Selected radio/checkbox (/AS other than /Off): draw a filled dot centered in the field,
          // matching the conventional "on" indicator. The /MK /CA caption names a ZapfDingbats glyph,
          // but its substitute rendering is unreliable, so a circle path reproduces the baseline dot
          // exactly without a font. /AS /Off draws nothing.
          const asMatch = /\/AS\s*\/(\w+)/.exec(annotText);
          if (asMatch && asMatch[1] !== 'Off') {
            const daMatch = /\/DA\s*\(((?:[^()\\]|\\.)*)\)/.exec(annotText);
            const da = daMatch ? daMatch[1] : '0 g';
            const tfEnd = da.lastIndexOf('Tf');
            const dotColor = tfEnd >= 0 ? da.slice(tfEnd + 2).trim() : '0 g';
            const cx = rectW / 2;
            const cy = rectH / 2;
            const r = Math.min(rectW, rectH) * 0.25;
            const k = 0.5522847498 * r;
            const f = (n) => n.toFixed(3);
            const dotPath = `${f(cx + r)} ${f(cy)} m `
              + `${f(cx + r)} ${f(cy + k)} ${f(cx + k)} ${f(cy + r)} ${f(cx)} ${f(cy + r)} c `
              + `${f(cx - k)} ${f(cy + r)} ${f(cx - r)} ${f(cy + k)} ${f(cx - r)} ${f(cy)} c `
              + `${f(cx - r)} ${f(cy - k)} ${f(cx - k)} ${f(cy - r)} ${f(cx)} ${f(cy - r)} c `
              + `${f(cx + k)} ${f(cy - r)} ${f(cx + r)} ${f(cy - k)} ${f(cx + r)} ${f(cy)} c h f`;
            const dotDict = `<</Type/XObject/Subtype/Form/FormType 1/BBox[0 0 ${rectW} ${rectH}]/Resources<</ProcSet[/PDF]>>>>`;
            const dotStream = `q ${dotColor} ${dotPath} Q`;
            const dotObjNum = 900000000 + annotRef;
            objCache.addSyntheticObject(dotObjNum, dotDict, new TextEncoder().encode(dotStream));
            apObjNum = dotObjNum;
          }
        }
      }

      if (apObjNum !== null) {
        const apObjText = objCache.getObjectText(apObjNum);
        if (!apObjText) continue;
        const apSubtypeMatch = /\/Subtype\s*\/(\w+)/.exec(apObjText);
        if (apSubtypeMatch && apSubtypeMatch[1] !== 'Form') continue;

        const bboxMatch = /\/BBox\s*\[\s*([\d.\-+e]+)\s+([\d.\-+e]+)\s+([\d.\-+e]+)\s+([\d.\-+e]+)\s*\]/.exec(apObjText);
        const bbox = bboxMatch ? [Number(bboxMatch[1]), Number(bboxMatch[2]), Number(bboxMatch[3]), Number(bboxMatch[4])] : [0, 0, rectW, rectH];

        // Parse the appearance form's Matrix (defaults to identity).
        // flattenDrawOps will apply this Matrix to content coordinates, so we must
        // compute annotTransform relative to the post-Matrix BBox, not the original.
        const apMatrix = parseFormMatrix(apObjText);
        const corners = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]]];
        const txArr = corners.map(([x, y]) => x * apMatrix[0] + y * apMatrix[2] + apMatrix[4]);
        const tyArr = corners.map(([x, y]) => x * apMatrix[1] + y * apMatrix[3] + apMatrix[5]);
        const effBBox = [Math.min(...txArr), Math.min(...tyArr), Math.max(...txArr), Math.max(...tyArr)];
        const effW = effBBox[2] - effBBox[0];
        const effH = effBBox[3] - effBBox[1];

        // Compute transform: map effective (post-Matrix) BBox to annotation Rect
        const sx = effW > 0 ? rectW / effW : 1;
        const sy = effH > 0 ? rectH / effH : 1;
        const annotTransform = [sx, 0, 0, sy, rectX0 - effBBox[0] * sx, rectY0 - effBBox[1] * sy];

        // Create a synthetic form entry and image op so flattenDrawOps can process it
        // Include bbox so flattenDrawOps applies BBox clipping to the annotation form.
        const annotFormKey = `_annot_${annotRef}`;
        forms.set(annotFormKey, { tag: annotFormKey, objNum: apObjNum, bbox: bbox.slice() });
        const syntheticOp = {
          type: 'image',
          name: annotFormKey,
          ctm: annotTransform,
          fillAlpha: 1,
          strokeAlpha: 1,
          fillColor: 'black',
        };
        const annotFlattened = await flattenDrawOps(
          [syntheticOp], images, forms, objCache, fonts, registeredFontNames,
          '', pageIndex, symbolFontTags, cidPUATags, extGStates, rawCharCodeTags,
          new Map(), 0, new Set(), cidCollisionMap,
        );
        // /CA is the annotation's constant opacity, parsed from the annotation dict
        // (not the appearance stream), and applies to every visible element of the annotation.
        const annotCaMatch = /\/CA\s+([0-9.]+)/.exec(annotText);
        const annotCA = annotCaMatch ? parseFloat(annotCaMatch[1]) : 1;
        for (const aOp of annotFlattened) {
          if (annotCA < 1) {
            aOp.fillAlpha = (aOp.fillAlpha ?? 1) * annotCA;
            aOp.strokeAlpha = (aOp.strokeAlpha ?? 1) * annotCA;
          }
          drawOps.push(aOp);
        }
      } else {
        // Synthesize appearance for Highlight annotations without /AP.
        // Pre-parsed in extractPdfAnnotations — look up by annotRef to skip the
        // QuadPoints/color/opacity regex here.
        const highlight = highlightByRef.get(annotRef);
        if (highlight) {
          const coords = highlight.quadPoints;
          if (coords) {
            const hlColor = highlight.color
              ? `rgb(${Math.round(highlight.color[0] * 255)},${Math.round(highlight.color[1] * 255)},${Math.round(highlight.color[2] * 255)})`
              : 'rgb(255,255,0)';
            for (let qi = 0; qi + 7 < coords.length; qi += 8) {
              // QuadPoints order: upper-left, upper-right, lower-left, lower-right
              /** @type {PathCommand[]} */
              const commands = [
                { type: 'M', x: coords[qi], y: coords[qi + 1] },
                { type: 'L', x: coords[qi + 2], y: coords[qi + 3] },
                { type: 'L', x: coords[qi + 6], y: coords[qi + 7] },
                { type: 'L', x: coords[qi + 4], y: coords[qi + 5] },
                { type: 'Z' },
              ];
              drawOps.push({
                type: 'path',
                commands,
                ctm: [1, 0, 0, 1, 0, 0],
                fill: true,
                stroke: false,
                evenOdd: false,
                fillColor: hlColor,
                strokeColor: 'rgb(0,0,0)',
                lineWidth: 0,
                lineCap: 0,
                lineJoin: 0,
                miterLimit: 10,
                dashArray: [],
                dashPhase: 0,
                fillAlpha: 1,
                strokeAlpha: 0,
                blendMode: 'Multiply',
              });
            }
          }
          continue;
        }

        // Synthesize appearance for Ink annotations without /AP
        if (/\/Subtype\s*\/Ink\b/.test(annotText)) {
          const inkListMatch = /\/InkList\s*\[(\[[\s\S]*?\])\s*\]/.exec(annotText);
          if (inkListMatch) {
            const cMatchInk = /\/C\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(annotText);
            const inkColor = cMatchInk
              ? `rgb(${Math.round(Number(cMatchInk[1]) * 255)},${Math.round(Number(cMatchInk[2]) * 255)},${Math.round(Number(cMatchInk[3]) * 255)})`
              : 'rgb(0,0,0)';

            const bsInkMatch = /\/BS\s*<<([^>]*)>>/.exec(annotText);
            let inkWidth = 1;
            let inkDash = [];
            if (bsInkMatch) {
              const bsContent = bsInkMatch[1];
              const wMatch = /\/W\s+([\d.]+)/.exec(bsContent);
              if (wMatch) inkWidth = Number(wMatch[1]);
              const dMatch = /\/D\s*\[\s*([\d.\s]+)\]/.exec(bsContent);
              if (dMatch) inkDash = dMatch[1].trim().split(/\s+/).map(Number);
            }

            const subArrays = [...inkListMatch[1].matchAll(/\[([\d.\-+e\s]+)\]/g)];
            for (const subArr of subArrays) {
              const coords = subArr[1].trim().split(/\s+/).map(Number);
              if (coords.length < 4) continue;
              /** @type {PathCommand[]} */
              const commands = [{ type: 'M', x: coords[0], y: coords[1] }];
              for (let i = 2; i < coords.length; i += 2) {
                commands.push({ type: 'L', x: coords[i], y: coords[i + 1] });
              }
              drawOps.push({
                type: 'path',
                commands,
                ctm: [1, 0, 0, 1, 0, 0],
                fill: false,
                stroke: true,
                evenOdd: false,
                fillColor: 'rgb(0,0,0)',
                strokeColor: inkColor,
                lineWidth: inkWidth,
                lineCap: 1,
                lineJoin: 1,
                miterLimit: 10,
                dashArray: inkDash,
                dashPhase: 0,
                fillAlpha: 1,
                strokeAlpha: 1,
              });
            }
          }
          continue;
        }

        // Synthesize appearance for Widget form-field annotations without a usable /AP.
        // Some PDFs ship a broken /AP (e.g. /N maps the appearance state to a name,
        // not a stream); viewers then draw the field box from its /MK characteristics.
        if (/\/Subtype\s*\/Widget\b/.test(annotText)) {
          const mkMatch = /\/MK\s*<<([\s\S]*?)>>/.exec(annotText);
          if (!mkMatch) continue;
          const mk = mkMatch[1];
          const parseMKColor = (key) => {
            const m = new RegExp(`\\/${key}\\s*\\[([^\\]]*)\\]`).exec(mk);
            if (!m) return null;
            const c = m[1].trim().split(/\s+/).filter((s) => s.length > 0).map(Number);
            if (c.length === 0 || c.some(Number.isNaN)) return null;
            if (c.length === 1) { const v = Math.round(c[0] * 255); return `rgb(${v},${v},${v})`; }
            if (c.length === 3) return `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
            if (c.length === 4) { const [r, g, b] = cmykToRgb(c[0], c[1], c[2], c[3]); return `rgb(${r},${g},${b})`; }
            return null;
          };
          const widgetBorderColor = parseMKColor('BC');
          const widgetBgColor = parseMKColor('BG');
          if (!widgetBorderColor && !widgetBgColor) continue;

          let widgetBorderWidth = widgetBorderColor ? 1 : 0;
          if (widgetBorderColor) {
            const bsWMatch = /\/BS\s*<<[^>]*\/W\s+([\d.]+)/.exec(annotText);
            if (bsWMatch) widgetBorderWidth = Number(bsWMatch[1]);
          }

          const ftMatch = /\/FT\s*\/(\w+)/.exec(annotText);
          const ft = ftMatch ? ftMatch[1] : '';
          const ffMatch = /\/Ff\s+(\d+)/.exec(annotText);
          const ff = ffMatch ? Number(ffMatch[1]) : 0;
          // Signature fields and push buttons have no synthesizable box appearance.
          if (ft === 'Sig' || (ft === 'Btn' && (ff & 0x10000))) continue;

          const whw = widgetBorderWidth / 2;
          const wx0 = rect[0] + whw;
          const wy0 = rect[1] + whw;
          const wx1 = rect[2] - whw;
          const wy1 = rect[3] - whw;
          /** @type {PathCommand[]} */
          let widgetCommands;
          if (ft === 'Btn' && (ff & 0x8000)) {
            // Radio button — circle inscribed in the (inset) Rect, 4 cubic Beziers
            const cx = (wx0 + wx1) / 2;
            const cy = (wy0 + wy1) / 2;
            const rx = (wx1 - wx0) / 2;
            const ry = (wy1 - wy0) / 2;
            const k = 0.5522847498;
            const kx = rx * k;
            const ky = ry * k;
            widgetCommands = [
              { type: 'M', x: cx + rx, y: cy },
              {
                type: 'C', x1: cx + rx, y1: cy + ky, x2: cx + kx, y2: cy + ry, x: cx, y: cy + ry,
              },
              {
                type: 'C', x1: cx - kx, y1: cy + ry, x2: cx - rx, y2: cy + ky, x: cx - rx, y: cy,
              },
              {
                type: 'C', x1: cx - rx, y1: cy - ky, x2: cx - kx, y2: cy - ry, x: cx, y: cy - ry,
              },
              {
                type: 'C', x1: cx + kx, y1: cy - ry, x2: cx + rx, y2: cy - ky, x: cx + rx, y: cy,
              },
              { type: 'Z' },
            ];
          } else {
            // Checkbox, text field, or choice field — rectangular box
            widgetCommands = [
              { type: 'M', x: wx0, y: wy0 },
              { type: 'L', x: wx1, y: wy0 },
              { type: 'L', x: wx1, y: wy1 },
              { type: 'L', x: wx0, y: wy1 },
              { type: 'Z' },
            ];
          }
          drawOps.push({
            type: 'path',
            commands: widgetCommands,
            ctm: [1, 0, 0, 1, 0, 0],
            fill: !!widgetBgColor,
            stroke: !!widgetBorderColor,
            evenOdd: false,
            fillColor: widgetBgColor || 'rgb(255,255,255)',
            strokeColor: widgetBorderColor || 'rgb(0,0,0)',
            lineWidth: widgetBorderWidth || 1,
            lineCap: 0,
            lineJoin: 0,
            miterLimit: 10,
            dashArray: [],
            dashPhase: 0,
            fillAlpha: 1,
            strokeAlpha: 1,
          });
          continue;
        }

        // Synthesize appearance for Square, Circle, Polygon, PolyLine, and Line annotations without /AP
        const subtypeMatch = /\/Subtype\s*\/(Square|Circle|Polygon|PolyLine|Line)/.exec(annotText);
        if (!subtypeMatch) continue;
        const annotSubtype = subtypeMatch[1];

        const cMatch = /\/C\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(annotText);
        const borderColor = cMatch
          ? `rgb(${Math.round(Number(cMatch[1]) * 255)},${Math.round(Number(cMatch[2]) * 255)},${Math.round(Number(cMatch[3]) * 255)})`
          : 'rgb(0,0,0)';

        const icMatch = /\/IC\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(annotText);
        const hasFill = !!icMatch;
        const fillColor = icMatch
          ? `rgb(${Math.round(Number(icMatch[1]) * 255)},${Math.round(Number(icMatch[2]) * 255)},${Math.round(Number(icMatch[3]) * 255)})`
          : 'rgb(0,0,0)';

        // /Border format: [hCornerRadius vCornerRadius width]; /BS overrides if present.
        const borderMatch = /\/Border\s*\[\s*[\d.]+\s+[\d.]+\s+([\d.]+)\s*\]/.exec(annotText);
        const bsWidthMatch = /\/BS\s*<<[^>]*\/W\s+([\d.]+)/.exec(annotText);
        let borderWidth = bsWidthMatch ? Number(bsWidthMatch[1]) : (borderMatch ? Number(borderMatch[1]) : 1);
        if (!bsWidthMatch && !borderMatch) {
          // Handle indirect /BS reference: /BS N 0 R
          const bsIndirectMatch = /\/BS\s+(\d+)\s+\d+\s+R/.exec(annotText);
          if (bsIndirectMatch) {
            const bsText = objCache.getObjectText(Number(bsIndirectMatch[1]));
            if (bsText) {
              const bsWMatch = /\/W\s+([\d.]+)/.exec(bsText);
              if (bsWMatch) borderWidth = Number(bsWMatch[1]);
            }
          }
        }

        // Inset the rect by half the border width so strokes stay inside the annotation rect
        const hw = borderWidth / 2;
        const x0 = rect[0] + hw;
        const y0 = rect[1] + hw;
        const x1 = rect[2] - hw;
        const y1 = rect[3] - hw;

        /** @type {PathCommand[]} */
        let commands;
        if (annotSubtype === 'Line') {
          // Parse /L [x1 y1 x2 y2]
          const lMatch = /\/L\s*\[\s*([\d.\-+e]+)\s+([\d.\-+e]+)\s+([\d.\-+e]+)\s+([\d.\-+e]+)\s*\]/.exec(annotText);
          if (!lMatch) continue;
          commands = [
            { type: 'M', x: Number(lMatch[1]), y: Number(lMatch[2]) },
            { type: 'L', x: Number(lMatch[3]), y: Number(lMatch[4]) },
          ];
        } else if (annotSubtype === 'Polygon' || annotSubtype === 'PolyLine') {
          // Parse /Vertices [x1 y1 x2 y2 ...]
          const vertMatch = /\/Vertices\s*\[\s*([\d.\-+e\s]+)\]/.exec(annotText);
          if (!vertMatch) continue;
          const coords = vertMatch[1].trim().split(/\s+/).map(Number);
          if (coords.length < 4) continue;
          commands = [{ type: 'M', x: coords[0], y: coords[1] }];
          for (let i = 2; i < coords.length; i += 2) {
            commands.push({ type: 'L', x: coords[i], y: coords[i + 1] });
          }
          if (annotSubtype === 'Polygon') commands.push({ type: 'Z' });
        } else if (annotSubtype === 'Square') {
          commands = [
            { type: 'M', x: x0, y: y0 },
            { type: 'L', x: x1, y: y0 },
            { type: 'L', x: x1, y: y1 },
            { type: 'L', x: x0, y: y1 },
            { type: 'Z' },
          ];
        } else {
          // Circle — approximate ellipse with 4 cubic Bezier curves
          const cx = (x0 + x1) / 2;
          const cy = (y0 + y1) / 2;
          const rx = (x1 - x0) / 2;
          const ry = (y1 - y0) / 2;
          // kappa for cubic Bezier circle approximation
          const k = 0.5522847498;
          const kx = rx * k;
          const ky = ry * k;
          commands = [
            { type: 'M', x: cx + rx, y: cy },
            {
              type: 'C', x1: cx + rx, y1: cy + ky, x2: cx + kx, y2: cy + ry, x: cx, y: cy + ry,
            },
            {
              type: 'C', x1: cx - kx, y1: cy + ry, x2: cx - rx, y2: cy + ky, x: cx - rx, y: cy,
            },
            {
              type: 'C', x1: cx - rx, y1: cy - ky, x2: cx - kx, y2: cy - ry, x: cx, y: cy - ry,
            },
            {
              type: 'C', x1: cx + kx, y1: cy - ry, x2: cx + rx, y2: cy - ky, x: cx + rx, y: cy,
            },
            { type: 'Z' },
          ];
        }

        drawOps.push({
          type: 'path',
          commands,
          ctm: [1, 0, 0, 1, 0, 0],
          fill: hasFill && annotSubtype !== 'PolyLine' && annotSubtype !== 'Line',
          stroke: true,
          evenOdd: false,
          fillColor,
          strokeColor: borderColor,
          lineWidth: borderWidth,
          lineCap: 0,
          lineJoin: 0,
          miterLimit: 10,
          dashArray: [],
          dashPhase: 0,
          fillAlpha: 1,
          strokeAlpha: 1,
        });
      }
    }
  }

  // Check path and text ops for color content
  const isGrayColor = (color) => {
    const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(color);
    return m && m[1] === m[2] && m[2] === m[3];
  };
  const t3xChecked = new Set();
  if (!pageHasColor) {
    for (const op of drawOps) {
      if (op.type === 'image') {
        const imgInfo = images.get(op.name);
        if (!imgInfo) continue;
        // An image mask painted with a shading pattern carries its color in the pattern stops,
        // not in the (1-bit) image, so it must be checked before the skip.
        if (op.patternShading && op.patternShading.stops
          && op.patternShading.stops.some((stop) => !isGrayColor(stop.color))) {
          pageHasColor = true;
          break;
        }
        if (imgInfo.bitsPerComponent === 1) continue;
        const cs = imgInfo.colorSpace;
        if (cs !== 'DeviceGray' && cs !== 'CalGray') {
          if (cs !== 'Indexed' || (imgInfo.paletteBase !== 'DeviceGray' && imgInfo.paletteBase !== 'CalGray')) {
            pageHasColor = true;
            break;
          }
        }
      } else if (op.type === 'path') {
        if ((op.fill && !isGrayColor(op.fillColor)) || (op.stroke && !isGrayColor(op.strokeColor))) {
          pageHasColor = true;
          break;
        }
        // Check pattern shading on path ops (mesh/gouraud/gradient fills via scn)
        if (op.patternShading) {
          const sh = op.patternShading;
          if (sh.type === 'mesh') {
            for (const patch of sh.patches) {
              for (const c of patch.colors) {
                if (c[0] !== c[1] || c[1] !== c[2]) { pageHasColor = true; break; }
              }
              if (pageHasColor) break;
            }
          } else if (sh.type === 'gouraud') {
            for (const tri of sh.triangles) {
              for (const c of tri.colors) {
                if (c[0] !== c[1] || c[1] !== c[2]) { pageHasColor = true; break; }
              }
              if (pageHasColor) break;
            }
          } else if (sh.stops) {
            for (const stop of sh.stops) {
              if (!isGrayColor(stop.color)) { pageHasColor = true; break; }
            }
          }
          if (pageHasColor) break;
        }
      } else if (op.type === 'type0text' && op.fillColor && !isGrayColor(op.fillColor)) {
        pageHasColor = true;
        break;
      } else if (op.type === 'type3glyph') {
        if (op.fillColor && !isGrayColor(op.fillColor)) { pageHasColor = true; break; }
        // A Type3 CharProc can paint a color image XObject (e.g. color emoji glyphs).
        if (op.type3XObjects) {
          for (const xObjNum of Object.values(op.type3XObjects)) {
            if (t3xChecked.has(xObjNum)) continue;
            t3xChecked.add(xObjNum);
            const xObjText = objCache.getObjectText(xObjNum);
            if (!xObjText || !/\/Subtype\s*\/Image/.test(xObjText)) continue;
            const ii = parseImageObject(xObjText, xObjNum, objCache);
            if (!ii || ii.imageMask || ii.bitsPerComponent === 1) continue;
            const cs = ii.colorSpace;
            if (cs !== 'DeviceGray' && cs !== 'CalGray'
              && (cs !== 'Indexed' || (ii.paletteBase !== 'DeviceGray' && ii.paletteBase !== 'CalGray'))) {
              pageHasColor = true;
              break;
            }
          }
          if (pageHasColor) break;
        }
      } else if (op.type === 'shading' && op.shading) {
        const sh = op.shading;
        if (sh.type === 'mesh') {
          for (const patch of sh.patches) {
            for (const c of patch.colors) {
              if (c[0] !== c[1] || c[1] !== c[2]) { pageHasColor = true; break; }
            }
            if (pageHasColor) break;
          }
        } else if (sh.type === 'gouraud') {
          for (const tri of sh.triangles) {
            for (const c of tri.colors) {
              if (c[0] !== c[1] || c[1] !== c[2]) { pageHasColor = true; break; }
            }
            if (pageHasColor) break;
          }
        } else if (sh.stops) {
          for (const stop of sh.stops) {
            if (!isGrayColor(stop.color)) { pageHasColor = true; break; }
          }
        }
        if (pageHasColor) break;
      }
    }
  }
  // Also check tiling pattern images, shading patterns, and text colors for color
  if (!pageHasColor) {
    for (const op of drawOps) {
      if (op.tilingPattern && op.tilingPattern.objNum) {
        const patObjText = objCache.getObjectText(op.tilingPattern.objNum);
        if (patObjText) {
          // Check images inside tiling patterns
          const patImgResult = parsePageImages(patObjText, objCache, { recurseForms: false });
          for (const [, imgInfo] of patImgResult.images) {
            if (imgInfo.bitsPerComponent === 1) continue;
            const cs = imgInfo.colorSpace;
            if (cs !== 'DeviceGray' && cs !== 'CalGray') {
              if (cs !== 'Indexed' || (imgInfo.paletteBase !== 'DeviceGray' && imgInfo.paletteBase !== 'CalGray')) {
                pageHasColor = true;
                break;
              }
            }
          }
          // Check shading patterns inside tiling patterns for color
          if (!pageHasColor) {
            const patPats = parsePatterns(patObjText, objCache);
            for (const [, patInfo] of patPats) {
              if (patInfo.shading && patInfo.shading.stops) {
                for (const stop of patInfo.shading.stops) {
                  if (!isGrayColor(stop.color)) { pageHasColor = true; break; }
                }
              }
              if (pageHasColor) break;
            }
          }
          // Check text/path color operators inside tiling pattern content streams
          if (!pageHasColor) {
            const patStreamBytes = objCache.getStreamBytes(op.tilingPattern.objNum);
            if (patStreamBytes) {
              const patStreamText = bytesToLatin1(patStreamBytes);
              // Scan for non-gray rg/RG operators: "r g b rg" where r≠g or g≠b
              const rgMatches = patStreamText.matchAll(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(?:rg|RG)\b/g);
              for (const m of rgMatches) {
                if (m[1] !== m[2] || m[2] !== m[3]) { pageHasColor = true; break; }
              }
              // Scan for k/K (CMYK) with non-pure-black values: "c m y k k" where c≠0 or m≠0 or y≠0
              if (!pageHasColor) {
                const kMatches = patStreamText.matchAll(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+[kK]\b/g);
                for (const m of kMatches) {
                  if (m[1] !== '0' || m[2] !== '0' || m[3] !== '0') { pageHasColor = true; break; }
                }
              }
            }
          }
        }
        if (pageHasColor) break;
      }
    }
  }
  // Also check inline images for color (BI/ID/EI ops produce 'inlineImage' draw ops
  // that bypass the XObject image scan above).
  if (!pageHasColor) {
    for (const op of drawOps) {
      if (op.type === 'inlineImage') {
        pageHasColor = true;
        break;
      }
    }
  }
  const effectiveColorMode = (pageHasColor && colorMode === 'color') ? 'color' : 'gray';

  // Render at the requested DPI (default 300), but cap the canvas width at
  // 3500px to match the dimension cap applied by imageContainer.js
  // (pageMetricsAll) and extractPDFText.js. Without this, wide pages (e.g.,
  // landscape presentations) produce images larger than the dimensions the
  // viewer uses for layout.
  const maxCanvasWidth = 3500;
  const scaleReq = dpi / 72;
  const fullWidth = Math.ceil(pageWidthPts * scaleReq);
  const scale = fullWidth > maxCanvasWidth ? maxCanvasWidth / pageWidthPts : scaleReq;

  // Match mupdf's fz_round_rect: ceil with small epsilon tolerance for FP precision.
  // This produces the same pixel dimensions as the mupdf baseline renderer.
  const canvasWidth = Math.ceil(pageWidthPts * scale - 0.001);
  const canvasHeight = Math.ceil(pageHeightPts * scale - 0.001);

  const canvas = ca.makeCanvas(canvasWidth, canvasHeight);
  // `willReadFrequently` forces Chromium's software 2D canvas backend.
  // The GPU path fails to render certain pages correctly.
  const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d', { willReadFrequently: true }));
  ctx.imageSmoothingQuality = 'high';

  if (drawOps.length === 0) {
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);
    const emptyImageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
    const out = { dataUrl: await buildPngDataUrl(emptyImageData, 'gray'), colorMode: 'gray', ok: true };
    ca.closeDrawable(canvas);
    return out;
  }

  // Declare caches before try so they're accessible in the finally cleanup block.
  /** @type {Map<string, CanvasPattern>} */
  const tilingPatternCache = new Map();
  // Cache key for a built pattern tile. Pattern names are scoped to their Resources dict,
  // so a page and a nested Form XObject can legally reuse a name (P0, P1) for different pattern objects.
  // The object number is included to disambiguate those scopes.
  const tileKeyOf = (ref) => {
    const base = ref.objNum != null ? `${ref.patName}#${ref.objNum}` : ref.patName;
    return ref.paintColor ? `${base}|${ref.paintColor}` : base;
  };
  // Keep this above the page-level tiling-pattern pre-pass below.
  // `renderTilingPatternTile` calls it for inline-image pattern cells, and that pre-pass runs first.
  // Declaring it lower would make the pre-pass hit a temporal-dead-zone ReferenceError.
  const decodeInlineImage = (op) => decodeInlineImageBitmap(op, objCache, colorSpaces);
  /** @type {Map<string, ImageBitmap>} */
  const bitmapCache = new Map();
  const smaskCanvasCache = new Map();
  // `createPattern(canvas, …)` clones the source surface on every call on
  // Node; tracked here and disposed in the page-end `finally` block.
  /** @type {CanvasPattern[]} */
  const transientPatterns = [];
  let textMeasureCanvas = null;
  let renderFailed = false;
  let failReason = '';
  let failDetail = '';

  try {
  // Apply page rotation to all draw ops by composing rotation CTM with each op's CTM.
  // This transforms content-space coordinates to visual-space coordinates.
    if (rotCtm) {
      for (const op of drawOps) {
        if (op.type === 'type0text') {
        // Text ops store transform components as op.a,b,c,d,x,y (equivalent to CTM [a,b,c,d,x,y])
          const oa = op.a;
          const ob = op.b;
          const oc = op.c;
          const od = op.d;
          const ox = op.x;
          const oy = op.y;
          op.a = rotCtm[0] * oa + rotCtm[2] * ob;
          op.b = rotCtm[1] * oa + rotCtm[3] * ob;
          op.c = rotCtm[0] * oc + rotCtm[2] * od;
          op.d = rotCtm[1] * oc + rotCtm[3] * od;
          op.x = rotCtm[0] * ox + rotCtm[2] * oy + rotCtm[4];
          op.y = rotCtm[1] * ox + rotCtm[3] * oy + rotCtm[5];
        } else if (op.ctm) {
        // Image and path ops store CTM as op.ctm [a,b,c,d,e,f]
          op.ctm = [
            rotCtm[0] * op.ctm[0] + rotCtm[2] * op.ctm[1], rotCtm[1] * op.ctm[0] + rotCtm[3] * op.ctm[1],
            rotCtm[0] * op.ctm[2] + rotCtm[2] * op.ctm[3], rotCtm[1] * op.ctm[2] + rotCtm[3] * op.ctm[3],
            rotCtm[0] * op.ctm[4] + rotCtm[2] * op.ctm[5] + rotCtm[4], rotCtm[1] * op.ctm[4] + rotCtm[3] * op.ctm[5] + rotCtm[5],
          ];
        }
        // Transform clip path CTMs for ALL op types (text, image, path)
        if (op.clips) {
          for (const clip of op.clips) {
            clip.ctm = [
              rotCtm[0] * clip.ctm[0] + rotCtm[2] * clip.ctm[1], rotCtm[1] * clip.ctm[0] + rotCtm[3] * clip.ctm[1],
              rotCtm[0] * clip.ctm[2] + rotCtm[2] * clip.ctm[3], rotCtm[1] * clip.ctm[2] + rotCtm[3] * clip.ctm[3],
              rotCtm[0] * clip.ctm[4] + rotCtm[2] * clip.ctm[5] + rotCtm[4], rotCtm[1] * clip.ctm[4] + rotCtm[3] * clip.ctm[5] + rotCtm[5],
            ];
          }
        }
        if (op.type === 'type3glyph') {
        // Type3 glyph ops store CTM as op.transform [a,b,c,d,e,f]
          op.transform = [
            rotCtm[0] * op.transform[0] + rotCtm[2] * op.transform[1], rotCtm[1] * op.transform[0] + rotCtm[3] * op.transform[1],
            rotCtm[0] * op.transform[2] + rotCtm[2] * op.transform[3], rotCtm[1] * op.transform[2] + rotCtm[3] * op.transform[3],
            rotCtm[0] * op.transform[4] + rotCtm[2] * op.transform[5] + rotCtm[4], rotCtm[1] * op.transform[4] + rotCtm[3] * op.transform[5] + rotCtm[5],
          ];
        }
      }
      // Shading matrices are in pre-rotation user space, so compose rotCtm to
      // match the rotated op.ctm and op.clips above. Dedup via Set since a
      // single shading can be referenced by many ops.
      const rotatedShadings = new Set();
      for (const op of drawOps) {
        const sh = op.patternShading;
        if (!sh || !sh.matrix || rotatedShadings.has(sh)) continue;
        rotatedShadings.add(sh);
        const m = sh.matrix;
        sh.matrix = [
          rotCtm[0] * m[0] + rotCtm[2] * m[1], rotCtm[1] * m[0] + rotCtm[3] * m[1],
          rotCtm[0] * m[2] + rotCtm[2] * m[3], rotCtm[1] * m[2] + rotCtm[3] * m[3],
          rotCtm[0] * m[4] + rotCtm[2] * m[5] + rotCtm[4], rotCtm[1] * m[4] + rotCtm[3] * m[5] + rotCtm[5],
        ];
      }
    }

    /**
     * Apply all clip paths from an op's clip stack to the canvas context.
     * Each clip intersects with the previous, matching PDF semantics for nested W/W* operators.
     * Text clips (from Tr modes 4-7) are skipped here — they are handled via compositing.
     */
    function applyClips(renderCtx, op) {
      if (!op.clips || op.clips.length === 0) return;
      // Clip intersection is commutative, so apply the cheapest (fewest-point) clips first.
      // A simple rectangle clip applied before a complex many-bezier
      // clip bounds the region Skia must rasterize and avoids re-rasterizing the
      // complex clip mask when a simpler clip follows it.
      const clips = op.clips.length > 1
        ? [...op.clips].sort((a, b) => (a.path ? a.path.length : 0) - (b.path ? b.path.length : 0))
        : op.clips;
      for (const clip of clips) {
        if (clip.textClip) continue; // handled separately via compositing
        if (!clip.path) continue;
        renderCtx.setTransform(
          clip.ctm[0] * scale,
          -clip.ctm[1] * scale,
          clip.ctm[2] * scale,
          -clip.ctm[3] * scale,
          (clip.ctm[4] - boxOriginX) * scale,
          (pageHeightPts + boxOriginY - clip.ctm[5]) * scale,
        );
        renderCtx.beginPath();
        for (const cmd of clip.path) {
          if (cmd.type === 'M') renderCtx.moveTo(cmd.x, cmd.y);
          else if (cmd.type === 'L') renderCtx.lineTo(cmd.x, cmd.y);
          else if (cmd.type === 'C') renderCtx.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y);
          else if (cmd.type === 'Z') renderCtx.closePath();
        }
        renderCtx.clip(clip.evenOdd ? 'evenodd' : 'nonzero');
      }
    }

    /**
     * Clip the canvas to the region where an axial (type 2) gradient is defined,
     * respecting the /Extend array. When Extend[i] is false, the gradient does not
     * paint beyond that endpoint, so we clip to the half-plane on the valid side.
     * @param {OffscreenCanvasRenderingContext2D} renderCtx
     * @param {number[]} coords - [x0, y0, x1, y1]
     * @param {boolean[]} extend - [extendStart, extendEnd]
     */
    function clipAxialExtend(renderCtx, coords, extend) {
      const [x0, y0, x1, y1] = coords;
      const dx = x1 - x0;
      const dy = y1 - y0;
      // Perpendicular vector (rotated 90 degrees)
      const px = -dy;
      const py = dx;
      // The clip strip is built in the current user space, so its half-extent must be sized in that space, not in page points.
      // When the shading's /Coords live in a space the CTM scales far from page space (coords in the millions under a ~1e-4 cm),
      // a page-point extent collapses the strip to a sliver and the gradient fill vanishes.
      // Map the canvas corners back into user space and size the extent to span them.
      const perpMag = Math.sqrt(px * px + py * py) || 1;
      let extentUser = Math.max(1e4, pageWidthPts * 10, pageHeightPts * 10);
      const inv = renderCtx.getTransform().inverse();
      if (Number.isFinite(inv.a) && Number.isFinite(inv.e)) {
        let maxDist = 0;
        for (const [cx, cy] of [[0, 0], [canvasWidth, 0], [0, canvasHeight], [canvasWidth, canvasHeight]]) {
          const ux = inv.a * cx + inv.c * cy + inv.e;
          const uy = inv.b * cx + inv.d * cy + inv.f;
          const d = Math.hypot(ux - x0, uy - y0);
          if (d > maxDist) maxDist = d;
        }
        if (maxDist > 0) extentUser = maxDist * 2;
      }
      // perpMag normalizes (px, py) to a unit vector, so BIG * (px, py) spans extentUser in user space.
      // That keeps the clip polygon's device coordinates near canvas scale, well under the ~1e9 some backends reject.
      const BIG = extentUser / perpMag;

      // When extend[0] is false, clip out the half-plane beyond the start point.
      // When extend[1] is false, clip out the half-plane beyond the end point.
      // We build a polygon covering only the valid region.
      if (!extend[0] && !extend[1]) {
      // Clip to the strip between start and end perpendicular lines
        renderCtx.beginPath();
        renderCtx.moveTo(x0 + BIG * px, y0 + BIG * py);
        renderCtx.lineTo(x0 - BIG * px, y0 - BIG * py);
        renderCtx.lineTo(x1 - BIG * px, y1 - BIG * py);
        renderCtx.lineTo(x1 + BIG * px, y1 + BIG * py);
        renderCtx.closePath();
        renderCtx.clip();
      } else if (!extend[0]) {
      // Clip to half-plane on the end-point side of start
        renderCtx.beginPath();
        renderCtx.moveTo(x0 + BIG * px, y0 + BIG * py);
        renderCtx.lineTo(x0 - BIG * px, y0 - BIG * py);
        renderCtx.lineTo(x0 - BIG * px + BIG * dx, y0 - BIG * py + BIG * dy);
        renderCtx.lineTo(x0 + BIG * px + BIG * dx, y0 + BIG * py + BIG * dy);
        renderCtx.closePath();
        renderCtx.clip();
      } else if (!extend[1]) {
      // Clip to half-plane on the start-point side of end
        renderCtx.beginPath();
        renderCtx.moveTo(x1 + BIG * px, y1 + BIG * py);
        renderCtx.lineTo(x1 - BIG * px, y1 - BIG * py);
        renderCtx.lineTo(x1 - BIG * px - BIG * dx, y1 - BIG * py - BIG * dy);
        renderCtx.lineTo(x1 + BIG * px - BIG * dx, y1 + BIG * py - BIG * dy);
        renderCtx.closePath();
        renderCtx.clip();
      }
    }

    /**
     * Fill the half-plane "behind" a Type 3 radial gradient's inner circle with the
     * first stop colour when Extend[0] is true.
     * Canvas2D's radial gradient leaves pixels transparent where the parameter ω resolves negative
     * (i.e. the side of the apex opposite the outer circle).
     * PDF spec §8.7.4.5.4 requires those pixels to take the inner-edge colour when Extend[0] is true.
     * @param {OffscreenCanvasRenderingContext2D} renderCtx
     * @param {{coords: number[], extend: boolean[], stops: {offset: number, color: string}[]}} sh
     */
    function fillRadialExtendBehind(renderCtx, sh) {
      if (!sh.extend || !sh.extend[0]) return;
      const [x0, y0, r0, x1, y1] = sh.coords;
      if (Math.abs(r0) > 1e-9) return;
      const dx = x1 - x0;
      const dy = y1 - y0;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-9) return;
      const ax = dx / len;
      const ay = dy / len;
      const px = -ay;
      const py = ax;
      const BIG = 1e6;
      renderCtx.beginPath();
      renderCtx.moveTo(x0 + BIG * px, y0 + BIG * py);
      renderCtx.lineTo(x0 - BIG * px, y0 - BIG * py);
      renderCtx.lineTo(x0 - BIG * px - BIG * ax, y0 - BIG * py - BIG * ay);
      renderCtx.lineTo(x0 + BIG * px - BIG * ax, y0 + BIG * py - BIG * ay);
      renderCtx.closePath();
      renderCtx.fillStyle = sh.stops[0].color;
      renderCtx.fill();
    }

    /**
     * Check whether an op has a text clip (from Tr modes 4-7) in its clip stack.
     * Returns the textClip array or null.
     */
    function getTextClip(op) {
      if (!op.clips) return null;
      for (const clip of op.clips) {
        if (clip.textClip) return clip.textClip;
      }
      return null;
    }

    /**
     * Draw text clip characters as filled shapes on a canvas (for compositing mask).
     * @param {OffscreenCanvas} maskCanvas
     * @param {Array<{text: string, fontFamily: string, fontSize: number, a: number, b: number, c: number, d: number, x: number, y: number}>} chars
     */
    function drawTextClipMask(maskCanvas, chars) {
      const mCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (maskCanvas.getContext('2d', { willReadFrequently: true }));
      mCtx.fillStyle = 'white';
      for (const ch of chars) {
        mCtx.save();
        // Use the same transform convention as normal text rendering:
        // 1px font (transform already includes fontSize via TRM), and
        // (-c, +d) sign convention matching the type0text rendering path.
        mCtx.setTransform(
          ch.a * scale,
          -ch.b * scale,
          -ch.c * scale,
          ch.d * scale,
          (ch.x - boxOriginX) * scale,
          (pageHeightPts + boxOriginY - ch.y) * scale,
        );
        // fontFamily may already be a multi-family CSS list with embedded quotes
        // (e.g., '"Courier New", Courier, monospace'). Wrap plain identifiers in
        // quotes; use pre-formatted family lists as-is.
        mCtx.font = /[",]/.test(ch.fontFamily)
          ? `1px ${ch.fontFamily}`
          : `1px "${ch.fontFamily}"`;
        mCtx.fillText(ch.text, 0, 0);
        mCtx.restore();
      }
    }

    /**
     * Translate every position component of a draw op (its ctm/transform/text
     * origin, clip ctms, and smask parentCtm) by (dxPdf, dyPdf) in PDF user
     * space, returning a shallow copy. Lets an op render into a tight bbox-sized
     * canvas placed at the bbox origin.
     * @param {any} op
     * @param {number} dxPdf
     * @param {number} dyPdf
     */
    function shiftOpBy(op, dxPdf, dyPdf) {
      /** @type {any} */
      const out = { ...op };
      if (op.clips) {
        out.clips = op.clips.map((/** @type {any} */ c) => {
          /** @type {any} */
          const nc = {
            ...c,
            ctm: c.ctm ? [c.ctm[0], c.ctm[1], c.ctm[2], c.ctm[3], c.ctm[4] + dxPdf, c.ctm[5] + dyPdf] : c.ctm,
          };
          if (c.textClip) nc.textClip = c.textClip.map((/** @type {any} */ ch) => ({ ...ch, x: ch.x + dxPdf, y: ch.y + dyPdf }));
          return nc;
        });
      }
      if (op.smask && op.smask.parentCtm) {
        const pc = op.smask.parentCtm;
        out.smask = { ...op.smask, parentCtm: [pc[0], pc[1], pc[2], pc[3], pc[4] + dxPdf, pc[5] + dyPdf] };
      }
      if (Array.isArray(op.ctm) && op.ctm.length === 6) {
        out.ctm = [op.ctm[0], op.ctm[1], op.ctm[2], op.ctm[3], op.ctm[4] + dxPdf, op.ctm[5] + dyPdf];
      } else if (Array.isArray(op.transform) && op.transform.length === 6) {
        out.transform = [op.transform[0], op.transform[1], op.transform[2], op.transform[3], op.transform[4] + dxPdf, op.transform[5] + dyPdf];
      } else if (op.type === 'type0text') {
        out.x = op.x + dxPdf;
        out.y = op.y + dyPdf;
      }
      return out;
    }

    /**
     * Device-pixel bounding box of a single path, image, type0text, or clipped shading op.
     * Returns null for ops whose extent cannot be bounded (unclipped shadings, other text).
     * Used to size a transparency group's isolation buffer.
     * @param {any} op
     * @returns {{minX:number,minY:number,maxX:number,maxY:number}|null}
     */
    function opDeviceBBox(op) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      const acc = (ux, uy, m) => {
        const px = (m[0] * ux + m[2] * uy + m[4] - boxOriginX) * scale;
        const py = (pageHeightPts + boxOriginY - (m[1] * ux + m[3] * uy + m[5])) * scale;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      };
      if (op.type === 'path' && op.commands && op.ctm) {
        for (const cmd of op.commands) {
          if (cmd.x != null) acc(cmd.x, cmd.y, op.ctm);
          if (cmd.x1 != null) acc(cmd.x1, cmd.y1, op.ctm);
          if (cmd.x2 != null) acc(cmd.x2, cmd.y2, op.ctm);
        }
        if (!Number.isFinite(minX)) return null;
        if (op.stroke) {
          const ctmScale = Math.sqrt(Math.abs(op.ctm[0] * op.ctm[3] - op.ctm[1] * op.ctm[2])) || 1;
          const pad = ((op.lineWidth || 1) * ctmScale * scale) / 2 + 2;
          minX -= pad; minY -= pad; maxX += pad; maxY += pad;
        }
      } else if (op.type === 'image' && (op.ctm || op.transform)) {
        const m = op.ctm || op.transform;
        acc(0, 0, m); acc(1, 0, m); acc(0, 1, m); acc(1, 1, m);
      } else if (op.type === 'type0text' && op.text && op.fontFamily) {
        if (!textMeasureCanvas) textMeasureCanvas = ca.makeCanvas(8, 8);
        const mctx = /** @type {OffscreenCanvasRenderingContext2D} */ (textMeasureCanvas.getContext('2d'));
        mctx.font = /[",]/.test(op.fontFamily) ? `1px ${op.fontFamily}` : `1px "${op.fontFamily}"`;
        const mw = mctx.measureText(op.text).width || 0;
        let hScale = 1;
        if (op.pdfGlyphWidth !== undefined && mw > 0) {
          hScale = op.pdfGlyphWidth / (1000 * mw);
          if (!/^"?_pdf_/.test(op.fontFamily) && hScale > 2.0) hScale = 1;
        }
        // Matches the type0text glyph transform: (a*hScale, -b*hScale, -c, d).
        const a = op.a * scale * hScale;
        const b = -op.b * scale * hScale;
        const c = -op.c * scale;
        const d = op.d * scale;
        const e = (op.x - boxOriginX) * scale;
        const f = (pageHeightPts + boxOriginY - op.y) * scale;
        for (const corner of [[-0.2, -1.3], [mw + 0.2, -1.3], [-0.2, 0.5], [mw + 0.2, 0.5]]) {
          const px = a * corner[0] + c * corner[1] + e;
          const py = b * corner[0] + d * corner[1] + f;
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
        }
      } else if (op.type === 'shading' && op.clips && op.clips.length) {
        // A standalone shading paints fillRect(-1e9..) clipped to op.clips, so its extent is the intersection of the clip paths.
        // Curve control points over-bound the curve, which is safe.
        // Unclipped shadings fill the page -> null.
        let ix0 = -Infinity;
        let iy0 = -Infinity;
        let ix1 = Infinity;
        let iy1 = Infinity;
        for (const clip of op.clips) {
          if (!clip.path || !clip.ctm) return null;
          let c0x = Infinity;
          let c0y = Infinity;
          let c1x = -Infinity;
          let c1y = -Infinity;
          for (const cmd of clip.path) {
            const pts = cmd.x1 != null
              ? [[cmd.x1, cmd.y1], [cmd.x2, cmd.y2], [cmd.x, cmd.y]]
              : (cmd.x != null ? [[cmd.x, cmd.y]] : []);
            for (const [ux, uy] of pts) {
              const px = (clip.ctm[0] * ux + clip.ctm[2] * uy + clip.ctm[4] - boxOriginX) * scale;
              const py = (pageHeightPts + boxOriginY - (clip.ctm[1] * ux + clip.ctm[3] * uy + clip.ctm[5])) * scale;
              if (px < c0x) c0x = px;
              if (px > c1x) c1x = px;
              if (py < c0y) c0y = py;
              if (py > c1y) c1y = py;
            }
          }
          if (!Number.isFinite(c0x)) return null;
          if (c0x > ix0) ix0 = c0x;
          if (c0y > iy0) iy0 = c0y;
          if (c1x < ix1) ix1 = c1x;
          if (c1y < iy1) iy1 = c1y;
        }
        if (ix1 <= ix0 || iy1 <= iy0) return null;
        minX = ix0; minY = iy0; maxX = ix1; maxY = iy1;
      } else {
        return null;
      }
      if (!Number.isFinite(minX)) return null;
      return {
        minX, minY, maxX, maxY,
      };
    }

    /**
     * Device-pixel bounding box enclosing a text-clip's glyphs, padded and
     * clamped to the page. Returns null if it cannot be measured. Uses the same
     * transform convention as `drawTextClipMask`.
     * @param {Array<{text:string,fontFamily:string,a:number,b:number,c:number,d:number,x:number,y:number}>} chars
     * @returns {{x:number,y:number,w:number,h:number}|null}
     */
    function textClipDeviceBBox(chars) {
      if (!chars || chars.length === 0) return null;
      if (!textMeasureCanvas) textMeasureCanvas = ca.makeCanvas(8, 8);
      const mctx = /** @type {OffscreenCanvasRenderingContext2D} */ (textMeasureCanvas.getContext('2d'));
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const ch of chars) {
        mctx.font = /[",]/.test(ch.fontFamily) ? `1px ${ch.fontFamily}` : `1px "${ch.fontFamily}"`;
        const w = mctx.measureText(ch.text).width || 0;
        // 1px font. Glyphs can reach past the advance width and ~1.3 em above /
        // ~0.5 em below the baseline. Over-enclose so no glyph is ever clipped.
        const corners = [[-0.2, -1.3], [w + 0.2, -1.3], [-0.2, 0.5], [w + 0.2, 0.5]];
        for (let ci = 0; ci < 4; ci++) {
          const lx = corners[ci][0];
          const ly = corners[ci][1];
          const dx = ch.a * scale * lx - ch.c * scale * ly + (ch.x - boxOriginX) * scale;
          const dy = -ch.b * scale * lx + ch.d * scale * ly + (pageHeightPts + boxOriginY - ch.y) * scale;
          if (dx < minX) minX = dx;
          if (dx > maxX) maxX = dx;
          if (dy < minY) minY = dy;
          if (dy > maxY) maxY = dy;
        }
      }
      if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
      const x = Math.max(0, Math.floor(minX) - 3);
      const y = Math.max(0, Math.floor(minY) - 3);
      const right = Math.min(canvasWidth, Math.ceil(maxX) + 3);
      const bottom = Math.min(canvasHeight, Math.ceil(maxY) + 3);
      return {
        x,
        y,
        w: right - x,
        h: bottom - y,
      };
    }

    // Pre-render tiling patterns (PatternType 1) to CanvasPattern objects.
    // Each pattern's content stream is rendered once to a small canvas, then reused via createPattern().

    /**
     * Render a single tiling pattern tile and cache the resulting CanvasPattern.
     * @param {string} patName - Pattern name for cache key
     * @param {{ objNum: number, bbox: number[], xStep: number, yStep: number, matrix: number[], paintType: number, paintColor?: string }} tp - Tiling pattern metadata
     */
    async function renderTilingPatternTile(patName, tp) {
      const cacheKey = tileKeyOf({ ...tp, patName });
      if (tilingPatternCache.has(cacheKey)) return;
      const patStreamBytes = objCache.getStreamBytes(tp.objNum);
      if (!patStreamBytes) return;
      const patStream = bytesToLatin1(patStreamBytes);

      const patObjText = objCache.getObjectText(tp.objNum);
      if (!patObjText) return;

      // Parse images from the pattern's resources
      let patResText = patObjText;
      const patResRef = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(patObjText);
      if (patResRef) {
        const resObj = objCache.getObjectText(Number(patResRef[1]));
        if (resObj) patResText = resObj;
      }
      const patImagesResult = parsePageImages(patResText, objCache, { recurseForms: false });
      const patImages = patImagesResult.images;
      const patForms = patImagesResult.forms;

      // Parse fonts from the pattern's resources and register them for canvas text rendering
      const patFonts = parsePageFonts(patObjText, objCache);
      const patRegistered = new Map();
      const patSymbolTags = new Set();
      const patCidPUATags = new Set();
      const patRawCharCodeTags = new Set();
      for (const [fontTag, fontObj] of patFonts) {
        // Pattern fonts share the same (docId, fontObjNum) identity as the
        // page-level fonts they (usually) reference, so the same alias is
        // reused across the page's pattern cells and the page body.
        const familyName = pdfFontFamilyName(objCache, fontObj.fontObjNum, `pat_${patName}_${fontTag}`);
        await convertAndRegisterFont(
          fontTag, fontObj, patRegistered, patSymbolTags, patCidPUATags,
          patRawCharCodeTags, cidCollisionMap, objCache, familyName,
        );
      }
      appendGenericFallbacks(patRegistered, patFonts);

      // The repeat cell is XStep/YStep, not the BBox.
      // `createPattern('repeat')` tiles at the canvas size, so when the BBox
      // exceeds the step the canvas is mostly empty and tiles with gaps.
      // Shrink the cell to the step, clamping downward only.
      // A step at or above the BBox keeps the old sizing (gapped or oversized tiles).
      // Cell content stays positioned relative to the BBox origin (tp.bbox[0/1]).
      const fullBboxW = tp.bbox[2] - tp.bbox[0];
      const fullBboxH = tp.bbox[3] - tp.bbox[1];
      const bboxW = tp.xStep ? Math.min(fullBboxW, Math.abs(tp.xStep)) : fullBboxW;
      const bboxH = tp.yStep ? Math.min(fullBboxH, Math.abs(tp.yStep)) : fullBboxH;
      const matScaleX = Math.sqrt(tp.matrix[0] * tp.matrix[0] + tp.matrix[1] * tp.matrix[1]);
      const matScaleY = Math.sqrt(tp.matrix[2] * tp.matrix[2] + tp.matrix[3] * tp.matrix[3]);
      const { tileW, tileH } = tilingTilePixelDims(bboxW, bboxH, matScaleX, matScaleY, scale);

      const tileCanvas = ca.makeCanvas(tileW, tileH);
      const tileCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (tileCanvas.getContext('2d', { willReadFrequently: true }));

      // Parse ExtGState, shadings, patterns, and color spaces from the pattern's resources
      const patExtGStates = parseExtGStates(patObjText, objCache);
      const patShadings = parseShadings(patObjText, objCache);
      const patPatterns = parsePatterns(patObjText, objCache);
      const patColorSpaces = parsePageColorSpaces(patObjText, objCache);

      const patRawDrawOps = parseDrawOps(patStream, patFonts, patExtGStates, patRegistered,
        patColorSpaces.size > 0 ? patColorSpaces : undefined, patSymbolTags, patCidPUATags,
        patRawCharCodeTags, patShadings, patPatterns, cidCollisionMap);

      // Expand Form XObjects in pattern draw ops.
      let patDrawOps;
      if (patForms.size > 0) {
        patDrawOps = [];
        for (const op of patRawDrawOps) {
          if (op.type === 'image') {
            const flattened = await flattenDrawOps(
              [op], patImages, patForms, objCache, patFonts, patRegistered,
              '', 0, patSymbolTags, patCidPUATags, patExtGStates, patRawCharCodeTags,
              new Map(), 0, new Set(), cidCollisionMap,
            );
            for (let fi = 0; fi < flattened.length; fi++) patDrawOps.push(flattened[fi]);
          } else {
            patDrawOps.push(op);
          }
        }
      } else {
        patDrawOps = patRawDrawOps;
      }

      const tileScaleX = tileW / bboxW;
      const tileScaleY = tileH / bboxH;
      for (const pop of patDrawOps) {
        if (pop.type === 'image') {
          const imgInfo = patImages.get(pop.name);
          if (!imgInfo) continue;
          const bitmap = imgInfo.imageMask
            ? await imageMaskToBitmap(imgInfo, tp.paintColor || pop.fillColor || 'black', objCache)
            : await imageInfoToBitmap(imgInfo, objCache);
          tileCtx.save();
          tileCtx.setTransform(
            pop.ctm[0] * tileScaleX, -pop.ctm[1] * tileScaleY,
            pop.ctm[2] * tileScaleX, -pop.ctm[3] * tileScaleY,
            (pop.ctm[4] - tp.bbox[0]) * tileScaleX,
            (bboxH + tp.bbox[1] - pop.ctm[5]) * tileScaleY,
          );
          tileCtx.transform(1, 0, 0, -1, 0, 1);
          tileCtx.drawImage(bitmap, 0, 0, 1, 1);
          tileCtx.restore();
          ca.closeDrawable(bitmap);
        } else if (pop.type === 'inlineImage') {
        // Handle inline images inside tiling pattern streams
          try {
            const bitmap = await decodeInlineImage(pop);
            if (bitmap) {
              tileCtx.save();
              tileCtx.setTransform(
                pop.ctm[0] * tileScaleX, -pop.ctm[1] * tileScaleY,
                pop.ctm[2] * tileScaleX, -pop.ctm[3] * tileScaleY,
                (pop.ctm[4] - tp.bbox[0]) * tileScaleX,
                (bboxH + tp.bbox[1] - pop.ctm[5]) * tileScaleY,
              );
              tileCtx.transform(1, 0, 0, -1, 0, 1);
              tileCtx.drawImage(bitmap, 0, 0, 1, 1);
              tileCtx.restore();
              ca.closeDrawable(bitmap);
            }
          } catch { /* skip */ }
        } else if (pop.type === 'path' && (pop.fill || pop.stroke)) {
          if (pop.fill) {
            // Determine the target context — if the op has an SMask, draw to a temp canvas first
            let drawCtx = tileCtx;
            let tempCanvas = null;
            if (pop.smask) {
              tempCanvas = ca.makeCanvas(tileW, tileH);
              drawCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (tempCanvas.getContext('2d', { willReadFrequently: true }));
            }

            drawCtx.save();
            if (pop.fillAlpha < 1) drawCtx.globalAlpha = pop.fillAlpha;
            drawCtx.setTransform(
              pop.ctm[0] * tileScaleX, -pop.ctm[1] * tileScaleY,
              pop.ctm[2] * tileScaleX, -pop.ctm[3] * tileScaleY,
              (pop.ctm[4] - tp.bbox[0]) * tileScaleX,
              (bboxH + tp.bbox[1] - pop.ctm[5]) * tileScaleY,
            );
            drawCtx.beginPath();
            for (const cmd of pop.commands) {
              switch (cmd.type) {
                case 'M': drawCtx.moveTo(cmd.x, cmd.y); break;
                case 'L': drawCtx.lineTo(cmd.x, cmd.y); break;
                case 'C': drawCtx.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y); break;
                case 'Z': drawCtx.closePath(); break;
                default: break;
              }
            }
            if (pop.tilingPattern) {
            // Nested tiling pattern fill: recursively render inner pattern, then tile it
              const innerPatName = pop.tilingPattern.patName;
              const innerKey = tileKeyOf(pop.tilingPattern);
              if (pop.tilingPattern.objNum && !tilingPatternCache.has(innerKey)) {
                try { await renderTilingPatternTile(innerPatName, pop.tilingPattern); } catch { /* skip */ }
              }
              const innerBitmap = tilingPatternCache.get(innerKey);
              if (innerBitmap) {
                drawCtx.clip(pop.evenOdd ? 'evenodd' : 'nonzero');
                const itp = pop.tilingPattern;
                const imatScaleX = Math.sqrt(itp.matrix[0] * itp.matrix[0] + itp.matrix[1] * itp.matrix[1]);
                const imatScaleY = Math.sqrt(itp.matrix[2] * itp.matrix[2] + itp.matrix[3] * itp.matrix[3]);
                const ibboxW = itp.bbox[2] - itp.bbox[0];
                const ibboxH = itp.bbox[3] - itp.bbox[1];

                // Compute inner tile origin and step vectors in outer tile pixel space
                const te0 = (itp.matrix[4] + itp.matrix[0] * itp.bbox[0] + itp.matrix[2] * (itp.bbox[1] + ibboxH) - tp.bbox[0]) * tileScaleX;
                const tf0 = (bboxH + tp.bbox[1] - itp.matrix[5] - itp.matrix[1] * itp.bbox[0] - itp.matrix[3] * (itp.bbox[1] + ibboxH)) * tileScaleY;
                const dex = itp.matrix[0] * itp.xStep * tileScaleX;
                const dfx = -itp.matrix[1] * itp.xStep * tileScaleY;
                const dey = itp.matrix[2] * itp.yStep * tileScaleX;
                const dfy = -itp.matrix[3] * itp.yStep * tileScaleY;
                const ta = itp.matrix[0] / imatScaleX;
                const tb2 = -itp.matrix[1] / imatScaleX;
                const tc2 = -itp.matrix[2] / imatScaleY;
                const td2 = itp.matrix[3] / imatScaleY;

                const stepXPx = Math.max(1, Math.sqrt(dex * dex + dfx * dfx));
                const stepYPx = Math.max(1, Math.sqrt(dey * dey + dfy * dfy));
                const repeatX = Math.ceil(tileW / stepXPx) + 2;
                const repeatY = Math.ceil(tileH / stepYPx) + 2;

                for (let ry = -repeatY; ry <= repeatY; ry++) {
                  for (let rx = -repeatX; rx <= repeatX; rx++) {
                    const te = te0 + rx * dex + ry * dey;
                    const tf = tf0 + rx * dfx + ry * dfy;
                    drawCtx.setTransform(ta, tb2, tc2, td2, te, tf);
                    drawCtx.drawImage(innerBitmap, 0, 0);
                  }
                }
              } else {
                drawCtx.fillStyle = pop.fillColor;
                drawCtx.fill(pop.evenOdd ? 'evenodd' : 'nonzero');
              }
            } else if (pop.patternShading) {
              const sh = pop.patternShading;
              drawCtx.clip(pop.evenOdd ? 'evenodd' : 'nonzero');
              if (sh.matrix) drawCtx.transform(...sh.matrix);
              if (sh.type === 'mesh') {
                renderMeshPatches(drawCtx, sh.patches);
              } else if (sh.type === 'gouraud') {
                renderGouraudTriangles(drawCtx, sh.triangles, null, [tileW, tileH]);
              } else {
                let grad;
                if (sh.type === 2) {
                  grad = drawCtx.createLinearGradient(sh.coords[0], sh.coords[1], sh.coords[2], sh.coords[3]);
                } else if (sh.type === 3) {
                  grad = drawCtx.createRadialGradient(sh.coords[0], sh.coords[1], sh.coords[2], sh.coords[3], sh.coords[4], sh.coords[5]);
                }
                if (grad) {
                  for (const stop of sh.stops) grad.addColorStop(stop.offset, stop.color);
                  drawCtx.fillStyle = grad;
                  drawCtx.fillRect(-1e9, -1e9, 2e9, 2e9);
                } else {
                  drawCtx.fillStyle = pop.fillColor;
                  drawCtx.fill(pop.evenOdd ? 'evenodd' : 'nonzero');
                }
              }
            } else {
              drawCtx.fillStyle = pop.fillColor;
              drawCtx.fill(pop.evenOdd ? 'evenodd' : 'nonzero');
            }
            drawCtx.restore();

            // Apply SMask: render mask form, convert to luminosity alpha, composite
            if (pop.smask && tempCanvas) {
              const maskCanvas = await renderSMaskToCanvas(pop.smask, objCache, tileW, tileH, bboxH, tp.bbox[0], tp.bbox[1], tileScaleX);
              if (maskCanvas) {
                const tempCtx2 = /** @type {OffscreenCanvasRenderingContext2D} */ (tempCanvas.getContext('2d', { willReadFrequently: true }));
                tempCtx2.globalCompositeOperation = 'destination-in';
                tempCtx2.drawImage(maskCanvas, 0, 0);
                ca.closeDrawable(maskCanvas);
                tempCtx2.globalCompositeOperation = 'source-over';
              }
              tileCtx.drawImage(tempCanvas, 0, 0);
              ca.closeDrawable(tempCanvas);
            }
          } // end if (pop.fill)
          if (pop.stroke) {
            tileCtx.save();
            if (pop.strokeAlpha < 1) tileCtx.globalAlpha = pop.strokeAlpha;
            tileCtx.setTransform(
              pop.ctm[0] * tileScaleX, -pop.ctm[1] * tileScaleY,
              pop.ctm[2] * tileScaleX, -pop.ctm[3] * tileScaleY,
              (pop.ctm[4] - tp.bbox[0]) * tileScaleX,
              (bboxH + tp.bbox[1] - pop.ctm[5]) * tileScaleY,
            );
            tileCtx.beginPath();
            for (const cmd of pop.commands) {
              switch (cmd.type) {
                case 'M': tileCtx.moveTo(cmd.x, cmd.y); break;
                case 'L': tileCtx.lineTo(cmd.x, cmd.y); break;
                case 'C': tileCtx.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y); break;
                case 'Z': tileCtx.closePath(); break;
                default: break;
              }
            }
            tileCtx.strokeStyle = pop.strokeColor || 'black';
            if (pop.lineWidth > 0) {
              tileCtx.lineWidth = pop.lineWidth;
            } else {
              const sx = Math.sqrt(pop.ctm[0] * pop.ctm[0] + pop.ctm[1] * pop.ctm[1]) * tileScaleX;
              const sy = Math.sqrt(pop.ctm[2] * pop.ctm[2] + pop.ctm[3] * pop.ctm[3]) * tileScaleY;
              tileCtx.lineWidth = 1 / (Math.max(sx, sy) || 1);
            }
            tileCtx.lineCap = /** @type {CanvasLineCap} */ (['butt', 'round', 'square'][pop.lineCap] || 'butt');
            tileCtx.lineJoin = /** @type {CanvasLineJoin} */ (['miter', 'round', 'bevel'][pop.lineJoin] || 'miter');
            if (pop.miterLimit) tileCtx.miterLimit = pop.miterLimit;
            if (pop.dashArray && pop.dashArray.length > 0) {
              tileCtx.setLineDash(pop.dashArray);
              tileCtx.lineDashOffset = pop.dashPhase || 0;
            }
            tileCtx.stroke();
            tileCtx.restore();
          }
        } else if (pop.type === 'type0text' && pop.fontFamily && pop.text) {
          const isEmbedded = /^"?_pdf_/.test(pop.fontFamily);
          const weight = (!isEmbedded && pop.bold) ? 'bold' : 'normal';
          const style = (!isEmbedded && pop.italic) ? 'italic' : 'normal';
          tileCtx.save();
          tileCtx.font = /[",]/.test(pop.fontFamily)
            ? `${style} ${weight} 1px ${pop.fontFamily}`
            : `${style} ${weight} 1px "${pop.fontFamily}"`;
          tileCtx.textBaseline = 'alphabetic';
          let tileHScale = 1;
          if (pop.pdfGlyphWidth !== undefined) {
            const mw = tileCtx.measureText(pop.text).width;
            if (mw > 0) {
              tileHScale = pop.pdfGlyphWidth / (1000 * mw);
              if (!isEmbedded && tileHScale > 2.0) tileHScale = 1;
            }
          }
          tileCtx.setTransform(
            pop.a * tileScaleX * tileHScale,
            -pop.b * tileScaleY * tileHScale,
            -pop.c * tileScaleX,
            pop.d * tileScaleY,
            (pop.x - tp.bbox[0]) * tileScaleX,
            (bboxH + tp.bbox[1] - pop.y) * tileScaleY,
          );
          tileCtx.fillStyle = pop.fillColor || 'black';
          if (pop.fillAlpha < 1) tileCtx.globalAlpha = pop.fillAlpha;
          tileCtx.fillText(pop.text, 0, 0);
          tileCtx.restore();
        } else if (pop.type === 'shading' && pop.shading) {
          // Cells can paint standalone `sh` shadings (e.g. a logo built from quadrant Gouraud meshes).
          // Map cell space to the tile canvas and apply the cell's clip so a shading clipped to a sub-region stays there.
          const sh = pop.shading;
          tileCtx.save();
          if (pop.fillAlpha < 1) tileCtx.globalAlpha = pop.fillAlpha;
          if (pop.clips) {
            for (const clip of pop.clips) {
              if (clip.textClip || !clip.path) continue;
              tileCtx.setTransform(
                clip.ctm[0] * tileScaleX, -clip.ctm[1] * tileScaleY,
                clip.ctm[2] * tileScaleX, -clip.ctm[3] * tileScaleY,
                (clip.ctm[4] - tp.bbox[0]) * tileScaleX,
                (bboxH + tp.bbox[1] - clip.ctm[5]) * tileScaleY,
              );
              tileCtx.beginPath();
              for (const cmd of clip.path) {
                if (cmd.type === 'M') tileCtx.moveTo(cmd.x, cmd.y);
                else if (cmd.type === 'L') tileCtx.lineTo(cmd.x, cmd.y);
                else if (cmd.type === 'C') tileCtx.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y);
                else if (cmd.type === 'Z') tileCtx.closePath();
              }
              tileCtx.clip(clip.evenOdd ? 'evenodd' : 'nonzero');
            }
          }
          tileCtx.setTransform(
            pop.ctm[0] * tileScaleX, -pop.ctm[1] * tileScaleY,
            pop.ctm[2] * tileScaleX, -pop.ctm[3] * tileScaleY,
            (pop.ctm[4] - tp.bbox[0]) * tileScaleX,
            (bboxH + tp.bbox[1] - pop.ctm[5]) * tileScaleY,
          );
          if (sh.type === 'mesh') {
            renderMeshPatches(tileCtx, sh.patches);
          } else if (sh.type === 'gouraud') {
            renderGouraudTriangles(tileCtx, sh.triangles, null, [tileW, tileH]);
          } else if (sh.type === 2 || sh.type === 3) {
            const grad = sh.type === 2
              ? tileCtx.createLinearGradient(sh.coords[0], sh.coords[1], sh.coords[2], sh.coords[3])
              : tileCtx.createRadialGradient(sh.coords[0], sh.coords[1], sh.coords[2], sh.coords[3], sh.coords[4], sh.coords[5]);
            for (const stop of sh.stops) grad.addColorStop(stop.offset, stop.color);
            tileCtx.fillStyle = grad;
            tileCtx.fillRect(-1e9, -1e9, 2e9, 2e9);
          }
          tileCtx.restore();
        }
      }

      const tileBitmap = await ca.createImageBitmapFromCanvas(tileCanvas);
      tilingPatternCache.set(cacheKey, tileBitmap);
    }

    // Render page-level tiling patterns
    for (const [patName, patInfo] of pagePatterns) {
      if (!patInfo.tiling) continue;
      try { await renderTilingPatternTile(patName, patInfo.tiling); } catch { /* skip */ }
    }

    // Render any tiling patterns discovered in Form XObjects (referenced from draw ops)
    for (const op of drawOps) {
      if (op.tilingPattern && op.tilingPattern.objNum && !tilingPatternCache.has(tileKeyOf(op.tilingPattern))) {
        try { await renderTilingPatternTile(op.tilingPattern.patName, op.tilingPattern); } catch { /* skip */ }
      }
    }

    const imageDrawCounts = new Map();
    for (const op of drawOps) {
      if (op.type === 'image') imageDrawCounts.set(op.name, (imageDrawCounts.get(op.name) || 0) + 1);
    }

    // Cache parsed Type3 glyph paths to avoid re-parsing the same CharProc
    const glyphPathCache = new Map();

    /**
     * Render a path op synchronously. This is the hot path for pages with many
     * vector elements (e.g., 73K circles). Avoids async/await overhead that
     * would otherwise create 73K microtask transitions.
     * @returns {boolean} true if handled, false if caller should use renderSingleOp
     */
    function renderPathOpSync(rCtx, op) {
      if (op.type !== 'path') return false;
      if (op.stroke && (op.strokePatternShading || op.strokeTilingPattern)) return false;
      rCtx.save();
      if (op.blendMode && op.blendMode !== 'Normal') {
        rCtx.globalCompositeOperation = pdfBlendToCanvas[op.blendMode] || op.blendMode.toLowerCase();
      }
      applyClips(rCtx, op);
      rCtx.setTransform(
        op.ctm[0] * scale, -op.ctm[1] * scale, op.ctm[2] * scale, -op.ctm[3] * scale,
        (op.ctm[4] - boxOriginX) * scale, (pageHeightPts + boxOriginY - op.ctm[5]) * scale,
      );
      rCtx.beginPath();
      for (const cmd of op.commands) {
        switch (cmd.type) {
          case 'M': rCtx.moveTo(cmd.x, cmd.y); break;
          case 'L': rCtx.lineTo(cmd.x, cmd.y); break;
          case 'C': rCtx.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y); break;
          case 'Z': rCtx.closePath(); break;
          default: break;
        }
      }
      if (op.fill) {
        rCtx.globalAlpha = op.fillAlpha;
        if (op.tilingPattern) {
          const tileCvs = tilingPatternCache.get(tileKeyOf(op.tilingPattern));
          if (tileCvs) {
            // Use ctx.createPattern + setTransform + fillRect rather than per-tile
            // drawImage calls. Patterns with small tile bbox can require hundreds of
            // thousands of draws per page; the native pattern API collapses that
            // into a single fillRect.
            const tp = op.tilingPattern;
            const bboxW = tp.bbox[2] - tp.bbox[0];
            const bboxH = tp.bbox[3] - tp.bbox[1];
            const matScaleX = Math.sqrt(tp.matrix[0] * tp.matrix[0] + tp.matrix[1] * tp.matrix[1]) || 1;
            const matScaleY = Math.sqrt(tp.matrix[2] * tp.matrix[2] + tp.matrix[3] * tp.matrix[3]) || 1;
            const { tileW, tileH } = tilingTilePixelDims(bboxW, bboxH, matScaleX, matScaleY, scale);
            const sx = bboxW / tileW * scale;
            const sy = bboxH / tileH * scale;

            rCtx.save();
            // Clip is captured under the path-to-device CTM; switch to
            // identity so the pattern matrix below is in device pixels.
            rCtx.clip(op.evenOdd ? 'evenodd' : 'nonzero');
            rCtx.setTransform(1, 0, 0, 1, 0, 0);
            const canvasPat = rCtx.createPattern(tileCvs, 'repeat');
            transientPatterns.push(canvasPat);
            canvasPat.setTransform(new DOMMatrix([
              tp.matrix[0] * sx, -tp.matrix[1] * sx,
              -tp.matrix[2] * sy, tp.matrix[3] * sy,
              (tp.matrix[0] * tp.bbox[0] + tp.matrix[2] * (tp.bbox[1] + bboxH) + tp.matrix[4] - boxOriginX) * scale,
              (pageHeightPts + boxOriginY - tp.matrix[1] * tp.bbox[0] - tp.matrix[3] * (tp.bbox[1] + bboxH) - tp.matrix[5]) * scale,
            ]));
            rCtx.fillStyle = canvasPat;
            rCtx.fillRect(0, 0, canvasWidth, canvasHeight);
            rCtx.restore();
            // Disposal is deferred to the render-level `finally` via
            // `transientPatterns`.
          } else {
            rCtx.fillStyle = op.fillColor;
            rCtx.fill(op.evenOdd ? 'evenodd' : 'nonzero');
          }
        } else if (op.patternShading) {
          const sh = op.patternShading;
          // Pattern matrix maps shading coords to the content stream's default user space.
          // For Form XObject content, patternBaseCTM maps that space to page space.
          // For page-level content, patternBaseCTM is absent (default user space IS page space).
          const bctm = op.patternBaseCTM;
          if (sh.type === 'mesh') {
            rCtx.save();
            rCtx.clip(op.evenOdd ? 'evenodd' : 'nonzero');
            rCtx.setTransform(scale, 0, 0, -scale, -boxOriginX * scale, (pageHeightPts + boxOriginY) * scale);
            if (bctm) rCtx.transform(bctm[0], bctm[1], bctm[2], bctm[3], bctm[4], bctm[5]);
            if (sh.matrix) rCtx.transform(...sh.matrix);
            renderMeshPatches(rCtx, sh.patches);
            rCtx.restore();
          } else if (sh.type === 'gouraud') {
            // Render the Gouraud triangle mesh with per-pixel barycentric color interpolation.
            rCtx.save();
            rCtx.clip(op.evenOdd ? 'evenodd' : 'nonzero');
            rCtx.setTransform(scale, 0, 0, -scale, -boxOriginX * scale, (pageHeightPts + boxOriginY) * scale);
            if (bctm) rCtx.transform(bctm[0], bctm[1], bctm[2], bctm[3], bctm[4], bctm[5]);
            if (sh.matrix) rCtx.transform(...sh.matrix);
            renderGouraudTriangles(rCtx, sh.triangles, gouraudClipBounds);
            rCtx.restore();
          } else {
            rCtx.save();
            rCtx.clip(op.evenOdd ? 'evenodd' : 'nonzero');
            rCtx.setTransform(scale, 0, 0, -scale, -boxOriginX * scale, (pageHeightPts + boxOriginY) * scale);
            if (bctm) rCtx.transform(bctm[0], bctm[1], bctm[2], bctm[3], bctm[4], bctm[5]);
            if (sh.matrix) rCtx.transform(...sh.matrix);
            if (sh.bbox) {
              rCtx.beginPath();
              rCtx.rect(sh.bbox[0], sh.bbox[1], sh.bbox[2] - sh.bbox[0], sh.bbox[3] - sh.bbox[1]);
              rCtx.clip();
            }
            if (sh.extend && (!sh.extend[0] || !sh.extend[1]) && sh.type === 2) {
              clipAxialExtend(rCtx, sh.coords, sh.extend);
            }
            let grad;
            if (sh.type === 2) {
              grad = rCtx.createLinearGradient(sh.coords[0], sh.coords[1], sh.coords[2], sh.coords[3]);
            } else if (sh.type === 3) {
              grad = rCtx.createRadialGradient(sh.coords[0], sh.coords[1], sh.coords[2], sh.coords[3], sh.coords[4], sh.coords[5]);
            }
            if (grad) {
              for (const stop of sh.stops) grad.addColorStop(stop.offset, stop.color);
              rCtx.fillStyle = grad;
              rCtx.fillRect(-1e9, -1e9, 2e9, 2e9);
            } else {
              rCtx.fillStyle = op.fillColor;
              rCtx.fillRect(-1e9, -1e9, 2e9, 2e9);
            }
            rCtx.restore();
          }
        } else {
          rCtx.fillStyle = op.fillColor;
          rCtx.fill(op.evenOdd ? 'evenodd' : 'nonzero');
        }
      }
      if (op.stroke) {
        rCtx.globalAlpha = op.strokeAlpha;
        rCtx.strokeStyle = op.strokeColor;
        // PDF spec: lineWidth 0 = thinnest line (1 device pixel).
        // Canvas ignores lineWidth=0, so compute a hairline width instead.
        if (op.lineWidth > 0) {
          rCtx.lineWidth = op.lineWidth;
        } else {
          const sx = Math.sqrt(op.ctm[0] * op.ctm[0] + op.ctm[1] * op.ctm[1]) * scale;
          const sy = Math.sqrt(op.ctm[2] * op.ctm[2] + op.ctm[3] * op.ctm[3]) * scale;
          rCtx.lineWidth = 1 / (Math.max(sx, sy) || 1);
        }
        rCtx.lineCap = /** @type {CanvasLineCap} */ (['butt', 'round', 'square'][op.lineCap] || 'butt');
        rCtx.lineJoin = /** @type {CanvasLineJoin} */ (['miter', 'round', 'bevel'][op.lineJoin] || 'miter');
        rCtx.miterLimit = op.miterLimit;
        if (op.dashArray.length > 0) {
          rCtx.setLineDash(op.dashArray);
          rCtx.lineDashOffset = op.dashPhase;
        }
        rCtx.stroke();
      }
      rCtx.restore();
      return true;
    }

    async function renderSingleOp(rCtx, op) {
      if (op.type === 'image') {
        const imageInfo = images.get(op.name);
        if (!imageInfo) return;

        // For image masks with tiling pattern fill, composite the pattern through the mask
        if (imageInfo.imageMask && op.tilingPattern) {
          const tileCvs = tilingPatternCache.get(tileKeyOf(op.tilingPattern));
          const canvasPat = tileCvs ? rCtx.createPattern(tileCvs, 'repeat') : null; if (canvasPat) transientPatterns.push(canvasPat);
          if (canvasPat) {
            const tileMaskKey = `${op.name}|rgb(255,255,255)`;
            const cachedTileMask = bitmapCache.get(tileMaskKey);
            const maskBitmap = cachedTileMask || await imageMaskToBitmap(imageInfo, 'rgb(255,255,255)', objCache);
            const imgW = Math.max(1, Math.round(Math.sqrt(op.ctm[0] * op.ctm[0] + op.ctm[1] * op.ctm[1]) * scale));
            const imgH = Math.max(1, Math.round(Math.sqrt(op.ctm[2] * op.ctm[2] + op.ctm[3] * op.ctm[3]) * scale));
            if (imgW <= 4096 && imgH <= 4096) {
              const tmpCanvas = ca.makeCanvas(imgW, imgH);
              const tmpCtx = tmpCanvas.getContext('2d', { willReadFrequently: true });
              tmpCtx.drawImage(maskBitmap, 0, 0, imgW, imgH);
              tmpCtx.globalCompositeOperation = 'source-in';
              const tp = op.tilingPattern;
              const bboxW = tp.bbox[2] - tp.bbox[0];
              const bboxH = tp.bbox[3] - tp.bbox[1];
              const matScaleX = Math.sqrt(tp.matrix[0] * tp.matrix[0] + tp.matrix[1] * tp.matrix[1]) || 1;
              const matScaleY = Math.sqrt(tp.matrix[2] * tp.matrix[2] + tp.matrix[3] * tp.matrix[3]) || 1;
              const { tileW, tileH } = tilingTilePixelDims(bboxW, bboxH, matScaleX, matScaleY, scale);
              const sx = bboxW / tileW * scale;
              const sy = bboxH / tileH * scale;
              const patOriginX = (tp.matrix[0] * tp.bbox[0] + tp.matrix[2] * (tp.bbox[1] + bboxH) + tp.matrix[4] - boxOriginX) * scale;
              const patOriginY = (pageHeightPts + boxOriginY - tp.matrix[1] * tp.bbox[0] - tp.matrix[3] * (tp.bbox[1] + bboxH) - tp.matrix[5]) * scale;
              const imgOriginX = (op.ctm[4] - boxOriginX) * scale;
              const imgOriginY = (pageHeightPts + boxOriginY - op.ctm[5]) * scale;
              canvasPat.setTransform(new DOMMatrix([
                tp.matrix[0] * sx, -tp.matrix[1] * sx, -tp.matrix[2] * sy, tp.matrix[3] * sy,
                patOriginX - imgOriginX, patOriginY - imgOriginY,
              ]));
              tmpCtx.fillStyle = canvasPat;
              tmpCtx.fillRect(0, 0, imgW, imgH);
              rCtx.save();
              if (op.fillAlpha < 1) rCtx.globalAlpha = op.fillAlpha;
              applyClips(rCtx, op);
              rCtx.setTransform(
                op.ctm[0] * scale, -op.ctm[1] * scale, op.ctm[2] * scale, -op.ctm[3] * scale,
                (op.ctm[4] - boxOriginX) * scale, (pageHeightPts + boxOriginY - op.ctm[5]) * scale,
              );
              rCtx.transform(1, 0, 0, -1, 0, 1);
              rCtx.drawImage(tmpCanvas, 0, 0, 1, 1);
              ca.closeDrawable(tmpCanvas);
              rCtx.restore();
            }
            if (!cachedTileMask) ca.closeDrawable(maskBitmap);
            return;
          }
        }

        // For image masks filled with a shading pattern (axial ShadingType 2 or radial type 3), composite the shading through the mask alpha.
        // The mask is drawn at the image transform to set the alpha, then the gradient is painted in pattern->page->device space
        // (the same mapping the path shading-pattern fill uses) under source-in.
        if (imageInfo.imageMask && op.patternShading
          && (op.patternShading.type === 2 || op.patternShading.type === 3)
          && op.patternShading.stops) {
          const sh = op.patternShading;
          const maskBitmap = await imageMaskToBitmap(imageInfo, 'rgb(0,0,0)', objCache);
          if (maskBitmap) {
            const tmpCanvas = ca.makeCanvas(canvasWidth, canvasHeight);
            const tmpCtx = tmpCanvas.getContext('2d', { willReadFrequently: true });
            tmpCtx.setTransform(
              op.ctm[0] * scale, -op.ctm[1] * scale, op.ctm[2] * scale, -op.ctm[3] * scale,
              (op.ctm[4] - boxOriginX) * scale, (pageHeightPts + boxOriginY - op.ctm[5]) * scale,
            );
            tmpCtx.transform(1, 0, 0, -1, 0, 1);
            tmpCtx.drawImage(maskBitmap, 0, 0, 1, 1);
            tmpCtx.setTransform(scale, 0, 0, -scale, -boxOriginX * scale, (pageHeightPts + boxOriginY) * scale);
            if (op.patternBaseCTM) tmpCtx.transform(...op.patternBaseCTM);
            if (sh.matrix) tmpCtx.transform(...sh.matrix);
            tmpCtx.globalCompositeOperation = 'source-in';
            const grad = sh.type === 2
              ? tmpCtx.createLinearGradient(sh.coords[0], sh.coords[1], sh.coords[2], sh.coords[3])
              : tmpCtx.createRadialGradient(sh.coords[0], sh.coords[1], sh.coords[2], sh.coords[3], sh.coords[4], sh.coords[5]);
            for (const stop of sh.stops) grad.addColorStop(stop.offset, stop.color);
            tmpCtx.fillStyle = grad;
            tmpCtx.fillRect(-1e9, -1e9, 2e9, 2e9);
            rCtx.save();
            if (op.fillAlpha < 1) rCtx.globalAlpha = op.fillAlpha;
            applyClips(rCtx, op);
            rCtx.setTransform(1, 0, 0, 1, 0, 0);
            rCtx.drawImage(tmpCanvas, 0, 0);
            rCtx.restore();
            ca.closeDrawable(tmpCanvas);
            ca.closeDrawable(maskBitmap);
            return;
          }
        }

        const maskFillColor = op.fillColor;
        const cachedBitmap = bitmapCache.get(op.name);
        const bitmap = cachedBitmap || (imageInfo.imageMask
          ? await imageMaskToBitmap(imageInfo, maskFillColor, objCache)
          : await imageInfoToBitmap(imageInfo, objCache, canvasWidth, canvasHeight));
        if (!bitmap) return;
        rCtx.save();
        if (op.fillAlpha < 1) rCtx.globalAlpha = op.fillAlpha;
        if (op.overprint && (imageInfo.colorSpace === 'Separation')) {
          rCtx.globalCompositeOperation = 'multiply';
        } else if (op.blendMode && op.blendMode !== 'Normal') {
          rCtx.globalCompositeOperation = pdfBlendToCanvas[op.blendMode] || op.blendMode.toLowerCase();
        }
        applyClips(rCtx, op);

        rCtx.setTransform(
          op.ctm[0] * scale,
          -op.ctm[1] * scale,
          op.ctm[2] * scale,
          -op.ctm[3] * scale,
          (op.ctm[4] - boxOriginX) * scale,
          (pageHeightPts + boxOriginY - op.ctm[5]) * scale,
        );
        rCtx.transform(1, 0, 0, -1, 0, 1);
        rCtx.drawImage(bitmap, 0, 0, 1, 1);
        rCtx.restore();

        if (!cachedBitmap) {
          // Image masks bake the per-draw fill color into the bitmap, so they cannot be shared across draws.
          if (!imageInfo.imageMask && imageDrawCounts.get(op.name) > 1) bitmapCache.set(op.name, bitmap);
          else ca.closeDrawable(bitmap);
        }
      } else if (op.type === 'type3glyph') {
        let pathData = glyphPathCache.get(op.charProcObjNum);
        if (!pathData) {
          const stBytes = objCache.getStreamBytes(op.charProcObjNum);
          if (!stBytes) return;
          pathData = parseGlyphStreamPaths(bytesToLatin1(stBytes));
          glyphPathCache.set(op.charProcObjNum, pathData);
        }

        if (pathData.doXObject && op.type3XObjects) {
        // Type3 glyph paints an XObject image via Do operator
          try {
            const xObjNum = op.type3XObjects[pathData.doXObject.name];
            if (xObjNum !== undefined) {
              const xObjText = objCache.getObjectText(xObjNum);
              if (xObjText && /\/Subtype\s*\/Image/.test(xObjText)) {
                const imageInfo = parseImageObject(xObjText, xObjNum, objCache);
                if (imageInfo) {
                  const bitmap = imageInfo.imageMask
                    ? await imageMaskToBitmap(imageInfo, op.fillColor || 'rgb(0,0,0)', objCache)
                    : await imageInfoToBitmap(imageInfo, objCache, canvasWidth, canvasHeight);
                  rCtx.save();
                  if (op.fillAlpha < 1) rCtx.globalAlpha = op.fillAlpha;
                  applyClips(rCtx, op);
                  rCtx.setTransform(
                    op.transform[0] * scale, -op.transform[1] * scale,
                    op.transform[2] * scale, -op.transform[3] * scale,
                    (op.transform[4] - boxOriginX) * scale,
                    (pageHeightPts + boxOriginY - op.transform[5]) * scale,
                  );
                  rCtx.transform(pathData.doXObject.cm[0], pathData.doXObject.cm[1], pathData.doXObject.cm[2], pathData.doXObject.cm[3], pathData.doXObject.cm[4], pathData.doXObject.cm[5]);
                  rCtx.transform(1, 0, 0, -1, 0, 1);
                  rCtx.drawImage(bitmap, 0, 0, 1, 1);
                  rCtx.restore();
                  ca.closeDrawable(bitmap);
                }
              }
            }
          } catch { /* skip failed Type3 Do XObject */ }
        } else if (pathData.inlineImage) {
        // Type3 glyph uses an inline bitmap image (BI/ID/EI)
          try {
            const syntheticOp = {
              dictText: pathData.inlineImage.dictText,
              imageData: pathData.inlineImage.imageData,
              fillColor: op.fillColor || 'rgb(0,0,0)',
            };
            const bitmap = await decodeInlineImage(syntheticOp);
            if (bitmap) {
              rCtx.save();
              if (op.fillAlpha < 1) rCtx.globalAlpha = op.fillAlpha;
              applyClips(rCtx, op);
              rCtx.setTransform(
                op.transform[0] * scale, -op.transform[1] * scale,
                op.transform[2] * scale, -op.transform[3] * scale,
                (op.transform[4] - boxOriginX) * scale,
                (pageHeightPts + boxOriginY - op.transform[5]) * scale,
              );
              rCtx.transform(pathData.inlineImage.cm[0], pathData.inlineImage.cm[1], pathData.inlineImage.cm[2], pathData.inlineImage.cm[3], pathData.inlineImage.cm[4], pathData.inlineImage.cm[5]);
              rCtx.transform(1, 0, 0, -1, 0, 1);
              rCtx.drawImage(bitmap, 0, 0, 1, 1);
              rCtx.restore();
              ca.closeDrawable(bitmap);
            }
          } catch { /* skip failed Type3 inline image */ }
        } else if (pathData.nestedText) {
        // Type3 CharProc that delegates to another embedded font via
        //   q <cm> cm BT /FontName <size> Tf <tm> Tm (char)Tj ET Q
        // Compose the effective text rendering matrix:
        //   trm = [innerSize,0,0,innerSize,0,0] * innerTm * innerCM * op.transform
        // op.transform already equals `Type3FontMatrix * [outerSize,...] * outerTm * CTM`
        // (i.e., the CTM the CharProc sees on entry), so composing innerCM and the
        // inner text state on top gives the final glyph→device transform. We then
        // draw the char with fillText using the target font's registered CSS name.
          const nt = pathData.nestedText;
          const innerFont = fonts.get(nt.fontName);
          const innerReg = registeredFontNames.get(nt.fontName);
          if (innerFont && innerReg) {
            const sizeMat = [nt.fontSize, 0, 0, nt.fontSize, 0, 0];
            const t1 = matMul(sizeMat, nt.tm);
            const t2 = matMul(t1, nt.cm);
            const trm = matMul(t2, op.transform);

            // Map the single-byte Tj string to what fillText should draw.
            // Use the target font's encoding/toUnicode mapping, matching the
            // logic in advanceLiteral() for standalone Type1 text.
            const charCode = nt.text.charCodeAt(0);
            const unicode = innerFont.toUnicode.get(charCode) || nt.text;
            const drawText = innerFont.encodingUnicode?.get(charCode) || unicode;

            if (drawText && drawText.trim().length > 0) {
              rCtx.save();
              if (op.fillAlpha < 1) rCtx.globalAlpha = op.fillAlpha;
              applyClips(rCtx, op);

              rCtx.font = /[",]/.test(innerReg)
                ? `1px ${innerReg}`
                : `1px "${innerReg}"`;
              rCtx.textBaseline = 'alphabetic';
              rCtx.fillStyle = op.fillColor || 'black';
              rCtx.setTransform(
                trm[0] * scale, -trm[1] * scale,
                -trm[2] * scale, trm[3] * scale,
                (trm[4] - boxOriginX) * scale,
                (pageHeightPts + boxOriginY - trm[5]) * scale,
              );
              rCtx.fillText(drawText, 0, 0);
              rCtx.restore();
            }
          }
        } else if (pathData.commands.length > 0) {
          rCtx.save();
          if (op.fillAlpha < 1) rCtx.globalAlpha = op.fillAlpha;
          applyClips(rCtx, op);

          rCtx.setTransform(
            op.transform[0] * scale,
            -op.transform[1] * scale,
            op.transform[2] * scale,
            -op.transform[3] * scale,
            (op.transform[4] - boxOriginX) * scale,
            (pageHeightPts + boxOriginY - op.transform[5]) * scale,
          );
          rCtx.beginPath();
          for (const cmd of pathData.commands) {
            switch (cmd.type) {
              case 'M': rCtx.moveTo(cmd.x, cmd.y); break;
              case 'L': rCtx.lineTo(cmd.x, cmd.y); break;
              case 'C': rCtx.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y); break;
              case 'Z': rCtx.closePath(); break;
              default: break;
            }
          }
          const mode = pathData.paintMode || 'fill';
          if (mode === 'fill' || mode === 'fillStroke') {
            rCtx.fillStyle = pathData.fillColor || op.fillColor || 'black';
            rCtx.fill(pathData.evenOdd ? 'evenodd' : 'nonzero');
          }
          if (mode === 'stroke' || mode === 'fillStroke') {
            rCtx.strokeStyle = pathData.strokeColor || op.fillColor || 'black';
            // Stroke-based Type3 glyphs (e.g. Korean outline fonts) set a sub-pixel line width in glyph space (a hairline).
            // Skia renders that as nearly nothing, dropping whole glyphs.
            // Clamp to a 1-device-pixel minimum, the thinnest visible line, matching how mupdf paints these strokes.
            const glyphToDevice = Math.sqrt(Math.abs(op.transform[0] * op.transform[3] - op.transform[1] * op.transform[2])) * scale || 1;
            rCtx.lineWidth = Math.max(pathData.lineWidth || 1, 1 / glyphToDevice);
            if (pathData.dashArray && pathData.dashArray.length > 0) {
              rCtx.setLineDash(pathData.dashArray);
              rCtx.lineDashOffset = pathData.dashPhase || 0;
            }
            rCtx.stroke();
          }
          rCtx.restore();
        }
      } else if (op.type === 'type0text') {
        rCtx.save();
        if (op.fillAlpha < 1) rCtx.globalAlpha = op.fillAlpha;
        applyClips(rCtx, op);

        const isEmbedded = /^"?_pdf_/.test(op.fontFamily);
        const weight = (!isEmbedded && op.bold) ? 'bold' : 'normal';
        const style = (!isEmbedded && op.italic) ? 'italic' : 'normal';
        rCtx.font = /[",]/.test(op.fontFamily)
          ? `${style} ${weight} 1px ${op.fontFamily}`
          : `${style} ${weight} 1px "${op.fontFamily}"`;
        rCtx.textBaseline = 'alphabetic';

        // Scale glyph width to match PDF-specified width when using a substitute font.
        // Cap at 2.0× to reject CJK-on-Latin mismatches and TJ-compensated wide Widths.
        let hScale = 1;
        if (op.pdfGlyphWidth !== undefined) {
          const measuredWidth = rCtx.measureText(op.text).width;
          if (measuredWidth > 0) {
            hScale = op.pdfGlyphWidth / (1000 * measuredWidth);
            if (!isEmbedded && hScale > 2.0) hScale = 1;
          }
        }

        // PDF spec §8.7.4.5.3: an axial shading with Extend=[false,false] must
        // not paint past its coordinate endpoints. The clip is applied here in
        // user-space coordinates before the per-glyph transform is set; Canvas
        // stores clips in device coordinates so the clip region survives the
        // subsequent setTransform, and glyph origins past the gradient's end
        // are correctly blanked instead of being painted with the last stop.
        if (op.patternShading && op.patternShading.type === 2
            && op.patternShading.extend
            && (!op.patternShading.extend[0] || !op.patternShading.extend[1])
            && op.patternShading.coords) {
          const shExt = op.patternShading;
          rCtx.setTransform(
            scale, 0, 0, -scale,
            -boxOriginX * scale,
            (pageHeightPts + boxOriginY) * scale,
          );
          if (op.patternBaseCTM) {
            rCtx.transform(op.patternBaseCTM[0], op.patternBaseCTM[1], op.patternBaseCTM[2], op.patternBaseCTM[3], op.patternBaseCTM[4], op.patternBaseCTM[5]);
          }
          if (shExt.matrix) rCtx.transform(...shExt.matrix);
          clipAxialExtend(rCtx, shExt.coords, shExt.extend);
        }

        rCtx.setTransform(
          op.a * scale * hScale,
          -op.b * scale * hScale,
          -op.c * scale,
          op.d * scale,
          (op.x - boxOriginX) * scale,
          (pageHeightPts + boxOriginY - op.y) * scale,
        );

        // Apply pattern fills (tiling or shading) to text, same as for paths.
        if (op.tilingPattern) {
          const tileCvs = tilingPatternCache.get(tileKeyOf(op.tilingPattern));
          const canvasPat = tileCvs ? rCtx.createPattern(tileCvs, 'repeat') : null; if (canvasPat) transientPatterns.push(canvasPat);
          if (canvasPat) {
            const tp = op.tilingPattern;
            const bboxW = tp.bbox[2] - tp.bbox[0];
            const bboxH = tp.bbox[3] - tp.bbox[1];
            const matScaleX = Math.sqrt(tp.matrix[0] * tp.matrix[0] + tp.matrix[1] * tp.matrix[1]);
            const matScaleY = Math.sqrt(tp.matrix[2] * tp.matrix[2] + tp.matrix[3] * tp.matrix[3]);
            const { tileW, tileH } = tilingTilePixelDims(bboxW, bboxH, matScaleX, matScaleY, scale);
            const sx = bboxW / tileW * scale;
            const sy = bboxH / tileH * scale;
            // Device-space pattern matrix: maps pattern source pixels to device pixels.
            const dm = new DOMMatrix([
              tp.matrix[0] * sx, -tp.matrix[1] * sx,
              -tp.matrix[2] * sy, tp.matrix[3] * sy,
              (tp.matrix[0] * tp.bbox[0] + tp.matrix[2] * (tp.bbox[1] + bboxH) + tp.matrix[4] - boxOriginX) * scale,
              (pageHeightPts + boxOriginY - tp.matrix[1] * tp.bbox[0] - tp.matrix[3] * (tp.bbox[1] + bboxH) - tp.matrix[5]) * scale,
            ]);
            // Text rendering can't use the identity-CTM trick because fillText needs the
            // per-glyph transform set above (font-size scaling, glyph origin, hScale).
            // CanvasPattern.setTransform's matrix is composed with the canvas CTM at paint
            // time, so passing dm directly would be multiplied by the per-glyph scale
            // (~625 for 150pt glyphs at 300 DPI), blowing one source pixel up to cover
            // the whole glyph and producing a flat-color fill. Premultiply dm by the
            // current CTM's inverse so the compositions cancel: paint = CTM × (CTM⁻¹ × dm) = dm.
            const ctmNow = rCtx.getTransform();
            const composed = ctmNow.inverse().multiply(dm);
            canvasPat.setTransform(composed);
            rCtx.fillStyle = canvasPat;
          } else {
            rCtx.fillStyle = op.fillColor || 'black';
          }
        } else if (op.patternShading) {
          const sh = op.patternShading;
          // Shading coords are in pattern space. Map to page space via sh.matrix,
          // then to text canvas-local space via the inverse of the text transform.
          const det = op.a * op.d - op.b * op.c;
          if (det !== 0 && sh.coords && sh.stops) {
            const shMat = sh.matrix;
            const bctm = op.patternBaseCTM;
            const toPage = (px, py) => {
              let x = px;
              let y = py;
              if (shMat) {
                x = shMat[0] * px + shMat[2] * py + shMat[4];
                y = shMat[1] * px + shMat[3] * py + shMat[5];
              }
              if (bctm) {
                const ox = bctm[0] * x + bctm[2] * y + bctm[4];
                const oy = bctm[1] * x + bctm[3] * y + bctm[5];
                x = ox;
                y = oy;
              }
              return [x, y];
            };
            const txCoord = (px, py) => {
              const dx = px - op.x;
              const dy = op.y - py;
              return [
                (op.d * dx + op.c * dy) / (det * hScale),
                (op.a * dy + op.b * dx) / det,
              ];
            };
            let grad;
            if (sh.type === 2) {
              const [px0, py0] = toPage(sh.coords[0], sh.coords[1]);
              const [px1, py1] = toPage(sh.coords[2], sh.coords[3]);
              const [x0, y0] = txCoord(px0, py0);
              const [x1, y1] = txCoord(px1, py1);
              grad = rCtx.createLinearGradient(x0, y0, x1, y1);
            } else if (sh.type === 3) {
              const [px0, py0] = toPage(sh.coords[0], sh.coords[1]);
              const [px1, py1] = toPage(sh.coords[3], sh.coords[4]);
              const [x0, y0] = txCoord(px0, py0);
              const [x1, y1] = txCoord(px1, py1);
              const shScale = shMat ? Math.sqrt(Math.abs(shMat[0] * shMat[3] - shMat[1] * shMat[2])) : 1;
              const avgScale = Math.sqrt(Math.abs(det)) * hScale / shScale;
              const r0 = sh.coords[2] / avgScale;
              const r1 = sh.coords[5] / avgScale;
              grad = rCtx.createRadialGradient(x0, y0, r0, x1, y1, r1);
            }
            if (grad) {
              for (const stop of sh.stops) grad.addColorStop(stop.offset, stop.color);
              rCtx.fillStyle = grad;
            } else {
              rCtx.fillStyle = op.fillColor || 'black';
            }
          } else {
            rCtx.fillStyle = op.fillColor || 'black';
          }
        } else {
          rCtx.fillStyle = op.fillColor || 'black';
        }

        const trMode = op.textRenderMode || 0;
        if (trMode === 0 || trMode === 2) {
          rCtx.fillText(op.text, 0, 0);
        }
        if (trMode === 1 || trMode === 2) {
          rCtx.strokeStyle = op.strokeColor || 'black';
          if (op.strokeAlpha < 1) rCtx.globalAlpha = op.strokeAlpha;
          rCtx.lineWidth = op.lineWidth / (Math.sqrt(op.a * op.a + op.b * op.b) || 1);
          rCtx.strokeText(op.text, 0, 0);
        }
        rCtx.restore();
      } else if (op.type === 'path') {
        rCtx.save();
        if (op.blendMode && op.blendMode !== 'Normal') {
          rCtx.globalCompositeOperation = pdfBlendToCanvas[op.blendMode] || op.blendMode.toLowerCase();
        }
        applyClips(rCtx, op);

        rCtx.setTransform(
          op.ctm[0] * scale,
          -op.ctm[1] * scale,
          op.ctm[2] * scale,
          -op.ctm[3] * scale,
          (op.ctm[4] - boxOriginX) * scale,
          (pageHeightPts + boxOriginY - op.ctm[5]) * scale,
        );
        rCtx.beginPath();
        for (const cmd of op.commands) {
          switch (cmd.type) {
            case 'M': rCtx.moveTo(cmd.x, cmd.y); break;
            case 'L': rCtx.lineTo(cmd.x, cmd.y); break;
            case 'C': rCtx.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y); break;
            case 'Z': rCtx.closePath(); break;
            default: break;
          }
        }
        if (op.fill) {
          rCtx.globalAlpha = op.fillAlpha;
          if (op.patternShading) {
            const sh = op.patternShading;
            const bctm = op.patternBaseCTM;
            if (sh.type === 'mesh') {
              rCtx.save();
              rCtx.clip(op.evenOdd ? 'evenodd' : 'nonzero');
              rCtx.setTransform(scale, 0, 0, -scale, -boxOriginX * scale, (pageHeightPts + boxOriginY) * scale);
              if (bctm) rCtx.transform(bctm[0], bctm[1], bctm[2], bctm[3], bctm[4], bctm[5]);
              if (sh.matrix) rCtx.transform(...sh.matrix);
              renderMeshPatches(rCtx, sh.patches);
              rCtx.restore();
            } else if (sh.type === 'gouraud') {
              rCtx.save();
              rCtx.clip(op.evenOdd ? 'evenodd' : 'nonzero');
              rCtx.setTransform(scale, 0, 0, -scale, -boxOriginX * scale, (pageHeightPts + boxOriginY) * scale);
              if (bctm) rCtx.transform(bctm[0], bctm[1], bctm[2], bctm[3], bctm[4], bctm[5]);
              if (sh.matrix) rCtx.transform(...sh.matrix);
              renderGouraudTriangles(rCtx, sh.triangles, gouraudClipBounds);
              rCtx.restore();
            } else {
              rCtx.save();
              rCtx.clip(op.evenOdd ? 'evenodd' : 'nonzero');
              rCtx.setTransform(scale, 0, 0, -scale, -boxOriginX * scale, (pageHeightPts + boxOriginY) * scale);
              if (bctm) rCtx.transform(bctm[0], bctm[1], bctm[2], bctm[3], bctm[4], bctm[5]);
              if (sh.matrix) rCtx.transform(...sh.matrix);
              if (sh.bbox) {
                rCtx.beginPath();
                rCtx.rect(sh.bbox[0], sh.bbox[1], sh.bbox[2] - sh.bbox[0], sh.bbox[3] - sh.bbox[1]);
                rCtx.clip();
              }
              if (sh.extend && (!sh.extend[0] || !sh.extend[1]) && sh.type === 2) {
                clipAxialExtend(rCtx, sh.coords, sh.extend);
              }
              let grad;
              if (sh.type === 2) {
                grad = rCtx.createLinearGradient(sh.coords[0], sh.coords[1], sh.coords[2], sh.coords[3]);
              } else if (sh.type === 3) {
                grad = rCtx.createRadialGradient(sh.coords[0], sh.coords[1], sh.coords[2], sh.coords[3], sh.coords[4], sh.coords[5]);
              }
              if (grad) {
                for (const stop of sh.stops) grad.addColorStop(stop.offset, stop.color);
                rCtx.fillStyle = grad;
                rCtx.fillRect(-1e9, -1e9, 2e9, 2e9);
              } else {
                rCtx.fillStyle = op.fillColor;
                rCtx.fillRect(-1e9, -1e9, 2e9, 2e9);
              }
              rCtx.restore();
            }
          } else {
            rCtx.fillStyle = op.fillColor;
            rCtx.fill(op.evenOdd ? 'evenodd' : 'nonzero');
          }
        }
        if (op.stroke) {
          rCtx.globalAlpha = op.strokeAlpha;
          let strokeStyleVal = op.strokeColor;
          if (op.strokePatternShading) {
            const sh = op.strokePatternShading;
            if ((sh.type === 2 || sh.type === 3) && sh.coords && sh.stops) {
              const m = sh.matrix || [1, 0, 0, 1, 0, 0];
              const bm = op.patternBaseCTM;
              const userX = (px, py) => {
                const ux = m[0] * px + m[2] * py + m[4];
                const uy = m[1] * px + m[3] * py + m[5];
                if (bm) {
                  return [bm[0] * ux + bm[2] * uy + bm[4], bm[1] * ux + bm[3] * uy + bm[5]];
                }
                return [ux, uy];
              };
              const opM = op.ctm;
              const det = opM[0] * opM[3] - opM[1] * opM[2];
              const invOp = det !== 0 ? [
                opM[3] / det, -opM[1] / det, -opM[2] / det, opM[0] / det,
                (opM[2] * opM[5] - opM[3] * opM[4]) / det,
                (opM[1] * opM[4] - opM[0] * opM[5]) / det,
              ] : [1, 0, 0, 1, 0, 0];
              const localCoord = (ux, uy) => [
                invOp[0] * ux + invOp[2] * uy + invOp[4],
                invOp[1] * ux + invOp[3] * uy + invOp[5],
              ];
              let grad;
              if (sh.type === 2) {
                const [u0x, u0y] = userX(sh.coords[0], sh.coords[1]);
                const [u1x, u1y] = userX(sh.coords[2], sh.coords[3]);
                const [lx0, ly0] = localCoord(u0x, u0y);
                const [lx1, ly1] = localCoord(u1x, u1y);
                grad = rCtx.createLinearGradient(lx0, ly0, lx1, ly1);
              } else {
                const [u0x, u0y] = userX(sh.coords[0], sh.coords[1]);
                const [u1x, u1y] = userX(sh.coords[3], sh.coords[4]);
                const [lx0, ly0] = localCoord(u0x, u0y);
                const [lx1, ly1] = localCoord(u1x, u1y);
                const avgScale = Math.sqrt(Math.abs(det)) * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
                grad = rCtx.createRadialGradient(lx0, ly0, sh.coords[2] / avgScale, lx1, ly1, sh.coords[5] / avgScale);
              }
              for (const stop of sh.stops) grad.addColorStop(stop.offset, stop.color);
              strokeStyleVal = grad;
            }
          } else if (op.strokeTilingPattern) {
            const tileCvs = tilingPatternCache.get(tileKeyOf(op.strokeTilingPattern));
            if (tileCvs) {
              const tp = op.strokeTilingPattern;
              const bboxW = tp.bbox[2] - tp.bbox[0];
              const bboxH = tp.bbox[3] - tp.bbox[1];
              const matScaleX = Math.sqrt(tp.matrix[0] * tp.matrix[0] + tp.matrix[1] * tp.matrix[1]) || 1;
              const matScaleY = Math.sqrt(tp.matrix[2] * tp.matrix[2] + tp.matrix[3] * tp.matrix[3]) || 1;
              const { tileW, tileH } = tilingTilePixelDims(bboxW, bboxH, matScaleX, matScaleY, scale);
              const sx = bboxW / tileW * scale;
              const sy = bboxH / tileH * scale;
              const canvasPat = rCtx.createPattern(tileCvs, 'repeat');
              transientPatterns.push(canvasPat);
              const dm = new DOMMatrix([
                tp.matrix[0] * sx, -tp.matrix[1] * sx,
                -tp.matrix[2] * sy, tp.matrix[3] * sy,
                (tp.matrix[0] * tp.bbox[0] + tp.matrix[2] * (tp.bbox[1] + bboxH) + tp.matrix[4] - boxOriginX) * scale,
                (pageHeightPts + boxOriginY - tp.matrix[1] * tp.bbox[0] - tp.matrix[3] * (tp.bbox[1] + bboxH) - tp.matrix[5]) * scale,
              ]);
              const ctmNow = rCtx.getTransform();
              canvasPat.setTransform(ctmNow.inverse().multiply(dm));
              strokeStyleVal = canvasPat;
            }
          }
          rCtx.strokeStyle = strokeStyleVal;
          // PDF spec: lineWidth 0 = thinnest line (1 device pixel).
          // Canvas ignores lineWidth=0, so compute a hairline width instead.
          if (op.lineWidth > 0) {
            rCtx.lineWidth = op.lineWidth;
          } else {
            const sx = Math.sqrt(op.ctm[0] * op.ctm[0] + op.ctm[1] * op.ctm[1]) * scale;
            const sy = Math.sqrt(op.ctm[2] * op.ctm[2] + op.ctm[3] * op.ctm[3]) * scale;
            rCtx.lineWidth = 1 / (Math.max(sx, sy) || 1);
          }
          rCtx.lineCap = /** @type {CanvasLineCap} */ (['butt', 'round', 'square'][op.lineCap] || 'butt');
          rCtx.lineJoin = /** @type {CanvasLineJoin} */ (['miter', 'round', 'bevel'][op.lineJoin] || 'miter');
          rCtx.miterLimit = op.miterLimit;
          if (op.dashArray.length > 0) {
            rCtx.setLineDash(op.dashArray);
            rCtx.lineDashOffset = op.dashPhase;
          }
          rCtx.stroke();
        }
        rCtx.restore();
      } else if (op.type === 'shading') {
        const sh = op.shading;
        if (!sh) return;
        rCtx.save();
        if (op.fillAlpha < 1) rCtx.globalAlpha = op.fillAlpha;
        // Apply blend mode from graphics state (e.g. Multiply from ExtGState).
        if (op.blendMode && op.blendMode !== 'Normal') {
          rCtx.globalCompositeOperation = pdfBlendToCanvas[op.blendMode] || op.blendMode.toLowerCase();
        }
        applyClips(rCtx, op);

        rCtx.setTransform(
          op.ctm[0] * scale,
          -op.ctm[1] * scale,
          op.ctm[2] * scale,
          -op.ctm[3] * scale,
          (op.ctm[4] - boxOriginX) * scale,
          (pageHeightPts + boxOriginY - op.ctm[5]) * scale,
        );

        if (sh.type === 2) {
          if (sh.bbox) {
            rCtx.beginPath();
            rCtx.rect(sh.bbox[0], sh.bbox[1], sh.bbox[2] - sh.bbox[0], sh.bbox[3] - sh.bbox[1]);
            rCtx.clip();
          }
          if (sh.extend && (!sh.extend[0] || !sh.extend[1])) {
            clipAxialExtend(rCtx, sh.coords, sh.extend);
          }
          const grad = rCtx.createLinearGradient(sh.coords[0], sh.coords[1], sh.coords[2], sh.coords[3]);
          for (const stop of sh.stops) grad.addColorStop(stop.offset, stop.color);
          rCtx.fillStyle = grad;
          rCtx.fillRect(-1e9, -1e9, 2e9, 2e9);
        } else if (sh.type === 3) {
          if (sh.bbox) {
            rCtx.beginPath();
            rCtx.rect(sh.bbox[0], sh.bbox[1], sh.bbox[2] - sh.bbox[0], sh.bbox[3] - sh.bbox[1]);
            rCtx.clip();
          }
          fillRadialExtendBehind(rCtx, sh);
          const grad = rCtx.createRadialGradient(
            sh.coords[0], sh.coords[1], sh.coords[2],
            sh.coords[3], sh.coords[4], sh.coords[5],
          );
          for (const stop of sh.stops) grad.addColorStop(stop.offset, stop.color);
          rCtx.fillStyle = grad;
          rCtx.fillRect(-1e9, -1e9, 2e9, 2e9);
        } else if (sh.type === 'mesh') {
          renderMeshPatches(rCtx, sh.patches);
        } else if (sh.type === 'gouraud') {
          renderGouraudTriangles(rCtx, sh.triangles, null, [canvasWidth, canvasHeight]);
        }
        rCtx.restore();
      } else if (op.type === 'inlineImage') {
      // Decode and render an inline image (BI/ID/EI)
        try {
        // Skip degenerate transforms (zero-size images from pattern sub-streams).
          if (Math.abs(op.ctm[0] * op.ctm[3] - op.ctm[1] * op.ctm[2]) < 1e-9) {
          // degenerate CTM — skip
          } else if (op.tilingPattern) {
          // Image mask with tiling pattern fill: render mask as white bitmap,
          // composite cached tiling pattern through it via source-in, then draw result.
            const tileCvs = tilingPatternCache.get(tileKeyOf(op.tilingPattern));
            const canvasPat = tileCvs ? rCtx.createPattern(tileCvs, 'repeat') : null; if (canvasPat) transientPatterns.push(canvasPat);
            const maskOp = { ...op, fillColor: 'rgb(255,255,255)' };
            const maskBitmap = canvasPat ? await decodeInlineImage(maskOp) : null;
            if (maskBitmap && canvasPat) {
              const imgW = Math.max(1, Math.round(Math.sqrt(op.ctm[0] * op.ctm[0] + op.ctm[1] * op.ctm[1]) * scale));
              const imgH = Math.max(1, Math.round(Math.sqrt(op.ctm[2] * op.ctm[2] + op.ctm[3] * op.ctm[3]) * scale));
              if (imgW <= 4096 && imgH <= 4096) {
                const tmpCanvas = ca.makeCanvas(imgW, imgH);
                const tmpCtx = tmpCanvas.getContext('2d', { willReadFrequently: true });
                tmpCtx.drawImage(maskBitmap, 0, 0, imgW, imgH);
                tmpCtx.globalCompositeOperation = 'source-in';
                const tp = op.tilingPattern;
                const bboxW = tp.bbox[2] - tp.bbox[0];
                const bboxH = tp.bbox[3] - tp.bbox[1];
                const matScaleX = Math.sqrt(tp.matrix[0] * tp.matrix[0] + tp.matrix[1] * tp.matrix[1]) || 1;
                const matScaleY = Math.sqrt(tp.matrix[2] * tp.matrix[2] + tp.matrix[3] * tp.matrix[3]) || 1;
                const { tileW, tileH } = tilingTilePixelDims(bboxW, bboxH, matScaleX, matScaleY, scale);
                const sx = bboxW / tileW * scale;
                const sy = bboxH / tileH * scale;
                const patOriginX = (tp.matrix[0] * tp.bbox[0] + tp.matrix[2] * (tp.bbox[1] + bboxH) + tp.matrix[4] - boxOriginX) * scale;
                const patOriginY = (pageHeightPts + boxOriginY - tp.matrix[1] * tp.bbox[0] - tp.matrix[3] * (tp.bbox[1] + bboxH) - tp.matrix[5]) * scale;
                const imgOriginX = (op.ctm[4] - boxOriginX) * scale;
                const imgOriginY = (pageHeightPts + boxOriginY - op.ctm[5]) * scale;
                canvasPat.setTransform(new DOMMatrix([
                  tp.matrix[0] * sx, -tp.matrix[1] * sx, -tp.matrix[2] * sy, tp.matrix[3] * sy,
                  patOriginX - imgOriginX, patOriginY - imgOriginY,
                ]));
                tmpCtx.fillStyle = canvasPat;
                tmpCtx.fillRect(0, 0, imgW, imgH);
                rCtx.save();
                if (op.fillAlpha < 1) rCtx.globalAlpha = op.fillAlpha;
                applyClips(rCtx, op);
                rCtx.setTransform(
                  op.ctm[0] * scale, -op.ctm[1] * scale,
                  op.ctm[2] * scale, -op.ctm[3] * scale,
                  (op.ctm[4] - boxOriginX) * scale,
                  (pageHeightPts + boxOriginY - op.ctm[5]) * scale,
                );
                rCtx.transform(1, 0, 0, -1, 0, 1);
                rCtx.drawImage(tmpCanvas, 0, 0, 1, 1);
                ca.closeDrawable(tmpCanvas);
                rCtx.restore();
              }
              ca.closeDrawable(maskBitmap);
            }
          } else {
            const bitmap = await decodeInlineImage(op);
            if (bitmap) {
              rCtx.save();
              if (op.fillAlpha < 1) rCtx.globalAlpha = op.fillAlpha;
              // Disable interpolation for small 1-bit images (QR codes, barcodes) to preserve sharp edges
              if (bitmap.width <= 256 && bitmap.height <= 256) {
                rCtx.imageSmoothingEnabled = false;
              }
              applyClips(rCtx, op);
              rCtx.setTransform(
                op.ctm[0] * scale, -op.ctm[1] * scale,
                op.ctm[2] * scale, -op.ctm[3] * scale,
                (op.ctm[4] - boxOriginX) * scale,
                (pageHeightPts + boxOriginY - op.ctm[5]) * scale,
              );
              rCtx.transform(1, 0, 0, -1, 0, 1);
              rCtx.drawImage(bitmap, 0, 0, 1, 1);
              rCtx.restore();
              ca.closeDrawable(bitmap);
            }
          }
        } catch { /* skip failed inline images */ }
      }
    }

    // Gouraud ShadingType 4 pattern fills are rendered per-op in renderPathOpSync,
    // interleaved with wireframe strokes in paint order. Each fill calls
    // renderGouraudTriangles with the composedBase × patternMatrix transform.
    // Pre-compute the clip bounds once for use by all gouraud ops.
    let gouraudClipBounds = null;
    {
      for (const op of drawOps) {
        if (op.type !== 'path' || !op.patternShading || op.patternShading.type !== 'gouraud') continue;
        const clipEntry = op.clips?.[op.clips.length - 1];
        if (clipEntry?.path && clipEntry.ctm) {
          const ct = clipEntry.ctm;
          let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
          for (const cmd of clipEntry.path) {
            if (cmd.x == null) continue;
            const px = (ct[0] * cmd.x + ct[2] * cmd.y + ct[4] - boxOriginX) * scale;
            const py = (pageHeightPts + boxOriginY - ct[1] * cmd.x - ct[3] * cmd.y - ct[5]) * scale;
            if (px < x0) x0 = px; if (px > x1) x1 = px;
            if (py < y0) y0 = py; if (py > y1) y1 = py;
          }
          gouraudClipBounds = [
            Math.max(0, Math.floor(x0)), Math.max(0, Math.floor(y0)),
            Math.min(canvasWidth, Math.ceil(x1)), Math.min(canvasHeight, Math.ceil(y1)),
          ];
        }
        break;
      }
    }

    // Group consecutive draw ops by their SMask state for masked rendering.
    // Ops with the same SMask are rendered together to a temp canvas, masked, then composited.
    // When ops have an outerSmask (form-level mask that wraps ops with their own inner smask),
    // group by outerSmask so the form's combined output gets the outer mask applied once.
    const opGroups = [];
    {
      let prevKey = '';
      for (const op of drawOps) {
        const outerSmask = op.outerSmask || null;
        const smask = op.smask || null;
        const groupId = op.groupId || null;
        // Break consecutive ops by transparency-groupId first, then by outer/inner SMask key.
        // Each transparency group renders to a private canvas and composites back with
        // its own blendMode/alpha/SMask captured at flatten time.
        // SMask-only groupings remain for forms that have an SMask without a /Group dictionary.
        const groupKey = groupId !== null ? `g:${groupId}` : '';
        const smaskKey = outerSmask ? `outer:${outerSmask.formObjNum}` : (smask ? String(smask.formObjNum) : '');
        const key = `${groupKey}|${smaskKey}`;
        if (key !== prevKey || opGroups.length === 0) {
          opGroups.push({
            smask: outerSmask || smask,
            outerSmask,
            groupId,
            ops: [op],
          });
          prevKey = key;
        } else {
          opGroups[opGroups.length - 1].ops.push(op);
        }
      }
    }

    /**
     * Render a list of ops to a canvas context, handling inner SMask grouping.
     * Ops with different inner smask values are rendered to temp canvases, masked, then composited.
     * @param {OffscreenCanvasRenderingContext2D} targetCtx
     * @param {Array<DrawOp>} ops
     */
    async function renderOpsWithInnerSmask(targetCtx, ops) {
    // Sub-group by inner smask
      const subGroups = [];
      let prevKey = '';
      for (const op of ops) {
        const smask = op.smask || null;
        const key = smask ? String(smask.formObjNum) : '';
        if (key !== prevKey || subGroups.length === 0) {
          subGroups.push({ smask, ops: [op] });
          prevKey = key;
        } else {
          subGroups[subGroups.length - 1].ops.push(op);
        }
      }

      for (const sub of subGroups) {
        let subCtx = targetCtx;
        let subCanvas = null;
        if (sub.smask) {
          subCanvas = ca.makeCanvas(canvasWidth, canvasHeight);
          subCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (subCanvas.getContext('2d', { willReadFrequently: true }));
        }

        for (const op of sub.ops) {
          const textClipCharsForOp = getTextClip(op);
          const savedCtx = subCtx;
          let textClipCanvas = null;
          if (textClipCharsForOp) {
            textClipCanvas = ca.makeCanvas(canvasWidth, canvasHeight);
            subCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (textClipCanvas.getContext('2d', { willReadFrequently: true }));
          }

          if (!renderPathOpSync(subCtx, op)) await renderSingleOp(subCtx, op);

          if (textClipCanvas && textClipCharsForOp) {
            const mCanvas = ca.makeCanvas(canvasWidth, canvasHeight);
            drawTextClipMask(mCanvas, textClipCharsForOp);
            subCtx.globalCompositeOperation = 'destination-in';
            subCtx.drawImage(mCanvas, 0, 0);
            ca.closeDrawable(mCanvas);
            subCtx.globalCompositeOperation = 'source-over';
            subCtx = savedCtx;
            subCtx.drawImage(textClipCanvas, 0, 0);
            ca.closeDrawable(textClipCanvas);
          } else if (textClipCharsForOp) {
            subCtx = savedCtx;
          }
        }

        if (sub.smask && subCanvas) {
          const cacheKey = `${sub.smask.formObjNum}:${sub.smask.parentCtm ? sub.smask.parentCtm.join(',') : ''}`;
          let maskCanvas = smaskCanvasCache.get(cacheKey);
          if (!maskCanvas) {
            maskCanvas = await renderSMaskToCanvas(sub.smask, objCache, canvasWidth, canvasHeight, pageHeightPts, boxOriginX, boxOriginY, scale);
            if (maskCanvas) smaskCanvasCache.set(cacheKey, maskCanvas);
          }
          if (maskCanvas) {
            subCtx.globalCompositeOperation = 'destination-in';
            subCtx.drawImage(maskCanvas, 0, 0);
            // Cached in smaskCanvasCache, disposed once at end of page.
            // Disposing here leaves a freed 1x1 canvas that SIGSEGVs the next composite.
            subCtx.globalCompositeOperation = 'source-over';
          }
          // Preserve the blend mode from the sub-group's ops so the masked content
          // blends correctly against the target canvas. Without this, Screen-blended
          // white rects are composited with source-over, covering the image with white
          // instead of brightening it through the gradient mask.
          const subBlend = sub.ops[0]?.blendMode;
          if (subBlend && subBlend !== 'Normal') {
            targetCtx.globalCompositeOperation = pdfBlendToCanvas[subBlend] || subBlend.toLowerCase();
          }
          targetCtx.drawImage(subCanvas, 0, 0);
          ca.closeDrawable(subCanvas);
          if (subBlend && subBlend !== 'Normal') {
            targetCtx.globalCompositeOperation = 'source-over';
          }
        }
      }
    }

    // Stack of active group canvases. Bottom is the page's main canvas; each
    // entry above is a transparency group's private buffer. When the next
    // opGroup belongs to a different group chain, we pop and composite up to
    // the common ancestor, then push fresh canvases down to the target depth.
    // `offX`/`offY` are the device-pixel origin of a tight group buffer and
    // `w`/`h` its size (full-page values for non-tight buffers).
    /** @type {Array<{ctx: OffscreenCanvasRenderingContext2D, canvas: any, groupId: number|null, offX: number, offY: number, w: number, h: number}>} */
    const ctxStack = [{
      ctx, canvas: null, groupId: null, offX: 0, offY: 0, w: canvasWidth, h: canvasHeight,
    }];

    // The Node.js canvas package defers drawImage(canvas) compositing and retains each
    // source surface until the destination is read back.
    // Read back one pixel from every live stack canvas periodically so retained sources are released.
    let compositeFlushCounter = 0;
    const flushComposites = () => {
      if ((++compositeFlushCounter % 12) !== 0) return;
      for (let i = 0; i < ctxStack.length; i++) ctxStack[i].ctx.getImageData(0, 0, 1, 1);
    };

    const popAndComposite = async () => {
      const top = ctxStack.pop();
      if (!top || top.groupId == null) return;
      const parent = ctxStack[ctxStack.length - 1];
      const attrs = groupContext.registry.get(top.groupId);
      if (!attrs) {
        ca.closeDrawable(top.canvas);
        return;
      }
      if (attrs.smask) {
        const isTight = top.w < canvasWidth || top.h < canvasHeight;
        let maskCanvas;
        if (isTight) {
          maskCanvas = await renderSMaskToCanvas(attrs.smask, objCache, canvasWidth, canvasHeight, pageHeightPts, boxOriginX, boxOriginY, scale, {
            x: top.offX, y: top.offY, width: top.w, height: top.h,
          });
        } else {
          const cacheKey = `${attrs.smask.formObjNum}:${attrs.smask.parentCtm ? attrs.smask.parentCtm.join(',') : ''}`;
          maskCanvas = smaskCanvasCache.get(cacheKey);
          if (!maskCanvas) {
            maskCanvas = await renderSMaskToCanvas(attrs.smask, objCache, canvasWidth, canvasHeight, pageHeightPts, boxOriginX, boxOriginY, scale);
            if (maskCanvas) smaskCanvasCache.set(cacheKey, maskCanvas);
          }
        }
        if (maskCanvas) {
          top.ctx.globalCompositeOperation = 'destination-in';
          top.ctx.drawImage(maskCanvas, 0, 0);
          top.ctx.globalCompositeOperation = 'source-over';
          // Full-page masks live in smaskCanvasCache and are disposed at end of page.
          // Disposing a cached canvas here SIGSEGVs the next composite that reads it.
          // Tight masks are unique per offset and uncached, so dispose now.
          if (isTight) ca.closeDrawable(maskCanvas);
        }
      }
      parent.ctx.save();
      if (attrs.fillAlpha != null && attrs.fillAlpha < 1) parent.ctx.globalAlpha = attrs.fillAlpha;
      if (attrs.blendMode && attrs.blendMode !== 'Normal') {
        parent.ctx.globalCompositeOperation = pdfBlendToCanvas[attrs.blendMode] || attrs.blendMode.toLowerCase();
      }
      parent.ctx.drawImage(top.canvas, top.offX - parent.offX, top.offY - parent.offY);
      parent.ctx.restore();
      ca.closeDrawable(top.canvas);
      flushComposites();
    };

    /** @param {number|null} groupId @returns {number[]} root-to-leaf chain of registered ancestors */
    const getGroupChain = (groupId) => {
      const chain = [];
      let g = groupId;
      while (g != null) {
        chain.unshift(g);
        const a = groupContext.registry.get(g);
        g = a ? a.parentGroupId : null;
      }
      return chain;
    };

    /**
     * Render a soft-masked op group into a buffer sized to a device-pixel bbox and
     * composite it into the current stack buffer at that offset.
     * Each op is shifted into the bbox's local space, the smask is built at the same bbox,
     * and `destination-in` applies it. Returns false if the mask could not be built.
     * @param {Array<any>} ops
     * @param {any} smask
     * @param {number} bx
     * @param {number} by
     * @param {number} bw
     * @param {number} bh
     * @returns {Promise<boolean>}
     */
    async function compositeTightSmaskGroup(ops, smask, bx, by, bw, bh) {
      const mask = await renderSMaskToCanvas(
        smask, objCache, canvasWidth, canvasHeight,
        pageHeightPts, boxOriginX, boxOriginY, scale,
        {
          x: bx, y: by, width: bw, height: bh,
        },
      );
      if (!mask) return false;
      const tightCanvas = ca.makeCanvas(bw, bh);
      const tightCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (tightCanvas.getContext('2d', { willReadFrequently: true }));
      const dx = -bx / scale;
      const dy = by / scale;
      for (const op of ops) {
        const shiftedOp = shiftOpBy(op, dx, dy);
        if (!renderPathOpSync(tightCtx, shiftedOp)) await renderSingleOp(tightCtx, shiftedOp);
      }
      tightCtx.globalCompositeOperation = 'destination-in';
      tightCtx.drawImage(mask, 0, 0);
      ca.closeDrawable(mask);
      tightCtx.globalCompositeOperation = 'source-over';
      const entry = ctxStack[ctxStack.length - 1];
      const blend = ops.length > 0 && ops[0].blendMode;
      if (blend && blend !== 'Normal') entry.ctx.globalCompositeOperation = pdfBlendToCanvas[blend] || blend.toLowerCase();
      entry.ctx.drawImage(tightCanvas, bx - entry.offX, by - entry.offY);
      ca.closeDrawable(tightCanvas);
      if (blend && blend !== 'Normal') entry.ctx.globalCompositeOperation = 'source-over';
      return true;
    }

    // Size each isolatable group's buffer to its content bbox.
    // Soft-mask groups qualify too: the result is content*mask,
    // which is zero where the content is transparent,
    // so clamping the buffer (and its mask) to the content bbox is lossless.
    /** @type {Map<number, {x:number,y:number,w:number,h:number}>} */
    const groupTightBBox = new Map();
    {
      const acc = new Map();
      for (const og of opGroups) {
        if (og.groupId == null) continue;
        const chain = getGroupChain(og.groupId);
        for (const dop of og.ops) {
          const bb = opDeviceBBox(dop);
          // Pattern/shading fills are positioned by a page- or device-space matrix
          // that shiftOpBy does not move, so they cannot render into a shifted tight
          // buffer. Keep groups that contain them full-page.
          const dpAny = /** @type {any} */ (dop);
          const untightable = !!(dop.outerSmask || dop.patternShading || dop.tilingPattern
            || dpAny.strokePatternShading || dpAny.strokeTilingPattern);
          for (const g of chain) {
            let e = acc.get(g);
            if (!e) {
              e = {
                minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity, ok: true,
              };
              acc.set(g, e);
            }
            if (!bb || untightable) { e.ok = false; continue; }
            if (bb.minX < e.minX) e.minX = bb.minX;
            if (bb.minY < e.minY) e.minY = bb.minY;
            if (bb.maxX > e.maxX) e.maxX = bb.maxX;
            if (bb.maxY > e.maxY) e.maxY = bb.maxY;
          }
        }
      }
      for (const [g, e] of acc) {
        const attrs = groupContext.registry.get(g);
        if (!e.ok || !attrs || !Number.isFinite(e.minX)) continue;
        const x = Math.max(0, Math.floor(e.minX) - 2);
        const y = Math.max(0, Math.floor(e.minY) - 2);
        const right = Math.min(canvasWidth, Math.ceil(e.maxX) + 2);
        const bottom = Math.min(canvasHeight, Math.ceil(e.maxY) + 2);
        // Content entirely outside the page clamps to a degenerate rect.
        // A 1x1 buffer composited at its off-page origin contributes nothing
        // and needs no full-page allocation.
        const w = Math.max(1, right - x);
        const h = Math.max(1, bottom - y);
        if (w * h < canvasWidth * canvasHeight) {
          groupTightBBox.set(g, {
            x, y, w, h,
          });
        }
      }
    }

    for (let groupIdx = 0; groupIdx < opGroups.length; groupIdx++) {
      const group = opGroups[groupIdx];
      const targetChain = group.groupId != null ? getGroupChain(group.groupId) : [];

      let common = 0;
      while (common < ctxStack.length - 1 && common < targetChain.length
        && ctxStack[common + 1].groupId === targetChain[common]) {
        common++;
      }
      while (ctxStack.length - 1 > common) {
        await popAndComposite();
      }
      for (let i = common; i < targetChain.length; i++) {
        const tb = groupTightBBox.get(targetChain[i]);
        const newCanvas = tb ? ca.makeCanvas(tb.w, tb.h) : ca.makeCanvas(canvasWidth, canvasHeight);
        const newCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (newCanvas.getContext('2d', { willReadFrequently: true }));
        ctxStack.push({
          ctx: newCtx, canvas: newCanvas, groupId: targetChain[i], offX: tb ? tb.x : 0, offY: tb ? tb.y : 0, w: tb ? tb.w : canvasWidth, h: tb ? tb.h : canvasHeight,
        });
      }

      const currentEntry = ctxStack[ctxStack.length - 1];
      const currentCtx = currentEntry.ctx;
      // Device-pixel origin of the current buffer. When it is a tight group buffer,
      // smask groups composited below must land at coordinates relative to it.
      const curOffX = currentEntry.offX;
      const curOffY = currentEntry.offY;

      if (group.outerSmask) {
      // Two-level masking: render all ops (with inner SMask handling) to a group canvas,
      // then apply the outer (form-level) SMask to the combined result.
        const groupCanvas = ca.makeCanvas(canvasWidth, canvasHeight);
        const groupCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (groupCanvas.getContext('2d', { willReadFrequently: true }));

        await renderOpsWithInnerSmask(groupCtx, group.ops);

        // Apply the outer (form-level) SMask to the combined group result
        const cacheKey = `${group.outerSmask.formObjNum}:${group.outerSmask.parentCtm ? group.outerSmask.parentCtm.join(',') : ''}`;
        let maskCanvas = smaskCanvasCache.get(cacheKey);
        if (!maskCanvas) {
          maskCanvas = await renderSMaskToCanvas(group.outerSmask, objCache, canvasWidth, canvasHeight, pageHeightPts, boxOriginX, boxOriginY, scale);
          if (maskCanvas) smaskCanvasCache.set(cacheKey, maskCanvas);
        }
        if (maskCanvas) {
          groupCtx.globalCompositeOperation = 'destination-in';
          groupCtx.drawImage(maskCanvas, 0, 0);
          // Cached in smaskCanvasCache, disposed once at end of page.
          // Disposing here leaves a freed 1x1 canvas that SIGSEGVs the next composite.
          groupCtx.globalCompositeOperation = 'source-over';
        }
        currentCtx.drawImage(groupCanvas, -curOffX, -curOffY);
        ca.closeDrawable(groupCanvas);
      } else if (group.smask) {
      // Fast path: when a smask group contains a single image op whose destination
      // rectangle is small compared to the page, avoid allocating a full-page OffscreenCanvas.
      // Instead render to a bbox-sized tight canvas and build the
      // smask at the same tight size. Critical for pages where many per-image
      // soft masks each allocated a full-page canvas.
        const fastOp = (group.ops.length === 1
        && group.ops[0].type === 'image'
        && /** @type {any} */ (group.ops[0]).ctm
        && !getTextClip(group.ops[0]))
          ? /** @type {any} */ (group.ops[0])
          : null;

        if (fastOp) {
        // Compute destination bbox in canvas pixels by transforming the unit square
        // through fastOp.ctm, then into canvas coords with Y flip.
          const corners = [
            [fastOp.ctm[4], fastOp.ctm[5]],
            [fastOp.ctm[0] + fastOp.ctm[4], fastOp.ctm[1] + fastOp.ctm[5]],
            [fastOp.ctm[2] + fastOp.ctm[4], fastOp.ctm[3] + fastOp.ctm[5]],
            [fastOp.ctm[0] + fastOp.ctm[2] + fastOp.ctm[4], fastOp.ctm[1] + fastOp.ctm[3] + fastOp.ctm[5]],
          ];
          let minPxX = Infinity;
          let minPxY = Infinity;
          let maxPxX = -Infinity;
          let maxPxY = -Infinity;
          for (let ci = 0; ci < 4; ci++) {
            const px = (corners[ci][0] - boxOriginX) * scale;
            const py = (pageHeightPts + boxOriginY - corners[ci][1]) * scale;
            if (px < minPxX) minPxX = px;
            if (px > maxPxX) maxPxX = px;
            if (py < minPxY) minPxY = py;
            if (py > maxPxY) maxPxY = py;
          }
          // Pad by 1 pixel so anti-aliasing at bbox edges isn't clipped.
          const bboxX = Math.max(0, Math.floor(minPxX) - 1);
          const bboxY = Math.max(0, Math.floor(minPxY) - 1);
          const bboxRight = Math.min(canvasWidth, Math.ceil(maxPxX) + 1);
          const bboxBottom = Math.min(canvasHeight, Math.ceil(maxPxY) + 1);
          const bboxW = bboxRight - bboxX;
          const bboxH = bboxBottom - bboxY;

          if (bboxW > 0 && bboxH > 0 && bboxW * bboxH < canvasWidth * canvasHeight / 4) {
          // Render the smask at bbox size instead of full-page. Each smask on this
          // class of page is typically unique per image op, so there's no benefit to
          // caching a full-page version in smaskCanvasCache — build it tight and
          // throw it away.
            const fastBbox = {
              x: bboxX,
              y: bboxY,
              width: bboxW,
              height: bboxH,
            };
            const fastMaskCanvas = await renderSMaskToCanvas(
              group.smask, objCache, canvasWidth, canvasHeight,
              pageHeightPts, boxOriginX, boxOriginY, scale,
              fastBbox,
            );
            if (fastMaskCanvas) {
              const tightCanvas = ca.makeCanvas(bboxW, bboxH);
              const tightCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (tightCanvas.getContext('2d', { willReadFrequently: true }));
              // Shift op.ctm translation so the image renders at (0,0) of tightCanvas
              // instead of its absolute canvas-pixel position.
              const shiftedOp = {
                ...fastOp,
                ctm: [fastOp.ctm[0], fastOp.ctm[1], fastOp.ctm[2], fastOp.ctm[3], fastOp.ctm[4] - bboxX / scale, fastOp.ctm[5] + bboxY / scale],
                clips: fastOp.clips ? fastOp.clips.map((/** @type {any} */ c) => ({
                  ...c,
                  ctm: c.ctm
                    ? [c.ctm[0], c.ctm[1], c.ctm[2], c.ctm[3], c.ctm[4] - bboxX / scale, c.ctm[5] + bboxY / scale]
                    : c.ctm,
                })) : fastOp.clips,
              };
              await renderSingleOp(tightCtx, shiftedOp);
              // Apply smask (already bbox-sized) directly onto the tight canvas.
              tightCtx.globalCompositeOperation = 'destination-in';
              tightCtx.drawImage(fastMaskCanvas, 0, 0);
              ca.closeDrawable(fastMaskCanvas);
              tightCtx.globalCompositeOperation = 'source-over';
              const fastBlend = fastOp.blendMode;
              if (fastBlend && fastBlend !== 'Normal') {
                currentCtx.globalCompositeOperation = pdfBlendToCanvas[fastBlend] || fastBlend.toLowerCase();
              }
              currentCtx.drawImage(tightCanvas, bboxX - curOffX, bboxY - curOffY);
              ca.closeDrawable(tightCanvas);
              if (fastBlend && fastBlend !== 'Normal') {
                currentCtx.globalCompositeOperation = 'source-over';
              }
              continue;
            }
          }
        }

        // Form-XObject bbox fast path: when every op in this smask group came
        // from the same top-level /Fmn Do and the form's /BBox projects to a
        // small fraction of the page in canvas pixels, render into a tight
        // canvas sized to that bbox instead of a full-page canvas. Each op's
        // translation components and clip CTMs are shifted by (-bboxX,+bboxY)
        // in PDF user-space so the output lands at (0,0) of the tight canvas.
        // Key case: glossy magazine covers where 20+ shaded-ring Form XObjects
        // each wrap a luminosity mask, and each bbox covers ~1% of the page.
        let formBBoxFastHandled = false;
        if (!group.ops.some((o) => getTextClip(o))) {
          const firstFormClip = (() => {
            const clips = group.ops[0].clips;
            if (!clips) return null;
            for (let i = clips.length - 1; i >= 0; i--) {
              if (clips[i].fromFormObjNum !== undefined) return clips[i];
            }
            return null;
          })();
          let allShare = !!firstFormClip;
          if (firstFormClip) {
            for (let gi = 1; gi < group.ops.length && allShare; gi++) {
              const clipsI = group.ops[gi].clips;
              let foundI = null;
              if (clipsI) {
                for (let ci = clipsI.length - 1; ci >= 0; ci--) {
                  if (clipsI[ci].fromFormObjNum !== undefined) { foundI = clipsI[ci]; break; }
                }
              }
              if (!foundI || foundI.fromFormObjNum !== firstFormClip.fromFormObjNum) { allShare = false; break; }
              for (let mi = 0; mi < 6; mi++) {
                if (foundI.ctm[mi] !== firstFormClip.ctm[mi]) { allShare = false; break; }
              }
            }
          }
          if (allShare && firstFormClip && firstFormClip.path) {
            const pts = firstFormClip.path;
            // The path is M,L,L,L,Z with 4 corners in form-local space.
            let minPxX = Infinity;
            let minPxY = Infinity;
            let maxPxX = -Infinity;
            let maxPxY = -Infinity;
            for (let pi = 0; pi < pts.length; pi++) {
              const pt = pts[pi];
              if (pt.type !== 'M' && pt.type !== 'L') continue;
              const ux = firstFormClip.ctm[0] * pt.x + firstFormClip.ctm[2] * pt.y + firstFormClip.ctm[4];
              const uy = firstFormClip.ctm[1] * pt.x + firstFormClip.ctm[3] * pt.y + firstFormClip.ctm[5];
              const px = (ux - boxOriginX) * scale;
              const py = (pageHeightPts + boxOriginY - uy) * scale;
              if (px < minPxX) minPxX = px;
              if (px > maxPxX) maxPxX = px;
              if (py < minPxY) minPxY = py;
              if (py > maxPxY) maxPxY = py;
            }
            const fbBboxX = Math.max(0, Math.floor(minPxX) - 1);
            const fbBboxY = Math.max(0, Math.floor(minPxY) - 1);
            const fbBboxRight = Math.min(canvasWidth, Math.ceil(maxPxX) + 1);
            const fbBboxBottom = Math.min(canvasHeight, Math.ceil(maxPxY) + 1);
            const fbBboxW = fbBboxRight - fbBboxX;
            const fbBboxH = fbBboxBottom - fbBboxY;

            if (fbBboxW > 0 && fbBboxH > 0 && fbBboxW * fbBboxH < canvasWidth * canvasHeight / 4) {
              formBBoxFastHandled = await compositeTightSmaskGroup(group.ops, group.smask, fbBboxX, fbBboxY, fbBboxW, fbBboxH);
            }
          }
        }
        if (formBBoxFastHandled) continue;

        // General tight path: when the fast paths above did not match but every op is
        // bounded and shiftable (no pattern/stroke-pattern fill, inner mask, or text clip),
        // size the buffer to the union of op device bboxes.
        // Catches masked content like a single clipped shading that is neither
        // a single image nor a shared-form-clip group.
        let generalTightHandled = false;
        if (!group.ops.some((o) => getTextClip(o))) {
          let uMinX = Infinity;
          let uMinY = Infinity;
          let uMaxX = -Infinity;
          let uMaxY = -Infinity;
          let tightable = true;
          for (const op of group.ops) {
            const oa = /** @type {any} */ (op);
            if (op.outerSmask || oa.patternShading || oa.tilingPattern || oa.strokePatternShading || oa.strokeTilingPattern) { tightable = false; break; }
            const obb = opDeviceBBox(op);
            if (!obb) { tightable = false; break; }
            if (obb.minX < uMinX) uMinX = obb.minX;
            if (obb.minY < uMinY) uMinY = obb.minY;
            if (obb.maxX > uMaxX) uMaxX = obb.maxX;
            if (obb.maxY > uMaxY) uMaxY = obb.maxY;
          }
          if (tightable && Number.isFinite(uMinX)) {
            const ux = Math.max(0, Math.floor(uMinX) - 1);
            const uy = Math.max(0, Math.floor(uMinY) - 1);
            const uw = Math.min(canvasWidth, Math.ceil(uMaxX) + 1) - ux;
            const uh = Math.min(canvasHeight, Math.ceil(uMaxY) + 1) - uy;
            if (uw > 0 && uh > 0 && uw * uh < canvasWidth * canvasHeight) {
              generalTightHandled = await compositeTightSmaskGroup(group.ops, group.smask, ux, uy, uw, uh);
            }
          }
        }
        if (generalTightHandled) continue;

        // Single-level masking (existing behavior): render ops to group canvas, apply mask
        const groupCanvas = ca.makeCanvas(canvasWidth, canvasHeight);
        const renderCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (groupCanvas.getContext('2d', { willReadFrequently: true }));

        for (const op of group.ops) {
          const textClipCharsForOp = getTextClip(op);
          let opCtx = renderCtx;
          let textClipCanvas = null;
          if (textClipCharsForOp) {
            textClipCanvas = ca.makeCanvas(canvasWidth, canvasHeight);
            opCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (textClipCanvas.getContext('2d', { willReadFrequently: true }));
          }

          if (!renderPathOpSync(opCtx, op)) await renderSingleOp(opCtx, op);

          if (textClipCanvas && textClipCharsForOp) {
            const mCanvas = ca.makeCanvas(canvasWidth, canvasHeight);
            drawTextClipMask(mCanvas, textClipCharsForOp);
            opCtx.globalCompositeOperation = 'destination-in';
            opCtx.drawImage(mCanvas, 0, 0);
            ca.closeDrawable(mCanvas);
            opCtx.globalCompositeOperation = 'source-over';
            renderCtx.drawImage(textClipCanvas, 0, 0);
            ca.closeDrawable(textClipCanvas);
          }
        }

        const cacheKey = `${group.smask.formObjNum}:${group.smask.parentCtm ? group.smask.parentCtm.join(',') : ''}`;
        let maskCanvas = smaskCanvasCache.get(cacheKey);
        if (!maskCanvas) {
          maskCanvas = await renderSMaskToCanvas(group.smask, objCache, canvasWidth, canvasHeight, pageHeightPts, boxOriginX, boxOriginY, scale);
          if (maskCanvas) smaskCanvasCache.set(cacheKey, maskCanvas);
        }
        if (maskCanvas) {
          renderCtx.globalCompositeOperation = 'destination-in';
          renderCtx.drawImage(maskCanvas, 0, 0);
          renderCtx.globalCompositeOperation = 'source-over';
        }
        const groupBlend = group.ops.length > 0 && group.ops[0].blendMode;
        if (groupBlend && groupBlend !== 'Normal') {
          currentCtx.globalCompositeOperation = pdfBlendToCanvas[groupBlend] || groupBlend.toLowerCase();
        }
        currentCtx.drawImage(groupCanvas, -curOffX, -curOffY);
        ca.closeDrawable(groupCanvas);
        if (groupBlend && groupBlend !== 'Normal') {
          currentCtx.globalCompositeOperation = 'source-over';
        }
      } else {
        // When the target is a tight group buffer, shift each op into the buffer's
        // local space (it is composited back at its offset in popAndComposite).
        const tgtEntry = ctxStack[ctxStack.length - 1];
        const grpShift = tgtEntry.offX !== 0 || tgtEntry.offY !== 0;
        const grpDx = -tgtEntry.offX / scale;
        const grpDy = tgtEntry.offY / scale;
        for (let opIdx = 0; opIdx < group.ops.length; opIdx++) {
          const op = grpShift ? shiftOpBy(group.ops[opIdx], grpDx, grpDy) : group.ops[opIdx];

          // Gouraud ops render normally through renderPathOpSync (no skip).

          const textClipCharsForOp = getTextClip(op);

          // Text clips usually cover a tiny label-sized region.
          // Render the op and its glyph mask into a canvas sized to the glyph bbox.
          if (textClipCharsForOp) {
            const tb = textClipDeviceBBox(textClipCharsForOp);
            if (tb && tb.w > 0 && tb.h > 0 && tb.w * tb.h < canvasWidth * canvasHeight / 4) {
              const dxPdf = -tb.x / scale;
              const dyPdf = tb.y / scale;
              const tightCanvas = ca.makeCanvas(tb.w, tb.h);
              const tightCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (tightCanvas.getContext('2d', { willReadFrequently: true }));
              const shiftedOp = shiftOpBy(op, dxPdf, dyPdf);
              if (!renderPathOpSync(tightCtx, shiftedOp)) await renderSingleOp(tightCtx, shiftedOp);
              const shiftedChars = textClipCharsForOp.map((/** @type {any} */ ch) => ({ ...ch, x: ch.x + dxPdf, y: ch.y + dyPdf }));
              const mCanvas = ca.makeCanvas(tb.w, tb.h);
              drawTextClipMask(mCanvas, shiftedChars);
              tightCtx.globalCompositeOperation = 'destination-in';
              tightCtx.drawImage(mCanvas, 0, 0);
              ca.closeDrawable(mCanvas);
              tightCtx.globalCompositeOperation = 'source-over';
              currentCtx.drawImage(tightCanvas, tb.x, tb.y);
              ca.closeDrawable(tightCanvas);
              flushComposites();
              continue;
            }
          }

          let opCtx = currentCtx;
          let textClipCanvas = null;
          if (textClipCharsForOp) {
            textClipCanvas = ca.makeCanvas(canvasWidth, canvasHeight);
            opCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (textClipCanvas.getContext('2d', { willReadFrequently: true }));
          }

          if (!renderPathOpSync(opCtx, op)) await renderSingleOp(opCtx, op);

          if (textClipCanvas && textClipCharsForOp) {
            const mCanvas = ca.makeCanvas(canvasWidth, canvasHeight);
            drawTextClipMask(mCanvas, textClipCharsForOp);
            opCtx.globalCompositeOperation = 'destination-in';
            opCtx.drawImage(mCanvas, 0, 0);
            ca.closeDrawable(mCanvas);
            opCtx.globalCompositeOperation = 'source-over';
            currentCtx.drawImage(textClipCanvas, 0, 0);
            ca.closeDrawable(textClipCanvas);
            flushComposites();
          }
        }
      }
      flushComposites();
    }
    while (ctxStack.length > 1) {
      await popAndComposite();
    }
  } catch (err) {
    // Return a blank page instead so the process never crashes and the page is still present.
    // The result carries `ok: false` and `failReason` so callers can flag a failure
    // placeholder explicitly rather than inferring it from a blank-vs-baseline diff.
    renderFailed = true;
    failDetail = err instanceof Error ? err.message : String(err);
    failReason = /** @type {any} */ (err)?.renderAbort || 'exception';
    console.warn(`[renderPdfPage] page ${pageIndex} returned blank: ${failDetail}`);
  } finally {
    // Dispose every cached Skia surface regardless of whether rendering threw.
    for (const bmp of bitmapCache.values()) ca.closeDrawable(bmp);
    for (const bmp of tilingPatternCache.values()) ca.closeDrawable(bmp);
    for (const cvs of smaskCanvasCache.values()) ca.closeDrawable(cvs);
    for (const p of transientPatterns) ca.closeDrawable(p);
    if (textMeasureCanvas) ca.closeDrawable(textMeasureCanvas);
    bitmapCache.clear();
    tilingPatternCache.clear();
    smaskCanvasCache.clear();
    transientPatterns.length = 0;
  }

  if (renderFailed) {
    ca.closeDrawable(canvas);
    const blankCanvas = ca.makeCanvas(canvasWidth, canvasHeight);
    const blankCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (blankCanvas.getContext('2d', { willReadFrequently: true }));
    blankCtx.fillStyle = 'white';
    blankCtx.fillRect(0, 0, canvasWidth, canvasHeight);
    const blankData = blankCtx.getImageData(0, 0, canvasWidth, canvasHeight);
    const blankResult = {
      dataUrl: await buildPngDataUrl(blankData, 'gray'), colorMode: 'gray', ok: false, failReason, failDetail,
    };
    ca.closeDrawable(blankCanvas);
    return blankResult;
  }

  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  ctx.globalCompositeOperation = 'source-over';

  // JPEG output (thumbnails): encode the canvas directly to a JPEG Blob, skipping getImageData and the PNG build.
  // Pass both `type` (the W3C OffscreenCanvas option browsers read) and `mime` (the option the Node @scribe.js/canvas fork reads).
  // Given only `type`, the fork ignores the format and falls back to PNG.
  if (outputFormat === 'jpeg') {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', mime: 'image/jpeg', quality });
    ca.closeDrawable(canvas);
    return { blob, colorMode: effectiveColorMode, ok: true };
  }

  // Encode via `buildPngDataUrl` (not `canvas.toBuffer('image/png')`):
  // smaller output (RGB-only, 1-channel gray) and avoids SkPngEncoder's
  // buffer retention.
  const imageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
  const result = {
    dataUrl: await buildPngDataUrl(imageData, effectiveColorMode), colorMode: effectiveColorMode, ok: true,
  };
  ca.closeDrawable(canvas);
  return result;
}

/** CRC-32 lookup table for PNG chunk checksums (browser path only). */
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}

// Node's native CRC-32 is ~11× faster than the JS table-lookup version on
// large inputs (measured: 3.5 ms vs 39 ms for 25 MB on Node 20). On the
// fast PNG path the IDAT chunk is ~25 MB per page, so this single swap is
// the difference between the fast path being net-faster and net-slower
// than the compressed path. Falls back to the JS implementation in
// browsers (no native CRC32 API).
const zlibCrc32 = (typeof process !== 'undefined' && typeof process.versions?.node === 'string')
  ? (await import('node:zlib')).crc32
  : null;

/**
 * Compute CRC-32 of a byte array, matching the PNG spec (ISO 3309 / ITU-T V.42).
 * @param {Uint8Array} bytes
 */
function crc32(bytes) {
  if (zlibCrc32) return zlibCrc32(bytes);
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Build a PNG chunk: 4-byte length + 4-byte type + data + 4-byte CRC.
 * @param {string} type - 4-character chunk type (e.g. 'IHDR', 'IDAT', 'IEND')
 * @param {Uint8Array} data - Chunk payload
 */
function makePngChunk(type, data) {
  const chunk = new Uint8Array(4 + 4 + data.length + 4);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

// Hoist Node zlib.deflateSync at module load so the hot path stays
// microtask-free. In browsers this resolves to null and we use
// CompressionStream (compressed) or writeStoredZlib (fast) instead.
const zlibDeflateSync = (typeof process !== 'undefined' && typeof process.versions?.node === 'string')
  ? (await import('node:zlib')).deflateSync
  : null;

/**
 * Apply PNG Up filter (type 2) to RGBA pixel data while stripping alpha.
 * Output: one filter-type byte (2) per row followed by width*channels pixel
 * bytes. Row 0 has no predecessor so its bytes are the raw stripped pixels.
 *
 * Hand-tuned for V8: running source/destination pointers, the y=0 case
 * split out, and an unrolled 2-pixel inner loop in the color branch. About
 * 35% faster than the per-pixel-index form on typical page-sized inputs.
 *
 * @param {Uint8ClampedArray|Uint8Array} data - RGBA pixel bytes, length w*h*4
 * @param {number} width
 * @param {number} height
 * @param {boolean} isGray - produce single-channel output from R component
 */
function filterUpStripAlpha(data, width, height, isGray) {
  const channels = isGray ? 1 : 3;
  const raw = new Uint8Array(height * (1 + width * channels));
  let d = 0;
  let s = 0;

  // Row 0: no predecessor — raw stripped pixels.
  raw[d++] = 2;
  const row0End = width * 4;
  if (isGray) {
    while (s < row0End) { raw[d++] = data[s]; s += 4; }
  } else {
    while (s < row0End) {
      raw[d++] = data[s];
      raw[d++] = data[s + 1];
      raw[d++] = data[s + 2];
      s += 4;
    }
  }

  // Rows 1..height-1: subtract the same-channel byte from the previous row.
  const rowStride = width * 4;
  for (let y = 1; y < height; y++) {
    raw[d++] = 2;
    let a = s - rowStride;
    const rowEnd = s + rowStride;
    if (isGray) {
      while (s < rowEnd) {
        raw[d++] = (data[s] - data[a]) & 0xFF;
        s += 4; a += 4;
      }
    } else {
      const evenEnd = s + (width & ~1) * 4;
      while (s < evenEnd) {
        raw[d++] = (data[s] - data[a]) & 0xFF;
        raw[d++] = (data[s + 1] - data[a + 1]) & 0xFF;
        raw[d++] = (data[s + 2] - data[a + 2]) & 0xFF;
        raw[d++] = (data[s + 4] - data[a + 4]) & 0xFF;
        raw[d++] = (data[s + 5] - data[a + 5]) & 0xFF;
        raw[d++] = (data[s + 6] - data[a + 6]) & 0xFF;
        s += 8; a += 8;
      }
      while (s < rowEnd) {
        raw[d++] = (data[s] - data[a]) & 0xFF;
        raw[d++] = (data[s + 1] - data[a + 1]) & 0xFF;
        raw[d++] = (data[s + 2] - data[a + 2]) & 0xFF;
        s += 4; a += 4;
      }
    }
  }
  return raw;
}

// Level 4 compression is significantly faster than the default level 6,
// in exchange for a small increase in size (~60% runtime reduction, 6% larger).
const PNG_DEFLATE_LEVEL = 4;

/**
 * Deflate for the compressed PNG path.
 * Node: zlib.deflateSync (sync, level `PNG_DEFLATE_LEVEL`), ~10% faster than piping
 * through CompressionStream because we avoid microtask overhead.
 * Browser: CompressionStream('deflate') (async). It exposes no level control,
 * so the browser path is unaffected by `PNG_DEFLATE_LEVEL`.
 *
 * We deliberately did NOT extract pako deflate for the browser sync path.
 * A sync pako.deflate at default level runs ~4× slower than CompressionStream
 * on typical page-sized inputs. This is different from inflate.
 *
 * @param {Uint8Array} raw
 * @returns {Promise<Uint8Array>|Uint8Array}
 */
function deflateCompressed(raw) {
  if (zlibDeflateSync) return zlibDeflateSync(raw, { level: PNG_DEFLATE_LEVEL });
  return deflateViaCompressionStream(raw);
}

/** Async CompressionStream 'deflate' → concatenated Uint8Array. */
async function deflateViaCompressionStream(raw) {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(raw);
  writer.close();
  const chunks = [];
  const reader = cs.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const compressedLen = chunks.reduce((sum, c) => sum + c.length, 0);
  const compressedData = new Uint8Array(compressedLen);
  let p = 0;
  for (const chunk of chunks) {
    compressedData.set(chunk, p);
    p += chunk.length;
  }
  return compressedData;
}

/**
 * Assemble a PNG byte stream (signature + IHDR + IDAT + IEND) from an
 * already-deflated IDAT payload and convert it to a base64 data URL.
 * Shared between the compressed and fast encoder paths.
 *
 * Base64: Node uses Buffer.from(...).toString('base64') which is ~400×
 * faster than the String.fromCharCode + btoa loop. Browsers keep the loop
 * since Buffer isn't available.
 *
 * @param {number} width
 * @param {number} height
 * @param {boolean} isGray
 * @param {Uint8Array} compressedData
 */
function assemblePngDataUrl(width, height, isGray, compressedData) {
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = isGray ? 0 : 2;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrChunk = makePngChunk('IHDR', ihdr);
  const idatChunk = makePngChunk('IDAT', compressedData);
  const iendChunk = makePngChunk('IEND', new Uint8Array(0));

  const totalLen = signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length;
  const pngBytes = new Uint8Array(totalLen);
  let pos = 0;
  pngBytes.set(signature, pos); pos += signature.length;
  pngBytes.set(ihdrChunk, pos); pos += ihdrChunk.length;
  pngBytes.set(idatChunk, pos); pos += idatChunk.length;
  pngBytes.set(iendChunk, pos);

  if (typeof Buffer !== 'undefined') {
    return `data:image/png;base64,${Buffer.from(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength).toString('base64')}`;
  }
  let binary = '';
  for (let i = 0; i < pngBytes.length; i++) {
    binary += String.fromCharCode(pngBytes[i]);
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

/**
 * Build a compressed PNG data URL from RGBA canvas ImageData.
 *
 * @param {ImageData} imageData - RGBA pixel data from canvas getImageData()
 * @param {'gray'|'color'} colorMode - 'gray' → colorType 0, else colorType 2
 * @returns {Promise<string>} PNG as data:image/png;base64,... URL
 */
async function buildPngDataUrl(imageData, colorMode) {
  const { width, height, data } = imageData;
  const isGray = colorMode === 'gray';
  const raw = filterUpStripAlpha(data, width, height, isGray);
  const compressed = await deflateCompressed(raw);
  return assemblePngDataUrl(width, height, isGray, compressed);
}

export { buildFontFromCFF as _buildFontFromCFF };
export { type1ShadingToAxial as _type1ShadingToAxial };
export { parseShadings as _parseShadings };
export { cssGenericForFontObj as _cssGenericForFontObj };
