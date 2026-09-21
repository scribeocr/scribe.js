import ocr from './objects/ocrObjects.js';

/**
 * Rewrite the text of every native word drawn with a Type 3 glyph whose outline is in `outlines`, from the document's current mappings.
 * Idempotent, so an undo or redo re-runs it after restoring the table.
 * @param {import('./containers/scribeDoc.js').ScribeDoc} doc
 * @param {?Set<string>} outlines - The outlines to rewrite; every outline when null.
 * @returns {Array<number>} The pages whose words changed.
 */
export function applyType3GlyphMappings(doc, outlines) {
  const pages = new Set();
  // Every layer holding parsed pages is rewritten, since a recognition run clones the native pages it does not replace and a `.scribe` restore installs them under its own name.
  for (const [name, layer] of Object.entries(doc.ocr)) {
    if (name === 'active' || !Array.isArray(layer)) continue;
    for (let n = 0; n < layer.length; n++) {
      const page = layer[n];
      const nt = doc.nativeText.pages[n];
      const hashes = doc.images.getType3GlyphHashesSync(n);
      if (!page || page.textSource !== 'pdf' || !nt || !hashes) continue;
      for (const line of page.lines) {
        for (const word of line.words) {
          const entry = nt[word.id];
          if (!entry?.codes || !word.chars) continue;
          const font = hashes.fonts.get(entry.fontObjNum);
          if (!font) continue;
          let changed = false;
          for (let i = 0; i < entry.codes.length && i < word.chars.length; i++) {
            const code = entry.codes[i];
            if (code < 0) continue;
            const hash = font.byCode.get(code)?.hash;
            if (!hash || (outlines && !outlines.has(hash))) continue;
            // The parser's rule for a Type 3 glyph with no Unicode mapping (parsePdfFonts.js): the recorded character, else the placeholder U+E000 + code.
            const text = doc.type3GlyphMappings.get(hash) ?? String.fromCodePoint(0xE000 + code);
            if (word.chars[i].text === text) continue;
            word.chars[i].text = text;
            changed = true;
          }
          if (!changed) continue;
          const text = ocr.replaceLigatures(word.chars.map((c) => c.text).join(''));
          // Style runs index into the text, so a length change from a multi-character value would misplace them.
          if (word.styleRuns && text.length !== word.text.length) word.styleRuns = null;
          word.text = text;
          pages.add(n);
        }
      }
    }
  }
  return [...pages].sort((a, b) => a - b);
}

/**
 * Fetch the glyph codes of every native word that shows a Type 3 placeholder but has none recorded.
 * Only a session saved before the parser recorded codes has such words.
 * Each page that holds them is parsed again.
 * @param {import('./containers/scribeDoc.js').ScribeDoc} doc
 * @param {?Array<number>} [pages] - The pages to check; every page when null.
 */
export async function ensureType3GlyphCodes(doc, pages = null) {
  const layers = Object.entries(doc.ocr).filter(([name, layer]) => name !== 'active' && Array.isArray(layer)).map(([, layer]) => layer);
  for (let n = 0; n < doc.pageMetrics.length; n++) {
    if (pages && !pages.includes(n)) continue;
    const nt = doc.nativeText.pages[n];
    const pm = doc.pageMetrics[n];
    const dims = doc.images.pdfDims300[n];
    if (!nt || !pm || !dims) continue;
    const stale = layers.some((layer) => layer[n]?.textSource === 'pdf'
      && layer[n].lines.some((line) => line.words.some((w) => nt[w.id] && !nt[w.id].codes && /[\uE000-\uE0FF]/.test(w.text))));
    if (!stale) continue;
    const scheduler = await doc.images.resolveSource(pm).getScheduler();
    const fresh = (await scheduler.parsePdfPage({ pageIndex: pm.sourcePageN ?? n, dpi: 300 * Math.min(dims.width, 3500) / dims.width })).nativeText || {};
    for (const [id, entry] of Object.entries(nt)) {
      const codes = fresh[id]?.codes;
      // The arrays of a record are index-aligned, so a fresh parse that segmented the word differently is not trusted.
      if (!codes || entry.codes || (entry.penX && entry.penX.length !== codes.length)) continue;
      entry.codes = codes;
    }
  }
}

/**
 * Record characters against Type 3 glyph outlines and apply them in place as one undoable step.
 * @param {import('./containers/scribeDoc.js').ScribeDoc} doc
 * @param {Iterable<[string, ?string]>} entries - `[pathHash, text]` pairs; a null or empty text removes the outline's character.
 * @param {{ label?: string }} [options]
 * @returns {Promise<Array<number>>} The pages whose words changed.
 */
export async function setType3GlyphMappings(doc, entries, options = {}) {
  /** @type {Map<string, ?string>} */
  const after = new Map();
  for (const [hash, text] of entries) after.set(hash, text || null);
  if (!after.size) return [];
  if (!doc.images.inputModes.pdf) throw new Error('Type 3 glyph mappings need the document\'s PDF.');
  // Every source's hashes settle first, so the apply and its undo run synchronously.
  const sources = new Set();
  for (let n = 0; n < doc.pageMetrics.length; n++) {
    const id = doc.pageMetrics[n]?.sourceId ?? 'p';
    if (!doc.nativeText.pages[n] || sources.has(id)) continue;
    sources.add(id);
    await doc.images.getType3GlyphHashes(n);
  }
  await ensureType3GlyphCodes(doc);
  /** @type {Map<string, ?string>} */
  const before = new Map();
  for (const hash of after.keys()) before.set(hash, doc.type3GlyphMappings.get(hash) ?? null);
  const apply = (/** @type {Map<string, ?string>} */ table) => {
    for (const [hash, text] of table) {
      if (text == null) doc.type3GlyphMappings.delete(hash);
      else doc.type3GlyphMappings.set(hash, text);
    }
    return applyType3GlyphMappings(doc, new Set(table.keys()));
  };
  const pages = apply(after);
  doc.docHistory.record({
    surface: 'glyphs', label: options.label ?? 'Edit characters', undo: () => apply(before), redo: () => apply(after),
  });
  return pages;
}
