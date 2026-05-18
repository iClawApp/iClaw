/**
 * Project CRUD + project-facts edit/delete (facts are created from chat flows).
 * Project page has separate Links (http) and Files (paths, file://) mined from messages.
 *
 * HTTP-form style (POST + 302 redirect) for mutations so vanilla HTML forms
 * work. JSON variants (PATCH) for inline edits on the project page.
 *
 * Every mutation broadcasts a server-side WS event so other tabs sync.
 */

import { Router } from 'express';
import { listProjectLinkGroups } from '../services/projectLinks';
import { chats, projects, projectFacts, projectSecrets, enrichFactsWithSourceChatTitles, enrichFactWithSourceChatTitle } from '../services/store';
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

projectsRouter.get('/', (_req, res) => {
  const allProjects = projects.list();
  const projectRows = projects.listWithMetrics().map((row) => ({
    project: row.project,
    chatCount: row.chatTotal,
    msgs14: row.messages14d,
    chats14: row.chats14d,
  }));
  res.render('projects', {
    chats: chats.list(),
    workingIds: chatStatus.workingIds(),
    allProjects,
    projectRows,
    activeChat: null,
    activeProject: null,
    activeProjectsList: true,
  });
});

projectsRouter.post('/', (req, res) => {
  const name = String(req.body?.name ?? '').trim();
  if (!name) {
    if (wantsJson(req)) {
      res.status(400).json({ error: 'name required' });
    } else {
      res.redirect(303, '/projects');
    }
    return;
  }
  const project = projects.create(name, null);
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
  const linkGroups = listProjectLinkGroups(id);
  res.render('project', {
    chats: chats.list(),
    workingIds: chatStatus.workingIds(),
    project,
    projectChats: chats.listByProject(id),
    facts: enrichFactsWithSourceChatTitles(projectFacts.listByProject(id)),
    projectSecrets: projectSecrets.listMetaByProject(id),
    projectWebLinks: linkGroups.web,
    projectFileLinks: linkGroups.files,
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
  const patch: { emoji?: unknown; color?: unknown } = {};
  if (typeof req.body?.name === 'string') {
    const name = req.body.name.trim();
    if (name) projects.rename(id, name);
  }
  if (req.body?.logoEmoji !== undefined && req.body?.logoEmoji !== null) {
    patch.emoji = req.body.logoEmoji;
  }
  if (req.body?.logoColor !== undefined && req.body?.logoColor !== null) {
    patch.color = req.body.logoColor;
  }
  if (patch.emoji !== undefined || patch.color !== undefined) {
    projects.setLogoAppearance(id, patch);
  }
  const updated = projects.get(id)!;
  wsHub.broadcastAll({ type: 'project-updated', project: updated });
  res.json(updated);
});

/** Composer attach menu — metadata only, no secret values. */
projectsRouter.get('/:id/secrets/picker', (req, res) => {
  const projectId = Number(req.params.id);
  if (!projects.get(projectId)) {
    res.status(404).json({ error: 'project not found' });
    return;
  }
  res.json(projectSecrets.listForComposerPicker(projectId));
});

/** Map a secret (any project) to a row usable in this project's chat transcript. */
projectsRouter.post('/:id/secrets/:secretId/use-in-chat', (req, res) => {
  const projectId = Number(req.params.id);
  const secretId = Number(req.params.secretId);
  if (!projects.get(projectId)) {
    res.status(404).json({ error: 'project not found' });
    return;
  }
  try {
    const row = projectSecrets.resolveForChat({ chatId: null, projectId }, secretId);
    res.json({
      id: row.id,
      label: row.label,
      value_length: row.value.length,
    });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'secret' });
  }
});

/** Reveal secret value on the project page (same project only). */
projectsRouter.get('/:id/secrets/:secretId/value', (req, res) => {
  const projectId = Number(req.params.id);
  const secretId = Number(req.params.secretId);
  const sec = projectSecrets.get(secretId);
  if (!projects.get(projectId) || !sec || sec.project_id !== projectId) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.type('application/json').json({ value: sec.value });
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
    chats.touch(chatId);
    wsHub.broadcastAll({
      type: 'chat-updated',
      chatId,
      projectId: null,
      projectName: null,
      updatedAt: chats.get(chatId)!.updated_at,
    });
  }
  res.redirect('/projects');
});

/* ---------------- facts (from chats only; edit/delete here) ---------------- */

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
  wsHub.broadcastAll({
    type: 'project-fact-updated',
    projectId,
    fact: enrichFactWithSourceChatTitle(updated),
  });
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
