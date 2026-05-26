/**
 * Send-button discovery hint.
 *
 * The long-press menu on the composer's Send button hides two power features
 * — scheduled messages and "create task". New users rarely find these on
 * their own, so we surface a small one-shot pill next to the button that
 * teaches the gesture.
 *
 * Threshold: we stop nagging when the user has EVER CREATED at least
 * `SEND_HINT_TASK_THRESHOLD` tasks AND `SEND_HINT_SCHEDULED_THRESHOLD`
 * scheduled messages. We deliberately measure "ever created" (via
 * sqlite_sequence under the hood) rather than current row counts — a
 * scheduled message is deleted after it fires, and a power user who
 * dispatched 10 of them shouldn't see a "did you know?" pill again just
 * because the table is empty right now.
 *
 * Once-per-day throttling lives in the browser (localStorage) — see
 * `public/js/iclaw.js`. The server only decides whether the pill is
 * eligible to render at all.
 */
import { scheduledMessages, tasks } from './store';

/** When BOTH thresholds are met (ever-created), the user has discovered the feature. */
export const SEND_HINT_TASK_THRESHOLD = 2;
export const SEND_HINT_SCHEDULED_THRESHOLD = 3;

/**
 * Returns `true` if the discovery hint should be eligible to render on
 * this page-load. Cheap — two reads of the sqlite_sequence table.
 */
export function shouldShowSendHint(): boolean {
  const tasksCount = tasks.everCreatedCount();
  const scheduledCount = scheduledMessages.everCreatedCount();
  return (
    tasksCount < SEND_HINT_TASK_THRESHOLD ||
    scheduledCount < SEND_HINT_SCHEDULED_THRESHOLD
  );
}
