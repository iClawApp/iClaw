/**
 * GET /remote-access — Settings page for the Remote Access feature.
 *
 * Server-renders the current list of tunnels. The page polls the JSON
 * API every 1.5s while open so newly-created tunnels' URLs appear and
 * countdowns tick down without manual refresh.
 */

import { Router } from 'express';

import { chats, projects, tasks } from '../services/store';
import { chatStatus } from '../services/chatStatus';
import { openclaw } from '../services/openclaw';
import { remoteAccess, ALLOWED_DURATIONS_MS } from '../services/remoteAccess';

export const remoteAccessPageRouter = Router();

remoteAccessPageRouter.get('/remote-access', (_req, res) => {
  res.render('remote-access', {
    title: 'Remote Access — iClaw',
    // Sidebar locals.
    chats: chats.list(),
    workingIds: chatStatus.workingIds(),
    allProjects: projects.list(),
    hasAnyTasks: tasks.hasAny(),
    taskStatusSignals: tasks.statusSignals(),
    activeChat: null,
    activeProject: null,
    activeProjectsList: false,
    activeTasksList: false,
    activeRemoteAccess: true,
    openclawBaseUrl: openclaw.baseUrl,
    // Page-specific.
    tunnels: remoteAccess.list(),
    allowedDurationsMs: ALLOWED_DURATIONS_MS,
  });
});
