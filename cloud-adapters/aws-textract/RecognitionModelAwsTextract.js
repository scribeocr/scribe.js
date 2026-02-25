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
    rateLimit: { tps: 1 },
  };

  static isThrottlingError(error) {
    return error?.$metadata?.httpStatusCode === 429
      || error?.name === 'ThrottlingException'
      || error?.name === 'ProvisionedThroughputExceededException'
      || error?.name === 'LimitExceededException';
  }

  /**
   * Recognize text from an image using AWS Textract.
   *
   * Region is resolved in this order:
   * 1. `options.region` — explicit region string
   * 2. Standard AWS SDK resolution: `AWS_REGION` env var → `AWS_DEFAULT_REGION` → `~/.aws/config`
   *
   * Credentials are resolved in this order:
   * 1. `options.credentials` — explicit `{ accessKeyId, secretAccessKey }` object
   * 2. Standard AWS SDK credential chain:
   *    - `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` env vars
   *    - `~/.aws/credentials` file (with optional `AWS_PROFILE`)
   *    - IAM role (when running on EC2/ECS/Lambda)
   *
   * @param {Uint8Array|ArrayBuffer} imageData - Image data
   * @param {Object} [options]
   * @param {boolean} [options.analyzeLayout=false] - Whether to enable layout analysis.
   *    Note that enabling layout analysis increases AWS costs.
   * @param {boolean} [options.analyzeTables=false] - Whether to enable table analysis.
   *    Enabling table analysis automatically enables layout analysis.
   *    Note that enabling table analysis significantly increases AWS costs.
   * @param {string} [options.region] - AWS region (e.g. 'us-east-1').
   *    If not provided, the SDK resolves from AWS_REGION env var, ~/.aws/config, or instance metadata.
   * @param {{accessKeyId: string, secretAccessKey: string}} [options.credentials] - AWS credentials.
   *    If not provided, the standard AWS SDK credential chain is used.
   * @returns {Promise<RecognitionResult>}
   */
  static async recognizeImage(imageData, options = {}) {
    const data = imageData instanceof ArrayBuffer ? new Uint8Array(imageData) : imageData;
    const analyzeLayout = options.analyzeLayout ?? false;
    const analyzeTables = options.analyzeTables ?? false;
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

  /**
   * Recognize text from a PDF document using AWS Textract's asynchronous API.
   *
   * Region and credentials are resolved the same way as `recognizeImage()`.
   *
   * @param {Uint8Array|ArrayBuffer} documentData - PDF data
   * @param {Object} [options]
   * @param {boolean} [options.analyzeLayout=false] - Whether to enable layout analysis.
   * @param {boolean} [options.analyzeTables=false] - Whether to enable table analysis.
   * @param {string} options.s3Bucket - S3 bucket name (required)
   * @param {string} [options.s3Key] - S3 key prefix (optional, auto-generated if not provided)
   * @param {boolean} [options.keepS3File=false] - Whether to keep the uploaded S3 file after processing
   * @param {number} [options.pollingInterval=5000] - Polling interval in milliseconds
   * @param {number} [options.maxWaitTime=1800000] - Maximum wait time in milliseconds (default: 30 minutes)
   * @param {string} [options.region] - AWS region.
   * @param {{accessKeyId: string, secretAccessKey: string}} [options.credentials] - AWS credentials.
   * @param {function} [options.progressCallback] - Optional callback for progress reporting.
   * @returns {Promise<RecognitionResult>}
   */
  static async recognizeDocument(documentData, options = {}) {
    const data = documentData instanceof ArrayBuffer ? new Uint8Array(documentData) : documentData;

    const result = await this.recognizePdfAsync(data, {
      analyzeLayout: options.analyzeLayout ?? false,
      analyzeTables: options.analyzeTables ?? false,
      s3Bucket: options.s3Bucket,
      s3Key: options.s3Key,
      keepS3File: options.keepS3File ?? false,
      pollingInterval: options.pollingInterval ?? 5000,
      maxWaitTime: options.maxWaitTime ?? 1800000,
      region: options.region,
      credentials: options.credentials,
      progressCallback: options.progressCallback,
    });

    if (result.success) {
      const combined = this.combineTextractResponses(result.data);
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
   * Asynchronous PDF recognition
   * @param {Uint8Array} pdfData
   * @param {Object} options
   * @param {boolean} [options.analyzeLayout]
   * @param {boolean} [options.analyzeTables]
   * @param {string} options.s3Bucket
   * @param {string} [options.s3Key]
   * @param {boolean} [options.keepS3File]
   * @param {number} [options.pollingInterval]
   * @param {number} [options.maxWaitTime]
   * @param {string} [options.region] - AWS region.
   * @param {{accessKeyId: string, secretAccessKey: string}} [options.credentials] - AWS credentials.
   * @param {function} [options.progressCallback] - Optional callback for progress reporting.
   */
  static recognizePdfAsync = async (pdfData, {
    analyzeLayout = false,
    analyzeTables = false,
    s3Bucket,
    s3Key,
    keepS3File = false,
    pollingInterval = 5000,
    maxWaitTime = 1800000,
    region,
    credentials,
    progressCallback,
  } = {}) => {
    const textractClient = new TextractClient({
      ...(region && { region }),
      ...(credentials && { credentials }),
    });

    const s3Client = new S3Client({
      ...(region && { region }),
      ...(credentials && { credentials }),
    });

    const finalS3Key = s3Key || `textract-temp/${Date.now()}-${Math.random().toString(36).substr(2, 9)}.pdf`;

    try {
      if (progressCallback) progressCallback({ status: 'uploading' });
      await s3Client.send(new PutObjectCommand({
        Bucket: s3Bucket,
        Key: finalS3Key,
        Body: pdfData,
        ContentType: 'application/pdf',
      }));

      let startCommand;

      if (analyzeLayout || analyzeTables) {
        const FeatureTypes = [];
        if (analyzeLayout) FeatureTypes.push('LAYOUT');
        if (analyzeTables) FeatureTypes.push('TABLES');

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

      if (progressCallback) progressCallback({ status: 'starting' });
      const startResponse = await textractClient.send(startCommand);
      const jobId = startResponse.JobId;

      const result = await this.pollForCompletion(
        textractClient,
        jobId,
        analyzeLayout || analyzeTables,
        pollingInterval,
        maxWaitTime,
        progressCallback,
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
          if (progressCallback) progressCallback({ status: 'cleanup' });
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
   * @param {function} [progressCallback] - Optional callback for progress reporting.
   */
  static pollForCompletion = async (textractClient, jobId, isAnalysis, pollingInterval, maxWaitTime, progressCallback) => {
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

          if (progressCallback) progressCallback({ status: 'retrieving', responsesReceived: allResponses.length });

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
          if (progressCallback) progressCallback({ status: 'polling', elapsedMs: Date.now() - startTime });
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
  static combineTextractResponses = (responses) => {
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
