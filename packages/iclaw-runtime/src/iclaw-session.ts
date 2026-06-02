/**
 * iClaw Work Mode session management.
 *
 * Bridges the gap between iClaw's simple sessionId-based API and
 * NanoClaw's agent_group / messaging_group / wiring DB model.
 *
 * On startup: ensures a default "iclaw-work" agent group exists.
 * Per session: creates a messaging_group + wiring so routeInbound works.
 */
import { randomUUID } from 'crypto';
import { getDb } from './db/connection.js';
import { createAgentGroup, getAgentGroupByFolder } from './db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from './db/messaging-groups.js';
import { updateContainerConfigScalars } from './db/container-configs.js';
import { initGroupFilesystem } from './group-init.js';
import { DEFAULT_MODEL } from './config.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

export const ICLAW_CHANNEL_TYPE = 'iclaw-http';
export const ICLAW_PLATFORM_ID = 'iclaw';
const DEFAULT_FOLDER = 'iclaw-work';

let _defaultAgentGroup: AgentGroup | null = null;

/** Ensure the default agent group exists. Called once at startup. */
export function ensureDefaultAgentGroup(): AgentGroup {
  if (_defaultAgentGroup) return _defaultAgentGroup;

  const existing = getAgentGroupByFolder(DEFAULT_FOLDER);
  if (existing) {
    _defaultAgentGroup = existing;
    return existing;
  }

  const group: AgentGroup = {
    id: randomUUID(),
    name: 'iClaw Work',
    folder: DEFAULT_FOLDER,
    agent_provider: 'claude',
    created_at: new Date().toISOString(),
  };
  createAgentGroup(group);
  // initGroupFilesystem calls ensureContainerConfig (INSERT OR IGNORE), creating an empty row
  initGroupFilesystem(group);
  // Update the row with model after it's been created
  updateContainerConfigScalars(group.id, {
    model: DEFAULT_MODEL,
    provider: 'claude',
    assistant_name: 'iClaw Work',
  });

  log.info('Created default agent group', { id: group.id, folder: DEFAULT_FOLDER, model: DEFAULT_MODEL });

  _defaultAgentGroup = group;
  return group;
}

/** Wire a new sessionId to the default agent group. Idempotent. */
export function wireSession(sessionId: string): void {
  const agentGroup = ensureDefaultAgentGroup();

  // Check if already wired
  const existing = getDb()
    .prepare(`SELECT 1 FROM messaging_groups WHERE channel_type = ? AND platform_id = ?`)
    .get(ICLAW_CHANNEL_TYPE, sessionId);
  if (existing) return;

  const mgId = `mg-iclaw-${sessionId.slice(0, 8)}`;
  const now = new Date().toISOString();

  createMessagingGroup({
    id: mgId,
    channel_type: ICLAW_CHANNEL_TYPE,
    platform_id: sessionId,
    name: `iclaw-session-${sessionId.slice(0, 8)}`,
    is_group: 0,
    unknown_sender_policy: 'public',
    denied_at: null,
    created_at: now,
  });

  createMessagingGroupAgent({
    id: `mga-iclaw-${sessionId.slice(0, 8)}`,
    messaging_group_id: mgId,
    agent_group_id: agentGroup.id,
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'accumulate',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  });

  log.debug('Wired session to agent group', { sessionId, agentGroupId: agentGroup.id });
}
