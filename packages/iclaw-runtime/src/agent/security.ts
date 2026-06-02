/**
 * Path security for Work Mode.
 * All file operations must pass validatePath() before execution.
 */
import fs from 'node:fs';
import path from 'node:path';

const BLOCKED_PATTERNS = [
  '.env', '.ssh', '.gnupg', '.gpg', '.aws', '.azure', '.gcloud', '.kube',
  'id_rsa', 'id_ed25519', 'id_dsa', 'private_key',
  '.netrc', '.npmrc', '.pypirc',
];

const BLOCKED_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.cert', '.crt'];

const BLOCKED_NAMES = [
  'credentials', 'credentials.json', 'credentials.yaml', 'credentials.yml',
  'secrets', 'secrets.json', 'secrets.yaml', 'secrets.yml',
  'token', 'tokens',
];

export class SecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityError';
  }
}

/** Resolve and validate a path against allowed folders. Throws SecurityError if blocked. */
export function validatePath(inputPath: string, allowedFolders: string[]): string {
  if (!inputPath) throw new SecurityError('Empty path');

  // Expand ~ to home
  const expanded = inputPath.startsWith('~/') || inputPath === '~'
    ? path.join(process.env.HOME ?? '', inputPath.slice(1))
    : inputPath;

  const resolved = path.resolve(expanded);

  // Symlink resolution — prevent escape via symlinks
  let realPath: string;
  try {
    realPath = fs.realpathSync(resolved);
  } catch {
    // File doesn't exist yet (write case) — use resolved path
    realPath = resolved;
  }

  // Check blocked patterns in any path component
  const parts = realPath.split(path.sep);
  for (const part of parts) {
    for (const blocked of BLOCKED_PATTERNS) {
      if (part === blocked || part.startsWith(blocked + '.')) {
        throw new SecurityError(`Path matches blocked pattern "${blocked}": ${realPath}`);
      }
    }
  }

  // Check blocked extensions
  const ext = path.extname(realPath).toLowerCase();
  if (BLOCKED_EXTENSIONS.includes(ext)) {
    throw new SecurityError(`File extension "${ext}" is blocked: ${realPath}`);
  }

  // Check blocked names
  const basename = path.basename(realPath).toLowerCase();
  for (const blocked of BLOCKED_NAMES) {
    if (basename === blocked || basename.startsWith(blocked + '.')) {
      throw new SecurityError(`File name matches blocked pattern "${blocked}": ${realPath}`);
    }
  }

  // Must be under at least one allowed folder
  if (allowedFolders.length > 0) {
    const allowed = allowedFolders.some((folder) => {
      try {
        const realFolder = fs.realpathSync(path.resolve(folder));
        return realPath === realFolder || realPath.startsWith(realFolder + path.sep);
      } catch {
        return false;
      }
    });

    if (!allowed) {
      throw new SecurityError(
        `Path "${realPath}" is outside allowed folders: ${allowedFolders.join(', ')}`,
      );
    }
  }

  return realPath;
}

/** Check if a path is read-write allowed (vs read-only). */
export function isWriteAllowed(
  realPath: string,
  allowedFolders: { path: string; readonly?: boolean }[],
): boolean {
  for (const folder of allowedFolders) {
    try {
      const realFolder = fs.realpathSync(path.resolve(folder.path));
      if (realPath === realFolder || realPath.startsWith(realFolder + path.sep)) {
        return !folder.readonly;
      }
    } catch {
      continue;
    }
  }
  return false;
}
