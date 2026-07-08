// Node-only worker for `extractTextDir`/`extractTextDirIter`.
// Each worker extracts one document's text single-threaded in-process (`opt.inProcess`), so the pool's unit of parallelism is the whole document.
import scribe from '../../scribe.js';

// Guarded dynamic import of node:worker_threads keeps the browser bundle clean.
const wt = typeof process === 'undefined' ? null : await import('node:worker_threads');
const parentPort = wt ? wt.parentPort : globalThis;
const config = (wt && wt.workerData) || {};

// Each worker has its own isolated scribe instance, so these globals never leak to the library caller.
scribe.opt.inProcess = true;
scribe.ScribeDoc.defaults.reflow = config.reflow ?? true;
scribe.ScribeDoc.defaults.usePDFText.ocr.main = true; // Trust existing text because this path never runs OCR.
scribe.ScribeDoc.defaults.displayMode = 'ebook';
if (config.lineNumbers) scribe.ScribeDoc.defaults.lineNumbers = true;

const format = config.format || 'txt';
// `.scribe.json` is the uncompressed scribe export; both scribe forms map to the 'scribe' format.
// Char boxes (`word.chars`) are excluded from scribe output by default; --char-boxes re-includes them.
const isScribe = format === 'scribe' || format === 'scribe.json';
const exportFormat = isScribe ? 'scribe' : format;
const exportOptions = isScribe
  ? { compressScribe: format === 'scribe', includeCharBoxesScribe: !!config.charBoxes }
  : undefined;

// Load built-in fonts once so every document this worker handles reuses them.
await scribe.init({ font: true });
parentPort.postMessage({ type: 'ready' });

parentPort.on('message', async ({ inputPath }) => {
  try {
    const doc = await scribe.openDocument([inputPath]);
    const text = await doc.exportData(exportFormat, exportOptions);
    await doc.terminate();
    // A parse that yields no text still resolves here as a successful empty extraction.
    // A parse failure instead throws and is reported by the catch below.
    parentPort.postMessage({ ok: true, text });
  } catch (err) {
    parentPort.postMessage({
      ok: false,
      error: { name: err?.name, message: String(err?.message ?? err), code: err?.code },
    });
  }
});
