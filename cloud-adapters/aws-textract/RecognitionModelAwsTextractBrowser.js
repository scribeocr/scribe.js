/**
 * @typedef {Object} RecognitionResult
 * @property {boolean} success
 * @property {string} [rawData]
 * @property {string} format
 * @property {Error} [error]
 */

import {
  TextractClient,
  DetectDocumentTextCommand,
  AnalyzeDocumentCommand,
} from './aws-textract.esm.bundle.min.js';

/**
 * Browser-compatible AWS Textract recognition model for use with Scribe.js.
 * Imports from a pre-bundled ESM file so no bare-specifier resolution is needed.
 * Supports synchronous (single-image) recognition only.
 */
export class RecognitionModelTextractBrowser {
  static config = {
    name: 'AWS Textract',
    outputFormat: 'textract',
  };

  /**
   * Recognize text from an image using AWS Textract.
   *
   * @param {Uint8Array|ArrayBuffer} imageData - Image data
   * @param {Object} [options]
   * @param {boolean} [options.analyzeLayout=false] - Whether to enable layout analysis.
   * @param {boolean} [options.analyzeTables=false] - Whether to enable table analysis.
   *    Enabling table analysis automatically enables layout analysis.
   * @param {string} [options.region] - AWS region (e.g. 'us-east-1').
   * @param {{accessKeyId: string, secretAccessKey: string, sessionToken?: string}} [options.credentials] - AWS credentials.
   * @returns {Promise<RecognitionResult>}
   */
  static async recognizeImage(imageData, options = {}) {
    const data = imageData instanceof ArrayBuffer ? new Uint8Array(imageData) : imageData;
    const analyzeTables = options.analyzeTables ?? false;
    const analyzeLayout = options.analyzeLayout ?? false;
    const region = options.region || undefined;
    const credentials = options.credentials || undefined;

    try {
      const textractClient = new TextractClient({
        ...(region && { region }),
        ...(credentials && { credentials }),
      });

      let command;
      if (analyzeLayout || analyzeTables) {
        const FeatureTypes = [];
        if (analyzeLayout) FeatureTypes.push('LAYOUT');
        if (analyzeTables) FeatureTypes.push('TABLES');
        command = new AnalyzeDocumentCommand({
          Document: { Bytes: data },
          FeatureTypes,
        });
      } else {
        command = new DetectDocumentTextCommand({
          Document: { Bytes: data },
        });
      }

      const response = await textractClient.send(command);
      return {
        success: true,
        rawData: JSON.stringify(response),
        format: 'textract',
      };
    } catch (error) {
      return {
        success: false,
        error,
        format: 'textract',
      };
    }
  }

  static async checkAvailability() {
    return { available: true };
  }
}
