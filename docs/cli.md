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

**Extract the text from a PDF** to a file. Pulls existing text from text-native PDFs and runs
OCR on image-based pages:

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
| `-d, --dir` | `extract` | Process all supported files in the input directory. |
| `-l, --line-numbers` | `extract` | Prefix each line with `page:line` (txt only). |
| `-o, --output <dir>` | `recognize`, `overlay`, `debug` | Output directory. |
| `-v, --vis` | `recognize`, `overlay` | Print OCR text visibly, colored by confidence. |
| `-h, --hocr` | `recognize` | Also write intermediate `.hocr`. |
| `-c, --conf` | `overlay` | Print the average confidence metric. |
| `--robust` | `overlay` | Confidence by re-running OCR rather than trusting provided data. |
| `-w, --workers <n>` | `check`, `eval`, `overlay`, `recognize` | Worker count (default up to 8). |

## More examples

```sh
# Extract every PDF in a folder to searchable PDFs
npx scribe extract ./scans ./out --format pdf --dir

# Add an existing hOCR text layer to a PDF
npx scribe overlay input.pdf input.hocr --output ./out

# Detect whether a PDF needs OCR
npx scribe type input.pdf
```

Run `npx scribe --help` or `npx scribe <command> --help` for the full list.
