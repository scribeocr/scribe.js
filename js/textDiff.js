import ocr from './objects/ocrObjects.js';

/**
 * @typedef {Object} TextDiffSide
 * @property {?number} pageN - The page of this side's words, 0-indexed, or null when the side has nothing.
 * @property {Array<string>} wordIds
 * @property {string} text - The words joined by spaces, as written.
 * @property {?string} anchorId - On a side with nothing, the id of this document's word that follows the change, or null at the end; null on a side with words.
 */

/**
 * @typedef {Object} TextDiffChange
 * @property {number} n - The change's number in reading order, from 1.
 * @property {'replaced'|'added'|'removed'|'page'} kind - `page` is a page whose words are nearly all removed, or added.
 * @property {TextDiffSide} a
 * @property {TextDiffSide} b
 */

/**
 * @typedef {Object} TextDiffLine
 * @property {{pageN: number, wordId: string}} a - A line of the first document: its page and the id of the word it is paired on.
 * @property {{pageN: number, wordId: string}} b - That word's counterpart in the second document.
 */

/**
 * @typedef {Object} TextDiff
 * @property {Array<TextDiffChange>} changes
 * @property {Array<{a: ?number, b: ?number}>} pages - The page pairs the diff aligned, with null where a page has no counterpart.
 * @property {Array<TextDiffLine>} lines - Every line of the first document that shares an unchanged run of three or more words with the second, paired on the first such word.
 *   The lines of a page change are left out.
 */

/**
 * @typedef {Object} TextDiffOptions
 * @property {boolean} [ignoreCap=false]
 * @property {boolean} [ignorePunct=false] - Compare words without the punctuation at their edges.
 * @property {boolean} [ignoreSegmentation=true] - Treat a run of words as equal to a run that holds the same characters split differently.
 */

/**
 * @typedef {Object} DiffToken
 * @property {string} key
 * @property {string} id
 * @property {string} text
 * @property {number} pageN
 * @property {boolean} lineEnd
 */

/** @typedef {{op: 'equal'|'del'|'ins', ai: number, bi: number}} DiffOp */
/** @typedef {{key: string, pageN: number, tokens: Array<DiffToken>}} DiffLine */

const CONTENT_RE = /[\p{L}\p{N}]/u;
const NUMBER_RE = /^\p{Nd}+$/u;
const ROMAN_RE = /^(?=[ivxlc])c{0,3}(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/i;
const PAGE_WORD_RE = /^(page|p\.|pg\.?|of)$/i;
const PAGE_CHANGE_SHARE = 0.9;
/** The worst-case memory of `myers` grows with the square of this limit. */
const MAX_EDITS = 3000;

/**
 * @param {string} text
 * @param {{ignoreCap: boolean, ignorePunct: boolean}} opt
 * @returns {string}
 */
function normalizeWord(text, opt) {
  let t = ocr.asciiPunctuation(ocr.replaceLigatures(text));
  if (opt.ignoreCap) t = t.toLowerCase();
  if (opt.ignorePunct) t = t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  return t;
}

/**
 * @param {Array<string>} a
 * @param {Array<string>} b
 * @param {number} [maxD]
 * @returns {?Array<DiffOp>} Null when the diff needs more than `maxD` edits.
 */
function myers(a, b, maxD = MAX_EDITS) {
  const n = a.length; const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  if (!n) return b.map((_, j) => ({ op: 'ins', ai: 0, bi: j }));
  if (!m) return a.map((_, i) => ({ op: 'del', ai: i, bi: 0 }));
  const limit = Math.min(max, maxD);
  /** @type {Array<Int32Array>} */
  const reaches = [];
  const v = new Int32Array(2 * limit + 4);
  const off = limit + 2;
  let found = false;
  for (let d = 0; d <= limit && !found; d++) {
    reaches.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
      else x = v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      v[off + k] = x;
      if (x >= n && y >= m) { found = true; break; }
    }
  }
  if (!found) return null;
  /** @type {Array<DiffOp>} */
  const ops = [];
  let x = n; let y = m;
  for (let d = reaches.length - 1; d >= 0; d--) {
    const vd = reaches[d]; const base = d + 1;
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && vd[base + k - 1] < vd[base + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vd[base + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { x -= 1; y -= 1; ops.push({ op: 'equal', ai: x, bi: y }); }
    if (d > 0) {
      if (x === prevX) { y -= 1; ops.push({ op: 'ins', ai: x, bi: y }); } else { x -= 1; ops.push({ op: 'del', ai: x, bi: y }); }
    }
  }
  ops.reverse();
  return ops;
}

/**
 * @param {Array<string>} aKeys
 * @param {Array<string>} bKeys
 * @returns {Array<DiffOp>}
 */
function diffKeys(aKeys, bKeys) {
  const inA = new Set(aKeys); const inB = new Set(bKeys);
  /** @type {Array<number>} */ const idxA = [];
  /** @type {Array<number>} */ const idxB = [];
  aKeys.forEach((k, i) => { if (inB.has(k)) idxA.push(i); });
  bKeys.forEach((k, i) => { if (inA.has(k)) idxB.push(i); });
  // Only shared keys go to `myers`, so keys on one side alone do not count against its edit limit.
  const shared = myers(idxA.map((i) => aKeys[i]), idxB.map((i) => bKeys[i])) || [];
  /** @type {Array<DiffOp>} */
  const ops = [];
  let a = 0; let b = 0;
  /** @param {number} to */
  const dropA = (to) => { while (a < to) { ops.push({ op: 'del', ai: a, bi: b }); a += 1; } };
  /** @param {number} to */
  const dropB = (to) => { while (b < to) { ops.push({ op: 'ins', ai: a, bi: b }); b += 1; } };
  for (const op of shared) {
    if (op.op === 'equal') {
      dropA(idxA[op.ai]); dropB(idxB[op.bi]);
      ops.push({ op: 'equal', ai: a, bi: b }); a += 1; b += 1;
    } else if (op.op === 'del') {
      dropA(idxA[op.ai]);
      ops.push({ op: 'del', ai: a, bi: b }); a += 1;
    } else {
      dropB(idxB[op.bi]);
      ops.push({ op: 'ins', ai: a, bi: b }); b += 1;
    }
  }
  dropA(aKeys.length); dropB(bKeys.length);
  return ops;
}

/**
 * The longest chain of anchors in which the second index rises.
 * @param {Array<[number, number]>} cand - Anchors sorted by their first index.
 * @returns {Array<[number, number]>}
 */
export function longestChain(cand) {
  /** @type {Array<number>} */
  const tails = [];
  /** @type {Array<number>} */
  const prev = new Array(cand.length).fill(-1);
  for (let i = 0; i < cand.length; i++) {
    const j = cand[i][1];
    let lo = 0; let hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cand[tails[mid]][1] < j) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const chain = [];
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) chain.push(cand[i]);
  return chain.reverse();
}

/**
 * @param {Array<DiffLine>} A
 * @param {Array<DiffLine>} B
 * @returns {Array<DiffOp>}
 */
function diffLines(A, B) {
  /** @type {Array<DiffOp>} */
  const ops = [];
  /** @param {number} a0 @param {number} a1 @param {number} b0 @param {number} b1 */
  const walk = (a0, a1, b0, b1) => {
    while (a0 < a1 && b0 < b1 && A[a0].key === B[b0].key) { ops.push({ op: 'equal', ai: a0, bi: b0 }); a0 += 1; b0 += 1; }
    const tail = [];
    while (a1 > a0 && b1 > b0 && A[a1 - 1].key === B[b1 - 1].key) { a1 -= 1; b1 -= 1; tail.push({ op: 'equal', ai: a1, bi: b1 }); }
    if (a0 < a1 && b0 < b1) {
      const countA = new Map(); const countB = new Map();
      for (let i = a0; i < a1; i++) countA.set(A[i].key, (countA.get(A[i].key) || 0) + 1);
      for (let j = b0; j < b1; j++) countB.set(B[j].key, (countB.get(B[j].key) || 0) + 1);
      const posB = new Map();
      for (let j = b0; j < b1; j++) if (countB.get(B[j].key) === 1 && countA.get(B[j].key) === 1) posB.set(B[j].key, j);
      /** @type {Array<[number, number]>} */
      const cand = [];
      for (let i = a0; i < a1; i++) { const j = posB.get(A[i].key); if (j !== undefined) cand.push([i, j]); }
      if (cand.length) {
        let pa = a0; let pb = b0;
        for (const [i, j] of longestChain(cand)) { walk(pa, i, pb, j); ops.push({ op: 'equal', ai: i, bi: j }); pa = i + 1; pb = j + 1; }
        walk(pa, a1, pb, b1);
      } else {
        const sub = myers(A.slice(a0, a1).map((l) => l.key), B.slice(b0, b1).map((l) => l.key));
        if (sub) for (const o of sub) ops.push({ op: o.op, ai: a0 + o.ai, bi: b0 + o.bi });
        else { for (let i = a0; i < a1; i++) ops.push({ op: 'del', ai: i, bi: b0 }); for (let j = b0; j < b1; j++) ops.push({ op: 'ins', ai: a1, bi: j }); }
      }
    } else {
      for (let i = a0; i < a1; i++) ops.push({ op: 'del', ai: i, bi: b0 });
      for (let j = b0; j < b1; j++) ops.push({ op: 'ins', ai: a0, bi: j });
    }
    for (let t = tail.length - 1; t >= 0; t--) ops.push(tail[t]);
  };
  walk(0, A.length, 0, B.length);
  return ops;
}

/**
 * Diff the text of two documents.
 * Decoration and numbering are left out before anything is compared: a word with no letter or digit, and a line that is a page or line number alone.
 * @param {Array<import('./objects/ocrObjects.js').OcrPage>} pagesA
 * @param {Array<import('./objects/ocrObjects.js').OcrPage>} pagesB
 * @param {TextDiffOptions} [options]
 * @returns {TextDiff}
 */
export function diffDocText(pagesA, pagesB, options = {}) {
  const opt = {
    ignoreCap: false, ignorePunct: false, ignoreSegmentation: true, ...options,
  };
  /**
   * @param {Array<import('./objects/ocrObjects.js').OcrPage>} pages
   * @returns {{lines: Array<DiffLine>, pageCount: number}}
   */
  const tokenizeDoc = (pages) => {
    /** @type {Array<DiffLine>} */
    const lines = [];
    for (let pageN = 0; pageN < pages.length; pageN++) {
      const page = pages[pageN];
      if (!page) continue;
      for (const line of page.lines) {
        /** @type {Array<DiffToken>} */
        const tokens = [];
        for (const w of line.words) {
          if (!w.text || !CONTENT_RE.test(w.text)) continue;
          tokens.push({
            key: normalizeWord(w.text, opt), id: w.id, text: w.text, pageN, lineEnd: false,
          });
        }
        if (!tokens.length) continue;
        const numeral = tokens.length === 1 && ROMAN_RE.test(tokens[0].text);
        const pageNumber = tokens.length <= 4 && tokens.some((t) => NUMBER_RE.test(t.text)) && tokens.every((t) => NUMBER_RE.test(t.text) || PAGE_WORD_RE.test(t.text));
        if (numeral || pageNumber) continue;
        tokens[tokens.length - 1].lineEnd = true;
        lines.push({ key: tokens.map((t) => t.key).join(' '), pageN, tokens });
      }
    }
    return { lines, pageCount: pages.length };
  };
  const A = tokenizeDoc(pagesA);
  const B = tokenizeDoc(pagesB);
  const lineOps = diffLines(A.lines, B.lines);

  /** @type {Map<DiffToken, DiffToken>} */
  const twinOf = new Map();
  for (let r = 0; r < lineOps.length;) {
    if (lineOps[r].op !== 'equal') { r += 1; continue; }
    let q = r; let count = 0;
    while (q < lineOps.length && lineOps[q].op === 'equal') { count += A.lines[lineOps[q].ai].tokens.length; q += 1; }
    if (count >= 3) {
      for (let t = r; t < q; t++) {
        const la = A.lines[lineOps[t].ai].tokens; const lb = B.lines[lineOps[t].bi].tokens;
        for (let w = 0; w < la.length && w < lb.length; w++) twinOf.set(la[w], lb[w]);
      }
    }
    r = q;
  }

  /** @type {Array<TextDiffChange>} */
  const changes = [];
  /** @param {Array<DiffToken>} toks @param {?DiffToken} anchor */
  const side = (toks, anchor) => ({
    pageN: toks.length ? toks[0].pageN : null,
    wordIds: toks.map((t) => t.id),
    text: toks.map((t) => t.text).join(' '),
    anchorId: toks.length ? null : (anchor ? anchor.id : null),
  });
  /** @param {Array<DiffToken>} aToks @param {Array<DiffToken>} bToks @param {?DiffToken} anchorA @param {?DiffToken} anchorB */
  const push = (aToks, bToks, anchorA, anchorB) => {
    if (!aToks.length && !bToks.length) return;
    if (opt.ignoreSegmentation && aToks.length && bToks.length) {
      const broken = aToks.some((t) => t.lineEnd && /-$/.test(t.key)) || bToks.some((t) => t.lineEnd && /-$/.test(t.key));
      const joined = (/** @type {Array<DiffToken>} */ toks) => { const j = toks.map((t) => t.key).join(''); return broken ? j.replace(/-/g, '') : j; };
      if (joined(aToks) === joined(bToks)) return;
    }
    const byPage = (/** @type {Array<DiffToken>} */ toks) => {
      /** @type {Array<Array<DiffToken>>} */ const parts = [];
      for (const t of toks) { const last = parts[parts.length - 1]; if (last && last[0].pageN === t.pageN) last.push(t); else parts.push([t]); }
      return parts;
    };
    const aParts = byPage(aToks); const bParts = byPage(bToks);
    for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
      const aPart = aParts[i] || []; const bPart = bParts[i] || [];
      const kind = aPart.length && bPart.length ? 'replaced' : aPart.length ? 'removed' : 'added';
      changes.push({
        n: 0, kind, a: side(aPart, anchorA), b: side(bPart, anchorB),
      });
    }
  };

  let i = 0;
  while (i < lineOps.length) {
    if (lineOps[i].op === 'equal') { i += 1; continue; }
    let j = i;
    /** @type {Array<DiffToken>} */ const aToks = [];
    /** @type {Array<DiffToken>} */ const bToks = [];
    while (j < lineOps.length && lineOps[j].op !== 'equal') {
      if (lineOps[j].op === 'del') aToks.push(...A.lines[lineOps[j].ai].tokens); else bToks.push(...B.lines[lineOps[j].bi].tokens);
      j += 1;
    }
    const after = j < lineOps.length ? lineOps[j] : null;
    const nextA = after ? A.lines[after.ai].tokens[0] : null;
    const nextB = after ? B.lines[after.bi].tokens[0] : null;
    i = j;
    const ops = diffKeys(aToks.map((t) => t.key), bToks.map((t) => t.key));
    // Only equal runs of three or more words count toward `anchored`, because two unrelated passages share words like "the" and "of" at every turn.
    let anchored = 0; let eqRun = 0;
    for (const op of ops) { if (op.op === 'equal') eqRun += 1; else { if (eqRun >= 3) anchored += eqRun; eqRun = 0; } }
    if (eqRun >= 3) anchored += eqRun;
    const shorter = Math.min(aToks.length, bToks.length);
    if (shorter >= 40 && anchored < 0.15 * shorter) { push(aToks, [], nextA, bToks[0]); push([], bToks, nextA, nextB); continue; }
    /** @type {Array<{eq: boolean, a: Array<DiffToken>, b: Array<DiffToken>}>} */
    const segs = [];
    for (const op of ops) {
      const last = segs[segs.length - 1];
      if (op.op === 'equal') {
        if (last && last.eq) { last.a.push(aToks[op.ai]); last.b.push(bToks[op.bi]); } else segs.push({ eq: true, a: [aToks[op.ai]], b: [bToks[op.bi]] });
      } else if (last && !last.eq) {
        if (op.op === 'del') last.a.push(aToks[op.ai]); else last.b.push(bToks[op.bi]);
      } else {
        segs.push({ eq: false, a: op.op === 'del' ? [aToks[op.ai]] : [], b: op.op === 'ins' ? [bToks[op.bi]] : [] });
      }
    }
    /** @type {typeof segs} */
    const merged = [];
    for (let s = 0; s < segs.length; s++) {
      const seg = segs[s];
      if (seg.eq && seg.a.length === 1 && s > 0 && s < segs.length - 1 && !segs[s - 1].eq && !segs[s + 1].eq) {
        const prev = merged[merged.length - 1];
        prev.a.push(...seg.a, ...segs[s + 1].a); prev.b.push(...seg.b, ...segs[s + 1].b);
        s += 1;
        continue;
      }
      merged.push({ eq: seg.eq, a: [...seg.a], b: [...seg.b] });
    }
    for (let s = 0; s < merged.length; s++) {
      const seg = merged[s];
      if (seg.eq) {
        if (seg.a.length >= 3) for (let w = 0; w < seg.a.length && w < seg.b.length; w++) twinOf.set(seg.a[w], seg.b[w]);
        continue;
      }
      const nextEq = merged.slice(s + 1).find((x) => x.eq);
      push(seg.a, seg.b, nextEq ? nextEq.a[0] : nextA, nextEq ? nextEq.b[0] : nextB);
    }
  }

  for (const which of /** @type {Array<'a'|'b'>} */ (['a', 'b'])) {
    const doc = which === 'a' ? A : B;
    const runKind = which === 'a' ? 'removed' : 'added';
    const total = new Map();
    for (const l of doc.lines) total.set(l.pageN, (total.get(l.pageN) || 0) + l.tokens.length);
    const gone = new Map();
    for (const c of changes) if (c.kind === runKind) gone.set(c[which].pageN, (gone.get(c[which].pageN) || 0) + c[which].wordIds.length);
    for (const [pageN, n] of gone) {
      if (n < (total.get(pageN) || 0) * PAGE_CHANGE_SHARE) continue;
      const runs = changes.filter((c) => c.kind === runKind && c[which].pageN === pageN);
      const first = changes.indexOf(runs[0]);
      const other = which === 'a' ? 'b' : 'a';
      /** @type {TextDiffChange} */
      const pc = {
        n: 0, kind: 'page', a: side([], null), b: side([], null),
      };
      pc[which] = {
        pageN, wordIds: runs.flatMap((c) => c[which].wordIds), text: runs.map((c) => c[which].text).join(' '), anchorId: null,
      };
      pc[other].anchorId = runs[0][other].anchorId;
      for (const r of runs) changes.splice(changes.indexOf(r), 1);
      changes.splice(first, 0, pc);
    }
  }

  changes.forEach((c, idx) => { c.n = idx + 1; });

  /** @type {Map<string, number>} */
  const pairVotes = new Map();
  for (const op of lineOps) {
    if (op.op !== 'equal' || A.lines[op.ai].tokens.length < 3) continue;
    const key = `${A.lines[op.ai].pageN}:${B.lines[op.bi].pageN}`;
    pairVotes.set(key, (pairVotes.get(key) || 0) + 1);
  }
  /** @type {Map<number, {pb: number, votes: number}>} */
  const bestFor = new Map();
  for (const [key, votes] of pairVotes) {
    const [pa, pb] = key.split(':').map(Number);
    const cur = bestFor.get(pa);
    if (!cur || votes > cur.votes) bestFor.set(pa, { pb, votes });
  }
  const textOnA = new Set(A.lines.map((l) => l.pageN)); const textOnB = new Set(B.lines.map((l) => l.pageN));
  /** @type {Array<{a: ?number, b: ?number}>} */
  const pages = [];
  let cursorB = 0;
  for (let pa = 0; pa < A.pageCount; pa++) {
    const best = bestFor.get(pa);
    if (!textOnA.has(pa)) {
      if (cursorB < B.pageCount && !textOnB.has(cursorB)) { pages.push({ a: pa, b: cursorB }); cursorB += 1; } else pages.push({ a: pa, b: null });
    } else if (best && best.pb >= cursorB) {
      for (let pb = cursorB; pb < best.pb; pb++) pages.push({ a: null, b: pb });
      pages.push({ a: pa, b: best.pb });
      cursorB = best.pb + 1;
    } else {
      pages.push({ a: pa, b: null });
    }
  }
  for (let pb = cursorB; pb < B.pageCount; pb++) pages.push({ a: null, b: pb });

  const pageGone = { a: new Set(), b: new Set() };
  for (const c of changes) if (c.kind === 'page') pageGone[c.a.wordIds.length ? 'a' : 'b'].add(c.a.wordIds.length ? c.a.pageN : c.b.pageN);
  /** @type {Array<TextDiffLine>} */
  const lines = [];
  for (const la of A.lines) {
    if (pageGone.a.has(la.pageN)) continue;
    const t = la.tokens.find((x) => twinOf.has(x));
    const tb = t ? twinOf.get(t) : null;
    if (!t || !tb || pageGone.b.has(tb.pageN)) continue;
    lines.push({ a: { pageN: la.pageN, wordId: t.id }, b: { pageN: tb.pageN, wordId: tb.id } });
  }
  return { changes, pages, lines };
}
