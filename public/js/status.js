// Polls /chats/status every 2s, toggles ● indicator per chat-item in the sidebar.
// Also exposes a tiny pub/sub for the active chat view (chat.js) to know
// when its chat enters/leaves the "working" state.

(function () {
  const POLL_MS = 2000;
  const listeners = new Set();

  window.iclaudeStatus = {
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    workingIds: new Set(),
  };

  function applyDots(working) {
    document.querySelectorAll('.chat-item').forEach((el) => {
      const id = Number(el.dataset.chatId);
      const dot = el.querySelector('.working-dot');
      if (!dot) return;
      if (working.has(id)) dot.classList.add('on');
      else dot.classList.remove('on');
    });
  }

  async function tick() {
    try {
      const res = await fetch('/chats/status', { headers: { accept: 'application/json' } });
      if (!res.ok) return;
      const body = await res.json();
      const next = new Set(body.working || []);
      const prev = window.iclaudeStatus.workingIds;
      window.iclaudeStatus.workingIds = next;
      applyDots(next);
      // notify listeners if the set actually changed
      const changed =
        prev.size !== next.size ||
        [...next].some((id) => !prev.has(id)) ||
        [...prev].some((id) => !next.has(id));
      if (changed) {
        for (const fn of listeners) {
          try { fn(next); } catch (e) { console.error(e); }
        }
      }
    } catch (e) {
      // ignore network errors; we'll try again next tick
    }
  }

  tick();
  setInterval(tick, POLL_MS);
})();
