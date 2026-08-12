/**
 * Geometry shared by the PDF export rewriter and the page renderer.
 * A native-text edit or redaction must suppress exactly the same glyphs on screen and in the exported file.
 */

import ocr from '../objects/ocrObjects.js';

/**
 * Map a rect from the page-pixel frame (top-left origin, the frame OCR words and edit records live in) to content-stream user space.
 * Inverts the box-origin + /Rotate transform the importer bakes into its initial CTM.
 * @param {bbox} bboxPx
 * @param {{width: number, height: number}} dims - Page dimensions in the page-pixel frame.
 * @param {number[]} box - Effective page box (CropBox when present, else MediaBox).
 * @param {number} rotate - Source PDF /Rotate (0/90/180/270).
 * @returns {?[number, number, number, number]} `[x0, y0, x1, y1]`, or null for a degenerate rect.
 */
export function pageRectToContentRect(bboxPx, dims, box, rotate) {
  const corners = [
    [bboxPx.left, bboxPx.top], [bboxPx.right, bboxPx.top],
    [bboxPx.left, bboxPx.bottom], [bboxPx.right, bboxPx.bottom],
  ];
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [px, py] of corners) {
    const [x, y] = pagePointToContentPoint(px, py, dims, box, rotate);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  if (!(x1 > x0 && y1 > y0)) return null;
  return [x0, y0, x1, y1];
}

/**
 * Map a point from the page-pixel frame to content-stream user space.
 * @param {number} px
 * @param {number} py
 * @param {{width: number, height: number}} dims - Page dimensions in the page-pixel frame.
 * @param {number[]} box - Effective page box (CropBox when present, else MediaBox).
 * @param {number} rotate - Source PDF /Rotate (0/90/180/270).
 * @returns {[number, number]}
 */
export function pagePointToContentPoint(px, py, dims, box, rotate) {
  const contentW = Math.abs(box[2] - box[0]);
  const contentH = Math.abs(box[3] - box[1]);
  const ox = Math.min(box[0], box[2]);
  const oy = Math.min(box[1], box[3]);
  const rot = ((rotate % 360) + 360) % 360;
  const visW = rot % 180 === 0 ? contentW : contentH;
  const visH = rot % 180 === 0 ? contentH : contentW;
  const vx = px * (visW / dims.width);
  const vy = visH - py * (visH / dims.height);
  if (rot === 90) return [contentW + ox - vy, vx + oy];
  if (rot === 180) return [contentW + ox - vx, contentH + oy - vy];
  if (rot === 270) return [vy + ox, contentH + oy - vx];
  return [vx + ox, vy + oy];
}

/**
 * Normalize one glyph's unicode string for identity comparison.
 * @param {?string} s
 * @returns {?string} Null when the string carries no comparable unicode (empty, or Private Use Area).
 */
export function foldGlyphText(s) {
  if (!s) return null;
  for (const ch of s) {
    const cp = /** @type {number} */ (ch.codePointAt(0));
    if (cp >= 0xE000 && cp <= 0xF8FF) return null;
  }
  const folded = ocr.replaceLigatures(s).toLowerCase();
  return folded.length > 0 ? folded : null;
}

/**
 * Map a text-edit record's glyph identities into content user space, the frame the strike tests glyph origins in.
 * @param {Array<TextEditGlyphWord>} glyphWords
 * @param {{width: number, height: number}} dims
 * @param {number[]} box
 * @param {number} rotate
 * @returns {{pts: Array<{u: ?string, x: number, y: number, f: ?number}>, tol: number}}
 */
export function mapTextEditGlyphs(glyphWords, dims, box, rotate) {
  /** @type {Array<{u: ?string, x: number, y: number, f: ?number}>} */
  const pts = [];
  for (const gw of glyphWords) {
    const f = Number.isFinite(gw.fontObjNum) ? /** @type {number} */ (gw.fontObjNum) : null;
    for (let i = 0; i < gw.chars.length; i++) {
      const [x, y] = pagePointToContentPoint(gw.x[i], gw.y[i], dims, box, rotate);
      pts.push({
        u: foldGlyphText(gw.chars[i]), x, y, f,
      });
    }
  }
  const [ax, ay] = pagePointToContentPoint(0, 0, dims, box, rotate);
  const [bx, by] = pagePointToContentPoint(1, 0, dims, box, rotate);
  const tol = 2 * Math.hypot(bx - ax, by - ay);
  return { pts, tol };
}

/**
 * Whether a strike-candidate glyph matches a recorded deleted glyph: origin within tolerance, font agreeing when both sides know it, and unicode agreeing when both sides have usable unicode.
 * A glyph with no usable unicode falls back to the origin and font test rather than matching or missing outright.
 * @param {{pts: Array<{u: ?string, x: number, y: number, f: ?number}>, tol: number}} gate
 * @param {?string} u - The candidate glyph's raw unicode string (un-normalized).
 * @param {?number} fontObjNum
 * @param {number} x - Glyph origin, content user space.
 * @param {number} y
 */
export function glyphIdentityMatches(gate, u, fontObjNum, x, y) {
  const uG = foldGlyphText(u);
  for (const p of gate.pts) {
    if (Math.abs(x - p.x) > gate.tol || Math.abs(y - p.y) > gate.tol) continue;
    if (p.f !== null && fontObjNum !== null && fontObjNum !== undefined && p.f !== fontObjNum) continue;
    if (uG !== null && p.u !== null) {
      if (uG === p.u) return true;
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Whether a glyph's approximate extent intersects any rect, in content user space.
 * The test is biased toward over-matching.
 * A glyph whose origin sits outside a rect but whose body crosses it must still count.
 * @param {number[]} trm - Full render matrix (size/Tz/rise prefix * Tm * CTM), 6 elements.
 * @param {number} advEm - Glyph advance in em units (PDF /Widths value / 1000).
 * @param {boolean} vertical
 * @param {Array<[number, number, number, number]>} rects - `[x0, y0, x1, y1]` user-space rects.
 * @param {number} [sizeCap] - When set, a rect only matches a glyph whose extent along the rect's short axis is at most `sizeCap` times the rect's own extent there.
 */
export function glyphEmBoxHitsRects(trm, advEm, vertical, rects, sizeCap) {
  let u0; let u1; let v0; let v1;
  if (vertical) {
    u0 = -0.6; u1 = 0.6; v0 = -1.1; v1 = 0.35;
  } else {
    u0 = -0.1; u1 = advEm + 0.05; v0 = -0.3; v1 = 0.95;
  }
  let gx0 = Infinity; let gy0 = Infinity; let gx1 = -Infinity; let gy1 = -Infinity;
  for (const [u, v] of [[u0, v0], [u1, v0], [u0, v1], [u1, v1]]) {
    const gx = u * trm[0] + v * trm[2] + trm[4];
    const gy = u * trm[1] + v * trm[3] + trm[5];
    gx0 = Math.min(gx0, gx); gy0 = Math.min(gy0, gy); gx1 = Math.max(gx1, gx); gy1 = Math.max(gy1, gy);
  }
  for (const b of rects) {
    if (gx0 < b[2] && gx1 > b[0] && gy0 < b[3] && gy1 > b[1]) {
      if (!sizeCap) return true;
      const rw = b[2] - b[0];
      const rh = b[3] - b[1];
      const glyphExtent = rh <= rw ? gy1 - gy0 : gx1 - gx0;
      if (glyphExtent <= sizeCap * (rh <= rw ? rh : rw)) return true;
    }
  }
  return false;
}

/**
 * Size cap for text-edit glyph suppression.
 * A same-line glyph's em box measures ~4-6 word-band heights, while a multi-line drop cap measures 3x that against a neighboring line's band.
 */
export const TEXT_EDIT_GLYPH_SIZE_CAP = 8;
