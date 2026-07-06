# Scribe.js Command-Line Interface

Installing the package provides a `scribe` command (run `npx scribe <command>` locally, or
`scribe` if installed globally).

For the JavaScript API, see the [Guide](./guide.md) and the [API reference](./API.md).

## The two most common uses

**Add an invisible text layer to a PDF** (make it searchable). Runs OCR on each page and writes
a searchable PDF to the output directory:

```sh
npx scribe recognize input.pdf --output ./out
```

**Extract the text from a PDF** to a file. Pulls the existing text out of a PDF; it does **not**
run OCR (use `recognize` for that), so a page whose text is only in a scanned image produces no text:

```sh
npx scribe extract input.pdf output.txt
```

Pass `-f docx`, `-f hocr`, `-f xlsx`, `-f md`, or `-f pdf` to `extract` to write a different
format instead of plain text.

The rest of this page lists every command and flag.

## Commands

| Command | Purpose |
| --- | --- |
| `extract <input> [output]` | Extract text from a PDF and save in a chosen format. |
| `render <input> [out_dir]` | Render each PDF page to a PNG image. |
| `subset <input> [output]` | Write a new PDF containing only the selected pages. |
| `recognize <files...>` | Run the built-in OCR engine and write a searchable PDF. |
| `overlay <files...>` | Add provided OCR data to a PDF as a text layer. |
| `type <pdf> [output]` | Detect PDF type: text-native, image + OCR text, or image-native. |
| `conf <ocr_file>` | Report a confidence metric from existing OCR data. |
| `check <files...>` | Confidence by re-running OCR and comparing to provided data. |
| `eval <files...>` | Evaluate the OCR engine against a ground-truth OCR file. |
| `debug <files...> [out_dir]` | Write Tesseract debug visualizations. |

Every command accepts a PDF and, where relevant, one or more OCR files (`.hocr` or Abbyy
`.xml`).

## Common flags

| Flag | Commands | Meaning |
| --- | --- | --- |
| `-f, --format <ext>` | `extract` | `pdf`, `hocr`, `docx`, `xlsx`, `txt`, `text`, `html`, `md`. Default `txt`. |
| `-r, --reflow` | `extract` | Combine lines into paragraphs. |
| `-d, --dir` | `extract` | Process every supported file in the input directory (one output file per input). |
| `-R, --recursive` | `extract` | With `--dir`, recurse into subdirectories; output mirrors the input tree. |
| `-w, --workers <n>` | `extract` | With `--dir`, number of documents to extract in parallel. Default `4`. |
| `-l, --line-numbers` | `extract` | Prefix each line with `page:line` (txt only). |
| `--dpi <number>` | `render` | Render resolution in dots per inch. Default `150`. |
| `--pages <range>` | `render` | Comma/range list of 0-based pages to render (e.g. `0-4,7`). Default: all. |
| `--gray` | `render` | Render in grayscale instead of color. |
| `--pages <range>` | `subset` | Comma/range list of 0-based pages to keep (e.g. `0-4,7`). Required. |
| `-o, --output <dir>` | `recognize`, `overlay`, `debug` | Output directory. |
| `-v, --vis` | `recognize`, `overlay` | Print OCR text visibly, colored by confidence. |
| `-h, --hocr` | `recognize` | Also write intermediate `.hocr`. |
| `-c, --conf` | `overlay` | Print the average confidence metric. |
| `--robust` | `overlay` | Confidence by re-running OCR rather than trusting provided data. |
| `-w, --workers <n>` | `check`, `eval`, `overlay`, `recognize` | Worker count (default up to 8). |
| `--model <name>` | `recognize` | Use a cloud recognition model instead of the built-in Tesseract engine. See [Cloud models](#cloud-models). |
| `-O, --model-option <key=value>` | `recognize` | Option forwarded to the cloud model. Repeatable. Coerces `true`/`false`/numbers, and comma-separated values to arrays. |
| `--local-adapters` | `recognize` | Resolve `--model` from this repo's `cloud-adapters/` tree instead of npm. For running from a scribe.js checkout. Also enabled by `SCRIBE_LOCAL_ADAPTERS=1`. |

## Cloud models

`recognize --model <name>` swaps the built-in Tesseract engine for a hosted OCR service. Each cloud model lives in its own `@scribe.js/*` adapter package so that users who only want Tesseract pay for none of the cloud SDK dependencies. Install just the adapter you plan to use.

| Name | Adapter package | Install |
| --- | --- | --- |
| `textract` | `@scribe.js/aws-textract` | `npm install @scribe.js/aws-textract` |
| `azure-doc-intel` | `@scribe.js/azure-doc-intel` | `npm install @scribe.js/azure-doc-intel` |
| `google-doc-ai` | `@scribe.js/gcs-doc-ai` | `npm install @scribe.js/gcs-doc-ai` |
| `google-vision` | `@scribe.js/gcs-vision` | `npm install @scribe.js/gcs-vision` |

Credentials are resolved through each provider's standard mechanisms (AWS SDK chain, Google ADC, Azure env vars, etc.). See the matching adapter README for the full list of credential and option fields.

Pass model-specific options with `-O key=value` (repeatable):

```sh
npx scribe recognize input.pdf \
  --model textract \
  -O analyzeLayout=true \
  -O region=us-east-1,us-west-2
```

If the adapter package is not installed, the CLI prints the exact `npm install` command and exits non-zero.

### Running from a scribe.js checkout

Contributors who clone the repo can skip `npm install @scribe.js/<adapter>` and use the in-repo adapter sources under `cloud-adapters/`. Pass `--local-adapters` (or export `SCRIBE_LOCAL_ADAPTERS=1`) and the loader resolves the model from `cloud-adapters/<adapter>/` instead of `node_modules`:

```sh
# one-time: install the adapter's runtime SDK deps
( cd cloud-adapters/aws-textract && npm install )

node cli/scribe.js recognize input.pdf --model textract --local-adapters
```

The cloud SDK (`@aws-sdk/client-textract`, …) is still required and not bundled with scribe.js; install it inside the adapter directory or at the repo root. If `--local-adapters` is passed but `cloud-adapters/` is not present (e.g. you installed scribe.js from npm, which does not ship that tree), the CLI errors with a checkout-required message.

## More examples

```sh
# Extract the text of every PDF in a folder to .txt files (one per input)
npx scribe extract ./docs ./out --dir

# Recurse into subfolders (output mirrors the input tree), 8 documents in parallel
npx scribe extract ./docs ./out --dir --recursive --workers 8

# Add an existing hOCR text layer to a PDF
npx scribe overlay input.pdf input.hocr --output ./out

# Detect whether a PDF needs OCR
npx scribe type input.pdf

# Render every page of a PDF to PNG images in ./out (one file per page)
npx scribe render input.pdf ./out --dpi 300

# Render only the first three pages, in grayscale
npx scribe render input.pdf ./out --pages 0-2 --gray

# Write a new PDF containing only pages 0-4 and 7
npx scribe subset input.pdf output.pdf --pages 0-4,7
```

Output images are named `<input-stem>-<page>.png` (0-based), e.g. `input-0.png`.
When `subset`'s output is a directory (or omitted), the file is named after the kept pages, e.g.
`<input-stem>-p10.pdf` or `<input-stem>-p0-4_7.pdf`.

Run `npx scribe --help` or `npx scribe <command> --help` for the full list.
