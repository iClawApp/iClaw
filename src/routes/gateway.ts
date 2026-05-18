/**
 * Thin HTTP proxies for OpenClaw RPCs that the browser UI needs:
 *
 *   GET  /api/gateway/commands         — slash-command catalog for `/` autocomplete
 *   GET  /api/gateway/usage/today      — gateway-side spend (cached 30s)
 */

import { Router } from 'express';
import { openclawWs } from '../services/openclawWs';

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

