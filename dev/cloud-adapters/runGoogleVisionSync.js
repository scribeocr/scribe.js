import fs from 'fs';
import path from 'path';
import { initPdfScheduler } from '../../js/pdfWorkerMain.js';
import { GoogleVisionModel } from '../../cloud-adapters/gcs-vision/RecognitionModelGoogleVision.js';

const args = process.argv.slice(2);
const splitMode = args.includes('--split');
const filePath = args.find((a) => !a.startsWith('--'));

if (!filePath) {
  console.error('Usage: node runGoogleVisionSync.js <file> [--split]');
  console.error('');
  console.error('  <file>     Image or PDF file to process');
  console.error('  --split    Write separate files per page instead of combining (PDF only)');
  console.error('');
  console.error('Google Cloud credentials must be configured.');
  console.error('Set GOOGLE_APPLICATION_CREDENTIALS to a service account key file path,');
  console.error('or run: gcloud auth application-default login');
  process.exit(1);
}

const fileExtension = path.extname(filePath).toLowerCase();
const isPdf = fileExtension === '.pdf';
const parsedPath = path.parse(filePath);

if (isPdf) {
  const pdfData = await fs.promises.readFile(filePath);
  const pdfBytes = new Uint8Array(pdfData);

  console.log('Initializing PDF worker pool...');
  const pdfScheduler = await initPdfScheduler(1);
  const { pageCount, pages } = await pdfScheduler.loadPdfInAllWorkers(pdfBytes);

  // Convert mediaBox (points, 72 DPI) to 300-DPI pixel dimensions to match the main code's cap logic.
  const pageDims300 = pages.map((p) => {
    const widthPts = Math.abs(p.mediaBox[2] - p.mediaBox[0]);
    return Math.round(widthPts * 300 / 72);
  });
  // Cap width at 3500px to avoid massive renders, matching the main code.
  const pageDPIs = pageDims300.map((w) => 300 * Math.min(w, 3500) / w);

  console.log(`PDF has ${pageCount} pages.`);

  const pageResults = [];

  for (let i = 0; i < pageCount; i++) {
    const dpi = pageDPIs[i];
    console.log(`Processing page ${i + 1}/${pageCount} (${Math.round(dpi)} DPI)...`);

    const { dataUrl } = await pdfScheduler.renderPdfPage({ pageIndex: i, colorMode: 'color', dpi });
    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
    const imageBuffer = new Uint8Array(Buffer.from(base64Data, 'base64'));

    const result = await GoogleVisionModel.recognizeImage(imageBuffer);

    if (!result.success) {
      console.error(`Error on page ${i + 1}:`, result.error);
      await pdfScheduler.terminate();
      process.exit(1);
    }

    pageResults.push(JSON.parse(result.rawData));
    console.log(`  Page ${i + 1} done.`);
  }

  await pdfScheduler.terminate();

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
  const result = await GoogleVisionModel.recognizeImage(fileData);

  if (!result.success) {
    console.error('Error:', result.error);
    process.exit(1);
  }

  const outputFileName = `${parsedPath.name}-GoogleVisionSync.json`;
  const outputPath = path.join(parsedPath.dir, outputFileName);
  console.log(`Writing result to ${outputPath}`);
  await fs.promises.writeFile(outputPath, JSON.stringify(JSON.parse(result.rawData), null, 2));
}

console.log('Done.');
