import * as vscode from 'vscode';
import fs from 'node:fs';
import path from 'node:path';

const VIEW_TYPE = 'viewer-21.pdf';
const ENTRY = 'scribe-ui/basic-viewer/vscode/vscode-entry.js';
// The page runs from the viewer's build because a webview serves files to the page and not to its workers, and the build makes each worker script self-contained.
// The packaged extension holds the build at its root and this file at its repo path, three levels down.
const STAGING = path.join(import.meta.dirname, 'staging');
const APP_ROOT = fs.existsSync(path.join(STAGING, ENTRY)) ? STAGING : path.join(import.meta.dirname, '..', '..', '..');

/** @param {vscode.ExtensionContext} context */
export function activate(context) {
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(VIEW_TYPE, {
    openCustomDocument(uri) {
      return { uri, dispose() {} };
    },
    resolveCustomEditor(doc, panel) {
      const { webview } = panel;
      const dir = vscode.Uri.joinPath(doc.uri, '..');
      const name = path.posix.basename(doc.uri.path);
      webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(APP_ROOT), dir] };

      const config = {
        doc: webview.asWebviewUri(doc.uri).toString(),
        name,
        page: 0,
        workers: 'fetch',
      };
      const csp = [
        "default-src 'none'",
        `script-src ${webview.cspSource} 'wasm-unsafe-eval'`,
        'worker-src blob:',
        `style-src ${webview.cspSource} 'unsafe-inline'`,
        `img-src ${webview.cspSource} blob: data:`,
        `font-src ${webview.cspSource} blob: data:`,
        // The extension's build embeds the workers' fonts as data URLs, which they fetch.
        `connect-src ${webview.cspSource} blob: data:`,
      ].join('; ');
      const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta id="viewer-config" data-config="${attr(JSON.stringify(config))}">
  <title>${attr(name)}</title>
  <style>
    html, body { margin: 0; padding: 0; overflow: hidden; }
    #pdfViewerCont { width: 100vw; height: 100vh; }
  </style>
  <script type="module" src="${webview.asWebviewUri(vscode.Uri.file(path.join(APP_ROOT, ENTRY)))}"></script>
</head>
<body>
  <div id="pdfViewerCont"></div>
</body>
</html>`;

      let ready = false;
      /** @type {object[]} */
      const pending = [];
      const post = (message) => {
        if (ready) webview.postMessage(message);
        else pending.push(message);
      };
      const messages = webview.onDidReceiveMessage(async (message) => {
        if (!message || typeof message.type !== 'string') return;
        if (message.type === 'ready') {
          ready = true;
          for (const m of pending.splice(0)) webview.postMessage(m);
        } else if (message.type === 'save' && message.bytes) {
          const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(dir, String(message.name || name)) });
          if (target) await vscode.workspace.fs.writeFile(target, new Uint8Array(message.bytes));
        } else if (message.type === 'openExternal' && /^(https?:|mailto:)/i.test(String(message.url))) {
          vscode.env.openExternal(vscode.Uri.parse(String(message.url)));
        }
      });

      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, name));
      /** @type {?ReturnType<typeof setTimeout>} */
      let timer = null;
      const changed = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
          timer = null;
          try {
            const before = await vscode.workspace.fs.stat(doc.uri);
            await new Promise((resolve) => { setTimeout(resolve, 150); });
            const after = await vscode.workspace.fs.stat(doc.uri);
            if (before.size !== after.size || before.mtime !== after.mtime) {
              changed();
              return;
            }
            post({ type: 'reload' });
          } catch { /* The delete event reports a file gone mid-write. */ }
        }, 300);
      };
      watcher.onDidChange(changed);
      // An atomic save can arrive as a create.
      watcher.onDidCreate(changed);
      watcher.onDidDelete(() => post({ type: 'deleted' }));

      panel.onDidDispose(() => {
        if (timer) clearTimeout(timer);
        watcher.dispose();
        messages.dispose();
      });
    },
  }, {
    webviewOptions: { retainContextWhenHidden: true },
    supportsMultipleEditorsPerDocument: false,
  }));
}

export function deactivate() {}
