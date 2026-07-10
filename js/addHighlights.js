import ocr from './objects/ocrObjects.js';
import { calcBboxUnion } from './utils/miscUtils.js';
import { TEXT_ANNOT_ICON_PX } from './pdf/parsePdfAnnots.js';

/** @typedef {import('./containers/scribeDoc.js').ScribeDoc} ScribeDoc */

const GROUP_PREFIX = 'hl-';

/**
 * Map a word/line bbox from scribe's internal "virtual horizontal" frame (how rotated lines are stored) back to page space.
 * @param {bbox} bbox - bbox in the line's orientation frame.
 * @param {number} orientation - line orientation (0-3).
 * @param {dims} dims - page dimensions.
 * @returns {bbox} bbox in page space.
 */
function bboxToPageSpace(bbox, orientation, dims) {
  const { width: w, height: h } = dims;
  if (orientation === 1) {
    return {
      left: w - bbox.bottom, top: bbox.left, right: w - bbox.top, bottom: bbox.right,
    };
  }
  if (orientation === 2) {
    return {
      left: w - bbox.right, top: h - bbox.bottom, right: w - bbox.left, bottom: h - bbox.top,
    };
  }
  if (orientation === 3) {
    return {
      left: bbox.top, top: h - bbox.right, right: bbox.bottom, bottom: h - bbox.left,
    };
  }
  return { ...bbox };
}

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
            type: 'highlight', bbox: bboxToPageSpace(word.bbox, line.orientation, pageObj.dims), color, opacity, groupId, comment,
          });
        }
        totalLinesHighlighted++;
      }
    } else if (highlight.text) {
      const matchWords = ocr.getMatchingWords(highlight.text, pageObj);
      for (const word of matchWords) {
        doc.annotations.pages[highlight.page].push({
          type: 'highlight', bbox: bboxToPageSpace(word.bbox, word.line.orientation, pageObj.dims), color, opacity, groupId, comment,
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

/** Annotation type tags emitted as vector shapes. */
export const SHAPE_ANNOT_TYPES = new Set(['square', 'circle', 'line', 'polygon', 'polyline']);

/**
 * @typedef {Object} ShapeSpec
 * @property {number} page - Page index (0-based).
 * @property {'square'|'circle'|'line'|'polygon'|'polyline'} type
 * @property {bbox} [bbox] - 'square'/'circle': rect/ellipse bounds in page coords (top-left origin).
 * @property {[number, number, number, number]} [points] - 'line': [x1, y1, x2, y2] in page coords.
 * @property {number[]} [vertices] - 'polygon'/'polyline': flat [x1, y1, ...] in page coords.
 * @property {string} [borderColor='#ff0000']
 * @property {string} [fillColor] - Omitted = outline only.
 * @property {number} [opacity=1]
 * @property {number} [borderWidth=1]
 * @property {string} [comment]
 */

/**
 * Add vector shape annotations at fixed page positions.
 * @param {ScribeDoc} doc
 * @param {Array<ShapeSpec>} shapes
 * @returns {{ shapesAdded: number }}
 */
export function addShapes(doc, shapes) {
  let shapesAdded = 0;
  for (const shape of shapes) {
    if (!SHAPE_ANNOT_TYPES.has(shape.type)) {
      throw new Error(`Unknown shape annotation type: ${shape.type}`);
    }
    if ((shape.type === 'square' || shape.type === 'circle') && !shape.bbox) {
      throw new Error(`A '${shape.type}' annotation must specify bbox.`);
    }
    if (shape.type === 'line' && (!shape.points || shape.points.length !== 4)) {
      throw new Error("A 'line' annotation must specify points [x1, y1, x2, y2].");
    }
    if ((shape.type === 'polygon' || shape.type === 'polyline')
      && (!shape.vertices || shape.vertices.length < 4 || shape.vertices.length % 2 !== 0)) {
      throw new Error(`A '${shape.type}' annotation must specify an even-length vertices array.`);
    }
    if (!doc.annotations.pages[shape.page]) continue;

    const style = {
      borderColor: shape.borderColor || '#ff0000',
      fillColor: shape.fillColor,
      opacity: shape.opacity ?? 1,
      borderWidth: shape.borderWidth ?? 1,
      comment: shape.comment,
    };
    if (shape.type === 'line') {
      doc.annotations.pages[shape.page].push({ type: 'line', points: [...shape.points], ...style });
    } else if (shape.type === 'polygon' || shape.type === 'polyline') {
      doc.annotations.pages[shape.page].push({ type: shape.type, vertices: [...shape.vertices], ...style });
    } else {
      doc.annotations.pages[shape.page].push({
        type: shape.type,
        bbox: {
          left: shape.bbox.left, top: shape.bbox.top, right: shape.bbox.right, bottom: shape.bbox.bottom,
        },
        ...style,
      });
    }
    shapesAdded++;
  }
  return { shapesAdded };
}

/**
 * Remove all shape annotations added by `addShapes`.
 * @param {ScribeDoc} doc
 */
export function clearShapes(doc) {
  for (let p = 0; p < doc.annotations.pages.length; p++) {
    doc.annotations.pages[p] = doc.annotations.pages[p].filter((a) => !SHAPE_ANNOT_TYPES.has(a.type));
  }
}

/**
 * @typedef {Object} TextAnnotSpec
 * @property {number} page - Page index (0-based).
 * @property {number} x - Icon left in page coords (top-left origin).
 * @property {number} y - Icon top in page coords.
 * @property {string} [comment] - Annotation body; '' when omitted.
 * @property {string} [color] - Icon color '#rrggbb'.
 * @property {string} [author]
 * @property {string} [createdAt] - UTC ISO-8601.
 * @property {AnnotationReply[]} [replies] - Reply thread under the comment, oldest first.
 * @property {boolean} [open] - Whether the popup opens by default; false when omitted.
 */

/**
 * Add freestanding /Text annotations at fixed page positions.
 * @param {ScribeDoc} doc
 * @param {Array<TextAnnotSpec>} textAnnots
 * @returns {{ added: number }}
 */
export function addTextAnnots(doc, textAnnots) {
  let added = 0;
  for (const spec of textAnnots) {
    if (!doc.annotations.pages[spec.page]) continue;
    /** @type {AnnotationText} */
    const annot = {
      type: 'text',
      bbox: {
        left: spec.x, top: spec.y, right: spec.x + TEXT_ANNOT_ICON_PX, bottom: spec.y + TEXT_ANNOT_ICON_PX,
      },
      comment: spec.comment || '',
      open: spec.open ?? false,
    };
    if (spec.color) annot.color = spec.color;
    if (spec.author) annot.author = spec.author;
    if (spec.createdAt) annot.createdAt = spec.createdAt;
    if (spec.replies && spec.replies.length > 0) annot.replies = spec.replies.map((r) => ({ ...r }));
    doc.annotations.pages[spec.page].push(annot);
    added += 1;
  }
  return { added };
}

/**
 * Remove all freestanding /Text annotations added by `addTextAnnots`.
 * @param {ScribeDoc} doc
 */
export function clearTextAnnots(doc) {
  for (let p = 0; p < doc.annotations.pages.length; p++) {
    doc.annotations.pages[p] = doc.annotations.pages[p].filter((a) => a.type !== 'text');
  }
}
