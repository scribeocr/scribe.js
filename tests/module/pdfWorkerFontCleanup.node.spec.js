import {
  describe, test, expect, beforeAll, afterEach,
} from 'vitest';
import { readFile } from 'node:fs/promises';
import { ca } from '../../js/canvasAdapter.js';
import {
  loadPdfForParsing,
  renderPdfPage,
  unloadPdf,
} from '../../js/worker/pdfWorker.js';
import { ASSETS_PATH } from './_paths.js';

const PDF_PATH = `${ASSETS_PATH}/border_patrol_tables.pdf`;

/** @returns {Promise<Uint8Array>} */
async function readPdfBytes() {
  return new Uint8Array(await readFile(PDF_PATH));
}

/** Every _pdf_d{docId}_* family currently registered. */
function pdfAliases() {
  if (!ca._registeredFonts) return [];
  return [...ca._registeredFonts.keys()].filter((k) => k.startsWith('_pdf_d'));
}

/** Every _scribe_* substitute family currently registered. */
function scribeAliases() {
  if (!ca._registeredFonts) return [];
  return [...ca._registeredFonts.keys()].filter((k) => k.startsWith('_scribe_'));
}

describe('pdfWorker font cleanup', () => {
  beforeAll(async () => {
    await ca.getCanvasNode();
  });

  afterEach(async () => {
    await unloadPdf();
  });

  test('registers _pdf_d* font aliases during page render', async () => {
    const beforeCount = pdfAliases().length;
    const pdfBytes = await readPdfBytes();
    await loadPdfForParsing({ pdfBytes });
    await renderPdfPage({ pageIndex: 0, colorMode: 'color' });
    const newAliases = pdfAliases().length - beforeCount;
    expect(newAliases).toBe(2);
  });

  test('unloadPdf() releases every _pdf_d* alias for the current document', async () => {
    const pdfBytes = await readPdfBytes();
    await loadPdfForParsing({ pdfBytes });
    await renderPdfPage({ pageIndex: 0, colorMode: 'color' });
    expect(pdfAliases().length).toBe(2);

    await unloadPdf();

    expect(pdfAliases()).toEqual([]);
  });

  test('loading a new PDF releases the previous PDF\'s aliases', async () => {
    // Same bytes loaded twice; the fresh ObjectCache gets a new docId,
    // so the second pass's aliases use a different prefix than the
    // first. Without the load-side cleanup, the first pass's aliases
    // would stay registered indefinitely.
    const pdfBytes = await readPdfBytes();
    await loadPdfForParsing({ pdfBytes });
    await renderPdfPage({ pageIndex: 0, colorMode: 'color' });
    const firstAliases = new Set(pdfAliases());
    expect(firstAliases.size).toBe(2);

    await loadPdfForParsing({ pdfBytes });
    const afterSecondLoad = pdfAliases();
    for (const firstAlias of firstAliases) {
      expect(afterSecondLoad).not.toContain(firstAlias);
    }
  });

  test('does not drop _scribe_* substitute aliases on unload', async () => {
    // Substitute fonts (NimbusSans/NimbusRoman/Dingbats) are process-
    // global — shared across all documents — so unloadPdf() must not
    // touch them. border_patrol_tables.pdf triggers Nimbus substitution
    // for two un-parseable embedded fonts (italic + bolditalic).
    const pdfBytes = await readPdfBytes();
    await loadPdfForParsing({ pdfBytes });
    await renderPdfPage({ pageIndex: 0, colorMode: 'color' });
    const scribeDuring = scribeAliases();
    expect(scribeDuring).toContain('_scribe_nimbussans_bolditalic:italic:bold');
    expect(scribeDuring).toContain('_scribe_nimbussans_italic:italic:normal');

    await unloadPdf();

    const scribeAfter = scribeAliases();
    for (const alias of scribeDuring) {
      expect(scribeAfter).toContain(alias);
    }
  });
});
