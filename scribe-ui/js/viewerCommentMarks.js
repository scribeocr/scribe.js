// On-page comment marks: the bubble beside a commented highlight (`.scribe-hl-cmark`) and the mark of a freestanding note (`.scribe-note-icon`).
// Imports no viewer module, so the viewer, the notes layer and the comment tools can each import it without a cycle.

/** The curved pointer that joins a mark to its anchor. */
export const BUBBLE_TIP_SVG = '<svg class="scribe-bub-tip" viewBox="0 0 7 12" aria-hidden="true">'
  + '<path class="scribe-bub-tip-fill" d="M1.0 1.75 L3.82 1.75 C3.82 3.48 4.76 4.76 5.95 5.48 Q6.45 6.00 5.95 6.52 C4.76 7.24 3.82 8.52 3.82 10.25 L1.0 10.25 Z"/>'
  + '<path class="scribe-bub-tip-stroke" d="M3.35 1.65 C3.35 3.45 4.68 4.75 5.95 5.48 Q6.45 6.00 5.95 6.52 C4.68 7.25 3.35 8.55 3.35 10.35"/>'
  + '</svg>';

const BUBBLE_LINES_HL_SVG = '<svg viewBox="0 0 12 9" fill="none" aria-hidden="true">'
  + '<path d="M1 2.25H11M1 6.75H7.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

const BUBBLE_LINES_NOTE_SVG = '<svg viewBox="0 0 10 9.5" fill="none" aria-hidden="true">'
  + '<path d="M1 1.5H9M1 4.75H9M1 8H6.4" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>';

/** The pointer under a note mark's spine, drawn from the box's bottom border (y = 0, with the box above) down to its tip. */
export const BUBBLE_NOTE_TAIL_SVG = '<svg class="scribe-note-tail" viewBox="-6 -1.5 12 8" aria-hidden="true">'
  + '<path class="scribe-bub-tip-fill" d="M-4.3 -0.5H4.3V0C2.45 0 1.22 2.85 0.5 4.5Q0 5.3 -0.5 4.5C-1.22 2.85 -2.45 0 -4.3 0Z"/>'
  + '<path class="scribe-bub-tip-stroke" d="M4.3 0C2.45 0 1.22 2.85 0.5 4.5Q0 5.3 -0.5 4.5C-1.22 2.85 -2.45 0 -4.3 0"/>'
  + '</svg>';

/** @type {?HTMLDivElement} */
let previewProbeEl = null;
/**
 * Preview fits by text width and comment.
 * Every re-placement, on a zoom step or a horizontal scroll, asks again for every mark, and measuring forces a layout.
 * @type {Map<string, {prefix: string, hasEllipsis: boolean, prefixPx: number}>}
 */
const previewFitCache = new Map();

const TAIL_CLASSES = ['is-left', 'is-right', 'is-down-left', 'is-down-right'];

const BUBBLE_MAX_LINES = 1.5;

const BUBBLE_MAX_NARROW = 0.15;

/**
 * Build a mark's inner DOM on first use, then set its pointer side, its color bar, and the text and width of its one-line hover preview.
 * @param {HTMLElement} markEl - A `.scribe-hl-cmark` (highlight bubble) or a `.scribe-note-icon` (note mark).
 * @param {object} opts
 * @param {boolean} opts.isNote
 * @param {string} [opts.color] - The highlight's color, shown as the bubble's bar.
 * @param {string} opts.tailClass - The side the pointer leaves from, one of `TAIL_CLASSES`.
 * @param {string} opts.comment
 * @param {number} opts.maxCardW - Screen px the preview may take.
 */
export function populateBubbleMark(markEl, {
  isNote, color = '', tailClass, comment, maxCardW,
}) {
  if (markEl.dataset.bubInit !== '1') {
    markEl.dataset.bubInit = '1';
    const shell = document.createElement('span');
    shell.className = 'scribe-bub-shell';
    shell.innerHTML = `<span class="scribe-bub-box"></span>${isNote ? BUBBLE_NOTE_TAIL_SVG : BUBBLE_TIP_SVG}`;
    const body = document.createElement('span');
    body.className = 'scribe-bub-body';
    const lines = document.createElement('span');
    lines.className = 'scribe-bub-lines';
    lines.innerHTML = isNote ? BUBBLE_LINES_NOTE_SVG : BUBBLE_LINES_HL_SVG;
    body.appendChild(lines);
    if (isNote) {
      markEl.replaceChildren(shell, body);
    } else {
      const bar = document.createElement('span');
      bar.className = 'scribe-cm-bar';
      markEl.replaceChildren(shell, bar, body);
    }
  }
  for (const tc of TAIL_CLASSES) markEl.classList.toggle(tc, tc === tailClass);
  if (!isNote) {
    const bar = /** @type {?HTMLElement} */ (markEl.querySelector('.scribe-cm-bar'));
    if (bar && color) bar.style.background = color;
  }

  // The preview is measured here, so the mark unrolls to a width known in advance.
  const cappedCardW = Math.max(88, Math.min(228, maxCardW));
  const padDeduction = isNote ? 40 : 26;
  const maxTextPx = Math.max(48, cappedCardW - padDeduction);
  const raw = comment.trim();
  const fitKey = `${maxTextPx}::${raw}`;
  let fit = previewFitCache.get(fitKey);
  if (!fit) {
    const paragraphs = raw.split('\n');
    const line0 = paragraphs[0].trim();
    if (!line0) {
      fit = { prefix: '', hasEllipsis: false, prefixPx: 0 };
    } else {
      if (!previewProbeEl || !previewProbeEl.isConnected) {
        previewProbeEl = document.createElement('div');
        // The font matches `.scribe-strip-text`, so a fit measured here holds in the preview.
        previewProbeEl.style.cssText = 'position:fixed;left:-9999px;top:0;visibility:hidden;pointer-events:none;margin:0;padding:0;border:0;box-sizing:border-box;'
          + 'font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:12.5px;line-height:18px;white-space:pre-wrap;overflow-wrap:break-word;';
        document.body.appendChild(previewProbeEl);
      }
      const span = document.createElement('span');
      previewProbeEl.style.width = `${maxTextPx}px`;
      span.textContent = line0;
      previewProbeEl.replaceChildren(span);
      if (paragraphs.length === 1 && previewProbeEl.offsetHeight <= 20) {
        fit = { prefix: line0, hasEllipsis: false, prefixPx: span.getBoundingClientRect().width };
      } else {
        // Take whole words while they stay on one line, then give the last one back if the ellipsis would not fit after it.
        const words = line0.split(/\s+/);
        let fitWords = words[0];
        for (let i = 1; i < words.length; i++) {
          const cand = `${fitWords} ${words[i]}`;
          span.textContent = cand;
          if (previewProbeEl.offsetHeight <= 20) fitWords = cand;
          else break;
        }
        span.textContent = fitWords;
        let prefixPx = span.getBoundingClientRect().width;
        if (prefixPx + 9 > maxTextPx && fitWords.includes(' ')) {
          fitWords = fitWords.slice(0, fitWords.lastIndexOf(' '));
          span.textContent = fitWords;
          prefixPx = span.getBoundingClientRect().width;
        }
        fit = { prefix: fitWords, hasEllipsis: true, prefixPx };
      }
    }
    previewFitCache.set(fitKey, fit);
  }

  const unrollW = fit.hasEllipsis
    ? cappedCardW
    : Math.max(88, Math.min(cappedCardW, Math.ceil(fit.prefixPx + padDeduction + 1)));
  const previewTextW = Math.max(48, unrollW - (isNote ? 40 : 25));
  markEl.style.setProperty('--scribe-unroll-w', `${unrollW}px`);
  markEl.style.setProperty('--scribe-preview-w', `${previewTextW}px`);
  markEl.dataset.hasEllipsis = fit.hasEllipsis ? '1' : '0';
  markEl.dataset.prefixPx = String(fit.prefixPx);
  markEl.dataset.previewText = fit.prefix;
  markEl.dataset.noPreview = maxCardW < 88 ? '1' : '0';
  // Update the live `.scribe-bub-strip` if one is currently mounted on the mark.
  const pTxt = /** @type {?HTMLElement} */ (markEl.querySelector('.scribe-prev-txt'));
  const pEll = /** @type {?HTMLElement} */ (markEl.querySelector('.scribe-prev-ell'));
  if (pTxt) pTxt.textContent = fit.prefix;
  if (pEll) pEll.hidden = !fit.hasEllipsis;
}

/**
 * Remove any active hover preview strip from a mark immediately.
 * @param {HTMLElement} markEl
 */
export function dropPreviewStrip(markEl) {
  const strip = markEl.querySelector('.scribe-bub-strip');
  if (strip) {
    for (const anim of strip.getAnimations({ subtree: true })) anim.cancel();
    strip.remove();
  }
  markEl.classList.remove('has-strip');
}

/** @type {WeakMap<object, {key: string, linesDisp: Array<{left: number, right: number, top: number, bottom: number}>, medianLineH: number, linePitch: number}>} */
const pageLineMetricsCache = new WeakMap();

/**
 * The boxes of page `n`'s text lines in displayed-page coordinates, the median line height, and the median within-column line pitch.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 * @param {dims} disp - The page's displayed dimensions.
 */
function getPageLineMetrics(viewer, n, disp) {
  const ocrPage = viewer.doc.pageStore.readOnlyPage(n);
  if (!ocrPage || ocrPage.lines.length === 0) {
    const assumedH = Math.max(12, Math.min(48, disp.height * 0.012));
    return { linesDisp: [], medianLineH: assumedH, linePitch: assumedH * 1.25 };
  }
  const pLeft0 = viewer._pageLeft(n);
  const pTop0 = viewer.getPageStop(n);
  // The boxes and the median are independent of zoom, so they are cached until the page's lines or its position in the document change.
  const cacheKey = `${disp.width}x${disp.height}@${pLeft0},${pTop0}:${ocrPage.lines.length}`;
  const hit = pageLineMetricsCache.get(ocrPage);
  if (hit && hit.key === cacheKey) return hit;

  /** @type {Array<{left: number, right: number, top: number, bottom: number}>} */
  const linesDisp = [];
  /** @type {number[]} */
  const heights = [];
  for (const ln of ocrPage.lines) {
    if (ln.words.length === 0) continue;
    const a = viewer.localToContent(n, ln.orientation, ln.bbox.left, ln.bbox.top);
    const b = viewer.localToContent(n, ln.orientation, ln.bbox.right, ln.bbox.bottom);
    const top = Math.min(a.y, b.y) - pTop0;
    const bottom = Math.max(a.y, b.y) - pTop0;
    linesDisp.push({
      left: Math.min(a.x, b.x) - pLeft0,
      right: Math.max(a.x, b.x) - pLeft0,
      top,
      bottom,
    });
    if (bottom > top) heights.push(bottom - top);
  }
  heights.sort((x, y) => x - y);
  const rawMed = heights.length > 0 ? heights[heights.length >> 1] : disp.height * 0.012;
  const medianLineH = Math.max(10, Math.min(disp.height * 0.06, rawMed));
  const byTop = [...linesDisp].sort((a, b) => a.top - b.top);
  /** @type {number[]} */
  const steps = [];
  for (let i = 0; i < byTop.length; i++) {
    const a = byTop[i];
    for (let j = i + 1; j < byTop.length && byTop[j].top - a.top <= rawMed * 3.2; j++) {
      const b = byTop[j];
      if (b.top - a.top < rawMed * 0.6) continue;
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > Math.min(a.right - a.left, b.right - b.left) * 0.5) {
        steps.push(b.top - a.top);
        break;
      }
    }
  }
  steps.sort((x, y) => x - y);
  const linePitch = Math.max(medianLineH, steps.length > 0 ? steps[steps.length >> 1] : medianLineH * 1.25);
  const entry = {
    key: cacheKey, linesDisp, medianLineH, linePitch,
  };
  pageLineMetricsCache.set(ocrPage, entry);
  return entry;
}

/**
 * Compute the zoom factors and height cap for sizing page `n`'s comment marks.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 * @returns {{z: number, effZ: number, maxH: number}} Live zoom `z`, effective mark zoom `effZ` that floors mark height in page units at `maxH`, and `maxH` in displayed-page coordinates.
 */
export function computePageBubbleZoom(viewer, n) {
  const disp = viewer.getDisplayDims(n);
  const z = viewer.zoomLevel;
  const shortSpan = Math.max(200, Math.min(disp.width, disp.height));
  const { linePitch } = getPageLineMetrics(viewer, n, disp);
  const capH = linePitch * BUBBLE_MAX_LINES;
  return { z, effZ: Math.max(z, 612 / shortSpan, 22 / capH), maxH: Math.min(22 * shortSpan / 612, capH) };
}

/**
 * Where the bubble of one commented highlight rests on page `n`, in displayed-page coordinates.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 * @param {Array<{left: number, right: number, top: number, bottom: number}>} runBoxes - The highlight's bands, one per line, in displayed-page coordinates.
 * @param {?Array<{left: number, top: number, right: number, bottom: number, side: string, rowMid: number}>} [placedHomes] - Bubbles placed so far, which this one avoids and then joins.
 */
export function computeHighlightMarginHome(viewer, n, runBoxes, placedHomes = null) {
  const disp = viewer.getDisplayDims(n);
  const { z, effZ, maxH } = computePageBubbleZoom(viewer, n);
  let wPage = 30 / effZ;
  const hPage = 22 / effZ;
  // Anchor on the last line so a card that falls back below the highlight opens next to its bubble.
  const lastRun = runBoxes.reduce((a, r) => (r.bottom > a.bottom ? r : a));
  const minRunL = Math.min(...runBoxes.map((r) => r.left));
  const maxRunR = Math.max(...runBoxes.map((r) => r.right));
  const minRunT = Math.min(...runBoxes.map((r) => r.top));
  const maxRunB = Math.max(...runBoxes.map((r) => r.bottom));
  const midY = (lastRun.top + lastRun.bottom) * 0.5;

  const { linesDisp, medianLineH } = getPageLineMetrics(viewer, n, disp);
  let colLeft = minRunL;
  let colRight = maxRunR;
  let leftClearLeft = minRunL;
  let rightClearRight = maxRunR;
  let leftObstructionRight = 0;
  let rightObstructionLeft = disp.width;
  let leftNear = 0;
  let rightNear = disp.width;

  if (linesDisp.length > 0) {
    const bandPad = medianLineH * 0.45;
    const nearYPad = medianLineH * 1.15;
    // Pad by `maxH` so the row scan covers every line the bubble ever reaches and stays fixed across zoom levels.
    const rowYPad = Math.max(medianLineH * 0.85, (maxH - (lastRun.bottom - lastRun.top)) * 0.5 + medianLineH * 0.2);
    const minGap = medianLineH * 0.30;
    const directLines = linesDisp.filter((c) => c.bottom >= minRunT - medianLineH * 0.2 && c.top <= maxRunB + medianLineH * 0.2
      && Math.min(c.right, maxRunR + medianLineH * 0.2) > Math.max(c.left, minRunL - medianLineH * 0.2));
    const refLineW = directLines.length > 0
      ? Math.max(...directLines.map((c) => c.right - c.left))
      : (maxRunR - minRunL);
    const maxColSpanW = Math.max(disp.width * 0.54, refLineW * 1.45);
    const colSample = linesDisp.filter((c) => c.bottom >= minRunT - nearYPad && c.top <= maxRunB + nearYPad
      && (c.right - c.left) <= maxColSpanW
      && Math.min(c.right, maxRunR + bandPad) > Math.max(c.left, minRunL - bandPad));
    if (colSample.length > 0) {
      colLeft = Math.min(minRunL, ...colSample.map((c) => c.left));
      colRight = Math.max(maxRunR, ...colSample.map((c) => c.right));
    } else if (directLines.length > 0) {
      colLeft = Math.min(minRunL, ...directLines.map((c) => c.left));
      colRight = Math.max(maxRunR, ...directLines.map((c) => c.right));
    }
    leftClearLeft = colLeft;
    rightClearRight = colRight;
    for (const c of linesDisp) {
      if (c.bottom < lastRun.top - rowYPad || c.top > lastRun.bottom + rowYPad) continue;
      // Short text well inside the page, such as a list marker, shifts the clear edge out without counting as a margin obstruction.
      if (c.right <= colLeft - minGap) {
        leftClearLeft = Math.min(leftClearLeft, c.left);
        leftNear = Math.max(leftNear, c.right);
        if ((c.right - c.left) > medianLineH * 2.4 || c.left < disp.width * 0.08) leftObstructionRight = Math.max(leftObstructionRight, c.right);
      }
      if (c.left >= colRight + minGap) {
        rightClearRight = Math.max(rightClearRight, c.right);
        rightNear = Math.min(rightNear, c.left);
        if ((c.right - c.left) > medianLineH * 2.4 || c.right > disp.width * 0.92) rightObstructionLeft = Math.min(rightObstructionLeft, c.left);
      }
    }
  }

  // 1. The side the highlight belongs to, from page geometry alone, so it never flips with zoom or scroll.
  const pageLeftOpen = leftObstructionRight === 0 && leftClearLeft >= disp.width * 0.04;
  const pageRightOpen = rightObstructionLeft >= disp.width - 1 && disp.width - rightClearRight >= disp.width * 0.04;
  const homeLeft = pageLeftOpen || !pageRightOpen;
  // Test the inter-column gap at `maxH` so side selection stays fixed across zoom, requiring 4px clearance to this column and 2px to the neighbor at full scale.
  const across = (homeLeft ? minRunL - colLeft : colRight - maxRunR) / Math.max(1, colRight - colLeft);
  const gapW = homeLeft ? rightNear - colRight : colLeft - leftNear;
  const otherIsGap = homeLeft ? rightNear < disp.width : leftNear > 0;
  const intrinsicLeft = across >= 0.5 && (!otherIsGap || gapW >= maxH * (30 * (1 - BUBBLE_MAX_NARROW) + 6) / 22) ? !homeLeft : homeLeft;

  // 2. A highlight in the middle of its column takes the other margin when a bubble already rests in its own, beside the same line or the next.
  let wantLeft = intrinsicLeft;
  if (placedHomes && placedHomes.length > 0 && pageLeftOpen && pageRightOpen) {
    const colSpan = Math.max(1, colRight - colLeft);
    const leftBusy = placedHomes.some((pr) => pr.side === 'left' && Math.abs(pr.rowMid - midY) < medianLineH * 1.5);
    const rightBusy = placedHomes.some((pr) => pr.side === 'right' && Math.abs(pr.rowMid - midY) < medianLineH * 1.5);
    if (wantLeft && leftBusy && !rightBusy && maxRunR > colLeft + colSpan * 0.42) {
      wantLeft = false;
    } else if (!wantLeft && rightBusy && !leftBusy && minRunL < colRight - colSpan * 0.42) {
      wantLeft = true;
    }
  }

  // 3. Position the bubble, keeping at least 4px to its own column in an inter-column gap so the protruding pointer tip clears the text.
  let restTopPage = Math.max(4 / effZ, Math.min(disp.height - hPage - 4 / effZ, midY - hPage * 0.5));
  let inGap = wantLeft !== homeLeft && otherIsGap;
  if (inGap) wPage = Math.max(30 * (1 - BUBBLE_MAX_NARROW) / effZ, Math.min(wPage, gapW - 8 / effZ));
  const gapClear = Math.min(10 / effZ, Math.max(4 / effZ, (gapW - wPage) / 2));
  const gapLeftPage = wantLeft ? colLeft - gapClear - wPage : colRight + gapClear;
  if (inGap && placedHomes && placedHomes.some((pr) => (pr.side !== (wantLeft ? 'left' : 'right') || Math.abs(pr.rowMid - midY) < medianLineH * 0.3)
    && Math.abs(gapLeftPage - pr.left) < 28 / effZ
    && restTopPage < pr.bottom + 3 / effZ && restTopPage + hPage > pr.top - 3 / effZ)) {
    inGap = false;
    wantLeft = homeLeft;
    wPage = 30 / effZ;
  }
  let restLeftPage = wantLeft ? leftClearLeft - 10 / effZ - wPage : rightClearRight + 10 / effZ;
  if (inGap) restLeftPage = gapLeftPage;

  // 4. Step down past same-line collisions only so bubbles on adjacent lines overlap and stay aligned with their own lines.
  if (placedHomes) {
    for (let pass = 0; pass < placedHomes.length; pass++) {
      let bumped = false;
      for (const pr of placedHomes) {
        if (Math.abs(pr.rowMid - midY) < medianLineH * 0.3
          && Math.abs(restLeftPage - pr.left) < 28 / effZ
          && restTopPage < pr.bottom + 3 / effZ
          && restTopPage + hPage > pr.top - 3 / effZ) {
          restTopPage = Math.max(4 / effZ, Math.min(disp.height - hPage - 4 / effZ, pr.bottom + 3 / effZ));
          bumped = true;
        }
      }
      if (!bumped) break;
    }
    placedHomes.push({
      left: restLeftPage, top: restTopPage, right: restLeftPage + wPage, bottom: restTopPage + hPage, side: wantLeft ? 'left' : 'right', rowMid: midY,
    });
  }

  // 5. The room that margin has on screen, for a preview or an open card.
  const inner = wantLeft ? restLeftPage + wPage : restLeftPage;
  let roomPx = (wantLeft ? inner : disp.width - inner) * z - 4;
  const pc = viewer.pageContainerArr?.[n];
  const sc = viewer.scrollContainer;
  if (pc && sc && pc.isConnected && sc.isConnected) {
    const pcRect = pc.getBoundingClientRect();
    const scRect = sc.getBoundingClientRect();
    if (pcRect.width > 0 && scRect.width > 0) {
      const row = viewer.rowOfPage(n);
      const beside = wantLeft ? n - 1 : n + 1;
      const facing = row !== null && beside >= 0 && beside < viewer.doc.pageMetrics.length && viewer.rowOfPage(beside) === row;
      if (wantLeft) roomPx = (pcRect.left + inner * z) - (facing ? Math.max(scRect.left, pcRect.left) : scRect.left) - 6;
      else roomPx = (facing ? Math.min(scRect.right, pcRect.right) : scRect.right) - 6 - (pcRect.left + inner * z);
    }
  }
  const clearPx = inGap ? Math.min(roomPx, (wantLeft ? inner - leftNear : rightNear - inner) * z - 4) : roomPx;

  return {
    restLeftPage,
    restTopPage,
    restRightPage: restLeftPage + wPage,
    restW: wPage * z,
    restH: hPage * z,
    tailClass: wantLeft ? 'is-left' : 'is-right',
    lockRight: wantLeft,
    roomPx: Math.floor(roomPx),
    clearPx: Math.floor(clearPx),
    textGapPx: (inGap ? gapClear : 10 / effZ) * z,
  };
}

/**
 * Where every commented highlight's bubble rests on page `n`, keyed `<slot>:<groupId>`.
 * Bubbles are placed in reading order, each avoiding the ones before it.
 * @param {import('../viewer.js').ScribeViewer} viewer
 * @param {number} n
 * @param {?{groupId: string, slot: ('highlight'|'line'), runs: Array<{left: number, right: number, top: number, bottom: number}>}} [extraCandidate] - A highlight with no bubble yet, placed as well.
 */
export function computePageHighlightHomes(viewer, n, extraCandidate = null) {
  const { medianLineH } = getPageLineMetrics(viewer, n, viewer.getDisplayDims(n));
  const pageAnnots = viewer.doc.annotations.pages[n] || [];
  const annotOrderOf = (groupId, slot) => {
    const idx = pageAnnots.findIndex((a) => (slot === 'line'
      ? (a.type === 'underline' || a.type === 'strikeout')
      : (!a.type || a.type === 'highlight')) && a.groupId === groupId);
    return idx >= 0 ? idx : 1e9;
  };

  /** @type {Array<{key: string, runs: Array<{left: number, right: number, top: number, bottom: number}>, annotOrder: number}>} */
  const items = [];
  const seen = new Set();
  for (const m of (viewer._commentMarks[n] || [])) {
    const key = `${m.slot}:${m.groupId}`;
    seen.add(key);
    items.push({
      key,
      runs: m.runs,
      annotOrder: annotOrderOf(m.groupId, m.slot),
    });
  }
  if (extraCandidate && !seen.has(`${extraCandidate.slot}:${extraCandidate.groupId}`)) {
    items.push({
      key: `${extraCandidate.slot}:${extraCandidate.groupId}`,
      runs: extraCandidate.runs,
      annotOrder: annotOrderOf(extraCandidate.groupId, extraCandidate.slot),
    });
  }

  // Sort by each highlight's last line, where its bubble rests, so collision checks run top-to-bottom.
  items.sort((a, b) => {
    const lastA = a.runs.reduce((p, r) => (r.bottom > p.bottom ? r : p));
    const lastB = b.runs.reduce((p, r) => (r.bottom > p.bottom ? r : p));
    const midYa = (lastA.top + lastA.bottom) * 0.5;
    const midYb = (lastB.top + lastB.bottom) * 0.5;
    if (Math.abs(midYa - midYb) > medianLineH * 0.55) return midYa - midYb;
    if (a.annotOrder !== b.annotOrder) return a.annotOrder - b.annotOrder;
    return lastA.left - lastB.left;
  });

  /** @type {Array<{left: number, top: number, right: number, bottom: number, side: string, rowMid: number}>} */
  const placedHomes = [];
  /** @type {Map<string, ReturnType<typeof computeHighlightMarginHome>>} */
  const byKey = new Map();
  for (const it of items) {
    byKey.set(it.key, computeHighlightMarginHome(viewer, n, it.runs, placedHomes));
  }
  return byKey;
}
