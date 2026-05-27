# @scribe.js/azure-doc-intel
Convert Azure Document Intelligence output into searchable PDFs. Azure Document Intelligence recognition adapter for [scribe.js-ocr](https://www.npmjs.com/package/scribe.js-ocr), an open-source OCR and text-extraction toolkit for browser and Node.js.

`scribe.js-ocr` already knows how to parse Azure Document Intelligence output into its OCR data model. This package is the thin Node client that calls Azure and returns that output. It is kept separate so the Azure SDK is only installed by projects that actually use it.

## Install

```sh
npm install scribe.js-ocr @scribe.js/azure-doc-intel
```

## Exports

| Specifier | Class | Environment |
| --- | --- | --- |
| `@scribe.js/azure-doc-intel` | `RecognitionModelAzureDocIntel` | Node. Sends documents to Azure as base64 and polls until done. Handles both images and PDFs inline. |

## Usage

Credentials stay on the server. Azure accepts images and PDFs through the same call.

```js
import scribe from 'scribe.js-ocr';
import { RecognitionModelAzureDocIntel } from '@scribe.js/azure-doc-intel';

const doc = await scribe.openDocument(['document.pdf']);

await doc.recognize({
  model: RecognitionModelAzureDocIntel,
  modelOptions: { analyzeLayout: true },
});

console.log(await doc.exportData('text'));
await doc.terminate();
await scribe.terminate();
```

The endpoint and key resolve from the `SCRIBE_AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` and `SCRIBE_AZURE_DOCUMENT_INTELLIGENCE_KEY` env vars, or pass them explicitly:

```js
modelOptions: {
  endpoint: 'https://<resource>.cognitiveservices.azure.com/',
  key: '...',
}
```

**Browser apps:** this package is Node-only and uses a server-side API key. For a browser app, requests need to be passed from browser to a Node.js server.

## Options

`modelOptions` accepted by `recognize()`:

- `analyzeLayout` (boolean) — use the `prebuilt-layout` model (paragraphs, tables, selection marks) instead of `prebuilt-read`.
- `endpoint` (string) — Azure resource endpoint.
- `key` (string) — Azure API key.
- `modelId` (string) — override the Azure model ID (default `prebuilt-read`, or `prebuilt-layout` when `analyzeLayout` is set).
