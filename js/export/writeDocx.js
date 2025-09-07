import { documentEnd, documentStart, docxStrings } from './resources/docxFiles.js';

import { writeText } from './writeText.js';

import { opt } from '../containers/app.js';

/**
 * Create a Word document from an array of ocrPage objects.
 *
 * @param {Object} params
 * @param {Array<OcrPage>} params.hocrCurrent -
 * @param {number} [params.minpage=0] - The first page to include in the document.
 * @param {number} [params.maxpage=-1] - The last page to include in the document.
 */
export async function writeDocx({ hocrCurrent, minpage = 0, maxpage = -1 }) {
  const { Uint8ArrayWriter, TextReader, ZipWriter } = await import('../../lib/zip.js/index.js');

  if (maxpage === -1) maxpage = hocrCurrent.length - 1;

  const zipFileWriter = new Uint8ArrayWriter();
  const zipWriter = new ZipWriter(zipFileWriter);

  const textReader = new TextReader(documentStart + writeText({
    ocrCurrent: hocrCurrent,
    minpage,
    maxpage,
    reflowText: opt.reflow,
    docxMode: true,
  }) + documentEnd);
  await zipWriter.add('word/document.xml', textReader);

  for (let i = 0; i < docxStrings.length; i++) {
    const textReaderI = new TextReader(docxStrings[i].content);
    await zipWriter.add(docxStrings[i].path, textReaderI);
  }

  await zipWriter.close();

  const zipFileData = await zipFileWriter.getData();

  return zipFileData;
}
