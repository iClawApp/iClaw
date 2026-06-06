#!/usr/bin/env bash
# Build the iClaw Secure-Mode sandbox image (Chromium + agent-browser).
# Usage: ./build-secure.sh [--cjk]
set -euo pipefail

cd "$(dirname "$0")"

# macOS: iClaw's engine is Colima, and the runtime looks for this image inside
# its own Colima VM. Build into that same VM (start it if needed, route the build
# to its context) so Secure Mode actually finds the image — not Docker Desktop.
if [[ "$(uname -s)" == "Darwin" ]]; then
  if ! command -v colima >/dev/null 2>&1; then
    echo "ERROR: colima not found. Install it first (iClaw installs it automatically; or: brew install colima docker)." >&2
    exit 1
  fi
  colima start iclaw
  export DOCKER_CONTEXT="colima-iclaw"
fi

IMAGE_TAG="${ICLAW_SECURE_IMAGE:-iclaw-secure:latest}"
CJK="false"
[[ "${1:-}" == "--cjk" ]] && CJK="true"

echo "Building ${IMAGE_TAG} (CJK fonts: ${CJK})..."
DOCKER_BUILDKIT=1 docker build \
  -f secure-sandbox.Dockerfile \
  --build-arg INSTALL_CJK_FONTS="${CJK}" \
  -t "${IMAGE_TAG}" \
  .

echo "Done. Secure Mode will use ${IMAGE_TAG}."
