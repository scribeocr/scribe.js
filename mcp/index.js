#!/usr/bin/env node

/**
 * MCP server for scribe.js document tools.
 *
 * Exposes tools for extracting text from documents (with page:line numbers)
 * and creating highlighted PDFs. Designed to work with Claude Code so that
 * Claude can do semantic reasoning over document text and produce highlighted
 * PDFs based on its analysis.
 *
 * Implements the MCP protocol (JSON-RPC over stdio) directly without the SDK.
 */

import { fileURLToPath } from 'url';
import {
  dirname, resolve, join, relative, extname,
} from 'path';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Import scribe.js from parent directory
const scribePath = resolve(__dirname, '..', 'scribe.js');
const scribeModule = await import(scribePath);
const scribe = scribeModule.default;

const SUPPORTED_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif'];

const logFile = resolve(dirname(fileURLToPath(import.meta.url)), 'mcp.log');
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

async function extractDocumentText({ file, startPage, maxChars }) {
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
    scribe.opt.lineNumbers = true;
    const pageText = await scribe.exportData('txt', p, p);
    scribe.opt.lineNumbers = false;
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

async function createHighlightedPdf({
  file, outputPath, highlights, pages,
}) {
  const filePath = resolve(file);
  if (!fs.existsSync(filePath)) {
    return { error: `File not found: ${filePath}` };
  }

  const outPath = resolve(outputPath);
  await ensureFileLoaded(filePath);

  let highlightsApplied = 0;
  let totalLinesHighlighted = 0;

  for (const highlight of highlights) {
    const page = scribe.data.ocr.active[highlight.page];
    if (!page) continue;

    const lines = highlight.lines;
    if (!lines || lines.length === 0) continue;

    for (let i = 0; i < lines.length; i++) {
      const lineNum = lines[i];
      const line = page.lines[lineNum];
      if (!line) continue;

      let wordsToHighlight = [...line.words];

      // On first line, try to start at startText
      if (i === 0 && highlight.startText) {
        const matchWords = scribe.utils.ocr.getMatchingWordsInLine(
          highlight.startText, line,
        );
        if (matchWords.length > 0) {
          const firstMatchIdx = line.words.indexOf(matchWords[0]);
          if (firstMatchIdx >= 0) {
            wordsToHighlight = line.words.slice(firstMatchIdx);
          }
        }
        // If no match, fall back to full line (wordsToHighlight unchanged)
      }

      // On last line, try to end at endText
      if (i === lines.length - 1 && highlight.endText) {
        const matchWords = scribe.utils.ocr.getMatchingWordsInLine(
          highlight.endText, line,
        );
        if (matchWords.length > 0) {
          const lastMatchIdx = line.words.indexOf(matchWords[matchWords.length - 1]);
          if (lastMatchIdx >= 0) {
            const startIdx = line.words.indexOf(wordsToHighlight[0]);
            wordsToHighlight = line.words.slice(
              startIdx >= 0 ? startIdx : 0,
              lastMatchIdx + 1,
            );
          }
        }
      }

      for (const word of wordsToHighlight) {
        scribe.data.annotations.pages[highlight.page].push({
          bbox: word.bbox,
          color: highlight.color || '#ffff00',
          opacity: 0.4,
          groupId: `highlight-${highlightsApplied}`,
          comment: highlight.comment || '',
        });
      }
      totalLinesHighlighted++;
    }
    highlightsApplied++;
  }

  scribe.opt.displayMode = 'annot';
  await scribe.download('pdf', outPath, 0, -1, pages || null);
  const loadedFile = currentFile;
  await scribe.clear();
  currentFile = null;
  if (loadedFile) {
    mcpLog(`reloading ${loadedFile} after highlight clear`);
    await ensureFileLoaded(loadedFile);
  }

  return { outputPath: outPath, highlightsApplied, totalLinesHighlighted };
}

/**
 * Spawn the Tauri viewer with the given CLI args.
 * Returns an error object if the Tauri binary is not found, otherwise spawns detached.
 */
function spawnTauri(cliArgs) {
  const tauriDir = resolve(__dirname, '..', '..', 'tauri');
  const binName = process.platform === 'win32' ? 'scribe-viewer-tauri.exe' : 'scribe-viewer-tauri';
  let tauriBin = resolve(tauriDir, 'target', 'release', binName);
  if (!fs.existsSync(tauriBin)) {
    tauriBin = resolve(tauriDir, 'target', 'debug', binName);
  }
  if (!fs.existsSync(tauriBin)) {
    return { error: `Tauri binary not found. Run "cargo tauri build" in ${tauriDir}.` };
  }

  const child = spawn(tauriBin, cliArgs, {
    detached: true,
    stdio: 'ignore',
    cwd: tauriDir,
  });
  child.unref();
  return null;
}

/**
 * Spawn the Electron viewer with the given CLI args.
 * Returns an error object if Electron is not installed, otherwise spawns detached.
 */
function spawnElectron(cliArgs) {
  const electronDir = resolve(__dirname, '..', '..', 'electron');
  const electronBin = resolve(electronDir, 'node_modules', '.bin', 'electron');
  const mainJs = resolve(electronDir, 'main.js');

  if (!fs.existsSync(electronBin)) {
    return { error: `Electron not found at ${electronBin}. Run "npm install" in ${electronDir}.` };
  }

  // ELECTRON_RUN_AS_NODE is set in some environments (e.g. Claude Code's VSCode extension)
  // and causes the Electron binary to run as a plain Node.js process. Unset it so the
  // Electron API (app, BrowserWindow, etc.) is available.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(electronBin, [mainJs, ...cliArgs], {
    detached: true,
    stdio: 'ignore',
    cwd: electronDir,
    env,
  });
  child.unref();
  return null;
}

/**
 * Spawn the viewer, trying Tauri first and falling back to Electron.
 */
function spawnViewer(cliArgs) {
  const tauriErr = spawnTauri(cliArgs);
  if (!tauriErr) return null;
  return spawnElectron(cliArgs);
}

async function openViewer({ file, page }) {
  const filePath = resolve(file);
  if (!fs.existsSync(filePath)) {
    return { error: `File not found: ${filePath}` };
  }

  const args = [`--file=${filePath}`];
  if (page != null) args.push(`--page=${page}`);

  const err = spawnViewer(args);
  if (err) return err;

  return { opened: filePath, page: page ?? 0 };
}

async function navigatePage({ file, page }) {
  const filePath = resolve(file);
  if (!fs.existsSync(filePath)) {
    return { error: `File not found: ${filePath}` };
  }

  const err = spawnViewer([`--file=${filePath}`, '--action=navigate', `--page=${page}`]);
  if (err) return err;

  return { navigated: true, page };
}

async function applyViewerHighlights({ file, highlights }) {
  const filePath = resolve(file);
  if (!fs.existsSync(filePath)) {
    return { error: `File not found: ${filePath}` };
  }

  const err = spawnViewer([`--file=${filePath}`, '--action=highlight', `--highlights=${JSON.stringify(highlights)}`]);
  if (err) return err;

  return { sent: true, highlightsCount: highlights.length };
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
      },
      required: [],
    },
  },
  {
    name: 'create_highlighted_pdf',
    description: 'Create a PDF with specified lines highlighted. Use page and line numbers from extract_document_text output. Optionally use startText/endText to refine highlights to specific words within the first/last line. Falls back to full-line highlighting if text matching fails.',
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
                description: 'Page number (0-indexed, from the page:line prefix).',
              },
              lines: {
                type: 'array',
                items: { type: 'integer' },
                description: 'Line numbers to highlight (0-indexed, from the page:line prefix).',
              },
              color: {
                type: 'string',
                description: 'Hex color for the highlight (e.g. "#ffff00" for yellow). Default: yellow.',
              },
              comment: {
                type: 'string',
                description: 'Comment explaining why this passage is highlighted. Becomes a PDF annotation.',
              },
              startText: {
                type: 'string',
                description: 'Optional: text to match within the first line to start the highlight at a specific word rather than the beginning of the line.',
              },
              endText: {
                type: 'string',
                description: 'Optional: text to match within the last line to end the highlight at a specific word rather than the end of the line.',
              },
            },
            required: ['page', 'lines'],
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
    name: 'open_viewer',

    description: 'Open a document in the Scribe PDF viewer (desktop app). If the viewer is already open, it navigates to the requested file and page. Supports PDF and image files.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Path to the document file.',
        },
        page: {
          type: 'integer',
          description: 'Page number to display (0-indexed). Default: 0.',
        },
      },
      required: ['file'],
    },
  },
  {
    name: 'navigate_page',
    description: 'Navigate the already-open Scribe PDF viewer to a specific page without re-importing the document. Much faster than open_viewer for page changes. The viewer must already be open with the same file.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Path to the document file (must match the file currently open in the viewer).',
        },
        page: {
          type: 'integer',
          description: 'Page number to navigate to (0-indexed).',
        },
      },
      required: ['file', 'page'],
    },
  },
  {
    name: 'apply_viewer_highlights',
    description: 'Apply highlights to the live Scribe PDF viewer. Uses the same highlight format as create_highlighted_pdf but applies them interactively in the viewer instead of exporting to a file. The viewer must already be open with the document loaded.',
    inputSchema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          description: 'Path to the document file (must match the file currently open in the viewer).',
        },
        highlights: {
          type: 'array',
          description: 'Array of highlight specifications (same format as create_highlighted_pdf).',
          items: {
            type: 'object',
            properties: {
              page: {
                type: 'integer',
                description: 'Page number (0-indexed).',
              },
              lines: {
                type: 'array',
                items: { type: 'integer' },
                description: 'Line numbers to highlight (0-indexed).',
              },
              color: {
                type: 'string',
                description: 'Hex color for the highlight (e.g. "#ffff00" for yellow). Default: yellow.',
              },
              comment: {
                type: 'string',
                description: 'Comment explaining why this passage is highlighted.',
              },
              startText: {
                type: 'string',
                description: 'Optional: text to match within the first line to start the highlight at a specific word.',
              },
              endText: {
                type: 'string',
                description: 'Optional: text to match within the last line to end the highlight at a specific word.',
              },
            },
            required: ['page', 'lines'],
          },
        },
      },
      required: ['file', 'highlights'],
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
];

const toolHandlers = {
  list_documents: (args) => enqueue(() => listDocuments(args)),
  load_document: (args) => enqueue(() => loadDocument(args)),
  extract_document_text: (args) => enqueue(() => extractDocumentText(args)),
  create_highlighted_pdf: (args) => enqueue(() => createHighlightedPdf(args)),
  open_viewer: (args) => openViewer(args),
  navigate_page: (args) => navigatePage(args),
  apply_viewer_highlights: (args) => applyViewerHighlights(args),
  render_page: (args) => enqueue(() => renderPage(args)),
  subset_pdf: (args) => enqueue(() => subsetPdf(args)),
  merge_pdfs: (args) => enqueue(() => mergePdfs(args)),
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
