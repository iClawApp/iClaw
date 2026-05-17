/**
 * Reusable Vitest mocks for the OpenClaw client surface. Tests stub these so
 * nothing reaches a real gateway — and so we can drive precise event
 * sequences (deltas, lifecycle, finals, errors) into chatRunner.
 *
 * Use:
 *   vi.mock('../../src/services/openclawWs', () => makeOpenclawWsMock());
 *   const { openclawWs } = await import('../../src/services/openclawWs');
 */

import { vi } from 'vitest';
import type { TurnEvent } from '../../src/services/openclawWs';

export interface ScriptedTurn {
  events: TurnEvent[];
  finalText?: string;
  /** When set, runTurn rejects after emitting any provided events. */
  rejectAfter?: Error;
}

export function makeOpenclawWsMock(opts: {
  scripts?: ScriptedTurn[];
  historyByKey?: Record<string, Array<{ role: string; content: unknown }>>;
} = {}): { openclawWs: Record<string, ReturnType<typeof vi.fn>> } {
  const scripts = [...(opts.scripts ?? [])];
  const historyByKey = opts.historyByKey ?? {};

  let sessionCounter = 0;

  const openclawWs = {
    listAgents: vi.fn(async () => [{ id: 'main' }, { id: 'code' }]),
    createSession: vi.fn(async (params: { agentId?: string } = {}) => {
      sessionCounter += 1;
      return {
        key: `agent:test-${sessionCounter}`,
        sessionId: `sess-${sessionCounter}`,
        agentId: params.agentId ?? 'main',
      };
    }),
    deleteSession: vi.fn(async () => undefined),
    getHistory: vi.fn(async (sessionKey: string) => historyByKey[sessionKey] ?? []),
    abortRun: vi.fn(async () => undefined),
    runTurn: vi.fn(
      async (params: {
        sessionKey: string;
        message: string;
        onEvent: (ev: TurnEvent) => void;
      }) => {
        const script = scripts.shift() ?? { events: [], finalText: '' };
        for (const ev of script.events) {
          params.onEvent(ev);
        }
        if (script.rejectAfter) throw script.rejectAfter;
        return { runId: `run-${sessionCounter}`, text: script.finalText ?? '' };
      },
    ),
    resolveExecApproval: vi.fn(async () => undefined),
    usageCost: vi.fn(async () => ({ totalUsd: 0.42 })),
    listModels: vi.fn(async () => ({
      models: [{ id: 'openai/gpt-4o', label: 'GPT-4o' }],
    })),
    listCommands: vi.fn(async () => ({
      commands: [
        { name: 'compact', description: 'Summarize older messages' },
        { name: 'reasoning', description: 'Toggle reasoning visibility' },
      ],
    })),
    patchSession: vi.fn(async () => ({ ok: true })),
    subscribeSessions: vi.fn(async () => undefined),
  };

  return { openclawWs };
}
