// Smoke test of the built app in `dist/`, run against the build output rather than the sources.
// The test suites never see the bundle, so this is what catches a build that succeeds but does not run.
// Usage: `npm run build && node tests/smoke/distSmoke.mjs --browser chrome|firefox`
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { remote } from 'webdriverio';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = path.join(ROOT, 'dist');
const browserArg = process.argv.indexOf('--browser');
const browserName = browserArg === -1 ? 'chrome' : process.argv[browserArg + 1];
const PDF = '/tests/test-assets/M.D.Fla._8_25-cv-03557-MSS-AEP_1_4_p6.pdf';
// The count this document yields today.
// A different value means extraction or recognition changed, not that the build is broken.
const NATIVE_LINES = 90;
const OCR_LINES = 90;
// Page rasters differ slightly between browsers, so recognition can land a line or two apart.
// A band rather than an exact count keeps the Firefox run from going flaky.
const OCR_LINES_TOLERANCE = 10;

// A fallback to the source tree would hide a file missing from dist/.
const app = express();
app.use(express.static(DIST));
app.use('/tests/test-assets', express.static(path.join(ROOT, 'tests/test-assets')));
app.use('/tests/test-lang-data', express.static(path.join(ROOT, 'tests/test-lang-data')));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => { server.once('listening', resolve); });
const base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}`;

/** @type {Record<string, any>} */
const chromeOptions = { args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.CHROMIUM_BINARY) chromeOptions.binary = process.env.CHROMIUM_BINARY;
/** @type {Record<string, any>} */
const firefoxOptions = { args: ['-headless'] };
if (process.env.FIREFOX_BINARY) firefoxOptions.binary = process.env.FIREFOX_BINARY;
/** @type {Record<string, any>} */
const capabilities = browserName === 'firefox'
  ? { browserName: 'firefox', 'moz:firefoxOptions': firefoxOptions }
  : { browserName: 'chrome', 'goog:chromeOptions': chromeOptions };
if (browserName !== 'firefox' && process.env.CHROMEDRIVER_BINARY) capabilities['wdio:chromedriverOptions'] = { binary: process.env.CHROMEDRIVER_BINARY };

const browser = await remote({ capabilities, logLevel: 'error' });

/**
 * Run an async function inside the page and wait for its result.
 * @param {string} label
 * @param {(arg: any) => Promise<any>} pageFn - Must not close over anything; it runs in the page.
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

let failed = false;
try {
  const started = Date.now();
  await browser.url(`${base}/index.html`);
  await browser.waitUntil(async () => browser.execute(() => !!(globalThis.df && globalThis.df.pdfViewer)), { timeout: 30000, interval: 100, timeoutMsg: 'viewer did not boot within 30 s' });
  console.log(`boot: ${Date.now() - started} ms`);

  const opened = await runInPage('open PDF', async (pdfPath) => {
    const buf = await (await fetch(pdfPath)).arrayBuffer();
    const viewer = globalThis.df.pdfViewer;
    await viewer.importFile(new File([buf], 'smoke.pdf', { type: 'application/pdf' }), 0);
    const { doc } = viewer.scribe;
    if (doc.textReady) await doc.textReady;
    return { pages: doc.ocr.active.length, lines: doc.ocr.active[0] ? doc.ocr.active[0].lines.length : -1 };
  }, PDF, 60000);
  if (opened.pages !== 1) throw new Error(`open PDF: expected 1 page, got ${opened.pages}`);
  if (opened.lines !== NATIVE_LINES) throw new Error(`open PDF: expected ${NATIVE_LINES} extracted lines, got ${opened.lines}`);

  await runInPage('OCR init', async (langPath) => {
    globalThis.df.scribe.opt.langPath = langPath;
    await globalThis.df.scribe.init({ ocr: true });
    return true;
  }, '/tests/test-lang-data', 180000);

  const ocrLines = await runInPage('recognize', async () => {
    const { doc } = globalThis.df.pdfViewer.scribe;
    await doc.recognize({ langs: ['eng'] });
    return doc.ocr.active[0].lines.length;
  }, null, 300000);
  if (Math.abs(ocrLines - OCR_LINES) > OCR_LINES_TOLERANCE) throw new Error(`recognize: expected about ${OCR_LINES} lines, got ${ocrLines}`);

  const exported = await runInPage('export PDF', async () => {
    const { doc } = globalThis.df.pdfViewer.scribe;
    const out = await doc.exportData('pdf');
    const bytes = out instanceof Uint8Array ? out : new Uint8Array(out);
    const text = new TextDecoder('latin1').decode(bytes);
    const pagesDict = text.match(/<<[^>]*\/Type\s*\/Pages[^>]*>>/);
    const count = pagesDict && pagesDict[0].match(/\/Count\s+(\d+)/);
    return { head: text.slice(0, 5), pageCount: count ? Number(count[1]) : null, size: bytes.length };
  }, null, 60000);
  if (exported.head !== '%PDF-') throw new Error(`export PDF: output does not start with %PDF- (got ${JSON.stringify(exported.head)})`);
  if (exported.pageCount !== 1) throw new Error(`export PDF: expected a 1-page PDF, got page count ${exported.pageCount}`);
  console.log(`export PDF: ${exported.size} bytes, ${exported.pageCount} page`);
  console.log(`smoke test passed (${browserName})`);
} catch (err) {
  failed = true;
  console.error(`smoke test FAILED (${browserName}): ${err instanceof Error ? err.message : err}`);
} finally {
  await browser.deleteSession().catch(() => {});
  server.close();
}
process.exit(failed ? 1 : 0);
