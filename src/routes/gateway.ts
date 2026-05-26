/**
 * Thin HTTP proxies for OpenClaw RPCs that the browser UI needs:
 *
 *   GET  /api/gateway/commands               — slash-command catalog for `/` autocomplete
 *   GET  /api/gateway/status                 — is the gateway HTTP health endpoint up?
 *   POST /api/gateway/start                  — `openclaw gateway start` (localhost only)
 *   GET  /api/gateway/session-reset-status   — does the user need to disable daily auto-reset?
 *   POST /api/gateway/session-reset-fix      — apply the "never reset" policy via config.patch
 */

import { Router } from 'express';
import { broadcastGatewayStatus } from '../services/gatewayEvents';
import { gatewayWs } from '../services/gatewayWs';
import { isLocalhostRequest, queueGatewayStart } from '../services/gatewayStart';
import { openclaw } from '../services/openclaw';
import { openclawWs } from '../services/openclawWs';

export const gatewayRouter: Router = Router();

gatewayRouter.get('/status', async (_req, res) => {
  res.json({ up: await openclaw.health() });
});

gatewayRouter.post('/start', async (req, res) => {
  if (!isLocalhostRequest(req)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  if (await openclaw.health()) {
    broadcastGatewayStatus('ok', null, { force: true });
    res.json({ ready: true });
    return;
  }

  void queueGatewayStart()
    .then(async (result) => {
      if (!result.ready) return;
      gatewayWs.resetConnection();
      try {
        await gatewayWs.ensureConnected();
        await openclawWs.subscribeSessions();
      } catch (err) {
        console.warn(
          '[gateway] reconnect after start failed:',
          err instanceof Error ? err.message : err,
        );
      }
      broadcastGatewayStatus('ok', null, { force: true });
    })
    .catch((err) => {
      console.warn(
        '[gateway] start task failed:',
        err instanceof Error ? err.message : err,
      );
    });

  res.json({ started: true });
});

interface CommandsResult {
  commands?: Array<{
    name?: string;
    description?: string;
    textAliases?: string[];
    scope?: string;
  }>;
}

gatewayRouter.get('/commands', async (req, res) => {
  const agentId = typeof req.query.agent === 'string' ? req.query.agent : undefined;
  try {
    const result = (await openclawWs.listCommands({ agentId })) as CommandsResult;
    const list = Array.isArray(result?.commands) ? result.commands : [];
    res.json({
      commands: list
        .map((c) => ({
          name: typeof c.name === 'string' ? c.name : '',
          description: typeof c.description === 'string' ? c.description : '',
          aliases: Array.isArray(c.textAliases)
            ? c.textAliases.filter((a) => typeof a === 'string')
            : [],
        }))
        .filter((c) => c.name),
    });
  } catch (err) {
    res
      .status(502)
      .json({ error: err instanceof Error ? err.message : 'gateway error', commands: [] });
  }
});

/* ------------------------- session reset policy ------------------------- */

/**
 * "Never reset" config our fix endpoint installs. 52 560 000 minutes ≈ 100
 * years — effectively turns the daily-reset behaviour off without inventing
 * a new mode that OpenClaw doesn't know.
 */
const NEVER_RESET = { mode: 'idle', idleMinutes: 52_560_000 } as const;
/** Resolve a possibly-deep value safely; returns undefined if any link is missing. */
function dig(obj: unknown, ...path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * The user-relevant reset-type for iClaw chats is `direct` (dashboard /
 * webchat). A session-wide `session.reset` covers it too. So "default policy
 * still in effect" means BOTH of these are missing — fresh OpenClaw install.
 */
function isDirectResetExplicitlySet(sessionCfg: unknown): boolean {
  const topLevel = dig(sessionCfg, 'reset', 'mode');
  if (typeof topLevel === 'string') return true;
  const perType = dig(sessionCfg, 'resetByType', 'direct', 'mode');
  if (typeof perType === 'string') return true;
  // Legacy alias the gateway honours.
  const dmAlias = dig(sessionCfg, 'resetByType', 'dm', 'mode');
  if (typeof dmAlias === 'string') return true;
  return false;
}

gatewayRouter.get('/session-reset-status', async (_req, res) => {
  try {
    const { config } = await openclawWs.getConfig();
    const sessionCfg = (config as { session?: unknown }).session;
    const explicit = isDirectResetExplicitlySet(sessionCfg);
    res.json({
      defaultPolicyActive: !explicit,
      currentSession: sessionCfg ?? null,
    });
  } catch (err) {
    res
      .status(502)
      .json({ error: err instanceof Error ? err.message : 'gateway error' });
  }
});

gatewayRouter.post('/session-reset-fix', async (_req, res) => {
  try {
    // Re-read the config (and its hash) right before patching — using a stale
    // hash from /session-reset-status would race with concurrent edits.
    const { hash, config } = await openclawWs.getConfig();
    const sessionCfg = (config as { session?: Record<string, unknown> }).session ?? {};
    // Merge our patch with whatever the user already had under resetByType,
    // so we don't clobber existing `thread` / `group` settings.
    const existingByType =
      (sessionCfg as { resetByType?: Record<string, unknown> }).resetByType ?? {};
    const patch = {
      session: {
        resetByType: {
          ...existingByType,
          direct: NEVER_RESET,
          group: existingByType.group ?? NEVER_RESET,
          thread: existingByType.thread ?? NEVER_RESET,
        },
      },
    };
    await openclawWs.patchConfig({
      patch,
      baseHash: hash,
      note: 'iClaw: disable daily session auto-reset (user-confirmed)',
    });
    res.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isScopeError = /missing scope|forbidden|unauthor/i.test(msg);
    res.status(isScopeError ? 403 : 502).json({
      error: msg,
      ...(isScopeError ? { reason: 'no-admin-scope' } : {}),
    });
  }
});



