import { getJpegDimensions, getPngDimensions } from '../utils/imageUtils.js';

export class ImageWrapper {
  /**
   * @param {number} n - Page number
   * @param {?string} imageStr - Base-64 image data URL ("data:image/png..." or "data:image/jpeg..."), or `null` for a bitmap-backed wrapper (see `fromBitmap`).
   * @param {string} colorMode - Color mode ("color", "gray", or "binary").
   * @param {boolean} rotated - Whether image has been rotated.
   * @param {boolean} upscaled - Whether image has been upscaled.
   *
   * All properties of this object must be serializable, as ImageWrapper objects are sent between threads.
   * This means that no promises can be used.
   * `imageBitmap` is null on any wrapper that crosses a worker boundary.
   * It is only populated on the browser main thread.
   */
  constructor(n, imageStr, colorMode, rotated = false, upscaled = false) {
    this.n = n;
    /**
     * Base-64 data URL.
     * May be `null` on a bitmap-backed wrapper until `ensureSrc()` materializes it.
     * @type {?string}
     */
    this.src = imageStr;
    if (imageStr) {
      const format0 = /** @type {'png'|'jpeg'|undefined} */ (imageStr.match(/^data:image\/(png|jpeg)/)?.[1]);
      if (!format0 || !['png', 'jpeg'].includes(format0)) throw new Error(`Invalid image format: ${format0}`);
      /** @type {'png'|'jpeg'} */
      this.format = format0;
    } else {
      // Bitmap-backed wrapper: `src` is materialized (as PNG) on demand by `ensureSrc()`.
      this.format = 'png';
    }
    this._dims = null;
    this.rotated = rotated;
    this.upscaled = upscaled;
    this.colorMode = colorMode;
    /** @type {?ImageBitmap} */
    this.imageBitmap = null;
  }

  /**
   * Build a wrapper backed directly by a rendered `ImageBitmap` (the browser viewer render path).
   * `src` stays `null` until a non-display consumer (OCR, export) calls `ensureSrc()`, so the PNG encode is deferred off the display path.
   * @param {number} n - Page number
   * @param {ImageBitmap} imageBitmap - Rendered page pixels.
   * @param {string} colorMode - Color mode ("color", "gray", or "binary").
   * @param {boolean} [rotated] - Whether image has been rotated.
   * @param {boolean} [upscaled] - Whether image has been upscaled.
   * @returns {ImageWrapper} The bitmap-backed wrapper.
   */
  static fromBitmap(n, imageBitmap, colorMode, rotated = false, upscaled = false) {
    const img = new ImageWrapper(n, null, colorMode, rotated, upscaled);
    img.imageBitmap = imageBitmap;
    return img;
  }

  /**
   * Ensure `src` exists, materializing it (as PNG) from the backing `ImageBitmap` if this is a bitmap-backed wrapper whose bytes were never encoded.
   * Synchronous, and only valid on the browser main thread (a bitmap-backed wrapper can only exist there).
   * A no-op on a normal string-backed wrapper.
   * @returns {?string} The base-64 data URL.
   */
  ensureSrc() {
    if (this.src == null && this.imageBitmap) {
      const canvas = document.createElement('canvas');
      canvas.width = this.imageBitmap.width;
      canvas.height = this.imageBitmap.height;
      /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d')).drawImage(this.imageBitmap, 0, 0);
      this.src = canvas.toDataURL('image/png');
    }
    return this.src;
  }
}

/**
 *
 * @param {ImageWrapper} img
 * @returns {dims}
 */
const getDims = (img) => {
  if (!img._dims) {
    if (img.imageBitmap) {
      // Bitmap-backed wrapper: read dimensions off the bitmap so `src` need not be materialized.
      img._dims = { width: img.imageBitmap.width, height: img.imageBitmap.height };
    } else if (img.format === 'jpeg') {
      img._dims = getJpegDimensions(img.src);
    } else {
      img._dims = getPngDimensions(img.src);
    }
  }
  return img._dims;
};

/**
 * Checks whether existing transformations need to be undone by re-rendering raw image.
 * When an existing image has an unwanted tranformation, it is re-rendered from the original source,
 * rather than attempting to unrotate/downscale/etc. the transformed image.
 *
 * @param {(ImageWrapper|import('../containers/imageContainer.js').ImageProperties)} img
 * @param {?import('../containers/imageContainer.js').ImagePropertiesRequest|ImageWrapper} [props]
 * @returns
 */
const requiresUndo = (img, props) => {
  if (!props) return false;
  if (img.rotated && props.rotated === false) return true;
  if (img.upscaled && props.upscaled === false) return true;
  // This condition should only apply to PDFs.
  if (img.colorMode === 'color' && props.colorMode === 'gray' || img.colorMode === 'gray' && props.colorMode === 'color') return true;
  return false;
};

/**
 * Whether the image properties are compatible with the requested properties.
 * @param {ImageWrapper|import('../containers/imageContainer.js').ImageProperties} img
 * @param {?import('../containers/imageContainer.js').ImagePropertiesRequest|ImageWrapper} [props]
 * @param {boolean} [significantRotation] - Whether the page angle is enough to warrant re-rendering.
 */
const compatible = (img, props, significantRotation) => {
  if (!props) return true;
  if (props.rotated === false && img.rotated === true) {
    // Requests to unrotate an image are always respected, even if the angle is very close to 0.
    // This is because the intent may be to restore the raw user-uploaded image for an export, which should always be possible.
    return false;
  } if (props.rotated === true && img.rotated === false) {
    // An unrotated image is considered compatible with a rotated request if the angle is very close to 0.
    if (significantRotation) {
      return false;
    }
  }

  if (props.upscaled === true && img.upscaled === false || props.upscaled === false && img.upscaled === true) return false;

  // The value 'native' is used for images uploaded from the user, and is essentially a default value.
  // These cannot be considered incompatible with any color mode as the color of user-uploaded images is never edited (binarization aside).
  if (props.colorMode && props.colorMode !== img.colorMode && img.colorMode !== 'native' && img.colorMode !== 'native') return false;
  return true;
};

export const imageUtils = {
  getDims,
  requiresUndo,
  compatible,
};
