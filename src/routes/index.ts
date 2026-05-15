import { Router } from 'express';
import { chats } from '../services/store';
import { openclaw } from '../services/openclaw';
import { openclawWs } from '../services/openclawWs';
import { chatStatus } from '../services/chatStatus';

export const indexRouter: Router = Router();

indexRouter.get('/', async (_req, res) => {
  const list = chats.list();
  const gatewayUp = await openclaw.health();
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
    activeChat: null,
    gatewayUp,
    agents,
    agentsError,
    defaultAgent: 'openclaw/default',
    openclawBaseUrl: openclaw.baseUrl,
    workingIds: chatStatus.workingIds(),
  });
});
