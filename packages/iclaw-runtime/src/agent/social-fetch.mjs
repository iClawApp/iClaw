#!/usr/bin/env node
// Keyless social-source fetcher. Self-contained: Node built-ins only (global
// fetch, Node 18+), NO imports — so it ships as one asset and runs as-is inside
// the sandbox container via `node` (honouring the network gate, exactly like
// analyze_link runs yt-dlp in-sandbox). Reads params from env, prints a
// normalized JSON payload between markers. Never throws: each source is isolated,
// a failure contributes [] + an error note so the others still return.
//
// Sources (all keyless / free — no API keys):
//   reddit      -> /search.rss?q=   (+ optional shreddit /svc comment enrichment)
//   hackernews  -> hn.algolia.com/api/v1/search
//
// Reddit technique (RSS discovery + shreddit comment scrape) is adapted from
// mvanhorn/last30days-skill (MIT) — the .json API is dead (403), these endpoints
// are the keyless state of the art. Post upvote score is NOT recoverable keyless.
//
// Env in:  SOCIAL_QUERY, SOCIAL_SOURCES(csv), SOCIAL_LIMIT, SOCIAL_TIME, SOCIAL_WITH_COMMENTS
// Std out: "__SOCIAL_JSON__\n" + JSON {query, counts, errors, results[]}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function get(url, { accept = '*/*', timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

function decodeEntities(s) {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#32;/g, ' ')
    .replace(/&nbsp;/g, ' ');
}
const stripTags = (s) => decodeEntities((s || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
const tokens = (s) => new Set((s || '').toLowerCase().match(/[a-z0-9]+/g) || []);
function relevance(query, title) {
  const q = tokens(query);
  if (q.size === 0) return 0;
  const t = tokens(title);
  let n = 0;
  for (const w of q) if (t.has(w)) n++;
  return Math.round((n / q.size) * 1000) / 1000;
}

// ── Reddit ────────────────────────────────────────────────────────────────────
async function shredditComments(sub, postId, max = 3) {
  const url = `https://www.reddit.com/svc/shreddit/comments/r/${sub}/t3_${postId}`;
  let html;
  try { html = await get(url, { timeoutMs: 12000 }); } catch { return [null, []]; }
  const totalM = html.match(/total-comments="(\d+)"/);
  const total = totalM ? Number(totalM[1]) : null;
  const comments = [];
  const re = /<shreddit-comment(?=[\s>])([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const attr = (k) => (attrs.match(new RegExp(`${k}="([^"]*)"`, 'i')) || [])[1];
    if (Number(attr('depth') || '0') !== 0) continue; // top-level only
    const thingId = attr('thingId');
    let body = '';
    if (thingId) {
      const bIdx = html.indexOf(`id="${thingId}-post-rtjson-content"`);
      if (bIdx !== -1) {
        const seg = html.slice(bIdx, bIdx + 2500);
        const ps = [...seg.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((x) => x[1]);
        body = stripTags(ps.join(' ')).slice(0, 280);
      }
    }
    const score = attr('score');
    comments.push({ author: attr('author') || null, score: score != null ? Number(score) : null, body });
  }
  comments.sort((x, y) => (y.score ?? -1) - (x.score ?? -1));
  return [total, comments.slice(0, max)];
}

async function fetchReddit(query, limit, time, withComments) {
  const url = `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=relevance&t=${time}`;
  const xml = await get(url, { accept: 'application/atom+xml' });
  const items = [];
  for (const block of xml.split('<entry>').slice(1)) {
    const entry = block.split('</entry>')[0];
    const title = decodeEntities((entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').trim();
    const href = (entry.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
    const author = decodeEntities((entry.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/) || [])[1] || '').trim();
    const created = (entry.match(/<(?:published|updated)>([\s\S]*?)<\/(?:published|updated)>/) || [])[1] || '';
    const subM = href.match(/\/r\/([^/]+)\//);
    const isPost = href.includes('/comments/');
    items.push({
      platform: 'reddit', type: isPost ? 'post' : 'subreddit', title, url: href,
      author: author || null, subreddit: subM ? subM[1] : null, created: created || null,
      score: null, snippet: '', relevance: relevance(query, title),
    });
  }
  const posts = items.filter((i) => i.type === 'post').sort((a, b) => b.relevance - a.relevance);
  const ranked = posts.concat(items.filter((i) => i.type !== 'post')).slice(0, limit);

  if (withComments) {
    const targets = ranked.filter((i) => i.type === 'post' && i.subreddit).slice(0, 3);
    await Promise.all(targets.map(async (it) => {
      const pid = (it.url.match(/\/comments\/([A-Za-z0-9]+)/) || [])[1];
      if (!pid) return;
      const [total, comments] = await shredditComments(it.subreddit, pid);
      it.num_comments = total;
      if (comments.length) it.comments = comments;
    }));
  }
  return ranked;
}

// ── Hacker News (Algolia) ───────────────────────────────────────────────────────
const HN_WINDOW = { day: 86400, week: 604800, month: 2592000, year: 31536000 };
async function fetchHackerNews(query, limit, time) {
  let url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${limit}`;
  const secs = HN_WINDOW[time];
  if (secs) url += `&numericFilters=created_at_i>${Math.floor(Date.now() / 1000) - secs}`;
  const data = JSON.parse(await get(url, { accept: 'application/json' }));
  return (data.hits || []).slice(0, limit).map((h) => ({
    platform: 'hackernews', type: 'story', title: h.title || h.story_title || '',
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    hn_url: `https://news.ycombinator.com/item?id=${h.objectID}`,
    author: h.author ?? null, score: h.points ?? null, num_comments: h.num_comments ?? null,
    created: h.created_at ?? null, snippet: (h.story_text || '').slice(0, 240),
    relevance: relevance(query, h.title || ''),
  }));
}

const SOURCES = { reddit: fetchReddit, hackernews: fetchHackerNews };

async function main() {
  const query = (process.env.SOCIAL_QUERY || '').trim();
  const sources = (process.env.SOCIAL_SOURCES || 'reddit,hackernews').split(',').map((s) => s.trim()).filter(Boolean);
  const limit = Math.max(1, Math.min(50, Number(process.env.SOCIAL_LIMIT || '25')));
  const time = process.env.SOCIAL_TIME || 'month';
  const withComments = ['1', 'true', 'yes'].includes((process.env.SOCIAL_WITH_COMMENTS || '').toLowerCase());

  const out = { query, counts: {}, errors: {}, results: [] };
  if (!query) { console.log('__SOCIAL_JSON__'); console.log(JSON.stringify({ ...out, error: 'empty query' })); return; }

  await Promise.all(sources.map(async (src) => {
    const fn = SOURCES[src];
    if (!fn) { out.errors[src] = 'unknown source'; out.counts[src] = 0; return; }
    try {
      const res = await fn(query, limit, time, withComments);
      out.counts[src] = res.length; out.results.push(...res);
    } catch (e) {
      out.errors[src] = `${e.name}: ${e.message}`; out.counts[src] = 0;
    }
  }));

  console.log('__SOCIAL_JSON__');
  console.log(JSON.stringify(out));
}
main();
