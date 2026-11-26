import {
  describe, test, expect, beforeAll, afterAll,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
    expect(doc.getPage(0).lines[46].words[8].text).toBe('firm');
    expect(doc.getPage(0).lines[13].words[3].text).toBe('firms;');
    expect(doc.getPage(0).lines[17].words[3].text).toBe('firm’s');
  });

  test('Saves each download under the name it was given, holding what exportData returns', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-download-'));
    try {
      await doc.download('scribe', path.join(dir, 'academic.scribe.json'), { compressScribe: false });
      expect(fs.existsSync(path.join(dir, 'academic.scribe.json')), 'an uncompressed .scribe download is saved under the name it was given').toBe(true);
      expect(fs.readFileSync(path.join(dir, 'academic.scribe.json'), 'utf8'), 'the saved .scribe.json holds what exportData returns')
        .toBe(await doc.exportData('scribe', { compressScribe: false }));

      await doc.download('txt', path.join(dir, 'academic.txt'));
      expect(fs.readFileSync(path.join(dir, 'academic.txt'), 'utf8'), 'the saved text holds what exportData returns').toBe(await doc.exportData('txt'));

      fs.writeFileSync(path.join(dir, 'kept.txt'), 'previous');
      await expect(doc.download('txt', path.join(dir, 'kept.txt'), { layer: 'no such layer' }), 'a download of a layer the document lacks is refused')
        .rejects.toThrow('No OCR layer named "no such layer" on this document.');
      expect([fs.readFileSync(path.join(dir, 'kept.txt'), 'utf8'), fs.readdirSync(dir).sort()],
        'a download that fails keeps the file that was there and leaves no partial file')
        .toStrictEqual(['previous', ['academic.scribe.json', 'academic.txt', 'kept.txt']]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await scribe.terminate();
    scribe.opt.inProcess = false;
  });
});
