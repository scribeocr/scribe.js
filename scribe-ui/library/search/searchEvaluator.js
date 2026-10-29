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
 * @property {number} tier - 1 the query's units adjacent in order and 2 the same with a longer word in place of the last.
 *   3 the units in order within the window, 4 any order within it and 5 anywhere on the page.
 * @property {number} count - Occurrences on the page, or the units' count in tier 5.
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
 * @param {number} options.bound - The answer keeps the first this many hit pages in ingest order.
 *   The pages holding the last word as typed come before those holding a longer word in its place.
 *   The fallback mode keeps this many pages, the best.
 * @param {number} [options.doc] - Sweep this document alone, by its ordinal in the one segment given.
 * @param {number} [options.marksPerPage]
 * @param {boolean} options.prefixLastWord - Read the last word as a prefix too.
 *   The pages holding a longer word in its place follow the pages holding it as typed.
 * @param {boolean} [options.lower] - Run the fallback mode, which ranks the pages without the phrase, as typed or with a longer last word, in tiers 3 to 5.
 * @param {boolean} options.rankSpan
 * @param {import('./searchTokenizer.js').TokenizerRules} options.tokenizer - The rules the index was built under.
 * @param {{pages: number, avgLength: number}} options.collection - Live pages and their mean length in positions, for BM25.
 * @param {boolean} [options.sweepByCost] - Plan each segment's sweep by cost.
 *   The hits, their counts and their marks are the same either way.
 * @param {number} [options.seekCostBytes]
 * @param {{cancelled: boolean, pause?: () => Promise<void>}} [job] - The fallback mode's run.
 *   Once a slice of work is spent the evaluation awaits `pause`, then stops if `cancelled` was set meanwhile.
 * @returns {Promise<{terms: string[], units: import('./searchTokenizer.js').QueryUnit[], quoted: boolean, hits: Hit[], matches: number, bounded: boolean, candidates: number,
 *   skips: number, found: number, exactPages: number, cancelled: boolean, partial: boolean, plan: ?SweepPlan}>}
 *   In the fallback mode `found` counts every page of a lower tier and `exactPages` the pages the answer lists.
 *   `partial` is set when a segment was left out because its range of the last word was cut short.
 *   `skips` counts the occurrences found by stepping over a marker.
 */
export const evaluate = async (segments, query, options, job) => {
  const { terms, units, quoted } = tokenizeQuery(query, options.tokenizer);
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
    terms, units, quoted, hits, matches, bounded: lowerMode ? found > bound : hits.length >= bound, candidates, skips, found, exactPages, cancelled, partial, plan,
  });
  if (!terms.length) return answer();
  const n = terms.length;
  // Someone who types a lone one- or two-letter word means exactly that word.
  const lastUnit = units[units.length - 1];
  const prefixAt = options.prefixLastWord && !lastUnit.quoted && !(n === 1 && terms[0].length < 3) ? n - 1 : -1;
  const prefix = prefixAt >= 0 ? terms[prefixAt] : '';
  if (lowerMode && units.length < 2) return answer();
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
   * @param {boolean} longer - Read the last word as a prefix.
   *   Outside the fallback mode the sweep then yields the pages holding the phrase with a longer word in place of the last, and not as typed.
   * @returns {AsyncGenerator<Hit, void, void>}
   */
  async function* sweep(seg, longer) {
    const { reader } = seg;
    const rangeAt = longer ? prefixAt : -1;
    const pre = looked.get(seg);
    const entries = pre ? pre.entries : terms.map((t, i) => (i === rangeAt ? null : reader.lookup(t)));
    if (entries.some((e, i) => i !== rangeAt && !e)) return;
    const range = pre ? pre.range : (rangeAt >= 0 ? reader.prefix(prefix, PREFIX_MAX_TERMS, PREFIX_MAX_BYTES) : null);
    /** @type {?ListCursor} */
    let prefixList = null;
    /** @type {?import('./searchSegment.js').PostingsCursor} */
    let lastWordItself = null;
    const others = entries.filter(Boolean);
    const minDf = others.length ? Math.min(...others.map((e) => /** @type {import('./searchSegment.js').TermEntry} */ (e).df)) : Infinity;
    if (range) {
      // A sweep over a range cut short could miss a page or rank a near match too low.
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
     * @param {number[]} chain @param {number} j @param {number} cur @param {number} end
     * @returns {boolean}
     */
    const walkRight = (chain, j, cur, end) => {
      if (j === end) return true;
      const from = (cur >>> 1) + 1 + (cur & 1);
      const markers = /** @type {number[]} */ (pageMarkers);
      let to = from;
      for (let at = firstAtOrAfter(markers, from); at < markers.length && (markers[at] >>> 1) === to; at++) to++;
      const vs = values[j];
      // Each position from right after `cur` to past the markers is tried, so a typed marker and a stepped-over one are both found.
      for (let x = from; x <= to; x++) {
        for (let at = firstAtOrAfter(vs, x); at < vs.length && (vs[at] >>> 1) === x; at++) {
          chain[j] = vs[at];
          if (walkRight(chain, j + 1, vs[at], end)) return true;
        }
      }
      return false;
    };
    /**
     * @param {number[]} chain @param {number} j @param {number} cur @param {number} from
     * @returns {boolean}
     */
    const walkLeft = (chain, j, cur, from) => {
      if (j < from) return true;
      const markers = /** @type {number[]} */ (pageMarkers);
      let to = (cur >>> 1) - 1;
      for (let at = firstAtOrAfter(markers, to); at >= 0 && at < markers.length && (markers[at] >>> 1) === to; at--) to--;
      const vs = /** @type {number[]} */ (values[j]);
      for (let y = (cur >>> 1) - 1; y >= to && y >= 0; y--) {
        let at = firstAtOrAfter(vs, y);
        if (at < vs.length && vs[at] === y << 1) {
          chain[j] = vs[at];
          if (walkLeft(chain, j - 1, vs[at], from)) return true;
        }
        for (at = firstAtOrAfter(vs, y - 1); y >= 1 && at < vs.length && (vs[at] >>> 1) === y - 1; at++) {
          if (!(vs[at] & 1)) continue;
          chain[j] = vs[at];
          if (walkLeft(chain, j - 1, vs[at], from)) return true;
        }
      }
      return false;
    };
    /**
     * @param {boolean} firstOnly
     * @param {number} [from]
     * @param {number} [to]
     * @param {number} [limit]
     * @returns {{count: number, marks: Array<[number, number]>}}
     */
    const occurrences = (firstOnly, from = 0, to = n, limit = marksPerPage) => {
      /** @type {Array<[number, number]>} */
      const marks = [];
      let count = 0;
      let a = from;
      for (let j = from + 1; j < to; j++) if (values[j].length < values[a].length) a = j;
      // Two chains can start for one occurrence when a prefix's range holds a joined hyphenation and its first half at one position.
      let lastFirst = -1;
      for (const av of values[a]) {
        const chain = new Array(n);
        chain[a] = av;
        let cur = av;
        let ok = true;
        for (let j = a + 1; j < to && ok; j++) {
          const expect = (cur >>> 1) + 1 + (cur & 1);
          const vs = values[j];
          const at = firstAtOrAfter(vs, expect);
          if (at < vs.length && (vs[at] >>> 1) === expect) {
            cur = vs[at];
            chain[j] = cur;
          } else ok = false;
        }
        cur = av;
        for (let j = a - 1; j >= from && ok; j--) {
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
          chain[a] = av;
          ok = walkRight(chain, a + 1, av, to) && walkLeft(chain, a - 1, av, from);
          stepped = ok;
        }
        if (!ok || (chain[from] >>> 1) === lastFirst) continue;
        lastFirst = chain[from] >>> 1;
        if (stepped) skips++;
        count++;
        if (firstOnly) break;
        if (marks.length < limit) marks.push([chain[from], chain[to - 1]]);
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
      if (!lowerMode && !longer) {
        const { count, marks } = occurrences(false);
        if (count) {
          yield {
            hash, page, ingestSeq: seg.ingestSeq(ordinal), tier: 1, count, span: n, score: 0, marks,
          };
        }
        continue;
      }
      let exact = false;
      if (rangeAt < 0) exact = occurrences(true).count > 0;
      else if (lastWordItself && lastWordItself.advance(key) && lastWordItself.key === key) {
        const rangeValues = values[rangeAt];
        values[rangeAt] = lastWordItself.values;
        exact = occurrences(true).count > 0;
        values[rangeAt] = rangeValues;
      }
      if (exact) {
        if (lowerMode) exactPages++;
        continue;
      }
      if (rangeAt >= 0) {
        if (!lowerMode) {
          const { count, marks } = occurrences(false);
          if (count) {
            yield {
              hash, page, ingestSeq: seg.ingestSeq(ordinal), tier: 2, count, span: n, score: 0, marks,
            };
          }
          continue;
        }
        if (occurrences(true).count) {
          exactPages++;
          continue;
        }
      }
      /** @type {Array<Array<{s: number, e: number, a: number, b: number}>>} */
      const occ = [];
      let unitMissing = false;
      for (const u of units) {
        if (u.to - u.from === 1) {
          occ.push(values[u.from].map((v) => ({
            s: v >>> 1, e: (v >>> 1) + (v & 1), a: v, b: v,
          })));
          continue;
        }
        const spans = occurrences(false, u.from, u.to, Infinity).marks;
        if (!spans.length) {
          unitMissing = true;
          break;
        }
        occ.push(spans.map(([a, b]) => ({
          s: a >>> 1, e: (b >>> 1) + (b & 1), a, b,
        })).sort((x, y) => x.s - y.s));
      }
      if (unitMissing) continue;
      const m = units.length;
      // A quoted phrase's words beyond its first do not count against the window.
      const widthCap = WINDOW + (n - m);
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
      for (let i = 0; i < occ[0].length; i++) {
        const first = occ[0][i];
        if (i > 0 && occ[0][i - 1].s === first.s) continue;
        let last = first;
        let ok = true;
        for (let u = 1; u < m && ok; u++) {
          let k = 0;
          while (k < occ[u].length && occ[u][k].s <= last.e) k++;
          if (k < occ[u].length) last = occ[u][k];
          else ok = false;
        }
        const width = ok ? last.e - first.s + 1 - passed(first.s, last.e) : Infinity;
        if (width <= widthCap) {
          count++;
          if (!span || width < span) span = width;
          if (marks.length < marksPerPage) marks.push([first.a, last.b]);
        }
      }
      if (count) tier = 3;
      else {
        /** @type {Array<{s: number, e: number, a: number, b: number, u: number}>} */
        const all = [];
        occ.forEach((list, u) => { for (const o of list) all.push({ ...o, u }); });
        all.sort((x, y) => x.s - y.s);
        const have = new Array(m).fill(0);
        let distinct = 0;
        let lo = 0;
        let lastStart = -1;
        for (let hi = 0; hi < all.length; hi++) {
          if (have[all[hi].u]++ === 0) distinct++;
          while (distinct === m) {
            let endAt = lo;
            for (let k = lo + 1; k <= hi; k++) if (all[k].e > all[endAt].e) endAt = k;
            const w = all[endAt].e - all[lo].s + 1 - passed(all[lo].s, all[endAt].e);
            if (w <= widthCap && all[lo].s !== lastStart) {
              lastStart = all[lo].s;
              count++;
              if (!span || w < span) span = w;
              if (marks.length < marksPerPage) marks.push([all[lo].a, all[endAt].b]);
            }
            if (--have[all[lo].u] === 0) distinct--;
            lo++;
          }
        }
        if (count) tier = 4;
        else {
          tier = 5;
          span = seg.pageLength(ordinal, page);
          count = m;
          for (const list of occ) if (marks.length < marksPerPage) marks.push([list[0].a, list[0].b]);
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
      for await (const hit of sweep(seg, prefixAt >= 0)) {
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
  for (const longer of prefixAt >= 0 ? [false, true] : [false]) {
    if (hits.length >= bound) break;
    /** @type {Array<{it: AsyncGenerator<Hit, void, void>, hit: Hit}>} */
    const heads = [];
    for (const seg of segments) {
      const it = sweep(seg, longer);
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
  }
  return answer();
};
