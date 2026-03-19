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

const SUPPORTED_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif'];

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

// Track loaded file to avoid redundant re-imports.
let currentFile = null;
async function ensureFileLoaded(filePath) {
  if (currentFile !== filePath) {
    await ensureInit();
    await scribe.importFiles([filePath]);
    currentFile = filePath;
  }
}

// --- Tool implementations ---

async function loadDocument({ file }) {
  const filePath = resolve(file);
  if (!fs.existsSync(filePath)) {
    return { error: `File not found: ${filePath}` };
  }
  await ensureFileLoaded(filePath);
  const pageCount = scribe.inputData.pageCount;
  return { file: filePath, pageCount, loaded: true };
}

async function listDocuments({ directory }) {
  const dir = resolve(directory);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return { error: `Cannot read directory: ${dir}` };
  }

  const docs = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.includes(ext)) continue;
    const fullPath = join(dir, entry.name);
    const stats = fs.statSync(fullPath);
    docs.push({
      path: fullPath,
      name: entry.name,
      sizeKb: Math.round(stats.size / 1024),
      extension: ext,
    });
  }
  return { documents: docs, count: docs.length };
}

async function extractDocumentText({
  file, startPage, maxChars, preserveSpacing,
}) {
  let filePath;
  if (file) {
    filePath = resolve(file);
    if (!fs.existsSync(filePath)) {
      return { error: `File not found: ${filePath}` };
    }
  } else if (currentFile) {
    filePath = currentFile;
  } else {
    return { error: 'No file specified and no document is currently loaded. Use load_document first or provide a file path.' };
  }

  await ensureFileLoaded(filePath);
  const pageCount = scribe.inputData.pageCount;
  const start = startPage ?? 0;
  const limit = maxChars ?? 20000;

  let text = '';
  let endPage = start;
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

  return {
    pageCount,
    startPage: start,
    endPage,
    hasMore: endPage < pageCount - 1,
    text,
  };
}

async function recognizeDocument({ file, langs }) {
  let filePath;
  if (file) {
    filePath = resolve(file);
    if (!fs.existsSync(filePath)) {
      return { error: `File not found: ${filePath}` };
    }
  } else if (currentFile) {
    filePath = currentFile;
  } else {
    return { error: 'No file specified and no document is currently loaded. Use load_document first or provide a file path.' };
  }

  await ensureFileLoaded(filePath);
  await scribe.recognize({ langs: langs || ['eng'] });
  return { file: filePath, pageCount: scribe.inputData.pageCount, recognized: true };
}

async function createHighlightedPdf({
  file, outputPath, highlights, pages,
}) {
  const filePath = resolve(file);
  if (!fs.existsSync(filePath)) {
    return { error: `File not found: ${filePath}` };
  }

  const outPath = resolve(outputPath);
  await ensureFileLoaded(filePath);

  const result = scribe.addHighlights(highlights);

  scribe.opt.displayMode = 'annot';
  await scribe.download('pdf', outPath, { pageArr: pages || null });

  scribe.clearHighlights();

  return { outputPath: outPath, ...result };
}

async function renderPage({ file, page, dpi }) {
  const filePath = resolve(file);
  if (!fs.existsSync(filePath)) {
    return { error: `File not found: ${filePath}` };
  }

  await ensureFileLoaded(filePath);

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

async function defineTablesHandler({ file, page, tables }) {
  if (file) {
    const filePath = resolve(file);
    if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };
    await ensureFileLoaded(filePath);
  } else if (!currentFile) {
    return { error: 'No file specified and no document is currently loaded.' };
  }

  const tablesPage = scribe.createTablesFromText(page, tables, scribe.data.ocr.active[page]);
  scribe.data.layoutDataTables.pages[page] = tablesPage;
  return { page, tablesCreated: tables.length, totalRows: tables.reduce((sum, t) => sum + (t.rows?.length || 0), 0) };
}

async function extractTablesHandler({ file, page, outputPath }) {
  if (file) {
    const filePath = resolve(file);
    if (!fs.existsSync(filePath)) return { error: `File not found: ${filePath}` };
    await ensureFileLoaded(filePath);
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

// --- MCP Protocol (JSON-RPC over stdio) ---

const TOOLS = [
  {
    name: 'list_documents',
    description: 'List PDF and image documents in a directory.',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Directory path to search for documents.',
        },
      },
      required: ['directory'],
    },
  },
  {
    name: 'load_document',
    description: 'Load a document into memory for subsequent operations. Returns page count and file info. Use this before calling extract_document_text multiple times to avoid reloading the document each time.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Path to the document file.',
        },
      },
      required: ['file'],
    },
  },
  {
    name: 'extract_document_text',
    description: 'Extract text from a PDF or image document. Returns text with page:line number prefixes (e.g. "0:5  some text") so lines can be referenced for highlighting. Handles text-native and image-based PDFs (via OCR). For large documents, returns text in chunks — check "hasMore" and use "startPage" to get the next chunk.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Path to the document file. Optional if a document is already loaded via load_document.',
        },
        startPage: {
          type: 'integer',
          description: 'Page to start extraction from (0-indexed). Default: 0.',
        },
        maxChars: {
          type: 'integer',
          description: 'Maximum characters to return. The server will include as many complete pages as fit within this limit. Default: 20000.',
        },
        preserveSpacing: {
          type: 'boolean',
          description: 'Preserve horizontal spacing from the document layout by padding words with spaces based on their position. Makes table columns visually aligned in the output. Default: false.',
        },
      },
      required: [],
    },
  },
  {
    name: 'recognize',
    description: 'Run OCR on a loaded document to recognize text from images. Required for image-based PDFs and scanned documents before extracting text. Not needed for text-native PDFs.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Path to the document file. Optional if a document is already loaded via load_document.',
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
