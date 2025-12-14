// Relative imports are required to run in browser.
/* eslint-disable import/no-relative-packages */
import { assert, config } from '../../node_modules/chai/chai.js';
import { writeAlto } from '../../js/export/writeAlto.js';
import scribe from '../../scribe.js';
import { ASSETS_PATH_KARMA } from '../constants.js';

config.truncateThreshold = 0; // Disable truncation for actual/expected values on assertion failure.

/**
 * Reads a text file in any environment (browser or Node.js).
 * @param {string} filePath
 */
async function readTextFileUniversal(filePath) {
  if (typeof process !== 'undefined') {
    const { promises: fsPromises } = await import('node:fs');
    const contents = await fsPromises.readFile(filePath, 'utf-8');
    return contents;
  }

  const response = await fetch(filePath);
  if (!response.ok) {
    throw new Error(`Failed to fetch file: ${filePath}`);
  }
  return await response.text();
}

/**
 * Function to normalize and extract content for comparison
 * @param {string} xmlStr
 */
const normalizeAlto = (xmlStr) => {
  xmlStr = xmlStr.replace(/<processingDateTime>[^<]*<\/processingDateTime>/g, '');
  xmlStr = xmlStr.replace(/<softwareCreator>[^<]*<\/softwareCreator>/g, '');
  xmlStr = xmlStr.replace(/<softwareName>[^<]*<\/softwareName>/g, '');
  xmlStr = xmlStr.replace(/<softwareVersion>[^<]*<\/softwareVersion>/g, '');

  xmlStr = xmlStr.replace(/<TopMargin[^>]*>\s*<\/TopMargin>/g, '');
  xmlStr = xmlStr.replace(/<LeftMargin[^>]*>\s*<\/LeftMargin>/g, '');
  xmlStr = xmlStr.replace(/<RightMargin[^>]*>\s*<\/RightMargin>/g, '');
  xmlStr = xmlStr.replace(/<BottomMargin[^>]*>\s*<\/BottomMargin>/g, '');

  xmlStr = xmlStr.replace(/<PrintSpace[^>]*>/g, '<PrintSpace>');

  // Remove position attributes from TextBlock.
  // Some of the test data is from Abbyy,
  // which does not tightly enclose TextBlock elements around text content.
  // Therefore, position attributes may differ after re-exporting.
  xmlStr = xmlStr.replace(/<TextBlock\s+([^>]*)>/g, (_match, attrs) => {
    const newAttrs = attrs.replace(/\s*VPOS="[^"]*"\s*/g, ' ')
      .replace(/\s*HPOS="[^"]*"\s*/g, ' ')
      .replace(/\s*WIDTH="[^"]*"\s*/g, ' ')
      .replace(/\s*HEIGHT="[^"]*"\s*/g, ' ')
      .trim();
    return `<TextBlock ${newAttrs}>`;
  });

  // Normalize confidence values to 2 decimal places
  xmlStr = xmlStr.replace(/WC="(\d+(?:\.\d+)?)"/g, (_match, value) => {
    const numValue = parseFloat(value);
    if (Number.isNaN(numValue)) {
      throw new Error(`Invalid WC value: "${value}" cannot be parsed to a number`);
    }
    return `WC="${numValue.toFixed(2)}"`;
  });

  xmlStr = xmlStr.replace(/<SP\s+([^>]*)\/>/g, (_match, attrs) => {
    const newAttrs = attrs.replace(/\s*VPOS="[^"]*"\s*/g, ' ').trim();
    return `<SP ${newAttrs}/>`;
  });

  xmlStr = xmlStr.replace(/\s+/g, ' ').trim();
  xmlStr = xmlStr.replace(/>/g, '>\n');
  return xmlStr;
};

// Using arrow functions breaks references to `this`.
/* eslint-disable prefer-arrow-callback */
/* eslint-disable func-names */

describe('Check .alto export function.', function () {
  this.timeout(10000);

  it('Should correctly export and reimport text content', async () => {
    await scribe.terminate();
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/the_past.alto.xml`]);

    const text1Before = scribe.data.ocr.active[0].lines[0].words.map((x) => x.text).join(' ');
    const text3Before = scribe.data.ocr.active[0].lines[2].words.map((x) => x.text).join(' ');

    const altoOutStr = writeAlto({ ocrData: scribe.data.ocr.active });

    const encoder = new TextEncoder();
    const encoded = encoder.encode(altoOutStr);

    await scribe.terminate();
    await scribe.importFiles({ ocrFiles: [encoded.buffer] });

    const text1After = scribe.data.ocr.active[0].lines[0].words.map((x) => x.text).join(' ');
    const text3After = scribe.data.ocr.active[0].lines[2].words.map((x) => x.text).join(' ');

    assert.strictEqual(text1Before, text1After);
    assert.strictEqual(text3Before, text3After);
  }).timeout(10000);

  it('Should correctly export and reimport confidence scores', async () => {
    await scribe.terminate();
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/the_past.alto.xml`]);

    const word1Before = scribe.data.ocr.active[0].lines[0].words[0];
    const word2Before = scribe.data.ocr.active[0].lines[0].words[1];
    const conf1Before = word1Before.conf;
    const conf2Before = word2Before.conf;

    const altoOutStr = writeAlto({ ocrData: scribe.data.ocr.active });

    const encoder = new TextEncoder();
    const encoded = encoder.encode(altoOutStr);

    await scribe.terminate();
    await scribe.importFiles({ ocrFiles: [encoded.buffer] });

    const word1After = scribe.data.ocr.active[0].lines[0].words[0];
    const word2After = scribe.data.ocr.active[0].lines[0].words[1];

    assert.approximately(word1After.conf, conf1Before, 1, 'Word 1 confidence should be approximately the same');
    assert.approximately(word2After.conf, conf2Before, 1, 'Word 2 confidence should be approximately the same');
  }).timeout(10000);

  it('Should correctly export and reimport font styles', async () => {
    await scribe.terminate();
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/the_past.alto.xml`]);

    const boldBefore1 = scribe.data.ocr.active[0].lines[0].words[0].style.bold;
    const boldBefore2 = scribe.data.ocr.active[0].lines[0].words[1].style.bold;

    const altoOutStr = writeAlto({ ocrData: scribe.data.ocr.active });

    const encoder = new TextEncoder();
    const encoded = encoder.encode(altoOutStr);

    await scribe.terminate();
    await scribe.importFiles({ ocrFiles: [encoded.buffer] });

    const boldAfter1 = scribe.data.ocr.active[0].lines[0].words[0].style.bold;
    const boldAfter2 = scribe.data.ocr.active[0].lines[0].words[1].style.bold;

    assert.strictEqual(boldBefore1, boldAfter1, 'Word 1 bold style should be preserved');
    assert.strictEqual(boldBefore2, boldAfter2, 'Word 2 bold style should be preserved');
  }).timeout(10000);

  it('Should correctly export and reimport font family', async () => {
    await scribe.terminate();
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/the_past.alto.xml`]);

    const fontBefore = scribe.data.ocr.active[0].lines[0].words[0].style.font;

    const altoOutStr = writeAlto({ ocrData: scribe.data.ocr.active });

    const encoder = new TextEncoder();
    const encoded = encoder.encode(altoOutStr);

    await scribe.terminate();
    await scribe.importFiles({ ocrFiles: [encoded.buffer] });

    const fontAfter = scribe.data.ocr.active[0].lines[0].words[0].style.font;

    assert.strictEqual(fontBefore, fontAfter, 'Font family should be preserved');
  }).timeout(10000);

  it('Should match original ALTO XML structure after round-trip (content-only comparison)', async () => {
    await scribe.terminate();
    await scribe.importFiles([`${ASSETS_PATH_KARMA}/simple_paragraph.alto.xml`]);

    const originalAltoStr = await readTextFileUniversal(`${ASSETS_PATH_KARMA}/simple_paragraph.alto.xml`);
    const altoOutStr = writeAlto({ ocrData: scribe.data.ocr.active });

    const normalizedOriginal = normalizeAlto(originalAltoStr);
    const normalizedExported = normalizeAlto(altoOutStr);

    assert.strictEqual(normalizedExported, normalizedOriginal, 'Exported ALTO should match original after normalization');
  }).timeout(10000);

  after(async () => {
    await scribe.terminate();
  });
}).timeout(120000);
