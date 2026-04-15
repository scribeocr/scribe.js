// Relative imports are required to run in browser.
/* eslint-disable import/no-relative-packages */
import { assert, config } from '../../node_modules/chai/chai.js';
import scribe from '../../scribe.js';
import { ASSETS_PATH_KARMA } from '../constants.js';

config.truncateThreshold = 0; // Disable truncation for actual/expected values on assertion failure.

// Using arrow functions breaks references to `this`.
/* eslint-disable prefer-arrow-callback */
/* eslint-disable func-names */

const PAGE_COUNT = 7;

// Helper function to read file content in both Node.js and browser environments
async function readFileContent(filePath) {
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    const fs = await import('node:fs/promises');
    return fs.readFile(filePath, 'utf-8');
  }
  const response = await fetch(filePath);
  return response.text();
}

class MockGoogleVisionModel {
  static config = {
    name: 'Mock Google Vision',
    outputFormat: 'google_vision',
  };

  static fixturePages = [];

  static pageIndex = 0;

  static async recognizeImage(imageData, options = {}) {
    const rawData = MockGoogleVisionModel.fixturePages[MockGoogleVisionModel.pageIndex];
    MockGoogleVisionModel.pageIndex++;
    return { success: true, rawData, format: 'google_vision' };
  }
}

class MockTextractModel {
  static config = {
    name: 'Mock Textract',
    outputFormat: 'textract',
  };

  static fixturePages = [];

  static pageIndex = 0;

  static async recognizeImage(imageData, options = {}) {
    const rawData = MockTextractModel.fixturePages[MockTextractModel.pageIndex];
    MockTextractModel.pageIndex++;
    return { success: true, rawData, format: 'textract' };
  }
}

class ScatteredFailModel {
  static config = {
    name: 'Scattered Fail',
    outputFormat: 'google_vision',
  };

  static fixturePages = [];

  static pageIndex = 0;

  static failPages = new Set([2, 5]);

  static async recognizeImage(imageData, options = {}) {
    const idx = ScatteredFailModel.pageIndex;
    ScatteredFailModel.pageIndex++;
    if (ScatteredFailModel.failPages.has(idx)) {
      return { success: false, error: new Error('Transient error'), format: 'google_vision' };
    }
    const rawData = ScatteredFailModel.fixturePages[idx];
    return { success: true, rawData, format: 'google_vision' };
  }
}

class MockTextractDocumentModeModel {
  static config = {
    name: 'Mock Textract DocumentMode',
    outputFormat: 'textract',
    documentMode: true,
  };

  static fixturePages = [];

  static lastDocInput = null;

  static async * recognizeDocument(doc, options = {}) {
    MockTextractDocumentModeModel.lastDocInput = doc;
    for (let i = 0; i < MockTextractDocumentModeModel.fixturePages.length; i++) {
      yield { pageNum: i, rawData: MockTextractDocumentModeModel.fixturePages[i] };
    }
  }
}

class FailingModel {
  static config = {
    name: 'Failing Model',
    outputFormat: 'hocr',
  };

  static pageIndex = 0;

  static async recognizeImage(imageData, options = {}) {
    FailingModel.pageIndex++;
    // Fail on page index 3
    if (FailingModel.pageIndex - 1 === 3) {
      return { success: false, error: new Error('API limit reached'), format: 'hocr' };
    }
    // Return empty success for other pages (will produce empty OCR)
    return { success: false, error: new Error('Not a real model'), format: 'hocr' };
  }
}

class SlowAbortModel {
  static config = {
    name: 'Slow Abort Textract',
    outputFormat: 'textract',
  };

  static sharedFixture = null;

  static perCallDelayMs = 300;

  static async recognizeImage(imageData, options = {}) {
    await new Promise((resolve) => setTimeout(resolve, SlowAbortModel.perCallDelayMs));
    if (options.signal && options.signal.aborted) {
      return { success: false, error: new Error('aborted by signal'), format: 'textract' };
    }
    return { success: true, rawData: SlowAbortModel.sharedFixture, format: 'textract' };
  }
}

class SlowAbortDocumentModeModel {
  static config = {
    name: 'Slow Abort DocumentMode',
    outputFormat: 'textract',
    documentMode: true,
  };

  static fixturePages = [];

  static perPageDelayMs = 300;

  static lastOptionsSignal = null;

  static async * recognizeDocument(doc, options = {}) {
    SlowAbortDocumentModeModel.lastOptionsSignal = options.signal || null;
    for (let i = 0; i < SlowAbortDocumentModeModel.fixturePages.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, SlowAbortDocumentModeModel.perPageDelayMs));
      if (options.signal && options.signal.aborted) return;
      yield { pageNum: i, rawData: SlowAbortDocumentModeModel.fixturePages[i] };
    }
  }
}

describe('Check custom model recognition with Google Vision format.', function () {
  this.timeout(60000);

  before(async function () {
    const gvDir = `${ASSETS_PATH_KARMA}/tests/test-assets/trident_v_connecticut_general/googleVision`;
    const gvDirAlt = `${ASSETS_PATH_KARMA}/trident_v_connecticut_general/googleVision`;

    MockGoogleVisionModel.fixturePages = [];
    MockGoogleVisionModel.pageIndex = 0;

    for (let i = 0; i < PAGE_COUNT; i++) {
      const filename = `trident_v_connecticut_general_${String(i).padStart(3, '0')}-GoogleVisionSync.json`;
      MockGoogleVisionModel.fixturePages[i] = await readFileContent(`${gvDirAlt}/${filename}`);
    }

    await scribe.importFiles([`${ASSETS_PATH_KARMA}/trident_v_connecticut_general.pdf`]);
    await scribe.recognize({ model: MockGoogleVisionModel });
  });

  it('Should produce OCR data for all 7 pages', async function () {
    for (let i = 0; i < PAGE_COUNT; i++) {
      assert.isOk(scribe.data.ocr.active[i], `Page ${i} should have OCR data`);
      assert.isTrue(scribe.data.ocr.active[i].lines.length > 0, `Page ${i} should have lines`);
    }
  }).timeout(10000);

  it('Should correctly recognize text on page 0', async function () {
    const firstWord = scribe.data.ocr.active[0].lines[0].words[0].text;
    assert.strictEqual(firstWord, '564');
  }).timeout(10000);

  it('Should correctly recognize text on page 6', async function () {
    const firstWord = scribe.data.ocr.active[6].lines[0].words[0].text;
    assert.strictEqual(firstWord, '570');
  }).timeout(10000);

  it('Should set active OCR to the custom model results', async function () {
    assert.strictEqual(scribe.data.ocr.active, scribe.data.ocr['Mock Google Vision']);
  }).timeout(10000);

  it('Should have correct page numbers on OcrPage objects', async function () {
    for (let i = 0; i < PAGE_COUNT; i++) {
      assert.strictEqual(scribe.data.ocr.active[i].n, i, `Page ${i} should have n=${i}`);
    }
  }).timeout(10000);

  after(async function () {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check custom model recognition with Textract format.', function () {
  this.timeout(60000);

  before(async function () {
    const txDir = `${ASSETS_PATH_KARMA}/trident_v_connecticut_general/awsTextract`;

    MockTextractModel.fixturePages = [];
    MockTextractModel.pageIndex = 0;

    for (let i = 0; i < PAGE_COUNT; i++) {
      const filename = `trident_v_connecticut_general_${String(i).padStart(3, '0')}-AwsTextractLayoutSync.json`;
      MockTextractModel.fixturePages[i] = await readFileContent(`${txDir}/${filename}`);
    }

    await scribe.importFiles([`${ASSETS_PATH_KARMA}/trident_v_connecticut_general.pdf`]);
    await scribe.recognize({ model: MockTextractModel });
  });

  it('Should produce OCR data for all 7 pages', async function () {
    for (let i = 0; i < PAGE_COUNT; i++) {
      assert.isOk(scribe.data.ocr.active[i], `Page ${i} should have OCR data`);
      assert.isTrue(scribe.data.ocr.active[i].lines.length > 0, `Page ${i} should have lines`);
    }
  }).timeout(10000);

  it('Should correctly recognize text on page 0', async function () {
    const firstWord = scribe.data.ocr.active[0].lines[0].words[0].text;
    assert.strictEqual(firstWord, '564');
  }).timeout(10000);

  it('Should correctly recognize text on page 6', async function () {
    const firstWord = scribe.data.ocr.active[6].lines[0].words[0].text;
    assert.strictEqual(firstWord, '570');
  }).timeout(10000);

  it('Should set active OCR to the custom model results', async function () {
    assert.strictEqual(scribe.data.ocr.active, scribe.data.ocr['Mock Textract']);
  }).timeout(10000);

  it('Should have correct page numbers on OcrPage objects', async function () {
    for (let i = 0; i < PAGE_COUNT; i++) {
      assert.strictEqual(scribe.data.ocr.active[i].n, i, `Page ${i} should have n=${i}`);
    }
  }).timeout(10000);

  it('Should have unique word IDs across all pages', async function () {
    const allIds = [];
    for (let i = 0; i < PAGE_COUNT; i++) {
      for (const line of scribe.data.ocr.active[i].lines) {
        for (const word of line.words) {
          allIds.push(word.id);
        }
      }
    }
    const uniqueIds = new Set(allIds);
    assert.strictEqual(uniqueIds.size, allIds.length, `Found ${allIds.length - uniqueIds.size} duplicate word IDs`);
  }).timeout(10000);

  after(async function () {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check custom model recognition in documentMode (Textract).', function () {
  this.timeout(60000);

  let preRenderSpyCalls = 0;
  let originalPreRender;

  before(async function () {
    const txDir = `${ASSETS_PATH_KARMA}/trident_v_connecticut_general/awsTextract`;

    MockTextractDocumentModeModel.fixturePages = [];
    MockTextractDocumentModeModel.lastDocInput = null;

    for (let i = 0; i < PAGE_COUNT; i++) {
      const filename = `trident_v_connecticut_general_${String(i).padStart(3, '0')}-AwsTextractLayoutSync.json`;
      MockTextractDocumentModeModel.fixturePages[i] = await readFileContent(`${txDir}/${filename}`);
    }

    await scribe.importFiles([`${ASSETS_PATH_KARMA}/trident_v_connecticut_general.pdf`]);

    originalPreRender = scribe.data.image.preRenderRange;
    preRenderSpyCalls = 0;
    scribe.data.image.preRenderRange = async function (...args) {
      preRenderSpyCalls++;
      return originalPreRender.apply(this, args);
    };

    try {
      await scribe.recognize({ model: MockTextractDocumentModeModel });
    } finally {
      scribe.data.image.preRenderRange = originalPreRender;
    }
  });

  it('Should skip ImageCache.preRenderRange on the documentMode path', async function () {
    assert.strictEqual(preRenderSpyCalls, 0);
  }).timeout(10000);

  it('Should hand the PDF bytes and page count to recognizeDocument', async function () {
    assert.isOk(MockTextractDocumentModeModel.lastDocInput);
    assert.instanceOf(MockTextractDocumentModeModel.lastDocInput.pdfBytes, Uint8Array);
    assert.isTrue(MockTextractDocumentModeModel.lastDocInput.pdfBytes.byteLength > 0);
    assert.strictEqual(MockTextractDocumentModeModel.lastDocInput.pageCount, PAGE_COUNT);
    assert.strictEqual(MockTextractDocumentModeModel.lastDocInput.pageDims.length, PAGE_COUNT);
  }).timeout(10000);

  it('Should produce OCR data for all 7 pages', async function () {
    for (let i = 0; i < PAGE_COUNT; i++) {
      assert.isOk(scribe.data.ocr.active[i], `Page ${i} should have OCR data`);
      assert.isTrue(scribe.data.ocr.active[i].lines.length > 0, `Page ${i} should have lines`);
    }
  }).timeout(10000);

  it('Should correctly recognize text on page 0', async function () {
    const firstWord = scribe.data.ocr.active[0].lines[0].words[0].text;
    assert.strictEqual(firstWord, '564');
  }).timeout(10000);

  it('Should correctly recognize text on page 6', async function () {
    const firstWord = scribe.data.ocr.active[6].lines[0].words[0].text;
    assert.strictEqual(firstWord, '570');
  }).timeout(10000);

  it('Should set active OCR to the documentMode model results', async function () {
    assert.strictEqual(scribe.data.ocr.active, scribe.data.ocr['Mock Textract DocumentMode']);
  }).timeout(10000);

  after(async function () {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check custom model progress reporting.', function () {
  this.timeout(60000);

  it('Should report progress for each page', async function () {
    MockGoogleVisionModel.pageIndex = 0;

    await scribe.importFiles([`${ASSETS_PATH_KARMA}/trident_v_connecticut_general.pdf`]);

    const progressPages = [];
    const originalHandler = scribe.opt.progressHandler;
    scribe.opt.progressHandler = (msg) => {
      if (msg.type === 'convert' && msg.info.engineName === 'Mock Google Vision') {
        progressPages.push(msg.n);
      }
    };

    await scribe.recognize({ model: MockGoogleVisionModel });

    scribe.opt.progressHandler = originalHandler;

    assert.strictEqual(progressPages.length, PAGE_COUNT);
    const sortedPages = [...progressPages].sort((a, b) => a - b);
    assert.deepStrictEqual(sortedPages, [0, 1, 2, 3, 4, 5, 6]);
  }).timeout(30000);

  after(async function () {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check custom model error handling.', function () {
  this.timeout(60000);

  it('Should abort after consecutive failures', async function () {
    FailingModel.pageIndex = 0;

    await scribe.importFiles([`${ASSETS_PATH_KARMA}/trident_v_connecticut_general.pdf`]);

    const warnings = [];
    const originalHandler = scribe.opt.warningHandler;
    scribe.opt.warningHandler = (msg) => {
      warnings.push(msg);
    };

    // Force sequential processing so failures are detected before all pages are dispatched.
    const originalWorkerN = scribe.opt.workerN;
    scribe.opt.workerN = 1;

    let thrownError = null;
    try {
      await scribe.recognize({ model: FailingModel });
    } catch (err) {
      thrownError = err;
    }

    scribe.opt.warningHandler = originalHandler;
    scribe.opt.workerN = originalWorkerN;

    assert.isNotNull(thrownError);
    assert.isTrue(thrownError.message.includes('consecutive failures'));
    assert.isTrue(thrownError.message.includes('Not a real model'));
    // With workerN=1, should have aborted after exactly 3 failures (the threshold)
    assert.strictEqual(warnings.length, 3);
  }).timeout(30000);

  after(async function () {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check custom model scattered failure handling.', function () {
  this.timeout(60000);

  before(async function () {
    const gvDirAlt = `${ASSETS_PATH_KARMA}/trident_v_connecticut_general/googleVision`;

    ScatteredFailModel.fixturePages = [];
    ScatteredFailModel.pageIndex = 0;

    for (let i = 0; i < PAGE_COUNT; i++) {
      const filename = `trident_v_connecticut_general_${String(i).padStart(3, '0')}-GoogleVisionSync.json`;
      ScatteredFailModel.fixturePages[i] = await readFileContent(`${gvDirAlt}/${filename}`);
    }

    await scribe.importFiles([`${ASSETS_PATH_KARMA}/trident_v_connecticut_general.pdf`]);
  });

  it('Should return partial results and warn about failed pages', async function () {
    const warnings = [];
    const originalHandler = scribe.opt.warningHandler;
    scribe.opt.warningHandler = (msg) => {
      warnings.push(msg);
    };

    await scribe.recognize({ model: ScatteredFailModel });

    scribe.opt.warningHandler = originalHandler;

    // Pages 2 and 5 should have failed
    const summaryWarning = warnings.find((w) => w.includes('page(s)'));
    assert.isOk(summaryWarning);
    assert.isTrue(summaryWarning.includes('2'));
    assert.isTrue(summaryWarning.includes('5'));

    // Successful pages should have OCR data
    for (const i of [0, 1, 3, 4, 6]) {
      assert.isOk(scribe.data.ocr.active[i], `Page ${i} should have OCR data`);
      assert.isTrue(scribe.data.ocr.active[i].lines.length > 0, `Page ${i} should have lines`);
    }

    // Failed pages should have no lines
    assert.strictEqual(scribe.data.ocr.active[2].lines.length, 0);
    assert.strictEqual(scribe.data.ocr.active[5].lines.length, 0);
  }).timeout(30000);

  after(async function () {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check AbortSignal handling on the per-image path.', function () {
  this.timeout(60000);

  let thrownError = null;

  before(async function () {
    const txDir = `${ASSETS_PATH_KARMA}/trident_v_connecticut_general/awsTextract`;
    const filename = 'trident_v_connecticut_general_000-AwsTextractLayoutSync.json';
    SlowAbortModel.sharedFixture = await readFileContent(`${txDir}/${filename}`);
    SlowAbortModel.perCallDelayMs = 300;

    await scribe.importFiles([`${ASSETS_PATH_KARMA}/trident_v_connecticut_general.pdf`]);

    // Force sequential dispatch so the abort window is deterministic.
    const originalWorkerN = scribe.opt.workerN;
    scribe.opt.workerN = 1;

    // Abort after the first page has completed and been converted, guaranteeing partial
    // results. Hooking the progress handler avoids racing against preRenderRange, which
    // could otherwise eat a fixed-delay abort window before any page dispatches.
    const ac = new AbortController();
    const originalProgressHandler = scribe.opt.progressHandler;
    let convertCount = 0;
    scribe.opt.progressHandler = (msg) => {
      if (msg && msg.type === 'convert' && msg.info && msg.info.engineName === 'Slow Abort Textract') {
        convertCount++;
        if (convertCount === 1) ac.abort();
      }
    };

    try {
      await scribe.recognize({ model: SlowAbortModel, signal: ac.signal });
    } catch (err) {
      thrownError = err;
    } finally {
      scribe.opt.workerN = originalWorkerN;
      scribe.opt.progressHandler = originalProgressHandler;
    }
  });

  it('Should throw an AbortError when aborted mid-run', async function () {
    assert.isNotNull(thrownError);
    assert.strictEqual(thrownError.name, 'AbortError');
  }).timeout(10000);

  it('Should preserve partial OCR results for pages that completed before abort', async function () {
    const engineOcr = scribe.data.ocr['Slow Abort Textract'] || [];
    const completedPages = engineOcr.filter((p) => p && p.lines && p.lines.length > 0);
    assert.isTrue(completedPages.length > 0, 'at least one page should have completed');
    assert.isTrue(completedPages.length < PAGE_COUNT, 'not all pages should have completed');
  }).timeout(10000);

  after(async function () {
    await scribe.terminate();
  });
}).timeout(120000);

describe('Check AbortSignal handling on the documentMode path.', function () {
  this.timeout(60000);

  let thrownError = null;

  before(async function () {
    const txDir = `${ASSETS_PATH_KARMA}/trident_v_connecticut_general/awsTextract`;
    SlowAbortDocumentModeModel.fixturePages = [];
    for (let i = 0; i < PAGE_COUNT; i++) {
      const filename = `trident_v_connecticut_general_${String(i).padStart(3, '0')}-AwsTextractLayoutSync.json`;
      SlowAbortDocumentModeModel.fixturePages[i] = await readFileContent(`${txDir}/${filename}`);
    }
    SlowAbortDocumentModeModel.perPageDelayMs = 300;
    SlowAbortDocumentModeModel.lastOptionsSignal = null;

    await scribe.importFiles([`${ASSETS_PATH_KARMA}/trident_v_connecticut_general.pdf`]);

    // Abort once the first page has been received and converted — guarantees partial
    // results regardless of how long the library takes to start consuming the stream.
    const ac = new AbortController();
    const originalProgressHandler = scribe.opt.progressHandler;
    let convertCount = 0;
    scribe.opt.progressHandler = (msg) => {
      if (msg && msg.type === 'convert' && msg.info && msg.info.engineName === 'Slow Abort DocumentMode') {
        convertCount++;
        if (convertCount === 1) ac.abort();
      }
    };

    try {
      await scribe.recognize({ model: SlowAbortDocumentModeModel, signal: ac.signal });
    } catch (err) {
      thrownError = err;
    } finally {
      scribe.opt.progressHandler = originalProgressHandler;
    }
  });

  it('Should throw an AbortError when aborted mid-stream', async function () {
    assert.isNotNull(thrownError);
    assert.strictEqual(thrownError.name, 'AbortError');
  }).timeout(10000);

  it('Should forward the signal into the model via options', async function () {
    assert.isOk(SlowAbortDocumentModeModel.lastOptionsSignal);
    assert.isTrue(SlowAbortDocumentModeModel.lastOptionsSignal.aborted);
  }).timeout(10000);

  it('Should preserve partial OCR results on the documentMode engine', async function () {
    const engineOcr = scribe.data.ocr['Slow Abort DocumentMode'] || [];
    const completedPages = engineOcr.filter((p) => p && p.lines && p.lines.length > 0);
    assert.isTrue(completedPages.length > 0, 'at least one page should have completed');
    assert.isTrue(completedPages.length < PAGE_COUNT, 'not all pages should have completed');
  }).timeout(10000);

  after(async function () {
    await scribe.terminate();
  });
}).timeout(120000);
