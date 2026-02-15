import ocr from '../objects/ocrObjects.js';

import { calcBboxUnion } from '../utils/miscUtils.js';
import { LayoutDataTablePage } from '../objects/layoutObjects.js';
import { pass3, splitUnicodeSuperscripts } from './convertPageShared.js';

const debugMode = false;

/**
 * @param {Object} params
 * @param {string} params.ocrStr
 * @param {dims[]} params.pageDims - Page metrics to use for the pages
 */
export async function convertDocGoogleDocAI({ ocrStr, pageDims }) {
  let ocrData;
  try {
    ocrData = JSON.parse(ocrStr);
  } catch (error) {
    throw new Error('Failed to parse Google Document AI JSON data.');
  }

  if (!ocrData.pages || ocrData.pages.length === 0) {
    throw new Error('Invalid Google Document AI format: missing pages data.');
  }

  const fullText = ocrData.text || '';

  const resArr = [];

  for (let n = 0; n < ocrData.pages.length; n++) {
    const pageData = ocrData.pages[n];
    const pageDimsN = pageDims[n];

    const pageWidth = pageData.dimension?.width;
    const pageHeight = pageData.dimension?.height;

    if (!pageWidth || !pageHeight) {
      throw new Error(`Failed to parse page dimensions for page ${n}.`);
    }

    const scaleX = pageDimsN ? pageDimsN.width / pageWidth : 1;
    const scaleY = pageDimsN ? pageDimsN.height / pageHeight : 1;

    const pageDimsOut = pageDimsN || { width: pageWidth, height: pageHeight };

    const pageObj = new ocr.OcrPage(n, pageDimsOut);
    pageObj.textSource = 'google_doc_ai';

    const pageTokens = pageData.tokens;
    const pageLines = pageData.lines;

    if (!pageTokens || pageTokens.length === 0 || !pageLines || pageLines.length === 0) {
      resArr.push({
        pageObj,
        charMetricsObj: {},
        dataTables: new LayoutDataTablePage(n),
        warn: { char: 'char_error' },
      });
      continue;
    }

    const lineSegments = pageLines.map((line) => {
      const seg = line.layout?.textAnchor?.textSegments?.[0];
      return {
        startIndex: parseInt(seg?.startIndex || '0', 10),
        endIndex: parseInt(seg?.endIndex || '0', 10),
        line,
      };
    });

    const lineTextRanges = [];

    // Assign tokens to lines based on text segment overlap
    for (let i = 0; i < lineSegments.length; i++) {
      const lineSeg = lineSegments[i];
      const lineLayout = lineSeg.line.layout;

      const lineVertices = getScaledVertices(lineLayout.boundingPoly, pageWidth, pageHeight, scaleX, scaleY);
      const lineXs = lineVertices.map((v) => v.x);
      const lineYs = lineVertices.map((v) => v.y);

      const lineBbox = {
        left: Math.min(...lineXs),
        top: Math.min(...lineYs),
        right: Math.max(...lineXs),
        bottom: Math.max(...lineYs),
      };

      const linePoly = {
        tl: lineVertices[0],
        tr: lineVertices[1],
        br: lineVertices[2],
        bl: lineVertices[3],
      };

      const baseline = [0, 0];

      if (linePoly.br.x !== linePoly.bl.x) {
        baseline[0] = (linePoly.br.y - linePoly.bl.y) / (linePoly.br.x - linePoly.bl.x);
      }

      const lineObj = new ocr.OcrLine(pageObj, lineBbox, baseline);
      if (debugMode) {
        lineObj.debug.raw = JSON.stringify(lineSeg.line);
      }

      const lineTokens = [];
      for (let j = 0; j < pageTokens.length; j++) {
        const token = pageTokens[j];
        const tokenSeg = token.layout?.textAnchor?.textSegments?.[0];
        const tokenStart = parseInt(tokenSeg?.startIndex || '0', 10);
        const tokenEnd = parseInt(tokenSeg?.endIndex || '0', 10);

        if (tokenStart >= lineSeg.startIndex && tokenEnd <= lineSeg.endIndex) {
          lineTokens.push(token);
        }
      }

      if (lineTokens.length === 0) continue;

      for (let j = 0; j < lineTokens.length; j++) {
        const token = lineTokens[j];
        const tokenLayout = token.layout;

        const tokenSeg = tokenLayout?.textAnchor?.textSegments?.[0];
        const tokenStart = parseInt(tokenSeg?.startIndex || '0', 10);
        const tokenEnd = parseInt(tokenSeg?.endIndex || '0', 10);
        const wordText = fullText.substring(tokenStart, tokenEnd).trim();

        if (!wordText) continue;

        const tokenVertices = getScaledVertices(tokenLayout.boundingPoly, pageWidth, pageHeight, scaleX, scaleY);
        const xs = tokenVertices.map((v) => v.x);
        const ys = tokenVertices.map((v) => v.y);

        const wordBbox = {
          left: Math.min(...xs),
          top: Math.min(...ys),
          right: Math.max(...xs),
          bottom: Math.max(...ys),
        };

        const wordPoly = {
          tl: tokenVertices[0],
          tr: tokenVertices[1],
          br: tokenVertices[2],
          bl: tokenVertices[3],
        };

        const wordId = `word_${n + 1}_${pageObj.lines.length + 1}_${j + 1}`;
        const wordObj = new ocr.OcrWord(lineObj, wordId, wordText, wordBbox, wordPoly);

        wordObj.conf = Math.round((tokenLayout.confidence || 0) * 100);

        if (debugMode) {
          wordObj.debug.raw = JSON.stringify(token);
        }

        lineObj.words.push(wordObj);
      }

      if (lineObj.words.length > 0) {
        splitUnicodeSuperscripts(lineObj);

        const wordBboxes = lineObj.words.map((w) => w.bbox);
        lineObj.bbox = calcBboxUnion(wordBboxes);

        // Calculate text metrics from line polygon height.
        // Google Document AI word bounding boxes extend to the full line height for all words,
        // so we use the line polygon to get the total text line height (ascender to descender).
        // Using a 3/4 ratio for ascender height matches the typical Latin font proportions
        // (ascender ~750/1000 em, descender ~250/1000 em).
        const lineHeight = ((linePoly.br.y - linePoly.tr.y) + (linePoly.bl.y - linePoly.tl.y)) / 2;

        lineObj.ascHeight = lineHeight * 3 / 4;
        lineObj.baseline[1] = lineHeight * -1 / 4 - (lineObj.bbox.bottom - linePoly.bl.y);

        lineTextRanges.push({ startIndex: lineSeg.startIndex, endIndex: lineSeg.endIndex });
        pageObj.lines.push(lineObj);
      }
    }

    // Assign lines to paragraphs using textAnchor ranges
    const pageParagraphs = pageData.paragraphs;
    if (pageParagraphs && pageParagraphs.length > 0) {
      for (const pagePar of pageParagraphs) {
        const parSeg = pagePar.layout?.textAnchor?.textSegments?.[0];
        const parStart = parseInt(parSeg?.startIndex || '0', 10);
        const parEnd = parseInt(parSeg?.endIndex || '0', 10);

        const paragraphLines = [];
        for (let k = 0; k < pageObj.lines.length; k++) {
          const lr = lineTextRanges[k];
          if (lr.startIndex >= parStart && lr.endIndex <= parEnd) {
            paragraphLines.push(pageObj.lines[k]);
          }
        }

        if (paragraphLines.length > 0) {
          const parBbox = calcBboxUnion(paragraphLines.map((line) => line.bbox));
          const parObj = new ocr.OcrPar(pageObj, parBbox);
          paragraphLines.forEach((lineObj) => { lineObj.par = parObj; });
          parObj.lines = paragraphLines;
          pageObj.pars.push(parObj);
        }
      }

      // Collect any unassigned lines into a fallback paragraph
      const unassignedLines = pageObj.lines.filter((line) => !line.par);
      if (unassignedLines.length > 0) {
        const parBbox = calcBboxUnion(unassignedLines.map((line) => line.bbox));
        const parObj = new ocr.OcrPar(pageObj, parBbox);
        unassignedLines.forEach((lineObj) => { lineObj.par = parObj; });
        parObj.lines = unassignedLines;
        pageObj.pars.push(parObj);
        console.warn(`Page ${n}: ${unassignedLines.length} line(s) were added to fallback paragraph due to missing paragraph assignments.`);
      }
    }

    const langSet = pass3(pageObj);

    const dataTables = new LayoutDataTablePage(n);

    resArr.push({ pageObj, dataTables, langSet });
  }

  return resArr;
}

/**
 * Get scaled vertices from a bounding poly.
 * Prefers absolute vertices, falls back to normalized vertices.
 * @param {Object} boundingPoly
 * @param {number} pageWidth
 * @param {number} pageHeight
 * @param {number} scaleX
 * @param {number} scaleY
 * @returns {Array<{x: number, y: number}>}
 */
function getScaledVertices(boundingPoly, pageWidth, pageHeight, scaleX, scaleY) {
  if (boundingPoly.vertices && boundingPoly.vertices.length > 0
    && boundingPoly.vertices.some((v) => v.x !== undefined || v.y !== undefined)) {
    return boundingPoly.vertices.map((v) => ({
      x: (v.x || 0) * scaleX,
      y: (v.y || 0) * scaleY,
    }));
  }
  if (boundingPoly.normalizedVertices && boundingPoly.normalizedVertices.length > 0) {
    return boundingPoly.normalizedVertices.map((v) => ({
      x: (v.x || 0) * pageWidth * scaleX,
      y: (v.y || 0) * pageHeight * scaleY,
    }));
  }
  throw new Error('No vertices found in bounding poly.');
}
