/**
 * GET /remote-access — Settings page for the Remote Access feature.
 *
 * Server-renders a snapshot of `remoteAccess.getStatus()`. The page
 * then polls /api/remote-access/status every 1.5s while the user is
 * looking at it so the URL/passphrase appear without a manual reload
 * once the tunnel handshake completes.
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
    // Sidebar locals (same as projects page).
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
    status: remoteAccess.getStatus(),
    allowedDurationsMs: ALLOWED_DURATIONS_MS,
  });
});
