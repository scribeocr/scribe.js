import ocr from '../objects/ocrObjects.js';

import {
  calcBboxUnion,
  mean50,
  descCharArr,
  ascCharArr,
  xCharArr,
  removeSuperscript,
} from '../utils/miscUtils.js';

import {
  LayoutDataColumn, LayoutDataTable, LayoutDataTablePage,
} from '../objects/layoutObjects.js';
import { pass3 } from './convertPageShared.js';

const debugMode = false;

/** Unicode superscript characters regex */
const superscriptCharsRegex = /[⁰¹²³⁴⁵⁶⁷⁸⁹ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻᴬᴮᴰᴱᴳᴴᴵᴶᴷᴸᴹᴺᴼᴾᴿᵀᵁⱽᵂ⁺⁻⁼⁽⁾]+/g;

/**
 * AWS Textract uses unicode superscript characters.
 * This function splits words containing these characters into separate words.
 * @param {OcrLine} lineObj
 */
function splitUnicodeSuperscripts(lineObj) {
  const newWords = [];

  for (let i = 0; i < lineObj.words.length; i++) {
    const wordObj = lineObj.words[i];
    const text = wordObj.text;

    if (!superscriptCharsRegex.test(text)) {
      newWords.push(wordObj);
      continue;
    }

    superscriptCharsRegex.lastIndex = 0;

    const segments = [];
    let lastIndex = 0;
    let match;

    while (true) {
      match = superscriptCharsRegex.exec(text);
      if (match === null) break;
      if (match.index > lastIndex) {
        segments.push({ text: text.slice(lastIndex, match.index), isSup: false });
      }
      segments.push({ text: match[0], isSup: true });
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      segments.push({ text: text.slice(lastIndex), isSup: false });
    }

    if (segments.length === 1) {
      wordObj.text = removeSuperscript(wordObj.text);
      wordObj.style.sup = segments[0].isSup;
      newWords.push(wordObj);
      continue;
    }

    const wordWidth = wordObj.bbox.right - wordObj.bbox.left;
    const totalChars = text.length;
    let charOffset = 0;

    for (let j = 0; j < segments.length; j++) {
      const segment = segments[j];
      const segmentChars = segment.text.length;

      const startRatio = charOffset / totalChars;
      const endRatio = (charOffset + segmentChars) / totalChars;

      const wordHeight = wordObj.bbox.bottom - wordObj.bbox.top;

      // For superscripts: smaller size (~58% height) positioned at top
      // The bottom of the superscript should align roughly with the x-height of regular text
      const supHeightRatio = 0.58;
      const supBottomOffset = wordHeight * 0.42; // Position bottom at ~42% from top (roughly x-height)

      const segmentBbox = {
        left: Math.round(wordObj.bbox.left + wordWidth * startRatio),
        top: wordObj.bbox.top,
        right: Math.round(wordObj.bbox.left + wordWidth * endRatio),
        bottom: segment.isSup
          ? Math.round(wordObj.bbox.top + supBottomOffset)
          : wordObj.bbox.bottom,
      };

      const segmentId = j === 0 ? wordObj.id : `${wordObj.id}_${j}`;
      const segmentText = segment.isSup ? removeSuperscript(segment.text) : segment.text;

      // Calculate proportional polygon based on character position
      let segmentPoly;
      if (wordObj.poly) {
        const polyWidth = wordObj.poly.tr.x - wordObj.poly.tl.x;
        const polyBottomWidth = wordObj.poly.br.x - wordObj.poly.bl.x;
        const polyHeight = ((wordObj.poly.bl.y - wordObj.poly.tl.y) + (wordObj.poly.br.y - wordObj.poly.tr.y)) / 2;

        // For superscripts, adjust the bottom y-coordinates to be higher
        const blY = segment.isSup
          ? wordObj.poly.tl.y + polyHeight * supHeightRatio
          : wordObj.poly.bl.y;
        const brY = segment.isSup
          ? wordObj.poly.tr.y + polyHeight * supHeightRatio
          : wordObj.poly.br.y;

        segmentPoly = {
          tl: {
            x: wordObj.poly.tl.x + polyWidth * startRatio,
            y: wordObj.poly.tl.y,
          },
          tr: {
            x: wordObj.poly.tl.x + polyWidth * endRatio,
            y: wordObj.poly.tr.y,
          },
          bl: {
            x: wordObj.poly.bl.x + polyBottomWidth * startRatio,
            y: blY,
          },
          br: {
            x: wordObj.poly.bl.x + polyBottomWidth * endRatio,
            y: brY,
          },
        };
      }

      const segmentWord = new ocr.OcrWord(lineObj, segmentId, segmentText, segmentBbox, segmentPoly);
      segmentWord.conf = wordObj.conf;
      segmentWord.lang = wordObj.lang;

      if (segment.isSup) {
        segmentWord.style.sup = true;
      }

      newWords.push(segmentWord);
      charOffset += segmentChars;
    }
  }

  lineObj.words = newWords;
}

/**
 *
 * @param {TextractPoint[]} poly
 */
const detectPolyOrientation = (poly) => {
  // 90 degrees clockwise
  if (poly[0].X > poly[2].X && poly[0].Y < poly[2].Y) {
    return 1;
  }

  // 180 degrees
  if (poly[0].X > poly[2].X && poly[0].Y > poly[2].Y) {
    return 2;
  }

  // 90 degrees counter-clockwise
  if (poly[0].X < poly[2].X && poly[1].X < poly[3].X && poly[0].Y > poly[2].Y) {
    return 3;
  }

  // Default
  return 0;
};

/**
 * @param {Object} params
 * @param {string|string[]} params.ocrStr - String or array of strings containing Textract JSON data.
 * @param {dims[]} params.pageDims - Page metrics to use for the pages (Textract only).
 */
export async function convertDocTextract({ ocrStr, pageDims }) {
  const blocks = /** @type {TextractBlock[]} */ ([]);
  try {
    if (typeof ocrStr === 'string') {
      ocrStr = [ocrStr];
    }

    for (let i = 0; i < ocrStr.length; i++) {
      const textractData = JSON.parse(ocrStr[i]);
      if (!textractData || !Array.isArray(textractData.Blocks)) {
        console.warn(`Invalid Textract JSON data at index ${i}. Expected an array of blocks.`);
        continue;
      }
      blocks.push(...textractData.Blocks);
    }
  } catch (error) {
    throw new Error('Failed to parse Textract JSON.');
  }

  const pageBlocks = blocks.filter((block) => block.BlockType === 'PAGE');

  const resArr = [];

  for (let n = 0; n < pageBlocks.length; n++) {
    const pageBlock = pageBlocks[n];

    // Textract uses normalized coordinates (0-1), we need to convert to pixels
    // We'll assume standard page dimensions since Textract doesn't provide pixel dimensions
    const pageDimsN = pageDims[n];
    if (!pageDimsN) {
      throw new Error(`No page dimensions provided for page ${n + 1}.`);
    }

    const pagePoly = pageBlock.Geometry && pageBlock.Geometry.Polygon ? pageBlock.Geometry.Polygon : null;
    if (!pagePoly) throw new Error(`No page polygon data for page ${n + 1}.`);

    const pageOrientation = detectPolyOrientation(pagePoly);

    console.log(`Page ${n + 1} orientation: ${pageOrientation * 90} degrees`);

    const pageObj = new ocr.OcrPage(n, pageDimsN);

    const lineBlocks = blocks.filter((block) => block.BlockType === 'LINE' && (!block.Page && n === 0 || block.Page === n + 1));
    if (lineBlocks.length === 0) {
      const warn = { char: 'char_error' };
      return {
        pageObj,
        charMetricsObj: {},
        dataTables: new LayoutDataTablePage(n),
        warn,
      };
    }

    const tablesPage = convertTableLayoutTextract(n, blocks, pageDimsN);

    const relationshipMap = new Map();
    blocks.forEach((block) => {
      if (block.Relationships) {
        block.Relationships.forEach((rel) => {
          if (rel.Type === 'CHILD') {
            relationshipMap.set(block.Id, rel.Ids || []);
          }
        });
      }
    });

    const blockMap = new Map();
    blocks.forEach((block) => {
      blockMap.set(block.Id, block);
    });

    // Process layout blocks (paragraphs) and their lines
    const layoutBlocks = blocks.filter((block) => block.BlockType && block.BlockType.startsWith('LAYOUT_'),
    );

    // Create a map to track which lines belong to which layout blocks
    const lineToLayoutMap = new Map();

    layoutBlocks.forEach((layoutBlock) => {
      const childIds = relationshipMap.get(layoutBlock.Id) || [];
      childIds.forEach((childId) => {
        const childBlock = blockMap.get(childId);
        if (childBlock && childBlock.BlockType === 'LINE') {
          lineToLayoutMap.set(childId, layoutBlock);
        }
      });
    });

    // Process lines and convert to OCR format
    const lineObjMap = new Map();
    lineBlocks.forEach((lineBlock, lineIndex) => {
      const lineObj = convertLineTextract(lineBlock, blockMap, relationshipMap, pageObj, n, lineIndex, pageDimsN, pageOrientation);
      if (lineObj) {
        pageObj.lines.push(lineObj);
        lineObjMap.set(lineBlock.Id, lineObj);
      }
    });

    pageObj.textSource = 'textract';

    // Create paragraphs from Textract layout blocks
    createParagraphsFromLayout(pageObj, layoutBlocks, relationshipMap, blockMap, lineObjMap);

    // Reorder lines based on paragraphs to ensure line order matches logical reading order.
    // Unlike most other programs, Textract does not do this automatically.
    const lines2 = /** @type {OcrLine[]} */ ([]);
    pageObj.pars.forEach((par) => {
      lines2.push(...par.lines);
    });

    if (lines2.length !== pageObj.lines.length) {
      console.warn(`Warning: Mismatch in number of lines (${lines2.length}) and lines in paragraphs (${pageObj.lines.length}) on page ${n + 1}. Lines will not be reordered.`);
    } else {
      pageObj.lines = lines2;
    }

    const langSet = pass3(pageObj);

    resArr.push({ pageObj, dataTables: tablesPage, langSet });
  }

  return resArr;
}

/**
 * Convert Textract LINE block to OcrLine
 * @param {TextractBlock} lineBlock - Textract LINE block
 * @param {Map<string, TextractBlock>} blockMap - Map of Textract blocks by ID
 * @param {Map<string, string[]>} relationshipMap - Map of Textract relationships by block ID
 * @param {OcrPage} pageObj - OcrPage object for the current page
 * @param {number} pageNum - Page number (0-indexed)
 * @param {number} lineIndex - Index of the line block on the page
 * @param {dims} pageDims - Dimensions of the page in pixels
 * @param {number} pageOrientation - Orientation of the page (0-3)
 */
function convertLineTextract(lineBlock, blockMap, relationshipMap, pageObj, pageNum, lineIndex, pageDims, pageOrientation) {
  // `lineBlock.Page` will be undefined when the entire document is a single page.
  if (!lineBlock.Text || !lineBlock.Geometry || (lineBlock.Page || 1) - 1 !== pageNum) return null;

  // Convert normalized coordinates to pixels
  const bboxLine = convertBoundingBox(lineBlock.Geometry.BoundingBox, pageDims);

  const polyLine0 = convertPolygon(lineBlock.Geometry.Polygon, pageDims, pageOrientation);
  let polyLine = /** @type {Polygon} */ (JSON.parse(JSON.stringify(polyLine0)));

  const baseline = [0, 0];
  const lineObj = new ocr.OcrLine(pageObj, bboxLine, baseline);

  const childIds = relationshipMap.get(lineBlock.Id) || [];

  const wordBlocks = /** @type {TextractBlock[]} */ (childIds.map((wordId) => blockMap.get(wordId)).filter((block) => block && block.BlockType === 'WORD'));

  wordBlocks.forEach((wordBlock, wordIndex) => {
    const bboxWord = convertBoundingBox(wordBlock.Geometry.BoundingBox, pageDims);
    const id = `word_${pageNum + 1}_${lineIndex + 1}_${wordIndex + 1}`;

    const poly = convertPolygon(wordBlock.Geometry.Polygon, pageDims, pageOrientation);

    const wordObj = new ocr.OcrWord(lineObj, id, wordBlock.Text, bboxWord, poly);
    wordObj.conf = wordBlock.Confidence || 100;

    lineObj.words.push(wordObj);
  });

  if (!wordBlocks.length || !lineObj.words.length) {
    console.warn(`Warning: Line with no words on page ${pageNum + 1}, line index ${lineIndex + 1}. Skipping line.`);
    return null;
  }

  const lineOrientation = (wordBlocks[0].Geometry.RotationAngle || 0) / 90;

  // @ts-ignore
  lineObj.orientation = pageOrientation - lineOrientation;
  if (lineObj.orientation < 0) {
    lineObj.orientation += 4;
  }

  if (lineObj.orientation === 1) {
    const lineBox = { ...lineObj.bbox };
    lineObj.bbox.left = lineBox.top;
    lineObj.bbox.top = pageDims.width - lineBox.right;
    lineObj.bbox.right = lineBox.bottom;
    lineObj.bbox.bottom = pageDims.width - lineBox.left;
    lineObj.words.forEach((word) => {
      const wordBox = { ...word.bbox };
      word.bbox.left = word.bbox.top;
      word.bbox.top = pageDims.width - wordBox.right;
      word.bbox.right = wordBox.bottom;
      word.bbox.bottom = pageDims.width - wordBox.left;
      word.poly = {
        tl: { x: word.poly.tr.y, y: pageDims.width - word.poly.tr.x },
        tr: { x: word.poly.br.y, y: pageDims.width - word.poly.br.x },
        br: { x: word.poly.bl.y, y: pageDims.width - word.poly.bl.x },
        bl: { x: word.poly.tl.y, y: pageDims.width - word.poly.tl.x },
      };
    });
    polyLine = {
      tl: { x: polyLine0.tr.y, y: pageDims.width - polyLine0.tr.x },
      tr: { x: polyLine0.br.y, y: pageDims.width - polyLine0.br.x },
      br: { x: polyLine0.bl.y, y: pageDims.width - polyLine0.bl.x },
      bl: { x: polyLine0.tl.y, y: pageDims.width - polyLine0.tl.x },
    };
  } else if (lineObj.orientation === 2) {
    const lineBox = { ...lineObj.bbox };
    lineObj.bbox.left = pageDims.width - lineBox.right;
    lineObj.bbox.top = pageDims.height - lineBox.bottom;
    lineObj.bbox.right = pageDims.width - lineBox.left;
    lineObj.bbox.bottom = pageDims.height - lineBox.top;
    lineObj.words.forEach((word) => {
      const wordBox = { ...word.bbox };
      word.bbox.left = pageDims.width - wordBox.right;
      word.bbox.top = pageDims.height - wordBox.bottom;
      word.bbox.right = pageDims.width - wordBox.left;
      word.bbox.bottom = pageDims.height - wordBox.top;
      word.poly = {
        tl: { x: pageDims.width - word.poly.br.x, y: pageDims.height - word.poly.br.y },
        tr: { x: pageDims.width - word.poly.bl.x, y: pageDims.height - word.poly.bl.y },
        br: { x: pageDims.width - word.poly.tl.x, y: pageDims.height - word.poly.tl.y },
        bl: { x: pageDims.width - word.poly.tr.x, y: pageDims.height - word.poly.tr.y },
      };
    });
    polyLine = {
      tl: { x: pageDims.width - polyLine0.br.x, y: pageDims.height - polyLine0.br.y },
      tr: { x: pageDims.width - polyLine0.bl.x, y: pageDims.height - polyLine0.bl.y },
      br: { x: pageDims.width - polyLine0.tl.x, y: pageDims.height - polyLine0.tl.y },
      bl: { x: pageDims.width - polyLine0.tr.x, y: pageDims.height - polyLine0.tr.y },
    };
  } else if (lineObj.orientation === 3) {
    const lineBox = { ...lineObj.bbox };
    lineObj.bbox.left = pageDims.height - lineBox.bottom;
    lineObj.bbox.top = lineBox.left;
    lineObj.bbox.right = pageDims.height - lineBox.top;
    lineObj.bbox.bottom = lineBox.right;
    lineObj.words.forEach((word) => {
      const wordBox = { ...word.bbox };
      word.bbox.left = pageDims.height - wordBox.bottom;
      word.bbox.top = wordBox.left;
      word.bbox.right = pageDims.height - wordBox.top;
      word.bbox.bottom = wordBox.right;
      word.poly = {
        tl: { x: pageDims.height - word.poly.bl.y, y: word.poly.bl.x },
        tr: { x: pageDims.height - word.poly.tl.y, y: word.poly.tl.x },
        br: { x: pageDims.height - word.poly.tr.y, y: word.poly.tr.x },
        bl: { x: pageDims.height - word.poly.br.y, y: word.poly.br.x },
      };
    });
    polyLine = {
      tl: { x: pageDims.height - polyLine0.bl.y, y: polyLine0.bl.x },
      tr: { x: pageDims.height - polyLine0.tl.y, y: polyLine0.tl.x },
      br: { x: pageDims.height - polyLine0.tr.y, y: polyLine0.tr.x },
      bl: { x: pageDims.height - polyLine0.br.y, y: polyLine0.br.x },
    };
  }

  // Calculate baseline from geometry - Textract doesn't provide explicit baseline
  // We'll estimate it based on the polygon points if available
  if (polyLine.br.x !== polyLine.bl.x) {
    lineObj.baseline[0] = (polyLine.br.y - polyLine.bl.y) / (polyLine.br.x - polyLine.bl.x);
  }

  splitUnicodeSuperscripts(lineObj);

  const descCharRegex = new RegExp(`[${descCharArr.join('')}]`);
  const ascCharRegex = new RegExp(`[${ascCharArr.join('')}]`);
  const xCharRegex = new RegExp(`[${xCharArr.join('')}]`);

  const descWords = /** @type {OcrWord[]} */([]);
  const nonDescWords = /** @type {OcrWord[]} */([]);
  const nonDescWordsPoly = /** @type {Polygon[]} */([]);
  const xOnlyWords = /** @type {OcrWord[]} */([]);
  const xOnlyWordsPoly = /** @type {Polygon[]} */([]);
  const ascOnlyWords = /** @type {OcrWord[]} */([]);
  const ascOnlyWordsPoly = /** @type {Polygon[]} */([]);
  const descOnlyWords = /** @type {OcrWord[]} */([]);

  for (let i = 0; i < lineObj.words.length; i++) {
    const word = lineObj.words[i];

    if (descCharRegex.test(word.text)) {
      descWords.push(word);
    }
    if (!descCharRegex.test(word.text) && (xCharRegex.test(word.text) || ascCharRegex.test(word.text))) {
      nonDescWords.push(word);
      nonDescWordsPoly.push(word.poly);
    }
    // The `ascCharRegex` array purposefully does not contain `f`, as it varies wildly in height,
    // and this array was primarily created for formats where we have character-level data.
    // Therefore, additional characters are added here as appropriate.
    if (xCharRegex.test(word.text) && !ascCharRegex.test(word.text)
      && !descCharRegex.test(word.text) && !/[fi]/.test(word.text)) {
      xOnlyWords.push(word);
      xOnlyWordsPoly.push(word.poly);
    }
    if (ascCharRegex.test(word.text) && !descCharRegex.test(word.text)) {
      ascOnlyWords.push(word);
      ascOnlyWordsPoly.push(word.poly);
    }
    if (descCharRegex.test(word.text) && !ascCharRegex.test(word.text)) {
      descOnlyWords.push(word);
    }
  }

  let xHeight = /** @type {?number} */ (mean50(xOnlyWordsPoly.map((wordPoly) => ((wordPoly.bl.y - wordPoly.tl.y) + (wordPoly.br.y - wordPoly.tr.y)) / 2)));
  const ascHeight = mean50(ascOnlyWordsPoly.map((wordPoly) => ((wordPoly.bl.y - wordPoly.tl.y) + (wordPoly.br.y - wordPoly.tr.y)) / 2));
  if (xHeight && ascHeight && xHeight > ascHeight * 0.8) {
    if (ascOnlyWords.length > xOnlyWords.length) {
      xHeight = null;
    }
  }

  const nonDescBottomDeltaArr = nonDescWordsPoly.map((wordPoly) => {
    const wordBottomMid = Math.round((wordPoly.bl.y + wordPoly.br.y) / 2);
    const wordXMid = Math.round((wordPoly.bl.x + wordPoly.br.x) / 2);
    const wordXMidOffset = wordXMid - lineObj.bbox.left;
    const wordBottomExp = polyLine.bl.y + (baseline[0] * wordXMidOffset);
    return wordBottomMid - wordBottomExp;
  });
  const nonDescBottomDelta = mean50(nonDescBottomDeltaArr);

  const lineHeight = ((polyLine.br.y - polyLine.tr.y) + (polyLine.bl.y - polyLine.tl.y)) / 2;
  if (Number.isFinite(nonDescBottomDelta) && nonDescBottomDelta < lineObj.bbox.bottom && nonDescBottomDelta < (lineHeight / 2)) {
    lineObj.baseline[1] = nonDescBottomDelta - (lineObj.bbox.bottom - polyLine.bl.y);
  } else {
    lineObj.baseline[1] = lineHeight * -1 / 3 - (lineObj.bbox.bottom - polyLine.bl.y);
  }

  // TODO: Properly process metrics when these are negative.
  // This seems to happen for certain orientations of text.
  // For now, we skip to ignore an error being thrown due to a negative value.
  if (xHeight && xHeight > 0) lineObj.xHeight = xHeight;
  if (ascHeight && ascHeight > 0) lineObj.ascHeight = ascHeight;

  return lineObj;
}

/**
 * Convert Textract normalized coordinates to pixel coordinates
 * @param {TextractBoundingBox} textractBbox - Textract bounding box with normalized coordinates
 * @param {dims} pageDims - Dimensions of the page in pixels
 * @returns {bbox}
 */
function convertBoundingBox(textractBbox, pageDims) {
  return {
    left: Math.round(textractBbox.Left * pageDims.width),
    top: Math.round(textractBbox.Top * pageDims.height),
    right: Math.round((textractBbox.Left + textractBbox.Width) * pageDims.width),
    bottom: Math.round((textractBbox.Top + textractBbox.Height) * pageDims.height),
  };
}

/**
 *
 * @param {TextractPoint[]} textractPolygon
 * @param {dims} pageDims
 * @param {number} orientation
 * @return {Polygon}
 */
function convertPolygon(textractPolygon, pageDims, orientation) {
  let br = 2;
  let bl = 3;
  let tr = 1;
  let tl = 0;

  if (orientation === 1) {
    br = 1;
    bl = 2;
    tr = 0;
    tl = 3;
  } else if (orientation === 2) {
    br = 0;
    bl = 1;
    tr = 3;
    tl = 2;
  } else if (orientation === 3) {
    br = 3;
    bl = 0;
    tr = 2;
    tl = 1;
  }

  return {
    br: {
      x: Math.round(textractPolygon[br].X * pageDims.width),
      y: Math.round(textractPolygon[br].Y * pageDims.height),
    },
    bl: {
      x: Math.round(textractPolygon[bl].X * pageDims.width),
      y: Math.round(textractPolygon[bl].Y * pageDims.height),
    },
    tr: {
      x: Math.round(textractPolygon[tr].X * pageDims.width),
      y: Math.round(textractPolygon[tr].Y * pageDims.height),
    },
    tl: {
      x: Math.round(textractPolygon[tl].X * pageDims.width),
      y: Math.round(textractPolygon[tl].Y * pageDims.height),
    },
  };
}

/**
 *
 * @param {OcrPage} pageObj
 * @param {TextractBlock[]} layoutBlocks
 * @param {Map<string, string[]>} relationshipMap - Map of Textract relationships by block ID
 * @param {Map<string, TextractBlock>} blockMap - Map of Textract blocks by ID
 * @param {Map<string, OcrLine>} lineObjMap - Map of OcrLine objects by block ID
 */
function createParagraphsFromLayout(pageObj, layoutBlocks, relationshipMap, blockMap, lineObjMap) {
  // Process each layout block as a paragraph
  layoutBlocks.forEach((layoutBlock) => {
    const childIds = relationshipMap.get(layoutBlock.Id) || [];
    const paragraphLines = [];

    // Find all LINE blocks that are children of this layout block
    childIds.forEach((childId) => {
      const childBlock = blockMap.get(childId);
      if (childBlock && childBlock.BlockType === 'LINE') {
        const lineObj = lineObjMap.get(childId);
        if (lineObj) {
          paragraphLines.push(lineObj);
        }
      }
    });

    if (paragraphLines.length > 0) {
      // Calculate paragraph bounding box from line bounding boxes
      const parBbox = calcBboxUnion(paragraphLines.map((line) => line.bbox));
      const parObj = new ocr.OcrPar(pageObj, parBbox);

      // Set the layout block type as a reason for debugging
      parObj.reason = layoutBlock.BlockType || 'LAYOUT_UNKNOWN';

      if (debugMode) {
        parObj.debug.sourceType = layoutBlock.BlockType || null;
      }

      paragraphLines.forEach((lineObj) => {
        lineObj.par = parObj;
      });

      parObj.lines = paragraphLines;
      pageObj.pars.push(parObj);
    }
  });

  // Handle any lines that weren't assigned to layout blocks
  // (fallback for lines not associated with layout blocks)
  const unassignedLines = pageObj.lines.filter((line) => !line.par);
  if (unassignedLines.length > 0) {
    // Group unassigned lines into a default paragraph
    const parBbox = calcBboxUnion(unassignedLines.map((line) => line.bbox));
    const parObj = new ocr.OcrPar(pageObj, parBbox);
    parObj.reason = 'UNASSIGNED_LINES';

    unassignedLines.forEach((lineObj) => {
      lineObj.par = parObj;
    });

    parObj.lines = unassignedLines;
    pageObj.pars.push(parObj);
  }
}

/**
 *
 * @param {number} pageNum
 * @param {TextractBlock[]} blocks
 * @param {dims} pageDims
 */
function convertTableLayoutTextract(pageNum, blocks, pageDims) {
  const tablesPage = new LayoutDataTablePage(pageNum);

  const tableBlocks = blocks.filter((block) => block.BlockType === 'TABLE' && (!block.Page && pageNum === 0 || block.Page === pageNum + 1));

  const relationshipMap = new Map();
  tableBlocks.forEach((block) => {
    if (block.Relationships) {
      block.Relationships.forEach((rel) => {
        if (rel.Type === 'CHILD') {
          relationshipMap.set(block.Id, rel.Ids || []);
        }
      });
    }
  });

  const blockMap = new Map();
  blocks.forEach((block) => {
    blockMap.set(block.Id, block);
  });

  for (const tableBlock of tableBlocks) {
    const table = new LayoutDataTable(tablesPage);
    const tableBbox = convertBoundingBox(tableBlock.Geometry.BoundingBox, pageDims);

    // Get CELL children
    const cellIds = relationshipMap.get(tableBlock.Id) || [];
    const cellBlocks = cellIds.map((id) => blockMap.get(id)).filter((block) => block && block.BlockType === 'CELL');

    if (cellBlocks.length > 0) {
      // Group cells by row and find column boundaries
      const cellsByRow = new Map();
      cellBlocks.forEach((cell) => {
        const rowIndex = cell.RowIndex || 0;
        if (!cellsByRow.has(rowIndex)) {
          cellsByRow.set(rowIndex, []);
        }
        cellsByRow.get(rowIndex).push(cell);
      });

      // Use first row to determine column structure
      const firstRowCells = cellsByRow.get(0) || cellsByRow.get(1) || [];
      firstRowCells.sort((a, b) => (a.ColumnIndex || 0) - (b.ColumnIndex || 0));

      // Create columns based on cell positions
      firstRowCells.forEach((cell) => {
        const cellBbox = convertBoundingBox(cell.Geometry.BoundingBox, pageDims);
        const column = new LayoutDataColumn({
          left: cellBbox.left,
          top: tableBbox.top,
          right: cellBbox.right,
          bottom: tableBbox.bottom,
        }, table);
        table.boxes.push(column);
      });
    }

    if (table.boxes.length > 0) {
      tablesPage.tables.push(table);
    }
  }

  return tablesPage;
}
