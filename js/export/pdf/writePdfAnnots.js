import { toUtf16BeHex, formatPdfDate } from '../../pdf/pdfPrimitives.js';

/**
 * Message for an annotation skipped because emitting it threw.
 * @param {string} type
 * @param {unknown} err
 */
function skipMessage(type, err) {
  return `Skipped ${type} annotation: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Build the /Text reply objects for one parent annotation's comment thread.
 * @param {AnnotationReply[]} replies
 * @param {number} parentObjNum
 * @param {string} rectStr - The parent's /Rect array contents.
 * @param {number} startObjNum
 * @param {boolean} omitIdentity - When true (a sanitized export), suppress `/T` and `/CreationDate`.
 * @returns {{ objectTexts: string[], annotRefs: string[] }}
 */
function buildReplyObjects(replies, parentObjNum, rectStr, startObjNum, omitIdentity) {
  const objectTexts = [];
  const annotRefs = [];
  let objNum = startObjNum;
  for (const reply of replies) {
    let str = `${objNum} 0 obj\n`;
    str += '<</Type /Annot /Subtype /Text';
    // /IRT makes viewers present the reply inside the parent's thread rather than as its own page icon, so it can reuse the parent's /Rect.
    str += ` /Rect [${rectStr}]`;
    str += ` /IRT ${parentObjNum} 0 R`;
    str += ` /Contents <${toUtf16BeHex(reply.text || '')}>`;
    str += ' /Name /Comment /Open false /F 4';
    if (!omitIdentity && reply.author) str += ` /T <${toUtf16BeHex(reply.author)}>`;
    if (!omitIdentity && reply.createdAt) {
      const pdfDate = formatPdfDate(reply.createdAt);
      if (pdfDate) str += ` /CreationDate (${pdfDate})`;
    }
    str += '>>\nendobj\n\n';
    annotRefs.push(`${objNum} 0 R`);
    objectTexts.push(str);
    objNum++;
  }
  return { objectTexts, annotRefs };
}

/**
 * @param {AnnotationHighlight[]} annotations
 * @param {number} startObjNum
 * @param {{ width: number, height: number }} outputDims
 * @param {(message: string) => void} [warningHandler] - Reports each annotation skipped on error.
 * @param {boolean} [omitIdentity] - When true (a sanitized/scrubbed export), suppress the author `/T` and `/CreationDate`.
 * @returns {{ objectTexts: string[], annotRefs: string[] }} Object strings (the i-th numbered startObjNum + i) and their `/Annots` references.
 */
export function buildHighlightAnnotObjects(annotations, startObjNum, outputDims, warningHandler, omitIdentity = false) {
  const objectTexts = [];
  const annotRefs = [];
  let objNum = startObjNum;

  for (const annot of annotations) {
    try {
      const hex = annot.color.replace('#', '');
      const r = parseInt(hex.substring(0, 2), 16) / 255;
      const g = parseInt(hex.substring(2, 4), 16) / 255;
      const b = parseInt(hex.substring(4, 6), 16) / 255;

      const pdfRectTop = outputDims.height - annot.bbox.top;
      const pdfRectBottom = outputDims.height - annot.bbox.bottom;

      let str = `${objNum} 0 obj\n`;
      str += '<</Type /Annot /Subtype /Highlight';
      str += ` /Rect [${annot.bbox.left} ${pdfRectBottom} ${annot.bbox.right} ${pdfRectTop}]`;

      // QuadPoints per line. If the annotation omits /quads we fall back to a
      // single quad matching the bbox so viewers still paint something.
      let quadPoints = '';
      const quads = annot.quads || [annot.bbox];
      for (const q of quads) {
        const qTop = outputDims.height - q.top;
        const qBottom = outputDims.height - q.bottom;
        quadPoints += `${q.left} ${qTop} ${q.right} ${qTop} ${q.left} ${qBottom} ${q.right} ${qBottom} `;
      }
      str += ` /QuadPoints [${quadPoints.trim()}]`;

      str += ` /C [${r} ${g} ${b}]`;
      str += ` /CA ${annot.opacity}`;
      str += ' /F 4';
      if (annot.comment) {
        str += ` /Contents <${toUtf16BeHex(annot.comment)}>`;
      }
      // Author is emitted as UTF-16BE hex so any name round-trips without PDF literal-string escaping.
      if (!omitIdentity && annot.author) str += ` /T <${toUtf16BeHex(annot.author)}>`;
      if (!omitIdentity && annot.createdAt) {
        const pdfDate = formatPdfDate(annot.createdAt);
        if (pdfDate) str += ` /CreationDate (${pdfDate})`;
      }
      str += '>>\nendobj\n\n';

      const parentObjNum = objNum;
      annotRefs.push(`${objNum} 0 R`);
      objectTexts.push(str);
      objNum++;
      if (annot.replies && annot.replies.length > 0) {
        const rectStr = `${annot.bbox.left} ${pdfRectBottom} ${annot.bbox.right} ${pdfRectTop}`;
        const replyObjs = buildReplyObjects(annot.replies, parentObjNum, rectStr, objNum, omitIdentity);
        objectTexts.push(...replyObjs.objectTexts);
        annotRefs.push(...replyObjs.annotRefs);
        objNum += replyObjs.objectTexts.length;
      }
    } catch (err) {
      warningHandler?.(skipMessage('highlight', err));
    }
  }

  return { objectTexts, annotRefs };
}

/**
 * Build the PDF objects for freestanding /Text annotations.
 * No /AP: viewers draw the /Name icon natively.
 * @param {AnnotationText[]} annotations
 * @param {number} startObjNum
 * @param {{ width: number, height: number }} outputDims
 * @param {(message: string) => void} [warningHandler] - Reports each annotation skipped on error.
 * @param {boolean} [omitIdentity] - When true (a sanitized export), suppress the author `/T` and `/CreationDate`.
 * @returns {{ objectTexts: string[], annotRefs: string[] }} Object strings (the i-th numbered startObjNum + i) and their `/Annots` references.
 */
export function buildTextAnnotObjects(annotations, startObjNum, outputDims, warningHandler, omitIdentity = false) {
  const objectTexts = [];
  const annotRefs = [];
  let objNum = startObjNum;

  for (const annot of annotations) {
    try {
      const pdfRectTop = outputDims.height - annot.bbox.top;
      const pdfRectBottom = outputDims.height - annot.bbox.bottom;

      let str = `${objNum} 0 obj\n`;
      str += '<</Type /Annot /Subtype /Text';
      str += ` /Rect [${annot.bbox.left} ${pdfRectBottom} ${annot.bbox.right} ${pdfRectTop}]`;
      str += ` /Contents <${toUtf16BeHex(annot.comment || '')}>`;
      str += ' /Name /Comment';
      str += ` /Open ${annot.open ? 'true' : 'false'}`;
      if (annot.color) {
        const hex = annot.color.replace('#', '');
        const r = parseInt(hex.substring(0, 2), 16) / 255;
        const g = parseInt(hex.substring(2, 4), 16) / 255;
        const b = parseInt(hex.substring(4, 6), 16) / 255;
        str += ` /C [${r} ${g} ${b}]`;
      }
      str += ' /F 4';
      if (!omitIdentity && annot.author) str += ` /T <${toUtf16BeHex(annot.author)}>`;
      if (!omitIdentity && annot.createdAt) {
        const pdfDate = formatPdfDate(annot.createdAt);
        if (pdfDate) str += ` /CreationDate (${pdfDate})`;
      }
      str += '>>\nendobj\n\n';

      const parentObjNum = objNum;
      annotRefs.push(`${objNum} 0 R`);
      objectTexts.push(str);
      objNum++;
      if (annot.replies && annot.replies.length > 0) {
        const rectStr = `${annot.bbox.left} ${pdfRectBottom} ${annot.bbox.right} ${pdfRectTop}`;
        const replyObjs = buildReplyObjects(annot.replies, parentObjNum, rectStr, objNum, omitIdentity);
        objectTexts.push(...replyObjs.objectTexts);
        annotRefs.push(...replyObjs.annotRefs);
        objNum += replyObjs.objectTexts.length;
      }
    } catch (err) {
      warningHandler?.(skipMessage('text annotation', err));
    }
  }

  return { objectTexts, annotRefs };
}

/**
 * @param {AnnotationFreeText[]} annotations
 * @param {number} startObjNum
 * @param {{ width: number, height: number }} outputDims
 * @param {(message: string) => void} [warningHandler] - Reports each annotation skipped on error.
 * @returns {{ objectTexts: string[], annotRefs: string[] }} Object strings (the i-th numbered startObjNum + i) and their `/Annots` references.
 */
export function buildFreeTextAnnotObjects(annotations, startObjNum, outputDims, warningHandler) {
  const objectTexts = [];
  const annotRefs = [];
  let objNum = startObjNum;

  for (const annot of annotations) {
    try {
      const hex = annot.textColor.replace('#', '');
      const r = parseInt(hex.substring(0, 2), 16) / 255;
      const g = parseInt(hex.substring(2, 4), 16) / 255;
      const b = parseInt(hex.substring(4, 6), 16) / 255;

      const pdfRectTop = outputDims.height - annot.bbox.top;
      const pdfRectBottom = outputDims.height - annot.bbox.bottom;

      let str = `${objNum} 0 obj\n`;
      str += '<</Type /Annot /Subtype /FreeText';
      str += ` /Rect [${annot.bbox.left} ${pdfRectBottom} ${annot.bbox.right} ${pdfRectTop}]`;
      str += ` /Contents <${toUtf16BeHex(annot.contents)}>`;
      // /DA is required for FreeText (ISO 32000-2 12.5.6.6).
      // With no /AP, viewers synthesize the appearance from it.
      // /Helv resolves without an /AcroForm /DR in all major viewers.
      str += ` /DA (/Helv ${annot.fontSize} Tf ${r} ${g} ${b} rg)`;
      str += ' /Q 0 /BS <</W 0>> /F 4';
      if (annot.fillColor) {
        const fhex = annot.fillColor.replace('#', '');
        const fr = parseInt(fhex.substring(0, 2), 16) / 255;
        const fg = parseInt(fhex.substring(2, 4), 16) / 255;
        const fb = parseInt(fhex.substring(4, 6), 16) / 255;
        str += ` /C [${fr} ${fg} ${fb}]`;
      }
      str += ` /CA ${annot.opacity}`;
      str += '>>\nendobj\n\n';

      const parentObjNum = objNum;
      annotRefs.push(`${objNum} 0 R`);
      objectTexts.push(str);
      objNum++;
      if (annot.replies && annot.replies.length > 0) {
        const rectStr = `${annot.bbox.left} ${pdfRectBottom} ${annot.bbox.right} ${pdfRectTop}`;
        const replyObjs = buildReplyObjects(annot.replies, parentObjNum, rectStr, objNum, false);
        objectTexts.push(...replyObjs.objectTexts);
        annotRefs.push(...replyObjs.annotRefs);
        objNum += replyObjs.objectTexts.length;
      }
    } catch (err) {
      warningHandler?.(skipMessage('FreeText', err));
    }
  }

  return { objectTexts, annotRefs };
}

const SHAPE_SUBTYPE = {
  square: 'Square', circle: 'Circle', line: 'Line', polygon: 'Polygon', polyline: 'PolyLine',
};

/**
 * Build the PDF objects for shape annotations: an annotation dict plus an /AP appearance stream per shape.
 * @param {AnnotationShape[]} annotations
 * @param {number} startObjNum
 * @param {{ width: number, height: number }} outputDims
 * @param {(message: string) => void} [warningHandler] - Reports each annotation skipped on error.
 * @returns {{ objectTexts: string[], annotRefs: string[] }} Object strings (the i-th numbered startObjNum + i) and their `/Annots` references.
 */
export function buildShapeAnnotObjects(annotations, startObjNum, outputDims, warningHandler) {
  const objectTexts = [];
  const annotRefs = [];
  const H = outputDims.height;
  let objNum = startObjNum;

  for (const annot of annotations) {
    try {
      const bhex = (annot.borderColor || '#ff0000').replace('#', '');
      const br = parseInt(bhex.substring(0, 2), 16) / 255;
      const bg = parseInt(bhex.substring(2, 4), 16) / 255;
      const bb = parseInt(bhex.substring(4, 6), 16) / 255;
      const width = annot.borderWidth ?? 1;
      const hasFill = annot.type !== 'line' && annot.type !== 'polyline' && !!annot.fillColor;

      let fr; let fg; let fb;
      if (hasFill) {
        const fhex = annot.fillColor.replace('#', '');
        fr = parseInt(fhex.substring(0, 2), 16) / 255;
        fg = parseInt(fhex.substring(2, 4), 16) / 255;
        fb = parseInt(fhex.substring(4, 6), 16) / 255;
      }

      // Geometry field and path ops, in PDF user space (y flipped).
      /** @type {Array<[number, number]>} */
      let pts;
      let geomStr = '';
      let pathOps = '';
      if (annot.type === 'line') {
        const [x1, y1, x2, y2] = annot.points;
        pts = [[x1, H - y1], [x2, H - y2]];
        geomStr = ` /L [${pts[0][0]} ${pts[0][1]} ${pts[1][0]} ${pts[1][1]}]`;
        pathOps = `${pts[0][0]} ${pts[0][1]} m\n${pts[1][0]} ${pts[1][1]} l\n`;
      } else if (annot.type === 'polygon' || annot.type === 'polyline') {
        pts = [];
        for (let i = 0; i < annot.vertices.length; i += 2) pts.push([annot.vertices[i], H - annot.vertices[i + 1]]);
        geomStr = ` /Vertices [${pts.map((p) => `${p[0]} ${p[1]}`).join(' ')}]`;
        pathOps = `${pts[0][0]} ${pts[0][1]} m\n${pts.slice(1).map((p) => `${p[0]} ${p[1]} l`).join('\n')}\n`;
        if (annot.type === 'polygon') pathOps += 'h\n';
      } else {
        const {
          left, top, right, bottom,
        } = annot.bbox;
        pts = [[left, H - bottom], [right, H - top]];
        if (annot.type === 'square') {
          pathOps = `${left} ${H - bottom} ${right - left} ${bottom - top} re\n`;
        } else {
          const cx = (left + right) / 2;
          const cy = H - (top + bottom) / 2;
          const rx = (right - left) / 2;
          const ry = (bottom - top) / 2;
          const kx = rx * 0.5522847498;
          const ky = ry * 0.5522847498;
          pathOps = `${cx + rx} ${cy} m\n`
            + `${cx + rx} ${cy + ky} ${cx + kx} ${cy + ry} ${cx} ${cy + ry} c\n`
            + `${cx - kx} ${cy + ry} ${cx - rx} ${cy + ky} ${cx - rx} ${cy} c\n`
            + `${cx - rx} ${cy - ky} ${cx - kx} ${cy - ry} ${cx} ${cy - ry} c\n`
            + `${cx + kx} ${cy - ry} ${cx + rx} ${cy - ky} ${cx + rx} ${cy} c\n`
            + 'h\n';
        }
      }

      // /Rect and appearance /BBox: geometry bounds padded by border width so the stroke isn't clipped.
      let gx0 = pts[0][0]; let gy0 = pts[0][1]; let gx1 = pts[0][0]; let gy1 = pts[0][1];
      for (const [x, y] of pts) {
        gx0 = Math.min(gx0, x); gy0 = Math.min(gy0, y); gx1 = Math.max(gx1, x); gy1 = Math.max(gy1, y);
      }
      const rect = `${gx0 - width} ${gy0 - width} ${gx1 + width} ${gy1 + width}`;

      const apObjNum = objNum + 1;

      let dict = `${objNum} 0 obj\n`;
      dict += `<</Type /Annot /Subtype /${SHAPE_SUBTYPE[annot.type]}`;
      dict += ` /Rect [${rect}]`;
      dict += ` /C [${br} ${bg} ${bb}]`;
      if (hasFill) dict += ` /IC [${fr} ${fg} ${fb}]`;
      dict += ` /CA ${annot.opacity ?? 1}`;
      dict += ` /BS <</W ${width}>>`;
      dict += ' /F 4';
      dict += geomStr;
      dict += ` /AP <</N ${apObjNum} 0 R>>`;
      if (annot.comment) dict += ` /Contents <${toUtf16BeHex(annot.comment)}>`;
      dict += '>>\nendobj\n\n';

      let ap = `q\n${br} ${bg} ${bb} RG\n`;
      if (hasFill) ap += `${fr} ${fg} ${fb} rg\n`;
      ap += `${width} w\n${pathOps}${hasFill ? 'B' : 'S'}\nQ`;
      const apObj = `${apObjNum} 0 obj\n<</Type /XObject /Subtype /Form /FormType 1 /BBox [${rect}] /Resources <<>> /Length ${ap.length}>>\nstream\n${ap}\nendstream\nendobj\n\n`;

      const parentObjNum = objNum;
      annotRefs.push(`${objNum} 0 R`);
      objectTexts.push(dict);
      objectTexts.push(apObj);
      objNum += 2;
      if (annot.replies && annot.replies.length > 0) {
        const replyObjs = buildReplyObjects(annot.replies, parentObjNum, rect, objNum, false);
        objectTexts.push(...replyObjs.objectTexts);
        annotRefs.push(...replyObjs.annotRefs);
        objNum += replyObjs.objectTexts.length;
      }
    } catch (err) {
      warningHandler?.(skipMessage(annot.type, err));
    }
  }

  return { objectTexts, annotRefs };
}

/**
 * Consolidates highlight annotations by using the OCR line/word structure.
 *
 * @param {Array<AnnotationHighlight>} pageAnnotations
 * @param {OcrPage} [pageObj]
 * @returns {Array<AnnotationHighlight>}
 */
export function consolidateAnnotations(pageAnnotations, pageObj) {
  if (pageAnnotations.length === 0 || !pageObj || pageObj.lines.length === 0) return [];

  // Group annotations by style key (color + opacity) and groupId.
  const groups = {};
  for (let i = 0; i < pageAnnotations.length; i++) {
    const annot = pageAnnotations[i];
    const key = annot.groupId || `style_${annot.color}_${annot.opacity}`;
    if (!groups[key]) {
      groups[key] = {
        color: annot.color, opacity: annot.opacity, comment: annot.comment || '', author: annot.author, createdAt: annot.createdAt, replies: annot.replies, annotations: [],
      };
    }
    groups[key].annotations.push(annot);
  }

  const result = [];

  for (const groupKey of Object.keys(groups)) {
    const group = groups[groupKey];

    // For each line in the page, find which word indices are highlighted by any annotation in this group.
    /** @type {Map<number, Set<number>>} */
    const highlightedWords = new Map();
    for (let li = 0; li < pageObj.lines.length; li++) {
      const line = pageObj.lines[li];
      for (let wi = 0; wi < line.words.length; wi++) {
        const word = line.words[wi];
        for (let ai = 0; ai < group.annotations.length; ai++) {
          const annot = group.annotations[ai];
          // Check if the annotation bbox overlaps with the word bbox.
          if (!(annot.bbox.left < word.bbox.right && annot.bbox.right > word.bbox.left
            && annot.bbox.top < word.bbox.bottom && annot.bbox.bottom > word.bbox.top)) continue;
          // If annotation has quads, require overlap with at least one quad.
          if (annot.quads) {
            const matchesQuad = annot.quads.some((quad) => quad.left < word.bbox.right && quad.right > word.bbox.left
              && quad.top < word.bbox.bottom && quad.bottom > word.bbox.top);
            if (!matchesQuad) continue;
          }
          if (!highlightedWords.has(li)) highlightedWords.set(li, new Set());
          /** @type {Set<number>} */ (highlightedWords.get(li)).add(wi);
          break;
        }
      }
    }

    if (highlightedWords.size === 0) continue;

    // For each line with highlighted words, split into runs of consecutive word indices.
    // Each run produces one quad bbox.
    /** @type {Array<{lineIndex: number, bbox: bbox}>} */
    const lineQuads = [];
    const sortedLineIndices = [...highlightedWords.keys()].sort((a, b) => a - b);

    for (const li of sortedLineIndices) {
      const wordSet = /** @type {Set<number>} */ (highlightedWords.get(li));
      const wordIndices = [...wordSet].sort((a, b) => a - b);
      const line = pageObj.lines[li];

      let runStart = 0;
      for (let i = 1; i <= wordIndices.length; i++) {
        if (i === wordIndices.length || wordIndices[i] !== wordIndices[i - 1] + 1) {
          // End of a consecutive run: merge bboxes of words in this run.
          let left = line.words[wordIndices[runStart]].bbox.left;
          let top = line.words[wordIndices[runStart]].bbox.top;
          let right = line.words[wordIndices[runStart]].bbox.right;
          let bottom = line.words[wordIndices[runStart]].bbox.bottom;
          for (let j = runStart + 1; j < i; j++) {
            const wb = line.words[wordIndices[j]].bbox;
            left = Math.min(left, wb.left);
            top = Math.min(top, wb.top);
            right = Math.max(right, wb.right);
            bottom = Math.max(bottom, wb.bottom);
          }
          lineQuads.push({
            lineIndex: li,
            bbox: {
              left, top, right, bottom,
            },
          });
          runStart = i;
        }
      }
    }

    // Merge quads from consecutive lines into multi-quad annotations.
    // Separate runs on the same line remain separate annotations.
    let currentQuads = [{ ...lineQuads[0].bbox }];
    let currentBbox = { ...lineQuads[0].bbox };
    let prevLineIndex = lineQuads[0].lineIndex;

    for (let i = 1; i < lineQuads.length; i++) {
      const isNextLine = lineQuads[i].lineIndex === prevLineIndex + 1;
      if (isNextLine) {
        currentQuads.push({ ...lineQuads[i].bbox });
        currentBbox.left = Math.min(currentBbox.left, lineQuads[i].bbox.left);
        currentBbox.top = Math.min(currentBbox.top, lineQuads[i].bbox.top);
        currentBbox.right = Math.max(currentBbox.right, lineQuads[i].bbox.right);
        currentBbox.bottom = Math.max(currentBbox.bottom, lineQuads[i].bbox.bottom);
      } else {
        result.push({
          bbox: currentBbox, quads: currentQuads, color: group.color, opacity: group.opacity, comment: group.comment, replies: group.replies,
        });
        currentQuads = [{ ...lineQuads[i].bbox }];
        currentBbox = { ...lineQuads[i].bbox };
      }
      prevLineIndex = lineQuads[i].lineIndex;
    }
    result.push({
      bbox: currentBbox,
      quads: currentQuads,
      color: group.color,
      opacity: group.opacity,
      comment: group.comment,
      author: group.author,
      createdAt: group.createdAt,
      replies: group.replies,
    });
  }

  return result;
}
