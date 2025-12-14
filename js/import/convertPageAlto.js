import ocr from '../objects/ocrObjects.js';

import {
  calcBboxUnion,
  unescapeXml,
} from '../utils/miscUtils.js';

import { LayoutDataTablePage } from '../objects/layoutObjects.js';
import { pass2, pass3 } from './convertPageShared.js';

// This import is a WIP and does not produce a text layer that closely overlays the source document.
// While the result can likely improved, this is caused in part by limitations in the ALTO format itself.
// The ALTO format only includes the most basic positioning information (word-level bounding boxes).

const debugMode = false;

/**
 * @param {Object} params
 * @param {string} params.ocrStr
 * @param {number} params.n
 */
export async function convertPageAlto({ ocrStr, n }) {
  const pageElement = ocrStr.match(/<Page[^>]+>/i);
  if (!pageElement) throw new Error('Failed to parse ALTO page element.');

  const heightStr = pageElement[0].match(/HEIGHT=["'](\d+)["']/i)?.[1];
  const widthStr = pageElement[0].match(/WIDTH=["'](\d+)["']/i)?.[1];

  if (!heightStr || !widthStr) throw new Error('Failed to parse page dimensions.');

  const pageDims = { height: parseInt(heightStr), width: parseInt(widthStr) };

  const pageObj = new ocr.OcrPage(n, pageDims);

  const textLineRegex = /<TextLine[^>]*>([\s\S]*?)<\/TextLine>/gi;

  /**
   * Extract attribute value from an XML element string
   * @param {string} elemStr
   * @param {string} attrName
   * @returns {?string}
   */
  function getAttr(elemStr, attrName) {
    const regex = new RegExp(`${attrName}=["']([^"']+)["']`, 'i');
    return elemStr.match(regex)?.[1] || null;
  }

  /**
   * @param {string} match - The TextLine element match
   * @param {?string} blockStyleRefs - STYLEREFS from parent TextBlock
   */
  function convertLine(match, blockStyleRefs = null) {
    const textLineTag = match.match(/<TextLine[^>]+>/i)?.[0];
    if (!textLineTag) return '';

    const lineVposStr = getAttr(textLineTag, 'VPOS');
    const lineHposStr = getAttr(textLineTag, 'HPOS');
    const lineHeightheightStr = getAttr(textLineTag, 'HEIGHT');
    const lineWidthStr = getAttr(textLineTag, 'WIDTH');

    if (!lineVposStr || !lineHposStr || !lineHeightheightStr || !lineWidthStr) {
      console.warn('Missing required positional attributes in ALTO TextLine element, skipping line.');
      return '';
    }

    const linebox = {
      left: parseInt(lineHposStr),
      top: parseInt(lineVposStr),
      right: parseInt(lineHposStr) + parseInt(lineWidthStr),
      bottom: parseInt(lineVposStr) + parseInt(lineHeightheightStr),
    };

    const baseline = [0, 0];

    // Height used as rough estimate for ascender height
    const height = parseInt(lineHeightheightStr);
    const lineAscHeightFinal = height * 0.75;
    const lineXHeightFinal = height * 0.5;

    const lineObj = new ocr.OcrLine(pageObj, linebox, baseline, lineAscHeightFinal, lineXHeightFinal);

    if (debugMode) lineObj.raw = match;

    const contentRegex = /<(?:String)\s+[^>]+\/?>/gi;
    const contentMatches = [...match.matchAll(contentRegex)];

    for (let i = 0; i < contentMatches.length; i++) {
      const contentMatch = contentMatches[i][0];

      const content = getAttr(contentMatch, 'CONTENT');
      if (!content) continue;

      const text = unescapeXml(content);
      const strHpos = getAttr(contentMatch, 'HPOS');
      const strVpos = getAttr(contentMatch, 'VPOS');
      const strHeight = getAttr(contentMatch, 'HEIGHT');
      const strWidth = getAttr(contentMatch, 'WIDTH');

      if (!strHpos || !strVpos || !strHeight || !strWidth) {
        console.warn('Missing required positional attributes in ALTO String element, skipping element.');
        continue;
      }

      const wordBox = {
        left: parseInt(strHpos),
        top: parseInt(strVpos),
        right: parseInt(strHpos) + parseInt(strWidth),
        bottom: parseInt(strVpos) + parseInt(strHeight),
      };

      const wordID = `word_${n + 1}_${pageObj.lines.length + 1}_${lineObj.words.length + 1}`;
      const wordObj = new ocr.OcrWord(lineObj, wordID, text, wordBox);

      const wcStr = getAttr(contentMatch, 'WC');
      if (wcStr) {
        wordObj.conf = Math.round(parseFloat(wcStr) * 100);
      }

      const styleAttr = getAttr(contentMatch, 'STYLE');
      if (styleAttr) {
        if (/bold/i.test(styleAttr)) wordObj.style.bold = true;
        if (/italic/i.test(styleAttr)) wordObj.style.italic = true;
        if (/underline/i.test(styleAttr)) wordObj.style.underline = true;
        if (/superscript/i.test(styleAttr)) wordObj.style.sup = true;
        if (/smallcaps/i.test(styleAttr)) wordObj.style.smallCaps = true;
      }

      // Parse STYLEREFS to get font information
      // Use String's STYLEREFS first, fall back to TextBlock's STYLEREFS
      const styleRefs = getAttr(contentMatch, 'STYLEREFS') || blockStyleRefs;
      if (styleRefs) {
        const styleRegex = new RegExp(`<TextStyle\\s*ID=["']${styleRefs}["'][^>]*>`, 'i');
        const styleMatch = ocrStr.match(styleRegex);
        if (styleMatch) {
          const fontFamily = getAttr(styleMatch[0], 'FONTFAMILY');
          if (fontFamily) wordObj.style.font = fontFamily;

          const fontSize = getAttr(styleMatch[0], 'FONTSIZE');
          if (fontSize) wordObj.style.size = parseInt(fontSize);
        }
      }

      if (debugMode) wordObj.raw = contentMatch;

      lineObj.words.push(wordObj);
    }

    if (lineObj.words.length > 0) {
      pageObj.lines.push(lineObj);
    }

    return '';
  }

  const textBlockRegex = /<TextBlock[^>]*>([\s\S]*?)<\/TextBlock>/gi;
  const textBlockMatches = [...ocrStr.matchAll(textBlockRegex)];

  for (const blockMatch of textBlockMatches) {
    const blockTag = blockMatch[0].match(/<TextBlock[^>]+>/i)?.[0];
    const blockStyleRefs = blockTag ? getAttr(blockTag, 'STYLEREFS') : null;
    const blockContent = blockMatch[1];

    /** @type {Array<OcrLine>} */
    const parLineArr = [];

    const textLinesInBlock = [...blockContent.matchAll(textLineRegex)];
    for (const lineMatch of textLinesInBlock) {
      const lineCountBefore = pageObj.lines.length;
      convertLine(lineMatch[0], blockStyleRefs);
      if (pageObj.lines.length > lineCountBefore) {
        parLineArr.push(pageObj.lines[pageObj.lines.length - 1]);
      }
    }

    if (parLineArr.length > 0) {
      const parbox = calcBboxUnion(parLineArr.map((x) => x.bbox));
      const parObj = new ocr.OcrPar(pageObj, parbox);

      parLineArr.forEach((x) => {
        x.par = parObj;
      });

      parObj.lines = parLineArr;
      pageObj.pars.push(parObj);
    }
  }

  const warn = { char: 'char_warning' };

  pass2(pageObj, 0);
  const langSet = pass3(pageObj);

  const dataTablePage = new LayoutDataTablePage(n);

  return {
    pageObj, dataTables: dataTablePage, warn, langSet,
  };
}
