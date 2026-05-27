#!/usr/bin/env node
// Reference HTTP server for running AWS Textract from the backend of a scribe.js
// browser application. The point of routing OCR through your own server,
// rather than calling Textract directly from the browser,
// is that AWS credentials stay on the server and never reach the user.
//
// How it works:
//   - The browser POSTs a PDF to `POST /ocr` (Content-Type: application/pdf).
//   - The server runs scribe.js end-to-end on that PDF:
//     it sends each page to Textract, converts the response into scribe.js's
//     OcrPage data model, and writes one NDJSON line per page to the response stream.
//   - The browser-side demo at `client/demo.js`
//     reads that NDJSON and calls `doc.insertParsedPage(...)` for each entry.
//     Conversion has already happened on the server,
//     so the browser just installs the structured pages.
//
// Each NDJSON line for a successful page contains the parsed `OcrPage`,
// the per-page layout `dataTables`, and a `warn` object for any conversion warning.
// Failed pages send `{ pageNum, error: { message } }` instead.
//
// Client disconnects (refresh, tab close, explicit `AbortController.abort` on the client)
// are detected via `res.on('close')` and propagated into `doc.recognize()` through an
// `AbortSignal`. An abandoned upload stops billing AWS as soon as the in-flight page
// settles, rather than running to completion.
//
// Usage:
//   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
//   TEXTRACT_REGIONS=us-east-1,us-west-2 \
//   node server.js
//
// See README.md for environment variables and deployment notes.
//
// Concurrency: this example serves concurrent requests in a single Node process.
// Each request gets its own `ScribeDoc` with its own `progressHandler`,
// `warningHandler`, and `errorHandler`,
// so two uploads in flight at the same time stream independently without cross-talk.
// For horizontal scaling, run N copies behind a load balancer (e.g. via `node:cluster`).

import http from 'node:http';
import crypto from 'node:crypto';
import scribe from '../../scribe.js';
import { RecognitionModelTextract } from '../../cloud-adapters/aws-textract/RecognitionModelAwsTextract.js';
import { removeCircularRefsOcr } from '../../js/objects/ocrObjects.js';
import { removeCircularRefsDataTables } from '../../js/objects/layoutObjects.js';

// Crash visibility: surface unhandled errors instead of silently dying.
/** @param {any} err */
const formatErr = (err) => (err && (err.stack || err.message || String(err))) || String(err);
process.on('unhandledRejection', (err) => {
  console.error('[fatal] unhandledRejection:', formatErr(err));
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', formatErr(err));
});

const PORT = Number(process.env.PORT || 3000);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const TEXTRACT_REGIONS = (process.env.TEXTRACT_REGIONS || process.env.AWS_REGION || 'us-east-1')
  .split(',').map((r) => r.trim()).filter(Boolean);
const ANALYZE_LAYOUT = process.env.TEXTRACT_LAYOUT === '1' || process.env.TEXTRACT_LAYOUT === 'true';
const ANALYZE_TABLES = process.env.TEXTRACT_TABLES === '1' || process.env.TEXTRACT_TABLES === 'true';
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 100 * 1024 * 1024);

const ENGINE_NAME = RecognitionModelTextract.config.name;

const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let total = 0;
  req.on('data', (chunk) => {
    total += chunk.length;
    if (total > MAX_UPLOAD_BYTES) {
      reject(Object.assign(new Error('Upload exceeds MAX_UPLOAD_BYTES'), { statusCode: 413 }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const writeCORS = (res) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
};

const handleOCR = async (req, res) => {
  const reqId = crypto.randomBytes(3).toString('hex');
  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(2)}s`;
  /** @param {...any} parts */
  const log = (...parts) => console.log(`[${reqId}] +${elapsed()}`, ...parts);

  log(`POST ${req.url} from ${req.socket.remoteAddress || '?'}`);

  // Client-disconnect detection.
  // When the browser drops TCP (refresh, close tab, navigate away, explicit
  // AbortController.abort on the client), propagate the abort into doc.recognize()
  // so it stops scheduling new pages instead of running the rest of the upload.
  //
  // Use `res.on('close')` gated on `res.writableFinished`. Node also fires a 'close'
  // event on `req`, but in modern Node that fires when the readable side completes
  // (i.e. right after `req.on('end')`), NOT when the client goes away — so using it
  // would abort every normal request the instant the body finishes uploading. The
  // `res` stream's close event is the authoritative "the socket went away" signal,
  // and `writableFinished` distinguishes "we already sent the full response" from
  // "we were still writing when the client vanished".
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) {
      log('client disconnected, aborting');
      ac.abort(Object.assign(new Error('Client disconnected'), { name: 'AbortError' }));
    }
  });

  const body = await readBody(req);
  if (body.length === 0) {
    log('empty body, replying 400');
    res.statusCode = 400;
    res.end('Empty body. POST a PDF as application/pdf.');
    return;
  }
  log(`PDF received: ${(body.length / 1024 / 1024).toFixed(2)} MB`);

  // scribe.openDocument accepts ArrayBuffer in its sorted-input form. Copy out of the
  // Node Buffer's underlying pool so we hand over an exact, standalone ArrayBuffer.
  const pdfArrayBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);

  if (ac.signal.aborted) {
    log('aborted before opening document, skipping recognition');
    return;
  }

  res.statusCode = 200;
  writeCORS(res);
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-store');
  // Disable proxy buffering so the browser sees lines as they're written.
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  /** @param {object} obj */
  const writeNDJSON = (obj) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`${JSON.stringify(obj)}\n`);
  };

  /** @type {import('../../js/containers/scribeDoc.js').ScribeDoc | undefined} */
  let doc;
  const emitted = new Set();

  try {
    doc = await scribe.openDocument({ pdfFiles: [pdfArrayBuffer] });
    log(`imported: ${doc.inputData.pageCount} page(s)`);

    // scribe.js's recognize loop fires per-page events:
    //   - `recognize` with status: 'sending' when dispatched to Textract
    //   - `recognize` with status: 'received' when raw JSON returns
    //   - `convert` once scribe.js has parsed the raw JSON into its OcrPage model
    // We log 'sending'/'received' for request-level visibility,
    // and on `convert` we emit one NDJSON line per page.
    // At that point doc.ocr[ENGINE_NAME][n] holds the parsed OcrPage,
    // doc.layoutDataTables.pages[n] holds the per-page tables,
    // and doc.convertPageWarn[n] holds the per-page conversion warning.
    doc.progressHandler = (msg) => {
      try {
        if (msg && msg.type === 'recognize' && msg.info && msg.info.engineName === ENGINE_NAME) {
          if (msg.info.status === 'sending') log(`page ${msg.n} → Textract`);
          else if (msg.info.status === 'received') log(`page ${msg.n} ← Textract`);
        } else if (msg && msg.type === 'convert' && msg.info && msg.info.engineName === ENGINE_NAME) {
          const n = msg.n;
          if (typeof n === 'number' && !emitted.has(n)) {
            const page = doc?.ocr[ENGINE_NAME]?.[n];
            if (page) {
              emitted.add(n);
              const strippedPage = removeCircularRefsOcr([page])[0];
              const strippedTables = removeCircularRefsDataTables([doc.layoutDataTables.pages[n]])[0];
              const warn = doc.convertPageWarn[n] || {};
              log(`page ${n} converted, streaming`);
              writeNDJSON({
                pageNum: n, page: strippedPage, dataTables: strippedTables, warn,
              });
            } else {
              log(`page ${n} convert event fired but no OcrPage on doc (skipping)`);
            }
          }
        }
      } catch (err) {
        // Never let progress handler errors take down recognition.
        console.error(`[${reqId}] progressHandler error:`, formatErr(err));
      }
    };

    // Surface per-page Textract failures (throttling, invalid input, etc.)
    // with the real error message so the client knows why a page is missing.
    // Document-scoped warnings (no `page`) become top-level error markers in the stream.
    doc.warningHandler = ({ message, page }) => {
      log(`warning${page !== undefined ? ` (page ${page})` : ''}: ${message}`);
      if (page !== undefined) {
        if (!emitted.has(page)) {
          emitted.add(page);
          writeNDJSON({ pageNum: page, error: { message } });
        }
      } else {
        writeNDJSON({ error: { message } });
      }
    };

    doc.errorHandler = ({ message, page }) => {
      log(`error${page !== undefined ? ` (page ${page})` : ''}: ${message}`);
      if (page !== undefined) {
        if (!emitted.has(page)) {
          emitted.add(page);
          writeNDJSON({ pageNum: page, error: { message } });
        }
      } else {
        writeNDJSON({ error: { message } });
      }
    };

    await doc.recognize({
      model: /** @type {any} */ (RecognitionModelTextract),
      modelOptions: {
        region: TEXTRACT_REGIONS.length > 1 ? TEXTRACT_REGIONS : TEXTRACT_REGIONS[0],
        analyzeLayout: ANALYZE_LAYOUT,
        analyzeTables: ANALYZE_TABLES,
      },
      signal: ac.signal,
    });
    log(`recognition complete, ${emitted.size} page(s) streamed`);

    // Safety net for a page that fires neither a `convert` event nor a warning.
    // With doc.warningHandler wired up this should be empty in practice,
    // but the client must not silently drop a page.
    const pageAll = doc.ocr[ENGINE_NAME] || [];
    for (let n = 0; n < pageAll.length; n++) {
      if (!emitted.has(n)) {
        log(`page ${n} produced no OCR data and no warning, emitting fallback error marker`);
        writeNDJSON({ pageNum: n, error: { message: 'No OCR data produced for page' } });
      }
    }
  } catch (err) {
    /** @type {any} */
    const e = err;
    if (e && e.name === 'AbortError') {
      log(`aborted mid-recognition; ${emitted.size} page(s) completed this run`);
      return;
    }
    console.error(`[${reqId}] recognition error:`, formatErr(e));
    writeNDJSON({ error: { message: e && e.message ? e.message : String(e) } });
    throw e;
  } finally {
    try { if (doc) await doc.terminate(); } catch (_) { /* ignore */ }
    if (!res.writableEnded) res.end();
    log('request closed');
  }
};

const server = http.createServer(async (req, res) => {
  writeCORS(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }
  if (req.method === 'POST' && req.url === '/ocr') {
    try {
      await handleOCR(req, res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) {
        res.statusCode = err.statusCode || 500;
        res.end(err.message || 'Server error');
      } else if (!res.writableEnded) {
        res.end();
      }
    }
    return;
  }
  res.statusCode = 404;
  res.end('Not found');
});

// Pre-load the shared OCR/font workers once at startup
// so the first request doesn't pay the init cost.
// The shared pool is reused across all concurrent requests by design.
await scribe.init();

server.listen(PORT, () => {
  console.log(`scribe.js Textract proxy listening on http://localhost:${PORT}`);
  console.log(`  regions: ${TEXTRACT_REGIONS.join(', ')}`);
  console.log(`  analyzeLayout=${ANALYZE_LAYOUT} analyzeTables=${ANALYZE_TABLES}`);
});
