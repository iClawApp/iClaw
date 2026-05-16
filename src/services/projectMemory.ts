/**
 * Project-level shared context: inject facts into gateway messages, auto-extract
 * facts after each turn (when enabled), and compact when the fact table grows.
 */

import { openclawWs } from './openclawWs';
import { projectFacts, projects, chats, projectFactSuggestions } from './store';
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

function agentIdFromLabel(model: string): string {
  if (!model || model === 'openclaw' || model === 'openclaw/default') return 'main';
  return model.startsWith('openclaw/') ? model.slice('openclaw/'.length) : model;
}

function sleep<T = null>(ms: number, value: T | null = null): Promise<T | null> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
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

  const all = projectFacts.listByProject(projectId, 200);
  if (all.length === 0) return storedUserContent;

  const prefixBase =
    '[Project context — shared facts for this workspace. Treat as background; the user message follows after the separator.]\n';
  const suffix = '\n---\n[User message]\n' + storedUserContent;
  const budget = Math.max(
    200,
    CONTEXT_INJECT_TARGET_TOKENS - approxTokens(prefixBase + suffix),
  );

  let usedTokens = 0;
  const lines: string[] = [];
  for (let i = all.length - 1; i >= 0 && lines.length < MAX_FACT_LINES_INJECT; i--) {
    const raw = all[i].content.replace(/\r?\n/g, ' ').trim();
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

function normalizeForDedup(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isDuplicateFact(candidate: string, existing: string[]): boolean {
  const c = normalizeForDedup(candidate);
  if (!c || c.length < 4) return true;
  for (const ex of existing) {
    const e = normalizeForDedup(ex);
    if (c === e) return true;
    if (c.length >= 20 && e.length >= 20 && (c.includes(e) || e.includes(c))) return true;
  }
  return false;
}

function parseExtractedFactLines(raw: string): string[] {
  const t = raw.trim();
  if (!t || /^none\.?$/i.test(t) || /^no facts\.?$/i.test(t) || /^nothing\.?$/i.test(t)) {
    return [];
  }
  const lines = t
    .split(/\r?\n/)
    .map((l) =>
      l
        .trim()
        .replace(/^[-*•]+\s*/, '')
        .replace(/^\d+[.)]\s*/, '')
        .trim(),
    )
    .filter((l) => l.length > 0);
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
    'TASK: From the single conversation turn below, extract 0 to 3 short durable facts for a shared project knowledge base.',
    '',
    'Include only: decisions, constraints, tech stack, URLs/paths that matter later, named entities the user cares about.',
    'Skip: greetings, chit-chat, step-by-step how-tos unless the outcome is a stable decision.',
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

async function runThrowawayTurn(agentLabel: string, message: string): Promise<string> {
  const agentId = agentIdFromLabel(agentLabel);
  let sessionKey: string | null = null;
  try {
    const session = await openclawWs.createSession({ agentId });
    sessionKey = session.key;
    let acc = '';
    await openclawWs.runTurn({
      sessionKey: session.key,
      message,
      onEvent: (ev) => {
        if (ev.type === 'text-delta') acc += ev.text;
        else if (ev.type === 'text-final') acc = ev.text || acc;
      },
    });
    return acc;
  } finally {
    if (sessionKey) openclawWs.deleteSession(sessionKey).catch(() => {});
  }
}

export async function extractFactsFromTurn(opts: {
  agentLabel: string;
  userMessage: string;
  assistantText: string;
  existingFacts: string[];
}): Promise<string[]> {
  const raw = await Promise.race([
    runThrowawayTurn(opts.agentLabel, buildExtractPrompt(opts)),
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
      runThrowawayTurn('openclaw/default', buildCompactionPrompt(contents)),
      sleep<string>(EXTRACT_BUDGET_MS, ''),
    ]);
    if (raw == null || raw === '') return;

    const merged = raw
      .split(/\r?\n/)
      .map((l) =>
        l
          .trim()
          .replace(/^[-*•]+\s*/, '')
          .replace(/^\d+[.)]\s*/, '')
          .trim(),
      )
      .filter((l) => l.length > 0)
      .slice(0, COMPACTION_TARGET_LINES);

    if (merged.length === 0) return;
    projectFacts.replaceAll(projectId, merged);
    const facts = projectFacts.listByProject(projectId);
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
  agentLabel: string;
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
    agentLabel: opts.agentLabel,
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
      projectName: proj?.name?.trim() || 'проєкт',
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
  agentLabel: string;
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
