import { Router } from 'express';

/**
 * The standalone "Team" page is retired — the per-project specialist roster now
 * lives in the slide-out drawer + the launcher tiles. Old /team links redirect
 * home. (Specialist chat creation still goes through
 * POST /projects/:id/team/:characterId/chat in routes/projects.ts — unrelated.)
 */
export const teamRouter: Router = Router();

teamRouter.get('/', (_req, res) => {
  res.redirect('/');
});
