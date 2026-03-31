#!/bin/bash
# Creates a clean dist directory for Tauri embedding,
# copying only the runtime files needed by the viewer.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIBE_UI_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRIBE_JS_ROOT="$(cd "$SCRIBE_UI_ROOT/.." && pwd)"
DIST="$SCRIPT_DIR/dist"

rm -rf "$DIST"
mkdir -p "$DIST/scribe.js"

# Top-level runtime files
cp "$SCRIBE_UI_ROOT/viewer.js" "$DIST/"

# basic-viewer: copy only the top-level files (not electron/tauri subdirs)
mkdir -p "$DIST/basic-viewer"
cp "$SCRIBE_UI_ROOT"/basic-viewer/*.js "$DIST/basic-viewer/"
cp "$SCRIBE_UI_ROOT"/basic-viewer/*.html "$DIST/basic-viewer/"

cp -r "$SCRIBE_UI_ROOT/js" "$DIST/js"

# scribe.js: top-level files only (not directories)
find "$SCRIBE_JS_ROOT" -maxdepth 1 -type f -name '*.js' -exec cp {} "$DIST/scribe.js/" \;

# scribe.js: runtime subdirectories
for dir in fonts js lib mupdf scrollview-web tess tesseract.js; do
  cp -r "$SCRIBE_JS_ROOT/$dir" "$DIST/scribe.js/$dir"
done
