import { calcBboxUnion, calcBoxOverlap, getRandomAlphanum } from '../utils/miscUtils.js';

/**
 * @param {number} n
 * @param {dims} dims
 * @property {number} n - Page number (index 0)
 * @property {dims} dims - Dimensions of OCR
 * @property {number} angle - Angle of page (degrees)
 * @property {Array<OcrLine>} lines -
 */
export function OcrPage(n, dims) {
  /** @type {number} */
  this.n = n;
  /** @type {dims} */
  this.dims = dims;
  /** @type {number} - Angle of page (degrees) */
  this.angle = 0;
  /** @type {Array<OcrPar>} */
  this.pars = [];
  /** @type {Array<OcrLine>} */
  this.lines = [];
  /** @type {TextSource} */
  this.textSource = null;
}

/**
 * Paragraph type indicating the semantic role of the paragraph.
 * @typedef {'title' | 'body' | 'footnote'} ParType
 */

/**
 *
 * @param {OcrPage} page
 * @param {bbox} bbox
 */
export function OcrPar(page, bbox) {
  this.page = page;
  /** @type {bbox} */
  this.bbox = bbox;
  /** @type {Array<OcrLine>} */
  this.lines = [];
  this.id = getRandomAlphanum(8);
  /**
   * Reason for paragraph break.
   * Used for debugging purposes.
   * @type {string}
   */
  this.reason = '';
  /**
   * Type of paragraph indicating its semantic role.
   * @type {ParType}
   */
  this.type = 'body';
  /**
   * ID of the footnote reference word that links to this footnote.
   * Only set when type === 'footnote'.
   * @type {string | null}
   */
  this.footnoteRefId = null;
}

export function LineDebugInfo() {
  /** @type {?string} */
  this.raw = null;
}

/**
 * @param {OcrPage} page
 * @param {bbox} bbox
 * @param {Array<number>} baseline
 * @param {?number} ascHeight - Height of median ascender character
 * @param {?number} xHeight - Height of median non-ascender/descender character
 * @property {bbox} bbox - bounding box for line
 * @property {Array<number>} baseline - baseline [slope, offset]
 * @property {?number} ascHeight -
 * @property {?number} xHeight -
 * @property {Array<OcrWord>} words - words in line
 * @property {OcrPage} page - page line belongs to
 * @property {?number} _sizeCalc - calculated line font size (using `ascHeight` and `xHeight`)
 * @property {?number} _size - line font size set (set through other means)
 *  `_size` should be preferred over `_sizeCalc` when both exist.
 * @property {?string} raw - Raw string this object was parsed from.
 *    Exists only for debugging purposes, should be `null` in production contexts.
 * @property {?{x: number, y: number}} _angleAdj - Cached x/y adjustments that must be made to coordinates when rotation is enabled.
 */
export function OcrLine(page, bbox, baseline, ascHeight = null, xHeight = null) {
  // These inline comments are required for types to work correctly with VSCode Intellisense.
  // Unfortunately, the @property tags above are not sufficient.
  this.id = getRandomAlphanum(8);
  /** @type {bbox} */
  this.bbox = bbox;
  /** @type {Array<number>} - baseline [slope, offset] */
  this.baseline = baseline;
  /** @type {?number} */
  this.ascHeight = ascHeight;
  /** @type {?number} */
  this.xHeight = xHeight;
  /** @type {Array<OcrWord>} */
  this.words = [];
  /** @type {OcrPage} */
  this.page = page;
  /** @type {?number} */
  this._sizeCalc = null;
  /** @type {?number} */
  this._size = null;
  /** @type {?{x: number, y: number}} */
  this._angleAdj = null;
  /** @type {OcrPar} */
  this.par = null;
  /** @type {number} */
  this.orientation = 0;
  /** @type {LineDebugInfo} */
  this.debug = new LineDebugInfo();
}

export function WordDebugInfo() {
  /** @type {?string} */
  this.raw = null;
}

/**
 * @param {OcrLine} line
 * @param {string} id
 * @param {string} text
 * @param {bbox} bbox
 * @param {Polygon} [poly]
 */
export function OcrWord(line, id, text, bbox, poly) {
  /** @type {string} */
  this.text = text;
  /** @type {?string} */
  this.textAlt = null;
  /** @type {Style} */
  this.style = {
    font: null,
    size: null,
    bold: false,
    italic: false,
    underline: false,
    smallCaps: false,
    sup: false,
    dropcap: false,
  };
  /** @type {string} */
  this.lang = 'eng';
  /** @type {number} */
  this.conf = 0;
  /** @type {bbox} */
  this.bbox = bbox;
  /** @type {?Polygon} */
  this.poly = poly || null;
  /** @type {boolean} */
  this.compTruth = false;
  /** @type {boolean} */
  this.matchTruth = false;
  /** @type {string} */
  this.id = id;
  /** @type {OcrLine} */
  this.line = line;
  /** @type {?Array<OcrChar>} */
  this.chars = null;
  /** @type {?{x: number, y: number}} */
  this._angleAdj = null;
  /**
   * @type {boolean} - If `true`, left/right coordinates represent the left/rightmost pixel.
   * If `false`, left/right coordinates represent the start/end of the font bounding box.
   */
  this.visualCoords = true;
  /** @type {WordDebugInfo} */
  this.debug = new WordDebugInfo();
  /**
   * ID of the footnote paragraph that this word references.
   * Only set when this word is a footnote reference (superscript number linking to a footnote).
   * @type {string | null}
   */
  this.footnoteParId = null;
}

/**
 *
 * @param {string} text
 * @param {bbox} bbox
 */
export function OcrChar(text, bbox) {
  /** @type {string} */
  this.text = text;
  /** @type {bbox} */
  this.bbox = bbox;
}

/**
 *
 * @param {OcrChar} char - The character to scale.
 * @param {number} scale - The scale factor.
 */
function scaleChar(char, scale) {
  char.bbox.left *= scale;
  char.bbox.top *= scale;
  char.bbox.right *= scale;
  char.bbox.bottom *= scale;
}

/**
 *
 * @param {OcrWord} word - The word to scale.
 * @param {number} scale - The scale factor.
 */
function scaleWord(word, scale) {
  word.bbox.left *= scale;
  word.bbox.top *= scale;
  word.bbox.right *= scale;
  word.bbox.bottom *= scale;

  if (word.chars) {
    for (const char of word.chars) {
      scaleChar(char, scale);
    }
  }
}

/**
 *
 * @param {OcrLine} line - The page to scale.
 * @param {number} scale - The scale factor.
 */
function scaleLine(line, scale) {
  line.bbox.left *= scale;
  line.bbox.top *= scale;
  line.bbox.right *= scale;
  line.bbox.bottom *= scale;

  for (const word of line.words) {
    scaleWord(word, scale);
  }

  if (line.ascHeight) line.ascHeight *= scale;
  if (line.xHeight) line.xHeight *= scale;

  line.baseline[1] *= scale;
}

/**
 *
 * @param {OcrPage} page - The page to scale.
 * @param {number} scale - The scale factor.
 */
function scalePage(page, scale) {
  for (const line of page.lines) {
    scaleLine(line, scale);
  }

  page.dims.width *= scale;
  page.dims.height *= scale;
}

/**
 *
 * @param {OcrLine} lineObj
 */
export const getPrevLine = (lineObj) => {
  // While lines have no unique ID, word IDs are assumed unique.
  // Therefore, lines are identified using the ID of the first word.
  if (!lineObj.words[0]) throw new Error('All lines must contain >=1 word');
  const lineIndex = lineObj.page.lines.findIndex((elem) => elem.words?.[0]?.id === lineObj.words[0].id);
  if (lineIndex < 1) return null;
  return lineObj.page.lines[lineIndex - 1];
};

/**
 *
 * @param {OcrLine} lineObj
 */
export const getNextLine = (lineObj) => {
  // While lines have no unique ID, word IDs are assumed unique.
  // Therefore, lines are identified using the ID of the first word.
  if (!lineObj.words[0]) throw new Error('All lines must contain >=1 word');
  const lineIndex = lineObj.page.lines.findIndex((elem) => elem.words?.[0]?.id === lineObj.words[0].id);
  if (lineIndex + 1 >= lineObj.page.lines.length) return null;
  return lineObj.page.lines[lineIndex + 1];
};

/**
 * @param {OcrPage} page
 * @param {string} id
 */
const getPageWord = (page, id) => {
  for (let i = 0; i < page.lines.length; i++) {
    for (let j = 0; j < page.lines[i].words.length; j++) {
      if (page.lines[i].words[j].id === id) return page.lines[i].words[j];
    }
  }

  return null;
};

/**
 * Delete word with id on a given page.
 * @param {OcrPage} page
 * @param {Array<string>} ids
 */
const deletePageWords = (page, ids) => {
  for (let i = 0; i < page.lines.length; i++) {
    for (let j = 0; j < page.lines[i].words.length; j++) {
      const idsIndex = ids.indexOf(page.lines[i].words[j].id);
      if (idsIndex >= 0) {
        // Delete the ID from the list
        ids.splice(idsIndex, 1);
        page.lines[i].words.splice(j, 1);
        // Subtract 1 from j to account for the fact that the array just got one element shorter
        j--;
        // If there are no words left in this line, delete the line
        if (page.lines[i].words.length === 0) {
          page.lines.splice(i, 1);
          i--;
          break;
        // If there are still words in this line, re-calculate the line bounding box.
        // To avoid duplicative calculations this only happens once at the end of the line or after all ids have been deleted.
        } else if (j + 1 === page.lines[i].words.length || ids.length === 0) {
          ocr.updateLineBbox(page.lines[i]);
        }
        // Return if all ids have been deleted.
        if (ids.length === 0) return;
      }
    }
  }
};

/**
 * @param {OcrPage} page
 */
const getPageWords = (page) => {
  const words = [];
  for (let i = 0; i < page.lines.length; i++) {
    words.push(...page.lines[i].words);
  }
  return words;
};

/**
 * Return an array of all characters used in the provided OCR data.
 * Used for subsetting fonts to only the necessary characters.
 * @param {Array<OcrPage>} ocrPageArr
 */
const getDistinctChars = (ocrPageArr) => {
  const charsAll = {};
  for (const ocrPage of ocrPageArr) {
    for (const ocrLine of ocrPage.lines) {
      for (const ocrWord of ocrLine.words) {
        ocrWord.text.split('').forEach((x) => {
          charsAll[x] = true;
        });
      }
    }
  }
  return Object.keys(charsAll);
};

/**
 * @param {OcrLine} line
 */
export const getLineText = (line) => {
  let text = '';
  for (let i = 0; i < line.words.length; i++) {
    text += `${line.words[i].text}`;
    if (i < line.words.length - 1) text += ' ';
  }
  return text;
};

/**
 * @param {OcrPar} par
 */
export const getParText = (par) => {
  let text = '';
  for (let i = 0; i < par.lines.length; i++) {
    if (i > 0) text += ' ';
    text += getLineText(par.lines[i]);
  }
  return text;
};

/**
 * @param {OcrPage} page
 */
const getPageText = (page) => {
  let text = '';
  for (let i = 0; i < page.lines.length; i++) {
    if (i > 0) text += '\n';
    text += getLineText(page.lines[i]);
  }
  return text;
};

/**
 * Get text from words in a specific region of the page.
 * This is a simple helper function that is used primarily for testing.
 * The actual logic for checking whether words are in a specific layout area
 * is more complex and is handled elsewhere.
 * @param {OcrPage} page
 * @param {bbox} bbox
 */
const getRegionText = (page, bbox) => {
  const regionWords = /** @type {OcrWord[]} */ ([]);

  for (let i = 0; i < page.lines.length; i++) {
    const line = page.lines[i];
    for (let j = 0; j < line.words.length; j++) {
      const word = line.words[j];
      if (calcBoxOverlap(word.bbox, bbox) > 0) {
        regionWords.push(word);
      }
    }
  }

  if (regionWords.length === 0) return '';

  let text = '';

  for (let i = 0; i < regionWords.length; i++) {
    if (i > 0 && regionWords[i - 1].line !== regionWords[i].line) {
      text += '\n';
    } else if (i > 0) {
      text += ' ';
    }

    text += regionWords[i].text;
  }

  return text;
};

/**
 * Calculates adjustments to line x and y coordinates needed to auto-rotate the page.
 * This is the rotation applied to the first word in the line (not the entire line bbox).
 * @param {OcrLine} line
 */
function calcLineStartAngleAdj(line) {
  if (!line.words[0]) {
    console.log('No words in line, report as bug.');
    return { x: 0, y: 0 };
  }

  const angle = line.page.angle * -1;
  const dims = line.page.dims;
  const sinAngle = Math.sin(angle * (Math.PI / 180));
  const cosAngle = Math.cos(angle * (Math.PI / 180));

  // Use the bounding box that is closest to the left bound of the line.
  // Note that we intentionally use real characters here, rather than predicting the baseline using the line bounding box and `baseline`,
  // as the latter was found to sometimes lead to incoherent results.
  let bbox;
  const char0Bbox = line.words[0]?.chars?.[0]?.bbox;
  if (char0Bbox) {
    bbox = char0Bbox;
  } else {
    bbox = line.words[0].bbox;
  }

  const width = line.orientation % 2 === 0 ? dims.width : dims.height;
  const height = line.orientation % 2 === 0 ? dims.height : dims.width;

  const bboxRot = rotateBbox(bbox, cosAngle, sinAngle, width, height);

  line._angleAdj = { x: bboxRot.left - bbox.left, y: bboxRot.bottom - bbox.bottom };

  return line._angleAdj;
}

/**
 * Calculates adjustments to word x and y coordinates needed to auto-rotate the page.
 * The numbers returned are *in addition* to the adjustment applied to the entire line (calculated by `calcLineStartAngleAdj`).
 *
 * @param {OcrWord} word
 */
function calcWordAngleAdj(word) {
  // if (word._angleAdj === null) {
  if (true) {
    word._angleAdj = { x: 0, y: 0 };

    const { angle } = word.line.page;

    if (Math.abs(angle ?? 0) > 0.05) {
      const sinAngle = Math.sin(angle * (Math.PI / 180));
      const cosAngle = Math.cos(angle * (Math.PI / 180));

      const x = word.bbox.left - word.line.bbox.left;
      const y = word.bbox.bottom - (word.line.bbox.bottom + word.line.baseline[1]);

      if (word.style.sup || word.style.dropcap) {
        const tanAngle = sinAngle / cosAngle;
        const angleAdjYSup = (y - (x * tanAngle)) * cosAngle - y;

        const angleAdjXSup = angle > 0 ? 0 : angleAdjYSup * tanAngle;

        word._angleAdj = { x: 0 - angleAdjXSup, y: angleAdjYSup };
      } else {
        const angleAdjXBaseline = x / cosAngle - x;
        word._angleAdj = { x: angleAdjXBaseline, y: 0 };
      }
    }
  }

  return word._angleAdj;
}

/**
 * Replace ligatures with individual ascii characters.
 * @param {string} text
 */
function replaceLigatures(text) {
  return text.replace(/Ĳ/g, 'IJ')
    .replace(/ĳ/g, 'ij')
    .replace(/ŉ/g, 'ʼn')
    .replace(/Ǳ/g, 'DZ')
    .replace(/ǲ/g, 'Dz')
    .replace(/ǳ/g, 'dz')
    .replace(/Ǆ/g, 'DŽ')
    .replace(/ǅ/g, 'Dž')
    .replace(/ǆ/g, 'dž')
    .replace(/Ǉ/g, 'LJ')
    .replace(/ǈ/g, 'Lj')
    .replace(/ǉ/g, 'lj')
    .replace(/Ǌ/g, 'NJ')
    .replace(/ǋ/g, 'Nj')
    .replace(/ǌ/g, 'nj')
    .replace(/ﬀ/g, 'ff')
    .replace(/ﬁ/g, 'fi')
    .replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi')
    .replace(/ﬄ/g, 'ffl')
    .replace(/ﬅ/g, 'ſt')
    .replace(/ﬆ/g, 'st');
}

/**
 * Escapes XML in a string
 * @param {String} string String to escape
 * @return {String} Escaped version of a string
 */
function escapeXml(string) {
  return string.replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Re-calculate bbox for line
 * @param {OcrLine} line
 * @param {boolean} adjustBaseline - Adjust baseline so that there is no visual change due to this function.
 *
 * `adjustBaseline` should generally be `true`, as calling `updateLineBbox` is not expected to change the appearance of the baseline.
 * The only case where this argument is `false` is when the baseline is adjusted elsewhere in the code,
 * notably in `rotateLine`.
 */
function updateLineBbox(line, adjustBaseline = true) {
  const lineboxBottomOrig = line.bbox.bottom;

  const wordBoxArr = line.words.map((x) => x.bbox);

  line.bbox = calcBboxUnion(wordBoxArr);

  if (adjustBaseline) line.baseline[1] += (lineboxBottomOrig - line.bbox.bottom);
}

/**
 * Re-calculate bbox for word from character-level bboxes.
 * @param {OcrWord} word
 */
function calcWordBbox(word) {
  if (!word.chars || word.chars.length === 0) return;

  const charBoxArr = word.chars.map((x) => x.bbox);

  word.bbox = calcBboxUnion(charBoxArr);
}

/**
 * Rotates bounding box.
 * Should not be used for lines--use `rotateLine` instead.
 * @param {bbox} bbox
 * @param {number} cosAngle
 * @param {number} sinAngle
 * @param {number} width
 * @param {number} height
 */
function rotateBbox(bbox, cosAngle, sinAngle, width, height) {
  // This math is technically only correct when the angle is 0, as that is the only time when
  // the left/top/right/bottom bounds exactly match the corners of the rectangle the line was printed in.
  // This is generally fine for words (as words are generally short),
  // but results in significantly incorrect results for lines.

  const bboxOut = { ...bbox };

  const xCenter = width / 2;
  const yCenter = height / 2;

  bboxOut.left = cosAngle * (bbox.left - xCenter) - sinAngle * (bbox.bottom - yCenter) + xCenter;
  bboxOut.right = cosAngle * (bbox.right - xCenter) - sinAngle * (bbox.bottom - yCenter) + xCenter;
  bboxOut.top = sinAngle * (bbox.left - xCenter) + cosAngle * (bbox.top - yCenter) + yCenter;
  bboxOut.bottom = sinAngle * (bbox.left - xCenter) + cosAngle * (bbox.bottom - yCenter) + yCenter;

  return bboxOut;
}

/**
 * Rotates line bounding box (modifies in place).
 * @param {OcrLine} line
 * @param {number} angle
 * @param {?dims} dims
 * @param {boolean} useCharLevel - Use character-level bounding boxes for rotation (if they exist).
 *    This option should only be enabled during the import process.
 *    Once users have edited the data, some words may have incorrect character-level data.
 */
function rotateLine(line, angle, dims = null, useCharLevel = false) {
  // If the angle is 0 (or very close) return early.
  if (Math.abs(angle) <= 0.05) return;

  // TODO: Is there ever a reason to use the page dims instead of the line dims?
  const dims1 = dims || line.page.dims;

  const sinAngle = Math.sin(angle * (Math.PI / 180));
  const cosAngle = Math.cos(angle * (Math.PI / 180));

  // Add preprocessing angle to baseline angle
  const { baseline } = line;
  const baselineAngleRadXML = Math.atan(baseline[0]);
  const baselineAngleRadAdj = angle * (Math.PI / 180);
  const baselineAngleRadTotal = Math.tan(baselineAngleRadXML + baselineAngleRadAdj);

  for (let i = 0; i < line.words.length; i++) {
    const word = line.words[i];
    if (useCharLevel && word.chars && word.chars.length > 0) {
      for (let j = 0; j < word.chars.length; j++) {
        const char = word.chars[j];
        char.bbox = rotateBbox(char.bbox, cosAngle, sinAngle, dims1.width, dims1.height);
      }
      ocr.calcWordBbox(word);
    } else {
      word.bbox = rotateBbox(word.bbox, cosAngle, sinAngle, dims1.width, dims1.height);
    }
  }

  // Re-calculate line bbox by rotating original line bbox
  const lineBoxRot = rotateBbox(line.bbox, cosAngle, sinAngle, dims1.width, dims1.height);

  // Re-calculate line bbox by taking union of word bboxes
  updateLineBbox(line, false);

  // Adjust baseline
  const baselineOffsetAdj = lineBoxRot.bottom - line.bbox.bottom;

  const baselineOffsetTotal = baseline[1] + baselineOffsetAdj;

  line.baseline[0] = baselineAngleRadTotal;
  line.baseline[1] = baselineOffsetTotal;
}

/**
 * Clones page object.
 * @param {OcrPage} page
 */
function clonePage(page) {
  const pageNew = new OcrPage(page.n, { ...page.dims });
  for (const line of page.lines) {
    const lineNew = cloneLine(line);
    lineNew.page = pageNew;
    pageNew.lines.push(lineNew);
  }
  return pageNew;
}

/**
 * Clones line and included words.  Does not clone page.
 * Should be used rather than `structuredClone` for performance reasons.
 * @param {OcrLine} line
 */
function cloneLine(line) {
  const lineNew = new OcrLine(line.page, { ...line.bbox }, line.baseline.slice(), line.ascHeight, line.xHeight);
  lineNew.id = line.id;
  lineNew.debug.raw = line.debug.raw;
  for (const word of line.words) {
    const wordNew = cloneWord(word);
    wordNew.line = lineNew;
    lineNew.words.push(wordNew);
  }
  return lineNew;
}

/**
 * Clones word.  Does not clone line or page.
 * Should be used rather than `structuredClone` for performance reasons.
 * TODO: Rewrite this so it is dynamic and does not break every time we edit the properties of OcrWord.
 * @param {OcrWord} word
 */
function cloneWord(word) {
  const wordNew = new OcrWord(word.line, word.id, word.text, { ...word.bbox });
  if (word.poly) wordNew.poly = { ...word.poly };
  wordNew.conf = word.conf;
  wordNew.style = { ...word.style };
  wordNew.lang = word.lang;
  wordNew.compTruth = word.compTruth;
  wordNew.matchTruth = word.matchTruth;
  wordNew.visualCoords = word.visualCoords;
  wordNew.debug.raw = word.debug.raw;
  wordNew.footnoteParId = word.footnoteParId;
  if (word.chars) {
    wordNew.chars = [];
    for (const char of word.chars) {
      wordNew.chars.push(cloneChar(char));
    }
  }
  return wordNew;
}

/**
 * Clones char.  Does not clone word, line, or page.
 * Should be used rather than `structuredClone` for performance reasons.
 * @param {OcrChar} char
 */
function cloneChar(char) {
  const charNew = new OcrChar(char.text, { ...char.bbox });
  return charNew;
}

/**
 * Gets words that match the provided text.
 * @param {string} text
 * @param {OcrPage} ocrPage
 */
function getMatchingWords(text, ocrPage) {
  text = text.trim().toLowerCase();

  if (!text) return [];
  const textArr = text.split(' ');

  const wordArr = ocr.getPageWords(ocrPage);

  const matchArr = [];

  for (let i = 0; i < wordArr.length - (textArr.length - 1); i++) {
    const word = wordArr[i];

    if (!word.text.toLowerCase().includes(textArr[0])) continue;

    const candArr = wordArr.slice(i, i + textArr.length);
    const candText = candArr.map((x) => x.text).join(' ').toLowerCase();

    if (candText.toLowerCase().includes(text)) {
      matchArr.push(...candArr);
    }
  }

  return matchArr;
}

/**
 * Gets word IDs that match the provided text.
 * @param {string} text
 * @param {OcrPage} ocrPage
 */
function getMatchingWordIds(text, ocrPage) {
  text = text.trim().toLowerCase();

  if (!text) return [];
  const textArr = text.split(' ');

  const wordArr = ocr.getPageWords(ocrPage);

  const matchIdArr = [];

  for (let i = 0; i < wordArr.length - (textArr.length - 1); i++) {
    const word = wordArr[i];

    if (!word.text.toLowerCase().includes(textArr[0])) continue;

    const candArr = wordArr.slice(i, i + textArr.length);
    const candText = candArr.map((x) => x.text).join(' ').toLowerCase();

    if (candText.toLowerCase().includes(text)) {
      matchIdArr.push(...candArr.map((x) => x.id));
    }
  }

  return matchIdArr;
}

/**
 *
 * @param {OcrWord} word
 * @param {"invis" | "ebook" | "eval" | "proof"} displayMode
 * @param {number} [confThreshMed=75]
 * @param {number} [confThreshHigh=85]
 * @param {number} [overlayOpacity=80]
 */
export function getWordFillOpacity(word, displayMode, confThreshMed = 75, confThreshHigh = 85, overlayOpacity = 80) {
  let fillColorHex;
  if (word.conf > confThreshHigh) {
    fillColorHex = '#00ff7b';
  } else if (word.conf > confThreshMed) {
    fillColorHex = '#ffc800';
  } else {
    fillColorHex = '#ff0000';
  }

  const fillColorHexMatch = word.matchTruth ? '#00ff7b' : '#ff0000';

  let opacity;
  let fill;
  // Set current text color and opacity based on display mode selected
  if (displayMode === 'invis') {
    opacity = 0;
    fill = 'black';
  } else if (displayMode === 'ebook') {
    opacity = 1;
    fill = 'black';
  } else if (displayMode === 'eval') {
    opacity = overlayOpacity / 100;
    fill = fillColorHexMatch;
  } else {
    opacity = overlayOpacity / 100;
    fill = fillColorHex;
  }

  return { opacity, fill };
}

/**
 * Serialize the OCR data as JSON.
 * A special function is needed to remove circular references.
 * @param {Array<OcrPage>} pages - Layout data tables.
 */
export const removeCircularRefsOcr = (pages) => {
  const pagesClone = structuredClone(pages);
  pagesClone.forEach((page) => {
    // Process paragraphs - convert line references to IDs
    page.pars.forEach((par) => {
      // @ts-ignore
      delete par.page;
      // Convert lines array to array of line IDs
      // @ts-ignore
      par.lineIds = par.lines.map((line) => line.id);
      // @ts-ignore
      delete par.lines;
    });

    page.lines.forEach((line) => {
      // @ts-ignore
      delete line.page;
      // Store par ID for deserialization
      if (line.par) {
        // @ts-ignore
        line.parId = line.par.id;
      }
      // @ts-ignore
      delete line.par;
      line.words.forEach((word) => {
        // @ts-ignore
        delete word.line;
      });
    });
  });
  return pagesClone;
};

/**
 * Restores circular references to array of OcrPage objects.
 * Used to restore circular references after deserializing.
 * @param {*} pages
 * @returns {Array<OcrPage>}
 */
export const addCircularRefsOcr = (pages) => {
  pages.forEach((page) => {
    page.lines.forEach((line) => {
      line.page = page;
      line.words.forEach((word) => {
        word.line = line;
        if (word.footnoteParId === undefined) {
          word.footnoteParId = null;
        }
      });
    });

    // Initialize pars array if not present
    if (!page.pars) {
      page.pars = [];
    }

    // Restore paragraph references
    page.pars.forEach((par) => {
      par.page = page;
      // Initialize footnoteRefId to null if not present
      if (par.footnoteRefId === undefined) {
        par.footnoteRefId = null;
      }
      // Restore lines array from lineIds
      // @ts-ignore
      if (par.lineIds && !par.lines) {
        // @ts-ignore
        par.lines = par.lineIds.map((id) => page.lines.find((line) => line.id === id)).filter((line) => line !== undefined);
        // @ts-ignore
        delete par.lineIds;
      }
      // Initialize lines array if not present
      if (!par.lines) {
        par.lines = [];
      }
    });

    // Restore line.par references from parId
    page.lines.forEach((line) => {
      // @ts-ignore
      if (line.parId !== undefined) {
        // @ts-ignore
        line.par = page.pars.find((par) => par.id === line.parId) || null;
        // @ts-ignore
        delete line.parId;
      } else if (line.par === undefined) {
        line.par = null;
      }
    });
  });
  return pages;
};

/**
 * Updates OCR format to latest version.
 * This function should be modified whenever the OCR data format changes
 * to ensure backward compatibility with older .scribe files.
 * @param {OcrPage[]} pages
 */
export const updateOcrFormat = (pages) => {
  pages.forEach((page) => {
    page.lines.forEach((line) => {
      if (!line.debug) {
        line.debug = new LineDebugInfo();
        // @ts-ignore
        if (line.raw) {
          // @ts-ignore
          line.debug.raw = line.raw;
        }
      }
      // @ts-ignore
      delete line.raw;

      line.words.forEach((word) => {
        if (!word.debug) {
          word.debug = new WordDebugInfo();
          // @ts-ignore
          if (word.raw) {
            // @ts-ignore
            word.debug.raw = word.raw;
          }
        }
        // @ts-ignore
        delete word.raw;
      });
    });
  });
};

const ocr = {
  OcrPage,
  OcrPar,
  OcrLine,
  OcrWord,
  OcrChar,
  WordDebugInfo,
  LineDebugInfo,
  calcLineStartAngleAdj,
  updateLineBbox,
  calcBboxUnion,
  calcWordBbox,
  calcWordAngleAdj,
  getPageWord,
  getPageWords,
  getDistinctChars,
  getMatchingWords,
  getMatchingWordIds,
  getPageText,
  getParText,
  getLineText,
  getRegionText,
  getPrevLine,
  getNextLine,
  getWordFillOpacity,
  clonePage,
  cloneLine,
  cloneWord,
  cloneChar,
  rotateLine,
  deletePageWords,
  replaceLigatures,
  scaleLine,
  scalePage,
  escapeXml,
};

export default ocr;
