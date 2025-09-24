// Relative imports are required to run in browser.
/* eslint-disable import/no-relative-packages */
import { assert, config } from '../../node_modules/chai/chai.js';

// Using arrow functions breaks references to `this`.
/* eslint-disable prefer-arrow-callback */
/* eslint-disable func-names */

import { importImageFileToBase64, base64ToBytes } from '../../js/utils/imageUtils.js';

config.truncateThreshold = 0; // Disable truncation for actual/expected values on assertion failure.

// Helper: create minimal byte arrays for testing format detection
function makeJpegBytes() {
  /* eslint-disable-next-line max-len */
  return new Uint8Array([0xFF, 0xD8, 0xFF, 0xDB, 0x00, 0x43, 0x00, 0x03, 0x02, 0x02, 0x02, 0x02, 0x02, 0x03, 0x02, 0x02, 0x02, 0x03, 0x03, 0x03, 0x03, 0x04, 0x06, 0x04, 0x04, 0x04, 0x04, 0x04, 0x08, 0x06, 0x06, 0x05, 0x06, 0x09, 0x08, 0x0A, 0x0A, 0x09, 0x08, 0x09, 0x09, 0x0A, 0x0C, 0x0F, 0x0C, 0x0A, 0x0B, 0x0E, 0x0B, 0x09, 0x09, 0x0D, 0x11, 0x0D, 0x0E, 0x0F, 0x10, 0x10, 0x11, 0x10, 0x0A, 0x0C, 0x12, 0x13, 0x12, 0x10, 0x13, 0x0F, 0x10, 0x10, 0x10, 0xFF, 0xC9, 0x00, 0x0B, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xFF, 0xCC, 0x00, 0x06, 0x00, 0x10, 0x10, 0x05, 0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0xD2, 0xCF, 0x20, 0xFF, 0xD9]);
}

function makePngBytes() {
  /* eslint-disable-next-line max-len */
  return new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x37, 0x6E, 0xF9, 0x24, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x01, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01, 0x73, 0x75, 0x01, 0x18, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);
}

describe('importImageFileToBase64', function () {
  this.timeout(10000);

  it('converts JPEG ArrayBuffer to a data URL with image/jpeg prefix', async () => {
    const bytes = makeJpegBytes();
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const dataUrl = await importImageFileToBase64(ab);
    assert.isTrue(dataUrl.startsWith('data:image/jpeg;base64,'), 'Should have jpeg data URL prefix');

    // Verify base64 decodes back to original bytes
    const decoded = base64ToBytes(dataUrl);
    assert.strictEqual(decoded.length, bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      assert.strictEqual(decoded[i], bytes[i], `Byte mismatch at index ${i}`);
    }
  }).timeout(5000);

  it('converts PNG ArrayBuffer to a data URL with image/png prefix', async () => {
    const bytes = makePngBytes();
    const ab = bytes.buffer;
    const dataUrl = await importImageFileToBase64(ab);
    assert.isTrue(dataUrl.startsWith('data:image/png;base64,'), 'Should have png data URL prefix');

    const decoded = base64ToBytes(dataUrl);
    assert.strictEqual(decoded.length, bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      assert.strictEqual(decoded[i], bytes[i], `Byte mismatch at index ${i}`);
    }
  }).timeout(5000);

  it('reads browser File via FileReader and returns a data URL with correct mime', async function () {
    // Skip if File API is not available (e.g., running in Node)
    if (typeof FileReader === 'undefined') {
      this.skip();
      return;
    }
    const bytes = makePngBytes();
    const blob = new Blob([bytes], { type: 'image/png' });
    const file = new File([blob], 'sample.png', { type: 'image/png' });

    const dataUrl = await importImageFileToBase64(file);
    assert.isTrue(dataUrl.startsWith('data:image/png;base64,'), 'Should have png data URL prefix');

    const decoded = base64ToBytes(dataUrl);
    assert.strictEqual(decoded.length, bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      assert.strictEqual(decoded[i], bytes[i], `Byte mismatch at index ${i}`);
    }
  }).timeout(5000);

  it('rejects on invalid input with helpful error message', async () => {
    let caught = null;
    try {
      await importImageFileToBase64({});
    } catch (e) {
      caught = e;
    }
    assert.isNotNull(caught, 'Error should be thrown');
    assert.match(String(caught?.message || caught), /Invalid input/i);
  }).timeout(5000);
});
