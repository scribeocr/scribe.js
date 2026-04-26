/**
 * PNG predictor decoder for PDF stream decompression.
 * Each row has a filter byte followed by `columns` data bytes.
 * @param {Uint8Array} data
 * @param {number} columns - bytes per row (width * colors * bpc / 8)
 * @param {number} [bpp=1] - bytes per pixel (colors * bpc / 8); used for Sub/Average/Paeth left offset
 */
export function decodePNGPredictor(data, columns, bpp = 1) {
  const rowSize = columns + 1; // filter byte + data bytes
  const numRows = Math.floor(data.length / rowSize);
  const result = new Uint8Array(numRows * columns);
  const prevRow = new Uint8Array(columns);

  for (let row = 0; row < numRows; row++) {
    const filterByte = data[row * rowSize];
    const srcOffset = row * rowSize + 1;
    const dstOffset = row * columns;

    for (let col = 0; col < columns; col++) {
      const raw = data[srcOffset + col];
      // PNG spec: "left" refers to the same component of the previous pixel,
      // which is bpp bytes back (not just 1 byte back for multi-component images).
      const left = col >= bpp ? result[dstOffset + col - bpp] : 0;
      const up = prevRow[col];

      switch (filterByte) {
        case 0: // None
          result[dstOffset + col] = raw;
          break;
        case 1: // Sub
          result[dstOffset + col] = (raw + left) % 256;
          break;
        case 2: // Up
          result[dstOffset + col] = (raw + up) % 256;
          break;
        case 3: // Average
          result[dstOffset + col] = (raw + Math.floor((left + up) / 2)) % 256;
          break;
        case 4: { // Paeth
          const upLeft = col >= bpp ? prevRow[col - bpp] : 0;
          result[dstOffset + col] = (raw + paethPredictor(left, up, upLeft)) % 256;
          break;
        }
        default:
          result[dstOffset + col] = raw;
          break;
      }
    }

    // Copy current row to prevRow for next iteration
    prevRow.set(result.subarray(dstOffset, dstOffset + columns));
  }

  return result;
}

/**
 * Paeth predictor function.
 * @param {number} a - left
 * @param {number} b - above
 * @param {number} c - upper-left
 */
function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
