import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { getContainerImageBase, getDefaultContainerImage, getInstallSlug } from './install-slug.js';
import { isValidTimezone } from './timezone.js';

const envConfig = readEnvFile(['TZ', 'ICLAW_RUNTIME_PORT', 'ICLAW_OPENROUTER_API_KEY', 'ICLAW_MODEL']);

const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored outside project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(HOME_DIR, '.config', 'iclaw', 'mount-allowlist.json');
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE_BASE = process.env.CONTAINER_IMAGE_BASE || getContainerImageBase(PROJECT_ROOT);
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || getDefaultContainerImage(PROJECT_ROOT);
export const INSTALL_SLUG = getInstallSlug(PROJECT_ROOT);
export const CONTAINER_INSTALL_LABEL = `iclaw-runtime=${INSTALL_SLUG}`;
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10);
export const MAX_MESSAGES_PER_PROMPT = Math.max(1, parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10);
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10);
export const MAX_CONCURRENT_CONTAINERS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5);

/** HTTP port for the iClaw runtime service. */
export const RUNTIME_PORT = parseInt(
  process.env.ICLAW_RUNTIME_PORT || envConfig.ICLAW_RUNTIME_PORT || '7430',
  10,
);

/** OpenRouter API key passed through to containers. */
export const OPENROUTER_API_KEY =
  process.env.ICLAW_OPENROUTER_API_KEY || envConfig.ICLAW_OPENROUTER_API_KEY || '';

/** Default model for Work Mode. */
export const DEFAULT_MODEL =
  process.env.ICLAW_MODEL || envConfig.ICLAW_MODEL || 'anthropic/claude-sonnet-4-5';

function resolveTimezone(): string {
  const candidates = [process.env.TZ, envConfig.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveTimezone();
