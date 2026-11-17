import {
  describe, test, expect, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH } from './_paths.js';

// One worker per document, so a document's second render runs on the worker that cached its fonts in the first.
scribe.opt.workerN = 1;

describe('Multi-document isolation', () => {
  afterAll(async () => {
    await scribe.terminate();
  });

  test('an open document renders the same beside a different document and after another instance of it closes', async () => {
    // On these two pages the documents' embedded fonts share an object number, so their registered names differ only by the loading thread's id.
    // A name registered twice draws with the font registered first, so only the document opened second shows a collision.
    // The pair must be the first two documents the file opens, since a pooled worker goes on counting the documents it loads and the count is part of the name.
    const article = await scribe.openDocument([`${ASSETS_PATH}/academic_article_1.pdf`]);
    await article.renderPageImage(0, { dpi: 72 });
    const report = await scribe.openDocument([`${ASSETS_PATH}/report_1.pdf`]);
    const beside = await report.renderPageImage(0, { dpi: 72 });
    expect(beside.ok, 'a page fails to render while a different document is open').toBe(true);
    await article.close();
    const alone = await report.renderPageImage(0, { dpi: 72 });
    expect(beside.dataUrl === alone.dataUrl, 'a page rendered while a different document is open differs from its render alone (cross-document font-name collision)').toBe(true);

    // Two instances of one file register identical font bytes, which share one typeface in Node's font registry.
    // @scribe.js/canvas older than 0.1.97-scribe.8 removes that typeface from under the second instance when the first closes.
    const reportAgain = await scribe.openDocument([`${ASSETS_PATH}/report_1.pdf`]);
    const before = await reportAgain.renderPageImage(0, { dpi: 72 });
    expect(before.ok, 'a page fails to render while another instance of the same document is open').toBe(true);
    await report.close();
    const after = await reportAgain.renderPageImage(0, { dpi: 72 });
    expect(after.dataUrl === before.dataUrl, 'a page render changed after another instance of the same document closed (shared font bytes removed on close)').toBe(true);
    await reportAgain.close();
  }, 30000);
});
