import { defineConfig } from 'vitest/config';
import { webdriverio } from '@vitest/browser-webdriverio';

// All capabilities are passed via the webdriverio() factory rather than per
// instance. The vitest webdriverio provider doesn't currently forward
// `instances[].capabilities` — it reads only from the factory `options`. Each
// browser ignores the capability keys it doesn't recognize (firefox ignores
// goog:* and wdio:chromedriverOptions, chrome ignores moz:*).
//
// Browser/driver paths default to webdriverio auto-discovery (selenium-manager).
// Set CHROMIUM_BINARY / CHROMEDRIVER_BINARY / FIREFOX_BINARY to pin specific
// binaries in restricted-network environments (dev container, CI).
/** @type {Record<string, any>} */
const chromeOptions = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
if (process.env.CHROMIUM_BINARY) chromeOptions.binary = process.env.CHROMIUM_BINARY;

/** @type {Record<string, any>} */
const firefoxOptions = { args: ['-headless'] };
if (process.env.FIREFOX_BINARY) firefoxOptions.binary = process.env.FIREFOX_BINARY;

/** @type {Record<string, any>} */
const CAPABILITIES = {
  'goog:chromeOptions': chromeOptions,
  'moz:firefoxOptions': firefoxOptions,
};
if (process.env.CHROMEDRIVER_BINARY) {
  CAPABILITIES['wdio:chromedriverOptions'] = { binary: process.env.CHROMEDRIVER_BINARY };
}

const SHARED_VITE_OPTIONS = {
  // Vite's default fs.allow only covers the workspace; explicitly include
  // the tests/test-lang-data directory so Vite's dev server will serve the
  // local Tesseract trained data via fetch (used as a CDN replacement).
  server: {
    fs: { allow: ['.'] },
  },
  // @scribe.js/canvas is a Node-only native binding. scribe.js only imports
  // it via `await import(...)` gated on `typeof process !== 'undefined'`,
  // but Vite's dep scanner walks the import regardless and fails when it
  // tries to pre-bundle the .node file for the browser.
  optimizeDeps: {
    exclude: ['@scribe.js/canvas'],
  },
};

// Use forward slashes — on Windows, `import.meta.dirname` returns a path with
// backslashes, and tinyglobby (the matcher behind `test.include`) silently
// drops mixed-slash patterns, so every test file would be skipped.
const ROOT = import.meta.dirname.replace(/\\/g, '/');
const ALL_TESTS = `${ROOT}/tests/module/**/*.spec.js`;
const NODE_ONLY_TESTS = `${ROOT}/tests/module/**/*.node.spec.js`;
// CLI tests live outside tests/module/ — they invoke node-only CLI entry points
// (fs, process, etc.) and have no browser equivalent, so they're added to the
// node project's include only.
const CLI_TESTS = `${ROOT}/tests/cli/**/*.spec.js`;

const SHARED_TEST_OPTIONS = {
  testTimeout: 90_000,
  hookTimeout: 90_000,
};

// Build a browser project with a single instance + an explicit project name.
// Each browser is its own top-level project (rather than two instances under
// one project) so vitest exposes them as `--project=chrome` / `--project=firefox`
// without surprise prefixing.
const browserProject = (browserName) => ({
  ...SHARED_VITE_OPTIONS,
  test: {
    ...SHARED_TEST_OPTIONS,
    name: browserName,
    include: [ALL_TESTS],
    // Browser tests can't load `mcp.node.spec.js` — it imports node:url and
    // mcp/tools.js, which Vite externalises for the browser bundle.
    exclude: [NODE_ONLY_TESTS],
    browser: {
      enabled: true,
      headless: true,
      provider: webdriverio({ capabilities: CAPABILITIES }),
      instances: [{ browser: browserName }],
    },
  },
});

// Three projects share the same test files. Vitest runs each project once
// against the full set; the test files use _paths.js to switch URL vs FS
// paths at runtime. Locally we default to chrome (see package.json scripts);
// CI runs all three in a matrix.
export default defineConfig({
  ...SHARED_VITE_OPTIONS,
  test: {
    projects: [
      {
        ...SHARED_VITE_OPTIONS,
        // Cap concurrent Node files at 4. Each test file pins
        // `scribe.opt.workerN = 1`, so cross-file Tesseract worker pressure
        // stays bounded. Running all 23 in parallel saturates canvas /
        // worker_threads and causes recognize/PDF-export hangs; ~4 is the
        // tested-good ceiling matching the pre-migration karma setup.
        poolOptions: {
          threads: { maxThreads: 4, minThreads: 1 },
        },
        test: {
          ...SHARED_TEST_OPTIONS,
          name: 'node',
          environment: 'node',
          include: [ALL_TESTS, CLI_TESTS],
        },
      },
      browserProject('chrome'),
      browserProject('firefox'),
    ],
  },
});
