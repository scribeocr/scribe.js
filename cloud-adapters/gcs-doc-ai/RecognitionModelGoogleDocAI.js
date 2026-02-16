/**
 * @typedef {Object} RecognitionResult
 * @property {boolean} success
 * @property {string} [rawData]
 * @property {string} format
 * @property {Error} [error]
 */

import { DocumentProcessorServiceClient } from '@google-cloud/documentai';
import { Storage } from '@google-cloud/storage';

export const MIME_TYPES = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * Extracts the resource name from a processor value that may be either a bare resource name
 * or a full endpoint URL (e.g. https://us-documentai.googleapis.com/v1/projects/.../processors/...).
 * @param {string} processorValue
 * @returns {{ processorName: string, apiEndpoint: string }}
 */
function parseProcessorValue(processorValue) {
  const resourceMatch = processorValue.match(/(projects\/[^/]+\/locations\/([^/]+)\/processors\/[^/:\s]+(?:\/processorVersions\/[^/:\s]+)?)/);
  if (!resourceMatch) {
    throw new Error(`Cannot parse processor resource name from: ${processorValue}. `
      + 'Expected format: projects/{project-id}/locations/{location}/processors/{processor-id}');
  }
  return {
    processorName: resourceMatch[1],
    apiEndpoint: `${resourceMatch[2]}-documentai.googleapis.com`,
  };
}

/**
 * Merges multiple Document AI output shards into a single document.
 * Each shard contains its own `text`, `pages`, and `shardInfo` (with `shardIndex`, `shardCount`, `textOffset`).
 * TextAnchor indices within each shard are relative to that shard's `text` field.
 * When merging, we concatenate text and offset the textAnchor indices for later shards.
 * @param {Array<Object>} shards - Array of parsed shard JSON objects
 * @returns {Object} Merged document
 */
function mergeShards(shards) {
  if (shards.length === 1) return shards[0];

  // Sort by shardIndex (falling back to textOffset or original order)
  shards.sort((a, b) => {
    const aIdx = parseInt(a.shardInfo?.shardIndex || '0', 10);
    const bIdx = parseInt(b.shardInfo?.shardIndex || '0', 10);
    return aIdx - bIdx;
  });

  const merged = {
    ...shards[0],
    pages: [],
    text: '',
  };
  delete merged.shardInfo;

  for (const shard of shards) {
    const textOffset = merged.text.length;

    if (textOffset > 0) {
      // Offset all textAnchor indices in this shard's pages
      offsetTextAnchors(shard.pages, textOffset);
    }

    merged.text += shard.text || '';
    merged.pages.push(...(shard.pages || []));
  }

  return merged;
}

/**
 * Recursively adjusts all textAnchor.textSegments startIndex/endIndex values by the given offset.
 * @param {*} obj - Object or array to traverse
 * @param {number} offset - Offset to add to indices
 */
function offsetTextAnchors(obj, offset) {
  if (!obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      offsetTextAnchors(item, offset);
    }
    return;
  }

  if (obj.textAnchor?.textSegments) {
    for (const seg of obj.textAnchor.textSegments) {
      // Proto3 omits fields with default value 0, so missing startIndex/endIndex means 0.
      seg.startIndex = String((parseInt(seg.startIndex || '0', 10)) + offset);
      seg.endIndex = String((parseInt(seg.endIndex || '0', 10)) + offset);
    }
  }

  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      offsetTextAnchors(value, offset);
    }
  }
}

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

    const result = await this.recognizeImageRaw(data, options);

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

  /**
   * Recognize text from a document using Google Document AI.
   * Document AI handles PDFs inline (up to 20MB), so this delegates to the same underlying method as recognizeImage.
   * For documents exceeding 20MB, use recognizeDocumentAsync with a GCS bucket.
   * @param {Uint8Array|ArrayBuffer} documentData - Document data
   * @param {Object} [options]
   * @param {string} [options.processorName] - Full Document AI processor resource name (overrides GOOGLE_DOCUMENT_AI_PROCESSOR env var).
   * @param {string} [options.mimeType] - MIME type of the document (default: 'application/pdf')
   * @param {boolean} [options.skipHumanReview] - Whether to skip human review (default: true)
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
   * Sends the data inline to Google Document AI's processDocument endpoint.
   * @param {Uint8Array} imageData - File data as bytes
   * @param {Object} [options]
   * @param {string} [options.processorName] - Full Document AI processor resource name (overrides GOOGLE_DOC_AI_PROCESSOR env var).
   *    Format: projects/{project-id}/locations/{location}/processors/{processor-id}
   *    Example: projects/my-project-123/locations/us/processors/a1b2c3d4e5f6
   * @param {string} [options.mimeType] - MIME type of the document (default: 'application/pdf')
   * @param {boolean} [options.skipHumanReview] - Whether to skip human review (default: true)
   * @param {Object} [options.fieldMask] - Field mask to limit response fields
   */
  static recognizeImageRaw = async (imageData, options = {}) => {
    const processorName = options.processorName || process.env.GOOGLE_DOC_AI_PROCESSOR;
    const mimeType = options.mimeType || 'application/pdf';
    const skipHumanReview = options.skipHumanReview ?? true;

    if (!processorName) {
      return {
        success: false,
        error: 'Processor name is required. Set GOOGLE_DOC_AI_PROCESSOR env var or pass options.processorName. '
          + 'Format: projects/{project-id}/locations/{location}/processors/{processor-id}',
        errorCode: 'MissingProcessorName',
      };
    }

    try {
      const parsed = parseProcessorValue(processorName);
      const client = new DocumentProcessorServiceClient({ apiEndpoint: parsed.apiEndpoint });

      const request = {
        name: parsed.processorName,
        rawDocument: {
          content: Buffer.from(imageData).toString('base64'),
          mimeType,
        },
        skipHumanReview,
      };

      if (options.fieldMask) {
        request.fieldMask = options.fieldMask;
      }

      const [result] = await client.processDocument(request);

      return { success: true, data: result.document };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        errorCode: error.name,
      };
    }
  };

  /**
   * Recognize text from document data using async batch processing via GCS.
   * Uploads the data to GCS, runs batch processing, downloads results, and cleans up.
   * Use this for documents that exceed the 20MB inline limit.
   * @param {Uint8Array} documentData - Document data as bytes
   * @param {Object} options
   * @param {string} options.gcsBucket - GCS bucket name for temporary storage
   * @param {string} [options.gcsKey] - GCS key prefix (auto-generated if not provided)
   * @param {boolean} [options.keepGcsFile] - Whether to keep GCS artifacts after processing (default: false)
   * @param {string} [options.mimeType] - MIME type of the document (default: 'application/pdf')
   * @param {string} [options.processorName] - Full Document AI processor resource name (overrides GOOGLE_DOC_AI_PROCESSOR env var).
   * @param {boolean} [options.skipHumanReview] - Whether to skip human review (default: true)
   */
  static recognizeDocumentAsync = async (documentData, options = {}) => {
    const {
      gcsBucket,
      gcsKey,
      keepGcsFile = false,
    } = options;

    const processorName = options.processorName || process.env.GOOGLE_DOC_AI_PROCESSOR;
    const mimeType = options.mimeType || 'application/pdf';

    if (!processorName) {
      return {
        success: false,
        error: 'Processor name is required. Set GOOGLE_DOC_AI_PROCESSOR env var or pass options.processorName. '
          + 'Format: projects/{project-id}/locations/{location}/processors/{processor-id}',
        errorCode: 'MissingProcessorName',
      };
    }

    if (!gcsBucket) {
      return {
        success: false,
        error: 'GCS bucket name is required for async processing. Pass options.gcsBucket or use --gcs-bucket.',
        errorCode: 'MissingGcsBucket',
      };
    }

    const storage = new Storage();
    const parsed = parseProcessorValue(processorName);

    // Derive a file extension from the MIME type for the GCS key
    const extForMime = Object.entries(MIME_TYPES).find(([, mime]) => mime === mimeType);
    const fileExtension = extForMime ? extForMime[0] : '.pdf';
    const finalGcsKey = gcsKey || `document-ai-temp/${Date.now()}-${Math.random().toString(36).substr(2, 9)}${fileExtension}`;
    const gcsInputUri = `gs://${gcsBucket}/${finalGcsKey}`;
    const outputPrefix = `${finalGcsKey}-output/`;
    const gcsOutputUri = `gs://${gcsBucket}/${outputPrefix}`;

    try {
      console.log(`Uploading file to GCS: ${gcsInputUri}`);
      await storage.bucket(gcsBucket).file(finalGcsKey).save(documentData, {
        contentType: mimeType,
      });

      const client = new DocumentProcessorServiceClient({ apiEndpoint: parsed.apiEndpoint });

      const request = {
        name: parsed.processorName,
        inputDocuments: {
          gcsDocuments: {
            documents: [{ gcsUri: gcsInputUri, mimeType }],
          },
        },
        documentOutputConfig: {
          gcsOutputConfig: {
            gcsUri: gcsOutputUri,
          },
        },
        skipHumanReview: options.skipHumanReview ?? true,
      };

      console.log('Starting Document AI batch processing...');
      const [operation] = await client.batchProcessDocuments(request);

      console.log('Waiting for batch operation to complete...');
      await operation.promise();

      const [outputFiles] = await storage.bucket(gcsBucket).getFiles({ prefix: outputPrefix });

      if (!outputFiles.length) {
        return { success: false, error: 'No output files found in GCS after batch processing.', errorCode: 'NoOutput' };
      }

      // Download all output files (shards) and merge them into a single document.
      // Google Document AI splits large documents into multiple shards, each with its own
      // text, pages, and shardInfo (shardIndex, shardCount, textOffset).
      const shards = [];
      for (const file of outputFiles) {
        const [content] = await file.download();
        shards.push(JSON.parse(content.toString()));
      }

      const data = mergeShards(shards);

      if (!keepGcsFile) {
        console.log(`Cleaning up GCS output files with prefix: ${outputPrefix}`);
        await Promise.all(outputFiles.map((file) => file.delete()));
      }

      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        errorCode: error.name,
      };
    } finally {
      if (!keepGcsFile) {
        try {
          console.log(`Cleaning up GCS input file: ${gcsInputUri}`);
          await storage.bucket(gcsBucket).file(finalGcsKey).delete();
        } catch (cleanupError) {
          console.warn(`Failed to clean up GCS file: ${cleanupError.message}`);
        }
      }
    }
  };
}
