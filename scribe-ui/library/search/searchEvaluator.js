import { PAGE_KEY_SPAN, readAllPostings } from './searchSegment.js';
import { MARKER_TERM, recordTokenTerm, tokenizeQuery } from './searchTokenizer.js';

const PREFIX_MAX_TERMS = 1024;
const PREFIX_MAX_BYTES = 64 << 20;
const VERIFY_COST_BYTES = 3000;
const MERGE_TERM_BYTES = 64;
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
 * A prefix's dictionary range read page by page, only at the pages asked for.
 * At a page it holds the sorted union of every range term's values there, which is what the whole range merged into one list holds.
 */
class RangeCursor {
  /**
   * @param {ReturnType<typeof import('./searchSegment.js').openSegment>} reader
   * @param {import('./searchSegment.js').TermEntry[]} terms
   * @param {number} seekCostBytes
   */
  constructor(reader, terms, seekCostBytes) {
    this.reader = reader;
    this.terms = terms;
    this.seekCostBytes = seekCostBytes;
    /** @type {?Array<{entry: import('./searchSegment.js').TermEntry, cursor: import('./searchSegment.js').PostingsCursor}>} */
    this.sought = null;
    /** @type {ListCursor[]} */
    this.merged = [];
    this.reads = 0;
    this.mergedTerms = 0;
    this.key = -1;
    /** @type {number[]} */
    this.values = [];
  }

  /** @param {number} target */
  advance(target) {
    if (this.key >= target) return true;
    if (!this.sought) this.sought = this.terms.map((entry) => ({ entry, cursor: this.reader.postings(entry) }));
    this.reads++;
    if ((this.reads & (this.reads - 1)) === 0) {
      const paid = this.reads * this.seekCostBytes;
      const due = this.sought.filter((s) => s.entry.len + MERGE_TERM_BYTES <= paid);
      if (due.length) {
        /** @type {Map<number, number[]>} */
        const merged = new Map();
        mergePostings(this.reader, due.map((s) => s.entry), merged);
        this.merged.push(new ListCursor(merged));
        this.sought = this.sought.filter((s) => s.entry.len + MERGE_TERM_BYTES > paid);
        this.mergedTerms += due.length;
      }
    }
    let key = Infinity;
    let live = 0;
    for (const m of this.merged) {
      if (!m.advance(target)) continue;
      if (m.key < key) key = m.key;
      this.merged[live++] = m;
    }
    this.merged.length = live;
    live = 0;
    for (const s of this.sought) {
      if (!s.cursor.advance(target, true)) continue;
      if (s.cursor.key < key) key = s.cursor.key;
      this.sought[live++] = s;
    }
    this.sought.length = live;
    if (key === Infinity) return false;
    /** @type {number[][]} */
    const parts = [];
    for (const m of this.merged) if (m.key === key) parts.push(m.values);
    for (const s of this.sought) if (s.cursor.key === key) parts.push(s.cursor.values);
    this.key = key;
    this.values = parts.length === 1 ? parts[0] : parts.flat().sort((a, b) => a - b);
    return true;
  }
}

/**
 * One hit page.
 * @typedef {Object} Hit
 * @property {string} hash
 * @property {number} page
 * @property {number} ingestSeq
 * @property {number} tier - 1 exact phrase, 2 words in order within the window, 3 any order within it, 4 anywhere on the page.
 * @property {number} count - Occurrences on the page (exact and window tiers), or the matched terms' count in tier 4.
 * @property {number} span
 * @property {number} score
 * @property {Array<[number, number]>} marks - The occurrences to highlight, as (position << 1 | span) values of their first and last token, at most 20.
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
  || (a.tier === 4 ? b.score - a.score : b.count - a.count || (rankSpan ? a.span - b.span : 0))
  || a.ingestSeq - b.ingestSeq || a.page - b.page;

/**
 * What the sweep planned by cost did, counted over a query's segments.
 * @typedef {Object} SweepPlan
 * @property {number} segments
 * @property {number} advanced
 * @property {number} sought
 * @property {number} rangeMerged
 * @property {number} rangeByPage
 * @property {number} rangeVerified
 * @property {number} rangeReads
 * @property {number} rangeTermsOpened
 * @property {number} rangeTermsMerged
 * @property {number} records
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
 * @param {boolean} options.prefixLastWord
 * @param {boolean} [options.lower] - The fallback mode: the window and page tiers of the pages without the exact phrase.
 * @param {boolean} options.rankSpan
 * @param {import('./searchTokenizer.js').TokenizerRules} options.tokenizer - The rules the index was built under.
 * @param {{pages: number, avgLength: number}} options.collection - Live pages and their mean length in positions, for BM25.
 * @param {boolean} [options.sweepByCost] - Plan each segment's sweep by cost.
 *   The hits, their counts and their marks are the same either way.
 * @param {number} [options.seekCostBytes]
 * @param {(hash: string, page: number) => Promise<?import('./searchPageRecords.js').PageRecord>} readRecord
 * @param {{cancelled: boolean, pause?: () => Promise<void>}} [job] - The fallback mode's run.
 *   Once a slice of work is spent the evaluation awaits `pause`, then stops if `cancelled` was set meanwhile.
 * @returns {Promise<{terms: string[], hits: Hit[], matches: number, bounded: boolean, candidates: number, verified: number,
 *   skips: number, found: number, exactPages: number, cancelled: boolean, plan: ?SweepPlan}>} In the fallback mode `found` counts every page of a lower tier.
 *   `skips` counts the occurrences found by stepping over a marker.
 */
export const evaluate = async (segments, query, options, readRecord, job) => {
  const terms = tokenizeQuery(query, options.tokenizer);
  /** @type {Hit[]} */
  const hits = [];
  let matches = 0;
  let candidates = 0;
  let verified = 0;
  let skips = 0;
  let found = 0;
  let exactPages = 0;
  let cancelled = false;
  const { bound, rankSpan } = options;
  const lowerMode = !!options.lower;
  /** @type {?SweepPlan} */
  const plan = options.sweepByCost ? {
    segments: 0, advanced: 0, sought: 0, rangeMerged: 0, rangeByPage: 0, rangeVerified: 0, rangeReads: 0, rangeTermsOpened: 0, rangeTermsMerged: 0, records: 0,
  } : null;
  const answer = () => ({
    terms, hits, matches, bounded: lowerMode ? found > bound : hits.length >= bound, candidates, verified, skips, found, exactPages, cancelled, plan,
  });
  if (!terms.length) return answer();
  const n = terms.length;
  const prefixAt = options.prefixLastWord ? n - 1 : -1;
  const prefix = prefixAt >= 0 ? terms[prefixAt] : '';
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
    /** @type {?RangeCursor} */
    let prefixByPage = null;
    const others = entries.filter(Boolean);
    const minDf = others.length ? Math.min(...others.map((e) => /** @type {import('./searchSegment.js').TermEntry} */ (e).df)) : Infinity;
    if (range) {
      if (!range.terms.length) return;
      // The fallback tiers need every position of the prefix on a page, so they always merge its range into one list.
      if (lowerMode && range.truncated) return;
      if (lowerMode || (!range.truncated && (others.length === 0 || range.bytes <= minDf * VERIFY_COST_BYTES))) {
        // With a range term on as many pages as the rarest other term or more, the merged range could not anchor the sweep.
        // As a page filter it would only drop candidates without the phrase, so reading the range by page loses nothing.
        if (plan && others.length && !lowerMode && Math.max(...range.terms.map((e) => e.df)) >= minDf) {
          prefixByPage = new RangeCursor(reader, range.terms, /** @type {number} */ (options.seekCostBytes));
          plan.rangeByPage++;
        } else {
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
        }
      } else {
        if (others.length === 0) return;
        if (plan) plan.rangeVerified++;
      }
    }
    const cursors = entries.map((e) => (e ? reader.postings(e) : prefixList));
    let anchor = -1;
    let anchorDf = Infinity;
    for (let i = 0; i < n; i++) {
      const c = cursors[i];
      if (c && c.count < anchorDf) {
        anchorDf = c.count;
        anchor = i;
      }
    }
    const anchorCursor = /** @type {NonNullable<typeof cursors[0]>} */ (cursors[anchor]);
    const order = [];
    for (let i = 0; i < n; i++) if (i !== anchor && cursors[i]) order.push(i);
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
    /** @type {Array<?number[]>} */
    let values = [];
    /** @type {?number[]} */
    let pageMarkers = null;
    /** @type {?import('./searchPageRecords.js').PageRecord|false} */
    let rec = null;
    /** @type {number[]} */
    let recValues = [];
    let needRecord = false;
    // Undefined until a walk first needs the segment's marker postings, null when the segment has none.
    /** @type {?import('./searchSegment.js').PostingsCursor|undefined} */
    let markerCursor;
    let markerSeek = false;
    /**
     * @param {string} hash @param {number} page
     */
    const loadRecord = async (hash, page) => {
      if (plan) plan.records++;
      const r = (await readRecord(hash, page)) || false;
      if (r) {
        recValues = new Array(r.pos.length);
        for (let k = 0; k < r.pos.length; k++) recValues[k] = (r.pos[k] << 1) | r.span[k];
      }
      return r;
    };
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
      if (!values[j] && prefixByPage) values[j] = prefixByPage.advance(pageKey) && prefixByPage.key === pageKey ? prefixByPage.values : [];
      const vs = values[j];
      // Each position from right after `cur` to past the markers is tried, so a typed marker and a stepped-over one are both found.
      for (let x = from; x <= to; x++) {
        if (vs) {
          for (let at = firstAtOrAfter(vs, x); at < vs.length && (vs[at] >>> 1) === x; at++) {
            chain[j] = vs[at];
            if (walkRight(chain, j + 1, vs[at])) return true;
          }
        } else if (!rec) {
          // The prefix term is verified from the page record, which the caller reads before walking again.
          if (rec === null) needRecord = true;
        } else {
          verified++;
          for (let k = firstAtOrAfter(recValues, x); k < rec.pos.length && rec.pos[k] === x; k++) {
            if (recordTokenTerm(rec, k, options.tokenizer).startsWith(prefix)) {
              chain[j] = recValues[k];
              if (walkRight(chain, j + 1, recValues[k])) return true;
            }
          }
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

    try {
      while (anchorCursor.next()) {
        if (job && performance.now() - sliceStart >= SLICE_MS && await paused()) {
          cancelled = true;
          return;
        }
        const { key } = anchorCursor;
        const ordinal = Math.floor(key / PAGE_KEY_SPAN);
        if (seg.dead.has(ordinal)) continue;
        let present = true;
        for (let k = 0; k < order.length && present; k++) {
          const c = /** @type {NonNullable<typeof cursors[0]>} */ (cursors[order[k]]);
          if (!c.advance(key, seekBy[order[k]]) || c.key !== key) present = false;
        }
        if (!present) continue;
        candidates++;
        const page = key % PAGE_KEY_SPAN;
        const { hash } = reader.docs[ordinal];
        pageKey = key;
        values = cursors.map((c) => (c ? c.values : null));
        pageMarkers = null;
        rec = null;
        recValues = [];
        /** @type {Array<[number, number]>} */
        let marks = [];
        let count = 0;
        // An occurrence counts once, by its first position.
        // Otherwise a list holding both a joined hyphenation and its first half at one position, as a prefix's range can, would start two chains for it.
        let lastFirst = -1;
        for (const av of /** @type {number[]} */ (values[anchor])) {
          const chain = new Array(n);
          chain[anchor] = av;
          let cur = av;
          let ok = true;
          // Both walks start from the anchor and are independent, so their order changes no result.
          // Under `sweepByCost` the left walk goes first, so the prefix, the last term, is read only for an occurrence whose other terms line up.
          for (let phase = 0; phase < 2 && ok; phase++) {
            cur = av;
            if ((phase === 0) === !plan) {
              for (let j = anchor + 1; j < n && ok; j++) {
                const expect = (cur >>> 1) + 1 + (cur & 1);
                if (!values[j] && prefixByPage) values[j] = prefixByPage.advance(key) && prefixByPage.key === key ? prefixByPage.values : [];
                if (values[j]) {
                  const vs = /** @type {number[]} */ (values[j]);
                  const at = firstAtOrAfter(vs, expect);
                  if (at < vs.length && (vs[at] >>> 1) === expect) {
                    cur = vs[at];
                    chain[j] = cur;
                  } else ok = false;
                } else {
                  if (rec === null) rec = await loadRecord(hash, page);
                  verified++;
                  ok = false;
                  if (rec) {
                    let k = firstAtOrAfter(recValues, expect);
                    for (; k < rec.pos.length && rec.pos[k] === expect; k++) {
                      if (recordTokenTerm(rec, k, options.tokenizer).startsWith(prefix)) {
                        cur = (rec.pos[k] << 1) | rec.span[k];
                        chain[j] = cur;
                        ok = true;
                        break;
                      }
                    }
                  }
                }
              }
            } else {
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
            }
          }
          let stepped = false;
          if (!ok && stepMarkers) {
            if (markersOfPage().length) {
              chain[anchor] = av;
              needRecord = false;
              ok = plan ? walkLeft(chain, anchor - 1, av) && walkRight(chain, anchor + 1, av) : walkRight(chain, anchor + 1, av) && walkLeft(chain, anchor - 1, av);
              if (!ok && needRecord) {
                rec = await loadRecord(hash, page);
                ok = plan ? walkLeft(chain, anchor - 1, av) && walkRight(chain, anchor + 1, av) : walkRight(chain, anchor + 1, av) && walkLeft(chain, anchor - 1, av);
              }
              stepped = ok;
            }
          }
          if (!ok || (chain[0] >>> 1) === lastFirst) continue;
          lastFirst = chain[0] >>> 1;
          if (stepped) skips++;
          count++;
          if (lowerMode) break;
          if (marks.length < 20) marks.push([chain[0], chain[n - 1]]);
        }
        if (count) {
          if (lowerMode) exactPages++;
          else {
            yield {
              hash, page, ingestSeq: seg.ingestSeq(ordinal), tier: 1, count, span: n, score: 0, marks,
            };
          }
        } else if (lowerMode) {
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
          marks = [];
          count = 0;
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
              if (marks.length < 20) marks.push([p0 << 1, last << 1]);
            }
          }
          if (count) tier = 2;
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
                  if (marks.length < 20) marks.push([all[lo][0] << 1, all[hi][0] << 1]);
                }
                if (--have[all[lo][1]] === 0) distinct--;
                lo++;
              }
            }
            if (count) tier = 3;
            else {
              tier = 4;
              span = seg.pageLength(ordinal, page);
              count = n;
              for (let j = 0; j < n; j++) if (marks.length < 20 && pos[j].length) marks.push([pos[j][0] << 1, pos[j][0] << 1]);
            }
          }
          let score = 0;
          if (tier === 4) {
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
    } finally {
      if (plan && prefixByPage && prefixByPage.sought) {
        plan.rangeReads += prefixByPage.reads;
        plan.rangeTermsOpened += prefixByPage.terms.length;
        plan.rangeTermsMerged += prefixByPage.mergedTerms;
      }
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
    for (const h of hits) matches += h.tier === 4 ? 1 : h.count;
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
