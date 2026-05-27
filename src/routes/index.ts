import { Router } from 'express';
import { chats, projectSecrets, projects, tasks } from '../services/store';
import { openclaw } from '../services/openclaw';
import { probeGateway } from '../services/gatewayProbe';
import { chatStatus } from '../services/chatStatus';
import { shouldShowSendHint } from '../services/sendHint';

export const indexRouter: Router = Router();

/** Draft composer — secret name check before the chat row exists. */
indexRouter.get('/api/secrets/check-label', (req, res) => {
  res.json({ available: projectSecrets.isLabelAvailable(String(req.query.label ?? '')) });
});

indexRouter.get('/', async (req, res) => {
  const list = chats.list();
  const allProjects = projects.list();

  // ?project=<id> — preselect a project for the new draft chat
  const projectQuery = typeof req.query.project === 'string' ? Number(req.query.project) : NaN;
  const preselectedProject =
    Number.isFinite(projectQuery) && projectQuery > 0
      ? projects.get(projectQuery) ?? null
      : null;

  const { gatewayUp, agents, agentsError, gatewayStatus } = await probeGateway('index');

  res.render('index', {
    chats: list,
    allProjects,
    hasAnyTasks: tasks.hasAny(),
    taskStatusSignals: tasks.statusSignals(),
    preselectedProject,
    activeChat: null,
    activeProject: preselectedProject,
    gatewayUp,
    gatewayStatus,
    agents,
    agentsError,
    defaultAgent: 'openclaw/default',
    openclawBaseUrl: openclaw.baseUrl,
    workingIds: chatStatus.workingIds(),
    sendHintShow: shouldShowSendHint(),
  });
});
