# Roadmap

A public sketch of where iClaw is heading. Anything not on this list is open for discussion — open an issue.

This isn't a contract. Priorities shift based on what users actually use.

## v0.1 — Public preview ✅

Shipped. See [CHANGELOG](CHANGELOG.md).

- ChatGPT-style two-column UI
- Local-first SQLite history, auto-loaded gateway token
- ~~OpenAI-compatible client for OpenClaw~~ → migrated to **native OpenClaw WebSocket** in `c1bb574` (operator/backend handshake, `chat.send`/`chat.history`, lifecycle + tool streams)
- Lazy chat creation, queued sends, AI-generated titles
- Token streaming + live tool activity over the same WS

## v0.2 — Quality of life ✅ (mostly)

Focus: make the daily-driver experience smoother.

- [x] Markdown rendering in assistant messages (code blocks, lists, links)
- [x] Syntax-highlighted code blocks (vendored highlight.js) with floating copy button
- [x] Dark theme (`prefers-color-scheme`) — light + dark token sets
- [x] Search across all chats (titles + message bodies, debounced)
- [x] Stop generation button (cancels in-flight turn via `chat.abort`)
- [x] Scroll-to-bottom on open without visible scroll animation
- [x] Live sidebar reorder when a chat receives a new message
- [ ] Keyboard shortcuts: `Cmd/Ctrl+K` (chat switcher), `Cmd/Ctrl+N` (new chat)
- [ ] Export chat as Markdown or JSON
- [ ] Better error toasts (not just inline `<div class="error">`)

## v0.3 — Power user (in flight)

Focus: features that ChatGPT users miss most + leverage what OpenClaw exposes.

- [x] **Projects with shared context** — each project owns its chats; per-turn AI fact extraction with user accept/reject in chat; auto-compaction at 30 facts; per-chat toggle to block writing back to the project (read always allowed).
- [x] **Scheduled messages** (Telegram-style hold-to-send): presets + custom datetime; restart-safe sweeper; per-chat banner with cancel.
- [x] **Per-chat model override** via `sessions.patch` + a `/models` picker in the header.
- [x] **Exec approvals** surfaced inline (Approve / Deny card driven by `exec.approval.requested` / `exec.approval.resolve`).
- [x] **Slash autocomplete** in the composer driven by `commands.list`.
- [x] **Reasoning toggle** that flips `/reasoning on|off|stream` on the gateway side and renders analysis-stream chunks inline.
- [x] **Today's gateway cost chip** polled from `usage.cost` (30s cache).
- [x] **Live gateway badge** that reacts to `health` / `shutdown` events + WS reconnects.
- [x] **Interrupt button** next to Stop — `chat.abort` + auto-flush the next queued message.
- [ ] Edit a previous user message and regenerate from there
- [ ] Pin/star important messages
- [ ] Drag-reorder chats in sidebar
- [ ] Chat folders / tagging (lightweight)

## v0.4 — Multi-agent UX

Focus: lean further into OpenClaw's multi-agent model.

- [ ] First-class "compare agents" view: same prompt → multiple agents side by side
- [x] Switch agent mid-chat with a clear visual marker in the history
- [ ] Live tool/activity timeline panel (expandable from the chat header)
- [ ] Token usage / latency stats per turn (read from `sessions.usage`)
- [ ] Voice mode bridging `talk.*` (out of scope for v0.4; tracked for later)

## v1.0 — Production-ready local app

- [ ] Docker image + `docker-compose.yml` (with OpenClaw service)
- [ ] Single-binary distribution (pkg / bun build)
- [ ] Internationalization (English + Ukrainian out of the box)
- [ ] Accessibility audit (keyboard navigation, screen-reader labels)
- [ ] End-to-end test suite (Playwright) on top of the current vitest unit + route coverage
- [x] **Vitest unit + integration tests** for store / projectMemory / routes / scheduler / chatRunner (100 tests)
- [x] **Design system** in `style.css` — tokens (`--space-*`, `--radius-*`, `--shadow-*`, semantic colors) + reusable primitives (`.btn`, `.chip`, `.card`, `.menu`)

## Explicitly **not** planned

These belong somewhere else (or to nobody):

- Building our own agent runtime, memory, or RAG — that's OpenClaw's job
- Cloud hosting / SaaS deployment — iClaw is local-first
- Multi-user auth and permissioning
- Bundling third-party model providers directly (configure them in OpenClaw)
- A heavyweight frontend framework migration — we'll stay on EJS + vanilla JS unless we hit a wall
- Re-implementing `agents.create/update/delete` in iClaw (that's the OpenClaw control-ui / config job)

If you want one of these, fork is welcome — but probably also reconsider whether iClaw is the right base.
