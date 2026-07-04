/**
 * Minimal JPEG decoder for CMYK/YCCK images.
 *
 * Many functions adapted from Mozilla pdf.js (Apache 2.0 license).
 */

import { xyzToSRGB } from '../pdfColorFunctions.js';

const idctCos = new Float64Array(64);
for (let x = 0; x < 8; x++) {
  for (let u = 0; u < 8; u++) {
    const alpha = u === 0 ? 1 / Math.sqrt(2) : 1;
    idctCos[x * 8 + u] = alpha * Math.cos((2 * x + 1) * u * Math.PI / 16) / 2;
  }
}

// Scratch for the IDCT row pass, reused across the idct8x8/4x4/2x2 calls below.
// The row pass writes every scratch entry a later column pass reads, so it never needs re-zeroing.
const idctScratch = new Float64Array(64);

/**
 * Full 8x8 inverse DCT, in place, via the even/odd butterfly:
 * each 1D pass forms an even-index sum E and an odd-index sum O,
 * then writes E+O and E-O to the symmetric output positions n and 7-n.
 * Input is dequantized DCT coefficients in natural (row-major) order.
 * Output is pixel values biased by +128, which the caller clamps to 0-255.
 * @param {Int32Array} block - 64-element array
 */
function idct8x8(block) {
  for (let row = 0; row < 8; row++) {
    const b = row * 8;
    const f0 = block[b];
    const f1 = block[b + 1];
    const f2 = block[b + 2];
    const f3 = block[b + 3];
    const f4 = block[b + 4];
    const f5 = block[b + 5];
    const f6 = block[b + 6];
    const f7 = block[b + 7];
    for (let n = 0; n < 4; n++) {
      const r = n * 8;
      const E = f0 * idctCos[r] + f2 * idctCos[r + 2] + f4 * idctCos[r + 4] + f6 * idctCos[r + 6];
      const O = f1 * idctCos[r + 1] + f3 * idctCos[r + 3] + f5 * idctCos[r + 5] + f7 * idctCos[r + 7];
      idctScratch[b + n] = E + O;
      idctScratch[b + 7 - n] = E - O;
    }
  }
  for (let col = 0; col < 8; col++) {
    const f0 = idctScratch[col];
    const f1 = idctScratch[8 + col];
    const f2 = idctScratch[16 + col];
    const f3 = idctScratch[24 + col];
    const f4 = idctScratch[32 + col];
    const f5 = idctScratch[40 + col];
    const f6 = idctScratch[48 + col];
    const f7 = idctScratch[56 + col];
    for (let n = 0; n < 4; n++) {
      const r = n * 8;
      const E = f0 * idctCos[r] + f2 * idctCos[r + 2] + f4 * idctCos[r + 4] + f6 * idctCos[r + 6];
      const O = f1 * idctCos[r + 1] + f3 * idctCos[r + 3] + f5 * idctCos[r + 5] + f7 * idctCos[r + 7];
      block[n * 8 + col] = Math.round(E + O) + 128;
      block[(7 - n) * 8 + col] = Math.round(E - O) + 128;
    }
  }
}

/**
 * Reduced 4x4 IDCT (in place): exact when every nonzero coefficient lies in the top-left 4x4, so the row/column passes only sum the four low-frequency taps.
 * Most baseline JPEG blocks quantize to this shape.
 * @param {Int32Array} block
 */
function idct4x4(block) {
  for (let x = 0; x < 8; x++) {
    const c0 = idctCos[x * 8];
    const c1 = idctCos[x * 8 + 1];
    const c2 = idctCos[x * 8 + 2];
    const c3 = idctCos[x * 8 + 3];
    idctScratch[x] = block[0] * c0 + block[1] * c1 + block[2] * c2 + block[3] * c3;
    idctScratch[8 + x] = block[8] * c0 + block[9] * c1 + block[10] * c2 + block[11] * c3;
    idctScratch[16 + x] = block[16] * c0 + block[17] * c1 + block[18] * c2 + block[19] * c3;
    idctScratch[24 + x] = block[24] * c0 + block[25] * c1 + block[26] * c2 + block[27] * c3;
  }
  for (let y = 0; y < 8; y++) {
    const c0 = idctCos[y * 8];
    const c1 = idctCos[y * 8 + 1];
    const c2 = idctCos[y * 8 + 2];
    const c3 = idctCos[y * 8 + 3];
    const b = y * 8;
    for (let x = 0; x < 8; x++) {
      block[b + x] = Math.round(idctScratch[x] * c0 + idctScratch[8 + x] * c1 + idctScratch[16 + x] * c2 + idctScratch[24 + x] * c3) + 128;
    }
  }
}

/**
 * Reduced 2x2 IDCT (in place): exact when every nonzero coefficient lies in the top-left 2x2 (DC plus the three lowest AC terms).
 * @param {Int32Array} block
 */
function idct2x2(block) {
  const F0 = block[0];
  const F1 = block[1];
  const F8 = block[8];
  const F9 = block[9];
  for (let x = 0; x < 8; x++) {
    idctScratch[x] = F0 * idctCos[x * 8] + F1 * idctCos[x * 8 + 1];
    idctScratch[8 + x] = F8 * idctCos[x * 8] + F9 * idctCos[x * 8 + 1];
  }
  for (let y = 0; y < 8; y++) {
    const cy0 = idctCos[y * 8];
    const cy1 = idctCos[y * 8 + 1];
    const b = y * 8;
    for (let x = 0; x < 8; x++) block[b + x] = Math.round(idctScratch[x] * cy0 + idctScratch[8 + x] * cy1) + 128;
  }
}

/**
 * Downscaling matrices for scaled decode (see `decodeJPEGComponents` `scale`).
 * Applied separably to an 8x8 coefficient block, `boxAvgMatrix[m]` produces the exact box-average of the block's full IDCT output.
 * m=1 (1/8) is DC-only, handled inline.
 * @type {Record<number, Float64Array>}
 */
const boxAvgMatrix = {};
for (const bm of [2, 4]) {
  const s = 8 / bm;
  const mat = new Float64Array(bm * 8);
  for (let j = 0; j < bm; j++) {
    for (let u = 0; u < 8; u++) {
      let acc = 0;
      for (let n = j * s; n < (j + 1) * s; n++) acc += idctCos[n * 8 + u];
      mat[j * 8 + u] = acc / s;
    }
  }
  boxAvgMatrix[bm] = mat;
}

// Scratch for the box-average row pass, reused across idctBoxAvg calls (up to m=4 rows x 8 columns).
const boxAvgScratch = new Float64Array(4 * 8);

/**
 * Box-average IDCT for scaled decode: writes the m x m box-average of the block's full IDCT into `out`, clamped 0-255.
 * Sums only the nonzero coefficient bounding box [0..maxRow] x [0..maxCol]; the rest are zero, so the reduced sum stays exact.
 * For m in {2,4}; m=1 (1/8) is DC-only, filled inline.
 * @param {Int32Array} block
 * @param {number} m
 * @param {Float64Array} mat
 * @param {Uint8Array} out
 * @param {number} maxRow
 * @param {number} maxCol
 */
function idctBoxAvg(block, m, mat, out, maxRow, maxCol) {
  for (let u = 0; u <= maxRow; u++) {
    const bu = u * 8;
    for (let i = 0; i < m; i++) {
      const mi = i * 8;
      let acc = 0;
      for (let c = 0; c <= maxCol; c++) acc += block[bu + c] * mat[mi + c];
      boxAvgScratch[u * m + i] = acc;
    }
  }
  for (let j = 0; j < m; j++) {
    const mj = j * 8;
    for (let i = 0; i < m; i++) {
      let acc = 0;
      for (let u = 0; u <= maxRow; u++) acc += boxAvgScratch[u * m + i] * mat[mj + u];
      let v = Math.round(acc) + 128;
      if (v < 0) v = 0; else if (v > 255) v = 255;
      out[j * m + i] = v;
    }
  }
}

/**
 * Build a lookup table for fast Huffman decoding.
 * Returns an object with a `decode` method.
 * @param {Uint8Array} bits
 * @param {Uint8Array} values
 */
function buildHuffmanTable(bits, values) {
  /** @type {{ code: number, len: number, symbol: number }[]} */
  const entries = [];
  let code = 0;
  let vi = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) {
      entries.push({ code, len, symbol: values[vi] });
      vi++;
      code++;
    }
    code <<= 1;
  }

  const maxCode = new Int32Array(17).fill(-1);
  const minCode = new Int32Array(17).fill(0);
  const valOffset = new Int32Array(17).fill(0);
  const symbols = new Uint8Array(entries.length);

  let ei = 0;
  for (let len = 1; len <= 16; len++) {
    const count = bits[len - 1];
    if (count > 0) {
      valOffset[len] = ei;
      minCode[len] = entries[ei].code;
      for (let i = 0; i < count; i++) {
        symbols[ei] = entries[ei].symbol;
        ei++;
      }
      maxCode[len] = entries[ei - 1].code;
    }
  }

  return {
    maxCode, minCode, valOffset, symbols,
  };
}

class BitReader {
  /**
   * @param {Uint8Array} data
   * @param {number} offset - start position in data
   */
  constructor(data, offset) {
    this.data = data;
    this.pos = offset;
    this.bitBuf = 0;
    this.bitsLeft = 0;
  }

  /**
   * Read the next bit from the bitstream, handling byte stuffing (0xFF 0x00).
   * @returns {number} 0 or 1
   */
  readBit() {
    if (this.bitsLeft === 0) {
      const b = this.data[this.pos++];
      if (b === 0xFF) {
        const next = this.data[this.pos++];
        if (next !== 0) {
          // Marker encountered — treat as end of scan
          this.pos -= 2;
          return -1;
        }
        // Byte-stuffed 0xFF → single 0xFF byte
      }
      this.bitBuf = b;
      this.bitsLeft = 8;
    }
    this.bitsLeft--;
    return (this.bitBuf >> this.bitsLeft) & 1;
  }

  /**
   * Read `n` bits as an unsigned integer.
   * @param {number} n
   */
  readBits(n) {
    let val = 0;
    for (let i = 0; i < n; i++) {
      const bit = this.readBit();
      if (bit < 0) return -1;
      val = (val << 1) | bit;
    }
    return val;
  }

  /**
   * Decode one Huffman symbol using (maxCode, minCode, valOffset) tables.
   * @param {{ maxCode: Int32Array, minCode: Int32Array, valOffset: Int32Array, symbols: Uint8Array }} table
   * @returns {number} decoded symbol value, or -1 on error
   */
  decodeHuffman(table) {
    let code = 0;
    for (let len = 1; len <= 16; len++) {
      const bit = this.readBit();
      if (bit < 0) return -1;
      code = (code << 1) | bit;
      if (table.maxCode[len] >= 0 && code <= table.maxCode[len]) {
        const idx = table.valOffset[len] + (code - table.minCode[len]);
        return table.symbols[idx];
      }
    }
    return -1; // Code too long
  }
}

/**
 * @typedef {Object} JpegComponent
 * @property {number} id - Component identifier
 * @property {number} hSamp - Horizontal sampling factor
 * @property {number} vSamp - Vertical sampling factor
 * @property {number} qtId - Quantization table identifier
 * @property {number} dcTableId - DC Huffman table identifier (set during SOS)
 * @property {number} acTableId - AC Huffman table identifier (set during SOS)
 */

/**
 * Decode a baseline CMYK/YCCK JPEG to per-component sample buffers (MCU-padded), before chroma upsampling or interleaving.
 *
 * @param {Uint8Array} jpegData - Raw JPEG file bytes
 * @param {{x0:number,y0:number,x1:number,y1:number}|null} [roi] - Region of interest in image pixels, to skip decoding regions the page clips away.
 *   Samples outside it are left zero and must not be read.
 * @param {number} [scale=1] - Downscale factor, one of 1/2/4/8.
 *   The returned planes come back at 1/scale resolution.
 * @returns {{ width: number, height: number, outW: number, outH: number, numComponents: number, compBuffers: Uint8Array[],
 * compWidths: number[], compHeights: number[], compSampling: {hSamp: number, vSamp: number}[],
 * maxHSamp: number, maxVSamp: number, adobeTransform: number }|null}
 *   `width`/`height` are the native size; `outW`/`outH` the decoded size (native/scale).
 *   Returns null for unsupported (non-baseline, non-3/4-component) JPEGs or on decode failure.
 */
function decodeJPEGComponents(jpegData, roi = null, scale = 1) {
  let pos = 0;
  const len = jpegData.length;

  function readMarker() {
    if (pos + 1 >= len) return -1;
    if (jpegData[pos] !== 0xFF) return -1;
    pos++;
    // Skip padding 0xFF bytes
    while (pos < len && jpegData[pos] === 0xFF) pos++;
    if (pos >= len) return -1;
    return jpegData[pos++];
  }

  function readUint16() {
    const v = (jpegData[pos] << 8) | jpegData[pos + 1];
    pos += 2;
    return v;
  }

  let width = 0;
  let height = 0;
  let numComponents = 0;
  /** @type {JpegComponent[]} */
  const components = [];
  /** @type {(Int32Array|null)[]} */
  const qtables = [null, null, null, null];
  /** @type {({ children: Int32Array }|null)[]} */
  const dcTables = [null, null, null, null];
  /** @type {({ children: Int32Array }|null)[]} */
  const acTables = [null, null, null, null];
  let adobeTransform = -1;
  let isBaseline = false;
  let maxHSamp = 1;
  let maxVSamp = 1;
  let restartInterval = 0;

  const soi = readMarker();
  if (soi !== 0xD8) return null; // Not JPEG

  let sosFound = false;
  while (pos < len && !sosFound) {
    const marker = readMarker();
    if (marker < 0) break;

    switch (marker) {
      case 0xC0: // SOF0 — Baseline DCT
      case 0xC1: { // SOF1 — Extended sequential DCT
        isBaseline = true;
        const segLen = readUint16();
        const precision = jpegData[pos++];
        if (precision !== 8) return null; // Only 8-bit supported
        height = readUint16();
        width = readUint16();
        numComponents = jpegData[pos++];
        if (numComponents !== 3 && numComponents !== 4) return null;
        for (let i = 0; i < numComponents; i++) {
          const id = jpegData[pos++];
          const sampling = jpegData[pos++];
          const hSamp = sampling >> 4;
          const vSamp = sampling & 0x0F;
          const qtId = jpegData[pos++];
          components.push({
            id, hSamp, vSamp, qtId, dcTableId: 0, acTableId: 0,
          });
          if (hSamp > maxHSamp) maxHSamp = hSamp;
          if (vSamp > maxVSamp) maxVSamp = vSamp;
        }
        break;
      }

      case 0xC2: { // SOF2 — Progressive DCT
        // Progressive not supported for CMYK
        return null;
      }

      case 0xC4: { // DHT — Define Huffman Table
        const segLen = readUint16();
        const segEnd = pos + segLen - 2;
        while (pos < segEnd) {
          const info = jpegData[pos++];
          const tableClass = info >> 4; // 0=DC, 1=AC
          const tableId = info & 0x0F;
          const bits = new Uint8Array(16);
          let totalCodes = 0;
          for (let i = 0; i < 16; i++) {
            bits[i] = jpegData[pos++];
            totalCodes += bits[i];
          }
          const values = new Uint8Array(totalCodes);
          for (let i = 0; i < totalCodes; i++) {
            values[i] = jpegData[pos++];
          }
          const table = buildHuffmanTable(bits, values);
          if (tableClass === 0) dcTables[tableId] = table;
          else acTables[tableId] = table;
        }
        pos = segEnd;
        break;
      }

      case 0xDB: { // DQT — Define Quantization Table
        const segLen = readUint16();
        const segEnd = pos + segLen - 2;
        while (pos < segEnd) {
          const info = jpegData[pos++];
          const precision = info >> 4; // 0=8bit, 1=16bit
          const tableId = info & 0x0F;
          const qt = new Int32Array(64);
          if (precision === 0) {
            for (let i = 0; i < 64; i++) qt[i] = jpegData[pos++];
          } else {
            for (let i = 0; i < 64; i++) {
              qt[i] = (jpegData[pos] << 8) | jpegData[pos + 1];
              pos += 2;
            }
          }
          qtables[tableId] = qt;
        }
        pos = segEnd;
        break;
      }

      case 0xDA: { // SOS — Start of Scan
        const segLen = readUint16();
        const nComp = jpegData[pos++];
        for (let i = 0; i < nComp; i++) {
          const compId = jpegData[pos++];
          const tables = jpegData[pos++];
          const dcId = tables >> 4;
          const acId = tables & 0x0F;
          // Find matching component
          for (const comp of components) {
            if (comp.id === compId) {
              comp.dcTableId = dcId;
              comp.acTableId = acId;
              break;
            }
          }
        }
        // Skip Ss, Se, Ah/Al (3 bytes)
        pos += 3;
        sosFound = true;
        break;
      }

      case 0xEE: { // APP14 — Adobe marker
        const segLen = readUint16();
        const segEnd = pos + segLen - 2;
        if (segLen >= 14) {
          const id = String.fromCharCode(jpegData[pos], jpegData[pos + 1], jpegData[pos + 2],
            jpegData[pos + 3], jpegData[pos + 4]);
          if (id === 'Adobe') {
            adobeTransform = jpegData[pos + 11];
          }
        }
        pos = segEnd;
        break;
      }

      case 0xD9: // EOI
        return null;

      case 0xDD: { // DRI — Define Restart Interval
        readUint16(); // length
        restartInterval = readUint16();
        break;
      }

      default: {
        // Skip unknown marker segment
        if (marker >= 0xE0 && marker <= 0xEF) {
          // APP markers
          const segLen = readUint16();
          pos += segLen - 2;
        } else if (marker >= 0xC0) {
          const segLen = readUint16();
          pos += segLen - 2;
        }
        break;
      }
    }
  }

  if (!sosFound || (numComponents !== 3 && numComponents !== 4) || !isBaseline) return null;

  // prettier-ignore
  const zigzag = [
    0, 1, 8, 16, 9, 2, 3, 10,
    17, 24, 32, 25, 18, 11, 4, 5,
    12, 19, 26, 33, 40, 48, 41, 34,
    27, 20, 13, 6, 7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36,
    29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46,
    53, 60, 61, 54, 47, 55, 62, 63,
  ];

  const mcuW = maxHSamp * 8;
  const mcuH = maxVSamp * 8;
  const mcuCountX = Math.ceil(width / mcuW);
  const mcuCountY = Math.ceil(height / mcuH);

  // Scaled decode: each block yields an m x m box-average patch (m = 8/scale), so the per-component planes are 1/scale the native size.
  // bs is the per-block edge (8 at full scale).
  const m = 8 / scale;
  const bs = scale === 1 ? 8 : m;
  const compBuffers = components.map((comp) => {
    const cw = mcuCountX * comp.hSamp * bs;
    const ch = mcuCountY * comp.vSamp * bs;
    return new Uint8Array(cw * ch);
  });
  const compWidths = components.map((comp) => mcuCountX * comp.hSamp * bs);

  const prevDC = new Int32Array(numComponents);

  const reader = new BitReader(jpegData, pos);

  let mcuCount = 0;

  // Region of interest in image pixels, expanded by one MCU so chroma upsampling at the region's edge still reads decoded neighbours.
  const dX0 = roi ? roi.x0 - mcuW : 0;
  const dY0 = roi ? roi.y0 - mcuH : 0;
  const dX1 = roi ? roi.x1 + mcuW : width;
  const dY1 = roi ? roi.y1 + mcuH : height;

  const block = new Int32Array(64);
  const scaledOut = new Uint8Array(16); // reduced m x m block output when scale > 1 (m <= 4)
  for (let mcuY = 0; mcuY < mcuCountY; mcuY++) {
    // Every remaining MCU row is below the region, so nothing is left to make visible. Stop.
    if (roi && mcuY * mcuH >= dY1) break;
    const rowVisible = !roi || (mcuY * mcuH < dY1 && (mcuY + 1) * mcuH > dY0);
    for (let mcuX = 0; mcuX < mcuCountX; mcuX++) {
      const mcuVisible = rowVisible && (!roi || (mcuX * mcuW < dX1 && (mcuX + 1) * mcuW > dX0));
      if (restartInterval > 0 && mcuCount > 0 && mcuCount % restartInterval === 0) {
        reader.bitsLeft = 0;
        let rPos = reader.pos;
        while (rPos < len - 1) {
          if (jpegData[rPos] === 0xFF && jpegData[rPos + 1] >= 0xD0 && jpegData[rPos + 1] <= 0xD7) {
            rPos += 2;
            break;
          }
          rPos++;
        }
        reader.pos = rPos;
        reader.bitsLeft = 0;
        prevDC.fill(0);
      }

      for (let ci = 0; ci < numComponents; ci++) {
        const comp = components[ci];
        const qt = qtables[comp.qtId];
        const dcTable = dcTables[comp.dcTableId];
        const acTable = acTables[comp.acTableId];
        if (!qt || !dcTable || !acTable) return null;

        const blocksH = comp.hSamp;
        const blocksV = comp.vSamp;

        for (let bv = 0; bv < blocksV; bv++) {
          for (let bh = 0; bh < blocksH; bh++) {
            block.fill(0);

            const dcCategory = reader.decodeHuffman(dcTable);
            if (dcCategory < 0) {
              // Error or EOI
              break;
            }
            let dcVal = 0;
            if (dcCategory > 0) {
              dcVal = reader.readBits(dcCategory);
              if (dcVal < 0) break;
              // Convert to signed: if high bit is 0, value is negative
              if (dcVal < (1 << (dcCategory - 1))) {
                dcVal -= (1 << dcCategory) - 1;
              }
            }
            prevDC[ci] += dcVal;
            block[0] = prevDC[ci] * qt[0];

            // Decode AC coefficients, tracking the bounding box of nonzero coeffs so the IDCT below can dispatch to the cheapest exact routine for this block's shape.
            let k = 1;
            let maxRow = 0;
            let maxCol = 0;
            while (k < 64) {
              const acSymbol = reader.decodeHuffman(acTable);
              if (acSymbol < 0) break;
              if (acSymbol === 0) break; // EOB
              const runLength = acSymbol >> 4;
              const acCategory = acSymbol & 0x0F;
              k += runLength;
              if (k >= 64) break;
              if (acCategory > 0) {
                let acVal = reader.readBits(acCategory);
                if (acVal < 0) break;
                if (acVal < (1 << (acCategory - 1))) {
                  acVal -= (1 << acCategory) - 1;
                }
                const nat = zigzag[k];
                block[nat] = acVal * qt[k];
                const nr = nat >> 3;
                const nc = nat & 7;
                if (nr > maxRow) maxRow = nr;
                if (nc > maxCol) maxCol = nc;
              }
              k++;
            }

            // This block is outside the region of interest, so drop it before the expensive inverse transform and pixel store.
            // The Huffman decode above still had to run to keep the sequential bitstream position and the differential DC predictor advanced for the following blocks.
            if (!mcuVisible) continue;

            if (scale === 1) {
              // Dispatch to the smallest IDCT still exact for this block's nonzero-coefficient bounding box.
              // The flat (DC-only) case multiplies by idctCos[0] on both passes exactly like the full transform, so its fill is byte-identical to idct8x8.
              if (maxRow === 0 && maxCol === 0) {
                block.fill(Math.round(block[0] * idctCos[0] * idctCos[0]) + 128);
              } else if (maxRow <= 1 && maxCol <= 1) {
                idct2x2(block);
              } else if (maxRow <= 3 && maxCol <= 3) {
                idct4x4(block);
              } else {
                idct8x8(block);
              }
              const cx = (mcuX * blocksH + bh) * 8;
              const cy = (mcuY * blocksV + bv) * 8;
              const cw = compWidths[ci];
              for (let row = 0; row < 8; row++) {
                for (let col = 0; col < 8; col++) {
                  let val = block[row * 8 + col];
                  if (val < 0) val = 0;
                  if (val > 255) val = 255;
                  compBuffers[ci][(cy + row) * cw + (cx + col)] = val;
                }
              }
            } else {
              // At m=1 (1/8 scale) the box-average patch is a single pixel holding the block's DC mean, the same value the flat fast path computes.
              if (m === 1) {
                let v = Math.round(block[0] * idctCos[0] * idctCos[0]) + 128;
                if (v < 0) v = 0; else if (v > 255) v = 255;
                scaledOut[0] = v;
              } else {
                idctBoxAvg(block, m, boxAvgMatrix[m], scaledOut, maxRow, maxCol);
              }
              const cx = (mcuX * blocksH + bh) * m;
              const cy = (mcuY * blocksV + bv) * m;
              const cw = compWidths[ci];
              for (let row = 0; row < m; row++) {
                for (let col = 0; col < m; col++) {
                  compBuffers[ci][(cy + row) * cw + (cx + col)] = scaledOut[row * m + col];
                }
              }
            }
          }
        }
      }
      mcuCount++;
    }
  }

  const compHeights = components.map((comp) => mcuCountY * comp.vSamp * bs);
  return {
    width,
    height,
    outW: scale === 1 ? width : Math.ceil(width / scale),
    outH: scale === 1 ? height : Math.ceil(height / scale),
    numComponents,
    compBuffers,
    compWidths,
    compHeights,
    compSampling: components.map((c) => ({ hSamp: c.hSamp, vSamp: c.vSamp })),
    maxHSamp,
    maxVSamp,
    adobeTransform,
  };
}

/**
 * Decode a CMYK JPEG and return RGBA pixel data as Uint8Array (R,G,B,A,R,G,B,A,...).
 *
 * @param {Uint8Array} jpegData - Raw JPEG bytes
 * @param {boolean} [decodeInvert=false]
 * @param {{x0:number,y0:number,x1:number,y1:number}|null} [roi] - Region of interest in image pixels.
 *    When set, only pixels inside it are converted and the rest of the returned buffer stays transparent-black.
 *    The returned image is still full size, not cropped to the region.
 * @param {number} [scale=1] - Downscale factor (1/2/4/8).
 *    When >1 the image is decoded at 1/scale resolution (each 8x8 block box-averaged to (8/scale)x(8/scale)).
 *    The returned width/height are the reduced size.
 *    Any `roi` is given in native image pixels and mapped onto the reduced grid here.
 * @returns {{ width: number, height: number, rgbData: Uint8Array }|null} width/height are the decoded (native/scale) size.
 */
export function decodeCMYKJpegToRGB(jpegData, decodeInvert = false, roi = null, scale = 1) {
  const dec = decodeJPEGComponents(jpegData, roi, scale);
  if (!dec) return null;
  const {
    outW, outH, numComponents, compBuffers, compWidths, compHeights, compSampling, maxHSamp, maxVSamp, adobeTransform,
  } = dec;
  const rgbData = new Uint8Array(outW * outH * 4); // RGBA for ImageData

  // roi is in native pixels, so map it to the reduced output grid (a no-op when scale === 1).
  const rx0 = roi ? Math.max(0, Math.floor(roi.x0 / scale)) : 0;
  const ry0 = roi ? Math.max(0, Math.floor(roi.y0 / scale)) : 0;
  const rx1 = roi ? Math.min(outW, Math.ceil(roi.x1 / scale)) : outW;
  const ry1 = roi ? Math.min(outH, Math.ceil(roi.y1 / scale)) : outH;

  // 4:4:4 (no subsampling) is the common case for print CMYK JPEGs.
  // Subsampled components instead go through bilinear upsampling.
  const noSubsampling = numComponents === 4
    && compSampling.every((cs) => cs.hSamp === maxHSamp && cs.vSamp === maxVSamp);
  const b0 = compBuffers[0];
  const b1 = compBuffers[1];
  const b2 = compBuffers[2];
  const b3 = compBuffers[3];
  const w0 = compWidths[0];
  const w1 = compWidths[1];
  const w2 = compWidths[2];
  const w3 = compWidths[3];
  const comp = new Uint8Array(numComponents);
  // Memoize the CMYK->RGB conversion: it is an expensive per-pixel polynomial and adjacent pixels are often identical (flat regions),
  // so reuse the previous result when the CMYK input is unchanged.
  let prevC = -1; let prevM = -1; let prevY = -1; let prevK = -1;
  let prevR = 0; let prevG = 0; let prevB = 0;
  for (let py = ry0; py < ry1; py++) {
    const r0 = py * w0;
    const r1 = py * w1;
    const r2 = py * w2;
    const r3 = py * w3;
    for (let px = rx0; px < rx1; px++) {
      const di = (py * outW + px) * 4;
      let c;
      let m;
      let y;
      let k;
      if (noSubsampling) {
        c = b0[r0 + px];
        m = b1[r1 + px];
        y = b2[r2 + px];
        k = b3[r3 + px];
      } else {
        for (let ci = 0; ci < numComponents; ci++) {
          const cs = compSampling[ci];
          if (cs.hSamp === maxHSamp && cs.vSamp === maxVSamp) {
            comp[ci] = compBuffers[ci][py * compWidths[ci] + px];
          } else {
            const cw = compWidths[ci];
            const ch = compHeights[ci];
            const fx = px * cs.hSamp / maxHSamp;
            const fy = py * cs.vSamp / maxVSamp;
            const x0 = Math.floor(fx);
            const y0 = Math.floor(fy);
            const x1 = Math.min(x0 + 1, cw - 1);
            const y1 = Math.min(y0 + 1, ch - 1);
            const dx = fx - x0;
            const dy = fy - y0;
            const buf = compBuffers[ci];
            const v00 = buf[y0 * cw + x0];
            const v10 = buf[y0 * cw + x1];
            const v01 = buf[y1 * cw + x0];
            const v11 = buf[y1 * cw + x1];
            comp[ci] = ((v00 * (1 - dx) + v10 * dx) * (1 - dy)
              + (v01 * (1 - dx) + v11 * dx) * dy + 0.5) | 0;
          }
        }
        c = comp[0];
        m = comp[1];
        y = comp[2];
        k = comp[3];
      }

      if (adobeTransform === 2) {
        const Y = c;
        const Cb = m;
        const Cr = y;
        let R = Y + 1.402 * (Cr - 128);
        let G = Y - 0.344136 * (Cb - 128) - 0.714136 * (Cr - 128);
        let B = Y + 1.772 * (Cb - 128);
        if (R < 0) R = 0; if (R > 255) R = 255;
        if (G < 0) G = 0; if (G > 255) G = 255;
        if (B < 0) B = 0; if (B > 255) B = 255;
        c = 255 - R;
        m = 255 - G;
        y = 255 - B;
      }

      if (decodeInvert) {
        c = 255 - c;
        m = 255 - m;
        y = 255 - y;
        k = 255 - k;
      }

      // Reuse the previous pixel's RGB when the CMYK input is identical (flat regions).
      if (c === prevC && m === prevM && y === prevY && k === prevK) {
        rgbData[di] = prevR;
        rgbData[di + 1] = prevG;
        rgbData[di + 2] = prevB;
        rgbData[di + 3] = 255;
        continue;
      }

      // CMYK -> RGB using polynomial approximation of US Web Coated (SWOP) v2 ICC profile.
      // Matches pdf.js. c,m,y,k here are 0-255; normalize to 0-1.
      const cn = c / 255;
      const mn = m / 255;
      const yn = y / 255;
      const kn = k / 255;
      const ri = 255
        + cn * (-4.387332384609988 * cn + 54.48615194189176 * mn + 18.82290502165302 * yn + 212.25662451639585 * kn - 285.2331026137004)
        + mn * (1.7149763477362134 * mn - 5.6096736904047315 * yn - 17.873870861415444 * kn - 5.497006427196366)
        + yn * (-2.5217340131683033 * yn - 21.248923337353073 * kn + 17.5119270841813)
        + kn * (-21.86122147463605 * kn - 189.48180835922747);
      const gi = 255
        + cn * (8.841041422036149 * cn + 60.118027045597366 * mn + 6.871425592049007 * yn + 31.159100130055922 * kn - 79.2970844816548)
        + mn * (-15.310361306967817 * mn + 17.575251261109482 * yn + 131.35250912493976 * kn - 190.9453302588951)
        + yn * (4.444339102852739 * yn + 9.8632861493405 * kn - 24.86741582555878)
        + kn * (-20.737325471181034 * kn - 187.80453709719578);
      const bi = 255
        + cn * (0.8842522430003296 * cn + 8.078677503112928 * mn + 30.89978309703729 * yn - 0.23883238689178934 * kn - 14.183576799673286)
        + mn * (10.49593273432072 * mn + 63.02378494754052 * yn + 50.606957656360734 * kn - 112.23884253719248)
        + yn * (0.03296041114873217 * yn + 115.60384449646641 * kn - 193.58209356861505)
        + kn * (-22.33816807309886 * kn - 180.12613974708367);

      const R = ri > 255 ? 255 : (ri < 0 ? 0 : Math.round(ri));
      const G = gi > 255 ? 255 : (gi < 0 ? 0 : Math.round(gi));
      const B = bi > 255 ? 255 : (bi < 0 ? 0 : Math.round(bi));
      rgbData[di] = R; rgbData[di + 1] = G; rgbData[di + 2] = B; rgbData[di + 3] = 255;
      prevC = c; prevM = m; prevY = y; prevK = k; prevR = R; prevG = G; prevB = B;
    }
  }

  return { width: outW, height: outH, rgbData };
}

/**
 * Convert raw Lab pixel bytes to RGBA.
 *
 * @param {Uint8Array|Uint8ClampedArray} data
 * @param {number} width
 * @param {number} height
 * @param {number[]} whitePoint
 * @param {number[]} [range]
 */
export function labBytesToRGBA(data, width, height, whitePoint, range) {
  const rgbData = new Uint8Array(width * height * 4);
  const [Xw, Yw, Zw] = whitePoint;
  const r = range || [-128, 127, -128, 127];
  const aMin = r[0]; const aSpan = r[1] - r[0];
  const bMin = r[2]; const bSpan = r[3] - r[2];

  for (let i = 0; i < width * height; i++) {
    const si = i * 3;
    const L = data[si] * 100 / 255;
    const a = data[si + 1] / 255 * aSpan + aMin;
    const b = data[si + 2] / 255 * bSpan + bMin;

    const fy = (L + 16) / 116;
    const fx = a / 500 + fy;
    const fz = fy - b / 200;

    const xr = fx > 6 / 29 ? fx * fx * fx : (fx - 16 / 116) * 3 * (6 / 29) * (6 / 29);
    const yr = fy > 6 / 29 ? fy * fy * fy : (fy - 16 / 116) * 3 * (6 / 29) * (6 / 29);
    const zr = fz > 6 / 29 ? fz * fz * fz : (fz - 16 / 116) * 3 * (6 / 29) * (6 / 29);

    const X = xr * Xw;
    const Y = yr * Yw;
    const Z = zr * Zw;
    const [rOut, gOut, bOut] = xyzToSRGB(X, Y, Z, whitePoint);
    const di = i * 4;
    rgbData[di] = rOut;
    rgbData[di + 1] = gOut;
    rgbData[di + 2] = bOut;
    rgbData[di + 3] = 255;
  }

  return rgbData;
}

/**
 * Quick check: does this JPEG have 4 components (CMYK)?
 * Scans for SOF0/SOF1 marker and checks component count.
 * @param {Uint8Array} jpegData
 * @returns {boolean}
 */
export function isCMYKJpeg(jpegData) {
  let i = 0;
  while (i < jpegData.length - 10) {
    if (jpegData[i] !== 0xFF) { i++; continue; }
    const marker = jpegData[i + 1];
    if (marker === 0 || marker === 0xFF) { i++; continue; }
    // SOF0 or SOF1: check component count
    if (marker === 0xC0 || marker === 0xC1) {
      return jpegData[i + 9] === 4;
    }
    // SOS: stop — scan data follows
    if (marker === 0xDA) break;
    // Standalone markers (no segment data): SOI, EOI, RST0-7, TEM
    if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) {
      i += 2;
      continue;
    }
    // Marker with segment: skip length bytes + data
    if (i + 3 < jpegData.length) {
      const segLen = (jpegData[i + 2] << 8) | jpegData[i + 3];
      i += 2 + segLen;
    } else {
      break;
    }
  }
  return false;
}
