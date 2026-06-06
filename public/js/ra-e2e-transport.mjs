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
  const ready = await installRaE2eTransport();
  if (!ready) {
    throw new Error('Encrypted session not ready. Sign in with your passphrase again.');
  }
  const toPath = function (u) {
    try {
      const url = new URL(u, location.origin);
      if (url.origin !== location.origin) return null;
      return url.pathname + url.search;
    } catch {
      return null;
    }
  };
  let path = toPath(nextUrl) || '/';
  let html = null;
  // Follow same-origin redirects over the encrypted channel. The relay/server
  // returns 3xx as-is (it doesn't follow them), so without this a redirecting
  // route — e.g. the 302 after a POST, or a GET that redirects — would fall
  // through to a full navigation and bounce off the gate again.
  for (let hop = 0; hop < 5; hop++) {
    const res = await window.fetch(path, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'text/html,application/xhtml+xml' },
      redirect: 'manual',
    });
    if (res.status >= 300 && res.status < 400) {
      const next = toPath(res.headers.get('location') || '');
      if (!next) throw new Error('Could not follow redirect (HTTP ' + res.status + ')');
      path = next;
      continue;
    }
    if (!res.ok) {
      throw new Error('Could not load workspace (HTTP ' + res.status + ')');
    }
    html = await res.text();
    break;
  }
  if (html == null) {
    throw new Error('Too many redirects loading workspace');
  }
  // Reflect the final URL (after any redirects) in the address bar.
  try {
    history.replaceState({ iclawE2eSpa: true }, '', path);
  } catch {
    // ignore
  }
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

/* ---------------------------------------------------------- SPA routing -- */
// Through a tunnel, every *full-page* navigation is answered with the
// passphrase gate ("Checking this device…") — the browser's own navigation
// request can't be E2E-wrapped, only fetch()/WebSocket can. So clicking from
// page to page flashes the gate each time while it re-establishes the channel
// and pulls the page over /__ra/e2e/http.
//
// These helpers keep navigation inside the already-installed encrypted
// transport: intercept in-app link clicks (and expose e2eNavigate() for the
// few programmatic navigations in iclaw.js), fetch the next page over the
// existing channel, and replace the document in place. iclaw.js still boots
// exactly once per page (document.write re-runs it), so there's no
// double-binding of its document/WebSocket listeners — same single-load model,
// just without the gate round trip.

let spaBound = false;
let spaNavInFlight = false;
let spaNavTimer = null;

function isE2eEnabled() {
  const meta = document.querySelector('meta[name="iclaw-ra-e2e"]');
  return !!(meta && meta.getAttribute('content') === 'true');
}

// Dev-only tracing (gated on window.__ICLAW_DEV__, set by head.ejs). Lets us see
// in the console whether a navigation went over E2E or fell back to the gate.
function spaLog() {
  try {
    const on = window.__ICLAW_DEV__ || localStorage.getItem('iclaw:spa-debug') === '1';
    if (on) {
      console.debug.apply(console, ['[iclaw][e2e-spa]'].concat([].slice.call(arguments)));
    }
  } catch {
    // ignore
  }
}

function beginSpaNav() {
  spaNavInFlight = true;
  // Self-healing latch: if the destination never re-initialises (e.g. its boot
  // import fails after document.write), don't block navigation forever. Timers
  // survive document.open(), so this clears even on the failure path.
  try {
    if (spaNavTimer) clearTimeout(spaNavTimer);
  } catch {
    // ignore
  }
  spaNavTimer = setTimeout(function () {
    spaNavInFlight = false;
  }, 20000);
}

/**
 * Navigate to a same-origin in-app URL over the encrypted transport, without
 * bouncing through the passphrase gate. Falls back to a normal navigation when
 * E2E isn't active or the encrypted load fails. Also exposed on
 * window.iclawE2eNavigate so iclaw.js can route its programmatic navigations.
 */
export async function e2eNavigate(nextUrl, opts) {
  if (!isE2eEnabled()) {
    window.location.assign(nextUrl);
    return;
  }
  let path;
  try {
    const u = new URL(nextUrl, location.origin);
    if (u.origin !== location.origin) {
      window.location.assign(nextUrl);
      return;
    }
    path = u.pathname + u.search + u.hash;
  } catch {
    window.location.assign(nextUrl);
    return;
  }
  if (spaNavInFlight) {
    spaLog('navigate skipped — already in flight, wanted', path);
    return;
  }
  beginSpaNav();
  try {
    if (opts && opts.replace) history.replaceState({ iclawE2eSpa: true }, '', path);
    else history.pushState({ iclawE2eSpa: true }, '', path);
  } catch {
    // ignore — address bar stays put, the content still swaps below
  }
  // Retry once before surrendering to a full navigation: a transient transport
  // hiccup (a dropped relay frame, a decrypt miss) shouldn't bounce the user
  // through the gate when a second encrypted attempt would just work.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await navigateViaE2eDocument(path);
      return; // success — the document is being replaced
    } catch (err) {
      const msg = (err && err.message) || String(err);
      if (attempt === 0) {
        spaLog('navigate attempt failed, retrying:', path, msg);
        await new Promise(function (r) {
          setTimeout(r, 150);
        });
        continue;
      }
      spaLog('navigate FELL BACK to full navigation (→ gate):', path, msg);
      spaNavInFlight = false;
      window.location.assign(path);
      return;
    }
  }
}

function spaShouldIntercept(a) {
  if (!a) return false;
  const target = a.getAttribute('target');
  if (target && target !== '_self') return false; // _blank etc. → let it open
  if (a.hasAttribute('download')) return false;
  if (a.dataset && typeof a.dataset.noSpa !== 'undefined') return false; // opt-out
  const href = a.getAttribute('href');
  if (!href || href.charAt(0) === '#') return false;
  let u;
  try {
    u = new URL(href, location.href);
  } catch {
    return false;
  }
  if (u.origin !== location.origin) return false; // external link
  const p = u.pathname;
  if (
    p.startsWith('/__ra/') ||
    p.startsWith('/js/') ||
    p.startsWith('/css/') ||
    p.startsWith('/uploads/') ||
    p.startsWith('/favicon')
  ) {
    return false; // non-page / asset / gate endpoints
  }
  // Same path, only a fragment differs → let the browser scroll natively.
  if (u.pathname === location.pathname && u.search === location.search && u.hash) {
    return false;
  }
  return true;
}

function onSpaClick(e) {
  if (e.defaultPrevented) {
    spaLog('click ignored — defaultPrevented (handled by app JS)');
    return; // iclaw.js already handled this click
  }
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const start = e.target;
  const a = start && start.closest ? start.closest('a[href]') : null;
  if (!a) return;
  if (!spaShouldIntercept(a)) {
    // Surface same-origin links we deliberately let full-navigate — these are
    // the ones that would show the gate. (External/asset links are expected.)
    const href = a.getAttribute('href') || '';
    let sameOrigin = false;
    try {
      sameOrigin = new URL(href, location.href).origin === location.origin;
    } catch {
      sameOrigin = false;
    }
    if (sameOrigin) spaLog('click NOT intercepted → full navigation:', href);
    return;
  }
  const u = new URL(a.getAttribute('href'), location.href);
  e.preventDefault();
  spaLog('intercept click →', u.pathname + u.search);
  e2eNavigate(u.pathname + u.search + u.hash);
}

function onSpaPopState() {
  if (!isE2eEnabled()) return;
  if (spaNavInFlight) return;
  beginSpaNav();
  // The browser already moved the address bar; just render the current URL.
  navigateViaE2eDocument(location.pathname + location.search).catch(function () {
    spaNavInFlight = false;
    window.location.reload();
  });
}

function spaToPath(u) {
  try {
    const url = new URL(u, location.href);
    if (url.origin !== location.origin) return null;
    return url.pathname + url.search;
  } catch {
    return null;
  }
}

async function submitFormOverE2e(form, method, actionPath) {
  if (spaNavInFlight) return;
  beginSpaNav();
  try {
    const body = new URLSearchParams(new FormData(form)).toString();
    let res;
    if (method === 'get') {
      const base = actionPath.split('#')[0].split('?')[0];
      res = await window.fetch(base + (body ? '?' + body : ''), {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'text/html,application/xhtml+xml' },
        redirect: 'manual',
      });
    } else {
      res = await window.fetch(actionPath, {
        method: method.toUpperCase(),
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          Accept: 'text/html,application/xhtml+xml',
        },
        body,
        redirect: 'manual',
      });
    }
    if (res.status >= 300 && res.status < 400) {
      // Post/Redirect/Get: load the redirect target over the encrypted channel.
      const target = spaToPath(res.headers.get('location') || '/');
      spaNavInFlight = false;
      if (target == null) {
        window.location.assign(res.headers.get('location') || '/');
        return;
      }
      return e2eNavigate(target);
    }
    if (res.ok) {
      const html = await res.text();
      try {
        history.pushState({ iclawE2eSpa: true }, '', actionPath);
      } catch {
        // ignore
      }
      document.open();
      document.write(html);
      document.close();
      return;
    }
    // Non-OK with a body (e.g. a re-rendered form with validation errors) —
    // show it; otherwise fall back to a real submit.
    const errHtml = await res.text().catch(() => '');
    if (errHtml) {
      document.open();
      document.write(errHtml);
      document.close();
      return;
    }
    spaNavInFlight = false;
    form.submit();
  } catch (err) {
    spaNavInFlight = false;
    try {
      form.submit();
    } catch {
      // ignore
    }
  }
}

function onSpaSubmit(e) {
  if (e.defaultPrevented) return; // JS-handled form (onsubmit="return false", etc.)
  const form = e.target;
  if (!form || form.tagName !== 'FORM') return;
  if (form.dataset && typeof form.dataset.noSpa !== 'undefined') return; // opt-out
  // Only forms that point at a concrete endpoint. Forms without an explicit
  // action (the composer, search, inline-edit forms) are app-JS-driven — never
  // ours to take over.
  const actionAttr = form.getAttribute('action');
  if (!actionAttr) return;
  const method = (form.getAttribute('method') || 'get').toLowerCase();
  if (method !== 'get' && method !== 'post') return; // skip method="dialog", etc.
  if ((form.getAttribute('enctype') || '').toLowerCase().indexOf('multipart') !== -1) {
    return; // file uploads — let the browser handle them
  }
  const actionPath = spaToPath(actionAttr);
  if (actionPath == null) return; // external / unparseable action
  const p = actionPath.split('?')[0];
  if (
    p.startsWith('/__ra/') ||
    p.startsWith('/js/') ||
    p.startsWith('/css/') ||
    p.startsWith('/uploads/')
  ) {
    return;
  }
  e.preventDefault();
  submitFormOverE2e(form, method, actionPath);
}

/**
 * Install in-app navigation interception. Called from every workspace page's
 * boot (head.ejs), which re-runs after each document.write swap.
 *
 * Listeners are bound on window and rebound *idempotently* (remove-then-add) on
 * every page. In theory window listeners survive document.open() (same realm),
 * so binding once would do — but if a swap ever drops them, an unbound page
 * would silently let chat-link clicks full-navigate and flash the gate. Removing
 * first guarantees exactly one handler whether or not they persisted.
 */
export function setupE2eSpaNavigation() {
  if (!isE2eEnabled()) return;
  // Fresh page after a swap — release the latch and its safety timer.
  spaNavInFlight = false;
  try {
    if (spaNavTimer) clearTimeout(spaNavTimer);
  } catch {
    // ignore
  }
  spaNavTimer = null;
  // Bubble phase: anything iclaw.js handled (and stopped/prevented) never
  // reaches window, so we only take over genuinely unclaimed link/form events.
  window.removeEventListener('click', onSpaClick);
  window.removeEventListener('submit', onSpaSubmit);
  window.removeEventListener('popstate', onSpaPopState);
  window.addEventListener('click', onSpaClick);
  window.addEventListener('submit', onSpaSubmit);
  window.addEventListener('popstate', onSpaPopState);
  spaLog('SPA navigation armed', spaBound ? '(re-armed)' : '(first)', location.pathname);
  spaBound = true;
}
