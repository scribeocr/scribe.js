import {
  describe, test, expect, afterAll, vi,
} from 'vitest';
import scribe from '../../scribe.js';
import { poolStats } from '../../js/pdfWorkerPool.js';
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
    expect(txt.length, 'a document opened after a worker crash extracts full text on the healed pool').toBe(3375);
    await doc2.close();
  }, 30000);

  // A viewer opens with deferred text so its first screen paints first; `textStart` is how it keeps the parse pump off the pool until that screen has asked.
  test('deferred extraction waits for textStart and then delivers the full text', async () => {
    let startText = () => {};
    const textStart = new Promise((resolve) => { startText = resolve; });
    const doc = await scribe.openDocument([`${ASSETS_PATH}/TSLA-Q4-2020-Update.pdf`], { deferText: true, textStart });
    const sched = await doc.images.getPdfScheduler();
    expect(sched.busy, 'no parse job reaches the pool while textStart is pending').toBe(false);
    expect(doc.inputData.pdfType, 'the document type is undecided until extraction runs').toBe(null);
    startText();
    await doc.textReady;
    const txt = await doc.exportData('text');
    expect(txt.length, 'the deferred text lands in full once textStart resolves').toBe(33389);
    await doc.close();
  }, 30000);

  // A tab closed while its text is still extracting tears the pool down under the parse pump; the extraction must stop quietly, not compute on the skipped results.
  test('closing a document during its deferred extraction settles textReady without an error', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const doc = await scribe.openDocument([`${ASSETS_PATH}/TSLA-Q4-2020-Update.pdf`], { deferText: true, pdfWorkerN: 1 });
      // The first screen's render puts the parse pump mid-flight on the one worker, where a tab close finds it.
      await doc.images.renderViewerRaster(0, 900, 'display');
      await doc.close();
      await expect(doc.textReady, 'textReady settles for a document closed mid-extraction').resolves.toBe(null);
      // The pump's last jobs settle after the close; give them a turn.
      await new Promise((resolve) => { setTimeout(resolve, 100); });
      const logged = errors.mock.calls.filter((c) => String(c[0]).includes('Deferred PDF text extraction failed'));
      expect(logged, 'a close during extraction logs no extraction error').toEqual([]);
    } finally {
      errors.mockRestore();
    }
  }, 30000);

  // The viewer grows the document on screen to several workers and shrinks it back when the reader leaves; the pool must hand the leaving workers to the next document.
  test('a lease grows and shrinks in place, and a growing document reuses the workers a shrinking one gives up', async () => {
    const a = await scribe.openDocument([`${ASSETS_PATH}/TSLA-Q4-2020-Update.pdf`], { pdfWorkerN: 1 });
    const b = await scribe.openDocument([`${ASSETS_PATH}/academic_article_1.pdf`], { pdfWorkerN: 1 });
    const before = poolStats();
    await a.images.setWorkerTarget(3);
    const schedA = await a.images.getPdfScheduler();
    expect(schedA.workers.length, 'growing a lease adds workers to the live scheduler without a reload').toBe(3);
    const grown = poolStats();
    expect(grown.leased - before.leased, 'growing by two leases two more workers').toBe(2);
    // Three renders in flight on A's three workers, then A shrinks while they run and B grows at once.
    const renders = [1, 2, 3].map((i) => schedA.renderPdfPage({
      pageIndex: i, colorMode: 'color', targetWidth: 1500, outputFormat: 'png',
    }, 'background'));
    const shrink = a.images.setWorkerTarget(1);
    await b.images.setWorkerTarget(3);
    const schedB = await b.images.getPdfScheduler();
    expect(schedB.workers.length, 'the growing document gets its three workers').toBe(3);
    await Promise.all(renders);
    await shrink;
    expect(schedA.workers.length, 'the shrinking document keeps one worker once its renders settle').toBe(1);
    const after = poolStats();
    expect(after.leased + after.spare + after.retiring, 'the growing document took over the retiring workers instead of spawning beside them').toBe(grown.leased + grown.spare);
    const txt = await b.exportData('text');
    expect(txt.length, 'the grown document still reads its text through the pool').toBe(3375);
    await a.close();
    await b.close();
  }, 60000);
});
