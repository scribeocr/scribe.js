// Code for adding visualization to OCR output
// Use: `node addOverlay.js [PDF file] [OCR data file] [output directory]`

import fs from 'node:fs';
import path from 'node:path';

import scribe from '../scribe.js';

const debugMode = false;

scribe.opt.saveDebugImages = debugMode;

/**
 * @param {string} func
 * @param {Object} params
 * @param {string[]} [params.files]
 * @param {string} [params.outputDir]
 * @param {Array<string>} [params.list]
 * @param {boolean} [params.robustConfMode]
 * @param {boolean} [params.printConf]
 * @param {boolean} [params.hocr]
 * @param {"eval" | "ebook" | "proof" | "invis"} [params.overlayMode]
 * @param {number} [params.workerN]
 */
async function main(func, params) {
  scribe.opt.workerN = params.workerN || null;

  if (!params.files || params.files.length === 0) {
    throw new Error('No input files provided.');
  }

  await scribe.init({
    pdf: true,
    ocr: true,
    font: true,
  });

  const robustConfMode = func === 'check' || params.robustConfMode || false;

  scribe.opt.displayMode = params.overlayMode || 'invis';
  const combineMode = robustConfMode ? 'conf' : 'data';

  const output = {};

  await scribe.importFiles(params.files);

  const outputStem = scribe.inputData.defaultDownloadFileName.replace(/\.\w{1,6}$/i, '') || 'output';

  const outputDir = params.outputDir || '.';

  if (outputDir) fs.mkdirSync(outputDir, { recursive: true });

  // Is this comment still relevant?
  // TODO: (1) Find out why font data is not being imported correctly from .hocr files.
  // (2) Use Tesseract Legacy font data when (1) recognition is being run anyway and (2) no font metrics data exists already.
  if (robustConfMode || func === 'eval' || func === 'recognize') {
    await scribe.recognize({
      modeAdv: 'combined',
      combineMode,
    });
    if (func === 'recognize') {
      output.text = scribe.data.ocr.active.map((x) => scribe.utils.ocr.getPageText(x)).join('\n');
    }
  }

  if (func === 'check' || func === 'conf' || params.printConf) {
    const { highConf, total } = scribe.utils.calcConf(scribe.data.ocr.active);
    console.log(`Confidence: ${highConf / total} (${highConf} of ${total})`);
    if (func === 'conf') {
      scribe.terminate();
      return output;
    }
  }

  if (['overlay', 'recognize'].includes(func) && (scribe.inputData.pdfMode || scribe.inputData.imageMode)) {
    let outputSuffix = '';
    if (scribe.opt.displayMode === 'proof') {
      outputSuffix = '_vis';
    } else if (scribe.opt.displayMode === 'invis') {

      // Check if output file would overwrite any input file, and if so, add a suffix to avoid overwriting.
      // This software is still in development--nobody should be ovewriting input files.
      const resolvedOutputFileTmp = path.resolve(`${outputDir}/${outputStem}.pdf`);
      for (let i = 0; i < params.files.length; i++) {
        const resolvedInputFile = path.resolve(params.files[i]);
        if (resolvedInputFile === resolvedOutputFileTmp) {
          outputSuffix = '_ocr';
          console.log(`Saving output with ${outputSuffix} suffix to avoid overwriting input: ${resolvedInputFile}`);
          break;
        }
      }
    }

    const outputPath = path.resolve(`${outputDir}/${outputStem}${outputSuffix}.pdf`);
    await scribe.download('pdf', outputPath);

    if (params.hocr) {
      const outputPathHocr = path.resolve(`${outputDir}/${outputStem}.hocr`);
      await scribe.download('hocr', outputPathHocr);
    }
  }

  if (debugMode) {
    const debugDir = `${outputDir}/${outputStem}_debug`;
    fs.mkdirSync(debugDir, { recursive: true });
    const outputPathCsv = `${debugDir}/_debug.csv`;
    scribe.utils.writeDebugCsv(scribe.data.ocr.active, outputPathCsv);

    scribe.utils.dumpDebugImages(debugDir);
    scribe.utils.dumpHOCR(debugDir);

    for (let i = 0; i < scribe.data.ocr.active.length; i++) {
      const outputPathPngI = `${debugDir}/page_vis_${i}.png`;
      const img = await scribe.utils.renderPageStatic(scribe.data.ocr.active[i]);
      const imgData = new Uint8Array(atob(img.split(',')[1])
        .split('')
        .map((c) => c.charCodeAt(0)));
      fs.writeFileSync(outputPathPngI, imgData);
    }
  }

  scribe.terminate();

  return output;
}

/**
 * Print confidence of Abbyy .xml file.
 *
 * @param {string[]} files - Paths to input files.
 */
export const conf = async (files) => (main('conf', { files }));

/**
 *
 * @param {string[]} files - Paths to input files.
 * @param {Object} options
 * @param {number} [options.workers]
 */
export const check = async (files, options) => (main('check', { files, workerN: options?.workers }));

/**
 * Evaluate internal OCR engine.
 *
 * @param {string[]} files - Paths to input files.
 * @param {Object} options
 * @param {number} [options.workers]
 */
export const evalInternal = async (files, options) => (main('eval', { files, workerN: options?.workers }));

/**
 *
 * @param {string[]} files - Paths to input files.
 * @param {*} outputDir
 * @param {Object} options
 * @param {boolean} [options.robust]
 * @param {boolean} [options.conf]
 * @param {"eval" | "ebook" | "proof" | "invis"} [options.overlayMode]
 * @param {number} [options.workers]
 */
export const overlay = async (files, outputDir, options) => (main('overlay', {
  files, outputDir, robustConfMode: options?.robust || false, printConf: options?.conf || false, overlayMode: options?.overlayMode || 'invis', workerN: options?.workers,
}));

/**
 *
 * @param {string[]} files - Paths to input files.
 * @param {Object} options
 * @param {"eval" | "ebook" | "proof" | "invis"} [options.overlayMode]
 * @param {boolean} [options.hocr]
 * @param {number} [options.workers]
 */
export const recognize = async (files, options) => (main('recognize', {
  files, overlayMode: options?.overlayMode || 'invis', workerN: options?.workers, hocr: options?.hocr,
}));

/**
 *
 * @param {string[]} files - Paths to input files.
 * @param {*} outputDir
 * @param {*} options
 */
export const debug = async (files, outputDir, options) => (main('debug', {
  files, outputDir, list: options?.list,
}));
