/**
 * @typedef {Object} RecognitionResult
 * @property {boolean} success
 * @property {string} [rawData]
 * @property {string} format
 * @property {Error} [error]
 */

import { OcrEngineAzureDocIntel } from './ocrEngineAzureDocIntel.js';

/**
 * Azure Document Intelligence recognition model for use with Scribe.js.
 */
export class RecognitionModelAzureDocIntel {
  static config = {
    name: 'Azure Document Intelligence',
    outputFormat: 'azure_doc_intel',
  };

  /**
   * Recognize text from an image using Azure Document Intelligence.
   * @param {Uint8Array|ArrayBuffer} imageData - Image data
   * @param {Object} [options]
   * @param {string} [options.endpoint] - Azure endpoint (overrides AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT env var)
   * @param {string} [options.key] - Azure API key (overrides AZURE_DOCUMENT_INTELLIGENCE_KEY env var)
   * @param {string} [options.modelId] - Azure model ID (default: 'prebuilt-read')
   * @returns {Promise<RecognitionResult>}
   */
  static async recognizeImage(imageData, options = {}) {
    const data = imageData instanceof ArrayBuffer ? new Uint8Array(imageData) : imageData;

    const result = await OcrEngineAzureDocIntel.recognizeImage(data, options);

    if (result.success) {
      return {
        success: true,
        rawData: JSON.stringify(result.data),
        format: 'azure_doc_intel',
      };
    }
    return {
      success: false,
      error: new Error(result.error),
      format: 'azure_doc_intel',
    };
  }

  static async checkAvailability() {
    return { available: true };
  }
}
