// Helvetica  (charCode → width, WinAnsiEncoding, codes 32-255)
const helvetica = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 611, 556, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
  // 127-143: DEL, Euro, undef, quotesinglbase..OE, undef, Zcaron, undef
  0, 556, 0, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0,
  // 144-159: undef, quoteleft..oe, undef, zcaron, Ydieresis
  0, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 0, 500, 667,
  // 160-175: nbsp, exclamdown..macron
  278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333,
  // 176-191: degree..questiondown
  400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  // 192-207: Agrave..Idieresis
  667, 667, 667, 667, 667, 667, 1000, 722, 611, 611, 611, 611, 278, 278, 278, 278,
  // 208-223: Eth..germandbls
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  // 224-239: agrave..idieresis
  556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278,
  // 240-255: eth..ydieresis
  556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
];

const helveticaBold = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
  // 127-143
  0, 556, 0, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0,
  // 144-159
  0, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 0, 500, 667,
  // 160-175
  278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333,
  // 176-191
  400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  // 192-207
  722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
  // 208-223
  722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  // 224-239
  556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278,
  // 240-255
  611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556,
];

const timesRoman = [
  250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444,
  921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722,
  556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500,
  333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500,
  500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541,
  // 127-143
  0, 500, 0, 333, 500, 444, 1000, 500, 500, 333, 1000, 556, 333, 889, 0, 611, 0,
  // 144-159
  0, 333, 333, 444, 444, 350, 500, 1000, 333, 980, 389, 333, 722, 0, 444, 722,
  // 160-175
  250, 333, 500, 500, 500, 500, 200, 500, 333, 760, 276, 500, 564, 333, 760, 333,
  // 176-191
  400, 564, 300, 300, 333, 500, 453, 250, 333, 300, 310, 500, 750, 750, 750, 444,
  // 192-207
  722, 722, 722, 722, 722, 722, 889, 667, 611, 611, 611, 611, 333, 333, 333, 333,
  // 208-223
  722, 722, 722, 722, 722, 722, 722, 564, 722, 722, 722, 722, 722, 722, 556, 500,
  // 224-239
  444, 444, 444, 444, 444, 444, 667, 444, 444, 444, 444, 444, 278, 278, 278, 278,
  // 240-255
  500, 500, 500, 500, 500, 500, 500, 564, 500, 500, 500, 500, 500, 500, 500, 500,
];

const timesBold = [
  250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500,
  930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722, 778,
  611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333, 278, 333, 581, 500,
  333, 500, 556, 444, 556, 444, 333, 500, 556, 278, 333, 556, 278, 833, 556, 500,
  556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444, 394, 220, 394, 520,
  // 127-143
  0, 500, 0, 333, 500, 500, 1000, 500, 500, 333, 1000, 556, 333, 1000, 0, 667, 0,
  // 144-159
  0, 333, 333, 500, 500, 350, 500, 1000, 333, 1000, 389, 333, 722, 0, 444, 722,
  // 160-175
  250, 333, 500, 500, 500, 500, 220, 500, 333, 747, 300, 500, 570, 333, 747, 333,
  // 176-191
  400, 570, 300, 300, 333, 556, 540, 250, 333, 300, 330, 500, 750, 750, 750, 500,
  // 192-207
  722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 389, 389, 389, 389,
  // 208-223
  722, 722, 778, 778, 778, 778, 778, 570, 778, 722, 722, 722, 722, 722, 611, 556,
  // 224-239
  500, 500, 500, 500, 500, 500, 722, 444, 444, 444, 444, 444, 278, 278, 278, 278,
  // 240-255
  500, 556, 500, 500, 500, 500, 500, 570, 500, 556, 556, 556, 556, 500, 556, 500,
];

const timesItalic = [
  250, 333, 420, 500, 500, 833, 778, 214, 333, 333, 500, 675, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 675, 675, 675, 500,
  920, 611, 611, 667, 722, 611, 611, 722, 722, 333, 444, 667, 556, 833, 667, 722,
  611, 722, 611, 500, 556, 722, 611, 833, 611, 556, 556, 389, 278, 389, 422, 500,
  333, 500, 500, 444, 500, 444, 278, 500, 500, 278, 278, 444, 278, 722, 500, 500,
  500, 500, 389, 389, 278, 500, 444, 667, 444, 444, 389, 400, 275, 400, 541,
  // 127-143
  0, 500, 0, 333, 500, 556, 889, 500, 500, 333, 1000, 500, 333, 944, 0, 556, 0,
  // 144-159
  0, 333, 333, 556, 556, 350, 500, 889, 333, 980, 389, 333, 667, 0, 389, 556,
  // 160-175
  250, 389, 500, 500, 500, 500, 275, 500, 333, 760, 276, 500, 675, 333, 760, 333,
  // 176-191
  400, 675, 300, 300, 333, 500, 523, 250, 333, 300, 310, 500, 750, 750, 750, 500,
  // 192-207
  611, 611, 611, 611, 611, 611, 889, 667, 611, 611, 611, 611, 333, 333, 333, 333,
  // 208-223
  722, 667, 722, 722, 722, 722, 722, 675, 722, 722, 722, 722, 722, 556, 611, 500,
  // 224-239
  500, 500, 500, 500, 500, 500, 667, 444, 444, 444, 444, 444, 278, 278, 278, 278,
  // 240-255
  500, 500, 500, 500, 500, 500, 500, 675, 500, 500, 500, 500, 500, 444, 500, 444,
];

const timesBoldItalic = [
  250, 389, 555, 500, 500, 833, 778, 278, 333, 333, 500, 570, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500,
  832, 667, 667, 667, 722, 667, 667, 722, 778, 389, 500, 667, 611, 889, 722, 722,
  611, 722, 667, 556, 611, 722, 667, 889, 667, 611, 611, 333, 278, 333, 570, 500,
  333, 500, 500, 444, 500, 444, 333, 500, 556, 278, 278, 500, 278, 778, 556, 500,
  500, 500, 389, 389, 278, 556, 444, 667, 500, 444, 389, 348, 220, 348, 570,
  // 127-143
  0, 500, 0, 333, 500, 500, 1000, 500, 500, 333, 1000, 556, 333, 944, 0, 611, 0,
  // 144-159
  0, 333, 333, 500, 500, 350, 500, 1000, 333, 1000, 389, 333, 667, 0, 389, 611,
  // 160-175
  250, 389, 500, 500, 500, 500, 220, 500, 333, 747, 266, 500, 606, 333, 747, 333,
  // 176-191
  400, 570, 300, 300, 333, 576, 500, 250, 333, 300, 300, 500, 750, 750, 750, 500,
  // 192-207
  667, 667, 667, 667, 667, 667, 944, 667, 667, 667, 667, 667, 389, 389, 389, 389,
  // 208-223
  722, 722, 722, 722, 722, 722, 722, 570, 722, 722, 722, 722, 722, 611, 611, 500,
  // 224-239
  500, 500, 500, 500, 500, 500, 722, 444, 444, 444, 444, 444, 278, 278, 278, 278,
  // 240-255
  500, 556, 500, 500, 500, 500, 500, 570, 500, 556, 556, 556, 556, 444, 500, 444,
];

/**
 * Map of standard PDF font name → width array (charCodes 32-255, WinAnsiEncoding).
 */
const standardFontWidths = new Map();

// Helvetica family
standardFontWidths.set('Helvetica', helvetica);
standardFontWidths.set('Helvetica-Bold', helveticaBold);
standardFontWidths.set('Helvetica-Oblique', helvetica);
standardFontWidths.set('Helvetica-BoldOblique', helveticaBold);

// Times family
standardFontWidths.set('Times-Roman', timesRoman);
standardFontWidths.set('Times-Bold', timesBold);
standardFontWidths.set('Times-Italic', timesItalic);
standardFontWidths.set('Times-BoldItalic', timesBoldItalic);

// Courier family — every glyph is 600 units wide
const courier = new Array(224).fill(600);
// Clear undefined WinAnsiEncoding positions
[95, 97, 109, 111, 112, 125].forEach((i) => { courier[i] = 0; });
standardFontWidths.set('Courier', courier);
standardFontWidths.set('Courier-Bold', courier);
standardFontWidths.set('Courier-Oblique', courier);
standardFontWidths.set('Courier-BoldOblique', courier);

// Dingbats (charCode → width, DingbatsEncoding, codes 32-126)
const dingbats = [
  278, 974, 961, 974, 980, 719, 789, 790, 791, 690, 960, 939, 549, 855, 911, 933,
  911, 945, 974, 755, 846, 762, 761, 571, 677, 763, 760, 759, 754, 494, 552, 537,
  577, 692, 786, 788, 788, 790, 793, 794, 816, 823, 789, 841, 823, 833, 816, 831,
  923, 744, 723, 749, 790, 792, 695, 776, 768, 792, 759, 707, 708, 682, 701, 826,
  815, 789, 789, 707, 687, 696, 689, 786, 787, 713, 791, 785, 791, 873, 761, 762,
  762, 759, 759, 892, 892, 788, 784, 438, 138, 277, 415, 392, 392, 668, 668,
];
standardFontWidths.set('ZapfDingbats', dingbats);

// Symbol (charCode → width, SymbolEncoding, codes 32-126)
const symbol = [
  250, 333, 713, 500, 549, 833, 778, 439, 333, 333, 500, 549, 250, 549, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 549, 549, 549, 444,
  549, 722, 667, 722, 612, 611, 763, 603, 722, 333, 631, 722, 686, 889, 722, 722,
  768, 741, 556, 592, 611, 690, 439, 768, 645, 795, 611, 333, 863, 333, 658, 500,
  500, 631, 549, 549, 494, 439, 521, 411, 603, 329, 603, 549, 549, 576, 521, 549,
  549, 521, 549, 603, 439, 576, 713, 686, 493, 686, 494, 480, 200, 480, 549,
];
standardFontWidths.set('Symbol', symbol);

/**
 * Dingbats glyph name → width (from Adobe AFM file, all 202 glyphs).
 * Used to populate widths when /Differences remaps charCodes to glyph names.
 */
const dingbatsGlyphWidths = {
  space: 278,
  a1: 974,
  a2: 961,
  a3: 980,
  a4: 719,
  a5: 789,
  a6: 494,
  a7: 552,
  a8: 537,
  a9: 577,
  a10: 692,
  a11: 960,
  a12: 939,
  a13: 549,
  a14: 855,
  a15: 911,
  a16: 933,
  a17: 945,
  a18: 974,
  a19: 755,
  a20: 846,
  a21: 762,
  a22: 761,
  a23: 571,
  a24: 677,
  a25: 763,
  a26: 760,
  a27: 759,
  a28: 754,
  a29: 786,
  a30: 788,
  a31: 788,
  a32: 790,
  a33: 793,
  a34: 794,
  a35: 816,
  a36: 823,
  a37: 789,
  a38: 841,
  a39: 823,
  a40: 833,
  a41: 816,
  a42: 831,
  a43: 923,
  a44: 744,
  a45: 723,
  a46: 749,
  a47: 790,
  a48: 792,
  a49: 695,
  a50: 776,
  a51: 768,
  a52: 792,
  a53: 759,
  a54: 707,
  a55: 708,
  a56: 682,
  a57: 701,
  a58: 826,
  a59: 815,
  a60: 789,
  a61: 789,
  a62: 707,
  a63: 687,
  a64: 696,
  a65: 689,
  a66: 786,
  a67: 787,
  a68: 713,
  a69: 791,
  a70: 785,
  a71: 791,
  a72: 873,
  a73: 761,
  a74: 762,
  a75: 759,
  a76: 892,
  a77: 892,
  a78: 788,
  a79: 784,
  a81: 438,
  a82: 138,
  a83: 277,
  a84: 415,
  a85: 509,
  a86: 410,
  a87: 234,
  a88: 234,
  a89: 390,
  a90: 390,
  a91: 276,
  a92: 276,
  a93: 317,
  a94: 317,
  a95: 334,
  a96: 334,
  a97: 392,
  a98: 392,
  a99: 668,
  a100: 668,
  a101: 732,
  a102: 544,
  a103: 544,
  a104: 910,
  a105: 911,
  a106: 667,
  a107: 760,
  a108: 760,
  a109: 626,
  a110: 694,
  a111: 595,
  a112: 776,
  a117: 690,
  a118: 791,
  a119: 790,
  a120: 788,
  a121: 788,
  a122: 788,
  a123: 788,
  a124: 788,
  a125: 788,
  a126: 788,
  a127: 788,
  a128: 788,
  a129: 788,
  a130: 788,
  a131: 788,
  a132: 788,
  a133: 788,
  a134: 788,
  a135: 788,
  a136: 788,
  a137: 788,
  a138: 788,
  a139: 788,
  a140: 788,
  a141: 788,
  a142: 788,
  a143: 788,
  a144: 788,
  a145: 788,
  a146: 788,
  a147: 788,
  a148: 788,
  a149: 788,
  a150: 788,
  a151: 788,
  a152: 788,
  a153: 788,
  a154: 788,
  a155: 788,
  a156: 788,
  a157: 788,
  a158: 788,
  a159: 788,
  a160: 894,
  a161: 838,
  a162: 924,
  a163: 1016,
  a164: 458,
  a165: 924,
  a166: 918,
  a167: 927,
  a168: 928,
  a169: 928,
  a170: 834,
  a171: 873,
  a172: 828,
  a173: 924,
  a174: 917,
  a175: 930,
  a176: 931,
  a177: 463,
  a178: 883,
  a179: 836,
  a180: 867,
  a181: 696,
  a182: 874,
  a183: 760,
  a184: 946,
  a185: 865,
  a186: 831,
  a187: 927,
  a188: 970,
  a189: 918,
  a190: 748,
  a191: 836,
  a192: 748,
  a193: 836,
  a194: 771,
  a195: 873,
  a196: 748,
  a197: 771,
  a198: 888,
  a199: 867,
  a200: 696,
  a201: 874,
  a202: 974,
  a203: 762,
  a204: 759,
  a205: 509,
  a206: 410,
};
/* eslint-enable object-curly-newline */

/**
 * Get Dingbats glyph width by glyph name.
 * @param {string} glyphName
 */
export function getDingbatsGlyphWidth(glyphName) {
  return dingbatsGlyphWidths[glyphName];
}

/**
 * Look up standard font widths for the given baseName.
 * Populates the widths Map and returns the average width as defaultWidth.
 *
 * @param {string} baseName - PDF font base name (e.g., 'Helvetica', 'Times-Roman')
 * @param {Map<number, number>} widths - Map to populate with charCode → width
 */
export function applyStandardFontWidths(baseName, widths) {
  let table = standardFontWidths.get(baseName);
  if (!table) {
    // Normalize common aliases (e.g. CourierNew, ArialMT, TimesNewRomanPSMT)
    // to standard PDF font names for width lookup.
    const lower = baseName.toLowerCase();
    const bold = /bold|black/i.test(baseName);
    const italic = /italic|oblique/i.test(baseName);
    let stdName = null;
    if (lower.includes('courier')) {
      stdName = bold && italic ? 'Courier-BoldOblique' : bold ? 'Courier-Bold' : italic ? 'Courier-Oblique' : 'Courier';
    } else if (lower.includes('arial') || lower.includes('helvetica')) {
      stdName = bold && italic ? 'Helvetica-BoldOblique' : bold ? 'Helvetica-Bold' : italic ? 'Helvetica-Oblique' : 'Helvetica';
    } else if (lower.includes('times')) {
      stdName = bold && italic ? 'Times-BoldItalic' : bold ? 'Times-Bold' : italic ? 'Times-Italic' : 'Times-Roman';
    }
    if (stdName) table = standardFontWidths.get(stdName);
  }
  if (!table) return null;
  let sum = 0;
  for (let i = 0; i < table.length; i++) {
    // Skip 0-width entries (undefined WinAnsiEncoding positions like 129, 141, etc.)
    if (table[i] > 0) widths.set(32 + i, table[i]);
    // Average only the base ASCII range (32-126) for defaultWidth
    if (i < 95) sum += table[i];
  }
  return sum / 95;
}

/**
 * Map a standard PDF font baseName to a CSS font-family string.
 *
 * @param {string} baseName
 */
export function standardFontToCSS(baseName) {
  if (baseName.startsWith('Helvetica')) return 'Helvetica, Arial, "Liberation Sans", sans-serif';
  if (baseName.startsWith('Arial')) return 'Arial, Helvetica, "Liberation Sans", sans-serif';
  if (baseName.startsWith('Times')) return '"Times New Roman", Times, "Liberation Serif", serif';
  if (baseName.startsWith('Courier')) return '"Courier New", Courier, "Liberation Mono", monospace';
  // Handle CID font names like "*Times New Roman-Italic-4807-Identity-H"
  const lower = baseName.toLowerCase();
  if (lower.includes('times new roman') || lower.includes('times-roman')) return '"Times New Roman", Times, "Liberation Serif", serif';
  if (lower.includes('arial') || lower.includes('helvetica')) return 'Arial, Helvetica, "Liberation Sans", sans-serif';
  if (lower.includes('courier')) return '"Courier New", Courier, "Liberation Mono", monospace';
  if (lower.includes('sans serif') || lower.includes('sans-serif')) return 'Arial, Helvetica, sans-serif';
  // Script/cursive fonts
  if (lower.includes('brush') || lower.includes('script') || lower.includes('cursive')) return 'cursive';
  // Broad serif/sans-serif classification by common font family patterns
  // URW/Ghostscript/TeX font names for standard 14 equivalents
  if (lower.includes('nimbusromno9l') || lower.includes('nimbusroman')) return '"Times New Roman", Times, "Liberation Serif", serif';
  if (lower.includes('nimbusmonl') || lower.includes('nimbusmono')) return '"Courier New", Courier, "Liberation Mono", monospace';
  if (lower.includes('nimbussanl') || lower.includes('nimbussans')) return 'Arial, Helvetica, "Liberation Sans", sans-serif';
  if (lower.includes('garamond') || lower.includes('palatino') || lower.includes('georgia')
    || lower.includes('bookman') || lower.includes('cambria') || lower.includes('book antiqua') || lower.includes('bookantiqua')
    || lower.includes('schoolbook') || lower.includes('newcenturyschlbk')) return 'serif';
  if (lower.includes('verdana') || lower.includes('tahoma') || lower.includes('calibri')
    || lower.includes('trebuchet') || lower.includes('segoe') || lower.includes('roboto')
    || lower.includes('frutiger') || lower.includes('myriad') || lower.includes('futura')
    || lower.includes('avenir') || lower.includes('gill sans') || lower.includes('optima')
    || lower.includes('centurygothic') || lower.includes('century gothic')) return 'sans-serif';
  return null;
}
