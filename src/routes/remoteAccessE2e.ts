import type { RequestHandler } from 'express';

import {
  getTunnelIdFromRequest,
  isGateEnabled,
  isTunneledRequest,
} from '../services/remoteAccessAuth';

export const remoteAccessE2eBootstrapHandler: RequestHandler = (req, res) => {
  if (!isTunneledRequest(req)) {
    res.status(404).json({ e2e: false });
    return;
  }
  const tunnelId = getTunnelIdFromRequest(req);
  if (!tunnelId || !isGateEnabled(tunnelId)) {
    res.status(404).json({ e2e: false });
    return;
  }
  res.json({
    e2e: true,
    tunnelId,
    opaque: true,
    httpPath: '/__ra/e2e/http',
    wsPath: '/__ra/e2e/ws',
  });
};
