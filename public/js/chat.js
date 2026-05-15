(function () {
  const messagesEl = document.getElementById('messages');
  const queueEl = document.getElementById('queue');
  const form = document.getElementById('send-form');
  const input = document.getElementById('composer-input');
  const button = form?.querySelector('button');
  if (!messagesEl || !queueEl || !form || !input || !button) return;

  const rawId = messagesEl.dataset.chatId;
  const startedOnDraft = messagesEl.dataset.draft === '1' || !rawId;
  let activeChatId = startedOnDraft ? null : Number(rawId);

  const waitingItems = [];
  let inFlight = null;
  let pumping = false;

  const STREAM_HEADERS = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
  };

  function escapeHtml(s) {
    return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  }

  function clearEmptyState() {
    const empty = messagesEl.querySelector('.empty-state');
    if (empty) empty.remove();
  }

  function scrollMessagesToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function appendUserMessage(content) {
    clearEmptyState();
    const div = document.createElement('div');
    div.className = 'msg user';
    div.innerHTML = '<div class="role">user</div>' + escapeHtml(content);
    messagesEl.appendChild(div);
    scrollMessagesToBottom();
    return div;
  }

  function beginAssistantStream(userNode) {
    const div = document.createElement('div');
    div.className = 'msg assistant streaming';
    div.innerHTML =
      '<div class="role">assistant</div>' +
      '<div class="stream-status">Thinking…</div>' +
      '<div class="stream-body"></div>';
    userNode.insertAdjacentElement('afterend', div);
    scrollMessagesToBottom();
    return div;
  }

  function insertErrorAfter(userNode, msg) {
    const div = document.createElement('div');
    div.className = 'msg system error';
    div.innerHTML = '<div class="role">error</div>' + escapeHtml(msg);
    userNode.insertAdjacentElement('afterend', div);
    return div;
  }

  function renderWaitingQueue() {
    queueEl.replaceChildren();
    waitingItems.forEach((item, idx) => {
      const el = document.createElement('div');
      el.className = 'queue-item queued';
      const preview = item.content.length > 80 ? item.content.slice(0, 79) + '…' : item.content;
      el.innerHTML =
        '<span class="queue-status">Queued #' + (idx + 1) + '</span>' +
        '<span class="queue-text">' + escapeHtml(preview) + '</span>';
      queueEl.appendChild(el);
      item.el = el;
    });
  }

  function enqueueWaiting(content) {
    const item = { content, el: null };
    waitingItems.push(item);
    renderWaitingQueue();
    return item;
  }

  function promoteDraftToChat(id) {
    activeChatId = id;
    messagesEl.dataset.chatId = String(id);
    delete messagesEl.dataset.draft;
    history.replaceState(null, '', '/chats/' + id);
  }

  function maybeRedirectWhenIdle() {
    if (!startedOnDraft || waitingItems.length > 0 || inFlight || !activeChatId) return;
    window.location.assign('/chats/' + activeChatId);
  }

  function parseSseBlocks(buffer, onEvent) {
    const parts = buffer.split('\n\n');
    const rest = parts.pop() ?? '';
    for (const block of parts) {
      for (const line of block.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          onEvent(JSON.parse(data));
        } catch {
          /* ignore malformed chunks */
        }
      }
    }
    return rest;
  }

  async function consumeSseResponse(res, userNode) {
    if (!res.body) throw new Error('No response body');
    const assistantEl = beginAssistantStream(userNode);
    const statusEl = assistantEl.querySelector('.stream-status');
    const bodyEl = assistantEl.querySelector('.stream-body');
    let gotDelta = false;
    let donePayload = null;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = parseSseBlocks(buffer, (ev) => {
        if (ev.type === 'status' && statusEl) {
          statusEl.textContent = ev.status === 'thinking' ? 'Thinking…' : ev.status;
        } else if (ev.type === 'delta' && bodyEl) {
          if (!gotDelta) {
            gotDelta = true;
            if (statusEl) statusEl.remove();
            assistantEl.classList.remove('streaming');
          }
          bodyEl.textContent += ev.text;
          scrollMessagesToBottom();
        } else if (ev.type === 'done') {
          donePayload = ev;
        } else if (ev.type === 'error') {
          throw new Error(ev.error || 'Stream error');
        }
      });
    }

    buffer += decoder.decode();
    parseSseBlocks(buffer + '\n\n', (ev) => {
      if (ev.type === 'delta' && bodyEl) {
        if (!gotDelta) {
          gotDelta = true;
          if (statusEl) statusEl.remove();
          assistantEl.classList.remove('streaming');
        }
        bodyEl.textContent += ev.text;
      } else if (ev.type === 'done') donePayload = ev;
      else if (ev.type === 'error') throw new Error(ev.error || 'Stream error');
    });

    if (!gotDelta && statusEl) statusEl.remove();
    assistantEl.classList.remove('streaming');
    return donePayload;
  }

  async function streamCreateFirst(item, agent) {
    const res = await fetch('/chats', {
      method: 'POST',
      headers: STREAM_HEADERS,
      body: JSON.stringify({ agent, content: item.content }),
    });
    if (!res.ok) throw new Error(await res.text());
    const done = await consumeSseResponse(res, item.userNode);
    if (done?.id) promoteDraftToChat(done.id);
    else if (done?.message?.chat_id) promoteDraftToChat(done.message.chat_id);
  }

  async function streamMessageTurn(item, id) {
    const res = await fetch('/chats/' + encodeURIComponent(id) + '/messages', {
      method: 'POST',
      headers: STREAM_HEADERS,
      body: JSON.stringify({ content: item.content }),
    });
    if (!res.ok) throw new Error(await res.text());
    await consumeSseResponse(res, item.userNode);
  }

  async function pumpQueue() {
    if (pumping || inFlight || waitingItems.length === 0) return;
    pumping = true;

    const waiting = waitingItems.shift();
    renderWaitingQueue();

    const item = { content: waiting.content, userNode: appendUserMessage(waiting.content) };
    inFlight = item;

    try {
      if (!activeChatId) {
        const agent = document.getElementById('draft-agent')?.value || 'openclaw/default';
        await streamCreateFirst(item, agent);
      } else {
        await streamMessageTurn(item, activeChatId);
      }
    } catch (err) {
      insertErrorAfter(item.userNode, err.message);
    }

    inFlight = null;
    pumping = false;
    maybeRedirectWhenIdle();
    pumpQueue();
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const content = input.value.trim();
    if (!content) return;

    enqueueWaiting(content);
    input.value = '';
    pumpQueue();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  input.focus();
})();
