/**
 * Gateway event bridge — subscribes to global OpenClaw broadcasts (session
 * index changes, exec approvals, …) and forwards them to browser clients.
 *
 * iClaw's per-turn event handling lives in chatRunner; this module handles
 * everything that arrives outside of a turn or applies across sessions.
 */

import { gatewayWs, type RawGatewayFrame } from './gatewayWs';
import { openclawWs } from './openclawWs';
import { wsHub } from './wsHub';
import { chats } from './store';

let started = false;

function pickString(payload: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const v = payload[key];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

function handleSessionsChanged(payload: Record<string, unknown>): void {
  const kind = pickString(payload, 'kind', 'op', 'action') ?? 'update';
  const sessionKey = pickString(payload, 'sessionKey', 'key', 'sessionId');
  // We don't try to fan out kind-specific updates — clients react to the
  // signal by refetching sidebar state if needed. This keeps the protocol
  // tiny while still solving the "another tab/CLI changed something" case.
  wsHub.broadcastAll({
    type: 'gateway-session-changed',
    kind,
    sessionKey,
  });
}

function handleExecApprovalRequested(payload: Record<string, unknown>): void {
  const approvalId = pickString(payload, 'approvalId', 'id');
  const sessionKey = pickString(payload, 'sessionKey', 'key');
  if (!approvalId || !sessionKey) return;
  const chat = chats.findBySessionKey(sessionKey);
  if (!chat) return;

  // Best-effort command summary — different hosts shape the payload slightly
  // differently (gateway vs node), so we accept several common keys.
  const command =
    pickString(payload, 'rawCommand', 'command') ??
    (() => {
      const argv = payload.argv;
      if (Array.isArray(argv)) return argv.map(String).join(' ');
      const plan = payload.systemRunPlan as Record<string, unknown> | undefined;
      if (plan) {
        return (
          pickString(plan, 'rawCommand', 'command') ??
          (Array.isArray(plan.argv) ? plan.argv.map(String).join(' ') : '')
        );
      }
      return '';
    })();
  const cwd =
    pickString(payload, 'cwd') ??
    pickString((payload.systemRunPlan ?? {}) as Record<string, unknown>, 'cwd');
  const reason = pickString(payload, 'reason', 'note');
  const host = pickString(payload, 'host') ?? 'gateway';

  wsHub.broadcastToChat(chat.id, {
    type: 'exec-approval-requested',
    chatId: chat.id,
    approvalId,
    command: command || '(no command text)',
    cwd,
    reason,
    host,
  });
}

function handleExecApprovalResolved(payload: Record<string, unknown>): void {
  const approvalId = pickString(payload, 'approvalId', 'id');
  const sessionKey = pickString(payload, 'sessionKey', 'key');
  if (!approvalId) return;

  // The gateway may resolve approvals from another client (control-ui, CLI, …)
  // — broadcasting back to the originating chat lets the UI remove the card
  // even when the local user didn't click anything.
  if (sessionKey) {
    const chat = chats.findBySessionKey(sessionKey);
    if (chat) {
      wsHub.broadcastToChat(chat.id, {
        type: 'exec-approval-resolved',
        chatId: chat.id,
        approvalId,
        decision: pickString(payload, 'decision') ?? 'unknown',
      });
      return;
    }
  }
  // Fallback when the gateway didn't include sessionKey — let every client
  // remove its matching card by approvalId.
  wsHub.broadcastAll({
    type: 'exec-approval-resolved',
    chatId: 0,
    approvalId,
    decision: pickString(payload, 'decision') ?? 'unknown',
  });
}

function dispatch(frame: RawGatewayFrame): void {
  if (frame.type !== 'event') return;
  const name = frame.event;
  if (!name) return;
  const payload = (frame.payload ?? {}) as Record<string, unknown>;

  if (name === 'sessions.changed') {
    handleSessionsChanged(payload);
    return;
  }
  if (name === 'exec.approval.requested') {
    handleExecApprovalRequested(payload);
    return;
  }
  if (name === 'exec.approval.resolved') {
    handleExecApprovalResolved(payload);
    return;
  }
}

export const gatewayEvents = {
  start(): void {
    if (started) return;
    started = true;
    gatewayWs.onFrame(dispatch);
    // Fire the index subscribe — fail loud since this is the only way we get
    // sessions.changed events. We retry on reconnect via the same path.
    void openclawWs.subscribeSessions().catch((err) => {
      console.warn(
        '[gatewayEvents] sessions.subscribe failed:',
        err instanceof Error ? err.message : err,
      );
    });
  },
};
