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

cp "$SCRIBE_JS_ROOT/scribe.js" "$DIST/"
for dir in fonts js lib; do
  cp -r "$SCRIBE_JS_ROOT/$dir" "$DIST/$dir"
done

# core-vanilla is skipped because the viewer never enables vanillaMode.
mkdir -p "$DIST/tess"
cp "$SCRIBE_JS_ROOT"/tess/*.js "$DIST/tess/"
cp -r "$SCRIBE_JS_ROOT/tess/worker-script" "$DIST/tess/worker-script"
cp -r "$SCRIBE_JS_ROOT/tess/core" "$DIST/tess/core"

# The rest of the directory is a standalone demo app and its node_modules, which the viewer never loads.
mkdir -p "$DIST/scrollview-web"
cp "$SCRIBE_JS_ROOT/scrollview-web/draw.js" "$SCRIBE_JS_ROOT/scrollview-web/LICENSE" "$DIST/scrollview-web/"
for dir in scrollview src util; do
  cp -r "$SCRIBE_JS_ROOT/scrollview-web/$dir" "$DIST/scrollview-web/$dir"
done

# scribe-ui: top-level files + js + library + basic-viewer (excluding electron/tauri subdirs)
cp "$SCRIBE_UI_ROOT"/*.js "$DIST/scribe-ui/"
cp -r "$SCRIBE_UI_ROOT/js" "$DIST/scribe-ui/js"
cp -r "$SCRIBE_UI_ROOT/library" "$DIST/scribe-ui/library"
cp "$SCRIBE_UI_ROOT"/basic-viewer/*.js "$DIST/scribe-ui/basic-viewer/"
cp "$SCRIBE_UI_ROOT"/basic-viewer/*.html "$DIST/scribe-ui/basic-viewer/"
cp -r "$SCRIBE_UI_ROOT/basic-viewer/icons" "$DIST/scribe-ui/basic-viewer/icons"
