# @scribe.js/aws-textract
Convert AWS Textract output into searchable PDFs. AWS Textract recognition adapter for [scribe.js-ocr](https://www.npmjs.com/package/scribe.js-ocr), an open-source OCR and text-extraction toolkit for browser and Node.js.

`scribe.js-ocr` already knows how to parse Textract output into its OCR data model. This package is the thin client that calls AWS Textract and returns that output. It is kept separate so the AWS SDK is only installed by projects that actually use Textract.

## Install

```sh
npm install scribe.js-ocr @scribe.js/aws-textract
```

## Exports

| Specifier | Class | Environment |
| --- | --- | --- |
| `@scribe.js/aws-textract` | `RecognitionModelTextract` | Node. Imports the AWS SDK as a normal dependency. Supports per-image and async PDF (via S3) recognition. |
| `@scribe.js/aws-textract/browser` | `RecognitionModelTextractBrowser` | Browser. Imports a pre-bundled AWS SDK, so no bare-specifier resolution is needed. Per-image recognition only. |

## Usage

Pick the pattern that matches where your AWS credentials can safely live.

### 1. Node / server-side

Credentials stay on the server. Use the default export.

```js
import scribe from 'scribe.js-ocr';
import { RecognitionModelTextract } from '@scribe.js/aws-textract';

await scribe.importFiles(['document.pdf']);

await scribe.recognize({
  model: RecognitionModelTextract,
  modelOptions: { analyzeLayout: true },
});

console.log(await scribe.exportData('text'));
await scribe.terminate();
```

Credentials and region resolve through the standard AWS SDK chain (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` env vars, `~/.aws/credentials`, or an IAM role), or pass them explicitly in `modelOptions`:

```js
modelOptions: {
  region: 'us-east-1',
  credentials: { accessKeyId: '...', secretAccessKey: '...' },
}
```

Textract rate limits are per region, so passing an array of regions distributes pages round-robin for higher throughput:

```js
modelOptions: { region: ['us-east-1', 'us-west-2', 'eu-west-1'] }
```

### 2. Browser via proxy server (recommended for production)

For a public browser app, the safe setup is to keep credentials off the client entirely. The browser sends each document to a backend you control, which runs the Node model from pattern 1 and streams results back. No AWS key ever reaches the client.

The scribe.js repository ships a ready-made client and server you can copy under the `server-textract-proxy` example (in scribe.js repo). The server holds the credentials and calls `RecognitionModelTextract`, and the browser uses a small proxy model that posts the document to your endpoint. This is the right default for most production sites.

### 3. Browser, direct to AWS (advanced / debugging)

The `/browser` export calls AWS straight from the browser with credentials you pass in. Those credentials reach the client, so this pattern is appropriate only for local debugging, trusted internal tools, or short-lived Amazon Cognito credentials (advanced users only). **Never ship long-lived IAM keys to a public site** — use pattern 2 instead.

```js
import scribe from 'scribe.js-ocr';
import { RecognitionModelTextractBrowser } from '@scribe.js/aws-textract/browser';

await scribe.importFiles(fileList);

await scribe.recognize({
  model: RecognitionModelTextractBrowser,
  modelOptions: {
    region: 'us-east-1',
    credentials: { accessKeyId: '...', secretAccessKey: '...' },
    analyzeLayout: true,
  },
});

console.log(await scribe.exportData('text'));
```

## Options

`modelOptions` accepted by `recognize()`:

- `analyzeLayout` (boolean) — enable layout analysis. Increases AWS cost.
- `analyzeTables` (boolean) — enable table analysis. Implies layout analysis. Significantly increases AWS cost.
- `region` (string | string[]) — AWS region, or an array for multi-region throughput.
- `credentials` (`{ accessKeyId, secretAccessKey }`) — explicit credentials.

The Node `RecognitionModelTextract` additionally supports async PDF recognition (`recognizeDocument`), which uploads to S3 and polls the async Textract API. See the JSDoc in `RecognitionModelAwsTextract.js` for `s3Bucket`, `pollingInterval`, and related options.

## Rebuilding the browser bundle

`aws-textract.esm.bundle.min.js` is a checked-in build artifact: the AWS SDK Textract client bundled for the browser. Regenerate it after bumping the AWS SDK version:

```sh
npm install
npm run build
```

The declared `@aws-sdk/*` dependency versions and the bundled version must be kept in sync. Both should match after a fresh `npm install && npm run build`.
