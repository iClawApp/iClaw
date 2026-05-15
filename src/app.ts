import express from 'express';
import path from 'node:path';

import { indexRouter } from './routes/index';
import { chatsRouter } from './routes/chats';
import { agentsRouter } from './routes/sessions';
import { mediaRouter } from './routes/media';

export function createApp(): express.Express {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.resolve(__dirname, '../views'));

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(express.static(path.resolve(__dirname, '../public')));

  app.use('/', indexRouter);
  app.use('/chats', chatsRouter);
  app.use('/api/agents', agentsRouter);
  app.use('/media', mediaRouter);

  app.use(
    (
      err: Error,
      req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error(err);
      if (res.headersSent) return;
      const wantsJson = req.headers.accept?.includes('application/json');
      res.status(500);
      if (wantsJson) res.json({ error: err.message });
      else res.type('text/plain').send(`Error: ${err.message}`);
    },
  );

  return app;
}
