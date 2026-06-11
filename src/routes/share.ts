import { Router, type Request, type Response } from 'express';

import { cloudShareBaseUrl } from '../services/openclaw';

/**
 * Share-upload proxy: browser → local server → iClaw-cloud.
 *
 * The chat is encrypted in the browser; the ciphertext is POSTed to iClaw-cloud
 * (`<cloud>/api/shares`). But that cross-origin POST needs a CORS preflight, and
 * the cloud currently answers OPTIONS with a 500 and no CORS headers — so the
 * browser's `fetch` fails with "Failed to fetch" (in BOTH the desktop app and the
 * npx browser build, whose origin is http://127.0.0.1:<random-port>).
 *
 * We sidestep CORS by forwarding the upload server-side (no preflight) and
 * returning the cloud's reply verbatim. Only OPAQUE ciphertext passes through —
 * the decryption key never leaves the URL fragment, so the local server relays
 * nothing it (or we) could read. The recipient link still points straight at the
 * cloud (`<cloud>/s/<id>`), so retrieval is unchanged.
 */
export const shareRouter = Router();

shareRouter.post('/api/shares', async (req: Request, res: Response) => {
  if (!cloudShareBaseUrl) {
    res.status(404).json({ error: 'sharing disabled' });
    return;
  }
  try {
    const upstream = await fetch(`${cloudShareBaseUrl}/api/shares`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req.body ?? {}),
    });
    const text = await upstream.text();
    res
      .status(upstream.status)
      .type(upstream.headers.get('content-type') ?? 'application/json')
      .send(text);
  } catch {
    res.status(502).json({ error: 'share upstream unreachable' });
  }
});
