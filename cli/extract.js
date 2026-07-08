import fs from 'node:fs';
import path from 'node:path';
import scribe from '../scribe.js';

// TODO: Consider whether this should exist and whether it should be combined into a larger CLI utility.
// This was originally created to provide a simple interface to extract existing text from a PDF file,
// however it now does other things, and this should likely be part of a larger `convert` utility.

/**
 * Extract a single document's existing text to one output file (no OCR).
 * Single-file path only. The CLI `--dir` batch is handled by `extractTextDir`, never here.
 *
 * @param {string} inputFile - Path to input file.
 * @param {?string} [output='.'] - Output file or directory.
 * @param {Object} [options]
 * @param {'pdf'|'hocr'|'alto'|'docx'|'xlsx'|'txt'|'text'|'md'|'html'|'scribe'|'scribe.json'} [options.format]
 * @param {boolean} [options.reflow]
 * @param {boolean} [options.lineNumbers]
 * @param {boolean} [options.charBoxes]
 */
export const extract = async (inputFile, output, options) => {
  const format = options?.format || 'txt';

  output = output || '.';
  const outputDir = path.dirname(output);
  const outputFile = outputDir === output ? `${path.basename(inputFile).replace(/\.\w{1,6}$/i, `.${format}`)}` : path.basename(output);
  const outputPath = `${outputDir}/${outputFile}`;

  // Single-file extraction always overwrites an existing output; skip-existing is scoped to --dir.
  if (path.resolve(inputFile) === path.resolve(outputPath)) {
    throw new Error(`Output path '${outputPath}' is the same as the input; refusing to overwrite the source. Choose a different output path or format.`);
  }

  scribe.ScribeDoc.defaults.reflow = true;
  scribe.ScribeDoc.defaults.usePDFText.ocr.main = true;
  scribe.ScribeDoc.defaults.displayMode = 'ebook';

  // Run everything on the main thread.
  // When running inexpensive operations (no OCR) in the CLI (1 document, no re-used workers),
  // loading workers often slows things down in absolute terms.
  // In all cases, users are better off running the CLI in parallel at the document level (e.g. using GNU Parallel).
  scribe.opt.inProcess = true;

  // TODO: Fonts do not need to be loaded for .txt output, but are needed for .pdf output.
  // so a more robust implementation would consider the arguments and only load fonts if necessary.
  const doc = await scribe.openDocument([inputFile]);

  if (outputDir) fs.mkdirSync(outputDir, { recursive: true });

  if (options?.lineNumbers) scribe.ScribeDoc.defaults.lineNumbers = true;

  // Char boxes (`word.chars`) are excluded from scribe output by default; --char-boxes re-includes them.
  // Harmless for non-scribe formats, which never carry char boxes.
  const includeCharBoxesScribe = !!options?.charBoxes;

  if (format === 'scribe.json') {
    // Uncompressed scribe export; with compression off exportData returns the JSON string to write directly.
    fs.writeFileSync(outputPath, /** @type {string} */ (await doc.exportData('scribe', { compressScribe: false, includeCharBoxesScribe })));
  } else {
    await doc.download(format, outputPath, { includeCharBoxesScribe });
  }

  await doc.terminate();
  await scribe.terminate();
};
