/**
 * @param {AnnotationHighlight[]} annotations
 * @param {number} startObjNum
 * @param {{ width: number, height: number }} outputDims
 */
export function buildHighlightAnnotObjects(annotations, startObjNum, outputDims) {
  const objectTexts = [];
  const annotRefs = [];

  for (let a = 0; a < annotations.length; a++) {
    const annot = annotations[a];
    const objNum = startObjNum + a;
    annotRefs.push(`${objNum} 0 R`);

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
      // UTF-16BE hex string with BOM for Unicode compatibility.
      let hexStr = 'FEFF';
      for (let ci = 0; ci < annot.comment.length; ci++) {
        hexStr += annot.comment.charCodeAt(ci).toString(16).toUpperCase().padStart(4, '0');
      }
      str += ` /Contents <${hexStr}>`;
    }
    str += '>>\nendobj\n\n';

    objectTexts.push(str);
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
        color: annot.color, opacity: annot.opacity, comment: annot.comment || '', annotations: [],
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
          bbox: currentBbox, quads: currentQuads, color: group.color, opacity: group.opacity, comment: group.comment,
        });
        currentQuads = [{ ...lineQuads[i].bbox }];
        currentBbox = { ...lineQuads[i].bbox };
      }
      prevLineIndex = lineQuads[i].lineIndex;
    }
    result.push({
      bbox: currentBbox, quads: currentQuads, color: group.color, opacity: group.opacity, comment: group.comment,
    });
  }

  return result;
}
