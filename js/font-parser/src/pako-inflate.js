/* eslint-disable no-labels */
/* eslint-disable camelcase */
/**
 * @license (MIT AND Zlib)
 *
 * Inflate-only subset of pako 2.1.0 (https://github.com/nodeca/pako).
 * Provides zlib and raw-deflate decompression; no gzip, no compression.
 *
 * Based on the zlib reference implementation by Jean-loup Gailly and Mark Adler
 * (C) 1995-2013 Jean-loup Gailly and Mark Adler.
 * JavaScript port (C) 2014-2017 Vitaly Puzrin and Andrey Tupitsin.
 *
 * This software is provided 'as-is', without any express or implied warranty.
 * See the original pako license for full terms.
 */

// ───────────────────────── Checksums ─────────────────────────────────────────

const adler32 = (adler, buf, len, pos) => {
  let s1 = (adler & 0xffff) | 0;
  let s2 = ((adler >>> 16) & 0xffff) | 0;
  let n = 0;

  while (len !== 0) {
    // Chunk size bounded well under 5552 to keep s2 in 31 signed bits
    // so the following %= does not overflow.
    n = len > 2000 ? 2000 : len;
    len -= n;
    do {
      s1 = (s1 + buf[pos++]) | 0;
      s2 = (s2 + s1) | 0;
    } while (--n);
    s1 %= 65521;
    s2 %= 65521;
  }
  return (s1 | (s2 << 16)) | 0;
};

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

const crc32 = (crc, buf, len, pos) => {
  const end = pos + len;
  crc ^= -1;
  for (let i = pos; i < end; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  }
  return crc ^ -1;
};

// ───────────────────────── State codes ───────────────────────────────────────

const HEAD = 16180;
const FLAGS = 16181;
const TIME = 16182;
const OS = 16183;
const EXLEN = 16184;
const EXTRA = 16185;
const NAME = 16186;
const COMMENT = 16187;
const HCRC = 16188;
const DICTID = 16189;
const DICT = 16190;
const TYPE = 16191;
const TYPEDO = 16192;
const STORED = 16193;
const COPY_ = 16194;
const COPY = 16195;
const TABLE = 16196;
const LENLENS = 16197;
const CODELENS = 16198;
const LEN_ = 16199;
const LEN = 16200;
const LENEXT = 16201;
const DIST = 16202;
const DISTEXT = 16203;
const MATCH = 16204;
const LIT = 16205;
const CHECK = 16206;
const LENGTH = 16207;
const DONE = 16208;
const BAD = 16209;
const MEM = 16210;
const SYNC = 16211;

// ───────────────────────── Return codes / flush modes ───────────────────────

const Z_NO_FLUSH = 0;
const Z_FINISH = 4;
const Z_BLOCK = 5;
const Z_TREES = 6;

const Z_OK = 0;
const Z_STREAM_END = 1;
const Z_NEED_DICT = 2;
const Z_STREAM_ERROR = -2;
const Z_DATA_ERROR = -3;
const Z_MEM_ERROR = -4;
const Z_BUF_ERROR = -5;

const Z_DEFLATED = 8;

const MAXBITS = 15;
const ENOUGH_LENS = 852;
const ENOUGH_DISTS = 592;

const CODES = 0;
const LENS = 1;
const DISTS = 2;

// ───────────────────────── inflate_fast ──────────────────────────────────────

/*
 * Decode literal, length, and distance codes and write out the resulting
 * literal and match bytes until either not enough input or output is
 * available, an end-of-block is encountered, or a data error is encountered.
 * When large enough input and output buffers are supplied to inflate(), for
 * example, a 16K input buffer and a 64K output buffer, more than 95% of the
 * inflate execution time is spent in this routine.
 *
 * Entry assumptions:
 *   state.mode === LEN
 *   strm.avail_in >= 6
 *   strm.avail_out >= 258
 *   start >= strm.avail_out
 *   state.bits < 8
 *
 * On return, state.mode is one of:
 *   LEN  - ran out of enough output space or enough available input
 *   TYPE - reached end of block code, inflate() to interpret next block
 *   BAD  - error in block data
 *
 * The maximum input bits used by a length/distance pair is 48 bits (six
 * bytes); with strm.avail_in >= 6 we never need an input-availability check
 * inside the decode loop. Each pair outputs at most 258 bytes, so with
 * strm.avail_out >= 258 we skip the output-availability check too.
 *
 * DO NOT reorganise the local variables or the loop body: this is the hottest
 * function in the decoder and V8 is sensitive to shape changes here.
 */
const inflate_fast = (strm, start) => {
  let _in; let last; let _out; let beg; let end;
  let dmax;
  let wsize; let whave; let wnext;
  let s_window; // named s_window to avoid conflict with instrumentation tools
  let hold; let bits;
  let lcode; let dcode; let lmask; let dmask;
  let here; let op; let len; let dist; let from; let from_source;
  let input; let output;

  const state = strm.state;
  _in = strm.next_in;
  input = strm.input;
  last = _in + (strm.avail_in - 5);
  _out = strm.next_out;
  output = strm.output;
  beg = _out - (start - strm.avail_out);
  end = _out + (strm.avail_out - 257);
  dmax = state.dmax;
  wsize = state.wsize;
  whave = state.whave;
  wnext = state.wnext;
  s_window = state.window;
  hold = state.hold;
  bits = state.bits;
  lcode = state.lencode;
  dcode = state.distcode;
  lmask = (1 << state.lenbits) - 1;
  dmask = (1 << state.distbits) - 1;

  top:
  do {
    if (bits < 15) {
      hold += input[_in++] << bits;
      bits += 8;
      hold += input[_in++] << bits;
      bits += 8;
    }

    here = lcode[hold & lmask];

    for (;;) { // goto emulation
      op = here >>> 24;
      hold >>>= op;
      bits -= op;
      op = (here >>> 16) & 0xff;
      if (op === 0) { // literal
        output[_out++] = here & 0xffff;
      } else if (op & 16) { // length base
        len = here & 0xffff;
        op &= 15;
        if (op) {
          if (bits < op) {
            hold += input[_in++] << bits;
            bits += 8;
          }
          len += hold & ((1 << op) - 1);
          hold >>>= op;
          bits -= op;
        }
        if (bits < 15) {
          hold += input[_in++] << bits;
          bits += 8;
          hold += input[_in++] << bits;
          bits += 8;
        }
        here = dcode[hold & dmask];

        for (;;) { // goto emulation
          op = here >>> 24;
          hold >>>= op;
          bits -= op;
          op = (here >>> 16) & 0xff;

          if (op & 16) { // distance base
            dist = here & 0xffff;
            op &= 15;
            if (bits < op) {
              hold += input[_in++] << bits;
              bits += 8;
              if (bits < op) {
                hold += input[_in++] << bits;
                bits += 8;
              }
            }
            dist += hold & ((1 << op) - 1);
            if (dist > dmax) {
              strm.msg = 'invalid distance too far back';
              state.mode = BAD;
              break top;
            }
            hold >>>= op;
            bits -= op;
            op = _out - beg;
            if (dist > op) { // copy from window
              op = dist - op;
              if (op > whave && state.sane) {
                strm.msg = 'invalid distance too far back';
                state.mode = BAD;
                break top;
              }
              from = 0;
              from_source = s_window;
              if (wnext === 0) { // very common case
                from += wsize - op;
                if (op < len) {
                  len -= op;
                  do {
                    output[_out++] = s_window[from++];
                  } while (--op);
                  from = _out - dist;
                  from_source = output;
                }
              } else if (wnext < op) { // wrap around window
                from += wsize + wnext - op;
                op -= wnext;
                if (op < len) {
                  len -= op;
                  do {
                    output[_out++] = s_window[from++];
                  } while (--op);
                  from = 0;
                  if (wnext < len) {
                    op = wnext;
                    len -= op;
                    do {
                      output[_out++] = s_window[from++];
                    } while (--op);
                    from = _out - dist;
                    from_source = output;
                  }
                }
              } else { // contiguous in window
                from += wnext - op;
                if (op < len) {
                  len -= op;
                  do {
                    output[_out++] = s_window[from++];
                  } while (--op);
                  from = _out - dist;
                  from_source = output;
                }
              }
              while (len > 2) {
                output[_out++] = from_source[from++];
                output[_out++] = from_source[from++];
                output[_out++] = from_source[from++];
                len -= 3;
              }
              if (len) {
                output[_out++] = from_source[from++];
                if (len > 1) output[_out++] = from_source[from++];
              }
            } else {
              from = _out - dist; // copy direct from output
              do { // minimum length is three
                output[_out++] = output[from++];
                output[_out++] = output[from++];
                output[_out++] = output[from++];
                len -= 3;
              } while (len > 2);
              if (len) {
                output[_out++] = output[from++];
                if (len > 1) output[_out++] = output[from++];
              }
            }
          } else if ((op & 64) === 0) { // 2nd-level distance code
            here = dcode[(here & 0xffff) + (hold & ((1 << op) - 1))];
            continue;
          } else {
            strm.msg = 'invalid distance code';
            state.mode = BAD;
            break top;
          }
          break;
        }
      } else if ((op & 64) === 0) { // 2nd-level length code
        here = lcode[(here & 0xffff) + (hold & ((1 << op) - 1))];
        continue;
      } else if (op & 32) { // end-of-block
        state.mode = TYPE;
        break top;
      } else {
        strm.msg = 'invalid literal/length code';
        state.mode = BAD;
        break top;
      }
      break;
    }
  } while (_in < last && _out < end);

  // return unused bytes (on entry, bits < 8, so _in won't go too far back)
  len = bits >> 3;
  _in -= len;
  bits -= len << 3;
  hold &= (1 << bits) - 1;

  strm.next_in = _in;
  strm.next_out = _out;
  strm.avail_in = _in < last ? 5 + (last - _in) : 5 - (_in - last);
  strm.avail_out = _out < end ? 257 + (end - _out) : 257 - (_out - end);
  state.hold = hold;
  state.bits = bits;
};

// ───────────────────────── inflate_table ─────────────────────────────────────

const lbase = new Uint16Array([ // length codes 257..285 base
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258, 0, 0,
]);

const lext = new Uint8Array([ // length codes 257..285 extra
  16, 16, 16, 16, 16, 16, 16, 16, 17, 17, 17, 17, 18, 18, 18, 18,
  19, 19, 19, 19, 20, 20, 20, 20, 21, 21, 21, 21, 16, 72, 78,
]);

const dbase = new Uint16Array([ // distance codes 0..29 base
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577, 0, 0,
]);

const dext = new Uint8Array([ // distance codes 0..29 extra
  16, 16, 16, 16, 17, 17, 18, 18, 19, 19, 20, 20, 21, 21, 22, 22,
  23, 23, 24, 24, 25, 25, 26, 26, 27, 27,
  28, 28, 29, 29, 64, 64,
]);

/*
 * Build a canonical Huffman decoding table for length/literal or distance
 * codes. See the detailed algorithm notes in the zlib reference - in short:
 *
 *   1. Count codes per length, derive offsets, and sort symbols by length.
 *   2. Fill a "root" table of 1<<root entries by replicating each symbol
 *      for every index whose low `len` bits match its Huffman code.
 *   3. Whenever a code is longer than `root`, allocate a sub-table and
 *      record a pointer in the root table entry.
 *   4. Continue until all symbols are placed; remaining entries (if any)
 *      are filled with an invalid-code marker.
 *
 * Each table entry is a packed int32: (bits<<24) | (op<<16) | val.
 */
const inflate_table = (type, lens, lens_index, codes, table, table_index, work, opts) => {
  const bits = opts.bits;

  let len = 0;
  let sym = 0;
  let min = 0;
  let max = 0;
  let root = 0;
  let curr = 0;
  let drop = 0;
  let left = 0;
  let used = 0;
  let huff = 0;
  let incr;
  let fill;
  let low;
  let mask;
  let next;
  let base = null;
  let match;
  const count = new Uint16Array(MAXBITS + 1);
  const offs = new Uint16Array(MAXBITS + 1);
  let extra = null;

  let here_bits;
  let here_op;
  let here_val;

  // Accumulate lengths. count[0] through count[MAXBITS] are zero-initialised
  // by Uint16Array construction, so only the increment loop is needed.
  for (sym = 0; sym < codes; sym++) count[lens[lens_index + sym]]++;

  // Bound code lengths, force root to be within code lengths.
  root = bits;
  for (max = MAXBITS; max >= 1; max--) {
    if (count[max] !== 0) break;
  }
  if (root > max) root = max;
  if (max === 0) { // no symbols to code at all
    table[table_index++] = (1 << 24) | (64 << 16) | 0;
    table[table_index++] = (1 << 24) | (64 << 16) | 0;
    opts.bits = 1;
    return 0; // no symbols, but wait for decoding to report error
  }
  for (min = 1; min < max; min++) {
    if (count[min] !== 0) break;
  }
  if (root < min) root = min;

  // Check for an over-subscribed or incomplete set of lengths.
  left = 1;
  for (len = 1; len <= MAXBITS; len++) {
    left <<= 1;
    left -= count[len];
    if (left < 0) return -1; // over-subscribed
  }
  if (left > 0 && (type === CODES || max !== 1)) return -1; // incomplete

  // Generate offsets into symbol table for each length for sorting.
  offs[1] = 0;
  for (len = 1; len < MAXBITS; len++) offs[len + 1] = offs[len] + count[len];

  // Sort symbols by length, by symbol order within each length.
  for (sym = 0; sym < codes; sym++) {
    if (lens[lens_index + sym] !== 0) {
      work[offs[lens[lens_index + sym]]++] = sym;
    }
  }

  // Set up for code type. Kept as if-else rather than switch to avoid v8 deopts.
  if (type === CODES) {
    base = extra = work; // dummy - not used
    match = 20;
  } else if (type === LENS) {
    base = lbase;
    extra = lext;
    match = 257;
  } else { // DISTS
    base = dbase;
    extra = dext;
    match = 0;
  }

  huff = 0; // starting code
  sym = 0; // starting code symbol
  len = min; // starting code length
  next = table_index; // current table to fill in
  curr = root; // current table index bits
  drop = 0; // current bits to drop from code for index
  low = -1; // trigger new sub-table when len > root
  used = 1 << root;
  mask = used - 1;

  if ((type === LENS && used > ENOUGH_LENS)
      || (type === DISTS && used > ENOUGH_DISTS)) return 1;

  for (;;) {
    here_bits = len - drop;
    if (work[sym] + 1 < match) {
      here_op = 0;
      here_val = work[sym];
    } else if (work[sym] >= match) {
      here_op = extra[work[sym] - match];
      here_val = base[work[sym] - match];
    } else {
      here_op = 32 + 64; // end of block
      here_val = 0;
    }

    // Replicate for those indices with low len bits equal to huff.
    incr = 1 << (len - drop);
    fill = 1 << curr;
    min = fill; // save offset to next table
    do {
      fill -= incr;
      table[next + (huff >> drop) + fill] = (here_bits << 24) | (here_op << 16) | here_val | 0;
    } while (fill !== 0);

    // Backwards increment the len-bit code huff.
    incr = 1 << (len - 1);
    while (huff & incr) incr >>= 1;
    if (incr !== 0) {
      huff &= incr - 1;
      huff += incr;
    } else {
      huff = 0;
    }

    sym++;
    if (--count[len] === 0) {
      if (len === max) break;
      len = lens[lens_index + work[sym]];
    }

    // Create new sub-table if needed.
    if (len > root && (huff & mask) !== low) {
      if (drop === 0) drop = root;
      next += min; // here min is 1 << curr

      curr = len - drop;
      left = 1 << curr;
      while (curr + drop < max) {
        left -= count[curr + drop];
        if (left <= 0) break;
        curr++;
        left <<= 1;
      }

      used += 1 << curr;
      if ((type === LENS && used > ENOUGH_LENS)
          || (type === DISTS && used > ENOUGH_DISTS)) return 1;

      low = huff & mask;
      table[low] = (root << 24) | (curr << 16) | (next - table_index) | 0;
    }
  }

  // Fill in the final entry if the code is incomplete (at most one entry,
  // since any incomplete code has max length 1 bit by this point).
  if (huff !== 0) table[next + huff] = ((len - drop) << 24) | (64 << 16) | 0;

  opts.bits = root;
  return 0;
};

// ───────────────────────── State objects ─────────────────────────────────────

const zswap32 = (q) => (((q >>> 24) & 0xff)
  + ((q >>> 8) & 0xff00)
  + ((q & 0xff00) << 8)
  + ((q & 0xff) << 24));

class InflateState {
  constructor() {
    this.strm = null;
    this.mode = 0;
    this.last = false;
    /** bit 0: zlib, bit 1: gzip, bit 2: validate check value */
    this.wrap = 0;
    this.havedict = false;
    /** gzip header method and flags (0 for zlib, -1 if no header yet) */
    this.flags = 0;
    /** zlib header max distance (INFLATE_STRICT) */
    this.dmax = 0;
    this.check = 0;
    this.total = 0;
    this.head = null;

    // Sliding window
    this.wbits = 0;
    this.wsize = 0;
    this.whave = 0;
    this.wnext = 0;
    this.window = null;

    // Bit accumulator
    this.hold = 0;
    this.bits = 0;

    // For string and stored-block copying
    this.length = 0;
    this.offset = 0;
    this.extra = 0;

    // Fixed and dynamic code tables
    this.lencode = null;
    this.distcode = null;
    this.lenbits = 0;
    this.distbits = 0;

    // Dynamic table building
    this.ncode = 0;
    this.nlen = 0;
    this.ndist = 0;
    this.have = 0;
    this.next = null;

    this.lens = new Uint16Array(320);
    this.work = new Uint16Array(288);

    // JS-specific: no pointers, so length and distance tables are held directly
    // in the state rather than allocated out of a shared codes[] area.
    this.lendyn = null;
    this.distdyn = null;
    this.sane = 0;
    this.back = 0;
    this.was = 0;
  }
}

class ZStream {
  constructor() {
    this.input = null;
    this.next_in = 0;
    this.avail_in = 0;
    this.total_in = 0;
    this.output = null;
    this.next_out = 0;
    this.avail_out = 0;
    this.total_out = 0;
    this.msg = '';
    this.state = null;
    /** best guess about the data type: 0 binary, 1 text, 2 unknown */
    this.data_type = 2;
    this.adler = 0;
  }
}

class GZheader {
  constructor() {
    this.text = 0;
    this.time = 0;
    this.xflags = 0;
    this.os = 0;
    this.extra = null;
    this.extra_len = 0;
    this.name = '';
    this.comment = '';
    this.hcrc = 0;
    this.done = false;
  }
}

// ───────────────────────── Inflate lifecycle helpers ────────────────────────

const inflateStateCheck = (strm) => {
  if (!strm) return 1;
  const state = strm.state;
  if (!state || state.strm !== strm || state.mode < HEAD || state.mode > SYNC) return 1;
  return 0;
};

const inflateResetKeep = (strm) => {
  if (inflateStateCheck(strm)) return Z_STREAM_ERROR;
  const state = strm.state;
  strm.total_in = strm.total_out = state.total = 0;
  strm.msg = '';
  if (state.wrap) strm.adler = state.wrap & 1; // supports the ill-conceived Java test suite
  state.mode = HEAD;
  state.last = 0;
  state.havedict = 0;
  state.flags = -1;
  state.dmax = 32768;
  state.head = null;
  state.hold = 0;
  state.bits = 0;
  state.lencode = state.lendyn = new Int32Array(ENOUGH_LENS);
  state.distcode = state.distdyn = new Int32Array(ENOUGH_DISTS);
  state.sane = 1;
  state.back = -1;
  return Z_OK;
};

const inflateReset = (strm) => {
  if (inflateStateCheck(strm)) return Z_STREAM_ERROR;
  const state = strm.state;
  state.wsize = 0;
  state.whave = 0;
  state.wnext = 0;
  return inflateResetKeep(strm);
};

const inflateReset2 = (strm, windowBits) => {
  if (inflateStateCheck(strm)) return Z_STREAM_ERROR;
  const state = strm.state;

  let wrap;
  if (windowBits < 0) {
    wrap = 0;
    windowBits = -windowBits;
  } else {
    wrap = (windowBits >> 4) + 5;
    if (windowBits < 48) windowBits &= 15;
  }

  if (windowBits && (windowBits < 8 || windowBits > 15)) return Z_STREAM_ERROR;
  if (state.window !== null && state.wbits !== windowBits) state.window = null;

  state.wrap = wrap;
  state.wbits = windowBits;
  return inflateReset(strm);
};

const inflateInit2 = (strm, windowBits) => {
  if (!strm) return Z_STREAM_ERROR;
  const state = new InflateState();
  strm.state = state;
  state.strm = strm;
  state.window = null;
  state.mode = HEAD;
  const ret = inflateReset2(strm, windowBits);
  if (ret !== Z_OK) strm.state = null;
  return ret;
};

// Fixed-Huffman tables are built once on first use (not thread-safe, but JS
// doesn't share state across threads so this is fine).
let virgin = true;
let lenfix;
let distfix;

const fixedtables = (state) => {
  if (virgin) {
    lenfix = new Int32Array(512);
    distfix = new Int32Array(32);

    // Literal/length table
    let sym = 0;
    while (sym < 144) state.lens[sym++] = 8;
    while (sym < 256) state.lens[sym++] = 9;
    while (sym < 280) state.lens[sym++] = 7;
    while (sym < 288) state.lens[sym++] = 8;
    inflate_table(LENS, state.lens, 0, 288, lenfix, 0, state.work, { bits: 9 });

    // Distance table
    sym = 0;
    while (sym < 32) state.lens[sym++] = 5;
    inflate_table(DISTS, state.lens, 0, 32, distfix, 0, state.work, { bits: 5 });

    virgin = false;
  }

  state.lencode = lenfix;
  state.lenbits = 9;
  state.distcode = distfix;
  state.distbits = 5;
};

/*
 * Update the sliding window with the last wsize (normally 32K) bytes written
 * before returning. Allocated on first use. Providing output buffers larger
 * than 32K speeds up subsequent matches, since distances within the recent
 * output don't need to be chased back into the window.
 */
const updatewindow = (strm, src, end, copy) => {
  const state = strm.state;

  if (state.window === null) {
    state.wsize = 1 << state.wbits;
    state.wnext = 0;
    state.whave = 0;
    state.window = new Uint8Array(state.wsize);
  }

  if (copy >= state.wsize) {
    state.window.set(src.subarray(end - state.wsize, end), 0);
    state.wnext = 0;
    state.whave = state.wsize;
  } else {
    let dist = state.wsize - state.wnext;
    if (dist > copy) dist = copy;
    state.window.set(src.subarray(end - copy, end - copy + dist), state.wnext);
    copy -= dist;
    if (copy) {
      state.window.set(src.subarray(end - copy, end), 0);
      state.wnext = copy;
      state.whave = state.wsize;
    } else {
      state.wnext += dist;
      if (state.wnext === state.wsize) state.wnext = 0;
      if (state.whave < state.wsize) state.whave += dist;
    }
  }
  return 0;
};

// ───────────────────────── inflate core state machine ───────────────────────

const order = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);

/*
 * The main inflate loop. This function is a hand-rolled state machine that
 * was ported from zlib's C macros; the `inf_leave` label plus `break` / `for`
 * pairs below emulate goto. The local `//` shorthand used to mark macro
 * boundaries in upstream pako (NEEDBITS/INITBITS/DROPBITS/PULLBYTE) has been
 * removed in favour of the inlined code alone. The logic is intentionally
 * preserved intact - changes here risk subtle regressions.
 */
const inflateCore = (strm, flush) => {
  let state;
  let input;
  let output;
  let next; // next input index
  let put; // next output index
  let have;
  let left;
  let hold;
  let bits;
  let _in;
  let _out; // save starting available input and output
  let copy; // number of stored or match bytes to copy
  let from;
  let from_source;
  let here = 0;
  let here_bits;
  let here_op;
  let here_val;
  let last_bits;
  let last_op;
  let last_val;
  let len;
  let ret;
  const hbuf = new Uint8Array(4); // buffer for gzip header crc calculation
  let opts;
  let n;

  if (inflateStateCheck(strm) || !strm.output
      || (!strm.input && strm.avail_in !== 0)) return Z_STREAM_ERROR;

  state = strm.state;
  if (state.mode === TYPE) state.mode = TYPEDO; // skip check

  put = strm.next_out;
  output = strm.output;
  left = strm.avail_out;
  next = strm.next_in;
  input = strm.input;
  have = strm.avail_in;
  hold = state.hold;
  bits = state.bits;

  _in = have;
  _out = left;
  ret = Z_OK;

  inf_leave:
  for (;;) {
    switch (state.mode) {
      case HEAD:
        if (state.wrap === 0) { state.mode = TYPEDO; break; }
        while (bits < 16) {
          if (have === 0) break inf_leave;
          have--;
          hold += input[next++] << bits;
          bits += 8;
        }
        if ((state.wrap & 2) && hold === 0x8b1f) { // gzip header
          if (state.wbits === 0) state.wbits = 15;
          state.check = 0;
          hbuf[0] = hold & 0xff;
          hbuf[1] = (hold >>> 8) & 0xff;
          state.check = crc32(state.check, hbuf, 2, 0);
          hold = 0; bits = 0;
          state.mode = FLAGS;
          break;
        }
        if (state.head) state.head.done = false;
        if (!(state.wrap & 1) || (((hold & 0xff) << 8) + (hold >> 8)) % 31) {
          strm.msg = 'incorrect header check';
          state.mode = BAD;
          break;
        }
        if ((hold & 0x0f) !== Z_DEFLATED) {
          strm.msg = 'unknown compression method';
          state.mode = BAD;
          break;
        }
        hold >>>= 4;
        bits -= 4;
        len = (hold & 0x0f) + 8;
        if (state.wbits === 0) state.wbits = len;
        if (len > 15 || len > state.wbits) {
          strm.msg = 'invalid window size';
          state.mode = BAD;
          break;
        }

        // pako patch: force `options.windowBits` so the default is the max.
        state.dmax = 1 << state.wbits;

        state.flags = 0;
        strm.adler = state.check = 1;
        state.mode = hold & 0x200 ? DICTID : TYPE;
        hold = 0; bits = 0;
        break;
      case FLAGS:
        while (bits < 16) {
          if (have === 0) break inf_leave;
          have--;
          hold += input[next++] << bits;
          bits += 8;
        }
        state.flags = hold;
        if ((state.flags & 0xff) !== Z_DEFLATED) {
          strm.msg = 'unknown compression method';
          state.mode = BAD;
          break;
        }
        if (state.flags & 0xe000) {
          strm.msg = 'unknown header flags set';
          state.mode = BAD;
          break;
        }
        if (state.head) state.head.text = (hold >> 8) & 1;
        if ((state.flags & 0x0200) && (state.wrap & 4)) {
          hbuf[0] = hold & 0xff;
          hbuf[1] = (hold >>> 8) & 0xff;
          state.check = crc32(state.check, hbuf, 2, 0);
        }
        hold = 0; bits = 0;
        state.mode = TIME;
        /* falls through */
      case TIME:
        while (bits < 32) {
          if (have === 0) break inf_leave;
          have--;
          hold += input[next++] << bits;
          bits += 8;
        }
        if (state.head) state.head.time = hold;
        if ((state.flags & 0x0200) && (state.wrap & 4)) {
          hbuf[0] = hold & 0xff;
          hbuf[1] = (hold >>> 8) & 0xff;
          hbuf[2] = (hold >>> 16) & 0xff;
          hbuf[3] = (hold >>> 24) & 0xff;
          state.check = crc32(state.check, hbuf, 4, 0);
        }
        hold = 0; bits = 0;
        state.mode = OS;
        /* falls through */
      case OS:
        while (bits < 16) {
          if (have === 0) break inf_leave;
          have--;
          hold += input[next++] << bits;
          bits += 8;
        }
        if (state.head) {
          state.head.xflags = hold & 0xff;
          state.head.os = hold >> 8;
        }
        if ((state.flags & 0x0200) && (state.wrap & 4)) {
          hbuf[0] = hold & 0xff;
          hbuf[1] = (hold >>> 8) & 0xff;
          state.check = crc32(state.check, hbuf, 2, 0);
        }
        hold = 0; bits = 0;
        state.mode = EXLEN;
        /* falls through */
      case EXLEN:
        if (state.flags & 0x0400) {
          while (bits < 16) {
            if (have === 0) break inf_leave;
            have--;
            hold += input[next++] << bits;
            bits += 8;
          }
          state.length = hold;
          if (state.head) state.head.extra_len = hold;
          if ((state.flags & 0x0200) && (state.wrap & 4)) {
            hbuf[0] = hold & 0xff;
            hbuf[1] = (hold >>> 8) & 0xff;
            state.check = crc32(state.check, hbuf, 2, 0);
          }
          hold = 0; bits = 0;
        } else if (state.head) {
          state.head.extra = null;
        }
        state.mode = EXTRA;
        /* falls through */
      case EXTRA:
        if (state.flags & 0x0400) {
          copy = state.length;
          if (copy > have) copy = have;
          if (copy) {
            if (state.head) {
              len = state.head.extra_len - state.length;
              // Use untyped array for more convenient processing later.
              if (!state.head.extra) state.head.extra = new Uint8Array(state.head.extra_len);
              // extra field is capped at 65536 bytes - no additional size check needed.
              state.head.extra.set(input.subarray(next, next + copy), len);
            }
            if ((state.flags & 0x0200) && (state.wrap & 4)) {
              state.check = crc32(state.check, input, copy, next);
            }
            have -= copy;
            next += copy;
            state.length -= copy;
          }
          if (state.length) break inf_leave;
        }
        state.length = 0;
        state.mode = NAME;
        /* falls through */
      case NAME:
        if (state.flags & 0x0800) {
          if (have === 0) break inf_leave;
          copy = 0;
          do {
            len = input[next + copy++];
            // Constant 65536 limit since in JS we don't preallocate memory.
            if (state.head && len && state.length < 65536) {
              state.head.name += String.fromCharCode(len);
            }
          } while (len && copy < have);

          if ((state.flags & 0x0200) && (state.wrap & 4)) {
            state.check = crc32(state.check, input, copy, next);
          }
          have -= copy;
          next += copy;
          if (len) break inf_leave;
        } else if (state.head) {
          state.head.name = null;
        }
        state.length = 0;
        state.mode = COMMENT;
        /* falls through */
      case COMMENT:
        if (state.flags & 0x1000) {
          if (have === 0) break inf_leave;
          copy = 0;
          do {
            len = input[next + copy++];
            if (state.head && len && state.length < 65536) {
              state.head.comment += String.fromCharCode(len);
            }
          } while (len && copy < have);
          if ((state.flags & 0x0200) && (state.wrap & 4)) {
            state.check = crc32(state.check, input, copy, next);
          }
          have -= copy;
          next += copy;
          if (len) break inf_leave;
        } else if (state.head) {
          state.head.comment = null;
        }
        state.mode = HCRC;
        /* falls through */
      case HCRC:
        if (state.flags & 0x0200) {
          while (bits < 16) {
            if (have === 0) break inf_leave;
            have--;
            hold += input[next++] << bits;
            bits += 8;
          }
          if ((state.wrap & 4) && hold !== (state.check & 0xffff)) {
            strm.msg = 'header crc mismatch';
            state.mode = BAD;
            break;
          }
          hold = 0; bits = 0;
        }
        if (state.head) {
          state.head.hcrc = (state.flags >> 9) & 1;
          state.head.done = true;
        }
        strm.adler = state.check = 0;
        state.mode = TYPE;
        break;
      case DICTID:
        while (bits < 32) {
          if (have === 0) break inf_leave;
          have--;
          hold += input[next++] << bits;
          bits += 8;
        }
        strm.adler = state.check = zswap32(hold);
        hold = 0; bits = 0;
        state.mode = DICT;
        /* falls through */
      case DICT:
        if (state.havedict === 0) {
          strm.next_out = put;
          strm.avail_out = left;
          strm.next_in = next;
          strm.avail_in = have;
          state.hold = hold;
          state.bits = bits;
          return Z_NEED_DICT;
        }
        strm.adler = state.check = 1;
        state.mode = TYPE;
        /* falls through */
      case TYPE:
        if (flush === Z_BLOCK || flush === Z_TREES) break inf_leave;
        /* falls through */
      case TYPEDO:
        if (state.last) {
          hold >>>= bits & 7;
          bits -= bits & 7;
          state.mode = CHECK;
          break;
        }
        while (bits < 3) {
          if (have === 0) break inf_leave;
          have--;
          hold += input[next++] << bits;
          bits += 8;
        }
        state.last = hold & 0x01;
        hold >>>= 1;
        bits -= 1;

        switch (hold & 0x03) {
          case 0: // stored block
            state.mode = STORED;
            break;
          case 1: // fixed block
            fixedtables(state);
            state.mode = LEN_;
            if (flush === Z_TREES) {
              hold >>>= 2;
              bits -= 2;
              break inf_leave;
            }
            break;
          case 2: // dynamic block
            state.mode = TABLE;
            break;
          case 3:
            strm.msg = 'invalid block type';
            state.mode = BAD;
        }
        hold >>>= 2;
        bits -= 2;
        break;
      case STORED:
        hold >>>= bits & 7; // go to byte boundary
        bits -= bits & 7;
        while (bits < 32) {
          if (have === 0) break inf_leave;
          have--;
          hold += input[next++] << bits;
          bits += 8;
        }
        if ((hold & 0xffff) !== ((hold >>> 16) ^ 0xffff)) {
          strm.msg = 'invalid stored block lengths';
          state.mode = BAD;
          break;
        }
        state.length = hold & 0xffff;
        hold = 0; bits = 0;
        state.mode = COPY_;
        if (flush === Z_TREES) break inf_leave;
        /* falls through */
      case COPY_:
        state.mode = COPY;
        /* falls through */
      case COPY:
        copy = state.length;
        if (copy) {
          if (copy > have) copy = have;
          if (copy > left) copy = left;
          if (copy === 0) break inf_leave;
          output.set(input.subarray(next, next + copy), put);
          have -= copy;
          next += copy;
          left -= copy;
          put += copy;
          state.length -= copy;
          break;
        }
        state.mode = TYPE;
        break;
      case TABLE:
        while (bits < 14) {
          if (have === 0) break inf_leave;
          have--;
          hold += input[next++] << bits;
          bits += 8;
        }
        state.nlen = (hold & 0x1f) + 257;
        hold >>>= 5;
        bits -= 5;
        state.ndist = (hold & 0x1f) + 1;
        hold >>>= 5;
        bits -= 5;
        state.ncode = (hold & 0x0f) + 4;
        hold >>>= 4;
        bits -= 4;
        if (state.nlen > 286 || state.ndist > 30) {
          strm.msg = 'too many length or distance symbols';
          state.mode = BAD;
          break;
        }
        state.have = 0;
        state.mode = LENLENS;
        /* falls through */
      case LENLENS:
        while (state.have < state.ncode) {
          while (bits < 3) {
            if (have === 0) break inf_leave;
            have--;
            hold += input[next++] << bits;
            bits += 8;
          }
          state.lens[order[state.have++]] = hold & 0x07;
          hold >>>= 3;
          bits -= 3;
        }
        while (state.have < 19) state.lens[order[state.have++]] = 0;
        state.lencode = state.lendyn;
        state.lenbits = 7;

        opts = { bits: state.lenbits };
        ret = inflate_table(CODES, state.lens, 0, 19, state.lencode, 0, state.work, opts);
        state.lenbits = opts.bits;

        if (ret) {
          strm.msg = 'invalid code lengths set';
          state.mode = BAD;
          break;
        }
        state.have = 0;
        state.mode = CODELENS;
        /* falls through */
      case CODELENS:
        while (state.have < state.nlen + state.ndist) {
          for (;;) {
            here = state.lencode[hold & ((1 << state.lenbits) - 1)];
            here_bits = here >>> 24;
            here_op = (here >>> 16) & 0xff;
            here_val = here & 0xffff;

            if (here_bits <= bits) break;
            if (have === 0) break inf_leave;
            have--;
            hold += input[next++] << bits;
            bits += 8;
          }
          if (here_val < 16) {
            hold >>>= here_bits;
            bits -= here_bits;
            state.lens[state.have++] = here_val;
          } else {
            if (here_val === 16) {
              n = here_bits + 2;
              while (bits < n) {
                if (have === 0) break inf_leave;
                have--;
                hold += input[next++] << bits;
                bits += 8;
              }
              hold >>>= here_bits;
              bits -= here_bits;
              if (state.have === 0) {
                strm.msg = 'invalid bit length repeat';
                state.mode = BAD;
                break;
              }
              len = state.lens[state.have - 1];
              copy = 3 + (hold & 0x03);
              hold >>>= 2;
              bits -= 2;
            } else if (here_val === 17) {
              n = here_bits + 3;
              while (bits < n) {
                if (have === 0) break inf_leave;
                have--;
                hold += input[next++] << bits;
                bits += 8;
              }
              hold >>>= here_bits;
              bits -= here_bits;
              len = 0;
              copy = 3 + (hold & 0x07);
              hold >>>= 3;
              bits -= 3;
            } else {
              n = here_bits + 7;
              while (bits < n) {
                if (have === 0) break inf_leave;
                have--;
                hold += input[next++] << bits;
                bits += 8;
              }
              hold >>>= here_bits;
              bits -= here_bits;
              len = 0;
              copy = 11 + (hold & 0x7f);
              hold >>>= 7;
              bits -= 7;
            }
            if (state.have + copy > state.nlen + state.ndist) {
              strm.msg = 'invalid bit length repeat';
              state.mode = BAD;
              break;
            }
            while (copy--) state.lens[state.have++] = len;
          }
        }

        if (state.mode === BAD) break;

        if (state.lens[256] === 0) {
          strm.msg = 'invalid code -- missing end-of-block';
          state.mode = BAD;
          break;
        }

        // The literal values 9 and 6 for lenbits/distbits below must not change
        // without re-checking the ENOUGH_LENS / ENOUGH_DISTS constants.
        state.lenbits = 9;
        opts = { bits: state.lenbits };
        ret = inflate_table(LENS, state.lens, 0, state.nlen, state.lencode, 0, state.work, opts);
        state.lenbits = opts.bits;
        if (ret) {
          strm.msg = 'invalid literal/lengths set';
          state.mode = BAD;
          break;
        }

        state.distbits = 6;
        state.distcode = state.distdyn;
        opts = { bits: state.distbits };
        ret = inflate_table(DISTS, state.lens, state.nlen, state.ndist, state.distcode, 0, state.work, opts);
        state.distbits = opts.bits;
        if (ret) {
          strm.msg = 'invalid distances set';
          state.mode = BAD;
          break;
        }
        state.mode = LEN_;
        if (flush === Z_TREES) break inf_leave;
        /* falls through */
      case LEN_:
        state.mode = LEN;
        /* falls through */
      case LEN:
        if (have >= 6 && left >= 258) {
          strm.next_out = put;
          strm.avail_out = left;
          strm.next_in = next;
          strm.avail_in = have;
          state.hold = hold;
          state.bits = bits;
          inflate_fast(strm, _out);
          put = strm.next_out;
          output = strm.output;
          left = strm.avail_out;
          next = strm.next_in;
          input = strm.input;
          have = strm.avail_in;
          hold = state.hold;
          bits = state.bits;
          if (state.mode === TYPE) state.back = -1;
          break;
        }
        state.back = 0;
        for (;;) {
          here = state.lencode[hold & ((1 << state.lenbits) - 1)];
          here_bits = here >>> 24;
          here_op = (here >>> 16) & 0xff;
          here_val = here & 0xffff;

          if (here_bits <= bits) break;
          if (have === 0) break inf_leave;
          have--;
          hold += input[next++] << bits;
          bits += 8;
        }
        if (here_op && (here_op & 0xf0) === 0) {
          last_bits = here_bits;
          last_op = here_op;
          last_val = here_val;
          for (;;) {
            here = state.lencode[last_val
              + ((hold & ((1 << (last_bits + last_op)) - 1)) >> last_bits)];
            here_bits = here >>> 24;
            here_op = (here >>> 16) & 0xff;
            here_val = here & 0xffff;

            if ((last_bits + here_bits) <= bits) break;
            if (have === 0) break inf_leave;
            have--;
            hold += input[next++] << bits;
            bits += 8;
          }
          hold >>>= last_bits;
          bits -= last_bits;
          state.back += last_bits;
        }
        hold >>>= here_bits;
        bits -= here_bits;
        state.back += here_bits;
        state.length = here_val;
        if (here_op === 0) {
          state.mode = LIT;
          break;
        }
        if (here_op & 32) {
          state.back = -1;
          state.mode = TYPE;
          break;
        }
        if (here_op & 64) {
          strm.msg = 'invalid literal/length code';
          state.mode = BAD;
          break;
        }
        state.extra = here_op & 15;
        state.mode = LENEXT;
        /* falls through */
      case LENEXT:
        if (state.extra) {
          n = state.extra;
          while (bits < n) {
            if (have === 0) break inf_leave;
            have--;
            hold += input[next++] << bits;
            bits += 8;
          }
          state.length += hold & ((1 << state.extra) - 1);
          hold >>>= state.extra;
          bits -= state.extra;
          state.back += state.extra;
        }
        state.was = state.length;
        state.mode = DIST;
        /* falls through */
      case DIST:
        for (;;) {
          here = state.distcode[hold & ((1 << state.distbits) - 1)];
          here_bits = here >>> 24;
          here_op = (here >>> 16) & 0xff;
          here_val = here & 0xffff;

          if (here_bits <= bits) break;
          if (have === 0) break inf_leave;
          have--;
          hold += input[next++] << bits;
          bits += 8;
        }
        if ((here_op & 0xf0) === 0) {
          last_bits = here_bits;
          last_op = here_op;
          last_val = here_val;
          for (;;) {
            here = state.distcode[last_val
              + ((hold & ((1 << (last_bits + last_op)) - 1)) >> last_bits)];
            here_bits = here >>> 24;
            here_op = (here >>> 16) & 0xff;
            here_val = here & 0xffff;

            if ((last_bits + here_bits) <= bits) break;
            if (have === 0) break inf_leave;
            have--;
            hold += input[next++] << bits;
            bits += 8;
          }
          hold >>>= last_bits;
          bits -= last_bits;
          state.back += last_bits;
        }
        hold >>>= here_bits;
        bits -= here_bits;
        state.back += here_bits;
        if (here_op & 64) {
          strm.msg = 'invalid distance code';
          state.mode = BAD;
          break;
        }
        state.offset = here_val;
        state.extra = here_op & 15;
        state.mode = DISTEXT;
        /* falls through */
      case DISTEXT:
        if (state.extra) {
          n = state.extra;
          while (bits < n) {
            if (have === 0) break inf_leave;
            have--;
            hold += input[next++] << bits;
            bits += 8;
          }
          state.offset += hold & ((1 << state.extra) - 1);
          hold >>>= state.extra;
          bits -= state.extra;
          state.back += state.extra;
        }
        if (state.offset > state.dmax) {
          strm.msg = 'invalid distance too far back';
          state.mode = BAD;
          break;
        }
        state.mode = MATCH;
        /* falls through */
      case MATCH:
        if (left === 0) break inf_leave;
        copy = _out - left;
        if (state.offset > copy) { // copy from window
          copy = state.offset - copy;
          if (copy > state.whave && state.sane) {
            strm.msg = 'invalid distance too far back';
            state.mode = BAD;
            break;
          }
          if (copy > state.wnext) {
            copy -= state.wnext;
            from = state.wsize - copy;
          } else {
            from = state.wnext - copy;
          }
          if (copy > state.length) copy = state.length;
          from_source = state.window;
        } else { // copy from output
          from_source = output;
          from = put - state.offset;
          copy = state.length;
        }
        if (copy > left) copy = left;
        left -= copy;
        state.length -= copy;
        do {
          output[put++] = from_source[from++];
        } while (--copy);
        if (state.length === 0) state.mode = LEN;
        break;
      case LIT:
        if (left === 0) break inf_leave;
        output[put++] = state.length;
        left--;
        state.mode = LEN;
        break;
      case CHECK:
        if (state.wrap) {
          while (bits < 32) {
            if (have === 0) break inf_leave;
            have--;
            // Use '|' instead of '+' to make sure the result is signed.
            hold |= input[next++] << bits;
            bits += 8;
          }
          _out -= left;
          strm.total_out += _out;
          state.total += _out;
          if ((state.wrap & 4) && _out) {
            strm.adler = state.check = state.flags
              ? crc32(state.check, output, _out, put - _out)
              : adler32(state.check, output, _out, put - _out);
          }
          _out = left;
          // NB: crc32 stored as signed 32-bit int; zswap32 returns signed too.
          if ((state.wrap & 4) && (state.flags ? hold : zswap32(hold)) !== state.check) {
            strm.msg = 'incorrect data check';
            state.mode = BAD;
            break;
          }
          hold = 0; bits = 0;
        }
        state.mode = LENGTH;
        /* falls through */
      case LENGTH:
        if (state.wrap && state.flags) {
          while (bits < 32) {
            if (have === 0) break inf_leave;
            have--;
            hold += input[next++] << bits;
            bits += 8;
          }
          if ((state.wrap & 4) && hold !== (state.total & 0xffffffff)) {
            strm.msg = 'incorrect length check';
            state.mode = BAD;
            break;
          }
          hold = 0; bits = 0;
        }
        state.mode = DONE;
        /* falls through */
      case DONE:
        ret = Z_STREAM_END;
        break inf_leave;
      case BAD:
        ret = Z_DATA_ERROR;
        break inf_leave;
      case MEM:
        return Z_MEM_ERROR;
      case SYNC:
      default:
        return Z_STREAM_ERROR;
    }
  }

  strm.next_out = put;
  strm.avail_out = left;
  strm.next_in = next;
  strm.avail_in = have;
  state.hold = hold;
  state.bits = bits;

  if (state.wsize || (_out !== strm.avail_out && state.mode < BAD
      && (state.mode < CHECK || flush !== Z_FINISH))) {
    updatewindow(strm, strm.output, strm.next_out, _out - strm.avail_out);
  }
  _in -= strm.avail_in;
  _out -= strm.avail_out;
  strm.total_in += _in;
  strm.total_out += _out;
  state.total += _out;
  if ((state.wrap & 4) && _out) {
    strm.adler = state.check = state.flags
      ? crc32(state.check, output, _out, strm.next_out - _out)
      : adler32(state.check, output, _out, strm.next_out - _out);
  }
  strm.data_type = state.bits
    + (state.last ? 64 : 0)
    + (state.mode === TYPE ? 128 : 0)
    + (state.mode === LEN_ || state.mode === COPY_ ? 256 : 0);
  if (((_in === 0 && _out === 0) || flush === Z_FINISH) && ret === Z_OK) ret = Z_BUF_ERROR;
  return ret;
};

const inflateEnd = (strm) => {
  if (inflateStateCheck(strm)) return Z_STREAM_ERROR;
  const state = strm.state;
  if (state.window) state.window = null;
  strm.state = null;
  return Z_OK;
};

const inflateGetHeader = (strm, head) => {
  if (inflateStateCheck(strm)) return Z_STREAM_ERROR;
  const state = strm.state;
  if ((state.wrap & 2) === 0) return Z_STREAM_ERROR;
  state.head = head;
  head.done = false;
  return Z_OK;
};

const inflateSetDictionary = (strm, dictionary) => {
  const dictLength = dictionary.length;
  if (inflateStateCheck(strm)) return Z_STREAM_ERROR;
  const state = strm.state;
  if (state.wrap !== 0 && state.mode !== DICT) return Z_STREAM_ERROR;

  if (state.mode === DICT) {
    const dictid = adler32(1, dictionary, dictLength, 0);
    if (dictid !== state.check) return Z_DATA_ERROR;
  }
  const ret = updatewindow(strm, dictionary, dictLength, dictLength);
  if (ret) {
    state.mode = MEM;
    return Z_MEM_ERROR;
  }
  state.havedict = 1;
  return Z_OK;
};

// ───────────────────────── Chunk utilities ──────────────────────────────────

const flattenChunks = (chunks) => {
  let len = 0;
  for (let i = 0; i < chunks.length; i++) len += chunks[i].length;

  const result = new Uint8Array(len);
  let pos = 0;
  for (let i = 0; i < chunks.length; i++) {
    result.set(chunks[i], pos);
    pos += chunks[i].length;
  }
  return result;
};

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

// Back up from `max` until the start of a valid UTF-8 sequence so that
// a byte slice can be decoded without splitting a multi-byte character.
const utf8border = (buf, max) => {
  max = max || buf.length;
  if (max > buf.length) max = buf.length;

  let pos = max - 1;
  while (pos >= 0 && (buf[pos] & 0xC0) === 0x80) pos--;
  if (pos < 0 || pos === 0) return max;

  const lead = buf[pos];
  const seqLen = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return (pos + seqLen > max) ? pos : max;
};

const messages = {
  2: 'need dictionary',
  1: 'stream end',
  0: '',
  '-1': 'file error',
  '-2': 'stream error',
  '-3': 'data error',
  '-4': 'insufficient memory',
  '-5': 'buffer error',
  '-6': 'incompatible version',
};

// ───────────────────────── Inflate user class ───────────────────────────────

/**
 * Streaming inflate. Accepts compressed data via {@link Inflate#push} and
 * delivers decompressed output through {@link Inflate#onData} and the final
 * {@link Inflate#onEnd} callback. After completion, {@link Inflate#result} is
 * either a `Uint8Array` or a string depending on `options.to`.
 *
 * Supported options:
 *   - `windowBits` - matches zlib's `windowBits`; negative for raw deflate
 *   - `dictionary` - preset dictionary as `Uint8Array`, `ArrayBuffer`, or string
 *   - `chunkSize` - size of internal output chunks (default 64 KiB)
 *   - `raw` - `true` to force raw-deflate mode
 *   - `to` - `'string'` to decode chunks as UTF-8 on the fly
 */
class Inflate {
  constructor(options) {
    this.options = {
      chunkSize: 64 * 1024,
      windowBits: 15,
      to: '',
      ...options || {},
    };

    const opt = this.options;

    // Force raw-stream window size when no header can tell us what it is.
    if (opt.raw && opt.windowBits >= 0 && opt.windowBits < 16) {
      opt.windowBits = -opt.windowBits;
      if (opt.windowBits === 0) opt.windowBits = -15;
    }

    // NOTE: gzip autodetect (windowBits += 32) is intentionally NOT applied.
    // PDFs never use gzip, and autodetect causes pako to reject valid zlib
    // streams with non-standard CINFO values or truncated checksums.

    this.err = 0;
    this.msg = '';
    this.ended = false;
    this.chunks = [];

    this.strm = new ZStream();
    this.strm.avail_out = 0;

    let status = inflateInit2(this.strm, opt.windowBits);
    if (status !== Z_OK) throw new Error(messages[status]);

    this.header = new GZheader();
    inflateGetHeader(this.strm, this.header);

    if (opt.dictionary) {
      if (typeof opt.dictionary === 'string') {
        opt.dictionary = utf8Encoder.encode(opt.dictionary);
      } else if (opt.dictionary instanceof ArrayBuffer) {
        opt.dictionary = new Uint8Array(opt.dictionary);
      }
      if (opt.raw) {
        status = inflateSetDictionary(this.strm, opt.dictionary);
        if (status !== Z_OK) throw new Error(messages[status]);
      }
    }
  }

  /**
   * Feed a chunk of compressed data into the inflator.
   * @param {Uint8Array|ArrayBuffer} data
   * @param {number|boolean} [flushMode] - 0..6 (Z_NO_FLUSH..Z_TREES);
   *   `true` is shorthand for `Z_FINISH`, `false`/undefined for `Z_NO_FLUSH`.
   * @returns {boolean} `true` on success, `false` on error.
   */
  push(data, flushMode) {
    const strm = this.strm;
    const chunkSize = this.options.chunkSize;
    const dictionary = this.options.dictionary;

    if (this.ended) return false;

    let flushValue;
    if (typeof flushMode === 'number' && flushMode === ~~flushMode) flushValue = flushMode;
    else flushValue = flushMode === true ? Z_FINISH : Z_NO_FLUSH;

    strm.input = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    strm.next_in = 0;
    strm.avail_in = strm.input.length;

    for (;;) {
      if (strm.avail_out === 0) {
        strm.output = new Uint8Array(chunkSize);
        strm.next_out = 0;
        strm.avail_out = chunkSize;
      }

      let status = inflateCore(strm, flushValue);

      if (status === Z_NEED_DICT && dictionary) {
        status = inflateSetDictionary(strm, dictionary);
        if (status === Z_OK) status = inflateCore(strm, flushValue);
        else if (status === Z_DATA_ERROR) status = Z_NEED_DICT; // more verbose
      }

      // Skip sync markers if more data follows and not in raw mode.
      while (strm.avail_in > 0
        && status === Z_STREAM_END
        && strm.state.wrap > 0
        && data[strm.next_in] !== 0) {
        inflateReset(strm);
        status = inflateCore(strm, flushValue);
      }

      if (status === Z_STREAM_ERROR
        || status === Z_DATA_ERROR
        || status === Z_NEED_DICT
        || status === Z_MEM_ERROR) {
        this.onEnd(status);
        this.ended = true;
        return false;
      }

      // Snapshot avail_out since we may patch the buffer for utf8 alignment.
      const lastAvailOut = strm.avail_out;

      if (strm.next_out && (strm.avail_out === 0 || status === Z_STREAM_END)) {
        if (this.options.to === 'string') {
          const next_out_utf8 = utf8border(strm.output, strm.next_out);
          const tail = strm.next_out - next_out_utf8;
          const utf8str = utf8Decoder.decode(strm.output.subarray(0, next_out_utf8));

          strm.next_out = tail;
          strm.avail_out = chunkSize - tail;
          if (tail) strm.output.set(strm.output.subarray(next_out_utf8, next_out_utf8 + tail), 0);

          this.onData(utf8str);
        } else {
          this.onData(strm.output.length === strm.next_out
            ? strm.output
            : strm.output.subarray(0, strm.next_out));
        }
      }

      if (status === Z_OK && lastAvailOut === 0) continue;

      if (status === Z_STREAM_END) {
        const endStatus = inflateEnd(this.strm);
        this.onEnd(endStatus);
        this.ended = true;
        return true;
      }

      if (strm.avail_in === 0) break;
    }

    return true;
  }

  /** Default chunk sink - override to stream output elsewhere. */
  onData(chunk) {
    this.chunks.push(chunk);
  }

  /** Default end callback - flattens chunks into `this.result`. */
  onEnd(status) {
    // Always flatten chunks into result - even on error, partial output is
    // useful for recovering truncated/corrupted PDF streams.
    if (this.chunks.length > 0) {
      this.result = this.options.to === 'string'
        ? this.chunks.join('')
        : flattenChunks(this.chunks);
    }
    this.chunks = [];
    this.err = status;
    this.msg = this.strm.msg;
  }
}

// Collect whatever output the inflator managed to produce, even if the stream
// was truncated or failed mid-way. Three candidate sources, in precedence:
//   1. inflator.result - flattened output set by onEnd
//   2. inflator.chunks - any chunks produced before onEnd ran
//   3. strm.output[0..next_out] - data sitting in the output buffer
const salvagePartial = (inflator) => {
  if (inflator.result instanceof Uint8Array) return inflator.result;
  const parts = [];
  if (inflator.chunks.length > 0) parts.push(...inflator.chunks);
  if (inflator.strm && inflator.strm.next_out > 0) {
    parts.push(inflator.strm.output.slice(0, inflator.strm.next_out));
  }
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0] : flattenChunks(parts);
};

// ───────────────────────── Public API ───────────────────────────────────────

/**
 * Decompress zlib-wrapped deflate data. Strips the zlib header/checksum
 * ourselves and delegates to inflateRaw, bypassing pako's strict header and
 * adler32 validation, which reject many valid PDF streams.
 * @param {Uint8Array} data - zlib-wrapped deflate data
 * @returns {Uint8Array}
 */
export function zlibInflate(data) {
  if (data.length < 2) throw new Error('inflate: input too short');
  if ((data[0] & 0x0F) !== 8) throw new Error('inflate: not deflate data');
  let offset = 2;
  if (data[1] & 0x20) offset += 4; // FDICT
  const result = inflateRaw(data.subarray(offset));
  if (!(result instanceof Uint8Array)) throw new Error('inflate: no output');
  return result;
}

/**
 * Decompress raw-deflate data (no zlib wrapper).
 * @param {Uint8Array|ArrayBuffer} data
 * @param {object} [options]
 * @returns {Uint8Array|string}
 */
export function inflateRaw(data, options) {
  const inflator = new Inflate({ ...(options || {}), raw: true });
  inflator.push(data);

  const salvaged = salvagePartial(inflator);
  if (salvaged) inflator.result = salvaged;

  if (inflator.err) {
    if (inflator.result instanceof Uint8Array && inflator.result.length > 0) return inflator.result;
    throw inflator.msg || messages[inflator.err];
  }
  return inflator.result || new Uint8Array(0);
}

/**
 * Decompress zlib-wrapped data, recovering partial output from corrupted
 * streams. Returns whatever was decompressed before the error, or an empty
 * Uint8Array if nothing could be recovered.
 * @param {Uint8Array} data - zlib-wrapped deflate data (may be corrupted)
 * @returns {Uint8Array}
 */
export function inflatePartial(data) {
  try {
    return zlibInflate(data);
  } catch { /* fall through */ }

  let offset = 2;
  if (data.length > 2 && (data[1] & 0x20)) offset += 4;
  if (data.length <= offset) return new Uint8Array(0);

  const inflator = new Inflate({ raw: true });
  inflator.push(data.subarray(offset));
  return salvagePartial(inflator) || new Uint8Array(0);
}

export { zlibInflate as inflate };
