#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
STAGING="$SCRIPT_DIR/staging"

(cd "$ROOT" && npm run build:vscode)
rm -f "$STAGING/_headers"

# extension.js keeps the place it holds in the repo, three levels below the package root, because it derives that root from its own location.
mkdir -p "$STAGING/scribe-ui/basic-viewer/vscode" "$STAGING/scribe-ui/basic-viewer/icons"
cp "$SCRIPT_DIR/extension.js" "$STAGING/scribe-ui/basic-viewer/vscode/"
cp "$ROOT/scribe-ui/basic-viewer/icons/icon-512.png" "$STAGING/scribe-ui/basic-viewer/icons/"
cp "$SCRIPT_DIR/README.md" "$SCRIPT_DIR/CHANGELOG.md" "$ROOT/LICENSE" "$STAGING/"

# Paths travel as arguments because Git Bash rewrites path-shaped arguments to native binaries into Windows form but leaves string contents alone.
node -e "
const fs = require('fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
manifest.main = 'scribe-ui/basic-viewer/vscode/extension.js';
manifest.icon = 'scribe-ui/basic-viewer/icons/icon-512.png';
delete manifest.scripts;
delete manifest.devDependencies;
fs.writeFileSync(process.argv[2], JSON.stringify(manifest, null, 2) + '\n');
" "$SCRIPT_DIR/package.json" "$STAGING/package.json"

VERSION="$(node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).version" "$SCRIPT_DIR/package.json")"
mkdir -p "$SCRIPT_DIR/dist"
(cd "$STAGING" && "$SCRIPT_DIR/node_modules/.bin/vsce" package --no-dependencies -o "$SCRIPT_DIR/dist/viewer-21-$VERSION.vsix" "$@")

echo ""
echo "Build complete. Package: scribe-ui/basic-viewer/vscode/dist/viewer-21-$VERSION.vsix"
