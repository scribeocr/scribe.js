/**
 * @typedef {Object} RecognitionResult
 * @property {boolean} success
 * @property {string} [rawData]
 * @property {string} format
 * @property {Error} [error]
 */

import DocumentIntelligence, { getLongRunningPoller, isUnexpected } from '@azure-rest/ai-document-intelligence';

/**
 * Azure Document Intelligence recognition model for use with Scribe.js.
 */
export class RecognitionModelAzureDocIntel {
  static config = {
    name: 'Azure Document Intelligence',
    outputFormat: 'azure_doc_intel',
  };

  /**
   * Recognize text from an image or document using Azure Document Intelligence.
   * Sends the data as base64 and polls until completion.
   * @param {Uint8Array|ArrayBuffer} imageData - Image or document data
   * @param {Object} [options]
   * @param {string} [options.endpoint] - Azure endpoint (overrides SCRIBE_AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT env var)
   * @param {string} [options.key] - Azure API key (overrides SCRIBE_AZURE_DOCUMENT_INTELLIGENCE_KEY env var)
   * @param {string} [options.modelId] - Azure model ID (default: 'prebuilt-read')
   * @returns {Promise<RecognitionResult>}
   */
  static async recognizeImage(imageData, options = {}) {
    const data = imageData instanceof ArrayBuffer ? new Uint8Array(imageData) : imageData;
    const endpoint = options.endpoint || process.env.SCRIBE_AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
    const key = options.key || process.env.SCRIBE_AZURE_DOCUMENT_INTELLIGENCE_KEY;
    const modelId = options.modelId || 'prebuilt-read';

    if (!endpoint) {
      return {
        success: false,
        error: new Error('Azure endpoint is required. Set SCRIBE_AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT or pass options.endpoint.'),
        format: 'azure_doc_intel',
      };
    }

    if (!key) {
      return {
        success: false,
        error: new Error('Azure API key is required. Set SCRIBE_AZURE_DOCUMENT_INTELLIGENCE_KEY or pass options.key.'),
        format: 'azure_doc_intel',
      };
    }

    try {
      const client = DocumentIntelligence(endpoint, { key });

      const base64Source = Buffer.from(data).toString('base64');

      const initialResponse = await client
        .path('/documentModels/{modelId}:analyze', modelId)
        .post({
          contentType: 'application/json',
          body: { base64Source },
        });

      if (isUnexpected(initialResponse)) {
        return {
          success: false,
          error: new Error(initialResponse.body.error?.message || 'Unexpected response from Azure Document Intelligence'),
          format: 'azure_doc_intel',
        };
      }

      const poller = getLongRunningPoller(client, initialResponse);
      const result = (await poller.pollUntilDone()).body;

      return {
        success: true,
        rawData: JSON.stringify(result),
        format: 'azure_doc_intel',
      };
    } catch (error) {
      return {
        success: false,
        error,
        format: 'azure_doc_intel',
      };
    }
  }

  /**
   * Recognize text from a document using Azure Document Intelligence.
   * Azure handles PDFs inline (as base64), so this delegates to recognizeImage.
   * @param {Uint8Array|ArrayBuffer} documentData - Document data (PDF, image, etc.)
   * @param {Object} [options]
   * @param {string} [options.endpoint] - Azure endpoint (overrides SCRIBE_AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT env var)
   * @param {string} [options.key] - Azure API key (overrides SCRIBE_AZURE_DOCUMENT_INTELLIGENCE_KEY env var)
   * @param {string} [options.modelId] - Azure model ID (default: 'prebuilt-read')
   * @returns {Promise<RecognitionResult>}
   */
  static async recognizeDocument(documentData, options = {}) {
    return this.recognizeImage(documentData, options);
  }

  static async checkAvailability() {
    return { available: true };
  }
}
