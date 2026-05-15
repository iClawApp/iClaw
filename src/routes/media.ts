/**
 * Proxy /media/* to OpenClaw's /api/chat/media/* with the gateway bearer
 * token injected, so the browser can render <img>/<video> src URLs without
 * having to handle auth itself.
 *
 * Stream-passthrough — no buffering, no caching. Anything > 25 MB is rare in
 * chat attachments but we still pipe rather than read into memory.
 */

import { Router, type Request, type Response } from 'express';
import { loadOpenClawConfig } from '../services/config';

export const mediaRouter: Router = Router();

const COPY_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-disposition',
  'last-modified',
  'etag',
];

mediaRouter.get('/*splat', async (req: Request, res: Response) => {
  const cfg = loadOpenClawConfig();
  if (!cfg.token) {
    res.status(503).type('text/plain').send('OpenClaw token not configured');
    return;
  }

  // Reconstruct the upstream path. Express stores the wildcard match in
  // req.params[0] (string) for legacy syntax and in an array for the
  // path-to-regexp v6 splat syntax — handle both.
  const splat = (req.params as Record<string, unknown>).splat;
  let suffix: string;
  if (Array.isArray(splat)) suffix = splat.join('/');
  else if (typeof splat === 'string') suffix = splat;
  else suffix = req.path.replace(/^\//, '');

  const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const upstreamUrl = `${cfg.baseUrl}/api/chat/media/${suffix}${search}`;

  try {
    const upstream = await fetch(upstreamUrl, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${cfg.token}`,
        accept: req.headers.accept ?? '*/*',
      },
    });

    res.status(upstream.status);
    for (const h of COPY_RESPONSE_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    // No-cache by default — attachments can be regenerated; safer not to cache.
    res.setHeader('cache-control', 'no-store');

    if (!upstream.body) {
      res.end();
      return;
    }

    // Stream the body through.
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && !res.write(Buffer.from(value))) {
        // Wait for drain before continuing — prevents memory blow-up on slow
        // clients consuming large attachments.
        await new Promise<void>((r) => res.once('drain', r));
      }
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) res.status(502);
    res.type('text/plain').send(`media proxy failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});
