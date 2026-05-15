# Contributing to iClaude

Thanks for considering a contribution. iClaude is a thin local UI on top of [OpenClaw Gateway](https://docs.openclaw.ai). We keep the surface small on purpose — the goal is **not** to build our own agent runtime.

## What we welcome

- Bug reports with steps to reproduce
- Small UX improvements (keyboard shortcuts, markdown rendering, dark theme, etc.)
- Streaming/SSE robustness fixes
- New surface features that fit "ChatGPT-style UI over OpenClaw" — pinned messages, chat search, export, themes, accessibility
- Documentation, examples, and screenshots

## What we don't want

- Wrapping/re-implementing OpenClaw's agent logic in iClaude
- Adding remote auth, multi-user, or hosting features (this is a local-first app by design)
- Bundling third-party AI providers directly — go through OpenClaw's gateway
- Heavyweight client frameworks for features that work fine with the current vanilla-JS + EJS setup

If you want to propose something larger, **open an issue first** so we can talk scope before you spend time.

## Development setup

Requirements: Node.js 20+ and a running [OpenClaw Gateway](https://docs.openclaw.ai) on `127.0.0.1:18789` with the OpenAI-compatible endpoint enabled.

```bash
git clone https://github.com/tmlxrd/iClaw.git
cd iClaw
npm install
npm run dev    # http://localhost:3000
```

The dev server reads the gateway token from `~/.openclaw/openclaw.json` automatically. Override with `OPENCLAW_BASE_URL` and `OPENCLAW_API_KEY` env vars if needed.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | tsx watch — auto-reload on save |
| `npm run typecheck` | `tsc --noEmit`, must be clean before PR |
| `npm run build` | Emit JS to `dist/` |
| `npm start` | Run compiled build |

### Test against a local gateway

If you don't want to run real OpenClaw during dev, the OpenAI-compat endpoint is mocked in `/tmp/fake-openclaw.cjs` in older commits — you can adapt that as a starting point.

## Code style

- TypeScript strict mode, no `any` unless commented why
- Express + EJS for routes/views, plain CSS for styling, vanilla JS on the client — no frontend framework
- SQLite via `better-sqlite3` (synchronous)
- All client-server communication via JSON or SSE
- File naming: `kebab-case.ts` for modules; one default export per route file

### Commits

- Imperative subject under 72 chars: `Add chat search`, `Fix queue reordering`
- Body explains *why* if non-obvious
- One logical change per commit when possible

### Pull requests

- Fork → branch off `dev` → PR back to `dev` (not `main`)
- Fill in the PR template
- `npm run typecheck && npm run build` must pass
- Screenshots/GIFs for UI changes are appreciated
- Keep the diff small; large PRs are hard to review and merge

## Reporting bugs

Use the **Bug report** issue template. Include:
- OS, Node version, browser
- OpenClaw Gateway version (`openclaw --version`)
- What you did, what happened, what you expected
- Any errors from the dev server console or browser devtools

## Proposing features

Use the **Feature request** issue template. Describe:
- What problem this solves
- Why it belongs in iClaude (vs. OpenClaw, vs. a separate tool)
- Rough sketch of the UX

## Code of Conduct

We follow the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind, be specific, assume good faith.

## License

By contributing, you agree your work is licensed under the [MIT License](LICENSE).
