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
  const messagesEl = document.getElementById('messages');
  const queueEl = document.getElementById('queue');
  const form = document.getElementById('send-form');
  const input = document.getElementById('composer-input');
  const button = form?.querySelector('.composer-send');
  const titleInput = document.getElementById('chat-title-input');
  const draftAgentSelect = document.getElementById('draft-agent');
  const draftProjectSelect = document.getElementById('draft-project');
  const stopBtn = document.getElementById('stop-btn');
  const searchInput = document.getElementById('sidebar-search-input');
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
    if (v > 9) return 9;
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
  /** Build a fact row matching `views/project.ejs` (WS-driven updates on project page). */
  function buildFactLi(f) {
    const li = document.createElement('li');
    li.className = 'fact';
    li.dataset.factId = String(f.id);
    const src =
      f.source_chat_id != null
        ? '<a href="/chats/' +
          f.source_chat_id +
          '" class="fact-source">Chat #' +
          f.source_chat_id +
          '</a>'
        : '';
    li.innerHTML =
      '<textarea class="fact-content" aria-label="Fact text" rows="2">' +
      escapeHtml(f.content || '') +
      '</textarea>' +
      '<div class="fact-meta">' +
      src +
      '<button type="button" class="fact-delete" aria-label="Delete fact">Remove</button></div>';
    const ta = li.querySelector('.fact-content');
    if (ta) ta.dataset.saved = String(f.content || '').trim();
    return li;
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
    row.remove();
    if (card && !card.querySelector('.fact-suggestion-row')) card.remove();
  }

  function appendFactSuggestionsCard(opts) {
    if (!messagesEl) return;
    const { projectId, chatId, suggestions, projectName } = opts;
    if (!suggestions || suggestions.length === 0) return;
    clearEmptyState();
    const safeName = escapeHtml((projectName || '').trim() || 'проєкт');
    const card = document.createElement('div');
    card.className = 'msg system fact-suggestions-card';
    card.dataset.projectId = String(projectId);
    card.dataset.chatId = String(chatId);
    const rows = suggestions
      .map(
        (s) =>
          '<li class="fact-suggestion-row" data-suggestion-id="' +
          s.id +
          '" role="listitem">' +
          '<p class="fact-suggestion-text">' +
          escapeHtml(s.content) +
          '</p>' +
          '<div class="fact-suggestion-actions">' +
          '<button type="button" class="fact-suggestion-btn fact-suggestion-reject" data-suggestion-id="' +
          s.id +
          '" aria-label="Пропустити">' +
          '<span class="fact-suggestion-btn-glyph" aria-hidden="true">✕</span>' +
          '</button>' +
          '<button type="button" class="fact-suggestion-btn fact-suggestion-accept" data-suggestion-id="' +
          s.id +
          '" aria-label="Зберегти в проєкт">' +
          '<span class="fact-suggestion-btn-glyph" aria-hidden="true">✓</span>' +
          '</button>' +
          '</div></li>',
      )
      .join('');
    card.innerHTML =
      '<div class="fact-suggestions-shell">' +
      '<p class="fact-suggestions-lead">Зберегти в памʼять «' +
      safeName +
      '»?</p>' +
      '<ul class="fact-suggestions-list" role="list">' +
      rows +
      '</ul>' +
      '</div>';
    messagesEl.appendChild(card);
    scrollToBottom();
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
      const projectLabel = pname || 'проєкт';
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
  // queue widget — shows only WAITING items (not the in-flight one)
  // -------------------------------------------------------------------------

  let nextQueueItemId = 1;

  function renderQueue() {
    if (!queueEl) return;
    queueEl.replaceChildren();
    waitingItems.forEach((item, idx) => {
      const el = document.createElement('div');
      el.className = 'queue-item queued';
      el.dataset.itemId = item.id;
      const preview = item.content.length > 80 ? item.content.slice(0, 79) + '…' : item.content;
      el.innerHTML =
        '<span class="queue-status">Queued #' + (idx + 1) + '</span>' +
        '<span class="queue-text">' + escapeHtml(preview) + '</span>' +
        '<button type="button" class="queue-remove" aria-label="Remove from queue" title="Remove from queue">×</button>';
      queueEl.appendChild(el);
    });
  }

  // Click on a tool's stream-status with .has-detail toggles between the
  // generic label and the detailed line. The next `turn-tool` start resets
  // the expansion (see handleServerMsg/turn-tool), so the click is scoped
  // to the current tool event only.
  if (messagesEl) {
    messagesEl.addEventListener('click', (e) => {
      const acc = e.target.closest('.fact-suggestion-accept');
      const rej = e.target.closest('.fact-suggestion-reject');
      if (acc || rej) {
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
      const status = e.target.closest('.stream-status.has-detail');
      if (!status) return;
      const expanded = status.classList.toggle('detail-expanded');
      status.textContent = expanded
        ? (status.dataset.detail || status.textContent)
        : (status.dataset.label || status.textContent);
    });
  }

  // Delete from queue via event delegation
  if (queueEl) {
    queueEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.queue-remove');
      if (!btn) return;
      const item = btn.closest('.queue-item');
      const id = item?.dataset.itemId;
      if (!id) return;
      const idx = waitingItems.findIndex((it) => it.id === id);
      if (idx >= 0) {
        waitingItems.splice(idx, 1);
        renderQueue();
      }
    });
  }

  // -------------------------------------------------------------------------
  // sidebar live updates
  // -------------------------------------------------------------------------
  /** When projects exist, keep non-nested chats under a "Personal" label (matches server EJS). */
  function ensurePersonalLabelBeforeOrphans(list) {
    const orphanChats = Array.from(list.children).filter(
      (n) =>
        n.nodeType === 1 &&
        n.classList.contains('chat-item') &&
        !n.classList.contains('nested'),
    );
    if (orphanChats.length === 0) return;
    if (!list.querySelector('.project-group')) return;
    const hasPersonal = Array.from(list.querySelectorAll('.sidebar-section-label')).some(
      (x) => x.textContent.trim() === 'Personal',
    );
    if (hasPersonal) return;
    const personalLbl = document.createElement('div');
    personalLbl.className = 'sidebar-section-label';
    personalLbl.textContent = 'Personal';
    list.insertBefore(personalLbl, orphanChats[0]);
  }

  function ensureSidebarSectionLabel(list, text) {
    const labels = list.querySelectorAll('.sidebar-section-label');
    for (let i = 0; i < labels.length; i++) {
      if (labels[i].textContent.trim() === text) return labels[i];
    }
    const el = document.createElement('div');
    el.className = 'sidebar-section-label';
    el.textContent = text;
    list.insertBefore(el, list.firstElementChild);
    return el;
  }

  function ensureProjectGroupInSidebar(list, projectId, projectName, logoEmoji, logoColor) {
    let group = list.querySelector('.project-group[data-project-id="' + projectId + '"]');
    const ei =
      logoEmoji !== undefined && logoEmoji !== null
        ? clampLogoEmojiJs(Number(logoEmoji))
        : 0;
    const ci =
      logoColor !== undefined && logoColor !== null
        ? clampLogoColorJs(Number(logoColor))
        : 0;
    if (!group) {
      ensureSidebarSectionLabel(list, 'Projects');
      group = document.createElement('div');
      group.className = 'project-group';
      group.dataset.projectId = String(projectId);
      const row = document.createElement('a');
      row.href = '/projects/' + projectId;
      row.className = 'project-row';
      const nm = projectName || ('Project #' + projectId);
      row.title = nm;
      row.innerHTML =
        buildProjectLogoHtml(ei, ci) +
        '<span class="project-row-name">' +
        escapeHtml(nm) +
        '</span>' +
        '<span class="project-row-count">0</span>';
      group.appendChild(row);
      const personalLbl = Array.from(list.querySelectorAll('.sidebar-section-label')).find(
        (x) => x.textContent.trim() === 'Personal',
      );
      const lastGroup = Array.from(list.querySelectorAll('.project-group')).pop();
      if (lastGroup) list.insertBefore(group, lastGroup.nextSibling);
      else if (personalLbl) list.insertBefore(group, personalLbl);
      else {
        const plab = Array.from(list.querySelectorAll('.sidebar-section-label')).find(
          (x) => x.textContent.trim() === 'Projects',
        );
        if (plab && plab.nextSibling) list.insertBefore(group, plab.nextSibling);
        else list.prepend(group);
      }
    } else {
      if (projectName != null) {
        const nameEl = group.querySelector('.project-row-name');
        if (nameEl) nameEl.textContent = projectName;
        const row = group.querySelector('.project-row');
        if (row) row.title = projectName;
      }
      if (logoEmoji !== undefined || logoColor !== undefined) {
        const row = group.querySelector('.project-row');
        const el = row?.querySelector('.project-logo');
        let e = 0;
        let c = 0;
        if (el) {
          const cur = readLogoFromEl(el);
          e = cur.ei;
          c = cur.ci;
        }
        if (logoEmoji !== undefined && logoEmoji !== null) e = clampLogoEmojiJs(Number(logoEmoji));
        if (logoColor !== undefined && logoColor !== null) c = clampLogoColorJs(Number(logoColor));
        if (row) {
          if (el) applyProjectLogoToEl(el, e, c);
          else row.insertAdjacentHTML('afterbegin', buildProjectLogoHtml(e, c));
        }
      }
    }
    return group;
  }

  function bumpProjectRowCount(group) {
    if (!group) return;
    const cnt = group.querySelectorAll('.chat-item.nested').length;
    const badge = group.querySelector('.project-row-count');
    if (badge) badge.textContent = String(cnt);
  }

  function refreshAllProjectCounts(list) {
    list.querySelectorAll('.project-group').forEach((g) => bumpProjectRowCount(g));
  }

  function placeChatAsOrphan(list, link) {
    link.classList.remove('nested');
    const tail = list.querySelector('#sidebar-list-tail');
    const hasProjects = list.querySelector('.project-group');
    if (hasProjects) {
      let personalLbl = Array.from(list.querySelectorAll('.sidebar-section-label')).find(
        (x) => x.textContent.trim() === 'Personal',
      );
      if (!personalLbl) {
        personalLbl = document.createElement('div');
        personalLbl.className = 'sidebar-section-label';
        personalLbl.textContent = 'Personal';
        if (tail) list.insertBefore(personalLbl, tail);
        else list.appendChild(personalLbl);
      }
      let n = personalLbl.nextSibling;
      let lastOrphan = null;
      while (n && n !== tail) {
        if (n.nodeType === 1 && n.classList && n.classList.contains('chat-item') && !n.classList.contains('nested')) {
          lastOrphan = n;
        }
        n = n.nextSibling;
      }
      if (lastOrphan) list.insertBefore(link, lastOrphan.nextSibling);
      else list.insertBefore(link, personalLbl.nextSibling);
    } else if (tail) {
      list.insertBefore(link, tail);
    } else {
      list.appendChild(link);
    }
  }

  function placeChatInProject(list, link, projectId, projectName) {
    link.classList.add('nested');
    const group = ensureProjectGroupInSidebar(list, projectId, projectName);
    group.appendChild(link);
    bumpProjectRowCount(group);
  }

  function sidebarUpsertChat(opts) {
    const id = opts.id;
    const title = opts.title;
    const projectId = opts.projectId;
    const projectName = opts.projectName;

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
        '<span class="chat-item-title"></span>' +
        '<span class="status-dot" aria-hidden="true"></span>';
    }
    if (title != null) {
      link.title = title;
      const titleEl = link.querySelector('.chat-item-title');
      if (titleEl) titleEl.textContent = title;
    }
    const mustReposition = projectId !== undefined;
    if (mustReposition) {
      const oldGroup = link.parentElement?.closest?.('.project-group') ?? null;
      if (link.parentElement) link.parentElement.removeChild(link);
      if (projectId == null) placeChatAsOrphan(list, link);
      else placeChatInProject(list, link, projectId, projectName);
      if (oldGroup && oldGroup !== link.parentElement) bumpProjectRowCount(oldGroup);
      refreshAllProjectCounts(list);
      ensurePersonalLabelBeforeOrphans(list);
    } else if (!list.contains(link)) {
      placeChatAsOrphan(list, link);
    }
    if (id === activeChatId) {
      document.querySelector('.new-chat-btn')?.classList.remove('active');
      document.querySelector('.project-row.active')?.classList.remove('active');
      list.querySelectorAll('.project-group.active').forEach((el) => el.classList.remove('active'));
      list.querySelectorAll('.chat-item.active').forEach((el) => el.classList.remove('active'));
      link.classList.add('active');
    }
    applySidebarSearchFilterIfActive();
  }
  function sidebarRemoveChat(id) {
    const list = document.getElementById('chat-list');
    const link = list?.querySelector('.chat-item[data-chat-id="' + id + '"]');
    const parentGroup = link?.closest('.project-group');
    link?.remove();
    if (parentGroup) bumpProjectRowCount(parentGroup);
    if (searchMatchSet !== null) applySidebarSearchFilter();
  }
  function statusDot(id) {
    return document.querySelector('.chat-item[data-chat-id="' + id + '"] .status-dot');
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
  }
  function setUnreadDot(id, on) {
    const dot = statusDot(id);
    if (!dot) return;
    if (on) dot.classList.add('unread');
    else dot.classList.remove('unread');
  }

  let searchMatchSet = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let searchDebounceTimer = null;

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
    if (!list) return;
    const noMatches = ensureSearchNoMatchesEl(list);
    if (searchMatchSet === null) {
      list.querySelectorAll('.chat-item').forEach((link) => {
        link.hidden = false;
      });
      noMatches.hidden = true;
      return;
    }
    list.querySelectorAll('.chat-item').forEach((link) => {
      const id = Number(link.dataset.chatId);
      link.hidden = !searchMatchSet.has(id);
    });
    const anyVisible = list.querySelector('.chat-item:not([hidden])');
    const hasAnyChats = Boolean(list.querySelector('.chat-item'));
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
    }, 280);
  }

  function applySidebarSearchFilterIfActive() {
    if (searchMatchSet !== null) applySidebarSearchFilter();
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
      if (activeChatId != null) {
        wsSend({ type: 'subscribe', chatId: activeChatId });
        loadPendingFactSuggestions();
      }
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
        sidebarUpsertChat({
          id: msg.chatId,
          title: msg.title,
          agent: msg.agent,
          projectId: msg.projectId,
          projectName: msg.projectName,
        });
        if (searchInput && searchInput.value.trim()) scheduleSidebarSearch();
        return;

      case 'chat-updated':
        if (msg.title != null || msg.projectId !== undefined) {
          sidebarUpsertChat({
            id: msg.chatId,
            title: msg.title,
            agent: msg.agent,
            projectId: msg.projectId,
            projectName: msg.projectName,
          });
        }
        if (msg.chatId === activeChatId && msg.title != null) applyTitleForActive(msg.title);
        if (searchInput && searchInput.value.trim()) scheduleSidebarSearch();
        return;

      case 'chat-deleted':
        sidebarRemoveChat(msg.chatId);
        if (msg.chatId === activeChatId) window.location.assign('/');
        return;

      case 'chat-unread':
        setWorkingDot(msg.chatId, false);
        setUnreadDot(msg.chatId, true);
        return;

      case 'chat-read':
        setUnreadDot(msg.chatId, false);
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
        setStopVisible(true);
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
          const label = msg.label || msg.name;
          const detail = (msg.detail && msg.detail !== label) ? msg.detail : '';
          // Always show the generic label. Hover (title) and click (expand)
          // reveal the detail when present. Each new tool resets the
          // expanded state — only this current event is interactable.
          status.textContent = label;
          status.classList.remove('detail-expanded');
          if (detail) {
            status.title = detail;
            status.dataset.detail = detail;
            status.dataset.label = label;
            status.classList.add('has-detail');
          } else {
            status.removeAttribute('title');
            delete status.dataset.detail;
            delete status.dataset.label;
            status.classList.remove('has-detail');
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
        setStopVisible(false);
        // Belt + suspenders: kill any leftover reload-placeholder that might
        // still be on the page if events arrived in a weird order.
        clearStreamArtifacts();
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
        // In-flight already shifted out of waitingItems when flushed.
        inFlight = false;
        if (waitingItems[0]) flushNextQueued();
        return;
      }

      case 'project-fact-suggestions': {
        if (msg.chatId !== activeChatId) return;
        const have = existingFactSuggestionIds();
        const fresh = (msg.suggestions || []).filter((s) => s && !have.has(s.id));
        if (fresh.length === 0) return;
        appendFactSuggestionsCard({
          projectId: msg.projectId,
          chatId: msg.chatId,
          projectName: typeof msg.projectName === 'string' ? msg.projectName : 'проєкт',
          suggestions: fresh,
        });
        return;
      }

      case 'project-fact-suggestion-removed':
        removeFactSuggestionRow(msg.chatId, msg.suggestionId);
        return;

      case 'project-created': {
        const list = document.getElementById('chat-list');
        if (list) {
          ensureProjectGroupInSidebar(
            list,
            msg.project.id,
            msg.project.name,
            msg.project.logo_emoji,
            msg.project.logo_color,
          );
          ensurePersonalLabelBeforeOrphans(list);
        }
        return;
      }

      case 'project-updated': {
        const g = document
          .getElementById('chat-list')
          ?.querySelector('.project-group[data-project-id="' + msg.project.id + '"]');
        const nameEl = g?.querySelector('.project-row-name');
        if (nameEl) nameEl.textContent = msg.project.name;
        const row = g?.querySelector('.project-row');
        if (row) row.title = msg.project.name;
        const logoEl = row?.querySelector('.project-logo');
        const hasE = msg.project.logo_emoji !== undefined && msg.project.logo_emoji !== null;
        const hasC = msg.project.logo_color !== undefined && msg.project.logo_color !== null;
        if (logoEl && (hasE || hasC)) {
          const cur = readLogoFromEl(logoEl);
          const e = hasE ? clampLogoEmojiJs(Number(msg.project.logo_emoji)) : cur.ei;
          const c = hasC ? clampLogoColorJs(Number(msg.project.logo_color)) : cur.ci;
          applyProjectLogoToEl(logoEl, e, c);
        }
        if (currentProjectPageId() === msg.project.id && (hasE || hasC)) {
          const tr = document.querySelector('.project-logo-trigger .project-logo');
          const cur2 = tr ? readLogoFromEl(tr) : { ei: 0, ci: 0 };
          syncProjectPageHeaderLogo(
            hasE ? clampLogoEmojiJs(Number(msg.project.logo_emoji)) : cur2.ei,
            hasC ? clampLogoColorJs(Number(msg.project.logo_color)) : cur2.ci,
          );
        }
        return;
      }

      case 'project-deleted': {
        const list = document.getElementById('chat-list');
        list?.querySelector('.project-group[data-project-id="' + msg.projectId + '"]')?.remove();
        if (currentProjectPageId() === msg.projectId) window.location.assign('/');
        return;
      }

      case 'project-fact-added': {
        if (currentProjectPageId() !== msg.projectId) return;
        const ul = document.getElementById('facts-list');
        const cnt = document.getElementById('facts-count');
        if (!ul) return;
        ul.querySelector('.facts-empty')?.remove();
        ul.appendChild(buildFactLi(msg.fact));
        if (cnt) cnt.textContent = String(ul.querySelectorAll('li.fact').length);
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
        const cnt = document.getElementById('facts-count');
        if (ul && !ul.querySelector('li.fact')) {
          const empty = document.createElement('li');
          empty.className = 'facts-empty muted';
          empty.textContent =
            'No facts yet. Accept a suggestion in a chat in this project to add one.';
          ul.appendChild(empty);
        }
        if (cnt && ul) cnt.textContent = String(ul.querySelectorAll('li.fact').length);
        return;
      }

      case 'project-facts-synced': {
        if (currentProjectPageId() !== msg.projectId) return;
        const ul = document.getElementById('facts-list');
        const cnt = document.getElementById('facts-count');
        if (!ul) return;
        ul.replaceChildren();
        for (let i = 0; i < msg.facts.length; i++) {
          ul.appendChild(buildFactLi(msg.facts[i]));
        }
        if (msg.facts.length === 0) {
          const empty = document.createElement('li');
          empty.className = 'facts-empty muted';
          empty.textContent =
            'No facts yet. Accept a suggestion in a chat in this project to add one.';
          ul.appendChild(empty);
        }
        if (cnt) cnt.textContent = String(msg.facts.length);
        return;
      }
    }
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
    renderQueue();
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
    else {
      payload.agent = draftAgentSelect?.value || 'openclaw/default';
      const dp = draftProjectSelect;
      if (dp && dp.value) {
        const n = Number(dp.value);
        if (Number.isFinite(n) && n > 0) payload.projectId = n;
      }
    }
    if (!wsSend(payload)) {
      // No connection — put the item back at the head so it isn't lost,
      // and let the open handler retry.
      inFlight = false;
      waitingItems.unshift(item);
      renderQueue();
    }
  }

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const content = input.value.trim();
      if (!content) return;
      waitingItems.push({ content, id: 'q-' + nextQueueItemId++ });
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
  // stop button (visible while this chat is working)
  // -------------------------------------------------------------------------
  function setStopVisible(visible) {
    if (!stopBtn) return;
    stopBtn.hidden = !visible;
  }
  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      if (activeChatId == null) return;
      wsSend({ type: 'abort', chatId: activeChatId });
      // Optimistically disable until server confirms via turn-error/ended,
      // so a frustrated double-click doesn't spam the gateway.
      stopBtn.disabled = true;
      setTimeout(() => { stopBtn.disabled = false; }, 3000);
    });
  }

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

  // -------------------------------------------------------------------------
  // boot
  // -------------------------------------------------------------------------
  hydrateServerRenderedMessages();
  // Show the latest message first (chats default to the bottom of the
  // transcript, like every other chat UI). Defer to the next frame so the
  // hydrated markdown has actually been laid out.
  requestAnimationFrame(() => scrollToBottom());
  connectWs();
})();
