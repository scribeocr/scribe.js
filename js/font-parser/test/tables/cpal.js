import assert from 'assert';
import { hex, unhex } from '../testutil.js';
import { makeCpalTable, parseCpalTable } from '../../src/opentype.js';

describe('tables/cpal.js', () => {
  const data = '00 00 00 02 00 03 00 04 00 00 00 12 00 00 00 01 00 02 '
                 + '88 66 BB AA 00 11 22 33 12 34 56 78 DE AD BE EF';
  const obj = {
    version: 0,
    numPaletteEntries: 2,
    colorRecords: [0x8866BBAA, 0x00112233, 0x12345678, 0xDEADBEEF],
    colorRecordIndices: [0, 1, 2],
  };

  it('can parse cpal table', () => {
    assert.deepStrictEqual(obj, parseCpalTable(unhex(data), 0));
  });

  it('can make cpal table', () => {
    const hexString = hex(makeCpalTable(obj).encode());
    parseCpalTable(unhex(hexString), 0);
    assert.deepStrictEqual(data, hexString);
  });
});
