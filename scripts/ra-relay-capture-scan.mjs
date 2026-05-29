#!/usr/bin/env node
/**
 * Scan relay frame capture (NDJSON or one JSON object per line) for E2E leaks.
 *
 *   node scripts/ra-relay-capture-scan.mjs frames.ndjson
 *   cat frames.ndjson | node scripts/ra-relay-capture-scan.mjs
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));

// Load compiled scan if present, else use tsx-free inline rules for dev.
let scanRelayCaptureLines;
try {
  ({ scanRelayCaptureLines } = require('../dist/services/remoteAccessCaptureScan.js'));
} catch {
  const rules = [
    { id: 'raw-passphrase-field', test: (t) => /"passphrase"\s*:\s*"/.test(t) || /passphrase=/.test(t) },
    { id: 'iclaw-ra-cookie', test: (t) => /iclaw_ra=[A-Za-z0-9%._-]{8,}/.test(t) },
    { id: 'html-doctype', test: (t) => /<!doctype\s+html/i.test(t) || /<html[\s>]/i.test(t) },
    {
      id: 'chat-api-json',
      test: (t) =>
        /"chatId"\s*:/.test(t) ||
        /"type"\s*:\s*"(message-appended|turn-delta|subscribe)"/.test(t),
    },
    {
      id: 'ws-subscribe-plain',
      test: (t) => /"type"\s*:\s*"subscribe"/.test(t) && !/"ct"\s*:/.test(t),
    },
  ];
  scanRelayCaptureLines = (lines) => {
    const hits = [];
    lines.forEach((line, i) => {
      const t = line.trim();
      if (!t) return;
      for (const r of rules) {
        if (r.test(t)) hits.push({ rule: r.id, detail: `${r.id} (line ${i + 1})` });
      }
    });
    return { ok: hits.length === 0, hits };
  };
}

async function readInput(path) {
  if (path) {
    return fs.readFileSync(path, 'utf8');
  }
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

const file = process.argv[2];
const raw = await readInput(file);
const lines = raw.split(/\r?\n/).filter(Boolean);

if (lines.length === 0) {
  console.error('No lines to scan. Pass a file or pipe NDJSON frames.');
  process.exit(2);
}

const result = scanRelayCaptureLines(lines);
if (result.ok) {
  console.log(`OK: ${lines.length} frame line(s) — no forbidden patterns.`);
  process.exit(0);
}

console.error(`FAIL: ${result.hits.length} issue(s):`);
for (const h of result.hits) {
  console.error(`  - [${h.rule}] ${h.detail}`);
}
process.exit(1);
