import DocumentIntelligence, { getLongRunningPoller, isUnexpected } from '@azure-rest/ai-document-intelligence';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

export class OcrEngineAzureDocIntel {
  constructor() {
    this.name = 'azure_doc_intel';
  }

  /**
   * Recognize text from a file.
   * Azure Document Intelligence accepts all supported file types inline (as base64),
   * so no cloud storage upload is needed regardless of format.
   * @param {string} filePath - Path to the file
   * @param {Object} [options]
   * @param {string} [options.endpoint] - Azure endpoint (overrides AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT env var)
   * @param {string} [options.key] - Azure API key (overrides AZURE_DOCUMENT_INTELLIGENCE_KEY env var)
   * @param {string} [options.modelId] - Azure model ID (default: 'prebuilt-read')
   */
  static recognizeFile = async (filePath, options = {}) => {
    try {
      const fileExtension = extname(filePath).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.pdf'].includes(fileExtension)) {
        return {
          success: false,
          error: `Unsupported file format: ${fileExtension}`,
          errorCode: 'UnsupportedFormat',
        };
      }
      const fileData = new Uint8Array(await readFile(filePath));
      return await this.recognizeImage(fileData, options);
    } catch (error) {
      return {
        success: false,
        error: error.message,
        errorCode: error.name,
      };
    }
  };

  /**
   * Recognize text from image/document data.
   * Sends the data as base64 to Azure Document Intelligence and polls until completion.
   * @param {Uint8Array} imageData - File data as bytes
   * @param {Object} [options]
   * @param {string} [options.endpoint] - Azure endpoint (overrides AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT env var)
   * @param {string} [options.key] - Azure API key (overrides AZURE_DOCUMENT_INTELLIGENCE_KEY env var)
   * @param {string} [options.modelId] - Azure model ID (default: 'prebuilt-read')
   */
  static recognizeImage = async (imageData, options = {}) => {
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
