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
    assert.isBelow(scribe.data.font.optMetrics.NimbusSans, 0.45);
  }).timeout(10000);

  it('Font optimization should be enabled when it improves overlap quality', async () => {
    assert.strictEqual(scribe.data.font.enableOpt, true);
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
    assert.isBelow(scribe.data.font.optMetrics.Palatino, 0.35);
  }).timeout(10000);

  it('Font optimization should be enabled when it improves overlap quality', async () => {
    assert.strictEqual(scribe.data.font.enableOpt, true);
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
    assert.isBelow(scribe.data.font.optMetrics.NimbusRomNo9L, 0.4);
  }).timeout(10000);

  it('Overlap with clockwise rotation is decent', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/simple_paragraph_rot5.png`]);
    await scribe.recognize({
      modeAdv: 'legacy',
    });

    if (!scribe.data.font.rawMetrics) throw new Error('DebugData.evalRaw is not defined');
    if (!scribe.data.font.optMetrics) throw new Error('DebugData.evalOpt is not defined');
    assert.isBelow(scribe.data.font.optMetrics.NimbusRomNo9L, 0.4);
  }).timeout(10000);

  it('Overlap with counterclockwise rotation is decent', async () => {
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/simple_paragraph_rotc5.png`]);
    await scribe.recognize({
      modeAdv: 'legacy',
    });

    if (!scribe.data.font.rawMetrics) throw new Error('DebugData.evalRaw is not defined');
    if (!scribe.data.font.optMetrics) throw new Error('DebugData.evalOpt is not defined');
    assert.isBelow(scribe.data.font.optMetrics.NimbusRomNo9L, 0.4);
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
