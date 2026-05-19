<p align="center">
  <img src="./public/icon-192.png" alt="iClaw logo" width="96" height="96">
</p>

<h1 align="center">iClaw</h1>

<p align="center">
  Chat UI for <a href="https://openclaw.ai">OpenClaw Gateway</a> — runs on your machine, stores history locally.
</p>

<p align="center">
  <a href="https://github.com/iClawApp/iClaw/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/iClawApp/iClaw/ci.yml?branch=main&style=for-the-badge" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@iclawapp/iclaw"><img src="https://img.shields.io/npm/v/@iclawapp/iclaw?style=for-the-badge" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT"></a>
</p>

![iClaw screenshot](./docs/readme-screenshot.png)

## Install

Requires [Node.js 20+](https://nodejs.org) and a running [OpenClaw Gateway](https://docs.openclaw.ai).

```bash
npx @iclawapp/iclaw
```

The terminal shows a short status line and **press `g`** to open the UI in your browser. It picks the next free port if `3000` is busy, and exits without starting a second copy if iClaw is already running.

Your chat history is saved to `~/.iclaw/data/iclaw.db`.

Optional env vars: `PORT` (preferred port, default `3000`), `ICLAW_OPEN_BROWSER=1` (also open the browser tab on start).

## Encrypted chat sharing (optional)

Hit **Share** in any chat to get an encrypted link. The chat is encrypted in your browser (AES-256-GCM); the server stores ciphertext only. Supports password protection, burn-after-read, and TTL.

Powered by [iClaw-cloud](https://github.com/iClawApp/iClaw-cloud) — defaults to `https://app.iclaw.digital`.

---

## For developers

```bash
git clone https://github.com/iClawApp/iClaw.git
cd iClaw && npm install && npm run dev
```

| | Default |
| --- | --- |
| Web UI | http://localhost:3000 |
| Gateway | http://127.0.0.1:18789 (`OPENCLAW_BASE_URL`) |

Optional env vars: [.env.example](.env.example).  
Architecture + coding rules: [AGENTS.md](AGENTS.md).

## Star history

[![Star History Chart](https://api.star-history.com/svg?repos=iClawApp/iClaw&type=Date)](https://www.star-history.com/#iClawApp/iClaw&Date)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [ROADMAP.md](ROADMAP.md), [CHANGELOG.md](CHANGELOG.md). Bug reports and small PRs welcome — for bigger changes open an issue first.

## License

MIT — see [LICENSE](LICENSE).
