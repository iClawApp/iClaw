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

/** User message waiting for the in-flight turn to finish (composer queue). */
export interface QueuedMessage {
  id: number;
  chat_id: number;
  content: string;
  reply_to_message_id: number | null;
  reply_quote: string | null;
  reply_to_role: string | null;
  attachments: MessageAttachment[] | null;
  /** Selected mode at enqueue time; preserved so the flush sends with it. */
  mode: ChatMode;
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

/**
 * Procedural memory: an accepted, active project skill stored as SKILL.md.
 * `project_id === null` means a global skill (available to every project).
 */
export interface ProjectSkill {
  id: number;
  project_id: number | null; // null = global
  name: string;
  description: string;
  body: string;
  tags: string | null; // JSON array
  source_chat_id: number | null;
  usage_count: number;
  version: number;
  created_at: string;
  updated_at: string;
  /** Filled by server for UI (not a DB column). */
  source_chat_title?: string;
}

/** LLM-proposed skill awaiting user accept/reject in the chat UI (inbox-gated). */
export interface ProjectSkillSuggestion {
  id: number;
  project_id: number;
  chat_id: number;
  kind: 'new' | 'patch';
  target_skill_id: number | null;
  name: string;
  description: string;
  body: string;
  tags: string | null;
  untrusted: number; // 0 | 1
  assistant_message_id: number | null;
  created_at: string;
}

/** API key / token; message text uses `[[iclaw:secret:id|…]]` placeholders. */
export interface ProjectSecret {
  id: number;
  /** null = chat-scoped secret (no project vault). */
  project_id: number | null;
  label: string;
  value: string;
  source_chat_id: number | null;
  source_message_id: number | null;
  created_at: string;
}

export type ChatKind = 'normal' | 'draft' | 'task_execution';

/**
 * How a user message should be handled.
 *
 *   - 'execute' — default: OpenClaw may use tools, files, shell, browser, etc.
 *     The back-compat fallback for any message whose `mode` is missing or
 *     unrecognized.
 *   - 'work' / 'secure' — run on iclaw-runtime (our runtime).
 *   - 'incognito' — read-only, ephemeral research on iclaw-runtime; never
 *     persisted (see services/chatModes.ts).
 *
 * Kept as a string union for the live modes, but the full catalog
 * (incl. planned modes like image) lives in
 * `services/chatModes.ts` so new modes can be added without touching this
 * type everywhere. Storage columns are plain TEXT, so adding a mode later
 * needs no DB migration.
 */
export type ChatMode = 'execute' | 'work' | 'secure' | 'incognito';

export type TaskStatus =
  | 'planning'
  | 'ready'
  | 'running'
  | 'needs_human'
  | 'needs_clarification'
  | 'needs_review'
  | 'done'
  | 'failed';

export type TaskStepActor = 'agent' | 'human';
export type TaskStepStatus = 'todo' | 'running' | 'needs_human' | 'done' | 'failed';

export interface TaskContextSnapshotMessage {
  id: number;
  role: string;
  content: string;
  attachments?: MessageAttachment[] | null;
  createdAt: string;
}

export interface TaskContextSnapshotPayload {
  capturedAt: string;
  sourceChatId: number;
  projectId: number | null;
  messages: TaskContextSnapshotMessage[];
  projectFacts: string[];
  attachedFiles: MessageAttachment[];
  secretRefs: { id: number; label: string }[];
}

export interface TaskContextSnapshot {
  id: number;
  project_id: number | null;
  source_chat_id: number;
  content_json: string;
  created_at: string;
}

/** Ephemeral Ask panel on a task page (deleted when the panel closes). */
export interface TaskAskSession {
  id: number;
  task_id: number;
  context_snapshot_id: number;
  openclaw_session_key: string;
  turn_count: number;
  created_at: string;
}

export interface Task {
  id: number;
  project_id: number | null;
  source_chat_id: number;
  title: string;
  goal: string;
  status: TaskStatus;
  agent: string | null;
  context_snapshot_id: number;
  execution_chat_id: number | null;
  result_summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskStep {
  id: number;
  task_id: number;
  position: number;
  actor: TaskStepActor;
  title: string;
  description: string | null;
  status: TaskStepStatus;
  /** Short line shown under the step title in the plan. */
  result_summary: string | null;
  /** Full agent/human output for this step (markdown text). */
  result_body: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskRun {
  id: number;
  task_id: number;
  execution_chat_id: number;
  /** Plan step this run belonged to, when known. */
  task_step_id: number | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  log_summary: string | null;
}

/** Task with steps and optional UI enrichments (not DB columns). */
export interface TaskWithSteps extends Task {
  steps: TaskStep[];
  source_chat_title?: string | undefined;
  current_step_title?: string | undefined;
}

export interface Chat {
  id: number;
  title: string;
  agent: string;
  openclaw_session_id: string;
  /** 'normal' chats appear in sidebar; 'task_execution' are hidden. */
  chat_kind?: ChatKind;
  /** null = chat is "personal" / not under any project */
  project_id: number | null;
  /** 0/1 — when 1, after each reply the app proposes facts; you confirm each with Add / Skip. */
  shares_to_project: number;
  /** Optional per-chat model override applied via `sessions.patch` on OpenClaw. */
  model_override: string | null;
  /** Sticky composer send-mode for this chat (e.g. 'work' | 'secure' | 'execute').
   *  null = never set → client uses the UI default. Survives navigation/devices. */
  mode: string | null;
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
  /**
   * How this message was sent. Only meaningful on `user` rows; assistant /
   * system rows default to 'execute'. Missing/legacy rows read back as
   * 'execute' (DB column default), so old chats stay fully compatible.
   */
  mode: ChatMode;
  /** Total tokens spent producing this (assistant) message. Dev-mode only; null otherwise. */
  tokens?: number | null;
  /** Of `tokens`, how many prompt tokens were served from the provider cache. Dev-mode. */
  cached_tokens?: number | null;
  created_at: string;
}
