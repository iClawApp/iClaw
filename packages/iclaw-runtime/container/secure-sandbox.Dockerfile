# syntax=docker/dockerfile:1.7
# iClaw Secure-Mode sandbox image.
#
# Minimal, single-purpose: a long-lived `sleep` container that the host
# docker-execs into for one turn at a time (see src/secure-runner.ts).
# Ships Chromium + the `agent-browser` CLI so the agent can browse the web
# from *inside* the isolated container — network reachability is governed
# systemically by the container's `--network` flag, not by any prompt.
#
# Built via container/build-secure.sh → tag `iclaw-secure:latest`.
# Runs as the non-root `node` user (like NanoClaw) so Chromium does not
# require --no-sandbox.

FROM node:22-slim

# CJK fonts add ~200MB; opt in only if rendering Chinese/Japanese/Korean.
ARG INSTALL_CJK_FONTS=false
# Pin deliberately — unpinned installs drift on every rebuild.
ARG AGENT_BROWSER_VERSION=latest
ARG PNPM_VERSION=10.33.0

# ---- System deps: Chromium + the shared libs it needs to launch ------------
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
        libgbm1 \
        libnss3 \
        libatk-bridge2.0-0 \
        libgtk-3-0 \
        libx11-xcb1 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libasound2 \
        libpangocairo-1.0-0 \
        libcups2 \
        libdrm2 \
        libxshmfence1 \
        ca-certificates \
        curl \
    && if [ "$INSTALL_CJK_FONTS" = "true" ]; then \
        apt-get install -y --no-install-recommends fonts-noto-cjk; \
       fi \
    && rm -rf /var/lib/apt/lists/*

# Point agent-browser / Playwright at the system Chromium and stop Playwright's
# postinstall from downloading its own ~300MB copy.
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# ---- agent-browser CLI (global, via pnpm) ----------------------------------
# agent-browser has a postinstall build step; pnpm's supply-chain policy blocks
# build scripts unless allowlisted, so opt it in explicitly.
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
RUN --mount=type=cache,target=/root/.cache/pnpm \
    echo "only-built-dependencies[]=agent-browser" > /root/.npmrc && \
    pnpm install -g "agent-browser@${AGENT_BROWSER_VERSION}"

# ---- Workspace + non-root user ---------------------------------------------
# /workspace is the host bind-mount target. Home must be writable for Chromium's
# profile/cache. Running as `node` avoids needing Chromium's --no-sandbox.
RUN mkdir -p /workspace && chown -R node:node /workspace && chmod 777 /home/node

USER node
WORKDIR /workspace

# Default command; the host overrides argv with `sleep 3600` at run time.
CMD ["sleep", "3600"]
