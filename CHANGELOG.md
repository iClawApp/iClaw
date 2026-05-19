# Changelog

All notable changes to iClaw are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/) and the project uses [Semantic Versioning](https://semver.org/) starting at v0.1.0.

## [Unreleased]

### Changed

- Gateway WebSocket handshake now requests `operator.admin` so in-app actions like **Yes, configure** on the daily session-reset banner can call `config.patch` without a manual `openclaw.json` edit.

### Added

#### Projects with shared context (memory layer)
- Per-project chats with optional **shared facts** auto-extracted from each turn.
- After every assistant reply, an LLM sub-request proposes 0–3 short facts; the user accepts or rejects each inline. Accepted facts are injected into the next user message as `[Project context]` block under a ~1500-token budget.
- Per-chat **Suggest facts for project** toggle blocks WRITE only (reads always happen if the chat is in a project).
- Auto-compaction kicks in at 30 facts → merged down to 15 via LLM call.
- Project page with **Чати / Памʼять / Посилання** tabs; activity-sorted project list with 14-day metrics.
- Inline edit + delete on each fact card, with fact source-chat title rendered.

#### Scheduled messages (Telegram-style)
- Long-press the Send button (450 ms) opens a menu with presets (+10 min / +1 h / +3 h / завтра 9:00) and a custom datetime picker.
- Pending list rendered above the composer with cancel buttons; updated live via `scheduled-added` / `scheduled-deleted` events.
- Background `scheduler` service sweeps `scheduled_messages` every 15 s, dispatches through the normal `sendMessage` path, and runs once on boot so anything that came due during downtime fires immediately. Restart-safe.

#### OpenClaw native WebSocket integration (full surface)
- **Handshake**: protocol v3/v4, `role: operator`, scopes `operator.read` + `operator.write` + `operator.approvals` + `operator.admin`, `client.mode: backend` (loopback trusted path).
- **Per-turn streaming**: text-delta → `chat.state=delta`; tool-start/end → `agent.stream=item phase=start|end`; lifecycle terminal phases (`end`/`error`/`aborted`/`cancelled`/`failed`/`terminated`/`stopped`); attachment items with `kind=file|image|media` rewritten through `/media` proxy.
- **Reasoning visibility**: analysis-stream items are emitted as `reasoning` events. The chat header toggle pushes `/reasoning <mode>` to the gateway *and* mirrors the state locally so the toggle isn't a placebo.
- **Per-session model override** via `sessions.patch` from a header `<select>` populated by `models.list`.
- **Compact session** button sends `/compact` through the normal chat pipeline.
- **Interrupt** button next to Stop calls `chat.abort` and auto-flushes the next queued message.
- **Exec approval cards** rendered inline on `exec.approval.requested` (Approve / Deny → `exec.approval.resolve`); resolved cards leave a brief decision trace and fade.
- **Live gateway badge** wired to `health` / `shutdown` events and WS reconnect transitions (states: connected / degraded / shutting down / unreachable).
- **Slash autocomplete** in the composer powered by `commands.list` — Arrow keys + Enter/Tab to pick.
- **Today's spend chip** polled from `usage.cost` (30 s server cache + 30 s client poll).
- **`sessions.changed` index subscription** survives reconnects (gatewayEvents re-fires the subscribe on every `hello-ok`).
- **Tick watchdog**: honour `policy.tickIntervalMs` from the hello-ok; close + reconnect the WS if no frame arrives for 2× the window (recovers cleanly from laptop sleep/wake).
- **Session cleanup**: deleting an iClaw chat now calls `sessions.delete` on the gateway so transcripts on disk don't leak.

#### UI / UX
- Markdown rendering (vendored `marked` v15.0.7), incremental during streaming.
- Syntax-highlighted code blocks (vendored highlight.js, GitHub light + dark themes) with floating copy button.
- Dark theme via `prefers-color-scheme` (light + dark token sets).
- Sidebar search over chat titles AND message bodies, debounced (1.5 s) with a unicode-lower SQLite function.
- Sidebar reorder live when a chat receives a new message (server broadcasts `chat-updated` with the new `updated_at`).
- Open-a-chat scrolls to the latest message before the first paint (`data-defer-paint` gate + synchronous `scrollTop`) — no visible scroll animation.
- Stop button to cancel a running turn; Interrupt to cancel and immediately fire the next queued message.
- Tool status / activity persists across page reloads (server-side `chatStatus` snapshot rendered into the reload placeholder).
- Fact suggestion cards in chat with merge-per-project/chat + timed-reject auto-dismiss.

#### Developer experience
- **Vitest** unit + integration test suite (100 tests): store CRUD, projectMemory pure helpers, scheduler sweep, HTTP routes for chats + projects + gateway proxies, chatRunner integration with stubbed `openclawWs`.
- **CI** now runs `npm test` between typecheck and build.
- **Design system** prelude at the top of `public/css/style.css`:
  - Tokens: `--space-*` (4 px grid), `--radius-*`, `--shadow-*`, `--z-*`, semantic colors (`--warn`, `--info`, `--approve`, `--approve-soft-*`, `--warn-soft-*`).
  - Reusable primitives: `.btn` (sizes `--sm`/`--lg` + tones `--primary`/`--danger`/`--approve`/`--ghost`/`--icon`), `.chip` (tones `--ok`/`--down`/`--warn`/`--accent`), `.card` (`--accent`/`--warn`/`--danger`), `.menu` + `.menu-item`.
  - Eliminated remaining hardcoded hex (`#c47a00`, `#2da44e`, `#b00020`, `#1a7f37`) from feature CSS — all flow through tokens.

### Changed

- **Architecture**: dropped the legacy OpenAI-compatible `/v1/chat/completions` HTTP path (commit `a92c10e`). All gateway traffic is now native OpenClaw WebSocket via `src/services/gatewayWs.ts` + `src/services/openclawWs.ts`.
- **DB schema** (additive migrations only): `chats.project_id`, `chats.shares_to_project`, `chats.model_override`, `chats.reasoning_mode`; new tables `projects`, `project_facts`, `project_fact_suggestions`, `scheduled_messages`; SQLite trigger `trg_chats_touch_on_message` keeps `chats.updated_at` correct on every message insert.
- **Sub-tasks** (project-fact extraction + compaction) always run against the gateway's default agent `main`, regardless of which agent the chat is on — keeps the two sub-pipelines consistent.
- **Dropped dead column** `projects.logo_preset` (replaced by `logo_emoji` + `logo_color`).
- **Removed** the unused activity bridge in `gatewayWs.ts` (~80 lines: `watchSession`, `mapAgentPayload`, `mapSessionToolPayload`, `emitActivity`).
- **Raised** the per-turn upper bound from 5 min → 60 min; OpenClaw itself defaults to 48 h, the old cap was killing legitimate tool-heavy runs.

### Fixed

- **Turn completion race** (`ebb9b4f`): resolve only on the `chat` event `state=final` payload, never on agent `lifecycle:end` alone — eliminates a window where chatRunner persisted from `chat.history` before the canonical assistant row existed.
- **Message-tool routing**: when the agent uses `tools.message.send`, the user-facing reply lives in a separate transcript row. `canonicalAssistantText()` walks `chat.history` to pick that up, falling back to streamed deltas only when nothing better is available.
- **WS subscriber timing**: socket is now subscribed to the new chat *before* `chat-created` is broadcast, so the originating tab no longer misses the entire turn.
- **Queue dedup** on the client (`flushNextQueued` was peeking `waitingItems[0]` without shifting; now shifts on flush, with stable per-item IDs and a delete button).
- **Optimistic user message** is marked with `.pending-id` and adopted by the upcoming `message-appended` for the same row instead of duplicating.
- **Status persistence**: a server-side `chatStatus` snapshot rendered into the reload placeholder lets a mid-turn page reload show the right state without waiting for the next event.
- **Stuck "working" state on lifecycle:error** — terminal phases (`end`/`error`/`aborted`/`cancelled`/`failed`/`terminated`/`stopped`) all unwind the lock. `/chats/:id/unstick` is the manual safety valve.

## v0.1.0 — initial public preview

Initial ChatGPT-style local UI for OpenClaw Gateway, on top of the OpenAI-compatible HTTP endpoint.

### Added

- **OpenAI-compatible client** for OpenClaw: `listAgents()` → `/v1/models`, `chat()` → `/v1/chat/completions`, `chatStream()` → SSE stream *(later replaced by native WS)*.
- **Auto-loaded gateway token** from `~/.openclaw/openclaw.json`.
- **Two-column ChatGPT-style UI** with isolated per-chat sessions (`x-openclaw-session-key`), agent choice, and SQLite-backed history.
- **Lazy chat creation** — no DB row until the first message.
- **Live working indicator** per chat in the sidebar.
- **Per-chat send serialization** via `chatStatus.withLock` keeping user/assistant pairs intact.
- **Client-side message queue** with position labels.
- **AI-generated chat titles** as a background sub-request with quality gates.
- **LICENSE** (MIT), **CONTRIBUTING**, **CODE_OF_CONDUCT**, **SECURITY**, **ROADMAP**, **AGENTS.md** for AI contributors.
- **GitHub Actions CI** (typecheck + build on push/PR for Node 20 + 22).

### Stack

- Node.js + TypeScript (strict)
- Express + EJS
- better-sqlite3
- Plain CSS, vanilla JavaScript on the client — no build step beyond `tsc`
