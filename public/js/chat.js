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

  /** Shown in the queue panel — not yet sent to the server. */
  /** @type {{ el: HTMLElement, content: string }[]} */
  const waitingItems = [];
  /** Currently in flight (shown in the message thread only). */
  /** @type {{ content: string, userNode: HTMLElement | null } | null} */
  let inFlight = null;
  let pumping = false;

  function escapeHtml(s) {
    return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  }

  function clearEmptyState() {
    const empty = messagesEl.querySelector('.empty-state');
    if (empty) empty.remove();
  }

  function appendUserMessage(content) {
    clearEmptyState();
    const div = document.createElement('div');
    div.className = 'msg user';
    div.innerHTML = '<div class="role">user</div>' + escapeHtml(content);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function insertAssistantAfter(userNode, content) {
    const div = document.createElement('div');
    div.className = 'msg assistant';
    div.innerHTML = '<div class="role">assistant</div>' + escapeHtml(content);
    userNode.insertAdjacentElement('afterend', div);
    if (userNode.nextElementSibling === div && div.nextElementSibling === null) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
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

  async function sendCreateFirst(item, agent) {
    const res = await fetch('/chats', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ agent, content: item.content }),
    });
    if (!res.ok) throw new Error(await res.text());
    const body = await res.json();
    promoteDraftToChat(body.id);
    insertAssistantAfter(item.userNode, body.message?.content || '');
  }

  async function sendMessageTurn(item, id) {
    const res = await fetch('/chats/' + encodeURIComponent(id) + '/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ content: item.content }),
    });
    if (!res.ok) throw new Error(await res.text());
    const msg = await res.json();
    insertAssistantAfter(item.userNode, msg.content || '');
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
        await sendCreateFirst(item, agent);
      } else {
        await sendMessageTurn(item, activeChatId);
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
