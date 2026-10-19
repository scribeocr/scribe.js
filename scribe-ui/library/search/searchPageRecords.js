import {
  ByteReader, ByteWriter, codec, utf8Decode, utf8Encode,
} from './searchBytes.js';

const MAGIC = utf8Encode('SPR2');
const METRIC_SCALE = 1000;
const OPACITY_SCALE = 100;
const SLOPE_SCALE = 10000;
const ANGLE_SCALE = 1000;
const FLAG_BOLD = 1;
const FLAG_ITALIC = 2;
const FLAG_SMALL_CAPS = 4;
const FLAG_SUP = 8;
const FLAG_DROPCAP = 16;
const FLAG_UNDERLINE = 32;
const FLAG_VISUAL = 64;

/** @param {number} v */
const zig = (v) => (v >= 0 ? v * 2 : -v * 2 - 1);
/** @param {number} v */
const unzig = (v) => (v % 2 === 0 ? v / 2 : -(v + 1) / 2);

/**
 * A page's word geometry and styles as the view block holds them.
 * The shape is the one the viewer's seed builds its page objects from.
 * @typedef {Object} PageView
 * @property {{width: number, height: number}} dims
 * @property {number} angle
 * @property {?string} textSource
 * @property {Array<{bbox: Box, type: ?string, headingLevel: ?number, parNum: ?number, marker: ?string}>} pars
 * @property {Array<ViewLine>} lines
 */
/**
 * @typedef {Object} ViewLine
 * @property {Box} bbox
 * @property {[number, number]} baseline
 * @property {?number} ascHeight
 * @property {?number} xHeight
 * @property {number} orientation
 * @property {?number} lineNum
 * @property {?string} pageNum
 * @property {?number} par - Index into the page's `pars`.
 * @property {?string} role
 * @property {Array<ViewWord>} words
 */
/**
 * @typedef {Object} ViewWord
 * @property {string} text
 * @property {Box} bbox
 * @property {string} id
 * @property {{font: ?string, size: ?number, bold: boolean, italic: boolean, smallCaps: boolean, sup: boolean, dropcap: boolean, underline: boolean, color: ?string, opacity: number}} style
 * @property {?string} lang
 * @property {number} conf
 * @property {boolean} visualCoords
 * @property {?string} footnoteParId
 */
/** @typedef {bbox} Box */

/**
 * @param {import('./searchTokenizer.js').PageInput} page
 * @returns {Uint8Array}
 */
const encodeView = (page) => {
  const w = new ByteWriter(4096);
  /** @type {Map<string, number>} */
  const table = new Map();
  /** @param {?string} s @returns {number} */
  const slot = (s) => {
    if (s == null || s === '') return 0;
    let i = table.get(s);
    if (i === undefined) {
      i = table.size;
      table.set(s, i);
    }
    return i + 1;
  };
  const words = page.lines.flatMap((line) => line.words);
  const boxes = [...page.pars.map((par) => par.bbox), ...page.lines.map((line) => line.bbox), ...words.map((word) => word.bbox)];
  const whole = Number.isInteger(page.dims.width) && Number.isInteger(page.dims.height)
    && boxes.every((b) => b && Number.isInteger(b.left) && Number.isInteger(b.top) && Number.isInteger(b.right) && Number.isInteger(b.bottom));
  const scale = whole ? 1 : METRIC_SCALE;
  /** @param {number} v */
  const fx = (v) => Math.round((v || 0) * scale);
  // The strings are gathered first, so the table precedes every field that cites it.
  const sourceSlot = slot(page.textSource);
  const parSlots = page.pars.map((par) => [slot(par.type), slot(par.marker)]);
  const lineSlots = page.lines.map((line) => [slot(line.role), slot(line.pageNum)]);
  const wordSlots = words.map((word) => [slot(word.font), slot(word.color), slot(word.lang), slot(word.id), slot(word.footnoteParId)]);
  w.varint(scale);
  w.varint(fx(page.dims.width));
  w.varint(fx(page.dims.height));
  w.varint(zig(Math.round((page.angle || 0) * ANGLE_SCALE)));
  w.varint(table.size);
  for (const s of table.keys()) {
    const b = utf8Encode(s);
    w.varint(b.length);
    w.bytes(b);
  }
  w.varint(sourceSlot);
  let pl = 0;
  let pt = 0;
  /** @param {Box} b */
  const box = (b) => {
    const l = fx(b.left);
    const t = fx(b.top);
    w.varint(zig(l - pl));
    w.varint(zig(t - pt));
    w.varint(Math.max(0, fx(b.right) - l));
    w.varint(Math.max(0, fx(b.bottom) - t));
    pl = l;
    pt = t;
  };
  w.varint(page.pars.length);
  page.pars.forEach((par, i) => {
    box(par.bbox);
    w.varint(parSlots[i][0]);
    w.varint(par.headingLevel || 0);
    w.varint(par.parNum || 0);
    w.varint(parSlots[i][1]);
  });
  w.varint(words.length);
  for (const word of words) box(word.bbox);
  w.varint(page.lines.length);
  page.lines.forEach((line, li) => {
    box(line.bbox);
    w.varint(zig(Math.round((line.baseline?.[0] || 0) * SLOPE_SCALE)));
    w.varint(zig(Math.round((line.baseline?.[1] || 0) * METRIC_SCALE)));
    w.varint(line.ascHeight == null ? 0 : Math.max(1, Math.round(line.ascHeight * METRIC_SCALE)));
    w.varint(line.xHeight == null ? 0 : Math.max(1, Math.round(line.xHeight * METRIC_SCALE)));
    w.varint(line.orientation || 0);
    w.varint(lineSlots[li][0]);
    w.varint(line.lineNum == null ? 0 : line.lineNum + 1);
    w.varint(lineSlots[li][1]);
    w.varint(line.par == null ? 0 : line.par + 1);
    w.varint(line.words.length);
  });
  for (const word of words) w.varint(word.t.length);
  for (const word of words) w.varint(word.size == null ? 0 : Math.max(1, Math.round(word.size * METRIC_SCALE)));
  for (const word of words) {
    w.varint((word.bold ? FLAG_BOLD : 0) | (word.italic ? FLAG_ITALIC : 0) | (word.smallCaps ? FLAG_SMALL_CAPS : 0) | (word.sup ? FLAG_SUP : 0)
      | (word.dropcap ? FLAG_DROPCAP : 0) | (word.underline ? FLAG_UNDERLINE : 0) | (word.visualCoords ? FLAG_VISUAL : 0));
  }
  for (let k = 0; k < 5; k++) for (const slots of wordSlots) w.varint(slots[k]);
  for (const word of words) w.varint(Math.round((word.opacity == null ? 1 : word.opacity) * OPACITY_SCALE));
  for (const word of words) w.varint(Math.max(0, Math.min(100, Math.round(word.conf || 0))));
  return w.result();
};

/**
 * @param {Array<?import('./searchTokenizer.js').TokenStream>} streams
 * @param {Array<?import('./searchTokenizer.js').PageInput>} pages - The pages the streams were tokenized from.
 * @returns {Promise<Uint8Array>}
 */
export const encodePageRecords = async (streams, pages) => {
  const tokenBlocks = await Promise.all(streams.map(async (page) => {
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
  const viewBlocks = await Promise.all(streams.map(async (stream, i) => {
    const page = pages[i];
    if (!stream || !stream.text || !page) return null;
    return codec(encodeView(page), 'deflate-raw', false);
  }));
  const out = new ByteWriter();
  out.bytes(MAGIC);
  out.u32(streams.length);
  const tokenTable = out.length;
  for (let i = 0; i <= streams.length; i++) out.u32(0);
  const viewTable = out.length;
  for (let i = 0; i <= streams.length; i++) out.u32(0);
  for (let i = 0; i < streams.length; i++) {
    out.u32At(tokenTable + i * 4, out.length);
    if (tokenBlocks[i]) out.bytes(tokenBlocks[i]);
  }
  out.u32At(tokenTable + streams.length * 4, out.length);
  for (let i = 0; i < streams.length; i++) {
    out.u32At(viewTable + i * 4, out.length);
    if (viewBlocks[i]) out.bytes(viewBlocks[i]);
  }
  out.u32At(viewTable + streams.length * 4, out.length);
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
 * @param {Uint8Array} block
 */
const decodeHead = (block) => {
  const r = new ByteReader(block);
  const scale = r.varint();
  const dims = { width: r.varint() / scale, height: r.varint() / scale };
  const angle = unzig(r.varint()) / ANGLE_SCALE;
  const count = r.varint();
  /** @type {string[]} */
  const table = new Array(count);
  for (let i = 0; i < count; i++) table[i] = utf8Decode(r.bytes(r.varint()));
  /** @param {number} s */
  const str = (s) => (s === 0 ? null : table[s - 1]);
  const textSource = str(r.varint());
  let pl = 0;
  let pt = 0;
  /** @returns {Box} */
  const box = () => {
    pl += unzig(r.varint());
    pt += unzig(r.varint());
    const wd = r.varint();
    const ht = r.varint();
    return {
      left: pl / scale, top: pt / scale, right: (pl + wd) / scale, bottom: (pt + ht) / scale,
    };
  };
  const parCount = r.varint();
  const pars = [];
  for (let i = 0; i < parCount; i++) {
    const bbox = box();
    pars.push({
      bbox, type: str(r.varint()), headingLevel: r.varint() || null, parNum: r.varint() || null, marker: str(r.varint()),
    });
  }
  const wordCount = r.varint();
  /** @type {Box[]} */
  const boxes = new Array(wordCount);
  for (let i = 0; i < wordCount; i++) boxes[i] = box();
  return {
    r, str, box, dims, angle, textSource, pars, boxes,
  };
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
  const { dims, boxes } = decodeHead(block);
  return { dims, boxes };
};

/**
 * @param {{size: number, read: (offset: number, length: number) => Uint8Array}} file
 * @param {number} pageN
 * @param {string} text - The text of the page's `PageRecord`, which each word's text is cut from.
 * @returns {Promise<?PageView>}
 */
export const readPageView = async (file, pageN, text) => {
  const head = new ByteReader(file.read(0, 8), 4);
  const pageCount = head.u32();
  if (pageN < 0 || pageN >= pageCount) return null;
  const block = await readBlock(file, pageN, 8 + 4 * (pageCount + 1));
  if (!block) return null;
  const {
    r, str, box, dims, angle, textSource, pars, boxes,
  } = decodeHead(block);
  const lineCount = r.varint();
  /**
   * @type {Array<{bbox: Box, baseline: [number, number], ascHeight: ?number, xHeight: ?number, orientation: number, role: ?string, lineNum: ?number,
   *   pageNum: ?string, par: ?number, wordCount: number}>}
   */
  const lineHeads = [];
  for (let li = 0; li < lineCount; li++) {
    const bbox = box();
    const slope = unzig(r.varint()) / SLOPE_SCALE;
    const offset = unzig(r.varint()) / METRIC_SCALE;
    const asc = r.varint();
    const xh = r.varint();
    const orientation = r.varint();
    const role = str(r.varint());
    const lineNum = r.varint();
    const pageNum = str(r.varint());
    const par = r.varint();
    const wordCount = r.varint();
    lineHeads.push({
      bbox,
      baseline: [slope, offset],
      ascHeight: asc === 0 ? null : asc / METRIC_SCALE,
      xHeight: xh === 0 ? null : xh / METRIC_SCALE,
      orientation,
      role,
      lineNum: lineNum === 0 ? null : lineNum - 1,
      pageNum,
      par: par === 0 ? null : par - 1,
      wordCount,
    });
  }
  const n = boxes.length;
  /** @param {(i: number) => number} read */
  const column = (read) => {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = read(i);
    return out;
  };
  const lengths = column(() => r.varint());
  const sizes = column(() => r.varint());
  const flags = column(() => r.varint());
  const fonts = column(() => str(r.varint()));
  const colors = column(() => str(r.varint()));
  const langs = column(() => str(r.varint()));
  const ids = column(() => str(r.varint()));
  const footnotes = column(() => str(r.varint()));
  const opacities = column(() => r.varint() / OPACITY_SCALE);
  const confs = column(() => r.varint());
  /** @type {Array<ViewLine>} */
  const lines = [];
  let at = 0;
  let k = 0;
  lineHeads.forEach((lh, li) => {
    if (li > 0) at += 1;
    /** @type {Array<ViewWord>} */
    const words = [];
    for (let wi = 0; wi < lh.wordCount; wi++, k++) {
      if (wi > 0) at += 1;
      const f = flags[k];
      words.push({
        text: text.slice(at, at + lengths[k]),
        bbox: boxes[k],
        id: ids[k] ?? `word_${pageN + 1}_${li + 1}_${wi + 1}`,
        style: {
          font: fonts[k],
          size: sizes[k] === 0 ? null : sizes[k] / METRIC_SCALE,
          bold: !!(f & FLAG_BOLD),
          italic: !!(f & FLAG_ITALIC),
          smallCaps: !!(f & FLAG_SMALL_CAPS),
          sup: !!(f & FLAG_SUP),
          dropcap: !!(f & FLAG_DROPCAP),
          underline: !!(f & FLAG_UNDERLINE),
          color: colors[k],
          opacity: opacities[k],
        },
        lang: langs[k],
        conf: confs[k],
        visualCoords: !!(f & FLAG_VISUAL),
        footnoteParId: footnotes[k],
      });
      at += lengths[k];
    }
    lines.push({
      bbox: lh.bbox, baseline: lh.baseline, ascHeight: lh.ascHeight, xHeight: lh.xHeight, orientation: lh.orientation, role: lh.role, lineNum: lh.lineNum, pageNum: lh.pageNum, par: lh.par, words,
    });
  });
  return {
    dims, angle, textSource, pars, lines,
  };
};

/**
 * @param {{size: number, read: (offset: number, length: number) => Uint8Array}} file
 */
export const pageRecordCount = (file) => new ByteReader(file.read(4, 4)).u32();
