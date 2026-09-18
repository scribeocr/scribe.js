import { leadingLineNumber, clusterPeaks } from './analyzeLayout.js';

/** @typedef {import('../objects/ocrObjects.js').OcrPage} OcrPage */
/** @typedef {import('../objects/ocrObjects.js').OcrLine} OcrLine */

const MAX_VALUE = 40;
const MAX_START = 3;
const MIN_RUN = 5;
const STRONG_RUN = 8;
const FULL_RUN = 20;
const LOCK_RUNS = 3;
const HEAD_PITCHES = 6;
const FOOT_PITCHES = 6;
const LABEL_KEEP_SHARE = 0.5;
const LABEL_COMPILATION_SHARE = 0.75;
const TAIL_RUNS = 2;
/** A first character `leadingLineNumber` can skip before a number: white space it trims or one of its leader dots. */
const LEAD_CHAR_RE = /^[\s·•∙⋅‧․]/;

/**
 * Assigns `pageNum` and `lineNum` to every line of a layer in place.
 * Pass every page of the layer in one call, since a number column is recognized only when it recurs across pages.
 * @param {Array<?OcrPage>} pages - A layer's pages.
 */
export function assignPageLineNums(pages) {
  /** @type {Array<PageInfo>} */
  const infos = [];
  /** @type {Array<Region>} */
  const runs = [];
  // An upper bound on the strong runs the candidates can form, so a document that cannot lock a column leaves before any geometry.
  // A strong run spans eight rows in steps of at most three, so it has at least four members, at least half outside tables, one at 3 or less and one at 7 or more.
  // The last bound is 7, not 8, because a stacked token's digits can start a run at 0.
  let strongCap = 0;
  for (let n = 0; n < pages.length; n++) {
    const pg = pages[n];
    if (!pg || !pg.lines) continue;
    const dims = pg.dims || { width: 0, height: 0 };
    let hMed = -1;
    /** @type {Array<Cand>} */
    const cands = [];
    /** @type {Array<Cand>} */
    const trailing = [];
    // On a document without numbered paper nearly every line leaves at the first-character test, so no costlier test belongs before it.
    for (const line of pg.lines) {
      line.lineNum = null; line.pageNum = null;
      const first = line.words[0];
      if (!first) continue;
      const t = first.text || '';
      const c = t.charCodeAt(0);
      if ((c > 32 && c < 48) || (c > 57 && c < 128)) continue;
      if (c >= 48 && c <= 57) {
        // Rejects only tokens neither `leadingLineNumber` nor the timestamp test can read: five or more digits, or a digit followed by a visible ASCII character other than a colon.
        let k = 1;
        while (k < t.length && t.charCodeAt(k) >= 48 && t.charCodeAt(k) <= 57) k++;
        if (k === t.length) { if (k > 4) continue; } else { const ck = t.charCodeAt(k); if (ck > 32 && ck < 128 && ck !== 58) continue; }
      } else if (!LEAD_CHAR_RE.test(t)) continue;
      // An OCR engine can read two or three stacked margin numbers as one tall token ("123"), which becomes one candidate per digit.
      // The width test keeps out a number printed in a tall font, which is wider than it is tall.
      if (line.words.length === 1 && (first.bbox.right - first.bbox.left) * t.length <= 0.9 * (first.bbox.bottom - first.bbox.top)
        && /^\d{2,3}$/.test(t) && [...t].every((ch, i, a) => i === 0 || +ch === +a[i - 1] + 1)) {
        if (hMed < 0) {
          const heights = new Float64Array(pg.lines.length);
          for (let i = 0; i < pg.lines.length; i++) heights[i] = pg.lines[i].bbox.bottom - pg.lines[i].bbox.top;
          heights.sort();
          hMed = heights[Math.floor(heights.length / 2)] || 1;
        }
        if (first.bbox.bottom - first.bbox.top >= 1.8 * hMed) {
          const h = (first.bbox.bottom - first.bbox.top) / t.length;
          for (let i = 0; i < t.length; i++) {
            const v = +t[i];
            cands.push({
              line: null, orientation: line.orientation || 0, value: v, x: first.bbox.left, xr: first.bbox.right, h, cy: first.bbox.top + (i + 0.5) * h, inTable: false,
            });
          }
          continue;
        }
      }
      // An OCR engine can join a row's text to the next mini-page's margin number across a condensed sheet's gutter.
      const last = line.words[line.words.length - 1];
      if (line.words.length >= 3 && last) {
        const lt = last.text || ''; const lc = lt.charCodeAt(0);
        if (lc >= 48 && lc <= 57 && /^\d{1,2}$/.test(lt) && +lt >= 1 && +lt <= MAX_VALUE
          && last.bbox.left - line.bbox.left >= 0.3 * (line.orientation % 2 ? dims.height : dims.width) && leadingLineNumber(line)) {
          const lastBox = last.bbox;
          trailing.push({
            line: null, orientation: line.orientation || 0, value: +lt, x: lastBox.left, xr: lastBox.right, h: lastBox.bottom - lastBox.top, cy: (lastBox.top + lastBox.bottom) / 2, inTable: false,
          });
        }
      }
      const stamped = line.words.length > 1 && /^\d{1,2}:\d{2}(:\d{2})?$/.test(t.trim());
      const lead = leadingLineNumber(stamped ? { words: line.words.slice(1) } : line);
      if (!lead || lead.value < 1 || lead.value > MAX_VALUE) continue;
      // The row's center is the number token's, since extraction can join two stacked numbers into one line.
      const numBox = line.words[lead.wordIndex + (stamped ? 1 : 0)].bbox;
      const cy = (numBox.top + numBox.bottom) / 2;
      const cx = (line.bbox.left + line.bbox.right) / 2;
      const inTable = !!pg.tableBoxes && pg.tableBoxes.some((b) => cx >= b.left && cx <= b.right && cy >= b.top && cy <= b.bottom);
      cands.push({
        line, orientation: line.orientation || 0, value: lead.value, x: numBox.left, xr: numBox.right, h: numBox.bottom - numBox.top, cy, inTable,
      });
    }
    for (const c of trailing) cands.push(c);
    if (cands.length < MIN_RUN) continue;
    // A page reads in the frame most of its lines are stored in, so a line stored in another frame (a stamp along the edge, a sideways margin note) is neither a row nor a label.
    const oc = [0, 0, 0, 0];
    for (const l of pg.lines) oc[l.orientation || 0]++;
    const orientation = oc.indexOf(Math.max(...oc));
    const W = orientation % 2 ? dims.height : dims.width;
    const kept = oc[orientation] === pg.lines.length ? cands : cands.filter((c) => c.orientation === orientation);
    if (kept.length < MIN_RUN || !W) continue;
    let low = 0; let high = 0; let nonTable = 0;
    for (const c of kept) { if (c.value <= MAX_START) low++; if (c.value >= STRONG_RUN - 1) high++; if (!c.inTable) nonTable++; }
    if (hMed < 0) {
      const heights = new Float64Array(pg.lines.length);
      for (let i = 0; i < pg.lines.length; i++) heights[i] = pg.lines[i].bbox.bottom - pg.lines[i].bbox.top;
      heights.sort();
      hMed = heights[Math.floor(heights.length / 2)] || 1;
    }
    const xTol = Math.max(1.5 * hMed, 0.015 * W);
    infos.push({
      index: infos.length, page: pg, orientation, width: W, xTol, cands: kept, cols: [], regions: [], tailRuns: 0,
    });
    strongCap += Math.min(low, high, Math.floor(kept.length / 4), Math.floor(nonTable / 2));
  }
  if (strongCap < LOCK_RUNS) return;

  for (const info of infos) {
    for (const peak of clusterPeaks(info.cands.map((c) => c.xr), info.xTol)) {
      const col = info.cands.filter((c) => Math.abs(c.xr - peak.center) <= info.xTol).sort((a, b) => a.cy - b.cy);
      info.cols.push({ xFrac: peak.center / info.width, col });
      for (const members of runsOf(col, null)) runs.push(makeRegion(info, members));
    }
  }
  if (!runs.length) return;

  // Runs away from a column where strong runs recur across the document are dropped, which keeps numbered lists, index columns and tables out.
  const tolFrac = median(infos.map((i) => i.xTol / i.width));
  /** @type {Array<Region>} */
  const accepted = [];
  const accept = (r) => { accepted.push(r); infos[r.infoIndex].regions.push(r); };
  /** @type {Array<{xFrac: number, pitch: number, firstCys: Array<number>}>} */
  const locked = [];
  for (const peak of clusterPeaks(runs.map((r) => r.xFrac), tolFrac)) {
    const at = runs.filter((r) => Math.abs(r.xFrac - peak.center) <= tolFrac);
    const strong = at.filter((r) => r.rows.length >= STRONG_RUN && r.rows[0].n <= MAX_START && !r.inTable);
    if (strong.length < LOCK_RUNS) continue;
    const topCy = Math.min(...strong.map((r) => r.firstCy));
    const pitch = median(strong.map((r) => r.pitch));
    // The column's first-row heights, one per stacked mini-page.
    locked.push({ xFrac: peak.center, pitch, firstCys: clusterPeaks(strong.map((r) => r.firstCy - (r.rows[0].n - 1) * pitch), 2 * pitch).map((c) => c.center) });
    for (const r of at) {
      if (r.rows.length >= MIN_RUN && r.rows[0].n <= MAX_START) accept(r);
      // A count that starts past row 3 is the tail of a page begun on the previous sheet when a fresh count follows just below it.
      // A count that lost its first numbers to extraction is not one, since its missing rows fit above it on the grid.
      else if (r.rows.length >= MIN_RUN && r.firstCy - (r.rows[0].n - 1) * r.pitch < topCy - 0.5 * r.pitch
        && at.some((o) => o.infoIndex === r.infoIndex && o.rows[0].n <= MAX_START && o.firstCy > r.lastCy && o.firstCy - r.lastCy < 5 * r.pitch)) infos[r.infoIndex].tailRuns++;
    }
  }
  if (!locked.length) return;
  // Once the document is numbered paper, a full count at any other x is a page set at its own margin (a certificate or errata page).
  const lockAccepted = new Set(accepted);
  for (const r of runs) if (!lockAccepted.has(r) && r.rows.length >= FULL_RUN && r.rows[0].n <= MAX_START && !r.inTable && !locked.some((l) => Math.abs(l.xFrac - r.xFrac) <= tolFrac)) accept(r);
  // A locked column's candidates are cut into runs again with the column's pitch known, which lets a count cross misread numbers at its start.
  for (const info of infos) {
    for (const l of locked) {
      const c = info.cols.find((x) => Math.abs(x.xFrac - l.xFrac) <= tolFrac);
      if (!c) continue;
      for (const members of runsOf(c.col, l.pitch)) {
        const r = makeRegion(info, members);
        if (r.rows.length < MIN_RUN) continue;
        // A count that starts a few rows down, at the height the grid gives that row, lost its first numbers to extraction.
        // A printed page's tail starts at the first-row height instead, so it stays out.
        const s0 = r.rows[0].n;
        const onGrid = s0 <= 8 && l.firstCys.some((f) => Math.abs(r.firstCy - (f + (s0 - 1) * l.pitch)) <= 0.8 * l.pitch);
        const covered = info.regions.filter((a) => Math.abs(a.xFrac - l.xFrac) <= tolFrac);
        if (covered.length) {
          // A second count in the column is another mini-page only when it lies clear of the first and starts on the grid, which keeps out a list numbered down a one-up page.
          if (onGrid && !covered.some((a) => a.firstCy <= r.lastCy && a.lastCy >= r.firstCy)) accept(r);
        } else if (s0 <= MAX_START || onGrid) accept(r);
      }
    }
  }
  for (const r of accepted) {
    const s0 = r.rows[0].n;
    if (s0 === 1 || s0 > 8) continue;
    const l = locked.filter((x) => Math.abs(x.xFrac - r.xFrac) <= tolFrac).find((x) => x.firstCys.some((f) => Math.abs(r.firstCy - (f + (s0 - 1) * x.pitch)) <= 0.8 * x.pitch));
    if (!l) continue;
    const head = [];
    for (let v = 1; v < s0; v++) head.push({ n: v, cy: r.firstCy - (s0 - v) * l.pitch });
    r.rows = head.concat(r.rows);
    r.firstCy = r.rows[0].cy;
    r.headRows = head.length;
  }
  // A video-synced transcript can print its count twice on the same rows, a plain column beside a timestamped one.
  for (const info of infos) {
    info.regions.sort((a, b) => a.xFrac - b.xFrac);
    for (let i = 0; i + 1 < info.regions.length; i++) {
      const a = info.regions[i]; const b = info.regions[i + 1];
      const overlap = Math.min(a.lastCy, b.lastCy) - Math.max(a.firstCy, b.firstCy);
      if (b.xFrac - a.xFrac >= 0.2 || overlap < 0.5 * Math.min(a.lastCy - a.firstCy, b.lastCy - b.firstCy)) continue;
      if (b.rows.length > a.rows.length) { a.rows = b.rows; a.firstCy = b.firstCy; a.lastCy = b.lastCy; a.pitch = b.pitch; }
      a.colRight = Math.max(a.colRight, b.colRight);
      info.regions.splice(i + 1, 1);
      i--;
    }
  }
  // A transcript printed from a text file breaks its pages mid-sheet, so a page's number below its last row would read as the next page's header.
  const midSheetBreaks = infos.filter((i) => i.tailRuns > 0).length >= TAIL_RUNS;
  /** @type {Array<number>} */
  const docCols = [];
  for (const l of locked.slice().sort((a, b) => a.xFrac - b.xFrac)) if (!docCols.length || l.xFrac - docCols[docCols.length - 1] >= 0.2) docCols.push(l.xFrac);

  /** @type {Array<{info: PageInfo, line: OcrLine, home: Home, cands: Array<{v: number, pageForm: boolean}>}>} */
  const labelLines = [];
  /** @type {Map<OcrLine, Home>} */
  const rehomed = new Map();
  /** @type {Map<OcrLine, Home>} */
  const homes = new Map();
  let headOnly = 0; let footOnly = 0;
  for (const info of infos) {
    if (!info.regions.length) continue;
    const W = info.width;
    // A page's columns include the document's, so a region ends where the next column would begin even when that mini-page holds no count.
    // A document column near one of the page's own counts is left out, so a page set at its own margin keeps a single column.
    const pageXs = info.regions.map((r) => r.xFrac);
    const colXs = clusterPeaks([...pageXs, ...docCols.filter((x) => !pageXs.some((px) => Math.abs(px - x) < 0.2))], tolFrac).map((p) => p.center);
    for (const r of info.regions) r.col = colXs.findIndex((x) => Math.abs(x - r.xFrac) <= tolFrac);
    // A scanned sheet's lower mini-page can sit a little to the side of the upper one, so two close columns whose counts never share a height are one column.
    for (let c = 1; c < colXs.length; c++) {
      const upper = info.regions.filter((r) => r.col === c - 1); const lower = info.regions.filter((r) => r.col === c);
      if (!upper.length || !lower.length || colXs[c] - colXs[c - 1] >= 0.06 || upper.some((a) => lower.some((b) => a.firstCy <= b.lastCy && a.lastCy >= b.firstCy))) continue;
      for (const r of info.regions) if (r.col >= c) r.col--;
      colXs.splice(c, 1); c--;
    }
    // Nothing lies left of the first column but that page's own margin, where a verso page prints its label.
    for (const r of info.regions) if (r.col === 0) r.xLeft = 0;
    // A column's regions share the leftmost of their left edges, so the columns tile the page and no label falls between them.
    for (const r of info.regions) r.xLeft = Math.min(...info.regions.filter((o) => o.col === r.col).map((o) => o.xLeft));
    for (const r of info.regions) {
      const next = info.regions.filter((o) => o.col === r.col + 1);
      const nextX = colXs[r.col + 1];
      r.xRight = next.length ? Math.min(...next.map((o) => o.xLeft)) : (nextX == null ? W : nextX * W - 2 * info.xTol);
    }
    let rowIdx = -1; let rowBottom = -Infinity;
    for (const r of info.regions.slice().sort((a, b) => a.firstCy - b.firstCy)) {
      if (r.firstCy > rowBottom) rowIdx++;
      rowBottom = Math.max(rowBottom, r.lastCy);
      r.row = rowIdx;
    }
    if (midSheetBreaks) continue;
    for (const line of info.page.lines) {
      if ((line.orientation || 0) !== info.orientation) continue;
      let home = homeOf(info, line, line.bbox.left);
      homes.set(line, home);
      if (home.body || (!home.head && !home.foot)) continue;
      // A page number right-aligned to a mini-page's edge can start inside the next column's range.
      const r0 = home.head || home.foot;
      if (r0.col > 0 && line.bbox.right < r0.colRight - 0.5 * info.xTol) {
        const prev = info.regions.find((o) => o.col === r0.col - 1);
        if (prev) { home = homeOf(info, line, prev.xLeft); rehomed.set(line, home); }
        if (home.body || (!home.head && !home.foot)) continue;
      }
      const r = home.head || home.foot;
      const h = line.bbox.bottom - line.bbox.top;
      // A band line is read in chains split at wide gaps, so a bare folio at the right end of a running head stands alone.
      /** @type {Array<Array<{t: string, w: import('../objects/ocrObjects.js').OcrWord}>>} */
      const chains = [];
      let prevW = null;
      for (const w of line.words) {
        const t = (w.text || '').replace(/^[·•∙⋅‧․]+|[·•∙⋅‧․]+$/g, '').trim();
        if (!t) continue;
        if (!chains.length || (prevW && w.bbox.left - prevW.bbox.right > 2.5 * h)) chains.push([]);
        const fused = /^(page|pg\.?|p\.)[:.]?(\d{1,4})$/i.exec(t);
        if (fused) chains[chains.length - 1].push({ t: fused[1], w }, { t: fused[2], w }); else chains[chains.length - 1].push({ t, w });
        prevW = w;
      }
      /** @type {Array<{v: number, pageForm: boolean}>} */
      const cands = [];
      for (const toks of chains) {
        if (toks.some(({ t }) => /^\(?pages\b/i.test(t))) continue; // the sheet footer "2 (Pages 2 - 5)"
        if (/\(\s*\d+\s*[-–]\s*\d+\s*\)/.test(toks.map(({ t }) => t).join(' '))) continue; // the sheet footer "Page: 17 (65 - 68)"
        const bareChain = toks.every(({ t }) => /^\d{1,4}$/.test(t) || /^[-–—[\]()]+$/.test(t));
        // A court's filing stamp ("Document 12-3 filed 01/02/23 ... pg 4 of 17") counts the filing's sheets, and its "of 17" can wrap to the next line.
        // An exhibit or appendix reference ("Exhibit B, Page 18") paginates the binder.
        const stamp = toks.some(({ t }) => /^(filed|document|ex\.?|exh\.?|exhibit|app\.?|appendix|appx\.?|attachment|att\.?|tab)$/i.test(t.replace(/,$/, '')));
        for (let i = 0; i < toks.length; i++) {
          const t = toks[i].t.replace(/^[-–—[\]()]+|[-–—[\]()]+$/g, '');
          // A leading zero marks a Bates or exhibit number, except the four-digit padding of a transcript printed from its ASCII file ("0004").
          if (!/^\d{1,4}$/.test(t) || (/^0\d/.test(t) && t.length !== 4)) continue;
          const v = parseInt(t, 10);
          if (v < 1) continue;
          const prev = i > 0 ? toks[i - 1].t : ''; const nextTok = i + 1 < toks.length ? toks[i + 1].t : '';
          if (/^of$/i.test(nextTok) || /^of$/i.test(prev)) continue; // "Page 3 of 120" counts sheets
          const pageForm = /^(page|pg\.?|p\.)[:.]?$/i.test(prev) && !stamp;
          if (!pageForm && !bareChain) continue;
          if (!pageForm && t.length === 4 && v >= 1900 && v <= 2100) continue;
          // A bare integer in the number column's own x-range is a row number above the run, unless it is too large or too long to be one.
          const wx = (toks[i].w.bbox.left + toks[i].w.bbox.right) / 2;
          if (!pageForm && v <= MAX_VALUE && t.length < 4 && wx >= r.colLeft - info.xTol && wx <= r.colRight + info.xTol) continue;
          cands.push({ v, pageForm });
        }
      }
      if (!cands.length) continue;
      labelLines.push({
        info, line, home, cands,
      });
      // On a stacked sheet a candidate above the topmost region or below the lowest is unambiguous.
      if (info.regions.length > 1) { if (!home.foot) headOnly++; else if (!home.head) footOnly++; }
    }
  }
  const docFoot = footOnly > headOnly;
  for (const {
    info, line, home, cands,
  } of labelLines) {
    const b = bandOf(home, info.regions.length === 1, docFoot);
    if (!b) continue;
    const r = b.region;
    const cyLine = (line.bbox.top + line.bbox.bottom) / 2;
    const dist = Math.abs((b.band === 'foot' ? cyLine - r.lastCy : r.firstCy - cyLine) / r.pitch);
    for (const c of cands) {
      r.labelCands.push({
        v: c.v, pageForm: c.pageForm, foot: b.band === 'foot', dist,
      });
    }
  }
  // The other band is read only when the document's band offers nothing, since an exhibit or filing stamp there ("Page 962") paginates the filing.
  for (const info of infos) {
    for (const r of info.regions) {
      const pref = r.labelCands.filter((c) => c.foot === docFoot);
      let cands = pref.length ? pref : r.labelCands;
      // Below the rows, a candidate more than a pitch farther down than the nearest is a filing's number, whatever its form.
      const below = cands.filter((c) => c.foot);
      if (below.length) { const d = Math.min(...below.map((c) => c.dist)); cands = cands.filter((c) => !c.foot || c.dist <= d + 1); }
      // Within each form only the values nearest the rows compete, since an appendix, binder or Bates number sits farther out at the sheet's edge.
      const near = (list) => { const d = list.length ? Math.min(...list.map((c) => c.dist)) : 0; return new Set(list.filter((c) => c.dist <= d + 0.5).map((c) => c.v)); };
      const pageVals = near(cands.filter((c) => c.pageForm));
      const bareVals = near(cands.filter((c) => !c.pageForm));
      if (pageVals.size === 1) { r.label = [...pageVals][0]; r.labelForm = 'page'; } else if (pageVals.size === 0 && bareVals.size === 1) { r.label = [...bareVals][0]; r.labelForm = 'bare'; }
      if (r.label != null) r.labelFoot = cands.some((c) => c.v === r.label && c.foot);
    }
  }

  // A sheet whose own labels allow exactly one order, column-major or row-major, reads in it, since a document can bind sheets printed both ways.
  const colKey = (a, b) => a.col - b.col || a.row - b.row;
  const rowKey = (a, b) => a.row - b.row || a.col - b.col;
  const inc = (labeled, key) => labeled.slice().sort(key).every((r, i, a) => i === 0 || r.label > a[i - 1].label);
  const sheetOrder = infos.map((info) => {
    const labeled = info.regions.filter((r) => r.label != null);
    return labeled.length < 2 ? null : [inc(labeled, colKey), inc(labeled, rowKey)];
  });
  const colMajor = sheetOrder.filter((o) => o && o[0]).length; const rowMajor = sheetOrder.filter((o) => o && o[1]).length;
  /** @type {Array<Region>} */
  const ordered = [];
  for (const info of infos) {
    const o = sheetOrder[info.index];
    const useRow = o && o[0] !== o[1] ? o[1] : rowMajor > colMajor;
    ordered.push(...info.regions.slice().sort(useRow ? rowKey : colKey));
  }

  // Labels must strictly increase in reading order, so a label outside the longest increasing subsequence is dropped as a misread or duplicate.
  // A compilation of excerpts bound out of order, labeled "Page N" throughout, also keeps every label that is unique in the document.
  const labeled = ordered.filter((r) => r.label != null);
  if (labeled.length) {
    const tails = []; const tailIdx = []; const prevIdx = new Array(labeled.length).fill(-1);
    for (let i = 0; i < labeled.length; i++) {
      const v = labeled[i].label;
      let lo = 0; let hi = tails.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < v) lo = mid + 1; else hi = mid; }
      // A repeated label keeps its later occurrence, unless only the earlier one is in the document's band, as when an errata page repeats the number of the page it corrects.
      const prevR = tails[lo] === v ? labeled[tailIdx[lo]] : null;
      if (!prevR || prevR.labelFoot !== docFoot || labeled[i].labelFoot === docFoot) { tails[lo] = v; tailIdx[lo] = i; }
      prevIdx[i] = lo > 0 ? tailIdx[lo - 1] : -1;
    }
    const keep = new Set();
    for (let i = tailIdx[tails.length - 1]; i >= 0; i = prevIdx[i]) keep.add(i);
    const share = keep.size / labeled.length;
    const counts = new Map();
    for (const r of labeled) counts.set(r.label, (counts.get(r.label) || 0) + 1);
    const compilation = share < LABEL_COMPILATION_SHARE && labeled.every((r) => r.labelForm === 'page');
    for (let i = 0; i < labeled.length; i++) {
      if (keep.has(i) && (compilation || share >= LABEL_KEEP_SHARE)) continue;
      if (compilation && counts.get(labeled[i].label) === 1) continue;
      labeled[i].label = null;
    }
  }

  for (const info of infos) {
    if (!info.regions.length) continue;
    const single = info.regions.length === 1;
    // The line a row's own number was read from is that row's, however tall an engine drew it and wherever its center falls.
    const ownRow = new Map();
    for (const r of info.regions) for (const x of r.rows) if (x.line) ownRow.set(x.line, { r, n: x.n });
    for (const line of info.page.lines) {
      if ((line.orientation || 0) !== info.orientation) continue;
      const own = ownRow.get(line);
      if (own) { line.lineNum = own.n; if (own.r.label != null) line.pageNum = String(own.r.label); continue; }
      const b = bandOf(rehomed.get(line) || homes.get(line) || homeOf(info, line, line.bbox.left), single, docFoot);
      if (!b) continue;
      const r = b.region;
      if (r.label != null) line.pageNum = String(r.label);
      if (b.band !== 'body') continue;
      if (line.bbox.bottom - line.bbox.top > 1.5 * r.pitch) continue;
      // Text set between two double-spaced numbers belongs to the number before it.
      const cy = (line.bbox.top + line.bbox.bottom) / 2;
      let lo = 0; let hi = r.rows.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (r.rows[mid].cy - 0.4 * r.pitch <= cy) lo = mid; else hi = mid - 1; }
      line.lineNum = r.rows[lo].n;
    }
  }
}

/**
 * @typedef {Object} Cand
 * @property {?OcrLine} line - the line the number leads, or `null` when that line is not the row's text (a stacked token, a number ending another mini-page's line)
 * @property {number} orientation - the frame the number's line is stored in
 * @property {number} value
 * @property {number} x - left edge of the number token
 * @property {number} xr - right edge of the number token
 * @property {number} h - height of the number token
 * @property {number} cy - vertical center of the number
 * @property {boolean} inTable
 */

/**
 * @typedef {Object} PageInfo
 * @property {number} index - position in the pass's `PageInfo` list, which skips pages without candidates
 * @property {OcrPage} page
 * @property {number} orientation - the frame the page reads in, the one most of its lines are stored in
 * @property {number} width - width of that frame
 * @property {number} xTol
 * @property {Array<Cand>} cands - candidates in the page's frame
 * @property {Array<{xFrac: number, col: Array<Cand>}>} cols - candidate columns on this page, each sorted by center
 * @property {Array<Region>} regions - accepted regions on this page
 * @property {number} tailRuns - runs on this page that start mid-count at a locked column
 */

/**
 * @typedef {Object} Region - One accepted run: one printed page, or one printed page's part of a sheet.
 * @property {number} infoIndex
 * @property {number} xFrac - the number column's right edge as a fraction of the page's frame width
 * @property {number} colLeft
 * @property {number} colRight
 * @property {number} xLeft - left edge of the region
 * @property {number} xRight - right edge of the region
 * @property {number} firstCy
 * @property {number} lastCy
 * @property {number} pitch
 * @property {boolean} inTable - most members lie inside a detected table
 * @property {Array<{n: number, cy: number, line?: ?OcrLine}>} rows
 * @property {number} [headRows] - rows restored above the count's first number
 * @property {number} col
 * @property {number} row
 * @property {?number} label
 * @property {?('page'|'bare')} labelForm - how the label was printed: "Page N" or a bare integer
 * @property {boolean} labelFoot - the label was read below the last row
 * @property {Array<{v: number, pageForm: boolean, foot: boolean, dist: number}>} labelCands - dist in pitches from the nearest row
 */

/**
 * Cuts one column of candidates into runs of values counting down the page.
 * @param {Array<Cand>} col - sorted by center
 * @param {?number} priorPitch - the column's row pitch when known from the rest of the document
 * @returns {Array<Array<Cand>>} member lists of at least two candidates
 */
function runsOf(col, priorPitch) {
  /** @type {Array<Array<Cand>>} */
  const out = [];
  /** @type {?{members: Array<Cand>, dys: Array<number>, skipped: number}} - dys are the single-step gaps, kept sorted */
  let run = null;
  const close = () => {
    if (run && run.members.length >= 2) out.push(run.members);
    run = null;
  };
  for (let i = 0; i < col.length; i++) {
    const c = col[i];
    if (!run) { run = { members: [c], dys: [], skipped: -1 }; continue; }
    const prev = run.members[run.members.length - 1];
    const dy = c.cy - prev.cy;
    const dv = c.value - prev.value;
    // A known column pitch overrides the run's own gaps, since a certificate page sets its numbers at half, single and double steps.
    const nd = run.dys.length;
    const pitch = priorPitch != null ? priorPitch : (nd ? (nd % 2 ? run.dys[(nd - 1) / 2] : (run.dys[nd / 2 - 1] + run.dys[nd / 2]) / 2) : null);
    // The same row's number a second time (drawn twice, or once alone and once fused into its text) is not a step.
    if (Math.abs(dy) < 0.4 * (pitch != null ? pitch : Math.max(prev.h, c.h))) continue;
    let fits = false;
    if (pitch == null) {
      const h = Math.max(prev.h, c.h);
      fits = dv === 1 && dy >= 0.7 * h && dy <= 6 * h;
    } else if (dv === 1) {
      fits = dy >= 0.4 * pitch && dy <= 2.5 * pitch;
    } else if (dv === 2 || dv === 3) {
      fits = Math.abs(dy - dv * pitch) <= 0.5 * pitch;
    }
    if (fits) {
      run.members.push(c);
      if (dv === 1) { let k = run.dys.length; while (k > 0 && run.dys[k - 1] > dy) k--; run.dys.splice(k, 0, dy); }
      run.skipped = -1;
      continue;
    }
    if (pitch != null && dy >= 0.4 * pitch && dy <= 2.5 * pitch && run.skipped < 0) { run.skipped = i; continue; }
    const restart = run.skipped;
    close();
    // The candidate that ended the run starts the next one, unless a skipped member was really the next run's start (25 then 1 on a stacked sheet).
    i = (restart >= 0 ? restart : i) - 1;
  }
  close();
  return out;
}

/**
 * @param {PageInfo} info
 * @param {Array<Cand>} members
 * @returns {Region}
 */
function makeRegion(info, members) {
  const dys = [];
  for (let i = 1; i < members.length; i++) if (members[i].value === members[i - 1].value + 1) dys.push(members[i].cy - members[i - 1].cy);
  const pitch = dys.length ? median(dys) : (members[members.length - 1].cy - members[0].cy) / (members[members.length - 1].value - members[0].value);
  /** @type {Array<{n: number, cy: number, line?: OcrLine}>} */
  const rows = [];
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    if (i > 0) {
      const prev = members[i - 1];
      for (let v = prev.value + 1; v < m.value; v++) rows.push({ n: v, cy: prev.cy + ((m.cy - prev.cy) * (v - prev.value)) / (m.value - prev.value) });
    }
    rows.push({ n: m.value, cy: m.cy, line: m.line });
  }
  const xrs = members.map((m) => m.xr).sort((a, b) => a - b);
  const colLeft = Math.min(...members.map((m) => m.x));
  const colRight = Math.max(...members.map((m) => m.xr));
  return {
    infoIndex: info.index,
    xFrac: xrs[Math.floor(xrs.length / 2)] / info.width,
    colLeft,
    colRight,
    xLeft: colLeft - info.xTol,
    xRight: info.width,
    firstCy: rows[0].cy,
    lastCy: rows[rows.length - 1].cy,
    pitch,
    inTable: members.filter((m) => m.inTable).length * 2 > members.length,
    rows,
    headRows: 0,
    col: 0,
    row: 0,
    label: null,
    labelForm: null,
    labelFoot: false,
    labelCands: [],
  };
}

/**
 * @typedef {Object} Home - Where a line stands among the regions of its column.
 * @property {?Region} body - the region whose rows the line lies on
 * @property {?Region} head - the region whose first row lies within HEAD_PITCHES below the line
 * @property {?Region} foot - the region whose last row lies within FOOT_PITCHES above the line
 */

/**
 * @param {PageInfo} info
 * @param {OcrLine} line
 * @param {number} x - the x that picks the line's column, normally its left edge
 * @returns {Home}
 */
function homeOf(info, line, x) {
  const cy = (line.bbox.top + line.bbox.bottom) / 2;
  let px = x;
  if (!info.regions.some((r) => x >= r.xLeft && x < r.xRight)) px = (line.bbox.left + line.bbox.right) / 2;
  /** @type {?Region} */
  let head = null;
  /** @type {?Region} */
  let foot = null;
  for (const r of info.regions) {
    if (px < r.xLeft || px >= r.xRight) continue;
    // A label can sit a third of a pitch from the first or last row, so the head and foot bands start there.
    // A label-shaped line above the first number actually read is the page's label, even inside a restored row's band.
    const restored = r.headRows && cy < r.rows[r.headRows].cy - 0.3 * r.pitch && /^(page|pg\.?|p\.)?[:.]?\s*-?\s*\d{1,4}\s*-?$/i.test(line.words.map((w) => w.text).join(' ').trim());
    if (!restored && cy >= r.firstCy - 0.3 * r.pitch && cy <= r.lastCy + 0.3 * r.pitch) return { body: r, head: null, foot: null };
    const dTop = (r.firstCy - cy) / r.pitch; const dBot = (cy - r.lastCy) / r.pitch;
    if (dTop > 0 && dTop <= HEAD_PITCHES && (!head || dTop < (head.firstCy - cy) / head.pitch)) head = r;
    if (dBot > 0 && dBot <= FOOT_PITCHES && (!foot || dBot < (cy - foot.lastCy) / foot.pitch)) foot = r;
  }
  return { body: null, head, foot };
}

/**
 * Picks the region and band a line is read in.
 * @param {Home} home
 * @param {boolean} single - the page holds one region
 * @param {boolean} docFoot - the document prints its page numbers below the rows
 * @returns {?{region: Region, band: 'body'|'head'|'foot'}}
 */
function bandOf(home, single, docFoot) {
  if (home.body) return { region: home.body, band: 'body' };
  // A document that prints its page numbers below the rows reads only foot bands, so a short page's folio never becomes the next mini-page's header.
  if (docFoot) return home.foot ? { region: home.foot, band: 'foot' } : null;
  if (home.head) return { region: home.head, band: 'head' };
  // Otherwise a foot band is read only on a single-region page, so a sheet's own footer never labels a mini-page.
  if (home.foot && single) return { region: home.foot, band: 'foot' };
  return null;
}

/** @param {Array<number>} arr */
function median(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  if (!s.length) return 0;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
