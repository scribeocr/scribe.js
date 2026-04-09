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
 * Manages a pool of AWS regions for round-robin request distribution.
 * Each region tracks its own throttle/backoff state independently.
 */
class RegionPool {
  /**
   * @param {string[]} regions
   * @param {Object} [defaultCredentials]
   */
  constructor(regions, defaultCredentials) {
    this.entries = regions.map((region) => ({
      region,
      credentials: defaultCredentials,
      backoffUntil: 0,
      consecutiveThrottles: 0,
    }));
    this._index = 0;
  }

  /** Get the next available region, skipping any currently in backoff. */
  getNext() {
    const now = Date.now();
    const len = this.entries.length;
    for (let i = 0; i < len; i++) {
      const entry = this.entries[(this._index + i) % len];
      if (entry.backoffUntil <= now) {
        this._index = ((this._index + i) % len) + 1;
        return entry;
      }
    }
    const soonest = this.entries.reduce((a, b) => (a.backoffUntil < b.backoffUntil ? a : b));
    return soonest;
  }

  /** Mark a region as throttled with exponential backoff. */
  markThrottled(entry) {
    entry.consecutiveThrottles++;
    entry.backoffUntil = Date.now() + Math.min(1000 * (2 ** entry.consecutiveThrottles), 32000);
  }

  /** Mark a region as successful (reset throttle state). */
  markSuccess(entry) {
    entry.consecutiveThrottles = 0;
    entry.backoffUntil = 0;
  }

  /** Returns true when every region is currently in a backoff window. */
  allInBackoff() {
    const now = Date.now();
    return this.entries.every((e) => e.backoffUntil > now);
  }
}

/**
 * Browser-compatible AWS Textract recognition model for use with Scribe.js.
 * Imports from a pre-bundled ESM file so no bare-specifier resolution is needed.
 * Supports synchronous (single-image) recognition only.
 */
export class RecognitionModelTextractBrowser {
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

  /** @type {RegionPool|null} */
  static _regionPool = null;

  /**
   * Lazily creates or reuses a RegionPool from options.region when it is an array.
   * @param {Object} options
   */
  static _ensureRegionPool(options) {
    const regions = options.region;
    if (!Array.isArray(regions) || regions.length <= 1) {
      this._regionPool = null;
      return;
    }
    const currentRegions = this._regionPool?.entries.map((e) => e.region);
    if (!currentRegions || JSON.stringify(currentRegions) !== JSON.stringify(regions)) {
      this._regionPool = new RegionPool(regions, options.credentials);
    }
  }

  /**
   * Dispatch a single image recognition request across the region pool.
   * @param {Uint8Array} data
   * @param {Object} options
   * @param {boolean} analyzeLayout
   * @param {boolean} analyzeTables
   * @returns {Promise<RecognitionResult>}
   */
  static async _recognizeWithPool(data, options, analyzeLayout, analyzeTables) {
    const pool = this._regionPool;
    const maxAttempts = pool.entries.length;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const entry = pool.getNext();

      const now = Date.now();
      if (entry.backoffUntil > now) {
        await new Promise((resolve) => setTimeout(resolve, entry.backoffUntil - now));
      }

      try {
        const textractClient = new TextractClient({
          region: entry.region,
          ...(entry.credentials && { credentials: entry.credentials }),
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
        pool.markSuccess(entry);
        return { success: true, rawData: JSON.stringify(response), format: 'textract' };
      } catch (error) {
        if (this.isThrottlingError(error)) {
          pool.markThrottled(entry);
          if (!pool.allInBackoff()) continue;
        }
        return { success: false, error, format: 'textract' };
      }
    }

    return { success: false, error: new Error('All regions exhausted'), format: 'textract' };
  }

  /**
   * Recognize text from an image using AWS Textract.
   *
   * @param {Uint8Array|ArrayBuffer} imageData - Image data
   * @param {Object} [options]
   * @param {boolean} [options.analyzeLayout=false] - Whether to enable layout analysis.
   * @param {boolean} [options.analyzeTables=false] - Whether to enable table analysis.
   *    Enabling table analysis automatically enables layout analysis.
   * @param {string|string[]} [options.region] - AWS region (e.g. 'us-east-1') or array of regions
   *    for multi-region throughput scaling (e.g. ['us-east-1', 'us-west-2']).
   *    When an array is provided, pages are distributed across regions round-robin
   *    with per-region throttle backoff.
   *    If not provided, the SDK resolves from AWS_REGION env var, ~/.aws/config, or instance metadata.
   * @param {{accessKeyId: string, secretAccessKey: string, sessionToken?: string}} [options.credentials] - AWS credentials.
   * @returns {Promise<RecognitionResult>}
   */
  static async recognizeImage(imageData, options = {}) {
    const data = imageData instanceof ArrayBuffer ? new Uint8Array(imageData) : imageData;
    const analyzeTables = options.analyzeTables ?? false;
    const analyzeLayout = options.analyzeLayout ?? false;

    // Multi-region path: distribute across regions with per-region backoff.
    this._ensureRegionPool(options);
    if (this._regionPool) {
      return this._recognizeWithPool(data, options, analyzeLayout, analyzeTables);
    }

    // Single-region path.
    const region = (typeof options.region === 'string' && options.region) || undefined;
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
