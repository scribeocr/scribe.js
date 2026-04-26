// Core infrastructure: types, encoding, parsing, table construction
// Merged from: check.js, util.js, types.js, parse.js, table.js

// --- check ---
// Run-time checking of preconditions.

function fail(message) {
  throw new Error(message);
}

// Precondition function that checks if the given predicate is true.
// If not, it will throw an error.
function argument(predicate, message) {
  if (!predicate) {
    fail(message);
  }
}

const check = { fail, argument, assert: argument };

function checkArgument(expression, message) {
  if (!expression) {
    throw message;
  }
}

// --- types ---
// Data types used in the OpenType font file.
// All OpenType fonts use Motorola-style byte ordering (Big Endian)

const LIMIT16 = 32768; // The limit at which a 16-bit number switches signs == 2^15
const LIMIT32 = 2147483648; // The limit at which a 32-bit number switches signs == 2 ^ 31

/**
 * @exports opentype.decode
 * @class
 */
const decode = {};
/**
 * @exports opentype.encode
 * @class
 */
const encode = {};
/**
 * @exports opentype.sizeOf
 * @class
 */
const sizeOf = {};

// Return a function that always returns the same value.
function constant(v) {
  return function () {
    return v;
  };
}

// OpenType data types //////////////////////////////////////////////////////

/**
 * Convert an 8-bit unsigned integer to a list of 1 byte.
 * @param {number} v
 * @returns {Array}
 */
encode.BYTE = function (v) {
  check.argument(v >= 0 && v <= 255, 'Byte value should be between 0 and 255.');
  return [v];
};
/**
 * @constant
 * @type {number}
 */
sizeOf.BYTE = constant(1);

/**
 * Convert a 8-bit signed integer to a list of 1 byte.
 * @param {string} v
 * @returns {Array}
 */
encode.CHAR = function (v) {
  return [v.charCodeAt(0)];
};

/**
 * @constant
 * @type {number}
 */
sizeOf.CHAR = constant(1);

/**
 * Convert an ASCII string to a list of bytes.
 * @param {string} v
 * @returns {Array}
 */
encode.CHARARRAY = function (v) {
  if (typeof v === 'undefined') {
    v = '';
    console.warn('Undefined CHARARRAY encountered and treated as an empty string. This is probably caused by a missing glyph name.');
  }
  const b = [];
  for (let i = 0; i < v.length; i += 1) {
    b[i] = v.charCodeAt(i);
  }

  return b;
};

/**
 * @param {Array} v
 * @returns {number}
 */
sizeOf.CHARARRAY = function (v) {
  if (typeof v === 'undefined') {
    return 0;
  }
  return v.length;
};

/**
 * Convert a 16-bit unsigned integer to a list of 2 bytes.
 * @param {number} v
 * @returns {Array}
 */
encode.USHORT = function (v) {
  return [(v >> 8) & 0xFF, v & 0xFF];
};

/**
 * @constant
 * @type {number}
 */
sizeOf.USHORT = constant(2);

/**
 * Convert a 16-bit signed integer to a list of 2 bytes.
 * @param {number} v
 * @returns {Array}
 */
encode.SHORT = function (v) {
  // Two's complement
  if (v >= LIMIT16) {
    v = -(2 * LIMIT16 - v);
  }

  return [(v >> 8) & 0xFF, v & 0xFF];
};

/**
 * @constant
 * @type {number}
 */
sizeOf.SHORT = constant(2);

/**
 * Convert a 24-bit unsigned integer to a list of 3 bytes.
 * @param {number} v
 * @returns {Array}
 */
encode.UINT24 = function (v) {
  return [(v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF];
};

/**
 * @constant
 * @type {number}
 */
sizeOf.UINT24 = constant(3);

/**
 * Convert a 32-bit unsigned integer to a list of 4 bytes.
 * @param {number} v
 * @returns {Array}
 */
encode.ULONG = function (v) {
  return [(v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF];
};

/**
 * @constant
 * @type {number}
 */
sizeOf.ULONG = constant(4);

/**
 * Convert a 32-bit unsigned integer to a list of 4 bytes.
 * @param {number} v
 * @returns {Array}
 */
encode.LONG = function (v) {
  // Two's complement
  if (v >= LIMIT32) {
    v = -(2 * LIMIT32 - v);
  }

  return [(v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF];
};

/**
 * @constant
 * @type {number}
 */
sizeOf.LONG = constant(4);

encode.FIXED = encode.ULONG;
sizeOf.FIXED = sizeOf.ULONG;

encode.FWORD = encode.SHORT;
sizeOf.FWORD = sizeOf.SHORT;

encode.UFWORD = encode.USHORT;
sizeOf.UFWORD = sizeOf.USHORT;

/**
 * Convert a 32-bit Apple Mac timestamp integer to a list of 8 bytes, 64-bit timestamp.
 * @param {number} v
 * @returns {Array}
 */
encode.LONGDATETIME = function (v) {
  return [0, 0, 0, 0, (v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF];
};

/**
 * @constant
 * @type {number}
 */
sizeOf.LONGDATETIME = constant(8);

/**
 * Convert a 4-char tag to a list of 4 bytes.
 * @param {string} v
 * @returns {Array}
 */
encode.TAG = function (v) {
  check.argument(v.length === 4, 'Tag should be exactly 4 ASCII characters.');
  return [v.charCodeAt(0),
    v.charCodeAt(1),
    v.charCodeAt(2),
    v.charCodeAt(3)];
};

/**
 * @constant
 * @type {number}
 */
sizeOf.TAG = constant(4);

// CFF data types ///////////////////////////////////////////////////////////

encode.Card8 = encode.BYTE;
sizeOf.Card8 = sizeOf.BYTE;

encode.Card16 = encode.USHORT;
sizeOf.Card16 = sizeOf.USHORT;

encode.OffSize = encode.BYTE;
sizeOf.OffSize = sizeOf.BYTE;

encode.SID = encode.USHORT;
sizeOf.SID = sizeOf.USHORT;

// Convert a numeric operand or charstring number to a variable-size list of bytes.
/**
 * Convert a numeric operand or charstring number to a variable-size list of bytes.
 * @param {number} v
 * @returns {Array}
 */
encode.NUMBER = function (v) {
  if (v >= -107 && v <= 107) {
    return [v + 139];
  } if (v >= 108 && v <= 1131) {
    v -= 108;
    return [(v >> 8) + 247, v & 0xFF];
  } if (v >= -1131 && v <= -108) {
    v = -v - 108;
    return [(v >> 8) + 251, v & 0xFF];
  } if (v >= -32768 && v <= 32767) {
    return encode.NUMBER16(v);
  }
  return encode.NUMBER32(v);
};

/**
 * @param {number} v
 * @returns {number}
 */
sizeOf.NUMBER = function (v) {
  return encode.NUMBER(v).length;
};

/**
 * Convert a signed number between -32768 and +32767 to a three-byte value.
 * This ensures we always use three bytes, but is not the most compact format.
 * @param {number} v
 * @returns {Array}
 */
encode.NUMBER16 = function (v) {
  return [28, (v >> 8) & 0xFF, v & 0xFF];
};

/**
 * @constant
 * @type {number}
 */
sizeOf.NUMBER16 = constant(3);

/**
 * Convert a signed number between -(2^31) and +(2^31-1) to a five-byte value.
 * This is useful if you want to be sure you always use four bytes,
 * at the expense of wasting a few bytes for smaller numbers.
 * @param {number} v
 * @returns {Array}
 */
encode.NUMBER32 = function (v) {
  return [29, (v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF];
};

/**
 * @constant
 * @type {number}
 */
sizeOf.NUMBER32 = constant(5);

/**
 * @param {number} v
 * @returns {Array}
 */
encode.REAL = function (v) {
  let value = v.toString();

  // Some numbers use an epsilon to encode the value. (e.g. JavaScript will store 0.0000001 as 1e-7)
  // This code converts it back to a number without the epsilon.
  const m = /\.(\d*?)(?:9{5,20}|0{5,20})\d{0,2}(?:e(.+)|$)/.exec(value);
  if (m) {
    const epsilon = parseFloat(`1e${(m[2] ? +m[2] : 0) + m[1].length}`);
    value = (Math.round(v * epsilon) / epsilon).toString();
  }

  let nibbles = '';
  for (let i = 0, ii = value.length; i < ii; i += 1) {
    const c = value[i];
    if (c === 'e') {
      nibbles += value[++i] === '-' ? 'c' : 'b';
    } else if (c === '.') {
      nibbles += 'a';
    } else if (c === '-') {
      nibbles += 'e';
    } else {
      nibbles += c;
    }
  }

  nibbles += (nibbles.length & 1) ? 'f' : 'ff';
  const out = [30];
  for (let i = 0, ii = nibbles.length; i < ii; i += 2) {
    out.push(parseInt(nibbles.substr(i, 2), 16));
  }

  return out;
};

/**
 * @param {number} v
 * @returns {number}
 */
sizeOf.REAL = function (v) {
  return encode.REAL(v).length;
};

encode.NAME = encode.CHARARRAY;
sizeOf.NAME = sizeOf.CHARARRAY;

encode.STRING = encode.CHARARRAY;
sizeOf.STRING = sizeOf.CHARARRAY;

/**
 * @param {DataView} data
 * @param {number} offset
 * @param {number} numBytes
 * @returns {string}
 */
decode.UTF8 = function (data, offset, numBytes) {
  const codePoints = [];
  const numChars = numBytes;
  for (let j = 0; j < numChars; j++, offset += 1) {
    codePoints[j] = data.getUint8(offset);
  }

  return String.fromCharCode.apply(null, codePoints);
};

/**
 * @param {DataView} data
 * @param {number} offset
 * @param {number} numBytes
 * @returns {string}
 */
decode.UTF16 = function (data, offset, numBytes) {
  const codePoints = [];
  const numChars = numBytes / 2;
  for (let j = 0; j < numChars; j++, offset += 2) {
    codePoints[j] = data.getUint16(offset);
  }

  return String.fromCharCode.apply(null, codePoints);
};

/**
 * Convert a JavaScript string to UTF16-BE.
 * @param {string} v
 * @returns {Array}
 */
encode.UTF16 = function (v) {
  const b = [];
  for (let i = 0; i < v.length; i += 1) {
    const codepoint = v.charCodeAt(i);
    b[b.length] = (codepoint >> 8) & 0xFF;
    b[b.length] = codepoint & 0xFF;
  }

  return b;
};

/**
 * @param {string} v
 * @returns {number}
 */
sizeOf.UTF16 = function (v) {
  return v.length * 2;
};

// Data for converting old eight-bit Macintosh encodings to Unicode.
// This representation is optimized for decoding; encoding is slower
// and needs more memory. The assumption is that all opentype.js users
// want to open fonts, but saving a font will be comparatively rare
// so it can be more expensive. Keyed by IANA character set name.
//
// Python script for generating these strings:
//
//     s = u''.join([chr(c).decode('mac_greek') for c in range(128, 256)])
//     print(s.encode('utf-8'))
/**
 * @private
 */
const eightBitMacEncodings = {
  'x-mac-croatian': // Python: 'mac_croatian'
    'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®Š™´¨≠ŽØ∞±≤≥∆µ∂∑∏š∫ªºΩžø'
    + '¿¡¬√ƒ≈Ć«Č… ÀÃÕŒœĐ—“”‘’÷◊©⁄€‹›Æ»–·‚„‰ÂćÁčÈÍÎÏÌÓÔđÒÚÛÙıˆ˜¯πË˚¸Êæˇ',
  'x-mac-cyrillic': // Python: 'mac_cyrillic'
    'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ†°Ґ£§•¶І®©™Ђђ≠Ѓѓ∞±≤≥іµґЈЄєЇїЉљЊњ'
    + 'јЅ¬√ƒ≈∆«»… ЋћЌќѕ–—“”‘’÷„ЎўЏџ№Ёёяабвгдежзийклмнопрстуфхцчшщъыьэю',
  'x-mac-gaelic': // http://unicode.org/Public/MAPPINGS/VENDORS/APPLE/GAELIC.TXT
    'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØḂ±≤≥ḃĊċḊḋḞḟĠġṀæø'
    + 'ṁṖṗɼƒſṠ«»… ÀÃÕŒœ–—“”‘’ṡẛÿŸṪ€‹›Ŷŷṫ·Ỳỳ⁊ÂÊÁËÈÍÎÏÌÓÔ♣ÒÚÛÙıÝýŴŵẄẅẀẁẂẃ',
  'x-mac-greek': // Python: 'mac_greek'
    'Ä¹²É³ÖÜ΅àâä΄¨çéèêë£™îï•½‰ôö¦€ùûü†ΓΔΘΛΞΠß®©ΣΪ§≠°·Α±≤≥¥ΒΕΖΗΙΚΜΦΫΨΩ'
    + 'άΝ¬ΟΡ≈Τ«»… ΥΧΆΈœ–―“”‘’÷ΉΊΌΎέήίόΏύαβψδεφγηιξκλμνοπώρστθωςχυζϊϋΐΰ\u00AD',
  'x-mac-icelandic': // Python: 'mac_iceland'
    'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûüÝ°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø'
    + '¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€ÐðÞþý·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ',
  'x-mac-inuit': // http://unicode.org/Public/MAPPINGS/VENDORS/APPLE/INUIT.TXT
    'ᐃᐄᐅᐆᐊᐋᐱᐲᐳᐴᐸᐹᑉᑎᑏᑐᑑᑕᑖᑦᑭᑮᑯᑰᑲᑳᒃᒋᒌᒍᒎᒐᒑ°ᒡᒥᒦ•¶ᒧ®©™ᒨᒪᒫᒻᓂᓃᓄᓅᓇᓈᓐᓯᓰᓱᓲᓴᓵᔅᓕᓖᓗ'
    + 'ᓘᓚᓛᓪᔨᔩᔪᔫᔭ… ᔮᔾᕕᕖᕗ–—“”‘’ᕘᕙᕚᕝᕆᕇᕈᕉᕋᕌᕐᕿᖀᖁᖂᖃᖄᖅᖏᖐᖑᖒᖓᖔᖕᙱᙲᙳᙴᙵᙶᖖᖠᖡᖢᖣᖤᖥᖦᕼŁł',
  'x-mac-ce': // Python: 'mac_latin2'
    'ÄĀāÉĄÖÜáąČäčĆćéŹźĎíďĒēĖóėôöõúĚěü†°Ę£§•¶ß®©™ę¨≠ģĮįĪ≤≥īĶ∂∑łĻļĽľĹĺŅ'
    + 'ņŃ¬√ńŇ∆«»… ňŐÕőŌ–—“”‘’÷◊ōŔŕŘ‹›řŖŗŠ‚„šŚśÁŤťÍŽžŪÓÔūŮÚůŰűŲųÝýķŻŁżĢˇ',
  macintosh: // Python: 'mac_roman'
    'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø'
    + '¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ',
  'x-mac-romanian': // Python: 'mac_romanian'
    'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ĂȘ∞±≤≥¥µ∂∑∏π∫ªºΩăș'
    + '¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›Țț‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ',
  'x-mac-turkish': // Python: 'mac_turkish'
    'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø'
    + '¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸĞğİıŞş‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙˆ˜¯˘˙˚¸˝˛ˇ',
};

/**
 * Decodes an old-style Macintosh string. Returns either a Unicode JavaScript
 * string, or 'undefined' if the encoding is unsupported. For example, we do
 * not support Chinese, Japanese or Korean because these would need large
 * mapping tables.
 * @param {DataView} dataView
 * @param {number} offset
 * @param {number} dataLength
 * @param {string} encoding
 * @returns {string}
 */
decode.MACSTRING = function (dataView, offset, dataLength, encoding) {
  const table = eightBitMacEncodings[encoding];
  if (table === undefined) {
    return undefined;
  }

  let result = '';
  for (let i = 0; i < dataLength; i++) {
    const c = dataView.getUint8(offset + i);
    // In all eight-bit Mac encodings, the characters 0x00..0x7F are
    // mapped to U+0000..U+007F; we only need to look up the others.
    if (c <= 0x7F) {
      result += String.fromCharCode(c);
    } else {
      result += table[c & 0x7F];
    }
  }

  return result;
};

// Helper function for encode.MACSTRING. Returns a dictionary for mapping
// Unicode character codes to their 8-bit MacOS equivalent. This table
// is not exactly a super cheap data structure, but we do not care because
// encoding Macintosh strings is only rarely needed in typical applications.
const macEncodingTableCache = typeof WeakMap === 'function' && new WeakMap();
let macEncodingCacheKeys;
const getMacEncodingTable = function (encoding) {
  // Since we use encoding as a cache key for WeakMap, it has to be
  // a String object and not a literal. And at least on NodeJS 2.10.1,
  // WeakMap requires that the same String instance is passed for cache hits.
  if (!macEncodingCacheKeys) {
    macEncodingCacheKeys = {};
    for (const e in eightBitMacEncodings) {
      /* jshint -W053 */ // Suppress "Do not use String as a constructor."
      macEncodingCacheKeys[e] = new String(e);
    }
  }

  const cacheKey = macEncodingCacheKeys[encoding];
  if (cacheKey === undefined) {
    return undefined;
  }

  // We can't do "if (cache.has(key)) {return cache.get(key)}" here:
  // since garbage collection may run at any time, it could also kick in
  // between the calls to cache.has() and cache.get(). In that case,
  // we would return 'undefined' even though we do support the encoding.
  if (macEncodingTableCache) {
    const cachedTable = macEncodingTableCache.get(cacheKey);
    if (cachedTable !== undefined) {
      return cachedTable;
    }
  }

  const decodingTable = eightBitMacEncodings[encoding];
  if (decodingTable === undefined) {
    return undefined;
  }

  const encodingTable = {};
  for (let i = 0; i < decodingTable.length; i++) {
    encodingTable[decodingTable.charCodeAt(i)] = i + 0x80;
  }

  if (macEncodingTableCache) {
    macEncodingTableCache.set(cacheKey, encodingTable);
  }

  return encodingTable;
};

/**
 * Encodes an old-style Macintosh string. Returns a byte array upon success.
 * If the requested encoding is unsupported, or if the input string contains
 * a character that cannot be expressed in the encoding, the function returns
 * 'undefined'.
 * @param {string} str
 * @param {string} encoding
 * @returns {Array}
 */
encode.MACSTRING = function (str, encoding) {
  const table = getMacEncodingTable(encoding);
  if (table === undefined) {
    return undefined;
  }

  const result = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);

    // In all eight-bit Mac encodings, the characters 0x00..0x7F are
    // mapped to U+0000..U+007F; we only need to look up the others.
    if (c >= 0x80) {
      c = table[c];
      if (c === undefined) {
        // str contains a Unicode character that cannot be encoded
        // in the requested encoding.
        return undefined;
      }
    }
    result[i] = c;
    // result.push(c);
  }

  return result;
};

/**
 * @param {string} str
 * @param {string} encoding
 * @returns {number}
 */
sizeOf.MACSTRING = function (str, encoding) {
  const b = encode.MACSTRING(str, encoding);
  if (b !== undefined) {
    return b.length;
  }
  return 0;
};

// Helper for encode.VARDELTAS
function isByteEncodable(value) {
  return value >= -128 && value <= 127;
}

// Helper for encode.VARDELTAS
function encodeVarDeltaRunAsZeroes(deltas, pos, result) {
  let runLength = 0;
  const numDeltas = deltas.length;
  while (pos < numDeltas && runLength < 64 && deltas[pos] === 0) {
    ++pos;
    ++runLength;
  }
  result.push(0x80 | (runLength - 1));
  return pos;
}

// Helper for encode.VARDELTAS
function encodeVarDeltaRunAsBytes(deltas, offset, result) {
  let runLength = 0;
  const numDeltas = deltas.length;
  let pos = offset;
  while (pos < numDeltas && runLength < 64) {
    const value = deltas[pos];
    if (!isByteEncodable(value)) {
      break;
    }

    // Within a byte-encoded run of deltas, a single zero is best
    // stored literally as 0x00 value. However, if we have two or
    // more zeroes in a sequence, it is better to start a new run.
    // Fore example, the sequence of deltas [15, 15, 0, 15, 15]
    // becomes 6 bytes (04 0F 0F 00 0F 0F) when storing the zero
    // within the current run, but 7 bytes (01 0F 0F 80 01 0F 0F)
    // when starting a new run.
    if (value === 0 && pos + 1 < numDeltas && deltas[pos + 1] === 0) {
      break;
    }

    ++pos;
    ++runLength;
  }
  result.push(runLength - 1);
  for (let i = offset; i < pos; ++i) {
    result.push((deltas[i] + 256) & 0xff);
  }
  return pos;
}

// Helper for encode.VARDELTAS
function encodeVarDeltaRunAsWords(deltas, offset, result) {
  let runLength = 0;
  const numDeltas = deltas.length;
  let pos = offset;
  while (pos < numDeltas && runLength < 64) {
    const value = deltas[pos];

    // Within a word-encoded run of deltas, it is easiest to start
    // a new run (with a different encoding) whenever we encounter
    // a zero value. For example, the sequence [0x6666, 0, 0x7777]
    // needs 7 bytes when storing the zero inside the current run
    // (42 66 66 00 00 77 77), and equally 7 bytes when starting a
    // new run (40 66 66 80 40 77 77).
    if (value === 0) {
      break;
    }

    // Within a word-encoded run of deltas, a single value in the
    // range (-128..127) should be encoded within the current run
    // because it is more compact. For example, the sequence
    // [0x6666, 2, 0x7777] becomes 7 bytes when storing the value
    // literally (42 66 66 00 02 77 77), but 8 bytes when starting
    // a new run (40 66 66 00 02 40 77 77).
    if (isByteEncodable(value) && pos + 1 < numDeltas && isByteEncodable(deltas[pos + 1])) {
      break;
    }

    ++pos;
    ++runLength;
  }
  result.push(0x40 | (runLength - 1));
  for (let i = offset; i < pos; ++i) {
    const val = deltas[i];
    result.push(((val + 0x10000) >> 8) & 0xff, (val + 0x100) & 0xff);
  }
  return pos;
}

/**
 * Encode a list of variation adjustment deltas.
 *
 * Variation adjustment deltas are used in ‘gvar’ and ‘cvar’ tables.
 * They indicate how points (in ‘gvar’) or values (in ‘cvar’) get adjusted
 * when generating instances of variation fonts.
 *
 * @see https://www.microsoft.com/typography/otspec/gvar.htm
 * @see https://developer.apple.com/fonts/TrueType-Reference-Manual/RM06/Chap6gvar.html
 * @param {Array} deltas
 * @return {Array}
 */
encode.VARDELTAS = function (deltas) {
  let pos = 0;
  const result = [];
  while (pos < deltas.length) {
    const value = deltas[pos];
    if (value === 0) {
      pos = encodeVarDeltaRunAsZeroes(deltas, pos, result);
    } else if (value >= -128 && value <= 127) {
      pos = encodeVarDeltaRunAsBytes(deltas, pos, result);
    } else {
      pos = encodeVarDeltaRunAsWords(deltas, pos, result);
    }
  }
  return result;
};

// Convert a list of values to a CFF INDEX structure.
// The values should be objects containing name / type / value.
/**
 * @param {Array} l
 * @returns {Array}
 */
encode.INDEX = function (l) {
  if (l.length === 0) {
    return [0, 0];
  }

  // First pass: encode each item and record its bytes and offset.
  const encodedItems = new Array(l.length);
  let totalDataSize = 0;
  for (let i = 0; i < l.length; i += 1) {
    const v = encode.OBJECT(l[i]);
    encodedItems[i] = v;
    totalDataSize += v.length;
  }

  // Determine offset size from the final offset value.
  const lastOffset = totalDataSize + 1;
  const offSize = (1 + Math.floor(Math.log(lastOffset) / Math.log(2)) / 8) | 0;

  // Pre-allocate the full result array.
  // Layout: count(2) + offSize(1) + offsets((count+1) * offSize) + data
  const offsetTableSize = (l.length + 1) * offSize;
  const headerSize = 2 + 1 + offsetTableSize;
  const result = new Array(headerSize + totalDataSize);

  // Write count (Card16).
  result[0] = (l.length >> 8) & 0xFF;
  result[1] = l.length & 0xFF;
  // Write offSize.
  result[2] = offSize;

  // Write offset table and copy data in a single pass.
  let dataPos = headerSize;
  let curOffset = 1;
  for (let i = 0; i < l.length; i += 1) {
    // Write offset for item i.
    const offPos = 3 + i * offSize;
    if (offSize === 1) {
      result[offPos] = curOffset & 0xFF;
    } else if (offSize === 2) {
      result[offPos] = (curOffset >> 8) & 0xFF;
      result[offPos + 1] = curOffset & 0xFF;
    } else if (offSize === 3) {
      result[offPos] = (curOffset >> 16) & 0xFF;
      result[offPos + 1] = (curOffset >> 8) & 0xFF;
      result[offPos + 2] = curOffset & 0xFF;
    } else {
      result[offPos] = (curOffset >> 24) & 0xFF;
      result[offPos + 1] = (curOffset >> 16) & 0xFF;
      result[offPos + 2] = (curOffset >> 8) & 0xFF;
      result[offPos + 3] = curOffset & 0xFF;
    }

    // Copy item data.
    const itemBytes = encodedItems[i];
    for (let j = 0; j < itemBytes.length; j += 1) {
      result[dataPos++] = itemBytes[j];
    }

    curOffset += itemBytes.length;
  }

  // Write final sentinel offset (for item count + 1).
  const lastOffPos = 3 + l.length * offSize;
  if (offSize === 1) {
    result[lastOffPos] = curOffset & 0xFF;
  } else if (offSize === 2) {
    result[lastOffPos] = (curOffset >> 8) & 0xFF;
    result[lastOffPos + 1] = curOffset & 0xFF;
  } else if (offSize === 3) {
    result[lastOffPos] = (curOffset >> 16) & 0xFF;
    result[lastOffPos + 1] = (curOffset >> 8) & 0xFF;
    result[lastOffPos + 2] = curOffset & 0xFF;
  } else {
    result[lastOffPos] = (curOffset >> 24) & 0xFF;
    result[lastOffPos + 1] = (curOffset >> 16) & 0xFF;
    result[lastOffPos + 2] = (curOffset >> 8) & 0xFF;
    result[lastOffPos + 3] = curOffset & 0xFF;
  }

  return result;
};

/**
 * @param {Array} v
 * @returns {number}
 */
sizeOf.INDEX = function (v) {
  if (v.length === 0) {
    return 2;
  }

  let dataSize = 0;
  for (let i = 0; i < v.length; i += 1) {
    dataSize += sizeOf.OBJECT(v[i]);
  }

  const lastOffset = dataSize + 1;
  const offSize = (1 + Math.floor(Math.log(lastOffset) / Math.log(2)) / 8) | 0;
  // count (2 bytes) + offSize (1 byte) + offset array ((count + 1) * offSize) + data
  return 2 + 1 + (v.length + 1) * offSize + dataSize;
};

/**
 * Convert an object to a CFF DICT structure.
 * The keys should be numeric.
 * The values should be objects containing name / type / value.
 * @param {Object} m
 * @returns {Array}
 */
encode.DICT = function (m) {
  const d = [];
  const keys = Object.keys(m);
  const length = keys.length;

  for (let i = 0; i < length; i += 1) {
    // Object.keys() return string keys, but our keys are always numeric.
    const k = parseInt(keys[i], 0);
    const v = m[k];
    // Value comes before the key.
    const enc1 = encode.OPERAND(v.value, v.type);
    const enc2 = encode.OPERATOR(k);
    for (let j = 0; j < enc1.length; j++) {
      d.push(enc1[j]);
    }
    for (let j = 0; j < enc2.length; j++) {
      d.push(enc2[j]);
    }
  }

  return d;
};

/**
 * @param {Object} m
 * @returns {number}
 */
sizeOf.DICT = function (m) {
  return encode.DICT(m).length;
};

/**
 * @param {number} v
 * @returns {Array}
 */
encode.OPERATOR = function (v) {
  if (v < 1200) {
    return [v];
  }
  return [12, v - 1200];
};

/**
 * @param {Array} v
 * @param {string} type
 * @returns {Array}
 */
encode.OPERAND = function (v, type) {
  const d = [];
  if (Array.isArray(type)) {
    for (let i = 0; i < type.length; i += 1) {
      check.argument(v.length === type.length, `Not enough arguments given for type${type}`);
      const enc1 = encode.OPERAND(v[i], type[i]);
      for (let j = 0; j < enc1.length; j++) {
        d.push(enc1[j]);
      }
    }
  } else if (type === 'SID') {
    const enc1 = encode.NUMBER(v);
    for (let j = 0; j < enc1.length; j++) {
      d.push(enc1[j]);
    }
  } else if (type === 'offset') {
    // We make it easy for ourselves and always encode offsets as
    // 4 bytes. This makes offset calculation for the top dict easier.
    const enc1 = encode.NUMBER32(v);
    for (let j = 0; j < enc1.length; j++) {
      d.push(enc1[j]);
    }
  } else if (type === 'number') {
    const enc1 = encode.NUMBER(v);
    for (let j = 0; j < enc1.length; j++) {
      d.push(enc1[j]);
    }
  } else if (type === 'real') {
    const enc1 = encode.REAL(v);
    for (let j = 0; j < enc1.length; j++) {
      d.push(enc1[j]);
    }
  } else {
    throw new Error(`Unknown operand type ${type}`);
    // FIXME Add support for booleans
  }

  return d;
};

encode.OP = encode.BYTE;
sizeOf.OP = sizeOf.BYTE;

// memoize charstring encoding using WeakMap if available
const wmm = typeof WeakMap === 'function' && new WeakMap();

/**
 * Convert a list of CharString operations to bytes.
 * @param {Array} ops
 * @returns {Array}
 */
encode.CHARSTRING = function (ops) {
  // See encode.MACSTRING for why we don't do "if (wmm && wmm.has(ops))".
  if (wmm) {
    const cachedValue = wmm.get(ops);
    if (cachedValue !== undefined) {
      return cachedValue;
    }
  }

  const d = [];
  const length = ops.length;

  for (let i = 0; i < length; i += 1) {
    const op = ops[i];
    const enc1 = encode[op.type](op.value);
    for (let j = 0; j < enc1.length; j++) {
      d.push(enc1[j]);
    }
  }

  if (wmm) {
    wmm.set(ops, d);
  }

  return d;
};

/**
 * @param {Array} ops
 * @returns {number}
 */
sizeOf.CHARSTRING = function (ops) {
  return encode.CHARSTRING(ops).length;
};

// Utility functions ////////////////////////////////////////////////////////

/**
 * Convert an object containing name / type / value to bytes.
 * @param {Object} v
 * @returns {Array}
 */
encode.OBJECT = function (v) {
  const encodingFunction = encode[v.type];
  check.argument(encodingFunction !== undefined, `No encoding function for type ${v.type}`);
  return encodingFunction(v.value);
};

/**
 * @param {Object} v
 * @returns {number}
 */
sizeOf.OBJECT = function (v) {
  const sizeOfFunction = sizeOf[v.type];
  check.argument(sizeOfFunction !== undefined, `No sizeOf function for type ${v.type}`);
  return sizeOfFunction(v.value);
};

/**
 * Convert a table object to bytes.
 * A table contains a list of fields containing the metadata (name, type and default value).
 * The table itself has the field values set as attributes.
 * @param {Table} table
 * @returns {Array}
 */
encode.TABLE = function (table) {
  const d = [];
  const length = table.fields.length;
  const subtables = [];
  const subtableOffsets = [];

  for (let i = 0; i < length; i += 1) {
    const field = table.fields[i];
    const encodingFunction = encode[field.type];
    check.argument(encodingFunction !== undefined, `No encoding function for field type ${field.type} (${field.name})`);
    let value = table[field.name];
    if (value === undefined) {
      value = field.value;
    }

    const bytes = encodingFunction(value);

    if (field.type === 'TABLE') {
      subtableOffsets.push(d.length);
      d.push(...[0, 0]);
      subtables.push(bytes);
    } else {
      for (let j = 0; j < bytes.length; j++) {
        d.push(bytes[j]);
      }
    }
  }

  for (let i = 0; i < subtables.length; i += 1) {
    const o = subtableOffsets[i];
    const offset = d.length;
    check.argument(offset < 65536, `Table ${table.tableName} too big.`);
    d[o] = offset >> 8;
    d[o + 1] = offset & 0xff;
    for (let j = 0; j < subtables[i].length; j++) {
      d.push(subtables[i][j]);
    }
  }

  return d;
};

/**
 * @param {Table} table
 * @returns {number}
 */
sizeOf.TABLE = function (table) {
  let numBytes = 0;
  const length = table.fields.length;

  for (let i = 0; i < length; i += 1) {
    const field = table.fields[i];
    const sizeOfFunction = sizeOf[field.type];
    check.argument(sizeOfFunction !== undefined, `No sizeOf function for field type ${field.type} (${field.name})`);
    let value = table[field.name];
    if (value === undefined) {
      value = field.value;
    }

    numBytes += sizeOfFunction(value);

    // Subtables take 2 more bytes for offsets.
    if (field.type === 'TABLE') {
      numBytes += 2;
    }
  }

  return numBytes;
};

encode.RECORD = encode.TABLE;
sizeOf.RECORD = sizeOf.TABLE;

// Merge in a list of bytes.
encode.LITERAL = function (v) {
  return v;
};

sizeOf.LITERAL = function (v) {
  return v.length;
};

// --- parse ---
// Parsing utility functions

// Retrieve an unsigned byte from the DataView.
function getByte(dataView, offset) {
  return dataView.getUint8(offset);
}

// Retrieve an unsigned 16-bit short from the DataView.
// The value is stored in big endian.
function getUShort(dataView, offset) {
  return dataView.getUint16(offset, false);
}

// Retrieve a signed 16-bit short from the DataView.
// The value is stored in big endian.
function getShort(dataView, offset) {
  return dataView.getInt16(offset, false);
}

// Retrieve an unsigned 32-bit long from the DataView.
// The value is stored in big endian.
function getULong(dataView, offset) {
  return dataView.getUint32(offset, false);
}

// Retrieve a 32-bit signed fixed-point number (16.16) from the DataView.
// The value is stored in big endian.
function getFixed(dataView, offset) {
  const decimal = dataView.getInt16(offset, false);
  const fraction = dataView.getUint16(offset + 2, false);
  return decimal + fraction / 65535;
}

// Retrieve a 4-character tag from the DataView.
// Tags are used to identify tables.
function getTag(dataView, offset) {
  let tag = '';
  for (let i = offset; i < offset + 4; i += 1) {
    tag += String.fromCharCode(dataView.getInt8(i));
  }

  return tag;
}

// Retrieve an offset from the DataView.
// Offsets are 1 to 4 bytes in length, depending on the offSize argument.
function getOffset(dataView, offset, offSize) {
  let v = 0;
  for (let i = 0; i < offSize; i += 1) {
    v <<= 8;
    v += dataView.getUint8(offset + i);
  }

  return v;
}

// Retrieve a number of bytes from start offset to the end offset from the DataView.
function getBytes(dataView, startOffset, endOffset) {
  const bytes = [];
  for (let i = startOffset; i < endOffset; i += 1) {
    bytes.push(dataView.getUint8(i));
  }

  return bytes;
}

// Convert the list of bytes to a string.
function bytesToString(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) {
    s += String.fromCharCode(bytes[i]);
  }

  return s;
}

const typeOffsets = {
  byte: 1,
  uShort: 2,
  short: 2,
  uLong: 4,
  fixed: 4,
  longDateTime: 8,
  tag: 4,
};

class Parser {
  constructor(data, offset) {
    this.data = data;
    this.offset = offset;
    this.relativeOffset = 0;
  }

  parseByte() {
    const v = this.data.getUint8(this.offset + this.relativeOffset);
    this.relativeOffset += 1;
    return v;
  }

  parseChar() {
    const v = this.data.getInt8(this.offset + this.relativeOffset);
    this.relativeOffset += 1;
    return v;
  }

  parseUShort() {
    const v = this.data.getUint16(this.offset + this.relativeOffset);
    this.relativeOffset += 2;
    return v;
  }

  parseShort() {
    const v = this.data.getInt16(this.offset + this.relativeOffset);
    this.relativeOffset += 2;
    return v;
  }

  parseF2Dot14() {
    const v = this.data.getInt16(this.offset + this.relativeOffset) / 16384;
    this.relativeOffset += 2;
    return v;
  }

  parseULong() {
    const v = getULong(this.data, this.offset + this.relativeOffset);
    this.relativeOffset += 4;
    return v;
  }

  parseFixed() {
    const v = getFixed(this.data, this.offset + this.relativeOffset);
    this.relativeOffset += 4;
    return v;
  }

  parseString(length) {
    const dataView = this.data;
    const offset = this.offset + this.relativeOffset;
    let string = '';
    this.relativeOffset += length;
    for (let i = 0; i < length; i++) {
      string += String.fromCharCode(dataView.getUint8(offset + i));
    }
    return string;
  }

  parseTag() {
    return this.parseString(4);
  }

  parseLongDateTime() {
    let v = getULong(this.data, this.offset + this.relativeOffset + 4);
    v -= 2082844800;
    this.relativeOffset += 8;
    return v;
  }

  parseVersion(minorBase) {
    const major = getUShort(this.data, this.offset + this.relativeOffset);
    const minor = getUShort(this.data, this.offset + this.relativeOffset + 2);
    this.relativeOffset += 4;
    if (minorBase === undefined) minorBase = 0x1000;
    return major + minor / minorBase / 10;
  }

  skip(type, amount) {
    if (amount === undefined) {
      amount = 1;
    }
    this.relativeOffset += typeOffsets[type] * amount;
  }

  parseULongList(count) {
    if (count === undefined) { count = this.parseULong(); }
    const offsets = new Array(count);
    const dataView = this.data;
    let offset = this.offset + this.relativeOffset;
    for (let i = 0; i < count; i++) {
      offsets[i] = dataView.getUint32(offset);
      offset += 4;
    }
    this.relativeOffset += count * 4;
    return offsets;
  }

  parseUShortList(count) {
    if (count === undefined) { count = this.parseUShort(); }
    const offsets = new Array(count);
    const dataView = this.data;
    let offset = this.offset + this.relativeOffset;
    for (let i = 0; i < count; i++) {
      offsets[i] = dataView.getUint16(offset);
      offset += 2;
    }
    this.relativeOffset += count * 2;
    return offsets;
  }

  parseShortList(count) {
    const list = new Array(count);
    const dataView = this.data;
    let offset = this.offset + this.relativeOffset;
    for (let i = 0; i < count; i++) {
      list[i] = dataView.getInt16(offset);
      offset += 2;
    }
    this.relativeOffset += count * 2;
    return list;
  }

  parseByteList(count) {
    const list = new Array(count);
    const dataView = this.data;
    let offset = this.offset + this.relativeOffset;
    for (let i = 0; i < count; i++) {
      list[i] = dataView.getUint8(offset++);
    }
    this.relativeOffset += count;
    return list;
  }

  parseList(count, itemCallback) {
    if (!itemCallback) {
      itemCallback = count;
      count = this.parseUShort();
    }
    const list = new Array(count);
    for (let i = 0; i < count; i++) {
      list[i] = itemCallback.call(this);
    }
    return list;
  }

  parseList32(count, itemCallback) {
    if (!itemCallback) {
      itemCallback = count;
      count = this.parseULong();
    }
    const list = new Array(count);
    for (let i = 0; i < count; i++) {
      list[i] = itemCallback.call(this);
    }
    return list;
  }

  parseRecordList(count, recordDescription) {
    if (!recordDescription) {
      recordDescription = count;
      count = this.parseUShort();
    }
    const records = new Array(count);
    const fields = Object.keys(recordDescription);
    for (let i = 0; i < count; i++) {
      const rec = {};
      for (let j = 0; j < fields.length; j++) {
        const fieldName = fields[j];
        const fieldType = recordDescription[fieldName];
        rec[fieldName] = fieldType.call(this);
      }
      records[i] = rec;
    }
    return records;
  }

  parseRecordList32(count, recordDescription) {
    if (!recordDescription) {
      recordDescription = count;
      count = this.parseULong();
    }
    const records = new Array(count);
    const fields = Object.keys(recordDescription);
    for (let i = 0; i < count; i++) {
      const rec = {};
      for (let j = 0; j < fields.length; j++) {
        const fieldName = fields[j];
        const fieldType = recordDescription[fieldName];
        rec[fieldName] = fieldType.call(this);
      }
      records[i] = rec;
    }
    return records;
  }

  parseStruct(description) {
    if (typeof description === 'function') {
      return description.call(this);
    }
    const fields = Object.keys(description);
    const struct = {};
    for (let j = 0; j < fields.length; j++) {
      const fieldName = fields[j];
      const fieldType = description[fieldName];
      struct[fieldName] = fieldType.call(this);
    }
    return struct;
  }

  parseValueRecord(valueFormat) {
    if (valueFormat === undefined) {
      valueFormat = this.parseUShort();
    }
    if (valueFormat === 0) {
      return;
    }
    const valueRecord = {};

    if (valueFormat & 0x0001) { valueRecord.xPlacement = this.parseShort(); }
    if (valueFormat & 0x0002) { valueRecord.yPlacement = this.parseShort(); }
    if (valueFormat & 0x0004) { valueRecord.xAdvance = this.parseShort(); }
    if (valueFormat & 0x0008) { valueRecord.yAdvance = this.parseShort(); }

    if (valueFormat & 0x0010) { valueRecord.xPlaDevice = undefined; this.parseShort(); }
    if (valueFormat & 0x0020) { valueRecord.yPlaDevice = undefined; this.parseShort(); }
    if (valueFormat & 0x0040) { valueRecord.xAdvDevice = undefined; this.parseShort(); }
    if (valueFormat & 0x0080) { valueRecord.yAdvDevice = undefined; this.parseShort(); }

    return valueRecord;
  }

  parseValueRecordList() {
    const valueFormat = this.parseUShort();
    const valueCount = this.parseUShort();
    const values = new Array(valueCount);
    for (let i = 0; i < valueCount; i++) {
      values[i] = this.parseValueRecord(valueFormat);
    }
    return values;
  }

  parsePointer(description) {
    const structOffset = this.parseOffset16();
    if (structOffset > 0) {
      return new Parser(this.data, this.offset + structOffset).parseStruct(description);
    }
    return undefined;
  }

  parsePointer32(description) {
    const structOffset = this.parseOffset32();
    if (structOffset > 0) {
      return new Parser(this.data, this.offset + structOffset).parseStruct(description);
    }
    return undefined;
  }

  parseListOfLists(itemCallback) {
    const offsets = this.parseOffset16List();
    const count = offsets.length;
    const relativeOffset = this.relativeOffset;
    const list = new Array(count);
    for (let i = 0; i < count; i++) {
      const start = offsets[i];
      if (start === 0) {
        list[i] = undefined;
        continue;
      }
      this.relativeOffset = start;
      if (itemCallback) {
        const subOffsets = this.parseOffset16List();
        const subList = new Array(subOffsets.length);
        for (let j = 0; j < subOffsets.length; j++) {
          this.relativeOffset = start + subOffsets[j];
          subList[j] = itemCallback.call(this);
        }
        list[i] = subList;
      } else {
        list[i] = this.parseUShortList();
      }
    }
    this.relativeOffset = relativeOffset;
    return list;
  }

  parseCoverage() {
    const startOffset = this.offset + this.relativeOffset;
    const format = this.parseUShort();
    const count = this.parseUShort();
    if (format === 1) {
      return {
        format: 1,
        glyphs: this.parseUShortList(count),
      };
    } if (format === 2) {
      const ranges = new Array(count);
      for (let i = 0; i < count; i++) {
        ranges[i] = {
          start: this.parseUShort(),
          end: this.parseUShort(),
          index: this.parseUShort(),
        };
      }
      return {
        format: 2,
        ranges,
      };
    }
    throw new Error(`0x${startOffset.toString(16)}: Coverage format must be 1 or 2.`);
  }

  parseClassDef() {
    const startOffset = this.offset + this.relativeOffset;
    const format = this.parseUShort();
    if (format === 1) {
      return {
        format: 1,
        startGlyph: this.parseUShort(),
        classes: this.parseUShortList(),
      };
    } if (format === 2) {
      return {
        format: 2,
        ranges: this.parseRecordList({
          start: Parser.uShort,
          end: Parser.uShort,
          classId: Parser.uShort,
        }),
      };
    }
    throw new Error(`0x${startOffset.toString(16)}: ClassDef format must be 1 or 2.`);
  }

  parseScriptList() {
    return this.parsePointer(Parser.recordList({
      tag: Parser.tag,
      script: Parser.pointer({
        defaultLangSys: Parser.pointer(langSysTable),
        langSysRecords: Parser.recordList({
          tag: Parser.tag,
          langSys: Parser.pointer(langSysTable),
        }),
      }),
    })) || [];
  }

  parseFeatureList() {
    return this.parsePointer(Parser.recordList({
      tag: Parser.tag,
      feature: Parser.pointer({
        featureParams: Parser.offset16,
        lookupListIndexes: Parser.uShortList,
      }),
    })) || [];
  }

  parseLookupList(lookupTableParsers) {
    return this.parsePointer(Parser.list(Parser.pointer(function () {
      const lookupType = this.parseUShort();
      check.argument(lookupType >= 1 && lookupType <= 9, `GPOS/GSUB lookup type ${lookupType} unknown.`);
      const lookupFlag = this.parseUShort();
      const useMarkFilteringSet = lookupFlag & 0x10;
      return {
        lookupType,
        lookupFlag,
        subtables: this.parseList(Parser.pointer(lookupTableParsers[lookupType])),
        markFilteringSet: useMarkFilteringSet ? this.parseUShort() : undefined,
      };
    }))) || [];
  }

  parseFeatureVariationsList() {
    return this.parsePointer32(function () {
      const majorVersion = this.parseUShort();
      const minorVersion = this.parseUShort();
      check.argument(majorVersion === 1 && minorVersion < 1, 'GPOS/GSUB feature variations table unknown.');
      const featureVariations = this.parseRecordList32({
        conditionSetOffset: Parser.offset32,
        featureTableSubstitutionOffset: Parser.offset32,
      });
      return featureVariations;
    }) || [];
  }
}

// Method aliases
Parser.prototype.parseCard8 = Parser.prototype.parseByte;
Parser.prototype.parseCard16 = Parser.prototype.parseUShort;
Parser.prototype.parseSID = Parser.prototype.parseUShort;
Parser.prototype.parseOffset16 = Parser.prototype.parseUShort;
Parser.prototype.parseOffset32 = Parser.prototype.parseULong;
Parser.prototype.parseOffset16List = Parser.prototype.parseUShortList;

// Static factory methods for use as parsing descriptors
Parser.list = function (count, itemCallback) {
  return function () { return this.parseList(count, itemCallback); };
};

Parser.list32 = function (count, itemCallback) {
  return function () { return this.parseList32(count, itemCallback); };
};

Parser.recordList = function (count, recordDescription) {
  return function () { return this.parseRecordList(count, recordDescription); };
};

Parser.recordList32 = function (count, recordDescription) {
  return function () { return this.parseRecordList32(count, recordDescription); };
};

Parser.pointer = function (description) {
  return function () { return this.parsePointer(description); };
};

Parser.pointer32 = function (description) {
  return function () { return this.parsePointer32(description); };
};

Parser.tag = Parser.prototype.parseTag;
Parser.byte = Parser.prototype.parseByte;
Parser.uShort = Parser.offset16 = Parser.prototype.parseUShort;
Parser.uShortList = Parser.prototype.parseUShortList;
Parser.uLong = Parser.offset32 = Parser.prototype.parseULong;
Parser.uLongList = Parser.prototype.parseULongList;
Parser.struct = Parser.prototype.parseStruct;
Parser.coverage = Parser.prototype.parseCoverage;
Parser.classDef = Parser.prototype.parseClassDef;

const langSysTable = {
  reserved: Parser.uShort,
  reqFeatureIndex: Parser.uShort,
  featureIndexes: Parser.uShortList,
};

const parse = {
  getByte, getCard8: getByte, getUShort, getCard16: getUShort, getShort, getULong, getFixed, getTag, getOffset, getBytes, bytesToString, Parser,
};

// --- table ---
// Table metadata

class Table {
  constructor(tableName, fields, options) {
    // For coverage tables with coverage format 2, we do not want to add the coverage data directly to the table object,
    // as this will result in wrong encoding order of the coverage data on serialization to bytes.
    if (fields.length && (fields[0].name !== 'coverageFormat' || fields[0].value === 1)) {
      for (let i = 0; i < fields.length; i += 1) {
        const field = fields[i];
        this[field.name] = field.value;
      }
    }

    this.tableName = tableName;
    this.fields = fields;
    if (options) {
      const optionKeys = Object.keys(options);
      for (let i = 0; i < optionKeys.length; i += 1) {
        const k = optionKeys[i];
        const v = options[k];
        if (this[k] !== undefined) {
          this[k] = v;
        }
      }
    }
  }

  encode() {
    return encode.TABLE(this);
  }

  sizeOf() {
    return sizeOf.TABLE(this);
  }
}

/**
 * @private
 */
function ushortList(itemName, list, count) {
  if (count === undefined) {
    count = list.length;
  }
  const fields = new Array(list.length + 1);
  fields[0] = { name: `${itemName}Count`, type: 'USHORT', value: count };
  for (let i = 0; i < list.length; i++) {
    fields[i + 1] = { name: itemName + i, type: 'USHORT', value: list[i] };
  }
  return fields;
}

/**
 * @private
 */
function tableList(itemName, records, itemCallback) {
  const count = records.length;
  const fields = new Array(count + 1);
  fields[0] = { name: `${itemName}Count`, type: 'USHORT', value: count };
  for (let i = 0; i < count; i++) {
    fields[i + 1] = { name: itemName + i, type: 'TABLE', value: itemCallback(records[i], i) };
  }
  return fields;
}

/**
 * @private
 */
function recordList(itemName, records, itemCallback) {
  const count = records.length;
  let fields = [];
  fields[0] = { name: `${itemName}Count`, type: 'USHORT', value: count };
  for (let i = 0; i < count; i++) {
    fields = fields.concat(itemCallback(records[i], i));
  }
  return fields;
}

// Common Layout Tables

/**
 * @exports opentype.Coverage
 * @class
 * @param {Table} coverageTable
 * @constructor
 * @extends opentype.Table
 */
class Coverage extends Table {
  constructor(coverageTable) {
    if (coverageTable.format === 1) {
      super('coverageTable',
        [{ name: 'coverageFormat', type: 'USHORT', value: 1 }]
          .concat(ushortList('glyph', coverageTable.glyphs)),
      );
    } else if (coverageTable.format === 2) {
      super('coverageTable',
        [{ name: 'coverageFormat', type: 'USHORT', value: 2 }]
          .concat(recordList('rangeRecord', coverageTable.ranges, (RangeRecord) => [
            { name: 'startGlyphID', type: 'USHORT', value: RangeRecord.start },
            { name: 'endGlyphID', type: 'USHORT', value: RangeRecord.end },
            { name: 'startCoverageIndex', type: 'USHORT', value: RangeRecord.index },
          ])),
      );
    } else {
      super('coverageTable', []);
      check.assert(false, 'Coverage format must be 1 or 2.');
    }
  }
}

class ScriptList extends Table {
  constructor(scriptListTable) {
    super('scriptListTable',
      recordList('scriptRecord', scriptListTable, (scriptRecord, i) => {
        const script = scriptRecord.script;
        const defaultLangSys = script.defaultLangSys;
        check.assert(!!defaultLangSys, `Unable to write GSUB: script ${scriptRecord.tag} has no default language system.`);
        return [
          { name: `scriptTag${i}`, type: 'TAG', value: scriptRecord.tag },
          {
            name: `script${i}`,
            type: 'TABLE',
            value: new Table('scriptTable', [
              {
                name: 'defaultLangSys',
                type: 'TABLE',
                value: new Table('defaultLangSys', [
                  { name: 'lookupOrder', type: 'USHORT', value: 0 },
                  { name: 'reqFeatureIndex', type: 'USHORT', value: defaultLangSys.reqFeatureIndex }]
                  .concat(ushortList('featureIndex', defaultLangSys.featureIndexes))),
              },
            ].concat(recordList('langSys', script.langSysRecords, (langSysRecord, j) => {
              const langSys = langSysRecord.langSys;
              return [
                { name: `langSysTag${j}`, type: 'TAG', value: langSysRecord.tag },
                {
                  name: `langSys${j}`,
                  type: 'TABLE',
                  value: new Table('langSys', [
                    { name: 'lookupOrder', type: 'USHORT', value: 0 },
                    { name: 'reqFeatureIndex', type: 'USHORT', value: langSys.reqFeatureIndex },
                  ].concat(ushortList('featureIndex', langSys.featureIndexes))),
                },
              ];
            }))),
          },
        ];
      }),
    );
  }
}

class FeatureList extends Table {
  constructor(featureListTable) {
    super('featureListTable',
      recordList('featureRecord', featureListTable, (featureRecord, i) => {
        const feature = featureRecord.feature;
        return [
          { name: `featureTag${i}`, type: 'TAG', value: featureRecord.tag },
          {
            name: `feature${i}`,
            type: 'TABLE',
            value: new Table('featureTable', [
              { name: 'featureParams', type: 'USHORT', value: feature.featureParams },
            ].concat(ushortList('lookupListIndex', feature.lookupListIndexes))),
          },
        ];
      }),
    );
  }
}

class LookupList extends Table {
  constructor(lookupListTable, subtableMakers) {
    super('lookupListTable', tableList('lookup', lookupListTable, (lookupTable) => {
      const subtableCallback = subtableMakers[lookupTable.lookupType];
      check.assert(!!subtableCallback, `Unable to write GSUB lookup type ${lookupTable.lookupType} tables.`);
      return new Table('lookupTable', [
        { name: 'lookupType', type: 'USHORT', value: lookupTable.lookupType },
        { name: 'lookupFlag', type: 'USHORT', value: lookupTable.lookupFlag },
      ].concat(tableList('subtable', lookupTable.subtables, subtableCallback)));
    }));
  }
}

// Record = same as Table, but inlined (a Table has an offset and its data is further in the stream)
// Don't use offsets inside Records (probable bug), only in Tables.

const Record = Table;
const table = {
  Table, Record, Coverage, ScriptList, FeatureList, LookupList, ushortList, tableList, recordList,
};

// --- Exports ---
export {
  decode, encode, sizeOf, eightBitMacEncodings,
};
export { fail, argument, argument as assert };
export { checkArgument };
export {
  getByte, getByte as getCard8, getUShort, getUShort as getCard16, getShort, getULong, getFixed, getTag, getOffset, getBytes, bytesToString, Parser,
};
export {
  Table, Record, Coverage, ScriptList, FeatureList, LookupList, ushortList, tableList, recordList,
};
export { check, parse, table };
