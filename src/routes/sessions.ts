import { Router } from 'express';
import { openclaw } from '../services/openclaw';

export const agentsRouter: Router = Router();

agentsRouter.get('/', async (_req, res, next) => {
  try {
    const agents = await openclaw.listAgents();
    res.json(agents);
  } catch (err) {
    next(err);
  }
});
