// Example: Using a cloud OCR service in the browser via a proxy server.
//
// Prerequisites:
//   1. Start the proxy server: node examples/browser/cloud-adapters/proxy-server.js
//   2. Serve this directory with a local dev server (e.g. `npx http-server`)
//   3. Open recognize-cloud.html in the browser
//
// The proxy server handles cloud credentials and API calls.
// Change the outputFormat below to match the adapter configured on the proxy server.

import scribe from '../../../scribe.js';
import { RecognitionModelProxy } from '../../../cloud-adapters/proxy/RecognitionModelProxy.js';

// Subclass the proxy adapter to match the cloud service running on the backend.
// Change `outputFormat` to match whichever adapter the proxy server is configured with:
//   'textract'       — AWS Textract
//   'google_vision'  — Google Cloud Vision
//   'google_doc_ai'  — Google Document AI
//   'azure_doc_intel' — Azure Document Intelligence
class CloudOCR extends RecognitionModelProxy {
  static config = { name: 'AWS Textract', outputFormat: 'textract' };

  static proxyUrl = 'http://localhost:8080/recognize';
}

await scribe.init({ ocr: true, font: true });

const elm = /** @type {HTMLInputElement} */ (document.getElementById('uploader'));
elm.addEventListener('change', async () => {
  if (!elm.files) return;
  const output = /** @type {HTMLPreElement} */ (document.getElementById('output'));
  output.textContent = 'Recognizing...';

  await scribe.importFiles(elm.files);
  await scribe.recognize({ model: CloudOCR });

  const text = await scribe.exportData('text');
  output.textContent = text;
  await scribe.terminate();
});
