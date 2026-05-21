import { describe, test, expect } from 'vitest';
import { base14ToBundledFont, cssFamilyToBundledFont } from '../../js/pdf/fonts/base14Substitution.js';
import { normalizeBase14Name } from '../../js/pdf/fonts/standardFontMetrics.js';
import { ca } from '../../js/canvasAdapter.js';
import { renderPdfPage } from '../_renderPdfPage.js';
import { ASSETS_PATH } from './_paths.js';

const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;

/** @param {string} pdfPath */
async function readPdfBytes(pdfPath) {
  if (isNode) {
    const { readFile } = await import('node:fs/promises');
    return new Uint8Array(await readFile(pdfPath));
  }
  const response = await fetch(pdfPath);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Build a minimal one-page PDF that draws "Hello World" with a single non-embedded
 * Base14 font, so the renderer must resolve it through `registerNonEmbeddedFont`.
 * @param {string} baseFontName - PDF BaseFont name (e.g. 'Symbol', 'ZapfDingbats')
 * @returns {Uint8Array}
 */
function buildHelloWorldPdf(baseFontName) {
  const stream = 'BT\n/F1 24 Tf\n72 720 Td\n(Hello World) Tj\nET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /${baseFontName} >>`,
  ];
  const header = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  let body = '';
  const offsets = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(header.length + body.length);
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = header.length + body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  const bin = (/** @type {string} */ s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
  const parts = [bin(header), bin(body), bin(xref), bin(trailer)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

describe('normalizeBase14Name', () => {
  test('returns canonical Base14 names as-is', () => {
    expect(normalizeBase14Name('Courier')).toBe('Courier');
    expect(normalizeBase14Name('Courier-BoldOblique')).toBe('Courier-BoldOblique');
    expect(normalizeBase14Name('Helvetica-Bold')).toBe('Helvetica-Bold');
    expect(normalizeBase14Name('Times-Italic')).toBe('Times-Italic');
    expect(normalizeBase14Name('Symbol')).toBe('Symbol');
    expect(normalizeBase14Name('ZapfDingbats')).toBe('ZapfDingbats');
  });

  test('maps common aliases to canonical Base14 names', () => {
    expect(normalizeBase14Name('CourierNew')).toBe('Courier');
    expect(normalizeBase14Name('CourierNewPS-BoldMT')).toBe('Courier-Bold');
    expect(normalizeBase14Name('ArialMT')).toBe('Helvetica');
    expect(normalizeBase14Name('Arial-BoldMT')).toBe('Helvetica-Bold');
    expect(normalizeBase14Name('TimesNewRomanPSMT')).toBe('Times-Roman');
    expect(normalizeBase14Name('TimesNewRomanPS-BoldItalicMT')).toBe('Times-BoldItalic');
  });

  test('returns null for non-Base14 fonts', () => {
    expect(normalizeBase14Name('Roboto')).toBe(null);
    expect(normalizeBase14Name('Garamond')).toBe(null);
    expect(normalizeBase14Name('Calibri')).toBe(null);
    expect(normalizeBase14Name('')).toBe(null);
  });
});

describe('base14ToBundledFont', () => {
  test('maps Courier family to NimbusMono', () => {
    const sub = base14ToBundledFont('Courier');
    expect(sub.family).toBe('NimbusMono');
    expect(sub.variant).toBe('Regular');
    expect(sub.alias).toBe('_scribe_nimbusmono_regular');
    expect(sub.faceWeight).toBe('normal');
    expect(sub.faceStyle).toBe('normal');
  });

  test('maps Courier-BoldOblique to NimbusMono-BoldItalic', () => {
    const sub = base14ToBundledFont('Courier-BoldOblique');
    expect(sub.family).toBe('NimbusMono');
    expect(sub.variant).toBe('BoldItalic');
    expect(sub.alias).toBe('_scribe_nimbusmono_bolditalic');
    expect(sub.faceWeight).toBe('bold');
    expect(sub.faceStyle).toBe('italic');
  });

  test('maps Helvetica family to NimbusSans', () => {
    expect(base14ToBundledFont('Helvetica').family).toBe('NimbusSans');
    expect(base14ToBundledFont('Helvetica-Bold').variant).toBe('Bold');
    expect(base14ToBundledFont('Helvetica-Oblique').variant).toBe('Italic');
  });

  test('maps Times family to NimbusRoman', () => {
    expect(base14ToBundledFont('Times-Roman').family).toBe('NimbusRoman');
    expect(base14ToBundledFont('Times-Bold').variant).toBe('Bold');
    expect(base14ToBundledFont('Times-Italic').variant).toBe('Italic');
    expect(base14ToBundledFont('Times-BoldItalic').variant).toBe('BoldItalic');
  });

  test('maps Symbol to StandardSymbolsPS without variant', () => {
    const sub = base14ToBundledFont('Symbol');
    expect(sub.family).toBe('StandardSymbolsPS');
    expect(sub.variant).toBe(null);
    expect(sub.alias).toBe('_scribe_standardsymbolsps');
  });

  test('maps ZapfDingbats to Dingbats without variant', () => {
    const sub = base14ToBundledFont('ZapfDingbats');
    expect(sub.family).toBe('Dingbats');
    expect(sub.variant).toBe(null);
    expect(sub.alias).toBe('_scribe_dingbats');
  });

  test('honors bold/italic hints for alias names with no style suffix', () => {
    const sub = base14ToBundledFont('ArialMT', { bold: true });
    expect(sub.variant).toBe('Bold');
    expect(sub.faceWeight).toBe('bold');
  });

  test('returns null for non-Base14 fonts', () => {
    expect(base14ToBundledFont('Roboto')).toBe(null);
    expect(base14ToBundledFont('Garamond')).toBe(null);
  });
});

describe('cssFamilyToBundledFont', () => {
  test('maps sans-serif CSS family to NimbusSans', () => {
    const sub = cssFamilyToBundledFont('Verdana, Tahoma, sans-serif');
    expect(sub.family).toBe('NimbusSans');
    expect(sub.variant).toBe('Regular');
  });

  test('maps serif CSS family to NimbusRoman', () => {
    const sub = cssFamilyToBundledFont('Garamond, "Liberation Serif", serif', { bold: true });
    expect(sub.family).toBe('NimbusRoman');
    expect(sub.variant).toBe('Bold');
  });

  test('returns null for monospace/cursive/empty', () => {
    expect(cssFamilyToBundledFont('Courier, monospace')).toBe(null);
    expect(cssFamilyToBundledFont('cursive')).toBe(null);
    expect(cssFamilyToBundledFont(null)).toBe(null);
    expect(cssFamilyToBundledFont('')).toBe(null);
  });
});

describe.runIf(isNode)('Non-embedded Base14 fonts register bundled substitutes when rendered', () => {
  test('Courier (non-embedded) → NimbusMono-Regular', async () => {
    const bytes = await readPdfBytes(`${ASSETS_PATH}/hello_world_courier_unembedded.pdf`);
    await renderPdfPage(bytes, 0);
    const registered = new Set();
    for (const v of (ca._registeredFonts || new Map()).values()) registered.add(v.fontFaceName);
    expect(registered.has('_scribe_nimbusmono_regular')).toBe(true);
  });

  test('Helvetica (non-embedded) → NimbusSans-Regular', async () => {
    const bytes = await readPdfBytes(`${ASSETS_PATH}/hello_world_helvetica_unembedded.pdf`);
    await renderPdfPage(bytes, 0);
    const registered = new Set();
    for (const v of (ca._registeredFonts || new Map()).values()) registered.add(v.fontFaceName);
    expect(registered.has('_scribe_nimbussans_regular')).toBe(true);
  });

  test('Times-Roman (non-embedded) → NimbusRoman-Regular', async () => {
    const bytes = await readPdfBytes(`${ASSETS_PATH}/hello_world_times_unembedded.pdf`);
    await renderPdfPage(bytes, 0);
    const registered = new Set();
    for (const v of (ca._registeredFonts || new Map()).values()) registered.add(v.fontFaceName);
    expect(registered.has('_scribe_nimbusroman_regular')).toBe(true);
  });

  test('Symbol (non-embedded) → StandardSymbolsPS', async () => {
    await renderPdfPage(buildHelloWorldPdf('Symbol'), 0);
    const registered = new Set();
    for (const v of (ca._registeredFonts || new Map()).values()) registered.add(v.fontFaceName);
    expect(registered.has('_scribe_standardsymbolsps')).toBe(true);
  });

  test('ZapfDingbats (non-embedded) → Dingbats', async () => {
    await renderPdfPage(buildHelloWorldPdf('ZapfDingbats'), 0);
    const registered = new Set();
    for (const v of (ca._registeredFonts || new Map()).values()) registered.add(v.fontFaceName);
    expect(registered.has('_scribe_dingbats')).toBe(true);
  });
});
