/**
 * Per-project procedural memory (the "skills" half of memory). After a chat
 * turn, a throttled background reviewer distills reusable *procedural skills*
 * from what just happened. Distilled skills do NOT activate automatically —
 * they land in a per-project inbox as suggestions (project_skill_suggestions).
 * The user accepts/edits/rejects them, exactly like project fact suggestions.
 *
 * This mirrors src/services/projectMemory.ts (the declarative "facts" half) and
 * layers Hermes's distillation discipline (class-level skills, patch-over-new)
 * plus the SKILL.md format on top, with a human-acceptance gate.
 *
 * SECURITY: the reviewer only ever emits inbox suggestions — it never writes an
 * active skill. Untrusted turns (web/email/Telegram ingestion, secure+network)
 * are flagged so the UI can warn the user. See docs/project-skills-spec.md §10.
 */

import {
  projectSkills,
  projectSkillSuggestions,
  projects,
  chats,
} from './store';
import type { ProjectSkillIndexRow } from './store';
import { runSubtaskTurn } from './subtaskLlm';
import { wsHub } from './wsHub';

/** Local copy (mirrors projectMemory.normalizeForDedup) — avoids a circular import. */
function normalizeForDedup(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Rough token budget for the prepended skills index block. */
const CHARS_PER_TOKEN_EST = 4;
const SKILLS_INDEX_TARGET_TOKENS = 600;
const MAX_INDEX_LINES = 30;
const MAX_DESC_CHARS = 200;
/** MVP shortcut (§7b): inline the full bodies of up to N small skills. */
const INLINE_BODY_COUNT = 3;
const INLINE_BODY_MAX_CHARS = 1200;
/**
 * Default review cadence (Ask/Execute). Work/Secure turns are agentic and
 * information-rich, so they pass a smaller interval (see WORK_REVIEW_INTERVAL
 * in chatRunner) and get reviewed more often.
 */
const SKILL_REVIEW_TURN_INTERVAL = 8;
const REVIEW_BUDGET_MS = 90_000;
/** Max suggestions accepted from a single review pass. */
const MAX_SUGGESTIONS_PER_REVIEW = 3;

/** Per-chat counter of substantive (tool-using) turns since the last review. */
const turnCounters = new Map<number, number>();
/** Chats with a review in flight — never run two concurrently for one chat. */
const reviewingChats = new Set<number>();

function approxTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN_EST);
}

function sleep<T = null>(ms: number, value: T | null = null): Promise<T | null> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/**
 * Build the "Skills available" block injected into the system prompt (Work /
 * Secure) or the gateway user message (Execute). Returns '' when the project
 * has no active skills. Index lines are token-bounded like facts; the bodies of
 * up to INLINE_BODY_COUNT small, most-recently-updated skills are inlined as an
 * MVP shortcut for `get_skill` (spec §7b).
 */
export function buildSkillsPromptBlock(projectId: number): string {
  if (!projects.get(projectId)) return '';
  const skills = projectSkills.listForProject(projectId);
  if (skills.length === 0) return '';

  const header = 'Skills available (procedural memory for this project):';
  let used = approxTokens(header);
  const lines: string[] = [];
  for (const s of skills) {
    if (lines.length >= MAX_INDEX_LINES) break;
    const desc =
      s.description.length > MAX_DESC_CHARS
        ? s.description.slice(0, MAX_DESC_CHARS - 1) + '…'
        : s.description;
    const line = `- ${s.name}: ${desc}`;
    const t = approxTokens(line + '\n');
    if (used + t > SKILLS_INDEX_TARGET_TOKENS && lines.length > 0) break;
    used += t;
    lines.push(line);
  }

  // Inline the bodies of a few small skills so the agent can follow them now,
  // without a round-trip. Larger skills stay index-only (request on demand).
  const inlined: string[] = [];
  let inlinedCount = 0;
  for (const s of skills) {
    if (inlinedCount >= INLINE_BODY_COUNT) break;
    if (s.body.length > INLINE_BODY_MAX_CHARS) continue;
    inlined.push(`\n--- skill: ${s.name} ---\n${s.body.trim()}`);
    inlinedCount++;
  }

  const parts = [header, ...lines];
  if (inlined.length > 0) {
    parts.push(
      '\nFull procedures for the most relevant skills follow. For any other skill above, ask the user or apply the one-line summary.',
      ...inlined,
    );
  } else if (lines.length > 0) {
    parts.push('\nApply a skill when its summary matches the task at hand.');
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Reviewer
// ---------------------------------------------------------------------------

interface ReviewedSkill {
  action: 'new' | 'patch';
  target?: string;
  name: string;
  description: string;
  tags?: string[];
  body: string;
}

/** Extract the first balanced JSON object from a possibly fenced model output. */
export function extractJsonObject(raw: string): string | null {
  const t = raw.trim();
  if (!t || /^none\.?$/i.test(t)) return null;
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return t.slice(start, i + 1);
    }
  }
  return null;
}

const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function toKebab(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/** Parse + sanitize the reviewer JSON into well-formed skill candidates. */
export function parseReviewedSkills(raw: string): ReviewedSkill[] {
  const json = extractJsonObject(raw);
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const arr = (parsed as { skills?: unknown })?.skills;
  if (!Array.isArray(arr)) return [];
  const out: ReviewedSkill[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === 'string' ? toKebab(o.name) : '';
    const description = typeof o.description === 'string' ? o.description.trim() : '';
    const body = typeof o.body === 'string' ? o.body.trim() : '';
    if (!name || !KEBAB_RE.test(name) || !description || !body) continue;
    const action = o.action === 'patch' ? 'patch' : 'new';
    const target = typeof o.target === 'string' ? toKebab(o.target) : undefined;
    const tags = Array.isArray(o.tags)
      ? o.tags.filter((t): t is string => typeof t === 'string').slice(0, 8)
      : undefined;
    out.push({ action, target, name, description, tags, body });
    if (out.length >= MAX_SUGGESTIONS_PER_REVIEW) break;
  }
  return out;
}

function buildReviewPrompt(opts: {
  transcript: string;
  existingIndex: ProjectSkillIndexRow[];
}): string {
  const existingBlock =
    opts.existingIndex.length > 0
      ? opts.existingIndex.map((s) => `- ${s.name}: ${s.description}`).join('\n')
      : '(none yet)';
  return [
    'TASK: From the conversation below, distill 0–3 reusable PROCEDURAL skills',
    'that would help an agent do similar work next time in this project.',
    '',
    'A skill captures a procedure / convention / workflow discovered this session:',
    'commands that worked, project conventions, tool quirks, gotchas, repeatable',
    'multi-step processes. It is CLASS-LEVEL and reusable — NOT a one-shot task log.',
    '',
    'Strongly PREFER patching an existing skill (action "patch", set "target" to',
    'its name) over creating a near-duplicate. Only create a "new" skill for a',
    'genuinely distinct capability. Most sessions produce zero or one skill update.',
    '',
    'Hard skip (never emit): transient task state ("user is debugging X"),',
    'secrets/tokens/credentials/.env values, SSH/IPs/hostnames, user-local',
    'filesystem paths, one-off facts (those belong to project facts, not skills).',
    '',
    'Existing skills (patch these instead of duplicating):',
    existingBlock,
    '',
    'Conversation:',
    opts.transcript.slice(0, 16000),
    '',
    'OUTPUT: strict JSON, no prose, no code fences:',
    '{"skills":[{"action":"new"|"patch","target":"<existing-name, patch only>",',
    '"name":"<kebab-case>","description":"<one line summary>","tags":["..."],',
    '"body":"<full SKILL.md markdown: frontmatter + procedure sections>"}]}',
    'If nothing qualifies, output exactly: {"skills":[]}',
    'Use the same language as the technical content.',
  ].join('\n');
}

/** Build a compact transcript of the recent turn for the reviewer. */
function buildTranscript(userMessage: string, assistantText: string): string {
  const user = userMessage.replace(/\s+/g, ' ').trim().slice(0, 6000);
  const assistant = assistantText.trim().slice(0, 12000);
  return `User:\n${user}\n\nAssistant:\n${assistant}`;
}

async function runProjectSkillReview(opts: {
  chatId: number;
  projectId: number;
  userMessage: string;
  assistantText: string;
  assistantMessageId: number;
  untrusted: boolean;
}): Promise<void> {
  const chat = chats.get(opts.chatId);
  if (!chat || chat.project_id !== opts.projectId) return;
  if (!chat.shares_to_project) return;
  if (!projects.get(opts.projectId)) return;
  if (reviewingChats.has(opts.chatId)) return;

  reviewingChats.add(opts.chatId);
  try {
    const existingIndex = projectSkills.listIndex(opts.projectId);
    const raw = await Promise.race([
      runSubtaskTurn(
        buildReviewPrompt({
          transcript: buildTranscript(opts.userMessage, opts.assistantText),
          existingIndex,
        }),
        { maxTokens: 4096 },
      ),
      sleep<string>(REVIEW_BUDGET_MS, ''),
    ]);
    if (raw == null || raw === '') return;

    const reviewed = parseReviewedSkills(raw);
    if (reviewed.length === 0) return;

    // Dedup pool: active skill names/descriptions + pending suggestion names.
    const activeNames = new Set(existingIndex.map((s) => normalizeForDedup(s.name)));
    const activeDescs = existingIndex.map((s) => normalizeForDedup(s.description));
    const pending = projectSkillSuggestions.listByProject(opts.projectId);
    const pendingNames = new Set(pending.map((s) => normalizeForDedup(s.name)));

    const inserted: {
      id: number;
      kind: 'new' | 'patch';
      name: string;
      description: string;
      untrusted: boolean;
      targetSkillId: number | null;
    }[] = [];

    for (const r of reviewed) {
      const normName = normalizeForDedup(r.name);
      const normDesc = normalizeForDedup(r.description);

      // Resolve patch target; downgrade to 'new' if the target is unknown.
      let kind: 'new' | 'patch' = r.action;
      let targetSkillId: number | null = null;
      if (kind === 'patch') {
        const targetName = r.target || r.name;
        const target =
          projectSkills.getByName(opts.projectId, targetName) ??
          projectSkills.getByName(null, targetName);
        if (target) {
          targetSkillId = target.id;
        } else {
          kind = 'new';
        }
      }

      // For 'new', skip if a same-named active/pending skill already exists, or
      // if the description duplicates an existing skill's summary.
      if (kind === 'new') {
        if (activeNames.has(normName) || pendingNames.has(normName)) continue;
        if (activeDescs.some((d) => d && (d === normDesc))) continue;
      }

      const row = projectSkillSuggestions.insert({
        projectId: opts.projectId,
        chatId: opts.chatId,
        kind,
        targetSkillId,
        name: r.name,
        description: r.description,
        body: r.body,
        tags: r.tags ?? null,
        untrusted: opts.untrusted,
        assistantMessageId: opts.assistantMessageId,
      });
      pendingNames.add(normName);
      inserted.push({
        id: row.id,
        kind: row.kind,
        name: row.name,
        description: row.description,
        untrusted: Boolean(row.untrusted),
        targetSkillId: row.target_skill_id,
      });
    }

    if (inserted.length > 0) {
      const proj = projects.get(opts.projectId);
      wsHub.broadcastAll({
        type: 'project-skill-suggestions',
        chatId: opts.chatId,
        projectId: opts.projectId,
        projectName: proj?.name?.trim() || 'project',
        suggestions: inserted,
      });
    }
  } catch (err) {
    console.error(
      '[projectSkills] review pipeline failed',
      err instanceof Error ? err.message : err,
    );
  } finally {
    reviewingChats.delete(opts.chatId);
  }
}

/**
 * Fire-and-forget skill review after a successful assistant reply. Throttled:
 * only runs once every SKILL_REVIEW_TURN_INTERVAL substantive turns per chat,
 * because skill review is heavier than fact extraction. Never blocks the turn.
 */
export function scheduleProjectSkillReview(opts: {
  chatId: number;
  projectId: number;
  sharesToProject: boolean;
  substantive: boolean;
  userMessage: string;
  assistantText: string;
  assistantMessageId: number;
  untrusted: boolean;
  /** Turns between reviews for this chat. Defaults to the Ask/Execute cadence. */
  interval?: number;
}): void {
  if (!opts.sharesToProject) return;
  if (!opts.substantive) return;

  const interval = opts.interval && opts.interval > 0 ? opts.interval : SKILL_REVIEW_TURN_INTERVAL;
  const next = (turnCounters.get(opts.chatId) ?? 0) + 1;
  if (next < interval) {
    turnCounters.set(opts.chatId, next);
    return;
  }
  turnCounters.set(opts.chatId, 0);

  void runProjectSkillReview({
    chatId: opts.chatId,
    projectId: opts.projectId,
    userMessage: opts.userMessage,
    assistantText: opts.assistantText,
    assistantMessageId: opts.assistantMessageId,
    untrusted: opts.untrusted,
  }).catch((err) => {
    console.error(
      '[projectSkills] review failed',
      err instanceof Error ? err.message : err,
    );
  });
}

/** Test/maintenance helper: reset the in-memory turn counter for a chat. */
export function resetSkillReviewCounter(chatId: number): void {
  turnCounters.delete(chatId);
}
