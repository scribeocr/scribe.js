import { PAGE_KEY_SPAN, readAllPostings } from './searchSegment.js';
import { MARKER_TERM, tokenizeQuery } from './searchTokenizer.js';

const PREFIX_MAX_TERMS = 1024;
const PREFIX_MAX_BYTES = 64 << 20;
const WINDOW = 8;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const SLICE_MS = 8;

/**
 * The index of the first value in `values` whose position is at least `pos`.
 * @param {number[]} values - Ascending (position << 1 | span) values.
 * @param {number} pos
 */
const firstAtOrAfter = (values, pos) => {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((values[mid] >>> 1) < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/** A cursor over terms' postings merged in memory by page, with the segment cursor's interface. */
class ListCursor {
  /** @param {Map<number, number[]>} merged - Values by page key, unsorted where terms share a page. */
  constructor(merged) {
    /** @type {Array<{key: number, values: number[]}>} */
    this.entries = [...merged.entries()].sort((a, b) => a[0] - b[0]).map(([key, values]) => ({ key, values: values.length > 1 ? values.sort((a, b) => a - b) : values }));
    this.count = this.entries.length;
    this.i = -1;
    this.key = -1;
    /** @type {number[]} */
    this.values = [];
  }

  next() {
    if (this.i + 1 >= this.entries.length) return false;
    this.i++;
    this.key = this.entries[this.i].key;
    this.values = this.entries[this.i].values;
    return true;
  }

  /** @param {number} target */
  advance(target) {
    if (this.key >= target) return true;
    let lo = this.i + 1;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.entries[mid].key < target) lo = mid + 1;
      else hi = mid;
    }
    if (lo >= this.entries.length) {
      this.i = this.entries.length;
      return false;
    }
    this.i = lo;
    this.key = this.entries[lo].key;
    this.values = this.entries[lo].values;
    return true;
  }
}

/**
 * @param {ReturnType<typeof import('./searchSegment.js').openSegment>} reader
 * @param {import('./searchSegment.js').TermEntry[]} entries
 * @param {Map<number, number[]>} merged
 */
const mergePostings = (reader, entries, merged) => {
  for (const e of entries) {
    for (const pe of readAllPostings(reader, e)) {
      const have = merged.get(pe.key);
      if (have) merged.set(pe.key, have.concat(pe.values));
      else merged.set(pe.key, pe.values);
    }
  }
};

/**
 * One hit page.
 * @typedef {Object} Hit
 * @property {string} hash
 * @property {number} page
 * @property {number} ingestSeq
 * @property {number} tier - 1 the exact phrase, 2 the phrase with a longer word in place of its last, 3 the words in order within the window, 4 any order within it, 5 anywhere on the page.
 * @property {number} count - Occurrences on the page, or the matched terms' count in tier 5.
 * @property {number} span
 * @property {number} score
 * @property {Array<[number, number]>} marks - The occurrences to highlight, as (position << 1 | span) values of their first and last token, at most `marksPerPage`.
 */

/**
 * The order of hit pages, best first.
 * Pages tied on every key fall to their document's ingest order, then their page number, neither of which a segment cut changes.
 * @param {Hit} a
 * @param {Hit} b
 * @param {boolean} rankSpan
 * @returns {number}
 */
export const compareHits = (a, b, rankSpan) => a.tier - b.tier
  || (a.tier === 5 ? b.score - a.score : b.count - a.count || (rankSpan ? a.span - b.span : 0))
  || a.ingestSeq - b.ingestSeq || a.page - b.page;

/**
 * What the sweep planned by cost did, counted over a query's segments.
 * @typedef {Object} SweepPlan
 * @property {number} segments
 * @property {number} advanced
 * @property {number} sought
 * @property {number} rangeMerged
 */

/**
 * @typedef {Object} LiveSegment
 * @property {ReturnType<typeof import('./searchSegment.js').openSegment>} reader
 * @property {Set<number>} dead
 * @property {(ordinal: number, page: number) => number} pageLength
 * @property {(ordinal: number) => number} ingestSeq - A segment holds its documents in ingest order, so its postings run in it.
 */

/**
 * Evaluate a query over the live segments.
 * @param {LiveSegment[]} segments
 * @param {string} query
 * @param {Object} options
 * @param {number} options.bound - The exact mode keeps the first this many exact hit pages in ingest order.
 *   The fallback mode keeps this many pages, the best.
 * @param {number} [options.doc] - Sweep this document alone, by its ordinal in the one segment given.
 * @param {number} [options.marksPerPage]
 * @param {boolean} options.prefixLastWord
 * @param {boolean} [options.lower] - Run the fallback mode, which ranks the pages without the exact phrase in tiers 2 to 5.
 * @param {boolean} options.rankSpan
 * @param {import('./searchTokenizer.js').TokenizerRules} options.tokenizer - The rules the index was built under.
 * @param {{pages: number, avgLength: number}} options.collection - Live pages and their mean length in positions, for BM25.
 * @param {boolean} [options.sweepByCost] - Plan each segment's sweep by cost.
 *   The hits, their counts and their marks are the same either way.
 * @param {number} [options.seekCostBytes]
 * @param {{cancelled: boolean, pause?: () => Promise<void>}} [job] - The fallback mode's run.
 *   Once a slice of work is spent the evaluation awaits `pause`, then stops if `cancelled` was set meanwhile.
 * @returns {Promise<{terms: string[], hits: Hit[], matches: number, bounded: boolean, candidates: number,
 *   skips: number, found: number, exactPages: number, cancelled: boolean, partial: boolean, plan: ?SweepPlan}>} In the fallback mode `found` counts every page of a lower tier.
 *   `partial` is set in the fallback mode when a segment was left out because its range of the last word was cut short.
 *   `skips` counts the occurrences found by stepping over a marker.
 */
export const evaluate = async (segments, query, options, job) => {
  const terms = tokenizeQuery(query, options.tokenizer);
  /** @type {Hit[]} */
  const hits = [];
  let matches = 0;
  let candidates = 0;
  let skips = 0;
  let found = 0;
  let exactPages = 0;
  let cancelled = false;
  let partial = false;
  const { bound, rankSpan } = options;
  const lowerMode = !!options.lower;
  const marksPerPage = options.marksPerPage ?? 20;
  /** @type {?SweepPlan} */
  const plan = options.sweepByCost ? {
    segments: 0, advanced: 0, sought: 0, rangeMerged: 0,
  } : null;
  const answer = () => ({
    terms, hits, matches, bounded: lowerMode ? found > bound : hits.length >= bound, candidates, skips, found, exactPages, cancelled, partial, plan,
  });
  if (!terms.length) return answer();
  const n = terms.length;
  // Only the fallback mode reads the last word as a prefix, since a page holding a longer word in its place is a near match.
  // Someone who types a lone one- or two-letter word means exactly that word.
  const prefixAt = lowerMode && options.prefixLastWord && !(n === 1 && terms[0].length < 3) ? n - 1 : -1;
  const prefix = prefixAt >= 0 ? terms[prefixAt] : '';
  // Every page holding a lone word read as itself is an exact page.
  if (lowerMode && n === 1 && prefixAt < 0) return answer();
  const stepMarkers = options.tokenizer.markersUnpositioned === 'both';
  let sliceStart = performance.now();
  const paused = async () => {
    if (job && job.pause) await job.pause();
    sliceStart = performance.now();
    return !!(job && job.cancelled);
  };
  // BM25's document frequencies over every live segment, so a page's score compares with any other page's.
  /** @type {Map<LiveSegment, {entries: Array<?import('./searchSegment.js').TermEntry>, range: ?ReturnType<LiveSegment['reader']['prefix']>}>} */
  const looked = new Map();
  const df = new Array(n).fill(0);
  if (lowerMode) {
    for (const seg of segments) {
      const entries = terms.map((t, i) => (i === prefixAt ? null : seg.reader.lookup(t)));
      const range = prefixAt >= 0 ? seg.reader.prefix(prefix, PREFIX_MAX_TERMS, PREFIX_MAX_BYTES) : null;
      looked.set(seg, { entries, range });
      for (let j = 0; j < n; j++) {
        if (j === prefixAt) for (const e of /** @type {NonNullable<typeof range>} */ (range).terms) df[j] += e.df;
        else df[j] += entries[j] ? /** @type {import('./searchSegment.js').TermEntry} */ (entries[j]).df : 0;
      }
    }
    for (let j = 0; j < n; j++) df[j] = Math.max(1, Math.min(df[j], options.collection.pages));
  }

  /**
   * @param {LiveSegment} seg
   * @returns {AsyncGenerator<Hit, void, void>}
   */
  async function* sweep(seg) {
    const { reader } = seg;
    const pre = looked.get(seg);
    const entries = pre ? pre.entries : terms.map((t, i) => (i === prefixAt ? null : reader.lookup(t)));
    if (entries.some((e, i) => i !== prefixAt && !e)) return;
    const range = pre ? pre.range : (prefixAt >= 0 ? reader.prefix(prefix, PREFIX_MAX_TERMS, PREFIX_MAX_BYTES) : null);
    /** @type {?ListCursor} */
    let prefixList = null;
    /** @type {?import('./searchSegment.js').PostingsCursor} */
    let lastWordItself = null;
    const others = entries.filter(Boolean);
    const minDf = others.length ? Math.min(...others.map((e) => /** @type {import('./searchSegment.js').TermEntry} */ (e).df)) : Infinity;
    if (range) {
      // The near matches need every position of the prefix on a page, so a range cut short would misplace them.
      if (range.truncated) {
        partial = true;
        return;
      }
      if (!range.terms.length) return;
      /** @type {Map<number, number[]>} */
      const merged = new Map();
      for (const e of range.terms) {
        if (job && performance.now() - sliceStart >= SLICE_MS && await paused()) {
          cancelled = true;
          return;
        }
        mergePostings(reader, [e], merged);
      }
      prefixList = new ListCursor(merged);
      if (plan) plan.rangeMerged++;
      const itself = reader.lookup(prefix);
      lastWordItself = itself ? reader.postings(itself) : null;
    }
    const cursors = entries.map((e) => (e ? reader.postings(e) : /** @type {ListCursor} */ (prefixList)));
    let anchor = -1;
    let anchorDf = Infinity;
    for (let i = 0; i < n; i++) {
      if (cursors[i].count < anchorDf) {
        anchorDf = cursors[i].count;
        anchor = i;
      }
    }
    const anchorCursor = cursors[anchor];
    const order = [];
    for (let i = 0; i < n; i++) if (i !== anchor) order.push(i);
    const seekBy = new Array(n).fill(false);
    if (plan) {
      const pages = entries.map((e) => (e ? e.df : Infinity));
      order.sort((a, b) => pages[a] - pages[b] || a - b);
      plan.segments++;
      for (const i of order) {
        const e = entries[i];
        if (!e) continue;
        seekBy[i] = e.len > minDf * /** @type {number} */ (options.seekCostBytes);
        if (seekBy[i]) plan.sought++;
        else plan.advanced++;
      }
    }

    let pageKey = -1;
    /** @type {number[][]} */
    let values = [];
    /** @type {?number[]} */
    let pageMarkers = null;
    // Undefined until a walk first needs the segment's marker postings, null when the segment has none.
    /** @type {?import('./searchSegment.js').PostingsCursor|undefined} */
    let markerCursor;
    let markerSeek = false;
    /**
     * @returns {number[]}
     */
    const markersOfPage = () => {
      if (markerCursor === undefined) {
        const entry = reader.lookup(MARKER_TERM);
        markerCursor = entry ? reader.postings(entry) : null;
        markerSeek = !!(plan && entry && entry.len > minDf * /** @type {number} */ (options.seekCostBytes));
      }
      if (pageMarkers === null) pageMarkers = markerCursor && markerCursor.advance(pageKey, markerSeek) && markerCursor.key === pageKey ? markerCursor.values : [];
      return pageMarkers;
    };
    /**
     * Complete `chain` right of term j - 1's token `cur`.
     * @param {number[]} chain @param {number} j @param {number} cur
     * @returns {boolean}
     */
    const walkRight = (chain, j, cur) => {
      if (j === n) return true;
      const from = (cur >>> 1) + 1 + (cur & 1);
      const markers = /** @type {number[]} */ (pageMarkers);
      let to = from;
      for (let at = firstAtOrAfter(markers, from); at < markers.length && (markers[at] >>> 1) === to; at++) to++;
      const vs = values[j];
      // Each position from right after `cur` to past the markers is tried, so a typed marker and a stepped-over one are both found.
      for (let x = from; x <= to; x++) {
        for (let at = firstAtOrAfter(vs, x); at < vs.length && (vs[at] >>> 1) === x; at++) {
          chain[j] = vs[at];
          if (walkRight(chain, j + 1, vs[at])) return true;
        }
      }
      return false;
    };
    /**
     * Complete `chain` left of term j + 1's token `cur`.
     * @param {number[]} chain @param {number} j @param {number} cur
     * @returns {boolean}
     */
    const walkLeft = (chain, j, cur) => {
      if (j < 0) return true;
      const markers = /** @type {number[]} */ (pageMarkers);
      let to = (cur >>> 1) - 1;
      for (let at = firstAtOrAfter(markers, to); at >= 0 && at < markers.length && (markers[at] >>> 1) === to; at--) to--;
      const vs = /** @type {number[]} */ (values[j]);
      for (let y = (cur >>> 1) - 1; y >= to && y >= 0; y--) {
        let at = firstAtOrAfter(vs, y);
        if (at < vs.length && vs[at] === y << 1) {
          chain[j] = vs[at];
          if (walkLeft(chain, j - 1, vs[at])) return true;
        }
        for (at = firstAtOrAfter(vs, y - 1); y >= 1 && at < vs.length && (vs[at] >>> 1) === y - 1; at++) {
          if (!(vs[at] & 1)) continue;
          chain[j] = vs[at];
          if (walkLeft(chain, j - 1, vs[at])) return true;
        }
      }
      return false;
    };
    /**
     * The phrase's occurrences on the page.
     * @param {boolean} firstOnly
     * @returns {{count: number, marks: Array<[number, number]>}}
     */
    const occurrences = (firstOnly) => {
      /** @type {Array<[number, number]>} */
      const marks = [];
      let count = 0;
      // Two chains can start for one occurrence when a prefix's range holds a joined hyphenation and its first half at one position.
      let lastFirst = -1;
      for (const av of values[anchor]) {
        const chain = new Array(n);
        chain[anchor] = av;
        let cur = av;
        let ok = true;
        for (let j = anchor + 1; j < n && ok; j++) {
          const expect = (cur >>> 1) + 1 + (cur & 1);
          const vs = values[j];
          const at = firstAtOrAfter(vs, expect);
          if (at < vs.length && (vs[at] >>> 1) === expect) {
            cur = vs[at];
            chain[j] = cur;
          } else ok = false;
        }
        cur = av;
        for (let j = anchor - 1; j >= 0 && ok; j--) {
          const p = cur >>> 1;
          const vs = /** @type {number[]} */ (values[j]);
          const plain = ((p - 1) << 1);
          const joined = ((p - 2) << 1) | 1;
          let at = firstAtOrAfter(vs, p - 1);
          if (at < vs.length && vs[at] === plain) cur = plain;
          else {
            at = firstAtOrAfter(vs, p - 2);
            if (p >= 2 && at < vs.length && vs[at] === joined) cur = joined;
            else ok = false;
          }
          if (ok) chain[j] = cur;
        }
        let stepped = false;
        if (!ok && stepMarkers && markersOfPage().length) {
          chain[anchor] = av;
          ok = walkRight(chain, anchor + 1, av) && walkLeft(chain, anchor - 1, av);
          stepped = ok;
        }
        if (!ok || (chain[0] >>> 1) === lastFirst) continue;
        lastFirst = chain[0] >>> 1;
        if (stepped) skips++;
        count++;
        if (firstOnly) break;
        if (marks.length < marksPerPage) marks.push([chain[0], chain[n - 1]]);
      }
      return { count, marks };
    };

    while (anchorCursor.next()) {
      if (job && performance.now() - sliceStart >= SLICE_MS && await paused()) {
        cancelled = true;
        return;
      }
      const { key } = anchorCursor;
      const ordinal = Math.floor(key / PAGE_KEY_SPAN);
      if (options.doc !== undefined) {
        if (ordinal < options.doc) continue;
        if (ordinal > options.doc) break;
      }
      if (seg.dead.has(ordinal)) continue;
      let present = true;
      for (let k = 0; k < order.length && present; k++) {
        const c = cursors[order[k]];
        if (!c.advance(key, seekBy[order[k]]) || c.key !== key) present = false;
      }
      if (!present) continue;
      candidates++;
      const page = key % PAGE_KEY_SPAN;
      const { hash } = reader.docs[ordinal];
      pageKey = key;
      values = cursors.map((c) => c.values);
      pageMarkers = null;
      if (!lowerMode) {
        const { count, marks } = occurrences(false);
        if (count) {
          yield {
            hash, page, ingestSeq: seg.ingestSeq(ordinal), tier: 1, count, span: n, score: 0, marks,
          };
        }
        continue;
      }
      // A page holding the phrase with the last word itself is an exact page, which the exact answer lists.
      let exact = false;
      if (prefixAt < 0) exact = occurrences(true).count > 0;
      else if (lastWordItself && lastWordItself.advance(key) && lastWordItself.key === key) {
        const rangeValues = values[prefixAt];
        values[prefixAt] = lastWordItself.values;
        exact = occurrences(true).count > 0;
        values[prefixAt] = rangeValues;
      }
      if (exact) {
        exactPages++;
        continue;
      }
      if (prefixAt >= 0) {
        const longer = occurrences(false);
        if (longer.count) {
          yield {
            hash, page, ingestSeq: seg.ingestSeq(ordinal), tier: 2, count: longer.count, span: n, score: 0, marks: longer.marks,
          };
          continue;
        }
      }
      // A window's length leaves out the markers it passes, as the exact walk steps over them.
      const markers = stepMarkers ? markersOfPage() : [];
      const pos = values.map((vs) => /** @type {number[]} */ (vs).map((v) => v >>> 1));
      const wordAt = markers.length ? new Set(pos.flat()) : null;
      /**
       * @param {number} a @param {number} b
       */
      const passed = (a, b) => {
        let s = 0;
        if (wordAt) for (let k = firstAtOrAfter(markers, a + 1); k < markers.length && (markers[k] >>> 1) < b; k++) if (!wordAt.has(markers[k] >>> 1)) s++;
        return s;
      };
      let tier = 0;
      let span = 0;
      /** @type {Array<[number, number]>} */
      const marks = [];
      let count = 0;
      for (let i = 0; i < pos[0].length; i++) {
        const p0 = pos[0][i];
        if (i > 0 && pos[0][i - 1] === p0) continue;
        let last = p0;
        let ok = true;
        for (let j = 1; j < n && ok; j++) {
          const at = firstAtOrAfter(/** @type {number[]} */ (values[j]), last + 1);
          if (at < pos[j].length) {
            last = pos[j][at];
          } else {
            ok = false;
          }
        }
        const width = ok ? last - p0 + 1 - passed(p0, last) : Infinity;
        if (width <= WINDOW) {
          count++;
          if (!span || width < span) span = width;
          if (marks.length < marksPerPage) marks.push([p0 << 1, last << 1]);
        }
      }
      if (count) tier = 3;
      else {
        const all = [];
        for (let j = 0; j < n; j++) for (const p of pos[j]) all.push([p, j]);
        all.sort((a, b) => a[0] - b[0]);
        const have = new Array(n).fill(0);
        let distinct = 0;
        let lo = 0;
        let lastStart = -1;
        for (let hi = 0; hi < all.length; hi++) {
          if (have[all[hi][1]]++ === 0) distinct++;
          while (distinct === n) {
            const w = all[hi][0] - all[lo][0] + 1 - passed(all[lo][0], all[hi][0]);
            if (w <= WINDOW && all[lo][0] !== lastStart) {
              lastStart = all[lo][0];
              count++;
              if (!span || w < span) span = w;
              if (marks.length < marksPerPage) marks.push([all[lo][0] << 1, all[hi][0] << 1]);
            }
            if (--have[all[lo][1]] === 0) distinct--;
            lo++;
          }
        }
        if (count) tier = 4;
        else {
          tier = 5;
          span = seg.pageLength(ordinal, page);
          count = n;
          for (let j = 0; j < n; j++) if (marks.length < marksPerPage && pos[j].length) marks.push([pos[j][0] << 1, pos[j][0] << 1]);
        }
      }
      let score = 0;
      if (tier === 5) {
        const dl = seg.pageLength(ordinal, page);
        const { pages, avgLength } = options.collection;
        for (let j = 0; j < n; j++) {
          const tf = pos[j].length;
          const idf = Math.log(1 + (pages - df[j] + 0.5) / (df[j] + 0.5));
          score += idf * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * dl / avgLength));
        }
      }
      yield {
        hash, page, ingestSeq: seg.ingestSeq(ordinal), tier, count, span, score, marks,
      };
    }
  }

  if (lowerMode) {
    for (const seg of segments) {
      for await (const hit of sweep(seg)) {
        found++;
        if (hits.length < bound || compareHits(hit, hits[hits.length - 1], rankSpan) < 0) {
          let at = hits.length;
          while (at > 0 && compareHits(hit, hits[at - 1], rankSpan) < 0) at--;
          hits.splice(at, 0, hit);
          if (hits.length > bound) hits.pop();
        }
      }
      if (cancelled) return answer();
    }
    for (const h of hits) matches += h.tier === 5 ? 1 : h.count;
    return answer();
  }
  // Every segment yields its hits in ingest order, so merging their heads keeps the first `bound` pages in that order, however the documents are cut into segments.
  /** @type {Array<{it: AsyncGenerator<Hit, void, void>, hit: Hit}>} */
  const heads = [];
  for (const seg of segments) {
    const it = sweep(seg);
    const first = await it.next();
    if (!first.done) heads.push({ it, hit: first.value });
  }
  while (heads.length) {
    let best = 0;
    for (let s = 1; s < heads.length; s++) {
      const a = heads[s].hit;
      const b = heads[best].hit;
      if (a.ingestSeq < b.ingestSeq || (a.ingestSeq === b.ingestSeq && a.page < b.page)) best = s;
    }
    const head = heads[best];
    hits.push(head.hit);
    matches += head.hit.count;
    if (hits.length >= bound) break;
    const next = await head.it.next();
    if (next.done) heads.splice(best, 1);
    else head.hit = next.value;
  }
  // The sweeps left unfinished at the bound end here, which settles their counters.
  for (const head of heads) await head.it.return(undefined);
  return answer();
};
