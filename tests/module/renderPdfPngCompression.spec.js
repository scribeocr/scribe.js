import {
  describe, test, expect, beforeAll,
} from 'vitest';
import { ca } from '../../js/canvasAdapter.js';
import { renderPdfPages } from '../../js/pdf/renderPdfPage.js';
import { ASSETS_PATH } from './_paths.js';

const PDF_FILE = `${ASSETS_PATH}/border_patrol_tables.pdf`;

/** @param {string} filePath */
async function readFileBytes(filePath) {
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    const fs = await import('node:fs/promises');
    const buf = await fs.readFile(filePath);
    return new Uint8Array(buf);
  }
  const response = await fetch(filePath);
  return new Uint8Array(await response.arrayBuffer());
}

/** Decode the base64 payload of a `data:image/png;base64,...` URL. */
function pngByteLength(dataUrl) {
  const prefix = 'data:image/png;base64,';
  expect(dataUrl.startsWith(prefix)).toBe(true);
  const base64 = dataUrl.slice(prefix.length);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor(base64.length * 3 / 4) - padding;
}

/** Decode a `data:image/png;base64,...` URL into raw PNG bytes (Node + browser). */
function dataUrlToPngBytes(dataUrl) {
  const base64 = dataUrl.slice('data:image/png;base64,'.length);
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(base64, 'base64'));
  const bin = atob(base64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

describe('renderPdfPages PNG compression', () => {
  beforeAll(async () => {
    if (ca.isNode) await ca.getCanvasNode();
  });

  test('border_patrol_tables.pdf p0 (color mode) compresses to under 1000 kB', async () => {
    // Sentinel against catastrophic regressions in the color encode path
    // (e.g., reverting to uncompressed PNG output, ~30 MB). The platform
    // built-in encoder produces ~969 kB so it would also pass; the narrow
    // gap is fine because color savings come from alpha-stripping rather
    // than 1-channel encoding.
    const bytes = await readFileBytes(PDF_FILE);
    const { dataUrls } = await renderPdfPages(bytes, 0, 0, 'color');
    const len = pngByteLength(dataUrls[0]);
    expect(len).toBeLessThan(1000 * 1024);
  });

  test('border_patrol_tables.pdf p0 (gray mode) compresses to under 600 kB', async () => {
    // Discriminator: custom output is ~414 kB (1-channel grayscale),
    // canvas.toBuffer/toDataURL output is ~878 kB (4-channel RGBA).
    // 600 kB cleanly fails the platform-encoder regression while leaving
    // ~45% headroom above the custom-encoder output.
    const bytes = await readFileBytes(PDF_FILE);
    const { dataUrls } = await renderPdfPages(bytes, 0, 0, 'gray');
    const len = pngByteLength(dataUrls[0]);
    expect(len).toBeLessThan(600 * 1024);
  });

  test('renders a valid PNG (sanity — not accidentally an all-blank image)', async () => {
    // The getImageData path has previously regressed to all-zero pixels
    // (napi-rs `copy_from` bug), which compresses to a tiny but
    // visually-broken PNG. Size-only assertions above would pass in
    // that case. Decode the PNG and confirm it contains non-trivial
    // pixel variance.
    const bytes = await readFileBytes(PDF_FILE);
    const { dataUrls } = await renderPdfPages(bytes, 0, 0, 'color');
    const pngBytes = dataUrlToPngBytes(dataUrls[0]);
    const img = await ca.createImageBitmapFromData(pngBytes);
    const canvas = ca.makeCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    const seen = new Set();
    for (let i = 0; i < data.length; i += 1600) {
      const l = (data[i] + data[i + 1] + data[i + 2]) >> 2;
      seen.add(l);
    }
    expect(seen.size).toBeGreaterThanOrEqual(10);
  });
});
