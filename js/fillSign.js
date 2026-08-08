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

// --- Deterministic fillable-area detection ---
// Finds checkboxes and blank lines a form draws as plain page content, so the UI can offer click-to-fill on documents whose interactive fields did not survive.
// Detection is recomputed from the page on every use and never stored.
// Persisting it would freeze detection mistakes into users' files.

/**
 * Drawn shapes from the PDF parse, keyed by the OcrPage they belong to.
 * Keying on page identity keeps this data off the OcrPage itself, so it survives page reorders and can never serialize into `.scribe` files.
 * @type {WeakMap<object, {
 *   squares?: Array<{left: number, top: number, right: number, bottom: number, stroke: boolean}>,
 *   marks?: Array<{left: number, top: number, right: number, bottom: number}>,
 *   marksOverflow?: boolean,
 *   images?: Array<{left: number, top: number, right: number, bottom: number}>,
 *   glyphBoxes?: Array<{id: string, bbox: {left: number, top: number, right: number, bottom: number}}>,
 * }>}
 */
const fillShapesByPage = new WeakMap();

/** Import hook that attaches a page's drawn shapes from the PDF parse. */
export function setPageFillShapes(pageObj, shapes) {
  if (pageObj && (shapes?.squares?.length || shapes?.marks?.length || shapes?.images?.length
    || shapes?.glyphBoxes?.length)) {
    fillShapesByPage.set(pageObj, shapes);
  }
}

// Units: pt thresholds convert through the page's px-per-pt scale, em thresholds scale by the candidate's own word height, and frac thresholds are fractions of the named quantity.
const DETECT = {
  // Smaller is a list bullet or radio dot, larger is a call-out frame.
  boxMinPt: 5,
  boxMaxPt: 24,
  // Symbol-font em boxes distort the square, so aspect accepts anything from tallish to wide.
  boxAspectMin: 0.55,
  boxAspectMax: 1.8,
  // A box glyph packed tight on both sides is a placeholder inside a token, as in part-number templates like G7SA-(box)A(box)B.
  // A checkbox keeps open space on at least one side.
  boxGluedGapEm: 0.2,
  boxCoverFrac: 0.15,
  fullPageImageFrac: 0.8,
  // Adjacent underscore runs closer than half a line height are one blank split by word segmentation.
  // A form's separate fields (First / Middle / Last) sit farther apart.
  runMergeGapEm: 0.5,
  // A word reaching below the run's midline sits on it; a caption hugging the space above stays clear.
  occupiedMidlineFrac: 0.4,
  occupiedMinOverlapPx: 6,
  occupiedOverlapFrac: 0.1,
  leaderPageNumGapEm: 2,
  // A ")" hugging the run's right end is a pleading-caption divider with the paren split into its own word.
  capParenGapEm: 0.5,
  standaloneRuleWidthFrac: 0.4,
  stackGapMinEm: 0.45,
  stackGapMaxEm: 4.6,
  // Two mates make a group of three answer rows; decorative cover rules come in pairs.
  stackMinMates: 2,
  promptLookbackEm: 2.5,
  segCaptionBandEm: 2.2,
  segClusterGapEm: 1.6,
  // A caption names its field in a few short words; anything longer reads as a sentence under a rule.
  segMaxClusterWords: 5,
  segMaxClusterChars: 42,
  segRowToleranceEm: 0.5,
  segMinSegmentPx: 30,
  parensMinAspectOfHeight: 1,
  // Reaching past the slot's midline is what counts as sitting in it, so a descender from the line above does not suppress.
  parensFilledMidlineFrac: 0.4,
};

// Words that name a telephone field, for the area-code slot printed as "( )".
// Substring matching is deliberate: "Telephone" carries "phone", "Cellular" carries "cell".
const PHONE_LABEL = /phone|fax|facsimile|mobile|\bcell|\btel\b|\bdaytime\b|\bevening\b/i;

// Codepoints that render as an empty checkbox.
// The first two rows are trusted Unicode (1F78E and 1F78F are the supplemental light/bold white squares Wingdings boxes decode to).
// The third row is wrong-but-stable codes that empty boxes in symbol fonts consistently extract as.
// F06F/F0A8/F071 are the Word checkbox inserts under the symbol-PUA convention.
// Already-checked box glyphs (2611, 2612, 22A0, 22A1, 2BBD, and Wingdings-family F0FE/F053) are deliberately absent, so a checked box is never a candidate and never a target.
const CHECKBOX_CODES = new Set([
  0x2610, 0x25A1, 0x25A2, 0x25FB, 0x274F, 0x2751, 0x2752,
  0x1F78E, 0x1F78F,
  0x2468, 0x2469, 0x2785, 0x2787, 0x2788, 0x2789, 0xF06F, 0xF0A8, 0xF071,
]);

/**
 * Detect fillable areas on page `n` from the page's own content.
 * Three signals: checkbox glyphs, underscore-run blanks, and the empty parentheses a phone row prints for its area code.
 * The arms produce disjoint geometry by construction, since a word is a box glyph, an underscore carrier, or a parenthesis but never two of those.
 *
 * @param {import('./containers/scribeDoc.js').ScribeDoc} doc
 * @param {number} n
 * @param {?Array<{arm: string, rule: string, bbox: bbox}>} [rejects] - When supplied, every killed candidate is appended with the rule that killed it (benchmark instrumentation).
 * @returns {Array<{kind: 'checkbox'|'blank', bbox: bbox, source: 'glyph'|'underscore'|'parens'}>}
 *   Targets in reading order, in page coordinates (the OCR frame).
 */
export function detectFillTargets(doc, n, rejects) {
  const pageObj = doc.ocr.active?.[n];
  if (!pageObj) return [];
  const pageSizePt = doc.inputData?.pageStats?.[n]?.pageSize?.[0];
  const pxPerPt = pageSizePt > 0 ? pageObj.dims.width / pageSizePt : 300 / 72;
  const targets = [];
  const kill = rejects ? (arm, rule, bbox) => rejects.push({ arm, rule, bbox: { ...bbox } }) : null;

  // Lifted fill-text and form-field values are our own output, never detection targets.
  const contentLines = pageObj.lines.filter((l) => l.words.length > 0 && !/^word_\d+_(txt|f)/.test(l.words[0].id));
  const words = [];
  for (const line of pageObj.lines) for (const w of line.words) words.push(w);
  const shapes = fillShapesByPage.get(pageObj) || {};
  const marks = shapes.marks || [];
  const images = shapes.images || [];
  // A box glyph's word bbox is its font's em box, which for symbol fonts can sit a quarter of a box height off the drawn square.
  const glyphInk = new Map((shapes.glyphBoxes || []).map((g) => [g.id, g.bbox]));
  const pageArea = pageObj.dims.width * pageObj.dims.height;
  const overArea = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
    * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  // A box already marked (a check drawn over it, or a raster painting its interior) can never be unchecked, so it is never a target.
  // Full-page images are exempt: a searchable scan's background marks nothing.
  const boxMarked = (b) => {
    const area = (b.right - b.left) * (b.bottom - b.top);
    return marks.some((m) => overArea(m, b) >= area * DETECT.boxCoverFrac)
      || images.some((im) => overArea(im, b) >= area * DETECT.boxCoverFrac
        && (im.right - im.left) * (im.bottom - im.top) < pageArea * DETECT.fullPageImageFrac);
  };

  // Arm 1, glyph checkboxes: single-codepoint words whose code is a known empty-box signature.
  for (const line of contentLines) {
    for (const word of line.words) {
      // A single code point is at most 2 UTF-16 units, so longer strings skip the spread.
      if (word.text.length > 2) continue;
      const cps = [...word.text];
      if (cps.length !== 1) continue;
      const cp = cps[0].codePointAt(0);
      if (!CHECKBOX_CODES.has(cp)) continue;
      const w = word.bbox.right - word.bbox.left;
      const h = word.bbox.bottom - word.bbox.top;
      const sizeOk = w >= DETECT.boxMinPt * pxPerPt && w <= DETECT.boxMaxPt * pxPerPt
        && h >= DETECT.boxMinPt * pxPerPt && h <= DETECT.boxMaxPt * pxPerPt
        && w / h >= DETECT.boxAspectMin && w / h <= DETECT.boxAspectMax;
      if (!sizeOk) {
        if (kill) kill('glyph', 'size', word.bbox);
        continue;
      }
      const tight = (test) => line.words.some((o) => o !== word
        && o.bbox.top < word.bbox.bottom && word.bbox.top < o.bbox.bottom && test(o));
      const glued = tight((o) => Math.abs(o.bbox.left - word.bbox.right) < DETECT.boxGluedGapEm * h)
        && tight((o) => Math.abs(word.bbox.left - o.bbox.right) < DETECT.boxGluedGapEm * h);
      if (glued) {
        if (kill) kill('glyph', 'glued', word.bbox);
        continue;
      }
      // A flattened form fill leaves the box glyph unchanged and puts the mark on top of it, as a separate text word ("X") or as drawn strokes.
      // Sibling empty-box glyphs are exempt because stacked box rows overlap typographically when the row pitch is tighter than the glyph's em box.
      const drawnBox = glyphInk.get(word.id) || word.bbox;
      const covered = words.some((o) => {
        if (o === word) return false;
        if (overArea(o.bbox, word.bbox) < w * h * DETECT.boxCoverFrac) return false;
        const oc = [...o.text];
        return !(oc.length === 1 && CHECKBOX_CODES.has(oc[0].codePointAt(0)));
      }) || boxMarked(drawnBox);
      if (covered) {
        if (kill) kill('glyph', 'covered', drawnBox);
        continue;
      }
      targets.push({ kind: 'checkbox', bbox: { ...drawnBox }, source: 'glyph' });
    }
  }

  // Arm 2, underscore blanks: runs of 3 or more underscores, merged across small same-line gaps.
  const underscoreOnlyLineTops = [];
  for (const line of pageObj.lines) {
    if (line.words.length === 1 && /^_{3,}$/.test(line.words[0].text)) underscoreOnlyLineTops.push(line.bbox.top);
  }
  for (const line of contentLines) {
    /** @type {Array<{left: number, right: number, top: number, bottom: number, h: number}>} */
    const runs = [];
    for (const word of line.words) {
      if (!/_{3,}/.test(word.text)) continue;
      const w = word.bbox.right - word.bbox.left;
      const h = word.bbox.bottom - word.bbox.top;
      for (const m of word.text.matchAll(/_{3,}/g)) {
        let left;
        let right;
        if (word.chars && word.chars.length === word.text.length) {
          left = word.chars[m.index].bbox.left;
          right = word.chars[m.index + m[0].length - 1].bbox.right;
        } else {
          left = word.bbox.left + (m.index / word.text.length) * w;
          right = word.bbox.left + ((m.index + m[0].length) / word.text.length) * w;
        }
        if (!(right > left)) continue;
        // A run whose word continues with ")" is a pleading-caption divider, never a blank.
        if (word.text[m.index + m[0].length] === ')') {
          if (kill) {
            kill('underscore', 'pleading-divider', {
              left, top: word.bbox.top, right, bottom: word.bbox.bottom,
            });
          }
          continue;
        }
        runs.push({
          left, right, top: word.bbox.top, bottom: word.bbox.bottom, h,
        });
      }
    }
    runs.sort((a, b) => a.left - b.left);
    /** @type {?typeof runs[0]} */
    let cur = null;
    const judge = () => {
      if (!cur) return;
      const run = cur;
      cur = null;
      const runW = run.right - run.left;
      const bbox = {
        left: Math.round(run.left), top: run.top, right: Math.round(run.right), bottom: run.bottom,
      };
      // A word from another line sitting on the run means the blank already holds an answer.
      // Underscore words never occupy, since a stacked sibling blank is not an answer.
      const occupied = words.some((o) => o.bbox.top < run.bottom - DETECT.occupiedMidlineFrac * run.h
        && o.bbox.bottom > (run.top + run.bottom) / 2
        && Math.min(o.bbox.right, run.right) - Math.max(o.bbox.left, run.left)
          > Math.max(DETECT.occupiedMinOverlapPx, runW * DETECT.occupiedOverlapFrac)
        && !line.words.includes(o) && !/_{3,}/.test(o.text));
      if (occupied) {
        if (kill) kill('underscore', 'occupied', bbox);
        return;
      }
      // Text on the left and a page number on the right make this a table-of-contents leader line.
      // The number may live in a separate right-aligned line, so search the whole band.
      const inBand = (o) => o.bbox.top < run.bottom && o.bbox.bottom > run.top;
      const rightWord = words.find((o) => inBand(o) && o.bbox.left >= run.right - 2
        && o.bbox.left - run.right < DETECT.leaderPageNumGapEm * run.h && /^[0-9]{1,4}[.)]?$/.test(o.text));
      const leftText = words.some((o) => inBand(o) && o.bbox.right <= run.left + 2 && !/^_{3,}$/.test(o.text));
      if (rightWord && leftText) {
        if (kill) kill('underscore', 'toc-leader', bbox);
        return;
      }
      const capParen = words.some((o) => inBand(o) && /^\)[.,;:]?$/.test(o.text)
        && o.bbox.left >= run.right - 2 && o.bbox.left - run.right < DETECT.capParenGapEm * run.h);
      if (capParen) {
        if (kill) kill('underscore', 'caption-paren', bbox);
        return;
      }
      // A wide run alone on its line is usually a decorative rule, as on brief covers and in caption blocks.
      // It stays a blank only in form context: stacked with sibling answer lines at row spacing, or directly under a line that ends like a prompt (":", "?", ")").
      if (line.words.length === 1 && runW >= pageObj.dims.width * DETECT.standaloneRuleWidthFrac) {
        const stacked = underscoreOnlyLineTops.filter((t) => {
          const g = Math.abs(t - run.top);
          return g >= DETECT.stackGapMinEm * run.h && g <= DETECT.stackGapMaxEm * run.h;
        }).length >= DETECT.stackMinMates;
        let prompt = false;
        let bestBottom = -Infinity;
        let bestLast = null;
        for (const l of pageObj.lines) {
          if (l === line || l.bbox.bottom > run.top || run.top - l.bbox.bottom > DETECT.promptLookbackEm * run.h) continue;
          if (l.bbox.bottom > bestBottom) {
            bestBottom = l.bbox.bottom;
            bestLast = l.words[l.words.length - 1];
          }
        }
        if (bestLast && /[:?)]$/.test(bestLast.text)) prompt = true;
        if (!stacked && !prompt) {
          if (kill) kill('underscore', 'standalone-rule', bbox);
          return;
        }
      }
      // One run above several short captions is one field per caption, as in (First) (Middle) (Last) under a single stretch of underscores.
      // Any failed condition falls back to the whole run as one target.
      // The band's near edge tests the caption line's vertical center, because an underscore word's em box descends below the drawn line and a caption's top can sit inside that descent.
      // Widely-spaced captions group as separate lines, so the caption row is every band line whose top sits within the row tolerance of the topmost one.
      const bandLines = [];
      let rowTop = Infinity;
      for (const l of pageObj.lines) {
        if (l === line || l.words.length === 0) continue;
        const cy = (l.bbox.top + l.bbox.bottom) / 2;
        if (cy <= run.bottom || l.bbox.top > run.bottom + DETECT.segCaptionBandEm * run.h) continue;
        bandLines.push(l);
        if (l.bbox.top < rowTop) rowTop = l.bbox.top;
      }
      const below = [];
      for (const l of bandLines) {
        if (l.bbox.top - rowTop > DETECT.segRowToleranceEm * run.h) continue;
        for (const o of l.words) {
          if (/_{3,}/.test(o.text)) continue;
          const cx = (o.bbox.left + o.bbox.right) / 2;
          if (cx < run.left || cx > run.right) continue;
          below.push(o);
        }
      }
      if (below.length >= 2) {
        below.sort((a, b) => a.bbox.left - b.bbox.left);
        const clusters = [[below[0]]];
        for (let i = 1; i < below.length; i++) {
          if (below[i].bbox.left - below[i - 1].bbox.right > DETECT.segClusterGapEm * run.h) clusters.push([]);
          clusters[clusters.length - 1].push(below[i]);
        }
        const captionLike = (c) => {
          if (c.length > DETECT.segMaxClusterWords) return false;
          const t = c.map((w) => w.text).join(' ');
          return t.length <= DETECT.segMaxClusterChars && /^[(A-Z]/.test(t);
        };
        if (clusters.length >= 2 && clusters.every(captionLike)) {
          const cuts = [];
          for (let i = 1; i < clusters.length; i++) {
            const prevRight = Math.max(...clusters[i - 1].map((w) => w.bbox.right));
            const nextLeft = Math.min(...clusters[i].map((w) => w.bbox.left));
            cuts.push((prevRight + nextLeft) / 2);
          }
          const edges = [run.left, ...cuts, run.right];
          const segments = [];
          for (let i = 0; i + 1 < edges.length; i++) {
            segments.push({ left: edges[i], right: edges[i + 1] });
          }
          if (segments.every((s) => s.right - s.left >= DETECT.segMinSegmentPx)) {
            for (const s of segments) {
              targets.push({
                kind: 'blank',
                bbox: {
                  left: Math.round(s.left), top: run.top, right: Math.round(s.right), bottom: run.bottom,
                },
                source: 'underscore',
              });
            }
            return;
          }
        }
      }
      targets.push({ kind: 'blank', bbox, source: 'underscore' });
    };
    for (const run of runs) {
      if (cur && run.left - cur.right <= cur.h * DETECT.runMergeGapEm) {
        cur.right = Math.max(cur.right, run.right);
        cur.top = Math.min(cur.top, run.top);
        cur.bottom = Math.max(cur.bottom, run.bottom);
      } else {
        judge();
        cur = { ...run };
      }
    }
    judge();
  }

  // Arm 3, phone-parens slots: an adjacent "(" ")" word pair on one line, with a phone label to its left.
  // Without that label, empty parentheses are overwhelmingly prose.
  for (const line of contentLines) {
    /** @type {?Object} */
    let openParen = null;
    for (const word of line.words) {
      if (word.text === '(') {
        openParen = word;
        continue;
      }
      if (word.text !== ')' || !openParen) {
        openParen = null;
        continue;
      }
      const slot = {
        left: openParen.bbox.right,
        top: openParen.bbox.top,
        right: word.bbox.left,
        bottom: openParen.bbox.bottom,
      };
      const pairOpen = openParen;
      openParen = null;
      const slotH = slot.bottom - slot.top;
      if (slot.right - slot.left < slotH * DETECT.parensMinAspectOfHeight) {
        if (kill) kill('parens', 'interior', slot);
        continue;
      }
      let labelled = false;
      for (const o of line.words) {
        if (o === pairOpen) break;
        if (PHONE_LABEL.test(o.text)) { labelled = true; break; }
      }
      if (!labelled) {
        if (kill) kill('parens', 'no-phone-label', slot);
        continue;
      }
      // A filled copy keeps the printed parentheses and puts the answer between them.
      const filled = words.some((o) => !line.words.includes(o)
        && o.bbox.top < slot.bottom - DETECT.parensFilledMidlineFrac * slotH
        && o.bbox.bottom > (slot.top + slot.bottom) / 2
        && Math.min(o.bbox.right, slot.right) - Math.max(o.bbox.left, slot.left) > 0);
      if (filled) {
        if (kill) kill('parens', 'filled', slot);
        continue;
      }
      targets.push({ kind: 'blank', bbox: slot, source: 'parens' });
    }
  }

  targets.sort((a, b) => a.bbox.top - b.bbox.top || a.bbox.left - b.bbox.left);
  return targets;
}
