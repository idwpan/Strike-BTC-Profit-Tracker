#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/src"
DIST_DIR="$ROOT_DIR/dist"
CHROME_DIR="$DIST_DIR/chrome"
FIREFOX_DIR="$DIST_DIR/firefox"
BASE_DIR="$DIST_DIR/base"

# Bail out early if core tools are missing.
need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required tool: $1" >&2; exit 1; }; }
need jq
need zip
need rsync
need node
need npx

# Start fresh.
rm -rf "$DIST_DIR"
mkdir -p "$BASE_DIR"

echo "[1/4] Copying src -> dist/base"
rsync -a "$SRC_DIR/" "$BASE_DIR/"

# If we have manifest.jsonc, strip comments into manifest.json.
# If we already have a manifest.json, just use it as-is.
JSONC="$BASE_DIR/manifest.jsonc"
JSON="$BASE_DIR/manifest.json"
if [[ -f "$JSONC" ]]; then
  echo "[2/4] Stripping comments: manifest.jsonc -> manifest.json"
  npx -y strip-json-comments-cli "$JSONC" > "$JSON"
  rm -f "$JSONC"
elif [[ -f "$JSON" ]]; then
  echo "[2/4] Using plain manifest.json (no comments to strip)"
else
  echo "Expected $JSONC or $JSON not found in $BASE_DIR" >&2
  exit 1
fi

# --- Chrome build ---
# Source manifest is already MV3 w/ service worker, so no transform needed here.
echo "[3/4] Building Chrome (MV3)"
rm -rf "$CHROME_DIR"
rsync -a "$BASE_DIR/" "$CHROME_DIR/"
(
  cd "$CHROME_DIR"
  # Double-check the manifest still has a service_worker defined.
  if ! jq -e '.background.service_worker? // empty' manifest.json >/dev/null; then
    echo "Warning: background.service_worker missing in Chrome build manifest.json" >&2
  fi
  zip -r "$DIST_DIR/../strike-tracker-chrome.zip" . -x ".*" -x "__MACOSX" >/dev/null
)

# --- Firefox build ---
# Same MV3 base, but swap the background to event-page scripts and insert polyfill.
echo "[4/4] Building Firefox (MV3 event page)"
rm -rf "$FIREFOX_DIR"
rsync -a "$BASE_DIR/" "$FIREFOX_DIR/"
(
  cd "$FIREFOX_DIR"
  "$ROOT_DIR/build-scripts/transform-firefox.sh"
  zip -r "$DIST_DIR/../strike-tracker-firefox.zip" . -x ".*" -x "__MACOSX" >/dev/null
)

echo "Artifacts:"
echo "  $ROOT_DIR/strike-tracker-chrome.zip"
echo "  $ROOT_DIR/strike-tracker-firefox.zip"
