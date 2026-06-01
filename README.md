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
  <a href="https://www.npmjs.com/package/@iclawapp/iclaw"><img src="https://img.shields.io/npm/dm/@iclawapp/iclaw?style=for-the-badge" alt="npm downloads"></a>
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

## Chat modes (Ask / Execute)

The composer has a small mode selector. **Execute** (default) is the full agent —
OpenClaw can use files, tools, shell, and the browser, exactly as before.
**Ask** is for quick questions, explanations, and planning with no heavy agent
execution. The selected mode is stored per message (`messages.mode`) and rides
along the whole `frontend → WS → chatRunner → OpenClaw` path. Missing/unknown
modes fall back to `execute`, so old chats and older clients keep working.

Modes are config-driven in [`src/services/chatModes.ts`](src/services/chatModes.ts)
(it also lists disabled placeholders — Research, Image, Safe Run — so new modes
can be added without touching call sites or the DB; the column is plain `TEXT`).

**How Ask works today and how to route it differently later.** For now Ask reuses
the same OpenClaw session as Execute and is differentiated by a short
"answer, don't execute" instruction prepended to the gateway message
(`applyModeToGatewayMessage`). Two cleaner backends are pre-seamed in
`chatModes.ts`:

- **No-tools / lightweight OpenClaw profile** — if the gateway gains a way to run
  a session with tools disabled, return it from `gatewayProfileForMode()` and
  have `openclawWs` forward it on `sessions.create` / `chat.send`. Modes that
  want this are already flagged `lightweight: true`.
- **OpenRouter / OpenAI direct** — for a true "no agent" answer, branch in
  `chatRunner` on `getModeDef(mode).lightweight` and call an LLM client instead
  of `openclawWs.runTurn`. The mode is already persisted per message, so this
  needs no schema or UI change.

## Remote Access (alpha)

Open the iClaw UI from another device through an **iclaw-relay** tunnel (Settings → Remote Access).

**Security model (summary):**

- **Relay access token** — blocks visitors who only guess the subdomain.
- **OPAQUE login** — passphrase is not sent in plaintext over the tunnel.
- **Encrypted HTTP/WebSocket** (E2E alpha) — payloads are encrypted between the browser and **local** iClaw; the relay forwards encrypted frames only.
- **Device sessions** — trusted browsers can reconnect without retyping the passphrase.
- **Alpha** — not externally audited. The relay still sees metadata (subdomain, timing, sizes, E2E endpoint paths).

Two setups: **local mode** (iClaw + OpenClaw on the same laptop) and **host mode** (always-on machine, browse from phone/laptop). See [docs/REMOTE_ACCESS.md](../docs/REMOTE_ACCESS.md).

Env on the iClaw host: `ICLAW_RELAY_URL` and `OPAQUE_SERVER_SETUP` (required when Remote Access is enabled).

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
Remote Access alpha: [docs/REMOTE_ACCESS.md](../docs/REMOTE_ACCESS.md), smoke [docs/REMOTE_ACCESS_SMOKE.md](../docs/REMOTE_ACCESS_SMOKE.md).

```bash
npm run test:ra-smoke          # E2E adversarial smoke (vitest)
npm run scan:relay-capture -- frames.ndjson   # scan relay frame capture
```

## Star history

[![Star History Chart](https://api.star-history.com/svg?repos=iClawApp/iClaw&type=Date)](https://www.star-history.com/#iClawApp/iClaw&Date)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), [ROADMAP.md](ROADMAP.md), [CHANGELOG.md](CHANGELOG.md). Bug reports and small PRs welcome — for bigger changes open an issue first.

## License

MIT — see [LICENSE](LICENSE).
