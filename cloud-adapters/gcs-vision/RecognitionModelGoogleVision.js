/**
 * @typedef {Object} RecognitionResult
 * @property {boolean} success
 * @property {string} [rawData]
 * @property {string} format
 * @property {Error} [error]
 */

import { ImageAnnotatorClient } from '@google-cloud/vision';
import { Storage } from '@google-cloud/storage';

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

    const result = await this.recognizeImageSync(data, options);

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

  /**
   * Recognize text from a PDF/TIFF document using Google Cloud Vision's asynchronous API.
   * @param {Uint8Array|ArrayBuffer} documentData - Document data
   * @param {Object} [options]
   * @param {string} options.gcsBucket - GCS bucket name (required)
   * @param {string} [options.gcsKey] - GCS key prefix (optional, auto-generated if not provided)
   * @param {boolean} [options.keepGcsFile=false] - Whether to keep the uploaded GCS file after processing
   * @param {string} options.fileExtension - File extension (e.g. '.pdf', '.tiff')
   * @returns {Promise<RecognitionResult>}
   */
  static async recognizeDocument(documentData, options = {}) {
    const data = documentData instanceof ArrayBuffer ? new Uint8Array(documentData) : documentData;

    const result = await this.recognizeDocumentAsync(data, {
      gcsBucket: options.gcsBucket,
      gcsKey: options.gcsKey,
      keepGcsFile: options.keepGcsFile ?? false,
      fileExtension: options.fileExtension,
    });

    if (result.success) {
      const combined = this.combineGoogleVisionAsyncResponses(result.data);
      return {
        success: true,
        rawData: JSON.stringify(combined),
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

  /**
   * Synchronous image recognition.
   * @param {Uint8Array} imageData
   * @param {Object} [options] - (not used for Google Vision)
   */
  static recognizeImageSync = async (imageData, options = {}) => {
    try {
      const visionClient = new ImageAnnotatorClient();
      const [result] = await visionClient.documentTextDetection({
        image: { content: imageData },
      });
      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        errorCode: error.name,
      };
    }
  };

  /**
   * Asynchronous PDF/TIFF recognition
   * @param {Uint8Array} fileData
   * @param {Object} options
   * @param {string} options.gcsBucket
   * @param {string} [options.gcsKey]
   * @param {boolean} [options.keepGcsFile]
   * @param {string} options.fileExtension
   */
  static recognizeDocumentAsync = async (fileData, {
    gcsBucket,
    gcsKey,
    keepGcsFile = false,
    fileExtension,
  } = {}) => {
    const visionClient = new ImageAnnotatorClient();
    const storage = new Storage();

    const finalGcsKey = gcsKey || `vision-temp/${Date.now()}-${Math.random().toString(36).substr(2, 9)}${fileExtension}`;
    const gcsUri = `gs://${gcsBucket}/${finalGcsKey}`;

    const mimeType = fileExtension === '.pdf' ? 'application/pdf' : 'image/tiff';

    try {
      console.log(`Uploading file to GCS: ${gcsUri}`);
      await storage.bucket(gcsBucket).file(finalGcsKey).save(fileData, {
        contentType: mimeType,
      });

      const [operation] = await visionClient.asyncBatchAnnotateFiles({
        requests: [
          {
            inputConfig: {
              gcsSource: {
                uri: gcsUri,
              },
              mimeType,
            },
            features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
            outputConfig: {
              gcsDestination: {
                uri: `gs://${gcsBucket}/${finalGcsKey}-output/`,
              },
              batchSize: 1,
            },
          },
        ],
      });

      console.log('Waiting for async operation to complete...');
      const [filesResponse] = await operation.promise();

      const output = filesResponse.responses[0];
      const gcsOutputUri = output.outputConfig.gcsDestination.uri;
      const prefix = gcsOutputUri.replace(`gs://${gcsBucket}/`, '');
      const [outputFiles] = await storage.bucket(gcsBucket).getFiles({ prefix });

      const outputContentP = outputFiles.map((file) => file.download());
      const outputContent = await Promise.all(outputContentP);
      const result = outputContent.map((content) => JSON.parse(content.toString()));

      if (!keepGcsFile) {
        console.log(`Cleaning up GCS output files with prefix: ${prefix}`);
        await Promise.all(outputFiles.map((file) => file.delete()));
      }

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        errorCode: error.name,
      };
    } finally {
      if (!keepGcsFile) {
        try {
          console.log(`Cleaning up GCS file: ${gcsUri}`);
          await storage.bucket(gcsBucket).file(finalGcsKey).delete();
        } catch (cleanupError) {
          console.warn(`Failed to clean up GCS file: ${cleanupError.message}`);
        }
      }
    }
  };

  /**
   * Combines output from the asynchronous Google Vision API into a single object.
   * @param {Array<Object>} responses
   */
  static combineGoogleVisionAsyncResponses = (responses) => {
    if (!responses || responses.length === 0) {
      throw new Error('No responses to combine.');
    }

    const combined = JSON.parse(JSON.stringify(responses[0]));

    for (let i = 1; i < responses.length; i++) {
      if (responses[i]?.responses) {
        combined.responses.push(
          ...JSON.parse(JSON.stringify(responses[i].responses)),
        );
      }
    }

    return combined;
  };
}
