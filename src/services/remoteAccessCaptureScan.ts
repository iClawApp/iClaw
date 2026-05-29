/**
 * Scan relay/iClaw tunnel frame captures for secrets and app plaintext (E2E smoke).
 */

export interface CaptureScanHit {
  rule: string;
  detail: string;
}

export interface CaptureScanResult {
  ok: boolean;
  hits: CaptureScanHit[];
}

/** Patterns that must NOT appear in relay-visible payloads when E2E transport is active. */
export const E2E_FORBIDDEN_CAPTURE_RULES: ReadonlyArray<{
  id: string;
  test: (text: string) => boolean;
  describe: string;
}> = [
  {
    id: 'raw-passphrase-field',
    describe: 'JSON/form passphrase field',
    test: (t) => /"passphrase"\s*:\s*"/.test(t) || /passphrase=/.test(t),
  },
  {
    id: 'iclaw-ra-cookie',
    describe: 'iclaw_ra session cookie value',
    test: (t) => /iclaw_ra=[A-Za-z0-9%._-]{8,}/.test(t),
  },
  {
    id: 'html-doctype',
    describe: 'HTML document',
    test: (t) => /<!doctype\s+html/i.test(t) || /<html[\s>]/i.test(t),
  },
  {
    id: 'chat-api-json',
    describe: 'chat/API JSON bodies',
    test: (t) =>
      /"chatId"\s*:/.test(t) ||
      /"type"\s*:\s*"(message-appended|turn-delta|subscribe)"/.test(t),
  },
  {
    id: 'ws-subscribe-plain',
    describe: 'WS subscribe plaintext',
    test: (t) => /"type"\s*:\s*"subscribe"/.test(t) && !/"ct"\s*:/.test(t),
  },
];

/** Allowed visible strings on relay when E2E is on (routing metadata). */
export const E2E_ALLOWED_SUBSTRINGS = [
  '/__ra/e2e/http',
  '/__ra/e2e/ws',
  '/__ra/opaque/',
  '"ct"',
  '"sid"',
];

export function scanRelayCaptureText(text: string): CaptureScanResult {
  const hits: CaptureScanHit[] = [];
  for (const rule of E2E_FORBIDDEN_CAPTURE_RULES) {
    if (rule.test(text)) {
      hits.push({ rule: rule.id, detail: rule.describe });
    }
  }
  return { ok: hits.length === 0, hits };
}

/** Scan JSON-serialized req/res/ws frames (one line per frame). */
export function scanRelayCaptureLines(lines: string[]): CaptureScanResult {
  const allHits: CaptureScanHit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const r = scanRelayCaptureText(line);
    for (const h of r.hits) {
      allHits.push({ rule: h.rule, detail: `${h.detail} (line ${i + 1})` });
    }
  }
  return { ok: allHits.length === 0, hits: allHits };
}

export function looksLikeE2eWireEnvelope(text: string): boolean {
  return /"v"\s*:\s*1/.test(text) && /"ct"\s*:\s*"/.test(text) && /"sid"\s*:\s*"/.test(text);
}
