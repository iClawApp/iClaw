import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

import { indexRouter } from './routes/index';
import { chatsRouter } from './routes/chats';
import { projectsRouter } from './routes/projects';
import { agentsRouter } from './routes/sessions';
import { mediaRouter } from './routes/media';
import { gatewayRouter } from './routes/gateway';
import { projects } from './services/store';

import { PROJECT_LOGO_EMOJIS } from './constants/projectLogos';

/** Resolves a project-relative directory when `__dirname` or cwd is not the package root (e.g. nested monorepos, odd runners). */
function resolveProjectDir(
  markerSegments: string[],
  fallbackFromSrc: string,
): string {
  const marker = path.join(...markerSegments);
  for (const start of [__dirname, process.cwd()]) {
    let dir = path.resolve(start);
    for (let i = 0; i < 50; i++) {
      if (fs.existsSync(path.join(dir, marker))) {
        return path.join(dir, markerSegments[0]);
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return path.resolve(__dirname, fallbackFromSrc);
}

export function createApp(): express.Express {
  const app = express();

  app.use((_req, res, next) => {
    res.locals.projectLogoEmojis = PROJECT_LOGO_EMOJIS;
    res.locals.projectsMini = projects.list().map((p) => ({
      id: p.id,
      name: p.name,
      logo_emoji: p.logo_emoji,
      logo_color: p.logo_color,
    }));
    next();
  });

  app.set('view engine', 'ejs');
  app.set('views', resolveProjectDir(['views', 'index.ejs'], '../views'));

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(
    express.static(
      resolveProjectDir(['public', 'css', 'style.css'], '../public'),
    ),
  );

  app.use('/', indexRouter);
  app.use('/chats', chatsRouter);
  app.use('/projects', projectsRouter);
  app.use('/api/agents', agentsRouter);
  app.use('/api/gateway', gatewayRouter);
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
