import {
  findXrefOffset, parseXref, ObjectCache, extractDict,
  getPageContentStreams, tokenizeContentStream,
} from '../../pdf/parsePdfUtils.js';
import { getPageObjects, collectPageTreeObjNums } from '../../pdf/parsePdfDoc.js';
import { createPdfFontRefs, createEmbeddedFontType0 } from './writePdfFonts.js';
import { ocrPageToPDFStream } from './writePdfText.js';
import { buildHighlightAnnotObjects, consolidateAnnotations } from './writePdfAnnots.js';
import { encodeStreamObject } from './writePdfStreams.js';
import {
  parseTrailerInfo,
  buildIncrementalXrefAndTrailer,
  traceReferencedObjects,
  buildFullXrefAndTrailer,
  copyRawObjectBytes,
} from './pdfObjectGraph.js';

/**
 * Parse /Contents from a page dict, returning an array of indirect references.
 * @param {string} pageObjText
 */
function parseExistingContents(pageObjText) {
  const arrayMatch = /\/Contents\s*\[([\s\S]*?)\]/.exec(pageObjText);
  if (arrayMatch) {
    return [...arrayMatch[1].matchAll(/(\d+)\s+(\d+)\s+R/g)]
      .map((m) => `${m[1]} ${m[2]} R`);
  }
  const singleMatch = /\/Contents\s+(\d+)\s+(\d+)\s+R/.exec(pageObjText);
  if (singleMatch) {
    return [`${singleMatch[1]} ${singleMatch[2]} R`];
  }
  return [];
}

/**
 * Resolve the effective /Resources dictionary for a page.
 * Handles inline dicts, indirect references, and inherited resources.
 * @param {string} pageObjText
 * @param {ObjectCache} objCache
 */
function resolvePageResources(pageObjText, objCache) {
  const resIdx = pageObjText.indexOf('/Resources');
  if (resIdx >= 0) {
    const afterRes = pageObjText.substring(resIdx + '/Resources'.length).trimStart();
    if (afterRes.startsWith('<<')) {
      const dictStart = pageObjText.indexOf('<<', resIdx);
      return extractDict(pageObjText, dictStart);
    }
    const refMatch = /^(\d+)\s+\d+\s+R/.exec(afterRes);
    if (refMatch) {
      const resText = objCache.getObjectText(Number(refMatch[1]));
      if (resText) {
        const dictStart = resText.indexOf('<<');
        if (dictStart >= 0) return extractDict(resText, dictStart);
      }
    }
  }

  const parentMatch = /\/Parent\s+(\d+)\s+\d+\s+R/.exec(pageObjText);
  if (parentMatch) {
    const parentText = objCache.getObjectText(Number(parentMatch[1]));
    if (parentText) {
      return resolvePageResources(parentText, objCache);
    }
  }

  return '<<>>';
}

/**
 * Merge overlay font and ExtGState entries into an existing Resources dict.
 * @param {string} existingDict
 * @param {string} overlayFontsStr
 * @param {string} overlayExtGStateStr
 */
function mergeResources(existingDict, overlayFontsStr, overlayExtGStateStr) {
  let inner = existingDict.slice(2, -2).trim();

  // Merge /Font entries
  const fontIdx = inner.indexOf('/Font');
  if (fontIdx >= 0) {
    const dictStart = inner.indexOf('<<', fontIdx);
    if (dictStart >= 0) {
      const fontDict = extractDict(inner, dictStart);
      // Insert overlay entries before the closing >>
      const mergedFontDict = `${fontDict.slice(0, -2)} ${overlayFontsStr}>>`;
      inner = `${inner.slice(0, fontIdx)}/Font${inner.slice(fontIdx + '/Font'.length, fontIdx + '/Font'.length + (dictStart - fontIdx - '/Font'.length))}${mergedFontDict}${inner.slice(fontIdx + '/Font'.length + (dictStart - fontIdx - '/Font'.length) + fontDict.length)}`;
    }
  } else if (overlayFontsStr) {
    inner += ` /Font<<${overlayFontsStr}>>`;
  }

  // Merge /ExtGState entries
  const gsIdx = inner.indexOf('/ExtGState');
  if (gsIdx >= 0) {
    const dictStart = inner.indexOf('<<', gsIdx);
    if (dictStart >= 0) {
      const gsDict = extractDict(inner, dictStart);
      const mergedGsDict = `${gsDict.slice(0, -2)} ${overlayExtGStateStr}>>`;
      inner = `${inner.slice(0, gsIdx)}/ExtGState${inner.slice(gsIdx + '/ExtGState'.length, gsIdx + '/ExtGState'.length + (dictStart - gsIdx - '/ExtGState'.length))}${mergedGsDict}${inner.slice(gsIdx + '/ExtGState'.length + (dictStart - gsIdx - '/ExtGState'.length) + gsDict.length)}`;
    }
  } else if (overlayExtGStateStr) {
    inner += ` /ExtGState<<${overlayExtGStateStr}>>`;
  }

  return `<<${inner}>>`;
}

/**
 * Rebuild a /Page dict with overlay additions.
 *
 * @param {number} objNum
 * @param {string} originalObjText
 * @param {string[]|null} newContentsArray - New /Contents refs. If null,
 *   preserve the original /Contents (used for the annotation-only path
 *   where no overlay content stream is being added).
 * @param {number|null} resourcesObjNum - New /Resources object number. If
 *   null, preserve the original /Resources entry verbatim.
 * @param {number|null} [parentObjNum=null]
 * @param {string[]} [extraAnnotRefs=[]] - Additional `N 0 R` refs to
 *   append to the merged /Annots array.
 * @param {import('../../pdf/parsePdfUtils.js').ObjectCache|null} [objCache=null]
 *   Used to resolve an indirect /Annots array so source refs can be
 *   inlined alongside new user-added refs.
 */
function buildReplacementPageDict(objNum, originalObjText, newContentsArray, resourcesObjNum, parentObjNum = null, extraAnnotRefs = [], objCache = null) {
  let dictStr = `${objNum} 0 obj\n<<`;
  dictStr += '/Type/Page';

  // Copy or override /Parent
  if (parentObjNum !== null) {
    dictStr += `/Parent ${parentObjNum} 0 R`;
  } else {
    const parentMatch = /\/Parent\s+(\d+\s+\d+\s+R)/.exec(originalObjText);
    if (parentMatch) dictStr += `/Parent ${parentMatch[1]}`;
  }

  // Copy /MediaBox
  const mbMatch = /\/MediaBox\s*\[\s*([\d.+\-e\s]+)\s*\]/.exec(originalObjText);
  if (mbMatch) dictStr += `/MediaBox[${mbMatch[1].trim()}]`;

  // Copy /CropBox if present
  const cbMatch = /\/CropBox\s*\[\s*([\d.+\-e\s]+)\s*\]/.exec(originalObjText);
  if (cbMatch) dictStr += `/CropBox[${cbMatch[1].trim()}]`;

  // Copy /Rotate if present
  const rotMatch = /\/Rotate\s+(\d+)/.exec(originalObjText);
  if (rotMatch) dictStr += `/Rotate ${rotMatch[1]}`;

  // Merge source /Annots with extraAnnotRefs (new user-added highlights).
  // When no extras are supplied we emit the source array verbatim so
  // pass-through annotations (links, notes, form widgets) survive unchanged.
  const annotsIndirectMatch = /\/Annots\s+(\d+)\s+\d+\s+R/.exec(originalObjText);
  const annotsArrayMatch = /\/Annots\s*\[([\s\S]*?)\]/.exec(originalObjText);
  const sourceAnnotRefs = [];
  if (annotsIndirectMatch && objCache) {
    const arrayText = objCache.getObjectText(Number(annotsIndirectMatch[1]));
    if (arrayText) {
      for (const m of arrayText.matchAll(/(\d+\s+\d+\s+R)/g)) sourceAnnotRefs.push(m[1]);
    }
  } else if (annotsArrayMatch) {
    for (const m of annotsArrayMatch[1].matchAll(/(\d+\s+\d+\s+R)/g)) sourceAnnotRefs.push(m[1]);
  }
  if (extraAnnotRefs.length > 0 || sourceAnnotRefs.length > 0) {
    if (extraAnnotRefs.length === 0 && annotsIndirectMatch && !objCache) {
      dictStr += `/Annots ${annotsIndirectMatch[0].slice('/Annots'.length).trim()}`;
    } else {
      dictStr += `/Annots[${[...sourceAnnotRefs, ...extraAnnotRefs].join(' ')}]`;
    }
  }

  // Copy /StructParents if present
  const spMatch = /\/StructParents\s+(\d+)/.exec(originalObjText);
  if (spMatch) dictStr += `/StructParents ${spMatch[1]}`;

  // Copy /Tabs if present
  const tabsMatch = /\/Tabs\s*\/(\w+)/.exec(originalObjText);
  if (tabsMatch) dictStr += `/Tabs/${tabsMatch[1]}`;

  // Copy /UserUnit if present
  const uuMatch = /\/UserUnit\s+([\d.]+)/.exec(originalObjText);
  if (uuMatch) dictStr += `/UserUnit ${uuMatch[1]}`;

  // /Contents: new array or preserved original
  if (newContentsArray !== null) {
    dictStr += `/Contents[${newContentsArray.join(' ')}]`;
  } else {
    const contentsArrMatch = /\/Contents\s*\[([\s\S]*?)\]/.exec(originalObjText);
    const contentsRefMatch = /\/Contents\s+(\d+\s+\d+\s+R)/.exec(originalObjText);
    if (contentsArrMatch) dictStr += `/Contents[${contentsArrMatch[1].trim()}]`;
    else if (contentsRefMatch) dictStr += `/Contents ${contentsRefMatch[1]}`;
  }

  // /Resources: new reference or preserved original (ref or inline dict)
  if (resourcesObjNum !== null) {
    dictStr += `/Resources ${resourcesObjNum} 0 R`;
  } else {
    const resRefMatch = /\/Resources\s+(\d+\s+\d+\s+R)/.exec(originalObjText);
    if (resRefMatch) {
      dictStr += `/Resources ${resRefMatch[1]}`;
    } else {
      const resInlineMatch = /\/Resources\s*<</.exec(originalObjText);
      if (resInlineMatch) {
        const dictStart = resInlineMatch.index + resInlineMatch[0].length - 2;
        dictStr += `/Resources${extractDict(originalObjText, dictStart)}`;
      }
    }
  }

  dictStr += '>>\nendobj\n\n';
  return dictStr;
}

/**
 * Walk a page's content streams and collect the names actually invoked by
 * Tf (fonts), Do (xobjects), and gs (ext-gstate) operators.
 * Only these three operators are walked — other resource-name operators
 * (cs/CS/scn/SCN/sh/BMC/BDC) are context-sensitive and intentionally skipped.
 * @param {string} pageObjText
 * @param {ObjectCache} objCache
 */
function collectUsedResourceNames(pageObjText, objCache) {
  const usedFonts = new Set();
  const usedXObjects = new Set();
  const usedExtGStates = new Set();

  const streams = getPageContentStreams(pageObjText, objCache);
  if (!streams) return { usedFonts, usedXObjects, usedExtGStates };

  for (const streamText of streams) {
    const tokens = tokenizeContentStream(streamText);
    let lastName = null;
    for (const tok of tokens) {
      if (tok.type === 'name') {
        lastName = tok.value;
        continue;
      }
      if (tok.type === 'operator') {
        if (lastName !== null) {
          if (tok.value === 'Tf') usedFonts.add(lastName);
          else if (tok.value === 'Do') usedXObjects.add(lastName);
          else if (tok.value === 'gs') usedExtGStates.add(lastName);
        }
        lastName = null;
        continue;
      }
      if (tok.type === 'number') continue;
      lastName = null;
    }
  }

  return { usedFonts, usedXObjects, usedExtGStates };
}

/**
 * Parse the top-level name→value entries of a PDF dict body.
 * @param {string} dictBody - The inner text of a dict (no outer << >>)
 */
function parseDictEntries(dictBody) {
  const entries = [];
  const len = dictBody.length;
  let i = 0;

  while (i < len) {
    while (i < len && /\s/.test(dictBody[i])) i++;
    if (i >= len) break;
    if (dictBody[i] !== '/') { i++; continue; }
    i++;
    let name = '';
    while (i < len && !/[\s/<>[\](){}%]/.test(dictBody[i])) { name += dictBody[i]; i++; }
    while (i < len && /\s/.test(dictBody[i])) i++;
    if (i >= len) break;

    const valueStart = i;
    const ch = dictBody[i];
    if (ch === '<' && dictBody[i + 1] === '<') {
      const sub = extractDict(dictBody, i);
      i += sub.length;
    } else if (ch === '[') {
      let depth = 1; i++;
      while (i < len && depth > 0) {
        if (dictBody[i] === '[') depth++;
        else if (dictBody[i] === ']') depth--;
        i++;
      }
    } else if (ch === '(') {
      let depth = 1; i++;
      while (i < len && depth > 0) {
        if (dictBody[i] === '\\') { i += 2; continue; }
        if (dictBody[i] === '(') depth++;
        else if (dictBody[i] === ')') depth--;
        i++;
      }
    } else if (ch === '<') {
      while (i < len && dictBody[i] !== '>') i++;
      if (i < len) i++;
    } else if (ch === '/') {
      i++;
      while (i < len && !/[\s/<>[\](){}%]/.test(dictBody[i])) i++;
    } else {
      const indirectMatch = /^(\d+)\s+(\d+)\s+R/.exec(dictBody.slice(i));
      if (indirectMatch) {
        i += indirectMatch[0].length;
      } else {
        while (i < len && !/[\s/<>[\]]/.test(dictBody[i])) i++;
      }
    }
    entries.push({ name, valueText: dictBody.slice(valueStart, i) });
  }

  return entries;
}

/**
 * Resolve a /Subtype subdict inside a resources dict — returns its inner body
 * (between << and >>). Handles both inline `/Font <<...>>` and indirect
 * `/Font N M R`. Returns null if the subdict is missing or malformed.
 * @param {string} resourcesDictBody
 * @param {string} key
 * @param {ObjectCache} objCache
 */
function locateResourceSubdict(resourcesDictBody, key, objCache) {
  const keyIdx = resourcesDictBody.indexOf(key);
  if (keyIdx < 0) return null;
  let i = keyIdx + key.length;
  while (i < resourcesDictBody.length && /\s/.test(resourcesDictBody[i])) i++;

  if (resourcesDictBody[i] === '<' && resourcesDictBody[i + 1] === '<') {
    const full = extractDict(resourcesDictBody, i);
    return {
      body: full.slice(2, -2),
      original: resourcesDictBody.slice(keyIdx, i + full.length),
      startInBody: keyIdx,
      endInBody: i + full.length,
    };
  }
  const refMatch = /^(\d+)\s+\d+\s+R/.exec(resourcesDictBody.slice(i));
  if (refMatch) {
    const refObjNum = Number(refMatch[1]);
    const refText = objCache.getObjectText(refObjNum);
    if (!refText) return null;
    const dictStart = refText.indexOf('<<');
    if (dictStart < 0) return null;
    const full = extractDict(refText, dictStart);
    return {
      body: full.slice(2, -2),
      original: resourcesDictBody.slice(keyIdx, i + refMatch[0].length),
      startInBody: keyIdx,
      endInBody: i + refMatch[0].length,
    };
  }
  return null;
}

/**
 * Given a /Resources dict text (full, with outer << >>) and sets of names
 * actually used by a page's content streams, return a new /Resources dict
 * where /Font, /XObject, and /ExtGState entries are pruned to only the used
 * names. Other subdicts pass through unchanged.
 * @param {string} resourcesDictText - Full /Resources dict including outer << >>
 * @param {{usedFonts: Set<string>, usedXObjects: Set<string>, usedExtGStates: Set<string>}} used
 * @param {ObjectCache} objCache
 */
function pruneResourcesDict(resourcesDictText, used, objCache) {
  if (!resourcesDictText.startsWith('<<') || !resourcesDictText.endsWith('>>')) {
    return resourcesDictText;
  }
  let body = resourcesDictText.slice(2, -2);

  /** @type {(key: string, usedSet: Set<string>) => void} */
  const pruneOne = (key, usedSet) => {
    const loc = locateResourceSubdict(body, key, objCache);
    if (!loc) return;
    const entries = parseDictEntries(loc.body);
    const kept = entries.filter((e) => usedSet.has(e.name));
    let replacement;
    if (kept.length === 0) {
      replacement = '';
    } else {
      const inner = kept.map((e) => `/${e.name} ${e.valueText}`).join(' ');
      replacement = `${key}<<${inner}>>`;
    }
    body = body.slice(0, loc.startInBody) + replacement + body.slice(loc.endInBody);
  };

  pruneOne('/Font', used.usedFonts);
  pruneOne('/XObject', used.usedXObjects);
  pruneOne('/ExtGState', used.usedExtGStates);

  return `<<${body}>>`;
}

/**
 * Replace the page dict's /Resources entry with the given inline dict text.
 * Handles inline, indirect, and absent /Resources forms.
 * @param {string} pageObjText
 * @param {string} newResourcesDictText
 */
function replacePageResources(pageObjText, newResourcesDictText) {
  const resIdx = pageObjText.indexOf('/Resources');
  if (resIdx < 0) {
    const insertPos = pageObjText.lastIndexOf('>>');
    if (insertPos < 0) return pageObjText;
    return `${pageObjText.slice(0, insertPos)}/Resources ${newResourcesDictText}${pageObjText.slice(insertPos)}`;
  }
  let afterKey = resIdx + '/Resources'.length;
  while (afterKey < pageObjText.length && /\s/.test(pageObjText[afterKey])) afterKey++;
  if (pageObjText[afterKey] === '<' && pageObjText[afterKey + 1] === '<') {
    const full = extractDict(pageObjText, afterKey);
    return `${pageObjText.slice(0, resIdx)}/Resources ${newResourcesDictText}${pageObjText.slice(afterKey + full.length)}`;
  }
  const refMatch = /^(\d+)\s+(\d+)\s+R/.exec(pageObjText.slice(afterKey));
  if (refMatch) {
    return `${pageObjText.slice(0, resIdx)}/Resources ${newResourcesDictText}${pageObjText.slice(afterKey + refMatch[0].length)}`;
  }
  return pageObjText;
}

/**
 * Rebuild a PDF containing only the selected pages, optionally with OCR
 * overlay text. Used instead of incremental update when exporting a proper
 * subset of pages. Unreferenced objects are excluded to reduce file size.
 * @param {Object} params
 * @param {Uint8Array} params.pdfBytes
 * @param {string} params.text
 * @param {ObjectCache} params.objCache
 * @param {Object} params.xrefEntries
 * @param {any[]} params.pages
 * @param {number[]} params.pageIndices
 * @param {number} params.startingNextObjNum
 * @param {any[]} [params.ocrArr]
 * @param {any[]} [params.pageMetricsArr]
 * @param {*} [params.pdfFonts]
 * @param {string} [params.textMode]
 * @param {boolean} [params.rotateText]
 * @param {boolean} [params.rotateBackground]
 * @param {number} [params.confThreshHigh]
 * @param {number} [params.confThreshMed]
 * @param {number} [params.proofOpacity]
 * @param {boolean} [params.humanReadable=false]
 * @param {Array<Array<AnnotationHighlight>>} [params.annotationsPages=[]]
 */
async function rebuildPdfSubset({
  pdfBytes, text, objCache, xrefEntries, pages,
  pageIndices, startingNextObjNum,
  ocrArr, pageMetricsArr, pdfFonts,
  textMode, rotateText, rotateBackground,
  confThreshHigh, confThreshMed, proofOpacity,
  humanReadable = false,
  annotationsPages = [],
}) {
  const overlayEnabled = !!(ocrArr && pageMetricsArr && pdfFonts);
  let nextObjNum = startingNextObjNum;

  const { pageTreeObjNums } = collectPageTreeObjNums(objCache);

  // Assign new object numbers for catalog and pages root
  const catalogObjNum = nextObjNum++;
  const pagesRootObjNum = nextObjNum++;

  /** @type {Set<PdfFontInfo>} */
  const pdfFontsUsed = new Set();

  /** @type {Array<{objNum: number, content: string | Uint8Array | import('./writePdfStreams.js').PdfBinaryObject}>} */
  const allOutputObjects = [];

  /** @type {Set<number>} */
  const modifiedPageObjNums = new Set();

  // Generate overlay content for each kept page that has OCR data (only if overlay enabled)
  if (overlayEnabled) {
    for (const i of pageIndices) {
      if (i >= pages.length) continue;

      const pageInfo = pages[i];
      const pageObj = ocrArr?.[i];
      const pixelDims = pageMetricsArr[i].dims;
      const pageAnnotations = annotationsPages[i] || [];

      const baseWidth = pageInfo.mediaBox[2] - pageInfo.mediaBox[0];
      const baseHeight = pageInfo.mediaBox[3] - pageInfo.mediaBox[1];
      const scaleX = pixelDims ? baseWidth / pixelDims.width : 1;
      const scaleY = pixelDims ? baseHeight / pixelDims.height : 1;
      const tx = pageInfo.mediaBox[0];
      const ty = pageInfo.mediaBox[1];

      let textContentObjStr = '';
      /** @type {Set<PdfFontInfo>} */
      let pageFontsUsed = new Set();
      if (pageObj && pageObj.lines.length > 0) {
        const angle = pageMetricsArr[i].angle || 0;
        const res = ocrPageToPDFStream(
          pageObj, pixelDims, pdfFonts, /** @type {'ebook'|'eval'|'proof'|'invis'} */ (textMode), angle,
          rotateText, rotateBackground, confThreshHigh, confThreshMed,
        );
        textContentObjStr = res.textContentObjStr || '';
        pageFontsUsed = res.pdfFontsUsed;
      }

      const hasText = textContentObjStr && textContentObjStr.length > 0;
      const hasAnnots = pageAnnotations.length > 0;
      if (!hasText && !hasAnnots) continue;

      /** @type {string[]|null} */
      let newContentsArray = null;
      /** @type {number|null} */
      let resourcesObjNum = null;

      if (hasText) {
        for (const font of pageFontsUsed) pdfFontsUsed.add(font);

        const qSaveStr = 'q\n';
        const qSaveObjNum = nextObjNum++;
        allOutputObjects.push({ objNum: qSaveObjNum, content: `${qSaveObjNum} 0 obj\n<</Length ${qSaveStr.length}>>\nstream\n${qSaveStr}endstream\nendobj\n\n` });

        const qOverlayStr = `Q\nq ${scaleX} 0 0 ${scaleY} ${tx} ${ty} cm\n${textContentObjStr}Q\n`;
        const qOverlayObjNum = nextObjNum++;
        allOutputObjects.push({ objNum: qOverlayObjNum, content: await encodeStreamObject(qOverlayObjNum, qOverlayStr, { humanReadable }) });

        const existingContentsRefs = parseExistingContents(pageInfo.objText);
        newContentsArray = [
          `${qSaveObjNum} 0 R`,
          ...existingContentsRefs,
          `${qOverlayObjNum} 0 R`,
        ];

        const existingResourcesStr = resolvePageResources(pageInfo.objText, objCache);
        let overlayFontsStr = '';
        for (const font of pageFontsUsed) {
          overlayFontsStr += `${font.name} ${font.objN} 0 R\n`;
        }
        const overlayExtGStateStr = `/GSO0 <</ca 0.0>>/GSO1 <</ca ${proofOpacity}>>`;
        const mergedResourcesStr = mergeResources(existingResourcesStr, overlayFontsStr, overlayExtGStateStr);

        resourcesObjNum = nextObjNum++;
        allOutputObjects.push({ objNum: resourcesObjNum, content: `${resourcesObjNum} 0 obj\n${mergedResourcesStr}\nendobj\n\n` });
      }

      /** @type {string[]} */
      let extraAnnotRefs = [];
      if (hasAnnots) {
        const consolidated = consolidateAnnotations(pageAnnotations, pageObj);
        const pageForEmit = consolidated.length > 0 ? consolidated : pageAnnotations;
        const transformed = pageForEmit.map((a) => overlayAnnotationBbox(a, scaleX, scaleY, tx, ty));
        const outputDims = { width: baseWidth, height: baseHeight };
        const { objectTexts, annotRefs } = buildHighlightAnnotObjects(transformed, nextObjNum, outputDims);
        for (const t of objectTexts) allOutputObjects.push({ objNum: nextObjNum++, content: t });
        extraAnnotRefs = annotRefs;
      }

      const newPageObj = buildReplacementPageDict(pageInfo.objNum, pageInfo.objText, newContentsArray, resourcesObjNum, pagesRootObjNum, extraAnnotRefs, objCache);
      allOutputObjects.push({ objNum: pageInfo.objNum, content: newPageObj });
      modifiedPageObjNums.add(pageInfo.objNum);
    }

    for (const pdfFont of pdfFontsUsed) {
      if (pdfFont.opentype?.names?.postScriptName?.en === 'NotoSansSC-Regular') continue;
      // eslint-disable-next-line no-await-in-loop
      const objStrArr = await createEmbeddedFontType0({ font: pdfFont.opentype, firstObjIndex: pdfFont.objN, humanReadable });
      for (let j = 0; j < objStrArr.length; j++) {
        allOutputObjects.push({ objNum: pdfFont.objN + j, content: objStrArr[j] });
      }
    }
  }

  /** @type {Map<number, string>} */
  const rewrittenPageTexts = new Map();
  for (const i of pageIndices) {
    if (i >= pages.length) continue;
    const pageInfo = pages[i];
    if (modifiedPageObjNums.has(pageInfo.objNum)) continue;

    let pageText = pageInfo.objText;

    if (/\/Parent\s+\d+\s+\d+\s+R/.test(pageText)) {
      pageText = pageText.replace(/\/Parent\s+\d+\s+\d+\s+R/, `/Parent ${pagesRootObjNum} 0 R`);
    }

    const resolvedRes = resolvePageResources(pageInfo.objText, objCache);
    const used = collectUsedResourceNames(pageInfo.objText, objCache);
    const prunedRes = pruneResourcesDict(resolvedRes, used, objCache);
    pageText = replacePageResources(pageText, prunedRes);

    rewrittenPageTexts.set(pageInfo.objNum, pageText);
    allOutputObjects.push({ objNum: pageInfo.objNum, content: `${pageInfo.objNum} 0 obj\n${pageText}\nendobj\n\n` });
  }

  const tracingTexts = [];
  for (const i of pageIndices) {
    if (i >= pages.length) continue;
    const rewritten = rewrittenPageTexts.get(pages[i].objNum);
    tracingTexts.push(rewritten || pages[i].objText);
  }
  const referencedObjNums = traceReferencedObjects(tracingTexts, objCache, pageTreeObjNums);

  for (const i of pageIndices) {
    if (i >= pages.length) continue;
    referencedObjNums.delete(pages[i].objNum);
  }
  for (const obj of allOutputObjects) {
    referencedObjNums.delete(obj.objNum);
  }

  for (const objNum of referencedObjNums) {
    const entry = xrefEntries[objNum];
    if (!entry) continue;

    if (entry.type === 1) {
      const rawCopy = copyRawObjectBytes(pdfBytes, text, objCache, entry);
      if (!rawCopy) continue;
      allOutputObjects.push({ objNum, content: rawCopy });
    } else if (entry.type === 2) {
      // ObjStm object: write as standalone
      // eslint-disable-next-line no-await-in-loop
      const objText = objCache.getObjectText(objNum);
      if (!objText) continue;
      allOutputObjects.push({ objNum, content: `${objNum} 0 obj\n${objText}\nendobj\n\n` });
    }
  }

  const keptPageRefs = [];
  for (const i of pageIndices) {
    if (i >= pages.length) continue;
    keptPageRefs.push(`${pages[i].objNum} 0 R`);
  }

  allOutputObjects.push({ objNum: catalogObjNum, content: `${catalogObjNum} 0 obj\n<</Type/Catalog/Pages ${pagesRootObjNum} 0 R>>\nendobj\n\n` });
  allOutputObjects.push({ objNum: pagesRootObjNum, content: `${pagesRootObjNum} 0 obj\n<</Type/Pages/Kids[${keptPageRefs.join(' ')}]/Count ${keptPageRefs.length}>>\nendobj\n\n` });

  // Build the new PDF
  const pdfHeader = '%PDF-1.7\n';
  /** @type {(string | Uint8Array)[]} */
  const parts = [pdfHeader];
  let byteLen = pdfHeader.length;

  const xrefEntryList = [];

  for (const obj of allOutputObjects) {
    xrefEntryList.push({ objNum: obj.objNum, offset: byteLen });
    const c = obj.content;
    if (typeof c === 'string') {
      parts.push(c);
      byteLen += c.length;
    } else if (c instanceof Uint8Array) {
      // Raw byte copy of original PDF object
      parts.push(c);
      byteLen += c.length;
    } else {
      // PdfBinaryObject: header + streamData + trailer
      parts.push(c.header);
      byteLen += c.header.length;
      parts.push(c.streamData);
      byteLen += c.streamData.length;
      parts.push(c.trailer);
      byteLen += c.trailer.length;
    }
  }

  const newXrefOffset = byteLen;
  const totalSize = Math.max(nextObjNum, ...allOutputObjects.map((o) => o.objNum + 1));
  const xrefStr = buildFullXrefAndTrailer(xrefEntryList, totalSize, `${catalogObjNum} 0 R`, newXrefOffset);
  parts.push(xrefStr);
  byteLen += xrefStr.length;

  // Concatenate all parts into a single byte array
  const result = new Uint8Array(byteLen);
  let writeOffset = 0;
  for (const part of parts) {
    if (typeof part === 'string') {
      for (let ci = 0; ci < part.length; ci++) {
        result[writeOffset++] = part.charCodeAt(ci);
      }
    } else {
      result.set(part, writeOffset);
      writeOffset += part.length;
    }
  }

  return result.buffer;
}

/**
 * Produce a new PDF containing only the specified pages of the input PDF.
 *
 * @param {ArrayBuffer | Uint8Array} basePdfData
 * @param {number[]} pageIndices
 */
export async function subsetPdf(basePdfData, pageIndices) {
  const pdfBytes = basePdfData instanceof Uint8Array ? basePdfData : new Uint8Array(basePdfData);
  const text = new TextDecoder('latin1').decode(pdfBytes);

  const xrefOffset = findXrefOffset(pdfBytes);
  const xrefEntries = parseXref(pdfBytes, xrefOffset);
  const objCache = new ObjectCache(pdfBytes, xrefEntries);
  const pages = getPageObjects(objCache);

  if (pageIndices.length === 0) throw new Error('subsetPdf: pageIndices is empty');
  for (const i of pageIndices) {
    if (!Number.isInteger(i) || i < 0 || i >= pages.length) {
      throw new RangeError(`subsetPdf: page ${i} out of range (0-${pages.length - 1})`);
    }
  }

  const startingNextObjNum = Math.max(...Object.keys(xrefEntries).map(Number)) + 1;

  return rebuildPdfSubset({
    pdfBytes,
    text,
    objCache,
    xrefEntries,
    pages,
    pageIndices,
    startingNextObjNum,
  });
}

/**
 * Transform a pixel-space AnnotationHighlight bbox into the coordinate frame the overlay's page uses.
 *
 * @param {AnnotationHighlight} annot
 * @param {number} scaleX
 * @param {number} scaleY
 * @param {number} tx
 * @param {number} ty
 * @returns {AnnotationHighlight}
 */
function overlayAnnotationBbox(annot, scaleX, scaleY, tx, ty) {
  const transformBbox = (b) => ({
    left: b.left * scaleX + tx,
    right: b.right * scaleX + tx,
    top: b.top * scaleY - ty,
    bottom: b.bottom * scaleY - ty,
  });
  const out = {
    ...annot,
    bbox: transformBbox(annot.bbox),
  };
  if (annot.quads) out.quads = annot.quads.map(transformBbox);
  return out;
}

/**
 * Insert OCR text layers into an existing PDF via incremental update, or
 * rebuild with a subset/reordering of pages when `pageArr` demands it.
 * In incremental mode the original PDF bytes are not modified; new objects
 * are appended after %%EOF.
 *
 * @param {Object} params
 * @param {ArrayBuffer} params.basePdfData - The original PDF bytes
 * @param {Array<OcrPage>} params.ocrArr - OCR data for each page (indexed to match `basePdfData`)
 * @param {Array<PageMetrics>} params.pageMetricsArr - Page metrics (dims in pixels)
 * @param {?Array<number>} [params.pageArr=null] - 0-based page indices into `basePdfData` to include. Defaults to all pages.
 * @param {("ebook"|"eval"|"proof"|"invis"|"annot")} [params.textMode="invis"]
 * @param {boolean} [params.rotateText=true]
 * @param {boolean} [params.rotateBackground=false]
 * @param {number} [params.confThreshHigh=85]
 * @param {number} [params.confThreshMed=75]
 * @param {number} [params.proofOpacity=0.8]
 * @param {boolean} [params.humanReadable=false]
 * @param {Array<Array<AnnotationHighlight>>} [params.annotationsPages=[]] - Per-page annotation arrays
 * @returns {Promise<ArrayBuffer>}
 */
export async function overlayPdfText({
  basePdfData,
  ocrArr,
  pageMetricsArr,
  pageArr = null,
  textMode = 'invis',
  rotateText = true,
  rotateBackground = false,
  confThreshHigh = 85,
  confThreshMed = 75,
  proofOpacity = 0.8,
  humanReadable = false,
  annotationsPages = [],
}) {
  const pdfBytes = new Uint8Array(basePdfData);
  // Local latin1 view used by overlayPdfText's downstream helpers.
  const text = new TextDecoder('latin1').decode(pdfBytes);

  // Step 1: Parse the base PDF structure
  const xrefOffset = findXrefOffset(pdfBytes);
  const xrefEntries = parseXref(pdfBytes, xrefOffset);
  const objCache = new ObjectCache(pdfBytes, xrefEntries);
  const pages = getPageObjects(objCache);
  const { rootRef } = parseTrailerInfo(text, xrefOffset);

  // Default to all pages in the source PDF when pageArr is not supplied.
  const effectivePageArr = pageArr
    ? pageArr.filter((i) => i >= 0 && i < pages.length)
    : Array.from({ length: pages.length }, (_, i) => i);

  // Step 2: Determine next available object number
  let nextObjNum = Math.max(...Object.keys(xrefEntries).map(Number)) + 1;

  // Step 3: Create font references starting at nextObjNum
  const fontRefs = await createPdfFontRefs(nextObjNum, ocrArr);
  const { pdfFonts } = fontRefs;
  nextObjNum = fontRefs.objectI;

  // If exporting a proper subset of pages (fewer pages than the source, or
  // a reordering), rebuild the PDF instead of incremental update. Incremental
  // can only extend existing pages in place — it can't drop or reorder them.
  const isSubset = effectivePageArr.length !== pages.length
    || effectivePageArr.some((v, idx) => v !== idx);
  if (isSubset) {
    return rebuildPdfSubset({
      pdfBytes,
      text,
      objCache,
      xrefEntries,
      pages,
      pageIndices: effectivePageArr,
      ocrArr,
      pageMetricsArr,
      textMode,
      rotateText,
      rotateBackground,
      confThreshHigh,
      confThreshMed,
      proofOpacity,
      pdfFonts,
      startingNextObjNum: nextObjNum,
      humanReadable,
      annotationsPages,
    });
  }

  /** @type {Set<PdfFontInfo>} */
  const pdfFontsUsed = new Set();

  // All new objects to append (font objects are added later)
  /** @type {Array<{objNum: number, content: string}>} */
  const newObjects = [];

  // Step 4: For each page, generate text content and build modified objects
  for (const i of effectivePageArr) {
    const pageInfo = pages[i];
    const pageObj = ocrArr?.[i];
    const pixelDims = pageMetricsArr[i].dims;
    const pageAnnotations = annotationsPages[i] || [];

    const baseWidth = pageInfo.mediaBox[2] - pageInfo.mediaBox[0];
    const baseHeight = pageInfo.mediaBox[3] - pageInfo.mediaBox[1];
    const scaleX = pixelDims ? baseWidth / pixelDims.width : 1;
    const scaleY = pixelDims ? baseHeight / pixelDims.height : 1;
    const tx = pageInfo.mediaBox[0];
    const ty = pageInfo.mediaBox[1];

    let textContentObjStr = '';
    /** @type {Set<PdfFontInfo>} */
    let pageFontsUsed = new Set();
    if (pageObj && pageObj.lines.length > 0) {
      const angle = pageMetricsArr[i].angle || 0;
      const res = ocrPageToPDFStream(
        pageObj, pixelDims, pdfFonts, textMode, angle,
        rotateText, rotateBackground, confThreshHigh, confThreshMed,
      );
      textContentObjStr = res.textContentObjStr || '';
      pageFontsUsed = res.pdfFontsUsed;
    }

    const hasText = textContentObjStr && textContentObjStr.length > 0;
    const hasAnnots = pageAnnotations.length > 0;
    if (!hasText && !hasAnnots) continue;

    /** @type {string[]|null} */
    let newContentsArray = null;
    /** @type {number|null} */
    let resourcesObjNum = null;

    if (hasText) {
      for (const font of pageFontsUsed) pdfFontsUsed.add(font);

      const qSaveStr = 'q\n';
      const qSaveObjNum = nextObjNum++;
      newObjects.push({ objNum: qSaveObjNum, content: `${qSaveObjNum} 0 obj\n<</Length ${qSaveStr.length}>>\nstream\n${qSaveStr}endstream\nendobj\n\n` });

      const qOverlayStr = `Q\nq ${scaleX} 0 0 ${scaleY} ${tx} ${ty} cm\n${textContentObjStr}Q\n`;
      const qOverlayObjNum = nextObjNum++;
      newObjects.push({ objNum: qOverlayObjNum, content: await encodeStreamObject(qOverlayObjNum, qOverlayStr, { humanReadable }) });

      const existingContentsRefs = parseExistingContents(pageInfo.objText);
      newContentsArray = [
        `${qSaveObjNum} 0 R`,
        ...existingContentsRefs,
        `${qOverlayObjNum} 0 R`,
      ];

      // Merge overlay fonts + ExtGState into the page's /Resources.
      const existingResourcesStr = resolvePageResources(pageInfo.objText, objCache);
      let overlayFontsStr = '';
      for (const font of pageFontsUsed) {
        overlayFontsStr += `${font.name} ${font.objN} 0 R\n`;
      }
      const overlayExtGStateStr = `/GSO0 <</ca 0.0>>/GSO1 <</ca ${proofOpacity}>>`;
      const mergedResourcesStr = mergeResources(existingResourcesStr, overlayFontsStr, overlayExtGStateStr);

      resourcesObjNum = nextObjNum++;
      newObjects.push({ objNum: resourcesObjNum, content: `${resourcesObjNum} 0 obj\n${mergedResourcesStr}\nendobj\n\n` });
    }

    /** @type {string[]} */
    let extraAnnotRefs = [];
    if (hasAnnots) {
      const consolidated = consolidateAnnotations(pageAnnotations, pageObj);
      const pageForEmit = consolidated.length > 0 ? consolidated : pageAnnotations;
      const transformed = pageForEmit.map((a) => overlayAnnotationBbox(a, scaleX, scaleY, tx, ty));
      const outputDims = { width: baseWidth, height: baseHeight };
      const { objectTexts, annotRefs } = buildHighlightAnnotObjects(transformed, nextObjNum, outputDims);
      for (const t of objectTexts) newObjects.push({ objNum: nextObjNum++, content: t });
      extraAnnotRefs = annotRefs;
    }

    const newPageObj = buildReplacementPageDict(pageInfo.objNum, pageInfo.objText, newContentsArray, resourcesObjNum, null, extraAnnotRefs, objCache);
    newObjects.push({ objNum: pageInfo.objNum, content: newPageObj });
  }

  // Step 5: Create font objects for fonts that are actually used
  /** @type {Array<{objNum: number, content: string | import('./writePdfStreams.js').PdfBinaryObject}>} */
  const fontObjects = [];
  for (const pdfFont of pdfFontsUsed) {
    if (pdfFont.opentype?.names?.postScriptName?.en === 'NotoSansSC-Regular') continue;
    const objStrArr = await createEmbeddedFontType0({ font: pdfFont.opentype, firstObjIndex: pdfFont.objN, humanReadable });
    for (let j = 0; j < objStrArr.length; j++) {
      fontObjects.push({ objNum: pdfFont.objN + j, content: objStrArr[j] });
    }
  }

  // Step 6: Build incremental update
  const allNewObjects = [...fontObjects, ...newObjects];

  if (allNewObjects.length === 0) return basePdfData;

  /** @type {(string | Uint8Array)[]} */
  const appendParts = [];
  let appendByteLen = 0;
  appendParts.push('\n');
  appendByteLen += 1;

  const newXrefEntries = [];

  for (const obj of allNewObjects) {
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
  const totalSize = Math.max(nextObjNum, ...allNewObjects.map((o) => o.objNum + 1));

  const trailerStr = buildIncrementalXrefAndTrailer(newXrefEntries, totalSize, xrefOffset, rootRef, newXrefOffset);
  appendParts.push(trailerStr);
  appendByteLen += trailerStr.length;

  const result = new Uint8Array(pdfBytes.length + appendByteLen);
  result.set(pdfBytes);
  let offset = pdfBytes.length;
  for (const part of appendParts) {
    if (typeof part === 'string') {
      for (let i = 0; i < part.length; i++) {
        result[offset++] = part.charCodeAt(i);
      }
    } else {
      result.set(part, offset);
      offset += part.length;
    }
  }

  return result.buffer;
}
