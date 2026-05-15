(function () {
  const messagesEl = document.getElementById('messages');
  const form = document.getElementById('send-form');
  const input = document.getElementById('composer-input');
  const button = form?.querySelector('button');
  if (!messagesEl || !form || !input || !button) return;

  const rawId = messagesEl.dataset.chatId;
  const isDraft = messagesEl.dataset.draft === '1' || !rawId;
  const chatId = isDraft ? null : Number(rawId);

  // Local pending placeholders, in submit order. Each fetch closes over its own
  // pending node, so we don't strictly need this array for correctness — but we
  // do use its length to label queued placeholders.
  const pending = [];

  function escapeHtml(s) {
    return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  }

  function appendMessage(role, content) {
    const empty = messagesEl.querySelector('.empty-state');
    if (empty) empty.remove();
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.innerHTML = '<div class="role">' + escapeHtml(role) + '</div>' + escapeHtml(content);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function updateQueuedLabels() {
    pending.forEach((node, idx) => {
      const isHead = idx === 0;
      const label = isHead ? '…thinking…' : '…queued (#' + (idx + 1) + ')…';
      node.querySelector('.placeholder-text').textContent = label;
    });
  }

  function appendPending() {
    const empty = messagesEl.querySelector('.empty-state');
    if (empty) empty.remove();
    const div = document.createElement('div');
    div.className = 'msg assistant pending';
    div.innerHTML =
      '<div class="role">assistant</div><span class="placeholder-text">…thinking…</span>';
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    pending.push(div);
    updateQueuedLabels();
    return div;
  }

  function resolvePending(node, htmlContent) {
    node.classList.remove('pending');
    node.innerHTML = '<div class="role">assistant</div>' + htmlContent;
    const idx = pending.indexOf(node);
    if (idx >= 0) pending.splice(idx, 1);
    updateQueuedLabels();
  }

  function failPending(node, errMsg) {
    node.classList.remove('pending');
    node.classList.add('error');
    node.innerHTML = '<div class="role">system</div>' + escapeHtml('Error: ' + errMsg);
    const idx = pending.indexOf(node);
    if (idx >= 0) pending.splice(idx, 1);
    updateQueuedLabels();
  }

  async function sendDraft(content, agent) {
    // POST /chats with the first message; server creates the chat + runs the
    // first turn. We block input only in draft mode (no chat_id yet for queue).
    input.disabled = true;
    button.disabled = true;
    const node = appendPending();
    try {
      const res = await fetch('/chats', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ agent, content }),
      });
      if (!res.ok) {
        failPending(node, await res.text());
        return;
      }
      const body = await res.json();
      // We've got a chat_id and the first reply. Navigate to the real chat page.
      window.location.assign('/chats/' + body.id);
    } catch (err) {
      failPending(node, err.message);
    } finally {
      input.disabled = false;
      button.disabled = false;
      input.focus();
    }
  }

  async function sendReal(content) {
    // Optimistic UI: render user msg + pending placeholder immediately, fire
    // the fetch, and let the server's per-chat lock serialize. The user can
    // submit more while this is in flight — they queue up locally and on the
    // server.
    const node = appendPending();
    try {
      const res = await fetch('/chats/' + encodeURIComponent(chatId) + '/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        failPending(node, await res.text());
        return;
      }
      const msg = await res.json();
      resolvePending(node, escapeHtml(msg.content || ''));
    } catch (err) {
      failPending(node, err.message);
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const content = input.value.trim();
    if (!content) return;
    if (input.disabled) return;

    appendMessage('user', content);
    input.value = '';

    if (isDraft) {
      const agent = document.getElementById('draft-agent')?.value || 'openclaw/default';
      await sendDraft(content, agent);
    } else {
      // Don't await — let the next submit happen freely. The Promise queues
      // independently and updates its own placeholder.
      sendReal(content);
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (input.disabled) return;
      form.requestSubmit();
    }
  });

  input.focus();
})();
