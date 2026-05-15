import { Router } from 'express';
import { projects } from '../services/store';
import { openclaw } from '../services/openclaw';

export const indexRouter: Router = Router();

indexRouter.get('/', async (_req, res) => {
  const list = projects.list();
  const gatewayUp = await openclaw.health();
  res.render('index', {
    projects: list,
    project: null,
    tasks: [],
    activeTask: null,
    gatewayUp,
    openclawBaseUrl: openclaw.baseUrl,
  });
});
