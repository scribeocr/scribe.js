import fs from 'node:fs';
import scribe from '../scribe.js';

/**
 * Render each selected page of a PDF to a PNG image file.
 *
 * @param {string} inputFile - Path to the input PDF file.
 * @param {?string} [outputDir='.'] - Directory to write page images into.
 * @param {Object} [options]
 * @param {string|number} [options.dpi=150] - Render resolution in dots per inch.
 * @param {string} [options.pages] - Comma/range list of 0-based pages (e.g. "0-4,7"). Default: all pages.
 * @param {boolean} [options.gray] - Render in grayscale instead of color.
 */
export const render = async (inputFile, outputDir, options) => {
  outputDir = outputDir || '.';
  const dpi = Number(options?.dpi) || 150;
  const colorMode = options?.gray ? 'gray' : 'color';

  let requestedPages = null;
  if (options?.pages) {
    requestedPages = [];
    for (const token of options.pages.split(',')) {
      const [a, b] = token.split('-');
      const start = parseInt(a, 10);
      const end = b !== undefined ? parseInt(b, 10) : start;
      if (Number.isNaN(start) || Number.isNaN(end)) {
        throw new Error(`Invalid --pages value: '${options.pages}'. Use 0-based numbers and ranges, e.g. 0-4,7.`);
      }
      for (let p = start; p <= end; p++) requestedPages.push(p);
    }
    requestedPages = [...new Set(requestedPages)].sort((x, y) => x - y);
  }

  await scribe.init({ font: true });
  const doc = await scribe.openDocument([inputFile]);

  try {
    const { pageCount } = doc.inputData;

    if (!doc.images.pdfDims300?.length) {
      throw new Error(`Cannot render '${inputFile}': the render command requires a PDF input.`);
    }

    const pageIndices = requestedPages || Array.from({ length: pageCount }, (_, i) => i);

    const outOfRange = pageIndices.find((p) => p < 0 || p >= pageCount);
    if (outOfRange !== undefined) {
      throw new Error(`Page ${outOfRange} out of range (document has ${pageCount} pages: 0-${pageCount - 1}).`);
    }

    fs.mkdirSync(outputDir, { recursive: true });

    const stem = doc.inputData.defaultDownloadFileName.replace(/\.\w{1,6}$/i, '') || 'output';
    const pdfScheduler = await doc.images.getPdfScheduler();

    for (const n of pageIndices) {
      const { dataUrl } = await pdfScheduler.renderPdfPage({ pageIndex: n, colorMode, dpi }, true);
      fs.writeFileSync(`${outputDir}/${stem}-${n}.png`, Buffer.from(dataUrl.split(',')[1], 'base64'));
    }
  } finally {
    await doc.terminate();
    await scribe.terminate();
  }
};
