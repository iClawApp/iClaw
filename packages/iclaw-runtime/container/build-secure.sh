#!/usr/bin/env bash
# Build the iClaw Secure-Mode sandbox image (Chromium + agent-browser).
# Usage: ./build-secure.sh [--cjk]
set -euo pipefail

cd "$(dirname "$0")"

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
