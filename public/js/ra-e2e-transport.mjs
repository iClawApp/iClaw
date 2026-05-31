/**
 * Encrypted fetch + WebSocket shim for tunneled Remote Access (E2E transport).
 */
import {
  deriveE2eSessionKeys,
  decryptE2eRecord,
  encryptE2eRecord,
  encodeWireEnvelope,
  decodeWireEnvelope,
  E2eCounterLedger,
  relayBindingFromAccessToken,
  relayBindingB64urlFromAccessToken,
  relayBindingFromB64url,
} from '/js/ra-e2e-crypto.mjs';

const E2E_HTTP_PATH = '/__ra/e2e/http';
const E2E_WS_PATH = '/__ra/e2e/ws';
const EXEMPT_PREFIXES = ['/__ra/opaque/', '/__ra/device/', '/__ra/e2e/', '/__ra/login'];

let state = null;
const c2sCtr = new Map();
const s2cLedger = new E2eCounterLedger();

function captureRelayAccessToken() {
  try {
    const access = new URLSearchParams(location.search).get('access');
    if (access) sessionStorage.setItem('iclaw_relay_access_raw', access);
  } catch {
    // ignore
  }
}

function captureRelayBindingFromPage() {
  try {
    const meta = document.querySelector('meta[name="iclaw-ra-relay-binding"]');
    const b64 = meta ? meta.getAttribute('content') || '' : '';
    if (b64) {
      sessionStorage.setItem('iclaw_relay_binding_b64', b64);
      return;
    }
    const stored = sessionStorage.getItem('iclaw_relay_binding_b64');
    if (stored) return;
    const accessRaw = sessionStorage.getItem('iclaw_relay_access_raw');
    if (accessRaw) {
      sessionStorage.setItem('iclaw_relay_binding_b64', relayBindingB64urlFromAccessToken(accessRaw));
    }
  } catch {
    // ignore
  }
}

function loadRelayBinding() {
  try {
    const meta = document.querySelector('meta[name="iclaw-ra-relay-binding"]');
    const fromMeta = meta ? meta.getAttribute('content') || '' : '';
    if (fromMeta) return relayBindingFromB64url(fromMeta);
    const stored = sessionStorage.getItem('iclaw_relay_binding_b64');
    if (stored) return relayBindingFromB64url(stored);
    const accessRaw = sessionStorage.getItem('iclaw_relay_access_raw');
    return relayBindingFromAccessToken(accessRaw || '');
  } catch {
    return relayBindingFromAccessToken('');
  }
}

function loadState() {
  const meta = document.querySelector('meta[name="iclaw-ra-e2e"]');
  if (!meta || meta.getAttribute('content') !== 'true') return null;
  const tunnelIdEl = document.querySelector('meta[name="iclaw-ra-tunnel-id"]');
  const tunnelId = tunnelIdEl ? tunnelIdEl.getAttribute('content') || '' : '';
  const opaqueSk = sessionStorage.getItem('iclaw_e2e_opaque_sk');
  const transportHandle = sessionStorage.getItem('iclaw_e2e_transport');
  if (!tunnelId || !opaqueSk || !transportHandle) return null;
  const relayBinding = loadRelayBinding();
  const keys = deriveE2eSessionKeys(opaqueSk, tunnelId, relayBinding);
  return { tunnelId, transportHandle, keys, relayBinding };
}

function nextC2sCtr(streamId) {
  const n = c2sCtr.get(streamId) ?? 0;
  c2sCtr.set(streamId, n + 1);
  return n;
}

function shouldWrapUrl(url) {
  try {
    const u = new URL(url, location.origin);
    if (u.origin !== location.origin) return false;
    const path = u.pathname;
    for (let i = 0; i < EXEMPT_PREFIXES.length; i++) {
      if (path.startsWith(EXEMPT_PREFIXES[i])) return false;
    }
    if (path.startsWith('/css/') || path.startsWith('/js/') || path.startsWith('/favicon')) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function encryptOutbound(kind, streamId, innerObj) {
  const ctr = nextC2sCtr(streamId);
  const inner = new TextEncoder().encode(JSON.stringify(innerObj));
  const ciphertext = await encryptE2eRecord(state.keys, 'c2s', {
    tunnelId: state.tunnelId,
    streamId,
    ctr,
    kind,
    inner,
    relayBinding: state.relayBinding,
  });
  return encodeWireEnvelope({
    sid: state.transportHandle,
    ctr,
    kind,
    streamId,
    ciphertext,
  });
}

async function decryptInbound(wireRaw, expectedKind) {
  const wire = decodeWireEnvelope(wireRaw);
  if (!wire || wire.sid !== state.transportHandle) return null;
  const plain = await decryptE2eRecord(
    state.keys,
    's2c',
    {
      tunnelId: state.tunnelId,
      streamId: wire.streamId,
      ctr: wire.ctr,
      kind: wire.kind,
      ciphertext: wire.ciphertext,
      relayBinding: state.relayBinding,
    },
    s2cLedger,
  );
  if (!plain || plain.kind !== expectedKind) return null;
  return { wire, plain };
}

function randomId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function headersToObject(headers) {
  const out = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach(function (v, k) {
      out[k.toLowerCase()] = v;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (pair && pair.length >= 2) out[String(pair[0]).toLowerCase()] = String(pair[1]);
    }
    return out;
  }
  for (const k of Object.keys(headers)) {
    out[k.toLowerCase()] = String(headers[k]);
  }
  return out;
}

async function e2eFetch(input, init) {
  const reqUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const reqInit = init ? { ...init } : {};
  if (input instanceof Request) {
    reqInit.method = reqInit.method || input.method;
    reqInit.headers = reqInit.headers || input.headers;
    if (!reqInit.body && input.body) {
      reqInit.body = await input.clone().arrayBuffer();
    }
  }
  const u = new URL(reqUrl, location.origin);
  const method = (reqInit.method || 'GET').toUpperCase();
  let bodyB64 = '';
  if (reqInit.body) {
    const buf =
      reqInit.body instanceof ArrayBuffer
        ? reqInit.body
        : typeof reqInit.body === 'string'
          ? new TextEncoder().encode(reqInit.body).buffer
          : await new Response(reqInit.body).arrayBuffer();
    bodyB64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
  }
  const streamId = randomId();
  const hdrs = headersToObject(reqInit.headers);
  if (!hdrs.cookie && document.cookie) hdrs.cookie = document.cookie;
  const inner = {
    id: streamId,
    method,
    path: u.pathname + u.search,
    headers: hdrs,
    bodyB64,
  };
  const wire = await encryptOutbound('http-req', streamId, inner);
  const res = await origFetch.call(window, E2E_HTTP_PATH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    credentials: 'same-origin',
    body: wire,
  });
  const wireOut = await res.text();
  const decrypted = await decryptInbound(wireOut, 'http-res');
  if (!decrypted) {
    return new Response(JSON.stringify({ error: 'E2E decrypt failed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const httpRes = JSON.parse(new TextDecoder().decode(decrypted.plain.inner));
  const bodyBytes = httpRes.bodyB64
    ? Uint8Array.from(atob(httpRes.bodyB64), (c) => c.charCodeAt(0))
    : new Uint8Array(0);
  return new Response(bodyBytes, {
    status: httpRes.status || 502,
    headers: httpRes.headers || {},
  });
}

function createE2eWebSocket(url, protocols) {
  const u = new URL(url, location.origin);
  const realPath = u.pathname + u.search;
  const wsUrl =
    (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + E2E_WS_PATH;

  const socket = new OrigWebSocket(wsUrl, protocols);
  const streamId = randomId();
  let tunnelReady = false;
  const pendingSend = [];
  const openListeners = [];

  const origAdd = socket.addEventListener.bind(socket);
  socket.addEventListener = function (type, listener, opts) {
    if (type === 'open' && typeof listener === 'function') {
      openListeners.push(listener);
      return;
    }
    if (type === 'message' && typeof listener === 'function') {
      userOnMessage.push(listener);
      return;
    }
    return origAdd(type, listener, opts);
  };

  origAdd('open', function () {
    const inner = {
      path: realPath,
      headers: { cookie: document.cookie },
    };
    encryptOutbound('ws-open', streamId, inner)
      .then(function (wire) {
        origSend(wire);
        tunnelReady = true;
        for (const item of pendingSend) {
          origSend(item);
        }
        pendingSend.length = 0;
        for (const fn of openListeners) {
          try {
            fn.call(socket, new Event('open'));
          } catch {
            // ignore
          }
        }
      })
      .catch(function () {
        socket.close();
      });
  });

  const userOnMessage = [];
  const origSend = socket.send.bind(socket);
  socket.send = function (data) {
    const isBinary = data instanceof ArrayBuffer || data instanceof Uint8Array || data instanceof Blob;
    const payload = isBinary
      ? data
      : typeof data === 'string'
        ? data
        : String(data);
    Promise.resolve()
      .then(async function () {
        let bodyB64;
        let binary = false;
        if (payload instanceof Blob) {
          const buf = await payload.arrayBuffer();
          bodyB64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
          binary = true;
        } else if (payload instanceof ArrayBuffer) {
          bodyB64 = btoa(String.fromCharCode(...new Uint8Array(payload)));
          binary = true;
        } else if (payload instanceof Uint8Array) {
          bodyB64 = btoa(String.fromCharCode(...payload));
          binary = true;
        } else {
          // btoa() only accepts Latin1; a JSON string with non-ASCII content
          // (Cyrillic, emoji, …) throws InvalidCharacterError, which the
          // surrounding .catch() swallowed → the frame silently never sent.
          // UTF-8 encode first, mirroring the inbound TextDecoder path, and
          // chunk the byte→char conversion so large messages don't overflow
          // the call stack.
          const str =
            typeof payload === 'string' ? payload : new TextDecoder().decode(payload);
          const bytes = new TextEncoder().encode(str);
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          }
          bodyB64 = btoa(bin);
        }
        const wire = await encryptOutbound('ws-data', streamId, { binary, dataB64: bodyB64 });
        if (tunnelReady) origSend(wire);
        else pendingSend.push(wire);
      })
      .catch(function () {
        // ignore
      });
  };

  origAdd('message', function (ev) {
    const wireRaw = typeof ev.data === 'string' ? ev.data : '';
    if (!wireRaw) return;
    Promise.resolve()
      .then(async function () {
        const wire = decodeWireEnvelope(wireRaw);
        if (!wire) return;
        const plain = await decryptE2eRecord(
          state.keys,
          's2c',
          {
            tunnelId: state.tunnelId,
            streamId: wire.streamId,
            ctr: wire.ctr,
            kind: wire.kind,
            ciphertext: wire.ciphertext,
            relayBinding: state.relayBinding,
          },
          s2cLedger,
        );
        if (!plain) return;
        if (plain.kind === 'ws-data') {
          const inner = JSON.parse(new TextDecoder().decode(plain.inner));
          const bytes = Uint8Array.from(atob(inner.dataB64), (c) => c.charCodeAt(0));
          const msgEv = new MessageEvent('message', {
            data: inner.binary ? bytes.buffer : new TextDecoder().decode(bytes),
          });
          for (const fn of userOnMessage) {
            try {
              fn.call(socket, msgEv);
            } catch {
              // ignore
            }
          }
        } else if (plain.kind === 'ws-close') {
          try {
            socket.close();
          } catch {
            // ignore
          }
        }
      })
      .catch(function () {
        // ignore
      });
  });

  return socket;
}

let origFetch = null;
let OrigWebSocket = null;
let installed = false;

/** Load workspace HTML via encrypted /__ra/e2e/http (after OPAQUE login). */
export async function navigateViaE2eDocument(nextUrl) {
  const installed = await installRaE2eTransport();
  if (!installed) {
    throw new Error('Encrypted session not ready. Sign in with your passphrase again.');
  }
  const path =
    typeof nextUrl === 'string' && nextUrl.startsWith('/')
      ? nextUrl
      : typeof nextUrl === 'string' && nextUrl.startsWith('http')
        ? new URL(nextUrl).pathname + new URL(nextUrl).search
        : '/';
  const res = await window.fetch(path, {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
  if (!res.ok) {
    throw new Error('Could not load workspace (HTTP ' + res.status + ')');
  }
  const html = await res.text();
  document.open();
  document.write(html);
  document.close();
}

export async function installRaE2eTransport() {
  captureRelayAccessToken();
  captureRelayBindingFromPage();
  state = loadState();
  if (!state) {
    return false;
  }
  // Idempotent: navigateViaE2eDocument installs on the gate page, then the
  // document.write'd workspace re-runs the boot script (same realm → same
  // module instance). Re-wrapping would capture the already-wrapped fetch and
  // recurse, so install the hooks exactly once. `state` is still refreshed
  // above so the active wrappers pick up the current page's meta.
  if (installed) {
    return true;
  }
  origFetch = window.fetch.bind(window);
  OrigWebSocket = window.WebSocket;

  window.fetch = function (input, init) {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!shouldWrapUrl(url)) {
      return origFetch(input, init);
    }
    return e2eFetch(input, init);
  };

  window.WebSocket = function (url, protocols) {
    const u = new URL(url, location.origin);
    // Compare HOST, not origin: a wss:// URL has origin "wss://host" which
    // never equals the page's "https://host", so an origin check would wrongly
    // fall through to a direct (un-encrypted, relay-rejected) /ws connection.
    if (u.host !== location.host || !u.pathname.startsWith('/ws')) {
      return new OrigWebSocket(url, protocols);
    }
    return createE2eWebSocket(url, protocols);
  };
  window.WebSocket.prototype = OrigWebSocket.prototype;
  // Preserve the static readyState constants. App code commonly gates sends on
  // `ws.readyState === WebSocket.OPEN`; without these copied across, the
  // replacement constructor has `WebSocket.OPEN === undefined`, so every such
  // check is `1 === undefined` → false and outbound frames (e.g. a chat `send`)
  // silently never transmit — the message just re-queues forever.
  window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
  window.WebSocket.OPEN = OrigWebSocket.OPEN;
  window.WebSocket.CLOSING = OrigWebSocket.CLOSING;
  window.WebSocket.CLOSED = OrigWebSocket.CLOSED;
  installed = true;
  return true;
}
