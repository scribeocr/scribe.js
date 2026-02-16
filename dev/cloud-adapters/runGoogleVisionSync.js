import fs from 'fs';
import path from 'path';
import { initMuPDFWorker } from '../../mupdf/mupdf-async.js';
import { GoogleVisionModel } from '../../cloud-adapters/gcs-vision/RecognitionModelGoogleVision.js';

const args = process.argv.slice(2);
const splitMode = args.includes('--split');
const filePath = args.find((a) => !a.startsWith('--'));

if (!filePath) {
  console.error('Usage: node runGoogleVisionSync.js <file> [--split]');
  console.error('');
  console.error('  <file>     Image or PDF file to process');
  console.error('  --split    Write separate files per page instead of combining (PDF only)');
  process.exit(1);
}

const fileExtension = path.extname(filePath).toLowerCase();
const isPdf = fileExtension === '.pdf';
const parsedPath = path.parse(filePath);

if (isPdf) {
  const pdfData = await fs.promises.readFile(filePath);

  console.log('Initializing MuPDF worker...');
  const mupdf = await initMuPDFWorker();
  const pdfDoc = await mupdf.openDocument(pdfData.buffer, 'document.pdf');
  mupdf.pdfDoc = pdfDoc;

  const pageCount = await mupdf.countPages();
  // pageSizes returns a 1-indexed array, so slice(1) to make it 0-indexed.
  const pageDims300 = (await mupdf.pageSizes([300])).slice(1);
  // Cap width at 3500px to avoid massive renders, matching the main code.
  const pageDPIs = pageDims300.map((dims) => 300 * Math.min(dims[0], 3500) / dims[0]);

  console.log(`PDF has ${pageCount} pages.`);

  const pageResults = [];

  for (let i = 0; i < pageCount; i++) {
    const dpi = pageDPIs[i];
    console.log(`Processing page ${i + 1}/${pageCount} (${Math.round(dpi)} DPI)...`);

    const pngDataUrl = await mupdf.drawPageAsPNG({ page: i + 1, dpi, color: true });
    const base64Data = pngDataUrl.replace(/^data:image\/png;base64,/, '');
    const imageBuffer = new Uint8Array(Buffer.from(base64Data, 'base64'));

    const result = await GoogleVisionModel.recognizeImageSync(imageBuffer);

    if (!result.success) {
      console.error(`Error on page ${i + 1}:`, result.error);
      mupdf.terminate();
      process.exit(1);
    }

    pageResults.push(result.data);
    console.log(`  Page ${i + 1} done.`);
  }

  mupdf.terminate();

  if (!splitMode) {
    // Combine into async-style format with a responses array so the output
    // is compatible with the same import path as the async API.
    const combined = { responses: pageResults };

    const outputFileName = `${parsedPath.name}-GoogleVisionSync.json`;
    const outputPath = path.join(parsedPath.dir, outputFileName);
    console.log(`Writing combined result to ${outputPath}`);
    await fs.promises.writeFile(outputPath, JSON.stringify(combined, null, 2));
  } else {
    for (let i = 0; i < pageResults.length; i++) {
      const outputFileName = `${parsedPath.name}-p${i}-GoogleVisionSync.json`;
      const outputPath = path.join(parsedPath.dir, outputFileName);
      console.log(`Writing result to ${outputPath}`);
      await fs.promises.writeFile(outputPath, JSON.stringify(pageResults[i], null, 2));
    }
  }
} else {
  const fileData = await fs.promises.readFile(filePath);
  const result = await GoogleVisionModel.recognizeImageSync(fileData);

  if (!result.success) {
    console.error('Error:', result.error);
    process.exit(1);
  }

  const outputFileName = `${parsedPath.name}-GoogleVisionSync.json`;
  const outputPath = path.join(parsedPath.dir, outputFileName);
  console.log(`Writing result to ${outputPath}`);
  await fs.promises.writeFile(outputPath, JSON.stringify(result.data, null, 2));
}

console.log('Done.');
