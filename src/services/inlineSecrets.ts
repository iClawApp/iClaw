/**
 * User messages may contain `[[iclaw:sN]]` markers (client) replaced server-side
 * with `[[iclaw:secret:id|urlEncodedLabel]]` rows in `project_secrets`. The
 * gateway receives expanded plaintext; the DB transcript and share payloads keep
 * placeholders only.
 */

import { projectSecrets } from './store';

/** Persisted in message rows — second group is encodeURIComponent(label). */
export const STORED_SECRET_PLACEHOLDER_RE = /\[\[iclaw:secret:(\d+)\|([^\]]+)\]\]/g;

export type InlineSecretWire = { slot: number; label: string; plain: string };

export function validateSecretLabel(raw: string): string {
  const s = raw.replace(/\r/g, '').trim();
  if (!s || s.length > 160) throw new Error('Назва секрету: 1–160 символів.');
  if (/[\[\]|]/.test(s)) throw new Error('Назва не може містити символи [ ] |.');
  if (/\n/.test(s)) throw new Error('Назва не може містити перенос рядка.');
  return s;
}

/**
 * Replace `[[iclaw:sN]]` with stored placeholders; insert `project_secrets` rows.
 */
export function resolveInlineSecretMarkersInContent(opts: {
  content: string;
  inlineSecrets: InlineSecretWire[] | undefined;
  projectId: number;
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
      throw new Error('Текст не містить маркерів секретів.');
    }
    return { storedContent: opts.content, newSecretIds: [] };
  }
  if (!opts.inlineSecrets || opts.inlineSecrets.length === 0) {
    throw new Error('Відсутні дані для вбудованих секретів.');
  }
  for (const slot of slotsInText) {
    if (!bySlot.has(slot)) {
      throw new Error(`Немає даних для маркера [[iclaw:s${slot}]].`);
    }
  }
  for (const [slot] of bySlot) {
    if (!slotsInText.has(slot)) {
      throw new Error(`Маркер [[iclaw:s${slot}]] відсутній у тексті.`);
    }
  }
  const orderedSlots = [...slotsInText].sort((a, b) => b - a);
  let stored = opts.content;
  const newSecretIds: number[] = [];
  for (const slot of orderedSlots) {
    const w = bySlot.get(slot)!;
    const label = validateSecretLabel(w.label);
    const plain = String(w.plain ?? '');
    if (!plain) throw new Error('Порожній секрет.');
    if (plain.length > 32768) throw new Error('Секрет занадто довгий.');
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
    const replacement = `[[iclaw:secret:${row.id}|${encLabel}]]`;
    stored = stored.split(marker).join(replacement);
  }
  return { storedContent: stored, newSecretIds };
}

/** Swap placeholders for plaintext before sending to OpenClaw (same project only). */
export function expandStoredSecretPlaceholdersForGateway(
  text: string,
  projectId: number | null,
): string {
  if (projectId == null) return text;
  return text.replace(STORED_SECRET_PLACEHOLDER_RE, (full, idStr: string) => {
    const id = Number(idStr);
    const row = projectSecrets.get(id);
    if (!row || row.project_id !== projectId) return full;
    return row.value;
  });
}

/** Strip client/server secret markers so auto-titles never echo token-shaped text. */
export function stripSecretMarkersForTitle(text: string): string {
  return String(text ?? '')
    .replace(/\[\[iclaw:s\d+\]\]/g, ' ')
    .replace(STORED_SECRET_PLACEHOLDER_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
