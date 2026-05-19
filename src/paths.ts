import { homedir } from 'node:os';
import path from 'node:path';

/** Canonical SQLite path for all runs (CLI, dev, npx). */
export function defaultDbPath(): string {
  return path.join(homedir(), '.iclaw', 'data', 'iclaw.db');
}

export function resolveDbPath(): string {
  const raw = process.env.DB_PATH;
  if (!raw) return defaultDbPath();
  if (raw.startsWith('~/')) {
    return path.join(homedir(), raw.slice(2));
  }
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(process.cwd(), raw);
}

export function resolveUploadsRoot(): string {
  return path.join(path.dirname(resolveDbPath()), 'uploads');
}

/** `~/.iclaw/...` in terminals when under the home directory. */
export function displayPath(filePath: string): string {
  const home = homedir();
  const normalized = path.resolve(filePath);
  if (normalized === home) return '~';
  if (normalized.startsWith(home + path.sep)) {
    return '~' + normalized.slice(home.length);
  }
  return normalized;
}
