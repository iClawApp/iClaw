(function () {
  'use strict';

  // Render markdown source blocks. HTML tags are escaped BEFORE parsing because
  // the catalog is user-generated — markdown formatting renders, raw HTML can't.
  if (window.marked && typeof window.marked.parse === 'function') {
    if (typeof window.marked.setOptions === 'function') {
      window.marked.setOptions({ breaks: true, gfm: true });
    }
    document.querySelectorAll('.js-md').forEach(function (el) {
      var src = (el.textContent || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      try {
        el.innerHTML = window.marked.parse(src);
      } catch (e) {
        /* leave the raw text as-is */
      }
    });
  }

  const btn = document.getElementById('role-detail-start');
  if (!btn) return;
  const errEl = document.getElementById('role-detail-error');

  btn.addEventListener('click', async function () {
    const templateId = btn.getAttribute('data-template-id');
    if (!templateId) return;

    const answers = {};
    document.querySelectorAll('#role-detail-ask [data-ask-key]').forEach(function (el) {
      answers[el.getAttribute('data-ask-key')] = el.value;
    });

    btn.disabled = true;
    if (errEl) {
      errEl.hidden = true;
      errEl.textContent = '';
    }
    try {
      const res = await fetch('/templates/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ templateId, answers }),
      });
      const data = await res.json().catch(function () {
        return {};
      });
      if (!res.ok) throw new Error(data.error || 'Не вдалося запустити');
      if (data.chatId) {
        window.location.href = '/chats/' + data.chatId;
        return;
      }
      throw new Error('No chatId in response');
    } catch (err) {
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = err instanceof Error ? err.message : String(err);
      }
    } finally {
      btn.disabled = false;
    }
  });
})();
