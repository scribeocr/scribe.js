import { getJpegDimensions, getPngDimensions } from '../utils/imageUtils.js';

export class ImageWrapper {
  /**
   * @param {number} n - Page number
   * @param {string} imageStr - Base-64 encoded image string. Should start with "data:image/png" or "data:image/jpeg".
   * @param {string} colorMode - Color mode ("color", "gray", or "binary").
   * @param {boolean} rotated - Whether image has been rotated.
   * @param {boolean} upscaled - Whether image has been upscaled.
   *
   * All properties of this object must be serializable, as ImageWrapper objects are sent between threads.
   * This means that no promises can be used.
   */
  constructor(n, imageStr, colorMode, rotated = false, upscaled = false) {
    this.n = n;
    this.src = imageStr;
    const format0 = imageStr.match(/^data:image\/(png|jpeg)/)?.[1];
    if (!format0 || !['png', 'jpeg'].includes(format0)) throw new Error(`Invalid image format: ${format0}`);
    this.format = format0;
    this._dims = null;
    this.rotated = rotated;
    this.upscaled = upscaled;
    this.colorMode = colorMode;
    /** @type {?ImageBitmap} */
    this.imageBitmap = null;
  }
}

/**
 *
 * @param {import('../containers/imageContainer.js').ImageWrapper} img
 * @returns {dims}
 */
const getDims = (img) => {
  if (!img._dims) {
    if (img.format === 'jpeg') {
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
