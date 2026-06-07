<p align="center">
  <img src="./public/icon-192.png" alt="iClaw logo" width="96" height="96">
</p>

<h1 align="center">iClaw</h1>

<p align="center">
  Minimalist agent UI - give it a project, it works only within it. Isolated memory, isolated folders
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@iclawapp/iclaw"><img src="https://img.shields.io/npm/dm/@iclawapp/iclaw?style=for-the-badge" alt="npm downloads"></a>
  <a href="https://www.reddit.com/r/iClaw_ai_agent/"><img src="https://img.shields.io/badge/Reddit-r%2FiClaw__ai__agent-FF4500?style=for-the-badge&logo=reddit&logoColor=white" alt="Reddit"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT"></a>
</p>

![iClaw screenshot](./docs/readme-screenshot.png)

## Install

Requires [Node.js 20+](https://nodejs.org)

```bash
npx @iclawapp/iclaw
```

Press **`g`** in the terminal to open the UI in your browser

## Star history

[![Star History Chart](https://api.star-history.com/svg?repos=iClawApp/iClaw&type=Date)](https://www.star-history.com/#iClawApp/iClaw&Date)

## Chat modes

| Mode | What it does | Backend |
| --- | --- | --- |
| **Work** | AI edits files in folders you pick; you approve every change. | iClaw runtime |
| **Safe work & Internet research** | Locked Docker sandbox — run untrusted code and research the web. | iClaw runtime |
| **Full Power** (default) | The full OpenClaw agent — files, tools, shell, browser. | OpenClaw Gateway |
| **Incognito** | Private, read-only research — reads files & the web, never writes, nothing saved. | iClaw runtime |

The three runtime modes need **Docker** running and an **OpenRouter key** (Settings); without either the composer falls back to Full Power. Architecture: [AGENTS.md](AGENTS.md).

## More

- **Encrypted chat sharing** — hit **Share** in any chat for an end-to-end encrypted link (AES-256-GCM; password, burn-after-read, TTL). Powered by [iClaw-cloud](https://github.com/iClawApp/iClaw-cloud).
- **Remote Access** (alpha) — reach the UI from another device over an iclaw-relay tunnel (Settings → Remote Access). Not externally audited yet — see [docs/REMOTE_ACCESS.md](docs/REMOTE_ACCESS.md).

## For developers

```bash
git clone https://github.com/iClawApp/iClaw.git
cd iClaw && npm install && npm run dev
```

Web UI on http://localhost:3000, Gateway on http://127.0.0.1:18789 (`OPENCLAW_BASE_URL`). Env vars: [.env.example](.env.example) · Architecture & coding rules: [AGENTS.md](AGENTS.md).

## License and contributing
[CONTRIBUTING.md](CONTRIBUTING.md) · [ROADMAP.md](ROADMAP.md) · [CHANGELOG.md](CHANGELOG.md)

MIT — see [LICENSE](LICENSE).
