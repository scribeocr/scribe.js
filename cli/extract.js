import fs from 'node:fs';
import path from 'node:path';
import scribe from '../scribe.js';

// TODO: Consider whether this should exist and whether it should be combined into a larger CLI utility.
// This was originally created to provide a simple interface to extract existing text from a PDF file,
// however it now does other things, and this should likely be part of a larger `convert` utility.

/**
 *
 * @param {string} inputFile - Path to input file.
 * @param {?string} [output='.'] - Output file or directory.
 * @param {Object} [options]
 * @param {Parameters<typeof scribe.download>[0]} [options.format]
 * @param {boolean} [options.reflow]
 */
export const extract = async (inputFile, output, options) => {
  const format = options?.format || 'txt';

  output = output || '.';
  const outputDir = path.dirname(output);
  const outputFile = outputDir === output ? `${path.basename(inputFile).replace(/\.\w{1,6}$/i, `.${format}`)}` : path.basename(output);
  const outputPath = `${outputDir}/${outputFile}`;

  scribe.opt.reflow = true;
  scribe.opt.extractText = true;
  scribe.opt.displayMode = 'ebook';

  // TODO: Fonts do not need to be loaded for .txt output, but are needed for .pdf output.
  // so a more robust implementation would consider the arguments and only load fonts if necessary.
  await scribe.init({ font: true });
  await scribe.importFiles([inputFile]);

  if (outputDir) fs.mkdirSync(outputDir, { recursive: true });

  await scribe.download(format, outputPath);

  await scribe.terminate();
};
