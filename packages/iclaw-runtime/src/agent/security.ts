/**
 * Path security for Work Mode.
 * All file operations must pass validatePath() before execution.
 */
import fs from 'node:fs';
import path from 'node:path';

const BLOCKED_PATTERNS = [
  '.env', '.ssh', '.gnupg', '.gpg', '.aws', '.azure', '.gcloud', '.kube', '.docker',
  'id_rsa', 'id_ed25519', 'id_dsa', 'private_key',
  '.netrc', '.npmrc', '.pypirc', '.secret',
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

/** Expand a leading ~ and resolve to an absolute path (no symlink resolution). */
function expandPath(inputPath: string): string {
  const expanded = inputPath.startsWith('~/') || inputPath === '~'
    ? path.join(process.env.HOME ?? '', inputPath.slice(1))
    : inputPath;
  return path.resolve(expanded);
}

/**
 * Return the secret-bearing pattern a real path matches (in any component, by
 * extension, or by basename), or null if clean. Shared by validatePath (host
 * file tools) and validateMountRoot (container mounts) so both apply the SAME
 * deny-list — a path the file tools refuse to touch is also never mounted.
 */
export function findBlockedPattern(realPath: string): string | null {
  const parts = realPath.split(path.sep);
  for (const part of parts) {
    for (const blocked of BLOCKED_PATTERNS) {
      if (part === blocked || part.startsWith(blocked + '.')) return blocked;
    }
  }
  const ext = path.extname(realPath).toLowerCase();
  if (BLOCKED_EXTENSIONS.includes(ext)) return ext;
  const basename = path.basename(realPath).toLowerCase();
  for (const blocked of BLOCKED_NAMES) {
    if (basename === blocked || basename.startsWith(blocked + '.')) return blocked;
  }
  return null;
}

/** Resolve and validate a path against allowed folders. Throws SecurityError if blocked. */
export function validatePath(inputPath: string, allowedFolders: string[]): string {
  if (!inputPath) throw new SecurityError('Empty path');

  const resolved = expandPath(inputPath);

  // Symlink resolution — prevent escape via symlinks
  let realPath: string;
  try {
    realPath = fs.realpathSync(resolved);
  } catch {
    // File doesn't exist yet (write case) — use resolved path
    realPath = resolved;
  }

  const blocked = findBlockedPattern(realPath);
  if (blocked) {
    throw new SecurityError(`Path matches blocked pattern "${blocked}": ${realPath}`);
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

/**
 * Validate a folder that's about to be bind-mounted into the command sandbox.
 * Resolves ~ and symlinks, then rejects any secret-bearing root (e.g. ~/.ssh,
 * a folder named `credentials`) via the SAME deny-list the host file tools use.
 * Returns the real (symlink-resolved) path to mount. Throws SecurityError.
 *
 * Note: this guards the mount ROOT. It deliberately does not try to hide secret
 * files nested inside an otherwise-legitimate folder — granting a shell into a
 * folder inherently exposes its contents. Callers therefore only mount folders
 * the user explicitly selected (never a broad fallback like all of $HOME).
 */
export function validateMountRoot(folderPath: string): string {
  if (!folderPath) throw new SecurityError('Empty mount path');
  const realPath = fs.realpathSync(expandPath(folderPath));
  const blocked = findBlockedPattern(realPath);
  if (blocked) {
    throw new SecurityError(`Folder matches blocked pattern "${blocked}": ${realPath}`);
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
