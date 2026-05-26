/**
 * sendHint — server-side gate for the long-press discovery pill.
 *
 * Rule: show until the user crosses BOTH thresholds — 2 tasks AND 3
 * scheduled messages. As long as either is below, the pill is eligible.
 * Throttling to once-per-day is the client's responsibility.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { db, resetTestDb } from '../helpers/db';
import { chats, scheduledMessages, taskContextSnapshots, tasks } from '../../src/services/store';
import {
  SEND_HINT_SCHEDULED_THRESHOLD,
  SEND_HINT_TASK_THRESHOLD,
  shouldShowSendHint,
} from '../../src/services/sendHint';

afterEach(() => resetTestDb());

function seedTasks(n: number) {
  const c = chats.create('openclaw/default');
  const snap = taskContextSnapshots.create({
    projectId: null,
    sourceChatId: c.id,
    payload: { agent: 'openclaw/default', chatId: c.id, messages: [] } as never,
  });
  for (let i = 0; i < n; i++) {
    tasks.create({
      projectId: null,
      sourceChatId: c.id,
      title: `T${i}`,
      goal: 'g',
      agent: 'openclaw/default',
      contextSnapshotId: snap.id,
      status: 'completed',
    });
  }
}

function seedScheduled(n: number) {
  const c = chats.create('openclaw/default');
  // Stagger by minute so unique(chat_id, scheduled_at) wouldn't bite us
  // (it doesn't today, but future-proof the seed).
  for (let i = 0; i < n; i++) {
    scheduledMessages.create({
      chatId: c.id,
      content: `m${i}`,
      scheduledAt: new Date(Date.now() + (i + 1) * 60_000),
    });
  }
}

describe('sendHint.shouldShowSendHint', () => {
  it('shows on an empty database (clean install)', () => {
    expect(shouldShowSendHint()).toBe(true);
  });

  it('keeps showing if only the task threshold is met', () => {
    seedTasks(SEND_HINT_TASK_THRESHOLD);
    seedScheduled(SEND_HINT_SCHEDULED_THRESHOLD - 1);
    expect(shouldShowSendHint()).toBe(true);
  });

  it('keeps showing if only the scheduled threshold is met', () => {
    seedTasks(SEND_HINT_TASK_THRESHOLD - 1);
    seedScheduled(SEND_HINT_SCHEDULED_THRESHOLD);
    expect(shouldShowSendHint()).toBe(true);
  });

  it('hides once BOTH thresholds are crossed', () => {
    seedTasks(SEND_HINT_TASK_THRESHOLD);
    seedScheduled(SEND_HINT_SCHEDULED_THRESHOLD);
    expect(shouldShowSendHint()).toBe(false);
  });

  it('hides when far past both thresholds (idempotent)', () => {
    seedTasks(SEND_HINT_TASK_THRESHOLD + 5);
    seedScheduled(SEND_HINT_SCHEDULED_THRESHOLD + 5);
    expect(shouldShowSendHint()).toBe(false);
  });

  // The whole point of measuring "ever created" rather than COUNT(*) — a
  // power user whose scheduled messages have all fired (= rows deleted) must
  // not be re-nagged about a feature they clearly mastered.
  it('stays hidden after rows are deleted (ever-created semantics)', () => {
    seedTasks(SEND_HINT_TASK_THRESHOLD);
    seedScheduled(SEND_HINT_SCHEDULED_THRESHOLD);
    expect(shouldShowSendHint()).toBe(false);

    // Wipe both tables; the sqlite_sequence counters survive.
    db.prepare('DELETE FROM scheduled_messages').run();
    db.prepare('DELETE FROM tasks').run();

    expect(shouldShowSendHint()).toBe(false);
  });
});
