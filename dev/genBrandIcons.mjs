// Generates every viewer.21.ai brand asset: the web favicon set and the desktop app's icons.
// The mark path is optically centered in its 96-unit box by ink centroid, which does not put its bounding box in the center.
// Run: node dev/genBrandIcons.mjs
import { createCanvas, Path2D } from '@scribe.js/canvas';
import { mkdirSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_OUT = path.join(ROOT, 'scribe-ui/basic-viewer/icons');
// electron-builder's buildResources directory.
const ELECTRON_OUT = path.join(ROOT, 'scribe-ui/basic-viewer/electron/build');
mkdirSync(WEB_OUT, { recursive: true });
mkdirSync(ELECTRON_OUT, { recursive: true });

const MARK_D = 'M 23.5 33.5 C 23.5 16.5 50.5 16.5 50.5 33.5 C 50.5 44.5 39 56.5 24 70 L 62 70 A 8 8 0 0 0 70 62 L 70 20.5 L 61 29.5';
const MARK_STROKE = 9;
const ACCENT = '#1c62d4';
const TILE_R = 21;
// More padding than this and the digits stop reading in a 16px browser tab.
const MARK_INSET = 0.95;

/**
 * Render the icon tile as a PNG buffer.
 * @param {number} size - Canvas edge in px.
 * @param {boolean} [squareCorners=false] - Fill the whole canvas instead of drawing the rounded tile, for platforms that apply their own icon mask.
 * @returns {Buffer}
 */
const renderTile = (size, squareCorners = false) => {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.scale(size / 96, size / 96);

  ctx.fillStyle = ACCENT;
  ctx.beginPath();
  if (squareCorners) {
    ctx.rect(0, 0, 96, 96);
  } else if (ctx.roundRect) {
    ctx.roundRect(0, 0, 96, 96, TILE_R);
  } else {
    ctx.moveTo(TILE_R, 0);
    ctx.arcTo(96, 0, 96, 96, TILE_R);
    ctx.arcTo(96, 96, 0, 96, TILE_R);
    ctx.arcTo(0, 96, 0, 0, TILE_R);
    ctx.arcTo(0, 0, 96, 0, TILE_R);
  }
  ctx.fill();

  const inset = ((1 - MARK_INSET) * 96) / 2;
  ctx.translate(inset, inset);
  ctx.scale(MARK_INSET, MARK_INSET);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = MARK_STROKE;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(new Path2D(MARK_D));
  return canvas.toBuffer('image/png');
};

writeFileSync(path.join(WEB_OUT, 'logo.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">
  <path d="${MARK_D}" fill="none" stroke="currentColor" stroke-width="${MARK_STROKE}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`);

const svgInset = ((1 - MARK_INSET) * 96) / 2;
writeFileSync(path.join(WEB_OUT, 'favicon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">
  <rect width="96" height="96" rx="${TILE_R}" fill="${ACCENT}"/>
  <g transform="translate(${svgInset} ${svgInset}) scale(${MARK_INSET})">
    <path d="${MARK_D}" fill="none" stroke="#fff" stroke-width="${MARK_STROKE}" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
</svg>
`);

/** @type {Array<[string, number]>} */
const webPngs = [['favicon-16.png', 16], ['favicon-32.png', 32], ['apple-touch-icon.png', 180], ['icon-512.png', 512]];
for (const [file, size] of webPngs) {
  writeFileSync(path.join(WEB_OUT, file), renderTile(size));
}

// Windows .ico: a directory of PNG-compressed entries (Vista and later).
const icoSizes = [16, 32, 48, 64, 256];
const icoPngs = icoSizes.map((size) => renderTile(size));
const icoDir = Buffer.alloc(6 + 16 * icoSizes.length);
icoDir.writeUInt16LE(0, 0);
icoDir.writeUInt16LE(1, 2);
icoDir.writeUInt16LE(icoSizes.length, 4);
let icoOffset = icoDir.length;
icoSizes.forEach((size, i) => {
  const at = 6 + 16 * i;
  // The size field is a single byte, so 256 is encoded as 0.
  icoDir.writeUInt8(size >= 256 ? 0 : size, at);
  icoDir.writeUInt8(size >= 256 ? 0 : size, at + 1);
  icoDir.writeUInt16LE(1, at + 4);
  icoDir.writeUInt16LE(32, at + 6);
  icoDir.writeUInt32LE(icoPngs[i].length, at + 8);
  icoDir.writeUInt32LE(icoOffset, at + 12);
  icoOffset += icoPngs[i].length;
});
const icoData = Buffer.concat([icoDir, ...icoPngs]);
writeFileSync(path.join(ELECTRON_OUT, 'icon.ico'), icoData);

// macOS .icns: 'icns' magic, then one typed chunk per size.
// Full-bleed square artwork: macOS applies its own squircle mask and inset, so baked-in corners or margin would be inset twice and read undersized in the Dock.
/** @type {Array<[string, number]>} */
const icnsSizes = [['icp4', 16], ['icp5', 32], ['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]];
const icnsChunks = icnsSizes
  .map(([type, size]) => {
    const png = renderTile(size, true);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([head, png]);
  });
const icnsHeader = Buffer.alloc(8);
icnsHeader.write('icns', 0, 'ascii');
icnsHeader.writeUInt32BE(8 + icnsChunks.reduce((sum, c) => sum + c.length, 0), 4);
const icnsData = Buffer.concat([icnsHeader, ...icnsChunks]);
writeFileSync(path.join(ELECTRON_OUT, 'icon.icns'), icnsData);

console.log(`web icons  -> ${WEB_OUT}`);
console.log(`app icons  -> ${ELECTRON_OUT}`);
