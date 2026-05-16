# AGENTS.md — Guardrails for AI coding agents working on iClaw

Hi. If you're an AI coding agent (Claude Code, Codex, Cursor, anyone) about to make changes here, read this once before you touch the source.

## What iClaw is

A **local web UI for [OpenClaw Gateway](https://docs.openclaw.ai)**. Nothing more. The app:

- Renders a ChatGPT-style chat surface (sidebar of chats, conversation in the middle)
- Stores chat history locally in SQLite (`data/iclaw.db`)
- Talks to a running OpenClaw Gateway on the same machine via the **native WebSocket protocol**
- Auto-loads the bearer token from `~/.openclaw/openclaw.json`

## What iClaw is **not**

These are intentional non-goals. Don't add them. If a request lands here that needs any of them, push back or open an issue first.

- **Not a generic OpenAI-compat client.** We migrated off `/v1/chat/completions` in commit `a92c10e`. Do not re-introduce an HTTP chat completion path.
- **Not a multi-provider chat tool.** No fallback to Ollama, vLLM, Claude API, OpenAI direct, etc. OpenClaw is the only backend.
- **Not a remote/hosted product.** Loopback-only. No multi-user, no auth layer, no team features. Threat model is "this user on this machine".
- **Not a re-implementation of OpenClaw's agent runtime.** We don't compact context, run tools, manage memory, or wrap the LLM. We display what the gateway produces.
- **Not heavyweight on the frontend.** No build step beyond `tsc`. Plain CSS, vanilla JS on the client, EJS for views. If you want to add React/Vue/Svelte, open an issue first — the answer is probably no for the current scope.

## Architecture you need to know

```
                  ┌─────────────────┐
                  │  OpenClaw       │
                  │  Gateway        │
                  │  (port 18789)   │
                  └────┬────────┬───┘
                       │WS      │HTTP /media/*  /health
                       │native  │
                  ┌────▼────────▼───────────────────────┐
                  │  iClaw Express + WS app (port 3000) │
                  │                                     │
                  │  gatewayWs.ts   ← single WS         │
                  │      ▲                              │
                  │  openclawWs.ts ← domain client      │
                  │      ▲                              │
                  │  chatRunner.ts ← turn orchestrator  │
                  │      ▲                              │
                  │      ├─ routes/ws.ts  (browser WS)  │
                  │      └─ routes/chats.ts (form POST) │
                  │           rename/agent/delete only  │
                  │                                     │
                  │  wsHub.ts ← pub/sub fanout          │
                  └────┬─────────────────────────────┬──┘
                       │WS /ws (real-time)            │HTTP (forms + pages)
                       ▼                              ▼
                  ┌──────────────────────────────────────┐
                  │  Browser — public/js/iclaw.js +      │
                  │  vendored marked.min.js              │
                  └──────────────────────────────────────┘
```

Browser ↔ server is **one persistent WebSocket** at `/ws`. All chat traffic
(send, abort, streaming turn events, cross-tab sync) flows through it.
HTTP routes only exist for: page rendering (EJS), one-shot form actions
(rename, change agent, delete), the `/media/*` proxy, and `GET
/health`-style endpoints. After every HTTP form-action that mutates a chat
the server emits the matching `chat-updated` / `chat-deleted` over WS so
other tabs catch up instantly.

### The canonical client paths

| What you want | Use |
| --- | --- |
| Run a turn (high-level: persist + broadcast) | `chatRunner.sendMessage({chatId?, content, agentLabel?, subscriber?})` |
| Push to a subscribed chat | `wsHub.broadcastToChat(chatId, msg)` |
| Push to every connected tab | `wsHub.broadcastAll(msg)` |
| List agents | `openclawWs.listAgents()` |
| Create a session | `openclawWs.createSession({ agentId })` |
| Send + stream a single OpenClaw turn (low-level) | `openclawWs.runTurn({ sessionKey, message, onEvent })` |
| Get transcript | `openclawWs.getHistory(sessionKey)` |
| Cancel running turn | `openclawWs.abortRun(sessionKey, runId?)` |
| Generic RPC against the gateway | `gatewayWs.request(method, params)` |
| Subscribe to per-session activity (high-level) | `gatewayWs.watchSession(sessionKey, listener)` |
| Raw frame access | `gatewayWs.onFrame(listener)` |
| Check gateway is up (no auth needed) | `openclaw.health()` |
| Read base URL for templates / proxy targets | `openclaw.baseUrl` |

Anything that mutates a chat from a route handler MUST also broadcast the
corresponding `chat-updated` / `chat-deleted` over `wsHub.broadcastAll`.
Otherwise other tabs won't see the change until they reload. Convention:
`routes/chats.ts` POST handlers do this directly; `chatRunner` does it for
title/agent changes inside a turn.

`src/services/openclaw.ts` is a deliberately tiny module — just `baseUrl` + `health()`. **Do not grow it.** All chat / agent / session work goes through `openclawWs.ts`.

### Event flow during a turn

A `runTurn` call emits these `TurnEvent`s through `onEvent`:

- `text-delta` — streaming text chunks (use directly as token stream)
- `tool-start` / `tool-end` — agent tool calls (bash, file, etc.) with a human label
- `lifecycle` — phase transitions (start, end, etc.)
- `attachment` — `{ url, mime, label? }`; URL is rewritten to `/media/...` so the browser can fetch through our proxy without seeing the gateway token
- `text-final` — emitted once at end, with the canonical final text

`runTurn` resolves when the turn ends (`chat:final` event or `lifecycle:end` for `runId`).

### Session keys

OpenClaw owns session keys. They look like `agent:main:dashboard:<uuid>`. Our DB column `chats.openclaw_session_id` stores this exact string after the first message.

`ensureOpenClawSession(chatId)` creates a session on demand for any chat that doesn't have a real (`agent:…`) key yet. There's no special legacy-migration path — anything that's not a real key gets replaced silently. Do not add complexity around this.

### Status & reload recovery

`chatStatus` tracks per-chat lock + current activity in memory. The route `GET /chats/status` exposes both for the sidebar polling. When the browser reloads mid-turn, the server-rendered template includes a placeholder + the current activity label, and `chat.js` polls status until the chat goes idle, then fetches new messages.

This is intentionally polling-based (cheap, simple). A full SSE reattach with token-by-token replay would need a per-turn event bus — out of scope for now.

## Stack rules

- **Node.js 20+**, TypeScript strict mode. No `any` without a comment explaining why.
- **Express + EJS** server, vanilla JS + plain CSS client. `marked` is the only client-side dependency.
- **better-sqlite3** for storage. Synchronous on purpose — keeps request handlers simple.
- **No frontend framework, no build step beyond `tsc`.** If you genuinely need reactivity, talk first.
- **CSS uses variables in `:root` and a `@media (prefers-color-scheme: dark)` override.** Don't hard-code colors in components.

## Conventions

- Routes return JSON when `Accept: application/json` or for `/api/*` paths; otherwise EJS or 302 redirect for forms. SSE is opt-in via `Accept: text/event-stream`.
- The chat route handles both streaming (SSE) and non-streaming (JSON) variants — keep both, but it's fine to drop non-streaming if it becomes a maintenance burden.
- Every commit must pass `npm run typecheck && npm run build`.
- One logical change per commit. Imperative subject ≤ 72 chars.
- See `CONTRIBUTING.md` for the rest of the rules.

## Things that have already burned us

- **Adding "lazy legacy migration" code with detection branches.** Removed in this commit — anything not a real OpenClaw key is just replaced. Don't re-add classification helpers.
- **Asking OpenClaw for AI-generated titles in the same session as the chat.** Pollutes the transcript. We use a throw-away session per title attempt.
- **Treating `kind: 'analysis'` items as tool calls.** That's reasoning, not a tool — skip it.
- **Sending content as a string array via OpenAI-compat.** OpenClaw's native protocol takes `chat.send { sessionKey, message: string, idempotencyKey }`. Don't try to mimic OpenAI message arrays.
- **Hardcoding the bearer token anywhere.** It must be read at runtime via `loadOpenClawConfig()`. Never log it. The `.env.example` and tracked source must not contain real tokens — that's checked at security audit time.

## When you're stuck

- Read `docs/gateway/protocol.md` inside the installed `openclaw` npm package (`~/.nvm/versions/node/<v>/lib/node_modules/openclaw/docs/gateway/protocol.md`). It has the full WS RPC surface.
- The OpenClaw control-ui bundle (`http://127.0.0.1:18789/assets/index-*.js`) shows how their own dashboard uses each RPC.
- Probe live with a small WS script — we have an example pattern at the bottom of recent commit `a92c10e`.

That's it. Keep iClaw small, focused, and OpenClaw-native.
