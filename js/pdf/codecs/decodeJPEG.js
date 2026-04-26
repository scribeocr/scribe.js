/**
 * Minimal JPEG decoder for CMYK/YCCK images.
 *
 * Many functions adapted from Mozilla pdf.js (Apache 2.0 license).
 */

const idctCos = new Float64Array(64);
for (let x = 0; x < 8; x++) {
  for (let u = 0; u < 8; u++) {
    const alpha = u === 0 ? 1 / Math.sqrt(2) : 1;
    idctCos[x * 8 + u] = alpha * Math.cos((2 * x + 1) * u * Math.PI / 16) / 2;
  }
}

/**
 * Apply 2D IDCT to an 8×8 block in-place using direct computation.
 * Input: dequantized DCT coefficients in natural (row-major) order.
 * Output: pixel values biased by +128 (clamp to 0-255 after).
 * @param {Int32Array} block - 64-element array
 */
function idct2d(block) {
  const tmp = new Float64Array(64);

  // Row pass: 1D IDCT on each row
  for (let x = 0; x < 8; x++) {
    for (let row = 0; row < 8; row++) {
      let sum = 0;
      const ri = row * 8;
      for (let u = 0; u < 8; u++) {
        sum += block[ri + u] * idctCos[x * 8 + u];
      }
      tmp[row * 8 + x] = sum;
    }
  }

  // Column pass: 1D IDCT on each column, store back to block with +128 bias
  for (let y = 0; y < 8; y++) {
    for (let col = 0; col < 8; col++) {
      let sum = 0;
      for (let v = 0; v < 8; v++) {
        sum += tmp[v * 8 + col] * idctCos[y * 8 + v];
      }
      block[y * 8 + col] = Math.round(sum) + 128;
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
 * Decode a CMYK/YCCK JPEG and return raw component data.
 *
 * @param {Uint8Array} jpegData - Raw JPEG file bytes
 * @returns {{ width: number, height: number, components: number, data: Uint8Array, adobeTransform: number }|null}
 *   data is interleaved: for 4 components, [C0,C1,C2,C3, C0,C1,C2,C3, ...]
 *   Returns null if not a 4-component JPEG or on decode failure.
 */
export function decodeJPEGRaw(jpegData) {
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

  const compBuffers = components.map((comp) => {
    const cw = mcuCountX * comp.hSamp * 8;
    const ch = mcuCountY * comp.vSamp * 8;
    return new Uint8Array(cw * ch);
  });
  const compWidths = components.map((comp) => mcuCountX * comp.hSamp * 8);

  const prevDC = new Int32Array(numComponents);

  const reader = new BitReader(jpegData, pos);

  let mcuCount = 0;

  for (let mcuY = 0; mcuY < mcuCountY; mcuY++) {
    for (let mcuX = 0; mcuX < mcuCountX; mcuX++) {
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
            const block = new Int32Array(64);

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

            // Decode AC coefficients
            let k = 1;
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
                block[zigzag[k]] = acVal * qt[k];
              }
              k++;
            }

            idct2d(block);

            const cx = (mcuX * blocksH + bh) * 8;
            const cy = (mcuY * blocksV + bv) * 8;
            const cw = compWidths[ci];
            for (let row = 0; row < 8; row++) {
              for (let col = 0; col < 8; col++) {
                const px = cx + col;
                const py = cy + row;
                let val = block[row * 8 + col];
                if (val < 0) val = 0;
                if (val > 255) val = 255;
                compBuffers[ci][py * cw + px] = val;
              }
            }
          }
        }
      }
      mcuCount++;
    }
  }

  // Bilinear chroma upsampling for subsampled components. Nearest-neighbor
  // reuse produces visible 2×2 (or 2×1) chroma blocks at MCU boundaries.
  // libjpeg-turbo (Chrome, mupdf) applies fancy upsampling by default for
  // the same reason; bilinear is a close approximation.
  const output = new Uint8Array(width * height * numComponents);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const outIdx = (y * width + x) * numComponents;
      for (let ci = 0; ci < numComponents; ci++) {
        const comp = components[ci];
        if (comp.hSamp === maxHSamp && comp.vSamp === maxVSamp) {
          // No subsampling — direct copy
          output[outIdx + ci] = compBuffers[ci][y * compWidths[ci] + x];
        } else {
          // Bilinear interpolation for subsampled components
          const cw = compWidths[ci];
          const ch = mcuCountY * comp.vSamp * 8;
          // Map output pixel to fractional component coordinate
          const fx = x * comp.hSamp / maxHSamp;
          const fy = y * comp.vSamp / maxVSamp;
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
          output[outIdx + ci] = ((v00 * (1 - dx) + v10 * dx) * (1 - dy)
            + (v01 * (1 - dx) + v11 * dx) * dy + 0.5) | 0;
        }
      }
    }
  }

  return {
    width, height, components: numComponents, data: output, adobeTransform,
  };
}

/**
 * Decode a CMYK JPEG and return RGB pixel data as Uint8Array (R,G,B,R,G,B,...).
 *
 * @param {Uint8Array} jpegData - Raw JPEG bytes
 * @param {boolean} [decodeInvert=false]
 * @returns {{ width: number, height: number, rgbData: Uint8Array }|null}
 */
export function decodeCMYKJpegToRGB(jpegData, decodeInvert = false) {
  const raw = decodeJPEGRaw(jpegData);
  if (!raw) return null;

  const {
    width, height, data, adobeTransform,
  } = raw;
  const rgbData = new Uint8Array(width * height * 4); // RGBA for ImageData

  for (let i = 0; i < width * height; i++) {
    const si = i * 4;
    let c = data[si];
    let m = data[si + 1];
    let y = data[si + 2];
    let k = data[si + 3];

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

    // CMYK → RGB using polynomial approximation of US Web Coated (SWOP) v2 ICC profile.
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
      + cn * (0.8842522430003296 * cn + 8.078677503112928 * mn + 30.89978309703729 * yn - 0.23883238689178934 * kn - 14.183019929975921)
      + mn * (10.49593273432072 * mn + 63.02378494754052 * yn + 50.606957656360734 * kn - 112.23884253719248)
      + yn * (0.03296041114873217 * yn + 115.60384449646641 * kn - 193.58209356861505)
      + kn * (-22.33816807309886 * kn - 180.12613974708367);

    const di = i * 4;
    rgbData[di] = ri > 255 ? 255 : (ri < 0 ? 0 : Math.round(ri));
    rgbData[di + 1] = gi > 255 ? 255 : (gi < 0 ? 0 : Math.round(gi));
    rgbData[di + 2] = bi > 255 ? 255 : (bi < 0 ? 0 : Math.round(bi));
    rgbData[di + 3] = 255; // Alpha
  }

  return { width, height, rgbData };
}

/**
 * Decode a Lab JPEG and return RGBA pixel data.
 * JPEG raw bytes encode L (0-255→0-100), a (0-255→-128..127), b (0-255→-128..127).
 * Converts Lab → XYZ → sRGB.
 *
 * @param {Uint8Array} jpegData - Raw JPEG bytes
 * @param {number[]} whitePoint - [Xw, Yw, Zw] CIE white point (e.g., D50: [0.9642, 1, 0.82491])
 * @returns {{ width: number, height: number, rgbData: Uint8Array }|null}
 */
export function decodeLabJpegToRGB(jpegData, whitePoint) {
  const raw = decodeJPEGRaw(jpegData);
  if (!raw || raw.components !== 3) return null;

  const { width, height, data } = raw;
  const rgbData = new Uint8Array(width * height * 4);
  const [Xw, Yw, Zw] = whitePoint;

  for (let i = 0; i < width * height; i++) {
    const si = i * 3;
    // Map JPEG byte values to Lab ranges
    const L = data[si] * 100 / 255;
    const a = data[si + 1] - 128;
    const b = data[si + 2] - 128;

    // Lab → XYZ
    const fy = (L + 16) / 116;
    const fx = a / 500 + fy;
    const fz = fy - b / 200;

    const xr = fx > 6 / 29 ? fx * fx * fx : (fx - 16 / 116) * 3 * (6 / 29) * (6 / 29);
    const yr = fy > 6 / 29 ? fy * fy * fy : (fy - 16 / 116) * 3 * (6 / 29) * (6 / 29);
    const zr = fz > 6 / 29 ? fz * fz * fz : (fz - 16 / 116) * 3 * (6 / 29) * (6 / 29);

    const X = xr * Xw;
    const Y = yr * Yw;
    const Z = zr * Zw;

    // XYZ (D50) → sRGB (D65) via Bradford chromatic adaptation + sRGB matrix
    // Combined D50→D65 adapted sRGB matrix:
    const lr = 3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z;
    const lg = -0.9787684 * X + 1.9161415 * Y + 0.0334540 * Z;
    const lb = 0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z;

    // sRGB gamma
    const gamma = (v) => {
      if (v <= 0.0031308) return 12.92 * v;
      return 1.055 * (v ** (1 / 2.4)) - 0.055;
    };

    const di = i * 4;
    rgbData[di] = Math.max(0, Math.min(255, Math.round(gamma(lr) * 255)));
    rgbData[di + 1] = Math.max(0, Math.min(255, Math.round(gamma(lg) * 255)));
    rgbData[di + 2] = Math.max(0, Math.min(255, Math.round(gamma(lb) * 255)));
    rgbData[di + 3] = 255;
  }

  return { width, height, rgbData };
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
