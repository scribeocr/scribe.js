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
  StartDocumentTextDetectionCommand,
  StartDocumentAnalysisCommand,
  GetDocumentTextDetectionCommand,
  GetDocumentAnalysisCommand,
} from '@aws-sdk/client-textract';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

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

    const result = await this.recognizeImageSync(data, {
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

  /**
   * Recognize text from a PDF document using AWS Textract's asynchronous API.
   * @param {Uint8Array|ArrayBuffer} documentData - PDF data
   * @param {Object} [options]
   * @param {boolean} [options.analyzeLayout=false] - Whether to enable layout analysis.
   * @param {boolean} [options.analyzeLayoutTables=false] - Whether to enable table analysis.
   * @param {string} options.s3Bucket - S3 bucket name (required)
   * @param {string} [options.s3Key] - S3 key prefix (optional, auto-generated if not provided)
   * @param {boolean} [options.keepS3File=false] - Whether to keep the uploaded S3 file after processing
   * @param {number} [options.pollingInterval=5000] - Polling interval in milliseconds
   * @param {number} [options.maxWaitTime=1800000] - Maximum wait time in milliseconds (default: 30 minutes)
   * @returns {Promise<RecognitionResult>}
   */
  static async recognizeDocument(documentData, options = {}) {
    const data = documentData instanceof ArrayBuffer ? new Uint8Array(documentData) : documentData;

    const result = await this.recognizePdfAsync(data, {
      analyzeLayout: options.analyzeLayout ?? false,
      analyzeLayoutTables: options.analyzeLayoutTables ?? false,
      s3Bucket: options.s3Bucket,
      s3Key: options.s3Key,
      keepS3File: options.keepS3File ?? false,
      pollingInterval: options.pollingInterval ?? 5000,
      maxWaitTime: options.maxWaitTime ?? 1800000,
    });

    if (result.success) {
      const combined = this.combineTextractAsyncResponses(result.data);
      return {
        success: true,
        rawData: JSON.stringify(combined),
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

  /**
   * Synchronous image recognition.
   * @param {Uint8Array} imageData
   * @param {Object} options
   */
  static recognizeImageSync = async (imageData, {
    analyzeLayout = false,
    analyzeLayoutTables = false,
  } = {}) => {
    try {
      const textractClient = new TextractClient({
        region: process.env.AWS_REGION || 'us-east-1',
      });

      let command;
      if (analyzeLayout) {
        const FeatureTypes = analyzeLayoutTables ? ['TABLES'] : ['LAYOUT'];
        command = new AnalyzeDocumentCommand({
          Document: { Bytes: imageData },
          FeatureTypes,
        });
      } else {
        command = new DetectDocumentTextCommand({
          Document: { Bytes: imageData },
        });
      }

      const response = await textractClient.send(command);
      return { success: true, data: response };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        errorCode: error.name,
      };
    }
  };

  /**
   * Asynchronous PDF recognition
   * @param {Uint8Array} pdfData
   * @param {Object} options
   */
  static recognizePdfAsync = async (pdfData, {
    analyzeLayout = false,
    analyzeLayoutTables = false,
    s3Bucket,
    s3Key,
    keepS3File = false,
    pollingInterval = 5000,
    maxWaitTime = 1800000,
  } = {}) => {
    const textractClient = new TextractClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });

    const s3Client = new S3Client({
      region: process.env.AWS_REGION || 'us-east-1',
    });

    const finalS3Key = s3Key || `textract-temp/${Date.now()}-${Math.random().toString(36).substr(2, 9)}.pdf`;

    try {
      console.log(`Uploading PDF to S3: s3://${s3Bucket}/${finalS3Key}`);
      await s3Client.send(new PutObjectCommand({
        Bucket: s3Bucket,
        Key: finalS3Key,
        Body: pdfData,
        ContentType: 'application/pdf',
      }));

      let startCommand;

      if (analyzeLayout) {
        const FeatureTypes = [];
        if (analyzeLayoutTables) FeatureTypes.push('TABLES');
        if (!analyzeLayoutTables) FeatureTypes.push('LAYOUT');

        startCommand = new StartDocumentAnalysisCommand({
          DocumentLocation: {
            S3Object: {
              Bucket: s3Bucket,
              Name: finalS3Key,
            },
          },
          FeatureTypes,
        });
      } else {
        startCommand = new StartDocumentTextDetectionCommand({
          DocumentLocation: {
            S3Object: {
              Bucket: s3Bucket,
              Name: finalS3Key,
            },
          },
        });
      }

      console.log('Starting Textract job...');
      const startResponse = await textractClient.send(startCommand);
      const jobId = startResponse.JobId;
      console.log(`Job started with ID: ${jobId}`);

      const result = await this.pollForCompletion(
        textractClient,
        jobId,
        analyzeLayout,
        pollingInterval,
        maxWaitTime,
      );

      return result;
    } catch (error) {
      return {
        success: false,
        error: error.message,
        errorCode: error.name,
      };
    } finally {
      if (!keepS3File) {
        try {
          console.log(`Cleaning up S3 file: s3://${s3Bucket}/${finalS3Key}`);
          await s3Client.send(new DeleteObjectCommand({
            Bucket: s3Bucket,
            Key: finalS3Key,
          }));
        } catch (cleanupError) {
          console.warn(`Failed to clean up S3 file: ${cleanupError.message}`);
        }
      }
    }
  };

  /**
   * Poll for job completion
   * @param {TextractClient} textractClient
   * @param {string} jobId
   * @param {boolean} isAnalysis
   * @param {number} pollingInterval
   * @param {number} maxWaitTime
   */
  static pollForCompletion = async (textractClient, jobId, isAnalysis, pollingInterval, maxWaitTime) => {
    const startTime = Date.now();
    let nextToken = null;
    const allResponses = [];

    while (Date.now() - startTime < maxWaitTime) {
      try {
        let getCommand;
        if (isAnalysis) {
          getCommand = new GetDocumentAnalysisCommand({
            JobId: jobId,
            NextToken: nextToken,
          });
        } else {
          getCommand = new GetDocumentTextDetectionCommand({
            JobId: jobId,
            NextToken: nextToken,
          });
        }

        const response = await textractClient.send(getCommand);

        if (response.JobStatus === 'SUCCEEDED') {
          allResponses.push(response);

          if (response.NextToken) {
            nextToken = response.NextToken;
            continue;
          } else {
            return {
              success: true,
              data: allResponses,
            };
          }
        } else if (response.JobStatus === 'FAILED') {
          return {
            success: false,
            error: response.StatusMessage || 'Textract job failed',
            errorCode: 'TextractJobFailed',
          };
        } else if (response.JobStatus === 'IN_PROGRESS') {
          console.log(`Job still in progress... (${Math.round((Date.now() - startTime) / 1000)}s elapsed)`);
          await new Promise((resolve) => setTimeout(resolve, pollingInterval));
        }
      } catch (error) {
        if (error.name === 'InvalidJobIdException') {
          return {
            success: false,
            error: 'Invalid job ID or job expired',
            errorCode: 'InvalidJobId',
          };
        }
        throw error;
      }
    }

    return {
      success: false,
      error: `Job timed out after ${maxWaitTime / 1000} seconds`,
      errorCode: 'Timeout',
    };
  };

  /**
   * Combines multiple paginated responses from an asynchronous Textract job into a single response object.
   * @param {Array<Object>} responses - An array of response objects from GetDocumentAnalysisCommand or GetDocumentTextDetectionCommand.
   * @returns {Object} A single, combined response object.
   */
  static combineTextractAsyncResponses = (responses) => {
    if (!responses || responses.length === 0) {
      return {};
    }

    const combined = {
      Blocks: [],
      Warnings: [],
    };

    let documentMetadata = null;

    for (const response of responses) {
      if (response.Blocks) {
        combined.Blocks.push(...response.Blocks);
      }
      if (response.Warnings) {
        combined.Warnings.push(...response.Warnings);
      }
      if (response.DocumentMetadata && !documentMetadata) {
        documentMetadata = response.DocumentMetadata;
      }
    }

    if (documentMetadata) {
      combined.DocumentMetadata = documentMetadata;
    }

    // Carry over other relevant top-level fields from the first response, except for pagination tokens.
    const template = { ...responses[0] };
    delete template.Blocks;
    delete template.Warnings;
    delete template.NextToken;

    return { ...template, ...combined };
  };
}
