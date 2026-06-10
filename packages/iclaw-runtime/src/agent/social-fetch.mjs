#!/usr/bin/env node
// Keyless social-source fetcher. Self-contained: Node built-ins only (global
// fetch, Node 18+), NO imports — so it ships as one asset and runs as-is inside
// the sandbox container via `node` (honouring the network gate, exactly like
// analyze_link runs yt-dlp in-sandbox). Reads params from env, prints a
// normalized JSON payload between markers. Never throws: each source is isolated,
// a failure contributes [] + an error note so the others still return.
//
// Sources (all keyless / free — no API keys):
//   reddit      -> /svc/shreddit/search (scored search) + /search.rss (breadth)
//                  + /svc/shreddit/community-more-posts (scored listings)
//                  + /svc/shreddit/comments (comment trees)
//   hackernews  -> hn.algolia.com/api/v1/search
//
// Reddit pipeline (relevance/expansion logic adapted from
// mvanhorn/last30days-skill, MIT; the scored-search partial is our own find —
// it server-renders votes + comment counts + timestamps keyless, which makes
// the old "upvotes need a paid key" caveat obsolete):
//   A) local query expansion: core subject + intent variants (review/vs/issues)
//   W1) parallel: scored search per query + RSS breadth + targeted-sub fetches
//   W2) parallel: derived-subreddit drill-down (in-sub search + listing cards)
//   R)  merge by post id, score backfill, token-overlap relevance vs the
//       ORIGINAL query, composite rank (relevance × engagement × freshness,
//       entity-miss demotion), recency-window filter
//   W3) optional: comment enrichment for the top posts (relevant posts claim
//       the scarce slots first)
//
// Env in:  SOCIAL_QUERY, SOCIAL_SOURCES(csv), SOCIAL_LIMIT, SOCIAL_TIME,
//          SOCIAL_WITH_COMMENTS, SOCIAL_SUBREDDITS(csv, optional targeting),
//          SOCIAL_URL (thread mode: ONE Reddit post + full nested comment tree).
// Std out: "__SOCIAL_JSON__\n" + JSON {query, counts, errors, results[], meta?}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One retry with backoff on transient failures (network/timeout/429/5xx) —
// enough to ride out a hiccup without doubling worst-case latency. Other 4xx
// are permanent (a 403/404 won't improve on retry), so fail immediately.
async function get(url, { accept = '*/*', timeoutMs = 15000, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(1200 * attempt);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept }, signal: ctrl.signal });
      if (r.ok) return await r.text();
      lastErr = new Error(`HTTP ${r.status}`);
      if (r.status < 500 && r.status !== 429) break;
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

/** Run async task factories with bounded concurrency; failures yield null. */
async function pool(tasks, n) {
  const results = new Array(tasks.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      try { results[i] = await tasks[i](); } catch { results[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) || 1 }, worker));
  return results;
}

function decodeEntities(s) {
  return (s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => safeCodePoint(Number(n)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, ''); // zero-width chars are display noise
}
function safeCodePoint(n) {
  try { return String.fromCodePoint(n); } catch { return ''; }
}
const stripTags = (s) => decodeEntities((s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Parse a timestamp defensively (Reddit emits "+0000" / 6-digit fractions). */
function safeDate(s) {
  if (!s) return null;
  const d = new Date(String(s).trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ── Relevance scoring (ported from last30days relevance.py) ──────────────────
//
// Query-centric 0..1 score: coverage of query tokens dominates, an informative-
// token term stops generic words ("best", "review") from passing on their own,
// a precision term penalizes noisy matches, and an exact-phrase bonus rewards
// literal hits. Matches on ONLY generic tokens cap at 0.24 so the ranking's
// entity-miss demotion (×0.3) can identify and bury them.

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'for', 'how', 'is', 'in', 'of', 'on', 'and', 'with',
  'from', 'by', 'at', 'this', 'that', 'it', 'my', 'your', 'i', 'me', 'we',
  'you', 'what', 'are', 'do', 'can', 'its', 'be', 'or', 'not', 'no', 'so',
  'if', 'but', 'about', 'all', 'just', 'get', 'has', 'have', 'was', 'will',
]);

const LOW_SIGNAL = new Set([
  'advice', 'best', 'chance', 'chances', 'code', 'compare', 'comparison',
  'differences', 'explain', 'guide', 'guides', 'latest', 'news', 'odds',
  'opinion', 'opinions', 'prediction', 'predictions', 'prompt', 'prompting',
  'prompts', 'quality', 'rate', 'review', 'reviews', 'thoughts', 'tip', 'tips',
  'tutorial', 'tutorials', 'update', 'updates', 'use', 'using', 'versus',
  'vs', 'worth',
]);

const SYNONYMS = {
  js: ['javascript'], javascript: ['js'],
  ts: ['typescript'], typescript: ['ts'],
  ai: ['artificial', 'intelligence'], ml: ['machine', 'learning'],
  react: ['reactjs'], reactjs: ['react'],
  vue: ['vuejs'], vuejs: ['vue'],
};

// Unicode-aware (\p{L}\p{N}) so non-Latin queries — Cyrillic, CJK… — keep
// their tokens and get real relevance scores instead of a flat fallback.
function tokenize(text) {
  const words = (text || '').toLowerCase().replace(/[^\p{L}\p{N}_\s]/gu, ' ').split(/\s+/);
  const out = new Set();
  for (const w of words) if (w.length > 1 && !STOPWORDS.has(w)) out.add(w);
  for (const w of [...out]) {
    const syn = SYNONYMS[w];
    if (syn) for (const s of syn) out.add(s);
  }
  return out;
}
const normPhrase = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}_\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/** Precompute the query's token shape once; reused across every candidate. */
function prepQuery(query) {
  const qTokens = tokenize(query);
  const informative = new Set([...qTokens].filter((t) => !LOW_SIGNAL.has(t)));
  return {
    qTokens,
    informative: informative.size ? informative : qTokens,
    phrase: normPhrase(query),
  };
}

function relevanceTo(prep, text) {
  if (!prep.qTokens.size) return 0.5;
  const t = tokenize(text);
  let overlap = 0;
  for (const w of prep.qTokens) if (t.has(w)) overlap++;
  if (!overlap) return 0;
  let infOverlap = 0;
  for (const w of prep.informative) if (t.has(w)) infOverlap++;
  const coverage = overlap / prep.qTokens.size;
  const informative = infOverlap / prep.informative.size;
  const precision = overlap / (Math.min(t.size, prep.qTokens.size + 4) || 1);
  const base = 0.55 * coverage ** 1.35 + 0.25 * informative + 0.2 * precision;
  // Generic-token-only match: cap below the demotion threshold.
  if (!infOverlap) return Math.min(0.24, Math.round(base * 100) / 100);
  let phraseBonus = 0;
  if (prep.phrase && normPhrase(text).includes(prep.phrase)) {
    phraseBonus = prep.phrase.includes(' ') ? 0.12 : 0.16;
  }
  return Math.min(1, Math.round((base + phraseBonus) * 100) / 100);
}

/** Title-first relevance: the body can support a marginal title, not rescue it. */
function postRelevance(prep, title, selftext) {
  const ts = relevanceTo(prep, title || '');
  if (!selftext) return ts;
  const support = Math.max(ts, relevanceTo(prep, selftext));
  return Math.round((0.75 * ts + 0.25 * support) * 100) / 100;
}

// ── Query expansion (ported from last30days query.py / reddit.py) ────────────
//
// Verbose questions search poorly ("what do people think about X" ≈ noise), so
// strip meta prefixes/noise words to a core subject, then add 0–2 intent
// variants (review/vs/issues) so different discussion angles surface. All
// local — no LLM call.

const PREFIXES = [
  'what are the best', 'what is the best', 'what are the latest',
  'what are people saying about', 'what do people think about',
  'how do i use', 'how to use', 'how to',
  'what are', 'what is', 'tips for', 'best practices for',
];

const NOISE_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'and', 'or', 'of', 'in', 'on',
  'for', 'with', 'about', 'to', 'how', 'what', 'which', 'who', 'why', 'when',
  'where', 'does', 'should', 'could', 'would', 'best', 'top', 'good', 'great',
  'awesome', 'latest', 'new', 'news', 'update', 'updates', 'trending',
  'hottest', 'hot', 'popular', 'viral', 'practices', 'features', 'guide',
  'tutorial', 'recommendations', 'advice', 'review', 'reviews', 'examples',
  'comparison', 'versus', 'vs', 'prompt', 'prompts', 'prompting', 'techniques',
  'tips', 'tricks', 'methods', 'strategies', 'approaches', 'using', 'uses',
  'use', 'people', 'saying', 'think', 'said', 'lately',
]);

function coreSubject(topic) {
  let text = (topic || '').toLowerCase().trim();
  for (const p of PREFIXES) {
    if (text.startsWith(p + ' ')) { text = text.slice(p.length).trim(); break; }
  }
  const kept = text.split(/\s+/).filter((w) => !NOISE_WORDS.has(w.replace(/[?!.,]+$/, '')));
  const result = (kept.length ? kept.join(' ') : text).replace(/[?!.]+$/, '').trim();
  return result || text;
}

function inferIntent(topic) {
  const t = (topic || '').toLowerCase();
  if (/\b(vs|versus|compare|difference between)\b/.test(t)) return 'comparison';
  if (/\b(how to|tutorial|guide|setup|install|configure|troubleshoot|error|fix|debug)\b/.test(t)) return 'how_to';
  if (/\b(thoughts on|worth it|should i|opinion|review)\b/.test(t)) return 'opinion';
  if (/\b(pricing|feature|features|best .* for)\b/.test(t)) return 'product';
  return 'news';
}

function expandQueries(topic, maxN) {
  const core = coreSubject(topic);
  const queries = [core];
  const orig = (topic || '').trim().replace(/[?!.]+$/, '');
  if (orig.toLowerCase() !== core && orig.split(/\s+/).length <= 8) queries.push(orig);
  const intent = inferIntent(topic);
  if (intent === 'product') queries.push(`${core} review OR recommendation OR best`);
  else if (intent === 'comparison') queries.push(`${core} worth it OR vs OR compared`);
  else if (intent === 'opinion') queries.push(`${core} worth it OR thoughts OR review`);
  if (maxN >= 4 && ['product', 'opinion', 'how_to'].includes(intent)) {
    queries.push(`${core} issues OR problems OR bug`);
  }
  return [...new Set(queries)].slice(0, maxN);
}

// ── Reddit fetchers/parsers ───────────────────────────────────────────────────

const postIdFrom = (url) => ((url || '').match(/\/comments\/([A-Za-z0-9]+)/) || [])[1] || '';

// Scored keyless SEARCH: /svc/shreddit/search server-renders ~7 post units per
// call with REAL votes + comment counts + timestamps, ranked by Reddit's own
// search relevance. Honours sort= (relevance/top/new), t= windows, and the
// `subreddit:`/`OR` query operators. Each unit is a cluster of
// <search-telemetry-tracker> elements whose tracking-context JSON carries the
// post id + clean title; the visible counter row renders "<votes> · <comments>"
// as two <faceplate-number> elements in that order.
// `communitySink` (Map<subLower, count>, optional) collects the /r/<sub> links
// the page renders — Reddit's own community suggestions + each post's home sub.
// Free subreddit-resolution signal for the drill-down wave, no extra request.
async function searchPartial(query, time, sort, communitySink) {
  const url =
    `https://www.reddit.com/svc/shreddit/search/?q=${encodeURIComponent(query)}` +
    `&sort=${sort}&t=${time}`;
  const html = await get(url, { accept: 'text/html' });
  if (communitySink) {
    for (const m of html.matchAll(/href="\/r\/([A-Za-z0-9_]+)\/?"/g)) {
      const k = m[1].toLowerCase();
      communitySink.set(k, (communitySink.get(k) || 0) + 1);
    }
  }
  const trackers = [...html.matchAll(/<search-telemetry-tracker[^>]*data-faceplate-tracking-context="([^"]*)"/g)];
  const order = [];
  const firstPos = new Map();
  const postInfo = new Map();
  for (const m of trackers) {
    let ctx;
    try { ctx = JSON.parse(decodeEntities(m[1])); } catch { continue; }
    const id = (ctx?.post?.id || '').replace(/^t3_/, '');
    if (!id) continue;
    if (!firstPos.has(id)) {
      firstPos.set(id, m.index);
      postInfo.set(id, ctx.post);
      order.push(id);
    }
  }
  const items = [];
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    const post = postInfo.get(id);
    if (post.nsfw) continue;
    const start = firstPos.get(id);
    const end = i + 1 < order.length ? firstPos.get(order[i + 1]) : Math.min(html.length, start + 20000);
    const win = html.slice(start, end);
    const href = win.match(/href="(\/r\/([^/"]+)\/comments\/[A-Za-z0-9]+[^"]*)"/);
    if (!href) continue;
    // Counter row order is votes then comments (verified against the comments
    // endpoint's total-comments). Anchor on the row to skip unrelated numbers.
    const cIdx = win.indexOf('search-counter-row');
    const nums = [...win.slice(cIdx === -1 ? 0 : cIdx).matchAll(/<faceplate-number number="(-?\d+)"/g)]
      .map((x) => Number(x[1]));
    const ts = (win.match(/<faceplate-timeago[^>]*ts="([^"]+)"/) || [])[1];
    items.push({
      id, src: 'search',
      title: decodeEntities(post.title || ''),
      url: `https://www.reddit.com${href[1]}`,
      subreddit: href[2],
      score: nums.length >= 1 ? nums[0] : null,
      num_comments: nums.length >= 2 ? nums[1] : null,
      created: safeDate(ts),
      author: null, selftext: '',
    });
  }
  return items;
}

// RSS breadth + fallback: no engagement numbers, but 25 entries per feed with
// author + selftext snippets, and it has survived every shreddit anti-bot wave
// so far — if the search partial is ever blocked (e.g. stricter datacenter-IP
// rules), discovery degrades to this instead of to nothing.
async function searchRss(query, time, sub) {
  // With `sub`: the sub-restricted feed — 25 in-community results vs the ~7 the
  // scored partial yields, so targeted mode gets both depth and breadth.
  const url = sub
    ? `https://www.reddit.com/r/${encodeURIComponent(sub)}/search.rss?q=${encodeURIComponent(query)}&restrict_sr=on&sort=relevance&t=${time}`
    : `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=relevance&t=${time}`;
  const xml = await get(url, { accept: 'application/atom+xml' });
  const items = [];
  for (const block of xml.split('<entry>').slice(1)) {
    const entry = block.split('</entry>')[0];
    const href = (entry.match(/<link[^>]*href="([^"]+)"/) || [])[1] || '';
    const id = postIdFrom(href);
    if (!id) continue; // non-post results (subreddit/user links) carry no discussion
    const title = decodeEntities((entry.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').trim();
    const author = decodeEntities((entry.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/) || [])[1] || '')
      .replace(/^\/?u\//, '').trim();
    const created = (entry.match(/<(?:published|updated)>([\s\S]*?)<\/(?:published|updated)>/) || [])[1] || '';
    // <content> is double-escaped HTML; decode once to HTML, then strip tags.
    // Trailing "submitted by /u/x [link] [comments]" is feed boilerplate.
    const rawContent = (entry.match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || '';
    const selftext = stripTags(decodeEntities(rawContent))
      .replace(/submitted by\s+\/?u\/.*$/i, '').trim().slice(0, 500);
    items.push({
      id, src: 'rss',
      title, url: href,
      subreddit: ((href.match(/\/r\/([^/]+)\//) || [])[1]) || null,
      score: null, num_comments: null,
      created: safeDate(created),
      author: author || null, selftext,
    });
  }
  return items;
}

// Scored subreddit LISTING: /svc/shreddit/community-more-posts serves the
// sub's top/hot cards with server-rendered score + comment-count attributes
// (the technique from last30days reddit_listing.py). Used as scored discovery
// for caller-targeted subs and as a score-backfill source for derived ones.
async function listingCards(sub, sort, time) {
  let url = `https://www.reddit.com/svc/shreddit/community-more-posts/${sort}/?name=${encodeURIComponent(sub)}`;
  if (sort === 'top') url += `&t=${time}`;
  const html = await get(url, { accept: 'text/html' });
  const items = [];
  for (const m of html.matchAll(/<shreddit-post(?=[\s>])[^>]*>/g)) {
    const tag = m[0];
    const attr = (k) => {
      const x = tag.match(new RegExp(`\\b${k}="([^"]*)"`));
      return x ? decodeEntities(x[1]) : null;
    };
    const permalink = attr('permalink') || '';
    const id = postIdFrom(permalink);
    if (!id) continue;
    const author = attr('author');
    items.push({
      id, src: 'listing',
      title: attr('post-title') || '',
      url: `https://www.reddit.com${permalink}`,
      subreddit: attr('subreddit-name') || sub,
      score: Number(attr('score') || 0),
      num_comments: Number(attr('comment-count') || 0),
      created: safeDate(attr('created-timestamp')),
      author: author && author !== '[deleted]' && author !== '[removed]' ? author : null,
      selftext: '',
    });
  }
  return items;
}

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
    // AutoModerator stickies ("featured on our Discord!" etc.) are pure noise.
    if (author === '[deleted]' || author === '[removed]' || author === 'AutoModerator') continue;
    const body = bodyFor(html, attr('thingId'));
    if (!body) continue;
    // Pinned moderation-bot comments carry no structural marker in this markup
    // (identical attrs, just pinned above sort=top), so filter the ubiquitous
    // bot phrasings by body (AutoModerator itself is caught by name above).
    if (/^your post is getting popular|\bi am a bot\b/i.test(body)) continue;
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

// Low-value comment filter (ported from last30days reddit_enrich insight
// heuristics): pure agreement/reaction one-liners waste the model's budget.
function isSubstantive(c) {
  const body = (c.body || '').trim();
  if (body.length < 20) return false;
  if (/^(this|same|agreed|exactly|yep|nope|yes|no|thanks|thank you)[.!]?$/i.test(body)) return false;
  if (/^(lol|lmao|haha)/i.test(body)) return false;
  return true;
}

// Parse a Reddit thread URL into {sub, id, slug}. The slug (5th path segment) is
// the title in underscore form — a free fallback title, since the comments
// endpoint carries no post title.
function extractPostRef(url) {
  const m = (url || '').match(/\/r\/([^/]+)\/comments\/([A-Za-z0-9]+)(?:\/([^/?#]+))?/);
  return m ? { sub: m[1], id: m[2], slug: m[3] || '' } : null;
}

// Resolve non-canonical thread links — /s/ share links (mobile "share" button),
// redd.it short links, bare /comments/<id> — to {sub, id, slug}. Share links
// 302 to the canonical URL; bare /comments/<id> only redirects on old.reddit
// (www renders client-side), so that's the resolver of last resort.
async function resolveThreadRef(url) {
  const direct = extractPostRef(url);
  if (direct) return direct;
  const headers = { 'User-Agent': UA };
  const follow = async (u) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    try {
      const r = await fetch(u, { headers, redirect: 'follow', signal: ctrl.signal });
      return r.url || '';
    } catch { return ''; } finally { clearTimeout(t); }
  };
  let final = await follow(url);
  let ref = extractPostRef(final);
  if (ref) return ref;
  const id = postIdFrom(final || url) ||
    (((final || url).match(/redd\.it\/([A-Za-z0-9]+)/) || [])[1] || '');
  if (!id) return null;
  final = await follow(`https://old.reddit.com/comments/${id}/`);
  return extractPostRef(final);
}

// Best-effort post title + selftext + SCORE from old.reddit (server-rendered) —
// the shreddit comments endpoint carries none of these. The post's `.thing` div
// is the only element on a thread page with a data-score attribute, so post
// upvotes ARE recoverable keyless here. Defensive: any failure returns {} and
// the caller falls back to the slug title.
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
  let score = null;
  let postIdx = html.indexOf(`thing_t3_${id}`);
  if (postIdx === -1) postIdx = html.indexOf(`t3_${id}`);
  const caIdx = html.indexOf('commentarea');
  if (postIdx !== -1) {
    // Score: data-score lives on the post's .thing div (same tag as the id
    // anchor, attribute order varies) and on no other element of the page.
    const tagStart = html.lastIndexOf('<div', postIdx);
    const tagEnd = html.indexOf('>', postIdx);
    const tag = tagStart !== -1 && tagEnd !== -1 ? html.slice(tagStart, tagEnd + 1) : '';
    const ds = tag.match(/\bdata-score="(\d+)"/) || html.match(/\bdata-score="(\d+)"/);
    if (ds) score = Number(ds[1]);
    const region = html.slice(postIdx, caIdx > postIdx ? caIdx : postIdx + 20000);
    const ub = region.indexOf('usertext-body');
    if (ub !== -1) {
      const win = region.slice(ub, ub + 8000);
      const ps = [...win.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((x) => x[1]);
      selftext = stripTags(ps.join(' ')).slice(0, 1500);
    }
  }
  return { title, selftext, score };
}

// ── Reddit orchestration ──────────────────────────────────────────────────────

// Known utility/meta subreddits that keyword-match queries but host no topical
// discussion; penalized (not banned) during subreddit derivation.
const UTILITY_SUBS = new Set([
  'namethatsong', 'findthatsong', 'tipofmytongue', 'whatisthissong',
  'helpmefind', 'whatisthisthing', 'whatsthissong', 'findareddit',
  'subredditdrama', 'outoftheloop',
]);

/** Most promising discussion subs across discovered posts (for drill-down).
 * `seeds` (Map<subLower, count>) carries the community links the search pages
 * rendered — Reddit's own suggestion signal — as a bonus on top of frequency. */
function deriveSubs(items, core, exclude, max, seeds) {
  const coreWords = core.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const excl = new Set(exclude.map((s) => s.toLowerCase()));
  const weights = new Map();
  const bump = (sub, w) => weights.set(sub, (weights.get(sub) || 0) + w);
  for (const it of items) {
    const sub = (it.subreddit || '').trim().toLowerCase();
    if (!sub || excl.has(sub)) continue;
    let w = 1;
    if (coreWords.some((cw) => sub.includes(cw))) w += 2; // sub named after the topic
    if ((it.score ?? 0) > 100) w += 0.5; // engaged community
    if (UTILITY_SUBS.has(sub)) w *= 0.3;
    bump(sub, w);
  }
  for (const [sub, n] of seeds || []) {
    if (excl.has(sub) || UTILITY_SUBS.has(sub)) continue;
    bump(sub, Math.min(3, n)); // suggestion signal, capped so it can't dominate
  }
  return [...weights.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([s]) => s);
}

/** The query-relevant window of a long selftext (ported from last30days
 * snippet.py): sliding word windows scored by relevance, best one wins —
 * instead of blindly serving the first N chars of a long post. */
function bestWindow(prep, text, maxChars) {
  if ((text || '').length <= maxChars) return text;
  const words = text.split(/\s+/);
  const size = 80, step = 55; // 25-word overlap keeps phrases intact at seams
  let best = '', bestScore = -1;
  for (let i = 0; i < words.length; i += step) {
    const win = words.slice(i, i + size).join(' ');
    const s = relevanceTo(prep, win);
    if (s > bestScore) { bestScore = s; best = i ? '…' + win : win; }
    if (i + size >= words.length) break;
  }
  return (best || text).slice(0, maxChars);
}

/** Merge a discovered item into the per-post-id accumulator, keeping the best fields. */
function mergeInto(byId, it) {
  const prev = byId.get(it.id);
  if (!prev) { byId.set(it.id, it); return; }
  if (prev.score == null && it.score != null) prev.score = it.score;
  if ((prev.num_comments == null || prev.num_comments === 0) && it.num_comments != null) prev.num_comments = it.num_comments;
  if (!prev.created && it.created) prev.created = it.created;
  if (!prev.author && it.author) prev.author = it.author;
  if ((it.selftext || '').length > (prev.selftext || '').length) prev.selftext = it.selftext;
  if ((it.title || '').length > (prev.title || '').length) prev.title = it.title;
}

const WINDOW_MS = { day: 864e5, week: 6048e5, month: 2592e6, year: 315576e5 };

function freshness(created, now, windowMs) {
  if (!created) return 0.4; // unknown: neutral-ish, below anything recent
  const age = now - Date.parse(created);
  const norm = Number.isFinite(windowMs) ? windowMs : 365 * 864e5;
  return Math.max(0, Math.min(1, 1 - age / norm));
}

// Composite rank: relevance dominates (×120 ≫ the ~42-point ceiling of a 3k-
// upvote engagement term) so engagement breaks ties between similarly-relevant
// posts instead of letting a viral tangent outrank a direct answer; freshness
// breaks ties inside the window. Entity misses (relevance ≤ 0.24 — only
// generic query words matched) are demoted ×0.3 so high-upvote off-topic
// posts can't flood the list (the last30days "Gemma/GPU threads" lesson).
function finalScore(it, now, windowMs, targetSet) {
  let f =
    120 * (it.relevance || 0) +
    12 * Math.log10(1 + Math.max(0, it.score ?? 0)) +
    5 * Math.log10(1 + Math.max(0, it.num_comments ?? 0)) +
    8 * freshness(it.created, now, windowMs);
  if ((it.relevance || 0) <= 0.24) f *= 0.3;
  if (targetSet.has((it.subreddit || '').toLowerCase())) f += 4; // caller chose this sub
  return f;
}

// Effort knobs scale with the caller's `limit` (which already expresses how
// much material they want): more queries, more drill-down, more enrichment.
function effortFor(limit) {
  if (limit <= 10) return { queries: 2, topRun: false, derived: 2, sorts: ['top'], enrich: 3 };
  if (limit <= 25) return { queries: 3, topRun: true, derived: 3, sorts: ['top', 'hot'], enrich: 5 };
  return { queries: 4, topRun: true, derived: 4, sorts: ['top', 'hot'], enrich: 6 };
}

async function fetchReddit(query, limit, time, withComments, targetSubs) {
  const K = effortFor(limit);
  const prep = prepQuery(query);
  const core = coreSubject(query);
  const queries = expandQueries(query, K.queries);
  const targetSet = new Set(targetSubs.map((s) => s.toLowerCase()));

  // ── Wave 1: scored search fan-out + RSS breadth + caller-targeted subs ──
  const communitySeeds = new Map();
  const w1 = queries.map((q) => () => searchPartial(q, time, 'relevance', communitySeeds));
  if (K.topRun) w1.push(() => searchPartial(core, time, 'top', communitySeeds));
  w1.push(() => searchRss(queries[0], time));
  for (const sub of targetSubs) {
    w1.push(() => searchPartial(`subreddit:${sub} ${core}`, time, 'relevance'));
    w1.push(() => searchRss(core, time, sub));
    for (const sort of K.sorts) w1.push(() => listingCards(sub, sort, time));
  }
  const byId = new Map();
  for (const batch of await pool(w1, 6)) {
    for (const it of batch || []) mergeInto(byId, it);
  }

  // ── Wave 2: derived-subreddit drill-down ──
  // In-sub scored search joins discovery outright (it is query-matched). The
  // subs' listing cards are NOT reliably on-topic, so they join discovery only
  // on a strong title match — otherwise they only backfill scores onto posts
  // already discovered (the last30days rule against upvote-flooding).
  const derived = deriveSubs([...byId.values()], core, targetSubs, K.derived, communitySeeds);
  const w2 = [];
  for (const sub of derived) {
    w2.push(() => searchPartial(`subreddit:${sub} ${core}`, time, 'relevance'));
    for (const sort of K.sorts) w2.push(() => listingCards(sub, sort, time));
  }
  for (const batch of await pool(w2, 6)) {
    for (const it of batch || []) {
      if (it.src !== 'listing') { mergeInto(byId, it); continue; }
      if (byId.has(it.id) || relevanceTo(prep, it.title) >= 0.45) mergeInto(byId, it);
    }
  }

  // ── Near-dupe collapse: crossposts share a title (and usually an author)
  // but have distinct post ids, so the byId merge can't catch them. Keep the
  // copy with the higher score; absorb fields the keeper is missing. ──
  const byTitle = new Map();
  for (const it of byId.values()) {
    const key = `${normPhrase(it.title)}|${it.author || ''}`;
    const prev = byTitle.get(key);
    if (!prev) { byTitle.set(key, it); continue; }
    const [keep, drop] = (it.score ?? -1) > (prev.score ?? -1) ? [it, prev] : [prev, it];
    if (keep.score == null && drop.score != null) keep.score = drop.score;
    if (!keep.created && drop.created) keep.created = drop.created;
    if ((drop.selftext || '').length > (keep.selftext || '').length) keep.selftext = drop.selftext;
    byTitle.set(key, keep);
  }

  // ── Relevance + window filter + composite rank ──
  const now = Date.now();
  const windowMs = WINDOW_MS[time] ?? Infinity;
  let items = [...byTitle.values()];
  for (const it of items) it.relevance = postRelevance(prep, it.title, it.selftext);
  if (Number.isFinite(windowMs)) {
    // Listings' hot sort ignores t=, so clamp by the cards' own timestamps
    // (15% slack tolerates clock/window edges; unknown dates pass through).
    items = items.filter((it) => !it.created || now - Date.parse(it.created) <= windowMs * 1.15);
  }
  for (const it of items) it.rank = finalScore(it, now, windowMs, targetSet);
  items.sort((a, b) => b.rank - a.rank);
  // Per-author cap (last30days fusion rule): no single voice dominates the
  // list — serial posters keep their 3 best-ranked posts, the rest yield.
  const byAuthor = new Map();
  items = items.filter((it) => {
    if (!it.author) return true;
    const n = (byAuthor.get(it.author) || 0) + 1;
    byAuthor.set(it.author, n);
    return n <= 3;
  });
  items = items.slice(0, limit);

  // ── Wave 3: comment enrichment, relevance-prioritized slots ──
  // Scarce slots go to on-topic posts first (within each tier, rank order is
  // preserved) so a viral tangent can't starve the posts the user came for.
  if (withComments) {
    const posts = items.filter((it) => it.subreddit && it.id);
    const slots = posts.filter((it) => (it.relevance || 0) >= 0.3)
      .concat(posts.filter((it) => (it.relevance || 0) < 0.3))
      .slice(0, K.enrich);
    await pool(slots.map((it) => async () => {
      const [total, comments] = await shredditComments(it.subreddit, it.id);
      if (total != null) it.num_comments = total;
      const top = comments.filter(isSubstantive)
        .sort((a, b) => (b.score ?? -1) - (a.score ?? -1)).slice(0, 4);
      if (top.length) it.comments = top;
    }), 4);
  }

  return {
    items: items.map((it) => ({
      platform: 'reddit', type: 'post',
      title: it.title || '(untitled)', url: it.url,
      author: it.author, subreddit: it.subreddit,
      score: it.score, num_comments: it.num_comments,
      created: it.created, snippet: '',
      relevance: it.relevance,
      ...(it.selftext ? { selftext: bestWindow(prep, it.selftext, 500) } : {}),
      ...(it.comments ? { comments: it.comments } : {}),
    })),
    meta: { queries, subreddits: [...targetSubs, ...derived] },
  };
}

// ── Hacker News (Algolia) ───────────────────────────────────────────────────────
const HN_WINDOW = { day: 86400, week: 604800, month: 2592000, year: 31536000 };
async function fetchHackerNews(query, limit, time) {
  let url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=${limit}`;
  const secs = HN_WINDOW[time];
  if (secs) url += `&numericFilters=created_at_i>${Math.floor(Date.now() / 1000) - secs}`;
  const data = JSON.parse(await get(url, { accept: 'application/json' }));
  const prep = prepQuery(query);
  return (data.hits || []).slice(0, limit).map((h) => ({
    platform: 'hackernews', type: 'story', title: h.title || h.story_title || '',
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    hn_url: `https://news.ycombinator.com/item?id=${h.objectID}`,
    author: h.author ?? null, score: h.points ?? null, num_comments: h.num_comments ?? null,
    created: h.created_at ?? null, snippet: (h.story_text || '').slice(0, 240),
    relevance: relevanceTo(prep, h.title || ''),
  }));
}

const SOURCES = { reddit: fetchReddit, hackernews: fetchHackerNews };

async function main() {
  const query = (process.env.SOCIAL_QUERY || '').trim();
  const url = (process.env.SOCIAL_URL || '').trim();
  const sources = (process.env.SOCIAL_SOURCES || 'reddit,hackernews').split(',').map((s) => s.trim()).filter(Boolean);
  const limit = Math.max(1, Math.min(50, Number(process.env.SOCIAL_LIMIT || '25')));
  const time = ['day', 'week', 'month', 'year', 'all'].includes(process.env.SOCIAL_TIME || '')
    ? process.env.SOCIAL_TIME : 'month';
  const withComments = ['1', 'true', 'yes'].includes((process.env.SOCIAL_WITH_COMMENTS || '').toLowerCase());
  // Caller-targeted subreddits: validated against Reddit's name rules, capped.
  const targetSubs = (process.env.SOCIAL_SUBREDDITS || '').split(',')
    .map((s) => s.trim().replace(/^\/?r\//i, ''))
    .filter((s) => /^[A-Za-z0-9_]{2,21}$/.test(s))
    .slice(0, 4);

  // ── URL/thread mode: fetch ONE Reddit post + its full (nested) comment tree ──
  if (url) {
    const out = { query: url, counts: {}, errors: {}, results: [] };
    const ref = await resolveThreadRef(url);
    if (!ref) {
      out.errors.reddit = 'unrecognized Reddit thread URL (post links, /s/ share links and redd.it links are supported)';
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
          score: post.score ?? null, num_comments: total, created: null,
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
      const res = await fn(query, limit, time, withComments, targetSubs);
      const items = Array.isArray(res) ? res : res.items;
      if (!Array.isArray(res) && res.meta) out.meta = { ...(out.meta || {}), ...res.meta };
      out.counts[src] = items.length;
      out.results.push(...items);
    } catch (e) {
      out.errors[src] = `${e.name}: ${e.message}`; out.counts[src] = 0;
    }
  }));

  console.log('__SOCIAL_JSON__');
  console.log(JSON.stringify(out));
}
main();
