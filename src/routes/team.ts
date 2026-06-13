import { Router } from 'express';
import { chats, projects, tasks } from '../services/store';
import { chatStatus } from '../services/chatStatus';
import { listCharacters, getCharacter, isKnownCharacter } from '../services/characters';

/**
 * Top-level Team flow: a "Team" button → pick a project → that project's roster
 * of specialists → a big brief composer to delegate a task. Delegation itself
 * reuses POST /projects/:id/team/:characterId/tasks (see routes/projects.ts).
 * One route, three states driven by query params (projectId, specialist).
 */
export const teamRouter: Router = Router();

teamRouter.get('/', (req, res) => {
  const allProjects = projects.list();

  const pidRaw = typeof req.query.projectId === 'string' ? Number(req.query.projectId) : NaN;
  // Land straight in a project's team (the first, if none given) — no "pick a
  // project" step each time; you swipe between projects from there.
  let selectedProject = Number.isFinite(pidRaw) ? projects.get(pidRaw) ?? null : null;
  if (!selectedProject && allProjects.length) selectedProject = allProjects[0]!;

  const sidRaw = typeof req.query.specialist === 'string' ? req.query.specialist : '';
  const selectedSpecialist =
    selectedProject && isKnownCharacter(sidRaw) ? getCharacter(sidRaw) : null;

  res.render('team', {
    // Sidebar locals.
    chats: chats.list(),
    workingIds: chatStatus.workingIds(),
    allProjects,
    hasAnyTasks: tasks.hasAny(),
    taskStatusSignals: tasks.statusSignals(),
    activeChat: null,
    activeProject: selectedProject,
    activeTeam: true,
    // Page locals.
    projects: allProjects,
    selectedProject,
    selectedSpecialist,
    specialists: listCharacters().filter((c) => c.id !== 'generalist'),
    projectTasks: selectedProject ? tasks.list({ projectId: selectedProject.id }) : [],
  });
});
