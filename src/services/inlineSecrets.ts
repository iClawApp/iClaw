/**
 * User messages may contain `[[iclaw:sN]]` markers (client) replaced server-side
 * with `[[iclaw:secret:id|urlEncodedLabel|valueLength]]` rows in `project_secrets`. The
 * gateway receives expanded plaintext; the DB transcript and share payloads keep
 * placeholders only.
 */

import { projectSecrets, secretUsableInChat } from './store';

/** Persisted in message rows — label is encodeURIComponent(label); length is optional (legacy). */
export const STORED_SECRET_PLACEHOLDER_RE =
  /\[\[iclaw:secret:(\d+)\|([^|\]]+)(?:\|(\d+))?\]\]/g;

export type InlineSecretWire = { slot: number; label: string; plain: string };

export function validateSecretLabel(raw: string): string {
  const s = raw.replace(/\r/g, '').trim();
  if (!s || s.length > 160) throw new Error('Secret name: 1–160 characters.');
  if (/[\[\]|]/.test(s)) throw new Error('Name cannot contain [ ] |.');
  if (/\n/.test(s)) throw new Error('Name cannot contain a line break.');
  return s;
}

/**
 * Replace `[[iclaw:sN]]` with stored placeholders; insert `project_secrets` rows.
 */
export function resolveInlineSecretMarkersInContent(opts: {
  content: string;
  inlineSecrets: InlineSecretWire[] | undefined;
  projectId: number | null;
  sourceChatId: number;
}): { storedContent: string; newSecretIds: number[] } {
  const bySlot = new Map<number, InlineSecretWire>();
  if (opts.inlineSecrets) {
    for (const s of opts.inlineSecrets) {
      const slot = Number(s.slot);
      if (!Number.isFinite(slot) || slot < 0 || slot > 99) {
        throw new Error('Invalid secret slot.');
      }
      if (bySlot.has(slot)) throw new Error('Duplicate secret slot.');
      bySlot.set(slot, s);
    }
  }
  const slotMatches = [...opts.content.matchAll(/\[\[iclaw:s(\d+)\]\]/g)];
  const slotsInText = new Set(slotMatches.map((m) => Number(m[1])));
  if (slotsInText.size === 0) {
    if (opts.inlineSecrets?.length) {
      throw new Error('Message has no secret markers.');
    }
    return { storedContent: opts.content, newSecretIds: [] };
  }
  if (!opts.inlineSecrets || opts.inlineSecrets.length === 0) {
    throw new Error('Missing data for inline secrets.');
  }
  for (const slot of slotsInText) {
    if (!bySlot.has(slot)) {
      throw new Error(`No data for marker [[iclaw:s${slot}]].`);
    }
  }
  for (const [slot] of bySlot) {
    if (!slotsInText.has(slot)) {
      throw new Error(`Marker [[iclaw:s${slot}]] is missing from the message.`);
    }
  }
  const orderedSlots = [...slotsInText].sort((a, b) => b - a);
  let stored = opts.content;
  const newSecretIds: number[] = [];
  for (const slot of orderedSlots) {
    const w = bySlot.get(slot)!;
    const label = validateSecretLabel(w.label);
    if (!projectSecrets.isLabelAvailable(label)) {
      throw new Error('Secret name already exists');
    }
    const plain = String(w.plain ?? '')
      .replace(/\r/g, '')
      .trim();
    if (!plain) throw new Error('Empty secret.');
    if (plain.length > 32768) throw new Error('Secret is too long.');
    const row = projectSecrets.insert({
      projectId: opts.projectId,
      label,
      value: plain,
      sourceChatId: opts.sourceChatId,
      sourceMessageId: null,
    });
    newSecretIds.push(row.id);
    const encLabel = encodeURIComponent(label);
    const marker = `[[iclaw:s${slot}]]`;
    const replacement = `[[iclaw:secret:${row.id}|${encLabel}|${row.value.length}]]`;
    stored = stored.split(marker).join(replacement);
  }
  return { storedContent: stored, newSecretIds };
}

/** Swap placeholders for plaintext before sending to OpenClaw. */
export function expandStoredSecretPlaceholdersForGateway(
  text: string,
  chat: { id: number; project_id: number | null },
): string {
  return text.replace(STORED_SECRET_PLACEHOLDER_RE, (full, idStr: string) => {
    const id = Number(idStr);
    const row = projectSecrets.get(id);
    if (!row || !secretUsableInChat(row, chat)) return full;
    return row.value;
  });
}

/**
 * Replace any occurrence of a chat-usable secret VALUE with `[secret:label]`.
 * For text that the MODEL produced or echoed (tool args, tool outputs): once a
 * secret is expanded for a turn, the model may type it into a command, and
 * without this scrub the plaintext would be persisted (tool traces) or pushed
 * to the UI (live status line) — undoing the placeholder system. Values shorter
 * than 6 chars are skipped (too collision-prone); longest values are replaced
 * first so one secret embedded in another can't leave a partial leak.
 */
export function redactSecretValuesForChat(
  text: string,
  chat: { id: number; project_id: number | null },
): string {
  if (!text) return text;
  const rows = projectSecrets
    .listUsableInChat(chat)
    .filter((r) => r.value.length >= 6)
    .sort((a, b) => b.value.length - a.value.length);
  let out = text;
  for (const r of rows) {
    if (out.includes(r.value)) {
      out = out.split(r.value).join(`[secret:${r.label}]`);
    }
    // Truncated occurrences: any clip between the secret's source and this
    // scrub (the 70-char detail cap, the 140-char outcome cap, the runtime's
    // own output clamps) can cut the value mid-token, and then an exact match
    // misses it — exactly how a 40-char GitHub PAT leaked as its first 36
    // chars. Catch any leading fragment of ≥16 chars and extend the match as
    // far as the text still follows the secret.
    out = redactPrefixFragments(out, r.value, r.label);
  }
  return out;
}

const SECRET_PREFIX_MIN = 16;

function redactPrefixFragments(text: string, value: string, label: string): string {
  if (value.length < SECRET_PREFIX_MIN) return text;
  const probe = value.slice(0, SECRET_PREFIX_MIN);
  let out = text;
  let i = out.indexOf(probe);
  while (i !== -1) {
    let len = SECRET_PREFIX_MIN;
    while (len < value.length && i + len < out.length && out[i + len] === value[len]) len++;
    out = out.slice(0, i) + `[secret:${label}]` + out.slice(i + len);
    i = out.indexOf(probe, i + 1);
  }
  return out;
}

// A KEY name whose decisive suffix marks the value as sensitive (case-insensitive,
// matched as a whole `_`-delimited word). Deliberately NOT broad words like API /
// ACCESS / SESSION / URL — those produce false positives (KIE_API_BASE, BASE_URL);
// the real secrets still end in KEY/TOKEN/SECRET/etc. (ACCESS_KEY, API_TOKEN…).
const SECRET_KEY_HINT =
  /(?:^|_)(?:KEY|TOKEN|SECRET|PASS|PASSWORD|PWD|APIKEY|CRED|CREDS|CREDENTIAL|CREDENTIALS|PRIVATE|BEARER|SIGNING|WEBHOOK|DSN|PAT)(?:_|$)/i;

/** A VALUE that looks like a credential: long, mixed letters+digits, token charset. */
function looksTokenish(v: string): boolean {
  const s = v.replace(/^['"]|['"]$/g, '');
  return s.length >= 16 && /[A-Za-z]/.test(s) && /[0-9]/.test(s) && /^[A-Za-z0-9_\-.\/+:=~]+$/.test(s);
}

/** A connection string with embedded credentials: scheme://user:password@host. */
function hasEmbeddedCredentials(v: string): boolean {
  return /^[A-Za-z][\w+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/.test(v.replace(/^['"]|['"]$/g, ''));
}

/**
 * Mask the VALUE in `KEY=VALUE` lines that look like secrets — the shape you get
 * from `cat .env` / `printenv`. INDEPENDENT of the vault: a never-registered key
 * (a fresh `.env` the agent just read) is caught before it lands in chat history
 * or the live UI, which `redactSecretValuesForChat` (vault-scoped) can't do.
 * Conservative — only fires on a secret-ish KEY or a token-shaped VALUE, so plain
 * config like `NODE_ENV=production` or `PORT=3000` survives untouched.
 */
export function redactEnvAssignments(text: string): string {
  if (!text) return text;
  return text.replace(
    /^([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)([ \t]*=[ \t]*)(['"]?)([^\n'"#]+?)\4([ \t]*(?:#[^\n]*)?)$/gm,
    (full: string, pre: string, key: string, eq: string, quote: string, val: string, post: string) => {
      const v = val.trim();
      if (!v) return full;
      if (SECRET_KEY_HINT.test(key) || looksTokenish(v) || hasEmbeddedCredentials(v)) {
        return `${pre}${key}${eq}${quote}[redacted]${quote}${post}`;
      }
      return full;
    },
  );
}

/** Strip client/server secret markers so auto-titles never echo token-shaped text. */
export function stripSecretMarkersForTitle(text: string): string {
  return String(text ?? '')
    .replace(/\[\[iclaw:s\d+\]\]/g, ' ')
    .replace(STORED_SECRET_PLACEHOLDER_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactWhitespaceText(text: string): { compact: string; indices: number[] } {
  const indices: number[] = [];
  let compact = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10 || c === 13) continue;
    indices.push(i);
    compact += text[i];
  }
  return { compact, indices };
}

function rangeFromCompactIndices(
  indices: number[],
  compactStart: number,
  compactEnd: number,
): { start: number; end: number } | null {
  if (!indices.length || compactStart >= indices.length) return null;
  const endIdx = Math.min(compactEnd, indices.length) - 1;
  return { start: indices[compactStart]!, end: indices[endIdx]! + 1 };
}

function selectionOverlapsSecretPlaceholder(
  content: string,
  start: number,
  end: number,
): boolean {
  STORED_SECRET_PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STORED_SECRET_PLACEHOLDER_RE.exec(content)) !== null) {
    const pStart = m.index;
    const pEnd = m.index + m[0].length;
    if (start < pEnd && end > pStart) return true;
  }
  return false;
}

function validateSelectionSpan(
  content: string,
  start: number,
  end: number,
): { start: number; end: number } | null {
  if (start < 0 || end <= start || end > content.length) return null;
  if (selectionOverlapsSecretPlaceholder(content, start, end)) return null;
  return { start, end };
}

/**
 * Map browser-selected plain text back to a span in the stored message body
 * (markdown + placeholders). Tries exact match, NBSP normalization, then
 * newline-insensitive compact search.
 */
export function findSelectionSpanInMessageContent(
  content: string,
  selection: string,
): { start: number; end: number } | null {
  const sel = String(selection ?? '').replace(/\r/g, '');
  const trimmed = sel.trim();
  if (!trimmed || /\[\[iclaw:/.test(trimmed)) return null;

  let hit = content.indexOf(sel);
  if (hit !== -1) {
    const span = validateSelectionSpan(content, hit, hit + sel.length);
    if (span) return span;
  }

  hit = content.indexOf(trimmed);
  if (hit !== -1) {
    const span = validateSelectionSpan(content, hit, hit + trimmed.length);
    if (span) return span;
  }

  const normContent = content.replace(/\u00a0/g, ' ');
  const normSel = trimmed.replace(/\u00a0/g, ' ');
  const normIdx = normContent.indexOf(normSel);
  if (normIdx !== -1) {
    const span = validateSelectionSpan(content, normIdx, normIdx + normSel.length);
    if (span) return span;
  }

  const cc = compactWhitespaceText(normContent);
  const cs = compactWhitespaceText(normSel);
  const cIdx = cc.compact.indexOf(cs.compact);
  if (cIdx !== -1) {
    const range = rangeFromCompactIndices(cc.indices, cIdx, cIdx + cs.compact.length);
    if (range) return validateSelectionSpan(content, range.start, range.end);
  }

  return null;
}

/** Replace a user-selected span with a stored secret placeholder. */
export function redactSelectionInMessageContent(opts: {
  content: string;
  selection: string;
  label: string;
  projectId: number | null;
  sourceChatId: number;
  sourceMessageId: number;
}): { content: string; secretId: number } {
  const span = findSelectionSpanInMessageContent(opts.content, opts.selection);
  if (!span) {
    throw new Error('Could not locate the selected text in this message.');
  }
  const label = validateSecretLabel(opts.label);
  if (!projectSecrets.isLabelAvailable(label)) {
    throw new Error('Secret name already exists');
  }
  const plain = opts.content.slice(span.start, span.end);
  if (!plain.trim()) throw new Error('Empty secret.');
  if (plain.length > 32768) throw new Error('Secret is too long.');
  const row = projectSecrets.insert({
    projectId: opts.projectId,
    label,
    value: plain,
    sourceChatId: opts.sourceChatId,
    sourceMessageId: opts.sourceMessageId,
  });
  const encLabel = encodeURIComponent(label);
  const replacement = `[[iclaw:secret:${row.id}|${encLabel}|${row.value.length}]]`;
  const newContent =
    opts.content.slice(0, span.start) + replacement + opts.content.slice(span.end);
  return { content: newContent, secretId: row.id };
}
