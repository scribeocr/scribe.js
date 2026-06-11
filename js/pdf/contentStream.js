// PDF content-stream tokenizer and serializer. Depends only on JS built-ins.

/** All valid PDF content stream operators (PDF Reference 1.7, Table A.1). */
const PDF_CONTENT_OPERATORS = new Set([
  'w', 'J', 'j', 'M', 'd', 'ri', 'i', 'gs',
  'q', 'Q', 'cm',
  'm', 'l', 'c', 'v', 'y', 'h', 're',
  'S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n',
  'W', 'W*',
  'BT', 'ET',
  'Tc', 'Tw', 'Tz', 'TL', 'Tf', 'Tr', 'Ts',
  'Td', 'TD', 'Tm', 'T*',
  'Tj', 'TJ', "'", '"',
  'd0', 'd1',
  'CS', 'cs', 'SC', 'SCN', 'sc', 'scn', 'G', 'g', 'RG', 'rg', 'K', 'k',
  'sh',
  'BI', 'ID', 'EI',
  'Do',
  'MP', 'DP', 'BMC', 'BDC', 'EMC',
  'BX', 'EX',
]);

// Character classification tables for the tokenizer. Indexed by charCode (0-255).
const TOK_WS = new Uint8Array(256);
const TOK_NAME_DELIM = new Uint8Array(256); // whitespace + /<>[](){}%
const TOK_DIGIT = new Uint8Array(256);
const TOK_OCTAL = new Uint8Array(256);
const TOK_NUM_START = new Uint8Array(256); // digit . + -
const TOK_OP_CHAR = new Uint8Array(256); // a-zA-Z'"*
const TOK_WS_OR_SLASH = new Uint8Array(256); // whitespace + /
for (const c of [0, 9, 10, 12, 13, 32]) TOK_WS[c] = 1;
for (let c = 0; c < 256; c++) if (TOK_WS[c]) { TOK_NAME_DELIM[c] = 1; TOK_WS_OR_SLASH[c] = 1; }
for (const c of [0x2F, 0x3C, 0x3E, 0x5B, 0x5D, 0x28, 0x29, 0x7B, 0x7D, 0x25]) TOK_NAME_DELIM[c] = 1;
TOK_WS_OR_SLASH[0x2F] = 1;
for (let c = 0x30; c <= 0x39; c++) { TOK_DIGIT[c] = 1; TOK_NUM_START[c] = 1; }
for (let c = 0x30; c <= 0x37; c++) TOK_OCTAL[c] = 1;
TOK_NUM_START[0x2E] = 1; TOK_NUM_START[0x2B] = 1; TOK_NUM_START[0x2D] = 1;
for (let c = 0x41; c <= 0x5A; c++) TOK_OP_CHAR[c] = 1;
for (let c = 0x61; c <= 0x7A; c++) TOK_OP_CHAR[c] = 1;
TOK_OP_CHAR[0x27] = 1; TOK_OP_CHAR[0x22] = 1; TOK_OP_CHAR[0x2A] = 1;

/**
 * Tokenize a PDF content stream into tokens.
 * @param {string} streamText
 * @returns {Array<PDFToken>}
 */
export function tokenizeContentStream(streamText) {
  const tokens = /** @type {Array<PDFToken>} */ ([]);
  let i = 0;
  const len = streamText.length;

  while (i < len) {
    const cc = streamText.charCodeAt(i);

    if (TOK_WS[cc]) { i++; continue; }

    const tokStart = i;

    if (cc === 0x25) { // %
      while (i < len) {
        const c2 = streamText.charCodeAt(i);
        if (c2 === 0x0A || c2 === 0x0D) break;
        i++;
      }
      continue;
    }

    if (cc === 0x2F) { // /
      i++;
      const nameStart = i;
      while (i < len && !TOK_NAME_DELIM[streamText.charCodeAt(i)]) i++;
      tokens.push({ type: 'name', value: streamText.slice(nameStart, i), start: tokStart });
      continue;
    }

    if (cc === 0x3C) { // <
      if (i + 1 < len && streamText.charCodeAt(i + 1) === 0x3C) {
        const dictStart = i;
        i += 2;
        let depth = 1;
        while (i < len && depth > 0) {
          const dc = streamText.charCodeAt(i);
          if (dc === 0x3C && i + 1 < len && streamText.charCodeAt(i + 1) === 0x3C) {
            depth++;
            i += 2;
          } else if (dc === 0x3E && i + 1 < len && streamText.charCodeAt(i + 1) === 0x3E) {
            depth--;
            i += 2;
          } else if (dc === 0x3C) {
            // A lone '<' opens a hex string.
            // Skip to its closing '>' so an abutting '>>>' run (hex close then dict close '>>') is not read as '>>' + '>',
            // which would close the dict one '>' early.
            i++;
            while (i < len && streamText.charCodeAt(i) !== 0x3E) i++;
            i++;
          } else if (dc === 0x28) { // ( literal string: may contain < > ( )
            i++;
            let strDepth = 1;
            while (i < len && strDepth > 0) {
              const sc = streamText.charCodeAt(i);
              if (sc === 0x5C) i += 2;
              else {
                if (sc === 0x28) strDepth++;
                else if (sc === 0x29) strDepth--;
                i++;
              }
            }
          } else if (dc === 0x25) { // % comment to end of line
            while (i < len && streamText.charCodeAt(i) !== 0x0A && streamText.charCodeAt(i) !== 0x0D) i++;
          } else {
            i++;
          }
        }
        tokens.push({ type: 'dict', value: streamText.slice(dictStart, i), start: tokStart });
        continue;
      }
      i++;
      let hex = '';
      while (i < len && streamText.charCodeAt(i) !== 0x3E) {
        if (!TOK_WS[streamText.charCodeAt(i)]) hex += streamText[i];
        i++;
      }
      i++;
      tokens.push({ type: 'hexstring', value: hex, start: tokStart });
      continue;
    }

    if (cc === 0x28) { // (
      i++;
      let str = '';
      let depth = 1;
      while (i < len && depth > 0) {
        const sc = streamText.charCodeAt(i);
        if (sc === 0x5C) { // backslash
          i++;
          if (i >= len) break;
          const ec = streamText.charCodeAt(i);
          if (ec === 0x6E) str += '\n';
          else if (ec === 0x72) str += '\r';
          else if (ec === 0x74) str += '\t';
          else if (ec === 0x62) str += '\b';
          else if (ec === 0x66) str += '\f';
          else if (ec === 0x28 || ec === 0x29 || ec === 0x5C) str += streamText[i];
          else if (ec === 0x0D) {
            if (i + 1 < len && streamText.charCodeAt(i + 1) === 0x0A) i++;
          } else if (ec === 0x0A) {
            /* line continuation */
          } else if (TOK_OCTAL[ec]) {
            let val = ec - 0x30;
            if (i + 1 < len && TOK_OCTAL[streamText.charCodeAt(i + 1)]) {
              i++;
              val = val * 8 + (streamText.charCodeAt(i) - 0x30);
              if (i + 1 < len && TOK_OCTAL[streamText.charCodeAt(i + 1)]) {
                i++;
                val = val * 8 + (streamText.charCodeAt(i) - 0x30);
              }
            }
            str += String.fromCharCode(val);
          } else {
            str += streamText[i];
          }
          i++;
        } else if (sc === 0x28) {
          depth++; str += '('; i++;
        } else if (sc === 0x29) {
          depth--;
          if (depth > 0) str += ')';
          i++;
        } else {
          str += streamText[i];
          i++;
        }
      }
      tokens.push({ type: 'string', value: str, start: tokStart });
      continue;
    }

    if (cc === 0x5B) { // [
      i++;
      const arrTokens = [];
      while (i < len) {
        const ac = streamText.charCodeAt(i);
        if (ac === 0x5D) { i++; break; }
        if (TOK_WS[ac]) { i++; continue; }
        if (ac === 0x3C && (i + 1 >= len || streamText.charCodeAt(i + 1) !== 0x3C)) {
          i++;
          let hex = '';
          while (i < len && streamText.charCodeAt(i) !== 0x3E) {
            if (!TOK_WS[streamText.charCodeAt(i)]) hex += streamText[i];
            i++;
          }
          i++;
          arrTokens.push({ type: 'hexstring', value: hex });
          continue;
        }
        if (ac === 0x28) {
          i++;
          let str = '';
          let d = 1;
          while (i < len && d > 0) {
            const sc = streamText.charCodeAt(i);
            if (sc === 0x5C) {
              i++;
              if (i >= len) break;
              const ec = streamText.charCodeAt(i);
              if (ec === 0x6E) str += '\n';
              else if (ec === 0x72) str += '\r';
              else if (ec === 0x74) str += '\t';
              else if (ec === 0x62) str += '\b';
              else if (ec === 0x66) str += '\f';
              else if (ec === 0x28 || ec === 0x29 || ec === 0x5C) str += streamText[i];
              else if (ec === 0x0D) { if (i + 1 < len && streamText.charCodeAt(i + 1) === 0x0A) i++; } else if (ec === 0x0A) { /* line continuation */ } else if (TOK_OCTAL[ec]) {
                let val = ec - 0x30;
                if (i + 1 < len && TOK_OCTAL[streamText.charCodeAt(i + 1)]) {
                  i++;
                  val = val * 8 + (streamText.charCodeAt(i) - 0x30);
                  if (i + 1 < len && TOK_OCTAL[streamText.charCodeAt(i + 1)]) {
                    i++;
                    val = val * 8 + (streamText.charCodeAt(i) - 0x30);
                  }
                }
                str += String.fromCharCode(val);
              } else {
                str += streamText[i];
              }
              i++;
            } else if (sc === 0x28) { d++; str += '('; i++; } else if (sc === 0x29) { d--; if (d > 0) str += ')'; i++; } else { str += streamText[i]; i++; }
          }
          arrTokens.push({ type: 'string', value: str });
          continue;
        }
        if (TOK_NUM_START[ac]) {
          const nstart = i;
          let hasDot = false;
          while (i < len) {
            const nc = streamText.charCodeAt(i);
            if (nc === 0x2E) { if (hasDot) break; hasDot = true; } else if (nc === 0x2B || nc === 0x2D) { if (i > nstart) break; } else if (!TOK_DIGIT[nc]) { break; }
            i++;
          }
          const nv = Number(streamText.slice(nstart, i));
          arrTokens.push({ type: 'number', value: Number.isFinite(nv) ? nv : 0 });
          continue;
        }
        i++;
      }
      tokens.push({ type: 'array', value: arrTokens, start: tokStart });
      continue;
    }

    if (TOK_NUM_START[cc]) {
      const nstart = i;
      let hasDot = false;
      while (i < len) {
        const nc = streamText.charCodeAt(i);
        if (nc === 0x2E) { if (hasDot) break; hasDot = true; } else if (nc === 0x2B || nc === 0x2D) { if (i > nstart) break; } else if (!TOK_DIGIT[nc]) { break; }
        i++;
      }
      const nv = Number(streamText.slice(nstart, i));
      tokens.push({ type: 'number', value: Number.isFinite(nv) ? nv : 0, start: tokStart });
      continue;
    }

    if (TOK_OP_CHAR[cc]) {
      // Inline image BI ... ID ... EI
      if (cc === 0x42 && i + 1 < len && streamText.charCodeAt(i + 1) === 0x49
          && (i + 2 >= len || TOK_WS_OR_SLASH[streamText.charCodeAt(i + 2)])) {
        i += 2;
        let dictText = '';
        while (i < len) {
          const dc = streamText.charCodeAt(i);
          if (dc === 0x49 && i + 1 < len && streamText.charCodeAt(i + 1) === 0x44
              && (i === 0 || TOK_WS[streamText.charCodeAt(i - 1)])
              && i + 2 < len && TOK_WS[streamText.charCodeAt(i + 2)]) {
            i += 3;
            break;
          }
          dictText += streamText[i];
          i++;
        }
        const dataStart = i;
        // Some PDFs emit raw image data whose last byte is non-whitespace.
        // The spec-strict whitespace-bounded scan below would miss EI, so for
        // raw images (no /F filter) match EI at the offset computed from /W /H /BPC.
        const dictTrim = dictText.trim();
        const hasFilter = /\/(?:F|Filter)\b/.test(dictTrim);
        let computedDataLen = -1;
        if (!hasFilter) {
          const wMatch = /\/(?:W|Width)\s+(\d+)/.exec(dictTrim);
          const hMatch = /\/(?:H|Height)\s+(\d+)/.exec(dictTrim);
          const bpcMatch = /\/(?:BPC|BitsPerComponent)\s+(\d+)/.exec(dictTrim);
          if (wMatch && hMatch) {
            const w = Number(wMatch[1]);
            const h = Number(hMatch[1]);
            const bpc = bpcMatch ? Number(bpcMatch[1]) : 8;
            let nComp = 1;
            if (/\/CS\s*\/(?:RGB|DeviceRGB|CalRGB)\b/.test(dictTrim)) nComp = 3;
            else if (/\/CS\s*\/(?:CMYK|DeviceCMYK)\b/.test(dictTrim)) nComp = 4;
            else if (/\/CS\s*\/(?:G|DeviceGray|CalGray)\b/.test(dictTrim)) nComp = 1;
            else if (/\/(?:IM|ImageMask)\s+true\b/.test(dictTrim)) { nComp = 1; } else nComp = 0; // Indexed or unknown — leave to scan
            if (nComp > 0) {
              const rowBytes = Math.ceil((w * nComp * bpc) / 8);
              computedDataLen = rowBytes * h;
            }
          }
        }
        if (computedDataLen >= 0) {
          const dataEnd = dataStart + computedDataLen;
          if (dataEnd + 2 <= len
              && streamText.charCodeAt(dataEnd) === 0x45
              && streamText.charCodeAt(dataEnd + 1) === 0x49
              && (dataEnd + 2 === len || TOK_WS_OR_SLASH[streamText.charCodeAt(dataEnd + 2)])) {
            const imageData = streamText.substring(dataStart, dataEnd);
            i = dataEnd + 2;
            tokens.push({ type: 'inlineImage', value: { dictText: dictTrim, imageData }, start: tokStart });
            continue;
          }
        }
        while (i < len) {
          const ec = streamText.charCodeAt(i);
          if (ec === 0x45 && i + 1 < len && streamText.charCodeAt(i + 1) === 0x49
              && i > dataStart && TOK_WS[streamText.charCodeAt(i - 1)]
              && (i + 2 >= len || TOK_WS_OR_SLASH[streamText.charCodeAt(i + 2)])) {
            break;
          }
          i++;
        }
        const imageData = streamText.substring(dataStart, i > dataStart ? i - 1 : i);
        i += 2;
        tokens.push({ type: 'inlineImage', value: { dictText: dictTrim, imageData }, start: tokStart });
        continue;
      }

      // 3-char operator (letters only)
      if (i + 2 < len) {
        const c2 = streamText.charCodeAt(i + 1);
        const c3 = streamText.charCodeAt(i + 2);
        if (TOK_OP_CHAR[c2] && TOK_OP_CHAR[c3]) {
          const op3 = streamText.slice(i, i + 3);
          if (PDF_CONTENT_OPERATORS.has(op3)) {
            tokens.push({ type: 'operator', value: op3, start: tokStart });
            i += 3;
            continue;
          }
        }
      }
      // 2-char operator (second char may be digit for d0/d1)
      if (i + 1 < len) {
        const c2 = streamText.charCodeAt(i + 1);
        if (TOK_OP_CHAR[c2] || TOK_DIGIT[c2]) {
          const op2 = streamText.slice(i, i + 2);
          if (PDF_CONTENT_OPERATORS.has(op2)) {
            tokens.push({ type: 'operator', value: op2, start: tokStart });
            i += 2;
            continue;
          }
        }
      }
      // 1-char operator
      tokens.push({ type: 'operator', value: streamText[i], start: tokStart });
      i++;
      continue;
    }

    i++;
  }

  return tokens;
}

/**
 * Format a JS number for emission into a PDF content stream.
 * @param {number} n
 */
export function formatPdfNumber(n) {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return String(n);
  const s = String(n);
  if (!s.includes('e') && !s.includes('E')) return s;
  const absN = Math.abs(n);
  if (absN === 0) return '0';
  const expDigits = Math.max(0, Math.ceil(-Math.log10(absN)));
  const fixed = n.toFixed(Math.min(expDigits + 6, 20));
  return fixed.replace(/\.?0+$/, '');
}

/**
 * Re-encode a tokenizer token as PDF content-stream syntax.
 * @param {PDFToken} t
 */
function serializeContentToken(t) {
  switch (t.type) {
    case 'name':
      return `/${t.value}`;
    case 'hexstring':
      return `<${t.value}>`;
    case 'number':
      return formatPdfNumber(t.value);
    case 'operator':
      return t.value;
    case 'array':
      return `[${t.value.map(serializeContentToken).join(' ')}]`;
    case 'dict':
      return t.value;
    case 'string': {
      // Tokenizer decoded escape sequences and `\nnn` octals into raw bytes
      // (latin1 charcodes 0..255). Re-escape: backslash, parens, and any
      // non-ASCII-printable byte gets a 3-digit octal escape.
      let out = '';
      for (let i = 0; i < t.value.length; i++) {
        const cc = t.value.charCodeAt(i);
        if (cc === 0x5C) out += '\\\\';
        else if (cc === 0x28) out += '\\(';
        else if (cc === 0x29) out += '\\)';
        else if (cc < 32 || cc > 126) out += `\\${cc.toString(8).padStart(3, '0')}`;
        else out += t.value[i];
      }
      return `(${out})`;
    }
    case 'inlineImage':
      return `BI\n${t.value.dictText}\nID\n${t.value.imageData}\nEI`;
    default:
      return '';
  }
}

/**
 * Rewrite a content stream to drop text-showing operators (Tj/TJ/'/").
 *
 * @param {string} streamText - Decoded latin1 content stream text.
 * @param {{ mode?: 'invisible' | 'all' }} [options]
 */
export function stripText(streamText, { mode = 'invisible' } = {}) {
  // Invisible-mode early exit: if the stream contains no Tr operator,
  // no glyph can have render mode 3, so nothing would ever be dropped.
  // Skipping the tokenize+serialize pass here is decisive on PDFs with multi-MB pages.
  if (mode === 'invisible' && !/\bTr\b/.test(streamText)) {
    return { text: streamText, dropped: false };
  }
  const tokens = tokenizeContentStream(streamText);

  // Invisible mode strips redundant invisible (Tr=3) text, but must NOT drop an invisible op whose advance positions VISIBLE text.
  // This is rare, but spacing characters are sometimes drawn using invisible text.
  // A self-contained invisible run that positions only itself and ends at a reposition, reaching no visible show, still drops wholesale,
  // so genuine redundant OCR layers are removed in full.
  /** @type {Set<number>} */
  const keepInvisible = new Set();
  if (mode === 'invisible') {
    let scanTr = 0;
    /** @type {Array<number>} */
    const scanTrStack = [];
    // Token indices of invisible Tj/TJ seen since the last reposition or visible show.
    /** @type {Array<number>} */
    let pendingInvisible = [];
    for (let ti = 0; ti < tokens.length; ti++) {
      const tok = tokens[ti];
      if (tok.type !== 'operator') continue;
      const op = tok.value;
      if (op === 'q') {
        scanTrStack.push(scanTr);
      } else if (op === 'Q') {
        if (scanTrStack.length > 0) scanTr = /** @type {number} */ (scanTrStack.pop());
      } else if (op === 'Tr') {
        // Tr's operand is the number token immediately before it.
        const prev = tokens[ti - 1];
        if (prev && prev.type === 'number') scanTr = prev.value;
      }

      if (op === 'Td' || op === 'TD' || op === 'Tm' || op === 'T*' || op === 'BT' || op === 'ET') {
        // Reposition: pending advances no longer position any following text.
        pendingInvisible = [];
      } else if (op === "'" || op === '"') {
        // These do a T* (next line) first, resetting x for anything pending.
        pendingInvisible = [];
        // Keep an invisible '/" verbatim — its T* line move can shift content below it.
        if (scanTr === 3) keepInvisible.add(ti);
      } else if (op === 'Tj' || op === 'TJ') {
        if (scanTr === 3) {
          pendingInvisible.push(ti); // candidate; kept only if a visible show follows
        } else {
          // A retained (visible) show consumes the pending advances — keep them.
          for (const idx of pendingInvisible) keepInvisible.add(idx);
          pendingInvisible = [];
        }
      }
    }
  }

  /** @type {Array<PDFToken>} */
  const operandBuf = [];
  let tr = 0;
  /** @type {Array<number>} */
  const trStack = [];
  // Array + join, not `+=` accumulation — `+=` is O(N²) on multi-MB streams.
  /** @type {Array<string>} */
  const out = [];
  let lastEndsInWhitespace = true;

  /** @param {Array<PDFToken>} ops */
  const flushOperands = (ops) => {
    for (let i = 0; i < ops.length; i++) {
      const piece = serializeContentToken(ops[i]);
      out.push(piece);
      if (i + 1 < ops.length) {
        out.push(' ');
        lastEndsInWhitespace = true;
      } else {
        lastEndsInWhitespace = piece.length > 0 && /\s/.test(piece[piece.length - 1]);
      }
    }
  };

  let dropped = false;
  for (let ti = 0; ti < tokens.length; ti++) {
    const tok = tokens[ti];
    if (tok.type !== 'operator') {
      operandBuf.push(tok);
      continue;
    }
    const op = tok.value;
    if (op === 'q') {
      trStack.push(tr);
    } else if (op === 'Q') {
      if (trStack.length > 0) tr = /** @type {number} */ (trStack.pop());
    } else if (op === 'Tr') {
      if (operandBuf.length > 0) {
        const last = operandBuf[operandBuf.length - 1];
        if (last.type === 'number') tr = last.value;
      }
    }

    const isTextShow = op === 'Tj' || op === 'TJ' || op === "'" || op === '"';
    // Drop a text-show op: in 'all' mode every show,
    // in 'invisible' mode only a Tr=3 show not flagged load-bearing in keepInvisible.
    const shouldDrop = isTextShow && (mode === 'all' || (tr === 3 && !keepInvisible.has(ti)));
    if (shouldDrop) {
      operandBuf.length = 0;
      dropped = true;
      continue;
    }

    flushOperands(operandBuf);
    operandBuf.length = 0;
    if (out.length > 0 && !lastEndsInWhitespace) {
      out.push(' ');
    }
    out.push(op);
    out.push('\n');
    lastEndsInWhitespace = true;
  }

  if (operandBuf.length > 0) {
    flushOperands(operandBuf);
  }

  return { text: out.join(''), dropped };
}
