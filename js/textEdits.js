import { bboxToPageSpace } from './addHighlights.js';
import { pageImagePlacements, pagePathPlacements } from './fillSign.js';
import { ensureGlyphSetForText } from './fontContainerMain.js';
import ocr, { OcrWord, OcrChar } from './objects/ocrObjects.js';
import { getRandomAlphanum } from './utils/miscUtils.js';
import { EDIT_FACE_FAMILIES, EDIT_FACE_FAMILY_NAMES } from './pdf/textPatch.js';

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
 * Return the page's native-text entries, keyed by word ID, for read-only access.
 * @param {ScribeDoc} doc
 * @param {?OcrPage} page
 * @returns {Record<string, NativeTextWord>}
 */
export function nativeTextForPage(doc, page) {
  if (!page || page.textSource !== 'pdf') return {};
  // Read via pageStore.extras(n, false) because indexing doc.nativeText.pages marks the 'pdf' page modified and drops its cached record.
  const extras = doc.pageStore.extras(page.n, false);
  return (extras ? extras.nativeText : doc.nativeText.pages[page.n]) || {};
}

/**
 * A word's drawn box in page space.
 * @param {ScribeDoc} doc
 * @param {OcrWord} word
 * @returns {{left: number, right: number, top: number, bottom: number}}
 */
export function wordDrawBox(doc, word) {
  const nt = nativeTextForPage(doc, word.line.page);
  const base = nt[word.id]?.baselineY ?? (word.line.bbox.bottom + (word.line.baseline?.[1] || 0));
  const size = word.style.size || Math.abs(word.bbox.bottom - word.bbox.top) / 0.75;
  return {
    left: word.bbox.left, right: word.bbox.right, top: base - 0.75 * size, bottom: base + 0.25 * size,
  };
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
  const page = doc.pageStore.readOnlyPage(line.page.n);
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
 * Delete whole lines of visible native PDF text.
 * @param {ScribeDoc} doc
 * @param {Array<OcrLine|{n: number, id: string}>} lines - Active-layer `OcrLine` objects, `{ page, words }` word-ID wrappers, or 0-based `{ n, id }` line references.
 * @param {string} [label] - Description of the edit for the undo timeline.
 * @returns {Promise<{pages: Array<number>, groupId: string, refused?: Array<{page: number, reason: string}>}>} Changed 0-based page indices and group ID, both empty when no page changed.
 */
export async function deleteTextLines(doc, lines, label = 'Deleted text') {
  /** @type {Map<number, Array<OcrLine|{n: number, id: string}>>} */
  const asked = new Map();
  for (const lineIn of lines) {
    if (!lineIn) continue;
    if (!('n' in lineIn) && (!lineIn.page || !lineIn.words || lineIn.words.length === 0)) continue;
    const n = 'n' in lineIn ? lineIn.n : lineIn.page.n;
    const pageAsked = asked.get(n);
    if (pageAsked) pageAsked.push(lineIn);
    else asked.set(n, [lineIn]);
  }
  /** @type {Map<number, {lines: Array<Array<string>>, specs: Array<TextEditWordSpec>, words: number}>} */
  const byPage = new Map();
  for (const [n, pageAsked] of asked) {
    doc.pageStore.held(() => {
      /** @type {{lines: Array<Array<string>>, specs: Array<TextEditWordSpec>, words: number}} */
      const kept = { lines: [], specs: [], words: 0 };
      /** @type {?Map<string, OcrLine>} */
      let lineById = null;
      for (const lineIn of pageAsked) {
        let line;
        if ('n' in lineIn) {
          if (!lineById) lineById = new Map((doc.pageStore.readOnlyPage(n)?.lines || []).map((l) => [l.id, l]));
          line = lineById.get(lineIn.id) || null;
        } else line = liveLineFor(doc, lineIn);
        if (!line) throw new Error('deleteTextLines: not a live line.');
        const nt = nativeTextForPage(doc, line.page);
        for (const w of line.words) {
          const e = nt[w.id];
          if (!e) throw new Error(`deleteTextLines: word "${w.text}" (${w.id}) is not visible native text.`);
          if (e.uneditable) throw new Error(`deleteTextLines: word "${w.text}" (${w.id}) is native text that is not editable (a Type 3 font, vertical writing, or a Form XObject drawn more than once).`);
          kept.words += 1;
          if (e.penX) {
            kept.specs.push({
              id: w.id, text: w.text, penX: e.penX, baselineY: e.baselineY,
            });
          }
        }
        kept.lines.push(line.words.map((w) => w.id));
      }
      byPage.set(n, kept);
    });
  }
  if (byPage.size === 0) return { pages: [], groupId: '' };

  const groupId = getRandomAlphanum(10);
  const results = await Promise.all([...byPage].map(([n, kept]) => (kept.specs.length === kept.words
    ? doc.images.applyTextEdit(n, { kind: 'delete', words: kept.specs }, groupId)
    : Promise.resolve(/** @type {TextEditResult} */ ({ refused: 'A word has no recorded pens.' })))));

  /** @type {Array<object>} */
  const entryPages = [];
  /** @type {Array<{page: number, reason: string}>} */
  const refused = [];
  let k = 0;
  let sliceLeft = 20;
  for (const [n, kept] of byPage) {
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
    const entryPage = doc.pageStore.held(() => {
      const page = /** @type {OcrPage} */ (doc.getPage(n));
      const nt = nativeTextForPage(doc, page);
      /** @type {Map<string, OcrLine>} */
      const lineOfFirstWord = new Map();
      for (const line of page.lines) if (line.words.length > 0) lineOfFirstWord.set(line.words[0].id, line);
      /** @type {Array<OcrLine>} */
      const pageLines = [];
      for (const ids of kept.lines) {
        const line = lineOfFirstWord.get(ids[0]);
        if (!line || line.words.length !== ids.length || line.words.some((w, i) => w.id !== ids[i])) return null;
        pageLines.push(line);
      }
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
      const replacedRecords = installRecords(doc, n, /** @type {Array<TextPatch>} */ (res.records), res.foldedIds);
      ocr.deletePageWords(page, wordIds.slice());
      /** @type {Record<string, NativeTextWord>} */
      const ntRemoved = {};
      const ntPage = doc.nativeText.pages[n];
      if (ntPage) {
        for (const id of wordIds) {
          if (ntPage[id]) ntRemoved[id] = ntPage[id];
          delete ntPage[id];
        }
      }
      return {
        n, records: res.records, wordIds, lineSnaps, annots, replacedRecords, ntRemoved,
      };
    });
    if (entryPage) entryPages.push(entryPage);
    else refused.push({ page: n, reason: 'The page changed while its text was being deleted.' });
  }
  if (entryPages.length > 0) doc.contentEditHistory.record({ pages: entryPages }, label);
  /** @type {{pages: Array<number>, groupId: string, refused?: Array<{page: number, reason: string}>}} */
  const out = { pages: entryPages.map((p) => p.n), groupId: entryPages.length > 0 ? groupId : '' };
  if (refused.length > 0) out.refused = refused;
  return out;
}

export {
  FAUX_BOLD_STROKE_EM, FAUX_OBLIQUE_SKEW, EDIT_FACE_FAMILIES, EDIT_FACE_FAMILY_NAMES,
} from './pdf/textPatch.js';

/**
 * Replace a line of visible native PDF text with `newText`.
 * Records one undoable step in `doc.contentEditHistory`.
 * @param {ScribeDoc} doc
 * @param {OcrLine} lineIn - An active-layer `OcrLine`, or a `{ page, words }` wrapper whose word IDs match one.
 * @param {string} newText - Empty or whitespace-only text deletes the line.
 * @param {{wordStyles?: Array<?{bold?: boolean, italic?: boolean, color?: string, font?: string, fontObjNum?: number}>}} [opts] - Style overrides per whitespace-split word of `newText`.
 *   `color` takes a `#rrggbb` hex string.
 *   `font` names a family in `EDIT_FACE_FAMILIES`.
 *   `fontObjNum` selects an existing font on the page, unless `font` is also set.
 * @returns {Promise<?{pages: Array<number>, groupId: string} | {refused: string}>} Affected page and group ID, `{ refused }` if the edit cannot be applied, or `null` if unchanged.
 */
export async function replaceTextLine(doc, lineIn, newText, opts) {
  return doc.pageStore.held(async () => {
    const line = liveLineFor(doc, lineIn);
    if (!line) throw new Error('replaceTextLine: not a live line.');
    const nt = nativeTextForPage(doc, line.page);
    for (const w of line.words) {
      if (!nt[w.id]) throw new Error(`replaceTextLine: word "${w.text}" (${w.id}) is not visible native text.`);
      if (nt[w.id].uneditable) throw new Error(`replaceTextLine: word "${w.text}" (${w.id}) is native text that is not editable (a Type 3 font, vertical writing, or a Form XObject drawn more than once).`);
    }
    const newTexts = String(newText).trim().split(/\s+/).filter((t) => t.length > 0);
    if (newTexts.length === 0) {
      const deleted = await deleteTextLines(doc, [line]);
      return deleted.refused ? { refused: deleted.refused[0].reason } : { pages: deleted.pages, groupId: deleted.groupId };
    }
    await ensureGlyphSetForText(newText);
    const wordStylesIn = opts?.wordStyles || null;
    const styles = newTexts.map((t, m) => {
      const ov = wordStylesIn?.[m];
      if (!ov) return null;
      /** @type {{ color?: string, bold?: boolean, italic?: boolean, font?: string, fontObjNum?: number }} */
      const st = {};
      if (typeof ov.color === 'string' && /^#[0-9a-f]{6}$/i.test(ov.color)) st.color = ov.color.toLowerCase();
      if (ov.bold !== undefined) st.bold = ov.bold;
      if (ov.italic !== undefined) st.italic = ov.italic;
      if (typeof ov.font === 'string' && EDIT_FACE_FAMILIES.includes(ov.font)) st.font = ov.font;
      else if (Number.isInteger(ov.fontObjNum) && /** @type {number} */ (ov.fontObjNum) >= 0) st.fontObjNum = ov.fontObjNum;
      return Object.keys(st).length > 0 ? st : null;
    });
    const oldWords = line.words.slice();
    if (newTexts.length === oldWords.length) {
      styles.forEach((st, m) => {
        if (!st || newTexts[m] !== oldWords[m].text) return;
        const w = oldWords[m];
        if (st.bold !== undefined && !!w.style.bold === st.bold) delete st.bold;
        if (st.italic !== undefined && !!w.style.italic === st.italic) delete st.italic;
        // Keep st.font when bold or italic changes so the word is redrawn in the built-in font even if w.style.font matched a page font.
        if (st.font && st.bold === undefined && st.italic === undefined && w.style.font === EDIT_FACE_FAMILY_NAMES[st.font]) delete st.font;
        if (st.fontObjNum !== undefined && nt[w.id]?.fontObjNum === st.fontObjNum) delete st.fontObjNum;
        if (Object.keys(st).length === 0) styles[m] = null;
      });
    }
    if (newTexts.length === oldWords.length && newTexts.every((t, m) => t === oldWords[m].text) && styles.every((st) => !st)) return null;
    if (oldWords.some((w) => !nt[w.id].penX)) return { refused: 'A word has no recorded pens.' };

    const page = line.page;
    const n = page.n;
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
    if (doc.getPage(n) !== page || !page.lines.includes(line)) return { refused: 'The line changed while it was being edited.' };

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
    /** @type {Record<string, NativeTextWord>} */
    const ntRemoved = {};
    for (const w of oldWords) {
      ntRemoved[w.id] = ntPage[w.id];
      if (!nextWords.includes(w)) delete ntPage[w.id];
    }
    /** @type {Record<string, NativeTextWord>} */
    const ntAdded = {};
    res.lineWords.forEach((lw, li) => {
      ntPage[nextWords[li].id] = lw.entry;
      ntAdded[nextWords[li].id] = structuredClone(lw.entry);
    });
    const lineAfterSnaps = [{ index: lineIndex, snap: snapshotLine(line) }];
    const sweepIds = [...new Set([...oldWords.map((w) => w.id), ...nextWords.map((w) => w.id)])];
    doc.contentEditHistory.record({
      pages: [{
        n, records: res.records, lineSnaps, lineAfterSnaps, sweepIds, annots, replacedRecords, ntRemoved, ntAdded,
      }],
    }, 'Edited text');
    return { pages: [n], groupId };
  });
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
      this.doc.pageStore.held(() => {
        // Load detail before splicing page.lines, since decodeDetailRecord matches character boxes to words positionally.
        const page = this.doc.getPage(p.n, { detail: true });
        if (!page) return;
        // Remove surviving versions of snapshotted lines, catching partially deleted twin lines via snap.words and new replacement word IDs via sweepIds.
        const snapWordIds = new Set();
        for (const { snap } of p.lineSnaps) for (const w of snap.words) snapWordIds.add(w.id);
        for (const id of p.sweepIds || []) snapWordIds.add(id);
        for (let i = page.lines.length - 1; i >= 0; i--) {
          if (page.lines[i].words.some((w) => snapWordIds.has(w.id))) page.lines.splice(i, 1);
        }
        for (const { index, snap } of p.lineSnaps) {
          const restored = structuredClone(snap);
          restored.page = page;
          page.lines.splice(Math.min(index, page.lines.length), 0, restored);
        }
        const ntPage = this.doc.nativeText.pages[p.n] || (this.doc.nativeText.pages[p.n] = {});
        for (const id of Object.keys(p.ntAdded || {})) delete ntPage[id];
        for (const [id, e] of Object.entries(p.ntRemoved)) ntPage[id] = structuredClone(e);
      });
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
      this.doc.pageStore.held(() => {
        const page = this.doc.getPage(p.n, { detail: true });
        if (!page) return;
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
        const ntPage = this.doc.nativeText.pages[p.n] || (this.doc.nativeText.pages[p.n] = {});
        for (const id of Object.keys(p.ntRemoved)) delete ntPage[id];
        for (const [id, e] of Object.entries(p.ntAdded || {})) ntPage[id] = structuredClone(e);
      });
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
