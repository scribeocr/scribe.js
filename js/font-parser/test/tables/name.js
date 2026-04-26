import assert from 'assert';
import { table, encode } from '../../src/types.js';
import { parseNameTable as _parseNameTable, makeNameTable as _makeNameTable } from '../../src/opentype.js';
import { hex, unhex } from '../testutil.js';

// For testing, we need a custom function that builds name tables.
// The public name.make() API of opentype.js is hiding the complexity
// of the various historic encodings and language identification
// systems that are used in OpenType and TrueType. Instead, it emits a
// simple JavaScript dictionary keyed by IETF BCP 47 language codes,
// which is the same format that is used for HTML and XML language
// tags.  That is convenient for users of opentype.js, but it
// complicates testing.
function makeNameTable(names) {
  const t = new table.Table('name', [
    { name: 'format', type: 'USHORT', value: 0 },
    { name: 'count', type: 'USHORT', value: names.length },
    { name: 'stringOffset', type: 'USHORT', value: 6 + names.length * 12 },
  ]);
  const stringPool = [];

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const text = unhex(name[1]);
    t.fields.push({ name: `platformID_${i}`, type: 'USHORT', value: name[2] });
    t.fields.push({ name: `encodingID_${i}`, type: 'USHORT', value: name[3] });
    t.fields.push({ name: `languageID_${i}`, type: 'USHORT', value: name[4] });
    t.fields.push({ name: `nameID_${i}`, type: 'USHORT', value: name[0] });
    t.fields.push({ name: `length_${i}`, type: 'USHORT', value: text.byteLength });
    t.fields.push({ name: `offset_${i}`, type: 'USHORT', value: stringPool.length });
    for (let j = 0; j < text.byteLength; j++) {
      stringPool.push(text.getUint8(j));
    }
  }

  t.fields.push({ name: 'strings', type: 'LITERAL', value: stringPool });

  const bytes = encode.TABLE(t);
  const data = new DataView(new ArrayBuffer(bytes.length), 0);
  for (let k = 0; k < bytes.length; k++) {
    data.setUint8(k, bytes[k]);
  }

  return data;
}

function parseNameTable(names, ltag) {
  return _parseNameTable(makeNameTable(names), 0, ltag);
}

function getNameRecords(nameTable) {
  // Encode the table to bytes, then parse name records from the binary.
  const bytes = encode.TABLE(nameTable);
  const result = [];
  const count = (bytes[2] << 8) | bytes[3];
  const stringOffset = (bytes[4] << 8) | bytes[5];

  for (let i = 0; i < count; i++) {
    const off = 6 + i * 12;
    const platformID = (bytes[off] << 8) | bytes[off + 1];
    const encodingID = (bytes[off + 2] << 8) | bytes[off + 3];
    const languageID = (bytes[off + 4] << 8) | bytes[off + 5];
    const nameID = (bytes[off + 6] << 8) | bytes[off + 7];
    const length = (bytes[off + 8] << 8) | bytes[off + 9];
    const strOff = (bytes[off + 10] << 8) | bytes[off + 11];

    const encodedText = bytes.slice(stringOffset + strOff, stringOffset + strOff + length);

    const plat = {
      0: 'Uni', 1: 'Mac', 2: 'ISO', 3: 'Win',
    }[platformID] || platformID;
    let enc;
    let lang;
    if (platformID === 0) {
      enc = { 3: 'UCS-2', 4: 'UTF-16' }[encodingID];
      lang = undefined;
    } else if (platformID === 1) {
      enc = { 0: 'smRoman', 28: 'smEthiopic' }[encodingID];
      lang = {
        0: 'langEnglish',
        2: 'langGerman',
        81: 'langIndonesian',
        143: 'langInuktitut',
      }[languageID];
    } else if (platformID === 3) {
      enc = { 1: 'UCS-2', 10: 'UCS-4' }[encodingID];
      lang = {
        0x0407: 'German/Germany',
        0x0409: 'English/US',
        0x0411: 'Japanese/Japan',
        0x0421: 'Indonesian/Indonesia',
        0x045d: 'Inuktitut/Canada',
        0x085d: 'Inuktitut-Latin/Canada',
      }[languageID];
    } else {
      enc = lang = undefined;
    }

    result.push(`${plat} ${enc || encodingID
    } ${lang || languageID
    } N${nameID
    } [${hex(encodedText)}]`);
  }

  return result;
}

describe('tables/name.js', () => {
  it('can parse a naming table', () => {
    assert.deepEqual(parseNameTable([
      [1, '0057 0061 006C 0072 0075 0073', 3, 1, 0x0409],
      [1, '140A 1403 1555 1585', 3, 1, 0x045D],
      [1, '0041 0069 0076 0069 0071', 3, 1, 0x085D],
      [1, '6D77 99AC', 3, 1, 0x0411],
      [300, '42 6C 61 63 6B 20 43 6F 6E 64 65 6E 73 65 64', 1, 0, 0],
      [300, '4B 6F 79 75 20 53 DD 6B DD DF DD 6B', 1, 35, 17],
      [300, '8F EE EB F3 F7 E5 F0 20 F2 E5 F1 E5 ED', 1, 7, 44],
      [44444, '004C 0069 0070 0073 0074 0069 0063 006B 0020 D83D DC84', 3, 10, 0x0409],
    ], undefined), {
      fontFamily: {
        en: 'Walrus',
        iu: 'ᐊᐃᕕᖅ',
        'iu-Latn': 'Aiviq',
        ja: '海馬',
      },
      300: {
        bg: 'Получер тесен',
        en: 'Black Condensed',
        tr: 'Koyu Sıkışık',
      },
      44444: {
        en: 'Lipstick 💄',
      },
    });
  });

  it('can parse a naming table which refers to an ‘ltag’ table', () => {
    const ltag = ['en', 'de', 'de-1901'];
    assert.deepEqual(parseNameTable([
      [1, '0057 0061 006C 0072 0075 0073', 0, 4, 0],
      [1, '0057 0061 006C 0072 006F 0073 0073', 0, 4, 1],
      [1, '0057 0061 006C 0072 006F 00DF', 0, 4, 2],
      [999, '0057 0061 006C 0072 0075 0073 002D 0054 0068 0069 006E', 0, 4, 0xFFFF],
    ], ltag), {
      fontFamily: {
        de: 'Walross',
        'de-1901': 'Walroß',
        en: 'Walrus',
      },
      999: {
        und: 'Walrus-Thin',
      },
    });
  });

  it('ignores name records for unknown platforms', () => {
    assert.deepEqual(parseNameTable([
      [1, '01 02', 666, 1, 1],
    ]), {});
  });

  it('can make a naming table', () => {
    // This is an interesting test case for various reasons:
    // * Indonesian ('id') uses the same string as English,
    //   so we exercise the building of string pools;
    const names = {
      fontFamily: {
        en: 'Walrus',
        de: 'Walross',
        id: 'Walrus',
      },
    };
    const ltag = [];
    assert.deepEqual(getNameRecords(_makeNameTable(names, ltag)), [
      'Mac smRoman langEnglish N1 [57 61 6C 72 75 73]',
      'Mac smRoman langGerman N1 [57 61 6C 72 6F 73 73]',
      'Mac smRoman langIndonesian N1 [57 61 6C 72 75 73]',
      'Win UCS-2 German/Germany N1 [00 57 00 61 00 6C 00 72 00 6F 00 73 00 73]',
      'Win UCS-2 English/US N1 [00 57 00 61 00 6C 00 72 00 75 00 73]',
      'Win UCS-2 Indonesian/Indonesia N1 [00 57 00 61 00 6C 00 72 00 75 00 73]',
    ]);
    assert.deepEqual(ltag, []);
  });

  it('can make a naming table that refers to a language tag table', () => {
    // Neither Windows nor MacOS define a numeric language code
    // for “German in the traditional orthography” (de-1901).
    // Windows has one for “Inuktitut in Latin” (iu-Latn),
    // but MacOS does not.
    const names = {
      fontFamily: {
        'de-1901': 'Walroß',
        'iu-Latn': 'Aiviq',
      },
    };
    const ltag = [];
    assert.deepEqual(getNameRecords(_makeNameTable(names, ltag)), [
      'Uni UTF-16 0 N1 [00 57 00 61 00 6C 00 72 00 6F 00 DF]',
      'Uni UTF-16 1 N1 [00 41 00 69 00 76 00 69 00 71]',
      'Win UCS-2 Inuktitut-Latin/Canada N1 [00 41 00 69 00 76 00 69 00 71]',
    ]);
    assert.deepEqual(ltag, ['de-1901', 'iu-Latn']);
  });

  it('can make a naming table for languages in unsupported scripts', () => {
    // MacJapanese would need very large tables for conversion,
    // so we do not ship a codec for this encoding in opentype.js.
    // The implementation should fall back to emitting Unicode strings
    // with a BCP 47 language code; only newer versions of MacOS will
    // recognize it but this is better than stripping the string away.
    const names = {
      fontFamily: {
        ja: '海馬',
      },
    };
    const ltag = [];
    assert.deepEqual(getNameRecords(_makeNameTable(names, ltag)), [
      'Uni UTF-16 0 N1 [6D 77 99 AC]',
      'Win UCS-2 Japanese/Japan N1 [6D 77 99 AC]',
    ]);
    assert.deepEqual(ltag, ['ja']);
  });

  it('can make a naming table for English names with unusual characters', () => {
    // The MacRoman encoding has no interrobang character. When
    // building a name table, this case should be handled gracefully.
    const names = {
      fontFamily: {
        en: 'Hello‽',
      },
    };
    const ltag = [];
    assert.deepEqual(getNameRecords(_makeNameTable(names, ltag)), [
      'Uni UTF-16 0 N1 [00 48 00 65 00 6C 00 6C 00 6F 20 3D]',
      'Win UCS-2 English/US N1 [00 48 00 65 00 6C 00 6C 00 6F 20 3D]',
    ]);
    assert.deepEqual(ltag, ['en']);
  });

  it('can make a naming table for languages with unusual Mac script codes', () => {
    // Inuktitut ('iu') has a very unusual MacOS script code (smEthiopic)
    // although there are probably not too many Inuit in Ethiopia.
    // Apple had run out of script codes and needed a quick hack.
    // The implementation uses a secondary look-up table for handling such
    // corner cases (Inuktitut is not the only one), and this test exercises it.
    const names = {
      fontFamily: {
        iu: 'ᐊᐃᕕᖅ',
      },
    };
    const ltag = [];
    assert.deepEqual(getNameRecords(_makeNameTable(names, ltag)), [
      'Mac smEthiopic langInuktitut N1 [84 80 CD E7]',
      'Win UCS-2 Inuktitut/Canada N1 [14 0A 14 03 15 55 15 85]',
    ]);
    assert.deepEqual(ltag, []);
  });

  it('can make a naming table with custom names', () => {
    // Custom name for a font variation axis.
    const names = {
      256: {
        en: 'Width',
        de: 'Breite',
      },
    };
    const ltag = [];
    assert.deepEqual(getNameRecords(_makeNameTable(names, ltag)), [
      'Mac smRoman langEnglish N256 [57 69 64 74 68]',
      'Mac smRoman langGerman N256 [42 72 65 69 74 65]',
      'Win UCS-2 German/Germany N256 [00 42 00 72 00 65 00 69 00 74 00 65]',
      'Win UCS-2 English/US N256 [00 57 00 69 00 64 00 74 00 68]',
    ]);
    assert.deepEqual(ltag, []);
  });
});
