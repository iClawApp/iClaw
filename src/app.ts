import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

import { indexRouter } from './routes/index';
import { chatsRouter } from './routes/chats';
import { projectsRouter } from './routes/projects';
import { agentsRouter } from './routes/sessions';
import { mediaRouter } from './routes/media';
import { gatewayRouter } from './routes/gateway';
import { updateRouter } from './routes/update';
import { tasksRouter } from './routes/tasks';
import { projects } from './services/store';
import {
  remoteAccessAuthMiddleware,
  remoteAccessLoginHandler,
} from './services/remoteAccessAuth';
import { remoteAccessApiRouter } from './routes/remoteAccessApi';
import { settingsRouter } from './routes/settings';

import { PROJECT_LOGO_EMOJIS } from './constants/projectLogos';
import { resolveUploadsRoot } from './paths';
import { getInstalledVersion } from './version';

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

  const iclawVersion = getInstalledVersion();

  app.use((_req, res, next) => {
    res.locals.iclawVersion = iclawVersion;
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

  // Remote-access password gate. No-op for direct localhost requests; blocks
  // tunneled requests (those carrying `x-iclaw-tunneled: 1`, set only by our
  // own remoteAccess loopback) until the user submits the passphrase on the
  // inline login page. Mounted BEFORE static so assets are gated too.
  app.use(remoteAccessAuthMiddleware);
  app.post('/__ra/login', remoteAccessLoginHandler);

  app.use(
    express.static(
      resolveProjectDir(['public', 'css', 'style.css'], '../public'),
    ),
  );

  // User-uploaded attachments live under `data/uploads/<chatId>/<file>` and are
  // served straight back to the browser for inline rendering in past messages.
  // No directory listing — express.static returns 404 for paths that don't exist.
  const uploadsRoot = path.resolve(resolveUploadsRoot());
  fs.mkdirSync(uploadsRoot, { recursive: true });
  app.use('/uploads', express.static(uploadsRoot));

  app.use('/', indexRouter);
  app.use('/chats', chatsRouter);
  app.use('/projects', projectsRouter);
  app.use('/tasks', tasksRouter);
  app.use('/', settingsRouter);
  app.use('/api/agents', agentsRouter);
  app.use('/api/gateway', gatewayRouter);
  app.use('/api/update', updateRouter);
  app.use('/api/remote-access', remoteAccessApiRouter);
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
