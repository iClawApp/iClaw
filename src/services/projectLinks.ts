import { db } from '../db/database';

export type ProjectLinkSource = {
  chatId: number;
  chatTitle: string;
  messageId: number;
  createdAt: string;
};

export type ProjectLinkKind = 'http' | 'file' | 'path';

export type ProjectLinkEntry = {
  /** Display string: URL, file URI, or filesystem path as it appeared in chat. */
  url: string;
  kind: ProjectLinkKind;
  lastAt: string;
  sources: ProjectLinkSource[];
};

const MAX_LINK_LEN = 2048;

function trimUrlTrailingPunctuation(s: string): string {
  return s.replace(/[.,;:!?)\]'">]+$/, '');
}

function normalizeCandidate(s: string): string | null {
  const t = trimUrlTrailingPunctuation(s.trim());
  if (!t || t.length < 2 || t.length > MAX_LINK_LEN) return null;
  return t;
}

function classifyLink(url: string): ProjectLinkKind {
  if (/^https?:\/\//i.test(url)) return 'http';
  if (/^file:/i.test(url)) return 'file';
  return 'path';
}

/** Strip http(s) spans so path regexes do not match inside URLs. */
function maskHttpLikeUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s\]<>"')\]]+/gi, (m) => ' '.repeat(m.length));
}

/**
 * Heuristic: filesystem-ish path or file URI (not http(s), not arbitrary scheme://).
 */
function looksLikeFilesystemPath(s: string): boolean {
  if (s.length < 2 || s.length > MAX_LINK_LEN) return false;
  if (/[\r\n\u0000<>|]/.test(s)) return false;
  if (/^file:/i.test(s)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return false;

  if (/^[a-zA-Z]:\\/.test(s)) return true;
  if (/^\\\\[^\s\\]+\\/.test(s)) return true;
  if (/^\/(?:[\w@.+\-]+\/)+[\w@.+\-]+$/.test(s)) return true;
  if (/^\.\/(?:[\w@.+\-]+\/)*[\w@.+\-]+$/.test(s)) return true;
  if (/^(?:\.\.\/)+(?:[\w@.+\-]+\/)*[\w@.+\-]+$/.test(s)) return true;
  if (/^[a-zA-Z0-9@._+\-]+(?:\/[a-zA-Z0-9@._+\-]+)+\.[a-zA-Z0-9]{1,12}$/.test(s)) return true;
  return false;
}

/** Collect http(s), file://, and path-like strings from plain text + markdown links + backticks. */
function extractLinkStringsFromMessageContent(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();

  const md = /\[[^\]]*?\]\(([^)\s]+)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = md.exec(text)) !== null) {
    const raw = normalizeCandidate(m[1]);
    if (!raw) continue;
    if (/^https?:\/\//i.test(raw)) found.add(raw);
    else if (/^file:/i.test(raw) || looksLikeFilesystemPath(raw)) found.add(raw);
  }

  const rawHttp = /https?:\/\/[^\s\]<>"')\]]+/gi;
  while ((m = rawHttp.exec(text)) !== null) {
    const u = normalizeCandidate(m[0]);
    if (u && /^https?:\/\//i.test(u)) found.add(u);
  }

  const fileUri = /file:\/\/[^\s\]<>"')\]]+/gi;
  while ((m = fileUri.exec(text)) !== null) {
    const u = normalizeCandidate(m[0]);
    if (u) found.add(u);
  }

  const bt = /`([^`\n]+)`/g;
  while ((m = bt.exec(text)) !== null) {
    const inner = normalizeCandidate(m[1]);
    if (!inner || /^https?:\/\//i.test(inner)) continue;
    if (/^file:/i.test(inner) || looksLikeFilesystemPath(inner)) found.add(inner);
  }

  const masked = maskHttpLikeUrls(text);

  const unixAbs = /(?:^|[\s([{'"`])(\/(?:[\w@.+\-]+\/)+[\w@.+\-]+)/g;
  while ((m = unixAbs.exec(masked)) !== null) {
    const u = normalizeCandidate(m[1]);
    if (u && looksLikeFilesystemPath(u)) found.add(u);
  }

  const win = /(?:^|[\s([{'"`])([a-zA-Z]:(?:\\[^\\/:*?"<>\s|]+)+)/g;
  while ((m = win.exec(masked)) !== null) {
    const u = normalizeCandidate(m[1]);
    if (u && looksLikeFilesystemPath(u)) found.add(u);
  }

  const unc = /(?:^|[\s([{'"`])(\\\\[^\s'")\]]+)/g;
  while ((m = unc.exec(masked)) !== null) {
    const u = normalizeCandidate(m[1]);
    if (u && /^\\\\/.test(u) && looksLikeFilesystemPath(u)) found.add(u);
  }

  const rel = /(?:^|[\s([{'"`])((?:\.{1,2}\/|)(?:[\w@.+\-]+\/)+[\w@.+\-]+\.[\w]{1,12})\b/g;
  while ((m = rel.exec(masked)) !== null) {
    const u = normalizeCandidate(m[1]);
    if (u && looksLikeFilesystemPath(u)) found.add(u);
  }

  return [...found];
}

export type ProjectLinkGroups = {
  /** http(s) only — for the «Links» tab. */
  web: ProjectLinkEntry[];
  /** file:// and filesystem paths — for the Files tab. */
  files: ProjectLinkEntry[];
};

type LinkAgg = {
  url: string;
  kind: ProjectLinkKind;
  lastAt: string;
  /** One row per chat — same URL repeated in one chat collapses to the newest message. */
  sources: Map<number, ProjectLinkSource>;
};

function finalizeAggMap(byKey: Map<string, LinkAgg>): ProjectLinkEntry[] {
  const entries: ProjectLinkEntry[] = [...byKey.values()].map((agg) => ({
    url: agg.url,
    kind: agg.kind,
    lastAt: agg.lastAt,
    sources: [...agg.sources.values()].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    ),
  }));
  entries.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
  return entries;
}

/**
 * Web URLs vs file/path strings from all project chats (one parse pass per message).
 */
export function listProjectLinkGroups(projectId: number): ProjectLinkGroups {
  const rows = db
    .prepare(
      `SELECT m.id AS mid, m.created_at AS mcat, m.content AS content, c.id AS cid, c.title AS ctitle
       FROM messages m
       INNER JOIN chats c ON c.id = m.chat_id
       WHERE c.project_id = ?
       ORDER BY m.id DESC`,
    )
    .all(projectId) as {
      mid: number;
      mcat: string;
      content: string;
      cid: number;
      ctitle: string;
    }[];

  const byWeb = new Map<string, LinkAgg>();
  const byFile = new Map<string, LinkAgg>();

  for (const r of rows) {
    for (const url of extractLinkStringsFromMessageContent(r.content)) {
      const kind = classifyLink(url);
      const map = kind === 'http' ? byWeb : byFile;
      let agg = map.get(url);
      if (!agg) {
        agg = { url, kind, lastAt: r.mcat, sources: new Map() };
        map.set(url, agg);
      }
      if (r.mcat > agg.lastAt) agg.lastAt = r.mcat;
      const prev = agg.sources.get(r.cid);
      const next: ProjectLinkSource = {
        chatId: r.cid,
        chatTitle: (r.ctitle || '').trim() || 'Chat',
        messageId: r.mid,
        createdAt: r.mcat,
      };
      if (
        !prev ||
        r.mcat > prev.createdAt ||
        (r.mcat === prev.createdAt && r.mid > prev.messageId)
      ) {
        agg.sources.set(r.cid, next);
      }
    }
  }

  return {
    web: finalizeAggMap(byWeb),
    files: finalizeAggMap(byFile),
  };
}
