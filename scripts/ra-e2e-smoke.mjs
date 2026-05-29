#!/usr/bin/env node
/**
 * Prints Remote Access E2E alpha manual smoke pointers (automated checks: npm run test:ra-smoke).
 */
console.log(`
Remote Access E2E alpha — manual smoke

Automated (run first):
  cd iClaw && npm run test:ra-smoke
  cd iClaw && npm test
  cd iclaw-relay && npm test

Relay capture scan (after recording frames):
  npm run scan:relay-capture -- ./tmp/relay-frames.ndjson

Checklists:
  docs/REMOTE_ACCESS_SMOKE.md
  docs/REMOTE_ACCESS_RELEASE_CHECKLIST.md
  docs/REMOTE_ACCESS.md
`);
