import fs from 'node:fs';
import path from 'node:path';

// Note: Node.js 20 added a File class in the `buffer` module in Node.js 20.0.0,
// so this class can eventually be replaced with that.

/**
 * Class representing a simplified version of the File interface for Node.js.
 */
export class FileNode {
  /**
   * Creates an instance of the File class.
   * @param {string} filePath - The path to the file.
   * @param {string} name - The name of the file.
   * @param {Buffer} fileData - The file's data.
   */
  constructor(filePath, name, fileData) {
    this.filePath = filePath;
    this.name = name;
    this.fileData = fileData;
  }

  /**
   * Returns an ArrayBuffer with the file's contents.
   * @returns {Promise<ArrayBuffer>} A promise that resolves with the file's contents as an ArrayBuffer.
   */
  async arrayBuffer() {
    return this.fileData.buffer.slice(this.fileData.byteOffset, this.fileData.byteOffset + this.fileData.byteLength);
  }
}

/**
 *
 * @param {Array<string>} filePaths
 * @returns
 */
export const wrapFilesNode = (filePaths) => {
  const filePromises = filePaths.map(async (filePath) => {
    const isUrl = filePath.startsWith('http://') || filePath.startsWith('https://') || filePath.startsWith('moz-extension://')
    || filePath.startsWith('chrome-extension://') || filePath.startsWith('file://');

    const fileData = isUrl ? Buffer.from(await fetch(filePath).then((res) => res.arrayBuffer())) : fs.readFileSync(filePath);

    const fileName = isUrl ? filePath.split('/').pop() : path.basename(filePath);

    return new FileNode(filePath, fileName, fileData);
  });

  return Promise.all(filePromises);
};
