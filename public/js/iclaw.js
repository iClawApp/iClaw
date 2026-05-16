// iClaw browser client — one WebSocket to /ws drives the whole UI.
//
// Responsibilities:
//   - Open and auto-reconnect a WebSocket to the iClaw server
//   - Subscribe to the active chat (if any) and any chat the user is in
//   - Render incoming events: message-appended, turn-delta, turn-tool, …
//   - Sidebar live updates: chat-created / chat-updated / chat-deleted
//   - Replace the page's compose-form submit with a WS send
//   - Hydrate already-server-rendered markdown bodies on load

(function () {
  // -------------------------------------------------------------------------
  // shared DOM handles + state
  // -------------------------------------------------------------------------
  const messagesEl = document.getElementById('messages');
  const queueEl = document.getElementById('queue');
  const form = document.getElementById('send-form');
  const input = document.getElementById('composer-input');
  const button = form?.querySelector('button');
  const titleInput = document.getElementById('chat-title-input');
  const draftAgentSelect = document.getElementById('draft-agent');
  const stopBtn = document.getElementById('stop-btn');

  const rawChatId = messagesEl?.dataset.chatId;
  const startedOnDraft = messagesEl?.dataset.draft === '1' || !rawChatId;
  let activeChatId = startedOnDraft ? null : Number(rawChatId);

  // local queue used while a turn for *this* tab is in-flight; the server
  // serializes turns per chat too, so this is just for the visible label
  const waitingItems = [];
  let inFlight = false;
  /** the assistant DOM node we're streaming into right now */
  let currentStreamEl = null;
  let currentStreamFullText = '';

  // -------------------------------------------------------------------------
  // markdown
  // -------------------------------------------------------------------------
  const VIDEO_EXT_RE = /\.(mp4|webm|ogg|mov|m4v)(\?[^#]*)?$/i;
  if (window.marked) {
    if (typeof window.marked.setOptions === 'function') {
      window.marked.setOptions({ breaks: true, gfm: true });
    }
    if (typeof window.marked.use === 'function') {
      window.marked.use({
        renderer: {
          link(token) {
            const href = (token && token.href) || '';
            const text = (token && token.text) || '';
            if (VIDEO_EXT_RE.test(href) && !/<img/i.test(text)) {
              const safe = String(href).replace(/"/g, '&quot;');
              return (
                '<video controls preload="metadata" src="' + safe + '">' +
                'Your browser does not support video.' +
                '</video>'
              );
            }
            return false;
          },
        },
      });
    }
  }
  function renderMarkdown(text) {
    const src = String(text ?? '');
    if (!window.marked || typeof window.marked.parse !== 'function') return escapeHtml(src);
    try { return window.marked.parse(src); } catch { return escapeHtml(src); }
  }
  function escapeHtml(s) {
    return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  }
  function decorateLinks(root) {
    root.querySelectorAll('a[href]').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
  }

  // -------------------------------------------------------------------------
  // DOM building blocks
  // -------------------------------------------------------------------------
  function clearEmptyState() {
    if (messagesEl) {
      const empty = messagesEl.querySelector('.empty-state');
      if (empty) empty.remove();
    }
  }
  function scrollToBottom() {
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function appendMessage(msg, opts) {
    if (!messagesEl) return null;
    clearEmptyState();
    const div = document.createElement('div');
    div.className = 'msg ' + (msg.role || 'system');
    if (msg.id) div.dataset.msgId = String(msg.id);
    if (opts?.pendingId) div.classList.add('pending-id');
    div.innerHTML =
      '<div class="role">' + escapeHtml(msg.role || 'system') + '</div>' +
      '<div class="msg-body">' + renderMarkdown(msg.content || '') + '</div>';
    decorateLinks(div);
    messagesEl.appendChild(div);
    scrollToBottom();
    return div;
  }
  function appendStreamingAssistant() {
    if (!messagesEl) return null;
    clearEmptyState();
    const div = document.createElement('div');
    div.className = 'msg assistant streaming stream-waiting';
    div.innerHTML =
      '<div class="role">assistant</div>' +
      '<div class="stream-status">Thinking…</div>' +
      '<div class="msg-body stream-body"></div>';
    messagesEl.appendChild(div);
    scrollToBottom();
    return div;
  }
  /**
   * Get or create the assistant streaming element. If the page was loaded
   * mid-turn there's an #reload-placeholder we adopt; otherwise we spawn a
   * fresh one. This is the single source of truth — never call
   * appendStreamingAssistant() directly elsewhere.
   */
  function ensureStreamEl() {
    if (currentStreamEl && messagesEl?.contains(currentStreamEl)) return currentStreamEl;
    const placeholder = document.getElementById('reload-placeholder');
    if (placeholder) {
      placeholder.id = '';
      currentStreamEl = placeholder;
      // Make sure it's classified as streaming so our state CSS applies
      currentStreamEl.classList.add('streaming');
      return currentStreamEl;
    }
    currentStreamEl = appendStreamingAssistant();
    return currentStreamEl;
  }
  /** Remove any orphaned reload placeholder + clear streaming styles. */
  function clearStreamArtifacts() {
    document.getElementById('reload-placeholder')?.remove();
    if (currentStreamEl && !messagesEl?.contains(currentStreamEl)) {
      currentStreamEl = null;
    }
  }
  function hydrateServerRenderedMessages() {
    if (!messagesEl) return;
    messagesEl.querySelectorAll('.msg .msg-body').forEach((body) => {
      const raw = body.textContent ?? '';
      if (!raw) return;
      body.innerHTML = renderMarkdown(raw);
      decorateLinks(body);
    });
  }

  // -------------------------------------------------------------------------
  // queue widget — shows only WAITING items (not the in-flight one)
  // -------------------------------------------------------------------------

  let nextQueueItemId = 1;

  function renderQueue() {
    if (!queueEl) return;
    queueEl.replaceChildren();
    waitingItems.forEach((item, idx) => {
      const el = document.createElement('div');
      el.className = 'queue-item queued';
      el.dataset.itemId = item.id;
      const preview = item.content.length > 80 ? item.content.slice(0, 79) + '…' : item.content;
      el.innerHTML =
        '<span class="queue-status">Queued #' + (idx + 1) + '</span>' +
        '<span class="queue-text">' + escapeHtml(preview) + '</span>' +
        '<button type="button" class="queue-remove" aria-label="Remove from queue" title="Remove from queue">×</button>';
      queueEl.appendChild(el);
    });
  }

  // Click on a tool's stream-status with .has-detail toggles between the
  // generic label and the detailed line. The next `turn-tool` start resets
  // the expansion (see handleServerMsg/turn-tool), so the click is scoped
  // to the current tool event only.
  if (messagesEl) {
    messagesEl.addEventListener('click', (e) => {
      const status = e.target.closest('.stream-status.has-detail');
      if (!status) return;
      const expanded = status.classList.toggle('detail-expanded');
      status.textContent = expanded
        ? (status.dataset.detail || status.textContent)
        : (status.dataset.label || status.textContent);
    });
  }

  // Delete from queue via event delegation
  if (queueEl) {
    queueEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.queue-remove');
      if (!btn) return;
      const item = btn.closest('.queue-item');
      const id = item?.dataset.itemId;
      if (!id) return;
      const idx = waitingItems.findIndex((it) => it.id === id);
      if (idx >= 0) {
        waitingItems.splice(idx, 1);
        renderQueue();
      }
    });
  }

  // -------------------------------------------------------------------------
  // sidebar live updates
  // -------------------------------------------------------------------------
  function sidebarUpsertChat({ id, title, agent }) {
    const list = document.getElementById('chat-list');
    if (!list) return;
    list.querySelector('.empty-list')?.remove();
    let link = list.querySelector('.chat-item[data-chat-id="' + id + '"]');
    if (!link) {
      link = document.createElement('a');
      link.href = '/chats/' + id;
      link.className = 'chat-item';
      link.dataset.chatId = String(id);
      link.innerHTML =
        '<span class="chat-item-title"></span>' +
        '<span class="working-dot" aria-hidden="true"></span>';
      list.prepend(link);
    }
    if (title != null) {
      link.title = title;
      const titleEl = link.querySelector('.chat-item-title');
      if (titleEl) titleEl.textContent = title;
    }
    if (id === activeChatId) {
      document.querySelector('.new-chat-btn')?.classList.remove('active');
      list.querySelectorAll('.chat-item.active').forEach((el) => el.classList.remove('active'));
      link.classList.add('active');
    }
  }
  function sidebarRemoveChat(id) {
    const list = document.getElementById('chat-list');
    list?.querySelector('.chat-item[data-chat-id="' + id + '"]')?.remove();
  }
  function setWorkingDot(id, on) {
    const item = document.querySelector('.chat-item[data-chat-id="' + id + '"] .working-dot');
    if (!item) return;
    if (on) item.classList.add('on');
    else item.classList.remove('on');
  }
  function applyTitleForActive(title) {
    if (titleInput && activeChatId != null) {
      titleInput.value = title;
      titleInput.defaultValue = title;
      titleInput.disabled = false;
    }
    document.title = (title || 'iClaw') + ' — iClaw';
  }

  // -------------------------------------------------------------------------
  // WebSocket: connect, reconnect, send
  // -------------------------------------------------------------------------
  let ws = null;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  const wsUrl = (() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws';
  })();

  function wsSend(msg) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      console.error('[iclaw] ws send failed', err);
      return false;
    }
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = Math.min(30_000, 500 * Math.pow(2, reconnectAttempt));
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWs();
    }, delay);
  }

  function connectWs() {
    try { ws = new WebSocket(wsUrl); }
    catch (e) { scheduleReconnect(); return; }

    ws.addEventListener('open', () => {
      reconnectAttempt = 0;
      if (activeChatId != null) wsSend({ type: 'subscribe', chatId: activeChatId });
    });
    ws.addEventListener('close', () => {
      ws = null;
      scheduleReconnect();
    });
    ws.addEventListener('error', () => { /* close fires next */ });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleServerMsg(msg);
    });
  }

  // -------------------------------------------------------------------------
  // handle server → client events
  // -------------------------------------------------------------------------
  function handleServerMsg(msg) {
    switch (msg.type) {
      case 'hello':
      case 'pong':
        return;

      case 'chat-created':
        if (startedOnDraft && activeChatId == null) {
          // This is our just-created chat — adopt it.
          activeChatId = msg.chatId;
          if (messagesEl) {
            messagesEl.dataset.chatId = String(msg.chatId);
            delete messagesEl.dataset.draft;
          }
          history.replaceState(null, '', '/chats/' + msg.chatId);
          applyTitleForActive(msg.title || 'New chat');
        }
        sidebarUpsertChat({ id: msg.chatId, title: msg.title, agent: msg.agent });
        return;

      case 'chat-updated':
        if (msg.title != null) sidebarUpsertChat({ id: msg.chatId, title: msg.title });
        if (msg.chatId === activeChatId && msg.title != null) applyTitleForActive(msg.title);
        return;

      case 'chat-deleted':
        sidebarRemoveChat(msg.chatId);
        if (msg.chatId === activeChatId) window.location.assign('/');
        return;

      case 'message-appended':
        if (msg.chatId !== activeChatId) return;

        if (msg.message.role === 'user') {
          // The optimistic user node we appended on submit doesn't know the id
          // yet — adopt this one, don't duplicate.
          const pending = messagesEl?.querySelector('.msg.user.pending-id');
          if (pending) {
            pending.classList.remove('pending-id');
            pending.dataset.msgId = String(msg.message.id);
          } else if (!messagesEl?.querySelector('.msg[data-msg-id="' + msg.message.id + '"]')) {
            appendMessage(msg.message);
          }
          return;
        }

        if (msg.message.role === 'assistant') {
          // If we missed a turn-started (e.g. reloaded mid-turn) but have a
          // reload-placeholder, adopt it now so the placeholder gets replaced
          // rather than left orphaned above the final message.
          const target = ensureStreamEl();
          if (target) {
            target.classList.remove(
              'streaming', 'stream-waiting', 'stream-tool', 'stream-generating',
            );
            target.dataset.msgId = String(msg.message.id);
            const status = target.querySelector('.stream-status');
            if (status) status.remove();
            const body = target.querySelector('.stream-body, .msg-body');
            if (body) {
              body.classList.remove('stream-body');
              body.innerHTML = renderMarkdown(msg.message.content || '');
              decorateLinks(body);
            }
            currentStreamEl = null;
            currentStreamFullText = '';
          } else {
            appendMessage(msg.message);
          }
          clearStreamArtifacts();
          return;
        }

        appendMessage(msg.message);
        return;

      case 'turn-started':
        setWorkingDot(msg.chatId, true);
        if (msg.chatId !== activeChatId) return;
        setStopVisible(true);
        ensureStreamEl();
        if (msg.activity?.label) {
          const status = currentStreamEl?.querySelector('.stream-status');
          if (status) status.textContent = msg.activity.label;
        }
        return;

      case 'turn-delta': {
        if (msg.chatId !== activeChatId) return;
        const el = ensureStreamEl();
        currentStreamFullText += msg.text;
        // first delta flips the state
        if (el.classList.contains('stream-waiting') ||
            el.classList.contains('stream-tool')) {
          el.classList.remove('stream-waiting', 'stream-tool');
          el.classList.add('stream-generating');
          const status = el.querySelector('.stream-status');
          if (status) status.hidden = true;
        }
        const body = el.querySelector('.stream-body, .msg-body');
        if (body) {
          body.innerHTML = renderMarkdown(currentStreamFullText);
          decorateLinks(body);
        }
        scrollToBottom();
        return;
      }

      case 'turn-tool': {
        if (msg.chatId !== activeChatId) return;
        const el = ensureStreamEl();
        const status = el.querySelector('.stream-status');
        if (msg.phase === 'start' && status) {
          status.hidden = false;
          const label = msg.label || msg.name;
          const detail = (msg.detail && msg.detail !== label) ? msg.detail : '';
          // Always show the generic label. Hover (title) and click (expand)
          // reveal the detail when present. Each new tool resets the
          // expanded state — only this current event is interactable.
          status.textContent = label;
          status.classList.remove('detail-expanded');
          if (detail) {
            status.title = detail;
            status.dataset.detail = detail;
            status.dataset.label = label;
            status.classList.add('has-detail');
          } else {
            status.removeAttribute('title');
            delete status.dataset.detail;
            delete status.dataset.label;
            status.classList.remove('has-detail');
          }
          el.classList.remove('stream-generating');
          el.classList.add('stream-tool');
        }
        return;
      }

      case 'turn-lifecycle': {
        if (msg.chatId !== activeChatId) return;
        const el = ensureStreamEl();
        const status = el.querySelector('.stream-status');
        if (status && !currentStreamFullText) {
          status.hidden = false;
          status.textContent = msg.label || msg.phase;
        }
        return;
      }

      case 'turn-attachment':
        // Already inlined into the running text via turn-delta. No-op here for v1.
        return;

      case 'turn-ended':
        setWorkingDot(msg.chatId, false);
        if (msg.chatId !== activeChatId) return;
        setStopVisible(false);
        // Belt + suspenders: kill any leftover reload-placeholder that might
        // still be on the page if events arrived in a weird order.
        clearStreamArtifacts();
        // The in-flight item is no longer in waitingItems (shifted out when
        // flushNextQueued started). Just clear the inFlight flag and start
        // the next one if any.
        if (inFlight) {
          inFlight = false;
          if (waitingItems[0]) flushNextQueued();
        }
        return;

      case 'turn-error': {
        if (msg.chatId !== activeChatId) {
          setWorkingDot(msg.chatId, false);
          return;
        }
        setStopVisible(false);
        if (currentStreamEl) {
          currentStreamEl.remove();
          currentStreamEl = null;
        }
        const div = document.createElement('div');
        div.className = 'msg system error';
        div.innerHTML =
          '<div class="role">error</div>' +
          '<div class="msg-body">' + escapeHtml('Error: ' + msg.error) + '</div>';
        messagesEl?.appendChild(div);
        setWorkingDot(msg.chatId, false);
        // In-flight already shifted out of waitingItems when flushed.
        inFlight = false;
        if (waitingItems[0]) flushNextQueued();
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // outgoing: form submit → WS send
  // -------------------------------------------------------------------------
  function flushNextQueued() {
    if (inFlight) return;
    // Take it out of the waiting list — it's no longer "queued", it's now
    // the in-flight message. The queue widget only renders waiting items.
    const item = waitingItems.shift();
    if (!item) return;
    renderQueue();
    inFlight = true;
    // Optimistically append user msg. Mark it as pending-id so the
    // upcoming `message-appended` for the same user msg adopts this node
    // instead of duplicating.
    appendMessage({ role: 'user', content: item.content }, { pendingId: true });
    currentStreamFullText = '';
    currentStreamEl = ensureStreamEl();
    const payload = {
      type: 'send',
      requestId: 'r-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      content: item.content,
    };
    if (activeChatId != null) payload.chatId = activeChatId;
    else payload.agent = draftAgentSelect?.value || 'openclaw/default';
    if (!wsSend(payload)) {
      // No connection — put the item back at the head so it isn't lost,
      // and let the open handler retry.
      inFlight = false;
      waitingItems.unshift(item);
      renderQueue();
    }
  }

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const content = input.value.trim();
      if (!content) return;
      waitingItems.push({ content, id: 'q-' + nextQueueItemId++ });
      input.value = '';
      renderQueue();
      flushNextQueued();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
    input.focus();
  }

  // -------------------------------------------------------------------------
  // chat title inline rename (HTTP form fallback for now)
  // -------------------------------------------------------------------------
  if (titleInput) {
    if (activeChatId != null) titleInput.disabled = false;
    async function save() {
      if (activeChatId == null) return;
      const next = titleInput.value.trim();
      if (!next || next === titleInput.defaultValue) return;
      try {
        const res = await fetch('/chats/' + encodeURIComponent(activeChatId), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: next }),
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        titleInput.defaultValue = data.title;
      } catch {
        titleInput.value = titleInput.defaultValue;
      }
    }
    titleInput.addEventListener('blur', save);
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); titleInput.blur(); }
    });
  }

  // -------------------------------------------------------------------------
  // stop button (visible while this chat is working)
  // -------------------------------------------------------------------------
  function setStopVisible(visible) {
    if (!stopBtn) return;
    stopBtn.hidden = !visible;
  }
  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      if (activeChatId == null) return;
      wsSend({ type: 'abort', chatId: activeChatId });
      // Optimistically disable until server confirms via turn-error/ended,
      // so a frustrated double-click doesn't spam the gateway.
      stopBtn.disabled = true;
      setTimeout(() => { stopBtn.disabled = false; }, 3000);
    });
  }

  // -------------------------------------------------------------------------
  // boot
  // -------------------------------------------------------------------------
  hydrateServerRenderedMessages();
  // Show the latest message first (chats default to the bottom of the
  // transcript, like every other chat UI). Defer to the next frame so the
  // hydrated markdown has actually been laid out.
  requestAnimationFrame(() => scrollToBottom());
  connectWs();
})();
