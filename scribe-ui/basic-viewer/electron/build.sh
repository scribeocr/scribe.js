#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# The app's imports climb from electron/ to the repo root, and electron-builder cannot pack files above its app directory.
# So the build stages the same self-contained project mirror the Tauri shell uses, overlays the electron files, and points electron-builder at the result.
bash "$SCRIPT_DIR/../tauri/prepare-dist.sh"

STAGING="$SCRIPT_DIR/staging"
rm -rf "$STAGING"
mkdir -p "$STAGING/scribe-ui/basic-viewer/electron"
cp -r "$SCRIPT_DIR/../tauri/dist/." "$STAGING/"
cp "$SCRIPT_DIR/main.js" "$SCRIPT_DIR/preload.js" "$SCRIPT_DIR/electron.html" "$SCRIPT_DIR/electron-entry.js" \
   "$STAGING/scribe-ui/basic-viewer/electron/"

cat > "$STAGING/package.json" <<'JSON'
{
  "name": "viewer-21",
  "productName": "21 Viewer",
  "description": "Document viewer for PDFs and scanned documents",
  "author": "21",
  "version": "0.1.0",
  "type": "commonjs",
  "main": "scribe-ui/basic-viewer/electron/main.js"
}
JSON

cd "$SCRIPT_DIR"
npx electron-builder

echo ""
echo "Build complete. Artifacts under: scribe-ui/basic-viewer/electron/dist/"
