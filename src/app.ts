import express from 'express';
import path from 'node:path';

import { indexRouter } from './routes/index';
import { projectsRouter } from './routes/projects';
import { tasksRouter } from './routes/tasks';
import { agentsRouter } from './routes/sessions';

export function createApp(): express.Express {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.resolve(__dirname, '../views'));

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(express.static(path.resolve(__dirname, '../public')));

  app.use('/', indexRouter);
  app.use('/projects', projectsRouter);
  app.use('/tasks', tasksRouter);
  app.use('/api/agents', agentsRouter);

  app.use(
    (
      err: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error(err);
      if (res.headersSent) return;
      const wantsJson = _req.headers.accept?.includes('application/json');
      res.status(500);
      if (wantsJson) res.json({ error: err.message });
      else res.type('text/plain').send(`Error: ${err.message}`);
    },
  );

  return app;
}
