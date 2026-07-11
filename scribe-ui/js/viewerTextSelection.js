import scribe from '../../scribe.js';
import { UiText } from './viewerWordObjects.js';

/**
 * Custom text selection for the read-only viewer, with no text in the DOM.
 *
 * The document already carries a complete geometric text model (page -> line -> word -> char, each with a bounding box, in reading order).
 * This module treats a selection as what it is in that model: a contiguous interval of the page's linear character sequence.
 * Every other operation is a projection of that interval.
 * A caret is an index, a hit test is "nearest index to this point", copying is a substring,
 * drawing is one rectangle per line the interval crosses, and highlighting is the set of words the interval touches.
 */

/** Distance (px, client space) from the scroll container's edge at which a drag starts autoscrolling. */
const AUTOSCROLL_ZONE = 44;

/** Autoscroll speed (px per frame) at a full `AUTOSCROLL_ZONE` of overshoot. */
const AUTOSCROLL_MAX = 26;

/** Two pointerdowns within this many ms and this many px of each other count as one multi-click gesture. */
const MULTI_CLICK_MS = 450;
const MULTI_CLICK_PX = 5;

/** A touch held this long, within `TOUCH_HOLD_PX` of where it started, selects the word under it. */
const TOUCH_HOLD_MS = 500;
const TOUCH_HOLD_PX = 10;

/**
 * How far the selection rectangle extends past the last word when a line's trailing newline is selected, as a fraction of the rectangle's height.
 * Matches the small sliver a browser paints for a fully-selected line rather than running out to the distant column edge.
 */
const NEWLINE_TAIL = 0.4;

/** Selection granularity, set by click count and held for the rest of the drag. */
const CHAR = 1;
const WORD = 2;
const LINE = 3;

let selectionStyleSheetInjected = false;

/** Inject the one-time selection stylesheet. */
export function ensureSelectionStyleSheet() {
  if (selectionStyleSheetInjected || typeof document === 'undefined') return;
  selectionStyleSheetInjected = true;
  const styleEl = document.createElement('style');
  // multiply keeps glyphs at full contrast under the wash, unlike a translucent per-rect background, and matches how the highlight layer below already blends.
  styleEl.textContent = '.scribe-layer-select{mix-blend-mode:multiply;pointer-events:none}'
    + '.scribe-sel-rect{position:absolute;background:var(--scribe-sel,#a6c8ff)}'
    + '.scribe-mark-rect{position:absolute;background:var(--scribe-match,#a9c4f5)}'
    + '.scribe-mark-rect.scribe-mark-active{background:var(--scribe-match-active,#ffb454)}';
  document.head.appendChild(styleEl);
}

const NO_ADJ = { x: 0, y: 0 };

/**
 * @typedef {object} LineEntry
 * @property {OcrLine} line
 * @property {Array<OcrWord>} words - Text-bearing words, in reading order.
 * @property {Array<{left: number, right: number, top: number, bottom: number}>} boxes - Word boxes, de-skewed, in group-local space.
 * @property {Array<number>} wordStart - Character offset of each word's first character.
 * @property {Array<number>} dx - Per-word x shift applied by the page's de-skew adjustment.
 * @property {number} start - Offset of the line's first character.
 * @property {number} end - Offset just past its last character, where its newline sits.
 * @property {number} orientation
 * @property {{x: number, y: number}} adjL
 * @property {{left: number, right: number, top: number, bottom: number}} lbox - Union of the line's word boxes, de-skewed and normalized, in `boxes` space.
 *   Not `line.bbox`, which can be inverted, null, or offset from the glyphs.
 * @property {{left: number, right: number, top: number, bottom: number}} band - The line's share of the page (see `_computeBands`).
 * @property {number} rectTop
 * @property {number} rectBottom
 * @property {Array<?Float64Array>} edges - Per-word character x-edges, filled on first use.
 */

/**
 * @typedef {object} SelPoint
 * @property {number} n - Page index.
 * @property {number} off - Character offset into that page's `PageTextIndex.text`.
 */

/**
 * @typedef {object} SelRect
 * @property {number} orientation
 * @property {number} left
 * @property {number} top
 * @property {number} right
 * @property {number} bottom
 */

/**
 * Orders two selection points by page index, then by character offset within the page.
 * @param {SelPoint} a
 * @param {SelPoint} b
 * @returns {number} Negative when `a` precedes `b`, positive when it follows, zero when equal.
 */
const cmpPoint = (a, b) => (a.n !== b.n ? a.n - b.n : a.off - b.off);

/**
 * A page's text as a linear character sequence, plus the geometry to map between offsets in that sequence and points on the page.
 *
 * Words in a line join with a single space and lines join with a newline, so every inter-word gap and line break owns exactly one offset,
 * letting a selection carry a trailing space or line break into the clipboard.
 *
 * Geometry is stored in each line's *group-local* space, the unrotated page space its orientation group is drawn in,
 * so the same numbers place a selection rectangle and answer a hit test.
 */
export class PageTextIndex {
  /**
   * @param {OcrPage} page
   * @param {number} angle - Page skew angle in degrees, from `pageMetrics`.
   * @param {dims} dims - Unrotated page dimensions.
   * @param {DocFonts} docFonts - Consulted only when a word lacks usable per-character boxes.
   */
  constructor(page, angle, dims, docFonts) {
    this.n = page.n;
    /** Identity check for the cache: a page edit or reorder swaps this object out. */
    this.page = page;
    this.docFonts = docFonts;
    /** The whole page as one string: selection offsets index into it. */
    this.text = '';
    /** @type {Array<LineEntry>} */
    this.lines = [];
    /** @type {Map<number, Array<number>>} Line indices per orientation, each in its own local space. */
    this.byOrientation = new Map();

    const imageRotated = Math.abs(angle ?? 0) > 0.05;

    /** @param {{left: number, top: number, right: number, bottom: number}} b */
    const finiteBox = (b) => !!b && Number.isFinite(b.left) && Number.isFinite(b.right)
      && Number.isFinite(b.top) && Number.isFinite(b.bottom);
    /** @param {{x: number, y: number}} adj */
    const finiteAdj = (adj) => ((Number.isFinite(adj.x) && Number.isFinite(adj.y)) ? adj : NO_ADJ);

    for (const line of page.lines) {
      // A word with no finite box (OCR junk carrying null coordinates) cannot host a caret, so it is excluded from the index the way empty-text words are.
      const words = line.words.filter((w) => w.text && finiteBox(w.bbox));
      if (words.length === 0) continue;

      // De-skew adjustments derive from the line/word geometry, so junk boxes elsewhere on the line can make them NaN.
      // An unplaceable adjustment falls back to none rather than poisoning every box.
      const adjL = imageRotated ? finiteAdj(scribe.utils.ocr.calcLineStartAngleAdj(line)) : NO_ADJ;
      if (this.text) this.text += '\n';
      const start = this.text.length;

      const boxes = [];
      const wordStart = [];
      const dx = [];
      const lbox = {
        left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity,
      };
      for (const word of words) {
        const adjW = imageRotated ? finiteAdj(scribe.utils.ocr.calcWordAngleAdj(word)) : NO_ADJ;
        const shiftX = adjL.x + adjW.x;
        const shiftY = adjL.y + adjW.y;
        // Normalized, never trusted from the source: TeX-generated PDFs carry boxes with top/bottom (and occasionally left/right) swapped, which would invert the band arithmetic downstream.
        const left = Math.min(word.bbox.left, word.bbox.right);
        const right = Math.max(word.bbox.left, word.bbox.right);
        const top = Math.min(word.bbox.top, word.bbox.bottom);
        const bottom = Math.max(word.bbox.top, word.bbox.bottom);
        boxes.push({
          left: left + shiftX, right: right + shiftX, top: top + shiftY, bottom: bottom + shiftY,
        });
        lbox.left = Math.min(lbox.left, left + shiftX);
        lbox.right = Math.max(lbox.right, right + shiftX);
        lbox.top = Math.min(lbox.top, top + shiftY);
        lbox.bottom = Math.max(lbox.bottom, bottom + shiftY);
        dx.push(shiftX);
        if (this.text.length > start) this.text += ' ';
        wordStart.push(this.text.length);
        this.text += word.text;
      }

      const li = this.lines.length;
      this.lines.push({
        line,
        words,
        boxes,
        wordStart,
        dx,
        start,
        end: this.text.length,
        orientation: line.orientation,
        adjL,
        lbox,
        band: {
          left: 0, right: 0, top: 0, bottom: 0,
        },
        rectTop: 0,
        rectBottom: 0,
        edges: words.map(() => null),
      });
      const bucket = this.byOrientation.get(line.orientation);
      if (bucket) bucket.push(li); else this.byOrientation.set(line.orientation, [li]);
    }

    for (const [orientation, indices] of this.byOrientation) {
      const localW = orientation % 2 === 1 ? dims.height : dims.width;
      const localH = orientation % 2 === 1 ? dims.width : dims.height;
      this._computeBands(indices, localW, localH);
    }
  }

  get length() { return this.text.length; }

  /**
   * Partition the page among one orientation's lines into bands that tile it with no dead zones, so a caret placed anywhere resolves to exactly one line.
   * @param {Array<number>} indices
   * @param {number} localW
   * @param {number} localH
   */
  _computeBands(indices, localW, localH) {
    // Left/right edges come first, from each line's column extent rather than its own box, so a drag past a short last line's final word still lands on it, not in a hole.
    // Adjacent columns meet at the midpoint of their extents, so neither overhangs.
    // The vertical pass then runs against those narrowed side spans, so an isolated line is bounded by the columns its span reaches over, not a page-wide slab.
    // Text can run past the page box, so the partition covers the union of the page and its content.
    // A band edge clamped to the page would leave the overflow strip owned by no line.
    let extLeft = 0;
    let extTop = 0;
    let extRight = localW;
    let extBottom = localH;
    for (const i of indices) {
      const b = this.lines[i].lbox;
      extLeft = Math.min(extLeft, b.left);
      extTop = Math.min(extTop, b.top);
      extRight = Math.max(extRight, b.right);
      extBottom = Math.max(extBottom, b.bottom);
    }

    /** @type {Map<number, {left: number, right: number}>} */
    const colExtents = new Map();
    for (const i of indices) {
      const lb = this.lines[i].lbox;
      // A short line x-overlaps its paragraph's full-width lines, so unioning the x-overlapping lines recovers the column width.
      // The vertical window stops a distant two-column title from welding both columns into one extent.
      const dilate = (lb.bottom - lb.top) * 3;

      /** @type {Array<{left: number, right: number, top: number, bottom: number}>} Boxes of every line in the window, sorted by left. */
      const win = [];
      for (const j of indices) {
        const mb = this.lines[j].lbox;
        if (mb.top >= lb.bottom + dilate || mb.bottom <= lb.top - dilate) continue;
        win.push(mb);
      }
      win.sort((a, b) => a.left - b.left);

      /**
       * Whether box `jb` overlaps two x-disjoint window lines, e.g. a footer or heading spanning a multi-column region.
       * Such a line belongs to no column, so unioning it would weld both columns into one extent and shadow the later column.
       * @param {{left: number, right: number}} jb
       * @returns {boolean}
       */
      const bridges = (jb) => {
        let minRight = Infinity;
        for (const mb of win) {
          if (mb === jb || mb.left >= jb.right || mb.right <= jb.left) continue;
          if (mb.left >= minRight) return true;
          minRight = Math.min(minRight, mb.right);
        }
        return false;
      };

      const ext = { left: lb.left, right: lb.right };
      for (const mb of win) {
        if (mb.left < lb.right && mb.right > lb.left && !bridges(mb)) {
          ext.left = Math.min(ext.left, mb.left);
          ext.right = Math.max(ext.right, mb.right);
        }
      }
      colExtents.set(i, ext);
    }

    for (const i of indices) {
      const lb = this.lines[i].lbox;
      const col = /** @type {{left: number, right: number}} */ (colExtents.get(i));
      const dilate = (lb.bottom - lb.top) * 3;
      const band = {
        left: extLeft, right: extRight, top: extTop, bottom: extBottom,
      };
      for (const j of indices) {
        if (j === i) continue;
        const mb = this.lines[j].lbox;
        const mc = /** @type {{left: number, right: number}} */ (colExtents.get(j));
        if (mb.top < lb.bottom + dilate && mb.bottom > lb.top - dilate) {
          if (mc.left >= col.right) band.right = Math.min(band.right, (col.right + mc.left) / 2);
          if (mc.right <= col.left) band.left = Math.max(band.left, (mc.right + col.left) / 2);
        }
      }
      this.lines[i].band = band;
    }

    /** The line directly above / below each line, i.e. the one whose midpoint set that band edge. */
    const above = new Map();
    const below = new Map();
    for (const i of indices) {
      const entry = this.lines[i];
      const lb = entry.lbox;
      const { band } = entry;
      for (const j of indices) {
        if (j === i) continue;
        const mb = this.lines[j].lbox;
        if (mb.left < band.right && mb.right > band.left) {
          if (mb.top >= lb.bottom && (lb.bottom + mb.top) / 2 < band.bottom) {
            band.bottom = (lb.bottom + mb.top) / 2;
            below.set(i, j);
          }
          if (mb.bottom <= lb.top && (mb.bottom + lb.top) / 2 > band.top) {
            band.top = (mb.bottom + lb.top) / 2;
            above.set(i, j);
          }
        }
      }
    }

    /**
     * How much whitespace a rectangle may paint beyond its glyphs before the gap counts as structure (a paragraph break) rather than leading.
     * Averaged over the pair so both sides of a shared band edge agree: they either both take the edge (tiling) or both pull back symmetrically.
     * @param {number} i
     * @param {?number} j
     * @returns {number}
     */
    const allowance = (i, j) => {
      const h = (e) => (e.line.ascHeight > 0 ? e.line.ascHeight * 1.36 : (e.lbox.bottom - e.lbox.top));
      const own = h(this.lines[i]);
      return 0.75 * (j === undefined ? own : (own + h(this.lines[j])) / 2);
    };

    for (const i of indices) {
      const entry = this.lines[i];
      const lb = entry.lbox;
      const { band } = entry;

      const belowJ = below.get(i);
      const gapBelow = belowJ === undefined ? Infinity : this.lines[belowJ].lbox.top - lb.bottom;
      const budgetBelow = allowance(i, belowJ);
      const aboveJ = above.get(i);
      const gapAbove = aboveJ === undefined ? Infinity : lb.top - this.lines[aboveJ].lbox.bottom;
      const budgetAbove = allowance(i, aboveJ);

      const top = gapAbove <= budgetAbove ? band.top : Math.max(band.top, lb.top - budgetAbove / 2);
      const bottom = gapBelow <= budgetBelow ? band.bottom : Math.min(band.bottom, lb.bottom + budgetBelow / 2);
      entry.rectTop = top;
      entry.rectBottom = bottom;
      if (entry.rectBottom <= entry.rectTop) {
        entry.rectTop = band.top;
        entry.rectBottom = band.bottom;
      }
    }
  }

  /**
   * The x of every character boundary of word `wi` on line `li`: `edges[k]` is the left edge of character `k`, and `edges[len]` the word's right edge.
   *
   * Per-character boxes from the PDF or OCR source are exact and are used whenever they line up with the word's text.
   * Otherwise the font's advance widths are scaled to span the word box, which keeps the caret near the glyph it points at even when the source gave only a word box.
   * Either way the result is forced non-decreasing and pinned to the box, so a caret search cannot walk off it.
   * @param {number} li
   * @param {number} wi
   * @returns {Float64Array}
   */
  edges(li, wi) {
    const entry = this.lines[li];
    const cached = entry.edges[wi];
    if (cached) return cached;

    const word = entry.words[wi];
    const box = entry.boxes[wi];
    const len = word.text.length;
    const shiftX = entry.dx[wi];
    const out = new Float64Array(len + 1);

    const { chars } = word;
    if (chars && chars.length === len) {
      for (let i = 0; i < len; i++) out[i] = chars[i].bbox.left + shiftX;
      out[len] = chars[len - 1].bbox.right + shiftX;
    } else {
      /** @type {?Array<number>} */
      let advances = null;
      try {
        const metrics = scribe.utils.calcWordMetrics(word, this.docFonts);
        if (metrics.advanceArr.length === len) {
          advances = metrics.advanceArr.map((a, i) => a + (metrics.kerningArr[i] || 0) + metrics.charSpacing);
        }
      } catch {
        advances = null;
      }
      if (advances) {
        let cum = 0;
        for (let i = 0; i < len; i++) { out[i] = cum; cum += advances[i]; }
        out[len] = cum;
        const scale = cum > 0 ? (box.right - box.left) / cum : 0;
        for (let i = 0; i <= len; i++) out[i] = box.left + out[i] * scale;
      } else {
        for (let i = 0; i <= len; i++) out[i] = box.left + (box.right - box.left) * (i / len);
      }
    }

    out[0] = box.left;
    out[len] = box.right;
    for (let i = 1; i < len; i++) {
      if (out[i] < out[i - 1]) out[i] = out[i - 1];
      if (out[i] > box.right) out[i] = box.right;
    }
    entry.edges[wi] = out;
    return out;
  }

  /**
   * The word index on line `li` owning offset `off`.
   * @param {number} li
   * @param {number} off
   * @returns {number}
   */
  wordForOffset(li, off) {
    const { wordStart } = this.lines[li];
    let wi = wordStart.length - 1;
    while (wi > 0 && wordStart[wi] > off) wi--;
    return wi;
  }

  /**
   * The x of character offset `off`, which must lie on line `li`.
   * @param {number} li
   * @param {number} off
   * @returns {number}
   */
  xForOffset(li, off) {
    const entry = this.lines[li];
    if (off <= entry.start) return entry.boxes[0].left;
    if (off >= entry.end) return entry.boxes[entry.boxes.length - 1].right;
    const wi = this.wordForOffset(li, off);
    return this.edges(li, wi)[off - entry.wordStart[wi]];
  }

  /**
   * The caret offset nearest x on line `li`.
   * Inside a word this snaps to a character boundary.
   * In the gap between two words it snaps to whichever word edge is closer, which is what decides whether the gap's space lands inside the selection.
   * @param {number} li
   * @param {number} x
   * @returns {number}
   */
  offsetForX(li, x) {
    const entry = this.lines[li];
    const { boxes } = entry;
    if (x <= boxes[0].left) return entry.start;
    if (x >= boxes[boxes.length - 1].right) return entry.end;

    for (let wi = 0; wi < boxes.length; wi++) {
      const box = boxes[wi];
      if (x < box.left) {
        const prev = boxes[wi - 1];
        const prevEnd = entry.wordStart[wi - 1] + entry.words[wi - 1].text.length;
        return (x - prev.right) < (box.left - x) ? prevEnd : entry.wordStart[wi];
      }
      if (x <= box.right) {
        const e = this.edges(li, wi);
        let best = 0;
        let bestDist = Infinity;
        for (let k = 0; k < e.length; k++) {
          const d = Math.abs(x - e[k]);
          if (d < bestDist) { bestDist = d; best = k; }
        }
        return entry.wordStart[wi] + best;
      }
    }
    return entry.end;
  }

  /**
   * The line of the given orientation owning a local-space point, and the point's distance from that line's glyphs.
   * The distance lets a caller choose between orientations on a mixed page.
   * @param {number} orientation
   * @param {number} x
   * @param {number} y
   * @returns {?{li: number, dist: number}}
   */
  lineAt(orientation, x, y) {
    const indices = this.byOrientation.get(orientation);
    if (!indices || indices.length === 0) return null;
    // Bands can still overlap (a layout the extent pass misreads), so among containing bands the line with the nearest glyphs wins, not the one earliest in reading order.
    // Reading order would let an earlier line's band permanently shadow a later line's own glyphs.
    // Line boxes tie at zero when a skewed scan's staircasing makes each tall enough to swallow its neighbours, so the nearest word box breaks the tie.
    // When the word boxes coincide too (duplicated OCR text), the nearest line midline breaks it.
    let hit = -1;
    let hitDist = Infinity;
    let hitWord = Infinity;
    let hitMid = Infinity;
    for (const i of indices) {
      const b = this.lines[i].band;
      if (x < b.left || x > b.right || y < b.top || y > b.bottom) continue;
      const ib = this.lines[i].lbox;
      const ix = Math.max(ib.left - x, 0, x - ib.right);
      const iy = Math.max(ib.top - y, 0, y - ib.bottom);
      const d = ix * ix + iy * iy;
      if (d > hitDist) continue;
      let w = d;
      if (d === 0) {
        w = Infinity;
        for (const wb of this.lines[i].boxes) {
          const wx = Math.max(wb.left - x, 0, x - wb.right);
          const wy = Math.max(wb.top - y, 0, y - wb.bottom);
          w = Math.min(w, wx * wx + wy * wy);
          if (w === 0) break;
        }
      }
      const m = Math.abs(y - (ib.top + ib.bottom) / 2);
      if (d < hitDist || w < hitWord || (w === hitWord && m < hitMid)) {
        hitDist = d; hitWord = w; hitMid = m; hit = i;
      }
    }
    // The bands tile the page, so a miss means the point is off the paper (a drag past the page edge).
    // Equally-near bands (two stacked lines sharing an edge the point is straight below) tie on band distance, where the nearer glyphs decide, not index order.
    if (hit < 0) {
      let bestDist = Infinity;
      let bestGlyph = Infinity;
      for (const i of indices) {
        const b = this.lines[i].band;
        const bx = Math.max(b.left - x, 0, x - b.right);
        const by = Math.max(b.top - y, 0, y - b.bottom);
        const d = bx * bx + by * by;
        if (d > bestDist) continue;
        const ib = this.lines[i].lbox;
        const ix = Math.max(ib.left - x, 0, x - ib.right);
        const iy = Math.max(ib.top - y, 0, y - ib.bottom);
        const g = ix * ix + iy * iy;
        if (d < bestDist || g < bestGlyph) { bestDist = d; bestGlyph = g; hit = i; }
      }
    }
    // Construction keeps all geometry finite, so this cannot fire.
    // If data ever defeats that, an unresolvable point must degrade to "no caret", never to a crash mid-gesture.
    if (hit < 0) return null;
    const lb = this.lines[hit].lbox;
    const gx = Math.max(lb.left - x, 0, x - lb.right);
    const gy = Math.max(lb.top - y, 0, y - lb.bottom);
    return { li: hit, dist: Math.hypot(gx, gy) };
  }

  /**
   * The line index containing `off`.
   * @param {number} off
   * @returns {number}
   */
  lineForOffset(off) {
    let lo = 0;
    let hi = this.lines.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lines[mid].start <= off) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /**
   * Grow `off` out to the bounds of the word or line it falls in, so a double- or triple-click drag keeps whole words (or whole lines) selected as it moves.
   * @param {number} off
   * @param {number} granularity - `CHAR`, `WORD`, or `LINE`.
   * @returns {{start: number, end: number}}
   */
  expand(off, granularity) {
    if (granularity === CHAR) return { start: off, end: off };
    const li = this.lineForOffset(off);
    const entry = this.lines[li];
    if (granularity === WORD) {
      const wi = this.wordForOffset(li, off);
      return { start: entry.wordStart[wi], end: entry.wordStart[wi] + entry.words[wi].text.length };
    }
    return { start: entry.start, end: entry.end };
  }

  /**
   * One rectangle per line the interval `[a, b)` crosses, each in its line's local space.
   * @param {number} a
   * @param {number} b
   * @returns {Array<SelRect>}
   */
  rects(a, b) {
    /** @type {Array<SelRect>} */
    const out = [];
    for (let li = 0; li < this.lines.length; li++) {
      const entry = this.lines[li];
      if (b <= entry.start || a > entry.end) continue;
      const left = this.xForOffset(li, Math.max(a, entry.start));
      // Past the last character sits the line's newline.
      // Selecting it paints a short tail.
      const right = b > entry.end
        ? entry.boxes[entry.boxes.length - 1].right + (entry.rectBottom - entry.rectTop) * NEWLINE_TAIL
        : this.xForOffset(li, b);
      if (right <= left) continue;
      out.push({
        orientation: entry.orientation, left, right, top: entry.rectTop, bottom: entry.rectBottom,
      });
    }
    return out;
  }

  /**
   * Ids of the words the interval `[a, b)` touches.
   * A word counts when the interval covers at least one of its characters, so a partial selection still highlights the whole word.
   * @param {number} a
   * @param {number} b
   * @returns {Array<string>}
   */
  wordIds(a, b) {
    const ids = [];
    for (const entry of this.lines) {
      if (b <= entry.start || a >= entry.end) continue;
      for (let wi = 0; wi < entry.words.length; wi++) {
        const ws = entry.wordStart[wi];
        const we = ws + entry.words[wi].text.length;
        if (a < we && b > ws) ids.push(entry.words[wi].id);
      }
    }
    return ids;
  }

  /**
   * Rectangles and text for a columnar selection over `box`: one rectangle per line, spanning only the words the box touches.
   * Lines join with newlines, so a table column copies as a column rather than as the interleaved reading-order text a linear selection would give.
   * @param {number} orientation
   * @param {{left: number, top: number, right: number, bottom: number}} box
   * @returns {{rects: Array<SelRect>, text: string, ids: Array<string>}}
   */
  boxSelection(orientation, box) {
    /** @type {Array<SelRect>} */
    const rects = [];
    const rows = [];
    const ids = [];
    for (const li of this.byOrientation.get(orientation) || []) {
      const entry = this.lines[li];
      let left = Infinity;
      let right = -Infinity;
      const texts = [];
      for (let wi = 0; wi < entry.words.length; wi++) {
        const wb = entry.boxes[wi];
        if (!(wb.left < box.right && wb.right > box.left && wb.top < box.bottom && wb.bottom > box.top)) continue;
        left = Math.min(left, wb.left);
        right = Math.max(right, wb.right);
        texts.push(entry.words[wi].text);
        ids.push(entry.words[wi].id);
      }
      if (texts.length === 0) continue;
      rects.push({
        orientation, left, right, top: entry.rectTop, bottom: entry.rectBottom,
      });
      rows.push({ top: entry.rectTop, text: texts.join(' ') });
    }
    rows.sort((p, q) => p.top - q.top);
    return { rects, text: rows.map((r) => r.text).join('\n'), ids };
  }
}

/**
 * Owns the viewer's text selection: the interval, the pointer and keyboard gestures that move it, the rectangles that draw it, and the text and words it yields.
 */
export class TextSelection {
  /** @param {import('../viewer.js').ScribeViewer} viewer */
  constructor(viewer) {
    /** Engine discriminator consumed by the viewer's engine seam (`viewer._sel()`). */
    this.kind = 'custom';
    this.viewer = viewer;

    /** @type {Array<?PageTextIndex>} Per-page, built on demand, dropped when the page's text changes. */
    this._index = [];

    /**
     * A linear selection is an interval of reading order.
     * A box selection is a rectangle of one page.
     * @type {?({kind: 'linear', start: SelPoint, end: SelPoint} | {kind: 'box', n: number, orientation: number, box: {left: number, top: number, right: number, bottom: number}})}
     */
    this.range = null;

    /** @type {?{anchor: SelPoint, granularity: number, pointerId: number, box: ?{n: number, orientation: number, x: number, y: number}, editWord?: ?import('./viewerWordObjects.js').UiOcrWord}} */
    this._drag = null;

    /** Last pointerdown, for the multi-click counter. */
    this._lastDown = {
      t: -1e9, x: 0, y: 0, count: 0,
    };
    /** Client coords of the drag pointer, kept live so the autoscroll tick can re-resolve the caret. */
    this._dragClient = { x: 0, y: 0 };
    /** @type {?number} */
    this._autoScrollRaf = null;

    /** @type {Array<Object<string, Array<HTMLDivElement>>>} Pooled selection rectangles, per page then orientation. */
    this._rectPool = [];

    /** A CSS cursor overriding the hover-derived one, set by the highlighter tool. @type {?string} */
    this.cursorOverride = null;

    /** @type {?{wordId: string, rects: Array<HTMLDivElement>}} */
    this._hlLift = null;
    /** @type {?number} */
    this._hoverRaf = null;

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onHoverMove = this._onHoverMove.bind(this);
    this._onDragMove = this._onDragMove.bind(this);
    this._onDragEnd = this._onDragEnd.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onCopy = this._onCopy.bind(this);
    this._autoScrollTick = this._autoScrollTick.bind(this);
  }

  install() {
    ensureSelectionStyleSheet();
    const sc = this.viewer.scrollContainer;
    sc.addEventListener('pointerdown', this._onPointerDown);
    sc.addEventListener('pointermove', this._onHoverMove);
    sc.addEventListener('keydown', this._onKeyDown);
    document.addEventListener('copy', this._onCopy);
    // Reachable by keyboard, so Ctrl+C / Ctrl+A / Escape have somewhere to land.
    if (!sc.hasAttribute('tabindex')) sc.tabIndex = 0;
    sc.style.outline = 'none';
  }

  destroy() {
    const sc = this.viewer.scrollContainer;
    if (sc) {
      sc.removeEventListener('pointerdown', this._onPointerDown);
      sc.removeEventListener('pointermove', this._onHoverMove);
      sc.removeEventListener('keydown', this._onKeyDown);
    }
    document.removeEventListener('copy', this._onCopy);
    this._endDrag();
    this._index.length = 0;
    this._rectPool.length = 0;
    this.range = null;
  }

  /**
   * Page `n`'s text index, built on first use.
   * Building is arithmetic over the OCR model (no fonts, no layout, no DOM), so any page can be indexed on demand, including one the viewer never rendered.
   * @param {number} n
   * @returns {?PageTextIndex}
   */
  index(n) {
    const page = this.viewer.doc.ocr.active?.[n];
    const cached = this._index[n];
    if (cached && cached.page === page) return cached;
    const metrics = this.viewer.doc.pageMetrics?.[n];
    if (!page || !metrics || !metrics.dims) return null;
    const built = new PageTextIndex(page, metrics.angle || 0, metrics.dims, this.viewer.doc.fonts);
    if (built.lines.length === 0) return null;
    this._index[n] = built;
    return built;
  }

  /**
   * Drop page `n`'s cached text index so the next `index(n)` rebuilds it.
   * @param {number} n
   */
  invalidatePage(n) { this._index[n] = null; }

  invalidateAll() {
    this._index.length = 0;
    this._rectPool.length = 0;
    this.range = null;
  }

  isEmpty() {
    if (!this.range) return true;
    if (this.range.kind === 'box') return this.range.box.right <= this.range.box.left;
    return cmpPoint(this.range.start, this.range.end) >= 0;
  }

  clear() {
    if (!this.range) return;
    this.range = null;
    this._renderAll();
    if (this.viewer.onSelectionChange) this.viewer.onSelectionChange();
  }

  /** Pages the selection touches, endpoints and everything between. @returns {Set<number>} */
  pages() {
    const out = new Set();
    if (!this.range) return out;
    if (this.range.kind === 'box') out.add(this.range.n);
    else for (let n = this.range.start.n; n <= this.range.end.n; n++) out.add(n);
    return out;
  }

  /** Select every page of the document, in reading order. */
  selectAll() {
    const pageCount = this.viewer.doc.ocr.active.length;
    let first = 0;
    while (first < pageCount && !this.index(first)) first++;
    let last = pageCount - 1;
    while (last >= first && !this.index(last)) last--;
    if (last < first) return;
    this.range = {
      kind: 'linear',
      start: { n: first, off: 0 },
      end: { n: last, off: /** @type {PageTextIndex} */ (this.index(last)).length },
    };
    this._renderAll();
    if (this.viewer.onSelectionChange) this.viewer.onSelectionChange();
  }

  /**
   * The selected text.
   * Within a page it is a plain substring of the page text, so word spacing and line breaks come from the model.
   * Pages join with a blank line.
   * Only newlines are stripped from a page's ends, since a selection may start or stop on a line break.
   * @returns {string}
   */
  getText() {
    if (!this.range) return '';
    if (this.range.kind === 'box') {
      const idx = this.index(this.range.n);
      return idx ? idx.boxSelection(this.range.orientation, this.range.box).text : '';
    }
    const { start, end } = this.range;
    const parts = [];
    for (let n = start.n; n <= end.n; n++) {
      const idx = this.index(n);
      if (!idx) continue;
      const a = n === start.n ? start.off : 0;
      const b = n === end.n ? end.off : idx.length;
      const text = idx.text.slice(a, b).replace(/^\n+/, '').replace(/\n+$/, '');
      if (text) parts.push(text);
    }
    return parts.join('\n\n');
  }

  /**
   * The viewer's word objects under the selection, for highlighting and the context menu.
   * @returns {Array<import('./viewerWordObjects.js').UiOcrWord>}
   */
  getWords() {
    if (!this.range) return [];
    /** @type {Array<import('./viewerWordObjects.js').UiOcrWord>} */
    const out = [];
    /** @param {number} n @param {Array<string>} ids */
    const collect = (n, ids) => {
      if (ids.length === 0) return;
      const byId = this.viewer.ensureWordObjs(n);
      for (const id of ids) {
        const kw = byId.get(id);
        if (kw) out.push(kw);
      }
    };
    if (this.range.kind === 'box') {
      const idx = this.index(this.range.n);
      if (idx) collect(this.range.n, idx.boxSelection(this.range.orientation, this.range.box).ids);
      return out;
    }
    const { start, end } = this.range;
    for (let n = start.n; n <= end.n; n++) {
      const idx = this.index(n);
      if (!idx) continue;
      const a = n === start.n ? start.off : 0;
      const b = n === end.n ? end.off : idx.length;
      collect(n, idx.wordIds(a, b));
    }
    return out;
  }

  // Hit testing

  /**
   * The caret nearest a client point, or null when the page has no text.
   * @param {number} clientX
   * @param {number} clientY
   * @returns {?SelPoint}
   */
  pointAt(clientX, clientY) {
    const { n, x, y } = this.viewer.clientToPage(clientX, clientY);
    const idx = this.index(n);
    if (!idx) return null;
    /** @type {?{li: number, dist: number, localX: number}} */
    let best = null;
    for (const orientation of idx.byOrientation.keys()) {
      const local = this.viewer.pageToLocal(n, orientation, x, y);
      const hit = idx.lineAt(orientation, local.x, local.y);
      if (!hit) continue;
      if (!best || hit.dist < best.dist) best = { li: hit.li, dist: hit.dist, localX: local.x };
    }
    if (!best) return null;
    return { n, off: idx.offsetForX(best.li, best.localX) };
  }

  /**
   * The highlighted word under a client point, if any.
   * @param {number} clientX
   * @param {number} clientY
   * @returns {?{kw: import('./viewerWordObjects.js').UiOcrWord, groupId: ?string, n: number}}
   */
  hitTestHighlight(clientX, clientY) {
    const { n, x, y } = this.viewer.clientToPage(clientX, clientY);
    const idx = this.index(n);
    const words = this.viewer._wordObjs[n];
    if (!idx || !words || words.length === 0) return null;
    for (const [orientation, indices] of idx.byOrientation) {
      const local = this.viewer.pageToLocal(n, orientation, x, y);
      for (const li of indices) {
        const entry = idx.lines[li];
        if (local.y < entry.rectTop || local.y > entry.rectBottom) continue;
        for (let wi = 0; wi < entry.boxes.length; wi++) {
          const box = entry.boxes[wi];
          if (local.x < box.left || local.x > box.right) continue;
          const kw = this.viewer.ensureWordObjs(n).get(entry.words[wi].id);
          if (kw && kw.highlightColor) return { kw, groupId: kw.highlightGroupId || null, n };
          return null;
        }
      }
    }
    return null;
  }

  /**
   * The word under a client point, if the point is inside its box.
   * This is the editing entry's hit test.
   * Unlike `hitTestHighlight` it returns any word, highlighted or not.
   * @param {number} clientX
   * @param {number} clientY
   * @returns {?import('./viewerWordObjects.js').UiOcrWord}
   */
  wordAt(clientX, clientY) {
    const { n, x, y } = this.viewer.clientToPage(clientX, clientY);
    const idx = this.index(n);
    if (!idx) return null;
    for (const [orientation, indices] of idx.byOrientation) {
      const local = this.viewer.pageToLocal(n, orientation, x, y);
      for (const li of indices) {
        const entry = idx.lines[li];
        if (local.y < entry.rectTop || local.y > entry.rectBottom) continue;
        for (let wi = 0; wi < entry.boxes.length; wi++) {
          const box = entry.boxes[wi];
          if (local.x < box.left || local.x > box.right) continue;
          return this.viewer.ensureWordObjs(n).get(entry.words[wi].id) ?? null;
        }
      }
    }
    return null;
  }

  /**
   * Whether a client point lands inside some line's band, i.e. over selectable text.
   * @param {number} clientX
   * @param {number} clientY
   * @returns {boolean}
   */
  isOverText(clientX, clientY) {
    const { n, x, y } = this.viewer.clientToPage(clientX, clientY);
    const idx = this.index(n);
    if (!idx) return false;
    for (const [orientation, indices] of idx.byOrientation) {
      const local = this.viewer.pageToLocal(n, orientation, x, y);
      for (const li of indices) {
        const b = idx.lines[li].band;
        if (local.x >= b.left && local.x <= b.right && local.y >= b.top && local.y <= b.bottom) return true;
      }
    }
    return false;
  }

  // Gestures

  /** @param {PointerEvent} event */
  _onPointerDown(event) {
    // Non-primary buttons belong to the pan and the context menu.
    if (event.button !== 0) return;
    if (this.viewer.state.layoutMode || this.viewer.enableCanvasSelection) return;
    // Comment marks, note marks, the comment card and editable fields own their own pointer gestures.
    if (event.target instanceof Element
      && event.target.closest('.scribe-hl-cmark, .scribe-note-icon, .scribe-cmt-card, [contenteditable]')) return;

    // A touch that moves is a pan, so a touch selection has to wait to see whether it holds still.
    if (event.pointerType === 'touch') { this._armTouchHold(event); return; }

    const near = Math.abs(event.clientX - this._lastDown.x) < MULTI_CLICK_PX
      && Math.abs(event.clientY - this._lastDown.y) < MULTI_CLICK_PX;
    // `PointerEvent.detail` carries the click count only in Chrome, so the counter is kept here.
    this._lastDown.count = (near && event.timeStamp - this._lastDown.t < MULTI_CLICK_MS) ? this._lastDown.count + 1 : 1;
    this._lastDown.t = event.timeStamp;
    this._lastDown.x = event.clientX;
    this._lastDown.y = event.clientY;
    const granularity = Math.min(this._lastDown.count, LINE);

    const { n, x, y } = this.viewer.clientToPage(event.clientX, event.clientY);
    const idx = this.index(n);
    if (!idx) { this.clear(); return; }

    if (event.altKey) {
      // Alt+drag selects a rectangle of the page rather than a run of reading order: the right gesture for a table column, and one a linear DOM selection cannot express at all.
      const orientation = idx.lines[0].orientation;
      const local = this.viewer.pageToLocal(n, orientation, x, y);
      this._drag = {
        anchor: { n, off: 0 },
        granularity: CHAR,
        pointerId: event.pointerId,
        box: {
          n, orientation, x: local.x, y: local.y,
        },
      };
      this.range = {
        kind: 'box',
        n,
        orientation,
        box: {
          left: local.x, top: local.y, right: local.x, bottom: local.y,
        },
      };
      this._renderAll();
    } else {
      const point = this.pointAt(event.clientX, event.clientY);
      if (!point) { this.clear(); return; }
      // A double-click captures the word to arm in-place editing, which `_onDragEnd` opens.
      const editWord = (UiText.enableEditing && this._lastDown.count === 2 && !event.altKey)
        ? this.wordAt(event.clientX, event.clientY) : null;
      // Shift-click extends from the far end of the existing selection rather than restarting it.
      let anchor = point;
      if (event.shiftKey && this.range && this.range.kind === 'linear') {
        anchor = cmpPoint(point, this.range.start) < 0 ? this.range.end : this.range.start;
      }
      this._drag = {
        anchor, granularity, pointerId: event.pointerId, box: null, editWord,
      };
      this._setLinear(anchor, point, granularity);
    }

    this._dragClient = { x: event.clientX, y: event.clientY };
    // Window-level, not pointer capture: capture would retarget the compatibility mouse events that the comment card and the middle-button pan still rely on.
    window.addEventListener('pointermove', this._onDragMove);
    window.addEventListener('pointerup', this._onDragEnd);
    window.addEventListener('pointercancel', this._onDragEnd);
    this.viewer.scrollContainer.focus({ preventScroll: true });
  }

  /**
   * Start the press-and-hold that turns a stationary touch into a word selection.
   * Moving first cancels it, leaving the touch to the viewer's own pan.
   * Holding still selects the word and hands the rest of the gesture to `_onDragMove`, which extends the selection a word at a time.
   * @param {PointerEvent} event
   */
  _armTouchHold(event) {
    const start = { x: event.clientX, y: event.clientY, id: event.pointerId };
    const cancel = () => {
      clearTimeout(timer);
      window.removeEventListener('pointermove', watch);
      window.removeEventListener('pointerup', cancel);
      window.removeEventListener('pointercancel', cancel);
    };
    /** @param {PointerEvent} move */
    const watch = (move) => {
      if (move.pointerId !== start.id) return;
      if (Math.hypot(move.clientX - start.x, move.clientY - start.y) > TOUCH_HOLD_PX) cancel();
    };
    const timer = setTimeout(() => {
      cancel();
      const point = this.pointAt(start.x, start.y);
      if (!point) return;
      this._drag = {
        anchor: point, granularity: WORD, pointerId: start.id, box: null,
      };
      this._dragClient = { x: start.x, y: start.y };
      this._setLinear(point, point, WORD);
      // The viewer pans on touchmove, but the flag above makes it stand down for the rest of this gesture.
      window.addEventListener('pointermove', this._onDragMove);
      window.addEventListener('pointerup', this._onDragEnd);
      window.addEventListener('pointercancel', this._onDragEnd);
    }, TOUCH_HOLD_MS);
    window.addEventListener('pointermove', watch);
    window.addEventListener('pointerup', cancel);
    window.addEventListener('pointercancel', cancel);
  }

  /** @param {PointerEvent} event */
  _onDragMove(event) {
    if (!this._drag || event.pointerId !== this._drag.pointerId) return;
    this._dragClient = { x: event.clientX, y: event.clientY };
    this._extendToClient(event.clientX, event.clientY);
    if (this._autoScrollRaf === null) this._autoScrollRaf = requestAnimationFrame(this._autoScrollTick);
  }

  /** @param {PointerEvent} event */
  _onDragEnd(event) {
    if (!this._drag || event.pointerId !== this._drag.pointerId) return;
    const editWord = this._drag.editWord;
    this._endDrag();
    // A double-click's edit opens from the RELEASE, the moment a native `dblclick` fires and users are calibrated to.
    // The pointer drifts a few px between the second press and its release, and at word zoom that drift is a character of caret placement,
    // so the caret must be computed from that release, not the press.
    // The edit opens only when the press and release land on the same word, mirroring `dblclick`'s same-target rule.
    // A release on another word keeps the word-drag selection instead.
    if (editWord && event.type === 'pointerup') {
      const kwUp = this.wordAt(event.clientX, event.clientY);
      if (kwUp && kwUp.word === editWord.word) {
        UiText._lastPointerClient = { x: event.clientX, y: event.clientY };
        this.clear();
        UiText.addTextInput(kwUp);
      }
    }
    if (this.viewer.onSelectionChange) this.viewer.onSelectionChange();
  }

  /**
   * Whether a pointer gesture is currently moving the selection.
   * @returns {boolean}
   */
  isDragging() { return !!this._drag; }

  _endDrag() {
    this._drag = null;
    if (this._autoScrollRaf !== null) cancelAnimationFrame(this._autoScrollRaf);
    this._autoScrollRaf = null;
    window.removeEventListener('pointermove', this._onDragMove);
    window.removeEventListener('pointerup', this._onDragEnd);
    window.removeEventListener('pointercancel', this._onDragEnd);
  }

  /**
   * Move the focus end of the drag to a client point.
   * The autoscroll tick calls this with an unchanged pointer position each frame: the content has moved under it, so the caret advances.
   * @param {number} clientX
   * @param {number} clientY
   */
  _extendToClient(clientX, clientY) {
    const drag = this._drag;
    if (!drag) return;
    if (drag.box) {
      const page = this.viewer.clientToPage(clientX, clientY);
      const local = this.viewer.pageToLocal(drag.box.n, drag.box.orientation, page.x, page.y);
      this.range = {
        kind: 'box',
        n: drag.box.n,
        orientation: drag.box.orientation,
        box: {
          left: Math.min(drag.box.x, local.x),
          right: Math.max(drag.box.x, local.x),
          top: Math.min(drag.box.y, local.y),
          bottom: Math.max(drag.box.y, local.y),
        },
      };
      this._renderAll();
      if (this.viewer.onSelectionChange) this.viewer.onSelectionChange();
      return;
    }
    const point = this.pointAt(clientX, clientY);
    if (point) this._setLinear(drag.anchor, point, drag.granularity);
  }

  /**
   * Order the anchor and focus carets, widen each to the gesture's granularity, and redraw.
   * @param {SelPoint} anchor
   * @param {SelPoint} focus
   * @param {number} granularity
   */
  _setLinear(anchor, focus, granularity) {
    const anchorIdx = this.index(anchor.n);
    const focusIdx = this.index(focus.n);
    if (!anchorIdx || !focusIdx) return;
    const anchorRange = anchorIdx.expand(anchor.off, granularity);
    const focusRange = focusIdx.expand(focus.off, granularity);
    this.range = cmpPoint(anchor, focus) <= 0
      ? { kind: 'linear', start: { n: anchor.n, off: anchorRange.start }, end: { n: focus.n, off: focusRange.end } }
      : { kind: 'linear', start: { n: focus.n, off: focusRange.start }, end: { n: anchor.n, off: anchorRange.end } };
    this._renderAll();
    if (this.viewer.onSelectionChange) this.viewer.onSelectionChange();
  }

  /**
   * Scroll while the drag pointer sits near or past a viewport edge, then re-resolve the caret at the unchanged pointer position.
   */
  _autoScrollTick() {
    this._autoScrollRaf = null;
    if (!this._drag) return;
    const sc = this.viewer.scrollContainer;
    const rect = sc.getBoundingClientRect();
    /**
     * Convert a signed overshoot into a scroll delta that ramps linearly and caps at AUTOSCROLL_MAX.
     * @param {number} over Signed overshoot past the inner edge of the autoscroll zone.
     * @returns {number} Signed scroll delta.
     */
    const speed = (over) => Math.sign(over) * Math.min(AUTOSCROLL_MAX, (Math.abs(over) / AUTOSCROLL_ZONE) * AUTOSCROLL_MAX);
    const overY = Math.max(0, this._dragClient.y - (rect.bottom - AUTOSCROLL_ZONE))
      || Math.min(0, this._dragClient.y - (rect.top + AUTOSCROLL_ZONE));
    const overX = Math.max(0, this._dragClient.x - (rect.right - AUTOSCROLL_ZONE))
      || Math.min(0, this._dragClient.x - (rect.left + AUTOSCROLL_ZONE));
    if (overX || overY) {
      sc.scrollTop += speed(overY);
      sc.scrollLeft += speed(overX);
      this._extendToClient(this._dragClient.x, this._dragClient.y);
    }
    this._autoScrollRaf = requestAnimationFrame(this._autoScrollTick);
  }

  /**
   * Cursor feedback and highlight hover, derived from geometry rather than from a pointer target.
   * @param {PointerEvent} event
   */
  _onHoverMove(event) {
    if (this._drag || this._hoverRaf !== null) return;
    const { clientX, clientY } = event;
    this._hoverRaf = requestAnimationFrame(() => {
      this._hoverRaf = null;
      const hit = this.hitTestHighlight(clientX, clientY);
      const wordId = hit ? hit.kw.word.id : null;
      if ((this._hlLift?.wordId ?? null) !== wordId) {
        if (this._hlLift) for (const rect of this._hlLift.rects) rect.classList.remove('scribe-hl-hover');
        this._hlLift = null;
        if (hit) {
          /** @type {Array<HTMLDivElement>} */
          const rects = [];
          if (hit.groupId) {
            // A group can span pages (a selection highlighted across a page break), so gather every page's bands.
            for (const map of this.viewer._highlightRectsByGroup) {
              const arr = map && map.get(hit.groupId);
              if (arr) rects.push(...arr);
            }
          } else if (hit.kw.highlightRectElem) {
            rects.push(hit.kw.highlightRectElem);
          }
          for (const rect of rects) rect.classList.add('scribe-hl-hover');
          this._hlLift = { wordId: /** @type {string} */ (wordId), rects };
        }
        if (this.viewer.onHighlightHover) this.viewer.onHighlightHover(hit ? hit.groupId : null);
      }

      let cursor = '';
      if (this.cursorOverride) cursor = this.cursorOverride;
      else if (hit) cursor = 'pointer';
      else if (this.isOverText(clientX, clientY)) cursor = 'text';
      if (this.viewer.scrollContainer.style.cursor !== cursor) this.viewer.scrollContainer.style.cursor = cursor;
    });
  }

  // Keyboard and clipboard

  /** @param {KeyboardEvent} event */
  _onKeyDown(event) {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && (event.key === 'c' || event.key === 'C')) {
      if (this.isEmpty()) return;
      const text = this.getText();
      if (!text) return;
      // Suppressing the key's default also suppresses the `copy` event it would raise, so `_onCopy` does not write the clipboard a second time.
      event.preventDefault();
      navigator.clipboard?.writeText(text);
    } else if (mod && (event.key === 'a' || event.key === 'A')) {
      event.preventDefault();
      this.selectAll();
    } else if (event.key === 'Escape' && !this.isEmpty()) {
      event.preventDefault();
      this.clear();
    }
  }

  /**
   * Serve a copy the browser initiated itself (its Edit menu, or a synthesized `ClipboardEvent`) from the custom selection.
   * Keyboard copy is handled in `_onKeyDown` and never reaches here.
   * @param {ClipboardEvent} event
   */
  _onCopy(event) {
    if (this.isEmpty() || !event.clipboardData || event.defaultPrevented) return;
    // The listener is on `document`, so with several viewers on the page only the one whose UI holds focus answers.
    // `outerElem` includes the owning app's chrome, so a click on its toolbar does not orphan the selection's copy.
    const active = document.activeElement;
    const owner = this.viewer.outerElem || this.viewer.elem;
    if (active && active !== document.body && !owner?.contains(active)) return;
    const text = this.getText();
    if (!text) return;
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
  }

  // Rendering

  /**
   * Redraw the selection on every page that has a container.
   * Pages built later call `renderPage` themselves.
   */
  _renderAll() {
    for (let n = 0; n < this.viewer.pageContainerArr.length; n++) {
      if (this.viewer.pageContainerArr[n]) this.renderPage(n);
    }
  }

  /**
   * Draw page `n`'s selection rectangles, reusing pooled `<div>`s.
   *
   * A screenful of selected text is a few dozen rectangles, so the layer is rewritten in full on every drag frame at no measurable cost.
   * @param {number} n
   */
  renderPage(n) {
    const pool = this._rectPool[n] || (this._rectPool[n] = {});
    /** @type {Object<string, Array<SelRect>>} */
    const wanted = {};

    if (!this.isEmpty()) {
      const idx = this.index(n);
      const range = /** @type {NonNullable<typeof this.range>} */ (this.range);
      if (idx) {
        /** @type {Array<SelRect>} */
        let rects = [];
        if (range.kind === 'box') {
          if (range.n === n) rects = idx.boxSelection(range.orientation, range.box).rects;
        } else if (n >= range.start.n && n <= range.end.n) {
          const a = n === range.start.n ? range.start.off : 0;
          const b = n === range.end.n ? range.end.off : idx.length;
          rects = idx.rects(a, b);
        }
        for (const rect of rects) (wanted[rect.orientation] || (wanted[rect.orientation] = [])).push(rect);
      }
    }

    for (const key of new Set([...Object.keys(pool), ...Object.keys(wanted)])) {
      const rects = wanted[key] || [];
      const divs = pool[key] || (pool[key] = []);
      if (rects.length === 0 && divs.length === 0) continue;
      const group = this.viewer.getSelectGroup(n, Number(key));
      if (!group) continue;
      while (divs.length < rects.length) {
        const div = document.createElement('div');
        div.className = 'scribe-sel-rect';
        group.appendChild(div);
        divs.push(div);
      }
      for (let i = 0; i < divs.length; i++) {
        const div = divs[i];
        if (i >= rects.length) { div.style.display = 'none'; continue; }
        const rect = rects[i];
        div.style.display = '';
        div.style.left = `${rect.left}px`;
        div.style.top = `${rect.top}px`;
        div.style.width = `${rect.right - rect.left}px`;
        div.style.height = `${rect.bottom - rect.top}px`;
      }
    }
  }

  /**
   * Forget page `n`'s pooled rectangles, whose elements went away with its layer.
   * @param {number} n
   */
  destroyPage(n) {
    this._rectPool[n] = {};
  }

  /**
   * Draw page `n`'s search-match rectangles.
   * Match state lives on the word objects (`viewerSearch` sets it), which have no span to paint a background onto.
   * @param {number} n
   */
  renderMarks(n) {
    const groups = this.viewer._selectGroups[n];
    if (groups) {
      for (const group of Object.values(groups)) {
        for (const el of [...group.querySelectorAll('.scribe-mark-rect')]) el.remove();
      }
    }
    const words = this.viewer._wordObjs[n];
    if (!words || words.length === 0) return;
    for (const kw of words) {
      if (!kw.activeMatch && !kw.fillBox) continue;
      // A span-backed word (visible display modes) paints its own match background, so a mark rect on top would double-tint it.
      if (kw.el) continue;
      const div = document.createElement('div');
      div.className = kw.activeMatch ? 'scribe-mark-rect scribe-mark-active' : 'scribe-mark-rect';
      Object.assign(div.style, {
        left: `${kw.x() - (kw.word.visualCoords ? kw.leftSideBearing : 0)}px`,
        top: `${kw.y() - kw.fontSize * 0.12}px`,
        width: `${kw.width()}px`,
        height: `${kw.fontSize * 0.84}px`,
      });
      this.viewer.getSelectGroup(n, kw.word.line.orientation).appendChild(div);
    }
  }
}
