/**
 * Lightweight Anthropic→OpenRouter compatibility proxy.
 *
 * Claude Code SDK sends beta headers (claude-code-20250219, advisor-tool-2026-03-01,
 * prompt-caching-scope-2026-01-05) that OpenRouter doesn't support and returns 400.
 * This proxy strips unsupported betas and forwards the request to OpenRouter.
 *
 * Call spawnOpenRouterProxy() to start it. It sets ANTHROPIC_BASE_URL in process.env
 * so Claude Code picks it up automatically.
 */

const OPENROUTER_BASE = 'https://openrouter.ai';
export const PROXY_PORT = 7431;

// Betas that OpenRouter's Anthropic-compatible endpoint supports
const ALLOWED_BETAS = new Set([
  'interleaved-thinking-2025-05-14',
  'prompt-caching-2024-07-31',
  'max-tokens-3-5-sonnet-2024-07-15',
  'computer-use-2024-10-22',
]);

function filterBetas(betaHeader: string): string {
  return betaHeader
    .split(',')
    .map((b) => b.trim())
    .filter((b) => ALLOWED_BETAS.has(b))
    .join(',');
}

/** Start the proxy and point ANTHROPIC_BASE_URL at it. */
export function spawnOpenRouterProxy(): void {
  // Only start if we're going through OpenRouter
  if (!process.env.ANTHROPIC_API_KEY?.startsWith('sk-or-')) return;

  Bun.serve({
    port: PROXY_PORT,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const targetUrl = new URL(url.pathname + url.search, OPENROUTER_BASE);

      const headers = new Headers();
      for (const [key, value] of req.headers.entries()) {
        if (key.toLowerCase() === 'host') continue;
        if (key.toLowerCase() === 'anthropic-beta') {
          const filtered = filterBetas(value);
          if (filtered) headers.set('anthropic-beta', filtered);
          continue;
        }
        headers.set(key, value);
      }

      const body = req.method !== 'GET' && req.method !== 'HEAD' ? await req.arrayBuffer() : undefined;
      const upstream = await fetch(targetUrl.toString(), { method: req.method, headers, body });
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    },
  });

  // Point Claude Code at the proxy (SDK appends /v1)
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${PROXY_PORT}/api`;
  console.error(`[openrouter-proxy] Started on port ${PROXY_PORT}`);
}
