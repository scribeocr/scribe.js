# Scribe.js Guide

Scribe.js performs OCR and extracts text from images and PDFs, and writes the results back out
in formats like searchable PDF, plain text, hOCR, and Word/Excel.

This guide covers the JavaScript API, from a first script to full document control. For a terse
reference of every function and method, see the [API reference](./API.md). If you want the
`scribe` command-line tool instead, see the [CLI reference](./cli.md). If you are choosing
between Scribe.js and Tesseract.js, see [Scribe.js vs. Tesseract.js](./scribe_vs_tesseract.md).

## Contents

1. [Install and import](#install-and-import)
2. [Quick start](#quick-start)
3. [Core concepts](#core-concepts)
4. [Importing files](#importing-files)
5. [Recognition (OCR)](#recognition-ocr)
6. [Exporting and output](#exporting-and-output)
7. [Configuration](#configuration)
8. [Browser usage notes](#browser-usage-notes)

## Install and import

```sh
npm i scribe.js-ocr
```

Scribe.js is written in JavaScript using ESM, so it can be imported directly in Node.js or in the
browser without a build step.

```js
// Node.js
import scribe from 'scribe.js-ocr';

// Browser (bundler such as Vite, Webpack, or Next.js)
import scribe from 'scribe.js-ocr';

// Browser without a bundler (import map or relative path)
import scribe from '/node_modules/scribe.js-ocr/scribe.js';
```

In the browser, all files must be served from the same origin as the code importing Scribe.js.
Importing from a CDN does not work, and there is no UMD build. See [Browser usage
notes](#browser-usage-notes).

## Quick start

There are two ways to use Scribe.js: a single-call helper for trying it out, and a document API
for application code.

### One-shot: `extractText`

`extractText` handles import, recognition, and export in one call. It returns plain text by
default and is smart about PDFs (extracting existing text from text-native PDFs and running OCR
on image-based ones).

```js
import scribe from 'scribe.js-ocr';

const text = await scribe.extractText(['https://tesseract.projectnaptha.com/img/eng_bw.png']);
console.log(text);

await scribe.terminate();
```

This is the easiest way to try Scribe.js, but it hides every piece of control a real
application typically needs: recognition options, progress events, error handling, per-word OCR
data, and the ability to produce more than one output format. Use it for scripts and
exploration. For production code, prefer `openDocument` below.

### Full control: `openDocument` and `ScribeDoc`

This is the recommended path for any application beyond a one-off script. Open a document with
`scribe.openDocument` and operate on the returned [`ScribeDoc`](#the-scribedoc-object), which
exposes recognition options, progress and warning handlers, the per-word OCR data, and every
output format.

```js
import scribe from 'scribe.js-ocr';

const doc = await scribe.openDocument(['receipt.png']);

await doc.recognize({ langs: ['eng'] });

// Read recognized words.
for (const word of doc.ocr.active[0].lines.flatMap((line) => line.words)) {
  console.log(word.text, word.conf);
}

// Write a searchable PDF.
await doc.download('pdf', 'receipt.pdf');

await doc.terminate();
await scribe.terminate();
```

`extractText` is a thin convenience wrapper around this exact flow that throws away the
intermediate state and returns just the text. Everything else in this guide builds on
`openDocument` and `ScribeDoc`.

## Core concepts

### Two API levels

| Level | Entry point | Use when |
| --- | --- | --- |
| One-shot | `scribe.extractText(files)` | Quick scripts or trying things out. Easy, but no progress events, no error surface, no per-word data. |
| Document | `scribe.openDocument(files)` -> `ScribeDoc` | Application code. Use whenever you need OCR options, progress or error handling, word-level data, multiple output formats, or multiple documents. |

### The `ScribeDoc` object

A `ScribeDoc` represents a single document being processed — its imported pages, OCR text,
layout, fonts, and images. `scribe.openDocument(files)` creates one, imports the files, and
returns it. Because each document holds its own state, you can have several open at once:

```js
const invoice = await scribe.openDocument(['invoice.pdf']);
const contract = await scribe.openDocument(['contract.pdf']);
// invoice and contract are fully independent.
```

### Resource lifecycle

Scribe.js has two tiers of resources.

- **Shared resources** — the OCR worker pool and the built-in fonts. These are process-wide and
  loaded lazily on first use. `scribe.init()` can pre-load them to remove first-use latency, and
  `scribe.terminate()` releases them.
- **Per-document resources** — each document's PDF renderer, image cache, and optimized fonts.
  `doc.terminate()` releases these for one document without touching the shared pool.

A typical full lifecycle:

```js
await scribe.init({ ocr: true, font: true }); // optional pre-load
const doc = await scribe.openDocument(files);
await doc.recognize();
await doc.download('pdf', 'out.pdf');
await doc.terminate();   // release this document
await scribe.terminate(); // release shared resources (e.g. before process exit)
```

You do not have to call `init` — resources load on demand. You should call `doc.terminate()` and
`scribe.terminate()` when finished, especially in Node.js, so the process can exit.

### The OCR data model

After import or recognition, a document's text lives under `doc.ocr`. This is a map of named OCR
versions; `doc.ocr.active` is the one used for export. Other versions may exist depending on what
ran, for example `'Tesseract Legacy'`, `'Tesseract LSTM'`, `'Tesseract Combined'`, `'User
Upload'` (imported OCR), and `'pdf'` (text pulled from an input PDF).

Each version is an array of pages. The hierarchy is page -> line -> word:

```js
const page = doc.ocr.active[0];          // OcrPage
const line = page.lines[0];              // OcrLine
const word = line.words[0];              // OcrWord

word.text;   // 'Hello'
word.conf;   // confidence, 0-100
word.bbox;   // { left, top, right, bottom } in page pixels
word.style;  // { font, size, bold, italic, underline, smallCaps, sup, dropcap, color, opacity }
word.chars;  // character-level data when available, otherwise null
```

Alongside the OCR text, a document carries:

- `doc.pageMetrics` — per-page dimensions and rotation angle.
- `doc.inputData` — input metadata (`pdfMode`, `imageMode`, `pdfType`, `pageCount`, ...).
- `doc.layoutRegions` / `doc.layoutDataTables` — layout regions and detected tables, used for
  reflow and tabular exports.
- `doc.fonts` / `doc.images` — document-scoped font and image caches.

## Importing files

`openDocument` (and `doc.importFiles`) accept several input shapes.

### Supported input types

| Category | Extensions |
| --- | --- |
| Images | `.png`, `.jpg`, `.jpeg` |
| PDF | `.pdf` |
| OCR data | `.hocr`, `.xml` (Abbyy/ALTO), `.html`, `.stext`, `.json` (AWS Textract / Google Vision), `.txt`, `.docx`, `.gz` (gzipped XML) |
| Sessions | `.scribe`, `.scribe.json` |

Notes:

- A PDF and image files cannot be imported together, and only one PDF is imported at a time.
- Importing an image together with an OCR file (e.g. a `.png` plus its `.hocr`) loads the text
  over the image without re-running OCR.

### Passing files

For `File` objects (browser) or file paths (Node.js), pass a single array — Scribe.js sorts them
by extension:

```js
// Node.js: file paths
const doc = await scribe.openDocument(['scan.png', 'scan.hocr']);

// Browser: a FileList or File[] from an <input type="file">
const doc = await scribe.openDocument(fileInput.files);

// Browser: URLs (fetched same-origin)
const doc = await scribe.openDocument(['/uploads/scan.png']);
```

When passing `ArrayBuffer` inputs, extension sorting is not possible, so provide a
`SortedInputFiles` object that names each type:

```js
const doc = await scribe.openDocument({
  pdfFiles: [pdfArrayBuffer],
  imageFiles: [imageArrayBuffer],
  ocrFiles: [ocrArrayBuffer],
  scribeFiles: [scribeArrayBuffer],
});
```

### Supplemental OCR and ground truth

`doc.importFilesSupp(files, ocrName)` imports an additional OCR version under a name of your
choice, without replacing `doc.ocr.active`. This is used for alternate engine output or for
ground-truth data to evaluate against (see `doc.compareOCR` / `doc.evalOCRPage` in the [API
reference](./API.md)).

### Sessions (`.scribe`)

The `.scribe` format saves a full session — OCR text, layout, fonts, and annotations — so work
can be resumed exactly. Export with `doc.exportData('scribe')` and reopen by importing the result
as a scribe file:

```js
const session = await doc.exportData('scribe');           // ArrayBuffer (gzip) by default
const restored = await scribe.openDocument({ scribeFiles: [session] });
```

## Recognition (OCR)

Run the built-in Tesseract engine on a document's pages with `doc.recognize(options)`. Files must
be imported first (they already are after `openDocument`). Results populate `doc.ocr`.

```js
await doc.recognize({
  langs: ['eng'],      // languages present in the document
  modeAdv: 'combined', // 'lstm' | 'legacy' | 'combined'
});
```

### Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `langs` | `string[]` | `['eng']` | Language codes. |
| `mode` | `'speed' \| 'quality'` | `'quality'` | Convenience setting: `speed` -> LSTM only, `quality` -> Legacy. |
| `modeAdv` | `'lstm' \| 'legacy' \| 'combined'` | `'combined'` | Engine selection. Overrides `mode`. |
| `combineMode` | `'conf' \| 'data' \| 'none'` | `'data'` | How to merge with existing OCR data, if any. |
| `vanillaMode` | `boolean` | `false` | Use the unmodified upstream Tesseract.js model. |
| `config` | `Object<string, string>` | `{}` | Raw Tesseract config parameters. |
| `model` | `RecognitionModel` | — | A custom recognition model (see [cloud adapters](#cloud-ocr-adapters)). |
| `modelOptions` | `Object` | `{}` | Options forwarded to the custom model. |
| `signal` | `AbortSignal` | — | Cancel a custom-model run. Completed pages are preserved. |

`modeAdv` trade-offs:

- `lstm` — fastest, neural model only.
- `legacy` — the older model; produces strong character metrics used for font optimization.
- `combined` — runs both and merges them for the best accuracy. Slowest.

### Languages

Pass any Tesseract language codes in `langs` (e.g. `['eng', 'fra', 'deu']`). Some languages pull
in extra fonts automatically: `chi_sim` loads a Chinese font, and `rus` / `ukr` / `ell` load
Cyrillic/Greek glyph coverage.

By default the `.traineddata` language files are fetched from a CDN. To use a local or offline
mirror, set `scribe.opt.langPath` to a directory containing `<lang>.traineddata.gz`:

```js
scribe.opt.langPath = '/assets/tessdata'; // loads /assets/tessdata/eng.traineddata.gz
```

### Progress

Set `scribe.opt.progressHandler` to receive progress messages during recognition and export:

```js
scribe.opt.progressHandler = (msg) => {
  if (msg.type === 'recognize') console.log('recognizing...');
};
```

### Cloud OCR adapters

Instead of the built-in engine, you can plug in a cloud OCR service by passing a `model` to
`recognize`. Scribe.js already knows how to parse each service's output into its OCR data model;
the adapter packages are thin clients that call the service. They are published separately so the
relevant cloud SDK is only installed by projects that use it.

| Service | Package | Model class |
| --- | --- | --- |
| AWS Textract | `@scribe.js/aws-textract` | `RecognitionModelTextract` (Node), `RecognitionModelTextractBrowser` |
| Google Cloud Vision | `@scribe.js/gcs-vision` | `RecognitionModelGoogleVision` |
| Google Document AI | `@scribe.js/gcs-doc-ai` | `RecognitionModelGoogleDocAI` |
| Azure Document Intelligence | `@scribe.js/azure-doc-intel` | `RecognitionModelAzureDocIntel` |

Node.js, with credentials on the server:

```js
import scribe from 'scribe.js-ocr';
import { RecognitionModelTextract } from '@scribe.js/aws-textract';

const doc = await scribe.openDocument(['document.pdf']);

await doc.recognize({
  model: RecognitionModelTextract,
  modelOptions: { analyzeLayout: true },
});

console.log(await doc.exportData('text'));
await doc.terminate();
await scribe.terminate();
```

For browser apps, the recommended pattern is a proxy server that holds the credentials and runs
the Node model, with the browser posting documents to it. A ready-to-copy client and server are
in [`examples/server-textract-proxy/`](../examples/server-textract-proxy/). Calling a cloud
service directly from the browser is possible (`@scribe.js/aws-textract/browser`) but exposes
credentials, so it is only appropriate for local debugging or short-lived tokens. Each adapter's
own README documents its `modelOptions`.

## Exporting and output

`doc.exportData(format, options)` returns the document in the requested format. `doc.download(
format, fileName, options)` does the same and saves the result — a browser download or a Node.js
file write.

```js
const text = await doc.exportData('text');     // string
const pdfBytes = await doc.exportData('pdf');   // ArrayBuffer
await doc.download('pdf', 'output.pdf');         // writes output.pdf
```

### Formats

| Format | Output | Notes |
| --- | --- | --- |
| `'txt'` / `'text'` | string | Plain text. |
| `'pdf'` | ArrayBuffer | PDF with a text layer (see display modes below). |
| `'hocr'` | string | hOCR XML. |
| `'alto'` | string | ALTO XML (saved with a `.xml` extension by `download`). |
| `'html'` | string | HTML, optionally with page images (`opt.includeImages`). |
| `'md'` | string | Markdown, with tables. |
| `'docx'` | ArrayBuffer | Word document. |
| `'xlsx'` | ArrayBuffer | Excel spreadsheet, from detected tables. |
| `'scribe'` | ArrayBuffer or string | Session file (gzip by default; see `opt.compressScribe`). |

### Page subsetting

```js
await doc.exportData('text', { minPage: 0, maxPage: 4 }); // first 5 pages (inclusive)
await doc.exportData('text', { pageArr: [0, 2, 5] });      // specific pages; overrides min/max
```

### PDFs and the text layer

How the text layer is drawn is controlled by `scribe.opt.displayMode`:

- `'invis'` — invisible text over the page image. The standard "searchable PDF."
- `'proof'` — visible text, color-coded by confidence. Useful for reviewing OCR quality.
- `'ebook'` — text only, no background image.

Two common PDF workflows:

```js
// 1. Image (or image PDF) -> searchable PDF
scribe.opt.displayMode = 'invis';
const doc = await scribe.openDocument(['scan.png']);
await doc.recognize();
await doc.download('pdf', 'searchable.pdf');

// 2. Add a text layer to an existing PDF (keeps the original pages)
const doc2 = await scribe.openDocument(['image-only.pdf']);
await doc2.recognize();
await doc2.download('pdf', 'image-only.searchable.pdf');
```

When the input is a PDF that already contains text, `scribe.opt.usePDFText` controls whether that
text is used as the primary or supplemental source, separately for native (visible) text and OCR
(invisible) text layers. See [Configuration](#configuration).

## Configuration

Global options live on `scribe.opt` (the `opt` class). Set them before the relevant operation;
`workerN` must be set before workers initialize. The most useful options:

```js
// Languages and workers
scribe.opt.langPath = null;   // dir of <lang>.traineddata.gz; null = CDN
scribe.opt.workerN = null;    // worker count; null = up to 6 (browser) / 8 (Node)

// Text output
scribe.opt.reflow = true;        // combine lines into paragraphs
scribe.opt.lineNumbers = false;  // prefix lines with page:line (txt only)
scribe.opt.removeMargins = false;

// PDF / image output
scribe.opt.displayMode = 'invis';   // 'invis' | 'proof' | 'ebook'
scribe.opt.colorMode = 'color';     // 'color' | 'gray' | 'binary'
scribe.opt.autoRotate = true;
scribe.opt.includeImages = false;   // include page images in HTML export

// PDF text handling and confidence thresholds
scribe.opt.usePDFText = { native: { supp: true, main: true }, ocr: { supp: true, main: false } };
scribe.opt.confThreshHigh = 85;
scribe.opt.confThreshMed = 75;

// Sessions
scribe.opt.compressScribe = true;        // gzip .scribe output
scribe.opt.includeExtraTextScribe = false;

// Handlers
scribe.opt.progressHandler = (msg) => {};
scribe.opt.warningHandler = (msg) => console.warn(msg);
scribe.opt.errorHandler = (msg) => console.error(msg);
```

See the [`opt` class](../js/containers/app.js) for the complete list.

## Browser usage notes

- **Same origin.** All Scribe.js files must be served from the same origin as the importing code.
  CDN imports do not work and there is no UMD build.
- **Assets.** Tesseract `.traineddata` files load from a CDN by default; point `opt.langPath` at a
  same-origin directory to self-host them.
- **Inputs.** Use a `File`/`FileList` from an `<input type="file">`, or same-origin URLs.
- **Templates.** Working setups for common build systems are listed in the
  [README](../README.md#templates) (ESM/no-build, Next.js, Webpack 5, Vue 2).
