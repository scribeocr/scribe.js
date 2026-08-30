#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
STAGING="$SCRIPT_DIR/staging"

# English OCR data, so recognition works offline in the packaged app.
# This is the same file the OCR worker would otherwise fetch from the CDN at first use, pinned to a package version and checksummed.
LANG_URL="https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0/eng.traineddata.gz"
LANG_SHA256="ed350f3752f81ee8f38769edc14d92d997dababe23b565c59879372cc46a2468"
LANG_CACHE="$SCRIPT_DIR/cache/eng.traineddata.gz"

(cd "$ROOT" && npm run build:electron)

# The shell files keep the same place they hold in the repo, three levels below the bundle root, because main.js derives that root from its own location and serves everything under it over app://.
rm -rf "$STAGING"
mkdir -p "$STAGING/scribe-ui/basic-viewer/electron" "$STAGING/scribe-ui/basic-viewer/icons" "$STAGING/lang"
cp -r "$ROOT/dist/." "$STAGING/"
rm -f "$STAGING/_headers"
cp "$SCRIPT_DIR/main.js" "$SCRIPT_DIR/preload.js" "$STAGING/scribe-ui/basic-viewer/electron/"
# No bundled HTML references the window icon main.js points at, so Vite never emits it.
cp "$ROOT/scribe-ui/basic-viewer/icons/icon-512.png" "$STAGING/scribe-ui/basic-viewer/icons/"

sha256_matches() {
  node -e "const c=require('crypto'),f=require('fs');process.exit(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex')===process.argv[2]?0:1)" "$1" "$LANG_SHA256"
}
if ! { [ -f "$LANG_CACHE" ] && sha256_matches "$LANG_CACHE"; }; then
  mkdir -p "$(dirname "$LANG_CACHE")"
  if ! curl -fsSL -o "$LANG_CACHE" "$LANG_URL" || ! sha256_matches "$LANG_CACHE"; then
    echo "Download of $LANG_URL failed or did not match its checksum; using the test-lang-data copy."
    cp "$ROOT/tests/test-lang-data/eng.traineddata.gz" "$LANG_CACHE"
    sha256_matches "$LANG_CACHE" || { echo "tests/test-lang-data/eng.traineddata.gz does not match the expected checksum either (is the submodule checked out?)."; exit 1; }
  fi
fi
cp "$LANG_CACHE" "$STAGING/lang/eng.traineddata.gz"

VERSION="$(node -p "require('$SCRIPT_DIR/package.json').version")"
cat > "$STAGING/package.json" <<JSON
{
  "name": "viewer-21",
  "productName": "21 Viewer",
  "description": "Document viewer for PDFs and scanned documents",
  "author": "21",
  "version": "$VERSION",
  "type": "commonjs",
  "main": "scribe-ui/basic-viewer/electron/main.js"
}
JSON

cd "$SCRIPT_DIR"
npx electron-builder "$@"

echo ""
echo "Build complete. Artifacts under: scribe-ui/basic-viewer/electron/dist/"
