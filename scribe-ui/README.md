# Scribe UI
Scribe UI is a library for implementing a viewer or editor UI for PDFs and scanned documents.  In addition to performant rendering of PDFs, Scribe UI supports advanced editing features unsupported by other PDF viewer libraries--notably allowing end users to edit text both manually and automatically using OCR.

Web applications implemented using Scribe UI are below:
1. [Scribe OCR](https://scribeocr.com/)(repo [here](https://github.com/scribeocr/scribeocr)) - run OCR on scanned documents and proofread OCR text.
2. [Alch.io](https://alch.io/) (repo [here](https://github.com/scribeocr/alch.io)) - extract tables from PDFs and export to Excel.
3. [Scribe PDF Viewer](https://viewer.scribeocr.com/) (repo [here](https://github.com/scribeocr/scribe-pdf-viewer)) - minimal example of PDF viewer implemented with Scribe UI.

Scribe UI wraps [Scribe.js](https://github.com/scribeocr/scribe.js), which provides all of the logic unrelated to UI, including reading PDFs, rendering pages to images, and running OCR.

# Usage
To start using Scribe UI, add this repo as a submodule in your project.  Scribe UI is currently not published to NPM, and is not capable of running using a CDN due to issues with cross-origin policies.

Scribe UI is a UI toolkit for creating viewer and editor interfaces, rather than a single drop-in viewer.  Additionally, Scribe UI is not yet fully documented.  Therefore, the best way to start using Scribe UI is to review the example applications listed above.  The simplest example is the [Scribe PDF Viewer repo](https://github.com/scribeocr/scribe-pdf-viewer), which provides code for creating a basic PDF viewer (visually similar to the Chrome PDF viewer) using Scribe UI.

# Basic Viewer (Web)
A minimal browser version of the viewer lives at [`basic-viewer/index.html`](basic-viewer/index.html).

From the parent directory (where `scribe-ui/` and `scribe.js/` sit as siblings):

```bash
npx http-server
```

Then open `http://localhost:8080/scribe-ui/basic-viewer/index.html` in a browser. Load a PDF from the in-page UI.

# Standalone Tauri Viewer
A standalone desktop build of the basic viewer lives in [`basic-viewer/tauri/`](basic-viewer/tauri/).

## Build
The build script auto-detects the environment:
- **With `cargo` available** (recommended — e.g. inside the scribe.js dev container, which preinstalls the Rust toolchain and Tauri v2 system libs): builds directly.
- **Without `cargo`**: falls back to a Docker-in-Docker build using `Dockerfile.build`.

```bash
bash basic-viewer/tauri/build.sh
```

Output: `basic-viewer/tauri/target/release/scribe-viewer-tauri`.

If building outside the dev container, the host needs Rust 1.85+ and the Tauri v2 Linux dependencies (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `libxdo-dev`, `libssl-dev`, `build-essential`).

## Run
The binary is a Linux GUI app and needs a display server plus the runtime libs (`libwebkit2gtk-4.1-0`, `libgtk-3-0`, `libayatana-appindicator3-1`, `librsvg2-2`, `libxdo3`).

```bash
./basic-viewer/tauri/target/release/scribe-viewer-tauri -f /path/to/file.pdf
```

CLI flags (via `tauri-plugin-cli`, see [`tauri.conf.json`](basic-viewer/tauri/tauri.conf.json)):
| Flag | Description |
| --- | --- |
| `-f, --file <path>` | PDF to load |
| `-p, --page <n>` | Initial page (0-indexed) |
| `-a, --action <load\|navigate\|highlight>` | Defaults to `load` |
| `-H, --highlights <json>` | JSON array of highlight rects |
