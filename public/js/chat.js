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
  const titleInput = document.getElementById('chat-title-input');

  const waitingItems = [];
  let inFlight = null;
  let pumping = false;

  const STREAM_HEADERS = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
  };

  // ---------- markdown rendering ----------

  // marked v15+: configure once. `breaks` turns single newlines into <br>, which
  // matches assistant output that uses bare newlines for line breaks. `gfm` enables
  // tables, strikethrough, autolinks. Marked escapes raw HTML by default, so
  // inline `<script>` from an agent reply renders as literal text — safe enough
  // for a local-first app with a trusted gateway.
  const VIDEO_EXT_RE = /\.(mp4|webm|ogg|mov|m4v)(\?[^#]*)?$/i;

  if (window.marked) {
    if (typeof window.marked.setOptions === 'function') {
      window.marked.setOptions({ breaks: true, gfm: true });
    }
    if (typeof window.marked.use === 'function') {
      // Auto-embed direct video URLs as <video> instead of <a>. We only handle
      // the simple case where the link text equals the href (autolink) or the
      // text doesn't contain HTML — for `[![poster](thumb)](video.mp4)` we
      // fall through so the user gets a clickable poster image.
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
            return false; // fall back to marked's default renderer
          },
        },
      });
    }
  }

  function renderMarkdown(text) {
    const src = String(text ?? '');
    if (!window.marked || typeof window.marked.parse !== 'function') {
      return escapeHtml(src);
    }
    try {
      return window.marked.parse(src);
    } catch {
      return escapeHtml(src);
    }
  }

  function escapeHtml(s) {
    return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  }

  // Open all links inside rendered messages in a new tab, with safe rel.
  function decorateLinks(root) {
    root.querySelectorAll('a[href]').forEach((a) => {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    });
  }

  // Hydrate server-rendered messages on page load: their .msg-body contains the
  // raw (HTML-escaped by EJS) source — replace it with the markdown render.
  function hydrateServerRenderedMessages() {
    messagesEl.querySelectorAll('.msg .msg-body').forEach((body) => {
      const raw = body.textContent ?? '';
      if (!raw) return;
      body.innerHTML = renderMarkdown(raw);
      decorateLinks(body);
    });
  }

  // ---------- DOM helpers ----------

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
    div.innerHTML =
      '<div class="role">user</div>' +
      '<div class="msg-body">' + renderMarkdown(content) + '</div>';
    decorateLinks(div);
    messagesEl.appendChild(div);
    scrollMessagesToBottom();
    return div;
  }

  function beginAssistantStream(userNode) {
    const div = document.createElement('div');
    div.className = 'msg assistant streaming stream-waiting';
    div.innerHTML =
      '<div class="role">assistant</div>' +
      '<div class="stream-status">Thinking…</div>' +
      '<div class="msg-body stream-body"></div>';
    userNode.insertAdjacentElement('afterend', div);
    scrollMessagesToBottom();
    return div;
  }

  function createStreamContext(assistantEl) {
    return {
      assistantEl,
      statusEl: assistantEl.querySelector('.stream-status'),
      bodyEl: assistantEl.querySelector('.stream-body'),
      gotDelta: false,
      activeTool: null,
      donePayload: null,
      pendingTitle: null,
      fullText: '',
    };
  }

  function onFirstDelta(ctx) {
    if (ctx.gotDelta) return;
    ctx.gotDelta = true;
    ctx.activeTool = null;
    ctx.assistantEl.classList.remove('stream-waiting', 'stream-tool');
    ctx.assistantEl.classList.add('stream-generating');
    if (ctx.statusEl) ctx.statusEl.hidden = true;
  }

  function handleStreamEvent(ev, ctx) {
    if (ev.type === 'status' && ctx.statusEl && !ctx.gotDelta) {
      ctx.statusEl.hidden = false;
      ctx.statusEl.textContent = 'Thinking…';
      ctx.assistantEl.classList.add('stream-waiting');
      ctx.assistantEl.classList.remove('stream-tool', 'stream-generating');
    } else if (
      (ev.type === 'tool' || ev.type === 'lifecycle') &&
      ctx.statusEl &&
      !ctx.gotDelta
    ) {
      if (ev.type === 'lifecycle') {
        ctx.activeTool = null;
        ctx.statusEl.hidden = false;
        ctx.statusEl.textContent = ev.label || ev.phase;
        ctx.assistantEl.classList.remove('stream-generating');
        ctx.assistantEl.classList.add('stream-tool');
      } else if (ev.phase === 'start') {
        ctx.activeTool = ev.name;
        ctx.statusEl.hidden = false;
        ctx.statusEl.textContent = ev.label || ev.name;
        ctx.assistantEl.classList.remove('stream-waiting', 'stream-generating');
        ctx.assistantEl.classList.add('stream-tool');
      } else if (ev.phase === 'end' && ctx.activeTool === ev.name) {
        ctx.activeTool = null;
      }
    } else if (ev.type === 'title' && ev.title) {
      const chatId = ev.id ?? activeChatId;
      if (chatId) {
        ctx.pendingTitle = ev.title;
        applyChatTitle(chatId, ev.title);
        if (!activeChatId) activeChatId = chatId;
      }
    } else if (ev.type === 'delta' && ctx.bodyEl) {
      onFirstDelta(ctx);
      ctx.fullText += ev.text;
      // Re-render the whole accumulated text as markdown. marked is fast enough
      // for normal-sized replies; ChatGPT does the same.
      ctx.bodyEl.innerHTML = renderMarkdown(ctx.fullText);
      decorateLinks(ctx.bodyEl);
      scrollMessagesToBottom();
    } else if (ev.type === 'done') {
      ctx.donePayload = ev;
    } else if (ev.type === 'error') {
      throw new Error(ev.error || 'Stream error');
    }
  }

  function finalizeStream(ctx) {
    ctx.assistantEl.classList.remove(
      'streaming',
      'stream-waiting',
      'stream-tool',
      'stream-generating',
    );
    if (!ctx.gotDelta && ctx.statusEl) ctx.statusEl.hidden = true;
    // Final paint: the markdown was rendered incrementally; if upstream sent
    // any trailing text or done.message.content differs, re-render to truth.
    if (ctx.donePayload?.message?.content && ctx.bodyEl) {
      ctx.bodyEl.innerHTML = renderMarkdown(ctx.donePayload.message.content);
      decorateLinks(ctx.bodyEl);
    }
  }

  function insertErrorAfter(userNode, msg) {
    const div = document.createElement('div');
    div.className = 'msg system error';
    div.innerHTML =
      '<div class="role">error</div>' +
      '<div class="msg-body">' + escapeHtml(msg) + '</div>';
    userNode.insertAdjacentElement('afterend', div);
    return div;
  }

  // ---------- queue widget ----------

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

  // ---------- chat title sync ----------

  function deriveTitle(content) {
    const t = String(content).trim();
    if (!t) return 'New chat';
    return t.length > 60 ? t.slice(0, 59) + '…' : t;
  }

  function setTitleInput(title, enabled) {
    if (!titleInput) return;
    titleInput.value = title;
    titleInput.defaultValue = title;
    if (enabled !== undefined) titleInput.disabled = !enabled;
  }

  function applyChatTitle(chatId, title) {
    const list = document.getElementById('chat-list');
    if (list) {
      list.querySelector('.empty-list')?.remove();
      document.querySelector('.new-chat-btn')?.classList.remove('active');
      list.querySelectorAll('.chat-item.active').forEach((el) => el.classList.remove('active'));

      let link = list.querySelector('.chat-item[data-chat-id="' + chatId + '"]');
      if (!link) {
        link = document.createElement('a');
        link.href = '/chats/' + chatId;
        link.className = 'chat-item active';
        link.dataset.chatId = String(chatId);
        link.innerHTML =
          '<span class="working-dot" aria-hidden="true"></span>' +
          '<span class="chat-item-title"></span>';
        list.prepend(link);
      } else {
        link.classList.add('active');
      }

      link.title = title;
      const titleEl = link.querySelector('.chat-item-title');
      if (titleEl) titleEl.textContent = title;
    }

    setTitleInput(title, true);
    document.title = title + ' — iClaw';
  }

  async function saveChatTitle(chatId) {
    if (!titleInput || !chatId) return;
    const next = titleInput.value.trim();
    if (!next || next === titleInput.defaultValue) return;
    const res = await fetch('/chats/' + encodeURIComponent(chatId), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: next }),
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    applyChatTitle(chatId, data.title);
  }

  function promoteDraftToChat(id, title) {
    activeChatId = id;
    messagesEl.dataset.chatId = String(id);
    delete messagesEl.dataset.draft;
    history.replaceState(null, '', '/chats/' + id);
    if (startedOnDraft) applyChatTitle(id, title);
    else setTitleInput(title, true);
  }

  // ---------- SSE ----------

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
    const ctx = createStreamContext(beginAssistantStream(userNode));

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = parseSseBlocks(buffer, (ev) => handleStreamEvent(ev, ctx));
    }

    buffer += decoder.decode();
    parseSseBlocks(buffer + '\n\n', (ev) => handleStreamEvent(ev, ctx));

    finalizeStream(ctx);
    return { done: ctx.donePayload, pendingTitle: ctx.pendingTitle };
  }

  function resolveChatTitle(done, pendingTitle, fallbackContent) {
    return done?.title ?? pendingTitle ?? deriveTitle(fallbackContent);
  }

  async function streamCreateFirst(item, agent) {
    const res = await fetch('/chats', {
      method: 'POST',
      headers: STREAM_HEADERS,
      body: JSON.stringify({ agent, content: item.content }),
    });
    if (!res.ok) throw new Error(await res.text());
    const { done, pendingTitle } = await consumeSseResponse(res, item.userNode);
    const chatId = done?.id ?? done?.message?.chat_id;
    if (chatId) {
      promoteDraftToChat(chatId, resolveChatTitle(done, pendingTitle, item.content));
    }
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
    pumpQueue();
  }

  // ---------- reload-during-processing recovery ----------
  //
  // If the page is loaded while this chat is mid-turn (server flagged
  // isWorking → template rendered #reload-placeholder), wire it up so:
  //   - the label tracks current activity (via status.js polling)
  //   - when the chat goes idle, fetch /chats/:id/messages and insert any
  //     messages that arrived since the last user msg already in the DOM
  //
  // This recovers from F5 / closed tab / new window flows. We don't get
  // token-by-token replay (that would need a shared event bus), but the
  // user sees a sensible placeholder, live status updates, and the full
  // assistant reply once it lands.

  function setPlaceholderLabel(placeholder, label) {
    const statusEl = placeholder.querySelector('.stream-status');
    if (statusEl) statusEl.textContent = label;
  }

  function setPlaceholderState(placeholder, activity) {
    placeholder.classList.remove(
      'stream-waiting',
      'stream-tool',
      'stream-generating',
    );
    if (!activity) {
      placeholder.classList.add('stream-waiting');
      return;
    }
    if (activity.kind === 'generating') placeholder.classList.add('stream-generating');
    else if (activity.kind === 'tool' || activity.kind === 'lifecycle') {
      placeholder.classList.add('stream-tool');
    } else placeholder.classList.add('stream-waiting');
  }

  async function reconcileMessagesAfterIdle(placeholder) {
    if (!activeChatId) return;
    try {
      const res = await fetch('/chats/' + encodeURIComponent(activeChatId) + '/messages', {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(await res.text());
      const all = await res.json();
      const knownIds = new Set();
      messagesEl.querySelectorAll('.msg[data-msg-id]').forEach((el) => {
        knownIds.add(Number(el.dataset.msgId));
      });

      // Find the assistant message that filled this placeholder. It's the
      // most recent assistant message not already known to the DOM.
      const newest = [...all].reverse().find(
        (m) => m.role === 'assistant' && !knownIds.has(m.id),
      );
      if (newest) {
        placeholder.classList.remove(
          'streaming',
          'stream-waiting',
          'stream-tool',
          'stream-generating',
        );
        placeholder.id = '';
        placeholder.dataset.msgId = String(newest.id);
        const statusEl = placeholder.querySelector('.stream-status');
        if (statusEl) statusEl.remove();
        const bodyEl = placeholder.querySelector('.stream-body');
        if (bodyEl) {
          bodyEl.classList.remove('stream-body');
          bodyEl.innerHTML = renderMarkdown(newest.content || '');
          decorateLinks(bodyEl);
        }
      } else {
        // Idle but no new assistant message — likely an error mid-turn.
        // Replace placeholder with an explanation.
        placeholder.replaceWith(
          (() => {
            const div = document.createElement('div');
            div.className = 'msg system error';
            div.innerHTML =
              '<div class="role">error</div>' +
              '<div class="msg-body">' +
              escapeHtml('Turn ended without an assistant reply. Try again.') +
              '</div>';
            return div;
          })(),
        );
      }
    } catch (err) {
      console.error('reload reconcile failed', err);
    }
  }

  function wireReloadPlaceholder() {
    const placeholder = document.getElementById('reload-placeholder');
    if (!placeholder || !activeChatId) return;

    const onStatus = (ev) => {
      const activity = ev.activities.get(activeChatId);
      const stillWorking = ev.workingIds.has(activeChatId);

      if (stillWorking) {
        // Update the label if activity changed.
        if (ev.activityChanged.includes(activeChatId) || ev.wentWorking.includes(activeChatId)) {
          setPlaceholderState(placeholder, activity);
          if (activity?.label) setPlaceholderLabel(placeholder, activity.label);
        }
      } else if (ev.wentIdle.includes(activeChatId)) {
        unsubscribe();
        reconcileMessagesAfterIdle(placeholder);
      }
    };

    const unsubscribe = window.iclawStatus?.onChange(onStatus) ?? (() => {});
  }

  // ---------- wiring ----------

  hydrateServerRenderedMessages();
  wireReloadPlaceholder();

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

  if (titleInput) {
    if (!startedOnDraft || activeChatId) titleInput.disabled = false;
    titleInput.addEventListener('blur', () => {
      if (activeChatId) {
        saveChatTitle(activeChatId).catch(() => {
          titleInput.value = titleInput.defaultValue;
        });
      }
    });
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        titleInput.blur();
      }
    });
  }

  input.focus();
})();
