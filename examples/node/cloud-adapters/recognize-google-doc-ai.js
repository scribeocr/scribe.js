#!/usr/bin/env node
// Example: Using Google Document AI as a custom recognition model with Scribe.js.
//
// Usage:
//   node examples/node/cloud-adapters/recognize-google-doc-ai.js path/to/document.pdf
//
// Prerequisites:
//   - Google Cloud credentials configured via one of:
//     - GOOGLE_APPLICATION_CREDENTIALS env var pointing to a service account JSON key file
//     - `gcloud auth application-default login`
//     - GCE/GKE metadata service (when running on Google Cloud)
//   - A Document AI processor configured in your Google Cloud project
//   - SCRIBE_GOOGLE_DOC_AI_PROCESSOR env var set to the processor resource name
//     Format: projects/{project-id}/locations/{location}/processors/{processor-id}
//   - The `@scribe.js/gcs-doc-ai` package installed (or implement your own model class)
//
// This example imports a document, runs OCR via Google Document AI,
// and prints the extracted text.

import scribe from '../../../scribe.js';
// If installed via npm: import { RecognitionModelGoogleDocAI } from '@scribe.js/gcs-doc-ai';
import { RecognitionModelGoogleDocAI } from '../../../cloud-adapters/gcs-doc-ai/RecognitionModelGoogleDocAI.js';

const [,, filePath] = process.argv;

if (!filePath) {
  console.error('Usage: node recognize-google-doc-ai.js <file>');
  process.exit(1);
}

(async () => {
  scribe.opt.progressHandler = (msg) => {
    if (msg.type === 'convert') {
      console.log(`Page ${msg.n} converted (${msg.info.engineName})`);
    }
  };

  await scribe.importFiles([filePath]);

  await scribe.recognize({
    model: RecognitionModelGoogleDocAI,
  });

  const text = await scribe.exportData('text');
  console.log(text);

  await scribe.terminate();
})();
