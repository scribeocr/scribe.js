#!/usr/bin/env node
// Example: Using Google Cloud Vision as a custom recognition model with Scribe.js.
//
// Usage:
//   node examples/node/cloud-adapters/recognize-google-vision.js path/to/document.pdf
//
// Prerequisites:
//   - Google Cloud credentials configured via one of:
//     - GOOGLE_APPLICATION_CREDENTIALS env var pointing to a service account JSON key file
//     - `gcloud auth application-default login`
//     - GCE/GKE metadata service (when running on Google Cloud)
//   - The `@scribe.js/gcs-vision` package installed (or implement your own model class)
//
// This example imports a document, runs OCR via Google Cloud Vision,
// and prints the extracted text.

import scribe from '../../../scribe.js';
// If installed via npm: import { RecognitionModelGoogleVision } from '@scribe.js/gcs-vision';
import { RecognitionModelGoogleVision } from '../../../cloud-adapters/gcs-vision/RecognitionModelGoogleVision.js';

const [,, filePath] = process.argv;

if (!filePath) {
  console.error('Usage: node recognize-google-vision.js <file>');
  process.exit(1);
}

(async () => {
  scribe.opt.progressHandler = (msg) => {
    if (msg.type === 'convert') {
      console.log(`Page ${msg.n} converted (${msg.info.engineName})`);
    }
  };

  const doc = await scribe.openDocument([filePath]);

  await doc.recognize({
    model: RecognitionModelGoogleVision,
  });

  const text = await doc.exportData('text');
  console.log(text);

  await doc.terminate();
  await scribe.terminate();
})();
