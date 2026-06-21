import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import scribe from '../../scribe.js';
import { PdfSchedulerInProcess } from '../../js/pdfWorkerMain.js';
import { ASSETS_PATH, LANG_PATH } from './_paths.js';

// Only coverage of the in-process path (opt.inProcess).
// PdfCore's parsing is otherwise exercised only through the worker path.

/** @type {import('../../js/containers/scribeDoc.js').ScribeDoc} */
let doc;

scribe.opt.langPath = LANG_PATH;

describe('In-process PDF text extraction (opt.inProcess).', () => {
  beforeAll(async () => {
    scribe.opt.inProcess = true;
    doc = await scribe.openDocument([`${ASSETS_PATH}/academic_article_1.pdf`]);
  });

  test('Routes to the in-process scheduler rather than a worker pool', () => {
    expect(doc.images.pdfScheduler).toBeInstanceOf(PdfSchedulerInProcess);
  });

  test('Extracts the same words as the worker path (fi ligature split)', () => {
    expect(doc.ocr.active[0].lines[46].words[8].text).toBe('firm');
    expect(doc.ocr.active[0].lines[13].words[3].text).toBe('firms;');
    expect(doc.ocr.active[0].lines[17].words[3].text).toBe('firm’s');
  });

  afterAll(async () => {
    await scribe.terminate();
    scribe.opt.inProcess = false;
  });
});
