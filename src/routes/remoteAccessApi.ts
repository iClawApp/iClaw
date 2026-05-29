/**
 * JSON API for the Settings → Remote Access page (multi-tunnel).
 *
 *   GET    /api/remote-access/tunnels        — list active tunnels + allowed durations
 *   POST   /api/remote-access/tunnels        — { durationMs, label? } → new tunnel
 *   DELETE /api/remote-access/tunnels/:id    — disable + delete one tunnel
 *   POST   /api/remote-access/tunnels/:id/regenerate-access — new ?access= token
 *
 * The legacy `/start` and `/stop` singleton endpoints are gone; the UI now
 * works against the collection.
 */

import { Router } from 'express';
import {
  remoteAccess,
  ALLOWED_DURATIONS_MS,
  type TunnelStatus,
} from '../services/remoteAccess';
import { remoteAccessDevices, type RemoteAccessDevice } from '../services/remoteAccessDevices';

export const remoteAccessApiRouter = Router();

function envelope(tunnels: TunnelStatus[]): {
  tunnels: TunnelStatus[];
  allowedDurationsMs: readonly number[];
} {
  return { tunnels, allowedDurationsMs: ALLOWED_DURATIONS_MS };
}

remoteAccessApiRouter.get('/tunnels', (_req, res) => {
  res.json(envelope(remoteAccess.list()));
});

remoteAccessApiRouter.post('/tunnels', async (req, res) => {
  const raw = req.body?.durationMs;
  const durationMs = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(durationMs) || !ALLOWED_DURATIONS_MS.includes(durationMs)) {
    res.status(400).json({
      error: 'durationMs must be one of the allowed values',
      allowedDurationsMs: ALLOWED_DURATIONS_MS,
    });
    return;
  }

  const labelRaw = req.body?.label;
  if (typeof labelRaw !== 'string' || !labelRaw.trim()) {
    res.status(400).json({ error: 'label is required' });
    return;
  }
  const label = labelRaw.trim().slice(0, 64);

  try {
    const status = await remoteAccess.createTunnel(durationMs, label);
    res.status(201).json(status);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'failed to create' });
  }
});

function deviceDto(d: RemoteAccessDevice): {
  id: string;
  tunnelId: string;
  name: string | null;
  userAgent: string | null;
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
} {
  return {
    id: d.id,
    tunnelId: d.tunnelId,
    name: d.name,
    userAgent: d.userAgent,
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt,
    revokedAt: d.revokedAt,
  };
}

remoteAccessApiRouter.get('/tunnels/:tunnelId/devices', (req, res) => {
  const tunnelId = req.params.tunnelId;
  if (!tunnelId) {
    res.status(400).json({ error: 'tunnelId required' });
    return;
  }
  if (!remoteAccess.getStatus(tunnelId)) {
    res.status(404).json({ error: 'tunnel not found' });
    return;
  }
  res.json({
    devices: remoteAccessDevices.listByTunnel(tunnelId).map(deviceDto),
  });
});

remoteAccessApiRouter.delete('/tunnels/:tunnelId/devices/:deviceId', (req, res) => {
  const { tunnelId, deviceId } = req.params;
  if (!tunnelId || !deviceId) {
    res.status(400).json({ error: 'tunnelId and deviceId required' });
    return;
  }
  if (!remoteAccess.getStatus(tunnelId)) {
    res.status(404).json({ error: 'tunnel not found' });
    return;
  }
  const ok = remoteAccessDevices.revoke(tunnelId, deviceId);
  if (!ok) {
    res.status(404).json({ error: 'device not found or already revoked' });
    return;
  }
  res.json({ ok: true });
});

remoteAccessApiRouter.post('/tunnels/:id/regenerate-access', (req, res) => {
  const id = req.params.id;
  if (!id || typeof id !== 'string') {
    res.status(400).json({ error: 'id required' });
    return;
  }
  const status = remoteAccess.regenerateAccessToken(id);
  if (!status) {
    res.status(404).json({ error: 'tunnel not found' });
    return;
  }
  res.json(status);
});

remoteAccessApiRouter.delete('/tunnels/:id', (req, res) => {
  const id = req.params.id;
  if (!id || typeof id !== 'string') {
    res.status(400).json({ error: 'id required' });
    return;
  }
  const ok = remoteAccess.deleteTunnel(id);
  if (!ok) {
    res.status(404).json({ error: 'tunnel not found' });
    return;
  }
  res.json({ ok: true });
});
