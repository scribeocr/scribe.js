/**
 * The Edit Text mode's live line editor.
 * A per-line canvas overlay draws the line being edited while the page raster re-renders with that line suppressed.
 */
import { ensureGlyphSetForText } from '../../js/fontContainerMain.js';
import ocr from '../../js/objects/ocrObjects.js';
import { resolveReplacementChar } from '../../js/pdf/glyphResolve.js';
import {
  wordBandRect, nativeTextForPage, glyphIdentitiesForWords, FAUX_BOLD_STROKE_EM, FAUX_OBLIQUE_SKEW,
} from '../../js/textEdits.js';

/** @typedef {import('../../js/objects/ocrObjects.js').OcrLine} OcrLine */

/**
 * One character of the line as the raster drew it.
 * @typedef {object} EditChar
 * @property {string} ch
 * @property {number} x0
 * @property {number} x1
 * @property {number} size
 * @property {number} baseY
 * @property {string} face
 * @property {string} color
 * @property {boolean} [tofu]
 * @property {string} [lig] - The ligature this character's cluster draws as, set on the cluster's first character.
 * @property {boolean} [ligMember] - A later character of a ligature cluster, which holds only a caret position.
 * @property {string} [fontStyle]
 * @property {string} [fontWeight]
 * @property {number} [skew]
 * @property {number} [stretch]
 * @property {number} [renderMode]
 * @property {number} [strokeWidthPx]
 * @property {string} [strokeColor]
 */

/**
 * The line currently open for editing.
 * @typedef {object} EditSession
 * @property {OcrLine} line
 * @property {number} n
 * @property {number} orientation
 * @property {{left: number, top: number, right: number, bottom: number}} box - The canvas's extent in the orientation group's local space.
 * @property {number} scale - Canvas pixels per local unit.
 * @property {number} baselineY
 * @property {number} size
 * @property {string} text - The live text, which edits mutate.
 * @property {string} origText
 * @property {Array<EditChar>} origChars
 * @property {WordMid} styleFromChar - The style newly typed characters take.
 * @property {Array<WordMid>} [wordMids] - Per-word typed-character styles, index-aligned with the line's words.
 * @property {number} caret
 * @property {?number} selAnchor
 * @property {Float64Array} xs - Local x of each caret slot.
 * @property {Float64Array} ys - Baseline y of each caret slot.
 * @property {Float64Array} [szs] - Font size at each caret slot.
 * @property {Map<number, WordToggle>} styleOv - Live bold/italic toggles keyed by word index of `text`.
 * @property {Map<number, WordBase>} wordBase - Each word's pre-edit style state, remapped alongside `styleOv`.
 * @property {Array<EditSnapshot>} undoStack
 * @property {Array<EditSnapshot>} redoStack
 * @property {boolean} composing
 */

/**
 * @typedef {{program: ?import('../../js/pdf/glyphResolve.js').EditFontProgram, style: Style, size: number,
 *   color: string, face: string, spaceAdvPx: number, renderMode?: number, strokeWidthPx?: number,
 *   strokeColor?: string, skew?: number}} WordMid
 */

/** @typedef {{bold?: boolean, italic?: boolean}} WordToggle */
/** @typedef {{bold: boolean, italic: boolean, stroked: boolean, skewed: boolean}} WordBase */
/** @typedef {{text: string, caret: number, styleOv: Map<number, WordToggle>, wordBase: Map<number, WordBase>}} EditSnapshot */

/**
 * Character spans of `text`'s whitespace-split words, `[start, end)` per word.
 * @param {string} text
 */
const tokenSpans = (text) => {
  /** @type {Array<[number, number]>} */
  const spans = [];
  const re = /\S+/g;
  let m = re.exec(text);
  while (m !== null) {
    spans.push([m.index, m.index + m[0].length]);
    m = re.exec(text);
  }
  return spans;
};

/**
 * @param {any} scribe - The viewer instance.
 * @param {{onCommitted?: (pages: Array<number>) => void, onOpenChanged?: (open: boolean) => void}} [hooks]
 */
export function createLineEditor(scribe, { onCommitted, onOpenChanged } = {}) {
  /** @type {?EditSession} */
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
  // The editing field draws only while a session is live, never on the lingering post-close canvas.
  let fieldOn = false;

  /** @param {EditSession} session */
  const layout = (session) => {
    const {
      text, origText, origChars, styleFromChar, baselineY, styleOv,
    } = session;
    const len = text.length;
    const olen = origText.length;
    // Word index at each character of the live text, for the per-word bold/italic toggles.
    const tokOf = new Int32Array(len + 1).fill(-1);
    if (styleOv.size > 0) {
      for (const [s0, s1] of tokenSpans(text).entries()) {
        for (let i = s1[0]; i < s1[1]; i++) tokOf[i] = s0;
      }
    }

    /**
     * Restyle one draw descriptor per its word's live toggle.
     * @template T
     * @param {T} d
     * @param {number} ti - The character's index in the live text.
     * @returns {T}
     */
    const applyToggle = (d, ti) => {
      const o = tokOf[ti] >= 0 ? styleOv.get(tokOf[ti]) : undefined;
      if (!o) return d;
      const dd = /** @type {{size: number, color: string, skew?: number, renderMode?: number, strokeWidthPx?: number, strokeColor?: string}} */ (d);
      if (o.bold === true && !dd.renderMode) {
        dd.renderMode = 2;
        dd.strokeWidthPx = FAUX_BOLD_STROKE_EM * dd.size;
        dd.strokeColor = dd.color;
      } else if (o.bold === false) {
        dd.renderMode = undefined;
        dd.strokeWidthPx = undefined;
        dd.strokeColor = undefined;
      }
      if (o.italic === true && !dd.skew) dd.skew = FAUX_OBLIQUE_SKEW;
      else if (o.italic === false) dd.skew = 0;
      return d;
    };
    let p = 0;
    while (p < len && p < olen && text[p] === origText[p]) p += 1;
    // A ligature draws as one glyph on its first letter, so a boundary landing inside one decomposes the whole cluster into the flow region.
    while (p > 0 && p < olen && origChars[p].ligMember) p -= 1;
    let sfx = 0;
    while (sfx < len - p && sfx < olen - p && text[len - 1 - sfx] === origText[olen - 1 - sfx]) sfx += 1;
    while (sfx > 0 && origChars[olen - sfx].ligMember) sfx -= 1;

    /** @type {Array<{ch: string, x: number, w: number, size: number, baseY: number, face: string,
     *   tofu?: boolean, color: string, fontStyle?: string, fontWeight?: string, skew?: number,
     *   stretch?: number, renderMode?: number, strokeWidthPx?: number, strokeColor?: string}>} */
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
        draws.push(applyToggle({
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
          renderMode: c.renderMode,
          strokeWidthPx: c.strokeWidthPx,
          strokeColor: c.strokeColor,
        }, ti));
      }
    };

    for (let i = 0; i < p; i++) emitOriginal(i, i, 0);

    let flowX = p < olen ? origChars[p].x0 : (olen > 0 ? origChars[olen - 1].x1 : 0);
    const flowBaseY = p < olen ? origChars[p].baseY : (olen > 0 ? origChars[olen - 1].baseY : baselineY);
    // Typed characters must resolve against the word they land in exactly as the commit does, or a multi-font line previews differently from what it commits as.
    // Past the last original word, both sides fall back to that word's style.
    const mids = session.wordMids && session.wordMids.length > 0 ? session.wordMids : [styleFromChar];
    let flowWi = 0;
    for (let i = 0; i < p; i++) if (text[i] === ' ') flowWi += 1;
    for (let i = p; i < len - sfx; i++) {
      const ch = text[i];
      const mid = mids[Math.min(flowWi, mids.length - 1)];
      xs[i] = flowX;
      ys[i] = flowBaseY;
      szs[i] = mid.size;
      if (ch === ' ') {
        flowWi += 1;
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
        const face = (r.kind === 'orig' ? mid.face : (r.fontFaceName || r.family)) || '';
        const fitMult = (r.kind === 'bundled' ? r.sizeMult : 1) || 1;
        draws.push(applyToggle({
          ch,
          x: flowX,
          w: r.advEm * mid.size,
          size: mid.size * fitMult,
          baseY: flowBaseY,
          face,
          color: mid.color,
          fontStyle: r.kind !== 'orig' && mid.style.italic ? 'italic' : '',
          fontWeight: r.kind !== 'orig' && mid.style.bold ? 'bold' : '',
          skew: mid.skew,
          stretch: r.kind === 'bundled' && r.stretch !== 1 ? r.stretch : undefined,
          renderMode: mid.renderMode,
          strokeWidthPx: mid.strokeWidthPx,
          strokeColor: mid.strokeColor,
        }, i));
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
      szs[len] = mids[Math.min(flowWi, mids.length - 1)].size;
    }
    return {
      draws, xs, ys, szs, firstDiff: p,
    };
  };

  /** @returns {?[number, number]} */
  const selRange = () => {
    if (!st || st.selAnchor == null || st.selAnchor === st.caret) return null;
    return st.selAnchor < st.caret ? [st.selAnchor, st.caret] : [st.caret, st.selAnchor];
  };

  const draw = () => {
    if (!st) return;
    const {
      draws, xs, ys, szs,
    } = layout(st);
    st.xs = xs;
    st.ys = ys;
    st.szs = szs;
    const cx = canvas.getContext('2d');
    if (!cx) return;
    cx.setTransform(1, 0, 0, 1, 0, 0);
    cx.clearRect(0, 0, canvas.width, canvas.height);
    cx.setTransform(st.scale, 0, 0, st.scale, -st.box.left * st.scale, -st.box.top * st.scale);
    cx.textBaseline = 'alphabetic';
    if (fieldOn && xs.length > 0) {
      let left = Infinity;
      let right = -Infinity;
      let top = Infinity;
      let bottom = -Infinity;
      for (let i = 0; i < xs.length; i++) {
        const size = szs[i] || st.size;
        left = Math.min(left, xs[i]);
        right = Math.max(right, xs[i]);
        top = Math.min(top, ys[i] - 0.75 * size);
        bottom = Math.max(bottom, ys[i] + 0.25 * size);
      }
      const dpr = window.devicePixelRatio || 1;
      // The band and 2-unit pad match the mode's line boxes, so the field lands exactly where the hairline sat.
      const pad = 2;
      const radius = (3 * dpr) / st.scale;
      cx.save();
      cx.beginPath();
      if (cx.roundRect) cx.roundRect(left - pad, top - pad, right - left + 2 * pad, bottom - top + 2 * pad, radius);
      else cx.rect(left - pad, top - pad, right - left + 2 * pad, bottom - top + 2 * pad);
      // Canvas ignores the transform for shadow blur and offset, so these hold a constant screen size at any zoom.
      cx.shadowColor = 'rgba(20, 30, 60, 0.22)';
      cx.shadowBlur = 5 * dpr;
      cx.shadowOffsetY = dpr;
      cx.fillStyle = '#ffffff';
      cx.fill();
      cx.shadowColor = 'rgba(0, 0, 0, 0)';
      cx.shadowBlur = 0;
      cx.shadowOffsetY = 0;
      cx.strokeStyle = '#c9d2de';
      cx.lineWidth = dpr / st.scale;
      cx.stroke();
      cx.restore();
    }
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
        // Faux-bold chars re-stroke the outlines like the raster (mode 2 fills then strokes; mode 1 strokes only).
        const strokeW = (d.renderMode === 1 || d.renderMode === 2) && d.strokeWidthPx ? d.strokeWidthPx : 0;
        const transformed = !!(d.skew || (d.stretch && d.stretch !== 1));
        if (transformed) {
          cx.save();
          if (d.skew) cx.transform(1, 0, -d.skew, 1, d.skew * d.baseY, 0);
          if (d.stretch && d.stretch !== 1) cx.transform(d.stretch, 0, 0, 1, d.x * (1 - d.stretch), 0);
        }
        if (d.renderMode !== 1) cx.fillText(d.ch, d.x, d.baseY);
        if (strokeW > 0) {
          cx.strokeStyle = d.strokeColor || d.color;
          cx.lineWidth = strokeW;
          cx.strokeText(d.ch, d.x, d.baseY);
        }
        if (transformed) cx.restore();
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

  /** @param {number} i */
  const setCaret = (i) => {
    if (!st) return;
    st.caret = Math.max(0, Math.min(st.text.length, i));
    restartBlink();
    draw();
  };

  const pushUndo = () => {
    if (!st) return;
    st.undoStack.push({
      text: st.text, caret: st.caret, styleOv: new Map(st.styleOv), wordBase: new Map(st.wordBase),
    });
    if (st.undoStack.length > 200) st.undoStack.shift();
    st.redoStack.length = 0;
  };

  /**
   * Shift the per-word toggle and base maps across a text edit at `pos` that removed `removedLen` characters.
   * Words the edit touched collapse to the tokens now spanning that region and inherit the first touched word's state.
   * @param {string} oldText
   * @param {string} newText
   * @param {number} pos
   * @param {number} removedLen
   */
  const remapWordMaps = (oldText, newText, pos, removedLen) => {
    if (!st || (st.styleOv.size === 0 && st.wordBase.size === 0)) return;
    const oldSpans = tokenSpans(oldText);
    const newSpans = tokenSpans(newText);
    const endPos = pos + removedLen;
    let wA = oldSpans.length;
    let wB = -1;
    for (let k = 0; k < oldSpans.length; k++) {
      if (oldSpans[k][1] >= pos && oldSpans[k][0] <= endPos) {
        wA = Math.min(wA, k);
        wB = Math.max(wB, k);
      }
    }
    const delta = newSpans.length - oldSpans.length;
    /**
     * @template T
     * @param {Map<number, T>} map
     */
    const remapOne = (map) => {
      /** @type {Map<number, T>} */
      const next = new Map();
      for (const [k, v] of map) {
        if (k < wA) next.set(k, v);
        else if (wB < 0 || k > wB) next.set(k + delta, v);
        else if (k === wA) {
          for (let t = wA; t <= wB + delta && t < newSpans.length; t++) {
            if (!next.has(t)) next.set(t, v);
          }
        }
      }
      return next;
    };
    st.styleOv = remapOne(st.styleOv);
    st.wordBase = remapOne(st.wordBase);
  };

  /**
   * Toggle bold/italic on the words under the selection (or the caret's word), word-processor style.
   * A style baked into the word's face cannot toggle off; such words are left unchanged.
   * @param {'bold'|'italic'} prop
   */
  const toggleWordStyle = (prop) => {
    if (!st) return;
    const s = st;
    const spans = tokenSpans(s.text);
    if (spans.length === 0) return;
    const sel = selRange();
    /** @type {Array<number>} */
    const targets = [];
    if (sel) {
      for (let k = 0; k < spans.length; k++) if (spans[k][0] < sel[1] && spans[k][1] > sel[0]) targets.push(k);
    } else {
      let k = spans.findIndex((sp2) => sp2[0] <= s.caret && s.caret <= sp2[1]);
      if (k === -1) {
        for (let j = spans.length - 1; j >= 0; j--) if (spans[j][1] < s.caret) { k = j; break; }
      }
      targets.push(k === -1 ? 0 : k);
    }
    /** @param {number} k */
    const base = (k) => s.wordBase.get(k) || {
      bold: false, italic: false, stroked: false, skewed: false,
    };
    /** @param {number} k */
    const eff = (k) => {
      const o = s.styleOv.get(k);
      return o && o[prop] !== undefined ? !!o[prop] : !!base(k)[prop];
    };
    // Any word lacking the style means the first press applies it to all.
    const target = targets.some((k) => !eff(k));
    pushUndo();
    for (const k of targets) {
      const b = base(k);
      /** @type {WordToggle} */
      const o = { ...(s.styleOv.get(k) || {}) };
      if (target === !!b[prop]) delete o[prop];
      else if (target) o[prop] = true;
      else if (prop === 'bold' ? b.stroked : b.skewed) o[prop] = false;
      else delete o[prop];
      if (o.bold === undefined && o.italic === undefined) s.styleOv.delete(k);
      else s.styleOv.set(k, o);
    }
    draw();
  };

  /** @param {string} chunk */
  const insertText = (chunk) => {
    if (!st) return;
    const clean = chunk.replace(/[\r\n\t]/g, ' ');
    if (!clean) return;
    pushUndo();
    const sel = selRange();
    const before = st.text;
    if (sel) {
      st.text = st.text.slice(0, sel[0]) + clean + st.text.slice(sel[1]);
      st.caret = sel[0] + clean.length;
      st.selAnchor = null;
      remapWordMaps(before, st.text, sel[0], sel[1] - sel[0]);
    } else {
      st.text = st.text.slice(0, st.caret) + clean + st.text.slice(st.caret);
      remapWordMaps(before, st.text, st.caret, 0);
      st.caret += clean.length;
    }
    restartBlink();
    draw();
    ensureGlyphSetForText(clean)
      .then((widened) => { if (widened) draw(); })
      .catch((e) => console.error('Edit Text: wider glyph set failed to load:', e));
  };

  /** @param {[number, number]} sel */
  const deleteRange = (sel) => {
    if (!st) return;
    pushUndo();
    const before = st.text;
    st.text = st.text.slice(0, sel[0]) + st.text.slice(sel[1]);
    st.caret = sel[0];
    st.selAnchor = null;
    remapWordMaps(before, st.text, sel[0], sel[1] - sel[0]);
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
    fieldOn = false;
    if (st) st.selAnchor = null;
    draw();
    hiddenInput.remove();
    document.removeEventListener('pointerdown', onDocPointerdown, true);
    if (onOpenChanged) onOpenChanged(false);
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
      line, n, text, origText, styleOv,
    } = st;
    const hasToggles = [...styleOv.values()].some((o) => o.bold !== undefined || o.italic !== undefined);
    if ((text.trim() === origText || text.trim() === origText.trim()) && !hasToggles) {
      close();
      return;
    }
    const wordStyles = hasToggles
      ? tokenSpans(text).map((value, k) => {
        const o = styleOv.get(k);
        return o && (o.bold !== undefined || o.italic !== undefined) ? o : null;
      })
      : null;
    detachInput();
    st = null;
    // A newer session may have opened on this page while replaceTextLine ran and now owns the rects.
    // Clearing them would redraw that session's original text under its editor.
    const ownedElsewhere = () => !!st && st.n === n;
    try {
      const res = await scribe.doc.replaceTextLine(line, text, wordStyles ? { wordStyles } : undefined);
      if (!ownedElsewhere()) scribe.doc.images.setEphemeralEditRects(n, null);
      if (res && onCommitted) onCommitted(res.pages);
      else scribe.refreshPageRaster(n);
      removeCanvasAfterRefresh(n);
    } catch (e) {
      if (!ownedElsewhere()) scribe.doc.images.setEphemeralEditRects(n, null);
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
        to.push({
          text: st.text, caret: st.caret, styleOv: new Map(st.styleOv), wordBase: new Map(st.wordBase),
        });
        st.text = prev.text;
        st.caret = prev.caret;
        st.styleOv = new Map(prev.styleOv);
        st.wordBase = new Map(prev.wordBase);
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
    if (mod && ['b', 'B', 'i', 'I'].includes(ev.key)) {
      ev.preventDefault();
      toggleWordStyle(ev.key === 'b' || ev.key === 'B' ? 'bold' : 'italic');
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
        const before = st.text;
        st.text = st.text.slice(0, st.caret - 1) + st.text.slice(st.caret);
        st.caret -= 1;
        remapWordMaps(before, st.text, st.caret, 1);
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
        const before = st.text;
        st.text = st.text.slice(0, st.caret) + st.text.slice(st.caret + 1);
        remapWordMaps(before, st.text, st.caret, 1);
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

  /**
   * @param {EditSession} session
   * @param {number} clientX
   * @param {number} clientY
   */
  const slotAtClient = (session, clientX, clientY) => {
    // clientToPage would resolve the page from the pointer, so a drag running past this page's edge would re-base onto its neighbor.
    const c = scribe.clientToContent(clientX, clientY);
    const local = scribe.pageToLocal(session.n, session.orientation,
      c.x - scribe._pageLeft(session.n), c.y - scribe.getPageStop(session.n));
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < session.xs.length; i++) {
      const d = Math.abs(local.x - session.xs[i]);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  };

  // Repeat clicks are counted manually because preventing the pointerdown's default suppresses dblclick events.
  let lastCanvasDown = {
    t: -1e9, x: 0, y: 0, count: 0,
  };
  const onCanvasPointerdown = (ev) => {
    if (!st || !containsPoint(ev.clientX, ev.clientY)) return;
    ev.stopPropagation();
    ev.preventDefault();
    const repeat = ev.timeStamp - lastCanvasDown.t < 420
      && Math.hypot(ev.clientX - lastCanvasDown.x, ev.clientY - lastCanvasDown.y) < 4;
    const count = repeat ? Math.min(lastCanvasDown.count + 1, 3) : 1;
    lastCanvasDown = {
      t: ev.timeStamp, x: ev.clientX, y: ev.clientY, count,
    };
    hiddenInput.focus({ preventScroll: true });
    const session = st;

    /**
     * An offset grown out to the click count's unit, which is the character itself, its word, or the whole line.
     * @param {number} off
     * @returns {{start: number, end: number}}
     */
    const unit = (off) => {
      const { text } = session;
      if (count === 1) return { start: off, end: off };
      if (count === 3) return { start: 0, end: text.length };
      let i = Math.max(0, Math.min(off, text.length - 1));
      if (text[i] === ' ' && i > 0 && text[i - 1] !== ' ') i -= 1;
      let a = i;
      let b = i;
      while (a > 0 && text[a - 1] !== ' ') a -= 1;
      while (b < text.length && text[b] !== ' ') b += 1;
      return { start: a, end: b };
    };

    const anchor = slotAtClient(session, ev.clientX, ev.clientY);
    /** @param {number} focus */
    const select = (focus) => {
      const a = unit(anchor);
      const f = unit(focus);
      const start = focus >= anchor ? a.start : f.start;
      const end = focus >= anchor ? f.end : a.end;
      if (start === end) {
        session.selAnchor = null;
        session.caret = start;
        return;
      }
      // The caret rides the end the pointer is on, so a later shift+arrow extends from where the drag stopped.
      session.selAnchor = focus >= anchor ? start : end;
      session.caret = focus >= anchor ? end : start;
    };

    select(anchor);
    restartBlink();
    draw();
    /** @param {PointerEvent} mv */
    const onMove = (mv) => {
      // A session that opened mid-drag must not receive writes from this one.
      if (st !== session) return;
      select(slotAtClient(session, mv.clientX, mv.clientY));
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
    // The phone's editing toolbar acts on the open session, so its presses must not read as clicking away.
    if (ev.target instanceof Element && ev.target.closest('.scribe-edit-text-tools')) return;
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
   * @param {?number} clientX - Null for a keyboard-initiated open.
   * @param {?number} clientY
   * @param {{caretEnd?: boolean}} [openOpts] - Place the caret at the end, for keyboard-initiated opens.
   */
  const open = async (info, clientX, clientY, openOpts = {}) => {
    if (st) await commit();
    const { line, n, orientation } = info;
    const page = line.page;
    const dims = page.dims;
    const nt = nativeTextForPage(scribe.doc, page);

    /** @type {Map<number|undefined, {program: ?import('../../js/pdf/glyphResolve.js').EditFontProgram, faceName: ?string}>} */
    const fonts = new Map();
    for (const w of line.words) {
      const f = nt[w.id]?.fontObjNum;
      if (!fonts.has(f)) fonts.set(f, (await scribe.doc.images.getEditFont(n, f)) || { program: null, faceName: null });
    }

    const baselineY = line.bbox.bottom + (line.baseline?.[1] || 0);
    /**
     * @type {Array<{ch: string, x0: number, x1: number, size: number, baseY: number, face: string,
     *   color: string, tofu?: boolean, lig?: string, ligMember?: boolean, fontStyle?: string,
     *   fontWeight?: string, skew?: number, stretch?: number, renderMode?: number,
     *   strokeWidthPx?: number, strokeColor?: string}>}
     */
    const origChars = [];
    let origText = '';
    for (let wi = 0; wi < line.words.length; wi++) {
      const w = line.words[wi];
      const size = w.style.size || Math.abs(w.bbox.bottom - w.bbox.top) / 0.75;
      const wNt = nt[w.id];
      const baseY = wNt?.baselineY ?? baselineY;
      const color = w.style.color || '#000000';
      const ef = fonts.get(wNt?.fontObjNum);
      const wStroked = !!(wNt && (wNt.renderMode === 1 || wNt.renderMode === 2) && wNt.strokeWidthPx);
      if (wi > 0) {
        const prev = line.words[wi - 1];
        origChars.push({
          ch: ' ', x0: prev.bbox.right, x1: w.bbox.left, size, baseY, face: '', color,
        });
        origText += ' ';
      }
      // A faux-bold word's boldness is its stroke, so substitute faces pick weight from the font's own flag; a bold substitute plus the stroke would double-bold.
      const wResolveStyle = wStroked && !ef?.program?.bold && w.style.bold ? { ...w.style, bold: false } : w.style;
      const wStroke = wStroked && wNt
        ? { renderMode: wNt.renderMode, strokeWidthPx: wNt.strokeWidthPx, strokeColor: wNt.strokeColor }
        : {};
      // An embedded face carries its style in its glyphs, so the italic/bold keywords go only on a fallback face.
      const charFace = (ch) => {
        let face = ef.faceName;
        let tofu = false;
        let fontStyle = '';
        let fontWeight = '';
        // A subset face has only the glyphs this document drew with it, so a character its program cannot map falls back to a substitute.
        const prog = ef?.program;
        if (face && prog && resolveReplacementChar(ch, prog, wResolveStyle).kind !== 'orig') face = null;
        if (!face) {
          const r = resolveReplacementChar(ch, ef.program, wResolveStyle);
          if (r.kind === 'tofu') tofu = true;
          else {
            face = r.fontFaceName || r.family;
            if (wResolveStyle.italic) fontStyle = 'italic';
            if (wResolveStyle.bold) fontWeight = 'bold';
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
              ...wStroke,
            });
            origText += seg;
            continue;
          }
          // A ligature the original font still maps draws as one glyph on the first letter's entry.
          // The rest of its entries only hold caret positions.
          const ligCh = ocr.ligatureForText(entries[ei].text);
          const ligOk = !!(ligCh && ef.faceName
            && resolveReplacementChar(ligCh, ef.program, wResolveStyle).kind === 'orig');
          for (let j = 0; j < seg.length; j++) {
            const x0 = pen + ((eb.right - pen) * j) / seg.length;
            const x1 = pen + ((eb.right - pen) * (j + 1)) / seg.length;
            const f = ligOk ? {
              face: ef.faceName, tofu: false, fontStyle: '', fontWeight: '',
            } : charFace(seg[j]);
            /** @type {(typeof origChars)[number]} */
            const entry = {
              ch: seg[j],
              x0,
              x1,
              size,
              baseY,
              face: f.face || '',
              color,
              tofu: f.tofu,
              fontStyle: f.fontStyle,
              fontWeight: f.fontWeight,
              skew: wSkew?.[ei] || 0,
              stretch: wStretch?.[ei] || 0,
              ...wStroke,
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
          const r = resolveReplacementChar(ch, ef.program, wResolveStyle);
          const x0 = cxPos;
          const x1 = cxPos + r.advEm * size;
          cxPos = x1;
          const f = charFace(ch);
          origChars.push({
            ch, x0, x1, size, baseY, face: f.face, color, tofu: f.tofu, fontStyle: f.fontStyle, fontWeight: f.fontWeight, ...wStroke,
          });
          origText += ch;
        }
      }
    }

    /** @type {Array<WordMid>} */
    const wordMids = line.words.map((w) => {
      const wSize = w.style.size || Math.abs(w.bbox.bottom - w.bbox.top) / 0.75;
      const e = nt[w.id];
      const wf = fonts.get(e?.fontObjNum);
      const stroked = !!(e && (e.renderMode === 1 || e.renderMode === 2) && e.strokeWidthPx);
      const wStyle = stroked && !wf?.program?.bold && w.style.bold ? { ...w.style, bold: false } : w.style;
      const wsp = resolveReplacementChar(' ', wf?.program || null, wStyle);
      return {
        program: wf?.program || null,
        style: wStyle,
        size: wSize,
        color: w.style.color || '#000000',
        face: wf?.faceName || '',
        spaceAdvPx: (wsp.kind === 'tofu' ? 0.25 : wsp.advEm) * wSize,
        renderMode: stroked && e ? e.renderMode : undefined,
        strokeWidthPx: stroked && e ? e.strokeWidthPx : undefined,
        strokeColor: stroked && e ? e.strokeColor : undefined,
        skew: e?.skew?.find((v) => v) || undefined,
      };
    });
    const sfSize = wordMids[0].size;

    // Base style state per word, so live toggles know each word's current state and what can toggle off.
    /** @type {Map<number, WordBase>} */
    const wordBase = new Map();
    line.words.forEach((w, k) => {
      const e = nt[w.id];
      wordBase.set(k, {
        bold: !!w.style.bold,
        italic: !!w.style.italic,
        stroked: !!(e && (e.renderMode === 1 || e.renderMode === 2) && e.strokeWidthPx),
        skewed: !!(e && e.skew && e.skew.some((v) => v)),
      });
    });

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
    // Quarter turns from the group's rotation, with its skew term dropped because skew never swaps axes.
    const q = ((orientation + Math.round((scribe.doc.pageMetrics[n].rotation || 0) / 90)) % 4 + 4) % 4;
    /**
     * A client rect read on the group's local axes.
     * `left`/`top` are the edges local x and y start at, negated where that axis runs against its screen axis.
     * @param {DOMRect} r
     */
    const localRect = (r) => ({
      left: q === 0 ? r.left : q === 1 ? r.top : q === 2 ? -r.right : -r.bottom,
      top: q === 0 ? r.top : q === 1 ? -r.right : q === 2 ? -r.bottom : r.left,
      width: q % 2 === 1 ? r.height : r.width,
      height: q % 2 === 1 ? r.width : r.height,
    });
    const grect = localRect(group.getBoundingClientRect());
    // The raster renders at a rounded integer width with compensated CSS, so ideal zoom coordinates drift from its real frame by up to a pixel across the page.
    // It is a child of the page container and stays on the screen axes while the group is rotated.
    const rr = rasterEl && rasterEl.width > 0 ? localRect(rasterEl.getBoundingClientRect()) : grect;
    const guxR = rr.width / unitsW;
    const guyR = rr.height / unitsH;
    const gux = grect.width / unitsW;
    const guy = grect.height / unitsH;
    // Draw at the raster's backing density while the compositor upscales it.
    // Its glyph rows are quantized to that grid.
    const bsY = rasterEl && rasterEl.width > 0 ? (q % 2 === 1 ? rasterEl.width : rasterEl.height) / unitsH : 0;
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
      styleFromChar: wordMids[0],
      wordMids,
      caret: 0,
      selAnchor: null,
      xs: new Float64Array(origText.length + 1),
      ys: new Float64Array(origText.length + 1),
      styleOv: new Map(),
      wordBase,
      undoStack: [],
      redoStack: [],
      composing: false,
    };

    const pt = clientX != null && clientY != null ? scribe.textSel?.pointAt?.(clientX, clientY) : null;
    const off = pt && pt.n === n ? pt.off - info.start : 0;
    st.caret = Math.max(0, Math.min(origText.length, off));
    if (openOpts.caretEnd) st.caret = origText.length;

    const rects = line.words.map((w) => wordBandRect(w.bbox, w.chars, orientation, dims));
    // The open line's identities keep the ephemeral suppression from blanking visually-overlapping other text.
    const glyphs = glyphIdentitiesForWords(nativeTextForPage(scribe.doc, line.page), line.words, orientation, dims);
    scribe.doc.images.setEphemeralEditRects(n, rects, glyphs);
    scribe.refreshPageRaster(n);

    document.addEventListener('pointerdown', onDocPointerdown, true);
    hiddenInput.value = '';
    hiddenInput.focus({ preventScroll: true });
    fieldOn = true;
    restartBlink();
    draw();
    if (onOpenChanged) onOpenChanged(true);
  };

  return {
    open,
    isOpen: () => !!st,
    lineOpen: () => st?.line || null,
    containsPoint,
    commit,
    revert: close,
    teardown: close,
    toggleStyle: toggleWordStyle,
  };
}
