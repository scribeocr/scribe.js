import fs from 'fs';
import path from 'path';
import { OcrEngineAWSTextract } from '../../cloud-adapters/aws-textract/ocrEngineAwsTextract.js';

const args = process.argv.slice(2);
const dirMode = args.includes('--dir');
const splitMode = args.includes('--split');
const filePath = args.find((a) => !a.startsWith('--'));
const s3BucketArg = args.find((a) => a.startsWith('--s3-bucket='));
const s3Bucket = s3BucketArg ? s3BucketArg.split('=')[1] : process.env.AWS_S3_BUCKET;

if (!filePath || !s3Bucket) {
  console.error('Usage: node runAwsTextractAsync.js <file-or-directory> --s3-bucket=<bucket> [--dir] [--layout] [--tables] [--split]');
  console.error('');
  console.error('  <file-or-directory>  File or directory to process');
  console.error('  --s3-bucket=<name>   S3 bucket for async processing (or set AWS_S3_BUCKET env var)');
  console.error('  --dir                Treat the path as a directory and process all supported files');
  console.error('  --layout             Enable layout analysis');
  console.error('  --tables             Enable table analysis');
  console.error('  --split              Write separate files per page instead of combining');
  process.exit(1);
}

const options = {
  analyzeLayout: args.includes('--layout'),
  analyzeLayoutTables: args.includes('--tables'),
  s3Bucket,
  processDirectory: dirMode,
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

  if (!splitMode) {
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
