import {
  describe, test, expect, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { ASSETS_PATH } from './_paths.js';

// The lease size is pinned so the crash-containment counts below are exact on any machine.
scribe.opt.workerN = 3;

describe('Shared PDF worker pool crash containment', () => {
  afterAll(async () => {
    await scribe.terminate();
  });

  test('a killed worker fails only its in-flight render, and the next open works on a healed pool', async () => {
    const doc = await scribe.openDocument([`${ASSETS_PATH}/TSLA-Q4-2020-Update.pdf`]);
    const sched = await doc.images.getPdfScheduler();
    const renders = Array.from({ length: 9 }, (_, i) => sched.renderPdfPage({
      pageIndex: i + 1, colorMode: 'color', targetWidth: 400, outputFormat: 'jpeg', quality: 0.6,
    }, false).then(() => 'ok', () => 'rejected'));
    sched.workers[0].terminate();
    const settled = await Promise.all(renders);
    expect(settled.filter((s) => s === 'rejected').length, 'only the killed worker\'s in-flight render is lost').toBe(1);
    expect(settled.filter((s) => s === 'ok').length, 'renders staged behind a killed worker complete on the surviving workers').toBe(8);
    await doc.close();

    // If release had returned the killed worker to the pool instead of destroying it, this open would lease it back and fail to load.
    const doc2 = await scribe.openDocument([`${ASSETS_PATH}/academic_article_1.pdf`]);
    const txt = await doc2.exportData('text');
    expect(txt.length, 'a document opened after a worker crash extracts full text on the healed pool').toBe(3391);
    await doc2.close();
  }, 30000);
});
