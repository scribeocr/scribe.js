import ocr from '../objects/ocrObjects.js';

import {
  calcBboxUnion,
  mean50,
  quantile,
  round6,
  descCharArr,
  ascCharArr,
  xCharArr,
} from '../utils/miscUtils.js';

import {
  LayoutDataColumn, LayoutDataTable, LayoutDataTablePage,
} from '../objects/layoutObjects.js';
import { pass3 } from './convertPageShared.js';

const debugMode = false;

/**
 * @param {Object} params
 * @param {string} params.ocrStr - Textract JSON as string
 * @param {dims[]} params.pageDims - Page metrics to use for the pages (Textract only).
 */
export async function convertDocTextract({ ocrStr, pageDims }) {
  let textractData;
  try {
    textractData = JSON.parse(ocrStr);
  } catch (error) {
    throw new Error('Failed to parse Textract JSON.');
  }

  const blocks = textractData.Blocks || [];

  // Find the PAGE block to get page dimensions
  const pageBlock = blocks.find((block) => block.BlockType === 'PAGE');
  if (!pageBlock) {
    throw new Error('No PAGE block found in Textract data.');
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
    const lineBlocks = blocks.filter((block) => block.BlockType === 'LINE');
    if (lineBlocks.length === 0) {
      const warn = { char: 'char_error' };
      return {
        pageObj,
        charMetricsObj: {},
        dataTables: new LayoutDataTablePage(n),
        warn,
      };
    }

    // Process tables
    const tablesPage = convertTableLayoutTextract(n, blocks, pageDimsN);

    // Build relationships map for quick lookup
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

    // Create a map of blocks by ID for quick lookup
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

    // Create paragraphs from Textract layout blocks
    createParagraphsFromLayout(pageObj, layoutBlocks, relationshipMap, blockMap, lineObjMap);

    const langSet = pass3(pageObj);

    resArr.push({ pageObj, dataTables: tablesPage, langSet });
  }

  return resArr;
}

/**
 * Calculate the baseline for a line object based on its words, and modify the line object in place.
 * The information available in Textract is limited, so we estimate the baseline
 * based on the positions of words that contain descenders, ascenders, or x-height characters.
 * @param {OcrLine} lineObj
 */
const calcLineBaseline = (lineObj) => {
  const descCharRegex = new RegExp(`[${descCharArr.join('')}]`);
  const ascCharRegex = new RegExp(`[${ascCharArr.join('')}]`);
  const xCharRegex = new RegExp(`[${xCharArr.join('')}]`);

  const descWords = /** @type {OcrWord[]} */([]);
  const nonDescWords = /** @type {OcrWord[]} */([]);
  const xOnlyWords = /** @type {OcrWord[]} */([]);
  const ascOnlyWords = /** @type {OcrWord[]} */([]);
  const descOnlyWords = /** @type {OcrWord[]} */([]);
  const ascDescWords = /** @type {OcrWord[]} */([]);

  for (const word of lineObj.words) {
    if (word.text && descCharRegex.test(word.text)) {
      descWords.push(word);
    }
    if (word.text && (xCharRegex.test(word.text) || ascCharRegex.test(word.text))) {
      nonDescWords.push(word);
    }
    // The `ascCharRegex` array purposefully does not contain `f`, as it varies wildly in height,
    // and this array was primarily created for formats where we have character-level data.
    // Therefore, additional characters are added here as appropriate.
    if (word.text && xCharRegex.test(word.text) && !ascCharRegex.test(word.text)
      && !descCharRegex.test(word.text) && !/[fi]/.test(word.text)) {
      xOnlyWords.push(word);
    }
    if (word.text && ascCharRegex.test(word.text) && !descCharRegex.test(word.text)) {
      ascOnlyWords.push(word);
    }
    if (word.text && descCharRegex.test(word.text) && !ascCharRegex.test(word.text)) {
      descOnlyWords.push(word);
    }
    if (word.text && ascCharRegex.test(word.text) && descCharRegex.test(word.text)) {
      ascDescWords.push(word);
    }
  }

  const nonDescBottoms = nonDescWords.map((word) => word.bbox.bottom);
  const nonDescBottom = mean50(nonDescBottoms);

  const lineHeight = lineObj.bbox.bottom - lineObj.bbox.top;
  const lineMid = lineObj.bbox.top + lineHeight / 2;
  if (Number.isFinite(nonDescBottom) && nonDescBottom < lineObj.bbox.bottom && nonDescBottom > lineMid) {
    lineObj.baseline[1] = nonDescBottom - lineObj.bbox.bottom;
  } else if (descWords.length > 0) {
    lineObj.baseline[1] = -lineHeight / 3;
  }

  let xHeight = /** @type {?number} */ (mean50(xOnlyWords.map((word) => (word.bbox.bottom - word.bbox.top))));
  const ascHeight = mean50(ascOnlyWords.map((word) => (word.bbox.bottom - word.bbox.top)));
  if (xHeight && ascHeight && xHeight > ascHeight * 0.8) {
    if (ascOnlyWords.length > xOnlyWords.length) {
      xHeight = null;
    }
  }

  if (xHeight) lineObj.xHeight = xHeight;
  if (ascHeight) lineObj.ascHeight = ascHeight;
};

/**
 * Convert Textract LINE block to OcrLine
 */
function convertLineTextract(lineBlock, blockMap, relationshipMap, pageObj, pageNum, lineIndex, pageDims) {
  if (!lineBlock.Text || !lineBlock.Geometry || lineBlock.Page - 1 !== pageNum) return null;

  // Convert normalized coordinates to pixels
  const bbox = convertBoundingBox(lineBlock.Geometry.BoundingBox, pageDims);

  // Calculate baseline from geometry - Textract doesn't provide explicit baseline
  // We'll estimate it based on the polygon points if available
  let baselineSlope = 0;
  if (lineBlock.Geometry.Polygon && lineBlock.Geometry.Polygon.length >= 4) {
    const poly = lineBlock.Geometry.Polygon;
    // Calculate slope using bottom points of the polygon
    const leftBottom = poly[3];
    const rightBottom = poly[2];
    if (rightBottom.X !== leftBottom.X) {
      baselineSlope = (rightBottom.Y - leftBottom.Y) / (rightBottom.X - leftBottom.X);
    }
  }

  const baseline = [baselineSlope, 0]; // [slope, offset]
  const lineObj = new ocr.OcrLine(pageObj, bbox, baseline);

  // This should be kept disabled as a rule unless debugging
  if (debugMode) lineObj.raw = JSON.stringify(lineBlock);

  // Get child word IDs
  const childIds = relationshipMap.get(lineBlock.Id) || [];

  // Process words
  childIds.forEach((wordId, wordIndex) => {
    const wordBlock = blockMap.get(wordId);
    if (wordBlock && wordBlock.BlockType === 'WORD') {
      const wordObj = convertWordTextract(wordBlock, lineObj, pageNum, lineIndex, wordIndex, pageDims);
      if (wordObj) {
        lineObj.words.push(wordObj);
      }
    }
  });

  calcLineBaseline(lineObj);

  return lineObj.words.length > 0 ? lineObj : null;
}

/**
 * Convert Textract WORD block to OcrWord
 */
function convertWordTextract(wordBlock, lineObj, pageNum, lineIndex, wordIndex, pageDims) {
  if (!wordBlock.Text || !wordBlock.Geometry) return null;

  const bbox = convertBoundingBox(wordBlock.Geometry.BoundingBox, pageDims);
  const id = `word_${pageNum + 1}_${lineIndex + 1}_${wordIndex + 1}`;

  const wordObj = new ocr.OcrWord(lineObj, wordBlock.Text, bbox, id);
  wordObj.conf = wordBlock.Confidence || 100;
  wordObj.lang = 'eng'; // Textract doesn't provide language per word in this format

  // Set default style - Textract doesn't provide detailed font information in basic output
  wordObj.style = {
    font: null,
    size: null,
    bold: false,
    italic: false,
    underline: false,
    smallCaps: false,
    sup: false,
    dropcap: false,
  };

  // Detect potential formatting based on text characteristics
  detectTextFormatting(wordObj);

  return wordObj;
}

/**
 * Convert Textract normalized coordinates to pixel coordinates
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
 * Detect basic text formatting based on text characteristics
 */
function detectTextFormatting(wordObj) {
  const text = wordObj.text;

  // Detect all caps (potential small caps)
  if (text.length > 1 && /^[A-Z][A-Z]+$/.test(text) && !/^[0-9]+$/.test(text)) {
    const wordHeight = wordObj.bbox.bottom - wordObj.bbox.top;
    const lineHeight = wordObj.line.bbox.bottom - wordObj.line.bbox.top;

    // If word is significantly smaller than line, it might be small caps
    if (wordHeight < lineHeight * 0.8) {
      wordObj.style.smallCaps = true;
    }
  }

  // Detect potential superscripts based on position and size
  if (wordObj.line.words.length > 1) {
    const wordHeight = wordObj.bbox.bottom - wordObj.bbox.top;
    const lineHeight = wordObj.line.bbox.bottom - wordObj.line.bbox.top;
    const wordTop = wordObj.bbox.top;
    const lineTop = wordObj.line.bbox.top;

    if (wordHeight < lineHeight * 0.7 && (wordTop - lineTop) > lineHeight * 0.2) {
      wordObj.style.sup = true;
    }
  }
}

/**
 * Create paragraphs from Textract layout blocks
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
 * Convert Textract table layout data
 */
function convertTableLayoutTextract(pageNum, blocks, pageDims) {
  const tablesPage = new LayoutDataTablePage(pageNum);

  // Find TABLE blocks
  const tableBlocks = blocks.filter((block) => block.BlockType === 'TABLE');

  // Build relationships map for tables
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
