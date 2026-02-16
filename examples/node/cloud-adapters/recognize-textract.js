#!/usr/bin/env node
// Example: Using AWS Textract as a custom recognition model with Scribe.js.
//
// Usage:
//   node examples/node/recognize-textract.js path/to/document.pdf
//
// Prerequisites:
//   - AWS credentials configured via one of:
//     - AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables
//     - ~/.aws/credentials file (with optional AWS_PROFILE)
//     - IAM role (when running on EC2/ECS/Lambda)
//   - AWS_REGION env var or ~/.aws/config for region selection
//   - The `@scribe.js/aws-textract` package installed (or implement your own model class)
//
// This example demonstrates how to use a custom recognition model with Scribe.js.
// The same pattern works for any model that implements the RecognitionModel interface.

import scribe from '../../../scribe.js';
// If installed via npm: import { RecognitionModelTextract } from '@scribe.js/aws-textract';
import { RecognitionModelTextract } from '../../../cloud-adapters/aws-textract/RecognitionModelAwsTextract.js';

const [,, filePath] = process.argv;

if (!filePath) {
  console.error('Usage: node recognize-textract.js <file>');
  process.exit(1);
}

(async () => {
  // Track progress per page
  scribe.opt.progressHandler = (msg) => {
    if (msg.type === 'convert' && msg.info.engineName === 'AWS Textract') {
      console.log(`Page ${msg.n} converted (${msg.info.engineName})`);
    }
  };

  await scribe.importFiles([filePath]);

  await scribe.recognize({
    model: RecognitionModelTextract,
    modelOptions: { analyzeLayout: true },
  });

  const text = await scribe.exportData('text');
  console.log(text);

  await scribe.terminate();
})();
