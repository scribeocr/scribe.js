// A page is encoded as two uncompressed binary records so it can be decoded without character-level data.
// The page record holds page layout, words, and styles, and the detail record holds character boxes, native-text entries, and fill shapes.
// The encoders reuse module-level scratch buffers across calls and return a caller-owned copy.
import {
  OcrPage, OcrPar, OcrLine, OcrWord, OcrChar, ParDebugInfo, LineDebugInfo, WordDebugInfo,
} from '../objects/ocrObjects.js';

const RECORD_VERSION = 3;

const W_CONF = 1;
const W_STYLE = 2;
const W_TOP = 4;
const W_BOTTOM = 8;
const W_READINGS = 16;
const W_ID_X = 32;
const W_ID_C = 64;
const W_ID_B = 128;
const W_ID_TWO = 256;
const W_ID_A = 512;
const W_ID_OTHER = 1024;
const W_TRUTH = 2048;
const W_LINK = 4096;
const W_RAW = 8192;
const W_FOOTNOTE = 16384;
const W_STYLE_RUNS = 32768;
const W_BOX_ODD = 65536;
const W_STYLE_ODD = 131072;

const L_ASC = 1;
const L_BASELINE = 2;
const L_PAR = 4;
const L_XH = 8;
const L_LINE_NUM = 16;
const L_PAGE_NUM = 32;
const L_ORIENT = 64;
const L_RAW = 128;
const L_BOX_ODD = 256;
const L_LR = 512;
const L_TB = 1024;

const P_REASON = 1;
const P_TYPE = 2;
const P_MARKER = 4;
const P_PAR_NUM = 8;
const P_HEADING = 16;
const P_FOOTNOTE_REF = 32;
const P_RAW = 64;
const P_SOURCE_TYPE = 128;
const P_SOURCE_STYLE = 256;
const P_BOX_ODD = 512;
const P_BOX_UNION = 1024;

const E_ENTRY = 1;
const E_BASELINE_Y = 2;
const E_FONT_OBJ = 4;
const E_PEN_X = 8;
const E_RENDER = 16;
const E_STROKE_W = 32;
const E_STROKE_C = 64;
const E_UNEDITABLE = 128;
const E_SKEW = 256;
const E_STRETCH = 512;
const E_CODES = 1024;
const E_EXTRA = 2048;
const E_ODD = 4096;

const R_TEXT = 1;
const R_RANK = 2;
const R_PLACE = 4;
const R_SPAN = 8;
const R_MSG = 16;
const R_SOURCE = 32;
const R_CONF = 64;

const N_F32 = 19;
const N_F64 = 23;
const N_NULL = 27;
const N_UNDEF = 59;
const N_JSON = 91;
const SCALE = [10, 100, 1000, 10000];

const S_NULL = 3;
const S_UNDEF = 7;
const S_JSON = 11;
const S_ALNUM8 = 15;
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const C_BASE = 3;

const D_LEFT = 1;
const D_TOP = 2;
const D_BOTTOM = 4;
const D_RIGHT = 8;
const D_MOVE = 16;

// The record names a fill-shape kind or a path's paint value by its place in these lists, so their order is part of the format.
const FILL_KINDS = ['squares', 'marks', 'images', 'paths', 'glyphBoxes'];
const PAINT = ['f', 's', 'fs'];
const PX_PER_PT = 300 / 72;
const P10 = [1, 10, 100, 1000, 10000, 100000, 1000000];

/**
 * Replace undefined values with a `{ $u: 1 }` marker for JSON serialization.
 * @param {string} key
 * @param {unknown} v
 */
const undefTag = (key, v) => (v === undefined ? { $u: 1 } : v);

/**
 * Restore `{ $u: 1 }` markers to undefined throughout a parsed JSON value.
 * @param {unknown} v
 */
function unmark(v) {
  if (v === null || typeof v !== 'object') return v;
  if (v.$u === 1) return undefined;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) v[i] = unmark(v[i]);
    return v;
  }
  for (const k in v) v[k] = unmark(v[k]);
  return v;
}

// Encoder

const STAGE = 1 << 14;
const SLACK = 192;
const MIN_OUT = 1 << 16;
const CAP_OUT = 1 << 26;
const WINDOW = 1024;
let callN = 0;
let outPeak = 0;
const LONG_MIN = 48;
const utf8Encoder = new TextEncoder();
const HAS_WELL_FORMED = typeof ''.isWellFormed === 'function';
const NONE = {};
const STAND_IN = { bold: null, link: undefined };
/** @type {Array<string>} */
const NO_KEYS = [];
const ALNUM_CODE = new Int8Array(128).fill(-1);
for (let i = 0; i < 62; i++) ALNUM_CODE[ALNUM.charCodeAt(i)] = i;

let B = new Uint8Array(MIN_OUT);
let DV = new DataView(B.buffer);
let stage = B.subarray(MIN_OUT - STAGE);

/**
 * Grow B if needed so n bytes fit at offset p before the trailing STAGE bytes.
 * @param {number} p
 * @param {number} n
 */
function ensure(p, n) {
  if (p + n > B.length - STAGE) {
    let cap = B.length * 2;
    while (cap < p + n + STAGE) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(B.subarray(0, p));
    B = next;
    DV = new DataView(next.buffer);
    stage = next.subarray(cap - STAGE);
  }
}

/** @param {number} p - The record's length. */
function finish(p) {
  const out = B.slice(0, p);
  if (p > outPeak) outPeak = p;
  const windowEnd = ++callN % WINDOW === 0;
  if (B.length > CAP_OUT || (windowEnd && B.length > MIN_OUT && B.length > 4 * (outPeak + STAGE))) {
    B = new Uint8Array(MIN_OUT);
    DV = new DataView(B.buffer);
    stage = B.subarray(MIN_OUT - STAGE);
  }
  if (windowEnd) outPeak = 0;
  return out;
}

/**
 * @template T
 * @param {T} v
 * @returns {T | typeof NONE}
 */
const prim = (v) => (v !== null && typeof v === 'object' ? NONE : v);

/** @param {number} v */
function varLen(v) {
  let n = 1;
  while (v >= 128) {
    v = Math.floor(v / 128);
    n++;
  }
  return n;
}

/**
 * Write a varint to B at offset p and return the next offset.
 * @param {number} p
 * @param {number} v - A non-negative integer below 2^53.
 */
function putVar(p, v) {
  const b = B;
  if (v < 128) { b[p] = v; return p + 1; }
  if (v < 16384) {
    b[p] = (v & 127) | 128;
    b[p + 1] = v >>> 7;
    return p + 2;
  }
  while (v >= 0x80000000) {
    b[p++] = (v % 128) | 128;
    v = Math.floor(v / 128);
  }
  while (v >= 128) {
    b[p++] = (v & 127) | 128;
    v >>>= 7;
  }
  b[p++] = v;
  return p;
}

// Strings

/**
 * Encode s at p as little-endian UTF-16 code units and return the next offset.
 * @param {number} p
 * @param {string} s
 */
function putStr16(p, s) {
  const n = s.length;
  ensure(p, 10 + 2 * n + SLACK);
  p = putVar(p, 4 * n + 2);
  const b = B;
  for (let i = 0; i < n; i++) {
    const c = s.charCodeAt(i);
    b[p++] = c & 255;
    b[p++] = c >> 8;
  }
  return p;
}

/**
 * @param {number} p
 * @param {string} s
 */
function putStrLong(p, s) {
  const n = s.length;
  let lone = HAS_WELL_FORMED && !s.isWellFormed();
  for (let i = 0; i < n && !HAS_WELL_FORMED && !lone; i++) {
    const c = s.charCodeAt(i);
    if (c < 0xd800 || c >= 0xe000) continue;
    const d = c < 0xdc00 && i + 1 < n ? s.charCodeAt(i + 1) : 0;
    if (d < 0xdc00 || d >= 0xe000) lone = true;
    else i++;
  }
  if (lone) return putStr16(p, s);
  ensure(p, 10 + 3 * n + SLACK);
  if (3 * n <= STAGE) {
    const written = utf8Encoder.encodeInto(s, stage).written;
    const q = putVar(p, written === n ? 4 * written : 4 * written + 1);
    B.copyWithin(q, B.length - STAGE, B.length - STAGE + written);
    return q + written;
  }
  const hl = varLen(12 * n + 1);
  const written = utf8Encoder.encodeInto(s, B.subarray(p + hl, p + hl + 3 * n)).written;
  const h = written === n ? 4 * written : 4 * written + 1;
  const hl2 = varLen(h);
  if (hl2 !== hl) B.copyWithin(p + hl2, p + hl, p + hl + written);
  putVar(p, h);
  return p + hl2 + written;
}

/**
 * @param {number} p
 * @param {string} s
 */
function putStr(p, s) {
  const n = s.length;
  if (n >= LONG_MIN) return putStrLong(p, s);
  ensure(p, 2 + 3 * n + SLACK);
  const b = B;
  const hl = n < 32 ? 1 : 2;
  let q = p + hl;
  let i = 0;
  for (; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c >= 128) break;
    b[q++] = c;
  }
  if (i === n) {
    if (n < 32) {
      b[p] = n << 2;
    } else {
      b[p] = ((n << 2) & 127) | 128;
      b[p + 1] = n >> 5;
    }
    return q;
  }
  for (; i < n; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      b[q++] = c;
    } else if (c < 0x800) {
      b[q++] = 0xc0 | (c >> 6);
      b[q++] = 0x80 | (c & 63);
    } else if (c < 0xd800 || c >= 0xe000) {
      b[q++] = 0xe0 | (c >> 12);
      b[q++] = 0x80 | ((c >> 6) & 63);
      b[q++] = 0x80 | (c & 63);
    } else {
      const d = c < 0xdc00 && i + 1 < n ? s.charCodeAt(i + 1) : 0;
      if (d < 0xdc00 || d >= 0xe000) return putStr16(p, s);
      const cp = ((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000;
      b[q++] = 0xf0 | (cp >> 18);
      b[q++] = 0x80 | ((cp >> 12) & 63);
      b[q++] = 0x80 | ((cp >> 6) & 63);
      b[q++] = 0x80 | (cp & 63);
      i++;
    }
  }
  const len = q - p - hl;
  const h = 4 * len + 1;
  const hl2 = h < 128 ? 1 : 2;
  if (hl2 !== hl) b.copyWithin(p + hl2, p + hl, q);
  if (hl2 === 1) {
    b[p] = h;
  } else {
    b[p] = (h & 127) | 128;
    b[p + 1] = h >> 7;
  }
  return p + hl2 + len;
}

/**
 * Encode v at p as a string, null, undefined, or tagged JSON value and return the next offset.
 * @param {number} p
 * @param {unknown} v
 */
function putStrAny(p, v) {
  if (typeof v === 'string') return putStr(p, v);
  if (v === null) { B[p] = S_NULL; return p + 1; }
  if (v === undefined) { B[p] = S_UNDEF; return p + 1; }
  B[p] = S_JSON;
  return putStr(p + 1, JSON.stringify(v, undefTag));
}

/**
 * Encode a value at p as a plain JSON field.
 * Nested undefined values in v are not preserved.
 * @param {number} p
 * @param {unknown} v
 * @returns {number}
 */
function putJson(p, v) {
  const s = v == null ? undefined : JSON.stringify(v);
  if (s === undefined) { B[p] = v === null ? S_NULL : S_UNDEF; return p + 1; }
  return putStr(p, s);
}

// Numbers

/**
 * Encode a non-number value for a numeric field at p.
 * @param {number} p
 * @param {unknown} v
 * @param {number} form - 0 for a number field, or 1 inside a delta or step field.
 * @returns {number}
 */
function putNotNum(p, v, form) {
  const h = v === null ? N_NULL : (v === undefined ? N_UNDEF : N_JSON);
  p = putVar(p, form === 0 ? h : 2 * h + 1);
  return h === N_JSON ? putStr(p, JSON.stringify(v, undefTag)) : p;
}

const ARG = new Float64Array(2);
// Equal to 2^52 + 2^51, so x + ROUND - ROUND rounds |x| < 2^51 to the nearest integer, ties to even.
const ROUND = 6755399441055744;

/**
 * Encode the number in ARG[0] at p and return the next offset.
 * @param {number} p
 * @param {number} form - 0 to write head h directly, or 1 to wrap it as 2h + 1.
 * @returns {number}
 */
function putNumSlow(p, form) {
  const v = ARG[0];
  const lim = form === 0 ? 2 ** 51 : 2 ** 49;
  let h = -1;
  if (Number.isInteger(v)) {
    if (v >= 0 && v < 2 * lim) h = v * 2;
    else if (v < 0 && v > -lim) h = (-v - 1) * 4 + 1;
  } else if (v < 1e9 && v > -1e9) {
    const x = v * 10000;
    let m = x + ROUND - ROUND;
    if (m - x < 1e-3 && x - m < 1e-3 && m / 10000 === v) {
      let k = 3;
      while (k > 0 && m % 10 === 0) {
        m /= 10;
        k--;
      }
      h = (m >= 0 ? 2 * m : -2 * m - 1) * 32 + k * 4 + 3;
    }
  }
  if (h >= 0) return putVar(p, form === 0 ? h : 2 * h + 1);
  if (Math.fround(v) === v) {
    p = putVar(p, form === 0 ? N_F32 : 2 * N_F32 + 1);
    DV.setFloat32(p, v, true);
    return p + 4;
  }
  p = putVar(p, form === 0 ? N_F64 : 2 * N_F64 + 1);
  DV.setFloat64(p, v, true);
  return p + 8;
}

/**
 * Encode v as a number field at p in the shortest form that round-trips it.
 * @param {number} p
 * @param {unknown} v
 */
function putNum(p, v) {
  if (typeof v !== 'number') return putNotNum(p, v, 0);
  if ((v | 0) === v && v >= 0) {
    if (v < 64) { B[p] = v << 1; return p + 1; }
    if (v < 8192) {
      B[p] = ((v << 1) & 127) | 128;
      B[p + 1] = v >> 6;
      return p + 2;
    }
  }
  ARG[0] = v;
  return putNumSlow(p, 0);
}

/** @param {number} p */
function putDiffSlow(p) {
  const v = ARG[0];
  const prev = ARG[1];
  if (Number.isInteger(v) && Number.isInteger(prev) && v < 2 ** 50 && v > -(2 ** 50) && prev < 2 ** 50 && prev > -(2 ** 50)) {
    const d = v - prev;
    return putVar(p, 2 * (d >= 0 ? 2 * d : -2 * d - 1));
  }
  return putNumSlow(p, 1);
}

/**
 * Encode box coordinate v at p relative to prev.
 * @param {number} p
 * @param {number} v
 * @param {number} prev
 */
function putDiff(p, v, prev) {
  const vi = v | 0;
  const pi = prev | 0;
  if (vi === v && pi === prev) {
    const d = vi - pi;
    if (d < 4096 && d >= -4096) {
      const z = (d << 1) ^ (d >> 31);
      if (z < 64) { B[p] = z << 1; return p + 1; }
      B[p] = ((z << 1) & 127) | 128;
      B[p + 1] = z >> 6;
      return p + 2;
    }
  }
  ARG[0] = v;
  ARG[1] = prev;
  return putDiffSlow(p);
}

/** @param {number} p */
function putStepSlow(p) {
  const v = ARG[0];
  const prev = ARG[1];
  if (Number.isInteger(v) && Number.isInteger(prev) && v < 2 ** 49 && v > -(2 ** 49) && prev < 2 ** 49 && prev > -(2 ** 49)) {
    const d = v - prev;
    return putVar(p, 4 * (d >= 0 ? 2 * d : -2 * d - 1));
  }
  if (v < 1e9 && v > -1e9 && prev < 1e9 && prev > -1e9) {
    const mv = v * 1000 + ROUND - ROUND;
    const mp = prev * 1000 + ROUND - ROUND;
    if (mv / 1000 === v && mp / 1000 === prev) {
      const d = mv - mp;
      return putVar(p, 4 * (d >= 0 ? 2 * d : -2 * d - 1) + 2);
    }
  }
  return putNumSlow(p, 1);
}

/**
 * Encode the native-text number in ARG[0] as a delta from PREV_NATIVE[k] and update PREV_NATIVE[k].
 * @param {number} p
 * @param {number} k
 */
function putStep(p, k) {
  const v = ARG[0];
  const prev = PREV_NATIVE[k];
  PREV_NATIVE[k] = v;
  const vi = v | 0;
  const pi = prev | 0;
  if (vi === v && pi === prev) {
    const d = vi - pi;
    if (d < 2048 && d >= -2048) {
      const z = (d << 1) ^ (d >> 31);
      if (z < 32) { B[p] = z << 2; return p + 1; }
      B[p] = ((z << 2) & 127) | 128;
      B[p + 1] = z >> 5;
      return p + 2;
    }
  }
  ARG[1] = prev;
  return putStepSlow(p);
}

/**
 * Encode a non-plain bbox as null, undefined, or JSON.
 * @param {number} p
 * @param {unknown} bb
 */
function putBoxOdd(p, bb) {
  if (bb === null || bb === undefined) return putStrAny(p, bb);
  B[p] = S_JSON;
  return putStr(p + 1, JSON.stringify(bb, undefTag));
}

/**
 * Return whether bb.left is a non-integer number that fits neither float32 nor 4-decimal fixed-point.
 * @param {?bbox} bb
 */
function needsFloat64(bb) {
  if (bb === null || typeof bb !== 'object') return false;
  const v = bb.left;
  if (typeof v !== 'number' || Number.isInteger(v) || Math.fround(v) === v) return false;
  if (v >= 1e9 || v <= -1e9) return true;
  const x = v * 10000;
  const m = x + ROUND - ROUND;
  return !(m - x < 1e-3 && x - m < 1e-3 && m / 10000 === v);
}

/**
 * Return whether bb is a non-null object with numeric left, top, right, and bottom fields.
 * @param {?bbox} bb
 * @returns {bb is bbox}
 */
function plainBox(bb) {
  return bb !== null && typeof bb === 'object' && typeof bb.left === 'number' && typeof bb.top === 'number' && typeof bb.right === 'number' && typeof bb.bottom === 'number';
}

const PREV_PAR = new Float64Array(4);
const PREV_LINE = new Float64Array(4);
const PREV_WORD = new Float64Array(4);
const PREV_CHAR = new Float64Array(4);
const PREV_NATIVE = new Float64Array(5);

/**
 * Encode a bounding box at p and return the next offset.
 * @param {number} p
 * @param {bbox} bb
 * @param {number} odd - Non-zero when bb is not a plain box.
 * @param {Float64Array} prev - Previous left, top, right, and bottom coordinates, updated in place when odd is 0.
 * @returns {number}
 */
function putBox(p, bb, odd, prev) {
  if (odd !== 0) return putBoxOdd(p, bb);
  const l = bb.left;
  const t = bb.top;
  const r = bb.right;
  const b = bb.bottom;
  p = putDiff(p, l, prev[0]);
  p = putDiff(p, t, prev[1]);
  p = putDiff(p, r, prev[2]);
  p = putDiff(p, b, prev[3]);
  prev[0] = l;
  prev[1] = t;
  prev[2] = r;
  prev[3] = b;
  return p;
}

/**
 * Encode a line baseline or native-text array field at p and return the next offset.
 * @param {number} p
 * @param {unknown} x
 * @param {number} kind - -1 for a line baseline, or PREV_NATIVE slot 0 (penX), 1 (skew), 2 (stretch), or 3 (codes).
 * @returns {number}
 */
function putList(p, x, kind) {
  const lead = kind < 0 ? 3 : 2;
  if (Array.isArray(x)) {
    const n = x.length;
    p = putVar(p, n + lead);
    ensure(p, 9 * n + SLACK);
    if (kind < 0) {
      for (let j = 0; j < n; j++) p = putNum(p, x[j]);
      return p;
    }
    for (let j = 0; j < n; j++) {
      const v = x[j];
      if (typeof v === 'number') {
        ARG[0] = v;
        p = putStep(p, kind);
      } else {
        p = putNotNum(p, v, 1);
      }
    }
    return p;
  }
  if (x === null) { B[p] = 0; return p + 1; }
  if (x === undefined && lead === 3) { B[p] = 1; return p + 1; }
  B[p] = lead - 1;
  return putStr(p + 1, JSON.stringify(x, undefTag));
}

// Ids and positions

let idA = 0;
let idB = 0;
let idC = 0;

/**
 * Parse a `word_<a>_<b>` or `word_<a>_<b>_<c>` id into `idA`, `idB`, and `idC`.
 * @param {string} s
 * @returns {number} Counter count (2 or 3) when each counter is 0 or 1-15 digits without a leading zero, or 0 otherwise.
 */
function parseId(s) {
  const len = s.length;
  if (len < 8 || len > 52 || s.charCodeAt(4) !== 95 || s.charCodeAt(0) !== 119 || s.charCodeAt(1) !== 111 || s.charCodeAt(2) !== 114 || s.charCodeAt(3) !== 100) return 0;
  let part = 0;
  let digits = 0;
  let v = 0;
  let a = 0; let b = 0;
  for (let i = 5; i < len; i++) {
    const d = s.charCodeAt(i) - 48;
    if (d === 47) {
      if (digits === 0 || part === 2) return 0;
      if (part === 0) a = v;
      else b = v;
      part++;
      digits = 0;
      v = 0;
    } else {
      if (d < 0 || d > 9 || (digits === 1 && v === 0) || digits === 15) return 0;
      v = v * 10 + d;
      digits++;
    }
  }
  if (part === 0 || digits === 0) return 0;
  if (part === 1) {
    idA = a;
    idB = v;
    return 2;
  }
  idA = a;
  idB = b;
  idC = v;
  return 3;
}

let lineHint = 0;
let lineMiss = 0;
/** @type {?Map<unknown, number>} */
let lineMap = null;
let parHint = 0;
let parMiss = 0;
/** @type {?Map<unknown, number>} */
let parMap = null;

/**
 * Return the 0-based index of `x` in `list`, or -1 if absent.
 * @template T
 * @param {Array<T>} list
 * @param {T} x
 * @param {boolean} isLine - True when `list` is `page.lines`, false when `page.pars`.
 * @returns {number}
 */
function positionOf(list, x, isLine) {
  const n = list.length;
  const hint = isLine ? lineHint : parHint;
  let at = -1;
  if (hint < n && list[hint] === x) at = hint;
  else if (hint > 0 && hint <= n && list[hint - 1] === x) at = hint - 1;
  else {
    let map = isLine ? lineMap : parMap;
    if (map === null && (isLine ? ++lineMiss : ++parMiss) > 4) {
      map = new Map();
      for (let i = 0; i < n; i++) map.set(list[i], i);
      if (isLine) lineMap = map;
      else parMap = map;
    }
    if (map !== null) {
      const got = map.get(x);
      at = got === undefined ? -1 : got;
    } else {
      for (let i = n - 1; i >= 0; i--) {
        if (list[i] === x) {
          at = i;
          break;
        }
      }
    }
  }
  if (at >= 0) {
    if (isLine) lineHint = at + 1;
    else parHint = at + 1;
  }
  return at;
}

// The page record's fields

/**
 * Encode signed integer d as a zigzag varint at p and return the next offset.
 * @param {number} p
 * @param {number} d
 */
function putZig(p, d) {
  return putVar(p, d >= 0 ? 2 * d : -2 * d - 1);
}

/**
 * Encode a string field at p, packing 8-character ASCII alphanumeric IDs, and return the next offset.
 * @param {number} p
 * @param {unknown} v
 */
function putId(p, v) {
  if (typeof v === 'string' && v.length === 8) {
    let x = 0; let y = 0;
    for (let i = 0; i < 8; i++) {
      const c = v.charCodeAt(i);
      const k = c < 128 ? ALNUM_CODE[c] : -1;
      if (k < 0) return putStrAny(p, v);
      if (i < 4) x |= k << (6 * i);
      else y |= k << (6 * (i - 4));
    }
    const b = B;
    b[p] = S_ALNUM8;
    b[p + 1] = x & 255;
    b[p + 2] = (x >> 8) & 255;
    b[p + 3] = x >> 16;
    b[p + 4] = y & 255;
    b[p + 5] = (y >> 8) & 255;
    b[p + 6] = y >> 16;
    return p + 7;
  }
  return putStrAny(p, v);
}

/** @param {unknown} v */
const isPrim = (v) => v === null || typeof v !== 'object';

let TB = new Uint8Array(1 << 16);
let tp = 0;

/**
 * Encode word text at p, splitting string payload bytes into TB, and return the next offset.
 * @param {number} p
 * @param {unknown} v
 */
function putText(p, v) {
  if (typeof v !== 'string') return putStrAny(p, v);
  const n0 = v.length;
  if (n0 < 32) {
    if (tp + n0 > TB.length) {
      const t = new Uint8Array(2 * TB.length);
      t.set(TB.subarray(0, tp));
      TB = t;
    }
    const t = TB;
    let q = tp;
    let i = 0;
    for (; i < n0; i++) {
      const c = v.charCodeAt(i);
      if (c >= 128) break;
      t[q++] = c;
    }
    if (i === n0) {
      B[p] = n0 << 2;
      tp = q;
      return p + 1;
    }
  }
  const q = putStr(p, v);
  const b = B;
  let hl = 1;
  while (b[p + hl - 1] >= 128) hl++;
  const n = q - p - hl;
  if (tp + n > TB.length) {
    const t = new Uint8Array(Math.max(2 * TB.length, tp + n));
    t.set(TB.subarray(0, tp));
    TB = t;
  }
  const t = TB;
  for (let i = p + hl; i < q; i++) t[tp++] = b[i];
  return p + hl;
}

const FIRST_LEFT = new Float64Array(1);

let WM = new Int32Array(1024);
let WP = new Int8Array(1024);
let WOK = new Int8Array(1024);
let WA = new Float64Array(1024);
let WB = new Float64Array(1024);
let WC = new Float64Array(1024);
let LM = new Int32Array(256);
let PLP = new Int32Array(256);
const LINE_HOLDS_TB = 1 << 20;
const LINE_PLAIN = 1 << 21;
/** @type {Array<?string|undefined>} */
const PF = [];
/** @type {Array<?number|undefined>} */
const PS = [];
/** @type {Array<?string|undefined>} */
const PC = [];
/** @type {Array<?number|undefined>} */
const PO = [];
/** @type {Array<?string|undefined>} */
const PL = [];
let PG = new Int32Array(64);
let palN = 0;
/** @type {Array<string|undefined>} */
const RS = [];
let RCONF = new Float64Array(64);
let rN = 0;
const VB = new Int32Array(32);

/**
 * Encode a word's readings at `p` and return the next write offset.
 * @param {number} p
 * @param {OcrWord['readings']} rd
 * @param {string} text - The parent word's text.
 * @returns {number}
 */
function putReadings(p, rd, text) {
  if (rd === null) { B[p] = 0; return p + 1; }
  const p0 = p;
  if (Array.isArray(rd)) {
    const r = rd.length;
    if (RCONF.length < r) RCONF = new Float64Array(2 * r);
    ensure(p, SLACK);
    p = putVar(p, 2 + r);
    let j = 0;
    for (; j < r; j++) {
      const row = rd[j];
      if (row === null || typeof row !== 'object') break;
      const src = row.source;
      const tx = row.text;
      const cf = row.conf;
      const rank = row.rank;
      const span = row.span;
      const msg = row.msg;
      if (typeof src !== 'string' || typeof tx !== 'string' || typeof cf !== 'number') break;
      let keys = 3;
      let fl = 0;
      if (rank !== undefined) {
        if (typeof rank !== 'number') break;
        keys++;
        fl |= R_RANK;
        if (rank === j + 1) fl |= R_PLACE;
      }
      if (span !== undefined) {
        if (typeof span !== 'number') break;
        keys++;
        fl |= R_SPAN;
      }
      if (msg !== undefined) {
        if (typeof msg !== 'string') break;
        keys++;
        fl |= R_MSG;
      }
      let c = 0;
      for (const key in row) c++;
      if (c !== keys) break;
      if (tx === text) fl |= R_TEXT;
      if (j < rN && RS[j] === src) fl |= R_SOURCE;
      if (j < rN && RCONF[j] === cf) fl |= R_CONF;
      ensure(p, SLACK);
      B[p++] = fl;
      if (!(fl & R_SOURCE)) p = putStr(p, src);
      if (!(fl & R_TEXT)) p = putStr(p, tx);
      if (!(fl & R_CONF)) p = putNum(p, cf);
      if ((fl & R_RANK) && !(fl & R_PLACE)) p = putNum(p, rank);
      if (fl & R_SPAN) p = putNum(p, span);
      if (fl & R_MSG) p = putStr(p, msg);
    }
    if (j === r) {
      for (let q = 0; q < r; q++) {
        RS[q] = rd[q].source;
        RCONF[q] = rd[q].conf;
      }
      rN = r;
      return p;
    }
  }
  B[p0] = 1;
  rN = 0;
  return putStr(p0 + 1, JSON.stringify(rd));
}

// The page record

/**
 * Encode a page without character boxes into an uncompressed page record.
 * @param {OcrPage} page
 * @param {?Record<string, NativeTextWord>} [nativeText] - Native-text entries keyed by word ID, used to record per-word native and uneditable header bits.
 * @param {number} [pageFlags] - Non-negative integer stored in the record header.
 * @returns {Uint8Array} Caller-owned record bytes.
 */
export function encodePageRecord(page, nativeText = null, pageFlags = 0) {
  const pars = page.pars;
  const lines = page.lines;
  const parN = pars.length;
  const lineN = lines.length;
  let wordN = 0;
  for (let i = 0; i < lineN; i++) wordN += lines[i].words.length;
  if (WM.length < wordN) {
    const cap = Math.max(wordN, 2 * WM.length);
    WM = new Int32Array(cap);
    WP = new Int8Array(cap);
    WOK = new Int8Array(cap);
    WA = new Float64Array(cap);
    WB = new Float64Array(cap);
    WC = new Float64Array(cap);
  }
  if (LM.length < lineN) LM = new Int32Array(Math.max(lineN, 2 * LM.length));
  const nt = nativeText;
  ensure(0, SLACK + (wordN >> 2));
  let p = 0;
  B[p++] = RECORD_VERSION;
  p = putVar(p, pageFlags);
  p = putVar(p, wordN);
  B[p++] = nt ? 1 : 0;
  const bitsAt = p;
  if (nt) {
    B.fill(0, p, p + ((wordN + 3) >> 2));
    p += (wordN + 3) >> 2;
  }
  p = putVar(p, lineN);
  p = putVar(p, parN);
  ensure(p, SLACK);
  const n = page.n;
  p = putNum(p, n);
  p = putNum(p, page.angle);
  p = putStrAny(p, page.textSource);
  p = putJson(p, page.dims);
  p = putJson(p, page.graphicLines);
  p = putJson(p, page.tableBoxes);

  const ruleOk = typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 1e15;
  const n1 = n + 1;
  let hits3 = 0;
  let hits2 = 0;
  /** @type {unknown} */
  let font = null;
  /** @type {unknown} */
  let size = null;
  /** @type {unknown} */
  let color = '#000000';
  /** @type {unknown} */
  let opacity = 1;
  /** @type {unknown} */
  let lang = 'eng';
  let flags = 64;
  let truth = 0;
  let tupleOk = true;
  /** @type {unknown} */
  let link;
  /** @type {unknown} */
  let conf = 0;
  /** @type {unknown} */
  let foot = null;
  /** @type {unknown} */
  let wRaw = null;
  let k = 0;
  for (let li = 0; li < lineN; li++) {
    const line = lines[li];
    const ws = line.words;
    const wn = ws.length;
    const lb = line.bbox;
    const lPlain = plainBox(lb);
    let lmode = 0;
    let minL = Infinity; let minT = Infinity; let maxR = -Infinity; let maxB = -Infinity;
    let eq = 0;
    let all = wn > 0;
    for (let wi = 0; wi < wn; wi++) {
      const bb = ws[wi].bbox;
      const ok = plainBox(bb);
      WOK[k + wi] = ok ? 1 : 0;
      if (!ok) { all = false; continue; }
      const l = bb.left;
      const t = bb.top;
      const r = bb.right;
      const b = bb.bottom;
      if (l < minL) minL = l;
      if (t < minT) minT = t;
      if (r > maxR) maxR = r;
      if (b > maxB) maxB = b;
      if (lPlain && t === lb.top && b === lb.bottom) eq++;
    }
    if (lPlain && all) {
      if (minL === lb.left && maxR === lb.right) lmode |= L_LR;
      if (minT === lb.top && maxB === lb.bottom && eq < 2) lmode |= L_TB;
    }
    if (lPlain && !(lmode & L_TB)) lmode |= LINE_HOLDS_TB;
    LM[li] = lmode | (lPlain ? LINE_PLAIN : 0);
    const lt = lPlain ? lb.top : 0;
    const lbo = lPlain ? lb.bottom : 0;
    for (let wi = 0; wi < wn; wi++, k++) {
      const word = ws[wi];
      const wb = word.bbox;
      let m = 0;
      if (WOK[k] === 0) m = W_BOX_ODD;
      else if (lmode & LINE_HOLDS_TB) {
        if (wb.top !== lt) m |= W_TOP;
        if (wb.bottom !== lbo) m |= W_BOTTOM;
      }
      const id = word.id;
      const parts = typeof id === 'string' ? parseId(id) : 0;
      WP[k] = parts;
      if (parts === 3) {
        WA[k] = idA;
        WB[k] = idB;
        WC[k] = idC;
        if (ruleOk && idA === n1 && idB === li + 1 && idC === wi + 1) hits3++;
      } else if (parts === 2) {
        WA[k] = idA;
        WB[k] = idB;
        if (ruleOk && idA === n1 && idB === k) hits2++;
      }
      let st = word.style;
      if (st == null) {
        STAND_IN.link = link;
        st = STAND_IN;
        m |= W_STYLE;
      }
      const vFont = st.font;
      const vSize = st.size;
      const vColor = st.color;
      const vOpacity = st.opacity;
      const vLang = word.lang;
      let f = 0;
      let notBool = false;
      if (st.bold === true) f |= 1;
      else if (st.bold !== false) notBool = true;
      if (st.italic === true) f |= 2;
      else if (st.italic !== false) notBool = true;
      if (st.underline === true) f |= 4;
      else if (st.underline !== false) notBool = true;
      if (st.smallCaps === true) f |= 8;
      else if (st.smallCaps !== false) notBool = true;
      if (st.sup === true) f |= 16;
      else if (st.sup !== false) notBool = true;
      if (st.dropcap === true) f |= 32;
      else if (st.dropcap !== false) notBool = true;
      if (word.visualCoords === true) f |= 64;
      else if (word.visualCoords !== false) notBool = true;
      if (word.compTruth === true) f |= 128;
      else if (word.compTruth !== false) notBool = true;
      if (word.matchTruth === true) f |= 256;
      else if (word.matchTruth !== false) notBool = true;
      if (notBool || !isPrim(vFont) || !isPrim(vSize) || !isPrim(vColor) || !isPrim(vOpacity) || !isPrim(vLang)) {
        m |= W_STYLE_ODD;
        tupleOk = false;
        truth = -1;
      } else {
        const f7 = f & 127;
        if (!tupleOk || vFont !== font || vSize !== size || vColor !== color || vOpacity !== opacity || f7 !== flags || vLang !== lang) {
          m |= W_STYLE;
          font = vFont;
          size = vSize;
          color = vColor;
          opacity = vOpacity;
          flags = f7;
          lang = vLang;
          tupleOk = true;
        }
        if (f >> 7 !== truth) { m |= W_TRUTH; truth = f >> 7; }
      }
      const vLink = st.link;
      const vConf = word.conf;
      const vFoot = word.footnoteParId;
      const wd = word.debug;
      const vRaw = wd ? wd.raw : undefined;
      if (vLink !== link) { m |= W_LINK; link = prim(vLink); }
      if (vConf !== conf) { m |= W_CONF; conf = prim(vConf); }
      if (vFoot !== foot) { m |= W_FOOTNOTE; foot = prim(vFoot); }
      if (vRaw !== wRaw) { m |= W_RAW; wRaw = prim(vRaw); }
      if (word.readings !== undefined) m |= W_READINGS;
      if (word.styleRuns !== undefined) m |= W_STYLE_RUNS;
      WM[k] = m;
      if (nt) {
        const e = nt[id];
        if (e) B[bitsAt + (k >> 2)] |= (e.uneditable ? 3 : 1) << (2 * (k & 3));
      }
    }
  }

  const rule = hits3 === 0 && hits2 === 0 ? 0 : (hits3 >= hits2 ? 1 : 2);
  let pa = 0; let pb = 0; let pc = 0;
  k = 0;
  for (let li = 0; li < lineN; li++) {
    const wn = lines[li].words.length;
    for (let wi = 0; wi < wn; wi++, k++) {
      const parts = WP[k];
      if (rule === 1 && parts === 3 && WA[k] === n1 && WB[k] === li + 1 && WC[k] === wi + 1) {
        pa = n1;
        pb = li + 1;
        pc = wi + 1;
        continue;
      }
      if (rule === 2 && parts === 2 && WA[k] === n1 && WB[k] === k) {
        pa = n1;
        pb = k;
        continue;
      }
      let m = rule !== 0 ? W_ID_X : 0;
      if (parts === 3) {
        if (WC[k] !== (wi === 0 ? 1 : pc + 1)) m |= W_ID_C;
        if (WB[k] !== (wi === 0 ? pb + 1 : pb)) m |= W_ID_B;
        if (WA[k] !== pa) m |= W_ID_A;
        pa = WA[k];
        pb = WB[k];
        pc = WC[k];
      } else if (parts === 2) {
        m |= W_ID_TWO;
        if (WB[k] !== pb + 1) m |= W_ID_B;
        if (WA[k] !== pa) m |= W_ID_A;
        pa = WA[k];
        pb = WB[k];
      } else {
        m |= W_ID_OTHER;
      }
      WM[k] |= m;
    }
  }
  let vary = 0;
  for (let i = 1; i < wordN; i++) vary |= WM[i];
  let vn = 0;
  for (let bit = 1; bit < 0x400000; bit *= 2) {
    if (vary & bit) VB[vn++] = bit;
  }
  const compact = vn <= 8;
  ensure(p, SLACK);
  B[p++] = rule;
  B[p++] = 63;
  tp = 0;
  FIRST_LEFT[0] = 0;
  p = putVar(p, 2 * vary + 1);

  PREV_PAR.fill(0);
  PREV_LINE.fill(0);
  PREV_WORD.fill(0);
  lineHint = 0;
  lineMiss = 0;
  lineMap = null;
  parHint = 0;
  parMiss = 0;
  parMap = null;
  /** @type {unknown} */
  let reason = '';
  /** @type {unknown} */
  let type = 'body';
  /** @type {unknown} */
  let marker = null;
  /** @type {unknown} */
  let parNum = null;
  /** @type {unknown} */
  let footRef = null;
  /** @type {unknown} */
  let heading = null;
  /** @type {unknown} */
  let pRaw = null;
  /** @type {unknown} */
  let sType = null;
  /** @type {unknown} */
  let sStyle = null;
  for (let i = 0; i < parN; i++) {
    const par = pars[i];
    const bb = par.bbox;
    let mask = plainBox(bb) ? 0 : P_BOX_ODD;
    const pl = par.lines;
    const pn = pl.length;
    if (PLP.length < pn) PLP = new Int32Array(Math.max(pn, 2 * PLP.length));
    let minL = Infinity; let minT = Infinity; let maxR = -Infinity; let maxB = -Infinity;
    let all = mask === 0;
    let found = 0;
    for (let j = 0; j < pn; j++) {
      const at = positionOf(lines, pl[j], true);
      PLP[j] = at;
      if (at < 0 || !all) continue;
      const lb = lines[at].bbox;
      if (!plainBox(lb)) { all = false; continue; }
      found++;
      if (lb.left < minL) minL = lb.left;
      if (lb.top < minT) minT = lb.top;
      if (lb.right > maxR) maxR = lb.right;
      if (lb.bottom > maxB) maxB = lb.bottom;
    }
    if (all && found > 0 && minL === bb.left && minT === bb.top && maxR === bb.right && maxB === bb.bottom) mask |= P_BOX_UNION;
    const vReason = par.reason;
    const vType = par.type;
    const vMarker = par.marker;
    const vParNum = par.parNum;
    const vFootRef = par.footnoteRefId;
    const vHeading = par.headingLevel;
    const dbg = par.debug;
    const vRaw = dbg ? dbg.raw : undefined;
    const vSType = dbg ? dbg.sourceType : undefined;
    const vSStyle = dbg ? dbg.sourceStyle : undefined;
    if (vReason !== reason) mask |= P_REASON;
    if (vType !== type) mask |= P_TYPE;
    if (vMarker !== marker) mask |= P_MARKER;
    if (vParNum !== parNum) mask |= P_PAR_NUM;
    if (vHeading !== heading) mask |= P_HEADING;
    if (vFootRef !== footRef) mask |= P_FOOTNOTE_REF;
    if (vRaw !== pRaw) mask |= P_RAW;
    if (vSType !== sType) mask |= P_SOURCE_TYPE;
    if (vSStyle !== sStyle) mask |= P_SOURCE_STYLE;
    ensure(p, SLACK);
    p = putVar(p, mask);
    p = putId(p, par.id);
    if (mask & P_BOX_ODD) p = putBoxOdd(p, bb);
    else if (!(mask & P_BOX_UNION)) p = putBox(p, bb, 0, PREV_PAR);
    if (mask & P_REASON) { p = putStrAny(p, vReason); reason = prim(vReason); }
    if (mask & P_TYPE) { p = putStrAny(p, vType); type = prim(vType); }
    if (mask & P_MARKER) { p = putStrAny(p, vMarker); marker = prim(vMarker); }
    if (mask & P_PAR_NUM) { p = putNum(p, vParNum); parNum = prim(vParNum); }
    if (mask & P_HEADING) { p = putNum(p, vHeading); heading = prim(vHeading); }
    if (mask & P_FOOTNOTE_REF) { p = putStrAny(p, vFootRef); footRef = prim(vFootRef); }
    if (mask & P_RAW) { p = putStrAny(p, vRaw); pRaw = prim(vRaw); }
    if (mask & P_SOURCE_TYPE) { p = putStrAny(p, vSType); sType = prim(vSType); }
    if (mask & P_SOURCE_STYLE) { p = putStrAny(p, vSStyle); sStyle = prim(vSStyle); }
    ensure(p, 10 + 3 * pn);
    p = putVar(p, pn);
    for (let j = 0; j < pn; j++) p = putVar(p, PLP[j] + 1);
  }

  /** @type {unknown} */
  let asc = null;
  /** @type {unknown} */
  let xh = null;
  /** @type {unknown} */
  let orient = 0;
  /** @type {unknown} */
  let lineNum = null;
  /** @type {unknown} */
  let pageNum = null;
  /** @type {unknown} */
  let lRaw = null;
  let parCode = 0;
  /** @type {?Array<number>|typeof NONE} */
  let baseline = NONE;
  PF[0] = null;
  PS[0] = null;
  PC[0] = '#000000';
  PO[0] = 1;
  PG[0] = 64;
  PL[0] = 'eng';
  palN = 1;
  rN = 0;
  k = 0;
  for (let li = 0; li < lineN; li++) {
    const line = lines[li];
    const lb = line.bbox;
    const lmode = LM[li];
    let mask = lmode & LINE_PLAIN ? lmode & (L_LR | L_TB) : L_BOX_ODD;
    const vBaseline = line.baseline;
    const vAsc = line.ascHeight;
    const vXh = line.xHeight;
    const vOrient = line.orientation;
    const vLineNum = line.lineNum;
    const vPageNum = line.pageNum;
    const ld = line.debug;
    const vRaw = ld ? ld.raw : undefined;
    const lp = line.par;
    let vPar = 0;
    if (lp) {
      const at = positionOf(pars, lp, false);
      if (at >= 0) vPar = at + 2;
    } else if (lp === undefined) {
      vPar = 1;
    }
    let sameBaseline = vBaseline === baseline && (vBaseline === null || vBaseline === undefined);
    if (Array.isArray(vBaseline) && Array.isArray(baseline) && vBaseline.length === baseline.length) {
      sameBaseline = true;
      for (let j = 0; j < vBaseline.length; j++) {
        if (vBaseline[j] !== baseline[j]) {
          sameBaseline = false;
          break;
        }
      }
    }
    if (!sameBaseline) mask |= L_BASELINE;
    if (vAsc !== asc) mask |= L_ASC;
    if (vXh !== xh) mask |= L_XH;
    if (vOrient !== orient) mask |= L_ORIENT;
    if (vLineNum !== lineNum) mask |= L_LINE_NUM;
    if (vPageNum !== pageNum) mask |= L_PAGE_NUM;
    if (vRaw !== lRaw) mask |= L_RAW;
    if (vPar !== parCode) mask |= L_PAR;
    ensure(p, SLACK);
    p = putVar(p, mask);
    p = putId(p, line.id);
    if (mask & L_BOX_ODD) {
      p = putBoxOdd(p, lb);
    } else {
      const l = lb.left;
      const t = lb.top;
      const r = lb.right;
      const b = lb.bottom;
      if (!(mask & L_LR)) { p = putDiff(p, l, PREV_LINE[0]); p = putDiff(p, r, PREV_LINE[2]); }
      if (!(mask & L_TB)) { p = putDiff(p, t, PREV_LINE[1]); p = putDiff(p, b, PREV_LINE[3]); }
      PREV_LINE[0] = l;
      PREV_LINE[1] = t;
      PREV_LINE[2] = r;
      PREV_LINE[3] = b;
    }
    if (mask & L_BASELINE) {
      p = putList(p, vBaseline, -1);
      baseline = Array.isArray(vBaseline) || vBaseline == null ? vBaseline : NONE;
    }
    if (mask & L_ASC) { p = putNum(p, vAsc); asc = prim(vAsc); }
    if (mask & L_XH) { p = putNum(p, vXh); xh = prim(vXh); }
    if (mask & L_ORIENT) { p = putNum(p, vOrient); orient = prim(vOrient); }
    if (mask & L_LINE_NUM) { p = putNum(p, vLineNum); lineNum = prim(vLineNum); }
    if (mask & L_PAGE_NUM) { p = putStrAny(p, vPageNum); pageNum = prim(vPageNum); }
    if (mask & L_RAW) { p = putStrAny(p, vRaw); lRaw = prim(vRaw); }
    if (mask & L_PAR) { p = putVar(p, vPar); parCode = vPar; }
    const ws = line.words;
    const wn = ws.length;
    ensure(p, SLACK);
    p = putVar(p, wn);
    const holds = (lmode & LINE_HOLDS_TB) !== 0;
    const lt = holds ? lb.top : 0;
    const lbo = holds ? lb.bottom : 0;

    for (let wi = 0; wi < wn; wi++, k++) {
      const word = ws[wi];
      const m = WM[k];
      ensure(p, SLACK);
      if (k === 0 || !compact) {
        p = putVar(p, m);
      } else if (vn > 0) {
        let c = 0;
        if (m !== 0) {
          for (let j = 0; j < vn; j++) {
            if (m & VB[j]) c |= 1 << j;
          }
        }
        B[p++] = c;
      }
      p = putText(p, word.text);
      if (m & W_ID_OTHER) {
        p = putStrAny(p, word.id);
      } else {
        if (m & W_ID_A) p = putVar(p, WA[k]);
        if (m & W_ID_B) p = putVar(p, WB[k]);
        if (m & W_ID_C) p = putVar(p, WC[k]);
      }
      const wb = word.bbox;
      if (m & W_BOX_ODD) {
        p = putBoxOdd(p, wb);
      } else {
        const l = wb.left;
        const t = wb.top;
        const r = wb.right;
        const b = wb.bottom;
        p = putDiff(p, l, wi === 0 ? FIRST_LEFT[0] : PREV_WORD[2]);
        p = putDiff(p, r, l);
        if (wi === 0) FIRST_LEFT[0] = l;
        if (holds) {
          if (m & W_TOP) p = putDiff(p, t, lt);
          if (m & W_BOTTOM) p = putDiff(p, b, lbo);
        } else {
          p = putDiff(p, t, PREV_WORD[1]);
          p = putDiff(p, b, PREV_WORD[3]);
        }
        PREV_WORD[0] = l;
        PREV_WORD[1] = t;
        PREV_WORD[2] = r;
        PREV_WORD[3] = b;
      }
      const st = word.style;
      if (m & W_STYLE_ODD) {
        // With W_STYLE, the style is null or undefined.
        if (m & W_STYLE) {
          p = putStr(putStrAny(putStrAny(p, st), word.lang), JSON.stringify([word.visualCoords, word.compTruth, word.matchTruth], undefTag));
        } else {
          p = putStrAny(p, st.font);
          p = putNum(p, st.size);
          p = putStrAny(p, st.color);
          p = putNum(p, st.opacity);
          p = putStrAny(p, word.lang);
          p = putStr(p, JSON.stringify([st.bold, st.italic, st.underline, st.smallCaps, st.sup, st.dropcap, word.visualCoords, word.compTruth, word.matchTruth], undefTag));
        }
      } else if (m & W_STYLE) {
        const vFont = st.font;
        const vSize = st.size;
        const vColor = st.color;
        const vOpacity = st.opacity;
        const vLang = word.lang;
        const f7 = (st.bold ? 1 : 0) | (st.italic ? 2 : 0) | (st.underline ? 4 : 0) | (st.smallCaps ? 8 : 0) | (st.sup ? 16 : 0) | (st.dropcap ? 32 : 0) | (word.visualCoords ? 64 : 0);
        let s = -1;
        for (let q = 0; q < palN; q++) {
          if (PG[q] === f7 && PF[q] === vFont && PS[q] === vSize && PC[q] === vColor && PO[q] === vOpacity && PL[q] === vLang) {
            s = q;
            break;
          }
        }
        if (s >= 0) {
          p = putVar(p, s + 1);
        } else {
          B[p++] = 0;
          p = putStrAny(p, vFont);
          p = putNum(p, vSize);
          p = putStrAny(p, vColor);
          p = putNum(p, vOpacity);
          ensure(p, SLACK);
          B[p++] = f7;
          p = putStrAny(p, vLang);
          if (PG.length === palN) {
            const g = new Int32Array(2 * palN);
            g.set(PG);
            PG = g;
          }
          PF[palN] = vFont;
          PS[palN] = vSize;
          PC[palN] = vColor;
          PO[palN] = vOpacity;
          PG[palN] = f7;
          PL[palN] = vLang;
          palN++;
        }
      }
      if (m & W_TRUTH) B[p++] = (word.compTruth ? 1 : 0) | (word.matchTruth ? 2 : 0);
      if (m & W_LINK) p = putStrAny(p, st.link);
      if (m & W_CONF) p = putNum(p, word.conf);
      if (m & W_FOOTNOTE) p = putStrAny(p, word.footnoteParId);
      if (m & W_RAW) p = putStrAny(p, word.debug ? word.debug.raw : undefined);
      if (m & W_READINGS) p = putReadings(p, word.readings, word.text);
      if (m & W_STYLE_RUNS) p = putJson(p, word.styleRuns);
    }
  }
  ensure(p, tp + SLACK);
  const b = B;
  const t = TB;
  for (let i = 0; i < tp; i++) b[p++] = t[i];
  b[p] = tp & 255;
  b[p + 1] = (tp >>> 8) & 255;
  b[p + 2] = (tp >>> 16) & 255;
  b[p + 3] = tp >>> 24;
  p += 4;
  if (TB.length > CAP_OUT) TB = new Uint8Array(1 << 16);
  lineMap = null;
  parMap = null;
  for (let i = 0; i < palN; i++) {
    PF[i] = undefined;
    PS[i] = undefined;
    PC[i] = undefined;
    PO[i] = undefined;
    PL[i] = undefined;
  }
  for (let i = 0; i < rN; i++) RS[i] = undefined;
  return finish(p);
}

// The detail record

let b4Top = 0;
let b4Height = 0;

/**
 * Encode a character bounding box at `p` against `PREV_CHAR`, or as a non-plain box when `odd` is non-zero.
 * @param {number} p
 * @param {bbox} bb
 * @param {number} odd
 */
function putCharBox(p, bb, odd) {
  if (odd !== 0) return putBox(p, bb, odd, PREV_CHAR);
  const P = PREV_CHAR;
  const l = bb.left;
  const t = bb.top;
  const r = bb.right;
  const b = bb.bottom;
  p = putDiff(p, l, P[2]);
  p = putDiff(p, r, l + (P[2] - P[0]));
  p = putDiff(p, t, P[1]);
  p = putDiff(p, b, P[3]);
  P[0] = l;
  P[1] = t;
  P[2] = r;
  P[3] = b;
  return p;
}

/**
 * Encode a word's characters at `p` when per-character texts or non-plain boxes are needed.
 * @param {number} p
 * @param {Array<OcrChar>} ch
 * @param {string} text
 */
function putCharsSlow(p, ch, text) {
  const cn = ch.length;
  let listed = typeof text !== 'string' || cn !== text.length;
  let boxOdd = false;
  for (let j = 0; j < cn; j++) {
    const ct = ch[j].text;
    if (!listed && (typeof ct !== 'string' || ct.length !== 1 || ct.charCodeAt(0) !== text.charCodeAt(j))) listed = true;
    if (!plainBox(ch[j].bbox)) boxOdd = true;
  }
  p = putVar(p, C_BASE + ((cn << 4) | (boxOdd ? 2 : 0) | (listed ? 1 : 0)));
  for (let j = 0; j < cn; j++) {
    ensure(p, SLACK);
    if (listed) p = putStrAny(p, ch[j].text);
    p = putCharBox(p, ch[j].bbox, boxOdd ? 1 : 0);
  }
  return p;
}

/**
 * Return the residual flags for deriving character boxes from `pens`, or -1 if they cannot be derived.
 * @param {Array<OcrChar>} ch
 * @param {Array<number>} pens
 * @param {string} text
 */
function derivable(ch, pens, text) {
  const n = ch.length;
  let fl = 0;
  let top0 = 0;
  let bot0 = 0;
  let prevR = 0;
  for (let j = 0; j < n; j++) {
    const c = ch[j];
    const ct = c.text;
    if (typeof ct !== 'string' || ct.length !== 1 || ct.charCodeAt(0) !== text.charCodeAt(j)) return -1;
    const bb = c.bbox;
    if (!plainBox(bb)) return -1;
    const l = bb.left;
    const t = bb.top;
    const r = bb.right;
    const b = bb.bottom;
    if ((l | 0) !== l || (t | 0) !== t || (r | 0) !== r || (b | 0) !== b) return -1;
    const pen = pens[j];
    if (typeof pen !== 'number' || !(pen > -1e9 && pen < 1e9)) return -1;
    if (l !== pen + ROUND - ROUND) fl |= D_LEFT;
    if (j === 0) {
      top0 = t;
      bot0 = b;
    } else {
      if (t !== top0) fl |= D_TOP;
      if (b !== bot0) fl |= D_BOTTOM;
      if (prevR !== l) fl |= D_RIGHT;
    }
    prevR = r;
  }
  return fl;
}

/**
 * Encode a word's character boxes at `p` as residuals from `pens`.
 * @param {number} p
 * @param {Array<OcrChar>} ch
 * @param {Array<number>} pens
 * @param {number} fl
 */
function putDerived(p, ch, pens, fl) {
  const n = ch.length;
  const first = ch[0].bbox;
  const top0 = first.top;
  const h = first.bottom - top0;
  if (top0 !== b4Top || h !== b4Height) fl |= D_MOVE;
  ensure(p, SLACK + 20 * n);
  B[p++] = fl;
  if (fl & D_MOVE) {
    p = putZig(p, top0 - b4Top);
    p = putZig(p, h - b4Height);
    b4Top = top0;
    b4Height = h;
  }
  const last = ch[n - 1].bbox;
  p = putZig(p, last.right - last.left);
  if (fl & D_LEFT) {
    for (let j = 0; j < n; j++) p = putZig(p, ch[j].bbox.left - (pens[j] + ROUND - ROUND));
  }
  if (fl & D_TOP) {
    for (let j = 1; j < n; j++) p = putZig(p, ch[j].bbox.top - top0);
  }
  if (fl & D_BOTTOM) {
    for (let j = 1; j < n; j++) p = putZig(p, ch[j].bbox.bottom - top0 - h);
  }
  if (fl & D_RIGHT) {
    for (let j = 0; j < n - 1; j++) p = putZig(p, ch[j].bbox.right - ch[j + 1].bbox.left);
  }
  return p;
}

// Fill shapes

const PREV_FILL = new Float64Array(8);
let fillQ = 1;
const PREV_GLYPH = new Float64Array(4);

/**
 * @param {unknown} o
 * @returns {o is Record<string, unknown>}
 */
const isRow = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

/**
 * Return whether `o` has numeric `left`, `top`, `right`, and `bottom` fields and no other defined properties besides `k1` and `k2`.
 * @param {Record<string, unknown>} o
 * @param {string} k1
 * @param {string} k2
 * @returns {boolean}
 */
function boxAnd(o, k1, k2) {
  for (const key in o) {
    if (key !== 'left' && key !== 'top' && key !== 'right' && key !== 'bottom' && key !== k1 && key !== k2 && o[key] !== undefined) return false;
  }
  return typeof o.left === 'number' && typeof o.top === 'number' && typeof o.right === 'number' && typeof o.bottom === 'number';
}

/**
 * Return the smallest decimal scale `e` in `[d, 6]` at which `v` (in 300-DPI pixels) is an exact multiple of `10^-e` points, or `d` if none fits.
 * @param {number} v
 * @param {number} d
 * @returns {number}
 */
function ptDigits(v, d) {
  if (!(v > -1e7 && v < 1e7)) return d;
  for (let e = d; e <= 6; e++) {
    const q = P10[e];
    const k = v * 0.24 * q + ROUND - ROUND;
    if ((k / q) * PX_PER_PT === v) return e;
  }
  return d;
}

/**
 * Write the fill-shape coordinate in `ARG[0]` at `p`, delta-encoded against `PREV_FILL[c]`, and return the next offset.
 * @param {number} p
 * @param {number} c
 * @returns {number}
 */
function putPt(p, c) {
  const v = ARG[0];
  const q = fillQ;
  const k = v * 0.24 * q + ROUND - ROUND;
  const ok = k < 2 ** 50 && k > -(2 ** 50);
  const prev = PREV_FILL[c];
  PREV_FILL[c] = ok ? k : 0;
  if (ok && (k / q) * PX_PER_PT === v) {
    const d = k - prev;
    return putVar(p, 2 * (d >= 0 ? 2 * d : -2 * d - 1));
  }
  return putNumSlow(p, 1);
}

/**
 * Encode the four coordinates of fill-shape box o against PREV_FILL slots c through c + 3.
 * @param {number} p
 * @param {bbox} o
 * @param {number} c
 */
function putPtBox(p, o, c) {
  ensure(p, SLACK);
  ARG[0] = o.left;
  p = putPt(p, c);
  ARG[0] = o.top;
  p = putPt(p, c + 1);
  ARG[0] = o.right;
  p = putPt(p, c + 2);
  ARG[0] = o.bottom;
  return putPt(p, c + 3);
}

/**
 * Return the point decimal scale (0 to 6) for encoding list, or -1 if any item does not match the row schema for kind.
 * @param {number} kind - 0 squares, 1 marks, 2 images, 3 paths, 4 glyphBoxes.
 * @param {Array<unknown>} list
 */
function fillScale(kind, list) {
  let d = 0;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (!isRow(o)) return -1;
    if (kind === 4) {
      if (typeof o.id !== 'string') return -1;
      for (const key in o) {
        if (key !== 'id' && key !== 'bbox' && o[key] !== undefined) return -1;
      }
      if (!isRow(o.bbox) || !boxAnd(o.bbox, 'left', 'left')) return -1;
      continue;
    }
    if (!boxAnd(o, kind === 0 ? 'stroke' : 'sites', kind === 0 ? 'stroke' : 'sites')) return -1;
    if (kind === 0 && typeof o.stroke !== 'boolean') return -1;
    if (kind === 1 && o.sites !== undefined) return -1;
    d = ptDigits(/** @type {number} */ (o.left), d);
    d = ptDigits(/** @type {number} */ (o.top), d);
    d = ptDigits(/** @type {number} */ (o.right), d);
    d = ptDigits(/** @type {number} */ (o.bottom), d);
    if (kind < 2) continue;
    const sites = o.sites;
    if (!Array.isArray(sites)) return -1;
    for (let j = 0; j < sites.length; j++) {
      const s = sites[j];
      if (!isRow(s)) return -1;
      if (kind === 3) {
        if (!boxAnd(s, 'paint', 'commands') || PAINT.indexOf(/** @type {string} */ (s.paint)) < 0 || !Number.isSafeInteger(s.commands) || /** @type {number} */ (s.commands) < 0) return -1;
      } else if (!boxAnd(s, 'objNum', 'objNum') || !(s.objNum === undefined || (Number.isSafeInteger(s.objNum) && /** @type {number} */ (s.objNum) >= 0))) return -1;
      d = ptDigits(/** @type {number} */ (s.left), d);
      d = ptDigits(/** @type {number} */ (s.top), d);
      d = ptDigits(/** @type {number} */ (s.right), d);
      d = ptDigits(/** @type {number} */ (s.bottom), d);
    }
  }
  return d;
}

/**
 * Encode a fill-shape list as binary rows at point decimal scale d.
 * @param {number} p
 * @param {number} kind
 * @param {Array<Object>} list
 * @param {number} d
 */
function putKind(p, kind, list, d) {
  const n = list.length;
  ensure(p, SLACK);
  p = putVar(p, n);
  B[p++] = d;
  fillQ = P10[d];
  PREV_FILL.fill(0);
  PREV_GLYPH.fill(0);
  for (let i = 0; i < n; i++) {
    const o = list[i];
    if (kind === 4) {
      ensure(p, SLACK);
      const id = o.id;
      if (parseId(id) === 3) {
        B[p++] = 1;
        p = putVar(p, idA);
        p = putVar(p, idB);
        p = putVar(p, idC);
      } else {
        B[p++] = 0;
        p = putStr(p, id);
      }
      p = putBox(p, o.bbox, 0, PREV_GLYPH);
      continue;
    }
    if (kind < 2) {
      p = putPtBox(p, o, 0);
      if (kind === 0) B[p++] = o.stroke ? 1 : 0;
      continue;
    }
    const sites = o.sites;
    const m = sites.length;
    let l = Infinity; let t = Infinity; let r = -Infinity; let b = -Infinity;
    for (let j = 0; j < m; j++) {
      const s = sites[j];
      if (s.left < l) l = s.left;
      if (s.top < t) t = s.top;
      if (s.right > r) r = s.right;
      if (s.bottom > b) b = s.bottom;
    }
    const union = m > 0 && l === o.left && t === o.top && r === o.right && b === o.bottom;
    ensure(p, SLACK);
    p = putVar(p, 2 * m + (union ? 1 : 0));
    if (!union) p = putPtBox(p, o, 0);
    for (let j = 0; j < m; j++) {
      const s = sites[j];
      p = putPtBox(p, s, 4);
      if (kind === 3) p = putVar(p, 3 * s.commands + PAINT.indexOf(s.paint));
      else p = putVar(p, s.objNum === undefined ? 0 : s.objNum + 1);
    }
  }
  return p;
}

/**
 * Encode a page's fill shapes into the detail record at p.
 * @param {number} p
 * @param {?PageFillShapes} fs
 */
function putFill(p, fs) {
  ensure(p, SLACK);
  if (!isRow(fs)) { B[p] = 0; return putJson(p + 1, fs); }
  B[p] = 1;
  const head = p + 1;
  p += 3;
  let codes = 0;
  for (let kind = 0; kind < 5; kind++) {
    const v = fs[FILL_KINDS[kind]];
    if (v === undefined) continue;
    const d = Array.isArray(v) ? fillScale(kind, v) : -1;
    if (d >= 0) {
      codes |= 1 << (2 * kind);
      p = putKind(p, kind, /** @type {Array<Object>} */ (v), d);
    } else {
      const s = JSON.stringify(v);
      if (s !== undefined) {
        codes |= 2 << (2 * kind);
        p = putStr(p, s);
      }
    }
  }
  for (let fi = 0; fi < 2; fi++) {
    const v = fi === 0 ? fs.marksOverflow : fs.pathsIneligible;
    let c = v === undefined ? 0 : (v === false ? 1 : (v === true ? 2 : 3));
    if (c === 3) {
      const s = JSON.stringify(v);
      if (s === undefined) c = 0;
      else p = putStr(p, s);
    }
    codes |= c << (10 + 2 * fi);
  }
  /** @type {Record<string, unknown>|undefined} */
  let extra;
  for (const key in fs) {
    if (key === 'squares' || key === 'marks' || key === 'images' || key === 'paths' || key === 'glyphBoxes' || key === 'marksOverflow' || key === 'pathsIneligible') continue;
    if (fs[key] === undefined) continue;
    if (extra === undefined) extra = {};
    extra[key] = fs[key];
  }
  ensure(p, SLACK);
  p = putJson(p, extra);
  B[head] = codes & 255;
  B[head + 1] = codes >> 8;
  return p;
}

/**
 * Encode a page's character boxes, native-text entries, and fill shapes into a detail record.
 * @param {OcrPage} page
 * @param {?Record<string, NativeTextWord>} [nativeText] - Native-text entries keyed by word id.
 * @param {?PageFillShapes} [fillShapes]
 * @returns {Uint8Array} The uncompressed detail record in a caller-owned buffer.
 */
export function encodeDetailRecord(page, nativeText = null, fillShapes = null) {
  const lines = page.lines;
  const lineN = lines.length;
  let wordN = 0;
  for (let i = 0; i < lineN; i++) wordN += lines[i].words.length;
  const nt = nativeText;
  ensure(0, SLACK);
  B[0] = RECORD_VERSION;
  B[1] = nt ? 3 : 2;
  let p = putVar(2, wordN);
  for (let k = 0; k < 4; k++) PREV_CHAR[k] = 0;
  PREV_NATIVE.fill(0);
  b4Top = 0;
  b4Height = 0;
  /** @type {unknown} */
  let by;
  /** @type {unknown} */
  let fo;
  /** @type {unknown} */
  let rm;
  /** @type {unknown} */
  let sw;
  /** @type {unknown} */
  let sc;
  /** @type {unknown} */
  let ue;
  const keys = nt ? Object.keys(nt) : NO_KEYS;
  let kc = 0;
  let inOrder = true;
  for (let li = 0; li < lineN; li++) {
    const ws = lines[li].words;
    for (let wi = 0; wi < ws.length; wi++) {
      const word = ws[wi];
      /** @type {?Array<number>} */
      let pens = null;
      if (nt) {
        const id = word.id;
        /** @type {NativeTextWord|undefined} */
        let e;
        if (kc < keys.length && keys[kc] === id) {
          e = nt[keys[kc++]];
        } else {
          e = nt[id];
          if (e !== undefined) inOrder = false;
        }
        ensure(p, SLACK);
        if (e === undefined) {
          B[p++] = 0;
        } else if (e === null || typeof e !== 'object') {
          p = putVar(p, E_ENTRY | E_ODD);
          p = putStr(p, JSON.stringify(e, undefTag));
        } else {
          const vBy = e.baselineY;
          const vFo = e.fontObjNum;
          const vRm = e.renderMode;
          const vSw = e.strokeWidthPx;
          const vSc = e.strokeColor;
          const vUe = e.uneditable;
          const penX = e.penX;
          const skew = e.skew;
          const stretch = e.stretch;
          const codes = e.codes;
          let m = E_ENTRY;
          if (vBy !== by) m |= E_BASELINE_Y;
          if (vFo !== fo) m |= E_FONT_OBJ;
          if (vRm !== rm) m |= E_RENDER;
          if (vSw !== sw) m |= E_STROKE_W;
          if (vSc !== sc) m |= E_STROKE_C;
          if (vUe !== ue) m |= E_UNEDITABLE;
          if (penX !== undefined) m |= E_PEN_X;
          if (skew !== undefined) m |= E_SKEW;
          if (stretch !== undefined) m |= E_STRETCH;
          if (codes !== undefined) m |= E_CODES;
          /** @type {?Record<string, unknown>} */
          let extra = null;
          for (const key in e) {
            if (key !== 'baselineY' && key !== 'fontObjNum' && key !== 'penX' && key !== 'renderMode' && key !== 'strokeWidthPx' && key !== 'strokeColor'
              && key !== 'uneditable' && key !== 'skew' && key !== 'stretch' && key !== 'codes') {
              if (extra === null) extra = {};
              extra[key] = e[key];
            }
          }
          if (extra !== null) m |= E_EXTRA;
          p = putVar(p, m);
          if (m & E_BASELINE_Y) {
            if (typeof vBy === 'number') {
              ARG[0] = vBy;
              p = putStep(p, 4);
            } else {
              p = putNotNum(p, vBy, 1);
            }
            by = prim(vBy);
          }
          if (m & E_FONT_OBJ) { p = putNum(p, vFo); fo = prim(vFo); }
          if (m & E_RENDER) { p = putNum(p, vRm); rm = prim(vRm); }
          if (m & E_STROKE_W) { p = putNum(p, vSw); sw = prim(vSw); }
          if (m & E_STROKE_C) { p = putStrAny(p, vSc); sc = prim(vSc); }
          if (m & E_UNEDITABLE) { p = putStrAny(p, vUe); ue = prim(vUe); }
          if (m & E_PEN_X) p = putList(p, penX, 0);
          if (m & E_SKEW) p = putList(p, skew, 1);
          if (m & E_STRETCH) p = putList(p, stretch, 2);
          if (m & E_CODES) p = putList(p, codes, 3);
          if (m & E_EXTRA) p = putStr(p, JSON.stringify(extra));
          if (Array.isArray(penX)) pens = penX;
        }
      }
      const ch = word.chars;
      ensure(p, SLACK);
      if (ch === null) { B[p++] = 0; continue; }
      if (ch === undefined) { B[p++] = 1; continue; }
      if (!Array.isArray(ch)) {
        B[p] = 2;
        p = putStr(p + 1, JSON.stringify(ch, undefTag));
        continue;
      }
      const cn = ch.length;
      const text = word.text;
      let slow = typeof text !== 'string' || cn !== text.length;
      if (!slow && pens !== null && cn > 0 && pens.length === cn) {
        const fl = derivable(ch, pens, text);
        if (fl >= 0) {
          p = putVar(p, C_BASE + ((cn << 4) | 8));
          p = putDerived(p, ch, pens, fl);
          continue;
        }
      }
      const p0 = p;
      const c0 = PREV_CHAR[0];
      const c1 = PREV_CHAR[1];
      const c2 = PREV_CHAR[2];
      const c3 = PREV_CHAR[3];
      if (!slow) {
        ensure(p, 10 + 36 * cn);
        const wide = cn > 0 && needsFloat64(ch[0].bbox);
        p = putVar(p, C_BASE + ((cn << 4) | (wide ? 4 : 0)));
        for (let j = 0; j < cn; j++) {
          const cc = ch[j];
          const ct = cc.text;
          const bb = cc.bbox;
          if (typeof ct !== 'string' || ct.length !== 1 || ct.charCodeAt(0) !== text.charCodeAt(j) || !plainBox(bb)) {
            slow = true;
            break;
          }
          if (wide) {
            const l = bb.left;
            const t = bb.top;
            const r = bb.right;
            const b = bb.bottom;
            DV.setFloat64(p, l, true);
            DV.setFloat64(p + 8, t, true);
            DV.setFloat64(p + 16, r, true);
            DV.setFloat64(p + 24, b, true);
            PREV_CHAR[0] = l;
            PREV_CHAR[1] = t;
            PREV_CHAR[2] = r;
            PREV_CHAR[3] = b;
            p += 32;
          } else {
            p = putCharBox(p, bb, 0);
          }
        }
      }
      if (slow) {
        PREV_CHAR[0] = c0;
        PREV_CHAR[1] = c1;
        PREV_CHAR[2] = c2;
        PREV_CHAR[3] = c3;
        p = putCharsSlow(p0, ch, text);
      }
    }
  }

  /** @type {Record<string, NativeTextWord>|undefined} */
  let strays;
  if (nt && (!inOrder || kc < keys.length)) {
    const wordIds = new Set();
    for (let i = 0; i < lineN; i++) {
      const ws = lines[i].words;
      for (let j = 0; j < ws.length; j++) wordIds.add(ws[j].id);
    }
    /** @type {Record<string, NativeTextWord>} */
    const found = {};
    let hasStrays = false;
    for (let i = 0; i < keys.length; i++) {
      if (!wordIds.has(keys[i])) {
        found[keys[i]] = nt[keys[i]];
        hasStrays = true;
      }
    }
    if (hasStrays) strays = found;
  }
  ensure(p, SLACK);
  p = putJson(p, strays);
  p = putFill(p, fillShapes);
  return finish(p);
}

// Decoder

const F64_DIFF = 2 * N_F64 + 1;
const ALNUM_CHAR = new Uint16Array(64);
for (let i = 0; i < 62; i++) ALNUM_CHAR[i] = ALNUM.charCodeAt(i);

const utf8Decoder = new TextDecoder();
const fcc = String.fromCharCode;
const NO_BYTES = new Uint8Array(0);
const NO_VIEW = new DataView(NO_BYTES.buffer);
/** @type {Array<OcrWord>} */
const NO_WORDS = [];

function FastPage(n, dims, angle, pars, lines, graphicLines, tableBoxes, textSource) {
  this.n = n;
  this.dims = dims;
  this.angle = angle;
  this.pars = pars;
  this.lines = lines;
  this.graphicLines = graphicLines;
  this.tableBoxes = tableBoxes;
  this.textSource = textSource;
}
FastPage.prototype = OcrPage.prototype;
function FastPar(page, bbox, lines, id, reason, type, marker, parNum, footnoteRefId, headingLevel, debug) {
  this.page = page;
  this.bbox = bbox;
  this.lines = lines;
  this.id = id;
  this.reason = reason;
  this.type = type;
  this.marker = marker;
  this.parNum = parNum;
  this.footnoteRefId = footnoteRefId;
  this.headingLevel = headingLevel;
  this.debug = debug;
}
FastPar.prototype = OcrPar.prototype;
function FastLine(id, bbox, baseline, ascHeight, xHeight, words, page, par, orientation, lineNum, pageNum, debug) {
  this.id = id;
  this.bbox = bbox;
  this.baseline = baseline;
  this.ascHeight = ascHeight;
  this.xHeight = xHeight;
  this.words = words;
  this.page = page;
  this.par = par;
  this.orientation = orientation;
  this.lineNum = lineNum;
  this.pageNum = pageNum;
  this.debug = debug;
}
FastLine.prototype = OcrLine.prototype;
function FastWord(text, readings, style, styleRuns, lang, conf, bbox, compTruth, matchTruth, id, line, chars, visualCoords, debug, footnoteParId) {
  this.text = text;
  this.readings = readings;
  this.style = style;
  this.styleRuns = styleRuns;
  this.lang = lang;
  this.conf = conf;
  this.bbox = bbox;
  this.compTruth = compTruth;
  this.matchTruth = matchTruth;
  this.id = id;
  this.line = line;
  this.chars = chars;
  this.visualCoords = visualCoords;
  this.debug = debug;
  this.footnoteParId = footnoteParId;
}
FastWord.prototype = OcrWord.prototype;
function FastChar(text, bbox) {
  this.text = text;
  this.bbox = bbox;
}
FastChar.prototype = OcrChar.prototype;

let buf = NO_BYTES;
let bufView = NO_VIEW;
let at = 0;

function overrun() {
  return new Error(`Record overrun at byte ${at} of ${buf.length}`);
}

function vint() {
  const b0 = buf[at];
  if (b0 < 128) { at++; return b0; }
  const b1 = buf[at + 1];
  if (b1 < 128) { at += 2; return (b0 & 127) | (b1 << 7); }
  let v = (b0 & 127) | ((b1 & 127) << 7);
  at += 2;
  let mul = 16384;
  for (let k = 0; k < 6; k++) {
    const b = buf[at++];
    if (b === undefined) throw overrun();
    v += (b & 127) * mul;
    if (b < 128) return v;
    mul *= 128;
  }
  throw overrun();
}

/**
 * Decode a number field whose varint header `h` is odd.
 * @param {number} h
 */
function numOdd(h) {
  if (h % 4 === 1) return -(h - 1) / 4 - 1;
  const q = (h - 3) / 4;
  const kind = q % 8;
  const z = (q - kind) / 8;
  if (kind < 4) return (z % 2 === 0 ? z / 2 : -(z + 1) / 2) / SCALE[kind];
  const p = at;
  if (kind === 4) {
    at = p + 4;
    return bufView.getFloat32(p, true);
  }
  if (kind === 5) {
    at = p + 8;
    return bufView.getFloat64(p, true);
  }
  if (z === 0) return null;
  if (z === 1) return undefined;
  return unmark(JSON.parse(str()));
}

function num() {
  const b0 = buf[at];
  if (b0 < 128) {
    at++;
    return (b0 & 1) === 0 ? b0 >> 1 : numOdd(b0);
  }
  const b1 = buf[at + 1];
  if (b1 < 128) {
    at += 2;
    const h = (b0 & 127) | (b1 << 7);
    return (h & 1) === 0 ? h >> 1 : numOdd(h);
  }
  const h = vint();
  return h % 2 === 0 ? h / 2 : numOdd(h);
}

/**
 * Return a string of n code units from u starting at p.
 * @param {Uint8Array|Uint16Array} u
 * @param {number} p
 * @param {number} n - At most 16.
 */
function units(u, p, n) {
  switch (n) {
    case 0: return '';
    case 1: return fcc(u[p]);
    case 2: return fcc(u[p], u[p + 1]);
    case 3: return fcc(u[p], u[p + 1], u[p + 2]);
    case 4: return fcc(u[p], u[p + 1], u[p + 2], u[p + 3]);
    case 5: return fcc(u[p], u[p + 1], u[p + 2], u[p + 3], u[p + 4]);
    case 6: return fcc(u[p], u[p + 1], u[p + 2], u[p + 3], u[p + 4], u[p + 5]);
    case 7: return fcc(u[p], u[p + 1], u[p + 2], u[p + 3], u[p + 4], u[p + 5], u[p + 6]);
    case 8: return fcc(u[p], u[p + 1], u[p + 2], u[p + 3], u[p + 4], u[p + 5], u[p + 6], u[p + 7]);
    case 9: return fcc(u[p], u[p + 1], u[p + 2], u[p + 3], u[p + 4], u[p + 5], u[p + 6], u[p + 7], u[p + 8]);
    case 10: return fcc(u[p], u[p + 1], u[p + 2], u[p + 3], u[p + 4], u[p + 5], u[p + 6], u[p + 7], u[p + 8], u[p + 9]);
    case 11: return fcc(u[p], u[p + 1], u[p + 2], u[p + 3], u[p + 4], u[p + 5], u[p + 6], u[p + 7], u[p + 8], u[p + 9], u[p + 10]);
    case 12: return fcc(u[p], u[p + 1], u[p + 2], u[p + 3], u[p + 4], u[p + 5], u[p + 6], u[p + 7], u[p + 8], u[p + 9], u[p + 10], u[p + 11]);
    case 13: return fcc(u[p], u[p + 1], u[p + 2], u[p + 3], u[p + 4], u[p + 5], u[p + 6], u[p + 7], u[p + 8], u[p + 9], u[p + 10], u[p + 11], u[p + 12]);
    case 14: return fcc(u[p], u[p + 1], u[p + 2], u[p + 3], u[p + 4], u[p + 5], u[p + 6], u[p + 7], u[p + 8], u[p + 9], u[p + 10], u[p + 11], u[p + 12], u[p + 13]);
    case 15: return fcc(u[p], u[p + 1], u[p + 2], u[p + 3], u[p + 4], u[p + 5], u[p + 6], u[p + 7], u[p + 8], u[p + 9], u[p + 10], u[p + 11], u[p + 12], u[p + 13], u[p + 14]);
    default: return fcc(u[p], u[p + 1], u[p + 2], u[p + 3], u[p + 4], u[p + 5], u[p + 6], u[p + 7], u[p + 8], u[p + 9], u[p + 10], u[p + 11], u[p + 12], u[p + 13], u[p + 14], u[p + 15]);
  }
}

// TextDecoder strips a leading UTF-8 BOM by default.
// Keeping it with { ignoreBOM: true } takes a slow path on Node 20.
/**
 * @param {number} p0
 * @param {number} end
 */
function longUtf8(p0, end) {
  const s = utf8Decoder.decode(buf.subarray(p0, end));
  return buf[p0] === 0xef && buf[p0 + 1] === 0xbb && buf[p0 + 2] === 0xbf ? `\uFEFF${s}` : s;
}

function alnum8() {
  const b = buf;
  const p = at;
  at = p + 6;
  const x = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);
  const y = b[p + 3] | (b[p + 4] << 8) | (b[p + 5] << 16);
  const A = ALNUM_CHAR;
  return fcc(A[x & 63], A[(x >> 6) & 63], A[(x >> 12) & 63], A[x >> 18], A[y & 63], A[(y >> 6) & 63], A[(y >> 12) & 63], A[y >> 18]);
}

const U16 = new Uint16Array(48);

/** @param {number} n - Bytes of UTF-8. */
function utf8Str(n) {
  const b = buf;
  const p0 = at;
  const end = p0 + n;
  if (end > b.length) throw overrun();
  at = end;
  if (n > 48) return longUtf8(p0, end);
  let k = 0;
  for (let p = p0; p < end;) {
    const c = b[p++];
    if (c < 0x80) {
      U16[k++] = c;
    } else if (c < 0xe0) {
      U16[k++] = ((c & 31) << 6) | (b[p] & 63);
      p++;
    } else if (c < 0xf0) {
      U16[k++] = ((c & 15) << 12) | ((b[p] & 63) << 6) | (b[p + 1] & 63);
      p += 2;
    } else {
      const x = (((c & 7) << 18) | ((b[p] & 63) << 12) | ((b[p + 1] & 63) << 6) | (b[p + 2] & 63)) - 0x10000;
      U16[k++] = 0xd800 | (x >> 10);
      U16[k++] = 0xdc00 | (x & 1023);
      p += 3;
    }
  }
  return k <= 16 ? units(U16, 0, k) : longUtf8(p0, end);
}

/** @param {number} n - Bytes of ASCII. */
function ascii(n) {
  const p = at;
  at = p + n;
  if (n <= 16) return units(buf, p, n);
  if (p + n > buf.length) throw overrun();
  return utf8Decoder.decode(buf.subarray(p, p + n));
}

/** Decode a string field, returning a string, null, undefined, or a JSON-encoded non-string value. */
function str() {
  let h = buf[at];
  if (h < 128) at++;
  else h = vint();
  const n = h >>> 2;
  const kind = h & 3;
  if (kind === 0) return ascii(n);
  if (kind === 1) return utf8Str(n);
  if (kind === 2) {
    let s = '';
    for (let i = 0; i < n; i++, at += 2) s += fcc(buf[at] | (buf[at + 1] << 8));
    return s;
  }
  if (n === 0) return null;
  if (n === 1) return undefined;
  if (n === 3) return alnum8();
  return unmark(JSON.parse(str()));
}

/** Decode a plain-JSON field, returning null, undefined, or the parsed value. */
function json() {
  const s = str();
  return s == null ? s : JSON.parse(s);
}

/** @param {number} h - The head of a number field. */
const numFrom = (h) => (h % 2 === 0 ? h / 2 : numOdd(h));

/**
 * @param {Float64Array} P
 * @param {number} k
 */
function diffSlow(P, k) {
  const h = vint();
  if (h % 2 === 1) return (P[k] = numFrom((h - 1) / 2));
  const z = h / 2;
  return (P[k] += (z % 2 === 0 ? z / 2 : -(z + 1) / 2));
}

/**
 * Decode four delta-encoded box coordinates into P.
 * @param {Float64Array} P
 */
function nextBox(P) {
  const b = buf;
  for (let k = 0; k < 4; k++) {
    const pk = P[k];
    const pi = pk | 0;
    const b0 = b[at];
    let h = b0;
    let n = 1;
    if (b0 >= 128) {
      h = (b0 & 127) | (b[at + 1] << 7);
      n = b[at + 1] < 128 ? 2 : 0;
    }
    if ((h & 1) === 0 && pi === pk && n !== 0) {
      at += n;
      const z = h >> 1;
      P[k] = pi + ((z >>> 1) ^ -(z & 1));
    } else if (b0 === F64_DIFF) {
      const p = at + 1;
      at = p + 8;
      P[k] = bufView.getFloat64(p, true);
    } else diffSlow(P, k);
  }
}

/**
 * Decode four delta-encoded box coordinates into `P` and return a bbox object.
 * @param {Float64Array} P
 */
function box(P) {
  nextBox(P);
  return {
    left: P[0], top: P[1], right: P[2], bottom: P[3],
  };
}

/**
 * Decode a native-text value against `PREV_NATIVE[k]` and update that slot when numeric.
 * @param {number} k
 */
function step(k) {
  const h = vint();
  let v;
  if (h % 2 === 1) {
    v = numFrom((h - 1) / 2);
  } else {
    const prev = PREV_NATIVE[k];
    const q = h % 4 === 0 ? h / 4 : (h - 2) / 4;
    const d = q % 2 === 0 ? q / 2 : -(q + 1) / 2;
    v = h % 4 === 0 ? prev + d : (Math.round(prev * 1000) + d) / 1000;
  }
  if (typeof v === 'number') PREV_NATIVE[k] = v;
  return v;
}

function baselineList() {
  const h = vint();
  if (h >= 3) {
    if (h === 5) return [num(), num()];
    const out = new Array(h - 3);
    for (let j = 0; j < out.length; j++) out[j] = num();
    return out;
  }
  if (h === 0) return null;
  return h === 2 ? unmark(JSON.parse(/** @type {string} */ (str()))) : undefined;
}

/**
 * Decode a non-array value for a native-text array field.
 * @param {number} h
 */
function oddList(h) {
  return h === 0 ? null : unmark(JSON.parse(/** @type {string} */ (str())));
}

/**
 * Decode out.length delta-encoded native-text values into out and return it.
 * @param {Array<number>} out
 * @param {number} kind - 0 penX, 1 skew, 2 stretch, 3 codes.
 */
function steps(out, kind) {
  for (let j = 0; j < out.length; j++) {
    const b0 = buf[at];
    if (b0 < 128 && (b0 & 3) === 2) {
      at++;
      const q = (b0 - 2) / 4;
      const v = (Math.round(PREV_NATIVE[kind] * 1000) + (q % 2 === 0 ? q / 2 : -(q + 1) / 2)) / 1000;
      PREV_NATIVE[kind] = v;
      out[j] = v;
    } else out[j] = step(kind);
  }
  return out;
}

function skipStr() {
  const h = vint();
  const n = h >>> 2;
  const kind = h & 3;
  if (kind < 2) at += n;
  else if (kind === 2) at += 2 * n;
  else if (n === 2) skipStr();
  else if (n === 3) at += 6;
}

/**
 * Decode one delta-encoded box coordinate into P[k] and return it.
 * @param {Float64Array} P
 * @param {number} k
 */
function coord(P, k) {
  const pk = P[k];
  const pi = pk | 0;
  const b = buf;
  const b0 = b[at];
  let h = b0;
  let n = 1;
  if (b0 >= 128) {
    h = (b0 & 127) | (b[at + 1] << 7);
    n = b[at + 1] < 128 ? 2 : 0;
  }
  if ((h & 1) === 0 && pi === pk && n !== 0) {
    at += n;
    const z = h >> 1;
    return (P[k] = pi + ((z >>> 1) ^ -(z & 1)));
  }
  diffSlow(P, k);
  return P[k];
}

let tat = 0;

/** Decode a word's text from its row header at `at` and string bytes at `tat`. */
function textStr() {
  const b0 = buf[at];
  if ((b0 & 3) === 3) return str();
  let h = b0;
  if (h < 128) at++;
  else h = vint();
  const n = h >>> 2;
  const kind = h & 3;
  const save = at;
  at = tat;
  let s;
  if (kind === 0) s = ascii(n);
  else if (kind === 1) s = utf8Str(n);
  else {
    s = '';
    for (let i = 0; i < n; i++, at += 2) s += fcc(buf[at] | (buf[at + 1] << 8));
  }
  tat = at;
  at = save;
  return s;
}

const PRED = new Float64Array(1);

/** Decode a delta-encoded character bbox and update `PREV_CHAR`. */
function charBox() {
  const P = PREV_CHAR;
  const pw = P[2] - P[0];
  PRED[0] = P[2];
  const left = coord(PRED, 0);
  PRED[0] = left + pw;
  const right = coord(PRED, 0);
  const top = coord(P, 1);
  const bottom = coord(P, 3);
  P[0] = left;
  P[2] = right;
  return {
    left, top, right, bottom,
  };
}

function zig() {
  const z = vint();
  return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
}

const LINE_TB = new Float64Array(1);
const EXP = new Int32Array(256);
let UNION_PARS = new Int32Array(64);

/**
 * Decode a word's readings.
 * @param {string} text - The word's text.
 */
function readReadings(text) {
  const code = vint();
  if (code === 0) return null;
  if (code === 1) {
    rN = 0;
    return JSON.parse(/** @type {string} */ (str()));
  }
  const r = code - 2;
  /** @type {NonNullable<OcrWord['readings']>} */
  const out = [];
  if (RCONF.length < r) RCONF = new Float64Array(2 * r);
  for (let j = 0; j < r; j++) {
    const fl = buf[at++];
    const source = /** @type {string} */ (fl & R_SOURCE ? RS[j] : str());
    const tx = /** @type {string} */ (fl & R_TEXT ? text : str());
    const conf = /** @type {number} */ (fl & R_CONF ? RCONF[j] : num());
    /** @type {NonNullable<OcrWord['readings']>[number]} */
    let row;
    if ((fl & (R_RANK | R_SPAN | R_MSG)) === 0) {
      row = { source, text: tx, conf };
    } else {
      row = { source, text: tx, conf };
      if (fl & R_RANK) row.rank = fl & R_PLACE ? j + 1 : /** @type {number} */ (num());
      if (fl & R_SPAN) row.span = /** @type {number} */ (num());
      if (fl & R_MSG) row.msg = /** @type {string} */ (str());
    }
    out.push(row);
  }
  for (let j = 0; j < r; j++) {
    RS[j] = out[j].source;
    RCONF[j] = out[j].conf;
  }
  rN = r;
  return out;
}

/**
 * Decode an uncompressed page record into an `OcrPage`.
 * Each decoded word has `chars` set to `null`.
 * @param {Uint8Array} bytes
 * @returns {OcrPage}
 */
export function decodePageRecord(bytes) {
  buf = bytes;
  bufView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== RECORD_VERSION) throw new Error(`Page record of version ${bytes[0]}, where ${RECORD_VERSION} is read.`);
  at = 1;
  vint();
  const wordN = vint();
  if (buf[at++] === 1) at += (wordN + 3) >> 2;
  const lineN = vint();
  const parN = vint();
  const n = num();
  const angle = num();
  const textSource = str();
  const dims = json();
  const graphicLines = json();
  const tableBoxes = json();
  const rule = buf[at++];
  at++;
  const e = bytes.length;
  tat = e - 4 - (bytes[e - 4] + bytes[e - 3] * 256 + bytes[e - 2] * 65536 + bytes[e - 1] * 16777216);
  let firstLeft = 0;
  const vary = (vint() - 1) / 2;
  const bits = [];
  for (let bit = 1; bit < 0x400000; bit *= 2) {
    if (vary & bit) bits.push(bit);
  }
  const vn = bits.length;
  const compact = vn <= 8;
  if (compact) {
    for (let c = 0; c < 1 << vn; c++) {
      let m = 0;
      for (let j = 0; j < vn; j++) {
        if (c & (1 << j)) m |= bits[j];
      }
      EXP[c] = m;
    }
  }
  PREV_PAR.fill(0);
  PREV_LINE.fill(0);
  PREV_WORD.fill(0);
  /** @type {Array<OcrPar>} */
  const pars = [];
  /** @type {Array<OcrLine>} */
  const lines = [];
  const page = new FastPage(n, dims, angle, pars, lines, graphicLines, tableBoxes, textSource);

  let reason = '';
  let type = 'body';
  let marker = null;
  let parNum = null;
  let footRef = null;
  let heading = null;
  let pRaw = null;
  let sType = null;
  let sStyle = null;
  let unionN = 0;
  if (UNION_PARS.length < parN) UNION_PARS = new Int32Array(Math.max(parN, 2 * UNION_PARS.length));
  for (let i = 0; i < parN; i++) {
    const mask = vint();
    const id = str();
    let bbox = null;
    if (mask & P_BOX_ODD) bbox = str();
    else if (mask & P_BOX_UNION) UNION_PARS[unionN++] = i;
    else bbox = box(PREV_PAR);
    if (mask & P_REASON) reason = str();
    if (mask & P_TYPE) type = str();
    if (mask & P_MARKER) marker = str();
    if (mask & P_PAR_NUM) parNum = num();
    if (mask & P_HEADING) heading = num();
    if (mask & P_FOOTNOTE_REF) footRef = str();
    if (mask & P_RAW) pRaw = str();
    if (mask & P_SOURCE_TYPE) sType = str();
    if (mask & P_SOURCE_STYLE) sStyle = str();
    const debug = new ParDebugInfo();
    if (pRaw !== null) debug.raw = pRaw;
    if (sType !== null) debug.sourceType = sType;
    if (sStyle !== null) debug.sourceStyle = sStyle;
    const own = [];
    const pn = vint();
    for (let j = 0; j < pn; j++) {
      const x = vint();
      if (x !== 0) own.push(x - 1);
    }
    pars.push(new FastPar(page, bbox, own, id, reason, type, marker, parNum, footRef, heading, debug));
  }

  let asc = null;
  let xh = null;
  let orient = 0;
  let lineNum = null;
  let pageNum = null;
  let lRaw = null;
  let parCode = 0;
  let baseline = null;
  let font = null;
  let size = null;
  let color = '#000000';
  let opacity = 1;
  let lang = 'eng';
  let flags = 64;
  let truth = 0;
  let bold = false;
  let italic = false;
  let underline = false;
  let smallCaps = false;
  let sup = false;
  let dropcap = false;
  let visualCoords = true;
  let compTruth = false;
  let matchTruth = false;
  let link;
  let conf = 0;
  let foot = null;
  let wRaw = null;
  PF[0] = null;
  PS[0] = null;
  PC[0] = '#000000';
  PO[0] = 1;
  PG[0] = 64;
  PL[0] = 'eng';
  palN = 1;
  rN = 0;
  let a = 0; let b = 0; let c = 0;
  /** @type {?string} */
  let prefix3 = null;
  let prefix3A = 0;
  let prefix3B = 0;
  /** @type {?string} */
  let prefix2 = null;
  let prefix2A = 0;
  const n1 = n + 1;
  const rulePrefix2 = rule === 2 ? `word_${n1}_` : '';
  let odd = null;
  let k = 0;
  for (let i = 0; i < lineN; i++) {
    const mask = vint();
    const id = str();
    let bbox;
    const derived = mask & (L_LR | L_TB);
    if (mask & L_BOX_ODD) {
      bbox = str();
    } else {
      let l = 0; let t = 0; let r = 0; let bo = 0;
      if (!(mask & L_LR)) { l = coord(PREV_LINE, 0); r = coord(PREV_LINE, 2); }
      if (!(mask & L_TB)) { t = coord(PREV_LINE, 1); bo = coord(PREV_LINE, 3); }
      bbox = {
        left: l, top: t, right: r, bottom: bo,
      };
    }
    const holds = !(mask & (L_BOX_ODD | L_TB));
    let bl;
    if (mask & L_BASELINE) {
      baseline = baselineList();
      bl = baseline;
    } else if (Array.isArray(baseline)) {
      bl = baseline.length === 2 ? [baseline[0], baseline[1]] : baseline.slice();
    } else {
      bl = baseline;
    }
    if (mask & L_ASC) asc = num();
    if (mask & L_XH) xh = num();
    if (mask & L_ORIENT) orient = num();
    if (mask & L_LINE_NUM) lineNum = num();
    if (mask & L_PAGE_NUM) pageNum = str();
    if (mask & L_RAW) lRaw = str();
    if (mask & L_PAR) parCode = vint();
    const wn = vint();
    const debug = new LineDebugInfo();
    if (lRaw !== null) debug.raw = lRaw;
    /** @type {Array<OcrWord>} */
    const words = [];
    const line = new FastLine(id, bbox, bl, asc, xh, words, page, parCode >= 2 ? pars[parCode - 2] : (parCode === 0 ? null : undefined), orient, lineNum, pageNum, debug);
    const lt = holds ? bbox.top : 0;
    const lbo = holds ? bbox.bottom : 0;
    const linePrefix = rule === 1 ? `word_${n1}_${i + 1}_` : '';
    let minL = Infinity; let minT = Infinity; let maxR = -Infinity; let maxB = -Infinity;
    for (let j = 0; j < wn; j++, k++) {
      let m;
      if (k === 0 || !compact) m = vint();
      else m = vn > 0 ? EXP[buf[at++]] : 0;
      const text = textStr();
      let wid;
      if (rule !== 0 && (m & W_ID_X) === 0) {
        if (rule === 1) {
          wid = linePrefix + (j + 1);
          a = n1;
          b = i + 1;
          c = j + 1;
        } else {
          wid = rulePrefix2 + k;
          a = n1;
          b = k;
        }
      } else if (m & W_ID_OTHER) {
        wid = str();
      } else {
        const two = (m & W_ID_TWO) !== 0;
        if (m & W_ID_A) a = vint();
        if (m & W_ID_B) b = vint();
        else if (two || j === 0) b++;
        if (m & W_ID_C) c = vint();
        else if (!two) c = j === 0 ? 1 : c + 1;
        if (two) {
          if (prefix2 === null || prefix2A !== a) {
            prefix2 = `word_${a}_`;
            prefix2A = a;
          }
          wid = prefix2 + b;
        } else {
          if (prefix3 === null || prefix3A !== a || prefix3B !== b) {
            prefix3 = `word_${a}_${b}_`;
            prefix3A = a;
            prefix3B = b;
          }
          wid = prefix3 + c;
        }
      }
      let wbox;
      if (m & W_BOX_ODD) {
        wbox = str();
      } else {
        PRED[0] = j === 0 ? firstLeft : PREV_WORD[2];
        const l = coord(PRED, 0);
        const r = coord(PRED, 0);
        if (j === 0) firstLeft = l;
        PREV_WORD[0] = l;
        PREV_WORD[2] = r;
        let t; let bo;
        if (holds) {
          if (m & W_TOP) {
            LINE_TB[0] = lt;
            t = coord(LINE_TB, 0);
          } else {
            t = lt;
          }
          if (m & W_BOTTOM) {
            LINE_TB[0] = lbo;
            bo = coord(LINE_TB, 0);
          } else {
            bo = lbo;
          }
          PREV_WORD[1] = t;
          PREV_WORD[3] = bo;
        } else {
          t = coord(PREV_WORD, 1);
          bo = coord(PREV_WORD, 3);
        }
        wbox = {
          left: l, top: t, right: r, bottom: bo,
        };
        if (derived) {
          if (l < minL) minL = l;
          if (t < minT) minT = t;
          if (r > maxR) maxR = r;
          if (bo > maxB) maxB = bo;
        }
      }
      if (m & W_STYLE_ODD) {
        if (m & W_STYLE) {
          if (odd === null) odd = [];
          odd.push(words, j, str());
          lang = str();
          const v = unmark(JSON.parse(/** @type {string} */ (str())));
          visualCoords = v[0];
          compTruth = v[1];
          matchTruth = v[2];
        } else {
          font = str();
          size = num();
          color = str();
          opacity = num();
          lang = str();
          const v = unmark(JSON.parse(/** @type {string} */ (str())));
          bold = v[0];
          italic = v[1];
          underline = v[2];
          smallCaps = v[3];
          sup = v[4];
          dropcap = v[5];
          visualCoords = v[6];
          compTruth = v[7];
          matchTruth = v[8];
        }
      } else {
        if (m & W_STYLE) {
          const s = vint();
          if (s === 0) {
            font = str();
            size = num();
            color = str();
            opacity = num();
            flags = buf[at++];
            lang = str();
            if (PG.length === palN) {
              const g = new Int32Array(2 * palN);
              g.set(PG);
              PG = g;
            }
            PF[palN] = font;
            PS[palN] = size;
            PC[palN] = color;
            PO[palN] = opacity;
            PG[palN] = flags;
            PL[palN] = lang;
            palN++;
          } else {
            const q = s - 1;
            font = PF[q];
            size = PS[q];
            color = PC[q];
            opacity = PO[q];
            flags = PG[q];
            lang = PL[q];
          }
          bold = (flags & 1) !== 0;
          italic = (flags & 2) !== 0;
          underline = (flags & 4) !== 0;
          smallCaps = (flags & 8) !== 0;
          sup = (flags & 16) !== 0;
          dropcap = (flags & 32) !== 0;
          visualCoords = (flags & 64) !== 0;
        }
        if (m & W_TRUTH) {
          truth = buf[at++];
          compTruth = (truth & 1) !== 0;
          matchTruth = (truth & 2) !== 0;
        }
      }
      if (m & W_LINK) link = str();
      if (m & W_CONF) conf = num();
      if (m & W_FOOTNOTE) foot = str();
      if (m & W_RAW) wRaw = str();
      const rd = m & W_READINGS ? readReadings(text) : undefined;
      const styleRuns = m & W_STYLE_RUNS ? json() : undefined;
      const style = link === undefined ? {
        font, size, bold, italic, underline, smallCaps, sup, dropcap, color, opacity,
      } : {
        font, size, bold, italic, underline, smallCaps, sup, dropcap, color, opacity, link,
      };
      const wdebug = new WordDebugInfo();
      if (wRaw !== null) wdebug.raw = wRaw;
      words.push(new FastWord(text, rd, style, styleRuns, lang, conf, wbox, compTruth, matchTruth, wid, line, null, visualCoords, wdebug, foot));
    }
    if (derived) {
      if (mask & L_LR) { bbox.left = minL; bbox.right = maxR; }
      if (mask & L_TB) { bbox.top = minT; bbox.bottom = maxB; }
    }
    if (!(mask & L_BOX_ODD)) {
      PREV_LINE[0] = bbox.left;
      PREV_LINE[1] = bbox.top;
      PREV_LINE[2] = bbox.right;
      PREV_LINE[3] = bbox.bottom;
    }
    lines.push(line);
  }
  for (let i = 0; i < parN; i++) {
    const own = pars[i].lines;
    for (let j = 0; j < own.length; j++) own[j] = lines[own[j]];
  }
  for (let u = 0; u < unionN; u++) {
    const par = pars[UNION_PARS[u]];
    const own = par.lines;
    let l = Infinity; let t = Infinity; let r = -Infinity; let bo = -Infinity;
    for (let j = 0; j < own.length; j++) {
      const lb = own[j].bbox;
      if (lb.left < l) l = lb.left;
      if (lb.top < t) t = lb.top;
      if (lb.right > r) r = lb.right;
      if (lb.bottom > bo) bo = lb.bottom;
    }
    par.bbox = {
      left: l, top: t, right: r, bottom: bo,
    };
  }
  if (odd !== null) {
    for (let q = 0; q < odd.length; q += 3) odd[q][odd[q + 1]].style = odd[q + 2];
  }
  for (let i = 0; i < palN; i++) {
    PF[i] = undefined;
    PS[i] = undefined;
    PC[i] = undefined;
    PO[i] = undefined;
    PL[i] = undefined;
  }
  for (let i = 0; i < rN; i++) RS[i] = undefined;
  if (at > buf.length) throw overrun();
  buf = NO_BYTES;
  bufView = NO_VIEW;
  return page;
}

/**
 * Read header fields and per-word native-text flags from an uncompressed page record.
 * `wordBits` holds one byte per word (bit 0 for a `nativeText` entry, bit 1 when uneditable), or is `null` when the record was encoded without `nativeText`.
 * @param {Uint8Array} bytes
 * @returns {{wordBits: ?Uint8Array, pageFlags: number, words: number, textSource: OcrPage['textSource']}}
 */
export function readPageRecordExtras(bytes) {
  buf = bytes;
  bufView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== RECORD_VERSION) throw new Error(`Page record of version ${bytes[0]}, where ${RECORD_VERSION} is read.`);
  at = 1;
  const pageFlags = vint();
  const wordN = vint();
  /** @type {?Uint8Array} */
  let wordBits = null;
  if (buf[at++] === 1) {
    wordBits = new Uint8Array(wordN);
    for (let k = 0; k < wordN; k++) wordBits[k] = (buf[at + (k >> 2)] >> (2 * (k & 3))) & 3;
    at += (wordN + 3) >> 2;
  }
  vint();
  vint();
  num();
  num();
  const textSource = str();
  buf = NO_BYTES;
  bufView = NO_VIEW;
  return {
    wordBits, pageFlags, words: wordN, textSource,
  };
}

// Fill shapes

/**
 * Decode a fill-shape coordinate in 300-DPI pixels, updating predictor slot `PREV_FILL[c]`.
 * @param {number} c
 */
function pt(c) {
  const h = vint();
  if (h % 2 === 1) {
    const v = numFrom((h - 1) / 2);
    const k = v * 0.24 * fillQ + ROUND - ROUND;
    PREV_FILL[c] = k < 2 ** 50 && k > -(2 ** 50) ? k : 0;
    return v;
  }
  const z = h / 2;
  const k = PREV_FILL[c] + (z % 2 === 0 ? z / 2 : -(z + 1) / 2);
  PREV_FILL[c] = k;
  return (k / fillQ) * PX_PER_PT;
}

/** @param {number} kind */
function readKind(kind) {
  const n = vint();
  fillQ = P10[buf[at++]];
  PREV_FILL.fill(0);
  PREV_GLYPH.fill(0);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    if (kind === 4) {
      const id = buf[at++] === 1 ? `word_${vint()}_${vint()}_${vint()}` : str();
      out[i] = { id, bbox: box(PREV_GLYPH) };
      continue;
    }
    if (kind < 2) {
      const left = pt(0);
      const top = pt(1);
      const right = pt(2);
      const bottom = pt(3);
      if (kind === 0) {
        out[i] = {
          left, top, right, bottom, stroke: buf[at++] === 1,
        };
      } else {
        out[i] = {
          left, top, right, bottom,
        };
      }
      continue;
    }
    const h = vint();
    const m = (h - (h % 2)) / 2;
    const union = h % 2 === 1;
    let left = 0; let top = 0; let right = 0; let bottom = 0;
    if (!union) {
      left = pt(0);
      top = pt(1);
      right = pt(2);
      bottom = pt(3);
    }
    const sites = new Array(m);
    let l = Infinity; let t = Infinity; let r = -Infinity; let b = -Infinity;
    for (let j = 0; j < m; j++) {
      const sl = pt(4);
      const st = pt(5);
      const sr = pt(6);
      const sb = pt(7);
      if (sl < l) l = sl;
      if (st < t) t = st;
      if (sr > r) r = sr;
      if (sb > b) b = sb;
      const v = vint();
      if (kind === 3) {
        const paint = v % 3;
        sites[j] = {
          left: sl, top: st, right: sr, bottom: sb, paint: PAINT[paint], commands: (v - paint) / 3,
        };
      } else if (v === 0) {
        sites[j] = {
          left: sl, top: st, right: sr, bottom: sb,
        };
      } else {
        sites[j] = {
          left: sl, top: st, right: sr, bottom: sb, objNum: v - 1,
        };
      }
    }
    if (union) {
      left = l;
      top = t;
      right = r;
      bottom = b;
    }
    out[i] = {
      left, top, right, bottom, sites,
    };
  }
  return out;
}

function fill() {
  if (buf[at++] === 0) return json();
  const codes = buf[at] | (buf[at + 1] << 8);
  at += 2;
  /** @type {PageFillShapes} */
  const fs = {};
  for (let kind = 0; kind < 5; kind++) {
    const c = (codes >> (2 * kind)) & 3;
    if (c === 1) fs[FILL_KINDS[kind]] = readKind(kind);
    else if (c === 2) fs[FILL_KINDS[kind]] = JSON.parse(/** @type {string} */ (str()));
  }
  for (let fi = 0; fi < 2; fi++) {
    const c = (codes >> (10 + 2 * fi)) & 3;
    if (c === 0) continue;
    fs[fi === 0 ? 'marksOverflow' : 'pathsIneligible'] = c === 1 ? false : (c === 2 ? true : JSON.parse(/** @type {string} */ (str())));
  }
  const extra = json();
  if (extra != null) Object.assign(fs, extra);
  return fs;
}

let DL = new Int32Array(64);
let DT = new Int32Array(64);
let DB = new Int32Array(64);
let DR = new Int32Array(64);

/**
 * Decode `n` pen-derived character boxes into `DL`, `DT`, `DB`, and `DR`.
 * @param {number} n
 * @param {Array<number>} pens
 */
function derivedBoxes(n, pens) {
  if (DL.length < n) {
    const cap = 2 * n;
    DL = new Int32Array(cap);
    DT = new Int32Array(cap);
    DB = new Int32Array(cap);
    DR = new Int32Array(cap);
  }
  const fl = buf[at++];
  if (fl & D_MOVE) {
    b4Top += zig();
    b4Height += zig();
  }
  const last = zig();
  const top0 = b4Top;
  const bot0 = b4Top + b4Height;
  for (let j = 0; j < n; j++) DL[j] = pens[j] + ROUND - ROUND + (fl & D_LEFT ? zig() : 0);
  DT[0] = top0;
  for (let j = 1; j < n; j++) DT[j] = top0 + (fl & D_TOP ? zig() : 0);
  DB[0] = bot0;
  for (let j = 1; j < n; j++) DB[j] = bot0 + (fl & D_BOTTOM ? zig() : 0);
  for (let j = 0; j < n - 1; j++) DR[j] = DL[j + 1] + (fl & D_RIGHT ? zig() : 0);
  DR[n - 1] = DL[n - 1] + last;
}

/**
 * Decode a detail record's character boxes onto a page's words and return its native-text entries and fill shapes.
 * Words are matched positionally across `page.lines`, and per-word boxes and native-text entries are skipped when the page's word count differs from the record.
 * @param {Uint8Array} bytes - Uncompressed detail record.
 * @param {OcrPage} page
 * @param {boolean} [onlyMissing] - Keep existing `word.chars` on words that already have character boxes.
 * @returns {{nativeText: ?Record<string, NativeTextWord>, fillShapes: ?PageFillShapes}}
 */
export function decodeDetailRecord(bytes, page, onlyMissing = false) {
  buf = bytes;
  at = 2;
  for (let k = 0; k < 4; k++) PREV_CHAR[k] = 0;
  PREV_NATIVE.fill(0);
  b4Top = 0;
  b4Height = 0;
  if (bytes[0] !== RECORD_VERSION) throw new Error(`Detail record of version ${bytes[0]}, where ${RECORD_VERSION} is read.`);
  const hasNative = (bytes[1] & 1) === 1;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bufView = dv;
  const wordN = vint();
  const pageLines = page.lines;
  let pageWordN = 0;
  for (let i = 0; i < pageLines.length; i++) pageWordN += pageLines[i].words.length;
  const matches = wordN === pageWordN;
  /** @type {?Record<string, NativeTextWord>} */
  const nativeText = hasNative ? {} : null;
  let by;
  let fo;
  let rm;
  let sw;
  let sc;
  let ue;
  let li = -1;
  let lineWords = NO_WORDS;
  let wi = 0;
  for (let i = 0; i < wordN; i++) {
    /** @type {?OcrWord} */
    let word = null;
    if (matches) {
      while (wi >= lineWords.length) {
        lineWords = pageLines[++li].words;
        wi = 0;
      }
      word = lineWords[wi++];
    }
    /** @type {?Array<number>} */
    let pens = null;
    const m = hasNative ? vint() : 0;
    if (m !== 0) {
      let entry;
      if (m & E_ODD) entry = unmark(JSON.parse(/** @type {string} */ (str())));
      else {
        if (m & E_BASELINE_Y) by = step(4);
        if (m & E_FONT_OBJ) fo = num();
        if (m & E_RENDER) rm = num();
        if (m & E_STROKE_W) sw = num();
        if (m & E_STROKE_C) sc = str();
        if (m & E_UNEDITABLE) ue = str();
        let h = m & E_PEN_X ? vint() : -1;
        const penX = h < 0 ? undefined : (h < 2 ? oddList(h) : steps(new Array(h - 2), 0));
        h = m & E_SKEW ? vint() : -1;
        const skew = h < 0 ? undefined : (h < 2 ? oddList(h) : steps(new Array(h - 2), 1));
        h = m & E_STRETCH ? vint() : -1;
        const stretch = h < 0 ? undefined : (h < 2 ? oddList(h) : steps(new Array(h - 2), 2));
        h = m & E_CODES ? vint() : -1;
        const codes = h < 0 ? undefined : (h < 2 ? oddList(h) : steps(new Array(h - 2), 3));
        if (Array.isArray(penX)) pens = penX;
        const shape = (by !== undefined ? 1 : 0) | (fo !== undefined ? 2 : 0) | (rm !== undefined ? 4 : 0) | (sw !== undefined ? 8 : 0)
          | (sc !== undefined ? 16 : 0) | (ue !== undefined ? 32 : 0) | (penX !== undefined ? 64 : 0) | (skew !== undefined ? 128 : 0)
          | (stretch !== undefined ? 256 : 0) | (codes !== undefined ? 512 : 0);
        if (shape === 67) entry = { baselineY: by, fontObjNum: fo, penX };
        else if (shape === 323) {
          entry = {
            baselineY: by, fontObjNum: fo, penX, stretch,
          };
        } else if (shape === 99) {
          entry = {
            baselineY: by, fontObjNum: fo, uneditable: ue, penX,
          };
        } else if (shape === 451) {
          entry = {
            baselineY: by, fontObjNum: fo, penX, skew, stretch,
          };
        } else if (shape === 195) {
          entry = {
            baselineY: by, fontObjNum: fo, penX, skew,
          };
        } else if (shape === 95) {
          entry = {
            baselineY: by, fontObjNum: fo, renderMode: rm, strokeWidthPx: sw, strokeColor: sc, penX,
          };
        } else if (shape === 611) {
          entry = {
            baselineY: by, fontObjNum: fo, uneditable: ue, penX, codes,
          };
        } else if (shape === 223) {
          entry = {
            baselineY: by, fontObjNum: fo, renderMode: rm, strokeWidthPx: sw, strokeColor: sc, penX, skew,
          };
        } else if (shape === 351) {
          entry = {
            baselineY: by, fontObjNum: fo, renderMode: rm, strokeWidthPx: sw, strokeColor: sc, penX, stretch,
          };
        } else {
          entry = {};
          if (by !== undefined) entry.baselineY = by;
          if (fo !== undefined) entry.fontObjNum = fo;
          if (rm !== undefined) entry.renderMode = rm;
          if (sw !== undefined) entry.strokeWidthPx = sw;
          if (sc !== undefined) entry.strokeColor = sc;
          if (ue !== undefined) entry.uneditable = ue;
          if (penX !== undefined) entry.penX = penX;
          if (skew !== undefined) entry.skew = skew;
          if (stretch !== undefined) entry.stretch = stretch;
          if (codes !== undefined) entry.codes = codes;
        }
        if (m & E_EXTRA) Object.assign(entry, JSON.parse(/** @type {string} */ (str())));
      }
      if (word !== null && nativeText !== null) nativeText[word.id] = entry;
    }
    const h = vint();
    if (h < C_BASE) {
      const value = h === 0 ? null : (h === 1 ? undefined : unmark(JSON.parse(/** @type {string} */ (str()))));
      if (word !== null && !(onlyMissing && word.chars)) word.chars = value;
      continue;
    }
    const x = h - C_BASE;
    const count = x >>> 4;
    const listed = (x & 1) !== 0;
    const boxOdd = (x & 2) !== 0;
    const wide = (x & 4) !== 0;
    const derived = (x & 8) !== 0;
    if (derived) derivedBoxes(count, /** @type {Array<number>} */ (pens));
    // Advance past the word's boxes without setting word.chars when the page word count differs, word.text.length changed after encoding, or onlyMissing keeps existing boxes.
    if (word === null || (!listed && count !== word.text.length) || (onlyMissing && word.chars)) {
      if (derived) continue;
      if (wide) {
        at += 32 * count;
        if (count > 0) {
          for (let k = 0; k < 4; k++) PREV_CHAR[k] = dv.getFloat64(at - 32 + 8 * k, true);
        }
        continue;
      }
      for (let j = 0; j < count; j++) {
        if (listed) skipStr();
        if (boxOdd) skipStr();
        else charBox();
      }
      continue;
    }
    const t = word.text;
    /** @type {Array<OcrChar>} */
    const chars = new Array(count);
    if (derived) {
      for (let j = 0; j < count; j++) {
        chars[j] = new FastChar(t[j], {
          left: DL[j], top: DT[j], right: DR[j], bottom: DB[j],
        });
      }
    } else if (wide) {
      for (let j = 0; j < count; j++, at += 32) {
        const left = dv.getFloat64(at, true);
        const top = dv.getFloat64(at + 8, true);
        const right = dv.getFloat64(at + 16, true);
        const bottom = dv.getFloat64(at + 24, true);
        chars[j] = new FastChar(t[j], {
          left, top, right, bottom,
        });
      }
      if (count > 0) {
        for (let k = 0; k < 4; k++) PREV_CHAR[k] = dv.getFloat64(at - 32 + 8 * k, true);
      }
    } else if (!listed && !boxOdd) {
      for (let j = 0; j < count; j++) chars[j] = new FastChar(t[j], charBox());
    } else {
      for (let j = 0; j < count; j++) {
        const ct = listed ? str() : t[j];
        chars[j] = new FastChar(ct, boxOdd ? str() : charBox());
      }
    }
    word.chars = chars;
  }
  const strays = json();
  if (nativeText !== null && strays !== undefined) Object.assign(nativeText, strays);
  const fillShapes = fill();
  if (at > buf.length) throw overrun();
  buf = NO_BYTES;
  bufView = NO_VIEW;
  return { nativeText, fillShapes };
}
