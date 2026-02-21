import fs from 'fs';
import path from 'path';
import { initMuPDFWorker } from '../../mupdf/mupdf-async.js';
import { RecognitionModelTextract } from '../../cloud-adapters/aws-textract/RecognitionModelAwsTextract.js';

const args = process.argv.slice(2);
const splitMode = args.includes('--split');
const filePath = args.find((a) => !a.startsWith('--'));

if (!filePath) {
  console.error('Usage: node runAwsTextractSync.js <file> [--layout] [--tables] [--split]');
  console.error('');
  console.error('  <file>     Image or PDF file to process');
  console.error('  --layout   Enable layout analysis');
  console.error('  --tables   Enable table analysis');
  console.error('  --split    Write separate files per page instead of combining (PDF only)');
  console.error('');
  console.error('AWS credentials and region must be configured via one of:');
  console.error('  - AWS_REGION, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY env vars');
  console.error('  - ~/.aws/credentials and ~/.aws/config files (with optional AWS_PROFILE)');
  console.error('  - IAM role (when running on EC2/ECS/Lambda)');
  process.exit(1);
}

const options = {
  analyzeLayout: args.includes('--layout'),
  analyzeTables: args.includes('--tables'),
};

const fileExtension = path.extname(filePath).toLowerCase();
const isPdf = fileExtension === '.pdf';
const parsedPath = path.parse(filePath);

let suffix = 'AwsTextractSync.json';
if (options.analyzeLayout) {
  suffix = 'AwsTextractLayoutSync.json';
}

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

    const result = await RecognitionModelTextract.recognizeImage(imageBuffer, options);

    if (!result.success) {
      console.error(`Error on page ${i + 1}:`, result.error);
      mupdf.terminate();
      process.exit(1);
    }

    pageResults.push(JSON.parse(result.rawData));
    console.log(`  Page ${i + 1} done.`);
  }

  mupdf.terminate();

  if (!splitMode) {
    const combined = RecognitionModelTextract.combineTextractResponses(pageResults);

    const outputFileName = `${parsedPath.name}-${suffix}`;
    const outputPath = path.join(parsedPath.dir, outputFileName);
    console.log(`Writing combined result to ${outputPath}`);
    await fs.promises.writeFile(outputPath, JSON.stringify(combined, null, 2));
  } else {
    for (let i = 0; i < pageResults.length; i++) {
      const outputFileName = `${parsedPath.name}-p${i}-${suffix}`;
      const outputPath = path.join(parsedPath.dir, outputFileName);
      console.log(`Writing result to ${outputPath}`);
      await fs.promises.writeFile(outputPath, JSON.stringify(pageResults[i], null, 2));
    }
  }
} else {
  const fileData = await fs.promises.readFile(filePath);
  const result = await RecognitionModelTextract.recognizeImage(fileData, options);

  if (!result.success) {
    console.error('Error:', result.error);
    process.exit(1);
  }

  const outputFileName = `${parsedPath.name}-${suffix}`;
  const outputPath = path.join(parsedPath.dir, outputFileName);
  console.log(`Writing result to ${outputPath}`);
  await fs.promises.writeFile(outputPath, JSON.stringify(JSON.parse(result.rawData), null, 2));
}

console.log('Done.');
