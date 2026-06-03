import {
  describe, test, expect, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

scribe.opt.workerN = 1;
scribe.opt.langPath = LANG_PATH;

// Using arrow functions breaks references to `this`.

describe('Check export for .html files.', () => {
  test('HTML export references the CDN by default and embeds fonts only with embedFonts', async () => {
    const doc = await scribe.openDocument([`${ASSETS_PATH}/testocr.png`, `${ASSETS_PATH}/testocr.abbyy.xml`]);

    // Default: reference the jsDelivr CDN, with no inline font bytes.
    const cdnHtml = /** @type {string} */ (await doc.exportData('html', { displayMode: 'proof' }));
    const cdnFaceCount = (cdnHtml.match(/@font-face/g) || []).length;
    expect(cdnFaceCount).toBe(1);
    expect(cdnHtml).toContain("src: url('https://cdn.jsdelivr.net/npm/scribe.js-ocr@0.8.0/fonts/all/NimbusSans-Regular.woff')");
    expect(cdnHtml).not.toContain('data:font/');

    // Opt-in: a self-contained file that opens offline / from `file://` with no remote URL.
    const embeddedHtml = /** @type {string} */ (await doc.exportData('html', { displayMode: 'proof', embedFonts: true }));
    expect(embeddedHtml).not.toContain('cdn.jsdelivr.net');
    expect(embeddedHtml).not.toContain("src: url('http");
    const embeddedFaceCount = (embeddedHtml.match(/@font-face/g) || []).length;
    expect(embeddedFaceCount).toBe(1);
    const dataFontCount = (embeddedHtml.match(/src: url\('data:font\//g) || []).length;
    expect(dataFontCount).toBe(1);
    // This document's single face is the built-in NimbusSans woff.
    expect(embeddedHtml).toContain("src: url('data:font/woff;base64,");

    await doc.clear();
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
