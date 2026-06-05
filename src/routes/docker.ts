/**
 * Docker status + lifecycle for the chat composer's Docker gate.
 *
 *   GET  /api/docker/status   — current daemon readiness (cached probe)
 *   POST /api/docker/start    — launch an installed-but-idle daemon (localhost)
 *   POST /api/docker/install  — install the engine, then start it (localhost)
 *
 * The actions run host commands, so they're localhost-only. They return at once
 * with a `starting`/`installing` state; the composer polls /status until ready.
 */

import { Router } from 'express';
import {
  DOCKER_SIZE_HINT,
  getDockerState,
  installDocker,
  startDocker,
} from '../services/docker';
import { isLocalhostRequest } from '../services/gatewayStart';

export const dockerRouter: Router = Router();

dockerRouter.get('/status', async (_req, res) => {
  res.json({ state: await getDockerState(), sizeHint: DOCKER_SIZE_HINT });
});

dockerRouter.post('/start', (req, res) => {
  if (!isLocalhostRequest(req)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  res.json({ state: startDocker() });
});

dockerRouter.post('/install', (req, res) => {
  if (!isLocalhostRequest(req)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  res.json({ state: installDocker() });
});
