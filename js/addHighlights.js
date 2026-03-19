import { annotations, ocrAll } from './containers/dataContainer.js';
import ocr from './objects/ocrObjects.js';

const GROUP_PREFIX = 'hl-';

/**
 * @typedef {Object} HighlightSpec
 * @property {number} page - Page index (0-based).
 * @property {number} [startLine] - First line index to highlight (0-based). If omitted, uses quote-only mode.
 * @property {number} [endLine] - Last line index to highlight (0-based). If omitted, defaults to startLine.
 * @property {string} [text] - Quote text to highlight. In line mode, narrows the first/last line to the
 *   matching words. In quote-only mode (no startLine/endLine), searches the entire page for this text.
 * @property {string} [color='#ffff00'] - Hex color for the highlight.
 * @property {number} [opacity=0.4] - Opacity (0 to 1).
 * @property {string} [comment] - Comment text for the annotation.
 */

/**
 * Add highlight annotations to the current document using page:line references
 * or page-level quote matching.
 *
 * Two modes:
 * - **Line mode** (`startLine`/`endLine` provided): highlights the specified line range.
 *   If `text` is also provided, narrows the first and last lines to the matching words.
 * - **Quote-only mode** (only `page` + `text`): searches the entire page for the quote
 *   and highlights the matching words.
 *
 * @param {Array<HighlightSpec>} highlights
 * @returns {{ highlightsApplied: number, totalLinesHighlighted: number }}
 */
export function addHighlights(highlights) {
  let highlightsApplied = 0;
  let totalLinesHighlighted = 0;

  for (const highlight of highlights) {
    const pageObj = ocrAll.active[highlight.page];
    if (!pageObj) continue;

    if (highlight.startLine == null && !highlight.text) {
      throw new Error('Each highlight must specify either startLine or text (or both).');
    }

    const color = highlight.color || '#ffe93b';
    const opacity = highlight.opacity ?? 0.4;
    const groupId = `${GROUP_PREFIX}${highlightsApplied}`;
    const comment = highlight.comment || '';

    if (highlight.startLine != null) {
      const startLine = highlight.startLine;
      const endLine = highlight.endLine ?? startLine;

      const textWords = highlight.text ? highlight.text.trim().split(/\s+/) : [];
      const startSnippet = textWords.length > 0 ? textWords.slice(0, 3).join(' ') : null;
      const endSnippet = textWords.length > 0 ? textWords.slice(-3).join(' ') : null;

      for (let lineIdx = startLine; lineIdx <= endLine; lineIdx++) {
        const line = pageObj.lines[lineIdx];
        if (!line) continue;

        let wordsToHighlight = [...line.words];

        if (lineIdx === startLine && startSnippet) {
          const matchWords = ocr.getMatchingWordsInLine(startSnippet, line);
          if (matchWords.length > 0) {
            const firstMatchIdx = line.words.indexOf(matchWords[0]);
            if (firstMatchIdx >= 0) {
              wordsToHighlight = line.words.slice(firstMatchIdx);
            }
          }
        }

        if (lineIdx === endLine && endSnippet) {
          const matchWords = ocr.getMatchingWordsInLine(endSnippet, line);
          if (matchWords.length > 0) {
            const lastMatchIdx = line.words.indexOf(matchWords[matchWords.length - 1]);
            if (lastMatchIdx >= 0) {
              const startIdx = line.words.indexOf(wordsToHighlight[0]);
              wordsToHighlight = line.words.slice(
                startIdx >= 0 ? startIdx : 0,
                lastMatchIdx + 1,
              );
            }
          }
        }

        for (const word of wordsToHighlight) {
          annotations.pages[highlight.page].push({
            bbox: word.bbox, color, opacity, groupId, comment,
          });
        }
        totalLinesHighlighted++;
      }
    } else if (highlight.text) {
      const matchWords = ocr.getMatchingWords(highlight.text, pageObj);
      for (const word of matchWords) {
        annotations.pages[highlight.page].push({
          bbox: word.bbox, color, opacity, groupId, comment,
        });
      }
      if (matchWords.length > 0) totalLinesHighlighted++;
    }

    highlightsApplied++;
  }

  return { highlightsApplied, totalLinesHighlighted };
}

/**
 * Remove all highlights previously added by {@link addHighlights}.
 */
export function clearHighlights() {
  for (let p = 0; p < annotations.pages.length; p++) {
    annotations.pages[p] = annotations.pages[p]
      .filter((a) => !a.groupId?.startsWith(GROUP_PREFIX));
  }
}
