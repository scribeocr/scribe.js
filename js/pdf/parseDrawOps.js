import { tokenizeContentStream } from './parsePdfDoc.js';
import { decodePdfName } from './parsePdfUtils.js';
import { cmykToRgb, tintComponentsToRGB, xyzToSRGB } from './pdfColorFunctions.js';
import { cidCodepoint, isCombiningOrIndicMark, isDefaultIgnorable } from './fonts/convertFontToOTF.js';

/**
 * Multiply two 3x3 affine matrices represented as 6-element arrays [a,b,c,d,e,f].
 * Matrix layout: | a b 0 |   Concatenation: result = m1 * m2
 *                | c d 0 |
 *                | e f 1 |
 * @param {number[]} m1
 * @param {number[]} m2
 */
export function matMul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

/**
 * @typedef {{ type: 'M', x: number, y: number }
 *   | { type: 'L', x: number, y: number }
 *   | { type: 'C', x1: number, y1: number, x2: number, y2: number, x: number, y: number }
 *   | { type: 'Z' }} PathCommand
 */

/**
 * Common optional fields added to ops during parsing (smask, blendMode, clips) or
 * during form XObject flattening (outerSmask). Declared on each op type to avoid
 * "property does not exist" errors from TS checking.
 *
 * @typedef {{ formObjNum: number, type: string, parentCtm?: number[], tr?: object|null, bc?: number[]|null }} SmaskRef
 * @typedef {{ path?: any[]|null, ctm: number[], evenOdd: boolean, textClip?: any[], fromFormObjNum?: number }} ClipEntry
 *
 * @typedef {{ isolated: boolean, knockout: boolean, blendMode?: string,
 *   fillAlpha: number, strokeAlpha: number, smask?: SmaskRef|null,
 *   parentGroupId: number|null }} TransparencyGroupAttrs
 *
 * @typedef {{ patName: string, objNum: number, bbox: number[], xStep: number, yStep: number, matrix: number[], paintType: number, paintColor?: string }} TilingPatternRef
 * @typedef {{ type: number, coords: number[], stops: Array<{offset: number, color: string}>,
 *   extend?: boolean[], bbox?: number[], matrix?: number[], multiply?: boolean }
 *   | { type: 'gouraud', triangles: Array<{vertices: number[][], colors: number[][]}>, matrix?: number[], stops?: undefined }
 *   | { type: 'mesh', patches: Array<{points: number[][][], colors: number[][]}>, matrix?: number[], stops?: undefined }} PatternShading
 *
 * Properties added during form XObject flattening (not present after initial parsing):
 * - overprint: set when ExtGState enables overprint mode
 * - fillColorInherited/strokeColorInherited: markers for form color inheritance resolution
 *
 * @typedef {{ type: 'image', name: string, ctm: number[], fillAlpha: number, strokeAlpha: number,
 *   fillColor: string, strokeColor?: string,
 *   patternShading?: PatternShading, tilingPattern?: TilingPatternRef,
 *   overprint?: boolean, fillColorInherited?: boolean, strokeColorInherited?: boolean,
 *   fillAlphaInherited?: boolean, strokeAlphaInherited?: boolean,
 *   smask?: SmaskRef|null, outerSmask?: SmaskRef|null, groupId?: number,
 *   blendMode?: string, clips?: ClipEntry[] }} ImageDrawOp
 * @typedef {{ type: 'type3glyph', charProcObjNum: number, transform: number[], ctm?: number[],
 *   fillColor: string, fillAlpha: number, strokeAlpha?: number,
 *   strokeColor?: string, type3XObjects?: { [name: string]: number },
 *   patternShading?: PatternShading, tilingPattern?: TilingPatternRef,
 *   overprint?: boolean, fillColorInherited?: boolean, strokeColorInherited?: boolean,
 *   fillAlphaInherited?: boolean, strokeAlphaInherited?: boolean,
 *   smask?: SmaskRef|null, outerSmask?: SmaskRef|null, groupId?: number,
 *   blendMode?: string, clips?: ClipEntry[] }} Type3GlyphOp
 * @typedef {{
 *   type: 'type0text', text: string, fontSize: number, fontFamily: string,
 *   bold: boolean, italic: boolean, x: number, y: number,
 *   a: number, b: number, c: number, d: number, fillColor: string, fillAlpha: number,
 *   textRenderMode: number, strokeColor: string, strokeAlpha: number, lineWidth: number,
 *   ctm?: number[], patternShading?: PatternShading, tilingPattern?: TilingPatternRef,
 *   overprint?: boolean, fillColorInherited?: boolean, strokeColorInherited?: boolean,
 *   fillAlphaInherited?: boolean, strokeAlphaInherited?: boolean,
 *   smask?: SmaskRef|null, outerSmask?: SmaskRef|null, groupId?: number,
 *   blendMode?: string, clips?: ClipEntry[],
 *   pdfGlyphWidth?: number,
 * }} Type0TextOp
 * @typedef {{
 *   type: 'path', commands: PathCommand[], ctm: number[],
 *   fill: boolean, stroke: boolean, evenOdd: boolean,
 *   fillColor: string, strokeColor: string,
 *   lineWidth: number, lineCap: number, lineJoin: number,
 *   miterLimit: number, dashArray: number[], dashPhase: number,
 *   fillAlpha: number, strokeAlpha: number,
 *   patternShading?: PatternShading, strokePatternShading?: PatternShading,
 *   tilingPattern?: TilingPatternRef, strokeTilingPattern?: TilingPatternRef,
 *   overprint?: boolean, fillColorInherited?: boolean, strokeColorInherited?: boolean,
 *   fillAlphaInherited?: boolean, strokeAlphaInherited?: boolean,
 *   smask?: SmaskRef|null, outerSmask?: SmaskRef|null, groupId?: number,
 *   blendMode?: string, clips?: ClipEntry[],
 * }} PathDrawOp
 * @typedef {{ type: 'shading', shading: object, ctm: number[], fillAlpha: number,
 *   fillColor?: string, strokeColor?: string, strokeAlpha?: number,
 *   patternShading?: PatternShading, tilingPattern?: TilingPatternRef,
 *   overprint?: boolean, fillColorInherited?: boolean, strokeColorInherited?: boolean,
 *   fillAlphaInherited?: boolean, strokeAlphaInherited?: boolean,
 *   smask?: SmaskRef|null, outerSmask?: SmaskRef|null, groupId?: number,
 *   blendMode?: string, clips?: ClipEntry[] }} ShadingDrawOp
 * @typedef {{ type: 'inlineImage', dictText: string, imageData: string, ctm: number[],
 *   fillColor: string, fillAlpha: number, strokeColor?: string, strokeAlpha?: number,
 *   patternShading?: PatternShading, tilingPattern?: TilingPatternRef,
 *   overprint?: boolean, fillColorInherited?: boolean, strokeColorInherited?: boolean,
 *   fillAlphaInherited?: boolean, strokeAlphaInherited?: boolean,
 *   smask?: SmaskRef|null, outerSmask?: SmaskRef|null, groupId?: number,
 *   blendMode?: string, clips?: ClipEntry[],
 *   colorSpaces?: Map<string, {type: string, tintSamples: Uint8Array|null, nComponents: number, deviceNGrid?: object|null, indexedInfo?: object|null, labWhitePoint?: number[]|null}>,
 * }} InlineImageOp
 * @typedef {ImageDrawOp | Type3GlyphOp | Type0TextOp | PathDrawOp | ShadingDrawOp | InlineImageOp} DrawOp
 */

/**
 * Parse a content stream and extract image draw operations, Type3 glyph
 * draw operations, and vector path draw operations with their full transforms.
 *
 * @param {string|string[]} contentStream
 * @param {Map<string, object>} fonts - Font map from parsePageFonts
 * @param {Map<string, ExtGStateEntry>} [extGStates] - ExtGState map
 * @param {Map<string, string>} [registeredFontNames]
 * @param {Map<string, {type: string, tintSamples: Uint8Array|null, nComponents: number, deviceNGrid?: object|null, indexedInfo?: object|null, labWhitePoint?: number[]|null}>} [colorSpaces]
 * @param {Set<string>} [symbolFontTags]
 * @param {Set<string>} [cidPUATags]
 * @param {Set<string>} [rawCharCodeTags]
 * @param {Map<string, object>} [shadings]
 * @param {Map<string, object>} [patterns]
 * @param {Map<string, Set<number>>} [cidCollisionMap]
 * @param {object|null} [inheritedTextState] - Text state carried in from an enclosing form XObject
 * @param {Set<string>} [hiddenOCMCNames] - Names in /Resources/Properties whose OCG is OFF; content inside `/OC /<name> BDC ... EMC` for these is not painted
 * @param {boolean[]} [recoveredStreamFlags] - Per-stream flags (index-aligned with `contentStream`).
 *    A stream that only decoded via partial-recovery inflate suppresses painting from its first syntactic anomaly onward.
 * @returns {Array<DrawOp>}
 */
export function parseDrawOps(
  contentStream, fonts, extGStates, registeredFontNames, colorSpaces = new Map(),
  symbolFontTags = new Set(), cidPUATags = new Set(), rawCharCodeTags = new Set(),
  shadings = new Map(), patterns = new Map(), cidCollisionMap = new Map(),
  inheritedTextState = null, hiddenOCMCNames = new Set(), recoveredStreamFlags = [],
) {
  /** @type {Array<DrawOp>} */
  const ops = [];

  // Accept either a single content stream string or an array of stream strings
  // (one per /Contents entry). Per PDF spec §7.8.2, streams in the /Contents
  // array are equivalent to a single concatenated stream — the split between
  // streams may fall between any pair of lexical tokens, including inside an
  // open array (e.g. `[` at the end of one stream and `(text)] TJ` at the
  // start of the next). Tokenizing each stream individually breaks such
  // PDFs, dropping the entire spanning operator. Concatenate before tokenizing.
  const streams = Array.isArray(contentStream) ? contentStream : [contentStream];
  const STREAM_SEP = '\n';
  const tokens = tokenizeContentStream(streams.join(STREAM_SEP));

  // Start offset (in the joined string) of each /Contents entry after the first.
  // A /Contents entry with a damaged FlateDecode tail emits garbled tokens that
  // trip the corruption-suppression threshold. Resetting that state at each
  // boundary keeps the damage from blanking later, intact entries.
  /** @type {number[]} */
  const streamBoundaryOffsets = [];
  if (streams.length > 1) {
    let acc = 0;
    for (let i = 0; i < streams.length - 1; i++) {
      acc += streams[i].length + STREAM_SEP.length;
      streamBoundaryOffsets.push(acc);
    }
  }
  let nextStreamBoundaryIdx = 0;

  // Graphics state
  let ctm = [1, 0, 0, 1, 0, 0];
  /** @type {any[]} */
  const gsStack = [];

  // Synthetic small-caps multiplier — must match FontContainerFont.smallCapsMult
  // (js/containers/fontContainer.js) so the rendered page agrees with the
  // viewer/OCR small-caps treatment.
  const SMALL_CAPS_MULT = 0.75;

  /**
   * Emulate non-embedded small-caps by uppercasing the text and scaling down the font size.
   *
   * @param {string} drawText
   * @param {number[]} trm - per-glyph transform [a,b,c,d,e,f]; mutated when applied.
   * @param {boolean} smallCaps
   */
  function applySmallCaps(drawText, trm, smallCaps) {
    if (!smallCaps) return { text: drawText, applied: false };
    const upper = drawText.toUpperCase();
    if (upper === drawText) return { text: drawText, applied: false };
    trm[0] *= SMALL_CAPS_MULT;
    trm[1] *= SMALL_CAPS_MULT;
    trm[2] *= SMALL_CAPS_MULT;
    trm[3] *= SMALL_CAPS_MULT;
    return { text: upper, applied: true };
  }

  // Text state
  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = [1, 0, 0, 1, 0, 0];
  /** @type {any} */
  let currentFont = null;
  let currentFontTag = '';
  /** @type {Set<string>} Tf tags already warned about, to avoid repeat logs in one stream. */
  const warnedMissingFontTags = new Set();
  let fontSize = 12;
  let tc = inheritedTextState ? inheritedTextState.tc : 0;
  let tw = inheritedTextState ? inheritedTextState.tw : 0;
  let tl = inheritedTextState ? inheritedTextState.tl : 0;
  let tz = inheritedTextState ? inheritedTextState.tz : 100;
  let trise = inheritedTextState ? inheritedTextState.trise : 0;
  let textRenderMode = inheritedTextState ? inheritedTextState.textRenderMode : 0;
  let fillColor = 'black';
  // Per PDF spec §8.10.1, a Form XObject's content stream inherits the graphics
  // state from the caller at the time of `Do`. parseDrawOps starts every stream
  // (including form streams) with parser-default colors, so we track whether the
  // current stream has explicitly set a fill/stroke color yet. Ops emitted while
  // false get an inheritance marker that flattenDrawOps resolves against the
  // parent op's color when expanding the form.
  let fillColorExplicit = false;
  let fillPatternShading = null; // shading data for pattern fills (gradient info)
  let fillTilingPattern = null; // tiling pattern data for pattern fills
  let strokeColor = 'rgb(0,0,0)';
  let strokeColorExplicit = false;
  let strokePatternShading = null; // shading data for pattern strokes
  let strokeTilingPattern = null; // tiling pattern data for pattern strokes
  let fillColorSpaceType = '';
  let strokeColorSpaceType = '';
  /** @type {Uint8Array|null} */
  let fillTintSamples = null;
  let fillTintNComponents = 3;
  let fillDeviceNGrid = null;
  /** @type {{palette: Uint8Array, hival: number, base: string}|null} */
  let fillIndexedInfo = null;
  /** @type {{palette: Uint8Array, hival: number, base: string}|null} */
  let strokeIndexedInfo = null;
  /** @type {Uint8Array|null} */
  let strokeTintSamples = null;
  let strokeTintNComponents = 3;
  let strokeDeviceNGrid = null;
  /** @type {number[]|null} */
  let fillLabWhitePoint = null;
  /** @type {number[]|null} */
  let strokeLabWhitePoint = null;
  let fillAlpha = 1;
  let strokeAlpha = 1;
  // A `gs` inside a form replaces the inherited fill/stroke alpha rather than
  // compounding with it, so ops emitted before the first alpha-setting `gs` get
  // an inheritance marker and the rest do not.
  let fillAlphaExplicit = false;
  let strokeAlphaExplicit = false;
  let overprint = false;
  let blendMode = 'Normal';
  let lineWidth = 1;
  let lineCap = 0;
  let lineJoin = 0;
  let miterLimit = 10;
  let dashArray = /** @type {number[]} */ ([]);
  let dashPhase = 0;

  // Path construction state
  /** @type {PathCommand[]} */
  let currentPath = [];
  let curX = 0;
  let curY = 0;
  let pathStartX = 0;
  let pathStartY = 0;

  // Clipping state
  let pendingClip = false; // true after W/W* until next paint/n
  let pendingClipEvenOdd = false; // true if W* (even-odd clipping)
  /** @type {Array<{path: PathCommand[], ctm: number[], evenOdd: boolean}>} */
  /** @type {ClipEntry[]} */
  let clipStack = [];

  // Text clipping: Tr modes 4-7 accumulate text outlines for clipping.
  // At ET, the accumulated text shapes become a clip that affects subsequent ops.
  /** @type {Array<{text: string, fontFamily: string, fontSize: number, a: number, b: number, c: number, d: number, x: number, y: number}>} */
  let textClipChars = [];

  // Soft mask state (from ExtGState /SMask)
  /** @type {{ formObjNum: number, type: string }|null} */
  /** @type {SmaskRef|null} */
  let currentSmask = null;

  /** @type {Array<any>} */
  const operandStack = [];

  // When a non-finite number (NaN) is detected in the token stream, it signals
  // corrupted content data. In that case we flush the current path and enter
  // skip mode: discard path construction ops until a painting op resets state.
  let skipCorruptedPath = false;

  // Corruption detection: count path-op anomalies (excess operands, out-of-bounds
  // coordinates, leftover operands at paint ops). A high count signals a corrupted
  // deflate stream where missing whitespace/periods produce garbled tokens. Once
  // the threshold is reached, stop emitting all subsequent draw ops to prevent
  // garbled fills from covering correctly-rendered content.
  let pathAnomalyCount = 0;
  let streamCorrupted = false;

  // A stream recovered via partial-recovery inflate is known-corrupt.
  // Its valid prefix is anomaly-free, so the first syntactic anomaly marks the garbled tail.
  // A clean stream uses a higher threshold so ordinary content is never suppressed.
  // Updated at each stream boundary from the current stream's recovery flag.
  let corruptionThreshold = recoveredStreamFlags[0] ? 1 : 5;

  /** @type {boolean[]} Nesting of BDC/BMC marked-content blocks; entry = whether hidden by OC */
  const mcStack = [];
  let ocHidden = false;

  /**
   * Emit Type3 glyph ops for a literal string.
   * @param {string} str
   */
  function showType3Literal(str) {
    if (!currentFont || !currentFont.type3) return;
    const { encoding, charProcObjNums, fontMatrix } = currentFont.type3;
    for (let i = 0; i < str.length; i++) {
      const charCode = str.charCodeAt(i);
      const glyphName = encoding[charCode];
      const charProcObjNum = glyphName ? charProcObjNums[glyphName] : undefined;
      const glyphWidth = (currentFont.widths.get(charCode) ?? currentFont.defaultWidth) / 1000 * fontSize;

      if (charProcObjNum !== undefined && textRenderMode !== 3) {
        // Compute text rendering matrix: Trm = [fontSize, 0, 0, fontSize, 0, 0] * Tm * CTM
        const trm = matMul([fontSize * tz / 100, 0, 0, fontSize, 0, trise], matMul(tm, ctm));
        const transform = matMul(fontMatrix, trm);
        const type3XObjects = currentFont.type3?.xobjectResources;
        /** @type {Type3GlyphOp} */
        const type3Op = {
          type: 'type3glyph', charProcObjNum, transform, fillColor, fillAlpha, type3XObjects,
        };
        if (!fillColorExplicit) type3Op.fillColorInherited = true;
        if (!fillAlphaExplicit) type3Op.fillAlphaInherited = true;
        ops.push(type3Op);
      }

      const advance = (glyphWidth + tc + (charCode === 0x20 ? tw : 0)) * tz / 100;
      tm[4] += advance * tm[0];
      tm[5] += advance * tm[1];
    }
  }

  /**
   * Emit Type3 glyph ops for a hex string.
   * @param {string} hex
   */
  function showType3Hex(hex) {
    if (!currentFont || !currentFont.type3) return;
    const { encoding, charProcObjNums, fontMatrix } = currentFont.type3;
    // Type3 fonts are always simple fonts, so each byte is one character code.
    for (let i = 0; i + 2 <= hex.length; i += 2) {
      const charCode = parseInt(hex.substring(i, i + 2), 16);
      const glyphName = encoding[charCode];
      const charProcObjNum = glyphName ? charProcObjNums[glyphName] : undefined;
      const glyphWidth = (currentFont.widths.get(charCode) ?? currentFont.defaultWidth) / 1000 * fontSize;

      if (charProcObjNum !== undefined && textRenderMode !== 3) {
        const trm = matMul([fontSize * tz / 100, 0, 0, fontSize, 0, trise], matMul(tm, ctm));
        const transform = matMul(fontMatrix, trm);
        const type3XObjects = currentFont.type3?.xobjectResources;
        /** @type {Type3GlyphOp} */
        const type3Op = {
          type: 'type3glyph', charProcObjNum, transform, fillColor, fillAlpha, type3XObjects,
        };
        if (!fillColorExplicit) type3Op.fillColorInherited = true;
        if (!fillAlphaExplicit) type3Op.fillAlphaInherited = true;
        ops.push(type3Op);
      }

      const advance = (glyphWidth + tc + (charCode === 0x20 ? tw : 0)) * tz / 100;
      tm[4] += advance * tm[0];
      tm[5] += advance * tm[1];
    }
  }

  /**
   * Advance text position for standard fonts (with optional CSS text rendering).
   * @param {string} str
   */
  function advanceLiteral(str) {
    if (!currentFont) return;
    const registeredName = registeredFontNames && registeredFontNames.get(currentFontTag);
    // See the long comment in advanceHex for why codespace ranges matter here:
    // a non-embedded Type0 CID font with a mixed 1-byte/2-byte predefined CMap
    // (e.g. /83pv-RKSJ-H) must decode 1-byte ASCII codes as 1 byte, not 2.
    const csRanges = currentFont.codespaceRanges;
    let i = 0;
    while (i < str.length) {
      let charCode;
      let numBytes = 1;
      if (csRanges) {
        const byte0 = str.charCodeAt(i);
        let matched = false;
        for (let r = 0; r < csRanges.length; r++) {
          const range = csRanges[r];
          if (range.bytes === 1) {
            if (byte0 >= range.low && byte0 <= range.high) {
              charCode = byte0;
              numBytes = 1;
              matched = true;
              break;
            }
          } else if (range.bytes === 2 && i + 1 < str.length) {
            const code2 = (byte0 << 8) | str.charCodeAt(i + 1);
            if (code2 >= range.low && code2 <= range.high) {
              charCode = code2;
              numBytes = 2;
              matched = true;
              break;
            }
          }
        }
        if (!matched) {
          if (i + 1 < str.length) {
            charCode = (byte0 << 8) | str.charCodeAt(i + 1);
            numBytes = 2;
          } else {
            charCode = byte0;
            numBytes = 1;
          }
        }
      } else {
        charCode = str.charCodeAt(i);
        numBytes = 1;
      }
      const glyphWidth = (currentFont.widths.get(charCode) ?? currentFont.defaultWidth) / 1000 * fontSize;
      const unicode = currentFont.toUnicode.get(charCode)
        || (numBytes === 1 ? str[i] : String.fromCharCode(charCode));
      const drawText = currentFont.encodingUnicode?.get(charCode) || unicode;
      // Skip zero-width characters
      if (registeredName && textRenderMode !== 3 && glyphWidth !== 0 && drawText && drawText.trim().length > 0) {
        const trm = matMul([fontSize * tz / 100, 0, 0, fontSize, 0, trise], matMul(tm, ctm));
        const sc = applySmallCaps(drawText, trm, !!currentFont.smallCaps);
        /** @type {Type0TextOp} */
        const textOp = {
          type: 'type0text',
          text: sc.text,
          fontSize,
          fontFamily: registeredName,
          bold: currentFont.bold,
          italic: currentFont.italic,
          x: trm[4],
          y: trm[5],
          a: trm[0],
          b: trm[1],
          c: trm[2],
          d: trm[3],
          fillColor,
          fillAlpha,
          textRenderMode,
          strokeColor,
          strokeAlpha,
          lineWidth: lineWidth * Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])),
        };
        if (!fillColorExplicit) textOp.fillColorInherited = true;
        if (!fillAlphaExplicit) textOp.fillAlphaInherited = true;
        if (!strokeColorExplicit) textOp.strokeColorInherited = true;
        if (!strokeAlphaExplicit) textOp.strokeAlphaInherited = true;
        ops.push(textOp);
      }
      i += numBytes;
      const isWordSpace = numBytes === 1 && charCode === 0x20;
      if (currentFont.verticalMode) {
        const vAdvance = (-fontSize + tc + (isWordSpace ? tw : 0)) * tz / 100;
        tm[4] += vAdvance * tm[2];
        tm[5] += vAdvance * tm[3];
      } else {
        const advance = (glyphWidth + tc + (isWordSpace ? tw : 0)) * tz / 100;
        tm[4] += advance * tm[0];
        tm[5] += advance * tm[1];
      }
    }
  }

  // Track last drawn hex string to detect duplicate rendering across font switches.
  // PDFs may interleave embedded and non-embedded sibling CID fonts where both render
  // the same hex string — the embedded font draws the glyphs, the non-embedded font
  // provides advance widths. Without dedup, characters appear doubled.
  let lastDrawnHex = '';
  let lastDrawnFontTag = '';

  /**
   * Advance text position for standard font hex strings (with optional CSS text rendering).
   * @param {string} hex
   */
  function advanceHex(hex) {
    if (!currentFont) return;
    const registeredName = registeredFontNames && registeredFontNames.get(currentFontTag);
    const usePUA = cidPUATags.has(currentFontTag);
    // Some Type0 CID fonts reach this function because their descendant CIDFont
    // has no embedded FontFile (fontObj.type0 is null), so showString routes
    // them here instead of to showType0Hex. Such fonts may carry codespaceRanges
    // from a predefined CMap like /83pv-RKSJ-H that mixes 1-byte ASCII with
    // 2-byte Shift-JIS codes; without honoring those ranges, ASCII hex like
    // <4E6F7420> ("Not ") gets decoded as two 2-byte CIDs (0x4E6F, 0x7420) and
    // fed to String.fromCharCode, producing CJK codepoints (乯, 琠) instead of Latin letters.
    const csRanges = currentFont.codespaceRanges;
    // Dedup: if the exact same hex string was just drawn by a different font (sibling),
    // skip drawing entirely — just advance the text position.
    const isDup = hex === lastDrawnHex && lastDrawnFontTag !== currentFontTag && lastDrawnHex.length > 0;
    let i = 0;
    while (i < hex.length) {
      let charCode = 0;
      let hexDigits = 4;
      if (csRanges && i + 1 < hex.length) {
        const byte0 = parseInt(hex.substring(i, i + 2), 16);
        let matched = false;
        for (let r = 0; r < csRanges.length; r++) {
          const range = csRanges[r];
          if (range.bytes === 1) {
            if (byte0 >= range.low && byte0 <= range.high) {
              charCode = byte0;
              hexDigits = 2;
              matched = true;
              break;
            }
          } else if (range.bytes === 2 && i + 3 < hex.length) {
            const code2 = parseInt(hex.substring(i, i + 4), 16);
            if (code2 >= range.low && code2 <= range.high) {
              charCode = code2;
              hexDigits = 4;
              matched = true;
              break;
            }
          }
        }
        if (!matched) {
          if (i + 3 < hex.length) {
            charCode = parseInt(hex.substring(i, i + 4), 16);
            hexDigits = 4;
          } else {
            charCode = parseInt(hex.substring(i, i + 2), 16);
            hexDigits = 2;
          }
        }
      } else {
        if (i + 3 >= hex.length) break;
        charCode = parseInt(hex.substring(i, i + 4), 16);
        hexDigits = 4;
      }
      const glyphWidth = (currentFont.widths.get(charCode) ?? currentFont.defaultWidth) / 1000 * fontSize;
      if (!isDup) {
        const tuStr = currentFont.toUnicode.get(charCode);
        const encStr = currentFont.encodingUnicode?.get(charCode);
        // Draw nothing rather than fabricating String.fromCharCode(charCode) for a glyph we cannot render.
        // usePUA false with an embedded CID fontFile and no ToUnicode means the rebuild failed, so the code is a glyph index, not Unicode.
        const embeddedGlyphUnavailable = !usePUA && !tuStr && !encStr && !!currentFont.type0?.fontFile && !(currentFont.toUnicode?.size);
        const collided = cidCollisionMap.get(currentFontTag)?.has(charCode);
        const drawText = usePUA
          ? String.fromCodePoint(cidCodepoint(collided ? undefined : tuStr, charCode).codepoint)
          : (embeddedGlyphUnavailable ? '' : (encStr || tuStr || String.fromCharCode(charCode)));
        if (registeredName && textRenderMode !== 3 && drawText && drawText.trim().length > 0) {
          const trm = matMul([fontSize * tz / 100, 0, 0, fontSize, 0, trise], matMul(tm, ctm));
          const sc = applySmallCaps(drawText, trm, !!currentFont.smallCaps);
          /** @type {Type0TextOp} */
          const textOp = {
            type: 'type0text',
            text: sc.text,
            fontSize,
            fontFamily: registeredName,
            bold: currentFont.bold,
            italic: currentFont.italic,
            x: trm[4],
            y: trm[5],
            a: trm[0],
            b: trm[1],
            c: trm[2],
            d: trm[3],
            fillColor,
            fillAlpha,
            textRenderMode,
            strokeColor,
            strokeAlpha,
            lineWidth: lineWidth * Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])),
          };
          if (!fillColorExplicit) textOp.fillColorInherited = true;
          if (!fillAlphaExplicit) textOp.fillAlphaInherited = true;
          if (!strokeColorExplicit) textOp.strokeColorInherited = true;
          if (!strokeAlphaExplicit) textOp.strokeAlphaInherited = true;
          ops.push(textOp);
        }
      }
      i += hexDigits;
      const isWordSpace = hexDigits === 2 && charCode === 0x20;
      if (currentFont.verticalMode) {
        const vAdv = (-fontSize + tc + (isWordSpace ? tw : 0)) * tz / 100;
        tm[4] += vAdv * tm[2];
        tm[5] += vAdv * tm[3];
      } else {
        const advance = (glyphWidth + tc + (isWordSpace ? tw : 0)) * tz / 100;
        tm[4] += advance * tm[0];
        tm[5] += advance * tm[1];
      }
    }
    lastDrawnHex = hex;
    lastDrawnFontTag = currentFontTag;
  }

  /**
   * Emit Type0 text ops for a hex string (2-byte CID encoding).
   * @param {string} hex
   */
  function showType0Hex(hex) {
    if (!currentFont || !currentFont.type0) return;
    const registeredName = registeredFontNames && registeredFontNames.get(currentFontTag);
    if (!registeredName) return;
    const usePUA = cidPUATags.has(currentFontTag);
    const cmapLookup = currentFont.charCodeToCID;
    const csRanges = currentFont.codespaceRanges;
    let i = 0;
    while (i < hex.length) {
      let charCode;
      let hexDigits = 4; // default 2-byte = 4 hex digits
      if (csRanges && i + 1 < hex.length) {
        const byte0 = parseInt(hex.substring(i, i + 2), 16);
        let matched = false;
        for (let r = 0; r < csRanges.length; r++) {
          const range = csRanges[r];
          if (range.bytes === 1) {
            if (byte0 >= range.low && byte0 <= range.high) {
              charCode = byte0;
              hexDigits = 2;
              matched = true;
              break;
            }
          } else if (range.bytes === 2 && i + 3 < hex.length) {
            const code2 = parseInt(hex.substring(i, i + 4), 16);
            if (code2 >= range.low && code2 <= range.high) {
              charCode = code2;
              hexDigits = 4;
              matched = true;
              break;
            }
          }
        }
        if (!matched) {
          if (i + 3 < hex.length) {
            charCode = parseInt(hex.substring(i, i + 4), 16);
          } else {
            charCode = parseInt(hex.substring(i, i + 2), 16);
            hexDigits = 2;
          }
        }
      } else {
        if (i + 3 >= hex.length) break;
        charCode = parseInt(hex.substring(i, i + 4), 16);
      }
      i += hexDigits;
      const cid = cmapLookup ? (cmapLookup.get(charCode) ?? charCode) : charCode;
      const rawWidth = currentFont.widths.get(cid) ?? currentFont.defaultWidth;
      const glyphWidth = rawWidth / 1000 * fontSize;
      if (textRenderMode !== 3) {
        const trm = matMul([fontSize * tz / 100, 0, 0, fontSize, 0, trise], matMul(tm, ctm));
        // Use cidCodepoint() to select real Unicode or PUA — must match the font builder.
        // ToUnicode CMap maps charCodes (not CIDs) to Unicode, so use charCode for lookup.
        const collided = cidCollisionMap.get(currentFontTag)?.has(cid);
        const tuStr = currentFont.toUnicode?.get(charCode);
        // For a glyph from an embedded CID font we could not rebuild, draw nothing (advance only),
        // rather than fabricating String.fromCharCode(charCode), as the empty embedded glyph would.
        // A successful no-ToUnicode embedded rebuild keys its glyphs in the PUA and sets usePUA,
        // so reaching here with usePUA false (an embedded fontFile, no ToUnicode)
        // means the code is a glyph index into a font we cannot render, not Unicode.
        const embeddedGlyphUnavailable = !usePUA && !tuStr
          && !!currentFont.type0?.fontFile && !(currentFont.toUnicode?.size);
        const unicode = usePUA
          ? String.fromCodePoint(cidCodepoint(collided ? undefined : tuStr, cid).codepoint)
          : (embeddedGlyphUnavailable ? '' : (tuStr || String.fromCharCode(charCode)));
        if (unicode && unicode.trim().length > 0) {
          const isNonEmbedded = !!(currentFont.type0 && !currentFont.type0.fontFile);
          const sc = applySmallCaps(unicode, trm, isNonEmbedded && !!currentFont.smallCaps);
          /** @type {Type0TextOp} */
          const opObj = {
            type: 'type0text',
            text: sc.text,
            fontSize,
            fontFamily: registeredName,
            bold: currentFont.bold,
            italic: currentFont.italic,
            x: trm[4],
            y: trm[5],
            a: trm[0],
            b: trm[1],
            c: trm[2],
            d: trm[3],
            fillColor,
            fillAlpha,
            textRenderMode,
            strokeColor,
            strokeAlpha,
            lineWidth: lineWidth * Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])),
          };
          if (isNonEmbedded && !sc.applied) {
            opObj.pdfGlyphWidth = rawWidth;
          }
          if (!fillColorExplicit) opObj.fillColorInherited = true;
          if (!fillAlphaExplicit) opObj.fillAlphaInherited = true;
          if (!strokeColorExplicit) opObj.strokeColorInherited = true;
          if (!strokeAlphaExplicit) opObj.strokeAlphaInherited = true;
          ops.push(opObj);
        }
      }
      const isWordSpace = hexDigits === 2 && charCode === 0x20;
      if (currentFont.verticalMode) {
        const vAdvance = (-fontSize + tc + (isWordSpace ? tw : 0)) * tz / 100;
        tm[4] += vAdvance * tm[2];
        tm[5] += vAdvance * tm[3];
      } else {
        const advance = (glyphWidth + tc + (isWordSpace ? tw : 0)) * tz / 100;
        tm[4] += advance * tm[0];
        tm[5] += advance * tm[1];
      }
    }
    lastDrawnHex = hex;
    lastDrawnFontTag = currentFontTag;
  }

  /**
   * Emit Type0 text ops for a literal string (single-byte encoding).
   * @param {string} str
   */
  function showType0Literal(str) {
    if (!currentFont || !currentFont.type0) return;
    const registeredName = registeredFontNames && registeredFontNames.get(currentFontTag);
    if (!registeredName) return;
    const usePUA = cidPUATags.has(currentFontTag);
    const cmapLookup = currentFont.charCodeToCID;
    const csRanges = currentFont.codespaceRanges;
    // Type0/CID fonts typically use 2-byte encoding, but some CMaps define
    // mixed-width codespace ranges (e.g. 1-byte for space, 2-byte for CIDs).
    let i = 0;
    while (i < str.length) {
      let charCode;
      let numBytes = 2;
      if (csRanges) {
        const byte0 = str.charCodeAt(i);
        let matched = false;
        for (let r = 0; r < csRanges.length; r++) {
          const range = csRanges[r];
          if (range.bytes === 1) {
            if (byte0 >= range.low && byte0 <= range.high) {
              charCode = byte0;
              numBytes = 1;
              matched = true;
              break;
            }
          } else if (range.bytes === 2 && i + 1 < str.length) {
            const code2 = (byte0 << 8) | str.charCodeAt(i + 1);
            if (code2 >= range.low && code2 <= range.high) {
              charCode = code2;
              numBytes = 2;
              matched = true;
              break;
            }
          }
        }
        if (!matched) {
          if (i + 1 < str.length) {
            charCode = (byte0 << 8) | str.charCodeAt(i + 1);
          } else {
            charCode = byte0;
            numBytes = 1;
          }
        }
      } else {
        if (i + 1 >= str.length) break;
        charCode = (str.charCodeAt(i) << 8) | str.charCodeAt(i + 1);
      }
      i += numBytes;
      const cid = cmapLookup ? (cmapLookup.get(charCode) ?? charCode) : charCode;
      const rawWidth = currentFont.widths.get(cid) ?? currentFont.defaultWidth;
      const glyphWidth = rawWidth / 1000 * fontSize;
      if (textRenderMode !== 3) {
        const trm = matMul([fontSize * tz / 100, 0, 0, fontSize, 0, trise], matMul(tm, ctm));
        // Use cidCodepoint() to select real Unicode or PUA — must match the font builder.
        // ToUnicode CMap maps charCodes (not CIDs) to Unicode, so use charCode for lookup.
        const collided = cidCollisionMap.get(currentFontTag)?.has(cid);
        const tuStr = currentFont.toUnicode?.get(charCode);
        // For a glyph from an embedded CID font we could not rebuild, draw nothing (advance only),
        // rather than fabricating String.fromCharCode(charCode), as the empty embedded glyph would.
        // A successful no-ToUnicode embedded rebuild keys its glyphs in the PUA and sets usePUA,
        // so reaching here with usePUA false (an embedded fontFile, no ToUnicode)
        // means the code is a glyph index into a font we cannot render, not Unicode.
        const embeddedGlyphUnavailable = !usePUA && !tuStr
          && !!currentFont.type0?.fontFile && !(currentFont.toUnicode?.size);
        const unicode = usePUA
          ? String.fromCodePoint(cidCodepoint(collided ? undefined : tuStr, cid).codepoint)
          : (embeddedGlyphUnavailable ? '' : (tuStr || String.fromCharCode(charCode)));
        if (unicode && unicode.trim().length > 0) {
          const isNonEmbedded = !!(currentFont.type0 && !currentFont.type0.fontFile);
          const sc = applySmallCaps(unicode, trm, isNonEmbedded && !!currentFont.smallCaps);
          /** @type {Type0TextOp} */
          const opObj = {
            type: 'type0text',
            text: sc.text,
            fontSize,
            fontFamily: registeredName,
            bold: currentFont.bold,
            italic: currentFont.italic,
            x: trm[4],
            y: trm[5],
            a: trm[0],
            b: trm[1],
            c: trm[2],
            d: trm[3],
            fillColor,
            fillAlpha,
            textRenderMode,
            strokeColor,
            strokeAlpha,
            lineWidth: lineWidth * Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])),
          };
          if (isNonEmbedded && !sc.applied) {
            opObj.pdfGlyphWidth = rawWidth;
          }
          if (!fillColorExplicit) opObj.fillColorInherited = true;
          if (!fillAlphaExplicit) opObj.fillAlphaInherited = true;
          if (!strokeColorExplicit) opObj.strokeColorInherited = true;
          if (!strokeAlphaExplicit) opObj.strokeAlphaInherited = true;
          ops.push(opObj);
        }
      }
      const isWordSpace = numBytes === 1 && charCode === 0x20;
      if (currentFont.verticalMode) {
        // Vertical writing: advance downward (w1 default = -1000 units)
        const vAdvance = (-fontSize + tc + (isWordSpace ? tw : 0)) * tz / 100;
        tm[4] += vAdvance * tm[2];
        tm[5] += vAdvance * tm[3];
      } else {
        const advance = (glyphWidth + tc + (isWordSpace ? tw : 0)) * tz / 100;
        tm[4] += advance * tm[0];
        tm[5] += advance * tm[1];
      }
    }
  }

  /**
   * Emit text ops for a Type1/TrueType literal string (single-byte encoding).
   * @param {string} str
   */
  function showType1Literal(str) {
    if (!currentFont || !currentFont.type1) return;
    const registeredName = registeredFontNames && registeredFontNames.get(currentFontTag);
    if (!registeredName) return;
    const isSymbol = symbolFontTags.has(currentFontTag);
    const isRawCharCode = rawCharCodeTags.has(currentFontTag);
    const hasPUA = cidPUATags.has(currentFontTag);
    const isNonEmbedded = !currentFont.type1.fontFile;
    const hasDifferences = !!(currentFont.differences && Object.keys(currentFont.differences).length > 0);
    for (let i = 0; i < str.length; i++) {
      const charCode = str.charCodeAt(i);
      const rawWidth = currentFont.widths.get(charCode) ?? currentFont.defaultWidth;
      const glyphWidth = rawWidth / 1000 * fontSize;
      const unicode = currentFont.toUnicode.get(charCode) || str[i];
      // A glyph's ToUnicode can be whitespace even when the glyph is visible (e.g. a leader-dot period whose ToUnicode is a space).
      // Gate rendering on drawDefault, which prefers the encoding glyph, so it is not skipped.
      const drawDefault = currentFont.encodingUnicode?.get(charCode) || unicode;
      // For PUA-mapped chars without AGL encoding, the charCode may be a control
      // or whitespace char (e.g. charCode 32 mapped to custom glyph G31). Use PUA
      // codepoint which is always non-whitespace, bypassing the trim() skip below.
      // Use PUA when: (a) charCode is in /Differences, (b) font has no /Differences
      // (relying on CFF built-in encoding, e.g., TeX CMSY10), or (c) charCode is NOT
      // in /Differences but also has no AGL/encoding mapping (custom CFF glyph names
      // like C0083 that only work through the built-in encoding's PUA entries).
      // Use PUA when: the font has PUA cmap entries AND the charCode either (a) is a
      // control char, (b) has no AGL/encoding mapping, or (c) is overridden by /Differences
      // (which may map it to a non-AGL glyph name like "boxcheckbld" that only exists in
      // the CFF font's PUA cmap, not in the encoding's Unicode mapping).
      const inDifferences = !!(currentFont.differences && currentFont.differences[charCode] !== undefined);
      // Some subsetters store a visible outline under a glyph name that resolves to
      // whitespace (e.g. a letter named "space"). fillText() silently skips whitespace,
      // so route such codes through their PUA codepoint instead.
      const encWhitespace = charCode >= 0x20 && (currentFont.encodingUnicode?.get(charCode) ?? 'x').trim() === '';
      const usesPUA = hasPUA && (
        (hasDifferences && inDifferences)
        || (!hasDifferences && (charCode < 0x20 || !currentFont.encodingUnicode?.has(charCode)))
        || encWhitespace
        // Charcode with width but no /Differences and no encoding mapping: route through
        // PUA so buildFontFromCFF can resolve it via the embedded font's intrinsic CFF Encoding.
        // Without this, control bytes trim to empty and codes >= 0x20 fall back to the
        // literal byte char, which is the wrong glyph when the CFF encoding diverges from
        // byte-as-Unicode (e.g., a sparse /Differences font where byte 0x20 maps to 'c').
        || (charCode > 0
          && currentFont.widths.has(charCode)
          && !currentFont.toUnicode.has(charCode)
          && !currentFont.encodingUnicode?.has(charCode))
      );
      // Symbol fonts (e.g. Wingdings) use charCodes in 0x01-0x1F range for visible glyphs
      // (circled numbers, arrows, etc.). These charCodes map to JS control characters
      // (\f, \r, etc.) that would be filtered out by trim(). Always render Symbol chars.
      if (textRenderMode !== 3 && (isSymbol || usesPUA || (drawDefault && drawDefault.trim().length > 0))) {
        let trm = matMul([fontSize * tz / 100, 0, 0, fontSize, 0, trise], matMul(tm, ctm));
        // Apply non-standard FontMatrix (shear/flip) from embedded Type1 font program
        const fm = currentFont.type1.fontMatrix;
        if (fm) trm = matMul(fm, trm);
        // For Symbol-encoded fonts, use PUA codepoints (0xF000 + charCode).
        // For fonts with PUA cmap entries, use PUA when the charCode has no AGL mapping.
        // For Mac-only cmap fonts, use raw charCode for drawing — but for Mac-Roman
        // cmaps, use the Mac-Roman Unicode mapping so Chrome resolves the correct glyph.
        // E.g., charCode 0xA5 → U+2022 (•) not U+00A5 (¥).
        let drawText;
        if (isSymbol) {
          drawText = String.fromCharCode(0xF000 + charCode);
        } else if (usesPUA) {
          drawText = String.fromCharCode(0xE000 + charCode);
        } else if (isRawCharCode) {
          // For Mac-only cmap fonts: charCodes >= 0x20 map directly through the font's
          // Mac cmap (the byte position IS the glyph lookup key). Multi-codepoint bfchar
          // entries (conjunct glyphs in Indic fonts, ligatures) AND Indic combining marks
          // use PUA (0xE000 + charCode) to avoid collisions and to bypass Chrome's
          // dotted-circle placeholder for orphan combining marks. Must match
          // convertFontToOTF's rawCharCode path.
          {
            const uniStr = currentFont.toUnicode.get(charCode);
            const firstCp = uniStr ? uniStr.codePointAt(0) : 0;
            const needsPUA = uniStr && ([...uniStr].length > 1 || isCombiningOrIndicMark(firstCp) || isDefaultIgnorable(firstCp));
            if (needsPUA) {
              drawText = String.fromCharCode(0xE000 + charCode);
            } else {
              drawText = uniStr ? String.fromCodePoint(firstCp) : str[i];
            }
          }
        } else {
          drawText = drawDefault;
        }
        const sc = applySmallCaps(drawText, trm, isNonEmbedded && !!currentFont.smallCaps);
        const opObj = {
          type: 'type0text',
          text: sc.text,
          fontSize,
          fontFamily: registeredName,
          bold: currentFont.bold,
          italic: currentFont.italic,
          x: trm[4],
          y: trm[5],
          a: trm[0],
          b: trm[1],
          c: trm[2],
          d: trm[3],
          fillColor,
          fillAlpha,
          textRenderMode,
          strokeColor,
          strokeAlpha,
          lineWidth: lineWidth * Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])),
        };
        if (isNonEmbedded && !sc.applied) opObj.pdfGlyphWidth = rawWidth;
        if (!fillColorExplicit) opObj.fillColorInherited = true;
        if (!fillAlphaExplicit) opObj.fillAlphaInherited = true;
        if (!strokeColorExplicit) opObj.strokeColorInherited = true;
        if (!strokeAlphaExplicit) opObj.strokeAlphaInherited = true;
        ops.push(opObj);
      }
      const advance = (glyphWidth + tc + (charCode === 0x20 ? tw : 0)) * tz / 100;
      tm[4] += advance * tm[0];
      tm[5] += advance * tm[1];
    }
  }

  /**
   * Emit text ops for a Type1/TrueType hex string (single-byte, 2-hex-digit encoding).
   * @param {string} hex
   */
  function showType1Hex(hex) {
    if (!currentFont || !currentFont.type1) return;
    const registeredName = registeredFontNames && registeredFontNames.get(currentFontTag);
    if (!registeredName) return;
    const isSymbol = symbolFontTags.has(currentFontTag);
    const isRawCharCode = rawCharCodeTags.has(currentFontTag);
    const hasPUA = cidPUATags.has(currentFontTag);
    const isNonEmbedded = !currentFont.type1.fontFile;
    const hasDifferences = !!(currentFont.differences && Object.keys(currentFont.differences).length > 0);
    for (let i = 0; i + 1 <= hex.length; i += 2) {
      const charCode = parseInt(hex.substring(i, i + 2), 16);
      const rawWidth = currentFont.widths.get(charCode) ?? currentFont.defaultWidth;
      const glyphWidth = rawWidth / 1000 * fontSize;
      const unicode = currentFont.toUnicode.get(charCode) || String.fromCharCode(charCode);
      // A glyph's ToUnicode can be whitespace even when the glyph is visible (e.g. a leader-dot period whose ToUnicode is a space).
      // Gate rendering on drawDefault, which prefers the encoding glyph, so it is not skipped.
      const drawDefault = currentFont.encodingUnicode?.get(charCode) || unicode;
      const inDifferences = !!(currentFont.differences && currentFont.differences[charCode] !== undefined);
      const encWhitespace = charCode >= 0x20 && (currentFont.encodingUnicode?.get(charCode) ?? 'x').trim() === '';
      const usesPUA = hasPUA && charCode > 0 && (
        (hasDifferences && inDifferences)
        || (!hasDifferences && (charCode < 0x20 || !currentFont.encodingUnicode?.has(charCode)))
        || encWhitespace
        // See showLiteralString: charcodes with widths but no /Differences and no encoding
        // mapping route through PUA so buildFontFromCFF can resolve them via the embedded
        // font's intrinsic CFF Encoding.
        || (currentFont.widths.has(charCode)
          && !currentFont.toUnicode.has(charCode)
          && !currentFont.encodingUnicode?.has(charCode))
      );
      // Skip zero-width characters — the PDF Widths array says these occupy no space,
      // so they should not render visually (common in TeX fonts for unused charCodes).
      if (textRenderMode !== 3 && glyphWidth !== 0 && (isSymbol || usesPUA || (drawDefault && drawDefault.trim().length > 0))) {
        let trm = matMul([fontSize * tz / 100, 0, 0, fontSize, 0, trise], matMul(tm, ctm));
        const fm = currentFont.type1.fontMatrix;
        if (fm) trm = matMul(fm, trm);
        let drawText;
        if (isSymbol) {
          drawText = String.fromCharCode(0xF000 + charCode);
        } else if (usesPUA) {
          drawText = String.fromCharCode(0xE000 + charCode);
        } else if (isRawCharCode) {
          {
            const uniStr = currentFont.toUnicode.get(charCode);
            const firstCp = uniStr ? uniStr.codePointAt(0) : 0;
            const needsPUA = uniStr && ([...uniStr].length > 1 || isCombiningOrIndicMark(firstCp) || isDefaultIgnorable(firstCp));
            if (needsPUA) {
              drawText = String.fromCharCode(0xE000 + charCode);
            } else {
              drawText = uniStr ? String.fromCodePoint(firstCp) : String.fromCharCode(charCode);
            }
          }
        } else {
          drawText = drawDefault;
        }
        const sc = applySmallCaps(drawText, trm, isNonEmbedded && !!currentFont.smallCaps);
        const opObj2 = {
          type: 'type0text',
          text: sc.text,
          fontSize,
          fontFamily: registeredName,
          bold: currentFont.bold,
          italic: currentFont.italic,
          x: trm[4],
          y: trm[5],
          a: trm[0],
          b: trm[1],
          c: trm[2],
          d: trm[3],
          fillColor,
          fillAlpha,
          textRenderMode,
          strokeColor,
          strokeAlpha,
          lineWidth: lineWidth * Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])),
        };
        if (isNonEmbedded && !sc.applied) opObj2.pdfGlyphWidth = rawWidth;
        if (!fillColorExplicit) opObj2.fillColorInherited = true;
        if (!fillAlphaExplicit) opObj2.fillAlphaInherited = true;
        if (!strokeColorExplicit) opObj2.strokeColorInherited = true;
        if (!strokeAlphaExplicit) opObj2.strokeAlphaInherited = true;
        ops.push(opObj2);
      }
      const advance = (glyphWidth + tc + (charCode === 0x20 ? tw : 0)) * tz / 100;
      tm[4] += advance * tm[0];
      tm[5] += advance * tm[1];
    }
  }

  /**
   * Show a string token — dispatches to Type3, Type0, Type1, or advance-only.
   * @param {{ type: string, value: string }} strTok
   */
  function showString(strTok) {
    if (!currentFont) return;
    const isType3 = !!currentFont.type3;
    const isType0 = !!currentFont.type0;
    const isType1 = !!currentFont.type1;
    if (strTok.type === 'hexstring') {
      if (isType3) showType3Hex(strTok.value);
      else if (isType0) showType0Hex(strTok.value);
      else if (isType1) showType1Hex(strTok.value);
      else advanceHex(strTok.value);
    } else if (strTok.type === 'string') {
      if (isType3) showType3Literal(strTok.value);
      else if (isType0) showType0Literal(strTok.value);
      else if (isType1) showType1Literal(strTok.value);
      else advanceLiteral(strTok.value);
    }
  }

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    // Handle inline images (BI/ID/EI) — the tokenizer produces a single 'inlineImage' token
    // containing the image dict text and binary data.
    if (tok.type === 'inlineImage') {
      if (ocHidden) continue;
      const { dictText, imageData } = tok.value;
      /** @type {InlineImageOp} */
      const inlineOp = {
        type: 'inlineImage',
        dictText,
        imageData,
        ctm: ctm.slice(),
        fillColor,
        fillAlpha,
        colorSpaces, // carry the active color space registry so Form XObject inline images resolve correctly
      };
      if (fillTilingPattern) inlineOp.tilingPattern = fillTilingPattern;
      if (fillPatternShading) inlineOp.patternShading = fillPatternShading;
      if (clipStack.length > 0) {
        inlineOp.clips = clipStack.map((c) => {
          const entry = { path: c.path ? c.path.slice() : null, ctm: c.ctm.slice(), evenOdd: c.evenOdd };
          if (c.textClip) entry.textClip = c.textClip;
          return entry;
        });
      }
      if (!fillColorExplicit) inlineOp.fillColorInherited = true;
      if (!fillAlphaExplicit) inlineOp.fillAlphaInherited = true;
      ops.push(inlineOp);
      continue;
    }

    if (tok.type !== 'operator') {
      // Non-finite numbers (NaN from garbled tokens like "4.58984938980.04") signal
      // corrupted content stream data. Flush the current path to preserve clean content
      // already accumulated, and enter corruption-skip mode: discard all subsequent
      // path construction until a painting operator resets the state.
      if (tok.type === 'number' && !Number.isFinite(tok.value)) {
        operandStack.length = 0;
        if (currentPath.length > 0) {
          /** @type {PathDrawOp} */
          const flushOp = {
            type: 'path',
            commands: currentPath,
            ctm: ctm.slice(),
            fill: false,
            stroke: true,
            evenOdd: false,
            fillColor,
            strokeColor,
            lineWidth,
            lineCap,
            lineJoin,
            miterLimit,
            dashArray: dashArray.length > 0 ? dashArray.slice() : dashArray,
            dashPhase,
            fillAlpha,
            strokeAlpha,
          };
          if (currentSmask) flushOp.smask = currentSmask;
          if (blendMode !== 'Normal') flushOp.blendMode = blendMode;
          ops.push(flushOp);
          currentPath = [];
        }
        skipCorruptedPath = true;
        continue;
      }
      operandStack.push(tok);
      continue;
    }

    // Stream boundary: corruption doesn't carry across /Contents entries, so reset
    // the suppression state here. A corrupted entry may also leave operands dangling.
    if (nextStreamBoundaryIdx < streamBoundaryOffsets.length && tok.start != null
      && tok.start >= streamBoundaryOffsets[nextStreamBoundaryIdx]) {
      while (nextStreamBoundaryIdx < streamBoundaryOffsets.length
        && tok.start >= streamBoundaryOffsets[nextStreamBoundaryIdx]) nextStreamBoundaryIdx++;
      if (streamCorrupted || skipCorruptedPath) operandStack.length = 0;
      pathAnomalyCount = 0;
      streamCorrupted = false;
      skipCorruptedPath = false;
      corruptionThreshold = recoveredStreamFlags[nextStreamBoundaryIdx] ? 1 : 5;
    }

    // If enough path anomalies accumulated (excess operands, leftover operands before paint ops),
    // the content stream is corrupted (e.g. damaged deflate data).
    // Stop emitting draw ops to prevent garbled fills from covering valid content.
    // A partially-recovered stream trips on the first anomaly.
    if (pathAnomalyCount >= corruptionThreshold && !streamCorrupted) {
      streamCorrupted = true;
      console.warn(`[renderPdfPage] Content stream appears corrupted (${pathAnomalyCount} path/color operand anomalies). Suppressing remaining draw operations to preserve valid content.`);
    }
    if (streamCorrupted) {
      operandStack.length = 0;
      continue;
    }

    // Content inside an `/OC /<name> BDC ... EMC` whose OCG is OFF is still
    // processed for graphics-state changes, but nothing it would paint is kept.
    if (tok.value === 'BDC' || tok.value === 'BMC') {
      let nowHidden = ocHidden;
      if (!nowHidden && tok.value === 'BDC' && hiddenOCMCNames.size > 0) {
        const tagTok = operandStack[operandStack.length - 2];
        const propTok = operandStack[operandStack.length - 1];
        if (tagTok && tagTok.type === 'name' && tagTok.value === 'OC'
          && propTok && propTok.type === 'name' && hiddenOCMCNames.has(propTok.value)) {
          nowHidden = true;
        }
      }
      mcStack.push(nowHidden);
      ocHidden = nowHidden;
      operandStack.length = 0;
      continue;
    }
    if (tok.value === 'EMC') {
      if (mcStack.length > 0) mcStack.pop();
      ocHidden = mcStack.length > 0 && mcStack[mcStack.length - 1];
      operandStack.length = 0;
      continue;
    }

    const opsLenBeforeOp = ops.length;

    switch (tok.value) {
      // Graphics state
      case 'q':
        gsStack.push({
          ctm: ctm.slice(),
          fillColor,
          fillColorExplicit,
          fillPatternShading,
          fillTilingPattern,
          strokeColor,
          strokeColorExplicit,
          strokePatternShading,
          strokeTilingPattern,
          fillColorSpaceType,
          strokeColorSpaceType,
          fillTintSamples,
          fillTintNComponents,
          strokeTintSamples,
          strokeTintNComponents,
          fillDeviceNGrid,
          strokeDeviceNGrid,
          fillIndexedInfo,
          strokeIndexedInfo,
          fillLabWhitePoint,
          strokeLabWhitePoint,
          fillAlpha,
          strokeAlpha,
          fillAlphaExplicit,
          strokeAlphaExplicit,
          lineWidth,
          lineCap,
          lineJoin,
          miterLimit,
          dashArray: dashArray.length > 0 ? dashArray.slice() : [],
          dashPhase,
          tc,
          tw,
          tl,
          tz,
          trise,
          textRenderMode,
          fontSize,
          currentFont,
          currentFontTag,
          clipStack: clipStack.length > 0 ? clipStack.map((c) => {
            /** @type {ClipEntry} */
            const entry = { path: c.path ? c.path.slice() : null, ctm: c.ctm.slice(), evenOdd: c.evenOdd };
            if (c.textClip) entry.textClip = c.textClip;
            return entry;
          }) : [],
          currentSmask,
          overprint,
          blendMode,
          pendingClip,
          pendingClipEvenOdd,
        });
        operandStack.length = 0;
        break;
      case 'Q':
        if (gsStack.length > 0) {
          const saved = gsStack.pop();
          ctm = saved.ctm;
          fillColor = saved.fillColor;
          fillColorExplicit = saved.fillColorExplicit;
          fillPatternShading = saved.fillPatternShading;
          fillTilingPattern = saved.fillTilingPattern;
          strokeColor = saved.strokeColor;
          strokeColorExplicit = saved.strokeColorExplicit;
          strokePatternShading = saved.strokePatternShading;
          strokeTilingPattern = saved.strokeTilingPattern;
          fillColorSpaceType = saved.fillColorSpaceType;
          strokeColorSpaceType = saved.strokeColorSpaceType;
          fillTintSamples = saved.fillTintSamples;
          fillTintNComponents = saved.fillTintNComponents;
          strokeTintSamples = saved.strokeTintSamples;
          strokeTintNComponents = saved.strokeTintNComponents;
          fillDeviceNGrid = saved.fillDeviceNGrid;
          strokeDeviceNGrid = saved.strokeDeviceNGrid;
          fillIndexedInfo = saved.fillIndexedInfo;
          strokeIndexedInfo = saved.strokeIndexedInfo;
          fillLabWhitePoint = saved.fillLabWhitePoint;
          strokeLabWhitePoint = saved.strokeLabWhitePoint;
          fillAlpha = saved.fillAlpha;
          strokeAlpha = saved.strokeAlpha;
          fillAlphaExplicit = saved.fillAlphaExplicit;
          strokeAlphaExplicit = saved.strokeAlphaExplicit;
          overprint = saved.overprint;
          blendMode = saved.blendMode;
          lineWidth = saved.lineWidth;
          lineCap = saved.lineCap;
          lineJoin = saved.lineJoin;
          miterLimit = saved.miterLimit;
          dashArray = saved.dashArray;
          dashPhase = saved.dashPhase;
          tc = saved.tc;
          tw = saved.tw;
          tl = saved.tl;
          tz = saved.tz;
          trise = saved.trise;
          textRenderMode = saved.textRenderMode;
          fontSize = saved.fontSize;
          currentFont = saved.currentFont;
          currentFontTag = saved.currentFontTag;
          clipStack = saved.clipStack;
          currentSmask = saved.currentSmask;
          pendingClip = saved.pendingClip;
          pendingClipEvenOdd = saved.pendingClipEvenOdd;
        }
        operandStack.length = 0;
        break;
      case 'cm':
        if (operandStack.length >= 6) {
          const m = operandStack.slice(operandStack.length - 6).map((t) => t.value);
          ctm = matMul(m, ctm);
        }
        operandStack.length = 0;
        break;
      case 'gs':
        if (operandStack.length >= 1 && extGStates) {
          const gsName = String(operandStack[operandStack.length - 1].value).replace(/^\//, '');
          const gs = extGStates.get(gsName);
          if (gs) {
            if (gs.fillAlpha !== undefined) { fillAlpha = gs.fillAlpha; fillAlphaExplicit = true; }
            if (gs.strokeAlpha !== undefined) { strokeAlpha = gs.strokeAlpha; strokeAlphaExplicit = true; }
            if (gs.overprint !== undefined) overprint = gs.overprint;
            if (gs.blendMode !== undefined) blendMode = gs.blendMode;
            if (gs.lineWidth !== undefined) lineWidth = gs.lineWidth;
            if (gs.lineCap !== undefined) lineCap = gs.lineCap;
            if (gs.lineJoin !== undefined) lineJoin = gs.lineJoin;
            if (gs.miterLimit !== undefined) miterLimit = gs.miterLimit;
            if (gs.dashArray !== undefined) { dashArray = gs.dashArray; dashPhase = gs.dashPhase ?? 0; }
            if (gs.smask !== undefined) {
              // PDF spec §11.6.5.1: SMask transparency group is positioned by the
              // parent CTM at the time the soft mask was set, NOT the form's local
              // matrix alone.  Capture the current CTM so renderSMaskToCanvas can
              // apply it as a base transform.
              currentSmask = gs.smask
                ? { ...gs.smask, parentCtm: ctm.slice() }
                : gs.smask;
            }
          }
        }
        operandStack.length = 0;
        break;

      // XObject
      case 'Do':
        if (operandStack.length >= 1) {
          const name = operandStack[operandStack.length - 1].value;
          /** @type {ImageDrawOp} */
          const doOp = {
            type: 'image', name, ctm: ctm.slice(), fillAlpha, strokeAlpha, fillColor, strokeColor,
          };
          if (fillTilingPattern) doOp.tilingPattern = fillTilingPattern;
          if (fillPatternShading) doOp.patternShading = fillPatternShading;
          if (overprint) doOp.overprint = true;
          if (blendMode !== 'Normal') doOp.blendMode = blendMode;
          if (clipStack.length > 0) {
            doOp.clips = clipStack.map((c) => {
              const entry = { path: c.path ? c.path.slice() : null, ctm: c.ctm.slice(), evenOdd: c.evenOdd };
              if (c.textClip) entry.textClip = c.textClip;
              return entry;
            });
          }
          if (currentSmask) doOp.smask = currentSmask;
          if (!fillColorExplicit) doOp.fillColorInherited = true;
          if (!fillAlphaExplicit) doOp.fillAlphaInherited = true;
          if (!strokeColorExplicit) doOp.strokeColorInherited = true;
          if (!strokeAlphaExplicit) doOp.strokeAlphaInherited = true;
          // Form XObject inherits the caller's text state at Do time.
          doOp.textState = {
            tc, tw, tl, tz, trise,
          };
          ops.push(doOp);
        }
        operandStack.length = 0;
        break;

      // Shading fill
      case 'sh':
        if (operandStack.length >= 1) {
          const shName = operandStack[operandStack.length - 1].value;
          const shading = shadings.get(shName);
          if (shading) {
            /** @type {ShadingDrawOp} */
            const shOp = {
              type: 'shading', shading, ctm: ctm.slice(), fillAlpha,
            };
            if (clipStack.length > 0) {
              shOp.clips = clipStack.map((c) => {
                const entry = { path: c.path ? c.path.slice() : null, ctm: c.ctm.slice(), evenOdd: c.evenOdd };
                if (c.textClip) entry.textClip = c.textClip;
                return entry;
              });
            }
            if (currentSmask) shOp.smask = currentSmask;
            if (blendMode !== 'Normal') shOp.blendMode = blendMode;
            ops.push(shOp);
          }
        }
        operandStack.length = 0;
        break;

      // Text object
      case 'BT':
        skipCorruptedPath = false;
        tm = [1, 0, 0, 1, 0, 0];
        tlm = [1, 0, 0, 1, 0, 0];
        textClipChars = [];
        operandStack.length = 0;
        break;
      case 'ET':
        // Text rendering modes 4-7 accumulate text into the clipping path.
        // At ET, push the accumulated text shapes as a text clip entry.
        if (textClipChars.length > 0) {
          clipStack.push({ textClip: textClipChars.slice(), ctm: [1, 0, 0, 1, 0, 0], evenOdd: false });
          textClipChars = [];
        }
        operandStack.length = 0;
        break;

      // Text state
      case 'Tf': {
        const size = operandStack.length >= 2 ? operandStack[operandStack.length - 1] : null;
        const name = operandStack.length >= 2 ? operandStack[operandStack.length - 2] : null;
        if (name && name.type === 'name' && size && size.type === 'number') {
          const fontTag = decodePdfName(name.value);
          currentFont = fonts.get(fontTag) || null;
          currentFontTag = fontTag;
          fontSize = size.value;
          if (!currentFont && !warnedMissingFontTags.has(fontTag)) {
            warnedMissingFontTags.add(fontTag);
            // No font object resolved -> the run's text is dropped (no encoding, widths, or family to render it).
            // Surface it so this failure mode is diagnosable instead of silently invisible.
            console.warn(`[parseDrawOps] Tf references font "${fontTag}" not found in resources; its text will not render`);
          }
        }
        operandStack.length = 0;
        break;
      }
      case 'Tc':
        if (operandStack.length >= 1) tc = operandStack[operandStack.length - 1].value;
        operandStack.length = 0;
        break;
      case 'Tw':
        if (operandStack.length >= 1) tw = operandStack[operandStack.length - 1].value;
        operandStack.length = 0;
        break;
      case 'Tz':
        if (operandStack.length >= 1) tz = operandStack[operandStack.length - 1].value;
        operandStack.length = 0;
        break;
      case 'Tr':
        if (operandStack.length >= 1) textRenderMode = operandStack[operandStack.length - 1].value;
        operandStack.length = 0;
        break;
      case 'Ts':
        if (operandStack.length >= 1) trise = operandStack[operandStack.length - 1].value;
        operandStack.length = 0;
        break;
      case 'TL':
        if (operandStack.length >= 1) tl = operandStack[operandStack.length - 1].value;
        operandStack.length = 0;
        break;
      case 'Tm':
        if (operandStack.length >= 6) {
          tm = operandStack.slice(operandStack.length - 6).map((t) => t.value);
          tlm = tm.slice();
        }
        operandStack.length = 0;
        break;
      case 'Td': {
        if (operandStack.length >= 2) {
          const tx = operandStack[operandStack.length - 2].value;
          const ty = operandStack[operandStack.length - 1].value;
          tlm = [tlm[0], tlm[1], tlm[2], tlm[3],
            tx * tlm[0] + ty * tlm[2] + tlm[4],
            tx * tlm[1] + ty * tlm[3] + tlm[5]];
          tm = tlm.slice();
        }
        operandStack.length = 0;
        break;
      }
      case 'TD': {
        if (operandStack.length >= 2) {
          const tx = operandStack[operandStack.length - 2].value;
          const ty = operandStack[operandStack.length - 1].value;
          tl = -ty;
          tlm = [tlm[0], tlm[1], tlm[2], tlm[3],
            tx * tlm[0] + ty * tlm[2] + tlm[4],
            tx * tlm[1] + ty * tlm[3] + tlm[5]];
          tm = tlm.slice();
        }
        operandStack.length = 0;
        break;
      }
      case 'T*': {
        const tx = 0;
        const ty = -tl;
        tlm = [tlm[0], tlm[1], tlm[2], tlm[3],
          tx * tlm[0] + ty * tlm[2] + tlm[4],
          tx * tlm[1] + ty * tlm[3] + tlm[5]];
        tm = tlm.slice();
        operandStack.length = 0;
        break;
      }

      // Show string operators
      case 'Tj':
        if (operandStack.length >= 1 && currentFont) {
          showString(operandStack[operandStack.length - 1]);
        }
        operandStack.length = 0;
        break;
      case 'TJ': {
        if (operandStack.length >= 1 && currentFont) {
          const arrTok = operandStack[operandStack.length - 1];
          if (arrTok.type === 'array') {
            for (const elem of arrTok.value) {
              if (elem.type === 'hexstring' || elem.type === 'string') {
                showString(elem);
              } else if (elem.type === 'number') {
                const adjustment = elem.value / 1000 * fontSize * tz / 100;
                tm[4] -= adjustment * tm[0];
                tm[5] -= adjustment * tm[1];
              }
            }
          }
        }
        operandStack.length = 0;
        break;
      }
      case "'": {
        const txP = 0;
        const tyP = -tl;
        tlm = [tlm[0], tlm[1], tlm[2], tlm[3],
          txP * tlm[0] + tyP * tlm[2] + tlm[4],
          txP * tlm[1] + tyP * tlm[3] + tlm[5]];
        tm = tlm.slice();
        if (operandStack.length >= 1 && currentFont) {
          showString(operandStack[operandStack.length - 1]);
        }
        operandStack.length = 0;
        break;
      }
      case '"': {
        if (operandStack.length >= 3) {
          tw = operandStack[operandStack.length - 3].value;
          tc = operandStack[operandStack.length - 2].value;
        }
        const txQ = 0;
        const tyQ = -tl;
        tlm = [tlm[0], tlm[1], tlm[2], tlm[3],
          txQ * tlm[0] + tyQ * tlm[2] + tlm[4],
          txQ * tlm[1] + tyQ * tlm[3] + tlm[5]];
        tm = tlm.slice();
        if (operandStack.length >= 1 && currentFont) {
          showString(operandStack[operandStack.length - 1]);
        }
        operandStack.length = 0;
        break;
      }

      // ── Fill color operators ──────────────────────────────────────
      case 'g':
        fillPatternShading = null;
        fillTilingPattern = null;
        fillColorExplicit = true;
        fillColorSpaceType = 'DeviceGray';
        fillTintSamples = null;
        fillTintNComponents = 1;
        fillDeviceNGrid = null;
        fillIndexedInfo = null;
        if (operandStack.length !== 1) pathAnomalyCount++;
        if (operandStack.length >= 1) {
          const gv = Math.round(operandStack[operandStack.length - 1].value * 255);
          fillColor = `rgb(${gv},${gv},${gv})`;
        }
        operandStack.length = 0;
        break;
      case 'rg':
        fillPatternShading = null;
        fillTilingPattern = null;
        fillColorExplicit = true;
        fillColorSpaceType = 'DeviceRGB';
        fillTintSamples = null;
        fillTintNComponents = 3;
        fillDeviceNGrid = null;
        fillIndexedInfo = null;
        if (operandStack.length !== 3) pathAnomalyCount++;
        if (operandStack.length >= 3) {
          const r = Math.round(operandStack[operandStack.length - 3].value * 255);
          const gv = Math.round(operandStack[operandStack.length - 2].value * 255);
          const b = Math.round(operandStack[operandStack.length - 1].value * 255);
          fillColor = `rgb(${r},${gv},${b})`;
        }
        operandStack.length = 0;
        break;
      case 'k':
        fillPatternShading = null;
        fillTilingPattern = null;
        fillColorExplicit = true;
        fillColorSpaceType = 'DeviceCMYK';
        fillTintSamples = null;
        fillTintNComponents = 4;
        fillDeviceNGrid = null;
        fillIndexedInfo = null;
        if (operandStack.length !== 4) pathAnomalyCount++;
        if (operandStack.length >= 4) {
          const ck = operandStack[operandStack.length - 4].value;
          const mk = operandStack[operandStack.length - 3].value;
          const yk = operandStack[operandStack.length - 2].value;
          const kk = operandStack[operandStack.length - 1].value;
          // Skip obviously corrupt CMYK values (valid range is [0,1])
          if (ck >= -0.1 && ck <= 1.1 && mk >= -0.1 && mk <= 1.1
              && yk >= -0.1 && yk <= 1.1 && kk >= -0.1 && kk <= 1.1) {
            const [rk, gk, bk] = cmykToRgb(ck, mk, yk, kk);
            fillColor = `rgb(${rk},${gk},${bk})`;
          }
        }
        operandStack.length = 0;
        break;

      // ── Stroke color operators ─────────────────────────────────────
      case 'G':
        strokePatternShading = null;
        strokeTilingPattern = null;
        strokeColorExplicit = true;
        strokeColorSpaceType = 'DeviceGray';
        strokeTintSamples = null;
        strokeTintNComponents = 1;
        strokeDeviceNGrid = null;
        strokeIndexedInfo = null;
        if (operandStack.length >= 1) {
          const gv = Math.round(operandStack[operandStack.length - 1].value * 255);
          strokeColor = `rgb(${gv},${gv},${gv})`;
        }
        operandStack.length = 0;
        break;
      case 'RG':
        strokePatternShading = null;
        strokeTilingPattern = null;
        strokeColorExplicit = true;
        strokeColorSpaceType = 'DeviceRGB';
        strokeTintSamples = null;
        strokeTintNComponents = 3;
        strokeDeviceNGrid = null;
        strokeIndexedInfo = null;
        if (operandStack.length >= 3) {
          const r = Math.round(operandStack[operandStack.length - 3].value * 255);
          const gv = Math.round(operandStack[operandStack.length - 2].value * 255);
          const b = Math.round(operandStack[operandStack.length - 1].value * 255);
          strokeColor = `rgb(${r},${gv},${b})`;
        }
        operandStack.length = 0;
        break;
      case 'K':
        strokePatternShading = null;
        strokeTilingPattern = null;
        strokeColorExplicit = true;
        strokeColorSpaceType = 'DeviceCMYK';
        strokeTintSamples = null;
        strokeTintNComponents = 4;
        strokeDeviceNGrid = null;
        strokeIndexedInfo = null;
        if (operandStack.length !== 4) pathAnomalyCount++;
        if (operandStack.length >= 4) {
          const cK = operandStack[operandStack.length - 4].value;
          const mK = operandStack[operandStack.length - 3].value;
          const yK = operandStack[operandStack.length - 2].value;
          const kK = operandStack[operandStack.length - 1].value;
          if (cK >= -0.1 && cK <= 1.1 && mK >= -0.1 && mK <= 1.1
              && yK >= -0.1 && yK <= 1.1 && kK >= -0.1 && kK <= 1.1) {
            const [rK, gK, bK] = cmykToRgb(cK, mK, yK, kK);
            strokeColor = `rgb(${rK},${gK},${bK})`;
          }
        }
        operandStack.length = 0;
        break;

      // ── General color space operators ──────────────────────────────
      case 'cs': {
        // Track fill color space type and tint samples for Separation handling
        const csName = operandStack.length >= 1 ? operandStack[operandStack.length - 1].value : '';
        const csInfo = colorSpaces.get(csName);
        fillColorSpaceType = csInfo ? csInfo.type : csName;
        fillTintSamples = csInfo ? csInfo.tintSamples : null;
        fillTintNComponents = csInfo ? csInfo.nComponents : 3;
        fillDeviceNGrid = csInfo ? csInfo.deviceNGrid : null;
        fillIndexedInfo = csInfo ? csInfo.indexedInfo : null;
        fillLabWhitePoint = csInfo ? csInfo.labWhitePoint : null;
        operandStack.length = 0;
        break;
      }
      case 'CS': {
        const csNameS = operandStack.length >= 1 ? operandStack[operandStack.length - 1].value : '';
        const csInfoS = colorSpaces.get(csNameS);
        strokeColorSpaceType = csInfoS ? csInfoS.type : csNameS;
        strokeTintSamples = csInfoS ? csInfoS.tintSamples : null;
        strokeTintNComponents = csInfoS ? csInfoS.nComponents : 3;
        strokeDeviceNGrid = csInfoS ? csInfoS.deviceNGrid : null;
        strokeIndexedInfo = csInfoS ? csInfoS.indexedInfo : null;
        strokeLabWhitePoint = csInfoS ? csInfoS.labWhitePoint : null;
        strokePatternShading = null;
        strokeTilingPattern = null;
        operandStack.length = 0;
        break;
      }
      case 'sc': case 'scn': {
        fillColorExplicit = true;
        if (operandStack.length >= 1) {
          // Pattern color space: last operand is a pattern name (string), not a number
          if (fillColorSpaceType === 'Pattern') {
            const patName = operandStack[operandStack.length - 1].value;
            const patInfo = typeof patName === 'string' && patterns.get(patName);
            if (patInfo) {
              fillColor = patInfo.color;
              fillPatternShading = patInfo.shading || null;
              fillTilingPattern = patInfo.tiling
                ? { patName, ...patInfo.tiling }
                : null;
              if (fillTilingPattern && patInfo.tiling.paintType === 2) {
                const comps = operandStack.slice(0, -1).map((t) => t.value).filter((v) => typeof v === 'number');
                if (comps.length === 1) {
                  const g = Math.round(comps[0] * 255);
                  fillTilingPattern.paintColor = `rgb(${g},${g},${g})`;
                } else if (comps.length === 3) {
                  fillTilingPattern.paintColor = `rgb(${Math.round(comps[0] * 255)},${Math.round(comps[1] * 255)},${Math.round(comps[2] * 255)})`;
                } else if (comps.length === 4) {
                  const [c, m, y, k] = comps;
                  fillTilingPattern.paintColor = `rgb(${Math.round(255 * (1 - c) * (1 - k))},${Math.round(255 * (1 - m) * (1 - k))},${Math.round(255 * (1 - y) * (1 - k))})`;
                }
              }
            }
            operandStack.length = 0;
            break;
          }
          fillPatternShading = null;
          fillTilingPattern = null;
          const vals = operandStack.map((t) => t.value);
          // Multi-component DeviceN: evaluate the pre-computed RGB grid via interpolation
          if (fillDeviceNGrid && vals.length === fillDeviceNGrid.nInputs) {
            const grid = fillDeviceNGrid;
            if (grid.parsedTint) {
              const rgb = tintComponentsToRGB(grid.parsedTint, vals);
              if (rgb) {
                fillColor = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
                operandStack.length = 0;
                break;
              }
            }
            const rgb = grid.rgbSamples;
            const nc = grid.nComponents; // RGB components per sample (3)
            if (grid.nInputs === 2) {
              // Bilinear interpolation on a 2D grid
              const s0 = grid.sizes[0];
              const s1 = grid.sizes[1];
              const fx = vals[0] * (s0 - 1);
              const fy = vals[1] * (s1 - 1);
              const x0 = Math.min(Math.floor(fx), s0 - 1);
              const y0 = Math.min(Math.floor(fy), s1 - 1);
              const x1 = Math.min(x0 + 1, s0 - 1);
              const y1 = Math.min(y0 + 1, s1 - 1);
              const dx = fx - x0;
              const dy = fy - y0;
              const i00 = (y0 * s0 + x0) * nc;
              const i10 = (y0 * s0 + x1) * nc;
              const i01 = (y1 * s0 + x0) * nc;
              const i11 = (y1 * s0 + x1) * nc;
              const r = Math.round((rgb[i00] * (1 - dx) + rgb[i10] * dx) * (1 - dy) + (rgb[i01] * (1 - dx) + rgb[i11] * dx) * dy);
              const g = Math.round((rgb[i00 + 1] * (1 - dx) + rgb[i10 + 1] * dx) * (1 - dy) + (rgb[i01 + 1] * (1 - dx) + rgb[i11 + 1] * dx) * dy);
              const b = Math.round((rgb[i00 + 2] * (1 - dx) + rgb[i10 + 2] * dx) * (1 - dy) + (rgb[i01 + 2] * (1 - dx) + rgb[i11 + 2] * dx) * dy);
              fillColor = `rgb(${r},${g},${b})`;
            } else {
              // For higher-dimensional DeviceN, use nearest-neighbor lookup
              // PDF spec: first input dimension varies fastest in the sample array
              let flatIdx = 0;
              let stride = 1;
              for (let d = 0; d < grid.nInputs; d++) {
                const si = Math.min(Math.round(vals[d] * (grid.sizes[d] - 1)), grid.sizes[d] - 1);
                flatIdx += si * stride;
                stride *= grid.sizes[d];
              }
              const ri = flatIdx * nc;
              fillColor = `rgb(${rgb[ri]},${rgb[ri + 1]},${rgb[ri + 2]})`;
            }
            operandStack.length = 0;
            break;
          }
          if (vals.length === 1 && fillColorSpaceType === 'Indexed' && fillIndexedInfo) {
            const idx = Math.max(0, Math.min(fillIndexedInfo.hival, Math.round(vals[0])));
            const base = fillIndexedInfo.base;
            const nComp = base === 'DeviceCMYK' ? 4 : (base === 'DeviceGray' || base === 'CalGray' ? 1 : 3);
            const po = idx * nComp;
            const pal = fillIndexedInfo.palette;
            if (nComp === 3) {
              fillColor = `rgb(${pal[po]},${pal[po + 1]},${pal[po + 2]})`;
            } else if (nComp === 1) {
              fillColor = `rgb(${pal[po]},${pal[po]},${pal[po]})`;
            } else if (nComp === 4) {
              const [ri, gi, bi] = cmykToRgb(pal[po] / 255, pal[po + 1] / 255, pal[po + 2] / 255, pal[po + 3] / 255);
              fillColor = `rgb(${ri},${gi},${bi})`;
            }
            operandStack.length = 0;
            break;
          }
          if (vals.length === 1) {
            if (fillColorSpaceType === 'Separation' && fillTintSamples && fillTintSamples.length >= fillTintNComponents) {
              // Evaluate sampled tint function with linear interpolation: tint 0=no ink, 1=full ink
              const nSamples = Math.floor(fillTintSamples.length / fillTintNComponents);
              const fi = Math.min(vals[0] * (nSamples - 1), nSamples - 1);
              const i0 = Math.min(Math.floor(fi), nSamples - 1);
              const i1 = Math.min(i0 + 1, nSamples - 1);
              const frac = fi - i0;
              if (fillTintNComponents >= 3) {
                const r = Math.round(fillTintSamples[i0 * 3] * (1 - frac) + fillTintSamples[i1 * 3] * frac);
                const g = Math.round(fillTintSamples[i0 * 3 + 1] * (1 - frac) + fillTintSamples[i1 * 3 + 1] * frac);
                const b = Math.round(fillTintSamples[i0 * 3 + 2] * (1 - frac) + fillTintSamples[i1 * 3 + 2] * frac);
                fillColor = `rgb(${r},${g},${b})`;
              } else {
                const v = Math.round(fillTintSamples[i0] * (1 - frac) + fillTintSamples[i1] * frac);
                fillColor = `rgb(${v},${v},${v})`;
              }
            } else if (fillColorSpaceType === 'Separation') {
              // No tint samples — simple inversion
              const gv = Math.round(255 * (1 - vals[0]));
              fillColor = `rgb(${gv},${gv},${gv})`;
            } else {
              const gv = Math.round(vals[0] * 255);
              fillColor = `rgb(${gv},${gv},${gv})`;
            }
          } else if (vals.length === 3) {
            if (fillColorSpaceType === 'Lab') {
              const fy = (vals[0] + 16) / 116;
              const fx = fy + vals[1] / 500;
              const fz = fy - vals[2] / 200;
              const delta = 6 / 29;
              const fInv = (ft) => (ft > delta ? ft * ft * ft : 3 * delta * delta * (ft - 4 / 29));
              const wp = fillLabWhitePoint || [0.9642, 1.0, 0.8249];
              const [r, g, b] = xyzToSRGB(wp[0] * fInv(fx), wp[1] * fInv(fy), wp[2] * fInv(fz), wp);
              fillColor = `rgb(${r},${g},${b})`;
            } else {
              fillColor = `rgb(${Math.round(vals[0] * 255)},${Math.round(vals[1] * 255)},${Math.round(vals[2] * 255)})`;
            }
          } else if (vals.length === 4) {
            const [rf, gf, bf] = cmykToRgb(vals[0], vals[1], vals[2], vals[3]);
            fillColor = `rgb(${rf},${gf},${bf})`;
          }
        }
        operandStack.length = 0;
        break;
      }
      case 'SC': case 'SCN': {
        strokeColorExplicit = true;
        if (operandStack.length >= 1) {
          if (strokeColorSpaceType === 'Pattern') {
            const patName = operandStack[operandStack.length - 1].value;
            const patInfo = typeof patName === 'string' && patterns.get(patName);
            if (patInfo) {
              strokeColor = patInfo.color;
              strokePatternShading = patInfo.shading || null;
              strokeTilingPattern = patInfo.tiling
                ? { patName, ...patInfo.tiling }
                : null;
            }
            operandStack.length = 0;
            break;
          }
          strokePatternShading = null;
          strokeTilingPattern = null;
          const vals = operandStack.map((t) => t.value);
          if (vals.length === 1 && strokeColorSpaceType === 'Indexed' && strokeIndexedInfo) {
            const idx = Math.max(0, Math.min(strokeIndexedInfo.hival, Math.round(vals[0])));
            const base = strokeIndexedInfo.base;
            const nComp = base === 'DeviceCMYK' ? 4 : (base === 'DeviceGray' || base === 'CalGray' ? 1 : 3);
            const po = idx * nComp;
            const pal = strokeIndexedInfo.palette;
            if (nComp === 3) {
              strokeColor = `rgb(${pal[po]},${pal[po + 1]},${pal[po + 2]})`;
            } else if (nComp === 1) {
              strokeColor = `rgb(${pal[po]},${pal[po]},${pal[po]})`;
            } else if (nComp === 4) {
              const [ri, gi, bi] = cmykToRgb(pal[po] / 255, pal[po + 1] / 255, pal[po + 2] / 255, pal[po + 3] / 255);
              strokeColor = `rgb(${ri},${gi},${bi})`;
            }
            operandStack.length = 0;
            break;
          }
          if (strokeDeviceNGrid && vals.length === strokeDeviceNGrid.nInputs) {
            const grid = strokeDeviceNGrid;
            if (grid.parsedTint) {
              const rgb = tintComponentsToRGB(grid.parsedTint, vals);
              if (rgb) {
                strokeColor = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
                operandStack.length = 0;
                break;
              }
            }
            const rgb = grid.rgbSamples;
            const nc = grid.nComponents;
            if (grid.nInputs === 2) {
              const s0 = grid.sizes[0];
              const s1 = grid.sizes[1];
              const fx = vals[0] * (s0 - 1);
              const fy = vals[1] * (s1 - 1);
              const x0 = Math.min(Math.floor(fx), s0 - 1);
              const y0 = Math.min(Math.floor(fy), s1 - 1);
              const x1 = Math.min(x0 + 1, s0 - 1);
              const y1 = Math.min(y0 + 1, s1 - 1);
              const dx = fx - x0;
              const dy = fy - y0;
              const i00 = (y0 * s0 + x0) * nc;
              const i10 = (y0 * s0 + x1) * nc;
              const i01 = (y1 * s0 + x0) * nc;
              const i11 = (y1 * s0 + x1) * nc;
              const r = Math.round((rgb[i00] * (1 - dx) + rgb[i10] * dx) * (1 - dy) + (rgb[i01] * (1 - dx) + rgb[i11] * dx) * dy);
              const g = Math.round((rgb[i00 + 1] * (1 - dx) + rgb[i10 + 1] * dx) * (1 - dy) + (rgb[i01 + 1] * (1 - dx) + rgb[i11 + 1] * dx) * dy);
              const bv = Math.round((rgb[i00 + 2] * (1 - dx) + rgb[i10 + 2] * dx) * (1 - dy) + (rgb[i01 + 2] * (1 - dx) + rgb[i11 + 2] * dx) * dy);
              strokeColor = `rgb(${r},${g},${bv})`;
            } else {
              let flatIdx = 0;
              let stride = 1;
              for (let d = 0; d < grid.nInputs; d++) {
                const si = Math.min(Math.round(vals[d] * (grid.sizes[d] - 1)), grid.sizes[d] - 1);
                flatIdx += si * stride;
                stride *= grid.sizes[d];
              }
              const ri = flatIdx * nc;
              strokeColor = `rgb(${rgb[ri]},${rgb[ri + 1]},${rgb[ri + 2]})`;
            }
            operandStack.length = 0;
            break;
          }
          if (vals.length === 1) {
            if (strokeColorSpaceType === 'Separation' && strokeTintSamples && strokeTintSamples.length >= strokeTintNComponents) {
              // Evaluate sampled tint function with linear interpolation
              const nSamples = Math.floor(strokeTintSamples.length / strokeTintNComponents);
              const fi = Math.min(vals[0] * (nSamples - 1), nSamples - 1);
              const i0 = Math.min(Math.floor(fi), nSamples - 1);
              const i1 = Math.min(i0 + 1, nSamples - 1);
              const frac = fi - i0;
              if (strokeTintNComponents >= 3) {
                const r = Math.round(strokeTintSamples[i0 * 3] * (1 - frac) + strokeTintSamples[i1 * 3] * frac);
                const g = Math.round(strokeTintSamples[i0 * 3 + 1] * (1 - frac) + strokeTintSamples[i1 * 3 + 1] * frac);
                const b = Math.round(strokeTintSamples[i0 * 3 + 2] * (1 - frac) + strokeTintSamples[i1 * 3 + 2] * frac);
                strokeColor = `rgb(${r},${g},${b})`;
              } else {
                const v = Math.round(strokeTintSamples[i0] * (1 - frac) + strokeTintSamples[i1] * frac);
                strokeColor = `rgb(${v},${v},${v})`;
              }
            } else if (strokeColorSpaceType === 'Separation') {
              const gv = Math.round(255 * (1 - vals[0]));
              strokeColor = `rgb(${gv},${gv},${gv})`;
            } else {
              const gv = Math.round(vals[0] * 255);
              strokeColor = `rgb(${gv},${gv},${gv})`;
            }
          } else if (vals.length === 3) {
            if (strokeColorSpaceType === 'Lab') {
              const fy = (vals[0] + 16) / 116;
              const fx = fy + vals[1] / 500;
              const fz = fy - vals[2] / 200;
              const delta = 6 / 29;
              const fInv = (ft) => (ft > delta ? ft * ft * ft : 3 * delta * delta * (ft - 4 / 29));
              const wp = strokeLabWhitePoint || [0.9642, 1.0, 0.8249];
              const [r, g, b] = xyzToSRGB(wp[0] * fInv(fx), wp[1] * fInv(fy), wp[2] * fInv(fz), wp);
              strokeColor = `rgb(${r},${g},${b})`;
            } else {
              strokeColor = `rgb(${Math.round(vals[0] * 255)},${Math.round(vals[1] * 255)},${Math.round(vals[2] * 255)})`;
            }
          } else if (vals.length === 4) {
            const [rs, gs, bs] = cmykToRgb(vals[0], vals[1], vals[2], vals[3]);
            strokeColor = `rgb(${rs},${gs},${bs})`;
          }
        }
        operandStack.length = 0;
        break;
      }

      // ── Line style operators ───────────────────────────────────────
      case 'w': // line width
        if (operandStack.length >= 1) lineWidth = operandStack[operandStack.length - 1].value;
        operandStack.length = 0;
        break;
      case 'J': // line cap
        if (operandStack.length >= 1) lineCap = operandStack[operandStack.length - 1].value;
        operandStack.length = 0;
        break;
      case 'j': // line join
        if (operandStack.length >= 1) lineJoin = operandStack[operandStack.length - 1].value;
        operandStack.length = 0;
        break;
      case 'M': // miter limit (uppercase, distinct from 'm' moveto)
        if (operandStack.length >= 1) miterLimit = operandStack[operandStack.length - 1].value;
        operandStack.length = 0;
        break;
      case 'd': // dash pattern: [array] phase d
        if (operandStack.length >= 2) {
          const phase = operandStack[operandStack.length - 1];
          const arr = operandStack[operandStack.length - 2];
          dashPhase = phase.value;
          dashArray = arr.type === 'array' ? arr.value.map((v) => v.value) : [];
        }
        operandStack.length = 0;
        break;

      // ── Path construction operators ────────────────────────────────
      case 'm': { // moveto
        if (skipCorruptedPath) { operandStack.length = 0; break; }
        if (operandStack.length !== 2) pathAnomalyCount++;
        if (operandStack.length >= 2) {
          if (operandStack.length > 2) { currentPath = []; operandStack.length = 0; break; }
          pathAnomalyCount = Math.max(0, pathAnomalyCount - 1);
          curX = operandStack[operandStack.length - 2].value;
          curY = operandStack[operandStack.length - 1].value;
          pathStartX = curX;
          pathStartY = curY;
          currentPath.push({ type: 'M', x: curX, y: curY });
        }
        operandStack.length = 0;
        break;
      }
      case 'l': { // lineto
        if (skipCorruptedPath) { operandStack.length = 0; break; }
        if (operandStack.length !== 2) pathAnomalyCount++;
        if (operandStack.length >= 2) {
          if (operandStack.length > 2) { pathAnomalyCount++; currentPath = []; operandStack.length = 0; break; }
          pathAnomalyCount = Math.max(0, pathAnomalyCount - 1);
          curX = operandStack[operandStack.length - 2].value;
          curY = operandStack[operandStack.length - 1].value;
          currentPath.push({ type: 'L', x: curX, y: curY });
        }
        operandStack.length = 0;
        break;
      }
      case 'c': { // curveto (x1 y1 x2 y2 x3 y3)
        if (skipCorruptedPath) { operandStack.length = 0; break; }
        if (operandStack.length !== 6) pathAnomalyCount++;
        if (operandStack.length >= 6) {
          if (operandStack.length > 6) { currentPath = []; operandStack.length = 0; break; }
          const x1 = operandStack[operandStack.length - 6].value;
          const y1 = operandStack[operandStack.length - 5].value;
          const x2 = operandStack[operandStack.length - 4].value;
          const y2 = operandStack[operandStack.length - 3].value;
          const x3 = operandStack[operandStack.length - 2].value;
          const y3 = operandStack[operandStack.length - 1].value;
          pathAnomalyCount = Math.max(0, pathAnomalyCount - 1);
          curX = x3;
          curY = y3;
          currentPath.push({
            type: 'C', x1, y1, x2, y2, x: curX, y: curY,
          });
        }
        operandStack.length = 0;
        break;
      }
      case 'v': { // curveto: cp1 = current point
        if (skipCorruptedPath) { operandStack.length = 0; break; }
        if (operandStack.length !== 4) pathAnomalyCount++;
        if (operandStack.length >= 4) {
          if (operandStack.length > 4) { currentPath = []; operandStack.length = 0; break; }
          const x2 = operandStack[operandStack.length - 4].value;
          const y2 = operandStack[operandStack.length - 3].value;
          const x3 = operandStack[operandStack.length - 2].value;
          const y3 = operandStack[operandStack.length - 1].value;
          pathAnomalyCount = Math.max(0, pathAnomalyCount - 1);
          currentPath.push({
            type: 'C', x1: curX, y1: curY, x2, y2, x: x3, y: y3,
          });
          curX = x3; curY = y3;
        }
        operandStack.length = 0;
        break;
      }
      case 'y': { // curveto: cp2 = endpoint
        if (skipCorruptedPath) { operandStack.length = 0; break; }
        if (operandStack.length !== 4) pathAnomalyCount++;
        if (operandStack.length >= 4) {
          if (operandStack.length > 4) { currentPath = []; operandStack.length = 0; break; }
          const x1 = operandStack[operandStack.length - 4].value;
          const y1 = operandStack[operandStack.length - 3].value;
          const yx = operandStack[operandStack.length - 2].value;
          const yy = operandStack[operandStack.length - 1].value;
          pathAnomalyCount = Math.max(0, pathAnomalyCount - 1);
          curX = yx;
          curY = yy;
          currentPath.push({
            type: 'C', x1, y1, x2: curX, y2: curY, x: curX, y: curY,
          });
        }
        operandStack.length = 0;
        break;
      }
      case 'h': // closepath
        if (skipCorruptedPath) { operandStack.length = 0; break; }
        currentPath.push({ type: 'Z' });
        curX = pathStartX;
        curY = pathStartY;
        operandStack.length = 0;
        break;
      case 're': { // rectangle (x y w h)
        if (skipCorruptedPath) { operandStack.length = 0; break; }
        if (operandStack.length !== 4) pathAnomalyCount++;
        if (operandStack.length >= 4) {
          if (operandStack.length > 4) { currentPath = []; operandStack.length = 0; break; }
          const rx = operandStack[operandStack.length - 4].value;
          const ry = operandStack[operandStack.length - 3].value;
          const rw = operandStack[operandStack.length - 2].value;
          const rh = operandStack[operandStack.length - 1].value;
          pathAnomalyCount = Math.max(0, pathAnomalyCount - 1);
          currentPath.push({ type: 'M', x: rx, y: ry });
          currentPath.push({ type: 'L', x: rx + rw, y: ry });
          currentPath.push({ type: 'L', x: rx + rw, y: ry + rh });
          currentPath.push({ type: 'L', x: rx, y: ry + rh });
          currentPath.push({ type: 'Z' });
          curX = rx; curY = ry;
          pathStartX = rx; pathStartY = ry;
        }
        operandStack.length = 0;
        break;
      }

      // ── Path painting operators ────────────────────────────────────
      case 'S': // stroke
        if (operandStack.length > 0) pathAnomalyCount++;
        if (pendingClip && currentPath.length > 0) {
          clipStack.push({ path: currentPath.slice(), ctm: ctm.slice(), evenOdd: pendingClipEvenOdd });
        }
        pendingClip = false;
        pendingClipEvenOdd = false;
        if (currentPath.length > 0) {
          /** @type {PathDrawOp} */
          const pathOpS = {
            type: 'path',
            commands: currentPath,
            ctm: ctm.slice(),
            fill: false,
            stroke: true,
            evenOdd: false,
            fillColor,
            strokeColor,
            lineWidth,
            lineCap,
            lineJoin,
            miterLimit,
            dashArray: dashArray.length > 0 ? dashArray.slice() : dashArray,
            dashPhase,
            fillAlpha,
            strokeAlpha,
          };
          if (currentSmask) pathOpS.smask = currentSmask;
          if (blendMode !== 'Normal') pathOpS.blendMode = blendMode;
          if (strokePatternShading) pathOpS.strokePatternShading = strokePatternShading;
          if (strokeTilingPattern) pathOpS.strokeTilingPattern = strokeTilingPattern;
          if (!strokeColorExplicit) pathOpS.strokeColorInherited = true;
          if (!strokeAlphaExplicit) pathOpS.strokeAlphaInherited = true;
          ops.push(pathOpS);
        }
        currentPath = [];
        operandStack.length = 0;
        break;
      case 's': // close + stroke
        if (operandStack.length > 0) pathAnomalyCount++;
        currentPath.push({ type: 'Z' });
        if (pendingClip && currentPath.length > 0) {
          clipStack.push({ path: currentPath.slice(), ctm: ctm.slice(), evenOdd: pendingClipEvenOdd });
        }
        pendingClip = false;
        pendingClipEvenOdd = false;
        if (currentPath.length > 0) {
          /** @type {PathDrawOp} */
          const pathOps2 = {
            type: 'path',
            commands: currentPath,
            ctm: ctm.slice(),
            fill: false,
            stroke: true,
            evenOdd: false,
            fillColor,
            strokeColor,
            lineWidth,
            lineCap,
            lineJoin,
            miterLimit,
            dashArray: dashArray.length > 0 ? dashArray.slice() : dashArray,
            dashPhase,
            fillAlpha,
            strokeAlpha,
          };
          if (currentSmask) pathOps2.smask = currentSmask;
          if (blendMode !== 'Normal') pathOps2.blendMode = blendMode;
          if (strokePatternShading) pathOps2.strokePatternShading = strokePatternShading;
          if (strokeTilingPattern) pathOps2.strokeTilingPattern = strokeTilingPattern;
          if (!strokeColorExplicit) pathOps2.strokeColorInherited = true;
          if (!strokeAlphaExplicit) pathOps2.strokeAlphaInherited = true;
          ops.push(pathOps2);
        }
        currentPath = [];
        operandStack.length = 0;
        break;
      case 'f': case 'F': // fill (non-zero winding)
        if (operandStack.length > 0) pathAnomalyCount++;
        if (pathAnomalyCount >= corruptionThreshold) { streamCorrupted = true; currentPath = []; operandStack.length = 0; break; }
        // Per PDF spec §4.4.3, W/W* before a paint operator establishes the clip
        if (pendingClip && currentPath.length > 0) {
          clipStack.push({ path: currentPath.slice(), ctm: ctm.slice(), evenOdd: pendingClipEvenOdd });
        }
        pendingClip = false;
        pendingClipEvenOdd = false;
        if (currentPath.length > 0) {
          /** @type {PathDrawOp} */
          const pathOpF = {
            type: 'path',
            commands: currentPath,
            ctm: ctm.slice(),
            fill: true,
            stroke: false,
            evenOdd: false,
            fillColor,
            strokeColor,
            lineWidth,
            lineCap,
            lineJoin,
            miterLimit,
            dashArray: dashArray.length > 0 ? dashArray.slice() : dashArray,
            dashPhase,
            fillAlpha,
            strokeAlpha,
          };
          if (currentSmask) pathOpF.smask = currentSmask;
          if (blendMode !== 'Normal') pathOpF.blendMode = blendMode;
          if (fillPatternShading) pathOpF.patternShading = fillPatternShading;
          if (fillTilingPattern) pathOpF.tilingPattern = fillTilingPattern;
          if (!fillColorExplicit) pathOpF.fillColorInherited = true;
          if (!fillAlphaExplicit) pathOpF.fillAlphaInherited = true;
          ops.push(pathOpF);
        }
        currentPath = [];
        operandStack.length = 0;
        break;
      case 'f*': // fill (even-odd)
        if (operandStack.length > 0) pathAnomalyCount++;
        if (pendingClip && currentPath.length > 0) {
          clipStack.push({ path: currentPath.slice(), ctm: ctm.slice(), evenOdd: pendingClipEvenOdd });
        }
        pendingClip = false;
        pendingClipEvenOdd = false;
        if (currentPath.length > 0) {
          /** @type {PathDrawOp} */
          const pathOpFS = {
            type: 'path',
            commands: currentPath,
            ctm: ctm.slice(),
            fill: true,
            stroke: false,
            evenOdd: true,
            fillColor,
            strokeColor,
            lineWidth,
            lineCap,
            lineJoin,
            miterLimit,
            dashArray: dashArray.length > 0 ? dashArray.slice() : dashArray,
            dashPhase,
            fillAlpha,
            strokeAlpha,
          };
          if (currentSmask) pathOpFS.smask = currentSmask;
          if (blendMode !== 'Normal') pathOpFS.blendMode = blendMode;
          if (fillPatternShading) pathOpFS.patternShading = fillPatternShading;
          if (fillTilingPattern) pathOpFS.tilingPattern = fillTilingPattern;
          if (!fillColorExplicit) pathOpFS.fillColorInherited = true;
          if (!fillAlphaExplicit) pathOpFS.fillAlphaInherited = true;
          ops.push(pathOpFS);
        }
        currentPath = [];
        operandStack.length = 0;
        break;
      case 'B': // fill + stroke (non-zero)
        if (operandStack.length > 0) pathAnomalyCount++;
        if (pendingClip && currentPath.length > 0) {
          clipStack.push({ path: currentPath.slice(), ctm: ctm.slice(), evenOdd: pendingClipEvenOdd });
        }
        pendingClip = false;
        pendingClipEvenOdd = false;
        if (currentPath.length > 0) {
          /** @type {PathDrawOp} */
          const pathOpB = {
            type: 'path',
            commands: currentPath,
            ctm: ctm.slice(),
            fill: true,
            stroke: true,
            evenOdd: false,
            fillColor,
            strokeColor,
            lineWidth,
            lineCap,
            lineJoin,
            miterLimit,
            dashArray: dashArray.length > 0 ? dashArray.slice() : dashArray,
            dashPhase,
            fillAlpha,
            strokeAlpha,
          };
          if (currentSmask) pathOpB.smask = currentSmask;
          if (blendMode !== 'Normal') pathOpB.blendMode = blendMode;
          if (fillPatternShading) pathOpB.patternShading = fillPatternShading;
          if (fillTilingPattern) pathOpB.tilingPattern = fillTilingPattern;
          if (strokePatternShading) pathOpB.strokePatternShading = strokePatternShading;
          if (strokeTilingPattern) pathOpB.strokeTilingPattern = strokeTilingPattern;
          if (!fillColorExplicit) pathOpB.fillColorInherited = true;
          if (!fillAlphaExplicit) pathOpB.fillAlphaInherited = true;
          if (!strokeColorExplicit) pathOpB.strokeColorInherited = true;
          if (!strokeAlphaExplicit) pathOpB.strokeAlphaInherited = true;
          ops.push(pathOpB);
        }
        currentPath = [];
        operandStack.length = 0;
        break;
      case 'B*': // fill + stroke (even-odd)
        if (operandStack.length > 0) pathAnomalyCount++;
        if (pendingClip && currentPath.length > 0) {
          clipStack.push({ path: currentPath.slice(), ctm: ctm.slice(), evenOdd: pendingClipEvenOdd });
        }
        pendingClip = false;
        pendingClipEvenOdd = false;
        if (currentPath.length > 0) {
          /** @type {PathDrawOp} */
          const pathOpBS = {
            type: 'path',
            commands: currentPath,
            ctm: ctm.slice(),
            fill: true,
            stroke: true,
            evenOdd: true,
            fillColor,
            strokeColor,
            lineWidth,
            lineCap,
            lineJoin,
            miterLimit,
            dashArray: dashArray.length > 0 ? dashArray.slice() : dashArray,
            dashPhase,
            fillAlpha,
            strokeAlpha,
          };
          if (currentSmask) pathOpBS.smask = currentSmask;
          if (blendMode !== 'Normal') pathOpBS.blendMode = blendMode;
          if (fillPatternShading) pathOpBS.patternShading = fillPatternShading;
          if (fillTilingPattern) pathOpBS.tilingPattern = fillTilingPattern;
          if (strokePatternShading) pathOpBS.strokePatternShading = strokePatternShading;
          if (strokeTilingPattern) pathOpBS.strokeTilingPattern = strokeTilingPattern;
          if (!fillColorExplicit) pathOpBS.fillColorInherited = true;
          if (!fillAlphaExplicit) pathOpBS.fillAlphaInherited = true;
          if (!strokeColorExplicit) pathOpBS.strokeColorInherited = true;
          if (!strokeAlphaExplicit) pathOpBS.strokeAlphaInherited = true;
          ops.push(pathOpBS);
        }
        currentPath = [];
        operandStack.length = 0;
        break;
      case 'b': // close + fill + stroke (non-zero)
        if (operandStack.length > 0) pathAnomalyCount++;
        currentPath.push({ type: 'Z' });
        if (pendingClip && currentPath.length > 0) {
          clipStack.push({ path: currentPath.slice(), ctm: ctm.slice(), evenOdd: pendingClipEvenOdd });
        }
        pendingClip = false;
        pendingClipEvenOdd = false;
        if (currentPath.length > 0) {
          /** @type {PathDrawOp} */
          const pathOpb = {
            type: 'path',
            commands: currentPath,
            ctm: ctm.slice(),
            fill: true,
            stroke: true,
            evenOdd: false,
            fillColor,
            strokeColor,
            lineWidth,
            lineCap,
            lineJoin,
            miterLimit,
            dashArray: dashArray.length > 0 ? dashArray.slice() : dashArray,
            dashPhase,
            fillAlpha,
            strokeAlpha,
          };
          if (currentSmask) pathOpb.smask = currentSmask;
          if (blendMode !== 'Normal') pathOpb.blendMode = blendMode;
          if (fillPatternShading) pathOpb.patternShading = fillPatternShading;
          if (fillTilingPattern) pathOpb.tilingPattern = fillTilingPattern;
          if (strokePatternShading) pathOpb.strokePatternShading = strokePatternShading;
          if (strokeTilingPattern) pathOpb.strokeTilingPattern = strokeTilingPattern;
          if (!fillColorExplicit) pathOpb.fillColorInherited = true;
          if (!fillAlphaExplicit) pathOpb.fillAlphaInherited = true;
          if (!strokeColorExplicit) pathOpb.strokeColorInherited = true;
          if (!strokeAlphaExplicit) pathOpb.strokeAlphaInherited = true;
          ops.push(pathOpb);
        }
        currentPath = [];
        operandStack.length = 0;
        break;
      case 'b*': // close + fill + stroke (even-odd)
        if (operandStack.length > 0) pathAnomalyCount++;
        currentPath.push({ type: 'Z' });
        if (pendingClip && currentPath.length > 0) {
          clipStack.push({ path: currentPath.slice(), ctm: ctm.slice(), evenOdd: pendingClipEvenOdd });
        }
        pendingClip = false;
        pendingClipEvenOdd = false;
        if (currentPath.length > 0) {
          /** @type {PathDrawOp} */
          const pathOpbS = {
            type: 'path',
            commands: currentPath,
            ctm: ctm.slice(),
            fill: true,
            stroke: true,
            evenOdd: true,
            fillColor,
            strokeColor,
            lineWidth,
            lineCap,
            lineJoin,
            miterLimit,
            dashArray: dashArray.length > 0 ? dashArray.slice() : dashArray,
            dashPhase,
            fillAlpha,
            strokeAlpha,
          };
          if (currentSmask) pathOpbS.smask = currentSmask;
          if (blendMode !== 'Normal') pathOpbS.blendMode = blendMode;
          if (fillPatternShading) pathOpbS.patternShading = fillPatternShading;
          if (fillTilingPattern) pathOpbS.tilingPattern = fillTilingPattern;
          if (strokePatternShading) pathOpbS.strokePatternShading = strokePatternShading;
          if (strokeTilingPattern) pathOpbS.strokeTilingPattern = strokeTilingPattern;
          if (!fillColorExplicit) pathOpbS.fillColorInherited = true;
          if (!fillAlphaExplicit) pathOpbS.fillAlphaInherited = true;
          if (!strokeColorExplicit) pathOpbS.strokeColorInherited = true;
          if (!strokeAlphaExplicit) pathOpbS.strokeAlphaInherited = true;
          ops.push(pathOpbS);
        }
        currentPath = [];
        operandStack.length = 0;
        break;
      case 'n': // end path (no paint — used for clipping)
        if (operandStack.length > 0) pathAnomalyCount++;
        if (pendingClip && currentPath.length > 0) {
          clipStack.push({ path: currentPath.slice(), ctm: ctm.slice(), evenOdd: pendingClipEvenOdd });
        }
        pendingClip = false;
        pendingClipEvenOdd = false;
        currentPath = [];
        operandStack.length = 0;
        break;
      case 'W': case 'W*': // clipping (path stays for next paint/n)
        pendingClip = true;
        pendingClipEvenOdd = (tok.value === 'W*');
        operandStack.length = 0;
        break;

      default:
        operandStack.length = 0;
        break;
    }

    // Inside a hidden optional-content block: drop anything painted, keep the
    // graphics-state changes already applied above.
    if (ocHidden && ops.length > opsLenBeforeOp) ops.length = opsLenBeforeOp;

    // Attach active clip path to any ops pushed during this operator.
    // The clip from W/W* applies to all subsequent drawing operations until Q restores state.
    if (clipStack.length > 0) {
      for (let j = opsLenBeforeOp; j < ops.length; j++) {
        if (!ops[j].clips) {
          ops[j].clips = clipStack.map((c) => {
            const entry = { path: c.path ? c.path.slice() : null, ctm: c.ctm.slice(), evenOdd: c.evenOdd };
            if (c.textClip) entry.textClip = c.textClip;
            return entry;
          });
        }
      }
    }

    // Attach pattern fill info to text ops (tiling patterns and shading patterns for text fills).
    if (fillPatternShading || fillTilingPattern) {
      for (let j = opsLenBeforeOp; j < ops.length; j++) {
        if (ops[j].type === 'type0text') {
          if (fillPatternShading) ops[j].patternShading = fillPatternShading;
          if (fillTilingPattern) ops[j].tilingPattern = fillTilingPattern;
        }
      }
    }

    // Accumulate text for clipping when Tr mode is 4-7
    if (textRenderMode >= 4) {
      for (let j = opsLenBeforeOp; j < ops.length; j++) {
        const op = ops[j];
        if (op.type === 'type0text' && op.fontFamily && op.text) {
          textClipChars.push({
            text: op.text,
            fontFamily: op.fontFamily,
            fontSize: op.fontSize,
            a: op.a,
            b: op.b,
            c: op.c,
            d: op.d,
            x: op.x,
            y: op.y,
          });
        }
      }
    }
  }

  return ops;
}
