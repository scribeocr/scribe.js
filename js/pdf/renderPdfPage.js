import { parsePageImages, parseImageObject, parseIndexedColorSpace } from './parsePdfImages.js';
import {
  parseSeparationTint, parseTintColorSpace,
  tintComponentsToRGB, cmykToRgb,
} from './pdfColorFunctions.js';
import {
  getPageContentStreams, getPageObjects, tokenizeContentStream, bytesToLatin1,
} from './parsePdfDoc.js';
import { extractPdfAnnotations } from './parsePdfAnnots.js';
import {
  findXrefOffset, parseXref, ObjectCache, extractDict,
  resolveIntValue, resolveNumValue, resolveArrayValue, applyPredictor,
} from './parsePdfUtils.js';
import { inflate as pakoInflate, inflatePartial as pakoInflatePartial } from '../../lib/pako-inflate.js';
import { parsePageFonts, parseGlyphStreamPaths } from './fonts/parsePdfFonts.js';
import { standardFontToCSS } from './fonts/standardFontMetrics.js';
import { loadFontFace } from '../containers/fontContainer.js';
import { decodeCMYKJpegToRGB, decodeLabJpegToRGB } from './codecs/decodeJPEG.js';
import {
  rebuildFontFromGlyphs, buildFontFromCFF, convertType1ToOTFNew, isCombiningOrIndicMark, cidCodepoint,
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
 * Classify a parsed PDF font into a CSS generic family keyword
 * ('sans-serif'|'serif'|'monospace'|'cursive'), used as a fallback chain item
 * after the embedded `_pdf_*` family so that glyphs missing from the embedded
 * font render in the correct style instead of Chrome's default serif.
 *
 * @param {{ baseName?: string, familyName?: string, serifFlag?: boolean }} fontObj
 * @returns {'sans-serif'|'serif'|'monospace'|'cursive'}
 */
function cssGenericForFontObj(fontObj) {
  const css = standardFontToCSS(fontObj.baseName || '');
  if (css) {
    if (/monospace/i.test(css)) return 'monospace';
    if (/cursive/i.test(css)) return 'cursive';
    if (/sans-serif/i.test(css)) return 'sans-serif';
    if (/serif/i.test(css)) return 'serif';
  }
  // Strip subset prefix "ABCDEF+" before name-based checks.
  const name = (fontObj.baseName || fontObj.familyName || '').replace(/^[A-Z]{6}\+/, '');
  if (/mono|courier|consola|typewriter|fixedsys|andale|inconsolata|menlo|lucidacons|sourcecode|firacode/i.test(name)) return 'monospace';
  if (/script|cursive|brush|chancery|handwrit|calligraph/i.test(name)) return 'cursive';
  if (/(^|[^a-z])sans([^a-z]|$)|gothic/i.test(name)) return 'sans-serif';
  if (/(^|[^a-z])serif([^a-z]|$)/i.test(name)) return 'serif';
  if (fontObj.serifFlag) return 'serif';
  return 'sans-serif';
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
    if (/,\s*(sans-serif|serif|monospace|cursive)\s*$/i.test(name)) continue;
    const fontObj = fonts.get(fontTag);
    if (!fontObj) continue;
    registeredFontNames.set(fontTag, `"${name}", ${cssGenericForFontObj(fontObj)}`);
  }
}

/**
 * Register a non-embedded font using bundled Nimbus substitution fonts.
 *
 * @param {{ baseName: string, bold?: boolean, italic?: boolean, serifFlag?: boolean }} fontObj
 * @param {string} _familyName - CSS font-family name to register
 * @param {Map<string, string>} targetMap - Map to set familyName into (e.g., registeredFontNames)
 * @param {string} fontTag - Font tag key for targetMap
 */
async function registerNonEmbeddedFont(fontObj, _familyName, targetMap, fontTag) {
  // Substitute fonts are the same bytes on every call — use a shared
  // `_scribe_*` family name (process-global) rather than the caller's
  // per-document alias so the registration dedups to one per process.
  // Dingbats: load bundled Dingbats font
  if (/ZapfDingbats/i.test(fontObj.baseName)) {
    const subName = '_scribe_dingbats';
    try {
      const url = new URL('../../fonts/Dingbats.woff', import.meta.url);
      let dingbatsBytes;
      if (ca.isNode) {
        const { fileURLToPath } = await import('node:url');
        const { readFileSync } = await import('node:fs');
        dingbatsBytes = readFileSync(fileURLToPath(url));
      } else {
        dingbatsBytes = await fetch(url).then((r) => r.arrayBuffer());
      }
      const face = loadFontFace(subName, 'normal', 'normal', dingbatsBytes);
      await face.loaded;
      targetMap.set(fontTag, subName);
    } catch (_e) {
      targetMap.set(fontTag, 'sans-serif');
    }
    return;
  }
  const cssFamily = standardFontToCSS(fontObj.baseName);
  // Monospace/cursive/unrecognized fonts have no bundled substitute — use CSS fallback.
  const isMonospace = cssFamily && /monospace/i.test(cssFamily);
  const isCursive = cssFamily && /cursive/i.test(cssFamily);
  if (isMonospace || isCursive || !cssFamily) {
    const fallback = isMonospace ? 'monospace' : isCursive ? 'cursive' : cssGenericForFontObj(fontObj);
    targetMap.set(fontTag, cssFamily || fallback);
    if (!cssFamily) console.warn(`[renderPdfPage] No font data for "${fontObj.baseName}", using ${fallback} fallback`);
    return;
  }
  const isSansSerif = /sans-serif|sans/i.test(cssFamily);
  const variant = fontObj.bold && fontObj.italic ? 'BoldItalic'
    : fontObj.bold ? 'Bold' : fontObj.italic ? 'Italic' : 'Regular';
  const family = isSansSerif ? 'NimbusSans' : 'NimbusRoman';
  // One alias per substitute file; same bytes on every call.
  const subName = `_scribe_${family.toLowerCase()}_${variant.toLowerCase()}`;
  try {
    const url = new URL(`../../fonts/all/${family}-${variant}.woff`, import.meta.url);
    let fontBytes;
    if (ca.isNode) {
      const { fileURLToPath } = await import('node:url');
      const { readFileSync } = await import('node:fs');
      fontBytes = readFileSync(fileURLToPath(url));
    } else {
      fontBytes = await fetch(url).then((r) => r.arrayBuffer());
    }
    const face = loadFontFace(subName, 'normal', 'normal', fontBytes);
    await face.loaded;
    targetMap.set(fontTag, subName);
  } catch (_e) {
    // Bundled font load failed — fall back to CSS font matching
    const fallback = cssGenericForFontObj(fontObj);
    targetMap.set(fontTag, cssFamily || fallback);
    console.warn(`[renderPdfPage] No font data for "${fontObj.baseName}", using ${cssFamily || fallback} fallback`);
  }
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
 * Multiply two 3x3 affine matrices represented as 6-element arrays [a,b,c,d,e,f].
 * Matrix layout: | a b 0 |   Concatenation: result = m1 * m2
 *                | c d 0 |
 *                | e f 1 |
 * @param {number[]} m1
 * @param {number[]} m2
 */
function matMul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

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
    const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));
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
  // Check for JPEG 2000 (JP2 signature: 0x0000000C 6A502020)
  if (rawData.length >= 8 && rawData[0] === 0x00 && rawData[1] === 0x00
    && rawData[2] === 0x00 && rawData[3] === 0x0C
    && rawData[4] === 0x6A && rawData[5] === 0x50) {
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
 * Convert decoded image bytes to an ImageBitmap suitable for canvas drawing.
 *
 * @param {import('./parsePdfImages.js').ImageInfo} imageInfo
 * @param {ObjectCache} [objCache]
 */
async function imageInfoToBitmap(imageInfo, objCache) {
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
        const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));
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

    // Lab JPEG: decode raw component data and convert Lab→sRGB.
    if (colorSpace === 'Lab') {
      const jpegBytes = imageData instanceof Uint8Array ? imageData : new Uint8Array(imageData);
      const wp = imageInfo.labWhitePoint || [0.9505, 1.0, 1.089]; // default D65
      const labResult = decodeLabJpegToRGB(jpegBytes, wp);
      if (labResult) {
        const { width: w, height: h, rgbData } = labResult;
        const canvas = ca.makeCanvas(w, h);
        const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));
        const imgData = new ImageData(new Uint8ClampedArray(rgbData.buffer, rgbData.byteOffset, rgbData.byteLength), w, h);
        ctx.putImageData(imgData, 0, 0);
        return ca.createImageBitmapFromCanvas(canvas);
      }
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
      const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));
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

    // /Decode [1 0 ...] inversion for JPEG: invert decoded pixel values via compositing
    if (decodeInvert) {
      const w = jpegBitmap.width;
      const h = jpegBitmap.height;
      const canvas = ca.makeCanvas(w, h);
      const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));
      ctx.drawImage(jpegBitmap, 0, 0);
      ca.closeDrawable(jpegBitmap);
      ctx.globalCompositeOperation = 'difference';
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, w, h);
      const invertedBitmap = await ca.createImageBitmapFromCanvas(canvas);

      // Apply soft mask if present
      if (sMask && sMaskWidth && sMaskHeight) {
        const canvas2 = ca.makeCanvas(w, h);
        const ctx2 = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas2.getContext('2d'));
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
        const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));
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
        // Mask is higher resolution — upsample image to mask dimensions
        const outW = sMaskWidth;
        const outH = sMaskHeight;
        const canvas = ca.makeCanvas(w, h);
        const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));
        ctx.drawImage(jpegBitmap, 0, 0);
        ca.closeDrawable(jpegBitmap);
        const imgData = ctx.getImageData(0, 0, w, h);
        const px = imgData.data;
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
            upsampled[dstIdx + 3] = sMask[y * outW + x];
          }
        }
        return ca.createImageBitmapFromImageData(new ImageData(upsampled, outW, outH));
      }
      // Mask is lower resolution — resample mask to image dimensions
      const canvas = ca.makeCanvas(w, h);
      const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));
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
    const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));
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
    const decoded = decodeJPX(imageData);
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
    if (components === 1 && colorSpace === 'Indexed' && imageInfo.palette) {
      // Indexed color space: each pixel value is an index into the PDF palette.
      const palette = imageInfo.palette;
      const base = imageInfo.paletteBase || 'DeviceRGB';
      const nComp = base === 'DeviceCMYK' ? 4 : (base === 'DeviceGray' || base === 'CalGray' ? 1 : 3);
      for (let i = 0; i < w * h; i++) {
        const idx = pixels[i];
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
          const tint = pixels[i];
          const [r, g, b] = interpolateTint(tintSamples, nSamples, tint);
          rgbaData[i * 4] = r;
          rgbaData[i * 4 + 1] = g;
          rgbaData[i * 4 + 2] = b;
          rgbaData[i * 4 + 3] = 255;
        }
      } else {
        for (let i = 0; i < w * h; i++) {
          const val = 255 - pixels[i];
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
          const c = pixels[i * 4] / 255;
          const m = pixels[i * 4 + 1] / 255;
          const y = pixels[i * 4 + 2] / 255;
          const k = pixels[i * 4 + 3] / 255;
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
        // Mask is higher resolution than image — upsample image to mask dimensions
        // to preserve fine mask detail (e.g., text stencil edges).
        const outW = sMaskWidth;
        const outH = sMaskHeight;
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
            upsampled[dstIdx + 3] = sMask[y * outW + x];
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

  if (colorSpace === 'Indexed' && imageInfo.palette) {
    const palette = imageInfo.palette;
    const base = imageInfo.paletteBase || 'DeviceRGB';
    const nComp = base === 'DeviceCMYK' ? 4 : (base === 'DeviceGray' || base === 'CalGray' ? 1 : 3);
    const hival = imageInfo.paletteHival != null ? imageInfo.paletteHival : ((1 << bitsPerComponent) - 1);
    rgbaData = new Uint8ClampedArray(width * height * 4);
    const rowBytes = Math.ceil(width * bitsPerComponent / 8);

    for (let y = 0; y < height; y++) {
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
        } else if (isSeparation) {
          // Separation without tint samples: 0=no ink (white), 1=full ink (black)
          const val = (1 - bit) * 255;
          rgbaData[pi] = val;
          rgbaData[pi + 1] = val;
          rgbaData[pi + 2] = val;
        } else {
          const val = bit * 255;
          rgbaData[pi] = val;
          rgbaData[pi + 1] = val;
          rgbaData[pi + 2] = val;
        }
        rgbaData[pi + 3] = 255;
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
    // CMYK → RGB using pdf.js polynomial approximation (SWOP ICC profile match)
    rgbaData = new Uint8ClampedArray(width * height * 4);
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
  } else if (colorSpace === 'Separation') {
    // Separation color space (including single-colorant DeviceN): pixel values are tint amounts
    // (0=no ink/white, 255=full ink). Apply tint transform if available, otherwise invert.
    rgbaData = new Uint8ClampedArray(width * height * 4);
    const tintSamples = imageInfo.separationTintSamples;
    if (tintSamples && tintSamples.length >= 3) {
      const nSamples = Math.floor(tintSamples.length / 3);
      for (let i = 0; i < width * height; i++) {
        const tint = decodeInvert ? (255 - imageData[i]) : imageData[i];
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
        const val = decodeInvert ? imageData[i] : (255 - imageData[i]);
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
  if (colorKeyMask && rgbaData) {
    const nPairs = colorKeyMask.length / 2;
    const components = Math.floor(imageData.length / (width * height));
    for (let i = 0; i < width * height; i++) {
      let masked = true;
      for (let c = 0; c < nPairs; c++) {
        const val = imageData[i * components + c];
        if (val < colorKeyMask[c * 2] || val > colorKeyMask[c * 2 + 1]) {
          masked = false;
          break;
        }
      }
      if (masked) rgbaData[i * 4 + 3] = 0;
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
 * @typedef {{ type: 'M', x: number, y: number }
 *   | { type: 'L', x: number, y: number }
 *   | { type: 'C', x1: number, y1: number, x2: number, y2: number, x: number, y: number }
 *   | { type: 'Z' }} PathCommand
 */

/**
 * Common optional fields added to ops during parsing (smask, blendMode, clips) or
 * during form XObject flattening (outerSmask). Declared on each op type to avoid
 * "property does not exist" errors from TS checking.
 *
 * @typedef {{ formObjNum: number, type: string, parentCtm?: number[] }} SmaskRef
 * @typedef {{ path?: any[]|null, ctm: number[], evenOdd: boolean, textClip?: any[], fromFormObjNum?: number }} ClipEntry
 *
 * @typedef {{ patName: string, objNum: number, bbox: number[], xStep: number, yStep: number, matrix: number[], paintType: number }} TilingPatternRef
 * @typedef {{ type: number, coords: number[], stops: Array<{offset: number, color: string}>,
 *   extend?: boolean[], bbox?: number[], matrix?: number[], multiply?: boolean }
 *   | { type: 'gouraud', triangles: Array<{vertices: number[][], colors: number[][]}>, matrix?: number[], stops?: undefined }
 *   | { type: 'mesh', patches: Array<{points: number[][][], colors: number[][]}>, matrix?: number[], stops?: undefined }} PatternShading
 *
 * Properties added during form XObject flattening (not present after initial parsing):
 * - overprint: set when ExtGState enables overprint mode
 * - fillColorInherited/strokeColorInherited: markers for form color inheritance resolution
 *
 * @typedef {{ type: 'image', name: string, ctm: number[], fillAlpha: number, strokeAlpha: number,
 *   fillColor: string, strokeColor?: string,
 *   patternShading?: PatternShading, tilingPattern?: TilingPatternRef,
 *   overprint?: boolean, fillColorInherited?: boolean, strokeColorInherited?: boolean,
 *   smask?: SmaskRef|null, outerSmask?: SmaskRef|null,
 *   blendMode?: string, clips?: ClipEntry[] }} ImageDrawOp
 * @typedef {{ type: 'type3glyph', charProcObjNum: number, transform: number[], ctm?: number[],
 *   fillColor: string, fillAlpha: number, strokeAlpha?: number,
 *   strokeColor?: string, type3XObjects?: { [name: string]: number },
 *   patternShading?: PatternShading, tilingPattern?: TilingPatternRef,
 *   overprint?: boolean, fillColorInherited?: boolean, strokeColorInherited?: boolean,
 *   smask?: SmaskRef|null, outerSmask?: SmaskRef|null,
 *   blendMode?: string, clips?: ClipEntry[] }} Type3GlyphOp
 * @typedef {{
 *   type: 'type0text', text: string, fontSize: number, fontFamily: string,
 *   bold: boolean, italic: boolean, x: number, y: number,
 *   a: number, b: number, c: number, d: number, fillColor: string, fillAlpha: number,
 *   textRenderMode: number, strokeColor: string, strokeAlpha: number, lineWidth: number,
 *   ctm?: number[], patternShading?: PatternShading, tilingPattern?: TilingPatternRef,
 *   overprint?: boolean, fillColorInherited?: boolean, strokeColorInherited?: boolean,
 *   smask?: SmaskRef|null, outerSmask?: SmaskRef|null,
 *   blendMode?: string, clips?: ClipEntry[],
 *   pdfGlyphWidth?: number,
 * }} Type0TextOp
 * @typedef {{
 *   type: 'path', commands: PathCommand[], ctm: number[],
 *   fill: boolean, stroke: boolean, evenOdd: boolean,
 *   fillColor: string, strokeColor: string,
 *   lineWidth: number, lineCap: number, lineJoin: number,
 *   miterLimit: number, dashArray: number[], dashPhase: number,
 *   fillAlpha: number, strokeAlpha: number,
 *   patternShading?: PatternShading, strokePatternShading?: PatternShading,
 *   tilingPattern?: TilingPatternRef, strokeTilingPattern?: TilingPatternRef,
 *   overprint?: boolean, fillColorInherited?: boolean, strokeColorInherited?: boolean,
 *   smask?: SmaskRef|null, outerSmask?: SmaskRef|null,
 *   blendMode?: string, clips?: ClipEntry[],
 * }} PathDrawOp
 * @typedef {{ type: 'shading', shading: object, ctm: number[], fillAlpha: number,
 *   fillColor?: string, strokeColor?: string, strokeAlpha?: number,
 *   patternShading?: PatternShading, tilingPattern?: TilingPatternRef,
 *   overprint?: boolean, fillColorInherited?: boolean, strokeColorInherited?: boolean,
 *   smask?: SmaskRef|null, outerSmask?: SmaskRef|null,
 *   blendMode?: string, clips?: ClipEntry[] }} ShadingDrawOp
 * @typedef {{ type: 'inlineImage', dictText: string, imageData: string, ctm: number[],
 *   fillColor: string, fillAlpha: number, strokeColor?: string, strokeAlpha?: number,
 *   patternShading?: PatternShading, tilingPattern?: TilingPatternRef,
 *   overprint?: boolean, fillColorInherited?: boolean, strokeColorInherited?: boolean,
 *   smask?: SmaskRef|null, outerSmask?: SmaskRef|null,
 *   blendMode?: string, clips?: ClipEntry[],
 *   colorSpaces?: Map<string, {type: string, tintSamples: Uint8Array|null, nComponents: number, deviceNGrid?: object|null, indexedInfo?: object|null, labWhitePoint?: number[]|null}>,
 * }} InlineImageOp
 * @typedef {ImageDrawOp | Type3GlyphOp | Type0TextOp | PathDrawOp | ShadingDrawOp | InlineImageOp} DrawOp
 */

/**
 * Parse a content stream and extract image draw operations, Type3 glyph
 * draw operations, and vector path draw operations with their full transforms.
 *
 * @param {string|string[]} contentStream
 * @param {Map<string, object>} fonts - Font map from parsePageFonts
 * @param {Map<string, ExtGStateEntry>} [extGStates] - ExtGState map
 * @param {Map<string, string>} [registeredFontNames]
 * @param {Map<string, object>} [colorSpaces]
 * @param {Set<string>} [symbolFontTags]
 * @param {Set<string>} [cidPUATags]
 * @param {Set<string>} [rawCharCodeTags]
 * @param {Map<string, object>} [shadings]
 * @param {Map<string, object>} [patterns]
 * @param {Map<string, Set<number>>} [cidCollisionMap]
 * @returns {Array<DrawOp>}
 */
function parseDrawOps(
  contentStream, fonts, extGStates, registeredFontNames, colorSpaces = new Map(),
  symbolFontTags = new Set(), cidPUATags = new Set(), rawCharCodeTags = new Set(),
  shadings = new Map(), patterns = new Map(), cidCollisionMap = new Map(),
) {
  /** @type {Array<DrawOp>} */
  const ops = [];

  // Accept either a single content stream string or an array of stream strings
  // (one per /Contents entry). Per PDF spec §7.8.2, streams in the /Contents
  // array are equivalent to a single concatenated stream — the split between
  // streams may fall between any pair of lexical tokens, including inside an
  // open array (e.g. `[` at the end of one stream and `(text)] TJ` at the
  // start of the next). Tokenizing each stream individually breaks such
  // PDFs, dropping the entire spanning operator. Concatenate before tokenizing.
  const streams = Array.isArray(contentStream) ? contentStream : [contentStream];
  const tokens = tokenizeContentStream(streams.join('\n'));

  // Graphics state
  let ctm = [1, 0, 0, 1, 0, 0];
  /** @type {any[]} */
  const gsStack = [];

  // Text state
  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = [1, 0, 0, 1, 0, 0];
  /** @type {any} */
  let currentFont = null;
  let currentFontTag = '';
  let fontSize = 12;
  let tc = 0;
  let tw = 0;
  let tl = 0;
  let tz = 100; // horizontal scaling percentage (100 = normal)
  let trise = 0; // text rise (Ts operator)
  let textRenderMode = 0; // 0=fill, 1=stroke, 2=fill+stroke, 3=invisible
  let fillColor = 'black';
  // Per PDF spec §8.10.1, a Form XObject's content stream inherits the graphics
  // state from the caller at the time of `Do`. parseDrawOps starts every stream
  // (including form streams) with parser-default colors, so we track whether the
  // current stream has explicitly set a fill/stroke color yet. Ops emitted while
  // false get an inheritance marker that flattenDrawOps resolves against the
  // parent op's color when expanding the form.
  let fillColorExplicit = false;
  let fillPatternShading = null; // shading data for pattern fills (gradient info)
  let fillTilingPattern = null; // tiling pattern data for pattern fills
  let strokeColor = 'rgb(0,0,0)';
  let strokeColorExplicit = false;
  let strokePatternShading = null; // shading data for pattern strokes
  let strokeTilingPattern = null; // tiling pattern data for pattern strokes
  let fillColorSpaceType = '';
  let strokeColorSpaceType = '';
  /** @type {Uint8Array|null} */
  let fillTintSamples = null;
  let fillTintNComponents = 3;
  let fillDeviceNGrid = null;
  /** @type {{palette: Uint8Array, hival: number, base: string}|null} */
  let fillIndexedInfo = null;
  /** @type {{palette: Uint8Array, hival: number, base: string}|null} */
  let strokeIndexedInfo = null;
  /** @type {Uint8Array|null} */
  let strokeTintSamples = null;
  let strokeTintNComponents = 3;
  let fillAlpha = 1;
  let strokeAlpha = 1;
  let overprint = false;
  let blendMode = 'Normal';
  let lineWidth = 1;
  let lineCap = 0;
  let lineJoin = 0;
  let miterLimit = 10;
  let dashArray = /** @type {number[]} */ ([]);
  let dashPhase = 0;

  // Path construction state
  /** @type {PathCommand[]} */
  let currentPath = [];
  let curX = 0;
  let curY = 0;
  let pathStartX = 0;
  let pathStartY = 0;

  // Clipping state
  let pendingClip = false; // true after W/W* until next paint/n
  let pendingClipEvenOdd = false; // true if W* (even-odd clipping)
  /** @type {Array<{path: PathCommand[], ctm: number[], evenOdd: boolean}>} */
  /** @type {ClipEntry[]} */
  let clipStack = [];

  // Text clipping: Tr modes 4-7 accumulate text outlines for clipping.
  // At ET, the accumulated text shapes become a clip that affects subsequent ops.
  /** @type {Array<{text: string, fontFamily: string, fontSize: number, a: number, b: number, c: number, d: number, x: number, y: number}>} */
  let textClipChars = [];

  // Soft mask state (from ExtGState /SMask)
  /** @type {{ formObjNum: number, type: string }|null} */
  /** @type {SmaskRef|null} */
  let currentSmask = null;

  /** @type {Array<any>} */
  const operandStack = [];

  // When a non-finite number (NaN) is detected in the token stream, it signals
  // corrupted content data. In that case we flush the current path and enter
  // skip mode: discard path construction ops until a painting op resets state.
  let skipCorruptedPath = false;

  // Corruption detection: count path-op anomalies (excess operands, out-of-bounds
  // coordinates, leftover operands at paint ops). A high count signals a corrupted
  // deflate stream where missing whitespace/periods produce garbled tokens. Once
  // the threshold is reached, stop emitting all subsequent draw ops to prevent
  // garbled fills from covering correctly-rendered content.
  let pathAnomalyCount = 0;
  let streamCorrupted = false;

  /**
   * Emit Type3 glyph ops for a literal string.
   * @param {string} str
   */
  function showType3Literal(str) {
    if (!currentFont || !currentFont.type3) return;
    const { encoding, charProcObjNums, fontMatrix } = currentFont.type3;
    for (let i = 0; i < str.length; i++) {
      const charCode = str.charCodeAt(i);
      const glyphName = encoding[charCode];
      const charProcObjNum = glyphName ? charProcObjNums[glyphName] : undefined;
      const glyphWidth = (currentFont.widths.get(charCode) ?? currentFont.defaultWidth) / 1000 * fontSize;

      if (charProcObjNum !== undefined) {
        // Compute text rendering matrix: Trm = [fontSize, 0, 0, fontSize, 0, 0] * Tm * CTM
        const trm = matMul([fontSize * tz / 100, 0, 0, fontSize, 0, trise], matMul(tm, ctm));
        const transform = matMul(fontMatrix, trm);
        const type3XObjects = currentFont.type3?.xobjectResources;
        /** @type {Type3GlyphOp} */
        const type3Op = {
          type: 'type3glyph', charProcObjNum, transform, fillColor, fillAlpha, type3XObjects,
        };
        if (!fillColorExplicit) type3Op.fillColorInherited = true;
        ops.push(type3Op);
      }

      const advance = (glyphWidth + tc + (charCode === 0x20 ? tw : 0)) * tz / 100;
      tm[4] += advance * tm[0];
      tm[5] += advance * tm[1];
    }
  }

  /**
   * Emit Type3 glyph ops for a hex string (2-byte CID encoding).
   * @param {string} hex
   */
  function showType3Hex(hex) {
    if (!currentFont || !currentFont.type3) return;
    const { encoding, charProcObjNums, fontMatrix } = currentFont.type3;
    // Determine byte width from hex string length: 2 hex chars = 1-byte code,
    // 4+ hex chars = 2-byte CID (matching the existing behavior for multi-byte strings).
    const step = hex.length <= 2 ? 2 : 4;
    for (let i = 0; i + step - 1 <= hex.length; i += step) {
      const charCode = parseInt(hex.substring(i, i + step), 16);
      const glyphName = encoding[charCode];
      const charProcObjNum = glyphName ? charProcObjNums[glyphName] : undefined;
      const glyphWidth = (currentFont.widths.get(charCode) ?? currentFont.defaultWidth) / 1000 * fontSize;

      if (charProcObjNum !== undefined) {
        const trm = matMul([fontSize * tz / 100, 0, 0, fontSize, 0, trise], matMul(tm, ctm));
        const transform = matMul(fontMatrix, trm);
        const type3XObjects = currentFont.type3?.xobjectResources;
        /** @type {Type3GlyphOp} */
        const type3Op = {
          type: 'type3glyph', charProcObjNum, transform, fillColor, fillAlpha, type3XObjects,
        };
        if (!fillColorExplicit) type3Op.fillColorInherited = true;
        ops.push(type3Op);
      }

      const isWordSpace = step === 2 && charCode === 0x20;
      const advance = (glyphWidth + tc + (isWordSpace ? tw : 0)) * tz / 100;
      tm[4] += advance * tm[0];
      tm[5] += advance * tm[1];
    }
  }

  /**
   * Advance text position for standard fonts (with optional CSS text rendering).
   * @param {string} str
   */
  function advanceLiteral(str) {
    if (!currentFont) return;
    const registeredName = registeredFontNames && registeredFontNames.get(currentFontTag);
    // See the long comment in advanceHex for why codespace ranges matter here:
    // a non-embedded Type0 CID font with a mixed 1-byte/2-byte predefined CMap
    // (e.g. /83pv-RKSJ-H) must decode 1-byte ASCII codes as 1 byte, not 2.
    const csRanges = currentFont.codespaceRanges;
    let i = 0;
    while (i < str.length) {
      let charCode;
      let numBytes = 1;
      if (csRanges) {
        const byte0 = str.charCodeAt(i);
        let matched = false;
        for (let r = 0; r < csRanges.length; r++) {
          const range = csRanges[r];
          if (range.bytes === 1) {
            if (byte0 >= range.low && byte0 <= range.high) {
              charCode = byte0;
              numBytes = 1;
              matched = true;
              break;
            }
          } else if (range.bytes === 2 && i + 1 < str.length) {
            const code2 = (byte0 << 8) | str.charCodeAt(i + 1);
            if (code2 >= range.low && code2 <= range.high) {
              charCode = code2;
              numBytes = 2;
              matched = true;
              break;
            }
          }
        }
        if (!matched) {
          if (i + 1 < str.length) {
            charCode = (byte0 << 8) | str.charCodeAt(i + 1);
            numBytes = 2;
          } else {
            charCode = byte0;
            numBytes = 1;
          }
        }
      } else {
        charCode = str.charCodeAt(i);
        numBytes = 1;
      }
      const glyphWidth = (currentFont.widths.get(charCode) ?? currentFont.defaultWidth) / 1000 * fontSize;
      const unicode = currentFont.toUnicode.get(charCode)
        || (numBytes === 1 ? str[i] : String.fromCharCode(charCode));
      const drawText = currentFont.encodingUnicode?.get(charCode) || unicode;
      // Skip zero-width characters
      if (registeredName && textRenderMode !== 3 && glyphWidth !== 0 && drawText && drawText.trim().length > 0) {
        const trm = matMul([fontSize * tz / 100, 0, 0, fontSize, 0, trise], matMul(tm, ctm));
        /** @type {Type0TextOp} */
        const textOp = {
          type: 'type0text',
          text: drawText,
          fontSize,
          fontFamily: registeredName,
          bold: currentFont.bold,
          italic: currentFont.italic,
          x: trm[4],
          y: trm[5],
          a: trm[0],
          b: trm[1],
          c: trm[2],
          d: trm[3],
          fillColor,
          fillAlpha,
          textRenderMode,
          strokeColor,
          strokeAlpha,
          lineWidth,
        };
        if (!fillColorExplicit) textOp.fillColorInherited = true;
        if (!strokeColorExplicit) textOp.strokeColorInherited = true;
        ops.push(textOp);
      }
      i += numBytes;
      const isWordSpace = numBytes === 1 && charCode === 0x20;
      if (currentFont.verticalMode) {
        const vAdvance = (-fontSize + tc + (isWordSpace ? tw : 0)) * tz / 100;
        tm[4] += vAdvance * tm[2];
        tm[5] += vAdvance * tm[3];
      } else {
        const advance = (glyphWidth + tc + (isWordSpace ? tw : 0)) * tz / 100;
        tm[4] += advance * tm[0];
        tm[5] += advance * tm[1];
      }
    }
  }

  // Track last drawn hex string to detect duplicate rendering across font switches.
  // PDFs may interleave embedded and non-embedded sibling CID fonts where both render
  // the same hex string — the embedded font draws the glyphs, the non-embedded font
  // provides advance widths. Without dedup, characters appear doubled.
  let lastDrawnHex = '';
  let lastDrawnFontTag = '';

  /**
   * Advance text position for standard font hex strings (with optional CSS text rendering).
   * @param {string} hex
   */
  function advanceHex(hex) {
    if (!currentFont) return;
    const registeredName = registeredFontNames && registeredFontNames.get(currentFontTag);
    const usePUA = cidPUATags.has(currentFontTag);
    // Some Type0 CID fonts reach this function because their descendant CIDFont
    // has no embedded FontFile (fontObj.type0 is null), so showString routes
    // them here instead of to showType0Hex. Such fonts may carry codespaceRanges
    // from a predefined CMap like /83pv-RKSJ-H that mixes 1-byte ASCII with
    // 2-byte Shift-JIS codes; without honoring those ranges, ASCII hex like
    // <4E6F7420> ("Not ") gets decoded as two 2-byte CIDs (0x4E6F, 0x7420) and
    // fed to String.fromCharCode, producing CJK codepoints (乯, 琠) instead of Latin letters.
    const csRanges = currentFont.codespaceRanges;
    // Dedup: if the exact same hex string was just drawn by a different font (sibling),
    // skip drawing entirely — just advance the text position.
    const isDup = hex === lastDrawnHex && lastDrawnFontTag !== currentFontTag && lastDrawnHex.length > 0;
    let i = 0;
    while (i < hex.length) {
      let charCode;
      let hexDigits = 4;
      if (csRanges && i + 1 < hex.length) {
        const byte0 = parseInt(hex.substring(i, i + 2), 16);
        let matched = false;
        for (let r = 0; r < csRanges.length; r++) {
          const range = csRanges[r];
          if (range.bytes === 1) {
            if (byte0 >= range.low && byte0 <= range.high) {
              charCode = byte0;
              hexDigits = 2;
              matched = true;
              break;
            }
          } else if (range.bytes === 2 && i + 3 < hex.length) {
            const code2 = parseInt(hex.substring(i, i + 4), 16);
            if (code2 >= range.low && code2 <= range.high) {
              charCode = code2;
              hexDigits = 4;
              matched = true;
              break;
            }
          }
        }
        if (!matched) {
          if (i + 3 < hex.length) {
            charCode = parseInt(hex.substring(i, i + 4), 16);
            hexDigits = 4;
          } else {
            charCode = parseInt(hex.substring(i, i + 2), 16);
            hexDigits = 2;
          }
        }
      } else {
        if (i + 3 >= hex.length) break;
        charCode = parseInt(hex.substring(i, i + 4), 16);
        hexDigits = 4;
      }
      const glyphWidth = (currentFont.widths.get(charCode) ?? currentFont.defaultWidth) / 1000 * fontSize;
      if (!isDup) {
        const unicode = currentFont.toUnicode.get(charCode) || String.fromCharCode(charCode);
        const collided = cidCollisionMap.get(currentFontTag)?.has(charCode);
        const drawText = usePUA
          ? String.fromCodePoint(cidCodepoint(collided ? undefined : currentFont.toUnicode?.get(charCode), charCode).codepoint)
          : (currentFont.encodingUnicode?.get(charCode) || unicode);
        if (registeredName && textRenderMode !== 3 && drawText && drawText.trim().length > 0) {
          const trm = matMul([fontSize * tz / 100, 0, 0, fontSize, 0, trise], matMul(tm, ctm));
          /** @type {Type0TextOp} */
          const textOp = {
            type: 'type0text',
            text: drawText,
            fontSize,
            fontFamily: registeredName,
            bold: currentFont.bold,
            italic: currentFont.italic,
            x: trm[4],
            y: trm[5],
            a: trm[0],
            b: trm[1],
            c: trm[2],
            d: trm[3],
            fillColor,
            fillAlpha,
            textRenderMode,
            strokeColor,
            strokeAlpha,
            lineWidth,
          };
          if (!fillColorExplicit) textOp.fillColorInherited = true;
          if (!strokeColorExplicit) textOp.strokeColorInherited = true;
          ops.push(textOp);
        }
      }
      i += hexDigits;
      const isWordSpace = hexDigits === 2 && charCode === 0x20;
      if (currentFont.verticalMode) {
        const vAdv = (-fontSize + tc + (isWordSpace ? tw : 0)) * tz / 100;
        tm[4] += vAdv * tm[2];
        tm[5] += vAdv * tm[3];
      } else {
        const advance = (glyphWidth + tc + (isWordSpace ? tw : 0)) * tz / 100;
        tm[4] += advance * tm[0];
        tm[5] += advance * tm[1];
      }
    }
    lastDrawnHex = hex;
    lastDrawnFontTag = currentFontTag;
  }

  /**
   * Emit Type0 text ops for a hex string (2-byte CID encoding).
   * @param {string} hex
   */
  function showType0Hex(hex) {
    if (!currentFont || !currentFont.type0) return;
    const registeredName = registeredFontNames && registeredFontNames.get(currentFontTag);
    if (!registeredName) return;
    const usePUA = cidPUATags.has(currentFontTag);
    const cmapLookup = currentFont.charCodeToCID;
    const csRanges = currentFont.codespaceRanges;
    let i = 0;
    while (i < hex.length) {
      let charCode;
      let hexDigits = 4; // default 2-byte = 4 hex digits
      if (csRanges && i + 1 < hex.length) {
        const byte0 = parseInt(hex.substring(i, i + 2), 16);
        let matched = false;
        for (let r = 0; r < csRanges.length; r++) {
          const range = csRanges[r];
          if (range.bytes === 1) {
            if (byte0 >= range.low && byte0 <= range.high) {
              charCode = byte0;
              hexDigits = 2;
              matched = true;
              break;
            }
          } else if (range.bytes === 2 && i + 3 < hex.length) {
            const code2 = parseInt(hex.substring(i, i + 4), 16);
            if (code2 >= range.low && code2 <= range.high) {
              charCode = code2;
              hexDigits = 4;
              matched = true;
              break;
            }
          }
        }
        if (!matched) {
          if (i + 3 < hex.length) {
            charCode = parseInt(hex.substring(i, i + 4), 16);
          } else {
            charCode = parseInt(hex.substring(i, i + 2), 16);
            hexDigits = 2;
          }
        }
      } else {
        if (i + 3 >= hex.length) break;
        charCode = parseInt(hex.substring(i, i + 4), 16);
      }
      i += hexDigits;
      const cid = cmapLookup ? (cmapLookup.get(charCode) ?? charCode) : charCode;
      const rawWidth = currentFont.widths.get(cid) ?? currentFont.defaultWidth;
      const glyphWidth = rawWidth / 1000 * fontSize;
      if (textRenderMode !== 3) {
        const trm = matMul([fontSize * tz / 100, 0, 0, fontSize, 0, trise], matMul(tm, ctm));
        // Use cidCodepoint() to select real Unicode or PUA — must match the font builder.
        // ToUnicode CMap maps charCodes (not CIDs) to Unicode, so use charCode for lookup.
        const collided = cidCollisionMap.get(currentFontTag)?.has(cid);
        const unicode = usePUA
          ? String.fromCodePoint(cidCodepoint(collided ? undefined : currentFont.toUnicode?.get(charCode), cid).codepoint)
          : (currentFont.toUnicode?.get(charCode) || String.fromCharCode(charCode));
        if (unicode && unicode.trim().length > 0) {
          /** @type {Type0TextOp} */
          const opObj = {
            type: 'type0text',
            text: unicode,
            fontSize,
            fontFamily: registeredName,
            bold: currentFont.bold,
            italic: currentFont.italic,
            x: trm[4],
            y: trm[5],
            a: trm[0],
            b: trm[1],
            c: trm[2],
            d: trm[3],
            fillColor,
            fillAlpha,
            textRenderMode,
            strokeColor,
            strokeAlpha,
            lineWidth,
          };
          if (currentFont.type0 && !currentFont.type0.fontFile) {
            opObj.pdfGlyphWidth = rawWidth;
          }
          if (!fillColorExplicit) opObj.fillColorInherited = true;
          if (!strokeColorExplicit) opObj.strokeColorInherited = true;
          ops.push(opObj);
        }
      }
      const isWordSpace = hexDigits === 2 && charCode === 0x20;
      if (currentFont.verticalMode) {
        const vAdvance = (-fontSize + tc + (isWordSpace ? tw : 0)) * tz / 100;
        tm[4] += vAdvance * tm[2];
        tm[5] += vAdvance * tm[3];
      } else {
        const advance = (glyphWidth + tc + (isWordSpace ? tw : 0)) * tz / 100;
        tm[4] += advance * tm[0];
        tm[5] += advance * tm[1];
      }
    }
    lastDrawnHex = hex;
    lastDrawnFontTag = currentFontTag;
  }

  /**
   * Emit Type0 text ops for a literal string (single-byte encoding).
   * @param {string} str
   */
  function showType0Literal(str) {
    if (!currentFont || !currentFont.type0) return;
    const registeredName = registeredFontNames && registeredFontNames.get(currentFontTag);
    if (!registeredName) return;
    const usePUA = cidPUATags.has(currentFontTag);
    const cmapLookup = currentFont.charCodeToCID;
    const csRanges = currentFont.codespaceRanges;
    // Type0/CID fonts typically use 2-byte encoding, but some CMaps define
    // mixed-width codespace ranges (e.g. 1-byte for space, 2-byte for CIDs).
    let i = 0;
    while (i < str.length) {
      let charCode;
      let numBytes = 2;
      if (csRanges) {
        const byte0 = str.charCodeAt(i);
        let matched = false;
        for (let r = 0; r < csRanges.length; r++) {
          const range = csRanges[r];
          if (range.bytes === 1) {
            if (byte0 >= range.low && byte0 <= range.high) {
              charCode = byte0;
              numBytes = 1;
              matched = true;
              break;
            }
          } else if (range.bytes === 2 && i + 1 < str.length) {
            const code2 = (byte0 << 8) | str.charCodeAt(i + 1);
            if (code2 >= range.low && code2 <= range.high) {
              charCode = code2;
              numBytes = 2;
              matched = true;
              break;
            }
          }
        }
        if (!matched) {
          if (i + 1 < str.length) {
            charCode = (byte0 << 8) | str.charCodeAt(i + 1);
          } else {
            charCode = byte0;
            numBytes = 1;
          }
        }
      } else {
        if (i + 1 >= str.length) break;
        charCode = (str.charCodeAt(i) << 8) | str.charCodeAt(i + 1);
      }
      i += numBytes;
      const cid = cmapLookup ? (cmapLookup.get(charCode) ?? charCode) : charCode;
      const rawWidth = currentFont.widths.get(cid) ?? currentFont.defaultWidth;
      const glyphWidth = rawWidth / 1000 * fontSize;
      if (textRenderMode !== 3) {
        const trm = matMul([fontSize * tz / 100, 0, 0, fontSize, 0, trise], matMul(tm, ctm));
        // Use cidCodepoint() to select real Unicode or PUA — must match the font builder.
        // ToUnicode CMap maps charCodes (not CIDs) to Unicode, so use charCode for lookup.
        const collided = cidCollisionMap.get(currentFontTag)?.has(cid);
        const unicode = usePUA
          ? String.fromCodePoint(cidCodepoint(collided ? undefined : currentFont.toUnicode?.get(charCode), cid).codepoint)
          : (currentFont.toUnicode?.get(charCode) || String.fromCharCode(charCode));
        if (unicode && unicode.trim().length > 0) {
          /** @type {Type0TextOp} */
          const opObj = {
            type: 'type0text',
            text: unicode,
            fontSize,
            fontFamily: registeredName,
            bold: currentFont.bold,
            italic: currentFont.italic,
            x: trm[4],
            y: trm[5],
            a: trm[0],
            b: trm[1],
            c: trm[2],
            d: trm[3],
            fillColor,
            fillAlpha,
            textRenderMode,
            strokeColor,
            strokeAlpha,
            lineWidth,
          };
          if (currentFont.type0 && !currentFont.type0.fontFile) {
            opObj.pdfGlyphWidth = rawWidth;
          }
          if (!fillColorExplicit) opObj.fillColorInherited = true;
          if (!strokeColorExplicit) opObj.strokeColorInherited = true;
          ops.push(opObj);
        }
      }
      const isWordSpace = numBytes === 1 && charCode === 0x20;
      if (currentFont.verticalMode) {
        // Vertical writing: advance downward (w1 default = -1000 units)
        const vAdvance = (-fontSize + tc + (isWordSpace ? tw : 0)) * tz / 100;
        tm[4] += vAdvance * tm[2];
        tm[5] += vAdvance * tm[3];
      } else {
        const advance = (glyphWidth + tc + (isWordSpace ? tw : 0)) * tz / 100;
        tm[4] += advance * tm[0];
        tm[5] += advance * tm[1];
      }
    }
  }

  /**
   * Emit text ops for a Type1/TrueType literal string (single-byte encoding).
   * @param {string} str
   */
  function showType1Literal(str) {
    if (!currentFont || !currentFont.type1) return;
    const registeredName = registeredFontNames && registeredFontNames.get(currentFontTag);
    if (!registeredName) return;
    const isSymbol = symbolFontTags.has(currentFontTag);
    const isRawCharCode = rawCharCodeTags.has(currentFontTag);
    const hasPUA = cidPUATags.has(currentFontTag);
    const isNonEmbedded = !currentFont.type1.fontFile;
    const hasDifferences = !!(currentFont.differences && Object.keys(currentFont.differences).length > 0);
    for (let i = 0; i < str.length; i++) {
      const charCode = str.charCodeAt(i);
      const rawWidth = currentFont.widths.get(charCode) ?? currentFont.defaultWidth;
      const glyphWidth = rawWidth / 1000 * fontSize;
      const unicode = currentFont.toUnicode.get(charCode) || str[i];
      // For PUA-mapped chars without AGL encoding, the charCode may be a control
      // or whitespace char (e.g. charCode 32 mapped to custom glyph G31). Use PUA
      // codepoint which is always non-whitespace, bypassing the trim() skip below.
      // Use PUA when: (a) charCode is in /Differences, (b) font has no /Differences
      // (relying on CFF built-in encoding, e.g., TeX CMSY10), or (c) charCode is NOT
      // in /Differences but also has no AGL/encoding mapping (custom CFF glyph names
      // like C0083 that only work through the built-in encoding's PUA entries).
      // Use PUA when: the font has PUA cmap entries AND the charCode either (a) is a
      // control char, (b) has no AGL/encoding mapping, or (c) is overridden by /Differences
      // (which may map it to a non-AGL glyph name like "boxcheckbld" that only exists in
      // the CFF font's PUA cmap, not in the encoding's Unicode mapping).
      const inDifferences = !!(currentFont.differences && currentFont.differences[charCode] !== undefined);
      // For CFF fonts rebuilt with PUA cmap entries:
      // - If /Differences exists, PUA entries are only generated for explicit /Differences
      //   charCodes, so never force PUA for ordinary ASCII codes.
      // - If /Differences is absent, keep the broader PUA fallback for control/unmapped codes.
      const usesPUA = hasPUA && (
        (hasDifferences && inDifferences)
        || (!hasDifferences && (charCode < 0x20 || !currentFont.encodingUnicode?.has(charCode)))
      );
      // Symbol fonts (e.g. Wingdings) use charCodes in 0x01-0x1F range for visible glyphs
      // (circled numbers, arrows, etc.). These charCodes map to JS control characters
      // (\f, \r, etc.) that would be filtered out by trim(). Always render Symbol chars.
      if (textRenderMode !== 3 && (isSymbol || usesPUA || (unicode && unicode.trim().length > 0))) {
        let trm = matMul([fontSize * tz / 100, 0, 0, fontSize, 0, trise], matMul(tm, ctm));
        // Apply non-standard FontMatrix (shear/flip) from embedded Type1 font program
        const fm = currentFont.type1.fontMatrix;
        if (fm) trm = matMul(fm, trm);
        // For Symbol-encoded fonts, use PUA codepoints (0xF000 + charCode).
        // For fonts with PUA cmap entries, use PUA when the charCode has no AGL mapping.
        // For Mac-only cmap fonts, use raw charCode for drawing — but for Mac-Roman
        // cmaps, use the Mac-Roman Unicode mapping so Chrome resolves the correct glyph.
        // E.g., charCode 0xA5 → U+2022 (•) not U+00A5 (¥).
        let drawText;
        if (isSymbol) {
          drawText = String.fromCharCode(0xF000 + charCode);
        } else if (usesPUA) {
          drawText = String.fromCharCode(0xE000 + charCode);
        } else if (isRawCharCode) {
          // For Mac-only cmap fonts: charCodes >= 0x20 map directly through the font's
          // Mac cmap (the byte position IS the glyph lookup key). Multi-codepoint bfchar
          // entries (conjunct glyphs in Indic fonts, ligatures) AND Indic combining marks
          // use PUA (0xE000 + charCode) to avoid collisions and to bypass Chrome's
          // dotted-circle placeholder for orphan combining marks. Must match
          // convertFontToOTF's rawCharCode path.
          {
            const uniStr = currentFont.toUnicode.get(charCode);
            const firstCp = uniStr ? uniStr.codePointAt(0) : 0;
            const needsPUA = uniStr && ([...uniStr].length > 1 || isCombiningOrIndicMark(firstCp));
            if (needsPUA) {
              drawText = String.fromCharCode(0xE000 + charCode);
            } else {
              drawText = uniStr ? String.fromCodePoint(firstCp) : str[i];
            }
          }
        } else {
          drawText = currentFont.encodingUnicode?.get(charCode) || unicode;
        }
        const opObj = {
          type: 'type0text',
          text: drawText,
          fontSize,
          fontFamily: registeredName,
          bold: currentFont.bold,
          italic: currentFont.italic,
          x: trm[4],
          y: trm[5],
          a: trm[0],
          b: trm[1],
          c: trm[2],
          d: trm[3],
          fillColor,
          fillAlpha,
          textRenderMode,
          strokeColor,
          strokeAlpha,
          lineWidth,
        };
        if (isNonEmbedded) opObj.pdfGlyphWidth = rawWidth;
        if (!fillColorExplicit) opObj.fillColorInherited = true;
        if (!strokeColorExplicit) opObj.strokeColorInherited = true;
        ops.push(opObj);
      }
      const advance = (glyphWidth + tc + (charCode === 0x20 ? tw : 0)) * tz / 100;
      tm[4] += advance * tm[0];
      tm[5] += advance * tm[1];
    }
  }

  /**
   * Emit text ops for a Type1/TrueType hex string (single-byte, 2-hex-digit encoding).
   * @param {string} hex
   */
  function showType1Hex(hex) {
    if (!currentFont || !currentFont.type1) return;
    const registeredName = registeredFontNames && registeredFontNames.get(currentFontTag);
    if (!registeredName) return;
    const isSymbol = symbolFontTags.has(currentFontTag);
    const isRawCharCode = rawCharCodeTags.has(currentFontTag);
    const hasPUA = cidPUATags.has(currentFontTag);
    const isNonEmbedded = !currentFont.type1.fontFile;
    const hasDifferences = !!(currentFont.differences && Object.keys(currentFont.differences).length > 0);
    for (let i = 0; i + 1 <= hex.length; i += 2) {
      const charCode = parseInt(hex.substring(i, i + 2), 16);
      const rawWidth = currentFont.widths.get(charCode) ?? currentFont.defaultWidth;
      const glyphWidth = rawWidth / 1000 * fontSize;
      const unicode = currentFont.toUnicode.get(charCode) || String.fromCharCode(charCode);
      const inDifferences = !!(currentFont.differences && currentFont.differences[charCode] !== undefined);
      const usesPUA = hasPUA && charCode > 0 && (
        (hasDifferences && inDifferences)
        || (!hasDifferences && (charCode < 0x20 || !currentFont.encodingUnicode?.has(charCode)))
      );
      // Skip zero-width characters — the PDF Widths array says these occupy no space,
      // so they should not render visually (common in TeX fonts for unused charCodes).
      if (textRenderMode !== 3 && glyphWidth !== 0 && (isSymbol || usesPUA || (unicode && unicode.trim().length > 0))) {
        let trm = matMul([fontSize * tz / 100, 0, 0, fontSize, 0, trise], matMul(tm, ctm));
        const fm = currentFont.type1.fontMatrix;
        if (fm) trm = matMul(fm, trm);
        let drawText;
        if (isSymbol) {
          drawText = String.fromCharCode(0xF000 + charCode);
        } else if (usesPUA) {
          drawText = String.fromCharCode(0xE000 + charCode);
        } else if (isRawCharCode) {
          {
            const uniStr = currentFont.toUnicode.get(charCode);
            const firstCp = uniStr ? uniStr.codePointAt(0) : 0;
            const needsPUA = uniStr && ([...uniStr].length > 1 || isCombiningOrIndicMark(firstCp));
            if (needsPUA) {
              drawText = String.fromCharCode(0xE000 + charCode);
            } else {
              drawText = uniStr ? String.fromCodePoint(firstCp) : String.fromCharCode(charCode);
            }
          }
        } else {
          drawText = currentFont.encodingUnicode?.get(charCode) || unicode;
        }
        const opObj2 = {
          type: 'type0text',
          text: drawText,
          fontSize,
          fontFamily: registeredName,
          bold: currentFont.bold,
          italic: currentFont.italic,
          x: trm[4],
          y: trm[5],
          a: trm[0],
          b: trm[1],
          c: trm[2],
          d: trm[3],
          fillColor,
          fillAlpha,
          textRenderMode,
          strokeColor,
          strokeAlpha,
          lineWidth,
        };
        if (isNonEmbedded) opObj2.pdfGlyphWidth = rawWidth;
        if (!fillColorExplicit) opObj2.fillColorInherited = true;
        if (!strokeColorExplicit) opObj2.strokeColorInherited = true;
        ops.push(opObj2);
      }
      const advance = (glyphWidth + tc + (charCode === 0x20 ? tw : 0)) * tz / 100;
      tm[4] += advance * tm[0];
      tm[5] += advance * tm[1];
    }
  }

  /**
   * Show a string token — dispatches to Type3, Type0, Type1, or advance-only.
   * @param {{ type: string, value: string }} strTok
   */
  function showString(strTok) {
    if (!currentFont) return;
    const isType3 = !!currentFont.type3;
    const isType0 = !!currentFont.type0;
    const isType1 = !!currentFont.type1;
    if (strTok.type === 'hexstring') {
      if (isType3) showType3Hex(strTok.value);
      else if (isType0) showType0Hex(strTok.value);
      else if (isType1) showType1Hex(strTok.value);
      else advanceHex(strTok.value);
    } else if (strTok.type === 'string') {
      if (isType3) showType3Literal(strTok.value);
      else if (isType0) showType0Literal(strTok.value);
      else if (isType1) showType1Literal(strTok.value);
      else advanceLiteral(strTok.value);
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    // Handle inline images (BI/ID/EI) — the tokenizer produces a single 'inlineImage' token
    // containing the image dict text and binary data.
    if (tok.type === 'inlineImage') {
      const { dictText, imageData } = tok.value;
      /** @type {InlineImageOp} */
      const inlineOp = {
        type: 'inlineImage',
        dictText,
        imageData,
        ctm: ctm.slice(),
        fillColor,
        fillAlpha,
        colorSpaces, // carry the active color space registry so Form XObject inline images resolve correctly
      };
      if (fillTilingPattern) inlineOp.tilingPattern = fillTilingPattern;
      if (fillPatternShading) inlineOp.patternShading = fillPatternShading;
      if (clipStack.length > 0) {
        inlineOp.clips = clipStack.map((c) => {
          const entry = { path: c.path ? c.path.slice() : null, ctm: c.ctm.slice(), evenOdd: c.evenOdd };
          if (c.textClip) entry.textClip = c.textClip;
          return entry;
        });
      }
      if (!fillColorExplicit) inlineOp.fillColorInherited = true;
      ops.push(inlineOp);
      continue;
    }

    if (tok.type !== 'operator') {
      // Non-finite numbers (NaN from garbled tokens like "4.58984938980.04") signal
      // corrupted content stream data. Flush the current path to preserve clean content
      // already accumulated, and enter corruption-skip mode: discard all subsequent
      // path construction until a painting operator resets the state.
      if (tok.type === 'number' && !Number.isFinite(tok.value)) {
        operandStack.length = 0;
        if (currentPath.length > 0) {
          /** @type {PathDrawOp} */
          const flushOp = {
            type: 'path',
            commands: currentPath,
            ctm: ctm.slice(),
            fill: false,
            stroke: true,
            evenOdd: false,
            fillColor,
            strokeColor,
            lineWidth,
            lineCap,
            lineJoin,
            miterLimit,
            dashArray: dashArray.length > 0 ? dashArray.slice() : dashArray,
            dashPhase,
            fillAlpha,
            strokeAlpha,
          };
          if (currentSmask) flushOp.smask = currentSmask;
          if (blendMode !== 'Normal') flushOp.blendMode = blendMode;
          ops.push(flushOp);
          currentPath = [];
        }
        skipCorruptedPath = true;
        continue;
      }
      operandStack.push(tok);
      continue;
    }

    // If enough path anomalies accumulated (excess operands, out-of-bounds
    // coordinates, leftover operands before paint ops), the content stream is
    // likely corrupted (e.g. damaged deflate data). Stop emitting draw ops to
    // prevent garbled fills from covering valid content.
    if (pathAnomalyCount >= 5 && !streamCorrupted) {
      streamCorrupted = true;
      console.warn('[renderPdfPage] Content stream appears corrupted (5+ path/color operand anomalies detected). Suppressing remaining draw operations to preserve valid content.');
    }
    if (streamCorrupted) {
      operandStack.length = 0;
      continue;
    }

    const opsLenBeforeOp = ops.length;

    switch (tok.value) {
      // Graphics state
      case 'q':
        gsStack.push({
          ctm: ctm.slice(),
          fillColor,
          fillColorExplicit,
          fillPatternShading,
          fillTilingPattern,
          strokeColor,
          strokeColorExplicit,
          strokePatternShading,
          strokeTilingPattern,
          fillColorSpaceType,
          strokeColorSpaceType,
          fillTintSamples,
          fillTintNComponents,
          strokeTintSamples,
          strokeTintNComponents,
          fillAlpha,
          strokeAlpha,
          lineWidth,
          lineCap,
          lineJoin,
          miterLimit,
          dashArray: dashArray.length > 0 ? dashArray.slice() : [],
          dashPhase,
          tc,
          tw,
          tl,
          tz,
          trise,
          textRenderMode,
          fontSize,
          currentFont,
          currentFontTag,
          clipStack: clipStack.length > 0 ? clipStack.map((c) => {
            /** @type {ClipEntry} */
            const entry = { path: c.path ? c.path.slice() : null, ctm: c.ctm.slice(), evenOdd: c.evenOdd };
            if (c.textClip) entry.textClip = c.textClip;
            return entry;
          }) : [],
          currentSmask,
          overprint,
          blendMode,
          pendingClip,
          pendingClipEvenOdd,
        });
        operandStack.length = 0;
        break;
      case 'Q':
        if (gsStack.length > 0) {
          const saved = gsStack.pop();
          ctm = saved.ctm;
          fillColor = saved.fillColor;
          fillColorExplicit = saved.fillColorExplicit;
          fillPatternShading = saved.fillPatternShading;
          fillTilingPattern = saved.fillTilingPattern;
          strokeColor = saved.strokeColor;
          strokeColorExplicit = saved.strokeColorExplicit;
          strokePatternShading = saved.strokePatternShading;
          strokeTilingPattern = saved.strokeTilingPattern;
          fillColorSpaceType = saved.fillColorSpaceType;
          strokeColorSpaceType = saved.strokeColorSpaceType;
          fillTintSamples = saved.fillTintSamples;
          fillTintNComponents = saved.fillTintNComponents;
          strokeTintSamples = saved.strokeTintSamples;
          strokeTintNComponents = saved.strokeTintNComponents;
          fillAlpha = saved.fillAlpha;
          strokeAlpha = saved.strokeAlpha;
          overprint = saved.overprint;
          blendMode = saved.blendMode;
          lineWidth = saved.lineWidth;
          lineCap = saved.lineCap;
          lineJoin = saved.lineJoin;
          miterLimit = saved.miterLimit;
          dashArray = saved.dashArray;
          dashPhase = saved.dashPhase;
          tc = saved.tc;
          tw = saved.tw;
          tl = saved.tl;
          tz = saved.tz;
          trise = saved.trise;
          textRenderMode = saved.textRenderMode;
          fontSize = saved.fontSize;
          currentFont = saved.currentFont;
          currentFontTag = saved.currentFontTag;
          clipStack = saved.clipStack;
          currentSmask = saved.currentSmask;
          pendingClip = saved.pendingClip;
          pendingClipEvenOdd = saved.pendingClipEvenOdd;
        }
        operandStack.length = 0;
        break;
      case 'cm':
        if (operandStack.length >= 6) {
          const m = operandStack.slice(operandStack.length - 6).map((t) => t.value);
          ctm = matMul(m, ctm);
        }
        operandStack.length = 0;
        break;
      case 'gs':
        if (operandStack.length >= 1 && extGStates) {
          const gsName = String(operandStack[operandStack.length - 1].value).replace(/^\//, '');
          const gs = extGStates.get(gsName);
          if (gs) {
            if (gs.fillAlpha !== undefined) fillAlpha = gs.fillAlpha;
            if (gs.strokeAlpha !== undefined) strokeAlpha = gs.strokeAlpha;
            if (gs.overprint !== undefined) overprint = gs.overprint;
            if (gs.blendMode !== undefined) blendMode = gs.blendMode;
            if (gs.smask !== undefined) {
              // PDF spec §11.6.5.1: SMask transparency group is positioned by the
              // parent CTM at the time the soft mask was set, NOT the form's local
              // matrix alone.  Capture the current CTM so renderSMaskToCanvas can
              // apply it as a base transform.
              currentSmask = gs.smask
                ? { ...gs.smask, parentCtm: ctm.slice() }
                : gs.smask;
            }
          }
        }
        operandStack.length = 0;
        break;

      // XObject
      case 'Do':
        if (operandStack.length >= 1) {
          const name = operandStack[operandStack.length - 1].value;
          /** @type {ImageDrawOp} */
          const doOp = {
            type: 'image', name, ctm: ctm.slice(), fillAlpha, strokeAlpha, fillColor, strokeColor,
          };
          if (fillTilingPattern) doOp.tilingPattern = fillTilingPattern;
          if (overprint) doOp.overprint = true;
          if (blendMode !== 'Normal') doOp.blendMode = blendMode;
          if (clipStack.length > 0) {
            doOp.clips = clipStack.map((c) => {
              const entry = { path: c.path ? c.path.slice() : null, ctm: c.ctm.slice(), evenOdd: c.evenOdd };
              if (c.textClip) entry.textClip = c.textClip;
              return entry;
            });
          }
          if (currentSmask) doOp.smask = currentSmask;
          if (!fillColorExplicit) doOp.fillColorInherited = true;
          if (!strokeColorExplicit) doOp.strokeColorInherited = true;
          ops.push(doOp);
        }
        operandStack.length = 0;
        break;

      // Shading fill
      case 'sh':
        if (operandStack.length >= 1) {
          const shName = operandStack[operandStack.length - 1].value;
          const shading = shadings.get(shName);
          if (shading) {
            /** @type {ShadingDrawOp} */
            const shOp = {
              type: 'shading', shading, ctm: ctm.slice(), fillAlpha,
            };
            if (clipStack.length > 0) {
              shOp.clips = clipStack.map((c) => {
                const entry = { path: c.path ? c.path.slice() : null, ctm: c.ctm.slice(), evenOdd: c.evenOdd };
                if (c.textClip) entry.textClip = c.textClip;
                return entry;
              });
            }
            if (currentSmask) shOp.smask = currentSmask;
            if (blendMode !== 'Normal') shOp.blendMode = blendMode;
            ops.push(shOp);
          }
        }
        operandStack.length = 0;
        break;

      // Text object
      case 'BT':
        skipCorruptedPath = false;
        tm = [1, 0, 0, 1, 0, 0];
        tlm = [1, 0, 0, 1, 0, 0];
        textClipChars = [];
        operandStack.length = 0;
        break;
      case 'ET':
        // Text rendering modes 4-7 accumulate text into the clipping path.
        // At ET, push the accumulated text shapes as a text clip entry.
        if (textClipChars.length > 0) {
          clipStack.push({ textClip: textClipChars.slice(), ctm: [1, 0, 0, 1, 0, 0], evenOdd: false });
          textClipChars = [];
        }
        operandStack.length = 0;
        break;

      // Text state
      case 'Tf': {
        const size = operandStack.length >= 2 ? operandStack[operandStack.length - 1] : null;
        const name = operandStack.length >= 2 ? operandStack[operandStack.length - 2] : null;
        if (name && name.type === 'name' && size && size.type === 'number') {
          currentFont = fonts.get(name.value) || null;
          currentFontTag = name.value;
          fontSize = size.value;
        }
        operandStack.length = 0;
        break;
      }
      case 'Tc':
        if (operandStack.length >= 1) tc = operandStack[operandStack.length - 1].value;
        operandStack.length = 0;
        break;
      case 'Tw':
        if (operandStack.length >= 1) tw = operandStack[operandStack.length - 1].value;
        operandStack.length = 0;
        break;
      case 'Tz':
        if (operandStack.length >= 1) tz = operandStack[operandStack.length - 1].value;
        operandStack.length = 0;
        break;
      case 'Tr':
        if (operandStack.length >= 1) textRenderMode = operandStack[operandStack.length - 1].value;
        operandStack.length = 0;
        break;
      case 'Ts':
        if (operandStack.length >= 1) trise = operandStack[operandStack.length - 1].value;
        operandStack.length = 0;
        break;
      case 'TL':
        if (operandStack.length >= 1) tl = operandStack[operandStack.length - 1].value;
        operandStack.length = 0;
        break;
      case 'Tm':
        if (operandStack.length >= 6) {
          tm = operandStack.slice(operandStack.length - 6).map((t) => t.value);
          tlm = tm.slice();
        }
        operandStack.length = 0;
        break;
      case 'Td': {
        if (operandStack.length >= 2) {
          const tx = operandStack[operandStack.length - 2].value;
          const ty = operandStack[operandStack.length - 1].value;
          tlm = [tlm[0], tlm[1], tlm[2], tlm[3],
            tx * tlm[0] + ty * tlm[2] + tlm[4],
            tx * tlm[1] + ty * tlm[3] + tlm[5]];
          tm = tlm.slice();
        }
        operandStack.length = 0;
        break;
      }
      case 'TD': {
        if (operandStack.length >= 2) {
          const tx = operandStack[operandStack.length - 2].value;
          const ty = operandStack[operandStack.length - 1].value;
          tl = -ty;
          tlm = [tlm[0], tlm[1], tlm[2], tlm[3],
            tx * tlm[0] + ty * tlm[2] + tlm[4],
            tx * tlm[1] + ty * tlm[3] + tlm[5]];
          tm = tlm.slice();
        }
        operandStack.length = 0;
        break;
      }
      case 'T*': {
        const tx = 0;
        const ty = -tl;
        tlm = [tlm[0], tlm[1], tlm[2], tlm[3],
          tx * tlm[0] + ty * tlm[2] + tlm[4],
          tx * tlm[1] + ty * tlm[3] + tlm[5]];
        tm = tlm.slice();
        operandStack.length = 0;
        break;
      }

      // Show string operators
      case 'Tj':
        if (operandStack.length >= 1 && currentFont) {
          showString(operandStack[operandStack.length - 1]);
        }
        operandStack.length = 0;
        break;
      case 'TJ': {
        if (operandStack.length >= 1 && currentFont) {
          const arrTok = operandStack[operandStack.length - 1];
          if (arrTok.type === 'array') {
            for (const elem of arrTok.value) {
              if (elem.type === 'hexstring' || elem.type === 'string') {
                showString(elem);
              } else if (elem.type === 'number') {
                const adjustment = elem.value / 1000 * fontSize * tz / 100;
                tm[4] -= adjustment * tm[0];
                tm[5] -= adjustment * tm[1];
              }
            }
          }
        }
        operandStack.length = 0;
        break;
      }
      case "'": {
        const txP = 0;
        const tyP = -tl;
        tlm = [tlm[0], tlm[1], tlm[2], tlm[3],
          txP * tlm[0] + tyP * tlm[2] + tlm[4],
          txP * tlm[1] + tyP * tlm[3] + tlm[5]];
        tm = tlm.slice();
        if (operandStack.length >= 1 && currentFont) {
          showString(operandStack[operandStack.length - 1]);
        }
        operandStack.length = 0;
        break;
      }
      case '"': {
        if (operandStack.length >= 3) {
          tw = operandStack[operandStack.length - 3].value;
          tc = operandStack[operandStack.length - 2].value;
        }
        const txQ = 0;
        const tyQ = -tl;
        tlm = [tlm[0], tlm[1], tlm[2], tlm[3],
          txQ * tlm[0] + tyQ * tlm[2] + tlm[4],
          txQ * tlm[1] + tyQ * tlm[3] + tlm[5]];
        tm = tlm.slice();
        if (operandStack.length >= 1 && currentFont) {
          showString(operandStack[operandStack.length - 1]);
        }
        operandStack.length = 0;
        break;
      }

      // ── Fill color operators ──────────────────────────────────────
      case 'g':
        fillPatternShading = null;
        fillTilingPattern = null;
        fillColorExplicit = true;
        if (operandStack.length !== 1) pathAnomalyCount++;
        if (operandStack.length >= 1) {
          const gv = Math.round(operandStack[operandStack.length - 1].value * 255);
          fillColor = `rgb(${gv},${gv},${gv})`;
        }
        operandStack.length = 0;
        break;
      case 'rg':
        fillPatternShading = null;
        fillTilingPattern = null;
        fillColorExplicit = true;
        if (operandStack.length !== 3) pathAnomalyCount++;
        if (operandStack.length >= 3) {
          const r = Math.round(operandStack[operandStack.length - 3].value * 255);
          const gv = Math.round(operandStack[operandStack.length - 2].value * 255);
          const b = Math.round(operandStack[operandStack.length - 1].value * 255);
          fillColor = `rgb(${r},${gv},${b})`;
        }
        operandStack.length = 0;
        break;
      case 'k':
        fillPatternShading = null;
        fillTilingPattern = null;
        fillColorExplicit = true;
        if (operandStack.length !== 4) pathAnomalyCount++;
        if (operandStack.length >= 4) {
          const ck = operandStack[operandStack.length - 4].value;
          const mk = operandStack[operandStack.length - 3].value;
          const yk = operandStack[operandStack.length - 2].value;
          const kk = operandStack[operandStack.length - 1].value;
          // Skip obviously corrupt CMYK values (valid range is [0,1])
          if (ck >= -0.1 && ck <= 1.1 && mk >= -0.1 && mk <= 1.1
              && yk >= -0.1 && yk <= 1.1 && kk >= -0.1 && kk <= 1.1) {
            const [rk, gk, bk] = cmykToRgb(ck, mk, yk, kk);
            fillColor = `rgb(${rk},${gk},${bk})`;
          }
        }
        operandStack.length = 0;
        break;

      // ── Stroke color operators ─────────────────────────────────────
      case 'G':
        strokePatternShading = null;
        strokeTilingPattern = null;
        strokeColorExplicit = true;
        if (operandStack.length >= 1) {
          const gv = Math.round(operandStack[operandStack.length - 1].value * 255);
          strokeColor = `rgb(${gv},${gv},${gv})`;
        }
        operandStack.length = 0;
        break;
      case 'RG':
        strokePatternShading = null;
        strokeTilingPattern = null;
        strokeColorExplicit = true;
        if (operandStack.length >= 3) {
          const r = Math.round(operandStack[operandStack.length - 3].value * 255);
          const gv = Math.round(operandStack[operandStack.length - 2].value * 255);
          const b = Math.round(operandStack[operandStack.length - 1].value * 255);
          strokeColor = `rgb(${r},${gv},${b})`;
        }
        operandStack.length = 0;
        break;
      case 'K':
        strokePatternShading = null;
        strokeTilingPattern = null;
        strokeColorExplicit = true;
        if (operandStack.length !== 4) pathAnomalyCount++;
        if (operandStack.length >= 4) {
          const cK = operandStack[operandStack.length - 4].value;
          const mK = operandStack[operandStack.length - 3].value;
          const yK = operandStack[operandStack.length - 2].value;
          const kK = operandStack[operandStack.length - 1].value;
          if (cK >= -0.1 && cK <= 1.1 && mK >= -0.1 && mK <= 1.1
              && yK >= -0.1 && yK <= 1.1 && kK >= -0.1 && kK <= 1.1) {
            const [rK, gK, bK] = cmykToRgb(cK, mK, yK, kK);
            strokeColor = `rgb(${rK},${gK},${bK})`;
          }
        }
        operandStack.length = 0;
        break;

      // ── General color space operators ──────────────────────────────
      case 'cs': {
        // Track fill color space type and tint samples for Separation handling
        const csName = operandStack.length >= 1 ? operandStack[operandStack.length - 1].value : '';
        const csInfo = colorSpaces.get(csName);
        fillColorSpaceType = csInfo ? csInfo.type : csName;
        fillTintSamples = csInfo ? csInfo.tintSamples : null;
        fillTintNComponents = csInfo ? csInfo.nComponents : 3;
        fillDeviceNGrid = csInfo ? csInfo.deviceNGrid : null;
        fillIndexedInfo = csInfo ? csInfo.indexedInfo : null;
        operandStack.length = 0;
        break;
      }
      case 'CS': {
        const csNameS = operandStack.length >= 1 ? operandStack[operandStack.length - 1].value : '';
        const csInfoS = colorSpaces.get(csNameS);
        strokeColorSpaceType = csInfoS ? csInfoS.type : csNameS;
        strokeTintSamples = csInfoS ? csInfoS.tintSamples : null;
        strokeTintNComponents = csInfoS ? csInfoS.nComponents : 3;
        strokeIndexedInfo = csInfoS ? csInfoS.indexedInfo : null;
        strokePatternShading = null;
        strokeTilingPattern = null;
        operandStack.length = 0;
        break;
      }
      case 'sc': case 'scn': {
        fillColorExplicit = true;
        if (operandStack.length >= 1) {
          // Pattern color space: last operand is a pattern name (string), not a number
          if (fillColorSpaceType === 'Pattern') {
            const patName = operandStack[operandStack.length - 1].value;
            const patInfo = typeof patName === 'string' && patterns.get(patName);
            if (patInfo) {
              fillColor = patInfo.color;
              fillPatternShading = patInfo.shading || null;
              fillTilingPattern = patInfo.tiling
                ? { patName, ...patInfo.tiling }
                : null;
            }
            operandStack.length = 0;
            break;
          }
          fillPatternShading = null;
          fillTilingPattern = null;
          const vals = operandStack.map((t) => t.value);
          // Multi-component DeviceN: evaluate the pre-computed RGB grid via interpolation
          if (fillDeviceNGrid && vals.length === fillDeviceNGrid.nInputs) {
            const grid = fillDeviceNGrid;
            const rgb = grid.rgbSamples;
            const nc = grid.nComponents; // RGB components per sample (3)
            if (grid.nInputs === 2) {
              // Bilinear interpolation on a 2D grid
              const s0 = grid.sizes[0];
              const s1 = grid.sizes[1];
              const fx = vals[0] * (s0 - 1);
              const fy = vals[1] * (s1 - 1);
              const x0 = Math.min(Math.floor(fx), s0 - 1);
              const y0 = Math.min(Math.floor(fy), s1 - 1);
              const x1 = Math.min(x0 + 1, s0 - 1);
              const y1 = Math.min(y0 + 1, s1 - 1);
              const dx = fx - x0;
              const dy = fy - y0;
              const i00 = (y0 * s0 + x0) * nc;
              const i10 = (y0 * s0 + x1) * nc;
              const i01 = (y1 * s0 + x0) * nc;
              const i11 = (y1 * s0 + x1) * nc;
              const r = Math.round((rgb[i00] * (1 - dx) + rgb[i10] * dx) * (1 - dy) + (rgb[i01] * (1 - dx) + rgb[i11] * dx) * dy);
              const g = Math.round((rgb[i00 + 1] * (1 - dx) + rgb[i10 + 1] * dx) * (1 - dy) + (rgb[i01 + 1] * (1 - dx) + rgb[i11 + 1] * dx) * dy);
              const b = Math.round((rgb[i00 + 2] * (1 - dx) + rgb[i10 + 2] * dx) * (1 - dy) + (rgb[i01 + 2] * (1 - dx) + rgb[i11 + 2] * dx) * dy);
              fillColor = `rgb(${r},${g},${b})`;
            } else {
              // For higher-dimensional DeviceN, use nearest-neighbor lookup
              // PDF spec: first input dimension varies fastest in the sample array
              let flatIdx = 0;
              let stride = 1;
              for (let d = 0; d < grid.nInputs; d++) {
                const si = Math.min(Math.round(vals[d] * (grid.sizes[d] - 1)), grid.sizes[d] - 1);
                flatIdx += si * stride;
                stride *= grid.sizes[d];
              }
              const ri = flatIdx * nc;
              fillColor = `rgb(${rgb[ri]},${rgb[ri + 1]},${rgb[ri + 2]})`;
            }
            operandStack.length = 0;
            break;
          }
          if (vals.length === 1 && fillColorSpaceType === 'Indexed' && fillIndexedInfo) {
            const idx = Math.max(0, Math.min(fillIndexedInfo.hival, Math.round(vals[0])));
            const base = fillIndexedInfo.base;
            const nComp = base === 'DeviceCMYK' ? 4 : (base === 'DeviceGray' || base === 'CalGray' ? 1 : 3);
            const po = idx * nComp;
            const pal = fillIndexedInfo.palette;
            if (nComp === 3) {
              fillColor = `rgb(${pal[po]},${pal[po + 1]},${pal[po + 2]})`;
            } else if (nComp === 1) {
              fillColor = `rgb(${pal[po]},${pal[po]},${pal[po]})`;
            } else if (nComp === 4) {
              const [ri, gi, bi] = cmykToRgb(pal[po] / 255, pal[po + 1] / 255, pal[po + 2] / 255, pal[po + 3] / 255);
              fillColor = `rgb(${ri},${gi},${bi})`;
            }
            operandStack.length = 0;
            break;
          }
          if (vals.length === 1) {
            if (fillColorSpaceType === 'Separation' && fillTintSamples && fillTintSamples.length >= fillTintNComponents) {
              // Evaluate sampled tint function with linear interpolation: tint 0=no ink, 1=full ink
              const nSamples = Math.floor(fillTintSamples.length / fillTintNComponents);
              const fi = Math.min(vals[0] * (nSamples - 1), nSamples - 1);
              const i0 = Math.min(Math.floor(fi), nSamples - 1);
              const i1 = Math.min(i0 + 1, nSamples - 1);
              const frac = fi - i0;
              if (fillTintNComponents >= 3) {
                const r = Math.round(fillTintSamples[i0 * 3] * (1 - frac) + fillTintSamples[i1 * 3] * frac);
                const g = Math.round(fillTintSamples[i0 * 3 + 1] * (1 - frac) + fillTintSamples[i1 * 3 + 1] * frac);
                const b = Math.round(fillTintSamples[i0 * 3 + 2] * (1 - frac) + fillTintSamples[i1 * 3 + 2] * frac);
                fillColor = `rgb(${r},${g},${b})`;
              } else {
                const v = Math.round(fillTintSamples[i0] * (1 - frac) + fillTintSamples[i1] * frac);
                fillColor = `rgb(${v},${v},${v})`;
              }
            } else if (fillColorSpaceType === 'Separation') {
              // No tint samples — simple inversion
              const gv = Math.round(255 * (1 - vals[0]));
              fillColor = `rgb(${gv},${gv},${gv})`;
            } else {
              const gv = Math.round(vals[0] * 255);
              fillColor = `rgb(${gv},${gv},${gv})`;
            }
          } else if (vals.length === 3) {
            if (fillColorSpaceType === 'Lab') {
              const fy = (vals[0] + 16) / 116;
              const fx = fy + vals[1] / 500;
              const fz = fy - vals[2] / 200;
              const delta = 6 / 29;
              const fInv = (ft) => (ft > delta ? ft * ft * ft : 3 * delta * delta * (ft - 4 / 29));
              // Use D65 white point (sRGB) directly instead of Lab's WhitePoint,
              // which performs XYZ scaling chromatic adaptation from Lab WP to D65.
              const X = 0.9505 * fInv(fx);
              const Y = fInv(fy);
              const Z = 1.089 * fInv(fz);
              const lr = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
              const lg = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
              const lb = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;
              const gammaEnc = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
              fillColor = `rgb(${Math.round(255 * Math.max(0, Math.min(1, gammaEnc(lr))))},${Math.round(255 * Math.max(0, Math.min(1, gammaEnc(lg))))},${Math.round(255 * Math.max(0, Math.min(1, gammaEnc(lb))))})`;
            } else {
              fillColor = `rgb(${Math.round(vals[0] * 255)},${Math.round(vals[1] * 255)},${Math.round(vals[2] * 255)})`;
            }
          } else if (vals.length === 4) {
            const [rf, gf, bf] = cmykToRgb(vals[0], vals[1], vals[2], vals[3]);
            fillColor = `rgb(${rf},${gf},${bf})`;
          }
        }
        operandStack.length = 0;
        break;
      }
      case 'SC': case 'SCN': {
        strokeColorExplicit = true;
        if (operandStack.length >= 1) {
          if (strokeColorSpaceType === 'Pattern') {
            const patName = operandStack[operandStack.length - 1].value;
            const patInfo = typeof patName === 'string' && patterns.get(patName);
            if (patInfo) {
              strokeColor = patInfo.color;
              strokePatternShading = patInfo.shading || null;
              strokeTilingPattern = patInfo.tiling
                ? { patName, ...patInfo.tiling }
                : null;
            }
            operandStack.length = 0;
            break;
          }
          strokePatternShading = null;
          strokeTilingPattern = null;
          const vals = operandStack.map((t) => t.value);
          if (vals.length === 1 && strokeColorSpaceType === 'Indexed' && strokeIndexedInfo) {
            const idx = Math.max(0, Math.min(strokeIndexedInfo.hival, Math.round(vals[0])));
            const base = strokeIndexedInfo.base;
            const nComp = base === 'DeviceCMYK' ? 4 : (base === 'DeviceGray' || base === 'CalGray' ? 1 : 3);
            const po = idx * nComp;
            const pal = strokeIndexedInfo.palette;
            if (nComp === 3) {
              strokeColor = `rgb(${pal[po]},${pal[po + 1]},${pal[po + 2]})`;
            } else if (nComp === 1) {
              strokeColor = `rgb(${pal[po]},${pal[po]},${pal[po]})`;
            } else if (nComp === 4) {
              const [ri, gi, bi] = cmykToRgb(pal[po] / 255, pal[po + 1] / 255, pal[po + 2] / 255, pal[po + 3] / 255);
              strokeColor = `rgb(${ri},${gi},${bi})`;
            }
            operandStack.length = 0;
            break;
          }
          if (vals.length === 1) {
            if (strokeColorSpaceType === 'Separation' && strokeTintSamples && strokeTintSamples.length >= strokeTintNComponents) {
              // Evaluate sampled tint function with linear interpolation
              const nSamples = Math.floor(strokeTintSamples.length / strokeTintNComponents);
              const fi = Math.min(vals[0] * (nSamples - 1), nSamples - 1);
              const i0 = Math.min(Math.floor(fi), nSamples - 1);
              const i1 = Math.min(i0 + 1, nSamples - 1);
              const frac = fi - i0;
              if (strokeTintNComponents >= 3) {
                const r = Math.round(strokeTintSamples[i0 * 3] * (1 - frac) + strokeTintSamples[i1 * 3] * frac);
                const g = Math.round(strokeTintSamples[i0 * 3 + 1] * (1 - frac) + strokeTintSamples[i1 * 3 + 1] * frac);
                const b = Math.round(strokeTintSamples[i0 * 3 + 2] * (1 - frac) + strokeTintSamples[i1 * 3 + 2] * frac);
                strokeColor = `rgb(${r},${g},${b})`;
              } else {
                const v = Math.round(strokeTintSamples[i0] * (1 - frac) + strokeTintSamples[i1] * frac);
                strokeColor = `rgb(${v},${v},${v})`;
              }
            } else if (strokeColorSpaceType === 'Separation') {
              const gv = Math.round(255 * (1 - vals[0]));
              strokeColor = `rgb(${gv},${gv},${gv})`;
            } else {
              const gv = Math.round(vals[0] * 255);
              strokeColor = `rgb(${gv},${gv},${gv})`;
            }
          } else if (vals.length === 3) {
            if (strokeColorSpaceType === 'Lab') {
              const fy = (vals[0] + 16) / 116;
              const fx = fy + vals[1] / 500;
              const fz = fy - vals[2] / 200;
              const delta = 6 / 29;
              const fInv = (ft) => (ft > delta ? ft * ft * ft : 3 * delta * delta * (ft - 4 / 29));
              // Use D65 white point (sRGB) directly for chromatic adaptation
              const X = 0.9505 * fInv(fx);
              const Y = fInv(fy);
              const Z = 1.089 * fInv(fz);
              const lr = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
              const lg = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
              const lb = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;
              const gammaEnc = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
              strokeColor = `rgb(${Math.round(255 * Math.max(0, Math.min(1, gammaEnc(lr))))},${Math.round(255 * Math.max(0, Math.min(1, gammaEnc(lg))))},${Math.round(255 * Math.max(0, Math.min(1, gammaEnc(lb))))})`;
            } else {
              strokeColor = `rgb(${Math.round(vals[0] * 255)},${Math.round(vals[1] * 255)},${Math.round(vals[2] * 255)})`;
            }
          } else if (vals.length === 4) {
            const [rs, gs, bs] = cmykToRgb(vals[0], vals[1], vals[2], vals[3]);
            strokeColor = `rgb(${rs},${gs},${bs})`;
          }
        }
        operandStack.length = 0;
        break;
      }

      // ── Line style operators ───────────────────────────────────────
      case 'w': // line width
        if (operandStack.length >= 1) lineWidth = operandStack[operandStack.length - 1].value;
        operandStack.length = 0;
        break;
      case 'J': // line cap
        if (operandStack.length >= 1) lineCap = operandStack[operandStack.length - 1].value;
        operandStack.length = 0;
        break;
      case 'j': // line join
        if (operandStack.length >= 1) lineJoin = operandStack[operandStack.length - 1].value;
        operandStack.length = 0;
        break;
      case 'M': // miter limit (uppercase, distinct from 'm' moveto)
        if (operandStack.length >= 1) miterLimit = operandStack[operandStack.length - 1].value;
        operandStack.length = 0;
        break;
      case 'd': // dash pattern: [array] phase d
        if (operandStack.length >= 2) {
          const phase = operandStack[operandStack.length - 1];
          const arr = operandStack[operandStack.length - 2];
          dashPhase = phase.value;
          dashArray = arr.type === 'array' ? arr.value.map((v) => v.value) : [];
        }
        operandStack.length = 0;
        break;

      // ── Path construction operators ────────────────────────────────
      case 'm': { // moveto
        if (skipCorruptedPath) { operandStack.length = 0; break; }
        if (operandStack.length !== 2) pathAnomalyCount++;
        if (operandStack.length >= 2) {
          if (operandStack.length > 2) { currentPath = []; operandStack.length = 0; break; }
          const mx = operandStack[operandStack.length - 2].value;
          const my = operandStack[operandStack.length - 1].value;
          const mpx = ctm[0] * mx + ctm[2] * my + ctm[4];
          const mpy = ctm[1] * mx + ctm[3] * my + ctm[5];
          if (Math.abs(mpx) < 32768 && Math.abs(mpy) < 32768) {
            pathAnomalyCount = Math.max(0, pathAnomalyCount - 1);
            curX = mx;
            curY = my;
            pathStartX = curX;
            pathStartY = curY;
            currentPath.push({ type: 'M', x: curX, y: curY });
          } else {
            pathAnomalyCount++;
          }
        }
        operandStack.length = 0;
        break;
      }
      case 'l': { // lineto
        if (skipCorruptedPath) { operandStack.length = 0; break; }
        if (operandStack.length !== 2) pathAnomalyCount++;
        if (operandStack.length >= 2) {
          if (operandStack.length > 2) { pathAnomalyCount++; currentPath = []; operandStack.length = 0; break; }
          const lx = operandStack[operandStack.length - 2].value;
          const ly = operandStack[operandStack.length - 1].value;
          const pageX = ctm[0] * lx + ctm[2] * ly + ctm[4];
          const pageY = ctm[1] * lx + ctm[3] * ly + ctm[5];
          if (Math.abs(pageX) < 32768 && Math.abs(pageY) < 32768) {
            pathAnomalyCount = Math.max(0, pathAnomalyCount - 1);
            curX = lx;
            curY = ly;
            currentPath.push({ type: 'L', x: curX, y: curY });
          } else {
            pathAnomalyCount++;
          }
        }
        operandStack.length = 0;
        break;
      }
      case 'c': { // curveto (x1 y1 x2 y2 x3 y3)
        if (skipCorruptedPath) { operandStack.length = 0; break; }
        if (operandStack.length !== 6) pathAnomalyCount++;
        if (operandStack.length >= 6) {
          if (operandStack.length > 6) { currentPath = []; operandStack.length = 0; break; }
          const x1 = operandStack[operandStack.length - 6].value;
          const y1 = operandStack[operandStack.length - 5].value;
          const x2 = operandStack[operandStack.length - 4].value;
          const y2 = operandStack[operandStack.length - 3].value;
          const x3 = operandStack[operandStack.length - 2].value;
          const y3 = operandStack[operandStack.length - 1].value;
          const cp1x = ctm[0] * x1 + ctm[2] * y1 + ctm[4];
          const cp1y = ctm[1] * x1 + ctm[3] * y1 + ctm[5];
          const cp2x = ctm[0] * x2 + ctm[2] * y2 + ctm[4];
          const cp2y = ctm[1] * x2 + ctm[3] * y2 + ctm[5];
          const cp3x = ctm[0] * x3 + ctm[2] * y3 + ctm[4];
          const cp3y = ctm[1] * x3 + ctm[3] * y3 + ctm[5];
          if (Math.abs(cp1x) < 32768 && Math.abs(cp1y) < 32768
              && Math.abs(cp2x) < 32768 && Math.abs(cp2y) < 32768
              && Math.abs(cp3x) < 32768 && Math.abs(cp3y) < 32768) {
            pathAnomalyCount = Math.max(0, pathAnomalyCount - 1);
            curX = x3;
            curY = y3;
            currentPath.push({
              type: 'C', x1, y1, x2, y2, x: curX, y: curY,
            });
          } else {
            pathAnomalyCount++;
          }
        }
        operandStack.length = 0;
        break;
      }
      case 'v': { // curveto: cp1 = current point
        if (skipCorruptedPath) { operandStack.length = 0; break; }
        if (operandStack.length !== 4) pathAnomalyCount++;
        if (operandStack.length >= 4) {
          if (operandStack.length > 4) { currentPath = []; operandStack.length = 0; break; }
          const x2 = operandStack[operandStack.length - 4].value;
          const y2 = operandStack[operandStack.length - 3].value;
          const x3 = operandStack[operandStack.length - 2].value;
          const y3 = operandStack[operandStack.length - 1].value;
          const vp2x = ctm[0] * x2 + ctm[2] * y2 + ctm[4];
          const vp2y = ctm[1] * x2 + ctm[3] * y2 + ctm[5];
          const vp3x = ctm[0] * x3 + ctm[2] * y3 + ctm[4];
          const vp3y = ctm[1] * x3 + ctm[3] * y3 + ctm[5];
          if (Math.abs(vp2x) < 32768 && Math.abs(vp2y) < 32768
              && Math.abs(vp3x) < 32768 && Math.abs(vp3y) < 32768) {
            pathAnomalyCount = Math.max(0, pathAnomalyCount - 1);
            currentPath.push({
              type: 'C', x1: curX, y1: curY, x2, y2, x: x3, y: y3,
            });
            curX = x3; curY = y3;
          } else {
            pathAnomalyCount++;
          }
        }
        operandStack.length = 0;
        break;
      }
      case 'y': { // curveto: cp2 = endpoint
        if (skipCorruptedPath) { operandStack.length = 0; break; }
        if (operandStack.length !== 4) pathAnomalyCount++;
        if (operandStack.length >= 4) {
          if (operandStack.length > 4) { currentPath = []; operandStack.length = 0; break; }
          const x1 = operandStack[operandStack.length - 4].value;
          const y1 = operandStack[operandStack.length - 3].value;
          const yx = operandStack[operandStack.length - 2].value;
          const yy = operandStack[operandStack.length - 1].value;
          const yp1x = ctm[0] * x1 + ctm[2] * y1 + ctm[4];
          const yp1y = ctm[1] * x1 + ctm[3] * y1 + ctm[5];
          const yp2x = ctm[0] * yx + ctm[2] * yy + ctm[4];
          const yp2y = ctm[1] * yx + ctm[3] * yy + ctm[5];
          if (Math.abs(yp1x) < 32768 && Math.abs(yp1y) < 32768
              && Math.abs(yp2x) < 32768 && Math.abs(yp2y) < 32768) {
            pathAnomalyCount = Math.max(0, pathAnomalyCount - 1);
            curX = yx;
            curY = yy;
            currentPath.push({
              type: 'C', x1, y1, x2: curX, y2: curY, x: curX, y: curY,
            });
          } else {
            pathAnomalyCount++;
          }
        }
        operandStack.length = 0;
        break;
      }
      case 'h': // closepath
        if (skipCorruptedPath) { operandStack.length = 0; break; }
        currentPath.push({ type: 'Z' });
        curX = pathStartX;
        curY = pathStartY;
        operandStack.length = 0;
        break;
      case 're': { // rectangle (x y w h)
        if (skipCorruptedPath) { operandStack.length = 0; break; }
        if (operandStack.length !== 4) pathAnomalyCount++;
        if (operandStack.length >= 4) {
          if (operandStack.length > 4) { currentPath = []; operandStack.length = 0; break; }
          const rx = operandStack[operandStack.length - 4].value;
          const ry = operandStack[operandStack.length - 3].value;
          const rw = operandStack[operandStack.length - 2].value;
          const rh = operandStack[operandStack.length - 1].value;
          const rpx = ctm[0] * rx + ctm[2] * ry + ctm[4];
          const rpy = ctm[1] * rx + ctm[3] * ry + ctm[5];
          const rpx2 = ctm[0] * (rx + rw) + ctm[2] * (ry + rh) + ctm[4];
          const rpy2 = ctm[1] * (rx + rw) + ctm[3] * (ry + rh) + ctm[5];
          if (Math.abs(rpx) < 32768 && Math.abs(rpy) < 32768
              && Math.abs(rpx2) < 32768 && Math.abs(rpy2) < 32768) {
            pathAnomalyCount = Math.max(0, pathAnomalyCount - 1);
            currentPath.push({ type: 'M', x: rx, y: ry });
            currentPath.push({ type: 'L', x: rx + rw, y: ry });
            currentPath.push({ type: 'L', x: rx + rw, y: ry + rh });
            currentPath.push({ type: 'L', x: rx, y: ry + rh });
            currentPath.push({ type: 'Z' });
            curX = rx; curY = ry;
            pathStartX = rx; pathStartY = ry;
          } else {
            pathAnomalyCount++;
          }
        }
        operandStack.length = 0;
        break;
      }

      // ── Path painting operators ────────────────────────────────────
      case 'S': // stroke
        if (operandStack.length > 0) pathAnomalyCount++;
        if (pendingClip && currentPath.length > 0) {
          clipStack.push({ path: currentPath.slice(), ctm: ctm.slice(), evenOdd: pendingClipEvenOdd });
        }
        pendingClip = false;
        pendingClipEvenOdd = false;
        if (currentPath.length > 0) {
          /** @type {PathDrawOp} */
          const pathOpS = {
            type: 'path',
            commands: currentPath,
            ctm: ctm.slice(),
            fill: false,
            stroke: true,
            evenOdd: false,
            fillColor,
            strokeColor,
            lineWidth,
            lineCap,
            lineJoin,
            miterLimit,
            dashArray: dashArray.length > 0 ? dashArray.slice() : dashArray,
            dashPhase,
            fillAlpha,
            strokeAlpha,
          };
          if (currentSmask) pathOpS.smask = currentSmask;
          if (blendMode !== 'Normal') pathOpS.blendMode = blendMode;
          if (strokePatternShading) pathOpS.strokePatternShading = strokePatternShading;
          if (strokeTilingPattern) pathOpS.strokeTilingPattern = strokeTilingPattern;
          if (!strokeColorExplicit) pathOpS.strokeColorInherited = true;
          ops.push(pathOpS);
        }
        currentPath = [];
        operandStack.length = 0;
        break;
      case 's': // close + stroke
        if (operandStack.length > 0) pathAnomalyCount++;
        currentPath.push({ type: 'Z' });
        if (pendingClip && currentPath.length > 0) {
          clipStack.push({ path: currentPath.slice(), ctm: ctm.slice(), evenOdd: pendingClipEvenOdd });
        }
        pendingClip = false;
        pendingClipEvenOdd = false;
        if (currentPath.length > 0) {
          /** @type {PathDrawOp} */
          const pathOps2 = {
            type: 'path',
            commands: currentPath,
            ctm: ctm.slice(),
            fill: false,
            stroke: true,
            evenOdd: false,
            fillColor,
            strokeColor,
            lineWidth,
            lineCap,
            lineJoin,
            miterLimit,
            dashArray: dashArray.length > 0 ? dashArray.slice() : dashArray,
            dashPhase,
            fillAlpha,
            strokeAlpha,
          };
          if (currentSmask) pathOps2.smask = currentSmask;
          if (blendMode !== 'Normal') pathOps2.blendMode = blendMode;
          if (strokePatternShading) pathOps2.strokePatternShading = strokePatternShading;
          if (strokeTilingPattern) pathOps2.strokeTilingPattern = strokeTilingPattern;
          if (!strokeColorExplicit) pathOps2.strokeColorInherited = true;
          ops.push(pathOps2);
        }
        currentPath = [];
        operandStack.length = 0;
        break;
      case 'f': case 'F': // fill (non-zero winding)
        if (operandStack.length > 0) pathAnomalyCount++;
        if (pathAnomalyCount >= 5) { streamCorrupted = true; currentPath = []; operandStack.length = 0; break; }
        // Per PDF spec §4.4.3, W/W* before a paint operator establishes the clip
        if (pendingClip && currentPath.length > 0) {
          clipStack.push({ path: currentPath.slice(), ctm: ctm.slice(), evenOdd: pendingClipEvenOdd });
        }
        pendingClip = false;
        pendingClipEvenOdd = false;
        if (currentPath.length > 0) {
          /** @type {PathDrawOp} */
          const pathOpF = {
            type: 'path',
            commands: currentPath,
            ctm: ctm.slice(),
            fill: true,
            stroke: false,
            evenOdd: false,
            fillColor,
            strokeColor,
            lineWidth,
            lineCap,
            lineJoin,
            miterLimit,
            dashArray: dashArray.length > 0 ? dashArray.slice() : dashArray,
            dashPhase,
            fillAlpha,
            strokeAlpha,
          };
          if (currentSmask) pathOpF.smask = currentSmask;
          if (blendMode !== 'Normal') pathOpF.blendMode = blendMode;
          if (fillPatternShading) pathOpF.patternShading = fillPatternShading;
          if (fillTilingPattern) pathOpF.tilingPattern = fillTilingPattern;
          if (!fillColorExplicit) pathOpF.fillColorInherited = true;
          ops.push(pathOpF);
        }
        currentPath = [];
        operandStack.length = 0;
        break;
      case 'f*': // fill (even-odd)
        if (operandStack.length > 0) pathAnomalyCount++;
        if (pendingClip && currentPath.length > 0) {
          clipStack.push({ path: currentPath.slice(), ctm: ctm.slice(), evenOdd: pendingClipEvenOdd });
        }
        pendingClip = false;
        pendingClipEvenOdd = false;
        if (currentPath.length > 0) {
          /** @type {PathDrawOp} */
          const pathOpFS = {
            type: 'path',
            commands: currentPath,
            ctm: ctm.slice(),
            fill: true,
            stroke: false,
            evenOdd: true,
            fillColor,
            strokeColor,
            lineWidth,
            lineCap,
            lineJoin,
            miterLimit,
            dashArray: dashArray.length > 0 ? dashArray.slice() : dashArray,
            dashPhase,
            fillAlpha,
            strokeAlpha,
          };
          if (currentSmask) pathOpFS.smask = currentSmask;
          if (blendMode !== 'Normal') pathOpFS.blendMode = blendMode;
          if (fillPatternShading) pathOpFS.patternShading = fillPatternShading;
          if (fillTilingPattern) pathOpFS.tilingPattern = fillTilingPattern;
          if (!fillColorExplicit) pathOpFS.fillColorInherited = true;
          ops.push(pathOpFS);
        }
        currentPath = [];
        operandStack.length = 0;
        break;
      case 'B': // fill + stroke (non-zero)
        if (operandStack.length > 0) pathAnomalyCount++;
        if (pendingClip && currentPath.length > 0) {
          clipStack.push({ path: currentPath.slice(), ctm: ctm.slice(), evenOdd: pendingClipEvenOdd });
        }
        pendingClip = false;
        pendingClipEvenOdd = false;
        if (currentPath.length > 0) {
          /** @type {PathDrawOp} */
          const pathOpB = {
            type: 'path',
            commands: currentPath,
            ctm: ctm.slice(),
            fill: true,
            stroke: true,
            evenOdd: false,
            fillColor,
            strokeColor,
            lineWidth,
            lineCap,
            lineJoin,
            miterLimit,
            dashArray: dashArray.length > 0 ? dashArray.slice() : dashArray,
            dashPhase,
            fillAlpha,
            strokeAlpha,
          };
          if (currentSmask) pathOpB.smask = currentSmask;
          if (blendMode !== 'Normal') pathOpB.blendMode = blendMode;
          if (fillPatternShading) pathOpB.patternShading = fillPatternShading;
          if (fillTilingPattern) pathOpB.tilingPattern = fillTilingPattern;
          if (strokePatternShading) pathOpB.strokePatternShading = strokePatternShading;
          if (strokeTilingPattern) pathOpB.strokeTilingPattern = strokeTilingPattern;
          if (!fillColorExplicit) pathOpB.fillColorInherited = true;
          if (!strokeColorExplicit) pathOpB.strokeColorInherited = true;
          ops.push(pathOpB);
        }
        currentPath = [];
        operandStack.length = 0;
        break;
      case 'B*': // fill + stroke (even-odd)
        if (operandStack.length > 0) pathAnomalyCount++;
        if (pendingClip && currentPath.length > 0) {
          clipStack.push({ path: currentPath.slice(), ctm: ctm.slice(), evenOdd: pendingClipEvenOdd });
        }
        pendingClip = false;
        pendingClipEvenOdd = false;
        if (currentPath.length > 0) {
          /** @type {PathDrawOp} */
          const pathOpBS = {
            type: 'path',
            commands: currentPath,
            ctm: ctm.slice(),
            fill: true,
            stroke: true,
            evenOdd: true,
            fillColor,
            strokeColor,
            lineWidth,
            lineCap,
            lineJoin,
            miterLimit,
            dashArray: dashArray.length > 0 ? dashArray.slice() : dashArray,
            dashPhase,
            fillAlpha,
            strokeAlpha,
          };
          if (currentSmask) pathOpBS.smask = currentSmask;
          if (blendMode !== 'Normal') pathOpBS.blendMode = blendMode;
          if (fillPatternShading) pathOpBS.patternShading = fillPatternShading;
          if (fillTilingPattern) pathOpBS.tilingPattern = fillTilingPattern;
          if (strokePatternShading) pathOpBS.strokePatternShading = strokePatternShading;
          if (strokeTilingPattern) pathOpBS.strokeTilingPattern = strokeTilingPattern;
          if (!fillColorExplicit) pathOpBS.fillColorInherited = true;
          if (!strokeColorExplicit) pathOpBS.strokeColorInherited = true;
          ops.push(pathOpBS);
        }
        currentPath = [];
        operandStack.length = 0;
        break;
      case 'b': // close + fill + stroke (non-zero)
        if (operandStack.length > 0) pathAnomalyCount++;
        currentPath.push({ type: 'Z' });
        if (pendingClip && currentPath.length > 0) {
          clipStack.push({ path: currentPath.slice(), ctm: ctm.slice(), evenOdd: pendingClipEvenOdd });
        }
        pendingClip = false;
        pendingClipEvenOdd = false;
        if (currentPath.length > 0) {
          /** @type {PathDrawOp} */
          const pathOpb = {
            type: 'path',
            commands: currentPath,
            ctm: ctm.slice(),
            fill: true,
            stroke: true,
            evenOdd: false,
            fillColor,
            strokeColor,
            lineWidth,
            lineCap,
            lineJoin,
            miterLimit,
            dashArray: dashArray.length > 0 ? dashArray.slice() : dashArray,
            dashPhase,
            fillAlpha,
            strokeAlpha,
          };
          if (currentSmask) pathOpb.smask = currentSmask;
          if (blendMode !== 'Normal') pathOpb.blendMode = blendMode;
          if (fillPatternShading) pathOpb.patternShading = fillPatternShading;
          if (fillTilingPattern) pathOpb.tilingPattern = fillTilingPattern;
          if (strokePatternShading) pathOpb.strokePatternShading = strokePatternShading;
          if (strokeTilingPattern) pathOpb.strokeTilingPattern = strokeTilingPattern;
          if (!fillColorExplicit) pathOpb.fillColorInherited = true;
          if (!strokeColorExplicit) pathOpb.strokeColorInherited = true;
          ops.push(pathOpb);
        }
        currentPath = [];
        operandStack.length = 0;
        break;
      case 'b*': // close + fill + stroke (even-odd)
        if (operandStack.length > 0) pathAnomalyCount++;
        currentPath.push({ type: 'Z' });
        if (pendingClip && currentPath.length > 0) {
          clipStack.push({ path: currentPath.slice(), ctm: ctm.slice(), evenOdd: pendingClipEvenOdd });
        }
        pendingClip = false;
        pendingClipEvenOdd = false;
        if (currentPath.length > 0) {
          /** @type {PathDrawOp} */
          const pathOpbS = {
            type: 'path',
            commands: currentPath,
            ctm: ctm.slice(),
            fill: true,
            stroke: true,
            evenOdd: true,
            fillColor,
            strokeColor,
            lineWidth,
            lineCap,
            lineJoin,
            miterLimit,
            dashArray: dashArray.length > 0 ? dashArray.slice() : dashArray,
            dashPhase,
            fillAlpha,
            strokeAlpha,
          };
          if (currentSmask) pathOpbS.smask = currentSmask;
          if (blendMode !== 'Normal') pathOpbS.blendMode = blendMode;
          if (fillPatternShading) pathOpbS.patternShading = fillPatternShading;
          if (fillTilingPattern) pathOpbS.tilingPattern = fillTilingPattern;
          if (strokePatternShading) pathOpbS.strokePatternShading = strokePatternShading;
          if (strokeTilingPattern) pathOpbS.strokeTilingPattern = strokeTilingPattern;
          if (!fillColorExplicit) pathOpbS.fillColorInherited = true;
          if (!strokeColorExplicit) pathOpbS.strokeColorInherited = true;
          ops.push(pathOpbS);
        }
        currentPath = [];
        operandStack.length = 0;
        break;
      case 'n': // end path (no paint — used for clipping)
        if (operandStack.length > 0) pathAnomalyCount++;
        if (pendingClip && currentPath.length > 0) {
          clipStack.push({ path: currentPath.slice(), ctm: ctm.slice(), evenOdd: pendingClipEvenOdd });
        }
        pendingClip = false;
        pendingClipEvenOdd = false;
        currentPath = [];
        operandStack.length = 0;
        break;
      case 'W': case 'W*': // clipping (path stays for next paint/n)
        pendingClip = true;
        pendingClipEvenOdd = (tok.value === 'W*');
        operandStack.length = 0;
        break;

      default:
        operandStack.length = 0;
        break;
    }

    // Attach active clip path to any ops pushed during this operator.
    // The clip from W/W* applies to all subsequent drawing operations until Q restores state.
    if (clipStack.length > 0) {
      for (let j = opsLenBeforeOp; j < ops.length; j++) {
        if (!ops[j].clips) {
          ops[j].clips = clipStack.map((c) => {
            const entry = { path: c.path ? c.path.slice() : null, ctm: c.ctm.slice(), evenOdd: c.evenOdd };
            if (c.textClip) entry.textClip = c.textClip;
            return entry;
          });
        }
      }
    }

    // Attach pattern fill info to text ops (tiling patterns and shading patterns for text fills).
    if (fillPatternShading || fillTilingPattern) {
      for (let j = opsLenBeforeOp; j < ops.length; j++) {
        if (ops[j].type === 'type0text') {
          if (fillPatternShading) ops[j].patternShading = fillPatternShading;
          if (fillTilingPattern) ops[j].tilingPattern = fillTilingPattern;
        }
      }
    }

    // Accumulate text for clipping when Tr mode is 4-7
    if (textRenderMode >= 4) {
      for (let j = opsLenBeforeOp; j < ops.length; j++) {
        const op = ops[j];
        if (op.type === 'type0text' && op.fontFamily && op.text) {
          textClipChars.push({
            text: op.text,
            fontFamily: op.fontFamily,
            fontSize: op.fontSize,
            a: op.a,
            b: op.b,
            c: op.c,
            d: op.d,
            x: op.x,
            y: op.y,
          });
        }
      }
    }
  }

  return ops;
}

/**
 * SMask info objects carry a `parentCtm` snapshotted at the time `/gs` set the
 * soft mask, in the coordinate space active at that point.  When the op is
 * later composed with parent form transforms, that parentCtm must be composed
 * the same way so the SMask form ends up in the correct page-space location.
 * Returns a new wrapper (without mutating the shared smask object).
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
   * Compose smask parentCtm into the result if either smask is present.
   * Mutates `result` in place.
   * @param {DrawOp} result
   */
  const composeSmaskCtms = (result) => {
    if (op.smask) result.smask = transformSmaskCtm(op.smask, composedBase);
    if (op.outerSmask) result.outerSmask = transformSmaskCtm(op.outerSmask, composedBase);
  };
  switch (op.type) {
    case 'image': {
      const finalCtm = matMul(op.ctm, composedBase);
      const result = { ...op, ctm: finalCtm };
      if (op.clips) result.clips = op.clips.map((c) => ({ ...c, ctm: matMul(c.ctm, composedBase) }));
      composeSmaskCtms(result);
      return result;
    }
    case 'type0text': {
      const trm = matMul([op.a, op.b, op.c, op.d, op.x, op.y], composedBase);
      const result = {
        ...op, a: trm[0], b: trm[1], c: trm[2], d: trm[3], x: trm[4], y: trm[5],
      };
      if (op.clips) result.clips = op.clips.map((c) => ({ ...c, ctm: matMul(c.ctm, composedBase) }));
      composeSmaskCtms(result);
      return result;
    }
    case 'type3glyph': {
      const newTransform = matMul(op.transform, composedBase);
      const result = { ...op, transform: newTransform };
      if (op.clips) result.clips = op.clips.map((c) => ({ ...c, ctm: matMul(c.ctm, composedBase) }));
      composeSmaskCtms(result);
      return result;
    }
    case 'path': {
      const newCtm = matMul(op.ctm, composedBase);
      const result = { ...op, ctm: newCtm };
      if (op.clips) result.clips = op.clips.map((c) => ({ ...c, ctm: matMul(c.ctm, composedBase) }));
      composeSmaskCtms(result);
      return result;
    }
    case 'shading': {
      const newCtm = matMul(op.ctm, composedBase);
      const result = { ...op, ctm: newCtm };
      if (op.clips) result.clips = op.clips.map((c) => ({ ...c, ctm: matMul(c.ctm, composedBase) }));
      composeSmaskCtms(result);
      return result;
    }
    case 'inlineImage': {
      const newCtm = matMul(op.ctm, composedBase);
      const result = { ...op, ctm: newCtm };
      if (op.clips) result.clips = op.clips.map((c) => ({ ...c, ctm: matMul(c.ctm, composedBase) }));
      composeSmaskCtms(result);
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
 * @returns {Promise<Array<DrawOp>>}
 */
async function flattenDrawOps(
  imageOps, images, forms, objCache, fonts, registeredFontNames, prefix = '',
  pageIndex = 0, symbolFontTags = new Set(), cidPUATags = new Set(), pageExtGStates = new Map(), rawCharCodeTags = new Set(),
  formResourceCache = new Map(), depth = 0, offOCGs = new Set(),
  cidCollisionMap = new Map(),
  inheritedFillColor = 'black', inheritedStrokeColor = 'rgb(0,0,0)',
) {
  /** @type {Array<DrawOp>} */
  const flattened = [];
  if (depth > 20) return flattened;
  formResourceCache.set('_callCount', (formResourceCache.get('_callCount') || 0) + 1);

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

    // Get the Form's /Matrix (defaults to identity)
    const matrixMatch = /\/Matrix\s*\[\s*([\d.\-\s]+)\]/.exec(formObjText);
    const formMatrix = matrixMatch
      ? matrixMatch[1].trim().split(/\s+/).map(Number)
      : [1, 0, 0, 1, 0, 0];

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
    let cached = formResourceCache.get(formInfo.objNum);
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
      if (formFonts.size > 0) {
        effectiveFonts2 = new Map([...fonts, ...formFonts]);
        effectiveRegistered2 = new Map(registeredFontNames);
        for (const [fontTag, fontObj] of formFonts) {
          // A Form XObject's local /Resources must shadow the parent scope.
          // Even if the tag already exists (e.g. /C0_0 on the page and inside
          // the form), re-register against the form font object so parseDrawOps
          // resolves to the form-local family alias.
          const formId = fullName.replace(/\//g, '_');
          const familyName = pdfFontFamilyName(objCache, fontObj.fontObjNum, `${formId}_${fontTag}`);
          await convertAndRegisterFont(
            fontTag, fontObj, effectiveRegistered2, symbolFontTags, cidPUATags,
            rawCharCodeTags, cidCollisionMap, objCache, familyName,
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
      const effectiveExtGStates2 = formExtGStates.size > 0
        ? new Map([...pageExtGStates, ...formExtGStates])
        : pageExtGStates;

      const streamBytes = objCache.getStreamBytes(formInfo.objNum);
      let rawFormDrawOps = [];
      if (streamBytes) {
        const formStream = bytesToLatin1(streamBytes);
        rawFormDrawOps = parseDrawOps(
          formStream, effectiveFonts2, effectiveExtGStates2, effectiveRegistered2,
          formColorSpaces.size > 0 ? formColorSpaces : undefined, symbolFontTags, cidPUATags, rawCharCodeTags,
          formShadings, formPatterns, cidCollisionMap,
        );
      }

      cached = {
        formImagesResult,
        rawFormDrawOps,
        effectiveFonts: effectiveFonts2,
        effectiveRegistered: effectiveRegistered2,
        effectiveExtGStates: effectiveExtGStates2,
      };
      formResourceCache.set(formInfo.objNum, cached);
    }

    // Resolve the form's effective inherited fill/stroke color. Per PDF spec §8.10.1,
    // a form inherits its caller's graphics state at the time of `Do`. The Do op was
    // emitted by the caller's parser with the caller's then-current colors; if the
    // caller never explicitly set a color before invoking the form (so the Do op was
    // tagged as inherited), fall back to this function's inherited param so the
    // chain propagates through nested forms.
    const formInheritedFill = op.fillColorInherited ? inheritedFillColor : op.fillColor;
    const formInheritedStroke = op.strokeColorInherited ? inheritedStrokeColor : (op.strokeColor || inheritedStrokeColor);

    // Per-call expansion (no expandedOps cache): the cached `rawFormDrawOps` carry
    // inheritance markers so the same parsed form can be reused across callers,
    // but each invocation resolves the markers against its own parent context.
    // Register images/forms with current prefix for the recursive flattening
    for (const [name, info] of cached.formImagesResult.images) {
      images.set(`${fullName}/${name}`, info);
    }
    for (const [name, info] of cached.formImagesResult.forms) {
      forms.set(`${fullName}/${name}`, info);
    }

    // Per PDF spec §4.9.1, Form XObjects without a /Resources dictionary
    // inherit resources from the parent scope.  Fonts and ExtGStates are
    // already inherited above; do the same for images and nested forms.
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
    const innerPrefix = `${fullName}/`;
    /** @type {Array<DrawOp>} */
    const expandedFormOps = [];
    for (const innerOp of cached.rawFormDrawOps) {
      if (innerOp.type === 'image') {
        const nestedFlattened = await flattenDrawOps(
          [innerOp], images, forms, objCache, effectiveFonts, effectiveRegistered,
          innerPrefix, pageIndex, symbolFontTags, cidPUATags, effectiveExtGStates, rawCharCodeTags,
          formResourceCache, depth + 1, offOCGs, cidCollisionMap,
          formInheritedFill, formInheritedStroke,
        );
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
      if (op.smask) {
        if (hasFormSiblingSmasks) {
          transformed.outerSmask = op.smask;
        } else if (!transformed.smask) {
          transformed.smask = op.smask;
        }
      }
      if (op.fillAlpha < 1) transformed.fillAlpha = (transformed.fillAlpha ?? 1) * op.fillAlpha;
      if (op.strokeAlpha < 1) transformed.strokeAlpha = (transformed.strokeAlpha ?? 1) * op.strokeAlpha;
      if (op.blendMode && !transformed.blendMode) transformed.blendMode = op.blendMode;
      if (op.overprint && !transformed.overprint) transformed.overprint = true;
      flattened.push(transformed);
    }
  }

  return flattened;
}

/**
 * Parse ExtGState entries from page resources for alpha transparency support.
 * Returns a map of GState names to their alpha values.
 *
 * @typedef {{ fillAlpha?: number, strokeAlpha?: number, overprint?: boolean,
 *   blendMode?: string, smask?: SmaskRef|null }} ExtGStateEntry
 *
 * @param {string} pageObjText - Raw text of the Page object
 * @param {ObjectCache} objCache - PDF object cache
 */
function parseExtGStates(pageObjText, objCache) {
  const states = new Map();

  let resourcesText = pageObjText;
  const resRefMatch = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(pageObjText);
  if (resRefMatch) {
    const resObj = objCache.getObjectText(Number(resRefMatch[1]));
    if (resObj) resourcesText = resObj;
  }

  const gsStart = resourcesText.indexOf('/ExtGState');
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
          };
        }
      }
    }

    // /BM = blend mode
    const bmMatch = /\/BM\s*\/(\w+)/.exec(gsObj);
    if (bmMatch) entry.blendMode = bmMatch[1];

    if (entry.fillAlpha !== undefined || entry.strokeAlpha !== undefined || entry.smask !== undefined || entry.overprint !== undefined || entry.blendMode !== undefined) {
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
          };
        }
      }
    }

    // /BM = blend mode
    const bmMatch2 = /\/BM\s*\/(\w+)/.exec(dictText);
    if (bmMatch2) entry.blendMode = bmMatch2[1];

    if (entry.fillAlpha !== undefined || entry.strokeAlpha !== undefined || entry.smask !== undefined || entry.overprint !== undefined || entry.blendMode !== undefined) {
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
        const namesMatch = /\/DeviceN\s*\[\s*((?:\/\w+\s*)+)\]/.exec(csObjText);
        if (namesMatch) {
          const colorants = namesMatch[1].trim().split(/(?=\/)/).filter((s) => s.startsWith('/'));
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
        const wpMatch = /\/WhitePoint\s*\[\s*([\d.\s]+)\]/.exec(csObjText);
        labWhitePoint = wpMatch ? wpMatch[1].trim().split(/\s+/).map(Number) : [0.9505, 1.0, 1.089];
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
      // Single-colorant DeviceN → treat as Separation
      if (csType === 'DeviceN') {
        const arrStart = csDictText.indexOf(match[0]);
        const arrEnd = csDictText.indexOf(']', arrStart) + 1;
        if (arrEnd > 0) {
          const arrText = csDictText.substring(arrStart, arrEnd);
          const namesMatch = /\/DeviceN\s*\[\s*((?:\/\w+\s*)+)\]/.exec(arrText);
          if (namesMatch) {
            const colorants = namesMatch[1].trim().split(/(?=\/)/).filter((s) => s.startsWith('/'));
            if (colorants.length === 1) csType = 'Separation';
          }
        }
      }
      if (csType === 'Separation') {
        const arrStart = csDictText.indexOf(match[0]);
        const arrEnd = csDictText.indexOf(']', arrStart) + 1;
        if (arrEnd > 0) {
          const tintInfo = parseSeparationTint(csDictText.substring(arrStart, arrEnd), objCache);
          tintSamples = tintInfo.tintSamples;
          nComponents = tintInfo.nComponents;
        }
      }
      let indexedInfo = null;
      if (csType === 'Indexed') {
        const arrStart = csDictText.indexOf(match[0]);
        // Find the matching ']' — need to handle nested brackets in hex strings
        const arrEnd = csDictText.indexOf(']', arrStart) + 1;
        if (arrEnd > 0) {
          indexedInfo = parseIndexedColorSpace(csDictText.substring(arrStart, arrEnd), objCache);
        }
      }
      colorSpaces.set(csName, {
        type: csType, tintSamples, nComponents, indexedInfo,
      });
    }
  }

  return colorSpaces;
}

/**
 * Evaluate a FunctionType 0 (sampled) function at a given input value.
 * Returns an array of output component values in the range specified by /Decode.
 *
 * @param {Uint8Array} samples - Raw sample data
 * @param {number} size - Number of samples
 * @param {number} nOutputs - Number of output components
 * @param {number[]} decode - Decode array [min0, max0, min1, max1, ...]
 * @param {number} t - Input value in domain [0, 1]
 * @param {number} [bitsPerSample]
 */
function evaluateSampledFunction(samples, size, nOutputs, decode, t, bitsPerSample = 8) {
  const idx = Math.min(Math.max(t * (size - 1), 0), size - 1);
  const i0 = Math.floor(idx);
  const i1 = Math.min(i0 + 1, size - 1);
  const frac = idx - i0;
  const bytesPerValue = bitsPerSample / 8;
  const maxVal = (2 ** bitsPerSample) - 1;
  const result = new Array(nOutputs);
  for (let c = 0; c < nOutputs; c++) {
    let s0 = 0;
    let s1 = 0;
    if (bytesPerValue === 1) {
      s0 = samples[i0 * nOutputs + c];
      s1 = samples[i1 * nOutputs + c];
    } else {
      const off0 = (i0 * nOutputs + c) * bytesPerValue;
      const off1 = (i1 * nOutputs + c) * bytesPerValue;
      // Use multiplication instead of bit shift so 32-bit samples don't overflow
      // JavaScript's 32-bit signed int (which would produce negative values for
      // samples with the top bit set and render the gradient as black).
      for (let j = 0; j < bytesPerValue; j++) {
        s0 = s0 * 256 + (samples[off0 + j] || 0);
        s1 = s1 * 256 + (samples[off1 + j] || 0);
      }
    }
    const sInterp = s0 + frac * (s1 - s0);
    // Map from sample range [0, maxVal] to decode range
    const dMin = decode[c * 2];
    const dMax = decode[c * 2 + 1];
    result[c] = dMin + (sInterp / maxVal) * (dMax - dMin);
  }
  return result;
}

/**
 * Evaluate a stitching function (FunctionType 3) for a single-output sub-function
 * used inside a multi-function /Function array. Returns a single numeric value.
 */
function evaluateStitchingFunc(sf, t) {
  const { bounds, encode, subFuncs } = sf;
  const domainBounds = [0, ...bounds, 1];
  let si = 0;
  for (let bi = 0; bi < bounds.length; bi++) {
    if (t >= bounds[bi]) si = bi + 1;
  }
  if (si >= subFuncs.length) si = subFuncs.length - 1;
  const sub = subFuncs[si];
  if (!sub) return 0;
  const dLo = domainBounds[si];
  const dHi = domainBounds[si + 1];
  const eLo = encode.length > si * 2 ? encode[si * 2] : 0;
  const eHi = encode.length > si * 2 + 1 ? encode[si * 2 + 1] : 1;
  const tLocal = dHi > dLo ? (t - dLo) / (dHi - dLo) : 0;
  const tEncoded = eLo + tLocal * (eHi - eLo);
  const tClamped = Math.max(0, Math.min(1, tEncoded));
  if (sub.funcType === 0) {
    const v = evaluateSampledFunction(sub.samples, sub.size, sub.nOutputs, sub.decode, tClamped, sub.bitsPerSample || 8);
    return v[0] ?? 0;
  }
  // Type 2 (exponential)
  return sub.c0[0] + (tClamped ** sub.n) * (sub.c1[0] - sub.c0[0]);
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

  // Build color evaluator from Function if present
  let colorFunc = null;
  const funcRefMatch = /\/Function\s+(\d+)\s+\d+\s+R/.exec(shObjText);
  if (funcRefMatch) {
    const funcObjText = objCache.getObjectText(Number(funcRefMatch[1]));
    if (funcObjText) colorFunc = buildColorEvaluatorFromText(funcObjText);
  } else {
    const funcIdx = shObjText.indexOf('/Function');
    if (funcIdx !== -1) {
      const funcDictOpen = shObjText.indexOf('<<', funcIdx + 9);
      if (funcDictOpen !== -1) {
        const funcDictText = extractDict(shObjText, funcDictOpen);
        if (funcDictText) colorFunc = buildColorEvaluatorFromText(funcDictText);
      }
    }
  }

  // Detect Separation/DeviceN color space and parse tint transform for color conversion.
  // When the color space is Separation, the stream stores tint values (nComps=1) that must
  // be mapped through the tint transform to get actual RGB colors.
  let sepTintSamples = null;
  const csRefMatch = /\/ColorSpace\s+(\d+)\s+\d+\s+R/.exec(shObjText);
  if (csRefMatch) {
    const csObjText = objCache.getObjectText(Number(csRefMatch[1]));
    if (csObjText && /\/Separation|\/DeviceN/.test(csObjText)) {
      const tintInfo = parseSeparationTint(csObjText, objCache);
      if (tintInfo.tintSamples) sepTintSamples = tintInfo.tintSamples;
    }
  }

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
    if (colorFunc) return colorFunc(comps);
    if (sepTintSamples && nComps === 1) {
      const sepMax = sepTintSamples.length / 3 - 1;
      const idx = Math.round(Math.max(0, Math.min(1, comps[0])) * sepMax) * 3;
      return [sepTintSamples[idx], sepTintSamples[idx + 1], sepTintSamples[idx + 2]];
    }
    if (nComps === 4) return cmykToRgb(comps[0], comps[1], comps[2], comps[3]);
    if (nComps === 1) { const v = Math.round(comps[0] * 255); return [v, v, v]; }
    return [Math.round(comps[0] * 255), Math.round(comps[1] * 255), Math.round(comps[2] * 255)];
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
  const tmpCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (tmpCanvas.getContext('2d'));
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
  const tmpCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (tmpCanvas.getContext('2d'));
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
 * Build a color evaluator from an inline function dict text.
 * Returns a function (comps: number[]) => [r, g, b] (0-255), or null.
 */
function buildColorEvaluatorFromText(funcDictText) {
  const funcTypeMatch = /\/FunctionType\s+(\d+)/.exec(funcDictText);
  const funcType = funcTypeMatch ? Number(funcTypeMatch[1]) : -1;

  if (funcType === 2) {
    const c0Match = /\/C0\s*\[\s*([\d.\s-]+)\]/.exec(funcDictText);
    const c1Match = /\/C1\s*\[\s*([\d.\s-]+)\]/.exec(funcDictText);
    const nMatch = /\/N\s+([\d.]+)/.exec(funcDictText);
    const c0 = c0Match ? c0Match[1].trim().split(/\s+/).map(Number) : [0, 0, 0];
    const c1 = c1Match ? c1Match[1].trim().split(/\s+/).map(Number) : [1, 1, 1];
    const n = nMatch ? Number(nMatch[1]) : 1;
    return (comps) => {
      const t = Math.max(0, Math.min(1, comps[0]));
      const tN = t ** n;
      return [
        Math.round(Math.max(0, Math.min(1, c0[0] + tN * (c1[0] - c0[0]))) * 255),
        Math.round(Math.max(0, Math.min(1, (c0[1] ?? 0) + tN * ((c1[1] ?? 1) - (c0[1] ?? 0)))) * 255),
        Math.round(Math.max(0, Math.min(1, (c0[2] ?? 0) + tN * ((c1[2] ?? 1) - (c0[2] ?? 0)))) * 255),
      ];
    };
  }

  if (funcType === 3) {
    const boundsMatch = /\/Bounds\s*\[\s*([\d.\s]*)\]/.exec(funcDictText);
    const encodeMatch = /\/Encode\s*\[\s*([\d.\s-]+)\]/.exec(funcDictText);
    const bounds = boundsMatch && boundsMatch[1].trim()
      ? boundsMatch[1].trim().split(/\s+/).map(Number) : [];
    const encode = encodeMatch ? encodeMatch[1].trim().split(/\s+/).map(Number) : [];
    const subFuncs = [];
    const funcsIdx = funcDictText.indexOf('/Functions');
    if (funcsIdx !== -1) {
      const afterFuncs = funcDictText.substring(funcsIdx + 10);
      for (const m of afterFuncs.matchAll(/<<([\s\S]*?)>>/g)) {
        const subText = m[1];
        const stMatch = /\/FunctionType\s+(\d+)/.exec(subText);
        if (!stMatch || Number(stMatch[1]) !== 2) continue;
        const sc0Match = /\/C0\s*\[\s*([\d.\s-]+)\]/.exec(subText);
        const sc1Match = /\/C1\s*\[\s*([\d.\s-]+)\]/.exec(subText);
        const snMatch = /\/N\s+([\d.]+)/.exec(subText);
        subFuncs.push({
          c0: sc0Match ? sc0Match[1].trim().split(/\s+/).map(Number) : [0],
          c1: sc1Match ? sc1Match[1].trim().split(/\s+/).map(Number) : [1],
          n: snMatch ? Number(snMatch[1]) : 1,
        });
      }
    }
    if (subFuncs.length === 0) return null;
    const domainBounds = [0, ...bounds, 1];
    return (comps) => {
      const t = Math.max(0, Math.min(1, comps[0]));
      let si = 0;
      for (let bi = 0; bi < bounds.length; bi++) {
        if (t >= bounds[bi]) si = bi + 1;
      }
      if (si >= subFuncs.length) si = subFuncs.length - 1;
      const sub = subFuncs[si];
      const dLo = domainBounds[si];
      const dHi = domainBounds[si + 1];
      const eLo = encode.length > si * 2 ? encode[si * 2] : 0;
      const eHi = encode.length > si * 2 + 1 ? encode[si * 2 + 1] : 1;
      const tLocal = dHi > dLo ? (t - dLo) / (dHi - dLo) : 0;
      const tEncoded = eLo + tLocal * (eHi - eLo);
      const tClamped = Math.max(0, Math.min(1, tEncoded));
      const tN = tClamped ** sub.n;
      return [
        Math.round(Math.max(0, Math.min(1, sub.c0[0] + tN * (sub.c1[0] - sub.c0[0]))) * 255),
        Math.round(Math.max(0, Math.min(1, (sub.c0[1] ?? 0) + tN * ((sub.c1[1] ?? 1) - (sub.c0[1] ?? 0)))) * 255),
        Math.round(Math.max(0, Math.min(1, (sub.c0[2] ?? 0) + tN * ((sub.c1[2] ?? 1) - (sub.c0[2] ?? 0)))) * 255),
      ];
    };
  }

  return null;
}

/**
 * Parse a ShadingType 4 (free-form Gouraud-shaded triangle mesh) shading.
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

  // Detect Separation/DeviceN color space for tint transform
  let sepTintSamples = null;
  const csRefMatch = /\/ColorSpace\s+(\d+)\s+\d+\s+R/.exec(shObjText);
  if (csRefMatch) {
    const csObjText = objCache.getObjectText(Number(csRefMatch[1]));
    if (csObjText && /\/Separation|\/DeviceN/.test(csObjText)) {
      const tintInfo = parseSeparationTint(csObjText, objCache);
      if (tintInfo.tintSamples) sepTintSamples = tintInfo.tintSamples;
    }
  }

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
    let color;
    if (sepTintSamples && nComps === 1) {
      const sepMax = sepTintSamples.length / 3 - 1;
      const idx = Math.round(Math.max(0, Math.min(1, comps[0])) * sepMax) * 3;
      color = [sepTintSamples[idx], sepTintSamples[idx + 1], sepTintSamples[idx + 2]];
    } else if (nComps === 4) color = cmykToRgb(comps[0], comps[1], comps[2], comps[3]);
    else if (nComps === 1) {
      const v = Math.round(comps[0] * 255);
      color = [v, v, v];
    } else {
      color = [Math.round(comps[0] * 255), Math.round(comps[1] * 255), Math.round(comps[2] * 255)];
    }
    return { coord: [x, y], color };
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

  // Build color evaluator from Function if present
  let colorFunc = null;
  const funcRefMatch = /\/Function\s+(\d+)\s+\d+\s+R/.exec(shObjText);
  if (funcRefMatch) {
    const funcObjText = objCache.getObjectText(Number(funcRefMatch[1]));
    if (funcObjText) colorFunc = buildColorEvaluatorFromText(funcObjText);
  } else {
    const funcIdx = shObjText.indexOf('/Function');
    if (funcIdx !== -1) {
      const funcDictOpen = shObjText.indexOf('<<', funcIdx + 9);
      if (funcDictOpen !== -1) {
        const funcDictText = extractDict(shObjText, funcDictOpen);
        if (funcDictText) colorFunc = buildColorEvaluatorFromText(funcDictText);
      }
    }
  }

  // Detect Separation/DeviceN color space for tint transform
  let sepTintSamples = null;
  if (!colorFunc) {
    const csRefMatch = /\/ColorSpace\s+(\d+)\s+\d+\s+R/.exec(shObjText);
    if (csRefMatch) {
      const csObjText = objCache.getObjectText(Number(csRefMatch[1]));
      if (csObjText && /\/Separation|\/DeviceN/.test(csObjText)) {
        const tintInfo = parseSeparationTint(csObjText, objCache);
        if (tintInfo.tintSamples) sepTintSamples = tintInfo.tintSamples;
      }
    }
  }

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
    let color;
    if (colorFunc) {
      color = colorFunc(comps);
    } else if (sepTintSamples && nComps === 1) {
      const sepMax = sepTintSamples.length / 3 - 1;
      const idx = Math.round(Math.max(0, Math.min(1, comps[0])) * sepMax) * 3;
      color = [sepTintSamples[idx], sepTintSamples[idx + 1], sepTintSamples[idx + 2]];
    } else if (nComps === 4) {
      color = cmykToRgb(comps[0], comps[1], comps[2], comps[3]);
    } else if (nComps === 1) {
      const v = Math.round(comps[0] * 255);
      color = [v, v, v];
    } else {
      color = [Math.round(comps[0] * 255), Math.round(comps[1] * 255), Math.round(comps[2] * 255)];
    }
    vertices.push({ x, y, color });
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

    if (shadingType !== 2 && shadingType !== 3) continue;

    const coordsStr = resolveArrayValue(shObjText, 'Coords', objCache);
    if (!coordsStr) continue;
    const coords = coordsStr.split(/\s+/).map(Number);

    // Parse /Extend array (defaults to [false, false] per spec)
    const extendStr = resolveArrayValue(shObjText, 'Extend', objCache);
    const extendParts = extendStr ? extendStr.split(/\s+/) : [];
    const extend = [extendParts[0] === 'true', extendParts[1] === 'true'];

    // Parse /BBox (optional clipping rectangle for the shading)
    const bboxStr = resolveArrayValue(shObjText, 'BBox', objCache);
    const bbox = bboxStr ? bboxStr.split(/\s+/).map(Number) : null;

    // Parse /ColorSpace. The shading's color space determines how the function
    // output is interpreted:
    //   - For Separation/DeviceN, the function emits tint amounts that must be
    //     passed through the space's tint transform (and then its alternate CS)
    //     to get RGB.
    //   - For DeviceGray/DeviceRGB/DeviceCMYK, the function emits colorant
    //     values directly.
    //
    // /ColorSpace may be (a) a scalar name `/DeviceGray`, (b) an inline array
    // `[/Separation /Black /DeviceCMYK 118 0 R]`, or (c) an indirect reference
    // `N 0 R`. Extract the defining text once so downstream detection can treat
    // all three forms the same way.
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

    // Parse function reference — handle both indirect ref and inline array of refs.
    // /Function may be: (a) a single indirect ref `N 0 R`, (b) an array of refs
    // `[N 0 R M 0 R ...]` where each function produces one output component.
    const funcArrAllMatch = /\/Function\s*\[\s*((?:\d+\s+\d+\s+R\s*)+)\]/.exec(shObjText);
    const funcArrRefs = funcArrAllMatch
      ? [...funcArrAllMatch[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]))
      : null;

    if (funcArrRefs && funcArrRefs.length > 1) {
      const nComponents = funcArrRefs.length;
      // Prepare each sub-function
      const subFuncs = [];
      for (const ref of funcArrRefs) {
        const subText = objCache.getObjectText(ref);
        if (!subText) { subFuncs.push(null); continue; }
        const subFuncType = resolveIntValue(subText, 'FunctionType', objCache, -1);
        if (subFuncType === 0) {
          const sizeStr = resolveArrayValue(subText, 'Size', objCache);
          const decodeStr = resolveArrayValue(subText, 'Decode', objCache);
          const rangeStr = resolveArrayValue(subText, 'Range', objCache);
          const size = sizeStr ? Number(sizeStr.trim().split(/\s+/)[0]) : 256;
          const range = rangeStr ? rangeStr.split(/\s+/).map(Number) : (decodeStr ? decodeStr.split(/\s+/).map(Number) : [0, 1]);
          const decode = decodeStr ? decodeStr.split(/\s+/).map(Number) : range;
          const nOutputs = range.length / 2;
          const bps = resolveIntValue(subText, 'BitsPerSample', objCache, 8);
          const funcBytes = objCache.getStreamBytes(ref);
          subFuncs.push({
            funcType: 0, samples: funcBytes, size, nOutputs, decode, bitsPerSample: bps,
          });
        } else if (subFuncType === 2) {
          const sc0Str = resolveArrayValue(subText, 'C0', objCache);
          const sc1Str = resolveArrayValue(subText, 'C1', objCache);
          subFuncs.push({
            funcType: 2,
            c0: sc0Str ? sc0Str.split(/\s+/).map(Number) : [0],
            c1: sc1Str ? sc1Str.split(/\s+/).map(Number) : [1],
            n: resolveNumValue(subText, 'N', objCache, 1),
          });
        } else if (subFuncType === 3) {
          // Stitching sub-function — parse it inline
          const boundsStr = resolveArrayValue(subText, 'Bounds', objCache);
          const encodeStr = resolveArrayValue(subText, 'Encode', objCache);
          const funcsStr = resolveArrayValue(subText, 'Functions', objCache);
          if (!funcsStr) { subFuncs.push(null); continue; }
          const bounds = boundsStr && boundsStr.trim() ? boundsStr.split(/\s+/).map(Number) : [];
          const encode = encodeStr ? encodeStr.split(/\s+/).map(Number) : [];
          const sfRefs = [...funcsStr.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
          const innerFuncs = [];
          for (const sfRef of sfRefs) {
            const sfText = objCache.getObjectText(sfRef);
            if (!sfText) { innerFuncs.push(null); continue; }
            const sfType = resolveIntValue(sfText, 'FunctionType', objCache, 2);
            if (sfType === 0) {
              const sz = resolveArrayValue(sfText, 'Size', objCache);
              const dc = resolveArrayValue(sfText, 'Decode', objCache);
              const rn = resolveArrayValue(sfText, 'Range', objCache);
              const size = sz ? Number(sz.trim().split(/\s+/)[0]) : 256;
              const range = rn ? rn.split(/\s+/).map(Number) : (dc ? dc.split(/\s+/).map(Number) : [0, 1]);
              const decode = dc ? dc.split(/\s+/).map(Number) : range;
              innerFuncs.push({
                funcType: 0,
                samples: objCache.getStreamBytes(sfRef),
                size,
                nOutputs: range.length / 2,
                decode,
                bitsPerSample: resolveIntValue(sfText, 'BitsPerSample', objCache, 8),
              });
            } else {
              const c0s = resolveArrayValue(sfText, 'C0', objCache);
              const c1s = resolveArrayValue(sfText, 'C1', objCache);
              innerFuncs.push({
                funcType: 2,
                c0: c0s ? c0s.split(/\s+/).map(Number) : [0],
                c1: c1s ? c1s.split(/\s+/).map(Number) : [1],
                n: resolveNumValue(sfText, 'N', objCache, 1),
              });
            }
          }
          subFuncs.push({
            funcType: 3, bounds, encode, subFuncs: innerFuncs,
          });
        } else {
          subFuncs.push(null);
        }
      }

      const hasSampled = subFuncs.some((sf) => sf && sf.funcType === 0);
      const nStops = hasSampled ? 64 : 16;
      const stops = [];
      for (let i = 0; i < nStops; i++) {
        const t = i / (nStops - 1);
        const values = new Array(nComponents);
        for (let ci = 0; ci < nComponents; ci++) {
          const sf = subFuncs[ci];
          if (!sf) { values[ci] = 0; continue; }
          if (sf.funcType === 0) {
            const v = evaluateSampledFunction(sf.samples, sf.size, sf.nOutputs, sf.decode, t, sf.bitsPerSample);
            values[ci] = v[0] ?? 0;
          } else if (sf.funcType === 2) {
            values[ci] = sf.c0[0] + (t ** sf.n) * (sf.c1[0] - sf.c0[0]);
          } else if (sf.funcType === 3) {
            values[ci] = evaluateStitchingFunc(sf, t);
          }
        }
        let r; let g; let b;
        if (deviceNTintCS) {
          const rgb = tintComponentsToRGB(deviceNTintCS, values);
          if (rgb) { [r, g, b] = rgb; } else { r = 128; g = 128; b = 128; }
        } else if (sepTintSamples) {
          const sepMax = sepTintSamples.length / 3 - 1;
          const idx = Math.round(Math.max(0, Math.min(1, values[0])) * sepMax) * 3;
          r = sepTintSamples[idx]; g = sepTintSamples[idx + 1]; b = sepTintSamples[idx + 2];
        } else if (shadingCS === 'DeviceCMYK' && nComponents >= 4) {
          const cc = Math.max(0, Math.min(1, values[0]));
          const mm = Math.max(0, Math.min(1, values[1]));
          const yy = Math.max(0, Math.min(1, values[2]));
          const kk = Math.max(0, Math.min(1, values[3]));
          [r, g, b] = cmykToRgb(cc, mm, yy, kk);
        } else {
          r = Math.round(Math.max(0, Math.min(1, values[0])) * 255);
          g = isGray ? r : Math.round(Math.max(0, Math.min(1, values[1] ?? 0)) * 255);
          b = isGray ? r : Math.round(Math.max(0, Math.min(1, values[2] ?? 0)) * 255);
        }
        stops.push({ offset: t, color: `rgb(${r},${g},${b})` });
      }
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

    const funcObjText = objCache.getObjectText(funcObjNum);
    if (!funcObjText) continue;

    const funcType = resolveIntValue(funcObjText, 'FunctionType', objCache, -1);

    if (funcType === 0) {
      // Sampled function
      const sizeStr = resolveArrayValue(funcObjText, 'Size', objCache);
      const decodeStr = resolveArrayValue(funcObjText, 'Decode', objCache);
      const rangeStr = resolveArrayValue(funcObjText, 'Range', objCache);

      const size = sizeStr ? Number(sizeStr.trim().split(/\s+/)[0]) : 256;
      // Per PDF spec Table 3.36, /Decode defaults to /Range when absent (not vice versa).
      // The reverse default would mis-size decode for any function whose /Range has a
      // different output count than the hardcoded fallback (e.g. 4-output CMYK functions
      // produce nOutputs=4 but a 6-element decode, leaving decode[6]/[7] undefined and
      // poisoning every sample with NaN).
      const range = rangeStr ? rangeStr.split(/\s+/).map(Number) : (decodeStr ? decodeStr.split(/\s+/).map(Number) : [0, 1, 0, 1, 0, 1]);
      const decode = decodeStr ? decodeStr.split(/\s+/).map(Number) : range;
      const nOutputs = range.length / 2;
      const bitsPerSample = resolveIntValue(funcObjText, 'BitsPerSample', objCache, 8);

      const funcBytes = objCache.getStreamBytes(funcObjNum);
      if (!funcBytes) continue;

      // Generate gradient color stops by sampling the function
      const nStops = Math.min(size, 64); // Use up to 64 stops for smooth gradients
      const stops = [];
      for (let i = 0; i < nStops; i++) {
        const t = i / (nStops - 1);
        const values = evaluateSampledFunction(funcBytes, size, nOutputs, decode, t, bitsPerSample);
        let r; let g; let b;
        if (deviceNTintCS) {
          // Multi-input DeviceN: pass the function's N outputs through the DeviceN
          // tint transform to get the alt-CS color, then convert to RGB.
          const rgb = tintComponentsToRGB(deviceNTintCS, values);
          if (rgb) { [r, g, b] = rgb; } else { r = 128; g = 128; b = 128; }
        } else if (sepTintSamples) {
          const sepMax = sepTintSamples.length / 3 - 1;
          const idx = Math.round(Math.max(0, Math.min(1, values[0])) * sepMax) * 3;
          r = sepTintSamples[idx]; g = sepTintSamples[idx + 1]; b = sepTintSamples[idx + 2];
        } else if (shadingCS === 'DeviceCMYK' && nOutputs >= 4) {
          const cc = Math.max(0, Math.min(1, values[0]));
          const mm = Math.max(0, Math.min(1, values[1]));
          const yy = Math.max(0, Math.min(1, values[2]));
          const kk = Math.max(0, Math.min(1, values[3]));
          [r, g, b] = cmykToRgb(cc, mm, yy, kk);
        } else {
          r = Math.round(Math.max(0, Math.min(1, values[0])) * 255);
          g = isGray ? r : Math.round(Math.max(0, Math.min(1, values[1])) * 255);
          b = isGray ? r : Math.round(Math.max(0, Math.min(1, values[2])) * 255);
        }
        stops.push({ offset: t, color: `rgb(${r},${g},${b})` });
      }

      shadings.set(shName, {
        type: shadingType, coords, stops, extend, bbox, multiply: isSeparationShading,
      });
    } else if (funcType === 2) {
      // Exponential interpolation function
      const c0Str = resolveArrayValue(funcObjText, 'C0', objCache);
      const c1Str = resolveArrayValue(funcObjText, 'C1', objCache);

      const c0 = c0Str ? c0Str.split(/\s+/).map(Number) : [0];
      const c1 = c1Str ? c1Str.split(/\s+/).map(Number) : [1];
      const n = resolveNumValue(funcObjText, 'N', objCache, 1);

      const stops = [];
      const nStops = n === 1 ? 2 : 16; // Linear needs only 2 stops
      for (let i = 0; i < nStops; i++) {
        const t = i / (nStops - 1);
        const tN = t ** n;
        let r; let g; let b;
        if (deviceNTintCS) {
          // Multi-input DeviceN: evaluate the exponential function for ALL components
          // (not just RGB-ish first 3), then pass the multi-component value through
          // the DeviceN tint transform to get RGB.
          const vals = c0.map((c0v, idx) => c0v + tN * (((c1[idx] != null) ? c1[idx] : 0) - c0v));
          const rgb = tintComponentsToRGB(deviceNTintCS, vals);
          if (rgb) { [r, g, b] = rgb; } else { r = 128; g = 128; b = 128; }
        } else if (sepTintSamples) {
          const val = Math.max(0, Math.min(1, c0[0] + tN * (c1[0] - c0[0])));
          const idx = Math.round(val * (sepTintSamples.length / 3 - 1)) * 3;
          r = sepTintSamples[idx]; g = sepTintSamples[idx + 1]; b = sepTintSamples[idx + 2];
        } else if (shadingCS === 'DeviceCMYK' && c0.length >= 4) {
          const cc = Math.max(0, Math.min(1, c0[0] + tN * (c1[0] - c0[0])));
          const mm = Math.max(0, Math.min(1, (c0[1] ?? 0) + tN * ((c1[1] ?? 0) - (c0[1] ?? 0))));
          const yy = Math.max(0, Math.min(1, (c0[2] ?? 0) + tN * ((c1[2] ?? 0) - (c0[2] ?? 0))));
          const kk = Math.max(0, Math.min(1, (c0[3] ?? 0) + tN * ((c1[3] ?? 0) - (c0[3] ?? 0))));
          [r, g, b] = cmykToRgb(cc, mm, yy, kk);
        } else {
          r = Math.round(Math.max(0, Math.min(1, c0[0] + tN * (c1[0] - c0[0]))) * 255);
          g = isGray ? r : Math.round(Math.max(0, Math.min(1, (c0[1] ?? 0) + tN * ((c1[1] ?? 1) - (c0[1] ?? 0)))) * 255);
          b = isGray ? r : Math.round(Math.max(0, Math.min(1, (c0[2] ?? 0) + tN * ((c1[2] ?? 1) - (c0[2] ?? 0)))) * 255);
        }
        stops.push({ offset: t, color: `rgb(${r},${g},${b})` });
      }

      shadings.set(shName, {
        type: shadingType, coords, stops, extend, bbox, multiply: isSeparationShading,
      });
    } else if (funcType === 3) {
      // Stitching function — evaluate sub-functions across their domains
      const boundsStr = resolveArrayValue(funcObjText, 'Bounds', objCache);
      const encodeStr = resolveArrayValue(funcObjText, 'Encode', objCache);
      const funcsStr = resolveArrayValue(funcObjText, 'Functions', objCache);
      if (!funcsStr) continue;

      const bounds = boundsStr && boundsStr.trim()
        ? boundsStr.split(/\s+/).map(Number) : [];
      const encode = encodeStr ? encodeStr.split(/\s+/).map(Number) : [];
      const subFuncRefs = [...funcsStr.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));

      const subFuncs = [];
      let hasSampledSub = false;
      for (let si = 0; si < subFuncRefs.length; si++) {
        const subText = objCache.getObjectText(subFuncRefs[si]);
        if (!subText) continue;
        const subFuncType = resolveIntValue(subText, 'FunctionType', objCache, 2);

        if (subFuncType === 0) {
          // Sampled sub-function
          hasSampledSub = true;
          const sizeStr = resolveArrayValue(subText, 'Size', objCache);
          const decodeStr = resolveArrayValue(subText, 'Decode', objCache);
          const rangeStr = resolveArrayValue(subText, 'Range', objCache);
          const size = sizeStr ? Number(sizeStr.trim().split(/\s+/)[0]) : 256;
          // Per PDF spec Table 3.36, /Decode defaults to /Range when absent
          const range = rangeStr ? rangeStr.split(/\s+/).map(Number) : (decodeStr ? decodeStr.split(/\s+/).map(Number) : [0, 1, 0, 1, 0, 1]);
          const decode = decodeStr ? decodeStr.split(/\s+/).map(Number) : range;
          const nOutputs = range.length / 2;
          const subBps = resolveIntValue(subText, 'BitsPerSample', objCache, 8);
          const funcBytes = objCache.getStreamBytes(subFuncRefs[si]);
          subFuncs.push({
            funcType: 0, samples: funcBytes, size, nOutputs, decode, bitsPerSample: subBps,
          });
        } else {
          // Type 2 (exponential)
          const sc0Str = resolveArrayValue(subText, 'C0', objCache);
          const sc1Str = resolveArrayValue(subText, 'C1', objCache);
          subFuncs.push({
            funcType: 2,
            c0: sc0Str ? sc0Str.split(/\s+/).map(Number) : [0],
            c1: sc1Str ? sc1Str.split(/\s+/).map(Number) : [1],
            n: resolveNumValue(subText, 'N', objCache, 1),
          });
        }
      }

      const domainBounds = [0, ...bounds, 1];
      const stops = [];
      const nStops = hasSampledSub ? 64 : 16;
      for (let i = 0; i < nStops; i++) {
        const t = i / (nStops - 1);
        let si = 0;
        for (let bi = 0; bi < bounds.length; bi++) {
          if (t >= bounds[bi]) si = bi + 1;
        }
        if (si >= subFuncs.length) si = subFuncs.length - 1;
        const sub = subFuncs[si];
        if (!sub) continue;

        // Map t from [domainBounds[si], domainBounds[si+1]] to [encode[2*si], encode[2*si+1]]
        const dLo = domainBounds[si];
        const dHi = domainBounds[si + 1];
        const eLo = encode.length > si * 2 ? encode[si * 2] : 0;
        const eHi = encode.length > si * 2 + 1 ? encode[si * 2 + 1] : 1;
        const tLocal = dHi > dLo ? (t - dLo) / (dHi - dLo) : 0;
        const tEncoded = eLo + tLocal * (eHi - eLo);
        const tClamped = Math.max(0, Math.min(1, tEncoded));

        let r; let g; let b;
        if (sub.funcType === 0) {
          const values = evaluateSampledFunction(sub.samples, sub.size, sub.nOutputs, sub.decode, tClamped, sub.bitsPerSample || 8);
          if (deviceNTintCS) {
            // Multi-input DeviceN: pass the function's N outputs through the DeviceN
            // tint transform to get the alt-CS color, then convert to RGB.
            const rgb = tintComponentsToRGB(deviceNTintCS, values);
            if (rgb) { [r, g, b] = rgb; } else { r = 128; g = 128; b = 128; }
          } else if (sepTintSamples) {
            const sepMax = sepTintSamples.length / 3 - 1;
            const idx = Math.round(Math.max(0, Math.min(1, values[0])) * sepMax) * 3;
            r = sepTintSamples[idx]; g = sepTintSamples[idx + 1]; b = sepTintSamples[idx + 2];
          } else if (shadingCS === 'DeviceCMYK' && sub.nOutputs >= 4) {
            const cc = Math.max(0, Math.min(1, values[0]));
            const mm = Math.max(0, Math.min(1, values[1]));
            const yy = Math.max(0, Math.min(1, values[2]));
            const kk = Math.max(0, Math.min(1, values[3]));
            [r, g, b] = cmykToRgb(cc, mm, yy, kk);
          } else {
            r = Math.round(Math.max(0, Math.min(1, values[0])) * 255);
            g = isGray ? r : Math.round(Math.max(0, Math.min(1, values[1])) * 255);
            b = isGray ? r : Math.round(Math.max(0, Math.min(1, values[2])) * 255);
          }
        } else {
          const tN = tClamped ** sub.n;
          if (deviceNTintCS) {
            // Multi-input DeviceN: interpolate ALL components, then run them through
            // the DeviceN tint transform to get RGB.
            const vals = sub.c0.map((c0v, idx) => c0v + tN * (((sub.c1[idx] != null) ? sub.c1[idx] : 0) - c0v));
            const rgb = tintComponentsToRGB(deviceNTintCS, vals);
            if (rgb) { [r, g, b] = rgb; } else { r = 128; g = 128; b = 128; }
          } else if (sepTintSamples) {
            const val = Math.max(0, Math.min(1, sub.c0[0] + tN * (sub.c1[0] - sub.c0[0])));
            const idx = Math.round(val * (sepTintSamples.length / 3 - 1)) * 3;
            r = sepTintSamples[idx]; g = sepTintSamples[idx + 1]; b = sepTintSamples[idx + 2];
          } else if (shadingCS === 'DeviceCMYK' && sub.c0.length >= 4) {
            const cc = Math.max(0, Math.min(1, sub.c0[0] + tN * (sub.c1[0] - sub.c0[0])));
            const mm = Math.max(0, Math.min(1, (sub.c0[1] ?? 0) + tN * ((sub.c1[1] ?? 0) - (sub.c0[1] ?? 0))));
            const yy = Math.max(0, Math.min(1, (sub.c0[2] ?? 0) + tN * ((sub.c1[2] ?? 0) - (sub.c0[2] ?? 0))));
            const kk = Math.max(0, Math.min(1, (sub.c0[3] ?? 0) + tN * ((sub.c1[3] ?? 0) - (sub.c0[3] ?? 0))));
            [r, g, b] = cmykToRgb(cc, mm, yy, kk);
          } else {
            r = Math.round(Math.max(0, Math.min(1, sub.c0[0] + tN * (sub.c1[0] - sub.c0[0]))) * 255);
            g = isGray ? r : Math.round(Math.max(0, Math.min(1, (sub.c0[1] ?? 0) + tN * ((sub.c1[1] ?? 1) - (sub.c0[1] ?? 0)))) * 255);
            b = isGray ? r : Math.round(Math.max(0, Math.min(1, (sub.c0[2] ?? 0) + tN * ((sub.c1[2] ?? 1) - (sub.c0[2] ?? 0)))) * 255);
          }
        }
        stops.push({ offset: t, color: `rgb(${r},${g},${b})` });
      }

      shadings.set(shName, {
        type: shadingType, coords, stops, extend, bbox, multiply: isSeparationShading,
      });
    }
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

  const patEntryRegex = /\/([^\s/<>[\]]+)\s+(\d+)\s+\d+\s+R/g;
  for (const match of patDictText.matchAll(patEntryRegex)) {
    const patName = match[1];
    const patObjNum = Number(match[2]);
    const patObjText = objCache.getObjectText(patObjNum);
    if (!patObjText) continue;

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

    const csMatch = /\/ColorSpace\s*(?:\[\s*)?\/(\w+)/.exec(shadingDict);
    let patShadingCS = csMatch ? csMatch[1] : 'DeviceRGB';
    let patSepTintSamples = null;
    /** @type {import('./pdfColorFunctions.js').ParsedTintCS|null} */
    let patDeviceNTintCS = null;

    // Handle indirect ColorSpace reference (e.g. Separation, ICCBased)
    if (!csMatch) {
      const csRefMatch = /\/ColorSpace\s+(\d+)\s+\d+\s+R/.exec(shadingDict);
      if (csRefMatch) {
        const csObjText = objCache.getObjectText(Number(csRefMatch[1]));
        if (csObjText) {
          if (/\/Separation|\/DeviceN/.test(csObjText)) {
            // For multi-colorant DeviceN (e.g. 5-channel PANTONE+CMYK), the 1D
            // diagonal tint LUT is wrong — each function output must go through
            // the multi-input tint transform as a full N-tuple. Parse the tint
            // CS directly and feed it to parseShadingFunction so Type 2/3
            // functions can evaluate all C0→C1 components jointly. Single-
            // colorant DeviceN still uses the faster 1D LUT.
            const dnNamesMatch = /\/DeviceN\s*\[\s*((?:\/[^/[\]<>(){}\s]+\s*)+)\]/.exec(csObjText);
            const dnNumColorants = dnNamesMatch
              ? (dnNamesMatch[1].match(/\/[^/[\]<>(){}\s]+/g) || []).length
              : 0;
            if (dnNumColorants >= 2) {
              patDeviceNTintCS = parseTintColorSpace(csObjText, objCache);
            } else {
              const tintInfo = parseSeparationTint(csObjText, objCache);
              if (tintInfo.tintSamples) patSepTintSamples = tintInfo.tintSamples;
            }
            patShadingCS = 'Separation';
          } else if (/\/DeviceCMYK/.test(csObjText)) {
            patShadingCS = 'DeviceCMYK';
          } else if (/\/DeviceGray/.test(csObjText)) {
            patShadingCS = 'DeviceGray';
          } else if (/\/ICCBased/.test(csObjText)) {
            const iccRefMatch = /(\d+)\s+\d+\s+R/.exec(csObjText);
            if (iccRefMatch) {
              const iccObjText = objCache.getObjectText(Number(iccRefMatch[1]));
              const nMatch = iccObjText && /\/N\s+(\d+)/.exec(iccObjText);
              const nComp = nMatch ? Number(nMatch[1]) : 3;
              patShadingCS = nComp === 1 ? 'DeviceGray' : nComp === 4 ? 'DeviceCMYK' : 'DeviceRGB';
            }
          }
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
          const matrixMatch = /\/Matrix\s*\[\s*([\d.\seE+-]+)\]/.exec(patObjText);
          const matrix = matrixMatch ? matrixMatch[1].trim().split(/\s+/).map(Number) : null;
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
        const matrixMatch = /\/Matrix\s*\[\s*([\d.\seE+-]+)\]/.exec(patObjText);
        const matrix = matrixMatch ? matrixMatch[1].trim().split(/\s+/).map(Number) : null;
        if (matrix) meshResult.matrix = matrix;
        patterns.set(patName, { color: 'rgb(128,128,128)', shading: meshResult });
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
    const matrixMatch = /\/Matrix\s*\[\s*([\d.\seE+-]+)\]/.exec(patObjText);
    const matrix = matrixMatch ? matrixMatch[1].trim().split(/\s+/).map(Number) : null;

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
    const shading = funcDictText
      ? parseShadingFunction(funcDictText, shadingType, coords, objCache, patSepTintSamples, patIsGray, funcObjNum, patIsCMYK, patDeviceNTintCS)
      : null;
    if (shading) {
      shading.extend = extend;
      if (bbox) shading.bbox = bbox;
      if (matrix) shading.matrix = matrix;
      // Use midpoint color as fallback for solid color, but include full shading data
      const midIdx = Math.floor(shading.stops.length / 2);
      const color = shading.stops[midIdx]?.color || 'rgb(128,128,128)';
      patterns.set(patName, { color, shading });
    }
  }

  return patterns;
}

/**
 * Parse a shading function dict and return gradient info with color stops.
 * Uses getObjectText/getStreamBytes for indirect refs.
 * @param {string} funcDictText - Already-resolved function dict text
 * @param {number} shadingType
 * @param {number[]} coords
 * @param {ObjectCache} objCache
 * @param {Uint8Array|null} sepTintSamples
 * @param {boolean} isGray
 * @param {number} [funcObjNum] - Object number (needed for FunctionType 0 stream data)
 * @param {boolean} [isCMYK]
 * @param {object} [deviceNTintCS]
 */
function parseShadingFunction(funcDictText, shadingType, coords, objCache, sepTintSamples, isGray, funcObjNum, isCMYK, deviceNTintCS) {
  const funcObjText = funcDictText;
  if (!funcObjText) return null;

  const funcTypeMatch = /\/FunctionType\s+(\d+)/.exec(funcObjText);
  const funcType = funcTypeMatch ? Number(funcTypeMatch[1]) : -1;

  if (funcType === 0) {
    const sizeStr = resolveArrayValue(funcObjText, 'Size', objCache);
    const decodeStr = resolveArrayValue(funcObjText, 'Decode', objCache);
    const rangeStr = resolveArrayValue(funcObjText, 'Range', objCache);
    const size = sizeStr ? Number(sizeStr.trim().split(/\s+/)[0]) : 256;
    // Per PDF spec Table 3.36, /Decode defaults to /Range when absent (see also the
    // matching fix in the standalone shading parser above).
    const range = rangeStr ? rangeStr.split(/\s+/).map(Number) : (decodeStr ? decodeStr.split(/\s+/).map(Number) : [0, 1, 0, 1, 0, 1]);
    const decode = decodeStr ? decodeStr.split(/\s+/).map(Number) : range;
    const nOutputs = range.length / 2;
    const bitsPerSample = resolveIntValue(funcObjText, 'BitsPerSample', objCache, 8);

    if (funcObjNum == null) return null;
    const funcBytes = objCache.getStreamBytes(funcObjNum);
    if (!funcBytes) return null;

    const nStops = Math.min(size, 64);
    const stops = [];
    for (let i = 0; i < nStops; i++) {
      const t = i / (nStops - 1);
      const values = evaluateSampledFunction(funcBytes, size, nOutputs, decode, t, bitsPerSample);
      let r; let g; let b;
      if (deviceNTintCS) {
        const rgb = tintComponentsToRGB(deviceNTintCS, values);
        if (rgb) { [r, g, b] = rgb; } else { r = 128; g = 128; b = 128; }
      } else if (sepTintSamples) {
        const sepMax = sepTintSamples.length / 3 - 1;
        const idx = Math.round(Math.max(0, Math.min(1, values[0])) * sepMax) * 3;
        r = sepTintSamples[idx]; g = sepTintSamples[idx + 1]; b = sepTintSamples[idx + 2];
      } else if (isCMYK && nOutputs >= 4) {
        const cc = Math.max(0, Math.min(1, values[0]));
        const mm = Math.max(0, Math.min(1, values[1]));
        const yy = Math.max(0, Math.min(1, values[2]));
        const kk = Math.max(0, Math.min(1, values[3]));
        [r, g, b] = cmykToRgb(cc, mm, yy, kk);
      } else {
        r = Math.round(Math.max(0, Math.min(1, values[0])) * 255);
        g = isGray ? r : Math.round(Math.max(0, Math.min(1, values[1])) * 255);
        b = isGray ? r : Math.round(Math.max(0, Math.min(1, values[2])) * 255);
      }
      stops.push({ offset: t, color: `rgb(${r},${g},${b})` });
    }
    return { type: shadingType, coords, stops };
  }

  if (funcType === 2) {
    const c0Str = resolveArrayValue(funcObjText, 'C0', objCache);
    const c1Str = resolveArrayValue(funcObjText, 'C1', objCache);
    const c0 = c0Str ? c0Str.split(/\s+/).map(Number) : [0];
    const c1 = c1Str ? c1Str.split(/\s+/).map(Number) : [1];
    const n = resolveNumValue(funcObjText, 'N', objCache, 1);
    const nStops = n === 1 ? 2 : 16;
    const stops = [];
    for (let i = 0; i < nStops; i++) {
      const t = i / (nStops - 1);
      const tN = t ** n;
      let r; let g; let b;
      if (deviceNTintCS) {
        // Multi-input DeviceN: interpolate ALL N components C0→C1, then run
        // them through the DeviceN tint transform to get RGB.
        const vals = c0.map((c0v, idx) => c0v + tN * (((c1[idx] != null) ? c1[idx] : 0) - c0v));
        const rgb = tintComponentsToRGB(deviceNTintCS, vals);
        if (rgb) { [r, g, b] = rgb; } else { r = 128; g = 128; b = 128; }
      } else if (sepTintSamples) {
        const val = Math.max(0, Math.min(1, c0[0] + tN * (c1[0] - c0[0])));
        const idx = Math.round(val * (sepTintSamples.length / 3 - 1)) * 3;
        r = sepTintSamples[idx]; g = sepTintSamples[idx + 1]; b = sepTintSamples[idx + 2];
      } else if (isCMYK && c0.length >= 4) {
        const cc = Math.max(0, Math.min(1, c0[0] + tN * (c1[0] - c0[0])));
        const mm = Math.max(0, Math.min(1, (c0[1] ?? 0) + tN * ((c1[1] ?? 0) - (c0[1] ?? 0))));
        const yy = Math.max(0, Math.min(1, (c0[2] ?? 0) + tN * ((c1[2] ?? 0) - (c0[2] ?? 0))));
        const kk = Math.max(0, Math.min(1, (c0[3] ?? 0) + tN * ((c1[3] ?? 0) - (c0[3] ?? 0))));
        [r, g, b] = cmykToRgb(cc, mm, yy, kk);
      } else {
        r = Math.round(Math.max(0, Math.min(1, c0[0] + tN * (c1[0] - c0[0]))) * 255);
        g = isGray ? r : Math.round(Math.max(0, Math.min(1, (c0[1] ?? 0) + tN * ((c1[1] ?? 1) - (c0[1] ?? 0)))) * 255);
        b = isGray ? r : Math.round(Math.max(0, Math.min(1, (c0[2] ?? 0) + tN * ((c1[2] ?? 1) - (c0[2] ?? 0)))) * 255);
      }
      stops.push({ offset: t, color: `rgb(${r},${g},${b})` });
    }
    return { type: shadingType, coords, stops };
  }

  if (funcType === 3) {
    const boundsStr = resolveArrayValue(funcObjText, 'Bounds', objCache);
    const encodeStr = resolveArrayValue(funcObjText, 'Encode', objCache);
    const funcsStr = resolveArrayValue(funcObjText, 'Functions', objCache);
    if (!funcsStr) return null;
    const bounds = boundsStr && boundsStr.trim()
      ? boundsStr.split(/\s+/).map(Number) : [];
    const encode = encodeStr ? encodeStr.split(/\s+/).map(Number) : [];
    // Sub-functions may be indirect refs (N 0 R) or inline dicts (<<...>>)
    const subFuncRefs = [...funcsStr.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
    const subFuncs = [];
    let hasSampledSub = false;
    if (subFuncRefs.length > 0) {
      for (let si = 0; si < subFuncRefs.length; si++) {
        const subText = objCache.getObjectText(subFuncRefs[si]);
        if (!subText) continue;
        const subFuncType = resolveIntValue(subText, 'FunctionType', objCache, 2);
        if (subFuncType === 0) {
          hasSampledSub = true;
          const sizeStr = resolveArrayValue(subText, 'Size', objCache);
          const decodeStr = resolveArrayValue(subText, 'Decode', objCache);
          const rangeStr = resolveArrayValue(subText, 'Range', objCache);
          const size = sizeStr ? Number(sizeStr.trim().split(/\s+/)[0]) : 256;
          const range = rangeStr ? rangeStr.split(/\s+/).map(Number) : (decodeStr ? decodeStr.split(/\s+/).map(Number) : [0, 1, 0, 1, 0, 1]);
          const decode = decodeStr ? decodeStr.split(/\s+/).map(Number) : range;
          const nOutputs = range.length / 2;
          const subBps = resolveIntValue(subText, 'BitsPerSample', objCache, 8);
          const funcBytes = objCache.getStreamBytes(subFuncRefs[si]);
          subFuncs.push({
            funcType: 0, samples: funcBytes, size, nOutputs, decode, bitsPerSample: subBps,
          });
        } else {
          const sc0Str = resolveArrayValue(subText, 'C0', objCache);
          const sc1Str = resolveArrayValue(subText, 'C1', objCache);
          subFuncs.push({
            funcType: 2,
            c0: sc0Str ? sc0Str.split(/\s+/).map(Number) : [0],
            c1: sc1Str ? sc1Str.split(/\s+/).map(Number) : [1],
            n: resolveNumValue(subText, 'N', objCache, 1),
          });
        }
      }
    } else {
      // Inline sub-function dicts: /Functions [ <<...>> <<...>> ... ]
      for (const m of funcsStr.matchAll(/<<([\s\S]*?)>>/g)) {
        const subText = m[1];
        const stMatch = /\/FunctionType\s+(\d+)/.exec(subText);
        if (stMatch && Number(stMatch[1]) !== 2) continue;
        const sc0Match = /\/C0\s*\[\s*([\d.\s-]+)\]/.exec(subText);
        const sc1Match = /\/C1\s*\[\s*([\d.\s-]+)\]/.exec(subText);
        const snMatch = /\/N\s+([\d.]+)/.exec(subText);
        subFuncs.push({
          funcType: 2,
          c0: sc0Match ? sc0Match[1].trim().split(/\s+/).map(Number) : [0],
          c1: sc1Match ? sc1Match[1].trim().split(/\s+/).map(Number) : [1],
          n: snMatch ? Number(snMatch[1]) : 1,
        });
      }
    }
    const domainBounds = [0, ...bounds, 1];
    const stops = [];
    const nStops = hasSampledSub ? 64 : 16;
    for (let i = 0; i < nStops; i++) {
      const t = i / (nStops - 1);
      let si = 0;
      for (let bi = 0; bi < bounds.length; bi++) {
        if (t >= bounds[bi]) si = bi + 1;
      }
      if (si >= subFuncs.length) si = subFuncs.length - 1;
      const sub = subFuncs[si];
      if (!sub) continue;
      const dLo = domainBounds[si];
      const dHi = domainBounds[si + 1];
      const eLo = encode.length > si * 2 ? encode[si * 2] : 0;
      const eHi = encode.length > si * 2 + 1 ? encode[si * 2 + 1] : 1;
      const tLocal = dHi > dLo ? (t - dLo) / (dHi - dLo) : 0;
      const tEncoded = eLo + tLocal * (eHi - eLo);
      const tClamped = Math.max(0, Math.min(1, tEncoded));
      let r; let g; let b;
      if (sub.funcType === 0) {
        const values = evaluateSampledFunction(sub.samples, sub.size, sub.nOutputs, sub.decode, tClamped, sub.bitsPerSample || 8);
        if (deviceNTintCS) {
          const rgb = tintComponentsToRGB(deviceNTintCS, values);
          if (rgb) { [r, g, b] = rgb; } else { r = 128; g = 128; b = 128; }
        } else if (sepTintSamples) {
          const sepMax = sepTintSamples.length / 3 - 1;
          const idx = Math.round(Math.max(0, Math.min(1, values[0])) * sepMax) * 3;
          r = sepTintSamples[idx]; g = sepTintSamples[idx + 1]; b = sepTintSamples[idx + 2];
        } else if (isCMYK && sub.nOutputs >= 4) {
          const cc = Math.max(0, Math.min(1, values[0]));
          const mm = Math.max(0, Math.min(1, values[1]));
          const yy = Math.max(0, Math.min(1, values[2]));
          const kk = Math.max(0, Math.min(1, values[3]));
          [r, g, b] = cmykToRgb(cc, mm, yy, kk);
        } else {
          r = Math.round(Math.max(0, Math.min(1, values[0])) * 255);
          g = isGray ? r : Math.round(Math.max(0, Math.min(1, values[1])) * 255);
          b = isGray ? r : Math.round(Math.max(0, Math.min(1, values[2])) * 255);
        }
      } else {
        const tN = tClamped ** sub.n;
        if (deviceNTintCS) {
          // Multi-input DeviceN: interpolate ALL N components C0→C1, then run
          // them through the DeviceN tint transform to get RGB.
          const vals = sub.c0.map((c0v, idx) => c0v + tN * (((sub.c1[idx] != null) ? sub.c1[idx] : 0) - c0v));
          const rgb = tintComponentsToRGB(deviceNTintCS, vals);
          if (rgb) { [r, g, b] = rgb; } else { r = 128; g = 128; b = 128; }
        } else if (sepTintSamples) {
          const val = Math.max(0, Math.min(1, sub.c0[0] + tN * (sub.c1[0] - sub.c0[0])));
          const sepMax = sepTintSamples.length / 3 - 1;
          const idx = Math.round(val * sepMax) * 3;
          r = sepTintSamples[idx]; g = sepTintSamples[idx + 1]; b = sepTintSamples[idx + 2];
        } else if (isCMYK && sub.c0.length >= 4) {
          const cc = Math.max(0, Math.min(1, sub.c0[0] + tN * (sub.c1[0] - sub.c0[0])));
          const mm = Math.max(0, Math.min(1, (sub.c0[1] ?? 0) + tN * ((sub.c1[1] ?? 0) - (sub.c0[1] ?? 0))));
          const yy = Math.max(0, Math.min(1, (sub.c0[2] ?? 0) + tN * ((sub.c1[2] ?? 0) - (sub.c0[2] ?? 0))));
          const kk = Math.max(0, Math.min(1, (sub.c0[3] ?? 0) + tN * ((sub.c1[3] ?? 0) - (sub.c0[3] ?? 0))));
          [r, g, b] = cmykToRgb(cc, mm, yy, kk);
        } else {
          r = Math.round(Math.max(0, Math.min(1, sub.c0[0] + tN * (sub.c1[0] - sub.c0[0]))) * 255);
          g = isGray ? r : Math.round(Math.max(0, Math.min(1, (sub.c0[1] ?? 0) + tN * ((sub.c1[1] ?? 1) - (sub.c0[1] ?? 0)))) * 255);
          b = isGray ? r : Math.round(Math.max(0, Math.min(1, (sub.c0[2] ?? 0) + tN * ((sub.c1[2] ?? 1) - (sub.c0[2] ?? 0)))) * 255);
        }
      }
      stops.push({ offset: t, color: `rgb(${r},${g},${b})` });
    }
    return { type: shadingType, coords, stops };
  }

  return null;
}

/**
 * Render an SMask Form XObject to a canvas and convert to a luminosity alpha mask.
 * Returns an OffscreenCanvas where each pixel's alpha = luminosity of the mask content.
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

  const { images: maskImages } = parsePageImages(formObjText, objCache, { recurseForms: false });

  const streamBytes = objCache.getStreamBytes(smaskInfo.formObjNum);
  if (!streamBytes) return null;
  const formStream = bytesToLatin1(streamBytes);

  const maskExtGStates = parseExtGStates(formObjText, objCache);
  const maskShadings = parseShadings(formObjText, objCache);
  const maskPatterns = parsePatterns(formObjText, objCache);

  const formDrawOps = parseDrawOps(formStream, new Map(), maskExtGStates, new Map(), new Map(),
    new Set(), new Set(), new Set(), maskShadings, maskPatterns);

  // Apply the form's /Matrix to each op's CTM (maps form space → user space)
  const matrixMatch = /\/Matrix\s*\[\s*([\d.\s-]+)\]/.exec(formObjText);
  if (matrixMatch) {
    const formMatrix = matrixMatch[1].trim().split(/\s+/).map(Number);
    if (formMatrix.length === 6) {
      for (const op of formDrawOps) {
        if (op.ctm) op.ctm = matMul(op.ctm, formMatrix);
      }
    }
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
  const maskCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (maskCanvas.getContext('2d'));

  // Fill with black (mask = 0 = fully transparent outside mask content)
  maskCtx.fillStyle = 'black';
  maskCtx.fillRect(0, 0, maskW, maskH);

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
      } else {
        maskCtx.fillStyle = op.fillColor || 'black';
        maskCtx.fill(op.evenOdd ? 'evenodd' : 'nonzero');
      }
      maskCtx.restore();
    }
  }

  // Convert rendered mask to luminosity alpha:
  // For each pixel, alpha = 0.299*R + 0.587*G + 0.114*B (scaled by pixel alpha)
  const maskData = maskCtx.getImageData(0, 0, maskW, maskH);
  const px = maskData.data;
  for (let i = 0; i < px.length; i += 4) {
    const luminosity = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    const alpha = px[i + 3] / 255;
    // Set pixel to white with alpha = luminosity * alpha
    px[i] = 255;
    px[i + 1] = 255;
    px[i + 2] = 255;
    px[i + 3] = Math.round(luminosity * alpha);
  }
  maskCtx.putImageData(maskData, 0, 0);

  return maskCanvas;
}

/**
 * Check if a Form XObject is hidden by Optional Content (OC).
 * @param {string} formObjText - The form XObject dictionary text
 * @param {Set<number>} offOCGs - Set of OCG object numbers that are OFF
 * @param {ObjectCache} objCache - PDF object cache
 */
function isFormOCHidden(formObjText, offOCGs, objCache) {
  if (offOCGs.size === 0) return false;
  const ocMatch = /\/OC\s+(\d+)\s+\d+\s+R/.exec(formObjText);
  if (!ocMatch) return false;
  const ocObjNum = Number(ocMatch[1]);
  const ocText = objCache.getObjectText(ocObjNum);
  if (!ocText) return false;
  // Direct OCG reference
  if (/\/Type\s*\/OCG/.test(ocText)) return offOCGs.has(ocObjNum);
  // OCMD — resolve /OCGs to OCG(s)
  if (/\/Type\s*\/OCMD/.test(ocText)) {
    const singleRef = /\/OCGs\s+(\d+)\s+\d+\s+R/.exec(ocText);
    if (singleRef) return offOCGs.has(Number(singleRef[1]));
    // Array of OCGs — default policy is AnyOn (visible if any ON)
    const arrayMatch = /\/OCGs\s*\[([^\]]*)\]/.exec(ocText);
    if (arrayMatch) {
      const refs = [...arrayMatch[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
      const policyMatch = /\/P\s*\/(\w+)/.exec(ocText);
      const policy = policyMatch ? policyMatch[1] : 'AnyOn';
      if (policy === 'AnyOn') return refs.every((r) => offOCGs.has(r));
      if (policy === 'AllOn') return refs.some((r) => offOCGs.has(r));
      if (policy === 'AnyOff') return !refs.some((r) => offOCGs.has(r));
      if (policy === 'AllOff') return !refs.every((r) => offOCGs.has(r));
    }
  }
  return false;
}

/**
 * Render a single PDF page to a PNG data URL, including raster images and Type3 font glyphs.
 *
 * @param {string} pageObjText - Raw text of the Page object
 * @param {ObjectCache} objCache - PDF object cache
 * @param {number[]} mediaBox - Page media box [x0, y0, x1, y1]
 * @param {number} pageIndex - Page index (for ImageWrapper)
 * @param {'color'|'gray'} [colorMode='color'] - Output color mode
 * @param {number} [rotate=0] - Page rotation in degrees
 * @returns {Promise<{dataUrl: string, colorMode: string}>} PNG data URL and effective color mode
 */
export async function renderPdfPageAsImage(pageObjText, objCache, mediaBox, pageIndex, colorMode = 'color', rotate = 0, dpi = 300) {
  // Optional Content visibility is a property of the document — fetch the
  // (cached) set of OCGs hidden in View mode from the ObjectCache so that
  // every caller of this function (worker, batch entry, tests) automatically
  // hides print-only watermark layers and other hidden OCGs.
  const offOCGs = objCache.getOffOCGs();
  const contentWidthPts = Math.abs(mediaBox[2] - mediaBox[0]);
  const contentHeightPts = Math.abs(mediaBox[3] - mediaBox[1]);
  // CropBox or other non-zero-origin boxes require coordinate offset
  const boxOriginX = mediaBox[0];
  const boxOriginY = mediaBox[1];

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
    const cCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (c.getContext('2d'));
    cCtx.fillStyle = 'white';
    cCtx.fillRect(0, 0, w, h);
    const _imgData = cCtx.getImageData(0, 0, w, h);
    const out = { dataUrl: await buildPngDataUrl(_imgData, 'gray'), colorMode: 'gray' };
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
    ? parseDrawOps(contentStreams, fonts, extGStates, registeredFontNames, colorSpaces, symbolFontTags, cidPUATags, rawCharCodeTags, pageShadings, pagePatterns, cidCollisionMap)
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
  if (forms.size > 0) {
    for (const op of rawDrawOps) {
      if (op.type === 'image') {
        const flattened = await flattenDrawOps(
          [op], images, forms, objCache, fonts, registeredFontNames,
          '', pageIndex, symbolFontTags, cidPUATags, extGStates, rawCharCodeTags,
          new Map(), 0, offOCGs, cidCollisionMap,
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
  /** @type {Map<number, import('./parsePdfAnnots.js').PdfHighlightRaw>} */
  const highlightByRef = new Map(annotsParsed.highlights.map((h) => [h.objNum, h]));
  const annotRefs = [
    ...annotsParsed.highlights.map((h) => h.objNum),
    ...annotsParsed.passthroughRefs,
  ];
  if (annotRefs.length > 0) {
    for (const annotRef of annotRefs) {
      const annotText = objCache.getObjectText(annotRef);
      if (!annotText) continue;

      const rectMatch = /\/Rect\s*\[\s*([\d.\-+e]+)\s+([\d.\-+e]+)\s+([\d.\-+e]+)\s+([\d.\-+e]+)\s*\]/.exec(annotText);
      if (!rectMatch) continue;
      const rect = [Number(rectMatch[1]), Number(rectMatch[2]), Number(rectMatch[3]), Number(rectMatch[4])];
      const rectW = rect[2] - rect[0];
      const rectH = rect[3] - rect[1];
      // Line annotations may have an empty Rect with endpoints defined by /L
      // Ink annotations may have inverted Rects (coords are in InkList, not Rect)
      const isLineAnnot = /\/Subtype\s*\/Line\b/.test(annotText);
      const isInkAnnot = /\/Subtype\s*\/Ink\b/.test(annotText);
      if ((rectW <= 0 || rectH <= 0) && !isLineAnnot && !isInkAnnot) continue;

      // Check annotation flags — skip if hidden (bit 2), invisible (bit 1), or NoView (bit 6)
      const flagsMatch = /\/F\s+(\d+)/.exec(annotText);
      const flags = flagsMatch ? Number(flagsMatch[1]) : 0;
      if (flags & 1 || flags & 2 || flags & 32) continue; // Invisible, Hidden, or NoView

      // Get normal appearance stream reference (/AP<</N objNum 0 R>>)
      // Also handle sub-state dictionaries (/AP<</N<</State1 obj1 0 R /State2 obj2 0 R>>>>)
      // used by checkboxes/radio buttons where /AS selects the current state.
      let apObjNum = null;
      const apDirectMatch = /\/AP\s*<<[\s\S]*?\/N\s+(\d+)\s+\d+\s+R/.exec(annotText);
      if (apDirectMatch) {
        apObjNum = Number(apDirectMatch[1]);
      } else {
        // Sub-state dict: /AP << /N << /Yes 31 0 R /Off 32 0 R >> >>
        const apDictMatch = /\/AP\s*<<[\s\S]*?\/N\s*<<([\s\S]*?)>>/.exec(annotText);
        if (apDictMatch) {
          const asMatch = /\/AS\s*\/(\w+)/.exec(annotText);
          const currentState = asMatch ? asMatch[1] : 'Off';
          const stateRefMatch = new RegExp(`\\/${currentState}\\s+(\\d+)\\s+\\d+\\s+R`).exec(apDictMatch[1]);
          if (stateRefMatch) apObjNum = Number(stateRefMatch[1]);
        }
      }

      if (apObjNum !== null) {
        const apObjText = objCache.getObjectText(apObjNum);
        if (!apObjText || !/\/Subtype\s*\/Form/.test(apObjText)) continue;

        const bboxMatch = /\/BBox\s*\[\s*([\d.\-+e]+)\s+([\d.\-+e]+)\s+([\d.\-+e]+)\s+([\d.\-+e]+)\s*\]/.exec(apObjText);
        const bbox = bboxMatch ? [Number(bboxMatch[1]), Number(bboxMatch[2]), Number(bboxMatch[3]), Number(bboxMatch[4])] : [0, 0, rectW, rectH];

        // Parse the appearance form's Matrix (defaults to identity).
        // flattenDrawOps will apply this Matrix to content coordinates, so we must
        // compute annotTransform relative to the post-Matrix BBox, not the original.
        const apMatrixMatch = /\/Matrix\s*\[\s*([\d.\-\s+e]+)\]/.exec(apObjText);
        const apMatrix = apMatrixMatch
          ? apMatrixMatch[1].trim().split(/\s+/).map(Number)
          : [1, 0, 0, 1, 0, 0];
        const corners = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]]];
        const txArr = corners.map(([x, y]) => x * apMatrix[0] + y * apMatrix[2] + apMatrix[4]);
        const tyArr = corners.map(([x, y]) => x * apMatrix[1] + y * apMatrix[3] + apMatrix[5]);
        const effBBox = [Math.min(...txArr), Math.min(...tyArr), Math.max(...txArr), Math.max(...tyArr)];
        const effW = effBBox[2] - effBBox[0];
        const effH = effBBox[3] - effBBox[1];

        // Compute transform: map effective (post-Matrix) BBox to annotation Rect
        const sx = effW > 0 ? rectW / effW : 1;
        const sy = effH > 0 ? rectH / effH : 1;
        const annotTransform = [sx, 0, 0, sy, rect[0] - effBBox[0] * sx, rect[1] - effBBox[1] * sy];

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
        for (const aOp of annotFlattened) drawOps.push(aOp);
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
  if (!pageHasColor) {
    for (const op of drawOps) {
      if (op.type === 'image') {
        const imgInfo = images.get(op.name);
        if (!imgInfo) continue;
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
      } else if ((op.type === 'type0text' || op.type === 'type3glyph') && op.fillColor && !isGrayColor(op.fillColor)) {
        pageHasColor = true;
        break;
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
  const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d'));
  ctx.imageSmoothingQuality = 'high';

  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  if (drawOps.length === 0) {
    const emptyImageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
    const out = { dataUrl: await buildPngDataUrl(emptyImageData, 'gray'), colorMode: 'gray' };
    ca.closeDrawable(canvas);
    return out;
  }

  // Declare caches before try so they're accessible in the finally cleanup block.
  /** @type {Map<string, CanvasPattern>} */
  const tilingPatternCache = new Map();
  /** @type {Map<string, ImageBitmap>} */
  const bitmapCache = new Map();
  const smaskCanvasCache = new Map();
  // `createPattern(canvas, …)` clones the source surface on every call on
  // Node; tracked here and disposed in the page-end `finally` block.
  /** @type {CanvasPattern[]} */
  const transientPatterns = [];

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
    }

    /**
     * Apply all clip paths from an op's clip stack to the canvas context.
     * Each clip intersects with the previous, matching PDF semantics for nested W/W* operators.
     * Text clips (from Tr modes 4-7) are skipped here — they are handled via compositing.
     */
    function applyClips(renderCtx, op) {
      if (!op.clips || op.clips.length === 0) return;
      for (const clip of op.clips) {
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
      // Some canvas backends drop clip regions with device-pixel coordinates exceeding ~1e9.
      // Scale BIG relative to page size and the perpendicular magnitude to stay in range.
      const perpMag = Math.sqrt(px * px + py * py) || 1;
      const BIG = Math.max(1e4, pageWidthPts * 10, pageHeightPts * 10) / perpMag;

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
      const mCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (maskCanvas.getContext('2d'));
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

    // Pre-render tiling patterns (PatternType 1) to CanvasPattern objects.
    // Each pattern's content stream is rendered once to a small canvas, then reused via createPattern().

    /**
     * Render a single tiling pattern tile and cache the resulting CanvasPattern.
     * @param {string} patName - Pattern name for cache key
     * @param {{ objNum: number, bbox: number[], xStep: number, yStep: number, matrix: number[], paintType: number }} tp - Tiling pattern metadata
     */
    async function renderTilingPatternTile(patName, tp) {
      if (tilingPatternCache.has(patName)) return;
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

      // Compute pattern tile size in pixels
      const bboxW = tp.bbox[2] - tp.bbox[0];
      const bboxH = tp.bbox[3] - tp.bbox[1];
      const matScaleX = Math.sqrt(tp.matrix[0] * tp.matrix[0] + tp.matrix[1] * tp.matrix[1]);
      const matScaleY = Math.sqrt(tp.matrix[2] * tp.matrix[2] + tp.matrix[3] * tp.matrix[3]);
      const tileW = Math.max(1, Math.round(bboxW * matScaleX * scale));
      const tileH = Math.max(1, Math.round(bboxH * matScaleY * scale));
      if (tileW > 4096 || tileH > 4096) return;

      const tileCanvas = ca.makeCanvas(tileW, tileH);
      const tileCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (tileCanvas.getContext('2d'));

      // Parse ExtGState, shadings, patterns, and color spaces from the pattern's resources
      const patExtGStates = parseExtGStates(patObjText, objCache);
      const patShadings = parseShadings(patObjText, objCache);
      const patPatterns = parsePatterns(patObjText, objCache);
      const patColorSpaces = parsePageColorSpaces(patObjText, objCache);

      const patRawDrawOps = parseDrawOps(patStream, patFonts, patExtGStates, patRegistered,
        patColorSpaces.size > 0 ? patColorSpaces : undefined, patSymbolTags, patCidPUATags,
        patRawCharCodeTags, patShadings, patPatterns, cidCollisionMap);

      // Expand Form XObjects in pattern draw ops (same as page-level expansion at lines 6591-6606)
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
            ? await imageMaskToBitmap(imgInfo, 'black', objCache)
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
              drawCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (tempCanvas.getContext('2d'));
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
              if (pop.tilingPattern.objNum && !tilingPatternCache.has(innerPatName)) {
                try { await renderTilingPatternTile(innerPatName, pop.tilingPattern); } catch { /* skip */ }
              }
              const innerBitmap = tilingPatternCache.get(innerPatName);
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
                const tempCtx2 = /** @type {OffscreenCanvasRenderingContext2D} */ (tempCanvas.getContext('2d'));
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
              if (!isEmbedded && tileHScale > 1.5) tileHScale = 1;
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
        }
      }

      const tileBitmap = await ca.createImageBitmapFromCanvas(tileCanvas);
      tilingPatternCache.set(patName, tileBitmap);
    }

    // Render page-level tiling patterns
    for (const [patName, patInfo] of pagePatterns) {
      if (!patInfo.tiling) continue;
      try { await renderTilingPatternTile(patName, patInfo.tiling); } catch { /* skip */ }
    }

    // Render any tiling patterns discovered in Form XObjects (referenced from draw ops)
    for (const op of drawOps) {
      if (op.tilingPattern && !tilingPatternCache.has(op.tilingPattern.patName)) {
      // Find the pattern's tiling metadata — search all pattern maps from the draw ops
      // The pattern info was stored on the op by parseDrawOps via the patterns map
        const patName = op.tilingPattern.patName;
        // Look up the pattern object from all parsed pattern sets
        for (const [, patInfo] of pagePatterns) {
          if (patInfo.tiling && tilingPatternCache.has(patName)) break;
        }
        // If still not cached, it came from a Form XObject — find it in the op's tiling data
        if (!tilingPatternCache.has(patName) && op.tilingPattern.objNum) {
          try { await renderTilingPatternTile(patName, op.tilingPattern); } catch { /* skip */ }
        }
      }
    }

    // Pre-create ImageBitmaps in parallel for all non-mask images referenced by draw ops.
    // This converts O(N) sequential `await createImageBitmap()` calls in the render loop
    // into a single parallel `await Promise.all()`, which is critical for pages with
    // thousands of tiny images (e.g., map tiles with 3000+ images).
    // Only activate for pages with many images to avoid any side effects on simpler pages.
    {
      const imageNames = new Set();
      for (const op of drawOps) {
        if (op.type === 'image') imageNames.add(op.name);
      }
      if (imageNames.size > 100) {
        const entries = [];
        for (const name of imageNames) {
          const info = images.get(name);
          if (info && !info.imageMask) {
            entries.push({ name, info });
          }
        }
        if (entries.length > 0) {
          const results = await Promise.all(entries.map((e) => imageInfoToBitmap(e.info, objCache).catch(() => null)));
          for (let i = 0; i < entries.length; i++) {
            if (results[i]) bitmapCache.set(entries[i].name, results[i]);
          }
        }
      }
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
          const tileCvs = tilingPatternCache.get(op.tilingPattern.patName);
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
            const tileW = Math.max(1, Math.round(bboxW * matScaleX * scale));
            const tileH = Math.max(1, Math.round(bboxH * matScaleY * scale));
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
          // Render Gouraud triangle with per-pixel barycentric interpolation.
          // Transform: page_to_device × composedBase × patternMatrix.
            const clipCtm = op.clips?.[op.clips.length - 1]?.ctm;
            rCtx.save();
            rCtx.clip(op.evenOdd ? 'evenodd' : 'nonzero');
            rCtx.setTransform(scale, 0, 0, -scale, -boxOriginX * scale, (pageHeightPts + boxOriginY) * scale);
            if (clipCtm) rCtx.transform(clipCtm[0], clipCtm[1], clipCtm[2], clipCtm[3], clipCtm[4], clipCtm[5]);
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

    /**
     * Decode an inline image (BI/ID/EI) and return an ImageBitmap.
     * Supports image masks with CCITTFaxDecode, DCTDecode (JPEG), and uncompressed data.
     */
    async function decodeInlineImage(op) {
      const { dictText, imageData } = op;
      // Map abbreviated inline image keys to standard names
      const getVal = (abbrev, full) => {
      // Match both `/F CCF` (space-separated) and `/F/CCF` (name value without space).
      // PDF inline image values can be names (prefixed with /), so capture with optional /.
      // Use negative lookahead (?![a-zA-Z]) so `/W` does not match inside `/Width`.
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
      // Parse filter(s) — can be a single name or an array like [ /A85 /Fl ]
      const filterMap = {
        CCF: 'CCITTFaxDecode', DCT: 'DCTDecode', Fl: 'FlateDecode', LZW: 'LZWDecode', RL: 'RunLengthDecode', AHx: 'ASCIIHexDecode', A85: 'ASCII85Decode',
      };
      let filters;
      const filterArrMatch = /\/(?:F|Filter)\s*\[\s*([^\]]+)\]/.exec(dictText);
      if (filterArrMatch) {
        filters = filterArrMatch[1].trim().split(/\s+/).map((f) => {
          const name = f.replace(/^\//, '');
          return filterMap[name] || name;
        });
      } else {
        const filterRaw = getVal('F', 'Filter') || '';
        const f = filterMap[filterRaw] || filterRaw;
        filters = f ? [f] : [];
      }
      // Resolve the inline image's color space.
      //
      // Per PDF spec §8.9.7, an inline image's /CS value is either one of the
      // standard device-name abbreviations (G, RGB, CMYK / DeviceGray, DeviceRGB,
      // DeviceCMYK) OR a name whose definition lives in the current Resources'
      // /ColorSpace subdictionary. The standard-name case is trivial; the
      // Resources-name case is the same lookup path that `cs`/`CS` operators
      // already go through, so we reuse the pre-built `colorSpaces` Map from
      // `parsePageColorSpaces()` (in closure). This is the broader fix the user
      // asked for: every code path that resolves a color-space name now consults
      // the single canonical registry, rather than each site rolling its own
      // half-supported subset of color-space forms.
      const csRaw = getVal('CS', 'ColorSpace') || '';
      const csMap = { G: 'DeviceGray', RGB: 'DeviceRGB', CMYK: 'DeviceCMYK' };
      let colorSpace = csMap[csRaw] || csRaw;
      /** @type {{type: string, indexedInfo: any, tintSamples: Uint8Array|null, nComponents: number, deviceNGrid: any}|null} */
      let resolvedCS = null;
      if (!['DeviceGray', 'DeviceRGB', 'DeviceCMYK'].includes(colorSpace)) {
      // Use the op's color space registry if present (carries the Form XObject's
      // /Resources/ColorSpace when the inline image is inside a Form), falling
      // back to the page-level registry in the closure.
        const csRegistry = op.colorSpaces || colorSpaces;
        const entry = csRegistry.get(csRaw);
        if (entry) {
          resolvedCS = entry;
          // Map the entry's type to a "family" that the byte-unpacker below uses
          // when it can't use an Indexed/tint lookup.
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
        // Handle inline array-form Indexed color space: /CS [ /Indexed ... ]
        // The getVal regex captures '[' when the value is an array, so detect and parse it here.
        if (!resolvedCS) {
          const inlineIdxDetect = /\/(?:CS|ColorSpace)\s*\[\s*\/Indexed\s/.exec(dictText);
          if (inlineIdxDetect) {
            const arrStart = dictText.indexOf('[', inlineIdxDetect.index);
            let depth = 0;
            let arrEnd = arrStart;
            for (let ci = arrStart; ci < dictText.length; ci++) {
              if (dictText[ci] === '[') depth++;
              else if (dictText[ci] === ']') { depth--; if (depth === 0) { arrEnd = ci + 1; break; } }
            }
            // Expand inline-image abbreviated base names before passing to shared parser
            let csText = dictText.substring(arrStart, arrEnd);
            csText = csText.replace(/\/Indexed(\s+)\/RGB\b/, '/Indexed$1/DeviceRGB')
              .replace(/\/Indexed(\s+)\/G\b/, '/Indexed$1/DeviceGray')
              .replace(/\/Indexed(\s+)\/CMYK\b/, '/Indexed$1/DeviceCMYK');
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

      // Convert imageData string to bytes (it's in latin1 encoding from the tokenizer)
      let data = new Uint8Array(imageData.length);
      for (let j = 0; j < imageData.length; j++) data[j] = imageData.charCodeAt(j);

      // Apply filters in order
      for (const filter of filters) {
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
          const decoded = decodeCCITTFax(data, params);
          data = new Uint8Array(decoded.buffer);
        } else if (filter === 'DCTDecode') {
        // JPEG data — create blob and decode (append EOI if missing)
          if (data.length >= 2 && !(data[data.length - 2] === 0xFF && data[data.length - 1] === 0xD9)) {
            const fixed = new Uint8Array(data.length + 2);
            fixed.set(data);
            fixed[data.length] = 0xFF;
            fixed[data.length + 1] = 0xD9;
            data = fixed;
          }
          return ca.createImageBitmapFromData(data);
        } else if (filter === 'FlateDecode') {
          let inflated = pakoInflate(data);
          if (!(inflated instanceof Uint8Array)) inflated = pakoInflatePartial(data);
          data = inflated;
          const dpMatch = /\/(?:DP|DecodeParms)\s*(?:\[\s*(?:null\s*)?)?<<([^>]*)>>/.exec(dictText);
          if (dpMatch) {
            // Inline images default /Columns to the image width when /DP omits it;
            // this differs from the spec default of 1 but matches what encoders
            // meant in practice (the raw predictor row width is the image width).
            let dpText = dpMatch[1];
            if (!/\/Columns\s+\d+/.test(dpText)) dpText = `/Columns ${width} ${dpText}`;
            data = applyPredictor(data, dpText, objCache);
          }
        } else if (filter === 'LZWDecode') {
          const { decodeLZW } = await import('./codecs/decodeLZW.js');
          data = decodeLZW(data, dictText);
        }
      }

      const invert = decode && decode[0] === 1;
      if (bpc === 1) {
        const rgba = new Uint8ClampedArray(width * height * 4);
        const rowBytes = Math.ceil(width / 8);
        if (isImageMask) {
        // Image mask: painted pixels use fill color, unpainted are transparent
          if (!op.fillColor || op.fillColor.includes('NaN')) return null;
          const cm = op.fillColor.match(/\d+/g) || ['0', '0', '0'];
          const fr = Number(cm[0]);
          const fg = Number(cm[1] || 0);
          const fb = Number(cm[2] || 0);
          for (let row = 0; row < height; row++) {
            for (let col = 0; col < width; col++) {
              const byteIdx = row * rowBytes + (col >> 3);
              const bit = (data[byteIdx] >> (7 - (col & 7))) & 1;
              const painted = invert ? bit === 1 : bit === 0;
              const px = (row * width + col) * 4;
              if (painted) {
                rgba[px] = fr; rgba[px + 1] = fg; rgba[px + 2] = fb; rgba[px + 3] = 255;
              }
            }
          }
        } else {
        // 1-bit grayscale image: render black pixels as opaque, white pixels as transparent.
        // This prevents white backgrounds in tiling pattern tiles from overwriting underlying content.
          for (let row = 0; row < height; row++) {
            for (let col = 0; col < width; col++) {
              const byteIdx = row * rowBytes + (col >> 3);
              const bit = (data[byteIdx] >> (7 - (col & 7))) & 1;
              const isBlack = invert ? bit === 1 : bit === 0;
              if (isBlack) {
                const px = (row * width + col) * 4;
                rgba[px] = 0; rgba[px + 1] = 0; rgba[px + 2] = 0; rgba[px + 3] = 255;
              }
            // White pixels remain transparent (0,0,0,0)
            }
          }
        }
        const imgData = new ImageData(rgba, width, height);
        return ca.createImageBitmapFromImageData(imgData);
      }

      // Multi-component uncompressed images. Indexed images are always 1 byte
      // per pixel (the byte is a palette index); we expand to RGB via the palette.
      // Separation/DeviceN similarly use 1 byte per pixel and go
      // through a pre-computed tint lookup. Plain DeviceGray/RGB/CMYK unpack
      // byte-by-byte as before.
      const rgba = new Uint8ClampedArray(width * height * 4);
      if (colorSpace === 'Indexed' && resolvedCS && resolvedCS.indexedInfo) {
        const { palette, hival, base } = resolvedCS.indexedInfo;
        const nComp = base === 'DeviceCMYK' ? 4 : (base === 'DeviceGray' || base === 'CalGray' ? 1 : 3);
        const maxIdx = Math.min(hival, Math.floor(palette.length / nComp) - 1);
        for (let j = 0; j < width * height; j++) {
          let idx = data[j] || 0;
          if (idx > maxIdx) idx = maxIdx;
          const po = idx * nComp;
          let r; let g; let b;
          if (nComp === 3) {
            r = palette[po]; g = palette[po + 1]; b = palette[po + 2];
          } else if (nComp === 1) {
            r = palette[po]; g = r; b = r;
          } else { // CMYK palette
            const [cr, cg, cb] = cmykToRgb(palette[po] / 255, palette[po + 1] / 255, palette[po + 2] / 255, palette[po + 3] / 255);
            r = cr; g = cg; b = cb;
          }
          rgba[j * 4] = r; rgba[j * 4 + 1] = g; rgba[j * 4 + 2] = b; rgba[j * 4 + 3] = 255;
        }
      } else if ((colorSpace === 'Separation' || colorSpace === 'DeviceN') && resolvedCS && resolvedCS.tintSamples) {
      // Single-input Separation/DeviceN: 1 byte per pixel, index into a 256-entry RGB tint LUT.
        const tint = resolvedCS.tintSamples;
        const tintMax = Math.floor(tint.length / 3) - 1;
        for (let j = 0; j < width * height; j++) {
          const idx = Math.min(data[j] || 0, tintMax) * 3;
          rgba[j * 4] = tint[idx]; rgba[j * 4 + 1] = tint[idx + 1]; rgba[j * 4 + 2] = tint[idx + 2]; rgba[j * 4 + 3] = 255;
        }
      } else {
        const nComponents = colorSpace === 'DeviceRGB' ? 3 : colorSpace === 'DeviceCMYK' ? 4 : 1;
        for (let j = 0; j < width * height; j++) {
          if (nComponents === 1) {
            const g = data[j] || 0;
            rgba[j * 4] = g; rgba[j * 4 + 1] = g; rgba[j * 4 + 2] = g; rgba[j * 4 + 3] = 255;
          } else if (nComponents === 3) {
            rgba[j * 4] = data[j * 3]; rgba[j * 4 + 1] = data[j * 3 + 1]; rgba[j * 4 + 2] = data[j * 3 + 2]; rgba[j * 4 + 3] = 255;
          } else if (nComponents === 4) {
            const c0 = data[j * 4]; const m0 = data[j * 4 + 1]; const y0 = data[j * 4 + 2]; const
              k0 = data[j * 4 + 3];
            const [cr, cg, cb] = cmykToRgb(c0 / 255, m0 / 255, y0 / 255, k0 / 255);
            rgba[j * 4] = cr; rgba[j * 4 + 1] = cg; rgba[j * 4 + 2] = cb; rgba[j * 4 + 3] = 255;
          }
        }
      }
      const imgData = new ImageData(rgba, width, height);
      return ca.createImageBitmapFromImageData(imgData);
    }

    async function renderSingleOp(rCtx, op) {
      if (op.type === 'image') {
        const imageInfo = images.get(op.name);
        if (!imageInfo) return;

        // For image masks with tiling pattern fill, composite the pattern through the mask
        if (imageInfo.imageMask && op.tilingPattern) {
          const tileCvs = tilingPatternCache.get(op.tilingPattern.patName);
          const canvasPat = tileCvs ? rCtx.createPattern(tileCvs, 'repeat') : null; if (canvasPat) transientPatterns.push(canvasPat);
          if (canvasPat) {
            const tileMaskKey = `${op.name}|rgb(255,255,255)`;
            const cachedTileMask = bitmapCache.get(tileMaskKey);
            const maskBitmap = cachedTileMask || await imageMaskToBitmap(imageInfo, 'rgb(255,255,255)', objCache);
            const imgW = Math.max(1, Math.round(Math.sqrt(op.ctm[0] * op.ctm[0] + op.ctm[1] * op.ctm[1]) * scale));
            const imgH = Math.max(1, Math.round(Math.sqrt(op.ctm[2] * op.ctm[2] + op.ctm[3] * op.ctm[3]) * scale));
            if (imgW <= 4096 && imgH <= 4096) {
              const tmpCanvas = ca.makeCanvas(imgW, imgH);
              const tmpCtx = tmpCanvas.getContext('2d');
              tmpCtx.drawImage(maskBitmap, 0, 0, imgW, imgH);
              tmpCtx.globalCompositeOperation = 'source-in';
              const tp = op.tilingPattern;
              const bboxW = tp.bbox[2] - tp.bbox[0];
              const bboxH = tp.bbox[3] - tp.bbox[1];
              const matScaleX = Math.sqrt(tp.matrix[0] * tp.matrix[0] + tp.matrix[1] * tp.matrix[1]) || 1;
              const matScaleY = Math.sqrt(tp.matrix[2] * tp.matrix[2] + tp.matrix[3] * tp.matrix[3]) || 1;
              const tileW = Math.max(1, Math.round(bboxW * matScaleX * scale));
              const tileH = Math.max(1, Math.round(bboxH * matScaleY * scale));
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

        const maskFillColor = op.fillColor;
        const cachedBitmap = bitmapCache.get(op.name);
        const bitmap = cachedBitmap || (imageInfo.imageMask
          ? await imageMaskToBitmap(imageInfo, maskFillColor, objCache)
          : await imageInfoToBitmap(imageInfo, objCache));
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

        // Only close bitmaps that were created on-demand (not from the pre-creation cache)
        if (!cachedBitmap) ca.closeDrawable(bitmap);
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
                    : await imageInfoToBitmap(imageInfo, objCache);
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
            rCtx.lineWidth = pathData.lineWidth || 1;
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

        // For non-embedded fonts, scale each glyph horizontally so its rendered width
        // matches the PDF-specified width. The substitute font (e.g. NimbusSans for
        // ArialNarrow) may have different glyph widths than the original font.
        // For generic CSS fallback fonts (not _pdf_*), cap the scale factor to avoid
        // extreme distortion — e.g., CJK full-width metrics (500) on proportional Latin
        // sans-serif "i" (0.222) would stretch to 225% without capping.
        let hScale = 1;
        if (op.pdfGlyphWidth !== undefined) {
          const measuredWidth = rCtx.measureText(op.text).width;
          if (measuredWidth > 0) {
            // pdfGlyphWidth is in 1/1000 of the font's em square; measuredWidth is in
            // em-units at 1px font size.
            hScale = op.pdfGlyphWidth / (1000 * measuredWidth);
            if (!isEmbedded && hScale > 1.5) hScale = 1;
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
          const tileCvs = tilingPatternCache.get(op.tilingPattern.patName);
          const canvasPat = tileCvs ? rCtx.createPattern(tileCvs, 'repeat') : null; if (canvasPat) transientPatterns.push(canvasPat);
          if (canvasPat) {
            const tp = op.tilingPattern;
            const bboxW = tp.bbox[2] - tp.bbox[0];
            const bboxH = tp.bbox[3] - tp.bbox[1];
            const matScaleX = Math.sqrt(tp.matrix[0] * tp.matrix[0] + tp.matrix[1] * tp.matrix[1]);
            const matScaleY = Math.sqrt(tp.matrix[2] * tp.matrix[2] + tp.matrix[3] * tp.matrix[3]);
            const tileW = Math.max(1, Math.round(bboxW * matScaleX * scale));
            const tileH = Math.max(1, Math.round(bboxH * matScaleY * scale));
            const sx = bboxW / tileW * scale;
            const sy = bboxH / tileH * scale;
            // Device-space pattern matrix: maps pattern source pixels to device pixels.
            // This is identical to the matrix used in the path-fill branch (line ~7870),
            // which works because that branch switches the canvas CTM to identity before
            // calling fillRect — so canvas CTM × pattern matrix = identity × dm = dm.
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
          // Shading pattern coordinates are in PDF page space; transform to text canvas-local space.
          // The text canvas setTransform is [op.a, -op.b, -op.c, op.d, ...] with an extra hScale
          // multiplying the first column. Inverting that system gives these formulas.
          const det = op.a * op.d - op.b * op.c;
          if (det !== 0 && sh.coords && sh.stops) {
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
              const [x0, y0] = txCoord(sh.coords[0], sh.coords[1]);
              const [x1, y1] = txCoord(sh.coords[2], sh.coords[3]);
              grad = rCtx.createLinearGradient(x0, y0, x1, y1);
            } else if (sh.type === 3) {
              const [x0, y0] = txCoord(sh.coords[0], sh.coords[1]);
              const [x1, y1] = txCoord(sh.coords[3], sh.coords[4]);
              const avgScale = Math.sqrt(Math.abs(det)) * hScale;
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
              const clipCtm2 = op.clips?.[op.clips.length - 1]?.ctm;
              rCtx.save();
              rCtx.clip(op.evenOdd ? 'evenodd' : 'nonzero');
              rCtx.setTransform(scale, 0, 0, -scale, -boxOriginX * scale, (pageHeightPts + boxOriginY) * scale);
              if (clipCtm2) rCtx.transform(clipCtm2[0], clipCtm2[1], clipCtm2[2], clipCtm2[3], clipCtm2[4], clipCtm2[5]);
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
            // Build a Canvas gradient whose axis is in the shading pattern's coordinate space
            // (transformed by patternBaseCTM and the pattern Matrix). The current path
            // drawing transform is temporarily replaced during construction so the
            // gradient axis is baked in device pixels; it remains positioned correctly
            // after restoring the path CTM for the actual stroke() call.
              rCtx.save();
              const bctm = op.patternBaseCTM;
              rCtx.setTransform(scale, 0, 0, -scale, -boxOriginX * scale, (pageHeightPts + boxOriginY) * scale);
              if (bctm) rCtx.transform(bctm[0], bctm[1], bctm[2], bctm[3], bctm[4], bctm[5]);
              if (sh.matrix) rCtx.transform(...sh.matrix);
              let grad;
              if (sh.type === 2) {
                grad = rCtx.createLinearGradient(sh.coords[0], sh.coords[1], sh.coords[2], sh.coords[3]);
              } else {
                grad = rCtx.createRadialGradient(sh.coords[0], sh.coords[1], sh.coords[2], sh.coords[3], sh.coords[4], sh.coords[5]);
              }
              for (const stop of sh.stops) grad.addColorStop(stop.offset, stop.color);
              rCtx.restore();
              strokeStyleVal = grad;
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
        // Skip degenerate transforms (zero-size images from pattern sub-streams)
          if (Math.abs(op.ctm[0]) < 1e-6 && Math.abs(op.ctm[3]) < 1e-6) {
          // degenerate CTM — skip
          } else if (op.tilingPattern) {
          // Image mask with tiling pattern fill: render mask as white bitmap,
          // composite cached tiling pattern through it via source-in, then draw result.
            const tileCvs = tilingPatternCache.get(op.tilingPattern.patName);
            const canvasPat = tileCvs ? rCtx.createPattern(tileCvs, 'repeat') : null; if (canvasPat) transientPatterns.push(canvasPat);
            const maskOp = { ...op, fillColor: 'rgb(255,255,255)' };
            const maskBitmap = canvasPat ? await decodeInlineImage(maskOp) : null;
            if (maskBitmap && canvasPat) {
              const imgW = Math.max(1, Math.round(Math.sqrt(op.ctm[0] * op.ctm[0] + op.ctm[1] * op.ctm[1]) * scale));
              const imgH = Math.max(1, Math.round(Math.sqrt(op.ctm[2] * op.ctm[2] + op.ctm[3] * op.ctm[3]) * scale));
              if (imgW <= 4096 && imgH <= 4096) {
                const tmpCanvas = ca.makeCanvas(imgW, imgH);
                const tmpCtx = tmpCanvas.getContext('2d');
                tmpCtx.drawImage(maskBitmap, 0, 0, imgW, imgH);
                tmpCtx.globalCompositeOperation = 'source-in';
                const tp = op.tilingPattern;
                const bboxW = tp.bbox[2] - tp.bbox[0];
                const bboxH = tp.bbox[3] - tp.bbox[1];
                const matScaleX = Math.sqrt(tp.matrix[0] * tp.matrix[0] + tp.matrix[1] * tp.matrix[1]) || 1;
                const matScaleY = Math.sqrt(tp.matrix[2] * tp.matrix[2] + tp.matrix[3] * tp.matrix[3]) || 1;
                const tileW = Math.max(1, Math.round(bboxW * matScaleX * scale));
                const tileH = Math.max(1, Math.round(bboxH * matScaleY * scale));
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
              // Debug: read back what we just drew
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
      let prevSmaskKey = '';
      for (const op of drawOps) {
        const outerSmask = op.outerSmask || null;
        const smask = op.smask || null;
        // Ops with outerSmask group by the outer mask (form-level); inner masks handled within.
        // Ops with only smask group by that smask (existing behavior).
        const key = outerSmask ? `outer:${outerSmask.formObjNum}` : (smask ? String(smask.formObjNum) : '');
        if (key !== prevSmaskKey || opGroups.length === 0) {
          opGroups.push({ smask: outerSmask || smask, outerSmask, ops: [op] });
          prevSmaskKey = key;
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
          subCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (subCanvas.getContext('2d'));
        }

        for (const op of sub.ops) {
          const textClipCharsForOp = getTextClip(op);
          const savedCtx = subCtx;
          let textClipCanvas = null;
          if (textClipCharsForOp) {
            textClipCanvas = ca.makeCanvas(canvasWidth, canvasHeight);
            subCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (textClipCanvas.getContext('2d'));
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
          const cacheKey = sub.smask.formObjNum;
          let maskCanvas = smaskCanvasCache.get(cacheKey);
          if (!maskCanvas) {
            maskCanvas = await renderSMaskToCanvas(sub.smask, objCache, canvasWidth, canvasHeight, pageHeightPts, boxOriginX, boxOriginY, scale);
            if (maskCanvas) smaskCanvasCache.set(cacheKey, maskCanvas);
          }
          if (maskCanvas) {
            subCtx.globalCompositeOperation = 'destination-in';
            subCtx.drawImage(maskCanvas, 0, 0);
            ca.closeDrawable(maskCanvas);
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

    for (let groupIdx = 0; groupIdx < opGroups.length; groupIdx++) {
      const group = opGroups[groupIdx];
      if (group.outerSmask) {
      // Two-level masking: render all ops (with inner SMask handling) to a group canvas,
      // then apply the outer (form-level) SMask to the combined result.
        const groupCanvas = ca.makeCanvas(canvasWidth, canvasHeight);
        const groupCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (groupCanvas.getContext('2d'));

        await renderOpsWithInnerSmask(groupCtx, group.ops);

        // Apply the outer (form-level) SMask to the combined group result
        const cacheKey = group.outerSmask.formObjNum;
        let maskCanvas = smaskCanvasCache.get(cacheKey);
        if (!maskCanvas) {
          maskCanvas = await renderSMaskToCanvas(group.outerSmask, objCache, canvasWidth, canvasHeight, pageHeightPts, boxOriginX, boxOriginY, scale);
          if (maskCanvas) smaskCanvasCache.set(cacheKey, maskCanvas);
        }
        if (maskCanvas) {
          groupCtx.globalCompositeOperation = 'destination-in';
          groupCtx.drawImage(maskCanvas, 0, 0);
          ca.closeDrawable(maskCanvas);
          groupCtx.globalCompositeOperation = 'source-over';
        }
        ctx.drawImage(groupCanvas, 0, 0);
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
              const tightCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (tightCanvas.getContext('2d'));
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
              // Blit tight result into main canvas at bbox position, with blend mode.
              const fastBlend = fastOp.blendMode;
              if (fastBlend && fastBlend !== 'Normal') {
                ctx.globalCompositeOperation = pdfBlendToCanvas[fastBlend] || fastBlend.toLowerCase();
              }
              ctx.drawImage(tightCanvas, bboxX, bboxY);
              ca.closeDrawable(tightCanvas);
              if (fastBlend && fastBlend !== 'Normal') {
                ctx.globalCompositeOperation = 'source-over';
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
          if (allShare) {
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
              const dx = -fbBboxX / scale;
              const dy = fbBboxY / scale;
              const shiftClips = (/** @type {any[]|undefined} */ clips) => (clips ? clips.map((/** @type {any} */ c) => ({
                ...c,
                ctm: c.ctm ? [c.ctm[0], c.ctm[1], c.ctm[2], c.ctm[3], c.ctm[4] + dx, c.ctm[5] + dy] : c.ctm,
              })) : clips);
              const shiftOp = (/** @type {any} */ op) => {
                /** @type {any} */
                const out = { ...op };
                if (op.clips) out.clips = shiftClips(op.clips);
                if (op.smask && op.smask.parentCtm) {
                  out.smask = {
                    ...op.smask,
                    parentCtm: [op.smask.parentCtm[0], op.smask.parentCtm[1], op.smask.parentCtm[2], op.smask.parentCtm[3],
                      op.smask.parentCtm[4] + dx, op.smask.parentCtm[5] + dy],
                  };
                }
                if (Array.isArray(op.ctm) && op.ctm.length === 6) {
                  out.ctm = [op.ctm[0], op.ctm[1], op.ctm[2], op.ctm[3], op.ctm[4] + dx, op.ctm[5] + dy];
                } else if (Array.isArray(op.transform) && op.transform.length === 6) {
                  out.transform = [op.transform[0], op.transform[1], op.transform[2], op.transform[3], op.transform[4] + dx, op.transform[5] + dy];
                } else if (op.type === 'type0text') {
                  out.x = op.x + dx;
                  out.y = op.y + dy;
                }
                return out;
              };

              const fbBbox = {
                x: fbBboxX, y: fbBboxY, width: fbBboxW, height: fbBboxH,
              };
              const fbMaskCanvas = await renderSMaskToCanvas(
                group.smask, objCache, canvasWidth, canvasHeight,
                pageHeightPts, boxOriginX, boxOriginY, scale,
                fbBbox,
              );
              if (fbMaskCanvas) {
                const tightCanvas = ca.makeCanvas(fbBboxW, fbBboxH);
                const tightCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (tightCanvas.getContext('2d'));
                for (const op of group.ops) {
                  const shiftedOp = shiftOp(op);
                  if (!renderPathOpSync(tightCtx, shiftedOp)) await renderSingleOp(tightCtx, shiftedOp);
                }
                tightCtx.globalCompositeOperation = 'destination-in';
                tightCtx.drawImage(fbMaskCanvas, 0, 0);
                ca.closeDrawable(fbMaskCanvas);
                tightCtx.globalCompositeOperation = 'source-over';

                const groupBlend = group.ops.length > 0 && group.ops[0].blendMode;
                if (groupBlend && groupBlend !== 'Normal') {
                  ctx.globalCompositeOperation = pdfBlendToCanvas[groupBlend] || groupBlend.toLowerCase();
                }
                ctx.drawImage(tightCanvas, fbBboxX, fbBboxY);
                ca.closeDrawable(tightCanvas);
                if (groupBlend && groupBlend !== 'Normal') {
                  ctx.globalCompositeOperation = 'source-over';
                }
                formBBoxFastHandled = true;
              }
            }
          }
        }
        if (formBBoxFastHandled) continue;

        // Single-level masking (existing behavior): render ops to group canvas, apply mask
        const groupCanvas = ca.makeCanvas(canvasWidth, canvasHeight);
        const renderCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (groupCanvas.getContext('2d'));

        for (const op of group.ops) {
          const textClipCharsForOp = getTextClip(op);
          let opCtx = renderCtx;
          let textClipCanvas = null;
          if (textClipCharsForOp) {
            textClipCanvas = ca.makeCanvas(canvasWidth, canvasHeight);
            opCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (textClipCanvas.getContext('2d'));
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

        const cacheKey = group.smask.formObjNum;
        let maskCanvas = smaskCanvasCache.get(cacheKey);
        if (!maskCanvas) {
          maskCanvas = await renderSMaskToCanvas(group.smask, objCache, canvasWidth, canvasHeight, pageHeightPts, boxOriginX, boxOriginY, scale);
          if (maskCanvas) smaskCanvasCache.set(cacheKey, maskCanvas);
        }
        if (maskCanvas) {
          renderCtx.globalCompositeOperation = 'destination-in';
          renderCtx.drawImage(maskCanvas, 0, 0);
          ca.closeDrawable(maskCanvas);
          renderCtx.globalCompositeOperation = 'source-over';
        }
        const groupBlend = group.ops.length > 0 && group.ops[0].blendMode;
        if (groupBlend && groupBlend !== 'Normal') {
          ctx.globalCompositeOperation = pdfBlendToCanvas[groupBlend] || groupBlend.toLowerCase();
        }
        ctx.drawImage(groupCanvas, 0, 0);
        ca.closeDrawable(groupCanvas);
        if (groupBlend && groupBlend !== 'Normal') {
          ctx.globalCompositeOperation = 'source-over';
        }
      } else {
        // No masking: render directly to main canvas
        for (let opIdx = 0; opIdx < group.ops.length; opIdx++) {
          const op = group.ops[opIdx];

          // Gouraud ops render normally through renderPathOpSync (no skip).

          const textClipCharsForOp = getTextClip(op);
          let opCtx = ctx;
          let textClipCanvas = null;
          if (textClipCharsForOp) {
            textClipCanvas = ca.makeCanvas(canvasWidth, canvasHeight);
            opCtx = /** @type {OffscreenCanvasRenderingContext2D} */ (textClipCanvas.getContext('2d'));
          }

          if (!renderPathOpSync(opCtx, op)) await renderSingleOp(opCtx, op);

          if (textClipCanvas && textClipCharsForOp) {
            const mCanvas = ca.makeCanvas(canvasWidth, canvasHeight);
            drawTextClipMask(mCanvas, textClipCharsForOp);
            opCtx.globalCompositeOperation = 'destination-in';
            opCtx.drawImage(mCanvas, 0, 0);
            ca.closeDrawable(mCanvas);
            opCtx.globalCompositeOperation = 'source-over';
            ctx.drawImage(textClipCanvas, 0, 0);
            ca.closeDrawable(textClipCanvas);
          }
        }
      }
    }
  } finally {
    // Dispose every cached Skia surface regardless of whether rendering threw.
    for (const bmp of bitmapCache.values()) ca.closeDrawable(bmp);
    for (const bmp of tilingPatternCache.values()) ca.closeDrawable(bmp);
    for (const cvs of smaskCanvasCache.values()) ca.closeDrawable(cvs);
    for (const p of transientPatterns) ca.closeDrawable(p);
    bitmapCache.clear();
    tilingPatternCache.clear();
    smaskCanvasCache.clear();
    transientPatterns.length = 0;
  }

  // Encode via `buildPngDataUrl` (not `canvas.toBuffer('image/png')`):
  // smaller output (RGB-only, 1-channel gray) and avoids SkPngEncoder's
  // buffer retention.
  const imageData = ctx.getImageData(0, 0, canvasWidth, canvasHeight);
  const result = { dataUrl: await buildPngDataUrl(imageData, effectiveColorMode), colorMode: effectiveColorMode };
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

/**
 * Deflate for the compressed PNG path.
 * Node: zlib.deflateSync (sync, default level 6) — ~10% faster than piping
 * through CompressionStream because we avoid microtask overhead.
 * Browser: CompressionStream('deflate') (async).
 *
 * We deliberately did NOT extract pako deflate for the browser sync path.
 * A sync pako.deflate at default level runs ~4× slower than CompressionStream
 * on typical page-sized inputs. This is different from inflate.
 *
 * @param {Uint8Array} raw
 * @returns {Promise<Uint8Array>|Uint8Array}
 */
function deflateCompressed(raw) {
  if (zlibDeflateSync) return zlibDeflateSync(raw);
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
 * Build a compressed PNG data URL from RGBA canvas ImageData. Uses filter
 * Up + default-level deflate, byte-compatible with the previous encoder's
 * output when invoked in Node (both use zlib's default level 6).
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

/**
 * Render all pages of a PDF to PNG data URLs.
 *
 * @param {Uint8Array|ArrayBuffer} pdfData - Raw PDF file data
 * @param {number} [minPage=0] - First page to render
 * @param {number} [maxPage=-1] - Last page to render (-1 = all)
 * @param {'color'|'gray'} [colorMode='color'] - Output color mode
 * @returns {Promise<{dataUrls: string[], colorModes: string[]}>} PNG data URLs and per-page effective color modes
 */
export async function renderPdfPages(pdfData, minPage = 0, maxPage = -1, colorMode = 'color') {
  // Ensure canvas backend is initialized before any sync canvas operations (Node.js only)
  if (ca.isNode) await ca.getCanvasNode();

  const pdfBytes = pdfData instanceof Uint8Array ? pdfData : new Uint8Array(pdfData);

  const xrefOffset = findXrefOffset(pdfBytes);
  const xrefEntries = parseXref(pdfBytes, xrefOffset);
  const objCache = new ObjectCache(pdfBytes, xrefEntries);
  const pageObjects = getPageObjects(objCache);

  const lastPage = maxPage === -1 ? pageObjects.length - 1 : Math.min(maxPage, pageObjects.length - 1);

  /** @type {string[]} */
  const dataUrls = [];
  /** @type {string[]} */
  const colorModes = [];
  try {
    for (let i = minPage; i <= lastPage; i++) {
      const {
        objText, mediaBox, cropBox, rotate,
      } = pageObjects[i];
      // Per PDF spec §10.10.1, the effective crop region is the intersection of CropBox
      // and MediaBox. Some spread PDFs have CropBox spanning two pages while MediaBox
      // defines the single page — using CropBox alone would render at double width.
      let effectiveBox = mediaBox;
      if (cropBox) {
        effectiveBox = [
          Math.max(cropBox[0], mediaBox[0]),
          Math.max(cropBox[1], mediaBox[1]),
          Math.min(cropBox[2], mediaBox[2]),
          Math.min(cropBox[3], mediaBox[3]),
        ];
      }
      const result = await renderPdfPageAsImage(objText, objCache, effectiveBox, i, colorMode, rotate);
      dataUrls.push(result.dataUrl);
      colorModes.push(result.colorMode);
    }
  } finally {
    // Release per-document fonts even on mid-batch throw.
    if (ca.isNode) ca.unregisterFontsMatching((name) => name.startsWith(`_pdf_d${objCache.docId}_`));
  }

  return { dataUrls, colorModes };
}
