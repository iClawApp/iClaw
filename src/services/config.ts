import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface OpenClawConfig {
  baseUrl: string;
  token: string;
  source: 'env' | 'home-config' | 'none';
}

function readGatewayPortFromServiceEnv(): number | null {
  const path = join(homedir(), '.openclaw', 'service-env', 'ai.openclaw.gateway.env');
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?OPENCLAW_GATEWAY_PORT\s*=\s*"?(\d+)"?/);
    if (m) return Number(m[1]);
  }
  return null;
}

function readHomeConfig(): { token: string; port?: number } | null {
  const path = join(homedir(), '.openclaw', 'openclaw.json');
  if (!existsSync(path)) return null;
  try {
    const json = JSON.parse(readFileSync(path, 'utf8'));
    const token = json?.gateway?.auth?.token;
    if (typeof token !== 'string' || !token) return null;
    return { token };
  } catch {
    return null;
  }
}

/**
 * Optional iClaw-cloud (encrypted share server) base URL. Empty / missing
 * means the share feature stays hidden in the UI. The browser talks to this
 * URL directly — iClaw itself never relays share traffic.
 */
export function loadCloudShareBaseUrl(): string {
  const raw = (process.env.ICLAW_CLOUD_URL ?? '').trim();
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
}

export function loadOpenClawConfig(): OpenClawConfig {
  const envToken = process.env.OPENCLAW_API_KEY?.trim();
  const envUrl = process.env.OPENCLAW_BASE_URL?.trim();

  if (envToken && envUrl) {
    return { baseUrl: envUrl.replace(/\/$/, ''), token: envToken, source: 'env' };
  }

  const home = readHomeConfig();
  const port = readGatewayPortFromServiceEnv() ?? 18789;
  const fallbackUrl = `http://127.0.0.1:${port}`;
  const baseUrl = (envUrl ?? fallbackUrl).replace(/\/$/, '');

  if (envToken) return { baseUrl, token: envToken, source: 'env' };
  if (home?.token) return { baseUrl, token: home.token, source: 'home-config' };

  return { baseUrl, token: '', source: 'none' };
}
