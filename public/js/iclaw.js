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
  // queue widget
  // -------------------------------------------------------------------------
  function renderQueue() {
    if (!queueEl) return;
    queueEl.replaceChildren();
    waitingItems.forEach((item, idx) => {
      const el = document.createElement('div');
      el.className = 'queue-item queued';
      const preview = item.content.length > 80 ? item.content.slice(0, 79) + '…' : item.content;
      el.innerHTML =
        '<span class="queue-status">Queued #' + (idx + 1) + '</span>' +
        '<span class="queue-text">' + escapeHtml(preview) + '</span>';
      queueEl.appendChild(el);
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
        '<span class="working-dot" aria-hidden="true"></span>' +
        '<span class="chat-item-title"></span>';
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
          // Prefer the agent's own description (e.g. "ls -la /tmp") when present.
          status.textContent = msg.detail || msg.label || msg.name;
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
        // Belt + suspenders: kill any leftover reload-placeholder that might
        // still be on the page if events arrived in a weird order.
        clearStreamArtifacts();
        // Drain queue (locally — server already serialized).
        if (inFlight) {
          inFlight = false;
          waitingItems.shift();
          renderQueue();
          if (waitingItems[0]) flushNextQueued();
        }
        return;

      case 'turn-error': {
        if (msg.chatId !== activeChatId) {
          setWorkingDot(msg.chatId, false);
          return;
        }
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
        inFlight = false;
        if (waitingItems.length) { waitingItems.shift(); renderQueue(); }
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // outgoing: form submit → WS send
  // -------------------------------------------------------------------------
  function flushNextQueued() {
    if (inFlight) return;
    const item = waitingItems[0];
    if (!item) return;
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
      // No connection — keep in queue, retry when WS opens (handled in open handler).
      // For now: notify error and bail.
      inFlight = false;
    }
  }

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const content = input.value.trim();
      if (!content) return;
      waitingItems.push({ content });
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
  // boot
  // -------------------------------------------------------------------------
  hydrateServerRenderedMessages();
  connectWs();
})();
