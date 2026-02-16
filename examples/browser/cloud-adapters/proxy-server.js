#!/usr/bin/env node
// Example: Proxy server for browser-based cloud OCR with Scribe.js.
//
// This server accepts image data from the browser, forwards it to a cloud
// OCR adapter, and returns the recognition result. Credentials and cloud
// configuration stay server-side.
//
// Usage:
//   node examples/browser/cloud-adapters/proxy-server.js [--port=8080]
//
// Then open recognize-cloud.html in a browser (served by your own dev server).
//
// By default this uses AWS Textract. To use a different adapter, change the
// import and modelOptions below. For example:
//
//   import { GoogleVisionModel } from '../../../cloud-adapters/gcs-vision/RecognitionModelGoogleVision.js';
//   const model = GoogleVisionModel;
//   const modelOptions = {};
//
// Prerequisites:
//   Cloud credentials must be configured for whichever adapter you choose.
//   See the Node.js examples in examples/node/cloud-adapters/ for details.

import http from 'node:http';

// --- Configure cloud adapter ---
// Swap this import for any adapter (GoogleVisionModel, RecognitionModelGoogleDocAI, RecognitionModelAzureDocIntel).
import { RecognitionModelTextract } from '../../../cloud-adapters/aws-textract/RecognitionModelAwsTextract.js';

const model = RecognitionModelTextract;
const modelOptions = { analyzeLayout: true };
// --- End configuration ---

const args = process.argv.slice(2);
const portArg = args.find((a) => a.startsWith('--port='));
const port = portArg ? parseInt(portArg.split('=')[1], 10) : 8080;

const server = http.createServer(async (req, res) => {
  // CORS headers for local development
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/recognize') {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const imageData = new Uint8Array(Buffer.concat(chunks));

      console.log(`Received ${imageData.length} bytes, sending to ${model.config.name}...`);
      const start = performance.now();
      const result = await model.recognizeImage(imageData, modelOptions);
      const elapsed = ((performance.now() - start) / 1000).toFixed(2);

      if (!result.success) {
        const msg = result.error instanceof Error ? result.error.stack || result.error.message : String(result.error || 'unknown error');
        console.error(`Recognition failed after ${elapsed}s:\n${msg}`);
        // Error objects serialize to {}, so replace with a plain message string for JSON.
        result.error = /** @type {any} */ (msg);
      } else {
        console.log(`Recognition finished in ${elapsed}s`);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      const msg = error instanceof Error ? error.stack || error.message : String(error);
      console.error(`Error processing request:\n${msg}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: msg, format: model.config.outputFormat }));
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(port, () => {
  console.log(`Proxy server listening on http://localhost:${port}`);
  console.log(`Cloud adapter: ${model.config.name} (format: ${model.config.outputFormat})`);
  console.log('Waiting for POST /recognize requests...');
});
