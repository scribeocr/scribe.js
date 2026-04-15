#!/usr/bin/env node
// Reference server for running AWS Textract on the backend of a scribe.js-based site.
//
// The browser POSTs a PDF to POST /ocr. This server imports the PDF into scribe.js,
// runs the stock RecognitionModelTextract adapter (sync endpoint, with multi-region
// round-robin throughput scaling), and streams per-page Textract JSON back as NDJSON
// as each page completes. The browser-side custom RecognitionModel uses documentMode
// to skip its own rendering and merge these results directly into its OCR state.
//
// Client disconnects are detected via req.on('close') and propagated into
// scribe.recognize() via AbortSignal, so an abandoned upload stops billing AWS as
// soon as the in-flight page settles instead of running to completion.
//
// Usage:
//   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
//   TEXTRACT_REGIONS=us-east-1,us-west-2 \
//   node server.js
//
// This example ships request serialization (a simple in-process mutex) because scribe.js
// uses module-level state and concurrent requests would stomp each other. For higher
// throughput, run N copies behind a load balancer (e.g. node:cluster); one region-rich
// request is already fast enough for most workloads.

import http from 'node:http';
import crypto from 'node:crypto';
import scribe from '../../scribe.js';
import { RecognitionModelTextract } from '../../cloud-adapters/aws-textract/RecognitionModelAwsTextract.js';

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

// Simple FIFO mutex. scribe.js has module-level state (inputData, ocrAll, ...),
// so we cannot run two recognition jobs concurrently in the same process.
let tail = Promise.resolve();
const withLock = (fn) => {
  const run = tail.then(fn, fn);
  tail = run.catch(() => {});
  return run;
};

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

  // Client-disconnect detection. When the browser drops TCP (refresh, close tab,
  // navigate away, explicit AbortController.abort on the client), propagate into
  // scribe.recognize() so it stops scheduling new pages and the mutex releases for
  // the next queued request.
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

  // scribe.importFiles accepts ArrayBuffer in its sorted-input form. Copy out of the
  // Node Buffer's underlying pool so we hand over an exact, standalone ArrayBuffer.
  const pdfArrayBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);

  await withLock(async () => {
    if (ac.signal.aborted) {
      log('aborted before acquiring lock, skipping recognition');
      return;
    }
    log('acquired mutex, starting recognition');

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

    // Force-keep raw Textract JSON so we can flush it to the response as each page lands.
    scribe.opt.keepRawData = true;

    // The stock scribe.js recognize loop fires `recognize` progressHandler events per page
    // (status: 'sending' when dispatched to Textract, 'received' when raw JSON returns) and
    // a `convert` event once scribe.js has parsed the raw JSON into its OcrPage model. We:
    //   - log 'sending' / 'received' to show request-level activity
    //   - emit NDJSON on `convert`, at which point scribe.data.ocrRaw[ENGINE_NAME][n] is
    //     guaranteed to hold the raw string.
    const emitted = new Set();
    const prevProgress = scribe.opt.progressHandler;
    scribe.opt.progressHandler = (msg) => {
      try {
        if (msg && msg.type === 'recognize' && msg.info && msg.info.engineName === ENGINE_NAME) {
          if (msg.info.status === 'sending') log(`page ${msg.n} → Textract`);
          else if (msg.info.status === 'received') log(`page ${msg.n} ← Textract`);
        } else if (msg && msg.type === 'convert' && msg.info && msg.info.engineName === ENGINE_NAME) {
          const n = msg.n;
          if (typeof n === 'number' && !emitted.has(n)) {
            const rawData = scribe.data.ocrRaw[ENGINE_NAME]?.[n];
            if (rawData) {
              emitted.add(n);
              log(`page ${n} converted, streaming ${rawData.length} bytes`);
              writeNDJSON({ pageNum: n, rawData });
            } else {
              log(`page ${n} convert event fired but ocrRaw empty (skipping)`);
            }
          }
        }
      } catch (err) {
        // Never let progress handler errors take down recognition.
        console.error(`[${reqId}] progressHandler error:`, formatErr(err));
      }
      if (prevProgress) prevProgress(msg);
    };

    try {
      await scribe.init();
      log('scribe.init done');
      await scribe.importFiles({ pdfFiles: [pdfArrayBuffer] });
      log(`imported: ${scribe.inputData.pageCount} page(s)`);

      await scribe.recognize({
        model: /** @type {any} */ (RecognitionModelTextract),
        modelOptions: {
          region: TEXTRACT_REGIONS.length > 1 ? TEXTRACT_REGIONS : TEXTRACT_REGIONS[0],
          analyzeLayout: ANALYZE_LAYOUT,
          analyzeTables: ANALYZE_TABLES,
        },
        signal: ac.signal,
      });
      log(`recognition complete, ${emitted.size} page(s) streamed`);

      // Flush error markers for any pages that did not produce a `convert` event
      // (e.g. failed pages recorded as empty OcrPage instances), so the client doesn't
      // silently drop them.
      const rawAll = scribe.data.ocrRaw[ENGINE_NAME] || [];
      for (let n = 0; n < rawAll.length; n++) {
        if (!emitted.has(n)) {
          log(`page ${n} produced no OCR data, emitting error marker`);
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
      scribe.opt.progressHandler = prevProgress;
      try { await scribe.terminate(); } catch (_) { /* ignore */ }
      if (!res.writableEnded) res.end();
      log('request closed');
    }
  });
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

server.listen(PORT, () => {
  console.log(`scribe.js Textract proxy listening on http://localhost:${PORT}`);
  console.log(`  regions: ${TEXTRACT_REGIONS.join(', ')}`);
  console.log(`  analyzeLayout=${ANALYZE_LAYOUT} analyzeTables=${ANALYZE_TABLES}`);
});
