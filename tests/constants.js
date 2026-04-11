export const port = 3031;
export const portKarma = 9876;
export const BASE_URL_KARMA = `http://localhost:${portKarma}/base`;

let basepath;
if (typeof process !== 'undefined') {
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  basepath = `${__dirname}/..`;
} else {
  // Derive the base URL from the current page location so tests work
  // even when Karma binds to a non-default port (e.g. port conflict).
  basepath = `${window.location.origin}/base`;
}

export const BASE_PATH_KARMA = basepath;
export const ASSETS_PATH_KARMA = `${BASE_PATH_KARMA}/tests/test-assets`;
