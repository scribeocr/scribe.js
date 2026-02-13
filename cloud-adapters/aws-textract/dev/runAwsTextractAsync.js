import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { OcrEngineAWSTextract } from '../ocrEngineAwsTextract.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const filePath = path.join(__dirname, './textract_testing');

const combineResponses = true;

const options = {
  analyzeLayout: true,
  analyzeLayoutTables: false,
  // Enter your S3 bucket name here to use asynchronous processing.
  // Sync processing does not require an S3 bucket.
  s3Bucket: 'textract-test-misc-us-east-1',
  // Set to true to process all PDF/image files in a directory.
  processDirectory: true,
};

const SUPPORTED_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.tiff', '.tif'];

async function processFile(inputPath) {
  console.log(`Processing: ${inputPath}`);
  const result = await OcrEngineAWSTextract.recognizeFileAsync(inputPath, options);

  if (!result.success) {
    console.error(`Error processing ${inputPath}:`, result.error);
    return false;
  }

  const parsedPath = path.parse(inputPath);
  let suffix = 'AwsTextract.json';
  if (options.analyzeLayout) {
    suffix = 'AwsTextractLayout.json';
  }

  if (combineResponses) {
    const outputFileName = `${parsedPath.name}-${suffix}`;
    const outputPath = path.join(parsedPath.dir, outputFileName);
    console.log(`Writing combined result to ${outputPath}`);
    await fs.promises.writeFile(outputPath, JSON.stringify(OcrEngineAWSTextract.combineTextractAsyncResponses(result.data), null, 2));
  } else {
    for (let i = 0; i < result.data.length; i++) {
      const outputFileName = `${parsedPath.name}-p${i}-${suffix}`;
      const outputPath = path.join(parsedPath.dir, outputFileName);
      console.log(`Writing result to ${outputPath}`);
      await fs.promises.writeFile(outputPath, JSON.stringify(result.data[i], null, 2));
    }
  }
  return true;
}

const stat = await fs.promises.stat(filePath);

if (stat.isDirectory()) {
  if (!options.processDirectory) {
    console.error('Input is a directory but processDirectory option is not enabled.');
    console.error('Set processDirectory: true in options to process all files in the directory.');
    process.exit(1);
  }

  const files = await fs.promises.readdir(filePath);
  const supportedFiles = files.filter((file) => {
    const ext = path.extname(file).toLowerCase();
    return SUPPORTED_EXTENSIONS.includes(ext);
  });

  if (supportedFiles.length === 0) {
    console.error('No supported files found in directory.');
    process.exit(1);
  }

  console.log(`Found ${supportedFiles.length} files to process.`);

  let successCount = 0;
  let failCount = 0;

  for (const file of supportedFiles) {
    const fullPath = path.join(filePath, file);
    const success = await processFile(fullPath);
    if (success) {
      successCount++;
    } else {
      failCount++;
    }
  }

  console.log(`\nCompleted: ${successCount} succeeded, ${failCount} failed.`);
} else {
  const success = await processFile(filePath);
  if (!success) {
    process.exit(1);
  }
}
