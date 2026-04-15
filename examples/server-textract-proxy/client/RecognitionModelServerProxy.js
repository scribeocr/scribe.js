// Client-side RecognitionModel that delegates OCR to a server-side Textract proxy.
//
// The stock scribe.js per-page recognition path (used by RecognitionModelTextractBrowser)
// pre-renders every PDF page in the browser and calls `recognizeImage(imageData)` per page.
// When `config.documentMode === true`, scribe.js instead skips pre-rendering, hands the
// whole PDF to `recognizeDocument` once, and consumes an async iterable of per-page raw
// results. That is exactly the shape a streaming HTTP body from a proxy server produces.
//
// Server contract: POST the PDF, receive `application/x-ndjson` where each line is either
//   { "pageNum": <int>, "rawData": "<stringified Textract JSON>" }
// or an error line
//   { "pageNum": <int>, "error": { "message": "..." } }

export class RecognitionModelServerProxy {
  static config = {
    name: 'Server Textract',
    outputFormat: 'textract',
    documentMode: true,
  };

  /**
   * @param {{ pdfBytes: Uint8Array|null, pageCount: number, pageDims: Array<{width:number,height:number}> }} doc
   * @param {{ serverUrl: string, headers?: Record<string,string>, signal?: AbortSignal }} options
   * @returns {AsyncGenerator<{ pageNum: number, rawData?: string, error?: { message: string } }>}
   */
  static async * recognizeDocument(doc, options) {
    if (!options || !options.serverUrl) {
      throw new Error('RecognitionModelServerProxy: modelOptions.serverUrl is required.');
    }
    if (!doc.pdfBytes) {
      throw new Error('RecognitionModelServerProxy: no PDF bytes available (imageMode documents are not supported).');
    }

    // scribe.js forwards its AbortSignal into modelOptions as `signal`. Pass it into
    // fetch() so cancelling a browser-side recognize() tears down the TCP connection,
    // which the server picks up via req.on('close') and uses to abort its own
    // scribe.recognize() call — closing the loop end-to-end.
    const res = await fetch(options.serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf', ...(options.headers || {}) },
      body: doc.pdfBytes,
      signal: options.signal,
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Proxy returned ${res.status} ${res.statusText}${errBody ? `: ${errBody}` : ''}`);
    }
    if (!res.body) {
      throw new Error('Proxy response has no body.');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (value) buf += decoder.decode(value, { stream: true });
        let nl = buf.indexOf('\n');
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) yield JSON.parse(line);
          nl = buf.indexOf('\n');
        }
        if (done) break;
      }
      // Flush any bytes still sitting in TextDecoder's internal buffer (matters only
      // for multi-byte UTF-8 split across the final chunk boundary).
      buf += decoder.decode();
      const tail = buf.trim();
      if (tail) yield JSON.parse(tail);
    } finally {
      // If the consumer breaks out of the for-await early (e.g. scribe.recognize is
      // itself aborted), cancel the reader so the underlying HTTP connection is torn
      // down instead of leaking until GC.
      reader.cancel().catch(() => { /* ignore */ });
    }
  }
}
