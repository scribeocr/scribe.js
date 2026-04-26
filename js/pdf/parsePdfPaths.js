import {
  findXrefOffset, parseXref, ObjectCache, bytesToLatin1,
  getPageObjects, getPageContentStream, tokenizeContentStream, findFormXObjects,
} from './parsePdfUtils.js';

/**
 * @typedef {{
 *   type: 'M', x: number, y: number
 * } | {
 *   type: 'L', x: number, y: number
 * } | {
 *   type: 'C', x1: number, y1: number, x2: number, y2: number, x: number, y: number
 * } | {
 *   type: 'Z'
 * }} PathCommand
 */

/**
 * @typedef {{
 *   commands: PathCommand[],
 *   fill: boolean,
 *   stroke: boolean,
 *   evenOdd: boolean,
 *   fillColor: number[],
 *   fillColorSpace: string,
 *   strokeColor: number[],
 *   strokeColorSpace: string,
 *   lineWidth: number,
 *   lineCap: number,
 *   lineJoin: number,
 *   miterLimit: number,
 *   dashArray: number[],
 *   dashPhase: number,
 * }} PaintedPath
 */

/**
 * Extract all painted vector paths from a single page.
 *
 * @param {string} pageObjText – raw text of the Page object
 * @param {ObjectCache} objCache
 * @param {Array} [prefetchedTokens] - Tokens from
 *   `tokenizeContentStream(getPageContentStream(...))`. Pass when the caller
 *   has already tokenized the page content stream to avoid duplicating that
 *   work; omit otherwise.
 * @returns {PaintedPath[]}
 */
export function parsePagePaths(pageObjText, objCache, prefetchedTokens) {
  let tokens = prefetchedTokens;
  if (!tokens) {
    const contentStreamText = getPageContentStream(pageObjText, objCache);
    if (!contentStreamText) return [];
    tokens = tokenizeContentStream(contentStreamText);
  }

  // Inline Form XObject content at Do operator sites so that vector paths
  // inside Form XObjects are extracted with the correct CTM.
  const expanded = inlineFormXObjects(tokens, pageObjText, objCache, new Set());

  return executePathOperators(expanded);
}

/**
 * Resolve Form XObject references in a token stream by inlining their content.
 * Each `Do` operator that references a Form XObject is replaced with
 * `q`, the form's /Matrix as a `cm` operator, the form's content tokens,
 * and `Q`. This allows executePathOperators to process paths inside
 * Form XObjects with the correct CTM.
 *
 * @param {Array} tokens - tokenized content stream
 * @param {string} containerObjText - object text of the container (page or form)
 * @param {ObjectCache} objCache
 * @param {Set<number>} visited - cycle detection
 */
function inlineFormXObjects(tokens, containerObjText, objCache, visited) {
  // Find Form XObjects available in the container's Resources
  const forms = findFormXObjects(containerObjText, objCache);
  if (forms.size === 0) return tokens;

  const result = [];
  const operandStack = [];

  for (const tok of tokens) {
    if (tok.type !== 'operator') {
      operandStack.push(tok);
      result.push(tok);
      continue;
    }

    if (tok.value === 'Do' && operandStack.length >= 1) {
      const name = operandStack[operandStack.length - 1].value;
      const form = forms.get(name);
      if (form && !visited.has(form.objNum)) {
        // Remove the XObject name operand we already pushed
        result.pop();

        visited.add(form.objNum);
        const formObjText = objCache.getObjectText(form.objNum);
        const formBytes = formObjText ? objCache.getStreamBytes(form.objNum) : null;
        if (formObjText && formBytes) {
          const formContentStream = bytesToLatin1(formBytes);
          const matrixMatch = /\/Matrix\s*\[\s*([\d.\-\s]+)\]/.exec(formObjText);
          const formMatrix = matrixMatch
            ? matrixMatch[1].trim().split(/\s+/).map(Number)
            : null;

          const formTokens = tokenizeContentStream(formContentStream);
          // Recurse into nested Form XObjects
          const expanded = inlineFormXObjects(formTokens, formObjText, objCache, visited);

          // Wrap in q/cm/Q to apply the form's Matrix and isolate state
          result.push({ type: 'operator', value: 'q' });
          if (formMatrix) {
            for (const v of formMatrix) result.push({ type: 'number', value: v });
            result.push({ type: 'operator', value: 'cm' });
          }
          for (const t of expanded) result.push(t);
          result.push({ type: 'operator', value: 'Q' });
        }
        operandStack.length = 0;
        continue;
      }
    }

    result.push(tok);
    operandStack.length = 0;
  }

  return result;
}

/**
 * Extract painted vector paths from every page in a PDF.
 *
 * @param {Uint8Array} pdfBytes
 */
export function extractAllPaths(pdfBytes) {
  const xrefOffset = findXrefOffset(pdfBytes);
  const xrefEntries = parseXref(pdfBytes, xrefOffset);
  const objCache = new ObjectCache(pdfBytes, xrefEntries);

  const pages = getPageObjects(objCache);
  const result = [];

  for (const { objText } of pages) {
    result.push(parsePagePaths(objText, objCache));
  }

  return result;
}

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
 * Transform a point through a CTM.
 * @param {number} x
 * @param {number} y
 * @param {number[]} ctm
 */
function transformPoint(x, y, ctm) {
  return {
    x: ctm[0] * x + ctm[2] * y + ctm[4],
    y: ctm[1] * x + ctm[3] * y + ctm[5],
  };
}

/**
 * Approximate uniform scale factor of a CTM (square-root of the determinant).
 * @param {number[]} ctm
 */
function ctmScale(ctm) {
  return Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]));
}

/**
 * Process tokenized content-stream operators and collect painted paths.
 *
 * @param {Array<import('./parsePdfDoc.js').PDFToken>} tokens
 * @returns {PaintedPath[]}
 */
function executePathOperators(tokens) {
  /** @type {PaintedPath[]} */
  const paths = [];

  let ctm = [1, 0, 0, 1, 0, 0];
  let fillColor = [0, 0, 0];
  let fillColorSpace = 'gray';
  let strokeColor = [0, 0, 0];
  let strokeColorSpace = 'gray';
  let lineWidth = 1;
  let lineCap = 0;
  let lineJoin = 0;
  let miterLimit = 10;
  let dashArray = /** @type {number[]} */ ([]);
  let dashPhase = 0;

  const gstateStack = [];

  /** @type {PathCommand[]} */
  let currentPath = [];
  let curX = 0;
  let curY = 0;
  let pathStartX = 0;
  let pathStartY = 0;

  /** @type {Array<any>} */
  const operandStack = [];

  function popNums(n) {
    const start = operandStack.length - n;
    const vals = operandStack.slice(start).map((t) => t.value);
    operandStack.length = 0;
    return vals;
  }

  function emitPath(fill, stroke, evenOdd) {
    if (currentPath.length === 0) return;

    const cmds = /** @type {PathCommand[]} */ ([]);
    for (const cmd of currentPath) {
      switch (cmd.type) {
        case 'M': case 'L': {
          const p = transformPoint(cmd.x, cmd.y, ctm);
          cmds.push({ type: cmd.type, x: p.x, y: p.y });
          break;
        }
        case 'C': {
          const p1 = transformPoint(cmd.x1, cmd.y1, ctm);
          const p2 = transformPoint(cmd.x2, cmd.y2, ctm);
          const p3 = transformPoint(cmd.x, cmd.y, ctm);
          cmds.push({
            type: 'C', x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, x: p3.x, y: p3.y,
          });
          break;
        }
        case 'Z':
          cmds.push({ type: 'Z' });
          break;
        // no default
      }
    }

    paths.push({
      commands: cmds,
      fill,
      stroke,
      evenOdd,
      fillColor: fillColor.slice(),
      fillColorSpace,
      strokeColor: strokeColor.slice(),
      strokeColorSpace,
      lineWidth: lineWidth * ctmScale(ctm),
      lineCap,
      lineJoin,
      miterLimit,
      dashArray: dashArray.slice(),
      dashPhase,
    });

    currentPath = [];
  }

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    if (tok.type !== 'operator') {
      operandStack.push(tok);
      continue;
    }

    const op = tok.value;

    switch (op) {
      // ── Graphics state ────────────────────────────────────────────
      case 'q':
        gstateStack.push({
          ctm: ctm.slice(),
          fillColor: fillColor.slice(),
          fillColorSpace,
          strokeColor: strokeColor.slice(),
          strokeColorSpace,
          lineWidth,
          lineCap,
          lineJoin,
          miterLimit,
          dashArray: dashArray.slice(),
          dashPhase,
        });
        operandStack.length = 0;
        break;

      case 'Q':
        if (gstateStack.length > 0) {
          const s = /** @type {typeof gstateStack[0]} */ (gstateStack.pop());
          ctm = s.ctm;
          fillColor = s.fillColor;
          fillColorSpace = s.fillColorSpace;
          strokeColor = s.strokeColor;
          strokeColorSpace = s.strokeColorSpace;
          lineWidth = s.lineWidth;
          lineCap = s.lineCap;
          lineJoin = s.lineJoin;
          miterLimit = s.miterLimit;
          dashArray = s.dashArray;
          dashPhase = s.dashPhase;
        }
        operandStack.length = 0;
        break;

      case 'cm':
        if (operandStack.length >= 6) {
          const m = popNums(6);
          ctm = multiplyMatrices(m, ctm);
        } else {
          operandStack.length = 0;
        }
        break;

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

      case 'M': // miter limit
        if (operandStack.length >= 1) miterLimit = operandStack[operandStack.length - 1].value;
        operandStack.length = 0;
        break;

      case 'd': // dash pattern  [array] phase d
        if (operandStack.length >= 2) {
          const phase = operandStack[operandStack.length - 1];
          const arr = operandStack[operandStack.length - 2];
          dashPhase = phase.value;
          dashArray = arr.type === 'array' ? arr.value.map((v) => v.value) : [];
        }
        operandStack.length = 0;
        break;

      // ── Color operators ───────────────────────────────────────────
      case 'g': // gray fill
        if (operandStack.length >= 1) {
          fillColor = popNums(1);
          fillColorSpace = 'gray';
        } else { operandStack.length = 0; }
        break;

      case 'G': // gray stroke
        if (operandStack.length >= 1) {
          strokeColor = popNums(1);
          strokeColorSpace = 'gray';
        } else { operandStack.length = 0; }
        break;

      case 'rg': // RGB fill
        if (operandStack.length >= 3) {
          fillColor = popNums(3);
          fillColorSpace = 'rgb';
        } else { operandStack.length = 0; }
        break;

      case 'RG': // RGB stroke
        if (operandStack.length >= 3) {
          strokeColor = popNums(3);
          strokeColorSpace = 'rgb';
        } else { operandStack.length = 0; }
        break;

      case 'k': // CMYK fill
        if (operandStack.length >= 4) {
          fillColor = popNums(4);
          fillColorSpace = 'cmyk';
        } else { operandStack.length = 0; }
        break;

      case 'K': // CMYK stroke
        if (operandStack.length >= 4) {
          strokeColor = popNums(4);
          strokeColorSpace = 'cmyk';
        } else { operandStack.length = 0; }
        break;

      case 'cs': // set fill color space (name)
        if (operandStack.length >= 1) {
          fillColorSpace = operandStack[operandStack.length - 1].value;
        }
        operandStack.length = 0;
        break;

      case 'CS': // set stroke color space (name)
        if (operandStack.length >= 1) {
          strokeColorSpace = operandStack[operandStack.length - 1].value;
        }
        operandStack.length = 0;
        break;

      case 'sc': case 'scn': // set fill color (operand count depends on color space)
        if (operandStack.length >= 1) {
          fillColor = operandStack.map((t) => t.value);
        }
        operandStack.length = 0;
        break;

      case 'SC': case 'SCN': // set stroke color
        if (operandStack.length >= 1) {
          strokeColor = operandStack.map((t) => t.value);
        }
        operandStack.length = 0;
        break;

      // ── Path construction ─────────────────────────────────────────
      case 'm': { // moveto
        if (operandStack.length >= 2) {
          const vals = popNums(2);
          curX = vals[0]; curY = vals[1];
          pathStartX = curX; pathStartY = curY;
          currentPath.push({ type: 'M', x: curX, y: curY });
        } else { operandStack.length = 0; }
        break;
      }

      case 'l': { // lineto
        if (operandStack.length >= 2) {
          const vals = popNums(2);
          curX = vals[0]; curY = vals[1];
          currentPath.push({ type: 'L', x: curX, y: curY });
        } else { operandStack.length = 0; }
        break;
      }

      case 'c': { // curveto (x1 y1 x2 y2 x3 y3)
        if (operandStack.length >= 6) {
          const vals = popNums(6);
          currentPath.push({
            type: 'C', x1: vals[0], y1: vals[1], x2: vals[2], y2: vals[3], x: vals[4], y: vals[5],
          });
          curX = vals[4]; curY = vals[5];
        } else { operandStack.length = 0; }
        break;
      }

      case 'v': { // curveto: first control point = current point (x2 y2 x3 y3)
        if (operandStack.length >= 4) {
          const vals = popNums(4);
          currentPath.push({
            type: 'C', x1: curX, y1: curY, x2: vals[0], y2: vals[1], x: vals[2], y: vals[3],
          });
          curX = vals[2]; curY = vals[3];
        } else { operandStack.length = 0; }
        break;
      }

      case 'y': { // curveto: last control point = endpoint (x1 y1 x3 y3)
        if (operandStack.length >= 4) {
          const vals = popNums(4);
          currentPath.push({
            type: 'C', x1: vals[0], y1: vals[1], x2: vals[2], y2: vals[3], x: vals[2], y: vals[3],
          });
          curX = vals[2]; curY = vals[3];
        } else { operandStack.length = 0; }
        break;
      }

      case 'h': // closepath
        currentPath.push({ type: 'Z' });
        curX = pathStartX; curY = pathStartY;
        operandStack.length = 0;
        break;

      case 're': { // rectangle (x y w h)
        if (operandStack.length >= 4) {
          const vals = popNums(4);
          const [rx, ry, rw, rh] = vals;
          currentPath.push({ type: 'M', x: rx, y: ry });
          currentPath.push({ type: 'L', x: rx + rw, y: ry });
          currentPath.push({ type: 'L', x: rx + rw, y: ry + rh });
          currentPath.push({ type: 'L', x: rx, y: ry + rh });
          currentPath.push({ type: 'Z' });
          curX = rx; curY = ry;
          pathStartX = rx; pathStartY = ry;
        } else { operandStack.length = 0; }
        break;
      }

      // ── Path painting ─────────────────────────────────────────────
      case 'S': // stroke
        emitPath(false, true, false);
        operandStack.length = 0;
        break;

      case 's': // close + stroke
        currentPath.push({ type: 'Z' });
        emitPath(false, true, false);
        operandStack.length = 0;
        break;

      case 'f': case 'F': // fill (non-zero winding)
        emitPath(true, false, false);
        operandStack.length = 0;
        break;

      case 'f*': // fill (even-odd)
        emitPath(true, false, true);
        operandStack.length = 0;
        break;

      case 'B': // fill + stroke (non-zero)
        emitPath(true, true, false);
        operandStack.length = 0;
        break;

      case 'B*': // fill + stroke (even-odd)
        emitPath(true, true, true);
        operandStack.length = 0;
        break;

      case 'b': // close + fill + stroke (non-zero)
        currentPath.push({ type: 'Z' });
        emitPath(true, true, false);
        operandStack.length = 0;
        break;

      case 'b*': // close + fill + stroke (even-odd)
        currentPath.push({ type: 'Z' });
        emitPath(true, true, true);
        operandStack.length = 0;
        break;

      case 'n': // end path (no paint — used for clipping)
        currentPath = [];
        operandStack.length = 0;
        break;

      // ── Clipping (modifies clip, then path is consumed by next paint/n) ──
      case 'W': case 'W*':
        // Clipping is applied implicitly; the path stays for the next paint op.
        operandStack.length = 0;
        break;

      // ── Skip text/image/other operators ───────────────────────────
      default:
        operandStack.length = 0;
        break;
    }
  }

  return paths;
}
