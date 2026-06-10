/**
 * Roles routes — the "hire a digital specialist" surface.
 *
 *   GET /roles       → hub: the curated, progressively-disclosed set of roles.
 *   GET /roles/:id   → a role: its delegation_examples (clickable), a task input,
 *                      and the tool-connect state (e.g. "Connect Notion").
 *
 * Roles are curated manifests in code (src/roles). Per-role *state* — a connected
 * tool token — lives in the KV store, keyed by tool so one Notion connection is
 * reused across every Notion role. The actual run (ephemeral container + soul as
 * systemPrompt + the Notion tool) is wired in a later step.
 */

import { Router } from 'express';

import { chats, projects, tasks } from '../services/store';
import { chatStatus } from '../services/chatStatus';
import { openclaw } from '../services/openclaw';
import { probeGateway } from '../services/gatewayProbe';
import { visibleRoles, getRole } from '../roles';
import { kvGet } from '../db/kv';

export const rolesRouter: Router = Router();

/** Locals every full page needs so the shared head + sidebar render. */
async function baseLocals(probeLabel: string) {
  const { gatewayUp, agentsError } = await probeGateway(probeLabel);
  return {
    chats: chats.list(),
    workingIds: chatStatus.workingIds(),
    allProjects: projects.list(),
    hasAnyTasks: tasks.hasAny(),
    taskStatusSignals: tasks.statusSignals(),
    activeChat: null,
    activeProject: null,
    gatewayUp,
    agentsError,
    openclawBaseUrl: openclaw.baseUrl,
  };
}

/** Tool-connection state, keyed by tool so it's shared across roles. */
function toolConnected(toolId: string): boolean {
  return Boolean((kvGet(`tool.${toolId}.token`) ?? '').trim());
}

/** Coarse maturity signal for progressive disclosure (more chats → more roles). */
function userMaturity(): number {
  // Mirrors the "Projects surfaces at ≥5 chats" disclosure pattern.
  return chats.list().length >= 5 ? 3 : 0;
}

rolesRouter.get('/', async (_req, res) => {
  const roles = visibleRoles(userMaturity()).map((r) => ({
    id: r.id,
    name: r.name,
    tagline: r.tagline,
    icon: r.icon,
    audience: r.audience,
    connectDifficulty: r.connectDifficulty,
    tool: r.tools[0]?.id ?? null,
    connected: r.tools.some((t) => toolConnected(t.id)),
  }));
  res.render('roles', {
    ...(await baseLocals('roles')),
    activeRolesList: true,
    roleRows: roles,
  });
});

rolesRouter.get('/:id', async (req, res) => {
  const role = getRole(String(req.params.id));
  if (!role) {
    res.redirect(302, '/roles');
    return;
  }
  res.render('role', {
    ...(await baseLocals('role')),
    activeRolesList: true,
    role: {
      id: role.id,
      name: role.name,
      tagline: role.tagline,
      icon: role.icon,
      audience: role.audience,
      delegationExamples: role.delegationExamples,
      deliverable: role.deliverable,
      tools: role.tools.map((t) => ({
        id: t.id,
        scope: t.scope,
        connect: t.connect,
        connectLabel: t.connectLabel ?? `Connect ${t.id}`,
        connected: toolConnected(t.id),
      })),
      egressAllowlist: role.egressAllowlist,
      definitionOfDone: role.definitionOfDone,
    },
  });
});
