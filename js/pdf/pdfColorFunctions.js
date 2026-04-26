/** @typedef {NonNullable<ReturnType<typeof parseFunction>>} ParsedFunction */

/**
 * Tokenize a PostScript calculator function body.
 * @param {string} code
 */
export function tokenizePS(code) {
  let src = code.trim();
  if (src.startsWith('{') && src.endsWith('}')) src = src.slice(1, -1);

  const tokens = [];
  const stack = [tokens];
  const re = /\{|\}|[^\s{}]+/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const tok = m[0];
    if (tok === '{') {
      const sub = [];
      stack[stack.length - 1].push(sub);
      stack.push(sub);
    } else if (tok === '}') {
      stack.pop();
    } else {
      const num = Number(tok);
      stack[stack.length - 1].push(Number.isNaN(num) ? tok : num);
    }
  }
  return tokens;
}

/**
 * Evaluate a tokenized PostScript calculator function.
 * @param {Array} tokens
 * @param {number[]} inputs
 */
export function evaluatePS(tokens, inputs) {
  const st = [...inputs];
  const exec = (toks) => {
    for (let i = 0; i < toks.length; i++) {
      const tok = toks[i];
      if (typeof tok === 'number') { st.push(tok); continue; }
      if (Array.isArray(tok)) { st.push(tok); continue; }
      if (tok === 'true') { st.push(true); continue; }
      if (tok === 'false') { st.push(false); continue; }
      const a = () => st.pop();
      const b = () => st.pop();
      switch (tok) {
        case 'dup': { const v = a(); st.push(v, v); break; }
        case 'exch': { const x = a(); const y = a(); st.push(x, y); break; }
        case 'pop': a(); break;
        case 'copy': {
          const n = a();
          const items = st.slice(st.length - n);
          st.push(...items);
          break;
        }
        case 'index': {
          const idx = a();
          st.push(st[st.length - 1 - idx]);
          break;
        }
        case 'roll': {
          const j = a();
          const n = a();
          if (n <= 0) break;
          const group = st.splice(st.length - n);
          const shift = ((j % n) + n) % n;
          for (let k = 0; k < n; k++) {
            st.push(group[(k - shift + n) % n]);
          }
          break;
        }
        case 'add': { const x = a(); st.push(b() + x); break; }
        case 'sub': { const x = a(); st.push(b() - x); break; }
        case 'mul': { const x = a(); st.push(b() * x); break; }
        case 'div': { const x = a(); st.push(b() / x); break; }
        case 'idiv': { const x = a(); st.push(Math.trunc(b() / x)); break; }
        case 'mod': { const x = a(); st.push(b() % x); break; }
        case 'neg': st.push(-a()); break;
        case 'abs': st.push(Math.abs(a())); break;
        case 'ceiling': st.push(Math.ceil(a())); break;
        case 'floor': st.push(Math.floor(a())); break;
        case 'round': st.push(Math.round(a())); break;
        case 'truncate': st.push(Math.trunc(a())); break;
        case 'sqrt': st.push(Math.sqrt(a())); break;
        case 'exp': { const x = a(); st.push(b() ** x); break; }
        case 'ln': st.push(Math.log(a())); break;
        case 'log': st.push(Math.log10(a())); break;
        case 'sin': st.push(Math.sin(a() * Math.PI / 180)); break;
        case 'cos': st.push(Math.cos(a() * Math.PI / 180)); break;
        case 'atan': {
          // PS spec: atan takes (num, den) with den on top of stack and returns the
          // angle in degrees, normalized to [0, 360). atan2() in JS returns (-π, π].
          const den = a();
          const num = a();
          let ang = Math.atan2(num, den) * 180 / Math.PI;
          if (ang < 0) ang += 360;
          st.push(ang);
          break;
        }
        case 'eq': { const x = a(); st.push(b() === x); break; }
        case 'ne': { const x = a(); st.push(b() !== x); break; }
        case 'gt': { const x = a(); st.push(b() > x); break; }
        case 'ge': { const x = a(); st.push(b() >= x); break; }
        case 'lt': { const x = a(); st.push(b() < x); break; }
        case 'le': { const x = a(); st.push(b() <= x); break; }
        case 'and': { const x = a(); const y = b(); st.push(typeof x === 'boolean' ? (x && y) : (x & y)); break; }
        case 'or': { const x = a(); const y = b(); st.push(typeof x === 'boolean' ? (x || y) : (x | y)); break; }
        case 'xor': { const x = a(); const y = b(); st.push(typeof x === 'boolean' ? (x !== y) : (x ^ y)); break; }
        case 'not': { const x = a(); st.push(typeof x === 'boolean' ? !x : ~x); break; }
        case 'bitshift': { const shift = a(); const val = a(); st.push(shift >= 0 ? (val << shift) : (val >> -shift)); break; }
        case 'if': { const proc = a(); const cond = a(); if (cond) exec(proc); break; }
        case 'ifelse': { const falseProc = a(); const trueProc = a(); const cond = a(); exec(cond ? trueProc : falseProc); break; }
        case 'cvi': { st.push(Math.trunc(a())); break; }
        case 'cvr': break;
        default: break;
      }
    }
  };
  exec(tokens);
  return st;
}

/**
 * Parse a PDF function. The argument can be:
 *   - An object number (indirect ref) — fetched and parsed via objCache.
 *   - A dict text (e.g. an inline `<<...>>` function dict).
 *
 * @param {string|number} funcDef
 * @param {import('./parsePdfUtils.js').ObjectCache} objCache
 */
export function parseFunction(funcDef, objCache) {
  /** @type {string|null} */
  let funcText = null;
  /** @type {number|null} */
  let funcObjNum = null;
  if (typeof funcDef === 'number') {
    funcObjNum = funcDef;
    funcText = objCache.getObjectText(funcObjNum);
  } else if (typeof funcDef === 'string') {
    funcText = funcDef;
  }
  if (!funcText) return null;

  const ftMatch = /\/FunctionType\s+(\d+)/.exec(funcText);
  if (!ftMatch) return null;
  const type = /** @type {0|2|3|4} */ (Number(ftMatch[1]));

  const domainMatch = /\/Domain\s*\[\s*([\d.\s-]+)\]/.exec(funcText);
  const domain = domainMatch ? domainMatch[1].trim().split(/\s+/).map(Number) : [0, 1];
  const nInputs = Math.max(1, Math.floor(domain.length / 2));

  const rangeMatch = /\/Range\s*\[\s*([\d.\s-]+)\]/.exec(funcText);
  const range = rangeMatch ? rangeMatch[1].trim().split(/\s+/).map(Number) : null;

  if (type === 0) {
    if (funcObjNum == null) return null;
    const sizeMatch = /\/Size\s*\[\s*([\d\s]+)\]/.exec(funcText);
    const size = sizeMatch
      ? sizeMatch[1].trim().split(/\s+/).map(Number)
      : new Array(nInputs).fill(256);
    const bpsMatch = /\/BitsPerSample\s+(\d+)/.exec(funcText);
    const bps = bpsMatch ? Number(bpsMatch[1]) : 8;
    const encodeMatch = /\/Encode\s*\[\s*([\d.\s-]+)\]/.exec(funcText);
    const encode = encodeMatch ? encodeMatch[1].trim().split(/\s+/).map(Number) : null;
    const decodeMatch = /\/Decode\s*\[\s*([\d.\s-]+)\]/.exec(funcText);
    // Decode defaults to Range per PDF spec Table 3.36
    const decode = decodeMatch ? decodeMatch[1].trim().split(/\s+/).map(Number) : range;
    const samples = objCache.getStreamBytes(funcObjNum);
    if (!samples) return null;
    const nOutputs = range ? Math.floor(range.length / 2) : 1;
    return {
      type, domain, range, nInputs, nOutputs, size, bps, encode, decode, samples,
    };
  }

  if (type === 2) {
    const c0Match = /\/C0\s*\[\s*([\d.\s-]+)\]/.exec(funcText);
    const c1Match = /\/C1\s*\[\s*([\d.\s-]+)\]/.exec(funcText);
    const nMatch = /\/N\s+([\d.]+)/.exec(funcText);
    const c0 = c0Match ? c0Match[1].trim().split(/\s+/).map(Number) : [0];
    const c1 = c1Match ? c1Match[1].trim().split(/\s+/).map(Number) : [1];
    const N = nMatch ? Number(nMatch[1]) : 1.0;
    const nOutputs = Math.max(c0.length, c1.length, 1);
    while (c0.length < nOutputs) c0.push(0);
    while (c1.length < nOutputs) c1.push(1);
    return {
      type, domain, range, nInputs: 1, nOutputs, c0, c1, N,
    };
  }

  if (type === 3) {
    // Stitching function: combines a sequence of 1-input sub-functions over Domain.
    // /Functions [F0 F1 ... Fn-1]   /Bounds [b1 ... bn-1]   /Encode [e0a e0b e1a e1b ...]
    // Each sub-function can be an indirect ref or an inline <<...>> dict.
    const subFuncs = parseFunctionsArray(funcText, objCache);
    if (!subFuncs || subFuncs.length === 0) return null;
    const boundsMatch = /\/Bounds\s*\[\s*([\d.\s-]*)\]/.exec(funcText);
    const bounds = boundsMatch
      ? boundsMatch[1].trim().split(/\s+/).filter((s) => s.length > 0).map(Number)
      : [];
    const stEncMatch = /\/Encode\s*\[\s*([\d.\s-]+)\]/.exec(funcText);
    const stitchEncode = stEncMatch
      ? stEncMatch[1].trim().split(/\s+/).map(Number)
      : (() => {
        const enc = [];
        for (const f of subFuncs) { enc.push(f.domain[0], f.domain[1]); }
        return enc;
      })();
    const nOutputs = subFuncs[0].nOutputs;
    return {
      type, domain, range, nInputs: 1, nOutputs, functions: subFuncs, bounds, stitchEncode,
    };
  }

  if (type === 4) {
    if (funcObjNum == null) return null;
    const samples = objCache.getStreamBytes(funcObjNum);
    if (!samples) return null;
    const psCode = new TextDecoder('utf-8').decode(samples).trim();
    const tokens = tokenizePS(psCode);
    const nOutputs = range ? Math.floor(range.length / 2) : 0;
    return {
      type, domain, range, nInputs, nOutputs, tokens,
    };
  }

  return null;
}

/**
 * Parse a `/Functions` array from a stitching function dict body. Handles
 * both indirect refs (`N 0 R`) and inline dicts (`<<...>>`).
 * @param {string} funcText - The Type 3 function dict text
 * @param {import('./parsePdfUtils.js').ObjectCache} objCache
 */
function parseFunctionsArray(funcText, objCache) {
  const fnsStart = funcText.indexOf('/Functions');
  if (fnsStart === -1) return null;
  const arrStart = funcText.indexOf('[', fnsStart);
  if (arrStart === -1) return null;
  // Find matching ']' allowing nested <<...>> dicts
  let depth = 0;
  let dictDepth = 0;
  let arrEnd = -1;
  for (let i = arrStart; i < funcText.length; i++) {
    const ch = funcText[i];
    if (dictDepth === 0 && ch === '[') {
      depth++;
    } else if (dictDepth === 0 && ch === ']') {
      depth--;
      if (depth === 0) { arrEnd = i; break; }
    } else if (ch === '<' && funcText[i + 1] === '<') {
      dictDepth++;
      i++;
    } else if (ch === '>' && funcText[i + 1] === '>') {
      dictDepth--;
      i++;
    }
  }
  if (arrEnd === -1) return null;
  const arrBody = funcText.substring(arrStart + 1, arrEnd);

  const result = [];
  // Split into tokens of either `N 0 R` or `<<...>>` dicts
  let i = 0;
  while (i < arrBody.length) {
    const ch = arrBody[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    if (ch === '<' && arrBody[i + 1] === '<') {
      // Inline dict — find matching >>
      let dd = 1; let j = i + 2;
      while (j < arrBody.length && dd > 0) {
        if (arrBody[j] === '<' && arrBody[j + 1] === '<') { dd++; j += 2; continue; }
        if (arrBody[j] === '>' && arrBody[j + 1] === '>') { dd--; j += 2; continue; }
        j++;
      }
      const dictText = arrBody.substring(i, j);
      const parsed = parseFunction(dictText, objCache);
      if (parsed) result.push(parsed);
      else return null;
      i = j;
      continue;
    }
    // Indirect ref `N G R`
    const refMatch = /^(\d+)\s+\d+\s+R/.exec(arrBody.substring(i));
    if (refMatch) {
      const parsed = parseFunction(Number(refMatch[1]), objCache);
      if (parsed) result.push(parsed);
      else return null;
      i += refMatch[0].length;
      continue;
    }
    // Skip unknown char
    i++;
  }
  return result.length > 0 ? result : null;
}

/**
 * Read a sample value from packed sample data at a given linear index.
 * @param {Uint8Array} samples
 * @param {number} index - linear sample index (component already factored in)
 * @param {number} bps - bits per sample (1, 2, 4, 8, 12, 16, 24, or 32)
 */
function readSample(samples, index, bps) {
  if (bps === 8) return samples[index];
  if (bps === 16) {
    return (samples[index * 2] << 8) | samples[index * 2 + 1];
  }
  if (bps < 8) {
    const bitOffset = index * bps;
    const byteIdx = bitOffset >> 3;
    const bitInByte = bitOffset & 7;
    // Read up to 16 bits
    let v = (samples[byteIdx] << 8) | (samples[byteIdx + 1] || 0);
    v >>= 16 - bps - bitInByte;
    v &= (1 << bps) - 1;
    return v;
  }
  // 32-bit etc. — uncommon for tint transforms
  return samples[index];
}

/**
 * Evaluate a parsed PDF function on the given inputs.
 * @param {ParsedFunction} fn
 * @param {number[]} inputs
 */
export function evaluateFunction(fn, inputs) {
  if (!fn) return null;

  // Clip inputs to Domain
  const clipped = new Array(fn.nInputs);
  for (let i = 0; i < fn.nInputs; i++) {
    const v = inputs[i] != null ? inputs[i] : 0;
    const dMin = fn.domain[i * 2];
    const dMax = fn.domain[i * 2 + 1];
    clipped[i] = Math.max(dMin, Math.min(dMax, v));
  }

  let out;
  if (fn.type === 0) {
    out = evaluateSampled(fn, clipped);
  } else if (fn.type === 2) {
    const t = clipped[0];
    const tN = fn.N === 1 ? t : t ** fn.N;
    out = fn.c0.map((v, j) => v + tN * (fn.c1[j] - v));
  } else if (fn.type === 3) {
    out = evaluateStitching(fn, clipped[0]);
  } else if (fn.type === 4) {
    const result = evaluatePS(fn.tokens, clipped);
    out = fn.nOutputs > 0 ? result.slice(-fn.nOutputs) : result;
  } else {
    return null;
  }

  // Clip outputs to Range if defined
  if (out && fn.range) {
    for (let oi = 0; oi < out.length; oi++) {
      const rMin = fn.range[oi * 2];
      const rMax = fn.range[oi * 2 + 1];
      if (rMin != null && rMax != null) {
        out[oi] = Math.max(rMin, Math.min(rMax, out[oi]));
      }
    }
  }
  return out;
}

/**
 * Evaluate a FunctionType 0 (sampled) function.
 * Implements multilinear interpolation across N input dimensions.
 */
function evaluateSampled(fn, inputs) {
  const {
    domain, encode, decode, size, samples, bps, nOutputs,
  } = fn;
  const maxSample = (1 << bps) - 1;
  const N = fn.nInputs;

  // Encode each input -> sample-space coordinate
  const e = new Array(N);
  for (let i = 0; i < N; i++) {
    const dMin = domain[i * 2];
    const dMax = domain[i * 2 + 1];
    const eMin = encode ? encode[i * 2] : 0;
    const eMax = encode ? encode[i * 2 + 1] : size[i] - 1;
    let val = ((inputs[i] - dMin) / (dMax - dMin)) * (eMax - eMin) + eMin;
    if (val < 0) val = 0;
    if (val > size[i] - 1) val = size[i] - 1;
    e[i] = val;
  }

  // Multilinear interpolation: for each of 2^N corners, weight by product of
  // (1-f) or f along each dimension, then sum and decode.
  const out = new Array(nOutputs).fill(0);
  const corners = 1 << N;
  // Pre-compute lo/hi indices and fractional parts
  const lo = new Array(N);
  const hi = new Array(N);
  const f = new Array(N);
  for (let i = 0; i < N; i++) {
    lo[i] = Math.floor(e[i]);
    hi[i] = Math.min(lo[i] + 1, size[i] - 1);
    f[i] = e[i] - lo[i];
  }

  // Sample stride: linearized N-D index uses size[0] as fastest axis
  for (let c = 0; c < corners; c++) {
    let weight = 1;
    let linear = 0;
    let stride = 1;
    for (let i = 0; i < N; i++) {
      const useHi = (c >> i) & 1;
      const idx = useHi ? hi[i] : lo[i];
      weight *= useHi ? f[i] : (1 - f[i]);
      linear += idx * stride;
      stride *= size[i];
    }
    // Read nOutputs samples at this corner
    for (let oi = 0; oi < nOutputs; oi++) {
      const raw = readSample(samples, linear * nOutputs + oi, bps);
      out[oi] += weight * raw;
    }
  }

  // Decode each output sample to its Decode range
  for (let oi = 0; oi < nOutputs; oi++) {
    if (decode) {
      const dMin = decode[oi * 2];
      const dMax = decode[oi * 2 + 1];
      out[oi] = (out[oi] / maxSample) * (dMax - dMin) + dMin;
    } else {
      out[oi] /= maxSample;
    }
  }
  return out;
}

/**
 * Evaluate a FunctionType 3 (stitching) function. Picks the correct
 * sub-function for the input value, encodes the input into the sub-function's
 * domain, and evaluates.
 */
function evaluateStitching(fn, x) {
  const {
    domain, functions, bounds, stitchEncode,
  } = fn;
  // Pick sub-function index based on bounds
  let k = 0;
  while (k < bounds.length && x >= bounds[k]) k++;
  const sub = functions[k];
  if (!sub) return null;
  const lower = k === 0 ? domain[0] : bounds[k - 1];
  const upper = k === bounds.length ? domain[1] : bounds[k];
  const encMin = stitchEncode[k * 2];
  const encMax = stitchEncode[k * 2 + 1];
  // Map x from [lower,upper] to [encMin,encMax]
  const t = upper === lower ? encMin : encMin + (x - lower) * (encMax - encMin) / (upper - lower);
  return evaluateFunction(sub, [t]);
}

/**
 * @typedef {{
 *   type: string,
 *   labWhitePoint?: number[],
 *   calRgbGamma?: number[]|null,
 *   calRgbMatrix?: number[]|null,
 *   nComp?: number,
 * }} ParsedAltCS
 */

/**
 * Parse an alternate color space text into a structured form. Handles direct
 * names (`/DeviceRGB`), parameterized inline arrays (`[/Lab <<...>>]`), and
 * indirect references (`N 0 R`). Returns null for unrecognized text.
 *
 * @param {string} csText - Color space text. May be a single name, an array, or any
 *   chunk of text containing the alt CS marker.
 * @param {import('./parsePdfUtils.js').ObjectCache} objCache
 * @returns {ParsedAltCS}
 */
export function parseAltColorSpace(csText, objCache) {
  /** @type {ParsedAltCS} */
  const out = { type: 'DeviceRGB' };

  if (/\/Lab\b/.test(csText)) {
    out.type = 'Lab';
    const wpMatch = /\/WhitePoint\s*\[\s*([\d.\s]+)\]/.exec(csText);
    if (wpMatch) out.labWhitePoint = wpMatch[1].trim().split(/\s+/).map(Number);
  } else if (/\/DeviceCMYK/.test(csText)) {
    out.type = 'DeviceCMYK';
    out.nComp = 4;
  } else if (/\/DeviceRGB/.test(csText)) {
    out.type = 'DeviceRGB';
    out.nComp = 3;
  } else if (/\/DeviceGray/.test(csText)) {
    out.type = 'DeviceGray';
    out.nComp = 1;
  } else if (/\/CalRGB/.test(csText)) {
    out.type = 'CalRGB';
    out.nComp = 3;
    const gMatch = /\/Gamma\s*\[\s*([\d.\s]+)\]/.exec(csText);
    if (gMatch) out.calRgbGamma = gMatch[1].trim().split(/\s+/).map(Number);
    const mMatch = /\/Matrix\s*\[\s*([\d.\s]+)\]/.exec(csText);
    if (mMatch) out.calRgbMatrix = mMatch[1].trim().split(/\s+/).map(Number);
  } else if (/\/CalGray/.test(csText)) {
    out.type = 'CalGray';
    out.nComp = 1;
  } else if (/\/ICCBased/.test(csText)) {
    // ICCBased: collapse to a Device* equivalent based on /N component count.
    let nMatch = /\/N\s+(\d+)/.exec(csText);
    if (!nMatch) {
      const refMatch = /\/ICCBased\s+(\d+)\s+\d+\s+R/.exec(csText);
      if (refMatch) {
        const iccObjText = objCache.getObjectText(Number(refMatch[1]));
        if (iccObjText) nMatch = /\/N\s+(\d+)/.exec(iccObjText);
      }
    }
    const n = nMatch ? Number(nMatch[1]) : 3;
    out.type = n === 4 ? 'DeviceCMYK' : n === 1 ? 'DeviceGray' : 'DeviceRGB';
    out.nComp = n;
  }
  return out;
}

const SRGB_GAMMA_ENC = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

/**
 * Convert CMYK (0-1) → RGB (0-255).
 *
 * Pure-K (C=M=Y=0) bypasses the polynomial and returns exact gray
 * `255*(1-K)`. In PDFs pure-K almost always means "intended as neutral
 * black" — body text, diagrams, line art. But SWOP black ink isn't
 * perfectly neutral, so feeding pure-K through the polynomial yields
 * R≠G≠B (e.g. CMYK(0,0,0,0.72) → RGB(107,109,114)), giving a visible
 * color cast on grayscale content. pdf.js applies the polynomial
 * unconditionally and accepts the tint; the bypass is our addition.
 *
 * Chromatic CMYK → polynomial approximation of US Web Coated (SWOP) v2.
 * The naive subtractive formula `(1-C)(1-K)` etc. gives wrong hues for
 * chromatic fills (e.g. forest-green renders as lime). Polynomial
 * adapted from Mozilla pdf.js (Apache 2.0), src/core/colorspace.js
 * DeviceCmykCS.
 *
 * @param {number} c
 * @param {number} m
 * @param {number} y
 * @param {number} k
 * @returns {[number, number, number]}
 */
export function cmykToRgb(c, m, y, k) {
  if (c === 0 && m === 0 && y === 0) {
    const gray = Math.max(0, Math.min(255, Math.round(255 * (1 - k))));
    return [gray, gray, gray];
  }
  const r = 255
    + c * (-4.387332384609988 * c + 54.48615194189176 * m + 18.82290502165302 * y + 212.25662451639585 * k - 285.2331026137004)
    + m * (1.7149763477362134 * m - 5.6096736904047315 * y - 17.873870861415444 * k - 5.497006427196366)
    + y * (-2.5217340131683033 * y - 21.248923337353073 * k + 17.5119270841813)
    + k * (-21.86122147463605 * k - 189.48180835922747);

  const g = 255
    + c * (8.841041422036149 * c + 60.118027045597366 * m + 6.871425592049007 * y + 31.159100130055922 * k - 79.2970844816548)
    + m * (-15.310361306967817 * m + 17.575251261109482 * y + 131.35250912493976 * k - 190.9453302588951)
    + y * (4.444339102852739 * y + 9.8632861493405 * k - 24.86741582555878)
    + k * (-20.737325471181034 * k - 187.80453709719578);

  const b = 255
    + c * (0.8842522430003296 * c + 8.078677503112928 * m + 30.89978309703729 * y - 0.23883238689178934 * k - 14.183019929975921)
    + m * (10.49593273432072 * m + 63.02378494754052 * y + 50.606957656360734 * k - 112.23884253719248)
    + y * (0.03296041114873217 * y + 115.60384449646641 * k - 193.58209356861505)
    + k * (-22.33816807309886 * k - 180.12613974708367);

  return [
    Math.max(0, Math.min(255, Math.round(r))),
    Math.max(0, Math.min(255, Math.round(g))),
    Math.max(0, Math.min(255, Math.round(b))),
  ];
}

/**
 * Convert components in the given alternate color space to an [r,g,b] byte triple.
 * Handles DeviceRGB / DeviceCMYK / DeviceGray / CalRGB / CalGray / Lab.
 * @param {ParsedAltCS} altCS
 * @param {number[]} comp - Components in the alt CS's natural range
 *   (Device*: [0,1] floats; Lab: L in [0,100], a/b in [-128,127])
 * @returns {[number, number, number]}
 */
export function altCSToRGB(altCS, comp) {
  let r; let g; let b;
  if (altCS.type === 'DeviceCMYK') {
    const C = comp[0] || 0;
    const M = comp[1] || 0;
    const Y = comp[2] || 0;
    const K = comp[3] || 0;
    r = Math.round(255 * (1 - C) * (1 - K));
    g = Math.round(255 * (1 - M) * (1 - K));
    b = Math.round(255 * (1 - Y) * (1 - K));
  } else if (altCS.type === 'DeviceGray' || altCS.type === 'CalGray') {
    const gray = Math.round(255 * Math.max(0, Math.min(1, comp[0] || 0)));
    r = gray; g = gray; b = gray;
  } else if (altCS.type === 'CalRGB') {
    const gamma = altCS.calRgbGamma || [1, 1, 1];
    const A = (comp[0] || 0) ** gamma[0];
    const B = (comp[1] || 0) ** gamma[1];
    const C = (comp[2] || 0) ** gamma[2];
    const m = altCS.calRgbMatrix || [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const X = m[0] * A + m[3] * B + m[6] * C;
    const Y = m[1] * A + m[4] * B + m[7] * C;
    const Z = m[2] * A + m[5] * B + m[8] * C;
    const lr = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
    const lg = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
    const lb = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;
    r = Math.round(255 * Math.max(0, Math.min(1, SRGB_GAMMA_ENC(lr))));
    g = Math.round(255 * Math.max(0, Math.min(1, SRGB_GAMMA_ENC(lg))));
    b = Math.round(255 * Math.max(0, Math.min(1, SRGB_GAMMA_ENC(lb))));
  } else if (altCS.type === 'Lab') {
    const Lstar = comp[0] || 0;
    const astar = comp[1] || 0;
    const bstar = comp[2] || 0;
    const fy = (Lstar + 16) / 116;
    const fx = fy + astar / 500;
    const fz = fy - bstar / 200;
    const delta = 6 / 29;
    const fInv = (ft) => (ft > delta ? ft * ft * ft : 3 * delta * delta * (ft - 4 / 29));
    // Scale by the D65 white point regardless of the color space's declared
    // WhitePoint — the D65 sRGB matrix expects a D65 reference white, and
    // without a chromatic adaptation step a D50-specified Lab(100,0,0) would
    // decode to cream instead of pure white. Matches the inline Lab handler in renderPdfPage.js.
    const xyzX = 0.9505 * fInv(fx);
    const xyzY = fInv(fy);
    const xyzZ = 1.089 * fInv(fz);
    const lr = 3.2406 * xyzX - 1.5372 * xyzY - 0.4986 * xyzZ;
    const lg = -0.9689 * xyzX + 1.8758 * xyzY + 0.0415 * xyzZ;
    const lb = 0.0557 * xyzX - 0.2040 * xyzY + 1.0570 * xyzZ;
    r = Math.round(255 * Math.max(0, Math.min(1, SRGB_GAMMA_ENC(lr))));
    g = Math.round(255 * Math.max(0, Math.min(1, SRGB_GAMMA_ENC(lg))));
    b = Math.round(255 * Math.max(0, Math.min(1, SRGB_GAMMA_ENC(lb))));
  } else {
    // DeviceRGB or unknown — treat as direct RGB.
    r = Math.round(255 * (comp[0] || 0));
    g = Math.round(255 * (comp[1] || 0));
    b = Math.round(255 * (comp[2] || 0));
  }
  return [Math.max(0, Math.min(255, r)), Math.max(0, Math.min(255, g)), Math.max(0, Math.min(255, b))];
}

/**
 * @typedef {{
 *   tintFn: ParsedFunction|null,
 *   altCS: ParsedAltCS,
 *   nInputs: number,
 * }} ParsedTintCS
 */

/**
 * Parse a Separation or DeviceN color space array into its tint function and
 * alternate color space. Handles inline tint dicts, indirect refs, and the
 * various ways the alt CS can be expressed (direct name, indirect ref, or
 * inline `[/Lab <<...>>]`-style array).
 *
 * @param {string} csText - The text of the color space array (typically the
 *   contents inside `[/Separation ...]` or `[/DeviceN ...]`).
 * @param {import('./parsePdfUtils.js').ObjectCache} objCache
 * @returns {ParsedTintCS}
 */
export function parseTintColorSpace(csText, objCache) {
  // Determine the alt CS first by scanning the array for a Device*/Cal*/Lab/ICCBased marker.
  // Order of detection (most specific first): direct-name, indirect ref, then any text.
  /** @type {ParsedAltCS} */
  let altCS = { type: 'DeviceRGB' };

  // Try direct name match: /Separation /Name /DeviceCMYK or /Lab
  const sepDirect = /\/Separation\s*\/[^\s/<>[\]]+\s*\/(Device\w+|CalRGB|CalGray|Lab|ICCBased)/.exec(csText);
  if (sepDirect) {
    altCS = parseAltColorSpace(`/${sepDirect[1]}`, objCache);
  } else {
    const sepRef = /\/Separation\s*\/[^\s/<>[\]]+\s*(\d+)\s+\d+\s+R/.exec(csText);
    if (sepRef) {
      const altObjText = objCache.getObjectText(Number(sepRef[1]));
      if (altObjText) altCS = parseAltColorSpace(altObjText, objCache);
    } else {
      // DeviceN: [/DeviceN [names] altCS tintFunc ...]
      const dnDirect = /\/DeviceN\s*\[[^\]]*\]\s*\/(Device\w+|CalRGB|CalGray|Lab|ICCBased)/.exec(csText);
      const dnRef = !dnDirect && /\/DeviceN\s*\[[^\]]*\]\s*(\d+)\s+\d+\s+R/.exec(csText);
      if (dnDirect) {
        altCS = parseAltColorSpace(`/${dnDirect[1]}`, objCache);
      } else if (dnRef) {
        const altObjText = objCache.getObjectText(Number(dnRef[1]));
        if (altObjText) altCS = parseAltColorSpace(altObjText, objCache);
      } else {
        // Fall back to scanning the whole text (handles inline `[/Lab <<...>>]`).
        altCS = parseAltColorSpace(csText, objCache);
      }
    }
  }

  // Find the tint function: an inline <<...>> dict containing /FunctionType,
  // or the last indirect ref that resolves to a function dict.
  /** @type {ParsedFunction|null} */
  let tintFn = null;
  const allInlineDicts = [...csText.matchAll(/<<[^]*?>>/g)];
  // Take the LAST inline dict (the alt CS dict, if any, comes earlier).
  const lastDict = allInlineDicts.length > 0 ? allInlineDicts[allInlineDicts.length - 1][0] : null;
  if (lastDict && /\/FunctionType/.test(lastDict)) {
    tintFn = parseFunction(lastDict, objCache);
  } else {
    const allRefs = [...csText.matchAll(/(\d+)\s+\d+\s+R/g)];
    for (let ri = allRefs.length - 1; ri >= 0; ri--) {
      const candidateNum = Number(allRefs[ri][1]);
      const candidateText = objCache.getObjectText(candidateNum);
      if (candidateText && /\/FunctionType/.test(candidateText)) {
        tintFn = parseFunction(candidateNum, objCache);
        break;
      }
    }
  }

  // Number of input components: for DeviceN, count colorant names; for Separation, always 1.
  let nInputs = 1;
  // PDF name escapes (e.g., /PANTONE#202755#20U) — match any non-delimiter chars.
  const dnNamesMatch = /\/DeviceN\s*\[\s*((?:\/[^/[\]<>(){}\s]+\s*)+)\]/.exec(csText);
  if (dnNamesMatch) {
    nInputs = (dnNamesMatch[1].match(/\/[^/[\]<>(){}\s]+/g) || []).length;
  }

  return { tintFn, altCS, nInputs };
}

/**
 * Build a 256-entry RGB lookup table for a single-input Separation/DeviceN
 * tint transform. Used by the renderer for fast per-pixel tint application.
 *
 * @param {ParsedTintCS} parsed
 * @returns {Uint8Array|null} Length 256*3, or null if no tint function.
 */
export function buildTintLookupTable(parsed) {
  if (!parsed || !parsed.tintFn) return null;
  const out = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const comp = evaluateFunction(parsed.tintFn, [t]);
    if (!comp) return null;
    const [r, g, b] = altCSToRGB(parsed.altCS, comp);
    out[i * 3] = r;
    out[i * 3 + 1] = g;
    out[i * 3 + 2] = b;
  }
  return out;
}

/**
 * Convert a single set of tint components through the function and alternate
 * color space to an [r,g,b] byte triple. Used by paths that handle one color
 * value at a time (Indexed→DeviceN palette conversion, scn/SCN operator).
 *
 * @param {ParsedTintCS} parsed
 * @param {number[]} components - Tint values in the function's input domain
 * @returns {[number, number, number]|null}
 */
export function tintComponentsToRGB(parsed, components) {
  if (!parsed || !parsed.tintFn) return null;
  const out = evaluateFunction(parsed.tintFn, components);
  if (!out) return null;
  return altCSToRGB(parsed.altCS, out);
}

/**
 * Precompute RGB tint samples for a Separation or DeviceN colorspace, ready
 * for indexed lookup by the renderer. Wraps parseTintColorSpace +
 * buildTintLookupTable / sample-grid conversion in one call.
 *
 * Output shape:
 *   - Single-input Separation/DeviceN: a 256-entry RGB lookup table
 *     (256*3 bytes), indexed by `tint = comp * 255`.
 *   - Multi-input DeviceN with a sampled tint function (FunctionType 0):
 *     the function's full sample grid converted from the alternate color
 *     space to sRGB. The caller must read /Size[] from the function dict
 *     to know how to address the grid (Size[0] varies fastest).
 *   - Multi-input DeviceN with FunctionType 2/4: a diagonal 256-entry sweep
 *     (every input set to the same t). Approximation; works because the
 *     multi-channel "tint" case has colors lying along a 1D path.
 *
 * @param {string} csText
 * @param {import('./parsePdfUtils.js').ObjectCache} objCache
 * @returns {{tintSamples: Uint8Array|null, nComponents: number}}
 */
export function parseSeparationTint(csText, objCache) {
  const parsed = parseTintColorSpace(csText, objCache);
  if (!parsed.tintFn) return { tintSamples: null, nComponents: 3 };

  // Single-input: standard 256-entry lookup table.
  if (parsed.nInputs === 1) {
    const tintSamples = buildTintLookupTable(parsed);
    return { tintSamples, nComponents: 3 };
  }

  // Multi-input: sampled function — convert each grid sample to RGB.
  if (parsed.tintFn.type === 0) {
    const fn = parsed.tintFn;
    const totalSamples = fn.size.reduce((a, b) => a * b, 1);
    const out = new Uint8Array(totalSamples * 3);
    const maxSample = (1 << fn.bps) - 1;
    const decode = fn.decode || fn.range || [];
    for (let s = 0; s < totalSamples; s++) {
      const comp = new Array(fn.nOutputs);
      for (let oi = 0; oi < fn.nOutputs; oi++) {
        const raw = readSample(fn.samples, s * fn.nOutputs + oi, fn.bps);
        const dMin = decode[oi * 2] != null ? decode[oi * 2] : 0;
        const dMax = decode[oi * 2 + 1] != null ? decode[oi * 2 + 1] : 1;
        comp[oi] = (raw / maxSample) * (dMax - dMin) + dMin;
      }
      const [r, g, b] = altCSToRGB(parsed.altCS, comp);
      out[s * 3] = r;
      out[s * 3 + 1] = g;
      out[s * 3 + 2] = b;
    }
    return { tintSamples: out, nComponents: 3 };
  }

  // Multi-input FunctionType 2/4: diagonal 256-entry sweep (approximation).
  const samples = new Uint8Array(256 * 3);
  const inputs = new Array(parsed.nInputs);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    for (let k = 0; k < parsed.nInputs; k++) inputs[k] = t;
    const out = evaluateFunction(parsed.tintFn, inputs);
    if (!out) return { tintSamples: null, nComponents: 3 };
    const [r, g, b] = altCSToRGB(parsed.altCS, out);
    samples[i * 3] = r;
    samples[i * 3 + 1] = g;
    samples[i * 3 + 2] = b;
  }
  return { tintSamples: samples, nComponents: 3 };
}
