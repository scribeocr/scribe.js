<!-- Hand-maintained API reference. Update it alongside changes to the public API in
     scribe.js and js/containers/scribeDoc.js. -->

# API Reference

This is a reference for the Scribe.js public API. For task-oriented documentation and examples,
start with the [Guide](./guide.md).

The package's default export (`import scribe from 'scribe.js-ocr'`) exposes the top-level
functions below, the [`ScribeDoc`](#scribedoc) class, the [`opt`](#scribeopt) configuration
object, and a [`utils`](#scribeutils) namespace.

## Contents

- [Top-level functions](#top-level-functions)
  - [`scribe.init`](#scribeinitparams)
  - [`scribe.openDocument`](#scribeopendocumentfiles)
  - [`scribe.extractText`](#scribeextracttextfiles-langs-outputformat-options)
  - [`scribe.terminate`](#scribeterminate)
- [`scribe.opt`](#scribeopt)
- [`scribe.ScribeDoc.defaults`](#scribescribedocdefaults)
- [`scribe.utils`](#scribeutils)
- [Other top-level exports](#other-top-level-exports)
- [ScribeDoc](#scribedoc)
  - [Properties](#properties)
  - [Import](#import-methods)
  - [Recognition](#recognition-methods)
  - [Export](#export-methods)
  - [Layout and tables](#layout-and-table-methods)
  - [Annotations](#annotation-methods)
  - [Rendering](#rendering-methods)
  - [Fonts](#font-methods)
  - [Lifecycle](#lifecycle-methods)
- [Data model](#data-model)

---

## Top-level functions

### `scribe.init(params?)`

Pre-load shared resources. Optional — the OCR engine and built-in fonts load automatically on
first use; pre-loading only reduces first-use latency. Each document's PDF renderer is created
lazily when that document opens a PDF.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `params.ocr` | `boolean` | `false` | Load the OCR engine. |
| `params.font` | `boolean` | `false` | Load the built-in fonts. |
| `params.ocrParams` | `Object` | `{}` | Parameters forwarded to OCR initialization. |

Returns `Promise<void>`.

### `scribe.openDocument(files)`

Open a new document from the provided files and return a handle to it. Equivalent to constructing
a [`ScribeDoc`](#scribedoc) and calling [`importFiles`](#docimportfilesfiles). Multiple documents
can be open at once; each operates on its own state.

| Parameter | Type | Description |
| --- | --- | --- |
| `files` | `Array<File>` \| `FileList` \| `Array<string>` \| [`SortedInputFiles`](#sortedinputfiles) | Files to import. A single array is sorted by extension; `ArrayBuffer` inputs require a `SortedInputFiles` object. |

Returns `Promise<ScribeDoc>`.

### `scribe.extractText(files, langs?, outputFormat?, options?)`

Convenience entry point that runs import, recognition, and export in one call. By default,
existing text is extracted from text-native PDFs; otherwise text is produced with OCR. Intended
for quick scripts and exploration: this call hides progress events, warning and error
handlers, recognition options, per-word OCR data, and the ability to produce more than one
output. Application code should use [`openDocument`](#scribeopendocumentfiles) and the
document's own methods.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `files` | same as `openDocument` | — | Files to process. |
| `langs` | `Array<string>` | `['eng']` | OCR languages. |
| `outputFormat` | export format string | `'txt'` | Any format accepted by [`exportData`](#docexportdataformat-options). |
| `options.skipRecPDFTextNative` | `boolean` | `true` | Skip OCR for text-native PDFs. |
| `options.skipRecPDFTextOCR` | `boolean` | `false` | Skip OCR for image PDFs that already have an invisible text layer. |

Returns `Promise<string \| ArrayBuffer>`.

### `scribe.terminate()`

Terminate shared resources (the general/OCR worker pool and built-in fonts). Per-document
resources are released with [`doc.terminate()`](#docterminate). Returns `Promise<void>`.

---

## `scribe.opt`

Process-wide configuration: worker count, asset paths, and handler callbacks shared across every
document. Set properties before the relevant operation; `workerN` must be set before workers
initialize. See [`js/containers/app.js`](../js/containers/app.js) for the complete, authoritative
list.

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `workerN` | `?number` | `null` | Worker count. `null` means up to 6 (browser) / 8 (Node). |
| `langPath` | `?string` | `null` | Directory containing `<lang>.traineddata.gz`. `null` means fetch from the jsdelivr CDN. |
| `usePdfSharedBuffer` | `boolean` | `false` | Share the loaded PDF across PDF workers via `SharedArrayBuffer` instead of cloning per worker. Requires a supported environment (Chrome with COOP/COEP, Node with shared memory enabled). |
| `progressHandler` | `(msg) => void` | no-op | Called with progress messages during recognition and export. |
| `warningHandler` | `(msg) => void` | `console.warn` | Called when Scribe.js emits a warning. |
| `errorHandler` | `(msg) => void` | `console.error` | Called when Scribe.js emits an error. |

## `scribe.ScribeDoc.defaults`

Per-document settings — recognition, rendering, and export behavior. Every export, recognition,
and import function resolves a setting as `options.X ?? ScribeDoc.defaults.X`, so mutating
`ScribeDoc.defaults` changes the default for every subsequent call, and passing `options.X` to
`exportData`, `download`, `importFiles`, or `recognize` overrides it for that one call. See
[`js/containers/scribeDocDefaults.js`](../js/containers/scribeDocDefaults.js) for the complete,
authoritative list.

Frequently used: `displayMode`, `colorMode`, `autoRotate`, `reflow`, `lineNumbers`,
`removeMargins`, `includeImages`, `usePDFText`, `keepPDFTextAlways`, `confThreshHigh`,
`confThreshMed`, `overlayOpacity`, `addOverlay`, `compressScribe`, `includeExtraTextScribe`,
`keepRawData`, `skipFontOpt`, `saveDebugImages`, `docxLineSplitMode`.

## `scribe.utils`

A namespace of helper functions, grouped by area. These are advanced building blocks; most
workflows do not need them.

- **OCR:** `assignParagraphs`, `calcConf`, `calcEvalStatsDoc`, `mergeOcrWords`,
  `checkOcrWordsAdjacent`, `splitOcrWord`, `ocr` (OCR object constructors and helpers).
- **Layout / tables:** `calcColumnBounds`, `calcTableBbox`, `extractSingleTableContent`,
  `detectTablesInPage`, `makeTableFromBbox`.
- **Fonts:** `calcWordMetrics`.
- **Export:** `writePdf`, `writeHocr`, `writeText`, `writeXlsx`, `writeXlsxFromRows`,
  `replaceType3FontsWithCorrected`, `extractType3DistinctGlyphs`.
- **Misc:** `calcBoxOverlap`, `convertToCSV`, `replaceSmartQuotes`, `getRandomAlphanum`,
  `countSubstringOccurrences`, `coords`, `imageStrToBlob`, `saveAs`.
- **Debug (Node.js):** `writeDebugCsv`, `drawDebugImages`, `dumpDebugImages`, `dumpHOCR`.

## Other top-level exports

- `scribe.ScribeDoc` — the [`ScribeDoc`](#scribedoc) class.
- `scribe.combineOCRPage` — merge one OCR page into another.
- `scribe.createTablesFromText` / `scribe.extractTextFromTables` — table extraction helpers.
- `scribe.layout` — layout object definitions.

---

## ScribeDoc

A single document being processed, holding its imported pages, OCR text, layout, and fonts.
Create one with [`scribe.openDocument`](#scribeopendocumentfiles) (recommended) or `new
scribe.ScribeDoc()` followed by [`doc.importFiles`](#docimportfilesfiles).

### Properties

| Property | Type | Description |
| --- | --- | --- |
| `id` | `number` | Process-unique id, used to namespace this document's fonts. |
| `inputData` | `InputData` | Input modes and file metadata (see [Data model](#inputdata)). |
| `ocr` | `Object<string, Array<OcrPage>>` | OCR versions by name; `ocr.active` is used for export. |
| `ocrRaw` | `Object<string, Array<string>>` | Raw OCR source data (kept when `ScribeDoc.defaults.keepRawData`). |
| `pageMetrics` | `Array<PageMetrics>` | Per-page dimensions and rotation. |
| `layoutRegions` | `{ pages: Array<LayoutPage> }` | Layout regions used for reflow/reorder. |
| `layoutDataTables` | `{ pages: Array<LayoutDataTablePage> }` | Detected data tables. |
| `annotations` | `{ pages: Array<Array<AnnotationHighlight>> }` | Highlight annotations. |
| `fonts` | `DocFonts` | Document-scoped font container. |
| `images` | `ImageStore` | Document-scoped image cache. |
| `debug` | `{ debugImg: {...} }` | Debug visualization images. |

### Import methods

#### `doc.importFiles(files)`

Import files into this document, replacing any current contents. A single array is sorted by
extension; `ArrayBuffer` inputs require a [`SortedInputFiles`](#sortedinputfiles) object.

| Parameter | Type |
| --- | --- |
| `files` | `Array<File>` \| `FileList` \| `Array<string>` \| `SortedInputFiles` |

Returns `Promise<void>`. (Async)

#### `doc.importFilesSupp(files, ocrName)`

Import supplemental OCR files (e.g. an alternate OCR version or ground truth) under `ocrName`,
without replacing `doc.ocr.active`.

| Parameter | Type | Description |
| --- | --- | --- |
| `files` | `Array<File>` \| `FileList` \| `Array<string>` \| `SortedInputFiles` | OCR files. |
| `ocrName` | `string` | Name to store the version under in `doc.ocr`. |

Returns `Promise<void>`. (Async)

### Recognition methods

#### `doc.recognize(options?)`

Recognize all of this document's pages with the OCR engine. Returns the recognized pages and
populates `doc.ocr`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `'speed' \| 'quality'` | `'quality'` | Convenience mode (`speed` -> LSTM, `quality` -> Legacy). |
| `langs` | `Array<string>` | `['eng']` | Languages in the document. |
| `modeAdv` | `'lstm' \| 'legacy' \| 'combined'` | `'combined'` | Engine selection. Overrides `mode`. |
| `combineMode` | `'conf' \| 'data' \| 'none'` | `'data'` | How to combine with existing OCR data. |
| `vanillaMode` | `boolean` | `false` | Use the unmodified Tesseract.js model. |
| `config` | `Object<string, string>` | `{}` | Raw Tesseract config parameters. |
| `model` | `RecognitionModel` | — | Custom recognition model (cloud adapters). |
| `modelOptions` | `Object` | `{}` | Options forwarded to the custom model. |
| `signal` | `AbortSignal` | — | Cancel a custom-model run; completed pages are preserved. |

Returns `Promise<Array<OcrPage>>`. (Async)

#### `doc.compareOCR(ocrA, ocrB, options?, progressCallback?)`

Compare two sets of OCR data and return comparison results and metrics. Used for evaluation and
for combining engine outputs. Returns `Promise<Object>`. (Async)

#### `doc.recognizePageImp(n, legacy, lstm, areaMode, tessOptions?, debugVis?, langs?, vanillaMode?)`

Low-level recognition of a single page (or sub-region) with fine-grained engine control.
Most callers should use [`recognize`](#docrecognizeoptions) instead. (Async)

#### `doc.evalOCRPage(params)`

Evaluate the OCR accuracy of a single page or line against ground truth.

| `params` field | Type | Description |
| --- | --- | --- |
| `page` | `OcrPage \| OcrLine` | The page or line to evaluate. |
| `func` | `function` | Optional scoring function. |
| `view` | `boolean` | Whether to produce a visualization. |

Returns `Promise<Object>` with evaluation metrics. (Async)

### Export methods

#### `doc.exportData(format?, options?)`

Export this document's active OCR data to the specified format.

| Parameter | Type | Default | Description |
| --- | --- | --- | --- |
| `format` | `'pdf' \| 'hocr' \| 'alto' \| 'docx' \| 'html' \| 'xlsx' \| 'txt' \| 'text' \| 'md' \| 'scribe'` | `'txt'` | Output format. |
| `options.minPage` | `number` | `0` | First page to export. |
| `options.maxPage` | `number` | `-1` | Last page (inclusive); `-1` means the last page. |
| `options.pageArr` | `Array<number>` | `null` | Explicit 0-based page indices. Overrides `minPage`/`maxPage`. |

Returns `Promise<string \| ArrayBuffer>` (string for text formats, `ArrayBuffer` for `pdf`,
`docx`, `xlsx`, and compressed `scribe`). (Async)

#### `doc.download(format, fileName, options?)`

Run [`exportData`](#docexportdataformat-options) and save the result — a browser download or a
Node.js file write. `fileName`'s extension is normalized to match `format`. Same `options` as
`exportData`. Returns `Promise<void>`. (Async)

### Layout and table methods

#### `doc.deleteLayoutRegion(region, n)`

Remove a layout region (matched by `region.id`) from page `n`.

#### `doc.deleteLayoutDataTable(table, n)`

Remove a data table (matched by `table.id`) from page `n`.

#### `doc.serializeLayoutDataTables()`

Serialize the document's data tables to a JSON string, stripping circular references. Returns
`string`.

### Annotation methods

#### `doc.addHighlights(highlights)`

Add highlight annotations using `page:line` references or page-level quote matching. Returns an
object summarizing applied highlights (`{ highlightsApplied, totalLinesHighlighted, groups }`).

#### `doc.clearHighlights()`

Remove all highlights previously added by `addHighlights`.

### Rendering methods

#### `doc.renderPageStatic(page)`

Render a page to a canvas, including the OCR text drawn over the page image. `page` is a page
number or page object.

### Font methods

#### `doc.runOptimization(ocrArr)`

Run font optimization and validation for this document based on the provided OCR pages. Returns
`Promise<void>`. (Async)

#### `doc.enableFontOpt(enable, force?)`

Enable or disable use of optimized fonts for this document, syncing the change to worker threads.
Optimized fonts must already exist (via `runOptimization`). Returns `Promise<void>`. (Async)

### Lifecycle methods

#### `doc.preloadPdfWorkers()`

Spawn this document's PDF worker pool ahead of any [`importFiles`](#docimportfilesfiles) call so
the workers are already running by the time a PDF arrives. The pool is created lazily on first
PDF access otherwise; pre-loading only reduces first-use latency. No-op if the pool already
exists. Workers survive [`clear`](#docclear), so the same document can pre-load once and then
import multiple PDFs in sequence. Returns `Promise<void>`. (Async)

#### `doc.clear()`

Reset all of this document's OCR text, layout, image caches, and font registrations. Keeps the
PDF worker pool alive so the document can be re-used for another file via
[`importFiles`](#docimportfilesfiles). Use [`terminate`](#docterminate) instead to also release
the workers.

#### `doc.terminate()`

Release this document's resources: terminate its PDF worker pool, clear its image cache, and drop
its optimized fonts. Does not touch the shared OCR pool or built-in fonts (use
[`scribe.terminate`](#scribeterminate) for those). Returns `Promise<void>`. (Async)

---

## Data model

### OcrPage / OcrLine / OcrWord

OCR results are a tree of pages, lines, and words.

```
OcrPage  { dims, angle, lines: OcrLine[] }
OcrLine  { bbox, baseline, words: OcrWord[] }
OcrWord  { text, conf, bbox, style, chars, ... }
```

`OcrWord` fields most callers read:

| Field | Type | Description |
| --- | --- | --- |
| `text` | `string` | The recognized text. |
| `conf` | `number` | Confidence, 0-100. |
| `bbox` | `{ left, top, right, bottom }` | Word bounds in page pixels. |
| `style` | `Object` | `{ font, size, bold, italic, underline, smallCaps, sup, dropcap, color, opacity }`. |
| `chars` | `Array<OcrChar> \| null` | Character-level data when available. |
| `lang` | `string` | Word language. |

### PageMetrics

Per-page geometry in `doc.pageMetrics[n]`: page `dims` (`{ width, height }`) and rotation
`angle`.

### InputData

`doc.inputData` describes the imported input.

| Field | Type | Description |
| --- | --- | --- |
| `pdfMode` | `boolean` | Input is a PDF. |
| `imageMode` | `boolean` | Input is image files. |
| `pdfType` | `'text' \| 'ocr' \| 'image' \| null` | PDF classification. |
| `xmlMode` | `Array<boolean>` | Whether OCR data exists per page. |
| `pageCount` | `number` | Total pages. |
| `inputFileNames` | `Array<string>` | Source file names. |

### SortedInputFiles

An object form of input that names each file type explicitly. Required for `ArrayBuffer` inputs.

| Property | Type |
| --- | --- |
| `pdfFiles` | `Array<File>` \| `Array<string>` \| `Array<ArrayBuffer>` |
| `imageFiles` | `Array<File>` \| `Array<string>` \| `Array<ArrayBuffer>` |
| `ocrFiles` | `Array<File>` \| `Array<string>` \| `Array<ArrayBuffer>` |
| `scribeFiles` | `Array<File>` \| `Array<string>` \| `Array<ArrayBuffer>` |
