import assert from 'assert';
import { unhex } from '../testutil.js';
import { parseLocaTable } from '../../src/opentype.js';

describe('tables/loca.js', () => {
  it('can parse the short version', () => {
    const data = unhex('DEAD BEEF 0010 0100 80CE');
    assert.deepEqual([32, 512, 2 * 0x80ce], parseLocaTable(data, 4, 2, true));
  });

  it('can parse the long version', () => {
    const data = unhex('DEADBEEF 00000010 00000100 ABCD5678');
    assert.deepEqual([0x10, 0x100, 0xabcd5678], parseLocaTable(data, 4, 2, false));
  });
});
