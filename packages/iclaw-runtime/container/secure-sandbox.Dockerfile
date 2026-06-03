# syntax=docker/dockerfile:1.7
# iClaw sandbox image — the SINGLE image shared by Safe work and Work mode.
#
# A long-lived `sleep` container the host docker-execs into, one turn at a time
# (Safe work: src/secure-runner.ts) or bind-mounts the user's folders into for
# `run_command` (Work: src/work-container.ts → resolveWorkImage prefers this tag).
#
# Toolset is curated 80/20: the ~20% of CLIs that ~80% of agent turns reach for,
# and nothing heavy. Deliberately EXCLUDED: a browser (Chromium + agent-browser
# ~870MB — web access is via curl/wget, and our search runs a different path),
# language toolchains/compilers, and other large runtimes. The agent self-installs
# the long tail at runtime WITHOUT root into /workspace/.tools (on PATH), which
# lives in the bind-mounted, TTL-reaped workspace — installs persist across
# container restarts within a session and auto-delete when the workspace expires.
# For a heavier base (e.g. a Go/Rust toolchain), point ICLAW_WORK_IMAGE at a
# custom image instead of bloating this shared one.
#
# Built via container/build-secure.sh → tag `iclaw-secure:latest`.
# Runs as the non-root `node` user.

FROM node:22-slim

# Curated 80/20 CLIs. curl/wget + ca-certificates power web access and non-root
# self-installs (downloading static binaries). git, python3 and an editor cover
# the bulk of real agent work. All baked in (not apt-installed at runtime)
# because the container runs as non-root `node` and is recreated after idle reap
# — a runtime `apt install` can't work and wouldn't persist anyway.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        wget \
        git \
        ripgrep \
        python3 \
        nano \
        unzip \
        zip \
        xz-utils \
        bzip2 \
        jq \
        less \
        tree \
    && rm -rf /var/lib/apt/lists/*

# ---- Self-installed tools (no root) ----------------------------------------
# Drop static binaries into /workspace/.tools/bin, or `npm i -g <pkg>` (prefix
# below). Inside the bind-mounted, TTL-reaped workspace, so they persist across
# container restarts within a session and are auto-deleted when the workspace
# expires (~7 days) — see createSecureWorkspace / destroySecureWorkspace.
ENV NPM_CONFIG_PREFIX=/workspace/.tools/npm
ENV PATH="/workspace/.tools/bin:/workspace/.tools/npm/bin:$PATH"

# ---- Workspace + non-root user ---------------------------------------------
# /workspace is the host bind-mount target. Home must be writable for tool caches.
RUN mkdir -p /workspace && chown -R node:node /workspace && chmod 777 /home/node

USER node
WORKDIR /workspace

# Default command; the host overrides argv with `sleep 3600` at run time.
CMD ["sleep", "3600"]
