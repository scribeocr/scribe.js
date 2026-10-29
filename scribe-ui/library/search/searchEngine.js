import { compareHits, evaluate } from './searchEvaluator.js';
import {
  encodePageRecords, readPageBoxes, readPageRecord, readPageView,
} from './searchPageRecords.js';
import {
  PAGE_KEY_SPAN, compareBytes, openSegment, readAllPostings, writeSegment,
} from './searchSegment.js';
import { HEAP_STRING, HEAP_TYPED_ARRAY, utf8Encode } from './searchBytes.js';
import { MARKER_TERM, TOKENIZER_DEFAULTS, tokenizePage } from './searchTokenizer.js';

/**
 * The engine's settings.
 * A timing harness outside this repository changes them one at a time against these defaults, so a setting the app never changes is still in use.
 */
export const ENGINE_DEFAULTS = Object.freeze({
  /** The number of hit pages at which the exact answer's sweep stops. */
  bound: 100,
  cacheBytes: 16 << 20,
  /**
   * How many files stay open between reads.
   * A file a read is using is never closed, so a query may open more.
   */
  maxOpenFiles: 48,
  mergeTarget: 30,
  mergeFactor: 10,
  /**
   * The last word is read as a prefix too.
   * The pages holding a longer word in its place follow the pages holding it as typed.
   */
  prefixLastWord: true,
  fallbackTiers: true,
  /** How many pages the ranked pass keeps, the best. */
  tierBound: 100,
  /**
   * Whether the fallback tiers are skipped for a query whose exact answer stopped at its bound.
   * On a large library, running them for such a query visits every page holding its common terms and delays the next query's first paint.
   */
  tiersSkipBounded: true,
  sweepByCost: true,
  seekCostBytes: 16,
  rankSpan: false,
  firstScreenDocs: 20,
  firstScreenPages: 4,
  snippetRadius: 70,
  /**
   * The tokenizer rules an empty index is built under.
   * An index that holds documents keeps its own.
   */
  tokenizer: TOKENIZER_DEFAULTS,
  /**
   * @type {'varint'|'packed'}
   */
  encoding: 'packed',
});

const CHUNK = 1 << 16;

/**
 * @typedef {Object} SearchStorage
 * @property {() => Promise<string[]>} list
 * @property {(name: string) => Promise<{size: number, read: (offset: number, length: number) => Uint8Array, close: () => void}>} open
 * @property {(name: string, bytes: Uint8Array) => Promise<void>} write
 * @property {(name: string) => Promise<void>} remove
 */

/**
 * @returns {SearchStorage}
 */
export const memoryStorage = () => {
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  return {
    list: async () => [...files.keys()],
    open: async (name) => {
      const bytes = files.get(name);
      if (!bytes) throw new Error(`NotFoundError: ${name}`);
      return { size: bytes.length, read: (offset, length) => bytes.subarray(offset, offset + length), close: () => {} };
    },
    write: async (name, bytes) => {
      files.set(name, bytes.slice());
    },
    remove: async (name) => {
      files.delete(name);
    },
  };
};

/**
 * @typedef {Object} ManifestSegment
 * @property {string} name
 * @property {number} bytes
 * @property {Array<{hash: string, pages: number, records: string, recordBytes?: number, ingestSeq: number}>} docs
 * @property {number[]} dead
 */

/**
 * @param {SearchStorage} storage
 * @param {Partial<typeof ENGINE_DEFAULTS>} [settings]
 */
export const createSearchEngine = (storage, settings = {}) => {
  const options = { ...ENGINE_DEFAULTS, ...settings, tokenizer: { ...TOKENIZER_DEFAULTS, ...(settings.tokenizer || {}) } };
  if (options.encoding !== 'varint' && options.encoding !== 'packed') throw new Error(`Unknown postings encoding ${JSON.stringify(options.encoding)}`);

  /** @type {Map<string, Uint8Array>} */
  const chunks = new Map();
  let cacheBytes = 0;
  /**
   * @type {Map<string, {handle: {size: number, read: (offset: number, length: number) => Uint8Array, close: () => void},
   *   view: {size: number, read: (offset: number, length: number) => Uint8Array}}>}
   */
  const open = new Map();
  /** @type {Map<string, number>} */
  const pins = new Map();
  let reads = 0;
  let markerSkips = 0;
  let readBytes = 0;
  const planned = {
    queries: 0, segments: 0, advanced: 0, sought: 0, rangeMerged: 0,
  };
  /**
   * A file's cached view.
   * It reads through whichever handle the file has open, so a segment reader outlives a close and a reopen of its file.
   * Only read through it while the file is acquired.
   * @param {string} name
   * @param {number} size
   */
  const viewOf = (name, size) => ({
    size,
    read: (offset, length) => {
      if (length <= 0) return new Uint8Array(0);
      const end = Math.min(size, offset + length);
      const first = Math.floor(offset / CHUNK);
      const last = Math.floor((end - 1) / CHUNK);
      const chunkOf = (c) => {
        const key = `${name}#${c}`;
        let bytes = chunks.get(key);
        if (bytes) {
          chunks.delete(key);
          chunks.set(key, bytes);
          return bytes;
        }
        const entry = open.get(name);
        if (!entry) throw new Error(`read of ${name}, which is not open`);
        const at = c * CHUNK;
        const want = Math.min(CHUNK, size - at);
        bytes = entry.handle.read(at, want);
        if (bytes.length !== want) throw new Error(`short read of ${name} at ${at}: ${bytes.length} of ${want} bytes`);
        reads++;
        readBytes += bytes.length;
        chunks.set(key, bytes);
        cacheBytes += bytes.length;
        while (cacheBytes > options.cacheBytes && chunks.size > 1) {
          const oldest = /** @type {[string, Uint8Array]} */ (chunks.entries().next().value);
          chunks.delete(oldest[0]);
          cacheBytes -= oldest[1].length;
        }
        return bytes;
      };
      if (first === last) {
        const c = chunkOf(first);
        return c.subarray(offset - first * CHUNK, end - first * CHUNK);
      }
      const out = new Uint8Array(end - offset);
      let at = 0;
      for (let c = first; c <= last; c++) {
        const bytes = chunkOf(c);
        const from = c === first ? offset - c * CHUNK : 0;
        const to = c === last ? end - c * CHUNK : bytes.length;
        out.set(bytes.subarray(from, to), at);
        at += to - from;
      }
      return out;
    },
  });
  /** @type {Map<string, Promise<NonNullable<ReturnType<typeof open.get>>>>} */
  const opening = new Map();
  const evict = () => {
    for (const segmentsToo of [false, true]) {
      for (const [name, entry] of open) {
        if (open.size <= options.maxOpenFiles) return;
        if (pins.has(name) || (!segmentsToo && readers.has(name))) continue;
        open.delete(name);
        entry.handle.close();
      }
    }
  };
  /** @param {string} name */
  const release = (name) => {
    const left = (pins.get(name) || 1) - 1;
    if (left) pins.set(name, left);
    else pins.delete(name);
    evict();
  };
  /**
   * Open a file, or take its open handle, for a read.
   * The file is pinned from this call until its matching `release`, so no eviction can close it under the read.
   * @param {string} name
   */
  const acquire = async (name) => {
    pins.set(name, (pins.get(name) || 0) + 1);
    try {
      let entry = open.get(name);
      if (entry) {
        open.delete(name);
        open.set(name, entry);
      } else {
        let pending = opening.get(name);
        if (!pending) {
          pending = storage.open(name).then((handle) => {
            const opened = { handle, view: viewOf(name, handle.size) };
            open.set(name, opened);
            return opened;
          });
          opening.set(name, pending);
          pending.then(() => opening.delete(name), () => opening.delete(name));
        }
        entry = await pending;
      }
      return entry.view;
    } catch (err) {
      release(name);
      throw err;
    }
  };
  /** @param {string} name */
  const closeFile = (name) => {
    const have = open.get(name);
    if (have) {
      have.handle.close();
      open.delete(name);
    }
    for (const key of chunks.keys()) {
      if (key.startsWith(`${name}#`)) {
        cacheBytes -= /** @type {Uint8Array} */ (chunks.get(key)).length;
        chunks.delete(key);
      }
    }
  };
  /** @param {string} name */
  const removeFile = async (name) => {
    closeFile(name);
    await storage.remove(name).catch(() => {});
  };

  /**
   * @type {{generation: number, next: number, nextIngestSeq: number, segments: ManifestSegment[], tokenizer?: import('./searchTokenizer.js').TokenizerRules}}
   */
  let manifest = {
    generation: 0, next: 1, nextIngestSeq: 0, segments: [],
  };
  /** @type {Map<string, {reader: ReturnType<typeof openSegment>, dead: Set<number>}>} */
  const readers = new Map();
  let manifestBytes = 0;
  /**
   * The tokenizer rules the index is built under.
   * All of its pages and queries must share them, so this session's rules apply only while the index is empty.
   * @type {import('./searchTokenizer.js').TokenizerRules}
   */
  let indexRules = { ...options.tokenizer };
  let collection = { pages: 0, positions: 0 };
  const recount = () => {
    let pages = 0;
    let positions = 0;
    for (const s of manifest.segments) {
      const r = readers.get(s.name);
      if (!r) continue;
      for (let i = 0; i < r.reader.docs.length; i++) {
        if (r.dead.has(i)) continue;
        pages += r.reader.docs[i].pageCount;
        positions += r.reader.docs[i].positions;
      }
    }
    collection = { pages, positions };
  };

  const writeManifest = async () => {
    manifest.generation++;
    manifest.tokenizer = indexRules;
    const bytes = new TextEncoder().encode(JSON.stringify(manifest));
    manifestBytes = bytes.length;
    await storage.write(`gen-${String(manifest.generation).padStart(6, '0')}.json`, bytes);
    const names = await storage.list();
    for (const n of names) {
      const m = /^gen-(\d+)\.json$/.exec(n);
      if (m && Number(m[1]) < manifest.generation) await storage.remove(n).catch(() => {});
    }
  };
  /** @param {ManifestSegment} seg */
  const readerOf = async (seg) => {
    let r = readers.get(seg.name);
    if (!r) {
      const file = await acquire(seg.name);
      try {
        r = { reader: openSegment(file), dead: new Set(seg.dead) };
      } finally {
        release(seg.name);
      }
      readers.set(seg.name, r);
    } else {
      r.dead = new Set(seg.dead);
    }
    return r;
  };
  const liveSegments = () => manifest.segments.filter((s) => s.dead.length < s.docs.length);
  /** @param {string} hash */
  const findLive = (hash) => {
    for (const seg of manifest.segments) {
      const ord = seg.docs.findIndex((d, i) => d.hash === hash && !seg.dead.includes(i));
      if (ord >= 0) return { seg, ord };
    }
    return null;
  };

  const loadIndex = async () => {
    manifest = {
      generation: 0, next: 1, nextIngestSeq: 0, segments: [],
    };
    const names = await storage.list();
    let best = 0;
    for (const n of names) {
      const m = /^gen-(\d+)\.json$/.exec(n);
      if (m && Number(m[1]) > best) best = Number(m[1]);
    }
    if (best) {
      const genName = `gen-${String(best).padStart(6, '0')}.json`;
      const f = await acquire(genName);
      try {
        manifest = JSON.parse(new TextDecoder().decode(f.read(0, f.size)));
        manifestBytes = f.size;
      } catch {
        manifest = {
          generation: best, next: 1, nextIngestSeq: 0, segments: [],
        };
      } finally {
        release(genName);
      }
      closeFile(genName);
      const present = new Set(names);
      manifest.segments = manifest.segments.filter((s) => present.has(s.name));
      if (manifest.nextIngestSeq === undefined) {
        const all = manifest.segments.flatMap((seg) => seg.docs).sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
        all.forEach((d, i) => { d.ingestSeq = i; });
        manifest.nextIngestSeq = all.length;
      }
    }
    // An index built before the manifest recorded its rules was built under `TOKENIZER_DEFAULTS`, except that a marker took no position.
    indexRules = manifest.segments.length ? { ...TOKENIZER_DEFAULTS, markersUnpositioned: true, ...(manifest.tokenizer || {}) } : { ...options.tokenizer };
    const referenced = new Set();
    for (const s of manifest.segments) {
      referenced.add(s.name);
      for (const d of s.docs) referenced.add(d.records);
    }
    for (const n of names) {
      if (/^(seg|pr)-\d+\.bin$/.test(n) && !referenced.has(n)) await storage.remove(n).catch(() => {});
      const m = /^gen-(\d+)\.json$/.exec(n);
      if (m && Number(m[1]) !== manifest.generation) await storage.remove(n).catch(() => {});
    }
    for (const s of manifest.segments) await readerOf(s);
    recount();
  };
  /** @type {?Promise<void>} */
  let opened = null;
  const openIndex = () => {
    if (!opened) {
      opened = loadIndex().catch((err) => {
        opened = null;
        throw err;
      });
    }
    return opened;
  };

  const mergeDown = async () => {
    while (liveSegments().length > options.mergeTarget) {
      const sources = liveSegments().sort((a, b) => a.bytes - b.bytes).slice(0, options.mergeFactor);
      /** @type {Array<{seg: ManifestSegment, reader: ReturnType<typeof openSegment>, dead: Set<number>, remap: Map<number, number>}>} */
      const inputs = [];
      /** @type {Array<{input: number, ordinal: number, doc: ManifestSegment['docs'][number], pageLengths: Uint16Array}>} */
      const live = [];
      for (const seg of sources) {
        const { reader, dead } = await readerOf(seg);
        seg.docs.forEach((d, i) => {
          if (!dead.has(i)) {
            live.push({
              input: inputs.length, ordinal: i, doc: d, pageLengths: reader.docs[i].pageLengths,
            });
          }
        });
        inputs.push({
          seg, reader, dead, remap: new Map(),
        });
      }
      // Documents go in ingest order, as in every segment, so the exact sweep's early stop keeps the same pages however the merges fall.
      live.sort((a, b) => a.doc.ingestSeq - b.doc.ingestSeq);
      /** @type {ManifestSegment['docs']} */
      const docs = [];
      const docTable = [];
      for (const x of live) {
        inputs[x.input].remap.set(x.ordinal, docs.length);
        docs.push(x.doc);
        docTable.push({ hash: x.doc.hash, pageCount: x.doc.pages, pageLengths: x.pageLengths });
      }
      /** @type {string[]} */
      const held = [];
      let written;
      try {
        for (const s of sources) {
          await acquire(s.name);
          held.push(s.name);
        }
        const iters = inputs.map((inp) => inp.reader.terms());
        const heads = iters.map((it) => it.next());
        const merged = function* mergedTerms() {
          while (heads.some((h) => !h.done)) {
            let best = -1;
            for (let i = 0; i < heads.length; i++) {
              if (heads[i].done) continue;
              if (best < 0 || compareBytes(heads[i].value.bytes, heads[best].value.bytes) < 0) best = i;
            }
            const { bytes } = heads[best].value;
            const entries = [];
            let holders = 0;
            for (let i = 0; i < heads.length; i++) {
              if (heads[i].done || compareBytes(heads[i].value.bytes, bytes) !== 0) continue;
              const { remap, reader } = inputs[i];
              for (const pe of readAllPostings(reader, heads[i].value)) {
                const ord = Math.floor(pe.key / PAGE_KEY_SPAN);
                const to = remap.get(ord);
                if (to === undefined) continue;
                entries.push({ key: to * PAGE_KEY_SPAN + (pe.key % PAGE_KEY_SPAN), values: pe.values });
              }
              holders++;
              heads[i] = iters[i].next();
            }
            // Each source's entries come in the merged key order, but the sources' documents interleave in it.
            if (holders > 1) entries.sort((a, b) => a.key - b.key);
            if (entries.length) yield { bytes, entries };
          }
        };
        written = writeSegment(docTable, merged(), options.encoding);
      } finally {
        for (const name of held) release(name);
      }
      const name = `seg-${manifest.next++}.bin`;
      await storage.write(name, written);
      const sourceNames = new Set(sources.map((s) => s.name));
      manifest.segments = manifest.segments.filter((s) => !sourceNames.has(s.name));
      manifest.segments.push({
        name, bytes: written.length, docs, dead: [],
      });
      await writeManifest();
      for (const s of sources) {
        readers.delete(s.name);
        await removeFile(s.name);
      }
      await readerOf(/** @type {ManifestSegment} */ (manifest.segments[manifest.segments.length - 1]));
    }
    const dropped = manifest.segments.filter((s) => s.dead.length >= s.docs.length);
    if (dropped.length) {
      manifest.segments = manifest.segments.filter((s) => s.dead.length < s.docs.length);
      await writeManifest();
      for (const s of dropped) {
        readers.delete(s.name);
        await removeFile(s.name);
      }
    }
  };

  /**
   * Mark a document's live copy dead.
   * Remove its page-record file only once a generation that no longer names it is written.
   * @param {string} hash
   * @returns {?string} The dead copy's page-record file.
   */
  const tombstone = (hash) => {
    const live = findLive(hash);
    if (!live) return null;
    live.seg.dead.push(live.ord);
    const r = readers.get(live.seg.name);
    if (r) r.dead.add(live.ord);
    return live.seg.docs[live.ord].records;
  };

  /**
   * @param {string} hash
   * @param {number} page
   * @returns {Promise<{rec: ?import('./searchPageRecords.js').PageRecord, boxes: ?{dims: {width: number, height: number}, boxes: Array<import('./searchPageRecords.js').Box>}}>}
   */
  const readPage = async (hash, page) => {
    const live = findLive(hash);
    if (!live) return { rec: null, boxes: null };
    const name = live.seg.docs[live.ord].records;
    const file = await acquire(name);
    try {
      const rec = await readPageRecord(file, page);
      return { rec, boxes: rec ? await readPageBoxes(file, page) : null };
    } finally {
      release(name);
    }
  };

  /**
   * @param {import('./searchPageRecords.js').PageRecord} rec
   * @returns {(v: number) => number}
   */
  const tokenIndexOf = (rec) => {
    const values = rec.pos.map((p, i) => (p << 1) | rec.span[i]);
    // Emission order is not value order: a joined hyphenation (2p + 1) comes before its first half (2p).
    const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
    return (v) => {
      let lo = 0;
      let hi = order.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (values[order[mid]] < v) lo = mid + 1;
        else hi = mid;
      }
      return lo < order.length && values[order[lo]] === v ? order[lo] : -1;
    };
  };

  /**
   * @template T
   * @param {import('./searchPageRecords.js').PageRecord} rec
   * @param {Array<T>} perWord
   * @param {Array<[number, number]>} marks - (position << 1 | span) values of each occurrence's first and last token.
   * @param {(v: number) => number} indexOf
   * @returns {Array<Array<T>>}
   */
  const wordsOf = (rec, perWord, marks, indexOf) => {
    const groups = [];
    // A word with no token, such as a line number right after a line-end hyphenation, lies inside an occurrence's range without being part of it.
    const tokenWords = new Set(rec.wordIndex);
    for (const [a, b] of marks) {
      const i = indexOf(a);
      const j = indexOf(b);
      if (i < 0 || j < 0) continue;
      const from = rec.wordIndex[i];
      // A joined hyphenation's second half is the token two after the joined one, and its word need not be the next word.
      const last = rec.span[j] && j + 2 < rec.wordIndex.length ? rec.wordIndex[j + 2] : rec.wordIndex[j];
      const to = Math.min(perWord.length - 1, last);
      if (from > to) continue;
      const group = [];
      for (let k = from; k <= to; k++) if (tokenWords.has(k)) group.push(perWord[k]);
      if (group.length) groups.push(group);
    }
    return groups;
  };

  /**
   * @param {import('./searchPageRecords.js').PageRecord} rec
   * @param {Array<[number, number]>} marks - (position << 1 | span) values of each occurrence's first and last token.
   * @param {(v: number) => number} indexOf
   */
  const snippetOf = (rec, marks, indexOf) => {
    const ranges = [];
    for (const [a, b] of marks) {
      const i = indexOf(a);
      const j = indexOf(b);
      if (i < 0 || j < 0) continue;
      ranges.push([rec.charStart[i], rec.charEnd[j]]);
    }
    ranges.sort((x, y) => x[0] - y[0]);
    if (!ranges.length) {
      return {
        text: rec.text.slice(0, options.snippetRadius * 2), marks: [], before: false, after: rec.text.length > options.snippetRadius * 2,
      };
    }
    const start = Math.max(0, ranges[0][0] - options.snippetRadius);
    const end = Math.min(rec.text.length, ranges[0][1] + options.snippetRadius);
    return {
      text: rec.text.slice(start, end),
      marks: ranges.filter(([s, e]) => s >= start && e <= end).map(([s, e]) => [s - start, e - start]),
      before: start > 0,
      after: end < rec.text.length,
    };
  };

  const tierRuns = {
    runs: 0, cancelled: 0, pages: 0, ms: 0,
  };
  /**
   * @param {string} query
   * @param {number} bound
   * @param {boolean} lower
   * @param {{cancelled: boolean, pause?: () => Promise<void>}} [job]
   */
  const answer = async (query, bound, lower, job) => {
    await openIndex();
    const t0 = performance.now();
    /** @type {string[]} */
    const held = [];
    try {
      const segs = [];
      for (const s of liveSegments()) {
        await acquire(s.name);
        held.push(s.name);
        const { reader, dead } = await readerOf(s);
        segs.push({
          reader,
          dead,
          pageLength: (/** @type {number} */ ord, /** @type {number} */ page) => reader.docs[ord].pageLengths[page] || 1,
          ingestSeq: (/** @type {number} */ ord) => s.docs[ord].ingestSeq,
        });
      }
      const result = await evaluate(segs, query, {
        bound,
        prefixLastWord: options.prefixLastWord,
        lower,
        rankSpan: options.rankSpan,
        sweepByCost: options.sweepByCost,
        seekCostBytes: options.seekCostBytes,
        tokenizer: indexRules,
        collection: { pages: collection.pages, avgLength: collection.pages ? collection.positions / collection.pages : 1 },
      }, job);
      if (result.cancelled) return null;
      const sweepMs = performance.now() - t0;
      if (!lower) {
        markerSkips += result.skips;
        if (result.plan) {
          planned.queries++;
          for (const [k, v] of Object.entries(result.plan)) planned[/** @type {keyof typeof planned} */ (k)] += v;
        }
      }
      /** @type {Map<string, {hash: string, pages: Array<import('./searchEvaluator.js').Hit>}>} */
      const byDoc = new Map();
      for (const h of result.hits) {
        let d = byDoc.get(h.hash);
        if (!d) {
          d = { hash: h.hash, pages: [] };
          byDoc.set(h.hash, d);
        }
        d.pages.push(h);
      }
      const docs = [...byDoc.values()];
      for (const d of docs) d.pages.sort((a, b) => compareHits(a, b, options.rankSpan));
      docs.sort((a, b) => compareHits(a.pages[0], b.pages[0], options.rankSpan));
      const t1 = performance.now();
      /** @type {Map<import('./searchEvaluator.js').Hit, ?ReturnType<typeof snippetOf>>} */
      const snippets = new Map();
      /** @type {Map<import('./searchEvaluator.js').Hit, ?{dims: {width: number, height: number}, rects: Array<Array<import('./searchPageRecords.js').Box>>}>} */
      const rects = new Map();
      // The results view fetches the other pages' snippets as it shows them.
      await Promise.all(docs.slice(0, options.firstScreenDocs).map(async (d) => {
        await Promise.all(d.pages.slice(0, options.firstScreenPages).map(async (h) => {
          const { rec, boxes } = await readPage(h.hash, h.page);
          if (!rec) {
            snippets.set(h, null);
            return;
          }
          const indexOf = tokenIndexOf(rec);
          snippets.set(h, snippetOf(rec, h.marks, indexOf));
          if (boxes) rects.set(h, { dims: boxes.dims, rects: wordsOf(rec, boxes.boxes, h.marks, indexOf) });
        }));
      }));
      return {
        query,
        terms: result.terms,
        units: result.units,
        quoted: result.quoted,
        matches: result.matches,
        bounded: result.bounded,
        partial: result.partial,
        bound,
        candidates: result.candidates,
        skips: result.skips,
        plan: result.plan,
        docs: docs.map((d) => ({
          hash: d.hash,
          total: d.pages.reduce((sum, h) => sum + (h.tier === 5 ? 1 : h.count), 0),
          pages: d.pages.map((h) => ({
            page: h.page, tier: h.tier, count: h.count, score: h.score, marks: h.marks, snippet: snippets.get(h) ?? null, rects: rects.get(h)?.rects ?? null, dims: rects.get(h)?.dims ?? null,
          })),
        })),
        ms: { sweep: sweepMs, snippets: performance.now() - t1, total: performance.now() - t0 },
        ...(lower ? { found: result.found, exactPages: result.exactPages } : { fallbackTiers: options.fallbackTiers }),
      };
    } finally {
      for (const name of held) release(name);
    }
  };

  return {
    options,
    open: openIndex,

    /**
     * @param {string} hash
     * @param {Array<?import('./searchTokenizer.js').PageInput>} pages
     * @returns {Promise<{pages: number, positions: number, tokens: number, unpositioned: number, markers: number, segmentBytes: number, recordBytes: number, ms: number}>}
     */
    async addDoc(hash, pages) {
      await openIndex();
      const t0 = performance.now();
      if (!manifest.segments.length) indexRules = { ...options.tokenizer };
      const streams = pages.map((p) => tokenizePage(p, indexRules));
      const records = await encodePageRecords(streams, pages);
      /** @type {Map<string, Map<number, number[]>>} */
      const byTerm = new Map();
      let positions = 0;
      let tokens = 0;
      let unpositioned = 0;
      let markers = 0;
      if (streams.length >= PAGE_KEY_SPAN) throw new Error(`A document of ${streams.length} pages exceeds the page key span.`);
      streams.forEach((s, page) => {
        positions += s.positions;
        tokens += s.terms.length;
        unpositioned += s.unpositioned;
        markers += s.markers.length;
        for (let i = 0; i < s.terms.length; i++) {
          let termPages = byTerm.get(s.terms[i]);
          if (!termPages) {
            termPages = new Map();
            byTerm.set(s.terms[i], termPages);
          }
          let values = termPages.get(page);
          if (!values) {
            values = [];
            termPages.set(page, values);
          }
          values.push((s.pos[i] << 1) | s.span[i]);
        }
        if (s.markers.length) {
          let termPages = byTerm.get(MARKER_TERM);
          if (!termPages) {
            termPages = new Map();
            byTerm.set(MARKER_TERM, termPages);
          }
          termPages.set(page, s.markers.map((p) => p << 1));
        }
      });
      const terms = [...byTerm.keys()].map((term) => ({ term, bytes: utf8Encode(term) })).sort((a, b) => compareBytes(a.bytes, b.bytes));
      const termEntries = function* docTerms() {
        for (const { term, bytes } of terms) {
          const termPages = /** @type {Map<number, number[]>} */ (byTerm.get(term));
          yield { bytes, entries: [...termPages.entries()].map(([key, values]) => ({ key, values })) };
        }
      };
      const segment = writeSegment([{ hash, pageCount: streams.length, pageLengths: streams.map((s) => s.positions) }], termEntries(), options.encoding);
      const k = manifest.next++;
      const recordsName = `pr-${k}.bin`;
      const segName = `seg-${k}.bin`;
      await storage.write(recordsName, records);
      await storage.write(segName, segment);
      const live = findLive(hash);
      const ingestSeq = live ? live.seg.docs[live.ord].ingestSeq : manifest.nextIngestSeq++;
      const oldRecords = tombstone(hash);
      manifest.segments.push({
        name: segName,
        bytes: segment.length,
        docs: [{
          hash, pages: streams.length, records: recordsName, recordBytes: records.length, ingestSeq,
        }],
        dead: [],
      });
      await writeManifest();
      if (oldRecords) await removeFile(oldRecords);
      await readerOf(manifest.segments[manifest.segments.length - 1]);
      await mergeDown();
      recount();
      return {
        pages: streams.length, positions, tokens, unpositioned, markers, segmentBytes: segment.length, recordBytes: records.length, ms: performance.now() - t0,
      };
    },

    /** @param {string} hash */
    async removeDoc(hash) {
      await openIndex();
      const oldRecords = tombstone(hash);
      if (!oldRecords) return;
      await writeManifest();
      await removeFile(oldRecords);
      await mergeDown();
      recount();
    },

    /** @param {string} hash */
    hasDoc(hash) {
      return !!findLive(hash);
    },

    /**
     * Answer a query's exact phrase, with snippets for the first screen.
     * @param {string} query
     * @param {{bound?: number}} [opts]
     */
    async query(query, opts = {}) {
      return /** @type {NonNullable<Awaited<ReturnType<typeof answer>>>} */ (await answer(query, opts.bound ?? options.bound, false));
    },

    /**
     * Answer a query's looser kinds, the best `tierBound` pages that hold every unit of the query but not its exact phrase.
     * Null when the job was canceled.
     * @param {string} query
     * @param {{cancelled: boolean, pause?: () => Promise<void>}} [job]
     */
    async tiers(query, job) {
      const t0 = performance.now();
      const result = await answer(query, options.tierBound, true, job);
      if (!result) tierRuns.cancelled++;
      else {
        tierRuns.runs++;
        tierRuns.pages += result.docs.reduce((sum, d) => sum + d.pages.length, 0);
        tierRuns.ms += performance.now() - t0;
      }
      return result;
    },

    /**
     * @param {string} hash
     * @param {Array<{page: number, marks: Array<[number, number]>}>} pages
     */
    async snippets(hash, pages) {
      await openIndex();
      return Promise.all(pages.map(async (p) => {
        const { rec, boxes } = await readPage(hash, p.page);
        if (!rec) {
          return {
            page: p.page, snippet: null, rects: null, dims: null,
          };
        }
        const indexOf = tokenIndexOf(rec);
        return {
          page: p.page, snippet: snippetOf(rec, p.marks, indexOf), rects: boxes ? wordsOf(rec, boxes.boxes, p.marks, indexOf) : null, dims: boxes ? boxes.dims : null,
        };
      }));
    },

    /**
     * @param {string} hash
     * @param {number[]} pageNs
     * @returns {Promise<Array<?import('./searchPageRecords.js').PageView>>}
     */
    async pages(hash, pageNs) {
      await openIndex();
      const live = findLive(hash);
      if (!live) return pageNs.map(() => null);
      const name = live.seg.docs[live.ord].records;
      const file = await acquire(name);
      try {
        const out = [];
        for (const n of pageNs) {
          const rec = await readPageRecord(file, n);
          out.push(rec ? await readPageView(file, n, rec.text) : null);
        }
        return out;
      } finally {
        release(name);
      }
    },

    /**
     * The document's matches of a query, in page order, with the ids of each occurrence's words.
     * @param {string} hash
     * @param {string} query
     * @param {Array<{page: number, tier: number, count: number, marks: Array<[number, number]>}>} [near] - Near matches of the document to return with its matches, as the results list shows them.
     *   A page that merely holds every word (tier 5) is one match of all its marked words.
     * @returns {Promise<{pages: Array<{page: number, count: number, matches: Array<Array<string>>}>}>}
     */
    async find(hash, query, near = []) {
      await openIndex();
      const live = findLive(hash);
      if (!live) return { pages: [] };
      const { seg } = live;
      await acquire(seg.name);
      /** @type {Awaited<ReturnType<typeof evaluate>>} */
      let result;
      try {
        const { reader, dead } = await readerOf(seg);
        result = await evaluate([{
          reader,
          dead,
          pageLength: (/** @type {number} */ ord, /** @type {number} */ page) => reader.docs[ord].pageLengths[page] || 1,
          ingestSeq: (/** @type {number} */ ord) => seg.docs[ord].ingestSeq,
        }], query, {
          bound: Number.POSITIVE_INFINITY,
          doc: live.ord,
          marksPerPage: Number.POSITIVE_INFINITY,
          prefixLastWord: options.prefixLastWord,
          rankSpan: options.rankSpan,
          sweepByCost: options.sweepByCost,
          seekCostBytes: options.seekCostBytes,
          tokenizer: indexRules,
          collection: { pages: collection.pages, avgLength: collection.pages ? collection.positions / collection.pages : 1 },
        });
      } finally {
        release(seg.name);
      }
      const name = seg.docs[live.ord].records;
      const file = await acquire(name);
      try {
        const listed = new Set(result.hits.map((h) => h.page));
        const wanted = [
          ...result.hits.map((h) => ({
            page: h.page, count: h.count, marks: h.marks, whole: false,
          })),
          ...near.filter((p) => !listed.has(p.page)).map((p) => ({
            page: p.page, count: p.tier === 5 ? 1 : p.count, marks: p.marks, whole: p.tier === 5,
          })),
        ].sort((a, b) => a.page - b.page);
        const pages = [];
        for (const h of wanted) {
          const rec = await readPageRecord(file, h.page);
          const view = rec ? await readPageView(file, h.page, rec.text) : null;
          if (!rec || !view) continue;
          const ids = view.lines.flatMap((l) => l.words.map((w) => w.id));
          const groups = wordsOf(rec, ids, h.marks, tokenIndexOf(rec));
          pages.push({ page: h.page, count: h.count, matches: h.whole ? [groups.flat()] : groups });
        }
        return { pages };
      } finally {
        release(name);
      }
    },

    /**
     * The engine's own account of what it holds in memory, and the index's shape.
     * A timing harness outside this repository reads it, so a field the app never reads is still in use.
     */
    stats() {
      let readerBytes = 0;
      let docs = 0;
      let pages = 0;
      let terms = 0;
      for (const [, r] of readers) {
        readerBytes += r.reader.residentBytes;
        terms += r.reader.termCount;
      }
      let bytes = 0;
      let recordBytes = 0;
      /** @type {Record<string, number>} */
      const encodings = {};
      for (const s of liveSegments()) {
        bytes += s.bytes;
        const r = readers.get(s.name);
        if (r) encodings[r.reader.encoding] = (encodings[r.reader.encoding] || 0) + 1;
        for (let i = 0; i < s.docs.length; i++) {
          if (s.dead.includes(i)) continue;
          docs++;
          pages += s.docs[i].pages;
          recordBytes += s.docs[i].recordBytes || 0;
        }
      }
      const chunkHeap = chunks.size * (HEAP_TYPED_ARRAY + HEAP_STRING + 40);
      const mismatch = Object.keys(indexRules).filter((rule) => indexRules[rule] !== options.tokenizer[rule]);
      return {
        residentBytes: cacheBytes + chunkHeap + readerBytes + manifestBytes,
        cacheBytes,
        dictionaryBytes: readerBytes,
        manifestBytes,
        segments: liveSegments().length,
        generation: manifest.generation,
        docs,
        pages,
        terms,
        segmentBytes: bytes,
        recordBytes,
        encodings,
        openFiles: open.size,
        pinnedFiles: pins.size,
        reads,
        readBytes,
        markerSkips,
        tokenizer: options.tokenizer,
        indexTokenizer: indexRules,
        tokenizerMismatch: mismatch,
        sweepByCost: options.sweepByCost,
        seekCostBytes: options.seekCostBytes,
        planned: { ...planned },
        tiers: { ...tierRuns, ms: Math.round(tierRuns.ms) },
        settings: Object.fromEntries(Object.entries(options).filter(([name]) => name !== 'tokenizer')),
      };
    },

    async reset() {
      for (const name of [...open.keys()]) closeFile(name);
      readers.clear();
      for (const n of await storage.list()) await storage.remove(n).catch(() => {});
      manifest = {
        generation: 0, next: 1, nextIngestSeq: 0, segments: [],
      };
      manifestBytes = 0;
      indexRules = { ...options.tokenizer };
      recount();
      opened = Promise.resolve();
    },

    close() {
      for (const name of [...open.keys()]) closeFile(name);
      readers.clear();
      opened = null;
    },
  };
};
