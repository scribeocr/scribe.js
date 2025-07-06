// File summary:
// Various utility functions used in other files.

// Includes all capital letters except for "J" and "Q"
export const ascCharArr = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'K', 'L', 'M', 'N', 'O', 'P', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
  'b', 'd', 'h', 'k', 'l', 't', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
export const xCharArr = ['a', 'c', 'e', 'm', 'n', 'o', 'r', 's', 'u', 'v', 'w', 'x', 'z'];
export const descCharArr = ['g', 'j', 'p', 'q', 'y'];

/**
 *
 * @param {Array<bbox>} bboxArr
 * @returns
 */
export const calcBboxUnion = (bboxArr) => ({
  left: Math.min(...bboxArr.map((x) => x.left)),
  top: Math.min(...bboxArr.map((x) => x.top)),
  right: Math.max(...bboxArr.map((x) => x.right)),
  bottom: Math.max(...bboxArr.map((x) => x.bottom)),
});

/**
 * Returns the proportion of boxA's area contained in boxB
 * @param {bbox} boxA
 * @param {bbox} boxB
 */
export function calcBoxOverlap(boxA, boxB) {
  const left = Math.max(boxA.left, boxB.left);
  const top = Math.max(boxA.top, boxB.top);
  const right = Math.min(boxA.right, boxB.right);
  const bottom = Math.min(boxA.bottom, boxB.bottom);

  const width = right - left;
  const height = bottom - top;

  if (width < 0 || height < 0) return 0;

  const areaA = (boxA.bottom - boxA.top) * (boxA.right - boxA.left);
  const area = width * height;

  return area / areaA;
}

/**
 * Returns the proportion of boxA's width contained in boxB
 * @param {bbox} boxA
 * @param {bbox} boxB
 */
export function calcHorizontalOverlap(boxA, boxB) {
  const left = Math.max(boxA.left, boxB.left);
  const right = Math.min(boxA.right, boxB.right);

  const widthOverlap = right - left;

  if (widthOverlap < 0) return 0;

  const widthA = boxA.right - boxA.left;

  return widthOverlap / widthA;
}

/**
 * Generates a random integer.
 *
 * @param {number} min - The minimum value (inclusive).
 * @param {number} max - The maximum value (exclusive).
 *
 * Taken from: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/random
 */
export function getRandomInt(min, max) {
  const minI = Math.ceil(min);
  const maxI = Math.floor(max);
  return Math.floor(Math.random() * (maxI - minI) + minI); // The maximum is exclusive and the minimum is inclusive
}

/**
 * Generates a random alphanumeric string of a specified length.
 *
 * @param {number} num - The length of the alphanumeric string to generate.
 */
export function getRandomAlphanum(num) {
  const outArr = new Array(num);
  for (let i = 0; i < num; i++) {
    let intI = getRandomInt(1, 62);
    if (intI <= 10) {
      intI += 47;
    } else if (intI <= 36) {
      intI = intI - 10 + 64;
    } else {
      intI = intI - 36 + 96;
    }
    outArr[i] = String.fromCharCode(intI);
  }
  return outArr.join('');
}

/**
 * Calculates the nth quantile of a given array of numbers.
 * @param {number[]} arr - The array of numbers.
 * @param {number} ntile - The quantile to calculate. Should be a value between 0 and 1.
 * @returns {number}
 * This function returns `null` if the array is empty, however the TypeScript definition does not reflect this.
 * Needing to implement type checks on every result is cumbersome, and generally not useful,
 * as other application logic often prevents empty arrays from being passed to this function.
 */
export function quantile(arr, ntile) {
  if (arr.length === 0) {
    // @ts-ignore
    return null;
  }
  const arr1 = [...arr];
  const mid = Math.floor(arr.length * ntile);

  // Using sort() will convert numbers to strings by default
  arr1.sort((a, b) => a - b);

  return arr1[mid];
}

/**
 *
 * @param {Array<number>} arr
 * @returns {number}
 * This function returns `null` if the array is empty, however the TypeScript definition does not reflect this.
 * Needing to implement type checks on every result is cumbersome, and generally not useful,
 * as other application logic often prevents empty arrays from being passed to this function.
 */
export const mean50 = (arr) => {
  if (arr.length === 0) {
    // @ts-ignore
    return null;
  }
  const per25 = Math.floor(arr.length / 4) - 1;
  const per75 = Math.ceil(arr.length * 3 / 4) - 1;
  const nums = [...arr].sort((a, b) => a - b);
  const numsMiddle = nums.slice(per25, per75 + 1);

  return numsMiddle.reduce((a, b) => a + b) / numsMiddle.length;
};

/**
 * Unescapes XML in a string. This should be replaced with a more robust solution.
 * @param {String} string
 * @return {String}
 */
export function unescapeXml(string) {
  const replaceFunc = (match, p1) => String.fromCharCode(parseInt(p1, 16));

  return string.replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&#34;/g, '"')
    // The prefix &#x indicates the character is encoded as hexidecimal.
    .replace(/&#x([0-9a-f]+);/g, replaceFunc)
    .replace(/\u00AD/g, '-'); // Replace soft hyphen with regular hyphen. This is unrelated to XML escaping, but should be done for all inputs.
}

// TODO: There may be duplicated approaches between `calcLang` and `getTextScript`.
// Consider whether a unified approach can be taken across the stext and hocr parsers.
/**
 * Calculates the language of a string.
 * The only return values are 'chi_sim' and 'eng', with 'chi_sim' being returned if any character is in the range of CJK Unified Ideographs.
 * @param {string} str -
 */
export function calcLang(str) {
  for (const char of str) {
    const code = char.charCodeAt(0);

    if (code >= 0 && code <= 127) continue;

    if ((code >= 0x4E00 && code <= 0x9FFF) // CJK Unified Ideographs
    || (code >= 0x3400 && code <= 0x4DBF) // CJK Unified Ideographs Extension A
    || (code >= 0x20000 && code <= 0x2A6DF) // CJK Unified Ideographs Extension B
    || (code >= 0x2A700 && code <= 0x2B73F) // CJK Unified Ideographs Extension C
    || (code >= 0x2B740 && code <= 0x2B81F) // CJK Unified Ideographs Extension D
    || (code >= 0x2B820 && code <= 0x2CEAF) // CJK Unified Ideographs Extension E
    || (code >= 0xF900 && code <= 0xFAFF) // CJK Compatibility Ideographs
    || (code >= 0x2F800 && code <= 0x2FA1F) // CJK Compatibility Ideographs Supplement
    ) return ('chi_sim');

    if ((code >= 0x0400 && code <= 0x04FF)
    || (code >= 0x0500 && code <= 0x052F)
    || code === 0x1C80
    || code === 0x1C81
    ) return ('rus');
  }

  return 'eng';
}

// Reads OCR files, which may be compressed as .gz or uncompressed

/**
 * Reads an OCR file, which may be compressed as .gz or uncompressed.
 *
 * @param {File|FileNode|string|ArrayBuffer} file - OCR file to read
 * @returns {Promise<string>} - Contents of file
 */
export async function readOcrFile(file) {
  if (file instanceof ArrayBuffer) {
    const fileUint8Array = new Uint8Array(file);

    const isGzipped = fileUint8Array[0] === 0x1F && fileUint8Array[1] === 0x8B;
    if (isGzipped) {
      const pako = await import('../../lib/pako.esm.min.js');
      file = pako.inflate(file)?.buffer;
    }
    const decoder = new TextDecoder('utf-8');
    return decoder.decode(file);
  }

  // Any string is assumed to be the file contents.
  if (typeof file === 'string') return file;

  // The `typeof process` condition is necessary to avoid error in Node.js versions <20, where `File` is not defined.
  if (typeof process === 'undefined' && file instanceof File) {
    if (/\.gz|\.scribe$/i.test(file.name)) {
      return (readTextFileGz(file));
    }
    return (readTextFile(file));
  }

  if (typeof process !== 'undefined') {
    if (!file?.fileData?.toString) throw new Error('Invalid input. Must be a FileNode, ArrayBuffer, or string.');
    // @ts-ignore
    return file.fileData.toString();
  }
  throw new Error('Invalid input. Must be a File, ArrayBuffer, or string.');
}

/**
 * Reads the contents of a Gzip-compressed text file and returns them as a promise.
 *
 * @param {File} file - The File object representing the Gzip-compressed text file to read.
 * @returns {Promise<string>} A promise that resolves with the decompressed text content of the file
 *                           or rejects with an error if reading or decompression fails.
 */
async function readTextFileGz(file) {
  const pako = await import('../../lib/pako.esm.min.js');
  return new Promise(async (resolve, reject) => {
    const zip1 = await file.arrayBuffer();
    const zip2 = await pako.inflate(zip1, { to: 'string' });
    resolve(zip2);
  });
}

/**
 * Reads the contents of a text file and returns them as a promise.
 *
 * @param {File} file - The File object representing the text file to read.
 * @returns {Promise<string>} A promise that resolves with the text content of the file
 *                           or rejects with an error if reading fails.
 */
export function readTextFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(reader.result);
    };
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

export function round3(x) {
  return (Math.round(x * 1e3) / 1e3);
}

/**
 * Rounds a number to six decimal places.
 * @param {number} x - The number to be rounded.
 * @returns {number} The rounded number.
 */
export function round6(x) {
  return (Math.round(x * 1e6) / 1e6);
}

/** Function that count occurrences of a substring in a string;
 * @param {String} string               The string
 * @param {String} subString            The sub string to search for
 * @param {Boolean} [allowOverlapping]  Optional. (Default:false)
 *
 * @author Vitim.us https://gist.github.com/victornpb/7736865
 * @see Unit Test https://jsfiddle.net/Victornpb/5axuh96u/
 * @see https://stackoverflow.com/a/7924240/938822
 */
export function countSubstringOccurrences(string, subString, allowOverlapping, caseSensitive = false) {
  string += '';
  subString += '';
  if (subString.length <= 0) return (string.length + 1);

  if (!caseSensitive) {
    string = string.toLowerCase();
    subString = subString.toLowerCase();
  }

  let n = 0;
  let pos = 0;
  const step = allowOverlapping ? 1 : subString.length;

  while (true) {
    pos = string.indexOf(subString, pos);
    if (pos >= 0) {
      ++n;
      pos += step;
    } else break;
  }
  return n;
}

/**
 * Saves a Blob or a string URL as a file to the user's computer.
 * Modified version of code found in FileSaver.js.
 *
 * @global
 * @param {string|ArrayBuffer|Blob} content
 * @param {string} fileName - File name.
 */
export const saveAs = async (content, fileName) => {
  if (typeof process !== 'undefined') {
    const { promises: fsPromises } = await import('node:fs');
    await fsPromises.writeFile(fileName, content);
    return;
  }

  let blob;
  if (typeof Blob !== 'undefined' && content instanceof Blob) {
    blob = content;
  } else {
    blob = new Blob([content], { type: 'application/octet-stream' });
  }

  const a = document.createElement('a');
  a.download = fileName;
  a.href = globalThis.URL.createObjectURL(blob);
  a.dispatchEvent(new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    view: window,
  }));
};

/**
 * Reduces an array of EvalMetrics objects into a single EvalMetrics object
 * by summing all of the corresponding properties.
 * @param {Array<EvalMetrics>} evalMetricsArr - Array of EvalMetrics objects.
 * @returns {EvalMetrics} A single EvalMetrics object with summed properties.
 */
export const reduceEvalMetrics = (evalMetricsArr) => evalMetricsArr.reduce((acc, curr) => ({
  total: acc.total + curr.total,
  correct: acc.correct + curr.correct,
  incorrect: acc.incorrect + curr.incorrect,
  missed: acc.missed + curr.missed,
  extra: acc.extra + curr.extra,
  correctLowConf: acc.correctLowConf + curr.correctLowConf,
  incorrectHighConf: acc.incorrectHighConf + curr.incorrectHighConf,
}), {
  total: 0,
  correct: 0,
  incorrect: 0,
  missed: 0,
  extra: 0,
  correctLowConf: 0,
  incorrectHighConf: 0,
});

/**
 * Delete all properties from `obj`.
 * This should be used instead of `obj = {}` to avoid creating a new object.
 * @param {Object} obj
 */
export function clearObjectProperties(obj) {
  for (const prop in obj) {
    if (Object.hasOwnProperty.call(obj, prop)) {
      delete obj[prop];
    }
  }
}

/**
 * Version of `Object.assign` that only assigns properties that are not `undefined`.
 * @param {Object} target - The target object to assign properties to.
 * @param {...Object} sources - The source objects to assign properties from.
 */
export function objectAssignDefined(target, ...sources) {
  for (const source of sources) {
    for (const key in source) {
      if (Object.hasOwnProperty.call(source, key) && source[key] !== undefined) {
        target[key] = source[key];
      }
    }
  }
  return target;
}

// Sans/serif lookup for common font families. These should not include spaces or underscores--multi-word font names should be concatenated.
// Fonts that should not be added (both Sans and Serif variants):
// DejaVu
const serifFonts = ['SerifDefault', 'Baskerville', 'Bembo', 'Bodoni', 'Bookman', 'C059', 'Calibri', 'Cambria', 'Century', 'Cheltenham', 'Courier', 'Garamond', 'Georgia',
  'LucidaBright', 'Minion', 'NimbusMono', 'Optima', 'P052', 'Palatino', 'Times'];
const sansFonts = ['SansDefault', 'Avenir', 'Arial', 'Calibri', 'Candara', 'Carlito', 'Comic', 'Franklin', 'Futura', 'Gotham', 'Gothic',
  'Helvetica', 'Impact', 'Interstate', 'Myriad', 'Tahoma', 'Trebuchet', 'Univers', 'Verdana'];

const serifFontsRegex = new RegExp(serifFonts.reduce((x, y) => `${x}|${y}`), 'i');
const sansFontsRegex = new RegExp(sansFonts.reduce((x, y) => `${x}|${y}`), 'i');

const unidentifiedFonts = new Set();

export class FontProps {
  static sansFontsDoc = new Set();

  static serifFontsDoc = new Set();

  static sizeMult = {};
}

/**
 * Given a font name from Tesseract/Abbyy XML, determine if it should be represented by sans font or serif font.
 *
 * @param {string|null|undefined} fontName - The name of the font to determine the type of. If the font name
 * is falsy, the function will return "Default".
 * @returns {('SansDefault'|'SerifDefault'|'Default')}
 */
export function determineSansSerif(fontName) {
  // Remove underscores and spaces from the font name.
  fontName = fontName?.replaceAll(/[_\s]/gi, '');

  /** @type {('SansDefault'|'SerifDefault'|'Default')} */
  let fontFamily = 'Default';
  // Font support is currently limited to 1 font for Sans and 1 font for Serif.
  if (fontName && !['Default', 'GlyphLessFont', 'HiddenHorzOCR'].includes(fontName)) {
    // First, test to see if "sans" or "serif" is in the name of the font
    if (/(^|\W|_)sans($|\W|_)/i.test(fontName)) {
      fontFamily = 'SansDefault';
    } else if (/(^|\W|_)serif($|\W|_)/i.test(fontName)) {
      fontFamily = 'SerifDefault';

    // If not, check against a list of known sans/serif fonts.
    // This list is almost certainly incomplete, so should be added to when new fonts are encountered.
    } else if (serifFontsRegex.test(fontName)) {
      fontFamily = 'SerifDefault';
    } else if (sansFontsRegex.test(fontName)) {
      fontFamily = 'SansDefault';
    } else if (fontName !== 'Default Metrics Font') {
      if (/serif|rom/i.test(fontName) && !/sans/i.test(fontName)) {
        fontFamily = 'SerifDefault';
      } else if (/san/i.test(fontName)) {
        fontFamily = 'SansDefault';
      // This comes after the hard-coded values, as the hard-coded values are considered more reliable.
      // If recognition decides the font named "Arial" is a serif font, it's probably wrong.
      } else if (FontProps.sansFontsDoc.has(fontName)) {
        fontFamily = 'SansDefault';
      } else if (FontProps.serifFontsDoc.has(fontName)) {
        fontFamily = 'SerifDefault';
      } else if (!unidentifiedFonts.has(fontName)) {
        unidentifiedFonts.add(fontName);
        console.log(`Unidentified font: ${fontName}`);
      }
    }
  }

  return fontFamily;
}

/**
 *
 * @param {Array<string>|string} text - String containing word, or array containing individual letters.
 * @returns
 */
export function getTextScript(text) {
  let han = 0;
  let latin = 0;
  const letterArr = typeof text === 'string' ? text.split('') : text;
  for (let j = 0; j < letterArr.length; j++) {
    if (/\p{Script=Han}/u.test(letterArr[j])) han++;
    if (/\p{Script=Latin}/u.test(letterArr[j])) latin++;
  }

  return { han, latin };
}

export const replaceSmartQuotes = (text) => {
  if (!/['"]/.test(text)) return text;
  return text.replace(/(^|[-–—])'/, '$1‘')
    .replace(/(^|[-–—])"/, '$1“')
    .replace(/'(?=$|[-–—])/, '’')
    .replace(/"(?=$|[-–—])/, '”')
    .replace(/([a-z])'(?=[a-z]$)/i, '$1’');
};

const superscriptMap = {
  // Superscript digits
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',

  // Superscript lowercase Latin letters
  ᵃ: 'a',
  ᵇ: 'b',
  ᶜ: 'c',
  ᵈ: 'd',
  ᵉ: 'e',
  ᶠ: 'f',
  ᵍ: 'g',
  ʰ: 'h',
  ⁱ: 'i',
  ʲ: 'j',
  ᵏ: 'k',
  ˡ: 'l',
  ᵐ: 'm',
  ⁿ: 'n',
  ᵒ: 'o',
  ᵖ: 'p',
  ʳ: 'r',
  ˢ: 's',
  ᵗ: 't',
  ᵘ: 'u',
  ᵛ: 'v',
  ʷ: 'w',
  ˣ: 'x',
  ʸ: 'y',
  ᶻ: 'z',

  // Superscript uppercase Latin letters
  ᴬ: 'A',
  ᴮ: 'B',
  ᴰ: 'D',
  ᴱ: 'E',
  ᴳ: 'G',
  ᴴ: 'H',
  ᴵ: 'I',
  ᴶ: 'J',
  ᴷ: 'K',
  ᴸ: 'L',
  ᴹ: 'M',
  ᴺ: 'N',
  ᴼ: 'O',
  ᴾ: 'P',
  ᴿ: 'R',
  ᵀ: 'T',
  ᵁ: 'U',
  ⱽ: 'V',
  ᵂ: 'W',

  // Superscript symbols and punctuation
  '⁺': '+',
  '⁻': '-',
  '⁼': '=',
  '⁽': '(',
  '⁾': ')',

};

/**
 * Converts superscript characters to their normal equivalents
 * @param {string} text - The text containing superscript characters
 * @returns {string} - The text with superscript characters converted to normal
 */
export function removeSuperscript(text) {
  if (typeof text !== 'string') {
    throw new TypeError('Input must be a string');
  }

  return text.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖʳˢᵗᵘᵛʷˣʸᶻᴬᴮᴰᴱᴳᴴᴵᴶᴷᴸᴹᴺᴼᴾᴿᵀᵁⱽᵂ⁺⁻⁼⁽⁾ᵅᵝᵞᵟᵋᶿᶥᶲᵠᵡ]/g, (match) => superscriptMap[match] || match);
}

/**
 *
 * @param {number} min - First number in the range.
 * @param {number} max - Last number in the range (inclusive).
 * @returns
 * `range(1, 5)` returns `[1, 2, 3, 4, 5]`.
 */
export function range(min, max) {
  const result = [];
  for (let i = min; i <= max; i++) {
    result.push(i);
  }
  return result;
}

// Function that logs to stderr and then waits for the log to be flushed to the console.
// This should only be used for debugging purposes.
export const debugLog = (x) => new Promise((resolve) => {
  process.stderr.write(`${String(x)}\n`, resolve);
});

/**
 *
 * @param {Partial<Style>} style
 */
export const getStyleLookup = (style) => {
  let styleStr = 'normal';
  if (style.bold && style.italic) {
    styleStr = 'boldItalic';
  } else if (style.bold) {
    styleStr = 'bold';
  } else if (style.italic) {
    styleStr = 'italic';
  }
  return styleStr;
};

/**
 * Identify specific font families and return a standardized name.
 * This function is not intended to map names to fonts supported by this program,
 * but rather simply to normalize the names of common fonts to a single name.
 */
export const cleanFamilyName = (family) => {
  let familyClean = family;
  if (/NimbusRom/i.test(family)) {
    familyClean = 'NimbusRoman';
  } else if (/TimesNewRom/i.test(family)) {
    familyClean = 'TimesNewRoman';
  } else if (/NimbusSan/i.test(family)) {
    familyClean = 'NimbusSans';
  } else if (/Helvetica/i.test(family)) {
    familyClean = 'Helvetica';
  } else if (/Arial/i.test(family)) {
    familyClean = 'Arial';
  } else if (/CenturySch/i.test(family)) {
    familyClean = 'CenturySchoolbook';
  } else if (/Palatino/i.test(family)) {
    familyClean = 'Palatino';
  } else if (/Garamond/i.test(family)) {
    familyClean = 'Garamond';
  } else if (/CenturyGothic/i.test(family)) {
    familyClean = 'CenturyGothic';
  } else if (/AvantGarde/i.test(family)) {
    familyClean = 'AvantGarde';
  } else if (/Carlito/i.test(family)) {
    familyClean = 'Carlito';
  } else if (/Calibri/i.test(family)) {
    familyClean = 'Calibri';
  } else if (/Courier/i.test(family)) {
    familyClean = 'Courier';
  } else if (/NimbusMono/i.test(family)) {
    familyClean = 'NimbusMono';
  } else if (/Dingbats/i.test(family)) {
    familyClean = 'Dingbats';
  } else if (/Wingdings/i.test(family)) {
    familyClean = 'Wingdings';
  }

  return familyClean;
};
