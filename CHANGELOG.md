# Changelog

All notable changes to iClaude are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project follows [Semantic Versioning](https://semver.org/) starting at v0.1.0.

## [Unreleased]

### Added
- LICENSE (MIT)
- CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, ROADMAP
- GitHub Actions CI: typecheck + build on push/PR
- Issue and pull request templates

## v0.1.0 — initial public preview

Initial ChatGPT-style local UI for OpenClaw Gateway. Builds the chat surface on top of OpenClaw's OpenAI-compatible `/v1/chat/completions` endpoint and stores conversation history locally in SQLite.

### Added
- **OpenAI-compatible client** for OpenClaw: `listAgents()` → `/v1/models`, `chat()` → `/v1/chat/completions`, `chatStream()` → SSE stream
- **Auto-loaded gateway token** from `~/.openclaw/openclaw.json` (no env vars required)
- **Two-column ChatGPT-style UI**: chat list (left), conversation (right)
- **Chats are isolated**: each has its own session key (sent as `x-openclaw-session-key`), agent choice, and message history in SQLite
- **Lazy chat creation**: nothing is written to the DB until the first message is sent — empty chats don't exist
- **Live working indicator** per chat: pulsing green dot in the sidebar while a turn is in flight
- **Per-chat send serialization** via `chatStatus.withLock` — parallel sends queue cleanly, user/assistant pairs stay intact
- **Client-side message queue**: type and send freely while a previous turn is processing; queued messages display above the composer with position labels
- **Token streaming via SSE** from OpenClaw through iClaude to the browser (delta-by-delta)
- **Live tool activity** from the gateway via WebSocket — shows which tool (bash, file, etc.) the agent is running in real time
- **Instant chat in sidebar**: the moment the server creates the chat row, a `title` SSE event is emitted with the truncated user message
- **AI-generated chat titles** as a cheap background sub-request to OpenClaw, with strict quality gates (rejects single-number / too-short / "Here is…" garbage) and a placeholder fallback
- **Inline rename** of chats in the chat header; `title_manual` flag prevents AI from overriding a user-set title
- **Per-chat agent switcher** in the chat header
- **Polling-based status panel** (`/chats/status` endpoint, sidebar dots refresh every 2s)
- **Cross-tab awareness**: send from one tab → other tabs see the indicator

### Stack
- Node.js + TypeScript (strict)
- Express + EJS
- better-sqlite3
- Plain CSS, vanilla JavaScript on the client — no build step beyond `tsc`
