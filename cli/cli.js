import fs from 'node:fs';
import path from 'node:path';

import { subsetPdf } from '../js/export/pdf/subsetPdf.js';
import scribe from '../scribe.js';
import { detectPDFType } from './detectPDFType.js';
import { extract } from './extract.js';
import {
  check,
  conf,
  debug,
  evalInternal, overlay, recognize,
} from './main.js';
import { loadRecognitionModel } from './recognitionModels.js';

/**
 * Parse a comma/range list of 0-based page numbers into sorted, deduplicated indices.
 *
 * @param {string} pagesStr - Comma/range list, e.g. "0-4,7".
 * @returns {number[]} Sorted unique 0-based page indices.
 */
const parsePageRange = (pagesStr) => {
  const pages = [];
  for (const token of pagesStr.split(',')) {
    const [a, b] = token.split('-');
    const start = parseInt(a, 10);
    const end = b !== undefined ? parseInt(b, 10) : start;
    if (Number.isNaN(start) || Number.isNaN(end)) {
      throw new Error(`Invalid --pages value: '${pagesStr}'. Use 0-based numbers and ranges, e.g. 0-4,7.`);
    }
    for (let p = start; p <= end; p++) pages.push(p);
  }
  return [...new Set(pages)].sort((x, y) => x - y);
};

/**
 * Print confidence of Abbyy .xml file.
 *
 * @param {string[]} files - Paths to input files.
 */
export const confCLI = async (files) => {
  await conf(files);
  process.exitCode = 0;
};

/**
 *
 * @param {string[]} files - Paths to input files.
 * @param {Object} options
 * @param {number} [options.workers]
 */
export const checkCLI = async (files, options) => {
  await check(files, options);
  process.exitCode = 0;
};

/**
 * Evaluate internal OCR engine.
 *
 * @param {string[]} files - Paths to input files.
 * @param {Object} options
 * @param {number} [options.workers]
 */
export const evalInternalCLI = async (files, options) => {
  const { evalMetrics } = await evalInternal(files, options);

  const ignoreExtra = true;
  let metricWER;
  if (ignoreExtra) {
    metricWER = Math.round(((evalMetrics.incorrect + evalMetrics.missed) / evalMetrics.total) * 100) / 100;
  } else {
    metricWER = Math.round(((evalMetrics.incorrect + evalMetrics.missed + evalMetrics.extra)
      / evalMetrics.total) * 100) / 100;
  }
  console.log(`Word Error Rate: ${metricWER}`);
  process.exitCode = 0;
};

const supportedExtensions = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif'];

/**
 *
 * @param {string} inputFile - Path to PDF file or directory.
 * @param {?string} [outputDir='.'] - Output directory.
 * @param {Object} [options]
 * @param {"pdf" | "hocr" | "docx" | "xlsx" | "txt" | "text" | "html"} [options.format]
 * @param {boolean} [options.reflow]
 * @param {boolean} [options.dir]
 */
export const extractCLI = async (inputFile, outputDir, options) => {
  if (options?.dir) {
    const files = fs.readdirSync(inputFile)
      .filter((file) => supportedExtensions.includes(path.extname(file).toLowerCase()))
      .map((file) => path.join(inputFile, file));

    if (files.length === 0) {
      console.error(`No supported files found in directory: ${inputFile}`);
      process.exitCode = 1;
      return;
    }

    const format = options?.format || 'txt';
    const outDir = outputDir || '.';

    for (const file of files) {
      const outputFileName = path.basename(file).replace(/\.\w{1,6}$/i, `.${format}`);
      const outputPath = path.join(outDir, outputFileName);
      await extract(file, outputPath, options);
    }
  } else {
    await extract(inputFile, outputDir, options);
  }
  process.exitCode = 0;
};

/**
 * Render each selected page of a PDF to a PNG image file.
 *
 * @param {string} inputFile - Path to input PDF file.
 * @param {?string} [outputDir='.'] - Output directory for page images.
 * @param {Object} [options]
 * @param {string} [options.dpi] - Render resolution in dots per inch. Default 150.
 * @param {string} [options.pages] - Comma/range list of 0-based pages (e.g. "0-4,7"). Default: all pages.
 * @param {boolean} [options.gray] - Render in grayscale instead of color.
 */
export const renderCLI = async (inputFile, outputDir, options) => {
  try {
    outputDir = outputDir || '.';
    const dpi = Number(options?.dpi) || 150;
    const colorMode = options?.gray ? 'gray' : 'color';

    const requestedPages = options?.pages ? parsePageRange(options.pages) : null;

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
        fs.writeFileSync(`${outputDir}/${stem}-${n}.png`, new Uint8Array(Buffer.from(dataUrl.split(',')[1], 'base64')));
      }
    } finally {
      await doc.terminate();
      await scribe.terminate();
    }
    process.exitCode = 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
};

/**
 * Write a new PDF containing only the selected pages of the input PDF.
 *
 * @param {string} inputFile - Path to input PDF file.
 * @param {?string} [output='.'] - Output PDF file, or directory to write `<stem>-p<pages>.pdf` into.
 * @param {Object} [options]
 * @param {string} [options.pages] - Comma/range list of 0-based pages to keep (e.g. "0-4,7"). Required.
 */
export const subsetCLI = async (inputFile, output, options) => {
  try {
    if (!options?.pages) throw new Error('The subset command requires --pages, e.g. --pages 0-4,7.');
    const pageIndices = parsePageRange(options.pages);

    output = output || '.';
    const intoDir = fs.existsSync(output) && fs.statSync(output).isDirectory();
    const stem = path.basename(inputFile).replace(/\.\w{1,6}$/i, '');

    /** @type {{ start: number, end: number }[]} */
    const groups = [];
    for (const i of pageIndices) {
      const last = groups[groups.length - 1];
      if (last && i === last.end + 1) last.end = i;
      else groups.push({ start: i, end: i });
    }
    const pagesSuffix = groups.map((g) => (g.start === g.end ? `${g.start}` : `${g.start}-${g.end}`)).join('_');
    const outputPath = intoDir ? path.join(output, `${stem}-p${pagesSuffix}.pdf`) : output;

    const pdfBytes = new Uint8Array(fs.readFileSync(inputFile));
    const subsetBytes = await subsetPdf(pdfBytes, pageIndices);

    const outputDir = path.dirname(outputPath);
    if (outputDir) fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputPath, new Uint8Array(subsetBytes));

    console.log(`Wrote ${pageIndices.length} page(s) to ${outputPath}`);
    process.exitCode = 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
};

/**
 *
 * @param {string} pdfFile - Path to PDF file.
 * @param {string} [outputPath] - Output file path.
 */
export const detectPDFTypeCLI = async (pdfFile, outputPath) => {
  await detectPDFType(pdfFile, outputPath);
  process.exitCode = 0;
};

/**
 *
 * @param {string[]} files - Paths to input files.
 * @param {Object} options
 * @param {string} [options.output] - Output directory for the resulting PDF.
 * @param {boolean} [options.robust]
 * @param {boolean} [options.conf]
 * @param {boolean} [options.vis]
 * @param {number} [options.workers]
 */
export const overlayCLI = async (files, options) => {
  options.overlayMode = options.vis ? 'proof' : 'invis';
  await overlay(files, options.output, options);
  process.exitCode = 0;
};

/**
 *
 * @param {string[]} files - Paths to input files.
 * @param {*} options
 */
export const recognizeCLI = async (files, options) => {
  options.overlayMode = options.vis ? 'proof' : 'invis';
  if (options.model) {
    try {
      options.model = await loadRecognitionModel(options.model, { localAdapters: options.localAdapters });
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
  }
  await recognize(files, options);
  process.exitCode = 0;
};

/**
 *
 * @param {string[]} files - Paths to input files.
 * @param {*} outputDir
 * @param {*} options
 */
export const debugCLI = async (files, outputDir, options) => {
  await debug(files, outputDir, options);
  process.exitCode = 0;
};
