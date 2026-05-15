(function () {
  const messagesEl = document.getElementById('messages');
  const form = document.getElementById('send-form');
  const input = document.getElementById('composer-input');
  if (!messagesEl || !form || !input) return;

  const taskId = messagesEl.dataset.taskId;

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  }

  function appendMessage(role, content) {
    const placeholder = messagesEl.querySelector('p.muted');
    if (placeholder) placeholder.remove();
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.innerHTML =
      '<div class="role">' + escapeHtml(role) + '</div>' + escapeHtml(content);
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const content = input.value.trim();
    if (!content) return;
    const button = form.querySelector('button');

    appendMessage('user', content);
    input.value = '';
    const pending = appendMessage('assistant', '…thinking…');
    pending.classList.add('pending');
    button.disabled = true;

    try {
      const res = await fetch('/tasks/' + encodeURIComponent(taskId) + '/messages', {
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
      pending.innerHTML =
        '<div class="role">assistant</div>' + escapeHtml(msg.content || '');
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } catch (err) {
      pending.remove();
      appendMessage('system', 'Network error: ' + err.message);
    } finally {
      button.disabled = false;
      input.focus();
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  input.focus();
})();
