# Roadmap

A public sketch of where iClaw is heading. Anything not on this list is open for discussion — open an issue.

This isn't a contract. Priorities shift based on what users actually use.

## v0.1 — Public preview ✅

Out now. See [CHANGELOG](CHANGELOG.md).

- ChatGPT-style two-column UI
- OpenAI-compatible client for OpenClaw
- SSE streaming + live tool activity via WebSocket
- Lazy chat creation, queued sends, AI-generated titles
- Auto-loaded gateway token

## v0.2 — Quality of life

Focus: make the daily-driver experience smoother.

- [ ] Markdown rendering in assistant messages (code blocks, lists, links)
- [ ] Syntax-highlighted code blocks with copy button
- [ ] Keyboard shortcuts: `Cmd/Ctrl+K` (chat switcher), `Cmd/Ctrl+N` (new chat), `Cmd/Ctrl+Backspace` (delete chat)
- [ ] Dark theme (manual toggle + `prefers-color-scheme`)
- [ ] Search across all chats
- [ ] Export chat as Markdown or JSON
- [ ] Replace status polling with SSE for the sidebar
- [ ] Better error toasts (not just inline `<div class="error">`)

## v0.3 — Power user

Focus: features that ChatGPT users miss most.

- [ ] Edit a previous user message and regenerate from there
- [ ] Stop generation button (cancel in-flight SSE)
- [ ] Pin/star important messages
- [ ] Drag-reorder chats in sidebar
- [ ] Chat folders / tagging (lightweight, no return to projects model)
- [ ] Per-chat custom-instruction notes (system-prompt overrides)

## v0.4 — Multi-agent UX

Focus: leverage OpenClaw's multi-agent model.

- [ ] First-class "compare agents" view: same prompt → multiple agents side by side
- [ ] Switch agent mid-chat with a clear visual marker in the history
- [ ] Live tool/activity timeline panel (expandable from the chat header)
- [ ] Token usage and latency stats per turn (read from `usage` in the response)

## v1.0 — Production-ready local app

- [ ] Docker image + `docker-compose.yml` (with OpenClaw service)
- [ ] Single-binary distribution (pkg / bun build)
- [ ] Internationalization (English + Ukrainian out of the box)
- [ ] Accessibility audit (keyboard navigation, screen-reader labels)
- [ ] End-to-end test suite (Playwright)
- [ ] Stable API contract for the backend so other UIs can be built on top

## Explicitly **not** planned

These belong somewhere else (or to nobody):

- Building our own agent runtime, memory, or RAG — that's OpenClaw's job
- Cloud hosting / SaaS deployment — iClaw is local-first
- Multi-user auth and permissioning
- Bundling third-party model providers directly (e.g., OpenAI, Anthropic, Vertex) — configure them in OpenClaw instead
- A heavyweight frontend framework migration — we'll stay on EJS + vanilla JS unless we hit a wall

If you want one of these, fork is welcome — but probably also reconsider whether iClaw is the right base.
