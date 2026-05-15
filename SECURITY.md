# Security Policy

## Supported versions

iClaw is pre-1.0. Only the latest commit on the `main` and `dev` branches receives security fixes.

## Scope

iClaw is a **local-only** UI binding to a local OpenClaw Gateway. The intended deployment is:

- Bound to `127.0.0.1` (loopback) on the user's own machine
- Accessed only from the same machine via `http://localhost:3000`
- Token-authenticated upstream against OpenClaw

If you expose iClaw on a network beyond loopback, you are responsible for adding your own authentication, TLS, and access controls in front of it.

### In-scope vulnerabilities

- Path traversal, XSS, SSRF, prototype pollution, SQL injection in our code
- Bugs that leak OpenClaw bearer tokens, session keys, or chat content outside the local machine
- Crashes triggered by crafted user input or gateway responses

### Out of scope

- Anything that requires the attacker to already have local OS-level access to your machine — at that point they can read `~/.openclaw/openclaw.json` directly
- Vulnerabilities in OpenClaw itself — report those upstream at <https://github.com/openclaw/openclaw>
- Missing rate limiting on a single-user local app

## Reporting a vulnerability

**Please do not open a public issue for security problems.** Instead:

1. Open a **private** security advisory on GitHub: <https://github.com/tmlxrd/iClaw/security/advisories/new>
2. Or contact the maintainers via the email listed on the GitHub profile

Please include:

- A description of the issue and its impact
- Steps to reproduce
- Affected version / commit SHA
- A proposed fix if you have one

We aim to acknowledge reports within 72 hours and to publish a fix within 14 days for confirmed issues. A coordinated disclosure window can be arranged on request.

## Defaults you should know

- The gateway bearer token is read from `~/.openclaw/openclaw.json` (mode `0600`)
- SQLite database is at `./data/iclaw.db`, no encryption-at-rest by default
- All chat history is stored locally; iClaw never sends it anywhere except OpenClaw
