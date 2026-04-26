/**
 * Find the byte offset of `needle` (an ASCII string) inside `bytes`, scanning
 * forward from `from`. Returns -1 if not found.
 * @param {Uint8Array} bytes
 * @param {string} needle - ASCII only
 * @param {number} [from=0]
 */
function byteIndexOf(bytes, needle, from = 0) {
  const nLen = needle.length;
  if (nLen === 0) return from;
  const c0 = needle.charCodeAt(0);
  if (nLen === 1) return bytes.indexOf(c0, from);
  const last = bytes.length - nLen;
  let i = from;
  while (i <= last) {
    i = bytes.indexOf(c0, i);
    if (i === -1 || i > last) return -1;
    let j = 1;
    while (j < nLen && bytes[i + j] === needle.charCodeAt(j)) j++;
    if (j === nLen) return i;
    i++;
  }
  return -1;
}

/**
 * PDF whitespace bytes per spec §3.1.1: NUL, HT, LF, FF, CR, SP.
 * @param {number} b
 */
function isPdfWhitespace(b) {
  return b === 0x20 || b === 0x09 || b === 0x0A || b === 0x0D || b === 0x0C || b === 0x00;
}

/**
 * ASCII digit byte (0-9).
 * @param {number} b
 */
function isAsciiDigit(b) {
  return b >= 0x30 && b <= 0x39;
}

/** @type {Uint32Array} Pre-computed T values: floor(2^32 * abs(sin(i+1))) */
const MD5_K = new Uint32Array([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
]);
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/**
 * Compute MD5 hash of a Uint8Array.
 * @param {Uint8Array} data
 * @returns {Uint8Array} 16-byte hash
 */
function md5(data) {
  const len = data.length;
  const bitLen = len * 8;
  const padLen = ((56 - (len + 1) % 64) + 64) % 64;
  const padded = new Uint8Array(len + 1 + padLen + 8);
  padded.set(data);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLen >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor(bitLen / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < padded.length; offset += 64) {
    const M = new Uint32Array(16);
    for (let j = 0; j < 16; j++) M[j] = dv.getUint32(offset + j * 4, true);
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;
    for (let i = 0; i < 64; i++) {
      let F; let g;
      if (i < 16) {
        F = (B & C) | (~B & D); g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C); g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D; g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D); g = (7 * i) % 16;
      }
      F = (F + A + MD5_K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << MD5_S[i]) | (F >>> (32 - MD5_S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const result = new Uint8Array(16);
  const rdv = new DataView(result.buffer);
  rdv.setUint32(0, a0, true);
  rdv.setUint32(4, b0, true);
  rdv.setUint32(8, c0, true);
  rdv.setUint32(12, d0, true);
  return result;
}

/**
 * RC4 encrypt/decrypt (symmetric).
 * @param {Uint8Array} key
 * @param {Uint8Array} data
 */
export function rc4(key, data) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 0xFF;
    const tmp = S[i]; S[i] = S[j]; S[j] = tmp;
  }
  const output = new Uint8Array(data.length);
  let i2 = 0; j = 0;
  for (let k = 0; k < data.length; k++) {
    i2 = (i2 + 1) & 0xFF;
    j = (j + S[i2]) & 0xFF;
    const tmp = S[i2]; S[i2] = S[j]; S[j] = tmp;
    output[k] = data[k] ^ S[(S[i2] + S[j]) & 0xFF];
  }
  return output;
}

// AES inverse S-box (used for InvSubBytes in decryption)
const AES_INV_SBOX = new Uint8Array([
  0x52, 0x09, 0x6a, 0xd5, 0x30, 0x36, 0xa5, 0x38, 0xbf, 0x40, 0xa3, 0x9e, 0x81, 0xf3, 0xd7, 0xfb,
  0x7c, 0xe3, 0x39, 0x82, 0x9b, 0x2f, 0xff, 0x87, 0x34, 0x8e, 0x43, 0x44, 0xc4, 0xde, 0xe9, 0xcb,
  0x54, 0x7b, 0x94, 0x32, 0xa6, 0xc2, 0x23, 0x3d, 0xee, 0x4c, 0x95, 0x0b, 0x42, 0xfa, 0xc3, 0x4e,
  0x08, 0x2e, 0xa1, 0x66, 0x28, 0xd9, 0x24, 0xb2, 0x76, 0x5b, 0xa2, 0x49, 0x6d, 0x8b, 0xd1, 0x25,
  0x72, 0xf8, 0xf6, 0x64, 0x86, 0x68, 0x98, 0x16, 0xd4, 0xa4, 0x5c, 0xcc, 0x5d, 0x65, 0xb6, 0x92,
  0x6c, 0x70, 0x48, 0x50, 0xfd, 0xed, 0xb9, 0xda, 0x5e, 0x15, 0x46, 0x57, 0xa7, 0x8d, 0x9d, 0x84,
  0x90, 0xd8, 0xab, 0x00, 0x8c, 0xbc, 0xd3, 0x0a, 0xf7, 0xe4, 0x58, 0x05, 0xb8, 0xb3, 0x45, 0x06,
  0xd0, 0x2c, 0x1e, 0x8f, 0xca, 0x3f, 0x0f, 0x02, 0xc1, 0xaf, 0xbd, 0x03, 0x01, 0x13, 0x8a, 0x6b,
  0x3a, 0x91, 0x11, 0x41, 0x4f, 0x67, 0xdc, 0xea, 0x97, 0xf2, 0xcf, 0xce, 0xf0, 0xb4, 0xe6, 0x73,
  0x96, 0xac, 0x74, 0x22, 0xe7, 0xad, 0x35, 0x85, 0xe2, 0xf9, 0x37, 0xe8, 0x1c, 0x75, 0xdf, 0x6e,
  0x47, 0xf1, 0x1a, 0x71, 0x1d, 0x29, 0xc5, 0x89, 0x6f, 0xb7, 0x62, 0x0e, 0xaa, 0x18, 0xbe, 0x1b,
  0xfc, 0x56, 0x3e, 0x4b, 0xc6, 0xd2, 0x79, 0x20, 0x9a, 0xdb, 0xc0, 0xfe, 0x78, 0xcd, 0x5a, 0xf4,
  0x1f, 0xdd, 0xa8, 0x33, 0x88, 0x07, 0xc7, 0x31, 0xb1, 0x12, 0x10, 0x59, 0x27, 0x80, 0xec, 0x5f,
  0x60, 0x51, 0x7f, 0xa9, 0x19, 0xb5, 0x4a, 0x0d, 0x2d, 0xe5, 0x7a, 0x9f, 0x93, 0xc9, 0x9c, 0xef,
  0xa0, 0xe0, 0x3b, 0x4d, 0xae, 0x2a, 0xf5, 0xb0, 0xc8, 0xeb, 0xbb, 0x3c, 0x83, 0x53, 0x99, 0x61,
  0x17, 0x2b, 0x04, 0x7e, 0xba, 0x77, 0xd6, 0x26, 0xe1, 0x69, 0x14, 0x63, 0x55, 0x21, 0x0c, 0x7d,
]);

// AES forward S-box (used only during key expansion)
const AES_SBOX = new Uint8Array([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]);

// AES round constants for key expansion
const AES_RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

/**
 * Expand a 16-byte AES-128 key into 11 round keys (176 bytes).
 * Returns equivalent inverse cipher round keys: rounds 1-9 are transformed
 * through InvMixColumns so the T-table decryption approach works correctly.
 * @param {Uint8Array} key
 */
function aesExpandKey(key) {
  const w = new Uint32Array(44);
  for (let i = 0; i < 4; i++) {
    w[i] = (key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3];
  }
  for (let i = 4; i < 44; i++) {
    let t = w[i - 1];
    if (i % 4 === 0) {
      // RotWord + SubWord + Rcon
      t = (AES_SBOX[(t >>> 16) & 0xFF] << 24) | (AES_SBOX[(t >>> 8) & 0xFF] << 16)
        | (AES_SBOX[t & 0xFF] << 8) | AES_SBOX[(t >>> 24) & 0xFF];
      t ^= (AES_RCON[i / 4 - 1] << 24);
    }
    w[i] = w[i - 4] ^ t;
  }
  // Transform rounds 1-9 through InvMixColumns for the equivalent inverse cipher.
  // InvMixColumns(word) = Td0[Sbox[b0]] ^ Td1[Sbox[b1]] ^ Td2[Sbox[b2]] ^ Td3[Sbox[b3]]
  for (let i = 4; i < 40; i++) {
    const v = w[i];
    w[i] = _td0[AES_SBOX[(v >>> 24) & 0xFF]] ^ _td1[AES_SBOX[(v >>> 16) & 0xFF]]
      ^ _td2[AES_SBOX[(v >>> 8) & 0xFF]] ^ _td3[AES_SBOX[v & 0xFF]];
  }
  return w;
}

// Precomputed inverse MixColumns lookup tables (Td0-Td3)
// These combine InvSubBytes and InvMixColumns into a single table lookup per byte.
const _td0 = new Uint32Array(256);
const _td1 = new Uint32Array(256);
const _td2 = new Uint32Array(256);
const _td3 = new Uint32Array(256);
{
  // GF(2^8) multiply helpers
  const xtime = (a) => ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xFF;
  const mul = (a, b) => {
    let r = 0;
    let aa = a;
    for (let i = 0; i < 8; i++) { if (b & (1 << i)) r ^= aa; aa = xtime(aa); }
    return r;
  };
  for (let i = 0; i < 256; i++) {
    const s = AES_INV_SBOX[i];
    const e = mul(s, 0x0e); const b = mul(s, 0x0b); const d = mul(s, 0x0d); const
      n = mul(s, 0x09);
    _td0[i] = (e << 24) | (n << 16) | (d << 8) | b;
    _td1[i] = (b << 24) | (e << 16) | (n << 8) | d;
    _td2[i] = (d << 24) | (b << 16) | (e << 8) | n;
    _td3[i] = (n << 24) | (d << 16) | (b << 8) | e;
  }
}

/**
 * Decrypt a single 16-byte block using AES-128 (equivalent inverse cipher).
 * Uses T-table approach: combined InvSubBytes + InvMixColumns lookup.
 * @param {Uint8Array} block - 16-byte ciphertext block
 * @param {Uint32Array} rk - 44-word expanded key
 * @param {Uint8Array} out - 16-byte output buffer
 */
function aesDecryptBlock(block, rk, out) {
  // Load block as 4 big-endian 32-bit words, XOR with last round key
  let s0 = ((block[0] << 24) | (block[1] << 16) | (block[2] << 8) | block[3]) ^ rk[40];
  let s1 = ((block[4] << 24) | (block[5] << 16) | (block[6] << 8) | block[7]) ^ rk[41];
  let s2 = ((block[8] << 24) | (block[9] << 16) | (block[10] << 8) | block[11]) ^ rk[42];
  let s3 = ((block[12] << 24) | (block[13] << 16) | (block[14] << 8) | block[15]) ^ rk[43];

  // Rounds 9 down to 1: InvShiftRows + InvSubBytes + InvMixColumns via T-tables
  for (let r = 9; r >= 1; r--) {
    const k = r * 4;
    const t0 = _td0[(s0 >>> 24)] ^ _td1[(s3 >>> 16) & 0xFF] ^ _td2[(s2 >>> 8) & 0xFF] ^ _td3[s1 & 0xFF] ^ rk[k];
    const t1 = _td0[(s1 >>> 24)] ^ _td1[(s0 >>> 16) & 0xFF] ^ _td2[(s3 >>> 8) & 0xFF] ^ _td3[s2 & 0xFF] ^ rk[k + 1];
    const t2 = _td0[(s2 >>> 24)] ^ _td1[(s1 >>> 16) & 0xFF] ^ _td2[(s0 >>> 8) & 0xFF] ^ _td3[s3 & 0xFF] ^ rk[k + 2];
    const t3 = _td0[(s3 >>> 24)] ^ _td1[(s2 >>> 16) & 0xFF] ^ _td2[(s1 >>> 8) & 0xFF] ^ _td3[s0 & 0xFF] ^ rk[k + 3];
    s0 = t0; s1 = t1; s2 = t2; s3 = t3;
  }

  // Final round: InvShiftRows + InvSubBytes + AddRoundKey (no InvMixColumns)
  out[0] = AES_INV_SBOX[(s0 >>> 24)] ^ (rk[0] >>> 24);
  out[1] = AES_INV_SBOX[(s3 >>> 16) & 0xFF] ^ ((rk[0] >>> 16) & 0xFF);
  out[2] = AES_INV_SBOX[(s2 >>> 8) & 0xFF] ^ ((rk[0] >>> 8) & 0xFF);
  out[3] = AES_INV_SBOX[s1 & 0xFF] ^ (rk[0] & 0xFF);
  out[4] = AES_INV_SBOX[(s1 >>> 24)] ^ (rk[1] >>> 24);
  out[5] = AES_INV_SBOX[(s0 >>> 16) & 0xFF] ^ ((rk[1] >>> 16) & 0xFF);
  out[6] = AES_INV_SBOX[(s3 >>> 8) & 0xFF] ^ ((rk[1] >>> 8) & 0xFF);
  out[7] = AES_INV_SBOX[s2 & 0xFF] ^ (rk[1] & 0xFF);
  out[8] = AES_INV_SBOX[(s2 >>> 24)] ^ (rk[2] >>> 24);
  out[9] = AES_INV_SBOX[(s1 >>> 16) & 0xFF] ^ ((rk[2] >>> 16) & 0xFF);
  out[10] = AES_INV_SBOX[(s0 >>> 8) & 0xFF] ^ ((rk[2] >>> 8) & 0xFF);
  out[11] = AES_INV_SBOX[s3 & 0xFF] ^ (rk[2] & 0xFF);
  out[12] = AES_INV_SBOX[(s3 >>> 24)] ^ (rk[3] >>> 24);
  out[13] = AES_INV_SBOX[(s2 >>> 16) & 0xFF] ^ ((rk[3] >>> 16) & 0xFF);
  out[14] = AES_INV_SBOX[(s1 >>> 8) & 0xFF] ^ ((rk[3] >>> 8) & 0xFF);
  out[15] = AES_INV_SBOX[s0 & 0xFF] ^ (rk[3] & 0xFF);
}

/**
 * Expand a 32-byte AES-256 key into 15 round keys (240 bytes).
 * Returns equivalent inverse cipher round keys for T-table decryption.
 * @param {Uint8Array} key - 32-byte key
 */
function aes256ExpandKey(key) {
  const w = new Uint32Array(60);
  for (let i = 0; i < 8; i++) {
    w[i] = (key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3];
  }
  for (let i = 8; i < 60; i++) {
    let t = w[i - 1];
    if (i % 8 === 0) {
      t = (AES_SBOX[(t >>> 16) & 0xFF] << 24) | (AES_SBOX[(t >>> 8) & 0xFF] << 16)
        | (AES_SBOX[t & 0xFF] << 8) | AES_SBOX[(t >>> 24) & 0xFF];
      t ^= (AES_RCON[i / 8 - 1] << 24);
    } else if (i % 8 === 4) {
      t = (AES_SBOX[(t >>> 24) & 0xFF] << 24) | (AES_SBOX[(t >>> 16) & 0xFF] << 16)
        | (AES_SBOX[(t >>> 8) & 0xFF] << 8) | AES_SBOX[t & 0xFF];
    }
    w[i] = w[i - 8] ^ t;
  }
  // InvMixColumns on rounds 1-13 for equivalent inverse cipher
  for (let i = 4; i < 56; i++) {
    const v = w[i];
    w[i] = _td0[AES_SBOX[(v >>> 24) & 0xFF]] ^ _td1[AES_SBOX[(v >>> 16) & 0xFF]]
      ^ _td2[AES_SBOX[(v >>> 8) & 0xFF]] ^ _td3[AES_SBOX[v & 0xFF]];
  }
  return w;
}

/**
 * Decrypt a single 16-byte block using AES-256.
 * @param {Uint8Array} block - 16-byte ciphertext
 * @param {Uint32Array} rk - 60-word expanded key
 * @param {Uint8Array} out - 16-byte output
 */
function aes256DecryptBlock(block, rk, out) {
  let s0 = ((block[0] << 24) | (block[1] << 16) | (block[2] << 8) | block[3]) ^ rk[56];
  let s1 = ((block[4] << 24) | (block[5] << 16) | (block[6] << 8) | block[7]) ^ rk[57];
  let s2 = ((block[8] << 24) | (block[9] << 16) | (block[10] << 8) | block[11]) ^ rk[58];
  let s3 = ((block[12] << 24) | (block[13] << 16) | (block[14] << 8) | block[15]) ^ rk[59];
  for (let r = 13; r >= 1; r--) {
    const k = r * 4;
    const t0 = _td0[(s0 >>> 24)] ^ _td1[(s3 >>> 16) & 0xFF] ^ _td2[(s2 >>> 8) & 0xFF] ^ _td3[s1 & 0xFF] ^ rk[k];
    const t1 = _td0[(s1 >>> 24)] ^ _td1[(s0 >>> 16) & 0xFF] ^ _td2[(s3 >>> 8) & 0xFF] ^ _td3[s2 & 0xFF] ^ rk[k + 1];
    const t2 = _td0[(s2 >>> 24)] ^ _td1[(s1 >>> 16) & 0xFF] ^ _td2[(s0 >>> 8) & 0xFF] ^ _td3[s3 & 0xFF] ^ rk[k + 2];
    const t3 = _td0[(s3 >>> 24)] ^ _td1[(s2 >>> 16) & 0xFF] ^ _td2[(s1 >>> 8) & 0xFF] ^ _td3[s0 & 0xFF] ^ rk[k + 3];
    s0 = t0; s1 = t1; s2 = t2; s3 = t3;
  }
  out[0] = AES_INV_SBOX[(s0 >>> 24)] ^ (rk[0] >>> 24);
  out[1] = AES_INV_SBOX[(s3 >>> 16) & 0xFF] ^ ((rk[0] >>> 16) & 0xFF);
  out[2] = AES_INV_SBOX[(s2 >>> 8) & 0xFF] ^ ((rk[0] >>> 8) & 0xFF);
  out[3] = AES_INV_SBOX[s1 & 0xFF] ^ (rk[0] & 0xFF);
  out[4] = AES_INV_SBOX[(s1 >>> 24)] ^ (rk[1] >>> 24);
  out[5] = AES_INV_SBOX[(s0 >>> 16) & 0xFF] ^ ((rk[1] >>> 16) & 0xFF);
  out[6] = AES_INV_SBOX[(s3 >>> 8) & 0xFF] ^ ((rk[1] >>> 8) & 0xFF);
  out[7] = AES_INV_SBOX[s2 & 0xFF] ^ (rk[1] & 0xFF);
  out[8] = AES_INV_SBOX[(s2 >>> 24)] ^ (rk[2] >>> 24);
  out[9] = AES_INV_SBOX[(s1 >>> 16) & 0xFF] ^ ((rk[2] >>> 16) & 0xFF);
  out[10] = AES_INV_SBOX[(s0 >>> 8) & 0xFF] ^ ((rk[2] >>> 8) & 0xFF);
  out[11] = AES_INV_SBOX[s3 & 0xFF] ^ (rk[2] & 0xFF);
  out[12] = AES_INV_SBOX[(s3 >>> 24)] ^ (rk[3] >>> 24);
  out[13] = AES_INV_SBOX[(s2 >>> 16) & 0xFF] ^ ((rk[3] >>> 16) & 0xFF);
  out[14] = AES_INV_SBOX[(s1 >>> 8) & 0xFF] ^ ((rk[3] >>> 8) & 0xFF);
  out[15] = AES_INV_SBOX[s0 & 0xFF] ^ (rk[3] & 0xFF);
}

// Forward MixColumns T-tables for AES-CBC encryption (used by R=6 key derivation)
const _te0 = new Uint32Array(256);
const _te1 = new Uint32Array(256);
const _te2 = new Uint32Array(256);
const _te3 = new Uint32Array(256);
{
  const xtime = (a) => ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xFF;
  for (let i = 0; i < 256; i++) {
    const s = AES_SBOX[i];
    const s2 = xtime(s);
    const s3 = s2 ^ s;
    _te0[i] = (s2 << 24) | (s << 16) | (s << 8) | s3;
    _te1[i] = (s3 << 24) | (s2 << 16) | (s << 8) | s;
    _te2[i] = (s << 24) | (s3 << 16) | (s2 << 8) | s;
    _te3[i] = (s << 24) | (s << 16) | (s3 << 8) | s2;
  }
}

/**
 * Encrypt a single 16-byte block using AES-128 (forward cipher).
 * @param {Uint8Array} block - 16-byte plaintext
 * @param {Uint32Array} rk - 44-word forward expanded key (NOT inverse-transformed)
 * @param {Uint8Array} out - 16-byte output
 */
function aesEncryptBlock(block, rk, out) {
  let s0 = ((block[0] << 24) | (block[1] << 16) | (block[2] << 8) | block[3]) ^ rk[0];
  let s1 = ((block[4] << 24) | (block[5] << 16) | (block[6] << 8) | block[7]) ^ rk[1];
  let s2 = ((block[8] << 24) | (block[9] << 16) | (block[10] << 8) | block[11]) ^ rk[2];
  let s3 = ((block[12] << 24) | (block[13] << 16) | (block[14] << 8) | block[15]) ^ rk[3];
  for (let r = 1; r <= 9; r++) {
    const k = r * 4;
    const t0 = _te0[(s0 >>> 24)] ^ _te1[(s1 >>> 16) & 0xFF] ^ _te2[(s2 >>> 8) & 0xFF] ^ _te3[s3 & 0xFF] ^ rk[k];
    const t1 = _te0[(s1 >>> 24)] ^ _te1[(s2 >>> 16) & 0xFF] ^ _te2[(s3 >>> 8) & 0xFF] ^ _te3[s0 & 0xFF] ^ rk[k + 1];
    const t2 = _te0[(s2 >>> 24)] ^ _te1[(s3 >>> 16) & 0xFF] ^ _te2[(s0 >>> 8) & 0xFF] ^ _te3[s1 & 0xFF] ^ rk[k + 2];
    const t3 = _te0[(s3 >>> 24)] ^ _te1[(s0 >>> 16) & 0xFF] ^ _te2[(s1 >>> 8) & 0xFF] ^ _te3[s2 & 0xFF] ^ rk[k + 3];
    s0 = t0; s1 = t1; s2 = t2; s3 = t3;
  }
  // Final round: SubBytes + ShiftRows + AddRoundKey (no MixColumns)
  out[0] = AES_SBOX[(s0 >>> 24)] ^ (rk[40] >>> 24);
  out[1] = AES_SBOX[(s1 >>> 16) & 0xFF] ^ ((rk[40] >>> 16) & 0xFF);
  out[2] = AES_SBOX[(s2 >>> 8) & 0xFF] ^ ((rk[40] >>> 8) & 0xFF);
  out[3] = AES_SBOX[s3 & 0xFF] ^ (rk[40] & 0xFF);
  out[4] = AES_SBOX[(s1 >>> 24)] ^ (rk[41] >>> 24);
  out[5] = AES_SBOX[(s2 >>> 16) & 0xFF] ^ ((rk[41] >>> 16) & 0xFF);
  out[6] = AES_SBOX[(s3 >>> 8) & 0xFF] ^ ((rk[41] >>> 8) & 0xFF);
  out[7] = AES_SBOX[s0 & 0xFF] ^ (rk[41] & 0xFF);
  out[8] = AES_SBOX[(s2 >>> 24)] ^ (rk[42] >>> 24);
  out[9] = AES_SBOX[(s3 >>> 16) & 0xFF] ^ ((rk[42] >>> 16) & 0xFF);
  out[10] = AES_SBOX[(s0 >>> 8) & 0xFF] ^ ((rk[42] >>> 8) & 0xFF);
  out[11] = AES_SBOX[s1 & 0xFF] ^ (rk[42] & 0xFF);
  out[12] = AES_SBOX[(s3 >>> 24)] ^ (rk[43] >>> 24);
  out[13] = AES_SBOX[(s0 >>> 16) & 0xFF] ^ ((rk[43] >>> 16) & 0xFF);
  out[14] = AES_SBOX[(s1 >>> 8) & 0xFF] ^ ((rk[43] >>> 8) & 0xFF);
  out[15] = AES_SBOX[s2 & 0xFF] ^ (rk[43] & 0xFF);
}

/**
 * Expand AES-128 key for ENCRYPTION (forward schedule, no InvMixColumns transform).
 * @param {Uint8Array} key - 16-byte key
 */
function aesExpandKeyForward(key) {
  const w = new Uint32Array(44);
  for (let i = 0; i < 4; i++) {
    w[i] = (key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3];
  }
  for (let i = 4; i < 44; i++) {
    let t = w[i - 1];
    if (i % 4 === 0) {
      t = (AES_SBOX[(t >>> 16) & 0xFF] << 24) | (AES_SBOX[(t >>> 8) & 0xFF] << 16)
        | (AES_SBOX[t & 0xFF] << 8) | AES_SBOX[(t >>> 24) & 0xFF];
      t ^= (AES_RCON[i / 4 - 1] << 24);
    }
    w[i] = w[i - 4] ^ t;
  }
  return w;
}

/**
 * AES-128-CBC encrypt (no padding). Used by R=6 key derivation (Algorithm 2.B).
 * @param {Uint8Array} key - 16-byte key
 * @param {Uint8Array} iv - 16-byte IV
 * @param {Uint8Array} data - plaintext (must be multiple of 16)
 */
function aesCBCEncrypt(key, iv, data) {
  const rk = aesExpandKeyForward(key);
  const nBlocks = data.length / 16;
  const out = new Uint8Array(data.length);
  const blk = new Uint8Array(16);
  const enc = new Uint8Array(16);
  // First block: XOR plaintext with IV
  for (let j = 0; j < 16; j++) blk[j] = data[j] ^ iv[j];
  aesEncryptBlock(blk, rk, enc);
  out.set(enc, 0);
  for (let i = 1; i < nBlocks; i++) {
    const off = i * 16;
    for (let j = 0; j < 16; j++) blk[j] = data[off + j] ^ enc[j];
    aesEncryptBlock(blk, rk, enc);
    out.set(enc, off);
  }
  return out;
}

/**
 * Decrypt data using AES-CBC (128 or 256-bit key). First 16 bytes are IV.
 * @param {Uint8Array} key - 16 or 32-byte AES key
 * @param {Uint8Array} data - IV (16 bytes) + ciphertext
 * @param {boolean} [removePadding=true] - whether to strip PKCS#7 padding
 */
export function aesDecrypt(key, data, removePadding = true) {
  if (data.length < 32 || data.length % 16 !== 0) return data;
  const is256 = key.length === 32;
  const rk = is256 ? aes256ExpandKey(key) : aesExpandKey(key);
  const decryptBlock = is256 ? aes256DecryptBlock : aesDecryptBlock;
  const nBlocks = (data.length - 16) / 16;
  const plain = new Uint8Array(nBlocks * 16);
  const block = new Uint8Array(16);

  for (let i = 0; i < nBlocks; i++) {
    const cipherOff = 16 + i * 16;
    decryptBlock(data.subarray(cipherOff, cipherOff + 16), rk, block);
    const prevOff = i * 16;
    for (let j = 0; j < 16; j++) plain[i * 16 + j] = block[j] ^ data[prevOff + j];
  }

  if (removePadding) {
    const padLen = plain[plain.length - 1];
    if (padLen > 0 && padLen <= 16) return plain.subarray(0, plain.length - padLen);
  }
  return plain;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * SHA-256 hash.
 * @param {Uint8Array} msg
 */
function sha256(msg) {
  // Pre-processing: pad message to 64-byte blocks
  const bitLen = msg.length * 8;
  const padLen = (55 - msg.length % 64 + 64) % 64 + 9;
  const padded = new Uint8Array(msg.length + padLen);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 4, bitLen, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
      const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, h0); odv.setUint32(4, h1); odv.setUint32(8, h2); odv.setUint32(12, h3);
  odv.setUint32(16, h4); odv.setUint32(20, h5); odv.setUint32(24, h6); odv.setUint32(28, h7);
  return out;
}

// SHA-512/SHA-384 uses 64-bit arithmetic. We represent each 64-bit word as [hi, lo] in a flat Int32Array.
const SHA512_K_FLAT = new Int32Array([
  0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc,
  0x3956c25b, 0xf348b538, 0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118,
  0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe, 0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2,
  0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235, 0xc19bf174, 0xcf692694,
  0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65,
  0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5,
  0x983e5152, 0xee66dfab, 0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4,
  0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725, 0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70,
  0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed, 0x53380d13, 0x9d95b3df,
  0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b,
  0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001, 0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30,
  0xd192e819, 0xd6ef5218, 0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8,
  0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53, 0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8,
  0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373, 0x682e6ff3, 0xd6b2b8a3,
  0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec,
  0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b,
  0xca273ece, 0xea26619c, 0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178,
  0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6, 0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b,
  0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc, 0x431d67c4, 0x9c100d4c,
  0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817,
]);

/**
 * SHA-512 core (also used for SHA-384 with different IVs).
 * @param {Uint8Array} msg
 * @param {Int32Array} iv - 16-element array [h0_hi,h0_lo,h1_hi,h1_lo,...,h7_hi,h7_lo]
 * @param {number} outLen - output bytes (64 for SHA-512, 48 for SHA-384)
 */
function sha512Core(msg, iv, outLen) {
  // 64-bit add: [hi,lo] += [bh,bl]
  const add64 = (arr, i, bh, bl) => {
    const lo = (arr[i + 1] + bl) | 0;
    arr[i] = (arr[i] + bh + ((lo >>> 0) < (arr[i + 1] >>> 0) ? 1 : 0)) | 0;
    arr[i + 1] = lo;
  };
  // Pad to 128-byte blocks
  const bitLenHi = 0;
  const bitLenLo = msg.length * 8;
  const padLen = (111 - msg.length % 128 + 128) % 128 + 17;
  const padded = new Uint8Array(msg.length + padLen);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLenHi, false);
  dv.setUint32(padded.length - 4, bitLenLo, false);

  const H = new Int32Array(iv);
  const W = new Int32Array(160); // 80 words × 2 (hi,lo)

  for (let off = 0; off < padded.length; off += 128) {
    for (let i = 0; i < 32; i++) W[i] = dv.getInt32(off + i * 4, false);
    for (let i = 16; i < 80; i++) {
      const i2 = i * 2;
      // sigma1(W[i-2])
      let wh = W[(i - 2) * 2]; let wl = W[(i - 2) * 2 + 1];
      const s1h = ((wh >>> 19) | (wl << 13)) ^ ((wl >>> 29) | (wh << 3)) ^ (wh >>> 6);
      const s1l = ((wl >>> 19) | (wh << 13)) ^ ((wh >>> 29) | (wl << 3)) ^ ((wl >>> 6) | (wh << 26));
      // sigma0(W[i-15])
      wh = W[(i - 15) * 2]; wl = W[(i - 15) * 2 + 1];
      const s0h = ((wh >>> 1) | (wl << 31)) ^ ((wh >>> 8) | (wl << 24)) ^ (wh >>> 7);
      const s0l = ((wl >>> 1) | (wh << 31)) ^ ((wl >>> 8) | (wh << 24)) ^ ((wl >>> 7) | (wh << 25));
      // W[i] = W[i-16] + s0 + W[i-7] + s1
      let lo = (W[(i - 16) * 2 + 1] + s0l) | 0;
      let hi = (W[(i - 16) * 2] + s0h + ((lo >>> 0) < (W[(i - 16) * 2 + 1] >>> 0) ? 1 : 0)) | 0;
      const lo2 = (lo + W[(i - 7) * 2 + 1]) | 0;
      hi = (hi + W[(i - 7) * 2] + ((lo2 >>> 0) < (lo >>> 0) ? 1 : 0)) | 0; lo = lo2;
      const lo3 = (lo + s1l) | 0;
      hi = (hi + s1h + ((lo3 >>> 0) < (lo >>> 0) ? 1 : 0)) | 0;
      W[i2] = hi; W[i2 + 1] = lo3;
    }
    // Working variables: [ah,al,bh,bl,...,hh,hl]
    const v = new Int32Array(H);
    for (let i = 0; i < 80; i++) {
      const eh = v[8]; const el = v[9]; const fh = v[10]; const fl = v[11]; const gh = v[12]; const gl = v[13];
      // Sigma1(e)
      const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
      const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
      // Ch(e,f,g)
      const chh = (eh & fh) ^ (~eh & gh);
      const chl = (el & fl) ^ (~el & gl);
      // T1 = h + S1 + Ch + K + W
      let t1l = (v[15] + S1l) | 0;
      let t1h = (v[14] + S1h + ((t1l >>> 0) < (v[15] >>> 0) ? 1 : 0)) | 0;
      let tmp = (t1l + chl) | 0; t1h = (t1h + chh + ((tmp >>> 0) < (t1l >>> 0) ? 1 : 0)) | 0; t1l = tmp;
      tmp = (t1l + SHA512_K_FLAT[i * 2 + 1]) | 0; t1h = (t1h + SHA512_K_FLAT[i * 2] + ((tmp >>> 0) < (t1l >>> 0) ? 1 : 0)) | 0; t1l = tmp;
      tmp = (t1l + W[i * 2 + 1]) | 0; t1h = (t1h + W[i * 2] + ((tmp >>> 0) < (t1l >>> 0) ? 1 : 0)) | 0; t1l = tmp;
      // Sigma0(a)
      const ah = v[0]; const al = v[1];
      const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
      const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
      // Maj(a,b,c)
      const majh = (ah & v[2]) ^ (ah & v[4]) ^ (v[2] & v[4]);
      const majl = (al & v[3]) ^ (al & v[5]) ^ (v[3] & v[5]);
      // T2 = S0 + Maj
      const t2l = (S0l + majl) | 0;
      const t2h = (S0h + majh + ((t2l >>> 0) < (S0l >>> 0) ? 1 : 0)) | 0;
      // Shift working variables
      v[14] = v[12]; v[15] = v[13]; v[12] = v[10]; v[13] = v[11];
      v[10] = v[8]; v[11] = v[9];
      v[9] = (v[7] + t1l) | 0; v[8] = (v[6] + t1h + ((v[9] >>> 0) < (v[7] >>> 0) ? 1 : 0)) | 0;
      v[6] = v[4]; v[7] = v[5]; v[4] = v[2]; v[5] = v[3]; v[2] = v[0]; v[3] = v[1];
      v[1] = (t1l + t2l) | 0; v[0] = (t1h + t2h + ((v[1] >>> 0) < (t1l >>> 0) ? 1 : 0)) | 0;
    }
    for (let i = 0; i < 16; i += 2) add64(H, i, v[i], v[i + 1]);
  }
  const out = new Uint8Array(outLen);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < outLen / 4; i++) odv.setInt32(i * 4, H[i], false);
  return out;
}

const SHA512_IV = new Int32Array([
  0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1,
  0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179,
]);

const SHA384_IV = new Int32Array([
  0xcbbb9d5d, 0xc1059ed8, 0x629a292a, 0x367cd507, 0x9159015a, 0x3070dd17, 0x152fecd8, 0xf70e5939,
  0x67332667, 0xffc00b31, 0x8eb44a87, 0x68581511, 0xdb0c2e0d, 0x64f98fa7, 0x47b5481d, 0xbefa4fa4,
]);

/** @param {Uint8Array} msg @returns {Uint8Array} 64-byte hash */
function sha512(msg) { return sha512Core(msg, SHA512_IV, 64); }
/** @param {Uint8Array} msg @returns {Uint8Array} 48-byte hash */
function sha384(msg) { return sha512Core(msg, SHA384_IV, 48); }

/**
 * Algorithm 2.B: Computing a hash for R=6.
 * Iterative SHA-256/384/512 + AES-128-CBC loop.
 * @param {Uint8Array} password - user password bytes (max 127)
 * @param {Uint8Array} salt - 8-byte salt
 * @param {Uint8Array} userKey - 48-byte /U or /O value
 * @returns {Uint8Array} 32-byte hash
 */
function computeHashR6(password, salt, userKey) {
  let K = sha256(concatBytes(password, salt, userKey));
  for (let round = 0; ; round++) {
    // K1 = password + K + userKey, repeated 64 times
    const oneRound = concatBytes(password, K, userKey);
    const K1 = new Uint8Array(oneRound.length * 64);
    for (let i = 0; i < 64; i++) K1.set(oneRound, i * oneRound.length);
    // AES-128-CBC encrypt K1 with key=K[0:16], iv=K[16:32]
    const E = aesCBCEncrypt(K.subarray(0, 16), K.subarray(16, 32), K1);
    // Select hash: first 16 bytes of E as big-endian integer mod 3.
    // Since 256 ≡ 1 (mod 3), this equals (sum of first 16 bytes) mod 3.
    let byteSum = 0;
    for (let j = 0; j < 16; j++) byteSum += E[j];
    const rem = byteSum % 3;
    K = rem === 0 ? sha256(E) : rem === 1 ? sha384(E) : sha512(E);
    // Rounds 0-63 always execute; exit check starts at round 64
    if (round >= 64 && E[E.length - 1] <= round - 32) break;
  }
  return K.subarray(0, 32);
}

function concatBytes(a, b, c) {
  const len = a.length + b.length + (c ? c.length : 0);
  const out = new Uint8Array(len);
  out.set(a, 0);
  out.set(b, a.length);
  if (c) out.set(c, a.length + b.length);
  return out;
}

/**
 * Derive the file encryption key for V=5/R=6.
 * @param {Uint8Array} U - 48-byte /U value
 * @param {Uint8Array} UE - 32-byte /UE value (encrypted file key)
 * @param {Uint8Array} O - 48-byte /O value
 * @param {Uint8Array} OE - 32-byte /OE value (encrypted file key, owner)
 */
function deriveFileKeyR6(U, UE, O, OE) {
  const password = new Uint8Array(0); // empty password
  const emptyKey = new Uint8Array(0);

  // Try user password first (userKey = empty for user)
  const userValSalt = U.subarray(32, 40);
  const userHash = computeHashR6(password, userValSalt, emptyKey);
  let matched = true;
  for (let i = 0; i < 32; i++) { if (userHash[i] !== U[i]) { matched = false; break; } }
  if (matched) {
    const userKeySalt = U.subarray(40, 48);
    const intermediateKey = computeHashR6(password, userKeySalt, emptyKey);
    const ivPlusUE = new Uint8Array(16 + UE.length);
    ivPlusUE.set(UE, 16);
    return aesDecrypt(intermediateKey, ivPlusUE, false);
  }

  // Try owner password (userKey = U[0:48] for owner)
  if (O && OE) {
    const ownerValSalt = O.subarray(32, 40);
    const ownerHash = computeHashR6(password, ownerValSalt, U.subarray(0, 48));
    matched = true;
    for (let i = 0; i < 32; i++) { if (ownerHash[i] !== O[i]) { matched = false; break; } }
    if (matched) {
      const ownerKeySalt = O.subarray(40, 48);
      const intermediateKey = computeHashR6(password, ownerKeySalt, U.subarray(0, 48));
      const ivPlusOE = new Uint8Array(16 + OE.length);
      ivPlusOE.set(OE, 16);
      return aesDecrypt(intermediateKey, ivPlusOE, false);
    }
  }

  return null;
}

/** Standard 32-byte padding used for PDF password hashing. */
const PDF_PASSWORD_PADDING = new Uint8Array([
  0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
  0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
]);

/**
 * Compute the base encryption key for a PDF (Algorithm 3.2 from PDF spec).
 * @param {Uint8Array} password - User password bytes (empty for no password)
 * @param {Uint8Array} O - 32-byte owner password hash from /Encrypt dict
 * @param {number} P - Permissions integer from /Encrypt dict
 * @param {Uint8Array} ID - First element of the document /ID array
 * @param {number} keyLength - Key length in bytes (5 for V=1, variable for V=2, 16 for V=4)
 * @param {number} R - Revision number (2, 3, or 4)
 * @param {boolean} [encryptMetadata=true] - /EncryptMetadata flag (R≥4 only)
 */
function computeEncryptionKey(password, O, P, ID, keyLength, R, encryptMetadata = true) {
  const padded = new Uint8Array(32);
  padded.set(password.subarray(0, 32));
  if (password.length < 32) {
    padded.set(PDF_PASSWORD_PADDING.subarray(0, 32 - password.length), password.length);
  }

  const pBytes = new Uint8Array(4);
  new DataView(pBytes.buffer).setInt32(0, P, true);

  const extraLen = (R >= 4 && !encryptMetadata) ? 4 : 0;
  const input = new Uint8Array(padded.length + O.length + 4 + ID.length + extraLen);
  let off = 0;
  input.set(padded, off); off += padded.length;
  input.set(O, off); off += O.length;
  input.set(pBytes, off); off += 4;
  input.set(ID, off); off += ID.length;
  if (R >= 4 && !encryptMetadata) {
    input[off] = 0xFF; input[off + 1] = 0xFF; input[off + 2] = 0xFF; input[off + 3] = 0xFF;
  }

  let hash = md5(input);

  if (R >= 3) {
    for (let i = 0; i < 50; i++) {
      hash = md5(hash.subarray(0, keyLength));
    }
  }

  return hash.subarray(0, keyLength);
}

/**
 * Compute per-object encryption key (Algorithm 3.1 from PDF spec).
 * @param {Uint8Array} baseKey - Base encryption key
 * @param {number} objNum - Object number
 * @param {number} genNum - Generation number
 * @param {boolean} [useAES=false] - If true, append "sAlT" (0x73 0x41 0x6C 0x54) for AES
 * @returns {Uint8Array} Per-object key (max 16 bytes)
 */
export function computeObjectKey(baseKey, objNum, genNum, useAES = false) {
  const saltLen = useAES ? 4 : 0;
  const input = new Uint8Array(baseKey.length + 5 + saltLen);
  input.set(baseKey);
  input[baseKey.length] = objNum & 0xFF;
  input[baseKey.length + 1] = (objNum >> 8) & 0xFF;
  input[baseKey.length + 2] = (objNum >> 16) & 0xFF;
  input[baseKey.length + 3] = genNum & 0xFF;
  input[baseKey.length + 4] = (genNum >> 8) & 0xFF;
  if (useAES) {
    input[baseKey.length + 5] = 0x73; // 's'
    input[baseKey.length + 6] = 0x41; // 'A'
    input[baseKey.length + 7] = 0x6C; // 'l'
    input[baseKey.length + 8] = 0x54; // 'T'
  }
  const hash = md5(input);
  return hash.subarray(0, Math.min(baseKey.length + 5, 16));
}

/**
 * Parse a PDF literal string from raw bytes, handling escape sequences.
 * @param {Uint8Array} bytes - PDF file bytes
 * @param {number} start - Offset of the opening '(' character
 * @returns {{ value: Uint8Array, end: number }} Decoded bytes and offset past closing ')'
 */
export function parsePdfLiteralString(bytes, start) {
  const result = [];
  let depth = 1;
  let i = start + 1; // skip opening '('
  while (i < bytes.length && depth > 0) {
    const b = bytes[i];
    if (b === 0x5C) { // backslash
      i++;
      const next = bytes[i];
      const escapes = {
        0x6E: 0x0A, 0x72: 0x0D, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0C, 0x28: 0x28, 0x29: 0x29, 0x5C: 0x5C,
      };
      if (escapes[next] !== undefined) {
        result.push(escapes[next]);
        i++;
      } else if (next >= 0x30 && next <= 0x37) { // octal \ddd
        let octal = next - 0x30;
        if (i + 1 < bytes.length && bytes[i + 1] >= 0x30 && bytes[i + 1] <= 0x37) {
          octal = octal * 8 + (bytes[++i] - 0x30);
          if (i + 1 < bytes.length && bytes[i + 1] >= 0x30 && bytes[i + 1] <= 0x37) {
            octal = octal * 8 + (bytes[++i] - 0x30);
          }
        }
        result.push(octal & 0xFF);
        i++;
      } else if (next === 0x0D || next === 0x0A) { // line continuation
        i++;
        if (next === 0x0D && i < bytes.length && bytes[i] === 0x0A) i++;
      } else {
        result.push(next);
        i++;
      }
    } else if (b === 0x28) { // (
      depth++;
      result.push(b);
      i++;
    } else if (b === 0x29) { // )
      depth--;
      if (depth > 0) result.push(b);
      i++;
    } else {
      result.push(b);
      i++;
    }
  }
  return { value: new Uint8Array(result), end: i };
}

/**
 * Parse a PDF hex string from raw bytes.
 * @param {Uint8Array} bytes - PDF file bytes
 * @param {number} start - Offset of the opening '<' character
 */
export function parsePdfHexString(bytes, start) {
  let hex = '';
  let i = start + 1; // skip opening '<'
  while (i < bytes.length && bytes[i] !== 0x3E) { // '>'
    const ch = bytes[i];
    if ((ch >= 0x30 && ch <= 0x39) || (ch >= 0x41 && ch <= 0x46) || (ch >= 0x61 && ch <= 0x66)) {
      hex += String.fromCharCode(ch);
    }
    i++;
  }
  if (hex.length % 2 !== 0) hex += '0'; // pad odd-length hex strings
  const result = new Uint8Array(hex.length / 2);
  for (let j = 0; j < result.length; j++) {
    result[j] = parseInt(hex.substring(j * 2, j * 2 + 2), 16);
  }
  return { value: result, end: i + 1 };
}

/**
 * Scan PDF bytes for "/Encrypt N M R" and return the encrypted-dict object
 * number, or null if no encryption marker is present. Walks all candidate
 * matches because the literal "/Encrypt" can appear in non-trailer contexts
 * (stream data, comments). Stops at the first one whose suffix parses as a
 * valid indirect reference.
 * @param {Uint8Array} bytes
 */
function findEncryptRef(bytes) {
  const marker = '/Encrypt';
  const len = bytes.length;
  let from = 0;
  while (true) {
    const idx = byteIndexOf(bytes, marker, from);
    if (idx === -1) return null;
    let p = idx + marker.length;
    // Reject longer key names like /Encryptable
    if (p < len) {
      const c = bytes[p];
      if ((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || isAsciiDigit(c) || c === 0x5F) {
        from = p;
        continue;
      }
    }
    while (p < len && isPdfWhitespace(bytes[p])) p++;
    if (p >= len || !isAsciiDigit(bytes[p])) { from = p; continue; }
    let objNum = 0;
    while (p < len && isAsciiDigit(bytes[p])) { objNum = objNum * 10 + (bytes[p] - 0x30); p++; }
    while (p < len && isPdfWhitespace(bytes[p])) p++;
    if (p >= len || !isAsciiDigit(bytes[p])) { from = p; continue; }
    while (p < len && isAsciiDigit(bytes[p])) p++;
    while (p < len && isPdfWhitespace(bytes[p])) p++;
    if (p >= len || bytes[p] !== 0x52) { from = p; continue; } // 'R'
    return objNum;
  }
}

/**
 * Scan PDF bytes for "/ID [" and return the byte offset just past the '['.
 * Returns -1 if no /ID array is present.
 * @param {Uint8Array} bytes
 */
function findIdArrayOpen(bytes) {
  const len = bytes.length;
  let from = 0;
  while (true) {
    const idx = byteIndexOf(bytes, '/ID', from);
    if (idx === -1) return -1;
    let p = idx + 3;
    // Reject longer keys (/IDTree, etc.)
    if (p < len) {
      const c = bytes[p];
      if ((c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || isAsciiDigit(c) || c === 0x5F) {
        from = p;
        continue;
      }
    }
    while (p < len && isPdfWhitespace(bytes[p])) p++;
    if (p < len && bytes[p] === 0x5B) return p + 1; // '['
    from = p;
  }
}

/**
 * Detect and set up PDF document encryption. Called during ObjectCache construction.
 * Supports V=1/R=2 (RC4 40-bit), V=2/R=3 (RC4 variable-length), V=4/R=4 (AES-128 or RC4).
 * Assumes empty user password (most common for permissions-only encrypted PDFs).
 * @param {import('./parsePdfUtils.js').ObjectCache} objCache
 */
export function setupEncryption(objCache) {
  const { pdfBytes, xrefEntries } = objCache;

  // Find /Encrypt reference (always lives in a trailer dict near the file end).
  // Scan raw bytes for the marker rather than materializing the whole file as
  // a string. /Encrypt may appear in non-trailer contexts (e.g. inside a stream
  // payload), so we accept any occurrence whose suffix parses as "N N R".
  const encryptMatch = findEncryptRef(pdfBytes);
  if (!encryptMatch) return;
  const encObjNum = encryptMatch;

  // Read the /Encrypt dict object from raw bytes (it is never encrypted itself)
  const encEntry = xrefEntries[encObjNum];
  if (!encEntry || encEntry.type !== 1) return;
  const encOffset = encEntry.offset;

  // Find the dict boundaries in raw bytes
  const encRegion = pdfBytes.subarray(encOffset, Math.min(encOffset + 2000, pdfBytes.length));
  const encText = String.fromCharCode.apply(null, encRegion); // true latin1, no Windows-1252 remapping

  const vMatch = /\/V\s+(\d+)/.exec(encText);
  const rMatch = /\/R\s+(\d+)/.exec(encText);
  const pMatch = /\/P\s+(-?\d+)/.exec(encText);
  if (!vMatch || !rMatch || !pMatch) return;

  const V = Number(vMatch[1]);
  const R = Number(rMatch[1]);
  const P = Number(pMatch[1]);

  if (V !== 1 && V !== 2 && V !== 4 && V !== 5) {
    console.warn(`[parsePdfUtils] Unsupported encryption version V=${V}, R=${R}`);
    return;
  }

  // V=5/R=6: AES-256 with SHA-based key derivation (PDF 2.0)
  if (V === 5) {
    // Parse /U, /UE, /O, /OE from raw bytes
    const U = parsePdfStringAt(pdfBytes, encOffset, encText, '/U');
    const UE = parsePdfStringAt(pdfBytes, encOffset, encText, '/UE');
    const O = parsePdfStringAt(pdfBytes, encOffset, encText, '/O');
    const OE = parsePdfStringAt(pdfBytes, encOffset, encText, '/OE');
    if (!U || !UE || U.length < 48 || UE.length < 32) {
      console.warn('[parsePdfUtils] V=5 encryption: missing or invalid /U or /UE');
      return;
    }
    const fileKey = deriveFileKeyR6(U, UE.subarray(0, 32),
      O && O.length >= 48 ? O : null, OE && OE.length >= 32 ? OE.subarray(0, 32) : null);
    if (!fileKey) {
      console.warn('[parsePdfUtils] V=5 encryption: password validation failed (non-empty password?)');
      return;
    }
    objCache.encryptionKey = fileKey;
    objCache.encryptObjNum = encObjNum;
    objCache.cipherMode = 'AESV3';
    return;
  }

  // Key length: V=1 always 40 bits (5 bytes); V=2 specified by /Length; V=4 always 128 bits (16 bytes)
  let keyLength = 5;
  if (V === 4) {
    keyLength = 16;
  } else if (V === 2) {
    const klMatch = /\/Length\s+(\d+)/.exec(encText);
    keyLength = klMatch ? Number(klMatch[1]) / 8 : 5;
  }

  // V=4: determine cipher mode from crypt filters (CF/StmF)
  // Default to RC4 for V=1/V=2
  let cipherMode = 'RC4';
  if (V === 4) {
    // /StmF names the crypt filter for streams (default: Identity = no encryption)
    const stmfMatch = /\/StmF\s*\/(\w+)/.exec(encText);
    const stmfName = stmfMatch ? stmfMatch[1] : 'Identity';
    if (stmfName === 'Identity') return; // Streams are not encrypted
    // Look up CFM in the named crypt filter dict: /CF<</StdCF<</CFM/AESV2 ...>>>>
    const cfmMatch = new RegExp(`/${stmfName}\\s*<<[^>]*?/CFM\\s*/(\\w+)`).exec(encText);
    cipherMode = (cfmMatch && cfmMatch[1] === 'AESV2') ? 'AESV2' : 'RC4';
  }

  // Parse /EncryptMetadata (V=4 only, default true)
  const encMetaMatch = /\/EncryptMetadata\s+(true|false)/.exec(encText);
  const encryptMetadata = encMetaMatch ? encMetaMatch[1] !== 'false' : true;

  // Parse /O (owner password hash) from raw bytes
  const O = parsePdfStringAt(pdfBytes, encOffset, encText, '/O');
  if (!O) return;

  // Find document /ID in trailer (not needed for V=5, but required for V=1-4).
  // /ID may be a hex string <...> OR a literal string (...). Parse from raw bytes
  // because literal /ID values can contain bytes 0x80-0x9F that would be mangled
  // by TextDecoder('latin1') (which is actually Windows-1252).
  // Match /ID followed by '[' to target the trailer's ID array specifically.
  // Page dicts can have /ID as an indirect reference (e.g. /ID 5 0 R for StructParent);
  // those lack the '[' and must not be matched.
  const idArrayIdx = findIdArrayOpen(pdfBytes);
  if (idArrayIdx === -1) return;
  let idPos = idArrayIdx;
  while (idPos < pdfBytes.length && (pdfBytes[idPos] === 0x20 || pdfBytes[idPos] === 0x0A || pdfBytes[idPos] === 0x0D || pdfBytes[idPos] === 0x09)) idPos++;
  let docID;
  if (pdfBytes[idPos] === 0x28) {
    docID = parsePdfLiteralString(pdfBytes, idPos).value;
  } else if (pdfBytes[idPos] === 0x3C) {
    docID = parsePdfHexString(pdfBytes, idPos).value;
  } else {
    return;
  }

  // Compute encryption key assuming empty user password
  const encKey = computeEncryptionKey(new Uint8Array(0), O, P, docID, keyLength, R, encryptMetadata);

  // Store encryption state in objCache
  objCache.encryptionKey = encKey;
  objCache.encryptObjNum = encObjNum;
  objCache.cipherMode = cipherMode;
}

/**
 * Parse a PDF string value for a given key from the encrypt dict raw bytes.
 * @param {Uint8Array} pdfBytes
 * @param {number} encOffset - byte offset of the encrypt object
 * @param {string} encText - latin1 text of the encrypt region
 * @param {string} key - e.g. '/O', '/U', '/UE', '/OE', '/Perms'
 * @returns {Uint8Array|null}
 */
function parsePdfStringAt(pdfBytes, encOffset, encText, key) {
  // Find the key, ensuring we don't match a longer key (e.g. /U shouldn't match /UE)
  const keyLen = key.length;
  let searchFrom = 0;
  let foundIdx = -1;
  while (true) {
    const idx = encText.indexOf(key, searchFrom);
    if (idx === -1) break;
    // Check the char after the key isn't alphanumeric (would mean it's a different key)
    const nextChar = encText.charCodeAt(idx + keyLen);
    if (nextChar >= 0x41 && nextChar <= 0x5A) { // A-Z — part of a longer key name
      searchFrom = idx + 1;
      continue;
    }
    foundIdx = idx;
    break;
  }
  if (foundIdx === -1) return null;

  // Find the string value start (skip key + whitespace)
  let pos = encOffset + foundIdx + keyLen;
  while (pos < pdfBytes.length && (pdfBytes[pos] === 0x20 || pdfBytes[pos] === 0x0A || pdfBytes[pos] === 0x0D || pdfBytes[pos] === 0x09)) pos++;
  if (pdfBytes[pos] === 0x28) return parsePdfLiteralString(pdfBytes, pos).value;
  if (pdfBytes[pos] === 0x3C) return parsePdfHexString(pdfBytes, pos).value;
  return null;
}
