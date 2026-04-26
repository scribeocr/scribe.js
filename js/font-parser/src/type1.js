import { Path } from './path.js';

/**
 * Decrypt a Type1 charstring (key=4330, discard first lenIV random bytes).
 * @param {Uint8Array} encrypted
 * @param {number} lenIV
 */
function decryptCharstring(encrypted, lenIV) {
  const decrypted = new Uint8Array(encrypted.length);
  let R = 4330;
  for (let i = 0; i < encrypted.length; i++) {
    const cipher = encrypted[i];
    decrypted[i] = cipher ^ (R >> 8);
    R = ((cipher + R) * 52845 + 22719) & 0xFFFF;
  }
  return decrypted.subarray(lenIV);
}

/**
 * Interpret a decrypted Type1 charstring and produce an opentype.js Path.
 * @param {Uint8Array} data - decrypted charstring bytes
 * @param {Array<Uint8Array>} subrs - subroutine array (decrypted)
 */
function interpretCharstring(data, subrs) {
  const path = new Path();
  let advanceWidth = 0;
  let x = 0;
  let y = 0;
  let open = false;
  const stack = [];
  const psStack = [];
  let flexMode = false;
  const flexPoints = [];
  let seacData = null;
  let sbx = 0;

  function processCharstring(csData, depth) {
    if (depth > 10) return;
    let i = 0;
    while (i < csData.length) {
      const b0 = csData[i];
      if (b0 >= 32 && b0 <= 246) {
        stack.push(b0 - 139); i++;
      } else if (b0 >= 247 && b0 <= 250) {
        stack.push((b0 - 247) * 256 + csData[i + 1] + 108); i += 2;
      } else if (b0 >= 251 && b0 <= 254) {
        stack.push(-(b0 - 251) * 256 - csData[i + 1] - 108); i += 2;
      } else if (b0 === 255) {
        const val = (csData[i + 1] << 24) | (csData[i + 2] << 16) | (csData[i + 3] << 8) | csData[i + 4];
        stack.push(val); i += 5;
      } else {
        let op = b0;
        i++;
        if (b0 === 12 && i < csData.length) { op = 1200 + csData[i]; i++; }

        switch (op) {
          case 13: // hsbw: sbx wx
            if (stack.length >= 2) {
              x = stack[0]; sbx = stack[0]; advanceWidth = stack[1];
            } else {
              advanceWidth = stack[0] || 0;
            }
            stack.length = 0;
            break;
          case 1207: // sbw: sbx sby wx wy
            if (stack.length >= 4) {
              x = stack[0]; y = stack[1]; advanceWidth = stack[2];
            } else {
              advanceWidth = stack.length >= 3 ? stack[2] : 0;
            }
            stack.length = 0;
            break;
          case 1: case 3: case 1201: case 1202: // hstem, vstem, vstem3, hstem3
            stack.length = 0;
            break;
          case 1200: // dotsection
            stack.length = 0;
            break;
          case 21: { // rmoveto dx dy
            const dx = stack.length >= 2 ? stack[stack.length - 2] : 0;
            const dy = stack.length >= 2 ? stack[stack.length - 1] : 0;
            x += dx; y += dy;
            if (flexMode) {
              flexPoints.push({ x, y });
            } else {
              if (open) path.close();
              path.moveTo(x, y);
              open = true;
            }
            stack.length = 0;
            break;
          }
          case 22: { // hmoveto dx
            const dx = stack.length >= 1 ? stack[stack.length - 1] : 0;
            x += dx;
            if (flexMode) {
              flexPoints.push({ x, y });
            } else {
              if (open) path.close();
              path.moveTo(x, y);
              open = true;
            }
            stack.length = 0;
            break;
          }
          case 4: { // vmoveto dy
            const dy = stack.length >= 1 ? stack[stack.length - 1] : 0;
            y += dy;
            if (flexMode) {
              flexPoints.push({ x, y });
            } else {
              if (open) path.close();
              path.moveTo(x, y);
              open = true;
            }
            stack.length = 0;
            break;
          }
          case 5: // rlineto dx dy (may have multiple pairs)
            for (let si = 0; si + 1 < stack.length; si += 2) {
              x += stack[si]; y += stack[si + 1];
              path.lineTo(x, y);
            }
            stack.length = 0;
            break;
          case 6: { // hlineto dx
            const dx = stack.length >= 1 ? stack[stack.length - 1] : 0;
            x += dx;
            path.lineTo(x, y);
            stack.length = 0;
            break;
          }
          case 7: { // vlineto dy
            const dy = stack.length >= 1 ? stack[stack.length - 1] : 0;
            y += dy;
            path.lineTo(x, y);
            stack.length = 0;
            break;
          }
          case 8: // rrcurveto dx1 dy1 dx2 dy2 dx3 dy3
            if (stack.length >= 6) {
              const x1 = x + stack[0]; const y1 = y + stack[1];
              const x2 = x1 + stack[2]; const y2 = y1 + stack[3];
              x = x2 + stack[4]; y = y2 + stack[5];
              path.curveTo(x1, y1, x2, y2, x, y);
            }
            stack.length = 0;
            break;
          case 30: // vhcurveto dy1 dx2 dy2 dx3
            if (stack.length >= 4) {
              const x1 = x; const y1 = y + stack[0];
              const x2 = x1 + stack[1]; const y2 = y1 + stack[2];
              x = x2 + stack[3]; y = y2;
              path.curveTo(x1, y1, x2, y2, x, y);
            }
            stack.length = 0;
            break;
          case 31: // hvcurveto dx1 dx2 dy2 dy3
            if (stack.length >= 4) {
              const x1 = x + stack[0]; const y1 = y;
              const x2 = x1 + stack[1]; const y2 = y1 + stack[2];
              x = x2; y = y2 + stack[3];
              path.curveTo(x1, y1, x2, y2, x, y);
            }
            stack.length = 0;
            break;
          case 9: // closepath
            if (open) { path.close(); open = false; }
            stack.length = 0;
            break;
          case 14: // endchar
            if (open) { path.close(); open = false; }
            stack.length = 0;
            return;
          case 10: { // callsubr
            const subrIdx = stack.pop();
            if (subrIdx !== undefined && subrs[subrIdx]) {
              processCharstring(subrs[subrIdx], depth + 1);
            }
            break;
          }
          case 11: // return
            return;
          case 1212: { // div a b
            const b = stack.pop();
            const a = stack.pop();
            if (a !== undefined && b !== undefined && b !== 0) stack.push(Math.round(a / b));
            else stack.push(0);
            break;
          }
          case 1206: { // seac — standard encoding accented character
            // Stack: asb adx ady bchar achar
            if (stack.length >= 5) {
              seacData = {
                asb: stack[stack.length - 5],
                adx: stack[stack.length - 4],
                ady: stack[stack.length - 3],
                bchar: stack[stack.length - 2],
                achar: stack[stack.length - 1],
              };
            }
            stack.length = 0;
            if (open) { path.close(); open = false; }
            return;
          }
          case 1216: { // callothersubr: arg1..argN N othersubr# callothersubr
            const otherSubrIdx = stack.pop();
            const nArgs = stack.pop() || 0;
            const psArgs = [];
            for (let a = 0; a < nArgs; a++) psArgs.unshift(stack.pop() || 0);
            if (otherSubrIdx === 1) {
              // Start flex: record reference point
              flexMode = true;
              flexPoints.length = 0;
              flexPoints.push({ x, y });
            } else if (otherSubrIdx === 0 && flexMode) {
              // End flex: points were recorded during rmoveto calls.
              // flexPoints[0] = reference, [1]-[7] = seven rmoveto positions.
              // Draw two cubic Bézier curves using points 1-6.
              if (flexPoints.length >= 8) {
                const p = flexPoints;
                path.curveTo(p[1].x, p[1].y, p[2].x, p[2].y, p[3].x, p[3].y);
                path.curveTo(p[4].x, p[4].y, p[5].x, p[5].y, p[6].x, p[6].y);
              }
              flexMode = false;
              if (psArgs.length >= 3) {
                psStack.push(psArgs[2]); // endY (popped second → stack[-1] → y)
                psStack.push(psArgs[1]); // endX (popped first → stack[-2] → x)
              }
            } else {
              // Default: push args onto PS stack for later `pop` retrieval
              for (let a = psArgs.length - 1; a >= 0; a--) psStack.push(psArgs[a]);
            }
            break;
          }
          case 1217: // pop — move value from PostScript stack to charstring stack.
            if (psStack.length > 0) stack.push(psStack.pop());
            break;
          case 1233: { // setcurrentpoint x y
            if (stack.length >= 2) {
              x = stack[stack.length - 2];
              y = stack[stack.length - 1];
            }
            stack.length = 0;
            break;
          }
          default:
            stack.length = 0;
            break;
        }
      }
    }
  }

  processCharstring(data, 0);
  if (open) path.close();
  return {
    path, advanceWidth, seac: seacData, sbx,
  };
}

/**
 * Parse a Type1 PFA/PFB font and extract glyph paths.
 *
 * @param {Uint8Array} pfaBytes - raw PFA/PFB font program bytes
 */
export function parseType1Font(pfaBytes) {
  try {
    let pfaText = '';
    for (let i = 0; i < pfaBytes.length; i += 16384) {
      pfaText += String.fromCharCode.apply(null, Array.from(pfaBytes.subarray(i, Math.min(i + 16384, pfaBytes.length))));
    }

    // Decrypt eexec section
    const eexecIdx = pfaText.indexOf('currentfile eexec');
    if (eexecIdx === -1) return null;
    let hexStart = eexecIdx + 'currentfile eexec'.length;
    while (hexStart < pfaText.length && (pfaText[hexStart] === '\n' || pfaText[hexStart] === '\r' || pfaText[hexStart] === ' ')) hexStart++;

    // Check if eexec section is hex-encoded or binary.
    // A single-byte test is unreliable because binary data can start with a valid
    // hex char (e.g. 0x69 = 'i'). Check the first several bytes instead.
    const sampleLen = Math.min(20, pfaText.length - hexStart);
    const isHex = /^[0-9A-Fa-f\s]+$/.test(pfaText.substring(hexStart, hexStart + sampleLen));
    let eexecBytes;
    if (isHex) {
      const hexStr = pfaText.substring(hexStart).replace(/\s/g, '');
      const zeroRun = hexStr.indexOf('0000000000');
      const cleanHex = zeroRun > 0 ? hexStr.substring(0, zeroRun) : hexStr;
      eexecBytes = new Uint8Array(cleanHex.length >> 1);
      for (let i = 0; i < eexecBytes.length; i++) {
        eexecBytes[i] = parseInt(cleanHex.substring(i * 2, i * 2 + 2), 16);
      }
    } else {
      eexecBytes = pfaBytes.subarray(hexStart);
    }

    // Decrypt eexec (key=55665, discard first 4 bytes)
    const decrypted = new Uint8Array(eexecBytes.length);
    let R = 55665;
    for (let i = 0; i < eexecBytes.length; i++) {
      const cipher = eexecBytes[i];
      decrypted[i] = cipher ^ (R >> 8);
      R = ((cipher + R) * 52845 + 22719) & 0xFFFF;
    }
    const decSub = decrypted.subarray(4);
    let privateText = '';
    for (let i = 0; i < decSub.length; i += 16384) {
      privateText += String.fromCharCode.apply(null, Array.from(decSub.subarray(i, Math.min(i + 16384, decSub.length))));
    }

    // Parse lenIV (number of random bytes prepended to charstrings, default 4)
    const lenIVMatch = privateText.match(/\/lenIV\s+(\d+)/);
    const lenIV = lenIVMatch ? Number(lenIVMatch[1]) : 4;

    // Detect RD operator alias: some fonts use "-|" instead of "RD"
    const rdOp = /-\|\s*\{string/.test(privateText) ? '-\\|' : 'RD';

    const subrs = [];
    const subrsMatch = privateText.match(/\/Subrs\s+(\d+)\s+array/);
    if (subrsMatch) {
      const nSubrs = Number(subrsMatch[1]);
      let sPos = subrsMatch.index + subrsMatch[0].length;
      const subrRegex = new RegExp(`dup\\s+(\\d+)\\s+(\\d+)\\s+${rdOp}\\s`);
      for (let s = 0; s < nSubrs; s++) {
        const dupMatch = subrRegex.exec(privateText.substring(sPos));
        if (!dupMatch) break;
        const subrIdx = Number(dupMatch[1]);
        const subrLen = Number(dupMatch[2]);
        const dataStart = sPos + dupMatch.index + dupMatch[0].length;
        const csBytes = decrypted.subarray(4 + dataStart, 4 + dataStart + subrLen);
        const csDecrypted = decryptCharstring(csBytes, lenIV);
        if (subrIdx < 1000) subrs[subrIdx] = csDecrypted;
        sPos = dataStart + subrLen;
      }
    }

    const charStringsMatch = privateText.match(/\/CharStrings\s+(\d+)\s+dict/);
    if (!charStringsMatch) return null;
    const csPos = charStringsMatch.index + charStringsMatch[0].length;

    const csRegex = new RegExp(`\\/(\\S+)\\s+(\\d+)\\s+${rdOp}\\s`, 'g');
    csRegex.lastIndex = csPos;

    // Interpret each charstring into a Path
    const glyphs = new Map();
    for (let csMatch = csRegex.exec(privateText); csMatch; csMatch = csRegex.exec(privateText)) {
      const glyphName = csMatch[1];
      const csLen = Number(csMatch[2]);
      const dataStart = csMatch.index + csMatch[0].length;
      const csBytes = decrypted.subarray(4 + dataStart, 4 + dataStart + csLen);
      const csDecrypted = decryptCharstring(csBytes, lenIV);
      const result = interpretCharstring(csDecrypted, subrs);
      glyphs.set(glyphName, result);
      csRegex.lastIndex = dataStart + csLen;
    }

    if (glyphs.size === 0) return null;

    // Resolve seac (Standard Encoding Accented Character) composites
    // seac builds accented glyphs by composing a base glyph + accent glyph.
    // bchar/achar are StandardEncoding charCodes that must be mapped to glyph names.
    const stdEncNames = [
      '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
      '', '', '', '', 'space', 'exclam', 'quotedbl', 'numbersign', 'dollar', 'percent', 'ampersand', 'quoteright',
      'parenleft', 'parenright', 'asterisk', 'plus', 'comma', 'hyphen', 'period', 'slash', 'zero', 'one', 'two',
      'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'colon', 'semicolon', 'less', 'equal', 'greater',
      'question', 'at', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S',
      'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'bracketleft', 'backslash', 'bracketright', 'asciicircum', 'underscore',
      'quoteleft', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't',
      'u', 'v', 'w', 'x', 'y', 'z', 'braceleft', 'bar', 'braceright', 'asciitilde', '', '', '', '', '', '', '', '',
      '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
      'exclamdown', 'cent', 'sterling', 'fraction', 'yen', 'florin', 'section', 'currency', 'quotesingle',
      'quotedblleft', 'guillemotleft', 'guilsinglleft', 'guilsinglright', 'fi', 'fl', '', 'endash', 'dagger',
      'daggerdbl', 'periodcentered', '', 'paragraph', 'bullet', 'quotesinglbase', 'quotedblbase', 'quotedblright',
      'guillemotright', 'ellipsis', 'perthousand', '', 'questiondown', '', 'grave', 'acute', 'circumflex', 'tilde',
      'macron', 'breve', 'dotaccent', 'dieresis', '', 'ring', 'cedilla', '', 'hungarumlaut', 'ogonek', 'caron',
      'emdash', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'AE', '', 'ordfeminine', '', '', '',
      '', 'Lslash', 'Oslash', 'OE', 'ordmasculine', '', '', '', '', '', 'ae', '', '', '', 'dotlessi', '', '',
      'lslash', 'oslash', 'oe', 'germandbls',
    ];
    for (const [, result] of glyphs) {
      if (!result.seac) continue;
      const {
        adx, ady, bchar, achar,
      } = result.seac;
      const baseName = stdEncNames[bchar] || '';
      const accentName = stdEncNames[achar] || '';
      const baseGlyph = baseName ? glyphs.get(baseName) : null;
      const accentGlyph = accentName ? glyphs.get(accentName) : null;
      if (!baseGlyph || !accentGlyph) continue;
      // Per Type1 spec: accent origin is placed at (adx, ady) in the composite's
      // coordinate system. The accent's path already starts at its own sbx, so
      // the x-offset is (adx - accentSbx) to align it correctly.
      const accentOffsetX = adx - (accentGlyph.sbx || 0);
      const accentOffsetY = ady;
      const composedPath = new Path();
      for (const cmd of baseGlyph.path.commands) {
        composedPath.commands.push({ ...cmd });
      }
      for (const cmd of accentGlyph.path.commands) {
        const shifted = { ...cmd };
        if (shifted.type === 'M' || shifted.type === 'L') {
          shifted.x += accentOffsetX; shifted.y += accentOffsetY;
        } else if (shifted.type === 'C') {
          shifted.x1 += accentOffsetX; shifted.y1 += accentOffsetY;
          shifted.x2 += accentOffsetX; shifted.y2 += accentOffsetY;
          shifted.x += accentOffsetX; shifted.y += accentOffsetY;
        } else if (shifted.type === 'Q') {
          shifted.x1 += accentOffsetX; shifted.y1 += accentOffsetY;
          shifted.x += accentOffsetX; shifted.y += accentOffsetY;
        }
        composedPath.commands.push(shifted);
      }
      result.path = composedPath;
    }

    // Parse /Encoding from PFA clear-text
    const encoding = new Map();
    const encMatch = pfaText.match(/\/Encoding\s+\d+\s+array/);
    if (encMatch) {
      const encRegex = /dup\s+(\d+)\s+\/(\S+)\s+put/g;
      encRegex.lastIndex = encMatch.index;
      for (let em = encRegex.exec(pfaText); em; em = encRegex.exec(pfaText)) {
        if (em.index > encMatch.index + 5000) break;
        const code = Number(em[1]);
        const name = em[2];
        if (glyphs.has(name)) encoding.set(code, name);
      }
    }

    const fontNameMatch = pfaText.match(/\/FontName\s+\/(\S+)/);
    const fontName = fontNameMatch ? fontNameMatch[1] : 'Type1Font';

    // Extract FontMatrix (6-element array, e.g. [0.001 0 0 0.001 0 0])
    const fmMatch = pfaText.match(/\/FontMatrix\s*\[([^\]]+)\]/);
    const fontMatrix = fmMatch
      ? fmMatch[1].trim().split(/\s+/).map(Number)
      : null;

    return {
      glyphs, encoding, fontName, fontMatrix,
    };
  } catch (_e) {
    return null;
  }
}
