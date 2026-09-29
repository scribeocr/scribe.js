/**
 * Content-stream patches for native text edits.
 * The parser, the renderer, and the PDF exporter all apply the same patches to the same decoded text, so what an edit shows is what it writes.
 */

import { formatPdfNumber, serializeContentToken } from './contentStream.js';
import { decodeTextCodes } from './pdfPrimitives.js';

/** @typedef {import('./parsePdfDoc.js').PositionedChar} PositionedChar */
/** @typedef {import('./parsePdfDoc.js').GlyphOpMap} GlyphOpMap */
/** @typedef {import('./parsePdfDoc.js').ShowOp} ShowOp */
/** @typedef {import('./parsePdfDoc.js').PageFont} PageFont */
/** @typedef {import('./parsePdfUtils.js').PDFToken} PDFToken */

/**
 * @typedef {{ start: number, end: number, origStart: number, origEnd: number, rec: ?TextPatch, editIdx: number }} PatchSegment
 *   One stretch of a patched stream.
 *   `rec` is null for verbatim text.
 */

/**
 * Whether a record patches `stream`.
 * @param {ContentEdit} rec
 * @param {TextPatchStream} stream
 */
export function recordTargets(rec, stream) {
  if (rec.type !== 'patchText') return false;
  if (stream.kind === 'page') return rec.stream.kind === 'page';
  return rec.stream.kind === 'form' && rec.stream.path === stream.path;
}

/**
 * Apply every record that patches `stream` to the stream's decoded text.
 * @param {string} text
 * @param {?Array<ContentEdit>} records
 * @param {TextPatchStream} stream
 * @returns {{ text: string, segments: Array<PatchSegment> }}
 */
export function applyTextPatchRecords(text, records, stream) {
  /** @type {Array<{ start: number, end: number, text: string, rec: TextPatch, editIdx: number }>} */
  const edits = [];
  for (const rec of records || []) {
    if (!recordTargets(rec, stream)) continue;
    rec.edits.forEach((e, i) => edits.push({
      start: e.start, end: e.end, text: e.text, rec, editIdx: i,
    }));
  }
  edits.sort((a, b) => a.start - b.start);
  /** @type {Array<string>} */
  const out = [];
  /** @type {Array<PatchSegment>} */
  const segments = [];
  let pos = 0;
  let outLen = 0;
  for (const e of edits) {
    if (e.start < pos || e.end > text.length) throw new Error('Text patches overlap or run past the stream.');
    if (e.start > pos) {
      const kept = text.slice(pos, e.start);
      out.push(kept);
      segments.push({
        start: outLen, end: outLen + kept.length, origStart: pos, origEnd: e.start, rec: null, editIdx: -1,
      });
      outLen += kept.length;
    }
    out.push(e.text);
    segments.push({
      start: outLen, end: outLen + e.text.length, origStart: e.start, origEnd: e.end, rec: e.rec, editIdx: e.editIdx,
    });
    outLen += e.text.length;
    pos = e.end;
  }
  if (pos < text.length || segments.length === 0) {
    const kept = text.slice(pos);
    out.push(kept);
    segments.push({
      start: outLen, end: outLen + kept.length, origStart: pos, origEnd: text.length, rec: null, editIdx: -1,
    });
  }
  return { text: out.join(''), segments };
}

/**
 * The segment of a patched stream that holds a patched offset, or null past the end.
 * @param {Array<PatchSegment>} segments
 * @param {number} at
 */
export const segmentAt = (segments, at) => segments.find((sg) => at >= sg.start && at < sg.end) || null;

/**
 * Apply a page's records to its /Contents entries.
 * @param {Array<string>} entries - The decoded /Contents entries, in order.
 * @param {?Array<ContentEdit>} records
 * @returns {{ text: string, segments: Array<PatchSegment>, boundaries: Array<number> }}
 *   `boundaries` holds the offset in `text` at which each entry after the first begins.
 *   A boundary that fell inside patched text moves to the start of that patch's replacement.
 */
export function patchPageContents(entries, records) {
  const { text, segments } = applyTextPatchRecords(entries.join('\n'), records, { kind: 'page' });
  const boundaries = [];
  for (let i = 0, acc = 0; i < entries.length - 1; i++) {
    acc += entries[i].length + 1;
    const seg = segments.find((sg) => acc >= sg.origStart && acc < sg.origEnd);
    boundaries.push(!seg ? text.length : (seg.rec ? seg.start : seg.start + (acc - seg.origStart)));
  }
  return { text, segments, boundaries };
}

/**
 * Whether any record patches `stream`.
 * @param {?Array<ContentEdit>} records
 * @param {TextPatchStream} stream
 */
export function textPatchesTarget(records, stream) {
  return !!records && records.some((rec) => recordTargets(rec, stream));
}

/** @param {number} v */
const round3 = (v) => Math.round(v * 1000) / 1000;

/** The stroke width a bold toggle gives a word that its font draws light, as a fraction of the font size. */
export const FAUX_BOLD_STROKE_EM = 0.025;
/** The shear an italic toggle gives a word that its font draws upright. */
export const FAUX_OBLIQUE_SKEW = 0.25;

/**
 * Find each requested word among a glyph-op map's words.
 * A word is matched by its glyph pens.
 * The id only breaks a tie between coincident twins.
 * @param {GlyphOpMap} glyphOpMap
 * @param {Array<TextEditWordSpec>} specs
 * @returns {Array<?LocatedWord>}
 */
export function locateWords(glyphOpMap, specs) {
  /** @type {Map<number, Array<[string, Array<PositionedChar>]>>} */
  const byFirstPen = new Map();
  for (const [id, chars] of glyphOpMap.words) {
    if (chars.length === 0) continue;
    const key = Math.round(chars[0].x * 1000);
    let list = byFirstPen.get(key);
    if (!list) { list = []; byFirstPen.set(key, list); }
    list.push([id, chars]);
  }
  return specs.map((spec) => {
    const pens = spec.penX;
    if (!pens || pens.length === 0) return null;
    const k = Math.round(pens[0] * 1000);
    const candidates = [k - 1, k, k + 1].flatMap((key) => byFirstPen.get(key) || []).filter(([, chars]) => chars.length === pens.length
      && chars.every((c, i) => Math.abs(round3(c.x) - pens[i]) <= 0.0015)
      && (spec.baselineY === undefined || Math.abs(round3(chars[0].y) - spec.baselineY) <= 0.0015));
    if (candidates.length === 0) return null;
    const exact = candidates.find(([id]) => id === spec.id) || candidates[0];
    return { id: spec.id, parseId: exact[0], chars: exact[1] };
  });
}

/**
 * A TJ number that moves the pen `d` text-space units along the text axis.
 * @param {ShowOp} op
 * @param {number} d
 */
const spacerFor = (op, d) => -(d * 1000) / (op.fontSize * (op.tz / 100));

/**
 * Codes to draw, as an insertion into a show operator.
 * @typedef {Object} CodeInsert
 * @property {string} hex - The codes, in hex.
 * @property {number} adv - The codes' advance, in text space.
 * @property {number} [gap] - A spacer drawn before the codes, in text space.
 * @property {number} [shift] - A user-space shift along the line from the anchor glyph's pen. Applies only to `insertBefore`.
 * @property {Array<{ hex: string, adv: number, gap?: number }>} [glyphs] - The codes one glyph at a time, each after its own spacer,
 *   for an operator whose character spacing is not the word's letter spacing.
 * @property {Array<CodeInsert>} [segments] - Inserts emitted in order, for a word drawn in more than one font.
 * @property {Object} [wrap]
 * @property {Array<string>} wrap.before - Operators that set the codes' style or font.
 * @property {Array<string>} wrap.after - Operators that restore the style or font.
 * @property {number} [wrap.lean] - A shear added to the text matrix for these codes only.
 */

/**
 * @typedef {Object} GlyphAction
 * @property {boolean} [drop] - Remove the glyph.
 * @property {CodeInsert} [replace] - Codes drawn in place of this glyph and of the dropped glyphs after it.
 * @property {CodeInsert} [insertBefore] - Codes drawn before this glyph.
 * @property {CodeInsert} [insertAfter] - Codes drawn after this glyph.
 * @property {number} [shift] - Moves the glyph, or its replacement, this far from its own pen, in user space along the line.
 * @property {Array<string>} [before] - Operators emitted before the glyph, outside any TJ.
 * @property {Array<string>} [after] - Operators emitted after the glyph, outside any TJ.
 * @property {boolean} [setsPen] - `before` ends with a text matrix at the glyph's target.
 * @property {boolean} [resetsPen] - `after` restores the line matrix.
 */

/**
 * Rewrite one show operator with per-glyph actions.
 * Text after a dropped, replaced or inserted run keeps its position unless an action moves it.
 * @param {ShowOp} op
 * @param {Array<PDFToken>} tokens - The stream's tokens.
 * @param {Map<string, GlyphAction>} actions - Keyed by `${elem}:${byte}`.
 * @param {Map<string, [number, number, number]>} pens - Text-space pen and advance of every glyph of the operator, same keys.
 * @returns {string} The operator's replacement text.
 */
export function rewriteShowOperator(op, tokens, actions, pens) {
  /** @type {Array<PDFToken>} */
  const operands = [];
  for (let i = op.tokIdx - 1; i >= 0 && tokens[i].type !== 'operator'; i--) operands.unshift(tokens[i]);
  const strTok = operands[operands.length - 1];
  if (!strTok) return '';
  /** @type {Array<PDFToken>} */
  const elems = op.op === 'TJ' ? (strTok.type === 'array' ? strTok.value : []) : [strTok];
  const isCID = !!(op.font && (op.font.type0 || op.font.isCIDFont));
  const csRanges = op.font ? op.font.codespaceRanges : null;
  const [a, b] = op.tm;
  const axisLen = Math.hypot(a, b) || 1;
  const ux = a / axisLen;
  const uy = b / axisLen;

  /** @type {Array<string>} */
  const out = [];
  if (op.op === "'") out.push('T*');
  if (op.op === '"' && operands.length >= 3) out.push(`${serializeContentToken(operands[operands.length - 3])} Tw ${serializeContentToken(operands[operands.length - 2])} Tc T*`);

  /** @type {Array<string>} */
  let parts = [];
  let hex = '';
  const flushHex = () => {
    if (hex) {
      parts.push(`<${hex}>`);
      hex = '';
    }
  };
  const flushTJ = () => {
    flushHex();
    if (parts.length > 0) out.push(`[${parts.join(' ')}] TJ`);
    parts = [];
  };
  /** @type {?[number, number]} */
  let rwPen = null;
  let inDrop = false;
  const advanceBy = (/** @type {number} */ adv) => { if (rwPen) rwPen = [rwPen[0] + adv * a, rwPen[1] + adv * b]; };
  const targetOf = (/** @type {[number, number]} */ at, /** @type {number|undefined} */ shift) => (shift ? /** @type {[number, number]} */ ([at[0] + shift * ux, at[1] + shift * uy]) : at);
  const moveTo = (/** @type {[number, number]} */ target) => {
    if (!rwPen) { rwPen = target; return; }
    const den = op.tm[0] * op.tm[0] + op.tm[1] * op.tm[1];
    const d = den > 0 ? ((target[0] - rwPen[0]) * op.tm[0] + (target[1] - rwPen[1]) * op.tm[1]) / den : 0;
    if (Math.abs(d) > 1e-7) { flushHex(); parts.push(formatPdfNumber(spacerFor(op, d))); }
    rwPen = target;
  };
  const emitInsert = (/** @type {CodeInsert} */ ins) => {
    if (ins.gap) { flushHex(); parts.push(formatPdfNumber(spacerFor(op, ins.gap))); advanceBy(ins.gap); }
    const wrap = ins.wrap;
    if (wrap && (wrap.before.length > 0 || wrap.lean)) {
      flushTJ();
      out.push(...wrap.before);
      if (wrap.lean && rwPen) {
        const [ta, tb, tc, td] = op.tm;
        out.push(`${formatPdfNumber(ta)} ${formatPdfNumber(tb)} ${formatPdfNumber(tc + wrap.lean * ta)} ${formatPdfNumber(td + wrap.lean * tb)} ${formatPdfNumber(rwPen[0])} ${formatPdfNumber(rwPen[1])} Tm`);
      }
    }
    if (ins.segments) {
      for (const seg of ins.segments) emitInsert(seg);
    } else if (ins.glyphs) {
      for (const g of ins.glyphs) {
        if (g.gap) { flushHex(); parts.push(formatPdfNumber(spacerFor(op, g.gap))); advanceBy(g.gap); }
        flushHex();
        hex = g.hex;
        flushHex();
        advanceBy(g.adv);
      }
    } else {
      flushHex();
      hex = ins.hex;
      flushHex();
      advanceBy(ins.adv);
    }
    if (wrap && (wrap.after.length > 0 || wrap.lean)) {
      flushTJ();
      if (wrap.lean) {
        const [ta, tb, tc, td] = op.tm;
        out.push(`${formatPdfNumber(ta)} ${formatPdfNumber(tb)} ${formatPdfNumber(tc)} ${formatPdfNumber(td)} ${formatPdfNumber(op.tlmAfter[4])} ${formatPdfNumber(op.tlmAfter[5])} Tm`);
        rwPen = [op.tlmAfter[4], op.tlmAfter[5]];
      }
      out.push(...wrap.after);
    }
  };

  for (let ei = 0; ei < elems.length; ei++) {
    const elem = elems[ei];
    if (elem.type === 'number') {
      if (inDrop) continue;
      flushHex();
      parts.push(formatPdfNumber(elem.value));
      advanceBy(-elem.value / 1000 * op.fontSize * (op.tz / 100));
      continue;
    }
    if (elem.type !== 'string' && elem.type !== 'hexstring') continue;
    let str = elem.value;
    if (elem.type === 'hexstring') {
      str = '';
      for (let i = 0; i + 1 <= elem.value.length; i += 2) str += String.fromCharCode(parseInt(elem.value.substring(i, i + 2), 16));
    }
    let byte = 0;
    for (const { charCode, numBytes } of decodeTextCodes(str, isCID ? csRanges : null, isCID ? 2 : 1)) {
      const key = `${ei}:${byte}`;
      byte += numBytes;
      const action = actions.get(key);
      const pen = pens.get(key) || null;
      const at = pen ? /** @type {[number, number]} */ ([pen[0], pen[1]]) : null;
      if (rwPen === null && at) rwPen = at;
      if (action && action.insertBefore && at) {
        moveTo(targetOf(at, action.insertBefore.shift));
        emitInsert(action.insertBefore);
      }
      if (action && action.replace) {
        if (at) moveTo(targetOf(at, action.shift));
        if (action.before && action.before.length > 0) {
          flushTJ();
          out.push(...action.before);
          if (action.setsPen && at) rwPen = targetOf(at, action.shift);
        }
        emitInsert(action.replace);
        if (action.after && action.after.length > 0) {
          const left = rwPen;
          flushTJ();
          out.push(...action.after);
          if (action.resetsPen && left) { rwPen = [op.tlmAfter[4], op.tlmAfter[5]]; moveTo(left); }
        }
        if (action.insertAfter) emitInsert(action.insertAfter);
        inDrop = true;
        continue;
      }
      if (action && action.drop) {
        inDrop = true;
        continue;
      }
      inDrop = false;
      const target = at ? targetOf(at, action && action.shift) : null;
      if (target && !(action && action.setsPen)) moveTo(target);
      if (action && action.before && action.before.length > 0) {
        flushTJ();
        out.push(...action.before);
        if (action.setsPen && target) rwPen = target;
      }
      hex += charCode.toString(16).padStart(numBytes * 2, '0');
      advanceBy(pen ? pen[2] : 0);
      if (action && action.after && action.after.length > 0) {
        const left = rwPen;
        flushTJ();
        out.push(...action.after);
        if (action.resetsPen && left) { rwPen = [op.tlmAfter[4], op.tlmAfter[5]]; moveTo(left); }
      }
      if (action && action.insertAfter) emitInsert(action.insertAfter);
    }
  }
  moveTo([op.tmAfter[4], op.tmAfter[5]]);
  flushTJ();
  return out.join('\n');
}

/**
 * The planned rewrite of one show operator.
 * @typedef {{ op: ShowOp, actions: Map<string, GlyphAction>, pens: Map<string, [number, number, number]> }} OpPlan
 */

/**
 * A code the page's font draws a text with.
 * `canon`, when set, is the text a word records for the code in place of its table key.
 * @typedef {{ code: number, nBytes: number, advEm: number, used: boolean, canon?: string }} FontCode
 */

/**
 * The byte width of a code in a font's strings.
 * @param {PageFont} fontObj
 * @param {number} code
 */
function codeBytes(fontObj, code) {
  if (!(fontObj.type0 || fontObj.isCIDFont)) return 1;
  const ranges = fontObj.codespaceRanges;
  if (ranges) {
    for (const r of ranges) {
      if (r.bytes === 1 && code <= 255 && code >= r.low && code <= r.high) return 1;
      if (r.bytes === 2 && code >= r.low && code <= r.high) return 2;
    }
  }
  return 2;
}

/**
 * The user-space point where a show operator draws a glyph whose text-space pen is `(tx, ty)`.
 * @param {ShowOp} op
 * @param {number} tx
 * @param {number} ty
 * @returns {[number, number]}
 */
export function drawnPen(op, tx, ty) {
  const ox = op.tm[2] * op.trise + tx;
  const oy = op.tm[3] * op.trise + ty;
  return [op.ctm[0] * ox + op.ctm[2] * oy + op.ctm[4], op.ctm[1] * ox + op.ctm[3] * oy + op.ctm[5]];
}

/**
 * Whether a glyph lies inside the region its operator paints.
 * That region is the page box cut down by the clips and form boxes in force.
 * @param {ShowOp} op
 * @param {NonNullable<PositionedChar['_src']>} src
 */
export function glyphVisible(op, src) {
  const box = op.visible;
  if (!box) return true;
  const tol = 0.5;
  // An edit moves glyphs only along the line, so the span from pen to advance end is all it can push out of view.
  for (const u of [0, src.adv]) {
    const [px, py] = drawnPen(op, src.tx + u * op.tm[0], src.ty + u * op.tm[1]);
    if (px < box[0] - tol || px > box[2] + tol || py < box[1] - tol || py > box[3] + tol) return false;
  }
  return true;
}

/**
 * Positions along and across the text axis of a glyph's operator, in the parse's pixels.
 * They place every glyph the streams drew on that one axis, including the glyphs the parse dropped and the rotated survivors it remapped into a frame of their own.
 * `alongAt` and `perpAt` place a `drawnPen` point.
 * @param {GlyphOpMap} glyphOpMap
 * @param {PositionedChar} c0 - The glyph whose operator gives the axis.
 */
function penAxis(glyphOpMap, c0) {
  const op = glyphOpMap.ops[c0._src.op];
  const ax = op.ctm[0] * op.tm[0] + op.ctm[2] * op.tm[1];
  const ay = op.ctm[1] * op.tm[0] + op.ctm[3] * op.tm[1];
  const len = Math.hypot(ax, ay) || 1;
  const ux = ax / len;
  const uy = ay / len;
  const px = glyphOpMap.scale;
  const alongAt = (/** @type {number} */ x, /** @type {number} */ y) => (x * ux + y * uy) * px;
  const perpAt = (/** @type {number} */ x, /** @type {number} */ y) => (y * ux - x * uy) * px;
  return {
    alongAt,
    perpAt,
    along: (/** @type {PositionedChar} */ c) => {
      const [x, y] = drawnPen(glyphOpMap.ops[c._src.op], c._src.tx, c._src.ty);
      return alongAt(x, y);
    },
    perp: (/** @type {PositionedChar} */ c) => {
      const [x, y] = drawnPen(glyphOpMap.ops[c._src.op], c._src.tx, c._src.ty);
      return perpAt(x, y);
    },
  };
}

/**
 * Each map's stream-drawn glyphs by text, each with its `drawnPen` point.
 * @type {WeakMap<GlyphOpMap, { count: number, byText: Map<string, Array<{ glyph: PositionedChar, x: number, y: number }>> }>}
 */
const glyphsByText = new WeakMap();

/**
 * The glyphs the streams drew as copies of `c`, `c` itself among them.
 * A copy has the same text at the same drawn place.
 * The place matches within the windows the page parse merges duplicates in, or within the few pixels a shadow or an invisible copy sits off its text.
 * @param {GlyphOpMap} glyphOpMap
 * @param {PositionedChar} c
 */
export const glyphCopies = (glyphOpMap, c) => {
  if (!c._src) return [c];
  let index = glyphsByText.get(glyphOpMap);
  if (!index || index.count !== glyphOpMap.glyphs.length) {
    /** @type {Map<string, Array<{ glyph: PositionedChar, x: number, y: number }>>} */
    const byText = new Map();
    for (const g of glyphOpMap.glyphs) {
      if (!g._src) continue;
      const [x, y] = drawnPen(glyphOpMap.ops[g._src.op], g._src.tx, g._src.ty);
      const entry = { glyph: g, x, y };
      const list = byText.get(g.text);
      if (list) list.push(entry);
      else byText.set(g.text, [entry]);
    }
    index = { count: glyphOpMap.glyphs.length, byText };
    glyphsByText.set(glyphOpMap, index);
  }
  const candidates = index.byText.get(c.text);
  if (!candidates) return [];
  const {
    along, perp, alongAt, perpAt,
  } = penAxis(glyphOpMap, c);
  const a0 = along(c);
  const p0 = perp(c);
  return candidates.filter(({ glyph: g, x, y }) => {
    if (g === c) return true;
    const size = Math.max(c.fontSize, g.fontSize);
    if (Math.abs(perpAt(x, y) - p0) > Math.max(3.5, 0.2 * size)) return false;
    const d = alongAt(x, y) - a0;
    if (Math.abs(d) <= Math.max(3.5, 0.1 * size)) return true;
    // A stroke pass drawn at a wider, offset position under its fill also counts as a copy, as the page parse merges it.
    if (Math.abs(c.fontSize - g.fontSize) >= 0.05 * size) return false;
    const overlap = Math.min(c.width, d + g.width) - Math.max(0, d);
    return overlap > 0.5 * Math.min(c.width, g.width);
  }).map((e) => e.glyph);
};

/**
 * The codes a font draws each text with.
 * Codes the page itself uses take precedence over the inverse of the font's ToUnicode and encoding maps.
 * @param {PageFont} fontObj
 * @param {GlyphOpMap} glyphOpMap - The page's glyph-op map, whose glyphs say which codes the page uses.
 * @param {?(text: string) => boolean} drawable - Whether the font's program draws a text the page has not used; null trusts the maps.
 * @returns {Map<string, FontCode>}
 */
export function fontCodeTable(fontObj, glyphOpMap, drawable) {
  const isCID = !!(fontObj.type0 || fontObj.isCIDFont);
  const advEmOf = (/** @type {number} */ code) => {
    const key = isCID && fontObj.charCodeToCID ? (fontObj.charCodeToCID.get(code) ?? code) : code;
    if (isCID && fontObj.validCIDs && !fontObj.validCIDs.has(key)) return NaN;
    const w = fontObj.widths.get(key) ?? fontObj.defaultWidth;
    return typeof w === 'number' ? w / 1000 : NaN;
  };
  /** @type {Map<string, FontCode>} */
  const table = new Map();
  /** @type {Map<string, Map<number, number>>} */
  const counts = new Map();
  for (const g of glyphOpMap.glyphs) {
    if (g._font !== fontObj || !g._src || !g.text || g.invisible) continue;
    let byCode = counts.get(g.text);
    if (!byCode) { byCode = new Map(); counts.set(g.text, byCode); }
    byCode.set(g._charCode, (byCode.get(g._charCode) || 0) + 1);
  }
  for (const [text, byCode] of counts) {
    let best = 0;
    for (const [code, n] of byCode) {
      if (best >= n) continue;
      const advEm = advEmOf(code);
      if (!(advEm >= 0)) continue;
      best = n;
      table.set(text, {
        code, nBytes: codeBytes(fontObj, code), advEm, used: true,
      });
    }
  }
  // A zero declared width on a non-blank map-derived code means the subset never drew its glyph, so that text gets no code.
  const addMap = (/** @type {?Map<number, string>} */ map) => {
    if (!map) return;
    for (const [code, str] of map) {
      if (!str || table.has(str)) continue;
      const advEm = advEmOf(code);
      if (!(advEm >= 0) || (advEm === 0 && str.trim() !== '')) continue;
      if (drawable && !drawable(str)) continue;
      table.set(str, {
        code, nBytes: codeBytes(fontObj, code), advEm, used: false,
      });
    }
  };
  addMap(fontObj.toUnicode);
  addMap(fontObj.encodingUnicode);
  // A font whose hyphen glyph reads back only as the soft hyphen types a hyphen with that glyph, unless the page draws a hyphen of its own.
  const hyphen = table.get('-');
  const soft = table.get('\u00ad');
  if (soft && (!hyphen || (!hyphen.used && hyphen.code === soft.code))) {
    const bridged = { ...soft, canon: '\u00ad' };
    table.set('-', bridged);
  }
  return table;
}

/**
 * Codes for a text in a font.
 * Pieces of up to three characters match longest first, so a ligature the page draws stays one glyph.
 * @param {Map<string, FontCode>} table
 * @param {string} text
 * @returns {?Array<FontCode & { text: string }>} Null when a character has no code.
 */
export function codesForText(table, text) {
  /** @type {Array<FontCode & { text: string }>} */
  const out = [];
  let i = 0;
  while (i < text.length) {
    let hit = null;
    for (let len = Math.min(3, text.length - i); len >= 1; len--) {
      const piece = text.slice(i, i + len);
      const fc = table.get(piece);
      if (fc) { hit = { ...fc, text: piece }; break; }
    }
    if (!hit) return null;
    out.push(hit);
    i += hit.text.length;
  }
  return out;
}

/**
 * The text-space advance of typed codes under a show operator's state.
 * @param {Array<{ advEm: number, nBytes: number, code: number }>} codes
 * @param {{ size: number, tc: number, tw: number, tz: number }} state
 */
export function typedAdvance(codes, state) {
  let adv = 0;
  for (const c of codes) adv += (c.advEm * state.size + state.tc + (c.nBytes === 1 && c.code === 32 ? state.tw : 0)) * (state.tz / 100);
  return adv;
}

/**
 * How far the words after an edited word move.
 * They stay put while the edited word ends at least `minGap` before the next word, and otherwise move by the word's whole growth.
 * @param {number} newEnd - Where the edited content ends.
 * @param {number} oldEnd - Where it ended before the edit.
 * @param {number} nextStart - Where the next word starts, before any shift.
 * @param {number} [minGap] - The smallest gap that still reads as a word break, in the units of the other three.
 *   Pass 0.16 of the font size, just over the parser's 0.15 word-split threshold, or the grown word reads back merged with its neighbor.
 */
export const tailShift = (newEnd, oldEnd, nextStart, minGap = 0) => (newEnd + minGap > nextStart ? Math.max(0, newEnd - oldEnd) : 0);

/**
 * @typedef {Object} TextEditRequest
 * @property {'delete'|'replace'} kind
 * @property {Array<TextEditWordSpec>} words - The line's words to act on.
 * @property {Array<string>} [newTexts] - A replacement's new words for the line, in order.
 * @property {Array<?{ color?: string, bold?: boolean, italic?: boolean }>} [styles] - A replacement's toggles, aligned with `newTexts`.
 *   A style toggle alone is a replacement whose words are unchanged.
 * @property {(fontObj: PageFont) => ?Map<string, FontCode>} [codeTable] - A replacement's code table per font, null when the font cannot be typed in.
 * @property {(fontObj: PageFont, text: string) => ?SubstituteGlyph} [substituteFor] - A replacement's glyph for a character no page font of the line draws, from the face standing in for `fontObj`.
 *   Null when there is none.
 */

/**
 * @typedef {Object} SubstituteGlyph
 * @property {string} tag - The font resource name the face is drawn under.
 * @property {number} gid - The glyph's id in the face, its 2-byte code under Identity-H.
 * @property {number} advEm - The glyph's advance in the face, per em, before the fit.
 * @property {number} sizeMult - The fit's size factor against the page font, applied through the font size.
 * @property {number} stretch - The fit's width factor, applied through horizontal scaling.
 * @property {string} family
 * @property {string} styleKey
 * @property {number} [ascent] - The ascent the face declares, per 1000 em of the face.
 * @property {number} [descent] - The descent the face declares, likewise.
 */

/**
 * A requested word as found in a glyph-op map.
 * @typedef {Object} LocatedWord
 * @property {string} id - The request's id for the word.
 * @property {string} parseId - The id the map's parse gave the word, which can differ from the request's.
 * @property {Array<PositionedChar>} chars - The word's glyphs that survived the parse's duplicate merge.
 */

/**
 * @typedef {Object} PredictedWord
 * @property {?string} oldId - The request word this word continues, null for an inserted word.
 * @property {string} text
 * @property {[number, number]} pen - The text-space pen the word's first glyph is drawn at after the edit.
 * @property {number} op - The show op whose matrices place that pen on the page.
 */

/**
 * Whitespace glyphs on a line's baseline band within a range along the line, from any operator.
 * @param {GlyphOpMap} glyphOpMap
 * @param {Array<PositionedChar>} visible - The line's visible glyphs, which set the band.
 * @param {(c: PositionedChar) => number} along
 * @param {(c: PositionedChar) => number} perp
 * @param {number} a0
 * @param {number} a1
 * @param {Set<PositionedChar>} skip
 */
function whitespaceOnBand(glyphOpMap, visible, along, perp, a0, a1, skip) {
  const perps = visible.map(perp).sort((x, y) => x - y);
  const perp0 = perps[Math.floor(perps.length / 2)];
  const size = Math.max(...visible.map((c) => c.fontSize));
  /** @type {Array<PositionedChar>} */
  const out = [];
  for (const c of glyphOpMap.glyphs) {
    if (skip.has(c) || !c._src || c.text.trim() !== '') continue;
    if (Math.abs(perp(c) - perp0) > size * 0.2) continue;
    const v = along(c);
    if (v < a0 || v > a1) continue;
    out.push(c);
  }
  return out;
}

/**
 * The operator rewrites for one edit, and what the planner learned making them.
 * @typedef {Object} TextEditPlan
 * @property {Map<number, OpPlan>} plans - The rewrite of each show op the edit touches, keyed by show op index.
 * @property {Array<?LocatedWord>} located - The requested words as found in the map, aligned with the request, null for a word not found.
 * @property {Array<string>} twinIds - Parse ids of other words that lose every glyph with the edit, which the caller removes from the live page too.
 * @property {Set<PositionedChar>} dropped - Every glyph the edit removes.
 * @property {Set<PositionedChar>} wordGlyphs - The located words' glyphs with their copies.
 * @property {?Array<PredictedWord>} predictedWords - A replacement's new word sequence, null for a deletion or a refusal.
 * @property {?string} refused - Why the edit cannot be planned, null when it can.
 * @property {Array<{ tag: string, family: string, styleKey: string, ascent?: number, descent?: number }>} [faces] - The substitute faces a replacement's patches draw with.
 */

/**
 * Plan the operator rewrites for a deletion or a replacement against the page's glyph-op map, built with its current records applied.
 * @param {GlyphOpMap} glyphOpMap
 * @param {TextEditRequest} req
 * @returns {TextEditPlan}
 */
export function planTextEdit(glyphOpMap, req) {
  const located = locateWords(glyphOpMap, req.words);
  /** @type {Map<number, OpPlan>} */
  const plans = new Map();
  const planFor = (/** @type {number} */ opIdx) => {
    let p = plans.get(opIdx);
    if (!p) {
      p = { op: glyphOpMap.ops[opIdx], actions: new Map(), pens: new Map() };
      plans.set(opIdx, p);
    }
    return p;
  };
  const keyOf = (/** @type {PositionedChar} */ c) => `${c._src.elem}:${c._src.byte}`;
  const register = (/** @type {PositionedChar} */ c) => {
    if (!c._src) return null;
    const p = planFor(c._src.op);
    p.pens.set(keyOf(c), [c._src.tx, c._src.ty, c._src.adv]);
    return p;
  };
  const actionOf = (/** @type {PositionedChar} */ c) => {
    const p = register(c);
    if (!p) return null;
    let act = p.actions.get(keyOf(c));
    if (!act) { act = {}; p.actions.set(keyOf(c), act); }
    return act;
  };
  /** @type {Map<PositionedChar, Array<PositionedChar>>} */
  const copies = new Map();
  /**
   * A glyph with its copies.
   * Every action on the glyph applies to its copies as well.
   * @param {PositionedChar} c
   */
  const copiesOf = (c) => {
    let list = copies.get(c);
    if (!list) { list = glyphCopies(glyphOpMap, c); copies.set(c, list); }
    return list;
  };
  /** @type {Set<PositionedChar>} */
  const wordGlyphs = new Set();
  for (const w of located) {
    if (w) {
      for (const c of w.chars) {
        for (const d of copiesOf(c)) wordGlyphs.add(d);
      }
    }
  }
  /** @type {Set<PositionedChar>} */
  const goneSet = new Set();
  /** @type {Array<string>} */
  const twinIds = [];
  const none = {
    plans, located, twinIds, dropped: goneSet, wordGlyphs, predictedWords: null, refused: null,
  };

  const registerOps = () => {
    for (const c of glyphOpMap.glyphs) if (c._src && plans.has(c._src.op)) register(c);
  };

  if (req.kind === 'delete') {
    const gone = [...wordGlyphs];
    const fold = (/** @type {string} */ s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const c of gone) goneSet.add(c);
    const locatedIds = new Set(located.filter((w) => w).map((w) => /** @type {{parseId: string}} */ (w).parseId));
    /** @type {Array<PositionedChar>} */
    const visible = [];
    for (const w of located) {
      if (w) {
        for (const c of w.chars) {
          if (c.text.trim() !== '') visible.push(c);
        }
      }
    }
    if (visible.length > 0) {
      const { along, perp } = penAxis(glyphOpMap, visible[0]);
      const size = Math.max(...visible.map((c) => c.fontSize));
      // A text-shadow halo sits too far from the deleted text for the per-glyph match above, so this pass matches it by overlap with the deleted words and a letter-subsequence test.
      const delChars = visible.map((c) => ({ u: fold(c.text), a: along(c), p: perp(c) })).filter((d) => d.u.length > 0).sort((x, y) => x.a - y.a);
      /** @type {Array<[number, number]>} */
      const spans = [];
      for (const w of located) {
        if (!w || w.chars.length === 0) continue;
        spans.push([Math.min(...w.chars.map((c) => along(c))), Math.max(...w.chars.map((c) => along(c) + (c.width || 0)))]);
      }
      const isSubseq = (/** @type {string} */ a, /** @type {string} */ b) => {
        let i = 0;
        for (const ch of b) { if (ch === a[i]) i += 1; if (i === a.length) return true; }
        return a.length === 0;
      };
      const PAD = 40;
      const perp0 = perp(visible[0]);
      for (const [id, chars] of glyphOpMap.words) {
        if (locatedIds.has(id) || twinIds.includes(id) || chars.length === 0) continue;
        let maxSize = -Infinity;
        for (const c of chars) maxSize = Math.max(maxSize, c.fontSize);
        const tol = Math.max(3, 0.5 * maxSize);
        const p0 = perp(chars[0]);
        if (Math.abs(p0 - perp0) > tol) continue;
        let a0 = Infinity;
        let a1 = -Infinity;
        for (const c of chars) {
          const v = along(c);
          a0 = Math.min(a0, v);
          a1 = Math.max(a1, v + (c.width || 0));
        }
        let under = 0;
        for (const [s0, s1] of spans) under += Math.max(0, Math.min(a1, s1) - Math.max(a0, s0));
        if (!(a1 > a0) || under < 0.6 * (a1 - a0)) continue;
        const wText = chars.map((c) => fold(c.text)).join('');
        if (wText.length < 3) continue;
        const winText = delChars.filter((d) => d.a >= a0 - PAD && d.a <= a1 + PAD && Math.abs(d.p - p0) <= tol).map((d) => d.u).join('');
        if (winText.length === 0) continue;
        const [lo, hi] = wText.length <= winText.length ? [wText, winText] : [winText, wText];
        if (!isSubseq(lo, hi)) continue;
        twinIds.push(id);
        for (const c of chars) {
          for (const d of copiesOf(c)) {
            if (!goneSet.has(d)) {
              gone.push(d);
              goneSet.add(d);
            }
          }
        }
      }
      let a0 = Infinity;
      let a1 = -Infinity;
      for (const c of gone) {
        a0 = Math.min(a0, along(c));
        a1 = Math.max(a1, along(c) + (c.width || 0));
      }
      for (const c of whitespaceOnBand(glyphOpMap, visible, along, perp, a0 - size, a1 + size, goneSet)) {
        gone.push(c);
        goneSet.add(c);
      }
    }
    // A word every glyph of which the deletion removes, such as an invisible copy the parse kept apart from the text it copies, goes with the line.
    for (const [id, chars] of glyphOpMap.words) {
      if (locatedIds.has(id) || twinIds.includes(id) || chars.length === 0) continue;
      if (chars.every((c) => goneSet.has(c))) twinIds.push(id);
    }
    for (const c of gone) {
      const act = actionOf(c);
      if (act) act.drop = true;
    }
    /** @type {Map<number, Map<number, [number, number]>>} */
    const dropRanges = new Map();
    for (const [opIdx, p] of plans) {
      /** @type {Map<number, [number, number]>} */
      const byElem = new Map();
      for (const key of p.actions.keys()) {
        const sep = key.indexOf(':');
        const e = Number(key.slice(0, sep));
        const bt = Number(key.slice(sep + 1));
        const r = byElem.get(e);
        if (!r) byElem.set(e, [bt, bt]);
        else { r[0] = Math.min(r[0], bt); r[1] = Math.max(r[1], bt); }
      }
      dropRanges.set(opIdx, byElem);
    }
    for (const ch of glyphOpMap.glyphs) {
      if (!ch._src) continue;
      const byElem = dropRanges.get(ch._src.op);
      if (!byElem) continue;
      const r = byElem.get(ch._src.elem);
      if (!r || ch._src.byte < r[0] || ch._src.byte > r[1]) continue;
      const p = /** @type {OpPlan} */ (plans.get(ch._src.op));
      const key = keyOf(ch);
      if (p.actions.has(key) || ch.text.trim() !== '') continue;
      p.pens.set(key, [ch._src.tx, ch._src.ty, ch._src.adv]);
      p.actions.set(key, { drop: true });
      goneSet.add(ch);
    }
    registerOps();
    return none;
  }

  if (located.some((w) => !w)) return none;
  const words = located.map((w, i) => ({ spec: req.words[i], chars: /** @type {{chars: Array<PositionedChar>}} */ (w).chars }));
  const newTexts = req.newTexts || [];
  const styles = req.styles || [];
  const first = words[0].chars.find((c) => c._src) || null;
  if (!first || !req.codeTable) return { ...none, refused: 'The line has no glyph in the page stream.' };
  const op0 = glyphOpMap.ops[first._src.op];
  const axisLen0 = Math.hypot(op0.tm[0], op0.tm[1]) || 1;
  const ux = op0.tm[0] / axisLen0;
  const uy = op0.tm[1] / axisLen0;
  const alongPen = (/** @type {number} */ x, /** @type {number} */ y) => x * ux + y * uy;
  const glyphStart = (/** @type {PositionedChar} */ c) => alongPen(c._src.tx, c._src.ty);
  const glyphEnd = (/** @type {PositionedChar} */ c) => {
    const op = glyphOpMap.ops[c._src.op];
    return alongPen(c._src.tx + c._src.adv * op.tm[0], c._src.ty + c._src.adv * op.tm[1]);
  };
  const wordStart = (/** @type {number} */ j) => glyphStart(words[j].chars[0]);
  const wordEnd = (/** @type {number} */ j) => glyphEnd(words[j].chars[words[j].chars.length - 1]);
  // Stops at the glyph's drawn width, before the operator's character and word spacing, since some producers draw no space glyphs and set a word's gap as the character spacing of its last glyph.
  const glyphWidthEnd = (/** @type {PositionedChar} */ c) => {
    const cop = glyphOpMap.ops[c._src.op];
    const widthTs = c._src.adv - (cop.tc + (c._src.space ? cop.tw : 0)) * (cop.tz / 100);
    return alongPen(c._src.tx + widthTs * cop.tm[0], c._src.ty + widthTs * cop.tm[1]);
  };
  const letterSpacingOf = (/** @type {Array<PositionedChar>} */ cs) => {
    const steps = [];
    for (let gi = 1; gi < cs.length; gi++) steps.push(glyphStart(cs[gi]) - glyphWidthEnd(cs[gi - 1]));
    steps.sort((x, y) => x - y);
    return steps.length > 0 ? steps[Math.floor(steps.length / 2)] : null;
  };
  const olen = words.length;
  const nlen = newTexts.length;
  let i0 = 0;
  while (i0 < olen && i0 < nlen && words[i0].spec.text === newTexts[i0]) i0 += 1;
  let k = 0;
  while (k < olen - i0 && k < nlen - i0 && words[olen - 1 - k].spec.text === newTexts[nlen - 1 - k]) k += 1;
  const pairs = Math.min(olen - i0 - k, nlen - i0 - k);
  /** @type {Array<{ kind: 'keep'|'change'|'insert', old: number, text: string, style: ?{ color?: string, bold?: boolean, italic?: boolean }, deletedBefore: Array<number> }>} */
  const items = [];
  for (let i = 0; i < nlen; i++) {
    const style = styles[i] || null;
    if (i < i0) {
      items.push({
        kind: 'keep', old: i, text: newTexts[i], style, deletedBefore: [],
      });
    } else if (i < i0 + pairs) {
      items.push({
        kind: 'change', old: i, text: newTexts[i], style, deletedBefore: [],
      });
    } else if (i < nlen - k) {
      items.push({
        kind: 'insert', old: -1, text: newTexts[i], style, deletedBefore: [],
      });
    } else {
      items.push({
        kind: 'keep', old: i - (nlen - olen), text: newTexts[i], style, deletedBefore: [],
      });
    }
  }
  const deleted = [];
  for (let j = i0 + pairs; j < olen - k; j++) deleted.push(j);
  const suffixItem = items.find((it) => it.kind === 'keep' && it.old >= olen - k);
  if (deleted.length > 0) (suffixItem || items[items.length - 1]).deletedBefore = deleted;
  const gaps = [];
  for (let j = 1; j < olen; j++) gaps.push(wordStart(j) - wordEnd(j - 1));
  gaps.sort((x, y) => x - y);
  const lineGap = gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : (op0.fontSize * 0.25 * axisLen0);
  const lineLetterSpacings = words.map((w) => letterSpacingOf(w.chars)).filter((v) => v !== null).sort((x, y) => x - y);
  const lineLetterSpacing = lineLetterSpacings.length > 0 ? lineLetterSpacings[Math.floor(lineLetterSpacings.length / 2)] : 0;

  /** @type {Array<PositionedChar>} */
  const visible = [];
  for (const w of words) for (const c of w.chars) if (c.text.trim() !== '') visible.push(c);
  const { along: alongPx, perp: perpPx } = penAxis(glyphOpMap, visible[0]);

  /** @type {Map<PageFont, ShowOp>} */
  const lineFontOps = new Map();
  for (const w of words) {
    for (const c of w.chars) {
      for (const d of copiesOf(c)) {
        if (d._src && d._font && !lineFontOps.has(d._font)) lineFontOps.set(d._font, glyphOpMap.ops[d._src.op]);
      }
    }
  }
  /**
   * Codes for a text in the font and state of an operator.
   * A character the operator's font lacks is typed in another font the line draws with, else in a substitute face.
   * Such a text is returned in segments.
   * @param {ShowOp} op
   * @param {string} text
   * @returns {{ hex: string, adv: number, codes: Array<FontCode & { text: string, canon?: string }>, segments?: Array<CodeInsert>, faces?: Array<SubstituteGlyph> } | { error: string }}
   */
  const codesIn = (op, text) => {
    if (!op.font) return { error: 'The word has no font.' };
    if (op.font.type3) return { error: 'Text in a Type 3 font is not replaced.' };
    if (op.font.verticalMode) return { error: 'Vertical text is not replaced.' };
    const table = req.codeTable ? req.codeTable(op.font) : null;
    if (!table) return { error: 'The font cannot be typed in.' };
    const state = {
      size: op.fontSize, tc: op.tc, tw: op.tw, tz: op.tz,
    };
    const whole = codesForText(table, text);
    if (whole) {
      const hex = whole.map((c) => c.code.toString(16).padStart(c.nBytes * 2, '0')).join('');
      return { hex, adv: typedAdvance(whole, state), codes: whole };
    }
    /** @type {Array<{ kind: 'page'|'font'|'face', fontObj?: PageFont, tag: string, size: number, tz: number, codes: Array<FontCode & { text: string, canon?: string }>, face?: SubstituteGlyph }>} */
    const runs = [];
    for (const ch of [...text]) {
      let placed = false;
      const own = codesForText(table, ch);
      if (own) {
        const last = runs[runs.length - 1];
        if (last && last.kind === 'page') last.codes.push(...own);
        else {
          runs.push({
            kind: 'page', tag: op.fontTag, size: op.fontSize, tz: op.tz, codes: own,
          });
        }
        placed = true;
      }
      if (!placed) {
        for (const [fontObj, fop] of lineFontOps) {
          if (fontObj === op.font || fontObj.type3 || fontObj.verticalMode || !fop.fontTag) continue;
          const other = req.codeTable ? req.codeTable(fontObj) : null;
          const codes = other ? codesForText(other, ch) : null;
          if (!codes) continue;
          const last = runs[runs.length - 1];
          if (last && last.kind === 'font' && last.fontObj === fontObj) last.codes.push(...codes);
          else {
            runs.push({
              kind: 'font', fontObj, tag: fop.fontTag, size: op.fontSize, tz: op.tz, codes,
            });
          }
          placed = true;
          break;
        }
      }
      if (!placed && req.substituteFor) {
        const face = req.substituteFor(op.font, ch);
        if (face) {
          const code = {
            code: face.gid, nBytes: 2, advEm: face.advEm * face.sizeMult, used: false, text: ch,
          };
          const last = runs[runs.length - 1];
          if (last && last.kind === 'face' && last.tag === face.tag) last.codes.push(code);
          else {
            runs.push({
              kind: 'face', tag: face.tag, size: op.fontSize * face.sizeMult, tz: op.tz * face.stretch, codes: [code], face,
            });
          }
          placed = true;
        }
      }
      if (!placed) return { error: `The font has no glyph for "${ch}".` };
    }
    /** @type {Array<CodeInsert>} */
    const segments = [];
    /** @type {Array<FontCode & { text: string, canon?: string }>} */
    const all = [];
    /** @type {Array<SubstituteGlyph>} */
    const faces = [];
    let adv = 0;
    for (const r of runs) {
      const hex = r.codes.map((c) => c.code.toString(16).padStart(c.nBytes * 2, '0')).join('');
      // A face code's advEm is already scaled by sizeMult to the page font's size, so divide that back out before measuring at the fitted size.
      const segAdv = typedAdvance(r.codes.map((c) => (r.kind === 'face' ? { ...c, advEm: c.advEm / (r.size / op.fontSize) } : c)), { ...state, size: r.size, tz: r.tz });
      /** @type {CodeInsert} */
      const seg = { hex, adv: segAdv };
      if (r.kind !== 'page') {
        const sizeBack = `${formatPdfNumber(op.fontSize)}`;
        seg.wrap = {
          before: [`/${r.tag} ${formatPdfNumber(r.size)} Tf`, ...(r.tz !== op.tz ? [`${formatPdfNumber(r.tz)} Tz`] : [])],
          after: [`/${op.fontTag} ${sizeBack} Tf`, ...(r.tz !== op.tz ? [`${formatPdfNumber(op.tz)} Tz`] : [])],
        };
      }
      if (r.face) faces.push(r.face);
      segments.push(seg);
      all.push(...r.codes);
      adv += segAdv;
    }
    if (segments.length === 1 && !segments[0].wrap) return { hex: segments[0].hex, adv, codes: all };
    return {
      hex: '', adv, codes: all, segments, faces,
    };
  };
  /**
   * Add codes beside a glyph that may already have codes inserted on that side, so both are emitted in order.
   * The first insert's shift places the pair.
   * @type {(act: GlyphAction, how: 'insertBefore'|'insertAfter', ins: CodeInsert) => void}
   */
  const chainInsert = (act, how, ins) => {
    const have = act[how];
    act[how] = have ? {
      hex: '', adv: have.adv + ins.adv, shift: have.shift, segments: [have, ins],
    } : ins;
  };

  /** @type {Array<PredictedWord>} */
  const predictedWords = [];
  /** @type {Map<string, SubstituteGlyph>} */
  const facesUsed = new Map();
  let s = 0;
  let prevEndNew = -Infinity;
  let prevOld = -1;
  /**
   * The glyph whose emitted codes end the previous old word, which an inserted word chains onto.
   * It is the word's last glyph when that glyph is kept, else the glyph that carries the changed word's new codes.
   * @type {?PositionedChar}
   */
  let prevTail = null;
  for (let ii = 0; ii < items.length; ii++) {
    const it = items[ii];
    for (const j of it.deletedBefore) {
      for (const c of words[j].chars) {
        for (const d of copiesOf(c)) {
          const act = actionOf(d);
          if (act) {
            act.drop = true;
            goneSet.add(d);
          }
        }
      }
      const prevEnd = j > 0 ? alongPx(words[j - 1].chars[words[j - 1].chars.length - 1]) + words[j - 1].chars[words[j - 1].chars.length - 1].width : -Infinity;
      const lastC = words[j].chars[words[j].chars.length - 1];
      for (const c of whitespaceOnBand(glyphOpMap, visible, alongPx, perpPx, prevEnd, alongPx(lastC) + lastC.width + 0.5, goneSet)) {
        const act = actionOf(c);
        if (act) { act.drop = true; goneSet.add(c); }
      }
    }
    let nextOldStart = Infinity;
    for (let jj = ii + 1; jj < items.length; jj++) if (items[jj].kind !== 'insert') { nextOldStart = wordStart(items[jj].old); break; }
    if (it.kind === 'keep') {
      const j = it.old;
      if (s) {
        for (const c of words[j].chars) {
          for (const d of copiesOf(c)) {
            const act = actionOf(d);
            if (act) act.shift = s;
          }
        }
      }
      if (it.style) applyStyle(words[j].chars, { ...words[j].spec, ...it.style }, s);
      const c0 = words[j].chars[0];
      predictedWords.push({
        oldId: words[j].spec.id, text: it.text, pen: [c0._src.tx + s * ux, c0._src.ty + s * uy], op: c0._src.op,
      });
      prevEndNew = wordEnd(j) + s;
      prevOld = j;
      prevTail = words[j].chars[words[j].chars.length - 1];
      continue;
    }
    if (it.kind === 'insert') {
      const nextItem = items.slice(ii + 1).find((x) => x.kind !== 'insert');
      const anchorChar = prevTail || (nextItem ? words[nextItem.old].chars[0] : null);
      if (!anchorChar || !anchorChar._src) return { ...none, refused: 'An inserted word has no neighbor to type beside.' };
      const how = prevTail ? 'insertAfter' : 'insertBefore';
      const op = glyphOpMap.ops[anchorChar._src.op];
      const axisLen = Math.hypot(op.tm[0], op.tm[1]) || 1;
      const r = codesIn(op, it.text);
      if ('error' in r) return { ...none, refused: r.error };
      const advUser = r.adv * axisLen;
      const start = prevTail ? prevEndNew + lineGap : wordStart(/** @type {{old: number}} */ (nextItem).old) + s;
      for (const d of copiesOf(anchorChar)) {
        const act = actionOf(d);
        if (!act) continue;
        const dop = glyphOpMap.ops[d._src.op];
        const rd = d === anchorChar ? r : codesIn(dop, it.text);
        if ('error' in rd) return { ...none, refused: rd.error };
        if (rd.faces) for (const f of rd.faces) facesUsed.set(f.tag, f);
        // The word is spaced by the line's gap from the glyph or the insert it follows.
        // The first word inserted before a glyph starts at that glyph's pen.
        /** @type {CodeInsert} */
        const ins = {
          hex: rd.hex, adv: rd.adv, gap: how === 'insertAfter' || act.insertBefore ? lineGap / (Math.hypot(dop.tm[0], dop.tm[1]) || 1) : 0, segments: rd.segments,
        };
        if (how === 'insertBefore') ins.shift = s;
        if (it.style) {
          const ops = styleOps(dop, { id: '', penX: [], ...it.style }, null);
          // The lean is written as a text matrix at the insertion's pen when its codes are emitted, so styleOps gets no target here.
          const shearDen = dop.tm[0] * dop.tm[0] + dop.tm[1] * dop.tm[1];
          const shearRaw = shearDen > 0 ? (dop.tm[0] * dop.tm[2] + dop.tm[1] * dop.tm[3]) / shearDen : 0;
          const shearNow = Math.abs(shearRaw) > 0.05 ? shearRaw : 0;
          const lean = it.style.italic === true && !shearNow ? FAUX_OBLIQUE_SKEW : (it.style.italic === false && shearNow ? -shearNow : 0);
          if (ops.before.length > 0 || ops.after.length > 0 || lean) ins.wrap = { before: ops.before, after: ops.after, lean: lean || undefined };
        }
        chainInsert(act, how, ins);
      }
      if (!prevTail) s += advUser + lineGap;
      const end = start + advUser;
      const dAlong = start - alongPen(anchorChar._src.tx, anchorChar._src.ty);
      predictedWords.push({
        oldId: null,
        text: 'codes' in r ? r.codes.map((fc) => fc.canon ?? fc.text).join('') : it.text,
        pen: [anchorChar._src.tx + dAlong * ux, anchorChar._src.ty + dAlong * uy],
        op: anchorChar._src.op,
      });
      prevEndNew = end;
      // The words after move by the line's growth past the previous word's old end, not by the whole inserted word, since a changed word before the insert may have shrunk.
      if (prevTail && nextOldStart < Infinity && end + lineGap > nextOldStart + s) s += Math.max(0, end - (wordEnd(prevOld) + s));
      continue;
    }
    // A changed word that is also toggled is redrawn whole, with no kept prefix or suffix, so the toggle's operators around its first glyph wrap all of its codes.
    const j = it.old;
    const chars = words[j].chars;
    const oldText = it.style ? '' : words[j].spec.text;
    const glyphTexts = chars.map((c) => c.text);
    const aligned = glyphTexts.join('') === oldText;
    let pre = 0;
    let suf = 0;
    if (aligned) {
      let cp = 0;
      while (cp < oldText.length && cp < it.text.length && oldText[cp] === it.text[cp]) cp += 1;
      let cs = 0;
      while (cs < oldText.length - cp && cs < it.text.length - cp && oldText[oldText.length - 1 - cs] === it.text[it.text.length - 1 - cs]) cs += 1;
      let acc = 0;
      while (pre < chars.length && acc + glyphTexts[pre].length <= cp) { acc += glyphTexts[pre].length; pre += 1; }
      acc = 0;
      while (suf < chars.length - pre && acc + glyphTexts[chars.length - 1 - suf].length <= cs) { acc += glyphTexts[chars.length - 1 - suf].length; suf += 1; }
    }
    const preLen = glyphTexts.slice(0, pre).join('').length;
    const sufLen = glyphTexts.slice(chars.length - suf).join('').length;
    const middle = it.text.slice(preLen, it.text.length - sufLen);
    const dropped = chars.slice(pre, chars.length - suf);
    const anchor = dropped[0] || chars[pre] || chars[pre - 1];
    const op = glyphOpMap.ops[anchor._src.op];
    const axisLen = Math.hypot(op.tm[0], op.tm[1]) || 1;
    const r = middle.length > 0 ? codesIn(op, middle) : { hex: '', adv: 0 };
    if ('error' in r) return { ...none, refused: r.error };
    const appendAfter = dropped.length === 0 && suf === 0 && pre > 0 ? chars[pre - 1] : null;
    const ownSpacing = letterSpacingOf(chars);
    const lsU = ownSpacing !== null ? ownSpacing : lineLetterSpacing;
    // The operator's character spacing beyond the word's own letter spacing, in its text space.
    // New codes are spaced by the word's letter spacing in every edit, since on some producers the operator's spacing is the word gap.
    const excessOf = (/** @type {ShowOp} */ dop) => Math.max(0, dop.tc * (dop.tz / 100) - lsU / (Math.hypot(dop.tm[0], dop.tm[1]) || 1));
    // Must match the advance `placeCodes` emits for the appended codes, since the words after are placed from it.
    const growthU = appendAfter && 'codes' in r ? (!r.segments && excessOf(op) > 1e-9 ? r.adv - r.codes.length * excessOf(op) : r.adv) * axisLen : 0;
    const spanStart = dropped.length > 0 ? glyphStart(dropped[0]) : (appendAfter ? glyphWidthEnd(appendAfter) : (pre > 0 ? glyphEnd(chars[pre - 1]) : glyphStart(chars[pre])));
    const oldSpanEnd = suf > 0 ? glyphStart(chars[chars.length - suf]) : (dropped.length > 0 ? glyphEnd(dropped[dropped.length - 1]) : spanStart);
    // Must match the advance `placeCodes` emits for the replacement, since the kept suffix and the words after are placed from it.
    const rAdv = 'codes' in r && !r.segments && excessOf(op) > 1e-9 ? r.adv - (r.codes.length - 1) * excessOf(op) : r.adv;
    const delta = appendAfter ? growthU : (spanStart + rAdv * axisLen) - oldSpanEnd;
    for (let gi = 0; gi < pre; gi++) {
      for (const d of copiesOf(chars[gi])) {
        const act = actionOf(d);
        if (act) act.shift = s;
      }
    }
    for (let gi = chars.length - suf; gi < chars.length; gi++) {
      for (const d of copiesOf(chars[gi])) {
        const act = actionOf(d);
        if (act) act.shift = s + delta;
      }
    }
    const shiftAt = s;
    const placeCodes = (/** @type {PositionedChar} */ c, /** @type {'replace'|'insertBefore'|'insertAfter'} */ how) => {
      for (const d of copiesOf(c)) {
        const act = actionOf(d);
        if (!act) continue;
        const dop = glyphOpMap.ops[d._src.op];
        const rd = d === c ? r : (middle.length > 0 ? codesIn(dop, middle) : { hex: '', adv: 0 });
        if ('error' in rd) return rd.error;
        if ('faces' in rd && rd.faces) for (const f of rd.faces) facesUsed.set(f.tag, f);
        const excess = 'codes' in rd && !rd.segments ? excessOf(dop) : 0;
        const dstate = {
          size: dop.fontSize, tc: dop.tc, tw: dop.tw, tz: dop.tz,
        };
        /**
         * The codes' placement, with the operator's excess spacing taken back before each glyph after the first.
         * Pass `firstToo` when the preceding glyph also trails that spacing, as in an append after the word's last glyph, so the first glyph takes it back too.
         * @param {boolean} firstToo
         */
        const spaced = (firstToo) => (excess > 1e-9 && 'codes' in rd
          ? {
            glyphs: rd.codes.map((fc, i) => ({ hex: fc.code.toString(16).padStart(fc.nBytes * 2, '0'), adv: typedAdvance([fc], dstate), gap: i > 0 || firstToo ? -excess : 0 })),
            adv: rd.adv - (firstToo ? rd.codes.length : rd.codes.length - 1) * excess,
          }
          : { glyphs: undefined, adv: rd.adv });
        if (how === 'replace') {
          const sp = spaced(false);
          act.replace = {
            hex: rd.hex, adv: sp.adv, glyphs: sp.glyphs, segments: rd.segments,
          };
          act.shift = shiftAt;
        } else if (how === 'insertBefore') {
          const sp = spaced(false);
          chainInsert(act, 'insertBefore', {
            hex: rd.hex, adv: sp.adv, glyphs: sp.glyphs, gap: act.insertBefore ? lineGap / (Math.hypot(dop.tm[0], dop.tm[1]) || 1) : 0, shift: shiftAt, segments: rd.segments,
          });
        } else if (appendAfter) {
          const sp = spaced(true);
          act.insertAfter = {
            hex: rd.hex, adv: sp.adv, glyphs: sp.glyphs, gap: 0, segments: rd.segments,
          };
        } else {
          act.insertAfter = {
            hex: rd.hex, adv: rd.adv, gap: 0, segments: rd.segments,
          };
        }
      }
      return null;
    };
    let err = null;
    if (dropped.length > 0) {
      err = placeCodes(dropped[0], 'replace');
      for (let gi = 1; gi < dropped.length; gi++) {
        for (const d of copiesOf(dropped[gi])) {
          const act = actionOf(d);
          if (act) {
            act.drop = true;
            goneSet.add(d);
          }
        }
      }
      for (const d of copiesOf(dropped[0])) goneSet.add(d);
    } else if (suf > 0) {
      err = placeCodes(chars[chars.length - suf], 'insertBefore');
    } else {
      err = placeCodes(chars[pre - 1], 'insertAfter');
    }
    if (err) return { ...none, refused: err };
    if (it.style) {
      for (const d of copiesOf(chars[0])) {
        const act = actionOf(d);
        if (!act) continue;
        const dop = glyphOpMap.ops[d._src.op];
        const target = /** @type {[number, number]} */ ([d._src.tx + s * ux, d._src.ty + s * uy]);
        const ops = styleOps(dop, { ...words[j].spec, ...it.style }, target);
        act.before = [...(act.before || []), ...ops.before];
        act.after = [...(act.after || []), ...ops.after];
        act.shift = s;
        if (ops.setsPen) act.setsPen = true;
        if (ops.resetsPen) act.resetsPen = true;
      }
    }
    // The word records what its codes read back as, since a typed hyphen can take a code that reads back as a soft hyphen.
    const middleRecorded = 'codes' in r ? r.codes.map((fc) => fc.canon ?? fc.text).join('') : middle;
    predictedWords.push({
      oldId: words[j].spec.id,
      text: it.text.slice(0, preLen) + middleRecorded + it.text.slice(it.text.length - sufLen),
      pen: [chars[0]._src.tx + s * ux, chars[0]._src.ty + s * uy],
      op: chars[0]._src.op,
    });
    // A margin over the parser's word-split threshold of 0.15 of the font size, which a gap must exceed to read as a word break.
    const minGap = 0.16 * op.fontSize * axisLen;
    prevOld = j;
    prevTail = suf > 0 ? chars[chars.length - 1] : (dropped.length > 0 ? dropped[0] : chars[pre - 1]);
    if (appendAfter) {
      const endW = spanStart + s + growthU;
      prevEndNew = endW + (glyphEnd(appendAfter) - spanStart);
      if (nextOldStart < Infinity) s += tailShift(endW, spanStart + s, nextOldStart + s, minGap);
    } else {
      const end = wordEnd(j) + s + delta;
      prevEndNew = end;
      if (nextOldStart < Infinity) s += tailShift(end, wordEnd(j) + s, nextOldStart + s, minGap);
    }
  }
  registerOps();
  return {
    ...none,
    predictedWords,
    faces: [...facesUsed.values()].map((f) => ({
      tag: f.tag, family: f.family, styleKey: f.styleKey, ascent: f.ascent, descent: f.descent,
    })),
  };

  /**
   * Toggle a kept word's state.
   * @param {Array<PositionedChar>} wordChars
   * @param {TextEditWordSpec & { color?: string, bold?: boolean, italic?: boolean }} spec
   * @param {number} shift - The word's shift, in user space along the line.
   */
  function applyStyle(wordChars, spec, shift) {
    /** @type {Map<number, Array<PositionedChar>>} */
    const byOp = new Map();
    for (const c of wordChars) {
      for (const d of copiesOf(c)) {
        if (!d._src) continue;
        const list = byOp.get(d._src.op) || [];
        byOp.set(d._src.op, list);
        list.push(d);
      }
    }
    for (const [opIdx, inOp] of byOp) {
      inOp.sort((x, y) => (x._src.elem - y._src.elem) || (x._src.byte - y._src.byte));
      const p = planFor(opIdx);
      const aC = inOp[0];
      const zC = inOp[inOp.length - 1];
      const dirLen = Math.hypot(p.op.tm[0], p.op.tm[1]) || 1;
      const target = /** @type {[number, number]} */ ([aC._src.tx + shift * (p.op.tm[0] / dirLen), aC._src.ty + shift * (p.op.tm[1] / dirLen)]);
      const {
        before, after, setsPen, resetsPen,
      } = styleOps(p.op, spec, target);
      const actA = /** @type {GlyphAction} */ (actionOf(aC));
      actA.before = [...(actA.before || []), ...before];
      if (setsPen) actA.setsPen = true;
      const actZ = /** @type {GlyphAction} */ (actionOf(zC));
      actZ.after = [...(actZ.after || []), ...after];
      if (resetsPen) actZ.resetsPen = true;
    }
  }
}

/**
 * The operators that set a word's toggled state and the ones that restore the page's.
 * @param {ShowOp} op
 * @param {{ color?: string, bold?: boolean, italic?: boolean }} spec
 * @param {?[number, number]} target - The pen a sheared matrix starts at, or null when no matrix may be written.
 */
function styleOps(op, spec, target) {
  /** @type {Array<string>} */
  const before = [];
  /** @type {Array<string>} */
  const after = [];
  let setsPen = false;
  let resetsPen = false;
  const hex = spec.color && /^#[0-9a-f]{6}$/i.test(spec.color) ? spec.color : null;
  const rgb = hex ? [1, 3, 5].map((i) => formatPdfNumber(parseInt(hex.slice(i, i + 2), 16) / 255)).join(' ') : null;
  const stroked = op.tr === 1 || op.tr === 2;
  const wantBold = spec.bold === true && !stroked && !op.font?.bold;
  const unbold = spec.bold === false && stroked;
  if (rgb) {
    before.push(`${rgb} rg`);
    after.push(op.fillColorSrc);
    if (stroked && !unbold) {
      before.push(`${rgb} RG`);
      after.push(op.strokeColorSrc);
    }
  }
  if (wantBold) {
    // The parser reads stroke width as line width times this CTM scale, so dividing by it makes the stroke read back at the intended width.
    const ctmScale = Math.sqrt(Math.abs(op.ctm[0] * op.ctm[3] - op.ctm[1] * op.ctm[2])) || 1;
    const sizeUser = Math.abs(op.fontSize * Math.hypot(op.tm[2] * op.ctm[0] + op.tm[3] * op.ctm[2], op.tm[2] * op.ctm[1] + op.tm[3] * op.ctm[3]));
    const lw = (FAUX_BOLD_STROKE_EM * sizeUser) / ctmScale;
    // The stroke takes the fill's ink, so the fill operators become their stroking forms.
    const strokeInk = rgb ? `${rgb} RG` : op.fillColorSrc.replace(/(^|\s)cs(\s)/, '$1CS$2').replace(/\s(g|rg|k|sc|scn)$/, (m, o) => ` ${o.toUpperCase()}`);
    before.push(`2 Tr ${formatPdfNumber(lw)} w ${strokeInk}`);
    after.push(`${op.tr} Tr ${formatPdfNumber(op.lineWidth)} w ${op.strokeColorSrc}`);
  } else if (unbold) {
    before.push('0 Tr');
    after.push(`${op.tr} Tr`);
  }
  // The parser computes matrix shear the same way, with the same 0.05 threshold, when it flags a word italic.
  const shearDen = op.tm[0] * op.tm[0] + op.tm[1] * op.tm[1];
  const shearRaw = shearDen > 0 ? (op.tm[0] * op.tm[2] + op.tm[1] * op.tm[3]) / shearDen : 0;
  const shearNow = Math.abs(shearRaw) > 0.05 ? shearRaw : 0;
  const wantLean = spec.italic === true && !shearNow && !op.font?.italic;
  const unlean = spec.italic === false && shearNow;
  if ((wantLean || unlean) && target) {
    const s = wantLean ? FAUX_OBLIQUE_SKEW : -shearNow;
    const [a, b, c, d] = op.tm;
    before.push(`${formatPdfNumber(a)} ${formatPdfNumber(b)} ${formatPdfNumber(c + s * a)} ${formatPdfNumber(d + s * b)} ${formatPdfNumber(target[0])} ${formatPdfNumber(target[1])} Tm`);
    setsPen = true;
    after.push(`${formatPdfNumber(a)} ${formatPdfNumber(b)} ${formatPdfNumber(c)} ${formatPdfNumber(d)} ${formatPdfNumber(op.tlmAfter[4])} ${formatPdfNumber(op.tlmAfter[5])} Tm`);
    resetsPen = true;
  }
  return {
    before, after, setsPen, resetsPen,
  };
}

/**
 * Turn operator plans into record edits.
 * A record whose text a plan rewrites is folded into the edits, which replace it.
 * @param {GlyphOpMap} glyphOpMap
 * @param {Map<number, OpPlan>} plans
 * @returns {{ edits: Map<number, Array<{ start: number, end: number, text: string }>>, folded: Array<TextPatch> }}
 *   `edits` is keyed by the map's stream index.
 *   `folded` lists the page's records the edits replace.
 */
export function editsFromPlans(glyphOpMap, plans) {
  /** @type {Map<number, Array<{ start: number, end: number, text: string }>>} */
  const edits = new Map();
  /** @type {Map<TextPatch, Map<number, Array<{ start: number, end: number, text: string }>>>} */
  const rewrites = new Map();
  for (const plan of plans.values()) {
    const { op } = plan;
    const stream = glyphOpMap.streams[op.streamIdx];
    // A replacement that opens with a number must not run into a keyword before it (`Td0.99`), since a PDF reader takes the two as one token.
    const prev = op.start > 0 ? stream.text[op.start - 1] : ' ';
    const text = (/[\s()<>[\]{}/%]/.test(prev) ? '' : '\n') + rewriteShowOperator(op, stream.tokens, plan.actions, plan.pens);
    const list = edits.get(op.streamIdx) || [];
    edits.set(op.streamIdx, list);
    const seg = segmentAt(stream.segments, op.start);
    if (!seg) throw new Error('A show operator sits outside every stream segment.');
    if (!seg.rec) {
      list.push({ start: seg.origStart + (op.start - seg.start), end: seg.origStart + (op.end - seg.start), text });
      continue;
    }
    let byEdit = rewrites.get(seg.rec);
    if (!byEdit) { byEdit = new Map(); rewrites.set(seg.rec, byEdit); }
    const inner = byEdit.get(seg.editIdx) || [];
    byEdit.set(seg.editIdx, inner);
    inner.push({ start: op.start - seg.start, end: op.end - seg.start, text });
  }
  /** @type {Array<TextPatch>} */
  const folded = [];
  for (const [rec, byEdit] of rewrites) {
    folded.push(rec);
    const streamIdx = glyphOpMap.streams.findIndex((st) => recordTargets(rec, st.stream));
    const list = edits.get(streamIdx) || [];
    edits.set(streamIdx, list);
    rec.edits.forEach((e, i) => {
      const inner = byEdit.get(i);
      let text = e.text;
      if (inner) {
        for (const r of inner.slice().sort((x, y) => y.start - x.start)) text = text.slice(0, r.start) + r.text + text.slice(r.end);
      }
      list.push({ start: e.start, end: e.end, text });
    });
  }
  for (const list of edits.values()) list.sort((a, b) => a.start - b.start);
  return { edits, folded };
}

/**
 * The key a character is matched on exactly when an edit is verified.
 * Pen position and size are left out for the caller to compare within a tolerance.
 * @param {PositionedChar} c
 */
export function charStateKey(c) {
  let col = '';
  if (c.textColor) for (let i = 0; i < c.textColor.length; i++) col += (i > 0 ? ',' : '') + Math.round(c.textColor[i] * 1000);
  let stroke = '';
  if (c.renderMode) {
    stroke = `${c.renderMode}:${Math.round((c.strokeWidthPx || 0) * 100)}:`;
    if (c.strokeColor) for (let i = 0; i < c.strokeColor.length; i++) stroke += (i > 0 ? ',' : '') + Math.round(c.strokeColor[i] * 1000);
  }
  return `${c.text}|${c._font?.fontObjNum ?? ''}|${col}|${stroke}|${typeof c.alpha === 'number' ? Math.round(c.alpha * 1000) : 1000}|${c.invisible ? 1 : 0}`;
}
