import ocr from './objects/ocrObjects.js';
import { calcBboxUnion } from './utils/miscUtils.js';

/** @typedef {import('./containers/scribeDoc.js').ScribeDoc} ScribeDoc */

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
 * @param {ScribeDoc} doc
 * @param {Array<HighlightSpec>} highlights
 * @returns {{
 *   highlightsApplied: number,
 *   totalLinesHighlighted: number,
 *   groups: Array<{ page: number, groupId: string, bbox: bbox }>,
 * }}
 */
export function addHighlights(doc, highlights) {
  let highlightsApplied = 0;
  let totalLinesHighlighted = 0;
  /** @type {Array<{ page: number, groupId: string, bbox: bbox }>} */
  const groups = [];

  for (const highlight of highlights) {
    const pageObj = doc.ocr.active[highlight.page];
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
          doc.annotations.pages[highlight.page].push({
            type: 'highlight', bbox: word.bbox, color, opacity, groupId, comment,
          });
        }
        totalLinesHighlighted++;
      }
    } else if (highlight.text) {
      const matchWords = ocr.getMatchingWords(highlight.text, pageObj);
      for (const word of matchWords) {
        doc.annotations.pages[highlight.page].push({
          type: 'highlight', bbox: word.bbox, color, opacity, groupId, comment,
        });
      }
      if (matchWords.length > 0) totalLinesHighlighted++;
    }

    const added = doc.annotations.pages[highlight.page].filter((a) => a.type !== 'freetext' && a.groupId === groupId);
    if (added.length > 0) {
      groups.push({ page: highlight.page, groupId, bbox: calcBboxUnion(added.map((a) => a.bbox)) });
    }

    highlightsApplied++;
  }

  return { highlightsApplied, totalLinesHighlighted, groups };
}

/**
 * @typedef {Object} FreeTextSpec
 * @property {number} page - Page index (0-based).
 * @property {bbox} bbox - Annotation rectangle in page coordinates
 *   (top-left origin, same frame as OCR words).
 * @property {string} contents - Text shown in the annotation.
 * @property {number} [fontSize=10] - Text size, in the same coordinate frame as bbox.
 * @property {string} [textColor='#000000'] - Hex text color.
 * @property {string} [fillColor] - Hex background color; omitted = transparent.
 * @property {number} [opacity=1] - Opacity (0 to 1).
 */

/**
 * Add FreeText (text label) annotations at fixed page positions.
 *
 * @param {ScribeDoc} doc
 * @param {Array<FreeTextSpec>} annotations
 * @returns {{ annotationsAdded: number }}
 */
export function addFreeText(doc, annotations) {
  let annotationsAdded = 0;
  for (const annot of annotations) {
    if (!annot.bbox || typeof annot.contents !== 'string') {
      throw new Error('Each FreeText annotation must specify bbox and contents.');
    }
    if (!doc.annotations.pages[annot.page]) continue;
    doc.annotations.pages[annot.page].push({
      type: 'freetext',
      bbox: {
        left: annot.bbox.left, top: annot.bbox.top, right: annot.bbox.right, bottom: annot.bbox.bottom,
      },
      contents: annot.contents,
      fontSize: annot.fontSize ?? 10,
      textColor: annot.textColor || '#000000',
      fillColor: annot.fillColor,
      opacity: annot.opacity ?? 1,
    });
    annotationsAdded++;
  }
  return { annotationsAdded };
}

/**
 * Remove all highlights previously added by `addHighlights`.
 * @param {ScribeDoc} doc
 */
export function clearHighlights(doc) {
  for (let p = 0; p < doc.annotations.pages.length; p++) {
    doc.annotations.pages[p] = doc.annotations.pages[p]
      .filter((a) => a.type === 'freetext' || !a.groupId?.startsWith(GROUP_PREFIX));
  }
}
