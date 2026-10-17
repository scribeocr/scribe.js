import {
  ByteReader, ByteWriter, codec, utf8Decode, utf8Encode,
} from './searchBytes.js';

const MAGIC = utf8Encode('SPR1');

/**
 * @param {Array<?import('./searchTokenizer.js').TokenStream>} pages
 * @returns {Promise<Uint8Array>}
 */
export const encodePageRecords = async (pages) => {
  const blocks = await Promise.all(pages.map(async (page) => {
    if (!page || !page.text) return null;
    const w = new ByteWriter(page.text.length * 2 + 64);
    const text = utf8Encode(page.text);
    w.varint(text.length);
    w.bytes(text);
    w.varint(page.terms.length);
    let lastPos = 0;
    let lastStart = 0;
    let lastWord = 0;
    for (let i = 0; i < page.terms.length; i++) {
      w.varint(((page.pos[i] - lastPos) << 1) | page.span[i]);
      lastPos = page.pos[i];
      w.varint(page.charStart[i] - lastStart);
      lastStart = page.charStart[i];
      w.varint(page.charEnd[i] - page.charStart[i]);
      w.varint(page.wordIndex[i] - lastWord);
      lastWord = page.wordIndex[i];
    }
    return codec(w.result(), 'deflate-raw', false);
  }));
  const out = new ByteWriter();
  out.bytes(MAGIC);
  out.u32(pages.length);
  const tableAt = out.length;
  for (let i = 0; i <= pages.length; i++) out.u32(0);
  for (let i = 0; i < pages.length; i++) {
    out.u32At(tableAt + i * 4, out.length);
    if (blocks[i]) out.bytes(blocks[i]);
  }
  out.u32At(tableAt + pages.length * 4, out.length);
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
 * @returns {Promise<?PageRecord>}
 */
export const readPageRecord = async (file, pageN) => {
  const head = new ByteReader(file.read(0, 8), 4);
  const pageCount = head.u32();
  if (pageN < 0 || pageN >= pageCount) return null;
  const table = new ByteReader(file.read(8 + pageN * 4, 8));
  const start = table.u32();
  const end = table.u32();
  if (end <= start) return null;
  const r = new ByteReader(await codec(file.read(start, end - start), 'deflate-raw', true));
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
 */
export const pageRecordCount = (file) => new ByteReader(file.read(4, 4)).u32();
