import { bboxToPageSpace } from './addHighlights.js';
import { ensureGlyphSetForText } from './fontContainerMain.js';
import ocr, { OcrWord, OcrChar } from './objects/ocrObjects.js';
import { resolveReplacementChar } from './pdf/glyphResolve.js';
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
 * The per-word delete rect, the vertical middle band of the word's box, in page space.
 * The glyph hit test consuming it is shared with redaction and inflates every glyph toward over-matching, so a full-box rect can also match glyphs of neighboring lines and of abutting words.
 * @param {bbox} b - The word's bbox (local frame).
 * @param {?Array<import('./objects/ocrObjects.js').OcrChar>} chars - The word's char boxes, when known.
 * @param {number} orientation
 * @param {{width: number, height: number}} dims
 */
export function wordBandRect(b, chars, orientation, dims) {
  const cy = (b.top + b.bottom) / 2;
  const q = Math.abs(b.bottom - b.top) * 0.15;
  const ix = Math.min(Math.abs(b.bottom - b.top) * 0.25, Math.abs(b.right - b.left) * 0.25);
  let left = b.left + ix;
  let right = b.right - ix;
  if (chars && chars.length > 0) {
    const fc = chars[0].bbox;
    const lc = chars[chars.length - 1].bbox;
    left = Math.min(left, (fc.left + fc.right) / 2);
    right = Math.max(right, (lc.left + lc.right) / 2);
  }
  return bboxToPageSpace({
    left, right, top: cy - q, bottom: cy + q,
  }, orientation, dims);
}

/**
 * Map a local-frame point to page space.
 * @param {number} x
 * @param {number} y
 * @param {number} o - Line orientation (quarter-turns).
 * @param {{width: number, height: number}} dims
 */
const localPointToPageSpace = (x, y, o, dims) => (o === 1 ? { x: dims.width - y, y: x }
  : o === 2 ? { x: dims.width - x, y: dims.height - y }
    : o === 3 ? { x: y, y: dims.height - x } : { x, y });

/**
 * Build the glyph identities a delete/replace record carries for `words`, in page space.
 * Record-drawn words have no pen origins, so their rounded char-box lefts stand in within the strike tolerance.
 * @param {Record<string, NativeTextWord>} nt - The page's native-text entries.
 * @param {Array<OcrWord>} words
 * @param {number} orientation - The words' line orientation.
 * @param {{width: number, height: number}} dims
 * @returns {Array<TextEditGlyphWord>}
 */
export function glyphIdentitiesForWords(nt, words, orientation, dims) {
  /** @type {Array<TextEditGlyphWord>} */
  const out = [];
  for (const w of words) {
    const e = nt[w.id];
    const chars = w.chars && w.chars.length > 0 ? w.chars.map((c) => c.text) : [w.text];
    const penX = e?.penX && e.penX.length === chars.length
      ? e.penX
      : (w.chars && w.chars.length > 0 ? w.chars.map((c) => c.bbox.left) : [w.bbox.left]);
    const baseY = e?.baselineY ?? w.bbox.bottom;
    /** @type {TextEditGlyphWord} */
    const gw = {
      chars, x: [], y: [],
    };
    for (const px of penX) {
      const p = localPointToPageSpace(px, baseY, orientation, dims);
      gw.x.push(p.x);
      gw.y.push(p.y);
    }
    if (e && Number.isFinite(e.fontObjNum)) gw.fontObjNum = e.fontObjNum;
    out.push(gw);
  }
  return out;
}

/**
 * Finds coincident twin words on lines not in `excludeLines`.
 * A twin's middle band sits on one of `rects` and its text is a degraded copy of the deleted text at that spot.
 * Some producers draw a row twice: a visible layer plus an alpha-0 duplicate, a faux-bold second pass, or white text-shadow halo copies.
 * The exported PDF drops the twin's glyphs via the deleted text's identities, so the twin words must be deleted as well or the app keeps finding text the export no longer contains.
 * @param {OcrPage} page
 * @param {Set<OcrLine>} excludeLines
 * @param {Array<bbox>} rects - Page-space delete rects.
 * @param {Array<TextEditGlyphWord>} deletedGlyphs - Page-space identities of the deleted words.
 * @param {Record<string, NativeTextWord>} ntPage - The page's native-text entries, for candidate baselines.
 * @returns {Array<{line: OcrLine, ids: Array<string>, boxes: Array<bbox>, words: Array<OcrWord>}>}
 */
function findSuperimposedWords(page, excludeLines, rects, deletedGlyphs, ntPage) {
  const foldChar = (s) => ocr.replaceLigatures(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  /** @type {Array<{u: string, x: number, y: number}>} */
  const delChars = [];
  for (const gw of deletedGlyphs) {
    for (let i = 0; i < gw.chars.length; i++) delChars.push({ u: foldChar(gw.chars[i]), x: gw.x[i], y: gw.y[i] });
  }
  delChars.sort((a, b) => a.x - b.x);
  const isSubseq = (/** @type {string} */ a, /** @type {string} */ b) => {
    let i = 0;
    for (const c of b) { if (c === a[i]) i += 1; if (i === a.length) return true; }
    return a.length === 0;
  };
  const PAD = 40;
  /** @type {Array<{line: OcrLine, ids: Array<string>, boxes: Array<bbox>, words: Array<OcrWord>}>} */
  const hits = [];
  for (const other of page.lines) {
    if (excludeLines.has(other)) continue;
    /** @type {?{line: OcrLine, ids: Array<string>, boxes: Array<bbox>, words: Array<OcrWord>}} */
    let entry = null;
    for (const w of other.words) {
      const band = wordBandRect(w.bbox, w.chars, other.orientation, page.dims);
      const hit = rects.some((r) => Math.min(band.bottom, r.bottom) > Math.max(band.top, r.top)
        && Math.min(band.right, r.right) - Math.max(band.left, r.left) >= 0.6 * (band.right - band.left));
      if (!hit) continue;
      const box = bboxToPageSpace(w.bbox, other.orientation, page.dims);
      const size = w.style.size || Math.abs(w.bbox.bottom - w.bbox.top);
      const baseTol = Math.max(3, 0.5 * size);
      const localBaseY = ntPage[w.id]?.baselineY ?? w.bbox.bottom;
      const baseY = localPointToPageSpace(w.bbox.left, localBaseY, other.orientation, page.dims).y;
      const windowChars = delChars.filter((c) => c.x >= box.left - PAD && c.x <= box.right + PAD && Math.abs(c.y - baseY) <= baseTol);
      let twin = false;
      if (windowChars.length > 0) {
        const wCharList = w.chars && w.chars.length > 0 ? w.chars : null;
        if (wCharList) {
          // A coincident twin sits at the same draw position, so both axes use the tight tolerance.
          // The loose `baseTol` above only pre-filters the window for the subsequence branch.
          let anyAlnum = false;
          twin = wCharList.every((c) => {
            const u = foldChar(c.text);
            if (u.length === 0) return true;
            anyAlnum = true;
            const cp = localPointToPageSpace(c.bbox.left, localBaseY, other.orientation, page.dims);
            return windowChars.some((d) => d.u === u && Math.abs(d.x - cp.x) <= 3.5 && Math.abs(d.y - cp.y) <= 3.5);
          }) && anyAlnum;
        }
        if (!twin) {
          const winText = windowChars.map((c) => c.u).join('');
          const wText = foldChar(w.text);
          if (wText.length >= 3) {
            const [lo, hi] = wText.length <= winText.length ? [wText, winText] : [winText, wText];
            twin = isSubseq(lo, hi);
          }
        }
      }
      if (twin) {
        entry ??= {
          line: other, ids: [], boxes: [], words: [],
        };
        entry.ids.push(w.id);
        entry.boxes.push(box);
        entry.words.push(w);
      }
    }
    if (entry) hits.push(entry);
  }
  return hits;
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
 * Word id → backing record id, from one page's edit records.
 * Words listed in a replaceText record's `wordIds` exist only as that record's runs, so editing or deleting them must fold the record.
 * @param {Array<TextEdit>} [records]
 * @returns {Map<string, string>}
 */
function backingRecordByWordId(records) {
  const map = new Map();
  for (const rec of records || []) {
    if (rec && rec.wordIds) for (const id of rec.wordIds) map.set(id, rec.id);
  }
  return map;
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
 * Deletes whole lines of visible native PDF text.
 * The words are also removed from the live OCR data, so search and text exports reflect the deletion immediately.
 * Records one undoable step in `doc.textEditHistory`.
 * @param {ScribeDoc} doc
 * @param {Array<OcrLine>} lines - Live lines from `doc.ocr.active` pages.
 * @returns {{pages: Array<number>, groupId: string}} Affected page indices (for viewer refresh) and the action's group id.
 */
export function deleteTextLines(doc, lines) {
  /** @type {Map<number, Array<OcrLine>>} */
  const byPage = new Map();
  for (const line of lines) {
    if (!line || !line.page || !line.words || line.words.length === 0) continue;
    const nt = nativeTextForPage(doc, line.page);
    for (const w of line.words) {
      if (!nt[w.id]) throw new Error(`deleteTextLines: word "${w.text}" (${w.id}) is not visible native text.`);
    }
    const n = line.page.n;
    if (!byPage.has(n)) byPage.set(n, []);
    byPage.get(n).push(line);
  }
  if (byPage.size === 0) return { pages: [], groupId: '' };

  const groupId = getRandomAlphanum(10);
  /** @type {Array<object>} */
  const entryPages = [];
  for (const [n, pageLines] of byPage) {
    const page = pageLines[0].page;
    const ntBefore = structuredClone(doc.nativeText.pages[n] || {});
    /** @type {Array<bbox>} */
    const rects = [];
    /** @type {Array<string>} */
    const wordIds = [];
    /** @type {Array<{index: number, snap: OcrLine}>} */
    const lineSnaps = [];
    /** @type {Array<bbox>} */
    const deletedWordBoxes = [];
    /** @type {Array<TextEditGlyphWord>} */
    const glyphs = [];
    const nt = nativeTextForPage(doc, page);
    for (const line of pageLines) {
      for (const w of line.words) {
        rects.push(wordBandRect(w.bbox, w.chars, line.orientation, page.dims));
        wordIds.push(w.id);
        deletedWordBoxes.push(bboxToPageSpace(w.bbox, line.orientation, page.dims));
      }
      glyphs.push(...glyphIdentitiesForWords(nt, line.words, line.orientation, page.dims));
      lineSnaps.push({ index: page.lines.indexOf(line), snap: snapshotLine(line) });
    }
    // A removed replaceText record's rects and glyph identities fold into this delete record so the stream glyphs the replace had suppressed stay suppressed.
    /** @type {Array<{index: number, record: TextEdit}>} */
    const replacedRecords = [];
    const backing = backingRecordByWordId(doc.textEdits.pages[n]);
    const backingIds = new Set();
    for (const line of pageLines) for (const w of line.words) { const rid = backing.get(w.id); if (rid) backingIds.add(rid); }
    // Folding a legacy record (no identities) forces the merged record geometric, or its rects would stop striking anything.
    let carriedLegacy = false;
    if (backingIds.size > 0 && doc.textEdits.pages[n]) {
      const recs = doc.textEdits.pages[n];
      for (let ri = recs.length - 1; ri >= 0; ri--) {
        if (backingIds.has(recs[ri].id)) {
          replacedRecords.push({ index: ri, record: recs[ri] });
          for (const r of recs[ri].rects || []) rects.push(r);
          if (recs[ri].glyphs) glyphs.push(...recs[ri].glyphs);
          else carriedLegacy = true;
          recs.splice(ri, 1);
        }
      }
      replacedRecords.reverse();
    }
    const twins = findSuperimposedWords(page, new Set(pageLines), rects, glyphs, nt);
    for (const t of twins) {
      lineSnaps.push({ index: page.lines.indexOf(t.line), snap: snapshotLine(t.line) });
      wordIds.push(...t.ids);
      deletedWordBoxes.push(...t.boxes);
      glyphs.push(...glyphIdentitiesForWords(nt, t.words, t.line.orientation, page.dims));
    }
    const annots = removeMarkupOnBoxes(doc, n, deletedWordBoxes);
    // Ascending order so undo can re-splice at the recorded indices left to right.
    lineSnaps.sort((a, b) => a.index - b.index);
    /** @type {TextEditDelete} */
    const record = {
      type: 'deleteText', id: getRandomAlphanum(10), groupId, rects,
    };
    if (!carriedLegacy) record.glyphs = glyphs;
    if (!doc.textEdits.pages[n]) doc.textEdits.pages[n] = [];
    doc.textEdits.pages[n].push(record);
    ocr.deletePageWords(page, wordIds.slice());
    const ntPage = doc.nativeText.pages[n];
    if (ntPage) for (const id of wordIds) delete ntPage[id];
    const ntAfter = structuredClone(doc.nativeText.pages[n] || {});
    entryPages.push({
      n, record, wordIds, lineSnaps, annots, replacedRecords, ntBefore, ntAfter,
    });
  }
  doc.textEditHistory.record({ groupId, pages: entryPages });
  return { pages: entryPages.map((p) => p.n), groupId };
}

export const FAUX_BOLD_STROKE_EM = 0.025;
export const FAUX_OBLIQUE_SKEW = 0.25;

/**
 * Replace a line's text with `newText`, optionally toggling bold/italic per word.
 * Deletes the changed words' original glyphs and lays out the new words as pre-resolved glyph runs in one `replaceText` record.
 * The renderer and the PDF export both execute that record, so the raster and the file cannot diverge.
 * Records one undoable step in `doc.textEditHistory`.
 * @param {ScribeDoc} doc
 * @param {OcrLine} line - A live line from `doc.ocr.active` pages.
 * @param {string} newText - The line's replacement text; empty deletes the line.
 * @param {{wordStyles?: Array<?{bold?: boolean, italic?: boolean}>}} [opts] - Per-word style toggles, index-aligned with the whitespace-split words of `newText`; null entries inherit.
 * @returns {Promise<?{pages: Array<number>, groupId: string}>} Affected pages and the action's group id, or null when nothing changes.
 */
export async function replaceTextLine(doc, line, newText, opts) {
  if (!line || !line.page || !line.words || line.words.length === 0) throw new Error('replaceTextLine: not a live line.');
  const nt = nativeTextForPage(doc, line.page);
  for (const w of line.words) {
    if (!nt[w.id]) throw new Error(`replaceTextLine: word "${w.text}" (${w.id}) is not visible native text.`);
  }
  const newTexts = String(newText).trim().split(/\s+/).filter((t) => t.length > 0);
  if (newTexts.length === 0) return deleteTextLines(doc, [line]);
  // Awaited, so a character typed faster than the wider set downloads is never committed as a tofu box.
  await ensureGlyphSetForText(newText);
  const wordStylesIn = opts?.wordStyles || null;
  // A toggle counts as a change only when it can alter the word's drawn state, so no-op toggles never force a redraw.
  /** @type {(w: OcrWord, ov: ?{bold?: boolean, italic?: boolean} | undefined) => boolean} */
  const styleChangeAt = (w, ov) => {
    if (!ov) return false;
    const e = nt[w.id];
    const stroked = !!(e && (e.renderMode === 1 || e.renderMode === 2) && e.strokeWidthPx);
    const skewed = !!(e && e.skew && e.skew.some((v) => v));
    if (ov.bold === true && !w.style.bold) return true;
    if (ov.bold === false && stroked) return true;
    if (ov.italic === true && !w.style.italic) return true;
    if (ov.italic === false && skewed) return true;
    return false;
  };

  const page = line.page;
  const n = page.n;
  const ntBefore = structuredClone(doc.nativeText.pages[n] || {});
  const dims = page.dims;
  const o = line.orientation || 0;
  const oldWords = line.words.slice();
  const oldTexts = oldWords.map((w) => w.text);
  const olen = oldWords.length;
  const nlen = newTexts.length;

  let i0 = 0;
  while (i0 < olen && i0 < nlen && oldTexts[i0] === newTexts[i0] && !styleChangeAt(oldWords[i0], wordStylesIn?.[i0])) i0 += 1;
  if (i0 === olen && i0 === nlen) return null;
  let k = 0;
  while (k < olen - i0 && k < nlen - i0 && oldTexts[olen - 1 - k] === newTexts[nlen - 1 - k]
    && !styleChangeAt(oldWords[olen - 1 - k], wordStylesIn?.[nlen - 1 - k])) k += 1;

  // A word drawn by a prior replaceText record has no original stream glyphs, so the redraw must span every such word and fold its record into this one.
  const backing = backingRecordByWordId(doc.textEdits.pages[n]);
  const backedIdx = [];
  for (let m = 0; m < olen; m++) if (backing.has(oldWords[m].id)) backedIdx.push(m);
  let rs = Math.min(i0, backedIdx.length ? backedIdx[0] : i0);
  // A pure append would make a record with no erase rects, leaving the splice nothing to anchor on in the source stream.
  // Redrawing the last original word gives the appended text the same in-place anchor as every other edit.
  if (rs === olen) rs = olen - 1;
  const lastBacked = backedIdx.length ? backedIdx[backedIdx.length - 1] : -1;
  const realignStartOld = Math.max(olen - k, lastBacked + 1);

  const recordId = getRandomAlphanum(10);
  const groupId = getRandomAlphanum(10);
  const baselineY = line.bbox.bottom + (line.baseline?.[1] || 0);
  const localPointToPage = (x, y) => (o === 1 ? { x: dims.width - y, y: x }
    : o === 2 ? { x: dims.width - x, y: dims.height - y }
      : o === 3 ? { x: y, y: dims.height - x } : { x, y });

  /** @type {Map<number, ?import('./pdf/glyphResolve.js').EditFontProgram>} */
  const programs = new Map();
  const programFor = async (fontObjNum) => {
    const key = fontObjNum ?? -1;
    if (!programs.has(key)) {
      const ef = fontObjNum !== undefined && fontObjNum !== null ? await doc.images.getEditFont(n, fontObjNum) : null;
      programs.set(key, ef?.program || null);
    }
    return programs.get(key);
  };

  // A changed middle word maps to the old word at the same index when one exists, so a retyped word keeps its identity and style.
  const styleFrom = oldWords[Math.min(i0, olen - 1)];
  const oldIndexFor = (m) => {
    if (m < i0) return m;
    if (m >= nlen - k) return m - (nlen - olen);
    return m < olen - k ? m : null;
  };
  const priorBackingIds = new Set();
  for (const w of oldWords) { const rid = backing.get(w.id); if (rid) priorBackingIds.add(rid); }

  // The layout loop mutates reused word objects in place, so pre-edit geometry below is read from this snapshot, not the live words.
  const lineIndex = page.lines.indexOf(line);
  /** @type {Array<{index: number, snap: OcrLine}>} */
  const lineSnaps = [{ index: lineIndex, snap: snapshotLine(line) }];
  const oldBoxes = lineSnaps[0].snap.words.map((w) => w.bbox);
  // Anchoring redraws to the rounded bbox left instead of the exact penX shifts glyphs by up to half a pixel.
  const wordPenLeft = (idx) => nt[lineSnaps[0].snap.words[idx].id]?.penX?.[0] ?? oldBoxes[idx].left;
  const oldIdentities = lineSnaps[0].snap.words.map((w) => glyphIdentitiesForWords(nt, [w], o, dims)[0]);

  /** @type {Array<TextEditRun>} */
  const runs = [];
  /** @type {Array<OcrWord>} */
  const redrawnWords = [];
  /** @type {Array<NativeTextWord>} */
  const redrawnEntries = [];
  let newRedrawEnd = nlen;
  let realigned = false;
  let pen = wordPenLeft(rs);
  let suffixDelta = 0;
  let inSuffix = false;
  let prevOldIdx = rs > 0 ? rs - 1 : null;
  let prevSpaceAdvPx = 0;

  for (let m = rs; m < newRedrawEnd; m++) {
    const curOld = oldIndexFor(m);
    // Words that were adjacent in the original line keep their original gap, so an equal-width edit realigns exactly.
    const flowX = m === rs ? pen
      : pen + (prevOldIdx !== null && curOld !== null && curOld === prevOldIdx + 1
        ? wordPenLeft(curOld) - oldBoxes[prevOldIdx].right
        : prevSpaceAdvPx);

    if (!realigned && realignStartOld < olen && m === nlen - (olen - realignStartOld)) {
      const delta = inSuffix ? suffixDelta : flowX - wordPenLeft(realignStartOld);
      if (Math.abs(delta) < 0.5) {
        realigned = true;
        newRedrawEnd = m;
        break;
      }
      inSuffix = true;
      suffixDelta = delta;
    }

    const src = curOld !== null ? oldWords[curOld] : null;
    const wordStyleSrc = src || styleFrom;
    const preBox = curOld !== null ? oldBoxes[curOld] : oldBoxes[Math.min(i0, olen - 1)];
    const s = wordStyleSrc.style.size || Math.abs(preBox.bottom - preBox.top) / 0.75;
    const srcEntry = nt[wordStyleSrc.id];
    const program = await programFor(srcEntry?.fontObjNum);
    // The flat line baseline would drop a raised sup word onto the body text.
    const wordBaseY = srcEntry?.baselineY ?? baselineY;
    const color = wordStyleSrc.style.color || '#000000';
    const ov = wordStylesIn?.[m] || null;
    const srcStroked = !!(srcEntry && (srcEntry.renderMode === 1 || srcEntry.renderMode === 2) && srcEntry.strokeWidthPx);
    /** @type {?{renderMode: number, strokeWidthPx: number, strokeColor?: string}} */
    let strokeState = srcStroked && srcEntry
      ? { renderMode: /** @type {number} */ (srcEntry.renderMode), strokeWidthPx: /** @type {number} */ (srcEntry.strokeWidthPx), strokeColor: srcEntry.strokeColor }
      : null;
    if (ov?.bold === true && !srcStroked && !wordStyleSrc.style.bold) {
      strokeState = { renderMode: 2, strokeWidthPx: Math.round(FAUX_BOLD_STROKE_EM * s * 1000) / 1000, strokeColor: color };
    } else if (ov?.bold === false) {
      strokeState = null;
    }
    let skewFinal = srcEntry?.skew?.find((v) => v) || 0;
    if (ov?.italic === true && !wordStyleSrc.style.italic) skewFinal = FAUX_OBLIQUE_SKEW;
    else if (ov?.italic === false) skewFinal = 0;
    const finalBold = ov && ov.bold !== undefined ? (ov.bold ? true : !!program?.bold) : wordStyleSrc.style.bold;
    const finalItalic = ov && ov.italic !== undefined ? (ov.italic ? true : !!program?.italic) : wordStyleSrc.style.italic;
    // A faux word's boldness is the stroke and its lean the shear, so substitute faces resolve without them; a styled substitute plus the synthesized state would double up.
    /** @type {{bold?: boolean, italic?: boolean, size?: number}} */
    let resolveStyle = { ...wordStyleSrc.style, bold: finalBold, italic: finalItalic };
    if (strokeState && !program?.bold && resolveStyle.bold) resolveStyle = { ...resolveStyle, bold: false };
    if (skewFinal && !program?.italic && resolveStyle.italic) resolveStyle = { ...resolveStyle, italic: false };

    let x;
    if (src && m < i0) {
      x = wordPenLeft(curOld);
    } else if (src && m >= nlen - k) {
      if (!inSuffix) {
        inSuffix = true;
        suffixDelta = flowX - wordPenLeft(curOld);
      }
      x = wordPenLeft(curOld) + suffixDelta;
    } else {
      x = flowX;
    }

    // A span that came from a single ligature glyph redraws as that glyph when it lies wholly in the word's unchanged prefix or suffix.
    /** @type {?Map<number, {ch: string, len: number}>} */
    let ligAt = null;
    const snapOld = curOld !== null ? lineSnaps[0].snap.words[curOld] : null;
    if (snapOld && snapOld.chars && snapOld.chars.length > 0) {
      const oldT = snapOld.text;
      const newT = newTexts[m];
      let pfx = 0;
      while (pfx < oldT.length && pfx < newT.length && oldT[pfx] === newT[pfx]) pfx += 1;
      let sfxN = 0;
      while (sfxN < oldT.length - pfx && sfxN < newT.length - pfx
        && oldT[oldT.length - 1 - sfxN] === newT[newT.length - 1 - sfxN]) sfxN += 1;
      let ti = 0;
      let recon = '';
      for (const entry of snapOld.chars) {
        const seg = ocr.replaceLigatures(entry.text);
        const lig = seg.length > 1 ? ocr.ligatureForText(entry.text) : null;
        if (lig && (ti + seg.length <= pfx || ti >= oldT.length - sfxN)) {
          const at = ti >= oldT.length - sfxN ? ti + newT.length - oldT.length : ti;
          if (!ligAt) ligAt = new Map();
          ligAt.set(at, { ch: lig, len: seg.length });
        }
        recon += seg;
        ti += seg.length;
      }
      if (recon !== oldT) ligAt = null;
    }

    /** @type {Array<{ch: string, cp?: number, gid?: number, advEm: number, sizeMult?: number, stretch?: number, tofu?: boolean, top: number, bottom: number, faceKey: string, font: ?object}>} */
    const resolved = [];
    let ci = 0;
    while (ci < newTexts[m].length) {
      let ch;
      let r = null;
      const lig = ligAt ? ligAt.get(ci) : undefined;
      if (lig) {
        // A substitute face's ligature would sit in a different typeface than the letters around it.
        const lr = resolveReplacementChar(lig.ch, program, resolveStyle);
        if (lr.kind === 'orig') {
          ch = newTexts[m].slice(ci, ci + lig.len);
          r = lr;
          ci += lig.len;
        }
      }
      if (!r) {
        ch = String.fromCodePoint(/** @type {number} */ (newTexts[m].codePointAt(ci)));
        r = resolveReplacementChar(ch, program, resolveStyle);
        ci += ch.length;
      }
      if (r.kind === 'tofu') {
        resolved.push({
          ch, tofu: true, advEm: r.advEm, top: wordBaseY - 0.72 * s, bottom: wordBaseY, faceKey: '', font: null,
        });
      } else {
        const fontObj = r.kind === 'orig' ? program.font : r.font;
        const g = fontObj.glyphs.get(r.gid);
        let yMax = null;
        let yMin = null;
        if (g && typeof g.yMax === 'number' && (g.yMax !== 0 || g.yMin !== 0)) {
          yMax = g.yMax;
          yMin = g.yMin;
        } else if (g) {
          try {
            const bb = g.getPath(0, 0, fontObj.unitsPerEm).getBoundingBox();
            yMax = -bb.y1;
            yMin = -bb.y2;
          } catch { /* metrics fall back below */ }
        }
        if (yMax === null || (yMax === 0 && yMin === 0)) {
          yMax = 0.75 * fontObj.unitsPerEm;
          yMin = 0;
        }
        const upem = fontObj.unitsPerEm;
        const drawMult = r.kind === 'bundled' ? (r.sizeMult || 1) : 1;
        resolved.push({
          ch,
          cp: r.codepoint,
          gid: r.gid,
          advEm: r.advEm,
          sizeMult: drawMult,
          stretch: r.kind === 'bundled' ? (r.stretch || 1) : 1,
          top: wordBaseY - (yMax / upem) * s * drawMult,
          bottom: wordBaseY - (yMin / upem) * s * drawMult,
          faceKey: r.kind === 'orig' ? 'o' : `b:${r.family}:${r.styleKey}`,
          font: r.kind === 'orig'
            ? { kind: 'orig', fontObjNum: srcEntry?.fontObjNum }
            : { kind: 'bundled', family: r.family, styleKey: r.styleKey },
        });
      }
    }

    /** @type {?TextEditRun} */
    let run = null;
    /** @type {?string} */
    let runFaceKey = null;
    // Run glyph advances are stored per em of the run's own size, which for fitted substitutes differs from the word size by sizeMult.
    // Layout math here stays in word-size units.
    let runSizeMult = 1;
    let cx = x;
    /** @type {Array<OcrChar>} */
    const chars = [];
    for (const r of resolved) {
      if (!r.tofu && r.faceKey !== runFaceKey) {
        run = null;
        runFaceKey = r.faceKey;
      }
      if (!run) {
        const org = localPointToPage(cx, wordBaseY);
        runSizeMult = r.sizeMult || 1;
        /** @type {TextEditRun} */
        const newRun = {
          x: org.x, y: org.y, orientation: o, sizePx: s * runSizeMult, color, font: r.font || { kind: 'orig', fontObjNum: srcEntry?.fontObjNum }, glyphs: [],
        };
        if (strokeState) {
          newRun.renderMode = strokeState.renderMode;
          newRun.strokeWidthPx = strokeState.strokeWidthPx;
          if (strokeState.strokeColor) newRun.strokeColor = strokeState.strokeColor;
        }
        if (skewFinal) newRun.skew = skewFinal;
        if (r.stretch && r.stretch !== 1) newRun.stretch = r.stretch;
        run = newRun;
        runs.push(run);
      }
      run.glyphs.push(r.tofu ? { tofu: true, advEm: r.advEm / runSizeMult } : { cp: r.cp, gid: r.gid, advEm: r.advEm / runSizeMult });
      chars.push(new OcrChar(r.ch, {
        left: cx, right: cx + r.advEm * s, top: r.top, bottom: r.bottom,
      }));
      cx += r.advEm * s;
    }
    const wordBbox = {
      left: x,
      right: cx,
      top: Math.min(...resolved.map((r) => r.top)),
      bottom: Math.max(...resolved.map((r) => r.bottom)),
    };

    /** @type {OcrWord} */
    let word;
    if (src) {
      word = src;
      word.text = newTexts[m];
      word.bbox = wordBbox;
      word.chars = chars;
      word.styleRuns = undefined;
    } else {
      word = new OcrWord(line, getRandomAlphanum(10), newTexts[m], wordBbox);
      word.style = { ...styleFrom.style };
      word.styleRuns = undefined;
      word.conf = styleFrom.conf;
      word.lang = styleFrom.lang;
      word.visualCoords = true;
      word.chars = chars;
    }
    if (ov && (ov.bold !== undefined || ov.italic !== undefined)) {
      word.style = { ...word.style, bold: finalBold, italic: finalItalic };
    }
    // Stroke width and shear have no home in the word style, so only the entry can carry them into a later edit.
    /** @type {NativeTextWord} */
    const wordEntry = { baselineY: nt[word.id] ? nt[word.id].baselineY : wordBaseY };
    const entryFontObjNum = nt[word.id] ? nt[word.id].fontObjNum : nt[styleFrom.id]?.fontObjNum;
    if (entryFontObjNum !== undefined) wordEntry.fontObjNum = entryFontObjNum;
    if (strokeState) {
      wordEntry.renderMode = strokeState.renderMode;
      wordEntry.strokeWidthPx = strokeState.strokeWidthPx;
      if (strokeState.strokeColor) wordEntry.strokeColor = strokeState.strokeColor;
    }
    if (skewFinal) wordEntry.skew = chars.map(() => skewFinal);
    redrawnEntries.push(wordEntry);
    redrawnWords.push(word);

    pen = cx;
    prevOldIdx = curOld;
    const sp = resolveReplacementChar(' ', program, resolveStyle);
    prevSpaceAdvPx = (sp.kind === 'tofu' ? 0.25 : sp.advEm) * s;
  }
  const redrawOldEndFinal = realigned ? realignStartOld : olen;

  // Record-drawn words have no original stream glyphs to band.
  // Their originals stay suppressed by the prior record's rects, which carry into the merged record.
  /** @type {Array<bbox>} */
  const newBands = [];
  /** @type {Array<bbox>} */
  const removedWordBoxes = [];
  for (let m = rs; m < redrawOldEndFinal; m++) {
    if (!backing.has(lineSnaps[0].snap.words[m].id)) newBands.push(wordBandRect(oldBoxes[m], lineSnaps[0].snap.words[m].chars, o, dims));
    removedWordBoxes.push(bboxToPageSpace(oldBoxes[m], o, dims));
  }

  /** @type {Array<{index: number, record: TextEdit}>} */
  const replacedRecords = [];
  /** @type {Array<bbox>} */
  const carriedRects = [];
  /** @type {Array<TextEditGlyphWord>} */
  const recordGlyphs = [];
  // Folding a legacy record (no identities) forces the merged record geometric, or its rects would stop striking anything.
  let carriedLegacy = false;
  if (priorBackingIds.size > 0 && doc.textEdits.pages[n]) {
    const recs = doc.textEdits.pages[n];
    for (let ri = recs.length - 1; ri >= 0; ri--) {
      if (priorBackingIds.has(recs[ri].id)) {
        replacedRecords.push({ index: ri, record: recs[ri] });
        for (const r of recs[ri].rects || []) carriedRects.push(r);
        if (recs[ri].glyphs) recordGlyphs.push(...recs[ri].glyphs);
        else carriedLegacy = true;
        recs.splice(ri, 1);
      }
    }
    replacedRecords.reverse();
  }
  for (let m = rs; m < redrawOldEndFinal; m++) {
    if (!backing.has(lineSnaps[0].snap.words[m].id)) recordGlyphs.push(oldIdentities[m]);
  }

  line.words = [...oldWords.slice(0, rs), ...redrawnWords, ...(realigned ? oldWords.slice(realignStartOld) : [])];
  for (const w of line.words) w.line = line;
  ocr.updateLineBbox(line);

  // Runs are empty only when the new text is a strict word-prefix of the old, i.e. the edit is a pure tail deletion.
  /** @type {TextEdit} */
  const record = runs.length > 0
    ? {
      type: 'replaceText', id: recordId, groupId, rects: [...carriedRects, ...newBands], runs, wordIds: redrawnWords.map((w) => w.id),
    }
    : {
      type: 'deleteText', id: recordId, groupId, rects: [...carriedRects, ...newBands],
    };
  if (!carriedLegacy) record.glyphs = recordGlyphs;
  if (!doc.textEdits.pages[n]) doc.textEdits.pages[n] = [];
  doc.textEdits.pages[n].push(record);

  /** @type {Array<string>} */
  const twinIds = [];
  const twins = findSuperimposedWords(page, new Set([line]), newBands, recordGlyphs, doc.nativeText.pages[n] || {});
  for (const t of twins) {
    lineSnaps.push({ index: page.lines.indexOf(t.line), snap: snapshotLine(t.line) });
    twinIds.push(...t.ids);
    removedWordBoxes.push(...t.boxes);
    recordGlyphs.push(...glyphIdentitiesForWords(doc.nativeText.pages[n] || {}, t.words, t.line.orientation, page.dims));
  }
  if (twinIds.length > 0) ocr.deletePageWords(page, twinIds.slice());
  const annots = removeMarkupOnBoxes(doc, n, removedWordBoxes);

  const ntPage = doc.nativeText.pages[n] || (doc.nativeText.pages[n] = {});
  for (const w of oldWords) { if (!line.words.includes(w)) delete ntPage[w.id]; }
  for (const id of twinIds) delete ntPage[id];
  for (let e = 0; e < redrawnWords.length; e++) ntPage[redrawnWords[e].id] = redrawnEntries[e];
  const ntAfter = structuredClone(ntPage);

  lineSnaps.sort((a, b) => a.index - b.index);
  const lineAfterSnaps = [{ index: lineIndex, snap: snapshotLine(line) }];
  const sweepIds = [];
  for (const { snap } of lineAfterSnaps) for (const w of snap.words) sweepIds.push(w.id);
  for (const w of oldWords) sweepIds.push(w.id);

  doc.textEditHistory.record({
    groupId,
    pages: [{
      n, record, wordIds: twinIds, lineSnaps, lineAfterSnaps, sweepIds, annots, replacedRecords, ntBefore, ntAfter,
    }],
  });
  return { pages: [n], groupId };
}

/**
 * Bounded undo/redo for native-text edits.
 * Page structure ops have a separate `PageHistory`.
 * Its snapshots carry the record arrays, so text-edit records survive page undo/redo.
 */
export class TextEditHistory {
  static LIMIT = 100;

  /** @param {ScribeDoc} doc */
  constructor(doc) {
    this.doc = doc;
    /** @type {Array<object>} */
    this.undoStack = [];
    /** @type {Array<object>} */
    this.redoStack = [];
  }

  /** @param {object} entry */
  record(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > TextEditHistory.LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /**
   * Undo the last text-edit action.
   * @returns {?Array<number>} Affected page indices, or null when nothing was undone.
   */
  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    for (const p of entry.pages) {
      const recs = this.doc.textEdits.pages[p.n];
      if (recs) {
        const idx = recs.findIndex((r) => r && r.id === p.record.id);
        if (idx !== -1) recs.splice(idx, 1);
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
   * Re-apply the last undone text-edit action.
   * @returns {?Array<number>} Affected page indices, or null when nothing was redone.
   */
  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    for (const p of entry.pages) {
      if (!this.doc.textEdits.pages[p.n]) this.doc.textEdits.pages[p.n] = [];
      const recs = this.doc.textEdits.pages[p.n];
      if (p.replacedRecords) {
        for (const { record } of p.replacedRecords) {
          const idx = recs.findIndex((r) => r && r.id === record.id);
          if (idx !== -1) recs.splice(idx, 1);
        }
      }
      recs.push(p.record);
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
        ocr.deletePageWords(page, p.wordIds.slice());
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
