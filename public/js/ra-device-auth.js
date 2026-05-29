/**
 * Remote Access trusted-device login (Ed25519 + IndexedDB).
 * Loaded only on the tunneled passphrase gate page.
 */
(function () {
  'use strict';

  var DB_NAME = 'iclaw-remote-access';
  var DB_VERSION = 1;
  var STORE = 'devices';

  function tunnelIdFromMeta() {
    var el = document.querySelector('meta[name="iclaw-ra-tunnel-id"]');
    return el ? el.getAttribute('content') || '' : '';
  }

  function nextFromMeta() {
    var el = document.querySelector('meta[name="iclaw-ra-next"]');
    return el ? el.getAttribute('content') || '/' : '/';
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

  function importPrivateKey(jwk) {
    return crypto.subtle.importKey('pkcs8', jwk, { name: 'Ed25519' }, false, ['sign']);
  }

  function generateKeypair() {
    return crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']).then(function (pair) {
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

  function finishLoginSuccess(tunnelId, next, login) {
    if (login.deviceId && login.privateKeyJwk) {
      return saveDevice({
        tunnelId: tunnelId,
        deviceId: login.deviceId,
        privateKeyJwk: login.privateKeyJwk,
      }).then(function () {
        redirectTo(login.next || next);
      });
    }
    redirectTo(login.next || next);
  }

  function tryDeviceLogin(tunnelId, record, next) {
    return postJson('/__ra/device/challenge', { deviceId: record.deviceId, next: next })
      .then(function (ch) {
        if (!ch.ok) throw new Error('challenge failed');
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
        if (!verified.ok) throw new Error('verify failed');
        redirectTo(verified.data.next || next);
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

  function wirePassphraseForm(tunnelId, next) {
    var form = document.getElementById('ra-gate-form');
    if (!form) return;

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var passInput = form.querySelector('#p');
      var passphrase = passInput ? passInput.value : '';
      var submitBtn = form.querySelector('.ra-gate-submit');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Continuing…';
      }

      generateKeypair()
        .then(function (keys) {
          return runOpaqueLogin(passphrase, next, keys).then(function (login) {
            clearPassphraseInput(passInput);
            return finishLoginSuccess(tunnelId, next, login);
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
    });
  }

  function init() {
    if (!window.crypto || !window.crypto.subtle || !window.indexedDB) {
      showPassphraseForm();
      return;
    }
    var tunnelId = tunnelIdFromMeta();
    var next = nextFromMeta();
    if (!tunnelId) {
      showPassphraseForm();
      return;
    }
    wirePassphraseForm(tunnelId, next);
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
