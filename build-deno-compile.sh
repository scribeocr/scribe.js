#!/bin/bash

## Note: 
## The Windows build does not work and the Mac build has never been tested.
## The Linux build should work.

# Extract version from package.json using grep and sed
VERSION=$(grep '"version"' package.json | sed -E 's/.*"version": *"([^"]+)".*/\1/')
if [ -z "$VERSION" ]; then
    echo "Failed to extract version from package.json"
    exit 1
fi

# Create build directory
mkdir -p build

# Build for different platforms
echo "Building for Linux x64..."
deno compile --allow-sys --allow-read  --allow-write --target x86_64-unknown-linux-gnu --output build/scribe-linux-x64 cli/scribe.js
# deno compile --allow-sys --allow-read  --allow-write --target x86_64-unknown-linux-gnu --output build/scribe-linux-x64 --include mupdf --include fonts --include js/worker cli/scribe.js

echo "Building for macOS x64..."
deno compile --allow-sys --allow-read  --allow-write --target x86_64-apple-darwin --output build/scribe-macos-x64 cli/scribe.js
# deno compile --allow-sys --allow-read  --allow-write --target x86_64-apple-darwin --output build/scribe-macos-x64 --include mupdf --include fonts --include js/worker cli/scribe.js

echo "Building for Windows x64..."
deno compile --allow-sys --allow-read  --allow-write --target x86_64-pc-windows-msvc --output build/scribe-windows-x64.exe cli/scribe.js
# deno compile --allow-sys --allow-read  --allow-write --target x86_64-pc-windows-msvc --output build/scribe-windows-x64.exe --include mupdf --include fonts --include js/worker cli/scribe.js

# Create checksums
cd build
sha256sum * > checksums.txt
cd ..