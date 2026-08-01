// These ops are only correct inside the caller's overlay `cm`, which applies px-to-pt scaling and page rotation.
import { deflateBytes } from './writePdfStreams.js';
import { base64ToBytes, getPngIHDRInfo } from '../../utils/imageUtils.js';
import { createImageXObjectJpeg, createImageXObjectPng } from './writePdfImages.js';
import { hex } from './writePdfFonts.js';

const zlibInflateSync = (typeof process !== 'undefined' && typeof process.versions?.node === 'string')
  ? (await import('node:zlib')).inflateSync
  : null;

/**
 * Decompress a zlib-wrapped deflate stream.
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
async function inflateBytes(bytes) {
  if (zlibInflateSync) return new Uint8Array(zlibInflateSync(bytes));
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Emit an 8-bit image XObject from raw samples.
 * @param {number} objNum
 * @param {Uint8Array} pixels
 * @param {number} width
 * @param {number} height
 * @param {'DeviceRGB'|'DeviceGray'} colorSpace
 * @param {?number} smaskObjNum
 * @param {boolean} humanReadable
 * @returns {Promise<string | import('./writePdfStreams.js').PdfBinaryObject>}
 */
async function rawImageObject(objNum, pixels, width, height, colorSpace, smaskObjNum, humanReadable) {
  const deflated = await deflateBytes(pixels);
  let dict = `${objNum} 0 obj\n<</Type /XObject\n/Subtype /Image\n/Width ${width}\n/Height ${height}\n`;
  dict += `/ColorSpace /${colorSpace}\n/BitsPerComponent 8\n`;
  if (smaskObjNum != null) dict += `/SMask ${smaskObjNum} 0 R\n`;
  if (humanReadable) {
    const hexStr = hex(deflated.buffer);
    return `${dict}/Filter [ /ASCIIHexDecode /FlateDecode ]\n/Length ${hexStr.length}\n>>\nstream\n${hexStr}\nendstream\nendobj\n\n`;
  }
  return {
    header: `${dict}/Filter /FlateDecode\n/Length ${deflated.length}\n>>\nstream\n`,
    streamData: deflated,
    trailer: '\nendstream\nendobj\n\n',
  };
}

/**
 * Build the content operators for a page's fill & sign items.
 * @param {Object} args
 * @param {Annotation[]} args.pageAnnotations
 * @param {?{width: number, height: number}} args.pixelDims
 * @param {() => number} args.allocObjNum
 * @param {(obj: {objNum: number, content: string | import('./writePdfStreams.js').PdfBinaryObject}) => void} args.pushObj
 * @param {boolean} args.humanReadable
 * @param {?function(string): void} [args.warningHandler]
 * @returns {Promise<?{ ops: string, xobjEntriesStr: string }>}
 */
export async function buildFillItemOps({
  pageAnnotations, pixelDims, allocObjNum, pushObj, humanReadable, warningHandler,
}) {
  const items = /** @type {Array<AnnotationInk | AnnotationStamp>} */ (pageAnnotations.filter((a) => a.type === 'ink' || a.type === 'stamp'));
  if (items.length === 0 || !pixelDims) return null;
  const pixH = pixelDims.height;
  const fmt = (v) => String(Math.round(v * 100) / 100);
  let ops = '';
  let xobjEntriesStr = '';

  for (const item of items) {
    if (item.type === 'ink') {
      const colorM = /^#([0-9A-Fa-f]{6})$/.exec(item.color || '#000000');
      const [r, g, b] = colorM
        ? [0, 2, 4].map((o) => Math.round((parseInt(colorM[1].slice(o, o + 2), 16) / 255) * 1000) / 1000)
        : [0, 0, 0];
      ops += `q\n${r} ${g} ${b} RG\n${fmt(item.width)} w\n1 J\n1 j\n`;
      for (const stroke of item.strokes || []) {
        if (!stroke.length) continue;
        ops += `${fmt(stroke[0][0])} ${fmt(pixH - stroke[0][1])} m\n`;
        for (let p = 1; p < stroke.length; p++) ops += `${fmt(stroke[p][0])} ${fmt(pixH - stroke[p][1])} l\n`;
        // A single tap still draws because round caps turn a zero-length segment into a dot.
        if (stroke.length === 1) ops += `${fmt(stroke[0][0])} ${fmt(pixH - stroke[0][1])} l\n`;
        ops += 'S\n';
      }
      ops += 'Q\n';
      continue;
    }

    const srcM = /^data:image\/(png|jpeg);base64,(.*)$/s.exec(item.imageData || '');
    if (!srcM) {
      if (typeof warningHandler === 'function') warningHandler('A placed image is not a PNG/JPEG data URL; it was left out of the export.');
      continue;
    }
    const bytes = base64ToBytes(item.imageData);
    let name = null;
    if (srcM[1] === 'jpeg') {
      const dims = parseJpegDims(bytes);
      if (!dims) {
        if (typeof warningHandler === 'function') warningHandler('A placed JPEG could not be parsed; it was left out of the export.');
        continue;
      }
      const objNum = allocObjNum();
      pushObj({ objNum, content: createImageXObjectJpeg(objNum, bytes.buffer, dims.width, dims.height, humanReadable) });
      name = `SigImg${objNum}`;
      xobjEntriesStr += `/${name} ${objNum} 0 R\n`;
    } else {
      const ihdr = getPngIHDRInfo(bytes);
      if (ihdr.colorType === 2 && ihdr.bitDepth === 8) {
        const objNum = allocObjNum();
        pushObj({ objNum, content: createImageXObjectPng(objNum, bytes.buffer, undefined, humanReadable) });
        name = `SigImg${objNum}`;
        xobjEntriesStr += `/${name} ${objNum} 0 R\n`;
      } else if (ihdr.colorType === 6 && ihdr.bitDepth === 8) {
        const rgba = unfilterPngScanlines(await inflateBytes(concatIdat(bytes)), ihdr.width, ihdr.height, 4);
        const rgb = new Uint8Array(ihdr.width * ihdr.height * 3);
        const alpha = new Uint8Array(ihdr.width * ihdr.height);
        for (let p = 0; p < ihdr.width * ihdr.height; p++) {
          rgb[p * 3] = rgba[p * 4];
          rgb[p * 3 + 1] = rgba[p * 4 + 1];
          rgb[p * 3 + 2] = rgba[p * 4 + 2];
          alpha[p] = rgba[p * 4 + 3];
        }
        const smaskObjNum = allocObjNum();
        pushObj({ objNum: smaskObjNum, content: await rawImageObject(smaskObjNum, alpha, ihdr.width, ihdr.height, 'DeviceGray', null, humanReadable) });
        const objNum = allocObjNum();
        pushObj({ objNum, content: await rawImageObject(objNum, rgb, ihdr.width, ihdr.height, 'DeviceRGB', smaskObjNum, humanReadable) });
        name = `SigImg${objNum}`;
        xobjEntriesStr += `/${name} ${objNum} 0 R\n`;
      } else {
        if (typeof warningHandler === 'function') warningHandler(`A placed PNG uses an unsupported variant (color type ${ihdr.colorType}, ${ihdr.bitDepth}-bit); it was left out of the export.`);
        continue;
      }
    }
    const {
      left, top, right, bottom,
    } = item.bbox;
    ops += `q\n${fmt(right - left)} 0 0 ${fmt(bottom - top)} ${fmt(left)} ${fmt(pixH - bottom)} cm\n/${name} Do\nQ\n`;
  }

  if (!ops) return null;
  return { ops, xobjEntriesStr };
}

/**
 * Width/height from a JPEG's first SOF marker.
 * @param {Uint8Array} bytes
 * @returns {?{width: number, height: number}}
 */
function parseJpegDims(bytes) {
  let i = 2;
  for (let guard = 0; guard < 10000 && i + 9 < bytes.length; guard++) {
    if (bytes[i] !== 0xFF) { i++; continue; }
    const marker = bytes[i + 1];
    // SOF0-15 minus DHT (C4), JPG (C8), DAC (CC).
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD9)) { i += 2; continue; }
    i += 2 + ((bytes[i + 2] << 8) | bytes[i + 3]);
  }
  return null;
}

/**
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
function concatIdat(bytes) {
  const parts = [];
  let total = 0;
  let i = 8;
  for (let guard = 0; guard < 100000 && i + 8 <= bytes.length; guard++) {
    const len = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    if (type === 'IDAT') {
      parts.push(bytes.subarray(i + 8, i + 8 + len));
      total += len;
    }
    if (type === 'IEND') break;
    i += 12 + len;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/**
 * Undo PNG scanline filtering on 8-bit samples.
 * @param {Uint8Array} raw - Inflated IDAT, each row a filter byte followed by width*bpp samples.
 * @param {number} width
 * @param {number} height
 * @param {number} bpp - Bytes per pixel.
 * @returns {Uint8Array} width*height*bpp unfiltered samples.
 */
function unfilterPngScanlines(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowIn = (stride + 1) * y + 1;
    const rowOut = stride * y;
    for (let x = 0; x < stride; x++) {
      const cur = raw[rowIn + x];
      const a = x >= bpp ? out[rowOut + x - bpp] : 0;
      const b = y > 0 ? out[rowOut - stride + x] : 0;
      const c = y > 0 && x >= bpp ? out[rowOut - stride + x - bpp] : 0;
      let v;
      if (filter === 0) v = cur;
      else if (filter === 1) v = cur + a;
      else if (filter === 2) v = cur + b;
      else if (filter === 3) v = cur + Math.floor((a + b) / 2);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[rowOut + x] = v & 0xFF;
    }
  }
  return out;
}
