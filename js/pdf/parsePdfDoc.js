import ocr from '../objects/ocrObjects.js';
import {
  calcLang, cleanFamilyName, mean50, round3, round6,
} from '../utils/miscUtils.js';
import {
  findXrefOffset, parseXref, ObjectCache,
  bytesToLatin1, getPageObjects, getPageContentStream, tokenizeContentStream,
  findFormXObjects, extractDict,
} from './parsePdfUtils.js';
import { parsePageFonts } from './fonts/parsePdfFonts.js';
import { parsePagePaths } from './parsePdfPaths.js';
import { detectTableRegions } from './detectPdfTables.js';
import { extractPdfAnnotations, pdfHighlightToAnnotation } from './parsePdfAnnots.js';
import { cmykToRgb } from './pdfColorFunctions.js';
import { assignParagraphs } from '../utils/reflowPars.js';

/** @typedef {import('./parsePdfUtils.js').PDFToken} PDFToken */
/** @typedef {import('../objects/ocrObjects.js').OcrPage} OcrPage */
import { LayoutDataTable, LayoutDataColumn, LayoutDataTablePage } from '../objects/layoutObjects.js';

/**
 * Normalize a PDF color to [r,g,b] in 0-1 for cross-color-space comparison.
 * @param {number[]} c
 */
function colorToRgb(c) {
  if (c.length === 1) return [c[0], c[0], c[0]];
  if (c.length === 3) return [c[0], c[1], c[2]];
  if (c.length === 4) {
    const [r, g, b] = cmykToRgb(c[0], c[1], c[2], c[3]);
    return [r / 255, g / 255, b / 255];
  }
  return null;
}

/**
 * Format an [r,g,b] (0..1) tuple as a lowercase '#rrggbb' hex string.
 * @param {number[]} rgb
 */
function rgbToHex(rgb) {
  /** @param {number} x */
  const clamp = (x) => Math.max(0, Math.min(255, Math.round(x * 255)));
  /** @param {number} x */
  const hex = (x) => clamp(x).toString(16).padStart(2, '0');
  return `#${hex(rgb[0])}${hex(rgb[1])}${hex(rgb[2])}`;
}

/**
 * Parse the ExtGState dictionary from a page (or Form XObject) /Resources entry,
 * returning a map of GS name → { fillAlpha }.
 * @param {string} containerObjText
 * @param {ObjectCache} objCache
 */
function parseFillAlphaExtGStates(containerObjText, objCache) {
  /** @type {Map<string, { fillAlpha: ?number }>} */
  const states = new Map();

  let resourcesText = containerObjText;
  const resRefMatch = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(containerObjText);
  if (resRefMatch) {
    const resObj = objCache.getObjectText(Number(resRefMatch[1]));
    if (resObj) resourcesText = resObj;
  }

  const gsStart = resourcesText.indexOf('/ExtGState');
  if (gsStart === -1) return states;

  let gsDictText;
  const afterGs = resourcesText.substring(gsStart + 10).trim();
  if (afterGs.startsWith('<<')) {
    gsDictText = extractDict(resourcesText, gsStart + 10 + resourcesText.substring(gsStart + 10).indexOf('<<'));
  } else {
    const gsRefMatch = /^(\d+)\s+\d+\s+R/.exec(afterGs);
    if (gsRefMatch) {
      const gsObj = objCache.getObjectText(Number(gsRefMatch[1]));
      if (gsObj) gsDictText = gsObj;
    }
  }
  if (!gsDictText) return states;

  let i = 2;
  while (i < gsDictText.length) {
    if (gsDictText[i] !== '/') { i++; continue; }
    let j = i + 1;
    while (j < gsDictText.length && !/[\s/<>[\]]/.test(gsDictText[j])) j++;
    const gsName = gsDictText.substring(i + 1, j);
    while (j < gsDictText.length && /\s/.test(gsDictText[j])) j++;
    let gsBody;
    if (gsDictText.startsWith('<<', j)) {
      gsBody = extractDict(gsDictText, j);
      i = j + gsBody.length;
    } else {
      const refMatch = /^(\d+)\s+\d+\s+R/.exec(gsDictText.substring(j));
      if (refMatch) {
        const refObj = objCache.getObjectText(Number(refMatch[1]));
        gsBody = refObj || '';
        i = j + refMatch[0].length;
      } else {
        i = j + 1;
        continue;
      }
    }
    const caMatch = /\/ca\s+([0-9.]+)/.exec(gsBody);
    states.set(gsName, { fillAlpha: caMatch ? parseFloat(caMatch[1]) : null });
  }
  return states;
}

export {
  bytesToLatin1, getPageObjects, getPageContentStream, getPageContentStreams, tokenizeContentStream, collectPageTreeObjNums,
} from './parsePdfUtils.js';

const SYMBOL_FONT_RE = /^(?:Webdings|Wingdings|ZapfDingbats|Symbol)(?:[-\s].*)?$/i;

function isSymbolFontFamily(familyName = '') {
  return SYMBOL_FONT_RE.test(familyName);
}

/**
 * Scan content stream tokens for Do operators and record the CTM at each invocation.
 * @param {Array<PDFToken>} tokens
 * @param {Map<string, { objNum: number }>} formXObjects
 * @param {number[]} initialCtm
 */
function findDoOperators(tokens, formXObjects, initialCtm) {
  const doOps = [];
  let ctm = initialCtm.slice();
  const ctmStack = [];
  const operandStack = [];

  for (const tok of tokens) {
    if (tok.type !== 'operator') {
      operandStack.push(tok);
      continue;
    }
    switch (tok.value) {
      case 'q':
        ctmStack.push(ctm.slice());
        break;
      case 'Q':
        if (ctmStack.length > 0) ctm = ctmStack.pop();
        break;
      case 'cm':
        if (operandStack.length >= 6) {
          const m = operandStack.slice(operandStack.length - 6).map((t) => t.value);
          ctm = multiplyMatrices(m, ctm);
        }
        break;
      case 'Do':
        if (operandStack.length >= 1) {
          const name = operandStack[operandStack.length - 1].value;
          if (formXObjects.has(name)) {
            doOps.push({ name, ctm: ctm.slice() });
          }
        }
        break;
      default:
        break;
    }
    operandStack.length = 0;
  }

  return doOps;
}

/**
 * Recursively extract text from Form XObjects referenced by Do operators.
 * Follows nested form XObjects to arbitrary depth (with cycle detection).
 * @param {string} containerObjText - Object text of the container (page or parent form XObject)
 * @param {Array<PDFToken>} containerTokens - Tokenized content stream of the container
 * @param {Map} parentFonts - Fonts available from the parent scope
 * @param {number} scale
 * @param {number} pageHeightPts
 * @param {number[]} containerCtm - CTM at the container level
 * @param {ObjectCache} objCache
 * @param {Set<number>} visited - Object numbers already visited (cycle detection)
 * @param {Map<string, { fillAlpha: ?number }>} [parentExtGStates] - ExtGState map inherited from the parent scope
 */
function extractFormXObjectText(containerObjText, containerTokens, parentFonts, scale, pageHeightPts, containerCtm, objCache, visited, parentExtGStates) {
  const chars = [];
  const formXObjects = findFormXObjects(containerObjText, objCache);
  if (formXObjects.size === 0) return chars;

  const doOps = findDoOperators(containerTokens, formXObjects, containerCtm);
  for (const doOp of doOps) {
    const form = formXObjects.get(doOp.name);
    if (visited.has(form.objNum)) continue;
    visited.add(form.objNum);

    const formObjText = objCache.getObjectText(form.objNum);
    if (!formObjText) continue;
    const formBytes = objCache.getStreamBytes(form.objNum);
    if (!formBytes) continue;
    const formContentStream = bytesToLatin1(formBytes);
    const formFonts = parsePageFonts(formObjText, objCache);
    const mergedFonts = new Map([...parentFonts, ...formFonts]);
    const formExtGStates = parseFillAlphaExtGStates(formObjText, objCache);
    const mergedExtGStates = formExtGStates.size > 0
      ? new Map([...(parentExtGStates || []), ...formExtGStates])
      : parentExtGStates;
    const matrixMatch = /\/Matrix\s*\[\s*([\d.\-\s]+)\]/.exec(formObjText);
    const formMatrix = matrixMatch
      ? matrixMatch[1].trim().split(/\s+/).map(Number)
      : [1, 0, 0, 1, 0, 0];
    const formCtm = multiplyMatrices(formMatrix, doOp.ctm);
    const formTokens = tokenizeContentStream(formContentStream);
    const formChars = executeTextOperators(
      formTokens, mergedFonts, scale, pageHeightPts, formCtm, mergedExtGStates,
    );
    for (let ci = 0; ci < formChars.length; ci++) chars.push(formChars[ci]);

    // Recurse into nested form XObjects within this form's content stream.
    const nestedChars = extractFormXObjectText(
      formObjText, formTokens, mergedFonts, scale, pageHeightPts, formCtm, objCache, visited, mergedExtGStates,
    );
    for (let ci = 0; ci < nestedChars.length; ci++) chars.push(nestedChars[ci]);
  }

  return chars;
}

/**
 * @typedef {{ printable: number, printableVis: number, pua: number, control: number, controlVis: number }} CharStats
 */

/**
 * Categorize positioned characters for type-detection scoring.
 * @param {Array<PositionedChar>} chars
 * @returns {CharStats}
 */
function scorePageChars(chars) {
  let printable = 0;
  let printableVis = 0;
  let pua = 0;
  let control = 0;
  let controlVis = 0;
  for (const ch of chars) {
    const codePoint = ch.text.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint >= 33 && codePoint <= 127) {
      printable++;
      if (!ch.invisible) printableVis++;
    } else if (codePoint >= 0xE000 && codePoint <= 0xF8FF) {
      pua++;
    } else if (codePoint >= 161) {
      printable++;
      if (!ch.invisible) printableVis++;
    } else if (codePoint < 32 || codePoint === 65533) {
      control++;
      if (!ch.invisible) controlVis++;
    }
  }
  return {
    printable, printableVis, pua, control, controlVis,
  };
}

/**
 * Determine PDF type from per-page character statistics.
 * @param {CharStats[]} pageStats
 * @param {number} pageCount
 */
export function determinePdfType(pageStats, pageCount) {
  let letterCountTotal = 0;
  let letterCountVis = 0;
  let pageCountTotalText = 0;
  let pageCountVisText = 0;
  let brokenCharCount = 0;
  let scoredCharCount = 0;
  for (const s of pageStats) {
    const pageScoreTotal = s.printable - 5 * s.control;
    const pageScoreVis = s.printableVis - 5 * s.controlVis;
    letterCountTotal += pageScoreTotal;
    letterCountVis += pageScoreVis;
    if (pageScoreTotal >= 100) pageCountTotalText++;
    if (pageScoreVis >= 100) pageCountVisText++;
    brokenCharCount += s.pua + s.control;
    scoredCharCount += s.printable + s.pua + s.control;
  }

  /** @type {"image" | "text" | "ocr"} */
  let type = 'image';
  if (letterCountTotal >= pageCount * 100
    && letterCountVis >= letterCountTotal * 0.9
    && pageCountVisText >= pageCount / 2) {
    type = 'text';
  } else if (letterCountTotal >= pageCount * 100
    && pageCountTotalText >= pageCount / 2) {
    type = 'ocr';
  }

  return { type, brokenCharCount, scoredCharCount };
}

/**
 * Process a single PDF page: parse fonts, extract text, compute type-detection scores.
 * @param {{ objText: string, mediaBox: number[], cropBox: number[]|null, rotate: number }} page
 * @param {ObjectCache} objCache
 * @param {number} n - Page index
 * @param {number} dpi
 */
export function parseSinglePage(page, objCache, n, dpi) {
  const {
    objText, mediaBox, cropBox, rotate,
  } = page;
  // Use CropBox when available — it defines the visible region.
  // Content outside the CropBox (e.g. printer slug metadata) should not be extracted.
  const effectiveBox = cropBox || mediaBox;
  const contentWidthPts = effectiveBox[2] - effectiveBox[0];
  const contentHeightPts = effectiveBox[3] - effectiveBox[1];

  // Compute initial CTM and visual page dimensions based on /Rotate.
  // /Rotate specifies clockwise rotation for display.
  // When the effective box origin is non-zero (e.g. CropBox [36 36 648 828]),
  // bake a translation into the initial CTM so that coordinates are relative
  // to the box origin. This matches how the renderer handles CropBox offsets.
  const boxOriginX = effectiveBox[0];
  const boxOriginY = effectiveBox[1];
  let initialCtm = [1, 0, 0, 1, -boxOriginX, -boxOriginY];
  let visualWidthPts = contentWidthPts;
  let visualHeightPts = contentHeightPts;
  if (rotate === 90) {
    // 90° CW: content (x,y) → visual (y, W-x)
    initialCtm = [0, -1, 1, 0, -boxOriginY, contentWidthPts + boxOriginX];
    visualWidthPts = contentHeightPts;
    visualHeightPts = contentWidthPts;
  } else if (rotate === 180) {
    // 180°: content (x,y) → visual (W-x, H-y)
    initialCtm = [-1, 0, 0, -1, contentWidthPts + boxOriginX, contentHeightPts + boxOriginY];
  } else if (rotate === 270) {
    // 270° CW (= 90° CCW): content (x,y) → visual (H-y, x)
    initialCtm = [0, 1, -1, 0, contentHeightPts + boxOriginY, -boxOriginX];
    visualWidthPts = contentHeightPts;
    visualHeightPts = contentWidthPts;
  }

  // Cap page width at 3500px to match the renderer (renderPdfPage.js) and
  // imageContainer.js. Without this, wide pages produce text positions in a
  // larger coordinate space than the rendered image, causing overlay misalignment.
  const maxWidth = 3500;
  const scale300 = dpi / 72;
  const fullWidth = Math.round(visualWidthPts * scale300);
  const scale = fullWidth > maxWidth ? maxWidth / visualWidthPts : scale300;

  const pageWidth = Math.round(visualWidthPts * scale);
  const pageHeight = Math.round(visualHeightPts * scale);

  const fonts = parsePageFonts(objText, objCache);
  const fontSummary = [...fonts].map(([tag, f]) => ({
    tag,
    baseName: f.baseName,
    familyName: f.familyName,
    bold: f.bold,
    italic: f.italic,
    smallCaps: f.smallCaps,
    isCID: f.isCIDFont,
    hasToUnicode: f.hasOwnToUnicode,
    toUnicodeCount: f.toUnicode.size,
    widthCount: f.widths.size,
    isType0: !!f.type0,
    isType1: !!f.type1,
    isType3: !!f.type3,
    embedded: !!(f.type0?.fontFile || f.type1?.fontFile),
    hasDifferences: !!f.differences,
  }));

  const contentStreamText = getPageContentStream(objText, objCache);
  if (!contentStreamText) {
    const pageObj = new ocr.OcrPage(n, { width: pageWidth, height: pageHeight });
    const charStats = {
      printable: 0, printableVis: 0, pua: 0, control: 0, controlVis: 0,
    };
    return {
      pageObj, langSet: new Set(), fontSet: new Set(), dataTablePage: new LayoutDataTablePage(n), charStats, fontSummary,
    };
  }

  const tokens = tokenizeContentStream(contentStreamText);
  const extGStates = parseFillAlphaExtGStates(objText, objCache);
  const chars = executeTextOperators(tokens, fonts, scale, visualHeightPts, initialCtm, extGStates);

  // Extract text from Form XObjects referenced by Do operators in the content stream.
  // Recurse into nested form XObjects so that deeply-nested text (e.g. 3+ levels) is extracted.
  const formChars = extractFormXObjectText(
    objText, tokens, fonts, scale, visualHeightPts, initialCtm, objCache, new Set(), extGStates,
  );
  for (let ci = 0; ci < formChars.length; ci++) chars.push(formChars[ci]);

  // Remove chars outside the visible page bounds (e.g. printer slug metadata
  // placed above the CropBox). Use a generous margin (1 fontSize) to avoid
  // clipping chars that slightly overhang the boundary.
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i];
    const margin = ch.fontSize || 0;
    if (ch.x + margin < 0 || ch.x > pageWidth + margin
        || ch.y + margin < 0 || ch.y > pageHeight + margin) {
      chars.splice(i, 1);
    }
  }

  const charStats = scorePageChars(chars);

  // Extract underline candidate rectangles from vector paths. Pass the already-computed
  // tokens so parsePagePaths doesn't re-fetch and re-tokenize the page content stream.
  const paths = parsePagePaths(objText, objCache, tokens);
  const underlineRects = [];
  for (const path of paths) {
    if (!path.fill && !path.stroke) continue;
    let minX = Infinity; let maxX = -Infinity;
    let minY = Infinity; let maxY = -Infinity;
    for (const cmd of path.commands) {
      if (cmd.type === 'M' || cmd.type === 'L') {
        if (cmd.x < minX) minX = cmd.x;
        if (cmd.x > maxX) maxX = cmd.x;
        if (cmd.y < minY) minY = cmd.y;
        if (cmd.y > maxY) maxY = cmd.y;
      }
    }
    const w = maxX - minX;
    const h = maxY - minY;
    if (h < 2 && w > 10) {
      const lineColor = path.stroke ? path.strokeColor : path.fillColor;
      underlineRects.push({
        left: (minX - boxOriginX) * scale,
        right: (maxX - boxOriginX) * scale,
        y: (visualHeightPts - (maxY - boxOriginY)) * scale,
        color: lineColor,
      });
    }
  }

  const {
    pageObj, langSet, fontSet, dataTablePage,
  } = groupCharsIntoPage(chars, n, pageWidth, pageHeight, underlineRects, paths, scale, visualHeightPts, boxOriginX, boxOriginY);

  // Extract highlight annotations + non-highlight passthrough refs. Converted
  // to pixel-space AnnotationHighlight here so every coord-space fact about
  // the page (scale, rotation CTM, Y-flip) stays local to parseSinglePage.
  const { highlights: highlightsRaw, passthroughRefs } = extractPdfAnnotations(objCache, objText);
  const annotations = highlightsRaw.map((raw, i) => pdfHighlightToAnnotation(raw, {
    scale,
    visualHeightPts,
    initialCtm,
    groupId: `_pdf_p${n}_a${raw.objNum}`,
  }));

  return {
    pageObj, langSet, fontSet, dataTablePage, charStats, fontSummary, annotations, annotationPassthroughRefs: passthroughRefs,
  };
}

/**
 * Extract text content directly from PDF raw bytes into OcrPage objects.
 * @param {Uint8Array} pdfBytes
 * @param {{ dpi?: number, pageIndices?: number[] }} [options]
 */
export function extractPDFTextDirect(pdfBytes, options = {}) {
  const dpi = options.dpi || 300;
  const pageIndices = options.pageIndices || null;

  const xrefOffset = findXrefOffset(pdfBytes);
  const xrefEntries = parseXref(pdfBytes, xrefOffset);
  const objCache = new ObjectCache(pdfBytes, xrefEntries);

  const pages = getPageObjects(objCache);
  const results = [];

  if (pageIndices) {
    const pageSet = new Set(pageIndices);
    for (let n = 0; n < pages.length; n++) {
      if (pageSet.has(n)) {
        results.push(parseSinglePage(pages[n], objCache, n, dpi));
      } else {
        results.push(null);
      }
    }
  } else {
    for (let n = 0; n < pages.length; n++) {
      results.push(parseSinglePage(pages[n], objCache, n, dpi));
    }
  }

  return results;
}

/**
 * Detect PDF type (text-native, OCR, or image) by counting visible vs invisible characters.
 * @param {Uint8Array} pdfBytes
 */
export function detectPdfType(pdfBytes) {
  const xrefOffset = findXrefOffset(pdfBytes);
  const xrefEntries = parseXref(pdfBytes, xrefOffset);
  const objCache = new ObjectCache(pdfBytes, xrefEntries);

  const pages = getPageObjects(objCache);
  const pageStats = [];

  for (let n = 0; n < pages.length; n++) {
    const { objText, mediaBox } = pages[n];
    const fonts = parsePageFonts(objText, objCache);
    const contentStreamText = getPageContentStream(objText, objCache);
    if (!contentStreamText) continue;

    const pageHeightPts = mediaBox[3] - mediaBox[1];
    const tokens = tokenizeContentStream(contentStreamText);
    const chars = executeTextOperators(tokens, fonts, 1, pageHeightPts);
    pageStats.push(scorePageChars(chars));
  }

  return determinePdfType(pageStats, pages.length);
}

/**
 * @typedef {{
 *   text: string, x: number, y: number, width: number, fontSize: number,
 *   fontInfo: { baseName: string, bold: boolean, italic: boolean, smallCaps: boolean,
 *     familyName: string, ascent: number, descent: number },
 *   invisible: boolean,
 *   orientation: number,
 *   dirX: number, dirY: number,
 *   textColor?: number[],
 *   alpha?: number,
 *   _perpDist?: number
 * }} PositionedChar
 */

/**
 * Multiply two 6-element PDF matrices [a, b, c, d, e, f].
 * @param {number[]} a
 * @param {number[]} b
 */
function multiplyMatrices(a, b) {
  return [
    a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

/**
 * Execute text operators from tokenized content stream and extract positioned characters.
 * @param {Array<PDFToken>} tokens
 * @param {Map<string, object>} fonts
 * @param {number} scale - DPI scale factor (dpi/72)
 * @param {number} pageHeightPts - visual page height in PDF points (after /Rotate)
 * @param {number[]} [initialCtm] - initial CTM incorporating /Rotate transform
 * @param {Map<string, { fillAlpha: ?number }>} [extGStates] - ExtGState map (name → entry) for `gs` operator
 * @returns {Array<PositionedChar>}
 */
function executeTextOperators(tokens, fonts, scale, pageHeightPts, initialCtm, extGStates) {
  const chars = /** @type {Array<PositionedChar>} */ ([]);

  // Graphics state
  let ctm = initialCtm ? initialCtm.slice() : [1, 0, 0, 1, 0, 0]; // current transformation matrix
  let tr = 0; // text rendering mode (0-7; mode 3 = invisible)
  /** @type {number[]} */
  let textColor = [0]; // current non-stroking (fill) color — default black
  let fillAlpha = 1; // current non-stroking alpha (from ExtGState /ca via `gs`)
  /** @type {Array<{ ctm: number[], tr: number, tc: number, tw: number, tz: number, tl: number, trise: number, fontSize: number, currentFont: any, textColor: number[], fillAlpha: number }>} */
  const gsStack = [];

  // Text state
  let tm = [1, 0, 0, 1, 0, 0]; // text matrix
  let tlm = [1, 0, 0, 1, 0, 0]; // text line matrix
  let currentFont = null;
  let fontSize = 12;
  let tc = 0; // character spacing
  let tw = 0; // word spacing
  let tz = 100; // horizontal scaling percentage (PDF spec §9.3.4 Th = Tz/100)
  let tl = 0; // leading
  let trise = 0; // text rise (unscaled text-space units, applied to glyph y in Trm)

  /** @type {Array<any>} */
  const operandStack = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    if (tok.type !== 'operator') {
      operandStack.push(tok);
      continue;
    }

    const op = tok.value;
    const charsBeforeOp = chars.length;

    switch (op) {
      // Graphics state operators
      case 'q':
        gsStack.push({
          ctm: ctm.slice(), tr, tc, tw, tz, tl, trise, fontSize, currentFont, textColor: textColor.slice(), fillAlpha,
        });
        operandStack.length = 0;
        break;

      case 'Q':
        if (gsStack.length > 0) {
          const saved = /** @type {NonNullable<ReturnType<typeof gsStack.pop>>} */ (gsStack.pop());
          ctm = saved.ctm;
          tr = saved.tr;
          tc = saved.tc;
          tw = saved.tw;
          tz = saved.tz;
          tl = saved.tl;
          trise = saved.trise;
          fontSize = saved.fontSize;
          currentFont = saved.currentFont;
          textColor = saved.textColor;
          fillAlpha = saved.fillAlpha;
        }
        operandStack.length = 0;
        break;

      case 'cm': {
        if (operandStack.length >= 6) {
          const m = operandStack.slice(operandStack.length - 6).map((t) => t.value);
          ctm = multiplyMatrices(m, ctm);
        }
        operandStack.length = 0;
        break;
      }

      // Text object operators
      case 'BT':
        tm = [1, 0, 0, 1, 0, 0];
        tlm = [1, 0, 0, 1, 0, 0];
        operandStack.length = 0;
        break;

      case 'ET':
        operandStack.length = 0;
        break;

      case 'Tf': {
        const size = operandStack.length >= 2 ? operandStack[operandStack.length - 1] : null;
        const name = operandStack.length >= 2 ? operandStack[operandStack.length - 2] : null;
        if (name && name.type === 'name' && size && size.type === 'number') {
          currentFont = fonts.get(name.value) || null;
          fontSize = Math.abs(size.value);
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

      case 'TL':
        if (operandStack.length >= 1) tl = operandStack[operandStack.length - 1].value;
        operandStack.length = 0;
        break;

      case 'Tr':
        if (operandStack.length >= 1) tr = operandStack[operandStack.length - 1].value;
        operandStack.length = 0;
        break;

      case 'Ts':
        if (operandStack.length >= 1) trise = operandStack[operandStack.length - 1].value;
        operandStack.length = 0;
        break;

      case 'Tm': {
        if (operandStack.length >= 6) {
          tm = operandStack.slice(operandStack.length - 6).map((t) => t.value);
          tlm = tm.slice();
        }
        operandStack.length = 0;
        break;
      }

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

      case 'Tj': {
        if (operandStack.length >= 1 && currentFont) {
          const strTok = operandStack[operandStack.length - 1];
          if (strTok.type === 'hexstring') {
            showHexString(strTok.value, currentFont, fontSize, tm, ctm, tc, tw, tz, tr, trise, chars, scale, pageHeightPts);
          } else if (strTok.type === 'string') {
            showLiteralString(strTok.value, currentFont, fontSize, tm, ctm, tc, tw, tz, tr, trise, chars, scale, pageHeightPts);
          }
        }
        operandStack.length = 0;
        break;
      }

      case 'TJ': {
        if (operandStack.length >= 1 && currentFont) {
          const arrTok = operandStack[operandStack.length - 1];
          if (arrTok.type === 'array') {
            for (const elem of arrTok.value) {
              if (elem.type === 'hexstring') {
                showHexString(elem.value, currentFont, fontSize, tm, ctm, tc, tw, tz, tr, trise, chars, scale, pageHeightPts);
              } else if (elem.type === 'string') {
                showLiteralString(elem.value, currentFont, fontSize, tm, ctm, tc, tw, tz, tr, trise, chars, scale, pageHeightPts);
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
          const strTok = operandStack[operandStack.length - 1];
          if (strTok.type === 'hexstring') {
            showHexString(strTok.value, currentFont, fontSize, tm, ctm, tc, tw, tz, tr, trise, chars, scale, pageHeightPts);
          } else if (strTok.type === 'string') {
            showLiteralString(strTok.value, currentFont, fontSize, tm, ctm, tc, tw, tz, tr, trise, chars, scale, pageHeightPts);
          }
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
          const strTok = operandStack[operandStack.length - 1];
          if (strTok.type === 'hexstring') {
            showHexString(strTok.value, currentFont, fontSize, tm, ctm, tc, tw, tz, tr, trise, chars, scale, pageHeightPts);
          } else if (strTok.type === 'string') {
            showLiteralString(strTok.value, currentFont, fontSize, tm, ctm, tc, tw, tz, tr, trise, chars, scale, pageHeightPts);
          }
        }
        operandStack.length = 0;
        break;
      }

      // Non-stroking color operators (text fill color).
      case 'g': case 'rg': case 'k': case 'sc': case 'scn':
        textColor = operandStack.map((t) => t.value);
        operandStack.length = 0;
        break;

      // Graphics state parameters (sets non-stroking alpha via /ca).
      case 'gs': {
        if (operandStack.length >= 1 && extGStates) {
          const nameTok = operandStack[operandStack.length - 1];
          if (nameTok && nameTok.type === 'name') {
            const entry = extGStates.get(nameTok.value);
            if (entry && entry.fillAlpha !== null && entry.fillAlpha !== undefined) {
              fillAlpha = entry.fillAlpha;
            }
          }
        }
        operandStack.length = 0;
        break;
      }

      default:
        operandStack.length = 0;
        break;
    }

    // Tag newly-added chars with the current text color and alpha.
    if (op === 'Tj' || op === 'TJ' || op === "'" || op === '"') {
      for (let ci = charsBeforeOp; ci < chars.length; ci++) {
        chars[ci].textColor = textColor;
        chars[ci].alpha = fillAlpha;
      }
    }
  }

  return chars;
}

/**
 * Decode hex string to a latin1 byte string and delegate to showLiteralString,
 * which handles both CID (2-byte / mixed-width via codespace ranges) and simple
 * fonts uniformly.
 * @param {string} hex
 * @param {object} font
 * @param {number} fontSize
 * @param {number[]} tm - text matrix (modified in place)
 * @param {number[]} ctm - current transformation matrix
 * @param {number} tc
 * @param {number} tw
 * @param {number} tz - horizontal scaling percentage (Tz, 100 = normal)
 * @param {number} tr - text rendering mode
 * @param {number} trise - text rise (unscaled text-space units)
 * @param {Array<PositionedChar>} chars
 * @param {number} scale
 * @param {number} pageHeightPts - page height in PDF points
 */
function showHexString(hex, font, fontSize, tm, ctm, tc, tw, tz, tr, trise, chars, scale, pageHeightPts) {
  let str = '';
  for (let i = 0; i + 1 <= hex.length; i += 2) {
    str += String.fromCharCode(parseInt(hex.substring(i, i + 2), 16));
  }
  showLiteralString(str, font, fontSize, tm, ctm, tc, tw, tz, tr, trise, chars, scale, pageHeightPts);
}

/**
 * Decode literal string and show characters (for simple encodings).
 * @param {string} str
 * @param {object} font
 * @param {number} fontSize
 * @param {number[]} tm
 * @param {number[]} ctm
 * @param {number} tc
 * @param {number} tw
 * @param {number} tz - horizontal scaling percentage (Tz, 100 = normal)
 * @param {number} tr - text rendering mode
 * @param {number} trise - text rise (unscaled text-space units)
 * @param {Array<PositionedChar>} chars
 * @param {number} scale
 * @param {number} pageHeightPts
 */
function showLiteralString(str, font, fontSize, tm, ctm, tc, tw, tz, tr, trise, chars, scale, pageHeightPts) {
  const hScale = Math.hypot(tm[0] * ctm[0] + tm[1] * ctm[2], tm[0] * ctm[1] + tm[1] * ctm[3]);
  const vScale = Math.hypot(tm[2] * ctm[0] + tm[3] * ctm[2], tm[2] * ctm[1] + tm[3] * ctm[3]);

  const dirX = tm[0] * ctm[0] + tm[1] * ctm[2];
  const dirY = -(tm[0] * ctm[1] + tm[1] * ctm[3]);
  const dirMag = Math.hypot(dirX, dirY);
  let orientation = 0;
  if (dirMag > 0.001) {
    const ndx = dirX / dirMag;
    const ndy = dirY / dirMag;
    if (Math.abs(ndx) < 0.5 && ndy >= 0.5) orientation = 1;
    else if (ndx <= -0.5 && Math.abs(ndy) < 0.5) orientation = 2;
    else if (Math.abs(ndx) < 0.5 && ndy <= -0.5) orientation = 3;
  }

  // Type0/CID fonts typically use 2-byte encoding, but some CMaps define
  // 1-byte or mixed-width codespace ranges (e.g. OneByteIdentityH).
  const isCID = font.type0 || font.isCIDFont;
  const csRanges = font.codespaceRanges;
  let i = 0;
  while (i < str.length) {
    let charCode;
    let numBytes;
    if (!isCID) {
      charCode = str.charCodeAt(i);
      numBytes = 1;
    } else if (csRanges) {
      const byte0 = str.charCodeAt(i);
      numBytes = 2; // default for CID
      let matched = false;
      for (let r = 0; r < csRanges.length; r++) {
        const range = csRanges[r];
        if (range.bytes === 1 && byte0 >= range.low && byte0 <= range.high) {
          charCode = byte0;
          numBytes = 1;
          matched = true;
          break;
        }
        if (range.bytes === 2 && i + 1 < str.length) {
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
      if (i + 1 >= str.length) break;
      charCode = (str.charCodeAt(i) << 8) | str.charCodeAt(i + 1);
      numBytes = 2;
    }
    i += numBytes;
    const toUnicodeValue = font.toUnicode.get(charCode);
    const encodingValue = font.encodingUnicode?.get(charCode);
    let unicode = toUnicodeValue || encodingValue;

    // Broken ToUnicode maps can flip ASCII letter case while still mapping to
    // the same underlying letter (e.g. E->e). For fonts flagged by parsePageFonts,
    // prefer encodingUnicode's case for those one-letter conflicts.
    if (font.preferEncodingCase
      && toUnicodeValue
      && encodingValue
      && toUnicodeValue.length === 1
      && encodingValue.length === 1
      && /[A-Za-z]/.test(toUnicodeValue)
      && /[A-Za-z]/.test(encodingValue)
      && toUnicodeValue !== encodingValue
      && toUnicodeValue.toLowerCase() === encodingValue.toLowerCase()) {
      unicode = encodingValue;
    }

    if (!unicode) {
      // CFF charset says this CID has no glyph — skip emission and advance.
      if (isCID && font.validCIDs && !font.validCIDs.has(charCode)) continue;
      unicode = isCID ? String.fromCharCode(charCode) : str[i - numBytes];
    }
    const glyphWidth = (font.widths.get(charCode) ?? font.defaultWidth) / 1000 * fontSize;

    // Transform text position through CTM to get page-space coordinates.
    const ox = tm[2] * trise + tm[4];
    const oy = tm[3] * trise + tm[5];
    const pageX = ctm[0] * ox + ctm[2] * oy + ctm[4];
    const pageY = ctm[1] * ox + ctm[3] * oy + ctm[5];

    chars.push({
      text: unicode,
      x: pageX * scale,
      y: (pageHeightPts - pageY) * scale,
      width: glyphWidth * tz / 100 * hScale * scale,
      // Keep fontSize tied to the text rendering matrix scale in device space.
      // Type3 ascent/descent is handled in bbox computation, not size scaling.
      fontSize: fontSize * vScale * scale,
      fontInfo: {
        baseName: font.baseName,
        bold: font.bold || tr === 1 || tr === 2,
        italic: font.italic || (Math.abs(tm[2]) > Math.abs(tm[0]) * 0.05 && Math.abs(tm[1]) < Math.abs(tm[0]) * 0.05),
        smallCaps: font.smallCaps,
        familyName: font.familyName,
        ascent: font.ascent,
        descent: font.descent,
      },
      invisible: tr === 3,
      orientation,
      dirX,
      dirY,
    });

    const isWordSpace = numBytes === 1 && charCode === 0x20;
    const advance = (glyphWidth + tc + (isWordSpace ? tw : 0)) * tz / 100;
    tm[4] += advance * tm[0];
    tm[5] += advance * tm[1];
  }
}

/**
 * Group positioned characters into OcrPage with lines and words.
 * @param {Array<PositionedChar>} chars
 * @param {number} n - page number (0-indexed)
 * @param {number} pageWidth - in pixels at target DPI
 * @param {number} pageHeight - in pixels at target DPI
 * @param {Array<{left: number, right: number, y: number, color?: number[]}>} [underlineRects] - thin horizontal rectangles for underline detection
 * @param {Array} [paths] - raw vector paths from parsePagePaths
 * @param {number} [scale] - DPI scale factor
 * @param {number} [visualHeightPts] - page height in points
 * @param {number} [boxOriginX] - X origin of effective page box in points
 * @param {number} [boxOriginY] - Y origin of effective page box in points
 */
function groupCharsIntoPage(chars, n, pageWidth, pageHeight, underlineRects = [], paths = [], scale = 1, visualHeightPts = 0, boxOriginX = 0, boxOriginY = 0) {
  const pageObj = new ocr.OcrPage(n, { width: pageWidth, height: pageHeight });
  const langSet = new Set();
  const fontSet = new Set();

  if (chars.length === 0) {
    return {
      pageObj, langSet, fontSet, dataTablePage: new LayoutDataTablePage(n),
    };
  }

  // Replace non-breaking spaces with regular spaces.
  for (const ch of chars) {
    if (ch.text === '\u00A0') ch.text = ' ';
  }

  // Dedupe overlapping glyphs from PDFs that use two text-rendering passes
  // (separate fill + stroke) to fake-bold a heading. Without dedup the same
  // glyph appears twice and fragments word grouping. Match on text + font +
  // orientation + position (~1px); OR the bold flag onto the surviving char.
  // eslint-disable-next-line no-param-reassign
  chars = (() => {
    const result = [];
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      let dupeIdx = -1;
      // Limit lookback — duplicates are emitted as adjacent passes within the
      // same text run, so a small window keeps this O(n) in practice.
      for (let j = result.length - 1; j >= Math.max(0, result.length - 8); j--) {
        const prev = result[j];
        if (prev.text === ch.text
            && prev.fontInfo.baseName === ch.fontInfo.baseName
            && prev.orientation === ch.orientation
            && Math.abs(prev.x - ch.x) < 1
            && Math.abs(prev.y - ch.y) < 1) {
          dupeIdx = j;
          break;
        }
      }
      if (dupeIdx >= 0) {
        if (ch.fontInfo.bold) result[dupeIdx].fontInfo.bold = true;
        if (!ch.invisible) result[dupeIdx].invisible = false;
        continue;
      }
      result.push(ch);
    }
    return result;
  })();

  // Transform coordinates for non-zero orientations into a "virtual horizontal" system
  // so the same line-grouping and word-splitting logic works for all orientations.
  // The transformations preserve ascent/descent behavior in the virtual y-direction.
  for (const ch of chars) {
    if (ch.orientation === 1) {
      // Orientation 1 (text going downward on screen): virtualX = y, virtualY = pageWidth - x
      const vx = ch.y;
      const vy = pageWidth - ch.x;
      ch.x = vx;
      ch.y = vy;
    } else if (ch.orientation === 2) {
      // Orientation 2 (text going leftward): virtualX = pageWidth - x, virtualY = pageHeight - y
      ch.x = pageWidth - ch.x;
      ch.y = pageHeight - ch.y;
    } else if (ch.orientation === 3) {
      // Orientation 3 (text going upward on screen): virtualX = pageHeight - y, virtualY = x
      const vx = pageHeight - ch.y;
      const vy = ch.x;
      ch.x = vx;
      ch.y = vy;
    }
  }

  // Compute average text direction for orientation-0 chars to enable rotation-aware line grouping.
  // For near-horizontal text, perpDist ≈ y so grouping is unchanged from pure y-sort.
  // For rotated text (e.g., 5° page tilt), perpDist correctly groups chars along rotated baselines.
  let avgDirX = 0;
  let avgDirY = 0;
  let orient0Count = 0;
  for (const ch of chars) {
    if (ch.orientation === 0) {
      avgDirX += ch.dirX;
      avgDirY += ch.dirY;
      orient0Count++;
    }
  }
  if (orient0Count > 0) {
    const mag = Math.hypot(avgDirX, avgDirY);
    if (mag > 0) { avgDirX /= mag; avgDirY /= mag; }
  }
  if (orient0Count === 0 || (avgDirX === 0 && avgDirY === 0)) {
    avgDirX = 1; avgDirY = 0;
  }

  // For orientation-0 chars, compute perpendicular distance from the average text direction.
  for (const ch of chars) {
    if (ch.orientation === 0) {
      ch._perpDist = -ch.x * avgDirY + ch.y * avgDirX;
    }
  }

  // Split chars into lines by processing in stream order and placing cuts.
  // Superscripts (small y-jump + font size change) are kept inline — no cut.
  // Space characters are added to the current line without cut evaluation,
  // since their font metrics can be unreliable (intermediate font sizes that
  // mask the actual text-to-superscript font ratio change).
  const lines = [];
  let currentLine = [chars[0]];
  // Track the line's anchor baseline: the y-position of the first full-size
  // (non-superscript) char. Used to detect baseline shifts masked by bridging
  // superscripts (e.g., "offset ᵃ Field" where "a" bridges two baselines).
  let anchorY = chars[0]._perpDist ?? chars[0].y;
  let anchorFontSize = chars[0].fontSize;

  for (let i = 1; i < chars.length; i++) {
    const ch = chars[i];

    // Space characters don't drive line breaks — add to current line.
    if (ch.text === ' ') {
      currentLine.push(ch);
      continue;
    }

    // For comparison, use the last non-space char (spaces have unreliable font metrics).
    let compPrev = chars[i - 1];
    if (compPrev.text === ' ') {
      for (let j = currentLine.length - 1; j >= 0; j--) {
        if (currentLine[j].text !== ' ') {
          compPrev = currentLine[j];
          break;
        }
      }
    }

    const chY = ch._perpDist ?? ch.y;
    const prevY = compPrev._perpDist ?? compPrev.y;
    const yGap = Math.abs(chY - prevY);
    const xGap = ch.x - (compPrev.x + compPrev.width);
    // Type3 fonts with non-standard FontMatrix (e.g. identity) can produce a
    // Tf-derived fontSize that's much smaller than the actual glyph advance —
    // the Tf value reflects text-space size, not the device-space em-height.
    // For gap thresholds we need a size reference proportional to visible
    // characters: a char's glyph advance is a safe floor, since fontSize
    // cannot be smaller than a single char's width in any real font.
    const chSize = Math.max(ch.fontSize, ch.width);
    const prevSize = Math.max(compPrev.fontSize, compPrev.width);
    const maxFont = Math.max(chSize, prevSize);
    const minFont = Math.min(chSize, prevSize);
    // Ratio checks compare Tf directly so that a same-font page (even one with
    // collapsed fontSize) still has fontRatio ≈ 1 and doesn't trigger false
    // size-change cuts from natural advance variation (e.g. "i" vs "M").
    const fontRatio = ch.fontSize / compPrev.fontSize;
    // Inline symbol glyphs (e.g., Webdings arrows between regular words) can carry
    // a different orientation/font size while still belonging to the same visual line.
    // Treat close symbol/text boundaries as inline to avoid fragmenting one sentence.
    const symbolBoundary = isSymbolFontFamily(ch.fontInfo.familyName)
      || isSymbolFontFamily(compPrev.fontInfo.familyName);
    const inlineSymbolBoundary = symbolBoundary
      && yGap < maxFont * 0.5
      && xGap > -maxFont * 0.2
      && xGap < maxFont;

    let isCut = false;

    // Orientation change.
    if (ch.orientation !== compPrev.orientation && !inlineSymbolBoundary) isCut = true;

    // Large y-jump: always a line break (too big for any superscript).
    else if (yGap > maxFont * 0.7 || yGap > minFont * 1.5) isCut = true;

    // Large backward x-jump: moving to start of a new line.
    else if (xGap < -maxFont * 2) isCut = true;

    // Large forward x-jump: column break or distant text region.
    else if (xGap > maxFont * 4) isCut = true;

    // Moderate y-jump with similar font size: line break, not a superscript.
    // Only applies when chars aren't horizontally adjacent — a new line never
    // starts flush against the previous character with no gap.
    else if (yGap > minFont * 0.3 && fontRatio > 0.8 && fontRatio < 1.25
      && (xGap < -maxFont * 0.1 || xGap > maxFont * 0.5)) isCut = true;

    // Large font size change with any y-gap: different text region
    // (e.g., 40pt heading adjacent to 7pt body text).
    // Same x-proximity guard: horizontally adjacent chars stay on the same line.
    else if (!inlineSymbolBoundary
      && yGap > minFont * 0.1 && (fontRatio > 1.75 || fontRatio < 1 / 1.75)
      && (xGap < -maxFont * 0.1 || xGap > maxFont * 0.5)) isCut = true;

    // Persistent font size change: when the font size changes significantly and
    // the new size persists for multiple subsequent characters, this is a line
    // transition (e.g., heading → sub-heading), not a superscript. Look ahead to
    // distinguish from a transient superscript marker that immediately reverts.
    else if (!inlineSymbolBoundary && yGap > minFont * 0.1 && (fontRatio < 0.8 || fontRatio > 1.25)) {
      let persistCount = 0;
      const targetSize = Math.min(ch.fontSize, compPrev.fontSize);
      for (let j = i + 1; j < chars.length && persistCount < 3; j++) {
        if (chars[j].text === ' ') continue;
        if (Math.abs(chars[j].fontSize - targetSize) < targetSize * 0.15) persistCount++;
        else break;
      }
      if (persistCount >= 3) isCut = true;
    }

    // Baseline drift: same-size char whose baseline shifted from the anchor,
    // bridged by an intervening superscript (e.g. "offset ᵃ Field", or a
    // footnote marker between a table row and a wrapped cell's first line).
    // Independent of the chain above so the persistent-fs-change branch can't
    // swallow it. Size match is bidirectional — a line starting with a leading
    // superscript followed by full-size text is promoting the anchor, not
    // drifting from it.
    if (!isCut
      && ch.fontSize >= anchorFontSize * 0.8 && ch.fontSize <= anchorFontSize * 1.25
      && Math.abs(chY - anchorY) > anchorFontSize * 0.3
      && xGap > maxFont * 0.5) isCut = true;

    if (isCut) {
      lines.push(currentLine);
      currentLine = [ch];
      anchorY = chY;
      anchorFontSize = ch.fontSize;
    } else {
      currentLine.push(ch);
      // Update anchor if this is a full-size char (not a superscript/subscript)
      if (ch.fontSize >= anchorFontSize * 0.8) {
        anchorY = chY;
      }
    }
  }
  if (currentLine.length > 0) lines.push(currentLine);

  // Merge orphan single-char lines into adjacent lines. PDF generators sometimes
  // emit characters far from their neighbors in stream order, creating spurious
  // single-char lines. Two cases are handled:
  //  (a) Same-size punctuation (e.g., curly quotes): same font, same size, baseline-adjacent.
  //  (b) Drop caps (e.g., large "T" before "he"): same font, orphan >2x larger, top-aligned,
  //      x-adjacent, single uppercase letter.
  // The orphan is inserted at the correct x-position so word splitting groups it
  // with its spatial neighbor.
  for (let li = lines.length - 1; li >= 0; li--) {
    if (lines[li].length !== 1) continue;
    const orphan = lines[li][0];
    const orphanRight = orphan.x + orphan.width;
    const orphanTop = orphan.y - (orphan.fontInfo.ascent / 1000) * orphan.fontSize;
    let merged = false;
    for (let lj = 0; lj < lines.length && !merged; lj++) {
      if (lj === li) continue;
      const target = lines[lj];
      for (const ch of target) {
        if (orphan.fontInfo.familyName !== ch.fontInfo.familyName) continue;
        const chRight = ch.x + ch.width;
        const maxFont = Math.max(orphan.fontSize, ch.fontSize);
        const minFont = Math.min(orphan.fontSize, ch.fontSize);

        const sameSize = Math.abs(orphan.fontSize - ch.fontSize) < maxFont * 0.1;
        const xAdj = (orphanRight >= ch.x - maxFont * 0.1 && orphan.x <= chRight + maxFont * 0.1);

        if (sameSize && xAdj && Math.abs(orphan.y - ch.y) < maxFont * 0.5) {
          // Case (a): same-size punctuation.
          let insertIdx = target.length;
          for (let k = 0; k < target.length; k++) {
            if (target[k].x > orphan.x) { insertIdx = k; break; }
          }
          target.splice(insertIdx, 0, orphan);
          lines.splice(li, 1);
          merged = true;
          break;
        }

        if (!sameSize && orphan.fontSize > ch.fontSize * 2
            && /[A-Z]/.test(orphan.text) && xAdj) {
          // Case (b): drop cap — check top alignment.
          const chTop = ch.y - (ch.fontInfo.ascent / 1000) * ch.fontSize;
          if (Math.abs(orphanTop - chTop) < minFont * 0.25) {
            let insertIdx = target.length;
            for (let k = 0; k < target.length; k++) {
              if (target[k].x > orphan.x) { insertIdx = k; break; }
            }
            target.splice(insertIdx, 0, orphan);
            lines.splice(li, 1);
            merged = true;
            break;
          }
        }
      }
    }
  }

  // Merge line fragments split by an inline superscript's y-shift.
  // The superscript-size check is the gating signal — same baseline + small gap
  // alone would also merge unrelated column-aligned lines.
  const lineAnchorOf = (lineChars) => {
    let maxSize = 0;
    for (const ch of lineChars) {
      if (ch.text !== ' ' && ch.fontSize > maxSize) maxSize = ch.fontSize;
    }
    if (maxSize === 0) return null;
    const ys = [];
    let leftX = Infinity;
    let rightX = -Infinity;
    for (const ch of lineChars) {
      if (ch.text === ' ') continue;
      if (ch.fontSize >= maxSize * 0.8) ys.push(ch._perpDist ?? ch.y);
      if (ch.x < leftX) leftX = ch.x;
      const r = ch.x + ch.width;
      if (r > rightX) rightX = r;
    }
    if (ys.length === 0) return null;
    ys.sort((a, b) => a - b);
    return {
      anchorFontSize: maxSize,
      baselineY: ys[Math.floor(ys.length / 2)],
      leftX,
      rightX,
    };
  };
  const lastNonSpace = (lineChars) => {
    for (let k = lineChars.length - 1; k >= 0; k--) {
      if (lineChars[k].text !== ' ') return lineChars[k];
    }
    return null;
  };
  const firstNonSpace = (lineChars) => {
    for (let k = 0; k < lineChars.length; k++) {
      if (lineChars[k].text !== ' ') return lineChars[k];
    }
    return null;
  };
  for (let li = lines.length - 2; li >= 0; li--) {
    const a = lineAnchorOf(lines[li]);
    const b = lineAnchorOf(lines[li + 1]);
    if (!a || !b) continue;
    const anchorSize = Math.max(a.anchorFontSize, b.anchorFontSize);
    if (Math.abs(a.baselineY - b.baselineY) > anchorSize * 0.25) continue;
    const gap = b.leftX - a.rightX;
    if (gap < -anchorSize * 0.1 || gap > anchorSize) continue;
    const lastA = lastNonSpace(lines[li]);
    const firstB = firstNonSpace(lines[li + 1]);
    const supBoundary = (lastA && lastA.fontSize < anchorSize * 0.85)
      || (firstB && firstB.fontSize < anchorSize * 0.85);
    if (!supBoundary) continue;
    lines[li] = [...lines[li], ...lines[li + 1]];
    lines.splice(li + 1, 1);
  }

  // Process each line (chars are already in stream order)
  for (const lineChars of lines) {
    // Split into words at space characters or large gaps (measured in stream order).
    const wordsInitial = [];
    let currentWord = [];
    for (let i = 0; i < lineChars.length; i++) {
      const ch = lineChars[i];
      if (ch.text === ' ') {
        // Check if this space is a real word break or a TJ kerning artifact.
        // If the next non-space char is visually close to where the space sits,
        // the space was inserted by TJ kerning but doesn't represent a word gap.
        if (currentWord.length > 0) {
          let nextNonSpace = null;
          for (let j = i + 1; j < lineChars.length; j++) {
            if (lineChars[j].text !== ' ') {
              nextNonSpace = lineChars[j];
              break;
            }
          }
          if (nextNonSpace) {
            const prevCh = currentWord[currentWord.length - 1];
            const visualGap = nextNonSpace.x - (prevCh.x + prevCh.width);
            // A space after a comma is always a word break — commas
            // are list/sentence delimiters and the space is real even when
            // negative Tc compresses it below the normal gap threshold.
            // Drop the space only when the kerning around it cancelled the
            // glyph advance (visualGap ≈ 0) or the prev glyph's bbox overlaps
            // the next char by less than the word-split tolerance. Justified
            // text often shrinks real inter-word gaps to a fraction of the
            // space-glyph advance; keep those as word breaks.
            const adjacencyTol = prevCh.fontSize * 0.15;
            const positiveTol = Math.max(prevCh.fontSize * 0.05, ch.width * 0.3);
            const isKerningArtifact = visualGap >= -adjacencyTol && visualGap < positiveTol;
            if (isKerningArtifact && prevCh.text !== ',') {
              continue;
            }
          }
          wordsInitial.push(currentWord);
          currentWord = [];
        }
        continue;
      }
      // Check for word boundaries between consecutive chars in stream order.
      if (currentWord.length > 0) {
        const prevCh = currentWord[currentWord.length - 1];
        const gap = ch.x - (prevCh.x + prevCh.width);
        const fontSizeMin = Math.min(ch.fontSize, prevCh.fontSize);
        // Sentence-terminal + em-dash is a definitional break ("COMMITTEES.—The…"),
        // not a closed compound ("respond—this"). Split the em-dash off as its own word.
        if (ch.text === '—' && /[.!?]/.test(prevCh.text)) {
          wordsInitial.push(currentWord);
          wordsInitial.push([ch]);
          currentWord = [];
          continue;
        }
        // Split at bold/italic style change.
        if (ch.fontInfo.bold !== prevCh.fontInfo.bold
          || ch.fontInfo.italic !== prevCh.fontInfo.italic) {
          wordsInitial.push(currentWord);
          currentWord = [];
        // Split at font family change (e.g., Dingbats checkbox → Times text).
        // Skip when chars are visually adjacent (gap near zero), since typeset documents
        // often use a different font for punctuation (e.g., MinionPro comma between MyriadPro digits).
        // Always split at symbol font boundaries (Webdings, Wingdings, Dingbats, Symbol)
        // regardless of gap — these contain icons/symbols, not text characters.
        } else if (ch.fontInfo.familyName !== prevCh.fontInfo.familyName
          && (gap > fontSizeMin * 0.15
            || isSymbolFontFamily(ch.fontInfo.familyName)
            || isSymbolFontFamily(prevCh.fontInfo.familyName))) {
          wordsInitial.push(currentWord);
          currentWord = [];
        // Split after right double quote followed by a letter.
        } else if (prevCh.text === '\u201D' && /[A-Za-z]/.test(ch.text)) {
          wordsInitial.push(currentWord);
          currentWord = [];
        // Split at forward x-gap (word spacing).
        } else if (gap > ch.fontSize * 0.15) {
          wordsInitial.push(currentWord);
          currentWord = [];
        // Split at baseline (y-position) change — separates superscripts from adjacent text.
        } else if (fontSizeMin > 0 && Math.abs(ch.y - prevCh.y) > fontSizeMin * 0.25) {
          wordsInitial.push(currentWord);
          currentWord = [];
        // Split at large backward x-jump — chars are at a different visual position
        // (e.g., sidebar text followed by body text in stream order).
        // Require ch.x < prevCh.x so we only split when the next char genuinely starts
        // before the previous char, not when it falls within an oversized glyph bbox
        // (e.g., curly apostrophe U+2019 with wide advance width in "Cruz's").
        } else if (gap < -ch.fontSize * 0.5 && ch.x < prevCh.x) {
          wordsInitial.push(currentWord);
          currentWord = [];
        // Split where x goes backward and font size increases — new small caps title-case word.
        } else if (gap < -fontSizeMin * 0.1 && fontSizeMin > 0 && ch.fontSize > prevCh.fontSize * 1.1) {
          wordsInitial.push(currentWord);
          currentWord = [];
        // Split before dot leaders: a non-period char followed by a run of 5+ periods.
        } else if (ch.text === '.' && prevCh.text !== '.') {
          let dotCount = 0;
          for (let j = i; j < lineChars.length && lineChars[j].text === '.'; j++) dotCount++;
          if (dotCount >= 5) {
            wordsInitial.push(currentWord);
            currentWord = [];
          }
        }
      }
      currentWord.push(ch);
    }
    if (currentWord.length > 0) wordsInitial.push(currentWord);

    // Sort words by x-position of their first character so line reads left-to-right.
    wordsInitial.sort((a, b) => a[0].x - b[0].x);

    // Merge adjacent words that were split at a small caps boundary.
    // A single uppercase char followed by an all-uppercase word at smaller font size,
    // with the same font family and no baseline shift, is likely a single small-caps word.
    const wordsMerged = [];
    for (let wi = 0; wi < wordsInitial.length; wi++) {
      const curr = wordsInitial[wi];
      const next = wordsInitial[wi + 1];
      if (curr.length === 1 && /[A-Z]/.test(curr[0].text) && next && next.length > 0
        && /[A-Z]/.test(next[0].text)
        && curr[0].fontInfo.familyName === next[0].fontInfo.familyName
        && next[0].fontSize < curr[0].fontSize * 0.95
        && Math.abs(next[0].y - curr[0].y) / Math.min(next[0].fontSize, curr[0].fontSize) < 0.15) {
        // Only merge if the gap between the letter and the next word is small enough
        // to be a small caps word (not a separate label like "A Reach," or "B Fork").
        // Real small caps have the letter visually adjacent to the rest of the word.
        const lastChar = curr[curr.length - 1];
        const nextChar = next[0];
        const gap = nextChar.x - (lastChar.x + lastChar.width);
        if (gap <= nextChar.fontSize * 0.3) {
          wordsMerged.push([...curr, ...next]);
          wi++; // skip next
        } else {
          wordsMerged.push(curr);
        }
      } else {
        wordsMerged.push(curr);
      }
    }

    // CJK word splitting: each CJK character becomes its own word.
    const wordsAfterCJK = [];
    for (const wordChars of wordsMerged) {
      const wordText = wordChars.map((c) => c.text).join('');
      if (calcLang(wordText) === 'chi_sim') {
        for (const ch of wordChars) {
          wordsAfterCJK.push([ch]);
        }
      } else {
        wordsAfterCJK.push(wordChars);
      }
    }

    if (wordsAfterCJK.length === 0) continue;

    // Split words at superscript boundaries (baseline shift + font size change).
    // Each entry in `words` is { chars, sup, smallCapsAlt, smallCapsAltTitleCase, smallCapsLargeFontSize }.
    const words = [];
    /** Baseline Y of the first non-superscript word, for bbox correction. */
    let normalBaselineY = null;
    /** Whether small caps (via font size reduction without baseline shift) is currently active. */
    let smallCapsAltActive = false;

    for (let wi = 0; wi < wordsAfterCJK.length; wi++) {
      const wordChars = wordsAfterCJK[wi];
      // Scan for baseline/size discontinuities within this word to detect superscript transitions.
      const splitPoints = [];
      for (let ci = 1; ci < wordChars.length; ci++) {
        const prev = wordChars[ci - 1];
        const curr = wordChars[ci];
        const fontSizeMin = Math.min(prev.fontSize, curr.fontSize);
        if (fontSizeMin === 0) continue;
        const baselineDelta = (curr.y - prev.y) / fontSizeMin;
        const sizeDelta = (curr.fontSize - prev.fontSize) / fontSizeMin;

        // Superscript start: baseline goes up (positive in page coords means down, but y is inverted),
        // size decreases. Superscript end: baseline goes back down, size increases.
        if (Number.isFinite(baselineDelta) && Number.isFinite(sizeDelta)
          && ((baselineDelta < -0.25 && sizeDelta < -0.05) || (baselineDelta > 0.25 && sizeDelta > 0.05))) {
          splitPoints.push({ index: ci, sizeDelta });
        } else if (ci === 1 && /[A-Z]/.test(prev.text) && curr.fontSize < prev.fontSize
          && prev.fontSize > 0 && Math.abs(baselineDelta) < 0.1) {
          // Fake small caps detection: font size decrease after first uppercase letter, no baseline shift.
          // Mark and continue (don't split word).
        }
      }

      // Split multiple footnote refs.  E.g. "(1)(3)".
      if (splitPoints.length === 0 && wordChars.length > 4) {
        const wText = wordChars.map((/** @type {any} */ c) => c.text).join('');
        if (/^(\(\d+\))+$/.test(wText)) {
          for (let ci = 1; ci < wordChars.length; ci++) {
            if (wordChars[ci - 1].text === ')' && wordChars[ci].text === '(') {
              splitPoints.push({ index: ci, sizeDelta: 0 });
            }
          }
        }
      }

      if (splitPoints.length === 0) {
        // No superscript boundary — push as a single word.
        words.push({
          chars: wordChars, sup: false, dropcap: false, smallCapsAlt: smallCapsAltActive, smallCapsAltTitleCase: false, smallCapsLargeFontSize: 0,
        });
      } else {
        // Split at each superscript boundary.
        let start = 0;
        let prevWasSup = false;
        for (const sp of splitPoints) {
          if (sp.index > start) {
            const supForSegment = sp.sizeDelta > 0 ? prevWasSup : (sp.sizeDelta < 0);
            words.push({
              chars: wordChars.slice(start, sp.index), sup: supForSegment, dropcap: false, smallCapsAlt: false, smallCapsAltTitleCase: false, smallCapsLargeFontSize: 0,
            });
            if (!supForSegment && normalBaselineY === null) {
              normalBaselineY = wordChars[start].y;
            }
            prevWasSup = supForSegment;
          }
          start = sp.index;
          // After splitting, the next segment's sup status is determined by the direction of the transition.
          prevWasSup = sp.sizeDelta < 0;
        }
        // Remaining chars after last split point.
        if (start < wordChars.length) {
          words.push({
            chars: wordChars.slice(start), sup: prevWasSup, dropcap: false, smallCapsAlt: false, smallCapsAltTitleCase: false, smallCapsLargeFontSize: 0,
          });
          if (!prevWasSup && normalBaselineY === null) {
            normalBaselineY = wordChars[start].y;
          }
        }
      }

      // Track baseline of non-superscript words.
      if (normalBaselineY === null && words.length > 0 && !words[words.length - 1].sup) {
        normalBaselineY = words[words.length - 1].chars[0].y;
      }
    }

    // Drop cap detection: a single-char word whose font size is >2x the next word's font size
    // and whose baseline is lower (the letter extends downward spanning multiple lines).
    for (let i = 0; i < words.length; i++) {
      if (words[i].sup || words[i].chars.length !== 1) continue;
      const nextIdx = i + 1;
      if (nextIdx >= words.length || words[nextIdx].chars.length === 0) continue;
      const dcFontSize = words[i].chars[0].fontSize;
      const nextFontSize = words[nextIdx].chars[0].fontSize;
      if (dcFontSize > nextFontSize * 2 && words[i].chars[0].y > words[nextIdx].chars[0].y) {
        words[i].dropcap = true;
      }
    }

    // Word-level superscript detection: compare consecutive words for font size + baseline differences.
    // This catches superscripts that are already separate words after line merging and word splitting.
    // Only consider short words (<=4 chars) as superscript candidates to avoid false positives from garbled lines.
    // Skip drop cap words when searching for comparison neighbors.
    // Guard: if the word immediately following the candidate has a similar font size (within 10%),
    // this is a persistent size transition (e.g., heading → sub-heading), not a superscript.
    let supChanged = true;
    while (supChanged) {
      supChanged = false;
      for (let i = 0; i < words.length; i++) {
        if (words[i].sup || words[i].dropcap || words[i].chars.length === 0 || words[i].chars.length > 4) continue;
        const wChars = words[i].chars;
        const wFontSize = wChars.reduce((sum, c) => sum + c.fontSize, 0) / wChars.length;
        const wBaseline = wChars.reduce((sum, c) => sum + c.y, 0) / wChars.length;

        // Check if the next word continues at the same small size (size transition, not superscript).
        let followIdx = i + 1;
        while (followIdx < words.length && (words[followIdx].sup || words[followIdx].dropcap)) followIdx++;
        let sizeTransition = false;
        if (followIdx < words.length && words[followIdx].chars.length > 0) {
          const followFontSize = words[followIdx].chars.reduce((sum, c) => sum + c.fontSize, 0) / words[followIdx].chars.length;
          sizeTransition = Math.abs(wFontSize - followFontSize) < Math.max(wFontSize, followFontSize) * 0.1;
        }

        // Compare with the previous non-sup, non-dropcap word.
        // Skip when the next word continues at the same small size (size transition, not superscript).
        let prevIdx = i - 1;
        while (prevIdx >= 0 && (words[prevIdx].sup || words[prevIdx].dropcap)) prevIdx--;
        if (!sizeTransition && prevIdx >= 0 && words[prevIdx].chars.length > 0) {
          const prevChars = words[prevIdx].chars;
          const prevFontSize = prevChars.reduce((sum, c) => sum + c.fontSize, 0) / prevChars.length;
          const prevBaseline = prevChars.reduce((sum, c) => sum + c.y, 0) / prevChars.length;
          const fontSizeMin = Math.min(wFontSize, prevFontSize);
          if (fontSizeMin > 0) {
            const sizeDelta = (wFontSize - prevFontSize) / fontSizeMin;
            const baselineDelta = (wBaseline - prevBaseline) / fontSizeMin;
            if (sizeDelta < -0.05 && baselineDelta < -0.25) {
              words[i].sup = true;
              supChanged = true;
              if (normalBaselineY === null) normalBaselineY = prevBaseline;
              continue;
            }
            if (sizeDelta < -0.3) {
              words[i].sup = true;
              supChanged = true;
              if (normalBaselineY === null) normalBaselineY = prevBaseline;
              continue;
            }
          }
        }

        // Compare with the next non-sup, non-dropcap word.
        let nextNonSupIdx = i + 1;
        while (nextNonSupIdx < words.length && (words[nextNonSupIdx].sup || words[nextNonSupIdx].dropcap)) nextNonSupIdx++;
        if (nextNonSupIdx < words.length && words[nextNonSupIdx].chars.length > 0) {
          const nextChars = words[nextNonSupIdx].chars;
          const nextFontSize = nextChars.reduce((sum, c) => sum + c.fontSize, 0) / nextChars.length;
          const nextBaseline = nextChars.reduce((sum, c) => sum + c.y, 0) / nextChars.length;
          const fontSizeMin = Math.min(wFontSize, nextFontSize);
          if (fontSizeMin > 0) {
            const sizeDelta = (wFontSize - nextFontSize) / fontSizeMin;
            const baselineDelta = (wBaseline - nextBaseline) / fontSizeMin;
            if (sizeDelta < -0.05 && baselineDelta < -0.25) {
              words[i].sup = true;
              supChanged = true;
              if (normalBaselineY === null) normalBaselineY = nextBaseline;
              continue;
            }
            if (sizeDelta < -0.3) {
              words[i].sup = true;
              supChanged = true;
              if (normalBaselineY === null) normalBaselineY = nextBaseline;
              continue;
            }
          }
        }
      }
    }

    // Recalculate normalBaselineY after word-level superscript detection, which may have
    // reclassified words that were initially non-sup (e.g., footnote marker "1" that is first
    // detected as superscript only by comparing with the next word "Cruz").
    // Skip drop cap words — their baseline extends below the visual line.
    normalBaselineY = null;
    for (const w of words) {
      if (!w.sup && !w.dropcap && w.chars.length > 0) {
        normalBaselineY = w.chars[0].y;
        break;
      }
    }

    // Detect fake small caps across word boundaries.
    // Look for words with mixed font sizes where all alpha chars are uppercase.
    // Chars at the smaller font size are "fake small caps" of their lowercase equivalents.
    let smallCapsBaseFontSize = 0;
    for (let i = 0; i < words.length; i++) {
      if (words[i].sup) continue;
      const wc = words[i].chars;
      if (wc.length < 2) continue;
      let maxFontSize = 0;
      let minFontSize = Infinity;
      for (const c of wc) {
        if (c.fontSize > maxFontSize) maxFontSize = c.fontSize;
        if (c.fontSize < minFontSize) minFontSize = c.fontSize;
      }
      const hasMixedSizes = maxFontSize > 0 && minFontSize < maxFontSize * 0.95;
      if (hasMixedSizes) {
        const allText = wc.map((c) => c.text).join('');
        if (!/[a-z]/.test(allText) && /[A-Z]/.test(allText)) {
          const largeChar = wc.find((c) => c.fontSize >= maxFontSize * 0.95);
          const smallChar = wc.find((c) => c.fontSize <= minFontSize * 1.05);
          const baselineDelta = largeChar && smallChar ? Math.abs(smallChar.y - largeChar.y) / minFontSize : 0;
          if (baselineDelta < 0.15) {
            words[i].smallCapsAlt = true;
            words[i].smallCapsLargeFontSize = maxFontSize;
            const firstAlpha = wc.find((c) => /[A-Z]/.test(c.text));
            if (firstAlpha && firstAlpha.fontSize >= maxFontSize * 0.95) {
              words[i].smallCapsAltTitleCase = true;
            }
            smallCapsAltActive = true;
            smallCapsBaseFontSize = maxFontSize;
          }
        }
      } else if (smallCapsAltActive) {
        const firstCharFontSize = wc[0].fontSize;
        const secondCharFontSize = wc[1].fontSize;
        const fontSizeMin = Math.min(firstCharFontSize, secondCharFontSize);
        const sizeDelta = fontSizeMin > 0 ? (secondCharFontSize - firstCharFontSize) / fontSizeMin : 0;
        if (Number.isFinite(sizeDelta) && sizeDelta > 0.05) {
          smallCapsAltActive = false;
        } else {
          words[i].smallCapsAlt = true;
          words[i].smallCapsLargeFontSize = smallCapsBaseFontSize;
        }
      }
    }

    // Compute line bbox from all non-superscript chars (or all chars if none are non-sup)
    const allLineChars = words.flatMap((w) => w.chars);
    const nonSupChars = allLineChars.filter((_, idx) => {
      let charCount = 0;
      for (const w of words) {
        charCount += w.chars.length;
        if (idx < charCount) return !w.sup;
      }
      return true;
    });
    const bboxChars = nonSupChars.length > 0 ? nonSupChars : allLineChars;

    const lineLeft = bboxChars.reduce((m, c) => Math.min(m, Math.round(c.x)), Infinity);
    const lineRight = bboxChars.reduce((m, c) => Math.max(m, Math.round(c.x + c.width)), -Infinity);
    const lineTop = bboxChars.reduce((m, c) => Math.min(m, Math.round(c.y - (c.fontInfo.ascent / 1000) * c.fontSize)), Infinity);
    const lineBottom = bboxChars.reduce((m, c) => Math.max(m, Math.round(c.y - (c.fontInfo.descent / 1000) * c.fontSize)), -Infinity);

    // Baseline: use the first non-superscript word's baseline, or fall back to first char.
    const baselineY = normalBaselineY ?? allLineChars[0].y;
    const baselineOffset = Math.round(baselineY - lineBottom);
    const ascHeight = (nonSupChars.length > 0 ? nonSupChars[0] : allLineChars[0]).fontSize * 0.6;

    // Compute baseline slope from the text direction vector (more robust than char position delta).
    // This matches mupdf stext which uses the dir attribute: slope = dir[1] for orientation 0.
    let baselineSlope = 0;
    const lineOrientation = allLineChars[0].orientation;
    let sumDirX = 0;
    let sumDirY = 0;
    for (const ch of bboxChars) {
      sumDirX += ch.dirX;
      sumDirY += ch.dirY;
    }
    const lineDirMag = Math.hypot(sumDirX, sumDirY);
    if (lineDirMag > 0) {
      const ndx = sumDirX / lineDirMag;
      const ndy = sumDirY / lineDirMag;
      if (lineOrientation === 1) {
        baselineSlope = round6(-ndx);
      } else if (lineOrientation === 2) {
        baselineSlope = round6(-ndy);
      } else if (lineOrientation === 3) {
        baselineSlope = round6(ndx);
      } else if (Math.abs(ndx) > 0.01) {
        // Orientation 0: slope = ndy (equivalent to mupdf dir[1] for unit direction vector).
        // For small angles, ndy ≈ sin(θ) ≈ tan(θ), matching the asin() conversion to degrees.
        baselineSlope = round6(ndy);
      }
    }

    const lineBbox = {
      left: lineLeft, top: lineTop, right: lineRight, bottom: lineBottom,
    };
    const lineObj = new ocr.OcrLine(pageObj, lineBbox, [baselineSlope, baselineOffset], ascHeight, null);

    // Set orientation from the line's characters (all chars in a line have the same orientation
    // due to the grouping constraint, so use the first char's orientation).
    lineObj.orientation = lineOrientation;

    // Build words
    for (let wi = 0; wi < words.length; wi++) {
      const wordChars = words[wi].chars;
      const isSup = words[wi].sup;
      const wordText = wordChars.map((c) => c.text).join('');
      if (wordText.trim() === '') continue;

      const wordLang = calcLang(wordText);
      langSet.add(wordLang);

      // Compute word bbox
      const wordLeft = Math.round(wordChars[0].x);
      const wordRight = Math.round(wordChars[wordChars.length - 1].x + wordChars[wordChars.length - 1].width);
      const wordTop = wordChars.reduce((m, c) => Math.min(m, Math.round(c.y - (c.fontInfo.ascent / 1000) * c.fontSize)), Infinity);
      const wordBottom = wordChars.reduce((m, c) => Math.max(m, Math.round(c.y - (c.fontInfo.descent / 1000) * c.fontSize)), -Infinity);

      const wordBbox = {
        left: wordLeft, top: wordTop, right: wordRight, bottom: wordBottom,
      };

      const wordID = `word_${n + 1}_${pageObj.lines.length + 1}_${wi + 1}`;
      const wordObj = new ocr.OcrWord(lineObj, wordID, wordText, wordBbox);
      wordObj.conf = 100;
      wordObj.visualCoords = false;
      wordObj.lang = wordLang;

      // Style from first alphanumeric character (matching mupdf behavior for leading punctuation)
      const firstAlphaNum = wordChars.find((c) => /[A-Za-z\d]/.test(c.text)) || wordChars[0];
      wordObj.style.font = firstAlphaNum.fontInfo.familyName;
      wordObj.style.bold = firstAlphaNum.fontInfo.bold;
      wordObj.style.italic = firstAlphaNum.fontInfo.italic;

      if (firstAlphaNum.textColor) {
        const rgb = colorToRgb(firstAlphaNum.textColor);
        if (rgb) wordObj.style.color = rgbToHex(rgb);
      }
      if (firstAlphaNum.invisible) {
        wordObj.style.opacity = 0;
      } else if (typeof firstAlphaNum.alpha === 'number') {
        wordObj.style.opacity = firstAlphaNum.alpha;
      }

      // For superscript and drop cap words, use the raw font size.
      // round3 collapses ~1e-16 drift from the (300/72) scale-factor multiplication chain;
      // layout uses char-level fontSize unchanged, only the user/test-facing style.size is rounded.
      if (isSup) {
        wordObj.style.size = round3(wordChars[0].fontSize);
        wordObj.style.sup = true;
      } else if (words[wi].dropcap) {
        wordObj.style.size = round3(wordChars[0].fontSize);
        wordObj.style.dropcap = true;
      } else {
        wordObj.style.size = round3(firstAlphaNum.fontSize);
      }

      // Small caps detection
      if (firstAlphaNum.fontInfo.smallCaps) {
        // Method A: Font name indicates small caps.
        wordObj.style.smallCaps = true;
      } else if (words[wi].smallCapsAlt) {
        // Method B: Fake small caps (font size decrease, no baseline shift, all uppercase).
        if (!/[a-z]/.test(wordObj.text) && /[A-Z].?[A-Z]/.test(wordObj.text)) {
          wordObj.style.smallCaps = true;
          if (words[wi].smallCapsLargeFontSize > 0) {
            wordObj.style.size = round3(words[wi].smallCapsLargeFontSize);
          }
        }
      }

      // Underline detection: check if a thin horizontal rectangle overlaps this word,
      // is positioned just below the baseline, and matches the text color.
      if (underlineRects.length > 0) {
        const baselineYWord = wordChars[0].y;
        const charColor = wordChars[0].textColor;
        // Reject rects that extend significantly past the line's text on either
        // side — those are table-row dividers / section rules that happen to
        // pass under this word, not text underlines. Tolerance scales with font
        // size to allow stroke caps and trailing-space overshoot on real underlines.
        const ruleOverhangLimit = wordChars[0].fontSize * 0.5;
        for (const rect of underlineRects) {
          if (rect.right > wordLeft && rect.left < wordRight
            && rect.y >= baselineYWord - wordChars[0].fontSize * 0.1
            && rect.y <= baselineYWord + wordChars[0].fontSize * 0.25
            && rect.left >= lineLeft - ruleOverhangLimit
            && rect.right <= lineRight + ruleOverhangLimit) {
            // Color match: the line color must match the text fill color.
            // Different colors indicate a decorative rule, not a text underline.
            // Normalize across color spaces — the same black may be stored as
            // DeviceGray [g] for the text and DeviceRGB [0,0,0] for the path.
            if (rect.color && charColor) {
              const rectRgb = colorToRgb(rect.color);
              const charRgb = colorToRgb(charColor);
              const bothDark = rectRgb && charRgb
                && rectRgb.every((v) => v < 0.3) && charRgb.every((v) => v < 0.3);
              if (rectRgb && charRgb && !bothDark
                && rectRgb.some((v, ci) => Math.abs(v - charRgb[ci]) > 0.1)) {
                continue;
              }
            }
            wordObj.style.underline = true;
            break;
          }
        }
      }

      fontSet.add(cleanFamilyName(wordObj.style.font));

      // Create char objects
      wordObj.chars = wordChars.map((c) => {
        let charTop = Math.round(c.y - (c.fontInfo.ascent / 1000) * c.fontSize);
        let charBottom = Math.round(c.y - (c.fontInfo.descent / 1000) * c.fontSize);
        // Adjust superscript char bbox.
        if (isSup && normalBaselineY !== null) {
          const supBaselineOffset = c.y - normalBaselineY;
          charTop -= Math.round(supBaselineOffset);
          charBottom -= Math.round(supBaselineOffset);
        }
        return new ocr.OcrChar(c.text, {
          left: Math.round(c.x), top: charTop, right: Math.round(c.x + c.width), bottom: charBottom,
        });
      });

      // Apply small caps lowercase restoration.
      if (wordObj.style.smallCaps && words[wi].smallCapsAlt) {
        const lgFont = words[wi].smallCapsLargeFontSize;
        const wc = words[wi].chars;
        if (lgFont > 0) {
          for (let ci = 0; ci < wordObj.chars.length; ci++) {
            if (wc[ci].fontSize < lgFont * 0.95) {
              wordObj.chars[ci].text = wordObj.chars[ci].text.toLowerCase();
            }
          }
        } else if (words[wi].smallCapsAltTitleCase) {
          wordObj.chars.slice(1).forEach((x) => { x.text = x.text.toLowerCase(); });
        } else {
          wordObj.chars.forEach((x) => { x.text = x.text.toLowerCase(); });
        }
        wordObj.text = wordObj.chars.map((x) => x.text).join('');
      }

      // Stylistic ligatures are font-rendering decoration; downstream code
      // (search, OCR diff, paragraph text) expects the component letters.
      wordObj.text = ocr.replaceLigatures(wordObj.text);

      lineObj.words.push(wordObj);
    }

    if (lineObj.words.length === 0) continue;

    ocr.updateLineBbox(lineObj);
    pageObj.lines.push(lineObj);
  }

  // Compute page angle from line baseline slopes (median of middle 50%).
  // Only use orientation-0 lines; rotated text should not affect the page angle.
  const angleRisePage = pageObj.lines
    .filter((l) => l.orientation === 0)
    .map((l) => l.baseline[0])
    .filter((s) => Math.abs(s) < 0.3);
  const angleRiseMedian = mean50(angleRisePage) || 0;
  pageObj.angle = Math.asin(angleRiseMedian) * (180 / Math.PI);

  // Detect tables from text structure and vector paths, and convert to LayoutDataTable format.
  const detectedTables = detectTableRegions(pageObj, paths, scale, visualHeightPts, boxOriginX, boxOriginY);
  const dataTablePage = new LayoutDataTablePage(n);
  for (const dt of detectedTables) {
    const dataTable = new LayoutDataTable(dataTablePage);
    // Build column bboxes from colSeparators, spanning the full table height.
    const separators = [dt.bbox.left, ...dt.colSeparators, dt.bbox.right];
    for (let i = 0; i < separators.length - 1; i++) {
      const colBbox = {
        left: separators[i], top: dt.bbox.top, right: separators[i + 1], bottom: dt.bbox.bottom,
      };
      dataTable.boxes.push(new LayoutDataColumn(colBbox, dataTable));
    }
    dataTable.detectionMethod = dt.detectionMethod || 'text';
    dataTable.title = dt.title || null;
    dataTablePage.tables.push(dataTable);
  }

  if (pageObj.lines.length > 0) {
    assignParagraphs(pageObj, pageObj.angle);
  }

  return {
    pageObj, langSet, fontSet, dataTablePage,
  };
}
