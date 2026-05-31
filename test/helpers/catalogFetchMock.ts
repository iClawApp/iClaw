import { vi } from 'vitest';
import type { TemplateManifest } from '../../src/services/catalog';

export const mockTemplates: TemplateManifest[] = [
  {
    id: 'smm-specialist',
    title: 'AI SMM-спеціаліст',
    tagline: 'Контент-план і пости для ваших соцмереж',
    category: 'Marketing',
    icon: '📱',
    forWhom: 'Власники, маркетологи, фрилансери',
    search: ['instagram', 'пости', 'smm'],
    agentId: 'openclaw/default',
    ask: [
      { key: 'platform', label: 'Platform', type: 'select', options: ['Instagram'] },
      { key: 'count', label: 'Count', type: 'select', options: ['5'] },
      { key: 'tone', label: 'Tone', type: 'select', options: ['Дружній'] },
    ],
    promptTemplate:
      'Ти — SMM. Платформа: {{platform}}. Кількість: {{count}}. Тон: {{tone}}.',
    firstHint: 'Напишіть тему — напр.: «пости про каву на тиждень»',
  },
  {
    id: 'daily-briefing',
    title: 'Щоденний брифінг',
    tagline: 'Короткий огляд дня',
    category: 'Productivity',
    icon: '☀️',
    forWhom: 'Підприємці',
    search: ['брифінг'],
    agentId: 'openclaw/default',
    ask: [{ key: 'focus', label: 'Фокус', type: 'text' }],
    promptTemplate: 'Брифінг. Фокус: {{focus}}.',
    firstHint: 'Що плануєте сьогодні?',
  },
  {
    id: 'notion-assistant',
    title: 'AI асистент Notion',
    tagline: 'Шукає й оновлює сторінки Notion',
    category: 'Productivity',
    icon: '🗂️',
    forWhom: 'Notion-користувачі',
    search: ['notion', 'нотатки'],
    agentId: 'openclaw/default',
    ask: [{ key: 'task', label: 'Що зробити в Notion?', type: 'text' }],
    mcpServers: [
      {
        name: 'notion',
        transport: 'streamable-http',
        url: 'https://mcp.notion.com/mcp',
        auth: 'oauth',
        description: 'Notion workspace',
      },
    ],
    promptTemplate: 'Працюй з Notion користувача. Завдання: {{task}}.',
    firstHint: 'Що зробити в Notion?',
  },
];

let templatesStore = [...mockTemplates];

export function resetMockTemplatesStore(): void {
  templatesStore = mockTemplates.map((t) => ({ ...t, ask: [...t.ask], search: [...t.search] }));
}

export function installCatalogFetchMock(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/api/templates') && method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ version: 1, templates: templatesStore }),
        } as Response;
      }

      const itemMatch = url.match(/\/api\/templates\/([^/?]+)$/);
      if (itemMatch && method === 'GET') {
        const id = decodeURIComponent(itemMatch[1]!);
        const found = templatesStore.find((t) => t.id === id);
        return {
          ok: Boolean(found),
          status: found ? 200 : 404,
          json: async () => found ?? { error: 'not found' },
        } as Response;
      }

      if (url.endsWith('/api/templates') && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as TemplateManifest;
        const id =
          body.id ||
          String(body.title || 'role')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9-]/g, '')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '') ||
          'role';
        if (templatesStore.some((t) => t.id === id)) {
          return {
            ok: false,
            status: 409,
            json: async () => ({ error: 'template id already exists' }),
          } as Response;
        }
        const row = { ...body, id, ask: body.ask ?? [], search: body.search ?? [] };
        templatesStore.push(row);
        return {
          ok: true,
          status: 201,
          json: async () => row,
        } as Response;
      }

      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}
