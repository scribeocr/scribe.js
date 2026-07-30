/**
 * Glyph resolution for edited native text.
 * The viewer raster and the PDF export both use the face and glyph resolved here, so an edited character cannot render one way on screen and another way in the exported file.
 */

import opentype from '../font-parser/src/index.js';
import {
  base14ToBundledFont, cssFamilyToBundledFont, genericToBundledFont, cssGenericForFontObj,
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
  };
}

/**
 * Resolve one replacement character against a word's original font and style.
 * @param {string} ch - One code point.
 * @param {?EditFontProgram} orig - The word's original font program, or null when the word has none (non-embedded source font).
 * @param {{ bold?: boolean, italic?: boolean }} style
 * @returns {{ kind: 'orig', codepoint: number, gid: number, advEm: number }
 *   | { kind: 'bundled', codepoint: number, gid: number, advEm: number,
 *       family: string, styleKey: string, font: import('../font-parser/src/index.js').Font,
 *       fontFaceName: string, fontFaceStyle: string, fontFaceWeight: string }
 *   | { kind: 'tofu', advEm: number }}
 */
export function resolveReplacementChar(ch, orig, style) {
  const codepoint = /** @type {number} */ (ch.codePointAt(0));

  if (orig?.font) {
    const gid = orig.font.charToGlyphIndex(ch);
    if (gid > 0) {
      const glyph = orig.font.glyphs.get(gid);
      // A subset font keeps its whole cmap but strips the outlines it never drew, so a mapped glyph can still be blank.
      // Accepting a blank one paints a correctly sized gap where the typed character should be.
      // Whitespace is blank in every font, and its original advance is what holds the edited line's spacing.
      const drawable = /\s/.test(ch) || !!glyph.isComposite
        || (glyph.path?.commands || []).some((c) => c.type === 'L' || c.type === 'C' || c.type === 'Q');
      if (drawable) {
        const advEm = glyph.advanceWidth / orig.font.unitsPerEm;
        return {
          kind: 'orig', codepoint, gid, advEm,
        };
      }
    }
  }

  const hints = { bold: !!style?.bold, italic: !!style?.italic };
  const baseName = orig?.baseName || '';
  const sub = base14ToBundledFont(baseName, hints)
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
        const advEm = bundled.opentype.glyphs.get(gid).advanceWidth / bundled.opentype.unitsPerEm;
        return {
          kind: 'bundled',
          codepoint,
          gid,
          advEm,
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
