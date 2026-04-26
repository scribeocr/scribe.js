import { inflateRaw } from './pako-inflate.js';
import { parseCFFTable, makeCFFTable } from './cff.js';
import { parseType1Font } from './type1.js';
import {
  parse, check, table, Parser, encode, decode, eightBitMacEncodings,
} from './types.js';
import {
  Font, GlyphSet, ttfGlyphLoader,
} from './font.js';
import { Glyph } from './glyph.js';
import {
  CmapEncoding, addGlyphNames, standardNames,
} from './encoding.js';
import { BoundingBox, Path } from './path.js';

// --- cmap table ---
// The `cmap` table stores the mappings from characters to glyphs.
// https://www.microsoft.com/typography/OTSPEC/cmap.htm

function parseCmapTableFormat0(cmap, p, platformID, encodingID) {
  // Length in bytes of the index map
  cmap.length = p.parseUShort();
  // see https://developer.apple.com/fonts/TrueType-Reference-Manual/RM06/Chap6name.html
  // section "Macintosh Language Codes"
  cmap.language = p.parseUShort() - 1;

  const indexMap = p.parseByteList(cmap.length);
  const glyphIndexMap = { ...indexMap };
  const encoding = getEncoding(platformID, encodingID, cmap.language);
  const decodingTable = eightBitMacEncodings[encoding];
  for (let i = 0; i < decodingTable.length; i++) {
    glyphIndexMap[decodingTable.charCodeAt(i)] = indexMap[0x80 + i];
  }
  cmap.glyphIndexMap = glyphIndexMap;
}

function parseCmapTableFormat12or13(cmap, p, format) {
  // Skip reserved.
  p.parseUShort();

  // Length in bytes of the sub-tables.
  cmap.length = p.parseULong();
  cmap.language = p.parseULong();

  let groupCount;
  cmap.groupCount = groupCount = p.parseULong();
  cmap.glyphIndexMap = {};

  for (let i = 0; i < groupCount; i += 1) {
    const startCharCode = p.parseULong();
    const endCharCode = p.parseULong();
    let startGlyphId = p.parseULong();

    for (let c = startCharCode; c <= endCharCode; c += 1) {
      cmap.glyphIndexMap[c] = startGlyphId;
      if (format === 12) {
        startGlyphId++;
      }
    }
  }
}

function parseCmapTableFormat4(cmap, p, data, start, offset) {
  // Length in bytes of the sub-tables.
  cmap.length = p.parseUShort();
  cmap.language = p.parseUShort();

  // segCount is stored x 2.
  let segCount;
  cmap.segCount = segCount = p.parseUShort() >> 1;

  // Skip searchRange, entrySelector, rangeShift.
  p.skip('uShort', 3);

  // The "unrolled" mapping from character codes to glyph indices.
  cmap.glyphIndexMap = {};
  const endCountParser = new parse.Parser(data, start + offset + 14);
  const startCountParser = new parse.Parser(data, start + offset + 16 + segCount * 2);
  const idDeltaParser = new parse.Parser(data, start + offset + 16 + segCount * 4);
  const idRangeOffsetParser = new parse.Parser(data, start + offset + 16 + segCount * 6);
  let glyphIndexOffset = start + offset + 16 + segCount * 8;
  for (let i = 0; i < segCount - 1; i += 1) {
    let glyphIndex;
    const endCount = endCountParser.parseUShort();
    const startCount = startCountParser.parseUShort();
    const idDelta = idDeltaParser.parseShort();
    const idRangeOffset = idRangeOffsetParser.parseUShort();
    for (let c = startCount; c <= endCount; c += 1) {
      if (idRangeOffset !== 0) {
        // The idRangeOffset is relative to the current position in the idRangeOffset array.
        // Take the current offset in the idRangeOffset array.
        glyphIndexOffset = (idRangeOffsetParser.offset + idRangeOffsetParser.relativeOffset - 2);

        // Add the value of the idRangeOffset, which will move us into the glyphIndex array.
        glyphIndexOffset += idRangeOffset;

        // Then add the character index of the current segment, multiplied by 2 for USHORTs.
        glyphIndexOffset += (c - startCount) * 2;
        glyphIndex = parse.getUShort(data, glyphIndexOffset);
        if (glyphIndex !== 0) {
          glyphIndex = (glyphIndex + idDelta) & 0xFFFF;
        }
      } else {
        glyphIndex = (c + idDelta) & 0xFFFF;
      }

      cmap.glyphIndexMap[c] = glyphIndex;
    }
  }
}

function parseCmapTableFormat6(cmap, p, platformID, encodingID) {
  cmap.length = p.parseUShort();
  cmap.language = p.parseUShort();
  const firstCode = p.parseUShort();
  const entryCount = p.parseUShort();
  const glyphIndexMap = {};
  for (let i = 0; i < entryCount; i++) {
    glyphIndexMap[firstCode + i] = p.parseUShort();
  }
  // Apply Mac encoding conversion for 0x80+ chars (same approach as format 0)
  if (platformID === 1) {
    const encoding = getEncoding(platformID, encodingID, cmap.language);
    const decodingTable = eightBitMacEncodings[encoding];
    if (decodingTable) {
      for (let i = 0; i < decodingTable.length; i++) {
        const macCharCode = 0x80 + i;
        if (glyphIndexMap[macCharCode] !== undefined) {
          glyphIndexMap[decodingTable.charCodeAt(i)] = glyphIndexMap[macCharCode];
        }
      }
    }
  }
  cmap.glyphIndexMap = glyphIndexMap;
}

// Parse the `cmap` table. This table stores the mappings from characters to glyphs.
// This function returns a `CmapEncoding` object or null if no supported format could be found.
export function parseCmapTable(data, start) {
  const cmap = {};
  cmap.version = parse.getUShort(data, start);
  check.argument(cmap.version === 0, 'cmap table version should be 0.');

  // The cmap table can contain many sub-tables, each with their own format.
  cmap.numTables = parse.getUShort(data, start + 2);
  let format14Parser = null;
  let format14offset = -1;
  let offset = -1;
  let platformId = null;
  let encodingId = null;
  const platform0Encodings = [0, 1, 2, 3, 4, 6];
  const platform3Encodings = [0, 1, 10];
  // Priority: platform 3/0 (Unicode/Windows) > platform 1 (Mac).
  // A platform-1-only font should still work, but a Unicode subtable always wins.
  let bestPriority = -1; // 0 = Mac, 1 = platform 0, 2 = platform 3
  for (let i = cmap.numTables - 1; i >= 0; i -= 1) {
    const curPlatformId = parse.getUShort(data, start + 4 + (i * 8));
    const curEncodingId = parse.getUShort(data, start + 4 + (i * 8) + 2);
    if ((curPlatformId === 3 && platform3Encodings.includes(curEncodingId))
            || (curPlatformId === 0 && platform0Encodings.includes(curEncodingId))
            || (curPlatformId === 1 && curEncodingId === 0) // MacOS <= 9
    ) {
      const priority = curPlatformId === 3 ? 2 : curPlatformId === 0 ? 1 : 0;
      if (priority < bestPriority) continue;
      if (priority === bestPriority && offset > 0) continue;
      offset = parse.getULong(data, start + 4 + (i * 8) + 4);
      platformId = curPlatformId;
      encodingId = curEncodingId;
      bestPriority = priority;
      // allow for early break
      if (format14Parser && bestPriority >= 1) {
        break;
      }
    } else if (curPlatformId === 0 && curEncodingId === 5) {
      format14offset = parse.getULong(data, start + 4 + (i * 8) + 4);
      format14Parser = new parse.Parser(data, start + format14offset);
      if (format14Parser.parseUShort() !== 14) {
        format14offset = -1;
        format14Parser = null;
      } else if (offset > 0 && bestPriority >= 1) {
        // we already got the regular table, early break
        break;
      }
    }
  }

  if (offset === -1) {
    // There is no cmap table in the font that we support.
    throw new Error('No valid cmap sub-tables found.');
  }

  cmap.platformID = platformId;
  cmap.encodingID = encodingId;

  const p = new parse.Parser(data, start + offset);
  cmap.format = p.parseUShort();

  if (cmap.format === 0) {
    parseCmapTableFormat0(cmap, p, platformId, encodingId);
  } else if (cmap.format === 12 || cmap.format === 13) {
    parseCmapTableFormat12or13(cmap, p, cmap.format);
  } else if (cmap.format === 4) {
    parseCmapTableFormat4(cmap, p, data, start, offset);
  } else if (cmap.format === 6) {
    parseCmapTableFormat6(cmap, p, platformId, encodingId);
  } else {
    throw new Error(
      'Only format 0, 4, 6, 12 and 14 cmap tables are supported '
            + `(found format ${cmap.format}, platformId ${platformId}, encodingId ${encodingId}).`,
    );
  }

  return cmap;
}

function writeUint16(d, pos, v) {
  d[pos] = (v >> 8) & 0xFF;
  d[pos + 1] = v & 0xFF;
}

function writeInt16(d, pos, v) {
  if (v < 0) {
    v += 0x10000;
  }
  d[pos] = (v >> 8) & 0xFF;
  d[pos + 1] = v & 0xFF;
}

function writeUint32(d, pos, v) {
  d[pos] = (v >> 24) & 0xFF;
  d[pos + 1] = (v >> 16) & 0xFF;
  d[pos + 2] = (v >> 8) & 0xFF;
  d[pos + 3] = v & 0xFF;
}

// Make cmap table, format 4 by default, 12 if needed only
export function makeCmapTable(glyphs) {
  // Plan 0 is the base Unicode Plan but emojis, for example are on another plan, and needs cmap 12 format (with 32bit)
  let isPlan0Only = true;
  let i;

  // Check if we need to add cmap format 12 or if format 4 only is fine
  for (i = glyphs.length - 1; i > 0; i -= 1) {
    const g = glyphs.get(i);
    if (g.unicode > 65535) {
      console.log('Adding CMAP format 12 (needed!)');
      isPlan0Only = false;
      break;
    }
  }

  // Build segments (same logic as before).
  const segments = [];
  for (i = 0; i < glyphs.length; i += 1) {
    const glyph = glyphs.get(i);
    for (let j = 0; j < glyph.unicodes.length; j += 1) {
      segments.push({
        end: glyph.unicodes[j],
        start: glyph.unicodes[j],
        delta: -(glyph.unicodes[j] - i),
        offset: 0,
        glyphIndex: i,
      });
    }
  }

  segments.sort((a, b) => a.start - b.start);

  // Add terminator segment.
  segments.push({
    end: 0xFFFF,
    start: 0xFFFF,
    delta: 1,
    offset: 0,
  });

  // Separate CMAP 4 segments (BMP only) from CMAP 12 groups.
  const cmap4Segments = [];
  const cmap12Groups = [];
  let glyphIdCount = 0;

  for (i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (seg.end <= 65535 && seg.start <= 65535) {
      cmap4Segments.push(seg);
      if (seg.glyphId !== undefined) {
        glyphIdCount += 1;
      }
    }
    // CMAP 12: skip terminator segment.
    if (!isPlan0Only && seg.glyphIndex !== undefined) {
      cmap12Groups.push(seg);
    }
  }

  const segCount4 = cmap4Segments.length;

  // CMAP 4 header values.
  const segCountX2 = segCount4 * 2;
  const searchRange = 2 ** Math.floor(Math.log(segCount4) / Math.log(2)) * 2;
  const entrySelector = Math.log(searchRange / 2) / Math.log(2);
  const rangeShift = segCountX2 - searchRange;

  // CMAP 4 subtable size: header (14) + 4 arrays (2 * segCount4 each) + reservedPad (2) + glyphIds (2 * glyphIdCount)
  const cmap4Length = 14 + segCount4 * 2 * 4 + 2 + glyphIdCount * 2;

  // Encoding record sizes.
  const numEncodingRecords = isPlan0Only ? 1 : 2;
  const headerSize = 4 + numEncodingRecords * 8; // version(2) + numTables(2) + records(8 each)
  const cmap4Offset = headerSize;

  // CMAP 12 subtable.
  const nGroups12 = cmap12Groups.length;
  const cmap12Length = !isPlan0Only ? (16 + nGroups12 * 12) : 0;
  const cmap12Offset = cmap4Offset + cmap4Length;

  const totalSize = headerSize + cmap4Length + cmap12Length;
  const d = new Array(totalSize);

  // Write cmap table header.
  let p = 0;
  writeUint16(d, p, 0); p += 2; // version
  writeUint16(d, p, numEncodingRecords); p += 2; // numTables

  // Encoding record 1: format 4 (platform 3, encoding 1).
  writeUint16(d, p, 3); p += 2; // platformID
  writeUint16(d, p, 1); p += 2; // encodingID
  writeUint32(d, p, cmap4Offset); p += 4; // offset

  if (!isPlan0Only) {
    // Encoding record 2: format 12 (platform 3, encoding 10).
    writeUint16(d, p, 3); p += 2;
    writeUint16(d, p, 10); p += 2;
    writeUint32(d, p, cmap12Offset); p += 4;
  }

  // Write CMAP 4 subtable.
  writeUint16(d, p, 4); p += 2; // format
  writeUint16(d, p, cmap4Length); p += 2; // length
  writeUint16(d, p, 0); p += 2; // language
  writeUint16(d, p, segCountX2); p += 2;
  writeUint16(d, p, searchRange); p += 2;
  writeUint16(d, p, entrySelector); p += 2;
  writeUint16(d, p, rangeShift); p += 2;

  // endCounts
  for (i = 0; i < segCount4; i += 1) {
    writeUint16(d, p, cmap4Segments[i].end); p += 2;
  }

  // reservedPad
  writeUint16(d, p, 0); p += 2;

  // startCounts
  for (i = 0; i < segCount4; i += 1) {
    writeUint16(d, p, cmap4Segments[i].start); p += 2;
  }

  // idDeltas
  for (i = 0; i < segCount4; i += 1) {
    writeInt16(d, p, cmap4Segments[i].delta); p += 2;
  }

  // idRangeOffsets
  for (i = 0; i < segCount4; i += 1) {
    writeUint16(d, p, cmap4Segments[i].offset); p += 2;
  }

  // glyphIds
  for (i = 0; i < segCount4; i += 1) {
    if (cmap4Segments[i].glyphId !== undefined) {
      writeUint16(d, p, cmap4Segments[i].glyphId); p += 2;
    }
  }

  // Write CMAP 12 subtable.
  if (!isPlan0Only) {
    writeUint16(d, p, 12); p += 2; // format
    writeUint16(d, p, 0); p += 2; // reserved
    writeUint32(d, p, cmap12Length); p += 4; // length
    writeUint32(d, p, 0); p += 4; // language
    writeUint32(d, p, nGroups12); p += 4; // nGroups

    for (i = 0; i < nGroups12; i += 1) {
      writeUint32(d, p, cmap12Groups[i].start); p += 4;
      writeUint32(d, p, cmap12Groups[i].end); p += 4;
      writeUint32(d, p, cmap12Groups[i].glyphIndex); p += 4;
    }
  }

  return new table.Table('cmap', [
    { name: 'data', type: 'LITERAL', value: d },
  ]);
}

// --- colr table ---
// The `COLR` table adds support for multi-colored glyphs
// https://www.microsoft.com/typography/OTSPEC/colr.htm

export function parseColrTable(data, start) {
  const p = new Parser(data, start);
  const version = p.parseUShort();
  check.argument(version === 0x0000, 'Only COLRv0 supported.');
  const numBaseGlyphRecords = p.parseUShort();
  const baseGlyphRecordsOffset = p.parseOffset32();
  const layerRecordsOffset = p.parseOffset32();
  const numLayerRecords = p.parseUShort();
  p.relativeOffset = baseGlyphRecordsOffset;
  const baseGlyphRecords = p.parseRecordList(numBaseGlyphRecords, {
    glyphID: Parser.uShort,
    firstLayerIndex: Parser.uShort,
    numLayers: Parser.uShort,
  });
  p.relativeOffset = layerRecordsOffset;
  const layerRecords = p.parseRecordList(numLayerRecords, {
    glyphID: Parser.uShort,
    paletteIndex: Parser.uShort,
  });
  return { version, baseGlyphRecords, layerRecords };
}

export function makeColrTable({ version = 0x0000, baseGlyphRecords = [], layerRecords = [] }) {
  check.argument(version === 0x0000, 'Only COLRv0 supported.');
  const baseGlyphRecordsOffset = 14;
  const layerRecordsOffset = baseGlyphRecordsOffset + (baseGlyphRecords.length * 6);
  const totalSize = 14 + baseGlyphRecords.length * 6 + layerRecords.length * 4;
  const d = new Array(totalSize);
  let p = 0;
  writeUint16(d, p, version); p += 2;
  writeUint16(d, p, baseGlyphRecords.length); p += 2;
  writeUint32(d, p, baseGlyphRecordsOffset); p += 4;
  writeUint32(d, p, layerRecordsOffset); p += 4;
  writeUint16(d, p, layerRecords.length); p += 2;
  for (let i = 0; i < baseGlyphRecords.length; i++) {
    writeUint16(d, p, baseGlyphRecords[i].glyphID); p += 2;
    writeUint16(d, p, baseGlyphRecords[i].firstLayerIndex); p += 2;
    writeUint16(d, p, baseGlyphRecords[i].numLayers); p += 2;
  }
  for (let i = 0; i < layerRecords.length; i++) {
    writeUint16(d, p, layerRecords[i].glyphID); p += 2;
    writeUint16(d, p, layerRecords[i].paletteIndex); p += 2;
  }
  return new table.Table('COLR', [
    { name: 'data', type: 'LITERAL', value: d },
  ]);
}

// --- cpal table ---
// The `CPAL` define a contiguous list of colors (colorRecords)
// Theses colors must be index by at least one default (0) palette (colorRecordIndices)
// every palettes share the same size (numPaletteEntries) and can overlap to refere the same colors
// https://www.microsoft.com/typography/OTSPEC/cpal.htm

export function parseCpalTable(data, start) {
  const p = new Parser(data, start);
  const version = p.parseShort();
  const numPaletteEntries = p.parseShort();
  const numPalettes = p.parseShort();
  const numColorRecords = p.parseShort();
  const colorRecordsArrayOffset = p.parseOffset32();
  const colorRecordIndices = p.parseUShortList(numPalettes);
  p.relativeOffset = colorRecordsArrayOffset;
  const colorRecords = p.parseULongList(numColorRecords);
  return {
    version, numPaletteEntries, colorRecords, colorRecordIndices,
  };
}

export function makeCpalTable({
  version = 0, numPaletteEntries = 0, colorRecords = [], colorRecordIndices = [0],
}) {
  check.argument(version === 0, 'Only CPALv0 are supported.');
  check.argument(colorRecords.length, 'No colorRecords given.');
  check.argument(colorRecordIndices.length, 'No colorRecordIndices given.');
  if (colorRecordIndices.length > 1) {
    check.argument(numPaletteEntries, 'Can\'t infer numPaletteEntries on multiple colorRecordIndices');
  }
  const totalSize = 12 + colorRecordIndices.length * 2 + colorRecords.length * 4;
  const d = new Array(totalSize);
  let p = 0;
  writeUint16(d, p, version); p += 2;
  writeUint16(d, p, numPaletteEntries || colorRecords.length); p += 2;
  writeUint16(d, p, colorRecordIndices.length); p += 2;
  writeUint16(d, p, colorRecords.length); p += 2;
  writeUint32(d, p, 12 + 2 * colorRecordIndices.length); p += 4;
  for (let i = 0; i < colorRecordIndices.length; i++) {
    writeUint16(d, p, colorRecordIndices[i]); p += 2;
  }
  for (let i = 0; i < colorRecords.length; i++) {
    writeUint32(d, p, colorRecords[i]); p += 4;
  }
  return new table.Table('CPAL', [
    { name: 'data', type: 'LITERAL', value: d },
  ]);
}

// --- glyf table ---
// The `glyf` table describes the glyphs in TrueType outline format.
// http://www.microsoft.com/typography/otspec/glyf.htm

// Parse the coordinate data for a glyph.
function parseGlyphCoordinate(p, flag, previousValue, shortVectorBitMask, sameBitMask) {
  let v;
  if ((flag & shortVectorBitMask) > 0) {
    // The coordinate is 1 byte long.
    v = p.parseByte();
    // The `same` bit is re-used for short values to signify the sign of the value.
    if ((flag & sameBitMask) === 0) {
      v = -v;
    }

    v = previousValue + v;
  } else {
    //  The coordinate is 2 bytes long.
    // If the `same` bit is set, the coordinate is the same as the previous coordinate.
    if ((flag & sameBitMask) > 0) {
      v = previousValue;
    } else {
      // Parse the coordinate as a signed 16-bit delta value.
      v = previousValue + p.parseShort();
    }
  }

  return v;
}

// Parse a TrueType glyph.
function parseGlyph(glyph, data, start) {
  const p = new parse.Parser(data, start);
  glyph.numberOfContours = p.parseShort();
  glyph._xMin = p.parseShort();
  glyph._yMin = p.parseShort();
  glyph._xMax = p.parseShort();
  glyph._yMax = p.parseShort();
  let flags;
  let flag;

  if (glyph.numberOfContours > 0) {
    // This glyph is not a composite.
    const endPointIndices = glyph.endPointIndices = [];
    for (let i = 0; i < glyph.numberOfContours; i += 1) {
      endPointIndices.push(p.parseUShort());
    }

    glyph.instructionLength = p.parseUShort();
    glyph.instructions = [];
    for (let i = 0; i < glyph.instructionLength; i += 1) {
      glyph.instructions.push(p.parseByte());
    }

    const numberOfCoordinates = endPointIndices[endPointIndices.length - 1] + 1;
    flags = [];
    for (let i = 0; i < numberOfCoordinates; i += 1) {
      flag = p.parseByte();
      flags.push(flag);
      // If bit 3 is set, we repeat this flag n times, where n is the next byte.
      if ((flag & 8) > 0) {
        const repeatCount = p.parseByte();
        for (let j = 0; j < repeatCount; j += 1) {
          flags.push(flag);
          i += 1;
        }
      }
    }

    check.argument(flags.length === numberOfCoordinates, 'Bad flags.');

    if (endPointIndices.length > 0) {
      const points = [];
      let point;
      // X/Y coordinates are relative to the previous point, except for the first point which is relative to 0,0.
      if (numberOfCoordinates > 0) {
        for (let i = 0; i < numberOfCoordinates; i += 1) {
          flag = flags[i];
          point = {};
          point.onCurve = !!(flag & 1);
          point.lastPointOfContour = endPointIndices.indexOf(i) >= 0;
          points.push(point);
        }

        let px = 0;
        for (let i = 0; i < numberOfCoordinates; i += 1) {
          flag = flags[i];
          point = points[i];
          point.x = parseGlyphCoordinate(p, flag, px, 2, 16);
          px = point.x;
        }

        let py = 0;
        for (let i = 0; i < numberOfCoordinates; i += 1) {
          flag = flags[i];
          point = points[i];
          point.y = parseGlyphCoordinate(p, flag, py, 4, 32);
          py = point.y;
        }
      }

      glyph.points = points;
    } else {
      glyph.points = [];
    }
  } else if (glyph.numberOfContours === 0) {
    glyph.points = [];
  } else {
    glyph.isComposite = true;
    glyph.points = [];
    glyph.components = [];
    let moreComponents = true;
    while (moreComponents) {
      flags = p.parseUShort();
      const component = {
        glyphIndex: p.parseUShort(),
        xScale: 1,
        scale01: 0,
        scale10: 0,
        yScale: 1,
        dx: 0,
        dy: 0,
      };
      if ((flags & 1) > 0) {
        // The arguments are words
        if ((flags & 2) > 0) {
          // values are offset
          component.dx = p.parseShort();
          component.dy = p.parseShort();
        } else {
          // values are matched points
          component.matchedPoints = [p.parseUShort(), p.parseUShort()];
        }
      } else {
        // The arguments are bytes
        if ((flags & 2) > 0) {
          // values are offset
          component.dx = p.parseChar();
          component.dy = p.parseChar();
        } else {
          // values are matched points
          component.matchedPoints = [p.parseByte(), p.parseByte()];
        }
      }

      if ((flags & 8) > 0) {
        // We have a scale
        component.xScale = component.yScale = p.parseF2Dot14();
      } else if ((flags & 64) > 0) {
        // We have an X / Y scale
        component.xScale = p.parseF2Dot14();
        component.yScale = p.parseF2Dot14();
      } else if ((flags & 128) > 0) {
        // We have a 2x2 transformation
        component.xScale = p.parseF2Dot14();
        component.scale01 = p.parseF2Dot14();
        component.scale10 = p.parseF2Dot14();
        component.yScale = p.parseF2Dot14();
      }

      component.flags = flags;
      glyph.components.push(component);
      moreComponents = !!(flags & 32);
    }
    if (flags & 0x100) {
      // We have instructions
      glyph.instructionLength = p.parseUShort();
      glyph.instructions = [];
      for (let i = 0; i < glyph.instructionLength; i += 1) {
        glyph.instructions.push(p.parseByte());
      }
    }
  }
}

// Transform an array of points and return a new array.
function transformPoints(points, transform) {
  const newPoints = [];
  for (let i = 0; i < points.length; i += 1) {
    const pt = points[i];
    const newPt = {
      x: transform.xScale * pt.x + transform.scale01 * pt.y + transform.dx,
      y: transform.scale10 * pt.x + transform.yScale * pt.y + transform.dy,
      onCurve: pt.onCurve,
      lastPointOfContour: pt.lastPointOfContour,
    };
    newPoints.push(newPt);
  }

  return newPoints;
}

function getContours(points) {
  const contours = [];
  let currentContour = [];
  for (let i = 0; i < points.length; i += 1) {
    const pt = points[i];
    currentContour.push(pt);
    if (pt.lastPointOfContour) {
      contours.push(currentContour);
      currentContour = [];
    }
  }

  check.argument(currentContour.length === 0, 'There are still points left in the current contour.');
  return contours;
}

// Convert the TrueType glyph outline to a Path.
export function getPath(points) {
  const p = new Path();
  if (!points) {
    return p;
  }

  const contours = getContours(points);

  for (let contourIndex = 0; contourIndex < contours.length; ++contourIndex) {
    const contour = contours[contourIndex];

    let curr = contour[contour.length - 1];
    let next = contour[0];

    if (curr.onCurve) {
      p.moveTo(curr.x, curr.y);
    } else if (next.onCurve) {
      p.moveTo(next.x, next.y);
    } else {
      // If both first and last points are off-curve, start at their middle.
      const start = { x: (curr.x + next.x) * 0.5, y: (curr.y + next.y) * 0.5 };
      p.moveTo(start.x, start.y);
    }

    for (let i = 0; i < contour.length; ++i) {
      curr = next;
      next = contour[(i + 1) % contour.length];

      if (curr.onCurve) {
        // This is a straight line.
        p.lineTo(curr.x, curr.y);
      } else {
        let next2 = next;

        if (!next.onCurve) {
          next2 = { x: (curr.x + next.x) * 0.5, y: (curr.y + next.y) * 0.5 };
        }

        p.quadraticCurveTo(curr.x, curr.y, next2.x, next2.y);
      }
    }

    p.closePath();
  }
  return p;
}

function buildPath(glyphs, glyph) {
  if (glyph.isComposite) {
    for (let j = 0; j < glyph.components.length; j += 1) {
      const component = glyph.components[j];
      const componentGlyph = glyphs.get(component.glyphIndex);
      // Force the ttfGlyphLoader to parse the glyph.
      componentGlyph.getPath();
      if (componentGlyph.points) {
        let transformedPoints;
        if (component.matchedPoints === undefined) {
          // component positioned by offset
          transformedPoints = transformPoints(componentGlyph.points, component);
        } else {
          // component positioned by matched points
          if ((component.matchedPoints[0] > glyph.points.length - 1)
                        || (component.matchedPoints[1] > componentGlyph.points.length - 1)) {
            throw Error(`Matched points out of range in ${glyph.name}`);
          }
          const firstPt = glyph.points[component.matchedPoints[0]];
          let secondPt = componentGlyph.points[component.matchedPoints[1]];
          const transform = {
            xScale: component.xScale,
            scale01: component.scale01,
            scale10: component.scale10,
            yScale: component.yScale,
            dx: 0,
            dy: 0,
          };
          secondPt = transformPoints([secondPt], transform)[0];
          transform.dx = firstPt.x - secondPt.x;
          transform.dy = firstPt.y - secondPt.y;
          transformedPoints = transformPoints(componentGlyph.points, transform);
        }
        glyph.points = glyph.points.concat(transformedPoints);
      }
    }
  }

  return getPath(glyph.points);
}

// Parse all the glyphs according to the offsets from the `loca` table.
export function parseGlyfTable(data, start, loca, font) {
  const glyphs = new GlyphSet(font);

  // The last element of the loca table is invalid.
  for (let i = 0; i < loca.length - 1; i += 1) {
    const offset = loca[i];
    const nextOffset = loca[i + 1];
    if (offset !== nextOffset) {
      glyphs.push(i, ttfGlyphLoader(font, i, parseGlyph, data, start + offset, buildPath));
    } else {
      glyphs.push(i, new Glyph({ index: i, font }));
    }
  }

  return glyphs;
}

// --- gpos table ---
// The `GPOS` table contains kerning pairs, among other things.
// https://docs.microsoft.com/en-us/typography/opentype/spec/gpos

const gposSubtableParsers = new Array(10); // gposSubtableParsers[0] is unused

// https://docs.microsoft.com/en-us/typography/opentype/spec/gpos#lookup-type-1-single-adjustment-positioning-subtable
// this = Parser instance
gposSubtableParsers[1] = function parseLookup1() {
  const start = this.offset + this.relativeOffset;
  const posformat = this.parseUShort();
  if (posformat === 1) {
    return {
      posFormat: 1,
      coverage: this.parsePointer(Parser.coverage),
      value: this.parseValueRecord(),
    };
  } if (posformat === 2) {
    return {
      posFormat: 2,
      coverage: this.parsePointer(Parser.coverage),
      values: this.parseValueRecordList(),
    };
  }
  check.assert(false, `0x${start.toString(16)}: GPOS lookup type 1 format must be 1 or 2.`);
};

// https://docs.microsoft.com/en-us/typography/opentype/spec/gpos#lookup-type-2-pair-adjustment-positioning-subtable
gposSubtableParsers[2] = function parseLookup2() {
  const start = this.offset + this.relativeOffset;
  const posFormat = this.parseUShort();
  check.assert(posFormat === 1 || posFormat === 2, `0x${start.toString(16)}: GPOS lookup type 2 format must be 1 or 2.`);
  const coverage = this.parsePointer(Parser.coverage);
  const valueFormat1 = this.parseUShort();
  const valueFormat2 = this.parseUShort();
  if (posFormat === 1) {
    // Adjustments for Glyph Pairs
    return {
      posFormat,
      coverage,
      valueFormat1,
      valueFormat2,
      pairSets: this.parseList(Parser.pointer(Parser.list(function () {
        return { // pairValueRecord
          secondGlyph: this.parseUShort(),
          value1: this.parseValueRecord(valueFormat1),
          value2: this.parseValueRecord(valueFormat2),
        };
      }))),
    };
  } if (posFormat === 2) {
    const classDef1 = this.parsePointer(Parser.classDef);
    const classDef2 = this.parsePointer(Parser.classDef);
    const class1Count = this.parseUShort();
    const class2Count = this.parseUShort();
    return {
      // Class Pair Adjustment
      posFormat,
      coverage,
      valueFormat1,
      valueFormat2,
      classDef1,
      classDef2,
      class1Count,
      class2Count,
      classRecords: this.parseList(class1Count, Parser.list(class2Count, function () {
        return {
          value1: this.parseValueRecord(valueFormat1),
          value2: this.parseValueRecord(valueFormat2),
        };
      })),
    };
  }
};

gposSubtableParsers[3] = function parseLookup3() { return { error: 'GPOS Lookup 3 not supported' }; };
gposSubtableParsers[4] = function parseLookup4() { return { error: 'GPOS Lookup 4 not supported' }; };
gposSubtableParsers[5] = function parseLookup5() { return { error: 'GPOS Lookup 5 not supported' }; };
gposSubtableParsers[6] = function parseLookup6() { return { error: 'GPOS Lookup 6 not supported' }; };
gposSubtableParsers[7] = function parseLookup7() { return { error: 'GPOS Lookup 7 not supported' }; };
gposSubtableParsers[8] = function parseLookup8() { return { error: 'GPOS Lookup 8 not supported' }; };
gposSubtableParsers[9] = function parseLookup9() { return { error: 'GPOS Lookup 9 not supported' }; };

// https://docs.microsoft.com/en-us/typography/opentype/spec/gpos
export function parseGposTable(data, start) {
  start = start || 0;
  const p = new Parser(data, start);
  const tableVersion = p.parseVersion(1);
  check.argument(tableVersion === 1 || tableVersion === 1.1, `Unsupported GPOS table version ${tableVersion}`);

  if (tableVersion === 1) {
    return {
      version: tableVersion,
      scripts: p.parseScriptList(),
      features: p.parseFeatureList(),
      lookups: p.parseLookupList(gposSubtableParsers),
    };
  }
  return {
    version: tableVersion,
    scripts: p.parseScriptList(),
    features: p.parseFeatureList(),
    lookups: p.parseLookupList(gposSubtableParsers),
    variations: p.parseFeatureVariationsList(),
  };
}

// GPOS Writing //////////////////////////////////////////////

function writeTag(d, pos, tag) {
  d[pos] = tag.charCodeAt(0);
  d[pos + 1] = tag.charCodeAt(1);
  d[pos + 2] = tag.charCodeAt(2);
  d[pos + 3] = tag.charCodeAt(3);
}

export function makeGposTable(kerningPairs) {
  const kerningArray = Object.entries(kerningPairs);
  kerningArray.sort((a, b) => {
    const aLeftGlyph = parseInt(a[0].match(/\d+/)[0]);
    const aRightGlyph = parseInt(a[0].match(/\d+$/)[0]);
    const bLeftGlyph = parseInt(b[0].match(/\d+/)[0]);
    const bRightGlyph = parseInt(b[0].match(/\d+$/)[0]);
    if (aLeftGlyph < bLeftGlyph) {
      return -1;
    }
    if (aLeftGlyph > bLeftGlyph) {
      return 1;
    }
    if (aRightGlyph < bRightGlyph) {
      return -1;
    }
    return 1;
  });

  const nPairs = kerningArray.length;

  const firstGlyphs = [];
  const kerningGlyphs2 = [];

  for (let i = 0; i < nPairs; i++) {
    const firstGlyph = parseInt(kerningArray[i][0].match(/\d+/)[0]);
    const secondGlyph = parseInt(kerningArray[i][0].match(/\d+$/)[0]);

    if (firstGlyph !== firstGlyphs[firstGlyphs.length - 1]) {
      firstGlyphs.push(firstGlyph);
      kerningGlyphs2[firstGlyphs.length - 1] = [];
    }

    kerningGlyphs2[firstGlyphs.length - 1].push([secondGlyph, kerningArray[i][1]]);
  }

  // Calculate total size for the dynamic portion (pairSetOffsets + pairSets + coverage).
  // pairSetOffsets: 2 * firstGlyphs.length
  // pairSets: for each firstGlyph, 2 (count) + 4 * pairCount
  // coverage: 2 (format) + 2 (glyphCount) + 2 * firstGlyphs.length
  let dynamicSize = 2 * firstGlyphs.length; // pairSetOffsets
  for (let i = 0; i < kerningGlyphs2.length; i++) {
    dynamicSize += 2 + 4 * kerningGlyphs2[i].length;
  }
  dynamicSize += 4 + 2 * firstGlyphs.length; // coverage

  const d = new Array(dynamicSize);
  let p = 0;

  // PairSet offsets
  let offsetN = 10 + 2 * firstGlyphs.length;
  for (let i = 0; i < firstGlyphs.length; i++) {
    writeUint16(d, p, offsetN); p += 2;
    offsetN = offsetN + 2 + 4 * kerningGlyphs2[i].length;
  }

  // PairSet tables
  for (let i = 0; i < kerningGlyphs2.length; i++) {
    writeUint16(d, p, kerningGlyphs2[i].length); p += 2;
    for (let j = 0; j < kerningGlyphs2[i].length; j++) {
      writeUint16(d, p, kerningGlyphs2[i][j][0]); p += 2; // secondGlyph
      writeUint16(d, p, kerningGlyphs2[i][j][1]); p += 2; // valueRecord1
    }
  }

  // Coverage table
  writeUint16(d, p, 1); p += 2; // format 1
  writeUint16(d, p, firstGlyphs.length); p += 2;
  for (let i = 0; i < firstGlyphs.length; i++) {
    writeUint16(d, p, firstGlyphs[i]); p += 2;
  }

  // Fixed header (62 bytes) + lookup subtable header (10 bytes) = 72 bytes before dynamic data
  const header = new Array(72);
  let h = 0;
  // GPOS Header
  writeUint16(header, h, 1); h += 2; // majorVersion
  writeUint16(header, h, 0); h += 2; // minorVersion
  writeUint16(header, h, 10); h += 2; // scriptListOffset
  writeUint16(header, h, 48); h += 2; // featureListOffset
  writeUint16(header, h, 62); h += 2; // lookupListOffset
  // ScriptList
  writeUint16(header, h, 2); h += 2; // scriptCount
  writeTag(header, h, 'DFLT'); h += 4;
  writeUint16(header, h, 14); h += 2;
  writeTag(header, h, 'latn'); h += 4;
  writeUint16(header, h, 26); h += 2;
  // Script Table #1
  writeUint16(header, h, 4); h += 2; // defaultLangSysOffset
  writeUint16(header, h, 0); h += 2; // langSysCount
  writeUint16(header, h, 0); h += 2; // lookupOrderOffset
  writeUint16(header, h, 65535); h += 2; // requiredFeatureIndex
  writeUint16(header, h, 1); h += 2; // featureIndexCount
  writeUint16(header, h, 0); h += 2; // featureIndex
  // Script Table #2
  writeUint16(header, h, 4); h += 2;
  writeUint16(header, h, 0); h += 2;
  writeUint16(header, h, 0); h += 2;
  writeUint16(header, h, 65535); h += 2;
  writeUint16(header, h, 1); h += 2;
  writeUint16(header, h, 0); h += 2;
  // FeatureList
  writeUint16(header, h, 1); h += 2; // featureCount
  writeTag(header, h, 'kern'); h += 4;
  writeUint16(header, h, 8); h += 2; // featureOffset
  writeUint16(header, h, 0); h += 2; // featureParamsOffset
  writeUint16(header, h, 1); h += 2; // lookupIndexCount
  writeUint16(header, h, 0); h += 2; // lookupListIndices
  // LookupList
  writeUint16(header, h, 1); h += 2; // lookupCount
  writeUint16(header, h, 4); h += 2; // lookupOffset
  writeUint16(header, h, 2); h += 2; // lookupType
  writeUint16(header, h, 0); h += 2; // lookupFlag
  writeUint16(header, h, 1); h += 2; // subTableCount
  writeUint16(header, h, 8); h += 2; // lookupOffset2
  // Lookup subtable header
  writeUint16(header, h, 1); h += 2; // posFormat
  writeUint16(header, h, 10 + 4 * firstGlyphs.length + 4 * nPairs); h += 2; // coverageOffset
  writeUint16(header, h, 4); h += 2; // valueFormat1
  writeUint16(header, h, 0); h += 2; // valueFormat2
  writeUint16(header, h, firstGlyphs.length); h += 2; // pairSetCount

  return new table.Table('GPOS', [
    { name: 'header', type: 'LITERAL', value: header },
    { name: 'data', type: 'LITERAL', value: d },
  ]);
}

// --- gsub table ---
// The `GSUB` table contains ligatures, among other things.
// https://www.microsoft.com/typography/OTSPEC/gsub.htm

const subtableParsers = new Array(9); // subtableParsers[0] is unused

// https://www.microsoft.com/typography/OTSPEC/GSUB.htm#SS
subtableParsers[1] = function parseLookup1() {
  const start = this.offset + this.relativeOffset;
  const substFormat = this.parseUShort();
  if (substFormat === 1) {
    return {
      substFormat: 1,
      coverage: this.parsePointer(Parser.coverage),
      deltaGlyphId: this.parseShort(),
    };
  } if (substFormat === 2) {
    return {
      substFormat: 2,
      coverage: this.parsePointer(Parser.coverage),
      substitute: this.parseOffset16List(),
    };
  }
  check.assert(false, `0x${start.toString(16)}: lookup type 1 format must be 1 or 2.`);
};

// https://www.microsoft.com/typography/OTSPEC/GSUB.htm#MS
subtableParsers[2] = function parseLookup2() {
  const substFormat = this.parseUShort();
  check.argument(substFormat === 1, 'GSUB Multiple Substitution Subtable identifier-format must be 1');
  return {
    substFormat,
    coverage: this.parsePointer(Parser.coverage),
    sequences: this.parseListOfLists(),
  };
};

// https://www.microsoft.com/typography/OTSPEC/GSUB.htm#AS
subtableParsers[3] = function parseLookup3() {
  const substFormat = this.parseUShort();
  check.argument(substFormat === 1, 'GSUB Alternate Substitution Subtable identifier-format must be 1');
  return {
    substFormat,
    coverage: this.parsePointer(Parser.coverage),
    alternateSets: this.parseListOfLists(),
  };
};

// https://www.microsoft.com/typography/OTSPEC/GSUB.htm#LS
subtableParsers[4] = function parseLookup4() {
  const substFormat = this.parseUShort();
  check.argument(substFormat === 1, 'GSUB ligature table identifier-format must be 1');
  return {
    substFormat,
    coverage: this.parsePointer(Parser.coverage),
    ligatureSets: this.parseListOfLists(function () {
      return {
        ligGlyph: this.parseUShort(),
        components: this.parseUShortList(this.parseUShort() - 1),
      };
    }),
  };
};

const lookupRecordDesc = {
  sequenceIndex: Parser.uShort,
  lookupListIndex: Parser.uShort,
};

// https://www.microsoft.com/typography/OTSPEC/GSUB.htm#CSF
subtableParsers[5] = function parseLookup5() {
  const start = this.offset + this.relativeOffset;
  const substFormat = this.parseUShort();

  if (substFormat === 1) {
    return {
      substFormat,
      coverage: this.parsePointer(Parser.coverage),
      ruleSets: this.parseListOfLists(function () {
        const glyphCount = this.parseUShort();
        const substCount = this.parseUShort();
        return {
          input: this.parseUShortList(glyphCount - 1),
          lookupRecords: this.parseRecordList(substCount, lookupRecordDesc),
        };
      }),
    };
  } if (substFormat === 2) {
    return {
      substFormat,
      coverage: this.parsePointer(Parser.coverage),
      classDef: this.parsePointer(Parser.classDef),
      classSets: this.parseListOfLists(function () {
        const glyphCount = this.parseUShort();
        const substCount = this.parseUShort();
        return {
          classes: this.parseUShortList(glyphCount - 1),
          lookupRecords: this.parseRecordList(substCount, lookupRecordDesc),
        };
      }),
    };
  } if (substFormat === 3) {
    const glyphCount = this.parseUShort();
    const substCount = this.parseUShort();
    return {
      substFormat,
      coverages: this.parseList(glyphCount, Parser.pointer(Parser.coverage)),
      lookupRecords: this.parseRecordList(substCount, lookupRecordDesc),
    };
  }
  check.assert(false, `0x${start.toString(16)}: lookup type 5 format must be 1, 2 or 3.`);
};

// https://www.microsoft.com/typography/OTSPEC/GSUB.htm#CC
subtableParsers[6] = function parseLookup6() {
  const start = this.offset + this.relativeOffset;
  const substFormat = this.parseUShort();
  if (substFormat === 1) {
    return {
      substFormat: 1,
      coverage: this.parsePointer(Parser.coverage),
      chainRuleSets: this.parseListOfLists(function () {
        return {
          backtrack: this.parseUShortList(),
          input: this.parseUShortList(this.parseShort() - 1),
          lookahead: this.parseUShortList(),
          lookupRecords: this.parseRecordList(lookupRecordDesc),
        };
      }),
    };
  } if (substFormat === 2) {
    return {
      substFormat: 2,
      coverage: this.parsePointer(Parser.coverage),
      backtrackClassDef: this.parsePointer(Parser.classDef),
      inputClassDef: this.parsePointer(Parser.classDef),
      lookaheadClassDef: this.parsePointer(Parser.classDef),
      chainClassSet: this.parseListOfLists(function () {
        return {
          backtrack: this.parseUShortList(),
          input: this.parseUShortList(this.parseShort() - 1),
          lookahead: this.parseUShortList(),
          lookupRecords: this.parseRecordList(lookupRecordDesc),
        };
      }),
    };
  } if (substFormat === 3) {
    return {
      substFormat: 3,
      backtrackCoverage: this.parseList(Parser.pointer(Parser.coverage)),
      inputCoverage: this.parseList(Parser.pointer(Parser.coverage)),
      lookaheadCoverage: this.parseList(Parser.pointer(Parser.coverage)),
      lookupRecords: this.parseRecordList(lookupRecordDesc),
    };
  }
  check.assert(false, `0x${start.toString(16)}: lookup type 6 format must be 1, 2 or 3.`);
};

// https://www.microsoft.com/typography/OTSPEC/GSUB.htm#ES
subtableParsers[7] = function parseLookup7() {
  // Extension Substitution subtable
  const substFormat = this.parseUShort();
  check.argument(substFormat === 1, 'GSUB Extension Substitution subtable identifier-format must be 1');
  const extensionLookupType = this.parseUShort();
  const extensionParser = new Parser(this.data, this.offset + this.parseULong());
  return {
    substFormat: 1,
    lookupType: extensionLookupType,
    extension: subtableParsers[extensionLookupType].call(extensionParser),
  };
};

// https://www.microsoft.com/typography/OTSPEC/GSUB.htm#RCCS
subtableParsers[8] = function parseLookup8() {
  const substFormat = this.parseUShort();
  check.argument(substFormat === 1, 'GSUB Reverse Chaining Contextual Single Substitution Subtable identifier-format must be 1');
  return {
    substFormat,
    coverage: this.parsePointer(Parser.coverage),
    backtrackCoverage: this.parseList(Parser.pointer(Parser.coverage)),
    lookaheadCoverage: this.parseList(Parser.pointer(Parser.coverage)),
    substitutes: this.parseUShortList(),
  };
};

// https://www.microsoft.com/typography/OTSPEC/gsub.htm
export function parseGsubTable(data, start) {
  start = start || 0;
  const p = new Parser(data, start);
  const tableVersion = p.parseVersion(1);
  check.argument(tableVersion === 1 || tableVersion === 1.1, 'Unsupported GSUB table version.');
  if (tableVersion === 1) {
    return {
      version: tableVersion,
      scripts: p.parseScriptList(),
      features: p.parseFeatureList(),
      lookups: p.parseLookupList(subtableParsers),
    };
  }
  return {
    version: tableVersion,
    scripts: p.parseScriptList(),
    features: p.parseFeatureList(),
    lookups: p.parseLookupList(subtableParsers),
    variations: p.parseFeatureVariationsList(),
  };
}

// GSUB Writing //////////////////////////////////////////////
const subtableMakers = new Array(9);

subtableMakers[1] = function makeLookup1(subtable) {
  if (subtable.substFormat === 1) {
    return new table.Table('substitutionTable', [
      { name: 'substFormat', type: 'USHORT', value: 1 },
      { name: 'coverage', type: 'TABLE', value: new table.Coverage(subtable.coverage) },
      { name: 'deltaGlyphID', type: 'SHORT', value: subtable.deltaGlyphId },
    ]);
  }
  return new table.Table('substitutionTable', [
    { name: 'substFormat', type: 'USHORT', value: 2 },
    { name: 'coverage', type: 'TABLE', value: new table.Coverage(subtable.coverage) },
  ].concat(table.ushortList('substitute', subtable.substitute)));

  check.fail('Lookup type 1 substFormat must be 1 or 2.');
};

subtableMakers[2] = function makeLookup2(subtable) {
  check.assert(subtable.substFormat === 1, 'Lookup type 2 substFormat must be 1.');
  return new table.Table('substitutionTable', [
    { name: 'substFormat', type: 'USHORT', value: 1 },
    { name: 'coverage', type: 'TABLE', value: new table.Coverage(subtable.coverage) },
  ].concat(table.tableList('seqSet', subtable.sequences, (sequenceSet) => new table.Table('sequenceSetTable', table.ushortList('sequence', sequenceSet)))));
};

subtableMakers[3] = function makeLookup3(subtable) {
  check.assert(subtable.substFormat === 1, 'Lookup type 3 substFormat must be 1.');
  return new table.Table('substitutionTable', [
    { name: 'substFormat', type: 'USHORT', value: 1 },
    { name: 'coverage', type: 'TABLE', value: new table.Coverage(subtable.coverage) },
  ].concat(table.tableList('altSet', subtable.alternateSets, (alternateSet) => new table.Table('alternateSetTable', table.ushortList('alternate', alternateSet)))));
};

subtableMakers[4] = function makeLookup4(subtable) {
  check.assert(subtable.substFormat === 1, 'Lookup type 4 substFormat must be 1.');
  return new table.Table('substitutionTable', [
    { name: 'substFormat', type: 'USHORT', value: 1 },
    { name: 'coverage', type: 'TABLE', value: new table.Coverage(subtable.coverage) },
  ].concat(table.tableList('ligSet', subtable.ligatureSets, (ligatureSet) => new table.Table('ligatureSetTable', table.tableList('ligature', ligatureSet, (ligature) => new table.Table('ligatureTable',
    [{ name: 'ligGlyph', type: 'USHORT', value: ligature.ligGlyph }]
      .concat(table.ushortList('component', ligature.components, ligature.components.length + 1)),
  ))))));
};

subtableMakers[6] = function makeLookup6(subtable) {
  if (subtable.substFormat === 1) {
    const returnTable = new table.Table('chainContextTable', [
      { name: 'substFormat', type: 'USHORT', value: subtable.substFormat },
      { name: 'coverage', type: 'TABLE', value: new table.Coverage(subtable.coverage) },
    ].concat(table.tableList('chainRuleSet', subtable.chainRuleSets, (chainRuleSet) => new table.Table('chainRuleSetTable', table.tableList('chainRule', chainRuleSet, (chainRule) => {
      let tableData = table.ushortList('backtrackGlyph', chainRule.backtrack, chainRule.backtrack.length)
        .concat(table.ushortList('inputGlyph', chainRule.input, chainRule.input.length + 1))
        .concat(table.ushortList('lookaheadGlyph', chainRule.lookahead, chainRule.lookahead.length))
        .concat(table.ushortList('substitution', [], chainRule.lookupRecords.length));

      chainRule.lookupRecords.forEach((record, i) => {
        tableData = tableData
          .concat({ name: `sequenceIndex${i}`, type: 'USHORT', value: record.sequenceIndex })
          .concat({ name: `lookupListIndex${i}`, type: 'USHORT', value: record.lookupListIndex });
      });
      return new table.Table('chainRuleTable', tableData);
    })))));
    return returnTable;
  } if (subtable.substFormat === 2) {
    check.assert(false, 'lookup type 6 format 2 is not yet supported.');
  } else if (subtable.substFormat === 3) {
    let tableData = [
      { name: 'substFormat', type: 'USHORT', value: subtable.substFormat },
    ];

    tableData.push({ name: 'backtrackGlyphCount', type: 'USHORT', value: subtable.backtrackCoverage.length });
    subtable.backtrackCoverage.forEach((coverage, i) => {
      tableData.push({ name: `backtrackCoverage${i}`, type: 'TABLE', value: new table.Coverage(coverage) });
    });
    tableData.push({ name: 'inputGlyphCount', type: 'USHORT', value: subtable.inputCoverage.length });
    subtable.inputCoverage.forEach((coverage, i) => {
      tableData.push({ name: `inputCoverage${i}`, type: 'TABLE', value: new table.Coverage(coverage) });
    });
    tableData.push({ name: 'lookaheadGlyphCount', type: 'USHORT', value: subtable.lookaheadCoverage.length });
    subtable.lookaheadCoverage.forEach((coverage, i) => {
      tableData.push({ name: `lookaheadCoverage${i}`, type: 'TABLE', value: new table.Coverage(coverage) });
    });

    tableData.push({ name: 'substitutionCount', type: 'USHORT', value: subtable.lookupRecords.length });
    subtable.lookupRecords.forEach((record, i) => {
      tableData = tableData
        .concat({ name: `sequenceIndex${i}`, type: 'USHORT', value: record.sequenceIndex })
        .concat({ name: `lookupListIndex${i}`, type: 'USHORT', value: record.lookupListIndex });
    });

    const returnTable = new table.Table('chainContextTable', tableData);

    return returnTable;
  }

  check.assert(false, 'lookup type 6 format must be 1, 2 or 3.');
};

export function makeGsubTable(gsub) {
  return new table.Table('GSUB', [
    { name: 'version', type: 'ULONG', value: 0x10000 },
    { name: 'scripts', type: 'TABLE', value: new table.ScriptList(gsub.scripts) },
    { name: 'features', type: 'TABLE', value: new table.FeatureList(gsub.features) },
    { name: 'lookups', type: 'TABLE', value: new table.LookupList(gsub.lookups, subtableMakers) },
  ]);
}

// --- head table ---
// The `head` table contains global information about the font.
// https://www.microsoft.com/typography/OTSPEC/head.htm

export function parseHeadTable(data, start) {
  const head = {};
  const p = new parse.Parser(data, start);
  head.version = p.parseVersion();
  head.fontRevision = Math.round(p.parseFixed() * 1000) / 1000;
  head.checkSumAdjustment = p.parseULong();
  head.magicNumber = p.parseULong();
  check.argument(head.magicNumber === 0x5F0F3CF5, 'Font header has wrong magic number.');
  head.flags = p.parseUShort();
  head.unitsPerEm = p.parseUShort();
  head.created = p.parseLongDateTime();
  head.modified = p.parseLongDateTime();
  head.xMin = p.parseShort();
  head.yMin = p.parseShort();
  head.xMax = p.parseShort();
  head.yMax = p.parseShort();
  head.macStyle = p.parseUShort();
  head.lowestRecPPEM = p.parseUShort();
  head.fontDirectionHint = p.parseShort();
  head.indexToLocFormat = p.parseShort();
  head.glyphDataFormat = p.parseShort();
  return head;
}

export function makeHeadTable(options) {
  // Apple Mac timestamp epoch is 01/01/1904 not 01/01/1970
  const timestamp = Math.round(new Date().getTime() / 1000) + 2082844800;
  let createdTimestamp = timestamp;

  if (options.createdTimestamp) {
    createdTimestamp = options.createdTimestamp + 2082844800;
  }

  const o = options || {};
  const d = new Array(54);
  let p = 0;
  writeUint32(d, p, o.version !== undefined ? o.version : 0x00010000); p += 4; // version (FIXED)
  writeUint32(d, p, o.fontRevision !== undefined ? o.fontRevision : 0x00010000); p += 4; // fontRevision (FIXED)
  writeUint32(d, p, o.checkSumAdjustment !== undefined ? o.checkSumAdjustment : 0); p += 4; // checkSumAdjustment
  writeUint32(d, p, o.magicNumber !== undefined ? o.magicNumber : 0x5F0F3CF5); p += 4; // magicNumber
  writeUint16(d, p, o.flags !== undefined ? o.flags : 0); p += 2; // flags
  writeUint16(d, p, o.unitsPerEm !== undefined ? o.unitsPerEm : 1000); p += 2; // unitsPerEm
  // created (LONGDATETIME = 8 bytes: 4 zero bytes + 4 byte timestamp)
  const created = o.created !== undefined ? o.created : createdTimestamp;
  d[p] = 0; d[p + 1] = 0; d[p + 2] = 0; d[p + 3] = 0;
  writeUint32(d, p + 4, created); p += 8;
  // modified (LONGDATETIME)
  const modified = o.modified !== undefined ? o.modified : timestamp;
  d[p] = 0; d[p + 1] = 0; d[p + 2] = 0; d[p + 3] = 0;
  writeUint32(d, p + 4, modified); p += 8;
  writeInt16(d, p, o.xMin !== undefined ? o.xMin : 0); p += 2;
  writeInt16(d, p, o.yMin !== undefined ? o.yMin : 0); p += 2;
  writeInt16(d, p, o.xMax !== undefined ? o.xMax : 0); p += 2;
  writeInt16(d, p, o.yMax !== undefined ? o.yMax : 0); p += 2;
  writeUint16(d, p, o.macStyle !== undefined ? o.macStyle : 0); p += 2;
  writeUint16(d, p, o.lowestRecPPEM !== undefined ? o.lowestRecPPEM : 0); p += 2;
  writeInt16(d, p, o.fontDirectionHint !== undefined ? o.fontDirectionHint : 2); p += 2;
  writeInt16(d, p, o.indexToLocFormat !== undefined ? o.indexToLocFormat : 0); p += 2;
  writeInt16(d, p, o.glyphDataFormat !== undefined ? o.glyphDataFormat : 0); p += 2;
  return new table.Table('head', [
    { name: 'data', type: 'LITERAL', value: d },
  ]);
}

// --- hhea table ---
// The `hhea` table contains information for horizontal layout.
// https://www.microsoft.com/typography/OTSPEC/hhea.htm

export function parseHheaTable(data, start) {
  const hhea = {};
  const p = new parse.Parser(data, start);
  hhea.version = p.parseVersion();
  hhea.ascender = p.parseShort();
  hhea.descender = p.parseShort();
  hhea.lineGap = p.parseShort();
  hhea.advanceWidthMax = p.parseUShort();
  hhea.minLeftSideBearing = p.parseShort();
  hhea.minRightSideBearing = p.parseShort();
  hhea.xMaxExtent = p.parseShort();
  hhea.caretSlopeRise = p.parseShort();
  hhea.caretSlopeRun = p.parseShort();
  hhea.caretOffset = p.parseShort();
  p.relativeOffset += 8;
  hhea.metricDataFormat = p.parseShort();
  hhea.numberOfHMetrics = p.parseUShort();
  return hhea;
}

export function makeHheaTable(options) {
  const o = options || {};
  const d = new Array(36);
  let p = 0;
  writeUint32(d, p, o.version !== undefined ? o.version : 0x00010000); p += 4; // version (FIXED)
  writeInt16(d, p, o.ascender !== undefined ? o.ascender : 0); p += 2; // ascender (FWORD)
  writeInt16(d, p, o.descender !== undefined ? o.descender : 0); p += 2; // descender (FWORD)
  writeInt16(d, p, o.lineGap !== undefined ? o.lineGap : 0); p += 2; // lineGap (FWORD)
  writeUint16(d, p, o.advanceWidthMax !== undefined ? o.advanceWidthMax : 0); p += 2; // advanceWidthMax (UFWORD)
  writeInt16(d, p, o.minLeftSideBearing !== undefined ? o.minLeftSideBearing : 0); p += 2; // minLeftSideBearing (FWORD)
  writeInt16(d, p, o.minRightSideBearing !== undefined ? o.minRightSideBearing : 0); p += 2; // minRightSideBearing (FWORD)
  writeInt16(d, p, o.xMaxExtent !== undefined ? o.xMaxExtent : 0); p += 2; // xMaxExtent (FWORD)
  writeInt16(d, p, o.caretSlopeRise !== undefined ? o.caretSlopeRise : 1); p += 2; // caretSlopeRise
  writeInt16(d, p, o.caretSlopeRun !== undefined ? o.caretSlopeRun : 0); p += 2; // caretSlopeRun
  writeInt16(d, p, o.caretOffset !== undefined ? o.caretOffset : 0); p += 2; // caretOffset
  writeInt16(d, p, 0); p += 2; // reserved1
  writeInt16(d, p, 0); p += 2; // reserved2
  writeInt16(d, p, 0); p += 2; // reserved3
  writeInt16(d, p, 0); p += 2; // reserved4
  writeInt16(d, p, o.metricDataFormat !== undefined ? o.metricDataFormat : 0); p += 2; // metricDataFormat
  writeUint16(d, p, o.numberOfHMetrics !== undefined ? o.numberOfHMetrics : 0); p += 2; // numberOfHMetrics
  return new table.Table('hhea', [
    { name: 'data', type: 'LITERAL', value: d },
  ]);
}

// --- hmtx table ---
// The `hmtx` table contains the horizontal metrics for all glyphs.
// https://www.microsoft.com/typography/OTSPEC/hmtx.htm

export function parseHmtxTable(data, start, numMetrics, numGlyphs, glyphs) {
  let advanceWidth;
  let leftSideBearing;
  const p = new parse.Parser(data, start);
  for (let i = 0; i < numGlyphs; i += 1) {
    if (i < numMetrics) {
      advanceWidth = p.parseUShort();
      leftSideBearing = p.parseShort();
    }

    const glyph = glyphs.get(i);
    glyph.advanceWidth = advanceWidth;
    glyph.leftSideBearing = leftSideBearing;
  }
}

export function makeHmtxTable(glyphs) {
  const data = new Array(glyphs.length * 4);
  for (let i = 0; i < glyphs.length; i += 1) {
    const glyph = glyphs.get(i);
    const advanceWidth = glyph.advanceWidth || 0;
    const leftSideBearing = glyph.leftSideBearing || 0;
    const off = i * 4;
    // advanceWidth as USHORT (big-endian)
    data[off] = (advanceWidth >> 8) & 0xFF;
    data[off + 1] = advanceWidth & 0xFF;
    // leftSideBearing as SHORT (big-endian, two's complement)
    data[off + 2] = (leftSideBearing >> 8) & 0xFF;
    data[off + 3] = leftSideBearing & 0xFF;
  }

  return new table.Table('hmtx', [
    { name: 'metrics', type: 'LITERAL', value: data },
  ]);
}

// --- kern table ---
// The `kern` table contains kerning pairs.
// Note that some fonts use the GPOS OpenType layout table to specify kerning.
// https://www.microsoft.com/typography/OTSPEC/kern.htm

// Parse the `kern` table which contains kerning pairs.
export function parseKernTable(data, start) {
  const p = new parse.Parser(data, start);
  const tableVersion = p.parseUShort();
  const pairs = {};
  if (tableVersion === 0) {
    // Windows kern table
    p.skip('uShort');
    const subtableVersion = p.parseUShort();
    check.argument(subtableVersion === 0, 'Unsupported kern sub-table version.');
    p.skip('uShort', 2);
    const nPairs = p.parseUShort();
    p.skip('uShort', 3);
    for (let i = 0; i < nPairs; i += 1) {
      const leftIndex = p.parseUShort();
      const rightIndex = p.parseUShort();
      const value = p.parseShort();
      pairs[`${leftIndex},${rightIndex}`] = value;
    }
  } else if (tableVersion === 1) {
    // Mac kern table
    p.skip('uShort');
    const nTables = p.parseULong();
    if (nTables > 1) {
      console.warn('Only the first kern subtable is supported.');
    }
    p.skip('uLong');
    const coverage = p.parseUShort();
    const subtableVersion = coverage & 0xFF;
    p.skip('uShort');
    if (subtableVersion === 0) {
      const nPairs = p.parseUShort();
      p.skip('uShort', 3);
      for (let i = 0; i < nPairs; i += 1) {
        const leftIndex = p.parseUShort();
        const rightIndex = p.parseUShort();
        const value = p.parseShort();
        pairs[`${leftIndex},${rightIndex}`] = value;
      }
    }
  } else {
    throw new Error(`Unsupported kern table version (${tableVersion}).`);
  }
  return pairs;
}

// --- loca table ---
// The `loca` table stores the offsets to the locations of the glyphs in the font.
// https://www.microsoft.com/typography/OTSPEC/loca.htm

// Parse the `loca` table. This table stores the offsets to the locations of the glyphs in the font,
// relative to the beginning of the glyphData table.
// The number of glyphs stored in the `loca` table is specified in the `maxp` table (under numGlyphs)
// The loca table has two versions: a short version where offsets are stored as uShorts, and a long
// version where offsets are stored as uLongs. The `head` table specifies which version to use
// (under indexToLocFormat).
export function parseLocaTable(data, start, numGlyphs, shortVersion) {
  const p = new parse.Parser(data, start);
  const parseFn = shortVersion ? p.parseUShort : p.parseULong;
  // There is an extra entry after the last index element to compute the length of the last glyph.
  // That's why we use numGlyphs + 1.
  const glyphOffsets = [];
  for (let i = 0; i < numGlyphs + 1; i += 1) {
    let glyphOffset = parseFn.call(p);
    if (shortVersion) {
      // The short table version stores the actual offset divided by 2.
      glyphOffset *= 2;
    }

    glyphOffsets.push(glyphOffset);
  }

  return glyphOffsets;
}

// --- ltag table ---
// The `ltag` table stores IETF BCP-47 language tags. It allows supporting
// languages for which TrueType does not assign a numeric code.
// https://developer.apple.com/fonts/TrueType-Reference-Manual/RM06/Chap6ltag.html
// http://www.w3.org/International/articles/language-tags/
// http://www.iana.org/assignments/language-subtag-registry/language-subtag-registry

export function makeLtagTable(tags) {
  let stringPool = '';
  const stringPoolOffset = 12 + tags.length * 4;
  const offsets = [];
  for (let i = 0; i < tags.length; ++i) {
    let pos = stringPool.indexOf(tags[i]);
    if (pos < 0) {
      pos = stringPool.length;
      stringPool += tags[i];
    }
    offsets.push({ offset: stringPoolOffset + pos, length: tags[i].length });
  }

  const totalSize = 12 + tags.length * 4 + stringPool.length;
  const d = new Array(totalSize);
  let p = 0;
  writeUint32(d, p, 1); p += 4; // version
  writeUint32(d, p, 0); p += 4; // flags
  writeUint32(d, p, tags.length); p += 4; // numTags
  for (let i = 0; i < offsets.length; i++) {
    writeUint16(d, p, offsets[i].offset); p += 2;
    writeUint16(d, p, offsets[i].length); p += 2;
  }
  for (let i = 0; i < stringPool.length; i++) {
    d[p++] = stringPool.charCodeAt(i);
  }
  return new table.Table('ltag', [
    { name: 'data', type: 'LITERAL', value: d },
  ]);
}

export function parseLtagTable(data, start) {
  const p = new parse.Parser(data, start);
  const tableVersion = p.parseULong();
  check.argument(tableVersion === 1, 'Unsupported ltag table version.');
  // The 'ltag' specification does not define any flags; skip the field.
  p.skip('uLong', 1);
  const numTags = p.parseULong();

  const tags = [];
  for (let i = 0; i < numTags; i++) {
    let tag = '';
    const offset = start + p.parseUShort();
    const length = p.parseUShort();
    for (let j = offset; j < offset + length; ++j) {
      tag += String.fromCharCode(data.getInt8(j));
    }

    tags.push(tag);
  }

  return tags;
}

// --- maxp table ---
// The `maxp` table establishes the memory requirements for the font.
// https://www.microsoft.com/typography/OTSPEC/maxp.htm

export function parseMaxpTable(data, start) {
  const maxp = {};
  const p = new parse.Parser(data, start);
  maxp.version = p.parseVersion();
  maxp.numGlyphs = p.parseUShort();
  if (maxp.version === 1.0) {
    maxp.maxPoints = p.parseUShort();
    maxp.maxContours = p.parseUShort();
    maxp.maxCompositePoints = p.parseUShort();
    maxp.maxCompositeContours = p.parseUShort();
    maxp.maxZones = p.parseUShort();
    maxp.maxTwilightPoints = p.parseUShort();
    maxp.maxStorage = p.parseUShort();
    maxp.maxFunctionDefs = p.parseUShort();
    maxp.maxInstructionDefs = p.parseUShort();
    maxp.maxStackElements = p.parseUShort();
    maxp.maxSizeOfInstructions = p.parseUShort();
    maxp.maxComponentElements = p.parseUShort();
    maxp.maxComponentDepth = p.parseUShort();
  }
  return maxp;
}

export function makeMaxpTable(numGlyphs) {
  const d = new Array(6);
  let p = 0;
  writeUint32(d, p, 0x00005000); p += 4; // version
  writeUint16(d, p, numGlyphs); p += 2; // numGlyphs
  return new table.Table('maxp', [
    { name: 'data', type: 'LITERAL', value: d },
  ]);
}

// Version 1.0 maxp for TrueType fonts (includes maxPoints, maxContours, etc.)
export function makeMaxpTableTrueType(numGlyphs, maxPoints, maxContours, maxCompositePoints, maxCompositeContours, maxComponentElements, maxComponentDepth, hintingMetrics) {
  const h = hintingMetrics || {};
  const d = new Array(32);
  let p = 0;
  writeUint32(d, p, 0x00010000); p += 4;
  writeUint16(d, p, numGlyphs); p += 2;
  writeUint16(d, p, maxPoints); p += 2;
  writeUint16(d, p, maxContours); p += 2;
  writeUint16(d, p, maxCompositePoints || 0); p += 2;
  writeUint16(d, p, maxCompositeContours || 0); p += 2;
  writeUint16(d, p, h.maxZones || 1); p += 2;
  writeUint16(d, p, h.maxTwilightPoints || 0); p += 2;
  writeUint16(d, p, h.maxStorage || 0); p += 2;
  writeUint16(d, p, h.maxFunctionDefs || 0); p += 2;
  writeUint16(d, p, h.maxInstructionDefs || 0); p += 2;
  writeUint16(d, p, h.maxStackElements || 0); p += 2;
  writeUint16(d, p, h.maxSizeOfInstructions || 0); p += 2;
  writeUint16(d, p, maxComponentElements || 0); p += 2;
  writeUint16(d, p, maxComponentDepth || 0); p += 2;
  return new table.Table('maxp', [
    { name: 'data', type: 'LITERAL', value: d },
  ]);
}

/**
 * Encode a single simple TrueType glyph into binary glyf data.
 * @param {Object} glyph - Glyph object with points, optional _xMin/_yMin/_xMax/_yMax, optional instructions
 * @returns {number[]} byte array for this glyph entry
 */
function encodeSimpleGlyph(glyph) {
  const points = glyph.points;
  if (!points || points.length === 0) return [];

  const endPtsOfContours = [];
  for (let i = 0; i < points.length; i++) {
    if (points[i].lastPointOfContour) endPtsOfContours.push(i);
  }
  if (endPtsOfContours.length === 0) return [];

  let xMin; let yMin; let xMax; let
    yMax;
  if (glyph._xMin !== undefined) {
    xMin = glyph._xMin;
    yMin = glyph._yMin;
    xMax = glyph._xMax;
    yMax = glyph._yMax;
  } else {
    xMin = Infinity; yMin = Infinity; xMax = -Infinity; yMax = -Infinity;
    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      if (pt.x < xMin) xMin = pt.x;
      if (pt.y < yMin) yMin = pt.y;
      if (pt.x > xMax) xMax = pt.x;
      if (pt.y > yMax) yMax = pt.y;
    }
  }

  const numberOfContours = endPtsOfContours.length;
  const d = [];

  pushInt16(d, numberOfContours);
  pushInt16(d, Math.round(xMin));
  pushInt16(d, Math.round(yMin));
  pushInt16(d, Math.round(xMax));
  pushInt16(d, Math.round(yMax));

  for (let i = 0; i < numberOfContours; i++) {
    pushUint16(d, endPtsOfContours[i]);
  }

  const instructions = glyph.instructions || [];
  pushUint16(d, instructions.length);
  for (let i = 0; i < instructions.length; i++) {
    d.push(instructions[i]);
  }

  let prevX = 0;
  let prevY = 0;
  const flags = [];
  const xDeltas = [];
  const yDeltas = [];
  for (let i = 0; i < points.length; i++) {
    const pt = points[i];
    const x = Math.round(pt.x);
    const y = Math.round(pt.y);
    const dx = x - prevX;
    const dy = y - prevY;
    prevX = x;
    prevY = y;

    let flag = pt.onCurve ? 0x01 : 0x00;
    if (i === 0) flag |= 0x40;

    if (dx === 0) {
      flag |= 0x10;
    } else if (dx >= -255 && dx <= 255) {
      flag |= 0x02;
      if (dx > 0) flag |= 0x10;
    }

    if (dy === 0) {
      flag |= 0x20;
    } else if (dy >= -255 && dy <= 255) {
      flag |= 0x04;
      if (dy > 0) flag |= 0x20;
    }

    flags.push(flag);
    xDeltas.push(dx);
    yDeltas.push(dy);
  }

  for (let i = 0; i < flags.length;) {
    const flag = flags[i];
    let repeatCount = 0;
    while (i + 1 + repeatCount < flags.length && flags[i + 1 + repeatCount] === flag && repeatCount < 255) {
      repeatCount++;
    }
    if (repeatCount > 0) {
      d.push(flag | 0x08);
      d.push(repeatCount);
      i += 1 + repeatCount;
    } else {
      d.push(flag);
      i++;
    }
  }

  for (let i = 0; i < xDeltas.length; i++) {
    const dx = xDeltas[i];
    if (flags[i] & 0x02) {
      d.push(Math.abs(dx));
    } else if (!(flags[i] & 0x10)) {
      pushInt16(d, dx);
    }
  }

  for (let i = 0; i < yDeltas.length; i++) {
    const dy = yDeltas[i];
    if (flags[i] & 0x04) {
      d.push(Math.abs(dy));
    } else if (!(flags[i] & 0x20)) {
      pushInt16(d, dy);
    }
  }

  return d;
}

function encodeCompositeGlyph(glyph) {
  const components = glyph.components;
  if (!components || components.length === 0) return [];

  let xMin; let yMin; let xMax; let
    yMax;
  if (glyph._xMin !== undefined) {
    xMin = glyph._xMin;
    yMin = glyph._yMin;
    xMax = glyph._xMax;
    yMax = glyph._yMax;
  } else {
    const pts = glyph.points || [];
    xMin = Infinity; yMin = Infinity; xMax = -Infinity; yMax = -Infinity;
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].x < xMin) xMin = pts[i].x;
      if (pts[i].y < yMin) yMin = pts[i].y;
      if (pts[i].x > xMax) xMax = pts[i].x;
      if (pts[i].y > yMax) yMax = pts[i].y;
    }
    if (xMin === Infinity) { xMin = 0; yMin = 0; xMax = 0; yMax = 0; }
  }

  const instructions = glyph.instructions || [];
  const hasInstructions = instructions.length > 0;

  const d = [];
  pushInt16(d, -1);
  pushInt16(d, Math.round(xMin));
  pushInt16(d, Math.round(yMin));
  pushInt16(d, Math.round(xMax));
  pushInt16(d, Math.round(yMax));

  for (let ci = 0; ci < components.length; ci++) {
    const comp = components[ci];
    const isLast = ci === components.length - 1;
    const hasScale = comp.xScale !== 1 || comp.yScale !== 1;
    const hasXYScale = hasScale && comp.xScale !== comp.yScale;
    const has2x2 = comp.scale01 !== 0 || comp.scale10 !== 0;

    let useWords;
    if (comp.flags !== undefined) {
      useWords = !!(comp.flags & 0x0001);
    } else {
      useWords = comp.dx < -128 || comp.dx > 127 || comp.dy < -128 || comp.dy > 127
        || (comp.matchedPoints !== undefined);
    }

    let flags = 0;
    if (useWords) flags |= 0x0001;
    if (comp.matchedPoints === undefined) flags |= 0x0002;
    if (!isLast) flags |= 0x0020;
    if (has2x2) flags |= 0x0080;
    else if (hasXYScale) flags |= 0x0040;
    else if (hasScale) flags |= 0x0008;
    if (isLast && hasInstructions) flags |= 0x0100;

    if (comp.flags !== undefined) {
      flags |= comp.flags & (0x0004 | 0x0200 | 0x0400 | 0x0800 | 0x1000);
    }

    pushUint16(d, flags);
    pushUint16(d, comp.glyphIndex);

    if (comp.matchedPoints !== undefined) {
      if (useWords) {
        pushUint16(d, comp.matchedPoints[0]);
        pushUint16(d, comp.matchedPoints[1]);
      } else {
        d.push(comp.matchedPoints[0] & 0xFF);
        d.push(comp.matchedPoints[1] & 0xFF);
      }
    } else if (useWords) {
      pushInt16(d, Math.round(comp.dx));
      pushInt16(d, Math.round(comp.dy));
    } else {
      d.push(Math.round(comp.dx) & 0xFF);
      d.push(Math.round(comp.dy) & 0xFF);
    }

    if (has2x2) {
      pushInt16(d, Math.round(comp.xScale * 0x4000));
      pushInt16(d, Math.round(comp.scale01 * 0x4000));
      pushInt16(d, Math.round(comp.scale10 * 0x4000));
      pushInt16(d, Math.round(comp.yScale * 0x4000));
    } else if (hasXYScale) {
      pushInt16(d, Math.round(comp.xScale * 0x4000));
      pushInt16(d, Math.round(comp.yScale * 0x4000));
    } else if (hasScale) {
      pushInt16(d, Math.round(comp.xScale * 0x4000));
    }
  }

  if (hasInstructions) {
    pushUint16(d, instructions.length);
    for (let i = 0; i < instructions.length; i++) {
      d.push(instructions[i]);
    }
  }

  while (d.length % 2 !== 0) d.push(0);
  return d;
}
function pushInt16(d, v) {
  if (v < 0) v += 0x10000;
  d.push((v >> 8) & 0xFF, v & 0xFF);
}

function pushUint16(d, v) {
  d.push((v >> 8) & 0xFF, v & 0xFF);
}

/**
 * Build glyf and loca tables from a GlyphSet.
 * @param {GlyphSet} glyphs
 */
export function makeGlyfTable(glyphs) {
  const allGlyfBytes = [];
  const locaOffsets = [];
  let maxPoints = 0;
  let maxContours = 0;
  let maxCompositePoints = 0;
  let maxCompositeContours = 0;
  let maxComponentElements = 0;
  let maxComponentDepth = 0;
  let maxSizeOfInstructions = 0;
  let offset = 0;

  for (let i = 0; i < glyphs.length; i++) {
    locaOffsets.push(offset);
    const glyph = glyphs.get(i);
    const pts = glyph.points;
    if (!pts || pts.length === 0) {
      continue;
    }

    const isComp = glyph.isComposite && glyph.components && glyph.components.length > 0;
    const glyphBytes = isComp ? encodeCompositeGlyph(glyph) : encodeSimpleGlyph(glyph);
    if (glyphBytes.length === 0) continue;

    while (glyphBytes.length % 2 !== 0) glyphBytes.push(0);

    for (let b = 0; b < glyphBytes.length; b++) allGlyfBytes.push(glyphBytes[b]);
    offset += glyphBytes.length;

    const instrLen = glyph.instructions ? glyph.instructions.length : 0;
    if (instrLen > maxSizeOfInstructions) maxSizeOfInstructions = instrLen;

    if (isComp) {
      if (pts.length > maxCompositePoints) maxCompositePoints = pts.length;
      const nc = pts.filter((p) => p.lastPointOfContour).length;
      if (nc > maxCompositeContours) maxCompositeContours = nc;
      if (glyph.components.length > maxComponentElements) maxComponentElements = glyph.components.length;
      if (maxComponentDepth < 1) maxComponentDepth = 1;
    } else {
      if (pts.length > maxPoints) maxPoints = pts.length;
      const nc = pts.filter((p) => p.lastPointOfContour).length;
      if (nc > maxContours) maxContours = nc;
    }
  }
  locaOffsets.push(offset);

  // Decide loca format: short if max offset fits in uint16 (offset/2 < 65536)
  const indexToLocFormat = (offset / 2) > 0xFFFF ? 1 : 0;

  // Build loca table bytes
  const locaBytes = [];
  for (let i = 0; i < locaOffsets.length; i++) {
    if (indexToLocFormat === 0) {
      pushUint16(locaBytes, locaOffsets[i] / 2);
    } else {
      const v = locaOffsets[i];
      locaBytes.push((v >> 24) & 0xFF, (v >> 16) & 0xFF, (v >> 8) & 0xFF, v & 0xFF);
    }
  }

  const glyfTable = new table.Table('glyf', [
    { name: 'data', type: 'LITERAL', value: allGlyfBytes },
  ]);
  const locaTable = new table.Table('loca', [
    { name: 'data', type: 'LITERAL', value: locaBytes },
  ]);

  return {
    glyfTable,
    locaTable,
    indexToLocFormat,
    maxPoints,
    maxContours,
    maxCompositePoints,
    maxCompositeContours,
    maxComponentElements,
    maxComponentDepth,
    maxSizeOfInstructions,
  };
}

// --- meta table ---
// The `GPOS` table contains kerning pairs, among other things.
// https://www.microsoft.com/typography/OTSPEC/gpos.htm

export function parseMetaTable(data, start) {
  const p = new parse.Parser(data, start);
  const tableVersion = p.parseULong();
  check.argument(tableVersion === 1, 'Unsupported META table version.');
  p.parseULong(); // flags
  p.parseULong(); // tableOffset
  const numDataMaps = p.parseULong();
  const tags = {};
  for (let i = 0; i < numDataMaps; i++) {
    const tag = p.parseTag();
    const dataOffset = p.parseULong();
    const dataLength = p.parseULong();
    tags[tag] = decode.UTF8(data, start + dataOffset, dataLength);
  }
  return tags;
}

export function makeMetaTable(tags) {
  const tagKeys = Object.keys(tags);
  const numTags = tagKeys.length;
  let stringPool = '';
  const stringPoolOffset = 16 + numTags * 12;

  const entries = [];
  for (let i = 0; i < tagKeys.length; i++) {
    const tag = tagKeys[i];
    const pos = stringPool.length;
    stringPool += tags[tag];
    entries.push({ tag, offset: stringPoolOffset + pos, length: tags[tag].length });
  }

  const totalSize = 16 + numTags * 12 + stringPool.length;
  const d = new Array(totalSize);
  let p = 0;
  writeUint32(d, p, 1); p += 4; // version
  writeUint32(d, p, 0); p += 4; // flags
  writeUint32(d, p, stringPoolOffset); p += 4; // offset
  writeUint32(d, p, numTags); p += 4; // numTags
  for (let i = 0; i < entries.length; i++) {
    writeTag(d, p, entries[i].tag); p += 4;
    writeUint32(d, p, entries[i].offset); p += 4;
    writeUint32(d, p, entries[i].length); p += 4;
  }
  for (let i = 0; i < stringPool.length; i++) {
    d[p++] = stringPool.charCodeAt(i);
  }
  return new table.Table('meta', [
    { name: 'data', type: 'LITERAL', value: d },
  ]);
}

// --- name table ---
// The `name` naming table.
// https://www.microsoft.com/typography/OTSPEC/name.htm

// NameIDs for the name table.
const nameTableNames = [
  'copyright', // 0
  'fontFamily', // 1
  'fontSubfamily', // 2
  'uniqueID', // 3
  'fullName', // 4
  'version', // 5
  'postScriptName', // 6
  'trademark', // 7
  'manufacturer', // 8
  'designer', // 9
  'description', // 10
  'manufacturerURL', // 11
  'designerURL', // 12
  'license', // 13
  'licenseURL', // 14
  'reserved', // 15
  'preferredFamily', // 16
  'preferredSubfamily', // 17
  'compatibleFullName', // 18
  'sampleText', // 19
  'postScriptFindFontName', // 20
  'wwsFamily', // 21
  'wwsSubfamily', // 22
];

const macLanguages = {
  0: 'en',
  1: 'fr',
  2: 'de',
  3: 'it',
  4: 'nl',
  5: 'sv',
  6: 'es',
  7: 'da',
  8: 'pt',
  9: 'no',
  10: 'he',
  11: 'ja',
  12: 'ar',
  13: 'fi',
  14: 'el',
  15: 'is',
  16: 'mt',
  17: 'tr',
  18: 'hr',
  19: 'zh-Hant',
  20: 'ur',
  21: 'hi',
  22: 'th',
  23: 'ko',
  24: 'lt',
  25: 'pl',
  26: 'hu',
  27: 'es',
  28: 'lv',
  29: 'se',
  30: 'fo',
  31: 'fa',
  32: 'ru',
  33: 'zh',
  34: 'nl-BE',
  35: 'ga',
  36: 'sq',
  37: 'ro',
  38: 'cz',
  39: 'sk',
  40: 'si',
  41: 'yi',
  42: 'sr',
  43: 'mk',
  44: 'bg',
  45: 'uk',
  46: 'be',
  47: 'uz',
  48: 'kk',
  49: 'az-Cyrl',
  50: 'az-Arab',
  51: 'hy',
  52: 'ka',
  53: 'mo',
  54: 'ky',
  55: 'tg',
  56: 'tk',
  57: 'mn-CN',
  58: 'mn',
  59: 'ps',
  60: 'ks',
  61: 'ku',
  62: 'sd',
  63: 'bo',
  64: 'ne',
  65: 'sa',
  66: 'mr',
  67: 'bn',
  68: 'as',
  69: 'gu',
  70: 'pa',
  71: 'or',
  72: 'ml',
  73: 'kn',
  74: 'ta',
  75: 'te',
  76: 'si',
  77: 'my',
  78: 'km',
  79: 'lo',
  80: 'vi',
  81: 'id',
  82: 'tl',
  83: 'ms',
  84: 'ms-Arab',
  85: 'am',
  86: 'ti',
  87: 'om',
  88: 'so',
  89: 'sw',
  90: 'rw',
  91: 'rn',
  92: 'ny',
  93: 'mg',
  94: 'eo',
  128: 'cy',
  129: 'eu',
  130: 'ca',
  131: 'la',
  132: 'qu',
  133: 'gn',
  134: 'ay',
  135: 'tt',
  136: 'ug',
  137: 'dz',
  138: 'jv',
  139: 'su',
  140: 'gl',
  141: 'af',
  142: 'br',
  143: 'iu',
  144: 'gd',
  145: 'gv',
  146: 'ga',
  147: 'to',
  148: 'el-polyton',
  149: 'kl',
  150: 'az',
  151: 'nn',
};

// MacOS language ID → MacOS script ID
//
// Note that the script ID is not sufficient to determine what encoding
// to use in TrueType files. For some languages, MacOS used a modification
// of a mainstream script. For example, an Icelandic name would be stored
// with smRoman in the TrueType naming table, but the actual encoding
// is a special Icelandic version of the normal Macintosh Roman encoding.
// As another example, Inuktitut uses an 8-bit encoding for Canadian Aboriginal
// Syllables but MacOS had run out of available script codes, so this was
// done as a (pretty radical) "modification" of Ethiopic.
//
// http://unicode.org/Public/MAPPINGS/VENDORS/APPLE/Readme.txt
const macLanguageToScript = {
  0: 0, // langEnglish → smRoman
  1: 0, // langFrench → smRoman
  2: 0, // langGerman → smRoman
  3: 0, // langItalian → smRoman
  4: 0, // langDutch → smRoman
  5: 0, // langSwedish → smRoman
  6: 0, // langSpanish → smRoman
  7: 0, // langDanish → smRoman
  8: 0, // langPortuguese → smRoman
  9: 0, // langNorwegian → smRoman
  10: 5, // langHebrew → smHebrew
  11: 1, // langJapanese → smJapanese
  12: 4, // langArabic → smArabic
  13: 0, // langFinnish → smRoman
  14: 6, // langGreek → smGreek
  15: 0, // langIcelandic → smRoman (modified)
  16: 0, // langMaltese → smRoman
  17: 0, // langTurkish → smRoman (modified)
  18: 0, // langCroatian → smRoman (modified)
  19: 2, // langTradChinese → smTradChinese
  20: 4, // langUrdu → smArabic
  21: 9, // langHindi → smDevanagari
  22: 21, // langThai → smThai
  23: 3, // langKorean → smKorean
  24: 29, // langLithuanian → smCentralEuroRoman
  25: 29, // langPolish → smCentralEuroRoman
  26: 29, // langHungarian → smCentralEuroRoman
  27: 29, // langEstonian → smCentralEuroRoman
  28: 29, // langLatvian → smCentralEuroRoman
  29: 0, // langSami → smRoman
  30: 0, // langFaroese → smRoman (modified)
  31: 4, // langFarsi → smArabic (modified)
  32: 7, // langRussian → smCyrillic
  33: 25, // langSimpChinese → smSimpChinese
  34: 0, // langFlemish → smRoman
  35: 0, // langIrishGaelic → smRoman (modified)
  36: 0, // langAlbanian → smRoman
  37: 0, // langRomanian → smRoman (modified)
  38: 29, // langCzech → smCentralEuroRoman
  39: 29, // langSlovak → smCentralEuroRoman
  40: 0, // langSlovenian → smRoman (modified)
  41: 5, // langYiddish → smHebrew
  42: 7, // langSerbian → smCyrillic
  43: 7, // langMacedonian → smCyrillic
  44: 7, // langBulgarian → smCyrillic
  45: 7, // langUkrainian → smCyrillic (modified)
  46: 7, // langByelorussian → smCyrillic
  47: 7, // langUzbek → smCyrillic
  48: 7, // langKazakh → smCyrillic
  49: 7, // langAzerbaijani → smCyrillic
  50: 4, // langAzerbaijanAr → smArabic
  51: 24, // langArmenian → smArmenian
  52: 23, // langGeorgian → smGeorgian
  53: 7, // langMoldavian → smCyrillic
  54: 7, // langKirghiz → smCyrillic
  55: 7, // langTajiki → smCyrillic
  56: 7, // langTurkmen → smCyrillic
  57: 27, // langMongolian → smMongolian
  58: 7, // langMongolianCyr → smCyrillic
  59: 4, // langPashto → smArabic
  60: 4, // langKurdish → smArabic
  61: 4, // langKashmiri → smArabic
  62: 4, // langSindhi → smArabic
  63: 26, // langTibetan → smTibetan
  64: 9, // langNepali → smDevanagari
  65: 9, // langSanskrit → smDevanagari
  66: 9, // langMarathi → smDevanagari
  67: 13, // langBengali → smBengali
  68: 13, // langAssamese → smBengali
  69: 11, // langGujarati → smGujarati
  70: 10, // langPunjabi → smGurmukhi
  71: 12, // langOriya → smOriya
  72: 17, // langMalayalam → smMalayalam
  73: 16, // langKannada → smKannada
  74: 14, // langTamil → smTamil
  75: 15, // langTelugu → smTelugu
  76: 18, // langSinhalese → smSinhalese
  77: 19, // langBurmese → smBurmese
  78: 20, // langKhmer → smKhmer
  79: 22, // langLao → smLao
  80: 30, // langVietnamese → smVietnamese
  81: 0, // langIndonesian → smRoman
  82: 0, // langTagalog → smRoman
  83: 0, // langMalayRoman → smRoman
  84: 4, // langMalayArabic → smArabic
  85: 28, // langAmharic → smEthiopic
  86: 28, // langTigrinya → smEthiopic
  87: 28, // langOromo → smEthiopic
  88: 0, // langSomali → smRoman
  89: 0, // langSwahili → smRoman
  90: 0, // langKinyarwanda → smRoman
  91: 0, // langRundi → smRoman
  92: 0, // langNyanja → smRoman
  93: 0, // langMalagasy → smRoman
  94: 0, // langEsperanto → smRoman
  128: 0, // langWelsh → smRoman (modified)
  129: 0, // langBasque → smRoman
  130: 0, // langCatalan → smRoman
  131: 0, // langLatin → smRoman
  132: 0, // langQuechua → smRoman
  133: 0, // langGuarani → smRoman
  134: 0, // langAymara → smRoman
  135: 7, // langTatar → smCyrillic
  136: 4, // langUighur → smArabic
  137: 26, // langDzongkha → smTibetan
  138: 0, // langJavaneseRom → smRoman
  139: 0, // langSundaneseRom → smRoman
  140: 0, // langGalician → smRoman
  141: 0, // langAfrikaans → smRoman
  142: 0, // langBreton → smRoman (modified)
  143: 28, // langInuktitut → smEthiopic (modified)
  144: 0, // langScottishGaelic → smRoman (modified)
  145: 0, // langManxGaelic → smRoman (modified)
  146: 0, // langIrishGaelicScript → smRoman (modified)
  147: 0, // langTongan → smRoman
  148: 6, // langGreekAncient → smRoman
  149: 0, // langGreenlandic → smRoman
  150: 0, // langAzerbaijanRoman → smRoman
  151: 0, // langNynorsk → smRoman
};

// While Microsoft indicates a region/country for all its language
// IDs, we omit the region code if it's equal to the "most likely
// region subtag" according to Unicode CLDR. For scripts, we omit
// the subtag if it is equal to the Suppress-Script entry in the
// IANA language subtag registry for IETF BCP 47.
//
// For example, Microsoft states that its language code 0x041A is
// Croatian in Croatia. We transform this to the BCP 47 language code 'hr'
// and not 'hr-HR' because Croatia is the default country for Croatian,
// according to Unicode CLDR. As another example, Microsoft states
// that 0x101A is Croatian (Latin) in Bosnia-Herzegovina. We transform
// this to 'hr-BA' and not 'hr-Latn-BA' because Latin is the default script
// for the Croatian language, according to IANA.
//
// http://www.unicode.org/cldr/charts/latest/supplemental/likely_subtags.html
// http://www.iana.org/assignments/language-subtag-registry/language-subtag-registry
const windowsLanguages = {
  0x0436: 'af',
  0x041C: 'sq',
  0x0484: 'gsw',
  0x045E: 'am',
  0x1401: 'ar-DZ',
  0x3C01: 'ar-BH',
  0x0C01: 'ar',
  0x0801: 'ar-IQ',
  0x2C01: 'ar-JO',
  0x3401: 'ar-KW',
  0x3001: 'ar-LB',
  0x1001: 'ar-LY',
  0x1801: 'ary',
  0x2001: 'ar-OM',
  0x4001: 'ar-QA',
  0x0401: 'ar-SA',
  0x2801: 'ar-SY',
  0x1C01: 'aeb',
  0x3801: 'ar-AE',
  0x2401: 'ar-YE',
  0x042B: 'hy',
  0x044D: 'as',
  0x082C: 'az-Cyrl',
  0x042C: 'az',
  0x046D: 'ba',
  0x042D: 'eu',
  0x0423: 'be',
  0x0845: 'bn',
  0x0445: 'bn-IN',
  0x201A: 'bs-Cyrl',
  0x141A: 'bs',
  0x047E: 'br',
  0x0402: 'bg',
  0x0403: 'ca',
  0x0C04: 'zh-HK',
  0x1404: 'zh-MO',
  0x0804: 'zh',
  0x1004: 'zh-SG',
  0x0404: 'zh-TW',
  0x0483: 'co',
  0x041A: 'hr',
  0x101A: 'hr-BA',
  0x0405: 'cs',
  0x0406: 'da',
  0x048C: 'prs',
  0x0465: 'dv',
  0x0813: 'nl-BE',
  0x0413: 'nl',
  0x0C09: 'en-AU',
  0x2809: 'en-BZ',
  0x1009: 'en-CA',
  0x2409: 'en-029',
  0x4009: 'en-IN',
  0x1809: 'en-IE',
  0x2009: 'en-JM',
  0x4409: 'en-MY',
  0x1409: 'en-NZ',
  0x3409: 'en-PH',
  0x4809: 'en-SG',
  0x1C09: 'en-ZA',
  0x2C09: 'en-TT',
  0x0809: 'en-GB',
  0x0409: 'en',
  0x3009: 'en-ZW',
  0x0425: 'et',
  0x0438: 'fo',
  0x0464: 'fil',
  0x040B: 'fi',
  0x080C: 'fr-BE',
  0x0C0C: 'fr-CA',
  0x040C: 'fr',
  0x140C: 'fr-LU',
  0x180C: 'fr-MC',
  0x100C: 'fr-CH',
  0x0462: 'fy',
  0x0456: 'gl',
  0x0437: 'ka',
  0x0C07: 'de-AT',
  0x0407: 'de',
  0x1407: 'de-LI',
  0x1007: 'de-LU',
  0x0807: 'de-CH',
  0x0408: 'el',
  0x046F: 'kl',
  0x0447: 'gu',
  0x0468: 'ha',
  0x040D: 'he',
  0x0439: 'hi',
  0x040E: 'hu',
  0x040F: 'is',
  0x0470: 'ig',
  0x0421: 'id',
  0x045D: 'iu',
  0x085D: 'iu-Latn',
  0x083C: 'ga',
  0x0434: 'xh',
  0x0435: 'zu',
  0x0410: 'it',
  0x0810: 'it-CH',
  0x0411: 'ja',
  0x044B: 'kn',
  0x043F: 'kk',
  0x0453: 'km',
  0x0486: 'quc',
  0x0487: 'rw',
  0x0441: 'sw',
  0x0457: 'kok',
  0x0412: 'ko',
  0x0440: 'ky',
  0x0454: 'lo',
  0x0426: 'lv',
  0x0427: 'lt',
  0x082E: 'dsb',
  0x046E: 'lb',
  0x042F: 'mk',
  0x083E: 'ms-BN',
  0x043E: 'ms',
  0x044C: 'ml',
  0x043A: 'mt',
  0x0481: 'mi',
  0x047A: 'arn',
  0x044E: 'mr',
  0x047C: 'moh',
  0x0450: 'mn',
  0x0850: 'mn-CN',
  0x0461: 'ne',
  0x0414: 'nb',
  0x0814: 'nn',
  0x0482: 'oc',
  0x0448: 'or',
  0x0463: 'ps',
  0x0415: 'pl',
  0x0416: 'pt',
  0x0816: 'pt-PT',
  0x0446: 'pa',
  0x046B: 'qu-BO',
  0x086B: 'qu-EC',
  0x0C6B: 'qu',
  0x0418: 'ro',
  0x0417: 'rm',
  0x0419: 'ru',
  0x243B: 'smn',
  0x103B: 'smj-NO',
  0x143B: 'smj',
  0x0C3B: 'se-FI',
  0x043B: 'se',
  0x083B: 'se-SE',
  0x203B: 'sms',
  0x183B: 'sma-NO',
  0x1C3B: 'sms',
  0x044F: 'sa',
  0x1C1A: 'sr-Cyrl-BA',
  0x0C1A: 'sr',
  0x181A: 'sr-Latn-BA',
  0x081A: 'sr-Latn',
  0x046C: 'nso',
  0x0432: 'tn',
  0x045B: 'si',
  0x041B: 'sk',
  0x0424: 'sl',
  0x2C0A: 'es-AR',
  0x400A: 'es-BO',
  0x340A: 'es-CL',
  0x240A: 'es-CO',
  0x140A: 'es-CR',
  0x1C0A: 'es-DO',
  0x300A: 'es-EC',
  0x440A: 'es-SV',
  0x100A: 'es-GT',
  0x480A: 'es-HN',
  0x080A: 'es-MX',
  0x4C0A: 'es-NI',
  0x180A: 'es-PA',
  0x3C0A: 'es-PY',
  0x280A: 'es-PE',
  0x500A: 'es-PR',

  // Microsoft has defined two different language codes for
  // “Spanish with modern sorting” and “Spanish with traditional
  // sorting”. This makes sense for collation APIs, and it would be
  // possible to express this in BCP 47 language tags via Unicode
  // extensions (eg., es-u-co-trad is Spanish with traditional
  // sorting). However, for storing names in fonts, the distinction
  // does not make sense, so we give “es” in both cases.
  0x0C0A: 'es',
  0x040A: 'es',

  0x540A: 'es-US',
  0x380A: 'es-UY',
  0x200A: 'es-VE',
  0x081D: 'sv-FI',
  0x041D: 'sv',
  0x045A: 'syr',
  0x0428: 'tg',
  0x085F: 'tzm',
  0x0449: 'ta',
  0x0444: 'tt',
  0x044A: 'te',
  0x041E: 'th',
  0x0451: 'bo',
  0x041F: 'tr',
  0x0442: 'tk',
  0x0480: 'ug',
  0x0422: 'uk',
  0x042E: 'hsb',
  0x0420: 'ur',
  0x0843: 'uz-Cyrl',
  0x0443: 'uz',
  0x042A: 'vi',
  0x0452: 'cy',
  0x0488: 'wo',
  0x0485: 'sah',
  0x0478: 'ii',
  0x046A: 'yo',
};

// Returns a IETF BCP 47 language code, for example 'zh-Hant'
// for 'Chinese in the traditional script'.
function getLanguageCode(platformID, languageID, ltag) {
  switch (platformID) {
    case 0: // Unicode
      if (languageID === 0xFFFF) {
        return 'und';
      } if (ltag) {
        return ltag[languageID];
      }

      break;

    case 1: // Macintosh
      return macLanguages[languageID];

    case 3: // Windows
      return windowsLanguages[languageID];
  }

  return undefined;
}

const utf16 = 'utf-16';

// MacOS script ID → encoding. This table stores the default case,
// which can be overridden by macLanguageEncodings.
const macScriptEncodings = {
  0: 'macintosh', // smRoman
  1: 'x-mac-japanese', // smJapanese
  2: 'x-mac-chinesetrad', // smTradChinese
  3: 'x-mac-korean', // smKorean
  6: 'x-mac-greek', // smGreek
  7: 'x-mac-cyrillic', // smCyrillic
  9: 'x-mac-devanagai', // smDevanagari
  10: 'x-mac-gurmukhi', // smGurmukhi
  11: 'x-mac-gujarati', // smGujarati
  12: 'x-mac-oriya', // smOriya
  13: 'x-mac-bengali', // smBengali
  14: 'x-mac-tamil', // smTamil
  15: 'x-mac-telugu', // smTelugu
  16: 'x-mac-kannada', // smKannada
  17: 'x-mac-malayalam', // smMalayalam
  18: 'x-mac-sinhalese', // smSinhalese
  19: 'x-mac-burmese', // smBurmese
  20: 'x-mac-khmer', // smKhmer
  21: 'x-mac-thai', // smThai
  22: 'x-mac-lao', // smLao
  23: 'x-mac-georgian', // smGeorgian
  24: 'x-mac-armenian', // smArmenian
  25: 'x-mac-chinesesimp', // smSimpChinese
  26: 'x-mac-tibetan', // smTibetan
  27: 'x-mac-mongolian', // smMongolian
  28: 'x-mac-ethiopic', // smEthiopic
  29: 'x-mac-ce', // smCentralEuroRoman
  30: 'x-mac-vietnamese', // smVietnamese
  31: 'x-mac-extarabic', // smExtArabic
};

// MacOS language ID → encoding. This table stores the exceptional
// cases, which override macScriptEncodings. For writing MacOS naming
// tables, we need to emit a MacOS script ID. Therefore, we cannot
// merge macScriptEncodings into macLanguageEncodings.
//
// http://unicode.org/Public/MAPPINGS/VENDORS/APPLE/Readme.txt
const macLanguageEncodings = {
  15: 'x-mac-icelandic', // langIcelandic
  17: 'x-mac-turkish', // langTurkish
  18: 'x-mac-croatian', // langCroatian
  24: 'x-mac-ce', // langLithuanian
  25: 'x-mac-ce', // langPolish
  26: 'x-mac-ce', // langHungarian
  27: 'x-mac-ce', // langEstonian
  28: 'x-mac-ce', // langLatvian
  30: 'x-mac-icelandic', // langFaroese
  37: 'x-mac-romanian', // langRomanian
  38: 'x-mac-ce', // langCzech
  39: 'x-mac-ce', // langSlovak
  40: 'x-mac-ce', // langSlovenian
  143: 'x-mac-inuit', // langInuktitut
  146: 'x-mac-gaelic', // langIrishGaelicScript
};

function getEncoding(platformID, encodingID, languageID) {
  switch (platformID) {
    case 0: // Unicode
      return utf16;

    case 1: // Apple Macintosh
      return macLanguageEncodings[languageID] || macScriptEncodings[encodingID];

    case 3: // Microsoft Windows
      if (encodingID === 1 || encodingID === 10) {
        return utf16;
      }

      break;
  }

  return undefined;
}

// Parse the naming `name` table.
// FIXME: Format 1 additional fields are not supported yet.
// ltag is the content of the `ltag' table, such as ['en', 'zh-Hans', 'de-CH-1904'].
export function parseNameTable(data, start, ltag) {
  const name = {};
  const p = new parse.Parser(data, start);
  const format = p.parseUShort();
  const count = p.parseUShort();
  const stringOffset = p.offset + p.parseUShort();
  for (let i = 0; i < count; i++) {
    const platformID = p.parseUShort();
    const encodingID = p.parseUShort();
    const languageID = p.parseUShort();
    const nameID = p.parseUShort();
    const property = nameTableNames[nameID] || nameID;
    const byteLength = p.parseUShort();
    const offset = p.parseUShort();
    const language = getLanguageCode(platformID, languageID, ltag);
    const encoding = getEncoding(platformID, encodingID, languageID);
    if (encoding !== undefined && language !== undefined) {
      let text;
      if (encoding === utf16) {
        text = decode.UTF16(data, stringOffset + offset, byteLength);
      } else {
        text = decode.MACSTRING(data, stringOffset + offset, byteLength, encoding);
      }

      if (text) {
        let translations = name[property];
        if (translations === undefined) {
          translations = name[property] = {};
        }

        translations[language] = text;
      }
    }
  }

  if (format === 1) {
    // FIXME: Also handle Microsoft's 'name' table 1.
    p.parseUShort();
  }

  return name;
}

// {23: 'foo'} → {'foo': 23}
// ['bar', 'baz'] → {'bar': 0, 'baz': 1}
function reverseDict(dict) {
  const result = {};
  for (const key in dict) {
    result[dict[key]] = parseInt(key);
  }

  return result;
}

function makeNameRecord(platformID, encodingID, languageID, nameID, length, offset) {
  return new table.Record('NameRecord', [
    { name: 'platformID', type: 'USHORT', value: platformID },
    { name: 'encodingID', type: 'USHORT', value: encodingID },
    { name: 'languageID', type: 'USHORT', value: languageID },
    { name: 'nameID', type: 'USHORT', value: nameID },
    { name: 'length', type: 'USHORT', value: length },
    { name: 'offset', type: 'USHORT', value: offset },
  ]);
}

// Finds the position of needle in haystack, or -1 if not there.
// Like String.indexOf(), but for arrays.
function findSubArray(needle, haystack) {
  const needleLength = needle.length;
  const limit = haystack.length - needleLength + 1;

  loop:
  for (let pos = 0; pos < limit; pos++) {
    for (; pos < limit; pos++) {
      for (let k = 0; k < needleLength; k++) {
        if (haystack[pos + k] !== needle[k]) {
          continue loop;
        }
      }

      return pos;
    }
  }

  return -1;
}

function addStringToPool(s, pool) {
  let offset = findSubArray(s, pool);
  if (offset < 0) {
    offset = pool.length;
    let i = 0;
    const len = s.length;
    for (; i < len; ++i) {
      pool.push(s[i]);
    }
  }

  return offset;
}

export function makeNameTable(names, ltag) {
  let nameID;
  const nameIDs = [];

  const namesWithNumericKeys = {};
  const nameTableIds = reverseDict(nameTableNames);
  for (const key in names) {
    let id = nameTableIds[key];
    if (id === undefined) {
      id = key;
    }

    nameID = parseInt(id);

    if (Number.isNaN(nameID)) {
      throw new Error(`Name table entry "${key}" does not exist, see nameTableNames for complete list.`);
    }

    namesWithNumericKeys[nameID] = names[key];
    nameIDs.push(nameID);
  }

  const macLanguageIds = reverseDict(macLanguages);
  const windowsLanguageIds = reverseDict(windowsLanguages);

  const nameRecords = [];
  const stringPool = [];

  for (let i = 0; i < nameIDs.length; i++) {
    nameID = nameIDs[i];
    const translations = namesWithNumericKeys[nameID];
    for (const lang in translations) {
      const text = translations[lang];

      // For MacOS, we try to emit the name in the form that was introduced
      // in the initial version of the TrueType spec (in the late 1980s).
      // However, this can fail for various reasons: the requested BCP 47
      // language code might not have an old-style Mac equivalent;
      // we might not have a codec for the needed character encoding;
      // or the name might contain characters that cannot be expressed
      // in the old-style Macintosh encoding. In case of failure, we emit
      // the name in a more modern fashion (Unicode encoding with BCP 47
      // language tags) that is recognized by MacOS 10.5, released in 2009.
      // If fonts were only read by operating systems, we could simply
      // emit all names in the modern form; this would be much easier.
      // However, there are many applications and libraries that read
      // 'name' tables directly, and these will usually only recognize
      // the ancient form (silently skipping the unrecognized names).
      let macPlatform = 1; // Macintosh
      let macLanguage = macLanguageIds[lang];
      let macScript = macLanguageToScript[macLanguage];
      const macEncoding = getEncoding(macPlatform, macScript, macLanguage);
      let macName = encode.MACSTRING(text, macEncoding);
      if (macName === undefined) {
        macPlatform = 0; // Unicode
        macLanguage = ltag.indexOf(lang);
        if (macLanguage < 0) {
          macLanguage = ltag.length;
          ltag.push(lang);
        }

        macScript = 4; // Unicode 2.0 and later
        macName = encode.UTF16(text);
      }

      const macNameOffset = addStringToPool(macName, stringPool);
      nameRecords.push(makeNameRecord(macPlatform, macScript, macLanguage,
        nameID, macName.length, macNameOffset));

      const winLanguage = windowsLanguageIds[lang];
      if (winLanguage !== undefined) {
        const winName = encode.UTF16(text);
        const winNameOffset = addStringToPool(winName, stringPool);
        nameRecords.push(makeNameRecord(3, 1, winLanguage,
          nameID, winName.length, winNameOffset));
      }
    }
  }

  nameRecords.sort((a, b) => ((a.platformID - b.platformID)
                || (a.encodingID - b.encodingID)
                || (a.languageID - b.languageID)
                || (a.nameID - b.nameID)));

  // Pre-encode the name table header and records as direct bytes.
  // Header: format(2) + count(2) + stringOffset(2) = 6 bytes
  // Each record: platformID(2) + encodingID(2) + languageID(2) + nameID(2) + length(2) + offset(2) = 12 bytes
  const headerAndRecords = new Array(6 + nameRecords.length * 12);
  // format = 0
  headerAndRecords[0] = 0; headerAndRecords[1] = 0;
  // count
  headerAndRecords[2] = (nameRecords.length >> 8) & 0xFF;
  headerAndRecords[3] = nameRecords.length & 0xFF;
  // stringOffset
  const stringOffset = 6 + nameRecords.length * 12;
  headerAndRecords[4] = (stringOffset >> 8) & 0xFF;
  headerAndRecords[5] = stringOffset & 0xFF;

  for (let r = 0; r < nameRecords.length; r++) {
    const rec = nameRecords[r];
    const off = 6 + r * 12;
    headerAndRecords[off] = (rec.platformID >> 8) & 0xFF;
    headerAndRecords[off + 1] = rec.platformID & 0xFF;
    headerAndRecords[off + 2] = (rec.encodingID >> 8) & 0xFF;
    headerAndRecords[off + 3] = rec.encodingID & 0xFF;
    headerAndRecords[off + 4] = (rec.languageID >> 8) & 0xFF;
    headerAndRecords[off + 5] = rec.languageID & 0xFF;
    headerAndRecords[off + 6] = (rec.nameID >> 8) & 0xFF;
    headerAndRecords[off + 7] = rec.nameID & 0xFF;
    headerAndRecords[off + 8] = (rec.length >> 8) & 0xFF;
    headerAndRecords[off + 9] = rec.length & 0xFF;
    headerAndRecords[off + 10] = (rec.offset >> 8) & 0xFF;
    headerAndRecords[off + 11] = rec.offset & 0xFF;
  }

  return new table.Table('name', [
    { name: 'header', type: 'LITERAL', value: headerAndRecords },
    { name: 'strings', type: 'LITERAL', value: stringPool },
  ]);
}

// --- os2 table ---
// The `OS/2` table contains metrics required in OpenType fonts.
// https://www.microsoft.com/typography/OTSPEC/os2.htm

const unicodeRanges = [
  { begin: 0x0000, end: 0x007F }, // Basic Latin
  { begin: 0x0080, end: 0x00FF }, // Latin-1 Supplement
  { begin: 0x0100, end: 0x017F }, // Latin Extended-A
  { begin: 0x0180, end: 0x024F }, // Latin Extended-B
  { begin: 0x0250, end: 0x02AF }, // IPA Extensions
  { begin: 0x02B0, end: 0x02FF }, // Spacing Modifier Letters
  { begin: 0x0300, end: 0x036F }, // Combining Diacritical Marks
  { begin: 0x0370, end: 0x03FF }, // Greek and Coptic
  { begin: 0x2C80, end: 0x2CFF }, // Coptic
  { begin: 0x0400, end: 0x04FF }, // Cyrillic
  { begin: 0x0530, end: 0x058F }, // Armenian
  { begin: 0x0590, end: 0x05FF }, // Hebrew
  { begin: 0xA500, end: 0xA63F }, // Vai
  { begin: 0x0600, end: 0x06FF }, // Arabic
  { begin: 0x07C0, end: 0x07FF }, // NKo
  { begin: 0x0900, end: 0x097F }, // Devanagari
  { begin: 0x0980, end: 0x09FF }, // Bengali
  { begin: 0x0A00, end: 0x0A7F }, // Gurmukhi
  { begin: 0x0A80, end: 0x0AFF }, // Gujarati
  { begin: 0x0B00, end: 0x0B7F }, // Oriya
  { begin: 0x0B80, end: 0x0BFF }, // Tamil
  { begin: 0x0C00, end: 0x0C7F }, // Telugu
  { begin: 0x0C80, end: 0x0CFF }, // Kannada
  { begin: 0x0D00, end: 0x0D7F }, // Malayalam
  { begin: 0x0E00, end: 0x0E7F }, // Thai
  { begin: 0x0E80, end: 0x0EFF }, // Lao
  { begin: 0x10A0, end: 0x10FF }, // Georgian
  { begin: 0x1B00, end: 0x1B7F }, // Balinese
  { begin: 0x1100, end: 0x11FF }, // Hangul Jamo
  { begin: 0x1E00, end: 0x1EFF }, // Latin Extended Additional
  { begin: 0x1F00, end: 0x1FFF }, // Greek Extended
  { begin: 0x2000, end: 0x206F }, // General Punctuation
  { begin: 0x2070, end: 0x209F }, // Superscripts And Subscripts
  { begin: 0x20A0, end: 0x20CF }, // Currency Symbol
  { begin: 0x20D0, end: 0x20FF }, // Combining Diacritical Marks For Symbols
  { begin: 0x2100, end: 0x214F }, // Letterlike Symbols
  { begin: 0x2150, end: 0x218F }, // Number Forms
  { begin: 0x2190, end: 0x21FF }, // Arrows
  { begin: 0x2200, end: 0x22FF }, // Mathematical Operators
  { begin: 0x2300, end: 0x23FF }, // Miscellaneous Technical
  { begin: 0x2400, end: 0x243F }, // Control Pictures
  { begin: 0x2440, end: 0x245F }, // Optical Character Recognition
  { begin: 0x2460, end: 0x24FF }, // Enclosed Alphanumerics
  { begin: 0x2500, end: 0x257F }, // Box Drawing
  { begin: 0x2580, end: 0x259F }, // Block Elements
  { begin: 0x25A0, end: 0x25FF }, // Geometric Shapes
  { begin: 0x2600, end: 0x26FF }, // Miscellaneous Symbols
  { begin: 0x2700, end: 0x27BF }, // Dingbats
  { begin: 0x3000, end: 0x303F }, // CJK Symbols And Punctuation
  { begin: 0x3040, end: 0x309F }, // Hiragana
  { begin: 0x30A0, end: 0x30FF }, // Katakana
  { begin: 0x3100, end: 0x312F }, // Bopomofo
  { begin: 0x3130, end: 0x318F }, // Hangul Compatibility Jamo
  { begin: 0xA840, end: 0xA87F }, // Phags-pa
  { begin: 0x3200, end: 0x32FF }, // Enclosed CJK Letters And Months
  { begin: 0x3300, end: 0x33FF }, // CJK Compatibility
  { begin: 0xAC00, end: 0xD7AF }, // Hangul Syllables
  { begin: 0xD800, end: 0xDFFF }, // Non-Plane 0 *
  { begin: 0x10900, end: 0x1091F }, // Phoenicia
  { begin: 0x4E00, end: 0x9FFF }, // CJK Unified Ideographs
  { begin: 0xE000, end: 0xF8FF }, // Private Use Area (plane 0)
  { begin: 0x31C0, end: 0x31EF }, // CJK Strokes
  { begin: 0xFB00, end: 0xFB4F }, // Alphabetic Presentation Forms
  { begin: 0xFB50, end: 0xFDFF }, // Arabic Presentation Forms-A
  { begin: 0xFE20, end: 0xFE2F }, // Combining Half Marks
  { begin: 0xFE10, end: 0xFE1F }, // Vertical Forms
  { begin: 0xFE50, end: 0xFE6F }, // Small Form Variants
  { begin: 0xFE70, end: 0xFEFF }, // Arabic Presentation Forms-B
  { begin: 0xFF00, end: 0xFFEF }, // Halfwidth And Fullwidth Forms
  { begin: 0xFFF0, end: 0xFFFF }, // Specials
  { begin: 0x0F00, end: 0x0FFF }, // Tibetan
  { begin: 0x0700, end: 0x074F }, // Syriac
  { begin: 0x0780, end: 0x07BF }, // Thaana
  { begin: 0x0D80, end: 0x0DFF }, // Sinhala
  { begin: 0x1000, end: 0x109F }, // Myanmar
  { begin: 0x1200, end: 0x137F }, // Ethiopic
  { begin: 0x13A0, end: 0x13FF }, // Cherokee
  { begin: 0x1400, end: 0x167F }, // Unified Canadian Aboriginal Syllabics
  { begin: 0x1680, end: 0x169F }, // Ogham
  { begin: 0x16A0, end: 0x16FF }, // Runic
  { begin: 0x1780, end: 0x17FF }, // Khmer
  { begin: 0x1800, end: 0x18AF }, // Mongolian
  { begin: 0x2800, end: 0x28FF }, // Braille Patterns
  { begin: 0xA000, end: 0xA48F }, // Yi Syllables
  { begin: 0x1700, end: 0x171F }, // Tagalog
  { begin: 0x10300, end: 0x1032F }, // Old Italic
  { begin: 0x10330, end: 0x1034F }, // Gothic
  { begin: 0x10400, end: 0x1044F }, // Deseret
  { begin: 0x1D000, end: 0x1D0FF }, // Byzantine Musical Symbols
  { begin: 0x1D400, end: 0x1D7FF }, // Mathematical Alphanumeric Symbols
  { begin: 0xFF000, end: 0xFFFFD }, // Private Use (plane 15)
  { begin: 0xFE00, end: 0xFE0F }, // Variation Selectors
  { begin: 0xE0000, end: 0xE007F }, // Tags
  { begin: 0x1900, end: 0x194F }, // Limbu
  { begin: 0x1950, end: 0x197F }, // Tai Le
  { begin: 0x1980, end: 0x19DF }, // New Tai Lue
  { begin: 0x1A00, end: 0x1A1F }, // Buginese
  { begin: 0x2C00, end: 0x2C5F }, // Glagolitic
  { begin: 0x2D30, end: 0x2D7F }, // Tifinagh
  { begin: 0x4DC0, end: 0x4DFF }, // Yijing Hexagram Symbols
  { begin: 0xA800, end: 0xA82F }, // Syloti Nagri
  { begin: 0x10000, end: 0x1007F }, // Linear B Syllabary
  { begin: 0x10140, end: 0x1018F }, // Ancient Greek Numbers
  { begin: 0x10380, end: 0x1039F }, // Ugaritic
  { begin: 0x103A0, end: 0x103DF }, // Old Persian
  { begin: 0x10450, end: 0x1047F }, // Shavian
  { begin: 0x10480, end: 0x104AF }, // Osmanya
  { begin: 0x10800, end: 0x1083F }, // Cypriot Syllabary
  { begin: 0x10A00, end: 0x10A5F }, // Kharoshthi
  { begin: 0x1D300, end: 0x1D35F }, // Tai Xuan Jing Symbols
  { begin: 0x12000, end: 0x123FF }, // Cuneiform
  { begin: 0x1D360, end: 0x1D37F }, // Counting Rod Numerals
  { begin: 0x1B80, end: 0x1BBF }, // Sundanese
  { begin: 0x1C00, end: 0x1C4F }, // Lepcha
  { begin: 0x1C50, end: 0x1C7F }, // Ol Chiki
  { begin: 0xA880, end: 0xA8DF }, // Saurashtra
  { begin: 0xA900, end: 0xA92F }, // Kayah Li
  { begin: 0xA930, end: 0xA95F }, // Rejang
  { begin: 0xAA00, end: 0xAA5F }, // Cham
  { begin: 0x10190, end: 0x101CF }, // Ancient Symbols
  { begin: 0x101D0, end: 0x101FF }, // Phaistos Disc
  { begin: 0x102A0, end: 0x102DF }, // Carian
  { begin: 0x1F030, end: 0x1F09F }, // Domino Tiles
];

export function getUnicodeRange(unicode) {
  for (let i = 0; i < unicodeRanges.length; i += 1) {
    const range = unicodeRanges[i];
    if (unicode >= range.begin && unicode < range.end) {
      return i;
    }
  }

  return -1;
}

// Parse the OS/2 and Windows metrics `OS/2` table
export function parseOS2Table(data, start) {
  const os2 = {};
  const p = new parse.Parser(data, start);
  os2.version = p.parseUShort();
  os2.xAvgCharWidth = p.parseShort();
  os2.usWeightClass = p.parseUShort();
  os2.usWidthClass = p.parseUShort();
  os2.fsType = p.parseUShort();
  os2.ySubscriptXSize = p.parseShort();
  os2.ySubscriptYSize = p.parseShort();
  os2.ySubscriptXOffset = p.parseShort();
  os2.ySubscriptYOffset = p.parseShort();
  os2.ySuperscriptXSize = p.parseShort();
  os2.ySuperscriptYSize = p.parseShort();
  os2.ySuperscriptXOffset = p.parseShort();
  os2.ySuperscriptYOffset = p.parseShort();
  os2.yStrikeoutSize = p.parseShort();
  os2.yStrikeoutPosition = p.parseShort();
  os2.sFamilyClass = p.parseShort();
  os2.panose = [];
  for (let i = 0; i < 10; i++) {
    os2.panose[i] = p.parseByte();
  }

  os2.ulUnicodeRange1 = p.parseULong();
  os2.ulUnicodeRange2 = p.parseULong();
  os2.ulUnicodeRange3 = p.parseULong();
  os2.ulUnicodeRange4 = p.parseULong();
  os2.achVendID = String.fromCharCode(p.parseByte(), p.parseByte(), p.parseByte(), p.parseByte());
  os2.fsSelection = p.parseUShort();
  os2.usFirstCharIndex = p.parseUShort();
  os2.usLastCharIndex = p.parseUShort();
  os2.sTypoAscender = p.parseShort();
  os2.sTypoDescender = p.parseShort();
  os2.sTypoLineGap = p.parseShort();
  os2.usWinAscent = p.parseUShort();
  os2.usWinDescent = p.parseUShort();
  if (os2.version >= 1) {
    os2.ulCodePageRange1 = p.parseULong();
    os2.ulCodePageRange2 = p.parseULong();
  }

  if (os2.version >= 2) {
    os2.sxHeight = p.parseShort();
    os2.sCapHeight = p.parseShort();
    os2.usDefaultChar = p.parseUShort();
    os2.usBreakChar = p.parseUShort();
    os2.usMaxContent = p.parseUShort();
  }

  return os2;
}

export function makeOS2Table(options) {
  const o = options || {};
  const d = new Array(96);
  let p = 0;
  writeUint16(d, p, o.version !== undefined ? o.version : 0x0003); p += 2;
  writeInt16(d, p, o.xAvgCharWidth !== undefined ? o.xAvgCharWidth : 0); p += 2;
  writeUint16(d, p, o.usWeightClass !== undefined ? o.usWeightClass : 0); p += 2;
  writeUint16(d, p, o.usWidthClass !== undefined ? o.usWidthClass : 0); p += 2;
  writeUint16(d, p, o.fsType !== undefined ? o.fsType : 0); p += 2;
  writeInt16(d, p, o.ySubscriptXSize !== undefined ? o.ySubscriptXSize : 650); p += 2;
  writeInt16(d, p, o.ySubscriptYSize !== undefined ? o.ySubscriptYSize : 699); p += 2;
  writeInt16(d, p, o.ySubscriptXOffset !== undefined ? o.ySubscriptXOffset : 0); p += 2;
  writeInt16(d, p, o.ySubscriptYOffset !== undefined ? o.ySubscriptYOffset : 140); p += 2;
  writeInt16(d, p, o.ySuperscriptXSize !== undefined ? o.ySuperscriptXSize : 650); p += 2;
  writeInt16(d, p, o.ySuperscriptYSize !== undefined ? o.ySuperscriptYSize : 699); p += 2;
  writeInt16(d, p, o.ySuperscriptXOffset !== undefined ? o.ySuperscriptXOffset : 0); p += 2;
  writeInt16(d, p, o.ySuperscriptYOffset !== undefined ? o.ySuperscriptYOffset : 479); p += 2;
  writeInt16(d, p, o.yStrikeoutSize !== undefined ? o.yStrikeoutSize : 49); p += 2;
  writeInt16(d, p, o.yStrikeoutPosition !== undefined ? o.yStrikeoutPosition : 258); p += 2;
  writeInt16(d, p, o.sFamilyClass !== undefined ? o.sFamilyClass : 0); p += 2;
  // PANOSE (10 BYTE fields)
  d[p++] = o.bFamilyType !== undefined ? o.bFamilyType : 0;
  d[p++] = o.bSerifStyle !== undefined ? o.bSerifStyle : 0;
  d[p++] = o.bWeight !== undefined ? o.bWeight : 0;
  d[p++] = o.bProportion !== undefined ? o.bProportion : 0;
  d[p++] = o.bContrast !== undefined ? o.bContrast : 0;
  d[p++] = o.bStrokeVariation !== undefined ? o.bStrokeVariation : 0;
  d[p++] = o.bArmStyle !== undefined ? o.bArmStyle : 0;
  d[p++] = o.bLetterform !== undefined ? o.bLetterform : 0;
  d[p++] = o.bMidline !== undefined ? o.bMidline : 0;
  d[p++] = o.bXHeight !== undefined ? o.bXHeight : 0;
  writeUint32(d, p, o.ulUnicodeRange1 !== undefined ? o.ulUnicodeRange1 : 0); p += 4;
  writeUint32(d, p, o.ulUnicodeRange2 !== undefined ? o.ulUnicodeRange2 : 0); p += 4;
  writeUint32(d, p, o.ulUnicodeRange3 !== undefined ? o.ulUnicodeRange3 : 0); p += 4;
  writeUint32(d, p, o.ulUnicodeRange4 !== undefined ? o.ulUnicodeRange4 : 0); p += 4;
  // achVendID (CHARARRAY, 4 bytes)
  const vendID = o.achVendID !== undefined ? o.achVendID : 'XXXX';
  for (let i = 0; i < 4; i++) {
    d[p++] = i < vendID.length ? vendID.charCodeAt(i) : 0;
  }
  writeUint16(d, p, o.fsSelection !== undefined ? o.fsSelection : 0); p += 2;
  writeUint16(d, p, o.usFirstCharIndex !== undefined ? o.usFirstCharIndex : 0); p += 2;
  writeUint16(d, p, o.usLastCharIndex !== undefined ? o.usLastCharIndex : 0); p += 2;
  writeInt16(d, p, o.sTypoAscender !== undefined ? o.sTypoAscender : 0); p += 2;
  writeInt16(d, p, o.sTypoDescender !== undefined ? o.sTypoDescender : 0); p += 2;
  writeInt16(d, p, o.sTypoLineGap !== undefined ? o.sTypoLineGap : 0); p += 2;
  writeUint16(d, p, o.usWinAscent !== undefined ? o.usWinAscent : 0); p += 2;
  writeUint16(d, p, o.usWinDescent !== undefined ? o.usWinDescent : 0); p += 2;
  writeUint32(d, p, o.ulCodePageRange1 !== undefined ? o.ulCodePageRange1 : 0); p += 4;
  writeUint32(d, p, o.ulCodePageRange2 !== undefined ? o.ulCodePageRange2 : 0); p += 4;
  writeInt16(d, p, o.sxHeight !== undefined ? o.sxHeight : 0); p += 2;
  writeInt16(d, p, o.sCapHeight !== undefined ? o.sCapHeight : 0); p += 2;
  writeUint16(d, p, o.usDefaultChar !== undefined ? o.usDefaultChar : 0); p += 2;
  writeUint16(d, p, o.usBreakChar !== undefined ? o.usBreakChar : 0); p += 2;
  writeUint16(d, p, o.usMaxContext !== undefined ? o.usMaxContext : 0); p += 2;
  return new table.Table('OS/2', [
    { name: 'data', type: 'LITERAL', value: d },
  ]);
}

// --- post table ---
// The `post` table stores additional PostScript information, such as glyph names.
// https://www.microsoft.com/typography/OTSPEC/post.htm

// Parse the PostScript `post` table
export function parsePostTable(data, start) {
  const post = {};
  const p = new parse.Parser(data, start);
  post.version = p.parseVersion();
  post.italicAngle = p.parseFixed();
  post.underlinePosition = p.parseShort();
  post.underlineThickness = p.parseShort();
  post.isFixedPitch = p.parseULong();
  post.minMemType42 = p.parseULong();
  post.maxMemType42 = p.parseULong();
  post.minMemType1 = p.parseULong();
  post.maxMemType1 = p.parseULong();
  switch (post.version) {
    case 1:
      post.names = standardNames.slice();
      break;
    case 2:
      post.numberOfGlyphs = p.parseUShort();
      post.glyphNameIndex = new Array(post.numberOfGlyphs);
      for (let i = 0; i < post.numberOfGlyphs; i++) {
        post.glyphNameIndex[i] = p.parseUShort();
      }

      post.names = [];
      for (let i = 0; i < post.numberOfGlyphs; i++) {
        if (post.glyphNameIndex[i] >= standardNames.length) {
          const nameLength = p.parseChar();
          post.names.push(p.parseString(nameLength));
        }
      }

      break;
    case 2.5:
      post.numberOfGlyphs = p.parseUShort();
      post.offset = new Array(post.numberOfGlyphs);
      for (let i = 0; i < post.numberOfGlyphs; i++) {
        post.offset[i] = p.parseChar();
      }

      break;
  }
  return post;
}

export function makePostTable() {
  const d = new Array(32);
  let p = 0;
  writeUint32(d, p, 0x00030000); p += 4; // version
  writeUint32(d, p, 0); p += 4; // italicAngle (FIXED)
  writeInt16(d, p, 0); p += 2; // underlinePosition (FWORD)
  writeInt16(d, p, 0); p += 2; // underlineThickness (FWORD)
  writeUint32(d, p, 0); p += 4; // isFixedPitch
  writeUint32(d, p, 0); p += 4; // minMemType42
  writeUint32(d, p, 0); p += 4; // maxMemType42
  writeUint32(d, p, 0); p += 4; // minMemType1
  writeUint32(d, p, 0); p += 4; // maxMemType1
  return new table.Table('post', [
    { name: 'data', type: 'LITERAL', value: d },
  ]);
}

// --- sfnt table ---
// The `sfnt` wrapper provides organization for the tables in the font.
// It is the top-level data structure in a font.
// https://www.microsoft.com/typography/OTSPEC/otff.htm
// Recommendations for creating OpenType Fonts:
// http://www.microsoft.com/typography/otspec140/recom.htm

function log2(v) {
  return Math.log(v) / Math.log(2) | 0;
}

function computeCheckSum(bytes) {
  let sum = 0;
  const len = bytes.length;
  for (let i = 0; i < len; i += 4) {
    sum += ((bytes[i] << 24)
            + ((bytes[i + 1] || 0) << 16)
            + ((bytes[i + 2] || 0) << 8)
            + (bytes[i + 3] || 0));
  }

  sum %= 2 ** 32;
  return sum;
}

// Get the metrics for a character. If the string has more than one character
// this function returns metrics for the first available character.
// You can provide optional fallback metrics if no characters are available.
function metricsForChar(font, chars, notFoundMetrics) {
  for (let i = 0; i < chars.length; i += 1) {
    const glyphIndex = font.charToGlyphIndex(chars[i]);
    if (glyphIndex > 0) {
      const glyph = font.glyphs.get(glyphIndex);
      return glyph.getMetrics();
    }
  }

  return notFoundMetrics;
}

function average(vs) {
  let sum = 0;
  for (let i = 0; i < vs.length; i += 1) {
    sum += vs[i];
  }

  return sum / vs.length;
}

// Convert the font object to a SFNT data structure.
// This structure contains all the necessary tables and metadata to create a binary OTF file.
function fontToSfntTable(font) {
  const xMins = [];
  const yMins = [];
  const xMaxs = [];
  const yMaxs = [];
  const advanceWidths = [];
  const leftSideBearings = [];
  const rightSideBearings = [];
  let firstCharIndex;
  let lastCharIndex = 0;
  let ulUnicodeRange1 = 0;
  let ulUnicodeRange2 = 0;
  let ulUnicodeRange3 = 0;
  let ulUnicodeRange4 = 0;

  for (let i = 0; i < font.glyphs.length; i += 1) {
    const glyph = font.glyphs.get(i);
    const unicode = glyph.unicode | 0;

    if (typeof glyph.advanceWidth !== 'number') {
      throw new Error(`Glyph ${glyph.name} (${i}): advanceWidth is not a number.`);
    }

    if (firstCharIndex > unicode || firstCharIndex === undefined) {
      // ignore .notdef char
      if (unicode > 0) {
        firstCharIndex = unicode;
      }
    }

    if (lastCharIndex < unicode) {
      lastCharIndex = unicode;
    }

    const position = getUnicodeRange(unicode);
    if (position < 32) {
      ulUnicodeRange1 |= 1 << position;
    } else if (position < 64) {
      ulUnicodeRange2 |= 1 << position - 32;
    } else if (position < 96) {
      ulUnicodeRange3 |= 1 << position - 64;
    } else if (position < 123) {
      ulUnicodeRange4 |= 1 << position - 96;
    } else {
      throw new Error('Unicode ranges bits > 123 are reserved for internal usage');
    }
    // Skip non-important characters.
    if (glyph.name === '.notdef') continue;
    const metrics = glyph.getMetrics();
    xMins.push(glyph._xMin !== undefined ? glyph._xMin : metrics.xMin);
    yMins.push(glyph._yMin !== undefined ? glyph._yMin : metrics.yMin);
    xMaxs.push(glyph._xMax !== undefined ? glyph._xMax : metrics.xMax);
    yMaxs.push(glyph._yMax !== undefined ? glyph._yMax : metrics.yMax);
    leftSideBearings.push(metrics.leftSideBearing);
    rightSideBearings.push(metrics.rightSideBearing);
    advanceWidths.push(glyph.advanceWidth);
  }

  const globals = {
    xMin: Math.min.apply(null, xMins),
    yMin: Math.min.apply(null, yMins),
    xMax: Math.max.apply(null, xMaxs),
    yMax: Math.max.apply(null, yMaxs),
    advanceWidthMax: Math.max.apply(null, advanceWidths),
    advanceWidthAvg: average(advanceWidths),
    minLeftSideBearing: Math.min.apply(null, leftSideBearings),
    maxLeftSideBearing: Math.max.apply(null, leftSideBearings),
    minRightSideBearing: Math.min.apply(null, rightSideBearings),
  };
  globals.ascender = font.ascender;
  globals.descender = font.descender;

  const headOptions = {
    flags: 3, // 00000011 (baseline for font at y=0; left sidebearing point at x=0)
    unitsPerEm: font.unitsPerEm,
    xMin: globals.xMin,
    yMin: globals.yMin,
    xMax: globals.xMax,
    yMax: globals.yMax,
    lowestRecPPEM: 3,
    createdTimestamp: font.createdTimestamp,
  };

  const isTrueType = font.outlinesFormat === 'truetype';

  // For TrueType: build glyf+loca first so we know indexToLocFormat for head table
  let glyfResult;
  if (isTrueType) {
    glyfResult = makeGlyfTable(font.glyphs);
    headOptions.indexToLocFormat = glyfResult.indexToLocFormat;
  }

  const headTable = makeHeadTable(headOptions);

  const hheaTable = makeHheaTable({
    ascender: globals.ascender,
    descender: globals.descender,
    advanceWidthMax: globals.advanceWidthMax,
    minLeftSideBearing: globals.minLeftSideBearing,
    minRightSideBearing: globals.minRightSideBearing,
    xMaxExtent: globals.maxLeftSideBearing + (globals.xMax - globals.xMin),
    numberOfHMetrics: font.glyphs.length,
  });

  let hintingMetrics = null;
  if (isTrueType && font.tables.maxp) {
    const m = font.tables.maxp;
    hintingMetrics = {
      maxZones: m.maxZones || 1,
      maxTwilightPoints: m.maxTwilightPoints || 0,
      maxStorage: m.maxStorage || 0,
      maxFunctionDefs: m.maxFunctionDefs || 0,
      maxInstructionDefs: m.maxInstructionDefs || 0,
      maxStackElements: m.maxStackElements || 0,
      maxSizeOfInstructions: Math.max(
        glyfResult.maxSizeOfInstructions || 0,
        m.maxSizeOfInstructions || 0,
        font.tables.fpgm ? font.tables.fpgm.length : 0,
        font.tables.prep ? font.tables.prep.length : 0,
      ),
    };
  }
  const maxpTable = isTrueType
    ? makeMaxpTableTrueType(font.glyphs.length, glyfResult.maxPoints, glyfResult.maxContours,
      glyfResult.maxCompositePoints, glyfResult.maxCompositeContours, glyfResult.maxComponentElements,
      glyfResult.maxComponentDepth, hintingMetrics)
    : makeMaxpTable(font.glyphs.length);

  const os2Table = makeOS2Table({
    xAvgCharWidth: Math.round(globals.advanceWidthAvg),
    usFirstCharIndex: firstCharIndex,
    usLastCharIndex: lastCharIndex,
    ulUnicodeRange1,
    ulUnicodeRange2,
    ulUnicodeRange3,
    ulUnicodeRange4,
    // See http://typophile.com/node/13081 for more info on vertical metrics.
    // We get metrics for typical characters (such as "x" for xHeight).
    // We provide some fallback characters if characters are unavailable: their
    // ordering was chosen experimentally.
    sTypoAscender: globals.ascender,
    sTypoDescender: globals.descender,
    sTypoLineGap: 0,
    usWinAscent: globals.yMax,
    usWinDescent: Math.abs(globals.yMin),
    ulCodePageRange1: 1, // FIXME: hard-code Latin 1 support for now
    sxHeight: metricsForChar(font, 'xyvw', { yMax: Math.round(globals.ascender / 2) }).yMax,
    sCapHeight: metricsForChar(font, 'HIKLEFJMNTZBDPRAGOQSUVWXY', globals).yMax,
    usDefaultChar: font.hasChar(' ') ? 32 : 0, // Use space as the default character, if available.
    usBreakChar: font.hasChar(' ') ? 32 : 0, // Use space as the break character, if available.
    ...font.tables.os2,
  });

  const hmtxTable = makeHmtxTable(font.glyphs);
  const cmapTable = makeCmapTable(font.glyphs);

  const englishFamilyName = font.getEnglishName('fontFamily');
  const englishStyleName = font.getEnglishName('fontSubfamily');
  const englishFullName = `${englishFamilyName} ${englishStyleName}`;
  let postScriptName = font.getEnglishName('postScriptName');
  if (!postScriptName) {
    postScriptName = `${englishFamilyName.replace(/\s/g, '')}-${englishStyleName}`;
  }

  const names = {};
  for (const n in font.names) {
    names[n] = font.names[n];
  }

  if (!names.uniqueID) {
    names.uniqueID = { en: `${font.getEnglishName('manufacturer')}:${englishFullName}` };
  }

  if (!names.postScriptName) {
    names.postScriptName = { en: postScriptName };
  }

  if (!names.preferredFamily) {
    names.preferredFamily = font.names.fontFamily;
  }

  if (!names.preferredSubfamily) {
    names.preferredSubfamily = font.names.fontSubfamily;
  }

  const languageTags = [];
  const nameTable = makeNameTable(names, languageTags);
  const ltagTable = (languageTags.length > 0 ? makeLtagTable(languageTags) : undefined);

  const postTable = makePostTable();

  const metaTable = (font.metas && Object.keys(font.metas).length > 0) ? makeMetaTable(font.metas) : undefined;

  const tables = [headTable, hheaTable, maxpTable, os2Table, nameTable, cmapTable, postTable, hmtxTable];
  if (isTrueType) {
    tables.push(glyfResult.glyfTable, glyfResult.locaTable);
    if (font.tables.cvt) {
      const cvtData = [];
      for (let i = 0; i < font.tables.cvt.length; i++) {
        pushInt16(cvtData, font.tables.cvt[i]);
      }
      tables.push(new table.Table('cvt ', [{ name: 'data', type: 'LITERAL', value: cvtData }]));
    }
    if (font.tables.fpgm) {
      tables.push(new table.Table('fpgm', [{ name: 'data', type: 'LITERAL', value: font.tables.fpgm }]));
    }
    if (font.tables.prep) {
      tables.push(new table.Table('prep', [{ name: 'data', type: 'LITERAL', value: font.tables.prep }]));
    }
  } else {
    tables.push(makeCFFTable(font.glyphs, {
      version: font.getEnglishName('version'),
      fullName: englishFullName,
      familyName: englishFamilyName,
      weightName: englishStyleName,
      postScriptName,
      unitsPerEm: font.unitsPerEm,
      fontBBox: [0, globals.yMin, globals.ascender, globals.advanceWidthMax],
    }));
  }
  if (ltagTable) {
    tables.push(ltagTable);
  }
  // Optional tables
  if (font.tables.gsub) {
    tables.push(makeGsubTable(font.tables.gsub));
  }
  if (font.kerningPairs && Object.keys(font.kerningPairs).length > 0) {
    tables.push(makeGposTable(font.kerningPairs));
  }
  if (font.tables.cpal) {
    tables.push(makeCpalTable(font.tables.cpal));
  }
  if (font.tables.colr) {
    tables.push(makeColrTable(font.tables.colr));
  }
  if (metaTable) {
    tables.push(metaTable);
  }

  // Encode each table once and assemble the SFNT binary directly.
  const encodedTables = [];
  for (let i = 0; i < tables.length; i += 1) {
    const t = tables[i];
    check.argument(t.tableName.length === 4, `Table name${t.tableName} is invalid.`);
    const bytes = t.encode();
    encodedTables.push({
      tag: t.tableName,
      bytes,
      checkSum: computeCheckSum(bytes),
      length: bytes.length,
    });
  }

  // Table records must be sorted alphabetically by tag.
  encodedTables.sort((a, b) => {
    if (a.tag > b.tag) {
      return 1;
    }
    return -1;
  });

  // Calculate SFNT header values.
  const numTables = encodedTables.length;
  const highestPowerOf2 = 2 ** log2(numTables);
  const searchRange = 16 * highestPowerOf2;
  const entrySelector = log2(highestPowerOf2);
  const rangeShift = numTables * 16 - searchRange;

  // Calculate total size and per-table offsets.
  const headerSize = 12;
  const directorySize = numTables * 16;
  let dataOffset = headerSize + directorySize;
  while (dataOffset % 4 !== 0) {
    dataOffset += 1;
  }

  const tableOffsets = [];
  let totalSize = dataOffset;
  for (let i = 0; i < encodedTables.length; i += 1) {
    tableOffsets.push(totalSize);
    totalSize += encodedTables[i].length;
    while (totalSize % 4 !== 0) {
      totalSize += 1;
    }
  }

  // Allocate the final buffer and write the SFNT header.
  const result = new Uint8Array(totalSize);
  const view = new DataView(result.buffer);
  // sfVersion: 'OTTO' for CFF, 0x00010000 for TrueType
  if (isTrueType) {
    result[0] = 0x00; result[1] = 0x01; result[2] = 0x00; result[3] = 0x00;
  } else {
    result[0] = 0x4F; result[1] = 0x54; result[2] = 0x54; result[3] = 0x4F;
  }
  view.setUint16(4, numTables);
  view.setUint16(6, searchRange);
  view.setUint16(8, entrySelector);
  view.setUint16(10, rangeShift);

  // Write table directory records and table data.
  let headTableOffset = -1;
  for (let i = 0; i < numTables; i += 1) {
    const t = encodedTables[i];
    const recordOffset = headerSize + i * 16;
    // Write tag (4 ASCII bytes).
    for (let j = 0; j < 4; j += 1) {
      result[recordOffset + j] = t.tag.charCodeAt(j);
    }

    view.setUint32(recordOffset + 4, t.checkSum);
    view.setUint32(recordOffset + 8, tableOffsets[i]);
    view.setUint32(recordOffset + 12, t.length);
    // Write table data.
    result.set(t.bytes, tableOffsets[i]);
    if (t.tag === 'head') {
      headTableOffset = tableOffsets[i];
    }
  }

  // Compute the font's overall checksum and patch head.checkSumAdjustment.
  check.argument(headTableOffset >= 0, 'Could not find head table with checkSum to adjust.');
  const fontCheckSum = computeCheckSumFromUint8Array(result);
  // checkSumAdjustment is at byte offset 8 within the head table.
  view.setUint32(headTableOffset + 8, (0xB1B0AFBA - fontCheckSum) >>> 0);

  return result;
}

/**
 * Compute a checksum over a Uint8Array without mutating it.
 * @param {Uint8Array} bytes
 * @returns {number}
 */
function computeCheckSumFromUint8Array(bytes) {
  let sum = 0;
  const len = bytes.length;
  for (let i = 0; i < len; i += 4) {
    sum += ((bytes[i] << 24)
            + ((bytes[i + 1] || 0) << 16)
            + ((bytes[i + 2] || 0) << 8)
            + (bytes[i + 3] || 0));
  }

  sum %= 2 ** 32;
  return sum;
}

/**
 * The opentype library.
 * @namespace opentype
 */

// Table Directory Entries //////////////////////////////////////////////
/**
 * Parses OpenType table entries.
 * @param  {DataView} data
 * @param  {number} numTables
 * @return {Object[]}
 */
function parseOpenTypeTableEntries(data, numTables) {
  const tableEntries = [];
  let p = 12;
  for (let i = 0; i < numTables; i += 1) {
    const tag = parse.getTag(data, p);
    const checksum = parse.getULong(data, p + 4);
    const offset = parse.getULong(data, p + 8);
    const length = parse.getULong(data, p + 12);
    tableEntries.push({
      tag, checksum, offset, length, compression: false,
    });
    p += 16;
  }

  return tableEntries;
}

/**
 * Parses WOFF table entries.
 * @param  {DataView} data
 * @param  {number} numTables
 * @return {Object[]}
 */
function parseWOFFTableEntries(data, numTables) {
  const tableEntries = [];
  let p = 44; // offset to the first table directory entry.
  for (let i = 0; i < numTables; i += 1) {
    const tag = parse.getTag(data, p);
    const offset = parse.getULong(data, p + 4);
    const compLength = parse.getULong(data, p + 8);
    const origLength = parse.getULong(data, p + 12);
    let compression;
    if (compLength < origLength) {
      compression = 'WOFF';
    } else {
      compression = false;
    }

    tableEntries.push({
      tag,
      offset,
      compression,
      compressedLength: compLength,
      length: origLength,
    });
    p += 20;
  }

  return tableEntries;
}

/**
 * @typedef TableData
 * @type Object
 * @property {DataView} data - The DataView
 * @property {number} offset - The data offset.
 */

/**
 * @param  {DataView} data
 * @param  {Object} tableEntry
 */
function uncompressTable(data, tableEntry) {
  if (tableEntry.compression === 'WOFF') {
    const inBuffer = new Uint8Array(data.buffer, tableEntry.offset + 2, tableEntry.compressedLength - 2);
    const outBuffer = inflateRaw(inBuffer);
    if (outBuffer.byteLength !== tableEntry.length) {
      throw new Error(`Decompression error: ${tableEntry.tag} decompressed length doesn't match recorded length`);
    }

    const view = new DataView(outBuffer.buffer, 0);
    return { data: view, offset: 0 };
  }
  return { data, offset: tableEntry.offset };
}

// Public API ///////////////////////////////////////////////////////////

/**
 * Parse the OpenType file data (as an ArrayBuffer) and return a Font object.
 * Throws an error if the font could not be parsed.
 * @param  {ArrayBuffer} buffer
 * @param  {Object} [options={}]
 */
function parseBuffer(buffer, options = {}) {
  const skipTables = options.skipTables ? new Set(options.skipTables) : null;
  let indexToLocFormat;
  let ltagTable;

  // Since the constructor can also be called to create new fonts from scratch, we indicate this
  // should be an empty font that we'll fill with our own data.
  const font = new Font({ empty: true });

  // OpenType fonts use big endian byte ordering.
  // We can't rely on typed array view types, because they operate with the endianness of the host computer.
  // Instead we use DataViews where we can specify endianness.
  const data = new DataView(buffer, 0);
  let numTables;
  let tableEntries = [];
  const signature = parse.getTag(data, 0);
  if (signature === String.fromCharCode(0, 1, 0, 0) || signature === 'true' || signature === 'typ1') {
    font.outlinesFormat = 'truetype';
    numTables = parse.getUShort(data, 4);
    tableEntries = parseOpenTypeTableEntries(data, numTables);
  } else if (signature === 'OTTO') {
    font.outlinesFormat = 'cff';
    numTables = parse.getUShort(data, 4);
    tableEntries = parseOpenTypeTableEntries(data, numTables);
  } else if (signature === 'wOFF') {
    const flavor = parse.getTag(data, 4);
    if (flavor === String.fromCharCode(0, 1, 0, 0)) {
      font.outlinesFormat = 'truetype';
    } else if (flavor === 'OTTO') {
      font.outlinesFormat = 'cff';
    } else {
      throw new Error(`Unsupported OpenType flavor ${signature}`);
    }

    numTables = parse.getUShort(data, 12);
    tableEntries = parseWOFFTableEntries(data, numTables);
  } else {
    throw new Error(`Unsupported OpenType signature ${signature}`);
  }

  let cffTableEntry;
  let glyfTableEntry;
  let gposTableEntry;
  let gsubTableEntry;
  let hmtxTableEntry;
  let kernTableEntry;
  let locaTableEntry;
  let nameTableEntry;
  let metaTableEntry;
  let p;

  for (let i = 0; i < numTables; i += 1) {
    const tableEntry = tableEntries[i];
    if (skipTables && skipTables.has(tableEntry.tag)) continue;
    let table;
    switch (tableEntry.tag) {
      case 'cmap':
        table = uncompressTable(data, tableEntry);
        font.tables.cmap = parseCmapTable(table.data, table.offset);
        font.encoding = new CmapEncoding(font.tables.cmap);
        break;
      case 'cvt ':
        table = uncompressTable(data, tableEntry);
        p = new parse.Parser(table.data, table.offset);
        font.tables.cvt = p.parseShortList(tableEntry.length / 2);
        break;
      case 'fpgm':
        table = uncompressTable(data, tableEntry);
        p = new parse.Parser(table.data, table.offset);
        font.tables.fpgm = p.parseByteList(tableEntry.length);
        break;
      case 'head':
        table = uncompressTable(data, tableEntry);
        font.tables.head = parseHeadTable(table.data, table.offset);
        font.unitsPerEm = font.tables.head.unitsPerEm;
        indexToLocFormat = font.tables.head.indexToLocFormat;
        break;
      case 'hhea':
        table = uncompressTable(data, tableEntry);
        font.tables.hhea = parseHheaTable(table.data, table.offset);
        font.ascender = font.tables.hhea.ascender;
        font.descender = font.tables.hhea.descender;
        font.numberOfHMetrics = font.tables.hhea.numberOfHMetrics;
        break;
      case 'hmtx':
        hmtxTableEntry = tableEntry;
        break;
      case 'ltag':
        table = uncompressTable(data, tableEntry);
        ltagTable = parseLtagTable(table.data, table.offset);
        break;
      case 'COLR':
        table = uncompressTable(data, tableEntry);
        font.tables.colr = parseColrTable(table.data, table.offset);
        break;
      case 'CPAL':
        table = uncompressTable(data, tableEntry);
        font.tables.cpal = parseCpalTable(table.data, table.offset);
        break;
      case 'maxp':
        table = uncompressTable(data, tableEntry);
        font.tables.maxp = parseMaxpTable(table.data, table.offset);
        font.numGlyphs = font.tables.maxp.numGlyphs;
        break;
      case 'name':
        nameTableEntry = tableEntry;
        break;
      case 'OS/2':
        table = uncompressTable(data, tableEntry);
        font.tables.os2 = parseOS2Table(table.data, table.offset);
        break;
      case 'post':
        table = uncompressTable(data, tableEntry);
        font.tables.post = parsePostTable(table.data, table.offset);
        {
          const post = font.tables.post;
          let glyphNames;
          switch (post.version) {
            case 1:
              glyphNames = standardNames.slice();
              break;
            case 2:
              glyphNames = new Array(post.numberOfGlyphs);
              for (let j = 0; j < post.numberOfGlyphs; j++) {
                if (post.glyphNameIndex[j] < standardNames.length) {
                  glyphNames[j] = standardNames[post.glyphNameIndex[j]];
                } else {
                  glyphNames[j] = post.names[post.glyphNameIndex[j] - standardNames.length];
                }
              }
              break;
            case 2.5:
              glyphNames = new Array(post.numberOfGlyphs);
              for (let j = 0; j < post.numberOfGlyphs; j++) {
                glyphNames[j] = standardNames[j + post.glyphNameIndex[j]];
              }
              break;
            default:
              glyphNames = [];
              break;
          }
          font.glyphNames = { names: glyphNames };
        }
        break;
      case 'prep':
        table = uncompressTable(data, tableEntry);
        p = new parse.Parser(table.data, table.offset);
        font.tables.prep = p.parseByteList(tableEntry.length);
        break;
      case 'glyf':
        glyfTableEntry = tableEntry;
        break;
      case 'loca':
        locaTableEntry = tableEntry;
        break;
      case 'CFF ':
        cffTableEntry = tableEntry;
        break;
      case 'kern':
        kernTableEntry = tableEntry;
        break;
      case 'GPOS':
        gposTableEntry = tableEntry;
        break;
      case 'GSUB':
        gsubTableEntry = tableEntry;
        break;
      case 'meta':
        metaTableEntry = tableEntry;
        break;
    }
  }

  const nameTable = uncompressTable(data, nameTableEntry);
  font.tables.name = parseNameTable(nameTable.data, nameTable.offset, ltagTable);
  font.names = font.tables.name;

  if (glyfTableEntry && locaTableEntry) {
    const shortVersion = indexToLocFormat === 0;
    const locaTable = uncompressTable(data, locaTableEntry);
    const locaOffsets = parseLocaTable(locaTable.data, locaTable.offset, font.numGlyphs, shortVersion);
    const glyfTable = uncompressTable(data, glyfTableEntry);
    font.glyphs = parseGlyfTable(glyfTable.data, glyfTable.offset, locaOffsets, font);
  } else if (cffTableEntry) {
    const cffTable = uncompressTable(data, cffTableEntry);
    parseCFFTable(cffTable.data, cffTable.offset, font);
  } else {
    throw new Error('Font doesn\'t contain TrueType or CFF outlines.');
  }

  const hmtxTable = uncompressTable(data, hmtxTableEntry);
  parseHmtxTable(hmtxTable.data, hmtxTable.offset, font.numberOfHMetrics, font.numGlyphs, font.glyphs);
  addGlyphNames(font);

  if (kernTableEntry) {
    const kernTable = uncompressTable(data, kernTableEntry);
    font.kerningPairs = parseKernTable(kernTable.data, kernTable.offset);
  } else {
    font.kerningPairs = {};
  }

  if (gposTableEntry) {
    const gposTable = uncompressTable(data, gposTableEntry);
    font.tables.gpos = parseGposTable(gposTable.data, gposTable.offset);
    font.position.init();
  }

  if (gsubTableEntry) {
    const gsubTable = uncompressTable(data, gsubTableEntry);
    font.tables.gsub = parseGsubTable(gsubTable.data, gsubTable.offset);
  }

  if (metaTableEntry) {
    const metaTable = uncompressTable(data, metaTableEntry);
    font.tables.meta = parseMetaTable(metaTable.data, metaTable.offset);
    font.metas = font.tables.meta;
  }

  return font;
}

/**
 * Convert the font object to a SFNT data structure.
 * This structure contains all the necessary tables and metadata to create a binary OTF file.
 */
Font.prototype.toTables = function () {
  return fontToSfntTable(this);
};

/**
 * Converts a Font into an ArrayBuffer
 * @return {ArrayBuffer}
 */
Font.prototype.toArrayBuffer = function () {
  const bytes = this.toTables();
  return bytes.buffer;
};

export {
  Font,
  Glyph,
  Path,
  BoundingBox,
  parseCFFTable,
  parseType1Font,
  parseBuffer as parse,
};
