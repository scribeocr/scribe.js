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

  let bitPos = 0;
  function readBits(n) {
    let val = 0;
    for (let i = 0; i < n; i++) {
      const byteIdx = Math.floor(bitPos / 8);
      const bitIdx = 7 - (bitPos % 8); // MSB first
      if (byteIdx < data.length) {
        val = val * 2 + ((Math.floor(data[byteIdx] / (2 ** bitIdx))) % 2);
      }
      bitPos++;
    }
    return val;
  }

  let codeSize = 9;
  let nextCode = 258;
  const dictionary = new Array(4096);
  const output = [];

  for (let i = 0; i < 256; i++) dictionary[i] = [i];

  let prevEntry = null;

  while (bitPos < data.length * 8) {
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
      entry = [...prevEntry, prevEntry[0]];
    } else {
      break; // Invalid code
    }

    for (let i = 0; i < entry.length; i++) output.push(entry[i]);

    if (prevEntry && nextCode < 4096) {
      dictionary[nextCode] = [...prevEntry, entry[0]];
      nextCode++;
      if (nextCode + earlyChange >= (2 ** codeSize) && codeSize < 12) {
        codeSize++;
      }
    }

    prevEntry = entry;
  }

  return new Uint8Array(output);
}
