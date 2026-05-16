import { Router } from 'express';
import { chats, projects } from '../services/store';
import { openclaw } from '../services/openclaw';
import { openclawWs } from '../services/openclawWs';
import { chatStatus } from '../services/chatStatus';

export const indexRouter: Router = Router();

indexRouter.get('/', async (req, res) => {
  const list = chats.list();
  const allProjects = projects.list();
  const gatewayUp = await openclaw.health();

  // ?project=<id> — preselect a project for the new draft chat
  const projectQuery = typeof req.query.project === 'string' ? Number(req.query.project) : NaN;
  const preselectedProject =
    Number.isFinite(projectQuery) && projectQuery > 0
      ? projects.get(projectQuery) ?? null
      : null;

  let agents: { id: string }[] = [];
  let agentsError: string | null = null;
  try {
    const raw = await openclawWs.listAgents();
    agents = [{ id: 'openclaw/default' }, ...raw.map((a) => ({ id: `openclaw/${a.id}` }))];
  } catch (err) {
    agentsError = err instanceof Error ? err.message : String(err);
  }

  res.render('index', {
    chats: list,
    allProjects,
    preselectedProject,
    activeChat: null,
    activeProject: preselectedProject,
    gatewayUp,
    agents,
    agentsError,
    defaultAgent: 'openclaw/default',
    openclawBaseUrl: openclaw.baseUrl,
    workingIds: chatStatus.workingIds(),
  });
});
