import { loadOpenClawConfig, type OpenClawConfig } from './config';

export interface OpenClawAgent {
  id: string;
  owned_by?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  content: string;
  finish_reason: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  raw: unknown;
}

const config: OpenClawConfig = loadOpenClawConfig();

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  if (config.token) h['authorization'] = `Bearer ${config.token}`;
  return h;
}

export const openclaw = {
  baseUrl: config.baseUrl,
  tokenSource: config.source,
  hasToken: Boolean(config.token),

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${config.baseUrl}/health`, { headers: authHeaders() });
      return res.ok;
    } catch {
      return false;
    }
  },

  async listAgents(): Promise<OpenClawAgent[]> {
    const res = await fetch(`${config.baseUrl}/v1/models`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`listAgents: HTTP ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { data?: OpenClawAgent[] };
    return body.data ?? [];
  },

  async chat(opts: {
    model: string;
    sessionKey: string;
    messages: ChatMessage[];
    signal?: AbortSignal;
  }): Promise<ChatResult> {
    const headers = authHeaders();
    headers['x-openclaw-session-key'] = opts.sessionKey;
    const res = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: opts.model, messages: opts.messages }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`chat: HTTP ${res.status} ${body}`);
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
      usage?: ChatResult['usage'];
    };
    const choice = body.choices?.[0];
    return {
      content: choice?.message?.content ?? '',
      finish_reason: choice?.finish_reason ?? null,
      usage: body.usage,
      raw: body,
    };
  },
};
