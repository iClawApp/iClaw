/**
 * Per-install identity for container labelling.
 *
 * Every sandbox container is stamped with `--label iclaw-install=<slug>` so the
 * orphan reapers only ever touch THIS install's containers — two iClaw installs
 * (different checkouts) on one machine can't kill each other's sandboxes.
 *
 * The slug is sha1 of this install's absolute path (like NanoClaw's
 * install-slug): deterministic across restarts, unique across checkouts.
 * Overridable via ICLAW_INSTALL_ID for unusual setups.
 */
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function computeSlug(): string {
  const override = process.env.ICLAW_INSTALL_ID?.trim();
  if (override) return override.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 32) || 'iclaw';
  // This file lives at <install>/packages/iclaw-runtime/(src|dist)/install-id.*
  const here = dirname(fileURLToPath(import.meta.url));
  const installRoot = resolve(here, '..');
  return createHash('sha1').update(installRoot).digest('hex').slice(0, 8);
}

/** `iclaw-install=<slug>` — the value passed to `docker run --label` / `ps --filter`. */
export const INSTALL_LABEL = `iclaw-install=${computeSlug()}`;
