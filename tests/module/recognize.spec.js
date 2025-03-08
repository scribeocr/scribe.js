// Relative imports are required to run in browser.
/* eslint-disable import/no-relative-packages */

// import { after, it } from 'mocha';
import { assert, config } from '../../node_modules/chai/chai.js';
// import path from 'path';
import scribe from '../../scribe.js';
import { ASSETS_PATH_KARMA } from '../constants.js';

config.truncateThreshold = 0; // Disable truncation for actual/expected values on assertion failure.

// Using arrow functions breaks references to `this`.
/* eslint-disable prefer-arrow-callback */
/* eslint-disable func-names */

describe('Check basic recognition features.', function () {
  this.timeout(20000);
  it('Should recognize basic .png image using single function', async () => {
    const txt = await scribe.extractText([`${ASSETS_PATH_KARMA}/simple.png`]);
    assert.strictEqual(txt, 'Tesseract.js');
  }).timeout(10000);

  it('Should recognize basic .jpg image using single function', async () => {
    const txt = await scribe.extractText([`${ASSETS_PATH_KARMA}/simple.jpg`]);
    assert.strictEqual(txt, 'Tesseract.js');
  }).timeout(10000);
});

describe('Check style detection.', function () {
  this.timeout(20000);
  before(async () => {
    // This article page contains mostly italic text.
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/italics_1.png`]);
    await scribe.recognize({
      modeAdv: 'legacy',
    });
  });

  it('Italic words are identified correctly', async () => {
    assert.isFalse(scribe.data.ocr.active[0].lines[0].words[3].style.italic);
    assert.isTrue(scribe.data.ocr.active[0].lines[0].words[4].style.italic);
    assert.isTrue(scribe.data.ocr.active[0].lines[0].words[5].style.italic);
    assert.isFalse(scribe.data.ocr.active[0].lines[0].words[6].style.italic);
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
});

describe('Check font optimization features.', function () {
  this.timeout(20000);
  before(async () => {
    // For this input image, font optimization significantly improves overlap quality.
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/analyst_report.png`]);
    await scribe.recognize({
      modeAdv: 'legacy',
    });
  });

  it('Font optimization improves overlap quality', async () => {
    if (!scribe.data.font.rawMetrics) throw new Error('DebugData.evalRaw is not defined');
    if (!scribe.data.font.optMetrics) throw new Error('DebugData.evalOpt is not defined');
    assert.isBelow(scribe.data.font.optMetrics.NimbusSans, scribe.data.font.rawMetrics.NimbusSans);
    assert.isBelow(scribe.data.font.optMetrics.NimbusSans, 0.47);
  }).timeout(10000);

  it('Font optimization should be enabled when it improves overlap quality', async () => {
    assert.strictEqual(scribe.data.font.state.enableOpt, true);
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
});

describe('Check that font optimization works with italics.', function () {
  this.timeout(20000);
  before(async () => {
    // This article page contains mostly italic text.
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/article_italics.png`]);
    await scribe.recognize({
      modeAdv: 'legacy',
    });
  });

  it('Font optimization improves overlap quality with italics', async () => {
    if (!scribe.data.font.rawMetrics) throw new Error('DebugData.evalRaw is not defined');
    if (!scribe.data.font.optMetrics) throw new Error('DebugData.evalOpt is not defined');
    assert.isBelow(scribe.data.font.optMetrics.Palatino, scribe.data.font.rawMetrics.Palatino);
    assert.isBelow(scribe.data.font.optMetrics.Palatino, 0.37);
  }).timeout(10000);

  it('Font optimization should be enabled when it improves overlap quality', async () => {
    assert.strictEqual(scribe.data.font.state.enableOpt, true);
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
});

describe('Check auto-rotate features.', function () {
  this.timeout(20000);

  it('Baseline overlap is decent', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/simple_paragraph.png`]);
    await scribe.recognize({
      modeAdv: 'legacy',
    });

    if (!scribe.data.font.rawMetrics) throw new Error('DebugData.evalRaw is not defined');
    if (!scribe.data.font.optMetrics) throw new Error('DebugData.evalOpt is not defined');
    assert.isBelow(scribe.data.font.optMetrics.NimbusRoman, 0.45);
  }).timeout(10000);

  it('Overlap with clockwise rotation is decent', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/simple_paragraph_rot5.png`]);
    await scribe.recognize({
      modeAdv: 'legacy',
    });

    if (!scribe.data.font.rawMetrics) throw new Error('DebugData.evalRaw is not defined');
    if (!scribe.data.font.optMetrics) throw new Error('DebugData.evalOpt is not defined');
    assert.isBelow(scribe.data.font.optMetrics.NimbusRoman, 0.45);
  }).timeout(10000);

  it('Overlap with counterclockwise rotation is decent', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/simple_paragraph_rotc5.png`]);
    await scribe.recognize({
      modeAdv: 'legacy',
    });

    if (!scribe.data.font.rawMetrics) throw new Error('DebugData.evalRaw is not defined');
    if (!scribe.data.font.optMetrics) throw new Error('DebugData.evalOpt is not defined');
    assert.isBelow(scribe.data.font.optMetrics.NimbusRoman, 0.45);
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
});

describe('Check Tesseract.js parameters can be set.', function () {
  this.timeout(20000);

  it('Config option tessedit_char_whitelist can be set', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/simple.png`]);
    await scribe.recognize({
      config: {
        tessedit_char_whitelist: '0123456789',
      },
    });
    const txt = await scribe.exportData('text');
    assert.isTrue(/\d{3,}/.test(txt) && !/[A-Za-z]/.test(txt));
  }).timeout(10000);

  it('Config option tessedit_char_whitelist can be restored', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/simple.png`]);
    await scribe.recognize({
      config: {
        tessedit_char_whitelist: '',
      },
    });
    const txt = await scribe.exportData('text');
    assert.strictEqual(txt, 'Tesseract.js');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
});

describe('Check comparison between OCR versions.', function () {
  this.timeout(20000);

  it('Errors in uploaded OCR data are corrected', async () => {
    // These functions still require various dependencies to be loaded to run properly.
    // In some future version this should be fixed.
    await scribe.init({ ocr: true, font: true });

    /** @type {Parameters<typeof scribe.compareOCR>[2]} */
    const compOptions = {
      mode: 'comb',
      supplementComp: false,
    };

    await scribe.importFiles([`${ASSETS_PATH_KARMA}/testocr.png`, `${ASSETS_PATH_KARMA}/testocr_errors.hocr`]);

    await scribe.importFilesSupp([`${ASSETS_PATH_KARMA}/testocr_missing_word.hocr`], 'Missing Word');

    const res = await scribe.compareOCR(scribe.data.ocr['User Upload'], scribe.data.ocr['Missing Word'], compOptions);

    // The first word is present in the 'Missing Word' OCR data.
    assert.strictEqual(res.ocr[0].lines[0].words[0].text, 'This');
  }).timeout(10000);

  it('Comparisons handled correctly when word is missing from comparison OCR', async () => {
    /** @type {Parameters<typeof scribe.compareOCR>[2]} */
    const compOptions1 = {
      mode: 'comb',
      supplementComp: false,
    };

    const res1 = await scribe.compareOCR(scribe.data.ocr['User Upload'], scribe.data.ocr['Missing Word'], compOptions1);

    // The second word is missing in the 'Missing Word' OCR data, so the confidence should be 0 when compared to itself.
    assert.strictEqual(res1.ocr[0].lines[0].words[2].conf, 0);

    /** @type {Parameters<typeof scribe.compareOCR>[2]} */
    const compOptions2 = {
      mode: 'comb',
      supplementComp: true,
    };

    const res2 = await scribe.compareOCR(scribe.data.ocr['User Upload'], scribe.data.ocr['Missing Word'], compOptions2);

    // When the `supplementComp` option is set to `true`, missing words should be supplemented with new recognition, so the confidence should be 100.
    assert.strictEqual(res2.ocr[0].lines[0].words[2].conf, 100);
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
});
