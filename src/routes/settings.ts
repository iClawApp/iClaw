/**
 * GET /settings — Settings page.
 *
 * For now the only section is Remote Access, but the page is built as a
 * sectioned scaffold so future settings can land alongside without a
 * separate URL.
 */

import { Router } from 'express';

import { chats, projects, tasks } from '../services/store';
import { chatStatus } from '../services/chatStatus';
import { openclaw } from '../services/openclaw';
import { remoteAccess, ALLOWED_DURATIONS_MS } from '../services/remoteAccess';

export const settingsRouter = Router();

settingsRouter.get('/settings', (_req, res) => {
  res.render('settings', {
    title: 'Settings — iClaw',
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
    activeSettings: true,
    openclawBaseUrl: openclaw.baseUrl,
    // Page-specific.
    tunnels: remoteAccess.list(),
    allowedDurationsMs: ALLOWED_DURATIONS_MS,
  });
});
