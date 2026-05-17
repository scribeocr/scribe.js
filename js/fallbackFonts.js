/**
 * Fallback fonts registered with @scribe.js/canvas once per process so any
 * codepoint outside the embedded/substituted font has a glyph to fall back
 * to in the Node render path. Skia does per-glyph fallback through the font
 * chain; these aliases sit at the end of every render chain.
 */

const FILES = [
  { path: '../fonts/NotoSansSC-Regular.ttf', alias: '_scribe_fallback_sc' },
  { path: '../fonts/fallback/NotoSansKR-Regular.otf', alias: '_scribe_fallback_kr' },
  { path: '../fonts/fallback/NotoSansSymbols-Regular.ttf', alias: '_scribe_fallback_symbols' },
  { path: '../fonts/fallback/NotoSansSymbols2-Regular.ttf', alias: '_scribe_fallback_symbols2' },
  { path: '../fonts/fallback/NotoSansArabic-Regular.ttf', alias: '_scribe_fallback_arabic' },
  { path: '../fonts/fallback/NotoSansHebrew-Regular.ttf', alias: '_scribe_fallback_hebrew' },
  { path: '../fonts/fallback/NotoSansDevanagari-Regular.ttf', alias: '_scribe_fallback_devanagari' },
  { path: '../fonts/fallback/NotoSansBengali-Regular.ttf', alias: '_scribe_fallback_bengali' },
  { path: '../fonts/fallback/NotoSansTamil-Regular.ttf', alias: '_scribe_fallback_tamil' },
  { path: '../fonts/fallback/NotoSansTelugu-Regular.ttf', alias: '_scribe_fallback_telugu' },
  { path: '../fonts/fallback/NotoSansGujarati-Regular.ttf', alias: '_scribe_fallback_gujarati' },
  { path: '../fonts/fallback/NotoSansGurmukhi-Regular.ttf', alias: '_scribe_fallback_gurmukhi' },
  { path: '../fonts/fallback/NotoSansKannada-Regular.ttf', alias: '_scribe_fallback_kannada' },
  { path: '../fonts/fallback/NotoSansMalayalam-Regular.ttf', alias: '_scribe_fallback_malayalam' },
  { path: '../fonts/fallback/NotoSansThai-Regular.ttf', alias: '_scribe_fallback_thai' },
  { path: '../fonts/fallback/NotoSansLao-Regular.ttf', alias: '_scribe_fallback_lao' },
  { path: '../fonts/fallback/NotoSansKhmer-Regular.ttf', alias: '_scribe_fallback_khmer' },
  { path: '../fonts/fallback/NotoSansMyanmar-Regular.ttf', alias: '_scribe_fallback_myanmar' },
];

export const FALLBACK_CHAIN = FILES.map((f) => `"${f.alias}"`).join(', ');

/**
 * Register all fallback fonts with the given @scribe.js/canvas module.
 * Node-only; safe to call multiple times (GlobalFonts.register dedups on
 * the alias name).
 *
 * @param {*} CanvasNode - resolved import of '@scribe.js/canvas'
 */
export async function registerFallbackFonts(CanvasNode) {
  if (typeof process === 'undefined') return;
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  for (const { path, alias } of FILES) {
    try {
      const bytes = readFileSync(fileURLToPath(new URL(path, import.meta.url)));
      CanvasNode.GlobalFonts.register(bytes, alias);
    } catch (e) {
      console.warn(`[fallbackFonts] Failed to register ${alias} (${path}): ${e.message}`);
    }
  }
}
