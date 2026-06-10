// iClaw browser client — one WebSocket to /ws drives the whole UI.
//
// Responsibilities:
//   - Open and auto-reconnect a WebSocket to the iClaw server
//   - Subscribe to the active chat (if any) and any chat the user is in
//   - Render incoming events: message-appended, turn-delta, turn-tool, …
//   - Sidebar live updates: chat / project / fact events
//   - Replace the page's compose-form submit with a WS send
//   - Hydrate already-server-rendered markdown bodies on load

(function () {
  // -------------------------------------------------------------------------
  // shared DOM handles + state
  // -------------------------------------------------------------------------
  // In-app navigation. Through a tunnel a full browser navigation bounces via
  // the passphrase gate ("Checking this device…") because it can't be E2E
  // wrapped. When the encrypted transport is installed it exposes
  // window.iclawE2eNavigate, which pulls the next page over the existing channel
  // and swaps the document in place — no gate round trip. Outside the tunnel
  // (helper absent) this is a normal navigation.
  function goTo(url) {
    if (typeof window.iclawE2eNavigate === 'function') {
      window.iclawE2eNavigate(url);
      return;
    }
    window.location.assign(url);
  }

  const messagesEl = document.getElementById('messages');
  function getMessagesThreadEl() {
    return messagesEl?.querySelector(':scope > .messages-thread') ?? null;
  }
  /** Inner column for transcript rows (scroll bar stays on `#messages` full width). */
  function messagesAppendRoot() {
    return getMessagesThreadEl() ?? messagesEl;
  }
  const queueListEl = document.getElementById('queue-list');
  const form = document.getElementById('send-form');
  const input = document.getElementById('composer-input');
  const button = form?.querySelector('.composer-send');
  const attachBtn = document.getElementById('composer-attach-btn');
  const fileInput = document.getElementById('composer-file-input');
  const attachmentsBar = document.getElementById('composer-attachments');
  const titleInput = document.getElementById('chat-title-input');
  const draftAgentSelect = document.getElementById('draft-agent');
  const projectPickEl = document.getElementById('project-pick');
  const draftBody = document.getElementById('draft-body');
  const draftPickStage = document.getElementById('draft-pick-stage');
  const composerWrap = document.getElementById('draft-composer-wrap');
  const draftEmptyHint = document.getElementById('draft-empty-hint');
  const stopBtn = document.getElementById('stop-btn');
  const searchInput = document.getElementById('sidebar-search-input');
  const sidebarToolbar = document.querySelector('.sidebar-toolbar');
  const searchToggleBtn = document.getElementById('sidebar-search-toggle');
  const searchCloseBtn = document.getElementById('sidebar-search-close');
  const rawChatId = messagesEl?.dataset.chatId;
  const startedOnDraft = messagesEl?.dataset.draft === '1' || !rawChatId;
  let activeChatId = startedOnDraft ? null : Number(rawChatId);

  // -------------------------------------------------------------------------
  // composer mode (Ask / Execute). Mode rides along with each sent message.
  // The set of selectable modes is rendered server-side from the config in
  // services/chatModes.ts, so adding a mode there surfaces it here with no
  // client change. Default + back-compat fallback is 'execute'.
  // -------------------------------------------------------------------------
  const MODE_STORAGE_KEY = rawChatId ? `iclaw:composer-mode:${rawChatId}` : 'iclaw:composer-mode';
  const composerModesEl = document.getElementById('composer-modes');
  const composerModeBtn = document.getElementById('composer-mode-btn');
  const composerModeMenu = document.getElementById('composer-mode-menu');
  const composerModeLabel = document.getElementById('composer-mode-label');
  const composerModeDefault =
    composerModesEl?.dataset.defaultMode || 'execute';
  const composerModeIds = composerModeMenu
    ? Array.from(composerModeMenu.querySelectorAll('.composer-mode-menu-item')).map(
        (el) => el.dataset.mode,
      )
    : [composerModeDefault];
  let selectedComposerMode = composerModeDefault;

  // True when an OpenRouter key is configured. Derived from the rendered menu:
  // locked (needs-key) items are only emitted when there's no key. Drives the
  // connect chooser + the Full Power "switch mode" overlay (the runtime modes
  // are the only fallback for a dead gateway, and they need the key).
  const openRouterReady =
    !!composerModeMenu &&
    !composerModeMenu.querySelector('.composer-mode-menu-item[data-requires-key="1"]');

  /** True when a mode is shown but locked behind a missing OpenRouter key. */
  function isModeLocked(id) {
    if (!composerModeMenu) return false;
    const el = composerModeMenu.querySelector(
      '.composer-mode-menu-item[data-mode="' + id + '"]',
    );
    return !!el && el.dataset.requiresKey === '1';
  }

  /** Currently selected send mode (always one of the rendered, enabled ids). */
  function getComposerMode() {
    return composerModeIds.includes(selectedComposerMode)
      ? selectedComposerMode
      : composerModeDefault;
  }

  function setComposerMode(mode, opts) {
    let next = composerModeIds.includes(mode) ? mode : composerModeDefault;
    // Don't land on a locked mode that isn't the default (e.g. a chat last used
    // in a runtime mode after the key was removed) — fall back to the default.
    // The default itself MAY be a locked Work (no OpenClaw + no key); that's
    // intended, and the connect chooser fires on first send.
    if (isModeLocked(next)) next = composerModeDefault;
    // Remember the mode we leave when entering Incognito, so the × can restore it.
    if (next === 'incognito' && selectedComposerMode !== 'incognito') {
      incognitoReturnMode = selectedComposerMode;
    }
    selectedComposerMode = next;
    if (composerModeBtn) composerModeBtn.dataset.mode = next;
    if (composerModeMenu) {
      composerModeMenu.querySelectorAll('.composer-mode-menu-item').forEach((el) => {
        const on = el.dataset.mode === next;
        el.setAttribute('aria-checked', on ? 'true' : 'false');
        if (composerModeLabel && on) {
          const t = el.querySelector('.menu-item__title');
          composerModeLabel.textContent = t ? t.textContent : next;
        }
        if (on) {
          const desc = el.querySelector('.composer-mode-menu-item__desc');
          if (composerModeBtn && desc) composerModeBtn.title = desc.textContent || '';
        }
      });
    }
    // Never persist incognito as a chat's default mode — it's a transient,
    // explicitly-entered surface, not a sticky preference.
    if ((!opts || opts.persist !== false) && next !== 'incognito') {
      try { localStorage.setItem(MODE_STORAGE_KEY, next); } catch (_) {}
      // Persist server-side too, so the mode sticks across page navigation and
      // syncs across devices — not just this browser's localStorage. Drafts have
      // no chat id yet (mode rides along with the first message); once the chat
      // exists the server row (chats.mode) is the source of truth on reload.
      if (activeChatId != null) {
        fetch('/chats/' + encodeURIComponent(activeChatId) + '/mode', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode: next }),
        }).catch(function () {});
      }
    }
    // Incognito: tint the surface + show the "nothing saved" banner, and start a
    // fresh ephemeral session each time the mode is (re)entered.
    if (typeof syncIncognitoSurface === 'function') syncIncognitoSurface(next);
    syncExecuteAvailability();
    if (typeof syncDockerAvailability === 'function') syncDockerAvailability();
    syncAgentVisibility(next);
  }

  /**
   * The Agent picker selects an OpenClaw agent session, which only affects Full
   * Power (Execute). Work / Safe work / Incognito route to iclaw-runtime and
   * ignore it — so hide it there instead of implying a choice that does nothing.
   * Mode is per-message, so this re-runs on every mode change. (When only Execute
   * is selectable the mode menu isn't rendered and this never hides it.)
   */
  function syncAgentVisibility(mode) {
    const m = mode || getComposerMode();
    document.querySelectorAll('.agent-form').forEach((el) => {
      el.hidden = m !== 'execute';
    });
  }

  // ── Full Power (Execute) gating ───────────────────────────────────────────
  // Execute routes to the OpenClaw gateway; the runtime modes don't. When the
  // gateway is off we mute the Full Power option and, if it's the selected mode,
  // cover the input with an explanation (same treatment as the drag-drop overlay)
  // so the user switches mode instead of typing into a dead end.
  const composerExecMsg = document.getElementById('composer-exec-msg');

  // ── Docker gating (Safe-work sandbox) ─────────────────────────────────────
  // We only block Safe work when Docker is NOT INSTALLED ('missing'). When it's
  // merely stopped, the runtime starts it on demand the moment a task needs it
  // (and auto-stops it when idle), so we don't block or nag. Work/Incognito are
  // never blocked — file tools run on the host, run_command starts Docker lazily.
  const composerDockerMsg = document.getElementById('composer-docker-msg');
  let dockerState = 'unknown';
  let dockerSizeHint = '';
  let dockerPollTimer = null;

  // Live "is the gateway usable for Full Power" flag. Seeded from the server via
  // the composer form's data-gateway-ok, then kept current by applyGatewayStatus
  // on every status change.
  let gatewayOk = (function seedGatewayOk() {
    if (form && form.dataset.gatewayOk != null) return form.dataset.gatewayOk !== '0';
    return true; // no signal → don't block
  })();

  // The sidebar "Start OpenClaw" banner only makes sense when the user actually
  // wants Full Power — the runtime modes (Work / Safe work / Incognito) never
  // touch the gateway. Tracked here so BOTH a gateway-status change and a mode
  // change re-evaluate the banner (see refreshGatewayOfflineBanner).
  let gatewayOffline = false;

  /** True only when OpenClaw is reachable for Full Power (Execute). */
  function isExecuteAvailable() {
    return gatewayOk;
  }

  /** Reflect gateway availability on the Full Power option + the input overlay. */
  function syncExecuteAvailability() {
    const avail = isExecuteAvailable();
    if (composerModeMenu) {
      const execItem = composerModeMenu.querySelector(
        '.composer-mode-menu-item[data-mode="execute"]',
      );
      if (execItem) execItem.classList.toggle('is-unavailable', !avail);
    }
    // Full Power with the gateway down is only a "switch mode below" situation
    // when the runtime modes are actually usable — i.e. an OpenRouter key is
    // set. Without a key those modes are locked, so don't disable the input
    // here; the submit handler surfaces the connect chooser instead.
    const blocked =
      !avail && getComposerMode() === 'execute' && openRouterReady;
    if (form) form.classList.toggle('is-exec-disabled', blocked);
    if (composerExecMsg) {
      composerExecMsg.setAttribute('aria-hidden', blocked ? 'false' : 'true');
    }
    refreshComposerInputDisabled();
    // The mode may have just changed — the sidebar "Start OpenClaw" banner is
    // gated on Full Power too, so keep it in sync from the same funnel.
    refreshGatewayOfflineBanner();
  }

  /**
   * The composer input is disabled while ANY blocking overlay is up — Full
   * Power with OpenClaw off, or a Docker-required mode with Docker off. Both
   * overlays cover the textarea, so the send target would be hidden anyway;
   * disabling input + send keeps keyboard submit from firing into nothing.
   */
  function refreshComposerInputDisabled() {
    const blocked = !!(
      form &&
      (form.classList.contains('is-exec-disabled') ||
        form.classList.contains('is-docker-disabled'))
    );
    if (input) input.disabled = blocked;
    const sb = document.getElementById('composer-send-btn');
    if (sb) sb.disabled = blocked;
  }

  /** True when the given mode can't run without a Docker daemon (Safe work). */
  function modeRequiresDocker(mode) {
    if (!composerModeMenu) return false;
    const item = composerModeMenu.querySelector(
      '.composer-mode-menu-item[data-mode="' + mode + '"]',
    );
    return !!item && item.dataset.requiresDocker === '1';
  }

  /**
   * Reflect Docker state. We only BLOCK when Docker is genuinely unusable —
   * i.e. not installed ('missing') — and only for a mode that can't run without
   * it (Safe work). When Docker is merely stopped we don't block or nag: the
   * runtime starts it on demand the moment a task needs it (and auto-stops it
   * when idle). Work/Incognito are never blocked — their file tools run on the
   * host and run_command starts Docker lazily. No-op until the first poll.
   */
  function syncDockerAvailability() {
    const missing = dockerState === 'missing';
    if (composerModeMenu) {
      composerModeMenu.querySelectorAll('.composer-mode-menu-item').forEach((el) => {
        if (el.dataset.requiresDocker === '1') {
          // A key-locked mode (no OpenRouter) stays locked regardless of Docker.
          el.classList.toggle('is-unavailable', missing || el.dataset.requiresKey === '1');
        }
      });
    }
    const mode = getComposerMode();
    const blocked = missing && modeRequiresDocker(mode);
    if (form) form.classList.toggle('is-docker-disabled', blocked);
    if (composerDockerMsg) {
      composerDockerMsg.setAttribute('aria-hidden', blocked ? 'false' : 'true');
    }
    applyDockerActionLabels();
    refreshComposerInputDisabled();
  }

  /** Button copy reflects whether Docker is missing (Install) or just idle (Start). */
  function applyDockerActionLabels() {
    const installing = dockerState === 'installing';
    const starting = dockerState === 'starting';
    const needsInstall = dockerState === 'missing';
    let label = needsInstall ? 'Install Docker' : 'Start Docker';
    if (installing) label = 'Installing Docker…';
    else if (starting) label = 'Starting Docker…';
    const busy = installing || starting;

    const mainBtn = document.getElementById('composer-docker-action');
    if (mainBtn) {
      mainBtn.textContent = label;
      mainBtn.disabled = busy;
    }
    const sizeEl = document.getElementById('composer-docker-size');
    if (sizeEl) sizeEl.textContent = needsInstall && !busy && dockerSizeHint ? dockerSizeHint : '';
  }

  function applyDockerState(next, sizeHint) {
    dockerState = next || 'unknown';
    if (typeof sizeHint === 'string' && sizeHint) dockerSizeHint = sizeHint;
    syncDockerAvailability();
  }

  function pollDockerStatus(opts) {
    fetch('/api/docker/status', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        applyDockerState(data.state, data.sizeHint);
        // Keep polling only while a start/install is in flight; otherwise the
        // state is settled and the next change is user-driven (button click).
        if (dockerState === 'installing' || dockerState === 'starting') {
          dockerPollTimer = setTimeout(() => pollDockerStatus(opts), 2500);
        }
      })
      .catch(() => {
        if (opts && opts.keepAlive) dockerPollTimer = setTimeout(() => pollDockerStatus(opts), 4000);
      });
  }

  function triggerDockerAction() {
    // Missing → install (which also starts); installed-but-idle → just start.
    const endpoint = dockerState === 'missing' ? '/api/docker/install' : '/api/docker/start';
    // Optimistic transient state so the button shows progress immediately.
    applyDockerState(dockerState === 'missing' ? 'installing' : 'starting', dockerSizeHint);
    fetch(endpoint, { method: 'POST', headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && data.state) applyDockerState(data.state, dockerSizeHint);
        if (dockerPollTimer) clearTimeout(dockerPollTimer);
        pollDockerStatus({ keepAlive: true });
      })
      .catch(() => {
        // Endpoint failed (e.g. non-localhost) — re-probe so the UI is honest.
        if (dockerPollTimer) clearTimeout(dockerPollTimer);
        pollDockerStatus({});
      });
  }

  (function initDockerGate() {
    const mainBtn = document.getElementById('composer-docker-action');
    if (mainBtn) mainBtn.addEventListener('click', triggerDockerAction);
    syncDockerAvailability();
    // First real status read; thereafter polling only runs during an action.
    pollDockerStatus({});
  })();

  // ── Incognito (ephemeral, never persisted) ────────────────────────────────
  // The conversation lives only in this tab: messages render locally, the turn
  // streams over `incognito-*` WS events keyed by `activeIncognitoKey`, and
  // nothing is written to the DB. Reloading the page clears it.
  let activeIncognitoKey = null;
  let incognitoReturnMode = composerModeDefault;

  function newIncognitoKey() {
    return 'inc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  /**
   * Leave Incognito → return to wherever we came from (that chat + the sidebar
   * come back). Incognito ran on a fresh ephemeral surface, so we just navigate
   * back; the ephemeral conversation is discarded.
   */
  function exitIncognito() {
    let origin = '/';
    try {
      origin = sessionStorage.getItem('iclaw:incognito-origin') || '/';
      sessionStorage.removeItem('iclaw:incognito-origin');
    } catch (_) {}
    window.location.assign(origin);
  }

  /** The fixed top-left × shown only in incognito. Created once, CSS toggles it. */
  function ensureIncognitoExitButton() {
    if (document.getElementById('incognito-exit')) return;
    const btn = document.createElement('button');
    btn.id = 'incognito-exit';
    btn.type = 'button';
    btn.className = 'incognito-exit';
    btn.setAttribute('aria-label', 'Exit Incognito');
    btn.title = 'Exit Incognito';
    btn.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
    btn.addEventListener('click', exitIncognito);
    document.body.appendChild(btn);
  }

  function syncIncognitoSurface(mode) {
    const on = mode === 'incognito';
    document.body.classList.toggle('incognito-mode', on);
    if (on) ensureIncognitoExitButton();
    let banner = document.getElementById('incognito-banner');
    if (on) {
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'incognito-banner';
        banner.className = 'incognito-banner';
        banner.innerHTML =
          '<svg class="incognito-banner__icon" viewBox="0 0 24 24" fill="none" ' +
          'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M2 12s3.5-7 10-7 10 7 10 7"/><path d="m4 4 16 16"/>' +
          '<path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>' +
          '<span>Incognito — read-only research. Your chat list is hidden, and this ' +
          'conversation isn’t saved or added to project memory.</span>';
        const root = typeof messagesAppendRoot === 'function' ? messagesAppendRoot() : messagesEl;
        (root || messagesEl)?.prepend(banner);
      }
      // Fresh session whenever incognito is (re)selected.
      activeIncognitoKey = null;
    } else if (banner) {
      banner.remove();
    }
  }

  /**
   * Finalize the streamed incognito reply (no message-appended for ephemeral
   * turns): render the full markdown, strip the streaming chrome, and release
   * the composer. Shared by the `incognito-turn-ended` event and the stop button.
   */
  function finalizeIncognitoStream() {
    setStopVisible(false);
    cancelStreamRender();
    if (currentStreamEl) {
      const body = currentStreamEl.querySelector('.stream-body, .msg-body');
      if (body && currentStreamFullText.trim()) {
        body.classList.remove('stream-body');
        body.innerHTML = renderMarkdown(currentStreamFullText);
        decorateMessageBody(body);
        currentStreamEl.classList.remove('streaming', 'stream-waiting', 'stream-tool', 'stream-generating');
        const st = currentStreamEl.querySelector('.stream-status');
        if (st) { stopStreamStatusDotAnim(st); st.remove(); }
      } else {
        currentStreamEl.remove();
      }
      currentStreamEl = null;
    }
    currentStreamFullText = '';
    streamShownLen = 0;
    if (inFlight) { inFlight = false; if (waitingItems[0]) flushNextQueued(); }
  }

  function closeComposerModeMenu() {
    if (!composerModeMenu) return;
    composerModeMenu.hidden = true;
    if (composerModeBtn) composerModeBtn.setAttribute('aria-expanded', 'false');
  }

  if (composerModeBtn && composerModeMenu) {
    // Initial mode precedence:
    //   1. server-persisted chat mode (data-chat-mode = chats.mode) — authoritative,
    //      survives navigation and syncs across devices.
    //   2. per-chat localStorage (legacy / offline fallback, existing chats only).
    //   3. the UI default (Work) — for new chats we ignore any stale GLOBAL
    //      localStorage value so a fresh chat always starts on the default.
    let stored = null;
    if (rawChatId) {
      try { stored = localStorage.getItem(MODE_STORAGE_KEY); } catch (_) {}
    }
    const chatMode = composerModesEl ? composerModesEl.dataset.chatMode : '';
    setComposerMode(chatMode || stored || composerModeDefault, { persist: false });
    // Entered via "Incognito" elsewhere → ?mode=incognito on a fresh surface.
    try {
      const _qp = new URLSearchParams(window.location.search);
      if (_qp.get('mode') === 'incognito' && composerModeIds.includes('incognito')) {
        setComposerMode('incognito', { persist: false });
        window.history.replaceState({}, '', window.location.pathname); // tidy the URL
      }
    } catch (_) {}

    composerModeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = composerModeMenu.hidden;
      composerModeMenu.hidden = !open;
      composerModeBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    const MODE_PLACEHOLDERS = {
      work:      'Work inside selected folders',
      secure:    'Run risky tasks in isolation',
      incognito: 'Private read-only research — nothing saved',
      execute:   'Use full iClaw power',
    };

    function updateComposerPlaceholder(mode) {
      if (input) input.placeholder = MODE_PLACEHOLDERS[mode] || 'Ask anything';
    }

    composerModeMenu.addEventListener('click', (e) => {
      const item = e.target.closest('.composer-mode-menu-item');
      if (!item) return;
      // Locked behind a missing OpenRouter key — re-offer connecting instead of
      // switching into a mode that can't run.
      if (item.dataset.requiresKey === '1') {
        closeComposerModeMenu();
        openConnectChooser();
        return;
      }
      // Incognito is a separate ephemeral surface, not a flag on the current
      // chat: open a fresh blank chat instead of converting this one. Remember
      // where we came from so the × can bring us back.
      if (item.dataset.mode === 'incognito' && !document.body.classList.contains('incognito-mode')) {
        try { sessionStorage.setItem('iclaw:incognito-origin', window.location.pathname + window.location.search); } catch (_) {}
        window.location.assign('/?mode=incognito');
        return;
      }
      setComposerMode(item.dataset.mode);
      closeComposerModeMenu();
      updateComposerPlaceholder(item.dataset.mode);
      if (typeof updateWorkFoldersButton === 'function') updateWorkFoldersButton();
      input?.focus();
    });

    // Set placeholder on initial load
    updateComposerPlaceholder(getComposerMode());
    document.addEventListener('click', (e) => {
      if (composerModeMenu.hidden) return;
      if (composerModesEl && !composerModesEl.contains(e.target)) closeComposerModeMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !composerModeMenu.hidden) closeComposerModeMenu();
    });
  }

  // -------------------------------------------------------------------------
  // Work Mode — folders picker
  // -------------------------------------------------------------------------
  const workFoldersBtn = document.getElementById('composer-work-folders-btn');
  const workFoldersModal = document.getElementById('work-folders-modal');
  const workFoldersList = document.getElementById('work-folders-list');
  const workFoldersInput = document.getElementById('work-folders-input');
  const workFoldersAddBtn = document.getElementById('work-folders-add-btn');
  const workFoldersBrowseBtn = document.getElementById('work-folders-browse-btn');
  const workFoldersClose = document.getElementById('work-folders-close');
  const workFoldersBackdrop = document.getElementById('work-folders-backdrop');
  const workFoldersCount = document.getElementById('composer-work-folders-count');

  function workFoldersKey() {
    const pid = messagesEl?.dataset.projectId;
    if (pid) return `iclaw:work-folders:project:${pid}`;
    return 'iclaw:work-folders:no-project';
  }

  // Folders are stored as { path, write }. Older clients stored bare path
  // strings — migrate those to writable (their effective behavior at the time)
  // so upgrading doesn't silently revoke access on existing folders. Newly
  // added folders default to read-only (see addFolder / browse below).
  function getWorkFolders() {
    let raw;
    try { raw = JSON.parse(localStorage.getItem(workFoldersKey()) || '[]'); }
    catch { return []; }
    if (!Array.isArray(raw)) return [];
    return raw
      .map((f) => (typeof f === 'string'
        ? { path: f, write: true }
        : (f && typeof f === 'object' && typeof f.path === 'string'
          ? { path: f.path, write: f.write === true }
          : null)))
      .filter(Boolean);
  }

  function saveWorkFolders(folders) {
    try { localStorage.setItem(workFoldersKey(), JSON.stringify(folders)); } catch {}
  }

  function escAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderWorkFoldersList() {
    if (!workFoldersList) return;
    const folders = getWorkFolders();
    workFoldersList.innerHTML = '';
    for (const f of folders) {
      const p = escAttr(f.path);
      const li = document.createElement('li');
      li.className = 'work-folders-list__item';
      const label = f.write ? 'Read & write' : 'Read-only';
      li.innerHTML =
        `<span class="work-folders-list__path" title="${p}">${p}</span>` +
        `<button type="button" class="work-folders-list__access" data-path="${p}" data-write="${f.write ? '1' : '0'}" ` +
        `title="Click to toggle access">${label}</button>` +
        `<button type="button" class="work-folders-list__remove" data-path="${p}" aria-label="Remove">×</button>`;
      workFoldersList.appendChild(li);
    }
    if (workFoldersCount) {
      workFoldersCount.textContent = folders.length > 0 ? String(folders.length) : '';
    }
  }

  // ── Network toggle (Secure Mode) ──────────────────────────────────────────
  const networkToggleBtn = document.getElementById('composer-network-toggle-btn');

  function networkKey() {
    const pid = messagesEl?.dataset.projectId;
    return pid ? `iclaw:secure-network:project:${pid}` : 'iclaw:secure-network:no-project';
  }

  function getNetworkEnabled() {
    try { return localStorage.getItem(networkKey()) === 'on'; } catch { return false; }
  }

  function setNetworkEnabledStorage(on) {
    try { localStorage.setItem(networkKey(), on ? 'on' : 'off'); } catch {}
  }

  function updateNetworkToggle() {
    if (!networkToggleBtn) return;
    const mode = getComposerMode();
    networkToggleBtn.hidden = (mode !== 'secure');
    const on = getNetworkEnabled();
    networkToggleBtn.dataset.network = on ? 'on' : 'off';
    networkToggleBtn.title = on ? 'Network is ON - click to disable' : 'Network is OFF - click to enable';
    networkToggleBtn.style.color = on ? 'var(--accent)' : '';
  }

  networkToggleBtn?.addEventListener('click', () => {
    const on = !getNetworkEnabled();
    setNetworkEnabledStorage(on);
    updateNetworkToggle();
  });

  function updateWorkFoldersButton() {
    if (!workFoldersBtn) return;
    const mode = getComposerMode();
    // Incognito also uses folders — as read-only roots for its sandboxed shell.
    workFoldersBtn.hidden = (mode !== 'work' && mode !== 'incognito');
    renderWorkFoldersList();
    updateNetworkToggle();
  }

  if (workFoldersBtn && workFoldersModal) {
    workFoldersBtn.addEventListener('click', () => {
      renderWorkFoldersList();
      workFoldersModal.hidden = false;
      workFoldersInput?.focus();
    });

    workFoldersList?.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.work-folders-list__remove');
      if (removeBtn) {
        const path = removeBtn.dataset.path;
        saveWorkFolders(getWorkFolders().filter((f) => f.path !== path));
        renderWorkFoldersList();
        return;
      }
      const accessBtn = e.target.closest('.work-folders-list__access');
      if (accessBtn) {
        const path = accessBtn.dataset.path;
        const folders = getWorkFolders().map((f) =>
          f.path === path ? { ...f, write: !f.write } : f);
        saveWorkFolders(folders);
        renderWorkFoldersList();
      }
    });

    function addFolderPath(val) {
      if (!val) return;
      const folders = getWorkFolders();
      if (!folders.some((f) => f.path === val)) {
        // New folders default to read-only; user opts into write explicitly.
        folders.push({ path: val, write: false });
        saveWorkFolders(folders);
        renderWorkFoldersList();
      }
    }

    function addFolder() {
      addFolderPath(workFoldersInput?.value.trim());
      if (workFoldersInput) workFoldersInput.value = '';
    }

    workFoldersAddBtn?.addEventListener('click', addFolder);
    workFoldersInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addFolder(); }
    });

    workFoldersBrowseBtn?.addEventListener('click', async () => {
      workFoldersBrowseBtn.disabled = true;
      try {
        const res = await fetch('/api/pick-folder', { method: 'POST' });
        if (res.status === 204) return; // user cancelled
        const data = await res.json();
        if (data.path) addFolderPath(data.path);
      } catch (e) {
        console.error('pick-folder failed', e);
      } finally {
        workFoldersBrowseBtn.disabled = false;
      }
    });

    const closeModal = () => { workFoldersModal.hidden = true; };
    workFoldersClose?.addEventListener('click', closeModal);
    workFoldersBackdrop?.addEventListener('click', closeModal);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !workFoldersModal.hidden) closeModal();
    });
  }

  updateWorkFoldersButton();

  // ── Secure workspace bar ─────────────────────────────────────────────────
  const secureBar = document.getElementById('secure-workspace-bar');
  const secureSizeEl = document.getElementById('secure-workspace-size');
  const secureTtlPrefixEl = document.getElementById('secure-workspace-ttl-prefix');
  const secureTtlValueBtn = document.getElementById('secure-workspace-ttl-value');
  const secureTtlMenu = document.getElementById('secure-ttl-menu');

  // Read the chat id live, not from the page-load `rawChatId` const. A chat that
  // starts as a draft has no id until the first message adopts it (adoptDraftChat
  // updates messagesEl.dataset.chatId); `rawChatId` stays empty, so keying the
  // bar off it left it hidden until a reload re-rendered at /chats/:id.
  const secureChatId = () => messagesEl?.dataset.chatId || '';

  function secureTtlKey() {
    // Per-chat TTL: every new chat starts from the 7-day default, and changing
    // it affects only that chat. (Previously chats in a project shared one TTL,
    // so a new project chat could inherit 30 — we don't want that.)
    return `iclaw:secure-ttl:chat:${secureChatId()}`;
  }

  function getSecureTtl() {
    try {
      const raw = localStorage.getItem(secureTtlKey());
      return raw ? JSON.parse(raw) : { ttlDays: 7, lastActivity: Date.now() };
    } catch { return { ttlDays: 7, lastActivity: Date.now() }; }
  }

  function saveSecureTtl(ttlDays) {
    try {
      localStorage.setItem(secureTtlKey(), JSON.stringify({ ttlDays, lastActivity: Date.now() }));
    } catch {}
  }

  function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // Returns { prefix, value } so the value can render as a separate inline,
  // clickable element ("deletes in [6d]") while the prefix stays plain text.
  function formatTtlRemaining(ttlDays, lastActivity) {
    if (ttlDays === 0) return { prefix: '', value: 'never deleted' };
    // +15s demo buffer: holds the full day count for ~15s after each reset so
    // users can see the countdown tick down (proof the TTL resets on activity).
    const expiresAt = lastActivity + ttlDays * 86400_000 + 15_000;
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) return { prefix: '', value: 'deleted' };
    const days = Math.floor(remaining / 86400_000);
    const hours = Math.floor((remaining % 86400_000) / 3600_000);
    const mins = Math.floor((remaining % 3600_000) / 60_000);
    const secs = Math.floor((remaining % 60_000) / 1000);
    let value;
    // More than 2 days: show only days (no hours)
    if (days > 2) value = `${days}d`;
    else if (days > 0) value = `${days}d ${hours}h`;
    else if (hours > 0) value = `${hours}h ${mins}m`;
    else if (mins > 0) value = `${mins}m ${secs}s`;
    else value = `${secs}s`;
    return { prefix: 'deletes in', value };
  }

  // True when the secret hint UI is visible — it takes priority over the secure bar.
  function secretUiVisible() {
    const el = document.getElementById('composer-secret-ui');
    return el && !el.hidden;
  }

  // Update only the TTL text (cheap, local — ticks every second).
  function tickSecureTtl() {
    if (!secureBar || secureBar.hidden) return;
    const ttl = getSecureTtl();
    const { prefix, value } = formatTtlRemaining(ttl.ttlDays, ttl.lastActivity);
    // Trailing space separates the plain prefix from the clickable value.
    if (secureTtlPrefixEl) secureTtlPrefixEl.textContent = prefix ? prefix + ' ' : '';
    if (secureTtlValueBtn) secureTtlValueBtn.textContent = value;
  }

  async function refreshSecureBar() {
    if (!secureBar) return;
    const mode = getComposerMode();
    const cid = secureChatId();
    // Hide if not in Secure Mode, or if the secret UI is currently showing.
    if (mode !== 'secure' || secretUiVisible() || !cid) { secureBar.hidden = true; return; }

    try {
      const res = await fetch(`/chats/${cid}/workspace-info`);
      const data = await res.json();
      // Only surface the bar once a secure session actually exists — i.e. after
      // the first message. Nothing is created on the host until then.
      // Show the bar only once the sandbox actually holds something — an empty
      // workspace has nothing to time, save, or destroy, so we surface nothing
      // (not even the "Secure workspace" label) until the agent writes a file.
      const size = data.active && data.workspaceSize != null ? data.workspaceSize : 0;
      if (!size) { secureBar.hidden = true; return; }
      secureBar.hidden = false;
      if (secureSizeEl) {
        secureSizeEl.textContent = formatBytes(size);
        secureSizeEl.hidden = false;
      }
      tickSecureTtl();
    } catch { secureBar.hidden = true; }
  }

  // Live countdown — updates the TTL text every second.
  setInterval(tickSecureTtl, 1000);

  secureTtlValueBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (secureTtlMenu) {
      secureTtlMenu.hidden = !secureTtlMenu.hidden;
    }
  });

  secureTtlMenu?.addEventListener('click', (e) => {
    const item = e.target.closest('[data-ttl]');
    if (!item) return;
    saveSecureTtl(Number(item.dataset.ttl));
    secureTtlMenu.hidden = true;
    refreshSecureBar();
  });

  // Save a copy of the sandbox out to a host folder (default ~/Downloads).
  // Read-only — copies the sandbox contents to a fresh place, touches nothing of
  // the user's. Confirmed first with a plain-language explanation.
  const secureExportBtn = document.getElementById('secure-workspace-export');
  secureExportBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const cid = secureChatId();
    if (!cid) return;
    if (!confirm(
      'Save a copy of this secure workspace to your Downloads folder?\n\n'
      + 'Heads up - these files leave the safe sandbox and land on your real computer. '
      + 'If anything was downloaded in here, it could carry viruses or other nasty surprises\n\n'
      + 'That\'s exactly what the sandbox is for - to keep anything dangerous trapped in there'
    )) return;
    // The button holds an icon + label (not text), so don't touch textContent —
    // just disable it for the duration of the copy.
    secureExportBtn.disabled = true;
    try {
      const res = await fetch(`/chats/${cid}/export-sandbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: '{}',
      });
      const data = await res.json();
      if (data && data.ok) alert(`Saved a copy${data.files != null ? ` (${data.files} files)` : ''} here:\n${data.path}`);
      else alert(`Couldn't save the copy: ${(data && data.error) || 'unknown error'}`);
    } catch { alert("Couldn't save the copy."); }
    secureExportBtn.disabled = false;
  });

  // Destroy the sandbox: deletes the copied workspace + container. The next
  // message starts a fresh sandbox (re-copying any selected folders).
  const secureDestroyBtn = document.getElementById('secure-workspace-destroy');
  secureDestroyBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const cid = secureChatId();
    if (!cid) return;
    if (!confirm('Delete this sandbox now? Everything copied or created inside it is removed right away - your original files on your computer are not touched')) return;
    // The button holds an icon + label (not text), so don't touch textContent —
    // just disable it; the bar refreshes (and usually hides) once it's gone.
    secureDestroyBtn.disabled = true;
    try {
      await fetch(`/chats/${cid}/destroy-workspace`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
    } catch { /* best-effort */ }
    secureDestroyBtn.disabled = false;
    refreshSecureBar();
  });

  document.addEventListener('click', (e) => {
    if (secureTtlMenu && !secureTtlMenu.hidden && !secureTtlValueBtn?.contains(e.target) && !secureTtlMenu.contains(e.target)) {
      secureTtlMenu.hidden = true;
    }
  });

  // Refresh bar when mode changes
  composerModeMenu?.addEventListener('click', () => setTimeout(refreshSecureBar, 50));
  refreshSecureBar();

  // -------------------------------------------------------------------------
  // Speech-to-text (mic). Records via MediaRecorder, POSTs the clip to
  // /api/stt, and inserts the returned transcript into the composer textarea.
  // Only wired when the server rendered the button (OPENROUTER_API_KEY set).
  // Hold to record; slide left to cancel; slide up to lock hands-free.
  // -------------------------------------------------------------------------
  const micBtn = document.getElementById('composer-mic-btn');
  if (micBtn && navigator.mediaDevices && window.MediaRecorder) {
    // Telegram/WhatsApp-style hold-to-record gesture ported from the Flutter
    // app: hold the mic to record, slide left to cancel, slide up to lock
    // hands-free. A Web Audio meter drives the live waveform + amplitude halo.
    // The post-release pipeline (audio → /api/stt → transcript) is unchanged.
    const recEl = document.getElementById('composer-recording');
    const recTimeEl = document.getElementById('composer-recording-time');
    const recHintEl = document.getElementById('composer-recording-hint');
    const recCancelBtn = document.getElementById('composer-recording-cancel');
    const recWave = document.getElementById('composer-recording-wave');
    const lockHintEl = document.getElementById('composer-lock-hint');
    const composerFieldEl = micBtn.closest('.composer-field');

    const CANCEL_DX = 72; // px dragged left to arm cancel
    const LOCK_DY = 96; // px dragged up to lock hands-free
    const MIN_MS = 800; // discard clips shorter than this
    const REST_HINT = '‹ slide to cancel · slide up to lock';

    let mediaRecorder = null;
    let mediaStream = null;
    let micChunks = [];
    // phase: 'idle' | 'starting' | 'recording' | 'locked'
    let phase = 'idle';
    let pendingSend = false;
    let willCancel = false;
    let ignoreNextUp = false;
    let startedAt = 0;
    let activePointerId = null;
    let startX = 0;
    let startY = 0;
    let holdHintTimer = 0;
    // Caret captured when recording starts, so the transcript is inserted at
    // the cursor (dictate-into-text) instead of appended at the end.
    let savedSelStart = null;
    let savedSelEnd = null;

    // Web Audio meter (live waveform + amplitude halo).
    let audioCtx = null;
    let analyser = null;
    let sourceNode = null;
    let meterRaf = 0;
    let timeData = null;
    let waveSamples = [];
    // Advance the waveform on a fixed cadence (not once per animation frame) so
    // the bars scroll at a calm, readable speed regardless of the display's
    // refresh rate. Between pushes we keep the loudest level seen, so a brief
    // peak still lands as a tall bar.
    const WAVE_SAMPLE_MS = 55;
    let lastWaveAt = 0;
    let wavePeak = 0;
    let accentColor = '#4f8cff';
    let dangerColor = '#e5484d';

    function setMicState(state) {
      micBtn.dataset.state = state;
      micBtn.setAttribute(
        'aria-pressed',
        state === 'recording' || state === 'locked' ? 'true' : 'false',
      );
      micBtn.title =
        state === 'recording'
          ? 'Release to send · slide to cancel'
          : state === 'locked'
            ? 'Tap to send'
            : state === 'busy'
              ? 'Transcribing…'
              : 'Hold to record';
    }

    function pickMicMime() {
      if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
      const cands = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
        'audio/mp4',
        'audio/mpeg',
      ];
      return cands.find((t) => MediaRecorder.isTypeSupported(t)) || '';
    }

    function stopMicStream() {
      if (mediaStream) {
        mediaStream.getTracks().forEach((t) => t.stop());
        mediaStream = null;
      }
    }

    function insertTranscript(text) {
      if (!input || !text) return;
      const val = input.value || '';
      // Insert at the caret captured when recording began; fall back to the end
      // when the field wasn't focused (savedSel* are null).
      let start = typeof savedSelStart === 'number' ? savedSelStart : val.length;
      let end = typeof savedSelEnd === 'number' ? savedSelEnd : val.length;
      start = Math.max(0, Math.min(start, val.length));
      end = Math.max(start, Math.min(end, val.length));
      const before = val.slice(0, start);
      const after = val.slice(end);
      // Pad so dictated words don't collide with the surrounding text.
      const lead = before && !/\s$/.test(before) ? ' ' : '';
      const trail = after && !/^\s/.test(after) ? ' ' : '';
      const piece = lead + text + trail;
      input.value = before + piece + after;
      const caret = before.length + (lead + text).length;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      try {
        input.setSelectionRange(caret, caret);
      } catch (_) {}
      // Keep the caret in sync for a possible next dictation.
      savedSelStart = caret;
      savedSelEnd = caret;
    }

    async function transcribeBlob(blob) {
      const res = await fetch('/api/stt', {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm' },
        body: blob,
      });
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try {
          const j = await res.json();
          if (j && j.error) msg = j.error;
        } catch (_) {}
        throw new Error(msg);
      }
      const j = await res.json();
      return j && typeof j.text === 'string' ? j.text.trim() : '';
    }

    async function onMicStop() {
      stopMeter();
      stopMicStream();
      const send = pendingSend;
      const type = (mediaRecorder && mediaRecorder.mimeType) || 'audio/webm';
      const blob = new Blob(micChunks, { type });
      micChunks = [];
      if (!send || !blob.size) {
        setMicState('idle');
        return;
      }
      setMicState('busy');
      try {
        const text = await transcribeBlob(blob);
        if (text) insertTranscript(text);
      } catch (err) {
        window.alert(
          'Transcription failed: ' + (err && err.message ? err.message : 'unknown error'),
        );
      } finally {
        setMicState('idle');
      }
    }

    // ----- recording UI -----
    function fmtTime(ms) {
      const cs = Math.floor(ms / 10) % 100;
      const totalSec = Math.floor(ms / 1000);
      const p2 = (n) => String(n).padStart(2, '0');
      return p2(Math.floor(totalSec / 60)) + ':' + p2(totalSec % 60) + '.' + p2(cs);
    }

    function readThemeColors() {
      try {
        const cs = getComputedStyle(document.documentElement);
        const a = cs.getPropertyValue('--accent').trim();
        const d = cs.getPropertyValue('--danger').trim();
        if (a) accentColor = a;
        if (d) dangerColor = d;
      } catch (_) {}
    }

    function sizeWaveCanvas() {
      if (!recWave) return;
      const dpr = window.devicePixelRatio || 1;
      const w = recWave.clientWidth || 160;
      recWave.width = Math.max(1, Math.round(w * dpr));
      recWave.height = Math.round(26 * dpr);
    }

    function positionLockHint() {
      if (!lockHintEl || !composerFieldEl) return;
      const r = micBtn.getBoundingClientRect();
      const fr = composerFieldEl.getBoundingClientRect();
      lockHintEl.style.left = r.left - fr.left + r.width / 2 + 'px';
      lockHintEl.style.bottom = fr.bottom - r.top + 10 + 'px';
    }

    function showRecordingUI() {
      readThemeColors();
      window.clearTimeout(holdHintTimer);
      if (composerFieldEl) composerFieldEl.classList.add('is-recording');
      if (recEl) {
        recEl.classList.remove('is-cancel', 'is-locked', 'is-hint');
        recEl.hidden = false;
      }
      micBtn.classList.remove('is-cancel');
      if (recHintEl) recHintEl.textContent = REST_HINT;
      if (recTimeEl) recTimeEl.textContent = '00:00.00';
      sizeWaveCanvas();
      if (lockHintEl) {
        lockHintEl.classList.remove('is-locked');
        lockHintEl.style.setProperty('--lock-progress', '0');
        lockHintEl.hidden = false;
        positionLockHint();
      }
    }

    function hideRecordingUI() {
      if (composerFieldEl) composerFieldEl.classList.remove('is-recording');
      if (recEl) {
        recEl.hidden = true;
        recEl.classList.remove('is-cancel', 'is-locked', 'is-hint');
      }
      if (lockHintEl) lockHintEl.hidden = true;
      micBtn.classList.remove('is-cancel');
      micBtn.style.setProperty('--mic-amp', '0');
    }

    function setCancelArmed(on) {
      if (willCancel === on) return;
      willCancel = on;
      if (recEl) recEl.classList.toggle('is-cancel', on);
      micBtn.classList.toggle('is-cancel', on);
      if (recHintEl && phase === 'recording') {
        recHintEl.textContent = on ? 'release to cancel' : REST_HINT;
      }
    }

    function setLockProgress(p) {
      if (lockHintEl) {
        lockHintEl.style.setProperty('--lock-progress', String(Math.max(0, Math.min(1, p))));
      }
    }

    function flashHoldHint() {
      // Quick tap (no real recording) → briefly coach the user to hold.
      if (!recEl) return;
      if (composerFieldEl) composerFieldEl.classList.add('is-recording');
      recEl.classList.add('is-hint');
      recEl.hidden = false;
      if (recHintEl) recHintEl.textContent = 'hold the mic to record';
      window.clearTimeout(holdHintTimer);
      holdHintTimer = window.setTimeout(() => {
        recEl.classList.remove('is-hint');
        if (phase === 'idle') {
          recEl.hidden = true;
          if (composerFieldEl) composerFieldEl.classList.remove('is-recording');
        }
      }, 1100);
    }

    // ----- Web Audio meter -----
    function startMeter(stream) {
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        audioCtx = new Ctx();
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        sourceNode = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.65;
        sourceNode.connect(analyser);
        timeData = new Uint8Array(analyser.fftSize);
        waveSamples = [];
        lastWaveAt = 0;
        wavePeak = 0;
      } catch (_) {
        // Meter is best-effort; recording still works without it.
      }
      meterRaf = requestAnimationFrame(meterFrame);
    }

    function stopMeter() {
      if (meterRaf) cancelAnimationFrame(meterRaf);
      meterRaf = 0;
      try { if (sourceNode) sourceNode.disconnect(); } catch (_) {}
      try { if (audioCtx) audioCtx.close(); } catch (_) {}
      sourceNode = null;
      analyser = null;
      audioCtx = null;
      timeData = null;
    }

    function meterFrame() {
      meterRaf = requestAnimationFrame(meterFrame);
      if (phase === 'recording' || phase === 'locked') {
        if (recTimeEl) recTimeEl.textContent = fmtTime(Date.now() - startedAt);
      }
      let level = 0;
      if (analyser && timeData) {
        analyser.getByteTimeDomainData(timeData);
        let sum = 0;
        for (let i = 0; i < timeData.length; i++) {
          const v = (timeData[i] - 128) / 128;
          sum += v * v;
        }
        // Higher gain so normal speech clearly pushes the bars up: quiet stays
        // near the baseline, loud reaches (near) full height.
        level = Math.min(1, Math.sqrt(sum / timeData.length) * 3.0);
      }
      // The halo tracks the live level every frame for a smooth pulse…
      micBtn.style.setProperty('--mic-amp', level.toFixed(3));
      // …but the waveform only advances every WAVE_SAMPLE_MS, carrying the peak
      // level from the in-between frames so loud moments read as tall bars.
      wavePeak = Math.max(wavePeak, level);
      const now = performance.now();
      if (now - lastWaveAt >= WAVE_SAMPLE_MS) {
        lastWaveAt = now;
        waveSamples.push(wavePeak);
        wavePeak = 0;
        drawWave();
      }
    }

    function drawWave() {
      if (!recWave) return;
      const ctx = recWave.getContext('2d');
      if (!ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const w = recWave.width;
      const h = recWave.height;
      ctx.clearRect(0, 0, w, h);
      const barW = 2 * dpr;
      const step = barW + 2 * dpr;
      const n = Math.max(1, Math.floor(w / step));
      if (waveSamples.length > n) waveSamples = waveSamples.slice(-n);
      const data = waveSamples;
      const mid = h / 2;
      ctx.fillStyle = willCancel ? dangerColor : accentColor;
      for (let i = 0; i < data.length; i++) {
        const bh = Math.max(2 * dpr, data[i] * h * 0.92);
        const x = w - (data.length - i) * step;
        const r = barW / 2;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, mid - bh / 2, barW, bh, r);
        else ctx.rect(x, mid - bh / 2, barW, bh);
        ctx.fill();
      }
    }

    // ----- lifecycle -----
    async function beginRecording() {
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (_) {
        phase = 'idle';
        activePointerId = null;
        hideRecordingUI();
        window.alert('Microphone access was blocked. Allow it in your browser to use voice input.');
        return;
      }
      // The user may have released or cancelled while the permission prompt was
      // open. If we're no longer arming, drop the freshly acquired stream.
      if (phase !== 'starting') {
        stopMicStream();
        return;
      }
      micChunks = [];
      const mimeType = pickMicMime();
      try {
        mediaRecorder = mimeType
          ? new MediaRecorder(mediaStream, { mimeType })
          : new MediaRecorder(mediaStream);
      } catch (_) {
        mediaRecorder = new MediaRecorder(mediaStream);
      }
      mediaRecorder.addEventListener('dataavailable', (e) => {
        if (e.data && e.data.size) micChunks.push(e.data);
      });
      mediaRecorder.addEventListener('stop', onMicStop);
      mediaRecorder.start();
      phase = 'recording';
      startedAt = Date.now();
      pendingSend = false;
      willCancel = false;
      setMicState('recording');
      showRecordingUI();
      startMeter(mediaStream);
      try { if (input) input.blur(); } catch (_) {}
    }

    function finishRecording(send) {
      if (phase !== 'recording' && phase !== 'locked') return;
      const longEnough = Date.now() - startedAt >= MIN_MS;
      pendingSend = !!send && longEnough && !willCancel;
      if (send && !longEnough && navigator.vibrate) {
        try { navigator.vibrate([15, 40, 15]); } catch (_) {}
      }
      phase = 'idle';
      willCancel = false;
      ignoreNextUp = false;
      activePointerId = null;
      hideRecordingUI();
      if (send && !longEnough) flashHoldHint();
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        try { mediaRecorder.stop(); } catch (_) { onMicStop(); }
      } else {
        onMicStop();
      }
    }

    function cancelRecording() {
      finishRecording(false);
    }

    function lockRecording() {
      if (phase !== 'recording') return;
      phase = 'locked';
      ignoreNextUp = true;
      setCancelArmed(false);
      setMicState('locked');
      if (recEl) recEl.classList.add('is-locked');
      // Lock confirmed — hide the floating lock pill so it doesn't sit over the
      // bar; the mic itself turns into the send button and Cancel drops to the
      // toolbar row.
      if (lockHintEl) lockHintEl.hidden = true;
      try { micBtn.releasePointerCapture(activePointerId); } catch (_) {}
      sizeWaveCanvas();
    }

    // ----- pointer gesture -----
    micBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (micBtn.dataset.state === 'busy') return;
      // In locked mode a fresh tap on the mic sends.
      if (phase === 'locked') {
        finishRecording(true);
        return;
      }
      if (phase !== 'idle') return;
      // Capture the caret so the transcript lands where the user put it. Only
      // when the textarea is focused; otherwise append at the end (null).
      if (input && document.activeElement === input) {
        savedSelStart = input.selectionStart;
        savedSelEnd = input.selectionEnd;
      } else {
        savedSelStart = null;
        savedSelEnd = null;
      }
      phase = 'starting';
      willCancel = false;
      activePointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      try { micBtn.setPointerCapture(e.pointerId); } catch (_) {}
      beginRecording();
    });

    micBtn.addEventListener('pointermove', (e) => {
      if (phase !== 'recording') return;
      if (activePointerId !== null && e.pointerId !== activePointerId) return;
      const dx = startX - e.clientX; // leftward positive
      const dy = startY - e.clientY; // upward positive
      setCancelArmed(dx >= CANCEL_DX);
      if (willCancel) {
        setLockProgress(0);
        return;
      }
      setLockProgress(dy / LOCK_DY);
      if (dy >= LOCK_DY) lockRecording();
    });

    function onPointerEnd(e) {
      if (activePointerId !== null && e.pointerId !== activePointerId) return;
      if (phase === 'starting') {
        // Released before recording actually began → treat as a quick tap.
        phase = 'idle';
        activePointerId = null;
        stopMicStream();
        flashHoldHint();
        return;
      }
      if (phase === 'recording') {
        finishRecording(!willCancel);
        return;
      }
      if (phase === 'locked' && ignoreNextUp) {
        // The release that triggered the lock — keep recording hands-free.
        ignoreNextUp = false;
      }
    }

    micBtn.addEventListener('pointerup', onPointerEnd);
    micBtn.addEventListener('pointercancel', (e) => {
      if (activePointerId !== null && e.pointerId !== activePointerId) return;
      if (phase === 'starting') {
        phase = 'idle';
        activePointerId = null;
        stopMicStream();
        return;
      }
      if (phase === 'recording') cancelRecording();
    });

    if (recCancelBtn) {
      recCancelBtn.addEventListener('click', (e) => {
        e.preventDefault();
        cancelRecording();
      });
    }

    window.addEventListener('resize', () => {
      if (phase === 'recording' || phase === 'locked') {
        sizeWaveCanvas();
        positionLockHint();
      }
    });
  }

  /** Clears timed reply-quote highlights in the transcript. */
  let replyJumpHighlightTimer = null;
  let replyJumpHighlightFadeTimer = null;

  function cancelReplyJumpHighlightTimers() {
    if (replyJumpHighlightTimer != null) {
      clearTimeout(replyJumpHighlightTimer);
      replyJumpHighlightTimer = null;
    }
    if (replyJumpHighlightFadeTimer != null) {
      clearTimeout(replyJumpHighlightFadeTimer);
      replyJumpHighlightFadeTimer = null;
    }
  }
  /** After project pick on draft home: null = no project, number = id. Meaningful only when `draftProjectLocked`. */
  let draftChosenProjectId = null;
  let draftProjectLocked = false;

  let composerSecretNextSlot = 0;
  /** @type {Map<number, { label: string; plain: string }>} */
  const composerSecretBySlot = new Map();
  let composerTokenDetectTimer = null;
  /** @type {{ start: number; end: number } | null} */
  let composerTokenDetectRange = null;

  function currentComposerProjectId() {
    if (activeChatId != null && messagesEl?.dataset.projectId) {
      const n = Number(messagesEl.dataset.projectId);
      if (Number.isFinite(n) && n > 0) return n;
    }
    if (
      draftChosenProjectId != null &&
      Number.isFinite(draftChosenProjectId) &&
      draftChosenProjectId > 0
    ) {
      return draftChosenProjectId;
    }
    return null;
  }

  /** Picker / use-in-chat need a persisted chat row (draft is ok). */
  function composerSecretContext() {
    if (activeChatId != null) {
      return {
        pickerUrl: '/chats/' + encodeURIComponent(activeChatId) + '/secrets/picker',
        useInChatUrl: (secretId) =>
          '/chats/' +
          encodeURIComponent(activeChatId) +
          '/secrets/' +
          encodeURIComponent(secretId) +
          '/use-in-chat',
      };
    }
    return null;
  }

  function composerSecretsEnabled() {
    if (activeChatId != null) return true;
    return Boolean(startedOnDraft && draftProjectLocked);
  }

  function composerSecretsBlockedMessage() {
    if (draftChatCreating) return 'Preparing chat…';
    if (startedOnDraft && !draftProjectLocked) {
      return 'Choose a project (or No project) on the home screen first.';
    }
    if (startedOnDraft && draftProjectLocked && activeChatId == null) {
      return 'Could not prepare chat. Try choosing the project again.';
    }
    return 'Open a chat to save secrets.';
  }

  let draftChatCreating = false;

  /** Adopt a server chat id on the home draft flow (URL + WS subscribe; sidebar optional). */
  function adoptDraftChat(payload, opts) {
    const id = Number(payload?.chatId);
    if (!Number.isFinite(id)) return;
    activeChatId = id;
    if (messagesEl) {
      messagesEl.dataset.chatId = String(id);
      delete messagesEl.dataset.draft;
      if (payload.projectId != null && Number.isFinite(Number(payload.projectId))) {
        messagesEl.dataset.projectId = String(payload.projectId);
      } else {
        messagesEl.dataset.projectId = '';
      }
      if (typeof updateWorkFoldersButton === 'function') updateWorkFoldersButton();
    }
    history.replaceState(null, '', '/chats/' + id);
    promoteDraftHeaderTools(id, payload.projectId);
    // Migrate mode from the draft fallback key to the per-chat key
    try {
      const draftMode = localStorage.getItem('iclaw:composer-mode');
      if (draftMode) localStorage.setItem(`iclaw:composer-mode:${id}`, draftMode);
    } catch (_) {}
    applyTitleForActive(payload.title || 'New chat');
    if (ws && ws.readyState === WebSocket.OPEN) {
      wsSend({ type: 'subscribe', chatId: id });
    }
    if (opts?.sidebar !== false) {
      sidebarUpsertChat({
        id,
        title: payload.title || 'New chat',
        agent: payload.agent,
        projectId: payload.projectId,
        projectName: payload.projectName,
        updatedAt: payload.updatedAt,
      });
      if (searchInput && searchInput.value.trim()) scheduleSidebarSearch();
    }
    syncComposerSecretUi();
  }

  /**
   * Promote the dormant draft header tools into a live chat's tools once the row
   * exists. The draft renders them hidden + action-less (see
   * partials/header-chat-tools.ejs); here we fill in the /chats/:id actions and
   * reveal them — so Share, Delete (and Suggest-facts, when the draft
   * chose a project) show up immediately instead of only after a reload. Queries
   * are scoped to the header so they don't hit the share modal's own .share-form.
   */
  function promoteDraftHeaderTools(id, projectId) {
    if (!startedOnDraft) return;
    const header = document.querySelector('.chat-header-tools');
    if (!header) return;
    const shareBtn = document.getElementById('share-btn');
    if (shareBtn) shareBtn.hidden = false;
    const delForm = header.querySelector('.delete-form');
    if (delForm) {
      delForm.setAttribute('action', '/chats/' + id + '/delete');
      delForm.hidden = false;
    }
    const hasProject =
      (projectId != null && Number.isFinite(Number(projectId))) ||
      (draftChosenProjectId != null && Number.isFinite(draftChosenProjectId));
    const sharesForm = header.querySelector('.share-form');
    if (sharesForm && hasProject) {
      sharesForm.setAttribute('action', '/chats/' + id + '/shares');
      sharesForm.hidden = false;
    }
  }

  async function ensureDraftChatRow() {
    if (activeChatId != null) return;
    const body = { agent: draftAgentSelect?.value || 'openclaw/default' };
    if (draftChosenProjectId != null && Number.isFinite(draftChosenProjectId)) {
      body.projectId = draftChosenProjectId;
    }
    const res = await fetch('/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(t || 'HTTP ' + res.status);
    }
    adoptDraftChat(await res.json(), { sidebar: false });
  }

  function selectionInsideIclawPlaceholder(text, start, end) {
    const lastOpen = text.lastIndexOf('[[iclaw:', end);
    if (lastOpen === -1 || lastOpen > start) return false;
    const close = text.indexOf(']]', lastOpen);
    if (close === -1) return false;
    return close >= end - 1;
  }

  /** Strip line breaks for regex matching; map compact indices back to `text`. */
  function compactSecretSearchText(text) {
    const indices = [];
    let compact = '';
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 10 || c === 13) continue;
      indices.push(i);
      compact += text[i];
    }
    return { compact, indices };
  }

  function rangeFromCompact(indices, compactStart, compactEnd) {
    if (!indices.length || compactStart >= indices.length) return null;
    const endIdx = Math.min(compactEnd, indices.length) - 1;
    return { start: indices[compactStart], end: indices[endIdx] + 1 };
  }

  /**
   * Detect well-known API-token shapes in `text`. All patterns are anchored to
   * a specific vendor prefix to keep false-positives near zero — we do NOT do
   * generic high-entropy matching (would fire on UUIDs / hashes / commit SHAs).
   * If multiple shapes hit, the LONGEST match wins. Line breaks inside a token
   * are ignored for matching (range still spans the original newlines).
   */
  function findLikelyTokenRange(text) {
    const patterns = [
      // ── OpenAI / OpenAI-style (also catches Anthropic sk-ant-* via the same prefix). ──
      /\bsk-[a-zA-Z0-9_-]{16,}\b/g,
      // ── GitHub: classic PAT and fine-grained PAT. ──
      /\bghp_[a-zA-Z0-9]{36}\b/g,
      /\bghu_[a-zA-Z0-9]{36}\b/g, // user-to-server OAuth
      /\bghs_[a-zA-Z0-9]{36}\b/g, // server-to-server OAuth
      /\bghr_[a-zA-Z0-9]{36}\b/g, // refresh
      /\bgho_[a-zA-Z0-9]{36}\b/g, // OAuth access
      /\bgithub_pat_[a-zA-Z0-9_]{22,}\b/g,
      // ── GitLab. ──
      /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
      // ── AWS access keys (standard + temporary). ──
      /\b(?:AKIA|ASIA|AIDA|AROA|ANPA|ANVA|APKA)[0-9A-Z]{16}\b/g,
      // ── Slack tokens (bot, user, app, refresh, app-level, legacy app-token). ──
      /\bxox[abprso]-[A-Za-z0-9-]{10,}\b/g,
      /\bxapp-[0-9]+-[A-Z0-9]+-[0-9]+-[A-Za-z0-9]+\b/g,
      // ── Stripe (secret / publishable / restricted, live + test). ──
      /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
      // ── Google API keys + OAuth client IDs. ──
      /\bAIza[0-9A-Za-z_-]{35}\b/g,
      /\b[0-9]+-[0-9A-Za-z_-]{32}\.apps\.googleusercontent\.com\b/g,
      // ── Shopify. ──
      /\bshpat_[a-fA-F0-9]{32}\b/g,
      /\bshppa_[a-fA-F0-9]{32}\b/g,
      /\bshpss_[a-fA-F0-9]{32}\b/g,
      // ── Twilio. ──
      /\bSK[0-9a-fA-F]{32}\b/g,
      // ── SendGrid. ──
      /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g,
      // ── Mailgun (key-…). ──
      /\bkey-[a-z0-9]{32}\b/g,
      // ── Brevo / Sendinblue. ──
      /\bxkeysib-[a-zA-Z0-9]{64}-[a-zA-Z0-9]{16}\b/g,
      // ── Telegram bot token. Looks like `<digits>:<35+ chars>`; we
      //    constrain the prefix length to avoid matching dates/timestamps. ──
      /\b\d{8,12}:[A-Za-z0-9_-]{35,}\b/g,
      // ── Discord bot token. Three dot-separated base64url segments. ──
      /\b[MN][A-Za-z\d]{23}\.[\w-]{6}\.[\w-]{27,}\b/g,
      // ── JWT (header.payload.signature — header always starts with "eyJ"). ──
      /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    ];
    const blockPatterns = [
      /-----BEGIN [A-Z0-9 ]+-----[\r\n]+(?:[A-Za-z0-9+/=\r\n]+)[\r\n]*-----END [A-Z0-9 ]+-----/g,
    ];
    let best = null;
    let bestLen = 0;

    function consider(start, end, spanLen) {
      if (selectionInsideIclawPlaceholder(text, start, end)) return;
      if (spanLen > bestLen) {
        best = { start, end };
        bestLen = spanLen;
      }
    }

    for (const re of blockPatterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        consider(m.index, m.index + m[0].length, m[0].length);
      }
    }

    function scanWithPatterns(source, mapRange) {
      for (const re of patterns) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(source)) !== null) {
          const s = m.index;
          const e = s + m[0].length;
          const range = mapRange ? mapRange(s, e) : { start: s, end: e };
          if (!range) continue;
          consider(range.start, range.end, range.end - range.start);
        }
      }
    }

    scanWithPatterns(text, null);

    const { compact, indices } = compactSecretSearchText(text);
    if (compact.length > 0) {
      scanWithPatterns(compact, (cs, ce) => rangeFromCompact(indices, cs, ce));
    }

    return best;
  }

  async function commitDraftFromCard(card) {
    if (!card || draftProjectLocked || draftChatCreating) return;
    const rawId = card.getAttribute('data-project-id');
    draftChosenProjectId =
      rawId == null || String(rawId).trim() === '' ? null : Number(rawId);
    if (draftChosenProjectId != null && !Number.isFinite(draftChosenProjectId)) {
      draftChosenProjectId = null;
    }
    draftChatCreating = true;
    try {
      await ensureDraftChatRow();
    } catch (err) {
      alert(err && err.message ? err.message : 'Could not start chat');
      return;
    } finally {
      draftChatCreating = false;
    }
    draftProjectLocked = true;
    if (projectPickEl) projectPickEl.hidden = true;
    if (draftPickStage) draftPickStage.hidden = true;
    draftBody?.classList.remove('is-picking');
    if (draftEmptyHint) draftEmptyHint.hidden = false;
    if (composerWrap) composerWrap.hidden = false;
    input?.focus();
    syncComposerSecretUi();
  }

  function initDraftProjectPick() {
    if (!startedOnDraft || !projectPickEl || !composerWrap || !draftBody) return;

    projectPickEl.addEventListener('click', (e) => {
      const card = e.target.closest('.project-pick-card');
      if (!card || draftProjectLocked) return;
      void commitDraftFromCard(card);
    });

    // Space = "No project" — a quick skip past project selection. Guarded to the
    // active picking stage so it never fires afterwards, and ignored while a text
    // field is focused. commitDraftFromCard's re-entry guard makes this safe even
    // if a card button also has focus.
    document.addEventListener('keydown', (e) => {
      if (e.key !== ' ' && e.code !== 'Space') return;
      if (draftProjectLocked || !draftBody.classList.contains('is-picking')) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const none = projectPickEl.querySelector('.project-pick-card--none');
      if (!none) return;
      e.preventDefault();
      void commitDraftFromCard(none);
    });

    // Hint "No project" pill → playful "pick a project" mode: the pill empties
    // with a light sheen and the project tiles jiggle iOS-home-screen style to
    // invite the user to choose which project to open. Toggles off on re-click.
    const hintNone = projectPickEl.querySelector('#project-pick-hint-none');
    const pickGrid = projectPickEl.querySelector('.project-pick-grid');
    if (hintNone && pickGrid) {
      hintNone.addEventListener('click', () => {
        const choosing = pickGrid.classList.toggle('is-choosing');
        hintNone.classList.toggle('is-emptied', choosing);
        hintNone.setAttribute('aria-pressed', choosing ? 'true' : 'false');
      });
    }

    const initSel = (projectPickEl.dataset.initialProjectId || '').trim();
    if (initSel !== '') {
      const esc =
        typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
          ? CSS.escape(initSel)
          : initSel.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const card = projectPickEl.querySelector('.project-pick-card[data-project-id="' + esc + '"]');
      if (card) queueMicrotask(() => void commitDraftFromCard(card));
    } else if (draftBody?.dataset.autoNone === '1') {
      // First-ever chat: skip the "Choose a project" step so a new user lands
      // straight on the welcome greeting + composer (No project).
      const card = projectPickEl.querySelector('.project-pick-card--none');
      if (card) queueMicrotask(() => void commitDraftFromCard(card));
    }
  }

  // Welcome-card suggestion chips: drop the text into the composer and send it,
  // so a non-technical user gets going with one click.
  function initWelcomeChips() {
    const card = document.getElementById('welcome-card');
    if (!card) return;
    card.addEventListener('click', (e) => {
      const chip = e.target.closest('.welcome-chip');
      if (!chip) return;
      const prompt = chip.getAttribute('data-prompt') || chip.textContent || '';
      const ta = document.getElementById('composer-input');
      const form = document.getElementById('send-form');
      if (!ta || !form) return;
      ta.value = prompt;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    });
  }

  initWelcomeChips();

  initDraftProjectPick();
  // serializes turns per chat too, so this is just for the visible label
  const waitingItems = [];
  /** Local-only ids for draft chats (no chatId yet). */
  let nextLocalQueueItemId = 1;
  /** Queue row ids created in this tab via POST — ignore matching `queue-added` echoes. */
  const ownQueueIds = new Set();

  function dedupeWaitingItems() {
    const seen = new Set();
    for (let i = waitingItems.length - 1; i >= 0; i--) {
      const it = waitingItems[i];
      const key = it.serverId != null ? 's:' + it.serverId : 'l:' + it.id;
      if (seen.has(key)) waitingItems.splice(i, 1);
      else seen.add(key);
    }
  }

  /** Insert a queue row once (guards WS echo arriving before POST `await` finishes). */
  function addWaitingItem(item, opts) {
    const atFront = opts && opts.at === 'front';
    if (item.serverId != null) {
      if (waitingItems.some((it) => it.serverId === item.serverId)) return false;
      ownQueueIds.add(item.serverId);
    } else if (waitingItems.some((it) => it.id === item.id)) {
      return false;
    }
    if (atFront) waitingItems.unshift(item);
    else waitingItems.push(item);
    return true;
  }
  const REPLY_QUOTE_MAX = 240;
  /** @type {{ messageId: number; quote: string; role: string } | null} */
  let pendingComposerReply = null;
  const composerReplyBar = document.getElementById('composer-reply-bar');
  const composerReplyText = document.getElementById('composer-reply-text');
  const composerReplyMeta = document.getElementById('composer-reply-meta');
  const composerReplyClearBtn = document.getElementById('composer-reply-clear');
  let inFlight = false;
  /** the assistant DOM node we're streaming into right now */
  let currentStreamEl = null;
  let currentStreamFullText = '';
  /** Pending requestAnimationFrame id for the streaming typewriter (0 = none). */
  let streamRenderRaf = 0;
  /** How many chars of currentStreamFullText the typewriter has revealed. */
  let streamShownLen = 0;
  /** Debounce hljs while `turn-delta` re-renders markdown (innerHTML each chunk). */
  let streamSyntaxHlTimer = null;

  /** Single-character ellipsis used in tool / lifecycle labels (`Running command…`). */
  const STATUS_UNICODE_ELLIPSIS = '\u2026';
  const streamStatusDotTimers = new WeakMap();

  function stopStreamStatusDotAnim(statusEl) {
    if (!statusEl) return;
    const id = streamStatusDotTimers.get(statusEl);
    if (id != null) {
      clearInterval(id);
      streamStatusDotTimers.delete(statusEl);
    }
  }

  /** If `text` ends with `…` or `...`, cycle 0–3 ASCII dots after the base. */
  function setStreamStatusLabel(statusEl, text) {
    if (!statusEl) return;
    const raw = String(text ?? '');
    stopStreamStatusDotAnim(statusEl);
    let base = raw;
    let animate = false;
    if (raw.endsWith(STATUS_UNICODE_ELLIPSIS)) {
      base = raw.slice(0, -1);
      animate = true;
    } else if (raw.endsWith('...')) {
      base = raw.slice(0, -3);
      animate = true;
    }
    if (!animate) {
      statusEl.textContent = raw;
      return;
    }
    let step = 0;
    function tick() {
      const n = step % 4;
      statusEl.textContent = base + '.'.repeat(n);
      step += 1;
    }
    tick();
    streamStatusDotTimers.set(statusEl, setInterval(tick, 450));
  }

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

  const MSG_SECRET_PH_RE = /\[\[iclaw:secret:(\d+)\|([^|\]]+)(?:\|(\d+))?\]\]/g;

  function decodePlaceholderLabel(enc) {
    try {
      return decodeURIComponent(String(enc ?? '').replace(/\+/g, ' '));
    } catch {
      return String(enc ?? '');
    }
  }

  /** Markdown + inline secret chips (values loaded on reveal). */
  function renderMessageHtml(text) {
    const html = renderMarkdown(text);
    if (!html) return html;
    return html.replace(MSG_SECRET_PH_RE, (_, id, encLabel, lenStr) => {
      const label = decodePlaceholderLabel(encLabel);
      const safeL = escapeHtml(label);
      const safeAttr = String(label)
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '&lt;');
      const len = lenStr != null && lenStr !== '' ? Number(lenStr) : NaN;
      const tokenLen =
        Number.isFinite(len) && len > 0 ? Math.min(Math.floor(len), 512) : 0;
      const labelLen = Math.min(Math.max(label.length, 1), 512);
      const bodySizing =
        ' data-secret-len="' +
        tokenLen +
        '" data-secret-label-ch="' +
        labelLen +
        '" style="--secret-len-ch:' +
        tokenLen +
        ';--secret-label-ch:' +
        labelLen +
        '"';
      return (
        '<span class="iclaw-secret-chip" data-secret-id="' +
        escapeHtml(String(id)) +
        '" data-secret-label="' +
        safeAttr +
        '">' +
        '<button type="button" class="iclaw-secret-reveal" aria-expanded="false" aria-label="Secret: ' +
        safeAttr +
        '">' +
        '<span class="iclaw-secret-spoiler-body"' +
        bodySizing +
        '>' +
        '<span class="iclaw-secret-spoiler-grain" aria-hidden="true"></span>' +
        '<span class="iclaw-secret-caption">' +
        safeL +
        '</span></span>' +
        '</button>' +
        '<span class="iclaw-secret-value" hidden><span class="iclaw-secret-code"></span></span>' +
        '</span>'
      );
    });
  }
  function escapeHtml(s) {
    return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  }
  function clampLogoEmojiJs(n) {
    const em = window.__ICLAW_PROJECT_LOGO_EMOJIS__;
    const max = Array.isArray(em) ? em.length - 1 : 9;
    let v = Number(n);
    if (!Number.isFinite(v) || v < 0) return 0;
    if (v > max) return max;
    return Math.floor(v);
  }
  function clampLogoColorJs(n) {
    let v = Number(n);
    if (!Number.isFinite(v) || v < 0) return 0;
    if (v > 11) return 11;
    return Math.floor(v);
  }
  function buildProjectLogoHtml(emojiIdx, colorIdx) {
    const em = window.__ICLAW_PROJECT_LOGO_EMOJIS__;
    if (!Array.isArray(em) || em.length === 0) return '';
    const ei = clampLogoEmojiJs(emojiIdx);
    const ci = clampLogoColorJs(colorIdx);
    const glyph = em[ei] != null ? String(em[ei]) : '📁';
    return (
      '<span class="project-logo" data-logo-color="' +
      String(ci) +
      '" aria-hidden="true">' +
      escapeHtml(glyph) +
      '</span>'
    );
  }
  function applyProjectLogoToEl(el, emojiIdx, colorIdx) {
    const em = window.__ICLAW_PROJECT_LOGO_EMOJIS__;
    if (!el || !Array.isArray(em) || em.length === 0) return;
    const ei = clampLogoEmojiJs(emojiIdx);
    const ci = clampLogoColorJs(colorIdx);
    const glyph = em[ei] != null ? String(em[ei]) : '📁';
    el.className = 'project-logo';
    el.dataset.logoColor = String(ci);
    el.textContent = glyph;
  }
  function readLogoFromEl(el) {
    if (!el) return { ei: 0, ci: 0 };
    const ci = clampLogoColorJs(Number(el.dataset.logoColor));
    const em = window.__ICLAW_PROJECT_LOGO_EMOJIS__;
    let ei = 0;
    if (Array.isArray(em)) {
      const t = el.textContent || '';
      const idx = em.indexOf(t);
      ei = idx >= 0 ? idx : 0;
    }
    return { ei, ci };
  }
  function syncProjectLogoPopoverSelection(emojiIdx, colorIdx) {
    const pop = document.getElementById('project-logo-popover');
    if (!pop) return;
    const ei = clampLogoEmojiJs(emojiIdx);
    const ci = clampLogoColorJs(colorIdx);
    pop.querySelectorAll('.project-logo-swatch--emoji').forEach((btn, i) => {
      const sel = i === ei;
      btn.classList.toggle('is-selected', sel);
      btn.setAttribute('aria-pressed', sel ? 'true' : 'false');
    });
    pop.querySelectorAll('.project-logo-swatch--color').forEach((btn) => {
      const id = Number(btn.dataset.logoColor);
      const sel = id === ci;
      btn.classList.toggle('is-selected', sel);
      btn.setAttribute('aria-pressed', sel ? 'true' : 'false');
    });
  }
  function syncProjectPageHeaderLogo(emojiIdx, colorIdx) {
    const inner = document.querySelector('.project-logo-trigger .project-logo');
    if (inner) applyProjectLogoToEl(inner, emojiIdx, colorIdx);
    syncProjectLogoPopoverSelection(emojiIdx, colorIdx);
  }
  function currentProjectPageId() {
    const m = document.querySelector('main.project-page[data-project-id]');
    if (!m || !m.dataset.projectId) return null;
    const n = Number(m.dataset.projectId);
    return Number.isFinite(n) ? n : null;
  }

  function refreshProjectTabLabels(activeTabName) {
    const root = document.querySelector('main.project-page[data-project-id]');
    if (!root) return;
    root.querySelectorAll('[data-project-tab]').forEach((btn) => {
      const name = btn.getAttribute('data-project-tab');
      const base = btn.getAttribute('data-tab-base') || '';
      const n = btn.getAttribute('data-tab-count');
      const active = name === activeTabName;
      const hasCount = n != null && String(n).trim() !== '';
      btn.textContent = active && hasCount ? base + ' (' + n + ')' : base;
    });
  }

  function syncProjectMemoryTabCountFromDom() {
    const root = document.querySelector('main.project-page[data-project-id]');
    const btn = root?.querySelector('[data-project-tab="memory"]');
    const ul = document.getElementById('facts-list');
    if (!btn || !ul) return;
    btn.setAttribute('data-tab-count', String(ul.querySelectorAll('li.fact').length));
    const active = root.querySelector('.project-tab.is-active')?.getAttribute('data-project-tab');
    refreshProjectTabLabels(active || 'chats');
  }

  function syncProjectSecretsTabCountFromDom() {
    const root = document.querySelector('main.project-page[data-project-id]');
    const btn = root?.querySelector('[data-project-tab="secrets"]');
    const ul = document.getElementById('secrets-list');
    if (!btn || !ul) return;
    btn.setAttribute('data-tab-count', String(ul.querySelectorAll('li.project-secret-row').length));
    const active = root.querySelector('.project-tab.is-active')?.getAttribute('data-project-tab');
    refreshProjectTabLabels(active || 'chats');
  }

  function syncProjectSkillsTabCountFromDom() {
    const root = document.querySelector('main.project-page[data-project-id]');
    const btn = root?.querySelector('[data-project-tab="skills"]');
    const ul = document.getElementById('skills-list');
    if (!btn || !ul) return;
    btn.setAttribute('data-tab-count', String(ul.querySelectorAll('li.skill').length));
    const active = root.querySelector('.project-tab.is-active')?.getAttribute('data-project-tab');
    refreshProjectTabLabels(active || 'chats');
  }

  /** Build a skill row matching `views/project.ejs` (WS-driven updates on project page). */
  function buildSkillLi(s) {
    const li = document.createElement('li');
    li.className = 'skill';
    li.dataset.skillId = String(s.id);
    li.dataset.skillVersion = String(s.version != null ? s.version : 1);
    const isGlobal = s.project_id == null;
    const titleRaw =
      s.source_chat_title != null && String(s.source_chat_title).trim() !== ''
        ? String(s.source_chat_title).trim()
        : 'Chat';
    const head =
      '<div class="project-row-head muted">' +
      (isGlobal
        ? '<span class="skill-scope-badge" title="Available to every project">Global</span>'
        : '') +
      (s.source_chat_id != null
        ? '<a href="/chats/' +
          s.source_chat_id +
          '" class="project-chat-source">' +
          escapeHtml(titleRaw) +
          '</a>'
        : '<span>—</span>') +
      '</div>';
    li.innerHTML =
      head +
      '<input class="skill-name" aria-label="Skill name" spellcheck="false" value="' +
      escapeHtml(s.name || '') +
      '" />' +
      '<textarea class="skill-description" aria-label="Skill summary" rows="2">' +
      escapeHtml(s.description || '') +
      '</textarea>' +
      '<details class="skill-body-details"><summary>View / edit procedure</summary>' +
      '<textarea class="skill-body" aria-label="Skill procedure (SKILL.md)" rows="10">' +
      escapeHtml(s.body || '') +
      '</textarea></details>' +
      '<div class="fact-meta">' +
      '<button type="button" class="fact-delete skill-delete" aria-label="Remove skill">Remove</button></div>';
    const nameEl = li.querySelector('.skill-name');
    if (nameEl) nameEl.dataset.saved = String(s.name || '').trim();
    const descEl = li.querySelector('.skill-description');
    if (descEl) descEl.dataset.saved = String(s.description || '').trim();
    const bodyEl = li.querySelector('.skill-body');
    if (bodyEl) bodyEl.dataset.saved = String(s.body || '').trim();
    return li;
  }

  /** Build a secrets row matching `views/project.ejs` (WS-driven updates on project page). */
  function buildProjectSecretRowLi(secret) {
    const label = String(secret?.label ?? '');
    const tokenLen = Math.min(
      Math.max(Number(secret?.value_length) || label.length || 1, 1),
      512,
    );
    const lenCh = String(tokenLen);
    const li = document.createElement('li');
    li.className = 'project-secret-row';
    li.dataset.secretId = String(secret.id);
    li.innerHTML =
      '<div class="project-chat-link project-chat-link--stacked project-secret-card">' +
      '<span class="project-chat-title project-secret-title">' +
      escapeHtml(label) +
      '</span>' +
      '<button type="button" class="project-secret-reveal iclaw-secret-spoiler-body project-secret-spoiler-preview" data-secret-len="' +
      lenCh +
      '" style="--secret-len-ch:' +
      lenCh +
      '" aria-label="Show secret value">' +
      '<span class="iclaw-secret-spoiler-grain" aria-hidden="true"></span></button>' +
      '</div>';
    return li;
  }

  /** Build a fact row matching `views/project.ejs` (WS-driven updates on project page). */
  function buildFactLi(f) {
    const li = document.createElement('li');
    li.className = 'fact';
    li.dataset.factId = String(f.id);
    const titleRaw =
      f.source_chat_title != null && String(f.source_chat_title).trim() !== ''
        ? String(f.source_chat_title).trim()
        : 'Chat';
    const head =
      f.source_chat_id != null
        ? '<div class="project-row-head muted"><a href="/chats/' +
          f.source_chat_id +
          '" class="project-chat-source">' +
          escapeHtml(titleRaw) +
          '</a></div>'
        : '<div class="project-row-head muted"><span>—</span></div>';
    li.innerHTML =
      head +
      '<textarea class="fact-content" aria-label="Fact text" rows="2">' +
      escapeHtml(f.content || '') +
      '</textarea>' +
      '<div class="fact-meta">' +
      '<button type="button" class="fact-delete" aria-label="Remove fact">Remove</button></div>';
    const ta = li.querySelector('.fact-content');
    if (ta) ta.dataset.saved = String(f.content || '').trim();
    return li;
  }
  /** Clipboard + check — inline SVG, `currentColor` from `.code-copy-btn`. */
  const CODE_COPY_ICON_SVG =
    '<svg class="code-copy-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path fill="currentColor" d="M16 1H4a2 2 0 0 0-2 2v12h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>';
  const CODE_COPIED_ICON_SVG =
    '<svg class="code-copy-icon code-copy-icon--ok" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19L21 7l-1.41-1.41L9 16.17z"/></svg>';

  /** Strip protocol/`www.`/trailing slash; middle-truncate pathological URLs. */
  function prettifyUrlText(href) {
    let s = String(href || '')
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/\/+$/, '');
    if (s.length > 60) s = s.slice(0, 42) + '…' + s.slice(-15);
    return s;
  }
  function decorateLinks(root) {
    root.querySelectorAll('a[href]').forEach((a) => {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      // Inside tables, collapse long bare-URL link text to a compact, readable
      // form (full URL stays on the href + title). Leaves `[label](url)` links
      // and prose URLs untouched. Idempotent: after rewrite text !== href.
      if (a.closest('td, th')) {
        const href = a.getAttribute('href') || '';
        const txt = (a.textContent || '').trim();
        if (txt && txt === href && /^https?:\/\//i.test(href)) {
          if (!a.title) a.title = href;
          a.textContent = prettifyUrlText(href);
        }
      }
    });
  }

  /** Wrap fenced ``` blocks for a floating copy control (after markdown → DOM). */
  function enhanceCodeBlocks(root) {
    if (!root || root.nodeType !== 1) return;
    const pres = root.querySelectorAll(
      '.msg-body pre, .stream-body pre, .task-log-entry-body pre',
    );
    pres.forEach((pre) => {
      if (pre.parentElement?.classList.contains('code-block-wrap')) return;
      const wrap = document.createElement('div');
      wrap.className = 'code-block-wrap';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'code-copy-btn';
      btn.innerHTML = CODE_COPY_ICON_SVG;
      btn.setAttribute('aria-label', 'Copy code');
      btn.title = 'Copy';
      const parent = pre.parentElement;
      if (!parent) return;
      parent.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      wrap.appendChild(btn);
    });
  }

  /** Wrap GFM tables in a horizontal-scroll frame (after markdown → DOM). */
  function enhanceTables(root) {
    if (!root || root.nodeType !== 1) return;
    const tables = root.querySelectorAll(
      '.msg-body table, .stream-body table, .task-log-entry-body table',
    );
    tables.forEach((table) => {
      if (table.parentElement?.classList.contains('md-table-wrap')) return;
      const parent = table.parentElement;
      if (!parent) return;
      const wrap = document.createElement('div');
      wrap.className = 'md-table-wrap';
      parent.insertBefore(wrap, table);
      wrap.appendChild(table);
    });
  }

  function clearStreamSyntaxHighlightSchedule() {
    if (streamSyntaxHlTimer != null) {
      clearTimeout(streamSyntaxHlTimer);
      streamSyntaxHlTimer = null;
    }
  }

  function scheduleStreamSyntaxHighlight(root) {
    clearStreamSyntaxHighlightSchedule();
    streamSyntaxHlTimer = setTimeout(() => {
      streamSyntaxHlTimer = null;
      if (root && document.contains(root)) highlightCodeBlocks(root);
    }, 280);
  }

  /** Apply highlight.js to fenced blocks (after marked + copy-wrap). Safe no-op if hljs not loaded. */
  function highlightCodeBlocks(root) {
    const hl = window.hljs;
    if (!root || root.nodeType !== 1 || !hl || typeof hl.highlightElement !== 'function') return;
    root.querySelectorAll(
      '.msg-body pre code, .stream-body pre code, .task-log-entry-body pre code',
    ).forEach((code) => {
      const pre = code.parentElement;
      if (!pre || pre.tagName !== 'PRE') return;
      if (pre.closest('.exec-approval-card')) return;
      if (code.classList.contains('hljs')) return;
      // Only highlight when the fence declares a language hljs actually knows.
      // On a bare/unknown fence, highlightElement() falls back to auto-detection,
      // which mis-guesses prose as Ruby/Perl (an apostrophe opens a "string" and
      // the github-dark theme dims whole paragraphs). Leave those as plain text.
      const langClass = [...code.classList].find((c) => c.startsWith('language-'));
      const lang = langClass && langClass.slice(9);
      const known =
        lang &&
        lang !== 'text' &&
        lang !== 'plaintext' &&
        typeof hl.getLanguage === 'function' &&
        hl.getLanguage(lang);
      if (known) {
        try {
          hl.highlightElement(code);
        } catch (_) {
          code.classList.add('hljs'); /* keep block styling even if hljs throws */
        }
      } else {
        code.classList.add('hljs'); /* plaintext — styled, no auto-detect */
      }
    });
  }

  /**
   * @param {Element} root
   * @param {{ deferSyntaxHighlight?: boolean }} [opts] — set during streaming deltas to avoid hljs on every token.
   */
  function decorateMessageBody(root, opts) {
    decorateLinks(root);
    enhanceCodeBlocks(root);
    enhanceTables(root);
    if (opts && opts.deferSyntaxHighlight) {
      scheduleStreamSyntaxHighlight(root);
      return;
    }
    clearStreamSyntaxHighlightSchedule();
    highlightCodeBlocks(root);
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
  function replyStubRoleLabel(role) {
    if (role === 'user') return 'You';
    if (role === 'assistant') return 'Assistant';
    return 'Chat';
  }

  function msgReplyStubHtml(replyToId, quote, replyToRole) {
    const rid = String(replyToId);
    const q = escapeHtml(quote);
    const who = escapeHtml(replyStubRoleLabel(replyToRole || ''));
    return (
      '<button type="button" class="msg-reply-stub" data-jump-to-msg="' +
      rid +
      '" data-reply-quote="' +
      encodeURIComponent(quote) +
      '" aria-label="Jump to quoted message">' +
      '<span class="msg-reply-stub-track">' +
      '<span class="msg-reply-stub-bar" aria-hidden="true"></span>' +
      '<span class="msg-reply-stub-body">' +
      '<span class="msg-reply-stub-label">' +
      who +
      '</span>' +
      '<span class="msg-reply-stub-quote">' +
      q +
      '</span></span></button>'
    );
  }

  function syncPendingUserReplyPreview(pendingEl, serverMsg) {
    if (!pendingEl || !serverMsg) return;
    if (pendingEl.querySelector('.msg-reply-stub')) return;
    const rId = Number(serverMsg.reply_to_message_id);
    const rQu = serverMsg.reply_quote != null ? String(serverMsg.reply_quote) : '';
    if (!Number.isFinite(rId) || !rQu) return;
    const rRole = serverMsg.reply_to_role != null ? String(serverMsg.reply_to_role) : '';
    const roleEl = pendingEl.querySelector('.role');
    if (roleEl) roleEl.insertAdjacentHTML('afterend', msgReplyStubHtml(rId, rQu, rRole));
  }

  function readReplyStubQuote(stub) {
    const enc = stub.getAttribute('data-reply-quote');
    if (enc == null || enc === '') return '';
    try {
      return decodeURIComponent(enc);
    } catch {
      return '';
    }
  }

  /** Text nodes to search for reply target (skip code — ranges must not split code). */
  function replyQuoteSearchTextNodes(root) {
    const out = /** @type {Text[]} */ ([]);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const el = n.parentElement;
      if (!el) continue;
      if (el.closest('pre, code, script, style')) continue;
      out.push(/** @type {Text} */ (n));
    }
    return out;
  }

  function clearReplyJumpHighlights(root) {
    if (!root) return;
    root.querySelectorAll('.msg-reply-quote-highlight').forEach((mark) => {
      const p = mark.parentNode;
      if (!p) return;
      while (mark.firstChild) p.insertBefore(mark.firstChild, mark);
      p.removeChild(mark);
      p.normalize();
    });
  }

  function scheduleClearReplyJumpHighlight(root) {
    cancelReplyJumpHighlightTimers();
    const holdMs = 800;
    const fadeMs = 200;
    replyJumpHighlightTimer = setTimeout(() => {
      replyJumpHighlightTimer = null;
      const marks = root.querySelectorAll('.msg-reply-quote-highlight');
      if (!marks.length) return;
      marks.forEach((m) => m.classList.add('msg-reply-quote-highlight--out'));
      replyJumpHighlightFadeTimer = setTimeout(() => {
        replyJumpHighlightFadeTimer = null;
        clearReplyJumpHighlights(root);
      }, fadeMs + 40);
    }, holdMs);
  }

  /**
   * If the stored quote appears verbatim in the parent body, wrap it in a
   * temporary highlight (not text selection).
   * @returns {boolean}
   */
  function highlightReplyTargetQuote(targetMsg, quoteRaw) {
    const body = targetMsg.querySelector('.msg-body');
    if (!body) return false;
    const q = String(quoteRaw ?? '').trim();
    if (!q) return false;
    const nodes = replyQuoteSearchTextNodes(body);
    if (!nodes.length) return false;
    const big = nodes.map((t) => t.nodeValue || '').join('');
    const idx = big.indexOf(q);
    if (idx === -1) return false;
    const end = idx + q.length;
    let acc = 0;
    /** @type {{ tn: Text; off: number } | null} */
    let startRef = null;
    /** @type {{ tn: Text; off: number } | null} */
    let endRef = null;
    for (const tn of nodes) {
      const len = (tn.nodeValue || '').length;
      const segEnd = acc + len;
      if (startRef === null && idx < segEnd) startRef = { tn, off: idx - acc };
      if (end <= segEnd) {
        endRef = { tn, off: end - acc };
        break;
      }
      acc = segEnd;
    }
    if (!startRef || !endRef) return false;
    try {
      const range = document.createRange();
      range.setStart(startRef.tn, startRef.off);
      range.setEnd(endRef.tn, endRef.off);
      const mark = document.createElement('mark');
      mark.className = 'msg-reply-quote-highlight';
      try {
        range.surroundContents(mark);
      } catch {
        const frag = range.extractContents();
        mark.appendChild(frag);
        range.insertNode(mark);
      }
      mark.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      return true;
    } catch {
      return false;
    }
  }

  function scrollToBottom() {
    if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  /** True when the messages list is at/near the bottom (within `threshold` px). */
  function isNearBottom(threshold = 120) {
    if (!messagesEl) return true;
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= threshold;
  }

  /**
   * Smooth "typewriter" streaming. Backend deltas arrive in bursts and can stall
   * for ~a second; we decouple what's shown from what's arrived. `currentStream
   * FullText` is the target (grows as deltas arrive); `streamShownLen` is how much
   * we've revealed. Each animation frame we reveal a few more characters, so the
   * user sees a steady flow no matter how lumpy the source is.
   *
   * The reveal is adaptive — a larger backlog drains faster (so we never fall
   * seconds behind on a big burst) while a small backlog types out gently. Re-
   * rendering happens at most once per frame (re-parsing the whole markdown +
   * replacing innerHTML per token would be O(n²) and thrash layout). Auto-scroll
   * fires only when the user is already at the bottom, so scrolling up mid-stream
   * no longer yanks them back down.
   */
  function renderStreamFrame() {
    streamRenderRaf = 0;
    const el = currentStreamEl;
    if (!el || !messagesEl?.contains(el)) return;
    const body = el.querySelector('.stream-body, .msg-body');
    if (!body) return;

    const target = currentStreamFullText;
    if (streamShownLen < target.length) {
      const remaining = target.length - streamShownLen;
      // ~120 chars/s floor (2 per frame), faster as the backlog grows.
      const step = Math.max(2, Math.ceil(remaining / 8));
      streamShownLen = Math.min(target.length, streamShownLen + step);
      const stick = isNearBottom();
      body.innerHTML = renderMarkdown(target.slice(0, streamShownLen));
      decorateMessageBody(body, { deferSyntaxHighlight: true });
      if (stick) scrollToBottom();
    }

    // Keep going while there's still backlog; otherwise idle until the next
    // delta re-arms the loop via ensureTyping().
    if (streamShownLen < currentStreamFullText.length) {
      streamRenderRaf = requestAnimationFrame(renderStreamFrame);
    }
  }

  /** Start the typewriter loop if it isn't already running. */
  function ensureTyping() {
    if (!streamRenderRaf) streamRenderRaf = requestAnimationFrame(renderStreamFrame);
  }

  /** Stop the typewriter and reset the revealed position (call when finalizing). */
  function cancelStreamRender() {
    if (streamRenderRaf) { cancelAnimationFrame(streamRenderRaf); streamRenderRaf = 0; }
    streamShownLen = 0;
  }
  /** Build the HTML block for persisted attachments (image inline / file as link). */
  function attachmentsHtml(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return '';
    const items = attachments
      .map((a) => {
        const url = String(a.url || '');
        const mime = String(a.mimeType || '');
        const name = String(a.fileName || 'file');
        const sz = humanSize(Number(a.sizeBytes) || 0);
        if (mime.startsWith('image/')) {
          return (
            '<a class="msg-attachment" href="' +
            escapeHtml(url) +
            '" target="_blank" rel="noopener noreferrer">' +
            '<img class="msg-attachment-image" src="' +
            escapeHtml(url) +
            '" alt="' +
            escapeHtml(name) +
            '" loading="lazy" />' +
            '</a>'
          );
        }
        return (
          '<a class="msg-attachment-file" href="' +
          escapeHtml(url) +
          '" target="_blank" rel="noopener noreferrer" title="' +
          escapeHtml(name) +
          '">' +
          '<span class="msg-attachment-file-name">' +
          escapeHtml(name) +
          '</span>' +
          (sz ? '<span class="msg-attachment-file-size">' + escapeHtml(sz) + '</span>' : '') +
          '</a>'
        );
      })
      .join('');
    return '<div class="msg-attachments">' + items + '</div>';
  }

  /** Dev mode: add a live message's tokens to the chat-wide running total. */
  function bumpChatTokenTotal(tokens) {
    if (!window.__ICLAW_DEV__ || !tokens) return;
    const el = document.getElementById('chat-token-total');
    if (!el) return;
    const cur = (Number(el.dataset.total) || 0) + Number(tokens);
    el.dataset.total = String(cur);
    el.textContent = cur.toLocaleString() + ' tok total';
    el.hidden = false;
  }

  /** Dev mode: show token usage (+cache hits) on a message bubble + chat total. */
  function applyTokenBadge(el, tokens, cached) {
    if (!window.__ICLAW_DEV__ || !tokens || !el) return;
    if (el.querySelector(':scope > .msg-tokens')) return;
    const c = Number(cached) || 0;
    const span = document.createElement('span');
    span.className = 'msg-tokens';
    span.title = 'Tokens spent on this reply' + (c ? ' (' + c.toLocaleString() + ' served from cache)' : '');
    span.textContent = Number(tokens).toLocaleString() + ' tok' + (c ? ' · ' + c.toLocaleString() + ' cached' : '');
    el.appendChild(span);
    bumpChatTokenTotal(tokens);
  }

  /**
   * Collapsible verified-tool-outcomes block for an assistant message (runtime
   * modes). Mirrors the server-side render in chat.ejs — the trace is the
   * runtime's record of what actually ran, so claims in the prose above it can
   * be checked at a glance.
   */
  function toolTraceHtml(trace) {
    // Dev-only UI (like the token badge); the trace is still persisted for all
    // installs — context compaction seeds from it regardless of display.
    if (!window.__ICLAW_DEV__) return '';
    if (!Array.isArray(trace) || trace.length === 0) return '';
    const failed = trace.filter(function (t) { return !t.ok; }).length;
    const items = trace
      .map(function (t) {
        // Row: tool name + request target; ✗ only on failures. Full args →
        // verdict in the hover tooltip. The `cd … && ` shell prefix is display
        // noise — the target is the command after it.
        const tip = [t.detail, t.outcome].filter(Boolean).join(' → ');
        const target = (t.detail || '').replace(/^(cd [^&|;]+ && )+/, '');
        return (
          '<li class="' + (t.ok ? 'tt-ok' : 'tt-err') + '"' +
          (tip ? ' title="' + escapeHtml(tip) + '"' : '') + '>' +
          (t.ok ? '' : '<span class="tt-mark">✗</span>') +
          '<span class="tt-name">' + escapeHtml(t.name || '') + '</span>' +
          (target ? '<span class="tt-detail">' + escapeHtml(target) + '</span>' : '') +
          '</li>'
        );
      })
      .join('');
    return (
      '<details class="msg-tool-trace"><summary>' +
      trace.length + ' tool call' + (trace.length === 1 ? '' : 's') +
      (failed > 0 ? ' · <span class="tt-failed">' + failed + ' failed</span>' : '') +
      '</summary><ul>' + items + '</ul></details>'
    );
  }

  function appendMessage(msg, opts) {
    if (!messagesEl) return null;
    clearEmptyState();
    // Stopped-by-user marker (system row with finish_reason='aborted')
    // arrives BEFORE turn-ended, so an empty streaming bubble would still
    // be on the page with "Finishing…". Yank it now so the system pill
    // doesn't appear stacked under a stale placeholder for the few ms
    // until turn-ended's own cleanup runs. The marker itself is then
    // rendered by the default .msg.system path below — same look as the
    // existing "Task done: …" notes.
    if (
      msg.role === 'system' &&
      msg.finish_reason === 'aborted' &&
      currentStreamEl &&
      currentStreamEl.classList.contains('streaming')
    ) {
      const body = currentStreamEl.querySelector('.stream-body, .msg-body');
      const hasContent = !!(body && body.textContent && body.textContent.trim());
      if (!hasContent) {
        currentStreamEl.remove();
        currentStreamEl = null;
      }
    }
    const div = document.createElement('div');
    div.className = 'msg ' + (msg.role || 'system');
    if (msg.id) div.dataset.msgId = String(msg.id);
    if (opts?.pendingId) div.classList.add('pending-id');
    const rId = msg.reply_to_message_id != null ? Number(msg.reply_to_message_id) : NaN;
    const rQuote = msg.reply_quote != null ? String(msg.reply_quote) : '';
    const rRole = msg.reply_to_role != null ? String(msg.reply_to_role) : '';
    const replyHtml = Number.isFinite(rId) && rQuote ? msgReplyStubHtml(rId, rQuote, rRole) : '';
    div.innerHTML =
      '<div class="role">' + escapeHtml(msg.role || 'system') + '</div>' +
      (replyHtml ? replyHtml : '') +
      '<div class="msg-body">' + renderMessageHtml(msg.content || '') + '</div>' +
      attachmentsHtml(msg.attachments) +
      (msg.role === 'assistant' ? toolTraceHtml(msg.tool_trace) : '');
    decorateMessageBody(div);
    applyTokenBadge(div, msg.tokens, msg.cached_tokens);
    messagesAppendRoot().appendChild(div);
    scrollToBottom();
    return div;
  }
  function appendStreamingAssistant() {
    if (!messagesEl) return null;
    clearEmptyState();
    // First turn of a chat can be a cold start (model/Docker warming up, 20–60s).
    // Say "Warming up…" instead of "Thinking…" so the wait reads as honest setup,
    // not a hang. Detected by the absence of any prior assistant message.
    const isFirstTurn = !messagesAppendRoot()?.querySelector('.msg.assistant');
    const div = document.createElement('div');
    div.className = 'msg assistant streaming stream-waiting';
    div.innerHTML =
      '<div class="role">assistant</div>' +
      '<div class="msg-body stream-body"></div>' +
      '<div class="stream-status"></div>';
    messagesAppendRoot().appendChild(div);
    const st = div.querySelector('.stream-status');
    if (st) setStreamStatusLabel(st, isFirstTurn ? 'Warming up…' : 'Thinking…');
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
      body.innerHTML = renderMessageHtml(raw);
      decorateMessageBody(body);
    });
  }

  /** Task detail: goal, agent ask, execution log (server-rendered + streaming). */
  function hydrateTaskMarkdownFields() {
    const root = document.querySelector('.task-page');
    if (!root) return;
    root.querySelectorAll('.task-md').forEach((el) => {
      const raw = (el.dataset.rawMd != null ? el.dataset.rawMd : el.textContent) ?? '';
      if (!String(raw).trim()) return;
      el.dataset.rawMd = raw;
      el.innerHTML = renderMessageHtml(raw);
      decorateMessageBody(el);
    });
  }

  function appendTaskLogMarkdown(body, chunk) {
    if (!body) return;
    const next = String(body.dataset.rawMd ?? body.textContent ?? '') + String(chunk ?? '');
    body.dataset.rawMd = next;
    body.innerHTML = renderMessageHtml(next);
    decorateMessageBody(body, { deferSyntaxHighlight: true });
  }

  function existingFactSuggestionIds() {
    const ids = new Set();
    if (!messagesEl) return ids;
    messagesEl.querySelectorAll('.fact-suggestion-row[data-suggestion-id]').forEach((el) => {
      const n = Number(el.dataset.suggestionId);
      if (Number.isFinite(n)) ids.add(n);
    });
    return ids;
  }

  function removeFactSuggestionRow(chatId, sid) {
    if (!messagesEl || chatId !== activeChatId) return;
    const row = messagesEl.querySelector('.fact-suggestion-row[data-suggestion-id="' + sid + '"]');
    if (!row) return;
    const card = row.closest('.fact-suggestions-card');
    cancelFactSuggestionRowExpiry(row);
    row.remove();
    if (card && !card.querySelector('.fact-suggestion-row')) card.remove();
  }

  const FACT_SUGGESTION_AUTO_REJECT_MS = 15_000;
  const FACT_REJECT_COUNTDOWN_RING_SVG =
    '<svg class="fact-reject-countdown-ring" aria-hidden="true" viewBox="0 0 36 36">' +
    '<circle cx="18" cy="18" r="14" fill="none" stroke-width="2" stroke-linecap="round" ' +
    'stroke-dasharray="87.965 87.965" stroke-dashoffset="0"/>' +
    '</svg>';

  /**
   * Countdown with setTimeout + optional CSS ring; pauses while hoverEl is hovered.
   * @returns {() => void} cancel
   */
  function attachPausableCountdown(opts) {
    const { hoverEl, durationMs, onExpire, onTickStart, onTickClear } = opts;
    let timeoutId = null;
    let remaining = durationMs;
    let deadline = 0;
    let paused = false;

    function detachHover() {
      if (!hoverEl) return;
      hoverEl.removeEventListener('mouseenter', onEnter);
      hoverEl.removeEventListener('mouseleave', onLeave);
    }

    function cancel() {
      if (timeoutId != null) clearTimeout(timeoutId);
      timeoutId = null;
      paused = false;
      deadline = 0;
      detachHover();
      if (onTickClear) onTickClear();
    }

    function armTimeout() {
      if (timeoutId != null) clearTimeout(timeoutId);
      deadline = Date.now() + remaining;
      timeoutId = setTimeout(() => {
        timeoutId = null;
        detachHover();
        if (onTickClear) onTickClear();
        onExpire();
      }, remaining);
    }

    function onEnter() {
      if (paused) return;
      paused = true;
      if (!deadline) return;
      remaining = Math.max(0, deadline - Date.now());
      if (timeoutId != null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    }

    function onLeave() {
      if (!paused) return;
      paused = false;
      if (remaining <= 0) {
        detachHover();
        if (onTickClear) onTickClear();
        onExpire();
        return;
      }
      armTimeout();
    }

    if (onTickStart) onTickStart();
    if (hoverEl) {
      hoverEl.addEventListener('mouseenter', onEnter);
      hoverEl.addEventListener('mouseleave', onLeave);
    }
    armTimeout();
    return cancel;
  }

  /** @type {HTMLElement[]} */
  const factSuggestionExpiryQueue = [];
  let processingFactSuggestionExpiry = false;

  function buildFactSuggestionRowHtml(s) {
    const id = Number(s.id);
    if (!Number.isFinite(id)) return '';
    return (
      '<li class="fact-suggestion-row" data-suggestion-id="' +
      id +
      '" role="listitem">' +
      '<p class="fact-suggestion-text">' +
      escapeHtml(s.content || '') +
      '</p>' +
      '<div class="fact-suggestion-actions">' +
      '<button type="button" class="fact-suggestion-btn fact-suggestion-reject" data-suggestion-id="' +
      id +
      '" aria-label="Skip">' +
      FACT_REJECT_COUNTDOWN_RING_SVG +
      '<span class="fact-suggestion-btn-glyph" aria-hidden="true">✕</span>' +
      '</button>' +
      '<button type="button" class="fact-suggestion-btn fact-suggestion-accept" data-suggestion-id="' +
      id +
      '" aria-label="Save to project">' +
      '<span class="fact-suggestion-btn-glyph" aria-hidden="true">✓</span>' +
      '</button>' +
      '</div></li>'
    );
  }

  function cancelFactSuggestionRowExpiry(row) {
    if (!row) return;
    if (typeof row._factExpiryClear === 'function') {
      row._factExpiryClear();
      return;
    }
    const i = factSuggestionExpiryQueue.indexOf(row);
    if (i >= 0) factSuggestionExpiryQueue.splice(i, 1);
  }

  function enqueueFactSuggestionExpiryRows(rows) {
    if (!rows || !rows.length) return;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      if (row && row.nodeType === 1) factSuggestionExpiryQueue.push(row);
    }
    void processFactSuggestionExpiryQueue();
  }

  function runSingleFactRejectExpiry(row, btn) {
    return new Promise((resolve) => {
      const sid = Number(btn.dataset.suggestionId);
      const cid = activeChatId;
      const hoverEl = row.closest('.fact-suggestions-card') || row;
      row._factExpiryClear = attachPausableCountdown({
        hoverEl,
        durationMs: FACT_SUGGESTION_AUTO_REJECT_MS,
        onTickStart: () => btn.classList.add('fact-suggestion-reject--expiring'),
        onTickClear: () => btn.classList.remove('fact-suggestion-reject--expiring'),
        onExpire: () => {
          delete row._factExpiryClear;
          btn.classList.remove('fact-suggestion-reject--expiring');
          if (document.contains(row) && Number.isFinite(sid) && cid != null) {
            fetch(
              '/chats/' +
                encodeURIComponent(cid) +
                '/fact-suggestions/' +
                encodeURIComponent(sid) +
                '/reject',
              { method: 'POST', headers: { Accept: 'application/json' } },
            ).then((res) => {
              if (res.ok) removeFactSuggestionRow(cid, sid);
            });
          }
          resolve();
        },
      });
    });
  }

  async function processFactSuggestionExpiryQueue() {
    if (processingFactSuggestionExpiry) return;
    processingFactSuggestionExpiry = true;
    try {
      while (factSuggestionExpiryQueue.length > 0) {
        const row = factSuggestionExpiryQueue[0];
        if (!row || !document.contains(row)) {
          factSuggestionExpiryQueue.shift();
          continue;
        }
        const btn = row.querySelector('.fact-suggestion-reject');
        if (!btn) {
          factSuggestionExpiryQueue.shift();
          continue;
        }
        await runSingleFactRejectExpiry(row, btn);
        factSuggestionExpiryQueue.shift();
      }
    } finally {
      processingFactSuggestionExpiry = false;
      if (factSuggestionExpiryQueue.length > 0) void processFactSuggestionExpiryQueue();
    }
  }

  function appendFactSuggestionsCard(opts) {
    if (!messagesEl) return;
    const { projectId, chatId, suggestions, projectName } = opts;
    if (!suggestions || suggestions.length === 0) return;
    clearEmptyState();
    const safeName = escapeHtml((projectName || '').trim() || 'project');
    const rowsHtml = suggestions.map(buildFactSuggestionRowHtml).filter(Boolean).join('');
    if (!rowsHtml) return;

    const pidEsc = String(projectId);
    const cidEsc = String(chatId);
    const existing = messagesEl.querySelector(
      '.fact-suggestions-card[data-project-id="' + pidEsc + '"][data-chat-id="' + cidEsc + '"]',
    );
    if (existing) {
      const ul = existing.querySelector('.fact-suggestions-list');
      if (!ul) return;
      const tpl = document.createElement('template');
      tpl.innerHTML = rowsHtml.trim();
      const added = [];
      tpl.content.childNodes.forEach((n) => {
        if (n.nodeType !== 1) return;
        const el = /** @type {HTMLElement} */ (n);
        const sid = el.dataset.suggestionId;
        if (!sid || ul.querySelector('.fact-suggestion-row[data-suggestion-id="' + sid + '"]')) return;
        ul.appendChild(el);
        added.push(el);
      });
      scrollToBottom();
      enqueueFactSuggestionExpiryRows(added);
      return;
    }

    const card = document.createElement('div');
    card.className = 'msg system fact-suggestions-card';
    card.dataset.projectId = pidEsc;
    card.dataset.chatId = cidEsc;
    card.innerHTML =
      '<div class="fact-suggestions-shell">' +
      '<p class="fact-suggestions-lead">Save to project memory «' +
      safeName +
      '»?</p>' +
      '<ul class="fact-suggestions-list" role="list">' +
      rowsHtml +
      '</ul>' +
      '</div>';
    messagesAppendRoot().appendChild(card);
    scrollToBottom();
    const addedRows = Array.from(card.querySelectorAll('.fact-suggestion-row'));
    enqueueFactSuggestionExpiryRows(addedRows);
  }

  async function loadPendingFactSuggestions() {
    if (activeChatId == null || !messagesEl) return;
    try {
      const res = await fetch('/chats/' + encodeURIComponent(activeChatId) + '/fact-suggestions', {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return;
      const data = await res.json();
      const list = Array.isArray(data.suggestions) ? data.suggestions : [];
      if (list.length === 0) return;
      const first = list[0];
      const pid = first ? Number(first.project_id) : NaN;
      if (!Number.isFinite(pid)) return;
      const have = existingFactSuggestionIds();
      const fresh = list
        .filter((s) => s && Number.isFinite(Number(s.id)) && !have.has(Number(s.id)))
        .map((s) => ({ id: Number(s.id), content: String(s.content ?? '') }));
      const pname =
        typeof data.projectName === 'string' && data.projectName.trim()
          ? data.projectName.trim()
          : null;
      const projectLabel = pname || 'project';
      appendFactSuggestionsCard({
        projectId: pid,
        chatId: activeChatId,
        projectName: projectLabel,
        suggestions: fresh,
      });
    } catch (_) {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // skill suggestions (inbox-gated procedural memory) — chat cards
  // Mirrors fact suggestions, but with no auto-reject: a skill is a standing
  // instruction, so acceptance is always a deliberate user action.
  // -------------------------------------------------------------------------

  function existingSkillSuggestionIds() {
    const ids = new Set();
    if (!messagesEl) return ids;
    messagesEl.querySelectorAll('.skill-suggestion-row[data-suggestion-id]').forEach((el) => {
      const n = Number(el.dataset.suggestionId);
      if (Number.isFinite(n)) ids.add(n);
    });
    return ids;
  }

  function removeSkillSuggestionRow(chatId, sid) {
    if (!messagesEl || chatId !== activeChatId) return;
    const row = messagesEl.querySelector(
      '.skill-suggestion-row[data-suggestion-id="' + sid + '"]',
    );
    if (!row) return;
    const card = row.closest('.skill-suggestions-card');
    row.remove();
    if (card && !card.querySelector('.skill-suggestion-row')) card.remove();
  }

  // "handle-sandbox-network" → "Handle sandbox network": a readable title from
  // the kebab slug, used until/unless the server sends a friendlier s.title.
  function humanizeSkillName(name) {
    const s = String(name || '').replace(/[-_]+/g, ' ').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  }

  // A non-technical person sees ONE plain sentence + two buttons. Everything
  // technical (kebab name, full procedure, "all projects", provenance) is folded
  // into a collapsed «Деталі» block — still in the DOM, so the accept handler
  // reads the same fields whether or not it's ever opened.
  function buildSkillSuggestionRowHtml(s) {
    const id = Number(s.id);
    if (!Number.isFinite(id)) return '';
    const kind = s.kind === 'patch' ? 'patch' : 'new';
    const humanTitle =
      (s.title && String(s.title).trim()) || humanizeSkillName(s.name) || 'це';
    const updatesLine =
      kind === 'patch'
        ? '<div class="skill-suggestion-updates">Доповнює те, що вже вмію</div>'
        : '';
    // Provenance kept — but as a quiet ⓘ, not a red "untrusted" badge.
    const infoIcon = s.untrusted
      ? '<span class="skill-suggestion-info" tabindex="0" role="img" aria-label="Підказано з матеріалу, що міг містити зовнішній вміст — перевір у «Деталях»" title="Підказано з матеріалу, що міг містити зовнішній (недовірений) вміст. Переглянь «Деталі», перш ніж зберігати.">&#9432;</span>'
      : '';
    return (
      '<li class="skill-suggestion-row" data-suggestion-id="' +
      id +
      '" data-kind="' +
      kind +
      '" role="listitem">' +
      '<div class="skill-suggestion-simple">' +
      '<div class="skill-suggestion-title">' +
      escapeHtml(humanTitle) +
      infoIcon +
      '</div>' +
      (s.description
        ? '<div class="skill-suggestion-summary">' + escapeHtml(s.description) + '</div>'
        : '') +
      updatesLine +
      '</div>' +
      '<details class="skill-suggestion-advanced"><summary>Деталі</summary>' +
      '<label class="skill-suggestion-field"><span class="skill-suggestion-field-label">Назва</span>' +
      '<input class="skill-suggestion-name" aria-label="Skill name" spellcheck="false" value="' +
      escapeHtml(s.name || '') +
      '" /></label>' +
      '<label class="skill-suggestion-field"><span class="skill-suggestion-field-label">Опис</span>' +
      '<textarea class="skill-suggestion-desc" aria-label="Skill summary" rows="2">' +
      escapeHtml(s.description || '') +
      '</textarea></label>' +
      '<label class="skill-suggestion-field"><span class="skill-suggestion-field-label">Що саме робити</span>' +
      '<textarea class="skill-suggestion-body" aria-label="Skill procedure (SKILL.md)" rows="10">' +
      escapeHtml(s.body || '') +
      '</textarea></label>' +
      '<label class="skill-suggestion-scope"><input type="checkbox" class="skill-suggestion-global" /> Використовувати в усіх проєктах</label>' +
      '</details>' +
      '<div class="skill-suggestion-actions">' +
      '<button type="button" class="skill-suggestion-btn skill-suggestion-reject" data-suggestion-id="' +
      id +
      '">Не треба</button>' +
      '<button type="button" class="skill-suggestion-btn skill-suggestion-accept" data-suggestion-id="' +
      id +
      '">Запам\'ятати</button>' +
      '</div></li>'
    );
  }

  function appendSkillSuggestionsCard(opts) {
    if (!messagesEl) return;
    const { projectId, chatId, suggestions, projectName } = opts;
    if (!suggestions || suggestions.length === 0) return;
    clearEmptyState();
    const safeName = escapeHtml((projectName || '').trim() || 'project');
    const rowsHtml = suggestions.map(buildSkillSuggestionRowHtml).filter(Boolean).join('');
    if (!rowsHtml) return;

    const pidEsc = String(projectId);
    const cidEsc = String(chatId);
    const existing = messagesEl.querySelector(
      '.skill-suggestions-card[data-project-id="' + pidEsc + '"][data-chat-id="' + cidEsc + '"]',
    );
    if (existing) {
      const ul = existing.querySelector('.skill-suggestions-list');
      if (!ul) return;
      const tpl = document.createElement('template');
      tpl.innerHTML = rowsHtml.trim();
      tpl.content.childNodes.forEach((n) => {
        if (n.nodeType !== 1) return;
        const el = n;
        const sid = el.dataset.suggestionId;
        if (!sid || ul.querySelector('.skill-suggestion-row[data-suggestion-id="' + sid + '"]'))
          return;
        ul.appendChild(el);
      });
      scrollToBottom();
      return;
    }

    const card = document.createElement('div');
    card.className = 'msg system skill-suggestions-card';
    card.dataset.projectId = pidEsc;
    card.dataset.chatId = cidEsc;
    card.innerHTML =
      '<div class="skill-suggestions-shell">' +
      '<p class="skill-suggestions-lead">💡 Запам\'ятати це для «' +
      safeName +
      '», щоб наступного разу зробити швидше?</p>' +
      '<ul class="skill-suggestions-list" role="list">' +
      rowsHtml +
      '</ul></div>';
    messagesAppendRoot().appendChild(card);
    scrollToBottom();
  }

  async function loadPendingSkillSuggestions() {
    if (activeChatId == null || !messagesEl) return;
    try {
      const res = await fetch(
        '/chats/' + encodeURIComponent(activeChatId) + '/skill-suggestions',
        { headers: { Accept: 'application/json' } },
      );
      if (!res.ok) return;
      const data = await res.json();
      const list = Array.isArray(data.suggestions) ? data.suggestions : [];
      if (list.length === 0) return;
      const first = list[0];
      const pid = first ? Number(first.project_id) : NaN;
      if (!Number.isFinite(pid)) return;
      const have = existingSkillSuggestionIds();
      const fresh = list
        .filter((s) => s && Number.isFinite(Number(s.id)) && !have.has(Number(s.id)))
        .map((s) => ({
          id: Number(s.id),
          kind: s.kind === 'patch' ? 'patch' : 'new',
          name: String(s.name ?? ''),
          description: String(s.description ?? ''),
          body: String(s.body ?? ''),
          untrusted: !!s.untrusted,
        }));
      const pname =
        typeof data.projectName === 'string' && data.projectName.trim()
          ? data.projectName.trim()
          : 'project';
      appendSkillSuggestionsCard({
        projectId: pid,
        chatId: activeChatId,
        projectName: pname,
        suggestions: fresh,
      });
    } catch (_) {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // queue widget — shows only WAITING items (not the in-flight one)
  // -------------------------------------------------------------------------

  function serverQueueItemFromApi(row) {
    const item = {
      serverId: row.id,
      id: String(row.id),
      content: row.content,
      mode: row.mode || undefined,
    };
    if (row.reply_to_message_id != null && row.reply_quote) {
      item.replyTo = {
        messageId: row.reply_to_message_id,
        quote: row.reply_quote,
        role: row.reply_to_role || undefined,
      };
    }
    if (row.attachments && row.attachments.length > 0) {
      item.attachments = row.attachments.map((a) => ({
        mimeType: a.mimeType,
        fileName: a.fileName,
        sizeBytes: a.sizeBytes,
        dataUrl: a.url,
        url: a.url,
      }));
    }
    return item;
  }

  function replaceWaitingItemsFromServer(rows) {
    waitingItems.length = 0;
    ownQueueIds.clear();
    for (const row of rows) addWaitingItem(serverQueueItemFromApi(row));
    renderQueue();
  }

  async function enqueueQueueOnServer(chatId, draft) {
    const body = { content: draft.content };
    if (draft.mode) body.mode = draft.mode;
    if (draft.replyTo) body.replyTo = draft.replyTo;
    if (draft.inlineSecrets && draft.inlineSecrets.length > 0) {
      body.inlineSecrets = draft.inlineSecrets;
    }
    if (draft.attachments && draft.attachments.length > 0) {
      body.attachments = draft.attachments.map((a) => ({
        mimeType: a.mimeType,
        fileName: a.fileName,
        content: a.base64,
      }));
    }
    const res = await fetch('/chats/' + encodeURIComponent(chatId) + '/queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || res.statusText || 'failed to enqueue');
    }
    return serverQueueItemFromApi(data.item);
  }

  async function deleteQueueOnServer(chatId, queueId) {
    await fetch(
      '/chats/' + encodeURIComponent(chatId) + '/queue/' + encodeURIComponent(queueId) + '/delete',
      { method: 'POST', headers: { Accept: 'application/json' } },
    );
  }

  async function promoteQueueOnServer(chatId, queueId) {
    const res = await fetch(
      '/chats/' + encodeURIComponent(chatId) + '/queue/' + encodeURIComponent(queueId) + '/promote',
      { method: 'POST', headers: { Accept: 'application/json' } },
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || res.statusText || 'failed to promote');
    }
    return data.queue;
  }

  const COMPOSER_PENDING_SEND_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  const COMPOSER_PENDING_EDIT_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

  function composerPendingRowInnerHtml(opts) {
    const kind = opts.kind;
    const whenEl =
      kind === 'scheduled' && opts.whenData
        ? '<span class="scheduled-item-when" data-when="' +
          escapeHtml(opts.whenData) +
          '">' +
          escapeHtml(opts.metaText) +
          '</span>'
        : '<span class="scheduled-item-when">' + escapeHtml(opts.metaText) + '</span>';
    return (
      '<div class="scheduled-item-text">' +
      escapeHtml(opts.content) +
      '</div>' +
      '<div class="scheduled-item-footer">' +
      '<div class="scheduled-item-meta">' +
      '<span class="scheduled-item-clock" aria-hidden="true">' +
      opts.metaIcon +
      '</span>' +
      whenEl +
      '</div>' +
      '<button type="button" class="scheduled-item-toggle" aria-expanded="false">Show more</button>' +
      opts.actionsHtml +
      '</div>'
    );
  }

  // Measure whether a pending-row's message overflows its collapsed height and
  // wire the "Show more" toggle accordingly. The full text always stays in the
  // DOM (only visually clipped via CSS), so edit/read paths still see it all.
  // Re-runnable: preserves an already-expanded row across content updates.
  function applyPendingRowClamp(row) {
    if (!row) return;
    const textEl = row.querySelector('.scheduled-item-text');
    const toggle = row.querySelector('.scheduled-item-toggle');
    if (!textEl || !toggle) return;
    const wasExpanded = row.classList.contains('is-expanded');
    // Collapse first so scrollHeight/clientHeight reflect the clamped box.
    row.classList.remove('is-expanded');
    const clampable = textEl.scrollHeight - textEl.clientHeight > 4;
    row.classList.toggle('is-clampable', clampable);
    const expanded = clampable && wasExpanded;
    row.classList.toggle('is-expanded', expanded);
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    toggle.textContent = expanded ? 'Show less' : 'Show more';
  }

  // Shared click handler for the "Show more"/"Show less" toggle in either list.
  // Returns true if it handled the event (so callers can early-return).
  function handlePendingRowToggleClick(e) {
    const toggle = e.target.closest('.scheduled-item-toggle');
    if (!toggle) return false;
    const row = toggle.closest('.scheduled-item');
    if (!row) return false;
    const expanded = row.classList.toggle('is-expanded');
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    toggle.textContent = expanded ? 'Show less' : 'Show more';
    return true;
  }

  function queueItemActionsHtml(id) {
    const esc = escapeHtml(String(id));
    return (
      '<div class="scheduled-item-actions">' +
      '<button type="button" class="queue-item-promote scheduled-item-send-now btn btn--icon btn--ghost" data-queue-id="' +
      esc +
      '" aria-label="Interrupt and send this" title="Interrupt current reply and send this message">' +
      COMPOSER_PENDING_SEND_SVG +
      '</button>' +
      '<button type="button" class="scheduled-item-cancel btn btn--icon btn--ghost" data-queue-id="' +
      esc +
      '" aria-label="Remove from queue" title="Remove from queue">×</button>' +
      '</div>'
    );
  }

  function renderQueue() {
    if (!queueListEl) return;
    dedupeWaitingItems();
    queueListEl.replaceChildren();
    waitingItems.forEach((item, idx) => {
      const row = document.createElement('div');
      const rowId = item.serverId != null ? item.serverId : item.id;
      row.className = 'scheduled-item scheduled-item--queue';
      row.dataset.queueId = String(rowId);
      row.innerHTML = composerPendingRowInnerHtml({
        kind: 'queue',
        metaIcon: '⏳',
        metaText: 'In queue #' + (idx + 1),
        content: item.content,
        actionsHtml: queueItemActionsHtml(rowId),
      });
      queueListEl.appendChild(row);
      applyPendingRowClamp(row);
    });
    queueListEl.classList.toggle('is-empty', waitingItems.length === 0);
  }

  const initialQueue = Array.isArray(window.__ICLAW_QUEUE__) ? window.__ICLAW_QUEUE__ : [];
  for (const row of initialQueue) addWaitingItem(serverQueueItemFromApi(row));
  if (initialQueue.length > 0) {
    renderQueue();
    // Turn already finished while we were on another page — drain persisted queue.
    if (!document.getElementById('reload-placeholder')) flushNextQueued();
  }

  // Click on a tool's stream-status with .has-detail toggles between the
  // generic label and the detailed line. While expanded, new tool-start
  // events keep showing detail until the user collapses or the turn ends.
  if (messagesEl) {
    messagesEl.addEventListener('click', (e) => {
      const replyStub = e.target.closest('.msg-reply-stub');
      if (replyStub) {
        const mid = replyStub.getAttribute('data-jump-to-msg');
        if (!mid) return;
        e.preventDefault();
        const targetMsg = messagesEl.querySelector('.msg[data-msg-id="' + mid + '"]');
        if (targetMsg) {
          cancelReplyJumpHighlightTimers();
          if (messagesEl) clearReplyJumpHighlights(messagesEl);
          const q = readReplyStubQuote(replyStub);
          const picked = q && highlightReplyTargetQuote(targetMsg, q);
          if (picked && messagesEl) scheduleClearReplyJumpHighlight(messagesEl);
          if (!picked) {
            targetMsg.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            targetMsg.classList.add('msg-highlight-flash');
            setTimeout(() => targetMsg.classList.remove('msg-highlight-flash'), 1200);
          }
        }
        return;
      }
      const copyBtn = e.target.closest('.code-copy-btn');
      if (copyBtn) {
        const wrap = copyBtn.closest('.code-block-wrap');
        const pre = wrap?.querySelector(':scope > pre');
        const code = pre?.querySelector('code');
        const raw = (code?.textContent ?? pre?.textContent ?? '').replace(/\u00a0/g, ' ');
        if (!raw.trim()) return;
        e.preventDefault();
        const showCopied = () => {
          copyBtn.innerHTML = CODE_COPIED_ICON_SVG;
          copyBtn.setAttribute('aria-label', 'Copied');
          copyBtn.removeAttribute('title');
          copyBtn.disabled = true;
          setTimeout(() => {
            copyBtn.innerHTML = CODE_COPY_ICON_SVG;
            copyBtn.setAttribute('aria-label', 'Copy code');
            copyBtn.title = 'Copy';
            copyBtn.disabled = false;
          }, 1700);
        };
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(raw).then(showCopied).catch(() => {});
        }
        return;
      }
      const acc = e.target.closest('.fact-suggestion-accept');
      const rej = e.target.closest('.fact-suggestion-reject');
      if (acc || rej) {
        const row = (acc || rej).closest('.fact-suggestion-row');
        cancelFactSuggestionRowExpiry(row);
        const sid = Number((acc || rej).dataset.suggestionId);
        if (!Number.isFinite(sid) || activeChatId == null) return;
        e.preventDefault();
        const path = acc ? 'accept' : 'reject';
        fetch(
          '/chats/' +
            encodeURIComponent(activeChatId) +
            '/fact-suggestions/' +
            encodeURIComponent(sid) +
            '/' +
            path,
          { method: 'POST', headers: { Accept: 'application/json' } },
        )
          .then((res) => {
            if (res.ok) removeFactSuggestionRow(activeChatId, sid);
          })
          .catch(() => {});
        return;
      }
      const sAcc = e.target.closest('.skill-suggestion-accept');
      const sRej = e.target.closest('.skill-suggestion-reject');
      if (sAcc || sRej) {
        const row = (sAcc || sRej).closest('.skill-suggestion-row');
        const sid = Number((sAcc || sRej).dataset.suggestionId);
        if (!Number.isFinite(sid) || activeChatId == null) return;
        e.preventDefault();
        if (sRej) {
          fetch(
            '/chats/' +
              encodeURIComponent(activeChatId) +
              '/skill-suggestions/' +
              encodeURIComponent(sid) +
              '/reject',
            { method: 'POST', headers: { Accept: 'application/json' } },
          )
            .then((res) => {
              if (res.ok) removeSkillSuggestionRow(activeChatId, sid);
            })
            .catch(() => {});
          return;
        }
        // Accept — submit any inline edits + the scope choice.
        const name = row?.querySelector('.skill-suggestion-name')?.value?.trim() || '';
        const description = row?.querySelector('.skill-suggestion-desc')?.value?.trim() || '';
        const body = row?.querySelector('.skill-suggestion-body')?.value?.trim() || '';
        const global = !!row?.querySelector('.skill-suggestion-global')?.checked;
        const payload = { scope: global ? 'global' : 'project' };
        if (name) payload.name = name;
        if (description) payload.description = description;
        if (body) payload.body = body;
        if (sAcc) sAcc.disabled = true;
        fetch(
          '/chats/' +
            encodeURIComponent(activeChatId) +
            '/skill-suggestions/' +
            encodeURIComponent(sid) +
            '/accept',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(payload),
          },
        )
          .then((res) => {
            if (res.ok) removeSkillSuggestionRow(activeChatId, sid);
            else if (sAcc) sAcc.disabled = false;
          })
          .catch(() => {
            if (sAcc) sAcc.disabled = false;
          });
        return;
      }
      const status = e.target.closest('.stream-status.has-detail');
      if (!status) return;
      const expanded = status.classList.toggle('detail-expanded');
      if (expanded) {
        stopStreamStatusDotAnim(status);
        status.textContent = status.dataset.detail || status.textContent;
      } else {
        const lab = status.dataset.label || status.textContent;
        setStreamStatusLabel(status, lab);
      }
    });
  }

  // Delete from queue + interrupt-and-promote via event delegation.
  if (queueListEl) {
    queueListEl.addEventListener('click', (e) => {
      if (handlePendingRowToggleClick(e)) return;
      const row = e.target.closest('.scheduled-item--queue');
      if (!row) return;
      const id = row.dataset.queueId;
      if (!id) return;
      const idx = waitingItems.findIndex((it) => String(it.serverId ?? it.id) === id);
      if (idx < 0) return;

      const cancelBtn = e.target.closest('.scheduled-item-cancel[data-queue-id]');
      const promoteBtn = e.target.closest('.queue-item-promote');

      if (cancelBtn) {
        const removed = waitingItems.splice(idx, 1)[0];
        if (removed?.serverId != null) ownQueueIds.delete(removed.serverId);
        renderQueue();
        if (removed?.serverId != null && activeChatId != null) {
          deleteQueueOnServer(activeChatId, removed.serverId).catch(() => {});
        }
        return;
      }
      if (!promoteBtn) return;

      // Interrupt: move this item to the front and abort the running turn.
      // The turn-error handler clears inFlight and calls flushNextQueued(),
      // which now picks up our promoted item.
      if (activeChatId == null) return;
      const picked = waitingItems[idx];
      if (!picked) return;
      const doPromoteLocal = () => {
        waitingItems.splice(idx, 1);
        waitingItems.unshift(picked);
        renderQueue();
      };
      if (picked.serverId != null) {
        promoteQueueOnServer(activeChatId, picked.serverId)
          .then((queue) => replaceWaitingItemsFromServer(queue))
          .catch(() => doPromoteLocal());
      } else {
        doPromoteLocal();
      }
      // If nothing is actually running, just flush now — no need to abort.
      if (!inFlight) {
        flushNextQueued();
        return;
      }
      // Optimistically disable buttons to prevent rapid double-clicks.
      if (promoteBtn) {
        promoteBtn.disabled = true;
        setTimeout(() => { promoteBtn.disabled = false; }, 3000);
      }
      wsSend({ type: 'abort', chatId: activeChatId });
    });
  }

  // -------------------------------------------------------------------------
  // sidebar live updates (flat chat list + optional project logo prefix)
  // -------------------------------------------------------------------------
  function findProjectMeta(projectId) {
    const arr = window.__ICLAW_PROJECTS__;
    if (!Array.isArray(arr) || projectId == null) return null;
    const id = Number(projectId);
    if (!Number.isFinite(id)) return null;
    return arr.find((p) => p && p.id === id) ?? null;
  }

  function getProjectsHubListEl() {
    return document.getElementById('projects-hub-list');
  }

  function sortProjectsHubRows() {
    const ul = getProjectsHubListEl();
    if (!ul) return;
    const rows = Array.from(ul.querySelectorAll(':scope > li.projects-hub-row'));
    if (rows.length < 2) return;
    function key(li) {
      const msgs = parseInt(li.getAttribute('data-msgs-14') || '0', 10) || 0;
      const chats = parseInt(li.getAttribute('data-chats-14') || '0', 10) || 0;
      const name = (li.querySelector('.projects-hub-name')?.textContent || '').toLowerCase();
      const id = parseInt(li.getAttribute('data-project-id') || '0', 10) || 0;
      return { msgs, chats, name, id };
    }
    rows.sort((a, b) => {
      const pa = key(a);
      const pb = key(b);
      if (pb.msgs !== pa.msgs) return pb.msgs - pa.msgs;
      if (pb.chats !== pa.chats) return pb.chats - pa.chats;
      const cmp = pa.name.localeCompare(pb.name, 'en', { sensitivity: 'base' });
      if (cmp !== 0) return cmp;
      return pa.id - pb.id;
    });
    for (const li of rows) ul.appendChild(li);
  }

  function appendProjectsHubRow(project) {
    const ul = getProjectsHubListEl();
    if (!ul || !project) return;
    ul.querySelector('.projects-hub-empty')?.remove();
    const pid = Number(project.id);
    if (!Number.isFinite(pid)) return;
    if (ul.querySelector('.projects-hub-row[data-project-id="' + pid + '"]')) return;
    const li = document.createElement('li');
    li.className = 'projects-hub-row';
    li.dataset.projectId = String(pid);
    li.setAttribute('data-msgs-14', '0');
    li.setAttribute('data-chats-14', '0');
    const ei = clampLogoEmojiJs(project.logo_emoji);
    const ci = clampLogoColorJs(project.logo_color);
    const nm = String(project.name || 'Project').trim() || 'Project';
    li.innerHTML =
      '<a href="/projects/' +
      pid +
      '" class="projects-hub-link">' +
      buildProjectLogoHtml(ei, ci) +
      '<span class="projects-hub-name">' +
      escapeHtml(nm) +
      '</span>' +
      '<span class="projects-hub-meta muted">0 chats</span></a>';
    ul.appendChild(li);
    sortProjectsHubRows();
  }

  function removeProjectsHubRow(projectId) {
    const ul = getProjectsHubListEl();
    if (!ul) return;
    const pid = Number(projectId);
    if (!Number.isFinite(pid)) return;
    ul.querySelector('.projects-hub-row[data-project-id="' + pid + '"]')?.remove();
    if (!ul.querySelector('.projects-hub-row')) {
      const li = document.createElement('li');
      li.className = 'projects-hub-empty';
      li.setAttribute('aria-live', 'polite');
      li.innerHTML =
        '<div class="projects-hub-empty-visual" aria-hidden="true"></div>' +
        '<p class="projects-hub-empty-title">Nothing here yet</p>' +
        '<p class="projects-hub-empty-hint muted">Add one above, then choose it when you start a chat from home.</p>';
      ul.appendChild(li);
    }
  }

  function updateProjectsHubRow(project) {
    const ul = getProjectsHubListEl();
    if (!ul || !project) return;
    const pid = Number(project.id);
    if (!Number.isFinite(pid)) return;
    const li = ul.querySelector('.projects-hub-row[data-project-id="' + pid + '"]');
    if (!li) return;
    const textEl = li.querySelector('.projects-hub-name');
    const logoEl = li.querySelector('.project-logo');
    if (textEl && project.name != null) {
      textEl.textContent = String(project.name).trim() || 'Project';
    }
    const hasE = project.logo_emoji !== undefined && project.logo_emoji !== null;
    const hasC = project.logo_color !== undefined && project.logo_color !== null;
    if (logoEl && (hasE || hasC)) {
      const cur = readLogoFromEl(logoEl);
      const ei = hasE ? clampLogoEmojiJs(Number(project.logo_emoji)) : cur.ei;
      const ci = hasC ? clampLogoColorJs(Number(project.logo_color)) : cur.ci;
      applyProjectLogoToEl(logoEl, ei, ci);
    }
  }

  function mergeProjectIntoClientCache(projectId, projectName) {
    if (projectId == null || !Number.isFinite(Number(projectId))) return;
    const pid = Number(projectId);
    const arr = window.__ICLAW_PROJECTS__;
    if (!Array.isArray(arr)) return;
    const nm = projectName != null ? String(projectName) : '';
    const prev = arr.find((p) => p && p.id === pid);
    if (!prev) {
      arr.push({
        id: pid,
        name: nm || 'Project',
        logo_emoji: 0,
        logo_color: 0,
      });
    } else if (nm) prev.name = nm;
  }

  function buildChatItemLeadingMarkHtml(projectIdStr) {
    const raw = projectIdStr != null ? String(projectIdStr).trim() : '';
    if (raw === '') {
      return '<span class="chat-item-project-mark chat-item-project-mark--spacer" aria-hidden="true"></span>';
    }
    const pid = Number(raw);
    if (!Number.isFinite(pid)) {
      return '<span class="chat-item-project-mark chat-item-project-mark--spacer" aria-hidden="true"></span>';
    }
    const p = findProjectMeta(pid);
    const ei = p ? clampLogoEmojiJs(Number(p.logo_emoji)) : 0;
    const ci = p ? clampLogoColorJs(Number(p.logo_color)) : 0;
    return (
      '<span class="chat-item-project-mark" aria-hidden="true">' +
      buildProjectLogoHtml(ei, ci) +
      '</span>'
    );
  }

  function buildChatItemAvatarWrapHtml(projectIdStr) {
    return (
      '<span class="chat-item-avatar-wrap">' +
      buildChatItemLeadingMarkHtml(projectIdStr) +
      '<span class="status-dot" aria-hidden="true"></span></span>'
    );
  }

  function syncChatItemProjectMark(link) {
    const mark = link.querySelector('.chat-item-avatar-wrap .chat-item-project-mark');
    if (!mark) return;
    const html = buildChatItemLeadingMarkHtml(link.dataset.projectId || '');
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const next = tmp.firstElementChild;
    if (next) mark.replaceWith(next);
  }

  function parseSidebarChatTs(iso) {
    if (iso == null || iso === '') return 0;
    const t = Date.parse(String(iso).replace(' ', 'T'));
    return Number.isFinite(t) ? t : 0;
  }

  function insertChatItemSorted(list, link) {
    const tail = list.querySelector('#sidebar-list-tail');
    const mine = Number(link.dataset.chatId);
    const myTs = parseSidebarChatTs(link.dataset.updatedAt);
    const others = Array.from(list.querySelectorAll('a.chat-item[data-chat-id]')).filter((el) => el !== link);
    let insertBefore = null;
    for (let i = 0; i < others.length; i++) {
      const o = others[i];
      const oTs = parseSidebarChatTs(o.dataset.updatedAt);
      const oid = Number(o.dataset.chatId);
      if (myTs > oTs || (myTs === oTs && mine > oid)) {
        insertBefore = o;
        break;
      }
    }
    if (insertBefore) list.insertBefore(link, insertBefore);
    else if (tail) list.insertBefore(link, tail);
    else list.appendChild(link);
  }

  function sidebarUpsertChat(opts) {
    const id = opts.id;
    const title = opts.title;
    const projectId = opts.projectId;
    const projectName = opts.projectName;
    const updatedAt = opts.updatedAt;

    const list = document.getElementById('chat-list');
    if (!list) return;
    list.querySelector('.empty-list')?.remove();
    let link = list.querySelector('a.chat-item[data-chat-id="' + id + '"]');
    const isNew = !link;
    if (!link) {
      link = document.createElement('a');
      link.href = '/chats/' + id;
      link.className = 'chat-item';
      link.dataset.chatId = String(id);
      link.innerHTML =
        buildChatItemAvatarWrapHtml('') +
        '<span class="chat-item-title"></span>';
    }
    if (title != null) {
      const titleEl = link.querySelector('.chat-item-title');
      if (titleEl) titleEl.textContent = title;
    }
    if (updatedAt != null && updatedAt !== '') {
      link.dataset.updatedAt = String(updatedAt);
    }
    if (projectId !== undefined) {
      link.dataset.projectId = projectId == null || projectId === '' ? '' : String(projectId);
      if (projectName != null && projectId != null && projectId !== '') {
        mergeProjectIntoClientCache(projectId, projectName);
      }
      syncChatItemProjectMark(link);
    }
    const reposition =
      isNew ||
      (updatedAt != null && updatedAt !== '') ||
      projectId !== undefined;
    if (reposition) {
      if (link.parentElement) link.parentElement.removeChild(link);
      insertChatItemSorted(list, link);
    } else if (!list.contains(link)) {
      insertChatItemSorted(list, link);
    }
    if (id === activeChatId) {
      document.querySelector('.new-chat-btn')?.classList.remove('active');
      list.querySelectorAll('.chat-item.active').forEach((el) => el.classList.remove('active'));
      link.classList.add('active');
    }
    applySidebarSearchFilterIfActive();
  }
  function sidebarRemoveChat(id) {
    const list = document.getElementById('chat-list');
    const link = list?.querySelector('a.chat-item[data-chat-id="' + id + '"]');
    link?.remove();
    if (searchMatchSet !== null) applySidebarSearchFilter();
  }
  function statusDot(id) {
    return document.querySelector(
      '.chat-item[data-chat-id="' + id + '"] .chat-item-avatar-wrap .status-dot',
    );
  }
  /** chatId → pending scheduled row count (sidebar muted dot). */
  const scheduledPendingCount = new Map();
  (function initScheduledPendingCount() {
    const raw = window.__ICLAW_SCHEDULED_CHAT_COUNTS__;
    if (!raw || typeof raw !== 'object') return;
    for (const [id, count] of Object.entries(raw)) {
      const chatId = Number(id);
      const n = Number(count);
      if (Number.isFinite(chatId) && n > 0) scheduledPendingCount.set(chatId, n);
    }
  })();

  function reconcileStatusDot(id) {
    const dot = statusDot(id);
    if (!dot) return;
    const working = dot.classList.contains('working');
    const unread = dot.classList.contains('unread');
    dot.classList.remove('scheduled');
    if (working || unread) {
      dot.setAttribute('aria-hidden', 'true');
      dot.removeAttribute('aria-label');
      scheduleFaviconUpdate();
      return;
    }
    const pending = scheduledPendingCount.get(id) || 0;
    if (pending > 0) {
      dot.classList.add('scheduled');
      dot.removeAttribute('aria-hidden');
      dot.setAttribute('aria-label', 'Scheduled message pending');
    } else {
      dot.setAttribute('aria-hidden', 'true');
      dot.removeAttribute('aria-label');
    }
    scheduleFaviconUpdate();
  }

  function setScheduledPendingCount(id, count) {
    const n = Math.max(0, Number(count) || 0);
    if (n > 0) scheduledPendingCount.set(id, n);
    else scheduledPendingCount.delete(id);
    reconcileStatusDot(id);
  }

  function bumpScheduledPending(id, delta) {
    const next = Math.max(0, (scheduledPendingCount.get(id) || 0) + delta);
    setScheduledPendingCount(id, next);
  }

  function countScheduledRowsInComposer() {
    if (!scheduledListEl) return 0;
    return scheduledListEl.querySelectorAll('.scheduled-item--scheduled').length;
  }

  function syncScheduledSidebarForChat(chatId) {
    if (chatId === activeChatId && scheduledListEl) {
      setScheduledPendingCount(chatId, countScheduledRowsInComposer());
    }
  }

  function setWorkingDot(id, on) {
    const dot = statusDot(id);
    if (!dot) return;
    if (on) {
      dot.classList.add('working');
      dot.classList.remove('unread');
    } else {
      dot.classList.remove('working');
    }
    reconcileStatusDot(id);
  }
  function setUnreadDot(id, on) {
    const dot = statusDot(id);
    if (!dot) return;
    if (on) dot.classList.add('unread');
    else dot.classList.remove('unread');
    reconcileStatusDot(id);
  }

  // -------------------------------------------------------------------------
  // Dynamic favicon — rounded (Apple-ish) + aggregate status dots.
  //
  // The favicon is a *derived view* of the sidebar status dots already in the
  // DOM, so there's no parallel state to keep in sync. We only repaint when
  // the computed verdict actually changes (debounced), so steady-state =
  // zero work. Dots are static (never animated) — animating a favicon would
  // re-encode a PNG every frame, which is the one thing that actually costs.
  // -------------------------------------------------------------------------
  const FAVICON_DEBOUNCE_MS = 200;
  const FAVICON_SIZE = 64; // render large; the browser downscales to 16/32
  let faviconBaseImg = null;
  let faviconBaseReady = false;
  let faviconLastVerdict = null;
  let faviconDebounceTimer = null;
  let faviconLinkEl = null;

  function faviconColor(name) {
    // Read live CSS tokens so dark theme is respected; hardcoded fallbacks
    // are the light-theme values.
    const read = (v, fallback) => {
      try {
        const got = getComputedStyle(document.documentElement)
          .getPropertyValue(v)
          .trim();
        return got || fallback;
      } catch {
        return fallback;
      }
    };
    if (name === 'orange') return '#ff9500';
    if (name === 'blue') return read('--md-link', '#2962ff');
    if (name === 'green') return read('--ok', '#16a34a');
    if (name === 'stone') return read('--scheduled', '#78716c');
    return '#888';
  }

  function ensureFaviconLink() {
    if (faviconLinkEl) return faviconLinkEl;
    // Drop the static PNG/ICO icon links so the browser doesn't prefer them
    // over our canvas one. apple-touch-icon is left alone (iOS rounds it).
    document
      .querySelectorAll('link[rel~="icon"]')
      .forEach((el) => el.parentNode && el.parentNode.removeChild(el));
    faviconLinkEl = document.createElement('link');
    faviconLinkEl.rel = 'icon';
    faviconLinkEl.id = 'iclaw-dynamic-favicon';
    document.head.appendChild(faviconLinkEl);
    return faviconLinkEl;
  }

  /** Read the sidebar DOM → ordered, de-duped color list (max 2). */
  function computeFaviconVerdict() {
    const has = (sel) => document.querySelector(sel) != null;
    const working =
      has('.chat-list .status-dot.working') ||
      has('.sidebar-tasks-dots .status-dot.working');
    const unread = has('.chat-list .status-dot.unread');
    const scheduled = has('.chat-list .status-dot.scheduled');
    const needsHuman = has('.sidebar-tasks-dots .status-dot.task-human');
    const review = has('.sidebar-tasks-dots .status-dot.task-review');
    const colors = [];
    if (needsHuman) colors.push('orange'); // most urgent
    if (unread || review) colors.push('blue');
    if (working) colors.push('green');
    if (scheduled) colors.push('stone');
    return colors.slice(0, 2); // cap at 2 — 3 dots turn to mush at 16px
  }

  function roundedClip(ctx, s) {
    const r = s * 0.28; // squircle-ish corner
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(0, 0, s, s, r);
    } else {
      ctx.moveTo(r, 0);
      ctx.arcTo(s, 0, s, s, r);
      ctx.arcTo(s, s, 0, s, r);
      ctx.arcTo(0, s, 0, 0, r);
      ctx.arcTo(0, 0, s, 0, r);
    }
    ctx.closePath();
  }

  function drawFavicon(colors) {
    if (!faviconBaseReady) return;
    const s = FAVICON_SIZE;
    const canvas = document.createElement('canvas');
    canvas.width = s;
    canvas.height = s;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Base icon, clipped to the rounded shape.
    ctx.save();
    roundedClip(ctx, s);
    ctx.clip();
    ctx.drawImage(faviconBaseImg, 0, 0, s, s);
    ctx.restore();

    // Status dots in the bottom-right, drawn right→left so the highest
    // priority (colors[0]) sits closest to the corner. Each gets a light
    // ring so it reads on any base color.
    const dotR = s * 0.17;
    const ring = Math.max(1.5, s * 0.045);
    const gap = dotR * 0.7;
    let cx = s - dotR - ring;
    const cy = s - dotR - ring;
    for (const color of colors) {
      ctx.beginPath();
      ctx.arc(cx, cy, dotR + ring, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
      ctx.fillStyle = faviconColor(color);
      ctx.fill();
      cx -= dotR * 2 + gap;
    }

    try {
      ensureFaviconLink().href = canvas.toDataURL('image/png');
    } catch {
      /* canvas tainted / unsupported — leave the static favicon */
    }
  }

  function scheduleFaviconUpdate() {
    if (faviconDebounceTimer != null) clearTimeout(faviconDebounceTimer);
    faviconDebounceTimer = setTimeout(() => {
      faviconDebounceTimer = null;
      const colors = computeFaviconVerdict();
      const key = colors.join(',');
      if (key === faviconLastVerdict) return; // verdict unchanged → no repaint
      faviconLastVerdict = key;
      drawFavicon(colors);
    }, FAVICON_DEBOUNCE_MS);
  }

  function initDynamicFavicon() {
    if (!document.head) return;
    ensureFaviconLink();
    const img = new Image();
    img.onload = () => {
      faviconBaseImg = img;
      faviconBaseReady = true;
      faviconLastVerdict = null; // force the first paint (rounding even when idle)
      scheduleFaviconUpdate();
    };
    img.onerror = () => {
      /* no base image — keep whatever the browser already has */
    };
    img.src = '/icon-192.png';
  }

  let searchMatchSet = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let searchDebounceTimer = null;
  const SIDEBAR_SEARCH_DEBOUNCE_MS = 1500;

  function ensureSearchNoMatchesEl(list) {
    let el = list.querySelector('.search-no-matches');
    if (!el) {
      el = document.createElement('p');
      el.className = 'muted empty-list search-no-matches';
      el.textContent = 'No matches.';
      el.hidden = true;
      list.appendChild(el);
    }
    return el;
  }

  function applySidebarSearchFilter() {
    const list = document.getElementById('chat-list');
    const statusEl = document.getElementById('sidebar-search-status');
    if (!list) return;
    const noMatches = ensureSearchNoMatchesEl(list);
    if (searchMatchSet === null) {
      list.querySelectorAll('.chat-item').forEach((link) => {
        link.hidden = false;
      });
      noMatches.hidden = true;
      if (statusEl) {
        statusEl.hidden = true;
        statusEl.textContent = '';
      }
      return;
    }
    const items = list.querySelectorAll('.chat-item');
    let visibleCount = 0;
    items.forEach((link) => {
      const id = Number(link.dataset.chatId);
      const show = searchMatchSet.has(id);
      link.hidden = !show;
      if (show) visibleCount += 1;
    });
    const total = items.length;
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.textContent =
        visibleCount === total
          ? 'All ' + total + ' chats match'
          : visibleCount + ' of ' + total + ' chats';
    }
    const anyVisible = list.querySelector('.chat-item:not([hidden])');
    const hasAnyChats = total > 0;
    noMatches.hidden = !hasAnyChats || Boolean(anyVisible);
  }

  async function runSidebarSearch() {
    const q = searchInput ? searchInput.value : '';
    if (!q.trim()) {
      searchMatchSet = null;
      applySidebarSearchFilter();
      return;
    }
    try {
      const res = await fetch('/chats/search?' + new URLSearchParams({ q: q.trim() }), {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error('search ' + res.status);
      const data = await res.json();
      const ids = Array.isArray(data.ids) ? data.ids : [];
      searchMatchSet = new Set(ids.map((x) => Number(x)));
    } catch (err) {
      console.error('[iclaw] sidebar search failed', err);
      searchMatchSet = null;
    }
    applySidebarSearchFilter();
  }

  function scheduleSidebarSearch() {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      searchDebounceTimer = null;
      runSidebarSearch();
    }, SIDEBAR_SEARCH_DEBOUNCE_MS);
  }

  function applySidebarSearchFilterIfActive() {
    if (searchMatchSet !== null) applySidebarSearchFilter();
  }

  // -------------------------------------------------------------------------
  // Sidebar chat context menu (share, rename, unread, delete) + text selection → reply
  // -------------------------------------------------------------------------
  const sidebarChatMenu = document.createElement('div');
  sidebarChatMenu.id = 'sidebar-chat-context-menu';
  sidebarChatMenu.className = 'sidebar-context-menu';
  sidebarChatMenu.hidden = true;
  document.body.appendChild(sidebarChatMenu);
  let sidebarMenuChatId = null;

  function buildSidebarContextMenuHtml() {
    const hasShare =
      Boolean(document.getElementById('share-modal')) &&
      Boolean(document.getElementById('share-btn'));
    const shareBtnHtml = hasShare
      ? '<button type="button" class="sidebar-context-menu-item" data-action="share">Share</button>'
      : '';
    return (
      shareBtnHtml +
      '<button type="button" class="sidebar-context-menu-item" data-action="rename">Rename</button>' +
      '<button type="button" class="sidebar-context-menu-item" data-action="unread">Mark unread</button>' +
      '<button type="button" class="sidebar-context-menu-item sidebar-context-menu-danger" data-action="delete">Delete chat</button>'
    );
  }

  const SIDEBAR_MENU_HOVER_INTENT_MS = 3500;
  let sidebarChatMenuAutoCloseTimer = null;

  function armSidebarChatMenuAutoClose() {
    if (sidebarChatMenuAutoCloseTimer != null) clearTimeout(sidebarChatMenuAutoCloseTimer);
    sidebarChatMenuAutoCloseTimer = setTimeout(() => {
      sidebarChatMenuAutoCloseTimer = null;
      closeSidebarChatMenu();
    }, SIDEBAR_MENU_HOVER_INTENT_MS);
  }
  function disarmSidebarChatMenuAutoClose() {
    if (sidebarChatMenuAutoCloseTimer != null) {
      clearTimeout(sidebarChatMenuAutoCloseTimer);
      sidebarChatMenuAutoCloseTimer = null;
    }
  }

  function closeSidebarChatMenu() {
    sidebarChatMenu.hidden = true;
    sidebarMenuChatId = null;
    disarmSidebarChatMenuAutoClose();
  }

  function openSidebarChatMenu(clientX, clientY, chatId) {
    sidebarMenuChatId = chatId;
    sidebarChatMenu.innerHTML = buildSidebarContextMenuHtml();
    sidebarChatMenu.hidden = false;
    const pad = 8;
    const mw = 200;
    const n = sidebarChatMenu.querySelectorAll('[data-action]').length || 1;
    const mh = Math.min(400, 28 + n * 42);
    let x = clientX;
    let y = clientY;
    x = Math.max(pad, Math.min(x, window.innerWidth - mw - pad));
    y = Math.max(pad, Math.min(y, window.innerHeight - mh - pad));
    sidebarChatMenu.style.left = x + 'px';
    sidebarChatMenu.style.top = y + 'px';
    armSidebarChatMenuAutoClose();
  }

  // Hover intent for the sidebar context menu — mirrors the schedule menu.
  sidebarChatMenu.addEventListener('mouseenter', disarmSidebarChatMenuAutoClose);
  sidebarChatMenu.addEventListener('mouseleave', armSidebarChatMenuAutoClose);

  document.addEventListener('pointerdown', (e) => {
    if (sidebarChatMenu.hidden) return;
    if (sidebarChatMenu.contains(e.target)) return;
    closeSidebarChatMenu();
  });

  sidebarChatMenu.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-action');
    const cid = sidebarMenuChatId;
    closeSidebarChatMenu();
    if (!Number.isFinite(cid)) return;
    if (action === 'share') {
      const list = document.getElementById('chat-list');
      const link = list?.querySelector('a.chat-item[data-chat-id="' + cid + '"]');
      const titleEl = link?.querySelector('.chat-item-title');
      const title = (titleEl && titleEl.textContent ? titleEl.textContent : '').trim() || 'Shared chat';
      window.dispatchEvent(
        new CustomEvent('iclaw-open-share', { detail: { chatId: cid, title } }),
      );
      return;
    }
    if (action === 'rename') {
      const list = document.getElementById('chat-list');
      const link = list?.querySelector('a.chat-item[data-chat-id="' + cid + '"]');
      const titleEl = link?.querySelector('.chat-item-title');
      const curTitle = (titleEl && titleEl.textContent ? titleEl.textContent : '').trim() || 'Chat';
      const next = window.prompt('New chat title:', curTitle);
      if (next == null) return;
      const t = next.trim();
      if (!t || t === curTitle) return;
      try {
        const res = await fetch('/chats/' + encodeURIComponent(cid), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: t }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        const nextTitle = data.title != null ? String(data.title) : t;
        if (link) {
          const te = link.querySelector('.chat-item-title');
          if (te) te.textContent = nextTitle;
        }
        if (activeChatId === cid && titleInput) {
          titleInput.value = nextTitle;
          titleInput.defaultValue = nextTitle;
        }
      } catch (err) {
        console.error('[iclaw] sidebar rename failed', err);
        window.alert('Could not save title.');
      }
      return;
    }
    if (action === 'unread') {
      try {
        const res = await fetch('/chats/' + encodeURIComponent(cid) + '/unread', {
          method: 'POST',
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(String(res.status));
        goTo('/');
      } catch (err) {
        console.error('[iclaw] mark unread failed', err);
      }
      return;
    }
    if (action === 'delete') {
      if (!confirm('Delete this chat?')) return;
      const f = document.createElement('form');
      f.method = 'POST';
      f.action = '/chats/' + encodeURIComponent(cid) + '/delete';
      document.body.appendChild(f);
      // requestSubmit() (not submit()) fires a real submit event, so the E2E
      // SPA layer can take it over the encrypted channel instead of a full
      // navigation that bounces off the gate. Falls back to a normal submit
      // when that layer isn't present (local, non-tunnel).
      if (typeof f.requestSubmit === 'function') f.requestSubmit();
      else f.submit();
    }
  });

  const chatListNav = document.getElementById('chat-list');
  if (chatListNav) {
    chatListNav.addEventListener('contextmenu', (e) => {
      const link = e.target.closest('a.chat-item[data-chat-id]');
      if (!link) return;
      e.preventDefault();
      const id = Number(link.dataset.chatId);
      if (!Number.isFinite(id)) return;
      markSidebarHintDiscovered(); // user discovered the gesture; never nag again
      openSidebarChatMenu(e.clientX, e.clientY, id);
    });

    // Hover-and-hold parity: cursor parked on a chat-item for 1.5s opens
    // the same context menu as right-click. Mouseover bubbles, so we use it
    // for delegation; we de-dupe child movements via the "same target" check.
    const HOVER_HOLD_MS = 1500;
    let chatHoverTimer = null;
    let chatHoverItem = null;
    chatListNav.addEventListener('mouseover', (e) => {
      const link = e.target.closest('a.chat-item[data-chat-id]');
      if (link === chatHoverItem) return; // still on same item (moved to child)
      if (chatHoverTimer) {
        clearTimeout(chatHoverTimer);
        chatHoverTimer = null;
      }
      chatHoverItem = link;
      if (!link) return;
      const id = Number(link.dataset.chatId);
      if (!Number.isFinite(id)) return;
      chatHoverTimer = setTimeout(() => {
        chatHoverTimer = null;
        if (chatHoverItem !== link) return; // pointer moved before timer fired
        const rect = link.getBoundingClientRect();
        markSidebarHintDiscovered();
        // Open near the item's right edge so the menu doesn't cover the title.
        openSidebarChatMenu(rect.right - 12, rect.top + 8, id);
      }, HOVER_HOLD_MS);
    });
    chatListNav.addEventListener('mouseout', (e) => {
      const link = e.target.closest('a.chat-item[data-chat-id]');
      if (!link) return;
      // Cursor moved to a child of the same item — not actually leaving.
      if (e.relatedTarget && link.contains(e.relatedTarget)) return;
      if (link !== chatHoverItem) return;
      if (chatHoverTimer) {
        clearTimeout(chatHoverTimer);
        chatHoverTimer = null;
      }
      chatHoverItem = null;
    });
  }

  // -------------------------------------------------------------------------
  // sidebar right-click discovery pill — paired with the contextmenu handler
  // above. Pure client gate: once the user right-clicks a chat, the flag
  // is set and the pill never shows again on this device.
  // -------------------------------------------------------------------------
  const SIDEBAR_HINT_DISCOVERED_KEY = 'sidebar-hint-discovered';
  const SIDEBAR_HINT_LAST_SHOWN_KEY = 'sidebar-hint-last-shown';
  function markSidebarHintDiscovered() {
    window.iclawUI.set(SIDEBAR_HINT_DISCOVERED_KEY, '1');
    const pill = document.getElementById('sidebar-hint-pill');
    if (pill && pill.parentNode) pill.parentNode.removeChild(pill);
  }

  (function setupSidebarHintPill() {
    const pill = document.getElementById('sidebar-hint-pill');
    if (!pill) return; // server skipped it (no chats yet)

    let discovered = null;
    let lastShown = null;
    discovered = window.iclawUI.get(SIDEBAR_HINT_DISCOVERED_KEY);
    lastShown = window.iclawUI.get(SIDEBAR_HINT_LAST_SHOWN_KEY);
    if (discovered === '1') {
      pill.remove();
      return;
    }

    const d = new Date();
    const todayKey =
      d.getFullYear() +
      '-' +
      String(d.getMonth() + 1).padStart(2, '0') +
      '-' +
      String(d.getDate()).padStart(2, '0');
    if (lastShown === todayKey) {
      pill.remove();
      return;
    }

    window.iclawUI.set(SIDEBAR_HINT_LAST_SHOWN_KEY, todayKey);

    pill.hidden = false;
    const hideTimer = setTimeout(() => {
      if (pill.parentNode) pill.parentNode.removeChild(pill);
    }, 12_000);

    // Click on any chat (left-click) = user is moving on — dismiss the
    // pill. We don't set discovered here, because they didn't actually
    // use the gesture yet.
    if (chatListNav) {
      chatListNav.addEventListener(
        'click',
        () => {
          clearTimeout(hideTimer);
          if (pill.parentNode) pill.parentNode.removeChild(pill);
        },
        { once: true },
      );
    }
  })();

  const selectionReplyFab = document.createElement('div');
  selectionReplyFab.id = 'msg-selection-reply-fab';
  selectionReplyFab.hidden = true;
  selectionReplyFab.innerHTML =
    '<div class="msg-selection-fab-inner">' +
    '<button type="button" class="msg-selection-reply-btn" data-selection-action="reply">Reply</button>' +
    '<button type="button" class="msg-selection-reply-btn" data-selection-action="hide-secret" hidden>Hide</button>' +
    '</div>';
  document.body.appendChild(selectionReplyFab);
  const selectionHideSecretBtn = selectionReplyFab.querySelector(
    '[data-selection-action="hide-secret"]',
  );

  function hideSelectionReplyFab() {
    selectionReplyFab.hidden = true;
  }

  function getReplySelectionContext() {
    if (!messagesEl || activeChatId == null) return null;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const raw = sel.toString().trim();
    if (!raw) return null;
    const quote = raw.length > REPLY_QUOTE_MAX ? raw.slice(0, REPLY_QUOTE_MAX) : raw;
    const anchorRoot =
      sel.anchorNode && sel.anchorNode.nodeType === 3
        ? sel.anchorNode.parentElement
        : /** @type {Element | null} */ (sel.anchorNode);
    const focusRoot =
      sel.focusNode && sel.focusNode.nodeType === 3
        ? sel.focusNode.parentElement
        : /** @type {Element | null} */ (sel.focusNode);
    const el = anchorRoot && anchorRoot.closest ? anchorRoot.closest('.msg') : null;
    const el2 = focusRoot && focusRoot.closest ? focusRoot.closest('.msg') : null;
    if (!el || el !== el2) return null;
    if (!messagesEl.contains(el)) return null;
    if (
      el.classList.contains('streaming') ||
      el.classList.contains('fact-suggestions-card') ||
      el.classList.contains('skill-suggestions-card')
    ) {
      return null;
    }
    const msgBody = anchorRoot && anchorRoot.closest ? anchorRoot.closest('.msg-body') : null;
    if (!msgBody || !el.contains(msgBody)) return null;
    if (
      anchorRoot?.closest('.iclaw-secret-chip, .iclaw-secret-revealed') ||
      focusRoot?.closest('.iclaw-secret-chip, .iclaw-secret-revealed')
    ) {
      return null;
    }
    const roleEl = el.querySelector('.role');
    const role = (roleEl && roleEl.textContent ? roleEl.textContent : '').trim();
    if (role !== 'user' && role !== 'assistant') return null;
    const messageId = Number(el.dataset.msgId);
    if (!Number.isFinite(messageId)) return null;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const selection = raw.length > 32768 ? raw.slice(0, 32768) : raw;
    return { messageId, quote, rect, role, selection };
  }

  function applyMessageContentToEl(msgEl, content) {
    const body = msgEl.querySelector('.msg-body');
    if (!body) return;
    body.innerHTML = renderMessageHtml(content || '');
    decorateMessageBody(body);
  }

  selectionReplyFab.addEventListener('mousedown', (e) => {
    e.preventDefault();
  });
  selectionReplyFab.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-selection-action]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const action = btn.getAttribute('data-selection-action');
    const mid = Number(selectionReplyFab.dataset.pendingMsgId);
    const quote = selectionReplyFab.dataset.pendingQuote || '';
    const role = selectionReplyFab.dataset.pendingRole || '';
    const selection = selectionReplyFab.dataset.pendingSelection || '';
    hideSelectionReplyFab();
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    if (action === 'reply') {
      if (Number.isFinite(mid) && quote) {
        pendingComposerReply = { messageId: mid, quote, role };
        updateComposerReplyBar();
        input?.focus();
      }
      return;
    }
    if (action === 'hide-secret') {
      if (!composerSecretsEnabled()) {
        alert(composerSecretsBlockedMessage());
        return;
      }
      if (!Number.isFinite(mid) || !selection.trim()) return;
      composerSecretRedactMessageId = mid;
      composerSecretInsert = { start: 0, end: 0, plain: selection };
      openComposerSecretModal((label) => applyMessageSecretRedact(label));
    }
  });

  document.addEventListener('mouseup', () => {
    requestAnimationFrame(() => {
      const ctx = getReplySelectionContext();
      if (!ctx) {
        hideSelectionReplyFab();
        return;
      }
      const fabW = selectionReplyFab.offsetWidth || 120;
      const fabH = selectionReplyFab.offsetHeight || 40;
      const gap = 6;
      /** Center under selection horizontally; `translate(-50%, …)` in CSS aligns to this point. */
      let x = ctx.rect.left + ctx.rect.width / 2;
      /** Anchor Y = top of selection; CSS `translateY(-100%)` places the pill just above this line. */
      let anchorY = ctx.rect.top;
      const minAnchorY = fabH + gap + 8;
      if (anchorY < minAnchorY) anchorY = minAnchorY;
      x = Math.max(8 + fabW / 2, Math.min(x, window.innerWidth - fabW / 2 - 8));
      selectionReplyFab.style.left = x + 'px';
      selectionReplyFab.style.top = anchorY + 'px';
      selectionReplyFab.dataset.pendingMsgId = String(ctx.messageId);
      selectionReplyFab.dataset.pendingQuote = ctx.quote;
      selectionReplyFab.dataset.pendingRole = ctx.role || '';
      selectionReplyFab.dataset.pendingSelection = ctx.selection || '';
      if (selectionHideSecretBtn) {
        selectionHideSecretBtn.hidden = !composerSecretsEnabled();
      }
      selectionReplyFab.hidden = false;
    });
  });

  messagesEl?.addEventListener(
    'scroll',
    () => {
      hideSelectionReplyFab();
    },
    { passive: true },
  );

  function openSidebarSearchPanel() {
    if (!sidebarToolbar || !searchToggleBtn) return;
    sidebarToolbar.classList.add('is-search-open');
    searchToggleBtn.setAttribute('aria-expanded', 'true');
    if (searchInput) requestAnimationFrame(() => searchInput.focus());
  }

  function closeSidebarSearchPanel() {
    if (!sidebarToolbar || !searchToggleBtn) return;
    sidebarToolbar.classList.remove('is-search-open');
    searchToggleBtn.setAttribute('aria-expanded', 'false');
    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }
    if (searchInput) {
      searchInput.value = '';
      searchInput.blur();
    }
    searchMatchSet = null;
    applySidebarSearchFilter();
  }

  if (searchToggleBtn && sidebarToolbar) {
    searchToggleBtn.addEventListener('click', openSidebarSearchPanel);
  }
  if (searchCloseBtn) {
    searchCloseBtn.addEventListener('click', closeSidebarSearchPanel);
  }
  if (searchInput) {
    searchInput.addEventListener('input', scheduleSidebarSearch);
    searchInput.addEventListener('search', () => {
      if (searchInput.value === '') {
        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
        searchDebounceTimer = null;
        searchMatchSet = null;
        applySidebarSearchFilter();
      }
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSidebarSearchPanel();
      }
    });
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
  let wsPingTimer = null;
  const wsUrl = (() => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws';
  })();

  function wsSend(msg) {
    var open = !!(ws && ws.readyState === WebSocket.OPEN);
    if (!open) return false;
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
      // Keep the socket warm. Remote-access tunnels traverse Cloudflare, which
      // drops idle WebSockets after ~100s — including during a long agent turn
      // with gaps between stream frames. The gateway answers 'ping' with 'pong'
      // (both no-ops in the UI), so this is a harmless heartbeat locally too.
      if (wsPingTimer) clearInterval(wsPingTimer);
      wsPingTimer = setInterval(() => { wsSend({ type: 'ping' }); }, 25000);
      if (activeChatId != null) {
        wsSend({ type: 'subscribe', chatId: activeChatId });
        loadPendingFactSuggestions();
        loadPendingSkillSuggestions();
      }
      /* If the socket dropped while we had pending task-create records (or
       * was never up when the server emitted 'ready'), reconcile against the
       * current task list as soon as we're back online. Closes the WS-race
       * leak where the 'ready' broadcast was missed. */
      try {
        reconcilePendingTaskCreatesAfterReconnect();
      } catch {
        /* defensive — never let the open handler throw */
      }
    });
    ws.addEventListener('close', () => {
      if (wsPingTimer) { clearInterval(wsPingTimer); wsPingTimer = null; }
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
          adoptDraftChat(msg);
        } else {
          sidebarUpsertChat({
            id: msg.chatId,
            title: msg.title,
            agent: msg.agent,
            projectId: msg.projectId,
            projectName: msg.projectName,
            updatedAt: msg.updatedAt,
          });
        }
        if (searchInput && searchInput.value.trim()) scheduleSidebarSearch();
        return;

      case 'chat-updated':
        if (
          msg.title != null ||
          msg.projectId !== undefined ||
          msg.updatedAt != null ||
          msg.agent != null ||
          msg.sharesToProject !== undefined
        ) {
          sidebarUpsertChat({
            id: msg.chatId,
            title: msg.title,
            agent: msg.agent,
            projectId: msg.projectId,
            projectName: msg.projectName,
            updatedAt: msg.updatedAt,
          });
        }
        if (msg.chatId === activeChatId && msg.title != null) applyTitleForActive(msg.title);
        // Composer mode changed elsewhere (another tab/device) → mirror it here
        // without re-persisting (avoids a broadcast loop).
        if (msg.chatId === activeChatId && msg.mode !== undefined) {
          setComposerMode(msg.mode, { persist: false });
        }
        if (msg.chatId === activeChatId && msg.projectId !== undefined && messagesEl) {
          messagesEl.dataset.projectId =
            msg.projectId != null && Number.isFinite(Number(msg.projectId))
              ? String(msg.projectId)
              : '';
          syncComposerSecretUi();
        }
        if (searchInput && searchInput.value.trim()) scheduleSidebarSearch();
        syncComposerSecretUi();
        return;

      case 'chat-deleted':
        sidebarRemoveChat(msg.chatId);
        if (msg.chatId === activeChatId) goTo('/');
        return;

      case 'chat-unread':
        setWorkingDot(msg.chatId, false);
        setUnreadDot(msg.chatId, true);
        return;

      case 'chat-read':
        setUnreadDot(msg.chatId, false);
        return;

      case 'message-updated':
        if (msg.chatId !== activeChatId || !messagesEl) return;
        {
          const msgEl = messagesEl.querySelector('.msg[data-msg-id="' + msg.message.id + '"]');
          if (msgEl) applyMessageContentToEl(msgEl, msg.message.content || '');
        }
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
            const pBody = pending.querySelector('.msg-body');
            if (pBody) {
              pBody.innerHTML = renderMessageHtml(msg.message.content || '');
              decorateMessageBody(pBody);
            }
            syncPendingUserReplyPreview(pending, msg.message);
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
            cancelStreamRender(); // final render below is authoritative
            target.classList.remove(
              'streaming', 'stream-waiting', 'stream-tool', 'stream-generating',
            );
            target.dataset.msgId = String(msg.message.id);
            const status = target.querySelector('.stream-status');
            if (status) {
              stopStreamStatusDotAnim(status);
              status.remove();
            }
            const body = target.querySelector('.stream-body, .msg-body');
            if (body) {
              body.classList.remove('stream-body');
              body.innerHTML = renderMarkdown(msg.message.content || '');
              decorateMessageBody(body);
            }
            // Inline images the agent surfaced via show_image. The streaming
            // bubble only built a text body, so append the attachments block here
            // (the non-streaming appendMessage path already includes it). Reload
            // renders them the same way, from msg.attachments.
            if (Array.isArray(msg.message.attachments) && msg.message.attachments.length) {
              target.querySelector('.msg-attachments-finalized')?.remove();
              const wrap = document.createElement('div');
              wrap.className = 'msg-attachments-finalized';
              wrap.innerHTML = attachmentsHtml(msg.message.attachments);
              target.appendChild(wrap);
            }
            // Tool trace (runtime modes): the streaming bubble has no trace
            // block, so attach it on finalize — same as attachments above.
            if (Array.isArray(msg.message.tool_trace) && msg.message.tool_trace.length) {
              target.querySelector('.msg-tool-trace')?.remove();
              target.insertAdjacentHTML('beforeend', toolTraceHtml(msg.message.tool_trace));
            }
            applyTokenBadge(target, msg.message.tokens, msg.message.cached_tokens);
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
        streamShownLen = 0; // fresh typewriter for the new turn
        ensureStreamEl();
        {
          const status = currentStreamEl?.querySelector('.stream-status');
          if (status) {
            status.hidden = false;
            status.classList.remove('detail-expanded', 'has-detail');
            status.removeAttribute('title');
            delete status.dataset.detail;
            delete status.dataset.label;
            setStreamStatusLabel(status, msg.activity?.label || 'Thinking…');
          }
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
          if (status) {
            stopStreamStatusDotAnim(status);
            status.hidden = true;
          }
        }
        // Feed the typewriter — it reveals the accumulated text smoothly,
        // a few chars per frame, instead of dumping each lumpy delta at once.
        ensureTyping();
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
          const keepDetailOpen = status.classList.contains('detail-expanded');
          if (detail) {
            status.dataset.detail = detail;
            status.dataset.label = label;
            status.title = detail;
            status.classList.add('has-detail');
            if (keepDetailOpen) {
              status.classList.add('detail-expanded');
              stopStreamStatusDotAnim(status);
              status.textContent = detail;
            } else {
              status.classList.remove('detail-expanded');
              setStreamStatusLabel(status, label);
            }
          } else {
            status.removeAttribute('title');
            delete status.dataset.detail;
            delete status.dataset.label;
            status.classList.remove('has-detail', 'detail-expanded');
            setStreamStatusLabel(status, label);
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
          setStreamStatusLabel(status, msg.label || msg.phase);
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
        // The first secure turn creates the sandbox host-side; surface the bar
        // as soon as the turn finishes (no-op outside Secure Mode). The fixed
        // retry timers on send can miss a slow container start, so refresh here
        // too rather than wait for a reload.
        refreshSecureBar();
        // Tear down a streaming element that nobody finalized — e.g. an
        // abort with no streamed text (skipPersist on the server → no
        // `message-appended` to clean it up), or any other edge where the
        // turn ends without an assistant message. Without this, the
        // "Finishing…" / "Thinking…" status would sit on the page until
        // the user reloaded.
        cancelStreamRender();
        if (currentStreamEl && currentStreamEl.classList.contains('streaming')) {
          const body = currentStreamEl.querySelector('.stream-body, .msg-body');
          const hasContent = !!(body && body.textContent && body.textContent.trim());
          if (hasContent) {
            currentStreamEl.classList.remove(
              'streaming', 'stream-waiting', 'stream-tool', 'stream-generating',
            );
            const st = currentStreamEl.querySelector('.stream-status');
            if (st) { stopStreamStatusDotAnim(st); st.remove(); }
            body?.classList.remove('stream-body');
          } else {
            currentStreamEl.remove();
          }
          currentStreamEl = null;
        }
        clearStreamArtifacts();
        // Note: the visible "Stopped" indicator is rendered by the
        // persistent system marker row that arrives via `message-appended`
        // (see appendMessage). We keep `msg.aborted` in the protocol but
        // don't render anything ad-hoc here — that would duplicate the
        // marker for aborted turns and (worse) the duplicate would vanish
        // on reload while the persisted marker survives.
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
          const st = currentStreamEl.querySelector('.stream-status');
          stopStreamStatusDotAnim(st);
          currentStreamEl.remove();
          currentStreamEl = null;
        }
        const div = document.createElement('div');
        div.className = 'msg system error';
        div.innerHTML =
          '<div class="role">error</div>' +
          '<div class="msg-body">' + escapeHtml('Error: ' + msg.error) + '</div>';
        messagesAppendRoot()?.appendChild(div);
        setWorkingDot(msg.chatId, false);
        // In-flight already shifted out of waitingItems when flushed.
        inFlight = false;
        if (waitingItems[0]) flushNextQueued();
        return;
      }

      /* ---- incognito (ephemeral; keyed, never persisted) ---- */
      case 'incognito-turn-delta': {
        if (msg.key !== activeIncognitoKey) return;
        const el = ensureStreamEl();
        currentStreamFullText += msg.text;
        if (el.classList.contains('stream-waiting') || el.classList.contains('stream-tool')) {
          el.classList.remove('stream-waiting', 'stream-tool');
          el.classList.add('stream-generating');
          const status = el.querySelector('.stream-status');
          if (status) { stopStreamStatusDotAnim(status); status.hidden = true; }
        }
        ensureTyping();
        return;
      }

      case 'incognito-turn-tool':
        // Tool activity indicator could go here; ignored for now.
        return;

      case 'incognito-error': {
        if (msg.key !== activeIncognitoKey) return;
        const div = document.createElement('div');
        div.className = 'msg system error';
        div.innerHTML =
          '<div class="role">error</div>' +
          '<div class="msg-body">' + escapeHtml('Error: ' + msg.message) + '</div>';
        messagesAppendRoot()?.appendChild(div);
        return;
      }

      case 'incognito-turn-ended': {
        if (msg.key !== activeIncognitoKey) return;
        const finishedEl = currentStreamEl;
        finalizeIncognitoStream();
        applyTokenBadge(finishedEl, msg.tokens, msg.cached);
        return;
      }

      case 'project-fact-suggestions': {
        if (msg.chatId !== activeChatId) return;
        const have = existingFactSuggestionIds();
        const fresh = (msg.suggestions || []).filter((s) => s && !have.has(Number(s.id)));
        if (fresh.length === 0) return;
        appendFactSuggestionsCard({
          projectId: msg.projectId,
          chatId: msg.chatId,
          projectName: typeof msg.projectName === 'string' ? msg.projectName : 'project',
          suggestions: fresh,
        });
        return;
      }

      case 'project-fact-suggestion-removed':
        removeFactSuggestionRow(msg.chatId, msg.suggestionId);
        return;

      case 'project-skill-suggestions': {
        if (msg.chatId !== activeChatId) return;
        const have = existingSkillSuggestionIds();
        const fresh = (msg.suggestions || []).filter((s) => s && !have.has(Number(s.id)));
        if (fresh.length === 0) return;
        appendSkillSuggestionsCard({
          projectId: msg.projectId,
          chatId: msg.chatId,
          projectName: typeof msg.projectName === 'string' ? msg.projectName : 'project',
          suggestions: fresh,
        });
        return;
      }

      case 'project-skill-suggestion-removed':
        removeSkillSuggestionRow(msg.chatId, msg.suggestionId);
        return;

      case 'project-skill-added': {
        if (currentProjectPageId() !== msg.projectId) return;
        const ul = document.getElementById('skills-list');
        if (!ul) return;
        ul.querySelector('li.project-chats-empty')?.remove();
        // Replace if a row with this id already exists (e.g. accept-as-update).
        ul.querySelector('li.skill[data-skill-id="' + msg.skill.id + '"]')?.remove();
        ul.insertBefore(buildSkillLi(msg.skill), ul.firstChild);
        syncProjectSkillsTabCountFromDom();
        return;
      }

      case 'project-skill-updated': {
        if (currentProjectPageId() !== msg.projectId) return;
        const ul = document.getElementById('skills-list');
        if (!ul) return;
        const existing = ul.querySelector('li.skill[data-skill-id="' + msg.skill.id + '"]');
        const fresh = buildSkillLi(msg.skill);
        if (existing) existing.replaceWith(fresh);
        else {
          ul.querySelector('li.project-chats-empty')?.remove();
          ul.insertBefore(fresh, ul.firstChild);
        }
        syncProjectSkillsTabCountFromDom();
        return;
      }

      case 'project-skill-deleted': {
        if (currentProjectPageId() !== msg.projectId) return;
        document
          .querySelector('#skills-list li.skill[data-skill-id="' + msg.skillId + '"]')
          ?.remove();
        const ul = document.getElementById('skills-list');
        if (ul && !ul.querySelector('li.skill')) {
          const empty = document.createElement('li');
          empty.className = 'project-chats-empty muted';
          empty.textContent =
            'No skills yet. Accept a skill suggestion in a chat for this project.';
          ul.appendChild(empty);
        }
        syncProjectSkillsTabCountFromDom();
        return;
      }

      case 'project-created': {
        const arr = window.__ICLAW_PROJECTS__;
        if (Array.isArray(arr)) {
          arr.push({
            id: msg.project.id,
            name: msg.project.name,
            logo_emoji: msg.project.logo_emoji ?? 0,
            logo_color: msg.project.logo_color ?? 0,
          });
        }
        appendProjectsHubRow(msg.project);
        return;
      }

      case 'project-updated': {
        const arr = window.__ICLAW_PROJECTS__;
        const pid = msg.project.id;
        const hasE = msg.project.logo_emoji !== undefined && msg.project.logo_emoji !== null;
        const hasC = msg.project.logo_color !== undefined && msg.project.logo_color !== null;
        if (Array.isArray(arr)) {
          const i = arr.findIndex((p) => p && p.id === pid);
          if (i >= 0) {
            const cur = arr[i];
            arr[i] = {
              id: pid,
              name: msg.project.name != null ? String(msg.project.name) : cur.name,
              logo_emoji: hasE ? clampLogoEmojiJs(Number(msg.project.logo_emoji)) : cur.logo_emoji,
              logo_color: hasC ? clampLogoColorJs(Number(msg.project.logo_color)) : cur.logo_color,
            };
          } else {
            arr.push({
              id: pid,
              name: msg.project.name != null ? String(msg.project.name) : 'Project',
              logo_emoji: hasE ? clampLogoEmojiJs(Number(msg.project.logo_emoji)) : 0,
              logo_color: hasC ? clampLogoColorJs(Number(msg.project.logo_color)) : 0,
            });
          }
        }
        document.querySelectorAll('.chat-item[data-project-id="' + pid + '"]').forEach((a) => {
          syncChatItemProjectMark(a);
        });
        if (currentProjectPageId() === pid && (hasE || hasC)) {
          const tr = document.querySelector('.project-logo-trigger .project-logo');
          const cur2 = tr ? readLogoFromEl(tr) : { ei: 0, ci: 0 };
          syncProjectPageHeaderLogo(
            hasE ? clampLogoEmojiJs(Number(msg.project.logo_emoji)) : cur2.ei,
            hasC ? clampLogoColorJs(Number(msg.project.logo_color)) : cur2.ci,
          );
        }
        updateProjectsHubRow(msg.project);
        sortProjectsHubRows();
        return;
      }

      case 'project-deleted': {
        const pid = msg.projectId;
        const list = document.getElementById('chat-list');
        list?.querySelectorAll('.chat-item[data-project-id="' + pid + '"]').forEach((a) => {
          a.dataset.projectId = '';
          syncChatItemProjectMark(a);
        });
        window.__ICLAW_PROJECTS__ = (window.__ICLAW_PROJECTS__ || []).filter((p) => p && p.id !== pid);
        removeProjectsHubRow(pid);
        if (currentProjectPageId() === pid) goTo('/projects');
        return;
      }

      case 'project-fact-added': {
        if (currentProjectPageId() !== msg.projectId) return;
        const ul = document.getElementById('facts-list');
        if (!ul) return;
        ul.querySelector('li.project-chats-empty')?.remove();
        ul.appendChild(buildFactLi(msg.fact));
        syncProjectMemoryTabCountFromDom();
        return;
      }

      case 'project-fact-updated': {
        if (currentProjectPageId() !== msg.projectId) return;
        const li = document.querySelector('#facts-list li.fact[data-fact-id="' + msg.fact.id + '"]');
        const ta = li?.querySelector('.fact-content');
        if (ta) {
          ta.value = msg.fact.content;
          ta.dataset.saved = msg.fact.content.trim();
        }
        return;
      }

      case 'project-fact-deleted': {
        if (currentProjectPageId() !== msg.projectId) return;
        document.querySelector('#facts-list li.fact[data-fact-id="' + msg.factId + '"]')?.remove();
        const ul = document.getElementById('facts-list');
        if (ul && !ul.querySelector('li.fact')) {
          const empty = document.createElement('li');
          empty.className = 'project-chats-empty muted';
          empty.textContent =
            'No facts yet. Accept a suggestion in a chat for this project.';
          ul.appendChild(empty);
        }
        syncProjectMemoryTabCountFromDom();
        return;
      }

      case 'project-secret-added': {
        if (currentProjectPageId() !== msg.projectId) return;
        const ul = document.getElementById('secrets-list');
        if (!ul) return;
        ul.querySelector('.project-chats-empty')?.remove();
        ul.insertBefore(buildProjectSecretRowLi(msg.secret), ul.firstChild);
        syncProjectSecretsTabCountFromDom();
        return;
      }

      case 'project-facts-synced': {
        if (currentProjectPageId() !== msg.projectId) return;
        const ul = document.getElementById('facts-list');
        if (!ul) return;
        ul.replaceChildren();
        for (let i = 0; i < msg.facts.length; i++) {
          ul.appendChild(buildFactLi(msg.facts[i]));
        }
        if (msg.facts.length === 0) {
          const empty = document.createElement('li');
          empty.className = 'project-chats-empty muted';
          empty.textContent =
            'No facts yet. Accept a suggestion in a chat for this project.';
          ul.appendChild(empty);
        }
        syncProjectMemoryTabCountFromDom();
        return;
      }

      case 'scheduled-added': {
        if (msg.chatId === activeChatId) {
          renderScheduledItem(msg.scheduled);
          syncScheduledSidebarForChat(msg.chatId);
        } else {
          bumpScheduledPending(msg.chatId, 1);
        }
        return;
      }

      case 'scheduled-updated': {
        if (msg.chatId !== activeChatId) return;
        updateScheduledItem(msg.scheduled);
        return;
      }

      case 'scheduled-deleted': {
        if (msg.chatId === activeChatId) {
          removeScheduledItem(msg.scheduledId);
          syncScheduledSidebarForChat(msg.chatId);
        } else {
          bumpScheduledPending(msg.chatId, -1);
        }
        return;
      }

      case 'queue-added': {
        if (msg.chatId !== activeChatId) return;
        if (addWaitingItem(serverQueueItemFromApi(msg.item))) renderQueue();
        return;
      }

      case 'queue-deleted': {
        if (msg.chatId !== activeChatId) return;
        const qIdx = waitingItems.findIndex((it) => it.serverId === msg.queueId);
        if (qIdx >= 0) {
          waitingItems.splice(qIdx, 1);
          renderQueue();
        }
        return;
      }

      case 'queue-reordered': {
        if (msg.chatId !== activeChatId) return;
        replaceWaitingItemsFromServer(msg.queue);
        return;
      }

      case 'exec-approval-requested': {
        if (msg.chatId !== activeChatId) return;
        renderApprovalCard({
          approvalId: msg.approvalId,
          command: msg.command,
          cwd: msg.cwd,
          reason: msg.reason,
          host: msg.host,
        });
        return;
      }

      case 'exec-approval-resolved': {
        if (msg.chatId !== 0 && msg.chatId !== activeChatId) return;
        removeApprovalCard(msg.approvalId, msg.decision);
        return;
      }

      case 'gateway-session-changed':
        // Informational — for now we don't auto-refetch the sidebar. Logging
        // this lets future iterations decide what to do without changing the
        // wire protocol again.
        console.debug('[iclaw] gateway-session-changed', msg.kind, msg.sessionKey);
        return;

      case 'task-ask-turn-started':
      case 'task-ask-turn-delta':
      case 'task-ask-turn-tool':
      case 'task-ask-turn-lifecycle':
      case 'task-ask-turn-ended':
      case 'task-ask-turn-error':
        handleTaskAskWs(msg);
        return;

      case 'task-run-delta': {
        const taskRoot = document.querySelector('.task-page[data-task-id]');
        if (!taskRoot || Number(taskRoot.dataset.taskId) !== msg.taskId) return;
        const logEl = document.getElementById('task-execution-log');
        if (!logEl) return;
        const emptyEl = logEl.querySelector('.task-log-empty');
        if (emptyEl) emptyEl.remove();
        const last = logEl.querySelector('.task-log-entry--assistant:last-child .task-log-entry-body');
        if (last) appendTaskLogMarkdown(last, msg.text);
        else {
          const article = document.createElement('article');
          article.className = 'task-log-entry task-log-entry--assistant';
          article.innerHTML =
            '<header class="task-log-entry-head">assistant</header>' +
            '<div class="task-log-entry-body task-md msg-body"></div>';
          const body = article.querySelector('.task-log-entry-body');
          appendTaskLogMarkdown(body, msg.text);
          logEl.appendChild(article);
        }
        logEl.scrollTop = logEl.scrollHeight;
        return;
      }

      case 'task-run-ended': {
        const taskRoot = document.querySelector('.task-page[data-task-id]');
        if (!taskRoot || Number(taskRoot.dataset.taskId) !== msg.taskId) return;
        window.location.reload();
        return;
      }

      case 'task-updated':
        if (document.getElementById('task-board')) refreshGlobalTasksBoard();
        if (msg.task) {
          finishPendingTaskCreateWhenReady(msg.task);
          applyTaskDetailRemoteTask(msg.task);
        }
        void refreshTasksNavSignals();
        return;

      case 'task-created':
        if (msg.task?.status === 'ready') finishPendingTaskCreateFromWs(msg.task);
        void refreshTasksNavSignals();
        return;

      case 'task-deleted':
        if (document.getElementById('task-board')) void refreshGlobalTasksBoard();
        void refreshTasksNavSignals();
        return;

      case 'gateway-status':
        applyGatewayStatus(msg.status, msg.detail);
        return;
    }
  }

  /**
   * Live mirror of the OpenClaw gateway badge — the EJS-rendered snapshot is
   * only true at page load. After a `gateway-status` push (health/shutdown/
   * reconnect) we update the existing chip in place so users see when the
   * gateway is unhealthy without needing F5.
   */
  const gatewayBanner = document.getElementById('sidebar-gateway-banner');
  const gatewayBannerStatus = document.getElementById('sidebar-gateway-status');
  const gatewayBannerStart = document.getElementById('sidebar-gateway-start');
  let gatewayStatusPollTimer = null;

  function setGatewayOffline(offline) {
    gatewayOffline = offline;
    refreshGatewayOfflineBanner();
  }

  /**
   * Show the "Start OpenClaw" banner only when the gateway is offline AND the
   * user actually wants Full Power. Work / Safe work / Incognito run on the
   * iclaw-runtime and never touch the gateway, so nudging them to start it is
   * just noise — same `execute` gate the composer overlay uses. Queries the DOM
   * directly (not the closure const) so it's safe to call from the early
   * mode-change funnel before the gateway-banner const is initialised.
   */
  function refreshGatewayOfflineBanner() {
    const banner = document.getElementById('sidebar-gateway-banner');
    if (!banner) return;
    banner.hidden = !(gatewayOffline && getComposerMode() === 'execute');
  }

  function applyGatewayStatus(status, detail) {
    // "degraded" (gateway answered /health but the WS RPC can't get through)
    // gets its own in-page banner on the home/projects pages, so the sidebar
    // "Start OpenClaw" banner is reserved for a genuinely-offline gateway —
    // there's nothing to "start" when it's already running.
    const offline = status === 'down' || status === 'shutdown';
    setGatewayOffline(offline);

    // Keep Full Power gating current on every page.
    gatewayOk = status === 'ok';
    if (typeof syncExecuteAvailability === 'function') syncExecuteAvailability();
  }

  (function initGatewayOfflineBanner() {
    // Only a genuinely-offline gateway shows the sidebar "Start OpenClaw" banner.
    // "degraded" is handled by the in-page banner instead.
    if (!gatewayBanner) return;
    void fetch('/api/gateway/status', { headers: { Accept: 'application/json' } })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && data.up !== true) setGatewayOffline(true);
      })
      .catch(() => {});
  })();

  // ── Connect-a-model chooser ───────────────────────────────────────────────
  // Shown when someone who skipped onboarding (no OpenRouter key, no reachable
  // OpenClaw) actually tries to send — re-offers the onboarding choice instead
  // of a dead end. The submit handler calls openConnectChooser(); this is a
  // function declaration so it's callable regardless of definition order.
  function openConnectChooser() {
    const modal = document.getElementById('connect-modal');
    if (modal) modal.hidden = false;
  }
  (function initConnectChooser() {
    const modal = document.getElementById('connect-modal');
    if (!modal) return;
    const close = () => { modal.hidden = true; };
    modal.querySelectorAll('[data-connect-close]').forEach((el) => {
      el.addEventListener('click', close);
    });
    const pick = document.getElementById('connect-pick-openrouter');
    if (pick) pick.addEventListener('click', () => { window.location.href = '/welcome'; });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) close();
    });
  })();

  function stopGatewayStatusPoll() {
    if (gatewayStatusPollTimer != null) {
      clearInterval(gatewayStatusPollTimer);
      gatewayStatusPollTimer = null;
    }
  }

  function startGatewayStatusPoll(onReady) {
    stopGatewayStatusPoll();
    const deadline = Date.now() + 90_000;
    gatewayStatusPollTimer = setInterval(async () => {
      if (Date.now() > deadline) {
        stopGatewayStatusPoll();
        if (gatewayBannerStatus) {
          gatewayBannerStatus.textContent = 'Still starting — almost there';
        }
        if (gatewayBannerStart) {
          gatewayBannerStart.disabled = false;
          gatewayBannerStart.textContent = 'Start OpenClaw';
        }
        return;
      }
      try {
        const res = await fetch('/api/gateway/status', {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data.up === true) {
          stopGatewayStatusPoll();
          onReady();
        }
      } catch {
        /* retry */
      }
    }, 1500);
  }

  if (gatewayBannerStart) {
    gatewayBannerStart.addEventListener('click', async () => {
      if (gatewayBannerStart.disabled) return;
      const prevLabel = gatewayBannerStart.textContent;
      gatewayBannerStart.disabled = true;
      gatewayBannerStart.textContent = 'Starting…';
      if (gatewayBannerStatus) {
        gatewayBannerStatus.textContent = 'You can keep chatting';
      }
      try {
        const res = await fetch('/api/gateway/start', {
          method: 'POST',
          headers: { Accept: 'application/json' },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || 'HTTP ' + res.status);
        }
        if (data.ready === true) {
          applyGatewayStatus('ok', null);
          window.location.reload();
          return;
        }
        if (gatewayBannerStatus) {
          gatewayBannerStatus.textContent = 'Starting — almost there';
        }
        startGatewayStatusPoll(() => {
          applyGatewayStatus('ok', null);
          window.location.reload();
        });
      } catch (err) {
        stopGatewayStatusPoll();
        const msg = err instanceof Error ? err.message : String(err);
        if (gatewayBannerStatus) {
          gatewayBannerStatus.textContent = msg;
        }
        gatewayBannerStart.disabled = false;
        gatewayBannerStart.textContent = prevLabel || 'Start OpenClaw';
      }
    });
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
    if (item.serverId != null) ownQueueIds.delete(item.serverId);
    renderQueue();
    inFlight = true;

    // Incognito: ephemeral turn — render locally, stream over `incognito-*`
    // events, never persist. No pending-id (no message-appended adopts it) and
    // no server chat is created.
    if (item.mode === 'incognito') {
      if (!activeIncognitoKey) activeIncognitoKey = newIncognitoKey();
      appendMessage({ role: 'user', content: item.content, mode: 'incognito' });
      currentStreamFullText = '';
      streamShownLen = 0;
      currentStreamEl = ensureStreamEl();
      setStopVisible(true);
      const wf = (typeof getWorkFolders === 'function' ? getWorkFolders() : [])
        .map((f) => ({ path: f.path, readonly: true }));
      const ok = wsSend({
        type: 'incognito-send',
        key: activeIncognitoKey,
        requestId: 'r-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        content: item.content,
        workFolders: wf.length ? wf : undefined,
      });
      if (!ok) {
        inFlight = false;
        addWaitingItem(item, { at: 'front' });
        renderQueue();
      }
      return;
    }

    // Optimistically append user msg. Mark it as pending-id so the
    // upcoming `message-appended` for the same user msg adopts this node
    // instead of duplicating.
    const optimistic = { role: 'user', content: item.content, mode: item.mode };
    if (item.replyTo) {
      optimistic.reply_to_message_id = item.replyTo.messageId;
      optimistic.reply_quote = item.replyTo.quote;
      if (item.replyTo.role) optimistic.reply_to_role = item.replyTo.role;
    }
    // Optimistic attachment previews use the in-memory data URLs we just
    // generated so the user sees the image immediately — the server replaces
    // them with proper `/uploads/...` URLs in the `message-appended` event.
    if (item.attachments && item.attachments.length > 0) {
      optimistic.attachments = item.attachments.map((a) => ({
        url: a.dataUrl,
        mimeType: a.mimeType,
        fileName: a.fileName,
        sizeBytes: a.sizeBytes,
      }));
    }
    appendMessage(optimistic, { pendingId: true });
    currentStreamFullText = '';
    streamShownLen = 0;
    currentStreamEl = ensureStreamEl();
    const payload = {
      type: 'send',
      requestId: 'r-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      content: item.content,
    };
    if (item.mode) payload.mode = item.mode;
    if (item.mode === 'work') {
      const wf = getWorkFolders ? getWorkFolders() : [];
      if (wf.length > 0) {
        payload.workFolders = wf.map((f) => ({ path: f.path, readonly: !f.write }));
      }
    }
    if (item.mode === 'secure') {
      payload.networkEnabled = typeof getNetworkEnabled === 'function' ? getNetworkEnabled() : false;
      // Reset TTL countdown on each message + send TTL to runtime
      if (typeof saveSecureTtl === 'function') {
        const cur = getSecureTtl();
        payload.ttlDays = cur.ttlDays;
        saveSecureTtl(cur.ttlDays);
        // Session is created host-side during this turn; re-check a few times
        // so the bar appears as soon as it exists (not before the first message).
        [250, 800, 1600, 3000].forEach((d) => setTimeout(refreshSecureBar, d));
      }
    }
    if (item.replyTo) {
      payload.replyTo = {
        messageId: item.replyTo.messageId,
        quote: item.replyTo.quote,
      };
      if (item.replyTo.role) payload.replyTo.role = item.replyTo.role;
    }
    if (item.attachments && item.attachments.length > 0) {
      payload.attachments = item.attachments.map((a) => ({
        mimeType: a.mimeType,
        fileName: a.fileName,
        content: a.base64,
      }));
    }
    if (item.inlineSecrets && item.inlineSecrets.length > 0) {
      payload.inlineSecrets = item.inlineSecrets;
    }
    if (item.serverId != null && activeChatId != null) {
      const requestId = payload.requestId;
      fetch(
        '/chats/' +
          encodeURIComponent(activeChatId) +
          '/queue/' +
          encodeURIComponent(item.serverId) +
          '/flush',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ requestId }),
        },
      )
        .then((res) => {
          if (!res.ok) {
            return res.json().then((data) => {
              throw new Error(data.error || res.statusText);
            });
          }
        })
        .catch(async () => {
          inFlight = false;
          if (activeChatId != null) {
            try {
              addWaitingItem(await enqueueQueueOnServer(activeChatId, item), { at: 'front' });
            } catch {
              addWaitingItem(item, { at: 'front' });
            }
          } else {
            addWaitingItem(item, { at: 'front' });
          }
          renderQueue();
        });
      return;
    }

    if (activeChatId != null) payload.chatId = activeChatId;
    else {
      payload.agent = draftAgentSelect?.value || 'openclaw/default';
      if (draftChosenProjectId != null && Number.isFinite(draftChosenProjectId)) {
        payload.projectId = draftChosenProjectId;
      }
    }
    if (!wsSend(payload)) {
      // No connection — put the item back at the head so it isn't lost,
      // and let the open handler retry.
      inFlight = false;
      addWaitingItem(item, { at: 'front' });
      renderQueue();
    }
  }

  /**
   * Shift+Enter on a line like "1. …" at end-of-line inserts "\n2. " (keeps indent).
   * Plain Enter still submits the composer.
   * @param {HTMLTextAreaElement} ta
   */
  function maybeContinueOrderedList(ta) {
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (start !== end) return false;
    const text = ta.value;
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const nextNl = text.indexOf('\n', start);
    const atLineEnd = nextNl === -1 ? start === text.length : start === nextNl;
    if (!atLineEnd) return false;
    const lineText = text.slice(lineStart, start);
    const m = /^(\s*)(\d+)\.\s*(.*)$/.exec(lineText);
    if (!m) return false;
    const n = parseInt(m[2], 10);
    if (!Number.isFinite(n) || n < 1 || n > 999) return false;
    const indent = m[1];
    const insert = '\n' + indent + (n + 1) + '. ';
    ta.value = text.slice(0, start) + insert + text.slice(start);
    const pos = start + insert.length;
    ta.setSelectionRange(pos, pos);
    return true;
  }

  function updateComposerReplyBar() {
    if (!composerReplyBar || !composerReplyText) return;
    if (pendingComposerReply && pendingComposerReply.quote) {
      if (composerReplyMeta) {
        const r = pendingComposerReply.role;
        composerReplyMeta.textContent =
          r === 'user' ? 'You' : r === 'assistant' ? 'Assistant' : 'Chat';
      }
      composerReplyText.textContent = pendingComposerReply.quote;
      composerReplyBar.hidden = false;
    } else {
      composerReplyBar.hidden = true;
      composerReplyText.textContent = '';
      if (composerReplyMeta) composerReplyMeta.textContent = '';
    }
  }

  if (composerReplyClearBtn) {
    composerReplyClearBtn.addEventListener('click', () => {
      pendingComposerReply = null;
      updateComposerReplyBar();
    });
  }

  // -------------------------------------------------------------------------
  // composer attachments (drag-drop, paste, paperclip → inline base64)
  // -------------------------------------------------------------------------
  /** Per-file size cap mirrors the gateway default (`agents.defaults.mediaMaxMb`). */
  const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
  /** UI sanity cap — server enforces the same number. */
  const ATTACHMENT_MAX_COUNT = 25;
  /** Same blacklist as the OpenClaw dashboard — videos are pushed through other channels. */
  const ATTACHMENT_VIDEO_EXT_RE = /\.(?:avi|m4v|mov|mp4|mpeg|mpg|webm)$/i;
  /** Each entry: { id, file, dataUrl, base64, mimeType, fileName, sizeBytes }. */
  let pendingAttachments = [];
  let attachmentSeq = 0;

  /** True when the file is acceptable. Same predicate as dashboard's `QC`. */
  function isSupportedAttachment(file) {
    if (file.type && file.type.startsWith('video/')) return false;
    if (file.name && ATTACHMENT_VIDEO_EXT_RE.test(file.name)) return false;
    return true;
  }

  function humanSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function renderAttachmentChips() {
    if (!attachmentsBar) return;
    if (pendingAttachments.length === 0) {
      attachmentsBar.innerHTML = '';
      attachmentsBar.hidden = true;
      return;
    }
    attachmentsBar.hidden = false;
    const html = pendingAttachments
      .map((a) => {
        const isImage = a.mimeType && a.mimeType.startsWith('image/');
        const name = escapeHtml(a.fileName);
        const size = escapeHtml(humanSize(a.sizeBytes));
        const thumb = isImage
          ? '<img class="composer-attachment-chip-thumb" src="' +
            escapeHtml(a.dataUrl) +
            '" alt="" />'
          : '';
        return (
          '<span class="composer-attachment-chip' +
          (isImage ? ' is-image' : '') +
          '" data-att-id="' +
          a.id +
          '">' +
          thumb +
          '<span class="composer-attachment-chip-name" title="' +
          name +
          ' (' +
          size +
          ')">' +
          name +
          '</span>' +
          '<button type="button" class="composer-attachment-chip-remove" data-att-remove="' +
          a.id +
          '" aria-label="Remove">×</button>' +
          '</span>'
        );
      })
      .join('');
    attachmentsBar.innerHTML = html;
  }

  /** Read a File into a base64 data URL via FileReader (matches dashboard's BF). */
  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(String(reader.result || '')));
      reader.addEventListener('error', () => reject(reader.error || new Error('read failed')));
      reader.readAsDataURL(file);
    });
  }

  /**
   * Parse `data:[meta],payload` in O(n) time. Avoids `/…,(.*)$/.exec()` on
   * multi‑MB screenshots — that pattern can blow the regex stack / RangeError
   * in browsers when the payload is huge.
   */
  function splitDataUrlParts(dataUrl) {
    const s = String(dataUrl || '');
    if (!s.startsWith('data:')) {
      return { mime: '', base64: s };
    }
    const comma = s.indexOf(',', 5);
    if (comma === -1) {
      return { mime: '', base64: '' };
    }
    const meta = s.slice(5, comma);
    const base64 = s.slice(comma + 1);
    const semi = meta.indexOf(';');
    const mime = (semi === -1 ? meta : meta.slice(0, semi)).trim();
    return { mime, base64 };
  }

  async function addFilesToPending(files) {
    if (!files || files.length === 0) return;
    const accepted = [];
    for (const f of files) {
      if (!isSupportedAttachment(f)) continue;
      if (f.size > ATTACHMENT_MAX_BYTES) continue;
      accepted.push(f);
    }
    if (accepted.length === 0) return;
    const slotsLeft = Math.max(0, ATTACHMENT_MAX_COUNT - pendingAttachments.length);
    const toRead = accepted.slice(0, slotsLeft);
    for (const file of toRead) {
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const parts = splitDataUrlParts(dataUrl);
        const base64 = parts.base64;
        const sniffedMime = parts.mime || '';
        pendingAttachments.push({
          id: 'att-' + ++attachmentSeq,
          file,
          dataUrl,
          base64,
          mimeType: file.type || sniffedMime || 'application/octet-stream',
          fileName: file.name || 'attachment',
          sizeBytes: file.size,
        });
      } catch {
        // Silently skip files that fail to read.
      }
    }
    renderAttachmentChips();
  }

  function removePendingAttachment(id) {
    pendingAttachments = pendingAttachments.filter((a) => a.id !== id);
    renderAttachmentChips();
  }

  function clearPendingAttachments() {
    pendingAttachments = [];
    renderAttachmentChips();
  }

  if (attachmentsBar) {
    attachmentsBar.addEventListener('click', (e) => {
      const t = e.target;
      if (t && t.matches && t.matches('[data-att-remove]')) {
        removePendingAttachment(t.getAttribute('data-att-remove'));
      }
    });
  }
  const composerAttachMenu = document.getElementById('composer-attach-menu');
  const composerSecretPickMenu = document.getElementById('composer-secret-pick-menu');
  let composerAttachMenuOpen = false;

  function buildStoredSecretPlaceholder(id, label, valueLength) {
    const enc = encodeURIComponent(String(label || ''));
    const len = Number(valueLength) || 0;
    return '[[iclaw:secret:' + id + '|' + enc + '|' + len + ']]';
  }

  function insertTextAtComposerCursor(text) {
    if (!input) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const v = input.value;
    input.value = v.slice(0, start) + text + v.slice(end);
    const pos = start + text.length;
    input.setSelectionRange(pos, pos);
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    scheduleTokenDetect();
    applyComposerSecretStripLayout();
  }

  function closeComposerAttachMenus() {
    if (composerAttachMenu) composerAttachMenu.hidden = true;
    if (composerSecretPickMenu) composerSecretPickMenu.hidden = true;
    composerAttachMenuOpen = false;
    if (attachBtn) attachBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onComposerAttachOutside, true);
  }

  function openComposerAttachMenu() {
    if (!composerAttachMenu) return;
    closeScheduleMenu();
    if (composerSecretPickMenu) composerSecretPickMenu.hidden = true;
    composerAttachMenu.hidden = false;
    composerAttachMenuOpen = true;
    if (attachBtn) attachBtn.setAttribute('aria-expanded', 'true');
    setTimeout(() => document.addEventListener('pointerdown', onComposerAttachOutside, true), 0);
  }

  function onComposerAttachOutside(ev) {
    const t = ev.target;
    if (attachBtn && attachBtn.contains(t)) return;
    if (composerAttachMenu && composerAttachMenu.contains(t)) return;
    if (composerSecretPickMenu && composerSecretPickMenu.contains(t)) return;
    closeComposerAttachMenus();
  }

  function secretPickSubtitleText(s) {
    const project = String(s.project_name ?? '').trim() || 'No project';
    const chat = String(s.chat_title ?? '').trim() || 'Chat';
    return project + ' | ' + chat;
  }

  function secretPickItemHtml(s) {
    const id = Number(s.id);
    const label = escapeHtml(String(s.label || ''));
    const subtitle = secretPickSubtitleText(s);
    const subtitleAttr = escapeHtml(subtitle);
    return (
      '<button type="button" class="menu-item composer-secret-pick-item" data-secret-id="' +
      id +
      '" role="menuitem">' +
      '<span class="menu-item__title composer-secret-pick-label">' +
      label +
      '</span>' +
      '<span class="composer-secret-pick-subtitle" title="' +
      subtitleAttr +
      '">' +
      escapeHtml(subtitle) +
      '</span>' +
      '</button>'
    );
  }

  function renderComposerSecretPickMenu(data) {
    if (!composerSecretPickMenu) return;
    const sections = Array.isArray(data?.sections) ? data.sections : [];
    let total = 0;
    for (const sec of sections) {
      if (Array.isArray(sec?.items)) total += sec.items.length;
    }
    let html =
      '<button type="button" class="menu-item composer-secret-pick-back" data-secret-pick="back">← Back</button>';
    if (total === 0) {
      html += '<div class="composer-secret-pick-empty">No saved secrets.</div>';
    } else {
      for (const sec of sections) {
        const items = Array.isArray(sec?.items) ? sec.items : [];
        if (items.length === 0) continue;
        const label = String(sec.label ?? '').trim();
        if (label) {
          html += '<div class="menu-section-label">' + escapeHtml(label) + '</div>';
        }
        for (const s of items) html += secretPickItemHtml(s);
      }
    }
    composerSecretPickMenu.innerHTML = html;
  }

  async function openComposerSecretPickMenu() {
    if (!composerSecretPickMenu) return;
    const ctx = composerSecretContext();
    if (!ctx) {
      alert(composerSecretsBlockedMessage());
      return;
    }
    if (composerAttachMenu) composerAttachMenu.hidden = true;
    composerSecretPickMenu.hidden = false;
    composerSecretPickMenu.innerHTML =
      '<button type="button" class="menu-item composer-secret-pick-back" data-secret-pick="back">← Back</button>' +
      '<div class="composer-secret-pick-empty">Loading…</div>';
    try {
      const res = await fetch(ctx.pickerUrl, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      renderComposerSecretPickMenu(data);
    } catch {
      composerSecretPickMenu.innerHTML =
        '<button type="button" class="menu-item composer-secret-pick-back" data-secret-pick="back">← Back</button>' +
        '<div class="composer-secret-pick-empty">Could not load secrets.</div>';
    }
  }

  async function useComposerSecretInChat(secretId) {
    const ctx = composerSecretContext();
    if (!ctx) return null;
    const res = await fetch(ctx.useInChatUrl(secretId), {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(t || 'HTTP ' + res.status);
    }
    return res.json();
  }

  if (composerAttachMenu) {
    composerAttachMenu.addEventListener('click', (e) => {
      const pick = e.target.closest('[data-attach-pick]')?.getAttribute('data-attach-pick');
      if (pick === 'file') {
        closeComposerAttachMenus();
        if (fileInput) fileInput.click();
        return;
      }
      if (pick === 'secret') void openComposerSecretPickMenu();
    });
  }
  if (composerSecretPickMenu) {
    composerSecretPickMenu.addEventListener('click', (e) => {
      if (e.target.closest('[data-secret-pick="back"]')) {
        composerSecretPickMenu.hidden = true;
        if (composerAttachMenu) composerAttachMenu.hidden = false;
        return;
      }
      const item = e.target.closest('.composer-secret-pick-item');
      if (!item) return;
      const sid = Number(item.getAttribute('data-secret-id'));
      if (!Number.isFinite(sid)) return;
      closeComposerAttachMenus();
      void useComposerSecretInChat(sid)
        .then((row) => {
          if (!row) return;
          insertTextAtComposerCursor(
            buildStoredSecretPlaceholder(row.id, row.label, row.value_length),
          );
        })
        .catch((err) => {
          alert(err && err.message ? err.message : 'Could not add secret');
        });
    });
  }
  if (attachBtn && fileInput) {
    attachBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (composerAttachMenuOpen) closeComposerAttachMenus();
      else openComposerAttachMenu();
    });
    fileInput.addEventListener('change', () => {
      addFilesToPending(Array.from(fileInput.files || []));
      // Allow re-selecting the same file later.
      fileInput.value = '';
    });
  }
  if (form) {
    // Dragging a file anywhere over the page surfaces a Telegram-style
    // drop-zone over the composer. We track dragenter/dragleave at the
    // document level (depth-counted because both fire repeatedly as the
    // pointer crosses child boundaries), and we ONLY accept the drop if it
    // lands on the form.
    let dragDepth = 0;
    function hasFiles(e) {
      return !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
    }
    document.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      dragDepth++;
      form.classList.add('is-drag-over');
    });
    document.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      // preventDefault so the browser doesn't open the file when it falls
      // outside the form — and so the form sees a 'copy' cursor.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) form.classList.remove('is-drag-over');
    });
    document.addEventListener('drop', (e) => {
      // Always clear the overlay on drop, regardless of target.
      dragDepth = 0;
      form.classList.remove('is-drag-over');
      // Outside the form → don't pick up the file. Inside → handle it.
      const inForm = e.target instanceof Node && form.contains(e.target);
      if (!inForm) return;
      if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
      e.preventDefault();
      addFilesToPending(Array.from(e.dataTransfer.files));
    });
  }
  if (input) {
    input.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length === 0) return;
      e.preventDefault();
      addFilesToPending(files);
    });
  }

  const composerSecretUi = document.getElementById('composer-secret-ui');
  const composerTokenHint = document.getElementById('composer-token-hint');
  const composerTokenHintText = document.getElementById('composer-token-hint-text');
  const composerSelectionHint = document.getElementById('composer-selection-hint');
  const composerTokenSaveBtn = document.getElementById('composer-token-save-btn');
  const composerMarkSecretBtn = document.getElementById('composer-mark-secret-btn');
  const composerSecretModal = document.getElementById('composer-secret-modal');
  const composerSecretBackdrop = document.getElementById('composer-secret-modal-backdrop');
  const composerSecretLabelInput = document.getElementById('composer-secret-label-input');
  const composerSecretValuePreview = document.getElementById('composer-secret-value-preview');
  const composerSecretValueInput = document.getElementById('composer-secret-value-input');
  const composerSecretTokenToggle = document.getElementById('composer-secret-token-toggle');
  const composerSecretOk = document.getElementById('composer-secret-ok');
  let composerSecretTokenEditing = false;
  let composerSelectionHintTimer = null;
  /** After a 300ms delay, the selection hint row may be shown. */
  let composerSelectionHintRevealed = false;
  const COMPOSER_SELECTION_HINT_DELAY_MS = 300;

  /** @type {((label: string) => void) | null} */
  let composerSecretCommit = null;
  /** @type {{ start: number; end: number; plain: string } | null} */
  let composerSecretInsert = null;
  /** When set, the secret modal redacts this message instead of the composer draft. */
  let composerSecretRedactMessageId = null;

  function syncComposerSecretUi() {
    applyComposerSecretStripLayout();
  }

  /** Non-empty, non-whitespace selection in the composer (for "mark as secret"). */
  function composerHasNonEmptySelection() {
    if (!input) return false;
    const s = input.selectionStart;
    const e = input.selectionEnd;
    if (s === e) return false;
    return input.value.slice(s, e).trim().length > 0;
  }

  function syncComposerSecretAccessoryClass(hasTokenHint, hasSel) {
    if (!form) return;
    form.classList.toggle('has-secret-accessory', !!(hasTokenHint || hasSel));
  }

  function cancelComposerSelectionHintReveal() {
    if (composerSelectionHintTimer) {
      clearTimeout(composerSelectionHintTimer);
      composerSelectionHintTimer = null;
    }
    composerSelectionHintRevealed = false;
  }

  /** Show the selection hint row 300ms after a non-empty composer selection. */
  function scheduleComposerSelectionHintReveal() {
    cancelComposerSelectionHintReveal();
    if (!input || !composerSecretsEnabled()) {
      applyComposerSecretStripLayout();
      return;
    }
    if (!composerHasNonEmptySelection()) {
      applyComposerSecretStripLayout();
      return;
    }
    applyComposerSecretStripLayout();
    composerSelectionHintTimer = setTimeout(() => {
      composerSelectionHintTimer = null;
      if (!composerHasNonEmptySelection()) return;
      composerSelectionHintRevealed = true;
      applyComposerSecretStripLayout();
    }, COMPOSER_SELECTION_HINT_DELAY_MS);
  }

  /**
   * Accessory inside the composer: token row and/or selection row (Apple-style
   * minimal strip). Token row is synced here via `updateComposerTokenRow` so
   * selection-only changes are correct without waiting for debounce.
   */
  function applyComposerSecretStripLayout() {
    applyComposerSecretStripLayoutInner();
    // Secret strip and the secure-workspace bar share the bottom row; whenever
    // the strip's visibility changes, re-evaluate the bar so it yields to the
    // strip ("Selection in message") and reappears once the strip is gone.
    if (typeof refreshSecureBar === 'function') refreshSecureBar();
  }

  function applyComposerSecretStripLayoutInner() {
    if (!composerSecretUi) return;
    if (composerSecretModal && !composerSecretModal.hidden) {
      cancelComposerSelectionHintReveal();
      if (composerSecretsEnabled()) composerSecretUi.hidden = false;
      syncComposerSecretAccessoryClass(false, false);
      return;
    }
    if (!composerSecretsEnabled()) {
      cancelComposerSelectionHintReveal();
      composerSecretUi.hidden = true;
      composerTokenDetectRange = null;
      if (composerTokenHint) composerTokenHint.hidden = true;
      if (composerSelectionHint) composerSelectionHint.hidden = true;
      syncComposerSecretAccessoryClass(false, false);
      return;
    }
    updateComposerTokenRow();
    const hasTokenHint = composerTokenHint && !composerTokenHint.hidden;
    const hasSel =
      composerSelectionHintRevealed && composerHasNonEmptySelection();
    if (composerSelectionHint) composerSelectionHint.hidden = !hasSel;
    const showStrip = hasTokenHint || hasSel;
    composerSecretUi.hidden = !showStrip;
    syncComposerSecretAccessoryClass(hasTokenHint, hasSel);
  }

  /** Sync the token-detected row from the current composer value (no debounce). */
  function updateComposerTokenRow() {
    if (!input || !composerTokenHint || !composerTokenHintText) return;
    if (!composerSecretsEnabled()) {
      composerTokenDetectRange = null;
      composerTokenHint.hidden = true;
      composerTokenHint.removeAttribute('title');
      return;
    }
    const t = input.value;
    const r = findLikelyTokenRange(t);
    if (!r) {
      composerTokenDetectRange = null;
      composerTokenHint.hidden = true;
      composerTokenHint.removeAttribute('title');
      return;
    }
    composerTokenDetectRange = r;
    composerTokenHintText.textContent = 'Likely contains sensitive data';
    composerTokenHint.title = t.slice(r.start, r.end);
    composerTokenHint.hidden = false;
  }

  function pruneComposerSecretSlots(text) {
    for (const slot of [...composerSecretBySlot.keys()]) {
      if (!text.includes('[[iclaw:s' + slot + ']]')) composerSecretBySlot.delete(slot);
    }
  }

  function buildInlineSecretsPayload(text) {
    const uniq = new Set();
    const re = /\[\[iclaw:s(\d+)\]\]/g;
    let m;
    while ((m = re.exec(text)) !== null) uniq.add(Number(m[1]));
    if (uniq.size === 0) return undefined;
    const slots = [...uniq].sort((a, b) => a - b);
    const labelsSeen = new Set();
    const out = [];
    for (const slot of slots) {
      const p = composerSecretBySlot.get(slot);
      if (!p) {
        throw new Error('Each [[iclaw:sN]] marker in the message needs a secret name (use the button).');
      }
      const labelKey = String(p.label ?? '')
        .trim()
        .toLowerCase();
      if (labelsSeen.has(labelKey)) {
        throw new Error('Secret name already exists');
      }
      labelsSeen.add(labelKey);
      out.push({
        slot,
        label: p.label,
        plain: String(p.plain ?? '')
          .replace(/\r/g, '')
          .trim(),
      });
    }
    return out;
  }

  async function isComposerSecretLabelAvailable(label) {
    if (!composerSecretsEnabled()) return true;
    const q = encodeURIComponent(String(label ?? '').trim());
    if (!q) return false;
    const url =
      activeChatId != null
        ? '/chats/' + encodeURIComponent(activeChatId) + '/secrets/check-label?label=' + q
        : '/api/secrets/check-label?label=' + q;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('Could not verify secret name');
    const data = await res.json();
    return data && data.available === true;
  }

  function clearComposerSecretDraft() {
    cancelComposerSelectionHintReveal();
    composerSecretBySlot.clear();
    composerSecretNextSlot = 0;
    composerTokenDetectRange = null;
    if (composerTokenHint) composerTokenHint.hidden = true;
    applyComposerSecretStripLayout();
  }

  function scheduleTokenDetect() {
    if (!input || !composerSecretsEnabled()) return;
    if (composerTokenDetectTimer) clearTimeout(composerTokenDetectTimer);
    composerTokenDetectTimer = setTimeout(runTokenDetect, 380);
  }

  function runTokenDetect() {
    composerTokenDetectTimer = null;
    updateComposerTokenRow();
    applyComposerSecretStripLayout();
  }

  /** Modal mask preview, e.g. sk***EF; each line masked separately. */
  function maskSecretPreviewLine(line) {
    const s = String(line ?? '');
    if (!s) return '';
    const n = s.length;
    if (n <= 2) return '••';
    if (n <= 3) return s[0] + '**' + s[n - 1];
    if (n <= 5) return s[0] + '***' + s[n - 1];
    if (n < 8) return s.slice(0, 2) + '**' + s.slice(-2);
    return s.slice(0, 2) + '***' + s.slice(-2);
  }

  function formatSecretModalPreview(plain) {
    const s = String(plain ?? '');
    if (!s) return '—';
    if (/[\r\n]/.test(s)) {
      return s
        .split(/\r?\n/)
        .map((line) => maskSecretPreviewLine(line))
        .join('\n');
    }
    return maskSecretPreviewLine(s);
  }

  function resizeComposerSecretTokenInput() {
    if (!composerSecretValueInput) return;
    composerSecretValueInput.style.height = 'auto';
    composerSecretValueInput.style.height = composerSecretValueInput.scrollHeight + 'px';
  }

  function syncComposerSecretPlainFromInput() {
    if (!composerSecretInsert || !composerSecretValueInput) return;
    composerSecretInsert.plain = composerSecretValueInput.value.replace(/\r/g, '').trim();
  }

  function syncComposerSecretTokenView() {
    const plain = composerSecretInsert ? composerSecretInsert.plain : '';
    if (composerSecretTokenEditing) {
      if (composerSecretValueInput) {
        composerSecretValueInput.value = plain;
        composerSecretValueInput.hidden = false;
        resizeComposerSecretTokenInput();
      }
      if (composerSecretValuePreview) composerSecretValuePreview.hidden = true;
      if (composerSecretTokenToggle) {
        composerSecretTokenToggle.setAttribute('aria-pressed', 'true');
        composerSecretTokenToggle.setAttribute('aria-label', 'Hide token');
        composerSecretTokenToggle.title = 'Hide token';
      }
    } else {
      if (composerSecretValuePreview) {
        composerSecretValuePreview.textContent = formatSecretModalPreview(plain);
        composerSecretValuePreview.hidden = false;
      }
      if (composerSecretValueInput) composerSecretValueInput.hidden = true;
      if (composerSecretTokenToggle) {
        composerSecretTokenToggle.setAttribute('aria-pressed', 'false');
        composerSecretTokenToggle.setAttribute('aria-label', 'Edit token');
        composerSecretTokenToggle.title = 'Edit token';
      }
    }
  }

  function setComposerSecretTokenEditing(editing) {
    if (composerSecretTokenEditing && !editing) syncComposerSecretPlainFromInput();
    composerSecretTokenEditing = editing;
    syncComposerSecretTokenView();
    if (editing && composerSecretValueInput) {
      setTimeout(() => composerSecretValueInput.focus(), 0);
    }
  }

  function openComposerSecretModal(onCommit) {
    if (!composerSecretModal || !composerSecretLabelInput) return;
    composerSecretCommit = onCommit;
    composerSecretTokenEditing = false;
    composerSecretModal.hidden = false;
    composerSecretLabelInput.value = '';
    syncComposerSecretTokenView();
    applyComposerSecretStripLayout();
    setTimeout(() => composerSecretLabelInput.focus(), 0);
  }

  function closeComposerSecretModal() {
    if (composerSecretModal) composerSecretModal.hidden = true;
    composerSecretInsert = null;
    composerSecretRedactMessageId = null;
    composerSecretCommit = null;
    composerSecretTokenEditing = false;
    if (composerSecretValuePreview) {
      composerSecretValuePreview.textContent = '';
      composerSecretValuePreview.hidden = false;
    }
    if (composerSecretValueInput) {
      composerSecretValueInput.value = '';
      composerSecretValueInput.hidden = true;
    }
    if (composerSecretTokenToggle) {
      composerSecretTokenToggle.setAttribute('aria-pressed', 'false');
    }
    applyComposerSecretStripLayout();
  }

  async function applyMessageSecretRedact(label) {
    const messageId = composerSecretRedactMessageId;
    if (messageId == null || activeChatId == null || !composerSecretInsert) return;
    if (composerSecretTokenEditing) syncComposerSecretPlainFromInput();
    const lab = String(label ?? '').trim();
    if (!lab) {
      alert('Enter a secret name.');
      return;
    }
    if (/[\[\]|]/.test(lab)) {
      alert('Name cannot contain [ ] |');
      return;
    }
    try {
      if (!(await isComposerSecretLabelAvailable(lab))) {
        alert('Secret name already exists');
        return;
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
      return;
    }
    const plain = String(composerSecretInsert.plain ?? '')
      .replace(/\r/g, '')
      .trim();
    if (!plain) {
      alert('Empty secret.');
      return;
    }
    try {
      const res = await fetch(
        '/chats/' +
          encodeURIComponent(activeChatId) +
          '/messages/' +
          encodeURIComponent(messageId) +
          '/redact-secret',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ label: lab, selection: plain }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error ? String(data.error) : 'HTTP ' + res.status);
      }
      const updated = data?.message;
      closeComposerSecretModal();
      if (updated && messagesEl) {
        const msgEl = messagesEl.querySelector('.msg[data-msg-id="' + updated.id + '"]');
        if (msgEl) applyMessageContentToEl(msgEl, updated.content || '');
      }
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  async function applySecretReplace(label) {
    if (!input || !composerSecretInsert) return;
    if (composerSecretTokenEditing) syncComposerSecretPlainFromInput();
    const lab = String(label ?? '').trim();
    if (!lab) {
      alert('Enter a secret name.');
      return;
    }
    if (/[\[\]|]/.test(lab)) {
      alert('Name cannot contain [ ] |');
      return;
    }
    try {
      if (!(await isComposerSecretLabelAvailable(lab))) {
        alert('Secret name already exists');
        return;
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
      return;
    }
    const t = input.value;
    const ins = composerSecretInsert;
    const plain = String(ins.plain ?? '')
      .replace(/\r/g, '')
      .trim();
    if (!plain) {
      alert('Empty secret.');
      return;
    }
    const slot = composerSecretNextSlot++;
    const marker = '[[iclaw:s' + slot + ']]';
    input.value = t.slice(0, ins.start) + marker + t.slice(ins.end);
    composerSecretBySlot.set(slot, { label: lab, plain });
    closeComposerSecretModal();
    scheduleTokenDetect();
  }

  function collapseSecretChip(chip) {
    chip.classList.remove('iclaw-secret-chip--revealed');
    chip.querySelector('.iclaw-secret-revealed')?.remove();
    const btn = chip.querySelector('.iclaw-secret-reveal');
    if (btn) btn.hidden = false;
    const wrap = chip.querySelector('.iclaw-secret-value');
    const code = wrap?.querySelector('.iclaw-secret-code');
    if (wrap) wrap.hidden = true;
    if (code) code.textContent = '';
  }

  function revealSecretChip(chip, valueText) {
    const value = valueText != null ? String(valueText) : '';
    const btn = chip.querySelector('.iclaw-secret-reveal');
    if (btn) btn.hidden = true;
    chip.querySelector('.iclaw-secret-revealed')?.remove();
    const plain = document.createElement('span');
    plain.className = 'iclaw-secret-revealed';
    plain.setAttribute('role', 'button');
    plain.setAttribute('tabindex', '0');
    plain.setAttribute('title', 'Click to hide');
    plain.textContent = value;
    chip.appendChild(plain);
    chip.classList.add('iclaw-secret-chip--revealed');
    const wrap = chip.querySelector('.iclaw-secret-value');
    const code = wrap?.querySelector('.iclaw-secret-code');
    if (code) code.textContent = value;
    if (wrap) wrap.hidden = true;
  }

  if (messagesEl) {
    messagesEl.addEventListener('click', (ev) => {
      const revealed = ev.target.closest('.iclaw-secret-revealed');
      if (revealed && messagesEl.contains(revealed)) {
        ev.preventDefault();
        const chip = revealed.closest('.iclaw-secret-chip');
        if (chip) collapseSecretChip(chip);
        return;
      }
      const btn = ev.target.closest('.iclaw-secret-reveal');
      if (!btn || !messagesEl.contains(btn)) return;
      ev.preventDefault();
      const chip = btn.closest('.iclaw-secret-chip');
      if (!chip || chip.classList.contains('iclaw-secret-chip--revealed')) return;
      const sid = chip.getAttribute('data-secret-id');
      if (!sid || activeChatId == null) return;
      const wrap = chip.querySelector('.iclaw-secret-value');
      const code = wrap?.querySelector('.iclaw-secret-code');
      if (!wrap || !code) return;
      if (code.textContent) {
        revealSecretChip(chip, code.textContent);
        return;
      }
      void fetch('/chats/' + encodeURIComponent(activeChatId) + '/secrets/' + encodeURIComponent(sid) + '/value', {
        headers: { Accept: 'application/json' },
      })
        .then((res) => {
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then((data) => {
          revealSecretChip(chip, data && data.value != null ? String(data.value) : '');
        })
        .catch(() => {
          revealSecretChip(chip, '(could not load)');
        });
    });
  }

  if (input) {
    input.addEventListener('select', () => {
      scheduleComposerSelectionHintReveal();
    });
    input.addEventListener('mouseup', () => {
      scheduleComposerSelectionHintReveal();
    });
    input.addEventListener('keyup', () => {
      scheduleComposerSelectionHintReveal();
    });
    input.addEventListener('input', () => {
      pruneComposerSecretSlots(input.value);
      scheduleTokenDetect();
      scheduleComposerSelectionHintReveal();
    });
  }

  if (composerMarkSecretBtn && input) {
    composerMarkSecretBtn.addEventListener('click', () => {
      if (!composerSecretsEnabled()) {
        alert(composerSecretsBlockedMessage());
        return;
      }
      const s = input.selectionStart;
      const e = input.selectionEnd;
      if (s === e) return;
      const plain = input.value.slice(s, e);
      if (!plain.trim()) return;
      composerSecretInsert = { start: s, end: e, plain };
      openComposerSecretModal((label) => applySecretReplace(label));
    });
  }

  if (composerTokenSaveBtn && input) {
    composerTokenSaveBtn.addEventListener('click', () => {
      if (!composerTokenDetectRange) return;
      if (!composerSecretsEnabled()) return;
      const { start, end } = composerTokenDetectRange;
      const plain = input.value.slice(start, end);
      composerSecretInsert = { start, end, plain };
      openComposerSecretModal((label) => applySecretReplace(label));
    });
  }

  if (composerSecretOk && composerSecretLabelInput) {
    composerSecretOk.addEventListener('click', () => {
      const fn = composerSecretCommit;
      if (!fn) return;
      if (composerSecretTokenEditing) syncComposerSecretPlainFromInput();
      const label = composerSecretLabelInput.value;
      if (composerSecretRedactMessageId != null) {
        void applyMessageSecretRedact(label);
      } else {
        void Promise.resolve(fn(label));
      }
    });
  }
  if (composerSecretTokenToggle) {
    composerSecretTokenToggle.addEventListener('click', () => {
      setComposerSecretTokenEditing(!composerSecretTokenEditing);
    });
  }
  if (composerSecretValueInput) {
    composerSecretValueInput.addEventListener('input', () => {
      syncComposerSecretPlainFromInput();
      resizeComposerSecretTokenInput();
    });
  }
  if (composerSecretBackdrop) {
    composerSecretBackdrop.addEventListener('click', () => closeComposerSecretModal());
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (composerSecretModal && !composerSecretModal.hidden) {
      e.preventDefault();
      closeComposerSecretModal();
    }
  });

  syncComposerSecretUi();

  if (form && input) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (startedOnDraft && !draftProjectLocked) return;
      // Don't send into a dead end. Full Power needs a reachable OpenClaw; the
      // runtime modes (incl. a Work default with no OpenClaw on the device) need
      // an OpenRouter key. When neither is usable, re-offer connecting a model.
      const _sendMode = getComposerMode();
      const _modeRunnable =
        _sendMode === 'execute' ? isExecuteAvailable() : openRouterReady;
      if (!_modeRunnable) {
        // Full Power with a key has usable runtime fallbacks → nudge to switch
        // mode; otherwise there's no working backend → re-offer connecting.
        if (_sendMode === 'execute' && openRouterReady) syncExecuteAvailability();
        else openConnectChooser();
        return;
      }
      // If the schedule menu was just opened by a long-press, the bubbling
      // click on the send button would otherwise submit a regular message.
      if (scheduleMenuJustOpened || isScheduleMenuOpen()) {
        scheduleMenuJustOpened = false;
        return;
      }
      const content = input.value.trim();
      if (!content && pendingAttachments.length === 0) return;
      let inlineSecrets;
      try {
        inlineSecrets = buildInlineSecretsPayload(content);
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
        return;
      }
      const replySnap = pendingComposerReply;
      pendingComposerReply = null;
      updateComposerReplyBar();
      // Snapshot + clear immediately so the user can start composing the next
      // message while this one streams.
      const attachmentsSnap = pendingAttachments.map((a) => ({
        id: a.id,
        mimeType: a.mimeType,
        fileName: a.fileName,
        sizeBytes: a.sizeBytes,
        dataUrl: a.dataUrl,
        base64: a.base64,
      }));
      clearPendingAttachments();
      const draft = {
        content,
        replyTo: replySnap || undefined,
        attachments: attachmentsSnap.length > 0 ? attachmentsSnap : undefined,
        inlineSecrets,
        mode: getComposerMode(),
      };
      let queued;
      const persistOnServer =
        activeChatId != null && (inFlight || waitingItems.length > 0);
      if (persistOnServer) {
        try {
          queued = await enqueueQueueOnServer(activeChatId, draft);
        } catch (err) {
          alert(err instanceof Error ? err.message : String(err));
          return;
        }
      } else {
        queued = {
          ...draft,
          id: 'local-' + nextLocalQueueItemId++,
        };
      }
      addWaitingItem(queued);
      input.value = '';
      clearComposerSecretDraft();
      renderQueue();
      flushNextQueued();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.isComposing) return;
      if (e.shiftKey) {
        if (maybeContinueOrderedList(input)) {
          e.preventDefault();
        }
        return;
      }
      e.preventDefault();
      form.requestSubmit();
    });
    if (!startedOnDraft || draftProjectLocked) input.focus();
  }

  // -------------------------------------------------------------------------
  // scheduled messages (Telegram-style hold-to-send-later)
  // -------------------------------------------------------------------------
  const scheduleMenu = document.getElementById('schedule-menu');
  const scheduleMenuMain = document.getElementById('schedule-menu-main');
  const scheduleMenuSchedule = document.getElementById('schedule-menu-schedule');
  const sendBtn = document.getElementById('composer-send-btn');
  const scheduledListEl = document.getElementById('scheduled-list');
  const schedulePicker = document.getElementById('schedule-picker');
  const schedulePickerBackdrop = document.getElementById('schedule-picker-backdrop');
  const schedulePickerCancel = document.getElementById('schedule-picker-cancel');
  const schedulePickerConfirm = document.getElementById('schedule-picker-confirm');
  const scheduleDatetimeInput = document.getElementById('schedule-datetime-input');
  const SCHEDULE_MIN_LEAD_MS = 3 * 60_000;
  const LONG_PRESS_MS = 450;
  const HOVER_HOLD_MS = 1500;
  let schedulePressTimer = null;
  let scheduleHoverTimer = null;
  let scheduleMenuJustOpened = false;
  let scheduleMenuAutoCloseTimer = null;
  let editingScheduledId = null;
  let schedulePickerOnConfirm = null;

  function toDatetimeLocalValue(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return (
      d.getFullYear() +
      '-' +
      pad(d.getMonth() + 1) +
      '-' +
      pad(d.getDate()) +
      'T' +
      pad(d.getHours()) +
      ':' +
      pad(d.getMinutes())
    );
  }

  function getScheduleMinWhen() {
    return new Date(Date.now() + SCHEDULE_MIN_LEAD_MS);
  }

  function clampScheduleWhen(when) {
    const min = getScheduleMinWhen();
    return when.getTime() < min.getTime() ? min : when;
  }

  function refreshScheduleDatetimeMin() {
    if (!scheduleDatetimeInput) return;
    scheduleDatetimeInput.min = toDatetimeLocalValue(getScheduleMinWhen());
  }

  function isScheduleWhenAllowed(when) {
    return when.getTime() >= getScheduleMinWhen().getTime();
  }

  function readSchedulePickerValue() {
    const v = scheduleDatetimeInput?.value;
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function ensureSchedulePickerPortal() {
    if (!schedulePicker || schedulePicker.parentElement === document.body) return;
    document.body.appendChild(schedulePicker);
  }

  function closeSchedulePicker() {
    if (!schedulePicker) return;
    schedulePicker.hidden = true;
    schedulePickerOnConfirm = null;
  }

  function openSchedulePicker(initialWhen, onConfirm) {
    if (!schedulePicker) return;
    ensureSchedulePickerPortal();
    closeScheduleMenu();
    schedulePickerOnConfirm = onConfirm;
    refreshScheduleDatetimeMin();
    const when = clampScheduleWhen(initialWhen || new Date(Date.now() + 60 * 60_000));
    if (scheduleDatetimeInput) {
      scheduleDatetimeInput.value = toDatetimeLocalValue(when);
    }
    schedulePicker.hidden = false;
    requestAnimationFrame(() => {
      const el = scheduleDatetimeInput;
      if (!el) return;
      if (typeof el.showPicker === 'function') {
        try {
          el.showPicker();
          return;
        } catch {
          /* fall through */
        }
      }
      el.focus();
    });
  }

  function composerHasMessageText() {
    return Boolean(input && String(input.value).trim());
  }

  /** After task create / send / schedule — empty composer and reset secret UI. */
  function clearComposerInput() {
    if (!input) return;
    input.value = '';
    clearComposerSecretDraft();
    closeScheduleMenu();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function isScheduleMenuOpen() {
    return scheduleMenu != null && !scheduleMenu.hidden;
  }

  function onScheduleMenuOutsidePointerDown(ev) {
    if (!isScheduleMenuOpen()) return;
    const t = ev.target;
    if (scheduleMenu.contains(t)) return;
    if (sendBtn && sendBtn.contains(t)) return;
    closeScheduleMenu();
  }

  function showScheduleMenuPanel(panel) {
    const main = scheduleMenuMain || scheduleMenu?.querySelector('[data-panel="main"]');
    const times = scheduleMenuSchedule || scheduleMenu?.querySelector('[data-panel="schedule"]');
    if (!main || !times) return;
    const showTimes = panel === 'schedule';
    main.hidden = showTimes;
    times.hidden = !showTimes;
  }

  const MENU_HOVER_INTENT_MS = 3500;

  function closeScheduleMenu() {
    if (!scheduleMenu) return;
    showScheduleMenuPanel('main');
    scheduleMenu.hidden = true;
    scheduleMenuJustOpened = false;
    if (scheduleMenuAutoCloseTimer != null) {
      clearTimeout(scheduleMenuAutoCloseTimer);
      scheduleMenuAutoCloseTimer = null;
    }
    document.removeEventListener('pointerdown', onScheduleMenuOutsidePointerDown, true);
  }

  /** Schedule a 3.5s close. Cleared by mouseenter on the menu; restarted by
   * mouseleave or any other re-entry into "user away" state. */
  function armScheduleMenuAutoClose() {
    if (scheduleMenuAutoCloseTimer != null) clearTimeout(scheduleMenuAutoCloseTimer);
    scheduleMenuAutoCloseTimer = setTimeout(() => {
      scheduleMenuAutoCloseTimer = null;
      closeScheduleMenu();
    }, MENU_HOVER_INTENT_MS);
  }
  function disarmScheduleMenuAutoClose() {
    if (scheduleMenuAutoCloseTimer != null) {
      clearTimeout(scheduleMenuAutoCloseTimer);
      scheduleMenuAutoCloseTimer = null;
    }
  }

  function openScheduleMenu() {
    if (!scheduleMenu || !composerHasMessageText()) return;
    closeComposerAttachMenus();
    document.removeEventListener('pointerdown', onScheduleMenuOutsidePointerDown, true);
    showScheduleMenuPanel('main');
    scheduleMenu.hidden = false;
    armScheduleMenuAutoClose();
    setTimeout(() => {
      document.addEventListener('pointerdown', onScheduleMenuOutsidePointerDown, true);
    }, 0);
  }

  if (scheduleMenu) {
    // Hover intent — cursor on the menu pauses the auto-close;
    // leaving the menu restarts the 3.5s countdown.
    scheduleMenu.addEventListener('mouseenter', disarmScheduleMenuAutoClose);
    scheduleMenu.addEventListener('mouseleave', armScheduleMenuAutoClose);
  }

  function parseScheduledStamp(stamp) {
    if (!stamp) return null;
    const s = String(stamp).trim();
    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const norm = s.replace(' ', 'T') + 'Z';
    const d = new Date(norm);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function formatScheduledWhen(stamp) {
    const d = parseScheduledStamp(stamp);
    if (!d) return String(stamp);
    const now = new Date();
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const sameDay = d.toDateString() === now.toDateString();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    const isTomorrow = d.toDateString() === tomorrow.toDateString();
    if (sameDay) return 'today ' + time;
    if (isTomorrow) return 'tomorrow ' + time;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ', ' + time;
  }

  function computeScheduledAt(offset) {
    const now = new Date();
    if (offset === '5m') return new Date(now.getTime() + 5 * 60_000);
    if (offset === '30m') return new Date(now.getTime() + 30 * 60_000);
    if (offset === '1h') return new Date(now.getTime() + 60 * 60_000);
    if (offset === 'tomorrow9') {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d;
    }
    return null;
  }

  function scheduledItemActionsHtml(id) {
    const esc = escapeHtml(String(id));
    return (
      '<div class="scheduled-item-actions">' +
      '<button type="button" class="scheduled-item-send-now btn btn--icon btn--ghost" data-scheduled-id="' +
      esc +
      '" aria-label="Send now" title="Send now">' +
      COMPOSER_PENDING_SEND_SVG +
      '</button>' +
      '<button type="button" class="scheduled-item-edit btn btn--icon btn--ghost" data-scheduled-id="' +
      esc +
      '" aria-label="Edit" title="Edit">' +
      COMPOSER_PENDING_EDIT_SVG +
      '</button>' +
      '<button type="button" class="scheduled-item-cancel btn btn--icon btn--ghost" data-scheduled-id="' +
      esc +
      '" aria-label="Cancel" title="Cancel">×</button>' +
      '</div>'
    );
  }

  function scheduledRowSortKey(row) {
    const t = parseScheduledStamp(row.dataset.scheduledAt);
    return t ? t.getTime() : Number.POSITIVE_INFINITY;
  }

  /** Soonest scheduled_at first (matches server ORDER BY scheduled_at ASC). */
  function sortScheduledListDom() {
    if (!scheduledListEl) return;
    const rows = [...scheduledListEl.querySelectorAll('.scheduled-item--scheduled')];
    if (rows.length < 2) return;
    rows.sort((a, b) => {
      const da = scheduledRowSortKey(a);
      const db = scheduledRowSortKey(b);
      if (da !== db) return da - db;
      return Number(a.dataset.scheduledId) - Number(b.dataset.scheduledId);
    });
    for (const row of rows) scheduledListEl.appendChild(row);
  }

  function refreshScheduledTimes() {
    if (!scheduledListEl) return;
    scheduledListEl.querySelectorAll('.scheduled-item-when[data-when]').forEach((el) => {
      el.textContent = formatScheduledWhen(el.dataset.when);
    });
  }

  function renderScheduledItem(scheduled) {
    if (!scheduledListEl) return;
    if (scheduledListEl.querySelector('.scheduled-item[data-scheduled-id="' + scheduled.id + '"]')) return;
    const row = document.createElement('div');
    row.className = 'scheduled-item scheduled-item--scheduled';
    row.dataset.scheduledId = String(scheduled.id);
    row.dataset.scheduledAt = scheduled.scheduled_at;
    row.innerHTML = composerPendingRowInnerHtml({
      kind: 'scheduled',
      metaIcon: '⏰',
      metaText: formatScheduledWhen(scheduled.scheduled_at),
      whenData: scheduled.scheduled_at,
      content: scheduled.content,
      actionsHtml: scheduledItemActionsHtml(scheduled.id),
    });
    scheduledListEl.appendChild(row);
    applyPendingRowClamp(row);
    scheduledListEl.classList.remove('is-empty');
    sortScheduledListDom();
  }
  function updateScheduledItem(scheduled) {
    if (!scheduledListEl) return;
    const row = scheduledListEl.querySelector(
      '.scheduled-item[data-scheduled-id="' + scheduled.id + '"]',
    );
    if (!row) {
      renderScheduledItem(scheduled);
      return;
    }
    row.dataset.scheduledAt = scheduled.scheduled_at;
    const whenEl = row.querySelector('.scheduled-item-when');
    if (whenEl) {
      whenEl.dataset.when = scheduled.scheduled_at;
      whenEl.textContent = formatScheduledWhen(scheduled.scheduled_at);
    }
    const textEl = row.querySelector('.scheduled-item-text');
    if (textEl) textEl.textContent = scheduled.content;
    applyPendingRowClamp(row);
    sortScheduledListDom();
  }

  function removeScheduledItem(id) {
    if (!scheduledListEl) return;
    const row = scheduledListEl.querySelector('.scheduled-item[data-scheduled-id="' + id + '"]');
    if (row) row.remove();
    if (!scheduledListEl.querySelector('.scheduled-item')) {
      scheduledListEl.classList.add('is-empty');
    }
  }

  async function submitScheduled(when, opts) {
    if (activeChatId == null) return;
    const content = (opts && opts.content) || input.value.trim();
    if (!content) return;
    if (!isScheduleWhenAllowed(when)) {
      alert('Please pick a time at least 3 minutes from now.');
      return;
    }
    const sid = (opts && opts.scheduledId) || editingScheduledId;
    if (!sid) {
      let inlineSecrets;
      try {
        inlineSecrets = buildInlineSecretsPayload(content);
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
        return;
      }
      try {
        const res = await fetch(
          '/chats/' + encodeURIComponent(activeChatId) + '/scheduled',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              content,
              scheduledAt: when.toISOString(),
              ...(inlineSecrets && inlineSecrets.length > 0 ? { inlineSecrets } : {}),
            }),
          },
        );
        if (!res.ok) throw new Error(await res.text());
        input.value = '';
        clearComposerSecretDraft();
        closeScheduleMenu();
        closeSchedulePicker();
      } catch (err) {
        alert('Failed to schedule: ' + (err instanceof Error ? err.message : err));
      }
      return;
    }
    try {
      const res = await fetch(
        '/chats/' + encodeURIComponent(activeChatId) + '/scheduled/' + encodeURIComponent(sid),
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content, scheduledAt: when.toISOString() }),
        },
      );
      if (!res.ok) throw new Error(await res.text());
      editingScheduledId = null;
      input.value = '';
      clearComposerSecretDraft();
      closeScheduleMenu();
      closeSchedulePicker();
    } catch (err) {
      alert('Failed to update: ' + (err instanceof Error ? err.message : err));
    }
  }

  async function sendScheduledNow(sid) {
    if (activeChatId == null || !Number.isFinite(sid)) return;
    removeScheduledItem(sid);
    try {
      const res = await fetch(
        '/chats/' + encodeURIComponent(activeChatId) + '/scheduled/' + encodeURIComponent(sid) + '/send-now',
        { method: 'POST' },
      );
      if (!res.ok) throw new Error(await res.text());
    } catch (err) {
      alert('Failed to send: ' + (err instanceof Error ? err.message : err));
    }
  }

  function beginEditScheduled(row) {
    if (!row || activeChatId == null) return;
    const sid = Number(row.dataset.scheduledId);
    if (!Number.isFinite(sid)) return;
    const textEl = row.querySelector('.scheduled-item-text');
    const content = textEl ? textEl.textContent : '';
    const stamp = row.dataset.scheduledAt || '';
    editingScheduledId = sid;
    input.value = content;
    input.focus();
    const when = parseScheduledStamp(stamp) || new Date(Date.now() + 60 * 60_000);
    openSchedulePicker(when, (picked) => {
      submitScheduled(picked, { scheduledId: sid, content: input.value.trim() });
    });
  }

  // long-press detection on the send button
  if (sendBtn) {
    sendBtn.addEventListener('pointerdown', () => {
      if (startedOnDraft || activeChatId == null) return;
      if (!composerHasMessageText()) return;
      if (schedulePressTimer) clearTimeout(schedulePressTimer);
      schedulePressTimer = setTimeout(() => {
        schedulePressTimer = null;
        scheduleMenuJustOpened = true;
        openScheduleMenu();
      }, LONG_PRESS_MS);
    });
    sendBtn.addEventListener('pointerup', () => {
      if (!isScheduleMenuOpen() && schedulePressTimer) {
        clearTimeout(schedulePressTimer);
        schedulePressTimer = null;
      }
    });
    sendBtn.addEventListener('pointerleave', () => {
      if (!isScheduleMenuOpen() && schedulePressTimer) {
        clearTimeout(schedulePressTimer);
        schedulePressTimer = null;
      }
    });
    sendBtn.addEventListener('pointercancel', () => {
      if (schedulePressTimer) {
        clearTimeout(schedulePressTimer);
        schedulePressTimer = null;
      }
    });
    // Hover-and-hold on desktop — 1.5s of cursor parked on the button
    // opens the same schedule menu as long-press. Discoverable for users
    // who don't think to click-and-hold.
    sendBtn.addEventListener('mouseenter', () => {
      if (startedOnDraft || activeChatId == null) return;
      if (!composerHasMessageText()) return;
      if (scheduleHoverTimer) clearTimeout(scheduleHoverTimer);
      scheduleHoverTimer = setTimeout(() => {
        scheduleHoverTimer = null;
        if (isScheduleMenuOpen()) return;
        openScheduleMenu();
      }, HOVER_HOLD_MS);
    });
    sendBtn.addEventListener('mouseleave', () => {
      if (scheduleHoverTimer) {
        clearTimeout(scheduleHoverTimer);
        scheduleHoverTimer = null;
      }
    });
    // Capture-phase click guard — swallows the synthetic click that follows
    // the pointerup at the end of a long-press, which would otherwise submit
    // the form.
    sendBtn.addEventListener('click', (e) => {
      if (scheduleMenuJustOpened || isScheduleMenuOpen()) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, true);
  }

  if (schedulePickerCancel) {
    schedulePickerCancel.addEventListener('click', () => {
      editingScheduledId = null;
      closeSchedulePicker();
    });
  }
  if (schedulePickerBackdrop) {
    schedulePickerBackdrop.addEventListener('click', () => {
      editingScheduledId = null;
      closeSchedulePicker();
    });
  }
  if (schedulePickerConfirm) {
    schedulePickerConfirm.addEventListener('click', () => {
      const when = readSchedulePickerValue();
      if (!when) {
        alert('Please pick a date and time.');
        return;
      }
      if (!isScheduleWhenAllowed(when)) {
        alert('Please pick a time at least 3 minutes from now.');
        return;
      }
      if (schedulePickerOnConfirm) {
        schedulePickerOnConfirm(when);
        return;
      }
      submitScheduled(when);
    });
  }
  if (scheduleDatetimeInput) {
    scheduleDatetimeInput.addEventListener('change', () => {
      refreshScheduleDatetimeMin();
      const d = readSchedulePickerValue();
      if (!d) return;
      const clamped = clampScheduleWhen(d);
      if (d.getTime() !== clamped.getTime()) {
        scheduleDatetimeInput.value = toDatetimeLocalValue(clamped);
      }
    });
  }

  const createTaskModal = document.getElementById('create-task-modal');
  const createTaskBackdrop = document.getElementById('create-task-modal-backdrop');
  const createTaskGoal = document.getElementById('create-task-goal');
  const createTaskCancel = document.getElementById('create-task-cancel');
  const createTaskSubmit = document.getElementById('create-task-submit');

  function ensureCreateTaskModalPortal() {
    if (!createTaskModal || createTaskModal.parentElement === document.body) return;
    document.body.appendChild(createTaskModal);
  }

  function openCreateTaskModal() {
    if (!createTaskModal) return;
    if (activeChatId == null || startedOnDraft) {
      alert('Open or start a saved chat first — tasks need a chat context.');
      return;
    }
    ensureCreateTaskModalPortal();
    closeScheduleMenu();
    const composerText = (input && input.value.trim()) || '';
    if (createTaskGoal) createTaskGoal.value = composerText;
    createTaskModal.hidden = false;
    requestAnimationFrame(() => {
      createTaskGoal?.focus();
    });
  }

  function closeCreateTaskModal() {
    if (createTaskModal) createTaskModal.hidden = true;
  }

  const pendingTaskCreateBanners = new Map();
  const PENDING_TASK_STORAGE_KEY = 'iclaw.pendingTaskCreates.v1';
  const PENDING_TASK_MAX_AGE_MS = 30 * 60_000;
  const TASK_READY_BANNER_DISMISS_MS = 30_000;
  const ICLAW_BANNER_COUNTDOWN_RING_SVG =
    '<svg class="iclaw-inline-banner__countdown-ring" aria-hidden="true" viewBox="0 0 36 36">' +
    '<circle cx="18" cy="18" r="14" fill="none" stroke-width="2" stroke-linecap="round" ' +
    'stroke-dasharray="87.965 87.965" stroke-dashoffset="0"/>' +
    '</svg>';

  function readPendingTaskCreatesStore() {
    try {
      const raw = sessionStorage.getItem(PENDING_TASK_STORAGE_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' ? obj : {};
    } catch {
      return {};
    }
  }

  function writePendingTaskCreatesStore(store) {
    try {
      sessionStorage.setItem(PENDING_TASK_STORAGE_KEY, JSON.stringify(store));
    } catch {
      /* storage full or disabled */
    }
  }

  function prunePendingTaskCreatesStore(store) {
    const now = Date.now();
    for (const id of Object.keys(store)) {
      const rec = store[id];
      if (!rec || now - (rec.createdAt || 0) > PENDING_TASK_MAX_AGE_MS) delete store[id];
    }
  }

  function upsertPendingTaskCreateRecord(rec) {
    const store = readPendingTaskCreatesStore();
    prunePendingTaskCreatesStore(store);
    store[rec.pendingId] = rec;
    writePendingTaskCreatesStore(store);
  }

  function removePendingTaskCreateRecord(pendingId) {
    const store = readPendingTaskCreatesStore();
    delete store[pendingId];
    writePendingTaskCreatesStore(store);
    /* Defined later in the same IIFE; resolves at call time once the module
     * is initialised. Keeps polling timers from outliving their record. */
    stopPendingTaskCreatePoll(pendingId);
  }

  function shouldSuppressTaskReadyBanner(rec) {
    if (document.getElementById('task-board')) return true;
    // Suppress if we're already on the task's own detail page
    if (rec && rec.taskId != null) {
      const taskPage = document.querySelector('.task-page[data-task-id]');
      if (taskPage && Number(taskPage.dataset.taskId) === Number(rec.taskId)) return true;
    }
    const projectPage = document.querySelector('.project-page[data-project-id]');
    if (projectPage && rec && rec.projectId != null) {
      return Number(projectPage.dataset.projectId) === Number(rec.projectId);
    }
    return false;
  }

  function buildTaskBannerActionsHtml(opts) {
    const openDisabled = opts && opts.openDisabled;
    const openSpinner = opts && opts.openSpinner;
    const showDismiss = opts && opts.showDismiss;
    let html = '<div class="iclaw-inline-banner__actions">';
    if (showDismiss) {
      html +=
        '<button type="button" class="iclaw-inline-banner-dismiss task-create-banner-dismiss" aria-label="Dismiss">' +
        ICLAW_BANNER_COUNTDOWN_RING_SVG +
        '<span class="iclaw-inline-banner-dismiss-glyph" aria-hidden="true">✕</span></button>';
    }
    html +=
      '<button type="button" class="btn btn--sm task-create-banner-open"' +
      (openDisabled ? ' disabled' : '') +
      (openSpinner ? ' aria-busy="true"' : '') +
      '>' +
      (openSpinner ? '<span class="iclaw-inline-banner__btn-spinner" aria-hidden="true"></span> ' : '') +
      'Open</button></div>';
    return html;
  }

  function wireTaskBannerActions(pendingId, taskId) {
    const row = pendingTaskCreateBanners.get(pendingId);
    if (!row?.el) return;
    const dismiss = row.el.querySelector('.task-create-banner-dismiss');
    if (dismiss && dismiss.dataset.bound !== '1') {
      dismiss.dataset.bound = '1';
      dismiss.addEventListener('click', () => removeTaskCreateBanner(pendingId));
    }
    const openBtn = row.el.querySelector('.task-create-banner-open');
    if (openBtn && taskId != null && openBtn.dataset.bound !== '1') {
      openBtn.dataset.bound = '1';
      openBtn.addEventListener('click', () => {
        removeTaskCreateBanner(pendingId);
        goTo('/tasks/' + encodeURIComponent(taskId));
      });
    }
  }

  function removeTaskCreateBanner(pendingId) {
    const row = pendingTaskCreateBanners.get(pendingId);
    if (row && typeof row._readyExpiryClear === 'function') row._readyExpiryClear();
    pendingTaskCreateBanners.delete(pendingId);
    removePendingTaskCreateRecord(pendingId);
    stopPendingTaskCreatePoll(pendingId);
    const el = row?.el || document.querySelector('[data-pending-id="' + pendingId + '"]');
    if (el) el.remove();
    const host = document.getElementById('iclaw-inline-banner-host');
    if (host && !host.children.length) host.remove();
  }

  function startTaskReadyBannerExpiry(pendingId) {
    const row = pendingTaskCreateBanners.get(pendingId);
    if (!row || !row.el) return;
    const dismiss = row.el.querySelector('.task-create-banner-dismiss');
    if (!dismiss) return;
    if (typeof row._readyExpiryClear === 'function') row._readyExpiryClear();
    row._readyExpiryClear = attachPausableCountdown({
      hoverEl: row.el,
      durationMs: TASK_READY_BANNER_DISMISS_MS,
      onTickStart: () => dismiss.classList.add('iclaw-inline-banner-dismiss--expiring'),
      onTickClear: () => dismiss.classList.remove('iclaw-inline-banner-dismiss--expiring'),
      onExpire: () => {
        delete row._readyExpiryClear;
        removeTaskCreateBanner(pendingId);
      },
    });
  }

  function getTaskCreateBannerHost() {
    let host = document.getElementById('iclaw-inline-banner-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'iclaw-inline-banner-host';
      host.className = 'iclaw-inline-banner-host';
      host.setAttribute('aria-live', 'polite');
      const main = document.querySelector('.col-main');
      const anchor =
        main?.querySelector('.chat-header') ||
        main?.querySelector('.project-header') ||
        main?.querySelector('.task-board-header') ||
        main?.firstElementChild;
      if (main && anchor) {
        anchor.insertAdjacentElement('afterend', host);
      } else {
        document.body.prepend(host);
      }
    }
    return host;
  }

  function showTaskCreatingBanner(pendingId, title, rec) {
    if (pendingTaskCreateBanners.has(pendingId)) return;
    const host = getTaskCreateBannerHost();
    const safeTitle = escapeHtml(title);
    const el = document.createElement('aside');
    el.className = 'iclaw-inline-banner iclaw-inline-banner--info card is-loading';
    el.dataset.pendingId = pendingId;
    el.setAttribute('role', 'status');
    el.innerHTML =
      '<div class="iclaw-inline-banner__main">' +
      '<p class="iclaw-inline-banner__lead">Task "' +
      safeTitle +
      '" is being created…</p>' +
      '<p class="iclaw-inline-banner__detail muted">Plan and context are being prepared in the background — you can continue chatting</p>' +
      '</div>' +
      buildTaskBannerActionsHtml({ openDisabled: true, openSpinner: true, showDismiss: false });
    host.prepend(el);
    pendingTaskCreateBanners.set(pendingId, {
      el,
      title,
      taskId: null,
      sourceChatId: rec?.sourceChatId ?? activeChatId,
      projectId: rec?.projectId ?? currentComposerProjectId(),
    });
  }

  function renderTasksNavDotsHtml(signals) {
    if (!signals) return '';
    const parts = [];
    if (signals.needsHuman) parts.push('<span class="status-dot task-human"></span>');
    if (signals.running) parts.push('<span class="status-dot working"></span>');
    if (signals.needsReview) parts.push('<span class="status-dot task-review"></span>');
    if (!parts.length) return '';
    return '<span class="sidebar-tasks-dots" aria-hidden="true">' + parts.join('') + '</span>';
  }

  function applyTasksNavSignals(signals) {
    const link = document.getElementById('sidebar-tasks-link');
    if (!link) return;
    if (!link.querySelector('.sidebar-projects-btn__label')) {
      const label = document.createElement('span');
      label.className = 'sidebar-projects-btn__label';
      label.textContent = (link.textContent || 'Tasks').trim() || 'Tasks';
      link.textContent = '';
      link.appendChild(label);
    }
    link.querySelector('.sidebar-tasks-dots')?.remove();
    const html = renderTasksNavDotsHtml(signals);
    if (html) link.insertAdjacentHTML('beforeend', html);
    scheduleFaviconUpdate();
  }

  async function refreshTasksNavSignals() {
    try {
      const res = await fetch('/tasks/signals', {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      if (data.hasAny) revealTasksNav();
      applyTasksNavSignals(data.signals || {});
    } catch {
      /* best-effort */
    }
  }

  function revealTasksNav() {
    if (document.documentElement.dataset.tasksNavVisible === '1') {
      void refreshTasksNavSignals();
      return;
    }
    document.documentElement.dataset.tasksNavVisible = '1';

    const sidebarNav = document.querySelector('.sidebar-projects-nav');
    if (sidebarNav && !sidebarNav.querySelector('#sidebar-tasks-link')) {
      const a = document.createElement('a');
      a.href = '/tasks';
      a.className = 'sidebar-projects-btn';
      a.id = 'sidebar-tasks-link';
      a.innerHTML = '<span class="sidebar-projects-btn__label">Tasks</span>';
      sidebarNav.appendChild(a);
      void refreshTasksNavSignals();
    }

    const projectRoot = document.querySelector('main.project-page[data-project-id]');
    if (projectRoot && !projectRoot.querySelector('#project-tab-tasks')) {
      const tabs = projectRoot.querySelector('.project-tabs');
      const pid = projectRoot.dataset.projectId;
      if (tabs && pid) {
        const tab = document.createElement('a');
        tab.href = '/tasks?projectId=' + encodeURIComponent(pid);
        tab.className = 'project-tab project-tab--tasks';
        tab.id = 'project-tab-tasks';
        tab.textContent = 'Tasks';
        tabs.appendChild(tab);
      }
    }
  }

  function markTaskCreateBannerReady(pendingId, taskId, title) {
    revealTasksNav();
    const row = pendingTaskCreateBanners.get(pendingId);
    const storeRec = readPendingTaskCreatesStore()[pendingId];
    const rec = {
      ...(storeRec || {}),
      pendingId,
      title,
      taskId,
      projectId: row?.projectId ?? storeRec?.projectId ?? null,
      sourceChatId: row?.sourceChatId ?? storeRec?.sourceChatId ?? null,
      status: 'ready',
    };
    if (shouldSuppressTaskReadyBanner(rec)) {
      removeTaskCreateBanner(pendingId);
      return;
    }
    if (!row || !row.el || row.taskId != null) return;
    row.taskId = taskId;
    if (storeRec) {
      upsertPendingTaskCreateRecord({
        ...storeRec,
        status: 'ready',
        taskId,
        error: null,
        projectId: rec.projectId,
      });
    }
    row.el.classList.remove('is-loading', 'is-error', 'iclaw-inline-banner--info');
    row.el.classList.add('is-ready', 'iclaw-inline-banner--success');
    const lead = row.el.querySelector('.iclaw-inline-banner__lead');
    if (lead) {
      lead.textContent = 'Task "' + title + '" is ready';
    }
    const detail = row.el.querySelector('.iclaw-inline-banner__detail');
    if (detail) detail.textContent = 'Plan saved — you can review it and start the agent.';
    const actions = row.el.querySelector('.iclaw-inline-banner__actions');
    if (actions) {
      actions.outerHTML = buildTaskBannerActionsHtml({
        openDisabled: false,
        openSpinner: false,
        showDismiss: true,
      });
    }
    wireTaskBannerActions(pendingId, taskId);
    startTaskReadyBannerExpiry(pendingId);
  }

  function taskCreateErrorMessage(err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/failed to fetch/i.test(msg)) {
      return 'Connection lost (page navigation or network). Refresh the chat — the task may have already been created.';
    }
    return msg;
  }

  function showTaskCreateBannerError(pendingId, title, errMsg, rec) {
    const msg = taskCreateErrorMessage(errMsg);
    const storeRec = readPendingTaskCreatesStore()[pendingId];
    if (storeRec) {
      upsertPendingTaskCreateRecord({
        ...storeRec,
        status: 'error',
        error: msg,
      });
    }
    const existing = pendingTaskCreateBanners.get(pendingId);
    if (existing?.el) {
      markTaskCreateBannerError(pendingId, title, msg);
      return;
    }
    const host = getTaskCreateBannerHost();
    const safeTitle = escapeHtml(title);
    const el = document.createElement('aside');
    el.className = 'iclaw-inline-banner iclaw-inline-banner--error card is-error';
    el.dataset.pendingId = pendingId;
    el.setAttribute('role', 'status');
    el.innerHTML =
      '<div class="iclaw-inline-banner__main">' +
      '<p class="iclaw-inline-banner__lead">Failed to create task "' +
      safeTitle +
      '"</p>' +
      '<p class="iclaw-inline-banner__detail">' +
      escapeHtml(msg) +
      '</p>' +
      '</div>' +
      buildTaskBannerActionsHtml({ openDisabled: true, openSpinner: false, showDismiss: true });
    host.prepend(el);
    pendingTaskCreateBanners.set(pendingId, {
      el,
      title,
      taskId: null,
      sourceChatId: rec?.sourceChatId ?? activeChatId,
      projectId: rec?.projectId ?? currentComposerProjectId(),
    });
    wireTaskBannerActions(pendingId, null);
    startTaskReadyBannerExpiry(pendingId);
  }

  function markTaskCreateBannerError(pendingId, title, err) {
    const row = pendingTaskCreateBanners.get(pendingId);
    if (!row || !row.el) return;
    const msg = typeof err === 'string' ? err : taskCreateErrorMessage(err);
    const storeRec = readPendingTaskCreatesStore()[pendingId];
    if (storeRec) {
      upsertPendingTaskCreateRecord({
        ...storeRec,
        status: 'error',
        error: msg,
      });
    }
    row.el.classList.remove(
      'is-loading',
      'is-ready',
      'iclaw-inline-banner--info',
      'iclaw-inline-banner--success',
    );
    row.el.classList.add('is-error', 'iclaw-inline-banner--error');
    const lead = row.el.querySelector('.iclaw-inline-banner__lead');
    if (lead) {
      lead.textContent = 'Failed to create task "' + title + '"';
    }
    const detail = row.el.querySelector('.iclaw-inline-banner__detail');
    if (detail) {
      detail.textContent = msg;
      detail.classList.remove('muted');
    }
    const actions = row.el.querySelector('.iclaw-inline-banner__actions');
    if (actions) {
      actions.outerHTML = buildTaskBannerActionsHtml({
        openDisabled: true,
        openSpinner: false,
        showDismiss: true,
      });
    }
    wireTaskBannerActions(pendingId, null);
    startTaskReadyBannerExpiry(pendingId);
  }

  function taskMatchesPendingRecord(task, rec) {
    if (!task || !rec || rec.status !== 'pending') return false;
    // Prefer matching by taskId — title can change after finishTaskAutoTitle runs
    if (rec.taskId != null) return Number(rec.taskId) === Number(task.id);
    if (rec.title !== task.title) return false;
    if (
      rec.sourceChatId != null &&
      task.source_chat_id != null &&
      task.source_chat_id !== rec.sourceChatId
    ) {
      return false;
    }
    return true;
  }

  /* A task is "materialised" once it has moved past the synchronous planning
   * window. Anything that isn't 'planning' means the server is done queueing
   * the task — pending banner is no longer needed. We used to gate this on
   * status === 'ready' only, which broke whenever the task skipped through
   * ready quickly (autorun, server-side autorun on fast-plan, WS race where the
   * 'ready' event arrived before the client subscribed). See iClaw bug report
   * "Task … is being created…" stuck for 30 min. */
  function isTaskMaterialised(status) {
    return typeof status === 'string' && status !== '' && status !== 'planning';
  }

  /* Silently drop the pending record/banner without showing the green "ready"
   * card. Used when the task has already moved past 'ready' (running, review,
   * etc.) — no point telling the user "your plan is ready" when it's been
   * running for a while. */
  function silentlyResolvePendingTaskCreate(pendingId) {
    if (pendingTaskCreateBanners.has(pendingId)) {
      removeTaskCreateBanner(pendingId);
    } else {
      removePendingTaskCreateRecord(pendingId);
    }
  }

  function finishPendingTaskCreateWhenReady(task) {
    if (!task || !isTaskMaterialised(task.status)) return;
    finishPendingTaskCreateFromWs(task);
  }

  function resolvePendingTaskCreateByTask(task) {
    if (!task || task.id == null || !isTaskMaterialised(task.status)) return false;
    const isReady = task.status === 'ready';
    const store = readPendingTaskCreatesStore();
    for (const rec of Object.values(store)) {
      if (!taskMatchesPendingRecord(task, rec)) continue;
      const merged = {
        ...rec,
        projectId: task.project_id ?? rec.projectId ?? null,
      };
      if (!isReady) {
        silentlyResolvePendingTaskCreate(rec.pendingId);
        return true;
      }
      if (shouldSuppressTaskReadyBanner(merged)) {
        removePendingTaskCreateRecord(rec.pendingId);
        return true;
      }
      if (!pendingTaskCreateBanners.has(rec.pendingId)) {
        showTaskCreatingBanner(rec.pendingId, rec.title, merged);
      }
      markTaskCreateBannerReady(rec.pendingId, task.id, rec.title);
      return true;
    }
    for (const [pendingId, row] of pendingTaskCreateBanners) {
      // Also try banners that already have a taskId but weren't caught above
      if (row.taskId != null) {
        if (Number(row.taskId) === Number(task.id)) {
          if (!isReady) {
            silentlyResolvePendingTaskCreate(pendingId);
          } else {
            markTaskCreateBannerReady(pendingId, task.id, row.title);
          }
          return true;
        }
        continue;
      }
      if (row.title !== task.title) continue;
      if (
        row.sourceChatId != null &&
        task.source_chat_id != null &&
        task.source_chat_id !== row.sourceChatId
      ) {
        continue;
      }
      if (!isReady) {
        silentlyResolvePendingTaskCreate(pendingId);
      } else {
        markTaskCreateBannerReady(pendingId, task.id, row.title);
      }
      return true;
    }
    return false;
  }

  function finishPendingTaskCreateFromWs(task) {
    resolvePendingTaskCreateByTask(task);
  }

  /* Active polling timers keyed by pendingId so we never start two for the
   * same record, and so we can stop them when the record gets resolved by
   * any other path (WS, manual dismiss, reconcile-on-hydrate). */
  const pendingTaskCreatePolls = new Map();

  function stopPendingTaskCreatePoll(pendingId) {
    const t = pendingTaskCreatePolls.get(pendingId);
    if (t) {
      clearTimeout(t);
      pendingTaskCreatePolls.delete(pendingId);
    }
  }

  /* Polling fallback when the WS 'ready' event is missed for any reason:
   *  - WS race on first connect (event flies before subscribe)
   *  - Task skipped through 'ready' too fast (autorun → 'running')
   *  - Transient WS disconnect during the planning window
   *
   * Cheap and bounded: ~10 attempts spaced 2s apart, total ~20s. Stops as
   * soon as the store entry disappears (someone else resolved it) or we
   * detect a materialised status. */
  function startPendingTaskCreatePoll(pendingId) {
    stopPendingTaskCreatePoll(pendingId);
    const MAX_ATTEMPTS = 10;
    const INTERVAL_MS = 2000;
    let attempt = 0;
    const tick = async () => {
      pendingTaskCreatePolls.delete(pendingId);
      const rec = readPendingTaskCreatesStore()[pendingId];
      if (!rec || rec.status !== 'pending') return; // resolved elsewhere
      attempt += 1;
      try {
        await reconcilePendingTaskCreate(rec);
      } catch {
        /* ignore, will retry */
      }
      const after = readPendingTaskCreatesStore()[pendingId];
      if (!after || after.status !== 'pending') return; // resolved
      if (attempt >= MAX_ATTEMPTS) return; // give up; hydrate/WS may still catch it
      const timer = setTimeout(tick, INTERVAL_MS);
      pendingTaskCreatePolls.set(pendingId, timer);
    };
    const timer = setTimeout(tick, INTERVAL_MS);
    pendingTaskCreatePolls.set(pendingId, timer);
  }

  async function reconcilePendingTaskCreate(rec) {
    if (!rec || rec.status !== 'pending') return;
    try {
      let match = null;
      /* Fast path: POST /tasks already gave us a taskId, so we can ask the
       * server for that one task instead of the whole list. Cheap regardless
       * of how many tasks the user has. */
      if (rec.taskId != null) {
        const res = await fetch('/tasks/' + encodeURIComponent(rec.taskId), {
          headers: { Accept: 'application/json' },
        });
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          if (data && data.task) match = data.task;
        } else if (res.status === 404) {
          /* Task got deleted between POST and reconcile (rare). Drop the
           * pending record so the banner doesn't loop forever. */
          silentlyResolvePendingTaskCreate(rec.pendingId);
          return;
        }
        /* Other non-OK statuses: fall through to the list endpoint as a
         * defensive retry — keeps reconcile working through transient errors. */
      }
      if (!match) {
        const res = await fetch('/tasks', { headers: { Accept: 'application/json' } });
        const data = await res.json().catch(() => ({}));
        const tasks = Array.isArray(data.tasks) ? data.tasks : [];
        const started = rec.createdAt || 0;
        match = tasks.find((t) => {
          // Prefer matching by taskId if already known (title can change after auto-title)
          if (rec.taskId != null) return Number(t.id) === Number(rec.taskId);
          if (t.title !== rec.title) return false;
          if (rec.sourceChatId != null && t.source_chat_id !== rec.sourceChatId) return false;
          const created = Date.parse(t.created_at || '');
          return !Number.isNaN(created) && created >= started - 5000;
        }) || null;
      }
      /* Any post-planning status is enough to resolve the pending record —
       * not just 'ready'. resolvePendingTaskCreateByTask handles the difference
       * between showing the success banner (ready) and silently clearing
       * (running/review/done/...). */
      if (match && isTaskMaterialised(match.status)) {
        resolvePendingTaskCreateByTask(match);
      }
    } catch {
      /* ignore */
    }
  }

  /* Called from the WS 'open' handler. We iterate every pending record (the
   * banner may not currently be in the DOM if the user navigated) and ask the
   * server for fresh task state. Records still in 'pending' get their polling
   * fallback restarted if it isn't already running, so we don't depend on a
   * second WS event arriving. */
  function reconcilePendingTaskCreatesAfterReconnect() {
    const store = readPendingTaskCreatesStore();
    for (const rec of Object.values(store)) {
      if (!rec || rec.status !== 'pending') continue;
      void reconcilePendingTaskCreate(rec);
      if (!pendingTaskCreatePolls.has(rec.pendingId)) {
        startPendingTaskCreatePoll(rec.pendingId);
      }
    }
  }

  function hydratePendingTaskCreateBanners() {
    const store = readPendingTaskCreatesStore();
    prunePendingTaskCreatesStore(store);
    writePendingTaskCreatesStore(store);
    const records = Object.values(store).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    for (const rec of records) {
      if (!rec || !rec.pendingId) continue;
      if (rec.status === 'pending') {
        showTaskCreatingBanner(rec.pendingId, rec.title, rec);
        reconcilePendingTaskCreate(rec);
        /* Restart the polling safety net for records that survived a tab
         * reload — the original poll timer lived only in the previous JS
         * runtime. Without this, a refresh while a task was stuck would
         * leave the banner up until PENDING_TASK_MAX_AGE_MS (30 min). */
        startPendingTaskCreatePoll(rec.pendingId);
      } else if (rec.status === 'ready' && rec.taskId) {
        if (shouldSuppressTaskReadyBanner(rec)) {
          removePendingTaskCreateRecord(rec.pendingId);
          continue;
        }
        showTaskCreatingBanner(rec.pendingId, rec.title, rec);
        markTaskCreateBannerReady(rec.pendingId, rec.taskId, rec.title);
      } else if (rec.status === 'error') {
        showTaskCreateBannerError(rec.pendingId, rec.title, rec.error || 'Error', rec);
      }
    }
  }

  async function submitCreateTask() {
    if (activeChatId == null || !createTaskGoal) return;
    const goal = createTaskGoal.value.trim();
    if (!goal) {
      alert('Enter a goal for the task.');
      createTaskGoal.focus();
      return;
    }
    /* Title is auto-generated server-side from the goal — placeholder here is
     * just for the "Creating task…" banner before the real title arrives.
     * Agent defaults to the source chat's agent (backend handles fallback). */
    const title = goal.slice(0, 60).replace(/\s+/g, ' ');
    const pendingId = 'tc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const sourceChatId = activeChatId;
    const projectId = currentComposerProjectId();
    upsertPendingTaskCreateRecord({
      pendingId,
      title,
      sourceChatId,
      projectId,
      status: 'pending',
      taskId: null,
      error: null,
      createdAt: Date.now(),
    });
    closeCreateTaskModal();
    clearComposerInput();
    showTaskCreatingBanner(pendingId, title, { sourceChatId, projectId });
    try {
      const res = await fetch('/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          sourceChatId: activeChatId,
          goal,
          /* Always generate a plan — no checkbox in the modal anymore. */
          generatePlan: true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      if (data.task && data.task.id) {
        const storeRec = readPendingTaskCreatesStore()[pendingId];
        if (storeRec) {
          upsertPendingTaskCreateRecord({
            ...storeRec,
            taskId: data.task.id,
            projectId: data.task.project_id ?? storeRec.projectId,
          });
        }
        const row = pendingTaskCreateBanners.get(pendingId);
        if (row) {
          row.taskId = data.task.id;
          row.projectId = data.task.project_id ?? row.projectId;
        }
        if (data.task.status === 'ready') {
          markTaskCreateBannerReady(pendingId, data.task.id, title);
        } else if (isTaskMaterialised(data.task.status)) {
          /* Server already moved the task past planning by the time we got the
           * response (very fast plan + autorun). Skip the banner-success path
           * and just clear the pending record so it doesn't haunt the UI. */
          silentlyResolvePendingTaskCreate(pendingId);
        } else {
          /* Still 'planning' — start the polling safety net in case the WS
           * 'ready' event flies before our subscription, or the task skips
           * through 'ready' too quickly. */
          startPendingTaskCreatePoll(pendingId);
        }
      }
    } catch (err) {
      const storeRec = readPendingTaskCreatesStore()[pendingId];
      if (storeRec && /failed to fetch/i.test(err instanceof Error ? err.message : String(err))) {
        await reconcilePendingTaskCreate(storeRec);
        const updated = readPendingTaskCreatesStore()[pendingId];
        if (updated?.taskId) {
          const row = pendingTaskCreateBanners.get(pendingId);
          if (row) row.projectId = updated.projectId ?? row.projectId;
          markTaskCreateBannerReady(pendingId, updated.taskId, title);
          return;
        }
      }
      markTaskCreateBannerError(pendingId, title, err);
    }
  }

  if (createTaskBackdrop) {
    createTaskBackdrop.addEventListener('click', closeCreateTaskModal);
  }
  if (createTaskCancel) {
    createTaskCancel.addEventListener('click', closeCreateTaskModal);
  }
  if (createTaskSubmit) {
    createTaskSubmit.addEventListener('click', () => submitCreateTask());
  }
  hydratePendingTaskCreateBanners();
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && createTaskModal && !createTaskModal.hidden) {
      closeCreateTaskModal();
    }
  });

  if (scheduleMenu) {
    scheduleMenu.addEventListener('click', (e) => {
      const btn = e.target.closest('.schedule-menu-item');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'open-schedule') {
        e.preventDefault();
        showScheduleMenuPanel('schedule');
        return;
      }
      if (action === 'schedule-back') {
        e.preventDefault();
        showScheduleMenuPanel('main');
        return;
      }
      if (action === 'create-task') {
        e.preventDefault();
        e.stopPropagation();
        closeScheduleMenu();
        openCreateTaskModal();
        return;
      }
      const offset = btn.dataset.offset;
      if (offset === 'custom') {
        openSchedulePicker(new Date(Date.now() + 60 * 60_000), (when) => submitScheduled(when));
        return;
      }
      const when = computeScheduledAt(offset);
      if (when) submitScheduled(when);
    });
  }

  if (scheduledListEl) {
    scheduledListEl.addEventListener('click', async (e) => {
      if (handlePendingRowToggleClick(e)) return;
      const sendNowBtn = e.target.closest('.scheduled-item-send-now');
      if (sendNowBtn) {
        const sid = Number(sendNowBtn.dataset.scheduledId);
        if (!Number.isFinite(sid) || activeChatId == null) return;
        await sendScheduledNow(sid);
        return;
      }
      const editBtn = e.target.closest('.scheduled-item-edit');
      if (editBtn) {
        const row = editBtn.closest('.scheduled-item');
        beginEditScheduled(row);
        return;
      }
      const btn = e.target.closest('.scheduled-item-cancel');
      if (!btn) return;
      const sid = Number(btn.dataset.scheduledId);
      if (!Number.isFinite(sid) || activeChatId == null) return;
      if (editingScheduledId === sid) editingScheduledId = null;
      removeScheduledItem(sid);
      try {
        await fetch(
          '/chats/' + encodeURIComponent(activeChatId) +
            '/scheduled/' + encodeURIComponent(sid) + '/delete',
          { method: 'POST' },
        );
      } catch {
        /* silent */
      }
    });
    sortScheduledListDom();
    refreshScheduledTimes();
    // Server-rendered rows (first paint) need the same overflow measurement.
    scheduledListEl.querySelectorAll('.scheduled-item').forEach(applyPendingRowClamp);
  }

  // -------------------------------------------------------------------------
  // send-button discovery pill — surfaces the long-press menu (scheduled
  // message / create task) for users who haven't crossed the usage threshold
  // yet. Server only renders the element when eligible; this block is
  // responsible for once-per-day throttling and auto-dismiss.
  // -------------------------------------------------------------------------
  (function setupSendHintPill() {
    const pill = document.getElementById('send-hint-pill');
    if (!pill) return; // server decided not to surface it

    const STORAGE_KEY = 'iclaw-send-hint-last-shown';
    const AUTO_HIDE_MS = 12_000;

    function todayKey() {
      const d = new Date();
      return (
        d.getFullYear() +
        '-' +
        String(d.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(d.getDate()).padStart(2, '0')
      );
    }

    let lastShown = null;
    try {
      lastShown = localStorage.getItem(STORAGE_KEY);
    } catch {
      // Private mode / storage disabled — treat as "never shown".
    }
    if (lastShown === todayKey()) return; // already shown today

    try {
      localStorage.setItem(STORAGE_KEY, todayKey());
    } catch {
      // ignore — we'll just nag again next page-load in that session
    }

    let hideTimer = null;
    function hidePill() {
      if (hideTimer != null) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      if (pill.parentNode) pill.parentNode.removeChild(pill);
    }

    pill.hidden = false;
    hideTimer = setTimeout(hidePill, AUTO_HIDE_MS);

    // Дрібні сигнали, що юзер зорієнтувався: почав писати або тицьнув send.
    // Без цього pill «висить» поки таймер не догорить, що відволікає.
    const input = document.getElementById('composer-input');
    if (input) input.addEventListener('focus', hidePill, { once: true });
    if (sendBtn) sendBtn.addEventListener('pointerdown', hidePill, { once: true });
  })();

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
      // Incognito has no DB chat — abort by ephemeral key and finalize locally.
      if (getComposerMode() === 'incognito' && activeIncognitoKey) {
        wsSend({ type: 'incognito-abort', key: activeIncognitoKey });
        finalizeIncognitoStream();
        stopBtn.disabled = true;
        setTimeout(() => { stopBtn.disabled = false; }, 3000);
        return;
      }
      if (activeChatId == null) return;
      wsSend({ type: 'abort', chatId: activeChatId });
      // Optimistically disable until server confirms via turn-error/ended,
      // so a frustrated double-click doesn't spam the gateway.
      stopBtn.disabled = true;
      setTimeout(() => { stopBtn.disabled = false; }, 3000);
    });
  }

  // -------------------------------------------------------------------------
  // Daily-reset policy banner — surfaces when OpenClaw's default "reset every
  // morning at 04:00" policy is active for `direct` (dashboard) sessions.
  // One-click fix via /api/gateway/session-reset-fix; if the gateway token
  // lacks admin scope we degrade to a copy-pasteable snippet for openclaw.json.
  //
  // Snooze model: instead of a permanent dismiss, "Remind me in 3 days" stores
  // a timestamp in localStorage and the banner stays hidden until that point.
  // The × in the corner sets a far-future snooze (effectively never).
  // -------------------------------------------------------------------------
  const RESET_REMIND_KEY = 'iclaw:resetPolicyRemindAfter';
  const SNOOZE_DAYS = 3;
  const NEVER_REMIND_MS = 100 * 365 * 24 * 60 * 60 * 1000;
  const RESET_POLICY_MANUAL_PATCH = JSON.stringify(
    {
      session: {
        resetByType: {
          direct: { mode: 'idle', idleMinutes: 52560000 },
          group: { mode: 'idle', idleMinutes: 52560000 },
          thread: { mode: 'idle', idleMinutes: 52560000 },
        },
      },
    },
    null,
    2,
  );
  const RESET_POLICY_CLI_COMMAND =
    "openclaw config patch --stdin <<'EOF'\n" +
    RESET_POLICY_MANUAL_PATCH +
    "\nEOF\nopenclaw gateway restart";

  const resetBanner = document.getElementById('reset-policy-banner');
  const resetBannerActions = document.getElementById('reset-policy-banner-actions');
  const resetBannerBody = document.getElementById('reset-policy-banner-body');
  const resetFixBtn = document.getElementById('reset-policy-fix');
  const resetSnoozeBtn = document.getElementById('reset-policy-snooze');
  const resetConfirm = document.getElementById('reset-policy-confirm');
  const resetConfirmBackdrop = document.getElementById('reset-policy-confirm-backdrop');
  const resetConfirmCancel = document.getElementById('reset-policy-confirm-cancel');
  const resetConfirmOk = document.getElementById('reset-policy-confirm-ok');

  function snoozeResetBanner(ms) {
    try {
      const until = Date.now() + ms;
      localStorage.setItem(RESET_REMIND_KEY, String(until));
    } catch {}
  }

  function isResetBannerSnoozed() {
    try {
      const raw = localStorage.getItem(RESET_REMIND_KEY);
      if (!raw) return false;
      const until = Number(raw);
      if (!Number.isFinite(until)) return false;
      return Date.now() < until;
    } catch {
      return false;
    }
  }

  function hideResetBanner() {
    if (resetBanner) resetBanner.hidden = true;
  }

  function showResetBannerFixed() {
    if (!resetBannerBody || !resetBannerActions) return;
    resetBannerBody.innerHTML =
      '<p class="iclaw-inline-banner__lead">Done ✓</p>' +
      '<p class="iclaw-inline-banner__detail">OpenClaw will no longer reset chats daily.</p>';
    resetBannerActions.innerHTML = '';
    // Banner already explains the success — auto-close after a beat.
    setTimeout(hideResetBanner, 2400);
  }

  function bindResetPolicyCopyButton(btnId, statusId, text, preId) {
    document.getElementById(btnId)?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        const s = document.getElementById(statusId);
        if (s) {
          s.textContent = '✓ copied';
          setTimeout(() => { s.textContent = ''; }, 2000);
        }
      } catch {
        const pre = document.getElementById(preId);
        if (pre) {
          const range = document.createRange();
          range.selectNodeContents(pre);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
      }
    });
  }

  function showResetBannerManualFallback() {
    if (!resetBannerBody || !resetBannerActions) return;
    resetBannerBody.innerHTML =
      '<p class="iclaw-inline-banner__lead">Automatic setup failed — the gateway token needs admin scope.</p>' +
      '<p class="iclaw-inline-banner__detail">' +
      'Run this in your terminal (same machine as OpenClaw), or paste the JSON into ' +
      '<code>~/.openclaw/openclaw.json</code> under <code>session</code> and restart the gateway.' +
      '</p>' +
      '<div class="reset-policy-manual">' +
      '<p class="reset-policy-manual-label muted">Terminal</p>' +
      '<pre id="reset-policy-cli">' +
      escapeHtml(RESET_POLICY_CLI_COMMAND) +
      '</pre>' +
      '<div class="reset-policy-manual-row">' +
      '<button type="button" class="btn btn--ghost btn--sm" id="reset-policy-copy-cli">Copy command</button>' +
      '<span class="muted" id="reset-policy-copy-cli-status"></span>' +
      '</div>' +
      '<p class="reset-policy-manual-label muted">Or edit openclaw.json</p>' +
      '<pre id="reset-policy-snippet">' +
      escapeHtml(RESET_POLICY_MANUAL_PATCH) +
      '</pre>' +
      '<div class="reset-policy-manual-row">' +
      '<button type="button" class="btn btn--ghost btn--sm" id="reset-policy-copy">Copy JSON</button>' +
      '<span class="muted" id="reset-policy-copy-status"></span>' +
      '</div>' +
      '</div>';
    resetBannerActions.innerHTML = '';
    bindResetPolicyCopyButton(
      'reset-policy-copy-cli',
      'reset-policy-copy-cli-status',
      RESET_POLICY_CLI_COMMAND,
      'reset-policy-cli',
    );
    bindResetPolicyCopyButton(
      'reset-policy-copy',
      'reset-policy-copy-status',
      RESET_POLICY_MANUAL_PATCH,
      'reset-policy-snippet',
    );
  }

  async function probeResetPolicyAndMaybeShowBanner() {
    if (!resetBanner) return;
    if (isResetBannerSnoozed()) return;
    try {
      const res = await fetch('/api/gateway/session-reset-status', {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data?.defaultPolicyActive === true) {
        resetBanner.hidden = false;
      }
    } catch {
      // Network/gateway hiccup — silently skip. Banner shows on next page load.
    }
  }

  if (resetFixBtn) {
    resetFixBtn.addEventListener('click', async () => {
      const original = resetFixBtn.textContent;
      resetFixBtn.disabled = true;
      resetFixBtn.textContent = '⏳ Applying…';
      try {
        const res = await fetch('/api/gateway/session-reset-fix', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) {
          // Permanent — no need to remind again.
          snoozeResetBanner(NEVER_REMIND_MS);
          showResetBannerFixed();
          return;
        }
        if (data?.reason === 'no-admin-scope') {
          showResetBannerManualFallback();
          return;
        }
        throw new Error(data?.error || 'HTTP ' + res.status);
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        if (/missing scope|forbidden|unauthor|admin/i.test(msg)) {
          showResetBannerManualFallback();
        } else if (resetBannerBody) {
          resetBannerBody.innerHTML =
            '<strong>Could not apply settings.</strong>' +
            '<span class="muted">' + escapeHtml(msg) + '</span>';
        }
        resetFixBtn.disabled = false;
        resetFixBtn.textContent = original;
      }
    });
  }
  function openResetPolicyConfirm() {
    if (!resetConfirm) return;
    resetConfirm.hidden = false;
    resetConfirmOk?.focus();
  }

  function closeResetPolicyConfirm() {
    if (resetConfirm) resetConfirm.hidden = true;
  }

  function confirmResetPolicySnooze() {
    snoozeResetBanner(SNOOZE_DAYS * 24 * 60 * 60 * 1000);
    closeResetPolicyConfirm();
    hideResetBanner();
  }

  if (resetSnoozeBtn) {
    resetSnoozeBtn.addEventListener('click', () => {
      openResetPolicyConfirm();
    });
  }
  if (resetConfirmOk) {
    resetConfirmOk.addEventListener('click', () => {
      confirmResetPolicySnooze();
    });
  }
  if (resetConfirmCancel) {
    resetConfirmCancel.addEventListener('click', () => {
      closeResetPolicyConfirm();
    });
  }
  if (resetConfirmBackdrop) {
    resetConfirmBackdrop.addEventListener('click', () => {
      closeResetPolicyConfirm();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !resetConfirm || resetConfirm.hidden) return;
    e.preventDefault();
    closeResetPolicyConfirm();
  });
  // Fire probe once on load. Don't block anything else.
  probeResetPolicyAndMaybeShowBanner();

  // -------------------------------------------------------------------------
  // npm update banner — installed from __ICLAW_VERSION__, latest from registry
  // -------------------------------------------------------------------------
  const NPM_REGISTRY_LATEST =
    'https://registry.npmjs.org/@iclawapp%2Ficlaw/latest';
  const UPDATE_CHECK_STORAGE_KEY = 'iclaw-update-registry-check';
  const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

  const updateBanner = document.getElementById('sidebar-update-banner');
  const updateBannerStatus = document.getElementById('sidebar-update-status');
  const updateBannerRun = document.getElementById('sidebar-update-run');

  function compareSemver(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  }

  function readRegistryCheckCache() {
    try {
      const raw = localStorage.getItem(UPDATE_CHECK_STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (typeof data.latest !== 'string' || typeof data.checkedAt !== 'number') {
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  function writeRegistryCheckCache(latest) {
    try {
      localStorage.setItem(
        UPDATE_CHECK_STORAGE_KEY,
        JSON.stringify({ latest, checkedAt: Date.now() }),
      );
    } catch {
      /* private mode / quota */
    }
  }

  async function probeNpmUpdateAndMaybeShowBanner() {
    if (!updateBanner) return;
    const installed =
      typeof window.__ICLAW_VERSION__ === 'string'
        ? window.__ICLAW_VERSION__.trim()
        : '';
    if (!installed) return;

    let latest = null;
    const cached = readRegistryCheckCache();
    const cacheFresh =
      cached && Date.now() - cached.checkedAt < UPDATE_CHECK_TTL_MS;
    if (cacheFresh) {
      latest = cached.latest;
    } else {
      try {
        const res = await fetch(NPM_REGISTRY_LATEST, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (typeof data.version !== 'string' || !data.version.trim()) return;
        latest = data.version.trim();
        writeRegistryCheckCache(latest);
      } catch {
        if (cached?.latest) latest = cached.latest;
        else return;
      }
    }

    if (!latest || compareSemver(latest, installed) <= 0) return;

    updateBanner.hidden = false;
  }

  if (updateBannerRun) {
    updateBannerRun.addEventListener('click', async () => {
      if (updateBannerRun.disabled) return;
      const prevLabel = updateBannerRun.textContent;
      updateBannerRun.disabled = true;
      updateBannerRun.textContent = 'Updating…';
      if (updateBannerStatus) {
        updateBannerStatus.textContent = 'You can keep chatting';
      }
      try {
        const res = await fetch('/api/update/run', {
          method: 'POST',
          headers: { Accept: 'application/json' },
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error || 'HTTP ' + res.status);
        }
        if (updateBannerStatus) {
          updateBannerStatus.textContent = 'When done, open iClaw again';
        }
        updateBannerRun.textContent = 'Updating…';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (updateBannerStatus) {
          updateBannerStatus.textContent = msg;
        }
        updateBannerRun.disabled = false;
        updateBannerRun.textContent = prevLabel || 'Update now';
      }
    });
  }

  void probeNpmUpdateAndMaybeShowBanner();

  // -------------------------------------------------------------------------
  // Exec approval cards (gateway → operator)
  // -------------------------------------------------------------------------
  function renderApprovalCard(opts) {
    if (!messagesEl) return;
    clearEmptyState();
    const existing = messagesEl.querySelector(
      '.exec-approval-card[data-approval-id="' + opts.approvalId + '"]',
    );
    if (existing) return;
    const card = document.createElement('div');
    card.className = 'msg system exec-approval-card';
    card.dataset.approvalId = opts.approvalId;
    const safeCmd = escapeHtml(opts.command || '(no command text)');
    const cwdLine = opts.cwd
      ? '<div class="exec-approval-cwd">cwd: <code>' + escapeHtml(opts.cwd) + '</code></div>'
      : '';
    const reasonLine = opts.reason
      ? '<div class="exec-approval-reason">' + escapeHtml(opts.reason) + '</div>'
      : '';
    card.innerHTML =
      '<div class="exec-approval-shell">' +
      '<div class="exec-approval-head">' +
      '<span class="exec-approval-icon" aria-hidden="true">🔐</span>' +
      '<span class="exec-approval-title">Command execution approval</span>' +
      '<span class="exec-approval-host">' + escapeHtml(opts.host || 'gateway') + '</span>' +
      '</div>' +
      '<pre class="exec-approval-cmd"><code>' + safeCmd + '</code></pre>' +
      cwdLine + reasonLine +
      '<div class="exec-approval-actions">' +
      '<button type="button" class="exec-approval-btn exec-approval-deny btn btn--danger btn--sm" data-decision="denied">Deny</button>' +
      '<button type="button" class="exec-approval-btn exec-approval-approve btn btn--approve btn--sm" data-decision="approved">Allow</button>' +
      '</div>' +
      '</div>';
    messagesAppendRoot().appendChild(card);
    scrollToBottom();
  }
  function removeApprovalCard(approvalId, decision) {
    if (!messagesEl) return;
    const card = messagesEl.querySelector(
      '.exec-approval-card[data-approval-id="' + approvalId + '"]',
    );
    if (!card) return;
    // If we know the decision, leave a small "decided" trace before removal so
    // the user sees what they chose; otherwise just drop it silently.
    if (decision) {
      const trace = document.createElement('div');
      trace.className = 'msg system exec-approval-trace';
      const label = decision === 'approved' ? '✓ Approved' : '✕ Denied';
      trace.innerHTML = '<div class="msg-body muted">' + escapeHtml(label) + '</div>';
      card.replaceWith(trace);
      // Auto-fade after a moment
      setTimeout(() => trace.remove(), 6_000);
    } else {
      card.remove();
    }
  }
  if (messagesEl) {
    messagesEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.exec-approval-btn');
      if (!btn) return;
      const card = btn.closest('.exec-approval-card');
      if (!card) return;
      const approvalId = card.dataset.approvalId;
      const decision = btn.dataset.decision === 'denied' ? 'denied' : 'approved';
      if (!approvalId || activeChatId == null) return;
      // Disable buttons to prevent double-clicks while the RPC resolves.
      card.querySelectorAll('.exec-approval-btn').forEach((b) => (b.disabled = true));
      wsSend({ type: 'exec-approval', chatId: activeChatId, approvalId, decision });
    });
  }

  // -------------------------------------------------------------------------
  // Slash autocomplete (`/` at composer start → commands.list)
  // -------------------------------------------------------------------------
  /** @type {Array<{name:string,description:string,aliases:string[]}>} */
  let commandCatalog = [];
  let commandsLoaded = false;
  let slashMenuEl = null;
  let slashActiveIndex = 0;
  /** @type {Array<{name:string,description:string}>} */
  let slashFiltered = [];

  async function ensureCommandsLoaded() {
    if (commandsLoaded) return;
    commandsLoaded = true;
    try {
      const agent = document.getElementById('chat-agent-select')?.value || '';
      const url = '/api/gateway/commands' + (agent ? '?agent=' + encodeURIComponent(agent) : '');
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const data = await res.json();
      commandCatalog = Array.isArray(data.commands) ? data.commands : [];
    } catch {
      commandCatalog = [];
    }
  }
  function buildSlashMenu() {
    if (slashMenuEl) return slashMenuEl;
    slashMenuEl = document.createElement('div');
    slashMenuEl.id = 'slash-menu';
    slashMenuEl.className = 'slash-menu';
    slashMenuEl.hidden = true;
    const composer = document.querySelector('.composer-field');
    if (composer) composer.appendChild(slashMenuEl);
    return slashMenuEl;
  }
  function closeSlashMenu() {
    if (slashMenuEl) slashMenuEl.hidden = true;
    slashFiltered = [];
    slashActiveIndex = 0;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (isScheduleMenuOpen()) {
      closeScheduleMenu();
      return;
    }
    const shareModal = document.getElementById('share-modal');
    if (shareModal && !shareModal.hidden) return;
    const logoPop = document.getElementById('project-logo-popover');
    const logoTrig = document.getElementById('project-logo-trigger');
    if (logoPop && !logoPop.hidden) {
      logoPop.hidden = true;
      if (logoTrig) logoTrig.setAttribute('aria-expanded', 'false');
      return;
    }
    if (sidebarToolbar?.classList.contains('is-search-open')) {
      closeSidebarSearchPanel();
      return;
    }
    if (!sidebarChatMenu.hidden) {
      closeSidebarChatMenu();
      return;
    }
    const selFab = document.getElementById('msg-selection-reply-fab');
    if (selFab && !selFab.hidden) {
      hideSelectionReplyFab();
      const sel = window.getSelection();
      if (sel) sel.removeAllRanges();
      return;
    }
    if (slashMenuEl && !slashMenuEl.hidden) {
      closeSlashMenu();
      return;
    }
    if (pendingComposerReply) {
      pendingComposerReply = null;
      updateComposerReplyBar();
      return;
    }
    const taskAskModal = document.getElementById('task-ask-modal');
    if (taskAskModal && !taskAskModal.hidden) return;
    if (location.pathname === '/' || location.pathname === '') return;
    goTo('/');
  });

  function renderSlashMenu() {
    const m = buildSlashMenu();
    if (slashFiltered.length === 0) {
      closeSlashMenu();
      return;
    }
    m.replaceChildren();
    slashFiltered.forEach((c, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'slash-item' + (i === slashActiveIndex ? ' active' : '');
      row.dataset.name = c.name;
      row.innerHTML =
        '<span class="slash-item-name">/' + escapeHtml(c.name) + '</span>' +
        (c.description ? '<span class="slash-item-desc">' + escapeHtml(c.description) + '</span>' : '');
      m.appendChild(row);
    });
    m.hidden = false;
  }
  function pickSlashCommand(name) {
    if (!input) return;
    input.value = '/' + name + ' ';
    closeSlashMenu();
    input.focus();
  }
  function updateSlashFromInput() {
    if (!input) return;
    const v = input.value;
    if (!v.startsWith('/')) {
      closeSlashMenu();
      return;
    }
    // Only autocomplete the first token; once user typed a space we hide.
    const firstSpace = v.indexOf(' ');
    if (firstSpace !== -1) {
      closeSlashMenu();
      return;
    }
    const needle = v.slice(1).toLowerCase();
    void ensureCommandsLoaded().then(() => {
      slashFiltered = commandCatalog
        .filter((c) => c.name.toLowerCase().startsWith(needle))
        .slice(0, 12);
      slashActiveIndex = 0;
      renderSlashMenu();
    });
  }
  if (input) {
    input.addEventListener('input', updateSlashFromInput);
    input.addEventListener('keydown', (e) => {
      if (!slashMenuEl || slashMenuEl.hidden) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        slashActiveIndex = (slashActiveIndex + 1) % Math.max(slashFiltered.length, 1);
        renderSlashMenu();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        slashActiveIndex =
          (slashActiveIndex - 1 + slashFiltered.length) % Math.max(slashFiltered.length, 1);
        renderSlashMenu();
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        const pick = slashFiltered[slashActiveIndex];
        if (pick) {
          e.preventDefault();
          pickSlashCommand(pick.name);
        }
      } else if (e.key === 'Escape') {
        closeSlashMenu();
      }
    });
  }
  document.addEventListener('click', (e) => {
    if (!slashMenuEl || slashMenuEl.hidden) return;
    if (slashMenuEl.contains(e.target)) {
      const item = e.target.closest('.slash-item');
      if (item) pickSlashCommand(item.dataset.name);
      return;
    }
    if (input?.contains(e.target)) return;
    closeSlashMenu();
  });

  // -------------------------------------------------------------------------
  // project page — facts list (fetch + WS sync from other tabs)
  // -------------------------------------------------------------------------
  const projectPageId = currentProjectPageId();
  const factsListEl = document.getElementById('facts-list');
  if (factsListEl && projectPageId != null) {
    factsListEl.querySelectorAll('.fact-content').forEach((ta) => {
      ta.dataset.saved = ta.value.trim();
    });
    factsListEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.fact-delete');
      if (!btn) return;
      const li = btn.closest('li.fact');
      const factId = li?.dataset.factId;
      if (!factId) return;
      e.preventDefault();
      fetch(
        '/projects/' +
          encodeURIComponent(projectPageId) +
          '/facts/' +
          encodeURIComponent(factId) +
          '/delete',
        { method: 'POST', headers: { Accept: 'application/json' } },
      ).catch(() => {});
    });
    factsListEl.addEventListener(
      'blur',
      (e) => {
        const ta = e.target.closest('.fact-content');
        if (!ta || !factsListEl.contains(ta)) return;
        const li = ta.closest('li.fact');
        const factId = li?.dataset.factId;
        if (!factId) return;
        const next = ta.value.trim();
        if (!next) return;
        if (next === (ta.dataset.saved || '').trim()) return;
        fetch(
          '/projects/' + encodeURIComponent(projectPageId) + '/facts/' + encodeURIComponent(factId),
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ content: next }),
          },
        )
          .then((res) => {
            if (res.ok) ta.dataset.saved = next;
          })
          .catch(() => {});
      },
      true,
    );
  }

  // -------------------------------------------------------------------------
  // project page — skills list (fetch + WS sync from other tabs)
  // -------------------------------------------------------------------------
  const skillsListEl = document.getElementById('skills-list');
  if (skillsListEl && projectPageId != null) {
    skillsListEl
      .querySelectorAll('.skill-name, .skill-description, .skill-body')
      .forEach((el) => {
        el.dataset.saved = el.value.trim();
      });
    skillsListEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.skill-delete');
      if (!btn) return;
      const li = btn.closest('li.skill');
      const skillId = li?.dataset.skillId;
      if (!skillId) return;
      e.preventDefault();
      fetch(
        '/projects/' +
          encodeURIComponent(projectPageId) +
          '/skills/' +
          encodeURIComponent(skillId) +
          '/delete',
        { method: 'POST', headers: { Accept: 'application/json' } },
      ).catch(() => {});
    });
    skillsListEl.addEventListener(
      'blur',
      (e) => {
        const el = e.target.closest('.skill-name, .skill-description, .skill-body');
        if (!el || !skillsListEl.contains(el)) return;
        const li = el.closest('li.skill');
        const skillId = li?.dataset.skillId;
        if (!skillId) return;
        const next = el.value.trim();
        if (!next) return;
        if (next === (el.dataset.saved || '').trim()) return;
        const field = el.classList.contains('skill-name')
          ? 'name'
          : el.classList.contains('skill-description')
            ? 'description'
            : 'body';
        const payload = {};
        payload[field] = next;
        fetch(
          '/projects/' +
            encodeURIComponent(projectPageId) +
            '/skills/' +
            encodeURIComponent(skillId),
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(payload),
          },
        )
          .then((res) => {
            if (res.ok) el.dataset.saved = next;
          })
          .catch(() => {});
      },
      true,
    );
  }

  function collapseProjectSecretRow(li) {
    li.classList.remove('project-secret-row--revealed');
    const preview = li.querySelector('.project-secret-reveal');
    if (preview) preview.hidden = false;
    const plain = li.querySelector('.project-secret-revealed');
    if (plain) {
      plain.hidden = true;
      plain.textContent = '';
    }
  }

  function revealProjectSecretRow(li, valueText) {
    const preview = li.querySelector('.project-secret-reveal');
    if (preview) preview.hidden = true;
    let plain = li.querySelector('.project-secret-revealed');
    if (!plain) {
      plain = document.createElement('span');
      plain.className = 'project-secret-revealed iclaw-secret-revealed';
      plain.setAttribute('role', 'button');
      plain.setAttribute('tabindex', '0');
      plain.setAttribute('title', 'Click to hide');
      preview?.insertAdjacentElement('afterend', plain);
    }
    plain.textContent = valueText != null ? String(valueText) : '';
    plain.hidden = false;
    li.classList.add('project-secret-row--revealed');
  }

  const secretsListEl = document.getElementById('secrets-list');
  if (secretsListEl && projectPageId != null) {
    secretsListEl.addEventListener('click', (e) => {
      const revealed = e.target.closest('.project-secret-revealed');
      if (revealed && secretsListEl.contains(revealed)) {
        e.preventDefault();
        const li = revealed.closest('li.project-secret-row');
        if (li) collapseProjectSecretRow(li);
        return;
      }
      const revealBtn = e.target.closest('.project-secret-reveal');
      if (revealBtn && secretsListEl.contains(revealBtn)) {
        e.preventDefault();
        const li = revealBtn.closest('li.project-secret-row');
        const sid = li?.dataset.secretId;
        if (!li || !sid || li.classList.contains('project-secret-row--revealed')) return;
        const cached = li.dataset.secretValue;
        if (cached) {
          revealProjectSecretRow(li, cached);
          return;
        }
        void fetch(
          '/projects/' +
            encodeURIComponent(projectPageId) +
            '/secrets/' +
            encodeURIComponent(sid) +
            '/value',
          { headers: { Accept: 'application/json' } },
        )
          .then((res) => {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then((data) => {
            const val = data && data.value != null ? String(data.value) : '';
            li.dataset.secretValue = val;
            revealProjectSecretRow(li, val);
          })
          .catch(() => {
            revealProjectSecretRow(li, '(could not load)');
          });
        return;
      }
    });
  }

  const projectLogoTrigger = document.getElementById('project-logo-trigger');
  const projectLogoPopover = document.getElementById('project-logo-popover');
  function closeProjectLogoPopover() {
    if (!projectLogoPopover || !projectLogoTrigger) return;
    projectLogoPopover.hidden = true;
    projectLogoTrigger.setAttribute('aria-expanded', 'false');
  }
  function openProjectLogoPopover() {
    if (!projectLogoPopover || !projectLogoTrigger) return;
    projectLogoPopover.hidden = false;
    projectLogoTrigger.setAttribute('aria-expanded', 'true');
  }
  if (projectLogoTrigger && projectLogoPopover && projectPageId != null) {
    projectLogoTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!projectLogoPopover.hidden) closeProjectLogoPopover();
      else openProjectLogoPopover();
    });
    projectLogoPopover.addEventListener('click', (e) => {
      const emBtn = e.target.closest('.project-logo-swatch--emoji');
      if (emBtn) {
        const id = Number(emBtn.dataset.logoEmoji);
        if (!Number.isFinite(id)) return;
        const inner = document.querySelector('.project-logo-trigger .project-logo');
        const cur = inner ? readLogoFromEl(inner) : { ei: 0, ci: 0 };
        syncProjectPageHeaderLogo(id, cur.ci);
        fetch('/projects/' + encodeURIComponent(projectPageId), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ logoEmoji: id }),
        }).catch(() => {});
        return;
      }
      const colBtn = e.target.closest('.project-logo-swatch--color');
      if (colBtn) {
        const id = Number(colBtn.dataset.logoColor);
        if (!Number.isFinite(id)) return;
        const inner = document.querySelector('.project-logo-trigger .project-logo');
        const cur = inner ? readLogoFromEl(inner) : { ei: 0, ci: 0 };
        syncProjectPageHeaderLogo(cur.ei, id);
        fetch('/projects/' + encodeURIComponent(projectPageId), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ logoColor: id }),
        }).catch(() => {});
      }
    });
    document.addEventListener('click', (e) => {
      if (!projectLogoPopover || projectLogoPopover.hidden) return;
      if (projectLogoTrigger.contains(e.target)) return;
      if (projectLogoPopover.contains(e.target)) return;
      closeProjectLogoPopover();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeProjectLogoPopover();
    });
  }

  function initProjectPageTabs() {
    const root = document.querySelector('main.project-page[data-project-id]');
    if (!root) return;
    const tabs = root.querySelectorAll('[data-project-tab]');
    const panels = {
      chats: document.getElementById('project-panel-chats'),
      memory: document.getElementById('project-panel-memory'),
      skills: document.getElementById('project-panel-skills'),
      links: document.getElementById('project-panel-links'),
      files: document.getElementById('project-panel-files'),
      secrets: document.getElementById('project-panel-secrets'),
    };
    if (
      !tabs.length ||
      !panels.chats ||
      !panels.memory ||
      !panels.skills ||
      !panels.links ||
      !panels.files ||
      !panels.secrets
    )
      return;

    function activate(name) {
      tabs.forEach((btn) => {
        const on = btn.getAttribute('data-project-tab') === name;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-selected', on ? 'true' : 'false');
        btn.tabIndex = on ? 0 : -1;
      });
      Object.keys(panels).forEach((k) => {
        const el = panels[k];
        if (!el) return;
        const on = k === name;
        el.classList.toggle('project-panel--active', on);
        el.hidden = !on;
      });
      refreshProjectTabLabels(name);
    }

    tabs.forEach((btn) => {
      btn.addEventListener('click', () => {
        const name = btn.getAttribute('data-project-tab');
        if (!name || !panels[name]) return;
        activate(name);
      });
    });
  }

  function tasksBoardQueryFromFilterValue(value) {
    const v = String(value ?? '').trim();
    if (!v) return '';
    if (v === 'orphan') return '?orphan=1';
    return '?projectId=' + encodeURIComponent(v);
  }

  function initTasksBoardPage() {
    const sel = document.getElementById('task-project-filter');
    if (!sel) return;
    sel.addEventListener('change', () => {
      goTo('/tasks' + tasksBoardQueryFromFilterValue(sel.value));
    });
  }

  const TASK_BOARD_COLS = [
    { key: 'ready', label: 'Ready' },
    { key: 'running', label: 'Running' },
    { key: 'needs_human', label: 'Your turn' },
    { key: 'review', label: 'Review' },
    { key: 'done', label: 'Done' },
  ];

  const TASK_APPROVE_RUN_FLASH_KEY = 'iclaw.taskApproveRun.v1';
  const TASK_RESUME_FLASH_KEY = 'iclaw.taskResumeFlash.v1';
  const TASK_RETRY_FLASH_KEY = 'iclaw.taskRetryFlash.v1';
  let boardFlashBannerEl = null;
  let boardFlashDismissTimer = null;
  let taskDetailSyncFingerprint = null;
  let taskDetailReloadTimer = null;

  function taskDetailFingerprint(task) {
    if (!task) return '';
    const steps = Array.isArray(task.steps) ? task.steps : [];
    return [
      task.status,
      task.current_step_title || '',
      steps
        .map((s) => String(s.id) + ':' + (s.status || '') + ':' + (s.result_summary || ''))
        .join(','),
    ].join('|');
  }

  function scheduleTaskDetailReload() {
    if (taskDetailReloadTimer != null) return;
    taskDetailReloadTimer = window.setTimeout(() => {
      taskDetailReloadTimer = null;
      window.location.reload();
    }, 400);
  }

  function applyTaskDetailRemoteTask(task) {
    const taskRoot = document.querySelector('.task-page[data-task-id]');
    if (!taskRoot || !task || Number(taskRoot.dataset.taskId) !== Number(task.id)) return;
    /* Title can change independently (background auto-title, manual rename
     * from another tab). Update in place — no reload — since the title isn't
     * part of taskDetailFingerprint. Skip if the user is currently editing. */
    const inp = taskRoot.querySelector('#task-title-input');
    if (inp && task.title && document.activeElement !== inp) {
      if (inp.defaultValue !== task.title) {
        inp.defaultValue = task.title;
        inp.value = task.title;
        document.title = task.title + ' — iClaw';
      }
    }
    const fp = taskDetailFingerprint(task);
    if (taskDetailSyncFingerprint == null) {
      taskDetailSyncFingerprint = fp;
      return;
    }
    if (fp !== taskDetailSyncFingerprint) scheduleTaskDetailReload();
  }

  function showBoardFlashBanner(opts) {
    const lead = opts && opts.lead ? String(opts.lead) : '';
    const detail = opts && opts.detail ? String(opts.detail) : '';
    const variant =
      opts && opts.variant === 'info'
        ? 'info'
        : opts && opts.variant === 'error'
          ? 'error'
          : 'success';
    const host = getTaskCreateBannerHost();
    if (boardFlashDismissTimer != null) {
      clearTimeout(boardFlashDismissTimer);
      boardFlashDismissTimer = null;
    }
    if (boardFlashBannerEl) boardFlashBannerEl.remove();
    const el = document.createElement('aside');
    el.className = 'iclaw-inline-banner iclaw-inline-banner--' + variant + ' card';
    el.setAttribute('role', 'status');
    el.innerHTML =
      '<div class="iclaw-inline-banner__main">' +
      '<p class="iclaw-inline-banner__lead">' +
      escapeHtml(lead) +
      '</p>' +
      (detail
        ? '<p class="iclaw-inline-banner__detail' +
          (variant === 'success' ? ' muted' : '') +
          '">' +
          escapeHtml(detail) +
          '</p>'
        : '') +
      '</div>';
    host.prepend(el);
    boardFlashBannerEl = el;
    const dismissMs = opts && opts.dismissMs;
    if (Number.isFinite(dismissMs) && dismissMs > 0) {
      boardFlashDismissTimer = setTimeout(() => {
        boardFlashDismissTimer = null;
        if (boardFlashBannerEl === el) {
          el.remove();
          boardFlashBannerEl = null;
        }
      }, dismissMs);
    }
  }

  async function refreshGlobalTasksBoard() {
    const boardEl = document.getElementById('task-board');
    if (!boardEl) return;
    try {
      const res = await fetch('/tasks' + (window.location.search || ''), {
        headers: { Accept: 'application/json' },
      });
      const data = await res.json();
      boardEl.innerHTML = renderTaskBoardHtml(data.board || {});
    } catch {
      /* board stays as server-rendered */
    }
  }

  function redirectToTasksAfterApproveRun(taskId, title) {
    sessionStorage.setItem(
      TASK_APPROVE_RUN_FLASH_KEY,
      JSON.stringify({
        taskId,
        title: title || 'Task',
        at: Date.now(),
      }),
    );
    goTo('/tasks');
  }

  function redirectToTasksAfterRetry(taskId, title) {
    sessionStorage.setItem(
      TASK_RETRY_FLASH_KEY,
      JSON.stringify({
        taskId,
        title: title || 'Task',
        at: Date.now(),
      }),
    );
    goTo('/tasks');
  }

  function redirectToTasksAfterResumeSubmit(taskId, title, humanInput) {
    sessionStorage.setItem(
      TASK_RESUME_FLASH_KEY,
      JSON.stringify({
        taskId,
        title: title || 'Task',
        humanInput: String(humanInput || '').trim(),
        at: Date.now(),
      }),
    );
    goTo('/tasks');
  }

  async function hydrateTaskApproveRunFlash() {
    const boardEl = document.getElementById('task-board');
    if (!boardEl) return;
    const raw = sessionStorage.getItem(TASK_APPROVE_RUN_FLASH_KEY);
    if (!raw) return;
    sessionStorage.removeItem(TASK_APPROVE_RUN_FLASH_KEY);
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    const taskId = Number(payload.taskId);
    const title = String(payload.title || 'Task').trim() || 'Task';
    if (!Number.isFinite(taskId)) return;

    await refreshGlobalTasksBoard();
    showBoardFlashBanner({
      lead: 'Task "' + title + '" started',
      detail: 'Agent is running in the background. Status updates on the board.',
      variant: 'success',
      dismissMs: 12000,
    });

    fetch('/tasks/' + encodeURIComponent(taskId) + '/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || res.statusText);
        await refreshGlobalTasksBoard();
        const status = data.task && data.task.status;
        if (status === 'needs_human') {
          showBoardFlashBanner({
            lead: 'Your input is needed',
            detail: 'Open task "' + title + '" in the Your turn column.',
            variant: 'info',
            dismissMs: 15000,
          });
        }
      })
      .catch(async (err) => {
        await refreshGlobalTasksBoard();
        showBoardFlashBanner({
          lead: 'Failed to start agent',
          detail: err instanceof Error ? err.message : String(err),
          variant: 'error',
          dismissMs: 15000,
        });
      });
  }

  async function hydrateTaskRetryFlash() {
    const boardEl = document.getElementById('task-board');
    if (!boardEl) return;
    const raw = sessionStorage.getItem(TASK_RETRY_FLASH_KEY);
    if (!raw) return;
    sessionStorage.removeItem(TASK_RETRY_FLASH_KEY);
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    const taskId = Number(payload.taskId);
    const title = String(payload.title || 'Task').trim() || 'Task';
    if (!Number.isFinite(taskId)) return;

    await refreshGlobalTasksBoard();
    showBoardFlashBanner({
      lead: 'Task "' + title + '" restarted',
      detail: 'Agent continues from the last step. Status will update on the board.',
      variant: 'success',
      dismissMs: 12000,
    });

    fetch('/tasks/' + encodeURIComponent(taskId) + '/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || res.statusText);
        await refreshGlobalTasksBoard();
        const status = data.task && data.task.status;
        if (status === 'needs_human') {
          showBoardFlashBanner({
            lead: 'Your input is needed',
            detail: 'Open task "' + title + '" in the Your turn column.',
            variant: 'info',
            dismissMs: 15000,
          });
        }
      })
      .catch(async (err) => {
        await refreshGlobalTasksBoard();
        showBoardFlashBanner({
          lead: 'Failed to restart',
          detail: err instanceof Error ? err.message : String(err),
          variant: 'error',
          dismissMs: 15000,
        });
      });
  }

  async function hydrateTaskResumeFlash() {
    const boardEl = document.getElementById('task-board');
    if (!boardEl) return;
    const raw = sessionStorage.getItem(TASK_RESUME_FLASH_KEY);
    if (!raw) return;
    sessionStorage.removeItem(TASK_RESUME_FLASH_KEY);
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    const taskId = Number(payload.taskId);
    const title = String(payload.title || 'Task').trim() || 'Task';
    const humanInput = String(payload.humanInput || '').trim();
    if (!Number.isFinite(taskId) || !humanInput) return;

    await refreshGlobalTasksBoard();
    showBoardFlashBanner({
      lead: 'Response sent — agent continues "' + title + '"',
      detail: 'Status updates on the board.',
      variant: 'success',
      dismissMs: 12000,
    });

    fetch('/tasks/' + encodeURIComponent(taskId) + '/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ humanInput }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || res.statusText);
        await refreshGlobalTasksBoard();
        const status = data.task && data.task.status;
        if (status === 'needs_human') {
          showBoardFlashBanner({
            lead: 'Your input is needed',
            detail: 'Open task "' + title + '" in the Your turn column.',
            variant: 'info',
            dismissMs: 15000,
          });
        } else if (status === 'needs_review') {
          showBoardFlashBanner({
            lead: 'Task "' + title + '" ready for review',
            detail: 'Open it in the Review column.',
            variant: 'success',
            dismissMs: 12000,
          });
        } else if (status === 'done') {
          showBoardFlashBanner({
            lead: 'Task "' + title + '" completed',
            detail: 'Card is on the board in the Done column.',
            variant: 'success',
            dismissMs: 12000,
          });
        } else if (status === 'failed') {
          showBoardFlashBanner({
            lead: 'Task "' + title + '" could not be continued',
            detail: 'Check the task on the board or open it again.',
            variant: 'error',
            dismissMs: 15000,
          });
        }
      })
      .catch(async (err) => {
        await refreshGlobalTasksBoard();
        showBoardFlashBanner({
          lead: 'Failed to continue task',
          detail: err instanceof Error ? err.message : String(err),
          variant: 'error',
          dismissMs: 15000,
        });
      });
  }

  function renderTaskBoardHtml(board) {
    return TASK_BOARD_COLS.map((col) => {
      const items = (board && board[col.key]) || [];
      const cards =
        items.length === 0
          ? '<li class="task-board-empty" aria-hidden="true">—</li>'
          : items
              .map((t) => {
                const failed = t.status === 'failed' ? ' task-board-card--failed' : '';
                const step = t.current_step_title
                  ? '<span class="task-board-card-sub">' +
                    escapeHtml(t.current_step_title) +
                    '</span>'
                  : '';
                return (
                  '<li><a href="/tasks/' +
                  encodeURIComponent(t.id) +
                  '" class="task-board-card' +
                  failed +
                  '"><span class="task-board-card-title">' +
                  escapeHtml(t.title) +
                  '</span>' +
                  step +
                  '</a></li>'
                );
              })
              .join('');
      return (
        '<section class="task-board-col" data-col="' +
        col.key +
        '"><header class="task-board-col-head"><h2 class="task-board-col-label">' +
        escapeHtml(col.label) +
        '</h2><span class="task-board-col-count">' +
        items.length +
        '</span></header><ul class="task-board-cards">' +
        cards +
        '</ul></section>'
      );
    }).join('');
  }

  const TASK_HUMAN_INPUT_MAX_PX = 288; /* keep in sync with .task-human-input max-height (18rem) */
  const TASK_STEP_INPUT_MAX_PX = 120;

  const TASK_STEP_TRASH_SVG =
    '<svg class="task-step-delete-icon" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';

  function taskStepDeleteHtml() {
    return (
      '<button type="button" class="task-step-delete" title="Remove step" aria-label="Remove step">' +
      TASK_STEP_TRASH_SVG +
      '</button>'
    );
  }

  function createTaskStepInsert() {
    const li = document.createElement('li');
    li.className = 'task-step-insert';
    li.innerHTML =
      '<button type="button" class="task-step-insert-btn" title="Add step after" aria-label="Add step after">+</button>';
    return li;
  }

  function taskStepActorToggleHtml(actor) {
    const a = actor === 'human' ? 'human' : 'agent';
    const label = taskStepActorLabel(a);
    const other = a === 'human' ? 'Agent' : 'You';
    return (
      '<button type="button" class="task-step-actor-toggle task-step-actor-toggle--' +
      a +
      '" aria-label="' +
      label +
      ' — switch to ' +
      other +
      '">' +
      '<span class="task-step-badge task-step-badge--' +
      a +
      '" aria-hidden="true">' +
      taskStepBadgeChar(a) +
      '</span>' +
      '<span class="task-step-actor-label">' +
      label +
      '</span>' +
      '</button>'
    );
  }

  function taskStepActorLabel(actor) {
    return actor === 'human' ? 'You' : 'Agent';
  }

  function taskStepBadgeChar(actor) {
    return actor === 'human' ? '👤' : '✦';
  }

  function isTaskStepRowLocked(row) {
    return row?.dataset?.stepLocked === '1';
  }

  function taskStepRowActor(row) {
    const staticActor = row?.querySelector('.task-step-actor-static');
    if (staticActor?.classList.contains('task-step-actor-static--human')) return 'human';
    if (staticActor?.classList.contains('task-step-actor-static--agent')) return 'agent';
    const toggle = row?.querySelector('.task-step-actor-toggle');
    if (toggle?.classList.contains('task-step-actor-toggle--human')) return 'human';
    const input = row?.querySelector('.task-step-input');
    if (input?.dataset.actor === 'human') return 'human';
    return 'agent';
  }

  function createTaskStepRow(opts) {
    const actor = opts && opts.actor === 'human' ? 'human' : 'agent';
    const title = opts && opts.title != null ? String(opts.title) : '';
    const stepId = opts && opts.stepId != null ? String(opts.stepId) : '';
    const li = document.createElement('li');
    li.className = 'task-step-row';
    if (stepId) li.dataset.stepId = stepId;
    li.innerHTML =
      taskStepActorToggleHtml(actor) +
      '<div class="task-step-main">' +
      '<textarea class="task-step-input" rows="1" data-actor="' +
      actor +
      '" aria-label="Step"></textarea>' +
      '</div>' +
      taskStepDeleteHtml();
    const input = li.querySelector('.task-step-input');
    if (input) input.value = title;
    return li;
  }

  function setTaskStepRowActor(row, actor) {
    const next = actor === 'human' ? 'human' : 'agent';
    const input = row.querySelector('.task-step-input');
    const toggle = row.querySelector('.task-step-actor-toggle');
    const badge = row.querySelector('.task-step-badge');
    const label = row.querySelector('.task-step-actor-label');
    if (input) input.dataset.actor = next;
    if (toggle) {
      toggle.className = 'task-step-actor-toggle task-step-actor-toggle--' + next;
      const lbl = taskStepActorLabel(next);
      toggle.setAttribute('aria-label', lbl + ' — switch to ' + (next === 'human' ? 'Agent' : 'You'));
    }
    if (badge) {
      badge.className = 'task-step-badge task-step-badge--' + next;
      badge.textContent = taskStepBadgeChar(next);
    }
    if (label) label.textContent = taskStepActorLabel(next);
  }

  function ensureTaskStepsEmptyPlaceholder(stepsList) {
    if (!stepsList) return;
    if (stepsList.querySelector('.task-step-row')) {
      stepsList.querySelector('.task-step-insert--empty')?.remove();
      return;
    }
    if (stepsList.querySelector('.task-step-insert--empty')) return;
    const li = createTaskStepInsert();
    li.classList.add('task-step-insert--empty');
    stepsList.appendChild(li);
  }

  function ensureLeadingStepInsert(stepsList) {
    const firstRow = stepsList.querySelector('.task-step-row');
    if (!firstRow) return;
    stepsList.querySelector('.task-step-insert--empty')?.remove();
    const prev = firstRow.previousElementSibling;
    if (isTaskStepRowLocked(firstRow)) {
      if (prev?.classList.contains('task-step-insert')) {
        prev.classList.add('task-step-insert--hidden');
      }
      return;
    }
    if (prev?.classList.contains('task-step-insert')) {
      prev.classList.remove('task-step-insert--hidden');
    }
    if (!prev?.classList.contains('task-step-insert')) {
      const leading = createTaskStepInsert();
      leading.classList.add('task-step-insert--leading');
      firstRow.before(leading);
    } else if (!prev.classList.contains('task-step-insert--leading')) {
      prev.classList.add('task-step-insert--leading');
    }
  }

  function normalizeTaskStepsList(stepsList) {
    stepsList.querySelectorAll('.task-step-actions').forEach((el) => el.remove());
    const rows = [...stepsList.querySelectorAll('.task-step-row')];
    if (rows.length) ensureLeadingStepInsert(stepsList);
    else {
      stepsList.querySelectorAll('.task-step-insert:not(.task-step-insert--empty)').forEach((el) => el.remove());
    }
    rows.forEach((row) => {
      const locked = isTaskStepRowLocked(row);
      if (locked) {
        row.querySelector('.task-step-delete')?.remove();
        row.querySelector('.task-step-actor-toggle')?.remove();
        const next = row.nextElementSibling;
        if (next?.classList.contains('task-step-insert')) {
          next.classList.add('task-step-insert--hidden');
        }
        return;
      }
      if (!row.querySelector('.task-step-delete')) {
        row.insertAdjacentHTML('beforeend', taskStepDeleteHtml());
      }
      const next = row.nextElementSibling;
      if (!next?.classList.contains('task-step-insert')) {
        row.after(createTaskStepInsert());
      } else {
        next.classList.remove('task-step-insert--hidden');
      }
    });
  }

  function addStepBefore(nextStepRow, stepsList) {
    if (isTaskStepRowLocked(nextStepRow)) return;
    const row = createTaskStepRow({ actor: 'agent', title: '' });
    nextStepRow.before(row);
    if (!row.nextElementSibling?.classList.contains('task-step-insert')) {
      row.after(createTaskStepInsert());
    }
    const ta = row.querySelector('.task-step-input');
    if (ta) bindAutoGrowTextarea(ta, TASK_STEP_INPUT_MAX_PX);
    ta?.focus();
    updateTaskStepsCount(stepsList);
  }

  function addStepAfter(prevStepRow, stepsList) {
    if (isTaskStepRowLocked(prevStepRow)) return;
    const row = createTaskStepRow({ actor: 'agent', title: '' });
    const insertLi = prevStepRow.nextElementSibling;
    if (insertLi?.classList.contains('task-step-insert')) {
      insertLi.before(row);
    } else {
      prevStepRow.after(row);
      prevStepRow.after(createTaskStepInsert());
    }
    const ta = row.querySelector('.task-step-input');
    if (ta) bindAutoGrowTextarea(ta, TASK_STEP_INPUT_MAX_PX);
    ta?.focus();
    updateTaskStepsCount(stepsList);
  }

  function removeStepRow(row, stepsList) {
    if (isTaskStepRowLocked(row)) return;
    const next = row.nextElementSibling;
    row.remove();
    if (next?.classList.contains('task-step-insert')) next.remove();
    normalizeTaskStepsList(stepsList);
    ensureTaskStepsEmptyPlaceholder(stepsList);
    updateTaskStepsCount(stepsList);
  }

  function updateTaskStepsCount(stepsList) {
    const el = document.getElementById('task-steps-count');
    if (!el || !stepsList) return;
    const n = stepsList.querySelectorAll('.task-step-row:not(.task-step-row--empty)').length;
    el.textContent = n + (n === 1 ? ' step' : ' steps');
  }

  function initTaskStepsEditor(stepsList, onChange) {
    if (!stepsList) return;
    const planReadonly = stepsList.dataset.planReadonly === '1';

    if (!planReadonly) normalizeTaskStepsList(stepsList);

    if (!planReadonly && typeof onChange === 'function') {
      stepsList.addEventListener('input', (ev) => {
        if (ev.target.closest('.task-step-input')) onChange();
      });
    }

    if (!planReadonly) {
      stepsList.querySelectorAll('.task-step-row').forEach((row) => {
        const ta = row.querySelector('.task-step-input');
        if (ta) bindAutoGrowTextarea(ta, TASK_STEP_INPUT_MAX_PX);
      });
    }

    if (planReadonly) {
      updateTaskStepsCount(stepsList);
      return;
    }

    stepsList.addEventListener('click', (ev) => {
      const actorToggle = ev.target.closest('.task-step-actor-toggle');
      if (actorToggle && stepsList.contains(actorToggle)) {
        ev.preventDefault();
        const row = actorToggle.closest('.task-step-row');
        if (row && isTaskStepRowLocked(row)) return;
        if (row) {
          const next =
            row.querySelector('.task-step-input')?.dataset.actor === 'human' ? 'agent' : 'human';
          setTaskStepRowActor(row, next);
          onChange?.();
        }
        return;
      }

      const insertBtn = ev.target.closest('.task-step-insert-btn');
      if (insertBtn && stepsList.contains(insertBtn)) {
        ev.preventDefault();
        const insertLi = insertBtn.closest('.task-step-insert');
        if (insertLi?.classList.contains('task-step-insert--hidden')) return;
        if (insertLi?.classList.contains('task-step-insert--empty')) {
          const row = createTaskStepRow({ actor: 'agent', title: '' });
          const leading = createTaskStepInsert();
          leading.classList.add('task-step-insert--leading');
          const trailing = createTaskStepInsert();
          insertLi.replaceWith(leading, row, trailing);
          const ta = row.querySelector('.task-step-input');
          if (ta) bindAutoGrowTextarea(ta, TASK_STEP_INPUT_MAX_PX);
          ta?.focus();
          updateTaskStepsCount(stepsList);
          onChange?.();
          return;
        }
        const prevStep = insertLi?.previousElementSibling;
        const nextStep = insertLi?.nextElementSibling;
        if (prevStep?.classList.contains('task-step-row') && !isTaskStepRowLocked(prevStep)) {
          addStepAfter(prevStep, stepsList);
          onChange?.();
        } else if (nextStep?.classList.contains('task-step-row') && !isTaskStepRowLocked(nextStep)) {
          addStepBefore(nextStep, stepsList);
          onChange?.();
        }
        return;
      }

      const deleteBtn = ev.target.closest('.task-step-delete');
      if (deleteBtn && stepsList.contains(deleteBtn)) {
        ev.preventDefault();
        const row = deleteBtn.closest('.task-step-row');
        if (row && isTaskStepRowLocked(row)) return;
        if (row) {
          removeStepRow(row, stepsList);
          onChange?.();
        }
      }
    });

    ensureTaskStepsEmptyPlaceholder(stepsList);
    updateTaskStepsCount(stepsList);
  }

  function bindAutoGrowTextarea(el, maxPx) {
    if (!el || el.tagName !== 'TEXTAREA') return;
    const cap = Number.isFinite(maxPx) ? maxPx : TASK_HUMAN_INPUT_MAX_PX;
    const grow = () => {
      el.style.height = 'auto';
      const next = Math.min(el.scrollHeight, cap);
      el.style.height = next + 'px';
      el.style.overflowY = el.scrollHeight > cap ? 'auto' : 'hidden';
    };
    el.addEventListener('input', grow);
    grow();
  }

  /** Live Ask modal — receives `task-ask-turn-*` from /ws (filtered by taskId + sessionId). */
  let taskAskLive = null;

  function taskAskIsActive() {
    return taskAskLive && !taskAskLive.modal.hidden;
  }

  function taskAskMatches(msg) {
    if (!taskAskIsActive()) return false;
    return (
      Number(msg.taskId) === taskAskLive.taskId &&
      Number(msg.sessionId) === taskAskLive.sessionId
    );
  }

  function taskAskScroll() {
    if (!taskAskLive) return;
    const el = taskAskLive.messagesPane || taskAskLive.thread;
    if (el) el.scrollTop = el.scrollHeight;
  }

  function taskAskEnsureStream() {
    if (!taskAskLive) return null;
    if (taskAskLive.streamEl && taskAskLive.thread.contains(taskAskLive.streamEl)) {
      return taskAskLive.streamEl;
    }
    const div = document.createElement('div');
    div.className = 'msg assistant streaming stream-waiting';
    div.innerHTML =
      '<div class="role">assistant</div>' +
      '<div class="msg-body stream-body"></div>' +
      '<div class="stream-status"></div>';
    taskAskLive.thread.appendChild(div);
    const st = div.querySelector('.stream-status');
    if (st) setStreamStatusLabel(st, 'Thinking…');
    taskAskLive.streamEl = div;
    taskAskLive.streamFullText = '';
    taskAskScroll();
    return div;
  }

  function taskAskFinalizeReply(text) {
    if (!taskAskLive || taskAskLive.turnFinalized) return;
    taskAskLive.turnFinalized = true;
    const reply = String(text ?? '').trim() || '(no response)';
    const el = taskAskLive.streamEl;
    if (el && taskAskLive.thread.contains(el)) {
      el.classList.remove(
        'streaming', 'stream-waiting', 'stream-tool', 'stream-generating',
      );
      const status = el.querySelector('.stream-status');
      if (status) {
        stopStreamStatusDotAnim(status);
        status.remove();
      }
      const body = el.querySelector('.stream-body, .msg-body');
      if (body) {
        body.classList.remove('stream-body');
        body.innerHTML = renderMessageHtml(reply);
        decorateMessageBody(body);
      }
    } else {
      const div = document.createElement('div');
      div.className = 'msg assistant';
      div.innerHTML =
        '<div class="role">assistant</div>' +
        '<div class="msg-body">' + renderMessageHtml(reply) + '</div>';
      decorateMessageBody(div);
      taskAskLive.thread.appendChild(div);
    }
    taskAskLive.streamEl = null;
    taskAskLive.streamFullText = '';
    taskAskScroll();
    if (taskAskLive.sendBtn) taskAskLive.sendBtn.disabled = false;
    taskAskLive.input?.focus();
  }

  function handleTaskAskWs(msg) {
    if (!taskAskMatches(msg)) return;

    switch (msg.type) {
      case 'task-ask-turn-started': {
        taskAskLive.turnFinalized = false;
        const el = taskAskEnsureStream();
        if (!el) return;
        el.classList.add('streaming', 'stream-waiting');
        el.classList.remove('stream-tool', 'stream-generating');
        const status = el.querySelector('.stream-status');
        if (status) {
          status.hidden = false;
          status.classList.remove('detail-expanded', 'has-detail');
          status.removeAttribute('title');
          delete status.dataset.detail;
          delete status.dataset.label;
          setStreamStatusLabel(status, msg.activity?.label || 'Thinking…');
        }
        return;
      }

      case 'task-ask-turn-delta': {
        const el = taskAskEnsureStream();
        if (!el) return;
        taskAskLive.streamFullText += msg.text;
        if (el.classList.contains('stream-waiting') || el.classList.contains('stream-tool')) {
          el.classList.remove('stream-waiting', 'stream-tool');
          el.classList.add('stream-generating');
          const status = el.querySelector('.stream-status');
          if (status) {
            stopStreamStatusDotAnim(status);
            status.hidden = true;
          }
        }
        const body = el.querySelector('.stream-body, .msg-body');
        if (body) {
          body.innerHTML = renderMarkdown(taskAskLive.streamFullText);
          decorateMessageBody(body, { deferSyntaxHighlight: true });
        }
        taskAskScroll();
        return;
      }

      case 'task-ask-turn-tool': {
        const el = taskAskEnsureStream();
        if (!el) return;
        const status = el.querySelector('.stream-status');
        if (msg.phase === 'start' && status) {
          status.hidden = false;
          const label = msg.label || msg.name;
          const detail = msg.detail && msg.detail !== label ? msg.detail : '';
          if (detail) {
            status.dataset.detail = detail;
            status.dataset.label = label;
            status.title = detail;
            status.classList.add('has-detail');
            status.classList.remove('detail-expanded');
            setStreamStatusLabel(status, label);
          } else {
            status.removeAttribute('title');
            delete status.dataset.detail;
            delete status.dataset.label;
            status.classList.remove('has-detail', 'detail-expanded');
            setStreamStatusLabel(status, label);
          }
          el.classList.remove('stream-waiting', 'stream-generating');
          el.classList.add('stream-tool');
        } else if (msg.phase === 'end' && status) {
          setStreamStatusLabel(status, msg.label || msg.phase);
        }
        return;
      }

      case 'task-ask-turn-lifecycle': {
        const el = taskAskEnsureStream();
        if (!el) return;
        const status = el.querySelector('.stream-status');
        if (status) {
          status.hidden = false;
          setStreamStatusLabel(status, msg.label || msg.phase);
        }
        return;
      }

      case 'task-ask-turn-ended':
        taskAskFinalizeReply(msg.reply);
        return;

      case 'task-ask-turn-error':
        taskAskFinalizeReply(msg.error || 'Ask failed');
        return;

      default:
        return;
    }
  }

  function initTaskAskModal(taskId, postAction) {
    const modal = document.getElementById('task-ask-modal');
    const openBtn = document.getElementById('task-ask-open-btn');
    const backdrop = document.getElementById('task-ask-modal-backdrop');
    const shell = document.getElementById('task-ask-modal-shell');
    const messagesPane = document.getElementById('task-ask-messages');
    const closeConfirm = document.getElementById('task-ask-close-confirm');
    const closeConfirmBackdrop = document.getElementById('task-ask-close-confirm-backdrop');
    const closeConfirmCancel = document.getElementById('task-ask-close-confirm-cancel');
    const closeConfirmOk = document.getElementById('task-ask-close-confirm-ok');
    const sendBtn = document.getElementById('task-ask-send-btn');
    const input = document.getElementById('task-ask-input');
    const thread = document.getElementById('task-ask-thread');
    if (!modal || !openBtn || !thread) return;

    bindAutoGrowTextarea(input, 200);

    function scrollAskThread() {
      const el = messagesPane || thread;
      if (el) el.scrollTop = el.scrollHeight;
    }

    let sessionId = null;
    let closing = false;
    let opening = false;

    function hideCloseConfirm() {
      if (closeConfirm) closeConfirm.hidden = true;
    }

    function showCloseConfirm() {
      if (closeConfirm) closeConfirm.hidden = false;
    }

    function requestCloseAsk() {
      if (opening) return;
      if (!Number.isFinite(sessionId)) {
        modal.hidden = true;
        hideCloseConfirm();
        return;
      }
      showCloseConfirm();
    }

    function appendAskBubble(role, text) {
      const div = document.createElement('div');
      const msgRole = role === 'user' ? 'user' : 'assistant';
      div.className = 'msg ' + msgRole;
      const bodyHtml =
        msgRole === 'assistant'
          ? '<div class="msg-body">' + renderMessageHtml(text) + '</div>'
          : '<div class="msg-body">' + escapeHtml(text) + '</div>';
      div.innerHTML = '<div class="role">' + msgRole + '</div>' + bodyHtml;
      if (msgRole === 'assistant') decorateMessageBody(div);
      thread.appendChild(div);
      scrollAskThread();
    }

    async function closeAskModal() {
      if (closing) return;
      closing = true;
      const sid = sessionId;
      sessionId = null;
      taskAskLive = null;
      modal.hidden = true;
      hideCloseConfirm();
      thread.innerHTML = '';
      if (input) input.value = '';
      if (Number.isFinite(sid)) {
        try {
          await postAction('/ask/close', { sessionId: sid });
        } catch {
          /* best-effort */
        }
      }
      closing = false;
    }

    async function openAskModal() {
      thread.innerHTML = '';
      if (input) input.value = '';
      modal.hidden = false;
      hideCloseConfirm();
      opening = true;
      openBtn.disabled = true;
      try {
        const data = await postAction('/ask/open', {});
        sessionId = Number(data.sessionId);
        if (!Number.isFinite(sessionId)) throw new Error('invalid session');
        taskAskLive = {
          taskId,
          sessionId,
          thread,
          messagesPane,
          modal,
          sendBtn,
          input,
          streamEl: null,
          streamFullText: '',
          turnFinalized: false,
        };
        appendAskBubble(
          'assistant',
          'Context snapshot taken. Ask anything about this task — it does not affect the plan or execution.',
        );
        input?.focus();
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
        modal.hidden = true;
      } finally {
        opening = false;
        openBtn.disabled = false;
      }
    }

    openBtn.addEventListener('click', () => void openAskModal());
    shell?.addEventListener('click', (e) => e.stopPropagation());
    backdrop?.addEventListener('click', () => requestCloseAsk());
    closeConfirm?.querySelector('.task-ask-close-confirm__panel')?.addEventListener('click', (e) => e.stopPropagation());
    closeConfirmBackdrop?.addEventListener('click', () => hideCloseConfirm());
    closeConfirmCancel?.addEventListener('click', () => hideCloseConfirm());
    closeConfirmOk?.addEventListener('click', () => void closeAskModal());

    async function sendAsk() {
      const message = input?.value?.trim();
      if (!message || !Number.isFinite(sessionId) || !taskAskLive) return;
      if (sendBtn?.disabled) return;
      appendAskBubble('user', message);
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      taskAskLive.turnFinalized = false;
      taskAskLive.streamEl = null;
      taskAskLive.streamFullText = '';
      sendBtn.disabled = true;
      try {
        const data = await postAction('/ask/turn', { sessionId, message });
        if (!taskAskLive.turnFinalized) {
          taskAskFinalizeReply(data.reply || '(no response)');
        }
      } catch (err) {
        if (!taskAskLive.turnFinalized) {
          taskAskFinalizeReply(err instanceof Error ? err.message : String(err));
        }
      }
    }

    sendBtn?.addEventListener('click', () => void sendAsk());
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void sendAsk();
      }
    });

    function onAskEscapeKey(e) {
      if (e.key !== 'Escape' || modal.hidden) return;
      e.preventDefault();
      e.stopPropagation();
      if (closeConfirm && !closeConfirm.hidden) {
        hideCloseConfirm();
        return;
      }
      requestCloseAsk();
    }
    // Capture so we run before the global Escape → home handler on task pages.
    document.addEventListener('keydown', onAskEscapeKey, true);
  }

  /**
   * Inline rename for the task title. Mirrors the chat header rename input:
   * permanent input styled as a heading, save on blur/Enter, Esc reverts,
   * no auto-select on focus. WS `task-updated` updates `value` in place
   * unless the input is focused — see applyTaskDetailRemoteTask.
   */
  function bindTaskTitleInlineEdit(root, taskId) {
    const inp = root.querySelector('#task-title-input');
    if (!inp || inp.dataset.titleBound === '1') return;
    inp.dataset.titleBound = '1';

    async function save() {
      const next = inp.value.trim();
      if (!next || next === inp.defaultValue) {
        inp.value = inp.defaultValue;
        return;
      }
      try {
        const res = await fetch('/tasks/' + encodeURIComponent(taskId), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ title: next }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || res.statusText);
        }
        const data = await res.json();
        inp.defaultValue = data.task?.title ?? next;
        inp.value = inp.defaultValue;
        document.title = inp.defaultValue + ' — iClaw';
      } catch (err) {
        inp.value = inp.defaultValue;
        alert('Failed to rename task: ' + (err instanceof Error ? err.message : String(err)));
      }
    }

    inp.addEventListener('blur', save);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        inp.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        inp.value = inp.defaultValue;
        inp.blur();
      }
    });
  }

  function initTaskDetailPage() {
    const root = document.querySelector('.task-page[data-task-id]');
    if (!root) return;
    const taskId = Number(root.dataset.taskId);
    if (!Number.isFinite(taskId)) return;

    bindAutoGrowTextarea(document.getElementById('task-human-input'), TASK_HUMAN_INPUT_MAX_PX);

    bindTaskTitleInlineEdit(root, taskId);

    const taskScrollEl = root;
    root.querySelectorAll('details').forEach((det) => {
      det.addEventListener('toggle', () => {
        const scrollTop = taskScrollEl.scrollTop;
        requestAnimationFrame(() => {
          taskScrollEl.scrollTop = scrollTop;
        });
        if (!det.open) return;
        det.querySelectorAll('.task-step-input').forEach((ta) => {
          bindAutoGrowTextarea(ta, TASK_STEP_INPUT_MAX_PX);
        });
      });
    });

    const runBtn = document.getElementById('task-run-btn');
    const deleteBtn = document.getElementById('task-delete-btn');
    const resumeBtn = document.getElementById('task-resume-btn');
    const doneBtn = document.getElementById('task-done-btn');
    const failBtn = document.getElementById('task-fail-btn');
    const retryBtn = document.getElementById('task-retry-btn');
    const stepsList = document.getElementById('task-steps-list');
    const taskMeta = window.__ICLAW_TASK__;
    const planAutosaveEnabled = taskMeta && taskMeta.status === 'ready';

    let planSaveTimer = null;
    let planSaveInFlight = false;
    let planSaveQueued = false;

    function collectSteps() {
      if (!stepsList) return [];
      return [...stepsList.querySelectorAll('.task-step-row:not(.task-step-row--empty)')].map((row) => {
        const stepId = row.dataset.stepId ? Number(row.dataset.stepId) : undefined;
        if (isTaskStepRowLocked(row) && Number.isFinite(stepId)) {
          const readonly = row.querySelector('.task-step-title-readonly');
          return {
            id: stepId,
            actor: taskStepRowActor(row),
            title: (readonly?.textContent || '').trim(),
            description: null,
          };
        }
        const input = row.querySelector('.task-step-input');
        const actor = input?.dataset.actor === 'human' ? 'human' : 'agent';
        const step = {
          actor,
          title: (input?.value || '').trim(),
          description: null,
        };
        if (Number.isFinite(stepId)) step.id = stepId;
        return step;
      }).filter((s) => s.title);
    }

    function schedulePlanAutosave(immediate) {
      if (!planAutosaveEnabled) return;
      clearTimeout(planSaveTimer);
      const delay = immediate ? 0 : 450;
      planSaveTimer = setTimeout(() => void flushPlanAutosave(), delay);
    }

    async function flushPlanAutosave() {
      if (!planAutosaveEnabled || planSaveInFlight) {
        if (planAutosaveEnabled) planSaveQueued = true;
        return;
      }
      planSaveInFlight = true;
      try {
        const steps = collectSteps();
        await patchTask({ steps });
      } catch (err) {
        console.warn('Plan autosave failed:', err);
      } finally {
        planSaveInFlight = false;
        if (planSaveQueued) {
          planSaveQueued = false;
          schedulePlanAutosave(true);
        }
      }
    }

    initTaskStepsEditor(stepsList, () => schedulePlanAutosave(true));

    function wireClick(id, handler) {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', handler);
    }

    async function postAction(path, body) {
      const res = await fetch('/tasks/' + encodeURIComponent(taskId) + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    }

    async function patchTask(body) {
      const res = await fetch('/tasks/' + encodeURIComponent(taskId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    }

    function requireSteps() {
      const steps = collectSteps();
      if (!steps.length) {
        alert('Add at least one step to the plan before continuing.');
        return null;
      }
      return steps;
    }

    async function savePlanBeforeRun() {
      clearTimeout(planSaveTimer);
      planSaveTimer = null;
      while (planSaveInFlight) {
        await new Promise((r) => setTimeout(r, 30));
      }
      const steps = requireSteps();
      if (!steps) return null;
      await patchTask({ steps });
      return steps;
    }

    async function onRunAgent(btn) {
      if (btn) btn.disabled = true;
      try {
        const steps = await savePlanBeforeRun();
        if (!steps) {
          if (btn) btn.disabled = false;
          return;
        }
        const title =
          (document.getElementById('task-title-input')?.value || '').trim() || 'Task';
        redirectToTasksAfterApproveRun(taskId, title);
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
        if (btn) btn.disabled = false;
      }
    }

    if (runBtn) runBtn.addEventListener('click', () => onRunAgent(runBtn));
    if (retryBtn) {
      retryBtn.addEventListener('click', () => {
        retryBtn.disabled = true;
        if (doneBtn) doneBtn.disabled = true;
        const title =
          (document.getElementById('task-title-input')?.value || '').trim() || 'Task';
        redirectToTasksAfterRetry(taskId, title);
      });
    }
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async () => {
        if (
          !window.confirm(
            'Delete this task? This action cannot be undone.',
          )
        ) {
          return;
        }
        deleteBtn.disabled = true;
        if (runBtn) runBtn.disabled = true;
        try {
          const res = await fetch('/tasks/' + encodeURIComponent(taskId), {
            method: 'DELETE',
            headers: { Accept: 'application/json' },
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || res.statusText);
          goTo('/tasks');
        } catch (err) {
          alert(err instanceof Error ? err.message : String(err));
          deleteBtn.disabled = false;
          if (runBtn) runBtn.disabled = false;
        }
      });
    }
    initTaskAskModal(taskId, postAction);

    if (resumeBtn) {
      resumeBtn.addEventListener('click', () => {
        const humanInput = document.getElementById('task-human-input')?.value?.trim();
        if (!humanInput) return;
        const title =
          (document.getElementById('task-title-input')?.value || '').trim() || 'Task';
        const taskMeta = window.__ICLAW_TASK__;
        redirectToTasksAfterResumeSubmit(taskId, title, humanInput);
      });
    }
    if (doneBtn) {
      doneBtn.addEventListener('click', async () => {
        doneBtn.disabled = true;
        if (failBtn) failBtn.disabled = true;
        try {
          await postAction('/complete', { status: 'done' });
          goTo('/tasks');
        } catch (err) {
          alert(err instanceof Error ? err.message : String(err));
          doneBtn.disabled = false;
          if (failBtn) failBtn.disabled = false;
        }
      });
    }
    if (failBtn) {
      failBtn.addEventListener('click', async () => {
        if (failBtn) failBtn.disabled = true;
        if (doneBtn) doneBtn.disabled = true;
        try {
          await postAction('/complete', { status: 'failed' });
          goTo('/tasks');
        } catch (err) {
          alert(err instanceof Error ? err.message : String(err));
          failBtn.disabled = false;
          if (doneBtn) doneBtn.disabled = false;
        }
      });
    }

    taskDetailSyncFingerprint =
      taskMeta && taskMeta.syncFingerprint
        ? String(taskMeta.syncFingerprint)
        : taskDetailFingerprint({ status: taskMeta?.status, steps: [] });
  }

  initProjectPageTabs();
  initTasksBoardPage();
  initTaskDetailPage();
  initDynamicFavicon();
  if (document.getElementById('sidebar-tasks-link')) void refreshTasksNavSignals();
  hydrateTaskApproveRunFlash();
  hydrateTaskResumeFlash();
  hydrateTaskRetryFlash();
  hydrateServerRenderedMessages();
  hydrateTaskMarkdownFields();
  (function seedMidTurnStreamStatusDots() {
    const st = document.querySelector('#reload-placeholder .stream-status');
    if (!st || st.classList.contains('detail-expanded')) return;
    const seed =
      (st.dataset.label && String(st.dataset.label).trim()) ||
      (st.textContent || '').trim() ||
      'Thinking…';
    setStreamStatusLabel(st, seed);
  })();
  // Show the latest message immediately — set scrollTop synchronously so the
  // first paint already has the bottom in view. `data-defer-paint` on the
  // section keeps it invisible until we strip the attribute below; without
  // that the browser may flash the top of the transcript for a frame.
  if (messagesEl) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    requestAnimationFrame(() => {
      // Re-affirm after layout settles (markdown rendering may shift heights),
      // then reveal the section.
      messagesEl.scrollTop = messagesEl.scrollHeight;
      messagesEl.removeAttribute('data-defer-paint');
    });
  }
  function bootConnectWs() {
    connectWs();
  }
  if (window.__iclawRaE2eBoot && typeof window.__iclawRaE2eBoot.then === 'function') {
    window.__iclawRaE2eBoot
      .then(function (ok) {
        if (!ok) {
          console.warn('[iclaw] E2E transport not active — encrypted remote access unavailable');
        }
        bootConnectWs();
      })
      .catch(function (err) {
        console.error('[iclaw] E2E transport install failed', err);
        bootConnectWs();
      });
  } else {
    bootConnectWs();
  }
})();
