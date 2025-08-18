import {
  TextractClient, DetectDocumentTextCommand, AnalyzeDocumentCommand,
} from '@aws-sdk/client-textract';

export class OcrEngineTextract {
  constructor() {
    this.name = 'Textract';
  }

  /**
   *
   * @param {Uint8Array<ArrayBufferLike>} imageData
   * @param {Object} [options]
   * @param {boolean} [options.analyzeLayout] - Whether to analyze layout
   * @param {boolean} [options.analyzeLayoutTables] - Whether to analyze layout tables
   * @returns
   */
  static recognizeImage = async (imageData, {
    analyzeLayout = false,
    analyzeLayoutTables = false,
  } = {}) => {
    try {
      // TODO: This should not overwrite the region in the user's profile, which I believe it currently does.
      const textractClient = new TextractClient({
        region: process.env.AWS_REGION || 'us-east-1',
      });

      let command;
      if (analyzeLayout) {
        /** @type {import('@aws-sdk/client-textract').FeatureType[]} */
        const FeatureTypes = analyzeLayoutTables ? ['TABLES'] : ['LAYOUT'];

        command = new AnalyzeDocumentCommand({
          Document: {
            Bytes: imageData,
          },
          FeatureTypes,
        });
      } else {
        command = new DetectDocumentTextCommand({
          Document: {
            Bytes: imageData,
          },
        });
      }

      const response = await textractClient.send(command);

      return {
        success: true,
        data: response,
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        errorCode: error.name,
      };
    }
  };
}
