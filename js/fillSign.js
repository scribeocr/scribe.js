// Fill & sign rows live in doc.annotations, but PDF export flattens them into page content instead of writing them as annotations.
import ocr from './objects/ocrObjects.js';
import { calcWordMetrics } from './utils/fontUtils.js';
import { calcLang, round3 } from './utils/miscUtils.js';

// The fill-text marking stays off the row so it never reaches the public `.scribe` annotations.
const fillTextRows = new WeakSet();

export const isFillTextRow = (row) => fillTextRows.has(row);

/** Mark the freetext rows at the given `[page, index]` positions as fill text. */
export function markFillTextRefs(doc, refs) {
  for (const ref of refs || []) {
    const row = doc.annotations.pages[ref?.[0]]?.[ref?.[1]];
    if (row && row.type === 'freetext') fillTextRows.add(row);
  }
}

export function collectFillTextRefs(doc) {
  const refs = [];
  for (let n = 0; n < doc.annotations.pages.length; n++) {
    const rows = doc.annotations.pages[n] || [];
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].type === 'freetext' && fillTextRows.has(rows[i])) refs.push([n, i]);
    }
  }
  return refs;
}

// This id shape must not match form-field lifted ids (`word_<page>_f...`), or regenerating one feature's lifted words could delete the other's.
const FILL_TEXT_ID_RE = /^word_\d+_txt/;
let fillTextSeq = 0;

export const isFillTextLine = (line) => line.words.length > 0 && line.words.every((w) => FILL_TEXT_ID_RE.test(w.id));

/**
 * Regenerate a fill-text row's bbox and lifted words from its contents.
 * @param {import('./containers/scribeDoc.js').ScribeDoc} doc
 * @param {number} n
 * @param {AnnotationFreeText} row
 * @param {bbox} [prevBbox] - The row's extent before a move/resize, so stale words are swept from the old location too.
 */
export function syncFillText(doc, n, row, prevBbox) {
  const pageObj = doc.ocr.active?.[n];
  if (!pageObj) return;

  const pad = 2;
  const inside = (line, b) => b && line.bbox.left >= b.left - pad && line.bbox.right <= b.right + pad
    && line.bbox.top >= b.top - pad && line.bbox.bottom <= b.bottom + pad;
  pageObj.lines = pageObj.lines.filter((line) => !(isFillTextLine(line) && (inside(line, row.bbox) || inside(line, prevBbox))));

  const fontSize = row.fontSize;
  const lineH = fontSize * 1.2;
  const asc = fontSize * 0.8;
  const desc = fontSize * 0.2;
  const textLines = String(row.contents || '').split(/\r\n|\r|\n/);

  const { left } = row.bbox;
  const { top } = row.bbox;
  let maxRight = left;
  fillTextSeq++;
  let liftLineIdx = 0;
  const newLines = [];
  for (let li = 0; li < textLines.length; li++) {
    const lineTop = top + li * lineH;
    const baselineY = lineTop + asc;
    const tokens = textLines[li].match(/\S+/g) || [];
    if (tokens.length === 0) continue;
    liftLineIdx++;
    const lineObj = new ocr.OcrLine(pageObj, {
      left, top: Math.round(lineTop), right: left, bottom: Math.round(lineTop + lineH),
    }, [0, Math.round(baselineY) - Math.round(lineTop + lineH)], asc, null);
    let x = left;
    let spaceAdv = fontSize * 0.278;
    const leadWs = /^\s*/.exec(textLines[li])[0].length;
    x += leadWs * spaceAdv;
    for (let wi = 0; wi < tokens.length; wi++) {
      const wordID = `word_${n + 1}_txt${fillTextSeq}e${liftLineIdx}_${wi + 1}`;
      const wordObj = new ocr.OcrWord(lineObj, wordID, tokens[wi], {
        left: Math.round(x), top: Math.round(lineTop), right: Math.round(x) + 1, bottom: Math.round(lineTop + lineH),
      });
      wordObj.conf = 100;
      wordObj.visualCoords = false;
      wordObj.lang = calcLang(tokens[wi]);
      wordObj.style.font = 'Helvetica';
      wordObj.style.size = round3(fontSize);
      let width = tokens[wi].length * fontSize * 0.5;
      try {
        const metrics = calcWordMetrics(wordObj, doc.fonts);
        width = metrics.visualWidth;
        spaceAdv = fontSize * 0.278;
        if (metrics.font?.opentype) {
          spaceAdv = metrics.font.opentype.charToGlyph(' ').advanceWidth * (fontSize / metrics.font.opentype.unitsPerEm);
        }
      } catch { /* keep the estimate */ }
      wordObj.bbox = {
        left: Math.round(x),
        top: Math.round(baselineY - asc),
        right: Math.round(x + width),
        bottom: Math.round(baselineY + desc),
      };
      lineObj.words.push(wordObj);
      x += width + spaceAdv;
    }
    lineObj.bbox.right = Math.round(x - spaceAdv);
    if (lineObj.bbox.right > maxRight) maxRight = lineObj.bbox.right;
    newLines.push(lineObj);
  }

  row.bbox = {
    left,
    top,
    right: Math.max(maxRight, left + Math.round(fontSize)),
    bottom: Math.round(top + Math.max(1, textLines.length) * lineH),
  };

  for (const lineObj of newLines) {
    const insertAt = pageObj.lines.findIndex((l) => l.bbox.top > lineObj.bbox.top);
    if (insertAt === -1) pageObj.lines.push(lineObj);
    else pageObj.lines.splice(insertAt, 0, lineObj);
  }
}

/**
 * Place a typed-text item on page n, anchored at its top-left corner.
 * @param {import('./containers/scribeDoc.js').ScribeDoc} doc
 * @param {number} n
 * @param {{ x: number, y: number, contents?: string, fontSize: number, textColor?: string }} item
 * @returns {AnnotationFreeText}
 */
export function addFillText(doc, n, item) {
  if (!item || !(Number(item.fontSize) > 0)) throw new Error('addFillText requires a positive fontSize.');
  /** @type {AnnotationFreeText} */
  const row = {
    type: 'freetext',
    bbox: {
      left: item.x, top: item.y, right: item.x + item.fontSize, bottom: item.y + item.fontSize * 1.2,
    },
    contents: String(item.contents || ''),
    fontSize: Number(item.fontSize),
    textColor: item.textColor || '#000000',
    opacity: 1,
  };
  while (doc.annotations.pages.length <= n) doc.annotations.pages.push([]);
  doc.annotations.pages[n].push(row);
  fillTextRows.add(row);
  syncFillText(doc, n, row);
  return row;
}

/**
 * Place a drawn item on page n.
 * @param {import('./containers/scribeDoc.js').ScribeDoc} doc
 * @param {number} n
 * @param {{ strokes: Array<Array<[number, number]>>, width?: number, color?: string }} item - Stroke polylines in page coordinates (top-left origin).
 * @returns {AnnotationInk}
 */
export function addInk(doc, n, item) {
  if (!item || !Array.isArray(item.strokes) || item.strokes.length === 0
    || item.strokes.some((s) => !Array.isArray(s) || s.length === 0)) {
    throw new Error('addInk requires at least one stroke with at least one point.');
  }
  const width = Number(item.width) > 0 ? Number(item.width) : 4;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const stroke of item.strokes) {
    for (const [x, y] of stroke) {
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  const pad = Math.ceil(width / 2);
  /** @type {AnnotationInk} */
  const row = {
    type: 'ink',
    strokes: item.strokes.map((s) => s.map(([x, y]) => [x, y])),
    width,
    color: item.color || '#000000',
    bbox: {
      left: left - pad, top: top - pad, right: right + pad, bottom: bottom + pad,
    },
  };
  while (doc.annotations.pages.length <= n) doc.annotations.pages.push([]);
  doc.annotations.pages[n].push(row);
  return row;
}

/**
 * Place an image item on page n.
 * @param {import('./containers/scribeDoc.js').ScribeDoc} doc
 * @param {number} n
 * @param {{ bbox: bbox, imageData: string }} item - `imageData` is a PNG or JPEG data URL.
 * @returns {AnnotationStamp}
 */
export function addStamp(doc, n, item) {
  if (!item || !/^data:image\/(png|jpeg);base64,/.test(item.imageData || '')) {
    throw new Error('addStamp requires a PNG or JPEG data URL.');
  }
  if (!item.bbox || !(item.bbox.right > item.bbox.left) || !(item.bbox.bottom > item.bbox.top)) {
    throw new Error('addStamp requires a bbox with positive width and height.');
  }
  /** @type {AnnotationStamp} */
  const row = {
    type: 'stamp',
    bbox: {
      left: item.bbox.left, top: item.bbox.top, right: item.bbox.right, bottom: item.bbox.bottom,
    },
    imageData: item.imageData,
  };
  while (doc.annotations.pages.length <= n) doc.annotations.pages.push([]);
  doc.annotations.pages[n].push(row);
  return row;
}
