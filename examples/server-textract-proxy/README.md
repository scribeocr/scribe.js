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

```js
import scribe from 'scribe.js';
import { RecognitionModelServerProxy } from './RecognitionModelServerProxy.js';

await scribe.init();
await scribe.importFiles([pdfFileFromInput]);

const ac = new AbortController();
cancelButton.addEventListener('click', () => ac.abort());

try {
  await scribe.recognize({
    model: RecognitionModelServerProxy,
    modelOptions: { serverUrl: 'https://your-server.example/ocr' },
    signal: ac.signal,
  });
  // scribe.data.ocr.active is populated; scribe.exportData('pdf') returns a searchable PDF
} catch (err) {
  if (err.name !== 'AbortError') throw err;
  // Partial results in scribe.data.ocr.active for pages that arrived before abort.
}
```

Copy [`client/RecognitionModelServerProxy.js`](client/RecognitionModelServerProxy.js) into your frontend bundle. No changes to the stock scribeocr GUI are required.

## API

`POST /ocr` — body: raw PDF bytes, `Content-Type: application/pdf`. Response: `application/x-ndjson`, one line per page:

- Success: `{"pageNum": 0, "rawData": "<stringified Textract JSON>"}`
- Failure: `{"pageNum": 0, "error": {"message": "..."}}`

Lines are flushed as each page completes, so the browser merges progressively.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Browser console: `405 Method Not Allowed` posting to `:8081` | You posted to the static file server. Change the port in the demo's Proxy URL field to `3000`. |
| Browser: `Failed to fetch` for `*.woff` during `importFiles` | The static file server isn't rooted at `scribe.js/`. Run `npx http-server` from the scribe.js checkout root, not from this folder. |
| Server log shows `client disconnected, aborting` immediately on every request | You're running an old build of `server.js`. Pull latest, kill, restart. |
| `EADDRINUSE :::3000` on startup | Another proxy instance is still running. `ss -ltnp \| grep :3000` to find it, kill, retry. |
| Per-region throttling errors in logs | Add more regions to `TEXTRACT_REGIONS` to scale TPS. |
