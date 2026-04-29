#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# When run inside an environment that already has cargo + the Tauri system
# deps (e.g. the scribe.js dev container), build directly. Otherwise fall
# back to the Docker-in-Docker path for hosts without a Rust toolchain.
if command -v cargo >/dev/null 2>&1; then
    cd "$SCRIPT_DIR"
    bash prepare-dist.sh
    cargo build --release
else
    docker build -t scribe-tauri-builder -f "$SCRIPT_DIR/Dockerfile.build" "$SCRIPT_DIR"
    docker run --rm \
        -v "$PROJECT_ROOT":/app \
        -w /app/basic-viewer/tauri \
        scribe-tauri-builder \
        bash -c "bash prepare-dist.sh && cargo build --release"
fi

echo ""
echo "Build complete. Binary at: basic-viewer/tauri/target/release/scribe-viewer-tauri"
