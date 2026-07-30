/**
 * Glyph resolution for edited native text.
 * The viewer raster and the PDF export both use the face and glyph resolved here, so an edited character cannot render one way on screen and another way in the exported file.
 */

import opentype from '../font-parser/src/index.js';
import {
  base14ToBundledFont, cssFamilyToBundledFont, genericToBundledFont, cssGenericForFontObj,
  extendedFamilyToBundledFont,
} from './fonts/base14Substitution.js';
import { standardFontToCSS } from './fonts/standardFontMetrics.js';
import { GlobalFonts } from '../containers/fontContainer.js';

/**
 * @typedef {Object} EditFontProgram
 * @property {'original'|'rebuilt'|'none'} kind
 * @property {?import('../font-parser/src/index.js').Font} font
 * @property {boolean} allGlyphsEmpty
 * @property {string} baseName
 * @property {string} familyName
 * @property {boolean} bold
 * @property {boolean} italic
 * @property {?boolean} serifFlag
 * @property {?number} [italicAngleDeg]
 * @property {?number} [capHeightPdf]
 * @property {?number} [xHeightPdf]
 * @property {?number} [stemV]
 * @property {Map<string, {sizeMult: number, stretch: number, monoAdvEm?: number}>} [fits]
 */

/**
 * Parse a `getPdfFontBytes` payload into the resolver's per-font entry.
 * @param {?{ kind: string, bytes?: ArrayBuffer, allGlyphsEmpty?: boolean, baseName: string, familyName: string, bold: boolean, italic: boolean, serifFlag: ?boolean }} payload
 * @returns {?EditFontProgram}
 */
export function parseEditFontPayload(payload) {
  if (!payload) return null;
  let font = null;
  if (payload.bytes && !payload.allGlyphsEmpty) {
    try {
      font = opentype.parse(payload.bytes);
    } catch (_e) {
      font = null;
    }
  }
  return {
    kind: /** @type {'original'|'rebuilt'|'none'} */ (payload.kind),
    font,
    allGlyphsEmpty: !!payload.allGlyphsEmpty,
    baseName: payload.baseName,
    familyName: payload.familyName,
    bold: !!payload.bold,
    italic: !!payload.italic,
    serifFlag: payload.serifFlag ?? null,
    italicAngleDeg: payload.italicAngleDeg ?? null,
    capHeightPdf: payload.capHeightPdf ?? null,
    xHeightPdf: payload.xHeightPdf ?? null,
    stemV: payload.stemV ?? null,
  };
}

/**
 * The glyph a character maps to, or null when the font has no drawable outline for it.
 * @param {import('../font-parser/src/index.js').Font} font
 * @param {string} ch
 * @returns {?{gid: number, glyph: object}}
 */
function drawableGlyph(font, ch) {
  const gid = font.charToGlyphIndex(ch);
  if (!(gid > 0)) return null;
  const glyph = font.glyphs.get(gid);
  // A subset font keeps its whole cmap but strips the outlines it never drew, so a mapped glyph can still be blank.
  // Whitespace is blank in every font, and its original advance is what holds the edited line's spacing.
  const drawable = /\s/.test(ch) || !!glyph.isComposite
    || (glyph.path?.commands || []).some((c) => c.type === 'L' || c.type === 'C' || c.type === 'Q');
  return drawable ? { gid, glyph } : null;
}

const FIT_PROBE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const XH_PROBE = 'xonezscuvw';
const CAP_PROBE = 'HIEFTLBD';

/** @param {import('../font-parser/src/index.js').Font} font @param {string} chars */
function medianInkTop(font, chars) {
  const tops = [];
  for (const ch of chars) {
    const d = drawableGlyph(font, ch);
    if (!d) continue;
    try {
      const bb = d.glyph.getBoundingBox();
      if (bb.y2 > bb.y1) tops.push(bb.y2 / font.unitsPerEm);
    } catch { /* skip unmeasurable glyphs */ }
  }
  if (tops.length < 2) return null;
  tops.sort((a, b) => a - b);
  return tops[Math.floor(tops.length / 2)];
}

/**
 * Fit a bundled substitute to the word's original font.
 * `sizeMult` matches the original's x-height, and `stretch` matches its advance widths.
 * @param {EditFontProgram} orig
 * @param {import('../font-parser/src/index.js').Font} subFont
 * @returns {{sizeMult: number, stretch: number, monoAdvEm?: number}}
 */
function bundledFit(orig, subFont) {
  const f = /** @type {import('../font-parser/src/index.js').Font} */ (orig.font);
  const wd = [];
  const ws = [];
  let lowerN = 0;
  for (const ch of FIT_PROBE) {
    const d = drawableGlyph(f, ch);
    if (!d || !(d.glyph.advanceWidth > 0)) continue;
    const sg = subFont.charToGlyphIndex(ch);
    if (!(sg > 0)) continue;
    const sAdv = subFont.glyphs.get(sg).advanceWidth;
    if (!(sAdv > 0)) continue;
    wd.push(d.glyph.advanceWidth / f.unitsPerEm);
    ws.push(sAdv / subFont.unitsPerEm);
    if (/[a-z]/.test(ch)) lowerN += 1;
  }

  let sizeMult = 1;
  const xhS = medianInkTop(subFont, XH_PROBE);
  const capS = medianInkTop(subFont, CAP_PROBE);
  const xhD = lowerN >= 2 ? medianInkTop(f, XH_PROBE) : null;
  const capD = medianInkTop(f, CAP_PROBE);
  if (xhD && xhS) sizeMult = xhD / xhS;
  else if (capD && capS) sizeMult = capD / capS;
  else if (orig.xHeightPdf && orig.xHeightPdf > 200 && xhS) sizeMult = orig.xHeightPdf / 1000 / xhS;
  else if (orig.capHeightPdf && orig.capHeightPdf > 300 && capS) sizeMult = orig.capHeightPdf / 1000 / capS;
  sizeMult = Math.min(1.15, Math.max(0.85, sizeMult));

  let stretch = 1;
  let monoAdvEm;
  if (wd.length >= 4) {
    let num = 0;
    let den = 0;
    let min = Infinity;
    let max = 0;
    let sum = 0;
    for (let i = 0; i < wd.length; i++) {
      num += wd[i] * ws[i];
      den += ws[i] * ws[i];
      if (wd[i] < min) min = wd[i];
      if (wd[i] > max) max = wd[i];
      sum += wd[i];
    }
    if (den > 0) {
      const kTotal = num / den;
      // Metric-clone pairs measure a slightly-off x-height that stretch then cancels, leaving the advances right but the glyphs distorted.
      if (Math.abs(kTotal - 1) < 0.035 && Math.abs(sizeMult - 1) < 0.06) sizeMult = 1;
      else if (Math.abs(sizeMult - 1) < 0.02) sizeMult = 1;
      stretch = Math.min(1.25, Math.max(0.8, kTotal / sizeMult));
      if (Math.abs(stretch - 1) < 0.02) stretch = 1;
    }
    // A monospace original needs every advance equal, not proportionally fitted.
    if (max / min < 1.02) monoAdvEm = sum / wd.length;
  } else if (Math.abs(sizeMult - 1) < 0.02) {
    sizeMult = 1;
  }
  const r = (v) => Math.round(v * 10000) / 10000;
  return monoAdvEm !== undefined
    ? { sizeMult: r(sizeMult), stretch: r(stretch), monoAdvEm: r(monoAdvEm) }
    : { sizeMult: r(sizeMult), stretch: r(stretch) };
}

/**
 * Resolve one replacement character against a word's original font and style.
 * @param {string} ch - One code point.
 * @param {?EditFontProgram} orig - The word's original font program, or null when the word has none (non-embedded source font).
 * @param {{ bold?: boolean, italic?: boolean }} style
 * @returns {{ kind: 'orig', codepoint: number, gid: number, advEm: number }
 *   | { kind: 'bundled', codepoint: number, gid: number, advEm: number,
 *       sizeMult: number, stretch: number,
 *       family: string, styleKey: string, font: import('../font-parser/src/index.js').Font,
 *       fontFaceName: string, fontFaceStyle: string, fontFaceWeight: string }
 *   | { kind: 'tofu', advEm: number }}
 *   Bundled `advEm` is the fitted advance in em of the word's own size.
 *   `sizeMult` scales the drawn face size and `stretch` the glyph width, both already folded into `advEm`.
 */
export function resolveReplacementChar(ch, orig, style) {
  const codepoint = /** @type {number} */ (ch.codePointAt(0));

  if (orig?.font) {
    const d = drawableGlyph(orig.font, ch);
    if (d) {
      const advEm = d.glyph.advanceWidth / orig.font.unitsPerEm;
      return {
        kind: 'orig', codepoint, gid: d.gid, advEm,
      };
    }
  }

  const hints = { bold: !!style?.bold, italic: !!style?.italic };
  const baseName = orig?.baseName || '';
  const sub = (orig?.font ? extendedFamilyToBundledFont(baseName, hints) : null)
    || base14ToBundledFont(baseName, hints)
    || cssFamilyToBundledFont(standardFontToCSS(baseName), hints)
    || genericToBundledFont(cssGenericForFontObj({
      baseName, familyName: orig?.familyName, serifFlag: orig?.serifFlag ?? undefined,
    }), hints);
  if (sub && sub.variant) {
    const styleKey = sub.variant === 'Regular' ? 'normal'
      : sub.variant === 'Bold' ? 'bold'
        : sub.variant === 'Italic' ? 'italic' : 'boldItalic';
    const bundled = GlobalFonts.raw?.[sub.family]?.[styleKey] || GlobalFonts.raw?.[sub.family]?.normal;
    if (bundled?.opentype) {
      const gid = bundled.opentype.charToGlyphIndex(ch);
      if (gid > 0) {
        let fit = null;
        if (orig?.font) {
          const fitKey = `${bundled.family}/${styleKey}`;
          if (!orig.fits) orig.fits = new Map();
          fit = orig.fits.get(fitKey);
          if (!fit) {
            fit = bundledFit(orig, bundled.opentype);
            orig.fits.set(fitKey, fit);
          }
        }
        const sizeMult = fit?.sizeMult ?? 1;
        const stretch = fit?.stretch ?? 1;
        const baseAdv = bundled.opentype.glyphs.get(gid).advanceWidth / bundled.opentype.unitsPerEm;
        const advEm = fit?.monoAdvEm ?? baseAdv * sizeMult * stretch;
        return {
          kind: 'bundled',
          codepoint,
          gid,
          advEm,
          sizeMult,
          stretch,
          family: bundled.family,
          styleKey,
          font: bundled.opentype,
          fontFaceName: bundled.fontFaceName,
          fontFaceStyle: bundled.fontFaceStyle,
          fontFaceWeight: bundled.fontFaceWeight,
        };
      }
    }
  }

  return { kind: 'tofu', advEm: 0.5 };
}
