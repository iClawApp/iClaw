/**
 * Background sweeper for `scheduled_messages`. Every tick, picks up rows
 * whose `scheduled_at` is in the past and dispatches them through the
 * normal chatRunner path — so a fired schedule looks exactly like a regular
 * user send (same persistence, same broadcasts, same lock semantics).
 *
 * Restart-safe: rows live in SQLite, so a crashed/restarted server picks
 * back up from where it left off and fires anything that came due while
 * the process was down.
 */

import { scheduledMessages } from './store';
import { sendMessage } from './chatRunner';
import { wsHub } from './wsHub';

// 4s so seconds-granularity self-timers (set_timer, e.g. "re-check in 10s" while
// polling a background job) fire promptly. The sweep is a cheap indexed query +
// the `sweeping` guard prevents overlap, so the tighter cadence is negligible.
const TICK_MS = 4_000;

let timer: NodeJS.Timeout | null = null;
let sweeping = false;

async function sweepOnce(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const due = scheduledMessages.listDue();
    for (const row of due) {
      // Remove first so a slow/failing send can't cause a second fire on
      // the next tick. The content is captured in `row.content`.
      scheduledMessages.remove(row.id);
      wsHub.broadcastAll({
        type: 'scheduled-deleted',
        chatId: row.chat_id,
        scheduledId: row.id,
      });
      try {
        await sendMessage({ chatId: row.chat_id, content: row.content });
      } catch (err) {
        console.error(
          '[scheduler] fire failed',
          err instanceof Error ? err.message : err,
        );
      }
    }
  } finally {
    sweeping = false;
  }
}

export const scheduler = {
  start(): void {
    if (timer) return;
    // Kick off one immediate sweep so messages that came due while we were
    // offline fire as soon as the server is up.
    void sweepOnce();
    timer = setInterval(() => {
      void sweepOnce();
    }, TICK_MS);
    // Don't keep the event loop alive solely because of the sweeper.
    timer.unref?.();
  },
  stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  },
};
