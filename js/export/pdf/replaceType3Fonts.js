import {
  findXrefOffset, getPageContentStreams, getPageObjects, parseXref,
} from '../../pdf/parsePdfUtils.js';
import {
  formatPdfNumber, tokenizeContentStream,
} from '../../pdf/contentStream.js';
import { ObjectCache } from '../../pdf/objectCache.js';
import {
  extractType3Fonts, extractType3DistinctGlyphs, parsePageFonts, parseType3Font,
} from '../../pdf/fonts/parsePdfFonts.js';
import opentype from '../../font-parser/src/index.js';
import { createEmbeddedFontType0 } from './writePdfFonts.js';
import { encodeStreamObject } from './writePdfStreams.js';
import {
  buildReplacementPageDict, mergeResources, resolvePageResources,
} from './pdfPageRewrite.js';
import {
  buildIncrementalXrefAndTrailer, parseTrailerInfo,
} from './pdfObjectGraph.js';

/**
 * Re-serialize a tokenized PDF content-stream operand.
 * @param {{type: string, value: any}} t
 * @returns {string}
 */
function serializeOperand(t) {
  if (t.type === 'name') return `/${t.value}`;
  if (t.type === 'number') return formatPdfNumber(t.value);
  if (t.type === 'hexstring') return `<${t.value}>`;
  if (t.type === 'dict') return t.value;
  if (t.type === 'string') {
    let out = '(';
    for (let i = 0; i < t.value.length; i++) {
      const c = t.value.charCodeAt(i);
      if (c === 0x28 || c === 0x29 || c === 0x5C) out += `\\${t.value[i]}`;
      else if (c < 0x20 || c > 0x7E) out += `\\${c.toString(8).padStart(3, '0')}`;
      else out += t.value[i];
    }
    return `${out})`;
  }
  if (t.type === 'array') return `[${t.value.map(serializeOperand).join(' ')}]`;
  if (t.type === 'boolean') return t.value ? 'true' : 'false';
  if (t.type === 'null') return 'null';
  if (t.type === 'inlineImage') return `BI\n${t.value.dictText}\nID\n${t.value.imageData}\nEI`;
  return '';
}

/**
 * Recode a 1-byte text-show operand into a 2-byte CID hex string using the
 * supplied charCode->gid map.
 *
 * @param {{type: string, value: any}} operand
 * @param {string} op
 * @param {Map<number, number>} charCodeToGid
 * @param {Map<number, number>} gidToAdvance - Per-GID advance width in font units (= 1/1000 em).
 * @returns {string | { op: 'TJ', text: string } | null} Re-encoded operand text,
 *   `{op:'TJ', text}` when the original op should be replaced with `TJ`, or
 *   null if recoding failed.
 */
function recodeOperand(operand, op, charCodeToGid, gidToAdvance) {
  const codeToHex = (code) => ((code >> 8) & 0xFF).toString(16).padStart(2, '0').toUpperCase()
    + (code & 0xFF).toString(16).padStart(2, '0').toUpperCase();

  const bytesToGids = (bytes) => {
    /** @type {number[]} */
    const gids = [];
    for (let i = 0; i < bytes.length; i++) {
      gids.push(charCodeToGid.get(bytes.charCodeAt(i)) ?? 0);
    }
    return gids;
  };

  /**
   * Emit a sequence of GIDs as TJ array parts, inserting a compensating spacer between each adjacent pair.
   * @param {number[]} gids
   * @param {string[]} parts - Output array that re-encoded parts are pushed onto.
   */
  const emitGidsWithSpacers = (gids, parts) => {
    if (gids.length === 0) return;
    let hexBuf = codeToHex(gids[0]);
    // The replacement font's bbox-derived advances are smaller than the source Type3 font's
    // placeholder 1-em (1000-unit) advance. Without a spacer, later glyphs sit too close and
    // downstream readers split one word into several. `advance - 1000` pushes the cursor forward by the gap.
    for (let i = 1; i < gids.length; i++) {
      const spacer = (gidToAdvance.get(gids[i - 1]) ?? 1000) - 1000;
      if (spacer === 0) {
        hexBuf += codeToHex(gids[i]);
      } else {
        parts.push(`<${hexBuf}>`);
        parts.push(formatPdfNumber(spacer));
        hexBuf = codeToHex(gids[i]);
      }
    }
    parts.push(`<${hexBuf}>`);
  };

  if (op === 'TJ') {
    if (operand.type !== 'array') return null;
    const parts = [];
    for (const elem of operand.value) {
      if (elem.type === 'number') {
        parts.push(formatPdfNumber(elem.value));
      } else if (elem.type === 'hexstring') {
        let bytes = '';
        for (let j = 0; j + 1 < elem.value.length; j += 2) {
          bytes += String.fromCharCode(parseInt(elem.value.slice(j, j + 2), 16));
        }
        emitGidsWithSpacers(bytesToGids(bytes), parts);
      } else if (elem.type === 'string') {
        emitGidsWithSpacers(bytesToGids(elem.value), parts);
      } else {
        return null;
      }
    }
    return `[${parts.join(' ')}]`;
  }

  // Tj, ' and " each take a single string operand.
  let bytes = '';
  if (operand.type === 'hexstring') {
    for (let j = 0; j + 1 < operand.value.length; j += 2) {
      bytes += String.fromCharCode(parseInt(operand.value.slice(j, j + 2), 16));
    }
  } else if (operand.type === 'string') {
    bytes = operand.value;
  } else {
    return null;
  }
  const gids = bytesToGids(bytes);
  // Single-char strings need no spacer and stay as Tj.
  // Multi-char strings emit as a TJ array with compensating spacers, which is only valid for
  // plain `Tj`. The move-to-next-line semantics of `'` and `"` aren't reproducible by TJ, so
  // those are recoded in place (Tc spacing brings most viewers close enough for line-starting glyphs).
  if (gids.length <= 1 || op !== 'Tj') {
    let hex = '';
    for (const g of gids) hex += codeToHex(g);
    return `<${hex}>`;
  }
  const parts = [];
  emitGidsWithSpacers(gids, parts);
  // If no spacers were inserted (all gid advances were exactly 1000), emitGidsWithSpacers
  // compacted everything into one hex blob and the TJ wrap is redundant.
  // Fall back to a plain Tj operand to keep the stream compact.
  if (parts.length === 1) return parts[0];
  return { op: 'TJ', text: `[${parts.join(' ')}]` };
}

/**
 * Walk a content stream and rewrite Tj/TJ/'/" operands whose active font is in
 * `charCodeToGidByTag`. Other operators and operands pass through verbatim.
 *
 * @param {string} streamText
 * @param {Map<string, Map<number, number>>} charCodeToGidByTag - Font tag -> charCode->gid map.
 *   Only fonts present in this map are rewritten. Others are left alone.
 * @param {Map<string, Map<number, number>>} gidToAdvanceByTag - Font tag -> gid->advance map.
 * @returns {{ changed: boolean, text: string }}
 */
function rewriteStreamForType3Replacement(streamText, charCodeToGidByTag, gidToAdvanceByTag) {
  const tokens = tokenizeContentStream(streamText);
  /** @type {Array<{type: string, value: any}>} */
  const operandBuf = [];
  /** @type {string[]} */
  const out = [];
  let currentFontTag = null;
  let changed = false;

  const flushOperandsVerbatim = () => {
    for (let i = 0; i < operandBuf.length; i++) {
      out.push(serializeOperand(operandBuf[i]));
      out.push(i + 1 < operandBuf.length ? ' ' : '');
    }
    operandBuf.length = 0;
  };

  for (const tok of tokens) {
    if (tok.type !== 'operator') {
      operandBuf.push(tok);
      continue;
    }
    const op = tok.value;

    if (op === 'Tf') {
      if (operandBuf.length >= 2) {
        const nameTok = operandBuf[operandBuf.length - 2];
        if (nameTok && nameTok.type === 'name') currentFontTag = nameTok.value;
      }
      flushOperandsVerbatim();
      out.push(' ', op, '\n');
      continue;
    }

    const isTextShow = op === 'Tj' || op === 'TJ' || op === "'" || op === '"';
    const map = isTextShow && currentFontTag ? charCodeToGidByTag.get(currentFontTag) : null;
    const advMap = isTextShow && currentFontTag ? gidToAdvanceByTag.get(currentFontTag) : null;
    if (isTextShow && map && advMap) {
      // ' takes one operand (string). " takes three (aw, ac, string).
      // Tj takes one. TJ takes one (array). Recode the last operand.
      const opIdx = operandBuf.length - 1;
      if (opIdx >= 0) {
        const recoded = recodeOperand(operandBuf[opIdx], op, map, advMap);
        if (recoded !== null) {
          for (let i = 0; i < opIdx; i++) {
            out.push(serializeOperand(operandBuf[i]));
            out.push(' ');
          }
          if (typeof recoded === 'string') {
            out.push(recoded, ' ', op, '\n');
          } else {
            out.push(recoded.text, ' ', recoded.op, '\n');
          }
          operandBuf.length = 0;
          changed = true;
          continue;
        }
      }
    }

    flushOperandsVerbatim();
    out.push(' ', op, '\n');
  }

  // Trailing operands without a closing operator: emit verbatim.
  if (operandBuf.length > 0) {
    flushOperandsVerbatim();
  }

  return { changed, text: changed ? out.join('') : streamText };
}

/**
 * Build the per-font charCode->GID map and per-GID ToUnicode override map.
 *
 * @param {ReturnType<typeof opentype.parse>} otFont - Parsed OpenType font
 * @param {{ encoding: Record<number, string>, glyphs: Record<string, { commands?: any[], advanceWidth?: number, pathHash?: string|null }> }} type3Info - parseType3Font output
 * @param {Map<string, string>} type3GlyphMappings - User mapping (pathHash -> unicode)
 * @param {Map<string, string>} pathHashByGlyphName - glyphName -> pathHash (paths only)
 * @returns {{ charCodeToGid: Map<number, number>, toUnicodeOverride: Map<number, string> }}
 */
function buildPerFontMaps(otFont, type3Info, type3GlyphMappings, pathHashByGlyphName) {
  // `extractType3Fonts` rebuilds the CFF with each Type3 glyph at GID 1..N in CharProcs order
  // (`.notdef` at GID 0) and glyph names matching the CharProcs keys, bridging charCode -> glyphName -> GID.
  /** @type {Map<string, number>} */
  const nameToGid = new Map();
  for (let i = 0; i < otFont.glyphs.length; i++) {
    const g = otFont.glyphs.glyphs[String(i)];
    if (g && g.name) nameToGid.set(g.name, i);
  }

  /** @type {Map<number, number>} */
  const charCodeToGid = new Map();
  /** @type {Map<number, string>} */
  const toUnicodeOverride = new Map();

  for (const [charCodeStr, glyphName] of Object.entries(type3Info.encoding)) {
    const charCode = Number(charCodeStr);
    const gid = nameToGid.get(glyphName);
    if (gid == null) continue;
    charCodeToGid.set(charCode, gid);
    const t3Glyph = type3Info.glyphs[glyphName];
    const pathHash = pathHashByGlyphName.get(glyphName);
    const mapped = pathHash ? type3GlyphMappings.get(pathHash) : undefined;
    if (mapped !== undefined && mapped.length > 0) {
      toUnicodeOverride.set(gid, mapped);
    } else if (t3Glyph
      && (!t3Glyph.commands || t3Glyph.commands.length === 0)
      && typeof t3Glyph.advanceWidth === 'number' && t3Glyph.advanceWidth > 0) {
      // Empty-path glyphs (no commands, positive advance) are spaces. Caller mappings only
      // cover glyphs with pathHashes, so without this they extract as the PUA placeholder
      // extractType3Fonts assigns by default.
      toUnicodeOverride.set(gid, ' ');
    }
  }
  return { charCodeToGid, toUnicodeOverride };
}

/**
 * Replace broken-encoding Type3 fonts in a PDF with Type0 (CIDFontType0C) fonts
 * whose glyph outlines are rebuilt from the source Type3 CharProcs and whose
 * `/ToUnicode` CMap is derived from the application-supplied per-glyph mapping.
 *
 * @param {object} params
 * @param {ArrayBuffer | Uint8Array} params.basePdfData - Source PDF bytes.
 * @param {Map<string, string>} params.type3GlyphMappings - pathHash -> unicode string.
 *   Use `extractType3DistinctGlyphs` to derive the pathHashes. Values may be
 *   multi-codepoint (ligatures). The new mapping always wins over any source
 *   `/ToUnicode` entries for replaced fonts.
 * @param {boolean} [params.humanReadable=false] - Emit uncompressed streams
 *   and hex-wrapped fonts for diffing.
 * @returns {Promise<ArrayBuffer>}
 */
export async function replaceType3FontsWithCorrected({
  basePdfData, type3GlyphMappings, humanReadable = false,
}) {
  const pdfBytes = basePdfData instanceof Uint8Array
    ? basePdfData
    : new Uint8Array(basePdfData);
  const text = new TextDecoder('latin1').decode(pdfBytes);

  const xrefOffset = findXrefOffset(pdfBytes);
  const xrefEntries = parseXref(pdfBytes, xrefOffset);
  const objCache = new ObjectCache(pdfBytes, xrefEntries);
  // Doc-wide object enumeration below needs the complete xref, so finish the deferred repair.
  objCache.ensureXrefRepaired();
  const { rootRef } = parseTrailerInfo(text, xrefOffset);

  const otFontsByObjNum = extractType3Fonts(pdfBytes);
  const replacedObjNums = Object.keys(otFontsByObjNum).map(Number);
  if (replacedObjNums.length === 0) {
    return pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength);
  }

  const distinctGlyphs = extractType3DistinctGlyphs(pdfBytes);
  /** @type {Map<number, Map<string, string>>} fontObjNum -> glyphName -> pathHash */
  const pathHashByGlyphNamePerFont = new Map();
  for (const g of distinctGlyphs) {
    if (!pathHashByGlyphNamePerFont.has(g.exampleFontObjNum)) {
      pathHashByGlyphNamePerFont.set(g.exampleFontObjNum, new Map());
    }
    pathHashByGlyphNamePerFont.get(g.exampleFontObjNum).set(g.exampleGlyphName, g.pathHash);
  }

  // Two `extractType3DistinctGlyphs` entries with the same pathHash collapse to one
  // (the example arbitrarily wins), but a given (fontObjNum, glyphName) is unique to
  // one font and we need pathHashes for every glyphName in every font. So parse each
  // Type3 font directly to enumerate its own CharProcs and recover their pathHashes.
  /** @type {Map<number, ReturnType<typeof parseType3Font>>} */
  const type3InfoByObjNum = new Map();
  /** @type {Map<number, Map<string, string>>} fontObjNum -> glyphName -> pathHash */
  const pathHashByName = new Map();
  for (const objNum of replacedObjNums) {
    const objText = objCache.getObjectText(objNum);
    if (!objText) continue;
    const info = parseType3Font(objText, objCache);
    if (!info) continue;
    type3InfoByObjNum.set(objNum, info);
    const m = new Map();
    for (const [name, glyph] of Object.entries(info.glyphs)) {
      if (glyph && glyph.pathHash) m.set(name, glyph.pathHash);
    }
    pathHashByName.set(objNum, m);
  }

  let nextObjNum = 0;
  for (const k in xrefEntries) {
    const n = Number(k);
    if (n > nextObjNum) nextObjNum = n;
  }
  nextObjNum += 1;

  /** @type {Map<number, { fontDictObjNum: number, fontTag: string }>} */
  const replacementByFontObjNum = new Map();
  /** @type {Map<number, Map<number, number>>} sourceFontObjNum -> charCode -> gid */
  const charCodeToGidByFontObjNum = new Map();
  /** @type {Map<number, Map<number, number>>} sourceFontObjNum -> gid -> advance (1/1000 em) */
  const gidToAdvanceByFontObjNum = new Map();
  /** @type {Array<{objNum: number, content: string | import('./writePdfStreams.js').PdfBinaryObject}>} */
  const newObjects = [];

  for (const objNum of replacedObjNums) {
    const info = type3InfoByObjNum.get(objNum);
    if (!info) continue;
    const fontFile = otFontsByObjNum[objNum].fontFile;
    /** @type {any} */
    const otFont = opentype.parse(fontFile.buffer.slice(
      fontFile.byteOffset, fontFile.byteOffset + fontFile.byteLength,
    ));

    // Type3 fonts in this corpus use placeholder `d1.wx` values, so every rebuilt-CFF glyph
    // shares one advance width. That uniform /W gives downstream readers no per-glyph signal,
    // so they merge adjacent words. Use each glyph's path right-edge as its advance (250 for empty-path spaces).
    for (let i = 1; i < otFont.glyphs.length; i++) {
      const g = otFont.glyphs.glyphs[String(i)];
      if (!g) continue;
      if (g.path && g.path.commands && g.path.commands.length > 0) {
        const bbox = g.getBoundingBox();
        const right = Math.max(0, Math.round(bbox.x2));
        g.advanceWidth = right > 0 ? right : 250;
      } else {
        g.advanceWidth = 250;
      }
    }

    const namesByName = pathHashByName.get(objNum) || new Map();
    const { charCodeToGid, toUnicodeOverride } = buildPerFontMaps(
      otFont,
      info,
      type3GlyphMappings,
      namesByName,
    );

    // Allocate 6 contiguous object numbers for the embedded Type0 font.
    const firstObjIndex = nextObjNum;
    nextObjNum += 6;

    const fontObjStrArr = await createEmbeddedFontType0({
      font: otFont,
      firstObjIndex,
      humanReadable,
      toUnicodeOverride,
    });
    // createEmbeddedFontType0 returns 6 objects: [fontDictObjStr, fontDescObjStr,
    // widthsObjStr, fontFileObj, fontObjStr, toUnicodeObj]. Each is identified by
    // its emitted `${index} 0 obj\n...` header, and the indices are known by construction.
    /** @type {number[]} */
    const objIndices = [
      firstObjIndex, firstObjIndex + 1, firstObjIndex + 2,
      firstObjIndex + 3, firstObjIndex + 4, firstObjIndex + 5,
    ];
    for (let k = 0; k < fontObjStrArr.length; k++) {
      newObjects.push({ objNum: objIndices[k], content: fontObjStrArr[k] });
    }

    replacementByFontObjNum.set(objNum, {
      fontDictObjNum: firstObjIndex,
      fontTag: info.name || `T3R${objNum}`,
    });
    charCodeToGidByFontObjNum.set(objNum, charCodeToGid);
    const gidToAdvance = new Map();
    for (let i = 0; i < otFont.glyphs.length; i++) {
      const g = otFont.glyphs.glyphs[String(i)];
      if (g) gidToAdvance.set(i, Math.round(g.advanceWidth * 1000 / otFont.unitsPerEm));
    }
    gidToAdvanceByFontObjNum.set(objNum, gidToAdvance);
  }

  if (replacementByFontObjNum.size === 0) {
    return pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength);
  }

  const pages = getPageObjects(objCache);

  for (const page of pages) {
    const pageObjText = page.objText;
    /** @type {Map<string, any>} */
    let pageFontInfos;
    try {
      pageFontInfos = parsePageFonts(pageObjText, objCache);
    } catch {
      pageFontInfos = new Map();
    }
    if (!pageFontInfos || pageFontInfos.size === 0) continue;

    /** @type {Array<{ tag: string, sourceObjNum: number, newObjNum: number }>} */
    const tagRedirects = [];
    /** @type {Map<string, Map<number, number>>} */
    const charCodeToGidByTag = new Map();
    /** @type {Map<string, Map<number, number>>} */
    const gidToAdvanceByTag = new Map();
    for (const [tag, fi] of pageFontInfos) {
      if (typeof fi.fontObjNum !== 'number') continue;
      const repl = replacementByFontObjNum.get(fi.fontObjNum);
      if (!repl) continue;
      tagRedirects.push({ tag, sourceObjNum: fi.fontObjNum, newObjNum: repl.fontDictObjNum });
      const m = charCodeToGidByFontObjNum.get(fi.fontObjNum);
      if (m) charCodeToGidByTag.set(tag, m);
      const adv = gidToAdvanceByFontObjNum.get(fi.fontObjNum);
      if (adv) gidToAdvanceByTag.set(tag, adv);
    }
    if (tagRedirects.length === 0) continue;

    const streams = getPageContentStreams(pageObjText, objCache);
    if (!streams || streams.length === 0) continue;
    const merged = streams.join('\n');
    const { changed, text: rewritten } = rewriteStreamForType3Replacement(merged, charCodeToGidByTag, gidToAdvanceByTag);
    if (!changed) continue;

    const newContentObjNum = nextObjNum++;
    const newContent = await encodeStreamObject(newContentObjNum, rewritten, { humanReadable });
    newObjects.push({ objNum: newContentObjNum, content: newContent });

    // Merge /Font redirects into the page's effective /Resources via last-wins.
    const existingResources = resolvePageResources(pageObjText, objCache);
    let overlayFontsStr = '';
    for (const r of tagRedirects) {
      overlayFontsStr += `/${r.tag} ${r.newObjNum} 0 R\n`;
    }
    const mergedResourcesStr = mergeResources(existingResources, overlayFontsStr, '', objCache, '');
    const newResourcesObjNum = nextObjNum++;
    newObjects.push({
      objNum: newResourcesObjNum,
      content: `${newResourcesObjNum} 0 obj\n${mergedResourcesStr}\nendobj\n\n`,
    });

    const newPageObj = buildReplacementPageDict(
      page.objNum, pageObjText, [`${newContentObjNum} 0 R`], newResourcesObjNum, null, [], objCache,
    );
    newObjects.push({ objNum: page.objNum, content: newPageObj });
  }

  // The original Type3 font dicts and their CharProcs streams are replaced, so mark them free in the new xref.
  /** @type {Set<number>} */
  const freedObjNums = new Set();
  for (const objNum of replacedObjNums) {
    if (!replacementByFontObjNum.has(objNum)) continue;
    freedObjNums.add(objNum);
    const info = type3InfoByObjNum.get(objNum);
    if (info && info.charProcObjNums) {
      for (const streamObjNum of Object.values(info.charProcObjNums)) {
        freedObjNums.add(streamObjNum);
      }
    }
  }

  if (newObjects.length === 0) {
    return pdfBytes.buffer.slice(pdfBytes.byteOffset, pdfBytes.byteOffset + pdfBytes.byteLength);
  }

  /** @type {(string | Uint8Array)[]} */
  const appendParts = [];
  let appendByteLen = 0;
  appendParts.push('\n');
  appendByteLen += 1;

  /** @type {Array<{objNum: number, offset: number}>} */
  const newXrefEntries = [];
  for (const obj of newObjects) {
    const offset = pdfBytes.length + appendByteLen;
    newXrefEntries.push({ objNum: obj.objNum, offset });
    const c = obj.content;
    if (typeof c === 'string') {
      appendParts.push(c);
      appendByteLen += c.length;
    } else {
      appendParts.push(c.header);
      appendByteLen += c.header.length;
      appendParts.push(c.streamData);
      appendByteLen += c.streamData.length;
      appendParts.push(c.trailer);
      appendByteLen += c.trailer.length;
    }
  }

  const newXrefOffset = pdfBytes.length + appendByteLen;
  let totalSize = nextObjNum;
  for (const o of newObjects) {
    if (o.objNum + 1 > totalSize) totalSize = o.objNum + 1;
  }
  for (const n of freedObjNums) {
    if (n + 1 > totalSize) totalSize = n + 1;
  }

  const trailerStr = buildIncrementalXrefAndTrailer(
    newXrefEntries, totalSize, xrefOffset, rootRef, newXrefOffset, [...freedObjNums],
  );
  appendParts.push(trailerStr);
  appendByteLen += trailerStr.length;

  const result = new Uint8Array(pdfBytes.length + appendByteLen);
  result.set(pdfBytes);
  let offset = pdfBytes.length;
  for (const part of appendParts) {
    if (typeof part === 'string') {
      for (let i = 0; i < part.length; i++) result[offset++] = part.charCodeAt(i);
    } else {
      result.set(part, offset);
      offset += part.length;
    }
  }
  return result.buffer;
}
