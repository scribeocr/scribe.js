import { compressChunks, crc32, nodeZlib } from '../utils/byteStream.js';

/**
 * A text file entry in a zip archive.
 * @typedef {Object} ZipEntry
 * @property {string} path
 * @property {string|Iterable<string>} text
 */

/**
 * Write a zip archive of UTF-8 text files as byte chunks.
 * Throws if an entry or the archive exceeds 4 GB.
 * @param {Iterable<ZipEntry>} entries - Each entry's `text` is fully consumed before the next entry is pulled.
 * @returns {AsyncGenerator<Uint8Array>}
 */
export async function* writeZipChunks(entries) {
  const TOO_LARGE = 'The export passes 4 GB, more than a zip file without zip64 holds.';
  const encoder = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  /** @type {Array<Uint8Array>} Central directory file headers. */
  const directory = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0808, true);
    localView.setUint16(8, 8, true);
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    const localOffset = offset;
    offset += local.length;
    yield local;

    let crc = 0;
    let size = 0;
    let packed = 0;
    const pieces = typeof entry.text === 'string' ? [entry.text] : entry.text;
    if (nodeZlib) {
      for (const piece of pieces) {
        const bytes = encoder.encode(piece);
        crc = crc32(bytes, crc);
        size += bytes.length;
        const out = nodeZlib.deflateRawSync(bytes, { finishFlush: nodeZlib.constants.Z_SYNC_FLUSH });
        packed += out.length;
        if (size > 0xFFFFFFFF || offset + packed > 0xFFFFFFFF) throw new Error(TOO_LARGE);
        yield out;
      }
      const last = nodeZlib.deflateRawSync(new Uint8Array(0));
      packed += last.length;
      yield last;
    } else {
      const encoded = (function* encodedPieces() {
        for (const piece of pieces) {
          const bytes = encoder.encode(piece);
          crc = crc32(bytes, crc);
          size += bytes.length;
          yield bytes;
        }
      }());
      for await (const out of compressChunks(encoded, 'deflate-raw')) {
        packed += out.length;
        if (size > 0xFFFFFFFF || offset + packed > 0xFFFFFFFF) throw new Error(TOO_LARGE);
        yield out;
      }
    }
    offset += packed;

    const descriptor = new Uint8Array(12);
    const descriptorView = new DataView(descriptor.buffer);
    descriptorView.setUint32(0, crc, true);
    descriptorView.setUint32(4, packed, true);
    descriptorView.setUint32(8, size, true);
    offset += descriptor.length;
    yield descriptor;

    const record = new Uint8Array(46 + name.length);
    const recordView = new DataView(record.buffer);
    recordView.setUint32(0, 0x02014b50, true);
    recordView.setUint16(4, 20, true);
    recordView.setUint16(6, 20, true);
    recordView.setUint16(8, 0x0808, true);
    recordView.setUint16(10, 8, true);
    recordView.setUint16(12, dosTime, true);
    recordView.setUint16(14, dosDate, true);
    recordView.setUint32(16, crc, true);
    recordView.setUint32(20, packed, true);
    recordView.setUint32(24, size, true);
    recordView.setUint16(28, name.length, true);
    recordView.setUint32(42, localOffset, true);
    record.set(name, 46);
    directory.push(record);
  }

  let directorySize = 0;
  for (const record of directory) {
    directorySize += record.length;
    yield record;
  }
  if (offset + directorySize > 0xFFFFFFFF) throw new Error(TOO_LARGE);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, directory.length, true);
  endView.setUint16(10, directory.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, offset, true);
  yield end;
}
