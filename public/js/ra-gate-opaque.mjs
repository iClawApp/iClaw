/**
 * OPAQUE passphrase login for Remote Access gate (tunneled E2E alpha).
 * Passphrase stays in memory only — never sent to POST /__ra/login.
 */
import * as opaque from '/js/vendor/opaque/index.js';

await opaque.ready;

function postJson(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  })
    .then(function (res) {
      return res.json().then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    })
    .catch(function () {
      throw new Error('Could not reach the server. Check your connection and try again.');
    });
}

function loginError(res) {
  if (res.data && typeof res.data.error === 'string') return res.data.error;
  if (res.status === 401) return 'Wrong passphrase.';
  if (res.status >= 500) return 'Remote Access login is not ready. Check iClaw settings and restart.';
  return 'Login failed';
}

/**
 * @param {{ passphrase: string, next: string, keys?: { publicKeySpki: string } | null }} opts
 * @returns {Promise<{ next: string, deviceId: string | null }>}
 */
async function opaquePassphraseLogin(opts) {
  const password = opts.passphrase;
  const next = opts.next || '/';

  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({ password });

  const start = await postJson('/__ra/opaque/login/start', { startLoginRequest });
  if (!start.ok) {
    throw new Error(loginError(start));
  }

  const loginResponse = start.data.loginResponse;
  const loginStateId = start.data.loginStateId;
  if (typeof loginResponse !== 'string' || typeof loginStateId !== 'string') {
    throw new Error('Login failed');
  }

  const clientResult = opaque.client.finishLogin({
    clientLoginState,
    loginResponse,
    password,
  });
  if (!clientResult) {
    throw new Error('Wrong passphrase.');
  }

  const finishBody = {
    loginStateId,
    finishLoginRequest: clientResult.finishLoginRequest,
    next,
  };
  if (opts.keys && opts.keys.publicKeySpki) {
    finishBody.registerDevice = {
      publicKey: opts.keys.publicKeySpki,
      name: null,
      userAgent: navigator.userAgent || '',
    };
  }

  const finish = await postJson('/__ra/opaque/login/finish', finishBody);
  if (!finish.ok) {
    throw new Error(loginError(finish));
  }

  try {
    sessionStorage.setItem('iclaw_e2e_opaque_sk', clientResult.sessionKey);
    if (typeof finish.data.transportHandle === 'string') {
      sessionStorage.setItem('iclaw_e2e_transport', finish.data.transportHandle);
    }
    const access = new URLSearchParams(location.search).get('access');
    if (access) sessionStorage.setItem('iclaw_relay_access_raw', access);
    const bindingMeta = document.querySelector('meta[name="iclaw-ra-relay-binding"]');
    const bindingB64 = bindingMeta ? bindingMeta.getAttribute('content') || '' : '';
    if (bindingB64) sessionStorage.setItem('iclaw_relay_binding_b64', bindingB64);
  } catch {
    // ignore quota errors
  }

  return {
    next: typeof finish.data.next === 'string' ? finish.data.next : next,
    deviceId: typeof finish.data.deviceId === 'string' ? finish.data.deviceId : null,
  };
}

window.iclawRaOpaqueLogin = opaquePassphraseLogin;
