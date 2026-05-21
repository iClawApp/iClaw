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
import { deriveTitle, suggestChatTitleWithTimeout } from './chatTitle';
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

const activeTaskLoops = new Set<number>();

export type TaskOutcomeKind =
  | 'needs_human'
  | 'ask_user'
  | 'add_human_step'
  | 'task_done'
  | 'needs_review'
  | 'none';

export interface ParsedTaskOutcome {
  kind: TaskOutcomeKind;
  /** NEEDS_HUMAN hint, or ADD_HUMAN_STEP plan row title. */
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

const TASK_OUTCOME_MARKERS = [
  'ADD_HUMAN_STEP',
  'ASK_USER',
  'NEEDS_HUMAN',
  'TASK_DONE',
  'NEEDS_REVIEW',
] as const;

/** Strip protocol lines agents append for the runner (not for humans). */
export function stripTaskOutcomeMarkers(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (/^\s*ADD_HUMAN_STEP\b/i.test(t)) return false;
      return !/^\s*(ASK_USER|NEEDS_HUMAN|TASK_DONE|NEEDS_REVIEW)\s*:?\s*$/i.test(t);
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const ASK_SPLIT_MARKERS = ['ASK_USER', 'NEEDS_HUMAN'] as const;

/**
 * Split agent output into context (before ASK_USER / NEEDS_HUMAN) and the question (after).
 * Used on the task detail "response needed" panel.
 */
export function formatAgentHumanAsk(text: string | null | undefined): {
  preamble: string;
  question: string;
} {
  const raw = String(text ?? '').trim();
  if (!raw) return { preamble: '', question: '' };

  const upper = raw.toUpperCase();
  let bestIdx = -1;
  let bestMarker = '';
  for (const marker of ASK_SPLIT_MARKERS) {
    const idx = upper.lastIndexOf(marker);
    if (idx >= 0 && idx >= bestIdx) {
      bestIdx = idx;
      bestMarker = marker;
    }
  }
  if (bestIdx >= 0 && bestMarker) {
    const before = stripTaskOutcomeMarkers(raw.slice(0, bestIdx));
    const after = stripTaskOutcomeMarkers(
      raw.slice(bestIdx + bestMarker.length).replace(/^[:\s-]+/, ''),
    );
    if (after) return { preamble: before, question: after };
    return { preamble: '', question: before || stripTaskOutcomeMarkers(raw) };
  }
  return { preamble: '', question: stripTaskOutcomeMarkers(raw) };
}

export function parseTaskOutcome(text: string): ParsedTaskOutcome {
  const t = text.trim();
  const upper = t.toUpperCase();
  for (const marker of TASK_OUTCOME_MARKERS) {
    const idx = upper.lastIndexOf(marker);
    if (idx >= 0) {
      const after = t.slice(idx + marker.length).trim();
      const instruction =
        after.replace(/^[:\s-]+/, '').split(/\n/)[0]?.trim() || undefined;
      if (marker === 'ADD_HUMAN_STEP') {
        const title =
          after.replace(/^[:\s-]+/, '').split(/\n/)[0]?.trim() || 'Your input needed';
        return { kind: 'add_human_step', instruction: title };
      }
      if (marker === 'ASK_USER') return { kind: 'ask_user', instruction };
      if (marker === 'NEEDS_HUMAN') return { kind: 'needs_human', instruction };
      if (marker === 'TASK_DONE') return { kind: 'task_done', instruction };
      return { kind: 'needs_review', instruction };
    }
  }
  return { kind: 'none' };
}

export function truncateSnapshotForPrompt(payload: TaskContextSnapshotPayload): string {
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
  /** One-shot user reply to ASK_USER; not stored on plan steps or prior run summary. */
  ephemeralNote?: string;
  runSummary?: string | null;
  /** Include the full context snapshot (goal+facts+chat). Only the first turn of a loop needs it; the OpenClaw session keeps it in history afterwards. */
  includeSnapshot?: boolean;
}): string {
  const stepLines = opts.steps
    .map((s, i) => `${i + 1}. [${s.actor}] ${s.title} (${s.status})`)
    .join('\n');
  const current = opts.steps.find((s) => s.status !== 'done' && s.status !== 'failed');
  const activeLine = current
    ? `Current step (execute only this gate): ${current.position + 1}. [${current.actor}] ${current.title}`
    : '';
  const includeSnapshot = opts.includeSnapshot !== false;
  return [
    'You are executing an iClaw task.',
    '',
    `Goal: ${opts.goal.trim()}`,
    '',
    ...(includeSnapshot
      ? ['Context snapshot:', truncateSnapshotForPrompt(opts.payload), '']
      : []),
    'Plan steps:',
    stepLines || '(no steps — execute the goal directly)',
    '',
    ...(activeLine ? [activeLine, ''] : []),
    ...(opts.runSummary ? [`Previous run summary:\n${opts.runSummary}`, ''] : []),
    ...(opts.ephemeralNote
      ? [
          'One-shot clarification from the user (not part of the frozen snapshot, plan, or prior OpenClaw transcript — use only to continue the current agent step):',
          opts.ephemeralNote,
          '',
        ]
      : []),
    ...(opts.resumeNote ? [`Human input for resume:\n${opts.resumeNote}`, ''] : []),
    'Rules:',
    current?.actor === 'human'
      ? '- Current step is HUMAN: do not run agent work; return NEEDS_HUMAN immediately.'
      : '- Execute only the current agent step; do not skip ahead past unfinished human steps.',
    '- For a quick clarification while staying on the current agent step (no new plan step), end with ASK_USER on its own line, then your question. The answer is one-shot and is not added to long-term task context.',
    '- If a human plan gate is required, stop and return NEEDS_HUMAN with a clear instruction on the last line.',
    '- If the user must act again and no upcoming human plan step fits, add a new plan step:',
    '  ADD_HUMAN_STEP: <short step title>',
    '  then your question (the runner inserts the human step and pauses).',
    '- Do not continue past human approval gates.',
    '- When the current agent step is finished, end with TASK_DONE on its own line (the runner advances to the next plan step).',
    '- Use TASK_DONE only after completing the current step — not while human steps are still pending.',
    '- When human review is needed before closing the whole task, end with NEEDS_REVIEW on its own line.',
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

/** Drop OpenClaw session history so the next turn only sees the rebuilt iClaw prompt. */
async function resetExecutionSession(executionChatId: number): Promise<void> {
  const chat = chats.get(executionChatId);
  if (!chat) return;
  const sk = chat.openclaw_session_id;
  if (typeof sk === 'string' && sk.startsWith('agent:')) {
    await openclawWs.deleteSession(sk).catch(() => {});
  }
  chats.replaceSessionKey(executionChatId, '');
}

function applyAskUserOutcome(taskId: number, assistantText: string): TaskWithSteps {
  const task = tasks.get(taskId);
  if (!task) throw new Error('task not found');
  const ask = formatAgentHumanAsk(assistantText);
  const summary =
    ask.question ||
    ask.preamble ||
    stripTaskOutcomeMarkers(assistantText).slice(0, 4000) ||
    'Clarification needed';
  tasks.patch(taskId, { status: 'needs_clarification', resultSummary: summary });
  postSourceChatNote(task.source_chat_id, `Task clarification: ${task.title}`);
  const enriched = enrichTaskWithSteps(tasks.get(taskId)!);
  broadcastTaskUpdated(enriched);
  return enriched;
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
  saveStepRunResult(step.id, text);
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
    const ask = formatAgentHumanAsk(assistantText);
    const summary =
      ask.question ||
      ask.preamble ||
      outcome.instruction ||
      stripTaskOutcomeMarkers(assistantText).slice(0, 4000);
    tasks.patch(taskId, {
      status: 'needs_human',
      resultSummary: summary,
    });
    if (humanStep) taskSteps.updateStatus(humanStep.id, 'needs_human');
    postSourceChatNote(
      task.source_chat_id,
      `Task needs human: ${task.title}${outcome.instruction ? ` — ${outcome.instruction}` : ''}`,
    );
    return 'needs_human';
  }
  if (outcome.kind === 'task_done') {
    throw new Error('task_done is handled by runTaskStepLoop');
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
  /** When false, user turn is not stored in the execution chat log (ephemeral clarification). */
  persistUser?: boolean;
}): Promise<string> {
  return chatStatus.withLock(opts.executionChatId, async () => {
  const sessionKey = await ensureExecutionSession(opts.executionChatId);
  const execChat = chats.get(opts.executionChatId)!;
  const stored = opts.gatewayMessage;
  const expanded = expandStoredSecretPlaceholdersForGateway(stored, execChat);

  if (opts.persistUser !== false) {
    const userMsg = messages.append(opts.executionChatId, 'user', stored, null);
    wsHub.broadcastToChat(opts.executionChatId, {
      type: 'message-appended',
      chatId: opts.executionChatId,
      message: userMsg,
    });
  }

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
  });
}

/** Short preview under the step title (full text, not the expandable Agent output). */
export function makeStepSummary(text: string, maxLen = 500): string {
  const stripped = stripTaskOutcomeMarkers(text).trim();
  if (!stripped) return '';
  const firstParagraph =
    stripped
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p.length > 0) ?? stripped;
  if (maxLen <= 0 || firstParagraph.length <= maxLen) return firstParagraph;
  return firstParagraph.slice(0, maxLen);
}

function saveStepRunResult(stepId: number, text: string): void {
  const body = stripTaskOutcomeMarkers(text).trim();
  if (!body) return;
  taskSteps.saveResult(stepId, body, makeStepSummary(body));
}

function markRunningStepDone(taskId: number, finalText?: string): void {
  const running = taskSteps.listByTask(taskId).find((s) => s.status === 'running');
  if (!running) return;
  if (finalText != null && String(finalText).trim()) {
    saveStepRunResult(running.id, finalText);
  }
  taskSteps.updateStatus(running.id, 'done');
}

function revertRunningStepToTodo(taskId: number): TaskStep | undefined {
  const running = taskSteps.listByTask(taskId).find((s) => s.status === 'running');
  if (running) {
    taskSteps.updateStatus(running.id, 'todo');
    return running;
  }
  return undefined;
}

function applyAddHumanStepOutcome(
  taskId: number,
  stepTitle: string,
  assistantText: string,
): TaskWithSteps {
  const task = tasks.get(taskId);
  if (!task) throw new Error('task not found');
  const anchor =
    revertRunningStepToTodo(taskId) ?? taskSteps.getActiveStep(taskId);
  if (!anchor) throw new Error('no active step to attach human step');
  const title = stepTitle.trim() || 'Your input needed';
  const inserted = taskSteps.insertHumanAfter(taskId, anchor.id, title);
  const ask = formatAgentHumanAsk(assistantText);
  const summary =
    ask.question ||
    ask.preamble ||
    stripTaskOutcomeMarkers(assistantText).slice(0, 4000) ||
    title;
  taskSteps.updateStatus(inserted.id, 'needs_human');
  tasks.patch(taskId, { status: 'needs_human', resultSummary: summary });
  postSourceChatNote(
    task.source_chat_id,
    `Task needs human: ${task.title} — ${title}`,
  );
  const enriched = enrichTaskWithSteps(tasks.get(taskId)!);
  broadcastTaskUpdated(enriched);
  return enriched;
}

function finishTaskComplete(taskId: number, summary: string | null): void {
  const task = tasks.get(taskId)!;
  tasks.patch(taskId, {
    status: 'done',
    resultSummary: summary,
  });
  postSourceChatNote(task.source_chat_id, `Task done: ${task.title}`);
  broadcastTaskUpdated(enrichTaskWithSteps(tasks.get(taskId)!));
}

/**
 * Run agent turns until a human gate, review, failure, or all plan steps are done.
 * TASK_DONE advances one agent step; the whole task closes only when no steps remain.
 */
async function runTaskStepLoop(
  taskId: number,
  opts: {
    executionChatId: number;
    payload: TaskContextSnapshotPayload;
    goal: string;
    resumeNote?: string;
    ephemeralNote?: string;
    initialRunSummary?: string | null;
  },
): Promise<void> {
  const task = tasks.get(taskId);
  if (!task) throw new Error('task not found');
  if (activeTaskLoops.has(taskId)) throw new Error('task step loop already active');
  activeTaskLoops.add(taskId);
  let runSummary = opts.initialRunSummary ?? null;
  let resumeNote = opts.resumeNote;
  let ephemeralNote = opts.ephemeralNote;
  /* Send the heavy context snapshot only once per loop invocation; the OpenClaw
   * session keeps it in history. Re-sending it every turn was bloating the
   * upstream context and correlated with degenerate empty turns. */
  let isFirstTurn = true;
  /* Per-step empty-output retries. Empty + markerless used to fall through to
   * markRunningStepDone, silently promoting upstream failures to "step done". */
  const emptyAttempts = new Map<number, number>();
  const MAX_EMPTY_ATTEMPTS = 2;

  try {
  while (true) {
    const active = taskSteps.getActiveStep(taskId);

    if (!active) {
      finishTaskComplete(taskId, runSummary);
      return;
    }

    if (active.actor === 'human') {
      pauseTaskForHumanStep(taskId, active, runSummary);
      return;
    }

    if (active.status === 'todo') {
      taskSteps.updateStatus(active.id, 'running');
    }

    tasks.patch(taskId, { status: 'running', resultSummary: runSummary });
    broadcastTaskUpdated(tasks.get(taskId)!);

    const run = taskRuns.create({
      taskId,
      executionChatId: opts.executionChatId,
      status: 'running',
      taskStepId: active.id,
    });

    const prompt = buildExecutionPrompt({
      goal: opts.goal,
      payload: opts.payload,
      steps: taskSteps.listByTask(taskId),
      resumeNote,
      ephemeralNote,
      runSummary,
      includeSnapshot: isFirstTurn,
    });
    isFirstTurn = false;
    resumeNote = undefined;
    const persistUser = ephemeralNote == null;
    ephemeralNote = undefined;

    const finalText = await runExecutionTurn({
      taskId,
      executionChatId: opts.executionChatId,
      gatewayMessage: prompt,
      runId: run.id,
      persistUser,
    });
    const outcome = parseTaskOutcome(finalText);

    if (outcome.kind === 'ask_user') {
      taskRuns.finish(run.id, 'completed', runSummary?.slice(0, 4000) ?? null);
      applyAskUserOutcome(taskId, finalText);
      return;
    }

    runSummary = finalText.slice(0, 4000) || null;

    if (outcome.kind === 'add_human_step') {
      applyAddHumanStepOutcome(
        taskId,
        outcome.instruction ?? 'Your input needed',
        finalText,
      );
      return;
    }
    if (outcome.kind === 'needs_human') {
      applyOutcomeToTask(taskId, outcome, finalText);
      return;
    }
    if (outcome.kind === 'needs_review') {
      applyOutcomeToTask(taskId, outcome, finalText);
      return;
    }

    /* Empty + no marker = upstream produced nothing useful (e.g. degenerate
     * empty chat:final from the gateway). Do not promote to done. Retry once
     * with a nudge, then escalate to needs_review so the human can see it. */
    if (outcome.kind === 'none' && stripTaskOutcomeMarkers(finalText).trim().length === 0) {
      const attempts = (emptyAttempts.get(active.id) ?? 0) + 1;
      emptyAttempts.set(active.id, attempts);
      if (attempts < MAX_EMPTY_ATTEMPTS) {
        ephemeralNote =
          'Previous turn returned an empty response. Please complete the current step now, ' +
          'or end with NEEDS_HUMAN/NEEDS_REVIEW if you cannot.';
        runSummary = opts.initialRunSummary ?? runSummary;
        continue;
      }
      const summary = 'Agent returned empty output for this step; not marking as done.';
      tasks.patch(taskId, { status: 'needs_review', resultSummary: summary });
      postSourceChatNote(
        task.source_chat_id,
        `Task needs review: ${task.title} — agent returned empty output`,
      );
      broadcastTaskUpdated(enrichTaskWithSteps(tasks.get(taskId)!));
      return;
    }

    /* task_done, or none (no marker) with non-empty text: agent did the work
     * but forgot the marker. Treat current agent step as finished and continue. */
    markRunningStepDone(taskId, finalText);

    const next = taskSteps.getActiveStep(taskId);
    if (!next) {
      finishTaskComplete(taskId, runSummary);
      return;
    }
    if (next.actor === 'human') {
      pauseTaskForHumanStep(taskId, next, runSummary);
      return;
    }

    broadcastTaskUpdated(enrichTaskWithSteps(tasks.get(taskId)!));
  }
  } finally {
    activeTaskLoops.delete(taskId);
  }
}

async function generatePlanForTask(
  taskId: number,
  goal: string,
  payload: TaskContextSnapshotPayload,
): Promise<TaskStep[]> {
  const raw = await Promise.race([
    runThrowawayTurn(buildTaskPlanPrompt(goal, payload)),
    new Promise<string>((resolve) => setTimeout(() => resolve(''), PLAN_BUDGET_MS)),
  ]);
  const parsed = parsePlanLines(raw);
  if (parsed.length) return taskSteps.replaceAll(taskId, parsed);
  return taskSteps.listByTask(taskId);
}

/** Background: agent plan + flip task to ready. */
async function finishTaskPlanning(
  taskId: number,
  opts: { sourceChatId: number; goal: string },
): Promise<void> {
  const task = tasks.get(taskId);
  if (!task || task.status !== 'planning') return;
  const snap = taskContextSnapshots.get(task.context_snapshot_id);
  const payload = snap ? taskContextSnapshots.parsePayload(snap) : buildContextSnapshot(opts.sourceChatId);
  try {
    await generatePlanForTask(taskId, opts.goal, payload);
  } catch (err) {
    console.error('[taskRunner] plan generation failed for task', taskId, err);
  }
  tasks.patch(taskId, { status: 'ready' });
  postSourceChatNote(opts.sourceChatId, `Task created: ${task.title}`);
  broadcastTaskUpdated(enrichTaskWithSteps(tasks.get(taskId)!));
}

/**
 * Background: generate a nicer task title via the agent and patch it in IF
 * the user hasn't already edited the placeholder. Mirrors the chat title flow.
 */
async function finishTaskAutoTitle(opts: {
  taskId: number;
  agent: string;
  goal: string;
  placeholder: string;
}): Promise<void> {
  try {
    const suggested = await suggestChatTitleWithTimeout({
      model: opts.agent,
      userMessage: opts.goal,
    });
    if (!suggested) return;
    const current = tasks.get(opts.taskId);
    /* Don't clobber a manual edit: only replace if title still matches the
     * placeholder we set at creation. */
    if (!current || current.title !== opts.placeholder) return;
    const updated = tasks.patch(opts.taskId, { title: suggested });
    if (updated) broadcastTaskUpdated(updated);
  } catch (err) {
    console.error(
      '[taskRunner] auto-title failed for task',
      opts.taskId,
      err instanceof Error ? err.message : err,
    );
  }
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
  const initialStatus: TaskStatus = opts.generatePlan ? 'planning' : 'ready';
  const providedTitle = (opts.title ?? '').trim();
  const placeholder = providedTitle ? providedTitle : deriveTitle(opts.goal);
  const task = tasks.create({
    projectId: chat.project_id,
    sourceChatId: opts.sourceChatId,
    title: placeholder,
    goal: opts.goal,
    agent,
    contextSnapshotId: snap.id,
    status: initialStatus,
  });

  /* If the caller didn't supply a title, generate one in the background and
   * patch it in once ready (mirroring chat title auto-generation). */
  if (!providedTitle) {
    void finishTaskAutoTitle({
      taskId: task.id,
      agent,
      goal: opts.goal,
      placeholder,
    });
  }

  if (opts.generatePlan) {
    const enriched = enrichTaskWithSteps(task);
    wsHub.broadcastAll({ type: 'task-created', task: enriched });
    void finishTaskPlanning(task.id, {
      sourceChatId: opts.sourceChatId,
      goal: opts.goal,
    });
    return enriched;
  }

  postSourceChatNote(opts.sourceChatId, `Task created: ${task.title}`);
  const enriched = enrichTaskWithSteps(task);
  wsHub.broadcastAll({ type: 'task-created', task: enriched });
  return enriched;
}

export function approvePlan(
  taskId: number,
  steps: {
    id?: number;
    actor: TaskStepActor;
    title: string;
    description?: string | null;
  }[],
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

  try {
    await Promise.race([
      runTaskStepLoop(taskId, {
        executionChatId,
        payload,
        goal: task.goal,
      }),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('task run timed out')), RUN_BUDGET_MS),
      ),
    ]);
  } catch (err) {
    const msg = isGatewayBridgeFailure(err)
      ? gatewayBridgeFailureUserMessage()
      : err instanceof Error
        ? err.message
        : String(err);
    tasks.patch(taskId, { status: 'failed', resultSummary: msg });
    const latestRun = taskRuns.getLatest(taskId);
    if (latestRun && latestRun.status === 'running') {
      taskRuns.finish(latestRun.id, 'failed', msg);
    }
    postSourceChatNote(task.source_chat_id, `Task failed: ${task.title}`);
    throw err;
  }

  const updated = enrichTaskWithSteps(tasks.get(taskId)!);
  broadcastTaskUpdated(updated);
  return updated;
}

export async function resumeTaskClarification(
  taskId: number,
  humanInput: string,
): Promise<TaskWithSteps> {
  const task = tasks.get(taskId);
  if (!task) throw new Error('task not found');
  if (task.status !== 'needs_clarification') {
    throw new Error('task is not waiting for clarification');
  }

  const executionChatId = getOrCreateExecutionChat(task);
  await resetExecutionSession(executionChatId);

  const snap = taskContextSnapshots.get(task.context_snapshot_id)!;
  const payload = taskContextSnapshots.parsePayload(snap);
  const lastRun = taskRuns.getLatest(taskId);
  const checkpointSummary = lastRun?.log_summary ?? null;

  tasks.patch(taskId, { status: 'running' });
  broadcastTaskUpdated(tasks.get(taskId)!);

  try {
    await Promise.race([
      runTaskStepLoop(taskId, {
        executionChatId,
        payload,
        goal: task.goal,
        ephemeralNote: humanInput.trim(),
        initialRunSummary: checkpointSummary,
      }),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('task run timed out')), RUN_BUDGET_MS),
      ),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    tasks.patch(taskId, { status: 'failed', resultSummary: msg });
    const latestRun = taskRuns.getLatest(taskId);
    if (latestRun && latestRun.status === 'running') {
      taskRuns.finish(latestRun.id, 'failed', msg);
    }
    throw err;
  }

  const updated = enrichTaskWithSteps(tasks.get(taskId)!);
  broadcastTaskUpdated(updated);
  return updated;
}

export async function resumeTask(taskId: number, humanInput: string): Promise<TaskWithSteps> {
  const task = tasks.get(taskId);
  if (!task) throw new Error('task not found');
  if (task.status === 'needs_clarification') {
    return resumeTaskClarification(taskId, humanInput);
  }
  if (task.status !== 'needs_human') throw new Error('task is not waiting for human input');

  const steps = taskSteps.listByTask(taskId);
  const waiting = steps.find((s) => s.status === 'needs_human');
  if (waiting) {
    saveStepRunResult(waiting.id, humanInput);
    taskSteps.updateStatus(waiting.id, 'done');
  }

  const next = taskSteps.getActiveStep(taskId);
  if (!next) {
    finishTaskComplete(taskId, humanInput.trim() || task.result_summary);
    return enrichTaskWithSteps(tasks.get(taskId)!);
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

  try {
    await Promise.race([
      runTaskStepLoop(taskId, {
        executionChatId,
        payload,
        goal: task.goal,
        resumeNote: humanInput.trim(),
        initialRunSummary: lastRun?.log_summary ?? task.result_summary,
      }),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('task run timed out')), RUN_BUDGET_MS),
      ),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    tasks.patch(taskId, { status: 'failed', resultSummary: msg });
    const latestRun = taskRuns.getLatest(taskId);
    if (latestRun && latestRun.status === 'running') {
      taskRuns.finish(latestRun.id, 'failed', msg);
    }
    throw err;
  }

  const updated = enrichTaskWithSteps(tasks.get(taskId)!);
  broadcastTaskUpdated(updated);
  return updated;
}

/**
 * Reset a failed task back to `ready` and run it again. Steps marked `done`
 * stay done; anything `running`/`failed` flips back to `todo`. The OpenClaw
 * session is intentionally kept — its turn history is the agent's own record
 * of what it did before the failure, so the retry resumes with context.
 */
export async function retryTask(taskId: number): Promise<TaskWithSteps> {
  const task = tasks.get(taskId);
  if (!task) throw new Error('task not found');
  if (task.status !== 'failed') {
    throw new Error(`task cannot retry from status ${task.status}`);
  }
  const steps = taskSteps.listByTask(taskId);
  if (!steps.length) throw new Error('task has no plan to retry');
  for (const s of steps) {
    if (s.status === 'running' || s.status === 'failed') {
      taskSteps.updateStatus(s.id, 'todo');
    }
  }
  tasks.patch(taskId, { status: 'ready', resultSummary: null });
  broadcastTaskUpdated(tasks.get(taskId)!);
  return runTask(taskId);
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
  { key: 'ready', statuses: ['ready', 'planning'] },
  { key: 'running', statuses: ['running'] },
  { key: 'needs_human', statuses: ['needs_human', 'needs_clarification'] },
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
    else board.ready.push(t);
  }
  return board;
}
