/**
 * Agent Task Board — snapshot, plan generation, run/resume against OpenClaw.
 * Execution lives in hidden `task_execution` chats; source chats get short system notes only.
 */

import { randomUUID } from 'node:crypto';
import {
  chats,
  messages,
  projectFacts,
  projectSecrets,
  taskContextSnapshots,
  taskRuns,
  tasks,
  taskSteps,
  enrichTaskWithSteps,
} from './store';
import { openclawWs, type TurnEvent } from './openclawWs';
import { stripBulletPrefix } from './projectMemory';
import { chatStatus } from './chatStatus';
import { wsHub } from './wsHub';
import {
  expandStoredSecretPlaceholdersForGateway,
  STORED_SECRET_PLACEHOLDER_RE,
} from './inlineSecrets';
import { normalizeAgentId, isGatewayBridgeFailure, gatewayBridgeFailureUserMessage } from './chatRunner';
import type {
  MessageAttachment,
  Task,
  TaskContextSnapshotPayload,
  TaskStatus,
  TaskStep,
  TaskStepActor,
  TaskWithSteps,
} from '../types';

const PLAN_AGENT_ID = 'main';
const SNAPSHOT_MSG_BUDGET_CHARS = 12_000;
const PLAN_BUDGET_MS = 120_000;
const RUN_BUDGET_MS = 60 * 60_000;

export type TaskOutcomeKind = 'needs_human' | 'task_done' | 'needs_review' | 'none';

export interface ParsedTaskOutcome {
  kind: TaskOutcomeKind;
  instruction?: string;
}

/** Collect secret refs from message placeholders (no plaintext). */
function secretRefsFromMessages(msgs: { content: string }[]): { id: number; label: string }[] {
  const seen = new Set<number>();
  const out: { id: number; label: string }[] = [];
  for (const m of msgs) {
    const re = new RegExp(STORED_SECRET_PLACEHOLDER_RE.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(m.content)) !== null) {
      const id = Number(match[1]);
      if (!Number.isFinite(id) || seen.has(id)) continue;
      seen.add(id);
      let label = match[2];
      try {
        label = decodeURIComponent(label);
      } catch {
        /* keep raw */
      }
      out.push({ id, label });
    }
  }
  return out;
}

export function buildContextSnapshot(
  sourceChatId: number,
  extra?: { attachedFiles?: MessageAttachment[]; secretRefIds?: number[] },
): TaskContextSnapshotPayload {
  const chat = chats.get(sourceChatId);
  if (!chat) throw new Error('source chat not found');
  const allMsgs = messages.listByChat(sourceChatId);
  const projectId = chat.project_id;
  const facts =
    projectId != null
      ? projectFacts.listByProject(projectId, 200).map((f) => f.content.trim()).filter(Boolean)
      : [];

  const secretRefs = secretRefsFromMessages(allMsgs);
  if (extra?.secretRefIds?.length) {
    const seen = new Set(secretRefs.map((r) => r.id));
    for (const id of extra.secretRefIds) {
      if (seen.has(id)) continue;
      const row = projectSecrets.get(id);
      if (row) {
        secretRefs.push({ id: row.id, label: row.label });
        seen.add(id);
      }
    }
  }

  return {
    capturedAt: new Date().toISOString(),
    sourceChatId,
    projectId,
    messages: allMsgs.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      attachments: m.attachments ?? null,
      createdAt: m.created_at,
    })),
    projectFacts: facts,
    attachedFiles: extra?.attachedFiles ?? [],
    secretRefs,
  };
}

export function parsePlanLines(raw: string): { actor: TaskStepActor; title: string; description?: string }[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => stripBulletPrefix(l))
    .filter(Boolean);
  const steps: { actor: TaskStepActor; title: string; description?: string }[] = [];
  for (const line of lines) {
    const m = line.match(/^(agent|human)\s*:\s*(.+)$/i);
    if (!m) continue;
    const actor = m[1].toLowerCase() as TaskStepActor;
    const title = m[2].trim();
    if (!title) continue;
    steps.push({ actor, title });
  }
  return steps;
}

export function parseTaskOutcome(text: string): ParsedTaskOutcome {
  const t = text.trim();
  const upper = t.toUpperCase();
  for (const marker of ['NEEDS_HUMAN', 'TASK_DONE', 'NEEDS_REVIEW'] as const) {
    const idx = upper.lastIndexOf(marker);
    if (idx >= 0) {
      const after = t.slice(idx + marker.length).trim();
      const instruction =
        after.replace(/^[:\s-]+/, '').split(/\n/)[0]?.trim() || undefined;
      if (marker === 'NEEDS_HUMAN') return { kind: 'needs_human', instruction };
      if (marker === 'TASK_DONE') return { kind: 'task_done', instruction };
      return { kind: 'needs_review', instruction };
    }
  }
  return { kind: 'none' };
}

function truncateSnapshotForPrompt(payload: TaskContextSnapshotPayload): string {
  let used = 0;
  const parts: string[] = [];
  if (payload.projectFacts.length) {
    parts.push('Project facts:\n' + payload.projectFacts.map((f) => `- ${f}`).join('\n'));
    used += parts[parts.length - 1].length;
  }
  const msgLines: string[] = [];
  for (let i = payload.messages.length - 1; i >= 0; i--) {
    const m = payload.messages[i];
    const line = `[${m.role}] ${m.content.slice(0, 800)}`;
    if (used + line.length > SNAPSHOT_MSG_BUDGET_CHARS && msgLines.length > 0) break;
    msgLines.unshift(line);
    used += line.length;
  }
  if (msgLines.length) parts.push('Chat transcript:\n' + msgLines.join('\n'));
  if (payload.attachedFiles.length) {
    parts.push(
      'Attached files: ' +
        payload.attachedFiles.map((f) => f.fileName || f.url).join(', '),
    );
  }
  if (payload.secretRefs.length) {
    parts.push(
      'Secret references (resolve at runtime): ' +
        payload.secretRefs.map((s) => `${s.label} (id ${s.id})`).join(', '),
    );
  }
  return parts.join('\n\n');
}

export function buildTaskPlanPrompt(goal: string, payload: TaskContextSnapshotPayload): string {
  return [
    'TASK: Create an execution plan for the iClaw task below.',
    'Output ONLY plan lines, one per line, format:',
    'agent: Step title',
    'human: Step title',
    'Use "human:" when user approval, credentials, or a decision is required.',
    'No numbering, no preamble, no markdown.',
    'Max 12 steps.',
    '',
    `Goal: ${goal.trim()}`,
    '',
    truncateSnapshotForPrompt(payload),
  ].join('\n');
}

function buildExecutionPrompt(opts: {
  goal: string;
  payload: TaskContextSnapshotPayload;
  steps: TaskStep[];
  resumeNote?: string;
  runSummary?: string | null;
}): string {
  const stepLines = opts.steps
    .map((s, i) => `${i + 1}. [${s.actor}] ${s.title} (${s.status})`)
    .join('\n');
  const current = opts.steps.find((s) => s.status !== 'done' && s.status !== 'failed');
  const activeLine = current
    ? `Current step (execute only this gate): ${current.position + 1}. [${current.actor}] ${current.title}`
    : '';
  return [
    'You are executing an iClaw task.',
    '',
    `Goal: ${opts.goal.trim()}`,
    '',
    'Context snapshot:',
    truncateSnapshotForPrompt(opts.payload),
    '',
    'Plan steps:',
    stepLines || '(no steps — execute the goal directly)',
    '',
    ...(activeLine ? [activeLine, ''] : []),
    ...(opts.runSummary ? [`Previous run summary:\n${opts.runSummary}`, ''] : []),
    ...(opts.resumeNote ? [`Human input for resume:\n${opts.resumeNote}`, ''] : []),
    'Rules:',
    current?.actor === 'human'
      ? '- Current step is HUMAN: do not run agent work; return NEEDS_HUMAN immediately.'
      : '- Execute only the current agent step; do not skip ahead past unfinished human steps.',
    '- If a human step is required, stop and return NEEDS_HUMAN with a clear instruction on the last line.',
    '- Do not continue past human approval gates.',
    '- When finished successfully, end with TASK_DONE on its own line.',
    '- When human review is needed before closing, end with NEEDS_REVIEW on its own line.',
  ].join('\n');
}

async function runThrowawayTurn(message: string): Promise<string> {
  let sessionKey: string | null = null;
  try {
    const session = await openclawWs.createSession({ agentId: PLAN_AGENT_ID });
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

export function postSourceChatNote(sourceChatId: number, text: string): void {
  const msg = messages.append(sourceChatId, 'system', text, null);
  wsHub.broadcastToChat(sourceChatId, {
    type: 'message-appended',
    chatId: sourceChatId,
    message: msg,
  });
}

function broadcastTaskUpdated(task: Task): void {
  const enriched = enrichTaskWithSteps(task);
  wsHub.broadcastAll({ type: 'task-updated', task: enriched });
}

async function ensureExecutionSession(executionChatId: number): Promise<string> {
  const chat = chats.get(executionChatId);
  if (!chat) throw new Error('execution chat not found');
  const existing = chat.openclaw_session_id;
  if (typeof existing === 'string' && existing.startsWith('agent:')) return existing;
  const fresh = await openclawWs.createSession({
    agentId: normalizeAgentId(chat.agent),
  });
  chats.replaceSessionKey(executionChatId, fresh.key);
  return fresh.key;
}

function findHumanGateStep(taskId: number): TaskStep | undefined {
  const steps = taskSteps.listByTask(taskId);
  return (
    steps.find((s) => s.actor === 'human' && s.status === 'needs_human') ??
    steps.find((s) => s.actor === 'human' && s.status === 'todo') ??
    steps.find((s) => s.status === 'needs_human')
  );
}

export function pauseTaskForHumanStep(
  taskId: number,
  step: TaskStep,
  summary?: string | null,
): TaskWithSteps {
  const task = tasks.get(taskId);
  if (!task) throw new Error('task not found');
  const text = (summary ?? step.title).trim() || step.title;
  taskSteps.updateStatus(step.id, 'needs_human');
  tasks.patch(taskId, { status: 'needs_human', resultSummary: text });
  postSourceChatNote(task.source_chat_id, `Task needs human: ${task.title} — ${step.title}`);
  const enriched = enrichTaskWithSteps(tasks.get(taskId)!);
  broadcastTaskUpdated(enriched);
  return enriched;
}

function applyOutcomeToTask(taskId: number, outcome: ParsedTaskOutcome, assistantText: string): TaskStatus {
  const task = tasks.get(taskId)!;

  if (outcome.kind === 'needs_human') {
    const humanStep = findHumanGateStep(taskId);
    tasks.patch(taskId, {
      status: 'needs_human',
      resultSummary: outcome.instruction || assistantText.slice(0, 2000),
    });
    if (humanStep) taskSteps.updateStatus(humanStep.id, 'needs_human');
    postSourceChatNote(
      task.source_chat_id,
      `Task needs human: ${task.title}${outcome.instruction ? ` — ${outcome.instruction}` : ''}`,
    );
    return 'needs_human';
  }
  if (outcome.kind === 'task_done') {
    tasks.patch(taskId, {
      status: 'done',
      resultSummary: assistantText.slice(0, 4000) || null,
    });
    const active = taskSteps.getActiveStep(taskId);
    if (active) taskSteps.updateStatus(active.id, 'done');
    postSourceChatNote(task.source_chat_id, `Task done: ${task.title}`);
    return 'done';
  }
  if (outcome.kind === 'needs_review') {
    tasks.patch(taskId, { status: 'needs_review', resultSummary: assistantText.slice(0, 4000) });
    return 'needs_review';
  }
  tasks.patch(taskId, { status: 'needs_review', resultSummary: assistantText.slice(0, 4000) });
  return 'needs_review';
}

async function runExecutionTurn(opts: {
  taskId: number;
  executionChatId: number;
  gatewayMessage: string;
  runId: number;
}): Promise<string> {
  const sessionKey = await ensureExecutionSession(opts.executionChatId);
  const execChat = chats.get(opts.executionChatId)!;
  const stored = opts.gatewayMessage;
  const expanded = expandStoredSecretPlaceholdersForGateway(stored, execChat);

  const userMsg = messages.append(opts.executionChatId, 'user', stored, null);
  wsHub.broadcastToChat(opts.executionChatId, {
    type: 'message-appended',
    chatId: opts.executionChatId,
    message: userMsg,
  });

  wsHub.broadcastAll({
    type: 'task-run-started',
    taskId: opts.taskId,
    executionChatId: opts.executionChatId,
  });

  let assistantText = '';
  const onEvent = (ev: TurnEvent): void => {
    if (ev.type === 'text-delta') {
      assistantText += ev.text;
      wsHub.broadcastAll({
        type: 'task-run-delta',
        taskId: opts.taskId,
        executionChatId: opts.executionChatId,
        text: ev.text,
      });
    } else if (ev.type === 'text-final') {
      assistantText = ev.text || assistantText;
    }
  };

  const { text: finalFromGateway } = await openclawWs.runTurn({
    sessionKey,
    message: expanded,
    onEvent,
  });

  const finalText =
    finalFromGateway.trim().length > 0 ? finalFromGateway : assistantText;
  const assistantMsg = messages.append(opts.executionChatId, 'assistant', finalText, null);
  wsHub.broadcastToChat(opts.executionChatId, {
    type: 'message-appended',
    chatId: opts.executionChatId,
    message: assistantMsg,
  });

  taskRuns.finish(opts.runId, 'completed', finalText.slice(0, 4000));
  wsHub.broadcastAll({
    type: 'task-run-ended',
    taskId: opts.taskId,
    executionChatId: opts.executionChatId,
  });

  return finalText;
}

export async function createTask(opts: {
  sourceChatId: number;
  title: string;
  goal: string;
  agent?: string | null;
  generatePlan?: boolean;
  attachedFiles?: MessageAttachment[];
  secretRefIds?: number[];
}): Promise<TaskWithSteps> {
  const chat = chats.get(opts.sourceChatId);
  if (!chat) throw new Error('source chat not found');
  const payload = buildContextSnapshot(opts.sourceChatId, {
    attachedFiles: opts.attachedFiles,
    secretRefIds: opts.secretRefIds,
  });
  const snap = taskContextSnapshots.create({
    projectId: chat.project_id,
    sourceChatId: opts.sourceChatId,
    payload,
  });
  const agent = (opts.agent ?? chat.agent).trim() || chat.agent;
  const task = tasks.create({
    projectId: chat.project_id,
    sourceChatId: opts.sourceChatId,
    title: opts.title,
    goal: opts.goal,
    agent,
    contextSnapshotId: snap.id,
    status: 'inbox',
  });

  let steps: TaskStep[] = [];
  if (opts.generatePlan) {
    const raw = await Promise.race([
      runThrowawayTurn(buildTaskPlanPrompt(opts.goal, payload)),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), PLAN_BUDGET_MS)),
    ]);
    const parsed = parsePlanLines(raw);
    if (parsed.length) steps = taskSteps.replaceAll(task.id, parsed);
  }

  postSourceChatNote(opts.sourceChatId, `Task created: ${task.title}`);
  const enriched = enrichTaskWithSteps(task);
  enriched.steps = steps.length ? steps : taskSteps.listByTask(task.id);
  wsHub.broadcastAll({ type: 'task-created', task: enriched });
  return enriched;
}

export function approvePlan(
  taskId: number,
  steps: { actor: TaskStepActor; title: string; description?: string | null }[],
): TaskWithSteps {
  const task = tasks.get(taskId);
  if (!task) throw new Error('task not found');
  if (!steps.length) throw new Error('at least one step required');
  taskSteps.replaceAll(taskId, steps);
  const updated = tasks.patch(taskId, { status: 'ready' })!;
  const enriched = enrichTaskWithSteps(updated);
  broadcastTaskUpdated(updated);
  return enriched;
}

function getOrCreateExecutionChat(task: Task): number {
  if (task.execution_chat_id) return task.execution_chat_id;
  const execChat = chats.create(task.agent ?? 'openclaw/default', task.project_id, {
    chatKind: 'task_execution',
    title: `Task #${task.id}`,
  });
  tasks.patch(task.id, { executionChatId: execChat.id });
  return execChat.id;
}

export async function runTask(taskId: number): Promise<TaskWithSteps> {
  const task = tasks.get(taskId);
  if (!task) throw new Error('task not found');
  if (task.status !== 'ready') {
    throw new Error(`task cannot run from status ${task.status}`);
  }
  const steps = taskSteps.listByTask(taskId);
  if (!steps.length) throw new Error('approve a plan with at least one step before running');

  const active = taskSteps.getActiveStep(taskId);
  if (active?.actor === 'human') {
    return pauseTaskForHumanStep(taskId, active);
  }
  if (active?.actor === 'agent' && active.status === 'todo') {
    taskSteps.updateStatus(active.id, 'running');
  }

  const executionChatId = getOrCreateExecutionChat(task);
  tasks.patch(taskId, { status: 'running' });
  broadcastTaskUpdated(tasks.get(taskId)!);

  const snap = taskContextSnapshots.get(task.context_snapshot_id)!;
  const payload = taskContextSnapshots.parsePayload(snap);
  const run = taskRuns.create({
    taskId,
    executionChatId,
    status: 'running',
  });

  const prompt = buildExecutionPrompt({
    goal: task.goal,
    payload,
    steps,
  });

  try {
    await chatStatus.withLock(executionChatId, async () => {
      const finalText = await Promise.race([
        runExecutionTurn({
          taskId,
          executionChatId,
          gatewayMessage: prompt,
          runId: run.id,
        }),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('task run timed out')), RUN_BUDGET_MS),
        ),
      ]);
      const outcome = parseTaskOutcome(finalText);
      applyOutcomeToTask(taskId, outcome, finalText);
    });
  } catch (err) {
    const msg = isGatewayBridgeFailure(err)
      ? gatewayBridgeFailureUserMessage()
      : err instanceof Error
        ? err.message
        : String(err);
    tasks.patch(taskId, { status: 'failed', resultSummary: msg });
    taskRuns.finish(run.id, 'failed', msg);
    postSourceChatNote(task.source_chat_id, `Task failed: ${task.title}`);
    throw err;
  }

  const updated = enrichTaskWithSteps(tasks.get(taskId)!);
  broadcastTaskUpdated(updated);
  return updated;
}

export async function resumeTask(taskId: number, humanInput: string): Promise<TaskWithSteps> {
  const task = tasks.get(taskId);
  if (!task) throw new Error('task not found');
  if (task.status !== 'needs_human') throw new Error('task is not waiting for human input');

  const steps = taskSteps.listByTask(taskId);
  const waiting = steps.find((s) => s.status === 'needs_human');
  if (waiting) taskSteps.updateStatus(waiting.id, 'done');

  const next = taskSteps.getActiveStep(taskId);
  if (!next) {
    tasks.patch(taskId, { status: 'done' });
    const enriched = enrichTaskWithSteps(tasks.get(taskId)!);
    broadcastTaskUpdated(enriched);
    return enriched;
  }
  if (next.actor === 'human') {
    return pauseTaskForHumanStep(taskId, next, humanInput);
  }
  if (next.actor === 'agent' && next.status === 'todo') {
    taskSteps.updateStatus(next.id, 'running');
  }

  const executionChatId = getOrCreateExecutionChat(task);
  const snap = taskContextSnapshots.get(task.context_snapshot_id)!;
  const payload = taskContextSnapshots.parsePayload(snap);
  const lastRun = taskRuns.getLatest(taskId);

  tasks.patch(taskId, { status: 'running' });
  broadcastTaskUpdated(tasks.get(taskId)!);

  const run = taskRuns.create({
    taskId,
    executionChatId,
    status: 'running',
  });

  const prompt = buildExecutionPrompt({
    goal: task.goal,
    payload,
    steps,
    resumeNote: humanInput.trim(),
    runSummary: lastRun?.log_summary ?? task.result_summary,
  });

  try {
    await chatStatus.withLock(executionChatId, async () => {
      const finalText = await runExecutionTurn({
        taskId,
        executionChatId,
        gatewayMessage: prompt,
        runId: run.id,
      });
      const outcome = parseTaskOutcome(finalText);
      applyOutcomeToTask(taskId, outcome, finalText);
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    tasks.patch(taskId, { status: 'failed', resultSummary: msg });
    taskRuns.finish(run.id, 'failed', msg);
    throw err;
  }

  const updated = enrichTaskWithSteps(tasks.get(taskId)!);
  broadcastTaskUpdated(updated);
  return updated;
}

export function completeTask(taskId: number, status: 'done' | 'failed'): TaskWithSteps {
  const task = tasks.get(taskId);
  if (!task) throw new Error('task not found');
  const updated = tasks.patch(taskId, { status })!;
  if (status === 'done') {
    postSourceChatNote(task.source_chat_id, `Task done: ${task.title}`);
  } else {
    postSourceChatNote(task.source_chat_id, `Task failed: ${task.title}`);
  }
  const enriched = enrichTaskWithSteps(updated);
  broadcastTaskUpdated(updated);
  return enriched;
}

/** Board column mapping for Kanban UI. */
export const TASK_BOARD_COLUMNS: { key: string; statuses: TaskStatus[] }[] = [
  { key: 'inbox', statuses: ['inbox'] },
  { key: 'ready', statuses: ['ready'] },
  { key: 'running', statuses: ['running'] },
  { key: 'needs_human', statuses: ['needs_human'] },
  { key: 'review', statuses: ['needs_review'] },
  { key: 'done', statuses: ['done', 'failed'] },
];

export function groupTasksForBoard(taskList: TaskWithSteps[]): Record<string, TaskWithSteps[]> {
  const board: Record<string, TaskWithSteps[]> = {};
  for (const col of TASK_BOARD_COLUMNS) {
    board[col.key] = [];
  }
  for (const t of taskList) {
    const col = TASK_BOARD_COLUMNS.find((c) => c.statuses.includes(t.status));
    if (col) board[col.key].push(t);
    else board.inbox.push(t);
  }
  return board;
}
