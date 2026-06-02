/**
 * Single source of truth for chat "modes" — the lightweight Ask vs. full
 * Execute distinction the composer offers, plus a place to grow future modes
 * (Research, Image, Safe Run) without hardcoding two modes everywhere *
 * Design notes
 * ------------
 * - The wire/DB value is a plain string. The TS union (`ChatMode` in
 *   ../types) only names the two LIVE modes; the catalog below can list
 *   `enabled: false` placeholders for modes we haven't built yet. Adding a
 *   live mode later = flip `enabled` and (if it needs a new union member)
 *   widen `ChatMode`. No DB migration is needed because the column is TEXT *
 * - `DEFAULT_MODE` is 'execute' so anything that doesn't specify a mode —
 *   legacy rows, older clients, scheduled messages, task runs — behaves
 *   exactly as before. `normalizeChatMode()` enforces this fallback *
 * How Ask is enforced (tool-less by construction)
 * -----------------------------------------------
 * `lightweight: true` marks modes that answer WITHOUT a full OpenClaw agent
 * run. chatRunner routes a lightweight turn to a direct OpenRouter chat
 * completion (services/openRouter.ts) with NO `tools` field — so the model has
 * no shell/file/browser tools to call in the first place. After the answer,
 * chatRunner bridges the Q&A into the chat's main OpenClaw session via
 * `chat.inject` (zero-cost), so a later Execute turn is aware of it *
 * Availability is config-driven: Ask requires `OPENROUTER_API_KEY`. Without it,
 * `listSelectableModes`/`isSelectableMode` drop Ask from the composer and
 * coerce any posted 'ask' to Execute; chatRunner also refuses a lightweight
 * turn defensively. Titles fall back to OpenClaw, but Ask never silently runs
 * on a tool-capable agent */

import type { ChatMode } from '../types';
import { openRouterEnabled } from './openRouter';

export interface ChatModeDef {
  /** Wire/DB value. */
  id: string;
  /** Short label for the selector chip. */
  label: string;
  /** One-liner shown in the selector / tooltip. */
  description: string;
  /** Whether the mode is selectable today. Placeholders are `false`. */
  enabled: boolean;
  /**
   * True when the mode answers without a full agent run. chatRunner routes
   * these to OpenRouter (tool-less); availability requires OPENROUTER_API_KEY   */
  lightweight: boolean;
}

/**
 * The full catalog. Order here is the order shown in the UI. Disabled entries
 * are intentionally kept so the selector and any future router can enumerate
 * the roadmap without scattering string literals across the codebase */
export const CHAT_MODES: readonly ChatModeDef[] = [
  {
    id: 'ask',
    label: 'Ask',
    description: 'Chat with AI — no access to your files or computer',
    enabled: true,
    lightweight: true,
  },
  {
    id: 'work',
    label: 'Work',
    description: 'AI edits files in folders you choose — you approve every change',
    enabled: true,
    lightweight: false,
  },
  {
    id: 'secure',
    label: 'Secure',
    description: 'Runs in a locked sandbox — safe for untrusted code or scripts',
    enabled: true,
    lightweight: false,
  },
  {
    id: 'execute',
    label: 'Execute',
    description: 'Full access via OpenClaw — for complex tasks that need more power',
    enabled: true,
    lightweight: false,
  },
  // --- Planned modes (not selectable yet) -------------------------------
  {
    id: 'research',
    label: 'Research',
    description: 'Deep multi-source research with citations. (Coming soon.)',
    enabled: false,
    lightweight: false,
  },
  {
    id: 'image',
    label: 'Image',
    description: 'Generate or edit images. (Coming soon.)',
    enabled: false,
    lightweight: false,
  },
] as const;

/** Mode used whenever none is supplied or the supplied one is unknown/disabled. */
export const DEFAULT_MODE: ChatMode = 'execute';

/** Modes a client is allowed to select right now. */
export const ENABLED_MODE_IDS: readonly string[] = CHAT_MODES.filter(
  (m) => m.enabled,
).map((m) => m.id);

/**
 * A mode is available when it's enabled AND its backend is reachable. Lightweight
 * (Ask) modes run on OpenRouter, so they're hidden unless a key is configured —
 * this is what keeps Ask out of the composer (and coerces posted 'ask' →
 * 'execute') when OpenRouter is unconfigured */
function modeAvailable(def: ChatModeDef): boolean {
  if (!def.enabled) return false;
  if (def.lightweight && !openRouterEnabled()) return false;
  // Work and Secure modes require OpenRouter
  if ((def.id === 'work' || def.id === 'secure') && !openRouterEnabled()) return false;
  return true;
}

/** Available modes only — feeds the composer selector (EJS locals / client). */
export function listSelectableModes(): ChatModeDef[] {
  return CHAT_MODES.filter(modeAvailable);
}

function findMode(id: string): ChatModeDef | undefined {
  return CHAT_MODES.find((m) => m.id === id);
}

/** True only for an available (enabled + backend-reachable) known mode id. */
export function isSelectableMode(id: string): boolean {
  const def = findMode(id);
  return Boolean(def && modeAvailable(def));
}

/**
 * Coerce any untrusted input (query body, WS frame, DB row) into a valid,
 * currently-selectable `ChatMode`. Unknown, disabled, or missing → DEFAULT_MODE */
export function normalizeChatMode(raw: unknown): ChatMode {
  if (typeof raw !== 'string') return DEFAULT_MODE;
  const id = raw.trim().toLowerCase();
  if (isSelectableMode(id)) return id as ChatMode;
  return DEFAULT_MODE;
}

/** Definition for a (normalized) mode — always defined for selectable modes. */
export function getModeDef(mode: ChatMode): ChatModeDef {
  return findMode(mode) ?? findMode(DEFAULT_MODE)!;
}

