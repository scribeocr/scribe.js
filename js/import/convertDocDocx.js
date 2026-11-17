import ocr from '../objects/ocrObjects.js';
import { LayoutDataTablePage } from '../objects/layoutObjects.js';
import { calcWordCharMetrics } from '../utils/fontUtils.js';
import { FontCont } from '../containers/fontContainer.js';
import { unescapeXml } from '../utils/miscUtils.js';
import { symbolToUnicode, wingdingsToUnicode } from '../pdf/fonts/standardEncodings.js';

const FONT_FAMILY = 'Times New Roman';
const FONT_SIZE = 14;
const CHAR_SPACING = 0;
const WORD_SPACING = 0;
const LINE_HEIGHT = 14.4;
const MARGIN_VERTICAL = 30;
const MARGIN_HORIZONTAL = 20;

// Common abbreviations that should not trigger sentence breaks
const SENTENCE_ABBREVS = new Set([
  // Titles
  'mr', 'mrs', 'ms', 'dr', 'prof', 'rev', 'sr', 'jr',
  // Common abbreviations
  'etc', 'vs', 'vol', 'no',
  // Latin abbreviations (stored without periods)
  'eg', 'ie', 'al', 'cf',
  // Page/section references
  'p', 'pp', 'pg', 'sec', 'ch', 'art', 'cl', 'fig', 'tab', 'ex',
  // Country abbreviations (stored without periods for matching U.S., U.K., etc.)
  'us', 'uk',
]);

/**
 * Check if a word ending in punctuation represents a sentence ending.
 * @param {string} word
 * @returns {boolean}
 */
function isSentenceEnding(word) {
  const trailingPuncMatch = word.match(/^(.+[.!?])(["')\]}>]*)$/);

  if (!trailingPuncMatch && !/[.!?]$/.test(word)) {
    return false;
  }

  const coreWord = trailingPuncMatch ? trailingPuncMatch[1] : word;

  if (/[!?]$/.test(coreWord)) return true;

  if (/\.{2,}$/.test(coreWord)) return false;

  if (/^[A-Z]\.$/.test(coreWord)) return false;

  if (/\d\.$/.test(coreWord)) return false;

  const base = coreWord.slice(0, -1).toLowerCase();
  if (SENTENCE_ABBREVS.has(base)) return false;

  const withoutPeriods = coreWord.replace(/\./g, '').toLowerCase();
  if (SENTENCE_ABBREVS.has(withoutPeriods)) return false;

  return true;
}

/**
 * Calculates the advance of a string in pixels.
 * @param {string} text
 * @param {number} size
 * @param {opentypeFont} font
 */
function getTextWidth(text, size, font) {
  const charMetrics = calcWordCharMetrics(text, font);

  const advanceTotal = charMetrics.advanceArr.reduce((a, b) => a + b, 0);
  const kerningTotal = charMetrics.kerningArr.reduce((a, b) => a + b, 0);

  const wordLastGlyphMetrics = font.charToGlyph(text.at(-1)).getMetrics();
  const wordFirstGlyphMetrics = font.charToGlyph(text[0]).getMetrics();

  const wordLeftBearing = wordFirstGlyphMetrics.xMin || 0;
  const lastGlyphMax = wordLastGlyphMetrics.xMax || 0;
  const wordRightBearing = charMetrics.advanceArr[charMetrics.advanceArr.length - 1] - lastGlyphMax;

  const wordWidth1 = (advanceTotal + kerningTotal - wordLeftBearing - wordRightBearing);
  const wordWidth1Px = wordWidth1 * (size / font.unitsPerEm);
  const spacingTotalPx = (text.length - 1) * CHAR_SPACING;
  const wordWidth = wordWidth1Px + spacingTotalPx;

  return wordWidth;
}

/**
 * @typedef {Object} StyleInfo
 * @property {number | null} fontSize - Font size in points
 * @property {string | null} font - Font family name
 * @property {boolean} bold
 * @property {boolean} italic
 * @property {string | null} numId - Numbering ID from style (if style has numbering)
 * @property {number | null} ilvl - Indent level from style (if style has numbering)
 */

/**
 * @typedef {Object} ParsedStyles
 * @property {Map<string, StyleInfo>} styles - Map of style ID to style properties
 * @property {number | null} defaultFontSize - Default font size from docDefaults in points
 */

/**
 * @typedef {Object} NumberingLevel
 * @property {number} start - Starting number for this level
 * @property {string} numFmt - Number format (decimal, upperLetter, lowerLetter, lowerRoman, upperRoman, bullet)
 * @property {string} lvlText - Level text template (e.g., "%1.", "%2.%3.")
 * @property {string | null} pStyle - Paragraph style linked to this level
 */

/**
 * @typedef {Object} AbstractNum
 * @property {Map<number, NumberingLevel>} levels - Map of indent level to level definition
 */

/**
 * @typedef {Object} ParsedNumbering
 * @property {Map<string, AbstractNum>} abstractNums - Map of abstractNumId to abstract number definition
 * @property {Map<string, string>} numIdToAbstractNumId - Map of numId to abstractNumId
 * @property {Map<string, {numId: string, ilvl: number}>} styleToNumbering - Map of style name to numId/ilvl
 */

/**
 * Parse numbering.xml from docx to extract numbering definitions
 * @param {string} numberingXml - The content of word/numbering.xml
 * @returns {ParsedNumbering}
 */
export function parseNumbering(numberingXml) {
  /** @type {Map<string, AbstractNum>} */
  const abstractNums = new Map();
  /** @type {Map<string, string>} */
  const numIdToAbstractNumId = new Map();
  /** @type {Map<string, {numId: string, ilvl: number}>} */
  const styleToNumbering = new Map();

  // Parse abstract numbering definitions
  const abstractNumMatches = numberingXml.matchAll(/<w:abstractNum\s+w:abstractNumId="([^"]+)"[^>]*>(.*?)<\/w:abstractNum>/gs);

  for (const match of abstractNumMatches) {
    const abstractNumId = match[1];
    const content = match[2];

    /** @type {Map<number, NumberingLevel>} */
    const levels = new Map();

    const levelMatches = content.matchAll(/<w:lvl\s+w:ilvl="(\d+)"[^>]*>(.*?)<\/w:lvl>/gs);

    for (const lvlMatch of levelMatches) {
      const ilvl = parseInt(lvlMatch[1], 10);
      const lvlContent = lvlMatch[2];

      const startMatch = lvlContent.match(/<w:start\s+w:val="(\d+)"/);
      const numFmtMatch = lvlContent.match(/<w:numFmt\s+w:val="([^"]+)"/);
      const lvlTextMatch = lvlContent.match(/<w:lvlText\s+w:val="([^"]*)"/);
      const pStyleMatch = lvlContent.match(/<w:pStyle\s+w:val="([^"]+)"/);

      levels.set(ilvl, {
        start: startMatch ? parseInt(startMatch[1], 10) : 1,
        numFmt: numFmtMatch ? numFmtMatch[1] : 'decimal',
        lvlText: lvlTextMatch ? lvlTextMatch[1] : '',
        pStyle: pStyleMatch ? pStyleMatch[1] : null,
      });

      // If this level is linked to a style, record the mapping
      if (pStyleMatch) {
        styleToNumbering.set(pStyleMatch[1], { numId: '', ilvl });
      }
    }

    abstractNums.set(abstractNumId, { levels });
  }

  // Parse num elements to map numId to abstractNumId
  const numMatches = numberingXml.matchAll(/<w:num\s+w:numId="([^"]+)"[^>]*>.*?<w:abstractNumId\s+w:val="([^"]+)".*?<\/w:num>/gs);

  for (const match of numMatches) {
    const numId = match[1];
    const abstractNumId = match[2];
    numIdToAbstractNumId.set(numId, abstractNumId);

    // Update styleToNumbering with actual numId
    const abstractNum = abstractNums.get(abstractNumId);
    if (abstractNum) {
      for (const [ilvl, level] of abstractNum.levels) {
        if (level.pStyle && styleToNumbering.has(level.pStyle)) {
          styleToNumbering.set(level.pStyle, { numId, ilvl });
        }
      }
    }
  }

  return { abstractNums, numIdToAbstractNumId, styleToNumbering };
}

/**
 * Convert number to Roman numeral
 * @param {number} num
 */
const toRoman = (num) => {
  const romanNumerals = [
    ['M', 1000], ['CM', 900], ['D', 500], ['CD', 400],
    ['C', 100], ['XC', 90], ['L', 50], ['XL', 40],
    ['X', 10], ['IX', 9], ['V', 5], ['IV', 4], ['I', 1],
  ];
  let result = '';
  for (const [letter, value] of romanNumerals) {
    while (num >= /** @type {number} */ (value)) {
      result += letter;
      num -= /** @type {number} */ (value);
    }
  }
  return result;
};

/**
 * @param {number} num
 * @param {string} numFmt
 */
function formatNumber(num, numFmt) {
  switch (numFmt) {
    case 'decimal':
      return String(num);
    case 'upperLetter':
      return String.fromCharCode(64 + ((num - 1) % 26) + 1);
    case 'lowerLetter':
      return String.fromCharCode(96 + ((num - 1) % 26) + 1);
    case 'upperRoman':
      return toRoman(num);
    case 'lowerRoman':
      return toRoman(num).toLowerCase();
    case 'bullet':
      return '•';
    default:
      return String(num);
  }
}

/**
 * @param {string} numId
 * @param {number} ilvl - Indent level
 * @param {ParsedNumbering} numberingData
 * @param {Map<string, number[]>} counters
 */
function generateMarker(numId, ilvl, numberingData, counters) {
  const abstractNumId = numberingData.numIdToAbstractNumId.get(numId);
  if (!abstractNumId) return undefined;

  const abstractNum = numberingData.abstractNums.get(abstractNumId);
  if (!abstractNum) return undefined;

  const level = abstractNum.levels.get(ilvl);
  if (!level || level.numFmt === 'bullet') return undefined;

  /** @param {number} i */
  const getStartValue = (i) => (abstractNum.levels.get(i)?.start ?? 1) - 1;

  if (!counters.has(numId)) {
    counters.set(numId, Array.from({ length: 10 }, (_, i) => getStartValue(i)));
  }

  const levelCounters = /** @type {number[]} */ (counters.get(numId));

  levelCounters[ilvl]++;

  // Reset counters for deeper levels
  for (let i = ilvl + 1; i < levelCounters.length; i++) {
    levelCounters[i] = getStartValue(i);
  }

  // Build the formatted number from lvlText template by replacing %1, %2, etc.
  let result = level.lvlText;
  for (let i = 0; i <= ilvl; i++) {
    const lvl = abstractNum.levels.get(i);
    if (lvl) {
      result = result.replace(new RegExp(`%${i + 1}`, 'g'), formatNumber(levelCounters[i], lvl.numFmt));
    }
  }

  // Remove trailing period and any remaining placeholders
  result = result.replace(/%\d+/g, '').replace(/\.$/, '');

  return result || undefined;
}

/**
 * Parse styles.xml from docx to extract style definitions
 * @param {string} stylesXml - The content of word/styles.xml
 * @returns {ParsedStyles} Parsed styles including default font size
 */
export function parseStyles(stylesXml) {
  /** @type {Map<string, StyleInfo>} */
  const styles = new Map();
  let defaultFontSize = null;

  const docDefaultsMatch = stylesXml.match(/<w:docDefaults>.*?<\/w:docDefaults>/s);
  if (docDefaultsMatch) {
    const defaultSzMatch = docDefaultsMatch[0].match(/<w:sz\s+w:val="(\d+)"/);
    if (defaultSzMatch) {
      defaultFontSize = parseInt(defaultSzMatch[1], 10) / 2;
    }
  }

  const styleMatches = stylesXml.matchAll(/<w:style\s+[^>]*w:styleId="([^"]+)"[^>]*>(.*?)<\/w:style>/gs);

  for (const styleMatch of styleMatches) {
    const styleId = styleMatch[1];
    const styleContent = styleMatch[2];

    /** @type {StyleInfo} */
    const styleInfo = {
      fontSize: null,
      font: null,
      bold: false,
      italic: false,
      numId: null,
      ilvl: null,
    };

    const szMatch = styleContent.match(/<w:sz\s+w:val="(\d+)"/);
    if (szMatch) {
      styleInfo.fontSize = parseInt(szMatch[1], 10) / 2;
    }

    const fontMatch = styleContent.match(/<w:rFonts\s+[^>]*w:ascii="([^"]+)"/);
    if (fontMatch) {
      styleInfo.font = unescapeXml(fontMatch[1]);
    }

    styleInfo.bold = /<w:b\s*\/>/.test(styleContent) || /<w:b\s+w:val="true"/.test(styleContent) || /<w:b\s+w:val="1"/.test(styleContent);

    styleInfo.italic = /<w:i\s*\/>/.test(styleContent) || /<w:i\s+w:val="true"/.test(styleContent) || /<w:i\s+w:val="1"/.test(styleContent);

    styles.set(styleId, styleInfo);
  }

  return { styles, defaultFontSize };
}

/**
 * @typedef {Object} RunStyles
 * @property {boolean} bold
 * @property {boolean} italic
 * @property {boolean} smallCaps
 * @property {boolean} underline
 * @property {boolean} sup
 * @property {string | null} font
 * @property {number | null} fontSize
 */

/**
 * One piece of a run's inline content.
 * @typedef {Object} RunItem
 * @property {string} [text]
 * @property {string} [footnoteId] - The footnote a `<w:footnoteReference>` points to.
 * @property {boolean} [customMark] - Whether that reference prints a mark of its own in place of a number.
 * @property {boolean} [footnoteRef] - Set for `<w:footnoteRef/>`, where a note prints its number.
 */

/**
 * Parse a docx run element (<w:r>) into its styles and its inline content in document order.
 * @param {string} runXml
 * @returns {{styles: RunStyles, items: Array<RunItem>}}
 */
function parseRunElement(runXml) {
  /** @type {RunStyles} */
  const styles = {
    bold: /<w:b\s*\/>/.test(runXml) || /<w:b\s+w:val="true"/.test(runXml) || /<w:b\s+w:val="1"/.test(runXml),
    italic: /<w:i\s*\/>/.test(runXml) || /<w:i\s+w:val="true"/.test(runXml) || /<w:i\s+w:val="1"/.test(runXml),
    smallCaps: /<w:smallCaps\s*\/>/.test(runXml) || /<w:smallCaps\s+w:val="true"/.test(runXml) || /<w:smallCaps\s+w:val="1"/.test(runXml),
    underline: /<w:u\s+w:val="single"/.test(runXml) || (/<w:u\s*\/>/.test(runXml) && !/<w:u\s+w:val="none"/.test(runXml)),
    sup: /<w:vertAlign\s+w:val="superscript"/.test(runXml),
    font: null,
    fontSize: null,
  };

  const fontMatch = runXml.match(/<w:rFonts\s+[^>]*w:ascii="([^"]+)"/);
  if (fontMatch) {
    styles.font = unescapeXml(fontMatch[1]);
  } else {
    const fontMatchHAnsi = runXml.match(/<w:rFonts\s+[^>]*w:hAnsi="([^"]+)"/);
    if (fontMatchHAnsi) {
      styles.font = unescapeXml(fontMatchHAnsi[1]);
    }
  }

  const szMatch = runXml.match(/<w:sz\s+w:val="(\d+)"/);
  if (szMatch) {
    styles.fontSize = parseInt(szMatch[1], 10) / 2;
  }

  /** @type {Array<RunItem>} */
  const items = [];
  for (const match of runXml.matchAll(/<w:(t|sym|tab|br|cr|noBreakHyphen|footnoteReference|footnoteRef)(?=[\s/>])([^>]*?)(?:\/>|>([^<]*)<\/w:t>)/g)) {
    const attrs = match[2];
    let text = '';
    if (match[1] === 't') {
      text = unescapeXml(match[3] ?? '');
    } else if (match[1] === 'sym') {
      const symFont = (/w:font="([^"]*)"/.exec(attrs)?.[1] ?? '').toLowerCase();
      const code = parseInt(/w:char="([0-9A-Fa-f]{1,4})"/.exec(attrs)?.[1] ?? '', 16);
      // Word stores a symbol font's character at its own code or shifted by 0xF000 into the private use area.
      const fontCode = code >= 0xF000 && code <= 0xF0FF ? code - 0xF000 : code;
      /** @type {Record<number, number>|undefined} */
      const symTable = symFont === 'symbol' ? symbolToUnicode : symFont === 'wingdings' ? wingdingsToUnicode : undefined;
      const mapped = symTable?.[fontCode];
      if (mapped !== undefined) {
        text = String.fromCodePoint(mapped);
      } else if (code >= 0x20 && (code < 0xD800 || code > 0xF8FF)) {
        text = String.fromCodePoint(code);
      }
    } else if (match[1] === 'tab') {
      text = '\t';
    } else if (match[1] === 'br' || match[1] === 'cr') {
      text = ' ';
    } else if (match[1] === 'noBreakHyphen') {
      text = '-';
    } else if (match[1] === 'footnoteReference') {
      const idMatch = /w:id="([^"]+)"/.exec(attrs);
      if (idMatch) items.push({ footnoteId: idMatch[1], customMark: /w:customMarkFollows="(?:1|true|on)"/.test(attrs) });
    } else {
      items.push({ footnoteRef: true });
    }

    if (!text) continue;
    const lastItem = items[items.length - 1];
    if (lastItem && lastItem.text !== undefined) {
      lastItem.text += text;
    } else {
      items.push({ text });
    }
  }

  return { styles, items };
}

/**
 * @typedef {Object} ParsedFootnote
 * @property {Array<{text: string, styles: RunStyles}>} runs
 * @property {string} [paraId] - The paragraph ID from Word (w14:paraId attribute)
 * @property {string} [openingToken] - The first word of the note's text, where a custom-marked note prints its mark.
 *    A Symbol-font asterisk (U+2217) in it is stored as a typed one.
 *    Empty for a note that holds `<w:footnoteRef/>`, which prints its number there.
 */

/**
 * Parse footnotes from docx footnotes.xml content
 * @param {string} footnotesXml
 * @returns {Map<string, ParsedFootnote>}
 */
export function parseFootnotes(footnotesXml) {
  /** @type {Map<string, ParsedFootnote>} */
  const footnotes = new Map();

  const footnoteMatches = footnotesXml.matchAll(/<w:footnote\s+[^>]*w:id="([^"]+)"[^>]*>(.*?)<\/w:footnote>/gs);

  for (const footnoteMatch of footnoteMatches) {
    const footnoteId = footnoteMatch[1];
    const footnoteContent = footnoteMatch[2];

    // Skip separator footnotes (id -1 and 0 are typically separators)
    if (footnoteId === '-1' || footnoteId === '0') continue;

    const parMatch = footnoteContent.match(/<w:p([^>]*)>/);
    const parAttrs = parMatch ? parMatch[1] : '';
    const paraIdMatch = parAttrs.match(/w14:paraId="([^"]+)"/);
    const paraId = paraIdMatch ? paraIdMatch[1] : undefined;

    const runs = [];
    let hasFootnoteRef = false;
    const runMatches = footnoteContent.matchAll(/<w:r[^>]*>(.*?)<\/w:r>/gs);

    for (const runMatch of runMatches) {
      const parsed = parseRunElement(runMatch[1]);
      for (const item of parsed.items) {
        if (item.footnoteRef) hasFootnoteRef = true;
        if (item.text) runs.push({ text: item.text, styles: parsed.styles });
      }
    }

    if (runs.length > 0) {
      const openingToken = hasFootnoteRef ? '' : (/^\s*(\S+)/.exec(runs[0].text) || ['', ''])[1].replace(/\u2217/g, '*');
      footnotes.set(footnoteId, { runs, paraId, openingToken });
    }
  }

  return footnotes;
}

/**
 * @typedef {'title' | 'body' | 'footnote'} ParType
 */

/**
 * @typedef {Object} ParsedRun
 * @property {string} text
 * @property {RunStyles} styles
 * @property {string} [footnoteId] - If set, this run is a footnote reference with this ID
 */

/**
 * @typedef {Object} ParsedParagraph
 * @property {Array<ParsedRun>} runs
 * @property {ParType} type
 * @property {string} [footnoteId] - If type is 'footnote', this is the footnote ID
 * @property {number} [footnoteIndex] - If type is 'footnote', its 1-based number among the auto-numbered footnotes.
 *    A custom-marked footnote has none.
 * @property {string} [footnoteMark] - If type is 'footnote', the mark Word shows for it, its number or its custom mark.
 *    A note whose custom mark could not be read has none.
 * @property {string} [paraId] - The paragraph ID from Word (w14:paraId attribute)
 * @property {string} [marker] - The list marker as Word renders it, if numbered
 * @property {string | null} [styleId] - The Word style ID (e.g., "Heading1", "Normal")
 */

/**
 * Parse paragraphs from docx document.xml content
 * @param {string} docXml
 * @param {Map<string, ParsedFootnote>} [footnotesMap]
 * @param {Map<string, StyleInfo>} [stylesMap]
 * @param {number | null} [defaultFontSize]
 * @param {ParsedNumbering | null} [numberingData]
 * @returns {Array<ParsedParagraph>}
 */
export function parseParagraphs(docXml, footnotesMap = new Map(), stylesMap = new Map(), defaultFontSize = null, numberingData = null) {
  /** @type {Array<ParsedParagraph>} */
  const paragraphs = [];
  /** @type {Array<string>} */
  const footnoteOrder = [];
  /** @type {Map<string, {label: string, index?: number}>} */
  const footnoteMarks = new Map();
  let autoNumbered = 0;

  /** @type {Map<string, number[]>} */
  const numberingCounters = new Map();

  const paragraphMatches = docXml.matchAll(/<w:p([^>]*)>(.*?)<\/w:p>/gs);

  for (const parMatch of paragraphMatches) {
    const parAttrs = parMatch[1];
    const parContent = parMatch[2];

    // Extract Word paragraph ID from w14:paraId attribute
    const paraIdMatch = parAttrs.match(/w14:paraId="([^"]+)"/);
    const paraId = paraIdMatch ? paraIdMatch[1] : undefined;
    /** @type {Array<ParsedRun>} */
    const runs = [];

    const pStyleMatch = parContent.match(/<w:pStyle\s+w:val="([^"]+)"/);
    const styleId = pStyleMatch ? pStyleMatch[1] : null;
    /** @type {ParType} */
    let parType = 'body';
    if (styleId) {
      const styleName = styleId.toLowerCase();
      if (styleName === 'title' || styleName.startsWith('heading') || styleName.startsWith('toc')) {
        parType = 'title';
      } else if (styleName.startsWith('quote') || styleName === 'intensequote') {
        parType = 'blockquote';
      }
    }

    const parStyle = styleId ? stylesMap.get(styleId) : null;

    // Extract paragraph numbering
    let marker;
    if (numberingData && styleId) {
      const styleNum = numberingData.styleToNumbering.get(styleId);
      if (styleNum) {
        marker = generateMarker(styleNum.numId, styleNum.ilvl, numberingData, numberingCounters);
      }
    }

    /** @type {Array<{styles: RunStyles, items: Array<RunItem>}>} */
    const parRuns = [];
    for (const runMatch of parContent.matchAll(/<w:r[^>]*>(.*?)<\/w:r>/gs)) {
      const parsed = parseRunElement(runMatch[1]);
      if (parsed.items.length === 0) continue;
      if (parsed.styles.fontSize === null) {
        if (parStyle?.fontSize) {
          parsed.styles.fontSize = parStyle.fontSize;
        } else if (defaultFontSize !== null) {
          parsed.styles.fontSize = defaultFontSize;
        }
      }
      if (parsed.styles.font === null && parStyle?.font) {
        parsed.styles.font = parStyle.font;
      }
      parRuns.push(parsed);
    }

    for (let r = 0; r < parRuns.length; r++) {
      const { styles, items } = parRuns[r];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.text) runs.push({ text: item.text, styles });
        const footnoteData = item.footnoteId === undefined ? undefined : footnotesMap.get(item.footnoteId);
        if (item.footnoteId === undefined || !footnoteData) continue;

        let label = '';
        if (item.customMark) {
          // The mark follows its reference in the same run.
          // Text in the next run is the mark only when the note opens with it, so that body text is never taken for a mark.
          const nextInRun = items[i + 1];
          const markItem = nextInRun || parRuns[r + 1]?.items[0];
          const token = (/^\S+/.exec(markItem?.text ?? '') || [''])[0];
          // A Symbol-font asterisk (U+2217) and a typed one mark the same note.
          const tokenTyped = token.replace(/\u2217/g, '*');
          const bareLength = tokenTyped.replace(/[.,;:!?)\]]+$/, '').length;
          if (token && tokenTyped === footnoteData.openingToken) {
            label = token;
          } else if (bareLength > 0 && tokenTyped.slice(0, bareLength) === footnoteData.openingToken) {
            label = token.slice(0, bareLength);
          } else if (nextInRun) {
            label = token;
          }
          if (markItem && label) markItem.text = /** @type {string} */ (markItem.text).slice(label.length);
        }

        if (!footnoteMarks.has(item.footnoteId)) {
          footnoteOrder.push(item.footnoteId);
          // A custom mark takes no number, since Word leaves custom-marked notes out of the count.
          footnoteMarks.set(item.footnoteId, item.customMark ? { label } : { label: String(++autoNumbered), index: autoNumbered });
        }
        if (!item.customMark) label = /** @type {{label: string}} */ (footnoteMarks.get(item.footnoteId)).label;
        if (label) runs.push({ text: label, styles: { ...styles, sup: true }, footnoteId: item.footnoteId });
      }
    }

    if (runs.length > 0) {
      paragraphs.push({
        runs, type: parType, paraId, marker, styleId,
      });
    }
  }

  if (footnoteOrder.length > 0) {
    const footnoteTextStyle = stylesMap.get('FootnoteText');
    const footnoteFontSize = footnoteTextStyle?.fontSize ?? defaultFontSize;

    for (const footnoteId of footnoteOrder) {
      const footnoteData = footnotesMap.get(footnoteId);
      if (footnoteData) {
        const mark = /** @type {{label: string, index?: number}} */ (footnoteMarks.get(footnoteId));
        /** @type {Array<ParsedRun>} */
        const footnoteParagraphRuns = [];

        let noteRuns = footnoteData.runs;
        // A custom-marked note opens with its mark as text, which the paragraph's marker carries instead.
        if (mark.index === undefined && mark.label && mark.label.replace(/\u2217/g, '*') === footnoteData.openingToken) {
          noteRuns = [{ text: noteRuns[0].text.trimStart().slice(mark.label.length), styles: noteRuns[0].styles }, ...noteRuns.slice(1)];
        }

        for (const run of noteRuns) {
          const runWithSize = {
            text: run.text,
            styles: {
              ...run.styles,
              fontSize: run.styles.fontSize ?? footnoteFontSize,
            },
          };
          footnoteParagraphRuns.push(runWithSize);
        }

        paragraphs.push({
          runs: footnoteParagraphRuns, type: 'footnote', footnoteId, footnoteIndex: mark.index, footnoteMark: mark.label || undefined, paraId: footnoteData.paraId, styleId: 'FootnoteText',
        });
      }
    }
  }

  return paragraphs;
}

/**
 * Convert a docx file to internal OCR format
 * @param {Object} params
 * @param {ArrayBuffer} params.docxData - The docx file data
 * @param {?{width: number, height: number}} [params.pageDims] - Page dimensions (will be calculated if not provided)
 * @param {'width' | 'sentence'} [params.lineSplitMode='width'] - How to split text into lines: 'width' splits based on page width, 'sentence' splits at sentence endings
 */
export async function convertDocDocx({ docxData, pageDims = null, lineSplitMode = 'width' }) {
  const zipModule = await import('../../lib/zip.js/index.js');

  const blob = new Blob([docxData]);

  const zipReader = new zipModule.ZipReader(new zipModule.BlobReader(blob));
  const entries = await zipReader.getEntries();

  const documentEntry = entries.find((entry) => entry.filename === 'word/document.xml');
  if (!documentEntry) {
    throw new Error('No word/document.xml found in docx file');
  }

  const writer = new zipModule.BlobWriter();
  await documentEntry.getData(writer);
  const documentBlob = await writer.getData();
  const documentXml = await documentBlob.text();

  // Read footnotes.xml if it exists
  let footnotesXml = null;
  const footnotesEntry = entries.find((entry) => entry.filename === 'word/footnotes.xml');
  if (footnotesEntry) {
    const footnotesWriter = new zipModule.BlobWriter();
    await footnotesEntry.getData(footnotesWriter);
    const footnotesBlob = await footnotesWriter.getData();
    footnotesXml = await footnotesBlob.text();
  }

  // Read styles.xml if it exists
  let stylesXml = null;
  const stylesEntry = entries.find((entry) => entry.filename === 'word/styles.xml');
  if (stylesEntry) {
    const stylesWriter = new zipModule.BlobWriter();
    await stylesEntry.getData(stylesWriter);
    const stylesBlob = await stylesWriter.getData();
    stylesXml = await stylesBlob.text();
  }

  // Read numbering.xml if it exists
  let numberingXml = null;
  const numberingEntry = entries.find((entry) => entry.filename === 'word/numbering.xml');
  if (numberingEntry) {
    const numberingWriter = new zipModule.BlobWriter();
    await numberingEntry.getData(numberingWriter);
    const numberingBlob = await numberingWriter.getData();
    numberingXml = await numberingBlob.text();
  }

  await zipReader.close();

  const pagesOut = await convertDocumentXML({
    documentXml, footnotesXml, stylesXml, numberingXml, pageDims, lineSplitMode,
  });

  return pagesOut;
}

/**
 * Convert a docx file to internal OCR format
 * @param {Object} params
 * @param {string} params.documentXml
 * @param {?string} [params.footnotesXml] - The content of word/footnotes.xml (optional)
 * @param {?string} [params.stylesXml] - The content of word/styles.xml (optional)
 * @param {?string} [params.numberingXml] - The content of word/numbering.xml (optional)
 * @param {?{width: number, height: number}} [params.pageDims] - Page dimensions (will be calculated if not provided)
 * @param {'width' | 'sentence'} [params.lineSplitMode='width'] - How to split text into lines: 'width' splits based on page width, 'sentence' splits at sentence endings
 */
const convertDocumentXML = async ({
  documentXml, footnotesXml = null, stylesXml = null, numberingXml = null, pageDims = null, lineSplitMode = 'width',
}) => {
  const fontOpentype = (await FontCont.getFont({ font: FONT_FAMILY })).opentype;

  const ASCENDER_HEIGHT = fontOpentype.ascender * (FONT_SIZE / fontOpentype.unitsPerEm);
  const DESCENDER_HEIGHT = fontOpentype.descender * (FONT_SIZE / fontOpentype.unitsPerEm);

  if (!pageDims) {
    pageDims = { width: 612, height: 792 };
  }

  const footnotesMap = footnotesXml ? parseFootnotes(footnotesXml) : new Map();
  const parsedStyles = stylesXml ? parseStyles(stylesXml) : { styles: new Map(), defaultFontSize: null };
  const numberingData = numberingXml ? parseNumbering(numberingXml) : null;

  const paragraphs = parseParagraphs(documentXml, footnotesMap, parsedStyles.styles, parsedStyles.defaultFontSize, numberingData);

  const pagesOut = [];
  let pageIndex = 0;
  let pageObj = new ocr.OcrPage(pageIndex, pageDims);
  pageObj.textSource = 'docx';
  let tablesPage = new LayoutDataTablePage(0);
  pagesOut.push({ pageObj, dataTables: tablesPage });

  const availableWidth = pageDims.width - MARGIN_HORIZONTAL * 2;
  let currentY = MARGIN_VERTICAL + LINE_HEIGHT / 2;

  // Track footnote reference words by their footnote ID for linking
  /** @type {Map<string, Array<import('../objects/ocrObjects.js').OcrWord>>} */
  const footnoteRefWords = new Map();

  for (const paragraph of paragraphs) {
    // Check if we need a new page before starting this paragraph
    if (currentY + FONT_SIZE > pageDims.height - MARGIN_VERTICAL) {
      pageIndex++;
      const newPage = new ocr.OcrPage(pageIndex, pageDims);
      newPage.textSource = 'docx';
      const newTables = new LayoutDataTablePage(pageIndex);
      pagesOut.push({ pageObj: newPage, dataTables: newTables });
      pageObj = newPage;
      tablesPage = newTables;
      currentY = MARGIN_VERTICAL + LINE_HEIGHT / 2;
    }

    const parLines = [];
    let parRight = MARGIN_HORIZONTAL;
    let runIndex = 0;
    let charIndexInRun = 0;
    const parRuns = paragraph.runs;
    const parType = paragraph.type;
    const parFootnoteId = paragraph.footnoteId;
    const parFootnoteMark = paragraph.footnoteMark;
    const parParaId = paragraph.paraId;
    const parMarker = paragraph.marker;
    const parStyleId = paragraph.styleId;

    while (runIndex < parRuns.length) {
      const baseline = [0, DESCENDER_HEIGHT];
      const lineTop = Math.round(currentY - ASCENDER_HEIGHT);
      const lineBottom = Math.round(currentY - DESCENDER_HEIGHT);

      const lineBbox = {
        left: MARGIN_HORIZONTAL,
        top: lineTop,
        right: MARGIN_HORIZONTAL,
        bottom: lineBottom,
      };
      const lineObj = new ocr.OcrLine(
        pageObj,
        lineBbox,
        baseline,
        ASCENDER_HEIGHT,
        null,
      );

      let currentX = MARGIN_HORIZONTAL;
      let lineComplete = false;
      let lastItemWasWhitespace = false;
      let lastWordIsRef = false;
      let pendingSentenceEnd = false;

      while (runIndex < parRuns.length && !lineComplete) {
        const run = parRuns[runIndex];
        const remainingText = run.text.substring(charIndexInRun);

        const words = remainingText.split(/(\s+)/);

        for (let wordIdx = 0; wordIdx < words.length; wordIdx++) {
          const word = words[wordIdx];
          if (word.length === 0) continue;

          const isWhitespace = /^\s+$/.test(word);

          if (isWhitespace) {
            if (lineSplitMode === 'sentence' && pendingSentenceEnd) {
              lineComplete = true;
              break;
            }
            const runFontSize = run.styles.fontSize || FONT_SIZE;
            const spaceWidth = getTextWidth(' ', runFontSize, fontOpentype) + WORD_SPACING;
            currentX += spaceWidth;
            charIndexInRun += word.length;
            lastItemWasWhitespace = true;
          } else {
            const runFontSize = run.styles.fontSize || FONT_SIZE;

            // Check if we should append to the previous word (word continues across runs)
            // Only append if: we're at the start of a new run AND the last item was NOT whitespace
            // A footnote reference stays a word of its own, since its link is a property of the whole word.
            const lastWord = lineObj.words[lineObj.words.length - 1];
            const stylesMatch = lastWord && lastWord.style.sup === run.styles.sup && lastWord.style.size === run.styles.fontSize;
            const shouldAppend = lastWord && wordIdx === 0 && charIndexInRun === 0 && !lastItemWasWhitespace && stylesMatch
              && !run.footnoteId && !lastWordIsRef;

            if (shouldAppend) {
              const combinedText = lastWord.text + word;
              const combinedWidth = getTextWidth(combinedText, runFontSize, fontOpentype);

              if (lineSplitMode !== 'sentence' && lastWord.bbox.left + combinedWidth > MARGIN_HORIZONTAL + availableWidth) {
                lineComplete = true;
                break;
              }

              const tailStyle = lastWord.styleRuns && lastWord.styleRuns.length > 0
                ? { ...lastWord.style, ...lastWord.styleRuns[lastWord.styleRuns.length - 1].style }
                : lastWord.style;
              if (tailStyle.bold !== run.styles.bold || tailStyle.italic !== run.styles.italic
                || tailStyle.smallCaps !== run.styles.smallCaps) {
                const delta = {};
                if (run.styles.bold !== lastWord.style.bold) delta.bold = run.styles.bold;
                if (run.styles.italic !== lastWord.style.italic) delta.italic = run.styles.italic;
                if (run.styles.smallCaps !== lastWord.style.smallCaps) delta.smallCaps = run.styles.smallCaps;
                lastWord.styleRuns = lastWord.styleRuns || [];
                lastWord.styleRuns.push({ i: lastWord.text.length, style: delta });
              }

              lastWord.text = combinedText;
              lastWord.bbox.right = Math.round(lastWord.bbox.left + combinedWidth);
              currentX = lastWord.bbox.right;
              charIndexInRun += word.length;
            } else {
              // Superscripts are typically rendered at ~60% of normal font size
              const supFontSizeRatio = 0.6;
              const effectiveFontSize = run.styles.sup ? runFontSize * supFontSizeRatio : runFontSize;
              const wordWidth = getTextWidth(word, effectiveFontSize, fontOpentype);

              if (lineSplitMode !== 'sentence' && lineObj.words.length > 0
                && currentX + wordWidth > MARGIN_HORIZONTAL + availableWidth) {
                lineComplete = true;
                break;
              }

              const wordAscenderHeight = fontOpentype.ascender * (runFontSize / fontOpentype.unitsPerEm);
              const wordDescenderHeight = fontOpentype.descender * (runFontSize / fontOpentype.unitsPerEm);

              // For superscripts, adjust vertical position to be above the baseline
              // The baseline is at currentY (from DESCENDER_HEIGHT), so superscripts should be above it
              let wordTop = Math.round(currentY - wordAscenderHeight);
              let wordBottom = Math.round(currentY - wordDescenderHeight);
              if (run.styles.sup) {
                // Superscript height is proportional to the reduced font size
                const supHeight = wordAscenderHeight * supFontSizeRatio;
                // Position superscript with its bottom at the x-height (roughly 70% of ascender)
                const xHeight = wordAscenderHeight * 0.7;
                wordBottom = Math.round(currentY - xHeight);
                wordTop = Math.round(wordBottom - supHeight);
              }

              const wordBbox = {
                left: Math.round(currentX),
                top: wordTop,
                right: Math.round(currentX + wordWidth),
                bottom: wordBottom,
              };
              const wordId = `word_${pageIndex + 1}_${pageObj.lines.length + 1}_${lineObj.words.length + 1}`;
              const wordObj = new ocr.OcrWord(lineObj, wordId, word, wordBbox);
              wordObj.conf = 100;
              wordObj.style.font = run.styles.font || FONT_FAMILY;

              wordObj.style.bold = run.styles.bold;
              wordObj.style.italic = run.styles.italic;
              wordObj.style.smallCaps = run.styles.smallCaps;
              wordObj.style.underline = run.styles.underline;
              wordObj.style.sup = run.styles.sup;
              wordObj.style.size = run.styles.fontSize;

              wordObj.visualCoords = false;

              if (run.footnoteId) {
                const refWords = footnoteRefWords.get(run.footnoteId);
                if (refWords) {
                  refWords.push(wordObj);
                } else {
                  footnoteRefWords.set(run.footnoteId, [wordObj]);
                }
              }
              lastWordIsRef = !!run.footnoteId;

              lineObj.words.push(wordObj);
              currentX += wordWidth;
              charIndexInRun += word.length;

              if (lineSplitMode === 'sentence' && isSentenceEnding(word)) {
                pendingSentenceEnd = true;
              }
            }
            lastItemWasWhitespace = false;
          }
        }

        if (charIndexInRun >= run.text.length) {
          runIndex++;
          charIndexInRun = 0;
        }

        if (lineComplete) break;
      }

      if (lineObj.words.length > 0) {
        lineObj.bbox = {
          left: lineObj.words[0].bbox.left,
          top: lineTop,
          right: lineObj.words[lineObj.words.length - 1].bbox.right,
          bottom: lineBottom,
        };

        pageObj.lines.push(lineObj);
        parLines.push(lineObj);
        parRight = Math.max(parRight, lineObj.bbox.right);
      }

      currentY += LINE_HEIGHT;
    }

    if (parLines.length > 0) {
      const parBbox = {
        left: MARGIN_HORIZONTAL,
        top: parLines[0].bbox.top,
        right: parRight,
        bottom: parLines[parLines.length - 1].bbox.bottom,
      };
      const parObj = new ocr.OcrPar(pageObj, parBbox);
      if (parParaId) parObj.id = parParaId;
      parObj.lines = parLines;
      parObj.type = parType;
      if (parMarker) {
        parObj.marker = parMarker;
      } else if (parFootnoteMark !== undefined) {
        parObj.marker = parFootnoteMark;
      }
      if (parStyleId) parObj.debug.sourceStyle = parStyleId;
      for (const ln of parLines) ln.par = parObj;

      // Link footnote paragraphs to their reference words (bidirectional)
      if (parFootnoteId) {
        const refWords = footnoteRefWords.get(parFootnoteId);
        if (refWords) {
          parObj.footnoteRefId = refWords[0].id;
          for (const refWord of refWords) refWord.footnoteParId = parObj.id;
        }
      }

      pageObj.pars.push(parObj);
    }
  }

  return pagesOut;
};
