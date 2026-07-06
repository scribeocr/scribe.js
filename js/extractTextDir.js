// Node-only, reached only via the Node-guarded `extractTextDir`/`extractTextDirIter` in scribe.js.
// The main thread only enumerates paths and writes output; the CPU-bound extraction runs in the worker pool (see extractTextDirWorker.js).

const supportedExtensions = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif']);

/**
 * Stream supported file paths under `inputDir`, optionally recursing into subdirectories.
 * Uses a manual directory queue (one non-recursive `opendir` per directory) so it is stable on the Node 20 floor and never materializes the whole listing.
 * Directory symlinks are not followed (a symlinked directory reports `isDirectory() === false`, so it is simply not queued), which keeps the walk cycle-safe.
 * The input directory failing to open is a real error. An unreadable subdirectory is skipped.
 * @param {typeof import('node:fs')} fs
 * @param {typeof import('node:path')} path
 * @param {string} inputDir
 * @param {boolean} recursive
 */
async function* walkFiles(fs, path, inputDir, recursive) {
  const dirQueue = [inputDir];
  let isRoot = true;
  while (dirQueue.length > 0) {
    const dir = dirQueue.shift();
    let handle;
    try {
      handle = await fs.promises.opendir(dir);
    } catch (err) {
      if (isRoot) throw err;
      isRoot = false;
      continue;
    }
    isRoot = false;
    for await (const entry of handle) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive) dirQueue.push(full);
      } else if (entry.isFile() && supportedExtensions.has(path.extname(entry.name).toLowerCase())) {
        yield full;
      }
    }
  }
}

/**
 * Extract each document's existing text (no OCR) from a directory, yielding one result per file as it completes. Node.js only.
 * Documents are farmed across `options.workers` worker threads, so results arrive in completion order, not directory order.
 *
 * @param {string} inputDir - Directory to read input files from.
 * @param {Object} [options]
 * @param {'pdf'|'hocr'|'docx'|'xlsx'|'txt'|'text'|'html'|'md'} [options.format='txt'] - Export format.
 * @param {boolean} [options.recursive=false] - Recurse into subdirectories.
 * @param {number} [options.workers=4] - Number of documents to process in parallel.
 * @param {boolean} [options.reflow] - Combine lines into paragraphs (defaults on).
 * @param {boolean} [options.lineNumbers] - Prefix each line with `page:line` (txt only).
 * @yields {{ inputPath: string, text?: (string|Uint8Array), error?: { name?: string, message: string, code?: string } }}
 *    On success, `text` holds the exported content (empty for a document with no text).
 *    On failure, `error` describes why the file was skipped.
 *    A failing file is never fatal to the batch.
 */
export async function* extractTextDirIter(inputDir, options = {}) {
  const fs = (await import('node:fs')).default;
  const path = (await import('node:path')).default;
  const { Worker } = await import('node:worker_threads');

  const workerCount = Math.max(1, Number(options.workers) || 4);
  const workerData = {
    format: options.format || 'txt',
    reflow: options.reflow,
    lineNumbers: options.lineNumbers,
  };

  const spawnWorker = () => new Promise((resolve) => {
    const worker = new Worker(new URL('./worker/extractTextDirWorker.js', import.meta.url), { workerData });
    const state = { worker, dead: false, inflight: null };
    const settle = (msg) => {
      const cb = state.inflight;
      state.inflight = null;
      if (cb) cb(msg);
    };
    worker.on('message', (msg) => {
      if (msg && msg.type === 'ready') { resolve(state); return; }
      settle(msg);
    });
    // A worker-level error/exit is a hard failure.
    // Mark the worker dead so its runner stops pulling new work, and fail whatever job was in flight rather than hanging.
    worker.on('error', (err) => {
      state.dead = true;
      settle({ ok: false, error: { name: err?.name || 'WorkerError', message: String(err?.message ?? err), code: err?.code } });
    });
    worker.on('exit', () => {
      state.dead = true;
      settle({ ok: false, error: { name: 'WorkerExit', message: 'Worker exited unexpectedly' } });
    });
    state.run = (inputPath) => new Promise((res) => {
      if (state.dead) { res({ ok: false, error: { name: 'WorkerDead', message: 'Worker no longer available' } }); return; }
      state.inflight = res;
      worker.postMessage({ inputPath });
    });
    state.terminate = () => worker.terminate();
  });

  const workers = await Promise.all(Array.from({ length: workerCount }, spawnWorker));

  // Serialize access to the shared file generator: concurrent `.next()` on one async generator is unsafe, so each runner's pull is chained after the previous one.
  const fileGen = walkFiles(fs, path, inputDir, !!options.recursive);
  let genChain = Promise.resolve();
  const nextPath = () => {
    const pull = genChain.then(() => fileGen.next());
    genChain = pull.then(() => undefined, () => undefined);
    return pull;
  };

  // Results channel drained by the loop below.
  const buffer = [];
  let notify = null;
  const wake = () => { if (notify) { const n = notify; notify = null; n(); } };
  const push = (item) => { buffer.push(item); wake(); };
  const waitForItem = () => new Promise((resolve) => { notify = resolve; });

  let done = false;
  let walkError = null;
  const runner = async (state) => {
    let next = await nextPath();
    while (!next.done && !state.dead) {
      const inputPath = next.value;
      const res = await state.run(inputPath);
      push({ inputPath, ...res });
      if (state.dead) break;
      next = await nextPath();
    }
  };
  Promise.all(workers.map(runner)).then(
    () => { done = true; wake(); },
    (err) => { done = true; walkError = err; wake(); },
  );

  try {
    while (!done || buffer.length > 0) {
      if (buffer.length === 0) {
        await waitForItem();
        continue;
      }
      const item = buffer.shift();
      if (item.ok) {
        yield { inputPath: item.inputPath, text: item.text };
      } else {
        yield { inputPath: item.inputPath, error: item.error };
      }
    }
    if (walkError) throw walkError;
  } finally {
    await Promise.all(workers.map((s) => s.terminate()));
  }
}

/**
 * Extract each document's existing text (no OCR) from a directory and write one output file per input, mirroring the input tree under `outputDir`. Node.js only.
 * Files that fail to parse are skipped (never fatal).
 * A document that parses to no text still produces a (possibly empty) output file.
 *
 * @param {string} inputDir - Directory to read input files from.
 * @param {string} outputDir - Directory to write output files into (mirrors the input tree).
 * @param {Parameters<typeof extractTextDirIter>[1] & { onProgress?: (p: { inputPath: string, ok: boolean, extracted: number, skipped: number }) => void }} [options]
 *    `onProgress`, if given, is called after each file with the running counts (for progress reporting on large batches).
 * @returns {Promise<{ extracted: number, skipped: number, failures: Array<{ inputPath: string, error: { name?: string, message: string, code?: string } }> }>}
 */
export async function extractTextDir(inputDir, outputDir, options = {}) {
  const fs = (await import('node:fs')).default;
  const path = (await import('node:path')).default;

  const format = options.format || 'txt';
  const ext = format === 'text' ? 'txt' : format;
  const onProgress = options.onProgress;

  const summary = { extracted: 0, skipped: 0, failures: [] };
  const createdDirs = new Set();

  for await (const result of extractTextDirIter(inputDir, options)) {
    if (result.error) {
      summary.skipped += 1;
      summary.failures.push({ inputPath: result.inputPath, error: result.error });
    } else {
      const rel = path.relative(inputDir, result.inputPath);
      // Swap the input extension for the output one, appending it to names with no extension so the output never collides with the input.
      const relOut = /\.\w{1,6}$/i.test(rel) ? rel.replace(/\.\w{1,6}$/i, `.${ext}`) : `${rel}.${ext}`;
      const outPath = path.join(outputDir, relOut);
      const outParent = path.dirname(outPath);
      if (!createdDirs.has(outParent)) {
        fs.mkdirSync(outParent, { recursive: true });
        createdDirs.add(outParent);
      }
      fs.writeFileSync(outPath, result.text ?? '');
      summary.extracted += 1;
    }
    if (onProgress) {
      onProgress({
        inputPath: result.inputPath,
        ok: !result.error,
        extracted: summary.extracted,
        skipped: summary.skipped,
      });
    }
  }

  return summary;
}
