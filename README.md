# iClaude

Local web UI for [OpenClaw Gateway](https://docs.openclaw.ai). A thin layer on top of OpenClaw — projects, tasks, pinned context notes, and a chat view bound to an OpenClaw agent. We do not build our own agent runtime or AI memory; OpenClaw remains the backend.

## How it talks to OpenClaw

OpenClaw exposes an **OpenAI-compatible** HTTP API on the same port as the dashboard (`18789` by default):

- `GET  /v1/models` — list agent targets (`openclaw/default`, `openclaw/research`, …)
- `POST /v1/chat/completions` — chat (we send the full history; gateway maintains agent state under `x-openclaw-session-key`)

iClaude:

- Auto-loads the gateway bearer token from `~/.openclaw/openclaw.json` → `gateway.auth.token` (no env vars needed)
- Stores conversation history locally in SQLite (gateway is stateless per-request)
- Sends pinned notes as a system message on every chat turn

## Prerequisites

The OpenAI-compatible endpoint is **disabled by default** in OpenClaw. Enable it once:

```json5
// in ~/.openclaw/openclaw.json
{
  "gateway": {
    "http": { "endpoints": { "chatCompletions": { "enabled": true } } }
  }
}
```

Then restart: `openclaw gateway restart`.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:3000

## Stack

- Node.js + TypeScript
- Express + EJS
- better-sqlite3
- Plain CSS, vanilla JS on the client

## What you get

- **Left column**: projects → tasks
- **Center**: chat with a chosen OpenClaw agent
- **Right column**: pinned context notes (auto-prepended to every chat turn as a system message)

Per task: pick one agent and a session-key is generated (a UUID, sent as `x-openclaw-session-key`). All messages persist in SQLite, so reloading the page does not lose history even though OpenClaw itself doesn't expose a history endpoint.

## Configuration (env, all optional)

| Var | Default | Purpose |
| --- | --- | --- |
| `OPENCLAW_BASE_URL` | `http://127.0.0.1:18789` (or `OPENCLAW_GATEWAY_PORT` from OpenClaw's service env) | Override gateway URL |
| `OPENCLAW_API_KEY` | _(read from `~/.openclaw/openclaw.json`)_ | Override bearer token |
| `PORT` | `3000` | iClaude HTTP port |
| `DB_PATH` | `./data/iclaude.db` | SQLite file path |

## Scripts

- `npm run dev` — dev server with auto-reload (tsx watch)
- `npm run build` — compile TS to `dist/`
- `npm start` — run compiled build
- `npm run typecheck` — type-check without emit
