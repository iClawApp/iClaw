/**
 * Project + project-facts CRUD.
 *
 * HTTP-form style (POST + 302 redirect) for mutations so vanilla HTML forms
 * work. JSON variants (PATCH/POST application/json) are also accepted for the
 * client-side edit affordances on the project page.
 *
 * Every mutation broadcasts a server-side WS event so other tabs sync.
 */

import { Router } from 'express';
import { chats, projects, projectFacts } from '../services/store';
import { chatStatus } from '../services/chatStatus';
import { wsHub } from '../services/wsHub';

export const projectsRouter: Router = Router();

function wantsJson(req: import('express').Request): boolean {
  return (
    req.headers['content-type']?.includes('application/json') ||
    req.headers.accept?.includes('application/json')
  ) ?? false;
}

/* ---------------- project CRUD ---------------- */

projectsRouter.post('/', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) {
    res.status(400).json({ error: 'name required' });
    return;
  }
  const description = req.body?.description
    ? String(req.body.description).trim() || null
    : null;
  const project = projects.create(name, description);
  wsHub.broadcastAll({ type: 'project-created', project });
  if (wantsJson(req)) {
    res.json(project);
  } else {
    res.redirect(`/projects/${project.id}`);
  }
});

projectsRouter.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const project = projects.get(id);
  if (!project) {
    res.status(404).send('project not found');
    return;
  }
  res.render('project', {
    chats: chats.list(),
    workingIds: chatStatus.workingIds(),
    project,
    projectChats: chats.listByProject(id),
    facts: projectFacts.listByProject(id),
    allProjects: projects.list(),
    activeChat: null,
    activeProject: project,
  });
});

projectsRouter.post('/:id/rename', (req, res) => {
  const id = Number(req.params.id);
  if (!projects.get(id)) {
    res.status(404).json({ error: 'project not found' });
    return;
  }
  const name = String(req.body?.name ?? '').trim();
  if (!name) {
    res.status(400).json({ error: 'name required' });
    return;
  }
  projects.rename(id, name);
  const updated = projects.get(id)!;
  wsHub.broadcastAll({ type: 'project-updated', project: updated });
  if (wantsJson(req)) res.json(updated);
  else res.redirect(`/projects/${id}`);
});

projectsRouter.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!projects.get(id)) {
    res.status(404).json({ error: 'project not found' });
    return;
  }
  if (typeof req.body?.name === 'string') {
    const name = req.body.name.trim();
    if (name) projects.rename(id, name);
  }
  if ('description' in (req.body ?? {})) {
    const desc =
      typeof req.body.description === 'string' ? req.body.description.trim() : null;
    projects.setDescription(id, desc || null);
  }
  const updated = projects.get(id)!;
  wsHub.broadcastAll({ type: 'project-updated', project: updated });
  res.json(updated);
});

projectsRouter.post('/:id/delete', (req, res) => {
  const id = Number(req.params.id);
  if (!projects.get(id)) {
    res.status(404).send('project not found');
    return;
  }
  const detachedChatIds = chats.listByProject(id).map((c) => c.id);
  projects.remove(id);
  wsHub.broadcastAll({ type: 'project-deleted', projectId: id });
  for (const chatId of detachedChatIds) {
    wsHub.broadcastAll({
      type: 'chat-updated',
      chatId,
      projectId: null,
      projectName: null,
    });
  }
  res.redirect('/');
});

/* ---------------- facts CRUD ---------------- */

projectsRouter.post('/:id/facts', (req, res) => {
  const projectId = Number(req.params.id);
  if (!projects.get(projectId)) {
    res.status(404).json({ error: 'project not found' });
    return;
  }
  const content = String(req.body?.content ?? '').trim();
  if (!content) {
    res.status(400).json({ error: 'content required' });
    return;
  }
  const sourceChatId =
    typeof req.body?.sourceChatId === 'number' ? req.body.sourceChatId : null;
  const sourceMessageId =
    typeof req.body?.sourceMessageId === 'number' ? req.body.sourceMessageId : null;
  const fact = projectFacts.append({
    projectId,
    content,
    sourceChatId,
    sourceMessageId,
  });
  wsHub.broadcastAll({ type: 'project-fact-added', projectId, fact });
  if (wantsJson(req)) res.json(fact);
  else res.redirect(`/projects/${projectId}`);
});

projectsRouter.patch('/:id/facts/:factId', (req, res) => {
  const projectId = Number(req.params.id);
  const factId = Number(req.params.factId);
  if (!projects.get(projectId)) {
    res.status(404).json({ error: 'project not found' });
    return;
  }
  const fact = projectFacts.get(factId);
  if (!fact || fact.project_id !== projectId) {
    res.status(404).json({ error: 'fact not found' });
    return;
  }
  const content = String(req.body?.content ?? '').trim();
  if (!content) {
    res.status(400).json({ error: 'content required' });
    return;
  }
  projectFacts.edit(factId, content);
  const updated = projectFacts.get(factId)!;
  wsHub.broadcastAll({ type: 'project-fact-updated', projectId, fact: updated });
  res.json(updated);
});

projectsRouter.post('/:id/facts/:factId/delete', (req, res) => {
  const projectId = Number(req.params.id);
  const factId = Number(req.params.factId);
  const fact = projectFacts.get(factId);
  if (!fact || fact.project_id !== projectId) {
    res.status(404).send('fact not found');
    return;
  }
  projectFacts.remove(factId);
  wsHub.broadcastAll({ type: 'project-fact-deleted', projectId, factId });
  if (wantsJson(req)) res.json({ id: factId, deleted: true });
  else res.redirect(`/projects/${projectId}`);
});
