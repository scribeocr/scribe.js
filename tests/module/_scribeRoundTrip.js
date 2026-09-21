// Shared by the two save-and-restore contract specs, one for the standard file and one for the session file.
import scribe from '../../scribe.js';

/** The two file layouts a contract spec saves in, with the export options that select each. */
export const LAYOUTS = [
  ['single', { compressScribe: false }],
  ['segmented', { compressScribe: true, scribeSegments: true, scribeSegmentThreshold: 1 }],
];

/**
 * Collect every value that differs between two parsed `.scribe` files.
 * @param {any} a
 * @param {any} b
 * @param {string} path
 * @param {Array<string>} out
 */
export function diffValues(a, b, path, out) {
  if (a === b) return;
  const typeA = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
  const typeB = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
  if (typeA !== typeB || (typeA !== 'object' && typeA !== 'array')) {
    const shown = [a, b].map((v) => (v === undefined ? 'absent' : JSON.stringify(v).slice(0, 60)));
    out.push(`${path}: ${shown[0]} -> ${shown[1]}`);
    return;
  }
  const keys = typeA === 'array' ? [...Array(Math.max(a.length, b.length)).keys()] : [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const k of keys) diffValues(a[k], b[k], typeA === 'array' ? `${path}[${k}]` : `${path}.${k}`, out);
}

/**
 * The text of a `.scribe` export.
 * @param {string|ArrayBuffer} raw
 * @returns {Promise<string>}
 */
export async function scribeText(raw) {
  if (typeof raw === 'string') return raw;
  return new TextDecoder().decode(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

/**
 * Save the document, restore the file, save again, and flag any values that were modified.
 * @param {import('../../js/containers/scribeDoc.js').ScribeDoc} doc
 * @param {object} options - Export options, applied to both saves.
 * @param {?object} source - The `pdfFiles` or `imageFiles` to restore alongside `doc`, or null to restore the file alone.
 * @returns {Promise<{firstText: string, changed: Array<string>}>} The first file's text and the differences (up to 20).
 */
export async function saveRestoreSave(doc, options, source) {
  const first = await doc.exportData('scribe', options);
  const firstText = await scribeText(first);
  const scribeFile = typeof first === 'string' ? new TextEncoder().encode(first).buffer : first;
  const restored = await scribe.openDocument({ scribeFiles: [scribeFile], ...(source || {}) });
  const secondText = await scribeText(await restored.exportData('scribe', options));
  await restored.close();
  /** @type {Array<string>} */
  const out = [];
  if (firstText.startsWith('{"scribeSegments"')) {
    const firstLines = firstText.split('\n').filter(Boolean);
    const secondLines = secondText.split('\n').filter(Boolean);
    for (let i = 0; i < Math.max(firstLines.length, secondLines.length); i++) {
      diffValues(firstLines[i] ? JSON.parse(firstLines[i]) : undefined, secondLines[i] ? JSON.parse(secondLines[i]) : undefined, i === 0 ? 'header' : `page ${i - 1}`, out);
    }
  } else {
    diffValues(JSON.parse(firstText), JSON.parse(secondText), 'file', out);
  }
  return { firstText, changed: out.length > 20 ? [...out.slice(0, 20), `and ${out.length - 20} more`] : out };
}

/**
 * The stores of `obj` that hold nothing, so their round trip passes without being tested.
 * @param {Record<string, any>} obj
 * @param {string} [prefix] - Prepended to each name.
 * @returns {Array<string>}
 */
export function emptyStores(obj, prefix = '') {
  /** @param {any} v @returns {boolean} */
  const empty = (v) => v === null || v === undefined
    || (Array.isArray(v) ? v.every((x) => x === 0 || empty(x)) : (typeof v === 'object' && Object.values(v).every((x) => empty(x))));
  return Object.entries(obj).filter(([, v]) => empty(v)).map(([k]) => `${prefix}${k}`);
}
