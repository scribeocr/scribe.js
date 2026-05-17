import { normalizeBase14Name } from './standardFontMetrics.js';

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
