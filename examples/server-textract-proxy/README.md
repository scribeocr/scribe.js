# scribe.js Textract proxy (reference server)

Browser POSTs a PDF to this server, server runs AWS Textract, NDJSON results stream back per page. Credentials stay on the server.

Reference only — no auth, no rate limit. Put it behind your own app's auth before exposing it.

## 1. Run the proxy

```sh
cd scribe.js/examples/server-textract-proxy
AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
TEXTRACT_REGIONS=us-east-1 \
node server.js
```

Requires Node 20+ and AWS credentials in the standard SDK chain.

| Env var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `CORS_ORIGIN` | `*` | Lock to your site origin in production. |
| `TEXTRACT_REGIONS` | `us-east-1` | Comma-separated. Multi-region round-robins for ~N× TPS. |
| `TEXTRACT_LAYOUT` | `false` | `1`/`true` to enable `AnalyzeDocument` LAYOUT. |
| `TEXTRACT_TABLES` | `false` | `1`/`true` to enable `AnalyzeDocument` TABLES. |
| `MAX_UPLOAD_BYTES` | `104857600` (100 MB) | |

The server logs each request with a 6-char ID and per-page timing — watch the terminal to see what it's doing.

## 2. Try it from the browser (demo page)

A self-contained HTML harness ships next to this README at [`client/demo.html`](client/demo.html). Serve the scribe.js root over HTTP and open the demo:

```sh
# In a second terminal, from the scribe.js checkout root (NOT this folder):
cd scribe.js
npx http-server -p 8081 --cors
```

Then open:

```
http://localhost:8081/examples/server-textract-proxy/client/demo.html
```

Pick a PDF, click **Recognize**. You should see per-page progress in both the demo log pane and the proxy server terminal. **Cancel** mid-run aborts cleanly. **Export searchable PDF** downloads the result.

If you're hitting the server from a different host on the LAN, change `localhost` in the demo's "Proxy URL" field to the proxy's IP — leave the port as `3000` (the proxy port, not the static-server port).

## 3. Wire it into your own app

The browser-side flow is small enough to live in a single file. The reference is
[`client/demo.js`](client/demo.js); copy its `streamServerOcr` async generator and the
recognize-button loop straight into your own frontend, then point `serverUrl` at your
deployed proxy:

```js
import scribe from 'scribe.js-ocr';
import { OcrPage } from 'scribe.js-ocr/js/objects/ocrObjects.js';

// streamServerOcr: copy from client/demo.js
// (POSTs the PDF, reads the NDJSON stream, yields one entry per page)

const pdfArrayBuffer = await pdfFileFromInput.arrayBuffer();
const doc = await scribe.openDocument({ pdfFiles: [pdfArrayBuffer] });

const ac = new AbortController();
cancelButton.addEventListener('click', () => ac.abort());

try {
  for await (const entry of streamServerOcr('https://your-server.example/ocr', pdfArrayBuffer, { signal: ac.signal })) {
    if (entry.error) {
      const dims = doc.pageMetrics[entry.pageNum].dims;
      doc.insertParsedPage(entry.pageNum, new OcrPage(entry.pageNum, dims), { engineName: 'Server Textract' });
      continue;
    }
    doc.insertParsedPage(entry.pageNum, entry.page, {
      engineName: 'Server Textract',
      dataTables: entry.dataTables,
      warn: entry.warn,
    });
  }
  // doc.ocr.active is populated; doc.exportData('pdf') returns a searchable PDF.
} catch (err) {
  if (err.name !== 'AbortError') throw err;
  // Partial results in doc.ocr.active for pages that arrived before abort.
}
```

No changes to the stock scribeocr GUI are required. The server runs scribe.js's Textract conversion in-process and streams the parsed `OcrPage` per page, so the browser does not need to re-parse Textract JSON.

## API

`POST /ocr` — body: raw PDF bytes, `Content-Type: application/pdf`. Response: `application/x-ndjson`, one line per page:

- Success: `{"pageNum": 0, "page": <OcrPage>, "dataTables": <LayoutDataTablePage>, "warn": <warning>}` — `page` is the parsed `OcrPage` with circular refs stripped (line.page, line.par, par.page, word.line, par.lines -> par.lineIds); `dataTables` is the per-page layout-table data (empty when `TEXTRACT_TABLES=false`); `warn` is the per-page conversion-warning object. Feed each line into `doc.insertParsedPage(pageNum, page, { engineName, dataTables, warn })` to install it into a browser-side `ScribeDoc`.
- Failure: `{"pageNum": 0, "error": {"message": "..."}}`

Lines are flushed as each page completes, so the browser merges progressively.
