const fs = require('fs');
const path = require('path');

const devDir = path.resolve(__dirname);
const unicharsetDir = path.join(devDir, 'unicharset');
const fontcharsetDir = path.join(devDir, 'fontcharset');

const charSetLatinBase = new Set([...fs.readFileSync(path.join(devDir, 'charSetLatinBase.txt'), 'utf8').trim()]);
const charSetLatinExt = new Set([...fs.readFileSync(path.join(devDir, 'charSetLatinExt.txt'), 'utf8').trim()]);
const charSetCyrillic = new Set([...fs.readFileSync(path.join(devDir, 'charSetCyrillic.txt'), 'utf8').trim()]);
const charSetGreek = new Set([...fs.readFileSync(path.join(devDir, 'charSetGreek.txt'), 'utf8').trim()]);

const charSetLatin = new Set([...charSetLatinBase, ...charSetLatinExt]);
const charSetAll = new Set([...charSetLatin, ...charSetCyrillic, ...charSetGreek]);

// Build intersection of all font charsets (characters present in every font)
const fontFiles = fs.readdirSync(fontcharsetDir).filter((f) => f.endsWith('.txt'));
let fontChars = null;
for (const f of fontFiles) {
  const chars = new Set([...fs.readFileSync(path.join(fontcharsetDir, f), 'utf8')]);
  if (fontChars === null) {
    fontChars = chars;
  } else {
    for (const c of fontChars) {
      if (!chars.has(c)) fontChars.delete(c);
    }
  }
}

/**
 * Parse a Tesseract unicharset file and return the set of characters it contains.
 * Skips special entries (NULL, Joined, Broken).
 */
function parseUnicharset(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  const chars = new Set();
  // Line 0 is the count; lines 1+ are entries
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const firstField = line.split(' ')[0];
    // Skip special Tesseract entries
    if (firstField === 'NULL' || firstField === 'Joined' || firstField.startsWith('|')) continue;
    // firstField is the character (may be multi-codepoint for ligatures etc.)
    chars.add(firstField);
  }
  return chars;
}

function findMissing(chars, charSet) {
  const missing = [];
  for (const ch of chars) {
    const allCovered = [...ch].every((c) => charSet.has(c));
    if (!allCovered) {
      missing.push(ch);
    }
  }
  return missing;
}

function findMissingFromFonts(chars) {
  const missing = [];
  for (const ch of chars) {
    const allInFonts = [...ch].every((c) => fontChars.has(c));
    if (!allInFonts) {
      missing.push(ch);
    }
  }
  return missing;
}

const formatChar = (ch) => {
  const codepoints = [...ch].map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
  return `${ch} (${codepoints.join(' ')})`;
};

const files = fs.readdirSync(unicharsetDir)
  .filter((f) => f.endsWith('.unicharset'))
  .sort();

const rows = [];

for (const file of files) {
  const lang = file.replace('.unicharset', '');
  const chars = parseUnicharset(path.join(unicharsetDir, file));

  const missingFonts = findMissingFromFonts(chars);
  const missingLatin = findMissing(chars, charSetLatin);
  const missingAll = findMissing(chars, charSetAll);

  // Split missing into: not in fonts vs in fonts but not in charset
  const missingFromFonts = [];
  const missingFromCharset = [];
  for (const ch of missingAll) {
    const inFonts = [...ch].every((c) => fontChars.has(c));
    if (inFonts) {
      missingFromCharset.push(ch);
    } else {
      missingFromFonts.push(ch);
    }
  }

  rows.push({
    lang,
    total: chars.size,
    fontsSupported: missingFonts.length === 0,
    fontsMissingCount: missingFonts.length,
    latinSupported: missingLatin.length === 0,
    latinMissingCount: missingLatin.length,
    allSupported: missingAll.length === 0,
    allMissingCount: missingAll.length,
    missingFromFonts,
    missingFromCharset,
  });
}

// Build markdown table
const lines = [];
lines.push('# Unicharset Coverage Report');
lines.push('');
lines.push('- **Fonts**: characters present in all raw font files (intersection of `script/fontcharset/*.txt`). Equivalent to what the `prod/all/` subset contains for every font.');
lines.push('- **Latin**: `charSetLatinBase.txt` + `charSetLatinExt.txt` (used for `prod/latin/` fonts)');
lines.push('- **Latin+Cy+Gr**: Latin + `charSetCyrillic.txt` + `charSetGreek.txt` (the historical "all" subset; retained as a reference point)');
lines.push('');
lines.push('| Language | Total Chars | Fonts | Latin | Latin+Cy+Gr | Missing from Fonts | Missing from Charset |');
lines.push('|----------|-------------|-------|-------|-------------|--------------------|----------------------|');

const formatMissing = (arr) => {
  if (arr.length === 0) return '';
  if (arr.length < 10) return arr.map(formatChar).join(', ');
  return `${arr.length} chars`;
};

for (const row of rows) {
  const fontsStr = row.fontsSupported ? 'Yes' : `No (${row.fontsMissingCount})`;
  const latinStr = row.latinSupported ? 'Yes' : `No (${row.latinMissingCount})`;
  const allStr = row.allSupported ? 'Yes' : `No (${row.allMissingCount})`;
  const missingFontsStr = formatMissing(row.missingFromFonts);
  const missingCharsetStr = formatMissing(row.missingFromCharset);

  lines.push(`| ${row.lang} | ${row.total} | ${fontsStr} | ${latinStr} | ${allStr} | ${missingFontsStr} | ${missingCharsetStr} |`);
}

lines.push('');

const output = lines.join('\n');
const outputPath = path.join(devDir, 'unicharsetCoverage.md');
fs.writeFileSync(outputPath, output, 'utf8');
console.log(`Coverage report written to ${outputPath}`);
console.log('');
console.log(output);
