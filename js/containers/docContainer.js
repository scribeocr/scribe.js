import { LayoutDataTables, LayoutRegions } from './layoutContainer.js';
import { checkMultiFontMode, FontCont } from './fontContainer.js';
import { ImageCache } from './imageContainer.js';
import { recognize } from '../recognizeConvert.js';
import { gs } from '../generalWorkerMain.js';
import { exportData } from '../export/export.js';
import { replaceObjectProperties } from '../utils/miscUtils.js';

export class InputData {
  constructor() {
    /** `true` if OCR data exists (whether from upload or built-in engine) */
    this.xmlMode = [];

    /** `true` if user uploaded pdf */
    this.pdfMode = false;

    /** `true` if user uploaded image files (.png, .jpeg) */
    this.imageMode = false;

    /** `true` if user re-uploaded HOCR data created by Scribe OCR */
    this.resumeMode = false;

    /** `true` if ground truth data is uploaded */
    this.evalMode = false;

    this.inputFileNames = [];

    this.defaultDownloadFileName = '';

    this.pageCount = 0;

    this.clear = () => {
      this.xmlMode.length = 0;
      this.pdfMode = false;
      this.imageMode = false;
      this.resumeMode = false;
      this.evalMode = false;
      this.inputFileNames = [];
      this.defaultDownloadFileName = '';
      this.pageCount = 0;
    };
  }
}

export class ScribeDoc {
  constructor() {
    this.inputData = new InputData();

    this.images = new ImageCache(this);

    this.layoutRegions = new LayoutRegions();

    this.layoutDataTables = new LayoutDataTables();

    /** @type {Object.<string, FontMetricsFamily>} */
    this.fontMetricsObj = {};

    this.font = new FontCont();

    /** @type {Object<string, Array<import('../objects/ocrObjects.js').OcrPage>>} */
    this.ocrAll = { active: [] };

    /** @type {Object<string, Array<string>>} */
    this.ocrAllRaw = { active: [] };

    /** @type {Array<PageMetrics>} */
    this.pageMetricsArr = [];

    /** @type {Array<Awaited<ReturnType<typeof import('../../scrollview-web/scrollview/ScrollView.js').ScrollView.prototype.getAll>>>} */
    this.visInstructions = [];

    /** @type {Array<Object<string, string>>} */
    this.convertPageWarn = [];

    /**
     * Recognize all pages in active document.
     * Files for recognition should already be imported using `importFiles` before calling this function.
     * The results of recognition can be exported by calling `exportFiles` after this function.
     * @param {Object} options
     * @param {'speed'|'quality'} [options.mode='quality'] - Recognition mode.
     * @param {Array<string>} [options.langs=['eng']] - Language(s) in document.
     * @param {'lstm'|'legacy'|'combined'} [options.modeAdv='combined'] - Alternative method of setting recognition mode.
     * @param {'conf'|'data'|'none'} [options.combineMode='data'] - Method of combining OCR results. Used if OCR data already exists.
     * @param {boolean} [options.vanillaMode=false] - Whether to use the vanilla Tesseract.js model.
     */
    this.recognize = (options) => (recognize(this, options));

    /**
     * Export active OCR data to specified format.
     * @param {'pdf'|'hocr'|'docx'|'xlsx'|'txt'|'text'} [format='txt']
     * @param {number} [minValue=0]
     * @param {number} [maxValue=-1]
     * @returns {Promise<string|ArrayBuffer>}
     */
    this.exportData = (format, minValue, maxValue) => (exportData(this, format, minValue, maxValue));

    /**
     * Automatically sets the default font to whatever font is most common in the provided font metrics.
     *
     */
    this.setDefaultFontAuto = () => {
      const multiFontMode = checkMultiFontMode(this.fontMetricsObj);

      // Return early if the OCR data does not contain font info.
      if (!multiFontMode) return;

      // Change default font to whatever named font appears more
      if ((this.fontMetricsObj.SerifDefault?.obs || 0) > (this.fontMetricsObj.SansDefault?.obs || 0)) {
        this.font.defaultFontName = 'SerifDefault';
      } else {
        this.font.defaultFontName = 'SansDefault';
      }

      if (gs.schedulerInner) {
        for (let i = 0; i < gs.schedulerInner.workers.length; i++) {
          const worker = gs.schedulerInner.workers[i];
          worker.updateFontContWorker({ defaultFontName: this.font.defaultFontName });
        }
      }
    };

    this.clearData = () => {
      this.inputData.clear();
      replaceObjectProperties(this.ocrAll, { active: [] });
      replaceObjectProperties(this.ocrAllRaw, { active: [] });
      this.layoutRegions.pages.length = 0;
      this.layoutDataTables.pages.length = 0;
      this.pageMetricsArr.length = 0;
      this.convertPageWarn.length = 0;
      this.images.clear();
      // Clear optimized font data and reset fontAll to raw data.
      replaceObjectProperties(this.fontMetricsObj);
      this.font.clear();
    };
  }
}
