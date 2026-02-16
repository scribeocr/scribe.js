import fs from 'fs';
import path from 'path';
import { GoogleVisionModel } from '../../cloud-adapters/gcs-vision/RecognitionModelGoogleVision.js';

const args = process.argv.slice(2);
const splitMode = args.includes('--split');
const filePath = args.find((a) => !a.startsWith('--'));
const gcsBucketArg = args.find((a) => a.startsWith('--gcs-bucket='));
const gcsBucket = gcsBucketArg ? gcsBucketArg.split('=')[1] : process.env.GCS_BUCKET;

if (!filePath || !gcsBucket) {
  console.error('Usage: node runGoogleVisionAsync.js <file> --gcs-bucket=<bucket> [--split]');
  console.error('');
  console.error('  <file>               File to process');
  console.error('  --gcs-bucket=<name>  GCS bucket for async processing (or set GCS_BUCKET env var)');
  console.error('  --split              Write separate files per page instead of combining');
  process.exit(1);
}

const options = {
  gcsBucket,
};

const fileData = await fs.promises.readFile(filePath);
const fileExtension = path.extname(filePath).toLowerCase();
const result = await GoogleVisionModel.recognizeDocumentAsync(fileData, { ...options, fileExtension });

if (!result.success) {
  console.error('Error:', result.error);
  process.exit(1);
}

const parsedPath = path.parse(filePath);
const suffix = 'GoogleVision.json';

if (!splitMode) {
  const outputFileName = `${parsedPath.name}-${suffix}`;
  const outputPath = path.join(parsedPath.dir, outputFileName);
  console.log(`Writing combined result to ${outputPath}`);
  await fs.promises.writeFile(outputPath, JSON.stringify(GoogleVisionModel.combineGoogleVisionAsyncResponses(result.data), null, 2));
} else {
  for (let i = 0; i < result.data.length; i++) {
    const outputFileName = `${parsedPath.name}-p${i}-${suffix}`;
    const outputPath = path.join(parsedPath.dir, outputFileName);
    console.log(`Writing result to ${outputPath}`);
    await fs.promises.writeFile(outputPath, JSON.stringify(result.data[i], null, 2));
  }
}
