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
    // Textract uses normalized coordinates (0-1), we need to convert to pixels
    // We'll assume standard page dimensions since Textract doesn't provide pixel dimensions
    const pageDimsN = pageDims[n];
    if (!pageDimsN) {
      throw new Error(`No page dimensions provided for page ${n + 1}.`);
    }

    const pageObj = new ocr.OcrPage(n, pageDimsN);

    // Check if we have any text content
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

    /** @type {Array<number>} */
    const angleRisePage = [];

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
      const lineObj = convertLineTextract(lineBlock, blockMap, relationshipMap, pageObj, n, lineIndex, pageDimsN);
      if (lineObj) {
        pageObj.lines.push(lineObj);
        lineObjMap.set(lineBlock.Id, lineObj);

        // Collect baseline slopes for angle calculation
        if (lineObj.baseline && Math.abs(lineObj.baseline[0]) > 0.001) {
          angleRisePage.push(lineObj.baseline[0]);
        }
      }
    });

    // Calculate page angle from line baselines
    const angleRiseMedian = mean50(angleRisePage) || 0;
    const angleOut = Math.asin(angleRiseMedian) * (180 / Math.PI);
    pageObj.angle = angleOut;
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
 */
function convertLineTextract(lineBlock, blockMap, relationshipMap, pageObj, pageNum, lineIndex, pageDims) {
  // `lineBlock.Page` will be undefined when the entire document is a single page.
  if (!lineBlock.Text || !lineBlock.Geometry || (lineBlock.Page || 1) - 1 !== pageNum) return null;

  // Convert normalized coordinates to pixels
  const bboxLine = convertBoundingBox(lineBlock.Geometry.BoundingBox, pageDims);

  const polyLine = convertPolygon(lineBlock.Geometry.Polygon, pageDims);

  // Calculate baseline from geometry - Textract doesn't provide explicit baseline
  // We'll estimate it based on the polygon points if available
  let baselineSlope = 0;
  if (polyLine.br.x !== polyLine.bl.x) {
    baselineSlope = (polyLine.br.y - polyLine.bl.y) / (polyLine.br.x - polyLine.bl.x);
  }

  const baseline = [baselineSlope, 0];
  const lineObj = new ocr.OcrLine(pageObj, bboxLine, baseline);
  const wordPolyArr = /** @type {Polygon[]} */ ([]);

  const childIds = relationshipMap.get(lineBlock.Id) || [];

  childIds.forEach((wordId, wordIndex) => {
    const wordBlock = blockMap.get(wordId);
    if (wordBlock && wordBlock.BlockType === 'WORD') {
      if (!wordBlock.Text || !wordBlock.Geometry) return;

      const bboxWord = convertBoundingBox(wordBlock.Geometry.BoundingBox, pageDims);
      const id = `word_${pageNum + 1}_${lineIndex + 1}_${wordIndex + 1}`;

      const wordObj = new ocr.OcrWord(lineObj, wordBlock.Text, bboxWord, id);
      wordObj.conf = wordBlock.Confidence || 100;

      lineObj.words.push(wordObj);
      wordPolyArr.push(convertPolygon(wordBlock.Geometry.Polygon, pageDims));
    }
  });

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
  const ascDescWords = /** @type {OcrWord[]} */([]);

  for (let i = 0; i < lineObj.words.length; i++) {
    const word = lineObj.words[i];
    const polyWord = wordPolyArr[i];

    if (word.text && descCharRegex.test(word.text)) {
      descWords.push(word);
    }
    if (word.text && (xCharRegex.test(word.text) || ascCharRegex.test(word.text))) {
      nonDescWords.push(word);
      nonDescWordsPoly.push(polyWord);
    }
    // The `ascCharRegex` array purposefully does not contain `f`, as it varies wildly in height,
    // and this array was primarily created for formats where we have character-level data.
    // Therefore, additional characters are added here as appropriate.
    if (word.text && xCharRegex.test(word.text) && !ascCharRegex.test(word.text)
      && !descCharRegex.test(word.text) && !/[fi]/.test(word.text)) {
      xOnlyWords.push(word);
      xOnlyWordsPoly.push(polyWord);
    }
    if (word.text && ascCharRegex.test(word.text) && !descCharRegex.test(word.text)) {
      ascOnlyWords.push(word);
      ascOnlyWordsPoly.push(polyWord);
    }
    if (word.text && descCharRegex.test(word.text) && !ascCharRegex.test(word.text)) {
      descOnlyWords.push(word);
    }
    if (word.text && ascCharRegex.test(word.text) && descCharRegex.test(word.text)) {
      ascDescWords.push(word);
    }

    // Replace unicode superscript characters with regular text.
    // TODO: This should be updated to properly handle superscripts rather than removing them.
    if (/[⁰¹²³⁴⁵⁶⁷⁸⁹ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻᴬᴮᴰᴱᴳᴴᴵᴶᴷᴸᴹᴺᴼᴾᴿᵀᵁⱽᵂ⁺⁻⁼⁽⁾]/g.test(word.text)) {
      word.text = removeSuperscript(word.text);
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

  const lineHeight = ((polyLine.tr.y - polyLine.br.y) + (polyLine.tr.y - polyLine.br.y)) / 2;
  if (Number.isFinite(nonDescBottomDelta) && nonDescBottomDelta < lineObj.bbox.bottom && nonDescBottomDelta > (lineHeight / 2)) {
    lineObj.baseline[1] = nonDescBottomDelta - (lineObj.bbox.bottom - polyLine.bl.y);
  } else if (descWords.length > 0) {
    lineObj.baseline[1] = -lineHeight / 3 - (lineObj.bbox.bottom - polyLine.bl.y);
  }

  if (xHeight) lineObj.xHeight = xHeight;
  if (ascHeight) lineObj.ascHeight = ascHeight;

  return lineObj.words.length > 0 ? lineObj : null;
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
 * @return {Polygon}
 */
function convertPolygon(textractPolygon, pageDims) {
  return {
    br: {
      x: Math.round(textractPolygon[2].X * pageDims.width),
      y: Math.round(textractPolygon[2].Y * pageDims.height),
    },
    bl: {
      x: Math.round(textractPolygon[3].X * pageDims.width),
      y: Math.round(textractPolygon[3].Y * pageDims.height),
    },
    tr: {
      x: Math.round(textractPolygon[1].X * pageDims.width),
      y: Math.round(textractPolygon[1].Y * pageDims.height),
    },
    tl: {
      x: Math.round(textractPolygon[0].X * pageDims.width),
      y: Math.round(textractPolygon[0].Y * pageDims.height),
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

    // Create paragraph if we have lines
    if (paragraphLines.length > 0) {
      // Calculate paragraph bounding box from line bounding boxes
      const parBbox = calcBboxUnion(paragraphLines.map((line) => line.bbox));
      const parObj = new ocr.OcrPar(pageObj, parBbox);

      // Set the layout block type as a reason for debugging
      parObj.reason = layoutBlock.BlockType || 'LAYOUT_UNKNOWN';

      // Assign lines to paragraph
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
