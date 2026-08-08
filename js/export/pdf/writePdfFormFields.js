import { extractPdfAnnotations } from '../../pdf/parsePdfAnnots.js';
import { layoutFieldValue } from '../../pdf/formFieldLayout.js';
import { applyStandardFontWidths } from '../../pdf/fonts/standardFontMetrics.js';

// Helvetica AFM advances (1000-em units) for centering comb characters in their cells, matching the viewer cover's per-cell text-align: center.
const helvWidths = new Map();
const helvDefaultWidth = applyStandardFontWidths('Helvetica', helvWidths) ?? 500;

/**
 * Skips one PDF value starting at `j` and returns the index just past it.
 * `j` must be at the value's first character, not leading whitespace.
 * @param {string} s
 * @param {number} j
 * @returns {number}
 */
function skipPdfValue(s, j) {
  const c = s[j];
  if (c === '(') {
    let depth = 0;
    for (let i = j; i < s.length; i++) {
      const ch = s[i];
      if (ch === '\\') { i++; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) return i + 1; }
    }
    return s.length;
  }
  if (c === '<' && s[j + 1] === '<') {
    let depth = 0;
    for (let i = j; i < s.length; i++) {
      const ch = s[i];
      if (ch === '(') { i = skipPdfValue(s, i) - 1; continue; }
      if (ch === '<' && s[i + 1] === '<') { depth++; i++; continue; }
      if (ch === '>' && s[i + 1] === '>') { depth--; i++; if (depth === 0) return i + 1; }
    }
    return s.length;
  }
  if (c === '<') {
    const end = s.indexOf('>', j);
    return end === -1 ? s.length : end + 1;
  }
  if (c === '[') {
    let depth = 0;
    for (let i = j; i < s.length; i++) {
      const ch = s[i];
      if (ch === '(') { i = skipPdfValue(s, i) - 1; continue; }
      if (ch === '<' && s[i + 1] === '<') { i = skipPdfValue(s, i) - 1; continue; }
      if (ch === '[') depth++;
      else if (ch === ']') { depth--; if (depth === 0) return i + 1; }
    }
    return s.length;
  }
  if (c === '/') {
    let i = j + 1;
    while (i < s.length && !/[\s()<>[\]{}/%]/.test(s[i])) i++;
    return i;
  }
  const refM = /^(\d+)\s+(\d+)\s+R(?![A-Za-z0-9])/.exec(s.slice(j));
  if (refM) return j + refM[0].length;
  let i = j;
  while (i < s.length && !/[\s()<>[\]{}/%]/.test(s[i])) i++;
  return i;
}

/**
 * Removes a top-level key (and its value) from a dictionary's text.
 * @param {string} dict - Object text whose outermost `<< ... >>` is the dictionary.
 * @param {string} key
 * @returns {string}
 */
function stripTopLevelKey(dict, key) {
  let depth = 0;
  for (let i = 0; i < dict.length; i++) {
    const c = dict[i];
    if (c === '(') { i = skipPdfValue(dict, i) - 1; continue; }
    if (c === '<' && dict[i + 1] === '<') { depth++; i++; continue; }
    if (c === '>' && dict[i + 1] === '>') { depth--; i++; continue; }
    if (c === '<') { i = skipPdfValue(dict, i) - 1; continue; }
    if (c === '/' && depth === 1 && dict.startsWith(key, i + 1) && !/[A-Za-z0-9]/.test(dict[i + 1 + key.length] || ' ')) {
      let j = i + 1 + key.length;
      while (j < dict.length && /\s/.test(dict[j])) j++;
      j = skipPdfValue(dict, j);
      return dict.slice(0, i) + dict.slice(j);
    }
  }
  return dict;
}

/**
 * Encodes a field value for /V.
 * Line breaks force the hex encoding because readers normalize any end-of-line inside a literal string to a single newline.
 * @param {string} value
 * @returns {string}
 */
function encodePdfTextString(value) {
  if (!/[^\x20-\xff]/.test(value) && !/[\r\n]/.test(value)) {
    return `(${value.replace(/[\\()]/g, (ch) => `\\${ch}`)})`;
  }
  let hex = 'FEFF';
  for (let i = 0; i < value.length; i++) hex += value.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  return `<${hex}>`;
}

/**
 * Builds the replacement and new PDF objects that write changed form-field values back into the source PDF.
 *
 * @param {Object} args
 * @param {import('../../pdf/objectCache.js').ObjectCache} args.objCache
 * @param {Array<{objNum: number, objText: string}>} args.pages
 * @param {number[]} args.pageIndices
 * @param {Array<?Annotation[]>} args.annotationsPages
 * @param {number} args.startingNextObjNum
 * @param {?number} args.catalogObjNum
 * @param {?function(string): void} [args.warningHandler]
 * @returns {{
 *   replacements: Map<number, string>,
 *   newObjects: Array<{objNum: number, content: string}>,
 *   catalogInsertRef: string,
 *   nextObjNum: number,
 * }}
 */
export function buildFormFieldUpdates({
  objCache, pages, pageIndices, annotationsPages, startingNextObjNum, catalogObjNum, warningHandler,
}) {
  /** @type {Map<number, string>} */
  const replacements = new Map();
  /** @type {Array<{objNum: number, content: string}>} */
  const newObjects = [];
  let nextObjNum = startingNextObjNum;
  let catalogInsertRef = '';

  /** @type {Array<AnnotationField & {srcRef: number}>} */
  const fieldRows = [];
  for (const i of pageIndices) {
    for (const a of annotationsPages[i] || []) {
      if (a.type === 'field' && a.srcRef != null) fieldRows.push(/** @type {AnnotationField & {srcRef: number}} */ (a));
    }
  }
  if (fieldRows.length === 0) {
    return {
      replacements, newObjects, catalogInsertRef, nextObjNum,
    };
  }

  /** @type {Map<number, import('../../pdf/parsePdfAnnots.js').PdfWidgetRaw>} */
  const rawByObjNum = new Map();
  for (const i of pageIndices) {
    const { widgets } = extractPdfAnnotations(objCache, pages[i].objText);
    for (const w of widgets) if (!rawByObjNum.has(w.objNum)) rawByObjNum.set(w.objNum, w);
  }

  let needAppearances = false;
  for (const row of fieldRows) {
    const raw = rawByObjNum.get(row.srcRef);
    if (!raw) continue;
    const isButton = raw.ft === 'Btn';
    const rowRaw = row.value == null || row.value === '' ? null : row.value;
    // A `.scribe` restore can put 'Off' in a row.
    // The parser normalizes it to null.
    const rowValue = isButton && rowRaw === 'Off' ? null : rowRaw;
    const rawValue = raw.value == null || raw.value === '' ? null : raw.value;
    if (rowValue === rawValue) continue;

    let srcText = objCache.getObjectText(row.srcRef);
    if (!srcText) continue;
    srcText = stripTopLevelKey(srcText, 'V');
    if (isButton) {
      srcText = stripTopLevelKey(srcText, 'AS');
    } else {
      srcText = stripTopLevelKey(srcText, 'AP');
    }

    const escName = (s) => s.replace(/[^\x21-\x7e]|[()<>[\]{}/%#]/g, (ch) => `#${(ch.charCodeAt(0) & 0xff).toString(16).padStart(2, '0').toUpperCase()}`);

    let vInsert = '';
    let insert = '';
    if (isButton) {
      // A radio kid's /AS must name one of its own /AP /N states, so a deselected one takes /Off rather than the group value in /V.
      const as = raw.onState != null ? (rowValue === raw.onState ? rowValue : 'Off') : (rowValue || 'Off');
      vInsert = ` /V /${escName(rowValue || 'Off')}`;
      insert = ` /AS /${escName(as)}`;
    } else if (rowValue == null) {
      const rectW = Math.abs(raw.rect[2] - raw.rect[0]);
      const rectH = Math.abs(raw.rect[3] - raw.rect[1]);
      const apObjNum = nextObjNum++;
      newObjects.push({
        objNum: apObjNum,
        content: `${apObjNum} 0 obj\n<</Type/XObject/Subtype/Form/FormType 1/BBox[0 0 ${rectW} ${rectH}]/Resources<</ProcSet[/PDF]>>/Length 0>>\nstream\n\nendstream\nendobj\n\n`,
      });
      insert = ` /AP <</N ${apObjNum} 0 R>>`;
    } else if ([...rowValue].some((c) => c.charCodeAt(0) > 0xff)) {
      // The Helvetica/WinAnsi appearance synthesis cannot encode this value.
      vInsert = ` /V ${encodePdfTextString(rowValue)}`;
      needAppearances = true;
    } else {
      const rectW = Math.abs(raw.rect[2] - raw.rect[0]);
      const rectH = Math.abs(raw.rect[3] - raw.rect[1]);
      const layout = layoutFieldValue(rowValue, rectW, rectH, {
        multiline: !!row.multiline, comb: !!row.comb, maxLen: row.maxLen ?? raw.maxLen, quadding: raw.quadding, da: raw.da,
      });
      const tfEnd = raw.da ? raw.da.lastIndexOf('Tf') : -1;
      const colorOps = tfEnd >= 0 ? raw.da.slice(tfEnd + 2).trim() : '0 g';
      const esc = (s) => s.replace(/[\\()]/g, (ch) => `\\${ch}`);
      let textCommands = '';
      const combN = row.comb ? (row.maxLen ?? raw.maxLen) : null;
      for (const ll of layout.lines) {
        if (combN > 0) {
          // One glyph per cell, advance-centered like the viewer cover's text-align: center.
          const cellW = rectW / combN;
          for (const wd of ll.words) {
            const start = Math.round(wd.x0 / cellW);
            for (let i = 0; i < wd.text.length; i++) {
              const chW = layout.fontSize * ((helvWidths.get(wd.text.charCodeAt(i)) ?? helvDefaultWidth) / 1000);
              const x = (start + i) * cellW + (cellW - chW) / 2;
              textCommands += `1 0 0 1 ${x.toFixed(2)} ${ll.y.toFixed(2)} Tm (${esc(wd.text[i])}) Tj `;
            }
          }
        } else {
          textCommands += `1 0 0 1 ${ll.x.toFixed(2)} ${ll.y.toFixed(2)} Tm (${esc(ll.text)}) Tj `;
        }
      }
      const stream = `/Tx BMC q 0 0 ${rectW} ${rectH} re W n BT /HsF ${layout.fontSize} Tf ${colorOps} ${textCommands.trim()} ET Q EMC`;
      const apObjNum = nextObjNum++;
      newObjects.push({
        objNum: apObjNum,
        content: `${apObjNum} 0 obj\n<</Type/XObject/Subtype/Form/FormType 1/BBox[0 0 ${rectW} ${rectH}]`
          + '/Resources<</Font<</HsF<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>>>/ProcSet[/PDF/Text]>>'
          + `/Length ${stream.length}>>\nstream\n${stream}\nendstream\nendobj\n\n`,
      });
      vInsert = ` /V ${encodePdfTextString(rowValue)}`;
      insert = ` /AP <</N ${apObjNum} 0 R>>`;
    }

    let vTarget = raw.valueRef ?? row.srcRef;
    if (vTarget !== row.srcRef) {
      const declSrc = objCache.getObjectText(vTarget);
      const declStripped = declSrc ? stripTopLevelKey(declSrc, 'V') : null;
      const declClose = declStripped ? declStripped.lastIndexOf('>>') : -1;
      if (declClose === -1) {
        vTarget = row.srcRef;
      } else {
        replacements.set(vTarget, `${vTarget} 0 obj\n${declStripped.slice(0, declClose)}${vInsert}${declStripped.slice(declClose)}\nendobj\n\n`);
      }
    }
    if (vTarget === row.srcRef) insert = vInsert + insert;

    const closeIdx = srcText.lastIndexOf('>>');
    if (closeIdx === -1) continue;
    const newBody = `${srcText.slice(0, closeIdx)}${insert}${srcText.slice(closeIdx)}`;
    replacements.set(row.srcRef, `${row.srcRef} 0 obj\n${newBody}\nendobj\n\n`);
  }

  if (replacements.size === 0 && newObjects.length === 0) {
    return {
      replacements, newObjects, catalogInsertRef, nextObjNum,
    };
  }

  // Some source PDFs have widget annotations but no /AcroForm, and conforming readers enumerate fields from /AcroForm/Fields.
  const catalogText = catalogObjNum != null ? objCache.getObjectText(catalogObjNum) : null;
  const acroRefM = catalogText ? /\/AcroForm\s+(\d+)\s+\d+\s+R/.exec(catalogText) : null;
  const acroInline = catalogText ? /\/AcroForm\s*<</.test(catalogText) : false;
  if (acroRefM) {
    if (needAppearances) {
      const acroNum = Number(acroRefM[1]);
      let acroText = objCache.getObjectText(acroNum);
      if (acroText) {
        acroText = stripTopLevelKey(acroText, 'NeedAppearances');
        const closeIdx = acroText.lastIndexOf('>>');
        if (closeIdx !== -1) {
          replacements.set(acroNum, `${acroNum} 0 obj\n${acroText.slice(0, closeIdx)} /NeedAppearances true${acroText.slice(closeIdx)}\nendobj\n\n`);
        }
      }
    }
  } else if (acroInline) {
    if (needAppearances && typeof warningHandler === 'function') {
      warningHandler('A filled value needs viewer-drawn appearances, but the catalog embeds /AcroForm inline; some viewers may show the previous appearance.');
    }
  } else if (catalogText) {
    const rootRefs = [...new Set([...rawByObjNum.values()].map((w) => w.rootRef))];
    const acroObjNum = nextObjNum++;
    newObjects.push({
      objNum: acroObjNum,
      content: `${acroObjNum} 0 obj\n<</Fields [${rootRefs.map((r) => `${r} 0 R`).join(' ')}]${needAppearances ? ' /NeedAppearances true' : ''}>>\nendobj\n\n`,
    });
    catalogInsertRef = ` /AcroForm ${acroObjNum} 0 R`;
  }

  return {
    replacements, newObjects, catalogInsertRef, nextObjNum,
  };
}
