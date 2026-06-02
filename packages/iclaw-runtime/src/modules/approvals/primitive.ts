/**
 * Approvals primitive — simplified for iClaw Runtime.
 *
 * In Work Mode, approval requests are routed back to the iClaw browser UI
 * via the iclaw-http channel (SSE event type: "approval_request").
 * The user approves/rejects in the browser; the response comes back as
 * a channel action event.
 */
import { createPendingApproval, getSession } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';

export interface ApprovalHandlerContext {
  session: Session;
  payload: Record<string, unknown>;
  userId: string;
  notify: (text: string) => void;
}

export type ApprovalHandler = (ctx: ApprovalHandlerContext) => Promise<void>;

const approvalHandlers = new Map<string, ApprovalHandler>();

export function registerApprovalHandler(action: string, handler: ApprovalHandler): void {
  if (approvalHandlers.has(action)) {
    log.warn('Approval handler re-registered (overwriting)', { action });
  }
  approvalHandlers.set(action, handler);
}

export function getApprovalHandler(action: string): ApprovalHandler | undefined {
  return approvalHandlers.get(action);
}

export function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake container after notification', { err }));
  }
}

export interface RequestApprovalOptions {
  session: Session;
  agentName: string;
  action: string;
  payload: Record<string, unknown>;
  title: string;
  question: string;
}

/**
 * Queue an approval request. Delivers an approval card to the iClaw UI
 * via the iclaw-http SSE channel. The user approves/rejects in the browser.
 */
export async function requestApproval(opts: RequestApprovalOptions): Promise<void> {
  const { session, action, payload, title, question } = opts;

  const approvalId = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const normalizedOptions = [
    { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
    { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
  ];
  createPendingApproval({
    approval_id: approvalId,
    session_id: session.id,
    request_id: approvalId,
    action,
    payload: JSON.stringify(payload),
    created_at: new Date().toISOString(),
    title,
    options_json: JSON.stringify(normalizedOptions),
  });

  // Deliver approval card to iClaw UI via the iclaw-http channel
  const adapter = getDeliveryAdapter();
  const channelType = 'iclaw-http';
  const platformId = 'iclaw';
  if (adapter) {
    try {
      await adapter.deliver(
        channelType,
        platformId,
        session.thread_id,
        'chat',
        JSON.stringify({
          type: 'approval_request',
          approvalId,
          title,
          question,
          options: normalizedOptions,
        }),
      );
    } catch (err) {
      log.error('Failed to deliver approval card to iClaw UI', { action, approvalId, err });
      notifyAgent(session, `${action} failed: could not deliver approval request.`);
      return;
    }
  }

  log.info('Approval requested', { action, approvalId });
}
