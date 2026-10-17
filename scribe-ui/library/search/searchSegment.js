import {
  ByteReader, ByteWriter, HEAP_OBJECT, HEAP_STRING, HEAP_TYPED_ARRAY, HEAP_VIEW, unpack, utf8Decode, utf8Encode,
} from './searchBytes.js';

const MAGIC = utf8Encode('SSG1');
const MAGIC_PACKED = utf8Encode('SSG2');
const PACK_MIN = 3;
const NO_BYTES = new Uint8Array(0);
export const DICT_BLOCK = 16;
export const POST_BLOCK = 128;
export const PAGE_KEY_SPAN = 65536;
const FOOTER_BYTES = 28;

/**
 * @typedef {Object} PostingEntry
 * @property {number} key - documentOrdinal * PAGE_KEY_SPAN + page.
 * @property {number[]} values - Ascending (position << 1 | span) values.
 */

const run = new Float64Array(POST_BLOCK);
let positionRun = new Float64Array(4096);

/**
 * @param {ByteWriter} w
 * @param {PostingEntry[]} entries
 * @param {number} from
 * @param {number} to
 * @param {number} prevDense - The dense page of the entry before the block, or -1 at the list's start.
 * @param {Float64Array} pageBase
 * @returns {number}
 */
const writePackedBlock = (w, entries, from, to, prevDense, pageBase) => {
  const m = to - from;
  let positions = 0;
  for (let i = from; i < to; i++) {
    const { key } = entries[i];
    const dense = pageBase[Math.floor(key / PAGE_KEY_SPAN)] + (key % PAGE_KEY_SPAN);
    run[i - from] = dense - prevDense - 1;
    prevDense = dense;
    positions += entries[i].values.length;
  }
  if (m >= PACK_MIN) w.packed(run, 0, m);
  else for (let i = 0; i < m; i++) w.varint(run[i]);
  for (let i = from; i < to; i++) run[i - from] = entries[i].values.length - 1;
  if (m >= PACK_MIN) w.packed(run, 0, m);
  else for (let i = 0; i < m; i++) w.varint(run[i]);
  if (positionRun.length < positions) positionRun = new Float64Array(positions * 2);
  let k = 0;
  for (let i = from; i < to; i++) {
    let last = 0;
    for (const v of entries[i].values) {
      positionRun[k++] = v - last;
      last = v;
    }
  }
  for (let at = 0; at < positions; at += POST_BLOCK) {
    const n = Math.min(POST_BLOCK, positions - at);
    if (n >= PACK_MIN) w.packed(positionRun, at, n);
    else for (let j = at; j < at + n; j++) w.varint(positionRun[j]);
  }
  return prevDense;
};

/**
 * @param {Array<{hash: string, pageCount: number, pageLengths: ArrayLike<number>}>} docs
 * @param {Iterable<{bytes: Uint8Array, entries: PostingEntry[]}>} terms - In ascending order of their UTF-8 bytes, each with its entries in ascending key order.
 * @param {'varint'|'packed'} [encoding]
 * @returns {Uint8Array}
 */
export const writeSegment = (docs, terms, encoding = 'varint') => {
  const packed = encoding === 'packed';
  const out = new ByteWriter(1 << 20);
  out.bytes(packed ? MAGIC_PACKED : MAGIC);
  const docTableOff = out.length;
  out.varint(docs.length);
  for (const d of docs) {
    const h = utf8Encode(d.hash);
    out.varint(h.length);
    out.bytes(h);
    out.varint(d.pageCount);
    for (let p = 0; p < d.pageCount; p++) out.varint(Math.min(65535, d.pageLengths[p] || 0));
  }
  const post = new ByteWriter(1 << 20);
  /** @type {Array<{term: Uint8Array, df: number, len: number, start: number}>} */
  const dict = [];
  const pageBase = new Float64Array(packed ? docs.length + 1 : 0);
  if (packed) for (let i = 0; i < docs.length; i++) pageBase[i + 1] = pageBase[i] + docs[i].pageCount;
  for (const { bytes, entries } of terms) {
    const start = post.length;
    post.varint(entries.length);
    if (entries.length > POST_BLOCK) {
      const blocks = [];
      let prevDense = -1;
      for (let b = 0; b < entries.length; b += POST_BLOCK) {
        const w = new ByteWriter(4096);
        let lastKey = b > 0 ? entries[b - 1].key : 0;
        const end = Math.min(entries.length, b + POST_BLOCK);
        if (packed) {
          prevDense = writePackedBlock(w, entries, b, end, prevDense, pageBase);
          lastKey = entries[end - 1].key;
        } else {
          for (let i = b; i < end; i++) {
            const e = entries[i];
            w.varint(e.key - lastKey);
            lastKey = e.key;
            w.varint(e.values.length);
            let lastV = 0;
            for (const v of e.values) {
              w.varint(v - lastV);
              lastV = v;
            }
          }
        }
        blocks.push({ bytes: w.result(), lastKey });
      }
      post.varint(blocks.length);
      let prevLast = 0;
      for (const b of blocks) {
        post.varint(b.lastKey - prevLast);
        prevLast = b.lastKey;
        post.varint(b.bytes.length);
      }
      for (const b of blocks) post.bytes(b.bytes);
    } else if (packed) {
      writePackedBlock(post, entries, 0, entries.length, -1, pageBase);
    } else {
      let lastKey = 0;
      for (const e of entries) {
        post.varint(e.key - lastKey);
        lastKey = e.key;
        post.varint(e.values.length);
        let lastV = 0;
        for (const v of e.values) {
          post.varint(v - lastV);
          lastV = v;
        }
      }
    }
    dict.push({
      term: bytes, df: entries.length, len: post.length - start, start,
    });
  }
  const dictOff = out.length;
  /** @type {Array<{term: Uint8Array, off: number, len: number}>} */
  const sparse = [];
  for (let b = 0; b < dict.length; b += DICT_BLOCK) {
    const blockOff = out.length;
    const end = Math.min(dict.length, b + DICT_BLOCK);
    out.varint(end - b);
    out.varint(dict[b].start);
    for (let i = b; i < end; i++) {
      const t = dict[i].term;
      if (i === b) {
        out.varint(t.length);
        out.bytes(t);
      } else {
        const p = dict[i - 1].term;
        let shared = 0;
        const max = Math.min(p.length, t.length);
        while (shared < max && p[shared] === t[shared]) shared++;
        out.varint(shared);
        out.varint(t.length - shared);
        out.bytes(t.subarray(shared));
      }
      out.varint(dict[i].df);
      out.varint(dict[i].len);
    }
    sparse.push({ term: dict[b].term, off: blockOff, len: out.length - blockOff });
  }
  const dictLen = out.length - dictOff;
  const postOff = out.length;
  out.bytes(post.result());
  const sparseOff = out.length;
  out.varint(sparse.length);
  for (const s of sparse) {
    out.varint(s.term.length);
    out.bytes(s.term);
    out.varint(s.off);
    out.varint(s.len);
  }
  const sparseLen = out.length - sparseOff;
  out.u32(docTableOff);
  out.u32(dictOff);
  out.u32(dictLen);
  out.u32(postOff);
  out.u32(sparseOff);
  out.u32(sparseLen);
  out.u32(dict.length);
  return out.result();
};

/**
 * @typedef {Object} TermEntry
 * @property {string} term
 * @property {number} df - Page entries in the postings.
 * @property {number} offset
 * @property {number} len - Byte length of the postings.
 */

/**
 * Compare two byte strings in the dictionary's order.
 * For UTF-8 that is code point order, which JavaScript's string comparison does not always follow.
 * @param {Uint8Array} a @param {Uint8Array} b
 */
export const compareBytes = (a, b) => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};

export class PostingsCursor {
  /**
   * @param {{read: (offset: number, length: number) => Uint8Array}} file
   * @param {TermEntry} entry
   */
  constructor(file, entry) {
    this.file = file;
    this.count = entry.df;
    this.key = -1;
    /** @type {number[]} */
    this.values = [];
    this.index = -1;
    const headLen = Math.min(entry.len, entry.df > POST_BLOCK ? 20 + Math.ceil(entry.df / POST_BLOCK) * 10 : entry.len);
    const r = new ByteReader(file.read(entry.offset, headLen));
    const n = r.varint();
    if (n > POST_BLOCK) {
      const nBlocks = r.varint();
      this.blockLastKey = new Array(nBlocks);
      this.blockOffset = new Array(nBlocks);
      let last = 0;
      let off = 0;
      for (let b = 0; b < nBlocks; b++) {
        last += r.varint();
        this.blockLastKey[b] = last;
        this.blockOffset[b] = off;
        off += r.varint();
      }
      this.blocksStart = entry.offset + r.at;
      this.blocksEnd = entry.offset + entry.len;
      this.block = -1;
      this.reader = null;
      this.blockRemaining = 0;
    } else {
      this.blockLastKey = null;
      this.reader = r;
      this.blockRemaining = n;
      this.block = 0;
    }
    this.prevKey = 0;
  }

  /** @param {number} b */
  _loadBlock(b) {
    const start = this.blocksStart + this.blockOffset[b];
    const end = b + 1 < this.blockOffset.length ? this.blocksStart + this.blockOffset[b + 1] : this.blocksEnd;
    this.reader = new ByteReader(this.file.read(start, end - start));
    this.block = b;
    this.blockRemaining = Math.min(POST_BLOCK, this.count - b * POST_BLOCK);
    this.prevKey = b > 0 ? this.blockLastKey[b - 1] : 0;
    this.index = b * POST_BLOCK - 1;
  }

  /** @returns {boolean} */
  next() {
    if (this.blockRemaining === 0) {
      if (this.blockLastKey === null || this.block + 1 >= this.blockLastKey.length) return false;
      this._loadBlock(this.block + 1);
    }
    const r = /** @type {ByteReader} */ (this.reader);
    this.prevKey += r.varint();
    this.key = this.prevKey;
    const n = r.varint();
    const values = new Array(n);
    let v = 0;
    for (let i = 0; i < n; i++) {
      v += r.varint();
      values[i] = v;
    }
    this.values = values;
    this.blockRemaining--;
    this.index++;
    return true;
  }

  /**
   * @param {number} target
   * @param {boolean} [skipPositions] - Step over the entries short of `target` without decoding their positions.
   *   The entry it stops on is still decoded in full.
   * @returns {boolean}
   */
  advance(target, skipPositions = false) {
    if (this.key >= target) return true;
    if (this.blockLastKey !== null) {
      let b = Math.max(this.block, 0);
      if (this.block < 0 || this.blockLastKey[this.block] < target) {
        while (b < this.blockLastKey.length && this.blockLastKey[b] < target) b++;
        if (b >= this.blockLastKey.length) {
          this.blockRemaining = 0;
          this.block = this.blockLastKey.length;
          return false;
        }
        this._loadBlock(b);
      }
    }
    if (!skipPositions) {
      while (this.next()) if (this.key >= target) return true;
      return false;
    }
    while (this.blockRemaining > 0 || (this.blockLastKey !== null && this.block + 1 < this.blockLastKey.length)) {
      if (this.blockRemaining === 0) this._loadBlock(this.block + 1);
      const r = /** @type {ByteReader} */ (this.reader);
      this.prevKey += r.varint();
      this.key = this.prevKey;
      const n = r.varint();
      this.blockRemaining--;
      this.index++;
      if (this.key >= target) {
        const values = new Array(n);
        let v = 0;
        for (let i = 0; i < n; i++) {
          v += r.varint();
          values[i] = v;
        }
        this.values = values;
        return true;
      }
      const { buf } = r;
      let at = r.at;
      let left = n;
      while (left > 0 && at < buf.length) if (buf[at++] < 0x80) left--;
      if (left > 0) throw new Error(`positions overrun at byte ${at} of ${buf.length}`);
      r.at = at;
    }
    return false;
  }
}

class PackedPostingsCursor extends PostingsCursor {
  /**
   * @param {{read: (offset: number, length: number) => Uint8Array}} file
   * @param {TermEntry} entry
   * @param {Int32Array} pageBase
   */
  constructor(file, entry, pageBase) {
    super(file, entry);
    this.pageBase = pageBase;
    // The block's arrays are plain because most lists are short and a typed array costs a buffer to allocate.
    /** @type {number[]} */
    this.keys = [];
    /** @type {number[]} */
    this.counts = [];
    /** @type {number[]} */
    this.posStart = [];
    /** @type {number[]} */
    this.deltas = [];
    this.m = 0;
    this.i = 0;
    this.buf = NO_BYTES;
    this.posAt = 0;
    this.group = 0;
    this.groups = 0;
    this.ready = 0;
    if (this.blockLastKey === null) this._decode(/** @type {ByteReader} */ (this.reader), this.count, -1);
  }

  /**
   * @param {ByteReader} r
   * @param {number} m
   * @param {number} prevKey - The key of the entry before the block, or -1 at the list's start.
   */
  _decode(r, m, prevKey) {
    if (this.keys.length < m) {
      this.keys = new Array(m);
      this.counts = new Array(m);
      this.posStart = new Array(m + 1);
    }
    const { buf } = r;
    const { keys, counts, pageBase } = this;
    if (m >= PACK_MIN) {
      unpack(buf, r.at + 1, m, buf[r.at], keys, 0);
      r.at += 1 + Math.ceil((m * buf[r.at]) / 8);
      unpack(buf, r.at + 1, m, buf[r.at], counts, 0);
      r.at += 1 + Math.ceil((m * buf[r.at]) / 8);
    } else {
      for (let i = 0; i < m; i++) keys[i] = r.varint();
      for (let i = 0; i < m; i++) counts[i] = r.varint();
    }
    const { posStart } = this;
    let ord = prevKey < 0 ? 0 : Math.floor(prevKey / PAGE_KEY_SPAN);
    let dense = prevKey < 0 ? -1 : pageBase[ord] + (prevKey % PAGE_KEY_SPAN);
    let total = 0;
    for (let i = 0; i < m; i++) {
      dense += keys[i] + 1;
      while (dense >= pageBase[ord + 1]) ord++;
      keys[i] = ord * PAGE_KEY_SPAN + (dense - pageBase[ord]);
      counts[i] += 1;
      posStart[i] = total;
      total += counts[i];
    }
    posStart[m] = total;
    if (this.deltas.length < total) this.deltas = new Array(Math.max(total, 2 * this.deltas.length));
    this.m = m;
    this.i = 0;
    this.buf = buf;
    this.posAt = r.at;
    this.group = 0;
    this.groups = Math.ceil(total / POST_BLOCK);
    this.ready = 0;
  }

  /** @param {number} b */
  _loadBlock(b) {
    const blockOffset = /** @type {number[]} */ (this.blockOffset);
    const start = this.blocksStart + blockOffset[b];
    const end = b + 1 < blockOffset.length ? this.blocksStart + blockOffset[b + 1] : this.blocksEnd;
    this.block = b;
    this._decode(new ByteReader(this.file.read(start, end - start)), Math.min(POST_BLOCK, this.count - b * POST_BLOCK),
      b > 0 ? /** @type {number[]} */ (this.blockLastKey)[b - 1] : -1);
  }

  /** @param {number} i */
  _take(i) {
    this.key = this.keys[i];
    const start = this.posStart[i];
    const end = this.posStart[i + 1];
    if (end > this.ready) {
      const { buf } = this;
      const total = this.posStart[this.m];
      // A skipped group ends before this entry's positions, so it is never the last group and always holds 128 values.
      while (this.group < this.groups && (this.group + 1) * POST_BLOCK <= start) {
        this.posAt += 1 + 16 * buf[this.posAt];
        this.group++;
      }
      while (this.group < this.groups && this.group * POST_BLOCK < end) {
        const from = this.group * POST_BLOCK;
        const n = Math.min(POST_BLOCK, total - from);
        if (n >= PACK_MIN) {
          unpack(buf, this.posAt + 1, n, buf[this.posAt], this.deltas, from);
          this.posAt += 1 + Math.ceil((n * buf[this.posAt]) / 8);
        } else {
          const r = new ByteReader(buf, this.posAt);
          for (let k = from; k < from + n; k++) this.deltas[k] = r.varint();
          this.posAt = r.at;
        }
        this.group++;
      }
      this.ready = Math.min(total, this.group * POST_BLOCK);
    }
    const { deltas } = this;
    const values = new Array(end - start);
    let v = 0;
    for (let k = start; k < end; k++) {
      v += deltas[k];
      values[k - start] = v;
    }
    this.values = values;
  }

  /** @returns {boolean} */
  next() {
    if (this.i >= this.m) {
      if (this.blockLastKey === null || this.block + 1 >= this.blockLastKey.length) return false;
      this._loadBlock(this.block + 1);
    }
    this._take(this.i++);
    return true;
  }

  /**
   * @param {number} target
   * @returns {boolean}
   */
  advance(target) {
    if (this.key >= target) return true;
    if (this.blockLastKey !== null && (this.block < 0 || this.blockLastKey[this.block] < target)) {
      let b = Math.max(this.block, 0);
      while (b < this.blockLastKey.length && this.blockLastKey[b] < target) b++;
      if (b >= this.blockLastKey.length) {
        this.block = this.blockLastKey.length;
        this.i = this.m;
        return false;
      }
      this._loadBlock(b);
    }
    let lo = this.i;
    let hi = this.m;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.keys[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    this.i = lo;
    while (this.next()) if (this.key >= target) return true;
    return false;
  }
}

/** @param {{size: number, read: (offset: number, length: number) => Uint8Array}} file */
export const openSegment = (file) => {
  const magic = utf8Decode(file.read(0, 4));
  if (magic !== 'SSG1' && magic !== 'SSG2') throw new Error(`not a search segment: ${JSON.stringify(magic)}`);
  const packed = magic === 'SSG2';
  const footer = new ByteReader(file.read(file.size - FOOTER_BYTES, FOOTER_BYTES));
  const docTableOff = footer.u32();
  const dictOff = footer.u32();
  footer.u32();
  const postOff = footer.u32();
  const sparseOff = footer.u32();
  const sparseLen = footer.u32();
  const termCount = footer.u32();
  const dt = new ByteReader(file.read(docTableOff, dictOff - docTableOff));
  const nDocs = dt.varint();
  /** @type {Array<{hash: string, pageCount: number, positions: number, pageLengths: Uint16Array}>} */
  const docs = [];
  /** @type {number[]} */
  const lengths = [];
  let hashChars = 0;
  for (let i = 0; i < nDocs; i++) {
    const hl = dt.varint();
    const hash = utf8Decode(dt.bytes(hl));
    hashChars += hash.length;
    const pageCount = dt.varint();
    let positions = 0;
    for (let p = 0; p < pageCount; p++) {
      const len = dt.varint();
      lengths.push(len);
      positions += len;
    }
    docs.push({
      hash, pageCount, positions, pageLengths: new Uint16Array(0),
    });
  }
  const pageLengths = Uint16Array.from(lengths);
  let pages = 0;
  for (const d of docs) {
    d.pageLengths = pageLengths.subarray(pages, pages + d.pageCount);
    pages += d.pageCount;
  }
  const pageBase = packed ? new Int32Array(nDocs + 1) : null;
  if (pageBase) for (let i = 0; i < nDocs; i++) pageBase[i + 1] = pageBase[i] + docs[i].pageCount;
  const sr = new ByteReader(file.read(sparseOff, sparseLen));
  const nBlocks = sr.varint();
  const firstAt = new Uint32Array(nBlocks + 1);
  const blockOff = new Uint32Array(nBlocks);
  const blockLen = new Uint32Array(nBlocks);
  const pool = new Uint8Array(sparseLen);
  let used = 0;
  for (let i = 0; i < nBlocks; i++) {
    const tl = sr.varint();
    pool.set(sr.bytes(tl), used);
    firstAt[i] = used;
    used += tl;
    blockOff[i] = sr.varint();
    blockLen[i] = sr.varint();
  }
  firstAt[nBlocks] = used;
  const firstTerms = pool.slice(0, used);
  let scratch = new Uint8Array(256);
  const residentBytes = 6 * HEAP_TYPED_ARRAY + firstTerms.byteLength + firstAt.byteLength + blockOff.byteLength + blockLen.byteLength
    + pageLengths.byteLength + scratch.byteLength + nDocs * (HEAP_OBJECT + HEAP_STRING + HEAP_VIEW + 8) + hashChars + 9 * HEAP_OBJECT
    + (pageBase ? HEAP_TYPED_ARRAY + pageBase.byteLength : 0);

  /** @param {number} b @param {Uint8Array} t */
  const compareFirst = (b, t) => {
    const from = firstAt[b];
    const len = firstAt[b + 1] - from;
    const n = Math.min(len, t.length);
    for (let i = 0; i < n; i++) if (firstTerms[from + i] !== t[i]) return firstTerms[from + i] - t[i];
    return len - t.length;
  };

  /** @param {Uint8Array} term */
  const blockFor = (term) => {
    let lo = 0;
    let hi = nBlocks - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (compareFirst(mid, term) <= 0) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  /**
   * @param {number} b
   * @param {(length: number, df: number, offset: number, len: number) => boolean} visit - The term is the first `length` bytes of `scratch`, which the next entry reuses.
   * @returns {boolean}
   */
  const scanBlock = (b, visit) => {
    const r = new ByteReader(file.read(blockOff[b], blockLen[b]));
    const n = r.varint();
    let postings = postOff + r.varint();
    const { buf } = r;
    for (let i = 0; i < n; i++) {
      const shared = i === 0 ? 0 : r.varint();
      const suffix = r.varint();
      if (shared + suffix > scratch.length) {
        const grown = new Uint8Array(Math.max(scratch.length * 2, shared + suffix));
        grown.set(scratch.subarray(0, shared));
        scratch = grown;
      }
      for (let q = 0; q < suffix; q++) scratch[shared + q] = buf[r.at + q];
      r.at += suffix;
      const df = r.varint();
      const len = r.varint();
      if (!visit(shared + suffix, df, postings, len)) return false;
      postings += len;
    }
    return true;
  };

  /** @param {number} length @param {Uint8Array} t @param {boolean} prefixOnly */
  const compareScratch = (length, t, prefixOnly) => {
    const n = Math.min(length, t.length);
    for (let i = 0; i < n; i++) if (scratch[i] !== t[i]) return scratch[i] - t[i];
    return prefixOnly && length >= t.length ? 0 : length - t.length;
  };

  return {
    encoding: packed ? 'packed' : 'varint',
    docs,
    pages,
    termCount,
    residentBytes,
    dictBytes: sparseLen,
    /**
     * @param {string} term
     * @returns {?TermEntry}
     */
    lookup(term) {
      if (!nBlocks) return null;
      const t = utf8Encode(term);
      if (compareFirst(0, t) > 0) return null;
      /** @type {?TermEntry} */
      let found = null;
      scanBlock(blockFor(t), (length, df, offset, len) => {
        const c = compareScratch(length, t, false);
        if (c === 0) {
          found = {
            term, df, offset, len,
          };
        }
        return c < 0;
      });
      return found;
    },
    /**
     * @param {string} prefix
     * @param {number} maxTerms
     * @param {number} maxBytes
     * @returns {{terms: TermEntry[], truncated: boolean, bytes: number}}
     */
    prefix(prefix, maxTerms, maxBytes) {
      /** @type {TermEntry[]} */
      const terms = [];
      let bytes = 0;
      let truncated = false;
      if (!nBlocks) return { terms, truncated, bytes };
      const p = utf8Encode(prefix);
      /** @type {Parameters<typeof scanBlock>[1]} */
      const take = (length, df, offset, len) => {
        const c = compareScratch(length, p, true);
        if (c < 0) return true;
        if (c > 0) return false;
        if (terms.length >= maxTerms || bytes + len > maxBytes) {
          truncated = true;
          return false;
        }
        terms.push({
          term: utf8Decode(scratch.subarray(0, length)), df, offset, len,
        });
        bytes += len;
        return true;
      };
      let more = true;
      for (let b = compareFirst(0, p) > 0 ? 0 : blockFor(p); b < nBlocks && more; b++) more = scanBlock(b, take);
      return { terms, truncated, bytes };
    },
    /** @returns {Generator<TermEntry & {bytes: Uint8Array}>} */
    * terms() {
      /** @type {Array<TermEntry & {bytes: Uint8Array}>} */
      let block = [];
      /** @type {Parameters<typeof scanBlock>[1]} */
      const collect = (length, df, offset, len) => {
        const bytes = scratch.slice(0, length);
        block.push({
          term: utf8Decode(bytes), bytes, df, offset, len,
        });
        return true;
      };
      for (let b = 0; b < nBlocks; b++) {
        block = [];
        scanBlock(b, collect);
        yield* block;
      }
    },
    /** @param {TermEntry} entry */
    postings(entry) {
      return pageBase ? new PackedPostingsCursor(file, entry, pageBase) : new PostingsCursor(file, entry);
    },
  };
};

/**
 * @param {ReturnType<typeof openSegment>} seg
 * @param {TermEntry} entry
 * @returns {PostingEntry[]}
 */
export const readAllPostings = (seg, entry) => {
  const c = seg.postings(entry);
  const out = [];
  while (c.next()) out.push({ key: c.key, values: c.values });
  return out;
};
