import { inputData, opt } from '../containers/app.js';
import {
  layoutDataTables, layoutRegions, ocrAll, pageMetricsArr,
} from '../containers/dataContainer.js';
import { ImageCache } from '../containers/imageContainer.js';
import { reorderOcrPage } from '../modifyOCR.js';
import { saveAs } from '../utils/miscUtils.js';
import { writePdf } from './writePdf.js';
import { writeHocr } from './writeHocr.js';
import { writeText } from './writeText.js';
import { writeHtml } from './writeHtml.js';
import { removeCircularRefsOcr } from '../objects/ocrObjects.js';
import { removeCircularRefsDataTables } from '../objects/layoutObjects.js';
import { FontCont } from '../containers/fontContainer.js';

/**
 * Export active OCR data to specified format.
 * @public
 * @param {'pdf'|'hocr'|'docx'|'html'|'xlsx'|'txt'|'text'|'scribe'} [format='txt']
 * @param {number} [minPage=0] - First page to export.
 * @param {number} [maxPage=-1] - Last page to export (inclusive). -1 exports through the last page.
 * @returns {Promise<string|ArrayBuffer>}
 */
export async function exportData(format = 'txt', minPage = 0, maxPage = -1) {
  if (format === 'text') format = 'txt';

  if (maxPage === -1) maxPage = inputData.pageCount - 1;

  /** @type {Array<OcrPage>} */
  let ocrDownload = [];

  if (format !== 'hocr' && opt.enableLayout) {
    // Reorder HOCR elements according to layout boxes
    for (let i = 0; i < ocrAll.active.length; i++) {
      ocrDownload.push(reorderOcrPage(ocrAll.active[i], layoutRegions.pages[i]));
    }
  } else {
    ocrDownload = ocrAll.active;
  }

  /** @type {string|ArrayBuffer} */
  let content;

  if (format === 'pdf') {
    const dimsLimit = { width: -1, height: -1 };
    if (opt.standardizePageSize) {
      for (let i = minPage; i <= maxPage; i++) {
        dimsLimit.height = Math.max(dimsLimit.height, pageMetricsArr[i].dims.height);
        dimsLimit.width = Math.max(dimsLimit.width, pageMetricsArr[i].dims.width);
      }
    }

    // For proof or ocr mode the text layer needs to be combined with a background layer
    if (opt.displayMode !== 'ebook') {
      const insertInputPDF = inputData.pdfMode && opt.addOverlay;

      const rotateBackground = !insertInputPDF && opt.autoRotate;

      const rotateText = !rotateBackground;

      // Page sizes should not be standardized at this step, as the overlayText/overlayTextImage functions will perform this,
      // and assume that the overlay PDF is the same size as the input images.
      const pdfStr = await writePdf(ocrDownload, minPage, maxPage, opt.displayMode, rotateText, rotateBackground,
        { width: -1, height: -1 }, opt.confThreshHigh, opt.confThreshMed, opt.overlayOpacity / 100);

      const enc = new TextEncoder();
      const pdfEnc = enc.encode(pdfStr);

      if (opt.intermediatePDF) return pdfEnc;

      // Create a new scheduler if one does not yet exist.
      // This would be the case for image uploads.
      const muPDFScheduler = await ImageCache.getMuPDFScheduler(1);
      const w = muPDFScheduler.workers[0];
      const pdfOverlay = await w.openDocument(pdfEnc.buffer, 'document.pdf');

      let insertInputFailed = false;

      // If the input document is a .pdf and "Add Text to Import PDF" option is enabled, we insert the text into that pdf (rather than making a new one from scratch)
      if (insertInputPDF) {
        // TODO: Figure out how to handle duplicative text--where the same text is in the source document and the OCR overlay.
        // An earlier version handled this by deleting the text in the source document,
        // however this resulted in results that were not as expected by the user (a visual element disappeared).
        try {
          // The `save` function modifies the original PDF, so we need a new PDF object to avoid modifying the original.
          const basePdfDataCopy = structuredClone(ImageCache.pdfData);
          const basePdf = await w.openDocument(basePdfDataCopy, 'document.pdf');
          // Make a new PDF with invisible text removed to avoid duplication.
          // Making a new PDF object is also required as the `overlayDocuments` function modifies the input PDF in place.
          const basePdfNoInvisData = await w.save({
            doc1: basePdf, minpage: minPage, maxpage: maxPage, pagewidth: dimsLimit.width, pageheight: dimsLimit.height, humanReadable: opt.humanReadablePDF, skipTextInvis: true,
          });
          const basePdfNoInvis = await w.openDocument(basePdfNoInvisData, 'document.pdf');
          if (minPage > 0 || maxPage < inputData.pageCount - 1) {
            await w.subsetPages(basePdfNoInvis, minPage, maxPage);
          }
          await w.overlayDocuments(basePdfNoInvis, pdfOverlay);
          content = await w.save({
            doc1: basePdfNoInvis, minpage: minPage, maxpage: maxPage, pagewidth: dimsLimit.width, pageheight: dimsLimit.height, humanReadable: opt.humanReadablePDF,
          });
          w.freeDocument(basePdf);
          w.freeDocument(basePdfNoInvis);
        } catch (error) {
          console.error('Failed to insert contents into input PDF, creating new PDF from rendered images instead.');
          console.error(error);
          insertInputFailed = true;
        }
      }

      // If the input is a series of images, those images need to be inserted into a new pdf
      if (!insertInputPDF && (inputData.pdfMode || inputData.imageMode) || insertInputFailed) {
        const props = { rotated: rotateBackground, upscaled: false, colorMode: opt.colorMode };
        const binary = opt.colorMode === 'binary';

        // An image could be rendered if either (1) binary is selected or (2) the input data is a PDF.
        // Otherwise, the images uploaded by the user are used.
        const renderImage = binary || inputData.pdfMode;

        // Pre-render to benefit from parallel processing, since the loop below is synchronous.
        if (renderImage) await ImageCache.preRenderRange(minPage, maxPage, binary, props);

        await w.convertImageStart({ humanReadable: opt.humanReadablePDF });
        for (let i = minPage; i < maxPage + 1; i++) {
          /** @type {import('../containers/imageContainer.js').ImageWrapper} */
          let image;
          if (binary) {
            image = await ImageCache.getBinary(i, props);
          } else if (inputData.pdfMode) {
            image = await ImageCache.getNative(i, props);
          } else {
            image = await ImageCache.nativeSrc[i];
          }

          // Angle the PDF viewer is instructed to rotated the image by.
          // This method is currently only used when rotation is needed but the user's (unrotated) source images are being used.
          // If the images are being rendered, then rotation is expected to be applied within the rendering process.
          const angleImagePdf = rotateBackground && !renderImage ? (pageMetricsArr[i].angle || 0) * -1 : 0;

          await w.convertImageAddPage({
            image: image.src, i, pagewidth: dimsLimit.width, pageheight: dimsLimit.height, angle: angleImagePdf,
          });
          opt.progressHandler({ n: i, type: 'export', info: {} });
        }
        const contentImage = await w.convertImageEnd();
        const pdfBase = await w.openDocument(contentImage, 'document.pdf');
        await w.overlayDocuments(pdfBase, pdfOverlay);
        content = await w.save({
          doc1: pdfBase, minpage: minPage, maxpage: maxPage, pagewidth: dimsLimit.width, pageheight: dimsLimit.height, humanReadable: opt.humanReadablePDF,
        });
        w.freeDocument(pdfBase);
        // Otherwise, there is only OCR data and not image data.
      } else if (!insertInputPDF) {
        content = await w.save({
          doc1: pdfOverlay, minpage: minPage, maxpage: maxPage, pagewidth: dimsLimit.width, pageheight: dimsLimit.height, humanReadable: opt.humanReadablePDF,
        });
      }

      w.freeDocument(pdfOverlay);
    } else {
      const pdfStr = await writePdf(ocrDownload, minPage, maxPage, opt.displayMode, false, true, dimsLimit, opt.confThreshHigh, opt.confThreshMed,
        opt.overlayOpacity / 100);

      // The PDF is still run through muPDF, even thought in eBook mode no background layer is added.
      // This is because muPDF cleans up the PDF we made in the previous step, including:
      // (1) Removing fonts that are not used (significantly reduces file size)
      // (2) Compresses PDF (significantly reduces file size)
      // (3) Fixes minor errors
      //      Being slightly outside of the PDF specification often does not impact readability,
      //      however certain picky programs (e.g. Adobe Acrobat) will throw warning messages.
      const enc = new TextEncoder();
      const pdfEnc = enc.encode(pdfStr);

      // Skip mupdf processing if the intermediate PDF is requested. Debugging purposes only.
      if (opt.intermediatePDF) return pdfEnc;

      const muPDFScheduler = await ImageCache.getMuPDFScheduler(1);
      const w = muPDFScheduler.workers[0];

      // The file name is only used to detect the ".pdf" extension
      const pdf = await w.openDocument(pdfEnc.buffer, 'document.pdf');

      content = await w.save({
        doc1: pdf, minpage: minPage, maxpage: maxPage, pagewidth: dimsLimit.width, pageheight: dimsLimit.height, humanReadable: opt.humanReadablePDF,
      });

      w.freeDocument(pdf);
    }
  } else if (format === 'hocr') {
    content = writeHocr(ocrDownload, minPage, maxPage);
  } else if (format === 'html') {
    const images = /** @type {Array<ImageWrapper>} */ ([]);
    if (opt.includeImages) {
      const props = { rotated: opt.autoRotate, upscaled: false, colorMode: opt.colorMode };
      const binary = opt.colorMode === 'binary';

      // An image could be rendered if either (1) binary is selected or (2) the input data is a PDF.
      // Otherwise, the images uploaded by the user are used.
      const renderImage = binary || inputData.pdfMode;

      // Pre-render to benefit from parallel processing, since the loop below is synchronous.
      if (renderImage) await ImageCache.preRenderRange(minPage, maxPage, binary, props);

      for (let i = minPage; i < maxPage + 1; i++) {
        /** @type {ImageWrapper} */
        let image;
        if (binary) {
          image = await ImageCache.getBinary(i, props);
        } else if (inputData.pdfMode) {
          image = await ImageCache.getNative(i, props);
        } else {
          image = await ImageCache.nativeSrc[i];
        }
        images.push(image);
      }
    }

    content = writeHtml({
      ocrPages: ocrDownload, images, minpage: minPage, maxpage: maxPage, reflowText: opt.reflow, removeMargins: opt.removeMargins,
    });
  } else if (format === 'txt') {
    content = writeText(ocrDownload, minPage, maxPage, opt.reflow, false);
  // Defining `DISABLE_DOCX_XLSX` disables docx/xlsx exports when using build tools.
  // @ts-ignore
  } else if (typeof DISABLE_DOCX_XLSX === 'undefined' && format === 'docx') {
    // Less common export formats are loaded dynamically to reduce initial load time.
    const writeDocx = (await import('./writeDocx.js')).writeDocx;
    content = await writeDocx(ocrDownload, minPage, maxPage);
  // @ts-ignore
  } else if (typeof DISABLE_DOCX_XLSX === 'undefined' && format === 'xlsx') {
    // Less common export formats are loaded dynamically to reduce initial load time.
    const writeXlsx = (await import('./writeTabular.js')).writeXlsx;
    content = await writeXlsx(ocrDownload, layoutDataTables.pages, minPage, maxPage);
  } else if (format === 'scribe') {
    const data = {
      ocr: removeCircularRefsOcr(ocrDownload),
      fontState: FontCont.state,
      layoutRegions: layoutRegions.pages,
      layoutDataTables: removeCircularRefsDataTables(layoutDataTables.pages),
    };
    const contentStr = JSON.stringify(data);

    const pako = await import('../../lib/pako.esm.mjs');
    const enc = new TextEncoder();
    content = pako.gzip(enc.encode(contentStr))?.buffer;
  }

  return content;
}

/**
 * Runs `exportData` and saves the result as a download (browser) or local file (Node.js).
 * @public
 * @param {'pdf'|'hocr'|'docx'|'xlsx'|'txt'|'text'|'html'|'scribe'} format
 * @param {string} fileName
 * @param {number} [minPage=0] - First page to export.
 * @param {number} [maxPage=-1] - Last page to export (inclusive). -1 exports through the last page.
 */
export async function download(format, fileName, minPage = 0, maxPage = -1) {
  if (format === 'text') format = 'txt';
  fileName = fileName.replace(/\.\w{1,6}$/, `.${format}`);
  const content = await exportData(format, minPage, maxPage);
  await saveAs(content, fileName);
}
