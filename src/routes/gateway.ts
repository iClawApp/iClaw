/**
 * Thin HTTP proxies for OpenClaw RPCs that the browser UI needs:
 *
 *   GET  /api/gateway/commands         — slash-command catalog for `/` autocomplete
 *   GET  /api/gateway/usage/today      — gateway-side spend (cached 30s)
 *   GET  /api/gateway/tools/:chatId    — tools effective for a session (sidebar)
 */

import { Router } from 'express';
import { openclawWs } from '../services/openclawWs';
import { chats } from '../services/store';
import { normalizeAgentId } from '../services/chatRunner';

export const gatewayRouter: Router = Router();

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

// 30s cache — usage.cost is a heavyish aggregate; we don't need second-by-second freshness.
let costCache: { expires: number; payload: unknown } | null = null;
const COST_TTL_MS = 30_000;

gatewayRouter.get('/usage/today', async (_req, res) => {
  const now = Date.now();
  if (costCache && costCache.expires > now) {
    res.json(costCache.payload);
    return;
  }
  try {
    // Today, local time → UTC ISO window. Most provider usage APIs accept
    // either YYYY-MM-DD or full ISO; we send midnight-to-now so half-day
    // queries are accurate.
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const result = (await openclawWs.usageCost({
      from: start.toISOString(),
      to: new Date().toISOString(),
    })) as { totalUsd?: number; total?: number; usd?: number };
    const total =
      typeof result?.totalUsd === 'number'
        ? result.totalUsd
        : typeof result?.total === 'number'
          ? result.total
          : typeof result?.usd === 'number'
            ? result.usd
            : null;
    const payload = { totalUsd: total, raw: result };
    costCache = { expires: now + COST_TTL_MS, payload };
    res.json(payload);
  } catch (err) {
    res
      .status(502)
      .json({ error: err instanceof Error ? err.message : 'gateway error', totalUsd: null });
  }
});

type NormalizedTool = {
  name: string;
  label?: string;
  description?: string;
  group?: string;
};

/**
 * Normalize tools.effective output. The gateway returns a tree:
 *   { agentId, profile, groups: [{id, label, source, tools: [{id, label, description, source}]}] }
 * and we flatten it into one list with each tool tagged by its group label.
 */
function normalizeTools(raw: unknown): NormalizedTool[] {
  const out: NormalizedTool[] = [];
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as { groups?: unknown; tools?: unknown };

  function pushFlatList(list: unknown, groupLabel: string | undefined): void {
    if (!Array.isArray(list)) return;
    for (const t of list) {
      if (!t || typeof t !== 'object') continue;
      const row = t as Record<string, unknown>;
      const name =
        typeof row.name === 'string'
          ? row.name
          : typeof row.id === 'string'
            ? row.id
            : '';
      if (!name) continue;
      out.push({
        name,
        label: typeof row.label === 'string' ? row.label : undefined,
        description: typeof row.description === 'string' ? row.description : undefined,
        group: groupLabel,
      });
    }
  }

  if (Array.isArray(r.groups)) {
    for (const g of r.groups) {
      if (!g || typeof g !== 'object') continue;
      const gRow = g as Record<string, unknown>;
      const groupLabel =
        typeof gRow.label === 'string'
          ? gRow.label
          : typeof gRow.id === 'string'
            ? gRow.id
            : 'other';
      pushFlatList(gRow.tools, groupLabel);
    }
  } else {
    // Fallback for flat shapes (older gateways or alternate endpoints).
    pushFlatList(Array.isArray(r.tools) ? r.tools : raw, undefined);
  }
  return out;
}

gatewayRouter.get('/tools/:chatId', async (req, res) => {
  const chatId = Number(req.params.chatId);
  const chat = chats.get(chatId);
  if (!chat) {
    res.status(404).json({ error: 'chat not found', tools: [] });
    return;
  }
  if (!chat.openclaw_session_id?.startsWith('agent:')) {
    res.json({ tools: [], note: 'session not yet bound to OpenClaw' });
    return;
  }
  try {
    const raw = await openclawWs.toolsEffective({
      sessionKey: chat.openclaw_session_id,
      agentId: normalizeAgentId(chat.agent),
    });
    res.json({ tools: normalizeTools(raw) });
  } catch (err) {
    res
      .status(502)
      .json({ error: err instanceof Error ? err.message : 'gateway error', tools: [] });
  }
});
