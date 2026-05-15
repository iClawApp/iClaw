(function () {
  const messagesEl = document.getElementById('messages');
  const form = document.getElementById('send-form');
  const input = document.getElementById('composer-input');
  const button = form?.querySelector('button');
  if (!messagesEl || !form || !input || !button) return;

  const chatId = Number(messagesEl.dataset.chatId);
  let locallyBusy = false;

  function escapeHtml(s) {
    return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  }

  function appendMessage(role, content) {
    const placeholder = messagesEl.querySelector('p.muted');
    if (placeholder) placeholder.remove();
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.innerHTML = '<div class="role">' + escapeHtml(role) + '</div>' + escapeHtml(content);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function setBusy(busy) {
    input.disabled = busy;
    button.disabled = busy;
    button.textContent = busy ? 'Working…' : 'Send';
    if (busy) input.blur();
    else input.focus();
  }

  // React to external busy-state changes (e.g. another tab sending in this chat).
  function isThisChatWorkingExternally() {
    const ids = window.iclaudeStatus?.workingIds;
    return ids?.has(chatId) ?? false;
  }
  if (window.iclaudeStatus) {
    window.iclaudeStatus.onChange(() => {
      // local busy takes precedence; only reflect external state when not locally busy.
      if (!locallyBusy) setBusy(isThisChatWorkingExternally());
    });
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (locallyBusy) return;
    const content = input.value.trim();
    if (!content) return;

    locallyBusy = true;
    appendMessage('user', content);
    input.value = '';
    const pending = appendMessage('assistant', '…thinking…');
    pending.classList.add('pending');
    setBusy(true);

    try {
      const res = await fetch('/chats/' + encodeURIComponent(chatId) + '/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const text = await res.text();
        pending.remove();
        appendMessage('system', 'Error: ' + text);
        return;
      }
      const msg = await res.json();
      pending.classList.remove('pending');
      pending.innerHTML = '<div class="role">assistant</div>' + escapeHtml(msg.content || '');
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } catch (err) {
      pending.remove();
      appendMessage('system', 'Network error: ' + err.message);
    } finally {
      locallyBusy = false;
      // mirror external state after our op finishes (in case other tabs are also working)
      setBusy(isThisChatWorkingExternally());
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
