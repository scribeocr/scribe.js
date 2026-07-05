/**
 * CCITT Fax decoder for PDF CCITTFaxDecode filter.
 *
 * Adapted from Mozilla pdf.js (Apache 2.0 license).
 */

const ccittEOL = -2;
const ccittEOF = -1;
const twoDimPass = 0;
const twoDimHoriz = 1;
const twoDimVert0 = 2;
const twoDimVertR1 = 3;
const twoDimVertL1 = 4;
const twoDimVertR2 = 5;
const twoDimVertL2 = 6;
const twoDimVertR3 = 7;
const twoDimVertL3 = 8;

// prettier-ignore
const twoDimTable = [
  [-1, -1], [-1, -1],
  [7, twoDimVertL3],
  [7, twoDimVertR3],
  [6, twoDimVertL2], [6, twoDimVertL2],
  [6, twoDimVertR2], [6, twoDimVertR2],
  [4, twoDimPass], [4, twoDimPass],
  [4, twoDimPass], [4, twoDimPass],
  [4, twoDimPass], [4, twoDimPass],
  [4, twoDimPass], [4, twoDimPass],
  [3, twoDimHoriz], [3, twoDimHoriz],
  [3, twoDimHoriz], [3, twoDimHoriz],
  [3, twoDimHoriz], [3, twoDimHoriz],
  [3, twoDimHoriz], [3, twoDimHoriz],
  [3, twoDimHoriz], [3, twoDimHoriz],
  [3, twoDimHoriz], [3, twoDimHoriz],
  [3, twoDimHoriz], [3, twoDimHoriz],
  [3, twoDimHoriz], [3, twoDimHoriz],
  [3, twoDimVertL1], [3, twoDimVertL1],
  [3, twoDimVertL1], [3, twoDimVertL1],
  [3, twoDimVertL1], [3, twoDimVertL1],
  [3, twoDimVertL1], [3, twoDimVertL1],
  [3, twoDimVertL1], [3, twoDimVertL1],
  [3, twoDimVertL1], [3, twoDimVertL1],
  [3, twoDimVertL1], [3, twoDimVertL1],
  [3, twoDimVertL1], [3, twoDimVertL1],
  [3, twoDimVertR1], [3, twoDimVertR1],
  [3, twoDimVertR1], [3, twoDimVertR1],
  [3, twoDimVertR1], [3, twoDimVertR1],
  [3, twoDimVertR1], [3, twoDimVertR1],
  [3, twoDimVertR1], [3, twoDimVertR1],
  [3, twoDimVertR1], [3, twoDimVertR1],
  [3, twoDimVertR1], [3, twoDimVertR1],
  [3, twoDimVertR1], [3, twoDimVertR1],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
  [1, twoDimVert0], [1, twoDimVert0],
];

// prettier-ignore
const whiteTable1 = [
  [-1, -1],
  [12, ccittEOL],
  [-1, -1], [-1, -1],
  [-1, -1], [-1, -1], [-1, -1], [-1, -1],
  [-1, -1], [-1, -1], [-1, -1], [-1, -1],
  [-1, -1], [-1, -1], [-1, -1], [-1, -1],
  [11, 1792], [11, 1792],
  [12, 1984],
  [12, 2048],
  [12, 2112],
  [12, 2176],
  [12, 2240],
  [12, 2304],
  [11, 1856], [11, 1856],
  [11, 1920], [11, 1920],
  [12, 2368],
  [12, 2432],
  [12, 2496],
  [12, 2560],
];

// prettier-ignore
const whiteTable2 = [
  [-1, -1], [-1, -1], [-1, -1], [-1, -1],
  [8, 29], [8, 29],
  [8, 30], [8, 30],
  [8, 45], [8, 45],
  [8, 46], [8, 46],
  [7, 22], [7, 22], [7, 22], [7, 22],
  [7, 23], [7, 23], [7, 23], [7, 23],
  [8, 47], [8, 47],
  [8, 48], [8, 48],
  [6, 13], [6, 13], [6, 13], [6, 13],
  [6, 13], [6, 13], [6, 13], [6, 13],
  [7, 20], [7, 20], [7, 20], [7, 20],
  [8, 33], [8, 33],
  [8, 34], [8, 34],
  [8, 35], [8, 35],
  [8, 36], [8, 36],
  [8, 37], [8, 37],
  [8, 38], [8, 38],
  [7, 19], [7, 19], [7, 19], [7, 19],
  [8, 31], [8, 31],
  [8, 32], [8, 32],
  [6, 1], [6, 1], [6, 1], [6, 1],
  [6, 1], [6, 1], [6, 1], [6, 1],
  [6, 12], [6, 12], [6, 12], [6, 12],
  [6, 12], [6, 12], [6, 12], [6, 12],
  [8, 53], [8, 53],
  [8, 54], [8, 54],
  [7, 26], [7, 26], [7, 26], [7, 26],
  [8, 39], [8, 39],
  [8, 40], [8, 40],
  [8, 41], [8, 41],
  [8, 42], [8, 42],
  [8, 43], [8, 43],
  [8, 44], [8, 44],
  [7, 21], [7, 21], [7, 21], [7, 21],
  [7, 28], [7, 28], [7, 28], [7, 28],
  [8, 61], [8, 61],
  [8, 62], [8, 62],
  [8, 63], [8, 63],
  [8, 0], [8, 0],
  [8, 320], [8, 320],
  [8, 384], [8, 384],
  [5, 10], [5, 10], [5, 10], [5, 10],
  [5, 10], [5, 10], [5, 10], [5, 10],
  [5, 10], [5, 10], [5, 10], [5, 10],
  [5, 10], [5, 10], [5, 10], [5, 10],
  [5, 11], [5, 11], [5, 11], [5, 11],
  [5, 11], [5, 11], [5, 11], [5, 11],
  [5, 11], [5, 11], [5, 11], [5, 11],
  [5, 11], [5, 11], [5, 11], [5, 11],
  [7, 27], [7, 27], [7, 27], [7, 27],
  [8, 59], [8, 59],
  [8, 60], [8, 60],
  [9, 1472],
  [9, 1536],
  [9, 1600],
  [9, 1728],
  [7, 18], [7, 18], [7, 18], [7, 18],
  [7, 24], [7, 24], [7, 24], [7, 24],
  [8, 49], [8, 49],
  [8, 50], [8, 50],
  [8, 51], [8, 51],
  [8, 52], [8, 52],
  [7, 25], [7, 25], [7, 25], [7, 25],
  [8, 55], [8, 55],
  [8, 56], [8, 56],
  [8, 57], [8, 57],
  [8, 58], [8, 58],
  [6, 192], [6, 192], [6, 192], [6, 192],
  [6, 192], [6, 192], [6, 192], [6, 192],
  [6, 1664], [6, 1664], [6, 1664], [6, 1664],
  [6, 1664], [6, 1664], [6, 1664], [6, 1664],
  [8, 448], [8, 448],
  [8, 512], [8, 512],
  [9, 704],
  [9, 768],
  [8, 640], [8, 640],
  [8, 576], [8, 576],
  [9, 832],
  [9, 896],
  [9, 960],
  [9, 1024],
  [9, 1088],
  [9, 1152],
  [9, 1216],
  [9, 1280],
  [9, 1344],
  [9, 1408],
  [7, 256], [7, 256], [7, 256], [7, 256],
  [4, 2], [4, 2], [4, 2], [4, 2],
  [4, 2], [4, 2], [4, 2], [4, 2],
  [4, 2], [4, 2], [4, 2], [4, 2],
  [4, 2], [4, 2], [4, 2], [4, 2],
  [4, 2], [4, 2], [4, 2], [4, 2],
  [4, 2], [4, 2], [4, 2], [4, 2],
  [4, 2], [4, 2], [4, 2], [4, 2],
  [4, 2], [4, 2], [4, 2], [4, 2],
  [4, 3], [4, 3], [4, 3], [4, 3],
  [4, 3], [4, 3], [4, 3], [4, 3],
  [4, 3], [4, 3], [4, 3], [4, 3],
  [4, 3], [4, 3], [4, 3], [4, 3],
  [4, 3], [4, 3], [4, 3], [4, 3],
  [4, 3], [4, 3], [4, 3], [4, 3],
  [4, 3], [4, 3], [4, 3], [4, 3],
  [4, 3], [4, 3], [4, 3], [4, 3],
  [5, 128], [5, 128], [5, 128], [5, 128],
  [5, 128], [5, 128], [5, 128], [5, 128],
  [5, 128], [5, 128], [5, 128], [5, 128],
  [5, 128], [5, 128], [5, 128], [5, 128],
  [5, 8], [5, 8], [5, 8], [5, 8],
  [5, 8], [5, 8], [5, 8], [5, 8],
  [5, 8], [5, 8], [5, 8], [5, 8],
  [5, 8], [5, 8], [5, 8], [5, 8],
  [5, 9], [5, 9], [5, 9], [5, 9],
  [5, 9], [5, 9], [5, 9], [5, 9],
  [5, 9], [5, 9], [5, 9], [5, 9],
  [5, 9], [5, 9], [5, 9], [5, 9],
  [6, 16], [6, 16], [6, 16], [6, 16],
  [6, 16], [6, 16], [6, 16], [6, 16],
  [6, 17], [6, 17], [6, 17], [6, 17],
  [6, 17], [6, 17], [6, 17], [6, 17],
  [4, 4], [4, 4], [4, 4], [4, 4],
  [4, 4], [4, 4], [4, 4], [4, 4],
  [4, 4], [4, 4], [4, 4], [4, 4],
  [4, 4], [4, 4], [4, 4], [4, 4],
  [4, 4], [4, 4], [4, 4], [4, 4],
  [4, 4], [4, 4], [4, 4], [4, 4],
  [4, 4], [4, 4], [4, 4], [4, 4],
  [4, 4], [4, 4], [4, 4], [4, 4],
  [4, 5], [4, 5], [4, 5], [4, 5],
  [4, 5], [4, 5], [4, 5], [4, 5],
  [4, 5], [4, 5], [4, 5], [4, 5],
  [4, 5], [4, 5], [4, 5], [4, 5],
  [4, 5], [4, 5], [4, 5], [4, 5],
  [4, 5], [4, 5], [4, 5], [4, 5],
  [4, 5], [4, 5], [4, 5], [4, 5],
  [4, 5], [4, 5], [4, 5], [4, 5],
  [6, 14], [6, 14], [6, 14], [6, 14],
  [6, 14], [6, 14], [6, 14], [6, 14],
  [6, 15], [6, 15], [6, 15], [6, 15],
  [6, 15], [6, 15], [6, 15], [6, 15],
  [5, 64], [5, 64], [5, 64], [5, 64],
  [5, 64], [5, 64], [5, 64], [5, 64],
  [5, 64], [5, 64], [5, 64], [5, 64],
  [5, 64], [5, 64], [5, 64], [5, 64],
  [4, 6], [4, 6], [4, 6], [4, 6],
  [4, 6], [4, 6], [4, 6], [4, 6],
  [4, 6], [4, 6], [4, 6], [4, 6],
  [4, 6], [4, 6], [4, 6], [4, 6],
  [4, 6], [4, 6], [4, 6], [4, 6],
  [4, 6], [4, 6], [4, 6], [4, 6],
  [4, 6], [4, 6], [4, 6], [4, 6],
  [4, 6], [4, 6], [4, 6], [4, 6],
  [4, 7], [4, 7], [4, 7], [4, 7],
  [4, 7], [4, 7], [4, 7], [4, 7],
  [4, 7], [4, 7], [4, 7], [4, 7],
  [4, 7], [4, 7], [4, 7], [4, 7],
  [4, 7], [4, 7], [4, 7], [4, 7],
  [4, 7], [4, 7], [4, 7], [4, 7],
  [4, 7], [4, 7], [4, 7], [4, 7],
  [4, 7], [4, 7], [4, 7], [4, 7],
];

// prettier-ignore
const blackTable1 = [
  [-1, -1], [-1, -1],
  [12, ccittEOL], [12, ccittEOL],
  [-1, -1], [-1, -1], [-1, -1], [-1, -1],
  [-1, -1], [-1, -1], [-1, -1], [-1, -1],
  [-1, -1], [-1, -1], [-1, -1], [-1, -1],
  [-1, -1], [-1, -1], [-1, -1], [-1, -1],
  [-1, -1], [-1, -1], [-1, -1], [-1, -1],
  [-1, -1], [-1, -1], [-1, -1], [-1, -1],
  [-1, -1], [-1, -1], [-1, -1], [-1, -1],
  [11, 1792], [11, 1792], [11, 1792], [11, 1792],
  [12, 1984], [12, 1984],
  [12, 2048], [12, 2048],
  [12, 2112], [12, 2112],
  [12, 2176], [12, 2176],
  [12, 2240], [12, 2240],
  [12, 2304], [12, 2304],
  [11, 1856], [11, 1856], [11, 1856], [11, 1856],
  [11, 1920], [11, 1920], [11, 1920], [11, 1920],
  [12, 2368], [12, 2368],
  [12, 2432], [12, 2432],
  [12, 2496], [12, 2496],
  [12, 2560], [12, 2560],
  [10, 18], [10, 18], [10, 18], [10, 18],
  [10, 18], [10, 18], [10, 18], [10, 18],
  [12, 52], [12, 52],
  [13, 640],
  [13, 704],
  [13, 768],
  [13, 832],
  [12, 55], [12, 55],
  [12, 56], [12, 56],
  [13, 1280],
  [13, 1344],
  [13, 1408],
  [13, 1472],
  [12, 59], [12, 59],
  [12, 60], [12, 60],
  [13, 1536],
  [13, 1600],
  [11, 24], [11, 24], [11, 24], [11, 24],
  [11, 25], [11, 25], [11, 25], [11, 25],
  [13, 1664],
  [13, 1728],
  [12, 320], [12, 320],
  [12, 384], [12, 384],
  [12, 448], [12, 448],
  [13, 512],
  [13, 576],
  [12, 53], [12, 53],
  [12, 54], [12, 54],
  [13, 896],
  [13, 960],
  [13, 1024],
  [13, 1088],
  [13, 1152],
  [13, 1216],
  [10, 64], [10, 64], [10, 64], [10, 64],
  [10, 64], [10, 64], [10, 64], [10, 64],
];

// prettier-ignore
const blackTable2 = [
  [8, 13], [8, 13], [8, 13], [8, 13],
  [8, 13], [8, 13], [8, 13], [8, 13],
  [8, 13], [8, 13], [8, 13], [8, 13],
  [8, 13], [8, 13], [8, 13], [8, 13],
  [11, 23], [11, 23],
  [12, 50],
  [12, 51],
  [12, 44],
  [12, 45],
  [12, 46],
  [12, 47],
  [12, 57],
  [12, 58],
  [12, 61],
  [12, 256],
  [10, 16], [10, 16], [10, 16], [10, 16],
  [10, 17], [10, 17], [10, 17], [10, 17],
  [12, 48],
  [12, 49],
  [12, 62],
  [12, 63],
  [12, 30],
  [12, 31],
  [12, 32],
  [12, 33],
  [12, 40],
  [12, 41],
  [11, 22], [11, 22],
  [8, 14], [8, 14], [8, 14], [8, 14],
  [8, 14], [8, 14], [8, 14], [8, 14],
  [8, 14], [8, 14], [8, 14], [8, 14],
  [8, 14], [8, 14], [8, 14], [8, 14],
  [7, 10], [7, 10], [7, 10], [7, 10],
  [7, 10], [7, 10], [7, 10], [7, 10],
  [7, 10], [7, 10], [7, 10], [7, 10],
  [7, 10], [7, 10], [7, 10], [7, 10],
  [7, 10], [7, 10], [7, 10], [7, 10],
  [7, 10], [7, 10], [7, 10], [7, 10],
  [7, 10], [7, 10], [7, 10], [7, 10],
  [7, 10], [7, 10], [7, 10], [7, 10],
  [7, 11], [7, 11], [7, 11], [7, 11],
  [7, 11], [7, 11], [7, 11], [7, 11],
  [7, 11], [7, 11], [7, 11], [7, 11],
  [7, 11], [7, 11], [7, 11], [7, 11],
  [7, 11], [7, 11], [7, 11], [7, 11],
  [7, 11], [7, 11], [7, 11], [7, 11],
  [7, 11], [7, 11], [7, 11], [7, 11],
  [7, 11], [7, 11], [7, 11], [7, 11],
  [9, 15], [9, 15], [9, 15], [9, 15],
  [9, 15], [9, 15], [9, 15], [9, 15],
  [12, 128],
  [12, 192],
  [12, 26],
  [12, 27],
  [12, 28],
  [12, 29],
  [11, 19], [11, 19],
  [11, 20], [11, 20],
  [12, 34],
  [12, 35],
  [12, 36],
  [12, 37],
  [12, 38],
  [12, 39],
  [11, 21], [11, 21],
  [12, 42],
  [12, 43],
  [10, 0], [10, 0], [10, 0], [10, 0],
  [7, 12], [7, 12], [7, 12], [7, 12],
  [7, 12], [7, 12], [7, 12], [7, 12],
  [7, 12], [7, 12], [7, 12], [7, 12],
  [7, 12], [7, 12], [7, 12], [7, 12],
  [7, 12], [7, 12], [7, 12], [7, 12],
  [7, 12], [7, 12], [7, 12], [7, 12],
  [7, 12], [7, 12], [7, 12], [7, 12],
  [7, 12], [7, 12], [7, 12], [7, 12],
];

// prettier-ignore
const blackTable3 = [
  [-1, -1], [-1, -1], [-1, -1], [-1, -1],
  [6, 9],
  [6, 8],
  [5, 7], [5, 7],
  [4, 6], [4, 6], [4, 6], [4, 6],
  [4, 5], [4, 5], [4, 5], [4, 5],
  [3, 1], [3, 1], [3, 1], [3, 1],
  [3, 1], [3, 1], [3, 1], [3, 1],
  [3, 4], [3, 4], [3, 4], [3, 4],
  [3, 4], [3, 4], [3, 4], [3, 4],
  [2, 3], [2, 3], [2, 3], [2, 3],
  [2, 3], [2, 3], [2, 3], [2, 3],
  [2, 3], [2, 3], [2, 3], [2, 3],
  [2, 3], [2, 3], [2, 3], [2, 3],
  [2, 2], [2, 2], [2, 2], [2, 2],
  [2, 2], [2, 2], [2, 2], [2, 2],
  [2, 2], [2, 2], [2, 2], [2, 2],
  [2, 2], [2, 2], [2, 2], [2, 2],
];

/**
 * Flatten a table of [len, val] pairs into one contiguous Int16Array to avoid a pointer chase per code lookup.
 * @param {[number, number][]} tbl Table of [len, val] pairs.
 * @returns {Int16Array} Flattened pairs, with len at even indices and val at odd indices.
 */
function flattenTable(tbl) {
  const a = new Int16Array(tbl.length * 2);
  for (let i = 0; i < tbl.length; i++) {
    a[2 * i] = tbl[i][0];
    a[2 * i + 1] = tbl[i][1];
  }
  return a;
}
const twoDimFlat = flattenTable(twoDimTable);
const whiteFlat1 = flattenTable(whiteTable1);
const whiteFlat2 = flattenTable(whiteTable2);
const blackFlat1 = flattenTable(blackTable1);
const blackFlat2 = flattenTable(blackTable2);
const blackFlat3 = flattenTable(blackTable3);

export class CCITTFaxDecoder {
  constructor(source, options = {}) {
    // Accepts a Uint8Array directly (indexed inline) or a { next() } source object.
    if (source && typeof source.next === 'function') {
      this.data = null;
      this.source = source;
    } else {
      this.data = source;
      this.source = null;
    }
    this.dataPos = 0;
    this.eof = false;

    this.encoding = options.K || 0;
    this.eoline = options.EndOfLine || false;
    this.byteAlign = options.EncodedByteAlign || false;
    this.columns = options.Columns || 1728;
    this.rows = options.Rows || 0;
    this.eoblock = options.EndOfBlock !== false;
    this.black = options.BlackIs1 || false;

    this.codingLine = new Uint32Array(this.columns + 1);
    this.refLine = new Uint32Array(this.columns + 2);

    this.codingLine[0] = this.columns;
    this.codingPos = 0;
    this._nextRowBuf = null;
    this._nextRowPos = 0;
    this._nextRowLen = 0;

    this.row = 0;
    this.nextLine2D = this.encoding < 0;
    this.inputBits = 0;
    this.inputBuf = 0;
    this.outputBits = 0;
    this.rowsDone = false;

    let code1;
    while ((code1 = this._lookBits(12)) === 0) {
      this._eatBits(1);
    }
    if (code1 === 1) {
      this._eatBits(12);
    }
    if (this.encoding > 0) {
      this.nextLine2D = !this._lookBits(1);
      this._eatBits(1);
    }
  }

  /**
   * Byte-at-a-time view over readRow for callers that stream bytes (JBIG2's MMR path): serves the buffered row, decoding the next row when it runs dry.
   * @returns {number} the next byte, or -1 at end of data
   */
  readNextChar() {
    if (this._nextRowBuf && this._nextRowPos < this._nextRowLen) {
      return this._nextRowBuf[this._nextRowPos++];
    }
    if (!this._nextRowBuf) this._nextRowBuf = new Uint8Array((this.columns + 7) >> 3);
    const wrote = this.readRow(this._nextRowBuf, 0);
    if (wrote <= 0) return -1;
    this._nextRowLen = wrote;
    this._nextRowPos = 1;
    return this._nextRowBuf[0];
  }

  /**
   * Decode one row and write its packed bytes at out[outPos..outPos+rowBytes).
   * @param {Uint8Array} out buffer that receives the packed row bytes
   * @param {number} outPos byte offset in out at which to start writing
   * @returns {number} bytes written (0 at end of data)
   */
  readRow(out, outPos) {
    if (this.rowsDone) {
      this.eof = true;
    }
    if (this.eof) {
      return 0;
    }
    const refLine = this.refLine;
    const codingLine = this.codingLine;
    const columns = this.columns;
    let refPos;
    let blackPixels;
    let i;

    this.err = false;

    let code1;
    let code2;
    let code3;

    if (this.nextLine2D) {
      for (i = 0; codingLine[i] < columns; ++i) {
        refLine[i] = codingLine[i];
      }
      refLine[i++] = columns;
      refLine[i] = columns;
      codingLine[0] = 0;
      this.codingPos = 0;
      refPos = 0;
      blackPixels = 0;

      while (codingLine[this.codingPos] < columns) {
        code1 = this._getTwoDimCode();
        switch (code1) {
          case twoDimPass:
            this._addPixels(refLine[refPos + 1], blackPixels);
            if (refLine[refPos + 1] < columns) {
              refPos += 2;
            }
            break;
          case twoDimHoriz:
            code1 = code2 = 0;
            if (blackPixels) {
              do {
                code1 += code3 = this._getBlackCode();
              } while (code3 >= 64);
              do {
                code2 += code3 = this._getWhiteCode();
              } while (code3 >= 64);
            } else {
              do {
                code1 += code3 = this._getWhiteCode();
              } while (code3 >= 64);
              do {
                code2 += code3 = this._getBlackCode();
              } while (code3 >= 64);
            }
            this._addPixels(codingLine[this.codingPos] + code1, blackPixels);
            if (codingLine[this.codingPos] < columns) {
              this._addPixels(
                codingLine[this.codingPos] + code2,
                blackPixels ^ 1,
              );
            }
            while (
              refLine[refPos] <= codingLine[this.codingPos]
                && refLine[refPos] < columns
            ) {
              refPos += 2;
            }
            break;
          case twoDimVertR3:
            this._addPixels(refLine[refPos] + 3, blackPixels);
            blackPixels ^= 1;
            if (codingLine[this.codingPos] < columns) {
              ++refPos;
              while (refLine[refPos] <= codingLine[this.codingPos] && refLine[refPos] < columns) { refPos += 2; }
            }
            break;
          case twoDimVertR2:
            this._addPixels(refLine[refPos] + 2, blackPixels);
            blackPixels ^= 1;
            if (codingLine[this.codingPos] < columns) {
              ++refPos;
              while (refLine[refPos] <= codingLine[this.codingPos] && refLine[refPos] < columns) { refPos += 2; }
            }
            break;
          case twoDimVertR1:
            this._addPixels(refLine[refPos] + 1, blackPixels);
            blackPixels ^= 1;
            if (codingLine[this.codingPos] < columns) {
              ++refPos;
              while (refLine[refPos] <= codingLine[this.codingPos] && refLine[refPos] < columns) { refPos += 2; }
            }
            break;
          case twoDimVert0:
            this._addPixels(refLine[refPos], blackPixels);
            blackPixels ^= 1;
            if (codingLine[this.codingPos] < columns) {
              ++refPos;
              while (refLine[refPos] <= codingLine[this.codingPos] && refLine[refPos] < columns) { refPos += 2; }
            }
            break;
          case twoDimVertL3:
            this._addPixelsNeg(refLine[refPos] - 3, blackPixels);
            blackPixels ^= 1;
            if (codingLine[this.codingPos] < columns) {
              if (refPos > 0) { --refPos; } else { ++refPos; }
              while (refLine[refPos] <= codingLine[this.codingPos] && refLine[refPos] < columns) { refPos += 2; }
            }
            break;
          case twoDimVertL2:
            this._addPixelsNeg(refLine[refPos] - 2, blackPixels);
            blackPixels ^= 1;
            if (codingLine[this.codingPos] < columns) {
              if (refPos > 0) { --refPos; } else { ++refPos; }
              while (refLine[refPos] <= codingLine[this.codingPos] && refLine[refPos] < columns) { refPos += 2; }
            }
            break;
          case twoDimVertL1:
            this._addPixelsNeg(refLine[refPos] - 1, blackPixels);
            blackPixels ^= 1;
            if (codingLine[this.codingPos] < columns) {
              if (refPos > 0) { --refPos; } else { ++refPos; }
              while (refLine[refPos] <= codingLine[this.codingPos] && refLine[refPos] < columns) { refPos += 2; }
            }
            break;
          case ccittEOF:
            this._addPixels(columns, 0);
            this.eof = true;
            break;
          default:
            console.warn('bad 2d code');
            this._addPixels(columns, 0);
            this.err = true;
        }
      }
    } else {
      codingLine[0] = 0;
      this.codingPos = 0;
      blackPixels = 0;
      while (codingLine[this.codingPos] < columns) {
        code1 = 0;
        if (blackPixels) {
          do {
            code1 += code3 = this._getBlackCode();
          } while (code3 >= 64);
        } else {
          do {
            code1 += code3 = this._getWhiteCode();
          } while (code3 >= 64);
        }
        this._addPixels(codingLine[this.codingPos] + code1, blackPixels);
        blackPixels ^= 1;
      }
    }

    let gotEOL = false;

    if (this.byteAlign) {
      this.inputBits &= ~7;
    }

    if (!this.eoblock && this.row === this.rows - 1) {
      this.rowsDone = true;
    } else {
      code1 = this._lookBits(12);
      if (this.eoline) {
        while (code1 !== ccittEOF && code1 !== 1) {
          this._eatBits(1);
          code1 = this._lookBits(12);
        }
      } else {
        while (code1 === 0) {
          this._eatBits(1);
          code1 = this._lookBits(12);
        }
      }
      if (code1 === 1) {
        this._eatBits(12);
        gotEOL = true;
      } else if (code1 === ccittEOF) {
        this.eof = true;
      }
    }

    if (!this.eof && this.encoding > 0 && !this.rowsDone) {
      this.nextLine2D = !this._lookBits(1);
      this._eatBits(1);
    }

    if (this.eoblock && gotEOL && this.byteAlign) {
      code1 = this._lookBits(12);
      if (code1 === 1) {
        this._eatBits(12);
        if (this.encoding > 0) {
          this._lookBits(1);
          this._eatBits(1);
        }
        if (this.encoding >= 0) {
          for (i = 0; i < 4; ++i) {
            code1 = this._lookBits(12);
            if (code1 !== 1) {
              console.warn(`bad rtc code: ${code1}`);
            }
            this._eatBits(12);
            if (this.encoding > 0) {
              this._lookBits(1);
              this._eatBits(1);
            }
          }
        }
        this.eof = true;
      }
    } else if (this.err && this.eoline) {
      while (true) {
        code1 = this._lookBits(13);
        if (code1 === ccittEOF) {
          this.eof = true;
          return -1;
        }
        if (code1 >> 1 === 1) {
          break;
        }
        this._eatBits(1);
      }
      this._eatBits(12);
      if (this.encoding > 0) {
        this._eatBits(1);
        this.nextLine2D = !(code1 & 1);
      }
    }

    this.row++;

    if (this.eof) {
      // eof was discovered while decoding this row: the byte-at-a-time reader emits exactly one byte of it
      // (its top-of-call eof check fires on the next call), so reproduce that single-byte tail.
      if (!this._rowScratch) this._rowScratch = new Uint8Array((this.columns + 7) >> 3);
      this._emitRow(this._rowScratch, 0);
      out[outPos] = this._rowScratch[0];
      return 1;
    }
    return this._emitRow(out, outPos);
  }

  _emitRow(out, outPos) {
    const columns = this.columns;
    const codingLine = this.codingLine;
    const rowBytes = (columns + 7) >> 3;
    out.fill(0, outPos, outPos + rowBytes);
    let prev = 0;
    for (let i = 0; prev < columns; i++) {
      let end = codingLine[i];
      if (end > columns) end = columns;
      if ((i & 1) === 0 && end > prev) {
        const firstByte = outPos + (prev >> 3);
        const lastByte = outPos + ((end - 1) >> 3);
        if (firstByte === lastByte) {
          out[firstByte] |= (0xFF >> (prev & 7)) & (0xFF << (7 - ((end - 1) & 7)));
        } else {
          out[firstByte] |= 0xFF >> (prev & 7);
          for (let bb = firstByte + 1; bb < lastByte; bb++) out[bb] = 0xFF;
          out[lastByte] |= 0xFF << (7 - ((end - 1) & 7));
        }
      }
      prev = end;
    }
    if (this.black) {
      for (let bb = outPos; bb < outPos + rowBytes; bb++) out[bb] ^= 0xFF;
    }
    return rowBytes;
  }

  _addPixels(a1, blackPixels) {
    const codingLine = this.codingLine;
    let codingPos = this.codingPos;
    if (a1 > codingLine[codingPos]) {
      if (a1 > this.columns) {
        console.warn('row is wrong length');
        this.err = true;
        a1 = this.columns;
      }
      if ((codingPos & 1) ^ blackPixels) {
        ++codingPos;
      }
      codingLine[codingPos] = a1;
    }
    this.codingPos = codingPos;
  }

  _addPixelsNeg(a1, blackPixels) {
    const codingLine = this.codingLine;
    let codingPos = this.codingPos;
    if (a1 > codingLine[codingPos]) {
      if (a1 > this.columns) {
        console.warn('row is wrong length');
        this.err = true;
        a1 = this.columns;
      }
      if ((codingPos & 1) ^ blackPixels) {
        ++codingPos;
      }
      codingLine[codingPos] = a1;
    } else if (a1 < codingLine[codingPos]) {
      if (a1 < 0) {
        console.warn('invalid code');
        this.err = true;
        a1 = 0;
      }
      while (codingPos > 0 && a1 < codingLine[codingPos - 1]) {
        --codingPos;
      }
      codingLine[codingPos] = a1;
    }
    this.codingPos = codingPos;
  }

  _findTableCode(start, end, table, limit) {
    const limitValue = limit || 0;
    for (let i = start; i <= end; ++i) {
      let code = this._lookBits(i);
      if (code === ccittEOF) {
        return [true, 1, false];
      }
      if (i < end) {
        code <<= end - i;
      }
      if (!limitValue || code >= limitValue) {
        const fi = (code - limitValue) * 2;
        if (table[fi] === i) {
          this._eatBits(i);
          return [true, table[fi + 1], true];
        }
      }
    }
    return [false, 0, false];
  }

  _getTwoDimCode() {
    let code = 0;
    let p;
    if (this.eoblock) {
      code = this._lookBits(7);
      if (code === ccittEOF) {
        return ccittEOF;
      }
      const len = code < twoDimFlat.length / 2 ? twoDimFlat[code * 2] : -1;
      if (len > 0) {
        this._eatBits(len);
        return twoDimFlat[code * 2 + 1];
      }
    } else {
      const result = this._findTableCode(1, 7, twoDimFlat);
      if (result[0] && result[2]) {
        return result[1];
      }
    }
    return ccittEOF;
  }

  _getWhiteCode() {
    let code = 0;
    let p;
    if (this.eoblock) {
      code = this._lookBits(12);
      if (code === ccittEOF) {
        return 1;
      }
      const wi = code >> 5 === 0 ? code * 2 : (code >> 3) * 2;
      const wt = code >> 5 === 0 ? whiteFlat1 : whiteFlat2;
      if (wt[wi] > 0) {
        this._eatBits(wt[wi]);
        return wt[wi + 1];
      }
    } else {
      let result = this._findTableCode(1, 9, whiteFlat2);
      if (result[0]) {
        return result[1];
      }
      result = this._findTableCode(11, 12, whiteFlat1);
      if (result[0]) {
        return result[1];
      }
    }
    console.warn('bad white code');
    this._eatBits(1);
    return 1;
  }

  _getBlackCode() {
    let code;
    let p;
    if (this.eoblock) {
      code = this._lookBits(13);
      if (code === ccittEOF) {
        return 1;
      }
      let bt;
      let bi;
      if (code >> 7 === 0) {
        bt = blackFlat1;
        bi = code * 2;
      } else if (code >> 9 === 0 && code >> 7 !== 0) {
        bt = blackFlat2;
        bi = ((code >> 1) - 64) * 2;
      } else {
        bt = blackFlat3;
        bi = (code >> 7) * 2;
      }
      if (bt[bi] > 0) {
        this._eatBits(bt[bi]);
        return bt[bi + 1];
      }
    } else {
      let result = this._findTableCode(2, 6, blackFlat3);
      if (result[0]) {
        return result[1];
      }
      result = this._findTableCode(7, 12, blackFlat2, 64);
      if (result[0]) {
        return result[1];
      }
      result = this._findTableCode(10, 13, blackFlat1);
      if (result[0]) {
        return result[1];
      }
    }
    console.warn('bad black code');
    this._eatBits(1);
    return 1;
  }

  _lookBits(n) {
    const data = this.data;
    if (data !== null) {
      while (this.inputBits < n) {
        if (this.dataPos >= data.length) {
          if (this.inputBits === 0) {
            return ccittEOF;
          }
          return (this.inputBuf << (n - this.inputBits)) & (0xffff >> (16 - n));
        }
        this.inputBuf = (this.inputBuf << 8) | data[this.dataPos++];
        this.inputBits += 8;
      }
      return (this.inputBuf >> (this.inputBits - n)) & (0xffff >> (16 - n));
    }
    let c;
    while (this.inputBits < n) {
      if ((c = this.source.next()) === -1) {
        if (this.inputBits === 0) {
          return ccittEOF;
        }
        return (this.inputBuf << (n - this.inputBits)) & (0xffff >> (16 - n));
      }
      this.inputBuf = (this.inputBuf << 8) | c;
      this.inputBits += 8;
    }
    return (this.inputBuf >> (this.inputBits - n)) & (0xffff >> (16 - n));
  }

  _eatBits(n) {
    if ((this.inputBits -= n) < 0) {
      this.inputBits = 0;
    }
  }
}

/**
 * Decode CCITT fax compressed data.
 *
 * @param {Uint8Array} data - Compressed data
 * @param {{K?: number, Columns?: number, Rows?: number, EndOfBlock?: boolean, BlackIs1?: boolean, EncodedByteAlign?: boolean, EndOfLine?: boolean}} params
 */
export function decodeCCITTFax(data, params = {}) {
  const decoder = new CCITTFaxDecoder(data, {
    K: params.K || 0,
    Columns: params.Columns || 1728,
    Rows: params.Rows || 0,
    EndOfBlock: params.EndOfBlock !== false,
    EncodedByteAlign: params.EncodedByteAlign || false,
    EndOfLine: params.EndOfLine || false,
    BlackIs1: params.BlackIs1 || false,
  });
  const rowBytes = ((params.Columns || 1728) + 7) >> 3;

  if (params.Rows && params.Columns) {
    const expected = rowBytes * params.Rows;
    const out = new Uint8Array(expected);
    let p = 0;
    while (p < expected) {
      const wrote = decoder.readRow(out, p);
      if (wrote <= 0) break;
      p += wrote;
    }
    if (p < expected) {
      // Fewer bytes than Rows demands: pad the remainder white (CCITT convention).
      out.fill(params.BlackIs1 ? 0x00 : 0xFF, p);
      return out;
    }
    // An EndOfBlock stream isn't bound by /Rows, so keep any rows beyond the declared height.
    let extra = null;
    let extraLen = 0;
    const rowBuf = new Uint8Array(rowBytes);
    let wroteExtra = decoder.readRow(rowBuf, 0);
    while (wroteExtra > 0) {
      if (!extra) extra = new Uint8Array(rowBytes * 16);
      if (extraLen + wroteExtra > extra.length) {
        const grown = new Uint8Array(extra.length * 2);
        grown.set(extra.subarray(0, extraLen));
        extra = grown;
      }
      extra.set(rowBuf.subarray(0, wroteExtra), extraLen);
      extraLen += wroteExtra;
      wroteExtra = decoder.readRow(rowBuf, 0);
    }
    if (extraLen === 0) return out;
    const full = new Uint8Array(expected + extraLen);
    full.set(out);
    full.set(extra.subarray(0, extraLen), expected);
    return full;
  }
  // Dimensions unknown: accumulate rows, then size to fit.
  let buf = new Uint8Array(rowBytes * 64);
  let len = 0;
  let wrote = decoder.readRow(buf, len);
  while (wrote > 0) {
    len += wrote;
    if (len + rowBytes > buf.length) {
      const grown = new Uint8Array(buf.length * 2);
      grown.set(buf.subarray(0, len));
      buf = grown;
    }
    wrote = decoder.readRow(buf, len);
  }
  return buf.slice(0, len);
}
