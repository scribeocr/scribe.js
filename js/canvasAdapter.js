import { imageStrToBlob } from './utils/imageUtils.js';

export class ca {
  static CanvasNode;

  static isNode = typeof process !== 'undefined';

  static _initPromise = null;

  /**
   * Load Node.js canvas module.
   * Must be called at least once before any canvas operations in Node.
   */
  static getCanvasNode = async () => {
    if (!ca.isNode) {
      throw new Error('getCanvasNode is only available in Node.js');
    }
    if (!ca._initPromise) {
      ca._initPromise = (async () => {
        ca.CanvasNode = await import('@scribe.js/canvas');
        globalThis.ImageData = ca.CanvasNode.ImageData;
        globalThis.DOMMatrix = ca.CanvasNode.DOMMatrix;
        return ca.CanvasNode;
      })();
    }
    return ca._initPromise;
  };

  static getCanvasNodeSync = () => {
    if (!ca.CanvasNode) throw new Error('@scribe.js/canvas not initialized — call await ca.getCanvasNode() first');
    return ca.CanvasNode;
  };

  /**
   * Create a canvas. Sync — @scribe.js/canvas must already be loaded in Node.js.
   * @param {number} width
   * @param {number} height
   */
  static makeCanvas = (width, height) => {
    if (!ca.isNode) return new OffscreenCanvas(width, height);
    return ca.getCanvasNodeSync().createCanvas(width, height);
  };

  /**
   * @param {number} width
   * @param {number} height
   */
  static createCanvas = async (width, height) => {
    if (!ca.isNode) return new OffscreenCanvas(width, height);
    if (!width || !height || width <= 0 || height <= 0) {
      throw new Error(`Invalid canvas size: ${width}x${height}`);
    }
    const CanvasNode = await ca.getCanvasNode();
    return CanvasNode.createCanvas(width, height);
  };

  /**
   * Synchronously release a drawable's native resources.
   * @param {*} d
   */
  static closeDrawable = (d) => {
    if (!d) return;
    if (typeof d.dispose === 'function') { d.dispose(); return; }
    if (typeof d.close === 'function') d.close();
  };

  /**
   * Decode raw image bytes (JPEG, PNG, etc.) into a drawable for `ctx.drawImage()`.
   * Browser: creates Blob + createImageBitmap.
   * Node: @scribe.js/canvas's loadImage which accepts a Buffer / Uint8Array.
   * @param {Uint8Array} data - Raw image bytes
   */
  static createImageBitmapFromData = async (data) => {
    if (!ca.isNode) {
      return createImageBitmap(new Blob([data]));
    }
    const CanvasNode = ca.getCanvasNodeSync();
    return CanvasNode.loadImage(Buffer.from(data));
  };

  /**
   * Create a drawable from an ImageData object.
   * Browser: createImageBitmap(imageData).
   * Node: putImageData onto a fresh Canvas — @scribe.js/canvas drawImage
   * accepts Canvas directly so we can return the canvas itself.
   * @param {ImageData} imgData
   */
  static createImageBitmapFromImageData = async (imgData) => {
    if (!ca.isNode) return createImageBitmap(imgData);
    const tmpCanvas = ca.makeCanvas(imgData.width, imgData.height);
    const tmpCtx = tmpCanvas.getContext('2d');
    tmpCtx.putImageData(imgData, 0, 0);
    return tmpCanvas;
  };

  /**
   * Create a drawable from a canvas (snapshot).
   * Browser: createImageBitmap(canvas).
   * Node: pass through — @scribe.js/canvas drawImage accepts Canvas directly.
   * @param {*} canvas
   */
  static createImageBitmapFromCanvas = async (canvas) => {
    if (!ca.isNode) return createImageBitmap(canvas);
    return canvas;
  };

  /**
   * Handles various image formats, always returns something drawable.
   *
   * @param {string|*|Promise<string>|Promise<*>} img
   */
  static getImageBitmap = async (img) => {
    img = await img;
    if (img === undefined) throw new Error('Input is undefined');
    if (img === null) throw new Error('Input is null');

    if (typeof img === 'string') {
      if (!ca.isNode) {
        const imgBlob = imageStrToBlob(img);
        return createImageBitmap(imgBlob);
      }
      const CanvasNode = await ca.getCanvasNode();
      const imgData = new Uint8Array(atob(img.split(',')[1])
        .split('')
        .map((c) => c.charCodeAt(0)));
      return CanvasNode.loadImage(Buffer.from(imgData));
    }

    return img;
  };

  /**
   * Composite key `${fontFaceName}:${fontFaceStyle}:${fontFaceWeight}` →
   * `{ fontKey, fontFaceName }`.
   * @type {Map<string, {fontKey: *, fontFaceName: string}>|null}
   */
  static _registeredFonts = null;

  /**
   * Register a font from raw bytes. Callers must pass stable family names
   * for the same bytes (embedded: `_pdf_d${docId}_f${fontObjNum}` via
   * `pdfFontFamilyName`; substitutes: `_scribe_*`) to avoid re-registration.
   *
   * @param {FontContainerFont} fontObj
   */
  static registerFontObj = async (fontObj) => {
    if (!ca.isNode) {
      throw new Error('registerFontObj is only available in Node.js');
    }
    const CanvasNode = await ca.getCanvasNode();
    if (!ca._registeredFonts) ca._registeredFonts = new Map();
    const dedupKey = `${fontObj.fontFaceName}:${fontObj.fontFaceStyle}:${fontObj.fontFaceWeight}`;
    if (ca._registeredFonts.has(dedupKey)) return;
    const fontBuffer = typeof fontObj.src === 'string'
      ? (await import('node:fs')).readFileSync(fontObj.src)
      : Buffer.from(fontObj.src);
    const weight = fontObj.fontFaceWeight === 'bold' ? 700 : 400;
    const fontKey = CanvasNode.GlobalFonts.register(fontBuffer, fontObj.fontFaceName, {
      style: fontObj.fontFaceStyle,
      weight,
    });
    ca._registeredFonts.set(dedupKey, { fontKey, fontFaceName: fontObj.fontFaceName });
  };

  /**
   * Bulk-unregister every font whose family name matches `predicate`.
   * `_scribe_*` substitute aliases are process-global; callers should
   * scope their predicate so those are not removed.
   *
   * @param {(name: string) => boolean} predicate - receives the font family
   *   name, i.e. the `fontFaceName` portion of the composite dedup key.
   */
  static unregisterFontsMatching = (predicate) => {
    if (!ca.isNode || !ca._registeredFonts) return;
    const toRemove = [];
    for (const [dedupKey, value] of ca._registeredFonts.entries()) {
      if (predicate(value.fontFaceName)) toRemove.push(dedupKey);
    }
    if (toRemove.length === 0) return;
    const CanvasNode = ca.getCanvasNodeSync();
    const keys = [];
    for (const dedupKey of toRemove) {
      const v = ca._registeredFonts.get(dedupKey);
      if (v && v.fontKey) keys.push(v.fontKey);
      ca._registeredFonts.delete(dedupKey);
    }
    if (keys.length > 0) CanvasNode.GlobalFonts.removeBatch(keys);
    if (typeof CanvasNode.GlobalFonts.clearRetired === 'function') {
      CanvasNode.GlobalFonts.clearRetired();
    }
  };
}
