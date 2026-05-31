/**
 * Templates gallery — list use-case cards and activate a template into a draft chat
 * with a hidden per-chat preamble (see Milestone 1 in docs/templates-gallery-plan.md).
 */

import { Router } from 'express';
import {
  catalog,
  CatalogUnavailableError,
  resolveAgentLabel,
  substitutePrompt,
} from '../services/catalog';
import { probeGateway } from '../services/gatewayProbe';
import { openclaw } from '../services/openclaw';
import { chats, projects, tasks } from '../services/store';
import { chatStatus } from '../services/chatStatus';
import { buildRoleFromInput } from '../services/roleFromSimpleInput';
import { buildMcpPlaybook } from '../services/mcpPlaybook';
import { mergeRoleCategories, ROLE_CATEGORIES } from '../constants/roleCategories';
import { mcpBadges, distinctMcpBadges } from '../constants/mcpIcons';

export const templatesRouter: Router = Router();

function wantsJson(req: import('express').Request): boolean {
  return (
    req.headers['content-type']?.includes('application/json') ||
    req.headers.accept?.includes('application/json') ||
    false
  );
}

function groupByCategory(templates: Awaited<ReturnType<typeof catalog.list>>) {
  const map = new Map<string, typeof templates>();
  for (const t of templates) {
    const cat = t.category?.trim() || 'Other';
    const list = map.get(cat) ?? [];
    list.push(t);
    map.set(cat, list);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b, 'en'));
}

function sidebarLocals() {
  return {
    chats: chats.list(),
    workingIds: chatStatus.workingIds(),
    allProjects: projects.list(),
    hasAnyTasks: tasks.hasAny(),
    taskStatusSignals: tasks.statusSignals(),
    activeChat: null,
    activeProject: null,
    activeTemplatesList: true,
    mcpBadges,
    distinctMcpBadges,
  };
}

templatesRouter.get('/', async (_req, res) => {
  const { gatewayUp, agentsError } = await probeGateway('templates');
  try {
    const templates = await catalog.list();
    res.render('templates', {
      ...sidebarLocals(),
      templates,
      templatesByCategory: groupByCategory(templates),
      roleCategories: mergeRoleCategories(templates.map((t) => t.category)),
      catalogError: null,
      gatewayUp,
      agentsError,
      openclawBaseUrl: openclaw.baseUrl,
    });
  } catch (err) {
    const message =
      err instanceof CatalogUnavailableError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'catalog unavailable';
    res.render('templates', {
      ...sidebarLocals(),
      templates: [],
      templatesByCategory: [],
      roleCategories: [...ROLE_CATEGORIES],
      catalogError: message,
      gatewayUp,
      agentsError,
      openclawBaseUrl: openclaw.baseUrl,
    });
  }
});

templatesRouter.post('/create', async (req, res) => {
  const body = req.body ?? {};
  const title = String(body.title ?? '').trim();
  const promptTemplate = String(body.promptTemplate ?? '').trim();
  if (!title || !promptTemplate) {
    const msg = 'Enter a name and AI instruction';
    if (wantsJson(req)) res.status(400).json({ error: msg });
    else res.redirect(303, '/templates?error=' + encodeURIComponent(msg));
    return;
  }

  const input = buildRoleFromInput({
    title,
    promptTemplate,
    category: String(body.category ?? '').trim() || undefined,
  });

  try {
    const created = await catalog.create(input);
    if (wantsJson(req)) {
      res.status(201).json({ ok: true, id: created.id, title: created.title });
    } else {
      res.redirect(
        303,
        '/templates?createdTitle=' + encodeURIComponent(created.title),
      );
    }
  } catch (err) {
    const message =
      err instanceof CatalogUnavailableError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'create failed';
    if (wantsJson(req)) {
      res.status(502).json({ error: message });
    } else {
      res.redirect(303, '/templates?error=' + encodeURIComponent(message));
    }
  }
});

templatesRouter.post('/activate', async (req, res) => {
  let manifest;
  try {
    const templateId = String(req.body?.templateId ?? '').trim();
    manifest = await catalog.getById(templateId);
  } catch (err) {
    const message =
      err instanceof CatalogUnavailableError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'catalog unavailable';
    if (wantsJson(req)) res.status(502).json({ error: message });
    else res.status(502).type('text/plain').send(message);
    return;
  }

  if (!manifest) {
    if (wantsJson(req)) {
      res.status(404).json({ error: 'template not found' });
    } else {
      res.status(404).type('text/plain').send('template not found');
    }
    return;
  }

  const answers = (req.body?.answers ?? {}) as Record<string, string>;
  let preamble = substitutePrompt(manifest, answers);
  if (manifest.mcpServers && manifest.mcpServers.length > 0) {
    preamble = `${preamble}\n\n${buildMcpPlaybook(manifest.mcpServers)}`;
  }
  const agent = await resolveAgentLabel(manifest.agentId);

  const chat = chats.create(agent, null, {
    chatKind: 'draft',
    useCasePreamble: preamble,
    templateId: manifest.id,
    title: manifest.title,
  });
  chats.rename(chat.id, manifest.title, { manual: true });

  if (wantsJson(req)) {
    res.json({ chatId: chat.id });
  } else {
    res.redirect(303, `/chats/${chat.id}`);
  }
});
