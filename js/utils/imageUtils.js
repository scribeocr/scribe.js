/* eslint-disable no-bitwise */

/**
 * Loads an image from a given URL and sets it to a specified HTML element.
 *
 * @param {string|Blob|ArrayBuffer} src - Image source.  Accepts ArrayBuffer, Blob, or URL.
 * @param {HTMLImageElement} elem - The image element where the loaded image will be set.
 * @returns {Promise<HTMLImageElement>} A promise that resolves with the image element when the image is loaded successfully.
 */
export async function loadImageElem(src, elem) {
  return new Promise((resolve, reject) => {
    let urlLoad;
    if (src instanceof Blob) {
      urlLoad = URL.createObjectURL(src);
    } else if (src instanceof ArrayBuffer) {
      const blob = new Blob([src]);
      urlLoad = URL.createObjectURL(blob);
    } else {
      urlLoad = src;
    }
    // const urlLoad = url instanceof Blob ? URL.createObjectURL(url) : url;
    elem.onload = () => resolve(elem);
    elem.onerror = reject;
    elem.src = urlLoad;
  });
}

export function imageStrToBlob(imgStr) {
  const imgData = new Uint8Array(atob(imgStr.split(',')[1])
    .split('')
    .map((c) => c.charCodeAt(0)));

  const imgBlob = new Blob([imgData], { type: 'application/octet-stream' });

  return imgBlob;
}

/**
 * Automatically detects the image type (jpeg or png).
 * @param {Uint8Array} image
 * @returns {('jpeg'|'png')}
 */
const detectImageFormat = (image) => {
  if (image[0] === 0xFF && image[1] === 0xD8) {
    return 'jpeg';
  } if (image[0] === 0x89 && image[1] === 0x50) {
    return 'png';
  }
  throw new Error('Unsupported image type');
};

/**
 *
 * @param {File|FileNode|ArrayBuffer} file
 * @returns {Promise<string>}
 */
export const importImageFileToBase64 = async (file) => new Promise((resolve, reject) => {
  if (file instanceof ArrayBuffer) {
    const imageUint8 = new Uint8Array(file);
    const format = detectImageFormat(imageUint8);
    const binary = String.fromCharCode(...imageUint8);
    resolve(`data:image/${format};base64,${btoa(binary)}`);
    return;
  }

  // The `typeof process` condition is necessary to avoid error in Node.js versions <20, where `File` is not defined.
  if (typeof process === 'undefined' && file instanceof File) {
    const reader = new FileReader();

    reader.onloadend = async () => {
      resolve(/** @type {string} */(reader.result));
    };

    reader.onerror = (error) => {
      reject(error);
    };

    reader.readAsDataURL(file);
    return;
  }

  if (typeof process !== 'undefined') {
    if (!file?.name) reject(new Error('Invalid input. Must be a FileNode or ArrayBuffer.'));
    const format = file.name.match(/jpe?g$/i) ? 'jpeg' : 'png';
    // @ts-ignore
    resolve(`data:image/${format};base64,${file.fileData.toString('base64')}`);
    return;
  }

  reject(new Error('Invalid input. Must be a File or ArrayBuffer.'));
});

/**
 * Converts a base64 encoded string to an array of bytes.
 *
 * @param {string} base64 - The base64 encoded string of the PNG image.
 * @returns {Uint8Array} The byte array representation of the image data.
 */
export function base64ToBytes(base64) {
  const commaIndex = base64.slice(0, 100).indexOf(',');
  if (commaIndex > 0) {
    base64 = base64.slice(commaIndex + 1);
  }
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Extracts complete IHDR information from a PNG image encoded in base64.
 *
 * @param {Uint8Array<ArrayBufferLike>} bytes - The base64 encoded string of the PNG image.
 * @returns {PngIHDRInfo}
 */
export function getPngIHDRInfo(bytes) {
  // The IHDR chunk data starts at byte 16 (after PNG signature and IHDR chunk header)
  // Width: bytes 16-19 (4 bytes, big-endian)
  const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];

  // Height: bytes 20-23 (4 bytes, big-endian)
  const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];

  // Bit depth: byte 24 (1 byte)
  const bitDepth = bytes[24];

  // Color type: byte 25 (1 byte)
  const colorType = bytes[25];

  // Compression method: byte 26 (1 byte, always 0 for PNG)
  const compressionMethod = bytes[26];

  // Filter method: byte 27 (1 byte, always 0 for PNG)
  const filterMethod = bytes[27];

  // Interlace method: byte 28 (1 byte, 0=none, 1=Adam7)
  const interlaceMethod = bytes[28];

  return {
    width,
    height,
    bitDepth,
    colorType,
    compressionMethod,
    filterMethod,
    interlaceMethod,
  };
}

/**
 * Extracts the width and height from the IHDR chunk of a PNG image encoded in base64.
 *
 * This function decodes the base64 to bytes and parses the IHDR chunk to extract the image dimensions.
 * It assumes the base64 string is a valid PNG image and directly starts parsing the binary data.
 * Note: This is a basic implementation without extensive error handling or validation.
 *
 * @param {string} base64 - The base64 encoded string of the PNG image.
 * @returns {dims} An object containing the width and height of the image.
 */
export function getPngDimensions(base64) {
  // The number 96 is chosen to line up leanly with byte boundaries (97 would result in an error)
  // but is otherwise arbitrary, while being large enough to contain the IHDR chunk.
  const bytes = base64ToBytes(base64.slice(0, 150).split(',')[1].slice(0, 96));
  // The width and height are located at specific positions in the IHDR chunk
  const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
  const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
  return { width, height };
}

/**
 * Gets the dimensions of a base64 encoded JPEG image.
 * @param {string} base64 - The base64 encoded JPEG image.
 * @returns {dims} The dimensions of the image.
 */
export function getJpegDimensions(base64) {
  // It would be more efficient if this only converted the base64 string up to the point where the dimensions are found.
  const bytes = base64ToBytes(base64.split(',')[1]);
  let i = 0;

  // Skip the initial marker if it exists.
  if (bytes[i] === 0xFF && bytes[i + 1] === 0xD8) {
    i += 2;
  }

  while (i < bytes.length) {
    // Look for the 0xFF marker that might indicate the start of an SOF segment
    if (bytes[i] === 0xFF) {
      // List of JPEG SOF markers taken from jhead.
      // https://github.com/Matthias-Wandel/jhead/blob/4d04ac965632e35a65709c7f92a857a749e71811/jhead.h#L247-L259
      if ([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF].includes(bytes[i + 1])) {
        // The height and width are stored after the marker and segment length
        const height = (bytes[i + 5] << 8) | bytes[i + 6];
        const width = (bytes[i + 7] << 8) | bytes[i + 8];
        return { width, height };
      }
      // Skip to the next marker if not an SOF marker
      const segmentLength = (bytes[i + 2] << 8) | bytes[i + 3];
      i += segmentLength + 2;
      continue;
    }
    i++;
  }
  throw new Error('Could not find dimensions in the JPEG image.');
}
