import { Router } from 'express';
import { projects, tasks, notes, messages } from '../services/store';
import { openclaw } from '../services/openclaw';
import type { ChatMessage } from '../services/openclaw';
import type { Note } from '../types';

export const tasksRouter: Router = Router();

const DEFAULT_AGENT = 'openclaw/default';

function buildSystemPrompt(taskTitle: string, pinned: Note[]): string | null {
  const body = pinned
    .filter((n) => n.pinned === 1)
    .map((n) => `- ${n.body}`)
    .join('\n');
  if (!body) return null;
  return `You are helping with the task: "${taskTitle}". The user has pinned the following context notes that should inform every response:\n${body}`;
}

tasksRouter.post('/', (req, res) => {
  const projectId = Number(req.body.project_id);
  const title = String(req.body.title ?? '').trim();
  if (!projectId || !title) {
    res.status(400).send('project_id and title required');
    return;
  }
  const task = tasks.create(projectId, title);
  res.redirect(`/tasks/${task.id}`);
});

tasksRouter.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const task = tasks.get(id);
    if (!task) {
      res.status(404).send('task not found');
      return;
    }
    const project = projects.get(task.project_id);
    let agents: { id: string }[] = [];
    let agentsError: string | null = null;
    try {
      agents = await openclaw.listAgents();
    } catch (err) {
      agentsError = err instanceof Error ? err.message : String(err);
    }
    res.render('task', {
      projects: projects.list(),
      project,
      tasks: tasks.listByProject(task.project_id),
      activeTask: task,
      notes: notes.listByTask(id),
      taskMessages: messages.listByTask(id),
      agents,
      agentsError,
      openclawBaseUrl: openclaw.baseUrl,
      defaultAgent: DEFAULT_AGENT,
    });
  } catch (err) {
    next(err);
  }
});

tasksRouter.post('/:id/status', (req, res) => {
  const id = Number(req.params.id);
  tasks.setStatus(id, String(req.body.status ?? 'open'));
  res.redirect(`/tasks/${id}`);
});

tasksRouter.post('/:id/delete', (req, res) => {
  const id = Number(req.params.id);
  const task = tasks.get(id);
  tasks.remove(id);
  res.redirect(task ? `/projects/${task.project_id}` : '/');
});

tasksRouter.post('/:id/start-chat', (req, res) => {
  const id = Number(req.params.id);
  const agent = String(req.body.agent ?? '').trim() || DEFAULT_AGENT;
  tasks.startChat(id, agent);
  res.redirect(`/tasks/${id}`);
});

tasksRouter.post('/:id/notes', (req, res) => {
  const id = Number(req.params.id);
  const body = String(req.body.body ?? '').trim();
  if (!body) {
    res.redirect(`/tasks/${id}`);
    return;
  }
  notes.create(id, body, true);
  res.redirect(`/tasks/${id}`);
});

tasksRouter.post('/:id/notes/:noteId/delete', (req, res) => {
  notes.remove(Number(req.params.noteId));
  res.redirect(`/tasks/${req.params.id}`);
});

tasksRouter.post('/:id/notes/:noteId/toggle', (req, res) => {
  notes.togglePin(Number(req.params.noteId));
  res.redirect(`/tasks/${req.params.id}`);
});

// JSON API used by the chat client
tasksRouter.get('/:id/messages', (req, res) => {
  const id = Number(req.params.id);
  if (!tasks.get(id)) {
    res.status(404).json({ error: 'task not found' });
    return;
  }
  res.json(messages.listByTask(id));
});

tasksRouter.post('/:id/messages', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const task = tasks.get(id);
    if (!task) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    if (!task.openclaw_session_id || !task.agent) {
      res.status(400).json({ error: 'chat not started — pick an agent first' });
      return;
    }
    const content = String(req.body?.content ?? '').trim();
    if (!content) {
      res.status(400).json({ error: 'content required' });
      return;
    }

    messages.append(id, 'user', content);

    const history: ChatMessage[] = [];
    const sys = buildSystemPrompt(task.title, notes.listByTask(id));
    if (sys) history.push({ role: 'system', content: sys });
    for (const m of messages.listByTask(id)) {
      if (m.role === 'user' || m.role === 'assistant' || m.role === 'system') {
        history.push({ role: m.role, content: m.content });
      }
    }

    const result = await openclaw.chat({
      model: task.agent,
      sessionKey: task.openclaw_session_id,
      messages: history,
    });

    const stored = messages.append(id, 'assistant', result.content, result.finish_reason);
    res.json(stored);
  } catch (err) {
    next(err);
  }
});
