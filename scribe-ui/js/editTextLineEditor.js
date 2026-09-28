/**
 * The Edit Text mode's live line editor.
 * A per-line canvas overlay draws the line being edited while the page raster re-renders with that line suppressed.
 * The glyphs it draws come from the worker, which plans the edit as a commit would and reports where the rewritten operators put each glyph.
 */
import { ensureGlyphSetForText } from '../../js/fontContainerMain.js';
import { GlobalFonts } from '../../js/containers/fontContainer.js';
import ocr from '../../js/objects/ocrObjects.js';
import { resolveReplacementChar } from '../../js/pdf/glyphResolve.js';
import { nativeTextForPage } from '../../js/textEdits.js';

/** @typedef {import('../../js/objects/ocrObjects.js').OcrLine} OcrLine */

/**
 * One word of the previewed line.
 * `oldId` is the id of the page word it continues, or null for a word the edit inserted.
 * @typedef {{ text: string, oldId: ?string, glyphs: Array<LineGlyph> }} PreviewWord
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
 * @property {number} lineStartX - The pen of the line's first glyph, where the caret of an empty line sits.
 * @property {string} text
 * @property {string} origText
 * @property {Array<PreviewWord>} words - The line as the worker last previewed it.
 * @property {string} wordsText - The text `words` previews; `text` runs a keystroke ahead of it while a preview is in flight.
 * @property {Array<PreviewWord>} origWords - The line as the page draws it, which a closed session shows again.
 * @property {Map<number|undefined, {program: ?import('../../js/pdf/glyphResolve.js').EditFontProgram, faceName: ?string}>} fonts - The page fonts the glyphs draw with, by font object number.
 * @property {boolean} previewBusy
 * @property {boolean} previewStale - The text or toggles changed while a preview was in flight.
 * @property {?Promise<void>} [previewDone] - Settles when the preview in flight has been drawn.
 * @property {number} caret
 * @property {?number} selAnchor
 * @property {Float64Array} xs - Local x of each caret slot.
 * @property {Float64Array} ys - Baseline y of each caret slot.
 * @property {Float64Array} [szs] - Font size at each caret slot.
 * @property {Map<number, WordToggle>} styleOv - Live style toggles keyed by word index of `text`.
 * @property {Map<number, WordBase>} wordBase - Each word's pre-edit style state, remapped alongside `styleOv`.
 * @property {Array<EditSnapshot>} undoStack
 * @property {Array<EditSnapshot>} redoStack
 * @property {boolean} composing
 * @property {?string} [previewInk]
 * @property {?Set<number>} [previewWords] - Word indices of `text` that `previewInk` draws on.
 */

/** @typedef {{bold?: boolean, italic?: boolean, color?: string}} WordToggle */
/** @typedef {{bold: boolean, italic: boolean, stroked: boolean, skewed: boolean, color: string}} WordBase */
/** @typedef {{text: string, caret: number, styleOv: Map<number, WordToggle>, wordBase: Map<number, WordBase>}} EditSnapshot */

/**
 * The canvas font of a drawn glyph.
 * @param {{ face: string, size: number, fontStyle?: string, fontWeight?: string }} d
 */
const fontOf = (d) => `${d.fontStyle || 'normal'} ${d.fontWeight || 'normal'} ${d.size}px ${/[",]/.test(d.face) ? d.face : `"${d.face}"`}`;

/** @type {?CanvasRenderingContext2D} */
let measureCtx = null;

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
 * @param {{onCommitted?: (pages: Array<number>) => void, onOpenChanged?: (open: boolean) => void,
 *   onRangeSelected?: (clientX: number, clientY: number) => void, onCaretChanged?: () => void}} [hooks]
 *   `onRangeSelected` fires when a pointer drag ends on a non-empty range.
 *   `onCaretChanged` fires after every redraw.
 */
export function createLineEditor(scribe, {
  onCommitted, onOpenChanged, onRangeSelected, onCaretChanged,
} = {}) {
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

  /**
   * The canvas face a glyph's character draws with.
   * An embedded font draws with its own face, and a character its subset lacks takes a built-in face.
   * Every glyph of a font the file does not embed takes a built-in face fitted to the declared width.
   * @param {EditSession} s
   * @param {LineGlyph} g
   * @param {string} ch - The character drawn, one of the glyph's when a ligature is drawn letter by letter.
   * @param {{ bold?: boolean, italic?: boolean }} hints
   * @returns {{ face: string, fontStyle: string, fontWeight: string, tofu: boolean, fitted: boolean, stretch?: number }}
   */
  const faceOf = (s, g, ch, hints) => {
    if (g.face) {
      const raw = GlobalFonts.raw?.[g.face.family];
      const f = raw?.[g.face.styleKey] || raw?.normal;
      if (f) {
        return {
          face: f.fontFaceName, fontStyle: f.fontFaceStyle || '', fontWeight: f.fontFaceWeight || '', tofu: false, fitted: false,
        };
      }
      return {
        face: g.face.family,
        fontStyle: /talic/.test(g.face.styleKey) ? 'italic' : '',
        fontWeight: /^bold/.test(g.face.styleKey) ? 'bold' : '',
        tofu: false,
        fitted: false,
      };
    }
    const ef = s.fonts.get(g.fontObjNum ?? undefined);
    // Some fonts map their visible hyphen glyph to a soft hyphen (U+00AD), which a canvas draws as nothing.
    const drawn = ch === '­' ? '-' : ch;
    if (ef?.faceName && ef.program && resolveReplacementChar(drawn, ef.program, hints).kind === 'orig') {
      return {
        face: ef.faceName, fontStyle: '', fontWeight: '', tofu: false, fitted: false,
      };
    }
    const r = resolveReplacementChar(drawn, ef?.program || null, hints);
    if (r.kind === 'tofu') {
      return {
        face: '', fontStyle: '', fontWeight: '', tofu: true, fitted: false,
      };
    }
    const sub = r.kind === 'builtIn' ? r : null;
    // The resolver's variant can differ from the hints when the font's name carries a weight or the hinted variant is not loaded.
    // The canvas must name the variant the resolver measured.
    return {
      face: (sub ? sub.fontFaceName || sub.family : ef?.faceName) || '',
      fontStyle: sub ? sub.fontFaceStyle : (hints.italic ? 'italic' : ''),
      fontWeight: sub ? sub.fontFaceWeight : (hints.bold ? 'bold' : ''),
      tofu: false,
      fitted: !ef?.program?.font,
      stretch: sub && sub.stretch !== 1 ? sub.stretch : undefined,
    };
  };

  /**
   * @typedef {{ch: string, x: number, w: number, size: number, baseY: number, face: string, tofu?: boolean, color: string, fontStyle?: string,
   *   fontWeight?: string, skew?: number, stretch?: number, renderMode?: number, strokeWidthPx?: number, strokeColor?: string}} Draw
   */

  /**
   * Caret slots and draws for the session's previewed words.
   * @param {EditSession} s
   */
  const layout = (s) => {
    const {
      text, words, wordsText,
    } = s;
    const wlen = wordsText.length;
    const xsW = new Float64Array(wlen + 1);
    const ysW = new Float64Array(wlen + 1);
    const szW = new Float64Array(wlen + 1);
    /** @type {Array<Draw>} */
    const draws = [];
    const gaps = [];
    for (let k = 1; k < words.length; k++) {
      const prev = words[k - 1].glyphs;
      const cur = words[k].glyphs;
      if (prev.length > 0 && cur.length > 0) gaps.push(cur[0].penX - (prev[prev.length - 1].penX + prev[prev.length - 1].widthPx));
    }
    gaps.sort((a, b) => a - b);
    const gap = gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : s.size * 0.25;
    const spans = tokenSpans(wordsText);
    let x = s.lineStartX;
    let y = s.baselineY;
    let size = s.size;
    let i = 0;
    for (let k = 0; k < spans.length && k < words.length; k++) {
      const [a, b] = spans[k];
      const w = words[k];
      if (w.glyphs.length === 0) continue;
      const first = w.glyphs[0];
      const last = w.glyphs[w.glyphs.length - 1];
      const pageWord = (w.oldId ? s.line.words.find((pw) => pw.id === w.oldId) : null) || s.line.words[0];
      const style = pageWord ? pageWord.style : {};
      // A word bold by a stroke rather than by its font takes the regular weight, since its glyphs already draw with the stroke.
      const hints = first.renderMode && !s.fonts.get(first.fontObjNum ?? undefined)?.program?.bold && style.bold ? { ...style, bold: false } : style;
      for (let j = 0, n = a - i; i < a; i++, j++) {
        xsW[i] = x + ((first.penX - x) * j) / n;
        ysW[i] = y;
        szW[i] = size;
      }
      const cells = w.glyphs.map((g) => ({ g, n: Math.max(1, ocr.replaceLigatures(g.text).length) }));
      if (cells.reduce((acc, c) => acc + c.n, 0) === b - a) {
        for (const { g, n } of cells) {
          for (let j = 0; j < n; j++, i++) {
            xsW[i] = g.penX + (g.widthPx * j) / n;
            ysW[i] = g.penY;
            szW[i] = g.sizePx;
          }
        }
      } else {
        const end = last.penX + last.widthPx;
        for (let j = 0; i < b; i++, j++) {
          xsW[i] = first.penX + ((end - first.penX) * j) / (b - a);
          ysW[i] = first.penY;
          szW[i] = first.sizePx;
        }
      }
      for (const g of w.glyphs) {
        const letters = ocr.replaceLigatures(g.text);
        const whole = faceOf(s, g, g.text, hints);
        // A substitute face can lack the ligature glyph, so such a ligature draws letter by letter across its width.
        const pieces = letters.length > 1 && (whole.tofu || whole.fitted || !whole.face)
          ? [...letters].map((ch, j) => ({
            ch, x: g.penX + (g.widthPx * j) / letters.length, w: g.widthPx / letters.length, f: faceOf(s, g, ch, hints),
          }))
          : [{
            ch: g.text, x: g.penX, w: g.widthPx, f: whole,
          }];
        for (const p of pieces) {
          let stretch = g.stretch || p.f.stretch;
          // A substitute face for a font the file does not embed is fitted glyph by glyph to the declared width, as the raster draws it.
          if (p.f.fitted && !g.widthsUnreliable) {
            stretch = g.stretch || undefined;
            if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
            if (measureCtx && p.f.face && p.w > 0) {
              measureCtx.font = fontOf({
                face: p.f.face, size: g.sizePx, fontStyle: p.f.fontStyle, fontWeight: p.f.fontWeight,
              });
              const scale = p.w / measureCtx.measureText(p.ch).width;
              // The raster draws a glyph unscaled when the fit would stretch it past double.
              if (scale > 0 && scale <= 2 && Math.abs(scale - 1) >= 1e-3) stretch = scale;
            }
          }
          draws.push({
            ch: p.ch,
            x: p.x,
            w: p.w,
            size: g.sizePx,
            baseY: g.penY,
            face: p.f.face,
            tofu: p.f.tofu,
            color: g.fillColor,
            fontStyle: p.f.fontStyle,
            fontWeight: p.f.fontWeight,
            skew: g.skew || undefined,
            stretch,
            renderMode: g.renderMode,
            strokeWidthPx: g.strokeWidthPx,
            strokeColor: g.strokeColor,
          });
        }
      }
      x = last.penX + last.widthPx;
      y = last.penY;
      size = last.sizePx;
    }
    for (; i <= wlen; i++, x += gap) {
      xsW[i] = x;
      ysW[i] = y;
      szW[i] = size;
    }
    // The live text can run a keystroke ahead of the preview; its extra characters share the last slot until the preview catches up.
    const len = text.length;
    const xs = new Float64Array(len + 1);
    const ys = new Float64Array(len + 1);
    const szs = new Float64Array(len + 1);
    for (let j = 0; j <= len; j++) {
      const k = Math.min(j, wlen);
      xs[j] = xsW[k];
      ys[j] = ysW[k];
      szs[j] = szW[k];
    }
    return {
      draws, xs, ys, szs,
    };
  };

  /**
   * Ask the worker where the line's glyphs land for the session's text and toggles, and redraw when it answers.
   * A change made while a request is in flight is sent when the answer arrives.
   */
  const requestPreview = () => {
    if (!st) return;
    if (st.previewBusy) { st.previewStale = true; return; }
    const s = st;
    const { text } = s;
    const newTexts = text.trim().split(/\s+/).filter((t) => t.length > 0);
    if (newTexts.length === 0) {
      s.words = [];
      s.wordsText = text;
      return;
    }
    s.previewBusy = true;
    s.previewStale = false;
    // The typing history's length when this text was captured; the entry below it is the state before the change that produced the text.
    const depth = s.undoStack.length;
    const nt = nativeTextForPage(scribe.doc, s.line.page);
    const styles = newTexts.map((t, k) => {
      const o = s.styleOv.get(k);
      const ink = s.previewInk && s.previewWords?.has(k) ? s.previewInk : o?.color;
      /** @type {{ color?: string, bold?: boolean, italic?: boolean }} */
      const style = {};
      if (ink) style.color = ink;
      if (o?.bold !== undefined) style.bold = o.bold;
      if (o?.italic !== undefined) style.italic = o.italic;
      return Object.keys(style).length > 0 ? style : null;
    });
    /** @type {import('../../js/pdf/textPatch.js').TextEditRequest} */
    const req = {
      kind: 'replace',
      words: s.line.words.map((w) => ({
        id: w.id, text: w.text, penX: nt[w.id]?.penX || [], baselineY: nt[w.id]?.baselineY,
      })),
      newTexts,
      styles,
    };
    s.previewDone = scribe.doc.images.previewTextEdit(s.n, req).then(async (/** @type {TextEditPreview} */ res) => {
      if (st !== s) return;
      if (res.words) {
        for (const w of res.words) {
          for (const g of w.glyphs) {
            const f = g.fontObjNum ?? undefined;
            if (g.face || s.fonts.has(f)) continue;
            s.fonts.set(f, (await scribe.doc.images.getEditFont(s.n, f)) || { program: null, faceName: null });
          }
        }
        if (st !== s) return;
        s.words = res.words;
        s.wordsText = text;
        return;
      }
      // The commit would refuse this text too, so the change that produced it is undone along with any change typed on top of it.
      const back = depth > 0 ? s.undoStack[depth - 1] : null;
      if (back) {
        s.text = back.text;
        s.caret = back.caret;
        s.selAnchor = null;
        s.styleOv = new Map(back.styleOv);
        s.wordBase = new Map(back.wordBase);
        s.undoStack.length = depth - 1;
        // The state typed back to may itself never have been previewed, when its keystrokes coalesced into the refused request.
        s.previewStale = s.text !== s.wordsText;
      }
    }).catch((e) => console.error('Edit Text: preview failed:', e)).finally(() => {
      if (st !== s) return;
      s.previewBusy = false;
      draw();
      if (s.previewStale) requestPreview();
    });
  };

  /** @returns {?[number, number]} */
  const selRange = () => {
    if (!st || st.selAnchor == null || st.selAnchor === st.caret) return null;
    return st.selAnchor < st.caret ? [st.selAnchor, st.caret] : [st.caret, st.selAnchor];
  };

  const draw = () => {
    if (!st) return;
    if (onCaretChanged) onCaretChanged();
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
        cx.font = fontOf(d);
        cx.fillStyle = d.color;
        // Faux-bold chars re-stroke the outlines like the raster (mode 2 fills then strokes; mode 1 strokes only).
        const strokeW = (d.renderMode === 1 || d.renderMode === 2) && d.strokeWidthPx ? d.strokeWidthPx : 0;
        const transformed = !!(d.skew || (d.stretch && d.stretch !== 1));
        if (transformed) {
          cx.save();
          if (d.skew) cx.transform(1, 0, -d.skew, 1, d.skew * d.baseY, 0);
          if (d.stretch && d.stretch !== 1) cx.transform(d.stretch, 0, 0, 1, d.x * (1 - d.stretch), 0);
        }
        // Some fonts map their visible hyphen glyph to a soft hyphen (U+00AD), which a canvas draws as nothing.
        const shown = d.ch === '\u00ad' ? '-' : d.ch;
        if (d.renderMode !== 1) cx.fillText(shown, d.x, d.baseY);
        if (strokeW > 0) {
          cx.strokeStyle = d.strokeColor || d.color;
          cx.lineWidth = strokeW;
          cx.strokeText(shown, d.x, d.baseY);
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
   * Step the session's typing-level history one entry backward or forward.
   * @param {boolean} redo
   * @returns {boolean} Whether a step was applied.
   */
  const stepHistory = (redo) => {
    if (!st) return false;
    const from = redo ? st.redoStack : st.undoStack;
    const to = redo ? st.undoStack : st.redoStack;
    const prev = from.pop();
    if (!prev) return false;
    to.push({
      text: st.text, caret: st.caret, styleOv: new Map(st.styleOv), wordBase: new Map(st.wordBase),
    });
    st.text = prev.text;
    st.caret = prev.caret;
    st.styleOv = new Map(prev.styleOv);
    st.wordBase = new Map(prev.wordBase);
    st.selAnchor = null;
    restartBlink();
    requestPreview();
    draw();
    return true;
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
   * The words a style action targets: those under the selection, else the caret's word.
   * @param {EditSession} s
   * @returns {Array<number>}
   */
  const targetWords = (s) => {
    const spans = tokenSpans(s.text);
    if (spans.length === 0) return [];
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
    return targets;
  };
  /**
   * @param {EditSession} s
   * @param {number} k
   * @returns {WordBase}
   */
  const baseOf = (s, k) => s.wordBase.get(k) || {
    bold: false, italic: false, stroked: false, skewed: false, color: '#000000',
  };

  /**
   * The bold / italic state of the words a toggle would act on: on when every word has it, locked when the style is baked into every word's face.
   * @param {'bold'|'italic'} prop
   */
  const wordStyleState = (prop) => {
    if (!st) return { present: false, on: false, locked: false };
    const s = st;
    const targets = targetWords(s);
    if (targets.length === 0) return { present: false, on: false, locked: false };
    const eff = (k) => {
      const o = s.styleOv.get(k);
      return o && o[prop] !== undefined ? !!o[prop] : !!baseOf(s, k)[prop];
    };
    const on = targets.every(eff);
    const locked = on && targets.every((k) => {
      const b = baseOf(s, k);
      const o = s.styleOv.get(k);
      return b[prop] && (!o || o[prop] === undefined) && !(prop === 'bold' ? b.stroked : b.skewed);
    });
    return { present: true, on, locked };
  };
  /** The ink of the words a color action would act on. */
  const wordColorState = () => {
    if (!st) return { present: false, color: null, mixed: false };
    const s = st;
    const targets = targetWords(s);
    if (targets.length === 0) return { present: false, color: null, mixed: false };
    const inks = [...new Set(targets.map((k) => s.styleOv.get(k)?.color || baseOf(s, k).color))];
    return { present: true, color: inks[0], mixed: inks.length > 1 };
  };
  /**
   * Set the ink of the words under the selection (or the caret's word); one typing-level undo step.
   * @param {string} hex
   */
  const setWordColor = (hex) => {
    if (!st) return;
    const s = st;
    const targets = targetWords(s);
    if (targets.length === 0) return;
    s.previewInk = null;
    s.previewWords = null;
    pushUndo();
    for (const k of targets) {
      /** @type {WordToggle} */
      const o = { ...(s.styleOv.get(k) || {}) };
      if (hex === baseOf(s, k).color) delete o.color; else o.color = hex;
      if (o.bold === undefined && o.italic === undefined && o.color === undefined) s.styleOv.delete(k);
      else s.styleOv.set(k, o);
    }
    requestPreview();
    draw();
  };
  /**
   * Draw the target words in `hex` without committing anything; null lifts the preview.
   * @param {?string} hex
   */
  const previewWordColor = (hex) => {
    if (!st) return;
    st.previewInk = hex || null;
    st.previewWords = hex ? new Set(targetWords(st)) : null;
    requestPreview();
    draw();
  };
  /** The client rect of the open line's text band, where the floating style bar anchors. */
  const bandClientRect = () => {
    if (!st || !st.xs || st.xs.length === 0) return null;
    let left = Infinity;
    let right = -Infinity;
    let top = Infinity;
    let bottom = -Infinity;
    for (let i = 0; i < st.xs.length; i++) {
      const size = st.szs?.[i] ?? st.size;
      left = Math.min(left, st.xs[i]);
      right = Math.max(right, st.xs[i]);
      top = Math.min(top, st.ys[i] - 0.75 * size);
      bottom = Math.max(bottom, st.ys[i] + 0.25 * size);
    }
    const r = canvas.getBoundingClientRect();
    const bw = st.box.right - st.box.left;
    const bh = st.box.bottom - st.box.top;
    if (!(bw > 0) || !(bh > 0) || !r.width) return null;
    const cx = (x) => r.left + ((x - st.box.left) / bw) * r.width;
    const cy = (y) => r.top + ((y - st.box.top) / bh) * r.height;
    return {
      left: cx(left), right: cx(right), top: cy(top), bottom: cy(bottom),
    };
  };

  /**
   * Toggle bold/italic on the words under the selection (or the caret's word), word-processor style.
   * A style baked into the word's face cannot toggle off; such words are left unchanged.
   * @param {'bold'|'italic'} prop
   */
  const toggleWordStyle = (prop) => {
    if (!st) return;
    const s = st;
    const targets = targetWords(s);
    if (targets.length === 0) return;
    /** @param {number} k */
    const base = (k) => baseOf(s, k);
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
      if (o.bold === undefined && o.italic === undefined && o.color === undefined) s.styleOv.delete(k);
      else s.styleOv.set(k, o);
    }
    requestPreview();
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
    requestPreview();
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
    requestPreview();
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
    // The lingering canvas keeps whatever detachInput's repaint drew, so the session must hold the original line again.
    st.text = st.origText;
    st.words = st.origWords;
    st.wordsText = st.origText;
    detachInput();
    st = null;
    scribe.doc.images.setEphemeralRecords(n, null);
    scribe.refreshPageRaster(n);
    removeCanvasAfterRefresh(n);
  };

  const commit = async () => {
    if (!st) return;
    // The lingering canvas shows the committed text until the page's raster catches up, so the preview of that text must have landed.
    const session = st;
    while (st === session && session.previewBusy) await session.previewDone;
    if (st !== session) return;
    const {
      line, n, text, origText, styleOv,
    } = st;
    const hasToggles = [...styleOv.values()].some((o) => o.bold !== undefined || o.italic !== undefined || o.color !== undefined);
    if ((text.trim() === origText || text.trim() === origText.trim()) && !hasToggles) {
      close();
      return;
    }
    const wordStyles = hasToggles
      ? tokenSpans(text).map((value, k) => {
        const o = styleOv.get(k);
        return o && (o.bold !== undefined || o.italic !== undefined || o.color !== undefined) ? o : null;
      })
      : null;
    detachInput();
    st = null;
    // A newer session may have opened on this page while replaceTextLine ran and now owns the rects.
    // Clearing them would redraw that session's original text under its editor.
    const ownedElsewhere = () => !!st && st.n === n;
    try {
      const res = await scribe.doc.replaceTextLine(line, text, wordStyles ? { wordStyles } : undefined);
      if (!ownedElsewhere()) scribe.doc.images.setEphemeralRecords(n, null);
      if (res && res.pages && onCommitted) onCommitted(res.pages);
      else scribe.refreshPageRaster(n);
      removeCanvasAfterRefresh(n);
    } catch (e) {
      if (!ownedElsewhere()) scribe.doc.images.setEphemeralRecords(n, null);
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
      stepHistory(ev.shiftKey);
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
        requestPreview();
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
        requestPreview();
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
    const onUp = (up) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      // A drag that selected words summons the floating style bar; a plain click never does.
      if (st === session && ev.pointerType !== 'touch' && selRange() && onRangeSelected) onRangeSelected(up.clientX, up.clientY);
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
    // The color plate's loupe is sampling the page: that press picks a color, it does not leave the line.
    if (scribe.scrollContainer?.classList.contains('scribe-edit-text-sampling')) return;
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

    const state = await scribe.doc.images.getLineState(n, line.words.map((w) => ({
      id: w.id, text: w.text, penX: nt[w.id]?.penX || [], baselineY: nt[w.id]?.baselineY,
    })));
    if (!state || !state.hide || state.words.length !== line.words.length || !state.words.every((sw) => sw)) return;
    /** @type {Array<PreviewWord>} */
    const words = state.words.map((sw, wi) => ({ text: line.words[wi].text, oldId: /** @type {{id: string}} */ (sw).id, glyphs: /** @type {{glyphs: Array<LineGlyph>}} */ (sw).glyphs }));
    // A word whose glyph texts do not spell its text has no slot per character to edit, so its line does not open.
    for (const w of words) if (w.glyphs.map((g) => ocr.replaceLigatures(g.text)).join('').toLowerCase() !== w.text.toLowerCase()) return;
    /** @type {EditSession['fonts']} */
    const fonts = new Map();
    for (const w of line.words) {
      const f = nt[w.id]?.fontObjNum;
      if (!fonts.has(f)) fonts.set(f, (await scribe.doc.images.getEditFont(n, f)) || { program: null, faceName: null });
    }
    const origText = words.map((w) => w.text).join(' ');
    const baselineY = line.bbox.bottom + (line.baseline?.[1] || 0);
    const glyphs = words.flatMap((w) => w.glyphs);
    const sfSize = glyphs[0]?.sizePx || line.words[0].style.size || Math.abs(line.bbox.bottom - line.bbox.top) / 0.75;

    // Base style state per word, so live toggles know each word's current state and what can toggle off.
    /** @type {Map<number, WordBase>} */
    const wordBase = new Map();
    line.words.forEach((w, k) => {
      const g0 = words[k].glyphs[0];
      wordBase.set(k, {
        bold: !!w.style.bold,
        italic: !!w.style.italic,
        stroked: !!g0?.renderMode,
        skewed: !!g0?.skew,
        color: (w.style.color || '#000000').toLowerCase(),
      });
    });

    // A zero descriptor descent puts char bbox bottoms at the baseline, so a canvas sized from the bboxes would clip descenders.
    let inkTop = baselineY - 1.3 * sfSize;
    let inkBottom = baselineY + 0.5 * sfSize;
    for (const g of glyphs) {
      inkTop = Math.min(inkTop, g.penY - 1.3 * g.sizePx);
      inkBottom = Math.max(inkBottom, g.penY + 0.5 * g.sizePx);
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
      lineStartX: glyphs[0]?.penX ?? line.bbox.left,
      text: origText,
      origText,
      words,
      wordsText: origText,
      origWords: words,
      fonts,
      previewBusy: false,
      previewStale: false,
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

    scribe.doc.images.setEphemeralRecords(n, state.hide);
    scribe.refreshPageRaster(n);

    document.addEventListener('pointerdown', onDocPointerdown, true);
    hiddenInput.value = '';
    hiddenInput.focus({ preventScroll: true });
    fieldOn = true;
    restartBlink();
    draw();
    if (onOpenChanged) onOpenChanged(true);
  };

  /** Settles once no preview is in flight for the open line, so a caller can read or capture what the text looks like. */
  const previewSettled = async () => {
    const session = st;
    while (session && st === session && session.previewBusy) await session.previewDone;
  };

  return {
    open,
    isOpen: () => !!st,
    lineOpen: () => st?.line || null,
    previewSettled,
    containsPoint,
    commit,
    revert: close,
    teardown: close,
    toggleStyle: toggleWordStyle,
    styleState: wordStyleState,
    colorState: wordColorState,
    setColor: setWordColor,
    previewColor: previewWordColor,
    bandClientRect,
    // The plate takes focus while it is up; a pick or a close hands the keyboard back here.
    focus: () => { if (st) hiddenInput.focus({ preventScroll: true }); },
    undo: () => stepHistory(false),
    redo: () => stepHistory(true),
    canUndo: () => !!st && st.undoStack.length > 0,
    canRedo: () => !!st && st.redoStack.length > 0,
  };
}
