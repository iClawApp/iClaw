import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { kvGet, kvSet, kvDelete } from '../db/kv';

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
 * iClaw-cloud base URL for end-to-end chat sharing. When unset, defaults to
 * the public iClaw-cloud host. Set to 0, false, off, no, or disabled (case
 * insensitive) to hide the Share button. The browser POSTs ciphertext here
 * directly — iClaw never relays share traffic.
 */
export function loadCloudShareBaseUrl(): string {
  const raw = (process.env.ICLAW_CLOUD_URL ?? '').trim();
  if (/^(0|false|off|no|disabled)$/i.test(raw)) return '';
  const base = (raw || 'https://app.iclaw.digital').replace(/\/+$/, '');
  return base;
}

export interface OpenRouterConfig {
  /** Empty when unconfigured — gates Ask/STT and title routing. */
  apiKey: string;
  baseUrl: string;
  /** Model for Ask turns. */
  askModel: string;
  /** Model for chat-title generation (cheapest sensible default). */
  titleModel: string;
  /** Cheap model for context compaction (summarizing old turns). */
  summaryModel: string;
  /** Multimodal model used for speech-to-text transcription. */
  sttModel: string;
  /** OpenRouter app-attribution headers (optional, for rankings). */
  referer: string;
  appTitle: string;
}

/** KV key under which the user's OpenRouter API key is stored (set in Settings). */
const OPENROUTER_API_KEY_KV = 'openrouter.api_key';

/**
 * Direct OpenRouter access for the tool-less features (Ask, titles, STT).
 *
 * The API key is entered by the user in Settings and stored in the local DB
 * (`iclaw_kv`) — NOT an env var. Models default to a cheap, fast, multimodal
 * flash model; advanced users can still override per-feature via the optional
 * `ICLAW_*_MODEL` env vars (undocumented).
 */
export function loadOpenRouterConfig(): OpenRouterConfig {
  const apiKey = (kvGet(OPENROUTER_API_KEY_KV) ?? '').trim();
  const baseUrl = (
    process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1'
  ).replace(/\/+$/, '');
  const askModel = process.env.ICLAW_ASK_MODEL?.trim() || 'google/gemini-2.5-flash';
  const titleModel = process.env.ICLAW_TITLE_MODEL?.trim() || 'google/gemini-2.5-flash';
  // Cheap/fast model for compaction; overridable. Falls back to truncation if
  // the call fails, so an invalid slug degrades gracefully.
  const summaryModel = process.env.ICLAW_SUMMARY_MODEL?.trim() || 'tencent/hy3-preview';
  const sttModel = process.env.ICLAW_STT_MODEL?.trim() || 'google/gemini-2.5-flash';
  const referer = process.env.OPENROUTER_REFERER?.trim() || 'https://iclaw.digital';
  const appTitle = process.env.OPENROUTER_APP_TITLE?.trim() || 'iClaw';
  return { apiKey, baseUrl, askModel, titleModel, summaryModel, sttModel, referer, appTitle };
}

/** Persist the user's OpenRouter API key (from Settings). Empty/blank clears it. */
export function setOpenRouterApiKey(key: string): void {
  const trimmed = key.trim();
  if (trimmed) kvSet(OPENROUTER_API_KEY_KV, trimmed);
  else kvDelete(OPENROUTER_API_KEY_KV);
}

/** Remove the stored OpenRouter API key (disconnect). */
export function clearOpenRouterApiKey(): void {
  kvDelete(OPENROUTER_API_KEY_KV);
}

/** KV key recording that the user has been through (or skipped) the welcome flow. */
const ONBOARDING_DONE_KV = 'onboarding.done';

/**
 * Has the first-run welcome flow been completed (or explicitly skipped)?
 * This is the sole gate for showing /welcome — independent of whether a key is
 * set, so a user can dismiss the screen and still configure things later.
 */
export function isOnboardingDone(): boolean {
  return kvGet(ONBOARDING_DONE_KV) === '1';
}

/** Mark the welcome flow complete so it never shows again (unless reset). */
export function setOnboardingDone(): void {
  kvSet(ONBOARDING_DONE_KV, '1');
}

/**
 * A privacy-preserving display form of the stored key: keeps the `sk-or-`
 * prefix and the last 4 chars, masks the middle. Empty string when unset.
 */
export function maskOpenRouterApiKey(): string {
  const key = (kvGet(OPENROUTER_API_KEY_KV) ?? '').trim();
  if (!key) return '';
  if (key.length <= 12) return '••••' + key.slice(-2);
  return key.slice(0, 7) + '••••••••' + key.slice(-4);
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
