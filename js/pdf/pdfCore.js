import { ca } from '../canvasAdapter.js';
import { unregisterFontFacesMatching } from '../containers/fontContainer.js';
import { ObjectCache } from './objectCache.js';
import { buildType3OpentypeFont, enumerateType3Fonts, parsePageFonts } from './fonts/parsePdfFonts.js';
import { parseAttachments } from './parseAttachments.js';
import { parseOutline } from './parseOutline.js';
import ocr from '../objects/ocrObjects.js';
import {
  colorToRgb, executeRewrittenOperator, parseSinglePage, rgbToHex,
} from './parsePdfDoc.js';
import { findXrefOffset, getPageObjects, parseXref } from './parsePdfUtils.js';
import {
  charStateKey, drawnPen, editsFromPlans, fontCodeTable, glyphCopies, glyphVisible, locateWords, planTextEdit, rewriteShowOperator, segmentAt,
} from './textPatch.js';
import {
  builtInFit, parseEditFontPayload, resolveReplacementChar, substituteFaceFor,
} from './glyphResolve.js';
import {
  ensureSubstituteFace, ensureSubstituteFacesForRecords, substituteFaceByObjNum, substituteFaceResourceEntries, loadSubstituteProgram, recordFaceTag,
} from './substituteFaces.js';
import { getRandomAlphanum } from '../utils/miscUtils.js';

/** @typedef {import('./parsePdfDoc.js').GlyphOpMap} GlyphOpMap */
/** @typedef {import('./parsePdfDoc.js').ShowOp} ShowOp */
/** @typedef {import('./parsePdfDoc.js').PositionedChar} PositionedChar */

/**
 * One loaded PDF and the page operations over it (parse, render).
 * Shared by the worker shell (js/worker/pdfWorker.js) and the in-process
 * scheduler (PdfSchedulerInProcess in js/pdfWorkerMain.js); each owns one instance.
 */
export class PdfCore {
  /** @type {?ObjectCache} */
  #objCache = null;

  /** @type {?ReturnType<typeof getPageObjects>} */
  #pages = null;

  /** @type {?import('./parsePdfDoc.js').LinkDestInfo} */
  #linkDestInfo = null;

  /**
   * Load PDF bytes and parse the document structure.
   * @param {Uint8Array | ArrayBuffer} pdfBytes
   */
  async load(pdfBytes) {
    await this.unload();
    const arr = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
    const xrefOffset = findXrefOffset(arr);
    const xrefEntries = parseXref(arr, xrefOffset);
    this.#objCache = new ObjectCache(arr, xrefEntries);
    this.#pages = getPageObjects(this.#objCache);
    // Shared across parsePage calls so the lazily-built named-destination map is walked at most once per document.
    this.#linkDestInfo = { objNumToIndex: new Map(this.#pages.map((p, i) => [p.objNum, i])), pages: this.#pages, nameDests: null };
    return {
      pageCount: this.#pages.length,
      pages: this.#pages.map((p) => ({ mediaBox: p.cropBox || p.mediaBox, rotate: p.rotate })),
      // Document outline (bookmarks), page-index-normalized; serializable across the worker boundary.
      outline: parseOutline(this.#objCache, this.#pages),
      // Embedded files and the portfolio collection, a name-tree walk with no stream decoded.
      attachments: parseAttachments(this.#objCache),
    };
  }

  /**
   * Parse a single page for text extraction + type-detection scoring.
   * @param {{ pageIndex: number, dpi: number }} args
   */
  parsePage({ pageIndex, dpi }) {
    if (!this.#objCache || !this.#pages) throw new Error('PDF not loaded');
    return parseSinglePage(this.#pages[pageIndex], this.#objCache, pageIndex, dpi, undefined, this.#linkDestInfo ?? undefined);
  }

  /**
   * @typedef {{ glyphOpMap: GlyphOpMap, pageObj: OcrPage, nativeText: Record<string, NativeTextWord>,
   *   fonts: Map<import('./parsePdfDoc.js').PageFont, { table: ?Map<string, import('./textPatch.js').FontCode>, substitute: ?SubstituteFace }> }} OpMappedPage
   */
  /**
   * @typedef {{ tag: string, font: import('../font-parser/src/index.js').Font, family: string, styleKey: string, sizeMult: number, stretch: number,
   *   metrics: ?{ ascent: number, descent: number } }} SubstituteFace
   */

  /**
   * The last op-mapped pages, keyed by page and the records they were parsed with.
   * An open, its previews and its commit parse the page once, and the parse that verified a commit serves the next open.
   * @type {Map<string, OpMappedPage>}
   */
  #opMappedPages = new Map();

  /**
   * Parse a page into its glyph-op map with the given edit records applied to its streams, or take it from the cache.
   * @param {number} pageIndex
   * @param {number} dpi
   * @param {?Array<ContentEdit>} records
   * @returns {Promise<OpMappedPage>}
   */
  async #opMappedPage(pageIndex, dpi, records) {
    if (!this.#objCache || !this.#pages) throw new Error('PDF not loaded');
    const recs = (records || []).filter((r) => r && r.type === 'patchText');
    const key = `${pageIndex}:${dpi}:${JSON.stringify(recs)}`;
    const hit = this.#opMappedPages.get(key);
    if (hit) return hit;
    await ensureSubstituteFacesForRecords(this.#objCache, recs);
    /** @type {GlyphOpMap} */
    const glyphOpMap = {
      stream: { kind: 'page' }, streams: [], ops: [], words: new Map(), glyphs: [], pageHeightPts: 0, scale: 1,
    };
    const parsed = parseSinglePage(this.#pages[pageIndex], this.#objCache, pageIndex, dpi, undefined, this.#linkDestInfo ?? undefined, glyphOpMap, recs);
    /** @type {OpMappedPage} */
    const entry = {
      glyphOpMap, pageObj: parsed.pageObj, nativeText: parsed.nativeText, fonts: new Map(),
    };
    this.#opMappedPages.set(key, entry);
    if (this.#opMappedPages.size > 4) this.#opMappedPages.delete(/** @type {string} */ (this.#opMappedPages.keys().next().value));
    return entry;
  }

  /**
   * The planner's `codeTable` and `substituteFor` for the fonts the found words draw with, each computed once per op-mapped page.
   * @param {OpMappedPage} entry
   * @param {number} pageIndex
   * @param {Array<?import('./textPatch.js').LocatedWord>} found
   */
  async #codeInputs(entry, pageIndex, found) {
    const fontObjs = new Set();
    for (const w of found) {
      for (const c of w ? w.chars : []) {
        for (const d of glyphCopies(entry.glyphOpMap, c)) {
          if (d._font) fontObjs.add(d._font);
        }
      }
    }
    for (const fontObj of fontObjs) {
      if (entry.fonts.has(fontObj)) continue;
      if (fontObj.type3 || fontObj.verticalMode) { entry.fonts.set(fontObj, { table: null, substitute: null }); continue; }
      let program = null;
      if (Number.isFinite(fontObj.fontObjNum)) {
        let pending = this.#editPrograms.get(fontObj.fontObjNum);
        if (!pending) {
          pending = this.getFontBytes({ fontObjNum: fontObj.fontObjNum, pageIndex }).then((payload) => parseEditFontPayload(payload));
          this.#editPrograms.set(fontObj.fontObjNum, pending);
          pending.catch(() => this.#editPrograms.delete(fontObj.fontObjNum));
        }
        program = await pending;
      }
      const drawable = program && program.font ? (/** @type {string} */ text) => resolveReplacementChar(text, program, {}).kind === 'orig' : null;
      const table = fontCodeTable(fontObj, entry.glyphOpMap, drawable);
      /** @type {?SubstituteFace} */
      let substitute = null;
      const face = substituteFaceFor(program, { bold: !!program?.bold, italic: !!program?.italic });
      if (face) {
        try {
          const font = await loadSubstituteProgram(face.family, face.styleKey);
          const fit = program && program.font ? builtInFit(program, font) : null;
          const sizeMult = fit?.sizeMult ?? 1;
          // The face declares the page font's ascent and descent, per em of the face at its fitted size, so a glyph it draws parses to the box its neighbors have.
          const metrics = Number.isFinite(fontObj.ascent) && Number.isFinite(fontObj.descent)
            ? { ascent: Math.round(fontObj.ascent / sizeMult), descent: Math.round(fontObj.descent / sizeMult) } : null;
          const faceEntry = await ensureSubstituteFace(this.#objCache, face.family, face.styleKey, metrics);
          substitute = {
            tag: faceEntry.tag, font: faceEntry.font, family: face.family, styleKey: face.styleKey, sizeMult, stretch: fit?.stretch ?? 1, metrics,
          };
        } catch (e) {
          console.warn(`[applyTextEdit] page ${pageIndex + 1}: the substitute face ${face.family}/${face.styleKey} is unavailable: ${e?.message || e}`);
        }
      }
      entry.fonts.set(fontObj, { table, substitute });
    }
    return {
      codeTable: (/** @type {import('./parsePdfDoc.js').PageFont} */ fontObj) => entry.fonts.get(fontObj)?.table ?? null,
      substituteFor: (/** @type {import('./parsePdfDoc.js').PageFont} */ fontObj, /** @type {string} */ text) => {
        const fb = entry.fonts.get(fontObj)?.substitute;
        if (!fb || [...text].length !== 1) return null;
        const gid = fb.font.charToGlyphIndex(text);
        if (!(gid > 0)) return null;
        const glyph = fb.font.glyphs.get(gid);
        if (!glyph || !(glyph.advanceWidth >= 0)) return null;
        return {
          tag: fb.tag,
          gid,
          advEm: glyph.advanceWidth / fb.font.unitsPerEm,
          sizeMult: fb.sizeMult,
          stretch: fb.stretch,
          family: fb.family,
          styleKey: fb.styleKey,
          ascent: fb.metrics ? fb.metrics.ascent : undefined,
          descent: fb.metrics ? fb.metrics.descent : undefined,
        };
      },
    };
  }

  /**
   * A glyph as the line editor draws it.
   * @param {PositionedChar} c
   * @returns {LineGlyph}
   */
  #lineGlyph(c) {
    const fill = c.textColor ? colorToRgb(c.textColor) : null;
    /** @type {LineGlyph} */
    const g = {
      text: c.text,
      penX: c.x,
      penY: c.y,
      widthPx: c.width,
      sizePx: c.fontSize,
      fontObjNum: Number.isFinite(c._font?.fontObjNum) ? c._font.fontObjNum : null,
      fillColor: fill ? rgbToHex(fill) : '#000000',
      skew: c.skew || 0,
      stretch: c.stretch || 0,
    };
    if (c._font?.widthsUnreliable) g.widthsUnreliable = true;
    const face = substituteFaceByObjNum(/** @type {ObjectCache} */ (this.#objCache), g.fontObjNum);
    if (face) g.face = face;
    if ((c.renderMode === 1 || c.renderMode === 2) && c.strokeWidthPx > 0) {
      g.renderMode = c.renderMode;
      g.strokeWidthPx = c.strokeWidthPx;
      const stroke = c.strokeColor ? colorToRgb(c.strokeColor) : null;
      if (stroke) g.strokeColor = rgbToHex(stroke);
    }
    return g;
  }

  /** @type {Map<number, Promise<?import('./glyphResolve.js').EditFontProgram>>} */
  #editPrograms = new Map();

  /**
   * The glyphs of a page's words as the content stream draws them.
   * @param {{ pageIndex: number, dpi: number, records: ?Array<ContentEdit>, words: Array<TextEditWordSpec> }} args
   *   `dpi` must be the resolution the words' pens were recorded at.
   * @returns {Promise<LineState>}
   */
  async getLineState({
    pageIndex, dpi, records, words: specs,
  }) {
    const { glyphOpMap } = await this.#opMappedPage(pageIndex, dpi, records);
    const located = locateWords(glyphOpMap, specs);
    const words = located.map((found, wi) => (found ? { id: specs[wi].id, glyphs: found.chars.map((c) => this.#lineGlyph(c)) } : null));
    /** @type {LineState['hide']} */
    let hide = null;
    if (located.every((w) => w)) {
      const { plans } = planTextEdit(glyphOpMap, { kind: 'delete', words: specs });
      const { edits, folded } = editsFromPlans(glyphOpMap, plans);
      const foldedIds = new Set(folded.map((r) => r.id));
      hide = [
        ...(records || []).filter((r) => r && !foldedIds.has(r.id)),
        ...[...edits].map(([streamIdx, list]) => /** @type {TextPatch} */ ({
          type: 'patchText', id: `hide${streamIdx}`, stream: glyphOpMap.streams[streamIdx].stream, edits: list,
        })),
      ];
    }
    return { words, hide };
  }

  /**
   * The glyphs of a line as a replacement of it would draw them, for the editor's preview.
   * @param {{ pageIndex: number, dpi: number, records: ?Array<ContentEdit>, req: import('./textPatch.js').TextEditRequest }} args
   * @returns {Promise<TextEditPreview>}
   */
  async previewTextEdit({
    pageIndex, dpi, records, req,
  }) {
    const entry = await this.#opMappedPage(pageIndex, dpi, records);
    const { glyphOpMap } = entry;
    const found = locateWords(glyphOpMap, req.words);
    if (found.some((w) => !w)) return { refused: `The page's stream has no glyphs at the pens of ${req.words.filter((w, i) => !found[i]).map((w) => w.id).join(', ')}.` };
    const {
      plans, predictedWords, refused, faces,
    } = planTextEdit(glyphOpMap, { ...req, ...(await this.#codeInputs(entry, pageIndex, found)) });
    if (refused) return { refused };
    const { scale } = glyphOpMap;
    const extraFonts = faces && faces.length > 0
      ? parsePageFonts(`<</Resources<</Font<<${substituteFaceResourceEntries(this.#objCache, [{ type: 'patchText', fonts: faces }])}>>>>>>`, this.#objCache)
      : new Map();
    /** @type {Map<number, { chars: Array<PositionedChar>, ops: Array<ShowOp> }>} */
    const rewritten = new Map();
    for (const [opIdx, plan] of plans) {
      const stream = glyphOpMap.streams[plan.op.streamIdx];
      rewritten.set(opIdx, executeRewrittenOperator(glyphOpMap, plan.op, rewriteShowOperator(plan.op, stream.tokens, plan.actions, plan.pens), extraFonts, scale));
    }
    /** @type {Map<number, Array<PositionedChar>>} */
    const untouched = new Map();
    for (const chars of glyphOpMap.words.values()) {
      for (const c of chars) {
        if (!c._src) continue;
        const list = untouched.get(c._src.op) || [];
        untouched.set(c._src.op, list);
        list.push(c);
      }
    }
    /** @type {(opIdx: number) => { chars: Array<PositionedChar>, ops: Array<ShowOp> }} */
    const poolOf = (opIdx) => {
      const run = rewritten.get(opIdx);
      return run ? { chars: run.chars, ops: run.ops } : { chars: untouched.get(opIdx) || [], ops: glyphOpMap.ops };
    };
    /** @type {TextEditPreview['words']} */
    const words = [];
    for (const p of predictedWords || []) {
      const op = glyphOpMap.ops[p.op];
      let { chars: pool, ops } = poolOf(p.op);
      let start = -1;
      let best = Infinity;
      pool.forEach((c, i) => {
        if (!c._src) return;
        const d = Math.abs(c._src.tx - p.pen[0]) + Math.abs(c._src.ty - p.pen[1]);
        if (d < best) { best = d; start = i; }
      });
      if (start < 0 || best > 0.5 * Math.abs(op.fontSize)) return { refused: `"${p.text}" has no glyph at its pen in the preview.` };
      const target = p.text.toLowerCase();
      /** @type {Array<PositionedChar>} */
      const glyphs = [];
      /** @type {Array<Array<ShowOp>>} */
      const opsOf = [];
      let spelled = '';
      let opIdx = p.op;
      let i = start;
      while (spelled.length < target.length) {
        if (i >= pool.length) {
          // A word the page draws with more than one show operator continues in the next operator of the same stream.
          opIdx += 1;
          if (opIdx >= glyphOpMap.ops.length || glyphOpMap.ops[opIdx].streamIdx !== op.streamIdx) break;
          ({ chars: pool, ops } = poolOf(opIdx));
          i = 0;
          continue;
        }
        const c = pool[i];
        i += 1;
        if (c.text.trim() === '') { if (glyphs.length === 0) continue; break; }
        glyphs.push(c);
        opsOf.push(ops);
        spelled += ocr.replaceLigatures(c.text).toLowerCase();
      }
      if (spelled !== target) return { refused: `"${p.text}" previews as "${spelled}".` };
      if (glyphs.some((c, k) => c._src && !glyphVisible(opsOf[k][c._src.op], c._src))) return { refused: `"${p.text}" would run past the edge of what the page shows.` };
      words.push({ text: p.text, oldId: p.oldId, glyphs: glyphs.map((c) => this.#lineGlyph(c)) });
    }
    return { words };
  }

  /**
   * Turn a deletion or a replacement of a line's words into content-stream patch records.
   * A re-parse of the patched page must show every glyph outside the edit unmoved and a replaced line that reads back as typed, or the edit is refused.
   * @param {{ pageIndex: number, dpi: number, records: ?Array<ContentEdit>, req: import('./textPatch.js').TextEditRequest, groupId?: string }} args
   * @returns {Promise<TextEditResult>}
   */
  async applyTextEdit({
    pageIndex, dpi, records, req, groupId,
  }) {
    const recs = (records || []).filter((r) => r && r.type === 'patchText');
    const before = await this.#opMappedPage(pageIndex, dpi, recs);
    const { glyphOpMap, pageObj: beforePage } = before;
    const foundWords = locateWords(glyphOpMap, req.words);
    const missingIds = req.words.filter((w, i) => !foundWords[i]).map((w) => w.id);
    if (missingIds.length > 0) return { refused: `The page's stream has no glyphs at the pens of ${missingIds.join(', ')}.` };
    const request = req.kind === 'replace' ? { ...req, ...(await this.#codeInputs(before, pageIndex, foundWords)) } : req;
    const {
      plans, located, twinIds, dropped, wordGlyphs, predictedWords, refused, faces,
    } = planTextEdit(glyphOpMap, request);
    if (refused) return { refused };
    if (plans.size === 0) return { unchanged: true };
    const { edits, folded } = editsFromPlans(glyphOpMap, plans);
    // The cached map's segments hold the records of the parse that built it, so a folded record is matched by id.
    const foldedIds = new Set(folded.map((r) => r.id));
    // A folded record's faces stay declared, since glyphs of its edits that survive the fold still draw with them.
    /** @type {Map<string, NonNullable<TextPatch['fonts']>[number]>} */
    const fonts = new Map();
    for (const r of folded) for (const f of r.fonts || []) fonts.set(recordFaceTag(f), f);
    for (const f of faces || []) {
      fonts.set(f.tag, Number.isFinite(f.ascent) && Number.isFinite(f.descent)
        ? {
          family: f.family, styleKey: f.styleKey, ascent: /** @type {number} */ (f.ascent), descent: /** @type {number} */ (f.descent),
        }
        : { family: f.family, styleKey: f.styleKey });
    }
    /** @type {Array<TextPatch>} */
    const newRecords = [];
    for (const [streamIdx, list] of edits) {
      /** @type {TextPatch} */
      const rec = {
        type: 'patchText', id: getRandomAlphanum(10), stream: glyphOpMap.streams[streamIdx].stream, edits: list,
      };
      if (groupId) rec.groupId = groupId;
      if (fonts.size > 0) rec.fonts = [...fonts.values()];
      newRecords.push(rec);
    }

    // A replacement leaves every glyph of the replaced line's operators, patched or not, out of the before/after glyph comparison, since glyphs after the changed word move by design.
    // The read-back of the changed words below checks that line instead.
    /** @type {(map: GlyphOpMap, opIdx: number) => string} */
    const originOf = (map, opIdx) => {
      const op = map.ops[opIdx];
      const seg = segmentAt(map.streams[op.streamIdx].segments, op.start);
      if (!seg) return `${op.streamIdx}:?`;
      return `${op.streamIdx}:${seg.rec ? seg.origStart : seg.origStart + (op.start - seg.start)}`;
    };
    /** @type {Set<string>} */
    const lineOrigins = new Set();
    if (req.kind === 'replace') {
      for (const d of wordGlyphs) if (d._src) lineOrigins.add(originOf(glyphOpMap, d._src.op));
      for (const opIdx of plans.keys()) lineOrigins.add(originOf(glyphOpMap, opIdx));
    }
    const touched = new Set([...wordGlyphs, ...dropped]);
    if (req.kind === 'replace') {
      for (const d of glyphOpMap.glyphs) {
        if (d._src && lineOrigins.has(originOf(glyphOpMap, d._src.op))) touched.add(d);
      }
    }
    // Glyphs are compared at the pen the stream drew them at, in user space, not at the parser's position.
    // A duplicate-glyph merge moves the survivor onto the later copy, so the parser's position changes with which copy an edit leaves standing.
    const TOL = 0.02;
    /** @type {(map: GlyphOpMap, c: PositionedChar) => [number, number]} */
    const drawnAt = (map, c) => (c._src ? drawnPen(map.ops[c._src.op], c._src.tx, c._src.ty) : [c.x, c.y]);
    /** @type {Map<string, Array<{ c: PositionedChar, at: [number, number] }>>} */
    const expected = new Map();
    for (const d of glyphOpMap.glyphs) {
      if (touched.has(d)) continue;
      const k = charStateKey(d);
      let list = expected.get(k);
      if (!list) { list = []; expected.set(k, list); }
      list.push({ c: d, at: drawnAt(glyphOpMap, d) });
    }
    const after = await this.#opMappedPage(pageIndex, dpi, [...recs.filter((r) => !foldedIds.has(r.id)), ...newRecords]);
    const kept = new Set();
    if (req.kind === 'replace') {
      for (const d of after.glyphOpMap.glyphs) {
        if (d._src && lineOrigins.has(originOf(after.glyphOpMap, d._src.op))) kept.add(d);
      }
    }
    /** @type {Map<string, Array<{ c: PositionedChar, at: [number, number] }>>} */
    const actual = new Map();
    for (const d of after.glyphOpMap.glyphs) {
      if (kept.has(d)) continue;
      const k = charStateKey(d);
      let list = actual.get(k);
      if (!list) { list = []; actual.set(k, list); }
      list.push({ c: d, at: drawnAt(after.glyphOpMap, d) });
    }
    const describe = (/** @type {PositionedChar} */ c) => `"${c.text}" at ${c.x.toFixed(2)},${c.y.toFixed(2)} size ${c.fontSize.toFixed(2)}`;
    for (const [k, list] of expected) {
      const candidates = (actual.get(k) || []).slice();
      for (const e of list) {
        const j = candidates.findIndex((a) => Math.abs(a.at[0] - e.at[0]) <= TOL && Math.abs(a.at[1] - e.at[1]) <= TOL && Math.abs(a.c.fontSize - e.c.fontSize) <= TOL);
        if (j === -1) return { refused: `A glyph outside the edited words changed: ${describe(e.c)} is not drawn there after the edit.` };
        candidates.splice(j, 1);
      }
      if (candidates.length > 0) return { refused: `The patched page draws a glyph the source did not: ${describe(candidates[0].c)}.` };
      actual.delete(k);
    }
    if (actual.size > 0) {
      const [list] = actual.values();
      return { refused: `The patched page draws a glyph the source did not: ${describe(list[0].c)}.` };
    }

    if (req.kind === 'delete') {
      const twins = twinIds.map((id) => {
        const chars = /** @type {Array<PositionedChar>} */ (glyphOpMap.words.get(id));
        return { penX: chars.map((c) => Math.round(c.x * 1000) / 1000), baselineY: Math.round(chars[0].y * 1000) / 1000 };
      });
      return { records: newRecords, foldedIds: [...foldedIds], twins };
    }

    /** @type {Map<string, OcrWord>} */
    const byId = new Map();
    for (const line of after.pageObj.lines) for (const word of line.words) byId.set(word.id, word);
    // Words are matched by the user-space pen of their first glyph, because cells that set their own transform can share a text-space pen.
    /** @type {Map<number, Array<[string, [number, number]]>>} */
    const byFirstPen = new Map();
    for (const [id, chars] of after.glyphOpMap.words) {
      if (chars.length === 0 || !chars[0]._src || !byId.has(id)) continue;
      const pen = drawnPen(after.glyphOpMap.ops[chars[0]._src.op], chars[0]._src.tx, chars[0]._src.ty);
      const key = Math.round(pen[0] * 1000);
      let list = byFirstPen.get(key);
      if (!list) { list = []; byFirstPen.set(key, list); }
      list.push([id, pen]);
    }
    const PEN_TOL = 0.005;
    /** @type {Array<string>} */
    const lineWordIds = [];
    for (const p of predictedWords || []) {
      const pen = drawnPen(glyphOpMap.ops[p.op], p.pen[0], p.pen[1]);
      const k = Math.round(pen[0] * 1000);
      const candidates = [k - 1, k, k + 1].flatMap((key) => byFirstPen.get(key) || [])
        .filter(([, at]) => Math.abs(at[0] - pen[0]) <= PEN_TOL && Math.abs(at[1] - pen[1]) <= PEN_TOL)
        .map(([id]) => id);
      const hit = candidates.find((id) => /** @type {OcrWord} */ (byId.get(id)).text === p.text);
      if (!hit) {
        const found = candidates.map((id) => /** @type {OcrWord} */ (byId.get(id)).text);
        return { refused: `"${p.text}" reads back ${found.length ? `as "${found.join('", "')}"` : 'as nothing'} at its pen.` };
      }
      lineWordIds.push(hit);
    }
    // A hole a deletion leaves can push the words after it onto a line of their own.
    // A grown word can pull a table cell or column beside it into the line.
    const afterLine = /** @type {OcrLine} */ (after.pageObj.lines.find((line) => line.words.some((word) => word.id === lineWordIds[0])));
    const split = lineWordIds.find((id) => !afterLine.words.some((word) => word.id === id));
    if (split) return { refused: `The line would split before "${/** @type {OcrWord} */ (byId.get(split)).text}".` };
    /** @type {(map: GlyphOpMap, id: string) => ?string} */
    const penKeyOf = (map, id) => {
      const chars = map.words.get(id);
      if (!chars || chars.length === 0 || !chars[0]._src) return null;
      const pen = drawnPen(map.ops[chars[0]._src.op], chars[0]._src.tx, chars[0]._src.ty);
      return `${Math.round(pen[0] * 100)}:${Math.round(pen[1] * 100)}`;
    };
    const beforeIds = new Set(located.filter((w) => w).map((w) => /** @type {{parseId: string}} */ (w).parseId));
    const beforeLine = beforePage.lines.find((line) => line.words.some((word) => beforeIds.has(word.id)));
    const beforePens = new Set((beforeLine ? beforeLine.words : []).map((word) => penKeyOf(glyphOpMap, word.id)).filter((k) => k));
    const merged = afterLine.words.filter((word) => !lineWordIds.includes(word.id) && !beforePens.has(penKeyOf(after.glyphOpMap, word.id)));
    if (merged.length > 0) return { refused: `The line would merge with the text beside it ("${merged.map((word) => word.text).join(' ')}").` };
    for (const id of lineWordIds) {
      for (const c of after.glyphOpMap.words.get(id) || []) {
        if (c._src && !glyphVisible(after.glyphOpMap.ops[c._src.op], c._src)) return { refused: `"${/** @type {OcrWord} */ (byId.get(id)).text}" would run past the edge of what the page shows.` };
      }
    }
    const invisible = lineWordIds.find((id) => !after.nativeText[id]);
    if (invisible) return { refused: `"${/** @type {OcrWord} */ (byId.get(invisible)).text}" reads back as text the page does not show.` };
    const lineWords = lineWordIds.map((id, i) => {
      const word = /** @type {OcrWord} */ (byId.get(id));
      return {
        oldId: /** @type {Array<{oldId: ?string}>} */ (predictedWords)[i].oldId,
        text: word.text,
        bbox: { ...word.bbox },
        chars: (word.chars || []).map((c) => ({ text: c.text, bbox: { ...c.bbox } })),
        style: { ...word.style },
        lang: word.lang,
        entry: after.nativeText[id],
      };
    });
    return { records: newRecords, foldedIds: [...foldedIds], lineWords };
  }

  /**
   * Render a single page to an image data URL, a JPEG/WebP blob, or a transferable ImageBitmap.
   * @param {{ pageIndex: number, colorMode: string, dpi?: number, targetWidth?: number,
   * outputFormat?: 'png'|'jpeg'|'webp'|'bitmap', quality?: number,
   * edits?: ?RenderEdits }} args - `targetWidth` renders the page exactly that many pixels wide, taking precedence over `dpi`.
   * @returns {Promise<{ dataUrl?: string, blob?: Blob, bitmap?: ImageBitmap, colorMode: string, ok: boolean, failReason?: string, failDetail?: string,
   *   perf?: { prepMs: number, drawMs: number, decodeMs: number, flushMs: number } }>}
   */
  async renderPage({
    pageIndex, colorMode, dpi, targetWidth, outputFormat = 'png', quality = 0.6, edits = null,
  }) {
    if (!this.#objCache || !this.#pages) throw new Error('PDF not loaded');
    // Lazy import so the renderer stays out of main-thread bundles that never render in-process.
    const { renderPdfPageAsImage } = await import('./renderPdfPage.js');
    if (typeof process !== 'undefined') await ca.getCanvasNode();
    const page = this.#pages[pageIndex];
    const box = page.cropBox || page.mediaBox;
    if (targetWidth) {
      // Deriving dpi from the same box/rotate floats renderPdfPageAsImage sizes its canvas from is what makes its ceil land on exactly `targetWidth`.
      const widthPts = Math.abs(box[2] - box[0]);
      const heightPts = Math.abs(box[3] - box[1]);
      const visualWidthPts = page.rotate === 90 || page.rotate === 270 ? heightPts : widthPts;
      dpi = (72 * targetWidth) / visualWidthPts;
    }
    return renderPdfPageAsImage(page.objText, this.#objCache, box, pageIndex, colorMode, page.rotate, dpi, outputFormat, quality, edits);
  }

  /**
   * Every Type 3 font in the file with the outline hash of the glyph bound to each character code.
   * @returns {{ fonts: Array<{ objNum: number, codes: number[], hashes: Array<?string>, blank: boolean[] }> }}
   *   `hashes[i]` is null when the procedure bound to `codes[i]` could not be read.
   *   `blank[i]` marks a procedure that draws nothing.
   */
  getType3GlyphHashes() {
    if (!this.#objCache) throw new Error('PDF not loaded');
    const fonts = [];
    for (const [objNum, info] of enumerateType3Fonts(this.#objCache)) {
      const codes = [];
      const hashes = [];
      const blank = [];
      for (const [codeStr, name] of Object.entries(info.encoding)) {
        const glyph = info.glyphs[name];
        codes.push(Number(codeStr));
        hashes.push(glyph?.pathHash ?? null);
        blank.push(!glyph || glyph.bbox === null);
      }
      fonts.push({
        objNum, codes, hashes, blank,
      });
    }
    return { fonts };
  }

  /**
   * The font program the renderer draws the given embedded font with, plus the cascade inputs native-text editing needs.
   * @param {{ fontObjNum: number, pageIndex?: number }} args - `pageIndex` is a page the font is used on, letting this instance resolve a font from a page it never parsed.
   * @returns {Promise<?{ kind: 'original'|'rebuilt'|'type3'|'none', bytes?: ArrayBuffer, allGlyphsEmpty?: boolean,
   *   glyphs?: Array<{ name: string, codes: number[], text: ?string, pathHash: ?string, hasOutline: boolean }>,
   *   baseName: string, familyName: string, bold: boolean, italic: boolean, serifFlag: boolean|null, capHeightPdf: ?number, xHeightPdf: ?number }>}
   *   `kind: 'none'` means the font has no usable embedded program, so editing must fall back the same way the renderer did.
   *   `kind: 'type3'` is a program built from a Type 3 font's CharProcs, which the Inspect panel draws with but edited text does not.
   *   `glyphs` names each CharProc with the codes that reach it and the text they extract as.
   *   Null means the `fontObjNum` is unknown.
   */
  async getFontBytes({ fontObjNum, pageIndex }) {
    if (!this.#objCache) throw new Error('PDF not loaded');
    let fontObj = this.#objCache.fontCache.get(fontObjNum);
    if (!fontObj && pageIndex !== undefined && this.#pages?.[pageIndex]) {
      this.parsePage({ pageIndex, dpi: 300 });
      fontObj = this.#objCache.fontCache.get(fontObjNum);
    }
    if (!fontObj) return null;
    if (!this.#objCache.fontBytesCache.has(fontObjNum) && !this.#objCache.fontConversionCache.has(fontObjNum)) {
      const { registerFontForEditing } = await import('./renderPdfPage.js');
      if (typeof process !== 'undefined') await ca.getCanvasNode();
      await registerFontForEditing(fontObj, this.#objCache);
    }
    // The program's glyphs answer to the text the parser gave each code, so the words it extracted draw in the font's own glyphs.
    // That text is often a private-use placeholder rather than a real character.
    if (fontObj.type3 && !this.#objCache.fontBytesCache.has(fontObjNum)) {
      const t3 = fontObj.type3;
      const overrides = new Map();
      const table = [];
      const taken = new Set();
      for (const name of Object.keys(t3.charProcObjNums)) {
        const info = t3.glyphs[name];
        const hasOutline = !!(info && info.commands && info.commands.some((c) => c.type === 'L' || c.type === 'C'));
        const codes = Object.entries(t3.encoding).filter(([, n]) => n === name).map(([c]) => Number(c)).sort((a, b) => a - b);
        const unicodes = [];
        for (const code of codes) {
          const text = fontObj.toUnicode.get(code);
          if (!text || [...text].length !== 1) continue;
          const cp = /** @type {number} */ (text.codePointAt(0));
          if (taken.has(cp)) continue;
          taken.add(cp);
          unicodes.push(cp);
        }
        // A placeholder d1 carries no usable advance, so the glyph's own ink sets the width instead.
        const advanceWidth = info && info.placeholderD1 && info.bbox && info.bbox.x1 > 0 ? info.bbox.x1 + Math.max(0, info.bbox.x0) : (info ? info.advanceWidth : 0);
        overrides.set(name, { unicodes, advanceWidth });
        table.push({
          name, codes, text: codes.length ? (fontObj.toUnicode.get(codes[0]) ?? null) : null, pathHash: (info && info.pathHash) || null, hasOutline,
        });
      }
      const objText = this.#objCache.getObjectText(fontObjNum);
      const built = objText && table.some((g) => g.hasOutline) ? buildType3OpentypeFont(objText, this.#objCache, overrides) : null;
      if (built) {
        const file = built.fontFile;
        this.#objCache.fontBytesCache.set(fontObjNum, { bytes: file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength), kind: 'type3', glyphs: table });
      }
    }
    const meta = {
      baseName: fontObj.baseName,
      familyName: fontObj.familyName,
      bold: !!fontObj.bold,
      italic: !!fontObj.italic,
      serifFlag: fontObj.serifFlag ?? null,
      capHeightPdf: fontObj.capHeightPdf ?? null,
      xHeightPdf: fontObj.xHeightPdf ?? null,
    };
    const entry = this.#objCache.fontBytesCache.get(fontObjNum);
    if (!entry) return { kind: 'none', ...meta };
    const allGlyphsEmpty = !!(fontObj.allGlyphsEmpty
      || this.#objCache.fontConversionCache.get(fontObjNum)?.allGlyphsEmpty);
    // Copied so the postMessage transfer can never detach the cached buffer.
    return {
      kind: entry.kind, bytes: entry.bytes.slice(0), allGlyphsEmpty, ...meta, ...(entry.glyphs ? { glyphs: entry.glyphs } : {}),
    };
  }

  /**
   * The decoded bytes of an embedded file stream (a portfolio member or a plain attachment), by the object number `doc.attachments.files[].objNum` carries.
   * @param {{ objNum: number }} args
   * @returns {?{ bytes: ArrayBuffer }} A fresh buffer, so the postMessage transfer can never detach cached data.
   *   Null when the object is not a readable stream.
   */
  getEmbeddedFileBytes({ objNum }) {
    if (!this.#objCache) throw new Error('PDF not loaded');
    const bytes = this.#objCache.getStreamBytes(objNum);
    if (!bytes) return null;
    return { bytes: bytes.slice().buffer };
  }

  /**
   * Release `_pdf_d${docId}_*` fonts (Node + browser registries) and clear the parsed document state.
   */
  async unload() {
    if (!this.#objCache) return;
    const { docId } = this.#objCache;
    const prefix = `_pdf_d${docId}_`;
    ca.unregisterFontsMatching((name) => name.startsWith(prefix));
    unregisterFontFacesMatching((family) => family.startsWith(prefix));
    // Free decoded-image bitmaps retained for the document's lifetime.
    const imgCache = this.#objCache.decodedImageCache;
    if (imgCache) {
      for (const entry of imgCache.values()) ca.closeDrawable(entry.bitmap);
      imgCache.clear();
      this.#objCache.decodedImageCacheBytes = 0;
    }
    this.#objCache = null;
    this.#pages = null;
    this.#linkDestInfo = null;
    this.#editPrograms.clear();
    this.#opMappedPages.clear();
  }
}
