#!/usr/bin/env bash
# install-docker.sh — best-effort Docker engine install for iClaw Work/Safe modes.
#
# Triggered by the composer's "Install Docker" button via POST /api/docker/install
# (localhost only). Idempotent: a no-op when Docker is already on PATH. The
# caller starts the daemon and polls readiness afterwards, so this script only
# has to land the binary.
#
#   macOS → Homebrew cask (errors out with guidance if brew is missing)
#   Linux → official get.docker.com convenience script + docker group
set -euo pipefail

if command -v docker >/dev/null 2>&1; then
  echo "docker already installed: $(docker --version 2>/dev/null || echo unknown)"
  exit 0
fi

case "$(uname -s)" in
  Darwin)
    if ! command -v brew >/dev/null 2>&1; then
      echo "ERROR: Homebrew not found. Install it from https://brew.sh then retry, or install Docker Desktop manually." >&2
      exit 1
    fi
    echo "Installing Docker Desktop via Homebrew…"
    brew install --cask docker
    ;;
  Linux)
    echo "Installing Docker Engine via get.docker.com…"
    curl -fsSL https://get.docker.com | sh
    if command -v sudo >/dev/null 2>&1; then
      sudo usermod -aG docker "$USER" || true
      echo "NOTE: log out and back in for docker group membership to take effect."
    fi
    ;;
  *)
    echo "ERROR: unsupported platform $(uname -s). Install Docker Desktop manually from https://docker.com/products/docker-desktop" >&2
    exit 1
    ;;
esac

echo "docker install step done."
