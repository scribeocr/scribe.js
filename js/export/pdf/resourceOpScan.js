// Every branch consumes the same extent as its counterpart in `tokenizeContentStream`, so a change to a lexing rule goes in both.

import { TOKENIZER_TABLES, locateInlineImage } from '../../pdf/contentStream.js';

const {
  ws: WS, nameDelim: NAME_DELIM, digit: DIGIT, numStart: NUM_START, opChar: OP_CHAR, wsOrSlash: WS_OR_SLASH,
} = TOKENIZER_TABLES;

const OPS2 = new Set();
const OPS3 = new Set();
for (const op of TOKENIZER_TABLES.operators) {
  if (op.length === 2) OPS2.add((op.charCodeAt(0) << 8) | op.charCodeAt(1));
  else if (op.length === 3) OPS3.add((op.charCodeAt(0) << 16) | (op.charCodeAt(1) << 8) | op.charCodeAt(2));
}
const K_TF = (0x54 << 8) | 0x66;
const K_DO = (0x44 << 8) | 0x6F;
const K_GS = (0x67 << 8) | 0x73;

/**
 * Index just past a literal string whose opening parenthesis is at `i - 1`.
 * @param {string} t
 * @param {number} i
 * @param {number} len
 */
function skipLiteral(t, i, len) {
  let depth = 1;
  while (i < len && depth > 0) {
    const sc = t.charCodeAt(i);
    if (sc === 0x5C) i += 2;
    else {
      if (sc === 0x28) depth++;
      else if (sc === 0x29) depth--;
      i++;
    }
  }
  return i;
}

/**
 * Index just past a number that starts at `i`.
 * @param {string} t
 * @param {number} i
 * @param {number} len
 */
function skipNumber(t, i, len) {
  const nstart = i;
  let hasDot = false;
  while (i < len) {
    const nc = t.charCodeAt(i);
    if (nc === 0x2E) { if (hasDot) break; hasDot = true; } else if (nc === 0x2B || nc === 0x2D) { if (i > nstart) break; } else if (!DIGIT[nc]) break;
    i++;
  }
  return i;
}

/**
 * Call `onUse` for every resource name a `Tf`, `Do` or `gs` operator takes.
 * Scanning stops when `onUse` returns true.
 * @param {string} t - Content stream text, one char per byte.
 * @param {(key: number, name: string) => (boolean|void)} onUse - `key` is 0 for `Tf`, 1 for `Do` and 2 for `gs`.
 * @returns {boolean} Whether `onUse` stopped the scan.
 */
export function scanResourceOps(t, onUse) {
  const len = t.length;
  let i = 0;
  let nameStart = -1;
  let nameEnd = 0;
  while (i < len) {
    const cc = t.charCodeAt(i);
    if (WS[cc]) { i++; continue; }

    if (cc === 0x25) {
      while (i < len) {
        const c2 = t.charCodeAt(i);
        if (c2 === 0x0A || c2 === 0x0D) break;
        i++;
      }
      continue;
    }

    if (cc === 0x2F) {
      i++;
      nameStart = i;
      while (i < len && !NAME_DELIM[t.charCodeAt(i)]) i++;
      nameEnd = i;
      continue;
    }

    if (cc === 0x3C) {
      if (i + 1 < len && t.charCodeAt(i + 1) === 0x3C) {
        i += 2;
        let depth = 1;
        while (i < len && depth > 0) {
          const dc = t.charCodeAt(i);
          if (dc === 0x3C && i + 1 < len && t.charCodeAt(i + 1) === 0x3C) {
            depth++;
            i += 2;
          } else if (dc === 0x3E && i + 1 < len && t.charCodeAt(i + 1) === 0x3E) {
            depth--;
            i += 2;
          } else if (dc === 0x3C) {
            i++;
            while (i < len && t.charCodeAt(i) !== 0x3E) i++;
            i++;
          } else if (dc === 0x28) {
            i = skipLiteral(t, i + 1, len);
          } else if (dc === 0x25) {
            while (i < len && t.charCodeAt(i) !== 0x0A && t.charCodeAt(i) !== 0x0D) i++;
          } else {
            i++;
          }
        }
        nameStart = -1;
        continue;
      }
      i++;
      while (i < len && t.charCodeAt(i) !== 0x3E) i++;
      i++;
      nameStart = -1;
      continue;
    }

    if (cc === 0x28) {
      i = skipLiteral(t, i + 1, len);
      nameStart = -1;
      continue;
    }

    if (cc === 0x5B) {
      i++;
      while (i < len) {
        const ac = t.charCodeAt(i);
        if (ac === 0x5D) { i++; break; }
        if (WS[ac]) { i++; continue; }
        if (ac === 0x3C && (i + 1 >= len || t.charCodeAt(i + 1) !== 0x3C)) {
          i++;
          while (i < len && t.charCodeAt(i) !== 0x3E) i++;
          i++;
          continue;
        }
        if (ac === 0x28) { i = skipLiteral(t, i + 1, len); continue; }
        if (NUM_START[ac]) { i = skipNumber(t, i, len); continue; }
        i++;
      }
      nameStart = -1;
      continue;
    }

    if (NUM_START[cc]) { i = skipNumber(t, i, len); continue; }

    if (OP_CHAR[cc]) {
      if (cc === 0x42 && i + 1 < len && t.charCodeAt(i + 1) === 0x49 && (i + 2 >= len || WS_OR_SLASH[t.charCodeAt(i + 2)])) {
        i = locateInlineImage(t, i + 2).end;
        nameStart = -1;
        continue;
      }

      if (i + 2 < len) {
        const c2 = t.charCodeAt(i + 1);
        const c3 = t.charCodeAt(i + 2);
        if (OP_CHAR[c2] && OP_CHAR[c3] && OPS3.has((cc << 16) | (c2 << 8) | c3)) {
          i += 3;
          nameStart = -1;
          continue;
        }
      }
      if (i + 1 < len) {
        const c2 = t.charCodeAt(i + 1);
        if (OP_CHAR[c2] || DIGIT[c2]) {
          const key = (cc << 8) | c2;
          if (OPS2.has(key)) {
            i += 2;
            if (nameStart >= 0 && (key === K_TF || key === K_DO || key === K_GS)) {
              if (onUse(key === K_TF ? 0 : key === K_DO ? 1 : 2, t.slice(nameStart, nameEnd))) return true;
            }
            nameStart = -1;
            continue;
          }
        }
      }
      i++;
      nameStart = -1;
      continue;
    }

    i++;
  }
  return false;
}
