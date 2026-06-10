// ── social_search (sandboxed keyless social-media search) ─────────────────────
//
// A unified "give keywords → get posts" tool over FREE keyless sources (no API
// keys): Reddit (scored shreddit search + RSS breadth + subreddit drill-down +
// comment scrape — real upvote/comment counts, see social-fetch.mjs) and
// HackerNews (Algolia). Designed to grow to more sources (Lemmy, GitHub…).
//
// Like analyze_link, the actual fetch runs INSIDE the sandbox container via the
// injected `runInSandbox` callback, so all egress honours the same container
// network gate — a host-side fetch would bypass Secure Mode's boundary (the same
// reason web_search/web_fetch are excluded there). The engine is a self-contained
// Node script (social-fetch.mjs) shipped as an asset; the container already has
// `node`, so nothing self-installs.
//
// Kept OUT of TOOL_DEFINITIONS and appended by the runner (like analyze_link).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SavingsNote } from './tools.js';

export const SOCIAL_SOURCES = ['reddit', 'hackernews'] as const;
const SOCIAL_RESULT_MAX_CHARS = Number(process.env.ICLAW_SOCIAL_MAX) || 14_000;

export const SOCIAL_SEARCH_TOOL = {
  type: 'function' as const,
  function: {
    name: 'social_search',
    description:
      'Reddit & HackerNews — free, no API keys, runs in the sandbox. Reddit results carry REAL ' +
      'upvote + comment counts and are ranked by relevance × engagement × freshness. Modes: ' +
      '(1) DISCOVERY — pass `query` keywords (a plain topic works best: the tool expands the query, ' +
      'discovers the most active subreddits and drills into them); with_comments:true also pulls ' +
      'top comments for the best posts. ' +
      '(2) TARGETED — add `subreddits` to focus on specific communities (in-sub search + their top posts). ' +
      '(3) THREAD — pass a Reddit post `url` to fetch THAT post (score, body) plus its FULL, nested ' +
      'comment tree (scored, one call). Prefer this over web_fetch for any specific Reddit link.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Discovery keywords / search terms. Provide this OR `url`.' },
        url: { type: 'string', description: 'A specific Reddit post URL (…/r/<sub>/comments/<id>/…) to fetch with its full comment tree. Use instead of `query` for a known link.' },
        subreddits: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional Reddit communities to target (e.g. ["LocalLLaMA"], max 4). Use when the user names a sub or the topic clearly lives in known communities.',
        },
        sources: {
          type: 'array',
          items: { type: 'string', enum: SOCIAL_SOURCES as unknown as string[] },
          description: 'Which platforms to search in discovery mode (default: all).',
        },
        time: {
          type: 'string',
          enum: ['day', 'week', 'month', 'year', 'all'],
          description: 'Recency window (default month).',
        },
        limit: { type: 'number', description: 'Max results per source (default 25, max 50).' },
        with_comments: { type: 'boolean', description: 'Also fetch top comments for the top Reddit posts.' },
      },
      required: [],
    },
  },
} as const;

interface SocialItem {
  platform: string;
  type: string;
  title: string;
  url: string;
  hn_url?: string;
  author: string | null;
  subreddit?: string | null;
  score?: number | null;
  num_comments?: number | null;
  created: string | null;
  snippet?: string;
  relevance: number;
  selftext?: string;
  comments?: { author: string | null; score: number | null; body: string; depth?: number }[];
}
interface SocialPayload {
  query: string;
  counts: Record<string, number>;
  errors: Record<string, string>;
  results: SocialItem[];
  meta?: { queries?: string[]; subreddits?: string[] };
  error?: string;
}

/** Single-quote a string for safe embedding in a bash command. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// The fetcher is plain JS (no imports) shipped next to this module; base64 it once
// and drop it into the container's workspace cache, then run with `node`.
const FETCHER_URL = new URL('./social-fetch.mjs', import.meta.url);
let fetcherB64: string | null = null;
function getFetcherB64(): string {
  if (fetcherB64 === null) fetcherB64 = readFileSync(fileURLToPath(FETCHER_URL)).toString('base64');
  return fetcherB64;
}

function buildSocialCommand(p: {
  query: string; url: string; sources: string; limit: number; time: string; withComments: boolean; subreddits: string;
}): string {
  // Write the fetcher to $HOME — writable in BOTH sandboxes regardless of the
  // container uid. Secure runs as `node` (owns /workspace), but Work runs as the
  // HOST uid with folders at /work/<n> and NO writable /workspace, so a
  // /workspace path fails with EACCES there. $HOME is set in both (Work:
  // HOME=/tmp, Secure: /home/node), so it's the one path safe everywhere.
  const script = '"$HOME/.iclaw-social-fetch.mjs"';
  return [
    'set -e',
    `echo ${shQuote(getFetcherB64())} | base64 -d > ${script}`,
    `SOCIAL_QUERY=${shQuote(p.query)} SOCIAL_URL=${shQuote(p.url)} SOCIAL_SOURCES=${shQuote(p.sources)} ` +
      `SOCIAL_LIMIT=${shQuote(String(p.limit))} SOCIAL_TIME=${shQuote(p.time)} ` +
      `SOCIAL_WITH_COMMENTS=${shQuote(p.withComments ? '1' : '0')} ` +
      `SOCIAL_SUBREDDITS=${shQuote(p.subreddits)} ` +
      `node ${script}`,
  ].join('\n');
}

/** Render the normalized payload into compact text for the model. */
function formatPayload(d: SocialPayload): string {
  const counts = Object.entries(d.counts).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none';
  const errs = Object.entries(d.errors || {});
  const lines: string[] = [`Social search "${d.query}" — ${counts}` + (errs.length ? ` (errors: ${errs.map(([k, v]) => `${k}=${v}`).join('; ')})` : '')];
  if (d.meta?.queries?.length) lines.push(`queries tried: ${d.meta.queries.join(' | ')}`);
  if (d.meta?.subreddits?.length) lines.push(`subreddits explored: ${d.meta.subreddits.map((s) => `r/${s}`).join(', ')}`);

  for (const platform of Object.keys(d.counts)) {
    const rows = d.results.filter((r) => r.platform === platform);
    if (!rows.length) continue;
    lines.push(`\n### ${platform}`);
    rows.forEach((r, i) => {
      const tag = r.subreddit ? `[r/${r.subreddit}] ` : '';
      lines.push(`${i + 1}. ${tag}${r.title || '(untitled)'}\n   ${r.url}`);
      const meta: string[] = [];
      if (r.author) meta.push(`by ${r.author}`);
      if (r.score != null) meta.push(`${r.score} points`);
      if (r.num_comments != null) meta.push(`${r.num_comments} comments`);
      if (r.created) meta.push(r.created.slice(0, 10));
      if (meta.length) lines.push(`   ${meta.join(' · ')}`);
      if (r.selftext) lines.push(`   ${r.selftext}`);
      for (const c of r.comments || []) {
        const indent = '   ' + '  '.repeat(Math.min(c.depth ?? 0, 6));
        lines.push(`${indent}• [${c.score ?? '?'}] ${c.author ?? 'anon'}: ${c.body || '(no text)'}`);
      }
    });
  }
  return lines.join('\n');
}

/**
 * social_search implementation. `runInSandbox` runs a bash command inside the
 * session's container; `networkEnabled` mirrors the chat's network gate.
 */
export async function socialSearch(
  args: Record<string, unknown>,
  deps: { runInSandbox: (command: string) => Promise<string>; networkEnabled: boolean; onNote?: ((note: SavingsNote) => void) | undefined },
): Promise<string> {
  const query = String(args.query ?? '').trim();
  const url = String(args.url ?? '').trim();
  if (!query && !url) return 'social_search needs a `query` (keywords) or a `url` (a Reddit post link).';
  if (!deps.networkEnabled) {
    return 'social_search needs network, which is currently OFF for this chat. Ask the user to enable network, then retry.';
  }

  const requested = Array.isArray(args.sources) ? args.sources.map(String) : [...SOCIAL_SOURCES];
  const sources = requested.filter((s) => (SOCIAL_SOURCES as readonly string[]).includes(s));
  if (!url && !sources.length) return `social_search: unknown source(s). Supported: ${SOCIAL_SOURCES.join(', ')}.`;
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 25));
  const time = ['day', 'week', 'month', 'year', 'all'].includes(String(args.time)) ? String(args.time) : 'month';
  const withComments = args.with_comments === true;
  // Targeted subreddits: light shape filter here; the fetcher re-validates
  // against Reddit's naming rules and caps the count.
  const subreddits = (Array.isArray(args.subreddits) ? args.subreddits : [])
    .map((s) => String(s).trim().replace(/^\/?r\//i, ''))
    .filter((s) => /^[A-Za-z0-9_]{2,21}$/.test(s))
    .slice(0, 4)
    .join(',');

  let raw: string;
  try {
    raw = await deps.runInSandbox(buildSocialCommand({ query, url, sources: sources.join(','), limit, time, withComments, subreddits }));
  } catch (err) {
    return `social_search failed to run in the sandbox: ${err instanceof Error ? err.message : String(err)}`;
  }

  const marker = raw.lastIndexOf('__SOCIAL_JSON__');
  if (marker === -1) return `social_search: no result from the sandbox. Output: ${raw.slice(0, 400)}`;
  let payload: SocialPayload;
  try {
    payload = JSON.parse(raw.slice(marker + '__SOCIAL_JSON__'.length).trim());
  } catch {
    return `social_search: could not parse result. Output: ${raw.slice(marker, marker + 400)}`;
  }

  const total = Object.values(payload.counts || {}).reduce((a, b) => a + b, 0);
  if (!total) {
    const errs = Object.entries(payload.errors || {}).map(([k, v]) => `${k}: ${v}`).join('; ');
    return `social_search found nothing for "${url || query}".${errs ? ` Source errors — ${errs}.` : ''}${url ? ' Check the Reddit URL is a post link.' : ' Try different keywords or sources.'}`;
  }

  const text = formatPayload(payload);
  if (text.length > SOCIAL_RESULT_MAX_CHARS) {
    return text.slice(0, SOCIAL_RESULT_MAX_CHARS) + `\n\n…[truncated — narrow the query or lower limit]`;
  }
  return text;
}
