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
// Env in:  SOCIAL_QUERY, SOCIAL_SOURCES(csv), SOCIAL_LIMIT, SOCIAL_TIME, SOCIAL_WITH_COMMENTS,
//          SOCIAL_URL (thread mode: fetch ONE Reddit post + its full nested comment tree).
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

// The next comment's rtjson anchor — bounds a comment's body slice so a parent
// never swallows its nested replies' text (ported from last30days-skill's
// reddit_shreddit._body_for; matches both the "-comment-" and "-post-" anchors).
const NEXT_RTJSON = /id="t1_[A-Za-z0-9]+-(?:comment|post)-rtjson-content"/;

// Extract one comment's text body, anchored on its unique thingId. The body div
// id embeds the thingId, so this maps body→comment correctly even for NESTED
// replies; the window is cut at the comment's own closing tag and the next
// comment's anchor, so a parent never absorbs a child comment's text.
function bodyFor(html, thingId) {
  if (!thingId) return '';
  const anchor = `id="${thingId}-post-rtjson-content"`;
  const idx = html.indexOf(anchor);
  if (idx === -1) return '';
  let win = html.slice(idx + anchor.length, idx + anchor.length + 8000);
  const end = win.indexOf('</shreddit-comment>');
  if (end !== -1) win = win.slice(0, end);
  const nxt = win.match(NEXT_RTJSON);
  if (nxt) win = win.slice(0, nxt.index);
  const ps = [...win.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((x) => x[1]);
  return ps.length ? stripTags(ps.join(' ')) : '';
}

// Fetch a post's comment tree via the keyless shreddit endpoint. Returns
// [total, comments] in DOM (tree pre-order) across ALL depths — each comment
// carries `depth` so callers can render nesting or flatten. sort=top front-loads
// the highest-scored comments on the first page (so big threads still surface
// their best). No pagination: only the first page of the tree is returned —
// deep "load more" branches are not followed.
async function shredditComments(sub, postId) {
  const url = `https://www.reddit.com/svc/shreddit/comments/r/${sub}/t3_${postId}?sort=top`;
  let html;
  try { html = await get(url, { timeoutMs: 12000 }); } catch { return [null, []]; }
  const totalM = html.match(/total-comments="(\d+)"/);
  const total = totalM ? Number(totalM[1]) : null;
  const comments = [];
  const re = /<shreddit-comment(?=[\s>])([^>]*)>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const attr = (k) => (attrs.match(new RegExp(`\\b${k}="([^"]*)"`, 'i')) || [])[1];
    const author = attr('author') || null;
    if (author === '[deleted]' || author === '[removed]') continue;
    const body = bodyFor(html, attr('thingId'));
    if (!body) continue;
    const score = attr('score');
    comments.push({
      author,
      score: score != null && score !== '' ? Number(score) : null,
      depth: Number(attr('depth') || '0'),
      body: body.slice(0, 300),
    });
  }
  return [total, comments];
}

// Parse a Reddit thread URL into {sub, id, slug}. The slug (5th path segment) is
// the title in underscore form — a free fallback title, since the comments
// endpoint carries no post title.
function extractPostRef(url) {
  const m = (url || '').match(/\/r\/([^/]+)\/comments\/([A-Za-z0-9]+)(?:\/([^/?#]+))?/);
  return m ? { sub: m[1], id: m[2], slug: m[3] || '' } : null;
}

// Best-effort post title + selftext from old.reddit (server-rendered) — the
// shreddit comments endpoint carries neither, so a full "post + comments" grabs
// the body here. Defensive: any failure returns {} and the caller falls back to
// the slug title with no selftext. (Same server-rendered source web_fetch uses.)
async function fetchRedditPost(sub, id) {
  let html;
  try {
    html = await get(`https://old.reddit.com/r/${sub}/comments/${id}/`, { accept: 'text/html', timeoutMs: 12000 });
  } catch { return {}; }
  // Title: old.reddit renders "<post title> : <sub>" (sometimes "… : r/<sub>").
  // The post title itself may contain colons, so strip only the KNOWN sub suffix.
  let title = stripTags((html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
  const subRe = sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  title = title.replace(new RegExp(`\\s*:\\s*(?:r/)?${subRe}\\s*$`, 'i'), '').trim();
  // Selftext: the post body is the FIRST `usertext-body` that sits BETWEEN the
  // post's own `.thing` (anchored on its t3_<id>) and the comment area — NOT the
  // sidebar's description, which precedes the post in old.reddit's markup. Slicing
  // to that window also keeps the <p> scan from leaking into comments. Link/image
  // posts with no body yield ''.
  let selftext = '';
  let postIdx = html.indexOf(`thing_t3_${id}`);
  if (postIdx === -1) postIdx = html.indexOf(`t3_${id}`);
  const caIdx = html.indexOf('commentarea');
  if (postIdx !== -1) {
    const region = html.slice(postIdx, caIdx > postIdx ? caIdx : postIdx + 20000);
    const ub = region.indexOf('usertext-body');
    if (ub !== -1) {
      const win = region.slice(ub, ub + 8000);
      const ps = [...win.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((x) => x[1]);
      selftext = stripTags(ps.join(' ')).slice(0, 1500);
    }
  }
  return { title, selftext };
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
      // Discovery wants a flavour, not the tree: top 3 by score across all depths.
      const top = comments.slice().sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, 3);
      if (top.length) it.comments = top;
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
  const url = (process.env.SOCIAL_URL || '').trim();
  const sources = (process.env.SOCIAL_SOURCES || 'reddit,hackernews').split(',').map((s) => s.trim()).filter(Boolean);
  const limit = Math.max(1, Math.min(50, Number(process.env.SOCIAL_LIMIT || '25')));
  const time = process.env.SOCIAL_TIME || 'month';
  const withComments = ['1', 'true', 'yes'].includes((process.env.SOCIAL_WITH_COMMENTS || '').toLowerCase());

  // ── URL/thread mode: fetch ONE Reddit post + its full (nested) comment tree ──
  if (url) {
    const out = { query: url, counts: {}, errors: {}, results: [] };
    const ref = extractPostRef(url);
    if (!ref) {
      out.errors.reddit = 'unrecognized Reddit thread URL';
      out.counts.reddit = 0;
    } else {
      try {
        const [post, [total, comments]] = await Promise.all([
          fetchRedditPost(ref.sub, ref.id),
          shredditComments(ref.sub, ref.id),
        ]);
        const slugTitle = ref.slug ? ref.slug.replace(/[_-]+/g, ' ').trim() : '';
        out.results.push({
          platform: 'reddit', type: 'post',
          title: post.title || slugTitle || '(untitled)',
          url, author: null, subreddit: ref.sub,
          score: null, num_comments: total, created: null,
          selftext: post.selftext || '', snippet: '', relevance: 0,
          comments: comments.slice(0, 50), // first page, top-sorted; huge threads clamp
        });
        out.counts.reddit = 1;
      } catch (e) {
        out.errors.reddit = `${e.name}: ${e.message}`;
        out.counts.reddit = 0;
      }
    }
    console.log('__SOCIAL_JSON__');
    console.log(JSON.stringify(out));
    return;
  }

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
