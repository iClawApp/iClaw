#!/usr/bin/env bash
# install-docker.sh — best-effort container-engine install for iClaw Work/Safe modes.
#
# Triggered by the composer's "Install" button via POST /api/docker/install
# (localhost only). Idempotent: a no-op when the engine is already present. The
# caller starts the engine and polls readiness afterwards, so this script only
# has to land the binaries.
#
# macOS — the engine is Colima (a lightweight Linux VM, NOT Docker Desktop, so no
# GUI, no licence, nothing for a non-technical user to configure). Two ways to
# land it, in order of preference:
#   1. Homebrew present → `brew install colima docker` (brew keeps it updated).
#   2. No Homebrew       → download PINNED colima + lima + docker binaries straight
#                          from the projects' official releases into ~/.iclaw/engine,
#                          verifying SHA-256. No brew, no Xcode CLT, no sudo — so it
#                          works on a clean Mac with nothing installed.
# Linux — official get.docker.com convenience script + docker group.
set -euo pipefail

# ---- pinned engine versions + SHA-256 (verified against the official releases) ----
# colima/lima: GitHub release asset digests · docker: download.docker.com static
# (no published checksum — hashes computed at pin time). To bump: change the
# version and the matching per-arch SHA-256 below.
COLIMA_VER="0.10.3"
LIMA_VER="2.1.2"
DOCKER_VER="29.5.3"
# colima-Darwin-<arch>
COLIMA_SHA_arm64="980ad8bf61a4ca370243f4cb41401a61276dcd2c2502bee7b9b86f9250169f34"
COLIMA_SHA_x86_64="3082737fe8a98afda11cba7d9a20b6e56fe80c6153464beda04bec630758770b"
# lima-<ver>-Darwin-<arch>.tar.gz  (bundles limactl + share/lima incl. the native guest agent)
LIMA_SHA_arm64="7081d03d01511f20c4a3b38d8120428ef1c66e4b21ec9b54017bc65da60b031f"
LIMA_SHA_x86_64="3dc5218c7b0cc14126fb6e3ae6f174f026660e4e2cdffcb34b16e5a2f415eb45"
# docker-<ver>.tgz  (download.docker.com/mac/static/stable/<arch>)
DOCKER_SHA_aarch64="a579c5fb15bebb35dc443cdf6f17b076b6c90afa6cd0e51463b1608e5b235536"
DOCKER_SHA_x86_64="db73fa6cdeb6a5a3b646fe18dec4cdb48ade3b5cea6bc069afcc389b5d1cb819"

ENGINE_DIR="${ICLAW_ENGINE_DIR:-$HOME/.iclaw/engine}"

# fetch_verify URL DEST EXPECTED_SHA256 — download over HTTPS, fail hard on mismatch.
fetch_verify() {
  local url="$1" dest="$2" sha="$3"
  echo "  ↓ $(basename "$dest")"
  curl -fSL --retry 3 "$url" -o "$dest"
  if ! echo "${sha}  ${dest}" | shasum -a 256 -c - >/dev/null 2>&1; then
    echo "ERROR: SHA-256 mismatch for $url — refusing to install." >&2
    rm -f "$dest"
    exit 1
  fi
}

# Download + verify pinned colima/lima/docker into ENGINE_DIR. No Homebrew needed.
install_engine_no_brew() {
  local m carch larch darch csha lsha dsha
  m="$(uname -m)"
  case "$m" in
    arm64)  carch=arm64;  larch=arm64;  darch=aarch64
            csha=$COLIMA_SHA_arm64;  lsha=$LIMA_SHA_arm64;  dsha=$DOCKER_SHA_aarch64 ;;
    x86_64) carch=x86_64; larch=x86_64; darch=x86_64
            csha=$COLIMA_SHA_x86_64; lsha=$LIMA_SHA_x86_64; dsha=$DOCKER_SHA_x86_64 ;;
    *) echo "ERROR: unsupported macOS architecture '$m'." >&2; exit 1 ;;
  esac

  local bin tmp
  bin="$ENGINE_DIR/bin"
  mkdir -p "$bin"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  echo "Homebrew not found — installing the Colima engine directly into $ENGINE_DIR"
  echo "(downloading pinned binaries; no brew, no Xcode tools, no password)…"

  # colima — single self-contained binary
  fetch_verify "https://github.com/abiosoft/colima/releases/download/v${COLIMA_VER}/colima-Darwin-${carch}" \
    "$bin/colima" "$csha"
  chmod +x "$bin/colima"

  # lima — tarball lays down bin/limactl + share/lima (limactl finds its share via ../share)
  fetch_verify "https://github.com/lima-vm/lima/releases/download/v${LIMA_VER}/lima-${LIMA_VER}-Darwin-${larch}.tar.gz" \
    "$tmp/lima.tgz" "$lsha"
  tar -xzf "$tmp/lima.tgz" -C "$ENGINE_DIR"

  # docker — static CLI client (tgz contains docker/docker)
  fetch_verify "https://download.docker.com/mac/static/stable/${darch}/docker-${DOCKER_VER}.tgz" \
    "$tmp/docker.tgz" "$dsha"
  tar -xzf "$tmp/docker.tgz" -C "$tmp"
  install -m 0755 "$tmp/docker/docker" "$bin/docker"

  if "$bin/colima" version >/dev/null 2>&1; then
    echo "Colima engine ready: $("$bin/colima" version 2>/dev/null | head -1)"
  else
    echo "ERROR: colima failed to run after install." >&2
    exit 1
  fi
}

case "$(uname -s)" in
  Darwin)
    # On macOS the engine is Colima. A bare `docker` CLI may already exist (e.g.
    # left over from Docker Desktop), so key the "already installed" check on
    # colima specifically — on PATH or in our own engine dir.
    if command -v colima >/dev/null 2>&1 || [ -x "$ENGINE_DIR/bin/colima" ]; then
      echo "colima already installed."
      exit 0
    fi
    if command -v brew >/dev/null 2>&1; then
      echo "Installing Colima + Docker CLI via Homebrew (no Docker Desktop)…"
      brew install colima docker
    else
      install_engine_no_brew
    fi
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
