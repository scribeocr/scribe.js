import path from 'node:path';
import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

// Development and the test suites bypass this config and run the unbundled sources as native ES modules.
// Nothing in `js/` or `scribe-ui/` may use Vite-only syntax such as `?url` imports or `import.meta.env`.
// No module the page can reach may contain a top-level `await`.
// Rolldown initializes the whole graph asynchronously, and inside scribe-ui's import cycles an initializer ends up awaiting itself, so the app silently never starts.

const ROOT = import.meta.dirname;

// Node built-ins and the native canvas binding are reached only behind `typeof process` checks that are false in a browser.
// Stubbing them keeps expected "externalized for browser compatibility" warnings out of the build log, so a real one stays visible.
const NODE_ONLY = new Set([...builtinModules, '@scribe.js/canvas']);
const nodeOnlyStub = () => ({
  name: 'scribe:node-only-stub',
  enforce: 'pre',
  resolveId(id) {
    return NODE_ONLY.has(id.startsWith('node:') ? id.slice(5) : id) ? `\0node-only:${id}` : null;
  },
  load(id) {
    return id.startsWith('\0node-only:') ? 'export default {};' : null;
  },
});

// The OCR worker picks one of several Tesseract builds by feature detection (tess/worker-script/index.js).
// Electron's Chromium always passes the relaxed-SIMD check and the viewer never enables vanilla mode, so the desktop build stubs out the variants it can never select.
// Each is a 3 MB .wasm plus glue.
const desktopEngineTrim = () => ({
  name: 'scribe:desktop-engine-trim',
  enforce: 'pre',
  resolveId(source, importer) {
    const file = source.startsWith('.') && importer ? path.resolve(path.dirname(importer), source) : source;
    return /\/tess\/core-vanilla\/tesseract-core[^/]*\.js$/.test(file) || /\/tess\/core\/tesseract-core(-lstm|-simd|-simd-lstm)?\.js$/.test(file)
      ? `\0desktop-trimmed:${file}`
      : null;
  },
  load(id) {
    return id.startsWith('\0desktop-trimmed:')
      ? 'export default async function TesseractCore() { throw new Error(\'This OCR engine variant is not included in the desktop build.\'); }'
      : null;
  },
});

export default defineConfig(({ mode }) => ({
  root: ROOT,
  plugins: mode === 'electron' ? [nodeOnlyStub(), desktopEngineTrim()] : [nodeOnlyStub()],
  build: {
    outDir: 'dist',
    // Source maps would add 17 MB to the installer.
    sourcemap: mode !== 'electron',
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: mode === 'electron'
        ? { electron: path.resolve(ROOT, 'scribe-ui/basic-viewer/electron/electron.html') }
        : { main: path.resolve(ROOT, 'index.html') },
    },
  },
  worker: {
    format: 'es',
    // Worker builds take their plugins from here rather than `plugins`.
    // Vite needs fresh plugin instances for each worker build.
    plugins: () => (mode === 'electron' ? [nodeOnlyStub(), desktopEngineTrim()] : [nodeOnlyStub()]),
  },
}));
