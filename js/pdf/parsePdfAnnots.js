import {
  resolveArrayValue, decodePdfString, parsePdfDate, resolveBoolValue, resolveNameValue,
} from './pdfPrimitives.js';

// Bounding-box size in pixels imposed on a /Text annotation.
// The size is nominal because the marker renders at a fixed on-screen size regardless of the box.
// Shared with the create paths so imported and newly-placed text annotations are one size.
export const TEXT_ANNOT_ICON_PX = 24;

/**
 * @typedef {Object} PdfHighlightRaw
 * @property {number} objNum
 * @property {[number, number, number, number]} rect - /Rect in pts, bottom-left origin.
 * @property {number[]|null} quadPoints - /QuadPoints: flat array of 8*N floats, pts, bottom-left origin.
 * @property {[number, number, number]|null} color - /C normalized 0..1, or null if absent.
 * @property {number} opacity - /CA, defaults to 1 when absent.
 * @property {string} comment - /Contents text (UTF-16BE or PDFDocEncoding decoded), '' when absent.
 * @property {string} author - /T text, '' when absent.
 * @property {?string} createdAt - /CreationDate as UTC ISO-8601, null when absent or unparseable.
 */

/**
 * Read a PDF string value for `key` from an annotation object's text: hex `<...>` or literal `(...)`, decoded.
 * '' when absent.
 * @param {string} annotText
 * @param {string} key - The dict key without the leading slash, e.g. 'Contents' or 'T'.
 * @returns {string}
 */
function parseAnnotPdfString(annotText, key) {
  const hexMatch = new RegExp(`/${key}\\s*(<[0-9A-Fa-f\\s]*>)`).exec(annotText);
  if (hexMatch) return decodePdfString(hexMatch[1]);
  const litMatch = new RegExp(`/${key}\\s*(\\((?:\\\\.|[^\\\\()])*\\))`).exec(annotText);
  if (litMatch) return decodePdfString(litMatch[1]);
  return '';
}

/**
 * @typedef {Object} PdfFreeTextRaw
 * @property {number} objNum
 * @property {[number, number, number, number]} rect - /Rect in pts, bottom-left origin.
 * @property {string} contents - /Contents text, '' when absent.
 * @property {number} fontSize - Tf size from /DA, 10 when absent.
 * @property {[number, number, number]|null} textColor - rg fill from /DA normalized 0..1, or null.
 * @property {[number, number, number]|null} fillColor - /C normalized 0..1, or null if absent.
 * @property {number} opacity - /CA, defaults to 1 when absent.
 */

/**
 * @typedef {Object} PdfTextAnnotRaw
 * @property {number} objNum
 * @property {[number, number, number, number]} rect - /Rect in pts, bottom-left origin.
 * @property {[number, number, number]|null} color - /C normalized 0..1, or null if absent.
 * @property {number} opacity - /CA, defaults to 1 when absent.
 * @property {string} contents - /Contents text, '' when absent.
 * @property {boolean} open - /Open, false when absent.
 * @property {string} iconName - /Name icon, 'Comment' when absent.
 * @property {string} author - /T text, '' when absent.
 * @property {?string} createdAt - /CreationDate as UTC ISO-8601, null when absent or unparseable.
 */

/**
 * True when the annotation is one the importer lifts into the editable model: a visible Highlight, FreeText, or a standalone Text annotation (not a reply).
 * The model re-emits these on export, so `buildReplacementPageDict` must drop the source copy or the annotation duplicates each round-trip.
 * @param {string} annotText - The raw annotation object text.
 * @returns {boolean}
 */
export function annotIsModelManaged(annotText) {
  // Invisible (bit 1), Hidden (bit 2), or NoView (bit 6).
  const flagsMatch = /\/F\s+(\d+)(?=\s*[/>])/.exec(annotText);
  const flags = flagsMatch ? Number(flagsMatch[1]) : 0;
  if (flags & 1 || flags & 2 || flags & 32) return false;
  if (/\/Subtype\s*\/Highlight\b/.test(annotText) || /\/Subtype\s*\/FreeText\b/.test(annotText)) return true;
  // A /Text annotation is lifted only when standalone.
  // A reply (/IRT) stays a passthrough so the thread is preserved.
  return /\/Subtype\s*\/Text\b/.test(annotText) && !/\/IRT\b/.test(annotText);
}

/**
 * Reads a page's /Annots and sorts each annotation into the highlight, free-text,
 * and standalone-text buckets the importer lifts into the editable model,
 * plus the refs of the remaining visible annotations that pass through unchanged on export.
 * @param {import('./objectCache.js').ObjectCache} objCache
 * @param {string} pageObjText
 * @returns {{ highlights: PdfHighlightRaw[], freeTexts: PdfFreeTextRaw[], textAnnots: PdfTextAnnotRaw[], passthroughRefs: number[] }}
 */
export function extractPdfAnnotations(objCache, pageObjText) {
  /** @type {PdfHighlightRaw[]} */
  const highlights = [];
  /** @type {PdfFreeTextRaw[]} */
  const freeTexts = [];
  /** @type {PdfTextAnnotRaw[]} */
  const textAnnots = [];
  /** @type {number[]} */
  const passthroughRefs = [];

  let annotRefs = null;
  const inlineMatch = /\/Annots\s*\[([^\]]*)\]/.exec(pageObjText);
  if (inlineMatch) {
    annotRefs = [...inlineMatch[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
  } else {
    const indirectMatch = /\/Annots\s+(\d+)\s+\d+\s+R/.exec(pageObjText);
    if (indirectMatch) {
      const arrayText = objCache.getObjectText(Number(indirectMatch[1]));
      if (arrayText) {
        annotRefs = [...arrayText.matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));
      }
    }
  }
  if (!annotRefs || annotRefs.length === 0) {
    return {
      highlights, freeTexts, textAnnots, passthroughRefs,
    };
  }

  for (const annotRef of annotRefs) {
    const annotText = objCache.getObjectText(annotRef);
    if (!annotText) continue;

    if (!annotIsModelManaged(annotText)) {
      // Of these not-lifted annotations, Invisible/Hidden/NoView are dropped entirely.
      // Every other (visible, non-Highlight/FreeText) annotation passes through on export unchanged.
      const flagsMatch = /\/F\s+(\d+)(?=\s*[/>])/.exec(annotText);
      const flags = flagsMatch ? Number(flagsMatch[1]) : 0;
      if (!(flags & 1 || flags & 2 || flags & 32)) passthroughRefs.push(annotRef);
      continue;
    }

    const isFreeText = /\/Subtype\s*\/FreeText\b/.test(annotText);
    const isTextAnnot = /\/Subtype\s*\/Text\b/.test(annotText);

    const rectStr = resolveArrayValue(annotText, 'Rect', objCache);
    const rectNums = rectStr ? rectStr.split(/\s+/).map(Number) : [];
    const rectValid = rectNums.length >= 4 && !rectNums.slice(0, 4).some(Number.isNaN);
    // A /Text annotation tolerates a missing/invalid rect (defaulted below) so a model-managed one is never silently lost.
    if (!rectValid && !isTextAnnot) continue;
    /** @type {[number, number, number, number]} */
    const rect = rectValid ? [rectNums[0], rectNums[1], rectNums[2], rectNums[3]] : [0, 0, TEXT_ANNOT_ICON_PX, TEXT_ANNOT_ICON_PX];

    const cStr = resolveArrayValue(annotText, 'C', objCache);
    const cNums = cStr ? cStr.split(/\s+/).map(Number) : null;
    /** @type {[number, number, number]|null} */
    const color = cNums && cNums.length >= 3 && !cNums.some(Number.isNaN)
      ? [cNums[0], cNums[1], cNums[2]] : null;

    const caMatch = /\/CA\s+([\d.]+)/.exec(annotText);
    const opacity = caMatch ? Number(caMatch[1]) : 1;

    if (isFreeText) {
      const daMatch = /\/DA\s*\(([^)]*)\)/.exec(annotText);
      const da = daMatch ? daMatch[1] : '';
      const tfMatch = /([\d.]+)\s+Tf/.exec(da);
      const rgMatch = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
      freeTexts.push({
        objNum: annotRef,
        rect,
        contents: parseAnnotPdfString(annotText, 'Contents'),
        fontSize: tfMatch ? Number(tfMatch[1]) : 10,
        textColor: rgMatch ? [Number(rgMatch[1]), Number(rgMatch[2]), Number(rgMatch[3])] : null,
        fillColor: color,
        opacity,
      });
      continue;
    }

    if (isTextAnnot) {
      const creationDateStr = parseAnnotPdfString(annotText, 'CreationDate');
      textAnnots.push({
        objNum: annotRef,
        rect,
        color,
        opacity,
        contents: parseAnnotPdfString(annotText, 'Contents'),
        open: resolveBoolValue(annotText, 'Open', objCache, false),
        iconName: resolveNameValue(annotText, 'Name', objCache) || 'Comment',
        author: parseAnnotPdfString(annotText, 'T'),
        createdAt: creationDateStr ? parsePdfDate(creationDateStr) : null,
      });
      continue;
    }

    const qpStr = resolveArrayValue(annotText, 'QuadPoints', objCache);
    const quadPoints = qpStr ? qpStr.split(/\s+/).map(Number) : null;

    const createdAtStr = parseAnnotPdfString(annotText, 'CreationDate');
    highlights.push({
      objNum: annotRef,
      rect,
      quadPoints,
      color,
      opacity,
      comment: parseAnnotPdfString(annotText, 'Contents'),
      author: parseAnnotPdfString(annotText, 'T'),
      createdAt: createdAtStr ? parsePdfDate(createdAtStr) : null,
    });
  }

  return {
    highlights, freeTexts, textAnnots, passthroughRefs,
  };
}

/**
 * Convert a PDF user-space highlight to the pixel-space `AnnotationHighlight`
 * shape used by `scribe.data.annotations.pages[i]`. Mirrors how `parseSinglePage`
 * transforms content-space chars into pixel-space OCR coordinates — apply
 * `initialCtm` (which bakes in any /Rotate), Y-flip against the post-rotate
 * visual height, then scale.
 *
 * @param {PdfHighlightRaw} raw
 * @param {{ scale: number, visualHeightPts: number, initialCtm: number[], groupId: string }} transform
 * @returns {AnnotationHighlight}
 */
export function pdfHighlightToAnnotation(raw, transform) {
  const {
    scale, visualHeightPts, initialCtm, groupId,
  } = transform;

  const mapPoint = (x, y) => {
    const cx = initialCtm[0] * x + initialCtm[2] * y + initialCtm[4];
    const cy = initialCtm[1] * x + initialCtm[3] * y + initialCtm[5];
    return { x: cx * scale, y: (visualHeightPts - cy) * scale };
  };

  const bboxFromCorners = (corners) => {
    let left = Infinity; let right = -Infinity;
    let top = Infinity; let bottom = -Infinity;
    for (const c of corners) {
      if (c.x < left) left = c.x;
      if (c.x > right) right = c.x;
      if (c.y < top) top = c.y;
      if (c.y > bottom) bottom = c.y;
    }
    return {
      left, top, right, bottom,
    };
  };

  // /Rect — apply full transform to all 4 corners, take bbox of the result.
  const rectCorners = [
    mapPoint(raw.rect[0], raw.rect[1]),
    mapPoint(raw.rect[2], raw.rect[1]),
    mapPoint(raw.rect[0], raw.rect[3]),
    mapPoint(raw.rect[2], raw.rect[3]),
  ];
  const bbox = bboxFromCorners(rectCorners);

  // /QuadPoints — group into quads of 4 (x,y) points, transform each, compute bbox per quad.
  /** @type {bbox[] | undefined} */
  let quads;
  if (raw.quadPoints && raw.quadPoints.length >= 8) {
    quads = [];
    for (let qi = 0; qi + 7 < raw.quadPoints.length; qi += 8) {
      const corners = [
        mapPoint(raw.quadPoints[qi], raw.quadPoints[qi + 1]),
        mapPoint(raw.quadPoints[qi + 2], raw.quadPoints[qi + 3]),
        mapPoint(raw.quadPoints[qi + 4], raw.quadPoints[qi + 5]),
        mapPoint(raw.quadPoints[qi + 6], raw.quadPoints[qi + 7]),
      ];
      quads.push(bboxFromCorners(corners));
    }
  }

  const color = raw.color || [1, 1, 0];
  const hex = `#${color.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('')}`;

  /** @type {AnnotationHighlight} */
  const annot = {
    type: 'highlight',
    bbox,
    color: hex,
    opacity: raw.opacity,
    groupId,
  };
  if (raw.comment) annot.comment = raw.comment;
  if (raw.author) annot.author = raw.author;
  if (raw.createdAt) annot.createdAt = raw.createdAt;
  if (quads && quads.length > 0) annot.quads = quads;
  return annot;
}

/**
 * Convert a PDF user-space FreeText annotation to the pixel-space
 * `AnnotationFreeText` shape used by `scribe.data.annotations.pages[i]`.
 * Coordinate handling matches `pdfHighlightToAnnotation`.
 * `fontSize` is scaled into the same pixel frame as the bbox, which the writer reverses on export.
 *
 * @param {PdfFreeTextRaw} raw
 * @param {{ scale: number, visualHeightPts: number, initialCtm: number[] }} transform
 * @returns {AnnotationFreeText}
 */
export function pdfFreeTextToAnnotation(raw, transform) {
  const { scale, visualHeightPts, initialCtm } = transform;

  const mapPoint = (x, y) => {
    const cx = initialCtm[0] * x + initialCtm[2] * y + initialCtm[4];
    const cy = initialCtm[1] * x + initialCtm[3] * y + initialCtm[5];
    return { x: cx * scale, y: (visualHeightPts - cy) * scale };
  };

  const corners = [
    mapPoint(raw.rect[0], raw.rect[1]),
    mapPoint(raw.rect[2], raw.rect[1]),
    mapPoint(raw.rect[0], raw.rect[3]),
    mapPoint(raw.rect[2], raw.rect[3]),
  ];
  let left = Infinity; let right = -Infinity;
  let top = Infinity; let bottom = -Infinity;
  for (const c of corners) {
    if (c.x < left) left = c.x;
    if (c.x > right) right = c.x;
    if (c.y < top) top = c.y;
    if (c.y > bottom) bottom = c.y;
  }

  const toHex = (rgb) => `#${rgb.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('')}`;

  /** @type {AnnotationFreeText} */
  const annot = {
    type: 'freetext',
    bbox: {
      left, top, right, bottom,
    },
    contents: raw.contents,
    // fontSize is a vertical distance, so like the rect corners it scales by the page CTM's vertical magnitude.
    // hypot(ctm[2], ctm[3]) gives that magnitude even on rotated pages, where ctm[3] alone would be 0.
    fontSize: raw.fontSize * scale * Math.hypot(initialCtm[2], initialCtm[3]),
    textColor: toHex(raw.textColor || [0, 0, 0]),
    opacity: raw.opacity,
  };
  if (raw.fillColor) annot.fillColor = toHex(raw.fillColor);
  return annot;
}

/**
 * Convert a PDF user-space /Text annotation to the pixel-space `AnnotationText` model.
 * Maps the /Rect corners like `pdfHighlightToAnnotation`, then imposes a fixed icon size on the top-left
 * (a point icon's source rect size is not meaningful and varies wildly between producers).
 * @param {PdfTextAnnotRaw} raw
 * @param {{ scale: number, visualHeightPts: number, initialCtm: number[] }} transform
 * @returns {AnnotationText}
 */
export function pdfTextAnnotToAnnotation(raw, transform) {
  const { scale, visualHeightPts, initialCtm } = transform;
  const mapPoint = (x, y) => {
    const cx = initialCtm[0] * x + initialCtm[2] * y + initialCtm[4];
    const cy = initialCtm[1] * x + initialCtm[3] * y + initialCtm[5];
    return { x: cx * scale, y: (visualHeightPts - cy) * scale };
  };
  const corners = [
    mapPoint(raw.rect[0], raw.rect[1]),
    mapPoint(raw.rect[2], raw.rect[1]),
    mapPoint(raw.rect[0], raw.rect[3]),
    mapPoint(raw.rect[2], raw.rect[3]),
  ];
  let left = Infinity;
  let top = Infinity;
  for (const c of corners) {
    if (c.x < left) left = c.x;
    if (c.y < top) top = c.y;
  }

  /** @type {AnnotationText} */
  const annot = {
    type: 'text',
    bbox: {
      left, top, right: left + TEXT_ANNOT_ICON_PX, bottom: top + TEXT_ANNOT_ICON_PX,
    },
    comment: raw.contents,
    open: raw.open,
  };
  if (raw.color) {
    annot.color = `#${raw.color.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('')}`;
  }
  if (raw.author) annot.author = raw.author;
  if (raw.createdAt) annot.createdAt = raw.createdAt;
  return annot;
}
