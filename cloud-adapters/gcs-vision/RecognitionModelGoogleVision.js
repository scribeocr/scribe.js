/**
 * @typedef {Object} RecognitionResult
 * @property {boolean} success
 * @property {string} [rawData]
 * @property {string} format
 * @property {Error} [error]
 */

import { OcrEngineGoogleVision } from './ocrEngineGoogleVision.js';

/**
 * Google Cloud Vision recognition model for use with Scribe.js.
 */
export class GoogleVisionModel {
  static config = {
    name: 'Google Vision',
    outputFormat: 'google_vision',
  };

  /**
   * Recognize text from an image using Google Cloud Vision.
   * @param {Uint8Array|ArrayBuffer} imageData - Image data
   * @param {Object} [options]
   * @returns {Promise<RecognitionResult>}
   */
  static async recognizeImage(imageData, options = {}) {
    const data = imageData instanceof ArrayBuffer ? new Uint8Array(imageData) : imageData;

    const result = await OcrEngineGoogleVision.recognizeImageSync(data, options);

    if (result.success) {
      return {
        success: true,
        rawData: JSON.stringify(result.data),
        format: 'google_vision',
      };
    }
    return {
      success: false,
      error: new Error(result.error),
      format: 'google_vision',
    };
  }

  static async checkAvailability() {
    return { available: true };
  }
}
