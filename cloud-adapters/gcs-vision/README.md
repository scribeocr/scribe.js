# @scribe.js/gcs-vision
Convert Google Cloud Vision output into searchable PDFs. Google Cloud Vision recognition adapter for [scribe.js-ocr](https://www.npmjs.com/package/scribe.js-ocr), an open-source OCR and text-extraction toolkit for browser and Node.js.

`scribe.js-ocr` already knows how to parse Google Cloud Vision output into its OCR data model. This package is the thin Node client that calls Vision and returns that output. It is kept separate so the Google Cloud SDKs are only installed by projects that actually use it.

## Install

```sh
npm install scribe.js-ocr @scribe.js/gcs-vision
```

## Exports

| Specifier | Class | Environment |
| --- | --- | --- |
| `@scribe.js/gcs-vision` | `RecognitionModelGoogleVision` | Node. Single images inline; PDF/TIFF via async batch processing through a GCS bucket. |

## Usage

```js
import scribe from 'scribe.js-ocr';
import { RecognitionModelGoogleVision } from '@scribe.js/gcs-vision';

const doc = await scribe.openDocument(['image.png']);

await doc.recognize({
  model: RecognitionModelGoogleVision,
});

console.log(await doc.exportData('text'));
await doc.terminate();
await scribe.terminate();
```

Credentials resolve through Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS`, `gcloud auth application-default login`, or GCE/GKE metadata), or pass `keyFilename` with the path to a service account JSON key:

```js
modelOptions: { keyFilename: '/path/to/service-account.json' }
```

Vision processes single images inline. PDF and TIFF documents require Vision's async API, which the model exposes via `recognizeDocument` with a `gcsBucket` and `fileExtension`: it uploads to GCS, runs the async job, downloads the output, and cleans up.

**Browser apps:** this package is Node-only. For a browser app, requests need to be passed from browser to a Node.js server.

## Options

`modelOptions` accepted by `recognize()`:

- `keyFilename` (string) — path to a service account JSON key. Defaults to ADC.

Additional options for the async `recognizeDocument` (PDF/TIFF) path:

- `gcsBucket` (string) — bucket for temporary storage. Required for async recognition.
- `fileExtension` (string) — `.pdf` or `.tiff`.
- `keepGcsFile` (boolean) — keep the temporary GCS artifacts (default `false`).
