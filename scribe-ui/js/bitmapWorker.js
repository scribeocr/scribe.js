import { imageStrToBlob } from '../../js/utils/imageUtils.js';

const parentPort = typeof process === 'undefined' ? globalThis : (await import('node:worker_threads')).parentPort;
if (!parentPort) throw new Error('This file must be run in a worker');

/**
 * Handles various image formats, always returns a ImageBitmap.
 *
 * @param {string|ImageBitmap|Promise<string>|Promise<ImageBitmap>} img
 * @returns {Promise<ImageBitmap>}
 */
export async function getImageBitmap(img) {
  const imgBlob = imageStrToBlob(img[0]);
  const imgBit = await createImageBitmap(imgBlob);
  return imgBit;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Compresses a page's bitmap to PNG when the viewer evicts it, so a revisit re-decodes the PNG instead of re-rendering the page from the PDF.
 * @param {ImageBitmap} bitmap
 * @returns {Promise<string>} A "data:image/png;base64,..." string.
 */
export async function compressBitmap(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  /** @type {OffscreenCanvasRenderingContext2D} */ (canvas.getContext('2d')).drawImage(bitmap, 0, 0);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return blobToDataUrl(blob);
}

const handleMessage = async (data) => {
  const func = data[0];
  const args = data[1];
  const id = data[2];

  ({
    // Convert page functions
    getImageBitmap,
    compressBitmap,
  })[func](args)
    .then((x) => {
      // Only an ImageBitmap is transferable; other results are cloned.
      const transfer = (typeof ImageBitmap !== 'undefined' && x instanceof ImageBitmap) ? [x] : [];
      parentPort.postMessage({ data: x, id, status: 'resolve' }, transfer);
    })
    .catch((err) => parentPort.postMessage({ data: err, id, status: 'reject' }));
};

if (typeof process === 'undefined') {
  onmessage = (event) => handleMessage(event.data);
} else {
  parentPort.on('message', handleMessage);
}

parentPort.postMessage({ data: 'ready', id: 0, status: 'resolve' });
