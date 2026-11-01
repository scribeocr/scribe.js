import { parseCitation, resolveCitation } from './resolveCitation.js';
import ocr from './objects/ocrObjects.js';

/** @typedef {import('./objects/ocrObjects.js').OcrPage} OcrPage */
/** @typedef {import('./objects/ocrObjects.js').OcrWord} OcrWord */

/**
 * @typedef {Object} DocAddress
 * @property {string} hash - The target document's library key, the first 16 hex digits of the SHA-256 of its bytes.
 * @property {number} pageIndex - The target page, 0-based, in the document's current page order.
 * @property {?string} cite - A citation as a filing writes it, such as "54:1-20" or "¶ 12", or null.
 * @property {?string} q - A quoted passage, or null.
 * @property {?number} line - The 0-based line the quote starts on, or null.
 * @property {?string} path - The target's path under its folder when the link was made, or null.
 * @property {?string} title - The target's title when the link was made, or null.
 */

/**
 * @typedef {Object} DocAddressTarget
 * @property {number} pageIndex - The page the locator resolved on, or the address's page when nothing resolves.
 * @property {Array<OcrWord>} words - The cited words in page order.
 * It is empty for a page alone, for a citation that names a whole page, or when nothing resolves.
 * @property {'ok'|'page'|'changed'} state - `ok` when the locator resolved, `page` for an address with no locator, `changed` when the locator no longer resolves.
 */

export const DOC_ADDRESS_SCHEME = 'scribe-doc:';

/**
 * A reader's label for an address.
 * @param {DocAddress} address
 * @returns {string}
 */
export function docAddressLabel(address) {
  const docName = address.title || address.path || address.hash;
  let where;
  if (address.cite) where = address.cite;
  else if (address.q) where = `“${address.q.length > 48 ? `${address.q.slice(0, 46)}…` : address.q}”`;
  else where = `p. ${address.pageIndex + 1}`;
  return `${docName} · ${where}`;
}

/**
 * Parse a document address.
 * @param {string} uri
 * @returns {?DocAddress} Null when `uri` is not an address.
 */
export function parseDocAddress(uri) {
  if (typeof uri !== 'string') return null;
  const m = /^scribe-doc:\/\/([0-9a-f]{16})\/(\d+)(?:\?([^#]*))?$/i.exec(uri.trim());
  if (!m) return null;
  const params = new URLSearchParams(m[3] || '');
  const line = params.get('line');
  return {
    hash: m[1].toLowerCase(),
    pageIndex: Number(m[2]),
    cite: params.get('cite'),
    q: params.get('q'),
    line: line != null && /^\d+$/.test(line) ? Number(line) : null,
    path: params.get('path'),
    title: params.get('title'),
  };
}

/**
 * Write a document address.
 * A citation takes precedence over a quote when both are given.
 * @param {{ hash: string, pageIndex: number, cite?: ?string, q?: ?string, line?: ?number, path?: ?string, title?: ?string }} address
 * @returns {string}
 */
export function formatDocAddress(address) {
  const params = new URLSearchParams();
  if (address.cite) {
    params.set('cite', address.cite);
  } else if (address.q) {
    params.set('q', address.q);
    if (address.line != null) params.set('line', String(address.line));
  }
  if (address.path) params.set('path', address.path);
  if (address.title) params.set('title', address.title);
  const query = params.toString();
  return `scribe-doc://${address.hash}/${address.pageIndex}${query ? `?${query}` : ''}`;
}

/**
 * Resolve an address against a layer's pages.
 * A quote is matched as consecutive words on the address's page.
 * @param {Array<?OcrPage>} pages
 * @param {DocAddress} address
 * @returns {DocAddressTarget}
 */
export function resolveDocAddress(pages, address) {
  if (address.cite) {
    const spans = resolveCitation(pages, address.cite);
    const span = spans.find((s) => s.page === address.pageIndex) || spans[0];
    if (!span) return { pageIndex: address.pageIndex, words: [], state: 'changed' };
    if (parseCitation(address.cite)?.kind === 'page') return { pageIndex: span.page, words: [], state: 'ok' };
    return { pageIndex: span.page, words: span.lines.flatMap((l) => l.words), state: 'ok' };
  }
  if (address.q) {
    const page = pages[address.pageIndex];
    const runs = page ? ocr.getQuoteRuns(address.q, page) : [];
    const run = (address.line != null && runs.find((r) => page.lines.indexOf(r[0].line) === address.line)) || runs[0];
    if (!run) return { pageIndex: address.pageIndex, words: [], state: 'changed' };
    return { pageIndex: address.pageIndex, words: run, state: 'ok' };
  }
  return { pageIndex: address.pageIndex, words: [], state: 'page' };
}
