/**
 * Decode LZW-compressed data (PDF LZWDecode filter).
 * @param {Uint8Array} data - LZW-compressed bytes
 * @param {string} dpText - DecodeParms dictionary text
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
  function readBits(n) {
    while (bitCount < n) {
      bitBuffer = (bitBuffer << 8) | (bytePos < dataLen ? data[bytePos] : 0);
      bytePos++;
      bitCount += 8;
    }
    bitCount -= n;
    bitPos += n;
    const val = (bitBuffer >>> bitCount) & ((1 << n) - 1);
    bitBuffer &= (1 << bitCount) - 1;
    return val;
  }

  let codeSize = 9;
  let nextCode = 258;
  /** @type {Uint8Array[]} */
  const dictionary = new Array(4096);
  for (let i = 0; i < 256; i++) dictionary[i] = Uint8Array.of(i);

  let output = new Uint8Array(1 << 16);
  let outLen = 0;
  function emit(entry) {
    if (outLen + entry.length > output.length) {
      let newCap = output.length;
      while (newCap < outLen + entry.length) newCap *= 2;
      const grown = new Uint8Array(newCap);
      grown.set(output.subarray(0, outLen));
      output = grown;
    }
    output.set(entry, outLen);
    outLen += entry.length;
  }

  let prevEntry = null;

  while (bitPos < dataBits) {
    const code = readBits(codeSize);

    if (code === EOD) break;

    if (code === CLEAR_TABLE) {
      codeSize = 9;
      nextCode = 258;
      prevEntry = null;
      continue;
    }

    let entry;
    if (code < nextCode) {
      entry = dictionary[code];
    } else if (code === nextCode && prevEntry) {
      entry = new Uint8Array(prevEntry.length + 1);
      entry.set(prevEntry);
      entry[prevEntry.length] = prevEntry[0];
    } else {
      break; // Invalid code
    }

    emit(entry);

    if (prevEntry && nextCode < 4096) {
      const newEntry = new Uint8Array(prevEntry.length + 1);
      newEntry.set(prevEntry);
      newEntry[prevEntry.length] = entry[0];
      dictionary[nextCode] = newEntry;
      nextCode++;
      if (nextCode + earlyChange >= (2 ** codeSize) && codeSize < 12) {
        codeSize++;
      }
    }

    prevEntry = entry;
  }

  return output.slice(0, outLen);
}
