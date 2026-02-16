#!/usr/bin/env node
// Example: Using Azure Document Intelligence as a custom recognition model with Scribe.js.
//
// Usage:
//   node examples/node/cloud-adapters/recognize-azure-doc-intel.js path/to/document.pdf
//
// Prerequisites:
//   - An Azure Document Intelligence resource created in the Azure portal
//   - SCRIBE_AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT env var set to the resource endpoint URL
//   - SCRIBE_AZURE_DOCUMENT_INTELLIGENCE_KEY env var set to the resource API key
//   - The `@scribe.js/azure-doc-intel` package installed (or implement your own model class)
//
// This example imports a document, runs OCR via Azure Document Intelligence,
// and prints the extracted text.

import scribe from '../../../scribe.js';
// If installed via npm: import { RecognitionModelAzureDocIntel } from '@scribe.js/azure-doc-intel';
import { RecognitionModelAzureDocIntel } from '../../../cloud-adapters/azure-doc-intel/RecognitionModelAzureDocIntel.js';

const [,, filePath] = process.argv;

if (!filePath) {
  console.error('Usage: node recognize-azure-doc-intel.js <file>');
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
    model: RecognitionModelAzureDocIntel,
  });

  const text = await scribe.exportData('text');
  console.log(text);

  await scribe.terminate();
})();
