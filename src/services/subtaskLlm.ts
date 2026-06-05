/**
 * Shared runner for the background "throwaway" LLM sub-tasks — fact extraction,
 * fact compaction, and skill review. These are cheap, tool-less, single-shot
 * prompts that should NOT spin up a full OpenClaw agent run when a direct,
 * cheaper path is available.
 *
 * Routing:
 *   1. If OpenRouter is configured, run on the cheap `summaryModel` via a direct
 *      /chat/completions call (much cheaper than an OpenClaw agent turn).
 *   2. Otherwise — or if the OpenRouter call fails — fall back to a throwaway
 *      OpenClaw session on the default `main` agent (the original behaviour).
 *
 * Only the background sub-tasks use this. The user-facing turns (Ask, Execute,
 * Work, Secure) keep their own backends.
 */

import { openclawWs } from './openclawWs';
import { complete, openRouterEnabled, isOpenRouterFailure } from './openRouter';
import { loadOpenRouterConfig } from './config';

/**
 * Sub-tasks always run against the gateway's default agent when falling back to
 * OpenClaw. Using whatever agent the chat is on risked specialised agents
 * underperforming on a plain text-extraction prompt. One agent, one behaviour.
 */
const SUBTASK_AGENT_ID = 'main';

export interface SubtaskTurnOptions {
  /** Optional system prompt (OpenRouter path only; ignored on OpenClaw fallback). */
  system?: string;
  temperature?: number;
  maxTokens?: number;
}

/** Throwaway OpenClaw session — original behaviour, used as the fallback path. */
async function runViaOpenClaw(message: string): Promise<string> {
  let sessionKey: string | null = null;
  try {
    const session = await openclawWs.createSession({ agentId: SUBTASK_AGENT_ID });
    sessionKey = session.key;
    let acc = '';
    await openclawWs.runTurn({
      sessionKey: session.key,
      message,
      onEvent: (ev) => {
        if (ev.type === 'text-delta') acc += ev.text;
        else if (ev.type === 'text-final') acc = ev.text || acc;
      },
    });
    return acc;
  } finally {
    if (sessionKey) openclawWs.deleteSession(sessionKey).catch(() => {});
  }
}

/**
 * Run a single-shot background sub-task prompt. Prefers OpenRouter (cheap model)
 * and falls back to OpenClaw when OpenRouter is unconfigured or the call throws.
 * Returns the assistant text (possibly empty — callers parse/validate it).
 */
export async function runSubtaskTurn(
  message: string,
  opts: SubtaskTurnOptions = {},
): Promise<string> {
  if (openRouterEnabled()) {
    try {
      const cfg = loadOpenRouterConfig();
      const messages = [];
      if (opts.system) messages.push({ role: 'system' as const, content: opts.system });
      messages.push({ role: 'user' as const, content: message });
      // Cheapest configured model — these tasks don't need a frontier model.
      return await complete({
        messages,
        model: cfg.summaryModel,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
      });
    } catch (err) {
      // OpenRouter unavailable / errored → fall back to OpenClaw rather than
      // dropping the sub-task. Log once; the fallback path is best-effort too.
      console.error(
        '[subtaskLlm] OpenRouter failed, falling back to OpenClaw',
        isOpenRouterFailure(err) ? (err as Error).message : err,
      );
    }
  }
  return runViaOpenClaw(message);
}
