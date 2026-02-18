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

// Change `outputFormat` to match whichever adapter the proxy server is configured with:
//   'textract'       — AWS Textract
//   'google_vision'  — Google Cloud Vision
//   'google_doc_ai'  — Google Document AI
//   'azure_doc_intel' — Azure Document Intelligence
class CloudOCR {
  static config = { name: 'AWS Textract', outputFormat: 'textract' };

  static proxyUrl = 'http://localhost:8080/recognize';

  static async recognizeImage(imageData, options = {}) {
    const data = imageData instanceof ArrayBuffer ? new Uint8Array(imageData) : imageData;
    const proxyUrl = options.proxyUrl || this.proxyUrl;
    const format = this.config.outputFormat || 'unknown';

    if (!proxyUrl) {
      return { success: false, error: new Error('proxyUrl is required.'), format };
    }

    try {
      const response = await fetch(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: data,
      });

      if (!response.ok) {
        return { success: false, error: new Error(`Proxy server returned HTTP ${response.status}`), format };
      }

      return await response.json();
    } catch (error) {
      return { success: false, error, format };
    }
  }

  static async checkAvailability() {
    return { available: true };
  }
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
