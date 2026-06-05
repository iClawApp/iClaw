/**
 * Single source of truth for chat "modes" — the distinctions the composer
 * offers, plus a place to grow future modes without hardcoding them everywhere.
 *
 * Design notes
 * ------------
 * - The wire/DB value is a plain string. The TS union (`ChatMode` in ../types)
 *   names the live modes; the catalog below can list `enabled: false`
 *   placeholders for modes we haven't built yet. Adding a live mode later =
 *   flip `enabled` and (if it needs a new union member) widen `ChatMode`. No DB
 *   migration is needed because the column is TEXT.
 * - `DEFAULT_MODE` is 'execute' so anything that doesn't specify a mode —
 *   legacy rows, older clients, scheduled messages, task runs — behaves exactly
 *   as before. `normalizeChatMode()` enforces this fallback.
 *
 * Backends
 * --------
 * - execute → the chat's main OpenClaw agent session (full tools).
 * - work / secure / incognito → iclaw-runtime (our runtime), which requires
 *   OPENROUTER_API_KEY to be configured.
 *
 * Incognito (read-only, ephemeral)
 * --------------------------------
 * A privacy mode: read files in ANY folder, read-only shell in a sandbox over
 * folders the user selects, and web research — but NO writes and NO other
 * actions. The conversation is ephemeral (kept only in the browser tab, never
 * persisted) and contributes nothing to project memory. Enforcement lives in
 * the runtime; the host treats incognito turns as non-persistent.
 */

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
  /** Runs on iclaw-runtime (requires OPENROUTER_API_KEY), not the OpenClaw agent. */
  runtimeBacked: boolean;
  /** Ephemeral, never-persisted conversation (incognito). */
  ephemeral: boolean;
  /**
   * Mode is unusable without a running Docker daemon. Safe work IS the Docker
   * sandbox, so it fails closed without it. Work/Incognito only LOSE shell
   * commands (run_command) — their file tools run on the host — so they stay
   * usable and are NOT marked here; the UI shows a softer "shell needs Docker"
   * hint for them instead of disabling the mode.
   */
  requiresDocker: boolean;
}

/**
 * The full catalog. Order here is the order shown in the UI. Disabled entries
 * are intentionally kept so the selector and any future router can enumerate
 * the roadmap without scattering string literals across the codebase.
 */
export const CHAT_MODES: readonly ChatModeDef[] = [
  {
    id: 'work',
    label: 'Work',
    description: 'AI edits files in folders you choose - you approve every change',
    enabled: true,
    runtimeBacked: true,
    ephemeral: false,
    requiresDocker: false,
  },
  {
    id: 'secure',
    label: 'Safe work & Internet research',
    description: 'Locked sandbox - safely run untrusted code and research the web, isolated from your system',
    enabled: true,
    runtimeBacked: true,
    ephemeral: false,
    requiresDocker: true,
  },
  {
    id: 'execute',
    label: 'Full Power',
    description: 'Full access via OpenClaw - for complex tasks that need more power',
    enabled: true,
    runtimeBacked: false,
    ephemeral: false,
    requiresDocker: false,
  },
  // Set apart at the bottom (the composer renders a divider before any
  // `ephemeral` mode) — it's a distinct, off-the-record surface.
  {
    id: 'incognito',
    label: 'Incognito',
    description: 'Private, read-only research - reads files & the web, never writes, nothing saved',
    enabled: true,
    runtimeBacked: true,
    ephemeral: true,
    requiresDocker: false,
  },
  // --- Planned modes (not selectable yet) -------------------------------
  {
    id: 'image',
    label: 'Image',
    description: 'Generate or edit images. (Coming soon.)',
    enabled: false,
    runtimeBacked: false,
    ephemeral: false,
    requiresDocker: false,
  },
] as const;

/** Mode used whenever none is supplied or the supplied one is unknown/disabled. */
export const DEFAULT_MODE: ChatMode = 'execute';

/**
 * UI default for the composer's mode selector on a NEW/empty chat. Deliberately
 * separate from DEFAULT_MODE: the latter is the backend normalization fallback
 * (mode-less posted/API messages keep routing to the OpenClaw agent), while this
 * only seeds what the picker shows when there's nothing else to go on.
 */
export const DEFAULT_COMPOSER_MODE: ChatMode = 'work';

/** Modes a client is allowed to select right now. */
export const ENABLED_MODE_IDS: readonly string[] = CHAT_MODES.filter(
  (m) => m.enabled,
).map((m) => m.id);

/**
 * A mode is available when it's enabled AND its backend is reachable. The
 * runtime-backed modes (Work / Secure / Incognito) run on iclaw-runtime, which
 * requires OpenRouter — so they're hidden (and posted values coerced to
 * Execute) when no key is configured.
 */
function modeAvailable(def: ChatModeDef): boolean {
  if (!def.enabled) return false;
  if (def.runtimeBacked && !openRouterEnabled()) return false;
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
 * UI default for the composer, with a graceful fallback: Work is runtime-backed,
 * so when it isn't currently selectable (e.g. no OpenRouter key) we fall back to
 * the always-available DEFAULT_MODE instead of pre-selecting a hidden mode.
 */
export function defaultComposerMode(): ChatMode {
  return isSelectableMode(DEFAULT_COMPOSER_MODE) ? DEFAULT_COMPOSER_MODE : DEFAULT_MODE;
}

/**
 * Coerce any untrusted input (query body, WS frame, DB row) into a valid,
 * currently-selectable `ChatMode`. Unknown, disabled, or missing → DEFAULT_MODE.
 */
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

/** True for the ephemeral, never-persisted incognito mode. */
export function isEphemeralMode(mode: ChatMode): boolean {
  return getModeDef(mode).ephemeral;
}
