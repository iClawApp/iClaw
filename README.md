# iClaude

Minimal local web UI for [OpenClaw Gateway](https://docs.openclaw.ai). A ChatGPT-style chat — list of chats on the left, conversation in the center, nothing else.

OpenClaw remains the AI runtime; iClaude is just the chat front-end and local history.

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

Then: `openclaw gateway restart`.

## Quick start

```bash
npm install
npm run dev
```

Open http://localhost:3000

## How it works

- Click **+ New chat** → a chat is created (default agent `openclaw/default`) and you start typing.
- Each chat is isolated: own session-key, own message history, own agent.
- History is stored locally in SQLite (`data/iclaude.db`), so reloading the page does not lose anything.
- Each request to OpenClaw sends the full conversation as `POST /v1/chat/completions` with the chat's `x-openclaw-session-key`.
- Chat title is auto-derived from the first message; rename in the header anytime.
- Switch agents per chat via the header dropdown.

## Token & port

iClaude auto-loads `gateway.auth.token` from `~/.openclaw/openclaw.json` and the gateway port from `~/.openclaw/service-env/ai.openclaw.gateway.env` (fallback `127.0.0.1:18789`). Override with env vars if needed:

| Var | Default | Purpose |
| --- | --- | --- |
| `OPENCLAW_BASE_URL` | `http://127.0.0.1:18789` | Override gateway URL |
| `OPENCLAW_API_KEY` | _(read from `~/.openclaw/openclaw.json`)_ | Override bearer token |
| `PORT` | `3000` | iClaude HTTP port |
| `DB_PATH` | `./data/iclaude.db` | SQLite file path |

## Stack

- Node.js + TypeScript
- Express + EJS
- better-sqlite3
- Plain CSS, vanilla JS

## Scripts

- `npm run dev` — dev server with auto-reload (tsx watch)
- `npm run build` — compile TS to `dist/`
- `npm start` — run compiled build
- `npm run typecheck` — type-check without emit
