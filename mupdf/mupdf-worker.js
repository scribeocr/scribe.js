// Copyright (C) 2004-2021 Artifex Software, Inc.
//
// This file is part of MuPDF.
//
// MuPDF is free software: you can redistribute it and/or modify it under the
// terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version.
//
// MuPDF is distributed in the hope that it will be useful, but WITHOUT ANY
// WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
// FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more
// details.
//
// You should have received a copy of the GNU Affero General Public License
// along with MuPDF. If not, see <https://www.gnu.org/licenses/agpl-3.0.en.html>
//
// Alternative licensing terms are available from the licensor.
// For commercial licensing, see <https://www.artifex.com/> or contact
// Artifex Software, Inc., 1305 Grant Avenue - Suite 200, Novato,
// CA 94945, U.S.A., +1(415)492-9861, for further information.

const parentPort = typeof process === 'undefined' ? globalThis : (await import('worker_threads')).parentPort;
if (!parentPort) throw new Error('This file must be run in a worker');

// Copied from https://gist.github.com/jonleighton/958841
function arrayBufferToBase64(arrayBuffer) {
  let base64 = '';
  const encodings = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  const bytes = new Uint8Array(arrayBuffer);
  const byteLength = bytes.byteLength;
  const byteRemainder = byteLength % 3;
  const mainLength = byteLength - byteRemainder;

  let a;
  let b;
  let c;
  let d;
  let chunk;

  // Main loop deals with bytes in chunks of 3
  for (let i = 0; i < mainLength; i += 3) {
    // Combine the three bytes into a single integer
    chunk = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];

    // Use bitmasks to extract 6-bit segments from the triplet
    a = (chunk & 16515072) >> 18; // 16515072 = (2^6 - 1) << 18
    b = (chunk & 258048) >> 12; // 258048   = (2^6 - 1) << 12
    c = (chunk & 4032) >> 6; // 4032     = (2^6 - 1) << 6
    d = chunk & 63; // 63       = 2^6 - 1

    // Convert the raw binary segments to the appropriate ASCII encoding
    base64 += encodings[a] + encodings[b] + encodings[c] + encodings[d];
  }

  // Deal with the remaining bytes and padding
  if (byteRemainder == 1) {
    chunk = bytes[mainLength];

    a = (chunk & 252) >> 2; // 252 = (2^6 - 1) << 2

    // Set the 4 least significant bits to zero
    b = (chunk & 3) << 4; // 3   = 2^2 - 1

    base64 += `${encodings[a] + encodings[b]}==`;
  } else if (byteRemainder == 2) {
    chunk = (bytes[mainLength] << 8) | bytes[mainLength + 1];

    a = (chunk & 64512) >> 10; // 64512 = (2^6 - 1) << 10
    b = (chunk & 1008) >> 4; // 1008  = (2^6 - 1) << 4

    // Set the 2 least significant bits to zero
    c = (chunk & 15) << 2; // 15    = 2^4 - 1

    base64 += `${encodings[a] + encodings[b] + encodings[c]}=`;
  }

  return base64;
}

export const mupdf = {};
let ready = false;

if (typeof process === 'object') {
  // @ts-ignore
  globalThis.self = globalThis;
  // @ts-ignore
  const { createRequire } = await import('module');
  globalThis.require = createRequire(import.meta.url);
  const { fileURLToPath } = await import('url');
  const { dirname } = await import('path');
  globalThis.__dirname = dirname(fileURLToPath(import.meta.url));
}

const { Module, FS } = await import('./libmupdf.js');

globalThis.Module = Module;
globalThis.FS = FS;

let wasm_pageText0;
let wasm_checkNativeText;
let wasm_extractAllFonts;
let wasm_pdfSaveDocument;
let wasm_runPDF;
let wasm_convertImageStart;
let wasm_convertImageAddPage;
let wasm_convertImageEnd;

Module.onRuntimeInitialized = function () {
  Module.ccall('initContext');
  mupdf.openDocumentFromBuffer = Module.cwrap('openDocumentFromBuffer', 'number', ['string', 'number', 'number']);
  mupdf.freeDocument = Module.cwrap('freeDocument', 'null', ['number']);
  mupdf.documentTitle = Module.cwrap('documentTitle', 'string', ['number']);
  mupdf.countPages = Module.cwrap('countPages', 'number', ['number']);
  mupdf.pageWidth = Module.cwrap('pageWidth', 'number', ['number', 'number', 'number']);
  mupdf.pageHeight = Module.cwrap('pageHeight', 'number', ['number', 'number', 'number']);
  mupdf.pageLinksJSON = Module.cwrap('pageLinks', 'string', ['number', 'number', 'number']);
  mupdf.doDrawPageAsPNG = Module.cwrap('doDrawPageAsPNG', 'null', ['number', 'number', 'number', 'number']);
  mupdf.doDrawPageAsPNGGray = Module.cwrap('doDrawPageAsPNGGray', 'null', ['number', 'number', 'number', 'number']);
  wasm_convertImageStart = Module.cwrap('convertImageStart', 'null', ['number']);
  wasm_convertImageAddPage = Module.cwrap('convertImageAddPage', 'null', ['number', 'number', 'number', 'number', 'number']);
  wasm_convertImageEnd = Module.cwrap('convertImageEnd', 'null', ['number']);
  wasm_runPDF = Module.cwrap('runPDF', 'null', ['number', 'number', 'number', 'number', 'number', 'number', 'number']);
  wasm_pdfSaveDocument = Module.cwrap('pdfSaveDocument', 'null', ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number']);
  mupdf.getLastDrawData = Module.cwrap('getLastDrawData', 'number', []);
  mupdf.getLastDrawSize = Module.cwrap('getLastDrawSize', 'number', []);
  wasm_extractAllFonts = Module.cwrap('extractAllFonts', 'number', ['number']);
  wasm_pageText0 = Module.cwrap('pageText', 'PageTextResults', ['number', 'number', 'number', 'number', 'number', 'number', 'number']);
  mupdf.overlayDocuments = Module.cwrap('pdfOverlayDocuments', 'null', ['number', 'number']);
  mupdf.subsetPages = Module.cwrap('pdfSubsetPages', 'null', ['number', 'number', 'number']);
  mupdf.searchJSON = Module.cwrap('search', 'string', ['number', 'number', 'number', 'string']);
  mupdf.loadOutline = Module.cwrap('loadOutline', 'number', ['number']);
  mupdf.freeOutline = Module.cwrap('freeOutline', null, ['number']);
  mupdf.outlineTitle = Module.cwrap('outlineTitle', 'string', ['number']);
  mupdf.outlinePage = Module.cwrap('outlinePage', 'number', ['number', 'number']);
  mupdf.outlineDown = Module.cwrap('outlineDown', 'number', ['number']);
  mupdf.outlineNext = Module.cwrap('outlineNext', 'number', ['number']);
  wasm_checkNativeText = Module.cwrap('checkNativeText', 'number', ['number', 'number']);
  mupdf.writeDocument = Module.cwrap('writeDocument', 'null', []);
  parentPort.postMessage('READY');
  ready = true;
};

/**
 *
 * @param {number} doc - Ignored (included as boilerplate for consistency with other functions).
 * @param {Object} args
 * @param {number} args.doc1 - Document to write.
 * @param {number} [args.minpage=0] - First page to include in the output PDF. Default is 0.
 * @param {number} [args.maxpage=-1] - Last page to include in the output PDF. Default is -1 (all pages).
 * @param {number} [args.pagewidth=-1] - Width of the pages in the output PDF. Default is -1 (same as input).
 * @param {number} [args.pageheight=-1] - Height of the pages in the output PDF. Default is -1 (same as input).
 * @param {Boolean} [args.humanReadable=false]
 * @param {Boolean} [args.skipTextInvis=false]
 * @param {Boolean} [args.delGarbage=true]
 * @returns
 */
mupdf.save = function (doc, {
  doc1, minpage = 0, maxpage = -1, pagewidth = -1, pageheight = -1, humanReadable = false, skipTextInvis = false, delGarbage = true,
}) {
  wasm_pdfSaveDocument(doc1, minpage, maxpage, pagewidth, pageheight, humanReadable, skipTextInvis, delGarbage);
  const content = FS.readFile('/download.pdf');

  FS.unlink('/download.pdf');
  return content;
};

/**
 *
 * @param {number} doc
 * @param {Object} args
 * @param {number} args.page
 * @param {number} [args.dpi = 72]
 * @param {'text'|'txt'|'html'|'xhtml'|'xml'|'json'} [args.format = 'text']
 * @param {boolean} [args.skipTextInvis=false]
 * @param {boolean} [args.calcStats=false]
 * @returns {{letterCountTotal: number, letterCountVis: number, content: string}}
 */
mupdf.pageText = function (doc, {
  page, dpi = 72, format = 'text', skipTextInvis = false, calcStats = false,
}) {
  const formatCode = {
    txt: 0,
    text: 0,
    html: 1,
    xhtml: 2,
    xml: 3,
    json: 4,
  }[format];

  const structPtr = wasm_pageText0(doc, page, dpi, formatCode, skipTextInvis, calcStats, true);

  const letterCountTotal = Module.getValue(structPtr, 'i32');
  const letterCountVis = Module.getValue(structPtr + 4, 'i32');
  const dataPtr = Module.getValue(structPtr + 8, 'i32');

  const content = Module.UTF8ToString(dataPtr);

  Module._free(dataPtr);

  return {
    letterCountTotal,
    letterCountVis,
    content,
  };
};

/**
 *
 * @param {number} doc
 */
mupdf.extractAllFonts = function (doc) {
  const fontCount = wasm_extractAllFonts(doc);

  const fontArr = [];
  for (let i = 0; i < fontCount; i++) {
    const fontFile = `font-${String(i + 1).padStart(4, '0')}.ttf`;
    fontArr.push(FS.readFile(fontFile));
    FS.unlink(fontFile);
  }

  return fontArr;
};

/**
 *
 * @param {number} doc
 */
mupdf.checkNativeText = function (doc) {
  return wasm_checkNativeText(doc, false);
};

/**
 *
 * @param {number} doc
 */
mupdf.detectExtractText = function (doc) {
  const res = wasm_checkNativeText(doc, true);
  let text = FS.readFile('/download.txt', { encoding: 'utf8' });

  // Sometimes mupdf makes files with an excessive number of newlines.
  // Therefore, a maximum of 2 newlines is allowed.
  if (typeof text === 'string') {
    text = text.replace(/(\n\s*){3,}/g, '\n\n').trim();
  }
  FS.unlink('/download.txt');

  const type = ['Text native', 'Image + OCR text', 'Image native'][res];

  return {
    type,
    text,
  };
};

mupdf.cleanFile = function (data) {
  FS.writeFile('test_1.pdf', data);
  // Module.FS_createDataFile("/", "test_1.pdf", data, 1, 1, 1)
  mupdf.writeDocument();
  const content = FS.readFile('/test_2.pdf');

  FS.unlink('/test_1.pdf');
  FS.unlink('/test_2.pdf');
  return content;
};

/**
 *
 * @param {number} doc
 * @param {Object} args
 * @param {Boolean} args.humanReadable
 */
mupdf.convertImageStart = function (doc, { humanReadable = false }) {
  wasm_convertImageStart(humanReadable);
};

/**
 *
 * @param {number} doc - doc is ignored (the active document is always the first argument, although not used here)
 * @param {Object} args
 * @param {string} args.image
 * @param {number} args.i
 * @param {number} args.pagewidth
 * @param {number} args.pageheight
 * @param {number} [args.angle=0] - Angle in degrees to rotate the image counter-clockwise.
 */
mupdf.convertImageAddPage = function (doc, {
  image, i, pagewidth, pageheight, angle = 0,
}) {
  const imgData = new Uint8Array(atob(image.split(',')[1])
    .split('')
    .map((c) => c.charCodeAt(0)));

  // Despite the images being named as PNG, they can be any format supported by mupdf.
  Module.FS_createDataFile('/', `${String(i)}.png`, imgData, 1, 1, 1);

  wasm_convertImageAddPage(i, pagewidth, pageheight, angle);

  FS.unlink(`${String(i)}.png`);
};

mupdf.convertImageEnd = function () {
  wasm_convertImageEnd();
  const content = FS.readFile('/download.pdf');
  FS.unlink('/download.pdf');
  return content;
};

/**
 *
 * @param {number} doc - Ignored (included as boilerplate for consistency with other functions).
 * @param {Object} args
 * @param {number} args.doc1 - Document to write.
 * @param {number} [args.minpage=0] - First page to include in the output PDF. Default is 0.
 * @param {number} [args.maxpage=-1] - Last page to include in the output PDF. Default is -1 (all pages).
 * @param {number} [args.pagewidth=-1] - Width of the pages in the output PDF. Default is -1 (same as input).
 * @param {number} [args.pageheight=-1] - Height of the pages in the output PDF. Default is -1 (same as input).
 * @param {Boolean} [args.humanReadable=false]
 * @returns
 */
mupdf.run = function (doc, {
  doc1, minpage = 0, maxpage = -1, pagewidth = -1, pageheight = -1, humanReadable = false,
}) {
  wasm_runPDF(doc1, minpage, maxpage, pagewidth, pageheight, humanReadable);
  const content = FS.readFile('/download.pdf');

  FS.unlink('/download.pdf');
  return content;
};

mupdf.openDocument = function (data, magic) {
  const n = data.byteLength;
  const ptr = Module._malloc(n);
  const src = new Uint8Array(data);
  Module.HEAPU8.set(src, ptr);
  return mupdf.openDocumentFromBuffer(magic, ptr, n);
};

/**
 *
 * @param {number} doc
 * @param {Object} args
 * @param {number} args.page
 * @param {number} args.dpi
 * @param {boolean} [args.color=true]
 * @param {boolean} [args.skipText=false]
 * @returns
 */
mupdf.drawPageAsPNG = function (doc, {
  page, dpi, color = true, skipText = false,
}) {
  if (color) {
    mupdf.doDrawPageAsPNG(doc, page, dpi, skipText);
  } else {
    mupdf.doDrawPageAsPNGGray(doc, page, dpi, skipText);
  }

  const n = mupdf.getLastDrawSize();
  const p = mupdf.getLastDrawData();
  return `data:image/png;base64,${arrayBufferToBase64(Module.HEAPU8.buffer.slice(p, p + n))}`;
};

mupdf.documentOutline = function (doc) {
  function makeOutline(node) {
    const list = [];
    while (node) {
      const entry = {
        title: mupdf.outlineTitle(node),
        page: mupdf.outlinePage(doc, node),
      };
      const down = mupdf.outlineDown(node);
      if (down) entry.down = makeOutline(down);
      list.push(entry);
      node = mupdf.outlineNext(node);
    }
    return list;
  }
  const root = mupdf.loadOutline(doc);
  if (root) {
    let list = null;
    try {
      list = makeOutline(root);
    } finally {
      mupdf.freeOutline(root);
    }
    return list;
  }
  return null;
};

mupdf.pageSizes = function (doc, dpi) {
  const list = [];
  const n = mupdf.countPages(doc);
  for (let i = 1; i <= n; ++i) {
    const w = mupdf.pageWidth(doc, i, dpi);
    const h = mupdf.pageHeight(doc, i, dpi);
    list[i] = [w, h];
  }
  return list;
};

mupdf.pageLinks = function (doc, page, dpi) {
  return JSON.parse(mupdf.pageLinksJSON(doc, page, dpi));
};

mupdf.search = function (doc, page, dpi, needle) {
  return JSON.parse(mupdf.searchJSON(doc, page, dpi, needle));
};

const handleMessage = (data) => {
  const [func, args, id] = data;
  if (!ready) {
    parentPort.postMessage(['ERROR', id, { name: 'NotReadyError', message: 'WASM module is not ready yet' }]);
    return;
  }

  if (func === 'PING') {
    ready = true;
    parentPort.postMessage(['READY']);
  }

  try {
    const result = mupdf[func](...args);
    if (result instanceof ArrayBuffer) parentPort.postMessage(['RESULT', id, result], [result]);
    else if (result?.buffer instanceof ArrayBuffer) {
      parentPort.postMessage(['RESULT', id, result], [result.buffer]);
    } else parentPort.postMessage(['RESULT', id, result]);
  } catch (error) {
    parentPort.postMessage(['ERROR', id, { name: error.name, message: error.message }]);
  }
};

if (typeof process === 'undefined') {
  onmessage = (event) => handleMessage(event.data);
} else {
  parentPort.on('message', handleMessage);
}
