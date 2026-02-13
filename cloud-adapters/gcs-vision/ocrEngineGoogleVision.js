import { ImageAnnotatorClient } from '@google-cloud/vision';
import { Storage } from '@google-cloud/storage';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

export class OcrEngineGoogleVision {
  constructor() {
    this.name = 'google_vision';
  }

  /**
   * Recognize text from an image file synchronously.
   * @param {string} filePath - Path to the image file
   * @param {Object} [options] - (not used for Google Vision)
   */
  static recognizeFileSync = async (filePath, options = {}) => {
    try {
      const fileExtension = extname(filePath).toLowerCase();
      if (!['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'].includes(fileExtension)) {
        return {
          success: false,
          error: `Unsupported file format for sync processing: ${fileExtension}`,
          errorCode: 'UnsupportedFormat',
        };
      }
      const fileData = await readFile(filePath);
      return await this.recognizeImageSync(fileData, options);
    } catch (error) {
      return {
        success: false,
        error: error.message,
        errorCode: error.name,
      };
    }
  };

  /**
   * Recognize text from a PDF/TIFF file asynchronously.
   * @param {string} filePath - Path to the PDF/TIFF file
   * @param {Object} [options]
   * @param {string} [options.gcsBucket] - GCS bucket name
   * @param {string} [options.gcsKey] - GCS key prefix (optional, auto-generated if not provided)
   * @param {boolean} [options.keepGcsFile] - Whether to keep the uploaded GCS file after processing
   */
  static recognizeFileAsync = async (filePath, {
    gcsBucket,
    gcsKey,
    keepGcsFile = false,
  } = {}) => {
    try {
      const fileExtension = extname(filePath).toLowerCase();
      if (!['.pdf', '.tiff', '.tif'].includes(fileExtension)) {
        return {
          success: false,
          error: `Unsupported file format for async processing: ${fileExtension}`,
          errorCode: 'UnsupportedFormat',
        };
      }

      if (!gcsBucket) {
        return {
          success: false,
          error: 'GCS bucket name is required for async processing',
          errorCode: 'MissingGcsBucket',
        };
      }

      const fileData = await readFile(filePath);
      return await this.recognizeDocumentAsync(fileData, {
        gcsBucket,
        gcsKey,
        keepGcsFile,
        fileExtension,
      });
    } catch (error) {
      return {
        success: false,
        error: error.message,
        errorCode: error.name,
      };
    }
  };

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
