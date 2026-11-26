import { inflateRecord } from './pageStore.js';

export const SAVED_MAGIC = 0x57524353;
export const SAVED_VERSION = 1;
export const SAVED_PREAMBLE = 16;

/**
 * Page-table entry for one stored page.
 * Elements are `[recordBytes, detailBytes, orderBytes, extrasBytes, flags, words, nativeWords, textSource, angle, key]`.
 * @typedef {[number, number, number, number, number, number, number, ?OcrPage['textSource'], ?number, string]} SavedRow
 */

/**
 * Page table of a saved file.
 * @typedef {Object} SavedTable
 * @property {?string} layer - Text layer name, or null when the document has no text.
 * @property {?Array<?number|SavedRow>} pages - Per-page `SavedRow`, 0-based base-file index for an unchanged page, or null for an empty slot.
 *   Null as a whole in a work file when every page matches the base records file in order.
 */

/**
 * Encoded page data read from a saved file.
 * @typedef {Object} SavedPage
 * @property {Uint8Array} record - Deflated page record.
 * @property {?Uint8Array} detail - Deflated detail record.
 * @property {?Int32Array} order - Detail-record word index for each word on the page, or null when word order matches.
 * @property {?{nativeText?: Object, fillShapes?: Object, truth?: Object, hocrSource?: Object}} extras
 * @property {number} flags
 * @property {import('./pageStore.js').PageCounts} counts
 * @property {?number} angle
 */

/**
 * File location and table row for one page in a saved file.
 * @typedef {Object} SavedSlot
 * @property {Blob} file
 * @property {SavedRow} row
 * @property {number} recordAt - Byte offset of the page record in `file`.
 * @property {number} restAt - Byte offset of the trailing detail, order, and extras bytes in `file`.
 * @property {number|string} key - 0-based page index in the base records file, or the record key from the work file.
 */

/**
 * Read a saved file's document blocks, page table, and page-data byte offset.
 * @param {Blob} file
 * @param {boolean} [blocksOnly] - When true, skip the page table and return `table: null`.
 * @returns {Promise<{blocks: Record<string, Object>, table: ?SavedTable, dataAt: number}>}
 */
export async function readSavedHead(file, blocksOnly = false) {
  const pre = new DataView(await file.slice(0, SAVED_PREAMBLE).arrayBuffer());
  if (pre.byteLength < SAVED_PREAMBLE || pre.getUint32(0, true) !== SAVED_MAGIC) throw new Error('The saved file is not one this version of the application wrote.');
  if (pre.getUint32(4, true) !== SAVED_VERSION) throw new Error(`The saved file is of version ${pre.getUint32(4, true)}, and this version of the application reads version ${SAVED_VERSION}.`);
  const blocksLength = pre.getUint32(8, true);
  const tableLength = pre.getUint32(12, true);
  const decoder = new TextDecoder();
  const blocks = JSON.parse(decoder.decode(await file.slice(SAVED_PREAMBLE, SAVED_PREAMBLE + blocksLength).arrayBuffer()));
  const dataAt = SAVED_PREAMBLE + blocksLength + tableLength;
  const table = blocksOnly ? null : JSON.parse(decoder.decode(await file.slice(SAVED_PREAMBLE + blocksLength, dataAt).arrayBuffer()));
  return { blocks, table, dataAt };
}

/** Maximum byte span coalesced into a single file slice read. */
const READ_WINDOW = 16 * 1024 * 1024;

/**
 * Open a document's base records file and optional incremental work file for paged reading.
 * @param {Blob} records
 * @param {?Blob} [work]
 */
export async function openSavedDoc(records, work = null) {
  const base = await readSavedHead(records);
  const top = work ? await readSavedHead(work) : null;
  const baseTable = /** @type {SavedTable} */ (base.table);
  const topTable = top ? /** @type {SavedTable} */ (top.table) : baseTable;

  /**
   * @param {Blob} file
   * @param {SavedTable} table
   * @param {number} dataAt
   * @returns {Array<?SavedSlot>}
   */
  const slotsOf = (file, table, dataAt) => {
    const rows = table.pages || [];
    let restAt = dataAt;
    for (const row of rows) {
      if (Array.isArray(row)) restAt += row[0];
    }
    let recordAt = dataAt;
    return rows.map((row, n) => {
      if (!Array.isArray(row)) return null;
      const slot = {
        file, row, recordAt, restAt, key: file === records ? n : row[9],
      };
      recordAt += row[0];
      restAt += row[1] + row[2] + row[3];
      return slot;
    });
  };
  const baseSlots = slotsOf(records, baseTable, base.dataAt);
  /** @type {Array<?SavedSlot>} */
  let slots = baseSlots;
  if (top && topTable.pages) {
    const own = slotsOf(/** @type {Blob} */ (work), topTable, top.dataAt);
    /**
     * Per-page source index in the original document.
     * @type {?Array<?number>}
     */
    const sources = top.blocks.session?.pageSourceIndices ?? base.blocks.session?.pageSourceIndices ?? null;
    slots = topTable.pages.map((row, n) => {
      if (typeof row === 'number') return baseSlots[row];
      const saved = own[n];
      // When a standalone work file predates ingest, point pages that match the new base records file at baseSlots so the next save stores them by index.
      const same = saved && topTable.layer === baseTable.layer ? baseSlots[sources?.[n] ?? n] : null;
      return same && same.row.every((field, k) => field === saved.row[k]) ? same : saved;
    });
  }

  return {
    /** Document-level blocks merged from the base records file and optional work file. */
    blocks: top ? { ...base.blocks, ...top.blocks, session: { ...base.blocks.session, ...top.blocks.session } } : base.blocks,
    /** Unmerged document-level blocks from the base records file. */
    baseBlocks: base.blocks,
    layer: topTable.layer,
    /** Number of pages in the base records file. */
    basePages: baseSlots.length,
    slots,
    /**
     * Read a run of the document's pages.
     * @param {number} from
     * @param {number} to - One past the last page.
     * @param {boolean} detail - Read each page's detail record, detail order and extras with its page record.
     * @returns {Promise<Array<?SavedPage>>}
     */
    async read(from, to, detail) {
      /** @type {Array<?SavedPage>} */
      const pages = [];
      /** @type {Map<Blob, Array<{at: number, length: number, page: SavedPage, part: 'record'|'detail'|'order'|'extras'}>>} */
      const spans = new Map();
      for (let n = from; n < to; n++) {
        const slot = slots[n];
        if (!slot) {
          pages.push(null);
          continue;
        }
        const { row } = slot;
        /** @type {SavedPage} */
        const page = {
          record: new Uint8Array(0),
          detail: null,
          order: null,
          extras: null,
          flags: row[4],
          counts: { words: row[5], nativeWords: row[6], textSource: row[7] },
          angle: row[8],
        };
        pages.push(page);
        let list = spans.get(slot.file);
        if (!list) {
          list = [];
          spans.set(slot.file, list);
        }
        list.push({
          at: slot.recordAt, length: row[0], page, part: 'record',
        });
        if (!detail) continue;
        if (row[1]) {
          list.push({
            at: slot.restAt, length: row[1], page, part: 'detail',
          });
        }
        if (row[2]) {
          list.push({
            at: slot.restAt + row[1], length: row[2], page, part: 'order',
          });
        }
        if (row[3]) {
          list.push({
            at: slot.restAt + row[1] + row[2], length: row[3], page, part: 'extras',
          });
        }
      }
      for (const [file, list] of spans) {
        list.sort((a, b) => a.at - b.at);
        for (let i = 0; i < list.length;) {
          let j = i + 1;
          let end = list[i].at + list[i].length;
          while (j < list.length && list[j].at <= end + 65536 && list[j].at + list[j].length - list[i].at <= READ_WINDOW) {
            end = Math.max(end, list[j].at + list[j].length);
            j++;
          }
          const stretch = new Uint8Array(await file.slice(list[i].at, end).arrayBuffer());
          if (stretch.length < end - list[i].at) throw new Error('The saved file is shorter than its page table says.');
          for (let k = i; k < j; k++) {
            const span = list[k];
            // Copy each span into its own buffer so retained page and detail records do not pin the whole stretch in memory.
            const bytes = stretch.slice(span.at - list[i].at, span.at - list[i].at + span.length);
            if (span.part === 'record') span.page.record = bytes;
            else if (span.part === 'detail') span.page.detail = bytes;
            else if (span.part === 'order') span.page.order = new Int32Array(new Uint8Array(inflateRecord(bytes)).buffer);
            else span.page.extras = JSON.parse(new TextDecoder().decode(bytes));
          }
          i = j;
        }
      }
      return pages;
    },
  };
}
