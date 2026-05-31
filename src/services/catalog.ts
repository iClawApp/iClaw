/**
 * Templates gallery catalog — fetched ONLY from iClaw-cloud (MongoDB via
 * GET /api/templates). No local JSON fallback.
 */

import { loadCloudShareBaseUrl } from './config';
import { normalizeAgentId } from './chatRunner';
import { openclawWs } from './openclawWs';

const DEFAULT_AGENT_LABEL = 'openclaw/default';
const CACHE_TTL_MS = 5 * 60 * 1000;

export type TemplateAskField = {
  key: string;
  label: string;
  type: 'select' | 'text';
  options?: string[];
};

/**
 * One MCP tool server a role needs. iClaw never connects this — the agent does,
 * at runtime, via the `openclaw mcp` CLI (see mcpPlaybook). Pure data so any
 * future MCP server is just a manifest entry.
 */
export type McpServerSpec = {
  name: string;
  transport: 'streamable-http' | 'sse' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  auth?: 'oauth' | 'bearer' | 'env' | 'none';
  secrets?: { key: string; label: string }[];
  description?: string;
};

export type TemplateManifest = {
  id: string;
  title: string;
  tagline: string;
  category: string;
  icon?: string;
  forWhom: string;
  search: string[];
  agentId: string;
  ask: TemplateAskField[];
  mcpServers?: McpServerSpec[];
  promptTemplate: string;
  firstHint?: string;
};

export type CatalogFile = {
  version: number;
  templates: TemplateManifest[];
};

export class CatalogUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogUnavailableError';
  }
}

let listCache: { data: CatalogFile; fetchedAt: number } | null = null;

function templatesApiBase(): string {
  const override = (process.env.ICLAW_CATALOG_URL ?? '').trim();
  if (override) {
    return override
      .replace(/\/+$/, '')
      .replace(/\/catalog\.json$/i, '')
      .replace(/\/api\/templates$/i, '');
  }
  const cloud = loadCloudShareBaseUrl();
  if (!cloud) {
    throw new CatalogUnavailableError(
      'Templates catalog requires ICLAW_CLOUD_URL (iClaw-cloud is not configured)',
    );
  }
  return cloud.replace(/\/+$/, '');
}

function listUrl(): string {
  return `${templatesApiBase()}/api/templates`;
}

function itemUrl(id: string): string {
  return `${templatesApiBase()}/api/templates/${encodeURIComponent(id)}`;
}

function parseCatalog(raw: unknown): CatalogFile {
  if (!raw || typeof raw !== 'object') {
    throw new CatalogUnavailableError('catalog: invalid response shape');
  }
  const obj = raw as Record<string, unknown>;
  const templates = obj.templates;
  if (!Array.isArray(templates)) {
    throw new CatalogUnavailableError('catalog: missing templates array');
  }
  return {
    version: typeof obj.version === 'number' ? obj.version : 1,
    templates: templates as TemplateManifest[],
  };
}

function parseManifest(raw: unknown): TemplateManifest {
  if (!raw || typeof raw !== 'object' || typeof (raw as TemplateManifest).id !== 'string') {
    throw new CatalogUnavailableError('catalog: invalid template shape');
  }
  return raw as TemplateManifest;
}

async function cloudFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      headers: {
        accept: 'application/json',
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new CatalogUnavailableError(
      `catalog: cannot reach iClaw-cloud (${url}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function loadCatalogList(): Promise<CatalogFile> {
  const now = Date.now();
  if (listCache && now - listCache.fetchedAt < CACHE_TTL_MS) {
    return listCache.data;
  }

  const url = listUrl();
  const res = await cloudFetch(url);
  if (!res.ok) {
    throw new CatalogUnavailableError(`catalog: GET ${url} → ${res.status}`);
  }
  const data = parseCatalog(await res.json());
  listCache = { data, fetchedAt: now };
  return data;
}

/** Clear in-memory list cache (tests + after create). */
export function resetCatalogCacheForTests(): void {
  listCache = null;
}

export function substitutePrompt(
  manifest: TemplateManifest,
  answers: Record<string, string>,
): string {
  const allowed = new Set((manifest.ask ?? []).map((f) => f.key));
  let out = manifest.promptTemplate ?? '';
  for (const key of allowed) {
    const value = String(answers[key] ?? '').trim();
    out = out.split(`{{${key}}}`).join(value);
  }
  return out.trim();
}

function agentLabelsFromList(rawAgents: { id: string }[]): Set<string> {
  const labels = new Set<string>([DEFAULT_AGENT_LABEL]);
  for (const a of rawAgents) {
    if (!a.id) continue;
    if (a.id === 'main' || a.id === 'default') {
      labels.add(DEFAULT_AGENT_LABEL);
    } else {
      labels.add(`openclaw/${a.id}`);
      labels.add(a.id);
    }
  }
  return labels;
}

/** Validate manifest.agentId against gateway agents; fallback to default. */
export async function resolveAgentLabel(preferred: string | undefined): Promise<string> {
  const label = (preferred ?? '').trim() || DEFAULT_AGENT_LABEL;
  try {
    const raw = await openclawWs.listAgents();
    const allowed = agentLabelsFromList(raw);
    if (allowed.has(label)) return label;
    const normalized = normalizeAgentId(label);
    for (const a of raw) {
      if (a.id === normalized) {
        return normalized === 'main' ? DEFAULT_AGENT_LABEL : `openclaw/${normalized}`;
      }
    }
  } catch {
    return label;
  }
  return DEFAULT_AGENT_LABEL;
}

export type CreateTemplateInput = {
  id?: string;
  title: string;
  tagline: string;
  category: string;
  forWhom: string;
  agentId?: string;
  ask?: TemplateAskField[];
  mcpServers?: McpServerSpec[];
  promptTemplate: string;
  firstHint?: string | null;
};

export const catalog = {
  async list(): Promise<TemplateManifest[]> {
    const file = await loadCatalogList();
    return file.templates ?? [];
  },

  async getById(id: string): Promise<TemplateManifest | null> {
    const trimmed = id.trim();
    if (!trimmed) return null;

    const url = itemUrl(trimmed);
    const res = await cloudFetch(url);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new CatalogUnavailableError(`catalog: GET ${url} → ${res.status}`);
    }
    return parseManifest(await res.json());
  },

  async create(input: CreateTemplateInput): Promise<TemplateManifest> {
    const url = listUrl();
    const res = await cloudFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg =
        typeof body.error === 'string' ? body.error : `catalog: POST ${url} → ${res.status}`;
      throw new CatalogUnavailableError(msg);
    }
    resetCatalogCacheForTests();
    return parseManifest(body);
  },
};
