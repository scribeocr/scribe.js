# @scribe.js/gcs-doc-ai
Convert Google Document AI output into searchable PDFs. Google Document AI recognition adapter for [scribe.js-ocr](https://www.npmjs.com/package/scribe.js-ocr), an open-source OCR and text-extraction toolkit for browser and Node.js.

`scribe.js-ocr` already knows how to parse Google Document AI output into its OCR data model. This package is the thin Node client that calls Document AI and returns that output. It is kept separate so the Google Cloud SDKs are only installed by projects that actually use it.

## Install

```sh
npm install scribe.js-ocr @scribe.js/gcs-doc-ai
```

## Exports

| Specifier | Class | Environment |
| --- | --- | --- |
| `@scribe.js/gcs-doc-ai` | `RecognitionModelGoogleDocAI` | Node. Inline processing up to 20 MB; larger documents via async batch processing through a GCS bucket. |

## Usage

```js
import scribe from 'scribe.js-ocr';
import { RecognitionModelGoogleDocAI } from '@scribe.js/gcs-doc-ai';

const doc = await scribe.openDocument(['document.pdf']);

await doc.recognize({
  model: RecognitionModelGoogleDocAI,
  modelOptions: {
    processorName: 'projects/my-project/locations/us/processors/abc123',
  },
});

console.log(await doc.exportData('text'));
await doc.terminate();
await scribe.terminate();
```

The processor resource name resolves from the `SCRIBE_GOOGLE_DOC_AI_PROCESSOR` env var or `modelOptions.processorName`. Credentials resolve through Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`, `gcloud auth application-default login`, or GCE/GKE metadata), or pass `keyFilename` with the path to a service account JSON key.

For documents above Document AI's 20 MB inline limit, the model also exposes async batch processing (`recognizeDocument` with a `gcsBucket`), which uploads to GCS, runs the batch job, merges the output shards, and cleans up.

**Browser apps:** this package is Node-only. For a browser app, requests need to be passed from browser to a Node.js server.

## Options

`modelOptions` accepted by `recognize()`:

- `processorName` (string) — full processor resource name `projects/{project}/locations/{location}/processors/{id}`. Required (or via env var).
- `mimeType` (string) — document MIME type (default `application/pdf`).
- `keyFilename` (string) — path to a service account JSON key. Defaults to ADC.
- `excludeImages` (boolean) — strip page images from the output to reduce its size.
- `skipHumanReview` (boolean) — default `true`.
- `gcsBucket` (string) — bucket for async batch processing of large documents (used by `recognizeDocument`).
