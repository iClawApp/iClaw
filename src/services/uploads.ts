/**
 * User attachment storage.
 *
 * Browser sends each attached file as base64 inline in the WebSocket `send`
 * payload (`{mimeType, fileName, content}`). We:
 *   1) decode and persist a copy under `data/uploads/<chatId>/<uuid>.<ext>` so
 *      the user's own message can render the file after a page reload, and
 *   2) hand the original base64 straight back to the caller to forward to
 *      OpenClaw's `chat.send` — the gateway decodes it again and gives it to
 *      the model. No upload roundtrip to the gateway.
 *
 * Mirrors the dashboard's exact contract (see attachment-normalize-CdYspVKW.js
 * in the openclaw package): MIME is auto-sniffed by the gateway, the
 * `data:<mime>;base64,` prefix is optional.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, statSync, copyFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { resolveUploadsRoot as uploadsRootFromPaths } from '../paths';
import type { MessageAttachment } from '../types';

/** Per-file cap mirrors OpenClaw's default `agents.defaults.mediaMaxMb` = 20. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Total per-turn cap. The `ws` node lib default frame max is 100 MB; base64
 * inflates payload ~33% so 75 MB of raw bytes is the practical ceiling for
 * one WS message. We round down to 75 MB for safety against JSON overhead.
 */
export const MAX_TOTAL_ATTACHMENT_BYTES = 75 * 1024 * 1024;

/**
 * Hard cap on attachment count per message. OpenClaw itself imposes no count
 * limit — this is a UI sanity cap so chips don't sprawl indefinitely.
 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 25;

/** Raw shape sent over WS by the browser. */
export interface IncomingAttachment {
  mimeType?: string;
  fileName?: string;
  /** Either bare base64 or a `data:<mime>;base64,<...>` URL. */
  content?: string;
}

/** Pair returned from `persistIncomingAttachments`: one for the DB, one for OpenClaw. */
export interface ProcessedAttachment {
  /** Persisted record used for DB + UI re-render. */
  persisted: MessageAttachment;
  /** Shape expected by OpenClaw's `chat.send` (gateway strips `data:` prefix itself). */
  forGateway: {
    type: 'image' | 'file';
    mimeType: string;
    fileName: string;
    content: string;
  };
}

/**
 * Split a `data:[meta],payload` URL without running a regex over megabyte
 * payloads — greedy `.*` + `$` on huge strings has caused RangeError/stack
 * issues in some JS runtimes.
 */
function stripDataUrl(content: string): { mime?: string; base64: string } {
  const trimmed = content.trim();
  if (!trimmed.startsWith('data:')) {
    return { base64: trimmed };
  }
  const comma = trimmed.indexOf(',', 5);
  if (comma === -1) {
    return { base64: trimmed };
  }
  const meta = trimmed.slice(5, comma);
  const base64 = trimmed.slice(comma + 1);
  const semi = meta.indexOf(';');
  const mimePart = semi === -1 ? meta : meta.slice(0, semi);
  const mime = mimePart.trim() || undefined;
  return { mime, base64 };
}

/** Pick a safe lowercase extension for a MIME — empty string when unknown. */
function extForMime(mime: string): string {
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/markdown': '.md',
    'application/json': '.json',
    'application/zip': '.zip',
  };
  return map[mime.toLowerCase()] ?? '';
}

/** Strip path separators / control chars from a user-supplied filename. */
function sanitizeFileName(raw: string | undefined): string {
  if (!raw) return 'attachment';
  // Keep only the basename — defends against `../../etc/passwd` style names.
  const base = raw.replace(/[\\/\0]/g, '_').replace(/^\.+/, '');
  return base.slice(0, 200) || 'attachment';
}

function resolveUploadsRoot(): string {
  return uploadsRootFromPaths();
}

/**
 * Validate, decode, and persist each incoming attachment.
 *
 * Throws on the first violation — the WS handler converts that into a
 * `turn-error` for the user. Returns processed pairs in the same order as the
 * input.
 */
export function persistIncomingAttachments(
  chatId: number,
  incoming: IncomingAttachment[] | undefined,
): ProcessedAttachment[] {
  if (!incoming || incoming.length === 0) return [];
  if (incoming.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new Error(
      `Too many attachments (max ${MAX_ATTACHMENTS_PER_MESSAGE} per message).`,
    );
  }

  const chatDir = join(resolveUploadsRoot(), String(chatId));
  mkdirSync(chatDir, { recursive: true });

  const out: ProcessedAttachment[] = [];
  let totalBytes = 0;

  for (const [idx, att] of incoming.entries()) {
    const content = typeof att?.content === 'string' ? att.content : '';
    if (!content) throw new Error(`Attachment ${idx + 1}: empty payload.`);

    const { mime: dataUrlMime, base64 } = stripDataUrl(content);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) {
      throw new Error(`Attachment ${idx + 1}: invalid base64.`);
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch {
      throw new Error(`Attachment ${idx + 1}: base64 decode failed.`);
    }
    if (buffer.byteLength === 0) {
      throw new Error(`Attachment ${idx + 1}: decoded to 0 bytes.`);
    }
    if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `Attachment ${idx + 1}: ${buffer.byteLength} bytes exceeds ${MAX_ATTACHMENT_BYTES} byte limit.`,
      );
    }
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error(
        `Combined attachments exceed ${MAX_TOTAL_ATTACHMENT_BYTES} byte total cap.`,
      );
    }

    const mimeType =
      (typeof att.mimeType === 'string' && att.mimeType.trim()) ||
      dataUrlMime ||
      'application/octet-stream';
    const fileName = sanitizeFileName(att.fileName);

    const id = randomUUID();
    const ext = extForMime(mimeType) || (fileName.match(/\.[a-zA-Z0-9]+$/)?.[0] ?? '');
    const onDiskName = `${id}${ext}`;
    const onDiskPath = join(chatDir, onDiskName);
    writeFileSync(onDiskPath, buffer);

    const url = `/uploads/${chatId}/${onDiskName}`;
    const persisted: MessageAttachment = {
      url,
      mimeType,
      fileName,
      sizeBytes: buffer.byteLength,
    };
    const isImage = mimeType.startsWith('image/');
    out.push({
      persisted,
      forGateway: {
        type: isImage ? 'image' : 'file',
        mimeType,
        fileName,
        content: base64,
      },
    });
  }

  return out;
}

/**
 * Resolve persisted attachments to absolute on-disk paths for the iclaw-runtime
 * (Work/Secure/Incognito). The runtime shares the host filesystem, so it reads
 * the file directly — no base64 roundtrip. Rows with an unexpected URL are
 * skipped (rather than thrown) so one bad attachment can't sink the whole turn.
 */
export function runtimeAttachmentsFromPersisted(
  chatId: number,
  persisted: MessageAttachment[],
): { path: string; mimeType: string; fileName: string }[] {
  if (!persisted.length) return [];
  const chatDir = join(resolveUploadsRoot(), String(chatId));
  const prefix = `/uploads/${chatId}/`;
  const out: { path: string; mimeType: string; fileName: string }[] = [];
  for (const att of persisted) {
    const url = att.url || '';
    if (!url.startsWith(prefix)) continue;
    out.push({
      path: join(chatDir, basename(url)),
      mimeType: att.mimeType || 'application/octet-stream',
      fileName: att.fileName || 'attachment',
    });
  }
  return out;
}

/**
 * Rebuild OpenClaw gateway attachment payloads from rows already on disk
 * (queued messages persist files at enqueue time).
 */
export function gatewayAttachmentsFromPersisted(
  chatId: number,
  persisted: MessageAttachment[],
): ProcessedAttachment['forGateway'][] {
  if (!persisted.length) return [];
  const chatDir = join(resolveUploadsRoot(), String(chatId));
  const out: ProcessedAttachment['forGateway'][] = [];
  for (const [idx, att] of persisted.entries()) {
    const url = att.url || '';
    const prefix = `/uploads/${chatId}/`;
    if (!url.startsWith(prefix)) {
      throw new Error(`Attachment ${idx + 1}: unexpected url ${url}`);
    }
    const onDiskName = basename(url);
    const onDiskPath = join(chatDir, onDiskName);
    let buffer: Buffer;
    try {
      buffer = readFileSync(onDiskPath);
    } catch {
      throw new Error(`Attachment ${idx + 1}: file missing on disk.`);
    }
    if (buffer.byteLength === 0) {
      throw new Error(`Attachment ${idx + 1}: file is empty.`);
    }
    const mimeType = att.mimeType || 'application/octet-stream';
    const fileName = att.fileName || 'attachment';
    const base64 = buffer.toString('base64');
    const isImage = mimeType.startsWith('image/');
    out.push({
      type: isImage ? 'image' : 'file',
      mimeType,
      fileName,
      content: base64,
    });
  }
  return out;
}

/** Map a lowercase image extension to its MIME (the set show_image supports). */
const AGENT_IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/**
 * Persist an image the AGENT produced — already a real file on the host (a Work
 * folder is bind-mounted live; a Secure workspace dir is the host side of the
 * container mount) — into the chat's uploads dir, returning a MessageAttachment
 * for the assistant row. Returns null (caller skips it) if the path isn't a
 * readable, image-typed, size-capped regular file.
 *
 * Path TRUST is the caller's job: only pass a host path already confirmed to lie
 * inside an allowed root. This copies (never moves) so the original is untouched.
 */
export function persistAgentImage(chatId: number, hostPath: string): MessageAttachment | null {
  let st;
  try { st = statSync(hostPath); } catch { return null; }
  if (!st.isFile() || st.size === 0 || st.size > MAX_ATTACHMENT_BYTES) return null;

  const ext = (basename(hostPath).match(/\.[a-zA-Z0-9]+$/)?.[0] ?? '').toLowerCase();
  const mimeType = AGENT_IMAGE_MIME[ext];
  if (!mimeType) return null; // not a supported image type

  const chatDir = join(resolveUploadsRoot(), String(chatId));
  mkdirSync(chatDir, { recursive: true });
  const onDiskName = `${randomUUID()}${ext}`;
  try {
    copyFileSync(hostPath, join(chatDir, onDiskName));
  } catch {
    return null;
  }
  return {
    url: `/uploads/${chatId}/${onDiskName}`,
    mimeType,
    fileName: sanitizeFileName(basename(hostPath)),
    sizeBytes: st.size,
  };
}
