import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { remote } from 'webdriverio';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const argValue = (flag, fallback) => (args.indexOf(flag) === -1 ? fallback : args[args.indexOf(flag) + 1]);
const VIEWER_ROOT = path.resolve(ROOT, argValue('--root', 'scribe-ui/basic-viewer/vscode/staging'));
const browserName = argValue('--browser', 'chrome');
const crossOriginRun = args.includes('--cross-origin');
const PDF = path.join(ROOT, 'tests/test-assets/M.D.Fla._8_25-cv-03557-MSS-AEP_1_4_p6.pdf');
const NATIVE_LINES = 119;
// This document's first page is drawn with a built-in substitute font.
const PDF2 = path.join(ROOT, 'tests/test-assets/E.D.Mich._2_12-cv-13821-AC-DRG_1_0.pdf');
const PDF2_PAGES = 6;
const PDF2_LINES_PAGE0 = 39;

const docs = new Map();
const app = express();
const crossOrigin = (res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
};
app.get('/doc/:name', (req, res) => {
  crossOrigin(res);
  const bytes = docs.get(req.params.name);
  if (!bytes) {
    res.status(404).end();
    return;
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.end(bytes);
});
app.use(express.static(VIEWER_ROOT, { setHeaders: crossOrigin }));
app.use('/src', express.static(ROOT, { setHeaders: crossOrigin }));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => { server.once('listening', resolve); });
const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
// The page and the viewer tree it loads sit on two origins, as a webview's page and its resources do.
const viewerOrigin = `http://127.0.0.1:${port}`;
const pageOrigin = `http://localhost:${port}`;

const CANVAS_HASH = `globalThis.__canvasHash = () => {
  const cs = [...document.querySelectorAll('#pdfViewerCont canvas')].filter((c) => c.width > 50 && c.height > 50).sort((a, b) => b.width * b.height - a.width * a.height);
  if (!cs.length) return null;
  const c = cs[0]; const ctx = c.getContext('2d'); if (!ctx) return null;
  const d = ctx.getImageData(0, 0, c.width, c.height).data; let dark = 0; let h = 0x811c9dc5;
  for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  for (let i = 0; i < d.length; i += 4) { if (d[i + 3] > 0 && d[i] + d[i + 1] + d[i + 2] < 384) dark++; }
  return { w: c.width, h: c.height, hash: h.toString(16), dark };
};`;

// The courier refuses a worker's requests to the viewer origin, as VS Code's webview service worker does.
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'text/javascript');
  res.end(`
const VIEWER = ${JSON.stringify(viewerOrigin)};
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (new URL(event.request.url).origin !== VIEWER) return;
  event.respondWith((async () => {
    const client = event.clientId ? await self.clients.get(event.clientId) : null;
    if (client && client.type === 'window') return fetch(event.request);
    for (const w of await self.clients.matchAll({ type: 'window' })) w.postMessage({ type: 'refused', url: event.request.url });
    await new Promise((r) => setTimeout(r, 500));
    return new Response('nothing is served to workers', { status: 408 });
  })());
});`);
});
app.get('/register.html', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!DOCTYPE html><html><body><script>
navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(() => navigator.serviceWorker.ready).then(() => { window.__registered = true; });
</script></body></html>`);
});

// The page the extension writes (see scribe-ui/basic-viewer/vscode/extension.js).
app.get('/page/:name', (req, res) => {
  const { name } = req.params;
  const config = { doc: `${viewerOrigin}/doc/${name}`, name, page: 0 };
  if (!crossOriginRun) config.workers = 'fetch';
  const csp = [
    "default-src 'none'",
    `script-src ${viewerOrigin} 'nonce-smoke' 'wasm-unsafe-eval'`,
    'worker-src blob:',
    `style-src ${viewerOrigin} 'unsafe-inline'`,
    `img-src ${viewerOrigin} blob: data:`,
    `font-src ${viewerOrigin} blob: data:`,
    `connect-src ${viewerOrigin} blob: data:`,
  ].join('; ');
  const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta id="viewer-config" data-config="${attr(JSON.stringify(config))}">
  <style>
    html, body { margin: 0; padding: 0; overflow: hidden; }
    #pdfViewerCont { width: 100vw; height: 100vh; }
  </style>
  <script nonce="smoke">
    globalThis.__messages = [];
    globalThis.__refused = [];
    globalThis.__controlled = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'refused') globalThis.__refused.push(e.data.url); });
    globalThis.acquireVsCodeApi = () => ({ postMessage: (m) => globalThis.__messages.push(m), getState: () => undefined, setState: () => {} });
    ${CANVAS_HASH}
  </script>
  <script type="module" src="${viewerOrigin}/scribe-ui/basic-viewer/vscode/vscode-entry.js"></script>
</head>
<body class="vscode-dark">
  <div id="pdfViewerCont"></div>
</body>
</html>`);
});

app.get('/worker-free.html', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;overflow:hidden}#pdfViewerCont{width:100vw;height:100vh}</style>
<script>${CANVAS_HASH}</script></head><body><div id="pdfViewerCont"></div>
<script type="module">
const scribe = (await import('/src/scribe.js')).default;
scribe.opt.inProcess = true;
const { pdfViewer } = await import('/src/scribe-ui/basic-viewer/example-app.js');
const name = new URLSearchParams(location.search).get('doc');
const buf = await (await fetch('/doc/' + name)).arrayBuffer();
// Opened as a tab, as the extension's page opens its document, so both pages show the tab strip and draw the document at the same size.
await pdfViewer.openFiles([new File([buf], name, { type: 'application/pdf' })]);
globalThis.__viewer = pdfViewer;
</script></body></html>`);
});

/** @type {Record<string, any>} */
const chromeOptions = { args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--window-size=1400,1000'] };
if (process.env.CHROMIUM_BINARY) chromeOptions.binary = process.env.CHROMIUM_BINARY;
/** @type {Record<string, any>} */
const firefoxOptions = { args: ['-headless', '-width', '1400', '-height', '1000'] };
if (process.env.FIREFOX_BINARY) firefoxOptions.binary = process.env.FIREFOX_BINARY;
/** @type {Record<string, any>} */
const capabilities = browserName === 'firefox'
  ? { browserName: 'firefox', 'moz:firefoxOptions': firefoxOptions }
  : { browserName: 'chrome', 'goog:chromeOptions': chromeOptions };
if (browserName !== 'firefox' && process.env.CHROMEDRIVER_BINARY) capabilities['wdio:chromedriverOptions'] = { binary: process.env.CHROMEDRIVER_BINARY };

const browser = await remote({ capabilities, logLevel: 'error' });

/**
 * @param {string} label
 * @param {(arg: any) => Promise<any>} pageFn
 * @param {any} arg
 * @param {number} timeoutMs
 */
const runInPage = async (label, pageFn, arg, timeoutMs) => {
  const started = Date.now();
  await browser.execute(`window.__smokeStep = { done: false }; (${pageFn.toString()})(arguments[0]).then((value) => { window.__smokeStep = { done: true, ok: true, value }; }, (e) => { window.__smokeStep = { done: true, ok: false, error: String((e && e.stack) || e) }; });`, arg);
  await browser.waitUntil(async () => browser.execute(() => !!(window.__smokeStep && window.__smokeStep.done)), { timeout: timeoutMs, interval: 250, timeoutMsg: `${label}: no result after ${timeoutMs} ms` });
  const result = await browser.execute(() => window.__smokeStep);
  if (!result.ok) throw new Error(`${label}: ${result.error}`);
  console.log(`${label}: ${Date.now() - started} ms`);
  return result.value;
};

const hashWhenDrawn = async () => {
  const inked = () => { const h = globalThis.__canvasHash(); return h && h.dark > 20 ? h : null; };
  for (let i = 0; i < 300; i += 1) {
    if (inked()) break;
    await new Promise((r) => { setTimeout(r, 50); });
  }
  // The viewer can redraw a page after its first ink, so the hash is taken once it holds still for a moment.
  let last = null;
  for (let i = 0; i < 40; i += 1) {
    const h = inked();
    if (h && last && h.hash === last.hash) return h;
    last = h;
    await new Promise((r) => { setTimeout(r, 200); });
  }
  return last;
};

/** @param {string} name */
const openPage = async (name) => {
  const started = Date.now();
  await browser.url(`${pageOrigin}/page/${name}`);
  await browser.waitUntil(async () => browser.execute(() => (globalThis.__messages || []).some((m) => m.type === 'ready')), {
    timeout: 120000, interval: 250, timeoutMsg: `${name}: the page did not report ready within 120 s`,
  });
  console.log(`open ${name}: ${Date.now() - started} ms`);
  return browser.execute(() => {
    const viewer = globalThis.df.pdfViewer;
    return {
      pages: viewer.pageCount,
      lines: viewer.scribe.doc?.ocr.active[0]?.lines.length ?? -1,
      theme: viewer.pdfViewerElem.getAttribute('data-theme'),
      controlled: globalThis.__controlled,
      fetched: !!globalThis.df.scribe.opt.fetchWorkerScripts,
    };
  });
};

const refused = () => browser.execute(() => globalThis.__refused.slice());

let failed = false;
try {
  if (!crossOriginRun) {
    await browser.url(`${pageOrigin}/register.html`);
    await browser.waitUntil(async () => browser.execute(() => !!window.__registered), { timeout: 30000, interval: 100, timeoutMsg: 'the service worker did not register' });
  }
  docs.set('smoke.pdf', fs.readFileSync(PDF));
  const opened = await openPage('smoke.pdf');
  if (opened.controlled !== !crossOriginRun) throw new Error(`service worker: expected the page ${crossOriginRun ? 'not ' : ''}to be controlled`);
  if (opened.fetched !== !crossOriginRun) throw new Error(`workers: expected opt.fetchWorkerScripts to be ${!crossOriginRun}`);
  if (opened.pages !== 1) throw new Error(`open PDF: expected 1 page, got ${opened.pages}`);
  if (opened.lines !== NATIVE_LINES) throw new Error(`open PDF: expected ${NATIVE_LINES} extracted lines, got ${opened.lines}`);
  if (opened.theme !== 'dark') throw new Error(`theme: expected the viewer dark under a vscode-dark body, got ${JSON.stringify(opened.theme)}`);
  const recognizeShown = await browser.execute(() => !!globalThis.df.pdfViewer._recognizeTool?.toolbarElem.isConnected);
  if (recognizeShown) throw new Error('recognition: the Recognize Text button is shown, but this build has no OCR engine');

  await browser.execute(() => { document.body.className = 'vscode-light'; });
  await browser.waitUntil(async () => browser.execute(() => globalThis.df.pdfViewer.pdfViewerElem.getAttribute('data-theme') === null), {
    timeout: 5000, interval: 100, timeoutMsg: 'theme: the viewer did not follow the body class to light',
  });
  console.log('theme: follows the body class');

  const hooks = await runInPage('hooks', async () => {
    const { opt } = globalThis.df.scribe;
    globalThis.__messages.length = 0;
    opt.openExternal('https://example.com/');
    await opt.saveAs(new Blob(['hello']), 'hello.txt');
    return globalThis.__messages.map((m) => ({
      type: m.type, name: m.name, url: m.url, bytes: m.bytes ? m.bytes.length : undefined,
    }));
  }, null, 10000);
  const expectedHooks = JSON.stringify([{ type: 'openExternal', url: 'https://example.com/' }, { type: 'save', name: 'hello.txt', bytes: 5 }]);
  if (JSON.stringify(hooks) !== expectedHooks) throw new Error(`hooks: expected ${expectedHooks}, got ${JSON.stringify(hooks)}`);

  docs.set('smoke.pdf', fs.readFileSync(PDF2));
  await browser.execute(() => { window.postMessage({ type: 'reload' }, '*'); });
  await browser.waitUntil(async () => browser.execute((pages, lines) => {
    const viewer = globalThis.df.pdfViewer;
    return viewer.pageCount === pages && viewer.scribe.doc?.ocr.active[0]?.lines.length === lines;
  }, PDF2_PAGES, PDF2_LINES_PAGE0), {
    timeout: 60000, interval: 250, timeoutMsg: `reload: the viewer did not show the ${PDF2_PAGES}-page document with ${PDF2_LINES_PAGE0} lines on its first page within 60 s`,
  });
  console.log('reload: replaced the document in place');

  await browser.execute(() => { window.postMessage({ type: 'navigate', page: 3 }, '*'); });
  await browser.waitUntil(async () => browser.execute(() => globalThis.df.pdfViewer.currentPage === 3), {
    timeout: 30000, interval: 250, timeoutMsg: 'navigate: the viewer did not land on page index 3',
  });
  console.log('navigate: page index 3');

  const session = await runInPage('export session', async () => {
    const out = await globalThis.df.pdfViewer.scribe.doc.exportData('scribe', { compressScribe: true });
    const bytes = typeof out === 'string' ? new TextEncoder().encode(out) : new Uint8Array(out instanceof Uint8Array ? out : new Uint8Array(out));
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
    return btoa(binary);
  }, null, 60000);
  const refusedSoFar = await refused();
  if (refusedSoFar.length) throw new Error(`courier: ${refusedSoFar.length} request(s) from a worker were refused, the first ${refusedSoFar[0]}`);
  docs.set('smoke.scribe', Buffer.from(session, 'base64'));
  const reopened = await openPage('smoke.scribe');
  if (reopened.pages !== PDF2_PAGES) throw new Error(`.scribe route: expected ${PDF2_PAGES} pages, got ${reopened.pages}`);
  if (reopened.lines !== PDF2_LINES_PAGE0) throw new Error(`.scribe route: expected ${PDF2_LINES_PAGE0} lines on the first page, got ${reopened.lines}`);

  docs.set('fonts.pdf', fs.readFileSync(PDF2));
  await openPage('fonts.pdf');
  const drawn = await runInPage('draw with workers', hashWhenDrawn, null, 60000);
  const refusedAll = await refused();
  if (refusedAll.length) throw new Error(`courier: ${refusedAll.length} request(s) from a worker were refused, the first ${refusedAll[0]}`);
  const sheetTools = await runInPage('phone Edit sheet', async () => {
    const viewer = globalThis.df.pdfViewer;
    viewer.resize(400, 800);
    await new Promise((r) => { setTimeout(r, 300); });
    viewer._dockEditBtn.click();
    const names = [...viewer._modeSheetElem.querySelectorAll('.scribe-mode-sheet-nm')].map((n) => n.textContent);
    viewer._closeModeSheet();
    return names;
  }, null, 30000);
  const expectedSheet = 'Edit Text, Edit Graphics, Fill & Sign, Edit Pages, Inspect Document';
  if (sheetTools.join(', ') !== expectedSheet) throw new Error(`phone layout: expected the Edit sheet to list ${expectedSheet}, without Recognize Text, got ${sheetTools.join(', ')}`);
  console.log('phone layout: the Edit sheet leaves out Recognize Text');
  await browser.url(`${viewerOrigin}/worker-free.html?doc=fonts.pdf`);
  await browser.waitUntil(async () => browser.execute(() => !!globalThis.__viewer), { timeout: 120000, interval: 250, timeoutMsg: 'worker-free: the page did not open the document within 120 s' });
  const drawnWithout = await runInPage('draw without workers', hashWhenDrawn, null, 60000);
  if (!drawn || !drawnWithout) throw new Error(`fonts: a page did not draw (${JSON.stringify(drawn)} / ${JSON.stringify(drawnWithout)})`);
  if (drawn.w !== drawnWithout.w || drawn.h !== drawnWithout.h) {
    throw new Error(`fonts: the two pages drew at different sizes, ${drawn.w}x${drawn.h} and ${drawnWithout.w}x${drawnWithout.h}, so their pixels cannot be compared`);
  }
  if (drawn.hash !== drawnWithout.hash) {
    throw new Error(`fonts: the page drawn with workers (hash ${drawn.hash}, ${drawn.dark} dark pixels) differs from the worker-free drawing `
      + `(hash ${drawnWithout.hash}, ${drawnWithout.dark} dark pixels); the substitute font did not load the same way`);
  }
  console.log(`fonts: the drawings match (hash ${drawn.hash}, ${drawn.dark} dark pixels)`);

  console.log(`smoke test passed (${browserName}, ${path.relative(ROOT, VIEWER_ROOT) || '.'}${crossOriginRun ? ', cross-origin workers' : ', fetched workers'})`);
} catch (err) {
  failed = true;
  console.error(`smoke test FAILED (${browserName}): ${err instanceof Error ? err.message : err}`);
} finally {
  await browser.deleteSession().catch(() => {});
  server.close();
}
process.exit(failed ? 1 : 0);
