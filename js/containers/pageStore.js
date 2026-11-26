import { opt } from './app.js';
import {
  encodePageRecord, decodePageRecord, encodeDetailRecord, decodeDetailRecord, readPageRecordExtras,
} from './pageRecord.js';
import { deflateBytes } from '../export/pdf/writePdfStreams.js';
import { inflate } from '../pdf/parsePdfUtils.js';

/** @typedef {import('../objects/ocrObjects.js').OcrPage} OcrPage */

/**
 * Encoded record bytes, either raw or deflate-compressed.
 * @typedef {{ bytes: Uint8Array, deflated: boolean }} HeldRecord
 */

/**
 * Native-text entries and fill shapes for a PDF page.
 * @typedef {{ nativeText: ?Record<string, NativeTextWord>, fillShapes: ?PageFillShapes }} PageExtras
 */

/**
 * Per-page total word count, native-PDF word count, and text source.
 * @typedef {{ words: number, nativeWords: number, textSource: OcrPage['textSource'] }} PageCounts
 */

/**
 * One page slot in a text layer, resident in memory or stored as encoded records.
 * @typedef {Object} PageEntry
 * @property {?OcrPage} page - Decoded page while in memory, or null when not loaded.
 * @property {boolean} detailed - Whether character boxes on `page` and `extras` from the detail record are loaded in memory.
 * @property {?HeldRecord} record - Cached page record while the page is unmodified, or null after a mutable read.
 * @property {?HeldRecord} detail - Cached detail record while valid, or null once detail is loaded on a modified page.
 * @property {boolean} clean - Whether the cached records match the in-memory page so eviction needs no re-encoding.
 * @property {?PageExtras} extras - Loaded PDF extras while detail is in memory, or null when absent, unloaded, or borrowed.
 * @property {?Int32Array} detailOrder - Per-word index into `detail` when words moved after `detail` was written, or null when in order.
 * @property {number} flags - Bitmask of PDF fill-shape flags stored in the page record header.
 * @property {number} words - Word count charged against the eviction budget while droppable, floored at 1.
 * @property {number} pins - Number of hosts currently pinning this entry in memory.
 * @property {?PageCounts} counts - Cached word counts while the page is unmodified.
 * @property {boolean} borrowed - Whether the page shares another layer's records.
 *   When true, native-text entries and fill shapes in the detail record belong to the source layer and are not loaded onto this entry.
 */

/**
 * Encoded record state of a single page.
 * @typedef {Object} PageSnapshot
 * @property {HeldRecord} record
 * @property {?HeldRecord} detail
 * @property {?Int32Array} order - Index in `detail` for each word on the page, or null when word order matches `detail`.
 * @property {number} flags
 * @property {?PageCounts} counts
 * @property {boolean} borrowed - Whether the page shares another layer's records.
 */

/** @type {WeakMap<OcrPage, PageEntry>} */
const entryOf = new WeakMap();

/**
 * Evictable in-memory page entries across all documents, ordered least-recently-used first.
 * @type {Set<PageEntry>}
 */
const droppable = new Set();
let droppableWords = 0;

// A top-level `await` here would make every importing module initialize asynchronously, which deadlocks scribe-ui's import cycles.
const zlib = (typeof process !== 'undefined' && typeof process.versions?.node === 'string')
  ? process.getBuiltinModule('node:zlib')
  : null;

/** Decompress a deflated record synchronously. */
export const inflateRecord = zlib ? zlib.inflateSync : inflate;

/**
 * Deflate an uncompressed record.
 * @param {Uint8Array} raw
 * @returns {Uint8Array|Promise<Uint8Array>} Deflated bytes synchronously in Node, or a promise in browsers.
 */
export function deflateRecord(raw) {
  // zlib.deflateSync returns a view into a pooled 16 KB chunk, so copy to avoid retaining the backing buffer.
  return zlib ? new Uint8Array(zlib.deflateSync(raw, { level: 1 })) : deflateBytes(raw);
}

/** @param {Uint8Array} raw */
function holdRecord(raw) {
  if (zlib) return /** @type {HeldRecord} */ ({ bytes: /** @type {Uint8Array} */ (deflateRecord(raw)), deflated: true });
  /** @type {HeldRecord} */
  const held = { bytes: raw, deflated: false };
  /** @type {Promise<Uint8Array>} */ (deflateRecord(raw)).then((bytes) => {
    held.bytes = bytes;
    held.deflated = true;
  }, () => {});
  return held;
}

/**
 * Encode `value` as deflated JSON in a `HeldRecord`.
 * @param {unknown} value
 * @returns {HeldRecord}
 */
export function holdJson(value) {
  return holdRecord(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * Decode and parse the JSON value in `held`.
 * @param {HeldRecord} held
 */
export function heldJson(held) {
  return JSON.parse(new TextDecoder().decode(held.deflated ? inflateRecord(held.bytes) : held.bytes));
}

/**
 * Compute the fill-shape summary bitmask for a PDF page.
 * @param {{dims: {width: number, height: number}}} page
 * @param {?PageFillShapes} fillShapes
 * @returns {number} Bitmask with `1` for an image or path under 95% of page area and `2` when `fillShapes.pathsIneligible` is set.
 */
export function fillShapeFlags(page, fillShapes) {
  if (!fillShapes) return 0;
  const areaCap = page.dims.width * page.dims.height * 0.95;
  let small = false;
  for (const e of fillShapes.images || []) {
    if ((e.right - e.left) * (e.bottom - e.top) < areaCap) small = true;
  }
  for (const e of fillShapes.paths || []) {
    if ((e.right - e.left) * (e.bottom - e.top) < areaCap) small = true;
  }
  return (small ? 1 : 0) | (fillShapes.pathsIneligible ? 2 : 0);
}

/**
 * Partition a document's pages into balanced runs sized to `opt.pageBudget` words.
 * @param {Array<number>} words - Word count per page.
 * @returns {Array<number>} Zero-based start page index of each run, followed by `words.length`.
 */
export function pageRuns(words) {
  const pageCount = words.length;
  // Balance run sizes so layout passes do not infer document conventions from a short trailing run.
  const cuts = [0];
  if (opt.dev.layoutChunkPages) {
    const chunkN = Math.max(1, Math.ceil(pageCount / opt.dev.layoutChunkPages));
    for (let c = 1; c <= chunkN; c++) cuts.push(Math.floor((c * pageCount) / chunkN));
  } else {
    let total = 0;
    for (const count of words) total += count;
    const chunkN = Math.max(1, Math.ceil(total / opt.pageBudget));
    let seen = 0;
    for (let n = 0; n < pageCount - 1 && cuts.length < chunkN; n++) {
      seen += words[n];
      if (seen >= (cuts.length * total) / chunkN) cuts.push(n + 1);
    }
    cuts.push(pageCount);
  }
  return cuts;
}

/**
 * Map each word on `page` to its pre-layout index in `idsBefore`.
 * @param {Array<string>} idsBefore
 * @param {OcrPage} page
 * @returns {?Int32Array} Pre-layout word indices, null when no words moved, or an empty array to invalidate stale detail when words were added, removed, or replaced.
 */
export function detailOrderAfter(idsBefore, page) {
  let k = 0;
  let moved = false;
  for (const line of page.lines) {
    for (const word of line.words) {
      if (word.id !== idsBefore[k++]) moved = true;
    }
  }
  if (!moved && k === idsBefore.length) return null;
  /** @type {Map<string, Array<number>>} */
  const places = new Map();
  for (let i = idsBefore.length - 1; i >= 0; i--) {
    const stack = places.get(idsBefore[i]);
    if (stack) stack.push(i);
    else places.set(idsBefore[i], [i]);
  }
  if (k !== idsBefore.length) return new Int32Array(0);
  const order = new Int32Array(k);
  k = 0;
  for (const line of page.lines) {
    for (const word of line.words) {
      const place = places.get(word.id)?.pop();
      if (place === undefined) return new Int32Array(0);
      order[k++] = place;
    }
  }
  return order;
}

/**
 * Decode an entry's detail record onto its page words and populate `entry.extras`.
 * @param {PageEntry} entry
 * @param {boolean} onlyMissing - Keep existing `word.chars` when already populated.
 */
function loadDetail(entry, onlyMissing) {
  const page = /** @type {OcrPage} */ (entry.page);
  const record = /** @type {HeldRecord} */ (entry.detail);
  let target = page;
  if (entry.detailOrder) {
    const order = entry.detailOrder;
    const inRecordOrder = new Array(order.length);
    let k = 0;
    for (const line of page.lines) {
      for (const word of line.words) {
        inRecordOrder[order[k++]] = word;
      }
    }
    target = k === order.length ? { lines: [{ words: inRecordOrder }] } : { lines: [] };
  }
  const extras = decodeDetailRecord(record.deflated ? inflateRecord(record.bytes) : record.bytes, target, onlyMissing);
  entry.extras = entry.borrowed ? null : extras;
  entry.detailed = true;
}

/**
 * Encode uncompressed records for a modified in-memory entry.
 * @param {PageEntry} entry
 * @returns {{record: Uint8Array, detail: ?Uint8Array, flags: number}} `detail` is null when the detail record is not loaded in memory, leaving `entry.detail` valid as-is.
 */
function encodeEntry(entry) {
  const page = /** @type {OcrPage} */ (entry.page);
  if (!entry.detailed && entry.detail && page.lines.some((line) => line.words.some((word) => word.chars))) loadDetail(entry, true);
  const nativeText = entry.detailed && entry.extras ? entry.extras.nativeText : null;
  const fillShapes = entry.detailed && entry.extras ? entry.extras.fillShapes : null;
  const flags = entry.detailed ? fillShapeFlags(page, fillShapes) : entry.flags;
  return {
    record: encodePageRecord(page, nativeText, flags),
    detail: entry.detailed ? encodeDetailRecord(page, nativeText, fillShapes) : null,
    flags,
  };
}

/**
 * Capture an entry's current state as a `PageSnapshot`.
 * @param {PageEntry} entry
 * @returns {PageSnapshot}
 */
function snapshotOf(entry) {
  if (entry.clean) {
    return {
      record: /** @type {HeldRecord} */ (entry.record), detail: entry.detail, order: entry.detailOrder, flags: entry.flags, counts: entry.counts, borrowed: entry.borrowed,
    };
  }
  const made = encodeEntry(entry);
  return {
    record: holdRecord(made.record),
    detail: made.detail ? holdRecord(made.detail) : entry.detail,
    order: made.detail ? null : entry.detailOrder,
    flags: made.flags,
    counts: null,
    borrowed: entry.borrowed,
  };
}

/**
 * Create an unloaded `PageEntry` from `snap`.
 * @param {PageSnapshot} snap
 * @returns {PageEntry}
 */
function entryFor(snap) {
  return {
    page: null,
    detailed: false,
    record: snap.record,
    detail: snap.detail,
    clean: true,
    extras: null,
    detailOrder: snap.order,
    flags: snap.flags,
    words: 0,
    pins: 0,
    counts: snap.counts,
    borrowed: snap.borrowed,
  };
}

/** @param {PageEntry} entry */
function unlist(entry) {
  if (droppable.delete(entry)) droppableWords -= entry.words;
}

/**
 * Update `entry` in the droppable LRU set and evict the least recently used pages to stay within `opt.pageBudget`.
 * @param {PageEntry} entry
 */
function list(entry) {
  // With an infinite budget nothing is evicted from the global `droppable` set, which would retain unclosed documents forever.
  if (opt.pageBudget === Infinity) return;
  if (entry.pins > 0) {
    unlist(entry);
    return;
  }
  if (!droppable.delete(entry)) {
    let words = 0;
    for (const line of /** @type {OcrPage} */ (entry.page).lines) words += line.words.length;
    entry.words = Math.max(words, 1);
    droppableWords += entry.words;
  }
  droppable.add(entry);
  for (const old of droppable) {
    if (droppableWords <= opt.pageBudget || old === entry) break;
    const page = /** @type {OcrPage} */ (old.page);
    if (!old.clean) {
      const made = encodeEntry(old);
      old.flags = made.flags;
      if (made.detail) {
        old.detail = holdRecord(made.detail);
        old.detailOrder = null;
      }
      old.record = holdRecord(made.record);
    }
    old.page = null;
    old.detailed = false;
    old.extras = null;
    old.clean = true;
    entryOf.delete(page);
    unlist(old);
  }
}

/**
 * Store for a document's named text layers.
 * Evicted pages are encoded into compact records and decoded into fresh objects on the next read, so callers must not hold `OcrPage` references across reads of other pages.
 */
export class PageStore {
  /** @type {Object<string, Array<?PageEntry|undefined>>} */
  #layers = {};

  /** @type {Map<object, Set<PageEntry>>} */
  #pinned = new Map();

  /** @type {?string} */
  #active = null;

  #holds = 0;

  /** The names of the layers, in the order they were added. */
  get names() {
    return Object.keys(this.#layers);
  }

  /** @param {string} name */
  has(name) {
    return name in this.#layers;
  }

  /**
   * Return whether `layer` holds a page at 0-based index `n`.
   * @param {number} n
   * @param {string} layer - Layer name, or `'active'`.
   * @returns {boolean}
   */
  hasPage(n, layer) {
    return !!this.#slots(layer)?.[n];
  }

  /** The name of the active layer, or null when no layer is active. */
  get active() {
    return this.#active;
  }

  set active(name) {
    if (name !== null && !(name in this.#layers)) throw new Error(`No text layer named "${name}" on this document.`);
    this.#active = name;
  }

  /**
   * Return the slot array for `layer`, resolving `'active'` to the active layer, or undefined if none exists.
   * @param {string} layer
   */
  #slots(layer) {
    const name = layer === 'active' ? this.#active : layer;
    return name === null ? undefined : this.#layers[name];
  }

  /** Return all non-empty entries across every layer, including duplicates shared between layers. */
  #entries() {
    return /** @type {Array<PageEntry>} */ (Object.values(this.#layers).flat().filter(Boolean));
  }

  /**
   * Remove `entry` from the droppable LRU set unless another layer still holds it at slot `n`.
   * @param {?PageEntry|undefined} entry
   * @param {number} n
   */
  #letGo(entry, n) {
    if (entry && !Object.values(this.#layers).some((slots) => slots[n] === entry)) unlist(entry);
  }

  /**
   * Ensure `entry.page` (and its detail when requested) is decoded in memory and update its LRU position.
   * @param {PageEntry} entry
   * @param {number} n
   * @param {boolean} detail
   * @param {boolean} mutable - Whether the caller may mutate the page, invalidating its cached record.
   */
  #load(entry, n, detail, mutable) {
    if (!entry.page) {
      const record = /** @type {HeldRecord} */ (entry.record);
      entry.page = decodePageRecord(record.deflated ? inflateRecord(record.bytes) : record.bytes);
      // Page operations move or copy records between slots without re-encoding, so decodePageRecord may return a stale page.n.
      entry.page.n = n;
      entry.detailed = false;
      entryOf.set(entry.page, entry);
    }
    if (detail && !entry.detailed) {
      if (entry.detail) loadDetail(entry, !entry.clean);
      else entry.detailed = true;
    }
    if (mutable) entry.clean = false;
    if (!entry.clean) {
      entry.counts = null;
      entry.record = null;
      if (entry.detailed) entry.detail = null;
    }
    if (this.#holds === 0) list(entry);
    else unlist(entry);
  }

  /**
   * Return the page at `n` on `layer` for in-place mutation.
   * @param {number} n
   * @param {string} [layer]
   * @param {boolean} [detail] - Whether to load character boxes onto the page's words.
   * @returns {?OcrPage|undefined}
   */
  getPage(n, layer = 'active', detail = false) {
    const entry = this.#slots(layer)?.[n];
    if (!entry) return entry;
    this.#load(entry, n, detail, true);
    return entry.page;
  }

  /**
   * Return the page at index `n` for read-only access.
   * @param {number} n
   * @param {string} [layer]
   * @param {boolean} [detail] - Whether to load character boxes onto the page's words.
   * @returns {?OcrPage|undefined}
   */
  readOnlyPage(n, layer = 'active', detail = false) {
    const entry = this.#slots(layer)?.[n];
    if (!entry) return entry;
    this.#load(entry, n, detail, false);
    return entry.page;
  }

  /**
   * Return the native-text entries and fill shapes for page `n` of the `pdf` layer.
   * @param {number} n
   * @param {boolean} mutable - Whether the caller may mutate the returned extras.
   * @returns {PageExtras|undefined} Undefined when the `pdf` layer has no page at `n`.
   */
  extras(n, mutable) {
    const entry = this.#layers.pdf?.[n];
    if (!entry) return undefined;
    this.#load(entry, n, true, mutable);
    if (!entry.extras) entry.extras = { nativeText: null, fillShapes: null };
    return entry.extras;
  }

  /**
   * Return an array view of a layer's pages that loads each page when indexed.
   * @param {string} [layer]
   * @param {boolean} [detail] - Whether to load character boxes onto each page's words.
   * @param {boolean} [mutable] - Whether the caller may mutate the returned pages.
   * @returns {Array<?OcrPage|undefined>}
   */
  pageList(layer = 'active', detail = false, mutable = false) {
    const slots = this.#slots(layer) || [];
    return new Proxy(/** @type {Array<?OcrPage|undefined>} */ ([]), {
      get: (target, prop, receiver) => {
        if (prop === 'length') return slots.length;
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          const entry = slots[Number(prop)];
          if (!entry) return entry;
          this.#load(entry, Number(prop), detail, mutable);
          return entry.page;
        }
        return Reflect.get(target, prop, receiver);
      },
      has: (target, prop) => (typeof prop === 'string' && /^\d+$/.test(prop) ? Number(prop) in slots : Reflect.has(target, prop)),
    });
  }

  /**
   * Return the number of slots in a layer, including empty slots.
   * @param {string} [layer]
   * @returns {number} The slot count, or 0 when the layer does not exist.
   */
  slotCount(layer = 'active') {
    return this.#slots(layer)?.length ?? 0;
  }

  /**
   * Pin the given active-layer page indices in memory for `host`, replacing any pages pinned by an earlier call with the same `host`.
   * @param {object} host
   * @param {Iterable<number>} pages
   */
  pin(host, pages) {
    const slots = this.#slots('active') || [];
    /** @type {Set<PageEntry>} */
    const next = new Set();
    for (const n of pages) {
      const entry = slots[n];
      if (entry) next.add(entry);
    }
    const before = this.#pinned.get(host);
    if (next.size) this.#pinned.set(host, next);
    else this.#pinned.delete(host);
    for (const entry of next) {
      if (before && before.has(entry)) continue;
      entry.pins++;
      unlist(entry);
    }
    if (!before) return;
    for (const entry of before) {
      if (next.has(entry)) continue;
      entry.pins--;
      if (entry.pins === 0 && entry.page && this.#holds === 0) list(entry);
    }
  }

  /**
   * Return a page's word count, native PDF word count, and text source.
   * @param {number} n
   * @param {string} [layer]
   * @returns {?PageCounts} Null when the layer has no page at `n`.
   */
  pageCounts(n, layer = 'active') {
    const entry = this.#slots(layer)?.[n];
    if (!entry) return null;
    if (entry.counts) return entry.counts;
    if (entry.record) {
      const head = readPageRecordExtras(entry.record.deflated ? inflateRecord(entry.record.bytes) : entry.record.bytes);
      if (head.wordBits || head.textSource !== 'pdf') {
        let nativeWords = 0;
        if (head.wordBits) {
          for (let k = 0; k < head.wordBits.length; k++) nativeWords += head.wordBits[k] & 1;
        }
        entry.counts = { words: head.words, nativeWords, textSource: head.textSource };
        return entry.counts;
      }
    }
    this.#load(entry, n, false, false);
    const page = /** @type {OcrPage} */ (entry.page);
    const nativeText = page.textSource === 'pdf' ? this.extras(n, false)?.nativeText : null;
    let words = 0;
    let nativeWords = 0;
    for (const line of page.lines) {
      for (const word of line.words) {
        words++;
        if (nativeText && nativeText[word.id]) nativeWords++;
      }
    }
    const counts = { words, nativeWords, textSource: page.textSource };
    if (entry.clean) entry.counts = counts;
    return counts;
  }

  /**
   * Return per-word native-text flags for page `n` in reading order.
   * Each byte is 0 for no native-text entry, 1 for an editable entry, or 3 for an uneditable entry.
   * @param {number} n
   * @param {string} [layer]
   * @returns {?Uint8Array} Null when the layer has no page at `n`, the page is modified, or its record lacks native-text bits.
   */
  nativeBits(n, layer = 'active') {
    const entry = this.#slots(layer)?.[n];
    if (!entry || !entry.clean || !entry.record) return null;
    return readPageRecordExtras(entry.record.deflated ? inflateRecord(entry.record.bytes) : entry.record.bytes).wordBits;
  }

  /**
   * Return the fill-shape flags bitmask for page `n` in the `pdf` layer.
   * Flag `1` indicates an image or path covering under 95% of the page, and flag `2` indicates `pathsIneligible`.
   * @param {number} n
   * @returns {?number} Null when the `pdf` layer holds no page at `n`.
   */
  shapeFlags(n) {
    const entry = this.#layers.pdf?.[n];
    if (!entry) return null;
    if (!entry.clean && entry.page && entry.detailed) return fillShapeFlags(entry.page, entry.extras ? entry.extras.fillShapes : null);
    return entry.flags;
  }

  /**
   * Return the cached page record when the page is unmodified, or null when modified or empty.
   * The same `HeldRecord` reference is returned until the slot is modified or replaced.
   * @param {number} n
   * @param {string} [layer]
   * @returns {?HeldRecord}
   */
  cleanRecord(n, layer = 'active') {
    const entry = this.#slots(layer)?.[n];
    return entry && entry.clean ? entry.record : null;
  }

  /**
   * Return a page's records, flags, and word counts for saving.
   * Modified pages are encoded on the spot and stay marked modified.
   * @param {number} n
   * @param {string} [layer]
   * @returns {?{record: HeldRecord, detail: ?HeldRecord, order: ?Int32Array, flags: number, counts: PageCounts}} Null when the layer holds no page at `n`.
   *   For unmodified pages, `record` is the same `HeldRecord` object returned by `cleanRecord`.
   */
  recordsOf(n, layer = 'active') {
    const entry = this.#slots(layer)?.[n];
    if (!entry) return null;
    const counts = /** @type {PageCounts} */ (this.pageCounts(n, layer));
    if (entry.clean) {
      return {
        record: /** @type {HeldRecord} */ (entry.record), detail: entry.detail, order: entry.detailOrder, flags: entry.flags, counts,
      };
    }
    const made = encodeEntry(entry);
    return {
      record: { bytes: made.record, deflated: false },
      detail: made.detail ? { bytes: made.detail, deflated: false } : entry.detail,
      order: made.detail ? null : entry.detailOrder,
      flags: made.flags,
      counts,
    };
  }

  /**
   * Capture a page's current state as records.
   * @param {number} n
   * @param {string} [layer]
   * @returns {?PageSnapshot} Null when the layer holds no page at `n`.
   */
  snapshot(n, layer = 'active') {
    const entry = this.#slots(layer)?.[n];
    return entry ? snapshotOf(entry) : null;
  }

  /**
   * Encode a standalone `OcrPage` into a `PageSnapshot`.
   * @param {OcrPage} page
   * @param {?PageExtras} [extras]
   * @returns {PageSnapshot}
   */
  static snapshotOfPage(page, extras = null) {
    return snapshotOf({
      page, detailed: true, record: null, detail: null, clean: false, extras, detailOrder: null, flags: 0, words: 0, pins: 0, counts: null, borrowed: false,
    });
  }

  /**
   * Restore an existing layer slot from `snap`.
   * Callers holding an older `OcrPage` reference must re-read the page from the store.
   * @param {number} n
   * @param {string} layer
   * @param {PageSnapshot} snap
   */
  restore(n, layer, snap) {
    const entry = this.#slots(layer)?.[n];
    if (!entry) throw new Error(`No page ${n} to restore on this text layer.`);
    if (entry.page) entryOf.delete(entry.page);
    unlist(entry);
    entry.page = null;
    entry.detailed = false;
    entry.extras = null;
    entry.record = snap.record;
    entry.detail = snap.detail;
    entry.detailOrder = snap.order;
    entry.flags = snap.flags;
    entry.counts = snap.counts;
    entry.clean = true;
  }

  /**
   * Share the records for page `n` from layer `from` into layer `to`.
   * Each layer decodes its own `OcrPage` instance, so mutating one layer does not affect the other.
   * @param {number} n
   * @param {string} from
   * @param {string} to
   */
  sharePage(n, from, to) {
    const snap = this.snapshot(n, from);
    this.add(to);
    const slots = this.#layers[to];
    const old = slots[n];
    if (snap) slots[n] = entryFor({ ...snap, borrowed: true });
    else delete slots[n];
    this.#letGo(old, n);
  }

  /**
   * Reorder, insert, or remove page slots across every layer, detaching any removed `OcrPage` objects.
   * @param {Array<?number>} tags - Per new slot index, the previous page index or null for a newly inserted slot.
   * @param {number} oldLength - Previous page count before remapping.
   * @param {Map<number, Object<string, PageSnapshot>>} [arriving] - Snapshots by layer for each newly inserted slot index.
   * @returns {Map<number, Object<string, PageSnapshot>>} Snapshots by layer for each removed page, keyed by its previous index.
   */
  remap(tags, oldLength, arriving = new Map()) {
    const kept = new Set(tags);
    /** @type {Map<number, Object<string, PageSnapshot>>} */
    const leaving = new Map();
    /** @type {Map<PageEntry, PageSnapshot>} */
    const left = new Map();
    /** @type {Map<PageSnapshot, PageEntry>} */
    const arrived = new Map();
    for (const [name, slots] of Object.entries(this.#layers)) {
      /** @type {Array<?PageEntry|undefined>} */
      const next = [];
      tags.forEach((old, pos) => {
        let entry = old === null ? undefined : slots[old];
        const snap = old === null ? arriving.get(pos)?.[name] : undefined;
        if (snap) {
          entry = arrived.get(snap) || entryFor(snap);
          arrived.set(snap, entry);
        }
        if (!entry) return;
        next[pos] = entry;
        if (entry.page) entry.page.n = pos;
      });
      slots.forEach((entry, old) => {
        if (!entry || kept.has(old)) return;
        const snap = left.get(entry) || snapshotOf(entry);
        left.set(entry, snap);
        const column = leaving.get(old) || {};
        column[name] = snap;
        leaving.set(old, column);
      });
      const length = slots.length === oldLength ? tags.length : next.length;
      slots.length = 0;
      next.forEach((entry, pos) => { slots[pos] = entry; });
      slots.length = length;
    }
    for (const entry of left.keys()) {
      unlist(entry);
      if (entry.page) entryOf.delete(entry.page);
      // Clear entry.page so unpinning a removed entry later cannot re-add it to the droppable LRU set.
      entry.page = null;
    }
    return leaving;
  }

  /**
   * Return counts of distinct in-memory `OcrPage` objects and how many of them are modified or pinned.
   * @returns {{pages: number, changed: number, pinned: number}}
   */
  residency() {
    const out = { pages: 0, changed: 0, pinned: 0 };
    for (const entry of new Set(this.#entries())) {
      if (!entry.page) continue;
      out.pages++;
      if (!entry.clean) out.changed++;
      if (entry.pins > 0) out.pinned++;
    }
    return out;
  }

  /**
   * Ensure layer `name` exists with at least `length` slots.
   * @param {string} name
   * @param {number} [length]
   */
  add(name, length = 0) {
    if (name === 'active') throw new Error('A text layer cannot be named "active".');
    if (!(name in this.#layers)) this.#layers[name] = [];
    if (this.#layers[name].length < length) this.#layers[name].length = length;
  }

  /**
   * Remove a layer and its pages.
   * @param {string} name
   */
  remove(name) {
    const slots = this.#layers[name];
    if (!slots) return;
    delete this.#layers[name];
    if (this.#active === name) this.#active = null;
    slots.forEach((entry, n) => this.#letGo(entry, n));
  }

  /**
   * Store `page` at index `n` in `layer`, creating the layer if needed.
   * @param {number} n
   * @param {?OcrPage} page
   * @param {string} layer
   * @param {?PageExtras} [extras]
   */
  setPage(n, page, layer, extras = null) {
    const name = layer === 'active' ? this.#active : layer;
    if (name === null) throw new Error('The document has no active text layer to write to.');
    this.add(name);
    const slots = this.#layers[name];
    const old = slots[n];
    slots[n] = this.slotFor(page);
    if (extras && slots[n]) /** @type {PageEntry} */ (slots[n]).extras = extras;
    if (old !== slots[n]) this.#letGo(old, n);
  }

  /**
   * Store `snap` at index `n` in `layer`, creating the layer if needed.
   * @param {number} n
   * @param {string} layer
   * @param {PageSnapshot} snap
   */
  setSnapshot(n, layer, snap) {
    this.add(layer);
    const slots = this.#layers[layer];
    const old = slots[n];
    slots[n] = entryFor(snap);
    this.#letGo(old, n);
  }

  /**
   * Store deflated page and detail records at slot `n` in `layer`, creating the layer if needed.
   * @param {number} n
   * @param {string} layer
   * @param {Uint8Array} record
   * @param {?Uint8Array} detail
   * @param {number} flags
   * @param {?PageCounts} [counts]
   */
  setRecords(n, layer, record, detail, flags, counts = null) {
    this.add(layer);
    const slots = this.#layers[layer];
    const old = slots[n];
    slots[n] = entryFor({
      record: { bytes: record, deflated: true }, detail: detail ? { bytes: detail, deflated: true } : null, order: null, flags, counts, borrowed: false,
    });
    this.#letGo(old, n);
  }

  /**
   * Return the stored page-record bytes for an unmodified slot in `layer`.
   * @param {number} n
   * @param {string} layer
   * @returns {Uint8Array}
   */
  heldRecord(n, layer) {
    return /** @type {HeldRecord} */ (/** @type {PageEntry} */ (this.#layers[layer][n]).record).bytes;
  }

  /**
   * Replace the deflated page record and cached word counts of an undecoded slot in `layer`.
   * @param {number} n
   * @param {string} layer
   * @param {Uint8Array} record
   * @param {?PageCounts} [counts]
   */
  replaceRecord(n, layer, record, counts = null) {
    const entry = /** @type {PageEntry} */ (this.#layers[layer][n]);
    entry.record = { bytes: record, deflated: true };
    entry.counts = counts;
  }

  /**
   * Set the detail-record word mapping for slot `n` in `layer`.
   * @param {number} n
   * @param {string} layer
   * @param {Int32Array} order - Per word on the page, its word index in the detail record.
   */
  setDetailOrder(n, layer, order) {
    /** @type {PageEntry} */ (this.#layers[layer][n]).detailOrder = order;
  }

  /**
   * Return whether the page at `n` in `layer` is in memory with its character boxes and extras loaded.
   * @param {number} n
   * @param {string} layer - Concrete layer name (`'active'` returns `false`).
   * @returns {boolean}
   */
  isDetailed(n, layer) {
    const entry = this.#layers[layer]?.[n];
    return !!entry && entry.page !== null && entry.detailed;
  }

  /**
   * Move layer `name` from `other` into this store, replacing any existing layer of that name.
   * @param {PageStore} other
   * @param {string} name
   */
  takeLayer(other, name) {
    const old = this.#layers[name];
    this.#layers[name] = other.#layers[name];
    delete other.#layers[name];
    if (other.#active === name) other.#active = null;
    if (old) old.forEach((entry, n) => this.#letGo(entry, n));
  }

  /**
   * Empty one slot of a layer.
   * @param {number} n
   * @param {string} layer
   */
  removePage(n, layer) {
    const slots = this.#slots(layer);
    if (!slots) return;
    const old = slots[n];
    delete slots[n];
    this.#letGo(old, n);
  }

  /**
   * Replace all pages in `layer`, creating the layer if needed.
   * @param {string} layer
   * @param {Array<?OcrPage|undefined>} pages
   */
  setPages(layer, pages) {
    this.add(layer);
    const slots = this.#layers[layer];
    const old = [...slots];
    slots.length = 0;
    slots.length = pages.length;
    pages.forEach((page, n) => { slots[n] = this.slotFor(page); });
    old.forEach((entry, n) => this.#letGo(entry, n));
  }

  /**
   * Replace this store's layers and active layer with those from `other`, leaving `other` empty.
   * @param {PageStore} other
   */
  adopt(other) {
    this.clear();
    this.#layers = other.#layers;
    this.#active = other.#active;
    other.#layers = {};
    other.#active = null;
  }

  /**
   * Return the existing `PageEntry` for `page`, or create a new one.
   * @param {?OcrPage|undefined} page
   * @returns {?PageEntry|undefined} Null or undefined when `page` is null or undefined.
   */
  slotFor(page) {
    if (!page) return page;
    let entry = entryOf.get(page);
    if (!entry) {
      entry = {
        page, detailed: true, record: null, detail: null, clean: false, extras: null, detailOrder: null, flags: 0, words: 0, pins: 0, counts: null, borrowed: false,
      };
      entryOf.set(page, entry);
    }
    if (this.#holds === 0) list(entry);
    else unlist(entry);
    return entry;
  }

  /**
   * Run `fn` with page eviction suspended on this store until `fn` finishes or its returned promise settles.
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  held(fn) {
    if (this.#holds++ === 0) this.#entries().forEach(unlist);
    const release = () => {
      if (--this.#holds === 0) {
        for (const entry of this.#entries()) {
          if (entry.page) list(entry);
        }
      }
    };
    let out;
    try {
      out = fn();
    } catch (err) {
      release();
      throw err;
    }
    if (out instanceof Promise) return /** @type {T} */ (out.finally(release));
    release();
    return out;
  }

  /**
   * Remove this store's pages from the global LRU eviction set and word budget.
   */
  stopCounting() {
    this.#entries().forEach(unlist);
  }

  clear() {
    this.stopCounting();
    this.#layers = {};
    this.#active = null;
    this.#pinned = new Map();
  }
}
