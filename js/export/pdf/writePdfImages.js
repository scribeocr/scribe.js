import { imageUtils } from '../../objects/imageObjects.js';
import { base64ToBytes, getPngIHDRInfo } from '../../utils/imageUtils.js';
import { hex } from './writePdfFonts.js';

/**
 * @param {number} x
 */
const formatNum = (x) => String(Math.round(x * 1e6) / 1e6);

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
    throw new Error('No IDAT chunks found in PNG file');
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
 * Creates PDF XObject for a .jpeg image. Binary (raw DCTDecode) by default.
 * Binary (raw DCTDecode) by default `humanReadable` wraps the stream in ASCIIHexDecode for diffable ASCII output.
 * @param {number} objIndex - PDF object index
 * @param {ArrayBufferLike} imageData - Raw image data
 * @param {number} width - Image width
 * @param {number} height - Image height
 * @param {boolean} humanReadable
 * @returns {string | import('./writePdfStreams.js').PdfBinaryObject} PDF XObject
 */
const createImageXObjectJpeg = (objIndex, imageData, width, height, humanReadable) => {
  const imageBytes = new Uint8Array(imageData);
  let dict = `${String(objIndex)} 0 obj\n`;
  dict += '<</Type /XObject\n';
  dict += '/Subtype /Image\n';
  dict += `/Width ${String(width)}\n`;
  dict += `/Height ${String(height)}\n`;
  dict += '/ColorSpace /DeviceRGB\n';
  dict += '/BitsPerComponent 8\n';

  if (humanReadable) {
    const imageHexStr = hex(imageBytes.buffer);
    return `${dict}/Filter [ /ASCIIHexDecode /DCTDecode ]\n/Length ${String(imageHexStr.length)}\n>>\nstream\n${imageHexStr}\nendstream\nendobj\n\n`;
  }
  return {
    header: `${dict}/Filter /DCTDecode\n/Length ${String(imageBytes.length)}\n>>\nstream\n`,
    streamData: imageBytes,
    trailer: '\nendstream\nendobj\n\n',
  };
};

/**
 * Creates a DeviceN color space PDF object for RGBA.
 * This allows for supporting RGBA by simply ignoring the alpha channel in rendering.
 *
 * @param {number} colorSpaceObjIndex - The object index for the color space object.
 */
export function createDeviceNRGBA(colorSpaceObjIndex) {
  const tintFuncObjIndex = colorSpaceObjIndex + 1;

  const tintTransformFunction = '{ pop }';

  const colorSpaceObj = `${colorSpaceObjIndex} 0 obj
[
  /DeviceN
  [ /Red /Green /Blue /Alpha ]
  /DeviceRGB
  ${tintFuncObjIndex} 0 R
]
endobj
`;

  const tintFuncObj = `${tintFuncObjIndex} 0 obj
<<
  /FunctionType 4
  /Domain [ 0 1 0 1 0 1 0 1 ]
  /Range [ 0 1 0 1 0 1 ]
  /Length ${tintTransformFunction.length}
>>
stream
${tintTransformFunction}
endstream
endobj
`;

  return [colorSpaceObj, tintFuncObj];
}

/**
 * Creates PDF XObject for a .png image. Binary (raw FlateDecode IDAT) by default.
 * `humanReadable` adds an ASCIIHexDecode wrapper for diffable output.
 * @param {number} objIndex - PDF object index
 * @param {ArrayBufferLike} imageData - Raw image data
 * @param {number|undefined} objDevN - Object index of associated DeviceN color space for supporting RGBA.
 *    This is necessary to handle PNGs with alpha channels without re-encoding.
 * @param {boolean} humanReadable
 * @returns {string | import('./writePdfStreams.js').PdfBinaryObject} PDF XObject
 */
const createImageXObjectPng = (objIndex, imageData, objDevN, humanReadable) => {
  const imageBytes = new Uint8Array(imageData);
  const imageDataOutput = extractPngIdatData(imageBytes);
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
    if (!objDevN) {
      console.warn('PNG has alpha channel but no DeviceN color space provided. PNG will not be rendered correctly.');
    } else {
      colorSpace = `${objDevN} 0 R`;
    }
  } else {
    console.warn(`Unsupported PNG color type: ${idhr.colorType}, defaulting to RGB`);
  }

  const parms = `<</Predictor ${predictor} /Colors ${colors} /Columns ${String(idhr.width)} >>`;
  let dict = `${String(objIndex)} 0 obj\n`;
  dict += '<</Type /XObject\n';
  dict += '/Subtype /Image\n';
  dict += `/Width ${String(idhr.width)}\n`;
  dict += `/Height ${String(idhr.height)}\n`;
  dict += `/ColorSpace ${colorSpace}\n`;
  dict += `/BitsPerComponent ${idhr.bitDepth}\n`;

  if (humanReadable) {
    // Two filters: the ASCIIHex wrapper (no params) then FlateDecode (predictor).
    const imageHexStr = hex(imageDataOutput.buffer);
    let objStr = dict;
    objStr += `/DecodeParms [ null ${parms} ]\n`;
    objStr += '/Filter [ /ASCIIHexDecode /FlateDecode ]\n';
    objStr += `/Length ${String(imageHexStr.length)}\n`;
    objStr += '>>\nstream\n';
    objStr += `${imageHexStr}\nendstream\nendobj\n\n`;
    return objStr;
  }
  return {
    header: `${dict}/DecodeParms ${parms}\n/Filter /FlateDecode\n/Length ${String(imageDataOutput.length)}\n>>\nstream\n`,
    streamData: imageDataOutput,
    trailer: '\nendstream\nendobj\n\n',
  };
};

/**
 * Creates PDF objects for multiple images
 * @param {ImageWrapper[]} images - Array of image data
 * @param {number} firstObjIndex - Starting object index
 * @param {number} [objDevN] - Object index of associated DeviceN color space for supporting RGBA.
 *    This is necessary to handle PNGs with alpha channels without re-encoding.
 * @param {boolean} [humanReadable=false] - If true, wrap image streams in ASCIIHexDecode for diffable ASCII output.
 *    Default emits raw binary streams.
 * @returns {Array<string | import('./writePdfStreams.js').PdfBinaryObject>}
 */
export function createEmbeddedImages(images, firstObjIndex, objDevN, humanReadable = false) {
  /** @type {Array<string | import('./writePdfStreams.js').PdfBinaryObject>} */
  const imageObjArr = [];

  images.forEach((image, index) => {
    const objIndex = firstObjIndex + index;
    const dims = imageUtils.getDims(image);
    const imageBytes = base64ToBytes(image.src);
    let objParts;
    if (image.format === 'jpeg') {
      objParts = createImageXObjectJpeg(objIndex, imageBytes.buffer, dims.width, dims.height, humanReadable);
    } else {
      objParts = createImageXObjectPng(objIndex, imageBytes.buffer, objDevN, humanReadable);
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
 * @param {string} imageName
 * @param {number} x - X position
 * @param {number} y - Y position
 * @param {number} width - Display width
 * @param {number} height - Display height
 * @param {number} rotation - Rotation angle in degrees (default: 0)
 * @returns {string} PDF drawing commands
 */
export function drawImageCommands(imageName, x, y, width, height, rotation = 0) {
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

  return `q\n${formatNum(a)} ${formatNum(b)} ${formatNum(c)} ${formatNum(d)} ${formatNum(e)} ${formatNum(f)} cm\n/${imageName} Do\nQ\n`;
}
