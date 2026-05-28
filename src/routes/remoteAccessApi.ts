/**
 * JSON API for the Settings → Remote Access page.
 *
 *   POST /api/remote-access/start   { durationMs }  → status
 *   POST /api/remote-access/stop                    → { ok: true }
 *   GET  /api/remote-access/status                  → status
 *
 * `localHost` / `localPort` are not part of the API surface — the iClaw
 * process knows where it's bound (set via remoteAccess.start* from
 * index.ts on startup) and reuses those for every loopback request.
 */

import { Router } from 'express';
import {
  remoteAccess,
  ALLOWED_DURATIONS_MS,
  getRelayUrl,
  type RemoteAccessStatus,
} from '../services/remoteAccess';
import { getBoundLocalAddress } from '../services/localAddress';

export const remoteAccessApiRouter = Router();

function jsonStatus(): RemoteAccessStatus & { allowedDurationsMs: readonly number[] } {
  return {
    ...remoteAccess.getStatus(),
    allowedDurationsMs: ALLOWED_DURATIONS_MS,
  };
}

remoteAccessApiRouter.get('/status', (_req, res) => {
  res.json(jsonStatus());
});

remoteAccessApiRouter.post('/start', (req, res) => {
  const raw = req.body?.durationMs;
  const durationMs = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(durationMs) || !ALLOWED_DURATIONS_MS.includes(durationMs)) {
    res.status(400).json({
      error: 'durationMs must be one of the allowed values',
      allowedDurationsMs: ALLOWED_DURATIONS_MS,
    });
    return;
  }

  const bound = getBoundLocalAddress();
  if (!bound) {
    res.status(503).json({ error: 'iClaw server not bound yet — try again in a moment' });
    return;
  }

  try {
    remoteAccess.startWithDuration(durationMs, {
      relayUrl: getRelayUrl(),
      localHost: bound.host,
      localPort: bound.port,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'failed to start' });
    return;
  }

  res.json(jsonStatus());
});

remoteAccessApiRouter.post('/stop', (_req, res) => {
  remoteAccess.stopNow();
  res.json({ ok: true });
});
