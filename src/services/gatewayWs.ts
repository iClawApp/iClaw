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
  error?: { code?: string; message?: string };
};

/** Raw frame seen on the socket — exposed to advanced subscribers. */
export type RawGatewayFrame = GatewayFrame;
type RawFrameListener = (frame: RawGatewayFrame) => void;

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

  if (stream === 'item') {
    const kind = typeof data.kind === 'string' ? data.kind : '';
    if (kind === 'analysis') return null;

    const phase = data.phase;
    const name = itemToolName(data);
    if (phase === 'start') return { kind: 'tool', phase: 'start', name };
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

/** Default RPC timeout — chat.send takes up to ~30s for big agent runs. */
const DEFAULT_RPC_TIMEOUT_MS = 120_000;

class GatewayWsBridge {
  private ws: WebSocket | null = null;
  private connectTask: Promise<void> | null = null;
  private connectSent = false;
  private nextRpcSeq = 1;

  private readonly activityListeners = new Map<string, Set<ActivityListener>>();
  private readonly rawListeners = new Set<RawFrameListener>();
  private readonly pending = new Map<
    string,
    { resolve: (payload: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly subscribedSessions = new Set<string>();

  // --- request/response RPC ---------------------------------------------

  /**
   * Generic RPC call. Returns the `payload` portion of the response when ok=true,
   * rejects with the gateway's error message when ok=false or on timeout.
   */
  async request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<T> {
    await this.ensureConnected();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`gatewayWs: not connected for ${method}`);
    }
    const id = String(this.nextRpcSeq++);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gatewayWs: ${method} timed out`));
      }, opts.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (payload) => resolve(payload as T),
        reject,
        timer,
      });
      const frame = { type: 'req', id, method, params };
      this.ws!.send(JSON.stringify(frame));
    });
  }

  private handleRpcResponse(frame: GatewayFrame): void {
    if (frame.id == null) return;
    const id = String(frame.id);
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (frame.ok) {
      entry.resolve(frame.payload);
    } else {
      const msg = frame.error?.message ?? `RPC failed (code: ${frame.error?.code ?? 'unknown'})`;
      entry.reject(new Error(msg));
    }
  }

  // --- raw frame subscription -------------------------------------------

  /**
   * Subscribe to every frame seen on the socket (events + responses).
   * Used by higher-level clients that want fine-grained protocol access
   * — e.g. to capture `chat`, `session.message`, full `agent` events.
   */
  onFrame(listener: RawFrameListener): () => void {
    this.rawListeners.add(listener);
    return () => this.rawListeners.delete(listener);
  }

  // --- activity (simple) subscription -----------------------------------

  private emitActivity(sessionKey: string, ev: GatewayActivity): void {
    const set = this.activityListeners.get(sessionKey);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(ev);
      } catch (err) {
        console.error('[gatewayWs] activity listener error', err);
      }
    }
  }

  private dispatchEvent(eventName: string, payload: Record<string, unknown>): void {
    const sessionKey = pickSessionKey(payload);

    if (eventName === 'session.tool') {
      const mapped = mapSessionToolPayload(payload);
      if (mapped && sessionKey) this.emitActivity(sessionKey, mapped);
      return;
    }

    if (eventName === 'agent') {
      const mapped = mapAgentPayload(payload);
      const sk = sessionKey ?? pickSessionKey((payload.data ?? {}) as Record<string, unknown>);
      if (!mapped || !sk) return;
      this.emitActivity(sk, mapped);
    }
  }

  private handleFrame(raw: string): void {
    let frame: GatewayFrame;
    try {
      frame = JSON.parse(raw) as GatewayFrame;
    } catch {
      return;
    }

    // notify raw listeners first — they may want to see everything
    if (this.rawListeners.size > 0) {
      for (const fn of this.rawListeners) {
        try {
          fn(frame);
        } catch (err) {
          console.error('[gatewayWs] raw listener error', err);
        }
      }
    }

    if (frame.type === 'event' || frame.event) {
      const name = frame.event ?? '';
      const payload = (frame.payload ?? {}) as Record<string, unknown>;
      if (name === 'connect.challenge') {
        this.sendConnect();
        return;
      }
      this.dispatchEvent(name, payload);
      return;
    }

    if (frame.type === 'res') {
      // RPC response — route to whoever is waiting
      this.handleRpcResponse(frame);
      // also: if hello-ok arrives, kick the auto-subscribe pass
      if (frame.ok === true) {
        const p = frame.payload as Record<string, unknown> | undefined;
        if (p?.type === 'hello-ok' || p?.protocol != null) {
          this.onConnected();
        }
      }
    }
  }

  private onConnected(): void {
    for (const sk of this.subscribedSessions) {
      this.sendSessionSubscribe(sk);
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
      userAgent: 'iclaw/0.1.0',
    };
    const id = String(this.nextRpcSeq++);
    this.ws.send(JSON.stringify({ type: 'req', id, method: 'connect', params }));
    // The hello-ok response is handled in handleFrame; we don't track this
    // request via `pending` because it's part of the handshake fast-path.
  }

  private sendSessionSubscribe(sessionKey: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Note: docs distinguish `sessions.subscribe` (index changes) from
    // `sessions.messages.subscribe` (per-session transcript). For tool/
    // activity events we don't actually need an explicit subscribe — `agent`
    // and `chat` events broadcast to any operator.read client. But calling
    // sessions.messages.subscribe enables `session.message` events for
    // persisted messages, which higher-level clients may want.
    this.request('sessions.messages.subscribe', { key: sessionKey }).catch((err) => {
      console.warn('[gatewayWs] sessions.messages.subscribe failed', err.message);
    });
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
        this.connectSent = false;
        // fail any pending RPCs
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error('gatewayWs: socket closed'));
        }
        this.pending.clear();
      }
    });
    ws.addEventListener('error', () => {
      /* close handler will run */
    });
  }

  async ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN && !this.connectTask) return;
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
      const finish = (err?: Error): void => {
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

      const helloListener = (ev: MessageEvent): void => {
        try {
          const frame = JSON.parse(String(ev.data)) as GatewayFrame;
          if (frame.type === 'res' && frame.ok === true) {
            const p = frame.payload as Record<string, unknown> | undefined;
            if (p?.type === 'hello-ok' || p?.protocol != null) {
              ws.removeEventListener('message', helloListener);
              finish();
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

  /** Subscribe to tool/lifecycle activity for a chat session key (high-level). */
  watchSession(sessionKey: string, listener: ActivityListener): () => void {
    let set = this.activityListeners.get(sessionKey);
    if (!set) {
      set = new Set();
      this.activityListeners.set(sessionKey, set);
    }
    set.add(listener);

    this.subscribedSessions.add(sessionKey);
    void this.ensureConnected()
      .then(() => this.sendSessionSubscribe(sessionKey))
      .catch((err) => console.error('[gatewayWs] connect failed', err.message));

    return () => {
      set?.delete(listener);
      if (set?.size === 0) {
        this.activityListeners.delete(sessionKey);
        this.subscribedSessions.delete(sessionKey);
      }
    };
  }
}

export const gatewayWs = new GatewayWsBridge();
