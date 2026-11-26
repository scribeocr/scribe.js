import { expect } from 'vitest';

/**
 * Return every page of a text layer with character boxes populated.
 * @param {import('../../js/containers/scribeDoc.js').ScribeDoc} doc
 * @param {string} [layer]
 * @returns {Array<?import('../../js/objects/ocrObjects.js').OcrPage|undefined>} Pages in index order, or `[]` when the layer is absent or no layer is active.
 */
export function docPages(doc, layer = 'active') {
  const name = layer === 'active' ? doc.activeLayer : layer;
  if (name === null || !doc.layers.includes(name)) return [];
  return Array.from({ length: doc.pageCount }, (_, n) => doc.getPage(n, { layer: name, detail: true }));
}

/**
 * Assert that `copy` and `orig` have matching own properties and back-references while sharing no objects.
 * @param {import('../../js/objects/ocrObjects.js').OcrPage} orig
 * @param {import('../../js/objects/ocrObjects.js').OcrPage} copy
 * @param {string} what - Label for the copy source in failure messages.
 * @param {?string} [skipKey] - Property name to skip at every depth.
 */
export function expectSamePage(orig, copy, what, skipKey = null) {
  const seen = new Map();
  const compare = (a, b, path) => {
    if (a === null || typeof a !== 'object') {
      if (!Object.is(a, b)) expect(b, `${what} dropped or altered ${path}`).toBe(a);
      return;
    }
    if (seen.has(a)) {
      if (b !== seen.get(a)) expect(b, `back-reference ${path} points into another graph than the copy ${what} made`).toBe(seen.get(a));
      return;
    }
    seen.set(a, b);
    if (b === a) expect(b, `${what} aliased ${path} to the original object`).not.toBe(a);
    if (b === null || typeof b !== 'object') expect(typeof b, `${what} dropped the object at ${path}`).toBe('object');
    for (const k of Object.keys(a)) {
      if (k !== skipKey) compare(a[k], b[k], `${path}.${k}`);
    }
  };
  compare(orig, copy, 'page');
}
