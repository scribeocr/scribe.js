import { inputData, opt } from '../containers/app.js';
import {
  annotations, layoutDataTables, layoutRegions, ocrAll, pageMetricsAll,
} from '../containers/dataContainer.js';
import { ImageCache } from '../containers/imageContainer.js';
import { reorderOcrPage } from '../modifyOCR.js';
import { saveAs } from '../utils/miscUtils.js';
import { writePdf } from './pdf/writePdf.js';
import { overlayPdfText, subsetPdf } from './pdf/writePdfOverlay.js';
import { writeHocr } from './writeHocr.js';
import { writeText } from './writeText.js';
import { writeHtml } from './writeHtml.js';
import { writeAlto } from './writeAlto.js';
import { writeMarkdown } from './writeMarkdown.js';
import { removeCircularRefsOcr } from '../objects/ocrObjects.js';
import { removeCircularRefsDataTables } from '../objects/layoutObjects.js';
import { FontCont } from '../containers/fontContainer.js';

/**
 * Export active OCR data to specified format.
 * @public
 * @param {'pdf'|'hocr'|'alto'|'docx'|'html'|'xlsx'|'txt'|'text'|'md'|'scribe'} [format='txt']
 * @param {Object} [options]
 * @param {number} [options.minPage=0] - First page to export.
 * @param {number} [options.maxPage=-1] - Last page to export (inclusive). -1 exports through the last page.
 * @param {?Array<number>} [options.pageArr=null] - Array of 0-based page indices to include. Overrides minPage/maxPage when provided.
 * @returns {Promise<string|ArrayBuffer>}
 */
export async function exportData(format = 'txt', { minPage = 0, maxPage = -1, pageArr = null } = {}) {
  if (format === 'text') format = 'txt';

  if (!pageArr) {
    if (maxPage === -1) maxPage = inputData.pageCount - 1;
    pageArr = [];
    for (let i = minPage; i <= maxPage; i++) pageArr.push(i);
  }

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
      for (const i of pageArr) {
        dimsLimit.height = Math.max(dimsLimit.height, pageMetricsAll[i].dims.height);
        dimsLimit.width = Math.max(dimsLimit.width, pageMetricsAll[i].dims.width);
      }
    }

    // For proof or ocr mode the text layer needs to be combined with a background layer
    if (opt.displayMode !== 'ebook') {
      const insertInputPDF = inputData.pdfMode && opt.addOverlay;

      const rotateBackground = !insertInputPDF && opt.autoRotate;

      const rotateText = !rotateBackground;

      let insertInputFailed = false;

      if (insertInputPDF) {
        try {
          let basePdfData = ImageCache.pdfData;
          let overlayOcrArr = ocrDownload;
          let overlayPageMetricsArr = pageMetricsAll;
          let overlayAnnotationsPages = annotations.pages;
          if (pageArr.length < inputData.pageCount) {
            basePdfData = await subsetPdf(basePdfData, pageArr);
            overlayOcrArr = pageArr.map((i) => ocrDownload[i]);
            overlayPageMetricsArr = pageArr.map((i) => pageMetricsAll[i]);
            overlayAnnotationsPages = pageArr.map((i) => annotations.pages[i] || []);
          }
          content = await overlayPdfText({
            basePdfData,
            ocrArr: overlayOcrArr,
            pageMetricsArr: overlayPageMetricsArr,
            textMode: opt.displayMode,
            rotateText,
            rotateBackground,
            confThreshHigh: opt.confThreshHigh,
            confThreshMed: opt.confThreshMed,
            proofOpacity: opt.overlayOpacity / 100,
            humanReadable: opt.humanReadablePDF,
            annotationsPages: overlayAnnotationsPages,
          });
        } catch (error) {
          console.error('Failed to overlay text onto input PDF, creating new PDF from rendered images instead.');
          console.error(error);
          insertInputFailed = true;
        }
      }

      // Build a fresh PDF (writePdf handles images natively; no mupdf convertImage* needed).
      if (!insertInputPDF || insertInputFailed) {
        const props = { rotated: rotateBackground, upscaled: false, colorMode: opt.colorMode };
        const binary = opt.colorMode === 'binary';

        // An image could be rendered if either (1) binary is selected or (2) the input data is a PDF.
        // Otherwise, the images uploaded by the user are used.
        const renderImage = binary || inputData.pdfMode;
        const includeImages = inputData.pdfMode || inputData.imageMode;

        // Pre-render to benefit from parallel processing, since the loop below is synchronous.
        if (renderImage && includeImages) await ImageCache.preRenderRange({ pageArr, binary, props });

        /** @type {ImageWrapper[]} */
        const images = [];
        if (includeImages) {
          for (const i of pageArr) {
            let image;
            if (binary) {
              image = await ImageCache.getBinary(i, props);
            } else if (inputData.pdfMode) {
              image = await ImageCache.getNative(i, props);
            } else {
              image = await ImageCache.nativeSrc[i];
            }
            images.push(image);
            opt.progressHandler({ n: i, type: 'export', info: {} });
          }
        }

        content = await writePdf({
          ocrArr: ocrDownload,
          pageMetricsArr: pageMetricsAll,
          pageArr,
          textMode: opt.displayMode,
          rotateText,
          rotateBackground,
          dimsLimit: { width: -1, height: -1 },
          confThreshHigh: opt.confThreshHigh,
          confThreshMed: opt.confThreshMed,
          proofOpacity: opt.overlayOpacity / 100,
          images,
          includeImages,
          annotationsPages: annotations.pages,
          humanReadable: opt.humanReadablePDF,
        });
      }
    } else {
      content = await writePdf({
        ocrArr: ocrDownload,
        pageMetricsArr: pageMetricsAll,
        pageArr,
        textMode: opt.displayMode,
        rotateText: false,
        rotateBackground: true,
        dimsLimit,
        confThreshHigh: opt.confThreshHigh,
        confThreshMed: opt.confThreshMed,
        proofOpacity: opt.overlayOpacity / 100,
        annotationsPages: annotations.pages,
        humanReadable: opt.humanReadablePDF,
      });
    }
  } else if (format === 'hocr') {
    content = writeHocr({ ocrData: ocrDownload, pageArr });
  } else if (format === 'alto') {
    content = writeAlto({ ocrData: ocrDownload, pageArr });
  } else if (format === 'html') {
    const images = /** @type {Array<ImageWrapper>} */ ([]);
    if (opt.includeImages) {
      const props = { rotated: opt.autoRotate, upscaled: false, colorMode: opt.colorMode };
      const binary = opt.colorMode === 'binary';

      // An image could be rendered if either (1) binary is selected or (2) the input data is a PDF.
      // Otherwise, the images uploaded by the user are used.
      const renderImage = binary || inputData.pdfMode;

      // Pre-render to benefit from parallel processing, since the loop below is synchronous.
      if (renderImage) await ImageCache.preRenderRange({ pageArr, binary, props });

      for (const i of pageArr) {
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
      ocrPages: ocrDownload, images, pageArr, reflowText: opt.reflow, removeMargins: opt.removeMargins,
    });
  } else if (format === 'txt') {
    content = writeText({
      ocrCurrent: ocrDownload,
      pageArr,
      reflowText: opt.reflow,
      lineNumbers: opt.lineNumbers,
    });
  } else if (format === 'md') {
    content = writeMarkdown({
      ocrCurrent: ocrDownload,
      layoutPageArr: layoutDataTables.pages,
      pageArr,
      reflowText: opt.reflow,
    });
  // Defining `DISABLE_DOCX_XLSX` disables docx/xlsx exports when using build tools.
  // @ts-ignore
  } else if (typeof DISABLE_DOCX_XLSX === 'undefined' && format === 'docx') {
    // Less common export formats are loaded dynamically to reduce initial load time.
    const writeDocx = (await import('./writeDocx.js')).writeDocx;
    content = await writeDocx({ hocrCurrent: ocrDownload, pageArr });
  // @ts-ignore
  } else if (typeof DISABLE_DOCX_XLSX === 'undefined' && format === 'xlsx') {
    // Less common export formats are loaded dynamically to reduce initial load time.
    const writeXlsx = (await import('./writeTabular.js')).writeXlsx;
    content = await writeXlsx({
      ocrPageArr: ocrDownload,
      layoutPageArr: layoutDataTables.pages,
      pageArr,
    });
  } else if (format === 'scribe') {
    const data = {
      ocr: removeCircularRefsOcr(ocrDownload, { includeText: opt.includeExtraTextScribe }),
      fontState: FontCont.state,
      layoutRegions: layoutRegions.pages,
      layoutDataTables: removeCircularRefsDataTables(layoutDataTables.pages),
      annotations: annotations.pages,
    };
    if (opt.compressScribe) {
      const contentStr = JSON.stringify(data);
      const cs = new CompressionStream('gzip');
      const compressedStream = new Blob([new TextEncoder().encode(contentStr)]).stream().pipeThrough(cs);
      content = await new Response(compressedStream).arrayBuffer();
    } else {
      content = JSON.stringify(data, null, 2);
    }
  }

  return content;
}

/**
 * Runs `exportData` and saves the result as a download (browser) or local file (Node.js).
 * @public
 * @param {'pdf'|'hocr'|'alto'|'docx'|'xlsx'|'txt'|'text'|'md'|'html'|'scribe'} format
 * @param {string} fileName
 * @param {Object} [options]
 * @param {number} [options.minPage=0] - First page to export.
 * @param {number} [options.maxPage=-1] - Last page to export (inclusive). -1 exports through the last page.
 * @param {?Array<number>} [options.pageArr=null] - Array of 0-based page indices to include. Overrides minPage/maxPage when provided.
 */
export async function download(format, fileName, { minPage = 0, maxPage = -1, pageArr = null } = {}) {
  if (format === 'text') format = 'txt';
  let ext;
  if (format === 'alto') {
    ext = 'xml';
  } else if (format === 'scribe' && !opt.compressScribe) {
    ext = 'scribe.json';
  } else {
    ext = format;
  }
  fileName = fileName.replace(/\.\w{1,6}$/, `.${ext}`);
  const content = await exportData(format, { minPage, maxPage, pageArr });
  await saveAs(content, fileName);
}
