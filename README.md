<p align="center">
  <img src="./public/icon-192.png" alt="iClaw logo" width="96" height="96">
</p>

<h1 align="center">iClaw</h1>

<p align="center">
  <a href="https://iclaw.digital">iclaw.digital</a>
</p>

Site: <https://iclaw.digital>

Chat-style web UI for a **local** [OpenClaw Gateway](https://docs.openclaw.ai): sidebar, streaming replies, tool activity, SQLite history on disk. The browser only connects to iClaw; iClaw connects to the gateway (native WebSocket). **Node.js 20+**; gateway must be running (default `http://127.0.0.1:18789`).

```bash
git clone https://github.com/iClawApp/iClaw.git && cd iClaw && npm install && npm run dev
```

Then open <http://localhost:3000>. Bearer token is read from `~/.openclaw/openclaw.json`. Production: `npm run build` then `npm start`.

| Where | Default |
| --- | --- |
| Web UI | <http://localhost:3000> |
| Browser ↔ iClaw | `ws://localhost:3000/ws` |
| Gateway | `http://127.0.0.1:18789` (`OPENCLAW_BASE_URL`) |

Optional env vars: [.env.example](.env.example). Notes for AI agents on this repo: [AGENTS.md](AGENTS.md).

## Encrypted chat sharing (optional)

Set `ICLAW_CLOUD_URL` to your [iClaw-cloud](https://github.com/iClawApp/iClaw-cloud) origin, or leave it unset to use the default `https://app.iclaw.digital`. Set to `false`, `0`, `off`, or `disabled` to hide **Share**. The chat is encrypted in your browser (AES-256-GCM + optional PBKDF2 password); the share server stores ciphertext only and the symmetric key lives in the URL fragment. TTL 1/3/7/30 days, optional burn-after-read, optional password.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), the [roadmap](ROADMAP.md), and the [changelog](CHANGELOG.md). Bug reports and small PRs welcome. For anything bigger, open an issue first to talk scope.

## Star history

[![Star History Chart](https://api.star-history.com/svg?repos=iClawApp/iClaw&type=Date)](https://www.star-history.com/#iClawApp/iClaw&Date)

## License

MIT — see [LICENSE](LICENSE). Same as [OpenClaw](https://github.com/openclaw/openclaw).
