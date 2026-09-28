import { bboxToPageSpace } from './addHighlights.js';
import { pageImagePlacements, pagePathPlacements } from './fillSign.js';
import { ensureGlyphSetForText } from './fontContainerMain.js';
import ocr, { OcrWord, OcrChar } from './objects/ocrObjects.js';
import { getRandomAlphanum } from './utils/miscUtils.js';

/** @typedef {import('./containers/scribeDoc.js').ScribeDoc} ScribeDoc */
/** @typedef {import('./objects/ocrObjects.js').OcrLine} OcrLine */
/** @typedef {import('./objects/ocrObjects.js').OcrPage} OcrPage */

/**
 * Snapshot a line for undo.
 * A restored clone gets `page` re-attached but keeps `par` null.
 * Paragraphs are derived state and are not re-derived here.
 * @param {OcrLine} line
 */
function snapshotLine(line) {
  const { page, par } = line;
  line.page = null;
  line.par = null;
  try {
    return structuredClone(line);
  } finally {
    line.page = page;
    line.par = par;
  }
}

/**
 * Remove word markup (highlights, underlines, strikethroughs) sitting on the given word boxes.
 * Returns the removed annotations with their original indices, ascending, so undo can re-splice them.
 * @param {ScribeDoc} doc
 * @param {number} n
 * @param {Array<bbox>} wordBoxes - Page-space boxes of the removed words.
 * @returns {Array<{index: number, record: Annotation}>}
 */
function removeMarkupOnBoxes(doc, n, wordBoxes) {
  /** @type {Array<{index: number, record: Annotation}>} */
  const annots = [];
  const pageAnnots = doc.annotations?.pages?.[n];
  if (!pageAnnots) return annots;
  for (let i = pageAnnots.length - 1; i >= 0; i--) {
    const a = pageAnnots[i];
    if (a.type !== 'highlight' && a.type !== 'underline' && a.type !== 'strikeout') continue;
    const ab = a.bbox;
    const aArea = Math.max(0, ab.right - ab.left) * Math.max(0, ab.bottom - ab.top);
    if (!(aArea > 0)) continue;
    let overlap = 0;
    for (const wb of wordBoxes) {
      const w = Math.min(ab.right, wb.right) - Math.max(ab.left, wb.left);
      const h = Math.min(ab.bottom, wb.bottom) - Math.max(ab.top, wb.top);
      if (w > 0 && h > 0) overlap += w * h;
      if (overlap >= 0.6 * aArea) break;
    }
    if (overlap >= 0.6 * aArea) {
      annots.push({ index: i, record: a });
      pageAnnots.splice(i, 1);
    }
  }
  annots.reverse();
  return annots;
}

/**
 * The page's native-text entries, keyed by word id.
 * A word with an entry is editable.
 * @param {ScribeDoc} doc
 * @param {?OcrPage} page
 * @returns {Record<string, NativeTextWord>}
 */
export function nativeTextForPage(doc, page) {
  if (!page || page.textSource !== 'pdf') return {};
  return doc.nativeText.pages[page.n] || {};
}

/**
 * The line of `doc` that holds a line handle's words.
 * The handle need not sit in the doc's page, e.g. a line of another document parsed from the same file, or one an undo replaced with a restored copy.
 * @param {ScribeDoc} doc
 * @param {?OcrLine} line
 * @returns {?OcrLine}
 */
function liveLineFor(doc, line) {
  if (!line || !line.page || !line.words || line.words.length === 0) return null;
  const page = doc.ocr.active[line.page.n];
  if (!page) return null;
  if (page.lines.includes(line)) return line;
  const ids = new Set(line.words.map((w) => w.id));
  return page.lines.find((l) => l.words.some((w) => ids.has(w.id))) || null;
}

/**
 * Splice the records an edit folded out of a page's list, append the edit's records, and return the folded ones with their positions, for undo.
 * @param {ScribeDoc} doc
 * @param {number} n
 * @param {Array<TextPatch>} records
 * @param {string[]} [foldedIds]
 */
function installRecords(doc, n, records, foldedIds) {
  const recs = doc.contentEdits.pages[n] || (doc.contentEdits.pages[n] = []);
  /** @type {Array<{index: number, record: ContentEdit}>} */
  const replaced = [];
  for (let ri = recs.length - 1; ri >= 0; ri--) {
    if (foldedIds && foldedIds.includes(recs[ri].id)) {
      replaced.push({ index: ri, record: recs[ri] });
      recs.splice(ri, 1);
    }
  }
  replaced.reverse();
  for (const rec of records) recs.push(rec);
  return replaced;
}

/**
 * Deletes whole lines of visible native PDF text.
 * The lines' words are also removed from `doc.ocr.active`.
 * Records one undoable step in `doc.contentEditHistory`.
 * Every page's rewrite is in hand before any page changes, so an error from any page's rewrite leaves the document as it was.
 * @param {ScribeDoc} doc
 * @param {Array<OcrLine>} lines - Lines of `doc.ocr.active` pages, or handles whose words those pages' lines carry.
 * @param {string} [label] - Description of the edit for the undo timeline.
 * @returns {Promise<{pages: Array<number>, groupId: string, refused?: Array<{page: number, reason: string}>}>}
 *   The pages changed and the action's group id, empty when no page changed.
 *   `refused` lists the pages whose deletion the worker refused, with the reason for each.
 *   Those pages are left as they were.
 */
export async function deleteTextLines(doc, lines, label = 'Deleted text') {
  /** @type {Map<number, Array<OcrLine>>} */
  const byPage = new Map();
  for (const lineIn of lines) {
    if (!lineIn || !lineIn.page || !lineIn.words || lineIn.words.length === 0) continue;
    const line = liveLineFor(doc, lineIn);
    if (!line) throw new Error('deleteTextLines: not a live line.');
    const nt = nativeTextForPage(doc, line.page);
    for (const w of line.words) {
      if (!nt[w.id]) throw new Error(`deleteTextLines: word "${w.text}" (${w.id}) is not visible native text.`);
      if (nt[w.id].uneditable) throw new Error(`deleteTextLines: word "${w.text}" (${w.id}) is native text that is not editable (a Type 3 font or vertical writing).`);
    }
    const n = line.page.n;
    if (!byPage.has(n)) byPage.set(n, []);
    byPage.get(n).push(line);
  }
  if (byPage.size === 0) return { pages: [], groupId: '' };

  const groupId = getRandomAlphanum(10);
  const results = await Promise.all([...byPage].map(([n, pageLines]) => {
    const nt = nativeTextForPage(doc, pageLines[0].page);
    /** @type {Array<TextEditWordSpec>} */
    const specs = [];
    let count = 0;
    for (const line of pageLines) {
      for (const w of line.words) {
        count += 1;
        const e = nt[w.id];
        if (e.penX) {
          specs.push({
            id: w.id, text: w.text, penX: e.penX, baselineY: e.baselineY,
          });
        }
      }
    }
    return specs.length === count
      ? doc.images.applyTextEdit(n, { kind: 'delete', words: specs }, groupId)
      : Promise.resolve(/** @type {TextEditResult} */ ({ refused: 'A word has no recorded pens.' }));
  }));

  /** @type {Array<object>} */
  const entryPages = [];
  /** @type {Array<{page: number, reason: string}>} */
  const refused = [];
  let k = 0;
  let sliceLeft = 20;
  for (const [n, pageLines] of byPage) {
    const res = results[k];
    k += 1;
    if (!res.records) {
      refused.push({ page: n, reason: res.refused || 'The edit changes nothing.' });
      continue;
    }
    if (sliceLeft === 0) {
      sliceLeft = 20;
      await new Promise((r) => { setTimeout(r, 0); });
    }
    sliceLeft -= 1;
    const page = pageLines[0].page;
    const nt = nativeTextForPage(doc, page);
    const ntBefore = structuredClone(doc.nativeText.pages[n] || {});
    /** @type {Array<string>} */
    const wordIds = [];
    /** @type {Array<{index: number, snap: OcrLine}>} */
    const lineSnaps = [];
    /** @type {Array<bbox>} */
    const deletedWordBoxes = [];
    for (const line of pageLines) {
      for (const w of line.words) {
        wordIds.push(w.id);
        deletedWordBoxes.push(bboxToPageSpace(w.bbox, line.orientation, page.dims));
      }
      lineSnaps.push({ index: page.lines.indexOf(line), snap: snapshotLine(line) });
    }
    const deletedIdSet = new Set(wordIds);
    // A twin's id comes from the worker's re-parse, whose positional ids need not match the live page's, so twins are matched by pens.
    const twinLines = new Set();
    for (const t of res.twins || []) {
      for (const line of page.lines) {
        if (pageLines.includes(line)) continue;
        for (const w of line.words) {
          const e = nt[w.id];
          if (!e || !e.penX || e.penX.length !== t.penX.length || deletedIdSet.has(w.id)) continue;
          if (Math.abs(e.baselineY - t.baselineY) > 0.0015 || e.penX.some((v, i) => Math.abs(v - t.penX[i]) > 0.0015)) continue;
          wordIds.push(w.id);
          deletedIdSet.add(w.id);
          deletedWordBoxes.push(bboxToPageSpace(w.bbox, line.orientation, page.dims));
          if (!twinLines.has(line)) {
            twinLines.add(line);
            lineSnaps.push({ index: page.lines.indexOf(line), snap: snapshotLine(line) });
          }
        }
      }
    }
    const annots = removeMarkupOnBoxes(doc, n, deletedWordBoxes);
    lineSnaps.sort((a, b) => a.index - b.index);
    const replacedRecords = installRecords(doc, n, res.records, res.foldedIds);
    ocr.deletePageWords(page, wordIds.slice());
    const ntPage = doc.nativeText.pages[n];
    if (ntPage) for (const id of wordIds) delete ntPage[id];
    const ntAfter = structuredClone(doc.nativeText.pages[n] || {});
    entryPages.push({
      n, records: res.records, wordIds, lineSnaps, annots, replacedRecords, ntBefore, ntAfter,
    });
  }
  if (entryPages.length > 0) doc.contentEditHistory.record({ pages: entryPages }, label);
  /** @type {{pages: Array<number>, groupId: string, refused?: Array<{page: number, reason: string}>}} */
  const out = { pages: entryPages.map((p) => p.n), groupId: entryPages.length > 0 ? groupId : '' };
  if (refused.length > 0) out.refused = refused;
  return out;
}

export { FAUX_BOLD_STROKE_EM, FAUX_OBLIQUE_SKEW } from './pdf/textPatch.js';

/**
 * Replace a line's text with `newText`.
 * Records one undoable step in `doc.contentEditHistory`.
 * @param {ScribeDoc} doc
 * @param {OcrLine} lineIn - A line of a `doc.ocr.active` page, or a handle whose words that page's line carries.
 * @param {string} newText - The line's replacement text; empty deletes the line.
 * @param {{wordStyles?: Array<?{bold?: boolean, italic?: boolean, color?: string}>}} [opts] - Per-word style toggles, index-aligned with the whitespace-split words of `newText`.
 *   Null entries inherit.
 *   `color` is the word's new ink as `#rrggbb`.
 *   A toggle a word already has, by its font or by an earlier edit, changes nothing.
 * @returns {Promise<?{pages: Array<number>, groupId: string} | {refused: string}>} The page changed and the action's group id, or null when the edit changes nothing.
 *   `refused` carries the reason when the page cannot be rewritten safely.
 *   The words are then left as the page drew them.
 */
export async function replaceTextLine(doc, lineIn, newText, opts) {
  const line = liveLineFor(doc, lineIn);
  if (!line) throw new Error('replaceTextLine: not a live line.');
  const nt = nativeTextForPage(doc, line.page);
  for (const w of line.words) {
    if (!nt[w.id]) throw new Error(`replaceTextLine: word "${w.text}" (${w.id}) is not visible native text.`);
    if (nt[w.id].uneditable) throw new Error(`replaceTextLine: word "${w.text}" (${w.id}) is native text that is not editable (a Type 3 font or vertical writing).`);
  }
  const newTexts = String(newText).trim().split(/\s+/).filter((t) => t.length > 0);
  if (newTexts.length === 0) {
    const deleted = await deleteTextLines(doc, [line]);
    return deleted.refused ? { refused: deleted.refused[0].reason } : { pages: deleted.pages, groupId: deleted.groupId };
  }
  // Awaited, so a character typed faster than the wider set downloads is never committed as a tofu box.
  await ensureGlyphSetForText(newText);
  const wordStylesIn = opts?.wordStyles || null;
  const styles = newTexts.map((t, m) => {
    const ov = wordStylesIn?.[m];
    if (!ov) return null;
    /** @type {{ color?: string, bold?: boolean, italic?: boolean }} */
    const st = {};
    if (typeof ov.color === 'string' && /^#[0-9a-f]{6}$/i.test(ov.color)) st.color = ov.color.toLowerCase();
    if (ov.bold !== undefined) st.bold = ov.bold;
    if (ov.italic !== undefined) st.italic = ov.italic;
    return Object.keys(st).length > 0 ? st : null;
  });
  const oldWords = line.words.slice();
  if (newTexts.length === oldWords.length && newTexts.every((t, m) => t === oldWords[m].text) && styles.every((st) => !st)) return null;
  if (oldWords.some((w) => !nt[w.id].penX)) return { refused: 'A word has no recorded pens.' };

  const page = line.page;
  const n = page.n;
  const ntBefore = structuredClone(doc.nativeText.pages[n] || {});
  const groupId = getRandomAlphanum(10);
  const res = await doc.images.applyTextEdit(n, {
    kind: 'replace',
    words: oldWords.map((w) => ({
      id: w.id, text: w.text, penX: /** @type {number[]} */ (nt[w.id].penX), baselineY: nt[w.id].baselineY,
    })),
    newTexts,
    styles,
  }, groupId);
  if (res.unchanged) return null;
  if (!res.records || !res.lineWords) return { refused: res.refused || 'The worker returned no records.' };

  const lineIndex = page.lines.indexOf(line);
  const lineSnaps = [{ index: lineIndex, snap: snapshotLine(line) }];
  const replacedRecords = installRecords(doc, n, res.records, res.foldedIds);
  const byId = new Map(oldWords.map((w) => [w.id, w]));
  /** @type {Array<OcrWord>} */
  const nextWords = [];
  res.lineWords.forEach((lw, li) => {
    let word = lw.oldId ? byId.get(lw.oldId) : undefined;
    if (!word) {
      const neighbors = [...res.lineWords.slice(0, li).reverse(), ...res.lineWords.slice(li + 1)];
      const donor = neighbors.map((x) => (x.oldId ? byId.get(x.oldId) : undefined)).find((x) => x) || oldWords[0];
      word = new OcrWord(line, getRandomAlphanum(10), lw.text, lw.bbox);
      word.conf = donor.conf;
      word.visualCoords = false;
    }
    word.text = lw.text;
    word.bbox = lw.bbox;
    word.chars = lw.chars.map((c) => new OcrChar(c.text, c.bbox));
    word.style = { ...word.style, ...lw.style };
    word.lang = lw.lang;
    word.styleRuns = undefined;
    word.line = line;
    nextWords.push(word);
  });
  const removedWordBoxes = oldWords.filter((w) => !nextWords.includes(w)).map((w) => bboxToPageSpace(w.bbox, line.orientation || 0, page.dims));
  line.words = nextWords;
  ocr.updateLineBbox(line);
  const annots = removeMarkupOnBoxes(doc, n, removedWordBoxes);
  const ntPage = doc.nativeText.pages[n] || (doc.nativeText.pages[n] = {});
  for (const w of oldWords) { if (!nextWords.includes(w)) delete ntPage[w.id]; }
  res.lineWords.forEach((lw, li) => { ntPage[nextWords[li].id] = lw.entry; });
  const ntAfter = structuredClone(ntPage);
  const lineAfterSnaps = [{ index: lineIndex, snap: snapshotLine(line) }];
  const sweepIds = [...new Set([...oldWords.map((w) => w.id), ...nextWords.map((w) => w.id)])];
  doc.contentEditHistory.record({
    pages: [{
      n, records: res.records, lineSnaps, lineAfterSnaps, sweepIds, annots, replacedRecords, ntBefore, ntAfter,
    }],
  }, 'Edited text');
  return { pages: [n], groupId };
}

/**
 * Delete the image and path placements whose extents match the given rects, as one undoable action.
 * @param {ScribeDoc} doc
 * @param {Array<{n: number, rect: bbox, kind: 'image'|'path'}>} items - Placement extents to delete, page-pixel frame.
 * @returns {?{pages: Array<number>}} Affected page indices, or null when no placement matches.
 */
export function deleteGraphics(doc, items) {
  const pad = 2;
  const groupId = getRandomAlphanum(10);
  /** @type {Array<{n: number, record: ImageEditDelete|PathEditDelete}>} */
  const pageRecords = [];
  for (const { n, rect, kind } of items) {
    const type = kind === 'path' ? 'deletePath' : 'deleteImage';
    if (pageRecords.some((p) => p.n === n && p.record.type === type && Math.abs(p.record.rect.left - rect.left) <= pad
      && Math.abs(p.record.rect.top - rect.top) <= pad && Math.abs(p.record.rect.right - rect.right) <= pad
      && Math.abs(p.record.rect.bottom - rect.bottom) <= pad)) continue;
    const placements = kind === 'path' ? pagePathPlacements(doc, n) : pageImagePlacements(doc, n);
    const picked = placements.filter((e) => Math.abs(e.left - rect.left) <= pad && Math.abs(e.top - rect.top) <= pad
      && Math.abs(e.right - rect.right) <= pad && Math.abs(e.bottom - rect.bottom) <= pad);
    if (picked.length === 0) continue;
    /** @type {ImageEditDelete|PathEditDelete} */
    const record = {
      type,
      id: getRandomAlphanum(10),
      rect: {
        left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
      },
      sites: picked.flatMap((e) => e.sites.map((s) => ({ ...s }))),
      groupId,
    };
    if (!doc.contentEdits.pages[n]) doc.contentEdits.pages[n] = [];
    doc.contentEdits.pages[n].push(record);
    pageRecords.push({ n, record });
  }
  if (pageRecords.length === 0) return null;
  const kinds = new Set(pageRecords.map((p) => p.record.type));
  const graphicsLabel = kinds.size > 1 ? 'Deleted graphics'
    : (kinds.has('deleteImage')
      ? (pageRecords.length === 1 ? 'Deleted image' : 'Deleted images')
      : (pageRecords.length === 1 ? 'Deleted graphic' : 'Deleted graphics'));
  doc.contentEditHistory.record({ groupId, pages: pageRecords }, graphicsLabel);
  return { pages: [...new Set(pageRecords.map((p) => p.n))] };
}

/**
 * Delete the image placements whose merged extents match the given rects, as one undoable action.
 * @param {ScribeDoc} doc
 * @param {Array<{n: number, rect: bbox}>} items - Placement extents to delete, page-pixel frame.
 * @returns {?{pages: Array<number>}} Affected page indices, or null when no placement matches.
 */
export function deleteImages(doc, items) {
  return deleteGraphics(doc, items.map((it) => ({ n: it.n, rect: it.rect, kind: /** @type {'image'} */ ('image') })));
}

/**
 * Bounded undo/redo for content edits (native text, images, and paths).
 * Page structure ops have a separate `PageHistory`.
 * Its snapshots carry the record arrays, so content-edit records survive page undo/redo.
 */
export class ContentEditHistory {
  static LIMIT = 100;

  /** @param {ScribeDoc} doc */
  constructor(doc) {
    this.doc = doc;
    /** @type {Array<object>} */
    this.undoStack = [];
    /** @type {Array<object>} */
    this.redoStack = [];
  }

  /**
   * Record one content edit as an undoable step.
   * @param {object} entry
   * @param {string} [label] - Description of the edit for the undo timeline, e.g. "Deleted image".
   */
  record(entry, label = 'Edited content') {
    this.undoStack.push(entry);
    if (this.undoStack.length > ContentEditHistory.LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    this.doc.docHistory.record({
      surface: 'content',
      label,
      undo: () => this.undo(),
      redo: () => this.redo(),
    });
  }

  /**
   * Undo the last content-edit action.
   * @returns {?Array<number>} Affected page indices, or null when nothing was undone.
   */
  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    for (const p of entry.pages) {
      if (p.record?.type === 'deleteImage' || p.record?.type === 'deletePath') {
        const imgRecs = this.doc.contentEdits.pages[p.n];
        if (imgRecs) {
          const idx = imgRecs.findIndex((r) => r && r.id === p.record.id);
          if (idx !== -1) imgRecs.splice(idx, 1);
        }
        continue;
      }
      const recs = this.doc.contentEdits.pages[p.n];
      if (recs) {
        for (const rec of p.records || [p.record]) {
          const idx = recs.findIndex((r) => r && r.id === rec.id);
          if (idx !== -1) recs.splice(idx, 1);
        }
        if (p.replacedRecords) {
          // Ascending indices, so each re-splice lands where the record originally sat.
          for (const { index, record } of p.replacedRecords) recs.splice(Math.min(index, recs.length), 0, record);
        }
      }
      const page = this.doc.ocr.active[p.n];
      if (!page) continue;
      // A co-deleted line can survive in shrunken form (only its overlapping words were removed), and a replaced line holds the after-edit words.
      // Both must go before the before-snapshots are spliced back, or undo would leave both copies on the page.
      const snapWordIds = new Set();
      for (const { snap } of p.lineSnaps) for (const w of snap.words) snapWordIds.add(w.id);
      for (const id of p.sweepIds || []) snapWordIds.add(id);
      for (let i = page.lines.length - 1; i >= 0; i--) {
        if (page.lines[i].words.some((w) => snapWordIds.has(w.id))) page.lines.splice(i, 1);
      }
      for (const { index, snap } of p.lineSnaps) {
        // The snapshot is reused on later undo/redo cycles, so installing it directly would let live-page mutations corrupt the stored copy.
        const restored = structuredClone(snap);
        restored.page = page;
        page.lines.splice(Math.min(index, page.lines.length), 0, restored);
      }
      if (p.ntBefore) this.doc.nativeText.pages[p.n] = structuredClone(p.ntBefore);
      const pageAnnots = this.doc.annotations?.pages?.[p.n];
      if (pageAnnots && p.annots) {
        for (const { index, record } of p.annots) {
          pageAnnots.splice(Math.min(index, pageAnnots.length), 0, record);
        }
      }
    }
    this.redoStack.push(entry);
    return entry.pages.map((p) => p.n);
  }

  /**
   * Re-apply the last undone content-edit action.
   * @returns {?Array<number>} Affected page indices, or null when nothing was redone.
   */
  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    for (const p of entry.pages) {
      if (!this.doc.contentEdits.pages[p.n]) this.doc.contentEdits.pages[p.n] = [];
      const recs = this.doc.contentEdits.pages[p.n];
      if (p.record?.type === 'deleteImage' || p.record?.type === 'deletePath') {
        recs.push(p.record);
        continue;
      }
      if (p.replacedRecords) {
        for (const { record } of p.replacedRecords) {
          const idx = recs.findIndex((r) => r && r.id === record.id);
          if (idx !== -1) recs.splice(idx, 1);
        }
      }
      for (const rec of p.records || [p.record]) recs.push(rec);
      const page = this.doc.ocr.active[p.n];
      if (page) {
        if (p.lineAfterSnaps?.length) {
          const sweep = new Set(p.sweepIds || []);
          for (let i = page.lines.length - 1; i >= 0; i--) {
            if (page.lines[i].words.some((w) => sweep.has(w.id))) page.lines.splice(i, 1);
          }
          for (const { index, snap } of p.lineAfterSnaps) {
            const restored = structuredClone(snap);
            restored.page = page;
            page.lines.splice(Math.min(index, page.lines.length), 0, restored);
          }
        }
        if (p.wordIds) ocr.deletePageWords(page, p.wordIds.slice());
      }
      if (p.ntAfter) this.doc.nativeText.pages[p.n] = structuredClone(p.ntAfter);
      const pageAnnots = this.doc.annotations?.pages?.[p.n];
      if (pageAnnots && p.annots) {
        for (const { record } of p.annots) {
          const idx = pageAnnots.indexOf(record);
          if (idx !== -1) pageAnnots.splice(idx, 1);
        }
      }
    }
    this.undoStack.push(entry);
    return entry.pages.map((p) => p.n);
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
