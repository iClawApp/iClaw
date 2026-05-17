# iClaw

Chat-style web UI for a **local** [OpenClaw Gateway](https://docs.openclaw.ai): sidebar, streaming replies, tool activity, SQLite history on disk. The browser only connects to iClaw; iClaw connects to the gateway (native WebSocket). **Node.js 20+**; gateway must be running (default `http://127.0.0.1:18789`).

```bash
git clone https://github.com/tmlxrd/iClaw.git && cd iClaw && npm install && npm run dev
```

Then open <http://localhost:3000>. Bearer token is read from `~/.openclaw/openclaw.json`. Production: `npm run build` then `npm start`.

| Where | Default |
| --- | --- |
| Web UI | <http://localhost:3000> |
| Browser ↔ iClaw | `ws://localhost:3000/ws` |
| Gateway | `http://127.0.0.1:18789` (`OPENCLAW_BASE_URL`) |

Optional env vars: [.env.example](.env.example). Notes for AI agents on this repo: [AGENTS.md](AGENTS.md).

## Encrypted chat sharing (optional)

Set `ICLAW_CLOUD_URL` to a running [iClaw-cloud](https://github.com/tmlxrd/iClaw-cloud) instance and a **Share** button appears in the chat header. The chat is encrypted in your browser (AES-256-GCM + optional PBKDF2 password); the share server stores ciphertext only and the symmetric key lives in the URL fragment. TTL 1/3/7/30 days, optional burn-after-read, optional password.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), the [roadmap](ROADMAP.md), and the [changelog](CHANGELOG.md). Bug reports and small PRs welcome. For anything bigger, open an issue first to talk scope.

## Star history

[![Star History Chart](https://api.star-history.com/svg?repos=tmlxrd/iClaw&type=Date)](https://www.star-history.com/#tmlxrd/iClaw&Date)

## License

MIT — see [LICENSE](LICENSE). Same as [OpenClaw](https://github.com/openclaw/openclaw).
