#!/usr/bin/env bash
#
# release.sh — build, sign, notarize and (optionally) publish the macOS app.
#
# Usage:
#   npm run release            # build + sign + notarize locally (no upload)
#   npm run release:publish    # ...and upload to GitHub Releases (needs GH_TOKEN)
#
# Notarization is PASSWORDLESS: it uses the notarytool keychain profile created
# once with `xcrun notarytool store-credentials` (see docs/desktop-release.md).
# Per-machine settings (signing identity, keychain profile, GitHub token) live in
# a gitignored `.env.release` — copy `.env.release.example` to create it.
set -euo pipefail
cd "$(dirname "$0")/.."

# Load per-machine config if present (exported for the child electron-builder).
if [ -f .env.release ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.release
  set +a
fi

PUBLISH="${1:-never}"               # "always" to upload to GitHub Releases
: "${APPLE_KEYCHAIN_PROFILE:=iclaw-notarize}"
export APPLE_KEYCHAIN_PROFILE

# Force the keychain-profile path: electron-builder prefers APPLE_ID + password
# (and the API key) OVER the keychain profile, so make sure a stray one in the
# environment can't hijack notarization.
unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER 2>/dev/null || true

echo "[release] keychain profile: ${APPLE_KEYCHAIN_PROFILE} · publish: ${PUBLISH}"
[ -n "${CSC_NAME:-}" ] && echo "[release] signing identity: ${CSC_NAME}"

npm run build:desktop
npm run vendor:node
npx electron-builder --mac --config.mac.notarize=true --publish "${PUBLISH}"

echo "[release] done — artifacts in release/ (dmg + zip + latest-mac.yml)"
