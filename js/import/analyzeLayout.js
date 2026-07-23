import { OcrPar, OcrLine } from '../objects/ocrObjects.js';
import { quantile, calcBboxUnion, normalizeHeadingText } from '../utils/miscUtils.js';

// Superscript-digit footnote markers are unreliable in CJK text, where ordinary digits get spuriously flagged as superscript, so every digit-convention site skips CJK lines.
// The symbol footnote convention (asterisks, daggers) is script-neutral, so do not extend this gate to it.
const CJK_RE = /[\u1100-\u11FF\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/;

/**
 * Document-level layout analysis and paragraph detection for native-text PDFs, written back onto `pages` in place.
 *
 * @param {Array<OcrPage>} pages - all pages of one document, lines already in reading order.
 * @param {{ debug?: boolean, elementFaithful?: boolean, pdfType?: ("image"|"text"|"ocr") }} [opts]
 * @returns {object} the derived document model, for diagnostics and tests only.
 */
export function analyzeLayout(pages, opts = {}) {
  // Phase 1: per-line feature vectors (one entry per line, across all pages).
  /** @type {Array<LineFeat>} */
  const feats = [];
  // Per-line style-histogram buffers, reused across lines as parallel key/weight arrays.
  // A line carries only a couple of distinct sizes/fonts/colors, so a linear indexOf scan beats five fresh Maps per line.
  const wSzKeys = []; const wSzWts = [];
  const wFamKeys = []; const wFamWts = [];
  const wColKeys = []; const wColWts = [];
  const wParKeys = []; const wParWts = []; const wParRoles = [];
  for (let p = 0; p < pages.length; p++) {
    const page = pages[p];
    const angle = page.angle || 0;
    const sinA = Math.sin(angle * (Math.PI / 180));
    const cosA = Math.cos(angle * (Math.PI / 180));
    const pageH = page.dims?.height || 0;
    const tBoxes = page.tableBoxes && page.tableBoxes.length ? page.tableBoxes : null;
    for (let i = 0; i < page.lines.length; i++) {
      const line = page.lines[i];
      if (!line || !line.words || line.words.length === 0) continue;
      const b = line.bbox;
      // Rotation-corrected horizontal extents (matches reflowPars convention).
      const left = b.left * cosA - sinA * b.bottom;
      const right = b.right * cosA - sinA * b.bottom;

      // Char-weighted dominant size / bold / italic over the line.
      let nChar = 0; let nBold = 0; let nItal = 0; let nArt = 0;
      wSzKeys.length = 0; wSzWts.length = 0;
      wFamKeys.length = 0; wFamWts.length = 0;
      wColKeys.length = 0; wColWts.length = 0;
      // Char-weighted dominant owning structure element (word.structElemId) over the line.
      wParKeys.length = 0; wParWts.length = 0; wParRoles.length = 0;
      // += cons strings pay a flatten-and-copy at the first charCodeAt or regex over the text, so the line text is built flat with one join.
      // A length-reset reused buffer joins slower than a fresh array.
      const wTexts = [];
      for (let w = 0; w < line.words.length; w++) {
        const word = line.words[w];
        const wl = word.text.length || 1;
        nChar += wl;
        if (word.style.bold) nBold += wl;
        if (word.style.italic) nItal += wl;
        if (word.artifact) nArt += wl;
        const sz = word.style.size || 0;
        if (sz) {
          const k = wSzKeys.indexOf(sz);
          if (k >= 0) wSzWts[k] += wl; else { wSzKeys.push(sz); wSzWts.push(wl); }
        }
        const fam = word.style.font || '';
        {
          const k = wFamKeys.indexOf(fam);
          if (k >= 0) wFamWts[k] += wl; else { wFamKeys.push(fam); wFamWts.push(wl); }
        }
        const col = word.style.color || '#000000';
        {
          const k = wColKeys.indexOf(col);
          if (k >= 0) wColWts[k] += wl; else { wColKeys.push(col); wColWts.push(wl); }
        }
        if (word.structElemId != null) {
          const k = wParKeys.indexOf(word.structElemId);
          if (k >= 0) { wParWts[k] += wl; wParRoles[k] = word.structElemTag; } else { wParKeys.push(word.structElemId); wParWts.push(wl); wParRoles.push(word.structElemTag); }
        }
        wTexts.push(word.text);
      }
      const text = wTexts.join(' ');
      let size = 0; let sizeBest = -1;
      for (let k = 0; k < wSzKeys.length; k++) if (wSzWts[k] > sizeBest) { sizeBest = wSzWts[k]; size = wSzKeys[k]; }
      let fontFamily = ''; let famBest = -1;
      for (let k = 0; k < wFamKeys.length; k++) if (wFamWts[k] > famBest) { famBest = wFamWts[k]; fontFamily = wFamKeys[k]; }
      let color = '#000000'; let colorBest = -1;
      for (let k = 0; k < wColKeys.length; k++) if (wColWts[k] > colorBest) { colorBest = wColWts[k]; color = wColKeys[k]; }
      let structId = null; let structBest = -1; let structRoleSel = null;
      for (let k = 0; k < wParKeys.length; k++) if (wParWts[k] > structBest) { structBest = wParWts[k]; structId = wParKeys[k]; structRoleSel = wParRoles[k]; }
      const structResolved = structId != null && nChar > 0 && structBest / nChar >= 0.6;

      let nLetters = 0; let nUpper = 0;
      for (let ci = 0; ci < text.length; ci++) {
        const cc = text.charCodeAt(ci);
        if (cc >= 65 && cc <= 90) { nLetters++; nUpper++; } else if (cc >= 97 && cc <= 122) nLetters++;
      }
      const allCaps = nLetters >= 2 && nUpper / nLetters >= 0.8;

      // Skip trailing footnote reference markers before the terminal-punctuation test, or a reference sitting after the sentence's punctuation defeats it.
      // Both marker forms qualify: a superscript digit/symbol, and the full-size baseline LEXIS "nN" form (a trailing "n4" after the sentence's punctuation).
      let lastIdx = line.words.length - 1;
      while (lastIdx > 0
        && ((line.words[lastIdx].style && line.words[lastIdx].style.sup && /^[\d*†‡]{1,3}$/.test(line.words[lastIdx].text))
          || /^\s*n\d{1,3}\s*$/.test(line.words[lastIdx].text || ''))) lastIdx--;
      const endsTerminal = /[.!?:]["')”’]?\s*$/.test(line.words[lastIdx].text || '');

      feats.push({
        page: p,
        lineIdx: i,
        line,
        left,
        right,
        width: right - left,
        top: b.top,
        bottom: b.bottom,
        height: b.bottom - b.top,
        center: (left + right) / 2,
        size,
        bold: nChar ? nBold / nChar : 0,
        italic: nChar ? nItal / nChar : 0,
        artifact: nChar ? nArt / nChar >= 0.6 : false,
        fontFamily,
        color,
        text,
        nChar,
        allCaps,
        endsTerminal,
        endsLetter: /[A-Za-z0-9]\s*$/.test(text),
        // The class is hyphen-minus, soft hyphen, hyphen, NB hyphen, solidus; the soft hyphen is invisible in source.
        endsHyphen: /[-­‐‑/]\s*$/.test(text),
        startsLower: /^[a-z]/.test(line.words[0].text),
        firstWordWidth: (line.words[0].bbox.right - line.words[0].bbox.left) || 0,
        firstWordSup: !!(line.words[0].style && line.words[0].style.sup),
        dropCap: line.words.length >= 3 && line.words[0].text.length <= 2
          && /^[A-Z]/.test(line.words[0].text)
          && size > 0 && (line.words[0].style.size || 0) >= size * 1.25,
        enumerator: lineEnumerator(line),
        orientation: line.orientation || 0,
        topFrac: pageH ? b.top / pageH : 0,
        bottomFrac: pageH ? b.bottom / pageH : 0,
        // A table's lone-integer cells and leading index column otherwise trip the bare-folio and line-number-column rules and are dropped on export.
        inTable: !!tBoxes && tBoxes.some((bx) => (left + right) / 2 >= bx.left && (left + right) / 2 <= bx.right
          && (b.top + b.bottom) / 2 >= bx.top && (b.top + b.bottom) / 2 <= bx.bottom),
        structId: structResolved ? structId : null,
        structRole: structResolved ? (structRoleSel || null) : null,
        // role and sigKey filled in Phase 3, sizeRatio in Phase 2
        role: 'body',
        sizeRatio: 1,
        sigKey: '',
        // filled in Phase 2:
        colorDistinct: false,
        // filled in Phase 2 (after per-page body family + the familyHeading flag are known):
        familyDistinct: false,
        // filled in Phase 3 setup (list-region detection): a confirmed member of a local list run.
        listConfirmed: false,
        // set by the line-number pass: this whole line is a standalone left-margin line number (case A) -> role 'linenum' -> dropped from reflowed text.
        // (Merged line numbers (case B) instead set OcrWord.lineNum on the leading prefix words and leave the line a body paragraph.)
        lineNum: false,
        // set by the sequence-tracking folio pass: a lone number whose value tracks the page across a contiguous run of pages (a top/bottom page-number folio) -> role 'pagenum',
        // regardless of how far it sits from the physical page edge.
        folio: false,
        // set by the hanging-marker (outdent) pass: this line is a short lead in an outdent column to the left of the body column, with the body text a separate line on the same row.
        // Such a lead is a transcript "Q"/"A"/"BY MR. X" speaker marker or a hanging-indent item lead.
        // It always starts a new paragraph (the mirror of a first-line indent).
        hangMarker: false,
      });
    }
  }

  // Phase 2: document style model.
  /** @type {Map<number, number>} */
  const sizeChars = new Map();
  for (const f of feats) if (f.size) sizeChars.set(f.size, (sizeChars.get(f.size) || 0) + f.nChar);
  let bodySize = 0; let bodySizeChars = -1;
  for (const [sz, c] of sizeChars) if (c > bodySizeChars) { bodySizeChars = c; bodySize = sz; }
  if (!bodySize) bodySize = quantile(feats.map((f) => f.size).filter(Boolean), 0.5) || 10;

  // Line numbers: the integer column down the left margin of legal depositions/pleadings/transcripts, one per text line, dropped as furniture from reflowed text.
  const LN_LEFT_FRAC = 0.4;
  const LN_GATE_RUN = 8; // doc enables the detector only if some page reaches this incrementing run
  const LN_CONF_RUN = 6; // a page is a confident line-numbered page at this run length
  const LN_RESCUE_RUN = 4; // a partial page within the numbered range is rescued at this run + locked column
  const LN_MAX_RUN = 35; // case B only: a long merged numeric column is a table
  const LN_MAX_START = 30; // line numbers start near 1 (per-page reset / continuous) whereas table indices start high
  const LN_MAX_INDENT = bodySize * 2; // the number column sits at/left of the body margin, while an indented list/quote is right of it
  const LN_MAX_NUMFIRST = 0.5; // case B: first content word numeric on most members -> a data table column
  const LN_MIN_PITCHREG = 0.85; // case B: strictly per-line pitch (line numbers) vs multi-line list/footnote items
  const LN_CASEB_MIN_RIGHTFRAC = 0.35; // case B: merged line numbers annotate prose across the page, not short cells
  const LN_CASEB_MIN_DENSITY = 0.6; // case B: line numbers tag every line in their span, whereas a numbered list or wrapped footnote refs tag few
  /** @type {Map<number, LineFeat[]>} */
  const lnByPage = new Map();
  for (const f of feats) { if (!lnByPage.has(f.page)) lnByPage.set(f.page, []); lnByPage.get(f.page).push(f); }
  // Per page: the longest incrementing run of left-region leading-integer lines, its members and column x.
  /** @type {Map<number, {run: number, members: Array<{f: LineFeat, value: number, prefixWords: number, standalone: boolean, x: number}>, colX: number}>} */
  const lnPageRuns = new Map();
  let lnGateFired = false;
  for (const [p, pf] of lnByPage) {
    const pageW = pages[p].dims?.width || 0;
    if (!pageW) continue;
    const leftEdge = pageW * LN_LEFT_FRAC;
    const cands = [];
    for (const f of pf) {
      if (f.left >= leftEdge) continue;
      const lead = leadingLineNumber(f.line);
      if (!lead) continue;
      // A data table's leading integer column (a row index or first data column) recurs at a fixed x exactly like a line-number margin.
      if (f.inTable) continue;
      cands.push({
        f, value: lead.value, prefixWords: lead.prefixWords, standalone: lead.standalone, x: f.left, top: f.top,
      });
    }
    if (cands.length < LN_RESCUE_RUN) continue;
    // Cluster by x before building the run so a digit-leading content line at a different x cannot interleave vertically and split the line-number column's run.
    // The bodySize cluster tolerance absorbs a right-aligned column's 1- vs 2-digit left-edge shift while keeping a separate content column apart.
    let bestRun = [];
    for (const peak of clusterPeaks(cands.map((c) => c.x), bodySize)) {
      const col = cands.filter((c) => Math.abs(c.x - peak.center) <= bodySize).sort((a, b) => a.top - b.top);
      let cur = [];
      for (const c of col) {
        const prev = cur.length ? cur[cur.length - 1] : null;
        if (prev && c.value > prev.value && c.value - prev.value <= 5) cur.push(c); else cur = [c];
        if (cur.length > bestRun.length) bestRun = cur.slice();
      }
    }
    if (bestRun.length < LN_RESCUE_RUN) continue;
    const xs = bestRun.map((c) => c.x).sort((a, b) => a - b);
    const colX = xs[Math.floor(xs.length / 2)];
    // lnLike decides whether this run is line numbers rather than a table index, numbered list, or quoted-transcript column.
    const saFrac = bestRun.filter((c) => c.standalone).length / bestRun.length;
    // Per-page (not doc-wide) so a multi-section doc (a report among exhibit pages at other margins) judges each page against its own body.
    // Falls back to colX when the page is entirely numbered prose with no non-member lines to measure, so the indentOk test below accepts it.
    const memberSet = new Set(bestRun.map((c) => c.f));
    const proseLines = pf.filter((f) => !memberSet.has(f) && (f.right - f.left) > bodySize * 8);
    const proseLefts = proseLines.map((f) => f.left);
    const bodyPeaks = clusterPeaks(proseLefts, bodySize * 0.6).sort((a, b) => b.count - a.count);
    const pageBodyLeft = bodyPeaks.length ? bodyPeaks[0].center : colX;
    const indentOk = colX <= pageBodyLeft + LN_MAX_INDENT;
    // A run entirely below the body is a footnote/endnote number block, and locking on it would strip the note numbers, so require a member at or above the lowest body line.
    // 'Body' means a non-member line carrying letters, so a bare-number folio at the bottom cannot extend the span down and re-admit the block.
    // Skipped under 4 body lines so a fully-numbered case-B page whose members are the body stays accepted.
    const bodyLines = pf.filter((f) => !memberSet.has(f) && /[A-Za-z]/.test(f.text || ''));
    const bodyBottom = bodyLines.length ? Math.max(...bodyLines.map((f) => f.top)) : Infinity;
    const bodyOverlap = bodyLines.length < 4 || bestRun.some((c) => c.top <= bodyBottom);
    // The run cap (LN_MAX_RUN) is skipped for a standalone case-A column (saFrac >= 0.5), which can legitimately be long on a dense single-spaced page.
    // The start cap on its first value still guards it.
    let lnLikeCore = bestRun[0].value <= LN_MAX_START && (saFrac >= 0.5 || bestRun.length <= LN_MAX_RUN);
    // Case B (the number leads a body line) needs extra discrimination because a data table row ("171 87279106 ... JONES") or a numbered list/footnote resembles a merged line number.
    // Case A (standalone column) skips these because its remaining confusers, high-start index columns, are already caught by the start cap.
    if (lnLikeCore && saFrac < 0.5) {
      let numFirst = 0; let haveContent = 0;
      for (const c of bestRun) { const fw = c.f.line.words[c.prefixWords]; if (!fw) continue; haveContent++; if (/\d/.test(fw.text) && /^[\d.,$%()-]+$/.test((fw.text || '').trim())) numFirst++; }
      const numericFirstFrac = haveContent ? numFirst / haveContent : 0;
      const tops = bestRun.map((c) => c.top); const gaps = [];
      for (let k = 1; k < tops.length; k++) gaps.push(tops[k] - tops[k - 1]);
      const medGap = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)] || 1;
      const pitchReg = gaps.length ? gaps.filter((g) => g >= 0.5 * medGap && g <= 1.75 * medGap).length / gaps.length : 1;
      const rights = bestRun.map((c) => c.f.right).sort((a, b) => a - b);
      const medRightFrac = rights[Math.floor(rights.length / 2)] / pageW;
      const spanTop = tops[0]; const spanBot = tops[tops.length - 1];
      const linesInSpan = pf.filter((f) => f.top >= spanTop - 1 && f.top <= spanBot + 1).length;
      const density = linesInSpan ? bestRun.length / linesInSpan : 1;
      lnLikeCore = numericFirstFrac < LN_MAX_NUMFIRST && pitchReg >= LN_MIN_PITCHREG
        && medRightFrac >= LN_CASEB_MIN_RIGHTFRAC && density >= LN_CASEB_MIN_DENSITY;
    }
    const lnLike = lnLikeCore && indentOk && bodyOverlap;
    lnPageRuns.set(p, {
      run: bestRun.length, members: bestRun, colX, lnLike, lnLikeCore, indentOk, cands, startVal: bestRun[0] ? bestRun[0].value : 99,
    });
    if (bestRun.length >= LN_GATE_RUN && lnLike) lnGateFired = true;
  }

  if (lnGateFired) {
    // The recurEntries filter below keys on cross-page recurrence, not the per-page lnLike test.
    // lnLike false-negatives on Q&A deposition pages, where a full 1..25 column recurs at one x across dozens of pages yet almost no single page passes it.
    const LN_LOCK_PAGES = 3; // a column locks only if a strong margin run recurs at its x on this many pages
    const recurEntries = [...lnPageRuns.entries()]
      .filter(([, r]) => r.run >= LN_CONF_RUN && r.startVal <= LN_MAX_START && r.indentOk);
    // The value cap: an accepted line number must be 1..lnCeil.
    // Falls back to 28 (typical transcript lines-per-page) when no page is lnLike.
    let lnCeil = 0;
    for (const [, r] of lnPageRuns) if (r.lnLike) for (const c of r.members) if (c.value > lnCeil) lnCeil = c.value;
    if (!lnCeil) lnCeil = 28;
    // A document's line-number column can sit at more than one x, so lock every qualifying x-cluster as its own column rather than collapsing to a single dominant one.
    const lockPeaks = clusterPeaks(recurEntries.map(([, r]) => r.colX), bodySize).filter((q) => q.count >= LN_LOCK_PAGES);
    for (const peak of lockPeaks) {
      const atX = recurEntries.filter(([, r]) => Math.abs(r.colX - peak.center) <= bodySize).map(([p]) => p).sort((a, b) => a - b);
      // Extend the rescue window one page past the confident span so the first/last page of a numbered run (a caption page or a section's final page, where the run is partial) is still recovered.
      const confMin = Math.min(...atX) - 1; const confMax = Math.max(...atX) + 1; const confSet = new Set(atX);
      for (const [p, r] of lnPageRuns) {
        if (Math.abs(r.colX - peak.center) > bodySize) continue;
        // The rescue arm deliberately omits the per-page lnLikeCore test, which false-negatives on a colloquy or rapid-exchange page between confident pages at this locked column.
        // The cross-page lock already vouches for such a page.
        // Start-near-1 plus the in-span window still reject a real table index, which starts high and lives outside the numbered range.
        const accept = confSet.has(p)
          || (r.run >= LN_RESCUE_RUN && r.startVal <= LN_MAX_START && p >= confMin && p <= confMax);
        if (!accept) continue;
        const markMember = (c) => {
          if (c.standalone) {
            c.f.lineNum = true;
          } else {
            for (let w = 0; w < c.prefixWords && w < c.f.line.words.length; w++) c.f.line.words[w].lineNum = true;
          }
        };
        // No run-length floor here: the page and column are already confirmed.
        // A run-length floor instead drops the short partial runs at a multi-up sheet's mini-page boundaries, leaving those turn-start lines unstripped so the turn cannot be recognised.
        // The value cap still rejects a stray large margin integer.
        const colCands = r.cands.filter((c) => Math.abs(c.x - peak.center) <= bodySize);
        for (const c of colCands) if (c.value >= 1 && c.value <= lnCeil) markMember(c);
      }
    }
  }

  // A left-margin line number is often set as a small raised digit, which lineEnumerator typed 'sup-ref' at construction.
  // Clear that enumerator or the margin column forms a footnote-reference scheme that switches on the footnote subsystem and mislabels the body it leads as note prose.
  for (const f of feats) {
    if (f.lineNum) { f.enumerator = null; continue; }
    const lnWs = f.line.words;
    if (!lnWs.length || !lnWs[0].lineNum) continue;
    let lnJ = 0;
    while (lnJ < lnWs.length && lnWs[lnJ].lineNum) lnJ++;
    f.enumerator = lineEnumerator({ words: lnWs.slice(lnJ) });
  }

  // These per-line features were frozen at construction from the leading digit word that the line-number pass has since stripped as furniture.
  // Left stale, startsLower reads the digit, not the lowercase continuation, defeating the wrap guard so a wrapped body line splits into its own paragraph.
  for (const f of feats) {
    if (f.lineNum) continue;
    const ws = f.line.words;
    if (!ws.length || !ws[0].lineNum) continue;
    let j = 0;
    while (j < ws.length && ws[j].lineNum) j++;
    if (j === 0 || j >= ws.length) continue;
    const w0 = ws[j];
    f.left = w0.bbox.left;
    f.startsLower = /^[a-z]/.test(w0.text);
    f.firstWordWidth = (w0.bbox.right - w0.bbox.left) || 0;
    f.firstWordSup = !!(w0.style && w0.style.sup);
  }

  /** @type {Array<Array<LineFeat>>} */
  const pageFeatArr = Array.from({ length: pages.length }, () => []);
  for (const f of feats) pageFeatArr[f.page].push(f);

  // Per-page body size takes the largest size that covers at least 30% of the page's chars, not merely the most common size.
  // Footnotes can out-mass the body in raw char count, but the body still reaches 30%.
  const szKeys = []; const szWts = [];
  /** @type {Map<number, number>} */
  const pageBodySize = new Map();
  for (let p = 0; p < pages.length; p++) {
    szKeys.length = 0; szWts.length = 0;
    let totalChars = 0;
    for (const f of pageFeatArr[p]) {
      if (!f.size) continue;
      const i = szKeys.indexOf(f.size);
      if (i >= 0) szWts[i] += f.nChar; else { szKeys.push(f.size); szWts.push(f.nChar); }
      totalChars += f.nChar;
    }
    let chosen = 0; let dominant = 0; let domC = -1;
    let docBodyChars = 0;
    for (let i = 0; i < szKeys.length; i++) {
      const sz = szKeys[i]; const c = szWts[i];
      if (c > domC) { domC = c; dominant = sz; }
      if (totalChars > 0 && c / totalChars >= 0.30 && sz > chosen) chosen = sz;
      if (Math.abs(sz - bodySize) <= bodySize * 0.05) docBodyChars += c;
    }
    let pb = chosen || dominant || bodySize;
    // The document's own body size wins when it is present on the page in quantity yet a smaller note regime out-masses it and would take the >=30% test.
    // Without this an endnote-heavy page reads its own body as oversized and mis-promotes ordinary lines to display headings.
    if (bodySize > pb && totalChars > 0 && docBodyChars / totalChars >= 0.15) pb = bodySize;
    pageBodySize.set(p, pb);
  }

  // sizeRatio is relative to the line's local page body, so it stays meaningful in small-type sections.
  for (const f of feats) f.sizeRatio = f.size ? f.size / (pageBodySize.get(f.page) || bodySize) : 1;

  // Dominant colour is per-page, so a heading is judged colour-distinct against its own page body.
  // This stops a cover/divider page whose body is entirely white-on-colour from reading all its white paragraphs as headings.
  /** @type {Map<number, string>} */
  const pageBodyColor = new Map();
  const colKeys = []; const colWts = [];
  for (let p = 0; p < pages.length; p++) {
    colKeys.length = 0; colWts.length = 0;
    for (const f of pageFeatArr[p]) {
      if (!f.nChar) continue;
      const i = colKeys.indexOf(f.color);
      if (i >= 0) colWts[i] += f.nChar; else { colKeys.push(f.color); colWts.push(f.nChar); }
    }
    let dom = '#000000'; let domC = -1;
    for (let i = 0; i < colKeys.length; i++) if (colWts[i] > domC) { domC = colWts[i]; dom = colKeys[i]; }
    pageBodyColor.set(p, dom);
  }

  // Per-page so family-distinctness is measured against a line's own page body: a page set entirely in the heading face (a table of contents in the sans face) does not read its own lines as headings.
  /** @type {Map<number, string>} */
  const pageBodyFamily = new Map();
  const famKeys = []; const famWts = [];
  for (let p = 0; p < pages.length; p++) {
    famKeys.length = 0; famWts.length = 0;
    for (const f of pageFeatArr[p]) {
      if (!f.nChar) continue;
      const i = famKeys.indexOf(f.fontFamily);
      if (i >= 0) famWts[i] += f.nChar; else { famKeys.push(f.fontFamily); famWts.push(f.nChar); }
    }
    let dom = ''; let domC = -1;
    for (let i = 0; i < famKeys.length; i++) if (famWts[i] > domC) { domC = famWts[i]; dom = famKeys[i]; }
    pageBodyFamily.set(p, dom);
  }

  // Bold or all-caps stands out as a heading only on a page whose body is not itself bold/caps, so prevalence is measured per page.
  /** @type {Map<number, {tot: number, bold: number, caps: number}>} */
  const pageStyleChars = new Map();
  for (const f of feats) {
    if (f.sizeRatio < 0.92 || f.sizeRatio > 1.08) continue;
    let acc = pageStyleChars.get(f.page);
    if (!acc) { acc = { tot: 0, bold: 0, caps: 0 }; pageStyleChars.set(f.page, acc); }
    acc.tot += f.nChar;
    if (f.bold > 0.6) acc.bold += f.nChar;
    if (f.allCaps) acc.caps += f.nChar;
  }

  // Per-page flush margin (not doc-level) so a footnote block or appendix at its own margin does not read as a page full of indented paragraphs.
  /** @type {Map<number, number>} */
  const pageFlush = new Map();
  let docLeftMedian = null;
  for (let p = 0; p < pages.length; p++) {
    const pb = pageBodySize.get(p) || bodySize;
    const pl = [];
    for (const f of pageFeatArr[p]) if (f.nChar >= 4 && Math.abs(f.size - pb) <= pb * 0.08) pl.push(f.left);
    const pk = clusterPeaks(pl, pb * 0.3).filter((c) => c.count >= Math.max(2, pl.length * 0.08));
    if (pk.length) { pageFlush.set(p, pk[0].center); continue; }
    if (pl.length) { pageFlush.set(p, Math.min(...pl)); continue; }
    if (docLeftMedian == null) docLeftMedian = quantile(feats.map((ff) => ff.left), 0.5) || 0;
    pageFlush.set(p, docLeftMedian);
  }

  // The nChar floor keeps 1-3 char fragments (a pleading's left-margin line number) from polluting the column/indent/justified model.
  const bodyFeats = feats.filter((f) => f.sizeRatio >= 0.92 && f.sizeRatio <= 1.08 && !f.allCaps && f.nChar >= 4);
  const bodyLefts = bodyFeats.map((f) => f.left);
  const bodyRights = bodyFeats.map((f) => f.right);

  // Column left edges: fine peaks of body-line lefts (tol under a typical 1-em indent so the flush margin and the first-line-indent column resolve as separate peaks).
  const leftPeaks = clusterPeaks(bodyLefts, bodySize * 0.3).filter((pk) => pk.count >= Math.max(3, bodyFeats.length * 0.05));
  // Flush body margin = leftmost significant peak (indents are always to its right).
  const bodyLeft = leftPeaks.length ? leftPeaks[0].center : (quantile(bodyLefts, 0.5) || 0);
  // bodyTextLeft is the majority body-line column, which in a hanging-indent doc is the deeper hang column where prose wraps, right of the marker-margin bodyLeft.
  // Choosing the majority count keeps a minority block-quote inset from hijacking this column.
  const bodyTextLeft = leftPeaks.length
    ? leftPeaks.reduce((a, b) => (b.count > a.count ? b : a)).center : bodyLeft;
  const bodyRight = quantile(bodyRights, 0.9) || 0;
  const colWidth = bodyRight - bodyLeft;

  // Line pitch: top-to-top advance between vertically-adjacent same-size body lines.
  const pitches = [];
  /** @type {Map<number, Array<number>>} */
  const pitchesByPage = new Map();
  for (let k = 1; k < feats.length; k++) {
    const a = feats[k - 1]; const b = feats[k];
    if (a.page !== b.page) continue;
    if (Math.abs(a.size - b.size) > bodySize * 0.1) continue;
    if (b.sizeRatio < 0.92 || b.sizeRatio > 1.08) continue;
    const dy = b.top - a.top;
    if (dy <= 0) continue; // column wrap / overlap
    if (dy > bodySize * 4) continue; // big jump (section break)
    pitches.push(dy);
    if (!pitchesByPage.has(a.page)) pitchesByPage.set(a.page, []);
    pitchesByPage.get(a.page).push(dy);
  }
  const leading = pitches.length ? quantile(pitches, 0.5) : bodySize * 1.2;

  // Detect a first-line indent by the continuation below popping back leftward to flush, not by rightward offset off the leftmost column.
  // The offset test reads hanging-indent bodies (prose sits right of the marker column) and both-side-inset block quotes as indents; the pop-back test rejects both.
  /** @type {Map<number, Array<typeof feats[number]>>} */
  const featsByPage = new Map();
  for (const f of feats) {
    if (!featsByPage.has(f.page)) featsByPage.set(f.page, []);
    featsByPage.get(f.page).push(f);
  }
  for (const arr of featsByPage.values()) arr.sort((a, b) => a.top - b.top);
  const bodySet = new Set(bodyFeats);
  // Neighbour search window: at least 2.2 em, widened to the looser of the document's line pitch and this page's own median advance.
  // A double-spaced body then still finds its continuation line even when dense furniture (a caption block) dragged the doc-wide leading below the page's own pitch.
  const relIndents = [];
  /** @type {Map<number, Array<number>>} */
  const pageRelIndents = new Map();
  for (const arr of featsByPage.values()) {
    const advs = [];
    for (let i = 1; i < arr.length; i++) {
      const a = arr[i].top - arr[i - 1].top;
      if (a > bodySize * 0.5) advs.push(a);
    }
    // The page's loosest recurring advance regime (same construction as pageBodyPitch below).
    // The median alone lands on dense furniture (a caption block at single-space above a double-spaced body) and leaves the window short of the body pitch.
    const looseCl = clusterPeaks(advs, leading * 0.5).filter((c) => c.count >= Math.max(4, advs.length * 0.2));
    const pagePitch = Math.max(quantile(advs, 0.5) || 0, looseCl.length ? looseCl[looseCl.length - 1].center : 0);
    const nbWindow = Math.max(bodySize * 2.2, leading * 1.5, pagePitch * 1.5);
    for (let i = 0; i < arr.length; i++) {
      const f = arr[i];
      // bodyFeats' sizeRatio is page-relative, so on a page dominated by small type the body lines land at ~1.13 and vanish, hence the extra document-body-size arm (see detectColumns).
      const bodyLike = bodySet.has(f)
        || (Math.abs(f.size - bodySize) <= bodySize * 0.1 && !f.allCaps && f.nChar >= 4);
      if (!bodyLike) continue;
      let above = null; let below = null; // nearest in-column (horizontally overlapping) neighbours
      for (let j = i - 1; j >= 0; j--) {
        const g = arr[j];
        if (f.top - g.top <= bodySize * 0.2) continue; // same row, other column
        if (f.top - g.top > nbWindow) break;
        if (g.left < f.right && f.left < g.right) { above = g; break; }
      }
      for (let j = i + 1; j < arr.length; j++) {
        const g = arr[j];
        if (g.top - f.top <= bodySize * 0.2) continue;
        if (g.top - f.top > nbWindow) break;
        if (g.left < f.right && f.left < g.right) { below = g; break; }
      }
      if (!below) continue;
      // The pop-back witness must itself be body prose: a paragraph opener's first wrap is a body line by definition.
      // Without this, a signature line "pops back" to the all-caps judge-title line below it and mints a bogus depth that breaks the page's real indent regime.
      if (!(bodySet.has(below)
        || (Math.abs(below.size - bodySize) <= bodySize * 0.1 && !below.allCaps && below.nChar >= 4))) continue;
      const d = f.left - below.left; // pop-back depth = indent relative to the continuation flush
      // Cap at 6.5 em, slightly above the widest downstream acceptance (the >=3-hit page regime's 6 em): a typewriter-era 1-inch tab runs ~5.5 em at small type.
      if (d <= bodySize * 0.4 || d >= bodySize * 6.5) continue;
      if (above && Math.abs(above.left - f.left) < bodySize * 0.4) continue; // aligned below the line above: a continuation, not a first line
      relIndents.push(d);
      if (!pageRelIndents.has(f.page)) pageRelIndents.set(f.page, []);
      pageRelIndents.get(f.page).push(d);
    }
  }
  const indentClusters = clusterPeaks(relIndents, bodySize * 0.3).sort((a, b) => b.count - a.count);
  const indentPk = indentClusters[0] || null;
  // The indent column holds one line per paragraph, so a low fraction with an absolute floor is safe: a non-indented doc never produces a tight relative-indent peak at all.
  // Small-doc arm: a one-to-two-page order has too few paragraphs to reach the 6-hit floor, so >=3 pop-backs in one dominant cluster (>=60%) arm the convention instead.
  // Large docs keep the strict floor because three stray same-depth hits across hundreds of lines are noise, not a convention.
  const indentActive = !!indentPk && ((indentPk.count >= 6 && indentPk.count >= bodyFeats.length * 0.03)
    || (bodyFeats.length < 80 && indentPk.count >= 3 && indentPk.count >= relIndents.length * 0.6));
  const indentDelta = indentActive ? indentPk.center : 0; // dominant indent depth, relative to a column's flush
  // Match a set of first-line-indent depths, not just the dominant one, because a document can use more than one indent depth.
  // Matching only the dominant depth fuses every paragraph on the other-depth pages.
  // The ~0.8-3.5 em magnitude window excludes shallow justification jitter and block-quote-deep insets.
  const indentDeltas = indentActive
    ? Array.from(new Set([indentDelta, ...indentClusters
      .filter((c) => c.count >= 6 && c.count >= bodyFeats.length * 0.03
        && c.center >= bodySize * 0.8 && c.center <= bodySize * 3.5)
      .map((c) => c.center)]))
    : [];
  // The break rules add a matching indent depth to each line's own column flush, so this absolute (left-column) value is only a fallback.
  const indentCol = indentActive ? bodyLeft + indentDelta : 0;

  // Per-page indent regime: a sparse-paragraph filing or a one-page order can carry a clean first-line-indent convention yet never reach the doc-level fraction or absolute floors.
  // The page regime demands a dominant single depth so a stray pair of quote openers cannot mint one.
  /** @type {Map<number, Array<number>>} */
  const pageIndentDeltas = new Map();
  // Doc-level coherence gate: page regimes are trusted only when the doc's pop-back evidence tells one story, a single dominant depth doc-wide or too little evidence to judge.
  // A document with plentiful but scattered pop-backs is one the doc detector deliberately rejected, and a lucky 2-hit page must not re-arm the indent rule there.
  const docIndentCoherent = relIndents.length < 6
    || (!!indentPk && indentPk.count >= relIndents.length * 0.6);
  for (const [p, ds] of pageRelIndents) {
    if (!docIndentCoherent) break;
    const cl = clusterPeaks(ds, bodySize * 0.3).sort((a, b) => b.count - a.count)[0];
    // Two-hit pages qualify only when both hits share the depth (a one-page order has 2-4 paragraphs total).
    const enough = cl && (cl.count >= 3 ? cl.count >= ds.length * 0.6 : (cl.count === 2 && ds.length === 2));
    // A dominant >=3-hit cluster may reach tab depth (a typewriter-era 1-inch indent runs ~5.5 em at small type).
    // The 3.5-em ceiling stays for thinner two-hit evidence.
    const capMult = cl && cl.count >= 3 ? 6 : 3.5;
    if (enough && cl.center >= bodySize * 0.8 && cl.center <= bodySize * capMult) {
      pageIndentDeltas.set(p, [cl.center]);
    }
  }
  // Only when the indent convention is robust may a geometric first-line indent override structural grouping and split a line off its owning element.
  // On small/varied layouts the indent model false-positives, so there the structure element is trusted.
  const indentStrong = indentActive && indentPk.count >= Math.max(12, bodyFeats.length * 0.06);

  const bodyFontFamily = dominantFamily(bodyFeats);
  // A dense monospace transcript's right edges cluster at the margin like genuine justification, yet it is actually ragged-right, so `justified` excludes monospace by font.
  // Without the exclusion the "prev ends early (justified)" rule splits every short transcript line into its own paragraph.
  const monospaceBody = /courier|mono|consol|typewriter|fixedsys|andale|inconsolata|menlo|lucida.?cons|sourcecode|firacode|nimbusmono|liberationmono|prestige|letter.?gothic|ocr[ab]\b/i.test(bodyFontFamily || '');
  const fullLines = bodyRights.filter((r) => r >= bodyRight - colWidth * 0.10).length;
  const justified = !monospaceBody && bodyRights.length >= 8 && fullLines / bodyRights.length >= 0.5;

  // A ragged-right page inside an otherwise-justified document is not justified.
  // Leaving it under the doc-wide flag would license the "prev ends early (justified)" rule there and shred each multi-line entry into separate paragraphs.
  /** @type {Map<number, boolean>} */
  const pageJustified = new Map();
  const pageRights = new Map();
  for (const f of bodyFeats) {
    if (!pageRights.has(f.page)) pageRights.set(f.page, []);
    pageRights.get(f.page).push(f.right);
  }
  for (const [p, rights] of pageRights) {
    if (rights.length < 8) continue;
    const full = rights.filter((r) => r >= bodyRight - colWidth * 0.10).length;
    pageJustified.set(p, full / rights.length >= 0.5);
  }

  const boldBodyLines = bodyFeats.filter((f) => f.bold > 0.6).length;
  const boldHeading = bodyFeats.length >= 8 && boldBodyLines / bodyFeats.length < 0.2;

  /** @type {Map<string, number>} */
  const docColorChars = new Map();
  let docTotalChars = 0;
  for (const f of feats) {
    if (!f.nChar) continue;
    docColorChars.set(f.color, (docColorChars.get(f.color) || 0) + f.nChar);
    docTotalChars += f.nChar;
  }
  let docTopColorChars = 0;
  for (const [, n] of docColorChars) if (n > docTopColorChars) docTopColorChars = n;
  const colorHeading = docTotalChars > 0 && docTopColorChars / docTotalChars >= 0.6;
  for (const f of feats) f.colorDistinct = colorHeading && f.color !== (pageBodyColor.get(f.page) || '#000000');

  // Family is the only heading cue that catches a sub-head marginally larger than body yet neither bold, all-caps, nor colour-distinct.
  /** @type {Map<string, number>} */
  const docFamilyChars = new Map();
  for (const f of feats) {
    if (!f.nChar) continue;
    docFamilyChars.set(f.fontFamily, (docFamilyChars.get(f.fontFamily) || 0) + f.nChar);
  }
  let docTopFamilyChars = 0;
  for (const [, n] of docFamilyChars) if (n > docTopFamilyChars) docTopFamilyChars = n;
  const familyHeading = docTotalChars > 0 && docTopFamilyChars / docTotalChars >= 0.6;
  for (const f of feats) {
    f.familyDistinct = familyHeading && !!f.fontFamily && f.fontFamily !== (pageBodyFamily.get(f.page) || bodyFontFamily);
  }

  // Disable the footnote subsystem on scanned line-numbered transcripts: OCR-baked margin line numbers get misread as footnote markers and cascade whole pages of testimony into the 'footnote' role.
  // The 'scanned' half of the gate spares born-digital line-numbered briefs (pdfType 'text') carrying real footnotes.
  // The line-number half spares scanned expert reports whose notes are genuine footnotes.
  let suppressNotes = false;
  if (opts.pdfType === 'ocr' || opts.pdfType === 'image') {
    let lockedLineNumbers = 0;
    let leadingLineNumberLines = 0;
    for (const f of feats) {
      if (f.lineNum) { lockedLineNumbers++; continue; }
      const w0 = f.line.words[0] && f.line.words[0].text;
      if (w0 && /^\d{1,2}$/.test(w0) && +w0 >= 1 && +w0 <= 35) leadingLineNumberLines++;
    }
    suppressNotes = lockedLineNumbers >= 10 || leadingLineNumberLines >= feats.length * 0.2;
  }

  // Word 0 is skipped so a note's own leading marker is not collected as a body reference, which would make the note appear referenced by itself.
  // Markers glued to a word are collected in symbol ("margins*") and superscript-digit form, but never as a plain glued digit, which is part of the word itself rather than a marker.
  const SUP_DIGIT_CHARS = /** @type {Record<string, string>} */ ({
    '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
  });
  /** @type {Map<number, Set<string>>} */
  const bodyRefLabels = new Map();
  /** @type {Set<string>} */
  const bodyRefLabelsDoc = new Set();
  if (!suppressNotes) {
    /** @param {number} p @param {string} label */
    const addLabel = (p, label) => {
      let set = bodyRefLabels.get(p);
      if (!set) { set = new Set(); bodyRefLabels.set(p, set); }
      set.add(label);
      bodyRefLabelsDoc.add(label);
    };
    for (let p = 0; p < pages.length; p++) {
      for (const line of pages[p].lines) {
        const ws = line.words;
        for (let wi = 1; wi < ws.length; wi++) {
          const w = ws[wi];
          const wt = (w.text || '').trim();
          // The three marker forms end on mutually exclusive character classes (symbol, ASCII digit, superscript digit), so one last-char check routes to at most one regex.
          const lc = wt.charCodeAt(wt.length - 1);
          if (lc === 42 || lc === 8224 || lc === 8225 || lc === 8727) {
            const gm = /[A-Za-z0-9][*†‡∗]{1,3}$/.exec(wt);
            if (gm) addLabel(p, gm[0].slice(1));
          } else if (lc >= 48 && lc <= 57) {
            // "FN"+number reference ("FN2", or glued to its host word as "flawed.FN2") anchors its note block under the number's value.
            // Matched by content since the marker carries no sup style.
            const fnm = /FN(\d{1,3})$/.exec(wt);
            if (fnm) addLabel(p, fnm[1]);
          } else if (lc === 185 || lc === 178 || lc === 179 || lc === 8304 || (lc >= 8308 && lc <= 8313)) {
            // A literal Unicode superscript digit is superscript by codepoint, not sup style, so the styled path below skips it.
            const um = /[⁰¹²³⁴-⁹]{1,4}$/.exec(wt);
            if (um && !ws.some((x) => CJK_RE.test(x.text || ''))) {
              addLabel(p, [...um[0]].map((c) => SUP_DIGIT_CHARS[c]).join(''));
            }
          }
          if (!w.style || !w.style.sup) continue;
          // A preceding raised word means a uniform-size marker cluster, not a reference after running text, so skip it.
          // The walk-back first steps over Word's hidden "0F" cross-reference bookmark: a fraction of the reference's size, present before every real reference.
          let pi = wi - 1;
          while (pi > 0 && ws[pi].style && ws[pi].style.sup
            && (ws[pi].style.size || 0) < ((w.style && w.style.size) || 0) * 0.5) pi--;
          if (ws[pi].style && ws[pi].style.sup) continue;
          const label = wt.replace(/[.)\]/]+$/, '');
          if (!/^[\d*†‡∗]{1,3}$/.test(label)) continue;
          if (!/[*†‡∗]/.test(label) && ws.some((x) => CJK_RE.test(x.text || ''))) continue;
          addLabel(p, label);
        }
      }
    }
  }

  // Restore raised note markers that extraction hid from the sup flag and the enumerator.
  // Anchor each repair on a same-page reference (bodyRefLabels.get(page)), never the doc-wide set: a footnote shares its page with its reference.
  // A doc-wide anchor would promote any stray number that matches an in-text reference anywhere in the document.
  if (!suppressNotes) {
    /** @type {Map<number, LineFeat[]>} */
    const repairByPage = new Map();
    for (const f of feats) {
      let arr = repairByPage.get(f.page);
      if (!arr) { arr = []; repairByPage.set(f.page, arr); }
      arr.push(f);
    }
    // Extraction can emit a split marker far from its note text (even after it), and paragraph assembly walks that order, so an unmoved marker pairs with the next note's text.
    /** @type {Array<{marker: LineFeat, text: LineFeat}>} */
    const markerMoves = [];
    for (const [page, pf] of repairByPage) {
      const pageRefs = bodyRefLabels.get(page);
      if (!pageRefs) continue;
      const sorted = [...pf].sort((a, b) => a.top - b.top || a.left - b.left);
      for (const f of sorted) {
        if (f.firstWordSup && f.enumerator && f.enumerator.scheme === 'sup-ref') continue;
        if (f.inTable) continue;
        if (CJK_RE.test(f.text)) continue;
        const w0 = f.line.words[0];
        const w0t = ((w0 && w0.text) || '').trim();
        const um = /^[⁰¹²³⁴-⁹]{1,4}/.exec(w0t);
        if (um) {
          const value = parseInt([...um[0]].map((c) => SUP_DIGIT_CHARS[c]).join(''), 10);
          if (pageRefs.has(String(value))) {
            f.firstWordSup = true;
            f.enumerator = { scheme: 'sup-ref', value, raw: um[0] };
          }
          continue;
        }
        const lead = w0t.replace(/[.)\]/]+$/, '');
        if (!/^\d{1,3}$/.test(lead) || !pageRefs.has(lead)) continue;
        if (w0 && w0.style && w0.style.sup && w0t !== lead) {
          f.firstWordSup = true;
          f.enumerator = { scheme: 'sup-ref', value: parseInt(lead, 10), raw: w0t };
          continue;
        }
        // Split marker with no sup style: smaller-or-raised geometry distinguishes it from an ordinary lone digit.
        if (f.line.words.length !== 1 || (w0 && w0.style && w0.style.sup)) continue;
        let noteText = null;
        for (const g of sorted) {
          if (g === f || g.inTable || g.runningFurniture) continue;
          if (Math.abs(g.top - f.top) > bodySize * 0.6) continue;
          if (g.left <= f.left || g.left - f.right > bodySize * 3) continue;
          if (!/[A-Za-z]{2,}/.test(g.text)) continue;
          noteText = g;
          break;
        }
        if (!noteText) continue;
        // The bare digit is script-neutral, so a CJK caption to its right makes it an instruction-step number, not a split Latin note marker.
        if (CJK_RE.test(noteText.text)) continue;
        if (!(f.size <= noteText.size * 0.9 || f.top <= noteText.top - bodySize * 0.12)) continue;
        f.firstWordSup = true;
        f.enumerator = { scheme: 'sup-ref', value: parseInt(lead, 10), raw: w0t };
        markerMoves.push({ marker: f, text: noteText });
      }
    }
    if (markerMoves.length) {
      /** @type {Map<LineFeat, LineFeat[]>} */
      const markersBefore = new Map();
      for (const { marker, text } of markerMoves) {
        let arr = markersBefore.get(text);
        if (!arr) { arr = []; markersBefore.set(text, arr); }
        arr.push(marker);
      }
      const movedSet = new Set(markerMoves.map((m) => m.marker));
      const reordered = [];
      for (const f of feats) {
        if (movedSet.has(f)) continue;
        const ms = markersBefore.get(f);
        if (ms) reordered.push(...ms);
        reordered.push(f);
      }
      feats.length = 0;
      for (const f of reordered) feats.push(f);
    }
  }

  const schemeRuns = detectNumberingSchemes(feats);
  // Disabling the sup-ref scheme is the single lever that turns off every superscript-marker-driven note path at once.
  // Its consumers: the marker-led footnote rule, the doc-wide endnote/footnote-block pass (gated on it), and the sup-ref numbering splits.
  if (suppressNotes && schemeRuns['sup-ref']) schemeRuns['sup-ref'].active = false;
  // sequenceValues are the would-be note openers, so a run of them is self-corroborating and must be confirmed by an independent in-text reference.
  if (schemeRuns['sup-ref'] && schemeRuns['sup-ref'].active
      && ![...schemeRuns['sup-ref'].sequenceValues].some((v) => bodyRefLabelsDoc.has(String(v)))) {
    schemeRuns['sup-ref'].active = false;
  }
  // The detector activates sup-ref only on an increasing run of >=3, so a document with just 1-2 notes (the common case) never activates it.
  // A line-leading superscript integer matching an in-text reference is strong evidence on its own, so activate the scheme for exactly those anchored values even without a run.
  if (!suppressNotes && schemeRuns['sup-ref'] && !schemeRuns['sup-ref'].active) {
    const anchored = new Set();
    for (const f of feats) {
      // A line number carries the same raised-digit sup-ref enumerator as a note marker, so without this skip it would falsely anchor the scheme.
      if (f.lineNum) continue;
      if (CJK_RE.test(f.text)) continue;
      if (f.firstWordSup && f.enumerator && f.enumerator.scheme === 'sup-ref'
          && f.enumerator.value != null && bodyRefLabelsDoc.has(String(f.enumerator.value))) {
        anchored.add(f.enumerator.value);
      }
    }
    if (anchored.size >= 1) {
      schemeRuns['sup-ref'].active = true;
      schemeRuns['sup-ref'].sequenceValues = anchored;
    }
  }

  const bigPitches = pitches.filter((x) => x > leading * 1.35);
  const spacedActive = bigPitches.length >= 3 && bigPitches.length >= pitches.length * 0.08;
  const paraGapThresh = spacedActive ? (leading + quantile(bigPitches, 0.5)) / 2 : Infinity;

  // Per-page rather than doc-wide.
  // Under a single borrowed doc-wide threshold, a page spaced looser than the doc median has its ordinary wrapped lines misread as inter-paragraph gaps and split line-by-line.
  /** @type {Map<number, number>} */
  const pageParaGap = new Map();
  for (const [p, ps] of pitchesByPage) {
    if (ps.length >= 8) { pageParaGap.set(p, gapThreshold(ps, leading)); continue; }
    // Floor the borrowed doc-wide threshold at 1.3x this page's own median pitch so a page in large uniform display type is not split at every wrapped line.
    // Genuine gaps (>=~1.4x pitch) still clear the 1.3x floor.
    const med = quantile(ps, 0.5) || 0;
    pageParaGap.set(p, Math.max(paraGapThresh, med * 1.3));
  }

  // Per-page body line pitch, a floor on the doc-wide threshold the gap rule borrows for a page, so a uniformly double-spaced page is not read as one gap per line.
  // Not a plain median: on a page mixing a single-spaced block with a double-spaced body the median lands on the dense block, so take the loosest pitch cluster holding >=20% of the page's lines.
  /** @type {Map<number, number>} */
  const pageBodyPitch = new Map();
  for (const [p, ps] of pitchesByPage) {
    const med = quantile(ps, 0.5) || 0;
    const looseRegimes = clusterPeaks(ps, leading * 0.5).filter((c) => c.count >= Math.max(4, ps.length * 0.2));
    const loosest = looseRegimes.length ? looseRegimes[looseRegimes.length - 1].center : 0;
    pageBodyPitch.set(p, Math.max(med, loosest));
  }

  // Block-paragraph regime: paragraphs separated by a blank line, not a first-line indent.
  // In a double-spaced body that gap is ~4x bodySize, so the section-break filter above drops it and paraGapThresh collapses to Infinity even though real paragraph gaps exist.
  // !indentActive: an indented double-spaced doc delimits by indent and must not be re-split on spacing.
  let blockParaGap = Infinity;
  if (!indentActive && paraGapThresh === Infinity) {
    // Body line pitch as a mode (5-unit bins): the footnote single-spacing pulls the median below the body's true pitch, so the most common within-paragraph pitch is the reliable reference.
    // Uses the `pitches` array, already stripped of the big gaps, so the mode is a body-line advance, not a separator.
    const pitchBins = new Map();
    for (const x of pitches) { const b = Math.round(x / 5) * 5; pitchBins.set(b, (pitchBins.get(b) || 0) + 1); }
    let bodyPitch = 0; let bestN = 0;
    for (const [b, n] of pitchBins) if (n > bestN) { bestN = n; bodyPitch = b; }
    // Rescan raw feats here, not the `pitches` array that already dropped these large gaps.
    // Count only an isolated band gap: taller than a line but followed by an ordinary line.
    let bigInBand = 0; let isolatedInBand = 0;
    if (bodyPitch > 0) {
      for (let k = 1; k < feats.length; k++) {
        const a = feats[k - 1]; const b = feats[k];
        if (a.page !== b.page) continue;
        if (Math.abs(a.size - b.size) > bodySize * 0.1) continue;
        if (b.sizeRatio < 0.92 || b.sizeRatio > 1.08) continue;
        const dy = b.top - a.top;
        if (dy <= bodyPitch * 1.4 || dy > bodyPitch * 3.2) continue;
        bigInBand++;
        const c = feats[k + 1];
        const nextDy = (c && c.page === b.page && Math.abs(b.size - c.size) <= bodySize * 0.1
          && c.sizeRatio >= 0.92 && c.sizeRatio <= 1.08) ? c.top - b.top : 0;
        if (nextDy <= bodyPitch * 1.4) isolatedInBand++;
      }
    }
    // The 60% isolated gate rejects a uniformly looser-spaced run whose big gaps are not paragraph breaks.
    // 1.35x body pitch sits above within-paragraph pitch variation and below the separator cluster.
    if (isolatedInBand >= 6 && isolatedInBand >= bigInBand * 0.6) blockParaGap = bodyPitch * 1.35;
  }

  const model = /** @type {LayoutModel} */ ({
    bodySize,
    bodyFontFamily,
    familyHeading,
    pageBodyFamily,
    bodyLeft,
    bodyTextLeft,
    bodyRight,
    colWidth,
    pageFlush,
    indentActive,
    indentStrong,
    indentCol,
    indentDelta,
    indentDeltas,
    leading,
    justified,
    pageJustified,
    boldHeading,
    colorHeading,
    spacedActive,
    paraGapThresh,
    blockParaGap,
    pageParaGap,
    pageBodyPitch,
    pageIndentDeltas,
    // Reference pages (TOC / Table of Authorities / index): per-page count of body lines ending in a dot-leader + page number.
    pageLeaderCount: (() => {
      /** @type {Map<number, number>} */
      const m = new Map();
      for (const f of feats) {
        if (f.artifact || f.orientation !== 0) continue;
        // (?:\.\s*){3,}: leaders come both solid ("....9") and spaced (". . . . 9").
        // Interleaved letters (a cite's "U.S.C.") break the dot run, so prose tails stay out.
        if (/(?:\.\s*){3,}\d{1,4}$/.test((f.text || '').trim())) m.set(f.page, (m.get(f.page) || 0) + 1);
      }
      return m;
    })(),
    schemes: schemeRuns,
    nLines: feats.length,
    nBodyLines: bodyFeats.length,
    // Does this producer keep one struct element per paragraph, so decideBreak can trust the element boundary directly?
    // True for Microsoft Word output, sniffed by the caller from /Creator|/Producer.
    // All other documents keep the conservative guards.
    elementFaithful: opts.elementFaithful === true,
  });

  // Phase 3: role classification + grouping, per page.
  // Rebuilt rather than reusing the Phase-2 grouping because the marker-repair pass above reorders feats within a page.
  /** @type {Array<Array<LineFeat>>} */
  const pageFeats3 = Array.from({ length: pages.length }, () => []);
  for (const f of feats) pageFeats3[f.page].push(f);
  // The separator rule's y marks the top of the footnote block, letting classifyRole find notes set at body size that the size-gated footnote test cannot see.
  /** @type {Map<number, number>} */
  const footnoteRuleY = new Map();
  /** @type {Map<number, number>} */
  const rawSepY = new Map(); // topmost lower-half separator-rule y per page, before corroboration
  // Topmost separator-shaped rule per page at any height, trusted only by the self-gated continuation path.
  // A footnote-dominated page (notes filling most of the page) sets its separator above mid-page, so the lower-half guard on the doc-wide footnoteRuleY would miss it.
  /** @type {Map<number, number>} */
  const rawSepAnyY = new Map();
  for (let p = 0; p < pages.length; p++) {
    const pageH = pages[p].dims?.height || 0;
    if (!pageH) continue;
    let y = null;
    let yAny = null;
    const pageRules = pages[p].rules || [];
    const pf3 = pageFeats3[p];
    for (const r of pageRules) {
      if (r.left > (pageFlush.get(p) ?? bodyLeft) + bodySize) continue; // not anchored at the page's left margin
      // (per-page flush, not doc-wide bodyLeft: a running-header docket stamp left of the body can drag doc-wide bodyLeft past the true margin, so a real separator would fail this left-anchor gate)
      // A full-width horizontal rule is a section or table border, not a note separator, but such borders are often drawn as per-cell segments each individually under the width threshold.
      // Union every rule collinear with this one (same y) before the width test so a segmented border still reads as full-width and is rejected.
      let uLeft = r.left; let uRight = r.right;
      for (const q of pageRules) if (Math.abs(q.y - r.y) <= bodySize * 0.3) { uLeft = Math.min(uLeft, q.left); uRight = Math.max(uRight, q.right); }
      if (uRight - uLeft > colWidth * 0.6) continue;
      // A text underline has the exact geometry of a footnote separator, distinguished only by lying inside a text line's bbox (on the baseline) rather than in the gap between lines.
      // Skip bbox-contained rules so an underlined sub-heading cannot seed a spurious footnote region.
      if (pf3.some((g) => r.y >= g.top && r.y <= g.bottom && r.left < g.right && r.right > g.left)) continue;
      if (yAny == null || r.y < yAny) yAny = r.y;
      if (r.y < pageH * 0.5) continue;
      if (y == null || r.y < y) y = r.y;
    }
    if (yAny != null) rawSepAnyY.set(p, yAny);
    // A text underline shares the separator's short-low-left geometry, so trust the rule only when a footnote-like line sits below it.
    // Ungated, the underline drags every line below it into the footnote role.
    if (y != null) {
      rawSepY.set(p, y);
      const corroborated = pf3.some((f) => {
        if (f.top <= y) return false;
        if (f.sizeRatio <= 0.86 && /[A-Za-z]{2,}/.test(f.text)) return true;
        // A note opener: led by a marker in an active numbering sequence, superscript ("¹⁵") or regular numbered ("18.", "67.").
        // A reference-list underline has author-name-led citations below it (no enumerator), so it fails.
        const sc = f.enumerator && schemeRuns[f.enumerator.scheme];
        return !!(f.enumerator && f.enumerator.value != null && sc && sc.active
          && sc.sequenceValues && sc.sequenceValues.has(f.enumerator.value));
      });
      if (corroborated) footnoteRuleY.set(p, y);
    }
  }
  model.bodyRefLabels = bodyRefLabels;
  model.bodyRefLabelsDoc = bodyRefLabelsDoc;

  // A footnote continued across a page break has no marker and is set at body size, so classifyRole misses it and would leave it typed as body.
  /** @type {Map<number, number>} */
  const footnoteContinues = new Map();
  const supRefRun = schemeRuns['sup-ref'];
  // note prose below a separator, excluding a centred folio/footer (anchored left of the note column)
  const noteLeftMax = (q) => (pageFlush.get(q) ?? bodyLeft) + bodySize * 4;
  for (let p = 1; p < pages.length; p++) {
    // rawSepAnyY takes the separator at any height with no low-on-page guard because the cross-page continuation test below is the real gate.
    // That test requires an open footnote on p-1, so a high separator alone cannot open a spurious region.
    const sepCur = rawSepAnyY.get(p);
    if (sepCur == null) continue;
    const prevH = pages[p - 1].dims?.height || 0;
    if (!prevH) continue;
    // Top of p-1's note zone: its separator-shaped rule, lowered to the topmost active sup-ref marker pinned to the page's lower half.
    // The marker arm lets a page with no drawn rule but marked notes still locate the zone.
    // Infinity means p-1 has no note zone, so its tail is body, not an open footnote, and this is no continuation.
    let prevNoteTop = rawSepAnyY.has(p - 1) ? rawSepAnyY.get(p - 1) : Infinity;
    for (const f of pageFeats3[p - 1]) {
      if (f.bottom / prevH <= 0.5 || f.lineNum) continue;
      if (f.firstWordSup && f.enumerator && f.enumerator.scheme === 'sup-ref'
        && supRefRun && supRefRun.active && supRefRun.sequenceValues && f.enumerator.value != null
        && supRefRun.sequenceValues.has(f.enumerator.value)) prevNoteTop = Math.min(prevNoteTop, f.top);
    }
    if (prevNoteTop === Infinity) continue;
    // A numbered multi-page table has rows shaped like baseline notes, and its last row reaches the page bottom unpunctuated.
    // Dropping !f.inTable would therefore read the whole table, page after page, as one giant note continuation.
    const prevNotes = pageFeats3[p - 1].filter((f) => f.top >= prevNoteTop && !f.inTable
      && !f.allCaps && /[A-Za-z]{2,}/.test(f.text) && f.left < noteLeftMax(p - 1));
    if (!prevNotes.length) continue;
    // prevNotes is only prose below a separator-shaped rule, which over-fires on markerless matter like word indexes and deposition Q&A.
    // Requiring a real note here stops those false note zones from spilling onto the next page.
    const prevRefs = bodyRefLabels.get(p - 1);
    const realNotes = prevNotes.filter((g) => {
      if (g.firstWordSup && g.enumerator && g.enumerator.scheme === 'sup-ref' && !g.lineNum
        && supRefRun && supRefRun.active && supRefRun.sequenceValues && g.enumerator.value != null
        && supRefRun.sequenceValues.has(g.enumerator.value)) return true;
      if (!prevRefs) return false;
      const lead = ((g.line.words[0] && g.line.words[0].text) || '').trim().replace(/[.)\]]+$/, '');
      if (!/^[\d*†‡]{1,3}$/.test(lead) || !prevRefs.has(lead)) return false;
      // A note opener starts a sentence or citation, so a lowercase second word means the marker is running body text, not a note.
      return !(g.line.words[1] && /^[a-z]/.test(g.line.words[1].text || ''));
    });
    if (!realNotes.length) continue;
    // an open note reaches the page bottom and ends without terminal punctuation
    const lastPrev = prevNotes.reduce((a, b) => (b.bottom > a.bottom ? b : a));
    if (lastPrev.bottom / prevH <= 0.8 || /[.!?)”’"']\s*$/.test(lastPrev.text.trim())) continue;
    // A last line much larger than the real notes is body text that reached the page bottom unpunctuated via a column break, not an open note.
    // Treating it as the open note cascades whole magazine-layout pages into the note role page after page.
    if (lastPrev.size > Math.max(...realNotes.map((g) => g.size)) * 1.15) continue;
    const curNotes = pageFeats3[p].filter((f) => f.top > sepCur && !f.inTable
      && !f.allCaps && /[A-Za-z]{2,}/.test(f.text) && f.left < noteLeftMax(p));
    if (!curNotes.length) continue;
    // p's note-zone opener: a continuation carries no active sup-ref marker (a new note would)
    const opener = curNotes.reduce((a, b) => (b.top < a.top ? b : a));
    const openerIsMarker = !!(opener.firstWordSup && opener.enumerator
      && opener.enumerator.scheme === 'sup-ref'
      && supRefRun && supRefRun.active && supRefRun.sequenceValues && opener.enumerator.value != null
      && supRefRun.sequenceValues.has(opener.enumerator.value));
    if (openerIsMarker) continue;
    footnoteContinues.set(p, lastPrev.size);
    if (!footnoteRuleY.has(p)) footnoteRuleY.set(p, sepCur); // the continuation corroborates this page's separator
  }
  // A line-numbered transcript's small, low testimony corroborates a footnote separator via the size-only path even with sup-ref disabled.
  // The drawn-rule footnote region must therefore also be dropped under the gate.
  if (suppressNotes) { footnoteRuleY.clear(); footnoteContinues.clear(); }
  model.footnoteContinues = footnoteContinues;
  model.footnoteRuleY = footnoteRuleY;

  // A word-index page's small, low entries read as notes, so classifyRole uses this set to keep the whole page out of the footnote role.
  /** @type {Set<number>} */
  const concordancePages = new Set();
  {
    /** @type {Map<number, {tot: number, conc: number}>} */
    const lineStats = new Map();
    for (const f of feats) {
      const t = (f.text || '').trim();
      if (t.length < 2) continue;
      if (!lineStats.has(f.page)) lineStats.set(f.page, { tot: 0, conc: 0 });
      const stat = lineStats.get(f.page);
      stat.tot++;
      const refs = (t.match(/\b\d{1,3}:\d{1,3}\b/g) || []).length;
      // Count of maximal letter runs of length >= 2 (what /[A-Za-z]{2,}/g matches), without materializing the match strings.
      let words = 0; let run = 0;
      for (let ci = 0; ci <= t.length; ci++) {
        const cc = ci < t.length ? t.charCodeAt(ci) : 0;
        if ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122)) run++;
        else { if (run >= 2) words++; run = 0; }
      }
      if (/(^|\s)\S+\s\(\d{1,3}\)/.test(t) || (refs >= 2 && refs >= words)) stat.conc++;
    }
    for (const [p, s] of lineStats) if (s.tot >= 8 && s.conc / s.tot >= 0.5) concordancePages.add(p);
  }
  model.concordancePages = concordancePages;

  // Running header/footer detection.
  // Margin-band recurrence alone is not enough: a repeated footnote tail or digit-stripped citation recurs too, and mislabelling it as furniture drops substantive text on export.
  // Each admitting path below therefore demands positive evidence that the recurring line is page furniture.
  /** @type {Map<string, Array<{page: number, nums: number[], allCaps: boolean, bold: boolean, nChar: number, text: string}>>} */
  const marginGroups = new Map();
  const contentPageCount = new Set(feats.map((f) => f.page)).size;
  // Page furniture lives in the margins, so /Artifact-tagged lines sitting mid-page mean the producer over-applies the tag to body content, leaving it useless as a furniture signal.
  // classifyRole ignores /Artifact (below) once this mid-page ratio is high.
  const midPageArtifact = feats.filter((f) => {
    const mid = (f.topFrac + f.bottomFrac) / 2;
    return f.artifact && mid > 0.08 && mid < 0.92;
  }).length;
  model.artifactUnreliable = feats.length > 0 && midPageArtifact / feats.length > 0.15;
  model.pageCount = pages.length;
  for (const f of feats) {
    if (!(f.topFrac < 0.12 || f.bottomFrac > 0.88)) continue;
    const key = `${f.bottomFrac > 0.88 ? 'b' : 't'}|${f.text.toLowerCase().replace(/\d+/g, '').replace(/[^a-z]+/g, ' ').trim()}`;
    if (key.length < 5) continue; // 'b|'/'t|' + at least 3 letters: skips folios and trivial marks
    f.marginKey = key;
    if (!marginGroups.has(key)) marginGroups.set(key, []);
    marginGroups.get(key).push({
      page: f.page,
      nums: (f.text.match(/\d+/g) || []).map(Number),
      allCaps: f.allCaps,
      bold: f.bold > 0.6,
      nChar: f.nChar,
      text: f.text,
      sup: f.firstWordSup,
      sizeRatio: f.sizeRatio,
    });
  }
  /** @type {Set<string>} */
  const furnitureKeys = new Set();
  // Furniture keys admitted only by the contiguous-run section-head path, below the recurrence gate.
  // Their text can collide with a one-off section heading just inside the margin band, so the marking below is position-guarded to the tight band.
  /** @type {Set<string>} */
  const runAdmittedKeys = new Set();
  /** @type {Set<string>} */
  const numberKeys = new Set();
  for (const [key, insts] of marginGroups) {
    // Real page furniture is ~1x body size, so a giant-font mark is never furniture however it recurs, and typing it as furniture would drop it on export.
    if (insts.filter((i) => i.sizeRatio > 3).length * 2 >= insts.length) continue;
    const keyPages = new Set(insts.map((i) => i.page));
    // A page-tracking number (value - page constant on most pages), i.e. a folio, "Page N of M", a PageID, or a Bates number.
    // Keys established this way skip the style/prose test below.
    /** @type {Map<number, Set<number>>} */
    const offsetPages = new Map();
    for (const inst of insts) {
      for (const n of new Set(inst.nums)) {
        const offset = n - inst.page;
        if (!offsetPages.has(offset)) offsetPages.set(offset, new Set());
        offsetPages.get(offset).add(inst.page);
      }
    }
    let best = 0;
    let bestRun = 0; // longest contiguous run of pages sharing one page-tracking offset
    for (const pgs of offsetPages.values()) {
      if (pgs.size > best) best = pgs.size;
      const sorted = [...pgs].sort((a, b) => a - b);
      let run = sorted.length ? 1 : 0;
      for (let k = 1, cur = 1; k < sorted.length; k++) {
        cur = sorted[k] === sorted[k - 1] + 1 ? cur + 1 : 1;
        if (cur > run) run = cur;
      }
      if (run > bestRun) bestRun = run;
    }
    // Contiguous page-tracking run of >= 3 pages: a short cover/declaration section carries its footer on too few pages for the recurrence gate, yet a contiguous run is unambiguous furniture.
    // Superscript-led instances are excluded because a once-per-page footnote's number also tracks the page, and dropping it as furniture would delete real note content on export.
    const sectionFooter = bestRun >= 3 && !insts.some((i) => i.sup);
    // A per-chapter running-head banner misses every other detector: it stays below the 25% recurrence gate, carries no page-tracking number, and its mixed case fails the style path's prose guard.
    // A short phrase repeating verbatim across a contiguous run of >= 3 pages catches it, and ordinary margin content never forms such a run since a page's last body line differs page to page.
    const sortedKeyPages = [...keyPages].sort((a, b) => a - b);
    let keyRun = sortedKeyPages.length ? 1 : 0;
    for (let k = 1, cur = 1; k < sortedKeyPages.length; k++) {
      cur = sortedKeyPages[k] === sortedKeyPages[k - 1] + 1 ? cur + 1 : 1;
      if (cur > keyRun) keyRun = cur;
    }
    const sectionHead = keyRun >= 3 && insts.every((i) => i.nChar <= 60) && !insts.some((i) => i.sup);
    // Recurrence gate: a true running head/footer/stamp recurs on a substantial fraction of pages, not merely >= 3 absolute (a repeated URL tail or caption recurs on only a handful).
    // A section running-footer or section head is exempt because its contiguous run is positive evidence in its own right.
    const belowRecurrenceGate = keyPages.size < Math.max(3, contentPageCount * 0.25) && !sectionFooter;
    if (belowRecurrenceGate && !sectionHead) continue;
    // Furniture established by a page-tracking number (offset recurrence or a section running-footer), as opposed to the text-only section-head / style paths below.
    const numberBased = sectionFooter || best >= Math.max(3, keyPages.size * 0.6);
    let furniture = sectionFooter || sectionHead || best >= Math.max(3, keyPages.size * 0.6);
    if (!furniture) {
      // Style alone (short + all-caps or bold) can still match real running content, so the prose guard excludes a mixed-case line that reads as an unfinished sentence.
      const allCapsKey = insts.filter((i) => i.allCaps).length * 2 >= insts.length;
      const boldKey = insts.filter((i) => i.bold).length * 2 >= insts.length;
      const shortMark = insts.every((i) => i.nChar <= 60);
      const rep = insts[0].text.trim();
      const prose = !allCapsKey && rep.split(/\s+/).length >= 4
        && (/^[\p{Ll}),;]/u.test(rep) || !/[.!?]["')\]]*$/.test(rep) || /[,;(–-]$/.test(rep));
      furniture = (allCapsKey || boldKey) && shortMark && !prose;
    }
    if (furniture) {
      furnitureKeys.add(key);
      if (belowRecurrenceGate) runAdmittedKeys.add(key);
      if (numberBased) numberKeys.add(key);
    }
  }
  for (const f of feats) {
    // A giant display heading can share its marginKey with a small recurring furniture tab of the same name, and without this per-instance size guard it would be dropped on export.
    // The whole-key giant-font guard above cannot substitute: the key is legitimately furniture for its small tabs, so only the lone giant instance must be excluded here.
    if (!(f.marginKey && furnitureKeys.has(f.marginKey) && f.sizeRatio <= 2)) continue;
    // A run-admitted key (section head/footer below the recurrence gate) may be shared by a one-off section-opener heading sitting just inside the margin band.
    // Mark only instances in the tight band where the running-head banner actually sits, so that title stays a heading rather than being dropped as furniture.
    if (runAdmittedKeys.has(f.marginKey) && !(f.topFrac < 0.08 || f.bottomFrac > 0.92)) continue;
    // Keys are digit-stripped, so a numberless body line can collapse onto a folio-bearing footer's number-key.
    // That line is not the stamp, and marking it furniture would delete its content on export.
    if (numberKeys.has(f.marginKey) && !/\d/.test(f.text)) continue;
    f.runningFurniture = true;
  }

  // Bare page-number folios that the two other furniture paths miss.
  // The text-keyed pass above needs letters to key on, and classifyRole's fallback keys on proximity to the page edge, so it drops a folio set in a tall margin.
  // Keys instead on a value-minus-page offset that holds across a contiguous run of pages.
  /** @type {Map<string, Array<{f: LineFeat, page: number, val: number}>>} */
  const folioBySide = new Map();
  for (const f of feats) {
    const tt = f.text.trim();
    if (!/^\d{1,4}$/.test(tt)) continue;
    // A data table's numeric cells also sit in the top/bottom band and increment across pages, forming spurious page-tracking offset runs, so a table cell must never be taken for a folio.
    if (f.inTable) continue;
    // A superscript note marker (incl. repaired split markers) is never a folio.
    // Sequential notes at steady page positions otherwise read as a perfect page-tracking run and the notes vanish as furniture.
    if (f.firstWordSup && f.enumerator && f.enumerator.scheme === 'sup-ref') continue;
    if (!(f.topFrac < 0.15 || f.bottomFrac > 0.80)) continue;
    const side = f.bottomFrac > 0.80 ? 'b' : 't';
    if (!folioBySide.has(side)) folioBySide.set(side, []);
    folioBySide.get(side).push({ f, page: f.page, val: Number(tt) });
  }
  for (const insts of folioBySide.values()) {
    /** @type {Map<number, Array<{f: LineFeat, page: number}>>} */
    const byOffset = new Map();
    for (const c of insts) {
      const off = c.val - c.page;
      if (!byOffset.has(off)) byOffset.set(off, []);
      byOffset.get(off).push(c);
    }
    for (const cs of byOffset.values()) {
      const pgs = [...new Set(cs.map((c) => c.page))].sort((a, b) => a - b);
      let run = pgs.length ? 1 : 0; let best = run;
      for (let k = 1; k < pgs.length; k++) { run = pgs[k] === pgs[k - 1] + 1 ? run + 1 : 1; if (run > best) best = run; }
      if (best >= 3) for (const c of cs) c.f.folio = true;
    }
  }

  // An endnote section and a voluminous footnote page look identical block-by-block (flush-left, superscript-marker-led, body-or-smaller).
  // The discriminator is page structure: endnotes form a consecutive run of note-dominated pages, while an isolated dominated page is footnotes filling one page.
  // footnoteBlock still matters: such a block crosses the page midline, so its upper lines escape every bottomFrac-gated footnote rule in classifyRole and would otherwise fall to 'body'.
  const supRefScheme = model.schemes['sup-ref'];
  if (supRefScheme && supRefScheme.active) {
    // Furniture is never a note entry: a pleading-paper margin number is itself a raised sup-ref digit, and once the scheme is active it would open a "note block" that swallows the page's body text.
    const opensEntry = (f) => f.firstWordSup && f.enumerator && f.enumerator.scheme === 'sup-ref'
      && !f.lineNum && !f.folio && !f.runningFurniture
      && supRefScheme.sequenceValues.has(f.enumerator.value);
    /** @type {Map<number, LineFeat[]>} */
    const featsByPage = new Map();
    for (const f of feats) {
      if (!featsByPage.has(f.page)) featsByPage.set(f.page, []);
      featsByPage.get(f.page).push(f);
    }
    // Each page's note block (markers + absorbed continuations), the sup-ref values its markers carry, and whether the block dominates the page (covers >60% of its content lines).
    /** @type {Map<number, {noteLines: LineFeat[], values: number[], dominated: boolean}>} */
    const pageNotes = new Map();
    for (const [p, pageFeats] of featsByPage) {
      const noteLines = [];
      /** @type {number[]} */
      const values = [];
      for (let i = 0; i < pageFeats.length; i++) {
        if (!opensEntry(pageFeats[i])) continue;
        const start = pageFeats[i];
        noteLines.push(start);
        values.push(start.enumerator.value);
        // The margin tolerance is asymmetric because a numbered reference's wrapped lines are hang-indented right of the marker.
        for (let j = i + 1; j < pageFeats.length; j++) {
          const g = pageFeats[j];
          if (opensEntry(g) || g.runningFurniture) break;
          const dx = g.left - start.left;
          if (g.sizeRatio >= 1.15 || dx < -bodySize * 0.6 || dx > bodySize * 2.5) break;
          if (g.top - pageFeats[j - 1].top > leading * 2.2) break;
          noteLines.push(g);
        }
      }
      if (!noteLines.length) continue;
      // Dominated = note entries cover most of the page's content (a normal footnote page's notes are a small tail beneath the body, never clearing this bar).
      const content = pageFeats.filter((f) => !f.runningFurniture).length;
      values.sort((a, b) => a - b);
      pageNotes.set(p, { noteLines, values, dominated: content > 0 && noteLines.length / content > 0.6 });
    }
    const domPages = [...pageNotes.keys()].filter((p) => pageNotes.get(p).dominated).sort((a, b) => a - b);
    /** @type {number[][]} */
    const runs = [];
    for (const p of domPages) {
      const last = runs[runs.length - 1];
      if (last && last[last.length - 1] === p - 1) last.push(p);
      else runs.push([p]);
    }
    // An unreferenced numbered run is a self-referential list (a caption list, a court-form's item numbers), not notes, so it stays body.
    /** @type {Set<number>} */
    const endnotePages = new Set();
    /** @type {Set<number>} */
    const footnoteBlockPages = new Set();
    for (const run of runs) {
      const referenced = run.some((p) => pageNotes.get(p).values.some((v) => bodyRefLabelsDoc.has(String(v))));
      if (!referenced) continue;
      if (run.length >= 2) for (const p of run) endnotePages.add(p);
      else footnoteBlockPages.add(run[0]);
    }
    // Extend a >=3-page endnote run onto an adjacent non-dominated page: a reference list's first page often shares the end of the report body, so its opening entries do not dominate.
    // Value contiguity across the page boundary keeps out a separate numbered block that restarts at 1.
    // The >=3 floor keeps a 2-page span, which can be one long footnote spilling over rather than a dedicated section, from growing.
    for (const run of runs) {
      if (run.length < 3) continue;
      const firstVals = pageNotes.get(run[0]).values;
      const before = pageNotes.get(run[0] - 1);
      if (before && !before.dominated && firstVals.length && before.values.length
        && before.values[before.values.length - 1] + 1 === firstVals[0]) endnotePages.add(run[0] - 1);
      const lastVals = pageNotes.get(run[run.length - 1]).values;
      const after = pageNotes.get(run[run.length - 1] + 1);
      if (after && !after.dominated && lastVals.length && after.values.length
        && after.values[0] - 1 === lastVals[lastVals.length - 1]) endnotePages.add(run[run.length - 1] + 1);
    }
    for (const [p, { noteLines }] of pageNotes) {
      if (endnotePages.has(p)) for (const f of noteLines) f.endnote = true;
      else if (footnoteBlockPages.has(p)) for (const f of noteLines) f.footnoteBlock = true;
    }
  }

  // Note-style profile: the document's note conventions.
  // Doc-level gate for classifyRole's rule that admits a full-size leading number matching an in-text reference as a note.
  let baselineMarkerNotesBelowSep = 0;
  for (const f of feats) {
    if (f.firstWordSup || f.bottomFrac <= 0.5) continue;
    const rp = bodyRefLabels.get(f.page);
    if (!rp) continue;
    const w0 = f.line.words[0];
    const lead = w0 ? (w0.text || '').trim().replace(/[.)\]/]+$/, '') : '';
    if (!/^\d{1,3}$/.test(lead) || !rp.has(lead)) continue;
    const fy = footnoteRuleY.get(f.page);
    if (fy == null || f.top <= fy) continue;
    if (f.left <= (pageFlush.get(f.page) ?? bodyLeft) + bodySize * 2) baselineMarkerNotesBelowSep++;
  }
  const usesBaselineMarker = baselineMarkerNotesBelowSep >= 1;

  // Note lines confirmed by marker/reference evidence, whose sizes and bold fraction define the size/weight envelope classifyRole gates note claims against.
  // Collected without that envelope applied, so it is derived from evidence, not from itself.
  /** @type {LineFeat[]} */
  const noteStyleLines = [];
  for (const f of feats) {
    if (f.endnote || f.footnoteBlock) { noteStyleLines.push(f); continue; }
    if (f.bottomFrac <= 0.5) continue;
    if (supRefScheme && supRefScheme.active && f.firstWordSup && f.enumerator
        && f.enumerator.scheme === 'sup-ref' && f.enumerator.value != null
        && supRefScheme.sequenceValues.has(f.enumerator.value)) {
      noteStyleLines.push(f);
      continue;
    }
    const rp = bodyRefLabels.get(f.page);
    if (!rp || f.allCaps) continue;
    const fy = footnoteRuleY.get(f.page);
    if (f.left > (pageFlush.get(f.page) ?? bodyLeft) + bodySize * (fy != null && f.top > fy ? 2 : 1)) continue;
    const w0t = ((f.line.words[0] && f.line.words[0].text) || '').trim();
    const lead = w0t.replace(/[.)\]/]+$/, '');
    const glued = /^([*†‡∗]{1,3})[A-Za-z0-9(“"'‘]/.exec(w0t);
    if ((/^[*†‡∗]{1,3}$/.test(lead) && rp.has(lead))
        || (glued && rp.has(glued[1]))
        || (/^\d{1,3}$/.test(lead) && rp.has(lead) && usesBaselineMarker)) noteStyleLines.push(f);
  }
  const noteSizes = noteStyleLines.map((f) => f.size).filter(Boolean).sort((a, b) => a - b);
  model.noteProfile = {
    usesBaselineMarker,
    // Not max, so one mis-admitted line cannot stretch the envelope.
    openerSize: noteSizes.length ? quantile(noteSizes, 0.9) : 0,
    notesBold: noteStyleLines.length >= 2
      && noteStyleLines.filter((f) => f.bold > 0.6).length / noteStyleLines.length >= 0.5,
  };

  // Heading signatures: the style tuples this document uses for headings.
  // Convention-first: a style tuple earns the right to make headings from how its lines behave document-wide.
  // classifyRole then promotes only members of qualified tuples, plus narrow per-line fallbacks.

  // Per-page columns: shape stats compare each line's width to its own column's width, so a single doc-wide colWidth would flag every two-column line as short.
  /** @type {Map<number, ?Array<{left:number,right:number,width:number}>>} */
  const pageColumns = new Map();
  for (const [p, arr] of featsByPage) pageColumns.set(p, detectColumns(arr, model));
  model.pageColumns = pageColumns;

  // featsByPage arrays are top-sorted, so scans stop at the window edge.
  // The iteration cap bounds fragment-dense pages, where hundreds of same-row fragments sit in one window and never trip that break, so an uncapped scan goes quadratic.
  for (const arr of featsByPage.values()) {
    for (let i = 0; i < arr.length; i++) {
      const f = arr[i];
      f.gapAbove = Infinity;
      f.belowFeat = null;
      for (let j = i - 1; j >= 0 && i - j <= 80; j--) {
        const g = arr[j];
        if (f.top - g.top <= Math.min(f.height, g.height) * 0.5) continue; // same row (other column/fragment)
        if (f.top - g.top > leading * 3.5) break;
        if (g.left < f.right && f.left < g.right) { f.gapAbove = f.top - g.bottom; break; }
      }
      for (let j = i + 1; j < arr.length && j - i <= 80; j++) {
        const g = arr[j];
        if (g.top - f.top <= Math.min(f.height, g.height) * 0.5) continue;
        if (g.top - f.top > leading * 3.5) break;
        if (g.left < f.right && f.left < g.right) { f.belowFeat = g; break; }
      }
    }
  }

  // Furniture, folios, line numbers, table cells, and note blocks are excluded so a style tuple shared between those roles and headings is judged on its content instances only.
  // The table detector owns cell detection, so heading rules here do not compensate for the cells it misses.
  /** @type {Map<string, {n: number, short: number, strong: number, weak: number, weakBig: number, enumLed: number, letterDom: number, lowerStart: number, headsBody: number}>} */
  const sigStats = new Map();
  for (const f of feats) {
    f.sigKey = `${Math.round(f.size * 2) / 2}|${f.bold > 0.6 ? 'b' : ''}${f.italic > 0.6 ? 'i' : ''}${f.allCaps ? 'c' : ''}|${f.fontFamily.replace(/^[A-Z]{6}\+/, '')}|${f.color}`;
    if (f.lineNum || f.folio || f.inTable || f.artifact || f.runningFurniture || f.endnote || f.footnoteBlock) continue;
    let s = sigStats.get(f.sigKey);
    if (!s) {
      s = {
        n: 0, short: 0, strong: 0, weak: 0, weakBig: 0, enumLed: 0, letterDom: 0, lowerStart: 0, headsBody: 0,
      };
      sigStats.set(f.sigKey, s);
    }
    s.n++;
    const col = columnFor(f.left, pageColumns.get(f.page) || null, bodySize);
    if (f.width < (col ? col.width : colWidth) * 0.85) s.short++;
    const st = pageStyleChars.get(f.page);
    const boldDistinct = f.bold > 0.6 && (!st || !st.tot || st.bold / st.tot < 0.3);
    const capsDistinct = f.allCaps && (!st || !st.tot || st.caps / st.tot < 0.3);
    if (f.sizeRatio >= 1.15 || boldDistinct || capsDistinct) s.strong++;
    else if ((f.familyDistinct || f.colorDistinct) && f.sizeRatio >= 0.95) {
      s.weak++;
      if (f.sizeRatio >= 1.02) s.weakBig++;
    }
    // An enumerator-led line is not a prose continuation, so its lowercase marker stays out of the lowerStart count.
    // An all-marker "b." heading still counts, while a "[2] [3] [4]" bracket run keeps its later digits and stays excluded.
    const enumLed = !!(f.enumerator && f.enumerator.scheme !== 'sup-ref' && f.enumerator.scheme !== 'bullet');
    if (enumLed) s.enumLed++;
    const fTrim = f.text.trim();
    const ldText = f.enumerator && enumLed && fTrim.startsWith(f.enumerator.raw)
      ? fTrim.slice(f.enumerator.raw.length) : f.text;
    let letters = 0; let digits = 0;
    for (let ci = 0; ci < ldText.length; ci++) {
      const cc = ldText.charCodeAt(ci);
      if ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122)) letters++;
      else if (cc >= 48 && cc <= 57) digits++;
    }
    if (enumLed ? letters >= digits : (letters >= 2 && letters >= digits)) s.letterDom++;
    if (f.startsLower && !enumLed) s.lowerStart++;
    // A subtitle or sub-heading can separate a heading from its body, so substantial text two rows down also qualifies.
    const b1 = f.belowFeat;
    if (b1 && (b1.nChar >= 30 || (b1.belowFeat && b1.belowFeat.nChar >= 30))) s.headsBody++;
  }
  /** @type {Set<string>} */
  const headingSigs = new Set();
  for (const [key, s] of sigStats) {
    if (s.n < 2) continue; // one-offs go to the display-singleton fallback
    if ((s.strong + s.weak) / s.n < 0.7) continue;
    if (s.short / s.n < 0.5) continue; // majority short of the column (wrapped headings dilute the frac)
    if (s.letterDom / s.n < 0.5) continue; // Bates/ID label columns, "[1]"-style bracket markers
    if (s.lowerStart / s.n > 0.4) continue; // flowing styled prose (bold warnings, EULA blocks)
    if (s.headsBody / s.n < 0.25) continue; // floating labels / code
    // Same-size family/colour distinction alone is weak evidence, so a class with no strong instances needs a size-bumped or enumerator-led majority to qualify.
    if (!s.strong && s.weakBig / s.n < 0.5 && s.enumLed / s.n < 0.5) continue;
    headingSigs.add(key);
  }
  model.headingSigs = headingSigs;
  model.headingSigStats = sigStats;

  // Classify in reading order so each line sees the already-classified line above it on the same page.
  for (let i = 0; i < feats.length; i++) {
    const prev = i > 0 && feats[i - 1].page === feats[i].page ? feats[i - 1] : null;
    feats[i].role = classifyRole(feats[i], model, colWidth, prev);
  }

  // A note's continuation lines carry no marker, so identify them by column position and matching style, not by extraction-order adjacency, which sweeps unrelated content into the note role.
  {
    /** @type {Map<number, LineFeat[]>} */
    const absorbByPage = new Map();
    for (const f of feats) {
      let arr = absorbByPage.get(f.page);
      if (!arr) { arr = []; absorbByPage.set(f.page, arr); }
      arr.push(f);
    }
    for (const [, pf] of absorbByPage) {
      const sorted = [...pf].sort((a, b) => a.top - b.top || a.left - b.left);
      for (let i = 0; i < sorted.length; i++) {
        const start = sorted[i];
        if (start.role !== 'footnote' && start.role !== 'endnote') continue;
        // A bare marker line is set smaller than its note text, so the note's size regime comes from the first absorbed text line, not the marker.
        const startBare = /^[\d*†‡∗⁰¹²³⁴-⁹]{1,3}$/.test(start.text.trim().replace(/[.)\]/]+$/, ''));
        let sizeRef = start.size;
        let cur = start;
        // A bare start is only the marker, which hangs left of its note column by up to a 0.5in tab, so its real column is not start.left but is learned from the first absorbed text line.
        let colRight = start.left;
        // The 80-line budget bounds the walk on cell-dense pages.
        for (let j = i + 1; j < sorted.length && j - i <= 80; j++) {
          const g = sorted[j];
          // The next note takes over as absorber when the outer loop reaches it.
          if (g.role === 'footnote' || g.role === 'endnote') break;
          // Once a bare paragraph-indent marker (tabbed in, wraps at the flush margin) has absorbed its text, the left bound widens to the page flush.
          // That widening applies only to a note visibly below body size, so a body-sized note cannot absorb the body paragraph that follows it.
          const leftMin = (startBare && cur !== start && sizeRef <= bodySize * 0.88
            ? Math.min(start.left, (model.pageFlush.get(start.page) ?? model.bodyLeft))
            : start.left) - bodySize * 0.6;
          if (g.left < leftMin
            || g.left - colRight > bodySize * (startBare && cur === start ? 3.5 : 2.5)) continue;
          if (g.role !== 'body') break; // heading/furniture in the note's own column: the note has ended
          if (g.runningFurniture || g.lineNum || g.folio || g.inTable) break;
          if (g.top - cur.top > leading * 2.2) break;
          // A plain note never continues into bold display text.
          if (startBare && cur === start) {
            if (g.size < start.size * 0.9 || !(g.sizeRatio <= 1.08 || g.size <= bodySize * 1.08)) break;
            sizeRef = g.size;
            colRight = Math.max(colRight, g.left);
          } else if (Math.abs(g.size - sizeRef) > sizeRef * 0.12) break;
          if (g.bold >= 0.9 && start.bold < 0.6) break;
          g.role = start.role;
          cur = g;
        }
      }
    }
  }

  // A bold term opening a body paragraph can mis-promote to a heading and split the paragraph, so demote a bold-only heading back to body.
  // familyDistinct is deliberately not among the size/all-caps/colour-distinct guards that spare real headings.
  // A bold weight registers under a different font name than the body face, so familyDistinct would fire on genuine same-typeface bold run-ins and wrongly preserve them.
  for (let i = 0; i < feats.length; i++) {
    const f = feats[i];
    if (f.role !== 'heading' || f.sizeRatio >= 1.15 || f.allCaps || f.colorDistinct || f.bold <= 0.6) continue;
    // Continuation = the first markedly-less-bold line after f on the same page, skipping further bold lines that are the rest of a multi-line bold name.
    let j = i + 1;
    while (j < feats.length && feats[j].page === f.page && feats[j].bold > 0.6) j++;
    const g = j < feats.length && feats[j].page === f.page ? feats[j] : null;
    // f is a run-in, not a heading, when its non-bold body g either continues the bold across the line break (gContinuesBold) or is a lowercase run-on of the same line (g.startsLower).
    // g.startsLower is the strict lowercase-letter form: the looser `!/^[A-Z]/` read a quote-led or digit-led fresh entry after a genuine heading as a run-on and wrongly demoted the heading.
    const gContinuesBold = g && g.line.words[0] && g.line.words[0].style && g.line.words[0].style.bold;
    if (g && g.role === 'body' && g.bold < f.bold - 0.3 && (gContinuesBold || g.startsLower)) {
      // `enumerator` is the primary signal, catching the lowercase-roman "ii." and lettered "a)" heading forms the uppercase-only regex misses.
      // The regex only backstops a heading whose enumerator the parser missed.
      // Bullet and sup-ref schemes are excluded because they are not ordinal heading markers, so a bold bullet stays eligible for demotion instead of freezing as a false heading.
      const sectionHeadingLine = (feat) => {
        const en = feat.enumerator;
        return (en && en.scheme !== 'bullet' && en.scheme !== 'sup-ref')
          || /^(?:[IVXLCDM]+|\d{1,3}|[A-Z])\.\s/.test(feat.text.trim());
      };
      // A bold run whose lead line is section-heading form is a wrapped heading, so keep the whole run as heading and skip past it rather than shredding it by demoting the marker-less lines.
      // Exception: form alone cannot tell a wrapped heading from an enumerated run-in lead-in, so a shared struct element (sameElementRunIn) marks it a run-in and demotes it.
      // Untagged pages (structId null) keep the conservative exemption.
      const sameElementRunIn = !!(g && f.structId != null && g.structId === f.structId);
      if (sectionHeadingLine(f) && !sameElementRunIn) { i = j - 1; continue; }
      for (let k = i; k < j; k++) {
        if (sectionHeadingLine(feats[k]) && !sameElementRunIn) continue;
        feats[k].role = 'body';
      }
    }
  }

  // Inline hyperlinked case citations (link-blue + underline) can dominate a line's char-weighted colour/family and mark it role='heading', splitting one running paragraph at a false title.
  // The tests below demote a colour/family heading whose distinct styling is inline rather than uniform.
  // The non-heading requirement in (b) spares a genuine wrapped colour/family heading, whose distinct neighbours are its own heading lines rather than body prose.
  for (let i = 0; i < feats.length; i++) {
    const f = feats[i];
    if (f.role !== 'heading' || f.sizeRatio >= 1.15 || f.bold > 0.6) continue;
    if (!f.colorDistinct && !f.familyDistinct) continue;
    const bodyColor = pageBodyColor.get(f.page) || '#000000';
    const bodyFamily = pageBodyFamily.get(f.page) || bodyFontFamily;
    const bodyStyled = (w) => !!w && (w.style.color || '#000000') === bodyColor && (w.style.font || '') === bodyFamily;
    const distinctStyled = (w) => !!w && !bodyStyled(w);
    const words = f.line.words;
    // (a) the line carries both a body-styled and a distinct-styled word (the run starts/ends mid-line).
    const mixed = words.some(bodyStyled) && words.some((w) => !bodyStyled(w));
    // (b) the distinct run crosses a line boundary into an adjacent non-heading line.
    const prev = i > 0 && feats[i - 1].page === f.page ? feats[i - 1] : null;
    const next = i + 1 < feats.length && feats[i + 1].page === f.page ? feats[i + 1] : null;
    const flowsIn = !!prev && prev.role !== 'heading'
      && distinctStyled(prev.line.words[prev.line.words.length - 1]) && distinctStyled(words[0]);
    const flowsOut = !!next && next.role !== 'heading'
      && distinctStyled(words[words.length - 1]) && distinctStyled(next.line.words[0]);
    if (mixed || flowsIn || flowsOut) f.role = 'body';
  }

  // Bookmarks name headings that classifyRole cannot detect: same size and weight as body text.
  for (const f of feats) {
    if (f.role !== 'body') continue;
    const anchors = pages[f.page] && pages[f.page].outlineHeadings;
    if (anchors && anchors.has(normalizeHeadingText(f.text))) f.role = 'heading';
  }

  // .docx export drops header/footer paragraphs, so this net demotes back to body a page whose real body was misclassified as furniture and would be silently deleted.
  // A sparse divider/cover page legitimately has furniture dominating its little text, so also require more furniture lines (>= 8) than genuine page furniture ever runs.
  const linesByPage = new Map();
  for (const f of feats) { if (!linesByPage.has(f.page)) linesByPage.set(f.page, []); linesByPage.get(f.page).push(f); }
  for (const [, pf] of linesByPage) {
    const total = pf.reduce((s, f) => s + f.nChar, 0);
    const furnChars = pf.reduce((s, f) => s + ((f.role === 'header' || f.role === 'footer') ? f.nChar : 0), 0);
    const furnLines = pf.reduce((s, f) => s + ((f.role === 'header' || f.role === 'footer') ? 1 : 0), 0);
    if (total > 0 && furnChars / total > 0.5 && furnLines >= 8) {
      for (const f of pf) if (f.role === 'header' || f.role === 'footer') f.role = 'body';
    }
  }

  // 'alpha-dot'/'roman-dot' are held non-splittable doc-wide because a bare line-leading "a." or "ii." is usually an initial, abbreviation, or citation fragment, not a list marker.
  // Genuine lists are recovered here per-run and flagged listConfirmed so only those members split, leaving scattered prose initials untouched.
  for (const scheme of ['alpha-dot', 'roman-dot']) {
    /** @type {Array<{members: Array<LineFeat>, column: number}>} */
    const runs = [];
    /** @type {Array<LineFeat>} */
    let run = [];
    let runColumn = 0;
    let broken = false; // a disqualifying line (heading/other-list) seen since the last run member
    const closeRun = () => { if (run.length >= 2) runs.push({ members: run, column: runColumn }); run = []; };
    for (const f of feats) {
      const en = f.enumerator;
      const isMarker = en && en.scheme === scheme && en.value != null && f.role === 'body';
      if (isMarker) {
        if (run.length && !broken
          && en.value === run[run.length - 1].enumerator.value + 1
          && Math.abs(f.left - runColumn) <= bodySize * 0.5) {
          run.push(f);
        } else {
          closeRun();
          run = [f]; runColumn = f.left; broken = false;
        }
      } else if (run.length && !broken) {
        // An intervening line breaks the run only if it is structural: a heading/title (a new section) or a marker of a different active scheme (a different list).
        // Furniture interleaves in content-stream order and is skipped, and ordinary body lines are item wraps.
        if (f.role === 'heading' || f.role === 'title') broken = true;
        else if (en && en.scheme !== scheme && model.schemes[en.scheme] && model.schemes[en.scheme].active) broken = true;
      }
    }
    closeRun();
    // A run of >=3 aligned markers proves its column hosts a lettered list (three stray initials aligning consecutively is implausible), so it confirms even at the body margin.
    // The >=2 relaxation confirms a shorter run only when its column was already proved by a >=3 run and is indented past body prose.
    // At the body margin, prose initials and wrapped case-citations that start a line are indistinguishable from a two-letter list.
    const provenColumns = runs.filter((r) => r.members.length >= 3).map((r) => r.column);
    for (const r of runs) {
      const indentedSubColumn = r.column > bodyTextLeft + bodySize * 0.5;
      if (r.members.length >= 3
        || (indentedSubColumn && provenColumns.some((c) => Math.abs(c - r.column) <= bodySize * 0.5))) {
        for (const m of r.members) m.listConfirmed = true;
      }
    }
  }

  // A lone dash doubles as inline sentence punctuation, not a list marker, so only a run of >=3 column-aligned dash markers is confirmed as a list.
  // Confirmed members get listConfirmed, which promotes them to strong markers in the bullet rule (strongScheme otherwise excludes a bare dash).
  {
    /** @type {Array<Array<LineFeat>>} */
    const runs = [];
    /** @type {Array<LineFeat>} */
    let run = [];
    let runColumn = 0;
    let broken = false;
    const isDash = (f) => f.enumerator && f.enumerator.scheme === 'bullet' && /^[–—-]$/.test(f.enumerator.raw);
    const closeRun = () => { if (run.length >= 3) runs.push(run); run = []; };
    for (const f of feats) {
      if (isDash(f) && f.role === 'body') {
        if (run.length && !broken && Math.abs(f.left - runColumn) <= bodySize * 0.5) {
          run.push(f);
        } else {
          closeRun();
          run = [f]; runColumn = f.left; broken = false;
        }
      } else if (run.length && !broken) {
        const en = f.enumerator;
        if (f.role === 'heading' || f.role === 'title') broken = true;
        else if (en && en.scheme === 'bullet') broken = true; // a different bullet glyph is a different list
        else if (en && model.schemes[en.scheme] && model.schemes[en.scheme].active) broken = true;
      }
    }
    closeRun();
    for (const r of runs) for (const m of r) m.listConfirmed = true;
  }

  // Group lines into paragraphs per page.
  const featByPage = new Map();
  for (const f of feats) {
    if (!featByPage.has(f.page)) featByPage.set(f.page, []);
    featByPage.get(f.page).push(f);
  }

  // Flags hanging markers by a recurring outdent column left of the body text: a transcript "Q"/"A"/"BY MR. X" speaker label, or a hanging-indent item label.
  // Keys on that geometry, never on the marker's text, so it catches any such marker rather than only the "Q"/"A" case.
  /** @type {LineFeat[]} */
  const leadCands = [];
  for (const [p, arr] of featsByPage) {
    if (pageColumns.get(p)) continue; // multi-column page: same-row fragments are columns, not marker+body
    for (let i = 0; i < arr.length; i++) {
      const f = arr[i];
      if (f.lineNum || f.left >= bodyTextLeft - bodySize) continue;
      let cwc = 0; for (const w of f.line.words) if (!w.lineNum && ++cwc > 2) break;
      if (cwc > 2) continue; // a marker is a few chars (<= 2 content words), not a wrapped body line
      // A same-row line to f's right at the body column = the testimony this lead introduces.
      // feats are top-sorted, so f's row is a short contiguous span around i: scan out only while the top stays in band.
      let hasBody = false;
      for (let j = i + 1; j < arr.length && arr[j].top - f.top < Math.min(f.height, arr[j].height) * 0.5; j++) {
        if (!arr[j].lineNum && arr[j].left > f.right && Math.abs(arr[j].left - bodyTextLeft) <= bodySize) { hasBody = true; break; }
      }
      for (let j = i - 1; j >= 0 && f.top - arr[j].top < Math.min(f.height, arr[j].height) * 0.5 && !hasBody; j--) {
        if (!arr[j].lineNum && arr[j].left > f.right && Math.abs(arr[j].left - bodyTextLeft) <= bodySize) { hasBody = true; break; }
      }
      if (hasBody) leadCands.push(f);
    }
  }
  const leadPeaks = clusterPeaks(leadCands.map((f) => f.left), bodySize * 0.5).sort((a, b) => b.count - a.count);
  const leadPk = leadPeaks[0];
  if (leadPk && leadPk.count >= Math.max(6, feats.length * 0.02)) {
    for (const f of leadCands) if (Math.abs(f.left - leadPk.center) <= bodySize) f.hangMarker = true;
  }

  // Drawn horizontal separator rules per page (from the PDF parser, in line-bbox coordinate space), so geometricBreak can split a paragraph across a rule lying in the gap between two lines.
  /** @type {Map<number, Array<{y:number, left:number, right:number}>>} */
  const pageRules = new Map();
  for (let p = 0; p < pages.length; p++) pageRules.set(p, pages[p].rules || []);
  model.pageRules = pageRules;

  // inInsetRun marks >=2 consecutive same-column lines at one left edge, separating a block quote from a lone first-line indent for the per-line quote rules that run where the region pass declined.
  // Whether that margin is inset is established elsewhere (bothSideInset), not here.
  for (const [p, pf] of featByPage) {
    const pcols = pageColumns.get(p);
    const lineCol = pf.map((ln) => columnFor(ln.left, pcols, bodySize));
    for (let k = 0; k < pf.length; k++) {
      const prevSameMargin = k > 0 && lineCol[k - 1] === lineCol[k]
        && Math.abs(pf[k - 1].left - pf[k].left) < bodySize * 0.5;
      const nextSameMargin = k + 1 < pf.length && lineCol[k + 1] === lineCol[k]
        && Math.abs(pf[k + 1].left - pf[k].left) < bodySize * 0.5;
      pf[k].inInsetRun = prevSameMargin || nextSameMargin;
    }
  }

  // Row fragments: a superscript reference marker the line grouper emitted as its own "line" (raised, small, a bare "[34]"/"12"/"*") sits on the previous line's row.
  // Left in the flow it breaks the region walk's top-monotonic advance and becomes the neighbour the next real line's break is judged against.
  // The region pass and the paragraph-grouping loop route flow around flagged lines, which still join their row's paragraph.
  for (const [, pf] of featByPage) {
    let lastFlow = null;
    for (const f of pf) {
      if (lastFlow) {
        const overlap = Math.min(f.bottom, lastFlow.bottom) - Math.max(f.top, lastFlow.top);
        // f.left must sit inside (or right of) its row's text span: a margin line number on the same row sits left of the text and must keep flowing to the line-number machinery.
        // The right bound: a marker adjoins its row's text, while a corner page number sharing a heading's row sits across the page and must stay its own paragraph.
        if (overlap >= (f.bottom - f.top) * 0.5
          && (f.bottom - f.top) < (lastFlow.bottom - lastFlow.top) * 0.8
          && f.left > lastFlow.left + bodySize
          && f.left < lastFlow.right + bodySize * 2
          && /^\[?[\d*†‡]{1,3}\]?$/.test((f.text || '').trim())) {
          f.rowFragment = true;
          continue;
        }
      }
      lastFlow = f;
    }
  }

  // Layout regions: where a run of >=2 body lines shares one indented left margin at a homogeneous pitch (a block quote, an inset extract), tag the run with its own frame.
  // geometricBreak then judges interior lines against the run's edges, pitch, and local justification.
  // Without a frame each interior line reads as indented and short against the body column, and the first-line-indent and ends-early rules shred the quote into per-line paragraphs.
  // Do not add a document-level gate (skipping paraGapThresh === Infinity docs): the modal double-spaced filing yields Infinity yet its single-spaced inset quotes are the very runs needing frames.
  // Structural indented stacks are instead rejected by the bothSides/flows qualifiers below.
  // Multi-column pages segment within each column, so a non-leftmost column's lines do not all read as "indented".
  for (const [p, pfAll] of featByPage) {
    // Row fragments (flagged above) are invisible to the walk: a raised marker fragment between two quote lines would break the top-monotonic advance and split one block into two regions.
    const pf = pfAll.filter((ln) => !ln.rowFragment);
    const pageFlushP = pageFlush.get(p) ?? bodyLeft;
    const pcols = pageColumns.get(p) || null;
    const pageGap = pageParaGap.get(p);
    // A paragraph-sized gap always ends the run even where pitch-homogeneous: a first-line-indented paragraph after the quote begins at the same indent margin and must not be swallowed.
    // Where no gap regime exists, a section-jump cap keeps far-apart same-left lines from seeding a bogus 2-line run.
    const gapB = (pageGap != null && pageGap !== Infinity) ? pageGap : paraGapThresh;
    const advanceCap = Math.min(gapB, bodySize * 4);
    let k = 0;
    while (k < pf.length) {
      const anchor = pf[k];
      const col = columnFor(anchor.left, pcols, bodySize);
      const flushHere = col ? col.left : pageFlushP;
      const rightHere = col ? col.right : bodyRight;
      if (anchor.role !== 'body' || anchor.artifact || anchor.left <= flushHere + bodySize * 0.4) { k++; continue; }
      let j = k + 1;
      while (j < pf.length && pf[j].role === 'body' && !pf[j].artifact
        && Math.abs(pf[j].left - anchor.left) < bodySize * 0.5
        && columnFor(pf[j].left, pcols, bodySize) === col
        && pf[j].top - pf[j - 1].top > 0
        && pf[j].top - pf[j - 1].top <= advanceCap) j++;
      // A real block repeats one advance, so any advance beyond 1.3x the run's minimum is a seam (a lead-in above a quote, extra leading between quoted paragraphs), never an interior wrap.
      const advances = [];
      for (let i = k + 1; i < j; i++) advances.push(pf[i].top - pf[i - 1].top);
      const minAdv = advances.length ? Math.min(...advances) : 0;
      let segStart = k;
      for (let segEnd = k + 1; segEnd <= j; segEnd++) {
        if (segEnd < j && pf[segEnd].top - pf[segEnd - 1].top <= minAdv * 1.3) continue;
        if (segEnd - segStart >= 2) {
          const run = pf.slice(segStart, segEnd);
          const left = Math.min(...run.map((ln) => ln.left));
          const right = Math.max(...run.map((ln) => ln.right));
          // The run's shared left indent alone also matches a stack of one-line indented paragraphs that each reach full body width and end terminally.
          // A real quotation is additionally inset on the right and wraps some non-final line mid-sentence.
          const bothSides = rightHere - right >= (left - flushHere) * 0.5;
          const flows = run.slice(0, -1).some((ln) => !ln.endsTerminal);
          if (bothSides && flows) {
            const segAdv = run.slice(1).map((ln, i) => ln.top - run[i].top).sort((a, b) => a - b);
            // Region-local justification, judged against the region's own right edge.
            // Fewer than 3 measurable interior lines is too thin to call and stays false, leaving the ends-early rule unlicensed inside the region.
            const interior = run.slice(0, -1);
            const fullCount = interior.filter((ln) => ln.right >= right - (right - left) * 0.10).length;
            const region = {
              left,
              right,
              width: right - left,
              pitch: segAdv[Math.floor(segAdv.length / 2)],
              justifiedLocal: interior.length >= 3 && fullCount / interior.length >= 0.5,
            };
            for (const ln of run) ln.blockRegion = region;
            // A block's own first line often sits off the shared margin (a deeper first-line indent, a hanging entry's outdented opener), so the same-left walk starts one line late.
            // The region-entry break would then land mid-sentence inside the block, so absorb lines directly above into the region's membership.
            // Never absorb into its frame: an outdented opener would drag region.left leftward and re-arm the indent rule against the shifted flush.
            // Deeper-indented lines always qualify, while outdented ones qualify only at the document's hang body column, where outdented openers are the convention.
            // A lead-in above a quote never qualifies because its pitch seam (double-space) or terminal colon excludes it.
            // Up to 3 lines absorb (a real block opener never wraps longer), so an opener the grouper split into multiple raw lines (a superscript marker emitted as its own fragment) still joins.
            let memberTop = run[0];
            for (let a = 0; a < 3; a++) {
              const idx = pf.indexOf(memberTop);
              const above = idx > 0 ? pf[idx - 1] : null;
              if (!(above && !above.blockRegion && above.role === 'body' && !above.artifact
                && !above.endsTerminal
                && columnFor(above.left, pcols, bodySize) === col
                && memberTop.top - above.top > 0 && memberTop.top - above.top <= region.pitch * 1.3
                && (above.left > run[0].left + bodySize * 0.4
                  || (above.left < run[0].left - bodySize * 0.4
                    && bodyTextLeft > bodyLeft + bodySize * 0.5
                    && Math.abs(run[0].left - bodyTextLeft) < bodySize * 0.5)))) break;
              above.blockRegion = region;
              memberTop = above;
            }
          }
        }
        segStart = segEnd;
      }
      k = j;
    }
    // A fragment rides its row's line: give it that line's region so region transitions and the per-line quote rules see consistent membership across the row.
    let lastReal = null;
    for (const ln of pfAll) {
      if (ln.rowFragment) { if (lastReal && lastReal.blockRegion) ln.blockRegion = lastReal.blockRegion; continue; }
      lastReal = ln;
    }
  }

  // Exclude a page whose tags fuse distinct index/TOC entries into one element, even when otherwise well-tagged, because trusting that grouping would merge entries that geometry segments correctly.
  /** @type {Map<number, boolean>} */
  const pageStructUsable = new Map();
  for (const [p, pf] of featByPage) {
    const content = pf.filter((f) => !f.artifact && f.nChar >= 2);
    const resolved = content.filter((f) => f.structId != null).length;
    const frac = content.length ? resolved / content.length : 0;
    pageStructUsable.set(p, resolved >= 4 && frac >= 0.6 && !tocTagsFuseEntries(pf));
  }

  // Bare-integer note markers (no trailing dot, not superscript) carry no enumerator, so no numbering break fires and a page's whole note block over-merges into one paragraph.
  // footnoteOpener makes geometricBreak split before each chain member.
  // The >=2-member +1 chain rejects a stray or citation number and a lone note that merely opens with a digit.
  for (const [p, pf] of featByPage) {
    const fn = pf.filter((f) => f.role === 'footnote').sort((a, b) => a.top - b.top);
    if (fn.length < 2) continue;
    const lead = fn.map((f) => {
      const m = /^(\d{1,3})(?=\D|$)/.exec((f.text || '').trim());
      return m ? parseInt(m[1], 10) : null;
    });
    let best = [];
    for (let a = 0; a < fn.length; a++) {
      if (lead[a] == null) continue;
      const seq = [a];
      let expected = lead[a] + 1;
      for (let j = a + 1; j < fn.length; j++) if (lead[j] === expected) { seq.push(j); expected++; }
      if (seq.length > best.length) best = seq;
    }
    if (best.length < 2) continue;
    for (const idx of best) fn[idx].footnoteOpener = true;
    // The first note's marker was misclassified as 'body', so the footnote chain detected above starts at the second note.
    const firstVal = lead[best[0]];
    const topFn = fn[0].top;
    const flushMax = (pageFlush.get(p) ?? bodyLeft) + bodySize;
    for (const f of pf) {
      if (f.role !== 'body' || f.top >= topFn || topFn - f.top > leading * 3) continue;
      if (f.sizeRatio > 0.86 || f.left > flushMax) continue;
      if (/^\d{1,3}$/.test((f.text || '').trim()) && Number(f.text.trim()) === firstVal - 1) {
        f.role = 'footnote';
        f.footnoteOpener = true;
      }
    }
  }

  // The line-grouper fuses a leading margin line number into the text on its fragment.
  // Split it into a standalone linenum unit so the body opens with its real first word and regroups against the previous body line through the inline-line-number transparency.
  for (const [p, pf] of featByPage) {
    let split = false;
    const out = [];
    for (const f of pf) {
      const ws = f.line.words;
      let j = 0;
      if (!f.lineNum && ws.length && ws[0].lineNum) { while (j < ws.length && ws[j].lineNum) j++; }
      if (j > 0 && j < ws.length) {
        const lnWords = ws.slice(0, j);
        const lnLine = new OcrLine(f.line.page, calcBboxUnion(lnWords.map((w) => w.bbox)), f.line.baseline, f.line.ascHeight, f.line.xHeight);
        lnLine.words = lnWords;
        lnLine.orientation = f.line.orientation;
        out.push({
          ...f,
          line: lnLine,
          lineNum: true,
          role: 'linenum',
          hangMarker: false,
          folio: false,
          left: lnLine.bbox.left,
          right: lnLine.bbox.right,
          text: lnWords.map((w) => w.text).join(' '),
          nChar: lnWords.reduce((a, w) => a + (w.text.length || 1), 0),
        });
        f.line.words = ws.slice(j);
        f.line.bbox = calcBboxUnion(f.line.words.map((w) => w.bbox));
        f.text = f.line.words.map((w) => w.text).join(' ');
        f.lnSplit = true; // this body line had a line number split off it, shifting its left bbox right
        // Keep page.lines (which the exporters iterate) in step with the feat/par structure: insert the new line-number line immediately before its now-shrunk body line, in reading order.
        const li = pages[p].lines.indexOf(f.line);
        if (li >= 0) pages[p].lines.splice(li, 0, lnLine);
        split = true;
      }
      out.push(f);
    }
    if (split) featByPage.set(p, out);
  }

  const hangMarkerPars = new Set();
  const lnSplitPars = new Set();
  for (let p = 0; p < pages.length; p++) {
    const page = pages[p];
    const pf = featByPage.get(p) || [];
    const structMode = pageStructUsable.get(p) || false;
    /** @type {Array<OcrPar>} */
    const parArr = [];
    /** @type {?LineFeat} */
    let curParFirst = null;
    /** @type {?OcrPar} */
    let curBodyPar = null; // most recent body paragraph, the reattach target across an inline line number
    /** @type {?LineFeat} */
    let curBodyFirst = null; // first line of curBodyPar (its curParFirst), for the geometric decision
    /** @type {?LineFeat} */
    let prevBody = null; // last line that is not a standalone line number, the neighbour an inline number is seen through
    for (let k = 0; k < pf.length; k++) {
      const f = pf[k];
      let pi = k - 1;
      while (pi >= 0 && pf[pi].rowFragment) pi--;
      const immPrev = pi >= 0 ? pf[pi] : null;
      // Skip an inline line number sitting on f's own row when deciding f's break, or a transcript whose every body row is preceded by its margin number shreds into one paragraph per line.
      // A row fragment joins the paragraph its row belongs to and is invisible as a neighbour: the next real line's break is judged against the full-width line, not the raised marker.
      if (f.rowFragment && parArr.length > 0) {
        const par = (!f.lineNum && curBodyPar) ? curBodyPar : parArr[parArr.length - 1];
        par.lines.push(f.line);
        f.line.par = par;
        continue;
      }
      const inlineLN = !f.lineNum && !!immPrev && immPrev.lineNum
        && Math.abs(f.top - immPrev.top) < Math.min(f.height, immPrev.height) * 0.5;
      const prev = inlineLN ? prevBody : immPrev;
      const { newPar, reason } = decideBreak(f, prev, model, inlineLN ? curBodyFirst : curParFirst, structMode);
      /** @type {OcrPar} */
      let par;
      if (!f.lineNum && !newPar && curBodyPar) {
        // parArr's last may be a standalone line-number paragraph emitted between two body rows, so attach the continuing body line to curBodyPar instead.
        par = curBodyPar;
      } else if (newPar || parArr.length === 0) {
        curParFirst = f;
        par = new OcrPar(page, {
          left: 0, top: 0, right: 0, bottom: 0,
        });
        par.reason = reason;
        par.type = f.role === 'heading' ? 'title'
          : f.role === 'footnote' ? 'footnote'
            : f.role === 'endnote' ? 'endnote'
              : f.role === 'pagenum' ? 'pagenum'
                : f.role === 'header' ? 'header'
                  : f.role === 'footer' ? 'footer'
                    : f.role === 'linenum' ? 'linenum'
                      : 'body';
        if (f.enumerator) par.parNum = f.enumerator.raw;
        if (f.hangMarker) hangMarkerPars.add(par);
        par.debug.sourceType = f.role;
        parArr.push(par);
      } else {
        par = parArr[parArr.length - 1]; // a line number continuing a contiguous run
      }
      par.lines.push(f.line);
      if (f.lnSplit) lnSplitPars.add(par);
      f.line.par = par;
      if (!f.lineNum) { curBodyPar = par; curBodyFirst = curParFirst; prevBody = f; }
    }
    for (const par of parArr) {
      let uL = Infinity; let uT = Infinity; let uR = -Infinity; let uB = -Infinity;
      for (const ln of par.lines) {
        const bb = ln.bbox;
        if (bb.left < uL) uL = bb.left;
        if (bb.top < uT) uT = bb.top;
        if (bb.right > uR) uR = bb.right;
        if (bb.bottom > uB) uB = bb.bottom;
      }
      par.bbox = {
        left: uL, top: uT, right: uR, bottom: uB,
      };
    }
    page.pars = parArr;
  }

  // Block-quote identification (post-grouping).
  // Re-tags body -> blockquote so the .docx export renders it with Word's "Quote" style.
  // Runs after grouping because the right-margin test needs par.bbox, which exists only once lines are grouped.
  // Indent is judged against the doc body margin, not this page's flush.
  // On a quote-dense page the most-common left is itself the quote margin, so pageFlush would zero the indent and miss every quote there.
  const structQuotePars = new Set();
  for (const [, pf] of featByPage) {
    for (const f of pf) {
      if ((f.structRole === 'BlockQuote' || f.structRole === 'Quote') && f.line.par) structQuotePars.add(f.line.par);
    }
  }
  for (let p = 0; p < pages.length; p++) {
    for (const par of pages[p].pars) {
      if (par.type !== 'body') continue;
      const leftIndent = par.bbox.left - bodyLeft;
      const rightInset = bodyRight - par.bbox.right;
      const geo = par.lines.length >= 2
        && leftIndent > colWidth * 0.035
        && rightInset > colWidth * 0.035
        && Math.abs(leftIndent - rightInset) < colWidth * 0.06;
      // A split-off leading line number shifts a transcript turn's left bbox into the testimony column, which reads as a false both-side inset, so lnSplit turns are excluded here.
      // A genuine inset quotation is not line-numbered on its own quoted lines, so it never lands in lnSplitPars and this guard drops no real block quote.
      if (hangMarkerPars.has(par) || lnSplitPars.has(par)) continue;
      if (structQuotePars.has(par) || par.lines.some((l) => l.blockRegion) || geo) par.type = 'blockquote';
    }
  }

  // Footnote linking: set the same par.footnoteRefId <-> word.footnoteParId link the .docx importer produces, so exporters can emit real footnotes rather than inline text.
  const markerRe = /^[\d*†‡]{1,3}$/;
  const labelOf = (t) => (t || '').trim().replace(/[.)\]]+$/, '');
  const bodyMarkers = []; // { order, page, word, label }, ascending by reading order
  for (let p = 0; p < pages.length; p++) {
    const { lines } = pages[p];
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (line.par && (line.par.type === 'footnote' || line.par.type === 'endnote')) continue; // a marker inside a note is not a body reference
      for (const word of line.words) {
        if (!word.style || !word.style.sup) continue;
        const label = labelOf(word.text);
        if (!markerRe.test(label)) continue;
        bodyMarkers.push({
          order: p * 100000 + li, page: p, word, label,
        });
      }
    }
  }

  for (let p = 0; p < pages.length; p++) {
    for (const par of pages[p].pars) {
      if ((par.type !== 'footnote' && par.type !== 'endnote') || par.footnoteRefId) continue;
      // The note's own label: its enumerator if present, else its leading superscript marker word.
      let label = par.parNum && markerRe.test(labelOf(par.parNum)) ? labelOf(par.parNum) : null;
      if (!label) {
        const w0 = par.lines[0] && par.lines[0].words[0];
        if (w0 && w0.style && w0.style.sup && markerRe.test(labelOf(w0.text))) label = labelOf(w0.text);
      }
      if (!label) continue;
      const fnLineIdx = pages[p].lines.indexOf(par.lines[0]);
      const fnOrder = p * 100000 + (fnLineIdx < 0 ? 99999 : fnLineIdx);
      // Nearest preceding unlinked marker with the same label: bodyMarkers is in reading order, so the last qualifying entry before fnOrder is the nearest, on the footnote's own page if one exists.
      let best = null;
      for (const m of bodyMarkers) {
        if (m.order >= fnOrder) break;
        if (m.word.footnoteParId || m.label !== label) continue;
        best = m;
      }
      if (best) {
        par.footnoteRefId = best.word.id;
        best.word.footnoteParId = par.id;
      }
    }
  }

  if (opts.debug) return { model, feats };
  return model;
}

// Decision: does line `f` start a new paragraph relative to `prev`?
/**
 * @param {LineFeat} f
 * @param {?LineFeat} prev
 * @param {LayoutModel} model
 * @param {?LineFeat} curParFirst
 * @param {boolean} [structMode] - group lines by their owning struct element instead of by geometry.
 */
function decideBreak(f, prev, model, curParFirst, structMode) {
  if (!prev) return { newPar: true, reason: 'first line' };
  if (f.orientation !== prev.orientation) return { newPar: true, reason: 'orientation change' };

  // Keep this before the struct logic.
  // The lowercase-continuation guard below would otherwise merge a page-top continuation that follows a page-bottom line number into the number's paragraph.
  // That paragraph then takes the 'linenum' role and is dropped from reflowed-text exports.
  if (f.lineNum !== prev.lineNum) return { newPar: true, reason: 'line-number boundary' };

  const geo = geometricBreak(f, prev, model, curParFirst);

  // Structural overlay: on a struct-eligible page, when both lines carry a trustworthy owning element the element defines the paragraph.
  if (structMode && f.structId != null && prev.structId != null) {
    if (f.structId === prev.structId) {
      // Same element means one paragraph: trust the producer's grouping over geometry, since over-splitting is what the tags exist to fix.
      // weakAllCapsRole: a body-styled all-caps line promoted only through a caps heading signature is an in-prose acronym wrapped onto its own line.
      // Its role-change break must not split the element.
      const weakAllCapsRole = geo.reason.startsWith('role change')
        && [f, prev].some((x) => x.role === 'heading' && x.allCaps
          && x.sizeRatio < 1.15 && x.bold <= 0.6 && !x.colorDistinct && !x.familyDistinct);
      // A first-line indent also overrides the element on a page whose own indent regime passed the dominance bar (model.pageIndentDeltas), the per-page counterpart of indentStrong.
      // That covers docs whose producer fused whole tagged elements across real indented paragraphs.
      const pageIndentStrong = geo.reason === 'first-line indent'
        && (((model.pageIndentDeltas && model.pageIndentDeltas.get(f.page)) || []).length > 0);
      if (geo.newPar && (isStrongBreak(geo.reason, model) || pageIndentStrong) && !weakAllCapsRole) return geo;
      return { newPar: false, reason: 'struct element (same)' };
    }
    // Different struct tags mark distinct heading levels the producer set (H1 banner over its H2).
    // The geometric heading-run merge below would otherwise fuse them when the two lines share a center axis.
    // Scoped to differing tags so a single heading the producer fragmented into same-tag elements still merges via geometry.
    if (f.role === 'heading' && prev.role === 'heading'
        && f.structRole && prev.structRole && f.structRole !== prev.structRole) {
      return { newPar: true, reason: 'struct element (heading level)' };
    }
    // An element-faithful producer can fragment one running sentence across elements, so a lowercase line after a prev that did not close is a continuation and merges despite the element boundary.
    // enumeratedListItemStart exempts a lowercase enumerator ("d)") so it still splits as the real new item it is, not a continuation.
    if (model.elementFaithful) {
      if (f.startsLower && !prev.endsTerminal && !enumeratedListItemStart(f, model)) {
        return { newPar: false, reason: 'struct continuation' };
      }
      // A producer fragments one multi-line heading into a /P element per line, so under element-faithful the element boundary spuriously splits the wrapped heading.
      if (f.role === 'heading' && prev.role === 'heading' && !geo.newPar) {
        return { newPar: false, reason: 'struct continuation (heading run)' };
      }
      // Merges a trailing dot-leader line ("... ... 24") the producer split into its own element back into the unfinished TOC/index entry above it.
      // The prev-has-no-leader test is what stops this from over-merging a hierarchical TOC, where every line is its own complete leader entry ("6.9 ...5" then "6.9.1 ...5").
      const leaderForm = /(?:\.\s*){3,}\d{1,4}$/; // solid or spaced dot leaders (see pageLeaderCount)
      if (curParFirst && f.left > curParFirst.left + model.bodySize * 0.5 && !geo.newPar
        && prev.page === f.page && f.top - prev.top < model.leading * 1.5
        && leaderForm.test(f.text.trim()) && !leaderForm.test(prev.text.trim())) {
        return { newPar: false, reason: 'struct continuation (hanging)' };
      }
      return { newPar: true, reason: 'struct element' };
    }
    // A lowercase-starting enumerated list item ("a)", "i)") is a real sibling item, so split it here before the lowercase-continuation guard below merges it on its lowercase start.
    if (f.startsLower && f.enumerator && enumeratedListItemStart(f, model)) {
      return { newPar: true, reason: `numbering (${f.enumerator.scheme} ${f.enumerator.raw})` };
    }
    // In an indent-strong doc every real paragraph begins with an indent, so a line triggering no geometric break is a continuation despite the producer tagging it as its own element.
    // Block-style docs are excluded because there the tags are the only paragraph signal.
    // The leading*2 contiguity check is required because paraGapThresh is Infinity on indent pages, so without it a distant separate element would be wrongly merged.
    if (model.indentStrong && !geo.newPar
      && prev.page === f.page && f.top - prev.top < model.leading * 2) {
      return { newPar: false, reason: 'struct continuation (indent doc)' };
    }
    // A line that starts lowercase continues the previous sentence (a real paragraph or heading is capitalized), so keep it merged despite the separate structure element.
    if (f.startsLower) return { newPar: false, reason: 'struct continuation' };
    return { newPar: true, reason: 'struct element' };
  }
  return geo;
}

/**
 * A geometric break that cannot occur mid-paragraph in wrapped prose, so it may split even inside one structure element.
 * @param {string} reason
 * @param {LayoutModel} model
 */
function isStrongBreak(reason, model) {
  return reason === 'paragraph gap'
    || reason === 'separator rule'
    || reason === 'footnote marker'
    || reason === 'bullet'
    || reason === 'drop cap'
    || reason.startsWith('numbering')
    || reason.startsWith('role change')
    || (reason === 'first-line indent' && model.indentStrong);
}

/**
 * @param {LineFeat} f
 * @param {LineFeat} prev
 * @param {LayoutModel} model
 * @param {?LineFeat} curParFirst
 */
function geometricBreak(f, prev, model, curParFirst) {
  if (f.top < prev.top - f.height * 0.5) return { newPar: true, reason: 'new column' };

  // Furniture (running header/footer, Bates stamp) is often painted out of visual position in the content stream.
  // A top-margin line and a bottom-margin line can therefore land adjacent despite sitting at opposite page extremes.
  // No real paragraph spans half the page height, so a >half-page downward jump between consecutive lines is always a boundary.
  if (f.topFrac - prev.topFrac > 0.5) return { newPar: true, reason: 'page wrap' };

  // A hanging marker starts a new paragraph even after a full prior line, where the justified ends-early rule cannot fire.
  if (f.hangMarker) return { newPar: true, reason: 'hanging marker' };

  // A drawn rule in the vertical gap between prev and f is a block boundary the geometry alone misses.
  // The strict rule.y > prev.bottom bound excludes text underlines, which sit inside their line's bbox rather than in the gap.
  if (prev.page === f.page) {
    const rules = model.pageRules && model.pageRules.get(f.page);
    if (rules) {
      const spanLeft = Math.min(prev.left, f.left);
      const spanRight = Math.max(prev.right, f.right);
      for (const rule of rules) {
        if (rule.y > prev.bottom && rule.y < f.top
          && rule.right > spanLeft && rule.left < spanRight) {
          return { newPar: true, reason: 'separator rule' };
        }
      }
    }
  }
  // A footnote note opener (flagged in phase 3): the next bare-integer marker in the page's note sequence begins a new note.
  // Bare-integer markers carry no enumerator for the numbering rule below, and the sequence flag already confirmed this one, so the break is unconditional and strong.
  if (f.footnoteOpener) return { newPar: true, reason: 'footnote marker' };

  const colJump = model.bodySize * 1.5;
  const sameColumn = Math.abs(f.left - prev.left) < model.colWidth * 0.5
    || Math.abs(f.left - model.bodyLeft) < colJump
    || (model.indentActive && Math.abs(f.left - model.indentCol) < colJump);

  // Syntax-blind continuation (body-frame): a line ending on a bare word or digit, with no punctuation of any kind, cannot end a paragraph in prose.
  // This catches what startsContinuation's lowercase test cannot: continuations opening on a capitalized noun, a digit, or a bracket, which otherwise shred double-spaced prose line-per-line.
  // Real paragraph and list boundaries are untouched: their prev lines end with some punctuation, and real blank-line gaps exceed the pitch bound.
  // The bare-word test is deliberately stricter than !endsTerminal, which a line ending in ";" or "," still passes, so enumerated legal lists keep splitting.
  // Three wrap shapes qualify: same margin (wrap under wrap), the first-line-indent pop-back, and the hanging-marker wrap commented below.
  // In the pop-back shape prev is the paragraph's own indented opener (curParFirst) and f returns left to the page flush.
  const flowPitch = Math.max((model.pageBodyPitch && model.pageBodyPitch.get(f.page)) || 0, model.leading);
  const pageFlushHere = (model.pageFlush && model.pageFlush.get(f.page)) ?? model.bodyLeft;
  const prevTrim = (prev.text || '').trim();
  // The digit exclusion: "...our mutual success. 32" ends on a footnote-reference digit run after punctuation, a punctuated line ending rather than a bare-word wrap.
  // \p{L}\p{N}, not [A-Za-z0-9]: non-Latin text (and Latin-1-mojibake extractions) must qualify as bare word ends too, or no line of a Cyrillic document ever earns the veto.
  const bareWordEnd = /[\p{L}\p{N}]$/u.test(prevTrim) && !/[.!?:;,]["')”’]?\s*\d{1,3}$/.test(prevTrim);
  const bareContinuation = prev.role === 'body' && f.role === 'body'
    && prev.page === f.page
    && bareWordEnd
    && (Math.abs(f.left - prev.left) < model.bodySize * 0.5
      || (prev === curParFirst
        && prev.left > f.left + model.bodySize * 0.4
        && prev.left - f.left <= model.bodySize * 4
        // Flush is checked against both the page's own flush and the doc body margin.
        // On a quote-dense page the most-common left is itself the quote margin, and a body paragraph's pop-back lands at the doc margin, not that one.
        && (Math.abs(f.left - pageFlushHere) < model.bodySize * 0.5
          || Math.abs(f.left - model.bodyLeft) < model.bodySize * 0.5))
      // Hanging-marker wrap: prev opens on a short outdented marker token ("3", "(a)") with its text starting at a deeper column, and the wrap lands at that text column (the second word's left).
      // prev.left is the marker's, so the same-margin test above cannot see this shape.
      || (prev.line && prev.line.words.length >= 2 && prev.line.words[0].text.length <= 3
        && prev.left < f.left - model.bodySize * 0.4
        && Math.abs(prev.line.words[1].bbox.left - f.left) < model.bodySize * 0.5))
    && f.fontFamily === prev.fontFamily
    && Math.abs(f.size - prev.size) <= model.bodySize * 0.1
    // Advance is judged top-to-top or bottom-to-bottom, whichever is smaller: a single tall glyph in one line inflates the top advance while the baselines still flow at pitch.
    && f.top - prev.top > 0
    && Math.min(f.top - prev.top, (f.top + f.height) - (prev.top + prev.height)) <= flowPitch * 1.3;

  // Reference pages (TOC / Table of Authorities / index): >=3 body lines ending in a dot-leader + page number mark a reference list, whose entries the margin rules misread in both directions.
  // A wrapped title splits at its hanging margin while the next entry's opener fuses into the line above, and an entry name severs from its own cite line.
  // On such a page the leader line itself is the structure: it terminates its entry, and until a leader or a terminal line closes the entry, following body lines at entry pitch belong to it.
  const leaderRe = /(?:\.\s*){3,}\d{1,4}$/; // solid or spaced dot leaders (see pageLeaderCount)
  const onLeaderPage = ((model.pageLeaderCount && model.pageLeaderCount.get(f.page)) || 0) >= 3;
  if (onLeaderPage && prev.page === f.page && f.role === 'body' && prev.role === 'body'
      && leaderRe.test(prevTrim)) {
    return { newPar: true, reason: 'reference entry' };
  }
  const refEntryContinuation = onLeaderPage && prev.page === f.page
    && f.role === 'body' && prev.role === 'body'
    && !leaderRe.test(prevTrim) && !prev.endsTerminal
    && f.top - prev.top > 0 && f.top - prev.top <= flowPitch * 1.3;

  // The gates (the value's neighbour occurs in the sequence, and the line follows a completed item) reject false enumerators.
  // Those are initials and abbreviations landing at a line start after a wrap (a name wrapped before its middle initial "S.") that match an enumerator pattern while continuing the sentence.
  if (f.enumerator) {
    const sc = model.schemes[f.enumerator.scheme];
    // A dash marker is kept out of strongScheme because a dash doubles as inline em-dash punctuation.
    // A wrapped em-dash clause opens a line mid-prose where a true bullet glyph never would, so it must clear followsComplete rather than qualify on its own.
    const dashMarker = f.enumerator.scheme === 'bullet' && /^[–—-]$/.test(f.enumerator.raw);
    const strongScheme = f.enumerator.scheme === 'section' || f.enumerator.scheme.startsWith('paren-')
      || f.enumerator.scheme === 'alpha-paren' || f.enumerator.scheme === 'roman-paren'
      || (f.enumerator.scheme === 'bullet' && !dashMarker) || f.enumerator.scheme === 'bracket-num'
      || f.listConfirmed; // a confirmed local-list member is as distinctive as a close-paren marker
    const followsComplete = strongScheme || prev.endsTerminal || prev.role !== 'body' || prev.role !== f.role;
    // A marker line that is really a wrap of the open item (bare-word prev, same margin/face/pitch, sitting at the item's wrap column) is inline text that happens to open on a marker pattern.
    // A real sibling or nested item opens at a marker column (curParFirst's own left, or outdented), never deeper at the wrap column after a mid-phrase line, so flat dotless lists keep splitting.
    const wrappedMidItem = bareContinuation && !!curParFirst
      && f.left > curParFirst.left + model.bodySize * 0.5;
    // A confirmed list-region member splits even though its dot-form scheme is non-splittable doc-wide: local structure (the run) has already disambiguated it from a prose initial.
    if (((sc && sc.active) || f.listConfirmed) && followsComplete && !wrappedMidItem) {
      if (f.enumerator.scheme === 'bullet') return { newPar: true, reason: 'bullet' };
      if (f.enumerator.value != null && (f.listConfirmed || sc.sequenceValues.has(f.enumerator.value))) {
        return { newPar: true, reason: `numbering (${f.enumerator.scheme} ${f.enumerator.raw})` };
      }
    }
  }

  // A bold run-in heading that flows into non-bold body on the same line ("TERRORIST ATTACKS. We cannot...") stays role 'body' and typically opens with no first-line indent.
  // On an indent-delimited page whose gap rule is off, nothing else then marks the boundary and the subsection fuses into the paragraph above.
  // leadHeadingFace keys on the typeface, not the caps, since a mixed-case lead in the heading face is invisible to the all-caps test.
  // letters >= digits keeps tabular figures in the bold heading face ("$ 12,460") from reading as a lead-in.
  // prevComplete requires prev to have ended a sentence or sit a full gap above, so an ordinary wrapped line that merely opens on bold words never splits.
  if (model.boldHeading && prev.role === 'body' && f.role === 'body') {
    const words = f.line.words;
    let k = 0;
    while (k < words.length && words[k].style && words[k].style.bold) k++;
    const lead = words.slice(0, k);
    const leadAllCaps = k >= 2 && lead.every((w) => {
      const t = (w.text || '').trim();
      return /[A-Z]/.test(t) && t === t.toUpperCase();
    });
    const leadText = lead.map((w) => w.text || '').join('');
    let letters = 0; let digits = 0;
    for (let ci = 0; ci < leadText.length; ci++) {
      const cc = leadText.charCodeAt(ci);
      if ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122)) letters++;
      else if (cc >= 48 && cc <= 57) digits++;
    }
    const bodyFamily = model.pageBodyFamily.get(f.page) || model.bodyFontFamily || '';
    const leadHeadingFace = k >= 2 && model.familyHeading && letters >= 2 && letters >= digits && !f.startsLower
      && lead.every((w) => w.style && w.style.font && w.style.font !== bodyFamily);
    const bodyAfter = k < words.length && !(words[k].style && words[k].style.bold);
    const prevComplete = prev.endsTerminal || f.top - prev.top > model.leading * 1.3;
    if ((leadAllCaps || leadHeadingFace) && bodyAfter && prevComplete) return { newPar: true, reason: 'heading-face run-in lead-in' };
  }

  // A body<->footnote flip must be corroborated by a size change: a footnote is just smaller body text, so a same-size flip is a false boundary.
  // Heading and page-furniture roles are always visually distinct and split on their own.
  // linenum splits unconditionally (margin numbers can interleave with body row-by-row) so body never inherits the 'linenum' type and gets dropped from reflowed exports.
  if (f.role !== prev.role && !(f.role === 'heading' && prev.role === 'heading')) {
    const fr = f.role; const pr = prev.role;
    const headingOrFurniture = fr === 'heading' || fr === 'pagenum' || fr === 'header' || fr === 'footer' || fr === 'linenum'
      || pr === 'heading' || pr === 'pagenum' || pr === 'header' || pr === 'footer' || pr === 'linenum';
    const sizeChange = Math.abs(f.size - prev.size) > model.bodySize * 0.1;
    // Endnotes sit at body size, so sizeChange cannot see the body<->endnote boundary that bounds the section.
    // Endnote-only: a footnote's word-less tail line is demoted to body, so an equivalent footnote term would false-split it.
    const endnoteTransition = (fr === 'endnote') !== (pr === 'endnote');
    if (headingOrFurniture || sizeChange || endnoteTransition) {
      return { newPar: true, reason: `role change (${prev.role}->${f.role})` };
    }
  }

  // Within a heading run, a centered display title varies in size per line by design, so a size-change split would shred it into one paragraph per line.
  // Group its lines by shared center axis instead, and fall back to the size split only for non-centered runs.
  if (f.role === 'heading' && prev.role === 'heading') {
    // The center-axis test below misreads a left-aligned ragged-right heading as a centered title and splits its short last line off, so catch a same-face all-caps run here first.
    // all-caps is required because a mixed-case block quote that familyDistinct mis-tagged role=heading can hold real internal paragraph breaks, whereas an all-caps heading run cannot.
    // The pitch guard keys on line height, not body leading, so a same-face heading a full paragraph gap below (a single-spaced heading inside a double-spaced body) is not fused.
    if (f.familyDistinct && prev.familyDistinct && f.allCaps && prev.allCaps
        && f.fontFamily === prev.fontFamily
        && Math.abs(f.top - prev.top) < Math.max(prev.height, f.height) * 1.8) {
      return { newPar: false, reason: '' };
    }
    const headCols = model.pageColumns && model.pageColumns.get(f.page);
    // A title line is symmetric (li~=ri) whether visibly centered (large equal margins) or a wrapped line filling nearly the full column (tiny equal margins).
    // A flush-left body line is asymmetric (li~=0, ri large).
    // Gate on symmetry, not an inset floor: a floor would reject a full-width wrapped title as "not centered" and split it.
    const insetsOf = (line) => {
      const col = columnFor(line.left, headCols, model.bodySize);
      const lm = col ? col.left : (model.pageFlush.get(line.page) ?? model.bodyLeft);
      const rm = col ? col.right : model.bodyRight;
      return { li: line.left - lm, ri: rm - line.right };
    };
    const symmetric = (ins) => Math.abs(ins.li - ins.ri) < Math.max(model.bodySize * 1.5, Math.min(ins.li, ins.ri) * 0.5);
    // Visibly centered = symmetric and inset well clear of both margins.
    // It is the positive evidence that a symmetric run is a centered display title and not just a stack of full-width headings, which a plain size-change split should still separate.
    // At least one line of the run must clear this bar.
    const clearlyCentered = (ins) => symmetric(ins) && Math.min(ins.li, ins.ri) > model.bodySize;
    const pIns = insetsOf(prev);
    const fIns = insetsOf(f);
    const titleEvidence = clearlyCentered(pIns) || clearlyCentered(fIns);
    // Key on the raw midpoint, not column-relative symmetry, so a phantom column skewing one line's insets cannot split the title.
    const sameCenter = Math.abs((prev.left + prev.right) / 2 - (f.left + f.right) / 2) < model.bodySize * 1.5;
    // A left-aligned multi-line heading's lines share a left edge but not a center axis, so sameCenter fails on them even though clearlyCentered fires.
    // Without sameLeft the block would split them on a spurious alignment change.
    const sameLeft = Math.abs(prev.left - f.left) < model.bodySize * 0.5
      && Math.abs(f.top - prev.top) < Math.max(prev.height, f.height) * 1.8;
    // A hanging-indent heading (a marker-led first line outdented left of its continuation) trips clearlyCentered on its full first line while defeating sameCenter and sameLeft.
    // Without this predicate it splits on a spurious alignment change.
    // Requiring the section marker keeps a same-geometry appendix table cell (no marker) from being fused.
    const sectionMarker = /^\s*(?:[A-Z]|[0-9]{1,2}|[IVXLC]{1,4})[.)]\s/.test(prev.text);
    const hangingHeading = sectionMarker
      && prev.left < f.left - model.bodySize * 0.5
      && Math.abs(f.top - prev.top) < Math.max(prev.height, f.height) * 1.8;
    if (titleEvidence && (sameCenter || sameLeft || hangingHeading)) return { newPar: false, reason: '' };
    // Centered title -> a line on a different center axis (a flush-left body line): the title/body boundary, invisible to size when the body sits at the same enlarged size as the title's last line.
    if (titleEvidence && !sameCenter) return { newPar: true, reason: 'heading alignment change' };
    if (Math.abs(f.size - prev.size) > model.bodySize * 0.1) return { newPar: true, reason: 'heading size change' };
    return { newPar: false, reason: '' };
  }

  // Notes get a dedicated early-return so they bypass the body split rules below, notably the fragile justified "ends early" rule that over-merges full-width note entries and over-splits short ones.
  if (f.role === 'footnote' || f.role === 'endnote') {
    if (f.firstWordSup) return { newPar: true, reason: 'footnote marker' };
    return { newPar: false, reason: '' };
  }

  // A drop cap only ever starts a paragraph, never a continuation line, so splitting unconditionally here is safe and catches a paragraph start the gap/indent rules would miss.
  if (f.dropCap) return { newPar: true, reason: 'drop cap' };

  // Per-line column geometry: downstream margin tests judge each line's flush/indent/right margin against its own column (from detectColumns), not the page-wide edges.
  // Without this the flush and indent columns come from the leftmost column alone.
  // A first-line-indent start in any other column is then invisible, fusing a magazine's columns into one paragraph, and a full left-column line reads as a paragraph end.
  // columnFor returns null on single-column pages, so margins fall back to the page-wide values and behaviour is unchanged.
  const pcols = model.pageColumns && model.pageColumns.get(prev.page);
  const prevCol = columnFor(prev.left, pcols, model.bodySize);
  const fCol = columnFor(f.left, pcols, model.bodySize);
  // Both lines in the same block-quote region: judge margins against the quote's own edges.
  // An interior line then reads as neither first-line-indented nor ending-early against the wider page/column edges.
  // The run's first line has no in-region predecessor, so it still breaks normally.
  const block = prev.blockRegion && prev.blockRegion === f.blockRegion ? prev.blockRegion : null;
  const endRight = block ? block.right : (prevCol ? prevCol.right : model.bodyRight);
  const endWidth = block ? block.width : (prevCol ? prevCol.width : model.colWidth);
  const flush = block ? block.left : (fCol ? fCol.left : (model.pageFlush.get(f.page) ?? model.bodyLeft));

  // In OCR text a centered multi-line title carries no size/bold/colour cue, so classifyRole types it as body and the justified "ends early" rule below over-splits its short first line.
  // Requiring both prev and f centered means it skips the title's first line (whose prev is body), so the block's start break still comes from the gap/role rules.
  // Margins read the line's own frame, most specific first: region, then column, then page (an inset run's lines are flush against their region and never centered, which is correct).
  const centeredLine = (line, col) => {
    const lm = line.blockRegion ? line.blockRegion.left : (col ? col.left : (model.pageFlush.get(line.page) ?? model.bodyLeft));
    const rm = line.blockRegion ? line.blockRegion.right : (col ? col.right : model.bodyRight);
    const li = line.left - lm;
    const ri = rm - line.right;
    const maxIndent = model.indentActive && model.indentDeltas.length ? Math.max(...model.indentDeltas) : 0;
    return li > maxIndent + model.bodySize && ri > model.bodySize * 1.5
      && Math.abs(li - ri) < Math.max(model.bodySize * 1.5, Math.min(li, ri) * 0.6);
  };
  if (prev.page === f.page && f.top - prev.top < model.leading * 1.5
      && centeredLine(prev, prevCol) && centeredLine(f, fCol)) {
    return { newPar: false, reason: 'centered run' };
  }

  // Hanging-indent continuation: a line hanging deeper than the current list item's marker line is a wrap, not the new indented paragraph its indent column would otherwise signal.
  // Gated on prev not ending terminally, or the guard swallows every first-line-indented body paragraph under a numbered section heading ("2. Title." then indented body).
  // Bracket-num markers ("[57]") drop that gate entirely, since bibliography lines break after abbreviation periods and the only entry boundary is the next "[N]".
  // A finite gap regime also drops it when no paragraph-sized gap precedes the line, because there the gap, not the period, marks the next item.
  // Without a gap regime that arm is inert, so a numbered section's indented body keeps the terminal gate.
  const pageGapThresh = (model.pageParaGap && model.pageParaGap.get(f.page)) ?? model.paraGapThresh;
  const noParaGapBefore = prev.page === f.page && pageGapThresh !== Infinity
    && f.top - prev.top < pageGapThresh;
  const hangsDeeper = !!curParFirst && f.left > curParFirst.left + model.bodySize * 0.5;
  // Page-scoped indent regime (model.pageIndentDeltas): a page with its own dominant first-line-indent depth licenses the indent machinery even when the doc-level regime never activated.
  // A sparse double-spaced filing or a lone journal exhibit page is the typical case.
  const pageDeltas = (model.pageIndentDeltas && model.pageIndentDeltas.get(f.page)) || [];
  const indentActiveHere = model.indentActive || pageDeltas.length > 0;
  const indentDeltasHere = pageDeltas.length ? model.indentDeltas.concat(pageDeltas) : model.indentDeltas;
  // Catches a markerless bibliography entry whose continuation line hangs at the indent column below a flush first line, which would otherwise read as a new first-line-indented paragraph.
  // prevInHangingEntry: a hang entry's non-first lines are all indented while a first-line-indent paragraph's continuations are flush, so reading prev stops the rule collapsing an indented column.
  const prevInHangingEntry = prev === curParFirst || prev.left > flush + model.bodySize * 0.5;
  const markerlessHang = hangsDeeper && !curParFirst.enumerator && noParaGapBefore && indentActiveHere
    && prevInHangingEntry
    && Math.abs(curParFirst.left - flush) < model.bodySize * 0.5
    && indentDeltasHere.some((d) => Math.abs(f.left - (flush + d)) < model.bodySize * 0.5);
  // Escape hatch in hangingContinuation: once an enumerated item is already hanging (prev is itself a hang line), it keeps absorbing indent-column lines even past a mid-item sentence end.
  // On a uniform page (pageGapThresh === Infinity) a line cut at that period has no gap rule to re-join it.
  // After a terminal "2. Title." prev is still the flush marker, so prevIsHang stays false and the terminal gate splits the heading from its first-line-indented body.
  const prevIsHang = !!curParFirst && prev !== curParFirst && prev.left > curParFirst.left + model.bodySize * 0.5
    && (noParaGapBefore || pageGapThresh === Infinity);
  // A line at the document's dominant body-prose column, when that column is a hang column right of the flush margin (bodyTextLeft > bodyLeft), is body at the entry's own wrap column.
  const atHangBodyColumn = (line) => model.bodyTextLeft > model.bodyLeft + model.bodySize * 0.5
    && Math.abs(line.left - model.bodyTextLeft) < model.bodySize * 0.5;
  // atHangBodyColumn(f) overrides the terminal-period gate for an enumerated reference whose marker line ends on a non-boundary period (a citation title's period before its journal line).
  // It cannot fuse adjacent entries: a new entry's marker opens at the outdent margin, never the hang column.
  const hangingContinuation = (curParFirst && curParFirst.enumerator && hangsDeeper
    && (!prev.endsTerminal || noParaGapBefore || prevIsHang || atHangBodyColumn(f)
      || curParFirst.enumerator.scheme === 'bracket-num'))
    || markerlessHang;
  // A line at the indent depth following a mid-sentence line is a wrapped continuation coincidentally aligned with the indent column, not a genuine first-line indent.
  const prevEndedPara = prev.role !== 'body' || prev.endsTerminal
    || prev.right < endRight - endWidth * 0.12;
  // Enumerators are excluded because a lowercase list marker ("a)", "c.") would otherwise trip the startsLower guard and merge consecutive lettered items into one.
  const startsContinuation = f.startsLower && !prev.endsTerminal && !f.enumerator;

  // In some legal-database prints a hyperlinked case citation reserves a sliver of extra leading above its line, inflating the pitch to ~1.4x body leading: over the gap threshold, under a real gap.
  // The gap rule then tears a paragraph at every wrapped citation, and the continuation begins with a capital/digit citation fragment no lexical guard rescues.
  // So suppress the break when the continuation carries a link (word.style.link, from the /Link annotation it sits under) and its pitch is citation-pad-sized rather than a full-line paragraph gap.
  const citationLeadContinuation = prev.page === f.page && prev.role === 'body' && f.role === 'body'
    && !!f.line && f.line.words.some((w) => w.style && w.style.link)
    && f.top - prev.top < model.leading * 1.6;

  // Continuation gate (region-scoped): two same-margin lines inside one region, advancing at the region's own pitch, with prev not ending terminally, are one flowing paragraph.
  // This single gate vetoes every weak break rule below (quote start/end, first-line indent, ends-early, gap) instead of each rule re-deriving its own partial version.
  // Sentence-aligned interior boundaries (prev ends '.') are deliberately not covered: those rely on the region frame maths.
  // Body-frame (region-less) lines keep startsContinuation as their lexical veto.
  const tightContinuation = !!block
    && prev.role === 'body' && f.role === 'body'
    && !prev.endsTerminal
    && Math.abs(f.left - prev.left) < model.bodySize * 0.5
    && f.top - prev.top > 0
    && f.top - prev.top <= block.pitch * 1.15
    && f.fontFamily === prev.fontFamily
    && Math.abs(f.size - prev.size) <= model.bodySize * 0.1;

  // Detects the start of a both-side-inset quotation, tagged 'blockquote' downstream by the type pass.
  // classifyRole has no quote role and a double-spaced page blinds the gap rule (pageParaGap = Infinity), so a quote at the body's first-line-indent column would fuse into its lead-in.
  // Inset is judged against the doc body margin, not this page's flush, because on a quote-dense page the most-common left is itself the quote margin.
  // Gated to justified docs because a body line's full right edge is the reliable contrast to the quote's inset right.
  const quoteInset = model.colWidth * 0.035;
  const bothSideInset = (line) => {
    const li = line.left - model.bodyLeft;
    const ri = model.bodyRight - line.right;
    return li > quoteInset && ri > quoteInset && Math.abs(li - ri) < model.colWidth * 0.06;
  };
  // A numbered item's continuation lines sit at the hang body column, but a both-sides quotation nested inside the item is inset beyond it.
  // So a line below that column bypasses the hangingContinuation veto, letting the block-quote start rule fire on a quote embedded in a numbered item.
  const belowHangBodyColumn = (line) => model.bodyTextLeft > model.bodyLeft + model.bodySize * 0.5
    && line.left > model.bodyTextLeft + model.bodySize * 0.5;
  // Region transitions: where the region pass has spoken, quote boundaries are region boundaries.
  // Interior lines (same region both sides) skip this block and reach the frame-corrected rules below.
  // The per-line bothSideInset rules further down stay as the fallback for runs the region pass rejected, and they share these vetoes so a transition vetoed here cannot be resurrected by them.
  // Inside a note paragraph the transitions are off entirely: a statute quoted within a footnote is an inset run of body-role lines, and splitting at its edges would sever the note's own tail.
  // !bareContinuation: a bare-word line end at the same margin is a wrapped sentence whatever the region tags say, else mis-read inset runs shred double-spaced prose line-per-line.
  // A real quote boundary is immune to that veto because its margins differ (entering/leaving an inset), which bareContinuation rejects.
  if ((f.blockRegion || prev.blockRegion) && f.blockRegion !== prev.blockRegion
      && prev.page === f.page && f.role === 'body' && prev.role === 'body'
      && (!curParFirst || (curParFirst.role !== 'footnote' && curParFirst.role !== 'endnote'))
      && !startsContinuation && !tightContinuation && !bareContinuation) {
    if (f.blockRegion && prev.blockRegion) return { newPar: true, reason: 'paragraph gap' };
    if (f.blockRegion && !hangingContinuation && !atHangBodyColumn(f)) return { newPar: true, reason: 'block quote' };
    if (prev.blockRegion && !hangingContinuation && !atHangBodyColumn(prev)) return { newPar: true, reason: 'block quote end' };
  }

  // Vetoes the block-quote start/end rules (!sameMarginNoGap) so a justified left-inset quotation does not shred itself.
  // An interior line justified to full width would otherwise read as resumed body (end) and the next right-ragged line as a fresh quote (start).
  // Pitch is bounded against bodySize, not model.leading: double-spaced leading is the body pitch while a single-spaced quote runs at ~1.15x, so a leading-relative bound would swallow the real gaps.
  const sameMarginNoGap = prev.page === f.page
    && Math.abs(f.left - prev.left) < model.bodySize * 0.5
    && prev.left > (model.pageFlush.get(f.page) ?? model.bodyLeft) + model.bodySize * 0.4
    && f.top - prev.top < model.bodySize * 1.5;
  // !block: an interior pair of one region (an absorbed off-margin opener above the run's flush lines) must never re-split here.
  // The opener's asymmetric insets read as "prev not inset" and would fire a phantom quote start inside the quote the region pass just assembled.
  if (model.justified && !fCol && !prevCol && !block && f.role === 'body' && prev.role === 'body'
      && prev.page === f.page && !startsContinuation && !tightContinuation && !bareContinuation
      && (!hangingContinuation || belowHangBodyColumn(f))
      && bothSideInset(f) && !bothSideInset(prev) && !atHangBodyColumn(f) && f.inInsetRun
      && !sameMarginNoGap) {
    return { newPar: true, reason: 'block quote' };
  }

  // Block-quote end: a quote's justified last line reaches its inset right margin, so "prev ends early" misses it, and a double-spaced page's pageParaGap = Infinity blinds the gap rule.
  // Without this rule the body lead-in that introduces the next quote fuses onto the quote above it.
  // Keyed on f reaching the full body width (not merely "not inset") so a quote's own short, right-ragged internal line never trips it.
  // !hangingContinuation: a hanging item's continuation lines are both-side-inset, so a longer hang line after a shorter one would otherwise read as a quote end and split the item in two.
  if (model.justified && !fCol && !prevCol && !block && f.role === 'body' && prev.role === 'body'
      && prev.page === f.page && !startsContinuation && !tightContinuation && !hangingContinuation
      && !bareContinuation
      && bothSideInset(prev) && prev.inInsetRun && !atHangBodyColumn(prev) && f.right >= model.bodyRight - quoteInset
      && !sameMarginNoGap) {
    return { newPar: true, reason: 'block quote end' };
  }

  // A bullet is a hanging marker, so a non-continuation line left of the item's bullet cannot be its wrap: the list has ended.
  // Restricted to the bullet scheme because a numbered/paren marker may be first-line-indented past its own flush continuations, where a line left of the marker is a legitimate wrap, not a list end.
  if (curParFirst && curParFirst.enumerator && curParFirst.enumerator.scheme === 'bullet'
      && !startsContinuation && f.left < curParFirst.left - model.bodySize * 0.5) {
    return { newPar: true, reason: 'list outdent' };
  }

  // A genuine first-line indent is indented relative to its own paragraph: the continuation below pops back leftward to flush (the same principle the model's indent detector uses).
  // A wrap that merely lands on the indent column is followed by more lines at that column, with no pop-back.
  // Only a terminal prev may still open a paragraph there: prev is then an indented lead-in whose next block shares f's margin ("The court found:" above an inset quote), so f shows no pop-back.
  // Off inside a note paragraph: a rule quoted within a footnote can contain indented sub-items that pop back exactly like body paragraphs, and splitting there severs the note's tail.
  // The note's own machinery (markers, openers) owns intra-note splits.
  if (indentActiveHere && !hangingContinuation && prevEndedPara && !startsContinuation
      && !tightContinuation && !bareContinuation && !refEntryContinuation
      && (!curParFirst || (curParFirst.role !== 'footnote' && curParFirst.role !== 'endnote'))
      && (prev.endsTerminal || !f.belowFeat || f.belowFeat.left < f.left - model.bodySize * 0.4)
      && indentDeltasHere.some((d) => Math.abs(f.left - (flush + d)) < model.bodySize * 0.5)
      && f.left > flush + model.bodySize * 0.4) {
    return { newPar: true, reason: 'first-line indent' };
  }

  // Same-baseline right fragment: a right-aligned field on prev's visual row (e.g. a flush-right date beside an org name) that the line-grouper split off on the wide horizontal gap.
  // It is one logical line, so f continues prev's paragraph.
  // It must run before the justification/gap/column rules below, which assume f is the next row and would misread a same-row fragment as a column shift.
  if (prev.page === f.page && f.left > prev.right
    && Math.abs(f.top - prev.top) < Math.min(f.height, prev.height) * 0.5) {
    return { newPar: false, reason: '' };
  }

  // Splits a smaller-type table note / fine-print block off the body narrative below it.
  // On an indent-delimited page the gap rule is off (pageParaGap=Infinity), so the resuming body line would otherwise read as the note's hanging continuation and fuse.
  // Anchored to model.bodySize, not a bare prev/f ratio, so it fires only on a return to body from below.
  if (prev.page === f.page && f.role === 'body' && prev.role === 'body'
      && prev.endsTerminal
      && prev.size < model.bodySize * 0.9
      && f.size >= model.bodySize * 0.95) {
    return { newPar: true, reason: 'size increase (note->body)' };
  }

  const pj = model.pageJustified.has(f.page) ? model.pageJustified.get(f.page) : model.justified;
  const pageGap = model.pageParaGap && model.pageParaGap.get(f.page);
  const pageJust = (pj === false && pageGap != null && pageGap !== Infinity) ? false : model.justified;
  // "Ends early" is only evidence where the local text is justified: inside a region the region's own right-edge coherence licenses the rule, never the document flag.
  // A ragged quote in a "justified" document must not shed a paragraph at every short line.
  const justHere = block ? block.justifiedLocal : pageJust;
  if (justHere && prev.page === f.page && prev.role === 'body' && f.role === 'body'
      && !hangingContinuation && !tightContinuation && !bareContinuation && !refEntryContinuation
      && prev.right < endRight - endWidth * 0.12
      && !startsContinuation
      && f.firstWordWidth > 0 && f.firstWordWidth < (endRight - prev.right)) {
    return { newPar: true, reason: 'prev ends early (justified)' };
  }

  // Space-delimited paragraph gap, judged against this page's own gap threshold (a uniformly-led page yields Infinity, so a doc-wide spacing estimate borrowed from other pages never over-splits it).
  if (prev.page === f.page) {
    let thresh = (model.pageParaGap && model.pageParaGap.get(f.page)) ?? model.paraGapThresh;
    // A single-spaced page with few genuine paragraph gaps can wrongly collapse to Infinity, so borrow the doc-wide paraGapThresh, but floor it to this page's own pitch.
    // That doc-wide value, dragged down by the document's denser pages, can sit below a double-spaced page's line pitch and would then split every ordinary line.
    // Apply the floor here, not by flooring pageParaGap at its source: its Infinity value gates the indent/block-paragraph fallbacks elsewhere, so flooring it would disable those.
    if (thresh === Infinity && model.paraGapThresh !== Infinity) {
      thresh = Math.max(model.paraGapThresh, (model.pageBodyPitch.get(f.page) || 0) * 1.3);
    }
    // Block-paragraph fallback: where the ratio/count machinery yielded no threshold (Infinity) on a non-indented blank-line-separated document, use the detected blank-line gap.
    // Floor it to this page's own body pitch like the paraGapThresh borrow above: a note-heavy document drags the doc-wide blockParaGap below a body page's pitch, splitting it at every ordinary line.
    if (thresh === Infinity && model.blockParaGap !== Infinity) {
      thresh = Math.max(model.blockParaGap, (model.pageBodyPitch.get(f.page) || 0) * 1.3);
    }
    // !hangingContinuation is not redundant with !startsContinuation here.
    // A marker glyph's tall bbox inflates the top-to-top pitch to a list item's first wrap into a phantom gap.
    // A wrap beginning with a capital (a proper noun or title) escapes the lowercase-only startsContinuation.
    if (thresh !== Infinity && f.top - prev.top > thresh && !startsContinuation && !hangingContinuation
      && !tightContinuation && !bareContinuation && !refEntryContinuation && !citationLeadContinuation) return { newPar: true, reason: 'paragraph gap' };
  }

  if (!sameColumn) return { newPar: true, reason: 'column shift' };
  return { newPar: false, reason: '' };
}

/**
 * True when a dense index/TOC page's structure tags fuse multiple entries into one element, so paragraph segmentation must fall back to geometry there rather than trust the tags.
 * Key on that actual fusion (>=2 entry-enders in one element), not the mere look of a TOC: a TOC that tags each entry as its own element is grouped correctly and geometry cannot recover it.
 * @param {Array<LineFeat>} pf
 */
function tocTagsFuseEntries(pf) {
  let entryLike = 0; let considered = 0;
  /** @type {Map<number, number>} entry-ender count per owning struct element */
  const endersByElement = new Map();
  for (const f of pf) {
    if (f.artifact || f.nChar < 4) continue;
    considered++;
    const t = f.text.trim();
    if (/(?:\.\s*){3,}\d{1,4}$/.test(t) // solid or spaced dot leaders -> page number
      || (/[A-Za-z]/.test(t) && /\bp{1,2}\.\s*\d{1,4}\.?$/.test(t)) // "... p. 684."
      || /\.\s+See\s+(?:also\s+)?[A-Z]/.test(t)) { // "Headword. See Other."
      entryLike++;
      if (f.structId != null) endersByElement.set(f.structId, (endersByElement.get(f.structId) || 0) + 1);
    }
  }
  if (considered < 6 || entryLike / considered < 0.4) return false; // not a dense index/TOC page
  for (const n of endersByElement.values()) if (n >= 2) return true; // an element fuses multiple entries
  return false;
}

// Role classification.
/**
 * @param {LineFeat} f
 * @param {LayoutModel} model
 * @param {number} colWidth
 * @param {LineFeat|null} [prev] - the line immediately above f on the same page, already classified.
 * @returns {'body'|'heading'|'footnote'|'endnote'|'linenum'|'pagenum'|'header'|'footer'}
 */
function classifyRole(f, model, colWidth, prev) {
  // Standalone left-margin line number (case A), flagged by the document-level line-number pass.
  // Checked first: a bare digit line carries no other role.
  if (f.lineNum) return 'linenum';
  // f.folio precedes the edge-proximity folio rules below so a folio set in a tall margin is still caught.
  if (f.folio) return 'pagenum';
  const t = f.text.trim();
  // Folios first: a lone digit/roman margin token is a page number by its form, so these tests precede the furniture rules that would otherwise claim it.
  // The extreme-margin guard keeps an in-body citation fragment ("1229.") that wrapped onto its own line from being typed 'pagenum' and deleted on export.
  // The size guard rejects a short row of small footnote-reference markers ("1 2 3", ~0.4x body) that would likewise be deleted as a page number.
  // A small folio that tracks the page is already caught by f.folio above.
  if (!f.inTable && (f.topFrac < 0.08 || f.bottomFrac > 0.92) && f.sizeRatio >= 0.5
      && /^[\d.\-—–]{1,5}$/.test(t.replace(/\s+/g, '')) && /\d/.test(t)) {
    // A page number cannot exceed the sheet count (plus a few uncounted cover/insert sheets), so a larger lone margin number is content, and typing it 'pagenum' would delete it on export.
    // A genuine folio above the sheet count (an excerpt of a larger document) tracks the page and is already caught by f.folio above.
    const val = parseInt(t.replace(/\D/g, ''), 10);
    if (val <= model.pageCount + 3) return 'pagenum';
  }
  // Roman-numeral folio.
  // Must be a canonical roman numeral, not a loose [ivxlcdm]+, so English words made only of roman-numeral letters ("civil", "mild", "did") do not false-match as a page number.
  if (f.topFrac < 0.08 || f.bottomFrac > 0.92) {
    const romanFolio = t.replace(/[\s\-—–]/g, '');
    if (romanFolio.length > 0 && /^m{0,3}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/i.test(romanFolio)) return 'pagenum';
  }
  // "N of M" page counter (scanned exhibit/form pages), placed before the footnote rule that would otherwise claim it.
  // "of" passes that rule's letters test and the counter is small and low like a note.
  // The whole-line anchor keeps it off genuine footnotes, which open with a marker and prose and so are never a bare "N of M" line.
  if (/^\d{1,3}\s+of\s+\d{1,3}$/.test(t) && (f.topFrac < 0.08 || f.bottomFrac > 0.92)) return 'pagenum';
  const furniture = (f.topFrac + f.bottomFrac) / 2 < 0.5 ? 'header' : 'footer';
  // Some producers tag the whole content stream /Artifact, so trust the tag only in the extreme top/bottom bands, else a fully-tagged page loses its entire body as header/footer on export.
  // Dropped doc-wide when model.artifactUnreliable (producer tags body content /Artifact).
  // Even the band is coarse (a full page's last body line can reach into the bottom 8%), and real furniture outside it is still caught by recurrence (runningFurniture) and the folio rules above.
  if (f.artifact && !model.artifactUnreliable && (f.topFrac < 0.08 || f.bottomFrac > 0.92)) return furniture;
  // Caught before the heading/footnote rules so an all-caps running footer is not read as a section title.
  if (f.runningFurniture) return furniture;
  // Classify a producer-tagged table cell (TD/TH) as body before the footnote rules, which would otherwise type a wide data table's small, low, columnar cells as flush-left footnotes.
  if (f.structRole === 'TD' || f.structRole === 'TH') return 'body';
  // On a word-index (concordance) page every footnote rule below is suppressed: its "headword (count) page:line" entries are not notes.
  // Gated per-page (model.concordancePages), so a mixed doc's transcript and brief pages keep the footnote subsystem.
  // Heading/body classification of the entries is left intact.
  const skipNotes = model.concordancePages.has(f.page);
  // Deliberately no markerless same-page footnote rule keyed on a doc-wide "has footnotes" flag: it would type every small bottom-of-page label, footer, and page counter as a note.
  // Each rule below requires per-instance evidence, so a real footnote whose in-text reference never parsed as a superscript is a deliberate miss.
  // That miss is accepted because mistyping body text as a note is far worse.
  const fnRuleY = skipNotes ? null : (model.footnoteRuleY && model.footnoteRuleY.get(f.page));
  // The bodySize and openerSize arms are not redundant with the page-relative sizeRatio.
  // On table-dominated pages sizeRatio reflects the table's small print, so those arms save real notes.
  const np = model.noteProfile;
  const noteEnvelope = (f.sizeRatio <= 1.08 || f.size <= model.bodySize * 1.08
      || (np.openerSize > 0 && f.size <= np.openerSize * 1.08))
    && (f.bold < 0.9 || np.notesBold);
  // bodyRefLabels excludes a line's own first word, so this isolated marker cannot self-match and vacuously pass the gate.
  if (fnRuleY != null && noteEnvelope && f.top > fnRuleY && f.bottomFrac > 0.5 && f.sizeRatio <= 0.86 && /^\d{1,3}$/.test(t)
      && f.left <= (model.pageFlush.get(f.page) ?? model.bodyLeft) + model.bodySize
      && model.bodyRefLabels.get(f.page)?.has(t)) return 'footnote';
  // The left bound reaches 4x bodySize to admit the note indent but stays left of page centre so a centred folio or footer below the separator is not swept in.
  // The size ceiling is the open note's own size (footnoteContinues stores it), so larger body or display text cannot be swept into a continuation.
  if (model.footnoteContinues && model.footnoteContinues.has(f.page) && fnRuleY != null && noteEnvelope
      && f.top > fnRuleY && !f.allCaps && !f.inTable && /[A-Za-z]{2,}/.test(t)
      && f.size <= (model.footnoteContinues.get(f.page) || 0) * 1.15
      && f.left < (model.pageFlush.get(f.page) ?? model.bodyLeft) + model.bodySize * 4) return 'footnote';
  // The envelope still gates f.endnote, so a bold display heading inside a note-dominated block stays a heading, not an endnote.
  if (!skipNotes && f.endnote && noteEnvelope) return 'endnote';
  // No geometric gate like the sibling footnote rules: f.footnoteBlock already marks the whole block as notes.
  // A gate would wrongly exclude its upper markers and wrapped continuations.
  if (!skipNotes && f.footnoteBlock && noteEnvelope) return 'footnote';
  // Catches body-size footnotes whose only superscript is the leading marker.
  // It never over-matches a stray superscript because the doc-wide sup-ref run it keys on activates only when real in-text references corroborate it.
  // Placed after the endnote rule so a dedicated endnote section keeps its endnote role.
  const supRef = model.schemes['sup-ref'];
  if (!skipNotes && noteEnvelope && supRef && supRef.active && f.bottomFrac > 0.5
      && !CJK_RE.test(t)
      && f.firstWordSup && f.enumerator && f.enumerator.scheme === 'sup-ref'
      && f.enumerator.value != null && supRef.sequenceValues.has(f.enumerator.value)) return 'footnote';
  // The Westlaw "FN"+number note opener ("FN2.") is unambiguous by content, so an active, reference-corroborated sup-ref run plus a value in that run types the note directly.
  // The bare-digit rules' geometric proxies (bottom-of-page, near-flush margin, separator rule, usesBaselineMarker) misfire on full-size notes indented in a two-column layout.
  // "FN"+digit cannot collide with a numbered body paragraph, so none of those proxies are needed.
  if (!skipNotes && noteEnvelope && supRef && supRef.active
      && f.enumerator && f.enumerator.scheme === 'sup-ref' && /^FN\d/.test(f.enumerator.raw || '')
      && f.enumerator.value != null && supRef.sequenceValues.has(f.enumerator.value)) return 'footnote';
  // Body-size footnote: the leading label is body size, not a superscript, so the matching in-text reference is the only evidence it is a note.
  // The left bound widens to 2x bodySize only below the separator (fnRuleY), since allowing it above would let a numbered body paragraph reach the bound and be mistyped.
  if (!skipNotes && noteEnvelope && f.bottomFrac > 0.5 && !f.allCaps && model.bodyRefLabels.has(f.page)
      && f.left <= (model.pageFlush.get(f.page) ?? model.bodyLeft)
        + model.bodySize * (fnRuleY != null && f.top > fnRuleY ? 2 : 1)) {
    const w0t = ((f.line.words[0] && f.line.words[0].text) || '').trim();
    const lead = w0t.replace(/[.)\]/]+$/, '');
    // A symbol marker glued to the note's first word ("*Non-GAAP...") is the same convention set in one text run.
    // The collector admits the matching glued in-text form ("margins*"), so both sides pair up.
    const glued = /^([*†‡∗]{1,3})[A-Za-z0-9(“"'‘]/.exec(w0t);
    if (model.bodyRefLabels.get(f.page)?.has(lead) || (glued && model.bodyRefLabels.get(f.page)?.has(glued[1]))) {
      // A symbol marker cannot collide with the document's own numbered paragraphs, so a reference match alone admits it.
      // A full-size number can, so admitting it is gated on the baseline-marker convention (usesBaselineMarker).
      // Otherwise a numbered body paragraph whose leading number coincides with an in-text reference is mistyped a note.
      if (/^[*†‡∗]{1,3}$/.test(lead) || glued) return 'footnote';
      if (/^\d{1,3}$/.test(lead) && (!model.noteProfile || model.noteProfile.usesBaselineMarker)) return 'footnote';
    }
  }
  // A definition-list item's bold lead term can otherwise promote to a heading and split from its definition.
  if (f.structRole === 'LI') return 'body';
  if (f.inTable) return 'body';
  let letters = 0; let digits = 0;
  for (let ci = 0; ci < t.length; ci++) {
    const cc = t.charCodeAt(ci);
    if ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122)) letters++;
    else if (cc >= 48 && cc <= 57) digits++;
  }
  let letterDom = letters >= 2 && letters >= digits;
  // An all-marker heading ("I.", "b.") is under-lettered, so re-judge on the text after the marker, whose letters-vs-digits test still keeps digit junk ("[2] [3] [4]") out.
  const en = f.enumerator;
  if (!letterDom && en && en.scheme !== 'sup-ref' && en.scheme !== 'bullet' && en.value != null
      && model.schemes[en.scheme] && model.schemes[en.scheme].sequenceValues
      && model.schemes[en.scheme].sequenceValues.has(en.value)) {
    const rest = t.startsWith(en.raw) ? t.slice(en.raw.length) : t;
    let rl = 0; let rd = 0;
    for (let ci = 0; ci < rest.length; ci++) {
      const cc = rest.charCodeAt(ci);
      if ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122)) rl++;
      else if (cc >= 48 && cc <= 57) rd++;
    }
    letterDom = rl >= rd;
  }
  const col = columnFor(f.left, (model.pageColumns && model.pageColumns.get(f.page)) || null, model.bodySize);
  const short = f.width < (col ? col.width : colWidth) * 0.85;
  // A full-width line matching a bold heading tuple promotes only when uniformly bold (>= 0.9).
  // At 0.6-0.9 bold such a line is body prose with a bold defined term the tuple cannot distinguish from a heading.
  const sigMember = model.headingSigs.has(f.sigKey) && letterDom
    && (short || f.bold <= 0.6 || f.bold >= 0.9);
  // A solid-bold line whose style tuple is not a heading signature because the document also opens run-in items in that bold style.
  // Body text is rarely solid-bold under the boldHeading gate, so even a full-width line promotes on weight alone.
  const fullBoldHeading = !sigMember && f.bold >= 0.9 && model.boldHeading && f.nChar <= 200 && letterDom;
  let displaySingleton = false;
  if (!sigMember && f.sizeRatio >= 1.15 && f.nChar <= 200 && letterDom) {
    const lm = col ? col.left : (model.pageFlush.get(f.page) ?? model.bodyLeft);
    const rm = col ? col.right : model.bodyRight;
    const li = f.left - lm;
    const ri = rm - f.right;
    const centered = li > model.bodySize && ri > model.bodySize
      && Math.abs(li - ri) < Math.max(model.bodySize * 1.5, Math.min(li, ri) * 0.6);
    // A line at >= 2.5x body size is display text on size alone: a giant stamp's bbox spans the column and overlaps neighbours, defeating every shape test.
    displaySingleton = short || centered || (f.gapAbove ?? Infinity) > model.leading * 1.2
      || f.sizeRatio >= 2.5;
  }
  // Form-based sub-heading path for a heading face the signature model cannot qualify because the document sets prose in it too.
  // The deep-indent gate separates a real sub-heading from a flush citation connector ("v.", "e. g.") that shows the same alpha-dot enumerator form at the body margin.
  let enumSetOffHeading = false;
  if (!sigMember && en && en.scheme !== 'bullet' && en.scheme !== 'sup-ref' && f.familyDistinct) {
    const flushL = model.pageFlush.get(f.page) ?? model.bodyLeft;
    enumSetOffHeading = f.left > flushL + Math.max(model.indentDelta, 0) + model.bodySize
      && letters >= 2 && letters >= digits;
  }
  if (sigMember || fullBoldHeading || displaySingleton || enumSetOffHeading) {
    // A bold emphasis phrase in prose can wrap so its tail lands majority-bold and false-promotes via the qualified bold tuple.
    // That tail continues the prior body line, so demote it to body.
    const boldOnlyHeading = f.sizeRatio < 1.15 && !f.allCaps && f.bold > 0.6;
    // Key on prev's last word being bold, not prev's overall boldness, since a run only partly bold across prev but bold at the break still continues into f.
    // An enumerator-led line is exempt: an enumerated bold heading legitimately follows a non-terminal bold line, and an emphasis tail never opens with a section marker.
    const prevLastWord = prev && prev.line.words[prev.line.words.length - 1];
    const prevLastWordBold = !!(prevLastWord && prevLastWord.style && prevLastWord.style.bold);
    if (boldOnlyHeading && prev && prev.role === 'body' && !prev.endsTerminal
        && prevLastWordBold
        && !(en && en.scheme !== 'bullet' && en.scheme !== 'sup-ref')) return 'body';
    // A /P-tagged all-caps-only "heading" is an in-prose all-caps designation wrapped onto its own short line, not a section title, and the producer's /P tag is positive evidence it is body.
    // Kept as a false heading it would sit at a real heading's element boundary and trip decideBreak's heading-run merge, absorbing the genuine heading below into this paragraph.
    const allCapsOnlyHeading = f.allCaps && f.sizeRatio < 1.15 && f.bold <= 0.6
      && !f.colorDistinct && !f.familyDistinct;
    if (allCapsOnlyHeading && f.structRole === 'P') return 'body';
    // A corrupt body font (no usable ToUnicode) can extract lowercase prose as uppercase glyphs.
    // An ordinary wrapped body line then reads all-caps and can promote through a caps signature as a false heading.
    // The glyphs are untrustworthy here, so discriminate a real heading from a continuation by geometry, not caps.
    if (allCapsOnlyHeading && prev && prev.role === 'body' && prev.page === f.page) {
      const gapBefore = (model.pageParaGap && model.pageParaGap.get(f.page)) ?? model.paraGapThresh;
      // Finite gap regime: a continuation when no real gap precedes it (it sits within the body pitch).
      if (Number.isFinite(gapBefore) && f.top - prev.top < gapBefore) return 'body';
      // No finite gap here (gapBefore null/Infinity in an indent-delimited or single-spaced doc), so the gap cannot discriminate.
      // Fall back to the running-sentence cue: a prev body line that did not finish its sentence runs its wrapped tail into this all-caps "heading", not a title.
      if (!Number.isFinite(gapBefore) && !prev.endsTerminal) return 'body';
    }
    // A weak all-caps line at the hang column following a non-terminal body line is the wrapped tail of a hanging-indent item whose last line stranded an acronym ("CAFCC.").
    // bodyTextLeft exceeds bodyLeft only in a hanging-list document, so the hang-column gate confines this demotion to those documents.
    const atHangColumn = model.bodyTextLeft > model.bodyLeft + model.bodySize * 0.5
      && Math.abs(f.left - model.bodyTextLeft) < model.bodySize * 0.5;
    if (atHangColumn && f.sizeRatio < 1.15 && !f.colorDistinct && !f.familyDistinct
        && prev && prev.role === 'body' && !prev.endsTerminal) return 'body';
    return 'heading';
  }
  return 'body';
}

// Helpers.

/**
 * Mean and member count of the densest cluster of `values` within `tol`.
 * @param {Array<number>} values
 * @param {number} tol
 */
function dominantCluster(values, tol) {
  if (!values.length) return { center: 0, count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  let best = { center: sorted[0], count: 0 };
  for (let i = 0; i < sorted.length; i++) {
    let j = i; let sum = 0;
    while (j < sorted.length && sorted[j] <= sorted[i] + 2 * tol) { sum += sorted[j]; j++; }
    const count = j - i;
    if (count > best.count) best = { center: sum / count, count };
  }
  return best;
}

/**
 * Threshold above which a top-to-top body-line pitch marks a paragraph break, or Infinity when the lines are not gap-separated (e.g. a uniform double-spaced regime).
 * Infinity makes the caller fall back to first-line indent and other signals.
 * @param {Array<number>} pitches
 * @param {number} fallbackLeading
 */
function gapThreshold(pitches, fallbackLeading) {
  if (pitches.length < 3) return Infinity;
  const lead = quantile(pitches, 0.5) || fallbackLeading;
  const cut = lead * 1.35;
  const big = pitches.filter((x) => x > cut);
  if (big.length < 3 || big.length < pitches.length * 0.08) return Infinity;
  let isolated = 0; // a big pitch followed by a non-big pitch is a real gap, not part of a run
  for (let i = 0; i < pitches.length; i++) {
    if (pitches[i] <= cut) continue;
    if (i + 1 >= pitches.length || pitches[i + 1] <= cut) isolated++;
  }
  if (isolated < big.length * 0.5) return Infinity;
  return (lead + quantile(big, 0.5)) / 2;
}

const LN_LEADER = '·•∙⋅‧․'; // middle dot, bullet, bullet-operator, dot-operator, hyphenation point, one-dot leader
const LN_LEADER_RE = new RegExp(`^[${LN_LEADER}]+$`);
const LN_INT_RE = new RegExp(`^[${LN_LEADER}]*(\\d{1,4})[${LN_LEADER}]*$`);
/**
 * Leading line-number of a line, tolerating leader dots that decorate transcript line numbers.
 * prefixWords counts the leading dots, the integer, and any trailing dots, so words[prefixWords] is the first body word.
 * standalone means the line is just that prefix (case A) versus having body text after it (case B).
 * ASCII '.' is deliberately not a leader char, so a numbered-list marker ("1.") does not match.
 * @param {OcrLine} line
 * @returns {?{value: number, prefixWords: number, standalone: boolean}}
 */
function leadingLineNumber(line) {
  const words = line.words;
  if (!words || !words.length) return null;
  let i = 0;
  while (i < words.length && LN_LEADER_RE.test((words[i].text || '').trim())) i++;
  if (i >= words.length) return null;
  const m = LN_INT_RE.exec((words[i].text || '').trim());
  if (!m) return null;
  let pfx = i + 1;
  while (pfx < words.length && LN_LEADER_RE.test((words[pfx].text || '').trim())) pfx++;
  return { value: Number(m[1]), prefixWords: pfx, standalone: pfx >= words.length };
}

/**
 * Sort values and split into clusters wherever an adjacent gap exceeds tol, returning {center: mean, count} per cluster, ascending by center.
 * @param {Array<number>} values
 * @param {number} tol
 */
function clusterPeaks(values, tol) {
  if (!values.length) return [];
  const sorted = [...values].sort((a, b) => a - b);
  const peaks = [];
  let start = 0;
  for (let i = 1; i <= sorted.length; i++) {
    if (i === sorted.length || sorted[i] - sorted[i - 1] > tol) {
      const slice = sorted.slice(start, i);
      peaks.push({ center: slice.reduce((a, b) => a + b, 0) / slice.length, count: slice.length });
      start = i;
    }
  }
  return peaks;
}

/**
 * The column of `pcols` that x-position `left` falls into, or null when the page has fewer than 2 columns.
 * @param {number} left
 * @param {Array<{left:number,right:number,width:number}>|null|undefined} pcols
 * @param {number} bodySize
 * @returns {?{left:number,right:number,width:number}}
 */
function columnFor(left, pcols, bodySize) {
  if (!pcols || pcols.length < 2) return null;
  let c = pcols[0];
  for (const cc of pcols) if (left >= cc.left - bodySize * 0.5) c = cc;
  return c;
}

/**
 * Detect the column layout of one page from its body lines, or null when the page is single-column.
 * Callers judge "line ends early" against each line's own column right margin, so a left-column line that fills its column is not mistaken for a short paragraph-ending line.
 * @param {Array<LineFeat>} pf - this page's line features
 * @param {LayoutModel} model
 * @returns {?Array<{left:number,right:number,width:number}>}
 */
function detectColumns(pf, model) {
  const bs = model.bodySize || 10;
  // sizeRatio is page-relative, so on a page dominated by small type the real body lines land at ~1.13 and vanish, the column never forms, and its lines are judged against the wrong frame.
  // Lines at the document body size are body wherever they sit, so accept those too.
  const body = pf.filter((f) => f.nChar >= 4 && !f.allCaps && f.orientation === 0
    && ((f.sizeRatio >= 0.92 && f.sizeRatio <= 1.08) || Math.abs(f.size - bs) <= bs * 0.1));
  if (body.length < 8) return null;
  // Column lefts: left-position clusters, merging clusters within ~7 em of the previous cluster as one column's flush/indent/double-indent chain (a real second column opens a column width away).
  // The window covers the deepest accepted first-line indent (a ~5.5-em typewriter tab) so tab openers cannot mint a phantom column at the tab stop.
  // Chaining off the previous peak matters: measured from the accepted flush, a quote margin (+3 em) then its indent (+6 em) mints a phantom column there.
  const peaks = clusterPeaks(body.map((f) => f.left), bs * 0.5)
    .filter((pk) => pk.count >= Math.max(3, body.length * 0.08))
    .sort((a, b) => a.center - b.center);
  const cols = [];
  let prevPeak = null;
  for (const pk of peaks) {
    const chained = prevPeak != null && pk.center - prevPeak < bs * 7;
    prevPeak = pk.center;
    if (chained) continue; // same column (indent chain): keep the flush left
    cols.push({ left: pk.center, rights: [] });
  }
  if (cols.length < 2) return null;
  for (const f of body) {
    let best = cols[0];
    for (const c of cols) if (f.left >= c.left - bs * 0.5) best = c;
    best.rights.push(f.right);
  }
  const out = [];
  for (const c of cols) {
    if (c.rights.length < 3) continue; // an under-populated cluster is noise, not a real column
    const right = quantile(c.rights, 0.9) || model.bodyRight;
    out.push({ left: c.left, right, width: right - c.left });
  }
  return out.length >= 2 ? out : null;
}

/**
 * @param {Array<LineFeat>} feats
 */
function dominantFamily(feats) {
  /** @type {Map<string, number>} */
  const m = new Map();
  for (const f of feats) m.set(f.fontFamily, (m.get(f.fontFamily) || 0) + f.nChar);
  let fam = ''; let best = -1;
  for (const [k, v] of m) if (v > best) { best = v; fam = k; }
  return fam;
}

const ROMAN = {
  i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000,
};
function romanToInt(s) {
  const t = s.toLowerCase();
  let total = 0;
  for (let i = 0; i < t.length; i++) {
    const cur = ROMAN[t[i]]; const next = ROMAN[t[i + 1]];
    if (!cur) return null;
    if (next && cur < next) total -= cur; else total += cur;
  }
  return total || null;
}

/**
 * Classify the leading enumerator of a line, if any.
 * @param {OcrLine} line
 * @returns {?{scheme: string, value: (number|null), raw: string}}
 */
function lineEnumerator(line) {
  const w0 = line.words[0]?.text || '';
  const w1 = line.words[1]?.text || '';
  let m;
  // A bare integer is ambiguous with an inline citation, a folio, or a dotless list item.
  // Unlike the punctuation-anchored schemes below, this branch keys on superscript style to mark it a note reference.
  // Strict `^\d{1,3}$` (no trailing punctuation) routes a superscripted "12." to the num-dot scheme below instead.
  if (line.words[0]?.style?.sup && /^\d{1,3}$/.test(w0)) {
    return { scheme: 'sup-ref', value: parseInt(w0, 10), raw: w0 };
  }
  // The Westlaw "FN"+number footnote convention: the note opener leads with "FN2." / "FN12" at full size on the baseline, with no sup style.
  // Route it to the sup-ref scheme keyed on the number so it anchors to the matching in-text reference and its block types as a footnote.
  if ((m = /^FN(\d{1,3})[.)]?$/.exec(w0))) {
    return { scheme: 'sup-ref', value: parseInt(m[1], 10), raw: w0 };
  }
  // "Sec. 2." / "SEC. 154." / "Section 3" / "Article IV"
  if (/^(Sec\.?|SEC\.?|Section|SECTION|Article|ARTICLE|§)$/.test(w0)) {
    const nm = /^(\d{1,4})/.exec(w1);
    if (nm) return { scheme: 'section', value: parseInt(nm[1], 10), raw: `${w0} ${w1}`.trim() };
    const rm = /^([ivxlcdm]+)[.)]?$/i.exec(w1);
    if (rm) return { scheme: 'section', value: romanToInt(rm[1]), raw: `${w0} ${w1}`.trim() };
    return null;
  }
  // "(a)" "(12)" "(iv)"
  if ((m = /^\((\d{1,3}|[a-z]{1,3}|[ivxlcdm]+)\)$/i.exec(w0))) {
    const inner = m[1];
    if (/^\d+$/.test(inner)) return { scheme: 'paren-num', value: parseInt(inner, 10), raw: w0 };
    if (/^[ivxlcdm]+$/i.test(inner) && inner.length > 1) return { scheme: 'paren-roman', value: romanToInt(inner), raw: w0 };
    if (/^[a-z]$/i.test(inner)) return { scheme: 'paren-alpha', value: inner.toLowerCase().charCodeAt(0) - 96, raw: w0 };
    return { scheme: 'paren-alpha', value: null, raw: w0 };
  }
  // "[12]": bracketed reference/footnote marker (bibliography entries, numbered endnotes), structurally unambiguous as a line-leading marker like the parenthesised forms.
  // It splits only for values with an observed neighbour once the scheme is active (>=2 consecutive values, per detectNumberingSchemes), so a lone "[12]" never splits.
  if ((m = /^\[(\d{1,3})\]$/.exec(w0))) return { scheme: 'bracket-num', value: parseInt(m[1], 10), raw: w0 };
  // "12." "12)" share one scheme: digits pervade inline citations ("...at 309 (2) ..."), so the close-paren form earns no extra trust and both must clear the active+followsComplete guards.
  if ((m = /^(\d{1,3})[.)]$/.exec(w0))) return { scheme: 'num-dot', value: parseInt(m[1], 10), raw: w0 };
  // Paren forms ("iv)", "a)") and dot forms ("iv.", "a.") get separate schemes so detectNumberingSchemes can hold the dot forms non-splittable.
  // A line-leading "a."/"v."/"Id." is usually an initial or abbreviation, not a list marker.
  if ((m = /^([ivxlcdm]{2,})\)$/i.exec(w0))) return { scheme: 'roman-paren', value: romanToInt(m[1]), raw: w0 };
  if ((m = /^([ivxlcdm]{2,})\.$/i.exec(w0))) return { scheme: 'roman-dot', value: romanToInt(m[1]), raw: w0 };
  if ((m = /^([a-z])\)$/i.exec(w0))) return { scheme: 'alpha-paren', value: m[1].toLowerCase().charCodeAt(0) - 96, raw: w0 };
  if ((m = /^([a-z])\.$/i.exec(w0))) return { scheme: 'alpha-dot', value: m[1].toLowerCase().charCodeAt(0) - 96, raw: w0 };
  // Including a bare dash (hyphen/en/em) as a bullet is safe because the bullet scheme activates only at >=3 occurrences (detectNumberingSchemes), so a lone inline dash never splits.
  if (/^[•◦▪▫●○◼◻➢»■□◾◽▶▸‣➤➔–—-]$/.test(w0)) return { scheme: 'bullet', value: null, raw: w0 };
  // A lone symbol or control glyph counts as a bullet: a dingbat-font marker, or a real bullet mangled by a corrupt ToUnicode into an arbitrary non-ASCII codepoint (even a C1 control).
  // Punctuation is excluded because an opening curly quote can line-lead as its own word without being a bullet.
  // The >= 0x80 floor keeps ASCII operators ("<", "+", "=") out, since ASCII bullets are already in the explicit set above.
  if ([...w0].length === 1 && w0.codePointAt(0) >= 0x80 && /[\p{S}\p{C}]/u.test(w0)) {
    return { scheme: 'bullet', value: null, raw: w0 };
  }
  return null;
}

/**
 * For each numbering scheme, decide whether it is "active" (an increasing run of >= 3 exists).
 * @param {Array<LineFeat>} feats
 * @returns {Object<string, {active: boolean, maxRun: number, sequenceValues: Set<number>}>}
 */
function detectNumberingSchemes(feats) {
  /** @type {Object<string, Array<number>>} */
  const seq = {};
  for (const f of feats) {
    if (!f.enumerator || f.enumerator.value == null) continue;
    (seq[f.enumerator.scheme] ||= []).push(f.enumerator.value);
  }
  /** @type {Object<string, {active: boolean, maxRun: number, sequenceValues: Set<number>}>} */
  const out = {};
  for (const [scheme, vals] of Object.entries(seq)) {
    const valueSet = new Set(vals);
    // A value "belongs to a sequence" if its predecessor or successor also occurs.
    // This separates real enumerations (1,2,3 / a,b,c / Sec.1,Sec.2) from stray matches like an initial "S." or an abbreviation "Id." (roman 499) that have no numeric neighbour.
    const sequenceValues = new Set([...valueSet].filter((v) => valueSet.has(v - 1) || valueSet.has(v + 1)));
    let run = 1; let maxRun = 1;
    const asc = [...valueSet].sort((a, b) => a - b);
    for (let i = 1; i < asc.length; i++) {
      if (asc[i] === asc[i - 1] + 1) { run++; maxRun = Math.max(maxRun, run); } else run = 1;
    }
    // Bare-period schemes ("a.", "ii.") stay non-splittable: in prose they are overwhelmingly initials and abbreviations that leak through the sequence guard.
    // Genuine alpha/roman lists mostly use the splittable paren forms instead.
    const splittable = scheme !== 'alpha-dot' && scheme !== 'roman-dot';
    // Strong marker forms activate on a 2-run: two consecutive values is the minimum real enumeration, and the statutory alternatives pair "(a) X; or (b) Y" never grows a third item.
    // Weak forms keep the 3-run bar because a stray "1."/"2." pair is far likelier in prose than a stray line-opening "(a)"/"(b)" pair.
    const strongForm = scheme === 'section' || scheme.startsWith('paren-')
      || scheme === 'alpha-paren' || scheme === 'roman-paren' || scheme === 'bracket-num';
    out[scheme] = { active: splittable && maxRun >= (strongForm ? 2 : 3), maxRun, sequenceValues };
  }
  // Count per distinct glyph, not lumped across all bullet lines, so only the same marker repeating >= 3 times activates the scheme, never a mix of three different stray symbols.
  const bulletGlyphCounts = new Map();
  for (const f of feats) {
    if (f.enumerator && f.enumerator.scheme === 'bullet') {
      bulletGlyphCounts.set(f.enumerator.raw, (bulletGlyphCounts.get(f.enumerator.raw) || 0) + 1);
    }
  }
  const bulletMax = Math.max(0, ...bulletGlyphCounts.values());
  if (bulletMax >= 3) out.bullet = { active: true, maxRun: bulletMax, sequenceValues: new Set() };
  return out;
}

/**
 * Does this line begin a genuine enumerated list item, not a sentence or citation continuation?
 * Only the close-paren marker form ("a)", "ii)") qualifies, since dot forms ("a.") collide with initials and abbreviations.
 * The marker's value must also participate in the document's enumeration, which rejects a stray parenthetical that is not part of a list.
 * @param {LineFeat} f
 * @param {LayoutModel} model
 */
function enumeratedListItemStart(f, model) {
  const e = f.enumerator;
  if (!e || e.value == null || !/\)$/.test(e.raw)) return false;
  const sc = model.schemes[e.scheme];
  return !!(sc && sc.sequenceValues && sc.sequenceValues.has(e.value));
}

/**
 * The document-wide style/layout model built in Phase 2 (and extended through Phase 3 setup), consumed by the role-classification and paragraph-break rules.
 * @typedef {object} LayoutModel
 * @property {number} bodySize
 * @property {string} bodyFontFamily
 * @property {boolean} familyHeading - the body family dominates enough that a distinct family is heading evidence.
 * @property {Map<number, string>} pageBodyFamily
 * @property {number} bodyLeft
 * @property {number} bodyTextLeft - majority body-line column, which in a hanging-indent doc is the wrap column right of bodyLeft.
 * @property {number} bodyRight
 * @property {number} colWidth
 * @property {Map<number, number>} pageFlush - per-page flush body left margin.
 * @property {boolean} indentActive
 * @property {boolean} indentStrong
 * @property {number} indentCol - absolute left of the dominant first-line-indent column (0 when inactive).
 * @property {number} indentDelta - dominant first-line-indent depth relative to a column's flush (0 when inactive).
 * @property {Array<number>} indentDeltas - accepted first-line-indent depths relative to a column's flush.
 * @property {number} leading
 * @property {boolean} justified
 * @property {Map<number, boolean>} pageJustified
 * @property {boolean} boldHeading
 * @property {boolean} colorHeading
 * @property {boolean} spacedActive
 * @property {number} paraGapThresh - doc-wide paragraph-gap threshold, Infinity when no spacing regime was detected.
 * @property {number} blockParaGap - blank-line gap of a block-paragraph doc, Infinity when none was detected.
 * @property {Map<number, number>} pageParaGap - per-page paragraph-gap threshold, may be Infinity.
 * @property {Map<number, number>} pageBodyPitch
 * @property {Map<number, Array<number>>} pageIndentDeltas - first-line-indent depths of pages with their own indent regime.
 * @property {Map<number, number>} pageLeaderCount - per-page count of lines ending in a dot-leader + page number.
 * @property {Object<string, {active: boolean, maxRun: number, sequenceValues: Set<number>}>} schemes
 * @property {number} nLines
 * @property {number} nBodyLines
 * @property {boolean} elementFaithful
 * @property {Map<number, Set<string>>} bodyRefLabels - per-page in-text note-reference labels.
 * @property {Set<string>} bodyRefLabelsDoc
 * @property {Map<number, number>} footnoteContinues - pages opening on a cross-page note continuation -> the open note's size.
 * @property {Map<number, number>} footnoteRuleY - per-page y of the corroborated footnote separator rule.
 * @property {Set<number>} concordancePages - pages detected as word-index (concordance) pages.
 * @property {boolean} artifactUnreliable - the producer tags body content /Artifact, so the tag is useless as a furniture signal.
 * @property {number} pageCount
 * @property {{usesBaselineMarker: boolean, openerSize: number, notesBold: boolean}} noteProfile - size/weight envelope of confirmed note lines.
 * @property {Map<number, ?Array<{left: number, right: number, width: number}>>} pageColumns
 * @property {Set<string>} headingSigs - style tuples qualified to make headings.
 * @property {Map<string, {n: number, short: number, strong: number, weak: number, weakBig: number, enumLed: number, letterDom: number, lowerStart: number, headsBody: number}>} headingSigStats
 * @property {Map<number, Array<{y: number, left: number, right: number}>>} pageRules - drawn horizontal separator rules per page.
 */

/**
 * @typedef {object} LineFeat
 * @property {number} page
 * @property {number} lineIdx
 * @property {OcrLine} line
 * @property {number} left
 * @property {number} right
 * @property {number} width
 * @property {number} top
 * @property {number} bottom
 * @property {number} height
 * @property {number} center
 * @property {number} size
 * @property {number} bold
 * @property {number} italic
 * @property {boolean} artifact
 * @property {string} fontFamily
 * @property {string} color - char-weighted dominant text colour of the line (hex).
 * @property {boolean} colorDistinct - colour differs from the page body colour in a monochrome doc.
 * @property {boolean} familyDistinct - font family differs from the page body family in a family-dominated doc.
 * @property {string} sigKey - style-tuple key (size|flags|family|color) for the heading-signature model, filled in Phase 3.
 * @property {number} [gapAbove] - gap to the nearest horizontally-overlapping line above (Infinity when none in window).
 * @property {?LineFeat} [belowFeat] - nearest horizontally-overlapping line below within the window.
 * @property {string} text
 * @property {number} nChar
 * @property {boolean} allCaps
 * @property {boolean} endsTerminal
 * @property {boolean} endsLetter - line text ends with a letter or digit.
 * @property {boolean} endsHyphen - line text ends with a hyphen or solidus.
 * @property {boolean} startsLower
 * @property {number} firstWordWidth - bbox width of the line's first word.
 * @property {boolean} firstWordSup
 * @property {boolean} dropCap - the line opens on an oversized 1-2 char capital (a drop cap).
 * @property {?{scheme: string, value: (number|null), raw: string}} enumerator
 * @property {number} orientation
 * @property {number} topFrac
 * @property {number} bottomFrac
 * @property {boolean} inTable - center point lies inside a detected data-table region (page.tableBoxes).
 * @property {?number} structId - owning structure-element object number (tagged PDFs), else null.
 * @property {?string} structRole - that element's tag (e.g. 'P','H2','LI'), else null.
 * @property {string} role
 * @property {number} sizeRatio
 * @property {{left:number,right:number,width:number,pitch:number,justifiedLocal:boolean}} [blockRegion]
 * @property {string} [marginKey] - normalized text+zone key for cross-page running-furniture detection.
 * @property {boolean} [runningFurniture] - text recurs at the same margin across many pages (a running head/footer).
 * @property {boolean} [endnote] - line belongs to a detected endnote section (a note-dominated page of bare superscript-numbered entries).
 * @property {boolean} [footnoteBlock] - line belongs to the note block of an isolated note-dominated page (not part of an endnote-section run).
 * @property {boolean} listConfirmed - line is a confirmed member of a local list region (a contiguous, consecutively valued, column-aligned run of >=3 markers).
 * @property {boolean} lineNum - line is a standalone left-margin line number.
 * @property {boolean} folio - a lone number whose value tracks the page across a contiguous run of pages.
 * @property {boolean} hangMarker - short outdented lead (a transcript "Q."/"A." speaker marker or hanging-list lead) with its body text on the same row.
 * @property {boolean} [rowFragment] - small same-row marker token (a note reference beside a taller line) routed out of the top-to-bottom flow.
 * @property {boolean} [inInsetRun] - line sits in a run of >=2 consecutive lines sharing one left edge.
 * @property {boolean} [footnoteOpener] - bare-integer note opener confirmed by the page's note-number chain.
 * @property {boolean} [lnSplit] - a leading line number was split off this line, shifting its left bbox right.
 */
