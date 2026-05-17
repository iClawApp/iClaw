export interface Project {
  id: number;
  name: string;
  description: string | null;
  /** Index into `PROJECT_LOGO_EMOJIS` (0–9). */
  logo_emoji: number;
  /** Background tone index (0–9), maps to `[data-logo-color]` CSS. */
  logo_color: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectFact {
  id: number;
  project_id: number;
  content: string;
  source_chat_id: number | null;
  source_message_id: number | null;
  created_at: string;
  updated_at: string;
  /** Filled by server for UI (not a DB column). */
  source_chat_title?: string;
}

/** A user message queued to fire at a specific time (Telegram-style schedule). */
export interface ScheduledMessage {
  id: number;
  chat_id: number;
  content: string;
  /** ISO-ish 'YYYY-MM-DD HH:MM:SS' UTC string from SQLite datetime(). */
  scheduled_at: string;
  created_at: string;
}

/** LLM-proposed fact awaiting user accept/reject in the chat UI. */
export interface ProjectFactSuggestion {
  id: number;
  project_id: number;
  chat_id: number;
  content: string;
  assistant_message_id: number | null;
  created_at: string;
}

export interface Chat {
  id: number;
  title: string;
  agent: string;
  openclaw_session_id: string;
  /** null = chat is "personal" / not under any project */
  project_id: number | null;
  /** 0/1 — when 1, after each reply the app proposes facts; you confirm each with Add / Skip. */
  shares_to_project: number;
  /** Optional per-chat model override applied via `sessions.patch` on OpenClaw. */
  model_override: string | null;
  /** Reasoning visibility mirror — 'off' | 'on' | 'stream'. */
  reasoning_mode: string;
  title_manual: number;
  unread: number;
  created_at: string;
  updated_at: string;
}

/** Metadata for a user-attached file (image / doc / etc) persisted to disk under /uploads. */
export interface MessageAttachment {
  /** Public URL served by express.static — e.g. `/uploads/49/<uuid>.png`. */
  url: string;
  /** MIME from the browser (or 'application/octet-stream' fallback). */
  mimeType: string;
  /** Original filename from the user's machine. */
  fileName: string;
  /** Decoded byte size, used for UI hints + size cap enforcement. */
  sizeBytes: number;
}

export interface Message {
  id: number;
  chat_id: number;
  role: 'user' | 'assistant' | 'system' | string;
  content: string;
  finish_reason: string | null;
  /** When set, this user message visually replies to an earlier row in the same chat. */
  reply_to_message_id?: number | null;
  /** Truncated excerpt (≤240 chars) shown in the reply preview bar. */
  reply_quote?: string | null;
  /** Role of the referenced message (`user` | `assistant`) for UI labels. */
  reply_to_role?: string | null;
  /** Persisted user-uploaded files (image / doc). `null` row column is parsed to undefined here. */
  attachments?: MessageAttachment[] | null;
  created_at: string;
}
