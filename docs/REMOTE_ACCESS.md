# Remote Access (E2E alpha)

Remote Access gives you a temporary public URL that lets you open this iClaw
from another device — your phone, another laptop, or someone you trust —
without opening any inbound port on your machine.

> **Alpha. Not externally audited.** The encryption design below is real and
> tested, but it has not had an independent security review. Treat it as
> "much better than plaintext," not as a hardened, audited product. See
> [Security model](#security-model) for exactly what is and isn't protected.

---

## How it works (one paragraph)

Your local iClaw opens **one outbound WebSocket** to a public **relay**
(`relay.iclaw.digital`). The relay hands out a temporary subdomain
(`https://<name>.iclaw.digital`) and forwards traffic back down that
WebSocket. A visitor opens the URL, passes the relay **access gate** (a
one-time `?access=` token baked into the link), then logs in with the
**passphrase** via **OPAQUE** (the passphrase never crosses the wire). After
login, every HTTP request and WebSocket message is **encrypted end-to-end**
between the visitor's browser and your local iClaw; the relay only ever sees
ciphertext envelopes.

```
[Browser] --TLS--> [Cloudflare] --> [relay] --(single WS)--> [your iClaw]
            \__________ E2E (OPAQUE-derived keys) __________/
                  relay sees only ciphertext + metadata
```

---

## Setup

### 1. OPAQUE server setup — automatic

Nothing to do. The first time you create a tunnel, iClaw generates an OPAQUE
server setup and stores it locally (in its SQLite, alongside the passphrases
and access tokens it already keeps). Fresh installs "just work".

**Optional override** — set `OPAQUE_SERVER_SETUP` to pin a specific value
(advanced / shared-host scenarios). The env var always wins over the
auto-generated one:

```bash
# generate one explicitly, if you want to control it:
npx @serenity-kit/opaque create-server-setup    # prints a base64 string
OPAQUE_SERVER_SETUP=<the base64 string from above>
```

- Keep it **secret** (don't commit it; `.env` should be git-ignored) and
  **stable**. If it changes, existing tunnels' stored OPAQUE records are
  invalidated and re-registered on next start.
- To run the **same** tunnel/passphrase across several of your machines, set
  the **same** `OPAQUE_SERVER_SETUP` on each; otherwise each host gets its own
  auto-generated value (independent).

### 2. (Optional) point at a different relay

By default iClaw uses the hosted relay:

```
wss://relay.iclaw.digital/tunnel
```

Override for local development against your own `iclaw-relay`:

```bash
ICLAW_RELAY_URL=ws://127.0.0.1:4100/tunnel
```

### 3. Create a tunnel

Open iClaw → gear icon → **Settings → Remote Access → Share**. Pick a name
and a duration (30 min / 12 h / 7 d / 30 d). You get:

- a **URL** (`https://<name>.iclaw.digital?access=…`) — already contains the
  one-time relay access token,
- a **passphrase** (4 words + digits) — shown separately.

Share **both**, ideally over a private channel. The visitor opens the URL and
enters the passphrase.

---

## Local mode vs always-on host

- **Local mode (default):** iClaw runs on your own machine and the tunnel
  lives only while iClaw is running and the tunnel hasn't expired. Quitting
  iClaw drops the tunnel; restarting within ~10 min restores the **same** URL
  (the relay reserves the subdomain during a short grace window). After that
  the URL changes on next start.
- **Always-on host:** run iClaw on a server you control (same `OPAQUE_SERVER_SETUP`
  in its env) so the tunnel survives across your laptop sleeping. Same code,
  just a longer-lived host. The relay is still in the trust boundary for
  metadata (see below).

---

## Managing access

- **New access link** (per tunnel) rotates the relay access token: old links
  and any already-issued access cookies stop working immediately; a fresh
  `?access=` link is minted. The passphrase and URL host stay the same.
- **Devices:** after a successful passphrase login, a browser registers a
  device keypair (private key stays in the browser) and appears under
  *Connected devices*; revoke individual devices from the tunnel card.
  > **Alpha limitation:** the E2E session keys live only in the tab's
  > `sessionStorage`, so reopening the link in a new tab (or after closing it)
  > currently **requires re-entering the passphrase** to re-derive them — the
  > device record updates "last seen" but does not yet skip the passphrase for
  > the encrypted session. Device-based E2E resume is planned, not shipped.
- **Disable** tears the tunnel down immediately; the URL 404s.

---

## Security model

**What is protected**

- **Passphrase** — never sent over the wire. OPAQUE proves knowledge of it
  without transmitting it; the relay cannot learn it.
- **HTTP & WebSocket payloads** — encrypted end-to-end (AES-256-GCM with
  per-stream subkeys derived from the OPAQUE session key via HKDF). The relay
  forwards only ciphertext envelopes; it cannot read request paths, bodies,
  responses, or chat content.
- **Tamper / replay** — each record is authenticated (GCM tag over a context
  AAD: tunnelId, streamId, direction, counter, frame kind, relay binding) and
  a per-stream monotonic counter ledger rejects replays.

**What the relay still sees (metadata)**

- The subdomain in use, connection timing, and approximate request/response
  **sizes**.
- Which **E2E endpoints** are hit (`/__ra/e2e/http`, `/__ra/e2e/ws`) and the
  bootstrap/OPAQUE/gate-asset requests that happen before the encrypted
  session is established.
- The relay **access cookie** (`iclaw_tunnel_access`) that rides the outer
  requests. It gates the subdomain but does **not** grant the relay access to
  encrypted content (that requires the OPAQUE-derived keys, which never leave
  the browser/iClaw).
- The iClaw login session (`iclaw_ra`) is **not** exposed to the relay: it is
  never handed to the browser, so it never rides an outer request. Inner
  encrypted requests are authenticated by possession of the E2E keys, and your
  local iClaw re-attaches the session id itself at loopback.

**What this is NOT**

- Not an audited, production-grade E2E system.
- Not anonymous — the relay operator can see you have an active tunnel and
  its traffic metadata.
- The browser code that performs the crypto is served **through the relay**;
  a malicious relay could in principle serve modified JS. Browser-delivered
  E2E is only as trustworthy as code delivery. A native client would close
  this gap; it is out of scope for the alpha.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| "Share" returns 503 `opaque_setup_unavailable` | OPAQUE setup is auto-generated now; this only happens if the OPAQUE runtime can't load. Check logs / reinstall deps. On older builds it was `opaque_setup_missing` — set `OPAQUE_SERVER_SETUP` or update iClaw. |
| Login says "Remote Access login is not ready" | OPAQUE registration not synced — restart iClaw. |
| URL changed after a restart | Expected if iClaw was down longer than the ~10 min reconnect grace, or the relay restarted. |
| Visitor sees "tunnel reconnecting" | iClaw briefly lost its relay WS; it retries automatically. |
| `403 Forbidden` on the URL | Missing/expired `?access=` token — use the full link, or mint a new one with **New access link**. |
| Raw `{"error":"E2E transport required …"}` instead of the page | A returning tab hit the workspace over plaintext. Fixed: plaintext navigations now always serve the gate. If you still see it, your iClaw predates the fix — rebuild/restart it. Re-enter the passphrase to start a fresh encrypted session. |
