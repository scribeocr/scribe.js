#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Build the Docker image (cached after first run)
docker build -t scribe-tauri-builder -f "$SCRIPT_DIR/Dockerfile.build" "$SCRIPT_DIR"

# Run the build inside the container, mounting the project
docker run --rm \
    -v "$PROJECT_ROOT":/app \
    -w /app/basic-viewer/tauri \
    scribe-tauri-builder \
    bash -c "bash prepare-dist.sh && cargo build --release"

echo ""
echo "Build complete. Binary at: basic-viewer/tauri/target/release/scribe-viewer-tauri"
