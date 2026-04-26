// Resolves the test-asset and Tesseract trained-data paths for whichever
// environment the test is running in. In the browser, scribe.importFiles
// fetches URLs relative to the dev-server origin; in Node, scribe's
// wrapFilesNode uses fs.readFileSync against absolute filesystem paths.
const isNode = typeof window === 'undefined';

let ASSETS_PATH;
let LANG_PATH;

if (isNode) {
  // Use fileURLToPath so the result is a clean OS-native filesystem path
  // (avoids the leading-slash quirk of `new URL(...).pathname` on Windows).
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  ASSETS_PATH = path.resolve(dirname, '../test-assets');
  LANG_PATH = path.resolve(dirname, '../test-lang-data');
} else {
  ASSETS_PATH = '/tests/test-assets';
  LANG_PATH = '/tests/test-lang-data';
}

export { ASSETS_PATH, LANG_PATH };
