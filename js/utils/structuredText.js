import { assignParagraphs } from './reflowPars.js';

/**
 * Build structured text for a single page, with optional paragraph boundaries and footnote annotations.
 * Lines are emitted as `page:line  text` with 0-based indices.
 * Those indices are the addresses AI consumers quote back, so renumbering silently misdirects them.
 * @param {import('../containers/scribeDoc.js').ScribeDoc} doc
 * @param {number} pageIdx - 0-based page index
 * @param {Object} opts
 * @param {boolean} [opts.parAnnots]
 * @param {boolean} [opts.footnoteAnnots]
 * @returns {string}
 */
export function buildStructuredPageText(doc, pageIdx, { parAnnots, footnoteAnnots }) {
  const pageObj = doc.ocr.active[pageIdx];
  if (!pageObj || pageObj.lines.length === 0) return '';

  const hasPars = pageObj.pars && pageObj.pars.length > 0;
  if (!hasPars && parAnnots) {
    const angle = doc.pageMetrics[pageIdx]?.angle || 0;
    assignParagraphs(pageObj, angle);
  }

  let out = '';
  let currentParId = null;

  for (let h = 0; h < pageObj.lines.length; h++) {
    const line = pageObj.lines[h];
    if (!line || line.words.length === 0) continue;

    const par = line.par || null;
    const parId = par?.id || null;

    if (parAnnots && parId !== currentParId) {
      let header = `\n--- par:${parId || 'unknown'} [${par?.type || 'body'}]`;
      if (footnoteAnnots && par?.type === 'footnote' && par.footnoteRefId) {
        const refWordId = par.footnoteRefId;
        let refInfo = refWordId;
        for (let li = 0; li < pageObj.lines.length; li++) {
          const refWord = pageObj.lines[li].words.find((w) => w.id === refWordId);
          if (refWord) {
            refInfo = `${pageIdx}:${li} "${refWord.text}"`;
            break;
          }
        }
        header += ` ref:${refInfo}`;
      }
      header += ' ---';
      out += header;
      currentParId = parId;
    }

    const lineText = line.words.map((w) => w.text).join(' ');
    out += `\n${pageIdx}:${h}  ${lineText}`;

    if (footnoteAnnots) {
      const fnWords = line.words.filter((w) => w.footnoteParId);
      for (const w of fnWords) {
        out += ` [footnote "${w.text}" → par:${w.footnoteParId}]`;
      }
    }
  }

  return out;
}
