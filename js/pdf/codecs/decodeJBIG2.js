/**
 * JBIG2 decoder.
 *
 * Adapted from Mozilla pdf.js (Apache 2.0 license).
 */

import { CCITTFaxDecoder } from './decodeCCITT.js';
import { ArithmeticDecoder, QeTable } from './decodeMQ.js';

const MIN_INT_32 = -(2 ** 31);
const MAX_INT_32 = 2 ** 31 - 1;

// Keeps every bit position of a packed text-region row, plus the page's bit offset, inside a 32-bit integer.
const MAX_PACKED_WIDTH = 0x7ffffff8;

function log2(x) {
  if (x <= 0) {
    return 0;
  }
  return Math.ceil(Math.log2(x));
}

function readInt8(data, offset) {
  return (data[offset] << 24) >> 24;
}

function readUint16(data, offset) {
  return (data[offset] << 8) | data[offset + 1];
}

function readUint32(data, offset) {
  return ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
}

class Jbig2Error extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'Jbig2Error';
  }
}

class ContextCache {
  getContexts(id, size) {
    const contexts = this[id];
    if (contexts !== undefined && contexts.length >= size) {
      return contexts;
    }
    const sized = new Int8Array(size);
    if (contexts !== undefined) {
      sized.set(contexts);
    }
    return this[id] = sized;
  }
}

class DecodingContext {
  constructor(data, start, end) {
    this.data = data;
    this.start = start;
    this.end = end;
  }

  get decoder() {
    const decoder = new ArithmeticDecoder(this.data, this.start, this.end);
    Object.defineProperty(this, 'decoder', { value: decoder });
    return decoder;
  }

  get contextCache() {
    const cache = new ContextCache();
    Object.defineProperty(this, 'contextCache', { value: cache });
    return cache;
  }
}

const INTEGER_CONTEXTS = 512;
const INTEGER_VALUE_BITS = [2, 4, 6, 8, 12, 32];
const INTEGER_VALUE_OFFSETS = [0, 4, 20, 84, 340, 4436];

function decodeInteger(contextCache, procedure, decoder) {
  const contexts = contextCache.getContexts(procedure, INTEGER_CONTEXTS);
  const sign = decoder.readBit(contexts, 1);
  let prev = 2 | sign;
  let ones = 0;
  while (ones < 5) {
    const bit = decoder.readBit(contexts, prev);
    prev = prev << 1 | bit;
    if (bit === 0) {
      break;
    }
    ones++;
  }
  const length = INTEGER_VALUE_BITS[ones];
  let bits = 0;
  for (let i = 0; i < length; i++) {
    const bit = decoder.readBit(contexts, prev);
    prev = prev < 256 ? prev << 1 | bit : (prev << 1 | bit) & 511 | 256;
    bits = bits << 1 | bit;
  }
  const value = (bits >>> 0) + INTEGER_VALUE_OFFSETS[ones];
  if (sign) {
    // A negative zero is the out-of-band value.
    return value !== 0 && -value >= MIN_INT_32 ? -value : null;
  }
  return value <= MAX_INT_32 ? value : null;
}

function decodeIAID(contextCache, decoder, codeLength) {
  const contexts = contextCache.getContexts('IAID', codeLength < 16 ? 1 << codeLength : 1 << 16);
  let prev = 1;
  for (let i = 0; i < codeLength; i++) {
    const bit = decoder.readBit(contexts, prev);
    prev = prev << 1 | bit;
  }
  if (codeLength < 31) {
    return prev & (1 << codeLength) - 1;
  }
  return prev & 0x7fffffff;
}

const SegmentTypes = ['SymbolDictionary', null, null, null, 'IntermediateTextRegion', null, 'ImmediateTextRegion',
  'ImmediateLosslessTextRegion', null, null, null, null, null, null, null, null, 'PatternDictionary', null, null,
  null, 'IntermediateHalftoneRegion', null, 'ImmediateHalftoneRegion', 'ImmediateLosslessHalftoneRegion', null, null,
  null, null, null, null, null, null, null, null, null, null, 'IntermediateGenericRegion', null, 'ImmediateGenericRegion',
  'ImmediateLosslessGenericRegion', 'IntermediateGenericRefinementRegion', null, 'ImmediateGenericRefinementRegion',
  'ImmediateLosslessGenericRefinementRegion', null, null, null, null, 'PageInformation', 'EndOfPage', 'EndOfStripe',
  'EndOfFile', 'Profiles', 'Tables', null, null, null, null, null, null, null, null, 'Extension'];

const CodingTemplates = [[{
  x: -1,
  y: -2,
}, {
  x: 0,
  y: -2,
}, {
  x: 1,
  y: -2,
}, {
  x: -2,
  y: -1,
}, {
  x: -1,
  y: -1,
}, {
  x: 0,
  y: -1,
}, {
  x: 1,
  y: -1,
}, {
  x: 2,
  y: -1,
}, {
  x: -4,
  y: 0,
}, {
  x: -3,
  y: 0,
}, {
  x: -2,
  y: 0,
}, {
  x: -1,
  y: 0,
}], [{
  x: -1,
  y: -2,
}, {
  x: 0,
  y: -2,
}, {
  x: 1,
  y: -2,
}, {
  x: 2,
  y: -2,
}, {
  x: -2,
  y: -1,
}, {
  x: -1,
  y: -1,
}, {
  x: 0,
  y: -1,
}, {
  x: 1,
  y: -1,
}, {
  x: 2,
  y: -1,
}, {
  x: -3,
  y: 0,
}, {
  x: -2,
  y: 0,
}, {
  x: -1,
  y: 0,
}], [{
  x: -1,
  y: -2,
}, {
  x: 0,
  y: -2,
}, {
  x: 1,
  y: -2,
}, {
  x: -2,
  y: -1,
}, {
  x: -1,
  y: -1,
}, {
  x: 0,
  y: -1,
}, {
  x: 1,
  y: -1,
}, {
  x: -2,
  y: 0,
}, {
  x: -1,
  y: 0,
}], [{
  x: -3,
  y: -1,
}, {
  x: -2,
  y: -1,
}, {
  x: -1,
  y: -1,
}, {
  x: 0,
  y: -1,
}, {
  x: 1,
  y: -1,
}, {
  x: -4,
  y: 0,
}, {
  x: -3,
  y: 0,
}, {
  x: -2,
  y: 0,
}, {
  x: -1,
  y: 0,
}]];

const RefinementTemplates = [{
  coding: [{
    x: 0,
    y: -1,
  }, {
    x: 1,
    y: -1,
  }, {
    x: -1,
    y: 0,
  }],
  reference: [{
    x: 0,
    y: -1,
  }, {
    x: 1,
    y: -1,
  }, {
    x: -1,
    y: 0,
  }, {
    x: 0,
    y: 0,
  }, {
    x: 1,
    y: 0,
  }, {
    x: -1,
    y: 1,
  }, {
    x: 0,
    y: 1,
  }, {
    x: 1,
    y: 1,
  }],
}, {
  coding: [{
    x: -1,
    y: -1,
  }, {
    x: 0,
    y: -1,
  }, {
    x: 1,
    y: -1,
  }, {
    x: -1,
    y: 0,
  }],
  reference: [{
    x: 0,
    y: -1,
  }, {
    x: -1,
    y: 0,
  }, {
    x: 0,
    y: 0,
  }, {
    x: 1,
    y: 0,
  }, {
    x: 0,
    y: 1,
  }, {
    x: 1,
    y: 1,
  }],
}];

const ReusedContexts = [0x9b25, 0x0795, 0x00e5, 0x0195];
const RefinementReusedContexts = [0x0020, 0x0008];

function isNominalTemplate0(templateIndex, at) {
  return templateIndex === 0 && at.length === 4 && at[0].x === 3 && at[0].y === -1
    && at[1].x === -3 && at[1].y === -1 && at[2].x === 2 && at[2].y === -2 && at[3].x === -2 && at[3].y === -2;
}

const MQ_QE = QeTable.qe;
const MQ_NMPS = QeTable.nmps;
const MQ_NLPS = QeTable.nlps;
const MQ_SWITCH = QeTable.switchFlag;

function decodeBitmapTemplate0(width, height, decodingContext) {
  const decoder = decodingContext.decoder;
  const contexts = decodingContext.contextCache.getContexts('GB', 1 << 16);
  const bitmap = [];
  const backing = new Uint8Array(width * height);
  let contextLabel; let i; let j; let pixel; let row; let row1; let
    row2;
  const OLD_PIXEL_MASK = 0x7bf7;
  for (i = 0; i < height; i++) {
    row = bitmap[i] = backing.subarray(i * width, (i + 1) * width);
    row1 = i < 1 ? row : bitmap[i - 1];
    row2 = i < 2 ? row : bitmap[i - 2];
    contextLabel = row2[0] << 13 | row2[1] << 12 | row2[2] << 11 | row1[0] << 7 | row1[1] << 6 | row1[2] << 5 | row1[3] << 4;
    // The main loop runs only while j+4 stays in range, so the neighbour reads need no bounds checks.
    // The short tail keeps the bounds checks.
    const jMain = width > 4 ? width - 4 : 0;
    for (j = 0; j < jMain; j++) {
      row[j] = pixel = decoder.readBit(contexts, contextLabel);
      contextLabel = (contextLabel & OLD_PIXEL_MASK) << 1 | row2[j + 3] << 11 | row1[j + 4] << 4 | pixel;
    }
    for (; j < width; j++) {
      row[j] = pixel = decoder.readBit(contexts, contextLabel);
      contextLabel = (contextLabel & OLD_PIXEL_MASK) << 1 | (j + 3 < width ? row2[j + 3] << 11 : 0) | (j + 4 < width ? row1[j + 4] << 4 : 0) | pixel;
    }
  }
  return bitmap;
}

function decodeBitmapTemplate0Packed(width, height, prediction, decodingContext, out, offset, stride) {
  const decoder = decodingContext.decoder;
  const contexts = decodingContext.contextCache.getContexts('GB', 1 << 16);
  if (width === 0) return;
  const data = decoder.data;
  const dataEnd = decoder.dataEnd;
  let a = decoder.a;
  let chigh = decoder.chigh;
  let clow = decoder.clow;
  let ct = decoder.ct;
  let bp = decoder.bp;
  const predictionLabel = ReusedContexts[0];
  let ltp = 0;
  // A page region can reach 2^31 pixels wide, so pixel widths and x coordinates avoid 32-bit shifts.
  const rowBytes = Math.ceil(width / 8);
  const lastByte = rowBytes - 1;
  const lastShiftEnd = 8 - (width - lastByte * 8);
  const whiteRow = new Uint8Array(rowBytes);
  for (let i = 0, rowStart = offset; i < height; i++, rowStart += stride) {
    if (prediction) {
      const cx = contexts[predictionLabel];
      let index = cx >> 1;
      let mps = cx & 1;
      const qe = MQ_QE[index];
      let bit;
      a -= qe;
      if (chigh >= qe && (a & 0x8000) !== 0) {
        chigh -= qe;
        bit = mps;
      } else {
        if (chigh < qe) {
          if (a < qe) {
            bit = mps;
            index = MQ_NMPS[index];
          } else {
            bit = mps ^ 1;
            if (MQ_SWITCH[index] === 1) mps = bit;
            index = MQ_NLPS[index];
          }
          a = qe;
        } else {
          chigh -= qe;
          if (a < qe) {
            bit = mps ^ 1;
            if (MQ_SWITCH[index] === 1) mps = bit;
            index = MQ_NLPS[index];
          } else {
            bit = mps;
            index = MQ_NMPS[index];
          }
        }
        do {
          if (ct === 0) {
            if (data[bp] === 0xff) {
              if (data[bp + 1] > 0x8f) {
                clow += 0xff00;
                ct = 8;
              } else {
                bp++;
                clow += data[bp] << 9;
                ct = 7;
              }
            } else {
              bp++;
              clow += bp < dataEnd ? data[bp] << 8 : 0xff00;
              ct = 8;
            }
            if (clow > 0xffff) {
              chigh += clow >> 16;
              clow &= 0xffff;
            }
          }
          a <<= 1;
          chigh = ((chigh << 1) & 0xffff) | ((clow >> 15) & 1);
          clow = (clow << 1) & 0xffff;
          ct--;
        } while ((a & 0x8000) === 0);
        contexts[predictionLabel] = index << 1 | mps;
      }
      ltp ^= bit;
      if (ltp) {
        if (i >= 1) out.copyWithin(rowStart, rowStart - stride, rowStart - stride + rowBytes);
        else out.fill(0, rowStart, rowStart + rowBytes);
        continue;
      }
    }
    const above1 = i >= 1 ? out : whiteRow;
    const above1Start = i >= 1 ? rowStart - stride : 0;
    const above2 = i >= 2 ? out : whiteRow;
    const above2Start = i >= 2 ? rowStart - 2 * stride : 0;
    let window1 = above1[above1Start];
    let window2 = above2[above2Start];
    let pixels = 0;
    let firstShift = 8;
    bytes: for (let b = 0; b < rowBytes; b++) {
      const notLast = b < lastByte;
      window1 = (window1 << 8 | (notLast ? above1[above1Start + b + 1] : 0)) & 0xffffff;
      window2 = (window2 << 8 | (notLast ? above2[above2Start + b + 1] : 0)) & 0xffffff;
      const shiftEnd = notLast ? 0 : lastShiftEnd;
      if (((window1 & 0x7ffe0) | (window2 & 0x3ffc0)) === 0) {
        for (let shift = firstShift; shift > shiftEnd; shift--) {
          const label = pixels & 0xf;
          if (label === 0) {
            const state = contexts[0];
            const qe = MQ_QE[state >> 1];
            const room = chigh < a - 0x8000 ? chigh : a - 0x8000;
            if ((state & 1) === 0 && room >= qe << 1) {
              const x = b * 8 + 8 - shift;
              let stop = x + (room / qe | 0);
              if (stop > width) stop = width;
              const scanLast = Math.floor((stop + 2) / 8);
              const scanEnd = scanLast < lastByte ? scanLast : lastByte;
              for (let t = b + 1; t <= scanEnd; t++) {
                const byte1 = above1[above1Start + t];
                const byte2 = above2[above2Start + t];
                if ((byte1 | byte2) !== 0) {
                  if (byte1 !== 0 && t * 8 + Math.clz32(byte1) - 27 < stop) stop = t * 8 + Math.clz32(byte1) - 27;
                  if (byte2 !== 0 && t * 8 + Math.clz32(byte2) - 26 < stop) stop = t * 8 + Math.clz32(byte2) - 26;
                  break;
                }
              }
              const m = stop - x;
              if (m >= 2) {
                const take = m * qe;
                a -= take;
                chigh -= take;
                const left = shift - shiftEnd;
                if (m < left) {
                  pixels <<= m;
                  shift -= m - 1;
                  continue;
                }
                out[rowStart + b] = pixels << left << shiftEnd & 0xff;
                let rest = m - left;
                let next = b + 1;
                for (; rest >= 8; rest -= 8) out[rowStart + next++] = 0;
                if (next > lastByte) break bytes;
                window1 = above1[above1Start + next - 1] << 8 | above1[above1Start + next];
                window2 = above2[above2Start + next - 1] << 8 | above2[above2Start + next];
                pixels = 0;
                firstShift = 8 - rest;
                b = next - 1;
                continue bytes;
              }
            }
          }
          const cx = contexts[label];
          let index = cx >> 1;
          let mps = cx & 1;
          const qe = MQ_QE[index];
          let pixel;
          a -= qe;
          if (chigh >= qe && (a & 0x8000) !== 0) {
            chigh -= qe;
            pixel = mps;
          } else {
            if (chigh < qe) {
              if (a < qe) {
                pixel = mps;
                index = MQ_NMPS[index];
              } else {
                pixel = mps ^ 1;
                if (MQ_SWITCH[index] === 1) mps = pixel;
                index = MQ_NLPS[index];
              }
              a = qe;
            } else {
              chigh -= qe;
              if (a < qe) {
                pixel = mps ^ 1;
                if (MQ_SWITCH[index] === 1) mps = pixel;
                index = MQ_NLPS[index];
              } else {
                pixel = mps;
                index = MQ_NMPS[index];
              }
            }
            do {
              if (ct === 0) {
                if (data[bp] === 0xff) {
                  if (data[bp + 1] > 0x8f) {
                    clow += 0xff00;
                    ct = 8;
                  } else {
                    bp++;
                    clow += data[bp] << 9;
                    ct = 7;
                  }
                } else {
                  bp++;
                  clow += bp < dataEnd ? data[bp] << 8 : 0xff00;
                  ct = 8;
                }
                if (clow > 0xffff) {
                  chigh += clow >> 16;
                  clow &= 0xffff;
                }
              }
              a <<= 1;
              chigh = ((chigh << 1) & 0xffff) | ((clow >> 15) & 1);
              clow = (clow << 1) & 0xffff;
              ct--;
            } while ((a & 0x8000) === 0);
            contexts[label] = index << 1 | mps;
          }
          pixels = pixels << 1 | pixel;
        }
      } else {
        const window2Up = window2 << 6;
        for (let shift = firstShift; shift > shiftEnd; shift--) {
          const label = (window2Up >> shift & 0xf800) | (window1 >> shift & 0x07f0) | (pixels & 0xf);
          const cx = contexts[label];
          let index = cx >> 1;
          let mps = cx & 1;
          const qe = MQ_QE[index];
          let pixel;
          a -= qe;
          if (chigh >= qe && (a & 0x8000) !== 0) {
            chigh -= qe;
            pixel = mps;
          } else {
            if (chigh < qe) {
              if (a < qe) {
                pixel = mps;
                index = MQ_NMPS[index];
              } else {
                pixel = mps ^ 1;
                if (MQ_SWITCH[index] === 1) mps = pixel;
                index = MQ_NLPS[index];
              }
              a = qe;
            } else {
              chigh -= qe;
              if (a < qe) {
                pixel = mps ^ 1;
                if (MQ_SWITCH[index] === 1) mps = pixel;
                index = MQ_NLPS[index];
              } else {
                pixel = mps;
                index = MQ_NMPS[index];
              }
            }
            do {
              if (ct === 0) {
                if (data[bp] === 0xff) {
                  if (data[bp + 1] > 0x8f) {
                    clow += 0xff00;
                    ct = 8;
                  } else {
                    bp++;
                    clow += data[bp] << 9;
                    ct = 7;
                  }
                } else {
                  bp++;
                  clow += bp < dataEnd ? data[bp] << 8 : 0xff00;
                  ct = 8;
                }
                if (clow > 0xffff) {
                  chigh += clow >> 16;
                  clow &= 0xffff;
                }
              }
              a <<= 1;
              chigh = ((chigh << 1) & 0xffff) | ((clow >> 15) & 1);
              clow = (clow << 1) & 0xffff;
              ct--;
            } while ((a & 0x8000) === 0);
            contexts[label] = index << 1 | mps;
          }
          pixels = pixels << 1 | pixel;
        }
      }
      out[rowStart + b] = pixels << shiftEnd & 0xff;
      pixels &= 0xf;
      firstShift = 8;
    }
  }
  decoder.a = a;
  decoder.chigh = chigh;
  decoder.clow = clow;
  decoder.ct = ct;
  decoder.bp = bp;
}

// A larger symbol takes the byte-per-pixel path, so a size whose allocation an engine refuses there stays refused.
const MAX_PACKED_SYMBOL_PIXELS = 1 << 28;

// MSB-first packed rows with zeroed trailing pad bits.
class PackedSymbol {
  constructor(width, height, packedRows) {
    this.width = width;
    this.height = height;
    this.packedRows = packedRows;
    /** @type {Array<Uint8Array>|null} */
    this.rows = null;
  }
}

function symbolByteRows(symbol) {
  if (symbol.rows !== null) {
    return symbol.rows;
  }
  const { width, height, packedRows } = symbol;
  const backing = new Uint8Array(width * height);
  const rows = [];
  for (let r = 0, at = 0; r < height; r++) {
    const row = backing.subarray(r * width, (r + 1) * width);
    let c = 0;
    for (; c + 8 <= width; c += 8, at++) {
      const v = packedRows[at];
      if (v !== 0) {
        row[c] = v >> 7;
        row[c + 1] = v >> 6 & 1;
        row[c + 2] = v >> 5 & 1;
        row[c + 3] = v >> 4 & 1;
        row[c + 4] = v >> 3 & 1;
        row[c + 5] = v >> 2 & 1;
        row[c + 6] = v >> 1 & 1;
        row[c + 7] = v & 1;
      }
    }
    if (c < width) {
      const v = packedRows[at++];
      for (let k = 7; c < width; c++, k--) {
        row[c] = v >> k & 1;
      }
    }
    rows.push(row);
  }
  symbol.rows = rows;
  return rows;
}

function packByteRow(row, width, out, at) {
  let c = 0;
  for (; c + 8 <= width; c += 8) {
    out[at++] = row[c] << 7 | row[c + 1] << 6 | row[c + 2] << 5 | row[c + 3] << 4 | row[c + 4] << 3 | row[c + 5] << 2
      | row[c + 6] << 1 | row[c + 7];
  }
  if (c < width) {
    let v = 0;
    for (let k = 7; c < width; c++, k--) {
      v |= row[c] << k;
    }
    out[at] = v;
  }
}

// Every byte of the region in `out` must be 0 on entry.
function decodeBitmapTemplate2Packed(width, height, prediction, decodingContext, out, offset, stride) {
  const decoder = decodingContext.decoder;
  const contexts = decodingContext.contextCache.getContexts('GB', 1 << 10);
  if (width === 0) return;
  const rowBytes = Math.ceil(width / 8);
  const lastByte = rowBytes - 1;
  const lastShiftEnd = 8 - (width - lastByte * 8);
  const data = decoder.data;
  const dataEnd = decoder.dataEnd;
  let a = decoder.a;
  let chigh = decoder.chigh;
  let clow = decoder.clow;
  let ct = decoder.ct;
  let bp = decoder.bp;
  const predictionLabel = ReusedContexts[2];
  let ltp = 0;
  for (let i = 0, rowStart = offset; i < height; i++, rowStart += stride) {
    if (prediction) {
      decoder.a = a;
      decoder.chigh = chigh;
      decoder.clow = clow;
      decoder.ct = ct;
      decoder.bp = bp;
      ltp ^= decoder.readBit(contexts, predictionLabel);
      a = decoder.a;
      chigh = decoder.chigh;
      clow = decoder.clow;
      ct = decoder.ct;
      bp = decoder.bp;
      if (ltp) {
        if (i >= 1) out.copyWithin(rowStart, rowStart - stride, rowStart - stride + rowBytes);
        continue;
      }
    }
    const above1 = i >= 1 ? rowStart - stride : rowStart;
    const above2 = i >= 2 ? rowStart - 2 * stride : rowStart;
    let window1 = out[above1];
    let window2 = out[above2];
    let pixels = 0;
    let firstShift = 8;
    bytes: for (let b = 0; b < rowBytes; b++) {
      const notLast = b < lastByte;
      window1 = (window1 << 8 | (notLast ? out[above1 + b + 1] : 0)) & 0xffffff;
      window2 = (window2 << 8 | (notLast ? out[above2 + b + 1] : 0)) & 0xffffff;
      const shiftEnd = notLast ? 0 : lastShiftEnd;
      if (((window1 & 0x3ffc0) | (window2 & 0x1ff80)) === 0) {
        for (let shift = firstShift; shift > shiftEnd; shift--) {
          const label = pixels & 3;
          if (label === 0) {
            const state = contexts[0];
            const qe = MQ_QE[state >> 1];
            const room = chigh < a - 0x8000 ? chigh : a - 0x8000;
            if ((state & 1) === 0 && room >= qe << 1) {
              const x = b * 8 + 8 - shift;
              let stop = x + (room / qe | 0);
              if (stop > width) stop = width;
              const scanLast = Math.floor((stop + 1) / 8);
              const scanEnd = scanLast < lastByte ? scanLast : lastByte;
              for (let t = b + 1; t <= scanEnd; t++) {
                const byte1 = out[above1 + t];
                const byte2 = out[above2 + t];
                if ((byte1 | byte2) !== 0) {
                  if (byte1 !== 0 && t * 8 + Math.clz32(byte1) - 26 < stop) stop = t * 8 + Math.clz32(byte1) - 26;
                  if (byte2 !== 0 && t * 8 + Math.clz32(byte2) - 25 < stop) stop = t * 8 + Math.clz32(byte2) - 25;
                  break;
                }
              }
              const m = stop - x;
              if (m >= 2) {
                const take = m * qe;
                a -= take;
                chigh -= take;
                const left = shift - shiftEnd;
                if (m < left) {
                  pixels <<= m;
                  shift -= m - 1;
                  continue;
                }
                out[rowStart + b] = pixels << left << shiftEnd & 0xff;
                const rest = m - left;
                const next = b + 1 + (rest >> 3);
                if (next > lastByte) break bytes;
                window1 = out[above1 + next - 1] << 8 | out[above1 + next];
                window2 = out[above2 + next - 1] << 8 | out[above2 + next];
                pixels = 0;
                firstShift = 8 - (rest & 7);
                b = next - 1;
                continue bytes;
              }
            }
          }
          const cx = contexts[label];
          let index = cx >> 1;
          let mps = cx & 1;
          const qe = MQ_QE[index];
          let pixel;
          a -= qe;
          if (chigh >= qe && (a & 0x8000) !== 0) {
            chigh -= qe;
            pixel = mps;
          } else {
            if (chigh < qe) {
              if (a < qe) {
                pixel = mps;
                index = MQ_NMPS[index];
              } else {
                pixel = mps ^ 1;
                if (MQ_SWITCH[index] === 1) mps = pixel;
                index = MQ_NLPS[index];
              }
              a = qe;
            } else {
              chigh -= qe;
              if (a < qe) {
                pixel = mps ^ 1;
                if (MQ_SWITCH[index] === 1) mps = pixel;
                index = MQ_NLPS[index];
              } else {
                pixel = mps;
                index = MQ_NMPS[index];
              }
            }
            do {
              if (ct === 0) {
                if (data[bp] === 0xff) {
                  if (data[bp + 1] > 0x8f) {
                    clow += 0xff00;
                    ct = 8;
                  } else {
                    bp++;
                    clow += data[bp] << 9;
                    ct = 7;
                  }
                } else {
                  bp++;
                  clow += bp < dataEnd ? data[bp] << 8 : 0xff00;
                  ct = 8;
                }
                if (clow > 0xffff) {
                  chigh += clow >> 16;
                  clow &= 0xffff;
                }
              }
              a <<= 1;
              chigh = ((chigh << 1) & 0xffff) | ((clow >> 15) & 1);
              clow = (clow << 1) & 0xffff;
              ct--;
            } while ((a & 0x8000) === 0);
            contexts[label] = index << 1 | mps;
          }
          pixels = pixels << 1 | pixel;
        }
      } else {
        const window1Down = window1 >> 3;
        const window2Up = window2 << 1;
        for (let shift = firstShift; shift > shiftEnd; shift--) {
          const label = (window2Up >> shift & 0x380) | (window1Down >> shift & 0x7c) | (pixels & 3);
          const cx = contexts[label];
          let index = cx >> 1;
          let mps = cx & 1;
          const qe = MQ_QE[index];
          let pixel;
          a -= qe;
          if (chigh >= qe && (a & 0x8000) !== 0) {
            chigh -= qe;
            pixel = mps;
          } else {
            if (chigh < qe) {
              if (a < qe) {
                pixel = mps;
                index = MQ_NMPS[index];
              } else {
                pixel = mps ^ 1;
                if (MQ_SWITCH[index] === 1) mps = pixel;
                index = MQ_NLPS[index];
              }
              a = qe;
            } else {
              chigh -= qe;
              if (a < qe) {
                pixel = mps ^ 1;
                if (MQ_SWITCH[index] === 1) mps = pixel;
                index = MQ_NLPS[index];
              } else {
                pixel = mps;
                index = MQ_NMPS[index];
              }
            }
            do {
              if (ct === 0) {
                if (data[bp] === 0xff) {
                  if (data[bp + 1] > 0x8f) {
                    clow += 0xff00;
                    ct = 8;
                  } else {
                    bp++;
                    clow += data[bp] << 9;
                    ct = 7;
                  }
                } else {
                  bp++;
                  clow += bp < dataEnd ? data[bp] << 8 : 0xff00;
                  ct = 8;
                }
                if (clow > 0xffff) {
                  chigh += clow >> 16;
                  clow &= 0xffff;
                }
              }
              a <<= 1;
              chigh = ((chigh << 1) & 0xffff) | ((clow >> 15) & 1);
              clow = (clow << 1) & 0xffff;
              ct--;
            } while ((a & 0x8000) === 0);
            contexts[label] = index << 1 | mps;
          }
          pixels = pixels << 1 | pixel;
        }
      }
      out[rowStart + b] = pixels << shiftEnd & 0xff;
      pixels &= 3;
      firstShift = 8;
    }
  }
  decoder.a = a;
  decoder.chigh = chigh;
  decoder.clow = clow;
  decoder.ct = ct;
  decoder.bp = bp;
}

function decodeBitmap(mmr, width, height, templateIndex, prediction, skip, at, decodingContext) {
  if (mmr) {
    const input = new Reader(decodingContext.data, decodingContext.start, decodingContext.end);
    return decodeMMRBitmap(input, width, height, false);
  }
  if (!skip && !prediction && isNominalTemplate0(templateIndex, at)) {
    return decodeBitmapTemplate0(width, height, decodingContext);
  }
  const useskip = !!skip;
  const template = CodingTemplates[templateIndex].concat(at);
  template.sort((a, b) => a.y - b.y || a.x - b.x);
  const templateLength = template.length;
  const templateX = new Int8Array(templateLength);
  const templateY = new Int8Array(templateLength);
  const changingTemplateEntries = [];
  let reuseMask = 0;
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let c; let
    k;
  for (k = 0; k < templateLength; k++) {
    templateX[k] = template[k].x;
    templateY[k] = template[k].y;
    minX = Math.min(minX, template[k].x);
    maxX = Math.max(maxX, template[k].x);
    minY = Math.min(minY, template[k].y);
    if (k < templateLength - 1 && template[k].y === template[k + 1].y && template[k].x === template[k + 1].x - 1) {
      reuseMask |= 1 << templateLength - 1 - k;
    } else {
      changingTemplateEntries.push(k);
    }
  }
  const changingEntriesLength = changingTemplateEntries.length;
  const changingTemplateX = new Int8Array(changingEntriesLength);
  const changingTemplateY = new Int8Array(changingEntriesLength);
  const changingTemplateBit = new Uint16Array(changingEntriesLength);
  for (c = 0; c < changingEntriesLength; c++) {
    k = changingTemplateEntries[c];
    changingTemplateX[c] = template[k].x;
    changingTemplateY[c] = template[k].y;
    changingTemplateBit[c] = 1 << templateLength - 1 - k;
  }
  const sbb_left = -minX;
  const sbb_top = -minY;
  const sbb_right = width - maxX;
  const pseudoPixelContext = ReusedContexts[templateIndex];
  const backing = new Uint8Array(width * height);
  let backingRow = 0;
  let row = new Uint8Array(width);
  const bitmap = [];
  const decoder = decodingContext.decoder;
  const contexts = decodingContext.contextCache.getContexts('GB', 1 << templateLength);
  let ltp = 0;
  let j;
  let i0;
  let j0;
  let contextLabel = 0;
  let bit;
  let shift;
  for (let i = 0; i < height; i++) {
    if (prediction) {
      const sltp = decoder.readBit(contexts, pseudoPixelContext);
      ltp ^= sltp;
      if (ltp) {
        bitmap.push(row);
        continue;
      }
    }
    {
      const fresh = backing.subarray(backingRow * width, (backingRow + 1) * width);
      backingRow++;
      fresh.set(row);
      row = fresh;
    }
    bitmap.push(row);
    for (j = 0; j < width; j++) {
      if (useskip && skip[i][j]) {
        row[j] = 0;
        continue;
      }
      if (j >= sbb_left && j < sbb_right && i >= sbb_top) {
        contextLabel = contextLabel << 1 & reuseMask;
        for (k = 0; k < changingEntriesLength; k++) {
          i0 = i + changingTemplateY[k];
          j0 = j + changingTemplateX[k];
          bit = bitmap[i0][j0];
          if (bit) {
            bit = changingTemplateBit[k];
            contextLabel |= bit;
          }
        }
      } else {
        contextLabel = 0;
        shift = templateLength - 1;
        for (k = 0; k < templateLength; k++, shift--) {
          j0 = j + templateX[k];
          if (j0 >= 0 && j0 < width) {
            i0 = i + templateY[k];
            if (i0 >= 0) {
              bit = bitmap[i0][j0];
              if (bit) {
                contextLabel |= bit << shift;
              }
            }
          }
        }
      }
      const pixel = decoder.readBit(contexts, contextLabel);
      row[j] = pixel;
    }
  }
  return bitmap;
}

function slideRefinementWindow(window, pixel, above, refAbove, refRow, refBelow) {
  return ((window << 1) & 0x116c) | ((window >> 3) & 0x200) | ((window >> 8) & 1)
    | above << 11 | pixel << 10 | refAbove << 7 | refRow << 4 | refBelow << 1;
}

function refinementTemplate1Label(window) {
  return (window & 0x200) | ((window >> 4) & 0x1c0) | ((window >> 3) & 0x20) | ((window >> 2) & 0x1c) | ((window >> 1) & 3);
}

function decodeRefinement(width, height, templateIndex, referenceBitmap, offsetX, offsetY, prediction, at, decodingContext,
  packed = false) {
  if (referenceBitmap instanceof PackedSymbol) {
    referenceBitmap = symbolByteRows(referenceBitmap);
  }
  const referenceWidth = referenceBitmap[0].length;
  const referenceHeight = referenceBitmap.length;
  const pseudoPixelContext = RefinementReusedContexts[templateIndex];
  const bitmap = [];
  const decoder = decodingContext.decoder;
  const contexts = decodingContext.contextCache.getContexts('GR', 1 << (templateIndex === 0 ? 13 : 10));
  let ltp = 0;
  // The general loop after this branch returns byte rows even when `packed` is set.
  if (width >= 1 && height >= 1
    && (templateIndex !== 0 || at[0].x === -1 && at[0].y === -1 && at[1].x === -1 && at[1].y === -1)) {
    const columnShift = 2 - offsetX;
    const spanStart = Math.max(0, -columnShift);
    const spanEnd = Math.min(width - 2, referenceWidth - columnShift);
    const zeroRow = new Uint8Array(referenceWidth);
    const leftColumn = -1 - offsetX;
    const centerColumn = leftColumn + 1;
    const rightColumn = leftColumn + 2;
    const leftInside = leftColumn >= 0 && leftColumn < referenceWidth;
    const centerInside = centerColumn >= 0 && centerColumn < referenceWidth;
    const rightInside = rightColumn >= 0 && rightColumn < referenceWidth;
    const rowBytes = width + 7 >> 3;
    const packedRows = packed ? new Uint8Array(rowBytes * height) : null;
    const evenRow = packed ? new Uint8Array(width) : null;
    const oddRow = packed && height > 1 ? new Uint8Array(width) : null;
    for (let i = 0; i < height; i++) {
      if (prediction) {
        const sltp = decoder.readBit(contexts, pseudoPixelContext);
        ltp ^= sltp;
        if (ltp) {
          throw new Jbig2Error('prediction is not supported');
        }
      }
      let row;
      let above;
      if (packed) {
        row = i & 1 ? oddRow : evenRow;
        above = i === 0 ? row : i & 1 ? evenRow : oddRow;
      } else {
        row = new Uint8Array(width);
        bitmap.push(row);
        above = i > 0 ? bitmap[i - 1] : row;
      }
      const r = i - offsetY;
      const refAbove = r >= 1 && r <= referenceHeight ? referenceBitmap[r - 1] : zeroRow;
      const refRow = r >= 0 && r < referenceHeight ? referenceBitmap[r] : zeroRow;
      const refBelow = r >= -1 && r < referenceHeight - 1 ? referenceBitmap[r + 1] : zeroRow;
      let window = above[0] << 12 | (width > 1 ? above[1] << 11 : 0);
      if (leftInside) window |= refAbove[leftColumn] | refRow[leftColumn] << 6 | refBelow[leftColumn] << 3;
      if (centerInside) window |= refAbove[centerColumn] << 8 | refRow[centerColumn] << 5 | refBelow[centerColumn] << 2;
      if (rightInside) window |= refAbove[rightColumn] << 7 | refRow[rightColumn] << 4 | refBelow[rightColumn] << 1;
      for (let j = 0; j < width; j++) {
        if (j === spanStart) {
          for (; j < spanEnd; j++) {
            const pixel = decoder.readBit(contexts, templateIndex === 0 ? window : refinementTemplate1Label(window));
            row[j] = pixel;
            const rc = j + columnShift;
            window = slideRefinementWindow(window, pixel, above[j + 2], refAbove[rc], refRow[rc], refBelow[rc]);
          }
        }
        const pixel = decoder.readBit(contexts, templateIndex === 0 ? window : refinementTemplate1Label(window));
        row[j] = pixel;
        const rc = j + columnShift;
        const inside = rc >= 0 && rc < referenceWidth;
        window = slideRefinementWindow(window, pixel, j + 2 < width ? above[j + 2] : 0,
          inside ? refAbove[rc] : 0, inside ? refRow[rc] : 0, inside ? refBelow[rc] : 0);
      }
      if (packed) {
        packByteRow(row, width, packedRows, i * rowBytes);
      }
    }
    return packed ? new PackedSymbol(width, height, packedRows) : bitmap;
  }
  let codingTemplate = RefinementTemplates[templateIndex].coding;
  if (templateIndex === 0) {
    codingTemplate = codingTemplate.concat([at[0]]);
  }
  const codingTemplateLength = codingTemplate.length;
  const codingTemplateX = new Int32Array(codingTemplateLength);
  const codingTemplateY = new Int32Array(codingTemplateLength);
  let k;
  for (k = 0; k < codingTemplateLength; k++) {
    codingTemplateX[k] = codingTemplate[k].x;
    codingTemplateY[k] = codingTemplate[k].y;
  }
  let referenceTemplate = RefinementTemplates[templateIndex].reference;
  if (templateIndex === 0) {
    referenceTemplate = referenceTemplate.concat([at[1]]);
  }
  const referenceTemplateLength = referenceTemplate.length;
  const referenceTemplateX = new Int32Array(referenceTemplateLength);
  const referenceTemplateY = new Int32Array(referenceTemplateLength);
  for (k = 0; k < referenceTemplateLength; k++) {
    referenceTemplateX[k] = referenceTemplate[k].x;
    referenceTemplateY[k] = referenceTemplate[k].y;
  }
  for (let i = 0; i < height; i++) {
    if (prediction) {
      const sltp = decoder.readBit(contexts, pseudoPixelContext);
      ltp ^= sltp;
      if (ltp) {
        throw new Jbig2Error('prediction is not supported');
      }
    }
    const row = new Uint8Array(width);
    bitmap.push(row);
    for (let j = 0; j < width; j++) {
      let i0; let
        j0;
      let contextLabel = 0;
      for (k = 0; k < codingTemplateLength; k++) {
        i0 = i + codingTemplateY[k];
        j0 = j + codingTemplateX[k];
        if (i0 < 0 || j0 < 0 || j0 >= width) {
          contextLabel <<= 1;
        } else {
          contextLabel = contextLabel << 1 | bitmap[i0][j0];
        }
      }
      for (k = 0; k < referenceTemplateLength; k++) {
        i0 = i + referenceTemplateY[k] - offsetY;
        j0 = j + referenceTemplateX[k] - offsetX;
        if (i0 < 0 || i0 >= referenceHeight || j0 < 0 || j0 >= referenceWidth) {
          contextLabel <<= 1;
        } else {
          contextLabel = contextLabel << 1 | referenceBitmap[i0][j0];
        }
      }
      const pixel = decoder.readBit(contexts, contextLabel);
      row[j] = pixel;
    }
  }
  return bitmap;
}

function decodeSymbolDictionary(huffman, refinement, symbols, numberOfNewSymbols, numberOfExportedSymbols,
  huffmanTables, templateIndex, at, refinementTemplateIndex, refinementAt, decodingContext, huffmanInput) {
  if (huffman && refinement) {
    throw new Jbig2Error('symbol refinement with Huffman is not supported');
  }
  const newSymbols = [];
  let currentHeight = 0;
  let symbolCodeLength = log2(symbols.length + numberOfNewSymbols);
  const decoder = decodingContext.decoder;
  const contextCache = decodingContext.contextCache;
  let tableB1; let
    symbolWidths;
  if (huffman) {
    tableB1 = getStandardTable(1);
    symbolWidths = [];
    symbolCodeLength = Math.max(symbolCodeLength, 1);
  }
  let packedTemplate = -1;
  if (!huffman && !refinement) {
    if (isNominalTemplate0(templateIndex, at)) {
      packedTemplate = 0;
    } else if (templateIndex === 2 && at.length === 1 && at[0].x === 2 && at[0].y === -1) {
      packedTemplate = 2;
    }
  }
  while (newSymbols.length < numberOfNewSymbols) {
    const deltaHeight = huffman ? huffmanTables.tableDeltaHeight.decode(huffmanInput) : decodeInteger(contextCache, 'IADH', decoder);
    currentHeight += deltaHeight;
    let currentWidth = 0;
    let totalWidth = 0;
    const firstSymbol = huffman ? symbolWidths.length : 0;
    while (true) {
      const deltaWidth = huffman ? huffmanTables.tableDeltaWidth.decode(huffmanInput) : decodeInteger(contextCache, 'IADW', decoder);
      if (deltaWidth === null) {
        break;
      }
      currentWidth += deltaWidth;
      totalWidth += currentWidth;
      // The inner loop breaks only on an OOB delta-width, which a corrupt stream may never emit.
      if ((huffman ? symbolWidths.length : newSymbols.length) >= numberOfNewSymbols) {
        throw new Jbig2Error('symbol dictionary decoded more symbols than declared');
      }
      let bitmap;
      if (refinement) {
        const numberOfInstances = decodeInteger(contextCache, 'IAAI', decoder);
        if (numberOfInstances > 1) {
          bitmap = decodeTextRegion(huffman, refinement, currentWidth, currentHeight, 0, numberOfInstances,
            1, symbols.concat(newSymbols), symbolCodeLength, 0, 0, 1, 0, huffmanTables, refinementTemplateIndex,
            refinementAt, decodingContext, 0, huffmanInput);
        } else {
          const symbolId = decodeIAID(contextCache, decoder, symbolCodeLength);
          const rdx = decodeInteger(contextCache, 'IARDX', decoder);
          const rdy = decodeInteger(contextCache, 'IARDY', decoder);
          const symbol = symbolId < symbols.length ? symbols[symbolId] : newSymbols[symbolId - symbols.length];
          bitmap = decodeRefinement(currentWidth, currentHeight, refinementTemplateIndex, symbol, rdx, rdy, false, refinementAt, decodingContext);
        }
        newSymbols.push(bitmap);
      } else if (huffman) {
        symbolWidths.push(currentWidth);
      } else if (packedTemplate >= 0 && currentWidth > 0 && currentHeight > 0
        && currentWidth * currentHeight <= MAX_PACKED_SYMBOL_PIXELS) {
        const rowBytes = currentWidth + 7 >> 3;
        const packedRows = new Uint8Array(rowBytes * currentHeight);
        if (packedTemplate === 0) {
          decodeBitmapTemplate0Packed(currentWidth, currentHeight, false, decodingContext, packedRows, 0, rowBytes);
        } else {
          decodeBitmapTemplate2Packed(currentWidth, currentHeight, false, decodingContext, packedRows, 0, rowBytes);
        }
        newSymbols.push(new PackedSymbol(currentWidth, currentHeight, packedRows));
      } else {
        bitmap = decodeBitmap(false, currentWidth, currentHeight, templateIndex, false, null, at, decodingContext);
        newSymbols.push(bitmap);
      }
    }
    if (huffman && !refinement) {
      const bitmapSize = huffmanTables.tableBitmapSize.decode(huffmanInput);
      huffmanInput.byteAlign();
      let collectiveBitmap;
      if (bitmapSize === 0) {
        collectiveBitmap = readUncompressedBitmap(huffmanInput, totalWidth, currentHeight);
      } else {
        const originalEnd = huffmanInput.end;
        const bitmapEnd = huffmanInput.position + bitmapSize;
        huffmanInput.end = bitmapEnd;
        collectiveBitmap = decodeMMRBitmap(huffmanInput, totalWidth, currentHeight, false);
        huffmanInput.end = originalEnd;
        huffmanInput.position = bitmapEnd;
      }
      const numberOfSymbolsDecoded = symbolWidths.length;
      if (firstSymbol === numberOfSymbolsDecoded - 1) {
        newSymbols.push(collectiveBitmap);
      } else {
        let i;
        let y;
        let xMin = 0;
        let xMax;
        let bitmapWidth;
        let symbolBitmap;
        for (i = firstSymbol; i < numberOfSymbolsDecoded; i++) {
          bitmapWidth = symbolWidths[i];
          xMax = xMin + bitmapWidth;
          symbolBitmap = [];
          for (y = 0; y < currentHeight; y++) {
            symbolBitmap.push(collectiveBitmap[y].subarray(xMin, xMax));
          }
          newSymbols.push(symbolBitmap);
          xMin = xMax;
        }
      }
    }
  }
  const exportedSymbols = [];
  const flags = [];
  let currentFlag = false;
  let i;
  let ii;
  const totalSymbolsLength = symbols.length + numberOfNewSymbols;
  while (flags.length < totalSymbolsLength) {
    let runLength = huffman ? tableB1.decode(huffmanInput) : decodeInteger(contextCache, 'IAEX', decoder);
    while (runLength--) {
      flags.push(currentFlag);
    }
    currentFlag = !currentFlag;
  }
  for (i = 0, ii = symbols.length; i < ii; i++) {
    if (flags[i]) {
      exportedSymbols.push(symbols[i]);
    }
  }
  for (let j = 0; j < numberOfNewSymbols; i++, j++) {
    if (flags[i]) {
      exportedSymbols.push(newSymbols[j]);
    }
  }
  return exportedSymbols;
}

function decodeTextRegion(huffman, refinement, width, height, defaultPixelValue, numberOfSymbolInstances,
  stripSize, inputSymbols, symbolCodeLength, transposed, dsOffset, referenceCorner, combinationOperator,
  huffmanTables, refinementTemplateIndex, refinementAt, decodingContext, logStripSize, huffmanInput, packedTarget = null) {
  if (huffman && refinement) {
    throw new Jbig2Error('refinement with Huffman is not supported');
  }
  const bitmap = [];
  let i; let
    row;
  let target = null; let targetStart = 0; let targetStride = 0; let targetBitOffset = 0;
  if (packedTarget) {
    target = packedTarget.data;
    targetStart = packedTarget.start;
    targetStride = packedTarget.stride;
    targetBitOffset = packedTarget.bitOffset;
  } else {
    for (i = 0; i < height; i++) {
      row = new Uint8Array(width);
      if (defaultPixelValue) {
        row.fill(defaultPixelValue);
      }
      bitmap.push(row);
    }
  }
  const decoder = decodingContext.decoder;
  const contextCache = decodingContext.contextCache;
  let stripT = huffman ? -huffmanTables.tableDeltaT.decode(huffmanInput) : -decodeInteger(contextCache, 'IADT', decoder);
  let firstS = 0;
  i = 0;
  while (i < numberOfSymbolInstances) {
    const deltaT = huffman ? huffmanTables.tableDeltaT.decode(huffmanInput) : decodeInteger(contextCache, 'IADT', decoder);
    stripT += deltaT;
    const deltaFirstS = huffman ? huffmanTables.tableFirstS.decode(huffmanInput) : decodeInteger(contextCache, 'IAFS', decoder);
    firstS += deltaFirstS;
    let currentS = firstS;
    do {
      let currentT = 0;
      if (stripSize > 1) {
        currentT = huffman ? huffmanInput.readBits(logStripSize) : decodeInteger(contextCache, 'IAIT', decoder);
      }
      const t = stripSize * stripT + currentT;
      const symbolId = huffman ? huffmanTables.symbolIDTable.decode(huffmanInput) : decodeIAID(contextCache, decoder, symbolCodeLength);
      const applyRefinement = refinement && (huffman ? huffmanInput.readBit() : decodeInteger(contextCache, 'IARI', decoder));
      let symbolBitmap = inputSymbols[symbolId];
      let symbolWidth;
      let symbolHeight;
      if (symbolBitmap instanceof PackedSymbol) {
        symbolWidth = symbolBitmap.width;
        symbolHeight = symbolBitmap.height;
      } else {
        symbolWidth = symbolBitmap[0].length;
        symbolHeight = symbolBitmap.length;
      }
      if (applyRefinement) {
        const rdw = decodeInteger(contextCache, 'IARDW', decoder);
        const rdh = decodeInteger(contextCache, 'IARDH', decoder);
        const rdx = decodeInteger(contextCache, 'IARDX', decoder);
        const rdy = decodeInteger(contextCache, 'IARDY', decoder);
        symbolWidth += rdw;
        symbolHeight += rdh;
        symbolBitmap = decodeRefinement(symbolWidth, symbolHeight, refinementTemplateIndex, symbolBitmap, (rdw >> 1) + rdx, (rdh >> 1) + rdy,
          false, refinementAt, decodingContext, target !== null);
      }
      let increment = 0;
      if (!transposed) {
        if (referenceCorner > 1) {
          currentS += symbolWidth - 1;
        } else {
          increment = symbolWidth - 1;
        }
      } else if (!(referenceCorner & 1)) {
        currentS += symbolHeight - 1;
      } else {
        increment = symbolHeight - 1;
      }
      let offsetT; let
        offsetS;
      if (transposed) {
        // When transposed, S=row and T=column, so swap which bits/dimensions control the offsets.
        offsetT = t - (referenceCorner & 2 ? symbolWidth - 1 : 0);
        offsetS = currentS - (referenceCorner & 1 ? 0 : symbolHeight - 1);
      } else {
        offsetT = t - (referenceCorner & 1 ? 0 : symbolHeight - 1);
        offsetS = currentS - (referenceCorner & 2 ? symbolWidth - 1 : 0);
      }
      let s2; let t2; let
        symbolRow;
      if (!target && symbolBitmap instanceof PackedSymbol) {
        symbolBitmap = symbolByteRows(symbolBitmap);
      }
      if (target) {
        const top = transposed ? offsetS : offsetT;
        const left = transposed ? offsetT : offsetS;
        const firstRow = Math.max(0, -top);
        const endRow = Math.min(symbolHeight, height - top);
        const symbolRowBytes = symbolWidth + 7 >> 3;
        let packedRows = symbolBitmap.packedRows;
        if (packedRows === undefined && firstRow < endRow) {
          packedRows = new Uint8Array(symbolRowBytes * symbolHeight);
          for (let r = 0; r < symbolHeight; r++) {
            packByteRow(symbolBitmap[r], symbolWidth, packedRows, r * symbolRowBytes);
          }
          symbolBitmap.packedRows = packedRows;
        }
        if (left >= 0 && left + symbolWidth <= width) {
          const bit = targetBitOffset + left;
          const shift = bit & 7;
          const back = 8 - shift;
          for (let r = firstRow; r < endRow; r++) {
            const at = targetStart + (top + r) * targetStride + (bit >> 3);
            const from = r * symbolRowBytes;
            let carry = 0;
            let k = 0;
            if (combinationOperator === 0) {
              for (; k < symbolRowBytes; k++) {
                const v = packedRows[from + k];
                target[at + k] |= carry | v >> shift;
                carry = v << back & 0xff;
              }
              if (carry) {
                target[at + k] |= carry;
              }
            } else {
              for (; k < symbolRowBytes; k++) {
                const v = packedRows[from + k];
                target[at + k] ^= carry | v >> shift;
                carry = v << back & 0xff;
              }
              if (carry) {
                target[at + k] ^= carry;
              }
            }
          }
        } else {
          const from = Math.max(0, -left);
          const to = Math.min(symbolWidth, width - left);
          for (let r = firstRow; r < endRow; r++) {
            const symbolRowStart = r * symbolRowBytes;
            const rowStart = targetStart + (top + r) * targetStride;
            for (let c = from; c < to; c++) {
              if (packedRows[symbolRowStart + (c >> 3)] & 0x80 >> (c & 7)) {
                const p = targetBitOffset + left + c;
                if (combinationOperator === 0) {
                  target[rowStart + (p >> 3)] |= 0x80 >> (p & 7);
                } else {
                  target[rowStart + (p >> 3)] ^= 0x80 >> (p & 7);
                }
              }
            }
          }
        }
      } else if (transposed) {
        for (s2 = 0; s2 < symbolHeight; s2++) {
          row = bitmap[offsetS + s2];
          if (!row) {
            continue;
          }
          symbolRow = symbolBitmap[s2];
          const maxWidth = Math.min(width - offsetT, symbolWidth);
          switch (combinationOperator) {
            case 0:
              for (t2 = 0; t2 < maxWidth; t2++) {
                row[offsetT + t2] |= symbolRow[t2];
              }
              break;
            case 2:
              for (t2 = 0; t2 < maxWidth; t2++) {
                row[offsetT + t2] ^= symbolRow[t2];
              }
              break;
            default:
              throw new Jbig2Error(`operator ${combinationOperator} is not supported`);
          }
        }
      } else {
        for (t2 = 0; t2 < symbolHeight; t2++) {
          row = bitmap[offsetT + t2];
          if (!row) {
            continue;
          }
          symbolRow = symbolBitmap[t2];
          switch (combinationOperator) {
            case 0:
              for (s2 = 0; s2 < symbolWidth; s2++) {
                row[offsetS + s2] |= symbolRow[s2];
              }
              break;
            case 2:
              for (s2 = 0; s2 < symbolWidth; s2++) {
                row[offsetS + s2] ^= symbolRow[s2];
              }
              break;
            default:
              throw new Jbig2Error(`operator ${combinationOperator} is not supported`);
          }
        }
      }
      i++;
      const deltaS = huffman ? huffmanTables.tableDeltaS.decode(huffmanInput) : decodeInteger(contextCache, 'IADS', decoder);
      if (deltaS === null) {
        break;
      }
      currentS += increment + deltaS + dsOffset;
    } while (true);
  }
  return bitmap;
}

function decodePatternDictionary(mmr, patternWidth, patternHeight, maxPatternIndex, template, decodingContext) {
  const at = [];
  if (!mmr) {
    at.push({
      x: -patternWidth,
      y: 0,
    });
    if (template === 0) {
      at.push({
        x: -3,
        y: -1,
      }, {
        x: 2,
        y: -2,
      }, {
        x: -2,
        y: -2,
      });
    }
  }
  const collectiveWidth = (maxPatternIndex + 1) * patternWidth;
  const collectiveBitmap = decodeBitmap(mmr, collectiveWidth, patternHeight, template, false, null, at, decodingContext);
  const patterns = [];
  for (let i = 0; i <= maxPatternIndex; i++) {
    const patternBitmap = [];
    const xMin = patternWidth * i;
    const xMax = xMin + patternWidth;
    for (let y = 0; y < patternHeight; y++) {
      patternBitmap.push(collectiveBitmap[y].subarray(xMin, xMax));
    }
    patterns.push(patternBitmap);
  }
  return patterns;
}

function decodeHalftoneRegion(mmr, patterns, template, regionWidth, regionHeight, defaultPixelValue, enableSkip,
  combinationOperator, gridWidth, gridHeight, gridOffsetX, gridOffsetY, gridVectorX, gridVectorY, decodingContext) {
  const skip = null;
  if (enableSkip) {
    throw new Jbig2Error('skip is not supported');
  }
  if (combinationOperator !== 0) {
    throw new Jbig2Error(`operator "${combinationOperator}" is not supported in halftone region`);
  }
  const regionBitmap = [];
  let i; let j; let
    row;
  for (i = 0; i < regionHeight; i++) {
    row = new Uint8Array(regionWidth);
    if (defaultPixelValue) {
      row.fill(defaultPixelValue);
    }
    regionBitmap.push(row);
  }
  const numberOfPatterns = patterns.length;
  const pattern0 = patterns[0];
  const patternWidth = pattern0[0].length;
  const patternHeight = pattern0.length;
  const bitsPerValue = log2(numberOfPatterns);
  const at = [];
  if (!mmr) {
    at.push({
      x: template <= 1 ? 3 : 2,
      y: -1,
    });
    if (template === 0) {
      at.push({
        x: -3,
        y: -1,
      }, {
        x: 2,
        y: -2,
      }, {
        x: -2,
        y: -2,
      });
    }
  }
  const grayScaleBitPlanes = [];
  let mmrInput; let
    bitmap;
  if (mmr) {
    mmrInput = new Reader(decodingContext.data, decodingContext.start, decodingContext.end);
  }
  for (i = bitsPerValue - 1; i >= 0; i--) {
    if (mmr) {
      bitmap = decodeMMRBitmap(mmrInput, gridWidth, gridHeight, true);
    } else {
      bitmap = decodeBitmap(false, gridWidth, gridHeight, template, false, skip, at, decodingContext);
    }
    grayScaleBitPlanes[i] = bitmap;
  }
  let mg; let ng; let bit; let patternIndex; let patternBitmap; let x; let y; let patternRow; let
    regionRow;
  for (mg = 0; mg < gridHeight; mg++) {
    for (ng = 0; ng < gridWidth; ng++) {
      bit = 0;
      patternIndex = 0;
      for (j = bitsPerValue - 1; j >= 0; j--) {
        bit ^= grayScaleBitPlanes[j][mg][ng];
        patternIndex |= bit << j;
      }
      patternBitmap = patterns[patternIndex];
      x = gridOffsetX + mg * gridVectorY + ng * gridVectorX >> 8;
      y = gridOffsetY + mg * gridVectorX - ng * gridVectorY >> 8;
      if (x >= 0 && x + patternWidth <= regionWidth && y >= 0 && y + patternHeight <= regionHeight) {
        for (i = 0; i < patternHeight; i++) {
          regionRow = regionBitmap[y + i];
          patternRow = patternBitmap[i];
          for (j = 0; j < patternWidth; j++) {
            regionRow[x + j] |= patternRow[j];
          }
        }
      } else {
        let regionX; let
          regionY;
        for (i = 0; i < patternHeight; i++) {
          regionY = y + i;
          if (regionY < 0 || regionY >= regionHeight) {
            continue;
          }
          regionRow = regionBitmap[regionY];
          patternRow = patternBitmap[i];
          for (j = 0; j < patternWidth; j++) {
            regionX = x + j;
            if (regionX >= 0 && regionX < regionWidth) {
              regionRow[regionX] |= patternRow[j];
            }
          }
        }
      }
    }
  }
  return regionBitmap;
}

function readSegmentHeader(data, start) {
  const segmentHeader = {};
  segmentHeader.number = readUint32(data, start);
  const flags = data[start + 4];
  const segmentType = flags & 0x3f;
  if (!SegmentTypes[segmentType]) {
    throw new Jbig2Error(`invalid segment type: ${segmentType}`);
  }
  segmentHeader.type = segmentType;
  segmentHeader.typeName = SegmentTypes[segmentType];
  segmentHeader.deferredNonRetain = !!(flags & 0x80);
  const pageAssociationFieldSize = !!(flags & 0x40);
  const referredFlags = data[start + 5];
  let referredToCount = referredFlags >> 5 & 7;
  const retainBits = [referredFlags & 31];
  let position = start + 6;
  if (referredToCount === 7) {
    referredToCount = readUint32(data, position - 1) & 0x1fffffff;
    position += 3;
    let bytes = referredToCount + 8 >> 3;
    retainBits[0] = data[position++];
    while (--bytes > 0) {
      retainBits.push(data[position++]);
    }
  } else if (referredToCount === 5 || referredToCount === 6) {
    throw new Jbig2Error('invalid referred-to flags');
  }
  segmentHeader.retainBits = retainBits;
  let referredToSegmentNumberSize = 4;
  if (segmentHeader.number <= 256) {
    referredToSegmentNumberSize = 1;
  } else if (segmentHeader.number <= 65536) {
    referredToSegmentNumberSize = 2;
  }
  const referredTo = [];
  let i; let
    ii;
  for (i = 0; i < referredToCount; i++) {
    let number;
    if (referredToSegmentNumberSize === 1) {
      number = data[position];
    } else if (referredToSegmentNumberSize === 2) {
      number = readUint16(data, position);
    } else {
      number = readUint32(data, position);
    }
    referredTo.push(number);
    position += referredToSegmentNumberSize;
  }
  segmentHeader.referredTo = referredTo;
  if (!pageAssociationFieldSize) {
    segmentHeader.pageAssociation = data[position++];
  } else {
    segmentHeader.pageAssociation = readUint32(data, position);
    position += 4;
  }
  segmentHeader.length = readUint32(data, position);
  position += 4;
  if (segmentHeader.length === 0xffffffff) {
    if (segmentType === 38) {
      const genericRegionInfo = readRegionSegmentInformation(data, position);
      const genericRegionSegmentFlags = data[position + RegionSegmentInformationFieldLength];
      const genericRegionMmr = !!(genericRegionSegmentFlags & 1);
      const searchPatternLength = 6;
      const searchPattern = new Uint8Array(searchPatternLength);
      if (!genericRegionMmr) {
        searchPattern[0] = 0xff;
        searchPattern[1] = 0xac;
      }
      searchPattern[2] = genericRegionInfo.height >>> 24 & 0xff;
      searchPattern[3] = genericRegionInfo.height >> 16 & 0xff;
      searchPattern[4] = genericRegionInfo.height >> 8 & 0xff;
      searchPattern[5] = genericRegionInfo.height & 0xff;
      for (i = position, ii = data.length; i < ii; i++) {
        let j = 0;
        while (j < searchPatternLength && searchPattern[j] === data[i + j]) {
          j++;
        }
        if (j === searchPatternLength) {
          segmentHeader.length = i + searchPatternLength;
          break;
        }
      }
      if (segmentHeader.length === 0xffffffff) {
        throw new Jbig2Error('segment end was not found');
      }
    } else {
      throw new Jbig2Error('invalid unknown segment length');
    }
  }
  segmentHeader.headerEnd = position;
  return segmentHeader;
}

function readSegments(header, data, start, end) {
  const segments = [];
  let position = start;
  while (position < end) {
    const segmentHeader = readSegmentHeader(data, position);
    position = segmentHeader.headerEnd;
    const segment = {
      header: segmentHeader,
      data,
    };
    if (!header.randomAccess) {
      segment.start = position;
      position += segmentHeader.length;
      segment.end = position;
    }
    segments.push(segment);
    if (segmentHeader.type === 51) {
      break;
    }
  }
  if (header.randomAccess) {
    for (let i = 0, ii = segments.length; i < ii; i++) {
      segments[i].start = position;
      position += segments[i].header.length;
      segments[i].end = position;
    }
  }
  return segments;
}

function readRegionSegmentInformation(data, start) {
  return {
    width: readUint32(data, start),
    height: readUint32(data, start + 4),
    x: readUint32(data, start + 8),
    y: readUint32(data, start + 12),
    combinationOperator: data[start + 16] & 7,
  };
}

const RegionSegmentInformationFieldLength = 17;

function processSegment(segment, visitor) {
  const header = segment.header;
  const data = segment.data;
  const end = segment.end;
  let position = segment.start;
  let args; let at; let i; let
    atLength;
  switch (header.type) {
    case 0:
      const dictionary = {};
      const dictionaryFlags = readUint16(data, position);
      dictionary.huffman = !!(dictionaryFlags & 1);
      dictionary.refinement = !!(dictionaryFlags & 2);
      dictionary.huffmanDHSelector = dictionaryFlags >> 2 & 3;
      dictionary.huffmanDWSelector = dictionaryFlags >> 4 & 3;
      dictionary.bitmapSizeSelector = dictionaryFlags >> 6 & 1;
      dictionary.aggregationInstancesSelector = dictionaryFlags >> 7 & 1;
      dictionary.bitmapCodingContextUsed = !!(dictionaryFlags & 256);
      dictionary.bitmapCodingContextRetained = !!(dictionaryFlags & 512);
      dictionary.template = dictionaryFlags >> 10 & 3;
      dictionary.refinementTemplate = dictionaryFlags >> 12 & 1;
      position += 2;
      if (!dictionary.huffman) {
        atLength = dictionary.template === 0 ? 4 : 1;
        at = [];
        for (i = 0; i < atLength; i++) {
          at.push({
            x: readInt8(data, position),
            y: readInt8(data, position + 1),
          });
          position += 2;
        }
        dictionary.at = at;
      }
      if (dictionary.refinement && !dictionary.refinementTemplate) {
        at = [];
        for (i = 0; i < 2; i++) {
          at.push({
            x: readInt8(data, position),
            y: readInt8(data, position + 1),
          });
          position += 2;
        }
        dictionary.refinementAt = at;
      }
      dictionary.numberOfExportedSymbols = readUint32(data, position);
      position += 4;
      dictionary.numberOfNewSymbols = readUint32(data, position);
      position += 4;
      args = [dictionary, header.number, header.referredTo, data, position, end];
      break;
    case 6:
    case 7:
      const textRegion = {};
      textRegion.info = readRegionSegmentInformation(data, position);
      position += RegionSegmentInformationFieldLength;
      const textRegionSegmentFlags = readUint16(data, position);
      position += 2;
      textRegion.huffman = !!(textRegionSegmentFlags & 1);
      textRegion.refinement = !!(textRegionSegmentFlags & 2);
      textRegion.logStripSize = textRegionSegmentFlags >> 2 & 3;
      textRegion.stripSize = 1 << textRegion.logStripSize;
      textRegion.referenceCorner = textRegionSegmentFlags >> 4 & 3;
      textRegion.transposed = !!(textRegionSegmentFlags & 64);
      textRegion.combinationOperator = textRegionSegmentFlags >> 7 & 3;
      textRegion.defaultPixelValue = textRegionSegmentFlags >> 9 & 1;
      textRegion.dsOffset = textRegionSegmentFlags << 17 >> 27;
      textRegion.refinementTemplate = textRegionSegmentFlags >> 15 & 1;
      if (textRegion.huffman) {
        const textRegionHuffmanFlags = readUint16(data, position);
        position += 2;
        textRegion.huffmanFS = textRegionHuffmanFlags & 3;
        textRegion.huffmanDS = textRegionHuffmanFlags >> 2 & 3;
        textRegion.huffmanDT = textRegionHuffmanFlags >> 4 & 3;
        textRegion.huffmanRefinementDW = textRegionHuffmanFlags >> 6 & 3;
        textRegion.huffmanRefinementDH = textRegionHuffmanFlags >> 8 & 3;
        textRegion.huffmanRefinementDX = textRegionHuffmanFlags >> 10 & 3;
        textRegion.huffmanRefinementDY = textRegionHuffmanFlags >> 12 & 3;
        textRegion.huffmanRefinementSizeSelector = !!(textRegionHuffmanFlags & 0x4000);
      }
      if (textRegion.refinement && !textRegion.refinementTemplate) {
        at = [];
        for (i = 0; i < 2; i++) {
          at.push({
            x: readInt8(data, position),
            y: readInt8(data, position + 1),
          });
          position += 2;
        }
        textRegion.refinementAt = at;
      }
      textRegion.numberOfSymbolInstances = readUint32(data, position);
      position += 4;
      args = [textRegion, header.referredTo, data, position, end];
      break;
    case 16:
      const patternDictionary = {};
      const patternDictionaryFlags = data[position++];
      patternDictionary.mmr = !!(patternDictionaryFlags & 1);
      patternDictionary.template = patternDictionaryFlags >> 1 & 3;
      patternDictionary.patternWidth = data[position++];
      patternDictionary.patternHeight = data[position++];
      patternDictionary.maxPatternIndex = readUint32(data, position);
      position += 4;
      args = [patternDictionary, header.number, data, position, end];
      break;
    case 22:
    case 23:
      const halftoneRegion = {};
      halftoneRegion.info = readRegionSegmentInformation(data, position);
      position += RegionSegmentInformationFieldLength;
      const halftoneRegionFlags = data[position++];
      halftoneRegion.mmr = !!(halftoneRegionFlags & 1);
      halftoneRegion.template = halftoneRegionFlags >> 1 & 3;
      halftoneRegion.enableSkip = !!(halftoneRegionFlags & 8);
      halftoneRegion.combinationOperator = halftoneRegionFlags >> 4 & 7;
      halftoneRegion.defaultPixelValue = halftoneRegionFlags >> 7 & 1;
      halftoneRegion.gridWidth = readUint32(data, position);
      position += 4;
      halftoneRegion.gridHeight = readUint32(data, position);
      position += 4;
      halftoneRegion.gridOffsetX = readUint32(data, position) & 0xffffffff;
      position += 4;
      halftoneRegion.gridOffsetY = readUint32(data, position) & 0xffffffff;
      position += 4;
      halftoneRegion.gridVectorX = readUint16(data, position);
      position += 2;
      halftoneRegion.gridVectorY = readUint16(data, position);
      position += 2;
      args = [halftoneRegion, header.referredTo, data, position, end];
      break;
    case 38:
    case 39:
      const genericRegion = {};
      genericRegion.info = readRegionSegmentInformation(data, position);
      position += RegionSegmentInformationFieldLength;
      const genericRegionSegmentFlags = data[position++];
      genericRegion.mmr = !!(genericRegionSegmentFlags & 1);
      genericRegion.template = genericRegionSegmentFlags >> 1 & 3;
      genericRegion.prediction = !!(genericRegionSegmentFlags & 8);
      if (!genericRegion.mmr) {
        atLength = genericRegion.template === 0 ? 4 : 1;
        at = [];
        for (i = 0; i < atLength; i++) {
          at.push({
            x: readInt8(data, position),
            y: readInt8(data, position + 1),
          });
          position += 2;
        }
        genericRegion.at = at;
      }
      args = [genericRegion, data, position, end];
      break;
    case 48:
      const pageInfo = {
        width: readUint32(data, position),
        height: readUint32(data, position + 4),
        resolutionX: readUint32(data, position + 8),
        resolutionY: readUint32(data, position + 12),
      };
      if (pageInfo.height === 0xffffffff) {
        delete pageInfo.height;
      }
      const pageSegmentFlags = data[position + 16];
      readUint16(data, position + 17);
      pageInfo.lossless = !!(pageSegmentFlags & 1);
      pageInfo.refinement = !!(pageSegmentFlags & 2);
      pageInfo.defaultPixelValue = pageSegmentFlags >> 2 & 1;
      pageInfo.combinationOperator = pageSegmentFlags >> 3 & 3;
      pageInfo.requiresBuffer = !!(pageSegmentFlags & 32);
      pageInfo.combinationOperatorOverride = !!(pageSegmentFlags & 64);
      args = [pageInfo];
      break;
    case 49:
      break;
    case 50:
      break;
    case 51:
      break;
    case 53:
      args = [header.number, data, position, end];
      break;
    case 62:
      break;
    default:
      throw new Jbig2Error(`segment type ${header.typeName}(${header.type}) is not implemented`);
  }
  const callbackName = `on${header.typeName}`;
  if (callbackName in visitor) {
    visitor[callbackName].apply(visitor, args);
  }
}

function processSegments(segments, visitor) {
  for (let i = 0, ii = segments.length; i < ii; i++) {
    processSegment(segments[i], visitor);
  }
}

function parseJbig2Chunks(chunks) {
  const visitor = new SimpleSegmentVisitor();
  for (let i = 0, ii = chunks.length; i < ii; i++) {
    const chunk = chunks[i];
    const segments = readSegments({}, chunk.data, chunk.start, chunk.end);
    processSegments(segments, visitor);
  }
  return visitor.buffer;
}

class SimpleSegmentVisitor {
  onPageInformation(info) {
    this.currentPageInfo = info;
    const rowSize = info.width + 7 >> 3;
    if (info.height != null) {
      const buffer = new Uint8ClampedArray(rowSize * info.height);
      if (info.defaultPixelValue) {
        buffer.fill(0xff);
      }
      this.buffer = buffer;
    } else {
      this.buffer = new Uint8ClampedArray(0);
    }
    // The regions drawn on this page so far, or null once one has written outside its own box.
    this.drawnRegions = [];
  }

  preparePage(regionInfo) {
    const pageInfo = this.currentPageInfo;
    const rowSize = pageInfo.width + 7 >> 3;
    const combinationOperator = pageInfo.combinationOperatorOverride ? regionInfo.combinationOperator : pageInfo.combinationOperator;
    // Grow buffer if page height was initially unknown.
    const requiredSize = (regionInfo.y + regionInfo.height) * rowSize;
    if (requiredSize > this.buffer.length) {
      const newBuffer = new Uint8ClampedArray(requiredSize);
      if (pageInfo.defaultPixelValue) {
        newBuffer.fill(0xff);
        // Existing bytes already have the correct values, overwrite the prefix.
      }
      newBuffer.set(this.buffer);
      this.buffer = newBuffer;
    }
    if (combinationOperator !== 0 && combinationOperator !== 2) {
      throw new Jbig2Error(`operator ${combinationOperator} is not supported`);
    }
    // A region wider than what is left of the page row runs on into the next row, outside its own box.
    if (this.drawnRegions) {
      if (regionInfo.x + regionInfo.width <= rowSize * 8) {
        this.drawnRegions.push(regionInfo);
      } else {
        this.drawnRegions = null;
      }
    }
    return combinationOperator;
  }

  drawBitmap(regionInfo, bitmap) {
    const combinationOperator = this.preparePage(regionInfo);
    const width = regionInfo.width;
    const height = regionInfo.height;
    const rowSize = this.currentPageInfo.width + 7 >> 3;
    const buffer = this.buffer;
    const mask0 = 128 >> (regionInfo.x & 7);
    let offset0 = regionInfo.y * rowSize + (regionInfo.x >> 3);
    let i; let j; let mask; let
      offset;
    // Pack 8 pixels per output byte across the aligned middle of each row.
    // The unaligned lead and the tail fall back to the per-pixel mask walk.
    const lead = Math.min((8 - (regionInfo.x & 7)) & 7, width);
    const midBytes = (width - lead) >> 3;
    for (i = 0; i < height; i++) {
      const bitmapRow = bitmap[i];
      mask = mask0;
      offset = offset0;
      for (j = 0; j < lead; j++) {
        if (bitmapRow[j]) {
          if (combinationOperator === 0) buffer[offset] |= mask; else buffer[offset] ^= mask;
        }
        mask >>= 1;
        if (!mask) {
          mask = 128;
          offset++;
        }
      }
      if (combinationOperator === 0) {
        for (let b = 0; b < midBytes; b++, j += 8) {
          const v = bitmapRow[j] << 7 | bitmapRow[j + 1] << 6 | bitmapRow[j + 2] << 5 | bitmapRow[j + 3] << 4
            | bitmapRow[j + 4] << 3 | bitmapRow[j + 5] << 2 | bitmapRow[j + 6] << 1 | bitmapRow[j + 7];
          if (v) buffer[offset] |= v;
          offset++;
        }
      } else {
        for (let b = 0; b < midBytes; b++, j += 8) {
          const v = bitmapRow[j] << 7 | bitmapRow[j + 1] << 6 | bitmapRow[j + 2] << 5 | bitmapRow[j + 3] << 4
            | bitmapRow[j + 4] << 3 | bitmapRow[j + 5] << 2 | bitmapRow[j + 6] << 1 | bitmapRow[j + 7];
          if (v) buffer[offset] ^= v;
          offset++;
        }
      }
      mask = 128;
      for (; j < width; j++) {
        if (bitmapRow[j]) {
          if (combinationOperator === 0) buffer[offset] |= mask; else buffer[offset] ^= mask;
        }
        mask >>= 1;
        if (!mask) {
          mask = 128;
          offset++;
        }
      }
      offset0 += rowSize;
    }
  }

  drawPackedBitmap(regionInfo, packed, rowBytes) {
    const combinationOperator = this.preparePage(regionInfo);
    const height = regionInfo.height;
    const rowSize = this.currentPageInfo.width + 7 >> 3;
    const buffer = this.buffer;
    const page = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
    const shift = regionInfo.x & 7;
    const back = 8 - shift;
    let offset = regionInfo.y * rowSize + (regionInfo.x >> 3);
    for (let i = 0, at = 0; i < height; i++, offset += rowSize) {
      let carry = 0;
      let b = 0;
      if (combinationOperator === 0) {
        for (; b < rowBytes; b++, at++) {
          const v = packed[at];
          const out = carry | v >> shift;
          if (out) page[offset + b] |= out;
          carry = v << back & 0xff;
        }
        if (carry) page[offset + b] |= carry;
      } else {
        for (; b < rowBytes; b++, at++) {
          const v = packed[at];
          const out = carry | v >> shift;
          if (out) page[offset + b] ^= out;
          carry = v << back & 0xff;
        }
        if (carry) page[offset + b] ^= carry;
      }
    }
  }

  onImmediateGenericRegion(region, data, start, end) {
    const regionInfo = region.info;
    const decodingContext = new DecodingContext(data, start, end);
    const width = regionInfo.width;
    const height = regionInfo.height;
    const pageInfo = this.currentPageInfo;
    const template2 = region.template === 2 && region.at.length === 1 && region.at[0].x === 2 && region.at[0].y === -1;
    if (region.mmr || !(template2 || isNominalTemplate0(region.template, region.at)) || !pageInfo
      || width * height > 2 ** 32) {
      const bitmap = decodeBitmap(region.mmr, width, height, region.template, region.prediction, null, region.at, decodingContext);
      this.drawBitmap(regionInfo, bitmap);
      return;
    }
    const kernel = template2 ? decodeBitmapTemplate2Packed : decodeBitmapTemplate0Packed;
    const rowSize = pageInfo.width + 7 >> 3;
    const combinationOperator = pageInfo.combinationOperatorOverride ? regionInfo.combinationOperator : pageInfo.combinationOperator;
    if (this.drawnRegions !== null && this.drawnRegions.length === 0 && !pageInfo.defaultPixelValue
      && (combinationOperator === 0 || combinationOperator === 2) && (regionInfo.x & 7) === 0
      && regionInfo.x + width <= pageInfo.width && pageInfo.height != null && regionInfo.y + height <= pageInfo.height) {
      this.preparePage(regionInfo);
      const buffer = this.buffer;
      const page = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length);
      kernel(width, height, region.prediction, decodingContext, page, regionInfo.y * rowSize + (regionInfo.x >> 3), rowSize);
      return;
    }
    const rowBytes = Math.ceil(width / 8);
    const packed = new Uint8Array(rowBytes * height);
    kernel(width, height, region.prediction, decodingContext, packed, 0, rowBytes);
    this.drawPackedBitmap(regionInfo, packed, rowBytes);
  }

  onImmediateLosslessGenericRegion() {
    this.onImmediateGenericRegion(...arguments);
  }

  onSymbolDictionary(dictionary, currentSegment, referredSegments, data, start, end) {
    let huffmanTables; let
      huffmanInput;
    if (dictionary.huffman) {
      huffmanTables = getSymbolDictionaryHuffmanTables(dictionary, referredSegments, this.customTables);
      huffmanInput = new Reader(data, start, end);
    }
    let symbols = this.symbols;
    if (!symbols) {
      this.symbols = symbols = {};
    }
    const inputSymbols = [];
    for (const referredSegment of referredSegments) {
      const referredSymbols = symbols[referredSegment];
      if (referredSymbols) {
        for (let si = 0; si < referredSymbols.length; si++) inputSymbols.push(referredSymbols[si]);
      }
    }
    const decodingContext = new DecodingContext(data, start, end);
    symbols[currentSegment] = decodeSymbolDictionary(dictionary.huffman, dictionary.refinement,
      inputSymbols, dictionary.numberOfNewSymbols, dictionary.numberOfExportedSymbols,
      huffmanTables, dictionary.template, dictionary.at, dictionary.refinementTemplate,
      dictionary.refinementAt, decodingContext, huffmanInput);
  }

  onImmediateTextRegion(region, referredSegments, data, start, end) {
    const regionInfo = region.info;
    let huffmanTables; let
      huffmanInput;
    const symbols = this.symbols || {};
    const inputSymbols = [];
    for (const referredSegment of referredSegments) {
      const referredSymbols = symbols[referredSegment];
      if (referredSymbols) {
        for (let si = 0; si < referredSymbols.length; si++) inputSymbols.push(referredSymbols[si]);
      }
    }
    const symbolCodeLength = log2(inputSymbols.length);
    if (region.huffman) {
      huffmanInput = new Reader(data, start, end);
      huffmanTables = getTextRegionHuffmanTables(region, referredSegments, this.customTables, inputSymbols.length, huffmanInput);
    }
    const decodingContext = new DecodingContext(data, start, end);
    const textOperator = region.combinationOperator;
    let packedTarget = null;
    let direct = false;
    if (!region.defaultPixelValue && (textOperator === 0 || textOperator === 2) && regionInfo.width <= MAX_PACKED_WIDTH) {
      const pageInfo = this.currentPageInfo;
      const rowSize = pageInfo.width + 7 >> 3;
      const pageOperator = pageInfo.combinationOperatorOverride ? regionInfo.combinationOperator : pageInfo.combinationOperator;
      const {
        x, y, width, height,
      } = regionInfo;
      // The page grows only after a region has decoded, so a region that fails to decode never allocates it.
      direct = (pageOperator === 0 || pageOperator === 2) && x + width <= rowSize * 8 && (y + height) * rowSize <= this.buffer.length
        && (pageOperator === textOperator || (!pageInfo.defaultPixelValue && this.drawnRegions !== null
          && !this.drawnRegions.some((d) => d.x < x + width && x < d.x + d.width && d.y < y + height && y < d.y + d.height)));
      if (direct) {
        this.preparePage(regionInfo);
        const page = this.buffer;
        packedTarget = {
          data: new Uint8Array(page.buffer, page.byteOffset, page.length), start: y * rowSize + (x >> 3), stride: rowSize, bitOffset: x & 7,
        };
      } else {
        const rowBytes = width + 7 >> 3;
        packedTarget = {
          data: new Uint8Array(rowBytes * height), start: 0, stride: rowBytes, bitOffset: 0,
        };
      }
    }
    const bitmap = decodeTextRegion(region.huffman, region.refinement, regionInfo.width,
      regionInfo.height, region.defaultPixelValue, region.numberOfSymbolInstances,
      region.stripSize, inputSymbols, symbolCodeLength, region.transposed, region.dsOffset,
      region.referenceCorner, textOperator, huffmanTables, region.refinementTemplate,
      region.refinementAt, decodingContext, region.logStripSize, huffmanInput, packedTarget);
    if (!packedTarget) {
      this.drawBitmap(regionInfo, bitmap);
    } else if (!direct) {
      this.drawPackedBitmap(regionInfo, packedTarget.data, packedTarget.stride);
    }
  }

  onImmediateLosslessTextRegion() {
    this.onImmediateTextRegion(...arguments);
  }

  onPatternDictionary(dictionary, currentSegment, data, start, end) {
    let patterns = this.patterns;
    if (!patterns) {
      this.patterns = patterns = {};
    }
    const decodingContext = new DecodingContext(data, start, end);
    patterns[currentSegment] = decodePatternDictionary(dictionary.mmr, dictionary.patternWidth, dictionary.patternHeight, dictionary.maxPatternIndex, dictionary.template, decodingContext);
  }

  onImmediateHalftoneRegion(region, referredSegments, data, start, end) {
    const patterns = this.patterns[referredSegments[0]];
    const regionInfo = region.info;
    const decodingContext = new DecodingContext(data, start, end);
    const bitmap = decodeHalftoneRegion(region.mmr, patterns, region.template, regionInfo.width,
      regionInfo.height, region.defaultPixelValue, region.enableSkip, region.combinationOperator,
      region.gridWidth, region.gridHeight, region.gridOffsetX, region.gridOffsetY, region.gridVectorX,
      region.gridVectorY, decodingContext);
    this.drawBitmap(regionInfo, bitmap);
  }

  onImmediateLosslessHalftoneRegion() {
    this.onImmediateHalftoneRegion(...arguments);
  }

  onTables(currentSegment, data, start, end) {
    let customTables = this.customTables;
    if (!customTables) {
      this.customTables = customTables = {};
    }
    customTables[currentSegment] = decodeTablesSegment(data, start, end);
  }
}

class HuffmanLine {
  constructor(lineData) {
    if (lineData.length === 2) {
      this.isOOB = true;
      this.rangeLow = 0;
      this.prefixLength = lineData[0];
      this.rangeLength = 0;
      this.prefixCode = lineData[1];
      this.isLowerRange = false;
    } else {
      this.isOOB = false;
      this.rangeLow = lineData[0];
      this.prefixLength = lineData[1];
      this.rangeLength = lineData[2];
      this.prefixCode = lineData[3];
      this.isLowerRange = lineData[4] === 'lower';
    }
  }
}

class HuffmanTreeNode {
  constructor(line) {
    this.children = [];
    if (line) {
      this.isLeaf = true;
      this.rangeLength = line.rangeLength;
      this.rangeLow = line.rangeLow;
      this.isLowerRange = line.isLowerRange;
      this.isOOB = line.isOOB;
    } else {
      this.isLeaf = false;
    }
  }

  buildTree(line, shift) {
    const bit = line.prefixCode >> shift & 1;
    if (shift <= 0) {
      this.children[bit] = new HuffmanTreeNode(line);
    } else {
      let node = this.children[bit];
      if (!node) {
        this.children[bit] = node = new HuffmanTreeNode(null);
      }
      node.buildTree(line, shift - 1);
    }
  }

  decodeNode(reader) {
    if (this.isLeaf) {
      if (this.isOOB) {
        return null;
      }
      const htOffset = reader.readBits(this.rangeLength);
      return this.rangeLow + (this.isLowerRange ? -htOffset : htOffset);
    }
    const node = this.children[reader.readBit()];
    if (!node) {
      throw new Jbig2Error('invalid Huffman data');
    }
    return node.decodeNode(reader);
  }
}

class HuffmanTable {
  constructor(lines, prefixCodesDone) {
    if (!prefixCodesDone) {
      this.assignPrefixCodes(lines);
    }
    this.rootNode = new HuffmanTreeNode(null);
    for (let i = 0, ii = lines.length; i < ii; i++) {
      const line = lines[i];
      if (line.prefixLength > 0) {
        this.rootNode.buildTree(line, line.prefixLength - 1);
      }
    }
  }

  decode(reader) {
    return this.rootNode.decodeNode(reader);
  }

  assignPrefixCodes(lines) {
    const linesLength = lines.length;
    let prefixLengthMax = 0;
    for (let i = 0; i < linesLength; i++) {
      prefixLengthMax = Math.max(prefixLengthMax, lines[i].prefixLength);
    }
    const histogram = new Uint32Array(prefixLengthMax + 1);
    for (let i = 0; i < linesLength; i++) {
      histogram[lines[i].prefixLength]++;
    }
    let currentLength = 1;
    let firstCode = 0;
    let currentCode;
    let currentTemp;
    let line;
    histogram[0] = 0;
    while (currentLength <= prefixLengthMax) {
      firstCode = firstCode + histogram[currentLength - 1] << 1;
      currentCode = firstCode;
      currentTemp = 0;
      while (currentTemp < linesLength) {
        line = lines[currentTemp];
        if (line.prefixLength === currentLength) {
          line.prefixCode = currentCode;
          currentCode++;
        }
        currentTemp++;
      }
      currentLength++;
    }
  }
}

function decodeTablesSegment(data, start, end) {
  const flags = data[start];
  const lowestValue = readUint32(data, start + 1) & 0xffffffff;
  const highestValue = readUint32(data, start + 5) & 0xffffffff;
  const reader = new Reader(data, start + 9, end);
  const prefixSizeBits = (flags >> 1 & 7) + 1;
  const rangeSizeBits = (flags >> 4 & 7) + 1;
  const lines = [];
  let prefixLength;
  let rangeLength;
  let currentRangeLow = lowestValue;
  do {
    prefixLength = reader.readBits(prefixSizeBits);
    rangeLength = reader.readBits(rangeSizeBits);
    lines.push(new HuffmanLine([currentRangeLow, prefixLength, rangeLength, 0]));
    currentRangeLow += 1 << rangeLength;
  } while (currentRangeLow < highestValue);
  prefixLength = reader.readBits(prefixSizeBits);
  lines.push(new HuffmanLine([lowestValue - 1, prefixLength, 32, 0, 'lower']));
  prefixLength = reader.readBits(prefixSizeBits);
  lines.push(new HuffmanLine([highestValue, prefixLength, 32, 0]));
  if (flags & 1) {
    prefixLength = reader.readBits(prefixSizeBits);
    lines.push(new HuffmanLine([prefixLength, 0]));
  }
  return new HuffmanTable(lines, false);
}

const standardTablesCache = {};

function getStandardTable(number) {
  let table = standardTablesCache[number];
  if (table) {
    return table;
  }
  let lines;
  switch (number) {
    case 1:
      lines = [[0, 1, 4, 0x0], [16, 2, 8, 0x2], [272, 3, 16, 0x6], [65808, 3, 32, 0x7]];
      break;
    case 2:
      lines = [[0, 1, 0, 0x0], [1, 2, 0, 0x2], [2, 3, 0, 0x6], [3, 4, 3, 0xe], [11, 5, 6, 0x1e], [75, 6, 32, 0x3e], [6, 0x3f]];
      break;
    case 3:
      lines = [[-256, 8, 8, 0xfe], [0, 1, 0, 0x0], [1, 2, 0, 0x2], [2, 3, 0, 0x6], [3, 4, 3, 0xe], [11, 5, 6, 0x1e], [-257, 8, 32, 0xff, 'lower'], [75, 7, 32, 0x7e], [6, 0x3e]];
      break;
    case 4:
      lines = [[1, 1, 0, 0x0], [2, 2, 0, 0x2], [3, 3, 0, 0x6], [4, 4, 3, 0xe], [12, 5, 6, 0x1e], [76, 5, 32, 0x1f]];
      break;
    case 5:
      lines = [[-255, 7, 8, 0x7e], [1, 1, 0, 0x0], [2, 2, 0, 0x2], [3, 3, 0, 0x6], [4, 4, 3, 0xe], [12, 5, 6, 0x1e], [-256, 7, 32, 0x7f, 'lower'], [76, 6, 32, 0x3e]];
      break;
    case 6:
      lines = [[-2048, 5, 10, 0x1c], [-1024, 4, 9, 0x8], [-512, 4, 8, 0x9], [-256, 4, 7, 0xa], [-128, 5, 6, 0x1d], [-64, 5, 5, 0x1e], [-32, 4, 5, 0xb], [0, 2, 7, 0x0], [128, 3, 7, 0x2], [256, 3, 8, 0x3], [512, 4, 9, 0xc], [1024, 4, 10, 0xd], [-2049, 6, 32, 0x3e, 'lower'], [2048, 6, 32, 0x3f]];
      break;
    case 7:
      lines = [[-1024, 4, 9, 0x8], [-512, 3, 8, 0x0], [-256, 4, 7, 0x9], [-128, 5, 6, 0x1a], [-64, 5, 5, 0x1b], [-32, 4, 5, 0xa], [0, 4, 5, 0xb], [32, 5, 5, 0x1c], [64, 5, 6, 0x1d], [128, 4, 7, 0xc], [256, 3, 8, 0x1], [512, 3, 9, 0x2], [1024, 3, 10, 0x3], [-1025, 5, 32, 0x1e, 'lower'], [2048, 5, 32, 0x1f]];
      break;
    case 8:
      lines = [[-15, 8, 3, 0xfc], [-7, 9, 1, 0x1fc], [-5, 8, 1, 0xfd], [-3, 9, 0, 0x1fd], [-2, 7, 0, 0x7c], [-1, 4, 0, 0xa], [0, 2, 1, 0x0], [2, 5, 0, 0x1a], [3, 6, 0, 0x3a], [4, 3, 4, 0x4], [20, 6, 1, 0x3b], [22, 4, 4, 0xb], [38, 4, 5, 0xc], [70, 5, 6, 0x1b], [134, 5, 7, 0x1c], [262, 6, 7, 0x3c], [390, 7, 8, 0x7d], [646, 6, 10, 0x3d], [-16, 9, 32, 0x1fe, 'lower'], [1670, 9, 32, 0x1ff], [2, 0x1]];
      break;
    case 9:
      lines = [[-31, 8, 4, 0xfc], [-15, 9, 2, 0x1fc], [-11, 8, 2, 0xfd], [-7, 9, 1, 0x1fd], [-5, 7, 1, 0x7c], [-3, 4, 1, 0xa], [-1, 3, 1, 0x2], [1, 3, 1, 0x3], [3, 5, 1, 0x1a], [5, 6, 1, 0x3a], [7, 3, 5, 0x4], [39, 6, 2, 0x3b], [43, 4, 5, 0xb], [75, 4, 6, 0xc], [139, 5, 7, 0x1b], [267, 5, 8, 0x1c], [523, 6, 8, 0x3c], [779, 7, 9, 0x7d], [1291, 6, 11, 0x3d], [-32, 9, 32, 0x1fe, 'lower'], [3339, 9, 32, 0x1ff], [2, 0x0]];
      break;
    case 10:
      lines = [[-21, 7, 4, 0x7a], [-5, 8, 0, 0xfc], [-4, 7, 0, 0x7b], [-3, 5, 0, 0x18], [-2, 2, 2, 0x0], [2, 5, 0, 0x19], [3, 6, 0, 0x36], [4, 7, 0, 0x7c], [5, 8, 0, 0xfd], [6, 2, 6, 0x1], [70, 5, 5, 0x1a], [102, 6, 5, 0x37], [134, 6, 6, 0x38], [198, 6, 7, 0x39], [326, 6, 8, 0x3a], [582, 6, 9, 0x3b], [1094, 6, 10, 0x3c], [2118, 7, 11, 0x7d], [-22, 8, 32, 0xfe, 'lower'], [4166, 8, 32, 0xff], [2, 0x2]];
      break;
    case 11:
      lines = [[1, 1, 0, 0x0], [2, 2, 1, 0x2], [4, 4, 0, 0xc], [5, 4, 1, 0xd], [7, 5, 1, 0x1c], [9, 5, 2, 0x1d], [13, 6, 2, 0x3c], [17, 7, 2, 0x7a], [21, 7, 3, 0x7b], [29, 7, 4, 0x7c], [45, 7, 5, 0x7d], [77, 7, 6, 0x7e], [141, 7, 32, 0x7f]];
      break;
    case 12:
      lines = [[1, 1, 0, 0x0], [2, 2, 0, 0x2], [3, 3, 1, 0x6], [5, 5, 0, 0x1c], [6, 5, 1, 0x1d], [8, 6, 1, 0x3c], [10, 7, 0, 0x7a], [11, 7, 1, 0x7b], [13, 7, 2, 0x7c], [17, 7, 3, 0x7d], [25, 7, 4, 0x7e], [41, 8, 5, 0xfe], [73, 8, 32, 0xff]];
      break;
    case 13:
      lines = [[1, 1, 0, 0x0], [2, 3, 0, 0x4], [3, 4, 0, 0xc], [4, 5, 0, 0x1c], [5, 4, 1, 0xd], [7, 3, 3, 0x5], [15, 6, 1, 0x3a], [17, 6, 2, 0x3b], [21, 6, 3, 0x3c], [29, 6, 4, 0x3d], [45, 6, 5, 0x3e], [77, 7, 6, 0x7e], [141, 7, 32, 0x7f]];
      break;
    case 14:
      lines = [[-2, 3, 0, 0x4], [-1, 3, 0, 0x5], [0, 1, 0, 0x0], [1, 3, 0, 0x6], [2, 3, 0, 0x7]];
      break;
    case 15:
      lines = [[-24, 7, 4, 0x7c], [-8, 6, 2, 0x3c], [-4, 5, 1, 0x1c], [-2, 4, 0, 0xc], [-1, 3, 0, 0x4], [0, 1, 0, 0x0], [1, 3, 0, 0x5], [2, 4, 0, 0xd], [3, 5, 1, 0x1d], [5, 6, 2, 0x3d], [9, 7, 4, 0x7d], [-25, 7, 32, 0x7e, 'lower'], [25, 7, 32, 0x7f]];
      break;
    default:
      throw new Jbig2Error(`standard table B.${number} does not exist`);
  }
  for (let i = 0, ii = lines.length; i < ii; i++) {
    lines[i] = new HuffmanLine(lines[i]);
  }
  table = new HuffmanTable(lines, true);
  standardTablesCache[number] = table;
  return table;
}

class Reader {
  constructor(data, start, end) {
    this.data = data;
    this.start = start;
    this.end = end;
    this.position = start;
    this.shift = -1;
    this.currentByte = 0;
  }

  readBit() {
    if (this.shift < 0) {
      if (this.position >= this.end) {
        throw new Jbig2Error('end of data while reading bit');
      }
      this.currentByte = this.data[this.position++];
      this.shift = 7;
    }
    const bit = this.currentByte >> this.shift & 1;
    this.shift--;
    return bit;
  }

  readBits(numBits) {
    let result = 0;
    let i;
    for (i = numBits - 1; i >= 0; i--) {
      result |= this.readBit() << i;
    }
    return result;
  }

  byteAlign() {
    this.shift = -1;
  }

  next() {
    if (this.position >= this.end) {
      return -1;
    }
    return this.data[this.position++];
  }
}

function getCustomHuffmanTable(index, referredTo, customTables) {
  let currentIndex = 0;
  for (let i = 0, ii = referredTo.length; i < ii; i++) {
    const table = customTables[referredTo[i]];
    if (table) {
      if (index === currentIndex) {
        return table;
      }
      currentIndex++;
    }
  }
  throw new Jbig2Error("can't find custom Huffman table");
}

function getTextRegionHuffmanTables(textRegion, referredTo, customTables, numberOfSymbols, reader) {
  const codes = [];
  for (let i = 0; i <= 34; i++) {
    const codeLength = reader.readBits(4);
    codes.push(new HuffmanLine([i, codeLength, 0, 0]));
  }
  const runCodesTable = new HuffmanTable(codes, false);
  codes.length = 0;
  for (let i = 0; i < numberOfSymbols;) {
    const codeLength = runCodesTable.decode(reader);
    if (codeLength >= 32) {
      let repeatedLength; let numberOfRepeats; let
        j;
      switch (codeLength) {
        case 32:
          if (i === 0) {
            throw new Jbig2Error('no previous value in symbol ID table');
          }
          numberOfRepeats = reader.readBits(2) + 3;
          repeatedLength = codes[i - 1].prefixLength;
          break;
        case 33:
          numberOfRepeats = reader.readBits(3) + 3;
          repeatedLength = 0;
          break;
        case 34:
          numberOfRepeats = reader.readBits(7) + 11;
          repeatedLength = 0;
          break;
        default:
          throw new Jbig2Error('invalid code length in symbol ID table');
      }
      for (j = 0; j < numberOfRepeats; j++) {
        codes.push(new HuffmanLine([i, repeatedLength, 0, 0]));
        i++;
      }
    } else {
      codes.push(new HuffmanLine([i, codeLength, 0, 0]));
      i++;
    }
  }
  reader.byteAlign();
  const symbolIDTable = new HuffmanTable(codes, false);
  let customIndex = 0;
  let tableFirstS;
  let tableDeltaS;
  let tableDeltaT;
  switch (textRegion.huffmanFS) {
    case 0:
    case 1:
      tableFirstS = getStandardTable(textRegion.huffmanFS + 6);
      break;
    case 3:
      tableFirstS = getCustomHuffmanTable(customIndex, referredTo, customTables);
      customIndex++;
      break;
    default:
      throw new Jbig2Error('invalid Huffman FS selector');
  }
  switch (textRegion.huffmanDS) {
    case 0:
    case 1:
    case 2:
      tableDeltaS = getStandardTable(textRegion.huffmanDS + 8);
      break;
    case 3:
      tableDeltaS = getCustomHuffmanTable(customIndex, referredTo, customTables);
      customIndex++;
      break;
    default:
      throw new Jbig2Error('invalid Huffman DS selector');
  }
  switch (textRegion.huffmanDT) {
    case 0:
    case 1:
    case 2:
      tableDeltaT = getStandardTable(textRegion.huffmanDT + 11);
      break;
    case 3:
      tableDeltaT = getCustomHuffmanTable(customIndex, referredTo, customTables);
      customIndex++;
      break;
    default:
      throw new Jbig2Error('invalid Huffman DT selector');
  }
  if (textRegion.refinement) {
    throw new Jbig2Error('refinement with Huffman is not supported');
  }
  return {
    symbolIDTable,
    tableFirstS,
    tableDeltaS,
    tableDeltaT,
  };
}

function getSymbolDictionaryHuffmanTables(dictionary, referredTo, customTables) {
  let customIndex = 0;
  let tableDeltaHeight;
  let tableDeltaWidth;
  switch (dictionary.huffmanDHSelector) {
    case 0:
    case 1:
      tableDeltaHeight = getStandardTable(dictionary.huffmanDHSelector + 4);
      break;
    case 3:
      tableDeltaHeight = getCustomHuffmanTable(customIndex, referredTo, customTables);
      customIndex++;
      break;
    default:
      throw new Jbig2Error('invalid Huffman DH selector');
  }
  switch (dictionary.huffmanDWSelector) {
    case 0:
    case 1:
      tableDeltaWidth = getStandardTable(dictionary.huffmanDWSelector + 2);
      break;
    case 3:
      tableDeltaWidth = getCustomHuffmanTable(customIndex, referredTo, customTables);
      customIndex++;
      break;
    default:
      throw new Jbig2Error('invalid Huffman DW selector');
  }
  let tableBitmapSize; let
    tableAggregateInstances;
  if (dictionary.bitmapSizeSelector) {
    tableBitmapSize = getCustomHuffmanTable(customIndex, referredTo, customTables);
    customIndex++;
  } else {
    tableBitmapSize = getStandardTable(1);
  }
  if (dictionary.aggregationInstancesSelector) {
    tableAggregateInstances = getCustomHuffmanTable(customIndex, referredTo, customTables);
  } else {
    tableAggregateInstances = getStandardTable(1);
  }
  return {
    tableDeltaHeight,
    tableDeltaWidth,
    tableBitmapSize,
    tableAggregateInstances,
  };
}

function readUncompressedBitmap(reader, width, height) {
  const bitmap = [];
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(width);
    bitmap.push(row);
    for (let x = 0; x < width; x++) {
      row[x] = reader.readBit();
    }
    reader.byteAlign();
  }
  return bitmap;
}

function decodeMMRBitmap(input, width, height, endOfBlock) {
  const params = {
    K: -1,
    Columns: width,
    Rows: height,
    BlackIs1: true,
    EndOfBlock: endOfBlock,
  };
  const decoder = new CCITTFaxDecoder(input, params);
  const bitmap = [];
  let currentByte;
  let eof = false;
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(width);
    bitmap.push(row);
    let shift = -1;
    for (let x = 0; x < width; x++) {
      if (shift < 0) {
        currentByte = decoder.readNextChar();
        if (currentByte === -1) {
          currentByte = 0;
          eof = true;
        }
        shift = 7;
      }
      row[x] = currentByte >> shift & 1;
      shift--;
    }
  }
  if (endOfBlock && !eof) {
    const lookForEOFLimit = 5;
    for (let i = 0; i < lookForEOFLimit; i++) {
      if (decoder.readNextChar() === -1) {
        break;
      }
    }
  }
  return bitmap;
}

/**
 * Decode JBIG2 image data.
 * @param {Uint8Array} data - The JBIG2 data stream
 * @param {Uint8Array|null} globals - Optional JBIG2 global segments data
 */
export function decodeJBIG2(data, globals = null) {
  const chunks = [];
  if (globals) {
    chunks.push({
      data: globals,
      start: 0,
      end: globals.length,
    });
  }
  chunks.push({
    data,
    start: 0,
    end: data.length,
  });
  const result = parseJbig2Chunks(chunks);
  // JBIG2 uses 1=black, 0=white; PDF uses the opposite convention.
  // Invert the packed bit buffer to match PDF expectations.
  const length = result.length;
  const wordCount = length >> 2;
  const words = new Uint32Array(result.buffer, result.byteOffset, wordCount);
  for (let i = 0; i < wordCount; i++) {
    words[i] = ~words[i];
  }
  for (let i = wordCount << 2; i < length; i++) {
    result[i] ^= 0xFF;
  }
  return result;
}
