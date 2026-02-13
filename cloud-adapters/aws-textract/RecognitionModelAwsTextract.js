/**
 * @typedef {Object} RecognitionResult
 * @property {boolean} success
 * @property {string} [rawData]
 * @property {string} format
 * @property {Error} [error]
 */

import { OcrEngineAWSTextract } from './ocrEngineAwsTextract.js';

/**
 * AWS Textract recognition model for use with Scribe.js.
 */
export class RecognitionModelTextract {
  static config = {
    name: 'AWS Textract',
    outputFormat: 'textract',
  };

  /**
   * Recognize text from an image using AWS Textract.
   * @param {Uint8Array|ArrayBuffer} imageData - Image data
   * @param {Object} [options]
   * @param {boolean} [options.analyzeLayout=false] - Whether to enable layout analysis.
   *    Note that enabling layout analysis increases AWS costs.
   * @param {boolean} [options.analyzeLayoutTables=false] - Whether to enable table analysis.
   *    Enabling table analysis automatically enables layout analysis.
   *    Note that enabling table analysis significantly increases AWS costs.
   * @returns {Promise<RecognitionResult>}
   */
  static async recognizeImage(imageData, options = {}) {
    const data = imageData instanceof ArrayBuffer ? new Uint8Array(imageData) : imageData;

    const result = await OcrEngineAWSTextract.recognizeImageSync(data, {
      analyzeLayout: options.analyzeLayout ?? false,
      analyzeLayoutTables: options.analyzeLayoutTables ?? false,
    });

    if (result.success) {
      return {
        success: true,
        rawData: JSON.stringify(result.data),
        format: 'textract',
      };
    }
    return {
      success: false,
      error: new Error(result.error),
      format: 'textract',
    };
  }

  static async checkAvailability() {
    return { available: true };
  }
}
