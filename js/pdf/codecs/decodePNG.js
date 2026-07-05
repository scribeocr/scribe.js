/**
 * PNG predictor decoder for PDF stream decompression.
 * Each row has a filter byte followed by `columns` data bytes.
 * @param {Uint8Array} data
 * @param {number} columns - bytes per row (width * colors * bpc / 8)
 * @param {number} [bpp=1] - bytes per pixel (colors * bpc / 8), used for Sub/Average/Paeth left offset
 * @returns {Uint8Array}
 */
export function decodePNGPredictor(data, columns, bpp = 1) {
  const rowSize = columns + 1;
  const numRows = Math.ceil(data.length / rowSize);
  const result = new Uint8Array(numRows * columns);
  const dvSrc = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const dvDst = new DataView(result.buffer, 0, result.byteLength);
  let outLen = 0;

  for (let row = 0; row < numRows; row++) {
    const srcOffset = row * rowSize + 1;
    const avail = Math.min(columns, data.length - srcOffset);
    if (avail <= 0) break;
    const filterByte = data[row * rowSize];
    const dstOffset = row * columns;
    const prevOffset = dstOffset - columns;

    if (filterByte === 0 || filterByte > 4) { // None
      result.set(data.subarray(srcOffset, srcOffset + avail), dstOffset);
    } else if (filterByte === 1) { // Sub
      if (bpp === 1) {
        let left = data[srcOffset];
        result[dstOffset] = left;
        for (let col = 1; col < avail; col++) {
          left = (data[srcOffset + col] + left) & 255;
          result[dstOffset + col] = left;
        }
      } else if (bpp === 3 && avail >= 3) {
        let l0 = data[srcOffset];
        let l1 = data[srcOffset + 1];
        let l2 = data[srcOffset + 2];
        result[dstOffset] = l0;
        result[dstOffset + 1] = l1;
        result[dstOffset + 2] = l2;
        let col = 3;
        for (; col + 2 < avail; col += 3) {
          l0 = (data[srcOffset + col] + l0) & 255;
          l1 = (data[srcOffset + col + 1] + l1) & 255;
          l2 = (data[srcOffset + col + 2] + l2) & 255;
          result[dstOffset + col] = l0;
          result[dstOffset + col + 1] = l1;
          result[dstOffset + col + 2] = l2;
        }
        for (; col < avail; col++) result[dstOffset + col] = data[srcOffset + col] + result[dstOffset + col - 3];
      } else if (bpp === 4 && avail >= 4) {
        let l0 = data[srcOffset];
        let l1 = data[srcOffset + 1];
        let l2 = data[srcOffset + 2];
        let l3 = data[srcOffset + 3];
        result[dstOffset] = l0;
        result[dstOffset + 1] = l1;
        result[dstOffset + 2] = l2;
        result[dstOffset + 3] = l3;
        let col = 4;
        for (; col + 3 < avail; col += 4) {
          l0 = (data[srcOffset + col] + l0) & 255;
          l1 = (data[srcOffset + col + 1] + l1) & 255;
          l2 = (data[srcOffset + col + 2] + l2) & 255;
          l3 = (data[srcOffset + col + 3] + l3) & 255;
          result[dstOffset + col] = l0;
          result[dstOffset + col + 1] = l1;
          result[dstOffset + col + 2] = l2;
          result[dstOffset + col + 3] = l3;
        }
        for (; col < avail; col++) result[dstOffset + col] = data[srcOffset + col] + result[dstOffset + col - 4];
      } else {
        let col = 0;
        for (; col < bpp && col < avail; col++) result[dstOffset + col] = data[srcOffset + col];
        for (; col < avail; col++) result[dstOffset + col] = data[srcOffset + col] + result[dstOffset + col - bpp];
      }
    } else if (filterByte === 2) { // Up
      if (row === 0) {
        result.set(data.subarray(srcOffset, srcOffset + avail), dstOffset);
      } else {
        let col = 0;
        const n4 = avail - 3;
        for (; col < n4; col += 4) {
          const x = dvSrc.getUint32(srcOffset + col, true);
          const y = dvDst.getUint32(prevOffset + col, true);
          const s = (((x & 0x7f7f7f7f) + (y & 0x7f7f7f7f)) ^ ((x ^ y) & 0x80808080)) >>> 0;
          dvDst.setUint32(dstOffset + col, s, true);
        }
        for (; col < avail; col++) result[dstOffset + col] = data[srcOffset + col] + result[prevOffset + col];
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
    } else if (row === 0) { // Paeth row 0
      let col = 0;
      for (; col < bpp && col < avail; col++) result[dstOffset + col] = data[srcOffset + col];
      for (; col < avail; col++) result[dstOffset + col] = data[srcOffset + col] + result[dstOffset + col - bpp];
    } else if (bpp === 1) { // Paeth, bpp=1 with rotating locals
      let left = (data[srcOffset] + result[prevOffset]) & 255;
      let upLeft = result[prevOffset];
      result[dstOffset] = left;
      for (let col = 1; col < avail; col++) {
        const up = result[prevOffset + col];
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        left = (data[srcOffset + col] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 255;
        result[dstOffset + col] = left;
        upLeft = up;
      }
    } else if (bpp === 3 && avail >= 3) { // Paeth, bpp=3 with rotating locals
      let l0 = (data[srcOffset] + result[prevOffset]) & 255;
      let l1 = (data[srcOffset + 1] + result[prevOffset + 1]) & 255;
      let l2 = (data[srcOffset + 2] + result[prevOffset + 2]) & 255;
      let ul0 = result[prevOffset];
      let ul1 = result[prevOffset + 1];
      let ul2 = result[prevOffset + 2];
      result[dstOffset] = l0;
      result[dstOffset + 1] = l1;
      result[dstOffset + 2] = l2;
      for (let col = 3; col < avail; col++) {
        const up = result[prevOffset + col];
        const p = l0 + up - ul0;
        const pa = Math.abs(p - l0);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - ul0);
        const v = (data[srcOffset + col] + (pa <= pb && pa <= pc ? l0 : pb <= pc ? up : ul0)) & 255;
        result[dstOffset + col] = v;
        l0 = l1; l1 = l2; l2 = v;
        ul0 = ul1; ul1 = ul2; ul2 = up;
      }
    } else if (bpp === 4 && avail >= 4) { // Paeth, bpp=4 with rotating locals
      let l0 = (data[srcOffset] + result[prevOffset]) & 255;
      let l1 = (data[srcOffset + 1] + result[prevOffset + 1]) & 255;
      let l2 = (data[srcOffset + 2] + result[prevOffset + 2]) & 255;
      let l3 = (data[srcOffset + 3] + result[prevOffset + 3]) & 255;
      let ul0 = result[prevOffset];
      let ul1 = result[prevOffset + 1];
      let ul2 = result[prevOffset + 2];
      let ul3 = result[prevOffset + 3];
      result[dstOffset] = l0;
      result[dstOffset + 1] = l1;
      result[dstOffset + 2] = l2;
      result[dstOffset + 3] = l3;
      for (let col = 4; col < avail; col++) {
        const up = result[prevOffset + col];
        const p = l0 + up - ul0;
        const pa = Math.abs(p - l0);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - ul0);
        const v = (data[srcOffset + col] + (pa <= pb && pa <= pc ? l0 : pb <= pc ? up : ul0)) & 255;
        result[dstOffset + col] = v;
        l0 = l1; l1 = l2; l2 = l3; l3 = v;
        ul0 = ul1; ul1 = ul2; ul2 = ul3; ul3 = up;
      }
    } else { // Paeth
      let col = 0;
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
