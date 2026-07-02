/**
 * Lossless identifying-metadata stripping and inspection for the two embedded PDF image formats that can carry it:
 * JPEG (DCTDecode) marker segments and JPEG2000 (JPXDecode) top-level JP2 boxes.
 * This is the codec-level half of the (opt-in) PDF metadata feature. The decoders in `../codecs/` stay focused on pixel data.
 */
import { concatBytes } from '../../utils/miscUtils.js';

// JPEG (DCTDecode): APPn / COM marker segments
// Lossless: the entropy-coded scan (DQT/SOF/DHT/SOS...EOI) is copied byte-for-byte and only whole metadata marker segments are excised.

const u16 = (b, i) => (b[i] << 8) | b[i + 1];

// JPEG APPn/COM markers that carry ONLY metadata -> drop.
// APP0 (JFIF), APP2 (ICC profile), and APP14 (Adobe colour transform, required to decode CMYK/YCCK) are rendering data -> keep.
const JPEG_DROP_MARKERS = new Set([
  0xE1, // APP1  - EXIF or XMP
  0xE3, 0xE4, 0xE5, 0xE6, 0xE7, 0xE8, 0xE9, 0xEA, 0xEB, 0xEC, // APP3-APP12
  0xED, // APP13 -- Photoshop/IPTC
  0xEF, // APP15
  0xFE, // COM - free-text comment
]);

/**
 * Strip metadata marker segments from a JPEG codestream. Returns the input unchanged if it is not a parseable JPEG or if nothing was dropped.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function stripJpegMetadata(bytes) {
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return bytes;
  const out = [];
  out.push(bytes.subarray(0, 2)); // SOI
  let i = 2;
  let dropped = false;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xFF) { // not at a marker, so the codestream is malformed. Stop here rather than misinterpret the bytes and corrupt the output.
      return dropped ? concatBytes(out.concat([bytes.subarray(i)])) : bytes;
    }
    let m = i + 1;
    while (m < bytes.length && bytes[m] === 0xFF) m++; // skip fill bytes
    const marker = bytes[m];
    if (marker === 0xDA) { // SOS -- copy the scan and everything after it verbatim
      out.push(bytes.subarray(i));
      break;
    }
    // Standalone markers with no segment (SOI/EOI/RSTn/TEM): copy and continue.
    if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) {
      out.push(bytes.subarray(i, m + 1));
      i = m + 1;
      continue;
    }
    if (m + 2 >= bytes.length) { out.push(bytes.subarray(i)); break; }
    const segLen = u16(bytes, m + 1);
    const segEnd = m + 1 + segLen;
    if (segLen < 2 || segEnd > bytes.length) { // malformed length; bail unchanged
      return dropped ? concatBytes(out.concat([bytes.subarray(i)])) : bytes;
    }
    if (JPEG_DROP_MARKERS.has(marker)) dropped = true;
    else out.push(bytes.subarray(i, segEnd));
    i = segEnd;
  }
  return dropped ? concatBytes(out) : bytes;
}

/**
 * Inspect a JPEG for metadata segments, for the metadata viewer.
 * Extracts printable ASCII runs from EXIF/XMP APP1 (camera make/model/software/serial are ASCII) and flags a GPS IFD pointer.
 * @param {Uint8Array} bytes
 * @returns {{hasExif: boolean, hasXmp: boolean, hasIptc: boolean, gpsPresent: boolean, strings: string[]}}
 */
export function inspectJpegMetadata(bytes) {
  const res = {
    hasExif: false, hasXmp: false, hasIptc: false, gpsPresent: false, strings: [],
  };
  if (!bytes || bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return res;
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xFF) break;
    let m = i + 1;
    while (m < bytes.length && bytes[m] === 0xFF) m++;
    const marker = bytes[m];
    if (marker === 0xDA || marker === 0xD9) break;
    if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) { i = m + 1; continue; }
    if (m + 2 >= bytes.length) break;
    const segLen = u16(bytes, m + 1);
    const payload = bytes.subarray(m + 3, Math.min(m + 1 + segLen, bytes.length));
    if (marker === 0xE1) {
      const head = latin1(payload.subarray(0, 30));
      if (head.startsWith('Exif')) {
        res.hasExif = true;
        // 0x8825 is the GPSInfo IFD tag id, scanned in both byte orders since EXIF endianness varies.
        if (indexOfPair(payload, 0x88, 0x25) !== -1 || indexOfPair(payload, 0x25, 0x88) !== -1) res.gpsPresent = true;
        for (const s of printableRuns(payload, 5)) if (res.strings.length < 20) res.strings.push(s);
      } else if (head.includes('ns.adobe.com/xap')) {
        res.hasXmp = true;
      }
    } else if (marker === 0xED) {
      res.hasIptc = true;
    }
    if (segLen < 2) break;
    i = m + 1 + segLen;
  }
  return res;
}

const latin1 = (b) => { let s = ''; for (let k = 0; k < b.length; k++) s += String.fromCharCode(b[k]); return s; };
function indexOfPair(b, a, c) { for (let k = 0; k + 1 < b.length; k++) if (b[k] === a && b[k + 1] === c) return k; return -1; }
/**
 * Extract printable-ASCII runs of at least `min` chars (catches camera model/serial strings in EXIF).
 * @param {Uint8Array} b
 * @param {number} min
 * @returns {string[]}
 */
function printableRuns(b, min) {
  const runs = [];
  let cur = '';
  for (let k = 0; k < b.length; k++) {
    const ch = b[k];
    if (ch >= 0x20 && ch <= 0x7E) cur += String.fromCharCode(ch);
    else { if (cur.length >= min) runs.push(cur); cur = ''; }
  }
  if (cur.length >= min) runs.push(cur);
  return runs;
}

// JPEG2000 (JPXDecode): top-level JP2 metadata boxes.
// Drops only top-level metadata boxes; the codestream and header boxes are untouched.

function readUint32(data, offset) {
  return ((data[offset] << 24) | (data[offset + 1] << 16)
          | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
}

// JP2 box types that carry only metadata, so are dropped at the top level.
const JPX_DROP_BOXES = new Set(['xml ', 'uuid', 'uinf', 'ulst', 'url ']);
const boxType = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);

/**
 * Strip top-level metadata boxes from a JPEG2000 (JP2/JPX) stream.
 * A raw codestream (starts with SOC 0xFF4F) has no boxes and is returned unchanged, as is anything unparseable.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function stripJpxMetadata(bytes) {
  if (!bytes || bytes.length < 8) return bytes;
  if (bytes[0] === 0xFF && bytes[1] === 0x4F) return bytes; // raw codestream, no metadata boxes
  const out = [];
  let i = 0;
  let dropped = false;
  while (i + 8 <= bytes.length) {
    let len = readUint32(bytes, i);
    let headerSize = 8;
    if (len === 1) { // 64-bit extended length
      len = readUint32(bytes, i + 8) * 4294967296 + readUint32(bytes, i + 12);
      headerSize = 16;
    } else if (len === 0) {
      len = bytes.length - i; // box extends to end of file
    }
    if (len < headerSize || i + len > bytes.length) { // malformed box length - bail unchanged
      return dropped ? concatBytes(out.concat([bytes.subarray(i)])) : bytes;
    }
    if (JPX_DROP_BOXES.has(boxType(bytes, i + 4))) dropped = true;
    else out.push(bytes.subarray(i, i + len));
    i += len;
  }
  if (i < bytes.length) out.push(bytes.subarray(i)); // trailing bytes, if any
  return dropped ? concatBytes(out) : bytes;
}

/**
 * Inspect a JPEG2000 stream for metadata boxes.
 * @param {Uint8Array} bytes
 * @returns {{hasXml: boolean, hasUuid: boolean, boxes: string[]}}
 */
export function inspectJpxMetadata(bytes) {
  const res = { hasXml: false, hasUuid: false, boxes: [] };
  if (!bytes || bytes.length < 8 || (bytes[0] === 0xFF && bytes[1] === 0x4F)) return res;
  let i = 0;
  while (i + 8 <= bytes.length) {
    let len = readUint32(bytes, i);
    let headerSize = 8;
    if (len === 1) { len = readUint32(bytes, i + 8) * 4294967296 + readUint32(bytes, i + 12); headerSize = 16; } else if (len === 0) len = bytes.length - i;
    if (len < headerSize || i + len > bytes.length) break;
    const t = boxType(bytes, i + 4);
    if (JPX_DROP_BOXES.has(t)) { res.boxes.push(t.trim()); if (t === 'xml ') res.hasXml = true; if (t === 'uuid') res.hasUuid = true; }
    i += len;
  }
  return res;
}
