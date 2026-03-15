/* eslint-disable import/no-relative-packages */
import { assert, config } from '../../node_modules/chai/chai.js';
import scribe from '../../scribe.js';
import { ImageCache } from '../../js/containers/imageContainer.js';
import { ASSETS_PATH_KARMA } from '../constants.js';

config.truncateThreshold = 0;

/* eslint-disable prefer-arrow-callback */
/* eslint-disable func-names */

/**
 * Helper: open a PDF buffer in muPDF, count annotations on a given page, then free the document.
 * @param {Object} w - muPDF async worker
 * @param {ArrayBuffer} pdfBuffer - PDF data
 * @param {number} page - 1-based page number
 * @returns {Promise<Array>} annotations array
 */
async function getAnnotationsForPage(w, pdfBuffer, page) {
  const doc = await w.openDocument(pdfBuffer, 'document.pdf');
  w.pdfDoc = doc;
  const annots = await w.pageAnnotations({ page, dpi: 72 });
  w.freeDocument(doc);
  return annots;
}

describe('Check PDF merge preserves annotations.', function () {
  this.timeout(120000);

  it('Merged PDF retains highlight annotations from both source documents', async () => {
    const docCount = 5;
    const colors = ['#ffff00', '#ff0000', '#00ff00', '#0000ff', '#ff00ff'];
    const pdfBuffers = [];

    for (let d = 0; d < docCount; d++) {
      scribe.opt.usePDFText.ocr.main = true;
      await scribe.importFiles([`${ASSETS_PATH_KARMA}/scribe_test_pdf1.pdf`]);

      const firstWord = scribe.data.ocr.active[0].lines[0].words[0];
      scribe.data.annotations.pages[0].push({
        bbox: {
          left: firstWord.bbox.left,
          top: firstWord.bbox.top,
          right: firstWord.bbox.right,
          bottom: firstWord.bbox.bottom,
        },
        color: colors[d],
        opacity: 0.35,
        groupId: `doc${d}-highlight`,
      });

      scribe.opt.displayMode = 'annot';
      pdfBuffers.push(await scribe.exportData('pdf'));
      await scribe.clear();
    }

    const muPDFScheduler = await ImageCache.getMuPDFScheduler(1);
    const w = muPDFScheduler.workers[0];

    for (let d = 0; d < docCount; d++) {
      const annots = await getAnnotationsForPage(w, new Uint8Array(pdfBuffers[d]).slice().buffer, 1);
      assert.isTrue(annots.length > 0, `Source PDF ${d} should have annotations before merge`);
    }
    const dst = await w.openDocument(pdfBuffers[0], 'document.pdf');
    w.pdfDoc = dst;

    for (let i = 1; i < docCount; i++) {
      const src = await w.openDocument(new Uint8Array(pdfBuffers[i]).slice().buffer, 'document.pdf');
      await w.mergeFrom(dst, src, {});
      w.freeDocument(src);
    }

    const mergedData = await w.save({ doc1: dst });
    const totalPages = await w.countPages();
    w.freeDocument(dst);

    const expectedPages = 2 * docCount;
    assert.strictEqual(totalPages, expectedPages, `Merged PDF should have ${expectedPages} pages`);

    const mergedBytes = new Uint8Array(mergedData instanceof ArrayBuffer ? mergedData : mergedData.buffer || mergedData);

    for (let d = 0; d < docCount; d++) {
      const annotPage = d * 2 + 1;
      const annots = await getAnnotationsForPage(w, mergedBytes.slice().buffer, annotPage);
      assert.isTrue(annots.length > 0,
        `Page ${annotPage} of merged PDF should have annotations from source ${d}`);
    }

    scribe.opt.displayMode = 'proof';
    scribe.opt.usePDFText.ocr.main = false;
  }).timeout(120000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);
