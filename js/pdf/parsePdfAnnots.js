import { resolveArrayValue, decodePdfString } from './pdfPrimitives.js';

/**
 * @typedef {Object} PdfHighlightRaw
 * @property {number} objNum
 * @property {[number, number, number, number]} rect - /Rect in pts, bottom-left origin.
 * @property {number[]|null} quadPoints - /QuadPoints: flat array of 8*N floats, pts, bottom-left origin.
 * @property {[number, number, number]|null} color - /C normalized 0..1, or null if absent.
 * @property {number} opacity - /CA, defaults to 1 when absent.
 * @property {string} comment - /Contents text (UTF-16BE or PDFDocEncoding decoded), '' when absent.
 */

/**
 * @param {string} annotText
 * @returns {string}
 */
function parseAnnotContents(annotText) {
  const hexMatch = /\/Contents\s*(<[0-9A-Fa-f\s]*>)/.exec(annotText);
  if (hexMatch) return decodePdfString(hexMatch[1]);
  const litMatch = /\/Contents\s*(\((?:\\.|[^\\()])*\))/.exec(annotText);
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
 * True when the annotation is one the importer lifts into the editable model: a visible Highlight or FreeText.
 * The model re-emits these on export, so `buildReplacementPageDict` must drop the source copy or the annotation duplicates each round-trip.
 * @param {string} annotText - The raw annotation object text.
 * @returns {boolean}
 */
export function annotIsModelManaged(annotText) {
  // Invisible (bit 1), Hidden (bit 2), or NoView (bit 6).
  const flagsMatch = /\/F\s+(\d+)(?=\s*[/>])/.exec(annotText);
  const flags = flagsMatch ? Number(flagsMatch[1]) : 0;
  if (flags & 1 || flags & 2 || flags & 32) return false;
  return /\/Subtype\s*\/Highlight\b/.test(annotText) || /\/Subtype\s*\/FreeText\b/.test(annotText);
}

/**
 * @param {import('./objectCache.js').ObjectCache} objCache
 * @param {string} pageObjText
 * @returns {{ highlights: PdfHighlightRaw[], freeTexts: PdfFreeTextRaw[], passthroughRefs: number[] }}
 */
export function extractPdfAnnotations(objCache, pageObjText) {
  /** @type {PdfHighlightRaw[]} */
  const highlights = [];
  /** @type {PdfFreeTextRaw[]} */
  const freeTexts = [];
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
  if (!annotRefs || annotRefs.length === 0) return { highlights, freeTexts, passthroughRefs };

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

    const rectStr = resolveArrayValue(annotText, 'Rect', objCache);
    if (!rectStr) continue;
    const rectNums = rectStr.split(/\s+/).map(Number);
    if (rectNums.length < 4 || rectNums.some(Number.isNaN)) continue;
    /** @type {[number, number, number, number]} */
    const rect = [rectNums[0], rectNums[1], rectNums[2], rectNums[3]];

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
        contents: parseAnnotContents(annotText),
        fontSize: tfMatch ? Number(tfMatch[1]) : 10,
        textColor: rgMatch ? [Number(rgMatch[1]), Number(rgMatch[2]), Number(rgMatch[3])] : null,
        fillColor: color,
        opacity,
      });
      continue;
    }

    const qpStr = resolveArrayValue(annotText, 'QuadPoints', objCache);
    const quadPoints = qpStr ? qpStr.split(/\s+/).map(Number) : null;

    highlights.push({
      objNum: annotRef,
      rect,
      quadPoints,
      color,
      opacity,
      comment: parseAnnotContents(annotText),
    });
  }

  return { highlights, freeTexts, passthroughRefs };
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
