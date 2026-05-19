/**
 * Agent Task Board — HTTP routes for tasks, board, run/resume.
 */

import { Router } from 'express';
import { openclaw } from '../services/openclaw';
import { openclawWs } from '../services/openclawWs';
import { chatStatus } from '../services/chatStatus';
import {
  chats,
  enrichTaskWithSteps,
  messages,
  projects,
  taskContextSnapshots,
  tasks,
  taskSteps,
} from '../services/store';
import {
  approvePlan,
  completeTask,
  createTask,
  groupTasksForBoard,
  resumeTask,
  runTask,
} from '../services/taskRunner';
import type { TaskContextSnapshotPayload, TaskStepActor } from '../types';

export const tasksRouter: Router = Router();

function wantsJson(req: import('express').Request): boolean {
  return (
    req.headers['content-type']?.includes('application/json') ||
    req.headers.accept?.includes('application/json') ||
    false
  );
}

function snapshotPreview(payload: TaskContextSnapshotPayload) {
  return {
    capturedAt: payload.capturedAt,
    messageCount: payload.messages.length,
    projectFactsCount: payload.projectFacts.length,
    attachedFiles: payload.attachedFiles.map((f) => ({
      fileName: f.fileName,
      mimeType: f.mimeType,
    })),
    secretRefs: payload.secretRefs.map((s) => ({ id: s.id, label: s.label })),
    messages: payload.messages.slice(-8).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content.slice(0, 400),
      createdAt: m.createdAt,
    })),
  };
}

async function viewLocals() {
  const gatewayUp = await openclaw.health();
  let agents: { id: string }[] = [];
  let agentsError: string | null = null;
  try {
    const raw = await openclawWs.listAgents();
    agents = [{ id: 'openclaw/default' }, ...raw.map((a) => ({ id: `openclaw/${a.id}` }))];
  } catch (err) {
    agentsError = err instanceof Error ? err.message : String(err);
  }
  return {
    chats: chats.list(),
    workingIds: chatStatus.workingIds(),
    allProjects: projects.list(),
    gatewayUp,
    agents,
    agentsError,
    defaultAgent: 'openclaw/default',
    openclawBaseUrl: openclaw.baseUrl,
  };
}

tasksRouter.get('/', async (req, res) => {
  const orphanOnly = req.query.orphan === '1' || req.query.orphan === 'true';
  const projectIdRaw = req.query.projectId;
  let taskList = tasks.list(
    orphanOnly
      ? { orphanOnly: true }
      : projectIdRaw != null && projectIdRaw !== ''
        ? { projectId: Number(projectIdRaw) }
        : undefined,
  );
  const enriched = taskList.map(enrichTaskWithSteps);
  const board = groupTasksForBoard(enriched);

  if (wantsJson(req)) {
    res.json({ tasks: enriched, board });
    return;
  }

  const locals = await viewLocals();
  res.render('tasks', {
    ...locals,
    tasks: enriched,
    board,
    orphanOnly,
    projectId: projectIdRaw ? Number(projectIdRaw) : null,
    activeChat: null,
    activeProject: null,
    activeTasksList: true,
  });
});

tasksRouter.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  const task = tasks.get(id);
  if (!task) {
    res.status(404).send('Task not found');
    return;
  }
  const enriched = enrichTaskWithSteps(task);
  const snap = taskContextSnapshots.get(task.context_snapshot_id);
  const preview = snap ? snapshotPreview(taskContextSnapshots.parsePayload(snap)) : null;
  const execMessages = task.execution_chat_id
    ? messages.listByChat(task.execution_chat_id)
    : [];

  if (wantsJson(req)) {
    res.json({ task: enriched, snapshotPreview: preview, executionLog: execMessages });
    return;
  }

  const locals = await viewLocals();
  const srcChat = chats.get(task.source_chat_id);
  res.render('task', {
    ...locals,
    task: enriched,
    snapshotPreview: preview,
    executionLog: execMessages,
    sourceChat: srcChat,
    activeChat: null,
    activeProject: task.project_id ? projects.get(task.project_id) : null,
    activeTasksList: true,
    defaultAgent: task.agent ?? locals.defaultAgent,
  });
});

tasksRouter.get('/:id/execution-log', (req, res) => {
  const task = tasks.get(Number(req.params.id));
  if (!task?.execution_chat_id) {
    res.json({ messages: [] });
    return;
  }
  res.json({ messages: messages.listByChat(task.execution_chat_id) });
});

tasksRouter.post('/', async (req, res) => {
  const sourceChatId = Number(req.body?.sourceChatId ?? req.body?.source_chat_id);
  const title = String(req.body?.title ?? '').trim();
  const goal = String(req.body?.goal ?? '').trim();
  if (!sourceChatId || !goal) {
    res.status(400).json({ error: 'sourceChatId and goal required' });
    return;
  }
  const generatePlan =
    req.body?.generatePlan === true ||
    req.body?.generatePlan === 'true' ||
    req.body?.generate_plan === '1';
  let attachedFiles = req.body?.attachedFiles;
  if (typeof attachedFiles === 'string') {
    try {
      attachedFiles = JSON.parse(attachedFiles);
    } catch {
      attachedFiles = [];
    }
  }
  let secretRefIds = req.body?.secretRefIds;
  if (typeof secretRefIds === 'string') {
    try {
      secretRefIds = JSON.parse(secretRefIds);
    } catch {
      secretRefIds = [];
    }
  }

  try {
    const task = await createTask({
      sourceChatId,
      title: title || goal.slice(0, 80),
      goal,
      agent: req.body?.agent ? String(req.body.agent) : null,
      generatePlan,
      attachedFiles: Array.isArray(attachedFiles) ? attachedFiles : [],
      secretRefIds: Array.isArray(secretRefIds)
        ? secretRefIds.map(Number).filter((n) => Number.isFinite(n))
        : [],
    });
    if (wantsJson(req)) {
      res.status(201).json({ task });
      return;
    }
    res.redirect(303, `/tasks/${task.id}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

tasksRouter.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const task = tasks.get(id);
  if (!task) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const patch: Parameters<typeof tasks.patch>[1] = {};
  if (req.body?.title != null) patch.title = String(req.body.title);
  if (req.body?.goal != null) patch.goal = String(req.body.goal);
  if (req.body?.agent != null) patch.agent = String(req.body.agent);
  if (Array.isArray(req.body?.steps)) {
    const steps = req.body.steps.map(
      (s: { actor?: string; title?: string; description?: string }) => ({
        actor: (s.actor === 'human' ? 'human' : 'agent') as TaskStepActor,
        title: String(s.title ?? '').trim(),
        description: s.description ? String(s.description) : null,
      }),
    ).filter((s: { title: string }) => s.title);
    taskSteps.replaceAll(id, steps);
  }
  const updated = tasks.patch(id, patch) ?? task;
  res.json({ task: enrichTaskWithSteps(updated) });
});

tasksRouter.post('/:id/approve-plan', (req, res) => {
  const id = Number(req.params.id);
  let steps = req.body?.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    steps = taskSteps.listByTask(id).map((s) => ({
      actor: s.actor,
      title: s.title,
      description: s.description,
    }));
  }
  if (!steps.length) {
    res.status(400).json({ error: 'add at least one step before approving' });
    return;
  }
  try {
    const task = approvePlan(
      id,
      steps.map((s: { actor: string; title: string; description?: string }) => ({
        actor: (s.actor === 'human' ? 'human' : 'agent') as TaskStepActor,
        title: String(s.title).trim(),
        description: s.description ?? null,
      })),
    );
    res.json({ task });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

tasksRouter.post('/:id/run', async (req, res) => {
  try {
    const task = await runTask(Number(req.params.id));
    res.json({ task });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

tasksRouter.post('/:id/resume', async (req, res) => {
  const humanInput = String(req.body?.humanInput ?? req.body?.content ?? '').trim();
  if (!humanInput) {
    res.status(400).json({ error: 'humanInput required' });
    return;
  }
  try {
    const task = await resumeTask(Number(req.params.id), humanInput);
    res.json({ task });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

tasksRouter.post('/:id/complete', (req, res) => {
  const status = req.body?.status === 'failed' ? 'failed' : 'done';
  try {
    const task = completeTask(Number(req.params.id), status);
    res.json({ task });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** JSON board for project Tasks tab. */
export function mountProjectTasksRoutes(router: Router): void {
  router.get('/:id/tasks', (req, res) => {
    const projectId = Number(req.params.id);
    if (!projects.get(projectId)) {
      res.status(404).json({ error: 'project not found' });
      return;
    }
    const enriched = tasks.list({ projectId }).map(enrichTaskWithSteps);
    res.json({ tasks: enriched, board: groupTasksForBoard(enriched) });
  });
}
