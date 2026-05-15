<div align="center">

<img src="docs/images/logo.png" alt="iClaw" width="220" />

# iClaw

**A local ChatGPT-style web UI for [OpenClaw Gateway](https://docs.openclaw.ai).**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/tmlxrd/iClaw/actions/workflows/ci.yml/badge.svg?branch=dev)](https://github.com/tmlxrd/iClaw/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

<!--
HERO SCREENSHOT — drop a PNG at docs/images/hero.png
Recommended: full-window screenshot at ~1600×1000, light theme, sidebar with
3–5 chats (interesting titles), one chat open with a real conversation and the
queue panel showing 1 in-flight item.
-->

![iClaw](docs/images/hero.png)

iClaw is a thin web UI bound to a local OpenClaw Gateway. It does **not** build its own agent runtime or AI memory — OpenClaw stays the backend; we just give you a nice chat surface and store conversation history locally in SQLite.

## Contents

- [Why iClaw](#why-iclaw)
- [Quick start](#quick-start)
- [Features](#features)
- [How it talks to OpenClaw](#how-it-talks-to-openclaw)
- [Configuration](#configuration)
- [Screenshots](#screenshots)
- [Stack](#stack)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [Star history](#star-history)
- [License](#license)

## Why iClaw

OpenClaw is a powerful self-hosted agent runtime, but its own dashboard is general-purpose. If you're used to ChatGPT's flow — a list of chats on the left, a conversation in the middle, fast back-and-forth — that's what iClaw gives you, against your own local OpenClaw.

What you get:

- **One-click new chat** — no project/task setup, just type
- **Per-chat isolation** — own session key, own message history, own agent
- **Streaming replies** with live tool activity from the agent
- **Auto-generated chat titles** (descriptive, not "8")
- **Local SQLite** for full chat history — survives reboots; nothing leaves your machine

## Quick start

Requirements: Node.js 20+ and a running OpenClaw Gateway with the OpenAI-compatible endpoint enabled.

```jsonc
// in ~/.openclaw/openclaw.json
{
  "gateway": {
    "http": { "endpoints": { "chatCompletions": { "enabled": true } } }
  }
}
```

Then restart the gateway:

```bash
openclaw gateway restart
```

Now run iClaw:

```bash
git clone https://github.com/tmlxrd/iClaw.git
cd iClaw
npm install
npm run dev
```

Open **<http://localhost:3000>** and start chatting.

The gateway bearer token is read from `~/.openclaw/openclaw.json` automatically — no env vars needed.

## Features

### Today (v0.1)

- ChatGPT-style two-column UI: chat list (left) + conversation (right)
- Lazy chat creation — empty chats don't exist in the DB until you send a message
- **Streaming** assistant replies via Server-Sent Events
- **Live tool activity** (which tool the agent is running) via WebSocket to the gateway
- **AI-generated chat titles** as a cheap background sub-request, with strict quality gates
- **Inline rename** + per-chat agent switcher in the header
- **Message queue**: type and send while a previous turn is in flight — they queue per chat and display above the composer
- **Live "working" indicator** per chat (pulsing dot in sidebar) — visible across tabs
- **Cross-tab awareness** via short polling of `/chats/status`
- Auto-discovered gateway URL and bearer token

### Coming next (v0.2 — quality of life)

- Markdown rendering with code-block copy
- Dark theme
- Keyboard shortcuts (`Cmd/Ctrl+K` switcher, `Cmd/Ctrl+N` new chat)
- Full-text chat search
- Export as Markdown / JSON

See [ROADMAP.md](ROADMAP.md) for the longer plan.

## How it talks to OpenClaw

OpenClaw exposes an **OpenAI-compatible** HTTP API on the same port as the dashboard (`18789` by default):

- `GET /v1/models` — list agent targets (`openclaw/default`, `openclaw/research`, …)
- `POST /v1/chat/completions` — chat (with `stream: true` for SSE)

iClaw is OpenClaw's *client*:

- We send the full conversation as `messages[]` on every turn — OpenClaw is stateless per request
- A locally-generated UUID is sent as `x-openclaw-session-key` so the gateway tracks agent state (memory, tools) across turns
- We store the conversation in SQLite so reloading the page never loses history (the gateway doesn't expose history)
- Pinned context is injected as a `system` message on each turn

## Configuration

Everything is optional. Defaults work for the standard local setup.

| Var | Default | Purpose |
| --- | --- | --- |
| `OPENCLAW_BASE_URL` | `http://127.0.0.1:18789` | Override gateway URL |
| `OPENCLAW_API_KEY` | _(read from `~/.openclaw/openclaw.json`)_ | Override bearer token |
| `PORT` | `3000` | iClaw HTTP port |
| `DB_PATH` | `./data/iclaw.db` | SQLite file path (existing `iclaude.db` is auto-migrated on first run) |

## Screenshots

<!--
Add files to docs/images/ and reference them here. Suggested set:

1. docs/images/hero.png          — Full app, light theme, busy state
2. docs/images/streaming.gif     — 5–8s GIF of a message being sent + streamed reply with tool indicator
3. docs/images/queue.png         — A chat with 2–3 queued sends visible above the composer
4. docs/images/agents.png        — Agent picker dropdown open
5. docs/images/dark.png          — (when v0.2 lands) dark theme

Tools: macOS Screenshot (Cmd+Shift+5) for stills, Kap (https://getkap.co) for GIFs.
Resize PNGs to 1600px wide and run through https://tinypng.com to shrink.
-->

| | |
| --- | --- |
| **Full app** | _Add `docs/images/hero.png`_ |
| **Streaming reply** | _Add `docs/images/streaming.gif`_ |
| **Message queue** | _Add `docs/images/queue.png`_ |
| **Agent picker** | _Add `docs/images/agents.png`_ |

## Stack

- Node.js 20+ with TypeScript (strict)
- Express + EJS for routes/views — plain CSS and vanilla JS on the client, no frontend framework
- `better-sqlite3` for synchronous SQLite access
- SSE for streaming server → client, plain `fetch` POSTs client → server, WebSocket to OpenClaw for tool/lifecycle events
- No build step beyond `tsc`

## Roadmap

See [ROADMAP.md](ROADMAP.md) for milestones and the "explicitly not planned" list.

## Contributing

We welcome bug reports, UX improvements, and small feature PRs. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before you start — it covers local setup, code style, and scope.

Also worth a look:

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)

## Star history

[![Star History Chart](https://api.star-history.com/svg?repos=tmlxrd/iClaw&type=Date)](https://www.star-history.com/#tmlxrd/iClaw&Date)

## License

MIT — see [LICENSE](LICENSE). Same license as [OpenClaw](https://github.com/openclaw/openclaw).
