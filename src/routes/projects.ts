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
import { chats, projects, projectFacts, projectSkills, projectSecrets, tasks, enrichFactsWithSourceChatTitles, enrichFactWithSourceChatTitle, enrichSkillsWithSourceChatTitles, enrichSkillWithSourceChatTitle } from '../services/store';
import { chatStatus } from '../services/chatStatus';
import { wsHub } from '../services/wsHub';
import { openclaw } from '../services/openclaw';
import { probeGateway } from '../services/gatewayProbe';
import { mountProjectTasksRoutes } from './tasks';
import { listCharacters, isKnownCharacter } from '../services/characters';
import { createTask } from '../services/taskRunner';

export const projectsRouter: Router = Router();

/** Fallback agent for new chats (mirrors routes/chats.ts). */
const DEFAULT_AGENT = 'openclaw/default';
mountProjectTasksRoutes(projectsRouter);

function wantsJson(req: import('express').Request): boolean {
  return (
    req.headers['content-type']?.includes('application/json') ||
    req.headers.accept?.includes('application/json')
  ) ?? false;
}

/* ---------------- project CRUD ---------------- */

projectsRouter.get('/', async (_req, res) => {
  const allProjects = projects.list();
  const projectRows = projects.listWithMetrics().map((row) => ({
    project: row.project,
    chatCount: row.chatTotal,
    msgs14: row.messages14d,
    chats14: row.chats14d,
  }));
  const { gatewayUp, agentsError } = await probeGateway('projects');
  res.render('projects', {
    chats: chats.list(),
    workingIds: chatStatus.workingIds(),
    allProjects,
    hasAnyTasks: tasks.hasAny(),
    taskStatusSignals: tasks.statusSignals(),
    projectRows,
    activeChat: null,
    activeProject: null,
    activeProjectsList: true,
    gatewayUp,
    agentsError,
    openclawBaseUrl: openclaw.baseUrl,
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
  } else if (req.body?.redirect === 'launcher') {
    // Created from the header switcher's "+" — drop straight into the new
    // project's launcher so the user can start a chat in it right away.
    res.redirect(`/?project=${project.id}`);
  } else {
    res.redirect(`/projects/${project.id}`);
  }
});

projectsRouter.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const project = projects.get(id);
  if (!project) {
    // Stale link / deleted project → home, not a dead-end 404 page.
    res.redirect('/');
    return;
  }
  const linkGroups = listProjectLinkGroups(id);
  res.render('project', {
    chats: chats.list(),
    workingIds: chatStatus.workingIds(),
    hasAnyTasks: tasks.hasAny(),
    taskStatusSignals: tasks.statusSignals(),
    project,
    projectChats: chats.listByProject(id),
    facts: enrichFactsWithSourceChatTitles(projectFacts.listByProject(id)),
    skills: enrichSkillsWithSourceChatTitles(projectSkills.listForProject(id)),
    projectSecrets: projectSecrets.listMetaByProject(id),
    projectWebLinks: linkGroups.web,
    projectFileLinks: linkGroups.files,
    allProjects: projects.list(),
    characters: listCharacters(),
    // The project's tasks — the Team tab shows each specialist's current work.
    projectTasks: tasks.list({ projectId: id }),
    activeChat: null,
    activeProject: project,
  });
});

/**
 * POST /projects/:id/team/:characterId/tasks — delegate a task to a specialist
 * from the project's Team tab. Creates a hidden context container chat (never
 * shown to the user) + a task assigned to the specialist, then lands on the
 * task's work view. The task runs (on the work view) as the specialist — its
 * execution inherits the persona + tool allowlist (see taskRunner).
 */
projectsRouter.post('/:id/team/:characterId/tasks', async (req, res) => {
  const id = Number(req.params.id);
  const project = projects.get(id);
  if (!project) {
    res.redirect('/');
    return;
  }
  if (!isKnownCharacter(req.params.characterId)) {
    res.status(404).send('unknown specialist');
    return;
  }
  const goal = String(req.body?.goal ?? '').trim();
  if (!goal) {
    res.redirect(`/projects/${id}`);
    return;
  }
  // Hidden context container — kind 'task_execution' is never listed in the
  // sidebar, so delegating never spawns a visible chat.
  const src = chats.create(DEFAULT_AGENT, id, { chatKind: 'task_execution', title: 'Delegation' });
  try {
    const task = await createTask({
      sourceChatId: src.id,
      title: '',
      goal,
      characterId: req.params.characterId,
      generatePlan: false,
    });
    res.redirect(303, `/tasks/${task.id}`);
  } catch (err) {
    res.status(500).send(err instanceof Error ? err.message : String(err));
  }
});

/**
 * POST /projects/:id/team/:characterId/chat — open the specialist's themed chat.
 * Reuses their most recent interactive chat in this project, or opens a new one
 * (?fresh=1 forces new). The chat runs in Work mode (iClaw runtime) so the
 * specialist's persona + playbook + tool allowlist + create_task all apply.
 */
projectsRouter.post('/:id/team/:characterId/chat', (req, res) => {
  const id = Number(req.params.id);
  const project = projects.get(id);
  if (!project) {
    res.redirect('/');
    return;
  }
  const cid = req.params.characterId;
  if (!isKnownCharacter(cid)) {
    res.status(404).send('unknown specialist');
    return;
  }
  const fresh = req.body?.fresh === '1' || req.body?.fresh === true;
  const existing = fresh
    ? undefined
    : chats
        .listByProject(id)
        .filter((c) => c.character_id === cid && c.chat_kind !== 'task_execution')
        .sort((a, b) => b.id - a.id)[0];
  let chatId: number;
  if (existing) {
    chatId = existing.id;
  } else {
    const chat = chats.create(DEFAULT_AGENT, id, { chatKind: 'draft' });
    chats.setCharacter(chat.id, cid);
    chats.setChatMode(chat.id, 'work');
    chatId = chat.id;
  }
  res.redirect(`/chats/${chatId}`);
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
    // Already gone → mirror the success path back to the projects list.
    res.redirect('/projects');
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

// Manually add a fact to the project Brain — the "remember this" quick-add from a
// chat. Distinct from the LLM-proposed fact-suggestion inbox: this is a direct,
// user-authored fact, persisted immediately.
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
  const rawChat = Number(req.body?.sourceChatId);
  const sourceChatId = Number.isFinite(rawChat) && rawChat > 0 ? rawChat : null;
  const fact = projectFacts.append({ projectId, content, sourceChatId });
  const enriched = enrichFactWithSourceChatTitle(fact);
  wsHub.broadcastAll({ type: 'project-fact-added', projectId, fact: enriched });
  res.status(201).json(enriched);
});

/* ---------------- skills (procedural memory; edit/delete here) ---------------- */

/** Skill belongs to the project when project-scoped, or is global (project_id null). */
function skillVisibleToProject(
  skill: { project_id: number | null } | undefined,
  projectId: number,
): boolean {
  return !!skill && (skill.project_id === projectId || skill.project_id === null);
}

/** Active skills (project + global), index info only. */
projectsRouter.get('/:id/skills', (req, res) => {
  const id = Number(req.params.id);
  if (!projects.get(id)) {
    res.status(404).json({ error: 'project not found' });
    return;
  }
  res.json({ skills: enrichSkillsWithSourceChatTitles(projectSkills.listForProject(id)) });
});

/** Full skill body (for the view/edit modal). */
projectsRouter.get('/:id/skills/:skillId', (req, res) => {
  const projectId = Number(req.params.id);
  const skillId = Number(req.params.skillId);
  const skill = projectSkills.get(skillId);
  if (!projects.get(projectId) || !skillVisibleToProject(skill, projectId)) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ skill: enrichSkillWithSourceChatTitle(skill!) });
});

projectsRouter.patch('/:id/skills/:skillId', (req, res) => {
  const projectId = Number(req.params.id);
  const skillId = Number(req.params.skillId);
  const skill = projectSkills.get(skillId);
  if (!projects.get(projectId) || !skillVisibleToProject(skill, projectId)) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const patch: { name?: string; description?: string; body?: string; tags?: string[] | null } = {};
  if (typeof req.body?.name === 'string' && req.body.name.trim()) patch.name = req.body.name;
  if (typeof req.body?.description === 'string' && req.body.description.trim())
    patch.description = req.body.description;
  if (typeof req.body?.body === 'string' && req.body.body.trim()) patch.body = req.body.body;
  if (Array.isArray(req.body?.tags)) {
    const tags = req.body.tags.filter((t: unknown): t is string => typeof t === 'string');
    patch.tags = tags.length > 0 ? tags : null;
  }
  try {
    projectSkills.update(skillId, patch);
    const updated = projectSkills.get(skillId)!;
    wsHub.broadcastAll({
      type: 'project-skill-updated',
      projectId,
      skill: enrichSkillWithSourceChatTitle(updated),
    });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'update failed' });
  }
});

projectsRouter.post('/:id/skills/:skillId/delete', (req, res) => {
  const projectId = Number(req.params.id);
  const skillId = Number(req.params.skillId);
  const skill = projectSkills.get(skillId);
  if (!skillVisibleToProject(skill, projectId)) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  projectSkills.remove(skillId);
  wsHub.broadcastAll({ type: 'project-skill-deleted', projectId, skillId });
  if (wantsJson(req)) res.json({ id: skillId, deleted: true });
  else res.redirect(`/projects/${projectId}`);
});
