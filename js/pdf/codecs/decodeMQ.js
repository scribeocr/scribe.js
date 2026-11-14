/**
 * MQ arithmetic decoder, shared by the JBIG2 and JPEG 2000 (JPX) entropy
 * decoders (ISO/IEC 14492 Annex E / ISO/IEC 15444-1 Annex C — the same coder).
 *
 * Adapted from Mozilla pdf.js (Apache 2.0 license).
 */

// Table C-2
const QE = new Uint16Array([
  0x5601, 0x3401, 0x1801, 0x0ac1, 0x0521, 0x0221, 0x5601, 0x5401, 0x4801, 0x3801, 0x3001, 0x2401, 0x1c01, 0x1601, 0x5601, 0x5401,
  0x5101, 0x4801, 0x3801, 0x3401, 0x3001, 0x2801, 0x2401, 0x2201, 0x1c01, 0x1801, 0x1601, 0x1401, 0x1201, 0x1101, 0x0ac1, 0x09c1,
  0x08a1, 0x0521, 0x0441, 0x02a1, 0x0221, 0x0141, 0x0111, 0x0085, 0x0049, 0x0025, 0x0015, 0x0009, 0x0005, 0x0001, 0x5601,
]);
const NMPS = new Uint8Array([
  1, 2, 3, 4, 5, 38, 7, 8, 9, 10, 11, 12, 13, 29, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34,
  35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 45, 46,
]);
const NLPS = new Uint8Array([
  1, 6, 9, 12, 29, 33, 6, 14, 14, 14, 17, 18, 20, 21, 14, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
  31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 46,
]);
const SWITCH = new Uint8Array([
  1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0,
]);

// The same arrays, for the JBIG2 kernels that carry readBit inline.
export const QeTable = {
  qe: QE, nmps: NMPS, nlps: NLPS, switchFlag: SWITCH,
};

export class ArithmeticDecoder {
  constructor(data, start, end) {
    this.data = data;
    this.bp = start;
    this.dataEnd = end;

    this.chigh = data[start];
    this.clow = 0;

    this.byteIn();

    this.chigh = ((this.chigh << 7) & 0xffff) | ((this.clow >> 9) & 0x7f);
    this.clow = (this.clow << 7) & 0xffff;
    this.ct -= 7;
    this.a = 0x8000;
  }

  byteIn() {
    const data = this.data;
    let bp = this.bp;

    if (data[bp] === 0xff) {
      if (data[bp + 1] > 0x8f) {
        this.clow += 0xff00;
        this.ct = 8;
      } else {
        bp++;
        this.clow += data[bp] << 9;
        this.ct = 7;
        this.bp = bp;
      }
    } else {
      bp++;
      this.clow += bp < this.dataEnd ? data[bp] << 8 : 0xff00;
      this.ct = 8;
      this.bp = bp;
    }
    if (this.clow > 0xffff) {
      this.chigh += this.clow >> 16;
      this.clow &= 0xffff;
    }
  }

  readBit(contexts, pos) {
    let cx_index = contexts[pos] >> 1;
    let cx_mps = contexts[pos] & 1;
    const qeIcx = QE[cx_index];
    let d;
    let a = this.a - qeIcx;

    if (this.chigh < qeIcx) {
      // exchangeLps
      if (a < qeIcx) {
        a = qeIcx;
        d = cx_mps;
        cx_index = NMPS[cx_index];
      } else {
        a = qeIcx;
        d = 1 ^ cx_mps;
        if (SWITCH[cx_index] === 1) {
          cx_mps = d;
        }
        cx_index = NLPS[cx_index];
      }
    } else {
      this.chigh -= qeIcx;
      if ((a & 0x8000) !== 0) {
        this.a = a;
        return cx_mps;
      }
      // exchangeMps
      if (a < qeIcx) {
        d = 1 ^ cx_mps;
        if (SWITCH[cx_index] === 1) {
          cx_mps = d;
        }
        cx_index = NLPS[cx_index];
      } else {
        d = cx_mps;
        cx_index = NMPS[cx_index];
      }
    }
    // C.3.3 renormD;
    do {
      if (this.ct === 0) {
        this.byteIn();
      }

      a <<= 1;
      this.chigh = ((this.chigh << 1) & 0xffff) | ((this.clow >> 15) & 1);
      this.clow = (this.clow << 1) & 0xffff;
      this.ct--;
    } while ((a & 0x8000) === 0);
    this.a = a;

    contexts[pos] = (cx_index << 1) | cx_mps;
    return d;
  }
}
