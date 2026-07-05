/**
 * Decode LZW-compressed data (PDF LZWDecode filter).
 *
 * The dictionary is four flat parallel arrays (prefix code, appended byte, sequence length, first byte).
 * A sequence is emitted by walking its prefix chain backwards straight into the output buffer, so decoding allocates nothing per code.
 * @param {Uint8Array} data - LZW-compressed bytes
 * @param {string} dpText - DecodeParms dictionary text
 * @returns {Uint8Array} Decoded bytes
 */
export function decodeLZW(data, dpText) {
  const earlyChangeMatch = /\/EarlyChange\s+(\d+)/.exec(dpText);
  const earlyChange = earlyChangeMatch ? Number(earlyChangeMatch[1]) : 1;

  const CLEAR_TABLE = 256;
  const EOD = 257;
  const dataLen = data.length;
  const dataBits = dataLen * 8;

  let bitPos = 0;
  let bitBuffer = 0;
  let bitCount = 0;
  let bytePos = 0;

  let codeSize = 9;
  let nextCode = 258;
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const length = new Uint16Array(4096);
  const first = new Uint8Array(4096);
  for (let i = 0; i < 256; i++) {
    prefix[i] = -1;
    suffix[i] = i;
    length[i] = 1;
    first[i] = i;
  }

  let output = new Uint8Array(1 << 16);
  let outLen = 0;

  let prevCode = -1;

  while (bitPos < dataBits) {
    while (bitCount < codeSize) {
      bitBuffer = (bitBuffer << 8) | (bytePos < dataLen ? data[bytePos] : 0);
      bytePos++;
      bitCount += 8;
    }
    bitCount -= codeSize;
    bitPos += codeSize;
    const code = (bitBuffer >>> bitCount) & ((1 << codeSize) - 1);
    bitBuffer &= (1 << bitCount) - 1;

    if (code === EOD) break;

    if (code === CLEAR_TABLE) {
      // Entries above 257 become stale but unreachable: codes are only valid below nextCode.
      codeSize = 9;
      nextCode = 258;
      prevCode = -1;
      continue;
    }

    let emitted; // dictionary index of the sequence just emitted
    let emittedFirst;
    if (code < nextCode) {
      emitted = code;
      const L = length[code];
      if (outLen + L > output.length) {
        let newCap = output.length;
        while (newCap < outLen + L) newCap *= 2;
        const grown = new Uint8Array(newCap);
        grown.set(output.subarray(0, outLen));
        output = grown;
      }
      let pos = outLen + L - 1;
      let c = code;
      while (prefix[c] >= 0) {
        output[pos--] = suffix[c];
        c = prefix[c];
      }
      output[pos] = suffix[c];
      emittedFirst = suffix[c];
      outLen += L;
    } else if (code === nextCode && prevCode >= 0) {
      // KwKwK: the code being defined right now is the previous sequence plus its own first byte.
      const L = length[prevCode] + 1;
      if (outLen + L > output.length) {
        let newCap = output.length;
        while (newCap < outLen + L) newCap *= 2;
        const grown = new Uint8Array(newCap);
        grown.set(output.subarray(0, outLen));
        output = grown;
      }
      let pos = outLen + L - 2;
      let c = prevCode;
      while (prefix[c] >= 0) {
        output[pos--] = suffix[c];
        c = prefix[c];
      }
      output[pos] = suffix[c];
      emittedFirst = suffix[c];
      output[outLen + L - 1] = emittedFirst;
      outLen += L;
      emitted = -1; // becomes the entry added below
    } else {
      break; // Invalid code
    }

    if (prevCode >= 0 && nextCode < 4096) {
      prefix[nextCode] = prevCode;
      suffix[nextCode] = emittedFirst;
      length[nextCode] = length[prevCode] + 1;
      first[nextCode] = first[prevCode];
      if (emitted < 0) emitted = nextCode;
      nextCode++;
      if (nextCode + earlyChange >= (2 ** codeSize) && codeSize < 12) {
        codeSize++;
      }
    }

    prevCode = emitted;
  }

  return output.slice(0, outLen);
}
