#!/usr/bin/env bash
set -euo pipefail

echo "Transforming manifest.json for Firefox MV3 (event page)..."

jq '
  # Replace the Chrome MV3 service worker with an event-page style background.
  # This lets us list the polyfill before background.js (service workers in MV3
  # only allow a single entry point).
  .background = { "scripts": ["vendor/browser-polyfill.js","background.js"] }

  # Tell AMO the minimum Firefox version that supports MV3 well.
  | .browser_specific_settings.gecko = { "strict_min_version": "121.0" }
' manifest.json > manifest.tmp && mv manifest.tmp manifest.json

# Quick sanity check to catch jq syntax errors or bad JSON
jq . manifest.json >/dev/null

echo "Firefox manifest transformation complete."
