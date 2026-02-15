import fs from 'fs';
import path from 'path';
import { OcrEngineGoogleDocAI } from '../../cloud-adapters/gcs-doc-ai/ocrEngineGoogleDocAI.js';

const args = process.argv.slice(2);
const dirMode = args.includes('--dir');
const filePath = args.find((a) => !a.startsWith('--'));
const gcsBucketArg = args.find((a) => a.startsWith('--gcs-bucket='));
const gcsBucket = gcsBucketArg ? gcsBucketArg.split('=')[1] : process.env.GCS_BUCKET;

if (!filePath || !gcsBucket) {
  console.error('Usage: node runGoogleDocAIAsync.js <file-or-directory> --gcs-bucket=<bucket> [--dir]');
  console.error('');
  console.error('  <file>               File or directory to process');
  console.error('  --gcs-bucket=<name>  GCS bucket for async processing (or set GCS_BUCKET env var)');
  console.error('  --dir                Treat the path as a directory and process all supported files');
  console.error('');
  console.error('Environment variables:');
  console.error('  GOOGLE_DOC_AI_PROCESSOR  (required) Full resource name of a Document AI processor.');
  console.error('    This is found in the Google Cloud Console under Document AI > Processors > processor details.');
  console.error('    Format: projects/{project-id}/locations/{location}/processors/{processor-id}');
  console.error('    Example: projects/my-project-123/locations/us/processors/a1b2c3d4e5f6');
  console.error('');
  console.error('  GCS_BUCKET  GCS bucket name (alternative to --gcs-bucket flag)');
  console.error('');
  console.error('  Google Application Default Credentials must also be configured.');
  console.error('  Set GOOGLE_APPLICATION_CREDENTIALS to a service account key file path,');
  console.error('  or run: gcloud auth application-default login');
  process.exit(1);
}

const SUPPORTED_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.gif', '.webp'];

async function processFile(inputPath) {
  console.log(`Processing: ${inputPath}`);
  const result = await OcrEngineGoogleDocAI.recognizeFileAsync(inputPath, { gcsBucket });

  if (!result.success) {
    console.error(`Error processing ${inputPath}:`, result.error);
    return false;
  }

  const parsedPath = path.parse(inputPath);
  const outputFileName = `${parsedPath.name}-GoogleDocAI.json`;
  const outputPath = path.join(parsedPath.dir, outputFileName);
  console.log(`Writing result to ${outputPath}`);
  await fs.promises.writeFile(outputPath, JSON.stringify(result.data, null, 2));
  return true;
}

const stat = await fs.promises.stat(filePath);

if (stat.isDirectory()) {
  if (!dirMode) {
    console.error('Input is a directory. Pass --dir to process all files in it.');
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
