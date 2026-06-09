/**
 * Project-level shared context: inject facts into gateway messages, auto-extract
 * facts after each turn (when enabled), and compact when the fact table grows.
 */

import { projectFacts, projects, chats, projectFactSuggestions, enrichFactsWithSourceChatTitles } from './store';
import { buildSkillsPromptBlock } from './projectSkills';
import { runSubtaskTurn } from './subtaskLlm';
import { wsHub } from './wsHub';

/** Rough token budget for the prepended project block (80/20 vs full window). */
const CONTEXT_INJECT_TARGET_TOKENS = 1500;
/** ~4 chars per token — good enough for budgeting injected text. */
const CHARS_PER_TOKEN_EST = 4;
const MAX_FACT_LINES_INJECT = 30;
const FACT_COMPACTION_THRESHOLD = 30;
const COMPACTION_TARGET_LINES = 15;
const EXTRACT_BUDGET_MS = 90_000;
const MAX_FACT_LINE_CHARS = 240;

const compactingProjects = new Set<number>();

function approxTokens(s: string): number {
  return Math.ceil(s.length / CHARS_PER_TOKEN_EST);
}

function sleep<T = null>(ms: number, value: T | null = null): Promise<T | null> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/** Strip leading bullet/number markers from a parsed model output line. */
export function stripBulletPrefix(line: string): string {
  return line
    .trim()
    .replace(/^[-*•]+\s*/, '')
    .replace(/^\d+[.)]\s*/, '')
    .trim();
}

/**
 * Build the string sent to OpenClaw for this user turn. The returned value may
 * prepend project facts; the caller should still persist `storedUserContent`
 * unchanged in SQLite so the UI transcript stays clean.
 */
export function buildGatewayUserMessage(
  storedUserContent: string,
  projectId: number,
): string {
  if (!projects.get(projectId)) return storedUserContent;

  const skillsBlock = buildSkillsPromptBlock(projectId);
  const all = projectFacts.listByProject(projectId, 200);
  // Nothing to inject — neither facts nor skills.
  if (all.length === 0 && !skillsBlock) return storedUserContent;

  const skillsPrefix = skillsBlock ? skillsBlock + '\n\n' : '';
  if (all.length === 0) {
    // Skills-only injection (no facts yet).
    return `[Project context for this workspace. Treat as background only; respond in direct conversation to the user (their message is after the separator).]\n${skillsPrefix}---\n[User message]\n${storedUserContent}`;
  }

  const prefixBase =
    '[Project context — shared facts for this workspace. Treat as background only; respond in direct conversation to the user (their message is after the separator).]\n' +
    skillsPrefix;
  const suffix = '\n---\n[User message]\n' + storedUserContent;
  const budget = Math.max(
    200,
    CONTEXT_INJECT_TARGET_TOKENS - approxTokens(prefixBase + suffix),
  );

  let usedTokens = 0;
  const lines: string[] = [];
  for (let i = all.length - 1; i >= 0 && lines.length < MAX_FACT_LINES_INJECT; i--) {
    const raw = all[i]!.content.replace(/\r?\n/g, ' ').trim();
    if (!raw) continue;
    let line = `- ${raw.length > MAX_FACT_LINE_CHARS ? raw.slice(0, MAX_FACT_LINE_CHARS - 1) + '…' : raw}`;
    const t = approxTokens(line + '\n');
    if (usedTokens + t > budget && lines.length > 0) break;
    if (usedTokens + t > budget && lines.length === 0) {
      const maxChars = Math.max(40, budget * CHARS_PER_TOKEN_EST - 6);
      line = `- ${raw.slice(0, maxChars)}…`;
      lines.push(line);
      break;
    }
    usedTokens += t;
    lines.push(line);
  }
  lines.reverse();
  return `${prefixBase}${lines.join('\n')}${suffix}`;
}

export function normalizeForDedup(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function isDuplicateFact(candidate: string, existing: string[]): boolean {
  const c = normalizeForDedup(candidate);
  if (!c || c.length < 4) return true;
  for (const ex of existing) {
    const e = normalizeForDedup(ex);
    if (c === e) return true;
    if (c.length >= 20 && e.length >= 20 && (c.includes(e) || e.includes(c))) return true;
  }
  return false;
}

export function parseExtractedFactLines(raw: string): string[] {
  const t = raw.trim();
  if (!t || /^none\.?$/i.test(t) || /^no facts\.?$/i.test(t) || /^nothing\.?$/i.test(t)) {
    return [];
  }
  const lines = t.split(/\r?\n/).map(stripBulletPrefix).filter((l) => l.length > 0);
  return lines.slice(0, 3).map((l) => (l.length > MAX_FACT_LINE_CHARS ? l.slice(0, MAX_FACT_LINE_CHARS) : l));
}

function buildExtractPrompt(opts: {
  userMessage: string;
  assistantText: string;
  existingFacts: string[];
}): string {
  const existingBlock =
    opts.existingFacts.length > 0
      ? opts.existingFacts.slice(0, 40).join('\n')
      : '(none yet)';
  const user = opts.userMessage.replace(/\s+/g, ' ').trim().slice(0, 4000);
  const assistant = opts.assistantText.replace(/\s+/g, ' ').trim().slice(0, 8000);
  return [
    'TASK: Extract 0–3 durable project facts from the turn below.',
    '',
    'A fact qualifies only if all hold:',
    "  - About the project itself (architecture, decisions, conventions, domain) — not what the user is doing right now.",
    '  - Still useful in 2+ weeks, in another conversation.',
    "  - Useful to a new teammate, not just to today's task.",
    '',
    'Hard skip, even if mentioned:',
    '  SSH/IPs/hostnames, deploy commands, credentials/tokens, .env values,',
    '  user-local filesystem paths, how-to steps, transient task state',
    '  ("user is deploying / debugging X"), library versions unless pinned on purpose.',
    '',
    'Examples of BAD facts (do NOT emit anything like these):',
    '  - User deployed via ssh deploy@10.0.0.5.',
    '  - Run `npm run dev` to start the server.',
    '  - User is currently debugging a WS disconnect.',
    '',
    'Do NOT repeat or paraphrase anything already listed under "Existing facts".',
    '',
    'Existing facts:',
    existingBlock,
    '',
    'User:',
    user,
    '',
    'Assistant:',
    assistant,
    '',
    'Rules:',
    '- Output ONLY new facts, one plain-text line each (no bullets required).',
    '- If nothing qualifies, output exactly: NONE',
    '- Max 3 lines. Each line max 240 characters.',
    '- Same language as the technical content.',
  ].join('\n');
}

export async function extractFactsFromTurn(opts: {
  userMessage: string;
  assistantText: string;
  existingFacts: string[];
}): Promise<string[]> {
  const raw = await Promise.race([
    runSubtaskTurn(buildExtractPrompt(opts), { maxTokens: 512 }),
    sleep<string>(EXTRACT_BUDGET_MS, ''),
  ]);
  if (raw == null || raw === '') return [];
  return parseExtractedFactLines(raw);
}

function buildCompactionPrompt(lines: string[]): string {
  return [
    'TASK: Merge the following project facts into at most 15 concise non-redundant lines.',
    'Preserve important technical detail. Drop duplicates and near-duplicates.',
    'Output ONLY the merged facts, one per line, plain text — no numbering, no preamble.',
    '',
    ...lines.map((l) => l.trim()).filter(Boolean),
  ].join('\n');
}

export async function compactProjectFacts(projectId: number): Promise<void> {
  if (!projects.get(projectId)) return;
  if (compactingProjects.has(projectId)) return;
  if (projectFacts.countByProject(projectId) <= FACT_COMPACTION_THRESHOLD) return;

  compactingProjects.add(projectId);
  try {
    const rows = projectFacts.listByProject(projectId, 500);
    const contents = rows.map((r) => r.content.trim()).filter(Boolean);
    if (contents.length <= FACT_COMPACTION_THRESHOLD) return;

    const raw = await Promise.race([
      runSubtaskTurn(buildCompactionPrompt(contents), { maxTokens: 1024 }),
      sleep<string>(EXTRACT_BUDGET_MS, ''),
    ]);
    if (raw == null || raw === '') return;

    const merged = raw
      .split(/\r?\n/)
      .map(stripBulletPrefix)
      .filter((l) => l.length > 0)
      .slice(0, COMPACTION_TARGET_LINES);

    if (merged.length === 0) return;
    projectFacts.replaceAll(projectId, merged);
    const facts = enrichFactsWithSourceChatTitles(projectFacts.listByProject(projectId));
    wsHub.broadcastAll({ type: 'project-facts-synced', projectId, facts });
  } catch (err) {
    console.error('[projectMemory] compaction failed', err instanceof Error ? err.message : err);
  } finally {
    compactingProjects.delete(projectId);
  }
}

async function runProjectFactExtraction(opts: {
  chatId: number;
  projectId: number;
  userMessage: string;
  assistantText: string;
  assistantMessageId: number;
}): Promise<void> {
  const chat = chats.get(opts.chatId);
  if (!chat || chat.project_id !== opts.projectId) return;
  if (!chat.shares_to_project) return;
  if (!projects.get(opts.projectId)) return;

  const existingRows = projectFacts.listByProject(opts.projectId);
  const existingContents = existingRows.map((r) => r.content);

  const candidates = await extractFactsFromTurn({
    userMessage: opts.userMessage,
    assistantText: opts.assistantText,
    existingFacts: existingContents,
  });

  const pendingContents = projectFactSuggestions.listByChat(opts.chatId).map((s) => s.content);
  let pool = [...existingContents, ...pendingContents];
  const inserted: { id: number; content: string }[] = [];

  for (const line of candidates) {
    const trimmed = line.trim();
    if (!trimmed || isDuplicateFact(trimmed, pool)) continue;
    const row = projectFactSuggestions.insert({
      projectId: opts.projectId,
      chatId: opts.chatId,
      content: trimmed,
      assistantMessageId: opts.assistantMessageId,
    });
    pool.push(trimmed);
    inserted.push({ id: row.id, content: row.content });
  }

  if (inserted.length > 0) {
    const proj = projects.get(opts.projectId);
    wsHub.broadcastAll({
      type: 'project-fact-suggestions',
      chatId: opts.chatId,
      projectId: opts.projectId,
      projectName: proj?.name?.trim() || 'project',
      suggestions: inserted,
    });
  }
}

/**
 * Fire-and-forget extraction after a successful assistant reply.
 */
export function scheduleProjectFactExtraction(opts: {
  chatId: number;
  projectId: number;
  sharesToProject: boolean;
  userMessage: string;
  assistantText: string;
  assistantMessageId: number;
}): void {
  if (!opts.sharesToProject) return;
  void runProjectFactExtraction(opts).catch((err) => {
    console.error('[projectMemory] extract pipeline failed', err instanceof Error ? err.message : err);
  });
}
