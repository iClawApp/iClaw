/**
 * Thin HTTP helpers for the gateway. iClaw talks to OpenClaw over the native
 * WebSocket protocol via openclawWs.ts — this file is only kept for two tiny
 * things that don't need a full WS handshake:
 *
 *   - `baseUrl`    — used by templates and the media proxy
 *   - `health()`   — unauthenticated GET /health, used for the connection badge
 *
 * If you find yourself adding HTTP request/response logic here, you almost
 * certainly want openclawWs instead. See AGENTS.md.
 */

import {
  loadOpenClawConfig,
  loadCloudShareBaseUrl,
  type OpenClawConfig,
} from './config';

const config: OpenClawConfig = loadOpenClawConfig();

export const openclaw = {
  baseUrl: config.baseUrl,
  tokenSource: config.source,
  hasToken: Boolean(config.token),

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${config.baseUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  },
};

/**
 * Optional iClaw-cloud base URL. Empty string = feature disabled (Share button
 * hidden in the UI). Read at import time so a single process never changes
 * mid-flight; restart iClaw to pick up a config change.
 */
export const cloudShareBaseUrl: string = loadCloudShareBaseUrl();
