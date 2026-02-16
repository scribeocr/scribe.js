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

    const result = await this.recognizeImageRaw(data, options);

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

  /**
   * Recognize text from a document using Azure Document Intelligence.
   * Azure handles PDFs inline (as base64), so this delegates to the same underlying method as recognizeImage.
   * @param {Uint8Array|ArrayBuffer} documentData - Document data (PDF, image, etc.)
   * @param {Object} [options]
   * @param {string} [options.endpoint] - Azure endpoint (overrides AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT env var)
   * @param {string} [options.key] - Azure API key (overrides AZURE_DOCUMENT_INTELLIGENCE_KEY env var)
   * @param {string} [options.modelId] - Azure model ID (default: 'prebuilt-read')
   * @returns {Promise<RecognitionResult>}
   */
  static async recognizeDocument(documentData, options = {}) {
    return this.recognizeImage(documentData, options);
  }

  static async checkAvailability() {
    return { available: true };
  }

  /**
   * Recognize text from image/document data.
   * Sends the data as base64 to Azure Document Intelligence and polls until completion.
   * @param {Uint8Array} imageData - File data as bytes
   * @param {Object} [options]
   * @param {string} [options.endpoint] - Azure endpoint (overrides AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT env var)
   * @param {string} [options.key] - Azure API key (overrides AZURE_DOCUMENT_INTELLIGENCE_KEY env var)
   * @param {string} [options.modelId] - Azure model ID (default: 'prebuilt-read')
   */
  static recognizeImageRaw = async (imageData, options = {}) => {
    const endpoint = options.endpoint || process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
    const key = options.key || process.env.AZURE_DOCUMENT_INTELLIGENCE_KEY;
    const modelId = options.modelId || 'prebuilt-read';

    if (!endpoint) {
      return {
        success: false,
        error: 'Azure endpoint is required. Set AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT or pass options.endpoint.',
        errorCode: 'MissingEndpoint',
      };
    }

    if (!key) {
      return {
        success: false,
        error: 'Azure API key is required. Set AZURE_DOCUMENT_INTELLIGENCE_KEY or pass options.key.',
        errorCode: 'MissingKey',
      };
    }

    try {
      const client = DocumentIntelligence(endpoint, { key });

      const base64Source = Buffer.from(imageData).toString('base64');

      const initialResponse = await client
        .path('/documentModels/{modelId}:analyze', modelId)
        .post({
          contentType: 'application/json',
          body: { base64Source },
        });

      if (isUnexpected(initialResponse)) {
        return {
          success: false,
          error: initialResponse.body.error?.message || 'Unexpected response from Azure Document Intelligence',
          errorCode: initialResponse.body.error?.code || 'UnexpectedResponse',
        };
      }

      const poller = getLongRunningPoller(client, initialResponse);
      const result = (await poller.pollUntilDone()).body;

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        errorCode: error.name,
      };
    }
  };
}
