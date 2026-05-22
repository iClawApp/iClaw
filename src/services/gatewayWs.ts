import { loadOpenClawConfig } from './config';

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

/** Default RPC timeout — chat.send takes up to ~30s for big agent runs. */
const DEFAULT_RPC_TIMEOUT_MS = 120_000;

/**
 * Hello-ok defaults from `docs/gateway/protocol.md`. Used while we wait for
 * the actual policy.tickIntervalMs to arrive on connect.
 */
const DEFAULT_TICK_INTERVAL_MS = 30_000;
/** When N ticks pass without any frame from the gateway, treat the socket as dead. */
const TICK_MISS_MULTIPLIER = 2;

/** Listener for connection-up edges. Fires once per successful hello-ok. */
type ReconnectListener = () => void;

class GatewayWsBridge {
  private ws: WebSocket | null = null;
  private connectTask: Promise<void> | null = null;
  private connectSent = false;
  private nextRpcSeq = 1;

  private readonly rawListeners = new Set<RawFrameListener>();
  private readonly reconnectListeners = new Set<ReconnectListener>();
  private readonly pending = new Map<
    string,
    { resolve: (payload: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly subscribedSessions = new Set<string>();

  // --- liveness watchdog -----------------------------------------------------
  /** Effective tick window negotiated from `hello-ok.policy.tickIntervalMs`. */
  private tickIntervalMs = DEFAULT_TICK_INTERVAL_MS;
  /** Timer that closes a stale socket if no frame arrived in TICK_MISS_MULTIPLIER × tickIntervalMs. */
  private tickWatchdog: NodeJS.Timeout | null = null;

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

  private handleFrame(raw: string): void {
    let frame: GatewayFrame;
    try {
      frame = JSON.parse(raw) as GatewayFrame;
    } catch {
      return;
    }

    // Any frame from the gateway counts as proof of life — reset the watchdog.
    this.armTickWatchdog();

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
      if (name === 'connect.challenge') {
        this.sendConnect();
        return;
      }
      return;
    }

    if (frame.type === 'res') {
      // RPC response — route to whoever is waiting
      this.handleRpcResponse(frame);
      // also: if hello-ok arrives, kick the auto-subscribe pass
      if (frame.ok === true) {
        const p = frame.payload as Record<string, unknown> | undefined;
        if (p?.type === 'hello-ok' || p?.protocol != null) {
          this.adoptPolicy(p);
          this.onConnected();
        }
      }
    }
  }

  /** Read tick interval and any other useful budgets out of hello-ok. */
  private adoptPolicy(payload: Record<string, unknown> | undefined): void {
    const policy = payload?.policy as Record<string, unknown> | undefined;
    const tick = policy?.tickIntervalMs;
    if (typeof tick === 'number' && tick > 1_000) {
      this.tickIntervalMs = tick;
    }
  }

  /**
   * (Re)arm the dead-socket timer. Called whenever we see a frame; closes
   * the socket if no frame arrives within `tickIntervalMs × TICK_MISS_MULTIPLIER`.
   * The close triggers our normal reconnect path the next time anyone calls
   * an RPC through `ensureConnected`.
   */
  private armTickWatchdog(): void {
    if (this.tickWatchdog) clearTimeout(this.tickWatchdog);
    this.tickWatchdog = setTimeout(() => {
      const ws = this.ws;
      if (!ws) return;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        console.warn(
          '[gatewayWs] tick watchdog: no frames for',
          this.tickIntervalMs * TICK_MISS_MULTIPLIER,
          'ms — closing socket to force reconnect',
        );
        try {
          ws.close(4000, 'tick-timeout');
        } catch {
          /* close errors don't matter — the close handler does the cleanup */
        }
      }
    }, this.tickIntervalMs * TICK_MISS_MULTIPLIER);
    // Don't keep the event loop alive solely on the watchdog.
    this.tickWatchdog.unref?.();
  }

  private clearTickWatchdog(): void {
    if (this.tickWatchdog) {
      clearTimeout(this.tickWatchdog);
      this.tickWatchdog = null;
    }
  }

  /** Run all connect-up listeners (gatewayEvents re-subscribes here). */
  onReconnect(listener: ReconnectListener): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  private onConnected(): void {
    for (const sk of this.subscribedSessions) {
      this.sendSessionSubscribe(sk);
    }
    for (const fn of this.reconnectListeners) {
      try {
        fn();
      } catch (err) {
        console.error('[gatewayWs] reconnect listener error', err);
      }
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
      // operator.approvals — exec.approval.resolve on exec.approval.requested.
      // operator.admin — config.patch (e.g. session-reset-fix banner), control-plane writes.
      scopes: [
        'operator.read',
        'operator.write',
        'operator.approvals',
        'operator.admin',
      ],
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
        this.clearTickWatchdog();
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

  /** Drop a dead socket so the next RPC opens a fresh connection (e.g. after gateway start). */
  resetConnection(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* best-effort */
      }
      this.ws = null;
    }
    this.connectTask = null;
    this.connectSent = false;
    this.clearTickWatchdog();
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('gatewayWs: socket closed'));
    }
    this.pending.clear();
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

  /**
   * Subscribe to per-session transcript events for `sessionKey`. Awaitable
   * so callers (e.g. `runTurn`) can guarantee the subscription is in place
   * before they kick off `chat.send`. Registers the session in
   * `subscribedSessions` so the post-reconnect `onConnected` hook
   * re-subscribes automatically — without that bookkeeping, an in-flight
   * turn that survives a socket reconnect would stop receiving events and
   * hang until the upper-bound timeout fires.
   */
  async subscribeSession(sessionKey: string): Promise<void> {
    this.subscribedSessions.add(sessionKey);
    try {
      await this.ensureConnected();
      await this.request('sessions.messages.subscribe', { key: sessionKey });
    } catch (err) {
      // Broadcast events still flow via `operator.read`, so we don't reject
      // the caller — but log because a silent failure here means missing
      // per-session frames if the gateway later restricts them.
      console.warn(
        '[gatewayWs] sessions.messages.subscribe failed:',
        (err as Error).message,
      );
    }
  }
}

export const gatewayWs = new GatewayWsBridge();
