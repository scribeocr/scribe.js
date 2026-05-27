// Browser-side harness for the scribe.js server-Textract proxy.
//
// Loads scribe.js directly as ES modules (no bundler), lets the user pick a PDF,
// streams per-page parsed OcrPage results from the reference server,
// and installs each one into the local ScribeDoc via doc.insertParsedPage().
// Includes a Cancel button that exercises the end-to-end abort path
// (fetch abort -> TCP close -> server req.on('close') -> doc.recognize signal on the server).

import scribe from '../../../scribe.js';
import { OcrPage } from '../../../js/objects/ocrObjects.js';

const SERVER_ENGINE_NAME = 'Server Textract';

// Streams parsed OCR results from the server-textract-proxy backend.
//
// On success each yielded entry is `{ pageNum, page, dataTables, warn }`:
//   - `page` is the parsed OcrPage scribe.js produced from Textract on the server.
//   - `dataTables` is the per-page LayoutDataTablePage
//     (empty if the server wasn't asked to extract tables).
//   - `warn` is the per-page conversion-warning object.
//
// On per-page failure the shape is `{ pageNum, error: { message } }` instead.
//
// Feed each entry into `doc.insertParsedPage(...)` on the browser side.
// The server already ran conversion, so no further scribe.js work is needed.
//
// The PDF is uploaded once and the response body is the NDJSON stream.
// AbortSignal is forwarded straight to fetch(),
// so cancelling on the browser tears down the connection,
// which the server picks up via req.on('close').
/**
 * Stream parsed OCR pages from a server-textract-proxy backend.
 *
 * @param {string} serverUrl
 * @param {ArrayBuffer} pdfBytes
 * @param {{ signal?: AbortSignal, headers?: Record<string,string> }} [options]
 * @returns {AsyncGenerator<
 *   { pageNum: number, page: object, dataTables: object, warn: object }
 *   | { pageNum: number, error: { message: string } }
 * >}
 */
async function* streamServerOcr(serverUrl, pdfBytes, { signal, headers } = {}) {
  const res = await fetch(serverUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', ...(headers || {}) },
    body: pdfBytes,
    signal,
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Proxy returned ${res.status} ${res.statusText}${errBody ? `: ${errBody}` : ''}`);
  }
  if (!res.body) throw new Error('Proxy response has no body.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) yield JSON.parse(line);
        nl = buf.indexOf('\n');
      }
      if (done) break;
    }
    buf += decoder.decode();
    const tail = buf.trim();
    if (tail) yield JSON.parse(tail);
  } finally {
    reader.cancel().catch(() => { /* noop */ });
  }
}

// We're sending the PDF to Textract; scribe.js's own PDF-native text extraction would
// run during importFiles by default (driven by opt.usePDFText.*), which pulls in the
// full font-loading pipeline. For this demo we don't want any of that — we only need
// scribe.js to hold the PDF bytes and merge per-page Textract JSON results on the way
// out. Disabling every usePDFText flag makes importFiles short-circuit the
// extractInternalPDFText() path entirely.
scribe.ScribeDoc.defaults.usePDFText.native.main = false;
scribe.ScribeDoc.defaults.usePDFText.native.supp = false;
scribe.ScribeDoc.defaults.usePDFText.ocr.main = false;
scribe.ScribeDoc.defaults.usePDFText.ocr.supp = false;
scribe.ScribeDoc.defaults.keepPDFTextAlways = false;

const uploaderEl = document.getElementById('uploader');
const serverUrlEl = document.getElementById('serverUrl');
const serverUrlDisplay = document.getElementById('serverUrlDisplay');
const runBtn = document.getElementById('run');
const cancelBtn = document.getElementById('cancel');
const exportBtn = document.getElementById('export');
const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');

serverUrlDisplay.textContent = serverUrlEl.value;
serverUrlEl.addEventListener('input', () => { serverUrlDisplay.textContent = serverUrlEl.value; });

let currentController = null;
let currentDoc = null;
let haveResults = false;

const log = (msg) => {
  const line = document.createElement('div');
  line.textContent = msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  // Also mirror to devtools console, because surprise errors on unawaited promises
  // (e.g. font fetches) land in the console and it's useful to see them interleaved
  // with our own progress lines.
  console.log('[demo]', msg);
};

const setStatus = (msg) => { statusEl.textContent = msg; };

// Surface any unhandled promise rejection in our log instead of only the devtools.
// Font fetches in particular are fire-and-forget inside scribe.js; if one fails the
// rejection bubbles here and we want the user to see it without opening the console.
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  log(`UNHANDLED: ${(reason && (reason.stack || reason.message)) || reason}`);
});

// Self-test: verify the static server actually serves scribe.js's font files from the
// path `import.meta.url` will resolve against. If this fails at page load, everything
// downstream will too — catch it here with an actionable message instead of letting
// scribe.js's internal fetches throw "Failed to fetch" mid-recognize.
(async () => {
  const probeUrl = new URL('../../../fonts/latin/NimbusSans-Regular.woff', import.meta.url).href;
  log(`probing font asset: ${probeUrl}`);
  try {
    const r = await fetch(probeUrl, { method: 'GET' });
    if (!r.ok) {
      log(`  -> HTTP ${r.status} ${r.statusText}`);
      setStatus(`Static server isn't serving scribe.js fonts (HTTP ${r.status}). Check that http-server is rooted at scribe.js/.`);
      return;
    }
    const ab = await r.arrayBuffer();
    log(`  -> OK (${ab.byteLength} bytes)`);
  } catch (err) {
    log(`  -> fetch threw: ${err && (err.message || err)}`);
    setStatus('Font probe fetch threw. Open devtools → Network tab and hard-reload (Ctrl+Shift+R) to see the real HTTP error.');
  }
})();

uploaderEl.addEventListener('change', () => {
  runBtn.disabled = !uploaderEl.files || uploaderEl.files.length === 0;
  exportBtn.disabled = true;
  haveResults = false;
  setStatus(runBtn.disabled ? 'Pick a PDF to begin.' : 'Ready. Click Recognize.');
});

runBtn.addEventListener('click', async () => {
  if (!uploaderEl.files || uploaderEl.files.length === 0) return;

  logEl.innerHTML = '';
  haveResults = false;
  exportBtn.disabled = true;
  runBtn.disabled = true;
  cancelBtn.disabled = false;
  setStatus('Initializing scribe.js…');

  const started = performance.now();
  let pagesReceived = 0;
  let pagesFailed = 0;

  try {
    await scribe.init();

    setStatus('Importing PDF…');
    const pdfArrayBuffer = await uploaderEl.files[0].arrayBuffer();
    currentDoc = await scribe.openDocument({ pdfFiles: [pdfArrayBuffer] });
    log(`PDF imported: ${currentDoc.inputData.pageCount} page(s)`);

    // The server fires its own progress events through its ScribeDoc.
    // On the browser side the only progress signal is each NDJSON line as it arrives.
    // doc.insertParsedPage re-emits a `convert` event per page,
    // but we already know which page just landed from the for-await,
    // so we log directly from the loop instead of routing through the global handler.

    const ac = new AbortController();
    currentController = ac;

    setStatus('Streaming OCR from server…');
    log(`POST → ${serverUrlEl.value.trim()}`);

    for await (const entry of streamServerOcr(serverUrlEl.value.trim(), pdfArrayBuffer, { signal: ac.signal })) {
      if (entry.error) {
        pagesFailed++;
        const dims = currentDoc.pageMetrics[entry.pageNum].dims;
        currentDoc.insertParsedPage(entry.pageNum, new OcrPage(entry.pageNum, dims), { engineName: SERVER_ENGINE_NAME });
        log(`  page ${entry.pageNum} failed: ${entry.error.message}`);
        continue;
      }
      currentDoc.insertParsedPage(entry.pageNum, entry.page, {
        engineName: SERVER_ENGINE_NAME,
        dataTables: entry.dataTables,
        warn: entry.warn,
      });
      pagesReceived++;
      const elapsed = ((performance.now() - started) / 1000).toFixed(2);
      log(`  +${elapsed}s  page ${entry.pageNum} received  (${pagesReceived}/${currentDoc.inputData.pageCount})`);
    }

    const elapsed = ((performance.now() - started) / 1000).toFixed(2);
    if (pagesFailed > 0) {
      setStatus(`Done in ${elapsed}s — ${pagesReceived} page(s) recognized, ${pagesFailed} failed.`);
    } else {
      setStatus(`Done in ${elapsed}s — ${pagesReceived} page(s) recognized.`);
    }
    haveResults = pagesReceived > 0;
  } catch (err) {
    if (err && err.name === 'AbortError') {
      log('-- aborted --');
      setStatus(`Cancelled. ${pagesReceived} page(s) completed before abort; partial results preserved.`);
      haveResults = pagesReceived > 0;
    } else {
      console.error(err);
      log(`ERROR: ${err.message || err}`);
      setStatus(`Error: ${err.message || err}`);
    }
  } finally {
    currentController = null;
    runBtn.disabled = !uploaderEl.files || uploaderEl.files.length === 0;
    cancelBtn.disabled = true;
    exportBtn.disabled = !haveResults;
  }
});

cancelBtn.addEventListener('click', () => {
  if (currentController) {
    currentController.abort();
    cancelBtn.disabled = true;
  }
});

exportBtn.addEventListener('click', async () => {
  exportBtn.disabled = true;
  setStatus('Building searchable PDF…');
  try {
    const pdfBytes = await currentDoc.exportData('pdf');
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (uploaderEl.files?.[0]?.name || 'document').replace(/\.pdf$/i, '') + '.searchable.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setStatus(`Exported ${a.download}`);
  } catch (err) {
    console.error(err);
    setStatus(`Export failed: ${err.message || err}`);
  } finally {
    exportBtn.disabled = false;
  }
});
