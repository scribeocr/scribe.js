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
  // /Contents (literal string) or /Contents <hex string>
  const hexMatch = /\/Contents\s*<([0-9A-Fa-f\s]*)>/.exec(annotText);
  if (hexMatch) {
    const hex = hexMatch[1].replace(/\s+/g, '');
    if (hex.length === 0) return '';
    // UTF-16BE if starts with BOM FE FF; otherwise treat bytes as PDFDocEncoding/latin1.
    if (hex.length >= 4 && hex.slice(0, 4).toUpperCase() === 'FEFF') {
      let out = '';
      for (let i = 4; i + 3 < hex.length; i += 4) {
        out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
      }
      return out;
    }
    let out = '';
    for (let i = 0; i + 1 < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    }
    return out;
  }
  const litMatch = /\/Contents\s*\(((?:\\.|[^\\()])*)\)/.exec(annotText);
  if (litMatch) {
    // Minimal unescape — \n, \r, \t, \\, \(, \). Full PDF literal-string
    // escaping (octal etc.) is not required for round-trip fidelity here.
    return litMatch[1]
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\\\/g, '\\');
  }
  return '';
}

/**
 * @param {import('./parsePdfUtils.js').ObjectCache} objCache
 * @param {string} pageObjText
 * @returns {{ highlights: PdfHighlightRaw[], passthroughRefs: number[] }}
 */
export function extractPdfAnnotations(objCache, pageObjText) {
  /** @type {PdfHighlightRaw[]} */
  const highlights = [];
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
  if (!annotRefs || annotRefs.length === 0) return { highlights, passthroughRefs };

  for (const annotRef of annotRefs) {
    const annotText = objCache.getObjectText(annotRef);
    if (!annotText) continue;

    // Skip Invisible (bit 1), Hidden (bit 2), or NoView (bit 6) annotations.
    const flagsMatch = /\/F\s+(\d+)/.exec(annotText);
    const flags = flagsMatch ? Number(flagsMatch[1]) : 0;
    if (flags & 1 || flags & 2 || flags & 32) continue;

    if (!/\/Subtype\s*\/Highlight\b/.test(annotText)) {
      passthroughRefs.push(annotRef);
      continue;
    }

    const rectMatch = /\/Rect\s*\[\s*([\d.\-+e]+)\s+([\d.\-+e]+)\s+([\d.\-+e]+)\s+([\d.\-+e]+)\s*\]/.exec(annotText);
    if (!rectMatch) continue;
    /** @type {[number, number, number, number]} */
    const rect = [Number(rectMatch[1]), Number(rectMatch[2]), Number(rectMatch[3]), Number(rectMatch[4])];

    const qpMatch = /\/QuadPoints\s*\[\s*([\d.\-+e\s]+)\]/.exec(annotText);
    const quadPoints = qpMatch ? qpMatch[1].trim().split(/\s+/).map(Number) : null;

    const cMatch = /\/C\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(annotText);
    /** @type {[number, number, number]|null} */
    const color = cMatch ? [Number(cMatch[1]), Number(cMatch[2]), Number(cMatch[3])] : null;

    const caMatch = /\/CA\s+([\d.]+)/.exec(annotText);
    const opacity = caMatch ? Number(caMatch[1]) : 1;

    highlights.push({
      objNum: annotRef,
      rect,
      quadPoints,
      color,
      opacity,
      comment: parseAnnotContents(annotText),
    });
  }

  return { highlights, passthroughRefs };
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
    bbox,
    color: hex,
    opacity: raw.opacity,
    groupId,
  };
  if (raw.comment) annot.comment = raw.comment;
  if (quads && quads.length > 0) annot.quads = quads;
  return annot;
}
