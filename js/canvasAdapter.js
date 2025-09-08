import { imageStrToBlob } from './utils/imageUtils.js';

export class ca {
  /** @type {import('canvaskit-wasm').CanvasKit} */
  static CanvasKit;

  static getCanvasKit = async () => {
    if (typeof process === 'undefined') {
      throw new Error('getCanvasKit is only available in Node.js');
    } else {
      if (!ca.CanvasKit) {
        // This weirdness is required for types to work for some reason.
        // https://stackoverflow.com/a/69694837
        const canvasKitImport = await import('canvaskit-wasm');
        const CanvasKitInit = canvasKitImport.default;
        ca.CanvasKit = await CanvasKitInit();
      }
      return ca.CanvasKit;
    }
  };

  /**
   *
   * @param {number} width
   * @param {number} height
   */
  static createCanvas = async (width, height) => {
    if (typeof process === 'undefined') {
      return new OffscreenCanvas(width, height);
    }
    if (!width || !height || width <= 0 || height <= 0) {
      throw new Error(`Invalid canvas size: ${width}x${height}`);
    }
    const canvasKit = await ca.getCanvasKit();
    return canvasKit.MakeCanvas(width, height);
  };

  /**
   * Handles various image formats, always returns a ImageBitmap.
   *
   * @param {string|ImageBitmap|Promise<string>|Promise<ImageBitmap>} img
   * @returns {Promise<ImageBitmap>}
   */
  static getImageBitmap = async (img) => {
    img = await img;
    if (img === undefined) throw new Error('Input is undefined');
    if (img === null) throw new Error('Input is null');

    if (typeof img === 'string') {
      if (typeof process === 'undefined') {
        const imgBlob = imageStrToBlob(img);
        const imgBit = await createImageBitmap(imgBlob);
        return imgBit;
      }

      const imgData = new Uint8Array(atob(img.split(',')[1])
        .split('')
        .map((c) => c.charCodeAt(0)));

      const canvasKit = await ca.getCanvasKit();

      const imgBit = await canvasKit.MakeImageFromEncoded(imgData);
      return imgBit;
    }

    // In Node.js the input is assumed to be already compatible with the `canvas.drawImage` method.
    // Additionally, `ImageBitmap` does not exist within the Node canvas package.
    // Second condition exists for type detection purposes.
    if (!(typeof process === 'undefined') && (typeof img !== 'string') && (typeof img !== 'number')) return img;

    return img;
  };

  static dummyCanvasPromise = ca.createCanvas(1, 1);

  /**
   *
   * @param {FontContainerFont} fontObj
   */
  static registerFontObj = async (fontObj) => {
    if (typeof process === 'undefined') {
      throw new Error('registerFontObj is only available in Node.js');
    } else {
      const dummyCanvas = await ca.dummyCanvasPromise;

      const fs = await import('node:fs');
      const fontBuffer = typeof fontObj.src === 'string' ? fs.readFileSync(fontObj.src) : fontObj.src;

      dummyCanvas.loadFont(fontBuffer, {
        family: fontObj.fontFaceName,
        style: fontObj.fontFaceStyle,
        weight: fontObj.fontFaceWeight,
      });
    }
  };
}
