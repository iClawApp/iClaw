/**
 * Remote Access trusted-device login (Ed25519 + IndexedDB).
 * Loaded only on the tunneled passphrase gate page.
 */
(function () {
  'use strict';

  var DB_NAME = 'iclaw-remote-access';
  var DB_VERSION = 1;
  var STORE = 'devices';

  // Gated diagnostic logging — set localStorage.ra_debug='1' (or ?radebug=1)
  // in the browser to see the gate/resume flow. Silent otherwise.
  function dbg() {
    try {
      if (localStorage.getItem('ra_debug') === '1' || /[?&]radebug=1/.test(location.search)) {
        console.log.apply(console, ['[ra-dbg]'].concat([].slice.call(arguments)));
      }
    } catch (e) {
      /* ignore */
    }
  }

  function tunnelIdFromMeta() {
    var el = document.querySelector('meta[name="iclaw-ra-tunnel-id"]');
    return el ? el.getAttribute('content') || '' : '';
  }

  function nextFromMeta() {
    var el = document.querySelector('meta[name="iclaw-ra-next"]');
    return el ? el.getAttribute('content') || '/' : '/';
  }

  function isTunneledGate() {
    var el = document.querySelector('meta[name="iclaw-ra-e2e"]');
    return el ? el.getAttribute('content') === 'true' : false;
  }

  function b64urlEncode(buf) {
    var bytes = new Uint8Array(buf);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function b64urlDecode(str) {
    var pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    var b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = function () {
        reject(req.error);
      };
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'tunnelId' });
        }
      };
      req.onsuccess = function () {
        resolve(req.result);
      };
    });
  }

  function loadDevice(tunnelId) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var store = tx.objectStore(STORE);
        var get = store.get(tunnelId);
        get.onsuccess = function () {
          resolve(get.result || null);
        };
        get.onerror = function () {
          reject(get.error);
        };
      });
    });
  }

  function saveDevice(record) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        var store = tx.objectStore(STORE);
        var put = store.put(record);
        put.onsuccess = function () {
          resolve();
        };
        put.onerror = function () {
          reject(put.error);
        };
      });
    });
  }

  function deleteDevice(tunnelId) {
    return openDb()
      .then(function (db) {
        return new Promise(function (resolve) {
          var tx = db.transaction(STORE, 'readwrite');
          tx.objectStore(STORE).delete(tunnelId);
          tx.oncomplete = function () {
            resolve();
          };
          tx.onerror = function () {
            resolve();
          };
        });
      })
      .catch(function () {
        // best-effort
      });
  }

  function importPrivateKey(jwk) {
    return crypto.subtle.importKey('pkcs8', jwk, { name: 'Ed25519' }, false, ['sign']);
  }

  function generateKeypair() {
    return crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']).then(function (pair) {
      return Promise.all([
        crypto.subtle.exportKey('pkcs8', pair.privateKey),
        crypto.subtle.exportKey('spki', pair.publicKey),
      ]).then(function (parts) {
        return {
          privateKeyJwk: parts[0],
          publicKeySpki: b64urlEncode(parts[1]),
        };
      });
    });
  }

  function signChallenge(privateKey, challengeB64) {
    return crypto.subtle.sign('Ed25519', privateKey, b64urlDecode(challengeB64)).then(function (sig) {
      return b64urlEncode(sig);
    });
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    }).then(function (res) {
      return res.json().then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    });
  }

  function showPassphraseForm() {
    var loading = document.getElementById('ra-gate-loading');
    var form = document.getElementById('ra-gate-form');
    if (loading) loading.hidden = true;
    if (form) {
      form.hidden = false;
      var input = form.querySelector('#p');
      if (input) input.focus();
    }
  }

  function redirectTo(next) {
    window.location.replace(next || '/');
  }

  function showFormError(form, message) {
    var existing = form.querySelector('.ra-gate-error');
    if (existing) existing.remove();
    var div = document.createElement('div');
    div.className = 'ra-gate-error';
    div.setAttribute('role', 'alert');
    div.textContent = message;
    var lead = form.querySelector('.ra-gate-lead');
    if (lead && lead.nextSibling) form.insertBefore(div, lead.nextSibling);
    else form.insertBefore(div, form.firstChild);
  }

  function resetSubmitButton(submitBtn) {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Continue';
    }
  }

  function clearPassphraseInput(passInput) {
    if (passInput) passInput.value = '';
  }

  function hasE2eSessionKeys() {
    return !!(
      sessionStorage.getItem('iclaw_e2e_opaque_sk') &&
      sessionStorage.getItem('iclaw_e2e_transport')
    );
  }

  function redirectAfterAuth(next) {
    var target = next || '/';
    if (isTunneledGate() && hasE2eSessionKeys()) {
      return import('/js/ra-e2e-transport.mjs?v=ra-gate-8')
        .then(function (m) {
          return m.navigateViaE2eDocument(target);
        })
        .catch(function (err) {
          var form = document.getElementById('ra-gate-form');
          if (form) {
            showFormError(
              form,
              err && err.message ? err.message : 'Could not open encrypted workspace.',
            );
          }
        });
    }
    if (isTunneledGate() && !hasE2eSessionKeys()) {
      showPassphraseForm();
      var form = document.getElementById('ra-gate-form');
      if (form) {
        showFormError(form, 'Enter your passphrase to start an encrypted session.');
      }
      return;
    }
    redirectTo(target);
  }

  function finishLoginSuccess(tunnelId, next, login) {
    if (login.deviceId && login.privateKeyJwk) {
      return saveDevice({
        tunnelId: tunnelId,
        deviceId: login.deviceId,
        privateKeyJwk: login.privateKeyJwk,
      }).then(function () {
        return redirectAfterAuth(login.next || next);
      });
    }
    return redirectAfterAuth(login.next || next);
  }

  // If the server no longer recognises this device (revoked / unknown), drop
  // the stale local record so the next passphrase login registers a fresh one
  // instead of reusing a dead device forever.
  function dropIfRejected(tunnelId, res) {
    if (res && res.status === 403) {
      return deleteDevice(tunnelId).then(function () {
        throw new Error('device revoked');
      });
    }
    return null;
  }

  function tryDeviceLogin(tunnelId, record, next) {
    return postJson('/__ra/device/challenge', { deviceId: record.deviceId, next: next })
      .then(function (ch) {
        if (!ch.ok) return dropIfRejected(tunnelId, ch) || Promise.reject(new Error('challenge failed'));
        return importPrivateKey(record.privateKeyJwk).then(function (priv) {
          return signChallenge(priv, ch.data.challenge).then(function (signature) {
            return postJson('/__ra/device/verify', {
              deviceId: record.deviceId,
              challengeId: ch.data.challengeId,
              signature: signature,
              next: next,
            });
          });
        });
      })
      .then(function (verified) {
        if (!verified.ok) return dropIfRejected(tunnelId, verified) || Promise.reject(new Error('verify failed'));
        return redirectAfterAuth(verified.data.next || next);
      });
  }

  function runOpaqueLogin(passphrase, next, keys) {
    if (typeof window.iclawRaOpaqueLogin !== 'function') {
      return Promise.reject(
        new Error('Secure login is still loading. Please wait a moment and try again.'),
      );
    }
    return window.iclawRaOpaqueLogin({
      passphrase: passphrase,
      next: next,
      keys: keys ? { publicKeySpki: keys.publicKeySpki } : null,
    }).then(function (result) {
      return {
        next: result.next,
        deviceId: result.deviceId,
        privateKeyJwk: keys ? keys.privateKeyJwk : null,
      };
    });
  }

  function runPassphraseLogin(form, tunnelId, next) {
    if (!window.isSecureContext || !window.crypto || !window.crypto.subtle) {
      showFormError(
        form,
        'Secure login requires HTTPS. Open the access link from relay.iclaw.digital (not http://*.lvh.me).',
      );
      return;
    }
    if (!window.indexedDB) {
      showFormError(form, 'This browser cannot store trusted devices (IndexedDB unavailable).');
      return;
    }

    var passInput = form.querySelector('#p');
    var passphrase = passInput ? passInput.value : '';
    var submitBtn = form.querySelector('.ra-gate-submit');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Continuing…';
    }

    // Reuse the device already registered for this browser instead of minting a
    // new keypair on every login — otherwise each passphrase entry spawns a
    // duplicate "Connected devices" record. Only register when none exists
    // (first login here, or after the server revoked the previous one).
    loadDevice(tunnelId)
      .catch(function () {
        return null;
      })
      .then(function (existing) {
        var haveDevice = !!(existing && existing.deviceId && existing.privateKeyJwk);
        var keysPromise = haveDevice ? Promise.resolve(null) : generateKeypair();
        return keysPromise.then(function (keys) {
          return runOpaqueLogin(passphrase, next, keys).then(function (login) {
            clearPassphraseInput(passInput);
            return finishLoginSuccess(tunnelId, next, login);
          });
        });
      })
      .catch(function (err) {
        clearPassphraseInput(passInput);
        resetSubmitButton(submitBtn);
        var msg =
          err && err.message
            ? err.message
            : 'Could not reach the server. Check your connection and try again.';
        showFormError(form, msg);
      });
  }

  function wirePassphraseForm(tunnelId, next) {
    var form = document.getElementById('ra-gate-form');
    if (!form) return;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
    });

    var submitBtn = form.querySelector('.ra-gate-submit');
    if (submitBtn) {
      submitBtn.addEventListener('click', function () {
        runPassphraseLogin(form, tunnelId, next);
      });
    }

    var passInput = form.querySelector('#p');
    if (passInput) {
      passInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          runPassphraseLogin(form, tunnelId, next);
        }
      });
    }
  }

  function init() {
    var tunnelId = tunnelIdFromMeta();
    var next = nextFromMeta();
    if (!tunnelId) {
      showPassphraseForm();
      return;
    }

    wirePassphraseForm(tunnelId, next);

    dbg('init: tunnelId=', tunnelId, 'next=', next, 'tunneledGate=', isTunneledGate(),
      'hasE2eKeys=', hasE2eSessionKeys(), 'secureCtx=', window.isSecureContext, 'indexedDB=', !!window.indexedDB);

    // Same-tab resume. This gate page is also the bootstrap for in-app
    // navigations (clicking a chat, reload, deep-link) — the workspace is a
    // multi-page app and a full navigation can't be E2E-wrapped, so the server
    // answers it with this page. If the tab already has an E2E session
    // (sessionStorage survives same-tab navigations), re-establish the
    // encrypted transport and load the requested page WITHOUT asking for the
    // passphrase again. Only a fresh tab (keys gone) falls through to login.
    if (isTunneledGate() && hasE2eSessionKeys()) {
      dbg('resume: importing transport + navigateViaE2eDocument', next);
      import('/js/ra-e2e-transport.mjs?v=ra-gate-8')
        .then(function (m) {
          dbg('resume: transport module loaded, navigating…');
          return m.navigateViaE2eDocument(next);
        })
        .then(function () {
          dbg('resume: navigateViaE2eDocument resolved (document.write done)');
        })
        .catch(function (err) {
          // Keys are stale (e.g. iClaw restarted and dropped the session) —
          // clear them and fall back to the passphrase.
          dbg('resume: FAILED →', err && err.message ? err.message : err, err);
          try {
            sessionStorage.removeItem('iclaw_e2e_opaque_sk');
            sessionStorage.removeItem('iclaw_e2e_transport');
          } catch (e) {
            // ignore
          }
          showPassphraseForm();
          var form = document.getElementById('ra-gate-form');
          if (form) {
            showFormError(form, 'Your secure session expired. Enter the passphrase to continue.');
          }
        });
      return;
    }

    dbg('init: no same-tab resume → device/passphrase path');

    if (!window.isSecureContext || !window.crypto || !window.crypto.subtle || !window.indexedDB) {
      showPassphraseForm();
      var form = document.getElementById('ra-gate-form');
      if (form && isTunneledGate()) {
        showFormError(
          form,
          'Secure login requires HTTPS (e.g. https://your-tunnel.iclaw.digital). HTTP dev URLs cannot use OPAQUE.',
        );
      }
      return;
    }

    loadDevice(tunnelId)
      .then(function (record) {
        if (!record || !record.deviceId || !record.privateKeyJwk) {
          showPassphraseForm();
          return;
        }
        return tryDeviceLogin(tunnelId, record, next).catch(function () {
          showPassphraseForm();
        });
      })
      .catch(function () {
        showPassphraseForm();
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
