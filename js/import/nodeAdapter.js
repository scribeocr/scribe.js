import fs from 'node:fs';
import path from 'node:path';

// Note: Node.js 20 added a File class in the `buffer` module in Node.js 20.0.0,
// so this class can eventually be replaced with that.

/**
 * @param {string} filePath
 */
const isUrl = (filePath) => filePath.startsWith('http://') || filePath.startsWith('https://') || filePath.startsWith('moz-extension://')
  || filePath.startsWith('chrome-extension://') || filePath.startsWith('file://');

/**
 * A simplified version of the browser `File` interface for Node.js.
 */
export class FileNode {
  /**
   * @param {string} filePath
   * @param {string} name - The name of the file.
   */
  constructor(filePath, name) {
    this.filePath = filePath;
    this.name = name;
  }

  /**
   * Read the whole file.
   * @returns {Promise<ArrayBuffer>} A promise that resolves with the file's contents as an ArrayBuffer.
   */
  async arrayBuffer() {
    if (isUrl(this.filePath)) return fetch(this.filePath).then((res) => res.arrayBuffer());
    const buf = await fs.promises.readFile(this.filePath);
    if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) return /** @type {ArrayBuffer} */ (buf.buffer);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }

  /**
   * Read the whole file into shared memory.
   * @returns {Promise<Uint8Array>} A view over a `SharedArrayBuffer` holding the file's contents.
   */
  async sharedBytes() {
    if (isUrl(this.filePath)) {
      const fetched = await fetch(this.filePath).then((res) => res.arrayBuffer());
      const view = new Uint8Array(new SharedArrayBuffer(fetched.byteLength));
      view.set(new Uint8Array(fetched));
      return view;
    }
    const handle = await fs.promises.open(this.filePath, 'r');
    try {
      const { size } = await handle.stat();
      const view = new Uint8Array(new SharedArrayBuffer(size));
      let read = 0;
      while (read < size) {
        const { bytesRead } = await handle.read(view, read, size - read, read);
        if (bytesRead === 0) break;
        read += bytesRead;
      }
      return read === size ? view : view.subarray(0, read);
    } finally {
      await handle.close();
    }
  }
}

/**
 * Wrap paths or URLs as lazy `FileNode` handles.
 * @param {Array<string>} filePaths
 * @returns {Promise<Array<FileNode>>}
 */
export const wrapFilesNode = async (filePaths) => filePaths.map((filePath) => new FileNode(
  filePath,
  isUrl(filePath) ? /** @type {string} */ (filePath.split('/').pop()) : path.basename(filePath),
));
