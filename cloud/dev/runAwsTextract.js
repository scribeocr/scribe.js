#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { OcrEngineTextract } from './awsTextract.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1 || args[0] === '-h' || args[0] === '--help') {
    console.error('Usage: ./awsTextract.js <imagePath> [--layout] [--tables]');
    process.exit(1);
  }

  const imagePath = args[0];
  const analyzeLayout = args.includes('--layout') || args.includes('--tables');
  const analyzeLayoutTables = args.includes('--tables');

  try {
    const bytes = await readFile(imagePath);
    const result = await OcrEngineTextract.recognizeImage(bytes, {
      analyzeLayout,
      analyzeLayoutTables,
    });

    if (!result.success) {
      console.error(`Error (${result.errorCode || 'Unknown'}): ${result.error || 'Failed'}`);
      process.exit(2);
    }

    console.log(JSON.stringify(result.data, null, 2));
  } catch (err) {
    console.error(`Unexpected error: ${err.message || err}`);
    process.exit(99);
  }
}

main();
