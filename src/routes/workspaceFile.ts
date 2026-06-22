/**
 * GET /workspace-file?path=<abs>[&download=1]
 *
 * Serve a file an agent wrote and linked by raw local path, so the user can open it
 * from chat instead of hunting in Finder. Authorization (allowlisted roots, realpath
 * containment, secret deny-list) lives in ../services/workspaceFiles — this is just
 * the HTTP shell. Sits behind the same auth middleware as the rest of the app.
 */
import { Router, type Request, type Response } from 'express';

import { resolveAllowedRoots, resolveServedFile, isInlineSafe } from '../services/workspaceFiles';

export const workspaceFileRouter: Router = Router();

workspaceFileRouter.get('/workspace-file', (req: Request, res: Response) => {
  const rawPath = typeof req.query.path === 'string' ? req.query.path : '';
  const forceDownload = req.query.download === '1' || req.query.download === 'true';

  const r = resolveServedFile(rawPath, resolveAllowedRoots());
  if (!r.ok) {
    res.status(r.status).type('text/plain').send(r.reason);
    return;
  }

  // Never let the browser sniff an agent file into active content, and force a
  // download for anything not on the inline-safe allowlist (html/svg/js etc.).
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const disposition = forceDownload || !isInlineSafe(r.realPath) ? 'attachment' : 'inline';
  res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(r.fileName)}`);

  res.sendFile(r.realPath, (err) => {
    if (err && !res.headersSent) res.status(500).type('text/plain').send('Could not read the file.');
  });
});
