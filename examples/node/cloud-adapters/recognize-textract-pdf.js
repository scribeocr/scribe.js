#!/usr/bin/env node
// Example: Using AWS Textract to create a searchable PDF with Scribe.js.
//
// Usage:
//   node examples/node/recognize-textract-pdf.js path/to/document.pdf [output.pdf]
//
// Prerequisites:
//   - AWS credentials configured via one of:
//     - AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables
//     - ~/.aws/credentials file (with optional AWS_PROFILE)
//     - IAM role (when running on EC2/ECS/Lambda)
//   - AWS_REGION env var or ~/.aws/config for region selection
//   - The `@scribe.js/aws-textract` package installed (or implement your own model class)
//
// This example imports a document, runs OCR via AWS Textract,
// and exports a searchable PDF with an invisible text layer.

import scribe from '../../../scribe.js';
// If installed via npm: import { RecognitionModelTextract } from '@scribe.js/aws-textract';
import { RecognitionModelTextract } from '../../../cloud-adapters/aws-textract/RecognitionModelAwsTextract.js';

const [,, filePath, outputPath] = process.argv;

if (!filePath) {
  console.error('Usage: node recognize-textract-pdf.js <input-file> [output.pdf]');
  process.exit(1);
}

const output = outputPath || filePath.replace(/\.[^.]+$/, '_ocr.pdf');

(async () => {
  scribe.opt.progressHandler = (msg) => {
    if (msg.type === 'convert') {
      console.log(`Page ${msg.n} converted (${msg.info.engineName})`);
    }
  };

  await scribe.importFiles([filePath]);

  await scribe.recognize({
    model: RecognitionModelTextract,
    modelOptions: { analyzeLayout: true },
  });

  await scribe.download('pdf', output);
  console.log(`Searchable PDF written to ${output}`);

  await scribe.terminate();
})();
