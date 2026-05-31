/**
 * Ephemeral "Ask" on a task page: fresh context snapshot + throwaway OpenClaw session.
 * Does not change task status, plan, execution chat, or the task's frozen snapshot.
 *
 * Turn streaming is pushed over the global WebSocket (`task-ask-turn-*`), same pattern
 * as `task-run-delta` — clients filter by taskId + sessionId.
 */

import { normalizeAgentId } from './chatRunner';
import { openclawWs, type TurnEvent } from './openclawWs';
import {
  chats,
  taskAskSessions,
  taskContextSnapshots,
  tasks,
} from './store';
import { toolActivityLabel } from './toolLabels';
import {
  buildContextSnapshot,
  truncateSnapshotForPrompt,
  TASK_ASK_LANGUAGE_POLICY,
} from './taskRunner';
import { wsHub } from './wsHub';
import type { ServerMsg } from '../types/protocol';
import type { Task, TaskContextSnapshotPayload } from '../types';

const ASK_BUDGET_MS = 120_000;

function broadcastAsk(
  taskId: number,
  sessionId: number,
  msg: Extract<
    ServerMsg,
    | { type: 'task-ask-turn-started' }
    | { type: 'task-ask-turn-delta' }
    | { type: 'task-ask-turn-tool' }
    | { type: 'task-ask-turn-lifecycle' }
    | { type: 'task-ask-turn-ended' }
    | { type: 'task-ask-turn-error' }
  >,
): void {
  wsHub.broadcastAll({ ...msg, taskId, sessionId });
}

function buildAskFirstTurnMessage(
  task: Task,
  payload: TaskContextSnapshotPayload,
  userMessage: string,
): string {
  return [
    'You are answering a quick question about an iClaw task.',
    'This is NOT task execution: do not use TASK_DONE, NEEDS_HUMAN, ASK_USER, ADD_HUMAN_STEP, or NEEDS_REVIEW.',
    'Reply helpfully and concisely.',
    '',
    `Task title: ${task.title.trim()}`,
    `Goal: ${task.goal.trim()}`,
    '',
    'Context snapshot (captured when the user opened Ask — may be newer than the task frozen snapshot):',
    truncateSnapshotForPrompt(payload),
    '',
    TASK_ASK_LANGUAGE_POLICY,
    '',
    'User question:',
    userMessage.trim(),
  ].join('\n');
}

function closeAskSessionRow(row: { id: number; context_snapshot_id: number; openclaw_session_key: string | null }): void {
  const sk = row.openclaw_session_key;
  if (typeof sk === 'string' && sk.startsWith('agent:')) {
    void openclawWs.deleteSession(sk).catch(() => {});
  }
  taskContextSnapshots.delete(row.context_snapshot_id);
  taskAskSessions.delete(row.id);
}

/** Close any open Ask sessions for this task (e.g. before opening a new one). */
export function closeAllTaskAskSessions(taskId: number): void {
  for (const row of taskAskSessions.listOpenByTask(taskId)) {
    closeAskSessionRow(row);
  }
}

export async function openTaskAsk(taskId: number): Promise<{ sessionId: number }> {
  const task = tasks.get(taskId);
  if (!task) throw new Error('task not found');

  closeAllTaskAskSessions(taskId);

  const chat = chats.get(task.source_chat_id);
  if (!chat) throw new Error('source chat not found');

  const payload = buildContextSnapshot(task.source_chat_id);
  const snap = taskContextSnapshots.create({
    projectId: chat.project_id,
    sourceChatId: task.source_chat_id,
    payload,
  });

  const agentId = normalizeAgentId(task.agent ?? chat.agent);
  const ocSession = await openclawWs.createSession({ agentId });
  const row = taskAskSessions.create({
    taskId,
    contextSnapshotId: snap.id,
    openclawSessionKey: ocSession.key,
  });

  return { sessionId: row.id };
}

function handleAskTurnEvent(taskId: number, sessionId: number, ev: TurnEvent, acc: { text: string }): void {
  if (ev.type === 'text-delta') {
    acc.text += ev.text;
    broadcastAsk(taskId, sessionId, { type: 'task-ask-turn-delta', taskId, sessionId, text: ev.text });
  } else if (ev.type === 'text-final') {
    acc.text = ev.text || acc.text;
  } else if (ev.type === 'tool-start') {
    broadcastAsk(taskId, sessionId, {
      type: 'task-ask-turn-tool',
      taskId,
      sessionId,
      phase: 'start',
      name: ev.name,
      label: ev.label,
      detail: ev.detail,
    });
  } else if (ev.type === 'tool-end') {
    broadcastAsk(taskId, sessionId, {
      type: 'task-ask-turn-tool',
      taskId,
      sessionId,
      phase: 'end',
      name: ev.name,
      label: toolActivityLabel(ev.name),
    });
  } else if (ev.type === 'lifecycle') {
    broadcastAsk(taskId, sessionId, {
      type: 'task-ask-turn-lifecycle',
      taskId,
      sessionId,
      phase: ev.phase,
      label: ev.label,
    });
  }
}

export async function taskAskTurn(
  taskId: number,
  sessionId: number,
  userMessage: string,
): Promise<{ reply: string }> {
  const text = userMessage.trim();
  if (!text) throw new Error('message required');

  const task = tasks.get(taskId);
  if (!task) throw new Error('task not found');

  const row = taskAskSessions.get(sessionId);
  if (!row || row.task_id !== taskId) throw new Error('ask session not found');

  const snap = taskContextSnapshots.get(row.context_snapshot_id);
  if (!snap) throw new Error('ask snapshot missing');

  const payload = taskContextSnapshots.parsePayload(snap);
  const isFirst = row.turn_count === 0;
  const gatewayMessage = isFirst
    ? buildAskFirstTurnMessage(task, payload, text)
    : text;

  broadcastAsk(taskId, sessionId, {
    type: 'task-ask-turn-started',
    taskId,
    sessionId,
    activity: { label: 'Thinking…' },
  });

  const acc = { text: '' };
  try {
    await Promise.race([
      openclawWs.runTurn({
        sessionKey: row.openclaw_session_key,
        message: gatewayMessage,
        onEvent: (ev) => handleAskTurnEvent(taskId, sessionId, ev, acc),
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('ask turn timed out')), ASK_BUDGET_MS),
      ),
    ]);

    taskAskSessions.incrementTurnCount(sessionId);
    const reply = acc.text.trim() || '(no response)';
    broadcastAsk(taskId, sessionId, {
      type: 'task-ask-turn-ended',
      taskId,
      sessionId,
      reply,
    });
    return { reply };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    broadcastAsk(taskId, sessionId, {
      type: 'task-ask-turn-error',
      taskId,
      sessionId,
      error,
    });
    throw err;
  }
}

export async function closeTaskAsk(taskId: number, sessionId: number): Promise<void> {
  const row = taskAskSessions.get(sessionId);
  if (!row || row.task_id !== taskId) return;
  closeAskSessionRow(row);
}
