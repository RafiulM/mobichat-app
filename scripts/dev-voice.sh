#!/usr/bin/env bash
# dev-voice.sh — Hot-reload dev server + .app bundle for voice/mic features.
# Starts the Vite dev server, builds a Tauri binary that connects to it,
# wraps it in a .app bundle (required for macOS TCC mic permissions),
# and launches it.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_BUNDLE="$ROOT_DIR/src-tauri/target/debug/Jan.app"
DEV_SERVER_PID=""

cleanup() {
  echo ""
  echo "Shutting down..."
  if [ -n "$DEV_SERVER_PID" ] && kill -0 "$DEV_SERVER_PID" 2>/dev/null; then
    kill "$DEV_SERVER_PID" 2>/dev/null || true
    wait "$DEV_SERVER_PID" 2>/dev/null || true
    echo "Vite dev server stopped."
  fi
}
trap cleanup EXIT INT TERM

# 1. Start Vite dev server in background
echo "Starting Vite dev server..."
cd "$ROOT_DIR"
IS_TAURI=true IS_DEV=true TAURI_ENV_PLATFORM=darwin yarn dev:web &
DEV_SERVER_PID=$!

# 2. Wait for dev server to be ready
echo "Waiting for dev server on http://localhost:1420..."
ATTEMPTS=0
MAX_ATTEMPTS=60
while ! curl -s -o /dev/null http://localhost:1420 2>/dev/null; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ $ATTEMPTS -ge $MAX_ATTEMPTS ]; then
    echo "Error: Dev server did not start within ${MAX_ATTEMPTS}s"
    exit 1
  fi
  if ! kill -0 "$DEV_SERVER_PID" 2>/dev/null; then
    echo "Error: Dev server process exited unexpectedly"
    exit 1
  fi
  sleep 1
done
echo "Dev server ready!"

# 3. Build Tauri binary in dev mode (loads from devUrl instead of embedded assets).
#    Tauri uses the `custom-protocol` cargo feature to switch: with it, the binary
#    embeds frontendDist; without it, cfg!(dev)=true and it loads from devUrl.
#    We list all default features from Cargo.toml EXCEPT `tauri/custom-protocol`.
#    Clean the package first to ensure no stale embedded assets from previous builds.
echo "Building Tauri binary (dev mode — loads from devUrl)..."
cd "$ROOT_DIR/src-tauri"
cargo clean -p MobiChat 2>/dev/null || true
cargo build --no-default-features --features "tauri/wry,tauri/common-controls-v6,tauri/x11,tauri/protocol-asset,tauri/macos-private-api,tauri/tray-icon,tauri/test,desktop"

# 4. Create .app bundle
echo "Creating .app bundle..."
mkdir -p "$APP_BUNDLE/Contents/MacOS"
cp "$ROOT_DIR/src-tauri/target/debug/Jan" "$APP_BUNDLE/Contents/MacOS/Jan"
cp "$ROOT_DIR/src-tauri/Info.plist" "$APP_BUNDLE/Contents/Info.plist"

/usr/libexec/PlistBuddy -c "Delete :CFBundleExecutable" "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleExecutable string Jan" "$APP_BUNDLE/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Delete :CFBundleName" "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleName string Jan" "$APP_BUNDLE/Contents/Info.plist"

# Link resources into the bundle
mkdir -p "$APP_BUNDLE/Contents/Resources"
rm -f "$APP_BUNDLE/Contents/Resources/resources"
ln -sf ../../../resources "$APP_BUNDLE/Contents/Resources/resources"

# Sign with entitlements for mic/audio access
codesign --force --sign - --entitlements "$ROOT_DIR/src-tauri/Entitlements.plist" "$APP_BUNDLE" 2>/dev/null || true

# 5. Launch
echo "Launching Jan.app (hot-reload + voice enabled)..."
echo "  Frontend: http://localhost:1420 (hot-reload active)"
echo "  Press Ctrl+C to stop."
open "$APP_BUNDLE"

# Keep script alive so the dev server stays running
wait "$DEV_SERVER_PID"
