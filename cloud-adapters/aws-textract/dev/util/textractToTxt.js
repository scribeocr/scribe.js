import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Converts AWS Textract Layout JSON output to plain text format.
 * Each paragraph (LAYOUT_TEXT block) becomes a single line in the output.
 *
 * Usage: node textractToTxt.js <input-file.json> [output-file.txt]
 * If output file is not specified, it will use the input filename with .txt extension
 */

function convertTextractToTxt(textractData) {
  const blocks = textractData.Blocks;

  // Create a map of all blocks by ID for quick lookup
  const blockMap = new Map();
  blocks.forEach((block) => {
    blockMap.set(block.Id, block);
  });

  // Find all LAYOUT_TEXT blocks (these represent paragraphs)
  const layoutTextBlocks = blocks.filter((block) => block.BlockType === 'LAYOUT_TEXT');

  // // Sort by page number and vertical position
  // layoutTextBlocks.sort((a, b) => {
  //   const pageA = a.Page || 0;
  //   const pageB = b.Page || 0;
  //   if (pageA !== pageB) {
  //     return pageA - pageB;
  //   }
  //   // Sort by vertical position (Top of bounding box)
  //   const topA = a.Geometry?.BoundingBox?.Top || 0;
  //   const topB = b.Geometry?.BoundingBox?.Top || 0;
  //   return topA - topB;
  // });

  const paragraphs = [];

  // Process each LAYOUT_TEXT block
  for (const layoutBlock of layoutTextBlocks) {
    const lineTexts = [];

    // Get all child LINE blocks
    if (layoutBlock.Relationships) {
      for (const relationship of layoutBlock.Relationships) {
        if (relationship.Type === 'CHILD') {
          for (const childId of relationship.Ids) {
            const childBlock = blockMap.get(childId);
            if (childBlock && childBlock.BlockType === 'LINE' && childBlock.Text) {
              lineTexts.push({
                text: childBlock.Text,
                top: childBlock.Geometry?.BoundingBox?.Top || 0,
              });
            }
          }
        }
      }
    }

    // Sort lines by vertical position within the paragraph
    lineTexts.sort((a, b) => a.top - b.top);

    // Join all line texts with spaces to form a single paragraph line
    const paragraphText = lineTexts.map((item) => item.text).join(' ');

    if (paragraphText.trim()) {
      paragraphs.push(paragraphText);
    }
  }

  // Also include LAYOUT_TITLE blocks as separate lines
  const layoutTitleBlocks = blocks.filter((block) => block.BlockType === 'LAYOUT_TITLE');

  // layoutTitleBlocks.sort((a, b) => {
  //   const pageA = a.Page || 0;
  //   const pageB = b.Page || 0;
  //   if (pageA !== pageB) {
  //     return pageA - pageB;
  //   }
  //   const topA = a.Geometry?.BoundingBox?.Top || 0;
  //   const topB = b.Geometry?.BoundingBox?.Top || 0;
  //   return topA - topB;
  // });

  const titles = [];
  for (const titleBlock of layoutTitleBlocks) {
    const lineTexts = [];

    if (titleBlock.Relationships) {
      for (const relationship of titleBlock.Relationships) {
        if (relationship.Type === 'CHILD') {
          for (const childId of relationship.Ids) {
            const childBlock = blockMap.get(childId);
            if (childBlock && childBlock.BlockType === 'LINE' && childBlock.Text) {
              lineTexts.push({
                text: childBlock.Text,
                top: childBlock.Geometry?.BoundingBox?.Top || 0,
              });
            }
          }
        }
      }
    }

    // lineTexts.sort((a, b) => a.top - b.top);
    const titleText = lineTexts.map((item) => item.text).join(' ');

    if (titleText.trim()) {
      titles.push({
        text: titleText,
        top: titleBlock.Geometry?.BoundingBox?.Top || 0,
        page: titleBlock.Page || 0,
      });
    }
  }

  // Combine titles and paragraphs, sorted by page and position
  const allBlocks = [
    ...titles.map((t) => ({
      type: 'title', text: t.text, top: t.top, page: t.page,
    })),
    ...paragraphs.map((p, i) => {
      const layoutBlock = layoutTextBlocks[i];
      return {
        type: 'paragraph',
        text: p,
        top: layoutBlock.Geometry?.BoundingBox?.Top || 0,
        page: layoutBlock.Page || 0,
      };
    }),
  ];

  allBlocks.sort((a, b) => {
    if (a.page !== b.page) {
      return a.page - b.page;
    }
    return a.top - b.top;
  });

  return allBlocks.map((block) => block.text).join('\n');
}

// Main execution
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: node textractToTxt.js <input-file.json> [output-file.txt]');
  console.error('Example: node textractToTxt.js ../assets/document-AwsTextractLayout.json output.txt');
  process.exit(1);
}

const inputPath = args[0];
const outputPath = args[1] || inputPath.replace(/\.json$/i, '.txt');

if (!fs.existsSync(inputPath)) {
  console.error(`Error: Input file not found: ${inputPath}`);
  process.exit(1);
}

console.log(`Reading AWS Textract output from: ${inputPath}`);
const textractData = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

const txtOutput = convertTextractToTxt(textractData);

console.log(`Writing text output to: ${outputPath}`);
fs.writeFileSync(outputPath, txtOutput, 'utf8');

console.log(`Conversion complete! Output written to ${outputPath}`);
console.log(`Total lines (paragraphs): ${txtOutput.split('\n').length}`);
