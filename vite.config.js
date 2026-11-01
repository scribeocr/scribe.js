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

const resolveSource = (source, importer) => (source.startsWith('.') && importer ? path.resolve(path.dirname(importer), source) : source);

// The OCR worker picks one of several Tesseract builds by feature detection (tess/worker-script/index.js).
// Electron's Chromium always passes the relaxed-SIMD check and the viewer never enables vanilla mode, so the desktop build stubs out the variants it can never select.
// Each is a 3 MB .wasm plus glue.
const desktopEngineTrim = () => ({
  name: 'scribe:desktop-engine-trim',
  enforce: 'pre',
  resolveId(source, importer) {
    const file = resolveSource(source, importer);
    return /\/tess\/core-vanilla\/tesseract-core[^/]*\.js$/.test(file) || /\/tess\/core\/tesseract-core-simd\.js$/.test(file)
      ? `\0desktop-trimmed:${file}`
      : null;
  },
  load(id) {
    return id.startsWith('\0desktop-trimmed:')
      ? 'export default async function TesseractCore() { throw new Error(\'This OCR engine variant is not included in the desktop build.\'); }'
      : null;
  },
});

const recognitionTrim = () => ({
  name: 'scribe:recognition-trim',
  enforce: 'pre',
  resolveId(source, importer) {
    const file = resolveSource(source, importer);
    return /\/tess\/core(?:-vanilla)?\/tesseract-core[^/]*\.js$/.test(file) || /\/tess\/worker-script\/index\.js$/.test(file)
      ? `\0recognition-trimmed:${file}`
      : null;
  },
  load(id) {
    if (!id.startsWith('\0recognition-trimmed:')) return null;
    return id.endsWith('/worker-script/index.js')
      ? 'throw new Error(\'Recognition is not included in this build.\');'
      : 'export default async function TesseractCore() { throw new Error(\'Recognition is not included in this build.\'); }';
  },
  // This keeps dead files out of the output: the debug menu's sample PDF, and the raw worker sources that the Node branch of each spawn site names.
  transform(code, id) {
    if (id.endsWith('/scribe-ui/js/controls/debugMenu.js')) {
      return code.replace("new URL('../../../tests/test-assets/ashcroft-v-iqbal.pdf', import.meta.url)", "'about:blank'");
    }
    if (/\/(?:pdfWorkerPool|generalWorkerMain|bitmapWorkerMain|extractTextDir|TessWorker)\.js$/.test(id)) {
      return code.replace(/new WorkerNode\(new URL\((['"][^'"]+['"]),\s*import\.meta\.url\)/g, 'new WorkerNode($1');
    }
    return null;
  },
});

// In a VS Code webview a worker can load nothing by address, so each worker script must carry everything it reads.
const workerEmbedFonts = () => ({
  name: 'scribe:worker-embed-fonts',
  generateBundle(_options, bundle) {
    for (const asset of Object.values(bundle)) {
      if (asset.type !== 'asset' || !/\.(woff2?|ttf|otf)$/.test(asset.fileName)) continue;
      const name = path.basename(asset.fileName);
      const dataUrl = `data:font/${path.extname(name).slice(1)};base64,${Buffer.from(asset.source).toString('base64')}`;
      const re = new RegExp(`new URL\\((["'\`])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1,\\s*import\\.meta\\.url\\)`, 'g');
      let used = false;
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || !re.test(chunk.code)) continue;
        chunk.code = chunk.code.replace(re, () => `new URL(\`${dataUrl}\`)`);
        used = true;
      }
      if (used) delete bundle[asset.fileName];
    }
  },
});

// The VS Code extension writes its page itself and loads the entry script by this path in the build.
const DESKTOP_INPUTS = {
  electron: 'scribe-ui/basic-viewer/electron/electron.html',
  vscode: 'scribe-ui/basic-viewer/vscode/vscode-entry.js',
};

export default defineConfig(({ mode }) => {
  const desktop = Object.hasOwn(DESKTOP_INPUTS, mode);
  const plugins = mode === 'vscode' ? [nodeOnlyStub(), recognitionTrim()] : desktop ? [nodeOnlyStub(), desktopEngineTrim()] : [nodeOnlyStub()];
  return {
    root: ROOT,
    base: mode === 'vscode' ? './' : '/',
    // public/ holds the site's favicons, PWA manifest and Cloudflare headers, none of which a desktop package reads.
    publicDir: desktop ? false : 'public',
    plugins,
    build: {
      // The extension's build goes straight into the directory its build script packages and its extension.js serves under F5.
      outDir: mode === 'vscode' ? 'scribe-ui/basic-viewer/vscode/staging' : 'dist',
      emptyOutDir: true,
      // Source maps would add 17 MB to the installer.
      sourcemap: !desktop,
      assetsInlineLimit: 0,
      rolldownOptions: {
        input: desktop ? { [mode]: path.resolve(ROOT, DESKTOP_INPUTS[mode]) } : { main: path.resolve(ROOT, 'index.html') },
        ...(mode === 'vscode' ? { output: { entryFileNames: DESKTOP_INPUTS.vscode } } : {}),
      },
    },
    worker: {
      format: 'es',
      // Worker builds take their plugins from here rather than `plugins`.
      // Vite needs fresh plugin instances for each worker build.
      plugins: () => (mode === 'vscode' ? [nodeOnlyStub(), recognitionTrim(), workerEmbedFonts()] : desktop ? [nodeOnlyStub(), desktopEngineTrim()] : [nodeOnlyStub()]),
      // A webview worker cannot load a chunk, so the extension's workers carry their dynamic imports inline.
      ...(mode === 'vscode' ? { rolldownOptions: { output: { codeSplitting: false } } } : {}),
    },
  };
});
