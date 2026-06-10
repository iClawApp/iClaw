import { Router, type Request, type Response } from 'express';

import { kvSet, kvDelete } from '../db/kv';

/**
 * Server-persisted UI state.
 *
 * The frontend's `window.iclawUI` (see views/partials/head.ejs) uses this as a
 * port-stable replacement for localStorage: in the desktop app the page origin
 * is http://127.0.0.1:<ephemeral-port>, so localStorage resets on every launch.
 * Flags like "the sidebar tip was discovered" therefore never stick. Persisting
 * them in the DB (keyed `ui.<key>` in iclaw_kv) survives port changes, reinstalls
 * and the browser/app split — one source of truth for small UI preferences.
 *
 * Single-user, localhost-bound app — no auth beyond the server's own binding.
 */
export const uiStateRouter = Router();

uiStateRouter.post('/api/ui-state', (req: Request, res: Response) => {
  const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
  if (!key || key.length > 128) {
    res.status(400).json({ error: 'invalid key' });
    return;
  }
  const value = req.body?.value;
  if (value === null || value === undefined) {
    kvDelete(`ui.${key}`);
  } else {
    kvSet(`ui.${key}`, String(value));
  }
  res.json({ ok: true });
});
