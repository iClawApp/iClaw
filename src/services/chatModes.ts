/**
 * Single source of truth for chat "modes" — the lightweight Ask vs. full
 * Execute distinction the composer offers, plus a place to grow future modes
 * (Research, Image, Safe Run) without hardcoding two modes everywhere.
 *
 * Design notes
 * ------------
 * - The wire/DB value is a plain string. The TS union (`ChatMode` in
 *   ../types) only names the two LIVE modes; the catalog below can list
 *   `enabled: false` placeholders for modes we haven't built yet. Adding a
 *   live mode later = flip `enabled` and (if it needs a new union member)
 *   widen `ChatMode`. No DB migration is needed because the column is TEXT.
 *
 * - `DEFAULT_MODE` is 'execute' so anything that doesn't specify a mode —
 *   legacy rows, older clients, scheduled messages, task runs — behaves
 *   exactly as before. `normalizeChatMode()` enforces this fallback.
 *
 * Routing Ask differently in the future
 * -------------------------------------
 * Today Ask reuses the same OpenClaw session as Execute and is differentiated
 * by a short instruction prepended to the gateway message (see
 * `applyModeToGatewayMessage`). Two cleaner backends are possible later and
 * the seams are already here:
 *
 *   1. No-tools / lightweight OpenClaw profile — if the gateway gains a way to
 *      run a session with tools disabled, return that descriptor from
 *      `gatewayProfileForMode()` and have the WS client pass it on
 *      `sessions.create` / `chat.send`. `lightweight: true` already marks the
 *      modes that want it.
 *   2. OpenRouter / OpenAI direct — for a true "no agent" answer, branch in
 *      chatRunner on `getModeDef(mode).lightweight` and call an LLM client
 *      instead of `openclawWs.runTurn`. The mode is persisted per message, so
 *      this can be added without any schema or UI change.
 */

import type { ChatMode } from '../types';

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
   * True when the mode wants a no-tools / no-heavy-execution answer. Drives
   * the Ask gateway preamble today and is the hook future routing keys off.
   */
  lightweight: boolean;
}

/**
 * The full catalog. Order here is the order shown in the UI. Disabled entries
 * are intentionally kept so the selector and any future router can enumerate
 * the roadmap without scattering string literals across the codebase.
 */
export const CHAT_MODES: readonly ChatModeDef[] = [
  {
    id: 'ask',
    label: 'Ask',
    description:
      'For simple questions, explanations, planning. No heavy agent execution.',
    enabled: true,
    lightweight: true,
  },
  {
    id: 'execute',
    label: 'Execute',
    description:
      'For tasks that may need files, tools, shell, browser, or actions.',
    enabled: true,
    lightweight: false,
  },
  // --- Planned modes (not selectable yet) -------------------------------
  // Flip `enabled: true` and wire the backend when each is implemented.
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
  {
    id: 'safe_run',
    label: 'Safe Run',
    description: 'Execute with tighter sandboxing and approvals. (Coming soon.)',
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

/** Enabled modes only — feeds the composer selector (EJS locals / client). */
export function listSelectableModes(): ChatModeDef[] {
  return CHAT_MODES.filter((m) => m.enabled);
}

function findMode(id: string): ChatModeDef | undefined {
  return CHAT_MODES.find((m) => m.id === id);
}

/** True only for an enabled, known mode id. */
export function isSelectableMode(id: string): boolean {
  const def = findMode(id);
  return Boolean(def && def.enabled);
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

/**
 * Instruction prepended to lightweight-mode messages so the agent answers
 * without spinning up heavy tool/agent execution. Returns the message
 * unchanged for Execute (and any non-lightweight mode) — Execute must stay
 * byte-for-byte identical to today's behavior.
 *
 * This is the interim mechanism. See the module header for the no-tools
 * profile / OpenRouter alternatives that can replace it later.
 */
const ASK_PREAMBLE = [
  '[iClaw Ask mode]',
  'The user is in "Ask" mode — a lightweight question, explanation, or planning request.',
  'Answer directly from reasoning and knowledge. Avoid running shell commands, editing or',
  'creating files, or driving the browser/other tools unless it is strictly required to answer.',
  'Do not begin a long autonomous task; keep it conversational and concise.',
  '',
  '',
].join('\n');

export function applyModeToGatewayMessage(mode: ChatMode, message: string): string {
  return getModeDef(mode).lightweight ? ASK_PREAMBLE + message : message;
}

/**
 * Reserved hook for a future no-tools / lightweight OpenClaw session profile.
 * Returns `null` today because the gateway exposes no such knob — callers must
 * treat `null` as "no special profile, send normally". Wire this up (and have
 * openclawWs forward it) if/when the gateway supports disabling tools.
 */
export function gatewayProfileForMode(_mode: ChatMode): null {
  return null;
}
