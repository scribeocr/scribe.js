import { detectPDFType } from './detectPDFType.js';
import { extract } from './extract.js';
import {
  check,
  conf,
  debug,
  evalInternal, overlay, recognize,
} from './main.js';

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

/**
 *
 * @param {string} inputFile - Path to PDF file.
 * @param {?string} [outputDir='.'] - Output directory.
 * @param {Object} [options]
 * @param {"pdf" | "hocr" | "docx" | "xlsx" | "txt" | "text" | "html"} [options.format]
 * @param {boolean} [options.reflow]
 */
export const extractCLI = async (inputFile, outputDir, options) => {
  await extract(inputFile, outputDir, options);
  process.exitCode = 0;
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
