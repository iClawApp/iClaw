/**
 * End-to-end encrypted chat sharing — client side.
 *
 * Flow on submit:
 *   1. Fetch the chat transcript (already on the page, but we ask the server
 *      for the canonical message list so the share matches what's persisted).
 *   2. JSON.stringify → gzip via CompressionStream → AES-256-GCM encrypt.
 *   3. If a password is set: derive a wrap-key with PBKDF2-SHA256 (200 000
 *      iterations) and wrap the real AES key with AES-GCM. The fragment key
 *      in the URL is NOT used in that case — only the password unlocks.
 *   4. POST ciphertext + metadata to iClaw-cloud → receive {id, url, expiresAt}.
 *   5. Show the URL (with `#k=<base64url(key)>` if no password).
 *
 * No part of this flow lets the share server see plaintext or keys.
 */

(() => {
  'use strict';

  const shareBtn = document.getElementById('share-btn');
  const modal = document.getElementById('share-modal');
  if (!shareBtn || !modal) return;

  const cloudBaseUrl = (shareBtn.dataset.cloudBaseUrl || '').replace(/\/+$/, '');
  if (!cloudBaseUrl) return;

  const $ = (sel) => modal.querySelector(sel);
  const formView = $('#share-form-view');
  const resultView = $('#share-result-view');
  const ttlSel = $('#share-ttl');
  const burnChk = $('#share-burn');
  const pwEnableChk = $('#share-pw-enable');
  const pwWrap = $('#share-pw-wrap');
  const pwInput = $('#share-pw');
  const submitBtn = $('#share-submit');
  const cancelBtn = $('#share-cancel');
  const closeBtn = $('#share-modal-close');
  const errorEl = $('#share-error');

  const resultMeta = $('#share-result-meta');
  const urlInput = $('#share-url');
  const copyBtn = $('#share-copy');
  const pwReminder = $('#share-pw-reminder');
  const newBtn = $('#share-new');
  const doneBtn = $('#share-done');

  /* ----------------------------------------- helpers ----------------- */

  function openModal() {
    showFormView();
    modal.hidden = false;
    setTimeout(() => ttlSel.focus(), 0);
  }
  function closeModal() {
    modal.hidden = true;
    errorEl.hidden = true;
    pwInput.value = '';
    pwEnableChk.checked = false;
    pwWrap.hidden = true;
    burnChk.checked = false;
    submitBtn.disabled = false;
    submitBtn.textContent = 'Generate link';
  }
  function showFormView() {
    formView.hidden = false;
    resultView.hidden = true;
  }
  function showResultView() {
    formView.hidden = true;
    resultView.hidden = false;
  }
  function setError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  shareBtn.addEventListener('click', openModal);
  closeBtn.addEventListener('click', closeModal);
  cancelBtn.addEventListener('click', closeModal);
  doneBtn.addEventListener('click', closeModal);
  newBtn.addEventListener('click', showFormView);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });
  pwEnableChk.addEventListener('change', () => {
    pwWrap.hidden = !pwEnableChk.checked;
    if (pwEnableChk.checked) pwInput.focus();
  });

  /* ----------------------------------------- crypto ------------------ */

  function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function bytesToBase64Url(bytes) {
    return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  async function gzip(bytes) {
    const cs = new CompressionStream('gzip');
    const stream = new Response(new Blob([bytes]).stream().pipeThrough(cs));
    return new Uint8Array(await stream.arrayBuffer());
  }

  async function importAesKey(raw, usages) {
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, usages);
  }

  async function deriveWrapKey(password, salt) {
    const base = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      { name: 'PBKDF2' },
      false,
      ['deriveKey'],
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 200_000, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  /* ----------------------------------------- collect chat ------------- */

  function getActiveChatId() {
    const el = document.getElementById('messages');
    const raw = el && el.dataset ? el.dataset.chatId : '';
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  async function fetchTranscript(chatId) {
    const res = await fetch(`/chats/${encodeURIComponent(chatId)}/messages`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error('Could not fetch transcript: HTTP ' + res.status);
    /** @type {Array<{id:number,role:string,content:string,created_at?:string}>} */
    const rows = await res.json();
    return rows.map((m) => ({
      role: m.role,
      content: m.content,
      createdAt: m.created_at || null,
    }));
  }

  /* ----------------------------------------- submit ------------------- */

  $('#share-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setError('');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Encrypting…';

    try {
      const chatId = getActiveChatId();
      if (!chatId) throw new Error('Open a chat first.');

      const ttlDays = Number(ttlSel.value);
      const burn = burnChk.checked;
      const password = pwEnableChk.checked ? (pwInput.value || '') : '';
      if (pwEnableChk.checked && password.length < 4) {
        throw new Error('Password must be at least 4 characters.');
      }

      // 1) gather data
      const titleEl = document.getElementById('chat-title-input');
      const agentSel = document.getElementById('chat-agent-select');
      const messages = await fetchTranscript(chatId);

      const payload = {
        version: 1,
        title: titleEl ? titleEl.value : 'Shared chat',
        agent: agentSel ? agentSel.value : null,
        sharedAt: new Date().toISOString(),
        messages,
      };
      const plaintextJson = new TextEncoder().encode(JSON.stringify(payload));

      // 2) gzip + encrypt
      const gz = await gzip(plaintextJson);
      const realKeyBytes = crypto.getRandomValues(new Uint8Array(32));
      const realKey = await importAesKey(realKeyBytes, ['encrypt']);
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ctBuf = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce },
        realKey,
        gz,
      );
      const ciphertext = new Uint8Array(ctBuf);

      // 3) optional password wrap
      let salt = null;
      let wrappedKey = null;
      if (password) {
        salt = crypto.getRandomValues(new Uint8Array(16));
        const wrapKey = await deriveWrapKey(password, salt);
        const wrapNonce = crypto.getRandomValues(new Uint8Array(12));
        const wrappedCtBuf = await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: wrapNonce },
          wrapKey,
          realKeyBytes,
        );
        // Pack 12-byte nonce + ciphertext into a single blob so the viewer
        // can read them back without a second field.
        const wrappedCt = new Uint8Array(wrappedCtBuf);
        wrappedKey = new Uint8Array(12 + wrappedCt.length);
        wrappedKey.set(wrapNonce, 0);
        wrappedKey.set(wrappedCt, 12);
      }

      // 4) upload
      submitBtn.textContent = 'Uploading…';
      const body = {
        ciphertext: bytesToBase64(ciphertext),
        nonce: bytesToBase64(nonce),
        salt: salt ? bytesToBase64(salt) : null,
        wrappedKey: wrappedKey ? bytesToBase64(wrappedKey) : null,
        hasPassword: Boolean(password),
        ttlDays,
        maxViews: burn ? 1 : null,
      };
      const res = await fetch(cloudBaseUrl + '/api/shares', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error('Server rejected the upload: ' + (t || res.status));
      }
      /** @type {{id:string, url:string, expiresAt:string}} */
      const data = await res.json();

      // 5) compose URL (with fragment key only when no password)
      const finalUrl = password
        ? data.url
        : data.url + '#k=' + bytesToBase64Url(realKeyBytes);

      urlInput.value = finalUrl;
      const expires = new Date(data.expiresAt);
      const parts = [
        'expires ' + expires.toLocaleString(),
        burn ? 'burns after first view' : null,
        password ? 'password-protected' : 'fragment-key only',
      ].filter(Boolean);
      resultMeta.textContent = parts.join(' · ');
      pwReminder.hidden = !password;

      showResultView();
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      setError(msg);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Generate link';
    }
  });

  /* ----------------------------------------- copy --------------------- */

  copyBtn.addEventListener('click', async () => {
    if (!urlInput.value) return;
    try {
      await navigator.clipboard.writeText(urlInput.value);
      const prev = copyBtn.textContent;
      copyBtn.textContent = 'Copied';
      copyBtn.disabled = true;
      setTimeout(() => {
        copyBtn.textContent = prev || 'Copy';
        copyBtn.disabled = false;
      }, 1500);
    } catch {
      urlInput.select();
    }
  });
})();
