/**
 * The Edit Text mode's live line editor.
 * A per-line canvas overlay draws the line being edited while the page raster re-renders with that line suppressed.
 */
import ocr from '../../js/objects/ocrObjects.js';
import { resolveReplacementChar } from '../../js/pdf/glyphResolve.js';
import { wordBandRect, nativeTextForPage } from '../../js/textEdits.js';

/** @typedef {import('../../js/objects/ocrObjects.js').OcrLine} OcrLine */

/**
 * @param {any} scribe - The viewer instance.
 * @param {{onCommitted?: (pages: Array<number>) => void}} [hooks]
 */
export function createLineEditor(scribe, { onCommitted } = {}) {
  /** @type {?object} */
  let st = null;

  const canvas = document.createElement('canvas');
  canvas.className = 'scribe-edit-text-editor';
  Object.assign(canvas.style, { position: 'absolute', pointerEvents: 'auto', cursor: 'text' });
  const hiddenInput = document.createElement('textarea');
  Object.assign(hiddenInput.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '1px',
    height: '1px',
    opacity: '0',
    border: 'none',
    padding: '0',
    resize: 'none',
    zIndex: '-1',
  });
  hiddenInput.setAttribute('autocapitalize', 'off');
  hiddenInput.setAttribute('autocomplete', 'off');
  hiddenInput.setAttribute('spellcheck', 'false');

  let caretBlinkOn = true;
  /** @type {?number} */
  let blinkTimer = null;

  const layout = () => {
    const {
      text, origText, origChars, styleFromChar, baselineY,
    } = st;
    const len = text.length;
    const olen = origText.length;
    let p = 0;
    while (p < len && p < olen && text[p] === origText[p]) p += 1;
    // A ligature draws as one glyph on its first letter, so a boundary landing inside one decomposes the whole cluster into the flow region.
    while (p > 0 && p < olen && origChars[p].ligMember) p -= 1;
    let sfx = 0;
    while (sfx < len - p && sfx < olen - p && text[len - 1 - sfx] === origText[olen - 1 - sfx]) sfx += 1;
    while (sfx > 0 && origChars[olen - sfx].ligMember) sfx -= 1;

    /** @type {Array<{ch: string, x: number, w: number, size: number, baseY: number, face: string,
     *   tofu?: boolean, color: string, fontStyle?: string, fontWeight?: string, skew?: number,
     *   stretch?: number}>} */
    const draws = [];
    const xs = new Float64Array(len + 1);
    /**
     * Baseline y at each caret position.
     * It lets the caret follow raised (sup) words.
     */
    const ys = new Float64Array(len + 1);
    const szs = new Float64Array(len + 1);

    const emitOriginal = (ti, oi, dx) => {
      const c = origChars[oi];
      xs[ti] = c.x0 + dx;
      ys[ti] = c.baseY;
      szs[ti] = c.size;
      if (c.ch !== ' ' && !c.ligMember) {
        draws.push({
          ch: c.lig || c.ch,
          x: c.x0 + dx,
          w: c.x1 - c.x0,
          size: c.size,
          baseY: c.baseY,
          face: c.face,
          tofu: c.tofu,
          color: c.color,
          fontStyle: c.fontStyle,
          fontWeight: c.fontWeight,
          skew: c.skew,
          stretch: c.stretch,
        });
      }
    };

    for (let i = 0; i < p; i++) emitOriginal(i, i, 0);

    let flowX = p < olen ? origChars[p].x0 : (olen > 0 ? origChars[olen - 1].x1 : 0);
    const flowBaseY = p < olen ? origChars[p].baseY : (olen > 0 ? origChars[olen - 1].baseY : baselineY);
    const mid = styleFromChar;
    for (let i = p; i < len - sfx; i++) {
      const ch = text[i];
      xs[i] = flowX;
      ys[i] = flowBaseY;
      szs[i] = mid.size;
      if (ch === ' ') {
        flowX += mid.spaceAdvPx;
        continue;
      }
      const r = resolveReplacementChar(ch, mid.program, mid.style);
      if (r.kind === 'tofu') {
        draws.push({
          ch, x: flowX, w: r.advEm * mid.size, size: mid.size, baseY: flowBaseY, face: '', tofu: true, color: mid.color,
        });
        flowX += r.advEm * mid.size;
      } else {
        const face = r.kind === 'orig' ? mid.face : (r.fontFaceName || r.family);
        draws.push({
          ch,
          x: flowX,
          w: r.advEm * mid.size,
          size: mid.size,
          baseY: flowBaseY,
          face,
          color: mid.color,
          fontStyle: r.kind !== 'orig' && mid.style.italic ? 'italic' : '',
          fontWeight: r.kind !== 'orig' && mid.style.bold ? 'bold' : '',
        });
        flowX += r.advEm * mid.size;
      }
    }

    if (sfx > 0) {
      const oStart = olen - sfx;
      const rawDelta = flowX - origChars[oStart].x0;
      const dx = Math.abs(rawDelta) < 0.5 ? 0 : rawDelta;
      for (let i = 0; i < sfx; i++) emitOriginal(len - sfx + i, oStart + i, dx);
      xs[len] = origChars[olen - 1].x1 + dx;
      ys[len] = origChars[olen - 1].baseY;
      szs[len] = origChars[olen - 1].size;
    } else {
      xs[len] = flowX;
      ys[len] = flowBaseY;
      szs[len] = mid.size;
    }
    return {
      draws, xs, ys, szs, firstDiff: p,
    };
  };

  const selRange = () => {
    if (!st || st.selAnchor == null || st.selAnchor === st.caret) return null;
    return st.selAnchor < st.caret ? [st.selAnchor, st.caret] : [st.caret, st.selAnchor];
  };

  const draw = () => {
    if (!st) return;
    const {
      draws, xs, ys, szs,
    } = layout();
    st.xs = xs;
    st.ys = ys;
    st.szs = szs;
    const cx = canvas.getContext('2d');
    cx.setTransform(1, 0, 0, 1, 0, 0);
    cx.clearRect(0, 0, canvas.width, canvas.height);
    cx.setTransform(st.scale, 0, 0, st.scale, -st.box.left * st.scale, -st.box.top * st.scale);
    cx.textBaseline = 'alphabetic';
    const sel = selRange();
    if (sel) {
      // On the page's white this fill matches the multiply-blended wash the page-level selection layer draws.
      cx.fillStyle = '#a6c8ff';
      for (let i = sel[0]; i < sel[1]; i++) {
        cx.fillRect(xs[i], ys[i] - 0.85 * szs[i], xs[i + 1] - xs[i], 1.05 * szs[i]);
      }
    }
    for (const d of draws) {
      if (d.tofu) {
        cx.lineWidth = 0.06 * d.size;
        cx.strokeStyle = d.color;
        cx.strokeRect(d.x + 0.07 * d.size, d.baseY - 0.72 * d.size, d.w - 0.14 * d.size, 0.72 * d.size);
      } else {
        // Style keywords and conditional family quoting mirror the raster's substituted-text path.
        cx.font = `${d.fontStyle || 'normal'} ${d.fontWeight || 'normal'} ${d.size}px ${/[",]/.test(d.face) ? d.face : `"${d.face}"`}`;
        cx.fillStyle = d.color;
        if (d.skew || (d.stretch && d.stretch !== 1)) {
          cx.save();
          if (d.skew) cx.transform(1, 0, -d.skew, 1, d.skew * d.baseY, 0);
          if (d.stretch && d.stretch !== 1) cx.transform(d.stretch, 0, 0, 1, d.x * (1 - d.stretch), 0);
          cx.fillText(d.ch, d.x, d.baseY);
          cx.restore();
        } else {
          cx.fillText(d.ch, d.x, d.baseY);
        }
      }
    }
    if (caretBlinkOn && !sel) {
      const ci = Math.min(st.caret, xs.length - 1);
      const x = xs[ci];
      const cy = ys[ci];
      cx.strokeStyle = '#1a73e8';
      cx.lineWidth = 2 / st.scale;
      cx.beginPath();
      cx.moveTo(x, cy - st.size * 0.85);
      cx.lineTo(x, cy + st.size * 0.2);
      cx.stroke();
    }
  };

  const restartBlink = () => {
    caretBlinkOn = true;
    if (blinkTimer) clearInterval(blinkTimer);
    blinkTimer = window.setInterval(() => {
      caretBlinkOn = !caretBlinkOn;
      draw();
    }, 550);
  };

  const setCaret = (i) => {
    st.caret = Math.max(0, Math.min(st.text.length, i));
    restartBlink();
    draw();
  };

  const pushUndo = () => {
    st.undoStack.push({ text: st.text, caret: st.caret });
    if (st.undoStack.length > 200) st.undoStack.shift();
    st.redoStack.length = 0;
  };

  const insertText = (chunk) => {
    const clean = chunk.replace(/[\r\n\t]/g, ' ');
    if (!clean) return;
    pushUndo();
    const sel = selRange();
    if (sel) {
      st.text = st.text.slice(0, sel[0]) + clean + st.text.slice(sel[1]);
      st.caret = sel[0] + clean.length;
      st.selAnchor = null;
    } else {
      st.text = st.text.slice(0, st.caret) + clean + st.text.slice(st.caret);
      st.caret += clean.length;
    }
    restartBlink();
    draw();
  };

  /** @param {[number, number]} sel */
  const deleteRange = (sel) => {
    pushUndo();
    st.text = st.text.slice(0, sel[0]) + st.text.slice(sel[1]);
    st.caret = sel[0];
    st.selAnchor = null;
    restartBlink();
    draw();
  };

  /**
   * Tear down input handling and repaint caret-less.
   * The canvas itself outlives the session.
   */
  const detachInput = () => {
    if (blinkTimer) clearInterval(blinkTimer);
    blinkTimer = null;
    caretBlinkOn = false;
    if (st) st.selAnchor = null;
    draw();
    hiddenInput.remove();
    document.removeEventListener('pointerdown', onDocPointerdown, true);
  };

  let lingerToken = 0;
  /**
   * Remove the preview canvas only once page `n`'s refreshed raster has landed.
   * @param {number} n
   */
  const removeCanvasAfterRefresh = (n) => {
    const tk = ++lingerToken;
    let retries = 3;
    /** @param {?Promise<any>} watched */
    const settle = (watched) => {
      const done = () => {
        // A reopen reclaimed the canvas while this waited; leave it to the new session.
        if (lingerToken !== tk || st) return;
        const cur = scribe.imageCache?.pageCanvases?.[n];
        // A back-to-back refresh superseded the watched render before it attached.
        // The canvas must outlive the replacement render too, or the line blanks until it lands.
        if (cur && cur !== watched) { settle(cur); return; }
        if (!cur && watched && retries > 0) {
          // The watched render was dropped or failed without a successor.
          retries -= 1;
          scribe.imageCache?.addPageCanvas(n);
          const next = scribe.imageCache?.pageCanvases?.[n];
          if (next) { settle(next); return; }
        }
        canvas.remove();
      };
      if (watched) watched.then(done, done);
      else done();
    };
    settle(scribe.imageCache?.pageCanvases?.[n] ?? null);
  };

  const close = () => {
    if (!st) return;
    const { n } = st;
    // The lingering canvas keeps whatever detachInput's repaint drew, so st.text must hold the original line.
    st.text = st.origText;
    detachInput();
    st = null;
    scribe.doc.images.setEphemeralEditRects(n, null);
    scribe.refreshPageRaster(n);
    removeCanvasAfterRefresh(n);
  };

  const commit = async () => {
    if (!st) return;
    const {
      line, n, text, origText,
    } = st;
    if (text.trim() === origText || text.trim() === origText.trim()) {
      close();
      return;
    }
    detachInput();
    st = null;
    try {
      const res = await scribe.doc.replaceTextLine(line, text);
      // A newer session may have opened on this page while replaceTextLine ran and now owns the rects.
      // Clearing them would redraw that session's original text under its editor.
      if (!st || st.n !== n) scribe.doc.images.setEphemeralEditRects(n, null);
      if (res && onCommitted) onCommitted(res.pages);
      else scribe.refreshPageRaster(n);
      removeCanvasAfterRefresh(n);
    } catch (e) {
      if (!st || st.n !== n) scribe.doc.images.setEphemeralEditRects(n, null);
      scribe.refreshPageRaster(n);
      removeCanvasAfterRefresh(n);
      throw e;
    }
  };

  const commitSafe = () => {
    commit().catch((e) => console.error('Edit Text: commit failed:', e));
  };

  const onKeydown = (ev) => {
    if (!st) return;
    ev.stopPropagation();
    if (ev.key === 'Escape') {
      ev.preventDefault();
      close();
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      commitSafe();
      return;
    }
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod && (ev.key === 'z' || ev.key === 'Z')) {
      // The document's text-edit history can only undo committed edits, so the editor keeps its own typing-level stacks.
      ev.preventDefault();
      const from = ev.shiftKey ? st.redoStack : st.undoStack;
      const to = ev.shiftKey ? st.undoStack : st.redoStack;
      const prev = from.pop();
      if (prev) {
        to.push({ text: st.text, caret: st.caret });
        st.text = prev.text;
        st.caret = prev.caret;
        st.selAnchor = null;
        restartBlink();
        draw();
      }
      return;
    }
    if (mod && (ev.key === 'a' || ev.key === 'A')) {
      ev.preventDefault();
      st.selAnchor = 0;
      st.caret = st.text.length;
      draw();
      return;
    }
    if (mod && (ev.key === 'c' || ev.key === 'C')) {
      const sel = selRange();
      if (sel) {
        ev.preventDefault();
        navigator.clipboard?.writeText(st.text.slice(sel[0], sel[1])).catch(() => {});
      }
      return;
    }
    if (mod) return;
    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'Home' || ev.key === 'End') {
      ev.preventDefault();
      const sel = selRange();
      let target;
      if (ev.key === 'Home') target = 0;
      else if (ev.key === 'End') target = st.text.length;
      else if (!ev.shiftKey && sel) target = ev.key === 'ArrowLeft' ? sel[0] : sel[1];
      else target = st.caret + (ev.key === 'ArrowLeft' ? -1 : 1);
      if (ev.shiftKey) {
        if (st.selAnchor == null) st.selAnchor = st.caret;
      } else st.selAnchor = null;
      setCaret(target);
      return;
    }
    if (ev.key === 'Backspace') {
      ev.preventDefault();
      const sel = selRange();
      if (sel) { deleteRange(sel); return; }
      if (st.caret > 0) {
        pushUndo();
        st.text = st.text.slice(0, st.caret - 1) + st.text.slice(st.caret);
        st.caret -= 1;
        restartBlink();
        draw();
      }
      return;
    }
    if (ev.key === 'Delete') {
      ev.preventDefault();
      const sel = selRange();
      if (sel) { deleteRange(sel); return; }
      if (st.caret < st.text.length) {
        pushUndo();
        st.text = st.text.slice(0, st.caret) + st.text.slice(st.caret + 1);
        restartBlink();
        draw();
      }
    }
  };

  const onInput = () => {
    if (!st || st.composing) return;
    const v = hiddenInput.value;
    if (v) {
      hiddenInput.value = '';
      insertText(v);
    }
  };
  const onCompositionStart = () => { if (st) st.composing = true; };
  const onCompositionEnd = () => {
    if (!st) return;
    st.composing = false;
    onInput();
  };

  const slotAtClient = (clientX) => {
    const rect = canvas.getBoundingClientRect();
    const localX = st.box.left + (clientX - rect.left) / (rect.width / (st.box.right - st.box.left));
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < st.xs.length; i++) {
      const d = Math.abs(localX - st.xs[i]);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  };

  // Double clicks are detected manually because preventing the pointerdown's default suppresses dblclick events.
  let lastCanvasDown = { t: -1e9, x: 0 };
  const onCanvasPointerdown = (ev) => {
    if (!st || !containsPoint(ev.clientX, ev.clientY)) return;
    ev.stopPropagation();
    ev.preventDefault();
    const isDouble = ev.timeStamp - lastCanvasDown.t < 420 && Math.abs(ev.clientX - lastCanvasDown.x) < 4;
    lastCanvasDown = { t: ev.timeStamp, x: ev.clientX };
    hiddenInput.focus({ preventScroll: true });
    if (isDouble && st.text) {
      let i = Math.max(0, Math.min(slotAtClient(ev.clientX), st.text.length - 1));
      if (st.text[i] === ' ' && i > 0 && st.text[i - 1] !== ' ') i -= 1;
      let a = i;
      let b = i;
      while (a > 0 && st.text[a - 1] !== ' ') a -= 1;
      while (b < st.text.length && st.text[b] !== ' ') b += 1;
      st.selAnchor = a;
      st.caret = b;
      draw();
      return;
    }
    const anchor = slotAtClient(ev.clientX);
    st.selAnchor = null;
    setCaret(anchor);
    const onMove = (mv) => {
      if (!st) return;
      const slot = slotAtClient(mv.clientX);
      st.selAnchor = slot === anchor ? null : anchor;
      st.caret = slot;
      draw();
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /**
   * Whether a point is inside the open editor's text band.
   * @param {number} clientX
   * @param {number} clientY
   */
  const containsPoint = (clientX, clientY) => {
    if (!st || !st.xs || st.xs.length === 0) return false;
    const p = scribe.clientToPage(clientX, clientY);
    if (p.n !== st.n) return false;
    const local = scribe.pageToLocal(st.n, st.orientation, p.x, p.y);
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    // The editor's canvas element spans the page's whole width, so the band comes from the glyph positions instead.
    // The em ratios match the mode's drawn line boxes, so no click can fall between the two regions.
    for (let i = 0; i < st.xs.length; i++) {
      const size = st.szs?.[i] ?? st.size;
      left = Math.min(left, st.xs[i]);
      right = Math.max(right, st.xs[i]);
      top = Math.min(top, st.ys[i] - 0.75 * size);
      bottom = Math.max(bottom, st.ys[i] + 0.25 * size);
    }
    const pad = 2;
    return local.x >= left - pad && local.x <= right + pad
      && local.y >= top - pad && local.y <= bottom + pad;
  };

  const onDocPointerdown = (ev) => {
    if (!st) return;
    if (ev.target === hiddenInput || containsPoint(ev.clientX, ev.clientY)) return;
    commitSafe();
  };

  canvas.addEventListener('pointerdown', onCanvasPointerdown);
  hiddenInput.addEventListener('keydown', onKeydown);
  hiddenInput.addEventListener('input', onInput);
  hiddenInput.addEventListener('compositionstart', onCompositionStart);
  hiddenInput.addEventListener('compositionend', onCompositionEnd);

  /**
   * Open the editor on a line.
   * @param {{n: number, line: OcrLine, lbox: bbox, orientation: number, start: number}} info - `lineInfoAt` result for the clicked point.
   * @param {number} clientX
   * @param {number} clientY
   */
  const open = async (info, clientX, clientY) => {
    if (st) await commit();
    const { line, n, orientation } = info;
    const page = line.page;
    const dims = page.dims;
    const nt = nativeTextForPage(scribe.doc, page);

    /** @type {Map<number, {program: ?object, faceName: ?string}>} */
    const fonts = new Map();
    for (const w of line.words) {
      const f = nt[w.id]?.fontObjNum;
      if (!fonts.has(f)) fonts.set(f, (await scribe.doc.images.getEditFont(n, f)) || { program: null, faceName: null });
    }

    const baselineY = line.bbox.bottom + (line.baseline?.[1] || 0);
    /**
     * @type {Array<{ch: string, x0: number, x1: number, size: number, baseY: number, face: string,
     *   color: string, tofu?: boolean, lig?: string, ligMember?: boolean, fontStyle?: string,
     *   fontWeight?: string, skew?: number, stretch?: number}>}
     */
    const origChars = [];
    let origText = '';
    for (let wi = 0; wi < line.words.length; wi++) {
      const w = line.words[wi];
      const size = w.style.size || Math.abs(w.bbox.bottom - w.bbox.top) / 0.75;
      const baseY = nt[w.id]?.baselineY ?? baselineY;
      const color = w.style.color || '#000000';
      const ef = fonts.get(nt[w.id]?.fontObjNum);
      if (wi > 0) {
        const prev = line.words[wi - 1];
        origChars.push({
          ch: ' ', x0: prev.bbox.right, x1: w.bbox.left, size, baseY, face: '', color,
        });
        origText += ' ';
      }
      // An embedded face carries its style in its glyphs, so the italic/bold keywords go only on a fallback face.
      const charFace = (ch) => {
        let face = ef.faceName;
        let tofu = false;
        let fontStyle = '';
        let fontWeight = '';
        if (!face) {
          const r = resolveReplacementChar(ch, ef.program, w.style);
          if (r.kind === 'tofu') tofu = true;
          else {
            face = r.fontFaceName || r.family;
            if (w.style.italic) fontStyle = 'italic';
            if (w.style.bold) fontWeight = 'bold';
          }
        }
        return {
          face: face || '', tofu, fontStyle, fontWeight,
        };
      };
      const entries = w.chars && w.chars.length > 0 ? w.chars : null;
      const wPenX = nt[w.id]?.penX;
      const wSkew = nt[w.id]?.skew;
      const wStretch = nt[w.id]?.stretch;
      let segs = entries ? entries.map((c) => ocr.replaceLigatures(c.text)) : null;
      if (segs && segs.join('') !== w.text) segs = null;
      if (segs) {
        for (let ei = 0; ei < entries.length; ei++) {
          const seg = segs[ei];
          const eb = entries[ei].bbox;
          // The bbox rounds the pen origin.
          // Per-glyph rounding reads as wrong letter spacing against the raster.
          const pen = wPenX?.[ei] ?? eb.left;
          if (seg.length === 1) {
            const f = charFace(seg);
            origChars.push({
              ch: seg,
              x0: pen,
              x1: eb.right,
              size,
              baseY,
              face: f.face,
              color,
              tofu: f.tofu,
              fontStyle: f.fontStyle,
              fontWeight: f.fontWeight,
              skew: wSkew?.[ei] || 0,
              stretch: wStretch?.[ei] || 0,
            });
            origText += seg;
            continue;
          }
          // A ligature the original font still maps draws as one glyph on the first letter's entry.
          // The rest of its entries only hold caret positions.
          const ligCh = ocr.ligatureForText(entries[ei].text);
          const ligOk = !!(ligCh && ef.faceName
            && resolveReplacementChar(ligCh, ef.program, w.style).kind === 'orig');
          for (let j = 0; j < seg.length; j++) {
            const x0 = pen + ((eb.right - pen) * j) / seg.length;
            const x1 = pen + ((eb.right - pen) * (j + 1)) / seg.length;
            const f = ligOk ? {
              face: ef.faceName, tofu: false, fontStyle: '', fontWeight: '',
            } : charFace(seg[j]);
            const entry = {
              ch: seg[j], x0, x1, size, baseY, face: f.face, color, tofu: f.tofu, fontStyle: f.fontStyle, fontWeight: f.fontWeight, skew: wSkew?.[ei] || 0, stretch: wStretch?.[ei] || 0,
            };
            if (ligOk && j === 0) entry.lig = ligCh;
            if (ligOk && j > 0) entry.ligMember = true;
            origChars.push(entry);
            origText += seg[j];
          }
        }
      } else {
        let cxPos = w.bbox.left;
        for (let ci = 0; ci < w.text.length; ci++) {
          const ch = w.text[ci];
          const r = resolveReplacementChar(ch, ef.program, w.style);
          const x0 = cxPos;
          const x1 = cxPos + r.advEm * size;
          cxPos = x1;
          const f = charFace(ch);
          origChars.push({
            ch, x0, x1, size, baseY, face: f.face, color, tofu: f.tofu, fontStyle: f.fontStyle, fontWeight: f.fontWeight,
          });
          origText += ch;
        }
      }
    }

    const styleFromWord = line.words[0];
    const sfSize = styleFromWord.style.size || Math.abs(styleFromWord.bbox.bottom - styleFromWord.bbox.top) / 0.75;
    const sfFonts = fonts.get(nt[styleFromWord.id]?.fontObjNum);
    const sp = resolveReplacementChar(' ', sfFonts.program, styleFromWord.style);

    // A zero descriptor descent puts char bbox bottoms at the baseline, so a canvas sized from the bboxes would clip descenders.
    let inkTop = baselineY - 1.3 * sfSize;
    let inkBottom = baselineY + 0.5 * sfSize;
    for (const c of origChars) {
      inkTop = Math.min(inkTop, c.baseY - 1.3 * c.size);
      inkBottom = Math.max(inkBottom, c.baseY + 0.5 * c.size);
    }
    const groupBox = {
      left: Math.min(line.bbox.left, 0) - 4,
      top: Math.min(line.bbox.top, inkTop) - 6,
      right: (orientation % 2 === 0 ? dims.width : dims.height),
      bottom: Math.max(line.bbox.bottom, inkBottom) + 6,
    };
    const group = scribe.getTextGroup(n, orientation);
    const dpr = window.devicePixelRatio || 1;
    const unitsW = orientation % 2 === 0 ? dims.width : dims.height;
    const unitsH = orientation % 2 === 0 ? dims.height : dims.width;
    const rasterEl = /** @type {?HTMLCanvasElement} */ (scribe.pageContainerArr?.[n]?.querySelector('canvas.scribe-layer-image'));
    const grect = group.getBoundingClientRect();
    // The raster renders at a rounded integer width with compensated CSS, so ideal zoom coordinates drift from its real frame by up to a pixel across the page.
    // Rotation is baked into the raster canvas, so it is oriented like the group and needs no axis swaps.
    const rr = rasterEl && rasterEl.width > 0 ? rasterEl.getBoundingClientRect() : grect;
    const guxR = rr.width / unitsW;
    const guyR = rr.height / unitsH;
    const gux = grect.width / unitsW;
    const guy = grect.height / unitsH;
    // Draw at the raster's backing density while the compositor upscales it.
    // Its glyph rows are quantized to that grid.
    const bsY = rasterEl && rasterEl.width > 0 ? rasterEl.height / unitsH : 0;
    const scale = bsY > 0 ? Math.min(guyR * dpr, bsY) : guyR * dpr;
    // The origin should sit on a whole cell of the raster's backing grid and on an integer device pixel, but a fractional upscale cannot satisfy both everywhere.
    // A fractional device origin resolves to either neighboring pixel as scroll phase changes, so the preview can land a pixel off the raster.
    const Ux = (guxR * dpr) / scale;
    const Uy = (guyR * dpr) / scale;
    const alignCell = (desired, edge, U) => {
      const k0 = Math.floor(desired * scale);
      let bestK = k0;
      let bestD = 1;
      for (let i = 0; i < 12; i++) {
        const dev = edge * dpr + (k0 - i) * U;
        const d = Math.abs(dev - Math.round(dev));
        if (d < bestD) { bestD = d; bestK = k0 - i; }
      }
      return bestK;
    };
    const kx = alignCell(groupBox.left, rr.left, Ux);
    const ky = alignCell(groupBox.top, rr.top, Uy);
    groupBox.left = kx / scale;
    groupBox.top = ky / scale;
    canvas.width = Math.max(1, Math.ceil((groupBox.right - groupBox.left) * scale));
    canvas.height = Math.max(1, Math.ceil((groupBox.bottom - groupBox.top) * scale));
    groupBox.right = groupBox.left + canvas.width / scale;
    groupBox.bottom = groupBox.top + canvas.height / scale;
    // Position and size are computed in the raster's frame, whose mapping can differ from the group's.
    // The gux/guy divisions only re-express those client values in group units, since the canvas scales under the group transform.
    canvas.style.left = `${(rr.left + groupBox.left * guxR - grect.left) / gux}px`;
    canvas.style.top = `${(rr.top + groupBox.top * guyR - grect.top) / guy}px`;
    canvas.style.width = `${(canvas.width * Ux) / dpr / gux}px`;
    canvas.style.height = `${(canvas.height * Uy) / dpr / guy}px`;
    group.appendChild(canvas);
    document.body.appendChild(hiddenInput);

    st = {
      line,
      n,
      orientation,
      box: groupBox,
      scale,
      baselineY,
      size: sfSize,
      text: origText,
      origText,
      origChars,
      styleFromChar: {
        program: sfFonts.program,
        style: styleFromWord.style,
        size: sfSize,
        color: styleFromWord.style.color || '#000000',
        face: sfFonts.faceName || '',
        spaceAdvPx: (sp.kind === 'tofu' ? 0.25 : sp.advEm) * sfSize,
      },
      caret: 0,
      selAnchor: null,
      xs: new Float64Array(origText.length + 1),
      ys: new Float64Array(origText.length + 1),
      undoStack: [],
      redoStack: [],
      composing: false,
    };

    const pt = scribe.textSel?.pointAt?.(clientX, clientY);
    const off = pt && pt.n === n ? pt.off - info.start : 0;
    st.caret = Math.max(0, Math.min(origText.length, off));

    const rects = line.words.map((w) => wordBandRect(w.bbox, w.chars, orientation, dims));
    scribe.doc.images.setEphemeralEditRects(n, rects);
    scribe.refreshPageRaster(n);

    document.addEventListener('pointerdown', onDocPointerdown, true);
    hiddenInput.value = '';
    hiddenInput.focus({ preventScroll: true });
    restartBlink();
    draw();
  };

  return {
    open,
    isOpen: () => !!st,
    lineOpen: () => st?.line || null,
    containsPoint,
    commit,
    revert: close,
    teardown: close,
  };
}
