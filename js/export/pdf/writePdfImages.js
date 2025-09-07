/* eslint-disable no-bitwise */
import { imageUtils } from '../../objects/imageObjects.js';
import { base64ToBytes, getPngIHDRInfo } from '../../utils/imageUtils.js';
import { hex } from './writePdfFonts.js';

/**
 * Extracts the concatenated data from all IDAT chunks of a PNG file.
 * @param {Uint8Array} pngBytes - The raw bytes of the PNG file.
 * @returns {Uint8Array} The concatenated zlib-compressed image data.
 */
function extractPngIdatData(pngBytes) {
  // PNG signature
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (pngBytes[i] !== signature[i]) {
      throw new Error('Invalid PNG file signature');
    }
  }

  let offset = 8;
  const idatChunks = [];

  while (offset < pngBytes.length) {
    // Read chunk length directly from bytes (big-endian)
    const length = (pngBytes[offset] << 24)
                   | (pngBytes[offset + 1] << 16)
                   | (pngBytes[offset + 2] << 8)
                   | pngBytes[offset + 3];
    offset += 4;

    const type = String.fromCharCode(
      pngBytes[offset],
      pngBytes[offset + 1],
      pngBytes[offset + 2],
      pngBytes[offset + 3],
    );
    offset += 4;

    if (type === 'IDAT') {
      idatChunks.push(pngBytes.subarray(offset, offset + length));
    } else if (type === 'IEND') {
      break;
    }

    offset += length + 4; // Skip data and CRC
  }

  if (idatChunks.length === 0) {
    console.warn('No IDAT chunks found in PNG image.');
    return pngBytes; // Fallback if no IDAT chunks are found
  }

  const totalLength = idatChunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const concatenated = new Uint8Array(totalLength);
  let currentOffset = 0;
  for (const chunk of idatChunks) {
    concatenated.set(chunk, currentOffset);
    currentOffset += chunk.length;
  }

  return concatenated;
}

/**
 * Creates PDF XObject for an .jpeg image
 * @param {number} objIndex - PDF object index
 * @param {ArrayBufferLike} imageData - Raw image data
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @returns {string} PDF XObject string
 */
const createImageXObjectJpeg = (objIndex, imageData, width, height) => {
  const imageBytes = new Uint8Array(imageData);
  let objStr = `${String(objIndex)} 0 obj\n`;
  objStr += '<</Type /XObject\n';
  objStr += '/Subtype /Image\n';

  // For JPEG, we can use the raw JPEG data directly
  const imageHexStr = hex(imageBytes.buffer);

  objStr += `/Width ${String(width)}\n`;
  objStr += `/Height ${String(height)}\n`;
  objStr += '/ColorSpace /DeviceRGB\n';
  objStr += '/BitsPerComponent 8\n';
  objStr += '/Filter [ /ASCIIHexDecode /DCTDecode ]\n';
  objStr += `/Length ${String(imageHexStr.length)}\n`;
  objStr += '>>\nstream\n';
  objStr += `${imageHexStr}\n`;
  objStr += 'endstream\nendobj\n\n';
  return objStr;
};

/**
 * Creates PDF XObject for an .png image
 * @param {number} objIndex - PDF object index
 * @param {ArrayBufferLike} imageData - Raw image data
 * @returns {string} PDF XObject string
 */
const createImageXObjectPng = (objIndex, imageData) => {
  const imageBytes = new Uint8Array(imageData);
  let objStr = `${String(objIndex)} 0 obj\n`;
  objStr += '<</Type /XObject\n';
  objStr += '/Subtype /Image\n';

  // For PNG, extract IDAT data and get header info
  const imageDataOutput = extractPngIdatData(imageBytes);
  const imageHexStr = hex(imageDataOutput.buffer);
  const idhr = getPngIHDRInfo(imageBytes);

  const predictor = 15;
  let colors = 3;
  let colorSpace = '/DeviceRGB';

  // Determine color space and number of color components based on PNG color type
  // Missing palette support (colorType 3)
  if (idhr.colorType === 0) {
    colors = 1;
    colorSpace = '/DeviceGray';
  } else if (idhr.colorType === 2) {
    colors = 3;
    colorSpace = '/DeviceRGB';
  } else if (idhr.colorType === 4) {
    colors = 2;
    colorSpace = '/DeviceGray';
  } else if (idhr.colorType === 6) {
    colors = 4;
    colorSpace = '/DeviceRGB';
  }

  objStr += '/DecodeParms [ null <<';
  objStr += `/Predictor ${predictor} `;
  objStr += `/Colors ${colors} `;
  objStr += `/Columns ${String(idhr.width)} `;
  objStr += ' >> ]\n';
  objStr += `/Width ${String(idhr.width)}\n`;
  objStr += `/Height ${String(idhr.height)}\n`;
  objStr += `/ColorSpace ${colorSpace}\n`;
  objStr += `/BitsPerComponent ${idhr.bitDepth}\n`;
  objStr += '/Filter [ /ASCIIHexDecode /FlateDecode ]\n';
  objStr += `/Length ${String(imageHexStr.length)}\n`;
  objStr += '>>\nstream\n';
  objStr += `${imageHexStr}\n`;
  objStr += 'endstream\nendobj\n\n';

  return objStr;
};

/**
 * Creates PDF objects for multiple images
 * @param {ImageWrapper[]} images - Array of image data
 * @param {number} firstObjIndex - Starting object index
 */
export function createEmbeddedImages(images, firstObjIndex) {
  /** @type {string[]} */
  const imageObjArr = [];

  images.forEach((image, index) => {
    const objIndex = firstObjIndex + index;
    const dims = imageUtils.getDims(image);
    const imageBytes = base64ToBytes(image.src);
    let objParts;
    if (image.format === 'jpeg') {
      objParts = createImageXObjectJpeg(objIndex, imageBytes.buffer, dims.width, dims.height);
    } else {
      objParts = createImageXObjectPng(objIndex, imageBytes.buffer);
    }
    imageObjArr.push(objParts);
  });

  return imageObjArr;
}

/**
 * Creates a resource dictionary entry for images
 * @param {Array<number>} imageObjIndices - Array of image object indices
 * @returns {string} Resource dictionary XObject entries
 */
export function createImageResourceDict(imageObjIndices) {
  if (imageObjIndices.length === 0) return '';

  let resourceStr = '/XObject<<';
  imageObjIndices.forEach((objIndex, i) => {
    resourceStr += `/Im${String(i)} ${String(objIndex)} 0 R\n`;
  });
  resourceStr += '>>';

  return resourceStr;
}

/**
 * Generates PDF drawing commands to place an image on a page with optional rotation
 * @param {number} imageIndex - Index of the image (for /Im naming)
 * @param {number} x - X position
 * @param {number} y - Y position
 * @param {number} width - Display width
 * @param {number} height - Display height
 * @param {number} rotation - Rotation angle in degrees (default: 0)
 * @returns {string} PDF drawing commands
 */
export function drawImageCommands(imageIndex, x, y, width, height, rotation = 0) {
  const angle = (rotation * Math.PI) / 180;

  const centerX = x + width / 2;
  const centerY = y + height / 2;

  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  const a = width * cos;
  const b = width * sin;
  const c = -height * sin;
  const d = height * cos;

  const e = centerX - (width * cos - height * sin) / 2;
  const f = centerY - (width * sin + height * cos) / 2;

  return `q\n${a} ${b} ${c} ${d} ${e} ${f} cm\n/Im${imageIndex} Do\nQ\n`;
}
