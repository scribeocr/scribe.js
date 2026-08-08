#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# prepare-dist.sh copies from the whole scribe.js project, so Docker must mount the repo root, not scribe-ui.
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Build natively when the host has cargo and the Tauri system deps, otherwise fall back to the Docker image.
# Both paths run `cargo tauri build` rather than plain `cargo build`, because only the bundler emits the .app/.dmg/.deb artifacts with the app icon.
# prepare-dist.sh runs from this script rather than a beforeBuildCommand hook, because the CLI runs hooks from the nearest package.json directory, which here is inside dist itself.
if command -v cargo >/dev/null 2>&1; then
    cd "$SCRIPT_DIR"
    bash prepare-dist.sh
    # The frontend assets are embedded into the binary by the generate_context macro at compile time, and cargo
    # does not notice dist-only changes, so an asset-only rebuild would silently repackage the previous binary.
    touch src/main.rs
    if cargo tauri --version >/dev/null 2>&1; then
        cargo tauri build
    else
        # Prebuilt CLI from npm, so a cargo-only host needs no `cargo install tauri-cli`.
        npx --yes @tauri-apps/cli@^2 build
    fi
else
    docker build -t scribe-tauri-builder -f "$SCRIPT_DIR/Dockerfile.build" "$SCRIPT_DIR"
    docker run --rm \
        -v "$REPO_ROOT":/app \
        -w /app/scribe-ui/basic-viewer/tauri \
        scribe-tauri-builder \
        bash -c "bash prepare-dist.sh && cargo tauri build --bundles deb"
fi

echo ""
echo "Build complete. Bundles under: scribe-ui/basic-viewer/tauri/target/release/bundle/"
