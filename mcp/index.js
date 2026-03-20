#!/usr/bin/env node

/**
 * MCP server for scribe.js document tools.
 *
 * Exposes tools for extracting text from documents (with page:line numbers),
 * running OCR, creating highlighted PDFs, rendering pages, and splitting/merging PDFs.
 * Designed to work with Claude Code so that Claude can do semantic reasoning
 * over document text and produce highlighted PDFs based on its analysis.
 *
 * Implements the MCP protocol (JSON-RPC over stdio) directly without the SDK.
 */

import { fileURLToPath } from 'url';
import {
  dirname, resolve, join, extname,
} from 'path';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import scribe.js from parent directory
const scribePath = resolve(__dirname, '..', 'scribe.js');
const scribeModule = await import(scribePath);
const scribe = scribeModule.default;

// Import writeText directly so we can pass lineNumbers without mutating global state.
const writeTextModule = await import(resolve(__dirname, '..', 'js', 'export', 'writeText.js'));
const { writeText } = writeTextModule;

// Import assignParagraphs for paragraph detection when not already assigned.
const reflowParsModule = await import(resolve(__dirname, '..', 'js', 'utils', 'reflowPars.js'));
const { assignParagraphs } = reflowParsModule;

// Import pageMetricsAll for angle data needed by assignParagraphs.
const dataContainerModule = await import(resolve(__dirname, '..', 'js', 'containers', 'dataContainer.js'));
const { pageMetricsAll } = dataContainerModule;

const SUPPORTED_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif'];
const DATA_EXTENSIONS = ['.scribe.json', '.json', '.json.gz', '.hocr', '.xml', '.stext', '.txt', '.docx'];

const logFile = resolve(__dirname, 'mcp.log');
function mcpLog(msg) {
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}\n`);
}

// Serialize document operations since scribe.js uses global mutable state.
let operationQueue = Promise.resolve();
function enqueue(fn) {
  operationQueue = operationQueue.then(fn, fn);
  return operationQueue;
}

let initialized = false;
async function ensureInit() {
  if (!initialized) {
    await scribe.init({ font: true });
    initialized = true;
  }
}

// Track loaded file (and optional companion data file) to avoid redundant re-imports.
let currentFile = null;
let currentDataFile = null;
async function ensureFileLoaded(filePath, dataFilePath) {
  // If no data file was explicitly provided and the same file is already loaded,
  // reuse the current data file to avoid re-importing without companion OCR data.
  if (dataFilePath === undefined && currentFile === filePath) {
    dataFilePath = currentDataFile;
  }
  if (currentFile !== filePath || currentDataFile !== (dataFilePath || null)) {
    await ensureInit();
    const filesToImport = [filePath];
    if (dataFilePath) filesToImport.push(dataFilePath);
    await scribe.importFiles(filesToImport);
    currentFile = filePath;
    currentDataFile = dataFilePath || null;
  }
}

// --- Tool implementations ---

async function loadDocument({ file, dataFile }) {
  const filePath = resolve(file);
  if (!fs.existsSync(filePath)) {
    return { error: `File not found: ${filePath}` };
  }
  let dataFilePath;
  if (dataFile) {
    dataFilePath = resolve(dataFile);
    if (!fs.existsSync(dataFilePath)) {
      return { error: `Data file not found: ${dataFilePath}` };
    }
  }
  await ensureFileLoaded(filePath, dataFilePath);
  const pageCount = scribe.inputData.pageCount;
  const hasOcrData = scribe.data.ocr.active?.some((page) => page?.lines?.length > 0) || false;
  return {
    file: filePath, dataFile: dataFilePath || null, pageCount, loaded: true, hasOcrData,
  };
}

/**
 * Check if a filename ends with one of the known data extensions.
 * Handles compound extensions like `.scribe.json` and `.json.gz`.
 */
function hasDataExtension(fileName) {
  const lower = fileName.toLowerCase();
  return DATA_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

async function listDocuments({ directory, dataDir }) {
  const dir = resolve(directory);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { error: `Cannot read directory: ${dir}` };
  }

  // Collect all filenames in the main directory for companion lookup.
  const fileNames = [];
  for (const entry of entries) {
    if (entry.isFile()) fileNames.push(entry.name);
  }

  // Also collect filenames from the optional dataDir subdirectory.
  let dataDirFiles = [];
  if (dataDir) {
    const dataDirPath = join(dir, dataDir);
    try {
      const dataDirEntries = fs.readdirSync(dataDirPath, { withFileTypes: true });
      dataDirFiles = dataDirEntries.filter((e) => e.isFile()).map((e) => e.name);
    } catch (e) {
      // dataDir doesn't exist or isn't readable — not an error, just no extra companions.
    }
  }

  const docs = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) continue;
    const fullPath = join(dir, entry.name);
    const stats = fs.statSync(fullPath);
    const stem = entry.name.replace(/\.[^.]+$/, '').toLowerCase();

    // Find companion data files: files that start with the same stem and have a data extension.
    const companions = [];
    for (const fn of fileNames) {
      if (fn === entry.name) continue;
      if (fn.toLowerCase().startsWith(stem) && hasDataExtension(fn)) {
        companions.push({ path: join(dir, fn), name: fn });
      }
    }
    if (dataDir) {
      for (const fn of dataDirFiles) {
        if (fn.toLowerCase().startsWith(stem) && hasDataExtension(fn)) {
          companions.push({ path: join(dir, dataDir, fn), name: `${dataDir}/${fn}` });
        }
      }
    }

    const docEntry = {
      path: fullPath,
      name: entry.name,
      sizeKb: Math.round(stats.size / 1024),
      extension: ext,
    };
    if (companions.length > 0) docEntry.companionDataFiles = companions;
    docs.push(docEntry);
  }
  return { documents: docs, count: docs.length };
}

async function extractDocumentText({
  file, startPage, maxChars, preserveSpacing, dataFile,
  parAnnots, footnoteAnnots, outputPath,
}) {
  let filePath;
  let dataFilePath;
  if (file) {
    filePath = resolve(file);
    if (!fs.existsSync(filePath)) {
      return { error: `File not found: ${filePath}` };
    }
    if (dataFile) {
      dataFilePath = resolve(dataFile);
      if (!fs.existsSync(dataFilePath)) {
        return { error: `Data file not found: ${dataFilePath}` };
      }
    }
  } else if (currentFile) {
    filePath = currentFile;
    dataFilePath = currentDataFile;
  } else {
    return { error: 'No file specified and no document is currently loaded. Use load_document first or provide a file path.' };
  }

  await ensureFileLoaded(filePath, dataFilePath);
  const pageCount = scribe.inputData.pageCount;
  // When outputPath is provided, extract ALL pages to a file and return metadata only.
  // Claude can then read the file directly with its native Read tool (much faster than paginating).
  if (outputPath) {
    const outPath = resolve(outputPath);
    let text = '';
    if (parAnnots || footnoteAnnots) {
      for (let p = 0; p < pageCount; p++) {
        text += buildStructuredPageText(p, { parAnnots, footnoteAnnots });
      }
    } else {
      text = writeText({
        ocrCurrent: scribe.data.ocr.active,
        pageArr: null,
        lineNumbers: true,
        preserveSpacing: preserveSpacing || false,
      });
    }
    fs.writeFileSync(outPath, text);
    return {
      outputPath: outPath, pageCount, charCount: text.length, file: filePath,
    };
  }

  const start = startPage ?? 0;
  const limit = maxChars ?? 20000;

  let text = '';
  let endPage = start;

  if (parAnnots || footnoteAnnots) {
    for (let p = start; p < pageCount; p++) {
      const pageText = buildStructuredPageText(p, { parAnnots, footnoteAnnots });
      if (text.length > 0 && text.length + pageText.length > limit) break;
      text += pageText;
      endPage = p;
    }
  } else {
    for (let p = start; p < pageCount; p++) {
      // Call writeText directly with lineNumbers param instead of mutating scribe.opt.
      const pageText = writeText({
        ocrCurrent: scribe.data.ocr.active,
        pageArr: [p],
        lineNumbers: true,
        preserveSpacing: preserveSpacing || false,
      });
      if (text.length > 0 && text.length + pageText.length > limit) break;
      text += pageText;
      endPage = p;
    }
  }

  return {
    pageCount,
    startPage: start,
    endPage,
    hasMore: endPage < pageCount - 1,
    text,
  };
}

/**
 * Build structured text for a single page, with optional paragraph boundaries and footnote annotations.
 * @param {number} pageIdx - 0-based page index
 * @param {Object} opts
 * @param {boolean} [opts.parAnnots]
 * @param {boolean} [opts.footnoteAnnots]
 * @returns {string}
 */
function buildStructuredPageText(pageIdx, { parAnnots, footnoteAnnots }) {
  const pageObj = scribe.data.ocr.active[pageIdx];
  if (!pageObj || pageObj.lines.length === 0) return '';

  // Ensure paragraphs are assigned if not already present.
  const hasPars = pageObj.pars && pageObj.pars.length > 0;
  if (!hasPars && parAnnots) {
    const angle = pageMetricsAll[pageIdx]?.angle || 0;
    assignParagraphs(pageObj, angle);
  }

  let out = '';
  let currentParId = null;

  for (let h = 0; h < pageObj.lines.length; h++) {
    const line = pageObj.lines[h];
    if (!line || line.words.length === 0) continue;

    // Insert paragraph header when the paragraph changes.
    const par = line.par || null;
    const parId = par?.id || null;

    if (parAnnots && parId !== currentParId) {
      let header = `\n--- par:${parId || 'unknown'} [${par?.type || 'body'}]`;
      // For footnote paragraphs, show what word/line they reference.
      if (footnoteAnnots && par?.type === 'footnote' && par.footnoteRefId) {
        const refWordId = par.footnoteRefId;
        // Find the reference word to show its location.
        let refInfo = refWordId;
        for (let li = 0; li < pageObj.lines.length; li++) {
          const refWord = pageObj.lines[li].words.find((w) => w.id === refWordId);
          if (refWord) {
            refInfo = `${pageIdx}:${li} "${refWord.text}"`;
            break;
          }
        }
        header += ` ref:${refInfo}`;
      }
      header += ' ---';
      out += header;
      currentParId = parId;
    }

    // Build line text.
    const lineText = line.words.map((w) => w.text).join(' ');
    out += `\n${pageIdx}:${h}  ${lineText}`;

    // Annotate footnote references on this line.
    if (footnoteAnnots) {
      const fnWords = line.words.filter((w) => w.footnoteParId);
      for (const w of fnWords) {
        out += ` [footnote "${w.text}" → par:${w.footnoteParId}]`;
      }
    }
  }

  return out;
}

async function batchExtractText({
  directory, outputDir, dataDir, files, preserveSpacing, parAnnots, footnoteAnnots,
}) {
  const dir = resolve(directory);
  const outDir = resolve(outputDir);

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { error: `Cannot read directory: ${dir}` };
  }

  fs.mkdirSync(outDir, { recursive: true });

  // Collect filenames for companion lookup.
  const fileNames = [];
  for (const entry of entries) {
    if (entry.isFile()) fileNames.push(entry.name);
  }

  let dataDirFiles = [];
  if (dataDir) {
    try {
      const dataDirEntries = fs.readdirSync(join(dir, dataDir), { withFileTypes: true });
      dataDirFiles = dataDirEntries.filter((e) => e.isFile()).map((e) => e.name);
    } catch (e) { /* dataDir doesn't exist — not an error */ }
  }

  // Filter to supported document files.
  let docEntries = entries.filter((e) => e.isFile() && SUPPORTED_EXTENSIONS.includes(extname(e.name).toLowerCase()));
  if (files) {
    const fileSet = new Set(files);
    docEntries = docEntries.filter((e) => fileSet.has(e.name));
  }

  const results = [];
  let successCount = 0;
  let errorCount = 0;

  for (const entry of docEntries) {
    const docPath = join(dir, entry.name);
    const stem = entry.name.replace(/\.[^.]+$/, '');
    const stemLower = stem.toLowerCase();

    // Find best companion data file (prefer .scribe.json).
    const allCompanions = [];
    for (const fn of fileNames) {
      if (fn === entry.name) continue;
      if (fn.toLowerCase().startsWith(stemLower) && hasDataExtension(fn)) {
        allCompanions.push(join(dir, fn));
      }
    }
    if (dataDir) {
      for (const fn of dataDirFiles) {
        if (fn.toLowerCase().startsWith(stemLower) && hasDataExtension(fn)) {
          allCompanions.push(join(dir, dataDir, fn));
        }
      }
    }
    const companionPath = allCompanions.find((p) => p.endsWith('.scribe.json')) || allCompanions[0] || null;

    try {
      await ensureFileLoaded(docPath, companionPath);
      const pageCount = scribe.inputData.pageCount;

      let text = '';
      if (parAnnots || footnoteAnnots) {
        for (let p = 0; p < pageCount; p++) {
          text += buildStructuredPageText(p, { parAnnots, footnoteAnnots });
        }
      } else {
        text = writeText({
          ocrCurrent: scribe.data.ocr.active,
          pageArr: null,
          lineNumbers: true,
          preserveSpacing: preserveSpacing || false,
        });
      }

      const outPath = join(outDir, `${stem}.mtxt`);
      fs.writeFileSync(outPath, text);
      results.push({
        file: docPath, outputPath: outPath, pageCount, charCount: text.length,
      });
      successCount++;
    } catch (e) {
      results.push({ file: docPath, error: e.message });
      errorCount++;
    }
  }

  return {
    outputDir: outDir, results, totalDocuments: results.length, successCount, errorCount,
  };
}

async function recognizeDocument({ file, langs, dataFile }) {
  let filePath;
  let dataFilePath;
  if (file) {
    filePath = resolve(file);
    if (!fs.existsSync(filePath)) {
      return { error: `File not found: ${filePath}` };
    }
    if (dataFile) {
      dataFilePath = resolve(dataFile);
      if (!fs.existsSync(dataFilePath)) {
        return { error: `Data file not found: ${dataFilePath}` };
      }
    }
  } else if (currentFile) {
    filePath = currentFile;
    dataFilePath = currentDataFile;
  } else {
    return { error: 'No file specified and no document is currently loaded. Use load_document first or provide a file path.' };
  }

  await ensureFileLoaded(filePath, dataFilePath);
  await scribe.recognize({ langs: langs || ['eng'] });
  return { file: filePath, pageCount: scribe.inputData.pageCount, recognized: true };
}

async function createHighlightedPdf({
  file, outputPath, highlights, pages, dataFile,
}) {
  const filePath = resolve(file);
  if (!fs.existsSync(filePath)) {
    return { error: `File not found: ${filePath}` };
  }
  let dataFilePath;
  if (dataFile) {
    dataFilePath = resolve(dataFile);
    if (!fs.existsSync(dataFilePath)) {
      return { error: `Data file not found: ${dataFilePath}` };
    }
  }

  const outPath = resolve(outputPath);
  await ensureFileLoaded(filePath, dataFilePath);

  const result = scribe.addHighlights(highlights);

  scribe.opt.displayMode = 'annot';
  await scribe.download('pdf', outPath, { pageArr: pages || null });

  scribe.clearHighlights();

  return { outputPath: outPath, ...result };
}

async function renderPage({
  file, page, dpi, dataFile,
}) {
  const filePath = resolve(file);
  if (!fs.existsSync(filePath)) {
    return { error: `File not found: ${filePath}` };
  }
  let dataFilePath;
  if (dataFile) {
    dataFilePath = resolve(dataFile);
    if (!fs.existsSync(dataFilePath)) {
      return { error: `Data file not found: ${dataFilePath}` };
    }
  }

  await ensureFileLoaded(filePath, dataFilePath);

  const pageCount = scribe.inputData.pageCount;
  const pageNum = page ?? 0;
  if (pageNum < 0 || pageNum >= pageCount) {
    return { error: `Page ${pageNum} out of range (0-${pageCount - 1})` };
  }

  const ImageCache = scribe.data.image;
  if (!ImageCache.pdfDims300 || !ImageCache.pdfDims300[pageNum]) {
    return { error: 'Document does not have PDF image data available for rendering.' };
  }

  const muPDFScheduler = await ImageCache.getMuPDFScheduler();
  const requestedDpi = dpi || 150;
  const dataUrl = await muPDFScheduler.drawPageAsPNG({
    page: pageNum + 1,
    dpi: requestedDpi,
    color: true,
    skipText: false,
  });

  // Strip "data:image/png;base64," prefix for MCP image content
  const base64 = dataUrl.split(',')[1];

  return {
    base64, page: pageNum, pageCount, dpi: requestedDpi,
  };
}

async function subsetPdf({ file, outputPath, pages }) {
  const filePath = resolve(file);
  if (!fs.existsSync(filePath)) {
    return { error: `File not found: ${filePath}` };
  }
  const ext = extname(filePath).toLowerCase();
  if (ext !== '.pdf') {
    return { error: `File is not a PDF: ${filePath}` };
  }

  const outPath = resolve(outputPath);
  await ensureInit();

  const ImageCache = scribe.data.image;
  const muPDFScheduler = await ImageCache.getMuPDFScheduler(1);
  const w = muPDFScheduler.workers[0];

  const fileData = fs.readFileSync(filePath);
  const doc = await w.openDocument(fileData.buffer, 'document.pdf');
  w.pdfDoc = doc;
  const totalPages = await w.countPages();

  // Validate page indices
  for (const p of pages) {
    if (p < 0 || p >= totalPages) {
      w.freeDocument(doc);
      return { error: `Page ${p} out of range (0-${totalPages - 1})` };
    }
  }

  await w.subsetPages(doc, { pageArr: pages });
  const outputData = await w.save({ doc1: doc });
  w.freeDocument(doc);

  fs.writeFileSync(outPath, Buffer.from(outputData));

  return {
    outputPath: outPath,
    inputPages: totalPages,
    outputPages: pages.length,
    pagesIncluded: pages,
  };
}

async function mergePdfs({ files, outputPath }) {
  if (!files || files.length === 0) {
    return { error: 'At least one file is required.' };
  }

  for (const entry of files) {
    const p = resolve(entry.file);
    if (!fs.existsSync(p)) return { error: `File not found: ${p}` };
    if (extname(p).toLowerCase() !== '.pdf') return { error: `Not a PDF: ${p}` };
  }

  const outPath = resolve(outputPath);
  await ensureInit();

  const ImageCache = scribe.data.image;
  const muPDFScheduler = await ImageCache.getMuPDFScheduler(1);
  const w = muPDFScheduler.workers[0];

  // Open first file as destination
  const first = files[0];
  const firstPath = resolve(first.file);
  const firstData = fs.readFileSync(firstPath);
  const dst = await w.openDocument(firstData.buffer, 'document.pdf');
  w.pdfDoc = dst;

  // If first entry specifies pages, subset the destination
  if (first.pages) {
    await w.subsetPages(dst, { pageArr: first.pages });
  }

  // Merge remaining files
  for (let i = 1; i < files.length; i++) {
    const entry = files[i];
    const srcPath = resolve(entry.file);
    const srcData = fs.readFileSync(srcPath);
    const src = await w.openDocument(srcData.buffer, 'document.pdf');
    await w.mergeFrom(dst, src, { pageArr: entry.pages });
    w.freeDocument(src);
  }

  const outputData = await w.save({ doc1: dst });
  w.pdfDoc = dst;
  const totalPages = await w.countPages();
  w.freeDocument(dst);

  fs.writeFileSync(outPath, Buffer.from(outputData));

  return {
    outputPath: outPath,
    totalPages,
    filesMerged: files.length,
  };
}

async function defineTablesHandler({
  file, page, tables, dataFile,
}) {
  if (file) {
    const filePath = resolve(file);
    if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };
    let dataFilePath;
    if (dataFile) {
      dataFilePath = resolve(dataFile);
      if (!fs.existsSync(dataFilePath)) return { error: `Data file not found: ${dataFilePath}` };
    }
    await ensureFileLoaded(filePath, dataFilePath);
  } else if (!currentFile) {
    return { error: 'No file specified and no document is currently loaded.' };
  }

  const tablesPage = scribe.createTablesFromText(page, tables, scribe.data.ocr.active[page]);
  scribe.data.layoutDataTables.pages[page] = tablesPage;
  return { page, tablesCreated: tables.length, totalRows: tables.reduce((sum, t) => sum + (t.rows?.length || 0), 0) };
}

async function extractTablesHandler({
  file, page, outputPath, dataFile,
}) {
  if (file) {
    const filePath = resolve(file);
    if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };
    let dataFilePath;
    if (dataFile) {
      dataFilePath = resolve(dataFile);
      if (!fs.existsSync(dataFilePath)) return { error: `Data file not found: ${dataFilePath}` };
    }
    await ensureFileLoaded(filePath, dataFilePath);
  } else if (!currentFile) {
    return { error: 'No file specified and no document is currently loaded.' };
  }

  const pageCount = scribe.inputData.pageCount;
  const result = {};

  if (page != null) {
    result.tables = scribe.extractTextFromTables(scribe.data.ocr.active[page], scribe.data.layoutDataTables.pages[page]);
    result.page = page;
  } else {
    // Return tables for all pages
    result.pages = {};
    for (let p = 0; p < pageCount; p++) {
      const tables = scribe.extractTextFromTables(scribe.data.ocr.active[p], scribe.data.layoutDataTables.pages[p]);
      if (tables.length > 0) result.pages[p] = tables;
    }
  }

  if (outputPath) {
    const outPath = resolve(outputPath);
    await scribe.download('xlsx', outPath);
    result.outputPath = outPath;
  }

  return result;
}

async function convertDocxToJson({ file, outputPath, lineSplitMode }) {
  const filePath = resolve(file);
  if (!fs.existsSync(filePath)) {
    return { error: `File not found: ${filePath}` };
  }
  if (extname(filePath).toLowerCase() !== '.docx') {
    return { error: `File is not a .docx file: ${filePath}` };
  }

  const outPath = outputPath
    ? resolve(outputPath)
    : filePath.replace(/\.docx$/i, '.scribe.json');

  await ensureInit();

  const prevLineSplitMode = scribe.opt.docxLineSplitMode;
  const prevCompressScribe = scribe.opt.compressScribe;
  if (lineSplitMode) {
    scribe.opt.docxLineSplitMode = lineSplitMode;
  }
  scribe.opt.compressScribe = false;

  try {
    await scribe.importFiles([filePath]);
    currentFile = filePath;
    currentDataFile = null;

    const scribeJson = await scribe.exportData('scribe');
    fs.writeFileSync(outPath, scribeJson);

    return {
      outputPath: outPath,
      pageCount: scribe.inputData.pageCount,
      lineSplitMode: scribe.opt.docxLineSplitMode,
    };
  } finally {
    scribe.opt.docxLineSplitMode = prevLineSplitMode;
    scribe.opt.compressScribe = prevCompressScribe;
  }
}

// async function createXlsxHandler({ outputPath, rows }) {
//   const outPath = resolve(outputPath);
//
//   const { writeXlsxFromStrings } = await import(resolve(__dirname, '..', 'js', 'export', 'writeTabular.js'));
//   const xlsxData = await writeXlsxFromStrings(rows);
//
//   fs.writeFileSync(outPath, xlsxData);
//
//   return {
//     outputPath: outPath,
//     rows: rows.length,
//     columns: Math.max(...rows.map((r) => r.length)),
//   };
// }

// --- MCP Protocol (JSON-RPC over stdio) ---

const TOOLS = [
  {
    name: 'list_documents',
    description: 'List PDF and image documents in a directory. Discovers companion data files (OCR exports, .scribe.json) that can be loaded alongside documents.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Directory path to search for documents.',
        },
        dataDir: {
          type: 'string',
          description: 'Optional subdirectory name to also search for companion data files (e.g., "_data"). By default, only the same directory as the documents is searched.',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'load_document',
    description: 'Load a document into memory for subsequent operations. Returns page count, file info, and whether OCR data is available. '
      + 'Optionally provide a companion data file to use existing OCR data instead of re-running recognition.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Path to the document file.',
        },
        dataFile: {
          type: 'string',
          description: 'Path to a companion data file (.scribe.json, Textract JSON, .hocr, .stext, etc.) with OCR/text data to use instead of extracting from the PDF.',
        },
      },
      required: ['file'],
    },
  },
  {
    name: 'extract_document_text',
    description: 'Extract text from a PDF or image document. Returns text with page:line number prefixes (e.g. "0:5  some text") so lines can be referenced for highlighting. '
      + 'Handles text-native and image-based PDFs (via OCR). '
      + 'For large documents, provide "outputPath" to write ALL text to a file and get metadata back — then read the file directly. '
      + 'Without outputPath, returns text in optimally-sized chunks — leave startPage and maxChars at defaults unless you need a specific page range. '
      + 'Check "hasMore" in the response; if true, set startPage to endPage + 1 to continue. '
      + 'A companion data file can be provided to use existing OCR data instead of re-running recognition. '
      + 'Use parAnnots and/or footnoteAnnots to add document structure annotations to the output.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Path to the document file. Optional if a document is already loaded via load_document.',
        },
        dataFile: {
          type: 'string',
          description: 'Path to a companion data file (.scribe.json, Textract JSON, .hocr, .stext, etc.) with OCR/text data to use instead of extracting from the PDF.',
        },
        outputPath: {
          type: 'string',
          description: 'Path to write the full extracted text to a file. When provided, ALL pages are extracted (startPage/maxChars are ignored) '
            + 'and the result contains only metadata (path, page count, character count). Read the output file directly for content.',
        },
        startPage: {
          type: 'integer',
          description: '0-indexed page to start from. Use to jump to a specific page or to continue paginating (set to endPage + 1 from the previous response). '
            + 'Default: 0. Ignored when outputPath is provided.',
        },
        maxChars: {
          type: 'integer',
          description: 'The default (20000) is optimized for typical use — do NOT override unless you have a specific reason. '
            + 'Maximum characters to return per chunk. The server includes as many complete pages as fit within this limit.',
        },
        preserveSpacing: {
          type: 'boolean',
          description: 'Preserve horizontal spacing from the document layout by padding words with spaces based on their position. '
            + 'Makes table columns visually aligned in the output. Default: false.',
        },
        parAnnots: {
          type: 'boolean',
          description: 'Annotate each group of lines with its paragraph ID and type '
            + '(body, title, or footnote), e.g. "--- par:abc123 [body] ---". '
            + 'Use this to identify which lines belong to the same paragraph. Default: false.',
        },
        footnoteAnnots: {
          type: 'boolean',
          description: 'Include footnote cross-reference annotations. Words that reference a footnote are annotated with '
            + '[footnote "word" → par:ID], and footnote paragraphs show which line/word they are linked from. '
            + 'Best used together with parAnnots. Default: false.',
        },
      },
      required: [],
    },
  },
  {
    name: 'recognize',
    description: 'Run OCR on a loaded document to recognize text from images. Required for image-based PDFs and scanned documents before extracting text. '
      + 'Not needed for text-native PDFs or when a companion data file was loaded.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Path to the document file. Optional if a document is already loaded via load_document.',
        },
        dataFile: {
          type: 'string',
          description: 'Path to a companion data file (.scribe.json, Textract JSON, .hocr, .stext, etc.) with OCR/text data to use instead of running recognition.',
        },
        langs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Language codes to recognize. Default: ["eng"].',
        },
      },
      required: [],
    },
  },
  {
    name: 'create_highlighted_pdf',
    description: 'Create a PDF with specified passages highlighted. '
      + 'Line mode: provide startLine/endLine, optionally with text to narrow to specific words. '
      + 'Quote mode: provide just page and text to search and highlight matching words.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Path to the source document.',
        },
        dataFile: {
          type: 'string',
          description: 'Path to a companion data file (.scribe.json, Textract JSON, .hocr, .stext, etc.) with OCR/text data.',
        },
        outputPath: {
          type: 'string',
          description: 'Path for the output highlighted PDF.',
        },
        highlights: {
          type: 'array',
          description: 'Array of highlight specifications.',
          items: {
            type: 'object',
            properties: {
              page: {
                type: 'integer',
                description: 'Page number (0-indexed).',
              },
              startLine: {
                type: 'integer',
                description: 'First line to highlight (0-indexed, from the page:line prefix). If omitted, uses quote-only mode with "text".',
              },
              endLine: {
                type: 'integer',
                description: 'Last line to highlight (0-indexed). Defaults to startLine if omitted.',
              },
              text: {
                type: 'string',
                description: 'Quote text to highlight. In line mode, narrows the first/last line to matching words. In quote-only mode (no startLine/endLine), searches the entire page for this text.',
              },
              color: {
                type: 'string',
                description: 'Hex color for the highlight (e.g. "#ffff00" for yellow). Default: yellow.',
              },
              comment: {
                type: 'string',
                description: 'Comment explaining why this passage is highlighted. Becomes a PDF annotation.',
              },
            },
            required: ['page'],
          },
        },
        pages: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Optional array of page indices to include in the output PDF (0-indexed). Can be non-continuous and in any order. If omitted, all pages are included.',
        },
      },
      required: ['file', 'outputPath', 'highlights'],
    },
  },
  {
    name: 'render_page',
    description: 'Render a page of a PDF document as a PNG image. Returns the image as base64-encoded data. Useful for visually reviewing a document page.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Path to the document file.',
        },
        dataFile: {
          type: 'string',
          description: 'Path to a companion data file (.scribe.json, Textract JSON, .hocr, .stext, etc.) with OCR/text data.',
        },
        page: {
          type: 'integer',
          description: 'Page number to render (0-indexed). Default: 0.',
        },
        dpi: {
          type: 'integer',
          description: 'Resolution in DPI. Higher values produce larger, sharper images. Default: 150.',
        },
      },
      required: ['file'],
    },
  },
  {
    name: 'subset_pdf',
    description: 'Create a new PDF containing only the specified pages from the input PDF. Pages are 0-indexed and can be non-continuous or reordered.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Path to the source PDF file.',
        },
        outputPath: {
          type: 'string',
          description: 'Path for the output PDF file.',
        },
        pages: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Array of page indices to include (0-indexed). Can be non-continuous and in any order. Example: [0, 2, 5] extracts pages 1, 3, and 6.',
        },
      },
      required: ['file', 'outputPath', 'pages'],
    },
  },
  {
    name: 'merge_pdfs',
    description: 'Merge multiple PDF files into a single PDF. Optionally select specific pages from each input file.',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'Array of PDF files to merge, in order.',
          items: {
            type: 'object',
            properties: {
              file: { type: 'string', description: 'Path to a PDF file.' },
              pages: {
                type: 'array',
                items: { type: 'integer' },
                description: 'Optional array of page indices to include (0-indexed). If omitted, all pages are included.',
              },
            },
            required: ['file'],
          },
        },
        outputPath: {
          type: 'string',
          description: 'Path for the output merged PDF.',
        },
      },
      required: ['files', 'outputPath'],
    },
  },
  {
    name: 'define_tables',
    description: 'Define tables on a page with pre-structured cell content. '
      + 'Provide cell content as rows of strings. Overwrites any existing tables for the page.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Path to the document file. Optional if already loaded.',
        },
        dataFile: {
          type: 'string',
          description: 'Path to a companion data file (.scribe.json, Textract JSON, .hocr, .stext, etc.) with OCR/text data.',
        },
        page: {
          type: 'integer',
          description: 'Page number (0-indexed).',
        },
        tables: {
          type: 'array',
          description: 'Array of table definitions.',
          items: {
            type: 'object',
            properties: {
              rows: {
                type: 'array',
                description: 'Table content as a 2D array: rows of cells. Each cell is a string.',
                items: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
            },
            required: ['rows'],
          },
        },
      },
      required: ['page', 'tables'],
    },
  },
  {
    name: 'extract_tables',
    description: 'Get structured table data for a page (or all pages). Returns tables previously defined via define_tables or imported from Textract/Abbyy. Optionally exports to xlsx.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Path to the document file. Optional if already loaded.',
        },
        dataFile: {
          type: 'string',
          description: 'Path to a companion data file (.scribe.json, Textract JSON, .hocr, .stext, etc.) with OCR/text data.',
        },
        page: {
          type: 'integer',
          description: 'Page number (0-indexed). If omitted, returns tables from all pages.',
        },
        outputPath: {
          type: 'string',
          description: 'Optional path for xlsx export. If provided, also saves tables as an xlsx file.',
        },
      },
      required: [],
    },
  },
  {
    name: 'convert_docx_to_json',
    description: 'Convert a .docx file to .scribe.json format. '
      + 'Parses the docx document structure and exports it as a scribe.json file containing page/line/word data with styling and font information.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Path to the .docx file to convert.',
        },
        outputPath: {
          type: 'string',
          description: 'Path for the output .scribe.json file. Default: same directory and basename as input with .scribe.json extension.',
        },
        lineSplitMode: {
          type: 'string',
          enum: ['width', 'sentence'],
          description: 'How to split text into lines. "width" wraps at page width (default). "sentence" splits at sentence boundaries.',
        },
      },
      required: ['file'],
    },
  },
  // {
  //   name: 'create_xlsx',
  //   description: 'Create an Excel workbook with a single sheet from structured data. Does not require a loaded document. '
  //     + 'Provide a 2D array of cell value strings. The first row is typically used as a header.',
  //   inputSchema: {
  //     type: 'object',
  //     properties: {
  //       outputPath: {
  //         type: 'string',
  //         description: 'Path for the output .xlsx file.',
  //       },
  //       rows: {
  //         type: 'array',
  //         description: 'Rows of the sheet. Each row is an array of cell value strings.',
  //         items: {
  //           type: 'array',
  //           items: { type: 'string' },
  //         },
  //       },
  //     },
  //     required: ['outputPath', 'rows'],
  //   },
  // },
  {
    name: 'batch_extract_text',
    description: 'Extract text from multiple documents in a directory, writing each to a .mtxt file. '
      + 'Returns metadata (paths, page counts, character counts) for all documents. '
      + 'Automatically discovers companion data files. Read the output .mtxt files directly for content.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Directory containing the documents to process.',
        },
        outputDir: {
          type: 'string',
          description: 'Directory to write extracted .mtxt text files into. Created if it does not exist.',
        },
        dataDir: {
          type: 'string',
          description: 'Optional subdirectory name to search for companion data files (e.g., "_data").',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of specific filenames to process. If omitted, processes all supported documents in the directory.',
        },
        preserveSpacing: {
          type: 'boolean',
          description: 'Preserve horizontal spacing from document layout. Default: false.',
        },
        parAnnots: {
          type: 'boolean',
          description: 'Annotate paragraph boundaries and types. Default: false.',
        },
        footnoteAnnots: {
          type: 'boolean',
          description: 'Include footnote cross-reference annotations. Default: false.',
        },
      },
      required: ['directory', 'outputDir'],
    },
  },
];

const toolHandlers = {
  list_documents: (args) => enqueue(() => listDocuments(args)),
  load_document: (args) => enqueue(() => loadDocument(args)),
  extract_document_text: (args) => enqueue(() => extractDocumentText(args)),
  recognize: (args) => enqueue(() => recognizeDocument(args)),
  create_highlighted_pdf: (args) => enqueue(() => createHighlightedPdf(args)),
  render_page: (args) => enqueue(() => renderPage(args)),
  subset_pdf: (args) => enqueue(() => subsetPdf(args)),
  merge_pdfs: (args) => enqueue(() => mergePdfs(args)),
  define_tables: (args) => enqueue(() => defineTablesHandler(args)),
  extract_tables: (args) => enqueue(() => extractTablesHandler(args)),
  convert_docx_to_json: (args) => enqueue(() => convertDocxToJson(args)),
  // create_xlsx: (args) => enqueue(() => createXlsxHandler(args)),
  batch_extract_text: (args) => enqueue(() => batchExtractText(args)),
};

// JSON-RPC message handling

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write(`${json}\n`);
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message) {
  sendMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    sendResult(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: {
        name: 'scribe-document-tools',
        version: '0.1.0',
      },
    });
    return;
  }

  if (method === 'notifications/initialized') {
    // No response needed for notifications
    return;
  }

  if (method === 'tools/list') {
    sendResult(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};
    const handler = toolHandlers[toolName];

    if (!handler) {
      sendResult(id, {
        content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
        isError: true,
      });
      return;
    }

    mcpLog(`tool call: ${toolName} args=${JSON.stringify(toolArgs)}`);
    const startTime = Date.now();
    try {
      const result = await handler(toolArgs);
      const elapsed = Date.now() - startTime;
      mcpLog(`tool done: ${toolName} (${elapsed}ms)`);

      // render_page returns image content instead of JSON text
      if (toolName === 'render_page' && result.base64) {
        sendResult(id, {
          content: [
            { type: 'image', data: result.base64, mimeType: 'image/png' },
            { type: 'text', text: JSON.stringify({ page: result.page, pageCount: result.pageCount, dpi: result.dpi }) },
          ],
        });
      } else {
        sendResult(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      }
    } catch (e) {
      sendResult(id, {
        content: [{ type: 'text', text: `Error: ${e.message}\n${e.stack}` }],
        isError: true,
      });
    }
    return;
  }

  if (method === 'ping') {
    sendResult(id, {});
    return;
  }

  // Unknown method
  if (id !== undefined) {
    sendError(id, -32601, `Method not found: ${method}`);
  }
}

// Read JSON-RPC messages from stdin (newline-delimited JSON)

let stdinBuf = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuf += chunk;
  processLines();
});

function processLines() {
  let newlineIdx;
  while ((newlineIdx = stdinBuf.indexOf('\n')) !== -1) {
    const line = stdinBuf.slice(0, newlineIdx).trim();
    stdinBuf = stdinBuf.slice(newlineIdx + 1);

    if (!line) continue;

    // Skip Content-Length headers (in case a client sends them)
    if (/^Content-Length:/i.test(line)) continue;

    try {
      const msg = JSON.parse(line);
      handleRequest(msg).catch((e) => {
        process.stderr.write(`Error handling request: ${e.message}\n${e.stack}\n`);
        if (msg.id !== undefined) {
          sendError(msg.id, -32603, `Internal error: ${e.message}`);
        }
      });
    } catch (e) {
      process.stderr.write(`Failed to parse JSON-RPC message: ${e.message}\n`);
    }
  }
}

process.stderr.write('scribe-document-tools MCP server started\n');

// Exports for testing.
export { ensureFileLoaded };
export function resetState() {
  currentFile = null;
  currentDataFile = null;
}
