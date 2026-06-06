#!/usr/bin/env bash
# install-docker.sh — best-effort container-engine install for iClaw Work/Safe modes.
#
# Triggered by the composer's "Install" button via POST /api/docker/install
# (localhost only). Idempotent: a no-op when the engine is already present. The
# caller starts the engine and polls readiness afterwards, so this script only
# has to land the binaries.
#
#   macOS → Colima + Docker CLI via Homebrew (a lightweight VM engine — NOT
#           Docker Desktop, so there's no GUI, no licence, and nothing for a
#           non-technical user to configure)
#   Linux → official get.docker.com convenience script + docker group
set -euo pipefail

case "$(uname -s)" in
  Darwin)
    # On macOS the engine is Colima. A bare `docker` CLI may already exist (e.g.
    # left over from Docker Desktop), so key the "already installed" check on
    # colima specifically — not on the docker client.
    if command -v colima >/dev/null 2>&1; then
      echo "colima already installed: $(colima version 2>/dev/null | head -1 || echo unknown)"
      exit 0
    fi
    if ! command -v brew >/dev/null 2>&1; then
      echo "ERROR: Homebrew not found. Install it from https://brew.sh then retry." >&2
      exit 1
    fi
    echo "Installing Colima + Docker CLI via Homebrew (no Docker Desktop)…"
    brew install colima docker
    ;;
  Linux)
    if command -v docker >/dev/null 2>&1; then
      echo "docker already installed: $(docker --version 2>/dev/null || echo unknown)"
      exit 0
    fi
    echo "Installing Docker Engine via get.docker.com…"
    curl -fsSL https://get.docker.com | sh
    if command -v sudo >/dev/null 2>&1; then
      sudo usermod -aG docker "$USER" || true
      echo "NOTE: log out and back in for docker group membership to take effect."
    fi
    ;;
  *)
    echo "ERROR: unsupported platform $(uname -s). Install Docker manually from https://docker.com" >&2
    exit 1
    ;;
esac

echo "container engine install step done."
