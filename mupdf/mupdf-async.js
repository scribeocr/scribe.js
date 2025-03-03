// Copyright (C) 2004-2021 Artifex Software, Inc.
//
// This file is part of MuPDF.
//
// MuPDF is free software: you can redistribute it and/or modify it under the
// terms of the GNU Affero General Public License as published by the Free
// Software Foundation, either version 3 of the License, or (at your option)
// any later version.
//
// MuPDF is distributed in the hope that it will be useful, but WITHOUT ANY
// WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
// FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more
// details.
//
// You should have received a copy of the GNU Affero General Public License
// along with MuPDF. If not, see <https://www.gnu.org/licenses/agpl-3.0.en.html>
//
// Alternative licensing terms are available from the licensor.
// For commercial licensing, see <https://www.artifex.com/> or contact
// Artifex Software, Inc., 1305 Grant Avenue - Suite 200, Novato,
// CA 94945, U.S.A., +1(415)492-9861, for further information.

// import { arrayBufferToBase64 } from "./js/miscUtils.js";
// import Worker from 'web-worker';

export async function initMuPDFWorker() {
  // This method of creating workers works natively in the browser, Node.js, and Webpack 5.
  // Do not change without confirming compatibility with all three.
  console.log('const mupdf = {}');
  const mupdf = {};
  let worker;
  if (typeof process === 'undefined') {
    worker = new Worker(new URL('./mupdf-worker.js', import.meta.url), { type: 'module' });
  } else {
    const WorkerNode = (await import('worker_threads')).Worker;
    worker = new WorkerNode(new URL('./mupdf-worker.js', import.meta.url));
  }

  const errorHandler = (err) => {
    console.error(err);
  };

  if (typeof process === 'undefined') {
    // @ts-ignore
    worker.onerror = errorHandler;
  } else {
    // @ts-ignore
    worker.on('error', errorHandler);
  }

  // There are a number of possible race conditions that can occur when using web workers.
  // It should be assumed that the code in the worker and this function can load in any order.
  // This includes:
  // (1) the worker code loading before the event handler in the main thread is set up
  // (2) the main thread code finishing before the event handler in the worker is set up.
  // To handle this, we currently (1) automatically send a "READY" message from the worker to the main thread
  // when the worker is ready, and (2) send a "PING" message from the main thread to the worker,
  // which causes the worker to send a "READY" message back to the main thread.
  // And (3) automatically reject the promise if the worker does not send a "READY" message within 5 seconds.
  let ready = false;
  let workerResReject;
  let workerResResolve;
  const workerRes = new Promise((resolve, reject) => {
    workerResResolve = resolve;
    workerResReject = reject;
  });

  worker.promises = {};
  worker.promiseId = 0;

  const messageHandler = async (data) => {
    if (typeof data === 'string' && data === 'READY') {
      ready = true;
      console.log(data);
      workerResResolve();
      console.log('return');
      return;
    } else {
      console.log('Other type of message');
    }
    const [type, id, result] = data;
    if (type === 'RESULT') {
      // worker.promises[id].resolve(result);
      if (['drawPageAsPNG'].includes(worker.promises[id].func)) {
        // const n = worker.promises[id].page - 1;
        // await insertImageCache(n, result);
        worker.promises[id].resolve(result);
        delete worker.promises[id];
      } else {
        worker.promises[id].resolve(result);
        delete worker.promises[id];
      }
    } else {

      if (!ready) {
        workerResReject(result);
        return;
      } 

      worker.promises[id].reject(result);
      delete worker.promises[id];
    }
  };

  if (typeof process === 'undefined') {
    // @ts-ignore
    worker.onmessage = (event) => messageHandler(event.data);
  } else {
    // @ts-ignore
    worker.on('message', messageHandler);
  }

  function wrap(func) {
    return function (...args) {
      return new Promise((resolve, reject) => {
        // Add the PDF as the first argument for most functions
        if (!['openDocument', 'cleanFile', 'freeDocument', 'overlayDocuments', 'subsetPages'].includes(func)) {
          // Remove job number (appended by Tesseract scheduler function)
          // args = args.slice(0,-1)

          if (args[0] === undefined) {
            args = [mupdf.pdfDoc];
          } else {
            args = [mupdf.pdfDoc, args[0]];
          }
        }
        const id = worker.promiseId++;
        const page = ['drawPageAsPNG'].includes(func) ? args[1] : null;
        worker.promises[id] = {
          resolve, reject, func, page,
        };

        if (args[0] instanceof ArrayBuffer) {
          worker.postMessage([func, args, id], [args[0]]);
        } else {
          worker.postMessage([func, args, id]);
        }
      });
    };
  }

  mupdf.openDocument = wrap('openDocument');
  mupdf.freeDocument = wrap('freeDocument');
  mupdf.documentTitle = wrap('documentTitle');
  mupdf.documentOutline = wrap('documentOutline');
  mupdf.countPages = wrap('countPages');
  mupdf.pageSizes = wrap('pageSizes');
  mupdf.pageWidth = wrap('pageWidth');
  mupdf.pageHeight = wrap('pageHeight');
  mupdf.pageLinks = wrap('pageLinks');
  mupdf.pageText = wrap('pageText');
  mupdf.pageTextHTML = wrap('pageTextHTML');
  mupdf.pageTextXHTML = wrap('pageTextXHTML');
  mupdf.pageTextXML = wrap('pageTextXML');
  mupdf.pageTextJSON = wrap('pageTextJSON');
  mupdf.extractAllFonts = wrap('extractAllFonts');
  mupdf.search = wrap('search');
  mupdf.drawPageAsPNG = wrap('drawPageAsPNG');
  mupdf.convertImageStart = wrap('convertImageStart');
  mupdf.convertImageAddPage = wrap('convertImageAddPage');
  mupdf.convertImageEnd = wrap('convertImageEnd');
  mupdf.checkNativeText = wrap('checkNativeText');
  mupdf.detectExtractText = wrap('detectExtractText');
  mupdf.save = wrap('save');
  mupdf.run = wrap('run');
  mupdf.cleanFile = wrap('cleanFile');
  mupdf.overlayDocuments = wrap('overlayDocuments');
  mupdf.subsetPages = wrap('subsetPages');
  mupdf.terminate = function () { worker.terminate(); };

  console.log('await readyPromise');

  if (!ready) worker.postMessage(['PING']);

  setTimeout(() => {
    workerResReject(new Error('Worker initialization timed out'));
  }, 5000);

  await workerRes;

  return mupdf;
}
