import { db } from '../db/database';

export type ProjectLinkSource = {
  chatId: number;
  chatTitle: string;
  messageId: number;
  createdAt: string;
};

export type ProjectLinkEntry = {
  url: string;
  lastAt: string;
  sources: ProjectLinkSource[];
};

function trimUrlTrailingPunctuation(s: string): string {
  return s.replace(/[.,;:!?)\]'">]+$/, '');
}

/** Collect http(s) URLs from plain text and markdown `[label](url)` links. */
function extractUrlsFromMessageContent(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();

  const md = /\[[^\]]*?\]\((https?:\/\/[^)\s]+)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = md.exec(text)) !== null) {
    const u = trimUrlTrailingPunctuation(m[1]);
    if (/^https?:\/\/.+/i.test(u)) found.add(u);
  }

  const raw = /https?:\/\/[^\s\]<>"')\]]+/gi;
  while ((m = raw.exec(text)) !== null) {
    const u = trimUrlTrailingPunctuation(m[0]);
    if (/^https?:\/\/.+/i.test(u)) found.add(u);
  }

  return [...found];
}

/**
 * Unique URLs across all messages in chats of this project, newest activity first.
 * Each URL lists chat/message sources (newest message per chat wins for ordering inside URL).
 */
export function listProjectLinkEntries(projectId: number): ProjectLinkEntry[] {
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

  type Agg = {
    url: string;
    lastAt: string;
    /** key `${chatId}:${messageId}` */
    sources: Map<string, ProjectLinkSource>;
  };

  const byUrl = new Map<string, Agg>();

  for (const r of rows) {
    for (const url of extractUrlsFromMessageContent(r.content)) {
      let agg = byUrl.get(url);
      if (!agg) {
        agg = { url, lastAt: r.mcat, sources: new Map() };
        byUrl.set(url, agg);
      }
      if (r.mcat > agg.lastAt) agg.lastAt = r.mcat;
      const key = `${r.cid}:${r.mid}`;
      agg.sources.set(key, {
        chatId: r.cid,
        chatTitle: (r.ctitle || '').trim() || 'Чат',
        messageId: r.mid,
        createdAt: r.mcat,
      });
    }
  }

  const entries: ProjectLinkEntry[] = [...byUrl.values()].map((agg) => ({
    url: agg.url,
    lastAt: agg.lastAt,
    sources: [...agg.sources.values()].sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
    ),
  }));

  entries.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
  return entries;
}
