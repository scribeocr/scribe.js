// Disabling eslint rules that would increase differences between Java/JavaScript versions.
/* eslint-disable no-param-reassign */

export class SVImageHandler {
  /**
   * @param {string} imgStr
   */
  static imageStrToBlob(imgStr) {
    const imgData = new Uint8Array(atob(imgStr)
      .split('')
      .map((c) => c.charCodeAt(0)));

    const imgBlob = new Blob([imgData], { type: 'application/octet-stream' });

    return imgBlob;
  }

  /**
   * @param {string} imgStr
   */
  static imageStrToBuffer(imgStr) {
    const imageBuffer = Buffer.from(imgStr, 'base64');

    return imageBuffer;
  }

  /**
   * Decode base64 image bytes to a drawable. Browser returns an ImageBitmap;
   * Node returns an `@scribe.js/canvas` Image — both are accepted by
   * `ctx.drawImage` on their respective canvas contexts.
   *
   * @param {string} img
   */
  static async readImage(img) {
    if (img === undefined) throw new Error('Input is undefined');
    if (img === null) throw new Error('Input is null');

    if (typeof process !== 'undefined') {
      const { loadImage } = await import('@scribe.js/canvas');
      return loadImage(this.imageStrToBuffer(img));
    }

    const imgBlob = this.imageStrToBlob(img);
    return createImageBitmap(imgBlob);
  }
}
