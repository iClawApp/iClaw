import { randomUUID } from 'node:crypto';
import { loadOpenClawConfig } from './config';

/** Activity from gateway WS (agent / session.tool), keyed by session. */
export type GatewayActivity =
  | { kind: 'tool'; phase: 'start' | 'end'; name: string }
  | { kind: 'lifecycle'; phase: string }
  | { kind: 'status'; status: 'thinking' };

type ActivityListener = (ev: GatewayActivity) => void;

type GatewayFrame = {
  type?: string;
  event?: string;
  method?: string;
  id?: string | number;
  ok?: boolean;
  payload?: Record<string, unknown>;
  params?: Record<string, unknown>;
};

function httpToWsUrl(httpUrl: string): string {
  const u = new URL(httpUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString().replace(/\/$/, '');
}

function pickSessionKey(payload: Record<string, unknown>): string | null {
  for (const key of ['sessionKey', 'session_id', 'sessionId']) {
    const v = payload[key];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

function toolNameFromPayload(data: Record<string, unknown>): string {
  const name = data.name ?? data.toolName ?? data.tool;
  return typeof name === 'string' && name ? name : 'tool';
}

function itemToolName(data: Record<string, unknown>): string {
  const name = toolNameFromPayload(data);
  if (name !== 'tool') return name;
  const kind = typeof data.kind === 'string' ? data.kind : '';
  if (kind && kind !== 'tool') return kind;
  return name;
}

function mapAgentPayload(payload: Record<string, unknown>): GatewayActivity | null {
  const stream = payload.stream;
  const data = (payload.data ?? {}) as Record<string, unknown>;

  if (stream === 'tool') {
    const phase = data.phase;
    if (phase === 'start') {
      return { kind: 'tool', phase: 'start', name: toolNameFromPayload(data) };
    }
    if (phase === 'result' || phase === 'end' || phase === 'error') {
      return { kind: 'tool', phase: 'end', name: toolNameFromPayload(data) };
    }
    return null;
  }

  // OpenClaw agent runs emit command/file activity as stream "item", not "tool".
  if (stream === 'item') {
    const kind = typeof data.kind === 'string' ? data.kind : '';
    if (kind === 'analysis') return null;

    const phase = data.phase;
    const name = itemToolName(data);
    if (phase === 'start') {
      return { kind: 'tool', phase: 'start', name };
    }
    if (phase === 'end' || phase === 'completed' || phase === 'error') {
      return { kind: 'tool', phase: 'end', name };
    }
    return null;
  }

  if (stream === 'lifecycle') {
    const phase = typeof data.phase === 'string' ? data.phase : 'unknown';
    if (phase === 'thinking') return { kind: 'status', status: 'thinking' };
    return null;
  }

  return null;
}

function mapSessionToolPayload(payload: Record<string, unknown>): GatewayActivity | null {
  const phase = payload.phase ?? payload.status;
  const name = toolNameFromPayload(payload);
  if (phase === 'start' || phase === 'running' || phase === 'invoke') {
    return { kind: 'tool', phase: 'start', name };
  }
  if (phase === 'end' || phase === 'done' || phase === 'result' || phase === 'error') {
    return { kind: 'tool', phase: 'end', name };
  }
  return null;
}

class GatewayWsBridge {
  private ws: WebSocket | null = null;
  private connectTask: Promise<void> | null = null;
  private connectNonce: string | null = null;
  private connectSent = false;
  private readonly listeners = new Map<string, Set<ActivityListener>>();
  private readonly subscribedSessions = new Set<string>();

  private nextId(): string {
    return randomUUID();
  }

  private sendReq(method: string, params: Record<string, unknown>): string {
    const id = this.nextId();
    const frame = { type: 'req', id, method, params };
    this.ws?.send(JSON.stringify(frame));
    return id;
  }

  private emit(sessionKey: string, ev: GatewayActivity): void {
    const set = this.listeners.get(sessionKey);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(ev);
      } catch (err) {
        console.error('[gatewayWs] listener error', err);
      }
    }
  }

  private dispatchEvent(eventName: string, payload: Record<string, unknown>): void {
    const sessionKey = pickSessionKey(payload);

    if (eventName === 'session.tool') {
      const mapped = mapSessionToolPayload(payload);
      if (mapped && sessionKey) this.emit(sessionKey, mapped);
      return;
    }

    if (eventName === 'agent') {
      const mapped = mapAgentPayload(payload);
      const sk = sessionKey ?? pickSessionKey((payload.data ?? {}) as Record<string, unknown>);
      if (!mapped || !sk) return;
      this.emit(sk, mapped);
    }
  }

  private handleFrame(raw: string): void {
    let frame: GatewayFrame;
    try {
      frame = JSON.parse(raw) as GatewayFrame;
    } catch {
      return;
    }

    if (frame.type === 'event' || frame.event) {
      const name = frame.event ?? '';
      const payload = (frame.payload ?? {}) as Record<string, unknown>;
      if (name === 'connect.challenge') {
        const nonce = payload.nonce ?? payload.challenge;
        if (typeof nonce === 'string') this.connectNonce = nonce;
        this.sendConnect();
        return;
      }
      this.dispatchEvent(name, payload);
      return;
    }

    if (frame.type === 'res' && frame.ok === true) {
      const p = frame.payload as Record<string, unknown> | undefined;
      if (p?.type === 'hello-ok' || p?.protocol != null) {
        this.onConnected();
      }
    }
  }

  private onConnected(): void {
    for (const sk of this.subscribedSessions) {
      this.sendSubscribe(sk);
    }
  }

  private sendConnect(): void {
    if (this.connectSent || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.connectSent = true;
    const cfg = loadOpenClawConfig();
    const params: Record<string, unknown> = {
      minProtocol: 3,
      maxProtocol: 4,
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      client: {
        id: 'gateway-client',
        version: '0.1.0',
        platform: 'nodejs',
        mode: 'backend',
      },
      auth: { token: cfg.token },
      locale: 'en-US',
      userAgent: 'iclaude/0.1.0',
    };
    this.sendReq('connect', params);
  }

  private sendSubscribe(sessionKey: string): void {
    if (this.subscribedSessions.has(sessionKey)) return;
    this.subscribedSessions.add(sessionKey);
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.sendReq('sessions.subscribe', { sessionKey });
  }

  private attachSocket(ws: WebSocket): void {
    ws.addEventListener('message', (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : '';
      if (data) this.handleFrame(data);
    });
    ws.addEventListener('close', () => {
      if (this.ws === ws) {
        this.ws = null;
        this.connectTask = null;
        this.connectNonce = null;
        this.connectSent = false;
      }
    });
    ws.addEventListener('error', () => {
      /* close handler will run */
    });
  }

  async ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connectTask) return this.connectTask;

    const cfg = loadOpenClawConfig();
    if (!cfg.token) throw new Error('gatewayWs: no auth token');

    this.connectTask = new Promise<void>((resolve, reject) => {
      const wsUrl = httpToWsUrl(cfg.baseUrl);
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      this.connectSent = false;
      this.attachSocket(ws);

      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(fallbackConnect);
        if (err) reject(err);
        else resolve();
      };

      const timeout = setTimeout(() => {
        finish(new Error('gatewayWs: connect timeout'));
        ws.close();
      }, 15_000);

      const onHello = () => finish();
      const helloListener = (ev: MessageEvent) => {
        try {
          const frame = JSON.parse(String(ev.data)) as GatewayFrame;
          if (frame.type === 'res' && frame.ok === true) {
            const p = frame.payload as Record<string, unknown> | undefined;
            if (p?.type === 'hello-ok' || p?.protocol != null) {
              ws.removeEventListener('message', helloListener);
              onHello();
            }
          }
        } catch {
          /* ignore */
        }
      };
      ws.addEventListener('message', helloListener);

      const fallbackConnect = setTimeout(() => this.sendConnect(), 400);

      ws.addEventListener('open', () => {
        /* connect after challenge event or fallback timer */
      });

      ws.addEventListener('error', () => {
        finish(new Error('gatewayWs: connection failed'));
      });
    }).finally(() => {
      this.connectTask = null;
    });

    return this.connectTask;
  }

  /** Subscribe to tool/lifecycle activity for a chat session key. */
  watchSession(sessionKey: string, listener: ActivityListener): () => void {
    let set = this.listeners.get(sessionKey);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionKey, set);
    }
    set.add(listener);

    void this.ensureConnected()
      .then(() => this.sendSubscribe(sessionKey))
      .catch((err) => console.error('[gatewayWs] connect failed', err.message));

    return () => {
      set?.delete(listener);
      if (set?.size === 0) {
        this.listeners.delete(sessionKey);
        this.subscribedSessions.delete(sessionKey);
      }
    };
  }
}

export const gatewayWs = new GatewayWsBridge();
