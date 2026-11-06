import {
  describe, test, expect, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { writeHtmlFragment } from '../../js/export/writeHtml.js';
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

    const plainHtml = /** @type {string} */ (await doc.exportData('html', { displayMode: 'proof', reflow: false, htmlFitWindow: false }));
    expect(plainHtml, 'the default HTML export differs from the export with reflow and htmlFitWindow at their defaults').toBe(cdnHtml);
    expect(cdnHtml, 'the exported file carries paragraph ids, which only the viewer fragment carries').not.toContain('data-par=');

    const fitHtml = /** @type {string} */ (await doc.exportData('html', { displayMode: 'proof', htmlFitWindow: true }));
    const fitRule = '  body {\n    zoom:min(1, tan(atan2(calc(100vw - 20px), 640px)));\n  }\n';
    expect(fitHtml, 'htmlFitWindow adds no scale rule sized to the widest page').toContain(fitRule);
    expect(fitHtml.replace(fitRule, ''), 'htmlFitWindow changes the file beyond the scale rule').toBe(cdnHtml);

    // The viewer's Export preview renders this fragment, so the fragment's markup and style rules must be the exported file's own.
    const fragmentParams = {
      ocrPages: doc.ocr.active, docFonts: doc.fonts, pageMetrics: doc.pageMetrics, displayMode: /** @type {const} */ ('proof'),
    };
    const fragment = writeHtmlFragment(fragmentParams);
    expect(cdnHtml, "the fragment's body is not the file's body").toContain(`<body>\n${fragment.body}</body>`);
    expect(cdnHtml, "the fragment's style rules are not the file's").toContain(`<style>\n${fragment.style}  @font-face`);
    const idFragment = writeHtmlFragment({ ...fragmentParams, parIds: true });
    expect((idFragment.body.match(/ data-par="[A-Za-z0-9]{8}"/g) || []).length, 'the fragment with paragraph ids does not carry one per line').toBe(8);
    expect(idFragment.body.replace(/ data-par="[A-Za-z0-9]{8}"/g, ''), 'the paragraph ids change the fragment beyond the attribute').toBe(fragment.body);

    await doc.clear();
  });

  afterAll(async () => {
    await scribe.terminate();
  });
});
