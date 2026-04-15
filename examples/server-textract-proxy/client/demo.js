// Browser-side harness for the scribe.js server-Textract proxy.
//
// Loads scribe.js directly as ES modules (no bundler), lets the user pick a PDF,
// calls scribe.recognize() with RecognitionModelServerProxy, and streams per-page
// results back from the reference server. Includes a Cancel button that exercises
// the end-to-end abort path (scribe.recognize signal → fetch abort → TCP close →
// server req.on('close') → scribe.recognize signal on the server).

import scribe from '../../../scribe.js';
import { RecognitionModelServerProxy } from './RecognitionModelServerProxy.js';

// We're sending the PDF to Textract; scribe.js's own PDF-native text extraction would
// run during importFiles by default (driven by opt.usePDFText.*), which pulls in the
// full font-loading pipeline. For this demo we don't want any of that — we only need
// scribe.js to hold the PDF bytes and merge per-page Textract JSON results on the way
// out. Disabling every usePDFText flag makes importFiles short-circuit the
// extractInternalPDFText() path entirely.
scribe.opt.usePDFText.native.main = false;
scribe.opt.usePDFText.native.supp = false;
scribe.opt.usePDFText.ocr.main = false;
scribe.opt.usePDFText.ocr.supp = false;
scribe.opt.keepPDFTextAlways = false;

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
  const prevProgress = scribe.opt.progressHandler;
  let pagesReceived = 0;

  try {
    await scribe.init();

    setStatus('Importing PDF…');
    await scribe.importFiles({ pdfFiles: [uploaderEl.files[0]] });
    log(`PDF imported: ${scribe.inputData.pageCount} page(s)`);

    // Watch the same `convert` progress events the server uses, so the UI shows each
    // page as it lands off the NDJSON stream.
    scribe.opt.progressHandler = (msg) => {
      if (msg && msg.type === 'convert' && msg.info && msg.info.engineName === 'Server Textract') {
        pagesReceived++;
        const elapsed = ((performance.now() - started) / 1000).toFixed(2);
        log(`  +${elapsed}s  page ${msg.n} received  (${pagesReceived}/${scribe.inputData.pageCount})`);
      }
      if (prevProgress) prevProgress(msg);
    };

    const ac = new AbortController();
    currentController = ac;

    setStatus('Streaming OCR from server…');
    log('POST → ' + serverUrlEl.value.trim());

    await scribe.recognize({
      model: RecognitionModelServerProxy,
      modelOptions: { serverUrl: serverUrlEl.value.trim() },
      signal: ac.signal,
    });

    const elapsed = ((performance.now() - started) / 1000).toFixed(2);
    setStatus(`Done in ${elapsed}s — ${pagesReceived} page(s) recognized.`);
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
    scribe.opt.progressHandler = prevProgress;
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
    const pdfBytes = await scribe.exportData('pdf');
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
