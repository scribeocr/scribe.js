import { normalizeBase14Name, standardFontToCSS } from './standardFontMetrics.js';

/**
 * Classify a parsed PDF font into a CSS generic family keyword ('sans-serif'|'serif'|'monospace'|'cursive').
 * Used as the third tier of the substitution cascade (after the embedded face and standardFontToCSS),
 * so a non-embedded font whose name resembles no standard family still renders in the correct style instead of the platform default serif.
 *
 * @param {{ baseName?: string, familyName?: string, serifFlag?: boolean }} fontObj
 * @returns {'sans-serif'|'serif'|'monospace'|'cursive'}
 */
export function cssGenericForFontObj(fontObj) {
  const css = standardFontToCSS(fontObj.baseName || '');
  if (css) {
    if (/monospace/i.test(css)) return 'monospace';
    if (/cursive/i.test(css)) return 'cursive';
    if (/sans-serif/i.test(css)) return 'sans-serif';
    if (/serif/i.test(css)) return 'serif';
  }
  // Strip subset prefix "ABCDEF+" before name-based checks.
  const name = (fontObj.baseName || fontObj.familyName || '').replace(/^[A-Z]{6}\+/, '');
  if (/mono|courier|consola|typewriter|fixedsys|andale|inconsolata|menlo|lucidacons|sourcecode|firacode/i.test(name)) return 'monospace';
  if (/script|cursive|brush|chancery|handwrit|calligraph/i.test(name)) return 'cursive';
  // Match "sans"/"serif" used in camelCase. "sans" is tested first so "sans-serif" forms stay sans.
  const lowerName = name.toLowerCase();
  if (lowerName.includes('sans') || /gothic/i.test(name)) return 'sans-serif';
  if (lowerName.includes('serif')) return 'serif';
  if (fontObj.serifFlag) return 'serif';
  return 'sans-serif';
}

/**
 * Resolve a Base14 PDF font name to its bundled substitute.
 *
 * @param {string} baseName - PDF BaseFont name
 * @param {{ bold?: boolean, italic?: boolean }} [hints] - bold/italic flags
 * @returns {{
 *   family: 'NimbusMono'|'NimbusSans'|'NimbusRoman'|'StandardSymbolsPS'|'Dingbats',
 *   variant: 'Regular'|'Bold'|'Italic'|'BoldItalic'|null,
 *   url: URL,
 *   alias: string,
 *   faceWeight: 'normal'|'bold',
 *   faceStyle: 'normal'|'italic',
 * } | null}
 */
export function base14ToBundledFont(baseName, { bold = false, italic = false } = {}) {
  const canonical = normalizeBase14Name(baseName);
  if (!canonical) return null;
  if (canonical === 'ZapfDingbats') {
    return {
      family: 'Dingbats',
      variant: null,
      url: new URL('../../../fonts/Dingbats.woff', import.meta.url),
      alias: '_scribe_dingbats',
      faceWeight: 'normal',
      faceStyle: 'normal',
    };
  }
  if (canonical === 'Symbol') {
    return {
      family: 'StandardSymbolsPS',
      variant: null,
      url: new URL('../../../fonts/StandardSymbolsPS.woff', import.meta.url),
      alias: '_scribe_standardsymbolsps',
      faceWeight: 'normal',
      faceStyle: 'normal',
    };
  }
  /** @type {'NimbusMono'|'NimbusSans'|'NimbusRoman'} */
  let family;
  if (canonical.startsWith('Courier')) family = 'NimbusMono';
  else if (canonical.startsWith('Helvetica')) family = 'NimbusSans';
  else if (canonical.startsWith('Times')) family = 'NimbusRoman';
  else return null;
  const isBold = bold || canonical.includes('Bold');
  const isItalic = italic || canonical.includes('Italic') || canonical.includes('Oblique');
  const variant = isBold && isItalic ? 'BoldItalic' : isBold ? 'Bold' : isItalic ? 'Italic' : 'Regular';
  return {
    family,
    variant,
    url: new URL(`../../../fonts/all/${family}-${variant}.woff`, import.meta.url),
    alias: `_scribe_${family.toLowerCase()}_${variant.toLowerCase()}`,
    faceWeight: isBold ? 'bold' : 'normal',
    faceStyle: isItalic ? 'italic' : 'normal',
  };
}

/**
 * Build a bundled-font descriptor by CSS classification, for non-Base14 fonts
 * whose names resemble standard families (e.g. Garamond, Bookman, Roboto).
 *
 * @param {string} cssFamily - return value of standardFontToCSS(baseName)
 * @param {{ bold?: boolean, italic?: boolean }} [hints]
 */
export function cssFamilyToBundledFont(cssFamily, { bold = false, italic = false } = {}) {
  if (!cssFamily) return null;
  let family;
  if (/sans-serif/i.test(cssFamily)) family = 'NimbusSans';
  else if (/serif/i.test(cssFamily)) family = 'NimbusRoman';
  else return null;
  const variant = bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular';
  return {
    family,
    variant,
    url: new URL(`../../../fonts/all/${family}-${variant}.woff`, import.meta.url),
    alias: `_scribe_${family.toLowerCase()}_${variant.toLowerCase()}`,
    faceWeight: bold ? 'bold' : 'normal',
    faceStyle: italic ? 'italic' : 'normal',
  };
}

/**
 * Build a bundled-font descriptor from a CSS generic keyword. Used as the
 * third-tier substitution when standardFontToCSS does not recognize the
 * font's name but a generic style can still be inferred.
 *
 * @param {'serif'|'sans-serif'|'monospace'|'cursive'|string|null} generic
 * @param {{ bold?: boolean, italic?: boolean }} [hints]
 */
export function genericToBundledFont(generic, { bold = false, italic = false } = {}) {
  let family;
  if (generic === 'sans-serif') family = 'NimbusSans';
  else if (generic === 'serif') family = 'NimbusRoman';
  else if (generic === 'monospace') family = 'NimbusMono';
  else return null;
  const variant = bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : 'Regular';
  return {
    family,
    variant,
    url: new URL(`../../../fonts/all/${family}-${variant}.woff`, import.meta.url),
    alias: `_scribe_${family.toLowerCase()}_${variant.toLowerCase()}`,
    faceWeight: bold ? 'bold' : 'normal',
    faceStyle: italic ? 'italic' : 'normal',
  };
}
