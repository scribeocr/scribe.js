import {
  ByteReader, ByteWriter, codec, utf8Decode, utf8Encode,
} from './searchBytes.js';

const MAGIC = utf8Encode('SPR3');
const METRIC_SCALE = 1000;

/** @param {number} v */
const zig = (v) => (v >= 0 ? v * 2 : -v * 2 - 1);
/** @param {number} v */
const unzig = (v) => (v % 2 === 0 ? v / 2 : -(v + 1) / 2);

/** @typedef {bbox} Box */

/**
 * Encode one page's token stream and word boxes into deflated page-record blocks.
 * @param {import('./searchTokenizer.js').TokenStream} stream
 * @param {?import('./searchTokenizer.js').PageInput} page
 * @returns {Promise<{tokens: ?Uint8Array, boxes: ?Uint8Array}>} Both null for a page without text.
 */
export const encodePageBlocks = async (stream, page) => {
  if (!stream.text || !page) return { tokens: null, boxes: null };
  const w = new ByteWriter(stream.text.length * 2 + 64);
  const text = utf8Encode(stream.text);
  w.varint(text.length);
  w.bytes(text);
  w.varint(stream.terms.length);
  let lastPos = 0;
  let lastStart = 0;
  let lastWord = 0;
  for (let i = 0; i < stream.terms.length; i++) {
    w.varint(((stream.pos[i] - lastPos) << 1) | stream.span[i]);
    lastPos = stream.pos[i];
    w.varint(stream.charStart[i] - lastStart);
    lastStart = stream.charStart[i];
    w.varint(stream.charEnd[i] - stream.charStart[i]);
    w.varint(stream.wordIndex[i] - lastWord);
    lastWord = stream.wordIndex[i];
  }
  const words = page.lines.flatMap((line) => line.words);
  const whole = Number.isInteger(page.dims.width) && Number.isInteger(page.dims.height)
    && words.every(({ bbox: b }) => b && Number.isInteger(b.left) && Number.isInteger(b.top) && Number.isInteger(b.right) && Number.isInteger(b.bottom));
  const scale = whole ? 1 : METRIC_SCALE;
  /** @param {number} v */
  const fx = (v) => Math.round((v || 0) * scale);
  const b = new ByteWriter(words.length * 6 + 16);
  b.varint(scale);
  b.varint(fx(page.dims.width));
  b.varint(fx(page.dims.height));
  b.varint(words.length);
  let pl = 0;
  let pt = 0;
  for (const { bbox } of words) {
    const l = fx(bbox.left);
    const t = fx(bbox.top);
    b.varint(zig(l - pl));
    b.varint(zig(t - pt));
    b.varint(Math.max(0, fx(bbox.right) - l));
    b.varint(Math.max(0, fx(bbox.bottom) - t));
    pl = l;
    pt = t;
  }
  return { tokens: await codec(w.result(), 'deflate-raw', false), boxes: await codec(b.result(), 'deflate-raw', false) };
};

/**
 * Join encoded page blocks into a page-record file.
 * @param {Array<{tokens: ?Uint8Array, boxes: ?Uint8Array}>} pages
 * @returns {Uint8Array}
 */
export const joinPageBlocks = (pages) => {
  const out = new ByteWriter();
  out.bytes(MAGIC);
  out.u32(pages.length);
  const tokenTable = out.length;
  for (let i = 0; i <= pages.length; i++) out.u32(0);
  const boxesTable = out.length;
  for (let i = 0; i <= pages.length; i++) out.u32(0);
  for (let i = 0; i < pages.length; i++) {
    out.u32At(tokenTable + i * 4, out.length);
    const { tokens } = pages[i];
    if (tokens) out.bytes(tokens);
  }
  out.u32At(tokenTable + pages.length * 4, out.length);
  for (let i = 0; i < pages.length; i++) {
    out.u32At(boxesTable + i * 4, out.length);
    const { boxes } = pages[i];
    if (boxes) out.bytes(boxes);
  }
  out.u32At(boxesTable + pages.length * 4, out.length);
  return out.result();
};

/**
 * @typedef {Object} PageRecord
 * @property {string} text
 * @property {number[]} pos
 * @property {number[]} span
 * @property {number[]} charStart
 * @property {number[]} charEnd
 * @property {number[]} wordIndex
 */

/**
 * @param {{size: number, read: (offset: number, length: number) => Uint8Array}} file
 * @param {number} pageN
 * @param {number} tableAt
 * @returns {Promise<?Uint8Array>}
 */
const readBlock = async (file, pageN, tableAt) => {
  const table = new ByteReader(file.read(tableAt + pageN * 4, 8));
  const start = table.u32();
  const end = table.u32();
  if (end <= start) return null;
  return codec(file.read(start, end - start), 'deflate-raw', true);
};

/**
 * @param {{size: number, read: (offset: number, length: number) => Uint8Array}} file
 * @param {number} pageN
 * @returns {Promise<?PageRecord>}
 */
export const readPageRecord = async (file, pageN) => {
  const head = new ByteReader(file.read(0, 8), 4);
  const pageCount = head.u32();
  if (pageN < 0 || pageN >= pageCount) return null;
  const block = await readBlock(file, pageN, 8);
  if (!block) return null;
  const r = new ByteReader(block);
  const textLen = r.varint();
  const text = utf8Decode(r.bytes(textLen));
  const n = r.varint();
  /** @type {PageRecord} */
  const rec = {
    text, pos: new Array(n), span: new Array(n), charStart: new Array(n), charEnd: new Array(n), wordIndex: new Array(n),
  };
  let lastPos = 0;
  let lastStart = 0;
  let lastWord = 0;
  for (let i = 0; i < n; i++) {
    const v = r.varint();
    lastPos += v >>> 1;
    rec.pos[i] = lastPos;
    rec.span[i] = v & 1;
    lastStart += r.varint();
    rec.charStart[i] = lastStart;
    rec.charEnd[i] = lastStart + r.varint();
    lastWord += r.varint();
    rec.wordIndex[i] = lastWord;
  }
  return rec;
};

/**
 * @param {{size: number, read: (offset: number, length: number) => Uint8Array}} file
 * @param {number} pageN
 * @returns {Promise<?{dims: {width: number, height: number}, boxes: Box[]}>}
 */
export const readPageBoxes = async (file, pageN) => {
  const head = new ByteReader(file.read(0, 8), 4);
  const pageCount = head.u32();
  if (pageN < 0 || pageN >= pageCount) return null;
  const block = await readBlock(file, pageN, 8 + 4 * (pageCount + 1));
  if (!block) return null;
  const r = new ByteReader(block);
  const scale = r.varint();
  const dims = { width: r.varint() / scale, height: r.varint() / scale };
  /** @type {Box[]} */
  const boxes = new Array(r.varint());
  let pl = 0;
  let pt = 0;
  for (let i = 0; i < boxes.length; i++) {
    pl += unzig(r.varint());
    pt += unzig(r.varint());
    const wd = r.varint();
    const ht = r.varint();
    boxes[i] = {
      left: pl / scale, top: pt / scale, right: (pl + wd) / scale, bottom: (pt + ht) / scale,
    };
  }
  return { dims, boxes };
};

/**
 * @param {{size: number, read: (offset: number, length: number) => Uint8Array}} file
 */
export const pageRecordCount = (file) => new ByteReader(file.read(4, 4)).u32();
