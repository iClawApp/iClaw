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

export type OpenClawStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; phase: 'start' | 'end'; name: string }
  | { type: 'finish'; reason: string | null };

type ToolCallDelta = {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
};

type CompletionChoice = {
  delta?: {
    content?: string;
    tool_calls?: ToolCallDelta[];
  };
  finish_reason?: string | null;
};

function* eventsFromChoice(
  choice: CompletionChoice,
  toolState: Map<number, string>,
): Generator<OpenClawStreamEvent> {
  const delta = choice.delta;
  if (delta?.content) {
    yield { type: 'delta', text: delta.content };
  }

  if (delta?.tool_calls) {
    for (const call of delta.tool_calls) {
      const idx = call.index ?? 0;
      const name = call.function?.name?.trim();
      if (!name) continue;

      const prev = toolState.get(idx);
      if (prev && prev !== name) {
        yield { type: 'tool', phase: 'end', name: prev };
      }
      if (prev !== name) {
        toolState.set(idx, name);
        yield { type: 'tool', phase: 'start', name };
      }
    }
  }

  if (choice.finish_reason) {
    for (const name of toolState.values()) {
      yield { type: 'tool', phase: 'end', name };
    }
    toolState.clear();
    yield { type: 'finish', reason: choice.finish_reason };
  }
}

const config: OpenClawConfig = loadOpenClawConfig();

function authHeaders(stream = false): Record<string, string> {
  const h: Record<string, string> = {
    accept: stream ? 'text/event-stream' : 'application/json',
    'content-type': 'application/json',
  };
  if (config.token) h['authorization'] = `Bearer ${config.token}`;
  return h;
}

async function* parseOpenAiSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<OpenClawStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const toolState = new Map<number, string>();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        for (const line of block.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (!trimmed.startsWith('data:')) continue;

          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') return;

          let json: { choices?: CompletionChoice[] };
          try {
            json = JSON.parse(data) as typeof json;
          } catch {
            continue;
          }

          const choice = json.choices?.[0];
          if (!choice) continue;
          yield* eventsFromChoice(choice, toolState);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
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

  async *chatStream(opts: {
    model: string;
    sessionKey: string;
    messages: ChatMessage[];
    signal?: AbortSignal;
  }): AsyncGenerator<OpenClawStreamEvent> {
    const headers = authHeaders(true);
    headers['x-openclaw-session-key'] = opts.sessionKey;
    const res = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: opts.model,
        messages: opts.messages,
        stream: true,
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`chatStream: HTTP ${res.status} ${body}`);
    }
    if (!res.body) throw new Error('chatStream: empty response body');
    yield* parseOpenAiSseStream(res.body);
  },
};
