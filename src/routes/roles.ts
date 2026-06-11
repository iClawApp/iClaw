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
import { kvGet, kvSet, kvDelete } from '../db/kv';
import { verifyNotionToken, type NotionIdentity } from '../services/notion';
import {
  createWorkSession,
  sendWorkMessage,
  subscribeWorkEvents,
  stopWorkSession,
  getWorkspaceInfo,
} from '../services/workRuntime';

export const rolesRouter: Router = Router();

/** Live role runs (runId === runtime sessionId). In-memory; a run is ephemeral. */
const activeRuns = new Map<string, { roleId: string; startedAt: number }>();

/**
 * The working procedure we append to a role's soul when it has a Notion tool, so
 * every Notion role drives the tools the same reliable way (search → create →
 * fill → hand back a URL) without each soul having to spell it out.
 */
const NOTION_PROCEDURE = `

Working procedure (Notion) — follow exactly:
1. Call notion_search first to find a page the user has shared with you; use its id as parent_page_id. If nothing is shared, tell the user to open a Notion page → ••• → Connections → add this integration, then stop.
2. Create ONE database with notion_create_database — give it clear, well-typed columns.
3. Fill it with notion_add_row, one row per item. Make every row genuinely useful — no filler.
4. Finish by giving the user the database URL and a one-line summary of what you built. Do NOT ask permission before creating — just build it; it's theirs to review, and they can delete it in one tap.`;

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

/** Friendly name of the connected workspace (proof the token reached the real thing). */
function toolWorkspace(toolId: string): string | null {
  return (kvGet(`tool.${toolId}.workspace`) ?? '').trim() || null;
}

/** Tools we know how to verify on connect; others just store the token as-is. */
async function verifyToolToken(toolId: string, token: string): Promise<NotionIdentity> {
  if (toolId === 'notion') return verifyNotionToken(token);
  return { ok: true };
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

/**
 * Connect a token-based tool (e.g. Notion). The token is verified against the
 * live API before we store it, so a bad paste fails loudly here instead of
 * silently at run time. Stored per-tool so one connection serves every role
 * that uses it. POST is method-distinct from GET /:id, so no route collision.
 */
rolesRouter.post('/tools/:toolId/connect', async (req, res) => {
  const toolId = String(req.params.toolId).toLowerCase();
  const token = String(req.body?.token ?? '').trim();
  if (!token) {
    res.status(400).json({ ok: false, error: 'Paste your token first.' });
    return;
  }
  const result = await verifyToolToken(toolId, token);
  if (!result.ok) {
    res.status(400).json({ ok: false, error: result.error ?? 'Could not verify that token.' });
    return;
  }
  kvSet(`tool.${toolId}.token`, token);
  if (result.workspaceName) kvSet(`tool.${toolId}.workspace`, result.workspaceName);
  else kvDelete(`tool.${toolId}.workspace`);
  res.json({ ok: true, workspaceName: result.workspaceName ?? null });
});

/** Disconnect = forget the token (the "fire the connection" half of the leash). */
rolesRouter.post('/tools/:toolId/disconnect', (req, res) => {
  const toolId = String(req.params.toolId).toLowerCase();
  kvDelete(`tool.${toolId}.token`);
  kvDelete(`tool.${toolId}.workspace`);
  res.json({ ok: true });
});

/**
 * Start a role run. Creates an ephemeral runtime session with the role's soul as
 * the system prompt and the connected tool token, sends the one-line task, and
 * returns a runId (the session id). The agent works host-side via the tool; the
 * box never touches the user's computer. Progress streams over /run/:runId/events.
 */
rolesRouter.post('/:id/run', async (req, res) => {
  const role = getRole(String(req.params.id));
  if (!role) {
    res.status(404).json({ ok: false, error: 'Unknown role.' });
    return;
  }
  const task = String(req.body?.task ?? '').trim();
  if (!task) {
    res.status(400).json({ ok: false, error: 'Describe the task in one line.' });
    return;
  }

  // Any tool the role needs must be connected first.
  const notionTool = role.tools.find((t) => t.id === 'notion');
  const notionToken = notionTool ? (kvGet('tool.notion.token') ?? '').trim() : '';
  if (notionTool && !notionToken) {
    res.status(400).json({ ok: false, error: 'Connect Notion first.' });
    return;
  }

  // Per-role memory: a brand/context note the user set once. Injected so the
  // role remembers who they are across runs (the thing that makes it a worker,
  // not a one-shot GPT).
  const memory = (kvGet(`role.${role.id}.memory`) ?? '').trim();
  const memoryBlock = memory
    ? `\n\nWhat you remember about this user (use it; don't ask again):\n${memory}`
    : '';
  const systemPrompt = role.soul + memoryBlock + (notionToken ? NOTION_PROCEDURE : '');
  try {
    const sessionId = await createWorkSession({
      systemPrompt,
      ...(notionToken ? { notionToken } : {}),
      roleRun: true, // exactly the role's declared tools — no file/web/shell.
      // No folders: the role never touches the user's computer — it works only in
      // the tools you connected. Delete tears the run down.
    });
    await sendWorkMessage(sessionId, task);
    activeRuns.set(sessionId, { roleId: role.id, startedAt: Date.now() });
    res.json({ ok: true, runId: sessionId });
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : 'Run failed to start.' });
  }
});

/** Proxy the runtime's SSE turn events to the browser for this run. */
rolesRouter.get('/:id/run/:runId/events', (req, res) => {
  const runId = String(req.params.runId);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  const send = (obj: unknown) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch {
      /* client gone */
    }
  };
  const unsub = subscribeWorkEvents(
    runId,
    (event) => {
      send(event);
      if (event.type === 'done') {
        try {
          res.end();
        } catch {
          /* already closed */
        }
      }
    },
    (err) => {
      send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      try {
        res.end();
      } catch {
        /* already closed */
      }
    },
  );
  req.on('close', () => unsub());
});

/** The deliverable for review (Notion database URL + row count), if any yet. */
rolesRouter.get('/:id/run/:runId/result', async (req, res) => {
  const info = await getWorkspaceInfo(String(req.params.runId));
  res.json({ ok: true, deliverable: info?.notionDeliverable ?? null });
});

/** Kill-switch: tear the run down. "Fire the worker" — the work stays in the tool. */
rolesRouter.delete('/:id/run/:runId', async (req, res) => {
  const runId = String(req.params.runId);
  try {
    await stopWorkSession(runId);
  } catch {
    /* best-effort: the session may already be gone */
  }
  activeRuns.delete(runId);
  res.json({ ok: true });
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
        connectedWorkspace: toolWorkspace(t.id),
      })),
      egressAllowlist: role.egressAllowlist,
      definitionOfDone: role.definitionOfDone,
      memory: (kvGet(`role.${role.id}.memory`) ?? '').trim(),
    },
  });
});

/** Save (or clear) the per-role brand/context memory the user types once. */
rolesRouter.post('/:id/memory', (req, res) => {
  const role = getRole(String(req.params.id));
  if (!role) {
    res.status(404).json({ ok: false, error: 'Unknown role.' });
    return;
  }
  const note = String(req.body?.note ?? '').trim().slice(0, 4000);
  if (note) kvSet(`role.${role.id}.memory`, note);
  else kvDelete(`role.${role.id}.memory`);
  res.json({ ok: true, saved: Boolean(note) });
});
