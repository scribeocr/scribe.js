import { scribeEnvelope, scribeSegmentHeader } from './export.js';
import { deflateRecord } from '../containers/pageStore.js';
import { SAVED_MAGIC, SAVED_PREAMBLE, SAVED_VERSION } from '../containers/savedDoc.js';
import { crc32 } from '../utils/byteStream.js';

/**
 * Serialize a document's metadata blocks and active-layer page records into the document-library binary format.
 * Writes an incremental work file against the base records file when `doc` was opened from saved files, or a full base records file otherwise.
 * @param {import('../containers/scribeDoc.js').ScribeDoc} doc
 * @returns {Promise<{parts: Array<Uint8Array>, textChanged: boolean}>} File byte chunks, with `textChanged` true when page records, page order, or layer differ from the prior saved state.
 */
export async function writeSavedDoc(doc) {
  const { active } = doc.pageStore;
  // Save any non-'pdf' active layer under 'User Upload' so reopen treats recognized and imported layers uniformly.
  let layer = active;
  if (active !== null && active !== 'pdf') layer = 'User Upload';
  const pageCount = active === null ? 0 : doc.pageStore.slotCount(active);
  const envelope = scribeEnvelope(doc, true, active);
  const header = { ...scribeSegmentHeader(envelope, pageCount), tableLinks: doc.tableLinkSuggestions };
  const prior = doc._saved;
  const saved = prior && prior.layer === layer ? prior : null;
  const baseBlocks = prior ? prior.baseBlocks : {};
  const encoder = new TextEncoder();

  /** @type {Record<string, unknown>} */
  const blocks = {};
  for (const [name, value] of Object.entries(header)) {
    if (name !== 'session' && JSON.stringify(value) !== JSON.stringify(baseBlocks[name])) blocks[name] = value ?? null;
  }
  /** @type {Record<string, unknown>} */
  const session = {};
  for (const [name, value] of Object.entries(header.session || {})) {
    if (JSON.stringify(value) !== JSON.stringify(baseBlocks.session?.[name])) session[name] = value ?? null;
  }
  if (Object.keys(session).length) blocks.session = session;

  /** @type {Array<?number|import('../containers/savedDoc.js').SavedRow>} */
  const rows = [];
  /** @type {Array<?number|string>} */
  const keys = [];
  /** @type {Array<Uint8Array>} */
  const records = [];
  /** @type {Array<Uint8Array>} */
  const rest = [];
  let asRecorded = !!saved && pageCount === saved.basePages;
  for (let n = 0; n < pageCount; n++) {
    const made = doc.pageStore.recordsOf(n, /** @type {string} */ (active));
    if (!made) {
      rows.push(null);
      keys.push(null);
      asRecorded = false;
      continue;
    }
    const known = saved ? saved.keyOf.get(made.record) : undefined;
    if (typeof known === 'number') {
      rows.push(known);
      keys.push(known);
      if (known !== n) asRecorded = false;
      continue;
    }
    asRecorded = false;
    /** @type {NonNullable<import('../containers/savedDoc.js').SavedPage['extras']>} */
    const extras = {};
    // The 'pdf' layer already stores native-text entries and fill shapes in made.detail.
    if (layer !== 'pdf') {
      const nativeText = envelope.session.nativeText[n];
      if (nativeText && Object.keys(nativeText).length) extras.nativeText = nativeText;
      const fillShapes = envelope.session.fillShapes[n];
      if (fillShapes) extras.fillShapes = fillShapes;
    }
    if (envelope.session.truth?.[n]) extras.truth = envelope.session.truth[n];
    if (envelope.session.hocrSource?.pages[n]) extras.hocrSource = envelope.session.hocrSource.pages[n];
    const extrasBytes = Object.keys(extras).length ? encoder.encode(JSON.stringify(extras)) : null;
    const record = made.record.deflated ? made.record.bytes : await deflateRecord(made.record.bytes);
    let detail = null;
    if (made.detail) detail = made.detail.deflated ? made.detail.bytes : await deflateRecord(made.detail.bytes);
    const order = made.order ? await deflateRecord(new Uint8Array(made.order.buffer, made.order.byteOffset, made.order.byteLength)) : null;
    const key = known ?? `${crc32(record).toString(36)}.${record.length}`;
    rows.push([
      record.length, detail ? detail.length : 0, order ? order.length : 0, extrasBytes ? extrasBytes.length : 0,
      made.flags, made.counts.words, made.counts.nativeWords, made.counts.textSource ?? null, doc.pageMetrics[n]?.angle ?? null, key,
    ]);
    keys.push(key);
    records.push(record);
    if (detail) rest.push(detail);
    if (order) rest.push(order);
    if (extrasBytes) rest.push(extrasBytes);
  }

  const blocksBytes = encoder.encode(JSON.stringify(blocks));
  const tableBytes = encoder.encode(JSON.stringify({ layer, pages: asRecorded ? null : rows }));
  const preamble = new Uint8Array(SAVED_PREAMBLE);
  const view = new DataView(preamble.buffer);
  view.setUint32(0, SAVED_MAGIC, true);
  view.setUint32(4, SAVED_VERSION, true);
  view.setUint32(8, blocksBytes.length, true);
  view.setUint32(12, tableBytes.length, true);

  const textChanged = !saved || saved.keys.length !== keys.length || keys.some((key, n) => key !== saved.keys[n]);
  doc._saved = {
    layer, keys, keyOf: saved ? saved.keyOf : new Map(), baseBlocks, basePages: prior ? prior.basePages : -1,
  };
  return { parts: [preamble, blocksBytes, tableBytes, ...records, ...rest], textChanged };
}
