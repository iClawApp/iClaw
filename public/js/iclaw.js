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
  function getMessagesThreadEl() {
    return messagesEl?.querySelector(':scope > .messages-thread') ?? null;
  }
  /** Inner column for transcript rows (scroll bar stays on `#messages` full width). */
  function messagesAppendRoot() {
    return getMessagesThreadEl() ?? messagesEl;
  }
  const queueEl = document.getElementById('queue');
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

  function commitDraftFromCard(card) {
    if (!card || draftProjectLocked) return;
    const rawId = card.getAttribute('data-project-id');
    draftChosenProjectId =
      rawId == null || String(rawId).trim() === '' ? null : Number(rawId);
    if (draftChosenProjectId != null && !Number.isFinite(draftChosenProjectId)) {
      draftChosenProjectId = null;
    }
    draftProjectLocked = true;
    if (projectPickEl) projectPickEl.hidden = true;
    if (draftPickStage) draftPickStage.hidden = true;
    draftBody?.classList.remove('is-picking');
    if (draftEmptyHint) draftEmptyHint.hidden = false;
    if (composerWrap) composerWrap.hidden = false;
    input?.focus();
  }

  function initDraftProjectPick() {
    if (!startedOnDraft || !projectPickEl || !composerWrap || !draftBody) return;

    projectPickEl.addEventListener('click', (e) => {
      const card = e.target.closest('.project-pick-card');
      if (!card || draftProjectLocked) return;
      commitDraftFromCard(card);
    });

    const initSel = (projectPickEl.dataset.initialProjectId || '').trim();
    if (initSel !== '') {
      const esc =
        typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
          ? CSS.escape(initSel)
          : initSel.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const card = projectPickEl.querySelector('.project-pick-card[data-project-id="' + esc + '"]');
      if (card) queueMicrotask(() => commitDraftFromCard(card));
    }
  }

  initDraftProjectPick();
  // serializes turns per chat too, so this is just for the visible label
  const waitingItems = [];
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

  /** Build a fact row matching `views/project.ejs` (WS-driven updates on project page). */
  function buildFactLi(f) {
    const li = document.createElement('li');
    li.className = 'fact';
    li.dataset.factId = String(f.id);
    const titleRaw =
      f.source_chat_title != null && String(f.source_chat_title).trim() !== ''
        ? String(f.source_chat_title).trim()
        : 'Чат';
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
      '<textarea class="fact-content" aria-label="Текст факту" rows="2">' +
      escapeHtml(f.content || '') +
      '</textarea>' +
      '<div class="fact-meta">' +
      '<button type="button" class="fact-delete" aria-label="Видалити факт">Прибрати</button></div>';
    const ta = li.querySelector('.fact-content');
    if (ta) ta.dataset.saved = String(f.content || '').trim();
    return li;
  }
  /** Clipboard + check — inline SVG, `currentColor` from `.code-copy-btn`. */
  const CODE_COPY_ICON_SVG =
    '<svg class="code-copy-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path fill="currentColor" d="M16 1H4a2 2 0 0 0-2 2v12h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>';
  const CODE_COPIED_ICON_SVG =
    '<svg class="code-copy-icon code-copy-icon--ok" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19L21 7l-1.41-1.41L9 16.17z"/></svg>';

  function decorateLinks(root) {
    root.querySelectorAll('a[href]').forEach((a) => {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    });
  }

  /** Wrap fenced ``` blocks for a floating copy control (after markdown → DOM). */
  function enhanceCodeBlocks(root) {
    if (!root || root.nodeType !== 1) return;
    const pres = root.querySelectorAll('.msg-body pre, .stream-body pre, .reasoning-body pre');
    pres.forEach((pre) => {
      if (pre.parentElement?.classList.contains('code-block-wrap')) return;
      const wrap = document.createElement('div');
      wrap.className = 'code-block-wrap';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'code-copy-btn';
      btn.innerHTML = CODE_COPY_ICON_SVG;
      btn.setAttribute('aria-label', 'Копіювати код');
      btn.title = 'Копіювати';
      const parent = pre.parentElement;
      if (!parent) return;
      parent.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      wrap.appendChild(btn);
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
      '.msg-body pre code, .stream-body pre code, .reasoning-body pre code',
    ).forEach((code) => {
      const pre = code.parentElement;
      if (!pre || pre.tagName !== 'PRE') return;
      if (pre.closest('.exec-approval-card')) return;
      if (code.classList.contains('hljs')) return;
      try {
        hl.highlightElement(code);
      } catch (_) {
        /* unknown language / empty */
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
    if (role === 'user') return 'Ви';
    if (role === 'assistant') return 'Асистент';
    return 'Чат';
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
      '" aria-label="Перейти до цитованого повідомлення">' +
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

  function appendMessage(msg, opts) {
    if (!messagesEl) return null;
    clearEmptyState();
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
      '<div class="msg-body">' + renderMarkdown(msg.content || '') + '</div>' +
      attachmentsHtml(msg.attachments);
    decorateMessageBody(div);
    messagesAppendRoot().appendChild(div);
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
      '<div class="stream-status"></div>' +
      '<div class="msg-body stream-body"></div>';
    messagesAppendRoot().appendChild(div);
    const st = div.querySelector('.stream-status');
    if (st) setStreamStatusLabel(st, 'Thinking…');
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
      decorateMessageBody(body);
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
      '" aria-label="Пропустити">' +
      FACT_REJECT_COUNTDOWN_RING_SVG +
      '<span class="fact-suggestion-btn-glyph" aria-hidden="true">✕</span>' +
      '</button>' +
      '<button type="button" class="fact-suggestion-btn fact-suggestion-accept" data-suggestion-id="' +
      id +
      '" aria-label="Зберегти в проєкт">' +
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
      let t = null;
      btn.classList.add('fact-suggestion-reject--expiring');
      row._factExpiryClear = () => {
        if (t != null) clearTimeout(t);
        t = null;
        btn.classList.remove('fact-suggestion-reject--expiring');
        delete row._factExpiryClear;
        resolve();
      };
      t = setTimeout(() => {
        t = null;
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
      }, FACT_SUGGESTION_AUTO_REJECT_MS);
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
    const safeName = escapeHtml((projectName || '').trim() || 'проєкт');
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
      '<p class="fact-suggestions-lead">Зберегти в памʼять «' +
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
      // ⏵ Interrupt = "send THIS one now": move it to the front of the queue,
      // then abort the current turn. The existing turn-error handler will
      // auto-flush, which picks up our new-head item next.
      el.innerHTML =
        '<span class="queue-status">Queued #' + (idx + 1) + '</span>' +
        '<span class="queue-text">' + escapeHtml(preview) + '</span>' +
        '<button type="button" class="queue-interrupt btn btn--icon btn--ghost" ' +
        'aria-label="Interrupt current and send this one now" ' +
        'title="Interrupt the current turn and send this message next">⏵</button>' +
        '<button type="button" class="queue-remove btn btn--icon btn--ghost" ' +
        'aria-label="Remove from queue" title="Remove from queue">×</button>';
      queueEl.appendChild(el);
    });
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
          copyBtn.setAttribute('aria-label', 'Скопійовано');
          copyBtn.removeAttribute('title');
          copyBtn.disabled = true;
          setTimeout(() => {
            copyBtn.innerHTML = CODE_COPY_ICON_SVG;
            copyBtn.setAttribute('aria-label', 'Копіювати код');
            copyBtn.title = 'Копіювати';
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
  if (queueEl) {
    queueEl.addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.queue-remove');
      const interruptBtn = e.target.closest('.queue-interrupt');
      const btn = removeBtn || interruptBtn;
      if (!btn) return;
      const itemEl = btn.closest('.queue-item');
      const id = itemEl?.dataset.itemId;
      if (!id) return;
      const idx = waitingItems.findIndex((it) => it.id === id);
      if (idx < 0) return;

      if (removeBtn) {
        waitingItems.splice(idx, 1);
        renderQueue();
        return;
      }

      // Interrupt: move this item to the front and abort the running turn.
      // The turn-error handler clears inFlight and calls flushNextQueued(),
      // which now picks up our promoted item.
      if (activeChatId == null) return;
      const [picked] = waitingItems.splice(idx, 1);
      waitingItems.unshift(picked);
      renderQueue();
      // If nothing is actually running, just flush now — no need to abort.
      if (!inFlight) {
        flushNextQueued();
        return;
      }
      // Optimistically disable buttons to prevent rapid double-clicks.
      btn.disabled = true;
      setTimeout(() => { btn.disabled = false; }, 3000);
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
      const cmp = pa.name.localeCompare(pb.name, 'uk', { sensitivity: 'base' });
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
      link.title = title;
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
      ? '<button type="button" class="sidebar-context-menu-item" data-action="share">Поділитися</button>'
      : '';
    return (
      shareBtnHtml +
      '<button type="button" class="sidebar-context-menu-item" data-action="rename">Перейменувати</button>' +
      '<button type="button" class="sidebar-context-menu-item" data-action="unread">Непрочитане</button>' +
      '<button type="button" class="sidebar-context-menu-item sidebar-context-menu-danger" data-action="delete">Видалити чат</button>'
    );
  }

  function closeSidebarChatMenu() {
    sidebarChatMenu.hidden = true;
    sidebarMenuChatId = null;
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
  }

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
      const curTitle = (titleEl && titleEl.textContent ? titleEl.textContent : '').trim() || 'Чат';
      const next = window.prompt('Нова назва чату:', curTitle);
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
          link.title = nextTitle;
        }
        if (activeChatId === cid && titleInput) {
          titleInput.value = nextTitle;
          titleInput.defaultValue = nextTitle;
        }
      } catch (err) {
        console.error('[iclaw] sidebar rename failed', err);
        window.alert('Не вдалось зберегти назву.');
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
        window.location.assign('/');
      } catch (err) {
        console.error('[iclaw] mark unread failed', err);
      }
      return;
    }
    if (action === 'delete') {
      if (!confirm('Видалити цей чат?')) return;
      const f = document.createElement('form');
      f.method = 'POST';
      f.action = '/chats/' + encodeURIComponent(cid) + '/delete';
      document.body.appendChild(f);
      f.submit();
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
      openSidebarChatMenu(e.clientX, e.clientY, id);
    });
  }

  const selectionReplyFab = document.createElement('div');
  selectionReplyFab.id = 'msg-selection-reply-fab';
  selectionReplyFab.hidden = true;
  selectionReplyFab.innerHTML =
    '<button type="button" class="msg-selection-reply-btn">Відповісти</button>';
  document.body.appendChild(selectionReplyFab);

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
      el.classList.contains('reasoning-block')
    ) {
      return null;
    }
    const msgBody = anchorRoot && anchorRoot.closest ? anchorRoot.closest('.msg-body') : null;
    if (!msgBody || !el.contains(msgBody)) return null;
    const roleEl = el.querySelector('.role');
    const role = (roleEl && roleEl.textContent ? roleEl.textContent : '').trim();
    if (role !== 'user' && role !== 'assistant') return null;
    const messageId = Number(el.dataset.msgId);
    if (!Number.isFinite(messageId)) return null;
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    return { messageId, quote, rect, role };
  }

  selectionReplyFab.addEventListener('mousedown', (e) => {
    e.preventDefault();
  });
  selectionReplyFab.querySelector('button')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const mid = Number(selectionReplyFab.dataset.pendingMsgId);
    const quote = selectionReplyFab.dataset.pendingQuote || '';
    const role = selectionReplyFab.dataset.pendingRole || '';
    hideSelectionReplyFab();
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    if (Number.isFinite(mid) && quote) {
      pendingComposerReply = { messageId: mid, quote, role };
      updateComposerReplyBar();
      input?.focus();
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
          updatedAt: msg.updatedAt,
        });
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
        // Sync header controls when another tab/CLI flipped these.
        if (msg.chatId === activeChatId && msg.reasoningMode !== undefined && reasoningToggle) {
          reasoningToggle.checked = msg.reasoningMode !== 'off';
        }
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
        const body = el.querySelector('.stream-body, .msg-body');
        if (body) {
          body.innerHTML = renderMarkdown(currentStreamFullText);
          decorateMessageBody(body, { deferSyntaxHighlight: true });
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
        finalizeReasoningBlock();
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
        finalizeReasoningBlock();
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

      case 'project-fact-suggestions': {
        if (msg.chatId !== activeChatId) return;
        const have = existingFactSuggestionIds();
        const fresh = (msg.suggestions || []).filter((s) => s && !have.has(Number(s.id)));
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
        if (currentProjectPageId() === pid) window.location.assign('/projects');
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
            'Поки немає фактів. Підтвердіть пропозицію в чаті цього проєкту.';
          ul.appendChild(empty);
        }
        syncProjectMemoryTabCountFromDom();
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
            'Поки немає фактів. Підтвердіть пропозицію в чаті цього проєкту.';
          ul.appendChild(empty);
        }
        syncProjectMemoryTabCountFromDom();
        return;
      }

      case 'scheduled-added': {
        if (msg.chatId !== activeChatId) return;
        renderScheduledItem(msg.scheduled);
        return;
      }

      case 'scheduled-deleted': {
        if (msg.chatId !== activeChatId) return;
        removeScheduledItem(msg.scheduledId);
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

      case 'turn-reasoning': {
        if (msg.chatId !== activeChatId) return;
        appendReasoningChunk(msg.text);
        return;
      }

      case 'gateway-session-changed':
        // Informational — for now we don't auto-refetch the sidebar. Logging
        // this lets future iterations decide what to do without changing the
        // wire protocol again.
        console.debug('[iclaw] gateway-session-changed', msg.kind, msg.sessionKey);
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
  function applyGatewayStatus(status, detail) {
    const badge = document.getElementById('gateway-badge');
    if (!badge) return;
    badge.classList.remove('ok', 'down', 'degraded', 'shutdown');
    if (status === 'ok') {
      badge.classList.add('ok');
      badge.textContent = 'OpenClaw: connected';
    } else if (status === 'degraded') {
      badge.classList.add('degraded');
      badge.textContent = 'OpenClaw: degraded';
    } else if (status === 'shutdown') {
      badge.classList.add('shutdown');
      badge.textContent = 'OpenClaw: shutting down';
    } else {
      badge.classList.add('down');
      badge.textContent = 'OpenClaw: unreachable';
    }
    const baseUrl = badge.dataset.baseUrl || '';
    badge.title = detail ? detail + (baseUrl ? ' — ' + baseUrl : '') : baseUrl;
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
    const optimistic = { role: 'user', content: item.content };
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
    currentStreamEl = ensureStreamEl();
    const payload = {
      type: 'send',
      requestId: 'r-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      content: item.content,
    };
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
      waitingItems.unshift(item);
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
          r === 'user' ? 'Ви' : r === 'assistant' ? 'Асистент' : 'Чат';
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
          '" aria-label="Прибрати">×</button>' +
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
        const m = /^data:([^;,]+)?(?:;[^,]*)?,(.*)$/.exec(dataUrl);
        const base64 = m ? m[2] : '';
        const sniffedMime = m && m[1] ? m[1].trim() : '';
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
  if (attachBtn && fileInput) {
    attachBtn.addEventListener('click', () => fileInput.click());
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

  if (form && input) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (startedOnDraft && !draftProjectLocked) return;
      // If the schedule menu was just opened by a long-press, the bubbling
      // click on the send button would otherwise submit a regular message.
      if (scheduleMenuJustOpened || isScheduleMenuOpen()) {
        scheduleMenuJustOpened = false;
        return;
      }
      const content = input.value.trim();
      if (!content && pendingAttachments.length === 0) return;
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
      waitingItems.push({
        content,
        id: 'q-' + nextQueueItemId++,
        replyTo: replySnap || undefined,
        attachments: attachmentsSnap.length > 0 ? attachmentsSnap : undefined,
      });
      input.value = '';
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
  const sendBtn = document.getElementById('composer-send-btn');
  const scheduledListEl = document.getElementById('scheduled-list');
  const scheduleCustomRow = scheduleMenu?.querySelector('.schedule-custom-row');
  const scheduleCustomInput = document.getElementById('schedule-custom-input');
  const scheduleCustomConfirm = document.getElementById('schedule-custom-confirm');
  const LONG_PRESS_MS = 450;
  let schedulePressTimer = null;
  let scheduleMenuJustOpened = false;
  let scheduleMenuAutoCloseTimer = null;

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

  function closeScheduleMenu() {
    if (!scheduleMenu) return;
    scheduleMenu.hidden = true;
    if (scheduleCustomRow) scheduleCustomRow.hidden = true;
    scheduleMenuJustOpened = false;
    if (scheduleMenuAutoCloseTimer != null) {
      clearTimeout(scheduleMenuAutoCloseTimer);
      scheduleMenuAutoCloseTimer = null;
    }
    document.removeEventListener('pointerdown', onScheduleMenuOutsidePointerDown, true);
  }

  function openScheduleMenu() {
    if (!scheduleMenu) return;
    if (!input.value.trim()) return;
    document.removeEventListener('pointerdown', onScheduleMenuOutsidePointerDown, true);
    scheduleMenu.hidden = false;
    if (scheduleCustomRow) scheduleCustomRow.hidden = true;
    if (scheduleMenuAutoCloseTimer != null) clearTimeout(scheduleMenuAutoCloseTimer);
    scheduleMenuAutoCloseTimer = setTimeout(() => {
      scheduleMenuAutoCloseTimer = null;
      closeScheduleMenu();
    }, 10_000);
    setTimeout(() => {
      document.addEventListener('pointerdown', onScheduleMenuOutsidePointerDown, true);
    }, 0);
  }

  /** Parse the SQLite UTC stamp ("YYYY-MM-DD HH:MM:SS") as a real UTC instant. */
  function parseScheduledStamp(stamp) {
    if (!stamp) return null;
    const s = String(stamp).trim();
    // ISO with timezone — trust as-is
    if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    // 'YYYY-MM-DD HH:MM:SS' or 'YYYY-MM-DDTHH:MM:SS' — server emits UTC
    const norm = s.replace(' ', 'T') + 'Z';
    const d = new Date(norm);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /** Render the "when" cell as a friendly local string. */
  function formatScheduledWhen(stamp) {
    const d = parseScheduledStamp(stamp);
    if (!d) return String(stamp);
    const now = new Date();
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const sameDay = d.toDateString() === now.toDateString();
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    const isTomorrow = d.toDateString() === tomorrow.toDateString();
    if (sameDay) return 'сьогодні ' + time;
    if (isTomorrow) return 'завтра ' + time;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ', ' + time;
  }

  function computeScheduledAt(offset) {
    const now = new Date();
    if (offset === '10m') return new Date(now.getTime() + 10 * 60_000);
    if (offset === '1h')  return new Date(now.getTime() + 60 * 60_000);
    if (offset === '3h')  return new Date(now.getTime() + 3 * 60 * 60_000);
    if (offset === 'tomorrow9') {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d;
    }
    return null;
  }

  /** Pad a Date into 'YYYY-MM-DDTHH:MM' for `<input type="datetime-local">`. */
  function toDatetimeLocalValue(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
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
    row.className = 'scheduled-item';
    row.dataset.scheduledId = String(scheduled.id);
    row.dataset.scheduledAt = scheduled.scheduled_at;
    row.innerHTML =
      '<div class="scheduled-item-main">' +
      '<div class="scheduled-item-meta">' +
      '<span class="scheduled-item-clock" aria-hidden="true">⏰</span>' +
      '<span class="scheduled-item-when" data-when="' + escapeHtml(scheduled.scheduled_at) + '">' +
      escapeHtml(formatScheduledWhen(scheduled.scheduled_at)) + '</span>' +
      '</div>' +
      '<div class="scheduled-item-text">' + escapeHtml(scheduled.content) + '</div>' +
      '</div>' +
      '<button type="button" class="scheduled-item-cancel btn btn--icon btn--ghost" data-scheduled-id="' +
      scheduled.id + '" aria-label="Скасувати заплановане повідомлення" title="Скасувати">×</button>';
    scheduledListEl.appendChild(row);
    scheduledListEl.classList.remove('is-empty');
  }
  function removeScheduledItem(id) {
    if (!scheduledListEl) return;
    const row = scheduledListEl.querySelector('.scheduled-item[data-scheduled-id="' + id + '"]');
    if (row) row.remove();
    if (!scheduledListEl.querySelector('.scheduled-item')) {
      scheduledListEl.classList.add('is-empty');
    }
  }

  async function submitScheduled(when) {
    if (activeChatId == null) return;
    const content = input.value.trim();
    if (!content) return;
    if (when.getTime() <= Date.now() - 60_000) {
      // 60s of tolerance; older than that is almost certainly a mistake.
      alert('Час уже минув — оберіть час у майбутньому.');
      return;
    }
    try {
      const res = await fetch(
        '/chats/' + encodeURIComponent(activeChatId) + '/scheduled',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content, scheduledAt: when.toISOString() }),
        },
      );
      if (!res.ok) throw new Error(await res.text());
      input.value = '';
      closeScheduleMenu();
      // Live `scheduled-added` broadcast will render the row.
    } catch (err) {
      alert('Не вдалось запланувати: ' + (err instanceof Error ? err.message : err));
    }
  }

  // long-press detection on the send button
  if (sendBtn) {
    sendBtn.addEventListener('pointerdown', () => {
      if (startedOnDraft || activeChatId == null) return;
      if (!input.value.trim()) return;
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

  if (scheduleMenu) {
    scheduleMenu.addEventListener('click', (e) => {
      const btn = e.target.closest('.schedule-menu-item');
      if (!btn) return;
      const offset = btn.dataset.offset;
      if (offset === 'custom') {
        if (scheduleCustomRow) scheduleCustomRow.hidden = false;
        if (scheduleCustomInput) {
          scheduleCustomInput.value = toDatetimeLocalValue(new Date(Date.now() + 60 * 60_000));
          scheduleCustomInput.focus();
        }
        return;
      }
      const when = computeScheduledAt(offset);
      if (when) submitScheduled(when);
    });
    scheduleCustomConfirm?.addEventListener('click', () => {
      const v = scheduleCustomInput?.value;
      if (!v) return;
      // datetime-local is interpreted as the user's local time
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return;
      submitScheduled(d);
    });
  }

  // Cancel buttons on the scheduled-list banner.
  if (scheduledListEl) {
    scheduledListEl.addEventListener('click', async (e) => {
      const btn = e.target.closest('.scheduled-item-cancel');
      if (!btn) return;
      const sid = Number(btn.dataset.scheduledId);
      if (!Number.isFinite(sid) || activeChatId == null) return;
      // Optimistic remove; if it fails, `scheduled-added` won't fire so we'd
      // miss the row. Acceptable — refetch on next page load anyway.
      removeScheduledItem(sid);
      try {
        await fetch(
          '/chats/' + encodeURIComponent(activeChatId) +
            '/scheduled/' + encodeURIComponent(sid) + '/delete',
          { method: 'POST' },
        );
      } catch {
        /* silent — broadcast will reconcile */
      }
    });
    // Hydrate the EJS-rendered "when" cells with local-friendly strings.
    refreshScheduledTimes();
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
  // Chat header extras: Reasoning toggle
  // (Interrupt moved to per-queue-item buttons; Compact removed — OpenClaw
  // auto-compacts at context limit, and users who want it can still type
  // /compact in the composer.)
  // -------------------------------------------------------------------------
  const reasoningToggle = document.getElementById('chat-reasoning-toggle');

  if (reasoningToggle && activeChatId != null) {
    reasoningToggle.addEventListener('change', async () => {
      const mode = reasoningToggle.checked ? 'on' : 'off';
      try {
        // Persist the iClaw mirror first so a slow gateway doesn't desync the UI.
        await fetch('/chats/' + encodeURIComponent(activeChatId) + '/reasoning', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode }),
        });
      } catch {
        // revert if the server didn't accept
        reasoningToggle.checked = !reasoningToggle.checked;
        return;
      }
      // The OpenClaw gateway only actually emits reasoning when the session
      // has been told to via /reasoning. Without this the toggle was a UI
      // placebo — checked but no analysis events ever arrived. Now we push
      // the slash command through the normal queue so OpenClaw flips state
      // server-side too. The /reasoning turn is small and bookkeeping-only.
      waitingItems.push({
        content: '/reasoning ' + mode,
        id: 'q-' + nextQueueItemId++,
      });
      renderQueue();
      flushNextQueued();
    });
  }

  // -------------------------------------------------------------------------
  // Usage cost chip — polls /api/gateway/usage/today every 30s
  // -------------------------------------------------------------------------
  const costChip = document.getElementById('cost-chip');
  function fmtUsd(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    if (n < 0.005) return '$0.00';
    if (n < 1) return '$' + n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    return '$' + n.toFixed(2);
  }
  async function refreshCost() {
    if (!costChip) return;
    try {
      const res = await fetch('/api/gateway/usage/today', { headers: { Accept: 'application/json' } });
      if (!res.ok) {
        costChip.hidden = true;
        return;
      }
      const data = await res.json();
      const txt = fmtUsd(data.totalUsd);
      if (txt == null) {
        costChip.hidden = true;
        return;
      }
      costChip.textContent = 'Today ' + txt;
      costChip.hidden = false;
    } catch {
      costChip.hidden = true;
    }
  }
  if (costChip) {
    refreshCost();
    setInterval(refreshCost, 30_000);
  }

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
      '<span class="exec-approval-title">Дозвіл на виконання команди</span>' +
      '<span class="exec-approval-host">' + escapeHtml(opts.host || 'gateway') + '</span>' +
      '</div>' +
      '<pre class="exec-approval-cmd"><code>' + safeCmd + '</code></pre>' +
      cwdLine + reasonLine +
      '<div class="exec-approval-actions">' +
      '<button type="button" class="exec-approval-btn exec-approval-deny btn btn--danger btn--sm" data-decision="denied">Відхилити</button>' +
      '<button type="button" class="exec-approval-btn exec-approval-approve btn btn--approve btn--sm" data-decision="approved">Дозволити</button>' +
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
  // Reasoning text rendering
  // -------------------------------------------------------------------------
  function appendReasoningChunk(text) {
    if (!messagesEl || !text) return;
    let block = messagesEl.querySelector('.reasoning-block.active');
    if (!block) {
      block = document.createElement('div');
      block.className = 'msg assistant reasoning-block active';
      block.innerHTML =
        '<div class="role">reasoning</div>' +
        '<div class="msg-body reasoning-body"></div>';
      // Insert above any currently-streaming assistant element so the user
      // sees thinking → answer, not answer → thinking.
      const appendRoot = messagesAppendRoot();
      if (currentStreamEl && appendRoot && currentStreamEl.parentElement === appendRoot) {
        appendRoot.insertBefore(block, currentStreamEl);
      } else if (appendRoot) {
        appendRoot.appendChild(block);
      }
    }
    const body = block.querySelector('.reasoning-body');
    if (body) body.textContent += text;
    scrollToBottom();
  }
  function finalizeReasoningBlock() {
    if (!messagesEl) return;
    messagesEl.querySelectorAll('.reasoning-block.active').forEach((b) => {
      b.classList.remove('active');
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
    if (location.pathname === '/' || location.pathname === '') return;
    window.location.assign('/');
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
      links: document.getElementById('project-panel-links'),
      files: document.getElementById('project-panel-files'),
    };
    if (!tabs.length || !panels.chats || !panels.memory || !panels.links || !panels.files) return;

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
  initProjectPageTabs();
  hydrateServerRenderedMessages();
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
  connectWs();
})();
