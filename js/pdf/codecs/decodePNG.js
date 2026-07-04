/**
 * PNG predictor decoder for PDF stream decompression.
 * Each row has a filter byte followed by `columns` data bytes.
 * @param {Uint8Array} data
 * @param {number} columns - bytes per row (width * colors * bpc / 8)
 * @param {number} [bpp=1] - bytes per pixel (colors * bpc / 8); used for Sub/Average/Paeth left offset
 */
export function decodePNGPredictor(data, columns, bpp = 1) {
  const rowSize = columns + 1; // filter byte + data bytes
  // Decode a final partial row (filter byte + fewer than `columns` data bytes)
  // rather than dropping it, so a stream that ends mid-row keeps its last bytes.
  const numRows = Math.ceil(data.length / rowSize);
  const result = new Uint8Array(numRows * columns);
  let outLen = 0;

  // The filter type is constant per row, so dispatch once per row and run a tight per-filter loop.
  // The previous row is read out of `result` in place (rows are contiguous) instead of keeping a copy,
  // and Uint8Array stores already truncate to a byte, so no explicit % 256 is needed.
  for (let row = 0; row < numRows; row++) {
    const srcOffset = row * rowSize + 1;
    const avail = Math.min(columns, data.length - srcOffset);
    if (avail <= 0) break;
    const filterByte = data[row * rowSize];
    const dstOffset = row * columns;
    const prevOffset = dstOffset - columns;

    if (filterByte === 0 || filterByte > 4) { // None (unknown filter types also pass bytes through)
      result.set(data.subarray(srcOffset, srcOffset + avail), dstOffset);
    } else if (filterByte === 1) { // Sub
      let col = 0;
      for (; col < bpp && col < avail; col++) result[dstOffset + col] = data[srcOffset + col];
      for (; col < avail; col++) result[dstOffset + col] = data[srcOffset + col] + result[dstOffset + col - bpp];
    } else if (filterByte === 2) { // Up (row 0 has an all-zero row above: passthrough)
      if (row === 0) {
        result.set(data.subarray(srcOffset, srcOffset + avail), dstOffset);
      } else {
        for (let col = 0; col < avail; col++) result[dstOffset + col] = data[srcOffset + col] + result[prevOffset + col];
      }
    } else if (filterByte === 3) { // Average
      let col = 0;
      if (row === 0) {
        for (; col < bpp && col < avail; col++) result[dstOffset + col] = data[srcOffset + col];
        for (; col < avail; col++) result[dstOffset + col] = data[srcOffset + col] + (result[dstOffset + col - bpp] >> 1);
      } else {
        for (; col < bpp && col < avail; col++) result[dstOffset + col] = data[srcOffset + col] + (result[prevOffset + col] >> 1);
        for (; col < avail; col++) {
          result[dstOffset + col] = data[srcOffset + col] + ((result[dstOffset + col - bpp] + result[prevOffset + col]) >> 1);
        }
      }
    } else if (row === 0) { // Paeth with an all-zero row above always selects `left`
      let col = 0;
      for (; col < bpp && col < avail; col++) result[dstOffset + col] = data[srcOffset + col];
      for (; col < avail; col++) result[dstOffset + col] = data[srcOffset + col] + result[dstOffset + col - bpp];
    } else { // Paeth
      let col = 0;
      // First pixel: left = upLeft = 0, so the predictor always resolves to `up`.
      for (; col < bpp && col < avail; col++) result[dstOffset + col] = data[srcOffset + col] + result[prevOffset + col];
      for (; col < avail; col++) {
        const left = result[dstOffset + col - bpp];
        const up = result[prevOffset + col];
        const upLeft = result[prevOffset + col - bpp];
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        result[dstOffset + col] = data[srcOffset + col] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      }
    }

    outLen = dstOffset + avail;
  }

  return result.subarray(0, outLen);
}
