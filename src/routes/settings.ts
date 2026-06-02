/**
 * GET /settings — Settings page.
 *
 * Sectioned scaffold: Remote Access + OpenRouter (the key that unlocks voice
 * messages, Ask mode, and smart titles). The key is stored in the local DB via
 * Settings — not an env var — and takes effect on the next page load.
 */

import { Router } from 'express';

import { chats, projects, tasks } from '../services/store';
import { chatStatus } from '../services/chatStatus';
import { openclaw } from '../services/openclaw';
import { remoteAccess, ALLOWED_DURATIONS_MS } from '../services/remoteAccess';
import {
  maskOpenRouterApiKey,
  setOpenRouterApiKey,
  clearOpenRouterApiKey,
} from '../services/config';
import { openRouterEnabled, fetchUsage, isOpenRouterFailure } from '../services/openRouter';

export const settingsRouter = Router();

/** Locals every settings sub-page needs for the shared sidebar + shell. */
function sidebarLocals() {
  return {
    title: 'Settings — iClaw',
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
  };
}

/** /settings → first sub-page. Each section is now its own page. */
settingsRouter.get('/settings', (_req, res) => {
  res.redirect('/settings/voice-ask');
});

settingsRouter.get('/settings/voice-ask', (_req, res) => {
  res.render('settings', {
    ...sidebarLocals(),
    settingsTab: 'voice-ask',
    openRouter: {
      hasKey: openRouterEnabled(),
      maskedKey: maskOpenRouterApiKey(),
    },
  });
});

settingsRouter.get('/settings/remote-access', (_req, res) => {
  res.render('settings', {
    ...sidebarLocals(),
    settingsTab: 'remote-access',
    tunnels: remoteAccess.list(),
    allowedDurationsMs: ALLOWED_DURATIONS_MS,
  });
});

/** Save / update the OpenRouter API key. Takes effect on the next page load. */
settingsRouter.post('/api/openrouter/key', (req, res) => {
  const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
  if (!key) {
    res.status(400).json({ error: 'Paste your OpenRouter API key first.' });
    return;
  }
  // OpenRouter keys look like `sk-or-...`. Be lenient (warn-not-block) so a
  // future key format still works, but catch obvious paste mistakes.
  if (!/^sk-or-/.test(key)) {
    res.status(400).json({ error: 'That doesn’t look like an OpenRouter key (expected to start with “sk-or-”).' });
    return;
  }
  setOpenRouterApiKey(key);
  res.json({ ok: true, maskedKey: maskOpenRouterApiKey() });
});

/** Disconnect — remove the stored key. */
settingsRouter.delete('/api/openrouter/key', (_req, res) => {
  clearOpenRouterApiKey();
  res.json({ ok: true });
});

/** Spend / credits readout for the connected key. */
settingsRouter.get('/api/openrouter/usage', async (_req, res) => {
  if (!openRouterEnabled()) {
    res.status(404).json({ error: 'No OpenRouter key connected.' });
    return;
  }
  try {
    const usage = await fetchUsage();
    res.json({ ok: true, usage });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res
      .status(502)
      .json({ error: isOpenRouterFailure(err) ? 'Could not load usage from OpenRouter.' : msg });
  }
});
