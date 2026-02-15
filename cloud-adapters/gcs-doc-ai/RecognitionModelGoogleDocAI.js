/**
 * @typedef {Object} RecognitionResult
 * @property {boolean} success
 * @property {string} [rawData]
 * @property {string} format
 * @property {Error} [error]
 */

import { OcrEngineGoogleDocAI } from './ocrEngineGoogleDocAI.js';

/**
 * Google Document AI recognition model for use with Scribe.js.
 */
export class RecognitionModelGoogleDocAI {
  static config = {
    name: 'Google Doc AI',
    outputFormat: 'google_doc_ai',
  };

  /**
   * Recognize text from an image using Google Document AI.
   * @param {Uint8Array|ArrayBuffer} imageData - Image data
   * @param {Object} [options]
   * @param {string} [options.processorName] - Full Document AI processor resource name (overrides GOOGLE_DOCUMENT_AI_PROCESSOR env var).
   *    Format: projects/{project-id}/locations/{location}/processors/{processor-id}
   *    Example: projects/my-project-123/locations/us/processors/a1b2c3d4e5f6
   * @param {string} [options.mimeType] - MIME type of the document (default: 'application/pdf')
   * @param {boolean} [options.skipHumanReview] - Whether to skip human review (default: true)
   * @returns {Promise<RecognitionResult>}
   */
  static async recognizeImage(imageData, options = {}) {
    const data = imageData instanceof ArrayBuffer ? new Uint8Array(imageData) : imageData;

    const result = await OcrEngineGoogleDocAI.recognizeImage(data, options);

    if (result.success) {
      return {
        success: true,
        rawData: JSON.stringify(result.data),
        format: 'google_doc_ai',
      };
    }
    return {
      success: false,
      error: new Error(result.error),
      format: 'google_doc_ai',
    };
  }

  static async checkAvailability() {
    return { available: true };
  }
}
