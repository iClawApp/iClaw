<div align="center">

<img src="docs/images/logo.png" alt="iClaw" width="220" />

# iClaw

**A local ChatGPT-style web UI for [OpenClaw Gateway](https://docs.openclaw.ai).**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/tmlxrd/iClaw/actions/workflows/ci.yml/badge.svg?branch=dev)](https://github.com/tmlxrd/iClaw/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

![iClaw](docs/images/hero.png)

A thin web UI bound to a local OpenClaw Gateway. iClaw is the chat surface — OpenClaw is the agent runtime.

## Quick start

Enable the OpenAI-compatible endpoint in OpenClaw (one-time):

```jsonc
// ~/.openclaw/openclaw.json
{ "gateway": { "http": { "endpoints": { "chatCompletions": { "enabled": true } } } } }
```

Restart the gateway, then run iClaw:

```bash
openclaw gateway restart
git clone https://github.com/tmlxrd/iClaw.git
cd iClaw && npm install && npm run dev
```

Open <http://localhost:3000>. The gateway token is auto-loaded from `~/.openclaw/openclaw.json`.

## Features

- ChatGPT-style two-column UI, one click to a new chat
- Streaming replies with live tool activity from the agent
- Auto-generated chat titles
- Inline rename, per-chat agent switcher
- Message queue per chat: send while one is processing
- Local SQLite history — survives reboots; nothing leaves your machine

## How it works

OpenClaw exposes an OpenAI-compatible API on the dashboard port (default `18789`):

- `GET /v1/models` — list agent targets
- `POST /v1/chat/completions` — chat (with `stream: true` for SSE)

iClaw stores full conversation history locally and sends the whole thread on each turn, plus an `x-openclaw-session-key` UUID so the gateway tracks agent state.

## Configuration

All optional.

| Var | Default | Purpose |
| --- | --- | --- |
| `OPENCLAW_BASE_URL` | `http://127.0.0.1:18789` | Gateway URL |
| `OPENCLAW_API_KEY` | _(from `~/.openclaw/openclaw.json`)_ | Bearer token override |
| `PORT` | `3000` | iClaw HTTP port |
| `DB_PATH` | `./data/iclaw.db` | SQLite file path |

## Stack

Node.js 20+ · TypeScript (strict) · Express + EJS · better-sqlite3 · plain CSS, vanilla JS. No frontend framework, no build step beyond `tsc`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), the [roadmap](ROADMAP.md), and the [changelog](CHANGELOG.md). Bug reports and small PRs welcome. For anything bigger, open an issue first to talk scope.

## Star history

[![Star History Chart](https://api.star-history.com/svg?repos=tmlxrd/iClaw&type=Date)](https://www.star-history.com/#tmlxrd/iClaw&Date)

## License

MIT — see [LICENSE](LICENSE). Same as [OpenClaw](https://github.com/openclaw/openclaw).
