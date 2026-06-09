import { describe, it, expect } from 'vitest';

import { webFetchSandboxed, webSearchSecure } from '../../packages/iclaw-runtime/src/agent/tools';

// webFetchSandboxed is the Secure-Mode web_fetch: it runs `curl` INSIDE the
// sandbox via the injected runInSandbox callback and parses a marker-delimited
// payload. These tests drive it with a fake runInSandbox (no Docker), so they
// cover URL handling, the META/ERR parsing, HTML stripping, the within-turn
// cache, and — most importantly — that a model-supplied URL is shell-quoted so
// it can never break out into arbitrary commands.

const META = '__ICLAW_FETCH_META__';
const ok = (ct: string, body: string) => async () => `${META}200 ${ct}\n${body}`;

describe('webFetchSandboxed', () => {
  it('refuses non-http(s) URLs without touching the sandbox', async () => {
    let ran = false;
    const r = await webFetchSandboxed(
      { url: 'ftp://example.com/x' },
      { runInSandbox: async () => { ran = true; return ''; }, networkEnabled: true },
    );
    expect(ran).toBe(false);
    expect(r).toMatch(/absolute http/i);
  });

  it('returns guidance (and runs nothing) when network is OFF', async () => {
    let ran = false;
    const r = await webFetchSandboxed(
      { url: 'https://example.com' },
      { runInSandbox: async () => { ran = true; return ''; }, networkEnabled: false },
    );
    expect(ran).toBe(false);
    expect(r).toMatch(/network.*OFF/i);
  });

  it('parses the META marker + body and reports the HTTP status', async () => {
    const r = await webFetchSandboxed(
      { url: 'https://example.com/data.txt', summarize: false },
      { runInSandbox: ok('text/plain', 'hello world'), networkEnabled: true },
    );
    expect(r).toContain('HTTP 200');
    expect(r).toContain('hello world');
  });

  it('strips HTML when the content-type is html', async () => {
    const r = await webFetchSandboxed(
      { url: 'https://example.com', summarize: false },
      { runInSandbox: ok('text/html; charset=utf-8', '<html><body><p>Hi <b>there</b></p></body></html>'), networkEnabled: true },
    );
    expect(r).toContain('Hi');
    expect(r).toContain('there');
    expect(r).not.toContain('<b>');
  });

  it('surfaces a curl error marker as a fetch failure', async () => {
    const r = await webFetchSandboxed(
      { url: 'https://nope.invalid', summarize: false },
      { runInSandbox: async () => '__ICLAW_FETCH_ERR__exit 6\ncurl: (6) Could not resolve host', networkEnabled: true },
    );
    expect(r).toMatch(/Fetch failed/i);
  });

  it('single-quotes the URL so shell metacharacters cannot break out', async () => {
    let cmd = '';
    // No whitespace (so it passes the http(s) check), but packed with $(), backticks and ;.
    const evil = 'https://evil.test/x?a=$(touch);b=`id`;c=1';
    await webFetchSandboxed(
      { url: evil, summarize: false },
      { runInSandbox: async (c) => { cmd = c; return ok('text/plain', 'ok')(); }, networkEnabled: true },
    );
    // The whole URL must appear wrapped in a single-quoted arg → the shell treats
    // $(), `` and ; as literal text, not commands.
    expect(cmd).toContain(`'${evil}'`);
    // And it must not appear bare (outside the quotes).
    expect(cmd.replace(`'${evil}'`, '')).not.toContain('$(touch)');
  });

  it('canonicalizes a github repo URL to its raw README before fetching', async () => {
    let cmd = '';
    await webFetchSandboxed(
      { url: 'https://github.com/openai/whisper', summarize: false },
      { runInSandbox: async (c) => { cmd = c; return ok('text/plain', 'x')(); }, networkEnabled: true },
    );
    expect(cmd).toContain('raw.githubusercontent.com/openai/whisper/HEAD/README.md');
  });

  it('serves a repeat URL from the within-turn cache (one network call)', async () => {
    let calls = 0;
    const deps = {
      runInSandbox: async () => { calls++; return ok('text/plain', 'hi')(); },
      networkEnabled: true,
      fetchCache: new Map<string, string>(),
    };
    await webFetchSandboxed({ url: 'https://example.com/p', summarize: false }, deps);
    // Same page, only a #fragment added → normalizes to the same cache key.
    const second = await webFetchSandboxed({ url: 'https://example.com/p#frag', summarize: false }, deps);
    expect(calls).toBe(1);
    expect(second).toMatch(/served from cache/i);
  });
});

describe('webSearchSecure', () => {
  it('requires a query', async () => {
    expect(await webSearchSecure({}, { networkEnabled: true })).toMatch(/requires a query/i);
  });

  it('gates on network OFF before doing any work', async () => {
    expect(await webSearchSecure({ query: 'anything' }, { networkEnabled: false })).toMatch(/network.*OFF/i);
  });
});
