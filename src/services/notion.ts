/**
 * Notion connection helpers for Roles.
 *
 * The host server (full network) uses these to VERIFY a pasted integration token
 * before we store it — so "connect Notion = one token and it just works" is proven,
 * not hoped. The role's *container* later talks to api.notion.com under its egress
 * allowlist; the host only does this lightweight identity check.
 *
 * Tokens are secrets: we never log them, and only ever send them to api.notion.com
 * over HTTPS.
 */

const NOTION_VERSION = '2022-06-28';

export interface NotionIdentity {
  ok: boolean;
  /** The Notion workspace the token belongs to (shown back as proof it connected). */
  workspaceName?: string;
  /** The integration's own (bot) name. */
  botName?: string;
  error?: string;
}

/** Shape-check: Notion internal integration tokens are `secret_…` or `ntn_…`. */
export function looksLikeNotionToken(token: string): boolean {
  return /^(secret_[A-Za-z0-9]{20,}|ntn_[A-Za-z0-9]{20,})$/.test(token.trim());
}

/**
 * Verify a token by asking Notion who we are (`GET /v1/users/me`). Returns the
 * workspace identity on success, or a friendly, actionable error otherwise.
 */
export async function verifyNotionToken(token: string): Promise<NotionIdentity> {
  const t = token.trim();
  if (!looksLikeNotionToken(t)) {
    return {
      ok: false,
      error: 'That doesn’t look like a Notion integration token — it should start with ntn_ or secret_.',
    };
  }
  try {
    const res = await fetch('https://api.notion.com/v1/users/me', {
      headers: {
        Authorization: `Bearer ${t}`,
        'Notion-Version': NOTION_VERSION,
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 401) {
      return { ok: false, error: 'Notion rejected that token. Double-check you copied the whole thing.' };
    }
    if (!res.ok) {
      return { ok: false, error: `Notion returned ${res.status}. Give it a moment and try again.` };
    }
    const body = (await res.json()) as {
      name?: string;
      bot?: { workspace_name?: string };
    };
    const identity: NotionIdentity = { ok: true };
    if (body.bot?.workspace_name) identity.workspaceName = body.bot.workspace_name;
    if (body.name) identity.botName = body.name;
    return identity;
  } catch {
    return { ok: false, error: 'Couldn’t reach Notion. Check your connection and try again.' };
  }
}
