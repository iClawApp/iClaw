// Polls /chats/status every 2s. Two responsibilities:
//   1. Toggle the ● indicator per chat-item in the sidebar
//   2. Expose a tiny pub/sub so chat.js can react to:
//      - this chat's activity label changing ("Running command…")
//      - this chat going from working → idle (used to fetch the final reply
//        when the page was reloaded mid-turn)

(function () {
  const POLL_MS = 2000;
  const listeners = new Set();

  window.iclawStatus = {
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    workingIds: new Set(),
    activities: new Map(), // id → { kind, label, name?, phase? }
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

  function indexActivities(arr) {
    const m = new Map();
    if (Array.isArray(arr)) {
      for (const entry of arr) {
        if (entry && typeof entry.id === 'number') {
          m.set(entry.id, entry.activity ?? null);
        }
      }
    }
    return m;
  }

  function activityEqual(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return a.kind === b.kind && a.label === b.label && a.name === b.name;
  }

  async function tick() {
    try {
      const res = await fetch('/chats/status', { headers: { accept: 'application/json' } });
      if (!res.ok) return;
      const body = await res.json();
      const nextWorking = new Set(body.working || []);
      const nextActivities = indexActivities(body.activities);

      const prevWorking = window.iclawStatus.workingIds;
      const prevActivities = window.iclawStatus.activities;

      const wentIdle = [];
      const wentWorking = [];
      const activityChanged = [];

      for (const id of prevWorking) {
        if (!nextWorking.has(id)) wentIdle.push(id);
      }
      for (const id of nextWorking) {
        if (!prevWorking.has(id)) wentWorking.push(id);
        if (!activityEqual(prevActivities.get(id), nextActivities.get(id))) {
          activityChanged.push(id);
        }
      }

      // commit new state
      window.iclawStatus.workingIds = nextWorking;
      window.iclawStatus.activities = nextActivities;
      applyDots(nextWorking);

      if (wentIdle.length || wentWorking.length || activityChanged.length) {
        for (const fn of listeners) {
          try {
            fn({
              workingIds: nextWorking,
              activities: nextActivities,
              wentIdle,
              wentWorking,
              activityChanged,
            });
          } catch (e) {
            console.error(e);
          }
        }
      }
    } catch {
      // ignore transient network errors
    }
  }

  tick();
  setInterval(tick, POLL_MS);
})();
