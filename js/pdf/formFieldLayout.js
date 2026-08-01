/**
 * @typedef {Object} FieldLayoutWord
 * @property {string} text
 * @property {number} x0 - Left edge, /Rect-local pts.
 * @property {number} x1 - Right edge, /Rect-local pts.
 */

/**
 * @typedef {Object} FieldLayoutLine
 * @property {string} text
 * @property {number} x
 * @property {number} y - Baseline.
 * @property {FieldLayoutWord[]} words
 */

/**
 * Lays out a form-field value inside its widget rect.
 * `renderPdfPage.js` synthesizes field appearances with its own copy of these rules, so edit both together.
 *
 * @param {string} value
 * @param {number} rectW
 * @param {number} rectH
 * @param {Object} [opts]
 * @param {boolean} [opts.multiline] - /Ff bit 13.
 * @param {?number} [opts.maxLen] - Comb cell count; combined with `comb` (Ff bit 25) one char occupies each cell.
 * @param {boolean} [opts.comb]
 * @param {number} [opts.quadding] - /Q: 0 left, 1 center, 2 right.
 * @param {?string} [opts.da] - /DA default-appearance string; its Tf size wins, 0 or absent means auto-size.
 * @returns {{ fontSize: number, lines: FieldLayoutLine[] }}
 */
export function layoutFieldValue(value, rectW, rectH, opts = {}) {
  const tfMatch = opts.da ? /\/[\w+-]+\s+([\d.]+)\s+Tf/.exec(opts.da) : null;
  let fontSize = tfMatch ? Number(tfMatch[1]) : 10;
  if (!fontSize) fontSize = Math.min(12, Math.max(6, rectH - 4));
  const avgCharW = fontSize * 0.5;
  const pad = 2;
  /** @type {FieldLayoutLine[]} */
  const lines = [];

  const wordsOf = (text, lineX, charW) => {
    /** @type {FieldLayoutWord[]} */
    const out = [];
    for (const m of text.matchAll(/\S+/g)) {
      out.push({ text: m[0], x0: lineX + m.index * charW, x1: lineX + (m.index + m[0].length) * charW });
    }
    return out;
  };

  if (opts.multiline) {
    const maxChars = Math.max(1, Math.floor((rectW - 2 * pad) / avgCharW));
    /** @type {string[]} */
    const wrapped = [];
    for (const para of value.split(/\r\n|\r|\n/)) {
      const words = para.split(/\s+/).filter((w) => w.length > 0);
      if (words.length === 0) { wrapped.push(''); continue; }
      let line = '';
      for (const w of words) {
        if (line.length === 0) line = w;
        else if ((line.length + 1 + w.length) <= maxChars) line += ` ${w}`;
        else { wrapped.push(line); line = w; }
      }
      if (line.length > 0) wrapped.push(line);
    }
    const leading = fontSize * 1.15;
    let y = rectH - pad - fontSize;
    for (const text of wrapped) {
      if (text.length > 0) {
        lines.push({
          text, x: pad, y, words: wordsOf(text, pad, avgCharW),
        });
      }
      y -= leading;
    }
    return { fontSize, lines };
  }

  const y = Math.max(pad, (rectH - fontSize) / 2 + fontSize * 0.2);
  if (opts.comb && opts.maxLen && opts.maxLen > 0) {
    const cellW = rectW / opts.maxLen;
    /** @type {FieldLayoutWord[]} */
    const combWords = [];
    for (const m of value.matchAll(/\S+/g)) {
      combWords.push({ text: m[0], x0: m.index * cellW, x1: (m.index + m[0].length) * cellW });
    }
    lines.push({
      text: value, x: 0, y, words: combWords,
    });
    return { fontSize, lines };
  }

  const textW = value.length * avgCharW;
  let x = pad;
  if (opts.quadding === 1) x = Math.max(pad, (rectW - textW) / 2);
  else if (opts.quadding === 2) x = Math.max(pad, rectW - textW - pad);
  lines.push({
    text: value, x, y, words: wordsOf(value, x, avgCharW),
  });
  return { fontSize, lines };
}
