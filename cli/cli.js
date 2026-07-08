import fs from 'node:fs';
import path from 'node:path';

import { subsetPdf, stripMetadataPdf } from '../js/export/pdf/subsetPdf.js';
import { getMetadata } from '../js/pdf/metadata/metadataInspect.js';
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

/**
 *
 * @param {string} inputFile - Path to PDF file or directory.
 * @param {?string} [outputDir='.'] - Output directory.
 * @param {Object} [options]
 * @param {"pdf" | "hocr" | "docx" | "xlsx" | "txt" | "text" | "html" | "md" | "scribe" | "scribe.json"} [options.format]
 * @param {boolean} [options.reflow]
 * @param {boolean} [options.lineNumbers]
 * @param {boolean} [options.dir]
 * @param {boolean} [options.recursive]
 * @param {string} [options.workers]
 * @param {boolean} [options.charBoxes]
 */
export const extractCLI = async (inputFile, outputDir, options) => {
  try {
    if (options?.dir) {
      const format = options.format || 'txt';
      const ext = format === 'text' ? 'txt' : format;
      // Default to a new `<input>-<ext>` directory so a batch never dumps loose files into the cwd.
      const outDir = outputDir || `${path.basename(inputFile)}-${ext}`;

      const isTTY = !!process.stderr.isTTY;
      const startTime = Date.now();
      let windowTime = startTime;
      let windowDone = 0;
      /** @type {(ms: number, n: number) => string} */
      const rate = (ms, n) => `${n > 0 ? (ms / n).toFixed(1) : '0.0'} ms/doc`;
      /** @type {(ms: number) => string} */
      const dur = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
      /** @type {(p: { extracted: number, skipped: number }) => string} */
      const counts = ({ extracted, skipped }) => (skipped
        ? `${extracted.toLocaleString()} extracted, ${skipped.toLocaleString()} skipped`
        : `${extracted.toLocaleString()} extracted`);

      process.stderr.write(`Extracting text from ${inputFile} to ${outDir}/ …\n`);
      /** @type {(p: { extracted: number, skipped: number }) => void} */
      const onProgress = (p) => {
        const done = p.extracted + p.skipped;
        const now = Date.now();
        if (done % 500 === 0) {
          // Persistent checkpoint: wall time per document over the last 500 files.
          const line = `  ${counts(p)} so far, ${rate(now - windowTime, done - windowDone)} over last ${done - windowDone}`;
          process.stderr.write(isTTY ? `\r\x1b[K${line}\n` : `${line}\n`);
          windowTime = now;
          windowDone = done;
        } else if (isTTY) {
          // Ongoing: cumulative wall time per document, refreshed each file.
          process.stderr.write(`\r\x1b[KExtracting… ${counts(p)} (${rate(now - startTime, done)})`);
        }
      };

      const summary = await scribe.extractTextDir(inputFile, outDir, {
        format,
        reflow: options.reflow,
        lineNumbers: options.lineNumbers,
        recursive: options.recursive,
        workers: options.workers ? Number(options.workers) : 4,
        charBoxes: options.charBoxes,
        onProgress,
      });

      const totalDocs = summary.extracted + summary.skipped;
      const totalMs = Date.now() - startTime;
      if (isTTY) process.stderr.write('\r\x1b[K'); // clear the transient live line before the summary

      let msg = `Extracted ${summary.extracted} file(s) to ${outDir}`;
      if (summary.skipped > 0) msg += `, skipped ${summary.skipped} that could not be read`;
      msg += totalDocs > 0 ? ` in ${dur(totalMs)} (${rate(totalMs, totalDocs)})` : ` in ${dur(totalMs)}`;
      console.log(`${msg}.`);
      for (const f of summary.failures.slice(0, 10)) {
        console.error(`  skipped ${f.inputPath}: ${f.error?.message || 'could not be read'}`);
      }
      if (summary.failures.length > 10) console.error(`  …and ${summary.failures.length - 10} more`);
    } else {
      await extract(inputFile, outputDir, options);
    }
    process.exitCode = 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
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
 * Print (or write as JSON) every category of identifying metadata embedded in a PDF.
 *
 * @param {string} pdfFile - Path to PDF file.
 * @param {Object} [options]
 * @param {boolean} [options.json] - Emit the raw metadata report as JSON instead of a summary.
 * @param {string} [options.output] - With --json, write the report to this file instead of stdout.
 */
export const metadataCLI = async (pdfFile, options) => {
  try {
    const pdfBytes = new Uint8Array(fs.readFileSync(pdfFile));
    const report = getMetadata(pdfBytes);

    if (options?.json) {
      const out = JSON.stringify(report, null, 2);
      if (options.output) {
        fs.writeFileSync(options.output, out);
        console.log(`Wrote metadata report to ${options.output}`);
      } else {
        console.log(out);
      }
      process.exitCode = 0;
      return;
    }

    const lines = [`Metadata in ${path.basename(pdfFile)}:`];
    if (report.info && Object.keys(report.info).length) {
      lines.push('\n  Document info (/Info):');
      for (const [k, v] of Object.entries(report.info)) lines.push(`    ${k}: ${v}`);
    }
    if (report.docId) lines.push(`\n  Document ID: ${report.docId}`);
    if (report.xmp.catalog) lines.push(`\n  XMP packet (document): ${report.xmp.catalog.length} bytes (use --json to see it in full)`);
    if (report.xmp.perObject.length) lines.push(`  XMP packets (per-object): ${report.xmp.perObject.length}`);
    if (report.customInfo && report.customInfo.length) {
      const fields = [...new Set(report.customInfo.flatMap((c) => c.keys))];
      lines.push(`\n  Custom document-info dictionaries: ${report.customInfo.length} (fields: ${fields.join(', ')})`);
    }
    if (report.annotationAuthors && report.annotationAuthors.length) {
      const names = [...new Set(report.annotationAuthors.map((a) => a.author))];
      lines.push(`\n  Comment/annotation authors: ${report.annotationAuthors.length} (${names.slice(0, 8).join(', ')})`);
    }
    if (report.pieceInfo.length) lines.push(`\n  Private application data (/PieceInfo): ${report.pieceInfo.length} object(s)`);
    if (report.ocgs.length) lines.push(`\n  Optional-content layers: ${report.ocgs.map((o) => o.name).join(', ')}`);
    if (report.embeddedFiles.length) lines.push(`\n  Embedded files: ${report.embeddedFiles.map((f) => f.name || '(unnamed)').join(', ')}`);
    const acts = [];
    if (report.actions.openAction) acts.push('OpenAction');
    if (report.actions.aa) acts.push('additional-actions (/AA)');
    if (report.actions.javascript) acts.push('JavaScript');
    if (acts.length) lines.push(`\n  Document actions: ${acts.join(', ')}`);
    if (report.images.length) {
      lines.push(`\n  Images carrying embedded metadata: ${report.images.length}`);
      for (const im of report.images.slice(0, 20)) {
        const bits = [`obj ${im.objNum}`, im.filter];
        if (im.hasExif) bits.push('EXIF');
        if (im.gpsPresent) bits.push('GPS');
        if (im.hasXmp) bits.push('XMP');
        if (im.hasIptc) bits.push('IPTC');
        if (im.hasXml) bits.push('XML');
        if (im.hasUuid) bits.push('UUID');
        lines.push(`    ${bits.join(' / ')}`);
      }
      if (report.images.length > 20) lines.push(`    …and ${report.images.length - 20} more`);
    }
    if (report.signatures.length) lines.push(`\n  Digital signatures: ${report.signatures.length}`);
    if (report.priorRevisions > 1) lines.push(`\n  Prior saved revisions retained: ${report.priorRevisions - 1}`);
    if (report.encrypted) lines.push('\n  Encrypted: yes');
    const kept = [];
    if (report.structTree) kept.push('accessibility tags');
    if (report.lang) kept.push(`language (${report.lang})`);
    if (report.pageLabels) kept.push('page labels');
    if (report.viewerPreferences) kept.push('viewer preferences');
    lines.push(`\n  Kept by default (removable via strip-metadata flags): ${kept.length ? kept.join(', ') : 'none'}`);
    console.log(lines.join('\n'));
    process.exitCode = 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
};

/**
 * Write a copy of a PDF with identifying metadata removed.
 * The visible pages are unchanged.
 * The balanced default strips info/XMP/PieceInfo/embedded files/image EXIF/actions/prior revisions/signatures and rewrites filename-leaking layer names,
 * but keeps accessibility tags, page labels, language, and viewer preferences.
 *
 * @param {string} inputFile - Path to the input PDF.
 * @param {string} [output] - Output PDF file, or a directory to write <stem>-clean.pdf into.
 * @param {Object} [options]
 * @param {boolean} [options.stripTags] - Also remove accessibility structure tags (/StructTreeRoot).
 * @param {boolean} [options.stripPageLabels] - Also remove page labels (/PageLabels).
 * @param {boolean} [options.stripViewerPrefs] - Also remove viewer preferences.
 * @param {boolean} [options.dropLayers] - Also drop optional-content (layer) configuration.
 */
export const stripMetadataCLI = async (inputFile, output, options) => {
  try {
    const pdfBytes = new Uint8Array(fs.readFileSync(inputFile));
    const before = getMetadata(pdfBytes);

    const scrubOpts = {
      stripStructTree: !!options?.stripTags,
      stripPageLabels: !!options?.stripPageLabels,
      stripViewerPrefs: !!options?.stripViewerPrefs,
      dropOCProperties: !!options?.dropLayers,
    };
    const warnings = [];
    const cleaned = await stripMetadataPdf(pdfBytes, scrubOpts, (m) => warnings.push(m));

    output = output || '.';
    const intoDir = fs.existsSync(output) && fs.statSync(output).isDirectory();
    const stem = path.basename(inputFile).replace(/\.\w{1,6}$/i, '');
    const outputPath = intoDir ? path.join(output, `${stem}-clean.pdf`) : output;
    const outputDir = path.dirname(outputPath);
    if (outputDir) fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputPath, cleaned);

    const after = getMetadata(cleaned);
    const removed = [];
    if (before.info && !after.info) removed.push('document info');
    if (before.docId && !after.docId) removed.push('document ID');
    if ((before.customInfo?.length || 0) > (after.customInfo?.length || 0)) removed.push(`${before.customInfo.length} custom document-info dict(s)`);
    if ((before.annotationAuthors?.length || 0) > (after.annotationAuthors?.length || 0)) removed.push(`author names from ${before.annotationAuthors.length} comment(s)`);
    if (before.xmp.catalog && !after.xmp.catalog) removed.push('document XMP');
    if (before.xmp.perObject.length > after.xmp.perObject.length) removed.push(`${before.xmp.perObject.length - after.xmp.perObject.length} per-object XMP packet(s)`);
    if (before.pieceInfo.length > after.pieceInfo.length) removed.push(`${before.pieceInfo.length} private-data object(s)`);
    if (before.embeddedFiles.length > after.embeddedFiles.length) removed.push(`${before.embeddedFiles.length} embedded file(s)`);
    if (before.images.length > after.images.length) removed.push(`image metadata from ${before.images.length - after.images.length} image(s)`);
    const hadActions = before.actions.openAction || before.actions.aa || before.actions.javascript;
    const hasActions = after.actions.openAction || after.actions.aa || after.actions.javascript;
    if (hadActions && !hasActions) removed.push('document actions/JavaScript');
    if (before.priorRevisions > after.priorRevisions) removed.push(`${before.priorRevisions - after.priorRevisions} prior revision(s)`);
    if (before.signatures.length > after.signatures.length) removed.push(`${before.signatures.length - after.signatures.length} digital signature(s)`);

    for (const w of warnings) console.warn(`Warning: ${w}`);
    console.log(`Removed: ${removed.length ? removed.join('; ') : 'nothing (no identifying metadata found)'}`);
    console.log(`Wrote cleaned PDF to ${outputPath} `
      + `(${(pdfBytes.length / 1048576).toFixed(2)} MB → ${(cleaned.length / 1048576).toFixed(2)} MB)`);
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
