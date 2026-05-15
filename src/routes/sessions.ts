import { Router } from 'express';
import { openclawWs } from '../services/openclawWs';

export const agentsRouter: Router = Router();

agentsRouter.get('/', async (_req, res, next) => {
  try {
    const raw = await openclawWs.listAgents();
    // Wrap into the "openclaw/<id>" namespace the UI expects.
    const items = [{ id: 'openclaw/default' }, ...raw.map((a) => ({ id: `openclaw/${a.id}` }))];
    res.json(items);
  } catch (err) {
    next(err);
  }
});
