# syntax=docker/dockerfile:1.7
# iClaw Secure-Mode sandbox image (slim).
#
# A long-lived `sleep` container the host docker-execs into, one turn at a time
# (see src/secure-runner.ts). Ships a small, high-value CLI toolset (~10MB over
# the node base). Browsing (Chromium + agent-browser, ~870MB) was removed to keep
# the image lean — the agent reaches the web via `curl` instead.
#
# The agent can self-install more tools at runtime WITHOUT root into
# /workspace/.tools (on PATH), which lives in the bind-mounted, TTL-reaped
# workspace, so installs persist across container restarts and auto-delete when
# the workspace expires.
#
# Built via container/build-secure.sh → tag `iclaw-secure:latest`.
# Runs as the non-root `node` user.

FROM node:22-slim

# High-value CLIs. curl + ca-certificates also power web access and non-root
# self-installs (downloading static binaries). git is baked in (not apt-installed
# at runtime) because the container runs as non-root `node` and is recreated after
# idle reap — a runtime `apt install git` can't work and wouldn't persist anyway.
# Keep in sync with the Work-mode image (container/Dockerfile), which also ships git.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        ripgrep \
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
