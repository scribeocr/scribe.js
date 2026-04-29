#!/bin/bash
# Creates a clean dist directory for Tauri embedding, mirroring the
# source layout (scribe-ui as a subdir of the scribe.js project root)
# so import paths resolve identically to the web build served from the
# project root.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIBE_UI_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRIBE_JS_ROOT="$(cd "$SCRIBE_UI_ROOT/.." && pwd)"
DIST="$SCRIPT_DIR/dist"

rm -rf "$DIST"
mkdir -p "$DIST/scribe-ui/basic-viewer"

# scribe.js: top-level files (entry point + siblings) and runtime subdirectories
find "$SCRIBE_JS_ROOT" -maxdepth 1 -type f -name '*.js' -exec cp {} "$DIST/" \;
for dir in fonts js lib scrollview-web tess; do
  cp -r "$SCRIBE_JS_ROOT/$dir" "$DIST/$dir"
done

# scribe-ui: top-level files + js + basic-viewer (excluding electron/tauri subdirs)
cp "$SCRIBE_UI_ROOT/viewer.js" "$DIST/scribe-ui/"
cp -r "$SCRIBE_UI_ROOT/js" "$DIST/scribe-ui/js"
cp "$SCRIBE_UI_ROOT"/basic-viewer/*.js "$DIST/scribe-ui/basic-viewer/"
cp "$SCRIBE_UI_ROOT"/basic-viewer/*.html "$DIST/scribe-ui/basic-viewer/"
