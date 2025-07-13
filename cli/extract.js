import fs from 'node:fs';
import path from 'node:path';
import scribe from '../scribe.js';

/**
 *
 * @param {string} pdfFile - Path to PDF file.
 * @param {?string} [output='.'] - Output file or directory.
 * @param {Object} [options]
 * @param {Parameters<typeof scribe.download>[0]} [options.format]
 * @param {boolean} [options.reflow]
 */
export const extract = async (pdfFile, output, options) => {
  const format = options?.format || 'txt';

  output = output || '.';
  const outputDir = path.dirname(output);
  const outputFile = outputDir === output ? `${path.basename(pdfFile).replace(/\.\w{1,6}$/i, `.${format}`)}` : path.basename(output);
  const outputPath = `${outputDir}/${outputFile}`;

  scribe.opt.reflow = true;
  scribe.opt.extractText = true;

  await scribe.init();
  await scribe.importFiles([pdfFile]);

  if (outputDir) fs.mkdirSync(outputDir, { recursive: true });

  await scribe.download(format, outputPath);

  await scribe.terminate();
};
